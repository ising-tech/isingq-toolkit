'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { validateDelivery, DELIVERY_CONTRACT_VERSION, matrixDocument, modelDigest, validateQubo } = require('../packages/core');

const fixture = () => ({
  qubo: { num_bits: 2, linear: [{ index: 1, coefficient: 0 }, { index: 0, coefficient: -3 }],
    quadratic: [{ i: 1, j: 0, coefficient: 2 }], offset: 5,
    variables: [{ index: 1, name: ' b ', meaning: 'second' }, { index: 0, name: 'a', meaning: 'first' }] },
  candidate_bits: [1, 1], claimed_objective_value: 4, mapping_completeness: 'complete',
  test_ledger: [{ id: 'energy', status: 'passed', evidence_ref: 'logs/energy.json' }, { id: 'business', result: 'not_run' }],
  business_solution: { opaque: true },
});
module.exports = { fixture };

test('validates delivery and computes objective facts without certifying business or supplied tests', () => {
  const document = fixture();
  const snapshot = structuredClone(document);
  const result = validateDelivery(document);
  assert.equal(DELIVERY_CONTRACT_VERSION, 'isingq-delivery-v1');
  assert.equal(result.delivery_contract_version, DELIVERY_CONTRACT_VERSION);
  assert.equal(result.summary.input_linear_terms, 2);
  assert.equal(result.summary.canonical_linear_terms, 1);
  assert.equal(result.summary.canonical_quadratic_terms, 1);
  assert.equal(result.summary.canonical_nonzero_terms, 2);
  assert.equal(result.summary.offset, 5);
  assert.equal(result.summary.candidate_objective_value, 4);
  assert.equal(result.summary.matrix_sha256, matrixDocument(document.qubo).sha256);
  assert.equal(result.summary.model_sha256, modelDigest(document.qubo).model_sha256);
  assert.deepEqual(result.summary.test_records, { total: 2, passed: 1, failed: 0, skipped: 0, not_run: 1, with_evidence_ref: 1, without_evidence_ref: 1 });
  assert.equal(result.validation.business_correctness, 'unverified');
  assert.equal(result.validation.ledger_authenticity, 'not_verified');
  assert.equal(result.validation.business_solution, 'unverified');
  assert.deepEqual(result.candidate.variables.map(variable => variable.value), [1, 1]);
  assert.deepEqual(document, snapshot);
});

test('strictly validates the delivery format and candidate bits, including sparse arrays', () => {
  for (const input of [null, [], 'bad', { qubo: { num_bits: 1 }, unknown: true },
    { ...fixture(), delivery_contract_version: 'unknown-version' }]) {
    assert.throws(() => validateDelivery(input), /document/);
  }
  for (const bits of [null, '11', [1], [1, 1, 0], [true, 1], ['1', 1], [2, 0], [NaN, 0], new Array(2)]) {
    assert.throws(() => validateDelivery({ ...fixture(), candidate_bits: bits }), error => {
      assert.equal(error.code, 'delivery_invalid');
      assert.match(error.message, /document.candidate_bits/);
      return true;
    });
  }
  assert.throws(() => validateDelivery({ ...fixture(), qubo: { num_bits: 2, offset: '5' } }), /document.qubo.*offset/);
  assert.throws(() => validateDelivery({ ...fixture(), claimed_objective_value: -1 }), /actual=-1, expected=4, offset=5/);
  assert.throws(() => validateDelivery({ ...fixture(), claimed_objective_value: Infinity }), /有限数/);
  const matrixOnly = { qubo: fixture().qubo };
  assert.equal(validateDelivery(matrixOnly).candidate, null);
  assert.equal(validateDelivery(matrixOnly).summary.candidate_objective_value, null);
  assert.throws(() => validateDelivery({ ...matrixOnly, claimed_objective_value: 0 }), /缺少 candidate_bits/);
});

test('rejects every unsupported claim and mismatched objective, digest or ledger statistic', () => {
  const document = fixture();
  const result = validateDelivery(document);
  assert.deepEqual(validateDelivery({ ...document, claimed_summary: result.summary }).summary, result.summary);
  for (const claims of [
    { unrecognized_pass_claim: true }, { objective_value: 4 }, { offset: 0 },
    { canonical_nonzero_terms: 3 }, { candidate_objective_value: -1 }, { model_sha256: 'wrong' },
    { test_records: { total: 3 } }, { test_records: { passed: 2 } },
    { test_records: { executed: 2 } }, { test_records: { total: '2' } }, { test_records: null },
  ]) {
    assert.throws(() => validateDelivery({ ...document, claimed_summary: claims }), /document.claimed_summary/);
  }
  assert.throws(() => validateDelivery({ ...document, test_ledger: [document.test_ledger[0], { id: ' energy ', status: 'passed' }] }), error => {
    assert.equal(error.code, 'delivery_duplicate_test_id');
    assert.match(error.message, /id="energy"/);
    return true;
  });
  for (const record of [
    { id: 'test', status: 'passed', result: 'failed' }, { id: 'test', status: 'PASS' },
    { id: 'test', status: 'passed', reported_count: 100 }, { id: ' ' , status: 'passed' },
    { id: 'test', result: 'passed', evidence_ref: '' }, { id: 'test' },
  ]) assert.throws(() => validateDelivery({ ...document, test_ledger: [record] }), /document.test_ledger\[0\]/);
});

