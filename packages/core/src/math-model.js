'use strict';

// math-model-v1: finite integer candidate evaluation, without solving or code execution.
const MATH_MODEL_CONTRACT_VERSION = 'math-model-v1';
const LIMIT = BigInt(Number.MAX_SAFE_INTEGER);
const VERIFICATION_SCOPE = 'declared_finite_integer_model';

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
  const extra = keys.filter(key => !required.includes(key) && !optional.includes(key));
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
  return value;
}
function label(obj, path) {
  if (Object.hasOwn(obj, 'label') && typeof obj.label !== 'string') fail(`${path}.label`, 'expected string');
}
function array(value, path, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(path, 'expected JSON array with standard Array.prototype');
  if (value.length > limit) fail(path, `count=${value.length} exceeds limit=${limit}`, 'unsupported_size');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
    && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))) fail(path, 'expected dense JSON array without additional fields');
  return value;
}

function validateMathModel(model, data) {
  fields(model, ['schema_version', 'id', 'variables', 'objective', 'constraints'], ['label'], 'model');
  label(model, 'model');
  if (model.schema_version !== MATH_MODEL_CONTRACT_VERSION) fail('model.schema_version', 'only math-model-v1 is supported', 'unsupported');
  identifier(model.id, 'model.id');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('data', 'expected flat parameter object');
  fields(data, [], Object.keys(data), 'data');
  for (const [key, value] of Object.entries(data)) { identifier(key, 'data.key'); integer(value, `data.${key}`); }
  const used = new Set();
  function scalar(value, path) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      fields(value, ['param'], [], path);
      const key = identifier(value.param, `${path}.param`);
      if (!Object.hasOwn(data, key)) fail(path, `missing data parameter=${key}`);
      used.add(key);
      return integer(data[key], `data.${key}`);
    }
    return integer(value, path);
  }
  const variableEntries = [];
  const variableNames = new Set();
  for (const [i, variable] of array(model.variables, 'model.variables', 256).entries()) {
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
  let termCount = 0;
  function expression(expr, degree, path) {
    fields(expr, ['terms'], ['constant'], path);
    const constant = scalar(Object.hasOwn(expr, 'constant') ? expr.constant : 0, `${path}.constant`);
    const terms = array(expr.terms, `${path}.terms`, 20000).map((term, i) => {
      if (++termCount > 20000) fail(path, 'total terms exceed 20000', 'unsupported_size');
      const loc = `${path}.terms[${i}]`;
      fields(term, ['coefficient', 'variables'], [], loc);
      const coefficient = scalar(term.coefficient, `${loc}.coefficient`);
      const names = array(term.variables, `${loc}.variables`, 20000);
      if (names.length < 1 || names.length > degree) fail(loc, `degree=${names.length}; supported degrees=1..${degree}`, 'unsupported');
      for (const name of names) {
        identifier(name, `${loc}.variables`);
        if (!variableNames.has(name)) fail(loc, `unknown variable=${name}`);
      }
      return [coefficient, [...names]];
    });
    return [constant, terms];
  }
  fields(model.objective, ['sense', 'expression'], [], 'model.objective');
  if (!['min', 'max'].includes(model.objective.sense)) fail('model.objective.sense', 'supported values are min and max', 'unsupported');
  const objective = expression(model.objective.expression, 2, 'model.objective.expression');
  const ids = new Set();
  const constraints = array(model.constraints, 'model.constraints', 1024).map((constraint, i) => {
    const path = `model.constraints[${i}]`;
    fields(constraint, ['id', 'expression', 'relation', 'rhs'], ['label'], path); label(constraint, path);
    const name = identifier(constraint.id, `${path}.id`);
    if (ids.has(name)) fail(`${path}.id`, `duplicate constraint=${name}`);
    ids.add(name);
    if (!['le', 'ge', 'eq'].includes(constraint.relation)) fail(`${path}.relation`, 'supported values are le, ge, eq', 'unsupported');
    return [name, expression(constraint.expression, 1, `${path}.expression`), constraint.relation, scalar(constraint.rhs, `${path}.rhs`)];
  });
  const unused = Object.keys(data).filter(key => !used.has(key)).sort();
  if (unused.length) fail('data', `unreferenced parameters=${JSON.stringify(unused)}`);
  return { variables: Object.fromEntries(variableEntries), sense: model.objective.sense, objective, constraints };
}
function valueOf(expression, assignment, path) {
  const [constant, terms] = expression;
  let total = constant;
  const breakdown = terms.map(([coefficient, variables], index) => {
    let value = coefficient;
    for (const name of variables) value = checked(BigInt(value) * BigInt(assignment[name]), `${path}.terms[${index}]`);
    total = checked(BigInt(total) + BigInt(value), path);
    return { index, coefficient, variables: [...variables], variable_values: variables.map(name => assignment[name]), value };
  });
  return { constant, terms: breakdown, total };
}
function evaluateMathCandidate(model, data, candidate) {
  const parsed = validateMathModel(model, data);
  fields(candidate, Object.keys(parsed.variables), [], 'candidate');
  const violations = [];
  const variable_diagnostics = model.variables.map(variable => {
    const [lower, upper] = parsed.variables[variable.id];
    const value = integer(candidate[variable.id], `candidate.${variable.id}`);
    const within_domain = value >= lower && value <= upper;
    if (!within_domain) violations.push({ id: variable.id, kind: 'domain', value, lower, upper });
    return { id: variable.id, ...(Object.hasOwn(variable, 'label') ? { label: variable.label } : {}), domain: variable.domain, value, lower, upper, within_domain };
  });
  const objective_breakdown = valueOf(parsed.objective, candidate, 'objective');
  const constraint_diagnostics = parsed.constraints.map(([id, expr, relation, rhs], i) => {
    const lhs = valueOf(expr, candidate, `constraints.${id}`).total;
    const delta = checked(BigInt(lhs) - BigInt(rhs), `constraints.${id}.residual`);
    const violation = relation === 'le' ? Math.max(0, delta) : relation === 'ge' ? Math.max(0, -delta) : Math.abs(delta);
    if (violation) violations.push({ id, kind: 'constraint', lhs, rhs, relation, violation });
    const slack = relation === 'le' ? -delta : relation === 'ge' ? delta : -Math.abs(delta);
    return { id, ...(Object.hasOwn(model.constraints[i], 'label') ? { label: model.constraints[i].label } : {}), lhs, rhs, relation, slack: slack === 0 ? 0 : slack, active: delta === 0, violation };
  });
  return { status: violations.length ? 'infeasible' : 'feasible', objective_value: objective_breakdown.total, violations,
    verification_scope: VERIFICATION_SCOPE, variable_diagnostics, constraint_diagnostics, objective_breakdown };
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
  const old = evaluateMathCandidate(model, data, baseline);
  const next = evaluateMathCandidate(model, data, candidate);
  return compareEvaluations(model.objective.sense, old, next);
}
module.exports = { MATH_MODEL_CONTRACT_VERSION, MathModelError, validateMathModel, evaluateMathCandidate, compareMathCandidates,
  // Shared protocol primitives remain internal to core; not exported from its public entry point.
  fields, array, identifier, integer, compareEvaluations };
