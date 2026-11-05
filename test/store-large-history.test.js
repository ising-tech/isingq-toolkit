'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { SolveStore, apiKey, saveApiKey } = require('../src/store');
const { SolverService } = require('../src/core');
const { createHandler } = require('../src/server');
const { configureHosts, hostPaths } = require('../src/hosts');
const http = require('undici');
const { IsingQTransport } = require('../src/isingq');

const MiB = 1024 * 1024;
const LIMIT = 128 * MiB;
const args = { qubo: { num_bits: 1, linear: [{ index: 0, coefficient: -1 }] }, model_summary: '历史兼容回归', idempotency_key: 'history-key', solver_options: { use_credit: false } };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-history-'));
  const environment = { HOME: home, USERPROFILE: home, LOCALAPPDATA: home, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home };
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new SolveStore(environment);
  const calls = { submit: 0, poll: 0 };
  const transport = {
    execution_mode: 'simulation',
    async submit() { calls.submit++; return { task_id: `test-${calls.submit}` }; },
    async poll() { calls.poll++; return { status: 'succeeded', bits: [1], energy: -1 }; },
  };
  return { home, environment, store, calls, transport, service: new SolverService({ store, transport }) };
}
async function legacyRun(f, changes = {}, bytes = 27 * MiB) {
  const started = await f.service.start(args);
  const run = { ...f.store.get(started.solve_id), legacy_notes: 'x'.repeat(bytes), ...changes };
  // Old versions wrote without a size bound; bypass the current writer to model upgrade.
  fs.writeFileSync(f.store.path(run.solve_id), JSON.stringify(run) + '\n');
  return run;
}

test('H01: legacy 27 MiB history survives restart, MCP get/poll, and unrelated submission unchanged', async t => {
  const f = fixture(t);
  const old = await legacyRun(f);
  const file = f.store.path(old.solve_id);
  const originalHash = digest(fs.readFileSync(file));
  const restarted = new SolverService({ store: new SolveStore(f.environment), transport: f.transport });
  const handle = createHandler(restarted);
  const get = await handle({ method: 'tools/call', params: { name: 'isingq_solve_result_get', arguments: { solve_id: old.solve_id } } });
  assert.equal(get.structuredContent.ok, true);
  assert.equal(get.structuredContent.data.solve_id, old.solve_id);
  assert.equal((await restarted.start(args)).solve_id, old.solve_id);
  await restarted.start({ ...args, idempotency_key: 'unrelated-key' });
  assert.equal(f.calls.submit, 2);
  assert.equal(digest(fs.readFileSync(file)), originalHash);
  const polled = await handle({ method: 'tools/call', params: { name: 'isingq_solve_poll', arguments: { solve_id: old.solve_id } } });
  assert.equal(polled.structuredContent.ok, true);
  assert.equal(polled.structuredContent.data.status, 'succeeded');
  assert.equal(f.calls.poll, 1);
  assert.equal(f.store.get(old.solve_id).legacy_notes, old.legacy_notes);
  assert.equal((await restarted.start(args)).solve_id, old.solve_id);
  assert.equal(f.calls.submit, 2);
});

test('H02: large unknown/rejected records retain occupancy and model/payment binding', async t => {
  for (const outcome of ['unknown', 'rejected']) {
    await t.test(outcome, async t => {
      const f = fixture(t);
      const old = await legacyRun(f, { status: outcome === 'unknown' ? 'submission_unknown' : 'failed', submission_outcome: outcome, provider_task_id: null }, 5 * MiB);
      const service = new SolverService({ store: new SolveStore(f.environment), transport: f.transport });
      await assert.rejects(() => service.start(args), e => e.run?.solve_id === old.solve_id);
      await assert.rejects(() => service.start({ ...args, qubo: { num_bits: 1, offset: 1 } }), /不同模型/);
      await assert.rejects(() => service.start({ ...args, solver_options: { use_credit: true } }), /不同模型/);
      await service.poll(old.solve_id);
      assert.deepEqual(f.calls, { submit: 1, poll: 0 });
    });
  }
});

test('H03: large safe failure can archive and retry once, retaining all historical fields', async t => {
  const f = fixture(t);
  const old = await legacyRun(f, { status: 'failed', submission_outcome: 'not_created', provider_task_id: null, submitted_at: null, error: { phase: 'upload' } });
  const service = new SolverService({ store: new SolveStore(f.environment), transport: f.transport });
  const retried = await service.start(args);
  assert.notEqual(retried.solve_id, old.solve_id);
  const archived = f.store.get(old.solve_id);
  assert.ok(archived.archived_at);
  assert.equal(archived.legacy_notes, old.legacy_notes);
  assert.equal((await service.start(args)).solve_id, retried.solve_id);
  assert.equal(f.calls.submit, 2);
});

