'use strict';
const { runWithCleanupSync } = require('./run-with-cleanup');

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileLimit, fileLimitHint } = require('./file-limits');

// Persisted QUBO JSON is larger than the uploaded CSV. Share one byte limit
// across writing, lookup, polling and archival; legacy records need no migration.
const MAX_API_KEY_BYTES = 64 * 1024;
const MAX_SUBMISSION_RECEIPT_BYTES = 4096;
const RUN_FILE = /^solve_[a-f0-9]{32}\.json$/;

function receiptPersistence(status) {
  return {
    status,
    instructions: status === 'receipt_only'
      ? '提供方已受理，完整记录写入失败。已单独保存任务回执，可用原 solve_id 查询并恢复完整记录。'
      : '提供方已受理，任务回执未能落盘。保留 solve_id 和 provider_task_id，并用提供方任务号在原服务核查。禁止重提。',
  };
}

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
  let created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, content);
    const ownedFd = descriptor;
    descriptor = undefined;
    fs.closeSync(ownedFd);
    fs.renameSync(temporary, file);
    created = false;
  } catch (error) {
    throw new SolveStoreError('solve_record_io_error', `求解记录写入失败；请检查目录权限和磁盘空间并核对原任务状态（path=${file}, fs_code=${error.code || 'unknown'}）`);
  } finally {
    if (descriptor !== undefined) {
      const ownedFd = descriptor;
      descriptor = undefined;
      try { fs.closeSync(ownedFd); } catch { /* Preserve the write or close error. */ }
    }
    if (created) {
      try { fs.unlinkSync(temporary); } catch { /* Preserve the write error and original record. */ }
    }
  }
}

