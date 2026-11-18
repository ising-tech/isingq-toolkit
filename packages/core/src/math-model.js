'use strict';

// math-model-v1: finite integer candidate evaluation, without solving or code execution.
const MATH_MODEL_CONTRACT_VERSION = 'math-model-v1';
const LIMIT = BigInt(Number.MAX_SAFE_INTEGER);
const VERIFICATION_SCOPE = 'declared_finite_integer_model';
const VERIFICATION_CAPACITY_CONTRACT_VERSION = 'isingq-verification-capacity-v1';
const VERIFICATION_INPUT_SETTING = 'ISINGQ_MAX_VERIFICATION_INPUT_BYTES';
// Text metadata is copied into diagnostics and rendered reports. Limits count
// UTF-16 code units; the discovery schema also advertises these upper bounds.
const MAX_MATH_IDENTIFIER_LENGTH = 1024;
const MAX_MATH_LABEL_LENGTH = 4096;
function verificationCapacityBasis(referenceBits = 4095) {
  if (!Number.isSafeInteger(referenceBits) || referenceBits < 1) throw new MathModelError('verification_capacity_invalid', 'verification.capacity', 'referenceBits须为实际模型的正安全整数维度');
  const n = Math.max(4095, referenceBits), id = 'x_' + (n - 1);
  const termBytes = Buffer.byteLength(JSON.stringify({ coefficient: -Number.MAX_SAFE_INTEGER, variables: [id, id] })) + 1;
  const terms = n * (n + 1) / 2, bytes = terms * termBytes;
  const defaultBytes = 2 ** Math.ceil(Math.log2(bytes * 1.5));
  if (![terms, bytes, defaultBytes].every(Number.isSafeInteger)) throw new MathModelError('verification_capacity_invalid', 'verification.capacity', '当前声明维度的容量预算超出安全整数计量范围；请核实实际机型与模型维度');
  return { reference_bits: n, unique_quadratic_and_linear_terms: terms, max_canonical_term_bytes: termBytes,
    dense_objective_bytes: bytes, minimum_headroom_ratio: 1.5, default_input_bytes: defaultBytes,
    scope: 'canonical full upper-triangular objective with indexed IDs and safe integer coefficients; remaining budget covers metadata, constraints and mappings' };
}
// Aggregate file bytes are accounted incrementally, independently of JS strings.
const MAX_VERIFICATION_INPUT_BYTES = Number.MAX_SAFE_INTEGER;

class MathModelError extends Error {
  constructor(code, path, message) {
    super(`${code} at ${path}: ${message}`);
    this.name = 'MathModelError';
    this.code = code;
    this.path = path;
  }
}
function fail(path, message, code = 'input_error') { throw new MathModelError(code, path, message); }
function fields(obj, required, optional, path) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(obj))) fail(path, 'expected plain object');
  const keys = Reflect.ownKeys(obj);
  if (keys.some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(obj, key).enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(obj, key), 'value'))) fail(path, 'expected JSON object with enumerable data fields');
  const missing = required.filter(key => !Object.hasOwn(obj, key));
  const allowed = new Set([...required, ...optional]);
  const extra = keys.filter(key => !allowed.has(key));
  if (missing.length || extra.length) fail(path, `missing fields=${JSON.stringify(missing.sort())}; unknown fields=${JSON.stringify(extra.sort())}`);
}
function integer(value, path) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    // Never coerce untrusted objects/functions for diagnostics: their conversion
    // hooks can execute code or throw before the structured input error.
    const received = typeof value === 'number' ? `type=number, value=${value}` : `type=${value === null ? 'null' : typeof value}`;
    fail(path, `expected integer, received ${received}`);
  }
  if (!Number.isSafeInteger(value)) fail(path, `integer=${value} exceeds safe magnitude=${Number.MAX_SAFE_INTEGER}`, 'unsupported_numeric');
  return value === 0 ? 0 : value;
}
function checked(value, path) {
  if (value < -LIMIT || value > LIMIT) fail(path, `integer=${value} exceeds safe magnitude=${Number.MAX_SAFE_INTEGER}`, 'unsupported_numeric');
  return Number(value);
}
function identifier(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected nonempty string');
  if (value.length > MAX_MATH_IDENTIFIER_LENGTH) fail(path, `length=${value.length} exceeds max_length=${MAX_MATH_IDENTIFIER_LENGTH}`, 'unsupported_size');
  return value;
}
function label(obj, path) {
  if (!Object.hasOwn(obj, 'label')) return;
  if (typeof obj.label !== 'string') fail(`${path}.label`, 'expected string');
  if (obj.label.length > MAX_MATH_LABEL_LENGTH) fail(`${path}.label`, `length=${obj.label.length} exceeds max_length=${MAX_MATH_LABEL_LENGTH}`, 'unsupported_size');
}
function array(value, path, limit = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(path, 'expected JSON array with standard Array.prototype');
  if (value.length > limit) fail(path, `count=${value.length} exceeds limit=${limit}`, 'unsupported_size');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
    && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))) fail(path, 'expected dense JSON array without additional fields');
  return value;
}

