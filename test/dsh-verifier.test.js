'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluate, sanitize, verificationExpectations } = require('../scripts/verify-dsh-plugin.js');

const EXPECTED = verificationExpectations({}, { version:'0.8.2', sha256:'a'.repeat(64) });

function goodSummary() {
  return {
    install: { plugin_exit: 0 },
    evidence: {
      ready: { isingq_tools: [...EXPECTED.toolNames] },
      verified: {
        passed: true,
        tools_match: true,
        isingq_tools: [...EXPECTED.toolNames],
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

test('default verifier and packaged inspector share the current fixed native tool contract', () => {
  assert.equal(EXPECTED.tools, 21);
  assert.deepEqual(EXPECTED.toolNames, require('../scripts/dsh-verify-inspector/expected-tools.cjs'));
  assert.equal(verificationExpectations({'expect-tools':'22'}, {version:'v',sha256:'hash'}).tools, 22);
});

test('desktop inspector dispatches a native batch and matches its returned call identity', async () => {
  const { executeTool } = await import('../scripts/dsh-verify-inspector/index.mjs');
  const signal = new AbortController().signal;
  const tools = { setExecutor() {}, async execute(input) {
    assert.deepEqual(input, { calls: [{ type: 'tool-call', id: 'one', name: 'verify', arguments: '{"x":1}' }], signal });
    return { results: [{ callId: 'one', result: { isError: false, value: { x: 1 } } }] };
  } };
  assert.deepEqual(await executeTool(tools, 'verify', { x: 1 }, 'one', signal), { x: 1 });
  tools.execute = async () => ({ results: [] });
  await assert.rejects(executeTool(tools, 'verify', { x: 1 }, 'one', signal), /did not return a result/);
});
test('rejects extra and same-count renamed tools even if a snapshot claims tools_match', () => {
  for (const kind of ['extra','renamed']) {
    const summary = goodSummary();
    for (const stage of ['ready','verified']) {
      const names=summary.evidence[stage].isingq_tools;
      if(kind === 'renamed') names.pop();
      names.push('isingq_unexpected');
    }
    const result=evaluate(summary, EXPECTED);
    assert.equal(result.passed,false); assert.equal(result.checks.ready_tools,false); assert.equal(result.checks.tools_match,false);
  }
});
