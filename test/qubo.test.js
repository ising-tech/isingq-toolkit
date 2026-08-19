'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeBits, matrixDocument, objectiveEnergy, validateQubo } = require('../src/qubo');

const QUBO = {
  num_bits: 2,
  linear: [
    { index: 0, coefficient: -1 },
    { index: 1, coefficient: 2 },
  ],
  quadratic: [{ i: 1, j: 0, coefficient: -3 }],
  offset: 4,
  variables: [
    { index: 0, name: 'choose_a', meaning: '选择 A' },
    { index: 1, name: 'choose_b', meaning: '选择 B' },
  ],
};

test('normalizes sparse QUBO and emits upper triangular matrix', () => {
  const document = matrixDocument(QUBO);
  assert.equal(document.content.toString(), '-1,-3\n0,2\n');
  assert.equal(document.summary.num_bits, 2);
  assert.equal(document.qubo.quadratic[0].i, 0);
  assert.equal(document.qubo.quadratic[0].j, 1);
});

test('rejects duplicate and invalid terms', () => {
  assert.throws(() => validateQubo({
    num_bits: 1,
    linear: [{ index: 0, coefficient: 1 }, { index: 0, coefficient: 2 }],
  }), /重复 index/);
  assert.throws(() => validateQubo({
    num_bits: 2,
    quadratic: [{ i: 0, j: 0, coefficient: 1 }],
  }), /不能包含对角项/);
});

test('decodes variables and evaluates objective including offset', () => {
  assert.deepEqual(decodeBits(QUBO, [1, 1]), [
    { index: 0, name: 'choose_a', meaning: '选择 A', value: 1 },
    { index: 1, name: 'choose_b', meaning: '选择 B', value: 1 },
  ]);
  assert.equal(objectiveEnergy(QUBO, [1, 1]), 2);
});
