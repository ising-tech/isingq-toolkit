'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { checkUpdate, compareVersions } = require('./update-check');
const CURRENT_VERSION = require('../package.json').version;
const SUCCESS_TTL_MS = 86400000;
const FAILURE_TTL_MS = 300000;
const LOCK_TTL_MS = 15000;
const SCHEMA = 'isingq-background-updates-v1';
const TOKEN = /^[a-f0-9]{64}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const ENVIRONMENT_KEYS = ['HOME', 'USERPROFILE', 'XDG_CACHE_HOME', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'];

function workerEnvironment(environment) {
  const clean = {};
  for (const key of ENVIRONMENT_KEYS) if (typeof environment[key] === 'string' && environment[key]) clean[key] = environment[key];
  return clean;
}
function validVersion(value) {
  try { return compareVersions(value, value) === 0; } catch { return false; }
}
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }
function own(stat) { return typeof process.getuid !== 'function' || stat.uid === process.getuid(); }
function privateDirectory(directory, create) {
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !own(stat)) throw Error('unsafe update directory');
  if (create && process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}
function directoryFor(environment, create) {
  const home = environment.HOME || environment.USERPROFILE;
  const base = environment.XDG_CACHE_HOME || (process.platform === 'win32' && environment.LOCALAPPDATA) || (home && path.join(home, '.cache'));
  if (typeof base !== 'string' || !base || !path.isAbsolute(base)) return null;
  // Resolve the user's cache base once (including OS aliases such as /var).
  // Every directory managed below that base must itself be a real directory.
  if (create) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(base).isDirectory() || fs.lstatSync(base).isSymbolicLink()) return null;
  const canonicalBase = fs.realpathSync(base);
  const parent = path.join(canonicalBase, 'isingq-mcp');
  const directory = path.join(parent, 'updates');
  privateDirectory(parent, create);
  privateDirectory(directory, create);
  return directory;
}
function safePath(directory, name) {
  // Recheck the directory before each operation; never follow a substituted
  // managed directory or a final-component symlink.
  if (fs.realpathSync(directory) !== directory || fs.lstatSync(directory).isSymbolicLink()) throw Error('unsafe update directory');
  const filename = path.join(directory, name);
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || !own(stat)) throw Error('unsafe update file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return filename;
}
function readJson(directory, name) {
  let fd;
  try {
    fd = fs.openSync(safePath(directory, name), fs.constants.O_RDONLY | NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !own(stat) || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077))) return null;
    const buffer = Buffer.alloc(4097);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 4096) return null;
    return { value: JSON.parse(buffer.toString('utf8', 0, length)), stat };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function fresh(at, ttl, now) { return timestamp(at) && at <= now && now - at < ttl; }
