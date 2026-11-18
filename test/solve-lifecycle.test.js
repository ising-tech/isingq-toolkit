'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SolverService } = require('../packages/core');
const { IsingQError } = require('../packages/core/src/isingq');
const { SolveStore } = require('../packages/core/src/store');
const { QUBO_OBJECTIVE_ENERGY_VERSION } = require('../packages/core/src/qubo');
const { createHandler } = require('../src/server');

const MODEL = { num_bits: 2, linear: [{ index: 0, coefficient: -1 }] };
const LEGACY = { qubo: MODEL, model_summary: 'offline fixture', idempotency_key: 'original', solver_options: { use_credit: false } };
const TARGET = { kind: 'cloud', environment: 'sit', computer_type_id: 1 };
const CATALOG = { schemaVersion: 1, uploadLimits: { maxCsvBytes: 1048576 }, computerTypes: [1, 2].map(id => ({
  id, name: 'offline fixture', spinNumber: '2', price: 0, computeCreditCost: 0,
  executionCapabilities: { problemTypes: ['qubo'], minDimension: 1, maxDimension: 2,
    inputFormats: ['csv'], maxCalculateCount: 1, supportsH: false, fixedPostProcess: null },
})) };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function deferred() {
  let resolve, reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-solve-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = { XDG_DATA_HOME: home, XDG_CONFIG_HOME: home };
  const store = new SolveStore(environment);
  const state = { submits: 0, polls: 0, catalog: async () => CATALOG, submit: async () => ({ task_id: 'original-provider-task' }),
    poll: async () => ({ status: 'succeeded', bits: [1, 0], energy: -1 }) };
  const transport = {
    execution_mode: 'simulation',
    async submit(...args) { state.submits++; return state.submit(...args); },
    async poll(...args) { state.polls++; return state.poll(...args); },
  };
  const targetOptions = {
    environment,
    catalogClientFactory: () => ({ get: () => state.catalog() }),
    cloudTransportFactory: () => transport,
  };
  const createService = (solveStore = new SolveStore(environment)) => new SolverService({ store: solveStore, transport, targetOptions });
  return { store, state, createService, service: createService(store) };
}

async function targetArgs(service, overrides = {}) {
  const basis = { target: TARGET, qubo: MODEL, solver_options: { ...LEGACY.solver_options, post_process: 0 }, ...overrides };
  const preparation = await service.prepareTarget(basis);
  assert.equal(preparation.ready, true, JSON.stringify(preparation.issues));
  return { ...basis, preparation_token: preparation.preparation_token, idempotency_key: LEGACY.idempotency_key, model_summary: LEGACY.model_summary };
}

function call(service, name, args) {
  return createHandler(service, { tools_profile: 'technical' })({ method: 'tools/call', params: { name, arguments: args } });
}

