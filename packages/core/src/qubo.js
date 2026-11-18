'use strict';

const crypto = require('crypto');

const MAX_BITS = 2048;
const MAX_MATRIX_BYTES = 20 * 1024 * 1024;
const QUBO_CONTRACT_VERSION = '1';
const MODEL_DIGEST_VERSION = 'isingq-model-v1';
const QUBO_OBJECTIVE_ENERGY_VERSION = 'isingq-qubo-objective-v1';
const MAX_VARIABLE_MEANING_LENGTH = 4096;

// Public input shape mirrors validateQubo; populated normalized output is not a
// declaration that callers must explicitly supply every defaulted field.
const QUBO_INPUT_SCHEMA = {
  type: 'object',
  description: '稀疏QUBO输入；仅num_bits必填。省略默认项是合法输入，规范化补默认值不构成模型修复。',
  properties: {
    num_bits: { type: 'integer', minimum: 1, maximum: MAX_BITS },
    linear: { type: 'array', items: { type: 'object' }, default: [] },
    quadratic: { type: 'array', items: { type: 'object' }, default: [] },
    offset: { type: ['number', 'null'], default: 0, description: '省略或null规范化为0；数值必须有限。' },
    variables: { type: 'array', items: { type: 'object', properties: {
      meaning: { type: ['string', 'null'], maxLength: MAX_VARIABLE_MEANING_LENGTH, description: '可省略；说明文字最多4096字符，不接受隐式字符串转换。' },
    } }, default: [] },
  },
  required: ['num_bits'], additionalProperties: false,
};
const QUBO_TRANSPORT_BOUNDARY = {
  input_representation: 'normalized_qubo', upload_representation: 'matrix_csv',
  create_task_model_field: 'inputJFile', original_qubo_json_sent: false,
  description: '先校验并规范化QUBO，再生成矩阵CSV上传；create_task传inputJFile及求解参数，不传原始QUBO JSON。补齐默认字段不改变规范化模型、矩阵或语义请求，不能据此认定修复远端拒绝。上传文件URL每次可不同，不能把随机对象名变化当模型变化。',
};

// Request identity still depends on validateQubo preserving the input order.
// Digests, new energy calculations and delivery use this canonical order.
function canonicalQubo(qubo) {
  return {
    num_bits: qubo.num_bits,
    linear: qubo.linear.filter((term) => term.coefficient !== 0)
      .sort((a, b) => a.index - b.index),
    quadratic: qubo.quadratic.filter((term) => term.coefficient !== 0)
      .sort((a, b) => a.i - b.i || a.j - b.j),
    offset: qubo.offset,
    variables: qubo.variables,
  };
}

function digestNormalizedQubo(qubo) {
  const { num_bits, offset, linear, quadratic, variables } = canonicalQubo(qubo);
  const canonical = { model_digest_version: MODEL_DIGEST_VERSION, num_bits, offset, linear, quadratic, variables };
  return {
    model_sha256: crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex'),
    model_digest_version: MODEL_DIGEST_VERSION,
  };
}

function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} 必须是有限数字`);
  }
  return value;
}

function arrayField(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${field} 必须是数组（收到 ${value === null ? 'null' : typeof value}）`);
  }
  return value;
}

function index(value, numBits, field) {
  if (!Number.isInteger(value) || value < 0 || value >= numBits) {
    throw new Error(`${field} 必须在 0 到 ${numBits - 1} 之间（value=${value}）`);
  }
  return value;
}

function validateQubo(input, limits = {}) {
  const qubo = normalizeQubo(input, limits, true);
  const maxMagnitude = (maximum, term) => Math.max(maximum, Math.abs(term.coefficient));
  return {
    qubo,
    summary: {
      num_bits: qubo.num_bits,
      linear_terms: qubo.linear.length,
      quadratic_terms: qubo.quadratic.length,
      named_variables: qubo.variables.length,
      max_abs_coefficient: qubo.quadratic.reduce(maxMagnitude, qubo.linear.reduce(maxMagnitude, 0)),
      convention: 'upper_triangular',
      ...digestNormalizedQubo(qubo),
    },
  };
}

