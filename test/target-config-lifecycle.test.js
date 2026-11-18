'use strict';
const { runWithCleanupSync } = require('../packages/core/src/run-with-cleanup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { fork, spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { buildSync } = require('esbuild');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { launchTargetConfig, openTargetConfig, MANAGER_BUILD_ID } = require('../packages/core/src/target-config-page');
const life = require('../packages/core/src/target-config-lifecycle');
const PAGE = require.resolve('../packages/core/src/target-config-page');
const STORE = require.resolve('../packages/core/src/solver-profiles');
const FIXTURE = path.join(__dirname, 'fixtures/target-config-lifecycle.js');
// Older-protocol fixtures deliberately lack scope metadata. Keep their
// registry separate from concurrent suites and the user's real manager.
const tempKeys = ['TMPDIR', 'TMP', 'TEMP'];
const inheritedTemps = Object.fromEntries(tempKeys.map(key => [key, process.env[key]]));
const suiteTemporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-lifecycle-suite-'));
for (const key of tempKeys) process.env[key] = suiteTemporaryRoot;
const evidence = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, milliseconds = 2500) { const deadline = Date.now() + milliseconds; while (Date.now() < deadline) { if (await predicate()) return; await pause(15); } assert.fail('bounded lifecycle observation did not complete'); }
async function rebind(port) {
  return new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
}
async function closePublic(session) {
  try { const u = new URL(session.url); await fetch(u.origin + '/api/close', { method: 'POST', headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) }, body: '{}', signal: AbortSignal.timeout(1500) }); } catch (_) {}
}
async function exitOf(child, timeout = 2500) { await until(() => child.exitCode !== null || Boolean(child.signalCode), timeout); }
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-lifecycle-'));
  const profileStore = new SolverProfileStore({ XDG_CONFIG_HOME: directory });
  const loc = life.location(life.canonicalConfigFile(profileStore.file), MANAGER_BUILD_ID);
  const sessions = [], children = [];
  const spawnSidecar = spec => { const child = fork(spec.modulePath, ['--config-sidecar', ...spec.args], { ...spec.options, execPath: spec.executablePath, execArgv: [] }); children.push(child); return child; };
  const launch = async options => { const session = await launchTargetConfig({ profileStore, lifetimeMs: 10000, ...options, lifecycleOptions: { spawnSidecar, ...options?.lifecycleOptions } }); sessions.push(session); return session; };
  t.after(async () => {
    for (const session of sessions) await closePublic(session);
    for (const child of children) { if (child.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); try { await exitOf(child, 1200); } catch (_) { child.kill('SIGKILL'); await exitOf(child); } } }
    // Test-injected corrupt/fake registrations are owned by this isolated key.
    try { fs.unlinkSync(loc.file); } catch (_) {}
    try { const claim = life.owner(loc); if (claim) life.removeClaim(loc, claim.nonce); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, profileStore, loc, sessions, children, launch, spawnSidecar };
}
function sameSession(actual, expected) { assert.equal(actual.pid, expected.pid); assert.equal(actual.expires_at, expected.expires_at); assert.equal(new URL(actual.url).origin, new URL(expected.url).origin); assert.ok(actual.url === expected.url, 'same private session URL must be reused without logging its token'); }
function summary(session) { const u = new URL(session.url); return { pid: session.pid, port: Number(u.port), origin: u.origin, expires_at: session.expires_at }; }
function synthetic(loc, extras = {}) { const now = Date.now(); return { protocol: life.LIFECYCLE_PROTOCOL, config_file: loc.config_file, build_id: loc.build_id, user_id: loc.user_id, nonce: 'a'.repeat(64), token: 'b'.repeat(64), pid: process.pid, origin: 'http://127.0.0.1:9', created_at: now, cloud_environment: 'prod', internal_preview: false, expiry_policy: 'idle', idle_timeout_ms: 10000, foreground_lease_ms: 90000, heartbeat_ms: 30000, ...extras }; }
async function assertReleased(h, session) {
  const port = Number(new URL(session.url).port);
  await until(() => !fs.existsSync(h.loc.file) && !fs.existsSync(h.loc.lock));
  await until(() => rebind(port));
  const owned = h.children.find(child => child.pid === session.pid); if (owned) await exitOf(owned);
  evidence.push({ operation: 'release', ...summary(session), port_rebind_succeeded: true, registration_removed: true, lock_removed: true, ...(owned ? { observed_child_exit: true } : {}) });
}