for (const first of ['target', 'legacy']) {
  test(`${first} reservation blocks other entries and different keys for the uploaded matrix`, async t => {
    const f = fixture(t), gate = deferred(), entered = deferred();
    f.state.submit = async () => { entered.resolve(); return f.state.submits === 1 ? gate.promise : { task_id: 'unexpected-second-task' }; };
    const changed = await targetArgs(f.service, { target: { ...TARGET, computer_type_id: 2 },
      qubo: { ...MODEL, offset: 10, variables: [{ index: 0, name: 'renamed' }] } });
    const pending = first === 'target' ? f.service.startTarget(await targetArgs(f.service)) : f.service.start(LEGACY);
    const captured = pending.then(run => run, error => error);
    await entered.promise;
    const [reserved] = f.store.list().records;
    try {
      const restarted = f.createService();
      for (const start of [
        () => restarted.start({ ...LEGACY, idempotency_key: 'alternate-v1' }),
        () => restarted.startTarget({ ...changed, idempotency_key: 'alternate-v2' }),
        first === 'target' ? () => restarted.start(LEGACY) : () => restarted.startTarget(changed),
      ]) {
        await assert.rejects(start, error => error.run?.solve_id === reserved.solve_id);
      }
      assert.equal(f.state.submits, 1);
    } finally {
      gate.reject(new IsingQError('offline lost receipt', { phase: 'create_task', submissionOutcome: 'unknown' }));
      assert.equal((await captured).run?.status, 'submission_unknown');
    }
    const historical = f.store.get(reserved.solve_id);
    delete historical.submission_outcome;
    delete historical.matrix.submitted_problem_sha256;
    delete historical.submitted_problem_sha256;
    f.store.archive(historical);
    const restarted = f.createService();
    await assert.rejects(restarted.start({ ...LEGACY, idempotency_key: 'further-v1' }), error => error.run?.solve_id === reserved.solve_id);
    await assert.rejects(restarted.startTarget({ ...changed, idempotency_key: 'further-v2' }), error => error.run?.solve_id === reserved.solve_id);
    assert.equal(f.state.submits, 1);
  });

  for (const backupWorks of [true, false]) {
    test(`${first} receipt exposes accepted task when ${backupWorks ? 'full record' : 'all receipt'} writes fail`, async t => {
      const f = fixture(t), save = f.store.save.bind(f.store);
      const isingqStart = first === 'target' ? 'isingq_target_solve_start' : 'isingq_solve_start';
      const input = first === 'target' ? await targetArgs(f.service) : LEGACY;
      let fail = true;
      t.mock.method(f.store, 'save', run => {
        if (fail && run.provider_task_id) throw Object.assign(new Error('offline storage test'), { code: 'ENOSPC' });
        return save(run);
      });
      if (!backupWorks) {
        t.mock.method(f.store, 'saveSubmissionReceipt', () => { throw Object.assign(new Error('offline storage test'), { code: 'ENOSPC' }); });
      }
      const result = await call(f.service, isingqStart, input);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
      assert.equal(result.structuredContent.error.code, 'solve_receipt_persistence_failed');
      const accepted = result.structuredContent.data;
      assert.equal(accepted.submission_outcome, 'created');
      assert.equal(accepted.status, 'submitted');
      assert.equal(accepted.provenance.provider_task_id, 'original-provider-task');
      assert.equal(accepted.receipt_persistence.status, backupWorks ? 'receipt_only' : 'not_saved');
      assert.match(result.structuredContent.error.message, new RegExp(accepted.solve_id + '.*original-provider-task'));
      assert.equal(f.state.submits, 1);
      fail = false;
      const restarted = f.createService();
      const replay = await call(restarted, isingqStart, input);
      assert.equal(replay.structuredContent.data.solve_id, accepted.solve_id);
      assert.equal(f.state.submits, 1);
      if (backupWorks) {
        assert.equal(restarted.get(accepted.solve_id).provenance.provider_task_id, 'original-provider-task');
        const authorized = await restarted.start({ ...LEGACY, idempotency_key: 'authorized-new-task' });
        assert.notEqual(authorized.solve_id, accepted.solve_id);
        assert.equal(f.state.submits, 2);
        const observed = await restarted.poll(accepted.solve_id);
        assert.equal(observed.status, 'succeeded');
        assert.equal(observed.receipt_persistence, undefined);
        assert.equal(observed.result.objective_value, -1);
        assert.equal(f.store.get(accepted.solve_id).objective_energy_version, QUBO_OBJECTIVE_ENERGY_VERSION);
        assert.equal(observed.objective_energy_version, undefined);
        assert.equal(observed.result.objective_energy_version, undefined);
        assert.equal(f.state.polls, 1);
      } else {
        await assert.rejects(restarted.start({ ...LEGACY, idempotency_key: 'alternate' }), error => error.run?.solve_id === accepted.solve_id);
        assert.equal(restarted.get(accepted.solve_id).status, 'submitting');
        assert.equal((await restarted.poll(accepted.solve_id)).status, 'submitting');
        assert.equal(f.state.polls, 0);
      }
    });
  }
}

