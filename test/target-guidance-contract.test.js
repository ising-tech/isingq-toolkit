'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler: createMcpHandler } = require('../src/server');
const createHandler = (service, options = {}) => createMcpHandler(service, { ...options, tools_profile: 'technical' });
const { modelingGuide } = require('../packages/core/src/modeling');
const { getKnowledge } = require('../packages/core/src/knowledge');

const handle = createHandler(new Proxy({}, { get() { throw new Error('GUIDANCE_MUST_NOT_ACCESS_SOLVER'); } }));
async function publicGuidance() {
  const [init, guide, resource, tools] = await Promise.all([
    handle({ method: 'initialize' }),
    handle({ method: 'tools/call', params: { name: 'isingq_modeling_guide_get', arguments: {} } }),
    handle({ method: 'resources/read', params: { uri: 'isingq://modeling/qubo' } }),
    handle({ method: 'tools/list' }),
  ]);
  return { init: init.instructions, guide: guide.structuredContent.data, resource: resource.contents[0].text, tools: tools.tools };
}

test('MCP confirmation policy scopes payment to cloud and exposes no local payment prerequisite', async () => {
  const { init, guide, resource } = await publicGuidance();
  assert.deepEqual(guide, modelingGuide());
  assert.ok(!guide.confirmation_policy.business_summary.includes('payment_choice'));
  assert.ok(guide.confirmation_policy.by_target.cloud.includes('payment_choice'));
  assert.ok(!guide.confirmation_policy.by_target.local.includes('payment_choice'));
  assert.ok(guide.confirmation_policy.by_target.local.includes('device_occupancy'));
  for (const text of [init, resource, [...guide.required_sequence, ...guide.agent_rules].join('\n')]) {
    assert.match(text, /target\.kind=local[\s\S]*不展示云费用[\s\S]*算力券[\s\S]*余额/);
    assert.match(text, /scope=cloud_platform[\s\S]*reason=local_target/);
    assert.match(text, /平台不计费.*不.*模拟/);
    assert.match(text, /仅.*(?:cloud_submit|云目标).*solver_options\.use_credit/);
    assert.doesNotMatch(text, /(?:^|\n)solver_options\.use_credit 必须|用户确认业务范围、目标约束、数据外发、付款选择/);
    assert.match(text, /切换.*本地.*移除.*云参数.*待处理付款/);
    assert.ok(text.includes(guide.result_evidence.execution_and_billing));
    assert.doesNotMatch(text, /billing.status=not_applicable 不发生真实计费/);
    assert.match(text, /本地重跑.*本次.*明确确认/);
  }
});

test('MCP public guidance offers management for every local configuration count with refresh semantics', async () => {
  const { init, guide, resource, tools } = await publicGuidance();
  for (const text of [init, resource]) {
    for (const rule of guide.target_guidance) assert.ok(text.includes(rule), rule);
    assert.match(text, /零／一／多台[\s\S]*添加／管理本地求解器/);
    assert.match(text, /isingq_solver_config_open[\s\S]*Host[\s\S]*可点击/);
    assert.match(text, /管理返回[\s\S]*isingq_solver_targets_list[\s\S]*保留模型[\s\S]*合法选择/);
    assert.match(text, /保存不提交/);
  }
  const list = tools.find(tool => tool.name === 'isingq_solver_targets_list');
  assert.match(list.description, /local.management/);
  assert.match(list.description, /零／一／多台/);
  assert.match(list.description, /管理操作不.*求解目标/);
  const open = tools.find(tool => tool.name === 'isingq_solver_config_open');
  assert.match(open.description, /返回.*(?:url|URL).*Host.*可点击/);
});

test('local task_mode public schema and guide share the internal default without a normal user menu', async () => {
  const { init, guide, resource, tools } = await publicGuidance();
  assert.equal(guide.solver_mode_policy.default, 2);
  assert.equal(guide.solver_mode_policy.ask_user, false);
  assert.equal(guide.solver_mode_policy.show_in_normal_flow, false);
  assert.equal(guide.solver_mode_policy.values, undefined);
  assert.equal(guide.solver_mode_policy.reuse_explicit_choice, true);
  for (const name of ['isingq_solver_targets_list', 'isingq_target_solve_prepare', 'isingq_target_solve_start']) {
    const mode = tools.find(tool => tool.name === name).inputSchema.properties.solver_options.properties.task_mode;
    assert.deepEqual(mode.enum, [0, 1, 2]);
    assert.ok(!Object.hasOwn(mode, 'default'), 'shared cloud/local schema must not inject a local-only default');
    assert.equal(mode.description, guide.solver_mode_policy.description);
  }
  for (const text of [init, resource, guide.solver_mode_policy.description]) {
    assert.match(text, /普通业务流程.*不询问.*不.*展示.*模式/);
    assert.match(text, /不改变.*bit.*精度/);
    assert.match(text, /不保证.*最优/);
    assert.doesNotMatch(text, /首次缺少模式时.*显式选择|不指定默认/);
    assert.match(text, /历史参数原样保留/);
  }
});

