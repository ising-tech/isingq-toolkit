'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('undici');
const { CloudCatalogClient, CloudTargetTransport, prepareCloudTarget, recommendCloudTargets, compatibilityIssues, validateCatalog } = require('../packages/core/src/cloud-target');
const { IsingQTransport, IsingQError } = require('../packages/core/src/isingq');
const { matrixDocument } = require('../packages/core/src/qubo');
const clone = value => JSON.parse(JSON.stringify(value));
const entry = { id: 8, name: null, spinNumber: '9999', price: 20, computeCreditCost: 3, executionCapabilities: { problemTypes: ['qubo'], minDimension: 2, maxDimension: 4, inputFormats: ['csv', 'npz'], maxCalculateCount: 3, supportsH: false, fixedPostProcess: 1 } };
const catalog = { schemaVersion: 1, uploadLimits: { maxCsvBytes: 1024 }, computerTypes: [entry, { ...entry, id: 9, executionCapabilities: null }] };
const opts = { post_process: 1, use_credit: false };
const matrix = n => matrixDocument({ num_bits: n, linear: [{ index: 0, coefficient: -1.5 }] });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function transport(responses, calls = [], extra = {}) {
  return new CloudTargetTransport({ apiKey: () => 'private-fixture-key', baseUrl: 'https://isolated.example/prefix', fetch: async (url, options) => { calls.push({ url, options }); const response = responses.shift(); if (response instanceof Error) throw response; assert.ok(response, 'unexpected extra HTTP request'); return response; }, ...extra });
}
const file = () => ({ ...prepareCloudTarget(matrix(2), entry, catalog, opts).file, task_name: 'unique-call-1' });
const submissionOptions = { ...opts, computer_type_id: 8, calculate_count: 2 };

test('anonymous fresh catalogue validates original schema and never reads or forwards credentials/channel/cookie', async () => {
  const calls = [];
  const client = new CloudCatalogClient({ baseUrl: 'https://isolated.example/api', fetch: async (url, options) => { calls.push({ url, options }); return json(catalog); } });
  assert.deepEqual(await client.get(), catalog); await client.get();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://isolated.example/api/public/computer-types');
  for (const { options } of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.ok(!Object.keys(options.headers).some(key => /authorization|cookie|channel/i.test(key)));
  }
});

test('empty catalogue differs from 503, malformed schema, duplicate ids and unsupported versions', async () => {
  assert.deepEqual(validateCatalog({ ...catalog, computerTypes: [] }).computerTypes, []);
  for (const mutate of [c => c.schemaVersion = 2, c => delete c.uploadLimits.maxCsvBytes, c => c.computerTypes.push(c.computerTypes[0]), c => c.computerTypes[0].price = '20', c => c.computerTypes[0].executionCapabilities.fixedPostProcess = true, c => delete c.computerTypes[0].executionCapabilities, c => c.computerTypes[0].executionCapabilities.maxDimension = 0, c => c.computerTypes[0].executionCapabilities.problemTypes = [1]]) {
    const fixture = clone(catalog); mutate(fixture); assert.throws(() => validateCatalog(fixture), error => error.code === 'CATALOGUE_SCHEMA_INVALID');
  }
  const client = new CloudCatalogClient({ baseUrl: 'https://isolated.example', fetch: async () => new Response('<html>internal error</html>', { status: 503 }) });
  await assert.rejects(client.get(), error => error.status === 503 && !error.message.includes('internal'));
});

test('429 Retry-After is propagated and prevents further request during backoff without parsing gateway bodies', async () => {
  let calls = 0;
  const client = new CloudCatalogClient({ baseUrl: 'https://isolated.example', fetch: async () => { calls++; return new Response('not JSON', { status: 429, headers: { 'Retry-After': '60' } }); } });
  await assert.rejects(client.get(), error => error.status === 429 && error.retryAfterSeconds === 60);
  await assert.rejects(client.get(), error => error.code === 'CATALOGUE_RATE_LIMITED' && error.retryAfterSeconds > 0);
  assert.equal(calls, 1);
  const noHeader = new CloudCatalogClient({ baseUrl: 'https://isolated.example', fetch: async () => new Response('gateway', { status: 429 }) });
  await assert.rejects(noHeader.get(), error => error.retryAfterSeconds === null);
});

