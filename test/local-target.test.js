'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { Response } = require('undici'); const { LocalSolverTransport, prepareLocalTarget } = require('../packages/core/src/local-target');
const contract = { contract_id: 'fixture-contract-v1', source: 'isolated golden fixture only', matrix_mode: 'binary', result_domain: 'spin', csv_layout: 'qubo_upper_triangular', spin_to_bit: 'plus_is_one', max_dimension: 3, allowed_states: ['stable'], coefficient_min: -127, coefficient_max: 127, integer_coefficients: true, max_file_bytes: 1024 * 1024 };
const profile = { id: `local_${'a'.repeat(32)}`, revision: 1, name: 'Fixture A', api_base_url: 'http://fixture.test:8080/reverse', web_base_url: null, contract };
const probe = { config: { deviceName: 'fixture', version: '1', maxPrecision: '8bit', maxScale: 4095 }, runtime: { bootTimestamp: 1 }, status: { status: 'stable' } };
const matrix = { content: Buffer.from('-1,2\n0,-3\n'), qubo: { num_bits: 2, linear: [{ index: 0, coefficient: -1 }, { index: 1, coefficient: -3 }], quadratic: [{ i: 0, j: 1, coefficient: 2 }], offset: 8 } };
function json(data, code = 10000, status = 200) { return new Response(JSON.stringify({ code, msg: 'redacted-provider-message', data }), { status, headers: { 'content-type': 'application/json' } }); }
function transport(steps, p = profile) { const calls = []; const instance = new LocalSolverTransport({ profile: p, fetch: async (url, options) => { calls.push({ url, options }); const step = steps.shift(); assert.ok(step, 'unexpected request'); return typeof step === 'function' ? step(url, options) : step; } }); return { instance, calls }; }
test('local task mode defaults to precise and preserves explicit advanced values independently of maxPrecision', () => {
  for (const options of [undefined, {}, { task_mode: undefined }]) {
    assert.deepEqual(prepareLocalTarget(matrix, profile, probe, options).solver_options, { task_mode: 2 });
  }
  for (const options of [null, [], { task_mode: null }, { task_mode: '1' }, { task_mode: -1 }, { task_mode: 3 }]) {
    assert.throws(() => prepareLocalTarget(matrix, profile, probe, options), error => {
      assert.equal(error.code, 'local_options_invalid');
      assert.doesNotMatch(error.message, /必须显式选择|请.*选择/); return true;
    });
  }
  for (const task_mode of [0, 1, 2]) {
    const prepared = prepareLocalTarget(matrix, profile, probe, { task_mode });
    assert.deepEqual(prepared.solver_options, { task_mode });
    assert.equal(prepared.precision.reported_max_precision, '8bit');
    assert.equal(prepared.file.content.toString(), matrix.content.toString());
  }
});
test('local prepare uses standard encoding and verified state, preserving original CSV/offset and no cloud limits', () => { assert.equal(prepareLocalTarget(matrix, { ...profile, contract: undefined }, probe, { task_mode: 1 }).effective_contract.result_domain, 'binary'); assert.throws(() => prepareLocalTarget(matrix, profile, { ...probe, status: { status: 'unstable' } }, { task_mode: 1 }), { code: 'local_state_not_allowed' }); assert.throws(() => prepareLocalTarget(matrix, profile, probe, { task_mode: 1, gear: 1 }), { code: 'local_options_invalid' }); const p = prepareLocalTarget(matrix, profile, probe, { task_mode: 2 }); assert.equal(p.file.content.toString(), matrix.content.toString()); assert.equal(p.encoding.offset, 8); assert.equal(p.encoding.provider_energy_is_qubo, false); assert.deepEqual(p.solver_options, { task_mode: 2 }); assert.equal(p.capabilities.contract.max_dimension, 3); });
test('local coefficients, dimensions and explicitly known file limits reject rather than coerce', () => { assert.throws(() => prepareLocalTarget(matrix, { ...profile, contract: { ...contract, max_dimension: 1 } }, probe, { task_mode: 0 }), { code: 'local_dimension_exceeded' }); assert.throws(() => prepareLocalTarget(matrix, { ...profile, contract: { ...contract, coefficient_min: 0 } }, probe, { task_mode: 0 }), { code: 'local_coefficient_invalid' }); assert.throws(() => prepareLocalTarget(matrix, { ...profile, contract: { ...contract, max_file_bytes: 2 } }, probe, { task_mode: 0 }), { code: 'local_file_too_large' }); });
test('local probe only POSTs config/runtime/status preserving reverse prefix without cloud credential', async () => { const { instance, calls } = transport([json(probe.config), json(probe.runtime), json(probe.status)]); assert.deepEqual(await instance.probe(), probe); assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/reverse/api/device/config', '/reverse/api/device/runtime', '/reverse/api/device/status']); for (const c of calls) { assert.equal(c.options.method, 'POST'); assert.deepEqual(c.options.headers, { 'Content-Type': 'application/json' }); assert.equal(c.options.redirect, 'error'); } });
test('local create uses exactly multipart param+file and accepted is not finished', async () => { const { instance, calls } = transport([json({ taskId: '42', status: 'success' })]); const file = prepareLocalTarget(matrix, profile, probe, { task_mode: 1 }).file; assert.deepEqual(await instance.submit({ ...file, task_name: 'unique-fixture' }, { task_mode: 1 }), { task_id: '42' }); const form = calls[0].options.body; assert.deepEqual([...form.keys()], ['param', 'file']); assert.deepEqual(JSON.parse(form.get('param')), { taskName: 'unique-fixture', taskMode: 1, matrixMode: 'binary' }); assert.equal(await form.get('file').text(), matrix.content.toString()); assert.equal(calls[0].options.headers['Content-Type'], undefined); assert.equal(calls.length, 1); });
test('HTTP200 business failure is rejected; malformed/timeout creation remains unknown without retry or raw body leakage', async () => { for (const step of [json({}, 400), new Response('private-supersecret', { status: 500 }), () => { throw Error('private-supersecret'); }]) { const { instance, calls } = transport([step]); const file = { ...prepareLocalTarget(matrix, profile, probe, { task_mode: 1 }).file, task_name: 'fixture' }; await assert.rejects(instance.submit(file, { task_mode: 1 }), e => { assert.ok(!e.message.includes('private-supersecret')); assert.ok(['rejected', 'unknown'].includes(e.submissionOutcome)); return true; }); assert.equal(calls.length, 1); } });
test('local detail distinguishes queued/running/failed; finished independently reads and validates result and direction', async () => { for (const [status, expected] of [['pending', 'queued'], ['running', 'running'], ['failed', 'failed']]) { const { instance, calls } = transport([json({ taskId: '42', status })]); assert.equal((await instance.poll('42', 2)).status, expected); assert.equal(calls.length, 1); } const { instance, calls } = transport([json({ taskId: '42', status: 'finished' }), json({ ok: true, spin_config: [1, -1], energy: -123, isingCalcMs: 12 })]); const r = await instance.poll('42', 2); assert.equal(r.status, 'succeeded'); assert.deepEqual(r.bits, [1, 0]); assert.equal(r.provider_energy, -123); assert.equal(r.isingCalcMs, 12); assert.ok(calls[1].url.endsWith('/api/task/result')); const flipped = transport([json({ taskId: '42', status: 'finished' }), json({ ok: true, spin_config: [1, -1], energy: -1, isingCalcMs: 0 })], { ...profile, contract: { ...contract, spin_to_bit: 'minus_is_one' } }); assert.deepEqual((await flipped.instance.poll('42', 2)).bits, [0, 1]); });
test('missing results distinguish unavailable/cache from invalid vectors/energy/time', async () => { for (const [response, expected] of [[json({}, 10021), 'result_pending'], [json({}, 10020), 'result_invalid'], [json({ ok: true, spin_config: [0, 1], energy: 0, isingCalcMs: 1 }), 'result_invalid'], [json({ ok: true, spin_config: [1], energy: 0, isingCalcMs: 1 }), 'result_invalid'], [json({ ok: true, spin_config: [1, -1], energy: '0', isingCalcMs: 1 }), 'result_invalid'], [json({ ok: true, spin_config: [1, -1], energy: 0, isingCalcMs: -1 }), 'result_invalid']]) { const { instance } = transport([json({ taskId: '42', status: 'finished' }), response]); assert.equal((await instance.poll('42', 2)).status, expected); } });
test('credential callback is explicit local-only, synchronous, never profile-persisted and bound to original profile', () => { let seen; const instance = new LocalSolverTransport({ profile, credentialProvider: p => { seen = p; return { headers: { Authorization: 'Bearer fixture-local-token' } }; } }); assert.equal(instance.prepareSubmission().headers.Authorization, 'Bearer fixture-local-token'); assert.deepEqual(seen, profile); assert.equal(profile.Authorization, undefined); assert.throws(() => new LocalSolverTransport({ profile, credentialProvider: async () => ({}) }).prepareSubmission(), { code: 'local_credentials_invalid' }); assert.throws(() => new LocalSolverTransport({ profile, credentialProvider: () => ({ headers: { 'X-API-Key': 'cloud-key' } }) }).prepareSubmission(), { code: 'local_credentials_invalid' }); });
test('directly supplied credentials cannot bypass cloud-header protection', async () => { const { instance, calls } = transport([json({ taskId: '42', status: 'success' })]); const file = { ...prepareLocalTarget(matrix, profile, probe, { task_mode: 1 }).file, task_name: 'fixture' }; await assert.rejects(instance.submit(file, { task_mode: 1 }, { headers: { 'X-API-Key': 'cloud-secret' } }), { code: 'local_credentials_invalid' }); assert.equal(calls.length, 0); });
test('finished with malformed result JSON is result_invalid rather than task failure', async () => { const { instance } = transport([json({ taskId: '42', status: 'finished' }), new Response('corrupted result')]); assert.equal((await instance.poll('42', 2)).status, 'result_invalid'); });
test('result file unreadable/corrupt provider codes remain result_invalid and creation internal errors remain unknown', async () => { for (const code of [10022, 10023]) { const { instance } = transport([json({ taskId: '42', status: 'finished' }), json({}, code)]); assert.equal((await instance.poll('42', 2)).status, 'result_invalid'); } const { instance } = transport([json({}, 500)]); await assert.rejects(instance.submit({ ...prepareLocalTarget(matrix, profile, probe, { task_mode: 1 }).file, task_name: 'fixture' }, { task_mode: 1 }), e => e.submissionOutcome === 'unknown'); });
test('credential callback exceptions cannot leak local authentication secrets', () => { const instance = new LocalSolverTransport({ profile, credentialProvider: () => { throw Error('supersecret-auth'); } }); assert.throws(() => instance.prepareSubmission(), e => e.code === 'local_credentials_invalid' && !e.message.includes('supersecret-auth')); });
test('local transport serializes real multipart against isolated loopback fixture without alternate endpoints', async t => { const nodeHttp = require('node:http'); const seen = []; const server = nodeHttp.createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 10000, data: { taskId: 'fixture-transport', status: 'success' } })); }); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.close(); server.closeAllConnections(); }); const instance = new LocalSolverTransport({ profile: { ...profile, api_base_url: `http://127.0.0.1:${server.address().port}/prefix` } }); const r = await instance.submit({ ...prepareLocalTarget(matrix, profile, probe, { task_mode: 1 }).file, task_name: 'fixture-real-http' }, { task_mode: 1 }); assert.equal(r.task_id, 'fixture-transport'); assert.equal(seen.length, 1); assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].url, '/prefix/api/task/create'); assert.match(seen[0].headers['content-type'], /^multipart\/form-data; boundary=/); assert.match(seen[0].body, /name="param"/); assert.match(seen[0].body, /"taskMode":1,"matrixMode":"binary"/); assert.match(seen[0].body, /name="file"; filename="matrix.csv"/); assert.match(seen[0].body, /-1,2\n0,-3/); assert.doesNotMatch(seen[0].body, /onlyLoad|computerType|postProcess|credit|gear/); assert.equal(seen[0].headers.authorization, undefined); });

