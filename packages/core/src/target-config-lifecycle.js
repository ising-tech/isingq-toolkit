'use strict';
const { runWithCleanupSync } = require('./run-with-cleanup');

const fs = require('node:fs');
const { unlinkOwnedFileSync } = require('./owned-file');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const LIFECYCLE_PROTOCOL = 'isingq-manager-lifecycle-v3';
const STARTUP_TIMEOUT_MS = 5000;
const WAIT_TIMEOUT_MS = 8000;
const IDENTITY_TIMEOUT_MS = 500;
const SHUTDOWN_GRACE_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 1000;
const HEX = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 16 * 1024;
class ManagerLifecycleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new ManagerLifecycleError(code, message); }
function userId() { return typeof process.getuid === 'function' ? String(process.getuid()) : 'user-' + crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 24); }
function assertPrivate(stat, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077))) fail('manager_registry_unsafe', '管理页登记必须是当前用户私有的普通文件/目录；请核对所有者、权限与符号链接，不会复用或终止不明进程');
}
function ensurePrivateDirectory(directory) {
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); assertPrivate(fs.lstatSync(directory), true); }
  catch (e) { if (e instanceof ManagerLifecycleError) throw e; fail('manager_registry_unavailable', '无法建立管理页私有登记；请检查临时目录权限与磁盘空间'); }
}
function canonicalConfigFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== 'solver-profiles.json') fail('manager_config_invalid', '管理页需要绝对solver-profiles.json配置路径');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { if (fs.lstatSync(file).isSymbolicLink()) fail('manager_config_invalid', '配置文件本身不可为符号链接；配置目录别名可使用'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return path.join(fs.realpathSync(directory), path.basename(file));
}
function buildIdentity(...sources) { return crypto.createHash('sha256').update([LIFECYCLE_PROTOCOL, ...sources].join('\0')).digest('hex'); }
function location(configFile, buildId, suppliedRoot, environment = 'prod') {
  if (!HEX.test(buildId)) fail('manager_build_invalid', '管理页构建身份无效；请使用匹配的Toolkit入口');
  if (!['prod', 'sit'].includes(environment)) fail('manager_build_invalid', '管理页作用域仅支持prod或sit');
  const uid = userId();
  const root = suppliedRoot || path.join(os.tmpdir(), 'isingq-manager-' + uid);
  if (!path.isAbsolute(root) || path.basename(root) !== 'isingq-manager-' + uid) fail('manager_registry_unsafe', '管理页登记位置与当前用户不匹配');
  ensurePrivateDirectory(root);
  const directory = fs.realpathSync(root);
  const key = crypto.createHash('sha256').update([uid, configFile, environment, LIFECYCLE_PROTOCOL].join('\0')).digest('hex');
  const scope = path.join(directory, key + '.scope.json');
  const descriptor = { protocol: LIFECYCLE_PROTOCOL, user_id: uid, config_file: configFile, cloud_environment: environment };
  if (!readPrivate(scope)) { try { exclusiveJson(scope, descriptor); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const recorded = readPrivate(scope, { missing: false });
  if (Object.keys(recorded).sort().join(',') !== Object.keys(descriptor).sort().join(',') || Object.keys(descriptor).some(name => recorded[name] !== descriptor[name])) fail('manager_registry_invalid', '管理页配置归属登记与当前作用域不一致；请保留并核查，未启动服务');
  return { directory, key, scope, file: path.join(directory, key + '.session.json'), lock: path.join(directory, key + '.starting'), config_file: configFile, build_id: buildId, user_id: uid, cloud_environment: environment };
}
function readPrivate(file, { missing = true } = {}) {
  let fd;
  return runWithCleanupSync(() => {
    try {
      assertPrivate(fs.lstatSync(file));
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const metadata = fs.fstatSync(fd); assertPrivate(metadata);
      if (metadata.size > MAX_RECORD_BYTES) fail('manager_registry_invalid', '管理页登记过大；请保留登记并由维护者核查，未启动替代进程');
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1); const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > MAX_RECORD_BYTES) fail('manager_registry_invalid', '管理页登记过大；请保留并核查');
      let value; try { value = JSON.parse(buffer.subarray(0, bytes).toString('utf8')); } catch (_) { fail('manager_registry_invalid', '管理页登记JSON损坏；请保留登记并核查，未盲目增开或终止进程'); }
      return value;
    } catch (e) { if (missing && e.code === 'ENOENT') return null; if (e instanceof ManagerLifecycleError) throw e; fail('manager_registry_unavailable', '无法安全读取管理页登记；请核对权限和文件类型'); }
  }, () => {
    if (fd !== undefined) fs.closeSync(fd);
  });
}
function exclusiveJson(file, value) {
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomUUID(); let fd, identity;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); identity = fs.fstatSync(fd);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd);
    const ownedFd = fd; fd = undefined; fs.closeSync(ownedFd);
    // A hard link is an atomic, exclusive publish of fully written bytes. A
    // contender can never parse an empty/half-written JSON lock or session.
    fs.linkSync(temporary, file);
  } finally {
    if (fd !== undefined) {
      if (!identity) { try { identity = fs.fstatSync(fd); } catch (_) {} }
      const ownedFd = fd; fd = undefined; try { fs.closeSync(ownedFd); } catch (_) {}
    }
    // Publication is complete after linkSync. Temporary cleanup must never turn
    // a published owner/session into a failure whose caller cannot release it.
    try { unlinkOwnedFileSync(temporary, identity); } catch (_) {}
  }
}

