'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { modelingGuide } = require('../packages/core/src/modeling');
const { createHandler } = require('../src/server');

function assertPolicy(guide) {
  assert.deepEqual(Object.keys(guide.intent_routes), ['explain', 'model_only', 'local_validate', 'cloud_submit']);
  for (const intent of ['explain', 'model_only', 'local_validate']) {
    assert.equal(guide.intent_routes[intent].cloud_submission, false);
    assert.equal(guide.intent_routes[intent].requires_api_key, false);
  }
  assert.equal(guide.intent_routes.explain.requires_runtime, false);
  assert.equal(guide.intent_routes.model_only.requires_runtime, false);
  assert.equal(guide.intent_routes.local_validate.requires_runtime, true);
  assert.equal(guide.intent_routes.cloud_submit.requires_explicit_authorization, true);
  assert.deepEqual(guide.confirmation_policy.business_summary, ['decision_scope', 'objectives_and_constraints', 'data_egress', 'payment_choice', 'task_execution']);
  assert.equal(guide.confirmation_policy.binding, 'model_sha256_and_solver_options');
  assert.equal(guide.confirmation_policy.requires_matrix_literacy, false);
  assert.equal(guide.confirmation_policy.details, 'on_request_or_technical_delivery');
  assert.equal(guide.data_readiness.symbolic_model.allows_missing_instance_values, true);
  assert.equal(guide.data_readiness.numeric_matrix.requires_validated_instance_values, true);
  assert.equal(guide.data_readiness.cloud_submission.requires_confirmed_model, true);
  assert.equal(guide.data_readiness.block_only_dependent_steps, true);
  assert.equal(guide.data_readiness.repeat_known_questions, false);
  assert.equal(guide.data_readiness.silent_business_defaults, false);
  assert.deepEqual(Object.keys(guide.result_evidence.states), ['candidate', 'feasible', 'proven_optimal', 'proven_infeasible', 'not_found', 'execution_failed']);
  assert.equal(guide.result_evidence.not_found_implies_infeasible, false);
  assert.equal(guide.result_evidence.allows_proven_global_optimum, true);
  assert.equal(guide.result_evidence.implements_business_validator, false);
  assert.equal(guide.result_evidence.nearest_repair_requires, 'distance_and_minimality_proof');
  assert.equal(guide.result_evidence.optimality_gap_requires, 'verified_optimum_or_valid_bound');
  assert.equal(guide.result_evidence.improvement_percent_requires, 'comparable_baseline_scope_and_formula');
  assert.equal(guide.result_evidence.separate_expected_and_realized_benefits, true);
  assert.doesNotMatch(guide.required_sequence.join(' '), /向用户展示矩阵.*取得确认|确认后调用 isingq_solve_start(?!（仅)/);
}

test('I01/I02/I03 local guide exposes conditional intent, staged data and evidence policy', () => {
  const guide = modelingGuide('  排班  ');
  assert.equal(guide.problem_summary, '排班');
  assert.equal(guide.scope, 'local_guidance_only');
  assertPolicy(guide);
});

test('I01/I02/I03 MCP guide consumer returns the same policy without accessing a solver', async () => {
  const service = new Proxy({}, { get() { throw new Error('GUIDE_MUST_NOT_CALL_SOLVER'); } });
  const response = await createHandler(service)({ method: 'tools/call', params: {
    name: 'isingq_modeling_guide_get', arguments: { problem_summary: '排班' },
  } });
  assert.equal(response.structuredContent.ok, true);
  assertPolicy(response.structuredContent.data);
});

test('I02/I03 initialization and advertised tool guidance cannot restore mandatory matrix literacy or implicit cloud flow', async () => {
  const handle = createHandler(new Proxy({}, { get() { throw new Error('GUIDANCE_MUST_NOT_CALL_SOLVER'); } }));
  const initialized = await handle({ method: 'initialize' });
  for (const intent of ['explain', 'model_only', 'local_validate', 'cloud_submit']) assert.ok(initialized.instructions.includes(intent));
  assert.match(initialized.instructions, /后台关联 model_sha256/);
  assert.match(initialized.instructions, /数据外发/);
  assert.doesNotMatch(initialized.instructions, /展示模型摘要与矩阵 SHA-256|缺少 API Key 时，应让用户/);
  const listed = await handle({ method: 'tools/list' });
  const solve = listed.tools.find((tool) => tool.name === 'isingq_solve_start');
  assert.match(solve.description, /用户明确授权当前云任务/);
  assert.match(solve.description, /后台绑定 model_sha256/);
  assert.match(solve.description, /无需读懂矩阵/);
  assert.equal(solve.annotations.destructiveHint, true);
  assert.deepEqual(solve.inputSchema.required, ['qubo', 'model_summary', 'idempotency_key', 'solver_options']);
  assert.doesNotMatch(solve.description, /必须展示模型摘要与矩阵 SHA-256/);
});

