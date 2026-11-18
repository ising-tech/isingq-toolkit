'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verificationCapacity, VERIFICATION_CAPACITY_CONTRACT_VERSION, buildVerifiedReport, compareMathCandidates } = require('../packages/core');
const { assertVerificationInput } = require('../packages/core/src/math-model');

const setting = 'ISINGQ_MAX_VERIFICATION_INPUT_BYTES';
const capacity = bytes => verificationCapacity({ [setting]: String(bytes) });

test('verification capacity has one explicit byte policy instead of model-count limits', () => {
  assert.equal(VERIFICATION_CAPACITY_CONTRACT_VERSION, 'isingq-verification-capacity-v1');
  assert.equal(verificationCapacity({}).max_input_bytes, 1024 * 1024 * 1024);
  assert.equal(capacity(12345).max_input_bytes, 12345);
  for (const value of ['', '0', '-1', '1.5', ' 1024', '1MiB', '9007199254740992']) {
    assert.throws(() => verificationCapacity({ [setting]: value }), error => error.code === 'verification_capacity_invalid'
      && error.message.includes(setting) && !error.message.includes('1MiB'));
  }
});

test('capacity counts exact aggregate UTF-8 JSON bytes including escapes, repeated references and numeric spelling', () => {
  const shared = { label: '设备\n"\\\u0000\u2028😀', values: [-0, 1e21, 1e-7, true, false, null] };
  for (const document of [{ a: shared, b: shared }, [], {}, '\ud800', [0], 1e21]) {
    const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8');
    assert.equal(assertVerificationInput(document, 'document', capacity(bytes)).input_bytes, bytes);
    assert.throws(() => assertVerificationInput(document, 'document', capacity(bytes - 1)), error => error.code === 'unsupported_size'
      && error.path === 'verification.input_bytes' && error.message.includes(`max_input_bytes=${bytes - 1}`));
  }
});

test('capacity preflight does not invoke hooks and rejects cycles, sparse arrays, symbols and inherited data', () => {
  let calls = 0;
  const cyclic = {}; cyclic.self = cyclic;
  const invalid = [cyclic, new Array(1), Object.create({ inherited: 1 }), { [Symbol('hidden')]: 1 },
    { toJSON() { calls++; return {}; } }, Object.defineProperty({}, 'secret', { enumerable: true, get() { calls++; return 1; } })];
  for (const input of invalid) assert.throws(() => assertVerificationInput(input), error => error.code === 'input_error');
  assert.equal(calls, 0);
  let nested = 0;
  for (let i = 0; i < 2000; i++) nested = [nested];
  assert.equal(assertVerificationInput(nested).input_bytes, 4001);
});

test('structured report mode keeps the exact same verified facts without rendering discarded Markdown', () => {
  const document = { report_contract_version: 'isingq-verified-report-v1', model: { schema_version: 'math-model-v1', id: 'comparison',
    variables: [{ id: 'x', domain: 'binary' }], objective: { sense: 'min', expression: { terms: [{ coefficient: 2, variables: ['x'] }] } }, constraints: [] },
    data: {}, baseline: { x: 1 }, candidates: [{ id: 'candidate', assignment: { x: 0 } }] };
  const full = buildVerifiedReport(document), facts = buildVerifiedReport(document, { render: false });
  const { report_markdown, visible_summary_markdown, report_artifact, ...expected } = full;
  assert.deepEqual(facts, expected); assert.ok(report_markdown && visible_summary_markdown && report_artifact);
  for (const options of [{ render: 'false' }, { extra: false }, []]) assert.throws(() => buildVerifiedReport(document, options), error => error.code === 'input_error');
});

test('baseline comparisons and multi-candidate reports enforce one aggregate input budget atomically', () => {
  const model = { schema_version: 'math-model-v1', id: 'aggregate', variables: [{ id: 'x', domain: 'binary' }],
    objective: { sense: 'min', expression: { terms: [{ coefficient: 1, variables: ['x'] }] } }, constraints: [] };
  const data = {}, baseline = { x: 1 }, candidate = { x: 0 }, previous = process.env[setting];
  const input = { model, data, baseline, candidate };
  const document = { report_contract_version: 'isingq-verified-report-v1', model, data, baseline,
    candidates: [{ id: 'a', assignment: candidate }, { id: 'b', assignment: baseline }] };
  try {
    for (const [value, run] of [[input, () => compareMathCandidates(model, data, baseline, candidate)],
      [document, () => buildVerifiedReport(document, { render: false })]]) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      process.env[setting] = String(bytes - 1);
      assert.throws(run, error => error.code === 'unsupported_size' && error.path === 'verification.input_bytes');
      process.env[setting] = String(bytes);
      assert.doesNotThrow(run);
    }
  } finally {
    if (previous === undefined) delete process.env[setting]; else process.env[setting] = previous;
  }
});
