'use strict';

const { decodeBits, storedObjectiveEnergy, storedQuboModelDigest } = require('./qubo');
const { verifyMathModelFile } = require('./review-file');
const { fields, array, integer, MathModelError, MATH_MODEL_INPUT_SCHEMA, createMathCandidateEvaluator, compareEvaluations, valueOf, assertVerificationInput } = require('./math-model');
const GUIDED_RESULT_REVIEW_CONTRACT_VERSION='isingq-guided-result-review-v1';
const RESULT_REVIEW_GUIDANCE='正常求解返回candidate_ready后，不以候选就绪作为最终答复：沿review现成call继续本地解码和业务复核，无需再询问用户是否解读，也不再次提交。Host从原建模上下文整理review.model（math-model-v1）、data及可选baseline；按原位索引使用x_0、x_1等变量，整数或其他编码通过bindings明确写出原解码表达式。程序从原记录取候选，不允许自行填写或替换本次赋值。仅在review现成call中补充业务核验信息，保留原关联不变。业务目标与QUBO含罚项的目标分开核对；不得反推或省略原约束来制造通过。缺原业务信息时保持未知，只补问业务缺项，不要求用户填写JSON、协议或内部参数。历史列表不批量复核。成功后直接呈现review返回reply中的完整方案、业务目标和约束复核，再基于这些事实解释业务含义；不只输出位串、状态或技术日志。模型内比较不说成实际收益，单个候选不声称全局最优；失败或不支持时保留原任务，说明未完成范围，不自动改模或重算。';
const RESULT_REVIEW_SCHEMA={type:'object',description:'原业务核验信息，由Host沿用建模上下文整理；不要求用户填写JSON。变量赋值由程序从原求解记录解码，不接收本次候选或自报结论。',
  properties:{model:{...MATH_MODEL_INPUT_SCHEMA,description:'既有math-model-v1；数值、变量含义和约束逐项沿用原业务模型。'},data:{type:'object',description:'原模型引用的平坦整数参数；没有参数时为{}。',additionalProperties:{type:'integer'}},baseline:{type:'object',description:'可选的同模型参考方案完整赋值，不是本次候选。',additionalProperties:{type:'integer'}},
    bindings:{type:'object',description:'可选的原编码映射，每个业务变量id对应一个math-model-v1表达式；变量引用原位x_0、x_1…，系数为整数常量。缺省时业务变量id直接对应原位。',additionalProperties:{type:'object',properties:{constant:{type:'integer'},terms:{type:'array',items:{type:'object',properties:{coefficient:{type:'integer'},variables:{type:'array',items:{type:'string'},minItems:1,maxItems:2}},required:['coefficient','variables'],additionalProperties:false}}},required:['terms'],additionalProperties:false}}},
  required:['model','data'],additionalProperties:false};
const RESULT_REVIEW_GUIDE={guidance:RESULT_REVIEW_GUIDANCE,model_contract:'math-model-v1',supported_scope:'finite_integer_model',capacity_scope:'完整model/data/baseline/bindings合计按UTF-8 JSON字节核验，数量按原模型完整保留，不按设备位数猜约束数。capacity属于宿主后台运行信息，正常业务答复不展开；超限时说明未完成范围并由维护者调整进程容量，不删减条件、不重新求解。',
  example:{model:{schema_version:'math-model-v1',id:'original-business',variables:[{id:'x_0',domain:'binary',label:'原变量含义'}],objective:{sense:'max',expression:{terms:[{coefficient:1,variables:['x_0']}]}},constraints:[{id:'original-limit',label:'原业务约束（须按原模型替换）',expression:{terms:[{coefficient:1,variables:['x_0']}]},relation:'le',rhs:1}]},data:{}},
  note:'示例仅说明结构，数值、约束和变量含义须沿用原建模，不把示例条件当实际需求。缺原业务信息或超出已有核验支持范围时保持未核验，不强行改写模型。'};

