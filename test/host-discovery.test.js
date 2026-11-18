'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { configureHosts, detectHosts, hostPaths } = require('../src/hosts');

function fixture(t, platform = 'linux') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-discovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = path.join(home, 'first'), second = path.join(home, 'second bin');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const environment = { HOME: home, PATH: [first, second].join(platform === 'win32' ? ';' : ':'), PATHEXT: '.BAT;.CMD;.EXE' };
  const fileSystem = {
    existsSync: file => String(file).startsWith(home + path.sep) && fs.existsSync(file),
    accessSync: (...args) => fs.accessSync(...args),
    statSync: (...args) => fs.statSync(...args),
  };
  const options = { environment, platform, fileSystem, writeGeneric: false };
  return { home, first, second, environment, options, paths: hostPaths(environment, platform) };
}
function executable(file, mode = 0o700) { fs.writeFileSync(file, 'fixture executable', { mode }); }

// Discovery is read-only even against the pre-injection implementation.
test('discovery honors injected PATH and config home, skipping non-executable files and directories', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.first, 'codex'));
  executable(path.join(f.first, 'claude'), 0o600);
  executable(path.join(f.second, 'codex'));
  for (const file of [f.paths.workbuddy, f.paths.claudeCode, f.paths.cursor, f.paths.vscode]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}');
  }
  assert.deepEqual(detectHosts(undefined, f.options), ['workbuddy', 'codex', 'claude-code', 'cursor', 'vscode']);
});

test('discovery uses win32 PATH separator and PATHEXT independently of the test OS', t => {
  const f = fixture(t, 'win32');
  fs.mkdirSync(path.join(f.first, 'codex.BAT'));
  executable(path.join(f.second, 'codex.CMD'));
  executable(path.join(f.second, 'claude.BAT'));
  assert.deepEqual(detectHosts(f.paths, f.options), ['claude-code']);
});

test('discovery with missing executables and absent configs returns no hosts', t => {
  const f = fixture(t);
  assert.deepEqual(detectHosts(f.paths, f.options), []);
});

test('Codex registration passes exact add arguments and bounds the injected process', t => {
  const f = fixture(t, 'win32');
  const codex = path.join(f.second, 'codex.exe');
  executable(path.join(f.first, 'codex.CMD'));
  executable(path.join(f.first, 'codex.BAT'));
  executable(codex);
  const command = { command: '/fixture path/isingq-mcp', args: ['serve', '--literal=value with spaces'] };
  const calls = [];
  configureHosts(['codex'], command, f.paths, { ...f.options, spawnSync: (...args) => { calls.push(args); return { status: 0 }; } });
  assert.equal(calls.length, 1);
  const [program, args, options] = calls[0];
  assert.equal(program, codex);
  assert.deepEqual(args, ['mcp', 'add', 'isingq', '--', command.command, ...command.args]);
  assert.deepEqual(options.env, f.environment);
  assert.equal(options.timeout, 15000);
  assert.equal(options.maxBuffer, 1024 * 1024);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, undefined);
  assert.equal(fs.existsSync(f.paths.generic), false);
});

test('Codex registration missing executable never starts a process or writes config', t => {
  const f = fixture(t);
  let spawned = false;
  assert.throws(() => configureHosts(['codex'], { command: 'fixture', args: [] }, f.paths, {
    ...f.options, spawnSync: () => { spawned = true; return { status: 0 }; },
  }), /未找到 Codex CLI.*component=codex_cli/);
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(f.paths.generic), false);
});

test('Codex registration reports exit and process failures without echoing process output', t => {
  const f = fixture(t, 'win32');
  executable(path.join(f.first, 'codex.exe'));
  const cases = [
    { status: 7, stdout: 'PRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR' },
    { status: null, error: Object.assign(new Error('PRIVATE_ERROR'), { code: 'ETIMEDOUT' }), signal: 'SIGTERM' },
    { status: null, error: Object.assign(new Error('PRIVATE_ERROR'), { code: 'ENOBUFS' }) },
    { status: 0, error: Object.assign(new Error('PRIVATE_ERROR'), { code: 'EACCES' }) },
  ];
  for (const result of cases) {
    assert.throws(() => configureHosts(['codex'], { command: 'fixture', args: [] }, f.paths, { ...f.options, spawnSync: () => result }), error => {
      assert.match(error.message, /component=codex_cli/);
      assert.match(error.message, new RegExp('exit_code=' + (result.status ?? 'unknown')));
      if (result.error) assert.ok(error.message.includes(result.error.code));
      assert.doesNotMatch(error.message, /PRIVATE_OUTPUT|PRIVATE_ERROR/);
      return true;
    });
  }
  assert.throws(() => configureHosts(['codex'], { command: 'fixture', args: [] }, f.paths, { ...f.options, spawnSync: () => { throw new Error('PRIVATE_THROW'); } }), error => {
    assert.match(error.message, /component=codex_cli/);
    assert.doesNotMatch(error.message, /PRIVATE_THROW/);
    return true;
  });
});

test('discovery rejects executable directories and non-executable PATH files', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.first, 'codex'));
  executable(path.join(f.second, 'claude'), 0o600);
  assert.deepEqual(detectHosts(f.paths, f.options), []);
});

test('Codex discovery and registration share the injected LOCALAPPDATA fallback', t => {
  const f = fixture(t, 'win32');
  executable(path.join(f.first, 'codex.CMD'));
  f.environment.LOCALAPPDATA = path.join(f.home, 'LocalData');
  const codex = path.join(f.environment.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe');
  fs.mkdirSync(path.dirname(codex), { recursive: true }); executable(codex);
  assert.deepEqual(detectHosts(f.paths, f.options), ['codex']);
  let program;
  configureHosts(['codex'], { command: 'fixture', args: ['serve'] }, undefined, {
    ...f.options, spawnSync: executable => { program = executable; return { status: 0 }; },
  });
  assert.equal(program, codex);
  assert.equal(fs.existsSync(f.paths.generic), false);
});


test('Windows shim-only installation is not auto-configurable and never starts a process', t => {
  const f = fixture(t, 'win32');
  for (const name of ['codex.CMD', 'codex.BAT', 'codex.exe.CMD']) executable(path.join(f.first, name));
  assert.deepEqual(detectHosts(f.paths, f.options), []);
  let spawned = false;
  assert.throws(() => configureHosts(['codex'], { command: 'fixture', args: ['serve'] }, f.paths, {
    ...f.options, spawnSync: () => { spawned = true; return { status: 0 }; },
  }), error => {
    assert.match(error.message, /component=codex_cli/);
    assert.match(error.message, /exit_code=not_started/);
    assert.match(error.message, /原生.*codex\.exe/);
    assert.match(error.message, /CMD.*BAT.*无法自动配置/);
    return true;
  });
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(f.paths.generic), false);
});
