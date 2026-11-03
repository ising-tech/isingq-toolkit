'use strict';

const crypto = require('crypto');

const { CLOUD_SUBMISSION_CONTRACT_VERSION, IsingQError, IsingQTransport, options, validateCloudSubmissionOptions } = require('./isingq');
const { TOPICS, getKnowledge } = require('./knowledge');
const { modelingGuide } = require('./modeling');
const {
  QUBO_CONTRACT_VERSION,
  MODEL_DIGEST_VERSION,
  decodeBits,
  matrixDocument,
  modelDigest,
  objectiveEnergy,
  validateQubo,
} = require('./qubo');
const { RESOURCES, readResource } = require('./resources');
const { configureApiKeyAsync } = require('./setup');
const { SolveStore, apiKey } = require('./store');
const { TOOL_DEFINITIONS, RECOVERY_GUIDANCE } = require('./tools');
const { WORKSPACE_CONTRACT_VERSION, WorkspaceArtifacts, WorkspaceError } = require('./workspace');
const { DELIVERY_CONTRACT_VERSION, DeliveryValidationError, validateDelivery } = require('./delivery');
const { MATH_MODEL_CONTRACT_VERSION, MathModelError, validateMathModel, evaluateMathCandidate, compareMathCandidates } = require('./math-model');
const { VERIFIED_REPORT_CONTRACT_VERSION, VERIFIED_REPORT_ARTIFACT_CONTRACT_VERSION, VerifiedReportError, buildVerifiedReport, verifyReportArtifact } = require('./verified-report');
const { EFFECT_EVIDENCE_CONTRACT_VERSION, executionEvidence, normalizeSetupResult } = require('./effect-evidence');

const RESULT_LIMITATIONS = [
  '结果只对应已提交的 QUBO，不自动证明原始业务硬约束满足。',
  '返回的最低 energy 不构成全局最优保证。',
  '未由 IsingQ API 明确返回设备信息时，不推断或声明实际硬件型号。',
];

const ENERGY_DEFINITION = {
  provider_energy: {
    model: 'ising',
    formula: 'E(s) = -1/2 * Σ_i Σ_j J_ij s_i s_j - Σ_i h_i s_i',
    latex: 'E(\\mathbf{s})=-\\frac{1}{2}\\sum_i\\sum_j J_{ij}s_i s_j-\\sum_i h_i s_i',
    variable_domain: 's_i ∈ {-1,+1}',
    half_factor: '对称耦合矩阵同时包含 J_ij 与 J_ji，1/2 用于消除交叉项的重复计数。',
  },
  objective_value: {
    model: 'qubo',
    formula: 'f(x) = offset + Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j',
    latex: 'f(\\mathbf{x})=\\mathrm{offset}+\\sum_i Q_{ii}x_i+\\sum_{i<j}Q_{ij}x_i x_j',
    variable_domain: 'x_i ∈ {0,1}',
    convention: 'upper_triangular',
  },
  relationship: 'provider_energy 是 IsingQ 返回的伊辛能量；objective_value 是 MCP 按用户确认的 QUBO 重新计算的目标值。两者可能因变量转换、常数项或系数口径而不同。',
};

