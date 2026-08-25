'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { apiKey, roots, saveApiKey } = require('../src/store');

test('stores API key privately and never includes it in paths', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-test-'));
  const environment = { HOME: home };
  const file = saveApiKey('private-api-key', environment);
  assert.equal(apiKey(environment), 'private-api-key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(file.includes('private-api-key'), false);
});

test('uses LOCALAPPDATA on Windows', () => {
  const value = roots({ USERPROFILE: 'C:\\Users\\alice', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }, 'win32');
  assert.match(value.config, /AppData/);
  assert.match(value.config, /isingq-mcp/);
});

test('accepts an administrator-provided API key for headless runtime without persisting it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-headless-'));
  const environment = { HOME: home, ISINGQ_API_KEY: 'headless-private-key' };
  assert.equal(apiKey(environment), 'headless-private-key');
  assert.equal(fs.existsSync(path.join(roots(environment).config, 'api-key')), false);
});

test('rejects an empty API key', () => {
  assert.throws(() => saveApiKey('  ', { HOME: os.tmpdir() }), /不能为空/);
});
