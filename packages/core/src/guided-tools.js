'use strict';
const { QUBO_INPUT_SCHEMA } = require('./qubo');
const { RESULT_REVIEW_GUIDANCE, RESULT_REVIEW_SCHEMA, RESULT_REVIEW_GUIDE } = require('./guided-result-review');
const { verificationCapacity } = require('./math-model');
const { REVIEW_FILE_SCHEMA } = require('./review-file');
const QUBO = { ...QUBO_INPUT_SCHEMA, properties: { ...QUBO_INPUT_SCHEMA.properties, num_bits:{type:'integer',minimum:1,description:'当前业务模型的实际二进制变量数，按所选目标核对能力。'} } };
const QUBO_FILE = {type:'object',description:'model／新prepare与qubo恰好二选一。大模型由本地建模程序生成qubo.json和SHA256，只传文件描述；Toolkit读取同一份字节并校验摘要，不在工具参数或聊天展开矩阵。',properties:{
  path:{type:'string',minLength:1,pattern:'^[^\\u0000-\\u001f\\u007f]+$',description:'Toolkit运行主机上的普通本地UTF-8 JSON文件路径；拒绝末级符号链接和非普通文件。'},
  sha256:{type:'string',pattern:'^[a-f0-9]{64}$',description:'该文件实际字节的完整小写SHA256，必填；由本地建模程序计算。'},
},required:['path','sha256'],additionalProperties:false};
const QUBO_FILE_FLOW = '较大模型从原业务文件通过本地建模程序生成qubo.json并计算实际字节SHA256，model／新prepare用qubo_file:{path,sha256}代替inline qubo，二者恰好选一个；文件位于Toolkit运行主机，无需聊天或工具参数展开矩阵。review_file仅是业务核验来源，不能代替QUBO输入。';
const ORDINARY_PREPARATION_FLOW = '用户明确要求准备求解时直接prepare，同时导出产物并准备目标；model仅用于只建模／只导出意图，不是求解前强制轮次，也不增加模型接受确认。prepare后先完成用户已经明确的业务选择。返回选项与用户指定的名称和来源无歧义相符时，沿该项现成call继续准备，不重复追问已知选择；已有明确付款选择也沿对应call复用，不代选资金、不擅自改变目标。选择不等于提交。在提交前准备阶段，仅在真正缺少目标或付款选择、遇到硬性阻断，或ready等待本次执行明确确认时，才呈现reply及全部动作并等待用户。';
const ORDINARY_INSTRUCTIONS = '这是伊辛智能 IsingQ 的业务建模与求解工具。先保留用户目标、约束和变量含义，由宿主Agent生成并核对当前业务QUBO。只需建模／导出时用isingq_solve的model，无需设备或云权限。首次建模和准备呈现modeling正文及本机文件入口，再附本步reply和操作；纯进度／历史无需重发公式。投资组合、路径规划、排程等问题均按原始业务条件核验。求解只用 isingq_solve：先prepare。' + QUBO_FILE_FLOW + ORDINARY_PREPARATION_FLOW + '本次明确确认后才能confirm；准备、查看、管理或“快点”均不是提交授权。结果只是候选，按原始业务约束核验，不保证最优，不猜设备内部原因，不擅自改模重提。云端付款来源由用户明确选择；仅云服务需要个人凭据时使用安全配置入口，不在对话中接收秘密。普通结果若带update_notice，仅在末尾简述；不主动检查更新。';
const GUIDED_TOOL_DEFINITION = {
  name:'isingq_solve',title:'准备、确认与查看本次业务求解',
  description:'建模产物与业务求解使用同一方法。model只做本机QUBO校验及三文件导出，不读目标、设备或凭据；要求求解准备时直接prepare，同时导出与准备，不必先model。model/prepare可提供model_markdown作为变量、业务目标、约束和公式说明；模型数学信息属于正常产物。首次建模／准备呈现modeling正文及实际文件入口，再附reply和全部操作；不要只剩求解摘要。结果reply是程序生成的本步业务回复，actions含完整业务label及现成call。' + ORDINARY_PREPARATION_FLOW + '只有用户明确确认当前内容才执行confirm；现成call不是授权证明。准备／管理／查询不提交，cancel仅停止提交前准备，受理未知不重建。',
  inputSchema:{type:'object',properties:{
    action:{type:'string',enum:['model','prepare','choose','funding','confirm','status','review','history','manage','refresh','cancel']},
    review:RESULT_REVIEW_SCHEMA,
    review_file:REVIEW_FILE_SCHEMA,
    model_markdown:{type:'string',maxLength:200000,description:'Agent撰写的业务变量、目标、约束与数学公式说明，原样绑定本次模型。公式使用LaTeX行内$...$或独立$$...$$数学块（如\\sum、x_{10}），不用普通Σ_文本或代码围栏冒充数学排版。不是求解器内部参数；省略时只导出已知QUBO表达并标注业务语义未知。'},
    qubo:QUBO,qubo_file:QUBO_FILE,problem_summary:{type:'string',minLength:1,maxLength:8000,description:'model/prepare时用简短自然语言说明当前业务目标与约束；不重复QUBO系数、编码清单或能量推断。完整模型由qubo或qubo_file提供。'},
    preferred_target:{type:'string',maxLength:120,description:'prepare时可填用户指定的设备名称；来源由返回选项核对。若仍返回选项，先按已经明确且无歧义的名称／来源选择对应call继续准备。'},
    confirmation_ref:{type:'string',description:'直接使用现成确认call中的不透明内容版本关联；不能跨摘要复用，也不是人工授权证明。'},
    request_id:{type:'string',description:'来自返回动作call.arguments的不透明关联；直接执行现成call，不向用户单独展示或自行构造。'},
    target_id:{type:'string',description:'choose时直接使用本次返回的目标选项标识。'},
    payment:{type:'string',enum:['credits','balance'],description:'仅付费云目标funding使用：用户明确选择算力券或账户余额。'},
    solve_id:{type:'string',description:'status/review查看历史任务时使用原记录标识；与request_id二选一。'},
    limit:{type:'integer',minimum:1,maximum:1000},offset:{type:'integer',minimum:0},
  },required:['action'],additionalProperties:false,allOf:[{if:{properties:{action:{enum:['model','prepare']}},required:['action'],not:{required:['request_id']}},then:{oneOf:[{required:['qubo'],not:{required:['qubo_file']}},{required:['qubo_file'],not:{required:['qubo']}}]}}]},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
};
function ordinaryModelingGuide(problemSummary='') {
  return {scope:'business_modeling',problem_summary:String(problemSummary||'').trim(),
    steps:['保留用户明确给出的目标、约束、数值和单位；缺少信息只阻断依赖步骤，不代定业务偏好。','定义二进制变量并保留每个变量的业务含义，按目标与约束构造QUBO，说明惩罚权重依据；业务公式用LaTeX行内$...$或独立$$...$$数学块。','仅建模／导出用isingq_solve的model；完整呈现modeling正文、公式及真实文件入口。要求求解准备时直接prepare，同时导出模型并准备目标；只有先前仅建模后再要求求解，才沿已有模型的准备call继续。' + ORDINARY_PREPARATION_FLOW,'用户明确确认本次摘要后继续同一请求；结果按原业务约束复核，未找到可行解不等于问题不可行。'],
    result_review:{...structuredClone(RESULT_REVIEW_GUIDE),capacity:verificationCapacity(),file_support:{
      export_helper:'writeMathModelReviewFile',sdk:'@ising-tech/isingq-core',
      workflow:'原业务模型已有文件或较大时，建模程序用导出助手传入原qubo、model/data及可迭代terms/constraints；在model/prepare附带review_file导出回执，后续现成call自动携带。不要展开全部矩阵到聊天或工具参数，也不要用qubo.json冒充业务核验清单。',
      location:'文件位于Toolkit运行主机；不要求用户维护协议、摘要或额外确认页面。完整核验明细保存为新的本地产物，原任务和输入不改写。'}},
    objective:'offset + Σ linear[i]·x_i + Σ quadratic[i,j]·x_i·x_j，x_i ∈ {0,1}',qubo_input:QUBO,qubo_file_workflow:QUBO_FILE_FLOW,
    result_boundary:'位串和目标值是候选数据，不证明业务可行或全局最优；某点数值吻合不能排除提供方内部处理问题，也不是擅自修改原模型的依据。'};
}
function ordinaryResource(uri) {
  if(uri==='isingq://modeling/qubo') return {uri,mimeType:'text/markdown',text:JSON.stringify(ordinaryModelingGuide(),null,2)};
  if(uri==='isingq://security/data-flow') return {uri,mimeType:'text/markdown',text:'业务建模由宿主Agent完成，业务对话与附件是否联网由宿主决定。QUBO校验、准备与产物由Toolkit运行主机处理。准备与连接管理不上传矩阵、不创建任务；只有本次明确确认后，矩阵才发往摘要中的所选云端或本地求解服务。云付款由用户选择，本地不要求云凭据。秘密只通过安全配置入口输入，不进入对话。查询与历史使用原任务来源，受理未知不自动重提。'};
  return null;
}
function ordinarySetupResult(raw) {
  if(raw.execution_mode === 'simulation') return {configured:false,status:'simulation',message:'这是模拟配置结果，本次未保存真实凭据。',remote_verified:false,next_action:'真实云操作前通过安全入口核对配置。'};
  if(raw.execution_mode !== 'live' || raw.credential_presence !== 'available') return {configured:false,status:'unknown',message:'本次未能核实既有配置；不能据此断定用户没有凭据。',remote_verified:false,next_action:'通过安全配置入口核对当前运行位置的配置。'};
  const saved = raw.credential_effect === 'written';
  return {configured:true,status:saved?'saved':'available',message:saved?'本次已安全保存本机配置。':'当前运行位置已有可读取配置。',remote_verified:false,next_action:'远端有效性尚未验证；继续本次云求解准备并核对目标与付款。'};
}
module.exports={GUIDED_TOOL_DEFINITION:{...GUIDED_TOOL_DEFINITION,description:GUIDED_TOOL_DEFINITION.description+QUBO_FILE_FLOW+RESULT_REVIEW_GUIDANCE},ORDINARY_INSTRUCTIONS:ORDINARY_INSTRUCTIONS+RESULT_REVIEW_GUIDANCE,ORDINARY_PREPARATION_FLOW,ordinaryModelingGuide,ordinaryResource,ordinarySetupResult};
