'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('source install emits a node-backed MCP command', () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const result = spawnSync(process.execPath, [executable, 'config', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.mcpServers.isingq.command, process.execPath);
  assert.deepEqual(config.mcpServers.isingq.args, [executable, 'serve']);
});

test('npx config follows the latest public npm package', () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const result = spawnSync(process.execPath, [executable, 'config', '--json', '--npx'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.mcpServers.isingq.command, 'npx');
  assert.deepEqual(config.mcpServers.isingq.args, ['-y', '@ising-tech/isingq-mcp', 'serve']);
});

test('setup --stdin stores a secret without echoing it', () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-cli-test-'));
  const secret = 'stdin-private-api-key';
  const result = spawnSync(process.execPath, [executable, 'setup', '--stdin'], {
    encoding: 'utf8',
    input: `${secret}\n`,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(secret), false);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(fs.readFileSync(response.api_key_file, 'utf8').trim(), secret);
  if (process.platform !== 'win32') assert.equal(fs.statSync(response.api_key_file).mode & 0o777, 0o600);
});

test('configure-host targets only the requested generic Host', () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-host-test-'));
  const result = spawnSync(process.execPath, [executable, 'configure-host', '--name', 'generic'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).configured_hosts, ['generic']);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config', 'isingq-mcp', 'mcp.generic.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.isingq.args.slice(-1), ['serve']);
  assert.equal(fs.existsSync(path.join(home, '.workbuddy', 'mcp.json')), false);
});

test('configure-host can persist a latest-version npx command', () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-npx-host-test-'));
  const result = spawnSync(process.execPath, [executable, 'configure-host', '--name', 'generic', '--npx'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config', 'isingq-mcp', 'mcp.generic.json'), 'utf8'));
  assert.equal(config.mcpServers.isingq.command, 'npx');
  assert.deepEqual(config.mcpServers.isingq.args, ['-y', '@ising-tech/isingq-mcp', 'serve']);
});

test('configure-host targets only WorkBuddy without a generic sidecar', () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-workbuddy-test-'));
  const configHome = path.join(home, 'config');
  const result = spawnSync(process.execPath, [executable, 'configure-host', '--name', 'workbuddy'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).configured_hosts, ['workbuddy']);
  assert.equal(fs.existsSync(path.join(home, '.workbuddy', 'mcp.json')), true);
  assert.equal(fs.existsSync(path.join(home, '.workbuddy', '.mcp.json')), false);
  assert.equal(fs.existsSync(path.join(configHome, 'isingq-mcp', 'mcp.generic.json')), false);
});

test('configure-host rejects unknown Hosts', () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const result = spawnSync(process.execPath, [executable, 'configure-host', '--name', 'trae'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不支持的 Agent Host.*trae/);
});
