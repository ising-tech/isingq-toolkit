'use strict';
process.env.ISINGQ_UPDATE_CHECK = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SolverService } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { createHandler } = require('../src/server');
const qubo = { num_bits: 2, linear: [{ index: 0, coefficient: -1 }] };
const confirm = output => output.actions.find(a => a.call.arguments.action === 'confirm').call.arguments;
function fixture(t, local = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-advice-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_DATA_HOME: path.join(directory, 'data') };
  const capability = { problemTypes: ['qubo'], minDimension: 1, maxDimension: 32, inputFormats: ['csv'], maxCalculateCount: 2, fixedPostProcess: 1, supportsH: false };
  const catalog = { schemaVersion: 1, uploadLimits: { maxCsvBytes: 1048576 }, computerTypes: [
    { id: 1, name: '适配', price: 0, computeCreditCost: 0, spinNumber: 'untrusted display text', executionCapabilities: capability },
    { id: 2, name: '超限', price: 0, computeCreditCost: 0, spinNumber: 'untrusted display text', executionCapabilities: { ...capability, maxDimension: 1 } },
    { id: 3, name: '未知', price: 0, computeCreditCost: 0, spinNumber: 'untrusted display text', executionCapabilities: null },
  ] };
  const state = { reads: 0, submits: [], adviceMissing: false };
  const service = new SolverService({ store: new SolveStore(environment), targetOptions: { environment,
    catalogClientFactory: () => ({ get: async () => { state.reads++; if (local) throw Error('local must not read cloud'); return structuredClone(catalog); } }),
    recommendCloud: (...args) => state.adviceMissing ? [] : require('../packages/core/src/cloud-target').recommendCloudTargets(...args),
    localTransportFactory: () => ({ prepareSubmission: () => ({}), probe: async () => ({ config: { maxScale: 32 }, runtime: { bootTimestamp: 1 }, status: { status: 'stable' } }), submit: async (_file, options) => { state.submits.push(options); return { task_id: 'local-fixture' }; } }),
    cloudTransportFactory: () => ({ prepareSubmission: () => ({}), submit: async (_file, options) => { state.submits.push(options); return { task_id: 'cloud-fixture' }; } }),
  } });
  const prepareTarget = service.prepareTarget.bind(service);
  service.prepareTarget = async args => {
    const value = await prepareTarget(args);
    // Simulate optional advice disappearing after the real independent check.
    if (state.adviceMissing) value.advice = [];
    return value;
  };
  if (local) service.profileSave({ name: '本地', api_base_url: 'http://fixture.test' });
  const handler = createHandler(service);
  const call = async args => (await handler({ method: 'tools/call', params: { name: 'isingq_solve', arguments: args } })).structuredContent.data;
  return { service, call, state, catalog };
}
test('ordinary MCP projects real catalogue recommendations, scale mismatch and null capability without filtering options', async t => {
  const f = fixture(t);
  assert.equal((await createHandler(f.service)({ method: 'tools/list' })).tools.length, 4);
  const raw = await f.service.listTargets({ qubo, solver_options: { calculate_count:1, post_process:1 } });
  assert.deepEqual(raw.cloud.advice.map(a => a.computer_type_id), [1], 'fixture must use valid real recommendation producer');
  const p = await f.call({ action: 'prepare', qubo, problem_summary: '普通选择' });
  assert.equal(p.status, 'needs_target'); assert.equal(p.targets.length, 3);
  assert.equal(p.targets[0].guidance.recommended, true);
  assert.equal(p.targets[0].guidance.model_variables, 2);
  assert.ok(p.targets[0].guidance.reasons.some(x => x.includes('实际矩阵2维')));
  assert.equal(p.targets[1].guidance.capacity.matches_known_limits, false);
  assert.equal(p.targets[1].guidance.recommended, false);
  assert.equal(p.targets[2].guidance.capacity.matches_known_limits, null);
  assert.equal(p.targets[2].guidance.recommended, false);
  assert.match(p.reply, /适配.*建议/); assert.match(p.reply, /超限.*不符合/); assert.match(p.reply, /未知.*未核实/);
  assert.equal(f.state.reads, 2); assert.equal(f.state.submits.length, 0);
  for (const name of ['超限', '未知']) {
    const blocked = await f.call(p.targets.find(x => x.name === name).call.arguments);
    assert.equal(blocked.ready, false); assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.suggestions[0].guidance.capacity.matches_known_limits, name === '超限' ? false : null);
  }
  const selected = await f.call(p.targets[0].call.arguments);
  assert.equal(selected.ready, true); assert.equal(selected.suggestions[0].name, '适配');
  assert.equal(selected.suggestions[0].guidance.recommended, true);
  assert.match(selected.reply, /适配.*建议/);
  const oldConfirm = confirm(selected);
  f.state.adviceMissing = true;
  const refreshed = await f.call({ action: 'refresh', request_id: oldConfirm.request_id });
  assert.deepEqual(confirm(refreshed), oldConfirm, 'advice-only refresh must preserve confirmation');
  assert.equal(refreshed.suggestions[0].guidance.recommended, false, 'advice may change without changing prepared content');
  const run = await f.call(oldConfirm); assert.equal(run.status, 'submitted'); assert.equal(f.state.submits.length, 1);
  t.diagnostic(JSON.stringify({ raw_advice:raw.cloud.advice, ordinary:{targets:p.targets,reply:p.reply}, selected:{suggestions:selected.suggestions,reply:selected.reply}, advice_only_confirmation_preserved:true, refreshed_recommended:refreshed.suggestions[0].guidance.recommended, submits:f.state.submits.length }));
});
for (const fixed of [0, 1, null]) test(`initial advice and preparation agree for declared fixed processing ${fixed}`, async t => {
  const f = fixture(t);
  f.catalog.computerTypes[0].executionCapabilities.fixedPostProcess = fixed;
  const raw = await f.service.listTargets({ qubo });
  assert.deepEqual(raw.cloud.advice.map(a => a.computer_type_id), [1]);
  const p = await f.call({ action: 'prepare', qubo, problem_summary: '按当前机型要求准备' });
  assert.equal(p.status, 'needs_target');
  assert.equal(p.targets[0].guidance.recommended, true, 'initial advice must not impose a different processing choice');
  assert.equal(f.state.submits.length, 0);
  const selected = await f.call(p.targets[0].call.arguments);
  assert.equal(selected.ready, true);
  assert.equal(selected.suggestions[0].guidance.recommended, true);
  assert.equal(f.state.submits.length, 0, 'recommendation and preparation do not submit');
  assert.doesNotMatch(p.reply + selected.reply, /post_process|fixedPostProcess|solver_options/);
  assert.equal((await f.call(confirm(selected))).status, 'submitted');
  assert.deepEqual(f.state.submits, [{ computer_type_id: 1, question_type: 1, calculate_count: 1, post_process: fixed ?? 1, use_credit: false }]);
});
test('missing optional recommendations neither block compatible selection nor add cloud I/O to local preparation', async t => {
  const cloud = fixture(t); cloud.state.adviceMissing = true;
  const p = await cloud.call({ action: 'prepare', qubo, problem_summary: '忽略建议' });
  assert.equal(p.targets[0].guidance.recommended, false);
  const selected = await cloud.call(p.targets[0].call.arguments);
  assert.equal(selected.ready, true);
  assert.equal((await cloud.call(confirm(selected))).status, 'submitted');
  const local = fixture(t, true);
  const ready = await local.call({ action: 'prepare', qubo, problem_summary: '本地' });
  assert.equal(ready.ready, true); assert.equal(local.state.reads, 0);
  assert.equal((await local.call(confirm(ready))).status, 'submitted');
  assert.deepEqual(local.state.submits, [{ task_mode: 2 }]); assert.equal(local.state.reads, 0);
});
