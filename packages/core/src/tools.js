'use strict';

const { TOPICS } = require('./knowledge');
const { QUBO_INPUT_SCHEMA } = require('./qubo');

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const RECOVERY_GUIDANCE = '诊断只能引用实际error字段：recovery.diagnostic_evidence标明provider_message是否存在及来源；缺失时仅用已有phase/http_status，不能说平台给过脱敏提示；simulation提示是模拟诊断，unknown来源未核实。恢复必须消费 recovery（isingq-recovery-v1）：幂等键仅在本地存储去重，create_task 未向远端传此键，不承诺后端防重复或防扣费。unknown 禁止原键重试、换键、作废后新建；poll/get 此时仅读本地，需要平台控制台/支持人工核对。rejected（含 HTTP400）原键仍占用；根因未核实时先诊断/人工核查，不把规范化等价改写当已核实修复来建议新任务；用户主动新任务仍按已有确认流程处理；只有 recovery.same_key_retry_allowed=true 的未创建失败可以修复后原模型原参数原键重试。observation.remote_request_performed 只描述本次是否远端轮询，不表示费用已核实。';
const QUBO_GUIDANCE = 'QUBO输入仅num_bits必填；linear/quadratic/variables省略为[]，offset省略或null为0。示例和规范化后的完整对象不是必填声明。QUBO经规范化转矩阵CSV上传，远端create_task传inputJFile及参数，不传原始QUBO JSON；补默认字段不改变语义请求，不是远端400的已核实修复。';
const TOOL_DEFINITIONS = [
  {
    name: 'isingq_api_key_setup',
    title: '安全配置 IsingQ API Key',
    description: '仅在用户明确要求配置或更换 IsingQ API Key 时调用。先向用户提供官方控制台 https://console.isingq.com/ 与 API Key 入口 https://console.isingq.com/api-keys，说明登录后在 API Key 页面创建并复制 Key，再调用本工具打开操作系统安全输入框并把 Key 保存到本机私有配置。不得让用户在对话中发送或粘贴 Key；Key 不进入工具参数、对话或返回值。按结构化执行证据描述结果：execution_mode=simulation 且 configured=false、credential_effect=not_written、no_real_credentials=true 表示模拟，未写入用户真实 Key；unknown 不能断言已配置或没有 Key。live 的 configured/written 只表示本次本地保存，already_configured/already_present 只表示当前运行时已有配置（可能来自环境变量），不证明此前磁盘已保存；remote_verification=unverified 不证明远端 Key 有效或鉴权成功。credential_presence=not_checked 表示本操作没有检查既有凭据，不能据此声称用户缺 Key、只缺真实凭据或运行环境已经齐备；no_real_credentials=true 仅表示本操作未接触真实凭据，绝不表示用户全局没有 Key。credential_presence=available 仅指当前运行时有可读取的本地配置，不证明远端有效。',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', default: false, description: '已有 Key 时是否由用户明确要求重新配置' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'isingq_knowledge_get',
    title: '查询 IsingQ 与伊辛智能公开知识',
    description: '从本机版本化知识包查询北京伊辛智能科技有限公司、公开产品清单、IsingQ、光电伊辛机、玉盘·伊辛云、解决方案、公开案例、FAQ 和术语；不联网，不需要 API Key。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: Object.keys(TOPICS), description: '要查询的公开知识主题' },
        locale: { type: 'string', enum: ['zh-CN'], default: 'zh-CN' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_modeling_guide_get',
    title: '获取 IsingQ QUBO 建模引导',
    description: '获取伊辛智能 IsingQ 的本地 QUBO 建模步骤指导；不编译业务模型，不生成变量编码或约束系数。',
    inputSchema: {
      type: 'object',
      properties: { problem_summary: { type: 'string', maxLength: 4000 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_qubo_validate',
    title: '校验 QUBO 模型',
    description: '本地结构校验 Agent 已生成的稀疏 QUBO（1 至 2048 位），返回系数摘要、仅覆盖 CSV 的 matrix_sha256，以及含 offset 与变量映射的 model_sha256 / model_digest_version。不编译业务模型，不证明业务正确或等价。' + QUBO_GUIDANCE,
    inputSchema: {
      type: 'object',
      properties: { qubo: QUBO_INPUT_SCHEMA },
      required: ['qubo'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_delivery_validate',
    title: '校验本地 QUBO 交付与客观摘要',
    description: '纯本地校验已生成的交付 document；复算含 offset 的候选 QUBO 能量、matrix/model 摘要和供应的唯一测试记录计数。拒绝重复测试 ID、未知摘要声明和统计冲突。不运行代码、不读取 evidence_ref、不证明业务可行或测试执行真实，不替代用户云求解确认。',
    inputSchema: {
      type: 'object',
      properties: { document: {
        type: 'object',
        properties: {
          delivery_contract_version: { type: 'string', enum: ['isingq-delivery-v1'] },
          qubo: QUBO_INPUT_SCHEMA,
          candidate_bits: { type: 'array', items: { type: 'integer', enum: [0, 1] }, description: '可选，长度必须等于 num_bits' },
          claimed_objective_value: { type: 'number', description: '可选，必须与包含 offset 的候选 QUBO 能量严格一致' },
          mapping_completeness: { type: 'string', enum: ['partial', 'complete'], default: 'partial' },
          test_ledger: { type: 'array', items: {
            type: 'object', properties: {
              id: { type: 'string', minLength: 1, maxLength: 200 },
              status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'not_run'] },
              result: { type: 'string', enum: ['passed', 'failed', 'skipped', 'not_run'], description: 'status 的别名，同时给出时必须一致' },
              evidence_ref: { type: ['string', 'null'], description: '仅统计有无，不读取或认证引用' },
            }, required: ['id'], anyOf: [{ required: ['status'] }, { required: ['result'] }], additionalProperties: false,
          } },
          claimed_summary: { type: 'object', description: '支持客观字段的部分声明；所有字段逐一核对，未知字段拒绝',
            properties: {
              num_bits: { type: 'integer' }, input_linear_terms: { type: 'integer' }, input_quadratic_terms: { type: 'integer' },
              canonical_linear_terms: { type: 'integer' }, canonical_quadratic_terms: { type: 'integer' }, canonical_nonzero_terms: { type: 'integer' },
              named_variables: { type: 'integer' }, mapping_completeness: { type: 'string', enum: ['partial', 'complete'] },
              offset: { type: 'number' }, max_abs_coefficient: { type: 'number' },
              matrix_sha256: { type: 'string' }, matrix_size_bytes: { type: 'integer' }, model_sha256: { type: 'string' }, model_digest_version: { type: 'string' },
              candidate_objective_value: { type: ['number', 'null'] },
              test_records: { type: 'object', properties: {
                total: { type: 'integer' }, passed: { type: 'integer' }, failed: { type: 'integer' }, skipped: { type: 'integer' },
                not_run: { type: 'integer' }, with_evidence_ref: { type: 'integer' }, without_evidence_ref: { type: 'integer' },
              }, additionalProperties: false },
            }, additionalProperties: false,
          },
          business_solution: { description: '任意业务对象仅标记 unverified，不校验其生产 schema 或可行性' },
        }, required: ['qubo'], additionalProperties: false,
      } },
      required: ['document'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_report_verify',
    title: '生成本地数学模型核验报告',
    description: '纯本地复算 math-model-v1 的候选目标分项、约束 lhs/rhs/slack/active 与同模型基线改善；仅对 provided_candidates 中可行候选排名，top_k 边界并列全部保留。消费已计算的 report_markdown 与结构化结果，不自行补数字、排名或绑定/冗余/敏感性结论；额外解释必须有事实与推导依据，无依据断言删除；已给事实不能制造为 missing_data；图形由核验数据生成并校验刻度，否则用数值表。不联网、不求解、不读取 evidence_ref，不证明自然语言语义完整、QUBO 等价或全局最优，不替代云提交授权。返回visible_summary_markdown作为可直接原样引用的业务摘要（字段与单位区分目标值和送检候选数量，不重新手写数值段）；该段在同一report_markdown内原样存在，recommendation_basis包含同次核验的目标分项、约束数值与送检可行候选排名，可直接回答推荐依据；不额外认证未计算的统计/敏感性。返回report_artifact绑定确定性report_markdown的UTF-8字节与输入摘要；document不包含任意最终Markdown，本只读工具没有检查磁盘交付文件。交付文件应通过专家CLI显式report export/check绑定最终路径，不能把另写文件称为本次已核验报告。',
    inputSchema: {
      type: 'object',
      properties: { document: {
        type: 'object',
        properties: {
          report_contract_version: { type: 'string', enum: ['isingq-verified-report-v1'] },
          model: { type: 'object', description: '冻结的 math-model-v1 有限整数数学规格；由 core 严格校验' },
          data: { type: 'object', additionalProperties: { type: 'integer' }, description: '扁平参数到安全整数的映射' },
          candidates: { type: 'array', items: {
            type: 'object', properties: {
              id: { type: 'string', minLength: 1 },
              assignment: { type: 'object', additionalProperties: { type: 'integer' }, description: '全部变量 ID 到安全整数的精确赋值' },
            }, required: ['id', 'assignment'], additionalProperties: false,
          } },
          baseline: { type: 'object', additionalProperties: { type: 'integer' }, description: '可选，同 model/data 的完整基线赋值；都可行时才计算改善' },
          top_k: { type: 'integer', minimum: 1, description: '可选，正安全整数；边界并列全部保留' },
        }, required: ['report_contract_version', 'model', 'data', 'candidates'], additionalProperties: false,
      } },
      required: ['document'], additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_solve_start',
    title: '提交 IsingQ 组合优化求解',
    description: '调用即会将 QUBO 转成矩阵，并使用本机个人 IsingQ API Key 创建远端求解任务。仅在用户明确授权当前云任务后调用；先展示业务范围、目标约束、数据外发、付款选择与任务执行摘要，后台绑定 model_sha256、求解参数和稳定幂等键。用户说“再次求解”或“重跑”只是新任务意图，不当作最终确认。即使模型、参数和付款均不变，也必须先展示本次摘要（沿用或变化、付款来源、再次消耗），再询问并等待用户后续明确确认；确认仅用于本次任务。poll/get 查询已有任务不需要新求解确认；受理不明时 poll/get 仅读本地记录，需控制台或平台支持核对远端，不重提。这是 Agent 与 Host 必须遵守的对话规范；实际强制拦截仍需 Host 权限策略配合，MCP 代码不能验证人类授权，不增加 confirmed 字段或确认 token。必须按用户明确选择传入 solver_options.use_credit=true/false；缺少付款选择先询问，不得自动切换付款或更换幂等键重提。矩阵/hash 详情按需提供，用户无需读懂矩阵；Host 可按权限策略再次确认。结果必须保留 execution_mode、billing.status 与 provenance.source：simulation 是模拟，不是真实云任务或真实扣费；unknown 不能按任务 ID/mock 前缀/路径猜测。live/unknown 且 billing.status=unverified 时无平台账单证据，不能声称已扣费或确认未扣费。付款参数 use_credit、calculate_count 和 succeeded 都不是扣费证据；当前工具不查询账单。' + RECOVERY_GUIDANCE + QUBO_GUIDANCE,
    inputSchema: {
      type: 'object',
      properties: {
        qubo: QUBO_INPUT_SCHEMA,
        model_summary: { type: 'string', minLength: 1, maxLength: 8000 },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
        solver_options: {
          type: 'object',
          description: '云提交参数；付款选择必须显式给出，其他字段可省略使用其默认值。',
          properties: {
            computer_type_id: { type: 'integer', minimum: 1, default: 1, description: '平台机型 ID，正整数，默认 1；需先核对平台能力。' },
            question_type: { type: 'integer', minimum: 1, default: 1, description: '平台问题类型 ID，正整数，默认 1。' },
            calculate_count: { type: 'integer', minimum: 1, maximum: 10000, default: 1, description: '计算次数，1 至 10000 的整数，默认 1。' },
            post_process: { type: 'boolean', default: false, description: '是否启用后处理，默认 false。' },
            use_credit: { type: 'boolean', description: '用户明确选择的付款方式：true=算力券，false=账户余额；缺失先询问，不得代选或自动切换，无默认值。' },
            gear: { type: 'integer', enum: [0, 1, 2], default: 2, description: '保留参数，默认 2；当前任务创建 HTTP 契约未发送 gear。' },
          },
          required: ['use_credit'],
          additionalProperties: false,
        },
      },
      required: ['qubo', 'model_summary', 'idempotency_key', 'solver_options'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'isingq_solve_poll',
    title: '查询 IsingQ 求解进度',
    description: '仅有 provider_task_id 且非终态时查询一次远端并更新本地记录；unknown、无远端ID及终态直接返回本地记录，不能称为远端查证；成功时返回 bit、变量映射、provider energy 和 QUBO 目标值。保留 execution_mode 与 billing.status：simulation 不是真实云任务；succeeded 不代表已扣费，unverified 表示没有账单证据，不查询账单。' + RECOVERY_GUIDANCE,
    inputSchema: {
      type: 'object',
      properties: { solve_id: { type: 'string' } },
      required: ['solve_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'isingq_solve_result_get',
    title: '读取本地 IsingQ 求解结果',
    description: '读取本机保存的 QUBO-only 求解状态、结果、execution_mode、billing.status 与来源信息；不联网，不自动断言业务可行或全局最优。历史无执行标识为 unknown；simulation 不是真实云任务，unverified 不证明已扣费或未扣费，不从 ID 或路径猜测。' + RECOVERY_GUIDANCE,
    inputSchema: {
      type: 'object',
      properties: { solve_id: { type: 'string' } },
      required: ['solve_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_update_check', title: '检查 IsingQ 更新',
    description: '仅在用户主动询问版本或明确要求刷新时调用。自动提醒由运行时后台完成，普通任务不应主动调用本工具。只读查询官方npm稳定版本，不发送模型或凭据、不安装、不修改配置；unavailable表示未核实，不等于已是最新，不阻断其他功能。',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: '忽略进程内缓存重新查询，默认 false' } }, additionalProperties: false },
    annotations: { ...READ_ONLY_ANNOTATIONS, openWorldHint: true },
  },
];

module.exports = { TOOL_DEFINITIONS, RECOVERY_GUIDANCE };
