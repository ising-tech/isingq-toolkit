'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { once } = require('node:events');
const { ManagerSession, IDLE_TIMEOUT_MS, FOREGROUND_LEASE_MS, HEARTBEAT_MS } = require('../packages/core/src/target-config-session');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { openTargetConfig, launchTargetConfig, MANAGER_BUILD_ID } = require('../packages/core/src/target-config-page');
const life = require('../packages/core/src/target-config-lifecycle');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const pageA = 'a'.repeat(32), pageB = 'b'.repeat(32);
function simulated(t, options = {}) { let now = 0; const s = new ManagerSession({ idleTimeoutMs: 100, foregroundLeaseMs: 90, heartbeatMs: 30, clock: () => now, ...options }); t.after(() => s.close()); return { s, set: value => { now = value; } }; }
async function server(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-idle-'));
  const profileStore = new SolverProfileStore({ XDG_CONFIG_HOME: directory });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const s = await openTargetConfig({ profileStore, idleTimeoutMs: 120, keepAlive: true, sessionOptions: { foregroundLeaseMs: 100, heartbeatMs: 30 }, ...options }); t.after(s.close);
  const u = new URL(s.url); return { s, profileStore, origin: u.origin, port: Number(u.port), headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) } };
}
const post = (h, route, data) => fetch(h.origin + route, { method: 'POST', headers: h.headers, body: JSON.stringify(data) });
const rebind = port => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

test('default policy is30m idle,90s lease and30s heartbeat without an absolute lifespan', () => {
  assert.equal(IDLE_TIMEOUT_MS, 1800000); assert.equal(FOREGROUND_LEASE_MS, 90000); assert.equal(HEARTBEAT_MS, 30000);
});

test('valid visible renewals continue beyond initial budget and two pages do not release one another', t => {
  const h = simulated(t); h.s.activity({ page_id: pageA, sequence: 1, visible: true, interactive: true });
  for (let i = 1; i <= 20; i++) { h.set(i * 50); h.s.activity({ page_id: pageA, sequence: i + 1, visible: true, interactive: true }); assert.equal(h.s.isActive(), true); assert.equal(h.s.snapshot().idle_deadline_at, null); }
  h.s.activity({ page_id: pageB, sequence: 1, visible: true, interactive: true }); h.s.activity({ page_id: pageA, sequence: 22, visible: false, interactive: false });
  assert.equal(h.s.snapshot().foreground_pages, 1); assert.equal(h.s.snapshot().idle_deadline_at, null);
  assert.throws(() => h.s.activity({ page_id: pageA, sequence: 21, visible: true, interactive: true }), e => e.code === 'activity_stale');
  h.s.activity({ page_id: pageB, sequence: 2, visible: false, interactive: false }); assert.equal(h.s.snapshot().idle_deadline_at, new Date(1100).toISOString());
});

test('hidden retries and unknown hidden pages do not renew idle; an expired visible update cannot resurrect it', t => {
  const h = simulated(t); const initial = h.s.snapshot().idle_deadline_at;
  for (let i = 1; i < 5; i++) { h.set(i * 15); h.s.activity({ page_id: pageA, sequence: i, visible: false, interactive: false }); assert.equal(h.s.snapshot().idle_deadline_at, initial); }
  h.set(90); h.s.activity({ page_id: pageB, sequence: 1, visible: false, interactive: false }); assert.equal(h.s.snapshot().idle_deadline_at, initial);
  h.set(100); assert.throws(() => h.s.activity({ page_id: pageA, sequence: 10, visible: true, interactive: true }), e => e.status === 403);
});

test('lost lease starts a full idle window at its actual expiry rather than the late observation time', t => {
  const h = simulated(t); h.s.activity({ page_id: pageA, sequence: 1, visible: true, interactive: true }); h.set(150);
  assert.equal(h.s.isActive(), true); assert.equal(h.s.snapshot().idle_deadline_at, new Date(190).toISOString()); h.set(189); assert.equal(h.s.isActive(), true); h.set(190); assert.equal(h.s.isActive(), false);
});