test('H04: 4 MiB boundary and multibyte records round trip', t => {
  const f = fixture(t);
  const base = { solve_id: 'solve_' + 'a'.repeat(32), idempotency_digest: digest('key'), request_digest: digest('request') };
  for (const bytes of [4 * MiB - 1, 4 * MiB, 4 * MiB + 1]) {
    const empty = JSON.stringify({ ...base, padding: '' }) + '\n';
    const run = { ...base, padding: 'x'.repeat(bytes - Buffer.byteLength(empty)) };
    f.store.save(run);
    assert.equal(fs.statSync(f.store.path(run.solve_id)).size, bytes);
    assert.deepEqual(f.store.get(run.solve_id), run);
  }
  const run = { ...base, padding: '历史'.repeat(MiB) };
  f.store.save(run);
  assert.deepEqual(f.store.findByIdempotency(base.idempotency_digest), run);
});

test('H05: oversized read is explicit, preserves history, and prevents submission', async t => {
  const f = fixture(t);
  const id = 'solve_' + 'b'.repeat(32);
  const file = f.store.path(id);
  fs.writeFileSync(file, '{}');
  fs.truncateSync(file, LIMIT + 1);
  await assert.rejects(() => f.service.start(args), e => {
    assert.equal(e.code, 'solve_record_too_large');
    assert.match(e.message, /bytes=134217729.*max_bytes=134217728/);
    assert.doesNotMatch(e.message, /损坏/);
    return true;
  });
  assert.equal(fs.statSync(file).size, LIMIT + 1);
  assert.equal(f.calls.submit, 0);
});

test('H06: oversized write never replaces a readable record or leaves a temporary file', t => {
  const f = fixture(t);
  const run = { solve_id: 'solve_' + 'c'.repeat(32), idempotency_digest: digest('key'), request_digest: digest('request') };
  f.store.save(run);
  // UTF-8 bytes, not character count, determine the persisted size.
  assert.throws(() => f.store.save({ ...run, padding: '中'.repeat(Math.ceil(LIMIT / 3)) }), { code: 'solve_record_too_large' });
  assert.deepEqual(f.store.get(run.solve_id), run);
  assert.deepEqual(fs.readdirSync(f.store.directory), [path.basename(f.store.path(run.solve_id))]);
});

test('H07: corrupt and structurally incomplete records fail closed without exposing content', async t => {
  for (const text of ['{"secret":"synthetic-private-value",', 'null', '[]', '{}']) {
    await t.test(text === '{}' ? 'missing occupancy fields' : 'invalid JSON/object', async t => {
      const f = fixture(t);
      const file = f.store.path('solve_' + 'd'.repeat(32));
      fs.writeFileSync(file, text);
      await assert.rejects(() => f.service.start(args), e => {
        assert.equal(e.code, 'solve_record_invalid');
        assert.doesNotMatch(e.message, /synthetic-private-value/);
        return true;
      });
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      assert.equal(f.calls.submit, 0);
    });
  }
});

test('H08: missing files and unsafe file types remain distinct read errors', t => {
  const f = fixture(t);
  const id = 'solve_' + 'e'.repeat(32);
  assert.throws(() => f.store.get(id), { code: 'solve_record_io_error' });
  fs.mkdirSync(f.store.path(id));
  assert.throws(() => f.store.get(id), { code: 'solve_record_unsafe' });
});

test('H09: API key writer honors 64 KiB byte limit including newline without replacing prior key', t => {
  const f = fixture(t);
  const key = 'k'.repeat(64 * 1024 - 1);
  const file = saveApiKey(key, f.environment);
  assert.equal(apiKey(f.environment), key);
  assert.throws(() => saveApiKey(key + 'k', f.environment), /超过.*64 KiB/);
  assert.equal(fs.statSync(file).size, 64 * 1024);
  assert.equal(apiKey(f.environment), key);
});

test('H10: Host merge cannot write config beyond its default 10 MiB read limit', t => {
  const f = fixture(t);
  const paths = hostPaths(f.environment, 'linux');
  fs.mkdirSync(path.dirname(paths.workbuddy), { recursive: true });
  const original = JSON.stringify({ mcpServers: {}, padding: 'x'.repeat(10 * MiB - 80) });
  fs.writeFileSync(paths.workbuddy, original);
  assert.throws(() => configureHosts(['workbuddy'], { command: '/opt/isingq-mcp', args: ['serve'] }, paths, { writeGeneric: false }), /超过有效容量上限/);
  assert.equal(fs.readFileSync(paths.workbuddy, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.workbuddy)), ['mcp.json']);
});

