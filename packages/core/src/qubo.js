'use strict';

const crypto = require('crypto');

const MAX_BITS = 2048;
const MAX_MATRIX_BYTES = 20 * 1024 * 1024;

function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} 必须是有限数字`);
  }
  return value;
}

function index(value, numBits, field) {
  if (!Number.isInteger(value) || value < 0 || value >= numBits) {
    throw new Error(`${field} 必须在 0 到 ${numBits - 1} 之间（value=${value}）`);
  }
  return value;
}

function validateQubo(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('qubo 必须是 object');
  }
  const allowed = new Set(['num_bits', 'linear', 'quadratic', 'offset', 'variables']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`qubo 包含未知字段（fields=${unknown.join(',')}）`);
  const numBits = input.num_bits;
  if (!Number.isInteger(numBits) || numBits < 1 || numBits > MAX_BITS) {
    throw new Error(`num_bits 必须在 1 到 ${MAX_BITS} 之间`);
  }
  const linear = Array.isArray(input.linear) ? input.linear : [];
  const quadratic = Array.isArray(input.quadratic) ? input.quadratic : [];
  const variables = Array.isArray(input.variables) ? input.variables : [];
  const diagonal = new Map();
  for (const [position, term] of linear.entries()) {
    if (!term || Array.isArray(term) || typeof term !== 'object') {
      throw new Error(`linear[${position}] 必须是 object`);
    }
    const i = index(term.index, numBits, `linear[${position}].index`);
    if (diagonal.has(i)) throw new Error(`linear 存在重复 index（index=${i}）`);
    diagonal.set(i, finiteNumber(term.coefficient, `linear[${position}].coefficient`));
  }
  const pairs = new Map();
  for (const [position, term] of quadratic.entries()) {
    if (!term || Array.isArray(term) || typeof term !== 'object') {
      throw new Error(`quadratic[${position}] 必须是 object`);
    }
    let i = index(term.i, numBits, `quadratic[${position}].i`);
    let j = index(term.j, numBits, `quadratic[${position}].j`);
    if (i === j) throw new Error(`quadratic 不能包含对角项（position=${position}）`);
    if (i > j) [i, j] = [j, i];
    const key = `${i}:${j}`;
    if (pairs.has(key)) throw new Error(`quadratic 存在重复变量对（pair=${key}）`);
    pairs.set(key, finiteNumber(term.coefficient, `quadratic[${position}].coefficient`));
  }
  const variableMap = new Map();
  for (const [position, variable] of variables.entries()) {
    if (!variable || Array.isArray(variable) || typeof variable !== 'object') {
      throw new Error(`variables[${position}] 必须是 object`);
    }
    const i = index(variable.index, numBits, `variables[${position}].index`);
    if (variableMap.has(i)) throw new Error(`variables 存在重复 index（index=${i}）`);
    if (typeof variable.name !== 'string' || !variable.name.trim() || variable.name.length > 200) {
      throw new Error(`variables[${position}].name 必须是 1 到 200 字符`);
    }
    const meaning = variable.meaning == null ? null : String(variable.meaning).trim();
    variableMap.set(i, { index: i, name: variable.name.trim(), meaning });
  }
  const offset = input.offset == null ? 0 : finiteNumber(input.offset, 'offset');
  const normalized = {
    num_bits: numBits,
    linear: [...diagonal].map(([i, coefficient]) => ({ index: i, coefficient })),
    quadratic: [...pairs].map(([key, coefficient]) => {
      const [i, j] = key.split(':').map(Number);
      return { i, j, coefficient };
    }),
    offset,
    variables: [...variableMap.values()].sort((a, b) => a.index - b.index),
  };
  const magnitude = [...diagonal.values(), ...pairs.values()].reduce(
    (maximum, value) => Math.max(maximum, Math.abs(value)), 0,
  );
  return {
    qubo: normalized,
    summary: {
      num_bits: numBits,
      linear_terms: diagonal.size,
      quadratic_terms: pairs.size,
      named_variables: variableMap.size,
      max_abs_coefficient: magnitude,
      convention: 'upper_triangular',
    },
  };
}

function matrixDocument(input) {
  const validated = validateQubo(input);
  const { qubo } = validated;
  const rows = Array.from({ length: qubo.num_bits }, () => Array(qubo.num_bits).fill(0));
  for (const term of qubo.linear) rows[term.index][term.index] = term.coefficient;
  for (const term of qubo.quadratic) rows[term.i][term.j] = term.coefficient;
  const content = Buffer.from(`${rows.map((row) => row.join(',')).join('\n')}\n`, 'utf8');
  if (content.length > MAX_MATRIX_BYTES) {
    throw new Error(`生成矩阵超过 20 MiB（bytes=${content.length}）`);
  }
  return {
    ...validated,
    content,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    size_bytes: content.length,
  };
}

function decodeBits(qubo, bits) {
  const validated = validateQubo(qubo).qubo;
  if (!Array.isArray(bits) || bits.length !== validated.num_bits || bits.some((bit) => ![0, 1].includes(bit))) {
    throw new Error(`bits 必须是长度为 ${validated.num_bits} 的 0/1 数组`);
  }
  const names = new Map(validated.variables.map((item) => [item.index, item]));
  return bits.map((value, i) => ({
    index: i,
    name: names.get(i)?.name || `x_${i}`,
    meaning: names.get(i)?.meaning || null,
    value,
  }));
}

function objectiveEnergy(qubo, bits) {
  const validated = validateQubo(qubo).qubo;
  if (!Array.isArray(bits) || bits.length !== validated.num_bits || bits.some((bit) => ![0, 1].includes(bit))) {
    throw new Error(`bits 必须是长度为 ${validated.num_bits} 的 0/1 数组`);
  }
  return validated.offset
    + validated.linear.reduce((sum, term) => sum + term.coefficient * bits[term.index], 0)
    + validated.quadratic.reduce((sum, term) => sum + term.coefficient * bits[term.i] * bits[term.j], 0);
}

module.exports = { decodeBits, matrixDocument, objectiveEnergy, validateQubo };
