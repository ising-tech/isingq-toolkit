'use strict';

const { executionEvidence } = require('./effect-evidence');
const { canRetrySubmission } = require('./solve-lifecycle');

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
    ...(run.receipt_persistence ? { receipt_persistence: run.receipt_persistence } : {}),
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
  constructor(run, { message, projection = publicRun } = {}) {
    const phase = run.error?.phase || 'unknown';
    const guidance = recoveryFor(run).instructions;
    const diagnostic = diagnosticEvidence(run).provider_message_present ? `；${diagnosticLabel(run)}：${run.error.provider_message}` : '';
    super(message || `求解启动失败（solve_id=${run.solve_id}, status=${run.status}, phase=${phase}, http_status=${run.error?.http_status ?? 'none'}）${diagnostic}；${guidance}`);
    this.run = projection(run);
  }
}

module.exports = { RESULT_LIMITATIONS, ENERGY_DEFINITION, RECOVERY_CONTRACT_VERSION, publicRun, SolveStartError };
