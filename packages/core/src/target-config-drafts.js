'use strict';
const { runWithCleanupSync } = require('./run-with-cleanup');

const fs = require('node:fs');
const { unlinkOwnedFileSync } = require('./owned-file');
const path = require('node:path');
const crypto = require('node:crypto');
const lifecycle = require('./target-config-lifecycle');
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 10;
const MAX_TOMBSTONES = 100;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_DRAFT_BYTES = 48 * 1024;
const ID = /^[a-f0-9]{32}$/;
const LIMITS = { name: 512, api_base_url: 4096, web_base_url: 4096, contract_text: 32768 };
class ManagerDraftError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function fail(status, code, message) { throw new ManagerDraftError(status, code, message); }
function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function fields(value, expected) { return object(value) && Object.keys(value).sort().join(',') === expected.slice().sort().join(','); }
function generation(value) { return Number.isSafeInteger(value) && value > 0; }
function normalize(input) {
  if (!fields(input, ['id', 'generation', 'mode', 'profile_id', 'profile_revision', 'values']) || !ID.test(input.id) || !generation(input.generation) || !['add', 'edit'].includes(input.mode) || !fields(input.values, Object.keys(LIMITS))) fail(400, 'draft_invalid', '草稿字段无效；仅支持编辑上下文id、generation、模式、原连接版本及四个文本字段，未备份');
  if (input.mode === 'add' ? input.profile_id !== null || input.profile_revision !== null : !/^local_[a-f0-9]{32}$/.test(input.profile_id) || !generation(input.profile_revision)) fail(400, 'draft_invalid', '草稿编辑来源与模式不匹配，未备份');
  const values = {};
  for (const [field, max] of Object.entries(LIMITS)) { if (typeof input.values[field] !== 'string' || input.values[field].length > max) fail(400, 'draft_too_large', `草稿文本超过字段上限（field=${field}, max_chars=${max}），未备份`); values[field] = input.values[field]; }
  const draft = { id: input.id, generation: input.generation, mode: input.mode, profile_id: input.profile_id, profile_revision: input.profile_revision, values };
  if (Buffer.byteLength(JSON.stringify(draft)) > MAX_DRAFT_BYTES) fail(413, 'draft_too_large', '单份草稿超过48KiB本机备份上限，未备份');
  return draft;
}
function privateStat(stat, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077))) fail(500, 'draft_store_unsafe', '草稿存储权限、所有者或文件类型不安全；未备份，请保留输入并核对本机私有目录');
}
class ManagerDraftStore {
  constructor({ configFile, clock = Date.now, ttlMs = DRAFT_TTL_MS, maxDrafts = MAX_DRAFTS, maxTombstones = MAX_TOMBSTONES } = {}) {
    if (![ttlMs, maxDrafts, maxTombstones].every(generation)) throw new Error('草稿保留期与容量必须为正安全整数');
    const file = lifecycle.canonicalConfigFile(configFile);
    this.directory = path.join(path.dirname(file), '.manager-drafts'); this.file = path.join(this.directory, 'drafts-v1.json'); this.lock = path.join(this.directory, 'write.lock');
    this.clock = clock; this.ttlMs = ttlMs; this.maxDrafts = maxDrafts; this.maxTombstones = maxTombstones;
  }
  directoryReady() { try { fs.mkdirSync(this.directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } privateStat(fs.lstatSync(this.directory), true); }
  load() {
    let fd;
    return runWithCleanupSync(() => {
      try {
        privateStat(fs.lstatSync(this.file)); fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const stat = fs.fstatSync(fd); privateStat(stat);
        if (stat.size > MAX_STORE_BYTES) fail(500, 'draft_store_invalid', '草稿文件超过1MiB上限，请保留原文件并核对；未覆盖备份');
        const buffer = Buffer.alloc(MAX_STORE_BYTES + 1); let bytes = 0;
        while (bytes <= MAX_STORE_BYTES) { const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null); if (!count) break; bytes += count; }
        let data; try { data = JSON.parse(buffer.subarray(0, bytes).toString('utf8')); } catch (_) { fail(500, 'draft_store_invalid', '草稿文件损坏，请保留原文件；不能声称可恢复，未覆盖备份'); }
        if (bytes > MAX_STORE_BYTES || !fields(data, ['version', 'drafts', 'tombstones']) || data.version !== 1 || !Array.isArray(data.drafts) || data.drafts.length > this.maxDrafts || !Array.isArray(data.tombstones) || data.tombstones.length > this.maxTombstones) fail(500, 'draft_store_invalid', '草稿文件版本、结构或容量不兼容；请保留并核对');
        const seen = new Set();
        for (const draft of data.drafts) {
          if (!fields(draft, ['id', 'generation', 'mode', 'profile_id', 'profile_revision', 'values', 'updated_at', 'expires_at'])) fail(500, 'draft_store_invalid', '草稿文件字段不兼容，请保留并核对');
          try { normalize({ id: draft.id, generation: draft.generation, mode: draft.mode, profile_id: draft.profile_id, profile_revision: draft.profile_revision, values: draft.values }); } catch (_) { fail(500, 'draft_store_invalid', '草稿文件包含无效字段，请保留并核对'); }
          if (seen.has(draft.id) || !Number.isFinite(Date.parse(draft.updated_at)) || !Number.isFinite(Date.parse(draft.expires_at))) fail(500, 'draft_store_invalid', '草稿身份或保留时间无效，请保留并核对'); seen.add(draft.id);
        }
        for (const tombstone of data.tombstones) { if (!fields(tombstone, ['id', 'generation', 'expires_at']) || !ID.test(tombstone.id) || !generation(tombstone.generation) || !Number.isFinite(tombstone.expires_at) || seen.has(tombstone.id)) fail(500, 'draft_store_invalid', '草稿清理保护记录无效，请保留并核对'); seen.add(tombstone.id); }
        return data;
      } catch (error) { if (error.code === 'ENOENT') return { version: 1, drafts: [], tombstones: [] }; throw error; }
    }, () => {
      if (fd !== undefined) fs.closeSync(fd);
    });
  }
  prune(data) {
    const now = this.clock(); data.tombstones = data.tombstones.filter(row => row.expires_at > now);
    const expired = data.drafts.filter(row => Date.parse(row.expires_at) <= now);
    if (data.tombstones.length + expired.length > this.maxTombstones) fail(409, 'draft_tombstone_capacity', '草稿清理保护记录已满；保留现有备份，请稍后重试，不能丢弃晚到写入保护');
    for (const row of expired) data.tombstones.push({ id: row.id, generation: row.generation, expires_at: now + this.ttlMs });
    data.drafts = data.drafts.filter(row => Date.parse(row.expires_at) > now);
  }
  write(data) {
    const text = JSON.stringify(data) + '\n'; if (Buffer.byteLength(text) > MAX_STORE_BYTES) fail(413, 'draft_store_too_large', '草稿存储超过1MiB上限，未备份');
    const temporary = this.file + '.tmp-' + crypto.randomUUID(); let fd, created = false;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      fs.writeFileSync(fd, text); fs.fsyncSync(fd);
      const ownedFd = fd; fd = undefined; fs.closeSync(ownedFd);
      fs.renameSync(temporary, this.file); created = false;
    } finally {
      if (fd !== undefined) { const ownedFd = fd; fd = undefined; try { fs.closeSync(ownedFd); } catch (_) {} }
      if (created) { try { fs.unlinkSync(temporary); } catch (_) {} }
    }
  }
  transaction(work) {
    let fd, identity, primaryError, cleanupError, result, primaryFailed = false, cleanupFailed = false;
    try {
      this.directoryReady();
      try { fd = fs.openSync(this.lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') fail(409, 'draft_store_busy', '其他管理入口正在写草稿；本次未备份，请保留输入后重试。异常退出遗留锁需核实后清理'); throw e; }
      identity = fs.fstatSync(fd);
      const data = this.load(); this.prune(data); result = work(data); this.write(data);
    } catch (e) {
      primaryFailed = true;
      primaryError = e instanceof ManagerDraftError ? e : new ManagerDraftError(500, 'draft_store_io_error', `本机草稿读写失败（fs_code=${typeof e?.code === 'string' && /^[A-Z0-9_]+$/.test(e.code) ? e.code : 'unknown'}）；本次未备份，请保留输入并检查目录权限/磁盘空间`);
    } finally {
      if (fd !== undefined) {
        if (!identity) { try { identity = fs.fstatSync(fd); } catch (error) { cleanupFailed = true; cleanupError = error; } }
        const ownedFd = fd; fd = undefined; try { fs.closeSync(ownedFd); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
      }
      try { unlinkOwnedFileSync(this.lock, identity); } catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupError = error; } }
    }
    if (primaryFailed) throw primaryError;
    if (cleanupFailed) throw cleanupError;
    return result;
  }
  list() { return this.transaction(data => ({ drafts: data.drafts.map(({ id, generation, updated_at, expires_at, mode, profile_id, profile_revision, values }) => ({ id, generation, updated_at, expires_at, mode, profile_id, profile_revision, name: values.name })) })); }
  get(id) { if (!ID.test(id)) fail(404, 'draft_not_found', '未找到该本机草稿'); return this.transaction(data => { const draft = data.drafts.find(row => row.id === id); if (!draft) fail(404, 'draft_not_found', '草稿已清理或过期，不能声称仍可恢复'); return { draft: structuredClone(draft) }; }); }
  save(input) {
    const value = normalize(input);
    return this.transaction(data => {
      if (data.tombstones.some(row => row.id === value.id)) fail(409, 'draft_deleted', '该编辑上下文已清理；晚到备份不会复活它，请使用新的编辑上下文id');
      const index = data.drafts.findIndex(row => row.id === value.id), old = data.drafts[index];
      if (old && (value.generation < old.generation || value.generation === old.generation && JSON.stringify(value) !== JSON.stringify(normalize({ id: old.id, generation: old.generation, mode: old.mode, profile_id: old.profile_id, profile_revision: old.profile_revision, values: old.values })))) fail(409, 'draft_generation_conflict', '草稿已由较新输入更新；未覆盖其他页签内容，请先核对原草稿');
      if (old && value.generation === old.generation) return { draft: structuredClone(old) };
      if (!old && data.drafts.length >= this.maxDrafts) fail(409, 'draft_capacity', `最多保留${this.maxDrafts}份未保存草稿；本次未备份，请明确恢复或忽略旧草稿后重试`);
      const now = this.clock(), draft = { ...value, updated_at: new Date(now).toISOString(), expires_at: new Date(now + this.ttlMs).toISOString() };
      if (old) data.drafts[index] = draft; else data.drafts.push(draft); return { draft: structuredClone(draft) };
    });
  }
  delete(id, input) {
    if (!ID.test(id) || !fields(input, ['generation']) || !generation(input.generation)) fail(400, 'draft_invalid', '清理草稿仅接受id及正整数generation');
    return this.transaction(data => {
      const draft = data.drafts.find(row => row.id === id), old = data.tombstones.find(row => row.id === id), previous = draft || old;
      if (previous && input.generation < previous.generation) fail(409, 'draft_generation_conflict', '该草稿已有较新一代；未清理其他页签的新内容');
      if (!old && data.tombstones.length >= this.maxTombstones) fail(409, 'draft_tombstone_capacity', '草稿清理保护已满；未丢弃晚到写入保护，请稍后重试');
      data.drafts = data.drafts.filter(row => row.id !== id);
      if (!old) data.tombstones.push({ id, generation: input.generation, expires_at: this.clock() + this.ttlMs });
      else if (input.generation > old.generation) { old.generation = input.generation; old.expires_at = this.clock() + this.ttlMs; }
      return { deleted: true, id, generation: input.generation };
    });
  }
}
module.exports = { ManagerDraftStore, ManagerDraftError, DRAFT_TTL_MS, MAX_DRAFTS, MAX_TOMBSTONES, MAX_DRAFT_BYTES };
