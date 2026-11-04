'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('every distribution resolves the fixed runtime HTTP dependency with the matching Node minimum', () => {
  const lock = readJson('package-lock.json');
  for (const directory of ['', 'packages/core', 'packages/dsh-plugin']) {
    const manifestPath = path.join(directory, 'package.json');
    const manifest = readJson(manifestPath);
    assert.equal(manifest.engines.node, '>=18.17');
    assert.equal(lock.packages[directory].engines.node, '>=18.17');
    if (!directory.endsWith('dsh-plugin')) {
      assert.equal(manifest.dependencies.undici, '6.29.1');
      assert.equal(lock.packages[directory].dependencies.undici, '6.29.1');
    }
    const consumer = createRequire(path.join(root, manifestPath));
    const coreEntry = directory.endsWith('dsh-plugin') ? consumer.resolve('@ising-tech/isingq-core') : path.join(root, directory, 'src/isingq.js');
    assert.equal(createRequire(coreEntry)('undici/package.json').version, '6.29.1');
  }
  assert.equal(lock.packages['node_modules/@yao-pkg/pkg-fetch/node_modules/undici'].version, '7.30.1');
});

test('source installer rejects Node before 18.17 and permits the minimum before invoking npm', { skip: process.platform === 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-installer-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const nodePath = path.join(directory, 'node');
  const npmPath = path.join(directory, 'npm');
  const preload = path.join(directory, 'version.cjs');
  const marker = path.join(directory, 'npm-called');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: process.env.ISINGQ_TEST_NODE_VERSION });\n");
  fs.writeFileSync(nodePath, `#!/bin/sh\nexec ${quote(process.execPath)} --require ${quote(preload)} "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(npmPath, '#!/bin/sh\nprintf called > "$ISINGQ_TEST_NPM_MARKER"\nexit 35\n', { mode: 0o700 });
  for (const version of ['17.9.1', '18.16.1', '18.17.0', '20.0.0']) {
    fs.rmSync(marker, { force: true });
    const result = spawnSync('/bin/sh', [path.join(root, 'install/install.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH, ISINGQ_TEST_NODE_VERSION: version, ISINGQ_TEST_NPM_MARKER: marker, ISINGQ_MCP_NPM_PREFIX: path.join(directory, 'prefix') },
    });
    const allowed = version === '18.17.0' || version === '20.0.0';
    assert.equal(fs.existsSync(marker), allowed, `version=${version}; stderr=${result.stderr}`);
    assert.equal(result.status, allowed ? 35 : 1, `version=${version}; stderr=${result.stderr}`);
    if (!allowed) {
      assert.ok(result.stderr.includes(`version=${version}, required=>=18.17`));
      assert.match(result.stderr, /请升级 Node.js/);
    }
  }
});
