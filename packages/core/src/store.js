'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileLimit, fileLimitHint } = require('./file-limits');

// Persisted QUBO JSON is larger than the uploaded CSV. Share one byte limit
// across writing, lookup, polling and archival; legacy records need no migration.
const MAX_API_KEY_BYTES = 64 * 1024;

class SolveStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function checkRecordSize(file, bytes, maxBytes) {
  if (bytes > maxBytes) {
    throw new SolveStoreError('solve_record_too_large', `求解记录超过读写上限；已停止操作以保留幂等检查，请保留原文件（path=${file}, bytes=${bytes}, max_bytes=${maxBytes}）；${fileLimitHint('record')}`);
  }
}

function validateRecord(value, file) {
  // Do not skip syntactically valid records whose occupancy cannot be checked.
  // Older records may omit recovery fields; leave those decisions to core.
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || typeof value.solve_id !== 'string' || `${value.solve_id}.json` !== path.basename(file)
    || typeof value.idempotency_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.idempotency_digest)
    || typeof value.request_digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_digest)) {
    throw new SolveStoreError('solve_record_invalid', `求解记录结构无效或幂等字段缺失；请保留原文件并从备份核对恢复，不要删除记录后重提（path=${file}）`);
  }
  return value;
}

function roots(environment = process.env, platform = process.platform) {
  const home = environment.HOME || environment.USERPROFILE || os.homedir();
  const config = platform === 'win32'
    ? (environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : (environment.XDG_CONFIG_HOME || path.join(home, '.config'));
  const data = platform === 'win32'
    ? (environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : (environment.XDG_DATA_HOME || path.join(home, '.local', 'share'));
  return {
    config: path.join(config, 'isingq-mcp'),
    data: path.join(data, 'isingq-mcp'),
  };
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function atomicJson(file, value, maxBytes) {
  validateRecord(value, file);
  const content = `${JSON.stringify(value)}\n`;
  checkRecordSize(file, Buffer.byteLength(content, 'utf8'), maxBytes);
  privateDirectory(path.dirname(file));
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  let descriptor;
  let pending = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    pending = true;
    fs.writeFileSync(descriptor, content);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    pending = false;
  } catch (error) {
    throw new SolveStoreError('solve_record_io_error', `求解记录写入失败；请检查目录权限和磁盘空间并核对原任务状态（path=${file}, fs_code=${error.code || 'unknown'}）`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (pending) fs.unlinkSync(temporary);
  }
}

function readJson(file, label, maxBytes) {
  let descriptor;
  try {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SolveStoreError('solve_record_unsafe', `${label} 必须为普通文件，拒绝符号链接或目录；请核对记录路径（path=${file}）`);
    }
    checkRecordSize(file, metadata.size, maxBytes);
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new SolveStoreError('solve_record_unsafe', `${label} 不是普通文件；请核对记录路径（path=${file}）`);
    checkRecordSize(file, opened.size, maxBytes);
    // Bound actual bytes too: a file may grow after the metadata check.
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(4096, opened.size + 1)));
    let bytes = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, maxBytes + 1 - bytes), null);
      if (!count) break;
      bytes += count;
      checkRecordSize(file, bytes, maxBytes);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
    catch (_) {
      // JSON parser messages can contain the original private record content.
      throw new SolveStoreError('solve_record_invalid', `${label} 不是有效 JSON；请保留原文件并从备份核对恢复（path=${file}）`);
    }
    return validateRecord(value, file);
  } catch (error) {
    if (error instanceof SolveStoreError) throw error;
    throw new SolveStoreError('solve_record_io_error', `${label} 无法读取；请检查文件存在、访问权限并保留历史记录（path=${file}, fs_code=${error.code || 'unknown'}）`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function apiKey(environment = process.env) {
  const injected = environment.ISINGQ_API_KEY;
  if (typeof injected === 'string' && injected.trim()) return injected.trim();
  const file = path.join(roots(environment).config, 'api-key');
  try {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_API_KEY_BYTES) throw new Error();
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!value || /\s/.test(value)) throw new Error();
    return value;
  } catch (_) {
    throw new Error('IsingQ API Key 未配置；请运行 isingq_api_key_setup 工具或 isingq-mcp setup');
  }
}

function saveApiKey(value, environment = process.env) {
  const normalized = String(value || '').trim();
  if (!normalized || /\s/.test(normalized)) throw new Error('IsingQ API Key 不能为空或包含空白');
  const bytes = Buffer.byteLength(`${normalized}\n`, 'utf8');
  if (bytes > MAX_API_KEY_BYTES) throw new Error(`API Key 文件超过 64 KiB；请核对输入是否为单个 Key（bytes=${bytes}, max_bytes=${MAX_API_KEY_BYTES}）`);
  const directory = roots(environment).config;
  privateDirectory(directory);
  const file = path.join(directory, 'api-key');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`拒绝写入 API Key 符号链接（path=${file}）`);
  }
  fs.writeFileSync(file, `${normalized}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

class SolveStore {
  constructor(environment = process.env) {
    this.maxRecordBytes = fileLimit('record', environment);
    this.directory = path.join(roots(environment).data, 'runs');
    privateDirectory(this.directory);
  }

  path(id) {
    if (typeof id !== 'string' || !/^solve_[a-f0-9]{32}$/.test(id)) throw new Error('solve_id 格式无效');
    return path.join(this.directory, `${id}.json`);
  }

  save(run) {
    atomicJson(this.path(run.solve_id), run, this.maxRecordBytes);
    return run;
  }

  get(id) {
    return readJson(this.path(id), '求解记录', this.maxRecordBytes);
  }

  archive(run) {
    const archived = { ...run, archived_at: new Date().toISOString() };
    try {
      this.save(archived);
    } catch (error) {
      throw new Error(`归档失败，已停止重新提交；请检查求解记录目录权限、磁盘空间和记录大小（solve_id=${run.solve_id}, path=${this.directory}）${error instanceof SolveStoreError ? `；${error.message}` : ''}`);
    }
    return archived;
  }

  findByIdempotency(digest, { includeArchived = false } = {}) {
    let archived = null;
    const names = fs.readdirSync(this.directory).filter((name) => /^solve_[a-f0-9]{32}\.json$/.test(name));
    if (names.length > 10000) {
      throw new Error(`求解记录超过安全扫描上限，已停止提交以避免重复任务；请先备份并整理记录（path=${this.directory}, count=${names.length}, limit=10000）`);
    }
    for (const name of names) {
      const run = readJson(path.join(this.directory, name), '求解记录', this.maxRecordBytes);
      if (run.idempotency_digest !== digest) continue;
      if (!run.archived_at) return run;
      archived = run;
    }
    return includeArchived ? archived : null;
  }
}

module.exports = { SolveStore, SolveStoreError, apiKey, roots, saveApiKey };
