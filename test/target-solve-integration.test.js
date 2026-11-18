'use strict';

// These are program/integration checks against isolated adapters and private
// temporary stores. They do not certify a real Host, LLM, cloud or device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SolverService, validateQubo, validateDelivery } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { IsingQError } = require('../packages/core/src/isingq');

const OPTIONS = { post_process: 1, use_credit: false };
const CLOUD = { kind: 'cloud', environment: 'sit', computer_type_id: 8 };
const MODEL = { num_bits: 2, linear: [{ index: 0, coefficient: -1 }, { index: 1, coefficient: -2 }], quadratic: [{ i: 0, j: 1, coefficient: 4 }], offset: 7, variables: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }] };
const CAPABILITIES = { problemTypes: ['qubo'], minDimension: 1, maxDimension: 4096, inputFormats: ['csv', 'npz'], maxCalculateCount: 3, supportsH: false, fixedPostProcess: 1 };
const CATALOG = { schemaVersion: 1, uploadLimits: { maxCsvBytes: 100 * 1024 * 1024 }, computerTypes: [
  { id: 2, name: 'cheaper fixture', spinNumber: '9999', price: 1, computeCreditCost: 2, executionCapabilities: CAPABILITIES },
  { id: 8, name: 'chosen fixture', spinNumber: '1', price: 5, computeCreditCost: 1, executionCapabilities: CAPABILITIES },
  { id: 9, name: null, spinNumber: '2049', price: 2, computeCreditCost: 1, executionCapabilities: null },
] };
const ENVIRONMENTS = { sit: { api_base_url: 'https://sit.invalid/fixture', web_base_url: 'https://sit.invalid/console' }, prod: { api_base_url: 'https://prod.invalid/fixture', web_base_url: 'https://prod.invalid/console' } };
const CONTRACT = { contract_id: 'isolated-reference-v1', source: 'isolated-test-contract-only-not-device-evidence', matrix_mode: 'binary', csv_layout: 'qubo_upper_triangular', spin_to_bit: 'plus_is_one', result_domain: 'spin', max_dimension: 4096, allowed_states: ['stable'], coefficient_min: -127, coefficient_max: 127, integer_coefficients: true, max_file_bytes: 1048576 };
const clone = value => structuredClone(value);
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function harness(t, targetOverrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-target-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_DATA_HOME: path.join(directory, 'data') };
  const store = new SolveStore(environment), profiles = new SolverProfileStore(environment);
  const state = { catalog: clone(CATALOG), reads: [], submits: [], polls: [], probes: [], credentials: 0, observations: [], submitGate: null, submitError: null, catalogueError: null, taskId: 'shared-provider-id', probeConfig: { deviceName: 'isolated fixture', version: '1', maxScale: 4096, maxPrecision: 'float64 fixture' } };
  const adapter = target => ({
    execution_mode: state.executionMode ?? 'simulation',
    prepareSubmission() { state.credentials++; return {}; },
    async probe() { state.probes.push(clone(target)); return { config: clone(state.probeConfig), runtime: { bootTimestamp: 1 }, status: { status: 'stable' } }; },
    async submit(file, options) {
      state.submits.push({ target: clone(target), file: { ...file, content: Buffer.from(file.content) }, options: clone(options) });
      if (state.submitGate) await state.submitGate;
      if (state.submitError) throw state.submitError;
      return { task_id: state.taskId };
    },
    async poll(id, numBits) {
      state.polls.push({ target: clone(target), id, numBits });
      const next = state.observations.shift();
      return clone(typeof next === 'function' ? await next() : next || { status: 'succeeded', bits: [0, 1], energy: -999 });
    },
  });
  const targetOptions = { environment, profileStore: profiles, environments: ENVIRONMENTS,
    catalogClientFactory(settings, environmentName) { return { async get() { state.reads.push({ ...settings, environment: environmentName }); if (state.catalogueError) throw state.catalogueError; return clone(state.catalog); } }; },
    cloudTransportFactory: adapter, localTransportFactory: adapter, ...targetOverrides,
  };
  const service = new SolverService({ store, targetOptions });
  return { directory, environment, store, profiles, service, state, targetOptions };
}
async function prepared(service, { target = CLOUD, qubo = MODEL, solver_options = OPTIONS } = {}) {
  const args = { target, qubo, solver_options };
  const preparation = await service.prepareTarget(args);
  assert.equal(preparation.ready, true, JSON.stringify(preparation.issues));
  assert.match(preparation.preparation_token, /^prep_[a-f0-9]{64}$/);
  return { ...args, preparation_token: preparation.preparation_token, model_summary: '隔离测试：已确认当前目标、矩阵和参数', idempotency_key: 'logical-call-1' };
}
function profile(service, name, suffix) {
  return service.profileSave({ name, api_base_url: `http://127.0.0.1:65530/${suffix}`, web_base_url: `http://127.0.0.1:65531/${suffix}`, contract: CONTRACT });
}

test('target list and preparation are read-only; no-key catalogue failure keeps local choices', async t => {
  const { service, state } = harness(t); const local = profile(service, '本地A', 'a');
  const listed = await service.listTargets({ environment: 'sit', qubo: MODEL, solver_options: OPTIONS });
  assert.equal(listed.contract_version, 'isingq-solver-target-v1'); assert.equal(listed.advice_is_optional, true);
  assert.equal(listed.cloud.targets.length, 3); assert.equal(listed.local.profiles[0].id, local.id);
  await prepared(service);
  assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0); assert.equal(state.credentials, 0);
  state.catalogueError = Object.assign(new Error('isolated catalogue unavailable'), { status: 503 });
  const degraded = await service.listTargets({ environment: 'sit', qubo: MODEL });
  assert.ok(degraded.cloud.error); assert.equal(degraded.local.profiles[0].id, local.id);
  assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
});

const LOCAL_BILLING = { status: 'not_applicable', scope: 'cloud_platform', reason: 'local_target' };

test('management remains an actionable non-target with zero, one or multiple local profiles and any cloud availability', async t => {
  const { service, state } = harness(t);
  const management = { label: '添加／管理本地求解器', tool: 'isingq_solver_config_open', arguments: {}, creates_task: false };
  for (const count of [0, 1, 2]) {
    if (count) profile(service, '本地' + count, 'management-' + count);
    for (const availability of ['available', 'unavailable', 'not_requested']) {
      state.catalogueError = availability === 'unavailable' ? new Error('isolated catalogue unavailable') : null;
      const listed = await service.listTargets({ include_cloud: availability !== 'not_requested' });
      assert.equal(listed.cloud.status, availability);
      assert.equal(listed.local.profiles.length, count);
      assert.deepEqual(listed.local.management, management);
      assert.ok(listed.local.profiles.every(item => item.tool !== management.tool));
      assert.ok(listed.cloud.targets.every(item => item.tool !== management.tool));
    }
  }
  assert.equal(state.submits.length, 0); assert.equal(state.probes.length, 0);
  assert.equal(state.credentials, 0); assert.equal(service.listRuns().total, 0);
});

