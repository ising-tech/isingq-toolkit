'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SolverService, SolveStartError } = require('../src/core');
const { IsingQTransport } = require('../src/isingq');
const { SolveStore, apiKey, saveApiKey } = require('../src/store');
const { createHandler } = require('../src/server');

const ARGS = { qubo: { num_bits: 1, linear: [{ index: 0, coefficient: -1 }] }, model_summary: '重试测试', idempotency_key: 'retry-request' };
const SIGNATURE = { data: { host: 'https://oss.example/upload', policy: 'policy', signature: 'signature', x_oss_credential: 'credential', x_oss_date: 'date', security_token: 'token' } };
function json(value) { return new Response(JSON.stringify(value), { status: 200 }); }
function fixture(t, handler, key = 'test-private-key') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-retry-'));
  const environment = { HOME: home };
  if (key) saveApiKey(key, environment);
  const store = new SolveStore(environment);
  const original = global.fetch;
  global.fetch = handler;
  t.after(() => { global.fetch = original; fs.rmSync(home, { recursive: true, force: true }); });
  const transport = new IsingQTransport({ apiKey: () => apiKey(environment) });
  return { environment, store, transport, service: new SolverService({ store, transport }) };
}
function success(url) {
  if (String(url).includes('getPostSignature')) return json(SIGNATURE);
  if (String(url).includes('create-general')) return json({ task_id: 'task-1' });
  return new Response('', { status: 200 });
}

test('missing key leaves no run and the same key can submit after private setup', async (t) => {
  const { environment, store, service } = fixture(t, success, null);
  await assert.rejects(() => service.start(ARGS), /API Key/);
  assert.deepEqual(fs.readdirSync(store.directory), []);
  saveApiKey('test-private-key', environment);
  assert.equal((await service.start(ARGS)).status, 'submitted');
});

test('signature failure is archived before a same-key retry and survives restart', async (t) => {
  let fail = true;
  const { environment, store, service } = fixture(t, (url) => fail ? new Response('', { status: 503 }) : success(url));
  await assert.rejects(() => service.start(ARGS));
  const oldId = fs.readdirSync(store.directory)[0].replace('.json', '');
  fail = false;
  const restarted = new SolverService({ store: new SolveStore(environment), transport: service.transport });
  const retried = await restarted.start(ARGS);
  assert.equal(retried.status, 'submitted');
  assert.notEqual(retried.solve_id, oldId);
  assert.equal(restarted.get(oldId).status, 'failed');
  assert.ok(store.get(oldId).archived_at);
  assert.equal((await restarted.start(ARGS)).solve_id, retried.solve_id);
});

test('invalid create response is unknown and same-key start remains an error', async (t) => {
  let creates = 0;
  const { service, store } = fixture(t, (url) => {
    if (String(url).includes('create-general')) { creates += 1; return new Response('invalid json'); }
    return success(url);
  });
  await assert.rejects(() => service.start(ARGS));
  const run = store.get(fs.readdirSync(store.directory)[0].replace('.json', ''));
  assert.equal(run.status, 'submission_unknown');
  await assert.rejects(() => service.start(ARGS), (error) => error.run?.solve_id === run.solve_id);
  assert.equal(creates, 1);
});

test('uses one credential snapshot and returns successful idempotency hits without credentials', async (t) => {
  const headers = [];
  const { service, transport } = fixture(t, (url, options) => { headers.push(options.headers?.Authorization); return success(url); });
  let reads = 0;
  transport.apiKey = () => { reads += 1; return 'snapshot-private-key'; };
  const started = await service.start(ARGS);
  assert.equal(reads, 1);
  assert.deepEqual(headers, ['snapshot-private-key', undefined, 'snapshot-private-key']);
  transport.apiKey = () => { throw new Error('credential provider must not run'); };
  assert.equal((await service.start(ARGS)).solve_id, started.solve_id);
});

