'use strict';

const http = require('undici');
const { LocalSolverTransport } = require('./local-target');
const { CLOUD_ENVIRONMENTS, CloudCatalogClient } = require('./cloud-target');

// The page socket retains its existing 10s inactivity bound. Parallel readonly
// provider requests finish within this shorter limit, returning a useful DTO.
const DEFAULT_TIMEOUT_SECONDS = 8;
const PROFILE_ID = /^local_[a-f0-9]{32}$/;
const DEVICE_FIELDS = ['name', 'version', 'max_scale', 'max_precision', 'status', 'boot_timestamp'];
const READS = [
  { group: 'config', route: '/api/device/config', phase: 'local_config', fields: [
    ['name', 'deviceName', value => typeof value === 'string' && value.trim().length > 0],
    ['version', 'version', value => typeof value === 'string' && value.trim().length > 0],
    ['max_scale', 'maxScale', value => Number.isSafeInteger(value) && value > 0],
    ['max_precision', 'maxPrecision', value => typeof value === 'string' && value.trim().length > 0],
  ] },
  { group: 'runtime', route: '/api/device/runtime', phase: 'local_runtime', fields: [
    ['boot_timestamp', 'bootTimestamp', value => Number.isSafeInteger(value) && value >= 0],
  ] },
  { group: 'status', route: '/api/device/status', phase: 'local_status', fields: [
    ['status', 'status', value => typeof value === 'string' && value.trim().length > 0],
  ] },
];
const LOCAL_CODES = new Set(['local_credentials_invalid', 'local_provider_error', 'local_response_invalid', 'local_response_too_large', 'local_request_failed']);
const FIELD_NAMES = { name: '设备名称', version: '版本', max_scale: '规模', max_precision: '精度', status: '运行状态', boot_timestamp: '开机时间' };
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function sameProfile(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }
function httpStatus(value) { return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null; }
class TargetConfigDataError extends Error {
  constructor(status, code, message, details = {}) { super(message); this.status = status; this.code = code; Object.assign(this, details); }
}
function localIssue(field, error, observedStatus) {
  const status = httpStatus(error?.status) || httpStatus(observedStatus);
  const code = LOCAL_CODES.has(error?.code) ? error.code : 'local_check_failed';
  let message;
  if (status === 401 || status === 403) message = '设备接口拒绝访问；请核对该连接的独立本地认证或访问权限。这不是本机配置会话失效。';
  else if (code === 'local_credentials_invalid') message = '独立本地凭据不可用；请检查本地认证配置，不要复用云端Key或在页面输入秘密。';
  else if (code === 'local_response_too_large') message = '设备信息响应超过读取上限；请核对原服务接口。';
  else if (code === 'local_response_invalid') message = '设备未返回可解析的信息对象；请核对服务地址、反代路径和接口版本。';
  else if (code === 'local_request_failed') message = '未取得设备接口回执，可能为网络或超时；请从Toolkit运行位置核对连接后重试，不能据此认定硬件离线。';
  else if (code === 'local_provider_error') message = '设备接口返回HTTP或业务错误；请按状态码核对原服务，不能据此认定硬件离线。';
  else message = '本次设备信息检查未完成；请核对该连接和本地运行环境后重试。';
  return { field, code, message, ...(status ? { http_status: status } : {}),
    ...(Number.isSafeInteger(error?.providerCode) ? { provider_code: error.providerCode } : {}) };
}