function sameBasis(record, loc) { return record?.protocol === LIFECYCLE_PROTOCOL && record.config_file === loc.config_file && record.build_id === loc.build_id && record.user_id === loc.user_id; }
function validSession(record, loc) {
  if (!sameBasis(record, loc) || typeof record.config_file !== 'string' || !path.isAbsolute(record.config_file) || !HEX.test(record.build_id) || !HEX.test(record.nonce) || !HEX.test(record.token) || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isFinite(record.created_at) || !['prod', 'sit'].includes(record.cloud_environment) || typeof record.internal_preview !== 'boolean' || record.cloud_environment === 'sit' && !record.internal_preview || record.expiry_policy !== 'idle' || ![record.idle_timeout_ms, record.foreground_lease_ms, record.heartbeat_ms].every(value => Number.isSafeInteger(value) && value > 0) || record.heartbeat_ms >= record.foreground_lease_ms) fail('manager_registry_invalid', '管理页会话登记与当前idle协议/配置/构建不匹配或已损坏；请保留并核查，不会盲目增开');
  let url; try { url = new URL(record.origin); } catch (_) { fail('manager_registry_invalid', '管理页登记地址无效；不会访问该地址'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || (!/^\d+$/.test(url.port) || Number(url.port) < 1) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== record.origin) fail('manager_registry_invalid', '管理页登记仅允许规范127.0.0.1临时端口；拒绝外部或任意地址');
  return record;
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function queryIdentity(record, timeoutMs = IDENTITY_TIMEOUT_MS) {
  try { validSession(record, { config_file: record.config_file, build_id: record.build_id, user_id: userId() }); } catch (_) { return Promise.resolve(false); }
  return new Promise(resolve => {
    let request, received, finished = false;
    const finish = valid => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (!valid) { received?.destroy(); request?.destroy(); }
      resolve(valid);
    };
    // Absolute wall-clock deadline covers connect, headers and streaming body.
    // A peer cannot renew it by continuously sending a few bytes.
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      request = http.get(record.origin + '/api/session', { headers: { 'X-Config-Token': record.token, Origin: record.origin }, agent: false }, response => {
        received = response; const parts = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > MAX_RECORD_BYTES) finish(false); else parts.push(chunk); });
        response.on('end', () => {
          try { const body = JSON.parse(Buffer.concat(parts).toString('utf8')); const valid = response.statusCode === 200 && ['protocol', 'nonce', 'config_file', 'build_id', 'user_id', 'pid', 'cloud_environment', 'internal_preview', 'expiry_policy', 'idle_timeout_ms', 'foreground_lease_ms', 'heartbeat_ms'].every(key => body[key] === record[key]) && body.closed === false && (body.idle_deadline_at === null || Number.isFinite(Date.parse(body.idle_deadline_at)) && Date.parse(body.idle_deadline_at) > Date.now()); finish(valid ? body : false); } catch (_) { finish(false); }
        });
        response.on('error', () => finish(false));
      });
      request.on('error', () => finish(false));
    } catch (_) { finish(false); }
  });
}

async function identity(record, timeoutMs = IDENTITY_TIMEOUT_MS) { return Boolean(await queryIdentity(record, timeoutMs)); }