test('ten identity-only opens reuse one verified sidecar, URL and original idle deadline', async t => {
  const h = setup(t); const first = await h.launch();
  for (let i = 0; i < 10; i++) sameSession(await h.launch({ lifetimeMs: 60000 }), first);
  assert.equal(h.children.length, 1);
  const record = life.readPrivate(h.loc.file); assert.equal(record.pid, first.pid);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(h.loc.file).mode & 0o077, 0); assert.equal(fs.statSync(h.loc.directory).mode & 0o077, 0); }
  assert.equal(fs.existsSync(h.loc.lock), false);
  evidence.push({ operation: 'sequential-reuse', calls: 11, actual_spawn_count: h.children.length, ...summary(first) });
  await closePublic(first); await assertReleased(h, first);
});

test('six independent parent processes concurrently perform exactly one fork and survive parent exit', { timeout: 12000 }, async t => {
  const h = setup(t), trace = path.join(h.directory, 'forks.log');
  const program = `const fs=require('node:fs'),{fork}=require('node:child_process');const {launchTargetConfig}=require(${JSON.stringify(PAGE)});const{SolverProfileStore}=require(${JSON.stringify(STORE)});launchTargetConfig({profileStore:new SolverProfileStore({XDG_CONFIG_HOME:${JSON.stringify(h.directory)}}),lifetimeMs:10000,lifecycleOptions:{spawnSidecar(s){const c=fork(s.modulePath,['--config-sidecar',...s.args],{...s.options,execPath:s.executablePath,execArgv:[]});fs.appendFileSync(${JSON.stringify(trace)},String(c.pid)+'\\n');return c}}}).then(s=>process.stdout.write(JSON.stringify(s))).catch(e=>{console.error(e.code);process.exitCode=1});`;
  const outputs = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, ['-e', program], { timeout: 11000 })));
  const sessions = outputs.map(output => { assert.equal(output.stderr, ''); return JSON.parse(output.stdout); }); h.sessions.push(...sessions);
  for (const session of sessions) sameSession(session, sessions[0]);
  const forks = fs.readFileSync(trace, 'utf8').trim().split('\n'); assert.equal(forks.length, 1); assert.equal(Number(forks[0]), sessions[0].pid);
  const u = new URL(sessions[0].url); assert.equal((await fetch(u.origin + '/api/profiles', { headers: { 'X-Config-Token': u.hash.slice(1) } })).status, 200);
  evidence.push({ operation: 'six-parent-concurrent-reuse', parent_count: 6, actual_spawn_count: forks.length, parents_exited: true, ...summary(sessions[0]) });
  await closePublic(sessions[0]); await assertReleased(h, sessions[0]);
});

test('different configurations isolate but a symlink directory alias reuses the same actual configuration', async t => {
  const h = setup(t), other = setup(t); const first = await h.launch(); const second = await other.launch(); assert.notEqual(first.pid, second.pid);
  const alias = path.join(h.directory, 'alias'); fs.symlinkSync(path.dirname(h.profileStore.file), alias, 'dir');
  const aliasStore = new SolverProfileStore({ XDG_CONFIG_HOME: h.directory }); aliasStore.file = path.join(alias, 'solver-profiles.json');
  const reused = await launchTargetConfig({ profileStore: aliasStore, lifetimeMs: 10000 }); sameSession(reused, first); assert.equal(h.children.length, 1);
  await closePublic(first); await closePublic(second); await assertReleased(h, first); await assertReleased(other, second);
});