for (const late of ['running', 'error']) {
  test(`late legacy ${late} observation cannot erase a saved candidate`, async t => {
    const f = fixture(t), delayed = deferred();
    f.state.poll = () => f.state.polls === 1 ? delayed.promise : { status: 'succeeded', bits: [1, 0], energy: -1 };
    const run = await f.service.start(LEGACY);
    const older = f.service.poll(run.solve_id);
    const captured = older.then(value => value, error => error);
    assert.equal((await f.service.poll(run.solve_id)).status, 'succeeded');
    if (late === 'error') delayed.reject(new Error('offline delayed error'));
    else delayed.resolve({ status: 'running' });
    assert.equal((await captured).status, 'succeeded');
    assert.equal(f.store.get(run.solve_id).status, 'succeeded');
    assert.deepEqual(f.store.get(run.solve_id).result.bits, [1, 0]);
  });
}

function historicalRecord(index, changes = {}) {
  return { schema: 'isingq-mcp-solve/v1', solve_id: 'solve_' + index.toString(16).padStart(32, '0'),
    idempotency_digest: digest('history-' + index), request_digest: digest('request-' + index),
    status: 'succeeded', qubo: MODEL, matrix: { num_bits: 2, sha256: digest('matrix') }, provider_task_id: null, ...changes };
}

for (const kind of ['legacy', 'target']) {
  test(kind + ' replays a known task while corrupt history prevents new reservations', async t => {
    const f = fixture(t);
    const input = kind === 'legacy' ? LEGACY : await targetArgs(f.service);
    const start = args => kind === 'legacy' ? f.service.start(args) : f.service.startTarget(args);
    const accepted = await start(input);
    const unrelated = historicalRecord(0);
    const file = f.store.path(unrelated.solve_id);
    fs.writeFileSync(file, '{}');
    f.state.catalog = async () => assert.fail('no provider query is needed');
    assert.equal((await start(input)).solve_id, accepted.solve_id);
    await assert.rejects(start({ ...input, idempotency_key: 'new-after-corruption' }), { code: 'solve_record_invalid' });
    f.store.save({ ...unrelated, status: undefined });
    assert.equal((await start(input)).solve_id, accepted.solve_id);
    await assert.rejects(start({ ...input, idempotency_key: 'new-after-status-damage' }), { code: 'solve_record_status_invalid' });
    assert.equal(f.state.submits, 1);
  });
}

for (const [firstTool, damagedStatus] of [
  ['isingq_solve_start', undefined],
  ['isingq_target_solve_start', '__proto__'],
]) {
  test(`history with ${damagedStatus === undefined ? 'missing' : 'unknown'} status blocks both technical entry points`, async t => {
    const f = fixture(t), target = await targetArgs(f.service);
    const inputs = { isingq_solve_start: LEGACY, isingq_target_solve_start: target };
    f.state.submit = async () => { throw new IsingQError('offline lost receipt', { phase: 'create_task', submissionOutcome: 'unknown' }); };
    const first = await call(f.service, firstTool, inputs[firstTool]);
    assert.equal(first.structuredContent.data.status, 'submission_unknown');
    const original = f.store.get(first.structuredContent.data.solve_id);
    const damaged = { ...original, status: damagedStatus, submission_outcome: undefined };
    const file = f.store.path(damaged.solve_id);
    fs.writeFileSync(file, JSON.stringify(damaged));
    const damagedBytes = fs.readFileSync(file);
    f.state.submit = async () => ({ task_id: 'unexpected-second-task' });
    const restarted = f.createService();
    for (const [tool, input] of Object.entries(inputs)) {
      for (const idempotencyKey of ['new-after-status-damage', input.idempotency_key]) {
        const replay = await call(restarted, tool, { ...input, idempotency_key: idempotencyKey });
        assert.equal(replay.isError, true);
        const error = replay.structuredContent.error;
        assert.equal(error.code, 'solve_record_status_invalid');
        assert.match(error.message, new RegExp(damaged.solve_id));
        assert.match(error.message, /核对备份或原服务/);
      }
    }
    assert.equal(f.state.submits, 1);
    assert.deepEqual(fs.readFileSync(file), damagedBytes);
  });
}