test('I01/I02/I03 MCP modeling resource renders canonical guide routes, stages and evidence without cloud-only sequence', async () => {
  const handle = createHandler(new Proxy({}, { get() { throw new Error('RESOURCE_MUST_NOT_CALL_SOLVER'); } }));
  const response = await handle({ method: 'resources/read', params: { uri: 'isingq://modeling/qubo' } });
  const text = response.contents[0].text;
  const guide = modelingGuide();
  for (const name of Object.keys(guide.intent_routes)) assert.ok(text.includes(name), name);
  for (const step of guide.required_sequence) assert.ok(text.includes(step), step);
  for (const [state, evidence] of Object.entries(guide.result_evidence.states)) assert.ok(text.includes(state + '：' + evidence), state);
  assert.match(text, /缺实例值可先做符号模型.*只阻断依赖步骤/);
  assert.match(text, /数据外发.*后台关联 model_sha256/s);
  assert.doesNotMatch(text, /Agent 必须先确认.*输入数据|调用顺序：.*提交求解|展示模型摘要与矩阵 SHA-256/);
});

test('rerun is new task intent and requires a fresh post-summary confirmation across all guidance consumers', async () => {
  const handle = createHandler(new Proxy({}, { get() { throw new Error('GUIDANCE_MUST_NOT_CALL_SOLVER'); } }));
  const initialized = await handle({ method: 'initialize' });
  const listed = await handle({ method: 'tools/list' });
  const solve = listed.tools.find(tool => tool.name === 'isingq_solve_start');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../lhm.plugin.json'), 'utf8'));
  assert.deepEqual(manifest.tools.find(tool => tool.name === solve.name), solve);
  const guide = modelingGuide();
  const resource = await handle({ method: 'resources/read', params: { uri: 'isingq://modeling/qubo' } });
  for (const text of [guide.agent_rules.join(' '), initialized.instructions, solve.description, resource.contents[0].text]) {
    assert.match(text, /再次求解.*重跑.*新任务意图.*最终确认/);
    assert.match(text, /即使.*模型.*参数.*付款.*不变/);
    assert.match(text, /沿用.*变化.*付款来源.*再次消耗/);
    assert.match(text, /询问.*等待.*后续明确确认/);
    assert.match(text, /确认仅用于本次任务/);
    assert.match(text, /poll\/get.*不需要.*新求解确认/);
    assert.match(text, /受理不明.*poll\/get.*本地记录.*控制台.*不重提/);
    assert.match(text, /对话规范.*Host.*不能.*验证.*人类授权/);
  }
  for (const name of ['confirmed', 'confirmed_by_user', 'confirmation_token']) assert.equal(solve.inputSchema.properties[name], undefined);
});

test('setup tool supplies official console instructions before asking the host to open a private prompt', async () => {
  const tools = (await createHandler({})({ method: 'tools/list' })).tools;
  const setup = tools.find(tool => tool.name === 'isingq_api_key_setup');
  assert.match(setup.description, /先.*https:\/\/console\.isingq\.com\/api-keys.*登录.*API Key.*创建.*复制.*再.*安全输入框/);
  assert.match(setup.description, /不得.*对话.*(?:发送|粘贴).*Key/);
  const initialized = await createHandler({})({ method: 'initialize' });
  assert.match(initialized.instructions, /https:\/\/console\.isingq\.com\/api-keys/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../lhm.plugin.json'), 'utf8'));
  assert.deepEqual(manifest.tools.find(tool => tool.name === setup.name), setup);
});

test('execution, billing and local credential effects stay separate in shared and MCP guidance', async () => {
  const handle = createHandler({});
  const initialized = await handle({ method: 'initialize' });
  const tools = (await handle({ method: 'tools/list' })).tools;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../lhm.plugin.json'), 'utf8'));
  for (const name of ['isingq_api_key_setup', 'isingq_solve_start', 'isingq_solve_poll', 'isingq_solve_result_get']) assert.deepEqual(manifest.tools.find(tool => tool.name === name), tools.find(tool => tool.name === name));
  for (const text of [modelingGuide().agent_rules.join(' '), initialized.instructions, tools.find(tool => tool.name === 'isingq_solve_start').description]) {
    assert.match(text, /execution_mode/);
    assert.match(text, /billing.status/);
    assert.match(text, /simulation/);
    assert.match(text, /unknown/);
    assert.match(text, /calculate_count.*succeeded.*不是扣费证据|calculate_count.*succeeded.*均不是扣费证据/);
  }
  const setup = tools.find(tool => tool.name === 'isingq_api_key_setup').description;
  assert.match(setup, /not_written.*no_real_credentials=true/);
  assert.match(setup, /already_configured.*环境变量/);
  assert.match(setup, /remote_verification=unverified.*不证明远端/);
  for (const text of [setup, initialized.instructions, modelingGuide().agent_rules.join(' ')]) {
    assert.match(text, /credential_presence=not_checked.*不能据此声称用户缺 Key/);
    assert.match(text, /只缺真实凭据.*运行环境已经齐备/);
    assert.match(text, /no_real_credentials=true 仅表示本操作未接触真实凭据/);
  }
});