test('local preparation and v2 success lifecycle scope billing to cloud platform without claiming simulation or hardware', async t => {
  for (const mode of ['live', 'unknown', 'simulation']) await t.test(mode, async t => {
    const { service, state, store, environment, targetOptions } = harness(t);
    state.executionMode = mode;
    const p = profile(service, 'cloud-looking label is still local', 'billing-' + mode);
    const target = { kind: 'local', profile_id: p.id }, solver_options = { task_mode: 0 };
    const preparation = await service.prepareTarget({ target, qubo: MODEL, solver_options });
    assert.deepEqual(preparation.billing, LOCAL_BILLING);
    const blocked = await service.prepareTarget({ target, qubo: MODEL, solver_options: { task_mode: null } });
    assert.equal(blocked.ready, false); assert.deepEqual(blocked.billing, LOCAL_BILLING);
    assert.match(blocked.issues[0].message, /task_mode/);
    assert.equal(state.submits.length, 0); assert.equal(state.credentials, 0);
    const args = await prepared(service, { target, solver_options });
    const run = await service.startTarget(args);
    const resumed = new SolverService({ store: new SolveStore(environment), targetOptions });
    for (const result of [run, await service.startTarget(args), service.get(run.solve_id), resumed.get(run.solve_id),
      service.listRuns().records[0], await resumed.poll(run.solve_id)]) {
      assert.equal(result.execution_mode, mode); assert.deepEqual(result.billing, LOCAL_BILLING);
      assert.equal(result.provenance.source, mode === 'live' ? 'local_ising_http' : mode);
      assert.equal(result.provenance.actual_hardware, null);
    }
    assert.deepEqual(store.get(run.solve_id).billing, LOCAL_BILLING);
    assert.equal(state.submits.length, 1); assert.equal(state.reads.length, 0);
  });
});

test('historic local v2 projection corrects cloud billing without rewriting history or origin', async t => {
  const { service, state, store, environment, targetOptions } = harness(t);
  state.executionMode = 'live';
  const p = profile(service, '历史原设备', 'historic-billing');
  const args = await prepared(service, { target: { kind: 'local', profile_id: p.id }, solver_options: { task_mode: 1 } });
  const run = await service.startTarget(args);
  const historic = store.get(run.solve_id);
  historic.billing = { status: 'unverified' }; // Previous v2 evidence must not stay authoritative.
  store.save(historic);
  const bytes = fs.readFileSync(store.path(run.solve_id));
  service.profileDelete(p.id);
  const resumed = new SolverService({ store: new SolveStore(environment), targetOptions });
  for (const result of [resumed.get(run.solve_id), resumed.listRuns().records[0], await resumed.startTarget(args)]) {
    assert.deepEqual(result.billing, LOCAL_BILLING); assert.equal(result.execution_mode, 'live');
    assert.deepEqual(result.target, historic.target); assert.equal(result.provenance.source, 'local_ising_http');
  }
  assert.deepEqual(fs.readFileSync(store.path(run.solve_id)), bytes);
  const polled = await resumed.poll(run.solve_id);
  assert.deepEqual(polled.billing, LOCAL_BILLING); assert.equal(polled.execution_mode, 'live');
  assert.deepEqual(polled.target, historic.target); assert.equal(polled.provenance.source, 'local_ising_http');
  assert.deepEqual(store.get(run.solve_id).billing, { status: 'unverified' });
  assert.equal(state.submits.length, 1); assert.equal(state.reads.length, 0);
});

test('historic local v2 without execution evidence stays unknown while cloud platform billing is not applicable', async t => {
  const { service, store } = harness(t);
  const p = profile(service, '无执行模式的历史设备', 'historic-unknown');
  const run = await service.startTarget(await prepared(service, { target: { kind: 'local', profile_id: p.id }, solver_options: { task_mode: 1 } }));
  const historic = store.get(run.solve_id);
  delete historic.execution_mode; delete historic.billing;
  store.save(historic);
  const bytes = fs.readFileSync(store.path(run.solve_id));
  for (const result of [service.get(run.solve_id), service.listRuns().records[0]]) {
    assert.equal(result.execution_mode, 'unknown'); assert.equal(result.provenance.source, 'unknown');
    assert.deepEqual(result.billing, LOCAL_BILLING);
  }
  assert.deepEqual(fs.readFileSync(store.path(run.solve_id)), bytes);
  const polled = await service.poll(run.solve_id);
  assert.equal(polled.execution_mode, 'unknown'); assert.equal(polled.provenance.source, 'unknown');
  assert.deepEqual(polled.billing, LOCAL_BILLING); assert.equal(store.get(run.solve_id).execution_mode, undefined);
});

test('local fresh and replayed failure receipts preserve billing scope for all execution modes', async t => {
  for (const mode of ['live', 'unknown', 'simulation']) for (const outcome of ['rejected', 'unknown']) await t.test(mode + '/' + outcome, async t => {
    const { service, state } = harness(t); state.executionMode = mode;
    const p = profile(service, '本地失败', 'failure-' + mode + '-' + outcome);
    const args = await prepared(service, { target: { kind: 'local', profile_id: p.id }, solver_options: { task_mode: 2 } });
    state.submitError = new IsingQError('isolated create failure', { phase: 'create_task', submissionOutcome: outcome });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(service.startTarget(args), error => {
      assert.deepEqual(error.run.billing, LOCAL_BILLING); assert.equal(error.run.execution_mode, mode);
      assert.equal(error.run.result_interpretation.provider_internal_processing, 'unknown');
      assert.equal(error.run.result_interpretation.provider_fault_cause, 'undetermined');
      assert.equal(error.run.provenance.source, mode === 'live' ? 'local_ising_http' : mode); return true;
    });
    assert.equal(state.submits.length, 1); assert.equal(state.reads.length, 0);
  });
});

test('cloud preparation and v2 receipts retain unverified live/unknown billing and simulation applicability', async t => {
  for (const mode of ['live', 'unknown', 'simulation']) await t.test(mode, async t => {
    const { service, state } = harness(t); state.executionMode = mode;
    const expected = { status: mode === 'simulation' ? 'not_applicable' : 'unverified' };
    const preparation = await service.prepareTarget({ target: CLOUD, qubo: MODEL, solver_options: OPTIONS });
    assert.deepEqual(preparation.billing, { status: 'unverified' });
    const args = await prepared(service), run = await service.startTarget(args);
    for (const result of [run, await service.startTarget(args), service.get(run.solve_id), await service.poll(run.solve_id)]) {
      assert.equal(result.execution_mode, mode); assert.deepEqual(result.billing, expected);
      assert.equal(result.provenance.source, mode === 'live' ? 'isingq_api' : mode);
    }
    assert.equal(state.submits.length, 1); assert.equal(state.probes.length, 0);
  });
});

