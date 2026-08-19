'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { TARGETS, selectTargets, writeReleaseMetadata } = require('../scripts/release-targets');

test('selects one native release target for a matrix runner', () => {
  const selected = selectTargets(['--target', 'node22-win-x64']);
  assert.deepEqual(selected, [{ target: 'node22-win-x64', name: 'isingq-mcp-windows-x64.exe' }]);
  assert.throws(() => selectTargets(['--target', 'unknown']), /未知构建目标/);
});

test('writes deterministic release checksums for selected artifacts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-release-test-'));
  try {
    const target = TARGETS[0];
    fs.writeFileSync(path.join(directory, target.name), 'binary');
    const files = writeReleaseMetadata(directory, [target], '1.2.3');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '1.2.3');
    assert.deepEqual(manifest.files, files);
    assert.match(fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8'), new RegExp(`  ${target.name}\\n$`));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
