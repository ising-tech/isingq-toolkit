'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
const pkg = require('../package.json');

test('packages the repository as an IsingQ Codex plugin', () => {
  assert.equal(manifest.name, 'isingq-mcp');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.repository, 'https://github.com/ising-tech/isingq-toolkit');
  assert.equal(manifest.author.email, undefined);
  assert.equal(manifest.interface.defaultPrompt.length, 3);
});

test('plugin starts the bundled source MCP without a separate native binary', () => {
  assert.deepEqual(mcp, {
    mcpServers: {
      isingq: {
        command: 'node',
        args: ['./bin/isingq-mcp.js', 'serve'],
        cwd: '.',
      },
    },
  });
});
