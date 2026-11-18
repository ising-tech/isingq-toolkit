'use strict';
const { runWithCleanup } = require('./run-with-cleanup');

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { constants } = require('node:buffer');
const { WorkspaceArtifacts } = require('./workspace');
const { MathModelError, fields, verificationCapacity } = require('./math-model');
const STRING_BYTES = constants.MAX_STRING_LENGTH - 1;
const CHUNK_BYTES = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (code, location, message) => { throw new MathModelError(code, location, message); };
const SHA = /^[a-f0-9]{64}$/;
function descriptor(value, location, absolute = false) {
  fields(value, [absolute ? 'manifest_path' : 'path', absolute ? 'content_digest' : 'sha256'], [], location);
  const name = value[absolute ? 'manifest_path' : 'path'], digest = value[absolute ? 'content_digest' : 'sha256'];
  if (typeof name !== 'string' || !name || /[\x00-\x1f\x7f]/.test(name) || (!absolute && name.includes('\\')) || typeof digest !== 'string' || !SHA.test(digest)) fail('review_file_invalid', location, '需要实际文件路径及完整小写SHA256；沿用文件导出回执，不在对话中手填');
  if (absolute ? !path.isAbsolute(name) : path.isAbsolute(name) || path.win32.isAbsolute(name) || name.split('/').some(p => p === '..' || /[:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    fail('review_file_unsafe', location, absolute ? 'manifest_path须为运行主机上的绝对路径' : '引用须在清单目录内，不能包含绝对路径、上级目录或不可移植文件名');
  }
  return name;
}
function parseCanonical(buffer, location) {
  let text, value;
  try { text = decoder.decode(buffer); value = JSON.parse(text); }
  catch (_) { fail('review_file_json_invalid', location, '文件不是有效UTF-8 JSON；请从原模型重新导出，不回显原始内容'); }
  if (JSON.stringify(value) !== text) fail('review_file_json_invalid', location, '文件须使用紧凑规范JSON；拒绝重复键、非规范数值或转义。请使用文件导出器重新生成');
  return value;
}

class ReviewFileSession {
  constructor(file, capacity = verificationCapacity()) {
    const absolute = descriptor(file, 'review_file', true);
    try { this.workspace = new WorkspaceArtifacts({ root: path.dirname(absolute), round: 1, environment: {} }); }
    catch (_) { fail('review_file_unsafe', 'review_file', `清单目录不可安全读取（path=${path.dirname(absolute)}）；检查目录与符号链接`); }
    this.file = { path: path.basename(absolute), sha256: file.content_digest };
    this.capacity = capacity; this.bytes = 0; this.active = new Set(); this.sources = []; this.maxLineBytes = 0;
  }
  charge(bytes) {
    this.bytes += bytes;
    if (!Number.isSafeInteger(this.bytes) || this.bytes > this.capacity.max_input_bytes) fail('unsupported_size', 'verification.input_bytes',
      `完整核验输入超过容量（bytes_at_least=${this.bytes}, max_input_bytes=${this.capacity.max_input_bytes}, setting=${this.capacity.setting}）；保留原模型与候选，调整核验进程资源后重试，不删约束或重新求解`);
  }
  checkedPath(ref) {
    const name = descriptor(ref, 'review_file.source');
    try { return this.workspace.check(path.join(this.workspace.root, name), false, true); }
    catch (_) { fail('review_file_unsafe', 'review_file.source', `拒绝重定向或不安全文件（path=${name}）；引用必须是清单目录内的普通文件`); }
  }
  async read(ref, consumer, { whole = false, finish } = {}) {
    const name = this.checkedPath(ref); let handle, key, registered = false;
    await runWithCleanup(async () => {
      try {
        handle = await fs.promises.open(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const before = await handle.stat();
        if (!before.isFile() || !Number.isSafeInteger(before.size)) fail('review_file_unsafe', 'review_file.source', `源文件必须是普通文件（path=${name}）`);
        this.checkedPath(ref); const actual = fs.lstatSync(name);
        if (actual.ino !== before.ino || actual.dev !== before.dev) fail('review_file_changed', 'review_file.source', `打开时文件已替换（path=${name}）`);
        key = `${before.dev}:${before.ino}`;
        if (this.active.has(key)) fail('review_file_cycle', 'review_file.source', `文件引用循环（path=${name}）；检查清单与表达式来源`);
        this.active.add(key); registered = true;
        if (this.bytes + before.size > this.capacity.max_input_bytes) fail('unsupported_size', 'verification.input_bytes',
          `完整核验输入超过容量（bytes_at_least=${this.bytes + before.size}, max_input_bytes=${this.capacity.max_input_bytes}, setting=${this.capacity.setting}）；保留原输入，不删约束或重新求解`);
        if (whole && before.size > STRING_BYTES) fail('review_file_metadata_too_large', 'review_file.manifest', `清单元数据超过当前字符串容量（bytes=${before.size}, max_bytes=${STRING_BYTES}）；将表达式或约束移到分块文件`);
        const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(CHUNK_BYTES); let bytes = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          this.charge(bytesRead); bytes += bytesRead; hash.update(buffer.subarray(0, bytesRead));
          await consumer(buffer.subarray(0, bytesRead));
        }
        if (finish) await finish();
        const after = await handle.stat(); this.checkedPath(ref); const current = fs.lstatSync(name);
        if (before.size !== bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || current.ino !== before.ino || current.dev !== before.dev) fail('review_file_changed', 'review_file.source', `读取期间源文件发生变化（path=${name}）；保留原任务并重新导出`);
        const observed = hash.digest('hex');
        if (observed !== ref.sha256) fail('review_file_digest_mismatch', 'review_file.source', `源文件摘要不符（path=${name}, expected=${ref.sha256}）；未完成核验，不回显其他文件的实际摘要，也不自动采用新文件`);
        this.sources.push({ path: name, sha256: observed, size_bytes: bytes });
      } catch (error) {
        if (error instanceof MathModelError) throw error;
        fail('review_file_unavailable', 'review_file.source', `无法读取源文件（path=${name}, fs_code=${typeof error.code === 'string' ? error.code : 'unknown'}）；检查文件存在、权限与磁盘状态`);
      }
    }, async () => {
      if (registered) this.active.delete(key);
    }, async () => {
      if (handle) await handle.close();
    });
  }
  async manifest() {
    const chunks = [];
    await this.read(this.file, chunk => { chunks.push(Buffer.from(chunk)); }, { whole: true });
    let content = Buffer.concat(chunks);
    if (content.at(-1) === 10) content = content.subarray(0, content.length - 1);
    return parseCanonical(content, 'review_file.manifest');
  }
  async rows(ref, consumer) {
    let pieces = [], length = 0, line = 0;
    const record = async chunk => {
      const size = length + chunk.length;
      if (size > STRING_BYTES) fail('review_file_record_too_large', 'review_file.source', `单条记录超过运行时字符串容量（line=${line + 1}, max_bytes=${STRING_BYTES}）；每行只放一项或一个约束，较大的表达式使用terms_file`);
      const data = pieces.length ? Buffer.concat([...pieces, chunk], size) : chunk;
      this.maxLineBytes = Math.max(this.maxLineBytes, size);
      const value = parseCanonical(data, `review_file.source.line${++line}`);
      pieces = []; length = 0;
      const pending = consumer(value, line);
      if (pending?.then) await pending;
    };
    await this.read(ref, async chunk => {
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) !== -1) { await record(chunk.subarray(start, end)); start = end + 1; }
      if (start < chunk.length) {
        const part = chunk.subarray(start); length += part.length;
        if (length > STRING_BYTES) fail('review_file_record_too_large', 'review_file.source', `单条记录超过运行时字符串容量（line=${line + 1}, max_bytes=${STRING_BYTES}）`);
        pieces.push(Buffer.from(part));
      }
    }, { finish: async () => { if (length) await record(Buffer.alloc(0)); } });
    return line;
  }
}

