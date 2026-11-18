'use strict';

const { validateQubo, matrixDocument, objectiveEnergy, decodeBits, canonicalQubo, storedObjectiveEnergy,
  storedQuboModelDigest, QUBO_OBJECTIVE_ENERGY_VERSION } = require('./qubo');

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
    const claimed = claims[key];
    const computed = expected[key];
    if (computed && typeof computed === 'object') {
      matchClaims(claimed, computed, `${field}.${key}`);
    } else if (claimed !== computed) {
      fail('delivery_claim_mismatch', `${field}.${key}`, `声明与计算值不一致（claimed=${display(claimed)}, computed=${display(computed)}）；请先省略 claimed_summary 和 claimed_objective_value 获取客观 summary，再按返回原值更新声明；四舍五入仅用于展示`);
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

function validateDelivery(document, limits) {
  return validateDeliveryDocument(document, limits);
}

function validateRecordedDelivery(document, limits, run) {
  return validateDeliveryDocument(document, limits, run.status === 'succeeded' && run.result ? run : undefined);
}

function deliveryObjective(qubo, bits, limits, run) {
  if (!run || run.objective_energy_version === QUBO_OBJECTIVE_ENERGY_VERSION) return objectiveEnergy(qubo, bits, limits);
  if (storedQuboModelDigest(run.qubo, limits).model_sha256 !== run.matrix.model_sha256) {
    fail('target_delivery_record_invalid', 'record.qubo', '原求解记录的模型摘要不一致；请从原记录核对，保留原任务及候选');
  }
  // A legacy result used the original stored term order, which the
  // order-independent model hash alone cannot recover from a delivery document.
  return storedObjectiveEnergy(run.qubo, bits, run.objective_energy_version, limits);
}

/** Validates supplied delivery facts only; never executes code or follows evidence references. */
function validateDeliveryDocument(document, limits, run) {
  fields(document, DOCUMENT_FIELDS, 'document');
  if (Object.hasOwn(document, 'delivery_contract_version') && document.delivery_contract_version !== DELIVERY_CONTRACT_VERSION) {
    fail('delivery_invalid', 'document.delivery_contract_version', `不支持的契约（actual=${display(document.delivery_contract_version)}, expected=${DELIVERY_CONTRACT_VERSION}）`);
  }
  let validated;
  try { validated = validateQubo(document.qubo, limits); }
  catch (error) { fail('delivery_invalid', 'document.qubo', error.message); }
  const policy = document.mapping_completeness === undefined ? 'partial' : document.mapping_completeness;
  if (!['partial', 'complete'].includes(policy)) fail('delivery_invalid', 'document.mapping_completeness', `必须是 partial|complete（actual=${display(policy)}）`);
  const { qubo, summary: legacy } = validated;
  if (policy === 'complete' && qubo.variables.length !== qubo.num_bits) {
    fail('delivery_mapping_incomplete', 'document.qubo.variables', `声明 complete 但映射未覆盖所有位（named_variables=${qubo.variables.length}, num_bits=${qubo.num_bits}）；补全索引映射或明确使用 partial`);
  }
  const canonical = canonicalQubo(qubo);
  let matrix;
  try { matrix = matrixDocument(qubo, limits); }
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
    const objective = deliveryObjective(qubo, bits, limits, run);
    if (!Number.isFinite(objective)) {
      fail('delivery_numeric_instability', 'computed.candidate_objective_value',
        `QUBO 能量复算超出有限数值范围（computed=${objective}, offset=${qubo.offset}）；请核对系数量级与消去结构后重新核验，保留原模型与候选`);
    }
    candidate = { bits: [...bits], objective_value: objective, variables: decodeBits(canonical, bits, limits) };
  }
  if (Object.hasOwn(document, 'claimed_objective_value')) {
    finite(document.claimed_objective_value, 'document.claimed_objective_value');
    if (!candidate) fail('delivery_invalid', 'document.claimed_objective_value', '缺少 candidate_bits，不能核验候选能量声明');
    if (document.claimed_objective_value !== candidate.objective_value) {
      fail('delivery_claim_mismatch', 'document.claimed_objective_value', `候选 QUBO 能量不一致（claimed=${document.claimed_objective_value}, computed=${candidate.objective_value}, offset=${qubo.offset}）；请先省略 claimed_objective_value 和 claimed_summary 获取 summary.candidate_objective_value，再按返回原值更新声明；四舍五入仅用于展示，复算必须包含 offset 和已编码罚项，不能用业务目标替代`);
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

module.exports = { DELIVERY_CONTRACT_VERSION, DeliveryValidationError, validateDelivery, validateRecordedDelivery };
