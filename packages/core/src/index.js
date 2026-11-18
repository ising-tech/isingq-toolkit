'use strict';

const crypto = require('crypto');
const { createBackgroundUpdates } = require('./background-updates');
const { UPDATE_CONTRACT_VERSION, checkUpdate } = require('./update-check');

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
const { MATH_MODEL_CONTRACT_VERSION, MathModelError, validateMathModel, evaluateMathCandidate, compareMathCandidates, VERIFICATION_CAPACITY_CONTRACT_VERSION, verificationCapacity, verificationCapacityBasis } = require('./math-model');
const { REVIEW_FILE_CONTRACT_VERSION, verifyMathModelFile } = require('./review-file');
const { writeMathModelReviewFile } = require('./review-file-writer');
const { VERIFIED_REPORT_CONTRACT_VERSION, VERIFIED_REPORT_ARTIFACT_CONTRACT_VERSION, VerifiedReportError, buildVerifiedReport, verifyReportArtifact } = require('./verified-report');
const { EFFECT_EVIDENCE_CONTRACT_VERSION, executionEvidence, normalizeSetupResult } = require('./effect-evidence');
const { SOLVER_TARGET_CONTRACT_VERSION, TargetEngine, publicTargetRun } = require('./target-service');
const { RESULT_LIMITATIONS, ENERGY_DEFINITION, RECOVERY_CONTRACT_VERSION, publicRun, SolveStartError } = require('./legacy-solve');
const { RECORD_SCHEMA, TERMINAL, canRetrySubmission, submittedProblemDigest, reserveStart, SubmissionPersistenceError,
  submitReservedRun, updatePolledRun, canAdvancePoll } = require('./solve-lifecycle');
const { GUIDED_SOLVE_CONTRACT_VERSION, GuidedSolve, guidedFailure } = require('./guided-solve');
const { GUIDED_RESULT_REVIEW_CONTRACT_VERSION } = require('./guided-result-review');
const { ordinarySetupResult } = require('./guided-tools');
const { GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION } = require('./guided-model-artifacts');

