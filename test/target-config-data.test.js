'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { TargetConfigData } = require('../packages/core/src/target-config-data');
const { openTargetConfig } = require('../packages/core/src/target-config-page');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { LocalSolverTransport } = require('../packages/core/src/local-target');
const { CloudCatalogClient } = require('../packages/core/src/cloud-target');
const CHECKED = '2026-11-11T03:04:05.000Z';
const INFO = { config: { deviceName: '返回的设备名称', version: 'fixture-v1', maxScale: 2049, maxPrecision: '8bit' }, runtime: { bootTimestamp: 12345 }, status: { status: 'stable' } };
const CATALOG = { schemaVersion: 1, uploadLimits: { maxCsvBytes: 12345 }, computerTypes: [{ id: 11, name: null, spinNumber: '2049', price: 0, computeCreditCost: 0, executionCapabilities: null }] };
const EMPTY = { ...CATALOG, computerTypes: [] };
const clone = value => structuredClone(value);
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'config-data-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profileStore = new SolverProfileStore({ XDG_CONFIG_HOME: directory });
  const profile = profileStore.save({ name: '用户别名A', api_base_url: 'http://isolated.invalid:8080/prefix', web_base_url: 'http://isolated.invalid/view' });
  return { profileStore, profile };
}
function localFactory(calls, behavior = (group) => json({ code: 10000, data: INFO[group] })) {
  return (profile, options) => {
    const transport = new LocalSolverTransport({ profile, ...options, fetch: async (url, request) => {
      const match = /\/api\/device\/(config|runtime|status)$/.exec(url);
      assert.ok(match, 'only the three readonly device endpoints may be called');
      assert.equal(url, `${profile.api_base_url}/api/device/${match[1]}`);
      assert.equal(request.method, 'POST'); assert.equal(request.body, '{}'); assert.equal(request.redirect, 'error');
      calls.push({ profile, url, request, group: match[1] }); return behavior(match[1], request);
    } });
    transport.probe = () => assert.fail('strict solve probe must not discard partial information');
    transport.submit = () => assert.fail('connection test must never submit');
    return transport;
  };
}
async function page(t, options = {}) {
  const saved = fixture(t); const session = await openTargetConfig({ ...saved, lifetimeMs: 10000, now: () => CHECKED, ...options }); t.after(session.close);
  const url = new URL(session.url);
  return { ...saved, session, origin: url.origin, headers: { 'X-Config-Token': url.hash.slice(1), Origin: url.origin, 'Content-Type': 'application/json' } };
}
async function isolatedServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('saved-profile test reuses only readonly transport requests, exposes actual fields and never needs a model', async t => {
  const { profileStore, profile } = fixture(t), calls = [];
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls), now: () => CHECKED });
  const result = await data.testProfile(profile.id, { revision: profile.revision });
  assert.equal(result.outcome, 'success'); assert.equal(result.profile_id, profile.id); assert.equal(result.profile_revision, 1); assert.equal(result.checked_at, CHECKED);
  assert.deepEqual(result.device, { name: '返回的设备名称', version: 'fixture-v1', max_scale: 2049, max_precision: '8bit', status: 'stable', boot_timestamp: 12345 });
  assert.deepEqual(result.issues, []); assert.deepEqual(result.observation, { source: 'toolkit_host', read_only: true, task_submitted: false });
  assert.equal(calls.length, 3); assert.equal(profileStore.get(profile.id).name, '用户别名A');
  assert.equal(Object.hasOwn(result, 'can_submit'), false); assert.equal(Object.hasOwn(result.device, 'coefficient_min'), false);
  for (const call of calls) assert.equal(Object.keys(call.request.headers).some(key => /authorization|channel|cookie/i.test(key)), false);
});

