'use strict';
const { runWithCleanupSync } = require('./run-with-cleanup');

const fs = require('node:fs');
const { unlinkOwnedFileSync } = require('./owned-file');
const path = require('node:path');
const crypto = require('node:crypto');
const { roots } = require('./store');
const MAX_BYTES = 1024 * 1024;
const MAX_PROFILES = 1000;
const ID = /^local_[a-f0-9]{32}$/;
const CONTRACT_FIELDS = ['contract_id', 'source', 'matrix_mode', 'csv_layout', 'spin_to_bit', 'result_domain', 'max_dimension', 'allowed_states', 'coefficient_min', 'coefficient_max', 'integer_coefficients', 'coefficient_step', 'max_file_bytes'];

class SolverProfileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new SolverProfileError(code, message); }
function normalizeUrl(value, field, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x20\x7f]/.test(value.trim())) fail('profile_url_invalid', `${field} 必须填写完整 http/https 地址；请包含实际协议、端口和反代路径`);
  let url;
  try { url = new URL(value.trim()); } catch (_) { fail('profile_url_invalid', `${field} 格式无效；示例：http://192.0.2.10:8080`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('profile_url_invalid', `${field} 只支持无凭据、无查询参数和片段的 http/https 地址`);
  return url.href.replace(/\/$/, '');
}
function normalizeContract(input) {
  if (input == null) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('profile_contract_invalid', 'contract 必须为已核实部署合同对象，或省略');
  for (const key of Object.keys(input)) if (!CONTRACT_FIELDS.includes(key)) fail('profile_contract_invalid', `contract 不支持字段 ${key}；秘密凭据不得写入普通配置`);
  const result = structuredClone(input);
  for (const field of ['contract_id', 'source']) if (field in result && (typeof result[field] !== 'string' || !result[field].trim() || result[field].length > 1000)) fail('profile_contract_invalid', `contract.${field} 必须为非空文本（最多1000字符）`);
  for (const field of ['max_dimension', 'max_file_bytes']) if (field in result && (!Number.isSafeInteger(result[field]) || result[field] < 1)) fail('profile_contract_invalid', `contract.${field} 必须是正整数`);
  for (const field of ['coefficient_min', 'coefficient_max']) if (field in result && !Number.isFinite(result[field])) fail('profile_contract_invalid', `contract.${field} 必须是有限数值`);
  if ('result_domain' in result && !['binary', 'spin'].includes(result.result_domain)) fail('profile_contract_invalid', 'contract.result_domain 必须是binary或spin；按已提交合同解释返回向量，不能从字段名或向量猜测');
  if ('coefficient_step' in result && (!Number.isFinite(result.coefficient_step) || result.coefficient_step <= 0)) fail('profile_contract_invalid', 'contract.coefficient_step 必须是有限正数；表示从0起的精确十进制系数步长');
  if ('integer_coefficients' in result && typeof result.integer_coefficients !== 'boolean') fail('profile_contract_invalid', 'contract.integer_coefficients 必须是boolean');
  if ('allowed_states' in result && (!Array.isArray(result.allowed_states) || !result.allowed_states.length || result.allowed_states.some(s => !['offline', 'powering_on', 'stable', 'debugging', 'unstable'].includes(s)))) fail('profile_contract_invalid', 'contract.allowed_states 必须明确列出获准提交的设备状态');
  if (result.coefficient_min > result.coefficient_max) fail('profile_contract_invalid', 'contract.coefficient_min 不得大于 coefficient_max');
  return result;
}
function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('profile_invalid', '连接必须是对象');
  const allowed = ['id', 'revision', 'name', 'api_base_url', 'web_base_url', 'contract'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) fail('profile_field_invalid', `连接不支持字段 ${key}；请使用 name/api_base_url/web_base_url/contract`);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120 || /[\x00-\x1f\x7f]/.test(input.name)) fail('profile_name_invalid', 'name 必须为1到120字符的连接名称，不能包含控制字符');
  if (input.id != null && (typeof input.id !== 'string' || !ID.test(input.id))) fail('profile_id_invalid', 'id 必须是已有连接的稳定 local_ 标识');
  const contract = normalizeContract(input.contract);
  return { name: input.name.trim(), api_base_url: normalizeUrl(input.api_base_url, 'api_base_url'), web_base_url: normalizeUrl(input.web_base_url, 'web_base_url', true), ...(contract ? { contract } : {}) };
}
class SolverProfileStore {
  constructor(environment = process.env) { this.directory = roots(environment).config; this.file = path.join(this.directory, 'solver-profiles.json'); }
  read() {
    let fd;
    return runWithCleanupSync(() => {
      try {
        const st = fs.lstatSync(this.file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_BYTES) fail('profiles_unsafe', '连接配置必须是小于1MiB的普通文件；请检查配置文件类型与大小');
        fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0;
        while (size <= MAX_BYTES) { const n = fs.readSync(fd, buffer, size, buffer.length - size, null); if (!n) break; size += n; }
        if (size > MAX_BYTES) fail('profiles_unsafe', '连接配置超过1MiB；请保留原文件并检查内容');
        let data; try { data = JSON.parse(buffer.subarray(0, size).toString('utf8')); } catch (_) { fail('profiles_invalid', '连接配置JSON损坏；请保留文件并从备份核对，不要覆盖'); }
        if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > MAX_PROFILES) fail('profiles_invalid', '连接配置版本或结构无效；请保留文件并核对版本');
        const ids = new Set();
        for (const p of data.profiles) { normalizeProfile(p); if (!ID.test(p.id) || !Number.isSafeInteger(p.revision) || p.revision < 1 || ids.has(p.id)) fail('profiles_invalid', '连接配置id或revision无效/重复；请从备份核对'); ids.add(p.id); }
        return data;
      } catch (error) { if (error.code === 'ENOENT') return { version: 1, profiles: [] }; if (error instanceof SolverProfileError) throw error; fail('profiles_io_error', `读取连接配置失败；请检查文件权限（fs_code=${error.code || 'unknown'}）`); }
    }, () => {
      if (fd !== undefined) fs.closeSync(fd);
    });
  }
  list() { return structuredClone(this.read().profiles); }
  get(id) { if (!ID.test(id)) fail('profile_id_invalid', '连接id无效'); const p = this.list().find(p => p.id === id); if (!p) fail('profile_not_found', `未找到连接（profile_id=${id}）；请刷新连接列表`); return p; }
  write(data) {
    if (data.profiles.length > MAX_PROFILES) fail('profiles_limit_exceeded', `连接数量超过上限（count=${data.profiles.length}, max_profiles=${MAX_PROFILES}）；请先删除不再使用的连接，原配置未修改`);
    const text = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_BYTES) fail('profiles_too_large', '连接配置超过1MiB；请减少配置内容');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) fail('profiles_unsafe', '配置目录不可为符号链接');
    if (process.platform !== 'win32') fs.chmodSync(this.directory, 0o700);
    const temp = `${this.file}.tmp-${crypto.randomUUID()}`;
    let fd;
    let created = false;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); created = true;
      fs.writeFileSync(fd, text); fs.fsyncSync(fd);
      const ownedFd = fd; fd = undefined; fs.closeSync(ownedFd);
      fs.renameSync(temp, this.file); created = false;
    }
    catch (error) { fail('profiles_io_error', `保存连接失败，原配置保留；请检查权限与磁盘空间（fs_code=${error.code || 'unknown'}）`); }
    finally {
      if (fd !== undefined) { const ownedFd = fd; fd = undefined; try { fs.closeSync(ownedFd); } catch (_) {} }
      if (created) { try { fs.unlinkSync(temp); } catch (_) {} }
    }
  }
  mutate(operation) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) fail('profiles_unsafe', '配置目录不可为符号链接');
    const lock = `${this.file}.lock`; let descriptor, identity, primaryError, primaryFailed = false;
    try { descriptor = fs.openSync(lock, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') fail('profiles_busy', '连接配置正在被其他入口修改；请稍后刷新重试。若进程已退出，请先核实无写入进程再移除遗留solver-profiles.json.lock'); fail('profiles_io_error', `无法锁定配置；请检查目录权限（fs_code=${e.code || 'unknown'}）`); }
    let result, cleanupError, cleanupFailed = false;
    try { identity = fs.fstatSync(descriptor); result = operation(); }
    catch (error) { primaryFailed = true; primaryError = error; }
    finally {
      if (descriptor !== undefined) {
        if (!identity) { try { identity = fs.fstatSync(descriptor); } catch (error) { cleanupFailed = true; cleanupError = error; } }
        const ownedFd = descriptor; descriptor = undefined; try { fs.closeSync(ownedFd); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
      }
      try { unlinkOwnedFileSync(lock, identity); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
    }
    if (primaryFailed) throw primaryError;
    if (cleanupFailed) throw cleanupError;
    return result;
  }
  save(input) { return this.mutate(() => this.saveLocked(input)); }
  saveLocked(input) {
    const value = normalizeProfile(input), data = this.read();
    const existing = input.id ? data.profiles.find(p => p.id === input.id) : null;
    if (input.id && !existing) fail('profile_not_found', `未找到连接（profile_id=${input.id}）；请刷新后重新编辑`);
    if (existing) {
      const revision = Object.hasOwn(input, 'revision') ? input.revision : undefined;
      if (!Number.isSafeInteger(revision) || revision < 1) fail('profile_revision_invalid', `编辑已有连接需要正安全整数revision（profile_id=${existing.id}）；请刷新并使用读取到的版本重试`);
      if (revision !== existing.revision) fail('profile_revision_conflict', `连接已被修改（profile_id=${existing.id}, current_revision=${existing.revision}）；请刷新后重试`);
      if (existing.revision === Number.MAX_SAFE_INTEGER) fail('profile_revision_invalid', '连接版本达到上限；请保留原配置并联系维护人员');
    }
    const profile = { id: existing?.id || `local_${crypto.randomBytes(16).toString('hex')}`, revision: (existing?.revision || 0) + 1, ...value };
    if (existing) data.profiles[data.profiles.indexOf(existing)] = profile; else data.profiles.push(profile);
    this.write(data); return structuredClone(profile);
  }
  delete(id) { return this.mutate(() => { const data = this.read(), old = this.get(id); data.profiles = data.profiles.filter(p => p.id !== old.id); this.write(data); return { deleted: true, id }; }); }
}
module.exports = { SolverProfileStore, SolverProfileError, normalizeUrl, normalizeProfile, normalizeContract };