test('security resources and FAQ describe selected cloud/local data destinations without obsolete cloud-only claims', async () => {
  const security = (await handle({ method: 'resources/read', params: { uri: 'isingq://security/data-flow' } })).contents[0].text;
  assert.match(security, /target\.kind=local[\s\S]*所选本地/);
  assert.doesNotMatch(security, /只有 isingq_solve_start|不向用户提供其他机型选择|除 IsingQ 求解链路外/);
  const faq = getKnowledge('faq');
  const upload = faq.facts.find(fact => fact.id === 'faq.data_upload');
  assert.match(upload.value, /所选.*(?:云端|云).*本地/);
  assert.doesNotMatch(upload.value, /调用求解提交工具会将矩阵发送至 IsingQ/);
  const key = faq.facts.find(fact => fact.id === 'faq.api_key');
  assert.match(key.caveat, /本地.*不.*云.*Key/);
});

test('final Host confirmation preserves actionable management after a not-ready local preparation', async () => {
  const { init, guide, resource, tools } = await publicGuidance();
  for (const text of [init, resource, guide.target_guidance.join('\n'), tools.find(tool => tool.name === 'isingq_target_solve_prepare').description]) {
    assert.match(text, /问答表单.*最终.*确认.*先添加／管理本地求解器.*确认提交.*暂不提交/);
    assert.match(text, /无按钮.*自然语言.*管理动作/);
    assert.match(text, /不.*tool:\/\//);
    assert.match(text, /管理返回.*刷新.*保留模型.*已选.*高级参数/);
    assert.match(text, /重新 prepare.*不.*接受建议.*不.*再次询问.*模式/);
  }
});

test('result consumers share an evidence boundary instead of diagnosing provider internals from a single matching energy', async () => {
  const { init, guide, resource, tools } = await publicGuidance();
  const policy = guide.result_interpretation_policy;
  assert.ok(policy, 'public guide must expose result evidence limitations');
  assert.equal(policy.provider_internal_processing, 'unknown');
  assert.equal(policy.provider_fault_cause, 'undetermined');
  assert.equal(policy.energy_agreement_scope, 'single_candidate_value_only');
  assert.equal(policy.client_quantization_scope, 'client_only_not_provider');
  assert.equal(policy.automatic_remodeling_authorized, false);
  for (const text of [init, resource, tools.find(tool => tool.name === 'isingq_solve_records_list').description]) {
    assert.ok(text.includes(policy.description));
    assert.match(text, /单点.*(?:energy|能量).*一致.*不.*证明.*(?:量化|缩放)/);
    assert.match(text, /client_quantization.*仅.*客户端.*不.*provider/);
    assert.match(text, /不.*(?:退火|采样).*唯一.*原因/);
    assert.match(text, /不.*8bit.*(?:范围|步长)/);
    assert.match(text, /不自行生成.*新模型.*用户另行要求.*实际依据/);
  }
});

test('direct prepare discovery requires consuming the same local normal-user presentation policy as the guide', async () => {
  const { guide, tools } = await publicGuidance();
  const policy = guide.local_preparation_presentation_policy;
  assert.ok(policy, 'normal presentation must have a canonical producer/consumer contract');
  assert.equal(policy.contract_version, 'isingq-local-preparation-presentation-v1');
  assert.equal(policy.audience, 'normal_user');
  assert.equal(policy.show_solver_mode, false);
  assert.equal(policy.show_server_postprocessing, false);
  assert.equal(policy.must_show_all_actions, true);
  assert.equal(policy.requires_current_task_authorization, true);
  assert.equal(policy.preparation_proves_authorization, false);
  const prepare = tools.find(tool => tool.name === 'isingq_target_solve_prepare');
  assert.ok(prepare.description.includes(policy.description), 'ToolSearch must expose the direct consumption contract even without a guide call');
  assert.match(prepare.description, /优先.*presentation.*普通.*摘要/);
});