test('H11: real dense QUBO produces a readable record above 27 MiB while CSV stays below 20 MiB', async t => {
  const f = fixture(t);
  const quadratic = [];
  for (let i = 0; i < 1400; i++) for (let j = i + 1; j < 1400; j++) quadratic.push({ i, j, coefficient: 1 });
  const started = await f.service.start({ ...args, qubo: { num_bits: 1400, quadratic } });
  assert.ok(fs.statSync(f.store.path(started.solve_id)).size > 27 * MiB);
  const run = new SolveStore(f.environment).get(started.solve_id);
  assert.equal(run.qubo.quadratic.length, quadratic.length);
  assert.ok(run.matrix.size_bytes < 20 * MiB);
  assert.equal(run.status, 'submitted');
  assert.equal(f.calls.submit, 1);
});

test('H12: exact 128 MiB persisted boundary is readable and the next byte is rejected', t => {
  const f = fixture(t);
  const run = { solve_id: 'solve_' + 'f'.repeat(32), idempotency_digest: digest('key'), request_digest: digest('request') };
  const empty = JSON.stringify({ ...run, padding: '' }) + '\n';
  f.store.save({ ...run, padding: 'x'.repeat(LIMIT - Buffer.byteLength(empty)) });
  const file = f.store.path(run.solve_id);
  assert.equal(fs.statSync(file).size, LIMIT);
  assert.equal(f.store.get(run.solve_id).padding.length, LIMIT - Buffer.byteLength(empty));
  fs.appendFileSync(file, ' ');
  assert.throws(() => f.store.get(run.solve_id), { code: 'solve_record_too_large' });
});

test('H13: failed atomic write keeps prior occupancy and removes only its temporary file', async t => {
  const f = fixture(t);
  const started = await f.service.start(args);
  const before = f.store.get(started.solve_id);
  const original = fs.writeFileSync;
  fs.writeFileSync = (target, ...rest) => {
    if (typeof target === 'number') throw Object.assign(new Error('synthetic-private-value'), { code: 'ENOSPC' });
    return original(target, ...rest);
  };
  try {
    assert.throws(() => f.store.save({ ...before, status: 'succeeded' }), e => {
      assert.equal(e.code, 'solve_record_io_error');
      assert.match(e.message, /ENOSPC/);
      assert.doesNotMatch(e.message, /synthetic-private-value/);
      return true;
    });
    assert.throws(() => f.store.archive(before), /归档失败.*停止重新提交/);
  } finally { fs.writeFileSync = original; }
  assert.deepEqual(f.store.get(started.solve_id), before);
  assert.equal((await f.service.start(args)).solve_id, started.solve_id);
  assert.equal(f.calls.submit, 1);
  assert.deepEqual(fs.readdirSync(f.store.directory), [path.basename(f.store.path(started.solve_id))]);
});

test('H14: read enforces actual bytes when size metadata underreports the file', t => {
  const f = fixture(t);
  const id = 'solve_' + '1'.repeat(32);
  const file = f.store.path(id);
  fs.writeFileSync(file, '{}');
  fs.truncateSync(file, LIMIT + 1);
  const lstat = fs.lstatSync, fstat = fs.fstatSync;
  fs.lstatSync = (...a) => Object.assign(lstat(...a), { size: 2 });
  fs.fstatSync = (...a) => Object.assign(fstat(...a), { size: 2 });
  try { assert.throws(() => f.store.get(id), { code: 'solve_record_too_large' }); }
  finally { fs.lstatSync = lstat; fs.fstatSync = fstat; }
});

