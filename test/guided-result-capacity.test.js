'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SolverService } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { createHandler } = require('../src/server');
const { channelAllocation } = require('./fixtures/solver-scale');

function originalRecord(t, sample, bits = sample.bits) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-review-capacity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { XDG_DATA_HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config') };
  const store = new SolveStore(environment), counts = { transport: 0 };
  const forbidden = () => { counts.transport++; throw Error('SOLVER_ACCESS_FORBIDDEN'); };
  const record = { solve_id: 'solve_0123456789abcdef0123456789abcdef', status: 'succeeded', execution_mode: 'simulation',
    idempotency_digest: '0'.repeat(64), request_digest: '1'.repeat(64),
    target: { kind: 'local', name: '4095位隔离验收记录' }, qubo: sample.qubo,
    result: { bits, objective_value: sample.energy(bits) } };
  store.save(record);
  const before = fs.readFileSync(store.path(record.solve_id));
  const service = new SolverService({ store, transport: { submit: forbidden, poll: forbidden, prepareSubmission: forbidden },
    targetOptions: { environment, localTransportFactory: forbidden, catalogClientFactory: forbidden } });
  const handler = createHandler(service);
  const call = async review => (await handler({ method: 'tools/call', params: { name: 'isingq_solve',
    arguments: { action: 'review', solve_id: record.solve_id, review } } })).structuredContent.data;
  const unchanged = () => { assert.deepEqual(counts, { transport: 0 }); assert.deepEqual(fs.readFileSync(store.path(record.solve_id)), before); };
  return { call, unchanged, record, environment, directory };
}

test('4095 actual business variables, 4094 real constraints and 81898 terms complete ordinary MCP review', async t => {
  const started = performance.now();
  const sample = channelAllocation();
  assert.equal(sample.model.variables.length, 4095); assert.equal(sample.model.constraints.length, 4094); assert.equal(sample.total_terms, 81898);
  const f = originalRecord(t, sample);
  const result = await f.call({ model: sample.model, data: sample.data, baseline: sample.baseline });
  assert.equal(result.status, 'result_reviewed', JSON.stringify(result.review?.issue));
  assert.equal(result.review.status, 'feasible');
  assert.equal(result.review.objective.value, sample.score(sample.bits));
  assert.equal(result.result.objective, sample.energy(sample.bits));
  assert.equal(result.review.decisions.length, 4095); assert.equal(result.review.decisions.at(-1).variable, 'x_4094');
  assert.equal(result.review.constraints.length, 4094); assert.ok(result.review.constraints.every(item => item.passed));
  assert.equal(result.review.baseline.improvement, 0);
  assert.match(result.reply, /另有 4055 项/); assert.match(result.reply, /另有 4054 项/);
  f.unchanged();
  t.diagnostic(JSON.stringify({ variables: 4095, constraints: 4094, total_terms: sample.total_terms,
    input_bytes: result.review.capacity.input_bytes, max_input_bytes: result.review.capacity.max_input_bytes,
    objective: result.review.objective.value, qubo_objective: result.result.objective,
    duration_ms: Math.round(performance.now() - started), peak_rss_bytes: process.resourceUsage().maxRSS * 1024 }));
});

test('4095-variable review checks the final real constraint after the visible table is truncated', async t => {
  const sample = channelAllocation(), bits = [...sample.bits]; bits[4094] = 1;
  const f = originalRecord(t, sample, bits), result = await f.call({ model: sample.model, data: sample.data, baseline: sample.baseline });
  assert.equal(result.status, 'result_reviewed', JSON.stringify(result.review?.issue));
  assert.equal(result.review.status, 'infeasible');
  assert.equal(result.review.objective.value, sample.score(bits));
  assert.equal(result.review.constraints.at(-1).passed, false); assert.equal(result.review.constraints.at(-1).actual, 2);
  assert.equal(result.review.baseline.status, 'not_comparable'); assert.equal(result.review.baseline.improvement, undefined);
  assert.match(result.reply, /关键相邻设备4094与4095分开/);
  f.unchanged();
});

