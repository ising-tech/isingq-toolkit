'use strict';

const crypto = require('node:crypto');
const http = require('undici');
const { matrixNpz } = require('./npz');
const { IsingQError, boundedJson, safeProviderMessage, normalizeCloudPoll } = require('./isingq');

const CLOUD_ENVIRONMENTS = Object.freeze({
  sit: Object.freeze({ api_base_url: 'https://api-sit.isingq.com' }),
  prod: Object.freeze({ api_base_url: 'https://api.isingq.com' }),
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
function invalid(field) {
  const error = new IsingQError(`云机型目录不兼容（field=${field}）；请核对 schemaVersion=1 接口`, { phase: 'catalogue' });
  error.code = 'CATALOGUE_SCHEMA_INVALID';
  return error;
}
function validateCatalog(catalog) {
  if (!object(catalog) || catalog.schemaVersion !== 1) throw invalid('schemaVersion');
  if (!object(catalog.uploadLimits) || !positive(catalog.uploadLimits.maxCsvBytes)) throw invalid('uploadLimits.maxCsvBytes');
  if (!Array.isArray(catalog.computerTypes)) throw invalid('computerTypes');
  const ids = new Set();
  for (const entry of catalog.computerTypes) {
    if (!object(entry) || !positive(entry.id) || ids.has(entry.id)) throw invalid('computerTypes.id');
    ids.add(entry.id);
    if (!(entry.name === null || typeof entry.name === 'string') || typeof entry.spinNumber !== 'string') throw invalid(`computerTypes[${entry.id}].name/spinNumber`);
    if (typeof entry.price !== 'number' || !Number.isFinite(entry.price) || entry.price < 0 || typeof entry.computeCreditCost !== 'number' || !Number.isFinite(entry.computeCreditCost) || entry.computeCreditCost < 0 || (entry.price === 0 && entry.computeCreditCost !== 0)) throw invalid(`computerTypes[${entry.id}].price/computeCreditCost`);
    const cap = entry.executionCapabilities;
    if (cap === null) continue;
    if (!object(cap) || !Array.isArray(cap.problemTypes) || cap.problemTypes.length === 0 || cap.problemTypes.some(value => !['qubo', 'ising'].includes(value)) || !Array.isArray(cap.inputFormats) || cap.inputFormats.length === 0 || cap.inputFormats.some(value => !['csv', 'npz'].includes(value)) || !positive(cap.minDimension) || !positive(cap.maxDimension) || cap.minDimension > cap.maxDimension || !positive(cap.maxCalculateCount) || typeof cap.supportsH !== 'boolean' || ![0, 1, null].includes(cap.fixedPostProcess)) throw invalid(`computerTypes[${entry.id}].executionCapabilities`);
  }
  return catalog;
}
function baseUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('云 API 地址必须是不含凭据、查询或片段的 HTTPS URL');
  return url.toString().replace(/\/$/, '');
}
function retryAfter(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  if (/^\d+$/.test(header.trim())) {
    const seconds = Number(header.trim());
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds : null;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : null;
}
function classify(error, phase) {
  if (!(error instanceof IsingQError)) error = new IsingQError(`IsingQ 请求或响应读取失败（phase=${phase}）；请核查原任务，勿盲目重提`, { phase });
  error.submissionOutcome ||= phase === 'create_task' ? 'unknown' : 'not_created';
  error.submissionUnknown = error.submissionOutcome === 'unknown';
  return error;
}
async function request(client, path, options, phase, credentials = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), client.timeoutSeconds * 1000);
  try {
    const response = await client.fetch(`${client.baseUrl}${path}`, { ...options, redirect: 'error', credentials: 'omit', signal: controller.signal });
    if (!response.ok) {
      const ambiguous = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
      const error = new IsingQError(`IsingQ 请求失败（phase=${phase}, status=${response.status}）`, {
        phase, status: response.status, retryable: ambiguous,
        submissionOutcome: phase === 'create_task' ? (ambiguous ? 'unknown' : 'rejected') : 'not_created',
      });
      error.retryAfterSeconds = retryAfter(response.headers.get('retry-after'));
      // A gateway can return HTML. Only the documented JSON message and size
      // fields leave this boundary; never attach the raw body to errors.
      try {
        const body = await boundedJson(response, phase);
        error.providerMessage = safeProviderMessage(body.message, [credentials.Authorization]);
        if (body.code === 'CSV_SIZE_LIMIT_EXCEEDED') {
          error.code = body.code;
          if (positive(body.maxCsvBytes)) error.maxCsvBytes = body.maxCsvBytes;
          if (body.requiredFormat === 'npz') error.requiredFormat = 'npz';
          error.message += `；CSV_SIZE_LIMIT_EXCEEDED（maxCsvBytes=${error.maxCsvBytes ?? '未返回'}, requiredFormat=${error.requiredFormat ?? '未返回'}），请重新读取目录并确认 NPZ 文件`;
        }
      } catch (_) { /* Preserve the HTTP classification. */ }
      throw error;
    }
    const body = await boundedJson(response, phase);
    if (body.success === false) {
      const error = new IsingQError(`IsingQ 业务拒绝（phase=${phase}）`, { phase, status: response.status, submissionOutcome: phase === 'create_task' ? 'rejected' : 'not_created', providerMessage: safeProviderMessage(body.message, [credentials.Authorization]) });
      throw error;
    }
    return body;
  } catch (error) {
    throw classify(error, phase);
  } finally { clearTimeout(timer); }
}
class CloudCatalogClient {
  constructor({ baseUrl: address, timeoutSeconds = 30, fetch = http.fetch }) {
    this.baseUrl = baseUrl(address); this.timeoutSeconds = timeoutSeconds; this.fetch = fetch;
    if (!(timeoutSeconds > 0) || !Number.isFinite(timeoutSeconds)) throw new Error('timeoutSeconds 必须为正数');
    this.retryNotBefore = 0;
  }
  async get() {
    if (Date.now() < this.retryNotBefore) {
      const error = new IsingQError('云目录仍在 Retry-After 退避期；稍后重试', { phase: 'catalogue', status: 429, retryable: true });
      error.retryAfterSeconds = Math.ceil((this.retryNotBefore - Date.now()) / 1000); error.code = 'CATALOGUE_RATE_LIMITED'; throw error;
    }
    try {
      return validateCatalog(await request(this, '/public/computer-types', { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-store' }, cache: 'no-store' }, 'catalogue'));
    } catch (error) {
      if (error.status === 429) {
        error.code = 'CATALOGUE_RATE_LIMITED';
        if (error.retryAfterSeconds !== null) this.retryNotBefore = Date.now() + error.retryAfterSeconds * 1000;
      }
      throw error;
    }
  }
}
function normalizeOptions(input, entry, submission = true) {
  const value = input ?? {};
  if (!object(value)) throw new Error('solver_options 必须是 object');
  const allowed = ['computer_type_id', 'question_type', 'calculate_count', 'post_process', 'use_credit'];
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`solver_options 未知字段（fields=${unknown.join(',')}）；新云接口不支持 gear`);
  if (value.computer_type_id !== undefined && value.computer_type_id !== entry.id) throw new Error(`computer_type_id 与所选目录条目不一致（selected=${entry.id}）`);
  if (value.question_type !== undefined && value.question_type !== 1) throw new Error('当前目标入口只接收 QUBO（question_type=1）');
  for (const key of Object.keys(value)) if (value[key] === null) throw new Error(`solver_options 字段不能为 null（field=${key}）`);
  const count = value.calculate_count ?? 1;
  if (!positive(count)) throw new Error('calculate_count 必须为正整数');
  if ((submission || value.post_process !== undefined) && ![0, 1].includes(value.post_process)) throw new Error('post_process 必须显式选择整数 0 或 1');
  if ((submission || value.use_credit !== undefined) && typeof value.use_credit !== 'boolean') throw new Error('use_credit 必须显式选择 boolean；请确认账户余额或算力券，不会自动选择');
  if (entry.price === 0 && value.use_credit === true) throw new Error('免费机型必须使用 use_credit=false');
  return { computer_type_id: entry.id, question_type: 1, calculate_count: count, ...(value.post_process === undefined ? {} : { post_process: value.post_process }), ...(value.use_credit === undefined ? {} : { use_credit: value.use_credit }) };
}
function compatibilityIssues(matrix, entry, catalog, { problem_type = 'qubo', has_h = false, calculate_count = 1, post_process } = {}) {
  const cap = entry.executionCapabilities;
  if (!cap) return ['executionCapabilities 尚未声明，不能核实提交兼容性'];
  const dimension = matrix.qubo.num_bits;
  const format = matrix.content.length > catalog.uploadLimits.maxCsvBytes ? 'npz' : 'csv';
  const issues = [];
  if (!cap.problemTypes.includes(problem_type)) issues.push(`问题类型不支持（problem_type=${problem_type}）`);
  if (dimension < cap.minDimension || dimension > cap.maxDimension) issues.push(`矩阵维度超出范围（dimension=${dimension}, min=${cap.minDimension}, max=${cap.maxDimension}）`);
  if (!cap.inputFormats.includes(format)) issues.push(`实际上传格式不支持（format=${format}）`);
  if (calculate_count > cap.maxCalculateCount) issues.push(`计算次数超出范围（count=${calculate_count}, max=${cap.maxCalculateCount}）`);
  if (has_h && !cap.supportsH) issues.push('当前机型不支持独立 H 文件');
  if (post_process !== undefined && cap.fixedPostProcess !== null && post_process !== cap.fixedPostProcess) issues.push(`post_process 与固定值冲突（selected=${post_process}, required=${cap.fixedPostProcess}）`);
  return issues;
}
function prepareCloudTarget(matrix, entry, catalog, solverOptions) {
  validateCatalog(catalog);
  if (!entry || !catalog.computerTypes.some(item => item.id === entry.id && JSON.stringify(item) === JSON.stringify(entry))) throw new Error('所选机型不在当前环境目录中；请重新读取并选择');
  const normalized = normalizeOptions(solverOptions, entry);
  const issues = compatibilityIssues(matrix, entry, catalog, normalized);
  if (issues.length) throw new Error(`云目标不兼容（computer_type_id=${entry.id}）：${issues.join('；')}`);
  const format = matrix.content.length > catalog.uploadLimits.maxCsvBytes ? 'npz' : 'csv';
  const content = format === 'npz' ? matrixNpz(matrix) : matrix.content;
  const file = { content, format, filename: `matrix.${format}`, sha256: crypto.createHash('sha256').update(content).digest('hex'), size_bytes: content.length };
  return { file, solver_options: normalized, entry, capabilities: entry.executionCapabilities, advice: [{ dimension: matrix.qubo.num_bits, format, reasons: [`实际矩阵 ${matrix.qubo.num_bits} 维，能力范围 ${entry.executionCapabilities.minDimension}–${entry.executionCapabilities.maxDimension}`, `实际文件格式 ${format}`] }] };
}
function recommendCloudTargets(matrix, catalog, options = {}) {
  validateCatalog(catalog);
  const candidates = [];
  for (const entry of catalog.computerTypes) {
    try {
      const normalized = normalizeOptions(options, entry, false);
      if (compatibilityIssues(matrix, entry, catalog, normalized).length) continue;
      candidates.push({ computer_type_id: entry.id, dimension: matrix.qubo.num_bits, format: matrix.content.length > catalog.uploadLimits.maxCsvBytes ? 'npz' : 'csv', reasons: [`实际矩阵 ${matrix.qubo.num_bits} 维，范围 ${entry.executionCapabilities.minDimension}–${entry.executionCapabilities.maxDimension}`, '问题类型、最终格式和计算次数满足已声明约束', normalized.post_process === undefined ? `post_process 尚未选择；目录固定要求=${entry.executionCapabilities.fixedPostProcess ?? '未声明'}` : '已选 post_process 满足已声明约束'], price: entry.price, computeCreditCost: entry.computeCreditCost });
    } catch (_) { /* Invalid or incomplete submission options do not authorize anything. */ }
  }
  const cost = options.use_credit === true ? 'computeCreditCost' : options.use_credit === false ? 'price' : null;
  return candidates.sort((a, b) => (cost ? a[cost] - b[cost] : 0) || a.computer_type_id - b.computer_type_id);
}
class CloudTargetTransport {
  constructor({ apiKey, baseUrl: address, timeoutSeconds = 30, fetch = http.fetch }) {
    if (typeof apiKey !== 'function') throw new Error('apiKey provider 必须可调用');
    if (!(timeoutSeconds > 0) || !Number.isFinite(timeoutSeconds)) throw new Error('timeoutSeconds 必须为正数');
    this.apiKey = apiKey; this.baseUrl = baseUrl(address); this.timeoutSeconds = timeoutSeconds; this.fetch = fetch; this.execution_mode = 'live';
  }
  prepareSubmission() {
    const key = this.apiKey();
    if (typeof key !== 'string' || !key || /\s/.test(key)) throw new Error('IsingQ API Key 不可用；请先完成云端凭据配置');
    return { Authorization: key, channel: 'sdk' };
  }
  async submit(file, solverOptions, credentials) {
    const id = solverOptions?.computer_type_id;
    if (!positive(id)) throw new Error('computer_type_id 必须为所选目录机型正整数 ID');
    const normalized = normalizeOptions(solverOptions, { id, price: null });
    if (!Buffer.isBuffer(file?.content) || !['csv', 'npz'].includes(file.format) || typeof file.task_name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(file.task_name) || file.filename !== `matrix.${file.format}`) throw new Error('云提交需要有效文件格式、matrix.csv/npz 文件名和唯一 task_name');
    credentials ??= this.prepareSubmission();
    if (!credentials.Authorization || credentials.channel !== 'sdk') throw new Error('云提交凭据无效；请重新准备认证');
    let phase = 'upload';
    try {
      const uploaded = await request(this, `/files/upload-bytes?originalFilename=${encodeURIComponent(file.filename)}`, { method: 'POST', headers: { ...credentials, 'Content-Type': 'application/octet-stream' }, body: file.content }, phase, credentials);
      const fileUrl = uploaded.data?.fileUrl;
      let url;
      try { url = new URL(fileUrl); } catch (_) { throw new IsingQError('上传响应缺少有效 data.fileUrl', { phase }); }
      if (typeof fileUrl !== 'string' || url.protocol !== 'https:' || url.username || url.password) throw new IsingQError('上传响应 data.fileUrl 必须为不含凭据的 HTTPS 地址', { phase });
      phase = 'create_task';
      const body = await request(this, '/tasks/create-general', { method: 'POST', headers: { ...credentials, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.task_name, computerTypeId: id, inputJFile: fileUrl, questionType: 1, caculateCount: normalized.calculate_count, postProcess: normalized.post_process, useCredit: normalized.use_credit }) }, phase, credentials);
      const taskId = body.data?.id;
      if (!(typeof taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) && !(Number.isSafeInteger(taskId) && taskId > 0)) throw new IsingQError('创建响应缺少有效 data.id；受理结果未知，请核查唯一任务名称', { phase, submissionOutcome: 'unknown' });
      return { task_id: String(taskId) };
    } catch (error) { throw classify(error, phase); }
  }
  async poll(taskId, numBits) {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) throw new Error('provider task_id 格式无效');
    const credentials = this.prepareSubmission();
    return normalizeCloudPoll(await request(this, `/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', headers: credentials }, 'poll', credentials), numBits, true);
  }
}
module.exports = { CLOUD_ENVIRONMENTS, CloudCatalogClient, CloudTargetTransport, prepareCloudTarget, recommendCloudTargets, compatibilityIssues, validateCatalog };