test('undeclared limits do not become fabricated constraints; explicit coefficient rules still reject', () => {
  for (const field of ['coefficient_min', 'coefficient_max', 'integer_coefficients', 'max_file_bytes']) {
    const partial = { ...contract }; delete partial[field];
    const prepared = prepareLocalTarget(matrix, { ...profile, contract: partial }, probe, { task_mode: 1 });
    assert.equal(prepared.declared_constraints[field].status, 'not_declared');
  }
  assert.doesNotThrow(() => prepareLocalTarget(matrix, { ...profile, contract: { ...contract, integer_coefficients: false } }, probe, { task_mode: 1 }));
  const oversized = { ...matrix, qubo: { ...matrix.qubo, linear: [{ index: 0, coefficient: 1e100 }] } };
  assert.throws(() => prepareLocalTarget(oversized, profile, probe, { task_mode: 1 }), { code: 'local_coefficient_invalid' });
});
test('local decimal step is exact from zero and never quantizes or epsilon-rounds the input', () => {
  const stepped = { ...profile, contract: { ...contract, integer_coefficients: false, coefficient_step: 0.1 } };
  const m = value => ({ content: Buffer.from(`${value},2\n0,-3\n`), qubo: { ...matrix.qubo, linear: [{ index: 0, coefficient: value }, { index: 1, coefficient: -3 }] } });
  for (const value of [0, 0.3, -0.3, 127, -127]) {
    const input = m(value); const prepared = prepareLocalTarget(input, stepped, probe, { task_mode: 1 });
    assert.equal(prepared.file.content.toString(), input.content.toString());
    assert.equal(input.qubo.linear[0].coefficient, value);
  }
  for (const value of [0.15, 0.30000000000000004, 127.1, -127.1]) assert.throws(() => prepareLocalTarget(m(value), stepped, probe, { task_mode: 1 }), { code: 'local_coefficient_invalid' });
  const scientific = { ...stepped, contract: { ...stepped.contract, coefficient_step: 1e-7 } };
  assert.doesNotThrow(() => prepareLocalTarget(m(3e-7), scientific, probe, { task_mode: 1 }));
  assert.throws(() => prepareLocalTarget(m(3.01e-7), scientific, probe, { task_mode: 1 }), { code: 'local_coefficient_invalid' });
  const integerAndStep = { ...profile, contract: { ...contract, coefficient_step: 2 } };
  assert.throws(() => prepareLocalTarget(matrix, integerAndStep, probe, { task_mode: 1 }), { code: 'local_coefficient_invalid' });
});
test('submit rejects unknown encoding semantics and explicit oversized bytes before sending any device request', async () => {
  const unknown = { ...contract, csv_layout: 'unknown' };
  const missing = transport([], { ...profile, contract: unknown });
  await assert.rejects(missing.instance.submit({ content: matrix.content, format: 'csv', task_name: 'not-sent' }, { task_mode: 1 }), e => e.code === 'local_encoding_unsupported' && e.submissionOutcome === 'not_created');
  assert.equal(missing.calls.length, 0);
  const bounded = transport([], { ...profile, contract: { ...contract, max_file_bytes: matrix.content.length - 1 } });
  await assert.rejects(bounded.instance.submit({ content: matrix.content, format: 'csv', task_name: 'not-sent' }, { task_mode: 1 }), e => e.code === 'local_file_too_large' && e.submissionOutcome === 'not_created');
  assert.equal(bounded.calls.length, 0);
  assert.doesNotThrow(() => prepareLocalTarget(matrix, { ...profile, contract: { ...contract, max_file_bytes: matrix.content.length } }, probe, { task_mode: 1 }));
});
test('mandatory zero CSV entries obey the explicit coefficient range and prior complete encoding remains queryable', async () => {
  assert.throws(() => prepareLocalTarget({ ...matrix, qubo: { ...matrix.qubo, linear: [{ index: 0, coefficient: 2 }] } }, { ...profile, contract: { ...contract, coefficient_min: 1 } }, probe, { task_mode: 1 }), { code: 'local_coefficient_invalid' });
  const historicalContract = { ...contract }; delete historicalContract.max_file_bytes; delete historicalContract.integer_coefficients;
  const { instance } = transport([json({ taskId: '42', status: 'finished' }), json({ ok: true, spin_config: [1, -1], energy: 0, isingCalcMs: 1 })], { ...profile, contract: historicalContract });
  assert.deepEqual((await instance.poll('42', 2)).bits, [1, 0]);
});
test('current device maxScale independently constrains verified contract dimensions and cannot be bypassed by confirmation', () => {
  const largerContract = { ...profile, contract: { ...contract, max_dimension: 4 } };
  const smallerDevice = { ...probe, config: { ...probe.config, maxScale: 1 } };
  assert.throws(() => prepareLocalTarget(matrix, largerContract, smallerDevice, { task_mode: 1 }), e => e.code === 'local_device_dimension_exceeded' && /dimension=2/.test(e.message) && /maxScale=1/.test(e.message) && /max_dimension=4/.test(e.message));
  assert.doesNotThrow(() => prepareLocalTarget(matrix, largerContract, { ...probe, config: { ...probe.config, maxScale: 2 } }, { task_mode: 1 }));
  assert.throws(() => prepareLocalTarget(matrix, { ...profile, contract: { ...contract, max_dimension: 1 } }, probe, { task_mode: 1 }), { code: 'local_dimension_exceeded' });
});
test('unknown, noninteger or nonpositive current device maxScale cannot establish preparation readiness', async () => {
  for (const maxScale of [undefined, null, 0, -1, 1.5, '4095', Infinity, NaN]) {
    const config = { ...probe.config, maxScale };
    assert.throws(() => prepareLocalTarget(matrix, profile, { ...probe, config }, { task_mode: 1 }), { code: 'local_probe_invalid' });
    const { instance } = transport([json(config), json(probe.runtime), json(probe.status)]);
    await assert.rejects(instance.probe(), { code: 'local_probe_invalid' });
  }
});
test('offline replay of real binary task7007 accepts spin_config as bits without relabelling provider energy', async () => {
  // Recorded by root in evidence/device-binary-golden/execution.json; this is
  // an offline replay only, never a request to the real device/task.
  const response = { ok: true, msg: 'success', spin_config: [0, 1], energy: -2, isingCalcMs: 390 };
  const basic = { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' };
  const { instance, calls } = transport([json({ taskId: '7007', status: 'finished' }), json(response)], basic);
  const result = await instance.poll('7007', 2);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result_domain, 'binary');
  assert.deepEqual(result.bits, [0, 1]);
  assert.deepEqual(result.spin_config, [0, 1]);
  assert.equal(result.spins, undefined);
  assert.equal(result.provider_energy, -2);
  assert.equal(result.energy, -2);
  assert.equal(result.device_compute_ms, 390);
  const { objectiveEnergy } = require('../packages/core/src/qubo');
  const qubo = { num_bits: 2, linear: [{ index: 0, coefficient: -3 }, { index: 1, coefficient: -2 }], quadratic: [{ i: 0, j: 1, coefficient: 4 }], offset: 3 };
  assert.equal(objectiveEnergy(qubo, result.bits), 1);
  assert.equal(calls.length, 2);
});
test('all-one output follows the submitted result-domain contract instead of guessing its vector domain', async () => {
  for (const result_domain of [undefined, 'binary', 'spin']) {
    const c = { ...contract, spin_to_bit: 'minus_is_one' }; if (result_domain) c.result_domain = result_domain; else delete c.result_domain;
    const { instance } = transport([json({ taskId: '42', status: 'finished' }), json({ ok: true, spin_config: [1, 1], energy: 2, isingCalcMs: 1 })], { ...profile, contract: c });
    const result = await instance.poll('42', 2);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result_domain, result_domain || 'binary');
    assert.deepEqual(result.bits, result_domain === 'spin' ? [0, 0] : [1, 1]);
    assert.deepEqual(result.spin_config, [1, 1]);
    if (result_domain === 'spin') assert.deepEqual(result.spins, [1, 1]); else assert.equal(result.spins, undefined);
  }
});
test('binary and explicit spin result domains reject the opposite vector without silent fallback', async () => {
  for (const [domain, vector] of [['binary', [-1, 1]], ['spin', [0, 1]]]) {
    const { instance } = transport([json({ taskId: '42', status: 'finished' }), json({ ok: true, spin_config: vector, energy: 0, isingCalcMs: 1 })], { ...profile, contract: { ...contract, result_domain: domain } });
    assert.equal((await instance.poll('42', 2)).status, 'result_invalid');
  }
});
test('standard binary preparation records its domain and distinguishes absent file declarations', () => {
  const c = { ...contract }; delete c.result_domain;
  const prepared = prepareLocalTarget(matrix, { ...profile, contract: c }, probe, { task_mode: 1 });
  assert.equal(prepared.encoding.result_domain, 'binary');
  const incomplete = { ...c }; delete incomplete.max_file_bytes;
  assert.equal(prepareLocalTarget(matrix, { ...profile, contract: incomplete }, probe, { task_mode: 1 }).declared_constraints.max_file_bytes.status, 'not_declared');
});
test('name-and-URL-only profile uses versioned standard binary preparation and submit without private capability declarations', async () => {
  const basic = { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' };
  const prepared = prepareLocalTarget(matrix, basic, probe, { task_mode: 1 });
  assert.equal(prepared.adapter_version, 'ising-control-http-v1');
  assert.deepEqual(prepared.effective_contract.allowed_states, ['stable']);
  assert.equal(prepared.effective_contract.matrix_mode, 'binary');
  assert.equal(prepared.effective_contract.result_domain, 'binary');
  assert.equal(prepared.effective_contract.csv_layout, 'qubo_upper_triangular');
  assert.equal(prepared.effective_contract.max_dimension, probe.config.maxScale);
  assert.equal(prepared.effective_contract.spin_to_bit, undefined);
  const { normalizeContract } = require('../packages/core/src/solver-profiles');
  assert.deepEqual(normalizeContract(prepared.effective_contract), prepared.effective_contract);
  const { instance, calls } = transport([json({ taskId: 'standard-fixture', status: 'success' })], basic);
  assert.deepEqual(await instance.submit({ ...prepared.file, task_name: 'standard-fixture' }, prepared.solver_options), { task_id: 'standard-fixture' });
  assert.deepEqual(JSON.parse(calls[0].options.body.get('param')), { taskName: 'standard-fixture', taskMode: 1, matrixMode: 'binary' });
});
test('unreported provider limits stay explicit metadata rather than invented 8bit upload constraints', () => {
  const basic = { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' };
  const { matrixDocument } = require('../packages/core/src/qubo');
  const actual = matrixDocument({ num_bits: 1, linear: [{ index: 0, coefficient: 1e100 }], offset: 0 });
  const prepared = prepareLocalTarget(actual, basic, probe, { task_mode: 1 });
  assert.equal(prepared.file.content.toString(), '1e+100\n');
  for (const field of ['coefficient_min', 'coefficient_max', 'integer_coefficients', 'coefficient_step', 'max_file_bytes']) {
    assert.equal(prepared.effective_contract[field], undefined);
    assert.equal(prepared.declared_constraints[field].status, 'not_declared');
    assert.equal(prepared.declared_constraints[field].responsibility, 'provider_managed');
  }
  assert.equal(prepared.precision.reported_max_precision, '8bit');
  assert.equal(prepared.precision.client_quantization, 'none');
  assert.equal(prepared.precision.lossless_guaranteed, false);
  assert.equal(prepared.client_capacity.scope, 'client_runtime');
  assert.ok(prepared.client_capacity.max_file_bytes > 0);
});
test('standard semantics still block unsupported layouts, missing spin mapping, unstable state and client capacity', () => {
  const basic = { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' };
  for (const override of [{ csv_layout: 'unknown' }, { matrix_mode: 'spin' }]) assert.throws(() => prepareLocalTarget(matrix, { ...basic, contract: override }, probe, { task_mode: 1 }), { code: 'local_encoding_unsupported' });
  assert.throws(() => prepareLocalTarget(matrix, { ...basic, contract: { result_domain: 'spin' } }, probe, { task_mode: 1 }), { code: 'local_contract_required' });
  assert.throws(() => prepareLocalTarget(matrix, basic, { ...probe, status: { status: 'debugging' } }, { task_mode: 1 }), { code: 'local_state_not_allowed' });
  const explicit = prepareLocalTarget(matrix, { ...basic, contract: { allowed_states: ['debugging'], max_dimension: 2 } }, { ...probe, status: { status: 'debugging' } }, { task_mode: 1 });
  assert.deepEqual(explicit.effective_contract.allowed_states, ['debugging']);
  assert.equal(explicit.effective_contract.max_dimension, 2);
  assert.throws(() => prepareLocalTarget(matrix, basic, probe, { task_mode: 1 }, { environment: { ISINGQ_MAX_LOCAL_FILE_BYTES: '2' } }), { code: 'local_client_file_too_large' });
});
test('standard defaults still require finite structured QUBO and protect direct submit client capacity', async () => {
  const basic = { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' };
  for (const qubo of [
    { ...matrix.qubo, offset: Infinity },
    { ...matrix.qubo, linear: [{ index: 0, coefficient: NaN }] },
    { ...matrix.qubo, linear: [{ index: 2, coefficient: 1 }] },
    { ...matrix.qubo, linear: [{ index: 0, coefficient: 1 }, { index: 0, coefficient: 2 }] },
  ]) assert.throws(() => prepareLocalTarget({ ...matrix, qubo }, basic, probe, { task_mode: 1 }), { code: 'local_matrix_invalid' });
  let calls = 0;
  const limited = new LocalSolverTransport({ profile: basic, environment: { ISINGQ_MAX_LOCAL_FILE_BYTES: '2' }, fetch: async () => { calls++; throw Error('must not send'); } });
  await assert.rejects(limited.submit({ content: matrix.content, format: 'csv', task_name: 'client-limit-fixture' }, { task_mode: 1 }), e => e.code === 'local_client_file_too_large' && e.submissionOutcome === 'not_created');
  assert.equal(calls, 0);
});
test('single declared bounds remain independent and effective rules survive JSON snapshot normalization', () => {
  const basic = { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' };
  const prepared = prepareLocalTarget(matrix, { ...basic, contract: { coefficient_min: -4 } }, probe, { task_mode: 1 });
  assert.equal(prepared.effective_contract.coefficient_min, -4);
  assert.equal(prepared.effective_contract.coefficient_max, undefined);
  assert.equal(prepared.declared_constraints.coefficient_min.value, -4);
  assert.equal(prepared.declared_constraints.coefficient_max.status, 'not_declared');
  const restored = JSON.parse(JSON.stringify(prepared.effective_contract));
  const again = prepareLocalTarget(matrix, { ...basic, contract: restored }, probe, { task_mode: 1 });
  assert.deepEqual(again.effective_contract, prepared.effective_contract);
  assert.throws(() => prepareLocalTarget(matrix, { ...basic, contract: { coefficient_min: -2 } }, probe, { task_mode: 1 }), { code: 'local_coefficient_invalid' });
});
test('missing display-only maxPrecision does not block an otherwise verified standard device', async () => {
  const config = { ...probe.config }; delete config.maxPrecision;
  const { instance } = transport([json(config), json(probe.runtime), json(probe.status)], { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' });
  const actual = await instance.probe();
  const prepared = prepareLocalTarget(matrix, { name: '标准伊辛机', api_base_url: 'http://fixture.test:8080' }, actual, { task_mode: 1 });
  assert.equal(prepared.precision.reported_max_precision, null);
  assert.equal(prepared.declared_constraints.coefficient_step.status, 'not_declared');
});
