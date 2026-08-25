'use strict';

const crypto = require('crypto');

const MAX_RESPONSE_BYTES = 1024 * 1024;

class IsingQError extends Error {
  constructor(message, { phase = 'unknown', status = null, retryable = false, submissionUnknown = false } = {}) {
    super(message);
    this.phase = phase;
    this.status = status;
    this.retryable = retryable;
    this.submissionUnknown = submissionUnknown;
  }
}

function endpoint(baseUrl, suffix) {
  return `${baseUrl.replace(/\/$/, '')}${suffix}`;
}

async function boundedJson(response, phase) {
  const declared = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new IsingQError(`IsingQ 响应过大（phase=${phase}, bytes=${declared}）`, { phase });
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new IsingQError(`IsingQ 响应超过 1 MiB（phase=${phase}）`, { phase });
  }
  try {
    const payload = JSON.parse(text);
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error();
    return payload;
  } catch (_) {
    throw new IsingQError(`IsingQ 返回无效 JSON（phase=${phase}）`, { phase });
  }
}

async function checkedFetch(url, options, phase, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      throw new IsingQError(`IsingQ 请求失败（phase=${phase}, status=${response.status}）`, {
        phase,
        status: response.status,
        retryable,
        submissionUnknown: phase === 'create_task' && (retryable || response.status === 409),
      });
    }
    return response;
  } catch (error) {
    if (error instanceof IsingQError) throw error;
    throw new IsingQError(`IsingQ 网络请求失败（phase=${phase}）`, {
      phase,
      retryable: phase !== 'create_task',
      submissionUnknown: phase === 'create_task',
    });
  } finally {
    clearTimeout(timer);
  }
}

function uploadSignature(payload) {
  const data = payload?.data;
  const fields = ['host', 'policy', 'signature', 'x_oss_credential', 'x_oss_date', 'security_token'];
  if (!data || typeof data !== 'object' || fields.some((field) => typeof data[field] !== 'string' || !data[field])) {
    throw new IsingQError('IsingQ OSS 签名响应缺少必要字段', { phase: 'upload_signature' });
  }
  const host = new URL(data.host);
  if (host.protocol !== 'https:' || host.username || host.password || host.search || host.hash) {
    throw new IsingQError('IsingQ OSS 地址必须是不含凭据的 HTTPS URL', { phase: 'upload_signature' });
  }
  return { ...data, host: host.toString() };
}

function taskId(payload) {
  for (const candidate of [payload, payload?.data]) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const field of ['id', 'taskId', 'task_id']) {
      const value = candidate[field];
      if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
    }
  }
  throw new IsingQError('IsingQ 创建任务响应缺少 task_id', { phase: 'create_task', submissionUnknown: true });
}

function options(input) {
  const value = input == null ? {} : input;
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('solver_options 必须是 object');
  const result = {
    computer_type_id: value.computer_type_id ?? 1,
    question_type: value.question_type ?? 1,
    calculate_count: value.calculate_count ?? 1,
    post_process: value.post_process ?? false,
    use_credit: value.use_credit ?? false,
    gear: value.gear ?? 2,
  };
  if (!Number.isInteger(result.computer_type_id) || result.computer_type_id < 1) throw new Error('computer_type_id 必须是正整数');
  if (!Number.isInteger(result.question_type) || result.question_type < 1) throw new Error('question_type 必须是正整数');
  if (!Number.isInteger(result.calculate_count) || result.calculate_count < 1 || result.calculate_count > 10000) {
    throw new Error('calculate_count 必须在 1 到 10000 之间');
  }
  if (typeof result.post_process !== 'boolean' || typeof result.use_credit !== 'boolean') {
    throw new Error('post_process 和 use_credit 必须是 boolean');
  }
  if (![0, 1, 2].includes(result.gear)) throw new Error('gear 必须是 0、1 或 2');
  return result;
}

