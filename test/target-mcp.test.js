'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

test('real MCP stdio process records explicit local choice, defers results and keeps deleted-profile history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-target-mcp-'));
  const requests = [], multipart = [];
  let details = 0, results = 0;
  const fixture = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ route: req.url, method: req.method, authorization: req.headers.authorization || null });
    let data;
    if (req.url === '/api/device/config') data = { deviceName: 'isolated fixture', version: 'fixture-1', maxScale: 2049, maxPrecision: '8bit' };
    else if (req.url === '/api/device/runtime') data = { bootTimestamp: 1 };
    else if (req.url === '/api/device/status') data = { status: 'stable' };
    else if (req.url === '/api/task/create') {
      multipart.push(body);
      assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
      data = { taskId: 'fixture-task', status: 'success' };
    } else if (req.url === '/api/task/detail') data = { taskId: 'fixture-task', status: ++details === 1 ? 'running' : 'finished' };
    else if (req.url === '/api/task/result') {
      if (++results === 1) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 10021, data: {}, msg: 'result not available' }));
        return;
      }
      data = { taskName: 'fixture', ok: true, spin_config: [1, -1], energy: -100, isingCalcMs: 3 };
    } else { res.writeHead(404); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 10000, data }));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const base = 'http://127.0.0.1:' + fixture.address().port;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/isingq-mcp.js'), 'serve', '--technical'], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'), ISINGQ_UPDATE_CHECK: 'off', ISINGQ_API_KEY: 'synthetic-cloud-key-not-for-local' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const pending = new Map(); let seq = 0, stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { assert.fail('MCP stdout contains non-JSON output'); }
    const callback = pending.get(response.id);
    if (callback) { pending.delete(response.id); callback(response); }
  });
  async function rpc(method, params) {
    const id = ++seq;
    const timeout = setTimeout(() => { pending.get(id)?.({ error: { message: 'MCP response timed out: ' + stderr } }); }, 5000);
    try {
      return await new Promise(resolve => { pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    } finally { clearTimeout(timeout); pending.delete(id); }
  }
  async function call(name, args = {}) {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result.structuredContent;
  }
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.match(initialized.result.instructions, /target_submit/);
  assert.match(initialized.result.instructions, /preparation_token/);
  const listed = await rpc('tools/list');
  for (const name of ['isingq_solver_targets_list', 'isingq_target_solve_prepare', 'isingq_target_solve_start', 'isingq_solver_config_open', 'isingq_solve_records_list']) {
    assert.ok(listed.result.tools.some(tool => tool.name === name), name);
  }
  const contract = { contract_id: 'fixture-only', source: 'isolated test reference; not a hardware contract', matrix_mode: 'binary',
    csv_layout: 'qubo_upper_triangular', spin_to_bit: 'plus_is_one', max_dimension: 2049, allowed_states: ['stable'],
    coefficient_min: -127, coefficient_max: 127, integer_coefficients: true, max_file_bytes: 1048576, result_domain: 'spin' };
  const saved = await call('isingq_solver_profiles_save', { profile: { name: 'fixture local', api_base_url: base,
    web_base_url: base + '/device-ui', contract } });
  assert.equal(saved.ok, true);
  const edited = await call('isingq_solver_profiles_save', { profile: { ...saved.data, name: 'updated fixture local' } });
  assert.equal(edited.ok, true);
  const profile = edited.data;
  assert.equal(profile.revision, 2);
  for (const [revision, code] of [[undefined, 'profile_revision_invalid'], [null, 'profile_revision_invalid'], [saved.data.revision, 'profile_revision_conflict']]) {
    const rejected = await call('isingq_solver_profiles_save', { profile: { ...saved.data, revision } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, code);
  }
  const choices = await call('isingq_solver_targets_list', { include_cloud: false });
  assert.equal(choices.data.local.profiles[0].id, profile.id);
  assert.equal(choices.data.local.profiles[0].name, profile.name);
  assert.equal(choices.data.local.profiles[0].revision, profile.revision);
  assert.equal(requests.length, 0, 'saving/listing never contacts device or cloud');
  const qubo = { num_bits: 2, linear: [{ index: 0, coefficient: -3 }, { index: 1, coefficient: -2 }],
    quadratic: [{ i: 0, j: 1, coefficient: 4 }], offset: 3 };
  const input = { target: { kind: 'local', profile_id: profile.id }, qubo, solver_options: { task_mode: 0 } };
  const preparation = await call('isingq_target_solve_prepare', input);
  assert.equal(preparation.data.ready, true);
  assert.equal(preparation.data.advice_is_optional, true);
  assert.equal(multipart.length, 0, 'preparation is not submission');
  const args = { ...input, preparation_token: preparation.data.preparation_token, model_summary: 'two-variable fixture', idempotency_key: 'one-fixture-call' };
  const started = await call('isingq_target_solve_start', args);
  assert.equal(started.ok, true);
  assert.equal(started.data.status, 'submitted');
  const id = started.data.solve_id;
  const replay = await call('isingq_target_solve_start', args);
  assert.equal(replay.data.solve_id, id);
  assert.equal(multipart.length, 1);
  assert.match(multipart[0], /-3,4\n0,-2\n/);
  assert.match(multipart[0], /"taskMode":0/);
  assert.doesNotMatch(multipart[0], /useCredit|computerTypeId|synthetic-cloud-key/);
  await call('isingq_solver_profiles_delete', { profile_id: profile.id });
  const running = await call('isingq_solve_poll', { solve_id: id });
  assert.equal(running.data.status, 'running');
  const deferred = await call('isingq_solve_poll', { solve_id: id });
  assert.equal(deferred.data.status, 'result_pending');
  const finished = await call('isingq_solve_poll', { solve_id: id });
  assert.equal(finished.data.status, 'succeeded');
  assert.deepEqual(finished.data.result.bits, [1, 0]);
  assert.equal(finished.data.result.objective_value, 0);
  assert.equal(finished.data.result.provider_energy, -100);
  assert.equal(finished.data.view.url, base + '/device-ui');
  assert.equal(finished.data.provenance.source, 'local_ising_http');
  assert.equal(requests.every(req => req.authorization === null), true);
  const records = await call('isingq_solve_records_list', { limit: 1, offset: 0 });
  assert.equal(records.data.total, 1);
  assert.equal(records.data.records[0].solve_id, id);
  const delivery = await call('isingq_target_delivery_validate', { solve_id: id,
    document: { qubo, candidate_bits: [1, 0], claimed_objective_value: 0 } });
  assert.equal(delivery.ok, true);
  assert.equal(multipart.length, 1, 'all subsequent reads and delivery reuse original task');
});