class ReviewChecksWriter {
  constructor(parent) {
    const workspace = new WorkspaceArtifacts({ root: parent, round: 1, environment: {} });
    this.directory = fs.mkdtempSync(path.join(workspace.root, 'file-review-'));
    this.path = path.join(this.directory, 'checks.jsonl');
    try {
      this.hash = crypto.createHash('sha256'); this.fd = fs.openSync(this.path, 'wx', 0o600);
      this.bytes = 0; this.parts = []; this.buffered = 0;
    } catch(error) {
      if(this.fd!==undefined) {
        const ownedFd=this.fd; this.fd=undefined;
        try { fs.closeSync(ownedFd); } catch(_) {}
        try { fs.unlinkSync(this.path); } catch(_) {}
      }
      // rmdir handles the empty-directory case without opening another fd, and
      // deliberately preserves any unexpected file we did not create.
      try { fs.rmdirSync(this.directory); } catch(_) {}
      throw error;
    }
  }
  append(value) {
    const line = JSON.stringify(value) + '\n'; this.parts.push(line); this.buffered += Buffer.byteLength(line);
    if (this.buffered >= CHUNK_BYTES) this.flush();
  }
  flush() {
    if (!this.parts.length) return;
    const data = Buffer.from(this.parts.join('')); fs.writeFileSync(this.fd, data); this.hash.update(data); this.bytes += data.length;
    this.parts = []; this.buffered = 0;
  }
  complete() {
    this.flush();
    const ownedFd=this.fd; this.fd=undefined;
    try { fs.closeSync(ownedFd); }
    catch(error) { try { fs.rmSync(this.directory,{recursive:true,force:true}); } catch(_) {} throw error; }
    return { path: this.path, content_digest: this.hash.digest('hex'), size_bytes: this.bytes };
  }
  discard() {
    let cleanupError;
    if (this.fd !== undefined) { const ownedFd=this.fd; this.fd=undefined; try { fs.closeSync(ownedFd); } catch(error) { cleanupError=error; } }
    try { fs.rmSync(this.directory, { recursive: true, force: true }); } catch(error) { if(!cleanupError) cleanupError=error; }
    if(cleanupError) throw cleanupError;
  }
}
module.exports = { ReviewFileSession, ReviewChecksWriter, parseCanonical, descriptor, CHUNK_BYTES };