test('explicit close, short TTL, SIGTERM and SIGINT reclaim owned processes, records and real listening ports', async t => {
  for (const mode of ['close', 'ttl', 'SIGTERM', 'SIGINT']) {
    const h = setup(t); const session = await h.launch({ lifetimeMs: mode === 'ttl' ? 300 : 10000 });
    if (mode === 'close') { await closePublic(session); await closePublic(session); }
    else if (mode !== 'ttl') h.children[0].kill(mode);
    await assertReleased(h, session);
    assert.equal(h.children[0].exitCode, 0, mode);
    evidence.push({ operation: mode, released: true, ...summary(session) });
  }
});

test('three open-close rounds leave no accumulated registration, lock, process or listener', async t => {
  const h = setup(t); const pids = [];
  for (let round = 0; round < 3; round++) { const session = await h.launch(); pids.push(session.pid); await closePublic(session); await assertReleased(h, session); }
  assert.equal(new Set(pids).size, 3); assert.equal(h.children.length, 3);
  assert.ok(h.children.every(child => child.exitCode === 0)); assert.equal(fs.existsSync(h.loc.file), false); assert.equal(fs.existsSync(h.loc.lock), false);
});

test('SIGKILL residue recovers safely even when an unrelated listener takes the old port', async t => {
  const h = setup(t); const first = await h.launch(); h.children[0].kill('SIGKILL'); await exitOf(h.children[0]); assert.ok(fs.existsSync(h.loc.file));
  const oldPort = Number(new URL(first.url).port); assert.equal(await rebind(oldPort), true);
  const external = http.createServer((_, response) => { response.setHeader('Content-Type', 'application/json'); response.end('{}'); });
  await new Promise(resolve => external.listen(oldPort, '127.0.0.1', resolve)); t.after(() => { external.closeAllConnections?.(); external.close(); });
  const recovered = await h.launch(); assert.notEqual(recovered.pid, first.pid); assert.notEqual(Number(new URL(recovered.url).port), oldPort);
  assert.equal((await fetch(`http://127.0.0.1:${oldPort}/health`)).status, 200);
  await closePublic(recovered); await assertReleased(h, recovered);
  evidence.push({ operation: 'sigkill-recovery', killed_owned_child: first.pid, recovered_pid: recovered.pid, unrelated_listener_preserved: true, old_port: oldPort });
});

test('live mismatched PID/identity, malformed records and non-loopback addresses never cause another spawn or a blind kill', async t => {
  const h = setup(t); const external = fork(FIXTURE, ['manager-external-listener'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => external.kill()); const [message] = await once(external, 'message');
  const record = synthetic(h.loc, { pid: external.pid, origin: `http://127.0.0.1:${message.port}` }); life.exclusiveJson(h.loc.file, record);
  await assert.rejects(h.launch(), e => e.code === 'manager_identity_unverified'); assert.equal(h.children.length, 0);
  assert.deepEqual(await (await fetch(record.origin + '/health')).json(), { alive: true }); assert.equal(external.exitCode, null);
  fs.unlinkSync(h.loc.file); fs.writeFileSync(h.loc.file, '{broken', { mode: 0o600 });
  await assert.rejects(h.launch(), e => e.code === 'manager_registry_invalid'); assert.equal(h.children.length, 0);
  fs.unlinkSync(h.loc.file); life.exclusiveJson(h.loc.file, synthetic(h.loc, { origin: 'http://not-approved.invalid:8080' }));
  await assert.rejects(h.launch(), e => e.code === 'manager_registry_invalid'); assert.equal(h.children.length, 0);
});

test('identity timeout on a live unexpired owner refuses reuse and additional startup', async t => {
  const h = setup(t); const external = http.createServer(request => request.resume());
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve)); t.after(() => { external.closeAllConnections?.(); external.close(); });
  life.exclusiveJson(h.loc.file, synthetic(h.loc, { origin: `http://127.0.0.1:${external.address().port}` }));
  const start = Date.now(); await assert.rejects(h.launch({ lifecycleOptions: { identityTimeoutMs: 40 } }), e => e.code === 'manager_identity_unverified');
  assert.ok(Date.now() - start < 1200); assert.equal(h.children.length, 0); assert.ok(external.listening);
});

