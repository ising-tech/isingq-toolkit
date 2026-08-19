'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { configureApiKey, promptApiKey } = require('../src/setup');
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