class SolverService {
  constructor({ store = new SolveStore(), transport = null, targetOptions = {} } = {}) {
    this.store = store;
    this.targetEngine = new TargetEngine({ ...targetOptions, store });
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
    const problemSha = submittedProblemDigest(matrix.qubo);
    const projectRun = run => run.schema === RECORD_SCHEMA ? publicTargetRun(run) : publicRun(run);
    const inspect = ({ existing, unresolved }) => {
      if (existing) {
        if (existing.schema === RECORD_SCHEMA || existing.request_digest !== requestDigest) {
          throw new SolveStartError(existing, { projection: projectRun,
            message: `idempotency_key 已用于不同模型或求解参数（含付款选择及原入口，solve_id=${existing.solve_id}）；请核查原任务状态，不要换入口或更换幂等键重提` });
        }
        if (!canRetrySubmission(existing)) {
          if (['failed', 'submission_unknown'].includes(existing.status)) throw new SolveStartError(existing);
          return publicRun(existing);
        }
      }
      if (unresolved) {
        throw new SolveStartError(unresolved, { projection: projectRun,
          message: `同一求解矩阵已有受理未知或正在提交的任务（solve_id=${unresolved.solve_id}）；请先核查原任务，禁止换入口、目标或幂等键重提` });
      }
      return null;
    };
    let credentials;
    const archiveFailure = error => ({ phase: error.code || 'reserve', retryable: false });
    const project = publicRun;
    const { run, replay } = reserveStart({ store: this.store, lock: key => this.targetEngine.lock(key),
      key: idempotencyDigest, problemSha, inspect, project, toIssue: archiveFailure, create: () => {
        const evidence = executionEvidence(this.transport.execution_mode, { strict: true });
        credentials = this.transport.prepareSubmission?.();
        if (credentials?.then) throw new Error('prepareSubmission 必须同步完成凭据校验');
        const timestamp = new Date().toISOString();
        return {
          schema: 'isingq-mcp-solve/v1',
          solve_id: `solve_${crypto.randomUUID().replace(/-/g, '')}`,
          status: 'submitting',
          execution_mode: evidence.execution_mode,
          billing: evidence.billing,
          model_summary: args.model_summary.trim(),
          qubo: matrix.qubo,
          matrix: { num_bits: matrix.qubo.num_bits, sha256: matrix.sha256, size_bytes: matrix.size_bytes },
          submitted_problem_sha256: problemSha,
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
      } });
    if (replay) return replay;
    return submitReservedRun({ store: this.store, run, project, submit: async () => {
      const submitted = await this.transport.submit(matrix, solverOptions, credentials);
      if (typeof submitted?.task_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(submitted.task_id)) {
        throw new IsingQError('IsingQ 创建任务响应缺少有效 task_id', { phase: 'create_task', submissionOutcome: 'unknown', submissionUnknown: true });
      }
      return submitted;
    }, onError: error => {
      const outcome = error instanceof IsingQError && ['not_created', 'rejected'].includes(error.submissionOutcome)
        ? error.submissionOutcome : 'unknown';
      return {
        fields: {
          submission_outcome: outcome,
          status: outcome === 'unknown' ? 'submission_unknown' : 'failed',
          error: {
            phase: error instanceof IsingQError ? error.phase : 'submit',
            http_status: error instanceof IsingQError ? error.status : null,
            retryable: error instanceof IsingQError ? error.retryable : false,
            ...(error instanceof IsingQError && error.providerMessage ? { provider_message: error.providerMessage } : {}),
          },
        },
        error: failed => new SolveStartError(failed),
      };
    } });
  }

  async poll(solveId) {
    const run = this.store.get(solveId);
    if (run.schema === RECORD_SCHEMA) return this.targetEngine.poll(run);
    if (!run.provider_task_id || TERMINAL.has(run.status)) return publicRun(run);
    let observed, queryError;
    try { observed = await this.transport.poll(run.provider_task_id, run.matrix.num_bits); }
    catch (error) { queryError = { error }; }
    return updatePolledRun({ store: this.store, lock: key => this.targetEngine.lock(key), original: run, project: publicRun,
      apply: latest => {
        if (queryError) throw queryError.error;
        if (!canAdvancePoll(latest.status, observed.status)) return { remote: true };
        latest.status = observed.status;
        latest.error = null;
        if (observed.status === 'succeeded') {
          const objective = objectiveEnergy(latest.qubo, observed.bits);
          if (Number.isFinite(objective)) {
            latest.result = {
              bits: observed.bits,
              variables: decodeBits(latest.qubo, observed.bits),
              provider_energy: observed.energy,
              objective_value: objective,
              offset: latest.qubo.offset,
            };
            latest.completed_at = new Date().toISOString();
          } else {
            latest.status = 'result_invalid';
            latest.result = null;
            latest.error = { code: 'target_objective_nonfinite', phase: 'poll', retryable: false,
              message: '原 QUBO 目标值复算超出有限数值范围；请保留记录并核对原模型和候选。' };
          }
        } else if (observed.status === 'failed') {
          latest.error = { phase: 'poll', retryable: false };
          latest.completed_at = new Date().toISOString();
        }
        latest.updated_at = new Date().toISOString();
        return { save: true, remote: true };
      } });
  }

  get(solveId) {
    const run = this.store.get(solveId);
    return run.schema === RECORD_SCHEMA ? publicTargetRun(run) : publicRun(run);
  }

  listTargets(args) { return this.targetEngine.listTargets(args); }
  prepareTarget(args) { return this.targetEngine.prepareTarget(args); }
  startTarget(args, options) { return this.targetEngine.startTarget(args, options); }
  listRuns(args) { return this.targetEngine.listRuns(args); }
  profileList() { return this.targetEngine.profileList(); }
  profileSave(profile) { return this.targetEngine.profileSave(profile); }
  profileDelete(id) { return this.targetEngine.profileDelete(id); }
  openTargetConfig() { return this.targetEngine.openTargetConfig(); }
  guideSolve(args) { try { return (this.guidedSolveEngine ||= new GuidedSolve(this)).call(args); } catch(error) { return Promise.resolve(guidedFailure(error)); } }
  validateTargetDelivery(args) { return this.targetEngine.validateTargetDelivery(args); }
}

module.exports = {
  REVIEW_FILE_CONTRACT_VERSION,
  verifyMathModelFile,
  writeMathModelReviewFile,
  verificationCapacityBasis,
  VERIFICATION_CAPACITY_CONTRACT_VERSION,
  verificationCapacity,
  GUIDED_RESULT_REVIEW_CONTRACT_VERSION,
  GUIDED_SOLVE_CONTRACT_VERSION,
  GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION,
  ordinarySetupResult,
  SOLVER_TARGET_CONTRACT_VERSION,
  createBackgroundUpdates,
  UPDATE_CONTRACT_VERSION,
  checkUpdate,
  FILE_LIMITS_CONTRACT_VERSION: 'isingq-file-limits-v1',
  fileLimit: require('./file-limits').fileLimit,
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
  SubmissionPersistenceError,
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