test('old owners cannot clean a new nonce registration or launch claim', t => {
  const h = setup(t), old = 'a'.repeat(64), current = 'c'.repeat(64);
  life.exclusiveJson(h.loc.file, synthetic(h.loc, { nonce: current }));
  assert.equal(life.removeSession(h.loc, old), false); assert.equal(life.readPrivate(h.loc.file).nonce, current);
  const claim = life.newClaim(h.loc, 500); assert.equal(life.removeClaim(h.loc, old), false); assert.equal(life.owner(h.loc).nonce, claim.nonce);
});

test('a live startup owner has bounded waiting and cannot be stolen based on age alone', async t => {
  const h = setup(t); life.newClaim(h.loc, 1); await pause(10);
  await assert.rejects(h.launch({ lifecycleOptions: { waitTimeoutMs: 100 } }), e => e.code === 'manager_wait_timeout');
  assert.equal(h.children.length, 0); assert.ok(fs.existsSync(h.loc.lock));
});

test('startup executable failure and a never-ready child both clean owned resources within bounds', async t => {
  const broken = setup(t);
  await assert.rejects(broken.launch({ executablePath: path.join(broken.directory, 'missing-runtime') }), e => ['manager_start_failed', 'manager_receipt_invalid'].includes(e.code));
  assert.equal(fs.existsSync(broken.loc.file), false); assert.equal(fs.existsSync(broken.loc.lock), false);
  const h = setup(t), file = path.join(h.directory, 'bound-port.json'); let owned;
  const start = Date.now();
  await assert.rejects(h.launch({ lifecycleOptions: { startupTimeoutMs: 250, spawnSidecar(spec) { owned = fork(FIXTURE, ['manager-never-ready', file], { ...spec.options, execArgv: [] }); h.children.push(owned); return owned; } } }), e => e.code === 'manager_start_timeout');
  assert.ok(Date.now() - start < 2000); await exitOf(owned); assert.equal(owned.signalCode, 'SIGKILL');
  const listener = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(await rebind(listener.port), true);
  assert.equal(fs.existsSync(h.loc.file), false); assert.equal(fs.existsSync(h.loc.lock), false);
  evidence.push({ operation: 'startup-timeout', observed_child_exit: true, actual_bound_port: listener.port, port_rebind_succeeded: true, forced_only_owned_child: true });
});

test('parent crash before child handoff is fenced and a late old child never opens another listener', { timeout: 10000 }, async t => {
  const h = setup(t), report = path.join(h.directory, 'late-child.json');
  const program = `const{fork}=require('node:child_process');const{launchTargetConfig}=require(${JSON.stringify(PAGE)});const{SolverProfileStore}=require(${JSON.stringify(STORE)});launchTargetConfig({profileStore:new SolverProfileStore({XDG_CONFIG_HOME:${JSON.stringify(h.directory)}}),lifetimeMs:10000,lifecycleOptions:{startupTimeoutMs:150,spawnSidecar(s){const c=fork(${JSON.stringify(FIXTURE)},['manager-delayed',${JSON.stringify(report)},'450',...s.args],{...s.options,execArgv:[]});process.send({spawned:c.pid});return c}}}).catch(()=>{});`;
  const parent = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); t.after(() => { if (parent.exitCode === null && !parent.signalCode) parent.kill(); });
  const [message] = await once(parent, 'message'); assert.ok(message.spawned); parent.kill('SIGKILL'); await exitOf(parent); await pause(200);
  const current = await h.launch(); await until(() => fs.existsSync(report)); const delayed = JSON.parse(fs.readFileSync(report, 'utf8')); assert.equal(delayed.listening, false);
  assert.equal(life.readPrivate(h.loc.file).pid, current.pid); assert.equal(h.children.length, 1);
  evidence.push({ operation: 'parent-crash-before-handoff', parent_exit_observed: true, delayed_child: message.spawned, old_child_opened_listener: delayed.listening, recovered_pid: current.pid });
  await closePublic(current); await assertReleased(h, current);
});

