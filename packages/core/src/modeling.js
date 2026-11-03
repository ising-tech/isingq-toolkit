'use strict';

const { QUBO_INPUT_SCHEMA, QUBO_TRANSPORT_BOUNDARY } = require('./qubo');

function modelingGuide(problemSummary = '') {
  return {
    scope: 'local_guidance_only',
    problem_summary: String(problemSummary || '').trim(),
    // Instruction policy only: these fields neither authorize a solve nor validate business rules.
    intent_routes: {
      explain: { requires_runtime: false, requires_api_key: false, cloud_submission: false, stop_after: 'answer' },
      model_only: { requires_runtime: false, requires_api_key: false, cloud_submission: false, stop_after: 'requested_model_or_matrix' },
      local_validate: { requires_runtime: true, requires_api_key: false, cloud_submission: false, stop_after: 'available_local_checks' },
      cloud_submit: { requires_runtime: true, requires_api_key: true, cloud_submission: true, requires_explicit_authorization: true },
    },
    data_readiness: {
      symbolic_model: { allows_missing_instance_values: true, requires: 'decision_and_objective_constraint_semantics_or_labeled_conditional_models' },
      numeric_matrix: { requires_validated_instance_values: true, requires: 'values_dimensions_domains_and_confirmed_material_weights' },
      cloud_submission: { requires_confirmed_model: true, requires: 'validated_matrix_capabilities_credentials_and_cloud_authorization' },
      block_only_dependent_steps: true,
      repeat_known_questions: false,
      silent_business_defaults: false,
    },
    confirmation_policy: {
      business_summary: ['decision_scope', 'objectives_and_constraints', 'data_egress', 'payment_choice', 'task_execution'],
      binding: 'model_sha256_and_solver_options',
      requires_matrix_literacy: false,
      details: 'on_request_or_technical_delivery',
      enforcement: 'agent_and_host_only_no_tool_confirmation_parameter',
    },
    result_evidence: {
      states: {
        candidate: '位串或候选方案尚未完成业务硬约束复核',
        feasible: '原始业务硬约束逐条复核通过，并说明覆盖范围',
        proven_optimal: '完整穷举、有效界限证书或其他可核验证明，限定覆盖范围',
        proven_infeasible: '完整穷举或不可行证书覆盖目标可行域',
        not_found: '本次方法与预算内未找到可行解，不等于问题不可行',
        execution_failed: '执行/连接/校验失败，不由此推断业务结论',
      },
      not_found_implies_infeasible: false,
      allows_proven_global_optimum: true,
      nearest_repair_requires: 'distance_and_minimality_proof',
      optimality_gap_requires: 'verified_optimum_or_valid_bound',
      improvement_percent_requires: 'comparable_baseline_scope_and_formula',
      separate_expected_and_realized_benefits: true,
      implements_business_validator: false,
    },
    required_sequence: [
      '先分流 explain / model_only / local_validate / cloud_submit；只执行用户请求的阶段',
      '复用已知信息，按 symbolic_model / numeric_matrix / cloud_submission 判断缺项，只阻断依赖步骤',
      '定义二进制变量，为每个 index 提供 name 与 meaning；条件模型显式标注假设',
      '把目标与已确认约束展开为 QUBO，说明编码、惩罚项与权重依据，不静默代定业务偏好',
      '需要本地校验时检查兼容 capability 后调用 isingq_qubo_validate，后台保存 model_sha256',
      '仅 cloud_submit 入口：每个新任务均先展示本次业务范围、目标约束、数据外发、沿用或变化、付款来源与再次消耗摘要，再询问并等待后续明确确认；缺少付款选择先询问，以显式 use_credit 提交并轮询',
      '解码候选，按原始约束与证明证据标记结果，不把最低 energy 自动等同于业务可行或最优',
    ],
    qubo_contract: {
      input_schema: QUBO_INPUT_SCHEMA,
      schema_role: 'illustrative_example_not_validation_schema',
      normalized_output_fields: ['num_bits', 'linear', 'quadratic', 'offset', 'variables'],
      transport_boundary: QUBO_TRANSPORT_BOUNDARY,
      objective: 'offset + Σ linear[i]·x_i + Σ quadratic[i,j]·x_i·x_j',
      binary_domain: 'x_i ∈ {0,1}',
      schema: {
        num_bits: '1 到 2048 的整数',
        linear: [{ index: 0, coefficient: 1.5 }],
        quadratic: [{ i: 0, j: 1, coefficient: -2.0 }],
        offset: 0,
        variables: [{ index: 0, name: 'x_0', meaning: '变量含义' }],
      },
    },
    explanation_contract: {
      facts: '保留用户明确给出的定义、单位、数值和约束；已给信息不是假设或缺失数据',
      missing_data: '仅列当前目标或约束计算确实依赖且用户尚未提供的信息，并说明受阻步骤；可选业务扩展不算当前缺项',
      inferences: '每项额外因果、敏感性或可行性解释需输入事实与推导依据；无证据时删除断言，必要的条件分析单列前提，不改变原问题结论',
      dimensions: '累计资源投入与日历持续时间、同时占用是不同量；没有新增排程约束时不能互相替代或据此否定已给累计约束',
      verification_scope: 'report verify 只复算声明模型和候选，不能为后加自然语言解释背书',
      visuals: '图形由已核验数据程序生成并检查数值、比例、单位与标签；无法验证时使用数值表',
    },
    agent_rules: [
      '建模与 QUBO 校验应在用户电脑上完成；LLM 宿主处理业务描述与附件是否联网取决于宿主',
      '不得索要用户在对话中粘贴 API Key；概念解释和符号建模无需安装或配置凭据',
      '不重复追问已知信息；缺实例数据可先给符号模型，只阻断依赖该数值的矩阵编译',
      '目标权重或软约束可能改变推荐时不能套行业默认；给标注假设的条件方案并确认相关业务选择',
      '云求解前取得用户对业务范围、目标约束、数据外发、付款选择与任务执行摘要的明确确认，后台关联 model_sha256 与参数',
      '用户说“再次求解”或“重跑”只是新任务意图，不当作最终确认。即使模型、参数和付款均不变，也必须先展示本次摘要（沿用或变化、付款来源、再次消耗），再询问并等待用户后续明确确认；确认仅用于本次任务。poll/get 查询已有任务不需要新求解确认；受理不明时 poll/get 仅读本地记录，需控制台或平台支持核对远端，不重提。这是 Agent 与 Host 必须遵守的对话规范；实际强制拦截仍需 Host 权限策略配合，MCP 代码不能验证人类授权，不增加 confirmed 字段或确认 token',
      'solver_options.use_credit 必须为用户明确选择的 true（算力券）/false（账户余额）；缺少选择先询问，不得自动切换付款方式。读取历史任务用 poll/get；付款或其他参数变化后重新确认，先核查原任务，不能换幂等键绕过状态保护',
      '模型、变量含义、offset 或求解参数变化后重新确认；只有 recovery.same_key_retry_allowed=true 才能同模型同参数同键重试；unknown 不可原键或换键重提，rejected 原键占用须修正原因并经新任务确认。幂等键只在本地去重，不保证远端去重或费用；observation 标明本次读取来源',
      '执行与计费必须分开说明：只信受信 Adapter 产生的 execution_mode（simulation/live/unknown）及 billing.status，不从任务 ID、mock 前缀、路径或任意文本猜测。simulation 是模拟结果，不是真实云任务，billing.status=not_applicable 不发生真实计费；live 或 unknown 且 billing.status=unverified 时没有平台账单证据，不能声称已扣费或确认未扣费。付款参数 use_credit、calculate_count 计算次数和任务 succeeded 都不是扣费证据；当前工具不查询账单',
      '配置只按结构化结果描述：simulation/configured=false/credential_effect=not_written/no_real_credentials=true 表示模拟，未写入用户真实 Key；unknown 表示证据不足，既不能说已配置也不能说没有 Key。live 的 status=configured 与 credential_effect=written 只证明本次本地保存，status=already_configured 与 already_present 只证明当前运行时已有配置，可能来自环境变量，不能说本次刚保存或此前磁盘已有 Key。remote_verification=unverified 不证明远端 Key 有效、鉴权成功或可求解',
      'credential_presence=not_checked 表示本操作没有检查既有凭据，不能据此声称用户缺 Key、只缺真实凭据或运行环境已经齐备；no_real_credentials=true 仅表示本操作未接触真实凭据，绝不表示用户全局没有 Key。credential_presence=available 仅指当前运行时有可读取的本地配置，不证明远端有效。',
      '普通用户默认业务摘要；变量、矩阵、hash 与详细日志按需提供，专业技术交付要求完整满足',
      '本引导不编译模型、不执行业务验证；结构或交付校验通过不证明业务等价、可行性或证据真实性',
    ],
  };
}

module.exports = { modelingGuide };
