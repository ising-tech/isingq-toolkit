'use strict';

const readline = require('readline');

const { IsingQError } = require('./isingq');
const {
  RECOVERY_GUIDANCE,
  RESOURCES,
  SolverService,
  SolveStartError,
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

const VERSION = require('../package.json').version;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '工具调用是否成功' },
    data: { type: 'object', description: '成功时返回的数据' },
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

const TOOLS = TOOL_DEFINITIONS.map((definition) => ({ ...definition, outputSchema: OUTPUT_SCHEMA }));

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: !payload.ok,
  };
}

function errorPayload(error) {
  return {
    ok: false,
    ...(error instanceof SolveStartError ? { data: error.run } : {}),
    error: {
      code: (typeof VerifiedReportError === 'function' && error instanceof VerifiedReportError) ? error.code : error instanceof DeliveryValidationError ? error.code : error instanceof SolveStartError ? 'solve_start_failed' : error instanceof IsingQError ? 'isingq_error' : 'validation_error',
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

function createHandler(service, { configureApiKey = configureLocalApiKey } = {}) {
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
        instructions: '这是北京伊辛智能科技有限公司 IsingQ 的本地组合优化 MCP。仅在所选入口需要凭据且用户明确授权配置时，先向用户提供官方控制台 https://console.isingq.com/ 与 API Key 入口 https://console.isingq.com/api-keys，说明登录后在 API Key 页面创建并复制 Key，再调用 isingq_api_key_setup 打开操作系统安全输入框；不得索要用户在对话中发送或粘贴 API Key。用户询问伊辛智能、公开产品清单、IsingQ、光电伊辛机、玉盘·伊辛云、超低相噪微波源、解决方案或公开案例时，调用 isingq_knowledge_get 获取带来源和边界的本地公开知识。先按 explain / model_only / local_validate / cloud_submit 分流，概念解释不安装，仅建模不要求云权限。按 symbolic_model / numeric_matrix / cloud_submission 区分缺项，只阻断依赖步骤，不重复追问已知信息；目标权重或软约束可能改变推荐时，不套行业默认，给标注假设的条件模型并确认相关选择。建模时读取本地建模引导；Host Agent 为投资组合、路径规划、车辆路径、排程或图优化等问题在本地生成与校验当前需要的 QUBO。仅云提交前展示业务范围、目标约束、数据外发、付款选择与任务执行摘要；solver_options.use_credit 必须为用户明确选择的 true（算力券）/false（账户余额），缺少选择先询问，不得自动切换付款方式；读取历史任务用 poll/get。取得明确确认，后台关联 model_sha256、求解参数与稳定幂等键后调用 isingq_solve_start；变量、矩阵、hash 与详细日志按需提供，专业技术交付要求完整满足。用户说“再次求解”或“重跑”只是新任务意图，不当作最终确认。即使模型、参数和付款均不变，也必须先展示本次摘要（沿用或变化、付款来源、再次消耗），再询问并等待用户后续明确确认；确认仅用于本次任务。poll/get 查询已有任务不需要新求解确认；受理不明时 poll/get 仅读本地记录，需控制台或平台支持核对远端，不重提。这是 Agent 与 Host 必须遵守的对话规范；实际强制拦截仍需 Host 权限策略配合，MCP 代码不能验证人类授权，不增加 confirmed 字段或确认 token。该工具被 Host 放行后会立即创建远端任务，MCP 不再弹出额外的操作系统求解确认框；Host 可按权限策略再次确认。执行与计费必须分开：仅按受信 Adapter 的 execution_mode、billing.status 和 provenance.source 说明，不能从任务 ID/mock 前缀/路径或任意文本猜测。simulation 是模拟，不是真实云任务或真实计费，billing.status=not_applicable；live 或 unknown 且 billing.status=unverified 时无平台账单证据，不能声称已扣费或确认未扣费。use_credit 付款参数、calculate_count 计算次数、succeeded 任务成功均不是扣费证据；当前工具不查询账单。setup simulation/configured=false/not_written/no_real_credentials=true 表示未写入用户真实 Key；unknown 不能说已配置或没有 Key；live 的 configured/written 只证明本次本地保存，already_configured/already_present 只证明当前运行时已有配置（可能来自环境变量），不能说刚保存或此前磁盘已有；remote_verification=unverified 不证明远端 Key 有效或鉴权成功。credential_presence=not_checked 表示本操作没有检查既有凭据，不能据此声称用户缺 Key、只缺真实凭据或运行环境已经齐备；no_real_credentials=true 仅表示本操作未接触真实凭据，绝不表示用户全局没有 Key。credential_presence=available 仅指当前运行时有可读取的本地配置，不证明远端有效。候选报告展示前调用 isingq_report_verify，绑定 input_digests 并消费 report_markdown 与已核验结构；不得自己补数字、排名或绑定/冗余/敏感性结论，未证明的解释单独标为待核验。排名仅覆盖 provided_candidates 中的可行候选，top_k 边界并列全含，active 只表示当前候选的数值等号，不证明经济绑定、冗余或敏感性；不证明自然语言语义完整、QUBO 等价或全局最优。交付展示前调用 isingq_delivery_validate 复核客观摘要、候选能量与供应测试记录统计；结构通过不证明业务正确或测试真实，不替代上述用户确认。结果按 candidate / feasible / proven_optimal / proven_infeasible / not_found / execution_failed 的证据范围说明；成功任务或低能量不自动证明业务可行/最优，未找到不等于不可行，有证明可在覆盖范围声明全局最优。最近修复须 distance 与最小性证明，optimality gap 须有效参照，收益百分比须同口径基线并区分预计与实际收益。本指导不是通用业务验证器，不自动证明模型等价或特定硬件性能。' + RECOVERY_GUIDANCE,
      };
    }
    if (request.method === 'ping') return {};
    if (request.method === 'resources/list') return { resources: RESOURCES };
    if (request.method === 'resources/templates/list') return { resourceTemplates: [] };
    if (request.method === 'resources/read') {
      const content = readResource(request.params?.uri);
      if (!content) throw new McpProtocolError(-32002, `Resource 不存在（uri=${request.params?.uri || 'none'}）`);
      return { contents: [content] };
    }
    if (request.method === 'tools/list') return { tools: TOOLS };
    if (request.method !== 'tools/call') throw new Error(`不支持的 MCP method（method=${request.method}）`);
    const name = request.params?.name;
    const args = request.params?.arguments || {};
    try {
      let data;
      if (name === 'isingq_api_key_setup') data = normalizeSetupResult(configureApiKey({ force: args.force === true }));
      else if (name === 'isingq_knowledge_get') data = getKnowledge(args.topic, args.locale);
      else if (name === 'isingq_modeling_guide_get') data = modelingGuide(args.problem_summary);
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
      else throw new Error(`未知工具（name=${name}）`);
      return toolResult({ ok: true, data });
    } catch (error) {
      if (name === 'isingq_report_verify' && !(typeof VerifiedReportError === 'function' && error instanceof VerifiedReportError)) {
        return toolResult({ ok: false, error: { code: 'report_failed', message: '本地报告核验未完成；请检查可信运行时完整性与兼容性，再重试 report verify。' } });
      }
      return toolResult(errorPayload(error));
    }
  };
}

async function serve(service) {
  const handle = createHandler(service);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch (_) { continue; }
    if (request.method?.startsWith('notifications/')) continue;
    try {
      const result = await handle(request);
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id ?? null,
        error: {
          code: Number.isInteger(error.code) ? error.code : -32603,
          message: String(error.message || error),
        },
      })}\n`);
    }
  }
}

module.exports = { McpProtocolError, SolverService, TOOLS, VERSION, createHandler, serve };