const RECOVERY_CONTRACT_VERSION = 'isingq-recovery-v1';
function diagnosticEvidence(run) {
  const present = typeof run.error?.provider_message === 'string' && run.error.provider_message.trim().length > 0;
  const mode = executionEvidence(run.execution_mode).execution_mode;
  return { provider_message_present: present,
    provider_message_source: present ? (mode === 'live' ? 'isingq_api' : mode) : 'absent',
    available_error_fields: ['phase', 'http_status'].filter(key => run.error?.[key] !== undefined && run.error[key] !== null)
      .concat(present ? ['provider_message'] : []) };
}
function diagnosticLabel(run) {
  const source = diagnosticEvidence(run).provider_message_source;
  return source === 'simulation' ? '模拟诊断' : source === 'isingq_api' ? '平台提示' : '来源未核实的诊断';
}
function recoveryFor(run) {
  const diagnostic = diagnosticEvidence(run);
  const diagnosticStep = diagnostic.provider_message_present
    ? `本记录提供了 ${diagnosticLabel(run)}（error.provider_message），结合实际 phase/http_status 核对；提示本身不证明完整根因。`
    : '本记录未提供 provider_message；仅按已有 phase/http_status 定位失败阶段，不能声称平台返回了原因或脱敏提示。请先核对当前请求参数与对应接口要求；仍无法定位时提供阶段和HTTP状态向维护者核查，不猜测付款或鉴权原因。';
  const retry = canRetrySubmission(run);
  const created = Boolean(run.provider_task_id || run.submitted_at || run.submission_outcome === 'created');
  const rejected = !created && run.submission_outcome === 'rejected';
  const action = retry ? 'repair_then_retry_same_request' : created ? 'inspect_existing_task' : rejected ? 'diagnose_rejection' : 'reconcile_externally';
  const instructions = retry
    ? '已确认未创建任务；修复失败阶段后，可用相同模型、求解参数和原幂等键重试。'
    : rejected
      ? `本次创建请求被拒绝；原幂等键已占用，不支持同键重试。${diagnosticStep}当前根因未核实，先诊断或人工核查；规范化前后语义相同的改写不算修复，不据此建议新任务。模拟记录交模拟执行者核查，真实记录可向平台支持提供阶段/HTTP状态与任务时段。若用户主动要求新任务，仍按已有流程展示摘要、付款及新增任务影响，取得新的提交确认后使用新键；不得称其为已修复重试。不要删除或作废旧记录。`
      : created
        ? '已有任务记录，不重新提交。非终态且有 provider_task_id 时 poll 可查询远端；终态 poll 和 get 仅读本地记录。需要进一步核查远端任务时，使用平台控制台或联系支持。'
        : '受理情况未知，原键重试被阻止；不要更换键、删除、归档或作废记录后重建。poll/get 仅读本地记录，不能查证远端受理。请在平台控制台核对提交时段与模型，或向平台支持提供 created_at、matrix.sha256 和已有 provider_task_id；solve_id 只是本地关联号。取得可核对的远端结论后再决定后续动作，当前工具没有远端查重或解除 unknown 的接口。';
  return { contract_version: RECOVERY_CONTRACT_VERSION, action, same_key_retry_allowed: retry,
    diagnostic_evidence: diagnostic,
    ...(rejected ? { root_cause_status: 'unverified', equivalent_normalization_is_repair: false } : {}),
    idempotency_scope: 'local_store', remote_deduplication: 'unverified',
    poll_behavior: !run.provider_task_id || ['succeeded', 'failed', 'submission_unknown'].includes(run.status) ? 'local_record_only' : 'remote_query',
    instructions, billing_instruction: executionEvidence(run.execution_mode).billing.status === 'not_applicable'
      ? '本次模拟操作不涉及真实计费，无需为本模拟单查询真实扣费；这不说明账户其他活动或历史任务的费用为零。'
      : '以 billing 字段为准；unverified 表示实际费用未知，不能承诺不扣费、已退款或远端防重复扣费。' };
}
function publicRun(run, remoteRequestPerformed = false) {
  const evidence = executionEvidence(run.execution_mode);
  return {
    solve_id: run.solve_id,
    status: run.status,
    recovery: recoveryFor(run),
    observation: { scope: 'status_query', interpretation: 'remote_request_performed仅描述本次状态查询是否发起远端poll，不证明创建历史或其他调用是否联网；执行来源另见execution_mode。', source: remoteRequestPerformed ? 'remote_poll' : 'local_record', remote_request_performed: remoteRequestPerformed },
    submission_outcome: run.submission_outcome || null,
    execution_mode: evidence.execution_mode,
    billing: evidence.billing,
    model_summary: run.model_summary,
    matrix: run.matrix,
    solver_options: run.solver_options,
    created_at: run.created_at,
    updated_at: run.updated_at,
    provenance: {
      provider: '北京伊辛智能科技有限公司',
      product: 'IsingQ',
      source: evidence.source,
      local_solve_id: run.solve_id,
      provider_task_id: run.provider_task_id,
      matrix_sha256: run.matrix.sha256,
      submitted_at: run.submitted_at || null,
      observed_at: run.updated_at,
      completed_at: run.completed_at || null,
    },
    limitations: RESULT_LIMITATIONS,
    energy_definition: ENERGY_DEFINITION,
    result: run.result || null,
    error: run.error || null,
  };
}

