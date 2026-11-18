'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const scenarios = [
  'poll-200-hang', 'poll-200-drip', 'signature-200-hang', 'create-200-hang', 'create-200-drip',
  'upload-429-hang', 'signature-401-drip', 'poll-429-hang', 'create-401-hang', 'create-429-drip',
  'poll-200-fast', 'signature-200-fast', 'create-200-fast', 'upload-200-hang',
];
for (const scenario of scenarios) {
  test(`loopback HTTP body deadline and submission outcome: ${scenario}`, () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../test-support/transport-loopback.cjs'), 'body-' + scenario], { encoding: 'utf8', timeout: 7000 });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).survived, true);
  });
}