function verificationCapacity(environment = process.env, referenceBits = 4095) {
  const derived = verificationCapacityBasis(referenceBits).default_input_bytes;
  const configured = environment[VERIFICATION_INPUT_SETTING];
  if (configured !== undefined && (typeof configured !== 'string' || !/^[1-9][0-9]*$/.test(configured)
    || !Number.isSafeInteger(Number(configured)) || Number(configured) > MAX_VERIFICATION_INPUT_BYTES)) {
    fail('verification.capacity', `invalid ${VERIFICATION_INPUT_SETTING}; remove it to restore ${derived} bytes, or set integer bytes in 1..${MAX_VERIFICATION_INPUT_BYTES}`, 'verification_capacity_invalid');
  }
  return { policy: 'aggregate_input_bytes',
      max_input_bytes: configured === undefined ? derived : Number(configured), setting: VERIFICATION_INPUT_SETTING };
}

// Count the exact compact UTF-8 JSON representation without invoking toJSON,
// accessors or conversion hooks, building a second full JSON string, or recursing
// on an untrusted structure. Shared subobjects count at each occurrence.
function assertVerificationInput(value, path = 'verification', capacity = verificationCapacity()) {
  let bytes = 0;
  const active = new WeakSet(), stack = [];
  const add = count => {
    bytes += count;
    if (bytes > capacity.max_input_bytes) fail('verification.input_bytes',
      `核验输入超过本地容量（bytes_at_least=${bytes}, max_input_bytes=${capacity.max_input_bytes}, setting=${capacity.setting}）；保留完整原模型和候选，由维护者调整核验进程容量后重试；不要删减约束或重新求解`, 'unsupported_size');
  };
  const quoted = text => {
    // The unescaped UTF-8 value is a cheap lower bound before allocating escapes.
    if (bytes + Buffer.byteLength(text, 'utf8') + 2 > capacity.max_input_bytes) add(Buffer.byteLength(text, 'utf8') + 2);
    add(Buffer.byteLength(JSON.stringify(text), 'utf8'));
  };
  const enter = (node, location) => {
    if (node === null) { add(4); return; }
    if (typeof node === 'string') { quoted(node); return; }
    if (typeof node === 'number') { if (!Number.isFinite(node)) fail(location, 'expected finite JSON number'); add(String(node).length); return; }
    if (typeof node === 'boolean') { add(node ? 4 : 5); return; }
    if (typeof node !== 'object') fail(location, 'expected JSON data value');
    if (active.has(node)) fail(location, 'cyclic input is not JSON data');
    const isArray = Array.isArray(node);
    let keys;
    if (isArray) {
      if (bytes + 2 * node.length + 1 > capacity.max_input_bytes) add(2 * node.length + 1);
      array(node, location);
    } else {
      keys = Object.keys(node); fields(node, [], keys, location);
    }
    const length = isArray ? node.length : keys.length;
    add(2 + Math.max(0, length - 1));
    active.add(node); stack.push({ node, location, keys, length, index: 0, isArray });
  };
  enter(value, path);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.length) { active.delete(frame.node); stack.pop(); continue; }
    const key = frame.isArray ? frame.index : frame.keys[frame.index]; frame.index++;
    if (!frame.isArray) { quoted(key); add(1); }
    enter(Object.getOwnPropertyDescriptor(frame.node, key).value, `${frame.location}.${key}`);
  }
  return { ...capacity, input_bytes: bytes };
}