test('invalid credentials are rejected before reservation without exposing their value', async (t) => {
  let calls = 0;
  const { service, store, transport } = fixture(t, () => { calls += 1; return success(''); });
  transport.apiKey = () => 'invalid private credential';
  await assert.rejects(() => service.start(ARGS), (error) => {
    assert.doesNotMatch(error.message, /invalid private credential/);
    return /API Key/.test(error.message);
  });
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(store.directory), []);
});

test('in-flight and restarted reservations prevent another submit while the result is unknown', async (t) => {
  const { store, environment } = fixture(t, () => { throw new Error('unexpected fetch'); });
  let release;
  let calls = 0;
  const transport = { submit: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); } };
  const service = new SolverService({ store, transport });
  const first = service.start(ARGS);
  const concurrent = await service.start(ARGS);
  assert.equal(concurrent.status, 'submitting');
  assert.equal(store.get(concurrent.solve_id).submission_outcome, 'unknown');
  const restarted = new SolverService({ store: new SolveStore(environment), transport });
  assert.equal((await restarted.start(ARGS)).solve_id, concurrent.solve_id);
  assert.equal(calls, 1);
  release({ task_id: 'task-1' });
  assert.equal((await first).status, 'submitted');
});

test('signature and upload failures are explicitly safe to retry', async (t) => {
  const cases = [
    ['signature network', 'getPostSignature', () => { throw new TypeError('private-key must not escape'); }],
    ['signature invalid JSON', 'getPostSignature', () => new Response('invalid')],
    ['signature body read', 'getPostSignature', () => ({ ok: true, headers: new Headers(), text: async () => { throw new Error('private-key must not escape'); } })],
    ['signature malformed URL', 'getPostSignature', () => json({ data: { ...SIGNATURE.data, host: 'not a URL' } })],
    ['upload HTTP', 'oss.example', () => new Response('', { status: 503 })],
    ['upload network', 'oss.example', () => { throw new Error('private-key must not escape'); }],
  ];
  for (const [label, marker, failResponse] of cases) {
    await t.test(label, async (t) => {
      let fail = true;
      let creates = 0;
      const { service, store } = fixture(t, (url) => {
        if (String(url).includes('create-general')) creates += 1;
        return fail && String(url).includes(marker) ? failResponse() : success(url);
      });
      await assert.rejects(() => service.start(ARGS), (error) => {
        assert.equal(error.run.status, 'failed');
        assert.doesNotMatch(error.message, /private-key/);
        return true;
      });
      const old = store.get(fs.readdirSync(store.directory)[0].replace('.json', ''));
      assert.equal(old.submission_outcome, 'not_created');
      assert.equal(creates, 0);
      fail = false;
      assert.equal((await service.start(ARGS)).status, 'submitted');
      assert.equal(creates, 1);
      assert.ok(store.get(old.solve_id).archived_at);
    });
  }
});

test('every ambiguous create outcome blocks a second POST after restart', async (t) => {
  const cases = [
    ['409', () => new Response('', { status: 409 })],
    ['503', () => new Response('', { status: 503 })],
    ['network', () => { throw new TypeError('private-key must not escape'); }],
    ['invalid JSON', () => new Response('invalid')],
    ['declared oversized', () => new Response('{}', { headers: { 'content-length': '1048577' } })],
    ['actual oversized', () => new Response('x'.repeat(1048577))],
    ['body read', () => ({ ok: true, headers: new Headers(), text: async () => { throw new TypeError('private-key must not escape'); } })],
    ['missing task ID', () => json({ data: {} })],
  ];
  for (const [label, response] of cases) {
    await t.test(label, async (t) => {
      let creates = 0;
      const { environment, service, store } = fixture(t, (url) => {
        if (String(url).includes('create-general')) { creates += 1; return response(); }
        return success(url);
      });
      let failed;
      await assert.rejects(() => service.start(ARGS), (error) => {
        failed = error.run;
        assert.equal(error.run.status, 'submission_unknown');
        assert.doesNotMatch(error.message, /private-key/);
        return true;
      });
      const restarted = new SolverService({ store: new SolveStore(environment), transport: service.transport });
      await assert.rejects(() => restarted.start(ARGS), (error) => error.run.solve_id === failed.solve_id);
      assert.equal(store.get(failed.solve_id).submission_outcome, 'unknown');
      assert.equal(creates, 1);
    });
  }
});