test('capability matching includes actual matrix min/max, count endpoints and final format; spinNumber ignored', () => {
  assert.deepEqual([1, 2, 4, 5].map(n => recommendCloudTargets(matrix(n), catalog, opts).length), [0, 1, 1, 0]);
  assert.equal(recommendCloudTargets(matrix(2), catalog, { ...opts, calculate_count: 3 }).length, 1);
  assert.equal(recommendCloudTargets(matrix(2), catalog, { ...opts, calculate_count: 4 }).length, 0);
  assert.throws(() => prepareCloudTarget(matrix(2), catalog.computerTypes[1], catalog, opts), /尚未声明/);
  assert.throws(() => prepareCloudTarget(matrix(2), entry, catalog, { ...opts, post_process: 0 }), /固定值冲突/);
  assert.match(compatibilityIssues(matrix(2), entry, catalog, { has_h: true }).join(''), /H/);
  assert.match(compatibilityIssues(matrix(2), entry, catalog, { problem_type: 'ising' }).join(''), /问题类型/);
  const csvOnly = clone(catalog); csvOnly.uploadLimits.maxCsvBytes = 1; csvOnly.computerTypes[0].executionCapabilities.inputFormats = ['csv'];
  assert.equal(recommendCloudTargets(matrix(2), csvOnly, opts).length, 0);
  assert.throws(() => prepareCloudTarget(matrix(2), csvOnly.computerTypes[0], csvOnly, opts), /format=npz/);
});

test('CSV threshold below/equal/above uses actual bytes and real NPZ, does not mutate model or force postprocess', () => {
  const doc = matrix(2); const before = clone(doc.qubo);
  for (const delta of [-1, 0, 1]) {
    const fixture = clone(catalog); fixture.uploadLimits.maxCsvBytes = doc.content.length + delta;
    const prepared = prepareCloudTarget(doc, fixture.computerTypes[0], fixture, opts);
    assert.equal(prepared.file.format, delta < 0 ? 'npz' : 'csv');
    assert.equal(prepared.file.content.subarray(0, 2).toString(), delta < 0 ? 'PK' : '-1');
    assert.equal(prepared.file.size_bytes, prepared.file.content.length);
  }
  assert.deepEqual(doc.qubo, before);
});

test('explicit postprocess/payment required; no gear, no cross-id selection; free requires false', () => {
  for (const option of [{}, { post_process: 1 }, { ...opts, post_process: true }, { ...opts, gear: 2 }, { ...opts, computer_type_id: 1 }, { ...opts, question_type: 2 }]) assert.throws(() => prepareCloudTarget(matrix(2), entry, catalog, option));
  const free = clone(catalog); free.computerTypes[0].price = 0; free.computerTypes[0].computeCreditCost = 0;
  assert.throws(() => prepareCloudTarget(matrix(2), free.computerTypes[0], free, { ...opts, use_credit: true }), /免费/);
  assert.equal(prepareCloudTarget(matrix(2), free.computerTypes[0], free, opts).solver_options.use_credit, false);
  const stale = { ...entry, price: 30 }; assert.throws(() => prepareCloudTarget(matrix(2), stale, catalog, opts), /当前环境目录/);
});

test('optional advice ranks by chosen funding only, never removes alternatives from catalogue or chooses funding', () => {
  const fixture = clone(catalog); fixture.computerTypes.push({ ...clone(entry), id: 2, price: 1, computeCreditCost: 5 });
  assert.deepEqual(recommendCloudTargets(matrix(2), fixture, opts).map(x => x.computer_type_id), [2, 8]);
  assert.deepEqual(recommendCloudTargets(matrix(2), fixture, { ...opts, use_credit: true }).map(x => x.computer_type_id), [8, 2]);
  assert.deepEqual(recommendCloudTargets(matrix(2), fixture).map(x => x.computer_type_id), [2, 8]);
  assert.match(recommendCloudTargets(matrix(2), fixture)[0].reasons.join('；'), /post_process 尚未选择.*1/);
  assert.equal(fixture.computerTypes.length, 3);
});

