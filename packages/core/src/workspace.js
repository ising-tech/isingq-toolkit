'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_CONTRACT_VERSION = 'isingq-workspace-v1';
const CATEGORIES = ['tmp', 'logs', 'output'];

class WorkspaceError extends Error {
  constructor(code, message, context, hint) {
    super(message);
    this.code = code;
    this.context = context;
    this.hint = hint;
  }
}

/** Local artifact paths only. This is not a shell runner or an OS sandbox. */
class WorkspaceArtifacts {
  constructor({ root, round } = {}) {
    this.root = root;
    this.round = round;
    if (typeof root !== 'string' || !root || /[\x00-\x1f\x7f]/.test(root) || !path.isAbsolute(root)) {
      this.fail('workspace_root_invalid', 'root 必须是显式指定的已存在目录绝对路径', { root });
    }
    if (!Number.isSafeInteger(round) || round < 1) {
      this.fail('workspace_round_invalid', 'round 必须是 1 到 Number.MAX_SAFE_INTEGER 的整数', { round });
    }
    const normalized = path.resolve(root);
    try {
      const metadata = fs.lstatSync(normalized);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        this.fail('workspace_root_invalid', 'root 必须是普通目录，不能是符号链接', { root: normalized });
      }
      this.root = fs.realpathSync(normalized);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      this.fail('workspace_root_unavailable', '无法读取 root；请先创建目录并检查访问权限', { root: normalized, fs_code: error.code });
    }
    this.roundDirectory = path.join(this.root, `round${round}`);
  }

  fail(code, message, context = {}) {
    throw new WorkspaceError(code, `${message}（root=${this.root}, round=${this.round}${context.path ? `, path=${context.path}` : ''}）`,
      { root: this.root, round: this.round, ...context }, '使用显式已存在的工作根、正整数轮次和本轮 tmp/、logs/、output/ 下的相对路径；检查目录权限并移除路径中的符号链接后重试。');
  }

  // Check every existing component. Never follow a symlink, including a dangling one.
  check(target, createDirectories = false, leafIsFile = false) {
    const relative = path.relative(this.root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      this.fail('artifact_path_invalid', '产物路径必须位于工作根内', { path: target });
    }
    try {
      const rootMetadata = fs.lstatSync(this.root);
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || fs.realpathSync(this.root) !== this.root) {
        this.fail('artifact_path_unsafe', '工作根已被替换或重定向', { path: this.root });
      }
      const components = relative.split(path.sep);
      let current = this.root;
      for (let i = 0; i < components.length; i++) {
        current = path.join(current, components[i]);
        const isFile = leafIsFile && i === components.length - 1;
        let metadata;
        try { metadata = fs.lstatSync(current); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          if (createDirectories && !isFile) {
            try { fs.mkdirSync(current, { mode: 0o700 }); }
            catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
            metadata = fs.lstatSync(current);
          } else continue;
        }
        if (metadata.isSymbolicLink() || (!isFile && !metadata.isDirectory()) || (isFile && !metadata.isFile())) {
          this.fail('artifact_path_unsafe', '拒绝符号链接或类型不匹配的路径节点', { path: current });
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      this.fail('artifact_io_error', '无法检查或创建产物目录；请检查目录权限与磁盘状态', { path: target, fs_code: error.code });
    }
    return target;
  }

  paths() {
    this.check(this.roundDirectory);
    const directories = Object.fromEntries(CATEGORIES.map(name => [name, this.check(path.join(this.roundDirectory, name))]));
    return { workspace_contract_version: WORKSPACE_CONTRACT_VERSION, root: this.root, round: this.round,
      round_dir: this.roundDirectory, directories };
  }

  init() {
    for (const category of CATEGORIES) this.check(path.join(this.roundDirectory, category), true);
    return this.paths();
  }

  resolve(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || /[\x00-\x1f\x7f\\]/.test(relativePath)
      || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)
      || relativePath.split('/').includes('..')) {
      this.fail('artifact_path_invalid', '产物路径无效；禁止绝对路径、..、反斜杠与控制字符', { path: relativePath });
    }
    const normalized = path.posix.normalize(relativePath);
    const parts = normalized.split('/');
    if (parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
      this.fail('artifact_path_invalid', '产物文件名不支持 Windows ADS、保留名、尾点/空格或不可移植字符', { path: relativePath });
    }
    if (!CATEGORIES.includes(parts[0]) || parts.length < 2 || !parts.at(-1) || parts.at(-1) === '.') {
      this.fail('artifact_path_invalid', '产物路径必须指定本轮 tmp/、logs/ 或 output/ 下的文件名', { path: relativePath });
    }
    return this.check(path.join(this.roundDirectory, ...parts), false, true);
  }

  // Read only a regular artifact within the same checked round paths. Bound the
  // actual bytes read, including growth after fstat, and never create directories.
  read(relativePath, maxBytes = 20 * 1024 * 1024) {
    const target = this.resolve(relativePath);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 20 * 1024 * 1024) {
      this.fail('artifact_size_invalid', '读取上限必须为0到20MiB的安全整数', { path: relativePath });
    }
    let descriptor;
    try {
      descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!fs.fstatSync(descriptor).isFile()) this.fail('artifact_path_unsafe', '产物必须是普通文件', { path: target });
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size <= maxBytes) {
        const count = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > maxBytes) this.fail('artifact_too_large', '产物超过读取上限；请减少报告候选或拆分交付', { path: target, max_bytes: maxBytes });
      return buffer.subarray(0, size);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      this.fail('artifact_read_error', '无法读取产物；请检查文件存在、权限与路径节点', { path: target, fs_code: error.code });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  write(relativePath, content) {
    const target = this.resolve(relativePath);
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      this.fail('artifact_content_invalid', '产物内容必须是 string 或 Buffer', { path: relativePath });
    }
    this.check(target, true, true);
    let descriptor;
    try {
      descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(descriptor, content);
    } catch (error) {
      this.fail(error.code === 'EEXIST' ? 'artifact_exists' : 'artifact_io_error',
        error.code === 'EEXIST' ? '产物已存在，拒绝覆盖；请选择新文件名或下一轮' : '产物写入失败；请检查权限、磁盘状态及路径节点',
        { path: target, fs_code: error.code });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    return { workspace_contract_version: WORKSPACE_CONTRACT_VERSION, root: this.root, round: this.round,
      relative_path: path.relative(this.roundDirectory, target).split(path.sep).join('/'), path: target,
      size_bytes: Buffer.byteLength(content) };
  }
}

module.exports = { WORKSPACE_CONTRACT_VERSION, WorkspaceArtifacts, WorkspaceError };