test('same logical key concurrent starts reserve one task before awaiting the provider', async t => {
  const { service, state } = harness(t); const args = await prepared(service);
  const gate = deferred(); state.submitGate = gate.promise;
  const calls = [service.startTarget(args), service.startTarget(args)];
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.submits.length, 1); assert.equal(service.listRuns().total, 1);
  } finally { gate.resolve(); }
  const results = await Promise.all(calls);
  assert.equal(results[0].solve_id, results[1].solve_id); assert.equal(state.submits.length, 1);
  assert.equal((await service.startTarget(args)).solve_id, results[0].solve_id);
  assert.equal(state.submits.length, 1);
});

test('same key cannot change target; a separately confirmed new call gets a unique provider name', async t => {
  const { service, state } = harness(t); const args = await prepared(service);
  const first = await service.startTarget(args);
  const changed = await prepared(service, { target: { ...CLOUD, computer_type_id: 2 } });
  await assert.rejects(service.startTarget(changed), error => error.code === 'target_key_conflict');
  assert.equal(state.submits.length, 1);
  await service.poll(first.solve_id); // Resolve the existing call before explicitly creating a new one.
  const second = await service.startTarget({ ...args, idempotency_key: 'explicitly-confirmed-new-call' });
  assert.notEqual(first.solve_id, second.solve_id);
  assert.notEqual(first.view.provider_task_name, second.view.provider_task_name);
  assert.equal(first.matrix.sha256, second.matrix.sha256);
  assert.equal(state.submits.length, 2);
});

test('price or capability changes invalidate the old confirmation basis before upload', async t => {
  for (const change of ['price', 'capability']) {
    const h = harness(t); const args = await prepared(h.service);
    const selected = h.state.catalog.computerTypes.find(entry => entry.id === 8);
    if (change === 'price') selected.price += 1;
    else selected.executionCapabilities.maxDimension += 1;
    await assert.rejects(h.service.startTarget(args), error => error.code === 'target_preparation_changed');
    assert.equal(h.state.submits.length, 0); assert.equal(h.service.listRuns().total, 0);
    const fresh = await prepared(h.service); assert.notEqual(fresh.preparation_token, args.preparation_token);
  }
});

test('choosing a compatible non-first recommendation preserves selected id and exact options', async t => {
  const { service, state } = harness(t);
  const list = await service.listTargets({ environment: 'sit', qubo: MODEL, solver_options: OPTIONS });
  assert.equal(list.cloud.advice[0].computer_type_id, 2);
  const args = await prepared(service); const run = await service.startTarget(args);
  assert.equal(run.target.computer_type_id, 8); assert.equal(state.submits[0].target.computer_type_id, 8);
  assert.equal(state.submits[0].options.computer_type_id, 8); assert.equal(state.submits[0].options.post_process, 1); assert.equal(state.submits[0].options.use_credit, false);
  assert.equal(state.submits.length, 1);
});

test('local A/B may share provider taskId without mixing origin, result or view', async t => {
  const { service, state } = harness(t);
  const a = profile(service, '本地A', 'a'), b = profile(service, '本地B', 'b');
  const first = await service.startTarget(await prepared(service, { target: { kind: 'local', profile_id: a.id }, solver_options: { task_mode: 0 } }));
  const argsB = await prepared(service, { target: { kind: 'local', profile_id: b.id }, solver_options: { task_mode: 2 } });
  const second = await service.startTarget({ ...argsB, idempotency_key: 'local-b-call' });
  assert.equal(first.provenance.provider_task_id, second.provenance.provider_task_id); assert.notEqual(first.solve_id, second.solve_id);
  state.observations.push({ status: 'succeeded', bits: [0, 1], energy: -99 }, { status: 'succeeded', bits: [1, 0], energy: -88 });
  const resultA = await service.poll(first.solve_id), resultB = await service.poll(second.solve_id);
  assert.equal(resultA.target.profile_id, a.id); assert.equal(resultB.target.profile_id, b.id);
  assert.equal(state.polls[0].target.api_base_url, a.api_base_url); assert.equal(state.polls[1].target.api_base_url, b.api_base_url);
  assert.equal(resultA.result.objective_value, 5); assert.equal(resultB.result.objective_value, 6);
  assert.equal(resultA.result.provider_energy, -99); assert.equal(resultB.result.provider_energy, -88);
  assert.equal(resultA.view.url, a.web_base_url); assert.equal(resultB.view.url, b.web_base_url);
});

test('rename, URL edit and profile deletion cannot rewrite historic poll or view snapshots', async t => {
  const { service, state, environment, targetOptions } = harness(t); const original = profile(service, '原设备A', 'original');
  const args = await prepared(service, { target: { kind: 'local', profile_id: original.id }, solver_options: { task_mode: 1 } });
  const run = await service.startTarget(args);
  const changed = service.profileSave({ ...original, name: '重命名且改址', api_base_url: 'http://127.0.0.1:65530/changed', web_base_url: 'http://127.0.0.1:65531/changed' });
  assert.ok(changed.revision > original.revision); service.profileDelete(original.id);
  const resumed = new SolverService({ store: new SolveStore(environment), targetOptions });
  const polled = await resumed.poll(run.solve_id);
  assert.equal(state.polls[0].target.api_base_url, original.api_base_url); assert.equal(state.polls[0].target.name, original.name);
  assert.equal(polled.target.revision, original.revision); assert.equal(polled.view.url, original.web_base_url);
  assert.equal(resumed.get(run.solve_id).view.url, original.web_base_url);
  assert.equal(resumed.listRuns().records[0].target.name, original.name);
  assert.equal(state.submits.length, 1);
});

test('unknown acceptance keeps occupancy and original name; same-key replay never resubmits', async t => {
  const { service, state } = harness(t); const args = await prepared(service);
  state.submitError = new IsingQError('isolated lost create receipt', { phase: 'create_task', submissionOutcome: 'unknown', submissionUnknown: true });
  let unknown;
  await assert.rejects(service.startTarget(args), error => { unknown = error.run; return error.run?.status === 'submission_unknown'; });
  assert.equal(service.listRuns().total, 1); assert.equal(unknown.submission_outcome, 'unknown');
  assert.ok(unknown.view.provider_task_name); assert.equal(unknown.provenance.provider_task_id, null);
  const originalName = unknown.view.provider_task_name;
  await assert.rejects(service.startTarget(args), error => error.run?.view.provider_task_name === originalName);
  const poll = await service.poll(unknown.solve_id);
  assert.equal(poll.status, 'submission_unknown'); assert.equal(poll.observation.remote_request_performed, false);
  assert.equal(state.polls.length, 0); assert.equal(state.submits.length, 1);
});

