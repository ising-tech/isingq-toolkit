'use strict';

const { runStdio } = require('./stdio-protocol');

const { IsingQError } = require('./isingq');
const { SolveStoreError } = require('./store');
const { FileLimitError } = require('../packages/core/src/file-limits');
const {
  checkUpdate,
  createBackgroundUpdates,
  RECOVERY_GUIDANCE,
  RESOURCES,
  SolverService,
  SolveStartError,
  SubmissionPersistenceError,
  DeliveryValidationError,
  validateDelivery,
  VerifiedReportError,
  buildVerifiedReport,
  TOOL_DEFINITIONS,
  getKnowledge,
  modelingGuide,
  normalizeSetupResult,
  readResource,
} = require('./core');
const { configureApiKey: configureLocalApiKey } = require('./setup');
const { validateTargetToolArguments } = require('../packages/core/src/target-tools');

const { GUIDED_TOOL_DEFINITION, ORDINARY_INSTRUCTIONS, ordinaryModelingGuide, ordinaryResource, ordinarySetupResult } = require('../packages/core/src/guided-tools');
const VERSION = require('../package.json').version;
const {runtimeIdentity} = require('../packages/core/src/runtime-identity');
const runtimeContracts = require('./core');
// A single-file release has no package/core source tree. Its build producer
// binds the original source identity using the exact same versioned algorithm.
const runtimeSourceIdentity=typeof __ISINGQ_BUILD_RUNTIME_IDENTITY__==='undefined'
  ? runtimeIdentity(require('node:path').resolve(__dirname,'..')) : __ISINGQ_BUILD_RUNTIME_IDENTITY__;
if(runtimeSourceIdentity?.artifact_digest_version!=='isingq-runtime-code-v1' || !/^[a-f0-9]{64}$/.test(runtimeSourceIdentity.artifact_sha256 || '')
  || runtimeSourceIdentity.package_version!==VERSION || runtimeSourceIdentity.core_version!==VERSION)throw Error('IsingQ运行时身份与包版本不一致；请核对源码包，或通过官方构建入口重新绑定发行身份。');
const RUNTIME_IDENTITY = Object.freeze({contract_version:'isingq-runtime-identity-v1',package_name:'@ising-tech/isingq-mcp',
  ...runtimeSourceIdentity,
  capabilities:{guided_solve:runtimeContracts.GUIDED_SOLVE_CONTRACT_VERSION,
    solver_target:runtimeContracts.SOLVER_TARGET_CONTRACT_VERSION,model_artifacts:runtimeContracts.GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION,result_review:runtimeContracts.GUIDED_RESULT_REVIEW_CONTRACT_VERSION,result_review_file:runtimeContracts.REVIEW_FILE_CONTRACT_VERSION},
  ...(process.env.ISINGQ_MANAGED_MCP_ID && /^[a-f0-9]{64}$/.test(process.env.ISINGQ_MANAGED_MCP_TOKEN || '')
    ? {connection_id:process.env.ISINGQ_MANAGED_MCP_ID,connection_token:process.env.ISINGQ_MANAGED_MCP_TOKEN} : {})});

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '工具调用是否成功' },
    data: { type: 'object', description: '成功时返回的数据' },
    update_notice: { type: 'object', description: '可选的已完成后台新版提示；不要求用户回应。不出现时不得主动谈论更新。' },
    runtime_identity: {type:'object',description:'宿主后台核对实际加载来源；不在普通业务回复中打印。'},
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['ok'],
  additionalProperties: false,
};

const TOOLS = [...TOOL_DEFINITIONS, GUIDED_TOOL_DEFINITION].map((definition) => ({ ...definition, outputSchema: OUTPUT_SCHEMA }));

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: !payload.ok,
  };
}

function errorPayload(error, targetOperation = false) {
  return {
    ok: false,
    ...(error instanceof SolveStartError || error instanceof SubmissionPersistenceError || (targetOperation && error.run) ? { data: error.run } : {}),
    error: {
      code: error instanceof SubmissionPersistenceError || (targetOperation && typeof error.code === 'string') ? error.code : error instanceof SolveStoreError || error instanceof FileLimitError ? error.code : (typeof VerifiedReportError === 'function' && error instanceof VerifiedReportError) ? error.code : error instanceof DeliveryValidationError ? error.code : error instanceof SolveStartError ? 'solve_start_failed' : error instanceof IsingQError ? 'isingq_error' : 'validation_error',
      message: error instanceof IsingQError
        ? `IsingQ 调用失败（phase=${error.phase}, status=${error.status ?? 'none'}, retryable=${error.retryable}）${error.providerMessage ? `；平台提示：${error.providerMessage}` : ''}`
        : String(error.message || error),
    },
  };
}

class McpProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function createHandler(service, { configureApiKey = configureLocalApiKey, backgroundUpdates = null, tools_profile = 'normal' } = {}) {
  if (!['normal','technical'].includes(tools_profile)) throw new Error('tools_profile必须是normal或technical');
  const technical = tools_profile === 'technical';
  const guidedTool = { ...GUIDED_TOOL_DEFINITION, outputSchema: OUTPUT_SCHEMA };
  const discovered = technical ? TOOLS : [...TOOLS.filter(t => ['isingq_api_key_setup','isingq_knowledge_get','isingq_modeling_guide_get'].includes(t.name)).map(t => t.name === 'isingq_api_key_setup' ? {...t,description:'仅当用户请求配置云服务凭据时打开安全输入入口。先引导用户登录https://console.isingq.com/并在API Key页面创建Key，不在对话中接收或显示秘密；本地求解不要求云Key。返回配置状态不证明远端鉴权成功。'} : t),guidedTool];
  const getService = () => {
    if (service === undefined) service = new SolverService();
    return service;
  };
  return async function handle(request) {
    if (request.method === 'initialize') {
      return {
        protocolVersion: request.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: 'isingq-mcp',
          title: 'IsingQ · 伊辛智能组合优化建模与求解',
          version: VERSION,
        },
        instructions: technical ? modelingGuide().target_guidance.join(' ') + '自动更新检查由运行时后台完成，不是Agent任务步骤。不要主动调用 update-check / isingq_update_check，也不要预告、播报或解释检查过程；只处理用户当前任务。普通成功结果若带 update_notice，则在正常结果末尾附一句该通知的 text，不提问、不要求回应、不自动升级；没有 update_notice 字段时完全不谈版本或检查状态。缓存会限制同一版本的重复通知。只有用户主动询问更新或要求刷新时，才调用手动检查命令，并如实解释其返回状态。后台查询未完成时主任务照常返回，提示可以留到后续普通结果；不为提示等待网络。diagnose始终离线。用户可通过 ISINGQ_UPDATE_CHECK=off 禁用自动检查，显式手动检查仍可使用。' + '这是北京伊辛智能科技有限公司 IsingQ 的本地组合优化 MCP。仅在所选入口需要凭据且用户明确授权配置时，先向用户提供官方控制台 https://console.isingq.com/ 与 API Key 入口 https://console.isingq.com/api-keys，说明登录后在 API Key 页面创建并复制 Key，再调用 isingq_api_key_setup 打开操作系统安全输入框；不得索要用户在对话中发送或粘贴 API Key。用户询问伊辛智能、公开产品清单、IsingQ、光电伊辛机、玉盘·伊辛云、超低相噪微波源、解决方案或公开案例时，调用 isingq_knowledge_get 获取带来源和边界的本地公开知识。先按 explain / model_only / local_validate / target_submit / legacy cloud_submit 分流，概念解释不安装，仅建模不要求云权限。按 symbolic_model / numeric_matrix / cloud_submission 区分缺项，只阻断依赖步骤，不重复追问已知信息；目标权重或软约束可能改变推荐时，不套行业默认，给标注假设的条件模型并确认相关选择。建模时读取本地建模引导；Host Agent 为投资组合、路径规划、车辆路径、排程或图优化等问题在本地生成与校验当前需要的 QUBO。以下付款与 isingq_solve_start 规则仅用于 legacy cloud_submit；新目标仍按 target.kind 分流。仅云提交前展示业务范围、目标约束、数据外发、付款选择与任务执行摘要；solver_options.use_credit 必须为用户明确选择的 true（算力券）/false（账户余额），缺少选择先询问，不得自动切换付款方式；读取历史任务用 poll/get。取得明确确认，Agent 在本轮上下文中关联校验返回的 model_sha256、求解参数与稳定幂等键后调用 isingq_solve_start；变量、矩阵、hash 与详细日志按需提供，专业技术交付要求完整满足。仅云目标（含 legacy cloud_submit）：用户说“再次求解”或“重跑”只是新任务意图，不当作最终确认。即使模型、参数和付款均不变，也必须先展示本次摘要（沿用或变化、付款来源、再次消耗），再询问并等待用户后续明确确认；确认仅用于本次任务。poll/get 查询已有任务不需要新求解确认；受理不明时 poll/get 仅读本地记录，需控制台或平台支持核对远端，不重提。这是 Agent 与 Host 必须遵守的对话规范；实际强制拦截仍需 Host 权限策略配合，MCP 代码不能验证人类授权，不增加 confirmed 字段或确认 token。该工具被 Host 放行后会立即创建远端任务，MCP 不再弹出额外的操作系统求解确认框；Host 可按权限策略再次确认。' + modelingGuide().result_evidence.execution_and_billing + 'setup simulation/configured=false/not_written/no_real_credentials=true 表示未写入用户真实 Key；unknown 不能说已配置或没有 Key；live 的 configured/written 只证明本次本地保存，already_configured/already_present 只证明当前运行时已有配置（可能来自环境变量），不能说刚保存或此前磁盘已有；remote_verification=unverified 不证明远端 Key 有效或鉴权成功。credential_presence=not_checked 表示本操作没有检查既有凭据，不能据此声称用户缺 Key、只缺真实凭据或运行环境已经齐备；no_real_credentials=true 仅表示本操作未接触真实凭据，绝不表示用户全局没有 Key。credential_presence=available 仅指当前运行时有可读取的本地配置，不证明远端有效。候选报告展示前调用 isingq_report_verify，绑定 input_digests 并消费 report_markdown 与已核验结构；不得自己补数字、排名或绑定/冗余/敏感性结论，未证明的解释单独标为待核验。排名仅覆盖 provided_candidates 中的可行候选，top_k 边界并列全含，active 只表示当前候选的数值等号，不证明经济绑定、冗余或敏感性；不证明自然语言语义完整、QUBO 等价或全局最优。交付展示前调用 isingq_delivery_validate 复核客观摘要、候选能量与供应测试记录统计；结构通过不证明业务正确或测试真实，不替代上述用户确认。结果按 candidate / feasible / proven_optimal / proven_infeasible / not_found / execution_failed 的证据范围说明；成功任务或低能量不自动证明业务可行/最优，未找到不等于不可行，有证明可在覆盖范围声明全局最优。最近修复须 distance 与最小性证明，optimality gap 须有效参照，收益百分比须同口径基线并区分预计与实际收益。本指导不是通用业务验证器，不自动证明模型等价或特定硬件性能。' + RECOVERY_GUIDANCE : ORDINARY_INSTRUCTIONS,
      };
    }
    if (request.method === 'ping') return {};
    if (request.method === 'resources/list') return { resources: technical ? RESOURCES : RESOURCES.map(r => r.uri === 'isingq://modeling/qubo' ? {...r,description:'业务变量、约束、QUBO与求解确认步骤。'} : r) };
    if (request.method === 'resources/templates/list') return { resourceTemplates: [] };
    if (request.method === 'resources/read') {
      const content = (!technical && ordinaryResource(request.params?.uri)) || readResource(request.params?.uri);
      if (!content) throw new McpProtocolError(-32002, `Resource 不存在（uri=${request.params?.uri || 'none'}）`);
      return { contents: [content] };
    }
    if (request.method === 'tools/list') return { tools: discovered };
    if (request.method !== 'tools/call') throw new McpProtocolError(-32601, `不支持的 MCP method（method=${request.method}）`);
    const name = request.params?.name;
    const args = request.params?.arguments || {};
    let targetOperation = false;
    try {
      targetOperation = validateTargetToolArguments(name, args);
      let data;
      if (name === 'isingq_api_key_setup') { const configured = normalizeSetupResult(configureApiKey({ force: args.force === true })); data = technical ? configured : ordinarySetupResult(configured); }
      else if (name === 'isingq_update_check') data = await checkUpdate(args);
      else if (name === 'isingq_knowledge_get') data = getKnowledge(args.topic, args.locale);
      else if (name === 'isingq_modeling_guide_get') data = technical ? modelingGuide(args.problem_summary) : ordinaryModelingGuide(args.problem_summary);
      else if (name === 'isingq_solve') data = await getService().guideSolve(args);
      else if (name === 'isingq_delivery_validate') {
        if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(key => key !== 'document')) {
          throw new DeliveryValidationError('delivery_unknown_field', 'arguments', '仅允许 document 字段；所有交付声明必须放在 document 内');
        }
        data = validateDelivery(args.document);
      }
      else if (name === 'isingq_report_verify') {
        if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(key => key !== 'document')) {
          throw new VerifiedReportError('report_unknown_field', 'arguments', '仅允许 document 字段；所有核验输入必须放在 document 内');
        }
        data = buildVerifiedReport(args.document);
      }
      else if (name === 'isingq_qubo_validate') data = getService().validate(args.qubo);
      else if (name === 'isingq_solve_start') data = await getService().start(args);
      else if (name === 'isingq_solve_poll') data = await getService().poll(args.solve_id);
      else if (name === 'isingq_solve_result_get') data = getService().get(args.solve_id);
      else if (name === 'isingq_solver_targets_list') data = await getService().listTargets(args);
      else if (name === 'isingq_target_solve_prepare') data = await getService().prepareTarget(args);
      else if (name === 'isingq_target_solve_start') data = await getService().startTarget(args);
      else if (name === 'isingq_solver_profiles_list') data = { profiles: getService().profileList() };
      else if (name === 'isingq_solver_profiles_save') data = getService().profileSave(args.profile);
      else if (name === 'isingq_solver_profiles_delete') data = getService().profileDelete(args.profile_id);
      else if (name === 'isingq_solver_config_open') data = await getService().openTargetConfig();
      else if (name === 'isingq_solve_records_list') data = getService().listRuns(args);
      else if (name === 'isingq_target_delivery_validate') data = getService().validateTargetDelivery(args);
      else throw new Error(`未知工具（name=${name}）`);
      const payload = { ok: true, data };
      if (name === 'isingq_modeling_guide_get') payload.runtime_identity = RUNTIME_IDENTITY;
      if (backgroundUpdates && ['isingq_modeling_guide_get', 'isingq_qubo_validate', 'isingq_knowledge_get'].includes(name)) {
        try {
          const notice = backgroundUpdates.takeNotice();
          if (notice) payload.update_notice = notice;
        } catch { /* Optional update delivery must never replace the task result. */ }
      }
      const result = toolResult(payload);
      if (name === 'isingq_solve') result.content = [{ type: 'text', text: JSON.stringify(data) }];
      return result;
    } catch (error) {
      if (name === 'isingq_report_verify' && !(typeof VerifiedReportError === 'function' && error instanceof VerifiedReportError)) {
        return toolResult({ ok: false, error: { code: 'report_failed', message: '本地报告核验未完成；请检查可信运行时完整性与兼容性，再重试 report verify。' } });
      }
      return toolResult(errorPayload(error, targetOperation));
    }
  };
}

