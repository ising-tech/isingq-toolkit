'use strict';
const { runWithCleanupSync } = require('./run-with-cleanup');

const fs = require('node:fs');
const { unlinkOwnedFileSync } = require('./owned-file');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateQubo } = require('./qubo');
const { fileLimit, readFileBounded, FileLimitError } = require('./file-limits');
const { GuidedModelArtifacts } = require('./guided-model-artifacts');
const { reviewCandidate, reviewCandidateFile, renderReview } = require('./guided-result-review');
const { inspectReviewFile, reviewFileReference, isFileReviewActive } = require('./review-file');
const { MathModelError } = require('./math-model');
const { RECORD_SCHEMA } = require('./target-service');
const GUIDED_SOLVE_CONTRACT_VERSION = 'isingq-guided-solve-v1';
const REQUEST_ID = /^request_[a-f0-9]{32}$/;
const pending = new Map();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idempotencyDigest = plan => crypto.createHash('sha256').update(plan.idempotency_key).digest('hex');
const clone = value => structuredClone(value);
function fault(code, message) { throw Object.assign(new Error(message), { code, guided: true }); }
function safeIssue(error) {
  if (error.guided) return { code: error.code, message: error.message };
  const code = error.code || 'service_unavailable';
  const messages = {
    local_coefficient_invalid: '模型系数不符合目标已声明的限制；请核对模型或另选目标，不自动转换原模型。',
    local_device_dimension_exceeded: '模型规模超过目标当前能力；请核对变量规模或另选目标。',
    local_dimension_exceeded: '模型规模超过所选连接允许的范围；请核对模型或连接。',
    local_state_not_allowed: '所选设备当前不处于允许求解的状态；请核对原设备后刷新。',
    local_client_file_too_large: '模型文件超过当前客户端容量；请核对模型规模或运行环境容量。',
    local_file_too_large: '模型文件超过目标明确允许的容量；请核对模型或另选目标。',
    local_encoding_unsupported: '所选目标不支持当前模型输入方式；请核对目标部署，不自动转换原模型。',
    solve_record_not_found: '原求解记录未找到；请核对原任务与运行位置，不要因此重复提交。',
    target_unresolved_submission: '同一模型已有受理未知的调用；请核查原任务，不换目标或重新创建。',
    target_credentials_unavailable: '所选服务的安全凭据尚未就绪；请通过安全配置入口核对，不在对话中发送秘密。',
    local_credentials_invalid: '所选本地服务的独立认证未就绪；请核对该部署的安全配置，不使用云凭据代替。',
    result_invalid: '原任务结果未通过结构或向量校验；请核对原设备返回的结果，保留记录，不自动重算。',
    result_pending: '原服务尚未提供可读取的完整结果；请继续查看原任务，不重复创建。',
    provider_execution_failed: '原服务报告执行失败或取消；已停止本次等待，请核对原任务，不自动重提。',
  };
  if (error.phase === 'credentials') return { code: 'credentials_required', message: messages.target_credentials_unavailable };
  const phases = { local_config:'读取所选设备配置失败', local_runtime:'读取所选设备运行信息失败', local_status:'读取所选设备状态失败', local_create:'原设备未提供有效创建回执', create_task:'原云服务未提供有效创建回执', local_detail:'读取原设备任务状态失败', local_result:'读取原设备任务结果失败', catalogue:'读取公开目标目录失败' };
  return { code, message: messages[code] || (phases[error.phase] ? phases[error.phase] + '；请核对原设备或服务，保留当前记录，不自动重提。' : '当前步骤未完成；请保留本次请求，核对原设备或服务后刷新。详细诊断保留在技术记录中，不自动重提。') };
}
function validateInput(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fault('input_invalid', '请提供求解动作及对应的业务信息。');
  const fields = {
    model: ['qubo','qubo_file','problem_summary','model_markdown','review_file'], prepare: ['request_id','qubo','qubo_file','problem_summary','preferred_target','model_markdown','review_file'], choose: ['request_id','target_id'], funding: ['request_id','payment'],
    confirm: ['request_id','confirmation_ref'], status: ['request_id','solve_id'], review:['request_id','solve_id','review','review_file'], history: ['limit','offset'], manage: ['request_id'], refresh: ['request_id'], cancel: ['request_id'],
  };
  if (!fields[args.action]) fault('action_invalid', '请选择准备、选择目标、付款、确认、查询、历史、管理、刷新或暂不提交操作。');
  if (Object.keys(args).some(key => key !== 'action' && !fields[args.action].includes(key))) fault('input_invalid', '该业务动作不接受额外技术参数；请仅提供本动作需要的业务字段。');
  if (args.review !== undefined && args.review_file !== undefined) fault('input_invalid','业务核验只沿用一种原模型来源：review或review_file，不能混合替换。');
  if (!['model','prepare','history','manage','status','review'].includes(args.action) && !args.request_id) fault('request_required', '请沿用上一结果的请求标识，继续当前业务流程。');
  if (args.action === 'prepare' && args.request_id && Object.keys(args).some(key => !['action','request_id'].includes(key))) fault('input_invalid','继续已有模型时请直接使用现成准备操作，不混入新的模型或说明。');
  if (args.action === 'history' && ((args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) || (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)))) fault('page_invalid','历史每页数量须为1到1000，起始位置须为非负整数。');
  if (args.solve_id !== undefined && (typeof args.solve_id !== 'string' || !/^solve_[a-f0-9]{32}$/.test(args.solve_id))) fault('record_invalid','请提供原结果返回的完整求解记录标识。');
  if (['status','review'].includes(args.action) && Boolean(args.request_id) === Boolean(args.solve_id)) fault('request_required', '查询或复核时请只提供请求标识或原求解记录标识。');
}
function quboInput(args, environment) {
  if (Object.hasOwn(args, 'qubo') === Object.hasOwn(args, 'qubo_file')) fault('qubo_input_invalid', 'model／新prepare须且仅须提供qubo或qubo_file；大模型请由本地建模程序生成JSON文件与SHA256后传入文件描述。');
  if (Object.hasOwn(args, 'qubo')) return args.qubo;
  const file = args.qubo_file;
  if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['path','sha256'].includes(key))
    || typeof file.path !== 'string' || !file.path.trim() || /[\x00-\x1f\x7f]/.test(file.path)
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fault('qubo_file_invalid', 'qubo_file须只包含Toolkit运行主机上的普通文件path与该文件实际字节的完整小写SHA256（sha256）；请由本地建模程序生成，不传矩阵正文。');
  let bytes;
  try { bytes = readFileBounded(file.path, fileLimit('localFile', environment)); }
  catch (error) {
    if (error instanceof FileLimitError) fault(error.code, error.message);
    fault('qubo_file_unavailable', `无法读取QUBO文件（path=${file.path}, fs_code=${typeof error.code === 'string' ? error.code : 'unknown'}）；检查文件存在、权限与普通文件类型后，重新计算SHA256。`);
  }
  // Hash and parse this one bounded byte snapshot. Continuations use only the
  // validated QUBO saved in the original request, never reread the source path.
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) fault('qubo_file_digest_mismatch', `QUBO文件摘要不符（path=${file.path}, expected=${file.sha256}）；文件可能已变化，请核对原模型并重新计算SHA256后准备；未保存新请求或创建任务。`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (_) { fault('qubo_file_json_invalid', `QUBO文件不是有效UTF-8 JSON（path=${file.path}）；请从原业务模型重新导出并计算SHA256；不回显文件内容。`); }
}
function action(action, label, extra = {}) { return { action, label, ...extra }; }
function command(label, arguments_) { return { label, call: { tool: 'isingq_solve', arguments: arguments_ } }; }
function capacitySummary(target, count, device) {
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  let minimum = null, maximum = null, source = '未声明';
  if (target?.kind === 'local') {
    const actual = positive(target.device_capabilities?.maxScale) ?? positive(device?.config?.maxScale);
    const declared = positive(target.effective_contract?.max_dimension) ?? positive(target.contract?.max_dimension);
    maximum = actual && declared ? Math.min(actual,declared) : actual ?? declared;
    if (maximum !== null) source = actual ? '本次设备及已声明部署范围' : '已声明部署范围';
  } else if (target?.kind === 'cloud') {
    const capability = target.entry?.executionCapabilities || target.capabilities;
    minimum = positive(capability?.minDimension); maximum = positive(capability?.maxDimension);
    if (minimum !== null || maximum !== null) source = '本次云目录声明';
  }
  return { minimum, maximum, source, matches_known_limits: minimum === null && maximum === null ? null
    : (minimum === null || count >= minimum) && (maximum === null || count <= maximum) };
}
// Advice is a projection of existing catalogue/preparation facts. It is not
// part of the confirmation basis and never authorizes or changes a selection.
function targetGuidance(choice, count, advice = [], prepared = null) {
  const capacity = capacitySummary({...choice.target, entry:choice.entry, contract:choice.contract, ...prepared?.target}, count, prepared?.device);
  // Render business reasons from the DTO's typed facts; provider/internal
  // parameter wording is retained in the technical advice, not copied here.
  const reasons = advice.map(item => '实际矩阵' + item.dimension + '维，'
    + (item.format ? '当前' + item.format.toUpperCase() + '格式及' : '') + '已声明求解要求匹配');
  return { model_variables:count, capacity, recommended:reasons.length > 0, reasons,
    note:capacity.matches_known_limits === false ? '本次规模不符合已声明范围；仍可选择查看独立准备检查。'
      : choice.target.kind === 'cloud' && !choice.entry?.executionCapabilities ? '能力尚未声明，提交兼容性未核实。'
      : reasons.length ? '按当前模型与已声明约束提供建议；建议可忽略，提交仍须独立准备检查。'
      : '适配建议未核实；不影响选择，提交仍须独立准备检查。' };
}
function present(output, context = {}) {
  const requestId = output.request_id;
  const actions = [];
  for (const item of output.actions || []) {
    if (item.action === 'funding' && item.payments) {
      for (const payment of item.payments) actions.push(command(payment === 'credits' ? '使用算力券' : '使用账户余额', { action: 'funding', request_id: requestId, payment }));
      continue;
    }
    const args = { action: item.action };
    if (item.confirmation_ref) args.confirmation_ref = item.confirmation_ref;
    if (item.request_id) args.request_id = item.request_id;
    else if (item.solve_id) args.solve_id = item.solve_id;
    else if (requestId && item.action !== 'history') args.request_id = requestId;
    if (item.review_file) args.review_file = clone(item.review_file);
    actions.push(command(item.label, args));
  }
  const targets = output.targets?.map(item => ({ name: item.name, location: item.location, guidance:clone(item.guidance),
    ...command('选择' + item.name + '（' + item.location + '）', { action: 'choose', request_id: requestId, target_id: item.target_id }) }));
  if (targets) for (const target of targets) actions.push({ label: target.label, call: clone(target.call) });
  if (output.status === 'history' && output.next_offset !== null) actions.push(command('查看下一页历史', { action: 'history', limit: context.limit ?? 100, offset: output.next_offset }));
  const source = output.summary;
  const summary = source ? { model_variables: source.model_variables, capacity: source.capacity, target: source.target,
    data_destination: source.data_destination, resource_impact: source.resource_impact } : undefined;
  const stages = {
    modeled: '模型已导出；本步只处理本机QUBO校验与产物，未读取求解目标或创建任务。',
    ready: '已完成本次准备，尚未提交；请确认后再求解。', needs_target: '模型已保存，尚未提交；请选择求解目标。',
    needs_payment: '目标已选定，尚未提交；请明确选择本次付款来源。', blocked: '本步未继续，请按以下说明核对。',
    cancelled: '已停止本次准备；这不等于取消远程设备任务。', submitted: '本次调用已受理，请继续查看原任务。',
    queued: '原任务正在排队。', running: '原任务正在运行。', submitting: '原任务仍在提交处理中。',
    candidate_ready: '原任务已返回候选结果，仍须按原始业务约束解码与核验。', waiting_result: '原服务尚未提供完整结果，请继续查看原任务。',
    result_reviewed:'已完成本次候选的解码与所声明业务模型复核。', needs_review_model:'候选已解码，仍需沿用原业务模型复核目标和约束。', review_blocked:'本次业务复核未完成；原任务和候选结果保持不变。',
    reviewing:'已有模型结果正在复核，本次复核尚未开始；请稍后沿原操作继续。',
    result_unavailable: '原任务结果暂不可用，请核对原设备返回，保留记录，不自动重算。',
    failed: '本次调用未成功完成；已保留记录，请核对原服务，不自动重提。',
    submission_unknown: '本次受理情况尚未核实，请核查原任务；不会自动重新创建。',
    management: '连接管理页已打开；保存不提交，管理页不是设备任务页。',
    history: '本页共有' + (output.records?.length ?? 0) + '条调用记录。',
  };
  const lines = [stages[output.status] || '请按本步返回的操作继续。'];
  const target = summary?.target || output.task?.target;
  if (target) lines.push('所选目标：' + target.name + '（' + target.location + '）。');
  if (Number.isInteger(summary?.model_variables)) lines.push('模型规模：' + summary.model_variables + '个二进制变量。');
  if (summary?.capacity) {
    const capacity = summary.capacity;
    if (capacity.maximum !== null || capacity.minimum !== null) lines.push(capacity.source + '：' + (capacity.minimum !== null ? '规模下限' + capacity.minimum + '，' : '') + (capacity.maximum !== null ? '规模上限' + capacity.maximum : '规模上限未声明') + '；本次规模' + (capacity.matches_known_limits ? '符合' : '不符合') + '已核实的规模限制。');
    else if (target) lines.push('目标规模范围尚未核实。');
  }
  if (summary?.data_destination) lines.push('矩阵数据去向：' + (summary.data_destination.address || '尚未核实') + '。');
  const impact = summary?.resource_impact;
  if (impact?.description) lines.push(impact.description);
  if (impact?.quote) lines.push('本次计算次数：' + (impact.calculation_count ?? '待核实') + '；目录报价：账户余额' + (impact.quote.balance ?? '未知') + '，算力券' + (impact.quote.credits ?? '未知') + '。');
  if (impact?.payment) lines.push('本次付款来源：' + (impact.payment === 'credits' ? '算力券' : '账户余额') + '。');
  if (impact?.actual_charge) lines.push(impact.actual_charge);
  for (const item of output.suggestions || []) {
    const guidance = item.guidance, capacity = guidance.capacity;
    lines.push(item.name + '（' + item.location + '）：' + (guidance.recommended ? '建议适配；' : '')
      + (capacity.minimum !== null || capacity.maximum !== null ? '已声明规模范围' + (capacity.minimum ?? '未声明') + '–' + (capacity.maximum ?? '未声明') + '；' : '')
      + (guidance.reasons.length ? guidance.reasons.join('；') + '；' : '') + guidance.note);
  }
  for (const item of output.blockers || []) lines.push(item.message);
  if (output.notice) lines.push(output.notice);
  if (output.execution) lines.push(output.execution + '。');
  if (output.review && ['feasible','infeasible','needs_business_model'].includes(output.review.status)) lines.push(renderReview(output.review));
  if (output.management?.url) lines.push('[打开连接管理页](' + output.management.url + ')');
  if (actions.length) lines.push('可选操作：\n' + actions.map((item, index) => (index + 1) + '. ' + item.label).join('\n'));
  const modeling = output.modeling ? (['status','history'].includes(context.action)
    ? { status:output.modeling.status, integrity:output.modeling.integrity, math_format:output.modeling.math_format, ...(output.modeling.issue ? {issue:output.modeling.issue} : {}), display:'files_only', files:output.modeling.files, files_markdown:output.modeling.files_markdown, location:output.modeling.location, note:output.modeling.note }
    : { ...clone(output.modeling), display:'full' }) : null;
  return { ...(modeling ? {modeling} : {}), reply: lines.join('\n'), status: output.status,
    ...(output.ready !== undefined ? { ready: output.ready } : {}),
    actions, ...(targets ? { targets } : {}),
    ...(output.suggestions ? { suggestions:clone(output.suggestions) } : {}),
    ...(output.blockers ? { blockers: clone(output.blockers) } : {}), ...(output.notice ? { notice: output.notice } : {}),
    ...(output.result ? { result: clone(output.result) } : {}), ...(output.task ? { task: clone(output.task) } : {}),
    ...(output.review ? {review:clone(output.review)} : {}),
    ...(output.execution ? { execution: output.execution } : {}), ...(output.management ? { management: clone(output.management) } : {}),
    ...(output.records ? { records: output.records.map(record => present(record)), total: output.total, next_offset: output.next_offset } : {}),
  };
}
function runView(raw, { requestId, reviewFile } = {}) {
  const continuation=requestId && reviewFile ? {request_id:requestId} : {solve_id:raw.solve_id};
  const taskNumber = raw.view?.provider_task_id || raw.provenance?.provider_task_id || raw.provider_task_id || null;
  const state = raw.submission_outcome === 'unknown' && !taskNumber ? 'submission_unknown' : { succeeded: 'candidate_ready', result_pending: 'waiting_result', result_invalid: 'result_unavailable' }[raw.status] || raw.status;
  const task = { task_number: taskNumber,
    target: { name: raw.target?.name || '原目标名称未记录', location: raw.target?.kind === 'local' ? '本地' : raw.target?.kind === 'cloud' ? '云端' : '未记录' },
    status: state, view: raw.view?.url ? { url: raw.view.url, label: raw.view.label || '查看原任务', note: '按原任务号在该页面查找；页面是否可达与任务执行状态分别核对。' } : { url: null, note: '原任务网页入口尚未核实；仍可继续查询记录。' } };
  const result = raw.result ? { bits: clone(raw.result.bits), variables: clone(raw.result.variables || []), objective: raw.result.objective_value,
    note: '这是候选结果，仍须按原始业务约束核验；不据此推断设备内部处理、故障唯一原因或全局最优。' } : undefined;
  return { solve_id: raw.solve_id, status: state, task,
    ...(result ? { result } : {}),
    execution: raw.execution_mode === 'simulation' ? '模拟执行' : raw.execution_mode === 'live' ? '所选服务返回的执行记录' : '执行来源尚未核实',
    ...(raw.error ? { blockers: [safeIssue({ code: raw.error.code, phase:raw.error.phase })] } : {}),
    ...(raw.receipt_persistence?.instructions ? { notice: raw.receipt_persistence.instructions }
      : state === 'submission_unknown' ? { notice: '受理情况未知，请核查原任务；不会自动新建或重复提交。' } : {}),
    actions: [...(state==='candidate_ready' && result ? [action('review','核对并解读本次结果',{
      ...continuation,...(reviewFile ? {review_file:clone(reviewFile)} : {})})] : []),
      action('status','继续查看原任务',continuation),action('history','查看调用历史'),action('manage','添加／管理本地求解器')],
  };
}
function recordedView(raw) {
  // Older solver records have no authenticated target/view snapshot.
  return raw.schema === RECORD_SCHEMA ? raw : { ...raw, target:null, view:null };
}
function storedReviewFile(binding) {
  try {
    if (typeof binding?.request_id !== 'string' || !REQUEST_ID.test(binding.request_id)) throw Error('request id');
    return reviewFileReference(binding.file);
  } catch (_) {
    fault('review_source_unavailable','原求解的核验文件关联无法核对；请保留记录并由维护者恢复原请求的核验引用，不能改用其他模型复核。');
  }
}
function pendingReview(continuation, reference, notice, linked = {}) {
  return {...linked,status:'reviewing',review:{status:'pending',scope:'unverified'},notice,
    actions:[action('review','稍后继续本次复核',{...continuation,review_file:reference})]};
}