function removeSession(loc, nonce) {
  const current = readPrivate(loc.file);
  if (!current || current.nonce !== nonce || !sameBasis(current, loc)) return false;
  fs.unlinkSync(loc.file); return true;
}
function ownerPath(loc) { return path.join(loc.lock, 'owner.json'); }
function handoffPath(loc) { return path.join(loc.lock, 'handoff.json'); }
function owner(loc) {
  try { assertPrivate(fs.lstatSync(loc.lock), true); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const value = readPrivate(ownerPath(loc));
  if (!value) return null; // mkdir -> owner write is synchronous but other processes can observe it.
  if (value.protocol !== LIFECYCLE_PROTOCOL || value.config_file !== loc.config_file || value.user_id !== loc.user_id || value.cloud_environment !== loc.cloud_environment || !HEX.test(value.build_id) || !HEX.test(value.nonce) || !Number.isSafeInteger(value.owner_pid) || value.owner_pid < 1 || !Number.isFinite(value.deadline_at)) fail('manager_lock_invalid', '管理页启动锁损坏或不匹配；请保留并核查，未盲目启动');
  return value;
}
function removeClaim(loc, nonce) {
  const current = owner(loc);
  if (!current || current.nonce !== nonce) return false;
  const handoff = readPrivate(handoffPath(loc));
  if (handoff && handoff.nonce !== nonce) return false;
  if (handoff && (!Number.isSafeInteger(handoff.pid) || handoff.pid < 1 || !['child', 'recovery'].includes(handoff.role))) fail('manager_lock_invalid', '启动接管登记损坏；请保留并核查，未删除不明所有者的锁');
  if (handoff) fs.unlinkSync(handoffPath(loc));
  fs.unlinkSync(ownerPath(loc));
  for (const name of fs.readdirSync(loc.lock)) {
    if (!/^(owner|handoff)\.json\.tmp-\d+-[a-f0-9-]+$/.test(name)) fail('manager_lock_invalid', '启动锁内存在未知文件；请保留并核查');
    const temporary = path.join(loc.lock, name); assertPrivate(fs.lstatSync(temporary)); fs.unlinkSync(temporary);
  }
  fs.rmdirSync(loc.lock); return true;
}
function newClaim(loc, startupMs) {
  try { fs.mkdirSync(loc.lock, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  const claim = { protocol: LIFECYCLE_PROTOCOL, config_file: loc.config_file, build_id: loc.build_id, user_id: loc.user_id, cloud_environment: loc.cloud_environment,
    nonce: crypto.randomBytes(32).toString('hex'), owner_pid: process.pid, created_at: Date.now(), deadline_at: Date.now() + startupMs };
  try { exclusiveJson(ownerPath(loc), claim); return claim; } catch (e) { try { fs.rmdirSync(loc.lock); } catch (_) {} throw e; }
}
function recoverClaim(loc) {
  const claim = owner(loc);
  if (!claim) {
    try { if (Date.now() - fs.lstatSync(loc.lock).mtimeMs > STARTUP_TIMEOUT_MS) fail('manager_lock_invalid', '管理页启动锁缺少所有权信息；请保留并核查'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return false;
  }
  if (Date.now() <= claim.deadline_at || alive(claim.owner_pid)) return false;
  let fenced = false;
  try {
    exclusiveJson(handoffPath(loc), { nonce: claim.nonce, pid: process.pid, role: 'recovery' }); fenced = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readPrivate(handoffPath(loc));
    if (!holder || holder.nonce !== claim.nonce || !Number.isSafeInteger(holder.pid) || holder.pid < 1 || !['child', 'recovery'].includes(holder.role)) fail('manager_lock_invalid', '管理页启动接管身份不明；请保留并核查');
    if (alive(holder.pid)) return false;
    // A dead child cannot race this removal; current nonce is rechecked below.
    fs.unlinkSync(handoffPath(loc)); return recoverClaim(loc);
  }
  if (fenced) {
    const current = owner(loc);
    if (!current || current.nonce !== claim.nonce || Date.now() <= current.deadline_at || alive(current.owner_pid)) return false;
    return removeClaim(loc, claim.nonce);
  }
  return false;
}
function claimChild(loc, nonce) {
  const claim = owner(loc);
  if (!claim || claim.build_id !== loc.build_id || claim.nonce !== nonce || Date.now() >= claim.deadline_at) fail('manager_claim_expired', '管理页启动接管已失效；未建立新监听口');
  try { exclusiveJson(handoffPath(loc), { nonce, pid: process.pid, role: 'child' }); }
  catch (e) { if (e.code === 'EEXIST') fail('manager_claim_lost', '管理页启动已由其他所有者接管；未建立新监听口'); throw e; }
  const after = owner(loc);
  if (!after || after.nonce !== nonce || Date.now() >= after.deadline_at) fail('manager_claim_expired', '管理页启动接管已过期；未发布会话');
  return after;
}
function publishSession(loc, claim, session) {
  const current = owner(loc), handoff = readPrivate(handoffPath(loc));
  if (!current || current.nonce !== claim.nonce || handoff?.nonce !== claim.nonce || handoff.pid !== process.pid || handoff.role !== 'child' || Date.now() >= claim.deadline_at) fail('manager_claim_lost', '管理页启动身份已变化；停止发布并关闭本次监听口');
  const url = new URL(session.url), policy = session.session;
  const record = { protocol: LIFECYCLE_PROTOCOL, config_file: loc.config_file, build_id: loc.build_id, user_id: loc.user_id,
    nonce: claim.nonce, pid: process.pid, origin: url.origin, token: url.hash.slice(1), created_at: session.created_at, cloud_environment: session.cloud_environment, internal_preview: session.internal_preview, expiry_policy: policy.expiry_policy, idle_timeout_ms: policy.idle_timeout_ms, foreground_lease_ms: policy.foreground_lease_ms, heartbeat_ms: policy.heartbeat_ms };
  validSession(record, loc); exclusiveJson(loc.file, record); removeClaim(loc, claim.nonce); return record;
}
async function reusable(loc, timeoutMs) {
  const value = readPrivate(loc.file);
  if (!value) return null;
  const record = validSession(value, { ...loc, build_id: value.build_id });
  if (record.cloud_environment !== loc.cloud_environment) fail('manager_registry_invalid', '管理页登记环境与当前作用域不一致，未启动替代服务');
  const verified = await queryIdentity(record, timeoutMs);
  if (verified && record.build_id === loc.build_id) return { ...record, current_state: verified };
  if (verified) { await retire(record, '/api/handover', timeoutMs); return null; }
  if (!alive(record.pid)) { removeSession({ ...loc, build_id: record.build_id }, record.nonce); return null; }
  fail('manager_identity_unverified', '现有管理页进程仍在运行，但身份或到期状态无法核实；请稍后重试或使用原页面结束。不会增开进程或根据登记PID终止进程');
}

// These control requests are sent only after matching a private registration
// and its authenticated loopback identity. Never signal a PID from disk.
async function control(record, route, value, timeoutMs) {
  const response = await fetch(record.origin + route, { method: 'POST', headers: { Origin: record.origin, 'Content-Type': 'application/json', 'X-Config-Token': record.token }, body: JSON.stringify(value), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json();
  if (response.status !== 200 || body.closed !== true) fail(body.code || 'manager_upgrade_unverified', `管理页升级尚未交接（${record.origin}）：${body.error || '原服务未确认结束'}；保留原页，不增开服务`);
}
async function retire(record, route, timeoutMs) {
  try { await control(record, route, route === '/api/handover' ? { expected_build: record.build_id } : {}, Math.max(timeoutMs, 100)); }
  catch (e) { if (e instanceof ManagerLifecycleError) throw e; fail('manager_upgrade_unverified', `原管理页交接未确认（${record.origin}）；请从原页保存或结束后重试，不增开服务`); }
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (alive(record.pid) && Date.now() < deadline) await sleep(15);
  if (alive(record.pid)) fail('manager_cleanup_unverified', `原管理页尚未退出（${record.origin}）；未创建新的服务`);
}
async function retireLegacy(loc, timeoutMs) {
  for (const name of fs.readdirSync(loc.directory).filter(name => /^[a-f0-9]{64}\.starting$/.test(name) && name !== loc.key + '.starting')) {
    const directory = path.join(loc.directory, name);
    let metadata; try { metadata = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assertPrivate(metadata, true);
    const descriptor = readPrivate(path.join(loc.directory, name.slice(0, -9) + '.scope.json'));
    if (descriptor) {
      const expected = crypto.createHash('sha256').update([descriptor.user_id, descriptor.config_file, descriptor.cloud_environment, LIFECYCLE_PROTOCOL].join('\0')).digest('hex');
      if (descriptor.protocol !== LIFECYCLE_PROTOCOL || descriptor.user_id !== loc.user_id || !path.isAbsolute(descriptor.config_file || '') || !['prod', 'sit'].includes(descriptor.cloud_environment) || name !== expected + '.starting') fail('manager_registry_invalid', '旧启动锁的配置归属登记无效，未启动替代服务');
      if (descriptor.config_file !== loc.config_file || descriptor.cloud_environment !== loc.cloud_environment) continue;
    }
    const claim = readPrivate(path.join(directory, 'owner.json'));
    if (!claim) {
      if (!fs.existsSync(directory)) continue;
      fail('manager_upgrade_starting', `旧启动登记${name.slice(0, 12)}尚无可核验归属；请等待旧启动完成或从旧入口恢复，未增开服务`);
    }
    if (claim.config_file !== loc.config_file || claim.user_id !== loc.user_id) continue;
    if (claim.cloud_environment && claim.cloud_environment !== loc.cloud_environment) continue;
    fail('manager_upgrade_starting', '同配置旧管理页正在启动或尚有启动登记；请等待旧入口完成或恢复结束后重试，未增开服务');
  }
  for (const name of fs.readdirSync(loc.directory).filter(name => /^[a-f0-9]{64}\.session\.json$/.test(name) && name !== loc.key + '.session.json')) {
    const file = path.join(loc.directory, name);
    let r; try { r = readPrivate(file); } catch (_) { continue; } // Unbound records do not establish ownership of this scope.
    if (!r || r.config_file !== loc.config_file || r.user_id !== loc.user_id) continue;
    if (r.cloud_environment && r.cloud_environment !== loc.cloud_environment) continue;
    if (r.protocol !== 'isingq-manager-lifecycle-v2') fail('manager_upgrade_unsupported', '发现同配置的未知旧管理协议；请从原页面结束后再打开，不增开服务');
    const legacyKey = crypto.createHash('sha256').update([loc.user_id, loc.config_file, r.build_id].join('\0')).digest('hex');
    let u; try { u = new URL(r.origin); } catch (_) {}
    if (name !== legacyKey + '.session.json' || !HEX.test(r.build_id) || !HEX.test(r.nonce) || !HEX.test(r.token) || !Number.isSafeInteger(r.pid) || r.pid < 1 || !u || u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.origin !== r.origin || u.username || u.password || u.pathname !== '/' || u.search || u.hash) fail('manager_registry_invalid', '同配置旧版登记不完整；请保留并核查，不增开或终止不明服务');
    if (!alive(r.pid)) { if (readPrivate(file)?.nonce === r.nonce) fs.unlinkSync(file); continue; }
    let response, state;
    try { response = await fetch(r.origin + '/api/session', { headers: { 'X-Config-Token': r.token, Origin: r.origin }, signal: AbortSignal.timeout(timeoutMs) }); state = await response.json(); } catch (_) {}
    if (response?.status !== 200 || !['protocol', 'nonce', 'config_file', 'build_id', 'user_id', 'pid'].every(key => state?.[key] === r[key]) || state.closed !== false) fail('manager_identity_unverified', `旧管理页身份无法核验（${r.origin}）；不增开或终止服务`);
    // v2 cannot atomically verify editor protection and retirement. It must
    // finish through its own confirmed close/idle path rather than /api/close
    // after a racy snapshot of page leases.
    fail('manager_upgrade_legacy', `旧管理页不支持安全版本交接（${r.origin}）；请在原页保存输入并结束管理后再打开新版，不增开服务`);
  }
}
function publicSession(record) { const state = record.current_state; return { url: record.origin + '/#' + record.token, pid: record.pid, scope: 'current_user_and_toolkit_host', cloud_environment: record.cloud_environment, internal_preview: record.internal_preview, expiry_policy: 'idle', idle_timeout_ms: record.idle_timeout_ms, foreground_lease_ms: record.foreground_lease_ms, heartbeat_ms: record.heartbeat_ms, idle_deadline_at: state?.idle_deadline_at ?? null, expires_at: state?.idle_deadline_at ?? null }; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
const CONTROL_IDENTITY = [control, retire].map(value => value.toString()).join('\0');
module.exports = { CONTROL_IDENTITY, LIFECYCLE_PROTOCOL, STARTUP_TIMEOUT_MS, WAIT_TIMEOUT_MS, IDENTITY_TIMEOUT_MS, SHUTDOWN_GRACE_MS, SHUTDOWN_TIMEOUT_MS,
  ManagerLifecycleError, canonicalConfigFile, buildIdentity, location, readPrivate, exclusiveJson, validSession, alive, identity, queryIdentity, removeSession,
  owner, newClaim, recoverClaim, removeClaim, claimChild, publishSession, reusable, retireLegacy, publicSession, sleep, userId };
