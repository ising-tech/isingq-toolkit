'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SolverService } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { TargetEngine } = require('../packages/core/src/target-service');
const ioError = code => Object.assign(new Error('injected ' + code), { code });
function root(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-target-cleanup-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }
function replace(file, text) { fs.renameSync(file, file + '.old'); fs.writeFileSync(file, text, { mode: 0o600 }); }
function fixture(t) {
  const directory = root(t), store = new SolveStore({ XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory }); let submits = 0;
  const entry = { id: 1, name: 'isolated', spinNumber: '2', price: 0, computeCreditCost: 0, executionCapabilities: { problemTypes: ['qubo'], minDimension: 1, maxDimension: 2, inputFormats: ['csv'], maxCalculateCount: 1, supportsH: false, fixedPostProcess: null } };
  const service = new SolverService({ store, targetOptions: {
    catalogClientFactory: () => ({ get: async () => ({ schemaVersion: 1, uploadLimits: { maxCsvBytes: 1048576 }, computerTypes: [entry] }) }),
    cloudTransportFactory: () => ({ execution_mode: 'simulation', prepareSubmission: () => ({}), submit: async () => { submits++; return { task_id: 'accepted-original-id' }; }, poll: async () => ({ status: 'succeeded', bits: [1, 0], energy: -1 }) }),
  } });
  const input = { target: { kind: 'cloud', environment: 'sit', computer_type_id: 1 }, qubo: { num_bits: 2, linear: [{ index: 0, coefficient: -1 }] }, solver_options: { post_process: 0, use_credit: false } };
  return { service, store, input, submits: () => submits, locks: path.join(store.directory, '.target-locks') };
}
async function args(f) { const prepared = await f.service.prepareTarget(f.input); assert.equal(prepared.ready, true); return { ...f.input, preparation_token: prepared.preparation_token, model_summary: 'offline cleanup fixture', idempotency_key: 'same-logical-call' }; }
for (const bytes of [0, 1]) test(`target lock reclaims its own ${bytes}-byte failed publication`, t => {
  const directory = root(t), engine = new TargetEngine({ store: { directory } }), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (fd, value, ...rest) => { if (typeof fd === 'number') { if (bytes) write(fd, String(value).slice(0, bytes)); throw ioError('ENOSPC'); } return write(fd, value, ...rest); });
  assert.throws(() => engine.lock('key'), error => error.code === 'target_store_unavailable');
  assert.equal(fs.existsSync(path.join(directory, '.target-locks/key.lock')), false);
});
test('target lock close failure closes once and safely reclaims ownership', t => {
  const directory = root(t), engine = new TargetEngine({ store: { directory } }), close = fs.closeSync; let calls = 0;
  t.mock.method(fs, 'closeSync', fd => { calls++; close(fd); throw ioError('EIO'); });
  assert.throws(() => engine.lock('key'), error => error.code === 'target_store_unavailable'); assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(directory, '.target-locks/key.lock')), false);
});
test('target lock publication failure and successful release preserve replacement inode', t => {
  const directory = root(t), engine = new TargetEngine({ store: { directory } }), file = path.join(directory, '.target-locks/key.lock'), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (fd, value, ...rest) => { if (typeof fd === 'number') { replace(file, 'replacement'); throw ioError('ENOSPC'); } return write(fd, value, ...rest); });
  assert.throws(() => engine.lock('key'), error => error.code === 'target_store_unavailable'); assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
  t.mock.restoreAll(); fs.unlinkSync(file); const release = engine.lock('key'); replace(file, String(process.pid)); release(); assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
});

test('reservation cleanup executes both releases and marks saved pre-provider occupancy not_created', async t => {
  const f = fixture(t), input = await args(f), unlink = fs.unlinkSync, calls = [];
  t.mock.method(fs, 'unlinkSync', file => { if (path.dirname(file) === f.locks) { calls.push(path.basename(file)); if (path.basename(file).startsWith('model-')) throw ioError('ECLEANUP'); } return unlink(file); });
  let error; await assert.rejects(f.service.startTarget(input), value => { error = value; return value.code === 'ECLEANUP'; });
  assert.equal(f.submits(), 0); assert.equal(calls.length, 2); assert.equal(calls.some(file => !file.startsWith('model-')), true);
  assert.equal(error.run.submission_outcome, 'not_created'); assert.equal(error.run.status, 'failed'); assert.equal(error.run.recovery.same_key_retry_allowed, true);
  const saved = f.store.get(error.run.solve_id); assert.equal(saved.submission_outcome, 'not_created'); assert.equal(saved.provider_task_id, null);
});