test('independent endpoint failures and missing fields keep successful information instead of strict-probe all-or-nothing', async t => {
  const { profileStore, profile } = fixture(t), calls = [];
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls, group => {
    if (group === 'config') return json({ code: 10000, data: { deviceName: '部分信息', version: '1', maxScale: 4095 } });
    if (group === 'runtime') throw new Error('secret-fixture-network-diagnostic');
    return json({ code: 10007, msg: 'secret-fixture-provider-message', data: {} });
  }) });
  const result = await data.testProfile(profile.id, { revision: 1 });
  assert.equal(result.outcome, 'partial'); assert.equal(result.device.name, '部分信息'); assert.equal(result.device.max_scale, 4095);
  assert.equal(result.device.max_precision, null); assert.equal(result.device.boot_timestamp, null); assert.equal(result.device.status, null);
  assert.ok(result.issues.some(issue => issue.field === 'max_precision' && issue.code === 'device_field_missing'));
  assert.ok(result.issues.some(issue => issue.field === 'runtime' && issue.code === 'local_request_failed'));
  assert.ok(result.issues.some(issue => issue.field === 'status' && issue.provider_code === 10007));
  assert.doesNotMatch(JSON.stringify(result), /secret-fixture|offline/); assert.equal(calls.length, 3);
});

test('invalid field types stay unknown without coercing scale, precision or operating state', async t => {
  const { profileStore, profile } = fixture(t), calls = [];
  const bodies = { config: { deviceName: '保留名称', version: null, maxScale: '2049', maxPrecision: 8 }, runtime: { bootTimestamp: -1 }, status: { status: false } };
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls, group => json({ code: 10000, data: bodies[group] })) });
  const result = await data.testProfile(profile.id, { revision: 1 });
  assert.equal(result.outcome, 'partial'); assert.equal(result.device.name, '保留名称');
  for (const field of ['version', 'max_scale', 'max_precision', 'status', 'boot_timestamp']) assert.equal(result.device[field], null, field);
  assert.equal(result.issues.length, 5); assert.ok(result.issues.every(issue => /device_field_/.test(issue.code)));
});

test('all invalid or failed device reads produce a failed DTO, not a successful connection just because HTTP200', async t => {
  const { profileStore, profile } = fixture(t), calls = [];
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls, () => new Response('<html>secret-provider-debug</html>')) });
  const result = await data.testProfile(profile.id, { revision: 1 });
  assert.equal(result.outcome, 'failed'); assert.ok(Object.values(result.device).every(value => value === null)); assert.equal(result.issues.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /secret-provider-debug|offline/);
});

test('missing independent local credentials fail without sending requests or disclosing provider errors', async t => {
  const { profileStore, profile } = fixture(t); let requests = 0;
  const data = new TargetConfigData({ profileStore, localTransportFactory: p => new LocalSolverTransport({ profile: p, credentialProvider() { throw new Error('credential-fixture-secret'); }, fetch() { requests++; throw new Error('not called'); } }) });
  const result = await data.testProfile(profile.id, { revision: 1 });
  assert.equal(result.outcome, 'failed'); assert.equal(result.issues[0].code, 'local_credentials_invalid'); assert.equal(requests, 0); assert.doesNotMatch(JSON.stringify(result), /credential-fixture-secret/);
});

test('invalid ids, stale versions and arbitrary transient URL/model options stop before any provider request', async t => {
  const { profileStore, profile } = fixture(t), calls = [];
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls) });
  for (const body of [null, {}, [], { revision: 0 }, { revision: '1' }, { revision: 1, url: 'http://unapproved.invalid' }, { revision: 1, qubo: {} }]) await assert.rejects(data.testProfile(profile.id, body), e => e.status === 400);
  await assert.rejects(data.testProfile('invalid', { revision: 1 }), e => e.status === 404);
  await assert.rejects(data.testProfile('local_' + 'f'.repeat(32), { revision: 1 }), e => e.status === 404);
  profileStore.save({ ...profile, name: '改过的连接' });
  await assert.rejects(data.testProfile(profile.id, { revision: 1 }), e => e.status === 409);
  assert.equal(calls.length, 0);
});

