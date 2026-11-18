'use strict';

const { QUBO_INPUT_SCHEMA, QUBO_TRANSPORT_BOUNDARY } = require('./qubo');
const { LOCAL_DEFAULT_TASK_MODE } = require('./local-target');

// These rules are shared by the guide, MCP initialization and public task_mode schema.
const LOCAL_SOLVER_MODE_GUIDANCE = `本地 solver_options.task_mode 缺省由 Core 统一规范化为${LOCAL_DEFAULT_TASK_MODE}（精准），MCP普通调用传solver_options={}即可。普通业务流程不询问、不主动展示求解模式、三档区别或服务器后处理；提交摘要只保留必要业务、目标、数据去向与设备占用，技术细节仅在用户主动查询时解释。底层兼容/诊断的显式合法高级参数及历史参数原样保留，不被新默认覆盖；不把“快点”等自然语言当作切换到0的技术指令。实际参数保留在工具原始JSON和记录供追溯；默认精准不保证最优、不承诺性能或精度无损，不改变硬件bit精度，不代表已修复设备问题。`;
const LOCAL_MANAGEMENT_CONFIRMATION_GUIDANCE = '本地 prepare 的 ready=true／false 均保留 local.management 操作；不能在准备或最终确认时丢失管理入口。实际 Host 使用问答表单时，最终提交确认必须提供“先添加／管理本地求解器”，与“确认提交”“暂不提交”并列为操作分支；ready=false 时仍保留管理与暂不提交，未就绪不能提交。Host 无按钮时提供明确自然语言管理动作，不编造 tool:// 链接，不预先启动页面。只有用户选择管理才调用现有 isingq_solver_config_open；管理返回后刷新本地列表，保留模型、已有合法目标与已选高级参数，按需重新 prepare 本次依据，不增加接受建议轮次，不再次询问模式，保存不提交。';
const LOCAL_MANAGEMENT_ACTION = Object.freeze({ label: '添加／管理本地求解器', tool: 'isingq_solver_config_open',
  arguments: Object.freeze({}), creates_task: false });