test('4095-variable review preserves and exposes the final business-domain failure', async t => {
  const sample = channelAllocation(), f = originalRecord(t, sample);
  sample.model.variables.at(-1).domain = 'integer'; sample.model.variables.at(-1).lower = 1; sample.model.variables.at(-1).upper = 1;
  const result = await f.call({ model: sample.model, data: sample.data });
  assert.equal(result.status, 'result_reviewed'); assert.equal(result.review.status, 'infeasible');
  assert.equal(result.review.decisions.at(-1).within_domain, false);
  assert.match(result.reply, /AP4095.*0.*1.*不满足/);
  f.unchanged();
});

test('a real stdio MCP process completes the full 4095-variable model using only the saved record', t => {
  const sample = channelAllocation(), f = originalRecord(t, sample), countFile = path.join(f.directory, 'network-count.json');
  const guard = path.join(f.directory, 'deny-network.cjs');
  fs.writeFileSync(guard, `const fs=require('node:fs');let calls=0;const deny=()=>{calls++;throw Error('NETWORK_FORBIDDEN');};
    require('node:net').Socket.prototype.connect=deny;
    for(const name of ['node:http','node:https']){const api=require(name);api.request=deny;api.get=deny;}
    globalThis.fetch=deny;
    process.on('exit',()=>fs.writeFileSync(${JSON.stringify(countFile)},JSON.stringify({calls})));\n`);
  const request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'isingq_solve', arguments: {
    action: 'review', solve_id: f.record.solve_id, review: { model: sample.model, data: sample.data, baseline: sample.baseline } } } };
  const response = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/isingq-mcp.js'), 'serve'], {
    input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: f.directory, ...f.environment, ISINGQ_UPDATE_CHECK: 'off', NODE_OPTIONS: `--require ${JSON.stringify(guard)}` } });
  assert.equal(response.status, 0, response.stderr || response.error?.message);
  const result = JSON.parse(response.stdout.trim()).result.structuredContent.data;
  assert.equal(result.status, 'result_reviewed', JSON.stringify(result.review?.issue));
  assert.equal(result.review.objective.value, sample.score(sample.bits));
  assert.equal(result.review.decisions.length, 4095); assert.equal(result.review.constraints.length, 4094);
  assert.deepEqual(JSON.parse(fs.readFileSync(countFile, 'utf8')), { calls: 0 }); f.unchanged();
});

test('aggregate mapping byte boundary is exact and capacity changes allow retry of the same saved candidate', async t => {
  const sample = channelAllocation(15), f = originalRecord(t, sample), setting = 'ISINGQ_MAX_VERIFICATION_INPUT_BYTES';
  const spec = { model: { schema_version: 'math-model-v1', id: 'aggregate-mapping', variables: ['a', 'b'].map(id => ({ id, domain: 'binary' })),
    objective: { sense: 'min', expression: { terms: [] } }, constraints: [] }, data: {},
    bindings: Object.fromEntries(['a', 'b'].map(id => [id, { terms: Array.from({ length: 100 }, () => ({ coefficient: 0, variables: ['x_0'] })) }])) };
  const bytes = Buffer.byteLength(JSON.stringify(spec)), before = JSON.stringify(spec), previous = process.env[setting];
  try {
    process.env[setting] = String(bytes - 1);
    const blocked = await f.call(spec);
    assert.equal(blocked.status, 'review_blocked'); assert.equal(blocked.review.scope, 'unverified');
    assert.equal(blocked.review.issue.code, 'unsupported_size'); assert.equal(blocked.review.issue.field, 'verification.input_bytes');
    assert.equal(blocked.review.objective, undefined); assert.match(blocked.reply, /不删减业务条件、不重新求解/);
    f.unchanged();
    process.env[setting] = String(bytes);
    const checked = await f.call(spec);
    assert.equal(checked.status, 'result_reviewed', JSON.stringify(checked.review?.issue));
    assert.equal(checked.review.capacity.input_bytes, bytes); assert.equal(checked.review.objective.value, 0);
    assert.equal(JSON.stringify(spec), before); f.unchanged();
    process.env[setting] = 'invalid';
    const invalid = await f.call(spec);
    assert.equal(invalid.status, 'review_blocked'); assert.equal(invalid.review.issue.code, 'verification_capacity_invalid');
    assert.equal(invalid.review.objective, undefined); f.unchanged();
  } finally {
    if (previous === undefined) delete process.env[setting]; else process.env[setting] = previous;
  }
});
