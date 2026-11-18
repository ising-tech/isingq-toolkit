'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { runWithCleanupSync, runWithCleanup } = require('../packages/core/src/run-with-cleanup');
const { readFileBounded } = require('../packages/core/src/file-limits');
const { SolveStore } = require('../packages/core/src/store');
const { ReviewFileSession } = require('../packages/core/src/review-file-io');
const { writeMathModelReviewFile } = require('../packages/core/src/review-file-writer');
const { GuidedSolve } = require('../packages/core/src/guided-solve');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
function failure(code) { return Object.assign(new Error(code), { code }); }
function directory(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-cleanup-priority-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function capture(work) { let failed = false, error; try { work(); } catch (value) { failed = true; error = value; } return { failed, error }; }
async function captureAsync(work) { let failed = false, error; try { await work(); } catch (value) { failed = true; error = value; } return { failed, error }; }
for (const primary of [undefined, null, 0, false, failure('PRIMARY')]) test(`sync/async cleanup preserves thrown ${String(primary)} and executes later steps`, async () => {
  const sync = [], async = [], cleanup = failure('CLEANUP');
  assert.deepEqual(capture(() => runWithCleanupSync(() => { throw primary; }, () => { sync.push('close'); throw cleanup; }, () => sync.push('unlink'))), { failed: true, error: primary });
  assert.deepEqual(await captureAsync(() => runWithCleanup(async () => { throw primary; }, async () => { async.push('close'); throw cleanup; }, async () => async.push('unlink'))), { failed: true, error: primary });
  assert.deepEqual(sync, ['close', 'unlink']); assert.deepEqual(async, sync);
});
for (const cleanup of [undefined, failure('CLOSE')]) test(`successful work retains cleanup failure ${String(cleanup)} and all later steps`, async () => {
  const steps = [];
  assert.deepEqual(capture(() => runWithCleanupSync(() => 'result', () => { steps.push('first'); throw cleanup; }, () => { steps.push('second'); throw failure('LATER'); })), { failed: true, error: cleanup });
  assert.deepEqual(await captureAsync(() => runWithCleanup(() => 'result', () => { throw cleanup; }, () => steps.push('async-later'))), { failed: true, error: cleanup });
  assert.deepEqual(steps, ['first', 'second', 'async-later']);
});
test('cleanup preserves the exact successful result', async () => { const value = Buffer.from([0, 255, 10]); assert.equal(runWithCleanupSync(() => value, () => {}), value); assert.equal(await runWithCleanup(() => value, async () => {}), value); });

test('bounded reads retain primary error and bytes; successful reads still report close failure', t => {
  const file = path.join(directory(t), 'input'), bytes = Buffer.from([0, 255, 10]); fs.writeFileSync(file, bytes);
  assert.deepEqual(readFileBounded(file, 1024), bytes);
  const read = fs.readSync, close = fs.closeSync, primary = failure('PRIMARY_READ'), cleanup = failure('CLOSE'); let closes = 0;
  t.mock.method(fs, 'readSync', () => { throw primary; });
  t.mock.method(fs, 'closeSync', fd => { closes++; close(fd); throw cleanup; });
  assert.throws(() => readFileBounded(file, 1024), error => error === primary); assert.equal(closes, 1);
  fs.readSync = read;
  assert.throws(() => readFileBounded(file, 1024), error => error === cleanup); assert.equal(closes, 2);
});

test('store read keeps its structured primary error when close also fails', t => {
  const store = new SolveStore({ HOME: directory(t) }), id = 'solve_' + 'a'.repeat(32);
  store.save({ solve_id: id, idempotency_digest: 'b'.repeat(64), request_digest: 'c'.repeat(64) });
  const close = fs.closeSync;
  t.mock.method(fs, 'readSync', () => { throw failure('EPRIMARY'); });
  t.mock.method(fs, 'closeSync', fd => { close(fd); throw failure('ECLOSE'); });
  assert.throws(() => store.get(id), error => error.code === 'solve_record_io_error' && error.message.includes('EPRIMARY') && !error.message.includes('ECLOSE'));
});

test('async FileHandle read preserves structured validation and clears active registration when close rejects', async t => {
  const root = directory(t), file = path.join(root, 'model.json'), content = '{}'; fs.writeFileSync(file, content);
  const digest = crypto.createHash('sha256').update(content).digest('hex'), session = new ReviewFileSession({ manifest_path: file, content_digest: digest });
  const open = fs.promises.open, closeError = failure('ECLOSE'); let closes = 0;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args), close = handle.close.bind(handle);
    handle.close = async () => { closes++; await close(); throw closeError; }; return handle;
  });
  await assert.rejects(session.read({ path: 'model.json', sha256: '0'.repeat(64) }, () => {}), error => error.code === 'review_file_digest_mismatch');
  assert.equal(session.active.size, 0); assert.equal(closes, 1);
  await assert.rejects(session.read({ path: 'model.json', sha256: digest }, () => {}), error => error === closeError);
  assert.equal(session.active.size, 0); assert.equal(closes, 2);
});

test('exporter preserves transform failure when FileHandle close and failed-export removal also fail', async t => {
  const root = directory(t), open = fs.promises.open, primary = failure('ETRANSFORM'); let closes = 0, removals = 0;
  t.mock.method(fs.promises, 'open', async (...args) => { const handle = await open(...args), close = handle.close.bind(handle); handle.close = async () => { closes++; await close(); throw failure('ECLOSE'); }; return handle; });
  t.mock.method(fs, 'rmSync', () => { removals++; throw failure('EREMOVE'); });
  async function* terms() { throw primary; }
  await assert.rejects(writeMathModelReviewFile({ directory: root, model: { schema_version: 'math-model-v1', id: 'model', variables: [{ id: 'x', domain: 'binary' }], objective: { sense: 'min', expression: { terms: terms() } }, constraints: [] }, data: {} }), error => error === primary);
  assert.equal(closes, 1); assert.equal(removals, 1); t.mock.restoreAll();
});

for (const kind of ['guided', 'profiles']) test(`${kind} lock preserves throw undefined and attempts owned unlink`, async t => {
  const root = directory(t), close = fs.closeSync, unlink = fs.unlinkSync; let lock, removed = false, workRan = false;
  t.mock.method(fs, 'unlinkSync', file => { if (file === lock) removed = true; return unlink(file); });
  if (kind === 'guided') {
    const guided = Object.create(GuidedSolve.prototype); guided.directory = root; const id = 'request_' + 'a'.repeat(32); lock = guided.file(id) + '.lock';
    assert.deepEqual(await captureAsync(() => guided.serial(id, () => { workRan = true; throw undefined; })), { failed: true, error: undefined });
    assert.equal(workRan, true); assert.equal(removed, true);
  } else {
    const profiles = new SolverProfileStore({ XDG_CONFIG_HOME: root }); lock = profiles.file + '.lock';
    t.mock.method(fs, 'closeSync', fd => { close(fd); throw failure('ECLOSE'); });
    assert.deepEqual(capture(() => profiles.mutate(() => { workRan = true; throw undefined; })), { failed: true, error: undefined });
    assert.equal(workRan, true); assert.equal(removed, true);
  }
});