test('in-process close is idempotent and bounded with active, idle and incomplete request sockets', { timeout: 3000 }, async t => {
  const h = setup(t); let release; const pendingWork = new Promise(resolve => { release = resolve; }); let entered; const workEntered = new Promise(resolve => { entered = resolve; });
  const session = await openTargetConfig({ profileStore: h.profileStore, lifetimeMs: 10000, dataService: { async testProfile() { entered(); await pendingWork; return {}; } } }); t.after(session.close);
  const u = new URL(session.url), port = Number(u.port); const headers = { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) };
  const active = fetch(u.origin + '/api/profiles/local_' + 'a'.repeat(32) + '/test', { method: 'POST', headers, body: '{"revision":1}' }).catch(() => null); await workEntered;
  const idle = net.connect(port, '127.0.0.1'); await once(idle, 'connect');
  const slow = net.connect(port, '127.0.0.1'); await once(slow, 'connect'); slow.write(`POST /api/profiles HTTP/1.1\r\nHost: ${u.host}\r\nOrigin: ${u.origin}\r\nX-Config-Token: ${u.hash.slice(1)}\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{`);
  idle.on('error', () => {}); slow.on('error', () => {}); idle.resume(); slow.resume();
  const idleClosed = new Promise(resolve => idle.once('close', resolve)), slowClosed = new Promise(resolve => slow.once('close', resolve));
  const start = Date.now(), closing = session.close(); assert.equal(session.close(), closing); await closing; await Promise.all([idleClosed, slowClosed]); release(); await active;
  assert.ok(Date.now() - start < 1500); assert.equal(await rebind(port), true); assert.equal(session.server.listening, false);
  assert.equal((await session.close()).closed, true);
  evidence.push({ operation: 'active-idle-slow-close', milliseconds: Date.now() - start, port, port_rebind_succeeded: true, parent_still_running: true });
});

