'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createBackgroundUpdates, runUpdateWorker } = require('../packages/core/src/background-updates');
const { createUpdateChecker } = require('../packages/core/src/update-check');
const CURRENT = require('../packages/core/package.json').version;
const MODULE = path.resolve(__dirname, '../packages/core/src/background-updates.js');
const WORKER = path.resolve(__dirname, '../packages/core/src/update-worker.js');
const UNDICI = require.resolve('undici');
const DAY = 86400000;
const FAILURE = 300000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = (latest = '0.9.0', status = 'update_available') => ({ current_version: CURRENT, latest_version: latest, status });

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-background-updates-'));
  const environment = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') };
  const directory = path.join(environment.XDG_CACHE_HOME, 'isingq-mcp/updates');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, environment, directory };
}
function write(directory, name, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}
function read(directory, name = 'cache.json') { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
async function until(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await delay(20); }
  assert.fail('background state did not settle before timeout');
}
function cache(at, latest = '0.9.0', status = 'update_available') {
  return { schema: 'isingq-background-updates-v1', current_version: CURRENT, latest_version: latest, status, checked_at: at };
}
function child(program, options = {}) {
  const process = spawn(global.process.execPath, ['-e', program], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', bytes => { stdout += bytes; });
  process.stderr.on('data', bytes => { stderr += bytes; });
  return new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('cold start and notice reads never wait for a two-second HTTP timeout', async t => {
  const f = fixture(t);
  let completed = false, calls = 0;
  const checker = createUpdateChecker({ timeoutMs: 2000, fetch: (_url, { signal }) => new Promise((_, reject) => {
    calls += 1;
    signal.addEventListener('abort', () => reject(Error('fixture timeout')), { once: true });
  }) });
  const manager = createBackgroundUpdates({ environment: f.environment, check: async args => {
    const value = await checker(args); completed = true; return value;
  } });
  const before = performance.now();
  assert.equal(manager.start(), undefined);
  assert.equal(manager.takeNotice(), null);
  assert.equal(require('../packages/core/src/qubo').validateQubo({ num_bits: 2 }).summary.num_bits, 2);
  assert.ok(performance.now() - before < 150, 'normal work must finish before the network timeout');
  assert.equal(completed, false);
  await manager.waitForIdle();
  assert.equal(calls, 1);
  assert.equal(completed, true);
  assert.equal(manager.takeNotice(), null);
  assert.equal(read(f.directory).status, 'unavailable');
});

test('completed cache yields a canonical notice only once per current/latest pair in 24 hours', async t => {
  const f = fixture(t);
  let now = 1700000000000, calls = 0;
  const make = () => createBackgroundUpdates({ environment: f.environment, now: () => now, check: async () => {
    calls += 1; return { ...result(), notice: 'REMOTE_ARBITRARY_SECRET', diagnostic_message: 'PRIVATE_MODEL', payload: { api_key: 'PRIVATE_KEY' } };
  } });
  const manager = make();
  manager.start(); await manager.waitForIdle();
  const notice = manager.takeNotice();
  assert.equal(notice.current_version, CURRENT);
  assert.equal(notice.latest_version, '0.9.0');
  assert.match(notice.text, /0\.9\.0.*手动升级/);
  assert.equal(notice.requires_response, false);
  assert.equal(notice.automatic_install, false);
  assert.equal(notice.announce_check, false);
  assert.equal(manager.takeNotice(), null);
  const restarted = make(); restarted.start(); await restarted.waitForIdle();
  assert.equal(restarted.takeNotice(), null);
  assert.equal(calls, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(f.directory, 'cache.json'), 'utf8'), /REMOTE_|PRIVATE_|payload|notice|diagnostic/);
  now += DAY;
  manager.start(); await manager.waitForIdle();
  assert.ok(manager.takeNotice());
  assert.equal(calls, 2);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
    for (const file of ['cache.json', 'notice.json']) assert.equal(fs.statSync(path.join(f.directory, file)).mode & 0o777, 0o600);
  }
});

test('a version cannot be announced twice within 24 hours even after another latest version', t => {
  const f = fixture(t); const now = Date.now();
  const manager = createBackgroundUpdates({ environment: f.environment, now: () => now });
  write(f.directory, 'cache.json', cache(now, '0.9.0'));
  assert.equal(manager.takeNotice().latest_version, '0.9.0');
  write(f.directory, 'cache.json', cache(now, '0.10.0'));
  assert.equal(manager.takeNotice().latest_version, '0.10.0');
  write(f.directory, 'cache.json', cache(now, '0.9.0'));
  assert.equal(manager.takeNotice(), null);
});

