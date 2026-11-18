'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const { IsingQTransport } = require('../packages/core/src/isingq');
const { roots } = require('../packages/core/src/store');
const manager = require('../packages/core/src/target-config-page');
const { publicSession } = require('../packages/core/src/target-config-lifecycle');
const { loadNativeDsh } = require('../test-support/native-dsh');

const localOrigin = 'http://dsh-contract.test';
const qubo = { num_bits: 2, linear: [{ index: 0, coefficient: -1 }] };

function isolate(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-dsh-contract-'));
  const overrides = {
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_DATA_HOME: path.join(directory, 'data'),
    LOCALAPPDATA: path.join(directory, 'appdata'),
    ISINGQ_UPDATE_CHECK: 'off',
    ISINGQ_API_KEY: 'dsh-contract-test-key',
  };
  const original = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const dispatcher = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  t.after(async () => {
    setGlobalDispatcher(dispatcher);
    await mock.close();
  });
  return mock;
}

async function nativeDsh(t) {
  const tools = await loadNativeDsh(t);
  let sequence = 0;
  const passed = new Set();
  async function execute(name, args = {}) {
    return tools.execute({
      name, arguments: args, callId: 'contract-' + (++sequence), signal: AbortSignal.timeout(5000),
    });
  }
  return {
    names: [...tools.view().visible.keys()].sort(),
    passed,
    execute,
    async call(name, args) {
      const result = await execute(name, args);
      assert.equal(result.isError, false, name + ': ' + (result.error?.message || ''));
      assert.deepEqual(JSON.parse(result.content[0].text), result.value, name + ' render');
      passed.add(name);
      return result.value;
    },
  };
}

function mockLocalProbe(mock, precision = { maxPrecision: '8bit' }) {
  const pool = mock.get(localOrigin);
  for (const [url, data] of [
    ['/api/device/config', { deviceName: 'DSH fixture', version: '1', maxScale: 16, ...precision }],
    ['/api/device/runtime', { bootTimestamp: 1 }],
    ['/api/device/status', { status: 'stable' }],
  ]) pool.intercept({ method: 'POST', path: url }).reply(200, { code: 10000, data }).persist();
  return pool;
}

test('native DSH receives binary and spin preparation through its lossless output boundary', async t => {
  const mock = isolate(t);
  mockLocalProbe(mock);
  const dsh = await nativeDsh(t);
  for (const [domain, contract] of [
    ['binary', undefined],
    ['spin', { result_domain: 'spin', spin_to_bit: 'plus_is_one' }],
  ]) {
    const profile = await dsh.call('isingq_solver_profiles_save', {
      profile: { name: domain, api_base_url: localOrigin, ...(contract ? { contract } : {}) },
    });
    const preparation = await dsh.call('isingq_target_solve_prepare', {
      target: { kind: 'local', profile_id: profile.id },
      qubo, solver_options: {},
    });
    assert.equal(preparation.ready, true, JSON.stringify(preparation.issues));
    assert.equal(preparation.target.device_capabilities.maxPrecision, '8bit');
    assert.equal(preparation.encoding.result_domain, domain);
    assert.equal(Object.hasOwn(preparation.encoding, 'spin_to_bit'), domain === 'spin');
    if (domain === 'spin') assert.equal(preparation.encoding.spin_to_bit, 'plus_is_one');
  }
});

test('native DSH can prepare when local device display precision is absent', async t => {
  mockLocalProbe(isolate(t), {});
  const dsh = await nativeDsh(t);
  const profile = await dsh.call('isingq_solver_profiles_save', {
    profile: { name: 'no precision reported', api_base_url: localOrigin },
  });
  const preparation = await dsh.call('isingq_target_solve_prepare', {
    target: { kind: 'local', profile_id: profile.id }, qubo, solver_options: {},
  });
  assert.equal(preparation.ready, true);
  assert.equal(Object.hasOwn(preparation.target.device_capabilities, 'maxPrecision'), false);
  assert.equal(preparation.precision.reported_max_precision, null);
});

