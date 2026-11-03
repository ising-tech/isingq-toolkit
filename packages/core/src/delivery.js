'use strict';

const { validateQubo, matrixDocument, objectiveEnergy, decodeBits } = require('./qubo');

const DELIVERY_CONTRACT_VERSION = 'isingq-delivery-v1';
const STATUSES = ['passed', 'failed', 'skipped', 'not_run'];
const DOCUMENT_FIELDS = ['delivery_contract_version', 'qubo', 'candidate_bits', 'claimed_objective_value',
  'mapping_completeness', 'test_ledger', 'claimed_summary', 'business_solution'];

class DeliveryValidationError extends Error {
  constructor(code, field, message) {
    super(`${field}: ${message}`);
    this.name = 'DeliveryValidationError';
    this.code = code;
  }
}

function fail(code, field, message) { throw new DeliveryValidationError(code, field, message); }
function object(value, field) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('delivery_invalid', field, '必须是 object');
}
function fields(value, allowed, field) {
  object(value, field);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail('delivery_unknown_field', field, `未知字段 fields=${unknown.join(',')}；支持字段=${allowed.join(',')}`);
}
function display(value) {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 200));
  if (value === null || ['number', 'boolean', 'undefined'].includes(typeof value)) return String(value);
  return Array.isArray(value) ? '[array]' : '[object]';
}
function text(value, field, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
    fail('delivery_invalid', field, `必须是 1 到 ${limit} 字符的非空字符串，且不含控制字符（收到 ${typeof value}）`);
  }
  return value.trim();
}
function finite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('delivery_invalid', field, `必须是有限数（actual=${display(value)}）`);
}
function matchClaims(claims, expected, field) {
  fields(claims, Object.keys(expected), field);
  for (const key of Object.keys(claims)) {
    const actual = claims[key];
    const computed = expected[key];
    if (computed && typeof computed === 'object') {
      matchClaims(actual, computed, `${field}.${key}`);
    } else if (actual !== computed) {
      fail('delivery_claim_mismatch', `${field}.${key}`, `声明与计算值不一致（actual=${display(actual)}, expected=${display(computed)}）；请用本工具的客观 summary 更新声明`);
    }
  }
}
function ledgerRecords(input) {
  if (!Array.isArray(input)) fail('delivery_invalid', 'document.test_ledger', '必须是数组');
  const seen = new Set();
  return Array.from(input, (record, position) => {
    const field = `document.test_ledger[${position}]`;
    fields(record, ['id', 'status', 'result', 'evidence_ref'], field);
    const id = text(record.id, `${field}.id`, 200);
    if (seen.has(id)) fail('delivery_duplicate_test_id', `${field}.id`, `重复测试 ID（id=${display(id)}）；每项测试只能提供一条记录，不会自动去重`);
    seen.add(id);
    const status = Object.hasOwn(record, 'status') ? record.status : record.result;
    if (!STATUSES.includes(status)) fail('delivery_invalid', `${field}.status/result`, `必须是 ${STATUSES.join('|')}（actual=${display(status)}）`);
    if (Object.hasOwn(record, 'result') && record.result !== status) {
      fail('delivery_invalid', `${field}.result`, `与 status 不一致（status=${display(status)}, result=${display(record.result)}）`);
    }
    const reference = record.evidence_ref == null ? null : text(record.evidence_ref, `${field}.evidence_ref`, 4096);
    return { id, status, evidence_ref: reference };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Validates supplied delivery facts only; never executes code or follows evidence references. */
function validateDelivery(document) {
  fields(document, DOCUMENT_FIELDS, 'document');
  if (Object.hasOwn(document, 'delivery_contract_version') && document.delivery_contract_version !== DELIVERY_CONTRACT_VERSION) {
    fail('delivery_invalid', 'document.delivery_contract_version', `不支持的契约（actual=${display(document.delivery_contract_version)}, expected=${DELIVERY_CONTRACT_VERSION}）`);
  }
  let validated;
  try { validated = validateQubo(document.qubo); }
  catch (error) { fail('delivery_invalid', 'document.qubo', error.message); }
  const policy = document.mapping_completeness === undefined ? 'partial' : document.mapping_completeness;
  if (!['partial', 'complete'].includes(policy)) fail('delivery_invalid', 'document.mapping_completeness', `必须是 partial|complete（actual=${display(policy)}）`);
  const { qubo, summary: legacy } = validated;
  if (policy === 'complete' && qubo.variables.length !== qubo.num_bits) {
    fail('delivery_mapping_incomplete', 'document.qubo.variables', `声明 complete 但映射未覆盖所有位（named_variables=${qubo.variables.length}, num_bits=${qubo.num_bits}）；补全索引映射或明确使用 partial`);
  }
  // The delivery layer has canonical order and removes explicit zeros. Do not
  // change legacy validateQubo order/counts or persisted request/matrix digests.
  const canonical = { num_bits: qubo.num_bits, linear: qubo.linear.filter(term => term.coefficient !== 0).sort((a, b) => a.index - b.index),
    quadratic: qubo.quadratic.filter(term => term.coefficient !== 0).sort((a, b) => a.i - b.i || a.j - b.j),
    offset: qubo.offset, variables: qubo.variables };
  let matrix;
  try { matrix = matrixDocument(qubo); }
  catch (error) { fail('delivery_invalid', 'document.qubo', error.message); }
  let candidate = null;
  if (Object.hasOwn(document, 'candidate_bits')) {
    const bits = document.candidate_bits;
    if (!Array.isArray(bits) || bits.length !== qubo.num_bits) {
      fail('delivery_invalid', 'document.candidate_bits', `必须是长度为 ${qubo.num_bits} 的数字 0/1 数组（actual_length=${Array.isArray(bits) ? bits.length : 'not_array'}）`);
    }
    for (let i = 0; i < bits.length; i++) {
      if (!Object.hasOwn(bits, i) || (bits[i] !== 0 && bits[i] !== 1)) {
        fail('delivery_invalid', `document.candidate_bits[${i}]`, `必须是数字 0 或 1（actual=${display(bits[i])}）`);
      }
    }
    const objective = objectiveEnergy(qubo, bits);
    const canonicalObjective = objectiveEnergy(canonical, bits);
    if (!Number.isFinite(objective) || !Number.isFinite(canonicalObjective) || objective !== canonicalObjective) {
      fail('delivery_numeric_instability', 'computed.candidate_objective_value',
        `输入与 canonical 计算次序的 QUBO 能量不稳定（input_order=${objective}, canonical_order=${canonicalObjective}, offset=${qubo.offset}）；当前交付不支持该数值精度，不能据此判定业务模型或用户声明错误。请调整系数量级/消去结构，或使用可安全累加的整数系数后重新核验；简单整体缩放不保证恢复稳定`);
    }
    candidate = { bits: [...bits], objective_value: objective, variables: decodeBits(canonical, bits) };
  }
  if (Object.hasOwn(document, 'claimed_objective_value')) {
    finite(document.claimed_objective_value, 'document.claimed_objective_value');
    if (!candidate) fail('delivery_invalid', 'document.claimed_objective_value', '缺少 candidate_bits，不能核验候选能量声明');
    if (document.claimed_objective_value !== candidate.objective_value) {
      fail('delivery_claim_mismatch', 'document.claimed_objective_value', `候选 QUBO 能量不一致（actual=${document.claimed_objective_value}, expected=${candidate.objective_value}, offset=${qubo.offset}）；复算必须包含 offset 和已编码罚项，不能用业务目标替代`);
    }
  }
  const records = ledgerRecords(document.test_ledger === undefined ? [] : document.test_ledger);
  const counts = { total: records.length, passed: 0, failed: 0, skipped: 0, not_run: 0, with_evidence_ref: 0, without_evidence_ref: 0 };
  for (const record of records) {
    counts[record.status] += 1;
    counts[record.evidence_ref === null ? 'without_evidence_ref' : 'with_evidence_ref'] += 1;
  }
  const summary = {
    num_bits: qubo.num_bits, input_linear_terms: legacy.linear_terms, input_quadratic_terms: legacy.quadratic_terms,
    canonical_linear_terms: canonical.linear.length, canonical_quadratic_terms: canonical.quadratic.length,
    canonical_nonzero_terms: canonical.linear.length + canonical.quadratic.length,
    named_variables: qubo.variables.length, mapping_completeness: qubo.variables.length === qubo.num_bits ? 'complete' : 'partial',
    offset: qubo.offset, max_abs_coefficient: legacy.max_abs_coefficient,
    matrix_sha256: matrix.sha256, matrix_size_bytes: matrix.size_bytes,
    model_sha256: legacy.model_sha256, model_digest_version: legacy.model_digest_version,
    candidate_objective_value: candidate?.objective_value ?? null, test_records: counts,
  };
  if (Object.hasOwn(document, 'claimed_summary')) matchClaims(document.claimed_summary, summary, 'document.claimed_summary');
  return { delivery_contract_version: DELIVERY_CONTRACT_VERSION, canonical_qubo: canonical, candidate,
    test_ledger: records, summary,
    validation: { structure: 'valid', mapping_requirement: policy, business_correctness: 'unverified',
      ledger_authenticity: 'not_verified', business_solution: Object.hasOwn(document, 'business_solution') ? 'unverified' : 'not_supplied' },
    limitations: [
      'candidate_objective_value 是包含 offset 与已编码罚项的 QUBO 能量，不自动等于业务目标值。',
      'test_records 仅统计供应的唯一测试记录；status/result 与 evidence_ref 不证明实际执行、通过或引用内容真实，引用不会被读取。',
      '不校验任意 business_solution 的业务 schema、约束可行性、模型等价性或全局最优性；结构通过不替代独立业务校验或用户云任务确认。',
    ] };
}

module.exports = { DELIVERY_CONTRACT_VERSION, DeliveryValidationError, validateDelivery };