class TargetConfigData {
  constructor({ profileStore, localTransportFactory, catalogClientFactory, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    now = () => new Date().toISOString() } = {}) {
    if (!profileStore || typeof profileStore.get !== 'function') throw new Error('TargetConfigData需要已配置的profileStore');
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds >= 10) throw new Error('配置页信息查询timeoutSeconds必须大于0且小于10秒，以保留本机响应时间');
    this.profileStore = profileStore; this.localTransportFactory = localTransportFactory; this.catalogClientFactory = catalogClientFactory;
    this.timeoutSeconds = timeoutSeconds; this.now = now; this.clients = new Map(); this.inFlightTests = new Map();
  }
  savedProfile(id) {
    if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new TargetConfigDataError(404, 'profile_not_found', '未找到已保存连接；请刷新连接列表后再测试');
    try { return this.profileStore.get(id); }
    catch (error) {
      if (['profile_not_found', 'profile_id_invalid'].includes(error.code)) throw new TargetConfigDataError(404, 'profile_not_found', '该连接已删除或不存在；请刷新连接列表');
      throw new TargetConfigDataError(400, 'profiles_unavailable', '无法读取已保存连接；请核对Toolkit配置文件后重试');
    }
  }
  async testProfile(id, input) {
    if (!object(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'revision') || !Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new TargetConfigDataError(400, 'profile_test_invalid', '测试仅接受已保存连接的{revision:正整数}，不能提供临时地址、模型或求解参数');
    }
    const profile = structuredClone(this.savedProfile(id));
    if (profile.revision !== input.revision) throw new TargetConfigDataError(409, 'profile_test_stale', '连接版本已变化；请刷新连接后重新测试，不会使用旧地址');
    const key = JSON.stringify(canonical(profile));
    let work = this.inFlightTests.get(key);
    if (!work) {
      work = this.readProfile(profile); this.inFlightTests.set(key, work);
      const cleanup = () => { if (this.inFlightTests.get(key) === work) this.inFlightTests.delete(key); };
      work.then(cleanup, cleanup);
    }
    const result = await work;
    this.assertCurrentProfile(profile);
    return structuredClone(result);
  }
  assertCurrentProfile(profile) {
    const current = this.savedProfile(profile.id);
    if (current.revision !== profile.revision || !sameProfile(profile, current)) throw new TargetConfigDataError(409, 'profile_test_stale', '检测期间连接已修改；已丢弃旧地址结果，请测试当前版本');
  }
  async readProfile(profile) {
    const device = Object.fromEntries(DEVICE_FIELDS.map(field => [field, null]));
    const issues = [], statuses = new Map();
    let transport, credentials;
    try {
      transport = this.localTransportFactory ? this.localTransportFactory(structuredClone(profile), { timeoutSeconds: this.timeoutSeconds }) : new LocalSolverTransport({ profile, timeoutSeconds: this.timeoutSeconds,
        fetch: async (url, options) => { const response = await http.fetch(url, options); statuses.set(String(url), response.status); return response; } });
      // Synchronous credential reads use only the selected local adapter. No
      // cloud API-key provider or solve preparation is involved in this check.
      credentials = transport.prepareSubmission?.();
      if (credentials?.then) throw Object.assign(new Error('async local credentials are unsupported'), { code: 'local_credentials_invalid' });
    } catch (error) { issues.push(localIssue('connection', error)); }
    if (!issues.length) {
      const outcomes = await Promise.allSettled(READS.map(read => Promise.resolve().then(() => transport.request(read.route, {}, read.phase, credentials))));
      outcomes.forEach((outcome, index) => {
        const read = READS[index];
        if (outcome.status === 'rejected') { issues.push(localIssue(read.group, outcome.reason, statuses.get(`${profile.api_base_url}${read.route}`))); return; }
        const data = outcome.value;
        for (const [field, key, valid] of read.fields) {
          const value = object(data) ? data[key] : undefined;
          if (valid(value)) device[field] = value;
          else issues.push({ field, code: value == null ? 'device_field_missing' : 'device_field_invalid', message: `本次接口未提供有效${FIELD_NAMES[field]}；该项保持未知，不从其他规格推断。` });
        }
      });
    }
    this.assertCurrentProfile(profile);
    const hasInformation = Object.values(device).some(value => value !== null);
    return { profile_id: profile.id, profile_revision: profile.revision, checked_at: this.now(),
      outcome: issues.length === 0 ? 'success' : hasInformation ? 'partial' : 'failed', device, issues,
      observation: { source: 'toolkit_host', read_only: true, task_submitted: false } };
  }
  async cloudCatalog(environment) {
    if (!['prod', 'sit'].includes(environment)) throw new TargetConfigDataError(400, 'cloud_environment_invalid', '云目录查看必须明确environment=prod或sit；此操作不修改求解目标');
    try {
      if (!this.clients.has(environment)) {
        const options = { baseUrl: CLOUD_ENVIRONMENTS[environment].api_base_url, timeoutSeconds: this.timeoutSeconds };
        this.clients.set(environment, this.catalogClientFactory ? this.catalogClientFactory(options, environment) : new CloudCatalogClient(options));
      }
      const catalog = await this.clients.get(environment).get();
      return { environment, checked_at: this.now(), catalog };
    } catch (error) {
      const status = httpStatus(error?.status);
      const retry = Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : null;
      const limited = status === 429;
      const code = limited ? 'CATALOGUE_RATE_LIMITED' : error?.code === 'CATALOGUE_SCHEMA_INVALID' ? 'CATALOGUE_SCHEMA_INVALID' : 'cloud_catalog_unavailable';
      throw new TargetConfigDataError(limited ? 429 : 502, code,
        limited ? '公开云目录被限流；请按退避时间稍后刷新，本地维护仍可使用。' : code === 'CATALOGUE_SCHEMA_INVALID' ? '公开云目录版本或结构不兼容；请核对原服务，未使用陈旧或固定名单。' : '公开云目录暂不可用；请稍后手动刷新，本地维护仍可使用。',
        { http_status: status, retry_after_seconds: retry });
    }
  }
}
module.exports = { TargetConfigData, TargetConfigDataError, DEFAULT_TIMEOUT_SECONDS };