function validCache(value, now) {
  if (!exactKeys(value, ['schema', 'current_version', 'latest_version', 'status', 'checked_at']) || value.schema !== SCHEMA
    || value.current_version !== CURRENT_VERSION) return false;
  if (value.status === 'unavailable') return value.latest_version === null && fresh(value.checked_at, FAILURE_TTL_MS, now);
  if (!validVersion(value.latest_version) || !fresh(value.checked_at, SUCCESS_TTL_MS, now)) return false;
  const comparison = compareVersions(value.latest_version, CURRENT_VERSION);
  return value.status === (comparison > 0 ? 'update_available' : comparison === 0 ? 'up_to_date' : 'current_ahead');
}
function ownsLock(directory, name, token) {
  const read = readJson(directory, name);
  return read && exactKeys(read.value, ['token', 'created_at']) && read.value.token === token && timestamp(read.value.created_at);
}
function releaseLock(directory, name, token) {
  try { if (ownsLock(directory, name, token)) fs.unlinkSync(safePath(directory, name)); } catch { /* Background work is best effort. */ }
}
function acquireLock(directory, name, now) {
  const token = crypto.randomBytes(32).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(safePath(directory, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
      fs.writeFileSync(fd, JSON.stringify({ token, created_at: now }));
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt) return null;
      const read = readJson(directory, name);
      const stat = fs.lstatSync(safePath(directory, name));
      const at = read && timestamp(read.value?.created_at) && read.value.created_at <= now ? read.value.created_at : Math.floor(stat.mtimeMs);
      if (!timestamp(at) || at > now || now - at < LOCK_TTL_MS) return null;
      // Only reclaim the same expired file observed above. A previous worker
      // must still prove ownership before it can write or release this lock.
      const current = fs.lstatSync(safePath(directory, name));
      if (current.ino !== stat.ino || current.dev !== stat.dev) return null;
      fs.unlinkSync(safePath(directory, name));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return null;
}
function writeOwned(directory, name, value, lockName, token) {
  if (!ownsLock(directory, lockName, token)) return false;
  const temporary = `${name}.${token}.tmp`;
  let fd;
  try {
    fd = fs.openSync(safePath(directory, temporary), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.closeSync(fd); fd = undefined;
    if (!ownsLock(directory, lockName, token)) return false;
    fs.renameSync(safePath(directory, temporary), safePath(directory, name));
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(safePath(directory, temporary)); } catch { /* Already renamed or no longer safe. */ }
  }
}
async function performCheck(directory, token, check, now) {
  try {
    if (!ownsLock(directory, 'check.lock', token)) return;
    let result;
    try { result = await check({ refresh: true }); } catch { /* Normalize errors without preserving their text. */ }
    const record = { schema: SCHEMA, current_version: CURRENT_VERSION, latest_version: null, status: 'unavailable', checked_at: now() };
    if (result?.current_version === CURRENT_VERSION && validVersion(result.latest_version)) {
      const comparison = compareVersions(result.latest_version, CURRENT_VERSION);
      const status = comparison > 0 ? 'update_available' : comparison === 0 ? 'up_to_date' : 'current_ahead';
      if (result.status === status) { record.status = status; record.latest_version = result.latest_version; }
    }
    writeOwned(directory, 'cache.json', record, 'check.lock', token);
  } catch { /* Never affect the caller's business operation. */ }
  finally { releaseLock(directory, 'check.lock', token); }
}

function createBackgroundUpdates({ mode = 'inline', environment = process.env, check = checkUpdate, now = Date.now, spawn = childProcess.spawn } = {}) {
  let pending = null;
  function start() {
    if (environment.ISINGQ_UPDATE_CHECK === 'off' || pending) return;
    let directory, token;
    try {
      if (!['inline', 'detached'].includes(mode)) return;
      directory = directoryFor(environment, true);
      if (!directory) return;
      const cached = readJson(directory, 'cache.json');
      if (cached && validCache(cached.value, now())) return;
      token = acquireLock(directory, 'check.lock', now());
      if (!token) return;
      // Another process may have finished between our first read and the lock.
      const completed = readJson(directory, 'cache.json');
      if (completed && validCache(completed.value, now())) {
        releaseLock(directory, 'check.lock', token);
        return;
      }
      if (mode === 'detached') {
        const child = spawn(process.execPath, [path.join(__dirname, 'update-worker.js'), token], {
          detached: true, stdio: 'ignore', windowsHide: true, env: workerEnvironment(environment),
        });
        child.once?.('error', () => releaseLock(directory, 'check.lock', token));
        child.unref();
      } else {
        pending = Promise.resolve().then(() => performCheck(directory, token, check, now)).catch(() => {}).finally(() => { pending = null; });
      }
    } catch { if (directory && token) releaseLock(directory, 'check.lock', token); }
  }
  function takeNotice() {
    if (environment.ISINGQ_UPDATE_CHECK === 'off') return null;
    let directory, token;
    try {
      directory = directoryFor(environment, false);
      if (!directory) return null;
      const cached = readJson(directory, 'cache.json');
      if (!cached || !validCache(cached.value, now()) || cached.value.status !== 'update_available') return null;
      token = acquireLock(directory, 'notice.lock', now());
      if (!token) return null;
      const latest = cached.value.latest_version;
      const previous = readJson(directory, 'notice.json')?.value;
      const validLedger = exactKeys(previous, ['schema', 'current_version', 'notices']) && previous.schema === SCHEMA
        && previous.current_version === CURRENT_VERSION && Array.isArray(previous.notices) && previous.notices.length <= 32
        && previous.notices.every(entry => exactKeys(entry, ['latest_version', 'noticed_at']) && validVersion(entry.latest_version) && timestamp(entry.noticed_at));
      const notices = validLedger ? previous.notices.filter(entry => fresh(entry.noticed_at, SUCCESS_TTL_MS, now())) : [];
      if (notices.some(entry => entry.latest_version === latest) || notices.length >= 32) return null;
      notices.push({ latest_version: latest, noticed_at: now() });
      if (!writeOwned(directory, 'notice.json', { schema: SCHEMA, current_version: CURRENT_VERSION, notices }, 'notice.lock', token)) return null;
      return { contract_version: 'isingq-update-notice-v1', package_name: '@ising-tech/isingq-mcp', current_version: CURRENT_VERSION,
        latest_version: latest, text: `IsingQ Toolkit ${latest} 已发布（当前 ${CURRENT_VERSION}）；可按安装方式手动升级。`,
        placement: 'after_primary_task_result', announce_check: false, requires_response: false, automatic_install: false };
    } catch { return null; }
    finally { if (directory && token) releaseLock(directory, 'notice.lock', token); }
  }
  return { start, takeNotice, waitForIdle: () => pending || Promise.resolve() };
}

async function runUpdateWorker(token, { environment = process.env, check = checkUpdate, now = Date.now } = {}) {
  if (environment.ISINGQ_UPDATE_CHECK === 'off' || typeof token !== 'string' || !TOKEN.test(token)) return;
  try {
    const directory = directoryFor(environment, false);
    if (directory) await performCheck(directory, token, check, now);
  } catch { /* Detached workers never print or change the main command's outcome. */ }
}

module.exports = { createBackgroundUpdates, runUpdateWorker };