test('failed not_created write keeps the saved unknown record and original solve_id', async t => {
  const f = fixture(t), input = await args(f), unlink = fs.unlinkSync, save = f.store.save.bind(f.store);
  t.mock.method(fs, 'unlinkSync', file => { if (path.dirname(file) === f.locks && path.basename(file).startsWith('model-')) throw ioError('ECLEANUP'); return unlink(file); });
  t.mock.method(f.store, 'save', run => { if (run.submission_outcome === 'not_created') throw ioError('ESAVE'); return save(run); });
  let error; await assert.rejects(f.service.startTarget(input), value => { error = value; return value.code === 'ECLEANUP'; });
  assert.equal(f.submits(), 0); assert.equal(error.run.submission_outcome, 'unknown'); assert.equal(error.run.recovery.same_key_retry_allowed, false);
  assert.equal(f.store.get(error.run.solve_id).submission_outcome, 'unknown');
});

test('reservation primary store failure survives cleanup errors and both lock releases run', async t => {
  const f = fixture(t), input = await args(f), unlink = fs.unlinkSync, primary = ioError('EPRIMARY'), calls = [];
  t.mock.method(f.store, 'save', () => { throw primary; });
  t.mock.method(fs, 'unlinkSync', file => { if (path.dirname(file) === f.locks) { calls.push(file); throw ioError('ECLEANUP'); } return unlink(file); });
  await assert.rejects(f.service.startTarget(input), error => error === primary && error.run.submission_outcome === 'unknown'); assert.equal(f.submits(), 0); assert.equal(calls.length, 2);
});

test('concurrent existing result survives reservation release failure without another submit', async t => {
  const f = fixture(t), input = await args(f), accepted = await f.service.startTarget(input), unlink = fs.unlinkSync;
  const original = f.store.get(accepted.solve_id);
  fs.unlinkSync(f.store.path(accepted.solve_id));
  t.mock.method(fs, 'unlinkSync', file => { if (path.dirname(file) === f.locks) throw ioError('ECLEANUP'); return unlink(file); });
  assert.deepEqual(await f.service.startTarget(input, { beforeCreate: () => f.store.save(original) }), accepted);
  assert.equal(f.submits(), 1);
});

test('poll preserves the stored accepted task result when lock release fails', async t => {
  const f = fixture(t), input = await args(f), accepted = await f.service.startTarget(input), unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => { if (path.dirname(file) === f.locks && path.basename(file).startsWith('poll-')) throw ioError('ECLEANUP'); return unlink(file); });
  const result = await f.service.poll(accepted.solve_id); assert.equal(result.status, 'succeeded'); assert.equal(result.view.provider_task_id, 'accepted-original-id'); assert.equal(f.store.get(accepted.solve_id).status, 'succeeded'); assert.equal(f.submits(), 1);
});
for (const persistent of [false, true]) test(`target lock ${persistent ? 'preserves unknown ownership' : 'retries identity'} after fstat failure`, t => {
  const directory = root(t), engine = new TargetEngine({ store: { directory } }), stat = fs.fstatSync; let calls = 0;
  t.mock.method(fs, 'fstatSync', (...values) => { if (++calls === 1 || persistent) throw ioError('EIO'); return stat(...values); });
  assert.throws(() => engine.lock('key'), error => error.code === 'target_store_unavailable'); assert.equal(fs.existsSync(path.join(directory, '.target-locks/key.lock')), persistent);
});
test('poll primary record failure survives failed owned release', async t => {
  const f = fixture(t), input = await args(f), accepted = await f.service.startTarget(input), unlink = fs.unlinkSync, get = f.store.get.bind(f.store), primary = ioError('EPRIMARY'); let reads = 0;
  t.mock.method(f.store, 'get', id => ++reads === 1 ? get(id) : (() => { throw primary; })());
  t.mock.method(fs, 'unlinkSync', file => { if (path.dirname(file) === f.locks) throw ioError('ECLEANUP'); return unlink(file); });
  await assert.rejects(f.service.poll(accepted.solve_id), error => error === primary); assert.equal(f.submits(), 1);
});
