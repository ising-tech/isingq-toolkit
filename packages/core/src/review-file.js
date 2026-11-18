'use strict';

const { ReviewFileSession, ReviewChecksWriter, descriptor } = require('./review-file-io');
const { MathModelError, fields, array, identifier, integer, checked, resolveScalar, resolveTerm, constraintHeader,
  constraintDiagnostic, evaluateDomains, mathTermValue, validateMathModelHeader, compareEvaluations, assertVerificationInput, verificationCapacity } = require('./math-model');
const { digest } = require('./verified-report');
const REVIEW_FILE_CONTRACT_VERSION = 'isingq-review-file-v1';
const workerKey=Symbol.for('isingq.review-file.worker.v1');
if(!process[workerKey]) Object.defineProperty(process,workerKey,{value:{active:false}});
const worker=process[workerKey];
const isFileReviewActive=()=>worker.active;
const fail = (code, path, message) => { throw new MathModelError(code, path, message); };
const REVIEW_FILE_SCHEMA = { type: 'object', description: '由原模型文件导出回执提供；大模型使用此引用，不在聊天或工具参数中展开完整矩阵。文件位于Toolkit运行主机。',
  properties: { manifest_path: { type: 'string', description: '实际清单绝对路径' }, content_digest: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '清单实际字节SHA256，直接复用导出回执' } }, required: ['manifest_path', 'content_digest'], additionalProperties: false };
function reviewFileReference(value) {
  descriptor(value,'review_file',true);
  return {manifest_path:value.manifest_path,content_digest:value.content_digest};
}

function expressionShape(expression, path) {
  const file = expression && Object.hasOwn(expression, 'terms_file');
  fields(expression, [file ? 'terms_file' : 'terms'], ['constant'], path);
  if (file) descriptor(expression.terms_file, path + '.terms_file'); else array(expression.terms, path + '.terms');
}
async function openModelFile(file, expectedQuboSha256, capacity) {
  const session = new ReviewFileSession(file,capacity), manifest = await session.manifest();
  fields(manifest, ['schema_version', 'model', 'data'], ['baseline', 'bindings', 'qubo_model_sha256'], 'review_file.manifest');
  if (Object.hasOwn(manifest, 'qubo_model_sha256') && (typeof manifest.qubo_model_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.qubo_model_sha256))) fail('input_error', 'review_file.qubo_model_sha256', '原QUBO摘要须为完整小写SHA256');
  if (manifest.schema_version !== REVIEW_FILE_CONTRACT_VERSION) fail('unsupported', 'review_file.schema_version', `仅支持${REVIEW_FILE_CONTRACT_VERSION}`);
  if (expectedQuboSha256 !== undefined && manifest.qubo_model_sha256 !== expectedQuboSha256) fail('review_candidate_mismatch', 'review_file.qubo_model_sha256', '核验文件未绑定本次原QUBO；沿用原建模导出文件，不自动换模或重算');
  const model = manifest.model;
  fields(model, ['schema_version', 'id', 'variables', 'objective'], ['label', 'constraints', 'constraints_file'], 'review_file.model');
  if (Object.hasOwn(model, 'constraints') === Object.hasOwn(model, 'constraints_file')) fail('input_error', 'review_file.model.constraints', '须提供完整constraints或constraints_file，且只能选一个；无额外约束使用[]');
  fields(model.objective, ['sense', 'expression'], [], 'review_file.model.objective'); expressionShape(model.objective.expression, 'review_file.objective');
  if (Object.hasOwn(model, 'constraints_file')) descriptor(model.constraints_file, 'review_file.constraints_file'); else array(model.constraints, 'review_file.constraints');
  const header = { ...model, objective: { sense: model.objective.sense, expression: {
    ...(Object.hasOwn(model.objective.expression, 'constant') ? { constant: model.objective.expression.constant } : {}), terms: [] } }, constraints: [] };
  delete header.constraints_file;
  const parsed = validateMathModelHeader(header, manifest.data);
  return { session, manifest, model, header, parsed };
}
async function inspectReviewFile(file, expectedQuboSha256) {
  descriptor(file, 'review_file', true); const saved = { ...file };
  const context = await openModelFile(saved, expectedQuboSha256);
  return { manifest_path: saved.manifest_path, content_digest: saved.content_digest, variables: context.model.variables.length };
}

