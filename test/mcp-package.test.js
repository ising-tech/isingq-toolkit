'use strict';
const { runWithCleanupSync } = require('../packages/core/src/run-with-cleanup');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { packMcp } = require('../scripts/pack-mcp');

const root = path.resolve(__dirname, '..');

test('MCP npm archive carries its own bilingual README without changing repository pages or runtime files', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-package-test-'));
  const pages = ['README.md', 'README.en.md'];
  const before = pages.map(file => fs.readFileSync(path.join(root, file)));
  runWithCleanupSync(() => {
    assert.equal(require('../package.json').scripts['pack:mcp'], 'node scripts/pack-mcp.js');
    const [packed] = packMcp({ destination: output });
    const archive = path.join(output, packed.filename);
    const read = file => execFileSync('tar', ['-xOf', archive, `package/${file}`]);
    for (const file of pages) {
      assert.deepEqual(read(file), fs.readFileSync(path.join(root, 'packages/mcp', file)));
    }
    for (const file of ['package.json', 'bin/isingq-mcp.js', 'src/server.js', 'packages/core/src/index.js', 'LICENSE', 'SECURITY.md']) {
      assert.deepEqual(read(file), fs.readFileSync(path.join(root, file)), file);
    }
    for (const file of packed.files) {
      assert.deepEqual(read(file.path), fs.readFileSync(path.join(root, pages.includes(file.path) ? 'packages/mcp' : '', file.path)), file.path);
    }
    assert.ok(!packed.files.some(file => file.path.startsWith('docs/') || file.path.startsWith('test/')));
  }, () => {
    pages.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[i], file));
  }, () => {
    fs.rmSync(output, { recursive: true, force: true });
  });
});
