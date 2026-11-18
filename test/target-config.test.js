'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { execFile } = require('node:child_process'); const { promisify } = require('node:util');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles'); const { openTargetConfig, launchTargetConfig } = require('../packages/core/src/target-config-page');
async function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-page-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const profileStore = new SolverProfileStore({ XDG_CONFIG_HOME: dir }); const s = await openTargetConfig({ profileStore, lifetimeMs: 10000 }); t.after(s.close); const url = new URL(s.url); const headers = { 'X-Config-Token': url.hash.slice(1), Origin: url.origin, 'Content-Type': 'application/json' }; return { s, profileStore, origin: url.origin, headers }; }
const { DEVICE_ART, STATIC_SVG_ASSETS } = require('../packages/core/src/target-config/device-art');
const profile = { name: '设备A', api_base_url: 'http://fixture.test:8080/proxy', web_base_url: '' };
test('manager cannot replace a newer connection with an omitted, null or stale revision', async t => {
  const { profileStore, origin, headers } = await fixture(t);
  const original = profileStore.save(profile);
  const latest = profileStore.save({ ...original, name: '另一客户端已更新' });
  for (const [revision, status, code] of [[undefined, 400, 'profile_revision_invalid'], [null, 400, 'profile_revision_invalid'], [original.revision, 409, 'profile_revision_conflict']]) {
    const response = await fetch(`${origin}/api/profiles`, { method: 'POST', headers, body: JSON.stringify({ ...original, revision }) });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  assert.deepEqual(profileStore.list(), [latest]);
});
test('loopback page returns promptly, uses Chinese labels, external assets, token hash and private caching', async t => { const { s, origin } = await fixture(t); assert.equal(new URL(s.url).hostname, '127.0.0.1'); assert.equal(new URL(s.url).hash.length, 65); const response = await fetch(origin); const html = await response.text(); assert.match(html, /求解器管理/); assert.match(html, /本地设备/); assert.match(html, /云端机型/); assert.match(html, /保存不自动测试/); assert.match(html, /label for="name"/); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(response.headers.get('access-control-allow-origin'), null); const script = await (await fetch(`${origin}/app.js`)).text(); assert.match(script, /textContent/); assert.doesNotMatch(script, /innerHTML/); assert.match(script, /replaceState/); });
test('configuration CRUD persists and deletes; cancel/no write requests save nothing and never submit', async t => { const { profileStore, origin, headers } = await fixture(t); assert.equal(fs.existsSync(profileStore.file), false); const before = await (await fetch(`${origin}/api/profiles`, { headers })).json(); assert.deepEqual(before.profiles, []); assert.equal(fs.existsSync(profileStore.file), false); const response = await fetch(`${origin}/api/profiles`, { method: 'POST', headers, body: JSON.stringify(profile) }); assert.equal(response.status, 200); const saved = await response.json(); assert.equal(saved.submitted, false); assert.equal(saved.connection_checked, false); assert.equal(profileStore.list().length, 1); const edited = await fetch(`${origin}/api/profiles`, { method: 'POST', headers, body: JSON.stringify({ ...saved.profile, name: '设备B' }) }); assert.equal((await edited.json()).profile.revision, 2); assert.equal((await fetch(`${origin}/api/profiles`, { method: 'POST', headers, body: JSON.stringify(saved.profile) })).status, 409); assert.equal((await fetch(`${origin}/api/profiles/${saved.profile.id}`, { method: 'DELETE', headers, body: '{}' })).status, 200); assert.deepEqual(profileStore.list(), []); });
test('API rejects missing token, cross-site origins, missing origin, wrong content type and oversized bodies', async t => { const { profileStore, origin, headers } = await fixture(t); const cases = [{ ...headers, 'X-Config-Token': 'wrong' }, { ...headers, Origin: 'https://external.test' }, { 'X-Config-Token': headers['X-Config-Token'], 'Content-Type': 'application/json' }]; for (const h of cases) assert.equal((await fetch(`${origin}/api/profiles`, { method: 'POST', headers: h, body: JSON.stringify(profile) })).status, 403); assert.equal((await fetch(`${origin}/api/profiles`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415); assert.equal((await fetch(`${origin}/api/profiles`, { method: 'POST', headers, body: JSON.stringify({ name: 'x'.repeat(65536) }) })).status, 413); assert.equal((await fetch(`${origin}/api/profiles`)).status, 403); assert.deepEqual(profileStore.list(), []); });
test('closing configuration explicitly leaves remote tasks unaffected', async t => { const { origin, headers } = await fixture(t); const response = await fetch(`${origin}/api/close`, { method: 'POST', headers, body: '{}' }); assert.deepEqual(await response.json(), { closed: true, remote_tasks_cancelled: false }); });
test('detached sidecar remains usable after launch parent exits, expires/close independently and emits only JSON parent output', async t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-sidecar-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const modulePath = require.resolve('../packages/core/src/target-config-page'); const storePath = require.resolve('../packages/core/src/solver-profiles'); const program = `const {launchTargetConfig}=require(${JSON.stringify(modulePath)});const {SolverProfileStore}=require(${JSON.stringify(storePath)});launchTargetConfig({profileStore:new SolverProfileStore({XDG_CONFIG_HOME:${JSON.stringify(dir)}}),lifetimeMs:10000}).then(v=>process.stdout.write(JSON.stringify(v)));`; const output = await promisify(execFile)(process.execPath, ['-e', program], { timeout: 5000 }); assert.equal(output.stderr, ''); const session = JSON.parse(output.stdout); t.after(async () => { const u = new URL(session.url); try { await fetch(`${u.origin}/api/close`, { method: 'POST', headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) }, body: '{}', signal: AbortSignal.timeout(1000) }); } catch (_) {} }); const url = new URL(session.url); const headers = { Origin: url.origin, 'Content-Type': 'application/json', 'X-Config-Token': url.hash.slice(1) }; assert.equal((await fetch(url.origin)).status, 200); const illustration = await fetch(url.origin + DEVICE_ART.neutral.path); assert.equal(illustration.status, 200); assert.equal(await illustration.text(), STATIC_SVG_ASSETS[DEVICE_ART.neutral.path]); assert.equal((await fetch(`${url.origin}/api/profiles`, { method: 'POST', headers, body: JSON.stringify(profile) })).status, 200); const store = new SolverProfileStore({ XDG_CONFIG_HOME: dir }); assert.equal(store.list()[0].name, '设备A'); assert.equal((await fetch(`${url.origin}/api/cloud/catalog?environment=invalid`, { headers })).status, 400); assert.equal((await fetch(`${url.origin}/api/profiles/${store.list()[0].id}/test`, { method: 'POST', headers, body: '{"revision":999}' })).status, 409); await fetch(`${url.origin}/api/close`, { method: 'POST', headers, body: '{}' }); });
test('packaged runtime detection covers pkg variants and SEA while unavailable node:sea remains safe on Node18', () => {
  const { isPackagedRuntime } = require('../packages/core/src/target-config-page');
  assert.equal(isPackagedRuntime({ pkg: {}, versions: {} }, () => false), true);
  assert.equal(isPackagedRuntime({ versions: { pkg: '6.22.0' } }, () => false), true);
  assert.equal(isPackagedRuntime({ versions: {} }, () => true), true);
  assert.equal(isPackagedRuntime({ versions: {} }, () => false), false);
  assert.equal(isPackagedRuntime({ versions: {} }, () => { const error = new Error('No such built-in module: node:sea'); error.code = 'ERR_UNKNOWN_BUILTIN_MODULE'; throw error; }), false);
});
test('esbuild Node bundle sidecar survives parent exit and serves configuration through the bundle private hook', async t => {
  const { buildSync } = require('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modulePath = require.resolve('../packages/core/src/target-config-page');
  const storePath = require.resolve('../packages/core/src/solver-profiles');
  const bundle = path.join(dir, 'toolkit-fixture.bundle.cjs');
  const entry = `const {launchTargetConfig,serveTargetConfigSidecar}=require(${JSON.stringify(modulePath)});\nconst {SolverProfileStore}=require(${JSON.stringify(storePath)});\nif(['__target-config-serve','--config-sidecar'].includes(process.argv[2])){serveTargetConfigSidecar(process.argv.slice(3));}else{launchTargetConfig({profileStore:new SolverProfileStore({XDG_CONFIG_HOME:${JSON.stringify(dir)}}),lifetimeMs:10000}).then(v=>process.stdout.write(JSON.stringify(v)));}`;
  buildSync({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'target-config-bundle-fixture.js' }, bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: bundle, logLevel: 'silent' });
  const output = await promisify(execFile)(process.execPath, [bundle], { timeout: 5000 });
  assert.equal(output.stderr, '');
  const session = JSON.parse(output.stdout);
  t.after(async () => { const u = new URL(session.url); try { await fetch(`${u.origin}/api/close`, { method: 'POST', headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) }, body: '{}', signal: AbortSignal.timeout(1000) }); } catch (_) {} });
  const url = new URL(session.url);
  assert.equal((await fetch(url.origin)).status, 200); const illustration = await fetch(url.origin + DEVICE_ART.neutral.path); assert.equal(illustration.status, 200); assert.equal(await illustration.text(), STATIC_SVG_ASSETS[DEVICE_ART.neutral.path]);
  const headers = { Origin: url.origin, 'Content-Type': 'application/json', 'X-Config-Token': url.hash.slice(1) };
  const saved = await fetch(`${url.origin}/api/profiles`, { method: 'POST', headers, body: JSON.stringify(profile) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).submitted, false);
  const store = new SolverProfileStore({ XDG_CONFIG_HOME: dir });
  assert.equal(store.list()[0].name, profile.name);
  assert.equal((await fetch(`${url.origin}/api/cloud/catalog?environment=invalid`, { headers })).status, 400);
  assert.equal((await fetch(`${url.origin}/api/profiles/${store.list()[0].id}/test`, { method: 'POST', headers, body: '{"revision":999}' })).status, 409);
  await fetch(`${url.origin}/api/close`, { method: 'POST', headers, body: '{}' });
});
test('configuration copy presents standard binary defaults and optional deployment overrides without claiming connectivity', () => {
  const view = require('../packages/core/src/target-config/view');
  const client = require('../packages/core/src/target-config/client');
  assert.match(view, /部署规则覆盖/);
  assert.match(view, /默认使用标准 binary 协议/);
  assert.match(view, /无头上三角 CSV/);
  assert.match(client, /已保存，求解前检查连接与设备状态/);
  assert.doesNotMatch(view + client, /提交前需核实编码合同|首次录入可留空。提交矩阵前，需由设备方确认/);
  assert.match(client, /尚未检查设备可用性，也未创建任务/);
});