function bitIndex(id, count) {
  const match=typeof id==='string' && /^x_(0|[1-9][0-9]*)$/.exec(id);
  const index=match ? Number(match[1]) : -1;
  if(!Number.isSafeInteger(index) || index<0 || index>=count) {
    throw new MathModelError('review_mapping_required','review.bindings','变量须引用原位索引 x_0、x_1…，且不能超过原矩阵维度；请沿用原建模映射。');
  }
  return index;
}
function assignmentFrom(record,specification) {
  const assignment=Object.create(null),variables=specification.model.variables;
  if(specification.bindings===undefined) {
    for(const v of variables) assignment[v.id]=record.result.bits[bitIndex(v.id,record.qubo.num_bits)];
    return assignment;
  }
  fields(specification.bindings,variables.map(v=>v.id),[],'review.bindings');
  for(const variable of variables) {
    const expression=specification.bindings[variable.id],boundTerms=[];
    fields(expression,['terms'],['constant'],'review.bindings.'+variable.id);
    for(const term of array(expression.terms,'review.bindings.terms')) {
      fields(term,['coefficient','variables'],[],'review.bindings.term');
      const coefficient=integer(term.coefficient,'review.bindings.term.coefficient');
      const indices=array(term.variables,'review.bindings.term.variables',2).map(id=>bitIndex(id,record.qubo.num_bits));
      if(!indices.length) throw new MathModelError('unsupported','review.bindings.term.variables','每项需引用1到2个原位；纯常量请使用constant字段。');
      boundTerms.push([indices.every(index=>record.result.bits[index]===1)?coefficient:0,[]]);
    }
    // The original bits are known values. Resolve them without manufacturing
    // another user model that would be charged against the input capacity.
    // Preserve every term and its order, including zero terms; the shared exact
    // evaluator still checks each coefficient, accumulation and overflow.
    const constant=Object.hasOwn(expression,'constant')?integer(expression.constant,'review.bindings.constant'):0;
    // These are resolved constants in the evaluator's internal representation,
    // not new user model inputs. Charge the original bindings once, rather than
    // applying a second input quota to a generated temporary model.
    assignment[variable.id]=valueOf([constant,boundTerms],{},'review.bindings.'+variable.id).total;
  }
  return assignment;
}