test('canonical summary is stable across item order while retaining distinct input/nonzero counts', () => {
  const document = fixture();
  const reordered = structuredClone(document);
  reordered.qubo.linear.reverse();
  reordered.qubo.variables.reverse();
  reordered.qubo.quadratic = [{ i: 0, j: 1, coefficient: 2 }];
  reordered.test_ledger.reverse();
  assert.deepEqual(validateDelivery(reordered), validateDelivery(document));
  assert.equal(validateQubo(document.qubo).summary.linear_terms, 2, 'legacy input count must not change');
  const noZeros = structuredClone(document);
  noZeros.qubo.linear = noZeros.qubo.linear.filter(term => term.coefficient !== 0);
  const first = validateDelivery(document).summary;
  const second = validateDelivery(noZeros).summary;
  assert.equal(first.input_linear_terms, 2);
  assert.equal(second.input_linear_terms, 1);
  for (const key of ['canonical_linear_terms', 'canonical_nonzero_terms', 'model_sha256', 'matrix_sha256', 'candidate_objective_value']) {
    assert.equal(first[key], second[key], key);
  }
});

test('full model digest tracks mapping changes and complete mapping is a delivery-only requirement', () => {
  const document = fixture();
  const original = validateDelivery(document);
  document.qubo.variables[0].meaning = 'changed meaning';
  const changed = validateDelivery(document);
  assert.equal(changed.summary.matrix_sha256, original.summary.matrix_sha256);
  assert.notEqual(changed.summary.model_sha256, original.summary.model_sha256);
  assert.throws(() => validateDelivery({ ...document, claimed_summary: { model_sha256: original.summary.model_sha256 } }), /model_sha256/);
  document.qubo.variables.pop();
  assert.equal(validateQubo(document.qubo).summary.named_variables, 1);
  assert.throws(() => validateDelivery(document), { code: 'delivery_mapping_incomplete' });
  const partial = validateDelivery({ ...document, mapping_completeness: 'partial' });
  assert.equal(partial.summary.mapping_completeness, 'partial');
  assert.equal(partial.validation.business_correctness, 'unverified');
});

test('opaque business solutions and self-reported passes remain unverified regardless of references', () => {
  for (const solution of [null, [], 'PASS', 123, { feasible: true, all_tests_passed: true }]) {
    const result = validateDelivery({ ...fixture(), business_solution: solution,
      test_ledger: [{ id: 'claim', status: 'passed', evidence_ref: 'https://must-not-open.invalid/evidence' }] });
    assert.equal(result.validation.business_correctness, 'unverified');
    assert.equal(result.validation.business_solution, 'unverified');
    assert.equal(result.validation.ledger_authenticity, 'not_verified');
    assert.equal(result.summary.test_records.passed, 1);
    assert.equal(result.summary.test_records.with_evidence_ref, 1);
  }
});


test('published claim schema matches every computed summary field; redundant status/result counts once', () => {
  const { TOOL_DEFINITIONS } = require('../packages/core');
  const result = validateDelivery({ ...fixture(), test_ledger: [{ id: 'one', status: 'passed', result: 'passed' }] });
  assert.equal(result.summary.test_records.total, 1);
  assert.equal(result.summary.test_records.passed, 1);
  const schema = TOOL_DEFINITIONS.find(tool => tool.name === 'isingq_delivery_validate').inputSchema.properties.document.properties.claimed_summary;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(result.summary).sort());
  assert.deepEqual(Object.keys(schema.properties.test_records.properties).sort(), Object.keys(result.summary.test_records).sort());
});

test('reports unsupported floating point cancellation instead of rejecting a legitimate legacy energy claim', () => {
  const document = { qubo: { num_bits: 3, linear: [
    { index: 0, coefficient: 1e16 }, { index: 2, coefficient: -1e16 }, { index: 1, coefficient: 1 },
  ] }, candidate_bits: [1, 1, 1], claimed_objective_value: 1 };
  const { objectiveEnergy } = require('../packages/core');
  assert.equal(objectiveEnergy(document.qubo, document.candidate_bits), 1);
  assert.throws(() => validateDelivery(document), error => {
    assert.equal(error.code, 'delivery_numeric_instability');
    assert.match(error.message, /input_order=1, canonical_order=0/);
    return true;
  });
  const bounded = structuredClone(document);
  bounded.qubo.linear[0].coefficient = 1e6;
  bounded.qubo.linear[1].coefficient = -1e6;
  assert.equal(validateDelivery(bounded).candidate.objective_value, 1);
});
