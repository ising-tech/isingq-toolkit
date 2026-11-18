'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const managed = require('../packages/core/src/managed-mcp-state');
const lifecycle = require('../packages/core/src/target-config-lifecycle');
const { GuidedSolve } = require('../packages/core/src/guided-solve');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { ManagerDraftStore } = require('../packages/core/src/target-config-drafts');
function root(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-cleanup-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }
function ioError(code) { return Object.assign(new Error('injected ' + code), { code }); }
function partialWrite(t, bytes, replace) {
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function(fd, value, ...args) {
    if (typeof fd === 'number') { if (bytes) write.call(this, fd, String(value).slice(0, bytes)); if (replace) replace(); throw ioError('ENOSPC'); }
    return write.call(this, fd, value, ...args);
  });
}
function replaceFile(file, text) { fs.renameSync(file, file + '.old'); fs.writeFileSync(file, text, { mode: 0o600 }); }
for (const bytes of [0, 15]) test(`managed lock reclaims its own ${bytes}-byte failed publication`, t => {
  const file = path.join(root(t), 'managed.lock'); partialWrite(t, bytes);
  assert.throws(() => managed.acquire(file), { code: 'ENOSPC' }); assert.equal(fs.existsSync(file), false);
  t.mock.restoreAll(); const release = managed.acquire(file, { timeoutMs: 0 }); release(); assert.equal(fs.existsSync(file), false);
});
for (const persistent of [false, true]) test(`managed lock ${persistent ? 'preserves unverifiable owner' : 'retries identity'} after fstat failure`, t => {
  const file = path.join(root(t), 'managed.lock'), stat = fs.fstatSync; let calls = 0;
  t.mock.method(fs, 'fstatSync', function(...args) { if (++calls === 1 || persistent) throw ioError('EIO'); return stat.apply(this, args); });
  assert.throws(() => managed.acquire(file), { code: 'EIO' }); assert.equal(fs.existsSync(file), persistent);
});
test('managed failed publication and successful release preserve replacement inode even with the same token', t => {
  const directory = root(t), file = path.join(directory, 'managed.lock'); partialWrite(t, 15, () => replaceFile(file, 'replacement'));
  assert.throws(() => managed.acquire(file), { code: 'ENOSPC' }); assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
  t.mock.restoreAll(); fs.unlinkSync(file); const release = managed.acquire(file), text = fs.readFileSync(file, 'utf8');
  replaceFile(file, text); release(); assert.equal(fs.readFileSync(file, 'utf8'), text);
});
function guided(t) { const value = Object.create(GuidedSolve.prototype); value.directory = root(t); return { value, id: 'request_' + 'a'.repeat(32), lock: path.join(value.directory, 'request_' + 'a'.repeat(32) + '.json.lock') }; }
for (const bytes of [0, 1]) test(`guided serial reclaims its own ${bytes}-byte failed PID write and preserves primary failure`, async t => {
  const { value, id, lock } = guided(t); partialWrite(t, bytes); let called = false;
  await assert.rejects(value.serial(id, () => { called = true; }), { code: 'ENOSPC' }); assert.equal(called, false); assert.equal(fs.existsSync(lock), false);
  t.mock.restoreAll(); assert.equal(await value.serial(id, () => 'retry'), 'retry');
});
test('guided serial preserves a replacement inode with the same live PID', async t => {
  const { value, id, lock } = guided(t);
  assert.equal(await value.serial(id, () => { replaceFile(lock, String(process.pid)); return 'done'; }), 'done');
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
});
for (const persistent of [false, true]) test(`guided serial handles ${persistent ? 'persistent' : 'first'} fstat failure conservatively`, async t => {
  const { value, id, lock } = guided(t), stat = fs.fstatSync; let calls = 0;
  t.mock.method(fs, 'fstatSync', function(...args) { if (++calls === 1 || persistent) throw ioError('EIO'); return stat.apply(this, args); });
  await assert.rejects(value.serial(id, () => assert.fail('work must not run')), { code: 'EIO' }); assert.equal(fs.existsSync(lock), persistent);
});
for (const kind of ['profiles', 'drafts']) test(`${kind} transaction preserves replacement inode and its primary error`, t => {
  const directory = root(t), profiles = new SolverProfileStore({ XDG_CONFIG_HOME: directory });
  const store = kind === 'profiles' ? profiles : new ManagerDraftStore({ configFile: profiles.file });
  const file = kind === 'profiles' ? profiles.file + '.lock' : store.lock, primary = ioError('ENOSPC');
  const work = () => { replaceFile(file, 'replacement'); throw primary; };
  assert.throws(() => kind === 'profiles' ? store.mutate(work) : store.transaction(work), error => kind === 'profiles' ? error === primary : error.code === 'draft_store_io_error');
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
});
function location(t) { const directory = root(t); return { directory, lock: path.join(directory, 'manager.starting'), file: path.join(directory, 'manager.session.json'), config_file: path.join(directory, 'solver-profiles.json'), build_id: 'a'.repeat(64), user_id: lifecycle.userId(), cloud_environment: 'prod' }; }
test('published claim, child handoff and session survive temporary unlink failure and remain releasable', t => {
  const loc = location(t), unlink = fs.unlinkSync, failed = new Set();
  t.mock.method(fs, 'unlinkSync', function(file) { if (String(file).includes('.tmp-') && !failed.has(file)) { failed.add(file); throw ioError('EPERM'); } return unlink.call(this, file); });
  const claim = lifecycle.newClaim(loc, 10000); assert.equal(lifecycle.owner(loc).nonce, claim.nonce);
  assert.equal(lifecycle.claimChild(loc, claim.nonce).nonce, claim.nonce);
  const record = lifecycle.publishSession(loc, claim, { url: 'http://127.0.0.1:43210/#' + 'b'.repeat(64), created_at: Date.now(), cloud_environment: 'prod', internal_preview: false, session: { expiry_policy: 'idle', idle_timeout_ms: 10000, foreground_lease_ms: 5000, heartbeat_ms: 1000 } });
  assert.equal(record.nonce, claim.nonce); assert.equal(fs.existsSync(loc.lock), false);
  t.mock.restoreAll(); assert.equal(lifecycle.removeSession(loc, claim.nonce), true);
  const next = lifecycle.newClaim(loc, 10000); assert.ok(next); assert.equal(lifecycle.removeClaim(loc, next.nonce), true);
});
test('exclusive JSON cleanup preserves a replacement temporary inode after publication', t => {
  const directory = root(t), file = path.join(directory, 'session.json'), link = fs.linkSync; let temporary;
  t.mock.method(fs, 'linkSync', function(source, destination) { link.call(this, source, destination); temporary = source; replaceFile(source, 'replacement'); });
  lifecycle.exclusiveJson(file, { published: true }); assert.deepEqual(JSON.parse(fs.readFileSync(file)), { published: true }); assert.equal(fs.readFileSync(temporary, 'utf8'), 'replacement');
});
for (const kind of ['profiles', 'drafts']) for (const persistent of [false, true]) test(`${kind} lock handles ${persistent ? 'persistent' : 'first'} fstat failure conservatively`, t => {
  const profiles = new SolverProfileStore({ XDG_CONFIG_HOME: root(t) }), store = kind === 'profiles' ? profiles : new ManagerDraftStore({ configFile: profiles.file });
  const lock = kind === 'profiles' ? profiles.file + '.lock' : store.lock, stat = fs.fstatSync; let calls = 0;
  t.mock.method(fs, 'fstatSync', function(...args) { if (++calls === 1 || persistent) throw ioError('EIO'); return stat.apply(this, args); });
  assert.throws(() => kind === 'profiles' ? store.mutate(() => assert.fail('work must not run')) : store.transaction(() => assert.fail('work must not run')), error => error.code === (kind === 'profiles' ? 'EIO' : 'draft_store_io_error'));
  assert.equal(fs.existsSync(lock), persistent);
});
for (const kind of ['managed', 'guided', 'profiles', 'drafts']) test(`${kind} preserves primary failure when owned lock unlink also fails`, async t => {
  const directory = root(t), primary = ioError('ENOSPC'), unlink = fs.unlinkSync; let lock;
  t.mock.method(fs, 'unlinkSync', function(file) { if (file === lock) throw ioError('EPERM'); return unlink.call(this, file); });
  if (kind === 'managed') {
    lock = path.join(directory, 'managed.lock'); partialWrite(t, 15);
    assert.throws(() => managed.acquire(lock), { code: 'ENOSPC' });
  } else if (kind === 'guided') {
    const fixture = guided(t); lock = fixture.lock;
    await assert.rejects(fixture.value.serial(fixture.id, () => { throw primary; }), error => error === primary);
  } else {
    const profiles = new SolverProfileStore({ XDG_CONFIG_HOME: directory }), store = kind === 'profiles' ? profiles : new ManagerDraftStore({ configFile: profiles.file });
    lock = kind === 'profiles' ? profiles.file + '.lock' : store.lock;
    assert.throws(() => kind === 'profiles' ? store.mutate(() => { throw primary; }) : store.transaction(() => { throw primary; }), error => kind === 'profiles' ? error === primary : error.code === 'draft_store_io_error' && error.message.includes('ENOSPC'));
  }
  assert.equal(fs.existsSync(lock), true);
});
test('exclusive JSON preserves link failure when temporary cleanup also fails', t => {
  const file = path.join(root(t), 'session.json');
  t.mock.method(fs, 'linkSync', () => { throw ioError('EEXIST'); });
  t.mock.method(fs, 'unlinkSync', () => { throw ioError('EPERM'); });
  assert.throws(() => lifecycle.exclusiveJson(file, { value: true }), { code: 'EEXIST' }); assert.equal(fs.existsSync(file), false);
});
test('exclusive JSON never removes a replaced published destination', t => {
  const file = path.join(root(t), 'session.json'), link = fs.linkSync;
  t.mock.method(fs, 'linkSync', function(source, destination) { link.call(this, source, destination); replaceFile(destination, 'replacement owner'); });
  lifecycle.exclusiveJson(file, { value: true }); assert.equal(fs.readFileSync(file, 'utf8'), 'replacement owner');
});

test('managed entropy failure after exclusive open releases the owned empty lock', t => {
  const file = path.join(root(t), 'managed.lock');
  t.mock.method(require('node:crypto'), 'randomBytes', () => { throw ioError('EIO'); });
  assert.throws(() => managed.acquire(file), { code: 'EIO' }); assert.equal(fs.existsSync(file), false);
});