test('up-to-date, ahead, failures and malformed checker results remain silent; failure TTL is five minutes', async t => {
  for (const value of [result(CURRENT, 'up_to_date'), result('0.7.0', 'current_ahead'), result(null, 'unavailable'),
    { ...result(), current_version: '0.1.0' }, result('0.09.0'), result('0.9.0-beta.1'), result('0.7.0'), null]) {
    const f = fixture(t);
    let now = 1700000000000, calls = 0;
    const manager = createBackgroundUpdates({ environment: f.environment, now: () => now, check: async () => { calls++; return value; } });
    manager.start(); await manager.waitForIdle();
    assert.equal(manager.takeNotice(), null);
    manager.start(); await manager.waitForIdle(); assert.equal(calls, 1);
    if (read(f.directory).status === 'unavailable') {
      now += FAILURE - 1; manager.start(); await manager.waitForIdle(); assert.equal(calls, 1);
      now += 1; manager.start(); await manager.waitForIdle(); assert.equal(calls, 2);
    }
  }
  const f = fixture(t);
  const manager = createBackgroundUpdates({ environment: f.environment, check: () => { throw Error('SECRET_STACK'); } });
  manager.start(); await manager.waitForIdle();
  assert.equal(manager.takeNotice(), null);
  assert.doesNotMatch(fs.readFileSync(path.join(f.directory, 'cache.json'), 'utf8'), /SECRET_STACK/);
});

test('stale, corrupt, extra-field, future and different-current caches are ignored', async t => {
  const now = 1700000000000;
  for (const value of ['not json', cache(now - DAY), { ...cache(now), current_version: '0.1.0' },
    { ...cache(now), arbitrary: 'REMOTE' }, cache(now + 1), cache(now, 'not-semver'), cache(now, CURRENT)]) {
    const f = fixture(t); write(f.directory, 'cache.json', value);
    let calls = 0;
    const manager = createBackgroundUpdates({ environment: f.environment, now: () => now, check: async () => { calls++; return result(); } });
    assert.equal(manager.takeNotice(), null);
    manager.start(); await manager.waitForIdle();
    assert.equal(calls, 1);
    assert.ok(manager.takeNotice());
  }
});

test('independent instances share an exclusive check lock; late workers cannot write or release another owner', async t => {
  const f = fixture(t); let release, calls = 0;
  const check = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const a = createBackgroundUpdates({ environment: f.environment, check });
  const b = createBackgroundUpdates({ environment: f.environment, check });
  a.start(); b.start(); await Promise.resolve();
  assert.equal(calls, 1);
  const replacement = { token: 'b'.repeat(64), created_at: Date.now() };
  write(f.directory, 'check.lock', replacement);
  release(result()); await a.waitForIdle(); await b.waitForIdle();
  assert.equal(fs.existsSync(path.join(f.directory, 'cache.json')), false);
  assert.deepEqual(read(f.directory, 'check.lock'), replacement);
  await runUpdateWorker('c'.repeat(64), { environment: f.environment, check: async () => { throw Error('wrong owner must not run'); } });
  assert.deepEqual(read(f.directory, 'check.lock'), replacement);
});

test('a cache completed between the initial read and lock acquisition prevents another query', async t => {
  const f = fixture(t); let injected = false, calls = 0;
  const original = fs.openSync;
  fs.openSync = function(filename, ...args) {
    if (path.basename(String(filename)) === 'check.lock' && !injected) {
      injected = true; write(f.directory, 'cache.json', cache(Date.now()));
    }
    return original.call(this, filename, ...args);
  };
  const manager = createBackgroundUpdates({ environment: f.environment, check: async () => { calls++; return result(); } });
  try { manager.start(); } finally { fs.openSync = original; }
  await manager.waitForIdle(); assert.equal(calls, 0); assert.ok(manager.takeNotice());
});

test('expired and damaged abandoned locks recover, fresh locks suppress duplicate checks', async t => {
  const now = Date.now();
  for (const lock of [{ token: 'a'.repeat(64), created_at: now - 16000 }, { token: 'a'.repeat(64), created_at: now + DAY }, 'damaged']) {
    const f = fixture(t); write(f.directory, 'check.lock', lock);
    fs.utimesSync(path.join(f.directory, 'check.lock'), new Date(now - 16000), new Date(now - 16000));
    let calls = 0;
    const manager = createBackgroundUpdates({ environment: f.environment, now: () => now, check: async () => { calls++; return result(); } });
    manager.start(); await manager.waitForIdle();
    assert.equal(calls, 1); assert.ok(manager.takeNotice());
  }
  const f = fixture(t); write(f.directory, 'check.lock', { token: 'a'.repeat(64), created_at: now });
  const manager = createBackgroundUpdates({ environment: f.environment, now: () => now, check: async () => { assert.fail('fresh lock must prevent a request'); } });
  manager.start(); await manager.waitForIdle(); assert.equal(manager.takeNotice(), null);
});