test('explicit HTTP rejection remains failed and occupied', async (t) => {
  let creates = 0;
  const { service, store } = fixture(t, (url) => {
    if (String(url).includes('create-general')) { creates += 1; return new Response('', { status: 400 }); }
    return success(url);
  });
  let failed;
  await assert.rejects(() => service.start(ARGS), (error) => {
    failed = error.run;
    return error.run.status === 'failed';
  });
  assert.equal(store.get(failed.solve_id).submission_outcome, 'rejected');
  await assert.rejects(() => service.start(ARGS), SolveStartError);
  assert.equal(creates, 1);
});

test('archival failure stops before any new submission and keeps active occupancy', async (t) => {
  let calls = 0;
  const { service, store } = fixture(t, () => { calls += 1; return new Response('', { status: 503 }); });
  await assert.rejects(() => service.start(ARGS));
  const old = store.get(fs.readdirSync(store.directory)[0].replace('.json', ''));
  const save = store.save.bind(store);
  store.save = (run) => { if (run.archived_at) throw new Error('disk full'); return save(run); };
  await assert.rejects(() => service.start(ARGS), /归档失败.*停止.*solve_id=solve_/);
  assert.equal(calls, 1);
  assert.equal(store.findByIdempotency(old.idempotency_digest).solve_id, old.solve_id);
  assert.equal(store.get(old.solve_id).archived_at, undefined);
});

test('model binding survives safe failures and an archive-only restart', async (t) => {
  const { service, store, environment } = fixture(t, () => new Response('', { status: 503 }));
  await assert.rejects(() => service.start(ARGS));
  const changed = { ...ARGS, qubo: { ...ARGS.qubo, offset: 1 } };
  await assert.rejects(() => service.start(changed), /不同模型/);
  const old = store.get(fs.readdirSync(store.directory)[0].replace('.json', ''));
  store.archive(old);
  const restarted = new SolverService({ store: new SolveStore(environment), transport: service.transport });
  assert.equal(restarted.store.findByIdempotency(old.idempotency_digest), null);
  await assert.rejects(() => restarted.start(changed), /不同模型/);
});

test('too many archived records fail closed instead of hiding active occupancy', async (t) => {
  let calls = 0;
  const { service, store } = fixture(t, () => { calls += 1; return success(''); });
  // The limit is checked before reading records. An active run could sort after
  // all these archives, so an incomplete scan must never permit another POST.
  for (let index = 0; index <= 10000; index += 1) {
    fs.writeFileSync(path.join(store.directory, `solve_${index.toString(16).padStart(32, '0')}.json`), '{}');
  }
  await assert.rejects(() => service.start(ARGS), /停止提交.*count=10001.*limit=10000/);
  assert.equal(calls, 0);
});

test('only legacy pre-create failures without task evidence may retry', async (t) => {
  for (const [phase, taskId, submittedAt, allowed] of [
    ['upload_signature', null, null, true], ['upload', null, null, true],
    ['submit', null, null, false], [null, null, null, false],
    ['upload', 'task-1', null, false], ['upload', null, '2026-01-01T00:00:00Z', false], ['poll', 'task-1', null, false],
  ]) {
    await t.test(`${phase}/${taskId}/${submittedAt}`, async (t) => {
      let creates = 0;
      const { service, store } = fixture(t, (url) => { if (String(url).includes('create-general')) creates += 1; return success(url); });
      const started = await service.start(ARGS);
      const run = store.get(started.solve_id);
      delete run.submission_outcome;
      Object.assign(run, { status: 'failed', error: { phase, http_status: null }, provider_task_id: taskId, submitted_at: submittedAt });
      store.save(run);
      if (allowed) assert.equal((await service.start(ARGS)).status, 'submitted');
      else await assert.rejects(() => service.start(ARGS), /核查远端任务/);
      assert.equal(creates, allowed ? 2 : 1);
    });
  }
});

