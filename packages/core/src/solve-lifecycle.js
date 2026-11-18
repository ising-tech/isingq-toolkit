'use strict';

const { runWithCleanupSync } = require('./run-with-cleanup');
const { receiptPersistence, SolveStoreError } = require('./store');
const { validateQubo, QUBO_OBJECTIVE_ENERGY_VERSION } = require('./qubo');

const RECORD_SCHEMA = 'isingq-mcp-solve/v2';
const TERMINAL = new Set(['succeeded', 'failed', 'submission_unknown']);
const POLL_RANK = { submitted: 0, queued: 1, running: 2, result_pending: 3, result_invalid: 3, succeeded: 4, failed: 4 };
const UNRESOLVED_STATUSES = new Set(['submitting', 'submission_unknown']);
const KNOWN_STATUSES = new Set([...Object.keys(POLL_RANK), ...UNRESOLVED_STATUSES]);
const now = () => new Date().toISOString();

function submittedProblemDigest(qubo) {
  // Metadata can alter the user's model confirmation but is absent from the
  // uploaded matrix. Do not apply current input limits to historical records.
  return validateQubo({ ...qubo, offset: 0, variables: [] }, { maxBits: Number.MAX_SAFE_INTEGER }).summary.model_sha256;
}

function canRetrySubmission(run) {
  if (run.status !== 'failed' || run.provider_task_id || run.submitted_at) return false;
  if (run.submission_outcome) return run.submission_outcome === 'not_created';
  return run.schema !== RECORD_SCHEMA && ['upload_signature', 'upload'].includes(run.error?.phase);
}

function unresolvedSubmission(run) {
  return UNRESOLVED_STATUSES.has(run.status) || run.submission_outcome === 'unknown'
    || (run.schema !== RECORD_SCHEMA && run.status === 'failed' && !run.submission_outcome
      && !run.provider_task_id && !run.submitted_at && !canRetrySubmission(run));
}

function submissionHistory(store, key, problemSha, previous) {
  const matchesUnresolved = run => {
    if (!KNOWN_STATUSES.has(run.status)) {
      throw new SolveStoreError('solve_record_status_invalid', `历史求解记录缺少可识别状态（solve_id=${run.solve_id}）；请保留原记录并核对备份或原服务的受理记录，未提交新任务`);
    }
    if (!unresolvedSubmission(run)) return false;
    const priorSha = run.submitted_problem_sha256 || run.matrix?.submitted_problem_sha256;
    if (typeof priorSha === 'string' && /^[a-f0-9]{64}$/.test(priorSha)) return priorSha === problemSha;
    try {
      if (run.qubo) return submittedProblemDigest(run.qubo) === problemSha;
    } catch (_) { /* Explain the historical record without exposing its contents. */ }
    throw new SolveStoreError('solve_unresolved_record_invalid', `历史在途记录缺少可核对的求解矩阵（solve_id=${run.solve_id}）；请保留原记录并核对备份或原服务，未提交新任务`);
  };
  if (typeof store.scanSubmission === 'function') return store.scanSubmission(key, matchesUnresolved, previous);
  // Embedded stores without disk paths may supply their own synchronous API.
  // Production disk stores must provide the full shared scan.
  const existing = store.findByIdempotency(key, { includeArchived: true });
  if (typeof store.list !== 'function') return { existing };
  let offset = 0;
  do {
    const page = store.list({ limit: 1, offset });
    const unresolved = page.records.find(matchesUnresolved);
    if (unresolved) return { existing, unresolved };
    offset = page.next_offset;
  } while (offset !== null);
  return { existing };
}

function requireSubmissionHistory(store) {
  if (typeof store.scanSubmission !== 'function' && typeof store.list !== 'function') {
    throw new SolveStoreError('target_store_capability_missing', '本地存储无法完整核查在途提交；请检查存储配置，未提交远端任务');
  }
}