test('anonymous favicon request returns empty204 while API token protection remains required', async t => {
  const { origin } = await fixture(t);
  const response = await fetch(`${origin}/favicon.ico`);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${origin}/api/profiles`)).status, 403);
});


test('device SVG resources use a strict hash whitelist after Host checks without opening arbitrary static paths', async t => {
  const { origin, headers } = await fixture(t);
  for (const art of Object.values(DEVICE_ART)) {
    const response = await fetch(origin + art.path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(await response.text(), STATIC_SVG_ASSETS[art.path]);
    for (const face of [art.frontPath, art.sidePath]) { const texture = await fetch(origin + face); assert.equal(texture.status, 200); assert.equal(await texture.text(), STATIC_SVG_ASSETS[face]); }
  }
  const wrongHostStatus = await new Promise((resolve, reject) => {
    require('node:http').get(origin + DEVICE_ART.neutral.path, { headers: { Host: 'outside.invalid' }, agent: false }, response => { response.resume(); resolve(response.statusCode); }).once('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  for (const route of ['/assets/device.svg', DEVICE_ART.neutral.path + '?file=solver-profiles.json', '/assets/%2e%2e/solver-profiles.json']) {
    assert.equal((await fetch(origin + route, { headers })).status, 404);
  }
  assert.equal((await fetch(origin + DEVICE_ART.neutral.path, { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(origin + '/api/profiles')).status, 403);
});
