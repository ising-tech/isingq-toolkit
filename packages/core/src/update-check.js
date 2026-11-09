'use strict';

const http = require('undici');
const CURRENT_VERSION = require('../package.json').version;
const PACKAGE_NAME = '@ising-tech/isingq-mcp';
const REGISTRY_URL = 'https://registry.npmjs.org/@ising-tech%2fisingq-mcp/latest';
const UPDATE_CONTRACT_VERSION = 'isingq-update-check-v1';

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error('版本必须是稳定语义版本（例如 0.8.0）');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function createUpdateChecker({ currentVersion = CURRENT_VERSION, fetch = (...args) => http.fetch(...args), now = Date.now,
  timeoutMs = 2000, successTtlMs = 86400000, failureTtlMs = 300000 } = {}) {
  if (!versionParts(currentVersion)) throw new Error('当前版本格式无效');
  let cache, expiresAt = 0, pending;
  function present(value, cached) {
    return { ...value, cached, notification: {
      show: value.status === 'update_available',
      text: value.status === 'update_available' ? value.notice : null,
      placement: 'after_primary_task_result',
      announce_check: false,
      requires_response: false,
      repeat_policy: 'once_per_conversation',
      silent_instruction: '用户没有询问更新时，检查前和检查中也不预告或播报版本查询；show=false 时所有用户可见消息均省略版本检查及其状态，不解释已是最新、不解释检查失败、不重试、不追问。',
    } };
  }
  async function request() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const base = { contract_version: UPDATE_CONTRACT_VERSION, package_name: PACKAGE_NAME, current_version: currentVersion,
      source: REGISTRY_URL, checked_at: new Date(now()).toISOString(), automatic_install: false };
    try {
      const response = await fetch(REGISTRY_URL, { headers: { Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 65536 || !response.body?.getReader) {
        await response.body?.cancel(); throw Error('invalid response');
      }
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65536) { await reader.cancel(); throw Error('response too large'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (metadata.name !== PACKAGE_NAME || !versionParts(metadata.version)) throw Error('invalid metadata');
      const comparison = compareVersions(metadata.version, currentVersion);
      return { ...base, status: comparison > 0 ? 'update_available' : comparison === 0 ? 'up_to_date' : 'current_ahead',
        latest_version: metadata.version, notice: comparison > 0 ? `IsingQ Toolkit ${metadata.version} 已发布；当前为 ${currentVersion}。可按安装方式显式升级，不自动更改环境。` : null };
    } catch {
      return { ...base, status: 'unavailable', latest_version: null, notice: null,
        diagnostic_message: '本次未能核实官方最新版本；仅供用户主动询问更新状态时解释，不影响当前操作。' };
    } finally { clearTimeout(timer); }
  }
  return async function checkUpdate(args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'refresh')
      || (Object.hasOwn(args, 'refresh') && typeof args.refresh !== 'boolean')) throw new Error('更新检查只接受可选 boolean refresh');
    if (pending) return pending;
    if (!args.refresh && cache && now() < expiresAt) return present(cache, true);
    pending = request().then(value => {
      cache = value; expiresAt = now() + (value.status === 'unavailable' ? failureTtlMs : successTtlMs);
      return present(value, false);
    }).finally(() => { pending = null; });
    return pending;
  };
}

const checkUpdate = createUpdateChecker();
module.exports = { UPDATE_CONTRACT_VERSION, checkUpdate, createUpdateChecker, compareVersions };
