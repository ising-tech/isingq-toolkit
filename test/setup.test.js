'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { configureApiKey, confirmSolve, promptApiKey } = require('../src/setup');
const { apiKey } = require('../src/store');

test('configures API key through a private prompt without returning the secret', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-plugin-setup-'));
  const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') };
  const result = configureApiKey({ environment, prompt: () => 'plugin-private-key' });
  assert.deepEqual(result, { configured: true, status: 'configured' });
  assert.equal(JSON.stringify(result).includes('plugin-private-key'), false);
  assert.equal(apiKey(environment), 'plugin-private-key');
});

test('reuses an existing API key without reopening the prompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-plugin-reuse-'));
  const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') };
  configureApiKey({ environment, prompt: () => 'existing-private-key' });
  let prompts = 0;
  const result = configureApiKey({ environment, prompt: () => { prompts += 1; return 'unexpected'; } });
  assert.deepEqual(result, { configured: true, status: 'already_configured' });
  assert.equal(prompts, 0);
});

test('rejects unsupported secure prompt platforms with an actionable error', () => {
  assert.throws(() => promptApiKey({ platform: 'aix' }), /不支持.*aix/);
});

test('binds macOS solve confirmation to the current request without shell interpolation', () => {
  let invocation;
  const confirmed = confirmSolve({
    model_summary: '最大割；$(touch /tmp/never-run)',
    num_bits: 4,
    matrix_sha256: 'a'.repeat(64),
    calculate_count: 2,
    use_credit: false,
  }, {
    platform: 'darwin',
    environment: {},
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });
  assert.equal(confirmed, true);
  assert.equal(invocation.command, 'osascript');
  assert.match(invocation.args.at(-1), /最大割.*4.*a{64}.*2/s);
  assert.equal(invocation.options.shell, undefined);
});

test('treats an OS confirmation cancel as a cancelled solve', () => {
  const confirmed = confirmSolve({
    model_summary: '测试模型',
    num_bits: 1,
    matrix_sha256: 'b'.repeat(64),
    calculate_count: 1,
    use_credit: true,
  }, {
    platform: 'darwin',
    spawn: () => ({ status: 1 }),
  });
  assert.equal(confirmed, false);
});

test('fails closed when Linux has no graphical confirmation component', () => {
  assert.throws(() => confirmSolve({
    model_summary: '测试模型',
    num_bits: 1,
    matrix_sha256: 'c'.repeat(64),
    calculate_count: 1,
    use_credit: false,
  }, {
    platform: 'linux',
    spawn: () => ({ error: { code: 'ENOENT' } }),
  }), /zenity.*kdialog.*尚未提交/);
});