test('a real operation holds the session and its completion starts a fresh idle window', t => {
  const h = simulated(t); const end = h.s.beginOperation(); h.set(1000); assert.equal(h.s.isActive(), true); assert.equal(h.s.snapshot().operations_in_flight, 1);
  end(); end(); assert.equal(h.s.snapshot().operations_in_flight, 0); assert.equal(h.s.snapshot().idle_deadline_at, new Date(1100).toISOString()); h.set(1100); assert.equal(h.s.isActive(), false);
});

test('operation timeout and explicit close release operation accounting without reporting saved data', async t => {
  const { s } = simulated(t, { operationTimeoutMs: 20 }); await assert.rejects(s.operation(() => new Promise(() => {})), e => e.status === 504); assert.equal(s.operations, 0);
  const pending = s.operation(() => new Promise(() => {})); s.close(); await assert.rejects(pending, e => e.code === 'config_session_closed'); assert.equal(s.operations, 0);
});

test('active lease capacity is separate from short-lived history and stale sequence protection stays bounded', t => {
  const h = simulated(t, { idleTimeoutMs: 1000, maxPageRecords: 2, pageRetentionMs: 200 });
  h.s.activity({ page_id: pageA, sequence: 1, visible: false, interactive: false }); h.s.activity({ page_id: pageB, sequence: 1, visible: false, interactive: false });
  h.s.activity({ page_id: 'c'.repeat(32), sequence: 1, visible: true, interactive: true });
  h.s.activity({ page_id: 'd'.repeat(32), sequence: 1, visible: true, interactive: true });
  assert.throws(() => h.s.activity({ page_id: 'e'.repeat(32), sequence: 1, visible: true, interactive: true }), e => e.code === 'activity_capacity');
  assert.throws(() => h.s.activity({ page_id: pageA, sequence: 1, visible: true, interactive: true }), e => e.code === 'activity_stale'); h.set(201);
  h.s.activity({ page_id: 'e'.repeat(32), sequence: 1, visible: true, interactive: true }); assert.equal(h.s.pages.size, 1);
});

test('128 hidden histories cannot block a normal new foreground page for a day', t => {
  const h = simulated(t, { idleTimeoutMs: 1800000 });
  for (let n = 1; n <= 128; n++) h.s.activity({ page_id: n.toString(16).padStart(32, '0'), sequence: 1, visible: false, interactive: false });
  h.s.activity({ page_id: 'f'.repeat(32), sequence: 1, visible: true, interactive: true }); assert.equal(h.s.snapshot().foreground_pages, 1);
});

test('HTTP visible lease crosses initial budget without any device/cloud heartbeat queries', { timeout: 2500 }, async t => {
  let probes = 0; const h = await server(t, { dataService: { testProfile() { probes++; }, cloudCatalog() { probes++; } } });
  for (let i = 1; i <= 6; i++) { const r = await post(h, '/api/activity', { page_id: pageA, sequence: i, visible: true, interactive: true }); assert.equal(r.status, 200); assert.equal((await r.json()).session.idle_deadline_at, null); await wait(40); }
  const state = await (await fetch(h.origin + '/api/session', { headers: h.headers })).json(); assert.equal(state.expiry_policy, 'idle'); assert.equal(state.foreground_pages, 1); assert.equal(probes, 0);
  assert.equal((await post(h, '/api/activity', { page_id: pageA, sequence: 5, visible: false, interactive: false })).status, 409);
  await post(h, '/api/activity', { page_id: pageA, sequence: 7, visible: false, interactive: false }); const end = Date.now(); await h.s.closed; assert.ok(Date.now() - end >= 100); assert.equal(await rebind(h.port), true);
});