function reserveStart({ store, lock, key, problemSha, previous, inspect, create, project, toIssue, timestamp = now }) {
  const releaseKey = lock(key);
  let releaseModel, run, replay, reserved = false, cleanupError, cleanupFailed = false;
  const releaseOwned = cleanup => {
    try { cleanup?.(); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
  };
  const beforeSubmissionFailure = error => {
    const primary = error && typeof error === 'object' ? error : Object.assign(new Error('本地提交占位失败，尚未发起远端任务提交；请保留原记录并核对存储状态'), { code: 'target_store_unavailable' });
    if (run) {
      if (reserved) {
        const date = timestamp();
        const failed = { ...run, status: 'failed', submission_outcome: 'not_created', error: toIssue(primary), completed_at: date, updated_at: date };
        // Only a completed durable write can turn the conservative unknown
        // reservation into retry evidence.
        try { store.save(failed); run = failed; } catch (_) {}
      }
      primary.run = project(run);
    }
    return primary;
  };
  try {
    runWithCleanupSync(() => {
      releaseModel = lock('model-' + problemSha);
      const history = submissionHistory(store, key, problemSha, previous);
      replay = inspect(history);
      if (replay) return;
      if (history.scanError) throw history.scanError;
      if (store.directory) requireSubmissionHistory(store);
      const existing = history.existing;
      const replacement = create(existing);
      if (existing && !existing.archived_at) {
        if (typeof store.archive !== 'function') throw new Error(`存储不支持归档，已停止重新提交（solve_id=${existing.solve_id}）`);
        store.archive(existing);
      }
      run = replacement;
      store.save(run);
      reserved = true;
    }, () => releaseOwned(releaseModel), () => releaseOwned(releaseKey));
  } catch (error) { throw beforeSubmissionFailure(error); }
  if (replay) return { replay };
  if (cleanupFailed) throw beforeSubmissionFailure(cleanupError);
  return { run };
}

class SubmissionPersistenceError extends Error {
  constructor(run) {
    const ids = `solve_id=${run.solve_id}, provider_task_id=${run.provenance.provider_task_id}`;
    super(`任务提交已受理（${ids}）；${run.receipt_persistence.instructions}`);
    this.code = 'solve_receipt_persistence_failed';
    this.run = run;
  }
}

async function submitReservedRun({ store, run, submit, onError, project, timestamp = now }) {
  let submitted;
  try { submitted = await submit(); }
  catch (error) {
    const date = timestamp();
    const failure = onError(error);
    const failed = { ...run, ...failure.fields, completed_at: date, updated_at: date };
    try { store.save(failed); }
    catch (writeError) {
      // A failed write leaves the existing conservative reservation in place.
      if (writeError instanceof Error) writeError.run = project(run);
      throw writeError;
    }
    throw failure.error(failed);
  }
  const date = timestamp();
  const accepted = { ...run, status: 'submitted', submission_outcome: 'created', provider_task_id: submitted.task_id,
    ...(run.stage === 'create' ? { stage: 'poll' } : {}), submitted_at: date, updated_at: date };
  try {
    store.save(accepted);
  } catch (_) {
    let status = 'not_saved';
    try {
      if (typeof store.saveSubmissionReceipt === 'function') {
        store.saveSubmissionReceipt(accepted);
        status = 'receipt_only';
      }
    } catch (_) {}
    throw new SubmissionPersistenceError(project({ ...accepted, receipt_persistence: receiptPersistence(status) }));
  }
  return project(accepted);
}

function canAdvancePoll(current, observed) {
  return (POLL_RANK[observed] ?? 0) >= (POLL_RANK[current] ?? 0);
}

function updatePolledRun({ store, lock, original, project, sameSource, apply, changedCode = 'solve_record_changed' }) {
  let release;
  try { release = lock('poll-' + original.solve_id); }
  catch (error) {
    if (error.code === 'target_in_flight') return project(store.get(original.solve_id), true);
    throw error;
  }
  try {
    // Network observations can finish out of order. Only the current stored
    // record, re-read under its lock, may be changed by the poll response.
    const latest = store.get(original.solve_id);
    if (TERMINAL.has(latest.status)) return project(latest, true);
    if (latest.schema !== original.schema || latest.provider_task_id !== original.provider_task_id || (sameSource && !sameSource(latest))) {
      throw Object.assign(new Error(`查询期间原任务来源被修改（solve_id=${original.solve_id}）；请保留记录并核对原任务`), { code: changedCode });
    }
    const result = apply(latest);
    if (result.save) {
      if (latest.status === 'succeeded') latest.objective_energy_version = QUBO_OBJECTIVE_ENERGY_VERSION;
      delete latest.receipt_persistence;
      store.save(latest);
    }
    return project(latest, result.remote);
  } finally {
    // Keep the persisted result or primary error even when release fails. The
    // existing inode-checked lock still prevents another owner from writing.
    try { release(); } catch (_) {}
  }
}

module.exports = { RECORD_SCHEMA, TERMINAL, submittedProblemDigest, canRetrySubmission, submissionHistory, requireSubmissionHistory, reserveStart,
  SubmissionPersistenceError, submitReservedRun, canAdvancePoll, updatePolledRun };
