'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const publicDistributionFiles = [
  'README.md',
  'server.json',
  'install/install.sh',
  'install/install.ps1',
  'skills/install-isingq-mcp/SKILL.md',
  'skills/install-isingq-mcp/SKILL.zh-CN.md',
  'skills/install-isingq-mcp/scripts/install-linux.sh',
  'skills/install-isingq-mcp/scripts/install-macos.sh',
  'skills/install-isingq-mcp/scripts/install-windows.ps1',
  '.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
  'plugins/isingq-mcp/.codex-plugin/plugin.json',
  'plugins/isingq-mcp/.mcp.json',
  'lhm.plugin.json',
  '.gitignore',
  '.gitattributes',
  'LICENSE',
  'NOTICE',
  'packages/core/package.json',
  'packages/dsh-plugin/package.json',
  'packages/dsh-plugin/cordis.patch.yml',
  'packages/dsh-plugin/index.mjs',
];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('public distribution files contain no internal endpoint or repository metadata', () => {
  const privateIpv4 = /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/;
  for (const relative of publicDistributionFiles) {
    const content = read(relative);
    assert.doesNotMatch(content, privateIpv4, relative);
    assert.doesNotMatch(content, /https?:\/\/[^/\s]*\.ising(?:[/:]|$)/, relative);
    if (path.basename(relative) !== 'LICENSE') {
      assert.doesNotMatch(content, /http:\/\/(?!\*)[A-Za-z0-9[]/, relative);
    }
  }
  const marketplace = JSON.parse(read('.agents/plugins/marketplace.json'));
  assert.equal(marketplace.name, 'isingq-toolkit');
  assert.equal(marketplace.plugins[0].source.path, './plugins/isingq-mcp');
  assert.match(read('.gitignore'), /^node_modules\/$/m);
  assert.match(read('.gitignore'), /^\.env$/m);
  assert.match(read('.gitignore'), /^\.playwright-cli\/$/m);
  assert.match(read('.gitignore'), /^output\/$/m);
  assert.match(read('.gitignore'), /^video\/$/m);
  assert.match(read('.gitattributes'), /^\* text=auto$/m);
  assert.match(read('.gitattributes'), /^dist\/ export-ignore$/m);
});

test('npm package includes only runtime and public integration files', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
  assert.equal(pkg.repository.url, 'git+https://github.com/ising-tech/isingq-toolkit.git');
  assert.match(pkg.scripts.prepublishOnly, /npm test.*npm run check/);
  assert.deepEqual(pkg.files, [
    '.codex-plugin/',
    '.mcp.json',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'server.json',
    'bin/',
    'install/',
    'packages/core/',
    'skills/',
    'src/',
  ]);
  assert.equal(pkg.dsh, undefined);
  assert.equal(pkg.dependencies?.['@deepseek-ai/dsh-tools'], undefined);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.ok(!pkg.files.some((entry) => /\.agents|output|playwright|video/.test(entry)));
});

test('publishes MCP Registry metadata aligned with the npm package', () => {
  const pkg = JSON.parse(read('package.json'));
  const server = JSON.parse(read('server.json'));
  assert.equal(pkg.mcpName, 'io.github.ising-tech/isingq-mcp');
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(server.repository.url, 'https://github.com/ising-tech/isingq-toolkit');
  assert.equal(server.repository.source, 'github');
  assert.deepEqual(server.packages, [{
    registryType: 'npm',
    identifier: pkg.name,
    version: pkg.version,
    transport: { type: 'stdio' },
  }]);
  assert.equal(server.packages[0].environmentVariables, undefined);
});

test('publishes the same Apache-2.0 license and notice in every package', () => {
  const rootLicense = read('LICENSE');
  const rootNotice = read('NOTICE');
  assert.match(rootLicense, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(rootNotice, /isingq-toolkit.*北京伊辛智能科技有限公司/s);
  for (const directory of ['packages/core', 'packages/dsh-plugin']) {
    const manifest = JSON.parse(read(`${directory}/package.json`));
    assert.equal(manifest.license, 'Apache-2.0');
    assert.equal(read(`${directory}/LICENSE`), rootLicense);
    assert.equal(read(`${directory}/NOTICE`), rootNotice);
    assert.ok(manifest.files.includes('LICENSE'));
    assert.ok(manifest.files.includes('NOTICE'));
  }
});

test('installers execute only the checked-out local source tree', () => {
  const installers = publicDistributionFiles.filter((relative) => /install.*\.(?:sh|ps1)$/.test(relative));
  for (const relative of installers) {
    const content = read(relative);
    assert.doesNotMatch(content, /curl|Invoke-WebRequest|Invoke-Expression|ISINGQ_MCP_INSTALL_URL|ISINGQ_MCP_ASSET_BASE/, relative);
    assert.match(content, /npm/, relative);
  }
});

test('publishes focused discovery keywords for each package boundary', () => {
  const mcp = JSON.parse(read('package.json'));
  const core = JSON.parse(read('packages/core/package.json'));
  const dsh = JSON.parse(read('packages/dsh-plugin/package.json'));
  assert.deepEqual(new Set(mcp.keywords), new Set([
    'mcp', 'model-context-protocol', 'isingq', 'ising-machine', 'qubo',
    'combinatorial-optimization', 'binary-optimization', 'agent-tools',
    'local-first', 'photonic-computing',
  ]));
  assert.ok(core.keywords.includes('solver'));
  assert.ok(core.keywords.includes('binary-optimization'));
  assert.ok(dsh.keywords.includes('deepseek-harness'));
  assert.ok(dsh.keywords.includes('dsh-plugin'));
});
