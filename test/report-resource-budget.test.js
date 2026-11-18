'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildVerifiedReport, evaluateMathCandidate } = require('../packages/core');
function document() {
  return { report_contract_version: 'isingq-verified-report-v1', model: { schema_version: 'math-model-v1', id: 'budget',
    variables: [{ id: 'x', domain: 'binary' }], objective: { sense: 'min', expression: { terms: [] } }, constraints: [] },
  data: {}, candidates: [{ id: 'a', assignment: { x: 0 } }] };
}
function oversized(run, path) { assert.throws(run, error => error.code === 'unsupported_size' && error.path === path); }
test('report rejects candidate and text limits before candidate evaluation, even with top_k', () => {
  for (const options of [{}, { render: false }]) {
    const d = document(); d.top_k = 1;
    d.candidates = Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}`, assignment: {} }));
    oversized(() => buildVerifiedReport(d, options), 'document.candidates');
  }
  for (const mutate of [d => d.candidates[0].id = 'z'.repeat(1025), d => d.model.id = 'z'.repeat(1025),
    d => d.model.label = 'private'.repeat(586), d => d.model.variables[0].label = 'z'.repeat(4097),
    d => d.model.constraints = [{ id: 'c', label: 'z'.repeat(4097), expression: { terms: [] }, relation: 'le', rhs: 1 }]]) {
    const d = document(); mutate(d);
    assert.throws(() => buildVerifiedReport(d), error => error.code === 'unsupported_size' && !error.message.includes('private'));
  }
});
test('report preflights aggregate arithmetic, diagnostic and output expansion budgets atomically', () => {
  const arithmetic = document();
  arithmetic.model.constraints = [{ id: 'large', expression: { terms: Array.from({ length: 6000 }, () => ({ coefficient: 0, variables: ['x'] })) }, relation: 'eq', rhs: 0 }];
  arithmetic.candidates = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, assignment: {} }));
  oversized(() => buildVerifiedReport(arithmetic), 'report.work_units');
  const diagnostics = document();
  diagnostics.model.variables = Array.from({ length: 101 }, (_, i) => ({ id: `x${i}`, domain: 'binary' }));
  diagnostics.candidates = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, assignment: {} }));
  oversized(() => buildVerifiedReport(diagnostics), 'report.diagnostic_rows');
  const output = document(); output.model.variables[0].label = '<'.repeat(4096);
  output.candidates = Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, assignment: {} }));
  output.top_k = 1;
  for (const options of [{}, { render: false }]) oversized(() => buildVerifiedReport(output, options), 'report.output_bytes');
});
test('report parses its model once while public single-candidate validation stays strict', () => {
  const d = document(); d.baseline = { x: 1 }; d.candidates.push({ id: 'b', assignment: { x: 1 } });
  // Instrument the existing aggregate validator without changing data or adding accessors.
  const original = Buffer.byteLength; let modelInputVisits = 0;
  Buffer.byteLength = function(value, ...args) { if (value === '"math-model-v1"') modelInputVisits++; return original.call(this, value, ...args); };
  try { buildVerifiedReport(d); } finally { Buffer.byteLength = original; }
  // One document preflight and one model parse; no model scan per baseline/candidate.
  assert.equal(modelInputVisits, 2);
  d.model.objective.expression.terms.push({ coefficient: {}, variables: ['x'] });
  assert.throws(() => evaluateMathCandidate(d.model, d.data, { x: 0 }), error => error.code === 'input_error');
});

test('4095-variable inline report and 1000 small tied candidates stay supported', () => {
  const large = document(); large.model.variables = Array.from({ length: 4095 }, (_, i) => ({ id: `x_${i}`, domain: 'binary' }));
  large.candidates[0].assignment = Object.fromEntries(large.model.variables.map(row => [row.id, 0]));
  const report = buildVerifiedReport(large);
  assert.equal(report.candidates[0].verification.variable_diagnostics.length, 4095);
  assert.equal(report.visible_summary.best_candidates[0].decisions.length, 4095);
  const small = document(); small.top_k = 1;
  small.candidates = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, assignment: { x: 0 } }));
  const ties = buildVerifiedReport(small);
  assert.equal(ties.ranking.length, 1000); assert.equal(ties.selection.boundary_ties_included, true);
  assert.equal(ties.visible_summary.best_candidates.length, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify({ structuredContent: ties, content: [{ type: 'text', text: JSON.stringify(ties) }] })) < 64 * 1024 * 1024);
});
test('accepted ordinary report keeps the complete frozen pre-budget bytes and input/artifact digests', () => {
  const crypto = require('node:crypto');
  const report = buildVerifiedReport(document());
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex'),
    '2ec0bd5f453c344d65c95c3d6d3a3c3948faa67c6642795dbb034ba92bb7f36d');
});
test('worst-case escaping and all-best summaries remain within the complete response byte budget', () => {
  for (const text of ['&', '<', '\\', '\u0000', '😀']) {
    const d = document(); d.model.label = text.repeat(128); d.model.variables[0].label = text.repeat(512);
    d.candidates = Array.from({ length: 30 }, (_, i) => ({ id: `${text.repeat(128)}${i}`, assignment: { x: 0 } }));
    d.top_k = 1; d.baseline = { x: 0 };
    const report = buildVerifiedReport(d);
    assert.equal(report.visible_summary.best_candidates.length, 30);
    assert.ok(Buffer.byteLength(JSON.stringify({ structuredContent: report, content: [{ type: 'text', text: JSON.stringify(report) }] })) < 64 * 1024 * 1024);
  }
});
test('baseline diagnostics consume the same total output capacity as candidate diagnostics', () => {
  const d = document(); d.model.variables[0].label = '<'.repeat(4096);
  d.candidates = Array.from({ length: 154 }, (_, i) => ({ id: `c${i}`, assignment: { x: 0 } }));
  assert.doesNotThrow(() => buildVerifiedReport(d, { render: false }));
  d.baseline = { x: 0 };
  oversized(() => buildVerifiedReport(d, { render: false }), 'report.output_bytes');
});