for (const change of ['edit', 'delete']) {
  test('asynchronous test discards late device information after profile ' + change, async t => {
    const { profileStore, profile } = fixture(t), calls = [], entered = gate(), release = gate();
    const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls, async group => { entered.resolve(); await release.promise; return json({ code: 10000, data: INFO[group] }); }) });
    const pending = data.testProfile(profile.id, { revision: 1 }); const captured = pending.catch(error => error);
    await entered.promise;
    if (change === 'edit') profileStore.save({ ...profile, api_base_url: 'http://changed.invalid:8080/other' }); else profileStore.delete(profile.id);
    release.resolve(); const error = await captured;
    assert.equal(error.status, change === 'edit' ? 409 : 404); assert.equal(Object.hasOwn(error, 'device'), false); assert.equal(calls.length, 3);
  });
}

test('same id/revision with replaced saved address is detected by profile identity CAS', async () => {
  const id = 'local_' + 'a'.repeat(32); let current = { id, revision: 1, name: '原连接', api_base_url: 'http://original.invalid', web_base_url: null };
  const entered = gate(), release = gate();
  const data = new TargetConfigData({ profileStore: { get() { return clone(current); } }, localTransportFactory: () => ({ prepareSubmission() {}, async request(route) { entered.resolve(); await release.promise; const group = route.split('/').at(-1); return clone(INFO[group]); } }) });
  const pending = data.testProfile(id, { revision: 1 }).catch(error => error); await entered.promise;
  current = { ...current, api_base_url: 'http://replacement.invalid' }; release.resolve();
  assert.equal((await pending).status, 409);
});

test('parallel tests on two saved profiles never exchange identities, aliases or returned information', async t => {
  const { profileStore, profile } = fixture(t); const second = profileStore.save({ name: 'B', api_base_url: 'http://other.invalid/prefix' });
  const data = new TargetConfigData({ profileStore, localTransportFactory: p => ({ prepareSubmission() {}, async request(route) { const group = route.split('/').at(-1); return group === 'config' ? { ...INFO.config, deviceName: p.id } : clone(INFO[group]); } }) });
  const results = await Promise.all([profile, second].map(p => data.testProfile(p.id, { revision: p.revision })));
  for (let i = 0; i < results.length; i++) { assert.equal(results[i].profile_id, [profile, second][i].id); assert.equal(results[i].device.name, results[i].profile_id); }
});

test('default transport retains non-JSON upstream auth status inside HTTP200 test results, never as local session403', async t => {
  const { profileStore, profile } = fixture(t); const calls = [];
  const origin = await isolatedServer(t, (request, response) => { calls.push(request.url); response.writeHead(403, { 'Content-Type': 'text/html' }); response.end('<html>private authentication internals</html>'); });
  const saved = profileStore.save({ ...profile, api_base_url: origin });
  const data = new TargetConfigData({ profileStore });
  const result = await data.testProfile(saved.id, { revision: saved.revision });
  assert.equal(result.outcome, 'failed'); assert.equal(result.issues.length, 3);
  for (const issue of result.issues) { assert.equal(issue.http_status, 403); assert.match(issue.message, /拒绝访问/); }
  assert.doesNotMatch(JSON.stringify(result), /private authentication internals/); assert.equal(calls.length, 3);
});

test('provider timeouts are bounded and reported as network-or-timeout without invented offline state', async t => {
  const { profileStore, profile } = fixture(t); let calls = 0;
  const origin = await isolatedServer(t, (request) => { calls++; request.resume(); });
  const saved = profileStore.save({ ...profile, api_base_url: origin });
  const result = await new TargetConfigData({ profileStore, timeoutSeconds: 0.03 }).testProfile(saved.id, { revision: saved.revision });
  assert.equal(result.outcome, 'failed'); assert.equal(calls, 3);
  assert.ok(result.issues.every(issue => issue.code === 'local_request_failed' && /网络或超时/.test(issue.message))); assert.equal(result.device.status, null);
});

