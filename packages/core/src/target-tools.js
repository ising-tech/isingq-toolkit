'use strict';

const { QUBO_INPUT_SCHEMA } = require('./qubo');
const { LOCAL_SOLVER_MODE_GUIDANCE, LOCAL_MANAGEMENT_CONFIRMATION_GUIDANCE, NUMERIC_MODEL_GUIDANCE, RESULT_INTERPRETATION_GUIDANCE,
  LOCAL_PREPARATION_PRESENTATION_GUIDANCE } = require('./modeling');
const TARGET_QUBO_SCHEMA = { ...QUBO_INPUT_SCHEMA, description: NUMERIC_MODEL_GUIDANCE, properties: { ...QUBO_INPUT_SCHEMA.properties,
  num_bits: { type: 'integer', minimum: 1, description: '实际编码维度；按所选目标能力及客户端容量独立校验，legacy入口仍使用原2048限制。' } } };
const TARGET_SCHEMA = { type: 'object', properties: { kind: { type: 'string', enum: ['cloud', 'local'] },
  environment: { type: 'string', enum: ['sit', 'prod'] }, computer_type_id: { type: 'integer', minimum: 1 }, profile_id: { type: 'string' } },
required: ['kind'], additionalProperties: false, oneOf: [
  { type: 'object', properties: { kind: { const: 'cloud' }, environment: { enum: ['sit', 'prod'] },
    computer_type_id: { type: 'integer', minimum: 1 } }, required: ['kind', 'environment', 'computer_type_id'], additionalProperties: false },
  { type: 'object', properties: { kind: { const: 'local' }, profile_id: { type: 'string' } },
    required: ['kind', 'profile_id'], additionalProperties: false },
] };
const OPTIONS_SCHEMA = { type: 'object', description: '云端calculate_count/post_process整数0|1/use_credit显式boolean；本地传{}使用默认配置，task_mode仅供高级兼容/诊断，普通流程不询问或展示。字段不跨目标混用，推荐不自动套用。',
  properties: { calculate_count: { type: 'integer', minimum: 1 }, post_process: { type: 'integer', enum: [0, 1] },
    use_credit: { type: 'boolean' }, task_mode: { type: 'integer', enum: [0, 1, 2], description: LOCAL_SOLVER_MODE_GUIDANCE }, computer_type_id: { type: 'integer', minimum: 1 }, question_type: { type: 'integer', const: 1, enum: [1] } },
  additionalProperties: false };