test('unknown acceptance cannot be bypassed by changing only the idempotency key', async t => {
  const { service, state } = harness(t); const args = await prepared(service);
  state.submitError = new IsingQError('isolated lost receipt', { phase: 'create_task', submissionOutcome: 'unknown' });
  await assert.rejects(service.startTarget(args)); state.submitError = null;
  await assert.rejects(service.startTarget({ ...args, idempotency_key: 'new-key-still-unresolved' }), error => /未知|核查|原任务/.test(error.message));
  assert.equal(state.submits.length, 1); assert.equal(service.listRuns().total, 1);
});

test('result_pending/invalid remain inspectable and distinct from provider failure; success requires valid vector', async t => {
  const { service, state } = harness(t); const args = await prepared(service); const run = await service.startTarget(args);
  state.observations.push({ status: 'result_pending', provider_status: 2 }, { status: 'result_invalid', provider_status: 2 }, { status: 'succeeded', bits: [1], energy: -5 }, { status: 'succeeded', bits: [0, 1], energy: -999 });
  for (const expected of ['result_pending', 'result_invalid', 'result_invalid']) {
    const pending = await service.poll(run.solve_id); assert.equal(pending.status, expected); assert.equal(pending.result, null); assert.equal(pending.completed_at, null);
  }
  const done = await service.poll(run.solve_id); assert.equal(done.status, 'succeeded'); assert.equal(done.result.objective_value, 5); assert.equal(done.result.provider_energy, -999);
  assert.deepEqual(done.result.variables.map(variable => [variable.name, variable.value]), [['A', 0], ['B', 1]]);
  const failArgs = { ...args, idempotency_key: 'provider-failure-case' }; const failure = await service.startTarget(failArgs);
  state.observations.push({ status: 'failed', provider_status: 3 }); const failed = await service.poll(failure.solve_id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'provider_execution_failed'); assert.ok(failed.completed_at);
  const count = state.polls.length; assert.equal((await service.poll(failure.solve_id)).status, 'failed'); assert.equal(state.polls.length, count);
});

test('2049-bit target runs decode and recompute energy/delivery while legacy validation retains 2048 limit', async t => {
  const { service, state } = harness(t); const n = 2049;
  const qubo = { num_bits: n, linear: [{ index: 0, coefficient: -2 }, { index: n - 1, coefficient: -7 }], quadratic: [{ i: 0, j: n - 1, coefficient: 3 }], offset: 11, variables: [{ index: 0, name: 'first' }, { index: n - 1, name: 'last' }] };
  assert.throws(() => service.validate(qubo), /2048/); assert.throws(() => validateQubo(qubo), /2048/);
  const args = await prepared(service, { qubo }); const run = await service.startTarget(args);
  const bits = Array(n).fill(0); bits[0] = 1; bits[n - 1] = 1;
  state.observations.push({ status: 'succeeded', bits, energy: -1234 });
  const result = await service.poll(run.solve_id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.variables.length, n);
  assert.equal(result.result.variables[n - 1].name, 'last'); assert.equal(result.result.variables[n - 1].value, 1);
  assert.equal(result.result.objective_value, 5); assert.equal(result.result.provider_energy, -1234);
  const document = { qubo, candidate_bits: bits, claimed_objective_value: 5, mapping_completeness: 'partial', test_ledger: [{ id: 'independent-integer-reference', status: 'passed', evidence_ref: 'isolated-program-test' }] };
  const delivery = service.validateTargetDelivery({ solve_id: run.solve_id, document });
  assert.equal(delivery.summary.num_bits, n); assert.equal(delivery.summary.candidate_objective_value, 5);
  assert.equal(delivery.summary.matrix_sha256, result.matrix.sha256);
  assert.equal(delivery.validation.business_correctness, 'unverified'); assert.equal(delivery.validation.ledger_authenticity, 'not_verified');
  assert.throws(() => validateDelivery(document), /2048/);
  assert.throws(() => service.validateTargetDelivery({ solve_id: run.solve_id, document: { ...document, qubo: { ...qubo, offset: 12 } } }), error => error.code === 'target_delivery_mismatch');
  assert.equal(state.submits.length, 1); assert.equal(state.polls[0].numBits, n);
});

