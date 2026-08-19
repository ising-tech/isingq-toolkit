'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_CONFIG_BYTES = 1024 * 1024;

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

function executableInPath(name, environment = process.env, platform = process.platform) {
  const extensions = platform === 'win32'
    ? ['', ...(environment.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
    : [''];
  for (const directory of (environment.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue discovery.
      }
    }
  }
  return null;
}

function hostExecutables() {
  const localAppData = process.env.LOCALAPPDATA || '';
  return {
    codex: [
      executableInPath(process.platform === 'win32' ? 'codex.exe' : 'codex'),
      '/Applications/Codex.app/Contents/Resources/codex',
      localAppData ? path.join(localAppData, 'Programs', 'Codex', 'codex.exe') : null,
    ].find((candidate) => candidate && fs.existsSync(candidate)) || null,
    claude: executableInPath(process.platform === 'win32' ? 'claude.exe' : 'claude'),
  };
}

function detectHosts(paths = hostPaths()) {
  const executables = hostExecutables();
  const detected = [];
  if (fs.existsSync(paths.workbuddy) || fs.existsSync('/Applications/WorkBuddy.app') || fs.existsSync('/opt/WorkBuddy')) detected.push('workbuddy');
  if (executables.codex) detected.push('codex');
  if (executables.claude || fs.existsSync(paths.claudeCode)) detected.push('claude-code');
  if (fs.existsSync(paths.cursor) || fs.existsSync('/Applications/Cursor.app') || fs.existsSync('/opt/Cursor')) detected.push('cursor');
  if (fs.existsSync(paths.vscode) || fs.existsSync('/Applications/Visual Studio Code.app') || fs.existsSync('/usr/share/code')) detected.push('vscode');
  return detected;
}

function refuseSymlink(file) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error(`拒绝写入符号链接（path=${file}）`);
  }
}

function atomicWrite(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  refuseSymlink(file);
  const temporary = path.join(directory, `.${path.basename(file)}.isingq-mcp-${process.pid}`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJsonObject(file, rootKey) {
  refuseSymlink(file);
  if (!fs.existsSync(file)) return { [rootKey]: {} };
  const metadata = fs.statSync(file);
  if (metadata.size > MAX_CONFIG_BYTES) throw new Error(`Agent 配置过大（path=${file}, bytes=${metadata.size}）`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Agent 配置不是有效 JSON（path=${file}）`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`Agent 配置根节点必须是 object（path=${file}）`);
  if (parsed[rootKey] === undefined) parsed[rootKey] = {};
  if (!parsed[rootKey] || Array.isArray(parsed[rootKey]) || typeof parsed[rootKey] !== 'object') {
    throw new Error(`${rootKey} 必须是 object（path=${file}）`);
  }
  return parsed;
}

function configureJsonHost(file, rootKey, command, includeType) {
  const config = readJsonObject(file, rootKey);
  const existing = config[rootKey].isingq;
  const next = existing && !Array.isArray(existing) && typeof existing === 'object' ? { ...existing } : {};
  for (const key of ['url', 'headers', 'env', 'disabled']) delete next[key];
  next.command = command.command;
  next.args = command.args;
  if (includeType) next.type = 'stdio'; else delete next.type;
  config[rootKey].isingq = next;
  atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`);
}

function configureCodex(command) {
  const executable = hostExecutables().codex;
  if (!executable) throw new Error('未找到 Codex CLI，无法自动配置 Codex');
  const result = spawnSync(executable, ['mcp', 'add', 'isingq', '--', command.command, ...command.args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Codex MCP 配置失败（exit_code=${result.status ?? 'unknown'}）`);
}

function configureHosts(hosts, command, paths = hostPaths(), options = {}) {
  for (const host of hosts) {
    if (host === 'workbuddy') configureJsonHost(paths.workbuddy, 'mcpServers', command, true);
    else if (host === 'codex') configureCodex(command);
    else if (host === 'claude-code') configureJsonHost(paths.claudeCode, 'mcpServers', command, true);
    else if (host === 'cursor') configureJsonHost(paths.cursor, 'mcpServers', command, false);
    else if (host === 'vscode') configureJsonHost(paths.vscode, 'servers', command, false);
    else if (host === 'generic') configureJsonHost(paths.generic, 'mcpServers', command, false);
    else throw new Error(`不支持的 Agent Host（host=${host}）`);
  }
  if (options.writeGeneric !== false && !hosts.includes('generic')) {
    configureJsonHost(paths.generic, 'mcpServers', command, false);
  }
  return hosts;
}

module.exports = { configureHosts, detectHosts, hostPaths, readJsonObject };