test('new transport uploads raw bytes then creates on same environment using fileUrl, id, numeric postProcess', async () => {
  const calls = []; const t = transport([json({ data: { fileUrl: 'https://storage.example/safe.npz' } }), json({ data: { id: 'task-new' } })], calls);
  assert.deepEqual(await t.submit(file(), submissionOptions), { task_id: 'task-new' });
  assert.equal(calls[0].url, 'https://isolated.example/prefix/files/upload-bytes?originalFilename=matrix.csv');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/octet-stream'); assert.ok(Buffer.isBuffer(calls[0].options.body));
  assert.equal(calls[1].url, 'https://isolated.example/prefix/tasks/create-general');
  assert.deepEqual(JSON.parse(calls[1].options.body), { name: 'unique-call-1', computerTypeId: 8, inputJFile: 'https://storage.example/safe.npz', questionType: 1, caculateCount: 2, postProcess: 1, useCredit: false });
  assert.equal(calls.every(c => c.options.headers.Authorization === 'private-fixture-key' && c.options.headers.channel === 'sdk'), true);
  assert.equal(calls.some(c => /Oss|Signature/.test(c.url)), false);
});

test('missing credentials or explicit options makes no HTTP call', async () => {
  const calls = []; const t = transport([], calls, { apiKey: () => '' });
  await assert.rejects(t.submit(file(), submissionOptions), /API Key/);
  await assert.rejects(t.submit(file(), { computer_type_id: 8, post_process: 1 }), /use_credit/);
  assert.equal(calls.length, 0);
});

test('CSV upload and referenced-file size errors preserve actual threshold/code/format without raw secrets', async () => {
  for (const create of [false, true]) {
    const responses = create ? [json({ data: { fileUrl: 'https://storage.example/f' } })] : [];
    responses.push(json({ success: false, code: 'CSV_SIZE_LIMIT_EXCEEDED', message: 'API_KEY=private-fixture-key https://secret.example', maxCsvBytes: 12345, requiredFormat: 'npz' }, create ? 400 : 413));
    await assert.rejects(transport(responses).submit(file(), submissionOptions), error => {
      assert.equal(error.code, 'CSV_SIZE_LIMIT_EXCEEDED'); assert.equal(error.maxCsvBytes, 12345); assert.equal(error.requiredFormat, 'npz'); assert.equal(error.submissionOutcome, create ? 'rejected' : 'not_created');
      assert.ok(!JSON.stringify(error).includes('private-fixture-key')); assert.ok(!JSON.stringify(error).includes('secret.example')); return true;
    });
  }
});

test('submission failures distinguish never-created, rejected and unknown; never retry or create fallback', async () => {
  const upload = json({ data: { fileUrl: 'https://storage.example/f' } });
  for (const [response, expected] of [[new Error('secret private-fixture-key'), 'unknown'], [json({}, 500), 'unknown'], [json({}, 409), 'unknown'], [json({ message: 'bad input' }, 400), 'rejected'], [json({ data: {} }), 'unknown'], [json({ success: false, message: 'denied' }), 'rejected'], [new Response('invalid JSON'), 'unknown']]) {
    const calls = [];
    await assert.rejects(transport([upload.clone(), response], calls).submit(file(), submissionOptions), error => error instanceof IsingQError && error.submissionOutcome === expected && error.submissionUnknown === (expected === 'unknown'));
    assert.equal(calls.length, 2);
  }
  const calls = []; await assert.rejects(transport([new Error('network')], calls).submit(file(), submissionOptions), e => e.submissionOutcome === 'not_created'); assert.equal(calls.length, 1);
});

