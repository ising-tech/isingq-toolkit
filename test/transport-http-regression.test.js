'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const fixture = path.resolve(__dirname, '../test-support/transport-loopback.cjs');
function run(mode, depth) {
  const result = spawnSync(process.execPath, [fixture, mode, String(depth || 6)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.survived, true);
  assert.equal(evidence.undici, '6.29.1');
  return evidence;
}
for (const depth of [6, 7]) {
  test(`public transport survives malicious ${depth}-layer encoding and early close`, () => {
    assert.equal(run('attack', depth).requests, 1);
  });
}
for (const mode of ['normal', 'error', 'redirect', 'timeout']) {
  test(`public transport uses pinned HTTP implementation for ${mode}`, () => { run(mode); });
}
