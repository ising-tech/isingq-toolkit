'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
const marketplacePluginRoot = path.join(root, 'plugins', 'isingq-mcp');
const marketplaceManifest = JSON.parse(fs.readFileSync(path.join(marketplacePluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const marketplaceMcp = JSON.parse(fs.readFileSync(path.join(marketplacePluginRoot, '.mcp.json'), 'utf8'));
const lobeManifest = JSON.parse(fs.readFileSync(path.join(root, 'lhm.plugin.json'), 'utf8'));
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
  assert.equal(manifest.interface.composerIcon, undefined);
  assert.equal(manifest.interface.logo, undefined);
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

test('repo marketplace points to the dedicated npx wrapper', () => {
  assert.equal(marketplace.name, 'isingq-toolkit');
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'isingq-mcp');
  assert.equal(marketplace.plugins[0].source.path, './plugins/isingq-mcp');
  assert.equal(marketplaceManifest.name, manifest.name);
  assert.equal(marketplaceManifest.version.split('+')[0], pkg.version);
  assert.equal(marketplaceManifest.mcpServers, './.mcp.json');
  assert.equal(marketplaceManifest.interface.composerIcon, './assets/isingq-icon.png');
  assert.equal(marketplaceManifest.interface.logo, './assets/isingq-icon.png');
  assert.deepEqual(marketplaceMcp, {
    mcpServers: {
      isingq: {
        command: 'npx',
        args: ['-y', '@ising-tech/isingq-mcp', 'serve'],
      },
    },
  });
});

test('LobeHub manifest is a reviewed local-stdio capability snapshot', () => {
  assert.equal(lobeManifest.identifier, 'ising-tech-isingq-toolkit');
  assert.equal(lobeManifest.version, pkg.version);
  assert.equal(lobeManifest.author, 'ising-tech');
  assert.equal(lobeManifest.cloudEndpoint, undefined);
  assert.equal(lobeManifest.tools.length, 7);
  assert.equal(lobeManifest.resources.length, 13);
  assert.match(lobeManifest.icon, /^https:\/\/raw\.githubusercontent\.com\/ising-tech\/isingq-toolkit\//);
  const solveStart = lobeManifest.tools.find(({ name }) => name === 'isingq_solve_start');
  assert.equal(solveStart.annotations.destructiveHint, true);
  assert.equal(solveStart.annotations.openWorldHint, true);
});