// Result operations must accept persisted normalized metadata created before the
// input text limit existed. They still validate every numeric/model field.
function normalizeQubo(input, { maxBits = MAX_BITS } = {}, newInput) {
  if (!Number.isSafeInteger(maxBits) || maxBits < 1) throw new Error('QUBO maxBits 必须是正安全整数');
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('qubo 必须是 object');
  }
  const allowed = new Set(['num_bits', 'linear', 'quadratic', 'offset', 'variables']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`qubo 包含未知字段（fields=${unknown.join(',')}）`);
  const numBits = input.num_bits;
  if (!Number.isInteger(numBits) || numBits < 1 || numBits > maxBits) {
    throw new Error(`num_bits 必须在 1 到 ${maxBits} 之间（value=${numBits}）`);
  }
  const linear = arrayField(input.linear, 'linear');
  const quadratic = arrayField(input.quadratic, 'quadratic');
  const variables = arrayField(input.variables, 'variables');
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
    if (variable.meaning != null && typeof variable.meaning !== 'string') {
      throw new Error(`variables[${position}].meaning 必须是省略、null或string（type=${typeof variable.meaning}）`);
    }
    if (newInput && typeof variable.meaning === 'string' && variable.meaning.length > MAX_VARIABLE_MEANING_LENGTH) {
      throw new Error(`variables[${position}].meaning 超过说明文字上限（length=${variable.meaning.length}, max_length=${MAX_VARIABLE_MEANING_LENGTH}）；请精简说明后重试`);
    }
    const meaning = variable.meaning == null ? null : variable.meaning.trim();
    variableMap.set(i, { index: i, name: variable.name.trim(), meaning });
  }
  const offset = input.offset == null ? 0 : finiteNumber(input.offset, 'offset');
  return {
    num_bits: numBits,
    linear: [...diagonal].map(([i, coefficient]) => ({ index: i, coefficient })),
    quadratic: [...pairs].map(([key, coefficient]) => {
      const [i, j] = key.split(':').map(Number);
      return { i, j, coefficient };
    }),
    offset,
    variables: [...variableMap.values()].sort((a, b) => a.index - b.index),
  };
}

function modelDigest(input, limits) {
  return digestNormalizedQubo(normalizeQubo(input, limits, true));
}

// Internal persisted-record boundary: revalidate the numeric model without
// applying new metadata length policy, retaining the original digest bytes.
function storedQuboModelDigest(input, limits) {
  return digestNormalizedQubo(normalizeQubo(input, limits, false));
}

function matrixDocument(input, limits = {}) {
  const validated = validateQubo(input, limits);
  const { qubo } = validated;
  const maxBytes = limits.maxMatrixBytes ?? MAX_MATRIX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('矩阵字节上限必须是正安全整数');
  const tooLarge = bytes => new Error(`生成矩阵超过 ${maxBytes === MAX_MATRIX_BYTES ? '20 MiB' : '客户端字节上限'}（bytes=${bytes}, max_bytes=${maxBytes}）；请核对目标能力与客户端容量配置`);
  // At least one digit and one separator per cell. Reject before allocation;
  // build one row at a time so a target-sized matrix does not allocate N² JS numbers.
  if (2 * qubo.num_bits * qubo.num_bits > maxBytes) throw tooLarge(2 * qubo.num_bits * qubo.num_bits);
  const rows = new Map();
  function put(i, j, coefficient) {
    if (!rows.has(i)) rows.set(i, new Map());
    rows.get(i).set(j, coefficient);
  }
  for (const term of qubo.linear) put(term.index, term.index, term.coefficient);
  for (const term of qubo.quadratic) put(term.i, term.j, term.coefficient);
  const chunks = [];
  let bytes = 0;
  for (let i = 0; i < qubo.num_bits; i++) {
    const row = Array(qubo.num_bits).fill(0);
    for (const [j, coefficient] of rows.get(i) || []) row[j] = coefficient;
    const chunk = Buffer.from(row.join(',') + '\n', 'utf8');
    bytes += chunk.length;
    if (bytes > maxBytes) throw tooLarge(bytes);
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks, bytes);
  return {
    ...validated,
    content,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    size_bytes: content.length,
  };
}

function assertBits(bits, numBits) {
  const invalid = () => new Error(`bits 必须是长度为 ${numBits} 的 0/1 数组`);
  if (!Array.isArray(bits) || bits.length !== numBits) throw invalid();
  for (let i = 0; i < numBits; i++) {
    if (bits[i] !== 0 && bits[i] !== 1) throw invalid();
  }
}

