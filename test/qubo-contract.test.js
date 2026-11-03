'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const core = require('../packages/core/src');
const quboApi = require('../src/qubo');
const { createHandler } = require('../src/server');

const MODEL = {
  num_bits: 3,
  linear: [{ index: 2, coefficient: 0.5 }, { index: 0, coefficient: -2 }],
  quadratic: [{ i: 2, j: 0, coefficient: 3 }],
  offset: 1.25,
  variables: [{ index: 2, name: 'b' }, { index: 0, name: ' 选择 A ', meaning: ' 主变量 ' }],
};
const GOLDEN_MODEL_HASH = '904814071ad3cf94447b7abe88990e9b9389c2a241ae666b31f2351dd4575b73';
const GOLDEN_EMPTY_HASH = 'dc13b4fa895f29bd84117f9eb57b5e12460aaa1d8856a320b6ef7250a949dc71';

test('core root exports the shared QUBO contract and detectable versions', () => {
  assert.equal(core.QUBO_CONTRACT_VERSION, '1');
  assert.equal(core.MODEL_DIGEST_VERSION, 'isingq-model-v1');
  for (const name of ['validateQubo', 'matrixDocument', 'objectiveEnergy', 'decodeBits', 'modelDigest']) {
    assert.equal(typeof core[name], 'function', name);
    assert.equal(core[name], quboApi[name], name);
    assert.equal(core[name], require('@ising-tech/isingq-mcp/core')[name], name);
  }
});

test('model digest has fixed golden bytes and covers the complete normalized model', () => {
  const expected = { model_sha256: GOLDEN_MODEL_HASH, model_digest_version: 'isingq-model-v1' };
  assert.deepEqual(core.modelDigest(MODEL), expected);
  assert.deepEqual(core.modelDigest({ num_bits: 2 }), {
    model_sha256: GOLDEN_EMPTY_HASH, model_digest_version: 'isingq-model-v1',
  });
  const validated = core.validateQubo(MODEL);
  for (const [key, value] of Object.entries(expected)) assert.equal(validated.summary[key], value);
  for (const change of [
    { num_bits: 4 },
    { offset: 1.5 },
    { linear: [{ index: 2, coefficient: 0.75 }, { index: 0, coefficient: -2 }] },
    { quadratic: [{ i: 0, j: 2, coefficient: 4 }] },
    { variables: [{ index: 0, name: 'renamed', meaning: '主变量' }, { index: 2, name: 'b' }] },
    { variables: [{ index: 0, name: '选择 A', meaning: 'other' }, { index: 2, name: 'b' }] },
    { variables: [{ index: 1, name: '选择 A', meaning: '主变量' }, { index: 2, name: 'b' }] },
    { variables: [] },
  ]) assert.notEqual(core.modelDigest({ ...MODEL, ...change }).model_sha256, GOLDEN_MODEL_HASH);
});

test('digest sorts terms, normalizes pair direction and ignores explicit zero coefficients', () => {
  assert.deepEqual(core.modelDigest({
    ...MODEL,
    linear: [{ index: 0, coefficient: -2 }, { index: 1, coefficient: -0 }, { index: 2, coefficient: 0.5 }],
    quadratic: [{ i: 1, j: 2, coefficient: 0 }, { i: 0, j: 2, coefficient: 3 }],
    variables: [{ index: 0, name: '选择 A', meaning: '主变量' }, { index: 2, name: ' b ', meaning: undefined }],
  }), core.modelDigest(MODEL));
  for (const offset of [undefined, null, 0, -0]) {
    assert.equal(core.modelDigest({ num_bits: 2, offset }).model_sha256, GOLDEN_EMPTY_HASH);
  }
  assert.equal(core.modelDigest({
    num_bits: 2, linear: [{ index: 0, coefficient: -0 }], quadratic: [{ i: 0, j: 1, coefficient: 0 }],
  }).model_sha256, GOLDEN_EMPTY_HASH);
  assert.equal(core.validateQubo({ num_bits: 2, linear: [{ index: 0, coefficient: 0 }] }).summary.linear_terms, 1);
  assert.equal(core.modelDigest({ num_bits: 2, variables: [{ index: 0, name: 'x', meaning: 7 }] }).model_sha256,
    core.modelDigest({ num_bits: 2, variables: [{ index: 0, name: 'x', meaning: '7' }] }).model_sha256);
  assert.notEqual(core.modelDigest({ num_bits: 2, variables: [{ index: 0, name: 'x', meaning: '' }] }).model_sha256,
    core.modelDigest({ num_bits: 2, variables: [{ index: 0, name: 'x', meaning: null }] }).model_sha256);
  const reorderedPairs = {
    num_bits: 4,
    quadratic: [{ i: 3, j: 1, coefficient: 4 }, { i: 2, j: 0, coefficient: 2 }, { i: 1, j: 0, coefficient: 3 }],
  };
  const snapshot = structuredClone(reorderedPairs);
  assert.deepEqual(core.modelDigest(reorderedPairs), core.modelDigest({
    num_bits: 4,
    quadratic: [{ i: 0, j: 1, coefficient: 3 }, { i: 0, j: 2, coefficient: 2 }, { i: 1, j: 3, coefficient: 4 }],
  }));
  assert.deepEqual(reorderedPairs, snapshot);
});