test('native DSH checks arguments, result values and rendered content for every registered tool', async t => {
  const mock = isolate(t);
  const windowsRoot = path.join(path.dirname(process.env.XDG_CONFIG_HOME), 'appdata', 'isingq-mcp');
  const windows = roots(process.env, 'win32');
  assert.ok(windows.config === windowsRoot && windows.data === windowsRoot, 'Windows fixture storage must use the test directory');
  const local = mockLocalProbe(mock);
  const task = 'local-contract-task';
  local.intercept({ method: 'POST', path: '/api/task/create' }).reply(200, {
    code: 10000, data: { status: 'success', taskId: task },
  });
  local.intercept({ method: 'POST', path: '/api/task/detail' }).reply(200, {
    code: 10000, data: { taskId: task, status: 'pending' },
  });
  local.intercept({ method: 'POST', path: '/api/task/detail' }).reply(200, {
    code: 10000, data: { taskId: task, status: 'finished' },
  }).persist();
  local.intercept({ method: 'POST', path: '/api/task/result' }).reply(200, { code: 10021, data: {} });
  local.intercept({ method: 'POST', path: '/api/task/result' }).reply(200,
    '{"code":10000,"data":{"ok":true,"spin_config":[1,-0],"energy":-0,"isingCalcMs":-0}}');

  const cloud = mock.get('https://api.isingq.com');
  cloud.intercept({ method: 'GET', path: '/public/computer-types' }).reply(200, {
    schemaVersion: 1,
    uploadLimits: { maxCsvBytes: 10000 },
    computerTypes: [
      { id: 7, name: '未声明能力', price: 20, computeCreditCost: 1, spinNumber: '16', executionCapabilities: null },
      { id: 8, name: '固定后处理', price: 20, computeCreditCost: 1, spinNumber: '16',
        executionCapabilities: { problemTypes: ['qubo'], inputFormats: ['csv'],
          minDimension: 1, maxDimension: 16, maxCalculateCount: 1, supportsH: false, fixedPostProcess: 1 } },
    ],
  }).persist();
  mock.get('https://registry.npmjs.org').intercept({
    method: 'GET', path: '/@ising-tech%2fisingq-mcp/latest',
  }).reply(200, { name: '@ising-tech/isingq-mcp', version: '9.0.0' });
  const legacySubmit = t.mock.method(IsingQTransport.prototype, 'submit', async () => ({ task_id: 'legacy-contract-task' }));
  cloud.intercept({ method: 'GET', path: '/tasks/legacy-contract-task' }).reply(200,
    '{"status":2,"result":{"bits":[1,-0],"energy":-0}}');
  t.mock.method(manager, 'launchTargetConfig', async () => publicSession({
    origin: 'http://127.0.0.1:12345', token: 'fixture-token', pid: 1, cloud_environment: 'prod', internal_preview: false,
    idle_timeout_ms: 1800000, foreground_lease_ms: 30000, heartbeat_ms: 5000,
  }));

  const dsh = await nativeDsh(t);
  for (const [name, args] of [
    ['isingq_qubo_validate', {}],
    ['isingq_qubo_validate', { qubo: { offset: null } }],
    ['isingq_api_key_setup', { force: 'false' }],
    ['isingq_knowledge_get', { topic: 'not-a-topic' }],
    ['isingq_target_solve_prepare', { target: { kind: 'invalid' }, qubo, solver_options: {} }],
  ]) {
    const result = await dsh.execute(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.error.info?.code, 'INVALID_ARGS', name + ': ' + result.error.message);
  }
  const invalidTerm = await dsh.execute('isingq_qubo_validate', { qubo: { num_bits: 2, linear: [{ index: 0 }] } });
  assert.equal(invalidTerm.isError, true);
  assert.match(invalidTerm.error.message, /linear\[0\]\.coefficient/);
  assert.equal((await dsh.call('isingq_api_key_setup')).status, 'already_configured');
  assert.equal((await dsh.call('isingq_update_check')).status, 'update_available');
  assert.equal((await dsh.call('isingq_knowledge_get', { topic: 'company', locale: 'zh-CN' })).topic, 'company');
  await dsh.call('isingq_modeling_guide_get', { problem_summary: '两变量模型' });
  assert.equal((await dsh.call('isingq_qubo_validate', { qubo: { ...qubo, offset: null } })).num_bits, 2);
  const resources = await dsh.call('isingq_resource_list');
  assert.ok(resources.length > 0);
  await dsh.call('isingq_resource_read', { uri: resources[0].uri });
  const managerSession = await dsh.call('isingq_solver_config_open');
  assert.equal(managerSession.idle_deadline_at, null);
  assert.equal(managerSession.cloud_environment, 'prod');
  assert.equal((await dsh.call('isingq_delivery_validate', { document: { qubo, candidate_bits: [1, 0] } })).summary.candidate_objective_value, -1);
  const report = await dsh.call('isingq_report_verify', { document: {
    report_contract_version: 'isingq-verified-report-v1',
    model: { schema_version: 'math-model-v1', id: 'dsh-contract', variables: [{ id: 'x', domain: 'binary' }],
      objective: { sense: 'min', expression: { terms: [{ coefficient: -1, variables: ['x'] }] } }, constraints: [] },
    data: {}, candidates: [{ id: 'measured', assignment: { x: 1 } }],
  } });
  assert.equal(report.ranking[0].objective_value, -1);

  const profile = await dsh.call('isingq_solver_profiles_save', { profile: { name: 'fixture', api_base_url: localOrigin } });
  assert.deepEqual((await dsh.call('isingq_solver_profiles_list')).profiles.map(entry => entry.id), [profile.id]);
  await dsh.call('isingq_solver_targets_list', { qubo });
  const cloudInput = { target: { kind: 'cloud', environment: 'prod', computer_type_id: 8 }, qubo };
  assert.equal((await dsh.call('isingq_target_solve_prepare', { ...cloudInput, solver_options: { post_process: 0, use_credit: false } })).ready, false);
  assert.equal((await dsh.call('isingq_target_solve_prepare', { ...cloudInput, solver_options: { post_process: 1, use_credit: false } })).ready, true);
  assert.equal((await dsh.call('isingq_target_solve_prepare', {
    ...cloudInput, target: { ...cloudInput.target, computer_type_id: 7 }, solver_options: { post_process: 1, use_credit: false },
  })).ready, false);

  const legacy = await dsh.call('isingq_solve_start', {
    qubo, model_summary: 'legacy', idempotency_key: 'legacy-contract',
    solver_options: { computer_type_id: 8, post_process: true, use_credit: false },
  });
  assert.equal(legacy.provenance.provider_task_id, 'legacy-contract-task');
  assert.equal(legacySubmit.mock.callCount(), 1);
  const legacyResult = await dsh.call('isingq_solve_poll', { solve_id: legacy.solve_id });
  assert.equal(legacyResult.status, 'succeeded');
  assert.equal(legacyResult.result.provider_energy, 0);
  assert.deepEqual(legacyResult.result.bits, [1, 0]);

  const input = { target: { kind: 'local', profile_id: profile.id }, qubo, solver_options: {} };
  const preparation = await dsh.call('isingq_target_solve_prepare', input);
  assert.equal(preparation.ready, true);
  const confirmation = { ...input, model_summary: 'two bits', idempotency_key: 'local-contract',
    preparation_token: preparation.preparation_token };
  const started = await dsh.call('isingq_target_solve_start', confirmation);
  assert.equal(started.provenance.provider_task_id, task);
  assert.equal((await dsh.call('isingq_target_solve_start', confirmation)).solve_id, started.solve_id);
  const solveId = { solve_id: started.solve_id };
  assert.equal((await dsh.call('isingq_solve_poll', solveId)).status, 'queued');
  assert.equal((await dsh.call('isingq_solve_poll', solveId)).status, 'result_pending');
  const solved = await dsh.call('isingq_solve_poll', solveId);
  assert.equal(solved.status, 'succeeded');
  assert.equal(solved.result.provider_energy, 0);
  assert.equal(solved.result.isingCalcMs, 0);
  assert.deepEqual((await dsh.call('isingq_solve_result_get', solveId)).result.bits, [1, 0]);
  const delivered = await dsh.call('isingq_target_delivery_validate', { ...solveId, document: { qubo, candidate_bits: [1, 0] } });
  assert.equal(delivered.summary.candidate_objective_value, -1);
  assert.equal((await dsh.call('isingq_solver_profiles_delete', { profile_id: profile.id })).deleted, true);
  const history = await dsh.call('isingq_solve_records_list', { limit: 10 });
  assert.deepEqual(new Set(history.records.map(row => row.solve_id)), new Set([started.solve_id, legacy.solve_id]));
  assert.deepEqual([...dsh.passed].sort(), dsh.names, 'each registered tool needs a successful native contract check');
});