function readJson(file, label, maxBytes) {
  let descriptor;
  return runWithCleanupSync(() => {
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
      if (error.code === 'ENOENT') {
        throw new SolveStoreError('solve_record_not_found', `未找到本地求解记录（solve_id=${path.basename(file, '.json')}）；请核对任务 ID 和原任务所在设备/运行时的历史记录；poll/get 无法恢复缺失记录，不要因此重新提交任务。`);
      }
      throw new SolveStoreError('solve_record_io_error', `${label} 无法读取；请检查文件存在、访问权限并保留历史记录（path=${file}, fs_code=${error.code || 'unknown'}）`);
    }
  }, () => {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  });
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
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`拒绝写入 API Key 符号链接（path=${file}）`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${normalized}\n`);
    const ownedFd = descriptor;
    descriptor = undefined;
    fs.closeSync(ownedFd);
    fs.renameSync(temporary, file);
    created = false;
  } catch (error) {
    throw new Error(`API Key 文件写入失败；请检查目录权限和磁盘空间（path=${file}, fs_code=${error.code || 'unknown'}）`);
  } finally {
    if (descriptor !== undefined) {
      const ownedFd = descriptor;
      descriptor = undefined;
      try { fs.closeSync(ownedFd); } catch { /* Preserve the write error and existing key. */ }
    }
    if (created) {
      try { fs.unlinkSync(temporary); } catch { /* Preserve the write error and existing key. */ }
    }
  }
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
    return this.restoreSubmissionReceipt(readJson(this.path(id), '求解记录', this.maxRecordBytes));
  }

  submissionReceiptPath(id) {
    return path.join(this.directory, '.submission-receipts', path.basename(this.path(id)));
  }

  saveSubmissionReceipt(run) {
    const { solve_id, idempotency_digest, request_digest, provider_task_id, submitted_at } = run;
    atomicJson(this.submissionReceiptPath(solve_id), {
      solve_id, idempotency_digest, request_digest, provider_task_id, submitted_at,
    }, MAX_SUBMISSION_RECEIPT_BYTES);
  }

  findSubmissionReceipt(run) {
    // Only the interrupted reservation can use the supplemental receipt.
    // A later full write (including poll) always has precedence.
    if (run.status !== 'submitting' || run.provider_task_id) return null;
    let receipt;
    try {
      receipt = readJson(this.submissionReceiptPath(run.solve_id), '求解回执', MAX_SUBMISSION_RECEIPT_BYTES);
    } catch (error) {
      if (error.code === 'solve_record_not_found') return null;
      throw error;
    }
    if (receipt.request_digest !== run.request_digest || receipt.idempotency_digest !== run.idempotency_digest
      || typeof receipt.provider_task_id !== 'string' || !receipt.provider_task_id.trim() || receipt.provider_task_id.length > 200
      || typeof receipt.submitted_at !== 'string' || !Number.isFinite(Date.parse(receipt.submitted_at))) {
      throw new SolveStoreError('solve_receipt_invalid', `任务回执与本地占位不匹配；请保留记录并用原 solve_id 核查（solve_id=${run.solve_id}）`);
    }
    return receipt;
  }

  restoreSubmissionReceipt(run, receipt = this.findSubmissionReceipt(run)) {
    if (!receipt) return run;
    return {
      ...run, status: 'submitted', submission_outcome: 'created',
      ...(run.stage === 'create' ? { stage: 'poll' } : {}),
      provider_task_id: receipt.provider_task_id, submitted_at: receipt.submitted_at, updated_at: receipt.submitted_at,
      receipt_persistence: receiptPersistence('receipt_only'),
    };
  }

  list({ limit = 100, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      throw new SolveStoreError('solve_list_invalid', '记录列表limit须为1到1000、offset须为非负整数');
    }
    const names = fs.readdirSync(this.directory).filter(name => RUN_FILE.test(name));
    if (names.length > 10000) throw new SolveStoreError('solve_list_too_large', '记录超过10000条；请由维护者备份整理，不要删除在途记录或重提任务');
    const ordered = names.map(name => ({ name, modified: fs.lstatSync(path.join(this.directory, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    return { records: ordered.slice(offset, offset + limit).map(({ name }) => this.get(path.basename(name, '.json'))),
      total: names.length, next_offset: offset + limit < names.length ? offset + limit : null };
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

  submissionRecordNames() {
    const names = fs.readdirSync(this.directory).filter(name => RUN_FILE.test(name));
    if (names.length > 10000) {
      throw new Error(`求解记录超过安全扫描上限，已停止提交以避免重复任务；请先备份并整理记录（path=${this.directory}, count=${names.length}, limit=10000）`);
    }
    return names;
  }

  scanSubmission(digest, matchesUnresolved, previous) {
    // The snapshot is scoped to one start across asynchronous preparation.
    // Every pass checks the live filenames and file versions. Atomic record
    // replacement, addition and in-place modification invalidate old decisions.
    const snapshot = new Map(), selected = {};
    let scanError;
    for (const name of this.submissionRecordNames()) {
      const file = path.join(this.directory, name);
      let fingerprint;
      try {
        const stat = fs.lstatSync(file, { bigint: true });
        fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.ctimeNs}:${stat.mtimeNs}`;
      } catch (_) {
        // Let the normal reader give the specific, redacted storage error.
      }
      let record, match = fingerprint && previous?.snapshot.get(name);
      let receipt;
      try {
        if (!match || match.fingerprint !== fingerprint) {
          record = readJson(file, '求解记录', this.maxRecordBytes);
          match = { fingerprint, key: record.idempotency_digest === digest, archived: Boolean(record.archived_at),
            archivedAt: typeof record.archived_at === 'string' ? Date.parse(record.archived_at) || 0 : 0,
            unresolved: matchesUnresolved(record) };
          if (record.status === 'submitting' && !record.provider_task_id && (match.key || match.unresolved)) {
            const { solve_id, request_digest, idempotency_digest, status } = record;
            match.receiptBinding = { solve_id, request_digest, idempotency_digest, status };
          }
        }
        // A receipt may be published while its reservation stays unchanged.
        receipt = match.receiptBinding ? this.findSubmissionReceipt(match.receiptBinding) : null;
      } catch (error) {
        // A verified active record can still be read by its original key.
        // Propagate this error before any new reservation.
        scanError ||= error;
        continue;
      }
      snapshot.set(name, match);
      const current = { name, match, record, receipt };
      if (match.key && (!selected.existing || (selected.existing.match.archived && (!match.archived || match.archivedAt > selected.existing.match.archivedAt)))) {
        selected.existing = current;
      }
      if (match.unresolved && !receipt && !selected.unresolved) selected.unresolved = current;
    }
    const result = { snapshot, raw: {}, scanError };
    for (const kind of ['existing', 'unresolved']) {
      const current = selected[kind];
      if (!current) continue;
      // A damaged file could be the active run for an archived match.
      if (kind === 'existing' && scanError && current.match.archived) continue;
      const id = path.basename(current.name, '.json');
      const cached = [previous?.raw?.existing, previous?.raw?.unresolved].find(run => run?.solve_id === id);
      // Keep full objects only for the selected key and unresolved matrix.
      // Another candidate is loaded only if it becomes selected after a change.
      const raw = current.record || (current.match.fingerprint && previous?.snapshot.get(current.name) === current.match && cached)
        || readJson(this.path(id), '求解记录', this.maxRecordBytes);
      result.raw[kind] = raw;
      result[kind] = result.existing?.solve_id === id ? result.existing : this.restoreSubmissionReceipt(raw, current.receipt);
    }
    return result;
  }

  findByIdempotency(digest, { includeArchived = false } = {}) {
    let archived = null, scanError;
    for (const name of this.submissionRecordNames()) {
      const id = path.basename(name, '.json');
      let run;
      try { run = readJson(this.path(id), '求解记录', this.maxRecordBytes); }
      catch (error) { scanError ||= error; continue; }
      if (run.idempotency_digest !== digest) continue;
      if (!run.archived_at) return this.restoreSubmissionReceipt(run);
      if (!archived || run.archived_at > archived.archived_at) archived = run;
    }
    // A known active record can be read above. Without that match, unreadable
    // history prevents treating the key as absent or using an archived attempt.
    if (scanError) throw scanError;
    return includeArchived && archived ? this.restoreSubmissionReceipt(archived) : null;
  }
}

module.exports = { SolveStore, SolveStoreError, apiKey, roots, saveApiKey, receiptPersistence };
