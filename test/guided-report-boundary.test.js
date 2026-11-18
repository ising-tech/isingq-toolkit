'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVerifiedReport } = require('../packages/core');
const { reviewCandidate } = require('../packages/core/src/guided-result-review');
function fixture(terms = []) {
  return { model: { schema_version: 'math-model-v1', id: 'business', variables: [{ id: 'x_0', domain: 'binary' }],
    objective: { sense: 'min', expression: { terms } }, constraints: [] }, data: {}, baseline: { x_0: 1 } };
}
const record = { solve_id: 'solve_0123456789abcdef0123456789abcdef', qubo: { num_bits: 1 }, result: { bits: [0], objective_value: 0 } };
test('guided mathematical consumer accepts complete input without weakening public structured-report budgets', () => {
  const specification = fixture(Array.from({ length: 20000 }, () => ({ coefficient: 0, variables: ['x_0'] })));
  const report = { report_contract_version: 'isingq-verified-report-v1', model: specification.model, data: specification.data,
    baseline: specification.baseline, candidates: [{ id: record.solve_id, assignment: { x_0: 0 } }] };
  for (const options of [{}, { render: false }]) assert.throws(() => buildVerifiedReport(report, options),
    error => error.code === 'unsupported_size' && error.path === 'report.output_bytes');
  const result = reviewCandidate(record, specification);
  assert.equal(result.status, 'feasible'); assert.equal(result.objective.value, 0);
  assert.equal(result.baseline.improvement, 0); assert.equal(result.decisions.length, 1);
  assert.equal(Object.hasOwn(result, 'objective_breakdown'), false);
  assert.equal(Object.hasOwn(result, 'report_markdown'), false);
});
test('guided candidate and baseline use a single strict model parse and unchanged business facts', () => {
  const specification = fixture([{ coefficient: 2, variables: ['x_0'] }]);
  const original = Buffer.byteLength; let visits = 0;
  Buffer.byteLength = function(value, ...args) { if (value === '"math-model-v1"') visits++; return original.call(this, value, ...args); };
  let result;
  try { result = reviewCandidate(record, specification); } finally { Buffer.byteLength = original; }
  assert.equal(visits, 2); // complete review input, then one strict model parse
  assert.equal(result.objective.value, 0); assert.deepEqual(result.baseline, { status: 'comparable', objective: 2, improvement: 2 });
  specification.model.objective.expression.terms[0].coefficient = {};
  assert.throws(() => reviewCandidate(record, specification), error => error.code === 'input_error');
});