test('new and legacy polling map 0 queued / 1 running / 2 success / 3 failed and distinguish missing/invalid result', async () => {
  const fixtures = [ { status: 0 }, { status: 1, result: { bits: [1, 0] } }, { status: 2, result: { spin_config: [-1, 1], energy: -3 } }, { status: 3, result: { bits: [1, 0], energy: -3 } }, { status: 2 }, { status: 2, result: { bits: [1] } }, { status: 2, result: { bits: [0, 1], energy: 'invalid' } } ];
  const expected = ['queued', 'running', 'succeeded', 'failed', 'result_pending', 'result_invalid', 'result_invalid'];
  for (const legacy of [false, true]) {
    const original = http.fetch;
    try {
      const responses = fixtures.map(data => json({ data }));
      const fetch = async () => { assert.ok(responses.length); return responses.shift(); };
      if (legacy) http.fetch = fetch;
      const t = legacy ? new IsingQTransport({ apiKey: () => 'fixture-key', baseUrl: 'https://isolated.example' }) : transport([], [], { fetch });
      for (let i = 0; i < expected.length; i++) assert.equal((await t.poll('task-1', 2)).status, expected[i]);
    } finally { http.fetch = original; }
  }
  await assert.rejects(transport([json({ data: { status: 999 } })]).poll('task-1', 2), /任务状态未知/);
  await assert.rejects(transport([json({ data: { status: '2' } })]).poll('task-1', 2), /任务状态未知/);
});

test('catalogue and authenticated paths reject oversize/malformed responses, redirects and unsafe base URLs', async () => {
  for (const address of ['http://isolated.example', 'https://key@isolated.example', 'https://isolated.example/?key=secret', 'https://isolated.example/#secret']) {
    assert.throws(() => new CloudCatalogClient({ baseUrl: address }));
  }
  for (const response of [new Response('oops'), new Response('{}', { headers: { 'Content-Length': '1048577' } }), new Response(JSON.stringify({ data: { fileUrl: 'http://unsafe.example/f' } })), new Response(JSON.stringify({ data: { fileUrl: 'https://key@unsafe.example/f' } }))]) {
    const calls = [];
    await assert.rejects(transport([response], calls).submit(file(), submissionOptions), e => e.submissionOutcome === 'not_created');
    assert.equal(calls.length, 1);
  }
});

test('fetch timeout is classified by request phase without retry or credential leakage', async () => {
  for (const create of [false, true]) {
    const calls = [];
    const fetch = async (url, options) => {
      calls.push(url);
      if (create && calls.length === 1) return json({ data: { fileUrl: 'https://storage.example/f' } });
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private-fixture-key'))));
    };
    const t = transport([], [], { fetch, timeoutSeconds: 0.005 });
    await assert.rejects(t.submit(file(), submissionOptions), e => e.submissionOutcome === (create ? 'unknown' : 'not_created') && !JSON.stringify(e).includes('private-fixture-key'));
    assert.equal(calls.length, create ? 2 : 1);
  }
});

test('null solver fields cannot silently invoke defaults or create requests', async () => {
  for (const field of ['calculate_count', 'post_process', 'use_credit', 'question_type', 'computer_type_id']) {
    assert.throws(() => prepareCloudTarget(matrix(2), entry, catalog, { ...opts, [field]: null }));
  }
});

test('converted NPZ bytes and original task name are what the same-environment upload receives', async () => {
  const fixture = clone(catalog); fixture.uploadLimits.maxCsvBytes = 1;
  const prepared = prepareCloudTarget(matrix(2), fixture.computerTypes[0], fixture, opts);
  const calls = [];
  await transport([json({ data: { fileUrl: 'https://storage.example/matrix.npz' } }), json({ data: { id: 12345 } })], calls).submit({ ...prepared.file, task_name: 'unique-npz-call' }, prepared.solver_options);
  assert.equal(calls[0].url, 'https://isolated.example/prefix/files/upload-bytes?originalFilename=matrix.npz');
  assert.deepEqual(calls[0].options.body, prepared.file.content);
  assert.equal(calls[0].options.body.readUInt32LE(0), 0x04034b50);
  assert.equal(JSON.parse(calls[1].options.body).name, 'unique-npz-call');
});

test('Retry-After HTTP date is honored and malformed/overflow values are not invented as delays', async () => {
  for (const [header, valid] of [[new Date(Date.now() + 60000).toUTCString(), true], ['9'.repeat(400), false], ['nonsense', false]]) {
    const client = new CloudCatalogClient({ baseUrl: 'https://isolated.example', fetch: async () => new Response('gateway', { status: 429, headers: { 'Retry-After': header } }) });
    await assert.rejects(client.get(), error => valid ? error.retryAfterSeconds > 0 && error.retryAfterSeconds <= 60 : error.retryAfterSeconds === null);
  }
});