test('H15: MCP exposes specific storage errors and never submits on unreadable history', async t => {
  const f = fixture(t);
  const id = 'solve_' + '2'.repeat(32);
  const handle = createHandler(f.service);
  const missing = await handle({ method: 'tools/call', params: { name: 'isingq_solve_result_get', arguments: { solve_id: id } } });
  assert.equal(missing.structuredContent.error.code, 'solve_record_io_error');
  fs.writeFileSync(f.store.path(id), '{}');
  const invalid = await handle({ method: 'tools/call', params: { name: 'isingq_solve_start', arguments: args } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'solve_record_invalid');
  assert.deepEqual(JSON.parse(invalid.content[0].text), invalid.structuredContent);
  assert.equal(f.calls.submit, 0);
});

test('H16: historical filename/solve_id mismatches and symlinks cannot bypass occupancy', async t => {
  const f = fixture(t);
  const started = await f.service.start(args);
  const file = f.store.path('solve_' + '3'.repeat(32));
  fs.copyFileSync(f.store.path(started.solve_id), file);
  assert.throws(() => f.store.findByIdempotency(digest('unrelated')), { code: 'solve_record_invalid' });
  fs.unlinkSync(file);
  // Windows file symlinks require developer mode/admin privilege; directory
  // rejection is covered by H08 on every platform.
  if (process.platform !== 'win32') {
    fs.symlinkSync(f.store.path(started.solve_id), file);
    assert.throws(() => f.store.findByIdempotency(digest('unrelated')), { code: 'solve_record_unsafe' });
  }
  assert.equal(f.calls.submit, 1);
});

test('H17: successful HTTP responses stop streaming at the byte bound without changing submission outcomes', async t => {
  for (const phase of ['upload_signature', 'create_task', 'poll']) {
    await t.test(phase, async t => {
      let pulls = 0, cancelled = false;
      const response = new Response(new ReadableStream({
        pull(controller) {
          if (pulls === 32) { controller.close(); return; }
          pulls++;
          controller.enqueue(new Uint8Array(64 * 1024).fill(32));
        },
        cancel() { cancelled = true; },
      }));
      const original = http.fetch;
      t.after(() => { http.fetch = original; });
      http.fetch = async url => {
        const u = String(url);
        if ((phase === 'upload_signature' && u.includes('getPostSignature'))
          || (phase === 'create_task' && u.includes('create-general'))
          || (phase === 'poll' && u.includes('/tasks/'))) return response;
        if (u.includes('getPostSignature')) return new Response(JSON.stringify({ data: {
          host: 'https://oss.example/upload', policy: 'policy', signature: 'signature', x_oss_credential: 'credential', x_oss_date: 'date', security_token: 'token',
        } }));
        return new Response('');
      };
      const transport = new IsingQTransport({ apiKey: () => 'synthetic-test-key' });
      await assert.rejects(() => phase === 'poll' ? transport.poll('test-task', 1)
        : transport.submit({ content: Buffer.from('1\n'), sha256: 'a'.repeat(64) }, { use_credit: false }), e => {
        assert.equal(e.phase, phase);
        assert.match(e.message, /超过 1 MiB/);
        if (phase !== 'poll') assert.equal(e.submissionOutcome, phase === 'create_task' ? 'unknown' : 'not_created');
        return true;
      });
      assert.equal(cancelled, true);
      assert.ok(pulls < 32, `must stop before draining all chunks; pulls=${pulls}`);
    });
  }
});

test('H18: HTTP exact byte boundary accepts split UTF-8 and declared oversize cancels before reading', async t => {
  const original = http.fetch;
  t.after(() => { http.fetch = original; });
  const prefix = '{"data":{"status":0},"padding":"';
  const suffix = '"}';
  const payload = Buffer.from(prefix + '中' + 'x'.repeat(MiB - Buffer.byteLength(prefix + '中' + suffix)) + suffix);
  assert.equal(payload.length, MiB);
  const split = Buffer.byteLength(prefix) + 1;
  http.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(payload.subarray(0, split)); c.enqueue(payload.subarray(split)); c.close(); } }));
  const transport = new IsingQTransport({ apiKey: () => 'synthetic-test-key' });
  assert.equal((await transport.poll('test-task', 1)).status, 'running');
  let cancelled = false;
  http.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(MiB + 1) } });
  await assert.rejects(() => transport.poll('test-task', 1), /响应过大/);
  assert.equal(cancelled, true);
});

test('H19: real stdio process and native DSH adapter read the same 27 MiB legacy history', async t => {
  const f = fixture(t);
  const run = await legacyRun(f);
  const before = digest(fs.readFileSync(f.store.path(run.solve_id)));
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'isingq_solve_result_get', arguments: { solve_id: run.solve_id } } };
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/isingq-mcp.js'), 'serve'], {
    env: { ...process.env, ...f.environment, ISINGQ_API_KEY: '' }, input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout).result;
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.solve_id, run.solve_id);
  const savedEnvironment = Object.fromEntries(Object.keys(f.environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, f.environment);
  try {
    const plugin = await import(pathToFileURL(path.resolve(__dirname, '../packages/dsh-plugin/index.mjs')));
    const tools = [];
    plugin.apply({ tools: { register(tool) { tools.push(tool); } } });
    const get = tools.find(tool => tool.name === 'isingq_solve_result_get');
    assert.equal((await get.execute({ solve_id: run.solve_id })).solve_id, run.solve_id);
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(digest(fs.readFileSync(f.store.path(run.solve_id))), before);
  assert.deepEqual(f.calls, { submit: 1, poll: 0 });
});
