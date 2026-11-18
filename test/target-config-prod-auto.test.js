'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSync } = require('esbuild');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { openTargetConfig, launchTargetConfig, managerBuildIdentity, MANAGER_BUILD_ID } = require('../packages/core/src/target-config-page');
const { MARKER, DEFAULT_BOOTSTRAP, renderManagerClient, resolveManagerEnvironment } = require('../packages/core/src/target-config-bootstrap');
const { CloudCatalogClient } = require('../packages/core/src/cloud-target');
const lifecycle = require('../packages/core/src/target-config-lifecycle');
const EMPTY = { schemaVersion: 1, uploadLimits: { maxCsvBytes: 12345 }, computerTypes: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const observations = [];
async function until(predicate, max = 2000) { const deadline = Date.now() + max; while (Date.now() < deadline) { if (await predicate()) return; await pause(10); } assert.fail('bounded temporary manager cleanup did not finish'); }
const rebind = port => new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
async function close(session) { const u = new URL(session.url); try { await fetch(u.origin + '/api/close', { method: 'POST', headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) }, body: '{}', signal: AbortSignal.timeout(1000) }); } catch (_) {} }
function fixture(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-prod-auto-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return { directory, profileStore: new SolverProfileStore({ XDG_CONFIG_HOME: directory }) }; }
async function page(t, options = {}) { const h = fixture(t); const session = await openTargetConfig({ profileStore: h.profileStore, idleTimeoutMs: 10000, ...options }); t.after(session.close); const u = new URL(session.url); return { ...h, session, origin: u.origin, headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) } }; }
const bootstrap = (environment, internalPreview) => MARKER + JSON.stringify({ environment, internal_preview: internalPreview });

test('bootstrap factory accepts exactly one explicit default machine fragment and rejects missing/duplicate/unknown variants', () => {
  const source = 'void (' + MARKER + DEFAULT_BOOTSTRAP + ');';
  assert.equal(renderManagerClient({}, source), source);
  assert.equal(renderManagerClient({ environment: 'sit', internalPreview: true }, source), 'void (' + bootstrap('sit', true) + ');');
  for (const malformed of ['', source + source, source + MARKER, source.replace('"prod"', '"other"'), source.replace('false', 'true')]) assert.throws(() => renderManagerClient({}, malformed), e => e.code === 'manager_bootstrap_invalid');
  for (const options of [{ environment: 'unknown' }, { environment: 'sit' }, { environment: 'sit', internalPreview: 'true' }]) assert.throws(() => renderManagerClient(options, source));
  assert.deepEqual(resolveManagerEnvironment(), { environment: 'prod', internalPreview: false });
  assert.deepEqual(resolveManagerEnvironment('sit'), { environment: 'sit', internalPreview: true });
  for (const untrusted of ['prod', 'stage', true, {}]) assert.throws(() => resolveManagerEnvironment(untrusted));
});

test('default manager is fixedProd, has no environment selector and rejects a tamperedSIT query before any catalogue call', async t => {
  const calls = []; const h = await page(t, { dataService: { async cloudCatalog(env) { calls.push(env); return { environment: env, checked_at: 'fixture', catalog: EMPTY }; } } });
  const html = await (await fetch(h.origin)).text(); assert.doesNotMatch(html, /<select\b|id="cloud-environment"/);
  const script = await (await fetch(h.origin + '/app.js')).text(); assert.equal(script.split(bootstrap('prod', false)).length, 2);
  const session = await (await fetch(h.origin + '/api/session', { headers: h.headers })).json(); assert.equal(session.cloud_environment, 'prod'); assert.equal(session.internal_preview, false);
  for (const query of ['environment=sit', 'environment=sit&internal_preview=true']) {
    const response = await fetch(h.origin + '/api/cloud/catalog?' + query, { headers: h.headers }); assert.equal(response.status, 400);
  }
  assert.deepEqual(calls, []);
  const normal = await fetch(h.origin + '/api/cloud/catalog?environment=prod', { headers: h.headers }); assert.equal(normal.status, 200); assert.deepEqual(calls, ['prod']);
  assert.equal((await normal.json()).environment, 'prod');
});

test('trusted internalSIT preview is fixedSIT with explicit bootstrap and rejectsProd query', async t => {
  const calls = []; const h = await page(t, { internalPreviewEnvironment: 'sit', dataService: { async cloudCatalog(env) { calls.push(env); return { environment: env, catalog: EMPTY }; } } });
  const html = await (await fetch(h.origin)).text(); assert.doesNotMatch(html, /<select\b|id="cloud-environment"/);
  const script = await (await fetch(h.origin + '/app.js')).text(); assert.equal(script.split(bootstrap('sit', true)).length, 2);
  const session = await (await fetch(h.origin + '/api/session', { headers: h.headers })).json(); assert.equal(session.cloud_environment, 'sit'); assert.equal(session.internal_preview, true);
  assert.equal((await fetch(h.origin + '/api/cloud/catalog?environment=prod', { headers: h.headers })).status, 400); assert.deepEqual(calls, []);
  const response = await fetch(h.origin + '/api/cloud/catalog?environment=sit', { headers: h.headers }); assert.equal(response.status, 200); assert.deepEqual(calls, ['sit']);
});