const SHARED = { target: TARGET_SCHEMA, qubo: TARGET_QUBO_SCHEMA, solver_options: OPTIONS_SCHEMA };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
function schema(properties, required = []) { return { type: 'object', properties, required, additionalProperties: false }; }
const TARGET_TOOL_DEFINITIONS = [
  { name: 'isingq_solver_targets_list', title: '查看云端与本地求解目标',
    description: '在同一求解确认环节给出可选目标与初步建议。公开云目录匿名读取；本地来自具名配置。推荐不是白名单，未被推荐仍可选，建议可延迟或忽略，不覆盖用户选择、不自动改参数。include_cloud=false可只读本地列表，无需等待云目录。零／一／多台本地配置均展示 local.management 的“添加／管理本地求解器”操作；管理操作不是求解目标，仅看目录不启动管理页。用户管理返回后重读最新本地列表，保留模型与已有合法选择，不自动改选或提交。仅看目录或建议不提交任务。',
    inputSchema: schema({ environment: { type: 'string', enum: ['sit', 'prod'], default: 'prod' }, qubo: TARGET_QUBO_SCHEMA,
      solver_options: OPTIONS_SCHEMA, include_cloud: { type: 'boolean', default: true } }), annotations: READ },
  { name: 'isingq_target_solve_prepare', title: '准备所选求解目标',
    description: LOCAL_PREPARATION_PRESENTATION_GUIDANCE + '用户在求解确认环节选择具体云机型或本地连接后，独立核对能力、文件、表示与参数，只读检查，不上传或创建。ready=false保留选择并说明具体硬性问题。ready=true的preparation_token仅绑定本次准备依据，不证明用户授权；建议无需接受，也不增加接受建议的确认轮次。' + LOCAL_MANAGEMENT_CONFIRMATION_GUIDANCE,
    inputSchema: schema(SHARED, ['target', 'qubo', 'solver_options']), annotations: READ },
  { name: 'isingq_target_solve_start', title: '按本次明确选择提交求解',
    description: '仅在Host已展示本次业务范围、目标、数据去向及按 target.kind 适用的资源影响摘要（本地为设备占用，不主动展示模式或内部后处理，不展示云费用或付款选择；云端展示适用参数并保留显式付款规则）并取得用户明确确认后调用。保留用户选择，选后建议不覆盖、不阻塞、不增加接受建议轮次。prepare返回的token绑定依据，目标/模型/参数/能力/报价变化须重核适用确认；token不是人类授权证明。每次逻辑任务用稳定幂等键，受理未知先核查原服务，不自动换目标、换键或盲目重提。历史查询使用原poll/get。',
    inputSchema: schema({ ...SHARED, preparation_token: { type: 'string', pattern: '^prep_[a-f0-9]{64}$' },
      model_summary: { type: 'string', minLength: 1, maxLength: 8000 }, idempotency_key: { type: 'string', minLength: 1, maxLength: 200 } },
      ['target', 'qubo', 'solver_options', 'preparation_token', 'model_summary', 'idempotency_key']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'isingq_solver_profiles_list', title: '查看具名本地连接',
    description: '只读列出当前用户/运行环境的本地连接，不创建任务，不推断网络可达或设备可提交。',
    inputSchema: schema({}), annotations: { ...READ, openWorldHint: false } },
  { name: 'isingq_solver_profiles_save', title: '保存本地求解器连接',
    description: '保存名称、实际求解服务地址及可选网页地址；新增/编辑仅写配置，不连接设备、不提交任务。已有连接需要原稳定id及revision，防止覆盖同时编辑。基础信息不依赖高级矩阵合同。秘密凭据不进入本工具或普通配置，不能传入云Key。',
    inputSchema: schema({ profile: { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'integer', minimum: 1 },
      name: { type: 'string', minLength: 1, maxLength: 120 }, api_base_url: { type: 'string' }, web_base_url: { type: ['string', 'null'] },
      contract: { type: 'object', description: '仅由维护者按设备已核实部署约定提供；不从文档示例或当前状态补造。', additionalProperties: true } },
      required: ['name', 'api_base_url'], additionalProperties: false } }, ['profile']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'isingq_solver_profiles_delete', title: '移除本地连接配置',
    description: '只移除本地连接，保留历史任务与提交时来源；不等于取消、删除或重算设备任务。',
    inputSchema: schema({ profile_id: { type: 'string' } }, ['profile_id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } },
  { name: 'isingq_solver_config_open', title: '打开本地求解器配置页',
    description: '按需启动有期限的本机loopback配置页并立即返回入口，不阻塞MCP或CLI。用户可录入/编辑名称与服务地址，保存不提交、取消不写入；样式确认与基础录入独立。返回实际 url，由实际 Host 支持打开或提供可点击入口，不让用户手拼地址；管理返回后重新读取本地目标列表，保留模型与合法选择，不自动提交。仅在Toolkit运行的本机浏览器访问，不把它当设备任务页面。',
    inputSchema: schema({}), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'isingq_solve_records_list', title: '逐笔查看求解调用记录',
    description: '读取云端/本地混合记录的原目标和查阅依据，分页读取。当前选择或配置改名/改址/删除不重写历史。旧缺来源记录明确未知，不用当前环境补填；打开网页不新建/重算任务。v2回执须消费result_interpretation说明结果证据边界。' + RESULT_INTERPRETATION_GUIDANCE,
    inputSchema: schema({ limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }, offset: { type: 'integer', minimum: 0, default: 0 } }),
    annotations: { ...READ, openWorldHint: false } },
  { name: 'isingq_target_delivery_validate', title: '按本次目标校验QUBO交付',
    description: '纯本地复用原交付数学与摘要校验，先核对document.qubo与该笔调用模型一致，按该目标已用规模解码/复算，避免新目标上传后被旧2048全局限制拦住。不证明业务完整、测试真实或人类授权，不再提交。',
    inputSchema: schema({ solve_id: { type: 'string' }, document: { type: 'object', description: '原isingq-delivery-v1交付文档，qubo须与该笔记录一致。' } }, ['solve_id', 'document']),
    annotations: { ...READ, openWorldHint: false } },
];
function validateTargetToolArguments(name, args) {
  const tool = TARGET_TOOL_DEFINITIONS.find(value => value.name === name);
  if (!tool) return false;
  if (!args || Array.isArray(args) || typeof args !== 'object') throw Object.assign(new Error('工具参数必须是object'), { code: 'target_input_invalid' });
  const unknown = Object.keys(args).filter(key => !Object.hasOwn(tool.inputSchema.properties, key));
  const missing = tool.inputSchema.required.filter(key => !Object.hasOwn(args, key));
  if (unknown.length || missing.length) throw Object.assign(new Error('工具参数字段不匹配（unknown=' + unknown.join(',') + ', missing=' + missing.join(',') + '）'), { code: 'target_input_invalid' });
  return true;
}
module.exports = { TARGET_QUBO_SCHEMA, TARGET_TOOL_DEFINITIONS, validateTargetToolArguments };