const LOCAL_PREPARATION_PRESENTATION_GUIDANCE = '本地 prepare 返回后，必须优先按 presentation 投影生成普通用户摘要与操作选择，不从审计字段自行拼展示清单。使用 presentation.summary 的实际目标、数据去向、设备占用及就绪／阻断说明，并补入 Host 当前任务中已知的业务范围；不得杜撰业务条件。完整呈现 presentation.actions 中的确认求解、先添加／管理本地求解器、暂不提交三种操作；未就绪时不得执行确认，Host无按钮时用明确自然语言提供三种操作。audit_only_fields 保留技术追溯，普通摘要不主动展示其中的模式／内部后处理；用户主动查询技术细节时才能按原始JSON解释。prepare只读检查，不上传矩阵、不创建任务；只有本次明确确认后才可向投影所列本地地址发送矩阵并占用设备，准备令牌与展示投影均不证明用户授权。';
function localPreparationPresentationPolicy() {
  return {
    contract_version: 'isingq-local-preparation-presentation-v1', audience: 'normal_user',
    show_solver_mode: false, show_server_postprocessing: false, must_show_all_actions: true,
    requires_current_task_authorization: true, preparation_proves_authorization: false,
    audit_only_fields: ['solver_options', 'preparation_token', 'matrix', 'file', 'device', 'encoding',
      'adapter_version', 'effective_contract', 'declared_constraints', 'precision', 'client_capacity', 'billing'],
    actions: [
      { id: 'confirm_submit', label: '确认按当前目标求解', tool: 'isingq_target_solve_start', creates_task: true,
        requires_current_task_authorization: true },
      { id: 'manage_local_solvers', ...structuredClone(LOCAL_MANAGEMENT_ACTION), label: '先' + LOCAL_MANAGEMENT_ACTION.label },
      { id: 'defer', label: '暂不提交', creates_task: false },
    ],
    description: LOCAL_PREPARATION_PRESENTATION_GUIDANCE,
  };
}
const RESULT_INTERPRETATION_GUIDANCE = '云端与本地结果采用相同证据边界：合法位串及原 QUBO 复算只说明该候选在声明域／维度下的值；单点 energy 加 offset 与原 QUBO 值一致，只证明该点数值吻合，不能证明 provider 内部未缩放、量化、截断，不能排除转换／极性问题，也不能证明整体模型、罚权或转换完整正确及真实硬件执行方式。client_quantization=none 仅表示客户端未量化，不等于 provider 未量化；结果接口未声明的 provider 内部处理为 unknown。不从 8bit 推算系数范围、量化步长或声称某个小系数模型正好适配／无损。不可行或非最优候选按已核验的业务约束与证明范围说明，原因未定，不把采样／退火未收敛认定为唯一原因，也不据单点吻合排除精度或其他问题。succeeded 仅为提供方执行与结果合同的技术状态，不等于业务可行或最优。保留原矩阵和记录，不自行生成、替换或离线试算新模型作为修复，除非用户另行要求且有实际依据；可以提议继续定位或询问是否另行建模，不凭 bit 猜测提出确定适配方案。首次正常建模与另获授权且有依据的改模仍可进行，实质变化后仍核验业务等价性、生成最终 CSV、重新 prepare 并更新适用确认。';
function resultInterpretationPolicy() {
  return {
    contract_version: 'isingq-result-interpretation-v1', scope: 'returned_vector_and_energy_only',
    vector_validation_scope: 'declared_domain_and_dimension',
    recomputation_scope: 'returned_candidate_under_original_qubo',
    energy_agreement_scope: 'single_candidate_value_only',
    provider_internal_processing: 'unknown', provider_fault_cause: 'undetermined',
    client_quantization_scope: 'client_only_not_provider',
    business_feasibility: 'not_assessed_by_core', global_optimality: 'not_assessed_by_core',
    task_status_scope: 'technical_provider_and_result_contract', automatic_remodeling_authorized: false,
    description: RESULT_INTERPRETATION_GUIDANCE,
  };
}
const NUMERIC_MODEL_GUIDANCE = '云端与本地采用相同服务边界：基础连接与已知 QUBO 协议可进入标准准备，仍严格检查实际 maxScale、文件容量及已明确声明的系数范围／格点限制。maxPrecision=8bit 只是设备展示的计算精度，不据此推导上传系数必须在 ±127 内或只能为整数。未声明的系数／量化规则如实标记未知，不据此判不兼容或阻断普通准备／提交，不要求普通用户提供完整硬件内部算法。Toolkit 不自动缩放、量化、截断；不根据 bit 精度或离线猜测修改既有模型、惩罚权重、辅助位、编码或业务条件。离线量化模拟仅是明确标注假设的独立实验，不是设备能力证据，也不是擅自改模理由。设备明确拒绝或结果异常时按原接口证据定位，保留原矩阵和记录，不自动回退、重编码或重提。首次正常构造 QUBO 和惩罚权重仍允许，但须有业务及数学依据；用户主动要求或确有已声明限制需要重建模时，说明实质变化、核验业务等价性，生成新模型与最终 CSV，重新 prepare 并更新适用确认，不沿用旧提交依据。ready 只表示已检查当前可核对的合同，不证明精度无损；完整数值／量化算法及独立参考仅在实施客户端数值变换或承诺无损／精度适配时才是前提，不作为普通提交前置。';
const EXECUTION_BILLING_GUIDANCE = '执行与计费必须分开说明：只信受信 Adapter 产生的 execution_mode（simulation/live/unknown）及 billing.status，不从任务 ID、mock 前缀、路径或任意文本猜测。只有 execution_mode=simulation 才称模拟结果，不是真实设备执行，simulation 的 billing.status=not_applicable；本地 target.kind=local 的 billing.status=not_applicable 仅指云平台计费不适用，不能反推模拟或全部成本为0。仅云目标 live 或 unknown 且 billing.status=unverified 时没有平台账单证据，不能声称已扣费或确认未扣费。付款参数 use_credit、calculate_count 计算次数和任务 succeeded 都不是扣费证据；当前工具不查询账单';
const TARGET_GUIDANCE = [
  '新求解目标使用显式 target_submit：在同一求解确认环节用 isingq_solver_targets_list 展示云端／本地选项与初步建议，选后建议可忽略、不改选、不自动套参数、不阻塞选择或增加接受建议轮次。isingq_target_solve_prepare 只独立核对硬性条件，ready=false 保留选择并说明问题；ready=true 的 preparation_token 只绑定目标／模型／参数／能力／适用报价，不证明人类授权。展示本次业务范围、目标设备、数据去向与适用资源影响；云端另展示适用参数，本地模式仅留工具JSON供追溯，获得明确确认后才调用 isingq_target_solve_start；实质内容变化才重核适用确认，单纯建议刷新不使确认失效。每笔记录随实际请求目标，用 records_list 及原 poll/get 续查，改配置不改变历史；目标交付使用 isingq_target_delivery_validate 绑定实际 solve_id。以下 cloud_submit 是 legacy 云兼容指导，不能在新目标缺省或能力缺失时自动回退；legacy 无确认 token 的约束不排除新目标准备依据哈希。',
  '同一求解确认环节在零／一／多台本地配置下始终展示“添加／管理本地求解器”操作，读取 local.management，管理操作不是求解目标；零配置按需引导新增，概念解释或仅建模不要求配置设备。用户选择管理后调用 isingq_solver_config_open，使用返回的实际 URL，由实际 Host 支持打开或提供可点击入口，不要求用户知道工具名或手拼地址；仅列目标不启动管理服务。保存不提交，取消不写入；管理返回后重新调用 isingq_solver_targets_list（只刷新本地可用 include_cloud=false），保留模型与已有合法选择，不自动改选或提交；原选择已删除或失效时说明具体问题并请用户选择，不替用户选。',
  'target_submit 按 target.kind 分流：target.kind=local 的准备、确认、提交、结果与异常流程不展示云费用明细或算力券／余额选择，不索取云 Key；本地摘要说明业务、实际设备、数据去向与设备占用；本地重跑也须先展示本次摘要并取得本次执行的明确确认，不沿用上一任务授权。本地 billing.status=not_applicable、scope=cloud_platform、reason=local_target 只表示云平台计费不适用，平台不计费不等于模拟，也不证明所有本地部署全部成本为0。切换到本地时移除不适用云参数及待处理付款项，保留模型与合法的本地选择并重新核对实际参数；仅 target.kind=cloud 或 legacy cloud_submit 适用云 Key、报价与显式付款规则。',
  LOCAL_SOLVER_MODE_GUIDANCE,
  LOCAL_MANAGEMENT_CONFIRMATION_GUIDANCE,
  LOCAL_PREPARATION_PRESENTATION_GUIDANCE,
  NUMERIC_MODEL_GUIDANCE,
  RESULT_INTERPRETATION_GUIDANCE,
];

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
      target_submit: { requires_runtime: true, requires_api_key: 'selected_target_only', requires_explicit_authorization: true, selection_stage: 'solve_confirmation', advice_blocks_selection: false },
    },
    data_readiness: {
      symbolic_model: { allows_missing_instance_values: true, requires: 'decision_and_objective_constraint_semantics_or_labeled_conditional_models' },
      numeric_matrix: { requires_validated_instance_values: true, requires: 'values_dimensions_domains_and_confirmed_material_weights' },
      cloud_submission: { requires_confirmed_model: true, requires: 'validated_matrix_capabilities_credentials_and_cloud_authorization' },
      block_only_dependent_steps: true,
      repeat_known_questions: false,
      silent_business_defaults: false,
    },
    update_policy: { mode: 'runtime_background', automatic_tool_call: false, notice_field: 'update_notice', when: 'after_primary_task_result', user_response_required: false, silent_when_notice_absent: true, automatic_install: false, failure_blocks_work: false },
    confirmation_policy: {
      business_summary: ['decision_scope', 'objectives_and_constraints', 'data_egress', 'applicable_resource_impact', 'task_execution'],
      by_target: {
        cloud: ['target', 'solver_options', 'data_egress', 'payment_choice', 'applicable_resource_impact', 'task_execution'],
        local: ['target', 'data_egress', 'device_occupancy', 'task_execution'],
      },
      binding: 'model_sha256_and_solver_options',
      requires_matrix_literacy: false,
      details: 'on_request_or_technical_delivery',
      enforcement: 'agent_and_host_only_no_tool_confirmation_parameter',
    },
    target_guidance: [...TARGET_GUIDANCE],
    solver_mode_policy: {
      user_label: '求解模式', parameter: 'solver_options.task_mode', provider_parameter: 'taskMode',
      default: LOCAL_DEFAULT_TASK_MODE, default_policy: 'local_precise_default', ask_user: false, show_in_normal_flow: false,
      reuse_explicit_choice: true,
      description: LOCAL_SOLVER_MODE_GUIDANCE,
    },
    local_preparation_presentation_policy: localPreparationPresentationPolicy(),
    numeric_model_policy: {
      applies_to: ['cloud', 'local'],
      infer_coefficient_range_from_bit_precision: false,
      undeclared_limits_block_standard_preparation: false,
      automatic_client_numeric_transformation: false,
      speculative_model_changes_allowed: false,
      ready_proves_lossless_precision: false,
      initial_model_construction_allowed: true,
      description: NUMERIC_MODEL_GUIDANCE,
    },
    result_interpretation_policy: resultInterpretationPolicy(),
    result_evidence: {
      execution_and_billing: EXECUTION_BILLING_GUIDANCE,
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
      ...TARGET_GUIDANCE,
      '先分流 explain / model_only / local_validate / target_submit / legacy cloud_submit；只执行用户请求的阶段',
      '复用已知信息，按 symbolic_model / numeric_matrix / cloud_submission 判断缺项，只阻断依赖步骤',
      '定义二进制变量，为每个 index 提供 name 与 meaning；条件模型显式标注假设',
      '把目标与已确认约束展开为 QUBO，说明编码、惩罚项与权重依据，不静默代定业务偏好',
      '需要本地校验时检查兼容 capability 后调用 isingq_qubo_validate，获取 model_sha256 并在本轮任务上下文中保留；校验不保存求解记录',
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
        num_bits: 'legacy校验1到2048；显式目标按当前能力和客户端容量核对',
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
      '云求解前取得用户对业务范围、目标约束、数据外发、付款选择与任务执行摘要的明确确认，Agent 在本轮上下文中关联校验返回的 model_sha256 与参数',
      '仅云目标（含 legacy cloud_submit）：用户说“再次求解”或“重跑”只是新任务意图，不当作最终确认。即使模型、参数和付款均不变，也必须先展示本次摘要（沿用或变化、付款来源、再次消耗），再询问并等待用户后续明确确认；确认仅用于本次任务。poll/get 查询已有任务不需要新求解确认；受理不明时 poll/get 仅读本地记录，需控制台或平台支持核对远端，不重提。这是 Agent 与 Host 必须遵守的对话规范；实际强制拦截仍需 Host 权限策略配合，MCP 代码不能验证人类授权，不增加 confirmed 字段或确认 token',
      '仅云目标（含 legacy cloud_submit）的 solver_options.use_credit 必须为用户明确选择的 true（算力券）/false（账户余额）；缺少选择先询问，不得自动切换付款方式。读取历史任务用 poll/get；付款或其他参数变化后重新确认，先核查原任务，不能换幂等键绕过状态保护',
      '模型、变量含义、offset 或求解参数变化后重新确认；只有 recovery.same_key_retry_allowed=true 才能同模型同参数同键重试；unknown 不可原键或换键重提，rejected 原键占用须修正原因并经新任务确认。幂等键只在本地去重，不保证远端去重或费用；observation 标明本次读取来源',
      EXECUTION_BILLING_GUIDANCE,
      '配置只按结构化结果描述：simulation/configured=false/credential_effect=not_written/no_real_credentials=true 表示模拟，未写入用户真实 Key；unknown 表示证据不足，既不能说已配置也不能说没有 Key。live 的 status=configured 与 credential_effect=written 只证明本次本地保存，status=already_configured 与 already_present 只证明当前运行时已有配置，可能来自环境变量，不能说本次刚保存或此前磁盘已有 Key。remote_verification=unverified 不证明远端 Key 有效、鉴权成功或可求解',
      'credential_presence=not_checked 表示本操作没有检查既有凭据，不能据此声称用户缺 Key、只缺真实凭据或运行环境已经齐备；no_real_credentials=true 仅表示本操作未接触真实凭据，绝不表示用户全局没有 Key。credential_presence=available 仅指当前运行时有可读取的本地配置，不证明远端有效。',
      '普通用户默认业务摘要；变量、矩阵、hash 与详细日志按需提供，专业技术交付要求完整满足',
      '本引导不编译模型、不执行业务验证；结构或交付校验通过不证明业务等价、可行性或证据真实性',
    ],
  };
}

module.exports = { modelingGuide, LOCAL_SOLVER_MODE_GUIDANCE, LOCAL_MANAGEMENT_CONFIRMATION_GUIDANCE, NUMERIC_MODEL_GUIDANCE,
  RESULT_INTERPRETATION_GUIDANCE, resultInterpretationPolicy, LOCAL_MANAGEMENT_ACTION,
  LOCAL_PREPARATION_PRESENTATION_GUIDANCE, localPreparationPresentationPolicy };