function resolveScalar(value, data, used, path) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    fields(value, ['param'], [], path);
    const key = identifier(value.param, `${path}.param`);
    if (!Object.hasOwn(data, key)) fail(path, `missing data parameter=${key}`);
    used.add(key); return integer(data[key], `data.${key}`);
  }
  return integer(value, path);
}
function resolveTerm(term, degree, names, data, used, path) {
  fields(term, ['coefficient', 'variables'], [], path);
  const coefficient = resolveScalar(term.coefficient, data, used, `${path}.coefficient`);
  const variables = array(term.variables, `${path}.variables`);
  if (variables.length < 1 || variables.length > degree) fail(path, `degree=${variables.length}; supported degrees=1..${degree}`, 'unsupported');
  for (const name of variables) {
    identifier(name, `${path}.variables`);
    if (!names.has(name)) fail(path, `unknown variable=${name}`);
  }
  return [coefficient, [...variables]];
}
function constraintHeader(constraint, data, used, path) {
  fields(constraint, ['id', 'expression', 'relation', 'rhs'], ['label'], path);
  label(constraint, path);
  const id = identifier(constraint.id, `${path}.id`);
  if (!['le', 'ge', 'eq'].includes(constraint.relation)) fail(`${path}.relation`, 'supported relations are le, ge, eq', 'unsupported');
  return { id, relation: constraint.relation, rhs: resolveScalar(constraint.rhs, data, used, `${path}.rhs`) };
}
function validateMathModel(model, data) { return parseMathModel(model, data, false); }
function validateMathModelHeader(model, data) { return parseMathModel(model, data, true); }
function mathTermValue(coefficient, variables, assignment, path) {
  let value = coefficient;
  for (const name of variables) value = value === 0 || assignment[name] === 0 ? 0 : checked(BigInt(value) * BigInt(assignment[name]), path);
  return value;
}
function constraintDiagnostic(id, relation, rhs, lhs) {
  const delta = checked(BigInt(lhs) - BigInt(rhs), `constraints.${id}.residual`);
  const violation = relation === 'le' ? Math.max(0, delta) : relation === 'ge' ? Math.max(0, -delta) : Math.abs(delta);
  const slack = relation === 'le' ? -delta : relation === 'ge' ? delta : -Math.abs(delta);
  return { id, lhs, rhs, relation, slack: slack === 0 ? 0 : slack, active: delta === 0, violation };
}
function parseMathModel(model, data, deferUnused) {
  fields(model, ['schema_version', 'id', 'variables', 'objective', 'constraints'], ['label'], 'model');
  label(model, 'model');
  if (model.schema_version !== MATH_MODEL_CONTRACT_VERSION) fail('model.schema_version', 'only math-model-v1 is supported', 'unsupported');
  identifier(model.id, 'model.id');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('data', 'expected flat parameter object');
  fields(data, [], Object.keys(data), 'data');
  assertVerificationInput({ model, data });
  for (const [key, value] of Object.entries(data)) { identifier(key, 'data.key'); integer(value, `data.${key}`); }
  const used = new Set();
  const scalar = (value, path) => resolveScalar(value, data, used, path);
  const variableEntries = [];
  const variableNames = new Set();
  for (const [i, variable] of array(model.variables, 'model.variables').entries()) {
    const path = `model.variables[${i}]`;
    fields(variable, ['id', 'domain'], ['label', 'lower', 'upper'], path);
    label(variable, path);
    const name = identifier(variable.id, `${path}.id`);
    if (variableNames.has(name)) fail(`${path}.id`, `duplicate variable=${name}`);
    let lower, upper;
    if (variable.domain === 'binary') {
      fields(variable, ['id', 'domain'], ['label'], path); lower = 0; upper = 1;
    } else if (variable.domain === 'integer') {
      fields(variable, ['id', 'domain', 'lower', 'upper'], ['label'], path);
      lower = scalar(variable.lower, `${path}.lower`); upper = scalar(variable.upper, `${path}.upper`);
      if (lower > upper) fail(path, `lower=${lower} exceeds upper=${upper}`);
      checked(BigInt(upper) - BigInt(lower), `${path}.width`);
    } else fail(`${path}.domain`, 'supported domains are binary and integer', 'unsupported');
    variableNames.add(name); variableEntries.push([name, [lower, upper]]);
  }
  function expression(expr, degree, path) {
    fields(expr, ['terms'], ['constant'], path);
    const constant = scalar(Object.hasOwn(expr, 'constant') ? expr.constant : 0, `${path}.constant`);
    const terms = array(expr.terms, `${path}.terms`).map((term, i) => resolveTerm(term, degree, variableNames, data, used, `${path}.terms[${i}]`));
    return [constant, terms];
  }
  fields(model.objective, ['sense', 'expression'], [], 'model.objective');
  if (!['min', 'max'].includes(model.objective.sense)) fail('model.objective.sense', 'supported values are min and max', 'unsupported');
  const objective = expression(model.objective.expression, 2, 'model.objective.expression');
  const ids = new Set();
  const constraints = array(model.constraints, 'model.constraints').map((constraint, i) => {
    const path = `model.constraints[${i}]`;
    fields(constraint, ['id', 'expression', 'relation', 'rhs'], ['label'], path); label(constraint, path);
    const name = identifier(constraint.id, `${path}.id`);
    if (ids.has(name)) fail(`${path}.id`, `duplicate constraint=${name}`);
    ids.add(name);
    if (!['le', 'ge', 'eq'].includes(constraint.relation)) fail(`${path}.relation`, 'supported values are le, ge, eq', 'unsupported');
    return [name, expression(constraint.expression, 1, `${path}.expression`), constraint.relation, scalar(constraint.rhs, `${path}.rhs`)];
  });
  const unused = Object.keys(data).filter(key => !used.has(key)).sort();
  if (!deferUnused && unused.length) fail('data', `unreferenced parameters=${JSON.stringify(unused)}`);
  return { variables: Object.fromEntries(variableEntries), sense: model.objective.sense, objective, constraints, ...(deferUnused ? { used_parameters: used } : {}) };
}
function valueOf(expression, assignment, path) {
  const [constant, terms] = expression;
  let total = constant;
  const breakdown = terms.map(([coefficient, variables], index) => {
    const value = mathTermValue(coefficient, variables, assignment, `${path}.terms[${index}]`);
    total = checked(BigInt(total) + BigInt(value), path);
    return { index, coefficient, variables: [...variables], variable_values: variables.map(name => assignment[name]), value };
  });
  return { constant, terms: breakdown, total };
}
function evaluateDomains(model, parsed, candidate) {
  fields(candidate, Object.keys(parsed.variables), [], 'candidate');
  const violations = [];
  const variable_diagnostics = model.variables.map(variable => {
    const [lower, upper] = parsed.variables[variable.id];
    const value = integer(candidate[variable.id], `candidate.${variable.id}`);
    const within_domain = value >= lower && value <= upper;
    if (!within_domain) violations.push({ id: variable.id, kind: 'domain', value, lower, upper });
    return { id: variable.id, ...(Object.hasOwn(variable, 'label') ? { label: variable.label } : {}), domain: variable.domain, value, lower, upper, within_domain };
  });
  return { variable_diagnostics, violations };
}
// Internal request-scoped evaluator: validation is mandatory when the closure is
// created. No caller-controlled skip-validation option is exposed.
function createMathCandidateEvaluator(model, data) {
  const parsed = validateMathModel(model, data);
  return candidate => {
    assertVerificationInput(candidate, 'candidate');
    const { variable_diagnostics, violations } = evaluateDomains(model, parsed, candidate);
    const objective_breakdown = valueOf(parsed.objective, candidate, 'objective');
    const constraint_diagnostics = parsed.constraints.map(([id, expr, relation, rhs], i) => {
      const lhs = valueOf(expr, candidate, `constraints.${id}`).total;
      const diagnostic = constraintDiagnostic(id, relation, rhs, lhs);
      if (diagnostic.violation) violations.push({ id, kind: 'constraint', lhs, rhs, relation, violation: diagnostic.violation });
      return { ...diagnostic, ...(Object.hasOwn(model.constraints[i], 'label') ? { label: model.constraints[i].label } : {}) };
    });
    return { status: violations.length ? 'infeasible' : 'feasible', objective_value: objective_breakdown.total, violations,
      verification_scope: VERIFICATION_SCOPE, variable_diagnostics, constraint_diagnostics, objective_breakdown };
  };
}
function evaluateMathCandidate(model, data, candidate) {
  const evaluate = createMathCandidateEvaluator(model, data);
  assertVerificationInput({ model, data, candidate });
  return evaluate(candidate);
}
function compareEvaluations(sense, baseline, candidate) {
  if (baseline.status !== 'feasible' || candidate.status !== 'feasible') return { status: 'not_comparable', baseline_status: baseline.status,
    candidate_status: candidate.status, reason: 'both plans must be feasible for this model and data' };
  const direction = sense === 'min' ? 1n : -1n;
  const improvement = checked(direction * (BigInt(baseline.objective_value) - BigInt(candidate.objective_value)), 'comparison.absolute_improvement');
  const percent = baseline.objective_value > 0 ? { numerator: checked(100n * BigInt(improvement), 'comparison.percent'), denominator: baseline.objective_value } : null;
  return { status: 'comparable', absolute_improvement: improvement, improvement_percent: percent, benefit_scope: 'model_predicted',
    baseline_objective: baseline.objective_value, candidate_objective: candidate.objective_value };
}
function compareMathCandidates(model, data, baseline, candidate) {
  assertVerificationInput({ model, data, baseline, candidate });
  const evaluate = createMathCandidateEvaluator(model, data);
  const old = evaluate(baseline);
  const next = evaluate(candidate);
  return compareEvaluations(model.objective.sense, old, next);
}
// Discovery metadata for the same mathematical input shape. Runtime validation and
// exact arithmetic remain authoritative; this prevents clients guessing fields.
const scalarSchema={oneOf:[{type:'integer',minimum:-Number.MAX_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER},
  {type:'object',properties:{param:{type:'string',minLength:1,maxLength:MAX_MATH_IDENTIFIER_LENGTH}},required:['param'],additionalProperties:false}]};