test('Prod404 remains a502 upstream failure and cannot be replaced bySIT, empty or fixed models', async t => {
  const urls = []; const h = await page(t, { catalogClientFactory: options => new CloudCatalogClient({ ...options, fetch: async (url, request) => { urls.push(url); assert.equal(Object.keys(request.headers).some(key => /authorization|cookie|channel/i.test(key)), false); return new Response('isolated upstream404', { status: 404 }); } }) });
  const response = await fetch(h.origin + '/api/cloud/catalog?environment=prod', { headers: h.headers }); assert.equal(response.status, 502);
  const body = await response.json(); assert.equal(body.http_status, 404); assert.equal(Object.hasOwn(body, 'catalog'), false);
  assert.deepEqual(urls, ['https://api.isingq.com/public/computer-types']);
  assert.equal((await fetch(h.origin + '/api/cloud/catalog?environment=sit', { headers: h.headers })).status, 400); assert.equal(urls.length, 1);
});

test('Prod and internalSIT have different actual builds and managed sidecars, while each mode reuses its own session', { timeout: 6000 }, async t => {
  const h = fixture(t), children = [], sessions = [];
  const spawnSidecar = s => { const child = fork(s.modulePath, ['--config-sidecar', ...s.args], { ...s.options, execPath: s.executablePath, execArgv: [] }); children.push(child); return child; };
  t.after(async () => { for (const session of sessions) await close(session); for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill(); });
  assert.equal(managerBuildIdentity(), MANAGER_BUILD_ID); assert.notEqual(managerBuildIdentity(resolveManagerEnvironment('sit')), MANAGER_BUILD_ID);
  for (const preview of [undefined, 'sit']) {
    const args = { profileStore: h.profileStore, idleTimeoutMs: 10000, internalPreviewEnvironment: preview, lifecycleOptions: { spawnSidecar } };
    const first = await launchTargetConfig(args); sessions.push(first); const again = await launchTargetConfig(args);
    assert.equal(again.pid, first.pid); assert.ok(again.url === first.url); assert.equal(first.cloud_environment, preview || 'prod'); assert.equal(first.internal_preview, preview === 'sit');
    const u = new URL(first.url), identity = await (await fetch(u.origin + '/api/session', { headers: { 'X-Config-Token': u.hash.slice(1) } })).json();
    assert.equal(identity.cloud_environment, first.cloud_environment); assert.equal(identity.build_id, managerBuildIdentity(resolveManagerEnvironment(preview)));
    const loc = lifecycle.location(lifecycle.canonicalConfigFile(h.profileStore.file), identity.build_id, undefined, identity.cloud_environment); const record = lifecycle.readPrivate(loc.file);
    assert.equal(record.cloud_environment, first.cloud_environment); assert.equal(record.internal_preview, first.internal_preview);
    observations.push({ environment: first.cloud_environment, internal_preview: first.internal_preview, pid: first.pid, port: Number(u.port), build_id: identity.build_id, same_mode_reused: true });
  }
  assert.equal(children.length, 2); assert.notEqual(sessions[0].pid, sessions[1].pid); assert.notEqual(new URL(sessions[0].url).port, new URL(sessions[1].url).port);
  for (const session of sessions) { await close(session); const u = new URL(session.url); await until(() => rebind(Number(u.port))); }
  await until(() => children.every(child => child.exitCode !== null || Boolean(child.signalCode)));
  assert.ok(children.every(child => child.exitCode === 0));
});

test('esbuild preserves literal bootstrap contract and supports fixedSIT source-independent entry and reuse', { timeout: 8000 }, async t => {
  const h = fixture(t), sessions = [];
  const pagePath = require.resolve('../packages/core/src/target-config-page'), storePath = require.resolve('../packages/core/src/solver-profiles');
  const bundle = path.join(h.directory, 'manager-sit.bundle.cjs');
  const entry = `const{launchTargetConfig,serveTargetConfigSidecar}=require(${JSON.stringify(pagePath)});const{SolverProfileStore}=require(${JSON.stringify(storePath)});if(['--config-sidecar','__target-config-serve'].includes(process.argv[2]))serveTargetConfigSidecar(process.argv.slice(3));else launchTargetConfig({profileStore:new SolverProfileStore({XDG_CONFIG_HOME:${JSON.stringify(h.directory)}}),idleTimeoutMs:10000,internalPreviewEnvironment:'sit'}).then(s=>process.stdout.write(JSON.stringify(s))).catch(e=>{console.error(e.code);process.exitCode=1});`;
  buildSync({ stdin: { contents: entry, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', target: 'node18', outfile: bundle, logLevel: 'silent', minify: true });
  t.after(async () => { for (const s of sessions) await close(s); });
  for (let i = 0; i < 2; i++) { const output = await promisify(execFile)(process.execPath, [bundle], { timeout: 6500 }); assert.equal(output.stderr, ''); sessions.push(JSON.parse(output.stdout)); }
  assert.equal(sessions[0].pid, sessions[1].pid); assert.ok(sessions[0].url === sessions[1].url); assert.equal(sessions[0].cloud_environment, 'sit');
  const u = new URL(sessions[0].url); const script = await (await fetch(u.origin + '/app.js')).text(); assert.equal(script.split(bootstrap('sit', true)).length, 2);
  const identity = await (await fetch(u.origin + '/api/session', { headers: { 'X-Config-Token': u.hash.slice(1) } })).json(); assert.equal(identity.cloud_environment, 'sit'); assert.equal(identity.internal_preview, true);
  await close(sessions[0]); await until(() => rebind(Number(u.port))); await until(() => !lifecycle.alive(sessions[0].pid));
});

test.after(() => { if (process.env.MANAGER_PROD_AUTO_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.MANAGER_PROD_AUTO_EVIDENCE_DIR, 'mode-resource-observations.json'), JSON.stringify({ scope: 'isolated loopback source and bundle; no device/cloud network', observations }, null, 2) + '\n'); });
