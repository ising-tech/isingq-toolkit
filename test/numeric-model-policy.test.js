'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler: createMcpHandler } = require('../src/server');
const createHandler = (service, options = {}) => createMcpHandler(service, { ...options, tools_profile: 'technical' });
const { modelingGuide } = require('../packages/core/src/modeling');
const { prepareLocalTarget } = require('../packages/core/src/local-target');
const { matrixDocument } = require('../packages/core/src/qubo');

const handle = createHandler(new Proxy({}, { get() { throw Error('GUIDANCE_MUST_NOT_ACCESS_SOLVER'); } }));
async function surfaces() {
  const [init, guide, resource, tools] = await Promise.all([
    handle({ method: 'initialize' }),
    handle({ method: 'tools/call', params: { name: 'isingq_modeling_guide_get', arguments: {} } }),
    handle({ method: 'resources/read', params: { uri: 'isingq://modeling/qubo' } }),
    handle({ method: 'tools/list' }),
  ]);
  return { init: init.instructions, guide: guide.structuredContent.data, resource: resource.contents[0].text, tools: tools.tools };
}

test('public numerical/model policy distinguishes provider unknowns from client conversion prerequisites across MCP consumers', async () => {
  const { init, guide, resource, tools } = await surfaces();
  const policy = guide.numeric_model_policy;
  assert.ok(policy, 'runtime must expose one canonical numerical/model policy');
  assert.deepEqual(policy, modelingGuide().numeric_model_policy);
  assert.deepEqual(policy.applies_to, ['cloud', 'local']);
  assert.equal(policy.infer_coefficient_range_from_bit_precision, false);
  assert.equal(policy.undeclared_limits_block_standard_preparation, false);
  assert.equal(policy.automatic_client_numeric_transformation, false);
  assert.equal(policy.speculative_model_changes_allowed, false);
  assert.equal(policy.ready_proves_lossless_precision, false);
  assert.equal(policy.initial_model_construction_allowed, true);
  for (const text of [init, resource, guide.required_sequence.join('\n')]) {
    assert.ok(text.includes(policy.description));
    assert.match(text, /maxPrecision=8bit.*不.*(?:±127|范围)/);
    assert.match(text, /未声明.*未知.*不.*(?:不兼容|阻断)/);
    assert.match(text, /不要求.*用户.*(?:完整|硬件).*算法/);
    assert.match(text, /不.*(?:猜测|推断).*修改.*(?:罚权|惩罚权重)/);
    assert.match(text, /离线量化.*独立实验.*不.*设备能力证据/);
    assert.match(text, /拒绝.*结果异常.*原矩阵.*记录.*不自动.*重提/);
    assert.match(text, /首次.*(?:惩罚权重|罚权).*允许/);
    assert.match(text, /重新.*prepare.*适用确认/);
    assert.match(text, /ready.*不证明.*(?:无损|精度)/);
  }
  for (const name of ['isingq_solver_targets_list', 'isingq_target_solve_prepare', 'isingq_target_solve_start']) {
    assert.ok(tools.find(tool => tool.name === name).inputSchema.properties.qubo.description.includes(policy.description));
  }
});

const basic = { name: 'isolated standard fixture', api_base_url: 'http://fixture.test:8080' };
const probe = { config: { deviceName: 'fixture', version: 'fixture-1', maxScale: 32, maxPrecision: '8bit' }, runtime: {}, status: { status: 'stable' } };
function originalMatrix() {
  return matrixDocument({ num_bits: 2, linear: [{ index: 0, coefficient: 1024.125 }, { index: 1, coefficient: -0.000125 }], quadratic: [{ i: 0, j: 1, coefficient: -300.5 }], offset: 7.25, variables: [{ index: 0, name: 'x', meaning: 'original business variable' }] });
}

test('8bit plus undeclared coefficient rules preserves large and fractional standard QUBO without requiring internals', () => {
  const original = originalMatrix();
  const snapshot = JSON.stringify(original.qubo), csv = original.content.toString();
  const prepared = prepareLocalTarget(original, basic, probe, { task_mode: 2 });
  assert.equal(prepared.file.content.toString(), csv);
  assert.equal(JSON.stringify(original.qubo), snapshot);
  assert.equal(prepared.encoding.offset, 7.25);
  assert.equal(prepared.precision.reported_max_precision, '8bit');
  assert.equal(prepared.precision.client_quantization, 'none');
  assert.equal(prepared.precision.lossless_guaranteed, false);
  for (const field of ['coefficient_min', 'coefficient_max', 'coefficient_step', 'integer_coefficients']) {
    assert.equal(prepared.declared_constraints[field].status, 'not_declared');
  }
});

test('actual declared range/grid, maxScale and client file limits still reject without rewriting the input', () => {
  const original = originalMatrix();
  const snapshot = JSON.stringify(original.qubo), csv = original.content.toString();
  for (const contract of [{ coefficient_max: 127 }, { coefficient_min: -127 }, { integer_coefficients: true }, { coefficient_step: 0.1 }]) {
    assert.throws(() => prepareLocalTarget(original, { ...basic, contract }, probe, { task_mode: 1 }), { code: 'local_coefficient_invalid' });
  }
  assert.throws(() => prepareLocalTarget(original, basic, { ...probe, config: { ...probe.config, maxScale: 1 } }, { task_mode: 1 }), { code: 'local_device_dimension_exceeded' });
  assert.throws(() => prepareLocalTarget(original, basic, probe, { task_mode: 1 }, { environment: { ISINGQ_MAX_LOCAL_FILE_BYTES: '2' } }), { code: 'local_client_file_too_large' });
  assert.equal(original.content.toString(), csv);
  assert.equal(JSON.stringify(original.qubo), snapshot);
});