class IsingQTransport {
  constructor({ apiKey, baseUrl = 'https://api.isingq.com', timeoutSeconds = 30 }) {
    if (typeof apiKey !== 'function') throw new Error('apiKey provider 必须可调用');
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('baseUrl 必须是不含凭据的 HTTPS URL');
    }
    this.apiKey = apiKey;
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.timeoutSeconds = timeoutSeconds;
  }

  headers() {
    const key = this.apiKey();
    if (typeof key !== 'string' || !key || /\s/.test(key)) throw new Error('IsingQ API Key 不可用');
    return { Authorization: key, channel: 'sdk' };
  }

  async submit(matrix, solverOptions) {
    const signatureResponse = await checkedFetch(
      endpoint(this.baseUrl, '/files/getPostSignatureForOssUpload'),
      { method: 'GET', headers: this.headers() },
      'upload_signature',
      this.timeoutSeconds,
    );
    const signature = uploadSignature(await boundedJson(signatureResponse, 'upload_signature'));
    const objectKey = `${crypto.randomUUID().slice(0, 8)}/isingq-mcp-qubo.csv`;
    const form = new FormData();
    form.append('success_action_status', '200');
    form.append('policy', signature.policy);
    form.append('x-oss-signature', signature.signature);
    form.append('x-oss-signature-version', 'OSS4-HMAC-SHA256');
    form.append('x-oss-credential', signature.x_oss_credential);
    form.append('x-oss-date', signature.x_oss_date);
    form.append('key', objectKey);
    form.append('x-oss-security-token', signature.security_token);
    form.append('file', new Blob([matrix.content], { type: 'text/csv' }), 'isingq-mcp-qubo.csv');
    await checkedFetch(
      signature.host,
      { method: 'POST', body: form },
      'upload',
      this.timeoutSeconds,
    );
    const normalized = options(solverOptions);
    const created = await checkedFetch(
      endpoint(this.baseUrl, '/tasks/create-general'),
      {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `isingq-mcp-${matrix.sha256.slice(0, 12)}`,
          computerTypeId: normalized.computer_type_id,
          inputJFile: `${signature.host.replace(/\/$/, '')}/${objectKey}`,
          inputHFile: null,
          questionType: normalized.question_type,
          caculateCount: normalized.calculate_count,
          postProcess: Number(normalized.post_process),
          couponId: null,
          useCoupon: false,
          useCredit: normalized.use_credit,
        }),
      },
      'create_task',
      this.timeoutSeconds,
    );
    return { task_id: taskId(await boundedJson(created, 'create_task')), options: normalized };
  }

  async poll(providerTaskId, numBits) {
    if (typeof providerTaskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(providerTaskId)) {
      throw new Error('provider task_id 格式无效');
    }
    const response = await checkedFetch(
      endpoint(this.baseUrl, `/tasks/${encodeURIComponent(providerTaskId)}`),
      { method: 'GET', headers: this.headers() },
      'poll',
      this.timeoutSeconds,
    );
    const body = await boundedJson(response, 'poll');
    const payload = body?.data && typeof body.data === 'object' ? body.data : body;
    const status = Number(payload.status);
    if (![1, 2, 3].includes(status)) return { status: 'running' };
    if (!payload.result || typeof payload.result !== 'object') return { status: 'failed' };
    const raw = Array.isArray(payload.result.bits) ? payload.result.bits : payload.result.spin_config;
    if (!Array.isArray(raw) || raw.length !== numBits) throw new IsingQError('IsingQ 解向量维度无效', { phase: 'poll' });
    let bits;
    if (raw.every((value) => Number.isInteger(value) && [0, 1].includes(value))) bits = raw;
    else if (raw.every((value) => Number.isInteger(value) && [-1, 1].includes(value))) bits = raw.map((value) => (value + 1) / 2);
    else throw new IsingQError('IsingQ 解向量取值无效', { phase: 'poll' });
    const energy = payload.result.energy == null ? null : Number(payload.result.energy);
    if (energy !== null && !Number.isFinite(energy)) throw new IsingQError('IsingQ energy 无效', { phase: 'poll' });
    return { status: 'succeeded', bits, energy };
  }
}

module.exports = { IsingQError, IsingQTransport, options };
