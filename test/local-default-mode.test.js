'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Response } = require('undici');
const { prepareLocalTarget, LocalSolverTransport } = require('../packages/core/src/local-target');
const { matrixDocument } = require('../packages/core/src/qubo');
const { createHandler: createMcpHandler } = require('../src/server');
const createHandler = (service, options = {}) => createMcpHandler(service, { ...options, tools_profile: 'technical' });

const profile = { name: 'isolated default fixture', api_base_url: 'http://fixture.test:8080' };
const probe = { config: { deviceName: 'fixture', version: '1', maxScale: 16, maxPrecision: '8bit' }, runtime: { bootTimestamp: 1 }, status: { status: 'stable' } };
const matrix = matrixDocument({ num_bits: 1, linear: [{ index: 0, coefficient: -1000.125 }], offset: 3 });

test('local omission defaults deterministically to precise in preparation and direct multipart submission', async () => {
  for (const options of [undefined, {}, { task_mode: undefined }, { task_mode: 2 }]) {
    const prepared = prepareLocalTarget(matrix, profile, probe, options);
    assert.deepEqual(prepared.solver_options, { task_mode: 2 });
    assert.equal(prepared.file.content.toString(), matrix.content.toString());
    const calls = [];
    const transport = new LocalSolverTransport({ profile, fetch: async (_url, request) => {
      calls.push(JSON.parse(request.body.get('param')));
      return new Response(JSON.stringify({ code: 10000, data: { taskId: 'isolated-default', status: 'success' } }), { headers: { 'content-type': 'application/json' } });
    } });
    await transport.submit({ ...prepared.file, task_name: 'isolated-default' }, options);
    assert.equal(calls[0].taskMode, 2);
    assert.equal(prepared.precision.client_quantization, 'none');
    assert.equal(prepared.precision.lossless_guaranteed, false);
  }
});

test('default never overwrites explicit advanced values or accepts null, invalid types or cloud fields', () => {
  for (const task_mode of [0, 1, 2]) assert.deepEqual(prepareLocalTarget(matrix, profile, probe, { task_mode }).solver_options, { task_mode });
  for (const options of [null, [], '2', { task_mode: null }, { task_mode: '2' }, { task_mode: true }, { task_mode: 3 }, { task_mode: 1.5 }, { use_credit: false }, { gear: 2 }]) {
    assert.throws(() => prepareLocalTarget(matrix, profile, probe, options), error => {
      assert.equal(error.code, 'local_options_invalid');
      assert.doesNotMatch(error.message, /请.*选择|必须显式选择/);
      return true;
    });
  }
});

test('MCP exposes precise default as technical policy without restoring a normal mode-selection conversation', async () => {
  const handle = createHandler(new Proxy({}, { get() { throw Error('GUIDANCE_MUST_NOT_CALL_SOLVER'); } }));
  const init = await handle({ method: 'initialize' });
  const guide = (await handle({ method: 'tools/call', params: { name: 'isingq_modeling_guide_get', arguments: {} } })).structuredContent.data;
  const resource = (await handle({ method: 'resources/read', params: { uri: 'isingq://modeling/qubo' } })).contents[0].text;
  const tools = (await handle({ method: 'tools/list' })).tools;
  assert.equal(guide.solver_mode_policy.default, 2);
  assert.equal(guide.solver_mode_policy.ask_user, false);
  assert.equal(guide.solver_mode_policy.show_in_normal_flow, false);
  assert.ok(!guide.confirmation_policy.by_target.local.includes('solver_options'));
  for (const name of ['isingq_solver_targets_list', 'isingq_target_solve_prepare', 'isingq_target_solve_start']) {
    const schema = tools.find(tool => tool.name === name).inputSchema.properties.solver_options;
    assert.ok(!Object.hasOwn(schema.properties.task_mode, 'default'), 'cloud shares this schema; only local Core normalization applies its default');
    assert.deepEqual(schema.properties.task_mode.enum, [0, 1, 2]);
    assert.equal(schema.properties.task_mode.description, guide.solver_mode_policy.description);
  }
  for (const text of [init.instructions, resource, guide.target_guidance.join('\n')]) {
    assert.ok(text.includes(guide.solver_mode_policy.description));
    assert.match(text, /普通业务流程.*不询问.*不.*展示.*模式/);
    assert.match(text, /不.*快点.*0/);
    assert.doesNotMatch(text, /首次缺少模式时.*显式选择|不指定默认|explicit_choice_no_default/);
    assert.match(text, /不保证.*最优/);
  }
});
