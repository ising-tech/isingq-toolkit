'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { fileLimit, assertFileBytes, readFileBounded, FileLimitError } = require('../packages/core/src/file-limits');

function hostPaths(environment = process.env, platform = process.platform) {
  const home = environment.HOME || environment.USERPROFILE || os.homedir();
  const windows = platform === 'win32';
  const configHome = environment.XDG_CONFIG_HOME
    || (windows ? environment.APPDATA : null)
    || path.join(home, '.config');
  const vscode = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    : windows
      ? path.join(environment.APPDATA || configHome, 'Code', 'User', 'mcp.json')
      : path.join(configHome, 'Code', 'User', 'mcp.json');
  return {
    workbuddy: path.join(home, '.workbuddy', 'mcp.json'),
    claudeCode: path.join(home, '.claude.json'),
    cursor: path.join(home, '.cursor', 'mcp.json'),
    vscode,
    generic: path.join(configHome, 'isingq-mcp', 'mcp.generic.json'),
  };
}

function executableInPath(name, environment = process.env, platform = process.platform, fileSystem = fs) {
  const extensions = platform === 'win32' && !path.win32.extname(name)
    ? ['', ...(environment.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
    : [''];
  for (const directory of (environment.PATH || '').split(platform === 'win32' ? ';' : ':')) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`);
      try {
        if (!fileSystem.statSync(candidate).isFile()) continue;
        fileSystem.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue discovery.
      }
    }
  }
  return null;
}

function hostExecutables({ environment = process.env, platform = process.platform, fileSystem = fs } = {}) {
  const localAppData = environment.LOCALAPPDATA || '';
  const locate = name => executableInPath(platform === 'win32' ? `${name}.exe` : name, environment, platform, fileSystem)
    || (platform === 'win32' ? executableInPath(name, environment, platform, fileSystem) : null);
  return {
    codex: [
      // Windows auto-configuration invokes without a shell: accept native
      // executables only, even when an earlier PATH directory has a shim.
      platform === 'win32' ? executableInPath('codex.exe', environment, platform, fileSystem) : locate('codex'),
      platform === 'win32' ? null : '/Applications/Codex.app/Contents/Resources/codex',
      localAppData ? path.join(localAppData, 'Programs', 'Codex', 'codex.exe') : null,
    ].find(candidate => candidate && fileSystem.existsSync(candidate)) || null,
    claude: locate('claude'),
  };
}

function detectHosts(paths, options = {}) {
  const { environment = process.env, platform = process.platform, fileSystem = fs } = options;
  paths ??= hostPaths(environment, platform);
  const executables = hostExecutables(options);
  const detected = [];
  if (fileSystem.existsSync(paths.workbuddy) || fileSystem.existsSync('/Applications/WorkBuddy.app') || fileSystem.existsSync('/opt/WorkBuddy')) detected.push('workbuddy');
  if (executables.codex) detected.push('codex');
  if (executables.claude || fileSystem.existsSync(paths.claudeCode)) detected.push('claude-code');
  if (fileSystem.existsSync(paths.cursor) || fileSystem.existsSync('/Applications/Cursor.app') || fileSystem.existsSync('/opt/Cursor')) detected.push('cursor');
  if (fileSystem.existsSync(paths.vscode) || fileSystem.existsSync('/Applications/Visual Studio Code.app') || fileSystem.existsSync('/usr/share/code')) detected.push('vscode');
  return detected;
}

function refuseSymlink(file) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`拒绝写入符号链接（path=${file}）`);
  }
}

function atomicWrite(file, content, maxBytes) {
  const bytes = Buffer.byteLength(content, 'utf8');
  assertFileBytes(bytes, maxBytes, 'hostConfig', file);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  refuseSymlink(file);
  const temporary = path.join(directory, `.${path.basename(file)}.isingq-mcp-${crypto.randomUUID()}`);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
    const ownedFd = descriptor;
    descriptor = undefined;
    fs.closeSync(ownedFd);
    fs.renameSync(temporary, file);
    created = false;
  } finally {
    if (descriptor !== undefined) {
      const ownedFd = descriptor;
      descriptor = undefined;
      try { fs.closeSync(ownedFd); } catch { /* Preserve the primary write error. */ }
    }
    if (created) {
      try { fs.unlinkSync(temporary); } catch { /* Preserve the primary write error and existing config. */ }
    }
  }
}

function readJsonObject(file, rootKey, environment = process.env) {
  const maxBytes = fileLimit('hostConfig', environment);
  refuseSymlink(file);
  if (!fs.existsSync(file)) return { [rootKey]: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileBounded(file, maxBytes, 'hostConfig').toString('utf8'));
  } catch (error) {
    if (error instanceof FileLimitError) throw error;
    throw new Error(`Agent 配置不是有效 JSON（path=${file}）`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`Agent 配置根节点必须是 object（path=${file}）`);
  if (parsed[rootKey] === undefined) parsed[rootKey] = {};
  if (!parsed[rootKey] || Array.isArray(parsed[rootKey]) || typeof parsed[rootKey] !== 'object') {
    throw new Error(`${rootKey} 必须是 object（path=${file}）`);
  }
  return parsed;
}

function configureJsonHost(file, rootKey, command, includeType, environment) {
  const maxBytes = fileLimit('hostConfig', environment);
  const config = readJsonObject(file, rootKey, environment);
  const existing = config[rootKey].isingq;
  const next = existing && !Array.isArray(existing) && typeof existing === 'object' ? { ...existing } : {};
  for (const key of ['url', 'headers', 'env', 'disabled']) delete next[key];
  next.command = command.command;
  next.args = command.args;
  if (includeType) next.type = 'stdio'; else delete next.type;
  config[rootKey].isingq = next;
  atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`, maxBytes);
}

function configureCodex(command, options = {}) {
  const environment = options.environment || process.env;
  const executable = hostExecutables(options).codex;
  if (!executable) {
    const guidance = (options.platform || process.platform) === 'win32'
      ? 'Windows 自动配置需要原生 codex.exe；仅有 .CMD/.BAT shim 时无法自动配置，请安装原生 Codex CLI 并把其目录加入 PATH 后重试'
      : '请安装 Codex CLI 或把其可执行文件目录加入 PATH 后重试';
    throw new Error(`未找到 Codex CLI（component=codex_cli, exit_code=not_started）；${guidance}`);
  }
  let result;
  try {
    result = (options.spawnSync || spawnSync)(executable, ['mcp', 'add', 'isingq', '--', command.command, ...command.args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: environment, timeout: 15000, maxBuffer: 1024 * 1024,
    });
  } catch (error) { result = { error }; }
  if (result?.error || result?.status !== 0) {
    const exitCode = Number.isInteger(result?.status) ? result.status : 'unknown';
    const reason = ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'ENOEXEC'].includes(result?.error?.code) ? result.error.code : 'process_failed';
    throw new Error(`Codex MCP 配置失败（component=codex_cli, exit_code=${exitCode}, reason=${reason}）；请检查 Codex CLI 是否可运行，再重试配置`);
  }
}

function configureHosts(hosts, command, paths, options = {}) {
  const environment = { ...(options.environment || process.env) };
  paths ??= hostPaths(environment, options.platform || process.platform);
  fileLimit('hostConfig', environment);
  for (const host of hosts) {
    if (host === 'workbuddy') configureJsonHost(paths.workbuddy, 'mcpServers', command, true, environment);
    else if (host === 'codex') configureCodex(command, { ...options, environment });
    else if (host === 'claude-code') configureJsonHost(paths.claudeCode, 'mcpServers', command, true, environment);
    else if (host === 'cursor') configureJsonHost(paths.cursor, 'mcpServers', command, false, environment);
    else if (host === 'vscode') configureJsonHost(paths.vscode, 'servers', command, false, environment);
    else if (host === 'generic') configureJsonHost(paths.generic, 'mcpServers', command, false, environment);
    else throw new Error(`不支持的 Agent Host（host=${host}）`);
  }
  if (options.writeGeneric !== false && !hosts.includes('generic')) {
    configureJsonHost(paths.generic, 'mcpServers', command, false, environment);
  }
  return hosts;
}

module.exports = { configureHosts, detectHosts, hostPaths, readJsonObject };