test('legacy polling never persists non-finite energy as a successful candidate', async t => {
  const f = fixture(t);
  const qubo = { num_bits: 2, linear: [0, 1].map(index => ({ index, coefficient: Number.MAX_VALUE })) };
  const run = await f.service.start({ ...LEGACY, qubo });
  f.state.poll = async () => ({ status: 'succeeded', bits: [1, 1], energy: 0 });
  const overflowed = await f.service.poll(run.solve_id);
  assert.equal(overflowed.status, 'result_invalid');
  assert.equal(overflowed.result, null);
  assert.equal(overflowed.error.code, 'target_objective_nonfinite');
  assert.equal(f.store.get(run.solve_id).objective_energy_version, undefined);
  f.state.poll = async () => ({ status: 'succeeded', bits: [1, 0], energy: 0 });
  const recovered = await f.service.poll(run.solve_id);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.result.objective_value, Number.MAX_VALUE);
  assert.equal(recovered.error, null);
});

test('target start scans each unchanged history record once and never materializes a list page', async t => {
  const f = fixture(t), input = await targetArgs(f.service), files = new Set(), reads = new Map();
  for (let index = 1; index <= 1002; index++) {
    const record = historicalRecord(index);
    files.add(f.store.path(record.solve_id));
    f.store.save(record);
  }
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (files.has(file)) reads.set(file, (reads.get(file) || 0) + 1);
    return open(file, ...args);
  });
  t.mock.method(f.store, 'list', () => { throw new Error('submission scan must not read pages'); });
  assert.equal((await f.service.startTarget(input)).status, 'submitted');
  assert.equal(reads.size, files.size);
  assert.deepEqual([...new Set(reads.values())], [1]);
});

for (const change of ['added', 'replaced', 'corrupted']) {
  test(`the locked scan observes ${change} history after asynchronous preparation`, async t => {
    const f = fixture(t), input = await targetArgs(f.service), entered = deferred(), continueCatalog = deferred();
    const record = historicalRecord(2);
    if (change !== 'added') f.store.save(record);
    f.state.catalog = async () => { entered.resolve(); await continueCatalog.promise; return CATALOG; };
    const pending = assert.rejects(f.service.startTarget(input), error => {
      if (change === 'corrupted') return error.code === 'solve_record_invalid';
      return error.run?.solve_id === record.solve_id;
    });
    await entered.promise;
    if (change === 'corrupted') fs.writeFileSync(f.store.path(record.solve_id), '{}');
    else f.store.save({ ...record, status: 'submission_unknown' });
    continueCatalog.resolve();
    await pending;
    assert.equal(f.state.submits, 0);
  });
}

test('a recovered receipt does not hide another unresolved record of the same matrix', async t => {
  const f = fixture(t), input = await targetArgs(f.service);
  const accepted = historicalRecord(1, { status: 'submitting' });
  const unknown = historicalRecord(2, { status: 'submission_unknown' });
  f.store.save(accepted);
  f.store.saveSubmissionReceipt({ ...accepted, provider_task_id: 'accepted-original', submitted_at: '2026-01-01T00:00:00.000Z' });
  f.store.save(unknown);
  await assert.rejects(f.service.startTarget(input), error => error.run?.solve_id === unknown.solve_id);
  assert.equal(f.state.submits, 0);
});

test('an unreadable historical matrix blocks submission with its solve_id', async t => {
  const f = fixture(t), input = await targetArgs(f.service);
  const old = historicalRecord(1, { status: 'submission_unknown', qubo: undefined });
  f.store.save(old);
  for (const start of [() => f.service.start(LEGACY), () => f.service.startTarget(input)]) {
    await assert.rejects(start, error => {
      assert.equal(error.code, 'solve_unresolved_record_invalid');
      assert.match(error.message, new RegExp(old.solve_id));
      assert.doesNotMatch(error.message, /num_bits/);
      return true;
    });
  }
  assert.equal(f.state.submits, 0);
});

