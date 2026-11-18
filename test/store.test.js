'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { apiKey, roots, saveApiKey, SolveStore, SolveStoreError } = require('../src/store');

function solve(id = 'solve_' + 'a'.repeat(32)) {
  return { solve_id: id, idempotency_digest: 'b'.repeat(64), request_digest: 'c'.repeat(64), status: 'queued' };
}

function withFsPatch(name, replacement, run) {
  const original = fs[name];
  fs[name] = replacement(original);
  try { return run(original); } finally { fs[name] = original; }
}

function storeFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-store-atomic-'));
  const store = new SolveStore({ HOME: home });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, store, file: store.path('solve_' + 'a'.repeat(32)) };
}

test('stores API key privately and never includes it in paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-test-'));
  const environment = { HOME: home };
  const file = saveApiKey('private-api-key', environment);
  assert.equal(apiKey(environment), 'private-api-key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(file.includes('private-api-key'), false);
});

test('uses LOCALAPPDATA on Windows', () => {
  const value = roots({ USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }, 'win32');
  assert.match(value.config, /AppData/);
  assert.match(value.config, /isingq-mcp/);
});

test('accepts an administrator-provided API key for headless runtime without persisting it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-headless-'));
  const environment = { HOME: home, ISINGQ_API_KEY: 'headless-private-key' };
  assert.equal(apiKey(environment), 'headless-private-key');
  assert.equal(fs.existsSync(path.join(roots(environment).config, 'api-key')), false);
});

test('rejects an empty API key', () => {
  assert.throws(() => saveApiKey('  ', { HOME: os.tmpdir() }), /不能为空/);
});

test('solve record close failure closes once, keeps the structured error, and removes its temporary file', t => {
  const f = storeFixture(t);
  let closeCalls = 0;
  withFsPatch('closeSync', original => fd => {
    closeCalls += 1;
    original.call(fs, fd);
    const error = Error('synthetic close failure'); error.code = 'EIO'; throw error;
  }, () => {
    assert.throws(() => f.store.save(solve()), error => error instanceof SolveStoreError && error.code === 'solve_record_io_error' && /fs_code=EIO/.test(error.message));
  });
  assert.equal(closeCalls, 1);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), []);
});

test('solve record write error stays primary when close also fails', t => {
  const f = storeFixture(t);
  const originalWrite = fs.writeFileSync;
  let closeCalls = 0;
  fs.writeFileSync = function(target, ...args) {
    if (typeof target === 'number') { const error = Error('synthetic write failure'); error.code = 'ENOSPC'; throw error; }
    return originalWrite.call(this, target, ...args);
  };
  try {
    withFsPatch('closeSync', original => fd => {
      closeCalls += 1; original.call(fs, fd);
      const error = Error('synthetic close failure'); error.code = 'EIO'; throw error;
    }, () => assert.throws(() => f.store.save(solve()), error => error instanceof SolveStoreError && /fs_code=ENOSPC/.test(error.message)));
  } finally { fs.writeFileSync = originalWrite; }
  assert.equal(closeCalls, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), []);
});

test('solve record rename failure preserves the old record and removes only its temporary file', t => {
  const f = storeFixture(t);
  fs.writeFileSync(f.file, JSON.stringify(solve()));
  const before = fs.readFileSync(f.file, 'utf8');
  withFsPatch('renameSync', original => (from, to) => {
    if (to === f.file) { const error = Error('synthetic rename failure'); error.code = 'EACCES'; throw error; }
    return original.call(fs, from, to);
  }, () => assert.throws(() => f.store.save({ ...solve(), status: 'done' }), error => error instanceof SolveStoreError && /fs_code=EACCES/.test(error.message)));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [path.basename(f.file)]);
});

test('solve record cleanup failure does not replace the write error', t => {
  const f = storeFixture(t);
  const originalWrite = fs.writeFileSync;
  const originalUnlink = fs.unlinkSync;
  fs.writeFileSync = function(target, ...args) {
    if (typeof target === 'number') { const error = Error('synthetic write failure'); error.code = 'ENOSPC'; throw error; }
    return originalWrite.call(this, target, ...args);
  };
  fs.unlinkSync = function(target, ...args) {
    if (String(target).includes('.tmp-')) { const error = Error('synthetic cleanup failure'); error.code = 'EPERM'; throw error; }
    return originalUnlink.call(this, target, ...args);
  };
  try {
    assert.throws(() => f.store.save(solve()), error => error instanceof SolveStoreError && /fs_code=ENOSPC/.test(error.message));
  } finally {
    fs.writeFileSync = originalWrite;
    fs.unlinkSync = originalUnlink;
  }
  for (const name of fs.readdirSync(path.dirname(f.file))) originalUnlink.call(fs, path.join(path.dirname(f.file), name));
});

test('API key replacement failures preserve the old key and never expose the submitted key', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-key-atomic-'));
  const environment = { HOME: home };
  const file = saveApiKey('synthetic-old-key', environment);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const failure of ['writeFileSync', 'closeSync', 'renameSync']) {
    const oldKey = fs.readFileSync(file, 'utf8');
    let closeCalls = 0;
    const original = fs[failure];
    fs[failure] = function(...args) {
      if (failure === 'writeFileSync' && typeof args[0] === 'number') { const error = Error('synthetic disk failure'); error.code = 'ENOSPC'; throw error; }
      if (failure === 'closeSync') { closeCalls += 1; original.call(fs, args[0]); const error = Error('synthetic close failure'); error.code = 'EIO'; throw error; }
      if (failure === 'renameSync' && args[1] === file) { const error = Error('synthetic rename failure'); error.code = 'EACCES'; throw error; }
      return original.apply(this, args);
    };
    try {
      assert.throws(() => saveApiKey('synthetic-new-key-secret', environment), error => {
        assert.doesNotMatch(error.message, /synthetic-new-key-secret/);
        return /API Key 文件写入失败/.test(error.message);
      }, `${failure} must leave the existing key intact`);
    } finally { fs[failure] = original; }
    assert.equal(fs.readFileSync(file, 'utf8'), oldKey);
    if (failure === 'closeSync') assert.equal(closeCalls, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp-')), []);
  }
});

test('API key target symlinks are rejected without changing their destination', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-key-symlink-'));
  const environment = { HOME: home };
  const directory = roots(environment).config;
  fs.mkdirSync(directory, { recursive: true });
  const outside = path.join(home, 'outside-key');
  fs.writeFileSync(outside, 'synthetic-outside-key');
  const file = path.join(directory, 'api-key');
  fs.symlinkSync(outside, file);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => saveApiKey('synthetic-new-key', environment), /拒绝写入 API Key 符号链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic-outside-key');
});

test('API key successful atomic replacement remains private', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-key-mode-'));
  const environment = { HOME: home };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = saveApiKey('synthetic-private-key', environment);
  assert.equal(apiKey(environment), 'synthetic-private-key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['api-key']);
});