test('native DSH keeps an uncertain submission queryable and prevents a second create', async t => {
  const pool = mockLocalProbe(isolate(t));
  let creates = 0;
  pool.intercept({ method: 'POST', path: '/api/task/create' }).reply(() => {
    creates += 1;
    return { statusCode: 500, data: { code: 10030, msg: 'fixture-private-provider-body' } };
  }).persist();
  const dsh = await nativeDsh(t);
  const profile = await dsh.call('isingq_solver_profiles_save', { profile: { name: 'uncertain', api_base_url: localOrigin } });
  const input = { target: { kind: 'local', profile_id: profile.id }, qubo, solver_options: {} };
  const ready = await dsh.call('isingq_target_solve_prepare', input);
  const start = { ...input, model_summary: 'uncertain result', idempotency_key: 'uncertain-contract',
    preparation_token: ready.preparation_token };
  for (const attempt of [start, start]) {
    const rejected = await dsh.execute('isingq_target_solve_start', attempt);
    assert.equal(rejected.isError, true);
    assert.notEqual(rejected.error.info?.code, 'INVALID_TOOL_OUTPUT');
    assert.doesNotMatch(rejected.error.message, /fixture-private-provider-body/);
  }
  assert.equal(creates, 1);
  const { records } = await dsh.call('isingq_solve_records_list');
  assert.equal(records.length, 1);
  const kept = await dsh.call('isingq_solve_result_get', { solve_id: records[0].solve_id });
  assert.equal(kept.status, 'submission_unknown');
  assert.equal(kept.provenance.provider_task_id, null);
  assert.equal(kept.recovery.action, 'reconcile_externally');
});