test('cloud catalogue uses fixed anonymous same-env paths, preserves null/empty data and creates one client per env', async t => {
  const { profileStore } = fixture(t); const factories = [], calls = [];
  const data = new TargetConfigData({ profileStore, now: () => CHECKED, catalogClientFactory(options, environment) {
    factories.push({ options, environment });
    return new CloudCatalogClient({ ...options, fetch: async (url, request) => { calls.push({ url, request }); return json(environment === 'sit' ? EMPTY : CATALOG); } });
  } });
  const prod = await data.cloudCatalog('prod'); const sit = await data.cloudCatalog('sit'); await data.cloudCatalog('prod');
  assert.deepEqual(prod, { environment: 'prod', checked_at: CHECKED, catalog: CATALOG }); assert.deepEqual(sit.catalog.computerTypes, []);
  assert.equal(factories.length, 2); assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.isingq.com/public/computer-types'); assert.equal(calls[1].url, 'https://api-sit.isingq.com/public/computer-types');
  for (const { request } of calls) { assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'no-store'); assert.equal(request.method, 'GET'); assert.equal(Object.keys(request.headers).some(key => /authorization|cookie|channel/i.test(key)), false); }
  assert.equal(Object.hasOwn(prod.catalog.computerTypes[0], 'connected'), false);
  for (const environment of [undefined, null, 'production', 'http://unapproved.invalid']) await assert.rejects(data.cloudCatalog(environment), error => error.status === 400);
  assert.equal(calls.length, 3);
});

test('429 backoff survives refresh on the same client and does not block SIT or local maintenance', async t => {
  const { profileStore, profile } = fixture(t); let calls = 0;
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory([]), catalogClientFactory(options, environment) {
    return new CloudCatalogClient({ ...options, fetch: async () => { calls++; return environment === 'prod' ? new Response('gateway body must not be parsed', { status: 429, headers: { 'Retry-After': '60' } }) : json(EMPTY); } });
  } });
  for (let i = 0; i < 2; i++) await assert.rejects(data.cloudCatalog('prod'), e => e.status === 429 && e.http_status === 429 && e.retry_after_seconds > 0 && e.code === 'CATALOGUE_RATE_LIMITED');
  assert.equal(calls, 1); assert.equal((await data.cloudCatalog('sit')).catalog.computerTypes.length, 0);
  assert.equal((await data.testProfile(profile.id, { revision: 1 })).outcome, 'success'); assert.equal(profileStore.list().length, 1);
});

test('cloud errors never become empty/stale catalogues, raw proxy leaks or local-session403', async t => {
  for (const fixtureResponse of [new Response('<html>secret proxy</html>', { status: 503 }), json({ schemaVersion: 77 }), json({ message: 'secret auth' }, 403), new Response('gateway', { status: 429 })]) {
    const { profileStore } = fixture(t); const responses = [json(CATALOG), fixtureResponse];
    const data = new TargetConfigData({ profileStore, catalogClientFactory: options => new CloudCatalogClient({ ...options, fetch: async () => responses.shift() }) });
    assert.equal((await data.cloudCatalog('prod')).catalog.computerTypes.length, 1);
    await assert.rejects(data.cloudCatalog('prod'), error => { assert.ok([429, 502].includes(error.status)); assert.doesNotMatch(error.message, /secret/); assert.equal(Object.hasOwn(error, 'catalog'), false); return true; });
  }
});