class SolveStartError extends Error {
  constructor(run) {
    const phase = run.error?.phase || 'unknown';
    const guidance = recoveryFor(run).instructions;
    const diagnostic = diagnosticEvidence(run).provider_message_present ? `；${diagnosticLabel(run)}：${run.error.provider_message}` : '';
    super(`求解启动失败（solve_id=${run.solve_id}, status=${run.status}, phase=${phase}, http_status=${run.error?.http_status ?? 'none'}）${diagnostic}；${guidance}`);
    this.run = publicRun(run);
  }
}

function canRetrySubmission(run) {
  if (run.status !== 'failed' || run.provider_task_id || run.submitted_at) return false;
  if (run.submission_outcome) return run.submission_outcome === 'not_created';
  // Older records have no outcome. Only known pre-create phases are evidence
  // that no remote task exists; legacy generic submit failures stay blocked.
  return ['upload_signature', 'upload'].includes(run.error?.phase);
}

class SolverService {
  constructor({ store = new SolveStore(), transport = null } = {}) {
    this.store = store;
    this.transport = transport || new IsingQTransport({
      apiKey: () => apiKey(),
      timeoutSeconds: Number(process.env.ISINGQ_TIMEOUT_SECONDS || 30),
    });
  }

  validate(qubo) {
    const document = matrixDocument(qubo);
    return { ...document.summary, matrix_sha256: document.sha256, matrix_size_bytes: document.size_bytes };
  }