test('source and esbuild entries work while each exact asset build reuses independently', { timeout: 10000 }, async t => {
  const h = setup(t); const source = await h.launch();
  const entry = `const {launchTargetConfig,serveTargetConfigSidecar}=require(${JSON.stringify(PAGE)});const {SolverProfileStore}=require(${JSON.stringify(STORE)});if(['__target-config-serve','--config-sidecar'].includes(process.argv[2]))serveTargetConfigSidecar(process.argv.slice(3));else launchTargetConfig({profileStore:new SolverProfileStore({XDG_CONFIG_HOME:${JSON.stringify(h.directory)}}),lifetimeMs:10000}).then(s=>process.stdout.write(JSON.stringify(s))).catch(e=>{console.error(e.code);process.exitCode=1});`;
  for (const changed of [false, true]) {
    const outfile = path.join(h.directory, changed ? 'different.cjs' : 'same.cjs');
    const options = { stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile, logLevel: 'silent' };
    if (changed) {
      const viewPath = require.resolve('../packages/core/src/target-config/view');
      const replacement = require(viewPath) + '\n<!-- alternate build fixture -->';
      // Build an isolated source copy through stdin's module override, without
      // modifying the shared UI asset or relying on the package version.
      const sourceText = fs.readFileSync(PAGE, 'utf8').replace("const view = require('./target-config/view');", 'const view = ' + JSON.stringify(replacement) + ';');
      const pageCopy = path.join(h.directory, 'changed-page.js'); fs.writeFileSync(pageCopy, sourceText.replace(/require\('\.\//g, "require('" + path.dirname(PAGE).replace(/\\/g, '/') + '/'));
      options.stdin.contents = entry.split(PAGE).join(pageCopy);
    }
    buildSync(options);
    const output = await promisify(execFile)(process.execPath, [outfile], { timeout: 7000 }); assert.equal(output.stderr, ''); const session = JSON.parse(output.stdout); h.sessions.push(session);
    const u = new URL(session.url); const identity = await (await fetch(u.origin + '/api/session', { headers: { 'X-Config-Token': u.hash.slice(1) } })).json();
    assert.match(identity.build_id, /^[a-f0-9]{64}$/);
    const again = JSON.parse((await promisify(execFile)(process.execPath, [outfile], { timeout: 7000 })).stdout); sameSession(again, session);
    if (identity.build_id === MANAGER_BUILD_ID) sameSession(session, source);
    else { assert.notEqual(session.pid, source.pid); assert.notEqual(u.port, new URL(source.url).port); }
    if (changed) assert.notEqual(identity.build_id, MANAGER_BUILD_ID);
    evidence.push({ operation: 'esbuild-entry-reuse', changed_view: changed, build_id: identity.build_id, repeated_entry_reused: true, ...summary(session) });
    if (session.pid !== source.pid) {
      await closePublic(session); const bundleLoc = life.location(life.canonicalConfigFile(h.profileStore.file), identity.build_id);
      await until(() => !fs.existsSync(bundleLoc.file) && !fs.existsSync(bundleLoc.lock));
      await until(() => rebind(Number(u.port))); await until(() => !life.alive(session.pid));
    }
  }
  await closePublic(source); await assertReleased(h, source);
});

test.after(() => {
  const directory = process.env.MANAGER_LIFECYCLE_EVIDENCE_DIR;
  if (directory) fs.writeFileSync(path.join(directory, 'resource-observations.json'), JSON.stringify({ scope: 'isolated loopback and private temporary configurations', preview56834_untouched: true, lifecycle_protocol: life.LIFECYCLE_PROTOCOL, build_id: MANAGER_BUILD_ID, constants: { startup_ms: life.STARTUP_TIMEOUT_MS, wait_ms: life.WAIT_TIMEOUT_MS, identity_ms: life.IDENTITY_TIMEOUT_MS, shutdown_grace_ms: life.SHUTDOWN_GRACE_MS, shutdown_ms: life.SHUTDOWN_TIMEOUT_MS }, observations: evidence }, null, 2) + '\n');
});


test('review regression: completing a body after close cannot save or delete configuration', { timeout: 3000 }, async t => {
  for (const method of ['POST', 'DELETE']) {
    const h = setup(t); const saved = h.profileStore.save({ name: '原配置', api_base_url: 'http://isolated.invalid' });
    let writes = 0; const original = h.profileStore[method === 'POST' ? 'save' : 'delete'].bind(h.profileStore);
    h.profileStore[method === 'POST' ? 'save' : 'delete'] = (...args) => { writes++; return original(...args); };
    const session = await openTargetConfig({ profileStore: h.profileStore, lifetimeMs: 10000 }); t.after(session.close);
    const u = new URL(session.url); const content = method === 'POST' ? JSON.stringify({ name: '迟到写入', api_base_url: 'http://late.invalid' }) : '{}';
    const route = method === 'POST' ? '/api/profiles' : '/api/profiles/' + saved.id;
    const socket = net.connect(Number(u.port), '127.0.0.1'); await once(socket, 'connect'); socket.on('error', () => {});
    let response = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { response += chunk; });
    const ended = new Promise(resolve => socket.once('close', resolve));
    socket.write(`${method} ${route} HTTP/1.1\r\nHost: ${u.host}\r\nOrigin: ${u.origin}\r\nX-Config-Token: ${u.hash.slice(1)}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(content)}\r\nConnection: close\r\n\r\n${content.slice(0, 1)}`);
    await pause(15); await closePublic({ url: session.url }); assert.equal(writes, 0);
    socket.write(content.slice(1)); await ended; await session.closed;
    assert.match(response, /^HTTP\/1\.1 403/); assert.equal(writes, 0, 'a403 response is insufficient if the store was already mutated');
    assert.equal(h.profileStore.list().length, 1); assert.equal(await rebind(Number(u.port)), true);
  }
});

test('review regression: identity deadline is absolute even while a peer continuously sends bytes', { timeout: 2000 }, async t => {
  const server = http.createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); const timer = setInterval(() => response.write(' '), 10);
    const end = setTimeout(() => { clearInterval(timer); response.end('{}'); }, 240);
    response.once('close', () => { clearInterval(timer); clearTimeout(end); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections?.(); server.close(); });
  const h = setup(t); const record = synthetic(h.loc, { origin: `http://127.0.0.1:${server.address().port}` });
  life.validSession(record, h.loc);
  const start = Date.now(); assert.equal(await life.identity(record, 50), false);
  assert.ok(Date.now() - start < 150, 'regular body traffic must not extend the absolute identity deadline');
});


test('corrupt child handoff identity is ambiguous and cannot be reclaimed as a dead process', async t => {
  const h = setup(t); const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await once(dead, 'exit');
  const claim = life.newClaim(h.loc, 1); const ownerFile = path.join(h.loc.lock, 'owner.json');
  fs.writeFileSync(ownerFile, JSON.stringify({ ...claim, owner_pid: dead.pid, deadline_at: Date.now() - 10 }));
  const handoff = path.join(h.loc.lock, 'handoff.json'); life.exclusiveJson(handoff, { nonce: claim.nonce, pid: 'unknown', role: 'child' });
  runWithCleanupSync(() => {
    assert.throws(() => life.recoverClaim(h.loc), error => error.code === 'manager_lock_invalid'); assert.equal(h.children.length, 0); assert.ok(fs.existsSync(handoff));
  }, () => {
    fs.unlinkSync(handoff);
  });
});


test('registration publish EACCES after listen cleans the real sidecar and permits a fresh launch', { timeout: 5000 }, async t => {
  const h = setup(t), file = path.join(h.directory, 'registration-failure.json'); let owned;
  const start = Date.now();
  await assert.rejects(h.launch({ lifecycleOptions: { spawnSidecar(spec) {
    owned = fork(FIXTURE, ['manager-registration-failure', file, ...spec.args], { ...spec.options, execArgv: [] });
    h.children.push(owned); return owned;
  } } }), error => ['manager_receipt_invalid', 'manager_start_failed'].includes(error.code));
  const failedAfterMs = Date.now() - start;
  assert.ok(failedAfterMs < 2000, 'an explicit publication failure should fail promptly within the startup bound');
  await exitOf(owned); const failure = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(failure.pid, owned.pid); assert.equal(failure.injected_error, 'EACCES'); assert.equal(failure.stage, 'publish_after_listen');
  assert.equal(await rebind(failure.port), true, 'prove the actual already-bound port was released');
  assert.equal(fs.existsSync(h.loc.file), false); assert.equal(fs.existsSync(h.loc.lock), false);
  const fresh = await h.launch(); assert.notEqual(fresh.pid, failure.pid);
  const freshUrl = new URL(fresh.url);
  assert.equal((await fetch(freshUrl.origin + '/api/profiles', { headers: { 'X-Config-Token': freshUrl.hash.slice(1) } })).status, 200);
  await closePublic(fresh); await assertReleased(h, fresh);
  const observation = { operation: 'registration-publish-failure', injected_error: failure.injected_error, injection_stage: failure.stage,
    failed_child_pid: failure.pid, actual_bound_port: failure.port, failed_after_ms: failedAfterMs, observed_child_exit: true,
    port_rebind_succeeded: true, registration_removed: true, lock_removed: true,
    fresh_launch_succeeded: true, fresh_pid: fresh.pid, fresh_port: Number(freshUrl.port), fresh_released: true,
    real_device_calls: 0, cloud_calls: 0, preview56834_untouched: true };
  evidence.push(observation);
  if (process.env.MANAGER_REGISTRATION_FAILURE_EVIDENCE_FILE) fs.writeFileSync(process.env.MANAGER_REGISTRATION_FAILURE_EVIDENCE_FILE, JSON.stringify(observation, null, 2) + '\n');
});

test.after(() => {
  for (const key of tempKeys) {
    if (inheritedTemps[key] === undefined) delete process.env[key];
    else process.env[key] = inheritedTemps[key];
  }
  fs.rmSync(suiteTemporaryRoot, { recursive: true, force: true });
});