test('symbolic links, unsafe cache paths, read/write and spawn failures remain silent', async t => {
  for (const name of ['cache.json', 'check.lock', 'notice.json']) {
    const f = fixture(t); const outside = path.join(f.home, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify(cache(Date.now())), { mode: 0o600 });
    fs.mkdirSync(f.directory, { recursive: true, mode: 0o700 });
    if (name === 'notice.json') write(f.directory, 'cache.json', cache(Date.now()));
    fs.symlinkSync(outside, path.join(f.directory, name));
    const before = fs.readFileSync(outside, 'utf8');
    const manager = createBackgroundUpdates({ environment: f.environment, check: async () => result() });
    manager.start(); await manager.waitForIdle(); assert.equal(manager.takeNotice(), null);
    assert.equal(fs.readFileSync(outside, 'utf8'), before);
  }
  const f = fixture(t); fs.mkdirSync(f.environment.XDG_CACHE_HOME);
  const outside = path.join(f.home, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.environment.XDG_CACHE_HOME, 'isingq-mcp'));
  const manager = createBackgroundUpdates({ environment: f.environment, check: () => assert.fail('unsafe directory must not request') });
  manager.start(); assert.equal(manager.takeNotice(), null); assert.deepEqual(fs.readdirSync(outside), []);
  const file = path.join(f.home, 'file'); fs.writeFileSync(file, 'untouched');
  const denied = createBackgroundUpdates({ environment: { XDG_CACHE_HOME: file }, check: () => assert.fail('invalid path') });
  denied.start(); assert.equal(denied.takeNotice(), null); assert.equal(fs.readFileSync(file, 'utf8'), 'untouched');
  const broken = fixture(t);
  const spawnFailure = createBackgroundUpdates({ mode: 'detached', environment: broken.environment, spawn() { throw Error('SECRET'); } });
  spawnFailure.start(); assert.equal(spawnFailure.takeNotice(), null);
  assert.equal(fs.existsSync(path.join(broken.directory, 'check.lock')), false);
});

test('detached environment is a strict allowlist, no business secrets or runtime injection', t => {
  const f = fixture(t); let invocation;
  const environment = { ...f.environment, USERPROFILE: f.home, LOCALAPPDATA: f.home, SystemRoot: 'C:\\Windows',
    ISINGQ_API_KEY: 'SECRET', NODE_OPTIONS: '--require untrusted', NPM_TOKEN: 'SECRET', npm_config_registry: 'https://private.invalid',
    PATH: '/private/bin', AWS_SECRET_ACCESS_KEY: 'SECRET', HTTPS_PROXY: 'http://private.invalid' };
  const manager = createBackgroundUpdates({ mode: 'detached', environment, spawn(...args) { invocation = args; return { unref() {}, once() {} }; } });
  manager.start();
  assert.equal(invocation[0], process.execPath);
  assert.equal(invocation[1][0], WORKER);
  assert.match(invocation[1][1], /^[a-f0-9]{64}$/);
  assert.equal(invocation[2].detached, true);
  assert.equal(invocation[2].stdio, 'ignore');
  assert.deepEqual(invocation[2].env, { HOME: f.home, USERPROFILE: f.home, XDG_CACHE_HOME: f.environment.XDG_CACHE_HOME, LOCALAPPDATA: f.home, SystemRoot: 'C:\\Windows' });
});

test('optout never starts work or reads notices, including previously completed cache', async t => {
  const f = fixture(t); write(f.directory, 'cache.json', cache(Date.now()));
  const manager = createBackgroundUpdates({ mode: 'detached', environment: { ...f.environment, ISINGQ_UPDATE_CHECK: 'off' },
    check() { assert.fail('optout check'); }, spawn() { assert.fail('optout spawn'); } });
  manager.start(); await manager.waitForIdle(); assert.equal(manager.takeNotice(), null);
  assert.equal(fs.existsSync(path.join(f.directory, 'notice.json')), false);
});