  async start(args) {
    const solverOptions = validateCloudSubmissionOptions(args?.solver_options);
    if (typeof args.model_summary !== 'string' || !args.model_summary.trim()) throw new Error('model_summary 不能为空');
    if (typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200) {
      throw new Error('idempotency_key 必须是 1 到 200 字符');
    }
    const matrix = matrixDocument(args.qubo);
    const requestDigest = crypto.createHash('sha256').update(JSON.stringify({
      qubo: matrix.qubo,
      solver_options: solverOptions,
    })).digest('hex');
    const idempotencyDigest = crypto.createHash('sha256').update(args.idempotency_key).digest('hex');
    const existing = this.store.findByIdempotency(idempotencyDigest, { includeArchived: true });
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error('idempotency_key 已用于不同模型或求解参数（含付款选择）；请核查原任务状态，不要更换幂等键盲目重提');
      if (!canRetrySubmission(existing)) {
        if (['failed', 'submission_unknown'].includes(existing.status)) throw new SolveStartError(existing);
        return publicRun(existing);
      }
    }
    // Synchronous preflight preserves the lookup -> reservation boundary. An
    // injected transport without this hook retains its existing submit API, but
    // its unclassified failures are conservatively treated as unknown.
    const evidence = executionEvidence(this.transport.execution_mode, { strict: true });
    const credentials = this.transport.prepareSubmission?.();
    if (credentials && typeof credentials.then === 'function') throw new Error('prepareSubmission 必须同步完成凭据校验');
    if (existing && !existing.archived_at) {
      if (typeof this.store.archive !== 'function') throw new Error(`存储不支持归档，已停止重新提交（solve_id=${existing.solve_id}）`);
      this.store.archive(existing);
    }
    const timestamp = new Date().toISOString();
    const run = {
      schema: 'isingq-mcp-solve/v1',
      solve_id: `solve_${crypto.randomUUID().replace(/-/g, '')}`,
      status: 'submitting',
      execution_mode: evidence.execution_mode,
      billing: evidence.billing,
      model_summary: args.model_summary.trim(),
      qubo: matrix.qubo,
      matrix: { num_bits: matrix.qubo.num_bits, sha256: matrix.sha256, size_bytes: matrix.size_bytes },
      solver_options: solverOptions,
      request_digest: requestDigest,
      idempotency_digest: idempotencyDigest,
      provider_task_id: null,
      result: null,
      error: null,
      created_at: timestamp,
      updated_at: timestamp,
      submitted_at: null,
      completed_at: null,
      submission_outcome: 'unknown',
    };
    this.store.save(run);
    try {
      const submitted = await this.transport.submit(matrix, solverOptions, credentials);
      if (typeof submitted?.task_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(submitted.task_id)) {
        throw new IsingQError('IsingQ 创建任务响应缺少有效 task_id', { phase: 'create_task', submissionOutcome: 'unknown', submissionUnknown: true });
      }
      run.provider_task_id = submitted.task_id;
      run.submission_outcome = 'created';
      run.status = 'submitted';
      run.submitted_at = new Date().toISOString();
    } catch (error) {
      run.submission_outcome = error instanceof IsingQError && ['not_created', 'rejected'].includes(error.submissionOutcome)
        ? error.submissionOutcome : 'unknown';
      run.status = run.submission_outcome === 'unknown' ? 'submission_unknown' : 'failed';
      run.completed_at = new Date().toISOString();
      run.updated_at = run.completed_at;
      run.error = {
        phase: error instanceof IsingQError ? error.phase : 'submit',
        http_status: error instanceof IsingQError ? error.status : null,
        retryable: error instanceof IsingQError ? error.retryable : false,
        ...(error instanceof IsingQError && error.providerMessage ? { provider_message: error.providerMessage } : {}),
      };
      this.store.save(run);
      throw new SolveStartError(run);
    }
    run.updated_at = new Date().toISOString();
    this.store.save(run);
    return publicRun(run);
  }

  async poll(solveId) {
    const run = this.store.get(solveId);
    if (!run.provider_task_id || ['succeeded', 'failed', 'submission_unknown'].includes(run.status)) return publicRun(run);
    const observed = await this.transport.poll(run.provider_task_id, run.matrix.num_bits);
    run.status = observed.status;
    if (observed.status === 'succeeded') {
      run.result = {
        bits: observed.bits,
        variables: decodeBits(run.qubo, observed.bits),
        provider_energy: observed.energy,
        objective_value: objectiveEnergy(run.qubo, observed.bits),
        offset: run.qubo.offset,
      };
      run.completed_at = new Date().toISOString();
    } else if (observed.status === 'failed') {
      run.error = { phase: 'poll', retryable: false };
      run.completed_at = new Date().toISOString();
    }
    run.updated_at = new Date().toISOString();
    this.store.save(run);
    return publicRun(run, true);
  }

  get(solveId) {
    return publicRun(this.store.get(solveId));
  }
}

module.exports = {
  RECOVERY_GUIDANCE,
  RECOVERY_CONTRACT_VERSION,
  EFFECT_EVIDENCE_CONTRACT_VERSION,
  normalizeSetupResult,
  MATH_MODEL_CONTRACT_VERSION,
  MathModelError,
  validateMathModel,
  evaluateMathCandidate,
  compareMathCandidates,
  VERIFIED_REPORT_CONTRACT_VERSION,
  VERIFIED_REPORT_ARTIFACT_CONTRACT_VERSION,
  verifyReportArtifact,
  VerifiedReportError,
  buildVerifiedReport,
  CLOUD_SUBMISSION_CONTRACT_VERSION,
  validateCloudSubmissionOptions,
  DELIVERY_CONTRACT_VERSION,
  DeliveryValidationError,
  validateDelivery,
  WORKSPACE_CONTRACT_VERSION,
  WorkspaceArtifacts,
  WorkspaceError,
  ENERGY_DEFINITION,
  QUBO_CONTRACT_VERSION,
  MODEL_DIGEST_VERSION,
  RESOURCES,
  RESULT_LIMITATIONS,
  SolverService,
  SolveStartError,
  TOPICS,
  TOOL_DEFINITIONS,
  configureApiKeyAsync,
  validateSolverOptions: options,
  decodeBits,
  getKnowledge,
  matrixDocument,
  modelDigest,
  modelingGuide,
  objectiveEnergy,
  readResource,
  validateQubo,
};