async function serve(service, { tools_profile = 'normal' } = {}) {
  let backgroundUpdates = null;
  try {
    backgroundUpdates = createBackgroundUpdates({ mode: 'inline' });
    backgroundUpdates.start();
  } catch { /* An optional background check must not prevent MCP startup. */ }
  const handle = createHandler(service, { backgroundUpdates, tools_profile });
  const managed = require('../packages/core/src/managed-mcp-state').serverControl();
  let activityCleanupFailed = false;
  try {
    await runStdio({
      input: process.stdin, output: process.stdout, handle,
      begin: request => {
        // A failed release can leave this generation busy. Do not admit more
        // tool work; keep the existing identity-query exception for recovery.
        if (activityCleanupFailed && request.method === 'tools/call' && request.params?.name !== 'isingq_modeling_guide_get') {
          throw new McpProtocolError(-32001, 'MCP 活动登记未能收尾；请重连服务并核对原调用结果，勿重复提交原任务。');
        }
        return managed?.begin(request);
      },
      onCleanupError: () => {
        activityCleanupFailed = true;
        process.stderr.write('MCP 调用已结束，但活动登记未能收尾；请重连服务并核对原调用结果，勿重复提交原任务。\n');
      },
    });
  } finally { managed?.close(); }
}

module.exports = { McpProtocolError, SolverService, TOOLS, VERSION, createHandler, serve };
