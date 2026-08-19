'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function atomicJson(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function readJson(file, label) {
  try {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch (_) {
    throw new Error(`${label} 不存在或损坏（path=${file}）`);
  }
}

function apiKey(environment = process.env) {
  const injected = environment.ISINGQ_API_KEY;
  if (typeof injected === 'string' && injected.trim()) return injected.trim();
  const file = path.join(roots(environment).config, 'api-key');
  try {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) throw new Error();
    const value = fs.readFileSync(file, 'utf8').trim();
    if (!value || /\s/.test(value)) throw new Error();
    return value;
  } catch (_) {
    throw new Error('IsingQ API Key 未配置；请运行 isingq-mcp setup');
  }
}

function saveApiKey(value, environment = process.env) {
  const normalized = String(value || '').trim();
  if (!normalized || /\s/.test(normalized)) throw new Error('IsingQ API Key 不能为空或包含空白');
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
    this.directory = path.join(roots(environment).data, 'runs');
    privateDirectory(this.directory);
  }

  path(id) {
    if (typeof id !== 'string' || !/^solve_[a-f0-9]{32}$/.test(id)) throw new Error('solve_id 格式无效');
    return path.join(this.directory, `${id}.json`);
  }

  save(run) {
    atomicJson(this.path(run.solve_id), run);
    return run;
  }

  get(id) {
    return readJson(this.path(id), '求解记录');
  }

  findByIdempotency(digest) {
    for (const name of fs.readdirSync(this.directory).slice(0, 10000)) {
      if (!/^solve_[a-f0-9]{32}\.json$/.test(name)) continue;
      const run = readJson(path.join(this.directory, name), '求解记录');
      if (run.idempotency_digest === digest) return run;
    }
    return null;
  }
}

module.exports = { SolveStore, apiKey, roots, saveApiKey };
