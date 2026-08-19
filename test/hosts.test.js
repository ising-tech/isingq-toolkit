'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { configureHosts, hostPaths } = require('../src/hosts');

test('configures detected JSON hosts and always writes a generic config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-hosts-'));
  const paths = hostPaths({ HOME: home }, 'linux');
  fs.mkdirSync(path.dirname(paths.workbuddy), { recursive: true });
  fs.writeFileSync(paths.workbuddy, '{"mcpServers":{},"preserved":true}\n');
  const command = { command: '/opt/isingq-mcp', args: ['serve'] };

  configureHosts(['workbuddy'], command, paths);

  const workbuddy = JSON.parse(fs.readFileSync(paths.workbuddy, 'utf8'));
  const generic = JSON.parse(fs.readFileSync(paths.generic, 'utf8'));
  assert.equal(workbuddy.preserved, true);
  assert.deepEqual(workbuddy.mcpServers.isingq, { ...command, type: 'stdio' });
  assert.deepEqual(generic.mcpServers.isingq, command);
  if (process.platform !== 'win32') assert.equal(fs.statSync(paths.workbuddy).mode & 0o777, 0o600);
});