test('shared validators preserve five-field structural and numeric boundaries', () => {
  const invalid = [
    null, [], 'qubo', {}, { num_bits: 0 }, { num_bits: 2049 }, { num_bits: 1.5 },
    { num_bits: 2, extra: true },
    ...['linear', 'quadratic', 'variables'].flatMap((key) => [null, {}, 1, false, ''].map((value) => ({ num_bits: 2, [key]: value }))),
    { num_bits: 2, linear: [null] },
    { num_bits: 2, linear: [{ index: -1, coefficient: 1 }] },
    { num_bits: 2, linear: [{ index: 2, coefficient: 1 }] },
    { num_bits: 2, linear: [{ index: 0, coefficient: 1 }, { index: 0, coefficient: 0 }] },
    { num_bits: 2, quadratic: [{ i: 0, j: 0, coefficient: 1 }] },
    { num_bits: 2, quadratic: [{ i: 0, j: 1, coefficient: 1 }, { i: 1, j: 0, coefficient: 2 }] },
    { num_bits: 2, variables: [{ index: 0, name: 'x' }, { index: 0, name: 'y' }] },
    { num_bits: 2, variables: [{ index: 2, name: 'x' }] },
    { num_bits: 2, variables: [{ index: 0, name: ' ' }] },
    { num_bits: 2, variables: [{ index: 0, name: 'x'.repeat(201) }] },
  ];
  for (const value of [NaN, Infinity, -Infinity, '1', null]) {
    invalid.push({ num_bits: 2, linear: [{ index: 0, coefficient: value }] });
    invalid.push({ num_bits: 2, quadratic: [{ i: 0, j: 1, coefficient: value }] });
    if (value !== null) invalid.push({ num_bits: 2, offset: value });
  }
  for (const input of invalid) {
    assert.throws(() => core.validateQubo(input));
    assert.throws(() => core.modelDigest(input));
  }
  for (const num_bits of [1, 2048]) assert.equal(core.validateQubo({ num_bits }).qubo.num_bits, num_bits);
  assert.equal(core.validateQubo({ num_bits: 2, offset: null }).qubo.offset, 0);
  assert.equal(core.validateQubo({ num_bits: 2, variables: [{ index: 0, name: 'x'.repeat(200) }] }).summary.named_variables, 1);
});

test('model hashing preserves legacy matrix bytes, normalized order and request digest', async () => {
  const document = core.matrixDocument(MODEL);
  assert.equal(document.content.toString(), '-2,0,3\n0,0,0\n0,0,0.5\n');
  assert.equal(document.sha256, crypto.createHash('sha256').update('-2,0,3\n0,0,0\n0,0,0.5\n').digest('hex'));
  assert.deepEqual(document.qubo.linear.map((term) => term.index), [2, 0]);
  assert.equal(core.matrixDocument({ ...MODEL, offset: 9, variables: [] }).sha256, document.sha256);
  let saved;
  let submitted;
  const service = new core.SolverService({
    store: { findByIdempotency: () => null, save: (run) => { saved = structuredClone(run); } },
    transport: { submit: async (matrix, solverOptions) => { submitted = { matrix, solverOptions }; return { task_id: 'mock-task' }; } },
  });
  await service.start({ qubo: MODEL, model_summary: 'local compatibility', idempotency_key: 'local-only', solver_options: { use_credit: false } });
  assert.equal(saved.request_digest, crypto.createHash('sha256').update(JSON.stringify({
    qubo: document.qubo, solver_options: submitted.solverOptions,
  })).digest('hex'));
  assert.deepEqual(saved.qubo, document.qubo);
  assert.equal(submitted.matrix.content.toString(), document.content.toString());
  assert.deepEqual(saved.matrix, { num_bits: 3, sha256: document.sha256, size_bytes: document.size_bytes });
});

test('MCP validation and core produce identical model digests and reject identical invalid inputs locally', async () => {
  const unexpected = () => { throw new Error('validation must not access storage or transport'); };
  const service = new core.SolverService({
    store: { findByIdempotency: unexpected, save: unexpected },
    transport: { prepareSubmission: unexpected, submit: unexpected, poll: unexpected },
  });
  const handle = createHandler(service);
  const response = await handle({ method: 'tools/call', params: { name: 'isingq_qubo_validate', arguments: { qubo: MODEL } } });
  const document = core.matrixDocument(MODEL);
  assert.deepEqual(response.structuredContent, { ok: true, data: {
    ...document.summary, matrix_sha256: document.sha256, matrix_size_bytes: document.size_bytes,
  } });
  assert.equal(response.structuredContent.data.model_sha256, GOLDEN_MODEL_HASH);
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  for (const input of [{ num_bits: 0 }, { num_bits: 2, linear: null }, { num_bits: 2, extra: true }]) {
    let expectedMessage;
    try { core.validateQubo(input); } catch (error) { expectedMessage = error.message; }
    const invalid = await handle({ method: 'tools/call', params: { name: 'isingq_qubo_validate', arguments: { qubo: input } } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.structuredContent.error.message, expectedMessage);
  }
});