test('real detached parent exits promptly; worker writes later and subsequent processes notice only once', async t => {
  const f = fixture(t);
  const preload = path.join(f.home, 'mock-fetch.cjs');
  fs.writeFileSync(preload, `
    require('node:net').Socket.prototype.connect=()=>{throw Error('REAL_NETWORK_FORBIDDEN')};
    for(const name of ['ISINGQ_API_KEY','NODE_OPTIONS','NPM_TOKEN','AWS_SECRET_ACCESS_KEY']) if(process.env[name]) throw Error('SECRET_ENV_INHERITED');
    const http=require(${JSON.stringify(UNDICI)});
    http.fetch=async()=>{await new Promise(r=>setTimeout(r,1500));return new http.Response(JSON.stringify({name:'@ising-tech/isingq-mcp',version:'0.9.0'}));};
  `);
  const program = `
    const {createBackgroundUpdates}=require(${JSON.stringify(MODULE)});
    const spawn=require('node:child_process').spawn;
    const manager=createBackgroundUpdates({mode:'detached',environment:${JSON.stringify({ ...f.environment, ISINGQ_API_KEY: 'SYNTHETIC_PRIVATE', NPM_TOKEN: 'SYNTHETIC_PRIVATE' })},
      spawn(executable,args,options){return spawn(executable,['--require',${JSON.stringify(preload)},...args],options)}});
    manager.start();process.stdout.write('BUSINESS_COMPLETED');
  `;
  const before = performance.now();
  const parent = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 4000 });
  assert.equal(parent.status, 0, parent.stderr);
  assert.equal(parent.stdout, 'BUSINESS_COMPLETED');
  assert.ok(performance.now() - before < 1200, 'parent must exit before delayed worker response');
  assert.equal(fs.existsSync(path.join(f.directory, 'cache.json')), false);
  await until(() => fs.existsSync(path.join(f.directory, 'cache.json')));
  const noticeProgram = `const m=require(${JSON.stringify(MODULE)}).createBackgroundUpdates({environment:${JSON.stringify(f.environment)}});process.stdout.write(JSON.stringify(m.takeNotice()));`;
  const notices = await Promise.all([child(noticeProgram), child(noticeProgram)]);
  for (const value of notices) { assert.equal(value.code, 0, value.stderr); assert.equal(value.stderr, ''); }
  assert.equal(notices.filter(value => JSON.parse(value.stdout)?.latest_version === '0.9.0').length, 1);
  assert.equal(createBackgroundUpdates({ environment: f.environment }).takeNotice(), null);
});

test('actual processes deduplicate cold checks with the same atomic lock', async t => {
  const f = fixture(t); const marker = path.join(f.home, 'checks');
  const program = `
    const fs=require('node:fs');const m=require(${JSON.stringify(MODULE)}).createBackgroundUpdates({environment:${JSON.stringify(f.environment)},check:async()=>{
      fs.appendFileSync(${JSON.stringify(marker)},'check\\n');await new Promise(r=>setTimeout(r,250));return ${JSON.stringify(result())};
    }});m.start();m.waitForIdle().then(()=>process.stdout.write('DONE'));
  `;
  const children = await Promise.all([child(program), child(program), child(program)]);
  for (const value of children) assert.equal(value.code, 0, value.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'check\n');
  assert.ok(createBackgroundUpdates({ environment: f.environment }).takeNotice());
});

test('worker has a hard lifetime even if an injected network implementation never settles', async t => {
  const f = fixture(t);
  const preload = path.join(f.home, 'hung-fetch.cjs');
  fs.writeFileSync(preload, `require('node:net').Socket.prototype.connect=()=>{throw Error('REAL_NETWORK_FORBIDDEN')};require(${JSON.stringify(UNDICI)}).fetch=()=>new Promise(()=>{});`);
  const token = 'a'.repeat(64); write(f.directory, 'check.lock', { token, created_at: Date.now() });
  const before = performance.now();
  const worker = spawnSync(process.execPath, ['--require', preload, WORKER, token], { env: f.environment, encoding: 'utf8', timeout: 7000 });
  assert.equal(worker.status, 0, worker.stderr); assert.equal(worker.stdout, ''); assert.equal(worker.stderr, '');
  assert.ok(performance.now() - before < 6500);
  assert.equal(fs.existsSync(path.join(f.directory, 'cache.json')), false);
  // A killed or prematurely exiting worker leaves a token that expires; it
  // cannot prevent a later task from checking forever.
  const old = Date.now() - 16000; write(f.directory, 'check.lock', { token, created_at: old });
  const recovered = createBackgroundUpdates({ environment: f.environment, check: async () => result() });
  recovered.start(); await recovered.waitForIdle(); assert.ok(recovered.takeNotice());
});