async function verifyMathModelFile(file, options) {
  if(worker.active) fail('review_file_busy','review_file','当前有文件核验正在进行；稍后沿同一候选继续，不并发重复读取大模型，不重新求解');
  worker.active=true;
  try { return await verifyFile(file,options); } finally { worker.active=false; }
}
async function verifyFile(file, options) {
  fields(options, ['outputDirectory'], ['assignment', 'sourceAssignment', 'expectedQuboSha256','referenceBits','sourceSolveId'], 'review_file.options');
  if (Object.hasOwn(options, 'assignment') === Object.hasOwn(options, 'sourceAssignment')) fail('input_error', 'review_file.candidate', '须由可信调用者提供一个实际候选来源');
  descriptor(file, 'review_file', true); file = { ...file }; options = { ...options };
  if(options.sourceSolveId!==undefined && (typeof options.sourceSolveId!=='string' || !/^solve_[a-f0-9]{32}$/.test(options.sourceSolveId))) fail('input_error','review_file.sourceSolveId','原任务关联须为实际保存记录标识');
  const candidateKey = Object.hasOwn(options, 'assignment') ? 'assignment' : 'sourceAssignment', supplied = options[candidateKey];
  if (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)) fail('input_error', 'review_file.candidate', '候选来源须为完整整数赋值');
  fields(supplied, Object.keys(supplied), [], 'review_file.candidate');
  const frozen = Object.create(null);
  for (const [id, value] of Object.entries(supplied)) frozen[id] = integer(value, 'review_file.candidate.' + id);
  options[candidateKey] = Object.freeze(frozen);
  const capacity=verificationCapacity(process.env,options.referenceBits ?? 4095);
  const { session, manifest, model, header, parsed } = await openModelFile(file, options.expectedQuboSha256,capacity);
  const data = manifest.data, used = parsed.used_parameters, names = new Set(Object.keys(parsed.variables));
  const orderedNames=model.variables.map(variable=>variable.id),orderedParameters=Object.keys(data),mappingSets=new WeakMap();
  const stats = { variables: model.variables.length, model_terms: 0, mapping_terms: 0, constraints: 0 };
  const scalar = (value, path) => resolveScalar(value, data, used, path);
  async function expression(expression, degree, assignments, path, mapping = false) {
    expressionShape(expression, path);
    const constant = Object.hasOwn(expression, 'constant') ? (mapping ? integer(expression.constant, path + '.constant') : scalar(expression.constant, path + '.constant')) : 0;
    if(mapping && !mappingSets.has(assignments[0])) mappingSets.set(assignments[0],new Set(Object.keys(assignments[0])));
    const sums = assignments.map(() => constant), allowed = mapping ? mappingSets.get(assignments[0]) : names;
    const consume = (term, index) => {
      if(term===null || typeof term!=='object' || Array.isArray(term)) fields(term,['coefficient','variables'],[],path+'.term');
      if(!mapping && term?.coefficient && typeof term.coefficient==='object' && Object.hasOwn(term.coefficient,'param_index')) {
        fields(term.coefficient,['param_index'],[],path+'.coefficient');
        const position=integer(term.coefficient.param_index,path+'.coefficient.param_index');
        if(position<0 || position>=orderedParameters.length) fail('input_error',path+'.coefficient.param_index','参数索引超出原data范围');
        term={...term,coefficient:{param:orderedParameters[position]}};
      }
      if(term && Object.hasOwn(term,'indices')) {
        fields(term,['coefficient','indices'],[],path+'.term');
        const indices=array(term.indices,path+'.indices',degree);
        term={coefficient:term.coefficient,variables:indices.map(value=>{
          const position=integer(value,path+'.index'),id=mapping?'x_'+position:orderedNames[position];
          if(position<0 || !id || !allowed.has(id)) fail('review_mapping_required',path+'.index','索引超出已声明变量或原位范围；沿用原模型顺序，不自动调整');
          return id;
        })};
      }
      if (mapping) integer(term.coefficient, path + '.coefficient');
      const [coefficient, variables] = resolveTerm(term, degree, allowed, mapping ? {} : data, used, path + '.terms[' + (index - 1) + ']');
      if (mapping) stats.mapping_terms++; else stats.model_terms++;
      for (let i = 0; i < assignments.length; i++) {
        const value = mathTermValue(coefficient, variables, assignments[i], path);
        if (value !== 0) sums[i] = checked(BigInt(sums[i]) + BigInt(value), path);
      }
    };
    if (expression.terms_file) await session.rows(expression.terms_file, consume);
    else expression.terms.forEach((term, i) => consume(term, i + 1));
    return sums;
  }
  let assignment;
  if (Object.hasOwn(options, 'assignment')) {
    if (manifest.bindings !== undefined) fail('input_error', 'review_file.bindings', '带原位映射的文件须提供原位来源，不能用业务赋值跳过解码');
    assignment = options.assignment;
  } else {
    const source = options.sourceAssignment;
    if (source === null || typeof source !== 'object' || Array.isArray(source)) fail('input_error', 'review_file.sourceAssignment', '原位来源须为完整已验证赋值');
    fields(source, Object.keys(source), [], 'review_file.sourceAssignment');
    const sourceCount=Object.keys(source).length;
    for (const [id, value] of Object.entries(source)) {
      const matched=/^x_(0|[1-9][0-9]*)$/.exec(id);
      if (!matched || !Number.isSafeInteger(Number(matched[1])) || Number(matched[1])>=sourceCount || ![0, 1].includes(integer(value, 'review_file.sourceAssignment'))) fail('input_error', 'review_file.sourceAssignment', '原位来源须为完整连续的x_0、x_1等0/1值');
    }
    session.charge(assertVerificationInput(source).input_bytes);
    assignment = Object.create(null);
    if (manifest.bindings !== undefined) fields(manifest.bindings, [...names], [], 'review_file.bindings');
    for (const variable of model.variables) {
      if (manifest.bindings !== undefined) assignment[variable.id] = (await expression(manifest.bindings[variable.id], 2, [source], 'review_file.bindings.' + variable.id, true))[0];
      else {
        if (!Object.hasOwn(source, variable.id)) fail('review_mapping_required', 'review_file.bindings', '业务变量未对应原位；沿用原编码映射，不猜测或改写变量');
        assignment[variable.id] = source[variable.id];
      }
    }
  }
  const current = evaluateDomains(header, parsed, assignment), baseline = Object.hasOwn(manifest, 'baseline') ? evaluateDomains(header, parsed, manifest.baseline) : null;
  if (Object.hasOwn(options, 'assignment')) session.charge(assertVerificationInput(assignment).input_bytes);
  const assignments = baseline ? [assignment, manifest.baseline] : [assignment];
  let writer;
  try {
    writer = new ReviewChecksWriter(options.outputDirectory);
    for (let i = 0; i < current.variable_diagnostics.length; i++) writer.append({ kind: 'variable', ...current.variable_diagnostics[i], ...(baseline ? { baseline: baseline.variable_diagnostics[i] } : {}) });
    const objective = await expression(model.objective.expression, 2, assignments, 'objective');
    const objectiveTerms = stats.model_terms, failed = [], passed = [], ids = new Set();
    let violations = current.violations.length, baselineViolations = baseline?.violations.length || 0;
    const constraint = async (item, index) => {
      const location = 'constraints[' + (index - 1) + ']', head = constraintHeader(item, data, used, location);
      if (ids.has(head.id)) fail('input_error', location, `重复约束id=${head.id}`); ids.add(head.id);
      const sums = await expression(item.expression, 1, assignments, location + '.expression');
      const actual = constraintDiagnostic(head.id, head.relation, head.rhs, sums[0]);
      const prior = baseline ? constraintDiagnostic(head.id, head.relation, head.rhs, sums[1]) : null;
      stats.constraints++; if (actual.violation) violations++; if (prior?.violation) baselineViolations++;
      const row = { label: item.label ?? head.id, actual: actual.lhs, required: actual.rhs, relation: actual.relation, slack: actual.slack, passed: actual.violation === 0 };
      const target = actual.violation ? failed : passed; if (target.length < 40) target.push(row);
      writer.append({ kind: 'constraint', ...actual, ...(item.label !== undefined ? { label: item.label } : {}), ...(prior ? { baseline: prior } : {}) });
    };
    if (model.constraints_file) await session.rows(model.constraints_file, constraint);
    else for (let i = 0; i < model.constraints.length; i++) await constraint(model.constraints[i], i + 1);
    const unused = Object.keys(data).filter(key => !used.has(key));
    if (unused.length) fail('input_error', 'data', `未引用参数=${JSON.stringify(unused.sort())}`);
    const verification = { status: violations ? 'infeasible' : 'feasible', objective_value: objective[0] };
    const comparison = baseline ? compareEvaluations(parsed.sense, { status: baselineViolations ? 'infeasible' : 'feasible', objective_value: objective[1] }, verification) : null;
    const proof = { manifest_sha256: file.content_digest, source_files: session.sources, assignment_sha256: digest(assignment),
      ...(options.sourceSolveId ? {source_solve_id:options.sourceSolveId} : {}),
      ...(options.expectedQuboSha256 ? {qubo_model_sha256:options.expectedQuboSha256} : {}),
      baseline_sha256: baseline ? digest(manifest.baseline) : null };
    writer.append({ kind: 'summary', ...verification, ...stats, proof });
    const checks = writer.complete();
    return { status: verification.status, scope: 'declared_business_model', label: model.label ?? model.id,
      objective: { sense: parsed.sense, value: objective[0] },
      decisions: [...current.variable_diagnostics.filter(v=>!v.within_domain),...current.variable_diagnostics.filter(v=>v.within_domain)].slice(0,40)
        .map(v => ({ variable: v.id, label: v.label ?? v.id, value: v.value, lower: v.lower, upper: v.upper, within_domain: v.within_domain })),
      decision_count:stats.variables,domain_violation_count:current.violations.length,
      constraints: [...failed, ...passed].slice(0, 40), constraint_count: stats.constraints, constraint_violation_count:violations-current.violations.length,
      baseline: comparison ? { status: comparison.status, objective: objective[1], ...(comparison.status === 'comparable' ? { improvement: comparison.absolute_improvement } : {}) } : null,
      capacity: { ...session.capacity, input_bytes: session.bytes }, file_statistics: { ...stats, objective_terms: objectiveTerms, max_record_bytes: session.maxLineBytes },
      complete_diagnostics: checks, input_proof: proof };
  } catch (error) {
    if (writer) { try { writer.discard(); } catch (_) { /* Never replace the original failure with cleanup diagnostics. */ } }
    if (error instanceof MathModelError) throw error;
    fail('review_file_output_unavailable', 'review_file.output', `完整核验明细未能写入（fs_code=${typeof error.code === 'string' ? error.code : 'unknown'}）；检查私有产物目录权限与磁盘空间，保留原任务和输入后重试`);
  }
}
module.exports = { REVIEW_FILE_CONTRACT_VERSION, REVIEW_FILE_SCHEMA, inspectReviewFile, verifyMathModelFile, reviewFileReference, isFileReviewActive };