function decodeBits(qubo, bits, limits) {
  const validated = normalizeQubo(qubo, limits, false);
  assertBits(bits, validated.num_bits);
  const names = new Map(validated.variables.map((item) => [item.index, item]));
  return bits.map((value, i) => ({
    index: i,
    name: names.get(i)?.name || `x_${i}`,
    meaning: names.get(i)?.meaning || null,
    value,
  }));
}

function visitActiveCoefficients(qubo, bits, visit) {
  visit(qubo.offset);
  for (const { index, coefficient } of qubo.linear) {
    if (bits[index]) visit(coefficient);
  }
  for (const { i, j, coefficient } of qubo.quadratic) {
    if (bits[i] && bits[j]) visit(coefficient);
  }
}

function sumAtFloatBoundary(qubo, bits) {
  // A finite coefficient is an integer multiple of 2^-1074. If a partial
  // float sum overflowed, accumulate those units before rounding the result.
  const buffer = new DataView(new ArrayBuffer(8));
  const hiddenBit = 1n << 52n;
  let units = 0n;
  visitActiveCoefficients(qubo, bits, coefficient => {
    buffer.setFloat64(0, coefficient);
    const raw = buffer.getBigUint64(0);
    const exponent = Number((raw >> 52n) & 0x7ffn);
    const fraction = raw & (hiddenBit - 1n);
    const significand = exponent ? fraction | hiddenBit : fraction;
    const value = significand << BigInt(Math.max(0, exponent - 1));
    units += raw >> 63n ? -value : value;
  });
  const magnitude = units < 0n ? -units : units;
  const shift = Math.max(0, magnitude.toString(2).length - 53);
  let significand = magnitude >> BigInt(shift);
  if (shift) {
    const remainder = magnitude - (significand << BigInt(shift));
    const midpoint = 1n << BigInt(shift - 1);
    if (remainder > midpoint || (remainder === midpoint && (significand & 1n))) significand += 1n;
  }
  const rounded = Number(significand) * 2 ** (shift - 1074);
  return units < 0n ? -rounded : rounded;
}

function objectiveEnergy(qubo, bits, limits) {
  const validated = normalizeQubo(qubo, limits, false);
  assertBits(bits, validated.num_bits);
  const canonical = canonicalQubo(validated);
  let total = 0, correction = 0;
  // Neumaier summation retains low-order contributions when terms with
  // very different magnitudes cancel. The model digest supplies the order.
  visitActiveCoefficients(canonical, bits, value => {
    const next = total + value;
    if (Number.isFinite(next)) {
      correction += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total;
    }
    total = next;
  });
  const result = total + correction;
  return Number.isFinite(result) ? result : sumAtFloatBoundary(canonical, bits);
}

function storedObjectiveEnergy(qubo, bits, version, limits) {
  if (version === QUBO_OBJECTIVE_ENERGY_VERSION) return objectiveEnergy(qubo, bits, limits);
  if (version !== undefined) throw new Error('历史记录的 QUBO 复算版本不受支持；请使用生成该记录的 Toolkit 核对。');
  // Earlier records used two input-order sums with the offset added outside
  // them. Use precisely that arithmetic to verify the saved historical value.
  const validated = normalizeQubo(qubo, limits, false);
  assertBits(bits, validated.num_bits);
  return validated.offset
    + validated.linear.reduce((sum, term) => sum + term.coefficient * bits[term.index], 0)
    + validated.quadratic.reduce((sum, term) => sum + term.coefficient * bits[term.i] * bits[term.j], 0);
}

module.exports = {
  // Internal use only; omitted from the package's public entry point.
  QUBO_OBJECTIVE_ENERGY_VERSION,
  canonicalQubo,
  storedObjectiveEnergy,
  storedQuboModelDigest,
  QUBO_INPUT_SCHEMA,
  QUBO_TRANSPORT_BOUNDARY,
  QUBO_CONTRACT_VERSION,
  MODEL_DIGEST_VERSION,
  decodeBits,
  matrixDocument,
  modelDigest,
  objectiveEnergy,
  validateQubo,
};
