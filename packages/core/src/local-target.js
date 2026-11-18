'use strict';

const crypto = require('node:crypto');
const { Blob } = require('node:buffer');
const http = require('undici');
const { IsingQError } = require('./isingq');
const { normalizeProfile } = require('./solver-profiles');
const { fileLimit } = require('./file-limits');
const { validateQubo } = require('./qubo');
const MAX_RESPONSE_BYTES = 1024 * 1024;
function error(code, message, options = {}) { const e = new IsingQError(message, options); e.code = code; return e; }
const LOCAL_ADAPTER_VERSION = 'ising-control-http-v1';
const LOCAL_DEFAULT_TASK_MODE = 2;
const STANDARD_LOCAL_CONTRACT = Object.freeze({
  contract_id: LOCAL_ADAPTER_VERSION,
  source: 'IsingControl HTTP v1; binary result-domain verified by task7007 (2026-11-10)',
  matrix_mode: 'binary', csv_layout: 'qubo_upper_triangular', result_domain: 'binary',
  allowed_states: Object.freeze(['stable']),
});
const PROVIDER_CONSTRAINT_FIELDS = ['coefficient_min', 'coefficient_max', 'integer_coefficients', 'coefficient_step', 'max_file_bytes'];
function resultDomain(contract) { return contract.result_domain || contract.matrix_mode; }
function contractFor(profile, { probe } = {}) {
  const overrides = normalizeProfile(profile).contract || {};
  const c = { ...STANDARD_LOCAL_CONTRACT, allowed_states: ['stable'], ...overrides };
  if (c.matrix_mode !== 'binary' || c.csv_layout !== 'qubo_upper_triangular') throw error('local_encoding_unsupported', '当前QUBO仅支持binary与无头qubo_upper_triangular CSV；spin输入或其他布局需要已实现且核实的转换，不会静默切换');
  if (c.spin_to_bit != null && !['plus_is_one', 'minus_is_one'].includes(c.spin_to_bit)) throw error('local_encoding_unsupported', 'spin_to_bit只能是明确的plus_is_one或minus_is_one映射');
  if (c.result_domain === 'spin' && !c.spin_to_bit) throw error('local_contract_required', '显式result_domain=spin需要明确spin_to_bit映射；不能从字段名或全1向量猜测');
  if (c.result_domain === 'binary') delete c.spin_to_bit;
  if (probe) {
    const currentMaxScale = probe.config?.maxScale;
    if (!Number.isSafeInteger(currentMaxScale) || currentMaxScale < 1) throw error('local_probe_invalid', '本次设备配置缺少有效的正整数maxScale；无法核实当前规模上界，请重新读取原设备配置');
    c.max_dimension = Math.min(currentMaxScale, overrides.max_dimension ?? currentMaxScale);
  }
  return c;
}
function declaredConstraints(contract) {
  return Object.fromEntries(PROVIDER_CONSTRAINT_FIELDS.map(field => [field,
    Object.hasOwn(contract, field) ? { status: 'declared', value: contract[field], source: 'explicit_contract' }
      : { status: 'not_declared', responsibility: 'provider_managed' }]));
}
// Use the exact decimal value actually serialized from each JS number. Decimal
// lattices start at zero; no tolerance, scaling or rounding changes the input.
function decimalFraction(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const numerator = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - Number(exponent);
  return scale < 0 ? { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n }
    : { numerator, denominator: 10n ** BigInt(scale) };
}
function obeysStep(value, step) {
  const fraction = decimalFraction(value);
  return (fraction.numerator * step.denominator) % (fraction.denominator * step.numerator) === 0n;
}
function localOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw error('local_options_invalid', `本地solver_options必须是object（actual_type=${options === null ? 'null' : Array.isArray(options) ? 'array' : typeof options}）；请传{}使用默认配置，不沿用云端参数`);
  const invalid = Object.keys(options).filter(k => k !== 'task_mode');
  if (invalid.length) throw error('local_options_invalid', `本地不支持参数（fields=${invalid.join(',')}）；只允许task_mode，不沿用云端参数`);
  const task_mode = options.task_mode === undefined ? LOCAL_DEFAULT_TASK_MODE : options.task_mode;
  if (!Number.isInteger(task_mode) || ![0, 1, 2].includes(task_mode)) throw error('local_options_invalid', `本地技术参数task_mode必须是整数0/1/2（actual_type=${task_mode === null ? 'null' : typeof task_mode}${typeof task_mode === 'number' ? ', actual=' + task_mode : ''}）；请修正参数或省略该字段使用默认配置`);
  return { task_mode };
}
function prepareLocalTarget(matrix, profile, probe, options, { environment = process.env } = {}) {
  const c = contractFor(profile, { probe }), solver_options = localOptions(options);
  const n = matrix?.qubo?.num_bits;
  if (!Number.isSafeInteger(n) || n < 1 || !Buffer.isBuffer(matrix?.content)) throw error('local_matrix_invalid', '需要规范化QUBO matrixDocument及真实CSV字节');
  const currentMaxScale = probe?.config?.maxScale;
  if (!Number.isSafeInteger(currentMaxScale) || currentMaxScale < 1) throw error('local_probe_invalid', '本次设备配置缺少有效的正整数maxScale；无法核实当前规模上界，请重新读取原设备配置');
  if (n > currentMaxScale) throw error('local_device_dimension_exceeded', `部署合同与当前设备能力不兼容（dimension=${n}, maxScale=${currentMaxScale}, max_dimension=${profile.contract?.max_dimension ?? c.max_dimension}）；请减少矩阵规模或核实原设备，刷新确认不能绕过当前能力上界`);
  if (n > c.max_dimension) throw error('local_dimension_exceeded', `矩阵超过已核实维度（dimension=${n}, max_dimension=${c.max_dimension}）`);
  if (!probe?.config || !probe.runtime || !probe.status || !c.allowed_states.includes(probe.status.status)) throw error('local_state_not_allowed', `设备状态尚未核实为获准提交状态（status=${probe?.status?.status || 'unknown'}, allowed_states=${c.allowed_states.join(',')}）；请核对设备方规则`);
  let validated;
  try { validated = validateQubo(matrix.qubo, { maxBits: currentMaxScale }).qubo; }
  catch (_) { throw error('local_matrix_invalid', `QUBO结构、索引或数值无效（dimension=${n}）；请检查有限系数/offset、变量索引和重复项`); }
  const terms = [...validated.linear, ...validated.quadratic];
  const coefficients = terms.map(t => t.coefficient);
  // Canonical upper-triangular CSV includes structural zeros below its diagonal.
  if (n > 1 || !coefficients.length) coefficients.push(0);
  const step = c.coefficient_step == null ? null : decimalFraction(c.coefficient_step);
  for (const coefficient of coefficients) if (!Number.isFinite(coefficient) || (c.integer_coefficients === true && !Number.isInteger(coefficient)) || (c.coefficient_min != null && coefficient < c.coefficient_min) || (c.coefficient_max != null && coefficient > c.coefficient_max) || (step && !obeysStep(coefficient, step))) throw error('local_coefficient_invalid', `矩阵系数不符合部署合同（coefficient=${coefficient}, min=${c.coefficient_min}, max=${c.coefficient_max}, integer_coefficients=${c.integer_coefficients === true}, coefficient_step=${c.coefficient_step ?? 'none'}, contract_id=${c.contract_id}）；请修正模型或核实合同，不得静默缩放、量化或截断`);
  const content = Buffer.from(matrix.content), size_bytes = content.length;
  const clientMaxBytes = fileLimit('localFile', environment);
  if (size_bytes > clientMaxBytes) throw error('local_client_file_too_large', `CSV超过客户端容量（bytes=${size_bytes}, client_max_file_bytes=${clientMaxBytes}）；请核对当前Toolkit容量配置，不代表设备上传上限`);
  if (c.max_file_bytes != null && size_bytes > c.max_file_bytes) throw error('local_file_too_large', `CSV超过已核实文件限制（bytes=${size_bytes}, max_file_bytes=${c.max_file_bytes}）`);
  const declared_constraints = declaredConstraints(c);
  const result_domain = resultDomain(c);
  return { adapter_version: LOCAL_ADAPTER_VERSION, effective_contract: structuredClone(c), declared_constraints,
    precision: { reported_max_precision: probe.config.maxPrecision ?? null, responsibility: 'provider_managed',
      integer_coefficients: declared_constraints.integer_coefficients, coefficient_step: declared_constraints.coefficient_step,
      client_quantization: 'none', client_scaling: 'none', client_truncation: 'none', lossless_guaranteed: false },
    client_capacity: { scope: 'client_runtime', max_file_bytes: clientMaxBytes, source: 'Toolkit localFile capacity' },
    file: { content, format: 'csv', filename: 'matrix.csv', sha256: crypto.createHash('sha256').update(content).digest('hex'), size_bytes }, solver_options,
    capabilities: { config: structuredClone(probe.config), runtime: structuredClone(probe.runtime), status: structuredClone(probe.status), contract: structuredClone(c) },
    encoding: {
      matrix_mode: c.matrix_mode, result_domain, csv_layout: c.csv_layout,
      ...(result_domain === 'spin' ? { spin_to_bit: c.spin_to_bit } : {}),
      offset: validated.offset, provider_energy_is_qubo: false,
    }, advice: [] };
}
async function readJson(response, phase) {
  const chunks = []; let size = 0;
  if (Number(response.headers?.get?.('content-length')) > MAX_RESPONSE_BYTES) { try { await response.body?.cancel(); } catch (_) {} throw error('local_response_too_large', `设备响应超过上限（phase=${phase}, max_bytes=${MAX_RESPONSE_BYTES}）`, { phase }); }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw error('local_response_too_large', `设备响应超过上限（phase=${phase}, max_bytes=${MAX_RESPONSE_BYTES}）`, { phase }); } chunks.push(Buffer.from(r.value)); } } finally { reader.releaseLock(); }
  } else { const text = await response.text(); size = Buffer.byteLength(text); if (size > MAX_RESPONSE_BYTES) throw error('local_response_too_large', `设备响应超过上限（phase=${phase}）`, { phase }); chunks.push(Buffer.from(text)); }
  try {
    // Provider -0 denotes the same bit, energy or timing value as 0.
    return JSON.parse(Buffer.concat(chunks).toString('utf8'), (_key, value) => value === 0 ? 0 : value);
  } catch (_) { throw error('local_response_invalid', `设备未返回有效JSON（phase=${phase}）；请核对服务地址和反代路径`, { phase }); }
}
class LocalSolverTransport {
  constructor({ profile, timeoutSeconds = 30, fetch = http.fetch, credentialProvider, environment = process.env } = {}) {
    normalizeProfile(profile); this.profile = structuredClone(profile); this.baseUrl = normalizeProfile(profile).api_base_url;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw error('local_timeout_invalid', 'timeoutSeconds必须大于0');
    this.clientMaxBytes = fileLimit('localFile', environment);
    this.timeoutMs = Math.ceil(timeoutSeconds * 1000); this.fetch = fetch; this.credentialProvider = credentialProvider; this.execution_mode = 'live';
  }
  prepareSubmission() {
    let supplied;
    try { supplied = this.credentialProvider ? this.credentialProvider(structuredClone(this.profile)) : null; }
    catch (_) { throw error('local_credentials_invalid', '无法读取独立本地凭据；请检查本地认证回调配置，不要在对话中发送秘密'); }
    return this.validateCredentials(supplied);
  }
  validateCredentials(supplied) {
    if (supplied?.then) throw error('local_credentials_invalid', '本地credentialProvider必须同步返回独立凭据，不能返回Promise');
    if (supplied == null) return { headers: {} };
    if (!supplied || Object.keys(supplied).some(k => k !== 'headers') || !supplied.headers || typeof supplied.headers !== 'object' || Array.isArray(supplied.headers)) throw error('local_credentials_invalid', '本地认证回调必须返回{headers:{...}}；请使用独立本地凭据');
    const headers = {};
    for (const [key, value] of Object.entries(supplied.headers)) {
      if (!/^[a-zA-Z0-9-]+$/.test(key) || /^(host|content-length|content-type|connection|cookie|proxy-authorization|x-api-key|api-key)$/i.test(key) || typeof value !== 'string' || /[\r\n]/.test(value)) throw error('local_credentials_invalid', '本地认证头无效或含保留头；请使用独立Authorization或部署明确的认证头，不复用云Key');
      headers[key] = value;
    }
    return { headers };
  }
  async request(route, body, phase, credentials, multipart = false) {
    const checkedCredentials = this.validateCredentials(credentials);
    const submitting = phase === 'local_create'; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${route}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { ...checkedCredentials.headers, ...(!multipart ? { 'Content-Type': 'application/json' } : {}) }, body: multipart ? body : JSON.stringify(body || {}) });
      const data = await readJson(response, phase);
      if (!response.ok || data?.code !== 10000) {
        const providerCode = Number.isInteger(data?.code) ? data.code : null;
        const rejected = response.status < 500 && [400, 10001].includes(providerCode);
        const e = error('local_provider_error', `本地服务请求失败（phase=${phase}, http=${response.status}, code=${providerCode ?? 'invalid'}）；请核对原设备状态，勿盲目重提`, { phase, status: response.status, submissionOutcome: submitting ? (rejected ? 'rejected' : 'unknown') : null, submissionUnknown: submitting && !rejected }); e.providerCode = providerCode; throw e;
      }
      if (!data.data || typeof data.data !== 'object' || Array.isArray(data.data)) throw error('local_response_invalid', `设备响应data无效（phase=${phase}）`, { phase });
      return data.data;
    } catch (e) {
      if (e instanceof IsingQError) { if (submitting && !e.submissionOutcome) { e.submissionOutcome = 'unknown'; e.submissionUnknown = true; } throw e; }
      throw error('local_request_failed', `本地请求未取得有效回执（phase=${phase}${response ? `, http=${response.status}` : ''}）；请核对原设备，不要重新创建任务`, { phase, submissionOutcome: submitting ? 'unknown' : null, submissionUnknown: submitting });
    } finally { clearTimeout(timer); }
  }
  async probe() {
    const credentials = this.prepareSubmission();
    const config = await this.request('/api/device/config', {}, 'local_config', credentials);
    const runtime = await this.request('/api/device/runtime', {}, 'local_runtime', credentials);
    const status = await this.request('/api/device/status', {}, 'local_status', credentials);
    if (typeof config.deviceName !== 'string' || typeof config.version !== 'string' || (!Number.isSafeInteger(config.maxScale) || config.maxScale < 1) || !Number.isFinite(runtime.bootTimestamp) || typeof status.status !== 'string') throw error('local_probe_invalid', '设备配置/运行/状态字段不完整；网络可达不代表能力已核实');
    return { config, runtime, status };
  }
  async submit(file, options, credentials = this.prepareSubmission()) {
    let c, o;
    try { c = contractFor(this.profile); o = localOptions(options); credentials = this.validateCredentials(credentials); }
    catch (e) { if (e instanceof IsingQError) { e.phase = 'local_create'; e.submissionOutcome = 'not_created'; } throw e; }
    if (!Buffer.isBuffer(file?.content) || file.format !== 'csv' || typeof file.task_name !== 'string' || !file.task_name.trim() || file.task_name.length > 200) throw error('local_file_invalid', '本地提交需要CSV字节及唯一task_name', { phase: 'local_create', submissionOutcome: 'not_created' });
    if (file.content.length > this.clientMaxBytes) throw error('local_client_file_too_large', `CSV超过客户端容量（bytes=${file.content.length}, client_max_file_bytes=${this.clientMaxBytes}）`, { phase: 'local_create', submissionOutcome: 'not_created' });
    if (c.max_file_bytes != null && file.content.length > c.max_file_bytes) throw error('local_file_too_large', `CSV超过已核实文件限制（bytes=${file.content.length}, max_file_bytes=${c.max_file_bytes}）`, { phase: 'local_create', submissionOutcome: 'not_created' });
    const form = new http.FormData(); form.set('param', JSON.stringify({ taskName: file.task_name, taskMode: o.task_mode, matrixMode: c.matrix_mode })); form.set('file', new Blob([file.content], { type: 'text/csv' }), 'matrix.csv');
    const data = await this.request('/api/task/create', form, 'local_create', credentials, true);
    if (data.status !== 'success' || typeof data.taskId !== 'string' || !data.taskId.trim()) throw error('local_create_invalid', '设备创建回执缺少有效taskId/status；受理情况未知，请核查原设备', { phase: 'local_create', submissionOutcome: 'unknown', submissionUnknown: true });
    return { task_id: data.taskId };
  }
  async poll(id, numBits) {
    if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(numBits) || numBits < 1) throw error('local_poll_invalid', '查询必须提供原设备taskId及正整数numBits');
    const credentials = this.prepareSubmission(); const detail = await this.request('/api/task/detail', { taskId: id }, 'local_detail', credentials);
    if (detail.taskId !== id) throw error('local_task_mismatch', '设备详情返回了不同taskId；已停止解析以防任务串号');
    const provider_status = detail.status;
    if (provider_status === 'pending') return { status: 'queued', provider_status };
    if (provider_status === 'running') return { status: 'running', provider_status };
    if (provider_status === 'failed') return { status: 'failed', provider_status };
    if (provider_status !== 'finished') throw error('local_status_invalid', '设备返回未知任务状态；请保留原任务并核对接口版本');
    let result;
    try { result = await this.request('/api/task/result', { taskId: id }, 'local_result', credentials); }
    catch (e) { if (['local_response_invalid', 'local_response_too_large'].includes(e.code)) return { status: 'result_invalid', provider_status, result_reason: 'malformed_result_response' }; if (e.providerCode === 10021) return { status: 'result_pending', provider_status, result_reason: 'unavailable_or_cleared', provider_code: 10021 }; if ([10022, 10023].includes(e.providerCode)) return { status: 'result_invalid', provider_status, result_reason: e.providerCode === 10022 ? 'result_file_unreadable' : 'result_json_corrupt', provider_code: e.providerCode }; if (e.providerCode === 10020) return { status: 'result_invalid', provider_status, result_reason: 'task_not_found', provider_code: 10020 }; throw e; }
    const c = contractFor(this.profile);
    const result_domain = resultDomain(c);
    // The provider keeps the spin_config field name for binary vectors too.
    // Interpret by the submitted snapshot contract, never by inspecting values:
    // all-one vectors are valid in both domains but may decode differently.
    const vector = result.spin_config;
    const allowedValues = result_domain === 'binary' ? [0, 1] : [-1, 1];
    if (result.ok !== true || !Array.isArray(vector) || vector.length !== numBits || vector.some(value => !allowedValues.includes(value)) || !Number.isFinite(result.energy) || !Number.isFinite(result.isingCalcMs) || result.isingCalcMs < 0) return { status: 'result_invalid', provider_status, result_domain, result_reason: 'invalid_vector_energy_or_timing' };
    const bits = result_domain === 'binary' ? vector.slice()
      : vector.map(s => c.spin_to_bit === 'plus_is_one' ? Number(s === 1) : Number(s === -1));
    return { status: 'succeeded', provider_status, result_domain, bits, energy: result.energy, provider_energy: result.energy,
      ...(result_domain === 'spin' ? { spins: vector.slice() } : {}), spin_config: vector.slice(),
      isingCalcMs: result.isingCalcMs, device_compute_ms: result.isingCalcMs };
  }
}
module.exports = { LocalSolverTransport, prepareLocalTarget, localOptions, LOCAL_DEFAULT_TASK_MODE, LOCAL_ADAPTER_VERSION };
