'use strict';

const crypto = require('crypto');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const MAX_PROVIDER_MESSAGE_CHARS = 512;
const CLOUD_SUBMISSION_CONTRACT_VERSION = 'isingq-cloud-submission-v1';

class IsingQError extends Error {
  constructor(message, { phase = 'unknown', status = null, retryable = false, submissionUnknown = false, submissionOutcome = null, providerMessage = null } = {}) {
    super(message);
    this.phase = phase;
    this.status = status;
    this.retryable = retryable;
    this.submissionUnknown = submissionUnknown;
    this.submissionOutcome = submissionOutcome;
    this.providerMessage = providerMessage;
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

function safeProviderMessage(value, secrets) {
  // Only the platform's JSON message contract is public. HTML and stack traces
  // are diagnostic internals, even if a proxy places them in a message field.
  if (typeof value !== 'string' || /<!doctype|<\/?[a-z][^>]*>|\b(?:Error|Exception):|(?:^|\n)\s*at\s+\S/i.test(value)) return null;
  let message = value;
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length)) {
    for (const representation of new Set([secret, encodeURIComponent(secret)])) message = message.split(representation).join('[REDACTED]');
  }
  message = message
    .replace(/\bBearer\s+[^\s;,]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|api[_ -]?key|access[_ -]?key|private[_ -]?key|secret[_ -]?key|access[_ -]?token|security[_ -]?token|refresh[_ -]?token|token|password|secret|signature|policy|cookie|set-cookie|x[_-]oss[_-]credential|x[_-]oss[_-]security[_-]token)\b["']?\s*[=:：]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s;,]+)/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return message ? message.slice(0, MAX_PROVIDER_MESSAGE_CHARS) : null;
}

async function failureMessage(response, secrets) {
  try {
    // Parsing/reading a failed response must never override its HTTP outcome.
    const declared = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(declared) && declared > MAX_ERROR_RESPONSE_BYTES) {
      await response.body?.cancel();
      return null;
    }
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_ERROR_RESPONSE_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(Buffer.from(value));
        }
        text = Buffer.concat(chunks).toString('utf8');
      } finally {
        reader.releaseLock();
      }
    } else {
      // Lightweight injected test transports may expose only text(). Real
      // fetch Responses always take the bounded streaming path above.
      text = await response.text();
      if (Buffer.byteLength(text) > MAX_ERROR_RESPONSE_BYTES) return null;
    }
    const payload = JSON.parse(text);
    return safeProviderMessage(payload.message, secrets);
  } catch (_) {
    return null;
  }
}

async function checkedFetch(url, options, phase, timeoutSeconds, secrets = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      const providerMessage = await failureMessage(response, [...secrets, options.headers?.Authorization]);
      throw new IsingQError(`IsingQ 请求失败（phase=${phase}, status=${response.status}）`, {
        phase,
        status: response.status,
        retryable,
        submissionUnknown: phase === 'create_task' && (retryable || response.status === 409),
        submissionOutcome: phase !== 'create_task' ? 'not_created' : (retryable || response.status === 409 ? 'unknown' : 'rejected'),
        providerMessage,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof IsingQError) throw error;
    throw new IsingQError(`IsingQ 网络请求失败（phase=${phase}）`, {
      phase,
      retryable: phase !== 'create_task',
      submissionUnknown: phase === 'create_task',
      submissionOutcome: phase === 'create_task' ? 'unknown' : 'not_created',
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
  const allowed = ['computer_type_id', 'question_type', 'calculate_count', 'post_process', 'use_credit', 'gear'];
  const unknown = Object.keys(value).filter(field => !allowed.includes(field));
  if (unknown.length) throw new Error(`solver_options 包含未知字段（fields=${unknown.join(',')}）；仅允许 ${allowed.join('/')}，不会使用默认值替代拼写错误`);
  for (const field of allowed) {
    if (Object.hasOwn(value, field) && value[field] === null) throw new Error(`solver_options 字段不能为 null（field=${field}）；需要默认值时省略该字段`);
  }
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

function validateCloudSubmissionOptions(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || !Object.hasOwn(input, 'use_credit') || typeof input.use_credit !== 'boolean') {
    throw new Error('solver_options.use_credit 必须是显式 boolean（true=算力券，false=账户余额）；请先向用户确认付款选择，不得自动切换。读取历史任务请使用 poll/get（isingq_solve_poll / isingq_solve_result_get）');
  }
  return options(input);
}

class IsingQTransport {
  constructor({ apiKey, baseUrl = 'https://api.isingq.com', timeoutSeconds = 30 }) {
    if (typeof apiKey !== 'function') throw new Error('apiKey provider 必须可调用');
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('baseUrl 必须是不含凭据的 HTTPS URL');
    }
    this.apiKey = apiKey;
    this.execution_mode = 'live';
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.timeoutSeconds = timeoutSeconds;
  }

  headers() {
    const key = this.apiKey();
    if (typeof key !== 'string' || !key || /\s/.test(key)) throw new Error('IsingQ API Key 不可用');
    return { Authorization: key, channel: 'sdk' };
  }

  prepareSubmission() {
    return this.headers();
  }

  async submit(matrix, solverOptions, credentials) {
    // No implicit payment default, including direct low-level callers. Validate
    // before credential reads and before the first upload-signature request.
    const normalized = validateCloudSubmissionOptions(solverOptions);
    credentials ??= this.prepareSubmission();
    let phase = 'upload_signature';
    try {
      const signatureResponse = await checkedFetch(
        endpoint(this.baseUrl, '/files/getPostSignatureForOssUpload'),
        { method: 'GET', headers: credentials },
        'upload_signature',
        this.timeoutSeconds,
      );
      const signature = uploadSignature(await boundedJson(signatureResponse, 'upload_signature'));
      const secrets = [credentials.Authorization, signature.policy, signature.signature, signature.x_oss_credential, signature.security_token];
      phase = 'upload';
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
        secrets,
      );
      phase = 'create_task';
      const created = await checkedFetch(
        endpoint(this.baseUrl, '/tasks/create-general'),
        {
          method: 'POST',
          headers: { ...credentials, 'Content-Type': 'application/json' },
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
        secrets,
      );
      return { task_id: taskId(await boundedJson(created, 'create_task')), options: normalized };
    } catch (error) {
      // Only the transport knows whether task creation may have started. This
      // boundary includes response-body reads and local parsing, not just fetch.
      const outcome = error instanceof IsingQError && error.submissionOutcome
        ? error.submissionOutcome : (phase === 'create_task' ? 'unknown' : 'not_created');
      if (error instanceof IsingQError) {
        error.submissionOutcome = outcome;
        error.submissionUnknown = outcome === 'unknown';
        throw error;
      }
      throw new IsingQError(`IsingQ 提交失败（phase=${phase}）`, {
        phase, submissionOutcome: outcome, submissionUnknown: outcome === 'unknown', retryable: outcome === 'not_created',
      });
    }
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

module.exports = { CLOUD_SUBMISSION_CONTRACT_VERSION, IsingQError, IsingQTransport, options, validateCloudSubmissionOptions };