function cell(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/[\\`*_{}\[\]()#!|]/g,'\\$&').replace(/[\r\n\u2028\u2029]/g,' ');
}
function rows(lines, headers, records, total = records.length, file = false) {
  lines.push('| '+headers.join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |');
  records.slice(0,40).forEach(row=>lines.push('| '+row.map(cell).join(' | ')+' |'));
  if(total>40) lines.push('',`另有 ${total-40} 项，完整数据保留在${file ? '完整核验明细文件' : '本次结果'}中。`);
  lines.push('');
}
function renderReview(review) {
  const lines=[];
  if(review.status==='needs_business_model') {
    lines.push('### 候选方案解码','');
    rows(lines,['变量','业务含义','值'],review.decoded.map(v=>[v.name,v.meaning || '未提供',v.value]));
    lines.push(`QUBO 目标复算值：${review.qubo_objective}。`,'',
      '该值可能包含罚项与常数；原业务目标和约束尚待复核。请沿用原建模信息完成本地核对，不需要重新提交求解。');
    return lines.join('\n');
  }
  const verdict=review.status==='feasible'?'本候选通过所声明业务模型的变量域与约束检查，可按下方赋值解释业务方案。':'本候选未通过所声明业务模型的检查，不能直接作为满足要求的方案；请先查看不满足项。';
  lines.push('### 业务结果','',verdict,`模型：${cell(review.label)}`,`业务目标值：${review.objective.value}（${review.objective.sense==='max'?'最大化':'最小化'}）。`,'');
  rows(lines,['业务变量','值'],review.decisions.map(v=>[v.label,v.value]),review.decision_count ?? review.decisions.length,Boolean(review.complete_diagnostics));
  const outOfDomain=review.decisions.filter(v=>!v.within_domain);
  if(outOfDomain.length) rows(lines,['变量域不满足项','实际值','允许范围','复核'],outOfDomain.map(v=>[v.label,v.value,`[${v.lower}, ${v.upper}]`,'不满足']),review.domain_violation_count ?? outOfDomain.length,Boolean(review.complete_diagnostics));
  if(review.constraints.length) {
    const displayed=[...review.constraints.filter(c=>!c.passed),...review.constraints.filter(c=>c.passed)];
    rows(lines,['业务约束','实际值','要求','复核'],displayed.map(c=>[c.label,c.actual,({le:'≤',ge:'≥',eq:'='}[c.relation])+' '+c.required,c.passed?'通过':'不满足']),review.constraint_count ?? review.constraints.length,Boolean(review.complete_diagnostics));
  }
  else lines.push('该业务模型未声明额外约束；本次已检查变量域。','');
  if(review.baseline?.status==='comparable') lines.push(`参考方案目标值：${review.baseline.objective}；本次模型内改善：${review.baseline.improvement}。`,'');
  else if(review.baseline) lines.push('参考方案或本次候选未通过可行性检查，本次不计算改善值。','');
  if(review.complete_diagnostics) lines.push('[完整核验明细](<'+encodeURI(review.complete_diagnostics.path).replace(/[<>#?]/g,c=>'%'+c.charCodeAt(0).toString(16))+'>)','');
  lines.push('复核只覆盖本次候选和所提供的业务模型，不证明模型与原需求完全等价或全局最优；不自动改模或重新求解。');
  return lines.join('\n');
}

function candidateFacts(record) {
  const limits={maxBits:record.qubo.num_bits};
  const decoded=decodeBits(record.qubo,record.result.bits,limits);
  const quboObjective=storedObjectiveEnergy(record.qubo,record.result.bits,record.objective_energy_version,limits);
  if(!Number.isFinite(quboObjective) || quboObjective!==record.result.objective_value) {
    throw new MathModelError('review_candidate_mismatch','result.objective_value','保存候选的 QUBO 复算值与原记录不一致；请核查原记录，不自动重算或改写。');
  }
  return { decoded, quboObjective };
}
async function reviewCandidateFile(record, file, outputDirectory) {
  const { decoded, quboObjective } = candidateFacts(record);
  const sourceAssignment = Object.fromEntries(record.result.bits.map((value,index)=>['x_'+index,value]));
  const verified = await verifyMathModelFile(file, { sourceAssignment, outputDirectory, referenceBits:record.qubo.num_bits, sourceSolveId:record.solve_id,
    expectedQuboSha256:storedQuboModelDigest(record.qubo,{maxBits:record.qubo.num_bits}).model_sha256 });
  const { input_proof, ...review } = verified;
  return { ...review, decoded, qubo_objective:quboObjective };
}
function reviewCandidate(record, specification) {
  const { decoded, quboObjective } = candidateFacts(record);
  if(specification===undefined) return {status:'needs_business_model',scope:'qubo_candidate',decoded,qubo_objective:quboObjective};
  fields(specification,['model','data'],['baseline','bindings'],'review');
  const capacity=assertVerificationInput(specification, 'review');
  // This consumer returns business decisions/constraint checks, not the public
  // report's objective breakdown, tied summaries or Markdown. Validate/parse the
  // complete model once and evaluate both assignments through the same closure.
  const evaluate=createMathCandidateEvaluator(specification.model,specification.data);
  const assignment=assignmentFrom(record,specification);
  const baseline=Object.hasOwn(specification,'baseline')?evaluate(specification.baseline):null;
  const verified=evaluate(assignment),sense=specification.model.objective.sense;
  const comparison=baseline?compareEvaluations(sense,baseline,verified):null;
  return {status:verified.status,scope:'declared_business_model',label:specification.model.label ?? specification.model.id,
    decoded,capacity,qubo_objective:quboObjective,objective:{sense,value:verified.objective_value},
    decisions:verified.variable_diagnostics.map(v=>({variable:v.id,label:v.label ?? v.id,value:v.value,lower:v.lower,upper:v.upper,within_domain:v.within_domain})),
    constraints:verified.constraint_diagnostics.map(c=>({label:c.label ?? c.id,actual:c.lhs,required:c.rhs,relation:c.relation,slack:c.slack,passed:c.violation===0})),
    baseline:baseline ? {status:comparison.status,objective:baseline.objective_value,
      ...(comparison.status==='comparable'?{improvement:comparison.absolute_improvement}:{})} : null};
}

module.exports={GUIDED_RESULT_REVIEW_CONTRACT_VERSION,RESULT_REVIEW_GUIDANCE,RESULT_REVIEW_SCHEMA,RESULT_REVIEW_GUIDE,reviewCandidate,reviewCandidateFile,renderReview};
