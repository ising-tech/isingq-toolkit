'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { unlinkOwnedFileSync } = require('./owned-file');
const path = require('node:path');
const { matrixDocument, validateQubo, decodeBits, objectiveEnergy } = require('./qubo');
const { publicRun } = require('./legacy-solve');
const { RECORD_SCHEMA, TERMINAL, canRetrySubmission, submittedProblemDigest, submissionHistory, requireSubmissionHistory, reserveStart,
  submitReservedRun, updatePolledRun, canAdvancePoll } = require('./solve-lifecycle');
const { apiKey } = require('./store');
const { fileLimit } = require('./file-limits');
const { executionEvidence } = require('./effect-evidence');
const { validateRecordedDelivery } = require('./delivery');
const { IsingQError } = require('./isingq');
const { LOCAL_MANAGEMENT_CONFIRMATION_GUIDANCE, resultInterpretationPolicy, LOCAL_MANAGEMENT_ACTION,
  localPreparationPresentationPolicy } = require('./modeling');
const { localOptions } = require('./local-target');

const SOLVER_TARGET_CONTRACT_VERSION = 'isingq-solver-target-v1';
const PREPARATION_CONFIRMATION_NOTE = 'preparation_token仅绑定准备依据，不证明人类授权；Host须在同一求解确认环节展示当前摘要并取得本次明确确认。';
function localPreparationPresentation(target, ready, issues) {
  const policy = localPreparationPresentationPolicy();
  return { ...policy,
    summary: {
      business_scope_source: 'host_current_task',
      selected_target: { kind: 'local', profile_id: target.profile_id, name: target.name ?? null },
      data_egress: { destination_api_base_url: target.api_base_url ?? null,
        destination_status: target.api_base_url ? 'known_selected_target' : 'unknown',
        preparation_uploads_matrix: false, matrix_sent_only_after_confirmation: true },
      device_occupancy: { status: 'not_started', on_confirm: 'uses_selected_local_solver' },
      readiness: { ready, issues: structuredClone(issues) },
    },
    actions: policy.actions.map(action => ({ ...action, enabled: action.id !== 'confirm_submit' || ready })),
  };
}
function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function fail(code, message, extra = {}) { throw Object.assign(new Error(message), { code, ...extra }); }
function fields(value, allowed, label) {
  if (!object(value)) fail('target_input_invalid', label + ' 必须为object');
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail('target_input_invalid', label + ' 包含未知字段（fields=' + unknown.join(',') + '）');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function targetReference(input) {
  if (!object(input)) fail('target_required', '请明确选择云机型或具名本地连接；新求解入口没有默认目标');
  if (input.kind === 'cloud') {
    fields(input, ['kind', 'environment', 'computer_type_id'], 'target');
    if (!['sit', 'prod'].includes(input.environment) || !Number.isSafeInteger(input.computer_type_id) || input.computer_type_id < 1) {
      fail('target_invalid', '云目标需要environment=sit/prod及目录返回的正整数computer_type_id');
    }
    return { kind: 'cloud', environment: input.environment, computer_type_id: input.computer_type_id };
  }
  if (input.kind === 'local') {
    fields(input, ['kind', 'profile_id'], 'target');
    if (typeof input.profile_id !== 'string' || !/^local_[a-f0-9-]{16,64}$/.test(input.profile_id)) fail('target_invalid', '本地目标需要已保存的稳定profile_id；请刷新连接列表');
    return { kind: 'local', profile_id: input.profile_id };
  }
  fail('target_invalid', 'target.kind 必须是cloud或local');
}
function intentOptions(target, input = {}) {
  if (target.kind === 'local') return localOptions(input);
  const options = input === undefined ? {} : input;
  const allowed = target.kind === 'cloud' ? ['computer_type_id', 'question_type', 'calculate_count', 'post_process', 'use_credit'] : ['task_mode'];
  fields(options, allowed, 'solver_options');
  for (const key of Object.keys(options)) if (options[key] === null) fail('target_options_invalid', 'solver_options不能为null（field=' + key + '）');
  if (options.computer_type_id !== undefined && options.computer_type_id !== target.computer_type_id) fail('target_options_invalid', 'solver_options.computer_type_id与所选目标不一致');
  if (options.question_type !== undefined && options.question_type !== 1) fail('target_options_invalid', '本次仅接续现有QUBO，question_type必须为1');
  return { calculate_count: options.calculate_count ?? 1, post_process: options.post_process ?? null, use_credit: options.use_credit ?? false };
}
function issue(error) {
  const providerMessage = error instanceof IsingQError && error.providerMessage;
  return { code: error.code || 'target_not_ready', message: error.message + (providerMessage ? '；提供方提示：' + providerMessage : ''),
    ...(providerMessage ? { provider_message: providerMessage } : {}),
    ...(Number.isInteger(error.providerCode) ? { provider_code: error.providerCode } : {}), ...(error.phase ? { phase: error.phase } : {}),
    ...(error.status ? { http_status: error.status } : {}), ...(error.retryAfterSeconds != null ? { retry_after_seconds: error.retryAfterSeconds } : {}) };
}
function viewSnapshot(target) {
  return { kind: target.web_base_url ? 'homepage' : 'unconfigured', url: target.web_base_url || null,
    label: target.kind === 'cloud' ? '在原环境云平台查看' : '打开原设备页面',
    guidance: target.web_base_url ? '使用本记录的平台／设备任务号或任务名在该主页查找；当前未声明任务详情深链。' : '尚未核实网页入口；请提供原环境／设备网页地址。API地址不是任务详情网页。',
    api_is_not_web: true };
}
function publicTargetRun(run, remote = false) {
  const evidence = executionEvidence(run.execution_mode, { targetKind: run.target.kind });
  const source = evidence.execution_mode === 'live' ? (run.target.kind === 'local' ? 'local_ising_http' : 'isingq_api') : evidence.source;
  const unknown = run.submission_outcome === 'unknown' || ['submitting', 'submission_unknown'].includes(run.status);
  return {
    solve_id: run.solve_id, status: run.status, stage: run.stage, result_state: run.result_state,
    target: structuredClone(run.target), view: { ...run.view, provider_task_id: run.provider_task_id, provider_task_name: run.provider_task_name },
    model_summary: run.model_summary, matrix: run.matrix, file: run.file, solver_options: run.solver_options,
    provider_status: run.provider_status ?? null, submission_outcome: run.submission_outcome,
    execution_mode: evidence.execution_mode, billing: evidence.billing,
    ...(run.receipt_persistence ? { receipt_persistence: run.receipt_persistence } : {}),
    observation: { scope: 'status_query', source: remote ? 'remote_poll' : 'local_record', remote_request_performed: remote },
    provenance: { source, target_kind: run.target.kind, local_solve_id: run.solve_id, provider_task_id: run.provider_task_id,
      provider_task_name: run.provider_task_name, matrix_sha256: run.matrix.sha256, submitted_at: run.submitted_at,
      actual_hardware: run.actual_hardware || null },
    recovery: { contract_version: 'isingq-recovery-v1', same_key_retry_allowed: canRetrySubmission(run),
      action: unknown ? 'reconcile_externally' : run.provider_task_id ? 'inspect_existing_task' : 'diagnose_rejection',
      idempotency_scope: 'local_store', remote_deduplication: 'unverified',
      instructions: unknown ? '受理未知：保留原记录并核查原服务／原任务名；禁止换目标、换键、删除记录或盲目重提。'
        : run.provider_task_id ? '按本记录原目标续查或查看；切换当前目标和修改连接不改变原任务。'
          : '核对本记录失败阶段；仅已证实未创建且原准备依据未变化时可使用原键重试，其他情形先查证。' },
    created_at: run.created_at, updated_at: run.updated_at, submitted_at: run.submitted_at, completed_at: run.completed_at,
    result: run.result || null, error: run.error || null,
    // A read-time evidence boundary, not a diagnosis or a rewrite of history.
    result_interpretation: resultInterpretationPolicy(),
    limitations: ['选择与请求目标不自动证明实际物理硬件；只有提供方实际执行证据才可说明。',
      'provider_energy与原QUBO目标值分别保存；结果不自动证明业务可行或全局最优。',
      '设备计算耗时与端到端耗时不同；公开报价、任务成功与实际费用核实不同。'],
  };
}

class TargetEngine {
  constructor({ store, environment = process.env, profileStore, catalogClientFactory, cloudTransportFactory, localTransportFactory,
    environments, prepareCloud, prepareLocal, recommendCloud, now = () => new Date().toISOString() } = {}) {
    this.store = store; this.environment = environment; this.profiles = profileStore; this.clients = new Map();
    this.catalogClientFactory = catalogClientFactory; this.cloudTransportFactory = cloudTransportFactory; this.localTransportFactory = localTransportFactory;
    this.environments = environments; this.prepareCloud = prepareCloud; this.prepareLocal = prepareLocal; this.recommendCloud = recommendCloud; this.now = now;
  }
  profileStore() { return this.profiles ||= new (require('./solver-profiles').SolverProfileStore)(this.environment); }
  limits() { return { maxBits: Number.MAX_SAFE_INTEGER, maxMatrixBytes: fileLimit('localFile', this.environment) }; }
  profileList() { return this.profileStore().list(); }
  profileSave(profile) { return this.profileStore().save(profile); }
  profileDelete(id) { return this.profileStore().delete(id); }
  openTargetConfig() { return require('./target-config-page').launchTargetConfig({ profileStore: this.profileStore() }); }
  cloudEnvironment(name) {
    const config = this.environments || require('./cloud-target').CLOUD_ENVIRONMENTS;
    const entry = config[name];
    if (!entry) fail('target_environment_invalid', '没有配置所选云环境（environment=' + name + '）');
    return { ...entry, web_base_url: entry.web_base_url || (name === 'prod' && entry.api_base_url === 'https://api.isingq.com' ? 'https://console.isingq.com' : null) };
  }
  catalog(name) {
    if (!this.clients.has(name)) {
      const settings = this.cloudEnvironment(name);
      this.clients.set(name, this.catalogClientFactory ? this.catalogClientFactory(settings, name) : new (require('./cloud-target').CloudCatalogClient)({ baseUrl: settings.api_base_url }));
    }
    return this.clients.get(name);
  }
  transport(snapshot, { restore = false } = {}) {
    if (snapshot.kind === 'cloud') return this.cloudTransportFactory ? this.cloudTransportFactory(snapshot)
      : new (require('./cloud-target').CloudTargetTransport)({ baseUrl: snapshot.api_base_url, apiKey: () => apiKey(this.environment) });
    if (restore && (!snapshot.effective_contract?.result_domain || !snapshot.adapter_version)) {
      fail('target_record_protocol_missing', '历史记录缺少已生效的适配器版本或结果域；保留原结果并核实原接口，不能用当前配置或向量值域猜测解码');
    }
    const local = require('./local-target');
    if (restore && snapshot.adapter_version !== local.LOCAL_ADAPTER_VERSION) {
      fail('target_record_protocol_unsupported', '原记录适配器版本当前不受支持（adapter_version=' + snapshot.adapter_version + '）；请使用匹配运行时查询，不迁移或重提原任务');
    }
    const profile = { id: snapshot.profile_id, revision: snapshot.revision, name: snapshot.name, api_base_url: snapshot.api_base_url,
      web_base_url: snapshot.web_base_url, contract: snapshot.effective_contract || snapshot.contract };
    return this.localTransportFactory ? this.localTransportFactory(snapshot) : new local.LocalSolverTransport({ profile, environment: this.environment });
  }
  async listTargets(args = {}) {
    fields(args, ['environment', 'qubo', 'solver_options', 'include_cloud'], '目标列表参数');
    const environment = args.environment || 'prod';
    if (!['sit', 'prod'].includes(environment)) fail('target_environment_invalid', 'environment必须为sit或prod');
    if (args.include_cloud !== undefined && typeof args.include_cloud !== 'boolean') fail('target_input_invalid', 'include_cloud必须为boolean');
    const profiles = this.profileList();
    const cloud = { environment, targets: [], advice: [], status: args.include_cloud === false ? 'not_requested' : 'pending' };
    if (args.include_cloud !== false) {
      try {
        const catalog = await this.catalog(environment).get();
        cloud.targets = structuredClone(catalog.computerTypes); cloud.upload_limits = catalog.uploadLimits; cloud.status = 'available';
        if (args.qubo !== undefined) {
          try {
            const matrix = matrixDocument(args.qubo, this.limits());
            cloud.advice = (this.recommendCloud || require('./cloud-target').recommendCloudTargets)(matrix, catalog, args.solver_options || {});
          } catch (error) { cloud.advice_status = 'unavailable'; cloud.advice_issue = issue(error); }
        }
      } catch (error) { cloud.status = 'unavailable'; cloud.error = issue(error); }
    }
    return { contract_version: SOLVER_TARGET_CONTRACT_VERSION, cloud, local: { profiles,
      management: structuredClone(LOCAL_MANAGEMENT_ACTION) }, advice_is_optional: true };
  }
  async prepareInternal(args) {
    fields(args, ['target', 'qubo', 'solver_options'], '求解准备参数');
    const reference = targetReference(args.target);
    intentOptions(reference, args.solver_options);
    const matrix = matrixDocument(args.qubo, this.limits());
    let prepared, snapshot, extra = {};
    if (reference.kind === 'cloud') {
      const environment = this.cloudEnvironment(reference.environment), catalog = await this.catalog(reference.environment).get();
      const entry = catalog.computerTypes.find(item => item.id === reference.computer_type_id);
      if (!entry) fail('target_unavailable', '所选云机型已不在当前环境目录；请保留模型并重新选择，不会自动改选');
      const input = { ...(args.solver_options || {}) };
      if (entry.price === 0 && input.use_credit === undefined) input.use_credit = false;
      prepared = (this.prepareCloud || require('./cloud-target').prepareCloudTarget)(matrix, entry, catalog, input);
      snapshot = { ...reference, name: entry.name ?? String(entry.id), api_base_url: environment.api_base_url, web_base_url: environment.web_base_url,
        entry: structuredClone(entry), capabilities: structuredClone(prepared.capabilities), upload_limits: structuredClone(catalog.uploadLimits) };
    } else {
      const profile = this.profileStore().get(reference.profile_id);
      snapshot = { ...reference, name: profile.name, api_base_url: profile.api_base_url, web_base_url: profile.web_base_url || null,
        revision: profile.revision, contract: structuredClone(profile.contract || null) };
      const probe = await this.transport(snapshot).probe();
      snapshot.device_capabilities = { deviceName: probe.config.deviceName, version: probe.config.version,
        maxScale: probe.config.maxScale, maxPrecision: probe.config.maxPrecision };
      // A profile may change while the asynchronous network check is pending.
      if (digest(profile) !== digest(this.profileStore().get(reference.profile_id))) fail('target_changed', '检查期间连接配置发生变化；请刷新本次摘要并重新确认');
      try {
        prepared = (this.prepareLocal || require('./local-target').prepareLocalTarget)(matrix, profile, probe, args.solver_options, { environment: this.environment });
      } catch (error) {
        error.prepared_target = snapshot; error.device_probe = probe; throw error;
      }
      snapshot.adapter_version = prepared.adapter_version;
      snapshot.effective_contract = structuredClone(prepared.effective_contract);
      snapshot.declared_constraints = structuredClone(prepared.declared_constraints);
      snapshot.precision = structuredClone(prepared.precision);
      extra = { device: probe, encoding: prepared.encoding, adapter_version: prepared.adapter_version,
        effective_contract: prepared.effective_contract, declared_constraints: prepared.declared_constraints,
        precision: prepared.precision, client_capacity: prepared.client_capacity };
    }
    const basis = { contract_version: SOLVER_TARGET_CONTRACT_VERSION, target: snapshot, model_sha256: matrix.summary.model_sha256,
      matrix_sha256: matrix.sha256, file_sha256: prepared.file.sha256, solver_options: prepared.solver_options };
    return { reference, snapshot, matrix, prepared, extra, token: 'prep_' + digest(basis) };
  }
  async prepareTarget(args) {
    const reference = targetReference(args?.target);
    // Preparation has not executed a task. Declare only billing applicability,
    // using the validated selection even when subsequent readiness checks fail.
    const billing = executionEvidence(undefined, { targetKind: reference.kind }).billing;
    // Keep the management branch available at the final preparation handoff,
    // including a failed check; listing it never opens a page.
    const localInteraction = (target, ready, issues) => reference.kind === 'local' ? {
      local: { management: structuredClone(LOCAL_MANAGEMENT_ACTION) },
      confirmation_note: PREPARATION_CONFIRMATION_NOTE + LOCAL_MANAGEMENT_CONFIRMATION_GUIDANCE,
      presentation: localPreparationPresentation(target, ready, issues),
    } : {};
    try {
      const value = await this.prepareInternal(args);
      return { contract_version: SOLVER_TARGET_CONTRACT_VERSION, preparation_token: value.token, target: value.snapshot,
        solver_options: value.prepared.solver_options, matrix: { ...value.matrix.summary, sha256: value.matrix.sha256, size_bytes: value.matrix.size_bytes },
        file: { format: value.prepared.file.format, sha256: value.prepared.file.sha256, size_bytes: value.prepared.file.size_bytes },
        ready: true, issues: [], advice: value.prepared.advice || [], advice_is_optional: true, view: viewSnapshot(value.snapshot), ...value.extra, billing,
        confirmation_note: PREPARATION_CONFIRMATION_NOTE, ...localInteraction(value.snapshot, true, []) };
    } catch (error) {
      const target = error.prepared_target || reference, issues = [issue(error)];
      return { contract_version: SOLVER_TARGET_CONTRACT_VERSION, target,
        ...(error.device_probe ? { device: error.device_probe } : {}), ready: false, issues, advice_is_optional: true, preparation_token: null, billing,
        ...localInteraction(target, false, issues) };
    }
  }
  lock(key) {
    if (!this.store.directory) return () => {}; // Test-only in-memory stores retain synchronous lookup/reserve behavior.
    const directory = path.join(this.store.directory, '.target-locks');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, key + '.lock');
    let fd, identity, created = false;
    try {
      fd = fs.openSync(file, 'wx', 0o600); created = true;
      identity = fs.fstatSync(fd);
      fs.writeFileSync(fd, String(process.pid));
      const ownedFd = fd; fd = undefined; fs.closeSync(ownedFd);
    } catch (error) {
      if (fd !== undefined) {
        if (!identity) { try { identity = fs.fstatSync(fd); } catch (_) {} }
        const ownedFd = fd; fd = undefined; try { fs.closeSync(ownedFd); } catch (_) {}
      }
      try { unlinkOwnedFileSync(file, identity); } catch (_) {}
      if (!created && error.code === 'EEXIST') fail('target_in_flight', '同一逻辑提交正在建立记录；请先查询原调用记录。进程异常退出后保留锁需维护者核查，不要换键重提');
      fail('target_store_unavailable', '无法锁定本地提交记录；请检查私有数据目录权限与磁盘空间，未提交远端任务');
    }
    return () => unlinkOwnedFileSync(file, identity);
  }

  async startTarget(args, { beforeCreate, guidedReview } = {}) {
    fields(args, ['target', 'qubo', 'solver_options', 'preparation_token', 'model_summary', 'idempotency_key'], '目标提交参数');
    const reference = targetReference(args.target);
    if (typeof args.model_summary !== 'string' || !args.model_summary.trim() || args.model_summary.length > 8000) fail('target_summary_required', 'model_summary须为1到8000字符的本次求解摘要');
    if (typeof args.idempotency_key !== 'string' || !args.idempotency_key || args.idempotency_key.length > 200) fail('target_key_required', 'idempotency_key须为1到200字符的本次稳定逻辑标识');
    if (typeof args.preparation_token !== 'string' || !/^prep_[a-f0-9]{64}$/.test(args.preparation_token)) fail('target_preparation_required', '须先准备并重新核对本次摘要，提供对应preparation_token');
    const normalized = validateQubo(args.qubo, this.limits()).qubo;
    const problemSha = submittedProblemDigest(normalized);
    const intent = digest({ target: reference, qubo: normalized, solver_options: intentOptions(reference, args.solver_options) });
    const key = crypto.createHash('sha256').update(args.idempotency_key).digest('hex');
    const projectRun = run => run.schema === RECORD_SCHEMA ? publicTargetRun(run) : publicRun(run);
    const inspect = ({ existing, unresolved }) => {
      if (existing) {
        if (existing.schema !== RECORD_SCHEMA || existing.intent_digest !== intent) {
          fail('target_key_conflict', '原幂等键已用于不同模型、目标或参数（solve_id=' + existing.solve_id + '）；请先核对原任务，不要换入口或换键盲目重提',
            { run: projectRun(existing) });
        }
        if (!canRetrySubmission(existing)) {
          const result = publicTargetRun(existing);
          if (['failed', 'submission_unknown'].includes(existing.status)) fail('target_previous_submission', result.recovery.instructions, { run: result });
          return result;
        }
      }
      requireSubmissionHistory(this.store);
      if (unresolved) {
        fail('target_unresolved_submission', '同一求解矩阵已有受理未知或正在提交的调用（solve_id=' + unresolved.solve_id + '）；offset或变量说明变化不改变已上传问题，请先核查原服务，不得换入口、幂等键、目标或参数重提',
          { run: projectRun(unresolved) });
      }
      return null;
    };
    const previous = submissionHistory(this.store, key, problemSha);
    const initialReplay = inspect(previous);
    if (initialReplay) return initialReplay;
    if (previous.scanError) throw previous.scanError;
    const ready = await this.prepareInternal({ target: args.target, qubo: args.qubo, solver_options: args.solver_options });
    if (ready.token !== args.preparation_token) fail('target_preparation_changed', '所选机型、能力、报价、连接或实际参数已变化；请重新准备并展示变化，取得本次适用确认后再提交。未上传或创建任务。');
    // Trusted embedding guard, after the final asynchronous preparation and
    // before credentials, reservation or any provider create/upload. Not an MCP input.
    if (beforeCreate !== undefined) {
      if (typeof beforeCreate !== 'function') fail('target_guard_invalid','创建前检查必须是可信同步函数');
      const checked = beforeCreate();
      if (checked?.then) fail('target_guard_invalid','创建前检查必须同步完成；未创建任务');
    }
    const transport = this.transport(ready.snapshot);
    const evidence = executionEvidence(transport.execution_mode, { strict: true, targetKind: ready.snapshot.kind });
    let credentials;
    try { credentials = transport.prepareSubmission?.(); }
    catch (error) { error.code ||= 'target_credentials_unavailable'; error.phase ||= 'credentials'; throw error; }
    if (credentials?.then) fail('target_credentials_invalid', 'prepareSubmission必须同步校验当前目标独立凭据');
    const requestDigest = digest({ target: ready.snapshot, qubo: ready.matrix.qubo, solver_options: ready.prepared.solver_options, file: ready.prepared.file.sha256 });
    const { run, replay } = reserveStart({
      store: this.store, lock: key => this.lock(key), key, problemSha, previous, inspect,
      project: publicTargetRun, toIssue: issue, timestamp: this.now,
      create: existing => {
        if (existing && existing.request_digest !== requestDigest) fail('target_retry_changed', '原失败记录的目标或请求依据已改变，不能按原键重试；先核查原记录与新的提交意图');
        const timestamp = this.now(), id = 'solve_' + crypto.randomUUID().replace(/-/g, '');
        const review = guidedReview ?? existing?.guided_review ?? null;
        return { schema: RECORD_SCHEMA, solve_id: id, status: 'submitting', stage: 'create', result_state: 'not_requested',
          target: ready.snapshot, view: viewSnapshot(ready.snapshot), execution_mode: evidence.execution_mode, billing: evidence.billing,
          model_summary: args.model_summary.trim(), qubo: ready.matrix.qubo,
          matrix: { num_bits: ready.matrix.qubo.num_bits, sha256: ready.matrix.sha256, size_bytes: ready.matrix.size_bytes,
            model_sha256: ready.matrix.summary.model_sha256, submitted_problem_sha256: problemSha },
          file: { format: ready.prepared.file.format, sha256: ready.prepared.file.sha256, size_bytes: ready.prepared.file.size_bytes },
          solver_options: ready.prepared.solver_options, encoding: ready.prepared.encoding || null,
          intent_digest: intent, request_digest: requestDigest, idempotency_digest: key,
          provider_task_name: existing?.provider_task_name || 'isingq-' + id, provider_task_id: null,
          guided_review: structuredClone(review),
          submission_outcome: 'unknown', result: null, error: null, created_at: timestamp, updated_at: timestamp, submitted_at: null, completed_at: null };
      },
    });
    if (replay) return replay;
    return submitReservedRun({ store: this.store, run, project: publicTargetRun, timestamp: this.now, submit: async () => {
      const submitted = await transport.submit({ ...ready.prepared.file, task_name: run.provider_task_name }, run.solver_options, credentials);
      if (typeof submitted?.task_id !== 'string' || !submitted.task_id.trim() || submitted.task_id.length > 200) {
        fail('target_receipt_invalid', '创建回执缺少提供方任务号；受理情况未知，请核查原服务', { phase: 'create_task' });
      }
      return submitted;
    }, onError: error => {
      const outcome = ['not_created', 'rejected'].includes(error?.submissionOutcome) ? error.submissionOutcome : 'unknown';
      const problem = issue(error instanceof Error ? error : new Error('求解提供方未返回可用的提交结果'));
      return {
        fields: { submission_outcome: outcome, status: outcome === 'unknown' ? 'submission_unknown' : 'failed', error: problem },
        error: failed => {
          const result = publicTargetRun(failed);
          return Object.assign(new Error(problem.message + '；' + result.recovery.instructions),
            { code: error?.code || 'target_start_failed', run: result });
        },
      };
    } });
  }
  async poll(run) {
    if (!run.provider_task_id || TERMINAL.has(run.status)) return publicTargetRun(run);
    let observed, queryError;
    try { observed = await this.transport(run.target, { restore: true }).poll(run.provider_task_id, run.matrix.num_bits); }
    catch (error) { queryError = error; }
    return updatePolledRun({ store: this.store, lock: key => this.lock(key), original: run, project: publicTargetRun,
      sameSource: latest => digest(latest.target) === digest(run.target), changedCode: 'target_record_changed',
      apply: latest => {
        if (queryError) {
          latest.error = issue(queryError);
          latest.updated_at = this.now();
          return { save: true, remote: Boolean(queryError.phase && queryError.phase !== 'unknown') };
        }
        const allowed = ['queued', 'running', 'succeeded', 'failed', 'result_pending', 'result_invalid'];
        if (!object(observed) || !allowed.includes(observed.status)) fail('target_observation_invalid', '提供方查询状态无法解释；保留原任务，不能重提');
        if (!canAdvancePoll(latest.status, observed.status)) return { remote: true };
        latest.status = observed.status; latest.provider_status = observed.provider_status ?? null; latest.error = null;
        latest.stage = observed.status.startsWith('result_') ? 'result' : observed.status === 'succeeded' ? 'complete' : 'poll';
        latest.result_state = observed.status === 'succeeded' ? 'valid' : observed.status.startsWith('result_') ? observed.status.slice(7) : 'not_available';
        if (observed.status === 'succeeded') {
          try {
            const limits = { maxBits: latest.matrix.num_bits }, bits = observed.bits;
            latest.result = { bits, variables: decodeBits(latest.qubo, bits, limits), provider_energy: observed.provider_energy ?? observed.energy ?? null,
              objective_value: objectiveEnergy(latest.qubo, bits, limits), offset: latest.qubo.offset,
              ...(observed.result_domain ? { result_domain: observed.result_domain } : {}),
              ...(observed.spin_config ? { provider_vector: observed.spin_config } : {}),
              ...(observed.spins ? { spin_config: observed.spins } : {}), ...(observed.device_compute_ms != null ? { device_compute_ms: observed.device_compute_ms } : {}),
              ...(observed.isingCalcMs != null ? { isingCalcMs: observed.isingCalcMs } : {}) };
            if (!Number.isFinite(latest.result.objective_value)) {
              fail('target_objective_nonfinite', '原QUBO目标值复算超出有限数值容量；保留原任务与提供方结果，不能据此宣称业务求解成功');
            }
            latest.completed_at = this.now();
          } catch (error) { latest.status = 'result_invalid'; latest.stage = 'result'; latest.result_state = 'invalid'; latest.result = null; latest.error = issue(error); }
        } else if (observed.status === 'failed') { latest.error = { code: 'provider_execution_failed', message: '原服务报告执行失败／取消，请查看本记录原任务' }; latest.completed_at = this.now(); }
        if (observed.result_reason || observed.reason) latest.error = { code: observed.status, message: observed.result_reason || observed.reason, provider_code: observed.provider_code ?? null };
        latest.updated_at = this.now();
        return { save: true, remote: true };
      } });
  }
  listRuns(args) {
    if (args !== undefined) fields(args, ['limit', 'offset'], '记录列表参数');
    const page = this.store.list(args);
    return { ...page, records: page.records.map(run => run.schema === RECORD_SCHEMA ? publicTargetRun(run) : {
      solve_id: run.solve_id, status: run.status, model_summary: run.model_summary, target: null, view: { kind: 'unconfigured', url: null,
        guidance: '旧记录没有可核实目标快照，保留本地结果；不能由当前连接或环境推算历史查看地址。' }, legacy: true }) };
  }
  validateTargetDelivery({ solve_id, document }) {
    const run = this.store.get(solve_id);
    if (run.schema !== RECORD_SCHEMA) fail('target_record_required', '目标交付检查需要本次v2记录；旧入口继续使用原交付校验');
    const limits = this.limits(), supplied = validateQubo(document?.qubo, limits);
    if (supplied.summary.model_sha256 !== run.matrix.model_sha256) fail('target_delivery_mismatch', '交付模型与该笔实际调用不一致，不能拼接其他模型或历史结果');
    return validateRecordedDelivery(document, { ...limits, maxBits: run.matrix.num_bits }, run);
  }
}

module.exports = { SOLVER_TARGET_CONTRACT_VERSION, RECORD_SCHEMA, TargetEngine, publicTargetRun, targetReference };