class GuidedSolve {
  constructor(service) {
    this.service = service; this.engine = service.targetEngine;
    if (!service.store.directory) fault('persistent_store_required', '业务求解需要可恢复的私有记录目录；请使用持久存储。');
    this.directory = path.join(service.store.directory, '.guided');
    if (fs.existsSync(this.directory) && (!fs.lstatSync(this.directory).isDirectory() || fs.lstatSync(this.directory).isSymbolicLink())) fault('private_store_unsafe', '业务请求目录异常；请核对私有存储，不要删除在途记录。');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(this.directory,0o700);
    this.maxBytes = service.store.maxRecordBytes || 128 * 1024 * 1024;
    this.modelArtifacts = new GuidedModelArtifacts({root:this.directory,environment:this.engine.environment,limits:()=>this.engine.limits()});
  }
  file(id) { if (typeof id !== 'string' || !REQUEST_ID.test(id)) fault('request_invalid','请求标识无效；请沿用上次返回的标识。'); return path.join(this.directory, id + '.json'); }
  save(plan) {
    const file = this.file(plan.request_id), data = JSON.stringify(plan);
    if (Buffer.byteLength(data) > this.maxBytes) fault('request_too_large','业务模型与请求记录超过当前容量；请缩小输入或核对运行容量。');
    const temp = file + '.tmp-' + crypto.randomUUID();
    let fd, created = false;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); created = true;
      fs.writeFileSync(fd, data);
      const ownedFd = fd; fd = undefined; fs.closeSync(ownedFd);
      fs.renameSync(temp, file); created = false;
    } finally {
      if (fd !== undefined) { const ownedFd = fd; fd = undefined; try { fs.closeSync(ownedFd); } catch (_) {} }
      if (created) { try { fs.unlinkSync(temp); } catch (_) {} }
    }
  }
  load(id) {
    const file = this.file(id); let fd;
    return runWithCleanupSync(() => {
      try {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fault('request_unsafe','请求记录异常；请保留原文件并由维护者核对。');
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const chunks = [], buffer = Buffer.alloc(65536); let bytes = 0;
        for (;;) { const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, this.maxBytes + 1 - bytes), null); if (!n) break; bytes += n; if (bytes > this.maxBytes) fault('request_too_large','请求记录超过当前读取容量；请保留原记录并核对容量。'); chunks.push(Buffer.from(buffer.subarray(0,n))); }
        const plan = JSON.parse(Buffer.concat(chunks).toString());
        if (plan.request_id !== id || plan.schema !== GUIDED_SOLVE_CONTRACT_VERSION || !plan.qubo
          || typeof plan.idempotency_key !== 'string' || !plan.idempotency_key) fault('request_invalid','请求记录不完整；请保留原记录核对，不自动重建。');
        return plan;
      } catch (error) { if (error.guided) throw error; fault('request_unavailable','本次请求记录无法读取；请核对原请求标识和私有记录，不要因此重复提交。'); }
    }, () => {
      if (fd !== undefined) fs.closeSync(fd);
    });
  }
  async serial(id, work) {
    const file = this.file(id), lock = file + '.lock';
    const previous = pending.get(file) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      let fd, identity, primaryError, cleanupError, result, primaryFailed = false, cleanupFailed = false;
      try {
        try { fd = fs.openSync(lock, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat = fs.lstatSync(lock);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200) fault('request_locked','本次请求正在处理或锁信息异常；请查询原请求，不新建。');
          const pid = Number(fs.readFileSync(lock, 'utf8'));
          let live = true;
          if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid,0); } catch (e) { if (e.code === 'ESRCH') live = false; } }
          if (live) fault('request_processing','本次请求正在处理，请稍后查询同一请求；不会重复创建任务。');
          if (fs.lstatSync(lock).ino !== stat.ino) fault('request_processing','本次请求正在恢复；请查询同一请求。');
          unlinkOwnedFileSync(lock, stat); fd = fs.openSync(lock,'wx',0o600);
        }
        identity = fs.fstatSync(fd);
        fs.writeFileSync(fd, String(process.pid));
        const ownedFd = fd; fd = undefined; fs.closeSync(ownedFd);
        result = await work();
      } catch (error) { primaryFailed = true; primaryError = error; }
      finally {
        if (fd !== undefined) {
          if (!identity) { try { identity = fs.fstatSync(fd); } catch (error) { cleanupFailed = true; cleanupError = error; } }
          const ownedFd = fd; fd = undefined; try { fs.closeSync(ownedFd); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
        }
        try { unlinkOwnedFileSync(lock, identity); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
      }
      if (primaryFailed) throw primaryError;
      if (cleanupFailed) throw cleanupError;
      return result;
    });
    pending.set(file,current);
    try { return await current; } finally { if (pending.get(file) === current) pending.delete(file); }
  }
  async choices(plan, initial = false, forceCloud = false) {
    const profiles = this.service.profileList();
    const preferred = plan.preferred_target?.trim().toLocaleLowerCase();
    const matches = preferred ? profiles.filter(p => p.name.toLocaleLowerCase() === preferred) : [];
    if (initial && (matches.length === 1 || (!preferred && profiles.length === 1))) plan.selected = { kind:'local', profile_id:(matches[0] || profiles[0]).id };
    const localSelected = plan.selected?.kind === 'local';
    const list = await this.service.listTargets({ include_cloud: forceCloud || !localSelected, environment:'prod', qubo:plan.qubo, solver_options:{calculate_count:1} });
    const choices = list.local.profiles.map(p => ({ target:{kind:'local',profile_id:p.id}, name:p.name, address:p.api_base_url, contract:p.contract }));
    for (const p of list.cloud.targets) choices.push({ target:{kind:'cloud',environment:'prod',computer_type_id:p.id}, name:p.name || String(p.id), entry:p });
    plan.choices = choices.map(c => ({...c,id:'target_' + hash(c.target).slice(0,32),
      guidance:targetGuidance(c,plan.qubo.num_bits,c.target.kind === 'cloud' ? (list.cloud.advice || []).filter(a => a.computer_type_id === c.target.computer_type_id) : [])}));
    if (initial && !plan.selected && preferred) {
      const named = plan.choices.filter(c => c.name.toLocaleLowerCase() === preferred);
      if (named.length === 1) plan.selected = named[0].target;
    }
    plan.catalog_unavailable = list.cloud.status === 'unavailable';
  }
  async refresh(plan, initial = false) {
    plan.notice = null; plan.issue = null;
    try { this.modelArtifacts.verify(plan); } catch(error) {plan.state='blocked';plan.confirmation=null;plan.issue=safeIssue(error);this.save(plan);return;}
    if (plan.intent === 'model_only' || (!plan.intent && plan.state === 'modeled')) {plan.intent='model_only';plan.state='modeled';plan.confirmation=null;this.save(plan);return;}
    await this.choices(plan,initial);
    const choice = plan.choices.find(c => hash(c.target) === hash(plan.selected));
    if (!choice) { plan.choice = null; plan.state = 'needs_target'; plan.preparation = null; plan.confirmation=null; if (plan.selected) plan.issue = {code:'target_unavailable',message:'原选择已不可用，请保留模型并选择当前目标。'}; this.save(plan); return; }
    plan.choice = choice;
    if (choice.target.kind === 'cloud') {
      const entry = choice.entry;
      const free = entry.price === 0;
      plan.options = {calculate_count:1,post_process:[0,1].includes(entry.executionCapabilities?.fixedPostProcess) ? entry.executionCapabilities.fixedPostProcess : 1,
        ...(free ? {use_credit:false} : plan.payment ? {use_credit:plan.payment === 'credits'} : {})};
      if (!free && !plan.payment) { plan.state = 'needs_payment'; plan.preparation = null; plan.confirmation=null; this.save(plan); return; }
    } else plan.options = {};
    const prepared = await this.service.prepareTarget({ target:plan.selected, qubo:plan.qubo, solver_options:plan.options });
    if (prepared.target?.name) choice.name = prepared.target.name;
    if (prepared.target?.api_base_url) choice.address = prepared.target.api_base_url;
    if (prepared.target?.entry) choice.entry = clone(prepared.target.entry);
    choice.guidance = targetGuidance(choice,plan.qubo.num_bits,prepared.advice || [],prepared);
    plan.preparation = prepared; plan.state = prepared.ready ? 'ready' : 'blocked';
    if (prepared.ready) plan.show_targets=false;
    if (!prepared.ready) plan.issue = safeIssue(prepared.issues?.[0] || {});
    this.bindConfirmation(plan);this.save(plan);
  }
  bindConfirmation(plan) {
    if (plan.state !== 'ready' || !plan.preparation?.ready || !plan.preparation.preparation_token) {
      if (plan.confirmation) { plan.confirmation = null; return true; }
      return false;
    }
    const basis = hash({ stage: 'ready', preparation: plan.preparation.preparation_token,
      problem_summary: plan.problem_summary, model_markdown:plan.model_markdown ?? null, artifacts:plan.artifacts?.files, summary: this.summary(plan) });
    if (plan.confirmation?.basis === basis) return false;
    plan.confirmation = { ref: 'confirm_' + crypto.randomUUID().replace(/-/g,''), basis };
    return true;
  }
  project(plan, {fullModeling = true} = {}) {
    const previousArtifactState = plan.artifacts?.status;
    const modeling = this.modelArtifacts.view(plan,{full:fullModeling});
    if (plan.solve_id) {
      if (previousArtifactState !== plan.artifacts?.status) this.save(plan);
      const raw=this.service.store.get(plan.solve_id);
      const record=recordedView(raw);
      const view=runView(record,{requestId:plan.request_id,reviewFile:this.reviewFile(raw,plan)});
      return { request_id:plan.request_id, ...view, summary:this.recordSummary(plan,record), modeling };
    }
    if (modeling.integrity === 'failed' && ['preparing','modeled','ready','needs_target','needs_payment','blocked'].includes(plan.state)) {
      if (plan.state === 'modeled') plan.intent='model_only';
      plan.state='blocked';plan.confirmation=null;
      plan.issue=modeling.issue || {code:'model_artifacts_changed',message:'当前建模产物无法核对；请恢复后刷新，并重新确认。'};
      this.save(plan);
    } else if (modeling.integrity === 'current_verified' && plan.state === 'blocked' && ['model_artifacts_changed','model_artifacts_export_failed'].includes(plan.issue?.code)) {
      plan.issue=null;plan.notice='文件一致性已恢复；请刷新当前准备，再按新摘要明确确认。';this.save(plan);
    }
    // Persist the issued content revision, including when an older private plan
    // is first viewed after this protocol upgrade. This is not human consent.
    if (this.bindConfirmation(plan)) this.save(plan);
    const choosing = plan.state === 'needs_target' || (plan.state === 'ready' && plan.show_targets);
    const ready = plan.state === 'ready' && !choosing;
    const guidanceChoices = choosing ? plan.choices : ['ready','needs_payment','blocked'].includes(plan.state) && plan.choice ? [plan.choice] : [];
    const suggestions = guidanceChoices.filter(c => c.guidance).map(c => ({ name:c.name,location:c.target.kind === 'local' ? '本地':'云端',guidance:clone(c.guidance) }));
    return { request_id:plan.request_id, status:choosing ? 'needs_target' : plan.state, ready, summary:this.summary(plan), modeling,
      ...(plan.issue ? {blockers:[plan.issue]} : {}), ...(plan.notice ? {notice:plan.notice} : {}),
      ...(suggestions.length ? {suggestions} : {}),
      ...(choosing ? {targets:plan.choices.map(c => ({target_id:c.id,name:c.name,location:c.target.kind === 'local' ? '本地':'云端',guidance:c.guidance})),
        ...(plan.catalog_unavailable ? {notice:'云目标目录暂不可用，已有本地连接仍可选择；可以稍后刷新。'} : {})} : {}),
      actions: plan.intent === 'model_only' && plan.state === 'blocked' ? [action('refresh','重新核对模型文件'),action('prepare','准备求解'),action('cancel','暂不求解')] : plan.state === 'modeled' ? [action('prepare','准备求解'),action('cancel','暂不求解')] : plan.state === 'cancelled' ? [action('history','查看历史'),action('manage','添加／管理本地求解器')] : [
        ...(ready ? [action('confirm','确认按当前摘要求解',{confirmation_ref:plan.confirmation?.ref})] : []),
        ...(['needs_target','ready','needs_payment','blocked'].includes(plan.state) && !choosing ? [action('choose','查看／更换目标')] : []),
        ...(plan.state === 'needs_payment' ? [action('funding','选择付款来源',{payments:['credits','balance']})] : []),
        action('manage','先添加／管理本地求解器'),...(!ready && (!choosing || plan.catalog_unavailable || !plan.choices.length) ? [action('refresh','重新检查当前准备')] : []),action('cancel','暂不提交')],
    };
  }
  summary(plan) {
    const c = plan.choice, local = c?.target.kind === 'local';
    return { problem:plan.problem_summary, model_variables:plan.qubo.num_bits,
      capacity:capacitySummary(plan.preparation?.target || (c ? {...c.target,entry:c.entry} : null),plan.qubo.num_bits,plan.preparation?.device),
      target:c ? {name:c.name,location:local?'本地':'云端'} : null,
      data_destination:c ? {name:c.name,address:local ? c.address : this.engine.cloudEnvironment('prod').api_base_url,preparation_uploads_matrix:false,confirmation_sends_matrix:true} : null,
      resource_impact:!c ? null : local ? {description:'提交后占用所选设备资源；当前准备未创建任务。'} : {calculation_count:1,
        quote:{balance:c.entry.price,credits:c.entry.computeCreditCost},payment:c.entry.price === 0 ? null : plan.payment || null,
        actual_charge:'实际扣费尚未核实，公开报价不是账单证据。'},
    };
  }
  recordSummary(plan, raw) {
    const target=raw.target, local=target?.kind==='local';
    return {problem:raw.model_summary || plan.problem_summary, model_variables:raw.matrix?.num_bits,
      capacity:capacitySummary(target,raw.matrix?.num_bits),
      target:target ? {name:target.name,location:local?'本地':'云端'} : null,
      data_destination:target ? {name:target.name,address:target.api_base_url || null} : null,
      resource_impact:local ? {description:'本次调用绑定原本地设备；执行及资源占用请按原任务记录核对。'} : {
        calculation_count:raw.solver_options?.calculate_count ?? null,
        quote:target?.entry ? {balance:target.entry.price,credits:target.entry.computeCreditCost} : null,
        payment:target?.entry?.price===0 ? null : typeof raw.solver_options?.use_credit==='boolean' ? raw.solver_options.use_credit?'credits':'balance' : null,
        actual_charge:raw.execution_mode==='simulation'?'本次是模拟执行，不涉及真实计费。':'实际扣费尚未核实，公开报价不是账单证据。'},
    };
  }
  existing(plan) { return this.service.store.findByIdempotency(idempotencyDigest(plan),{includeArchived:true}); }
  attach(plan,run, viewOptions) {
    plan.solve_id=run.solve_id; plan.state=run.status;
    if (run.receipt_persistence) {
      // A valid provider receipt survives additional local read/write errors.
      // The original idempotency key still locates the conservative reservation.
      try { this.save(plan); } catch (_) {}
      return {request_id:plan.request_id,...runView(run),summary:this.recordSummary(plan,run)};
    }
    this.save(plan);
    return this.project(plan,viewOptions);
  }
  async confirm(plan, confirmationRef) {
    if (plan.state === 'cancelled') return this.project(plan);
    if (plan.solve_id) return this.project(plan);
    // The plan is saved as submitting before startTarget can reserve or send
    // the task. Fresh confirmations use startTarget's single history scan.
    if (plan.state === 'submitting' || plan.state === 'submission_unknown') {
      const existing = this.existing(plan);
      if (existing) return this.attach(plan,existing);
      plan.state='submission_unknown';
      plan.issue={code:'acceptance_unknown',message:'上次提交的完整记录尚未核实；请核查原服务，不会自动重新创建。'};
      this.save(plan);
      return this.project(plan);
    }
    if (plan.state !== 'ready' || !plan.confirmation || confirmationRef !== plan.confirmation.ref) {
      plan.notice='本次准备内容或阶段已更新，未提交；请查看本步摘要，并在明确确认后使用对应的新操作。';
      this.save(plan); return this.project(plan);
    }
    await this.refresh(plan);
    // Re-check the caller's issued revision after fresh provider checks. An old
    // callback cannot be upgraded to the latest preparation token on replay.
    if (plan.state !== 'ready' || confirmationRef !== plan.confirmation?.ref) {
      plan.notice='目标、能力或本次资源摘要已变化，未提交；请按更新后的摘要作新的明确确认。';
      this.save(plan); return this.project(plan);
    }
    plan.state='submitting'; this.save(plan);
    try {
      const run=await this.service.startTarget({target:plan.selected,qubo:plan.qubo,solver_options:plan.options,
        preparation_token:plan.preparation.preparation_token,model_summary:plan.problem_summary,idempotency_key:plan.idempotency_key},
      {beforeCreate:()=>this.modelArtifacts.verify(plan),
        ...(plan.review_file ? {guidedReview:{request_id:plan.request_id,file:plan.review_file}} : {})});
      return this.attach(plan,run);
    } catch (error) {
      const run=error.run || this.existing(plan);
      if (run) return this.attach(plan,run);
      if (error.code==='target_preparation_changed') {
        plan.state='blocked';plan.confirmation=null;this.save(plan);
        await this.refresh(plan);plan.notice='检查期间目标或资源依据发生变化，已更新摘要；请重新确认当前内容。';this.save(plan);return this.project(plan);
      }
      plan.state='blocked'; plan.confirmation=null; plan.issue=safeIssue(error); plan.diagnostic={code:error.code || null,phase:error.phase || null,http_status:error.status || null}; this.save(plan); return this.project(plan);
    }
  }
  async call(args) { return present(await this.dispatch(args), args); }
  legacyReviewBindings() {
    // Old runs contain the digest of a random plan key. Only that key proves
    // ownership: another plan may attach the same run after a duplicate guard.
    // Supported writers replace plans atomically via save(), which updates
    // the directory revision. Manual repairs should reopen the session.
    const directory = fs.lstatSync(this.directory,{bigint:true});
    if (!directory.isDirectory()) fault('review_source_unavailable','原核验请求目录异常；请保留并恢复原私有请求目录。');
    const stamp = [directory.dev,directory.ino,directory.mtimeNs,directory.ctimeNs].join(':');
    const previous = this.legacyReviewIndex;
    if (previous?.stamp === stamp) return previous.bindings;
    const plans = new Map(), bindings = new Map();
    for (const name of fs.readdirSync(this.directory)) {
      const requestId = name.slice(0,-5);
      if (!name.endsWith('.json') || !REQUEST_ID.test(requestId)) continue;
      const stat = fs.lstatSync(this.file(requestId),{bigint:true});
      const revision = [stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
      let entry = previous?.plans.get(requestId);
      if (entry?.revision !== revision) {
        let plan;
        try { plan = this.load(requestId); }
        catch (_) { fault('review_source_unavailable','无法核对历史请求（request_id=' + requestId + '）的原核验来源；请保留并恢复原请求记录。'); }
        entry = {revision,key:idempotencyDigest(plan),file:plan.review_file};
      }
      plans.set(requestId,entry);
      if (entry.file !== undefined) bindings.set(entry.key,{request_id:requestId,file:entry.file});
    }
    this.legacyReviewIndex = {stamp,plans,bindings};
    return bindings;
  }
  reviewFile(raw,plan,legacy = () => this.legacyReviewBindings()) {
    if (raw.guided_review !== undefined) return raw.guided_review === null ? undefined : storedReviewFile(raw.guided_review);
    if (plan && raw.idempotency_digest === idempotencyDigest(plan)) {
      return plan.review_file === undefined ? undefined : storedReviewFile({request_id:plan.request_id,file:plan.review_file});
    }
    const binding = raw.idempotency_digest && legacy().get(raw.idempotency_digest);
    return binding ? storedReviewFile(binding) : undefined;
  }
  async status(solveId) {
    const raw=this.service.store.get(solveId);
    const current=raw.schema===RECORD_SCHEMA ? await this.engine.poll(raw) : await this.service.poll(solveId);
    return runView(current,{reviewFile:this.reviewFile(raw)});
  }
  history(args) {
    const page=this.service.store.list({limit:args.limit ?? 100,offset:args.offset ?? 0});
    let legacy;
    const records=page.records.map(raw=>runView(recordedView(raw),{reviewFile:this.reviewFile(raw,null,()=>legacy ??= this.legacyReviewBindings())}));
    return {status:'history',records,total:page.total,next_offset:page.next_offset,actions:[action('manage','添加／管理本地求解器')]};
  }
  async review(args) {
    const plan=args.request_id ? this.load(args.request_id) : null;
    const solveId=args.solve_id || plan.solve_id;
    const continuation=plan ? {request_id:plan.request_id} : {solve_id:solveId};
    const busyNotice='当前已有文件核验在进行；稍后沿原记录继续复核，仍会检查原核验文件的摘要。';
    if (!plan && args.review_file!==undefined && isFileReviewActive()) {
      return pendingReview(continuation,reviewFileReference(args.review_file),busyNotice);
    }
    const raw=solveId ? this.service.store.get(solveId) : this.existing(plan);
    if (!raw) fault('review_not_ready','本次请求尚无已受理的求解记录；复核不会创建任务，请先完成原求解。');
    const bound=this.reviewFile(raw,plan), requestId=plan?.request_id;
    let reference,linked;
    try {
      reference=args.review_file===undefined ? bound : reviewFileReference(args.review_file);
      if(bound && (args.review!==undefined || reference.content_digest!==bound.content_digest)) {
        return {...runView(raw,{requestId,reviewFile:bound}),status:'blocked',ready:false,blockers:[{code:'review_source_changed',message:'本次原请求已绑定核验文件；请沿现成调用复核，不替换原模型来源。'}]};
      }
      if(reference && isFileReviewActive()) return pendingReview(continuation,reference,busyNotice);
      linked=runView(raw,{requestId,reviewFile:reference});
      if(linked.status!=='candidate_ready' || !linked.result) return {...linked,notice:'原任务尚未提供完整候选；请继续查看原任务，不提交新任务。'};
      const review=reference!==undefined ? await reviewCandidateFile(raw,reference,this.directory) : reviewCandidate(raw,args.review);
      return {...linked,status:review.status==='needs_business_model'?'needs_review_model':'result_reviewed',review,
        actions:review.status==='needs_business_model'?linked.actions:linked.actions.filter(a=>a.action!=='review')};
    } catch(error) {
      if(!(error instanceof MathModelError)) throw error;
      if(error.code==='review_file_busy' && reference!==undefined) return pendingReview(continuation,reference,error.message,linked);
      const recovery=linked || runView(raw,{requestId,reviewFile:bound});
      if (!bound && args.review_file!==undefined && reference===undefined) recovery.actions=recovery.actions.filter(item=>item.action!=='review');
      return {...recovery,status:'review_blocked',review:{status:'blocked',scope:'unverified',issue:{code:error.code,field:error.path,detail:error.message}},
        blockers:[{code:error.code,message:error.path==='verification.input_bytes' || error.code==='verification_capacity_invalid'
          ? '本次业务复核超出本地核验容量或容量配置无效；原模型和候选已保留。请由维护者检查核验进程容量后重试，不删减业务条件、不重新求解。'
          : error.code.startsWith('review_file') ? '原业务核验文件无法读取、已变化或格式不兼容；请从原模型重新导出，再复核本次候选。原任务已保留，不重新求解。'
          : '业务复核输入未通过检查；请沿用原模型核对变量映射、数值与约束说明。原任务和候选已保留，不自动改模或重算。'}]};
    }
  }
  async dispatch(args) {
    try {
      validateInput(args);
      if (args.action === 'history') return this.history(args);
      if (args.action === 'status' && args.solve_id) return await this.status(args.solve_id);
      if (args.action === 'review') return await this.review(args);
      if (args.action === 'manage' && !args.request_id) { const page=await this.service.openTargetConfig(); return {status:'management',management:{url:page.url,label:'添加／管理本地求解器',note:'这是连接管理页，不是设备任务页；保存不提交。'},actions:[]}; }
      if (args.action === 'model' || (args.action === 'prepare' && !args.request_id)) {
        if (typeof args.problem_summary !== 'string' || !args.problem_summary.trim() || args.problem_summary.length>8000) fault('problem_required','请提供1到8000字符的本次业务问题摘要。');
        if (args.preferred_target !== undefined && (typeof args.preferred_target !== 'string' || !args.preferred_target.trim() || args.preferred_target.length>120)) fault('target_invalid','请提供要使用的设备名称；不确定时可省略并从列表选择。');
        const input = quboInput(args, this.engine.environment);
        let qubo, modelDigest;
        try { const validated=validateQubo(input,this.engine.limits());qubo=validated.qubo;modelDigest=validated.summary.model_sha256; } catch(error) { fault('model_invalid',error.message); }
        let reviewFile;
        if(args.review_file!==undefined) { const inspected=await inspectReviewFile(args.review_file,modelDigest);reviewFile={manifest_path:inspected.manifest_path,content_digest:inspected.content_digest}; }
        if (args.model_markdown !== undefined && (typeof args.model_markdown !== 'string' || args.model_markdown.length > 200000)) fault('model_document_invalid','建模说明须为不超过200000字符的文本；只提供业务变量、目标、约束和公式。');
        const plan={schema:GUIDED_SOLVE_CONTRACT_VERSION,request_id:'request_'+crypto.randomUUID().replace(/-/g,''),qubo,problem_summary:args.problem_summary.trim(),preferred_target:args.preferred_target,model_markdown:args.model_markdown,
          ...(reviewFile ? {review_file:reviewFile} : {}),selected:null,payment:null,choices:[],state:'preparing',intent:args.action==='model'?'model_only':'solve_prepare',idempotency_key:'guided-'+crypto.randomUUID()};
        this.save(plan);
        try {
          this.modelArtifacts.export(plan);
          if(args.action === 'model') {plan.state='modeled';this.save(plan);} else await this.refresh(plan,true);
        } catch(error) { plan.state='blocked';plan.issue=safeIssue(error);this.save(plan); }
        return this.project(plan);
      }
      return await this.serial(args.request_id,async()=>{
        const plan=this.load(args.request_id);
        if (args.action === 'status') {
          const existing=plan.solve_id ? null:this.existing(plan);
          if (existing) this.attach(plan,existing,{fullModeling:false});
          if (plan.solve_id) { await this.service.poll(plan.solve_id); return this.project(plan,{fullModeling:false}); }
          if (plan.state==='submitting') {plan.state='submission_unknown';plan.issue={code:'acceptance_unknown',message:'上次提交尚未核实，请核查原服务，不会重复创建。'};this.save(plan);}
          return this.project(plan,{fullModeling:false});
        }
        if (args.action === 'prepare') {
          if (plan.solve_id || ['submitting','submission_unknown'].includes(plan.state)) return this.project(plan);
          if (plan.state==='cancelled') return this.project(plan);
          plan.intent='solve_prepare';this.save(plan);await this.refresh(plan,true);return this.project(plan);
        }
        if (args.action === 'confirm') return this.confirm(plan,args.confirmation_ref);
        if (args.action === 'manage') {
          const page=await this.service.openTargetConfig(), current=this.project(plan);
          return {...current,status:'management',ready:false,management:{url:page.url,label:'添加／管理本地求解器',note:'连接管理页保存不提交；配置完成后沿现成操作继续检查。'},
            actions:plan.solve_id || plan.state==='cancelled' ? current.actions : [action('refresh','配置完成，继续检查'),action('cancel','暂不提交')]};
        }
        if (plan.solve_id || ['submitting','submission_unknown'].includes(plan.state)) fault('already_submitted','本次请求已进入提交或受理核查；只能查看原任务，不能修改或取消远程任务。');
        if (plan.state==='cancelled') return this.project(plan);
        if (args.action === 'cancel') {plan.state='cancelled';plan.confirmation=null;this.save(plan);return {...this.project(plan),notice:'已停止本次准备；这不是取消远程设备任务。'};}
        if (plan.intent === 'model_only' && ['choose','funding'].includes(args.action)) fault('prepare_required','本请求只做建模；需要求解时请先选择现成的准备求解操作。');
        if (args.action === 'choose') {
          if (args.target_id === undefined) { await this.choices(plan,false,true);plan.show_targets=true;this.save(plan);return this.project(plan); }
          plan.show_targets=false;
          const choice=plan.choices.find(c=>c.id===args.target_id);
          if (!choice) fault('target_invalid','目标选项已失效；请刷新当前列表后重新选择。');
          plan.selected=choice.target;plan.payment=null;plan.preparation=null;
          plan.confirmation=null;plan.state='preparing';this.save(plan);
        }
        if (args.action === 'funding') {
          if (plan.selected?.kind!=='cloud' || !plan.choice?.entry || plan.choice.entry.price===0) fault('payment_not_applicable','当前目标不需要选择云付款来源；请继续当前业务流程。');
          if (!['credits','balance'].includes(args.payment)) fault('payment_required','请明确选择算力券或账户余额。');
          plan.payment=args.payment;plan.confirmation=null;plan.state='preparing';this.save(plan);
        }
        await this.refresh(plan);return this.project(plan);
      });
    } catch (error) {
      const requestId = typeof args?.request_id === 'string' && REQUEST_ID.test(args.request_id) ? args.request_id : null;
      const continuation = requestId && ['request_processing','request_locked'].includes(error.code)
        ? [action('status','稍后查看本次请求')] : [];
      return {status:'blocked',ready:false,...(requestId?{request_id:requestId}:{}),blockers:[safeIssue(error)],
        actions:[...continuation,action('history','查看调用历史'),action('manage','添加／管理本地求解器')]};
    }
  }
}
function guidedFailure(error) { return present({status:'blocked',ready:false,blockers:[safeIssue(error)],actions:[action('history','查看调用历史'),action('manage','添加／管理本地求解器')]}); }
module.exports={GUIDED_SOLVE_CONTRACT_VERSION,GuidedSolve,guidedFailure};