const idSchema={type:'string',minLength:1,maxLength:MAX_MATH_IDENTIFIER_LENGTH};
const labelSchema={type:'string',maxLength:MAX_MATH_LABEL_LENGTH};
function expressionSchema(degree) {
  return {type:'object',properties:{constant:scalarSchema,terms:{type:'array',items:{type:'object',properties:{coefficient:scalarSchema,variables:{type:'array',minItems:1,maxItems:degree,items:idSchema}},required:['coefficient','variables'],additionalProperties:false}}},required:['terms'],additionalProperties:false};
}
const MATH_MODEL_INPUT_SCHEMA={type:'object',properties:{
  schema_version:{type:'string',const:MATH_MODEL_CONTRACT_VERSION},id:idSchema,label:labelSchema,
  variables:{type:'array',description:'完整原业务变量，按实际模型规模核验；整体输入受本地核验容量保护。直接对应原位时用x_0、x_1等id；其他编码通过bindings声明。label写业务含义，不使用name、index或meaning字段。',items:{oneOf:[
    {type:'object',properties:{id:idSchema,domain:{type:'string',const:'binary'},label:labelSchema},required:['id','domain'],additionalProperties:false},
    {type:'object',properties:{id:idSchema,domain:{type:'string',const:'integer'},label:labelSchema,lower:scalarSchema,upper:scalarSchema},required:['id','domain','lower','upper'],additionalProperties:false}]}},
  objective:{type:'object',properties:{sense:{type:'string',enum:['min','max']},expression:expressionSchema(2)},required:['sense','expression'],additionalProperties:false},
  constraints:{type:'array',description:'完整原业务仿射约束，整体输入受本地核验容量保护；原问题无额外约束时为[]。变量域由variables定义，不增加恒等式占位。',items:{type:'object',properties:{id:idSchema,label:labelSchema,expression:expressionSchema(1),relation:{type:'string',enum:['le','ge','eq']},rhs:scalarSchema},required:['id','expression','relation','rhs'],additionalProperties:false}},
},required:['schema_version','id','variables','objective','constraints'],additionalProperties:false};

module.exports = { MATH_MODEL_CONTRACT_VERSION, MATH_MODEL_INPUT_SCHEMA, MathModelError, validateMathModel, evaluateMathCandidate, compareMathCandidates,
  VERIFICATION_CAPACITY_CONTRACT_VERSION, verificationCapacity, verificationCapacityBasis, assertVerificationInput,
  // Shared protocol primitives remain internal to core; not exported from its public entry point.
  MAX_MATH_IDENTIFIER_LENGTH, MAX_MATH_LABEL_LENGTH, createMathCandidateEvaluator, fields, array, identifier, integer, checked, compareEvaluations, valueOf, resolveScalar, resolveTerm,
  constraintHeader, constraintDiagnostic, evaluateDomains, mathTermValue, validateMathModelHeader };
