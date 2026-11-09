'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluate, sanitize } = require('../scripts/verify-dsh-plugin.js');

const EXPECTED = {
  tools: 12,
  coreVersion: '0.8.2',
  coreSha256: 'a'.repeat(64),
};

function goodSummary() {
  return {
    install: { plugin_exit: 0 },
    evidence: {
      ready: { isingq_tools: Array.from({ length: 12 }, (_, index) => `isingq_tool_${index}`) },
      verified: {
        passed: true,
        tools_match: true,
        isingq_tools: Array.from({ length: 12 }, (_, index) => `isingq_tool_${index}`),
        artifacts: { core_version: '0.8.2', core_sha256: 'a'.repeat(64) },
      },
    },
    host_run: { alive_after_grace: true, exit: { code: 0, signal: null }, closed_snapshot: true },
  };
}

test('accepts a complete verification record', () => {
  assert.equal(evaluate(goodSummary(), EXPECTED).passed, true);
});

test('rejects a non-zero host exit even when the plugin verified', () => {
  const summary = goodSummary();
  summary.host_run.exit = { code: 7, signal: null };
  const result = evaluate(summary, EXPECTED);
  assert.equal(result.passed, false);
  assert.equal(result.checks.host_exit_zero, false);
  assert.equal(result.checks.plugin_passed, true);
});

test('rejects a runtime that loaded the wrong core version', () => {
  const summary = goodSummary();
  summary.evidence.verified.artifacts.core_version = '0.8.1';
  assert.equal(evaluate(summary, EXPECTED).checks.core_version, false);
  assert.equal(evaluate(summary, EXPECTED).passed, false);
});

test('rejects a runtime whose core digest does not match the candidate', () => {
  const summary = goodSummary();
  summary.evidence.verified.artifacts.core_sha256 = 'b'.repeat(64);
  assert.equal(evaluate(summary, EXPECTED).checks.core_sha256, false);
  assert.equal(evaluate(summary, EXPECTED).passed, false);
});

test('rejects a partial ready snapshot even when the verified snapshot is complete', () => {
  const summary = goodSummary();
  summary.evidence.ready.isingq_tools = ['isingq_api_key_setup', 'isingq_knowledge_get'];
  assert.equal(evaluate(summary, EXPECTED).checks.ready_tools, false);
  assert.equal(evaluate(summary, EXPECTED).passed, false);
});

test('redacts authorization, bearer, token, api key and secret values', () => {
  const text = 'Authorization: Bearer sk-synthetic-secret\n' +
    'token=synthetic-token&next=1\n' +
    'api_key=synthetic-api-key\n' +
    'password: synthetic-password\n' +
    'sk-synthetic-key';
  const clean = sanitize(text);
  for (const secret of ['sk-synthetic-secret', 'synthetic-token', 'synthetic-api-key', 'synthetic-password', 'sk-synthetic-key']) {
    assert.equal(clean.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(clean, /Authorization: <redacted>/);
  assert.match(clean, /token=<redacted>/);
});