test('new APIs retain token/origin/content-type/host guards, strict request shape and read-only session scope', async t => {
  const calls = [];
  const p = await page(t, { localTransportFactory: localFactory(calls), catalogClientFactory: options => new CloudCatalogClient({ ...options, fetch: async () => json(EMPTY) }) });
  const route = `${p.origin}/api/profiles/${p.profile.id}/test`;
  assert.equal((await fetch(route, { method: 'POST', headers: { Origin: p.origin, 'Content-Type': 'application/json' }, body: '{"revision":1}' })).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { ...p.headers, Origin: 'https://foreign.invalid' }, body: '{"revision":1}' })).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { ...p.headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(route, { method: 'POST', headers: p.headers, body: JSON.stringify({ revision: 1, url: 'http://transient.invalid' }) })).status, 400);
  assert.equal((await fetch(`${p.origin}/api/cloud/catalog?environment=prod`)).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${p.origin}/api/cloud/catalog?environment=prod`, { headers: { ...p.headers, Host: 'foreign.invalid' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); request.once('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  for (const suffix of ['', '?environment=prod&environment=sit', '?environment=prod&baseUrl=https://unapproved.invalid', '?environment=other']) assert.equal((await fetch(`${p.origin}/api/cloud/catalog${suffix}`, { headers: p.headers })).status, 400);
  const savedOnly = await fetch(`${p.origin}/api/profiles`, { method: 'POST', headers: p.headers, body: JSON.stringify({ name: '仅保存不探测', api_base_url: 'http://saved-only.invalid' }) });
  assert.equal(savedOnly.status, 200); assert.equal((await savedOnly.json()).connection_checked, false);
  assert.equal((await fetch(`${p.origin}/api/profiles`, { headers: p.headers })).status, 200);
  assert.equal(calls.length, 0);
  const testResponse = await fetch(route, { method: 'POST', headers: p.headers, body: '{"revision":1}' });
  assert.equal(testResponse.status, 200); assert.equal((await testResponse.json()).outcome, 'success');
  const cloud = await fetch(`${p.origin}/api/cloud/catalog?environment=prod`, { headers: p.headers }); assert.equal(cloud.status, 200); assert.deepEqual((await cloud.json()).catalog.computerTypes, []);
  assert.equal(cloud.headers.get('cache-control'), 'no-store'); assert.match(cloud.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(p.profileStore.get(p.profile.id).revision, 1);
});

test('API carries local failed/partial outcomes at200 and cloud Retry-After as429 without mixing session authorization', async t => {
  let authOnly = false;
  const p = await page(t, { localTransportFactory: localFactory([], group => !authOnly && group === 'config' ? json({ code: 10000, data: INFO.config }) : json({ code: 10001 }, authOnly ? 403 : 401)), catalogClientFactory: options => new CloudCatalogClient({ ...options, fetch: async () => new Response('gateway', { status: 429, headers: { 'Retry-After': '60' } }) }) });
  const response = await fetch(`${p.origin}/api/profiles/${p.profile.id}/test`, { method: 'POST', headers: p.headers, body: '{"revision":1}' });
  assert.equal(response.status, 200); const local = await response.json(); assert.equal(local.outcome, 'partial'); assert.equal(local.device.name, INFO.config.deviceName); assert.ok(local.issues.some(issue => issue.http_status === 401));
  authOnly = true;
  const denied = await fetch(`${p.origin}/api/profiles/${p.profile.id}/test`, { method: 'POST', headers: p.headers, body: '{"revision":1}' });
  assert.equal(denied.status, 200); const failed = await denied.json(); assert.equal(failed.outcome, 'failed'); assert.ok(failed.issues.every(issue => issue.http_status === 403));
  const cloud = await fetch(`${p.origin}/api/cloud/catalog?environment=prod`, { headers: p.headers }); assert.equal(cloud.status, 429); assert.equal(cloud.headers.get('retry-after'), '60');
  const error = await cloud.json(); assert.equal(error.http_status, 429); assert.equal(error.retry_after_seconds, 60); assert.equal(error.code, 'CATALOGUE_RATE_LIMITED');
  const refresh = await fetch(`${p.origin}/api/cloud/catalog?environment=prod`, { headers: p.headers }); assert.equal(refresh.status, 429);
});

test('API late result after edit/deletion returns409/404 rather than old device fields', async t => {
  for (const change of ['edit', 'delete']) {
    const entered = gate(), release = gate();
    const p = await page(t, { localTransportFactory: localFactory([], async group => { entered.resolve(); await release.promise; return json({ code: 10000, data: INFO[group] }); }) });
    const responsePromise = fetch(`${p.origin}/api/profiles/${p.profile.id}/test`, { method: 'POST', headers: p.headers, body: '{"revision":1}' });
    await entered.promise;
    if (change === 'edit') p.profileStore.save({ ...p.profile, name: '编辑后' }); else p.profileStore.delete(p.profile.id);
    release.resolve(); const response = await responsePromise; assert.equal(response.status, change === 'edit' ? 409 : 404); const body = await response.json(); assert.ok(body.code); assert.equal(Object.hasOwn(body, 'device'), false);
  }
});

test('overlapping same-profile tests share one readonly flight after validating each caller and next refresh stays fresh', async t => {
  const { profileStore, profile } = fixture(t), calls = [], entered = gate(), release = gate();
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls, async group => { entered.resolve(); await release.promise; return json({ code: 10000, data: INFO[group] }); }) });
  const first = data.testProfile(profile.id, { revision: 1 }), second = data.testProfile(profile.id, { revision: 1 });
  await entered.promise;
  await assert.rejects(data.testProfile(profile.id, { revision: 1, url: 'http://unapproved.invalid' }), e => e.status === 400);
  await assert.rejects(data.testProfile(profile.id, { revision: 2 }), e => e.status === 409);
  const simultaneousCalls = calls.length; release.resolve(); const results = await Promise.all([first, second]);
  assert.equal(simultaneousCalls, 3, 'two overlapping valid callers must share exactly config/runtime/status');
  assert.deepEqual(results[0], results[1]); results[0].device.name = 'mutated caller copy'; assert.equal(results[1].device.name, INFO.config.deviceName);
  await data.testProfile(profile.id, { revision: 1 }); assert.equal(calls.length, 6, 'completed work is removed; manual/automatic later refresh reads again');
});

test('changed saved basis uses a different flight and old callers still fail CAS rather than sharing newer data', async t => {
  const { profileStore, profile } = fixture(t), calls = [], entered = gate(), release = gate();
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls, async group => { entered.resolve(); await release.promise; return json({ code: 10000, data: INFO[group] }); }) });
  const old = [data.testProfile(profile.id, { revision: 1 }), data.testProfile(profile.id, { revision: 1 })]; const oldSettled = Promise.allSettled(old);
  await entered.promise; const changed = profileStore.save({ ...profile, api_base_url: 'http://changed.invalid:8080/new' });
  await assert.rejects(data.testProfile(profile.id, { revision: 1 }), e => e.status === 409);
  const current = data.testProfile(changed.id, { revision: changed.revision }); await Promise.resolve(); await Promise.resolve();
  release.resolve(); const [previous, fresh] = await Promise.all([oldSettled, current]);
  assert.equal(calls.length, 6); assert.ok(previous.every(result => result.status === 'rejected' && result.reason.status === 409));
  assert.equal(fresh.profile_revision, changed.revision); assert.equal(data.inFlightTests.size, 0);
});

test('deleted saved profile rejects all merged callers and completed failures are not kept as a permanent cache', async t => {
  const { profileStore, profile } = fixture(t), calls = [], entered = gate(), release = gate();
  const data = new TargetConfigData({ profileStore, localTransportFactory: localFactory(calls, async group => { entered.resolve(); await release.promise; return json({ code: 10000, data: INFO[group] }); }) });
  const pending = Promise.allSettled([data.testProfile(profile.id, { revision: 1 }), data.testProfile(profile.id, { revision: 1 })]);
  await entered.promise; profileStore.delete(profile.id); release.resolve();
  assert.ok((await pending).every(result => result.status === 'rejected' && result.reason.status === 404)); assert.equal(calls.length, 3); assert.equal(data.inFlightTests.size, 0);
  const freshProfile = profileStore.save({ name: '新保存配置', api_base_url: profile.api_base_url });
  await data.testProfile(freshProfile.id, { revision: freshProfile.revision }); assert.equal(calls.length, 6);
});