test('created tasks which later fail are never resubmitted', async (t) => {
  let creates = 0;
  const { service } = fixture(t, (url) => {
    if (String(url).includes('create-general')) creates += 1;
    if (/\/tasks\/task-1$/.test(String(url))) return json({ data: { status: 2 } });
    return success(url);
  });
  const started = await service.start(ARGS);
  assert.equal((await service.poll(started.solve_id)).status, 'failed');
  await assert.rejects(() => service.start(ARGS), (error) => error.run.provenance.provider_task_id === 'task-1');
  assert.equal(creates, 1);
});

test('unclassified custom transport exceptions and malformed success stay unknown', async (t) => {
  for (const submit of [async () => { throw new Error('private-key must not escape'); }, async () => ({})]) {
    await t.test('custom transport', async (t) => {
      const { store } = fixture(t, () => { throw new Error('unexpected fetch'); });
      let calls = 0;
      const service = new SolverService({ store, transport: { submit: async () => { calls += 1; return submit(); } } });
      await assert.rejects(() => service.start(ARGS), (error) => {
        assert.doesNotMatch(error.message, /private-key/);
        return error.run.status === 'submission_unknown';
      });
      await assert.rejects(() => service.start(ARGS), SolveStartError);
      assert.equal(calls, 1);
    });
  }
});

test('MCP start reports both fresh and cached failure with matching structured and text data; reads succeed', async (t) => {
  const { service } = fixture(t, (url) => String(url).includes('create-general') ? new Response('invalid') : success(url));
  const handle = createHandler(service);
  const request = { method: 'tools/call', params: { name: 'isingq_solve_start', arguments: ARGS } };
  const first = await handle(request);
  const repeated = await handle(request);
  for (const response of [first, repeated]) {
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.ok, false);
    assert.equal(response.structuredContent.error.code, 'solve_start_failed');
    assert.equal(response.structuredContent.data.status, 'submission_unknown');
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  }
  assert.equal(first.structuredContent.data.solve_id, repeated.structuredContent.data.solve_id);
  for (const name of ['isingq_solve_poll', 'isingq_solve_result_get']) {
    const response = await handle({ method: 'tools/call', params: { name, arguments: { solve_id: first.structuredContent.data.solve_id } } });
    assert.equal(response.isError, false);
    assert.equal(response.structuredContent.ok, true);
    assert.equal(response.structuredContent.data.status, 'submission_unknown');
  }
});

test('native DSH adapter propagates cached start failure from the shared core', async (t) => {
  const { environment, service } = fixture(t, (url) => String(url).includes('create-general') ? new Response('invalid') : success(url));
  let failed;
  await assert.rejects(() => service.start(ARGS), (error) => { failed = error.run; return true; });
  const replacements = { XDG_CONFIG_HOME: path.join(environment.HOME, '.config'), XDG_DATA_HOME: path.join(environment.HOME, '.local', 'share') };
  const previous = Object.fromEntries(Object.keys(replacements).map((name) => [name, process.env[name]]));
  Object.assign(process.env, replacements);
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const { pathToFileURL } = require('node:url');
  const plugin = await import(pathToFileURL(path.resolve(__dirname, '../packages/dsh-plugin/index.mjs')));
  const tools = [];
  plugin.apply({ tools: { register(tool) { tools.push(tool); } } });
  const start = tools.find((tool) => tool.name === 'isingq_solve_start');
  await assert.rejects(() => start.execute(ARGS), (error) => error instanceof SolveStartError && error.run.solve_id === failed.solve_id);
});