async function crossProcessRace(t, differentKeys = false, mixedEntries = false) {
  const { directory, environment } = harness(t); const countFile = path.join(directory, 'provider-create-count.log');
  const corePath = require.resolve('../packages/core'); const storePath = require.resolve('../packages/core/src/store');
  const program = `
  const fs=require('node:fs'); const {SolverService}=require(${JSON.stringify(corePath)}); const {SolveStore}=require(${JSON.stringify(storePath)});
  const environment=${JSON.stringify(environment)}, catalog=${JSON.stringify(CATALOG)};
  const transport={execution_mode:'simulation',prepareSubmission(){return{}},async submit(file){fs.appendFileSync(${JSON.stringify(countFile)},(file.task_name || 'legacy')+'\\n');await new Promise(resolve=>{process.once('message',resolve);process.send({type:'submit_started'})});return{task_id:'cross-process-task'}}};
  const service=new SolverService({store:new SolveStore(environment),transport,targetOptions:{environment,environments:${JSON.stringify(ENVIRONMENTS)},catalogClientFactory:()=>({get:async()=>structuredClone(catalog)}),cloudTransportFactory:()=>transport}});
  (async()=>{const args={target:${JSON.stringify(CLOUD)},qubo:${JSON.stringify(MODEL)},solver_options:${JSON.stringify(OPTIONS)}};const p=await service.prepareTarget(args);if(!p.ready)throw new Error(JSON.stringify(p.issues));process.send({type:'ready'});await new Promise(resolve=>process.once('message',resolve));try{const options={qubo:args.qubo,solver_options:args.solver_options,model_summary:'isolated multiprocess confirmed fixture',idempotency_key:process.env.TARGET_INTEGRATION_RACE_KEY};const result=process.env.TARGET_INTEGRATION_RACE_ENTRY==='legacy'?await service.start({...options,solver_options:{...options.solver_options,post_process:Boolean(options.solver_options.post_process)}}):await service.startTarget({...options,target:args.target,preparation_token:p.preparation_token});process.send({type:'result',solve_id:result.solve_id,status:result.status})}catch(e){process.send({type:'result',error_code:e.code || (e.run ? 'solve_start_failed' : e.name),message:e.message})}process.disconnect()})().catch(e=>{console.error(e.message);process.exitCode=1;process.disconnect()});`;
  const children = [], ready = deferred(), results = [], finishedChildren = new Set(); let readyCount = 0, submitCount = 0, released = false;
  const releaseProvider = () => {
    if (!released && submitCount >= 1 && (results.length >= 1 || submitCount >= 2)) {
      released = true; for (const child of children) if (child.connected && !finishedChildren.has(child)) child.send('provider-receipt');
    }
  };
  const completions = Array.from({ length: 2 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program], { env: { ...process.env, TARGET_INTEGRATION_RACE_KEY: differentKeys ? 'independent-key-' + index : 'shared-process-key', TARGET_INTEGRATION_RACE_ENTRY: mixedEntries && index === 0 ? 'legacy' : 'target' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child); let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => {
      if (message.type === 'ready' && ++readyCount === 2) ready.resolve();
      if (message.type === 'submit_started') submitCount++;
      if (message.type === 'result') { results.push(message); finishedChildren.add(child); }
      releaseProvider();
    });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exit=${code}, stderr=${stderr}`)));
  }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await ready.promise; for (const child of children) child.send('start'); await Promise.all(completions);
  const creates = fs.readFileSync(countFile, 'utf8').trim().split('\n');
  assert.equal(creates.length, 1, 'shared persistent occupancy/locks must prevent a second provider submit while the first receipt is unresolved');
  const store = new SolveStore(environment); assert.equal(store.list().total, 1);
  const expectedErrors = differentKeys ? ['target_in_flight', 'target_unresolved_submission'] : ['target_in_flight'];
  if (mixedEntries) expectedErrors.push('solve_start_failed');
  for (const result of results) if (result.error_code) assert.ok(expectedErrors.includes(result.error_code), result.message);
  if (mixedEntries) assert.equal(results.filter(result => result.error_code).length, 1);
  const ids = results.filter(result => result.solve_id).map(result => result.solve_id); assert.ok(ids.length >= 1); assert.equal(new Set(ids).size, 1);
}

test('two independent processes sharing a store cannot create twice for one logical key', { timeout: 10000 }, async t => crossProcessRace(t));
test('new keys cannot bypass unresolved same-model occupancy across independent processes', { timeout: 10000 }, async t => crossProcessRace(t, true));
test('legacy and target processes share same-matrix reservation with different keys', { timeout: 10000 }, async t => crossProcessRace(t, true, true));

test('model-only, variable-meaning and parameter changes require a new confirmation token even with unchanged CSV', async t => {
  const { service, state } = harness(t); const args = await prepared(service);
  for (const variant of [
    { ...args, qubo: { ...clone(MODEL), offset: 8 } },
    { ...args, qubo: { ...clone(MODEL), variables: [{ index: 0, name: 'A', meaning: 'changed interpretation' }, { index: 1, name: 'B' }] } },
    { ...args, solver_options: { ...OPTIONS, calculate_count: 2 } },
  ]) {
    await assert.rejects(service.startTarget(variant), error => error.code === 'target_preparation_changed');
  }
  assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
});

test('standard local profile resolves explicit binary contract while missing cloud prerequisites and unsupported local encoding never upload', async t => {
  const { service, state } = harness(t);
  const noFunding = await service.prepareTarget({ target: CLOUD, qubo: MODEL, solver_options: { post_process: 1 } });
  assert.equal(noFunding.ready, false); assert.match(JSON.stringify(noFunding.issues), /use_credit/);
  const unknown = await service.prepareTarget({ target: { ...CLOUD, computer_type_id: 9 }, qubo: MODEL, solver_options: OPTIONS });
  assert.equal(unknown.ready, false); assert.match(JSON.stringify(unknown.issues), /尚未声明/);
  const standard = service.profileSave({ name: '标准本地连接', api_base_url: 'http://127.0.0.1:65530/standard-profile' });
  assert.equal(standard.contract, undefined, 'standard profile must not require users to fill a deployment contract');
  const local = await service.prepareTarget({ target: { kind: 'local', profile_id: standard.id }, qubo: MODEL, solver_options: { task_mode: 0 } });
  assert.equal(local.ready, true, JSON.stringify(local.issues));
  assert.equal(local.encoding.matrix_mode, 'binary'); assert.equal(local.encoding.result_domain, 'binary');
  assert.match(local.adapter_version, /^ising-control-http-v\d+$/);
  assert.equal(local.effective_contract.contract_id, local.adapter_version);
  assert.match(local.effective_contract.source, /IsingControl HTTP v1/);
  assert.equal(local.effective_contract.matrix_mode, 'binary'); assert.equal(local.effective_contract.result_domain, 'binary');
  assert.equal(local.effective_contract.csv_layout, 'qubo_upper_triangular');
  assert.equal(local.target.adapter_version, local.adapter_version);
  assert.deepEqual(local.target.effective_contract, local.effective_contract, 'confirmation target snapshot must bind its effective standard contract');
  for (const field of ['coefficient_min', 'coefficient_max', 'integer_coefficients', 'coefficient_step', 'max_file_bytes']) {
    assert.equal(local.declared_constraints[field].status, 'not_declared', field);
    assert.equal(local.declared_constraints[field].responsibility, 'provider_managed', field);
    assert.equal(Object.hasOwn(local.declared_constraints[field], 'value'), false, 'do not invent ' + field);
  }
  assert.equal(local.precision.responsibility, 'provider_managed'); assert.equal(local.precision.lossless_guaranteed, false);
  assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
  for (const contract of [{ csv_layout: 'unsupported_layout' }, { matrix_mode: 'spin' }]) {
    const unsupported = service.profileSave({ name: '不支持的数学表示', api_base_url: 'http://127.0.0.1:65530/unsupported-encoding', contract });
    const blocked = await service.prepareTarget({ target: { kind: 'local', profile_id: unsupported.id }, qubo: MODEL, solver_options: { task_mode: 0 } });
    assert.equal(blocked.ready, false); assert.equal(blocked.preparation_token, null);
    assert.ok(blocked.issues.some(issue => issue.code === 'local_encoding_unsupported'));
    assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
  }
  const args = await prepared(service); state.catalog.computerTypes = state.catalog.computerTypes.filter(entry => entry.id !== 8);
  await assert.rejects(service.startTarget(args), error => error.code === 'target_unavailable');
  assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
});

for (const [label, target] of [['machine', { ...CLOUD, computer_type_id: 2 }], ['environment', { ...CLOUD, environment: 'prod' }]]) {
  test('unknown acceptance cannot be bypassed by a new key and changed cloud ' + label, async t => {
    const { service, state } = harness(t); const firstArgs = await prepared(service);
    state.submitError = new IsingQError('isolated lost receipt', { phase: 'create_task', submissionOutcome: 'unknown' });
    await assert.rejects(service.startTarget(firstArgs)); state.submitError = null;
    const changed = await prepared(service, { target });
    await assert.rejects(service.startTarget({ ...changed, idempotency_key: 'changed-target-still-unresolved' }), error => /未知|核查|原任务/.test(error.message));
    assert.equal(state.submits.length, 1); assert.equal(service.listRuns().total, 1);
  });
}

test('cloud result validation reason remains actionable after the service stores its invalid state', async t => {
  const { normalizeCloudPoll } = require('../packages/core/src/isingq');
  const { service, state } = harness(t); const run = await service.startTarget(await prepared(service));
  state.observations.push(normalizeCloudPoll({ data: { status: 2, result: { bits: [1], energy: 0 } } }, 2, true));
  const result = await service.poll(run.solve_id);
  assert.equal(result.status, 'result_invalid');
  assert.match(result.error?.message || '', /维度/);
  assert.equal(service.get(run.solve_id).error?.message, result.error.message);
  assert.equal(state.submits.length, 1);
});

test('real local adapter plus service preserves CSV, provider phases, spin decoding and result diagnostics on injected HTTP', async t => {
  const { LocalSolverTransport } = require('../packages/core/src/local-target');
  const calls = [], detailStatuses = ['pending', 'running', 'finished', 'finished', 'finished'];
  const resultBodies = [{ code: 10021, msg: 'fixture result pending' }, { code: 10023, msg: 'fixture result corrupt' }, { code: 10000, data: { ok: true, spin_config: [-1, 1], energy: -500, isingCalcMs: 17 } }];
  const reply = body => new Response(JSON.stringify(body));
  const { service } = harness(t, { localTransportFactory(snapshot) {
    return new LocalSolverTransport({ profile: { id: snapshot.profile_id, revision: snapshot.revision, name: snapshot.name, api_base_url: snapshot.api_base_url, web_base_url: snapshot.web_base_url, contract: snapshot.contract }, fetch: async (url, options) => {
      calls.push({ url, options }); const route = new URL(url).pathname;
      if (route.endsWith('/api/device/config')) return reply({ code: 10000, data: { deviceName: 'fixture only', version: '1', maxScale: 4096, maxPrecision: 'float64 fixture' } });
      if (route.endsWith('/api/device/runtime')) return reply({ code: 10000, data: { bootTimestamp: 1 } });
      if (route.endsWith('/api/device/status')) return reply({ code: 10000, data: { status: 'stable' } });
      if (route.endsWith('/api/task/create')) return reply({ code: 10000, data: { status: 'success', taskId: 'isolated-local-task' } });
      if (route.endsWith('/api/task/detail')) return reply({ code: 10000, data: { taskId: 'isolated-local-task', status: detailStatuses.shift() } });
      if (route.endsWith('/api/task/result')) return reply(resultBodies.shift());
      assert.fail('unexpected isolated HTTP route: ' + route);
    } });
  } });
  const p = profile(service, '隔离协议设备', 'protocol');
  const run = await service.startTarget(await prepared(service, { target: { kind: 'local', profile_id: p.id }, solver_options: { task_mode: 2 } }));
  for (const expected of ['queued', 'running', 'result_pending', 'result_invalid']) {
    const result = await service.poll(run.solve_id); assert.equal(result.status, expected); assert.equal(result.result, null);
    if (expected === 'result_pending') assert.equal(result.error.provider_code, 10021);
    if (expected === 'result_invalid') assert.equal(result.error.provider_code, 10023);
  }
  const result = await service.poll(run.solve_id);
  assert.equal(result.status, 'succeeded'); assert.deepEqual(result.result.bits, [0, 1]); assert.deepEqual(result.result.spin_config, [-1, 1]);
  assert.equal(result.result.provider_energy, -500); assert.equal(result.result.objective_value, 5); assert.equal(result.result.isingCalcMs, 17);
  const creates = calls.filter(call => call.url.endsWith('/api/task/create')); assert.equal(creates.length, 1);
  const param = JSON.parse(creates[0].options.body.get('param')); assert.equal(param.taskName, run.view.provider_task_name); assert.equal(param.matrixMode, 'binary'); assert.equal(param.taskMode, 2);
  assert.equal(await creates[0].options.body.get('file').text(), '-1,4\n0,-2\n');
  assert.equal(calls.filter(call => call.url.endsWith('/api/task/result')).length, 3);
  assert.equal(calls.every(call => !Object.keys(call.options.headers).some(key => /authorization|channel|cookie/i.test(key))), true);
});

test('local unknown acceptance cannot be bypassed by a new key and another local profile', async t => {
  const { service, state } = harness(t); const a = profile(service, '未知来源A', 'unknown-a'), b = profile(service, '替代B', 'unknown-b');
  const original = await prepared(service, { target: { kind: 'local', profile_id: a.id }, solver_options: { task_mode: 1 } });
  state.submitError = new IsingQError('isolated local create receipt lost', { phase: 'local_create', submissionOutcome: 'unknown' });
  await assert.rejects(service.startTarget(original)); state.submitError = null;
  const replacement = await prepared(service, { target: { kind: 'local', profile_id: b.id }, solver_options: { task_mode: 1 } });
  await assert.rejects(service.startTarget({ ...replacement, idempotency_key: 'local-bypass-unknown' }), error => /未知|核查|原任务/.test(error.message));
  assert.equal(state.submits.length, 1); assert.equal(service.listRuns().total, 1);
});

test('archiving an unknown record cannot permit another key to recreate its unresolved model', async t => {
  const { service, state, store } = harness(t); const args = await prepared(service); let unknown;
  state.submitError = new IsingQError('isolated lost receipt', { phase: 'create_task', submissionOutcome: 'unknown' });
  await assert.rejects(service.startTarget(args), error => { unknown = error.run; return unknown?.status === 'submission_unknown'; });
  store.archive(store.get(unknown.solve_id)); state.submitError = null;
  await assert.rejects(service.startTarget({ ...args, idempotency_key: 'archive-must-not-unblock' }), error => /未知|核查|原任务/.test(error.message));
  assert.equal(state.submits.length, 1); assert.equal(store.list().total, 1); assert.ok(store.get(unknown.solve_id).archived_at);
});

for (const [field, changed] of [['version', '2'], ['maxPrecision', 'changed precision fixture'], ['maxScale', 4095]]) {
  test('device config.' + field + ' change invalidates old local confirmation before submit', async t => {
    const { service, state } = harness(t); const p = profile(service, '能力依据变化设备', 'capability-change');
    const args = await prepared(service, { target: { kind: 'local', profile_id: p.id }, solver_options: { task_mode: 1 } });
    state.probeConfig[field] = changed;
    await assert.rejects(service.startTarget(args), error => error.code === 'target_preparation_changed');
    assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
    const fresh = await prepared(service, { target: args.target, solver_options: args.solver_options });
    assert.notEqual(fresh.preparation_token, args.preparation_token);
  });
}

for (const late of ['running', 'request failure']) {
  test('older ' + late + ' poll arriving after newer success cannot overwrite terminal result', async t => {
    const { service, state } = harness(t); const run = await service.startTarget(await prepared(service));
    const gate = deferred();
    state.observations.push(() => gate.promise, { status: 'succeeded', provider_status: 2, bits: [0, 1], energy: -999 });
    const older = service.poll(run.solve_id);
    const olderOutcome = older.then(value => ({ value }), error => ({ error }));
    assert.equal(state.polls.length, 1, 'first remote poll is already awaiting its provider response');
    const newer = await service.poll(run.solve_id);
    assert.equal(newer.status, 'succeeded'); assert.equal(service.get(run.solve_id).result.objective_value, 5);
    if (late === 'running') gate.resolve({ status: 'running', provider_status: 1 });
    else gate.reject(new IsingQError('isolated delayed poll failure', { phase: 'poll', status: 503 }));
    const outcome = await olderOutcome;
    const stored = service.get(run.solve_id);
    assert.equal(stored.status, 'succeeded', 'late poll must not move a completed task back into submitted/running');
    assert.equal(stored.result_state, 'valid'); assert.deepEqual(stored.result, newer.result);
    assert.equal(stored.provider_status, 2); assert.equal(stored.completed_at, newer.completed_at);
    assert.equal(stored.error, null, 'late transport failure must not poison the already valid result');
    assert.equal(outcome.error, undefined); assert.equal(outcome.value.status, 'succeeded', 'late response must return the latest persisted task state');
    assert.equal(state.submits.length, 1); assert.equal(state.polls.length, 2);
  });
}

test('local prepare carries management through default mode, explicit mode and stale profile over actual MCP responses without opening it', async t => {
  const { service, state } = harness(t);
  const { createHandler } = require('../src/server');
  let opened = 0;
  service.openTargetConfig = () => { opened++; throw Error('PREPARATION_MUST_NOT_OPEN_MANAGEMENT'); };
  const handle = createHandler(service);
  const call = async (name, args = {}) => (await handle({ method: 'tools/call', params: { name, arguments: args } })).structuredContent;
  const p = profile(service, '管理衔接设备', 'management-handoff');
  const args = { target: { kind: 'local', profile_id: p.id }, qubo: clone(MODEL), solver_options: {} };
  const listed = await call('isingq_solver_targets_list', { include_cloud: false });
  const expected = listed.data.local.management;
  assert.equal(expected.tool, 'isingq_solver_config_open');
  for (const task_mode of [undefined, 1]) {
    args.solver_options = task_mode === undefined ? {} : { task_mode };
    const response = await call('isingq_target_solve_prepare', args);
    assert.equal(response.ok, true);
    assert.equal(response.data.ready, true);
    assert.deepEqual(response.data.local?.management, expected);
    assert.match(response.data.confirmation_note, /先添加／管理本地求解器/);
    assert.match(response.data.confirmation_note, /确认提交.*暂不提交/);
    assert.deepEqual(response.data.solver_options, { task_mode: task_mode ?? 2 });
    response.data.local.management.arguments.mutated_by_client = true;
  }
  service.profileDelete(p.id);
  const stale = await call('isingq_target_solve_prepare', args);
  assert.equal(stale.data.ready, false);
  assert.deepEqual(stale.data.local.management, expected);
  assert.deepEqual(args.qubo, MODEL);
  assert.deepEqual(args.solver_options, { task_mode: 1 });
  assert.equal(opened, 0); assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
  const cloud = await call('isingq_target_solve_prepare', { target: CLOUD, qubo: MODEL, solver_options: OPTIONS });
  assert.equal(cloud.data.local, undefined);
});

test('indistinguishable quantized and heuristic provider worlds retain unknown result interpretation in actual MCP and history', async t => {
  // These are two deliberately constructed provider hypotheses, not claims
  // about any real device. The quantized variant reports original-QUBO energy
  // after choosing a vector under different internal coefficients.
  const qubo = { num_bits: 2, linear: [{ index: 0, coefficient: -1.4 }, { index: 1, coefficient: -1.49 }], quadratic: [{ i: 0, j: 1, coefficient: 3 }], offset: 7, variables: [] };
  const value = (bits, coefficients) => coefficients[0] * bits[0] + coefficients[1] * bits[1] + coefficients[2] * bits[0] * bits[1];
  const original = [-1.4, -1.49, 3], quantized = original.map(Math.round);
  const candidates = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const chosenWithQuantization = candidates.reduce((best, bits) => value(bits, quantized) < value(best, quantized) ? bits : best);
  const heuristicWithoutQuantization = [1, 0];
  assert.notDeepEqual(original, quantized);
  assert.deepEqual(chosenWithQuantization, heuristicWithoutQuantization);
  assert.ok(value([0, 1], original) < value(heuristicWithoutQuantization, original), 'observed candidate is suboptimal under the original model');
  const worlds = [chosenWithQuantization, heuristicWithoutQuantization].map(bits => ({ status: 'succeeded', provider_status: 2, bits, energy: value(bits, original) }));
  assert.deepEqual(worlds[0], worlds[1], 'vector and provider energy cannot distinguish the internal pipelines');
  for (const kind of ['local', 'cloud']) for (const [world, observed] of worlds.entries()) await t.test(kind + '/' + world, async t => {
    const { service, state, store, environment, targetOptions } = harness(t);
    state.executionMode = 'live'; state.probeConfig.maxPrecision = '8bit';
    const p = kind === 'local' ? service.profileSave({ name: 'isolated result fixture', api_base_url: 'http://127.0.0.1:65530/result-fixture' }) : null;
    const target = p ? { kind, profile_id: p.id } : CLOUD;
    const solver_options = p ? { task_mode: 1 } : OPTIONS;
    const args = await prepared(service, { target, qubo, solver_options });
    const run = await service.startTarget(args);
    state.observations.push(clone(observed));
    const done = await service.poll(run.solve_id);
    const storedBeforeRead = fs.readFileSync(store.path(run.solve_id));
    const { createHandler } = require('../src/server');
    const handle = createHandler(new SolverService({ store: new SolveStore(environment), targetOptions }));
    const read = async (name, args) => (await handle({ method: 'tools/call', params: { name, arguments: args } })).structuredContent.data;
    const historical = await read('isingq_solve_result_get', { solve_id: run.solve_id });
    const listed = await read('isingq_solve_records_list', {});
    for (const result of [done, historical, listed.records[0]]) {
      assert.equal(result.result_interpretation?.provider_internal_processing, 'unknown');
      assert.equal(result.result_interpretation?.provider_fault_cause, 'undetermined');
      assert.equal(result.result_interpretation?.energy_agreement_scope, 'single_candidate_value_only');
      assert.equal(result.result_interpretation?.automatic_remodeling_authorized, false);
      assert.equal(result.result_interpretation?.business_feasibility, 'not_assessed_by_core');
      assert.equal(result.status, 'succeeded'); assert.deepEqual(result.result.bits, observed.bits);
      assert.equal(result.result.provider_energy, observed.energy);
      assert.equal(result.result.objective_value, observed.energy + qubo.offset);
      assert.equal(result.result.offset, qubo.offset); assert.equal(result.matrix.sha256, done.matrix.sha256);
      assert.deepEqual(result.solver_options, done.solver_options); assert.deepEqual(result.billing, done.billing);
      assert.deepEqual(result.provenance, done.provenance);
    }
    assert.deepEqual(store.get(run.solve_id).qubo, qubo);
    assert.deepEqual(fs.readFileSync(store.path(run.solve_id)), storedBeforeRead, 'historical evidence projection must not rewrite the record');
    assert.equal(state.submits.length, 1);
  });
});

test('local omitted and explicit precise options share preparation basis and idempotency while historic balanced remains exact', async t => {
  const { service, state, store } = harness(t);
  const p = profile(service, '默认精准设备', 'precise-default');
  const target = { kind: 'local', profile_id: p.id };
  const input = { target, qubo: clone(MODEL) };
  const implicit = await service.prepareTarget(input);
  assert.equal(implicit.ready, true, JSON.stringify(implicit.issues));
  const empty = await service.prepareTarget({ ...input, solver_options: {} });
  const explicit = await service.prepareTarget({ ...input, solver_options: { task_mode: 2 } });
  assert.deepEqual(implicit.solver_options, { task_mode: 2 });
  assert.equal(implicit.preparation_token, empty.preparation_token);
  assert.equal(implicit.preparation_token, explicit.preparation_token);
  const args = { ...input, preparation_token: implicit.preparation_token, model_summary: 'isolated default', idempotency_key: 'default-equivalent' };
  const submitted = await service.startTarget(args);
  for (const solver_options of [{}, { task_mode: 2 }]) {
    const replay = await service.startTarget({ ...args, solver_options });
    assert.equal(replay.solve_id, submitted.solve_id);
    assert.deepEqual(replay.solver_options, { task_mode: 2 });
  }
  assert.equal(state.submits.length, 1); assert.deepEqual(state.submits[0].options, { task_mode: 2 });
  const balanced = await service.startTarget(await prepared(service, { target, solver_options: { task_mode: 1 } }).then(args => ({ ...args, idempotency_key: 'historic-balanced' })));
  const bytes = fs.readFileSync(store.path(balanced.solve_id));
  const handle = require('../src/server').createHandler(service);
  for (const name of ['isingq_solve_result_get', 'isingq_solve_poll']) {
    const receipt = (await handle({ method: 'tools/call', params: { name, arguments: { solve_id: balanced.solve_id } } })).structuredContent.data;
    assert.deepEqual(receipt.solver_options, { task_mode: 1 });
  }
  assert.deepEqual(store.get(balanced.solve_id).solver_options, { task_mode: 1 });
  // A status query may update the record; reading a cached result must not.
  const latest = fs.readFileSync(store.path(balanced.solve_id)); service.get(balanced.solve_id);
  assert.deepEqual(fs.readFileSync(store.path(balanced.solve_id)), latest);
  assert.ok(bytes.length > 0);
  const localPrepared = (await handle({ method: 'tools/call', params: { name: 'isingq_target_solve_prepare', arguments: { ...input, solver_options: {} } } })).structuredContent;
  assert.equal(localPrepared.data.ready, true); assert.deepEqual(localPrepared.data.solver_options, { task_mode: 2 });
  for (const solver_options of [{}, { post_process: 1 }, { use_credit: false }, { task_mode: 2 }]) {
    const cloud = await service.prepareTarget({ target: CLOUD, qubo: MODEL, solver_options });
    assert.equal(cloud.ready, false, 'local defaults must not relax paid-cloud options');
  }
  assert.equal(state.submits.length, 2);
});

test('local prepare supplies a complete normal presentation alongside unchanged audits/basis for ready and blocked MCP consumers', async t => {
  const { service, state } = harness(t);
  const handle = require('../src/server').createHandler(service);
  const call = async args => (await handle({ method: 'tools/call', params: { name: 'isingq_target_solve_prepare', arguments: args } })).structuredContent.data;
  const p = profile(service, '本地展示设备', 'presentation');
  const input = { target: { kind: 'local', profile_id: p.id }, qubo: clone(MODEL), solver_options: {} };
  service.openTargetConfig = () => { throw Error('PREPARE_MUST_NOT_OPEN_MANAGEMENT'); };
  const ready = await call(input);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.solver_options, { task_mode: 2 });
  const explicit = await call({ ...input, solver_options: { task_mode: 2 } });
  assert.equal(explicit.preparation_token, ready.preparation_token);
  const changed = service.profileSave({ ...p, contract: { ...p.contract, coefficient_min: 0 } });
  const blocked = await call(input);
  assert.equal(blocked.ready, false);
  assert.ok(changed.revision > p.revision);
  for (const result of [ready, blocked]) {
    const presentation = result.presentation;
    assert.ok(presentation, 'final preparation response must carry normal fields and all three action branches');
    assert.equal(presentation.contract_version, 'isingq-local-preparation-presentation-v1');
    assert.equal(presentation.audience, 'normal_user');
    assert.equal(presentation.show_solver_mode, false);
    assert.equal(presentation.show_server_postprocessing, false);
    assert.equal(presentation.requires_current_task_authorization, true);
    assert.equal(presentation.preparation_proves_authorization, false);
    assert.deepEqual(presentation.actions.map(action => action.id), ['confirm_submit', 'manage_local_solvers', 'defer']);
    assert.equal(presentation.actions[0].enabled, result.ready);
    assert.equal(presentation.actions[0].requires_current_task_authorization, true);
    assert.equal(presentation.actions[1].tool, result.local.management.tool);
    assert.equal(presentation.actions[1].creates_task, false);
    assert.equal(presentation.actions[2].creates_task, false);
    assert.equal(presentation.summary.business_scope_source, 'host_current_task');
    assert.equal(presentation.summary.selected_target.name, p.name);
    assert.equal(presentation.summary.data_egress.destination_api_base_url, p.api_base_url);
    assert.equal(presentation.summary.data_egress.preparation_uploads_matrix, false);
    assert.equal(presentation.summary.data_egress.matrix_sent_only_after_confirmation, true);
    assert.equal(presentation.summary.device_occupancy.status, 'not_started');
    assert.equal(presentation.summary.readiness.ready, result.ready);
    assert.doesNotMatch(JSON.stringify(presentation.summary), /task_mode|精准|均衡|快速|CPU|后处理/);
    assert.ok(presentation.audit_only_fields.includes('solver_options'));
    assert.ok(presentation.audit_only_fields.includes('preparation_token'));
    assert.deepEqual(presentation.summary.readiness.issues, result.issues);
  }
  ready.presentation.actions[1].arguments.mutated = true;
  const fresh = await call(input);
  assert.deepEqual(fresh.presentation.actions[1].arguments, {});
  const cloud = await call({ target: CLOUD, qubo: MODEL, solver_options: OPTIONS });
  assert.equal(cloud.presentation, undefined);
  assert.equal(state.submits.length, 0); assert.equal(service.listRuns().total, 0);
  assert.deepEqual(input.qubo, MODEL);
});