test('identity reads alone do not extend idle and a long bounded operation starts idle after completing', { timeout: 2500 }, async t => {
  const h = await server(t); const deadline = Date.now() + 350;
  while (Date.now() < deadline && h.s.server.listening) { try { await fetch(h.origin + '/api/session', { headers: h.headers }); } catch (_) {} await wait(20); }
  await h.s.closed; assert.equal(await rebind(h.port), true);
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), work = new Promise(resolve => { release = resolve; });
  const active = await server(t, { dataService: { async testProfile() { entered(); await work; return { outcome: 'success' }; } } });
  const response = post(active, '/api/profiles/local_' + pageA + '/test', { revision: 1 }); await started; await wait(250);
  assert.equal(active.s.server.listening, true); assert.equal((await (await fetch(active.origin + '/api/session', { headers: active.headers })).json()).operations_in_flight, 1);
  const completedAt = Date.now(); release(); assert.equal((await response).status, 200); await active.s.closed; assert.ok(Date.now() - completedAt >= 100); assert.equal(await rebind(active.port), true);
});

test('half body is not an active operation and completion after idle expiry writes nothing', { timeout: 2500 }, async t => {
  const h = await server(t); let writes = 0; const save = h.profileStore.save.bind(h.profileStore); h.profileStore.save = value => { writes++; return save(value); };
  const u = new URL(h.origin), socket = net.connect(h.port, '127.0.0.1'); await once(socket, 'connect'); socket.on('error', () => {}); socket.resume();
  const content = JSON.stringify({ name: 'late', api_base_url: 'http://isolated.invalid' }); const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(`POST /api/profiles HTTP/1.1\r\nHost: ${u.host}\r\nOrigin: ${h.origin}\r\nX-Config-Token: ${h.headers['X-Config-Token']}\r\nContent-Type: application/json\r\nContent-Length: ${content.length}\r\n\r\n{`);
  await wait(160); socket.write(content.slice(1)); await h.s.closed; await closed; assert.equal(writes, 0); assert.equal(await rebind(h.port), true);
});

test('v2 registry ignores a cached initial deadline while the actual managed service remains foreground-active', { timeout: 4000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-idle-managed-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profileStore = new SolverProfileStore({ XDG_CONFIG_HOME: directory }); const session = await launchTargetConfig({ profileStore, idleTimeoutMs: 180, sessionOptions: { foregroundLeaseMs: 500, heartbeatMs: 100 } });
  const u = new URL(session.url), h = { origin: u.origin, headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) } }; t.after(async () => { try { await post(h, '/api/close', {}); } catch (_) {} });
  const loc = life.location(life.canonicalConfigFile(profileStore.file), MANAGER_BUILD_ID), record = life.readPrivate(loc.file); assert.equal(record.protocol, 'isingq-manager-lifecycle-v3'); assert.equal(Object.hasOwn(record, 'deadline_at'), false);
  await post(h, '/api/activity', { page_id: pageA, sequence: 1, visible: true, interactive: true }); await wait(240);
  const reused = await launchTargetConfig({ profileStore, idleTimeoutMs: 180 }); assert.equal(reused.pid, session.pid); assert.ok(reused.url === session.url); assert.equal(reused.expires_at, null);
  await post(h, '/api/activity', { page_id: pageA, sequence: 2, visible: false, interactive: false });
  const deadline = Date.now() + 2000; while (Date.now() < deadline && fs.existsSync(loc.file)) await wait(20);
  assert.equal(fs.existsSync(loc.file), false); assert.equal(await rebind(Number(u.port)), true);
  const exitDeadline = Date.now() + life.SHUTDOWN_TIMEOUT_MS;
  while (life.alive(session.pid) && Date.now() < exitDeadline) await wait(Math.min(10, Math.max(1, exitDeadline - Date.now())));
  assert.equal(life.alive(session.pid), false, 'managed process must exit within the declared1s shutdown observation budget');
});
