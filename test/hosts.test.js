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

function hostFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-host-atomic-'));
  const paths = hostPaths({ HOME: home }, 'linux');
  fs.mkdirSync(path.dirname(paths.workbuddy), { recursive: true });
  const old = '{"mcpServers":{"other":{"command":"kept"}},"preserved":true}\n';
  fs.writeFileSync(paths.workbuddy, old, { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, paths, old, options: { environment: { HOME: home }, writeGeneric: false }, command: { command: '/opt/isingq-mcp', args: ['serve'] } };
}

test('host config temp names are random and an existing pid-style collision is preserved', t => {
  const f = hostFixture(t);
  const collision = path.join(path.dirname(f.paths.workbuddy), `.mcp.json.isingq-mcp-${process.pid}`);
  fs.writeFileSync(collision, 'pre-existing temp owned by another writer');
  const seen = [];
  const original = fs.openSync;
  fs.openSync = function(filename, ...args) {
    if (String(filename).includes('.isingq-mcp-')) seen.push(path.basename(String(filename)));
    return original.call(this, filename, ...args);
  };
  try { configureHosts(['workbuddy'], f.command, f.paths, f.options); } finally { fs.openSync = original; }
  assert.equal(fs.readFileSync(collision, 'utf8'), 'pre-existing temp owned by another writer');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\.mcp\.json\.isingq-mcp-[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(fs.readFileSync(f.paths.workbuddy, 'utf8').includes('"preserved": true'), true);
});

test('host config write and rename failures keep the old config and clean only owned temporary files', t => {
  for (const failure of ['write', 'rename']) {
    const f = hostFixture(t);
    const descriptors = new Set();
    const temporaryPaths = new Set();
    const originalOpen = fs.openSync;
    const originalWrite = fs.writeFileSync;
    const originalRename = fs.renameSync;
    fs.openSync = function(filename, ...args) {
      const fd = originalOpen.call(this, filename, ...args);
      if (String(filename).includes('.isingq-mcp-')) { descriptors.add(fd); temporaryPaths.add(String(filename)); }
      return fd;
    };
    if (failure === 'write') fs.writeFileSync = function(target, ...args) {
      if (descriptors.has(target)) { const error = Error('synthetic write failure'); error.code = 'ENOSPC'; throw error; }
      return originalWrite.call(this, target, ...args);
    };
    if (failure === 'rename') fs.renameSync = function(from, to) {
      if (to === f.paths.workbuddy) { const error = Error('synthetic rename failure'); error.code = 'EACCES'; throw error; }
      return originalRename.call(this, from, to);
    };
    try {
      assert.throws(() => configureHosts(['workbuddy'], f.command, f.paths, f.options), /synthetic (write|rename) failure/);
    } finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; fs.renameSync = originalRename; }
    assert.equal(fs.readFileSync(f.paths.workbuddy, 'utf8'), f.old);
    assert.deepEqual(fs.readdirSync(path.dirname(f.paths.workbuddy)).filter(name => name.includes('.isingq-mcp-')), []);
  }
});
