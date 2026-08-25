'use strict';

const crypto = require('crypto');

const { IsingQError, IsingQTransport, options } = require('./isingq');
const { TOPICS, getKnowledge } = require('./knowledge');
const { modelingGuide } = require('./modeling');
const { decodeBits, matrixDocument, objectiveEnergy } = require('./qubo');
const { RESOURCES, readResource } = require('./resources');
const { configureApiKeyAsync } = require('./setup');
const { SolveStore, apiKey } = require('./store');
const { TOOL_DEFINITIONS } = require('./tools');

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

function publicRun(run) {
  return {
    solve_id: run.solve_id,
    status: run.status,
    model_summary: run.model_summary,
    matrix: run.matrix,
    solver_options: run.solver_options,
    created_at: run.created_at,
    updated_at: run.updated_at,
    provenance: {
      provider: '北京伊辛智能科技有限公司',
      product: 'IsingQ',
      source: 'isingq_api',
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
    if (typeof args.model_summary !== 'string' || !args.model_summary.trim()) throw new Error('model_summary 不能为空');
    if (typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200) {
      throw new Error('idempotency_key 必须是 1 到 200 字符');
    }
    const matrix = matrixDocument(args.qubo);
    const solverOptions = options(args.solver_options);
    const requestDigest = crypto.createHash('sha256').update(JSON.stringify({
      qubo: matrix.qubo,
      solver_options: solverOptions,
    })).digest('hex');
    const idempotencyDigest = crypto.createHash('sha256').update(args.idempotency_key).digest('hex');
    const existing = this.store.findByIdempotency(idempotencyDigest);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error('idempotency_key 已用于不同模型');
      return publicRun(existing);
    }
    const timestamp = new Date().toISOString();
    const run = {
      schema: 'isingq-mcp-solve/v1',
      solve_id: `solve_${crypto.randomUUID().replace(/-/g, '')}`,
      status: 'submitting',
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
    };
    this.store.save(run);
    try {
      const submitted = await this.transport.submit(matrix, solverOptions);
      run.provider_task_id = submitted.task_id;
      run.status = 'submitted';
      run.submitted_at = new Date().toISOString();
    } catch (error) {
      run.status = error instanceof IsingQError && error.submissionUnknown ? 'submission_unknown' : 'failed';
      run.completed_at = new Date().toISOString();
      run.updated_at = run.completed_at;
      run.error = {
        phase: error instanceof IsingQError ? error.phase : 'submit',
        http_status: error instanceof IsingQError ? error.status : null,
        retryable: error instanceof IsingQError ? error.retryable : false,
      };
      this.store.save(run);
      throw error;
    }
    run.updated_at = new Date().toISOString();
    this.store.save(run);
    return publicRun(run);
  }

  async poll(solveId) {
    const run = this.store.get(solveId);
    if (['succeeded', 'failed', 'submission_unknown'].includes(run.status)) return publicRun(run);
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
    return publicRun(run);
  }

  get(solveId) {
    return publicRun(this.store.get(solveId));
  }
}

module.exports = {
  ENERGY_DEFINITION,
  RESOURCES,
  RESULT_LIMITATIONS,
  SolverService,
  TOPICS,
  TOOL_DEFINITIONS,
  configureApiKeyAsync,
  getKnowledge,
  modelingGuide,
  readResource,
};