test('the locked scan rechecks a supplemental receipt when its reservation did not change', async t => {
  const f = fixture(t), input = await targetArgs(f.service), entered = deferred(), continueCatalog = deferred();
  const reservation = historicalRecord(1, { status: 'submitting' });
  f.store.save(reservation);
  f.store.saveSubmissionReceipt({ ...reservation, provider_task_id: 'accepted-original', submitted_at: '2026-01-01T00:00:00.000Z' });
  f.state.catalog = async () => { entered.resolve(); await continueCatalog.promise; return CATALOG; };
  const pending = assert.rejects(f.service.startTarget(input), error => error.run?.solve_id === reservation.solve_id);
  await entered.promise;
  fs.unlinkSync(f.store.submissionReceiptPath(reservation.solve_id));
  continueCatalog.resolve();
  await pending;
  assert.equal(f.state.submits, 0);
});

test('target uses the original key and provider task name for a proven safe retry', async t => {
  const f = fixture(t), input = await targetArgs(f.service);
  f.state.submit = async () => { throw new IsingQError('offline pre-create issue', { phase: 'upload', submissionOutcome: 'not_created' }); };
  let first;
  await assert.rejects(f.service.startTarget(input), error => {
    first = error.run;
    return first.recovery.same_key_retry_allowed === true;
  });
  f.state.submit = async () => ({ task_id: 'accepted-retry' });
  const restarted = f.createService();
  const created = await restarted.startTarget(input);
  assert.notEqual(created.solve_id, first.solve_id);
  assert.equal(created.view.provider_task_name, first.view.provider_task_name);
  assert.equal(created.view.provider_task_id, 'accepted-retry');
  assert.ok(f.store.get(first.solve_id).archived_at);
  assert.equal((await restarted.startTarget(input)).solve_id, created.solve_id);
  assert.equal(f.state.submits, 2);
});

test('target replays known requests but requires a complete store scan before a fresh reservation', async t => {
  const f = fixture(t), input = await targetArgs(f.service), accepted = await f.service.startTarget(input);
  const service = new SolverService({ store: { findByIdempotency: (...args) => f.store.findByIdempotency(...args) } });
  assert.deepEqual(await service.startTarget(input), accepted);
  await assert.rejects(service.startTarget({ ...input, idempotency_key: 'unknown-key' }),
    { code: 'target_store_capability_missing' });
  assert.equal(f.state.submits, 1);
});

test('a new target record without a review writes an explicit private no-review value', async t => {
  const f = fixture(t);
  const result = await f.service.startTarget(await targetArgs(f.service));
  assert.equal(f.store.get(result.solve_id).guided_review, null);
  assert.equal(result.guided_review, undefined);
});

test('trusted guided review metadata is cloned into the first reservation and remains private', async t => {
  const f = fixture(t), input = await targetArgs(f.service), gate = deferred(), entered = deferred();
  const guidedReview = { request_id: 'review-fixture', file: { manifest_path: 'offline-manifest.json', content_digest: 'a'.repeat(64) } };
  const original = structuredClone(guidedReview);
  f.state.submit = async () => { entered.resolve(); return f.state.submits === 1 ? gate.promise : { task_id: 'unexpected-second-task' }; };
  const pending = f.service.startTarget(input, { guidedReview });
  await entered.promise;
  guidedReview.file.manifest_path = 'caller-mutation.json';
  const [reservation] = f.store.list().records;
  try {
    assert.deepEqual(reservation.guided_review, original);
    assert.equal(f.service.get(reservation.solve_id).guided_review, undefined);
  } finally { gate.resolve({ task_id: 'accepted-guided-task' }); }
  assert.equal((await pending).guided_review, undefined);
  assert.deepEqual(f.store.get(reservation.solve_id).guided_review, original);
  assert.equal((await call(f.service, 'isingq_target_solve_start', { ...input, guidedReview })).isError, true);
});
