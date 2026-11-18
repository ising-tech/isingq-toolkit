'use strict';
const { runWithCleanup } = require('./run-with-cleanup');

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { WorkspaceArtifacts } = require('./workspace');
const { MathModelError, fields, array, integer, resolveScalar, resolveTerm, constraintHeader, validateMathModelHeader, evaluateDomains, assertVerificationInput, verificationCapacity } = require('./math-model');
const { REVIEW_FILE_CONTRACT_VERSION } = require('./review-file');
const { validateQubo } = require('./qubo');
const fail = (code, location, message) => { throw new MathModelError(code, location, message); };

// Trusted modeling-code helper: iterable terms are consumed incrementally, never
// passed as executable input through MCP. The returned descriptor is the exact
// object accepted by review_file; users need not maintain the file protocol.
async function writeMathModelReviewFile(input) {
  fields(input, ['directory', 'model', 'data'], ['baseline', 'bindings', 'qubo_model_sha256','qubo','referenceBits'], 'review_file.export');
  const model = input.model;
  fields(model, ['schema_version', 'id', 'variables', 'objective', 'constraints'], ['label'], 'model');
  fields(model.objective, ['sense', 'expression'], [], 'model.objective');
  fields(model.objective.expression, ['terms'], ['constant'], 'model.objective.expression');
  const metadata = { schema_version: model.schema_version, id: model.id, variables: model.variables,
    ...(Object.hasOwn(model, 'label') ? { label: model.label } : {}), objective: { sense: model.objective.sense,
      expression: { ...(Object.hasOwn(model.objective.expression, 'constant') ? { constant: model.objective.expression.constant } : {}), terms: [] } }, constraints: [] };
  const suppliedBaseline = Object.hasOwn(input, 'baseline') ? input.baseline : undefined;
  assertVerificationInput({ model: metadata, data: input.data, ...(suppliedBaseline !== undefined ? { baseline: suppliedBaseline } : {}) });
  const baseline = suppliedBaseline === undefined ? undefined : structuredClone(suppliedBaseline);
  const data = structuredClone(input.data), header = structuredClone(metadata), parsed = validateMathModelHeader(header, data), used = parsed.used_parameters;
  const names = new Set(Object.keys(parsed.variables)), nameIndices=new Map(header.variables.map((variable,index)=>[variable.id,index])),capacity = verificationCapacity(process.env,input.referenceBits ?? 4095);
  const parameterIndices=new Map(Object.keys(data).map((name,index)=>[name,index]));
  if (baseline !== undefined) evaluateDomains(header, parsed, baseline);
  if(input.qubo!==undefined && input.qubo_model_sha256!==undefined) fail('input_error','review_file.export.qubo','只提供原qubo或已保存的摘要之一，不混用两个来源');
  if(input.qubo!==undefined) assertVerificationInput(input.qubo);
  const quboDigest = input.qubo===undefined ? input.qubo_model_sha256 : validateQubo(input.qubo,{maxBits:input.qubo.num_bits}).summary.model_sha256;
  if (quboDigest !== undefined && (typeof quboDigest !== 'string' || !/^[a-f0-9]{64}$/.test(quboDigest))) fail('input_error', 'review_file.export.qubo_model_sha256', '原QUBO摘要须为完整小写SHA256');
  const directory = fs.mkdtempSync(path.join(new WorkspaceArtifacts({ root: input.directory, round: 1, environment: {} }).root, 'review-model-'));
  let bytes = 0, serial = 0;
  const charge = size => { bytes += size; if (bytes > capacity.max_input_bytes) fail('unsupported_size', 'verification.input_bytes',
    `导出输入超过核验预算（bytes=${bytes}, max_input_bytes=${capacity.max_input_bytes}, setting=${capacity.setting}）；保留原模型并核对资源配置，不删条件`); };
  async function rows(filename, values, transform) {
    if (values === null || typeof values !== 'object' || (!values[Symbol.iterator] && !values[Symbol.asyncIterator])) fail('input_error', 'review_file.export', '表达式或约束须为数组或由建模程序提供的可迭代数据');
    const file = path.join(directory, filename), handle = await fs.promises.open(file, 'wx', 0o600), hash = crypto.createHash('sha256');
    let chunks = [], pending = 0;
    const flush = async () => {
      if (!pending) return;
      const buffer = Buffer.from(chunks.join('')); charge(buffer.length); hash.update(buffer); await handle.writeFile(buffer);
      chunks = []; pending = 0;
    };
    await runWithCleanup(async () => {
      for await (const value of values) {
        const record = transform ? await transform(value) : value, line = JSON.stringify(record) + '\n';
        chunks.push(line); pending += Buffer.byteLength(line); if (pending >= 64 * 1024) await flush();
      }
      await flush();
    }, async () => {
      await handle.close();
    });
    return { path: filename, sha256: hash.digest('hex') };
  }
  async function expression(value, degree, filename, mapping = false, forceFile = false) {
    fields(value, ['terms'], ['constant'], 'review_file.export.expression');
    if (mapping && Object.hasOwn(value, 'constant')) integer(value.constant, 'review_file.export.binding.constant');
    if (!mapping && Object.hasOwn(value, 'constant')) resolveScalar(value.constant, data, used, 'review_file.export.expression.constant');
    const validateTerm = term => {
      if (mapping) {
        fields(term, ['coefficient', 'variables'], [], 'review_file.export.binding.term');
        integer(term.coefficient, 'review_file.export.binding.coefficient');
        const variables = array(term.variables, 'review_file.export.binding.variables');
        const resolved = resolveTerm(term, degree, new Set(variables), {}, used, 'review_file.export.binding.term');
        if (resolved[1].some(id => !/^x_(0|[1-9][0-9]*)$/.test(id))) fail('review_mapping_required', 'review_file.export.bindings', '映射须引用原位x_0、x_1等');
      } else resolveTerm(term, degree, names, data, used, 'review_file.export.term');
    };
    // Finite in-memory affine rows/bindings remain compact records. Iterables
    // and the objective use external term files, so no giant array/string forms.
    if (Array.isArray(value.terms) && !forceFile) {
      array(value.terms, 'review_file.export.terms');
      for (const term of value.terms) validateTerm(term);
      assertVerificationInput(value); return structuredClone(value);
    }
    const constant = Object.hasOwn(value, 'constant') ? structuredClone(value.constant) : undefined;
    const ref = await rows(filename, value.terms, term => {
      validateTerm(term);
      const indices=term.variables.map(id=>mapping?Number(id.slice(2)):nameIndices.get(id));
      if(indices.some(index=>!Number.isSafeInteger(index)||index<0)) fail('review_mapping_required','review_file.export.indices','变量索引不在安全整数范围内');
      const coefficient=!mapping && term.coefficient!==null && typeof term.coefficient==='object'
        ? {param_index:parameterIndices.get(term.coefficient.param)} : term.coefficient;
      return {coefficient,indices};
    });
    return { ...(constant !== undefined ? { constant } : {}), terms_file: ref };
  }
  try {
    const objective = await expression(model.objective.expression, 2, 'objective.jsonl', false, true);
    const ids = new Set();
    const constraints = await rows('constraints.jsonl', model.constraints, async value => {
      const head = constraintHeader(value, data, used, 'review_file.export.constraint');
      if (ids.has(head.id)) fail('input_error', 'review_file.export.constraint', '约束id重复'); ids.add(head.id);
      const clone = { id: value.id, rhs: structuredClone(value.rhs), relation: value.relation, ...(value.label !== undefined ? { label: value.label } : {}) };
      clone.expression = await expression(value.expression, 1, 'constraint-' + (++serial) + '.jsonl');
      return clone;
    });
    let bindings;
    if (input.bindings !== undefined) {
      fields(input.bindings, [...names], [], 'review_file.export.bindings'); bindings = Object.create(null);
      for (const id of names) bindings[id] = await expression(input.bindings[id], 2, 'binding-' + (++serial) + '.jsonl', true);
    }
    const unused = Object.keys(data).filter(key => !used.has(key));
    if (unused.length) fail('input_error', 'data', `未引用参数=${JSON.stringify(unused.sort())}`);
    const manifest = { schema_version: REVIEW_FILE_CONTRACT_VERSION, ...(quboDigest !== undefined ? { qubo_model_sha256: quboDigest } : {}),
      model: { ...header, objective: { sense: header.objective.sense, expression: objective }, constraints_file: constraints }, data,
      ...(baseline !== undefined ? { baseline: structuredClone(baseline) } : {}), ...(bindings !== undefined ? { bindings } : {}) };
    delete manifest.model.constraints;
    const content = JSON.stringify(manifest) + '\n'; charge(Buffer.byteLength(content));
    const manifest_path = path.join(directory, 'review.json'); fs.writeFileSync(manifest_path, content, { flag: 'wx', mode: 0o600 });
    return { manifest_path, content_digest: crypto.createHash('sha256').update(content).digest('hex') };
  } catch (error) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_) {} throw error; }
}
module.exports = { writeMathModelReviewFile };
