'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const core = require('../packages/core');
const { IsingQTransport } = require('../src/isingq');
const { createHandler } = require('../src/server');

const ARGS = { qubo: { num_bits: 1 }, model_summary: 'explicit payment', idempotency_key: 'payment-contract' };
const INVALID = [undefined, null, {}, [], false, { use_credit: null }, { use_credit: 0 }, { use_credit: 'false' }, Object.create({ use_credit: false })];
const SIGNATURE = { data: { host: 'https://oss.example/upload', policy: 'private-policy', signature: 'private-signature', x_oss_credential: 'private-oss-credential', x_oss_date: 'date', security_token: 'private-oss-token' } };
const PRIVATE_KEY = 'private-api-key-sentinel';

function fixture() {
  const runs = new Map();
  const events = [];
  const store = {
    findByIdempotency(digest) { events.push('lookup'); return [...runs.values()].find(run => run.idempotency_digest === digest); },
    save(run) { events.push('save'); runs.set(run.solve_id, structuredClone(run)); },
    get(id) { return runs.get(id); },
  };
  const transport = new IsingQTransport({ apiKey: () => { events.push('credentials'); return PRIVATE_KEY; } });
  return { service: new core.SolverService({ store, transport }), store, events, runs };
}

test('cloud submission helper is detectable and preserves pure normalization compatibility', () => {
  assert.equal(core.CLOUD_SUBMISSION_CONTRACT_VERSION, 'isingq-cloud-submission-v1');
  assert.equal(require('@ising-tech/isingq-mcp/core').validateCloudSubmissionOptions, core.validateCloudSubmissionOptions);
  assert.equal(core.validateSolverOptions().use_credit, false);
  assert.equal(core.validateSolverOptions(null).use_credit, false);
  for (const input of INVALID) assert.throws(() => core.validateCloudSubmissionOptions(input), /solver_options\.use_credit.*boolean.*付款/);
  for (const use_credit of [false, true]) {
    assert.deepEqual(core.validateCloudSubmissionOptions({ use_credit }), { ...core.validateSolverOptions(), use_credit });
  }
});

test('core and MCP reject missing payment before lookup, credentials, storage or upload', async t => {
  const previous = global.fetch;
  global.fetch = () => { throw new Error('NETWORK_MUST_NOT_RUN'); };
  t.after(() => { global.fetch = previous; });
  for (const solver_options of INVALID) {
    const f = fixture();
    await assert.rejects(() => f.service.start({ ...ARGS, solver_options }), /付款.*poll.*get/);
    const result = await createHandler(f.service)({ method: 'tools/call', params: { name: 'isingq_solve_start', arguments: { ...ARGS, solver_options } } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
    assert.deepEqual(f.events, []);
  }
});

test('low-level transport rejects missing payment before even reading credentials', async t => {
  const previous = global.fetch;
  global.fetch = () => { throw new Error('NETWORK_MUST_NOT_RUN'); };
  t.after(() => { global.fetch = previous; });
  let reads = 0;
  const transport = new IsingQTransport({ apiKey: () => { reads += 1; throw new Error('CREDENTIALS_MUST_NOT_RUN'); } });
  for (const input of INVALID) await assert.rejects(() => transport.submit({ content: Buffer.from('0'), sha256: 'a'.repeat(64) }, input), /付款/);
  assert.equal(reads, 0);
});

test('MCP snapshot and DSH keep required payment visible in their compiled nested schemas', async () => {
  const solve = core.TOOL_DEFINITIONS.find(tool => tool.name === 'isingq_solve_start');
  assert.ok(solve.inputSchema.required.includes('solver_options'));
  assert.deepEqual(solve.inputSchema.properties.solver_options.required, ['use_credit']);
  assert.equal(solve.inputSchema.properties.solver_options.additionalProperties, false);
  assert.equal(solve.inputSchema.properties.solver_options.properties.use_credit.default, undefined);
  assert.deepEqual(Object.keys(solve.inputSchema.properties.solver_options.properties).sort(), Object.keys(core.validateSolverOptions()).sort());
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../lhm.plugin.json'), 'utf8'));
  assert.deepEqual(manifest.tools.find(tool => tool.name === solve.name).inputSchema, solve.inputSchema);
  const plugin = await import(pathToFileURL(path.join(__dirname, '../packages/dsh-plugin/index.mjs')));
  const tools = [];
  plugin.apply({ tools: { register(tool) { tools.push(tool); } } });
  const native = tools.find(tool => tool.name === solve.name);
  assert.ok(native.parameters.required.includes('solver_options'));
  assert.deepEqual(native.parameters.properties.solver_options.required, ['use_credit']);
  assert.match(native.parameters.properties.solver_options.properties.calculate_count.description, /1 至 10000/);
  assert.equal(native.parameters.properties.solver_options.properties.calculate_count.maximum, undefined, 'DSH supported schema subset excludes numeric bounds; core enforces them');
  await assert.rejects(() => native.execute(ARGS), /solver_options/);
  await assert.rejects(() => native.execute({ ...ARGS, solver_options: {} }), /use_credit/);
});

test('explicit true and false reach create exactly; changing payment keeps original occupancy', async t => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  for (const use_credit of [false, true]) {
    const f = fixture();
    const created = [];
    global.fetch = async (url, init) => {
      if (String(url).includes('getPostSignature')) return Response.json(SIGNATURE);
      if (String(url).includes('create-general')) { created.push(JSON.parse(init.body)); return Response.json({ task_id: 'task-1' }); }
      return new Response('');
    };
    const args = { ...ARGS, solver_options: { use_credit } };
    const run = await f.service.start(args);
    assert.equal(created[0].useCredit, use_credit);
    assert.equal(run.solver_options.use_credit, use_credit);
    assert.equal((await f.service.start(args)).solve_id, run.solve_id);
    await assert.rejects(() => f.service.start({ ...args, solver_options: { use_credit: !use_credit } }), /模型或求解参数/);
    await assert.rejects(() => f.service.start(ARGS), /poll.*get/);
    assert.equal(f.service.get(run.solve_id).status, 'submitted');
    assert.equal(created.length, 1);
  }
});

test('platform JSON message survives safely in fresh/cached errors and persistence without changing rejection', async t => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const f = fixture();
  let creates = 0;
  global.fetch = async url => {
    if (String(url).includes('getPostSignature')) return Response.json(SIGNATURE);
    if (String(url).includes('create-general')) {
      creates += 1;
      return Response.json({ message: `算力券不足，请确认付款选择；Authorization: Bearer ${PRIVATE_KEY}; security_token=private-oss-token; api_key=OTHER_PRIVATE_VALUE; "accessKey":"PRIVATE_ACCESS_KEY"; 诊断 ${JSON.stringify({ api_key: 'OTHER_PRIVATE_SENTINEL', access_token: 'OTHER_TOKEN_SENTINEL', password: 'prefix"PRIVATE_SUFFIX', secret: "prefix\\'PRIVATE_BACKSLASH_SUFFIX" })}; 'api_key' : 'prefix\\'PRIVATE_SINGLE_SUFFIX'`, stack: 'PRIVATE_STACK', arbitrary: 'PRIVATE_FIELD' }, { status: 400 });
    }
    return new Response('');
  };
  const handle = createHandler(f.service);
  const request = { method: 'tools/call', params: { name: 'isingq_solve_start', arguments: { ...ARGS, solver_options: { use_credit: true } } } };
  const first = await handle(request);
  const repeated = await handle(request);
  for (const result of [first, repeated]) {
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.data.status, 'failed');
    assert.equal(result.structuredContent.data.error.http_status, 400);
    assert.match(result.structuredContent.data.error.provider_message, /算力券不足，请确认付款选择/);
    assert.match(result.structuredContent.error.message, /算力券不足/);
    assert.equal(result.structuredContent.data.submission_outcome, 'rejected');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.doesNotMatch(JSON.stringify(result), /private-api-key-sentinel|private-oss-token|OTHER_PRIVATE_VALUE|PRIVATE_STACK|PRIVATE_FIELD|PRIVATE_ACCESS_KEY|OTHER_PRIVATE_SENTINEL|OTHER_TOKEN_SENTINEL|PRIVATE_SUFFIX|PRIVATE_BACKSLASH_SUFFIX|PRIVATE_SINGLE_SUFFIX/);
  }
  assert.deepEqual(first, repeated);
  const saved = f.store.get(first.structuredContent.data.solve_id);
  assert.equal(saved.submission_outcome, 'rejected');
  assert.deepEqual(saved.error, first.structuredContent.data.error);
  assert.equal(creates, 1);
});

test('error bodies without content-length stop reading at the actual byte limit and cancel the stream', async t => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  let pulled = 0;
  let cancelled = false;
  global.fetch = async url => {
    if (String(url).includes('getPostSignature')) return Response.json(SIGNATURE);
    if (!String(url).includes('create-general') && String(url) !== SIGNATURE.data.host) throw new Error('UNEXPECTED_MOCK_REQUEST');
    if (String(url) === SIGNATURE.data.host) return new Response('');
    const response = new Response(new ReadableStream({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(8192).fill(120)); },
      cancel() { cancelled = true; },
    }), { status: 400 });
    response.text = () => { throw new Error('UNBOUNDED_TEXT_MUST_NOT_RUN'); };
    return response;
  };
  const f = fixture();
  await assert.rejects(() => f.service.start({ ...ARGS, solver_options: { use_credit: false } }), error => {
    assert.equal(error.run.error.http_status, 400);
    assert.equal(error.run.submission_outcome, 'rejected');
    assert.equal(error.run.error.provider_message, undefined);
    return true;
  });
  assert.equal(cancelled, true);
  assert.ok(pulled <= 4, `stream exceeded diagnostic read budget: chunks=${pulled}`);
});

test('safe platform message is limited without inventing a payment reason for unrelated HTTP400', async t => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const f = fixture();
  global.fetch = async url => {
    if (String(url).includes('getPostSignature')) return Response.json(SIGNATURE);
    if (String(url).includes('create-general')) return Response.json({ message: '模型参数不合法：' + 'x'.repeat(2000) }, { status: 400 });
    if (String(url) === SIGNATURE.data.host) return new Response('');
    throw new Error('UNEXPECTED_MOCK_REQUEST');
  };
  await assert.rejects(() => f.service.start({ ...ARGS, solver_options: { use_credit: false } }), error => {
    assert.match(error.run.error.provider_message, /^模型参数不合法/);
    assert.ok(error.run.error.provider_message.length <= 512);
    assert.doesNotMatch(error.run.error.provider_message, /余额|算力券|付款/);
    return true;
  });
});

test('DSH exposes the same sanitized fresh and cached failure, and keeps history reads available', async t => {
  const previousFetch = global.fetch;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-payment-dsh-'));
  const replacements = { XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_DATA_HOME: path.join(directory, 'data'), ISINGQ_API_KEY: PRIVATE_KEY };
  const previous = Object.fromEntries(Object.keys(replacements).map(name => [name, process.env[name]]));
  Object.assign(process.env, replacements);
  t.after(() => {
    global.fetch = previousFetch;
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let creates = 0;
  global.fetch = async url => {
    if (String(url).includes('getPostSignature')) return Response.json(SIGNATURE);
    if (String(url).includes('create-general')) { creates += 1; return Response.json({ message: `算力券不足 ${PRIVATE_KEY}；诊断 ${JSON.stringify({ api_key: 'OTHER_PRIVATE_SENTINEL', access_token: 'OTHER_TOKEN_SENTINEL', password: 'prefix"PRIVATE_SUFFIX' })}` }, { status: 400 }); }
    if (String(url) === SIGNATURE.data.host) return new Response('');
    throw new Error('UNEXPECTED_MOCK_REQUEST');
  };
  const plugin = await import(pathToFileURL(path.join(__dirname, '../packages/dsh-plugin/index.mjs')));
  const tools = [];
  plugin.apply({ tools: { register(tool) { tools.push(tool); } } });
  const start = tools.find(tool => tool.name === 'isingq_solve_start');
  await assert.rejects(() => start.execute({ ...ARGS, solver_options: { use_credit: false, calculate_count: 10001 } }), /calculate_count.*10000/);
  assert.equal(creates, 0);
  let original;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => start.execute({ ...ARGS, solver_options: { use_credit: true } }), error => {
      assert.ok(error instanceof core.SolveStartError);
      assert.match(error.message, /算力券不足/);
      assert.equal(error.run.submission_outcome, 'rejected');
      assert.doesNotMatch(error.message, /private-api-key-sentinel|OTHER_PRIVATE_SENTINEL|OTHER_TOKEN_SENTINEL|PRIVATE_SUFFIX/);
      assert.doesNotMatch(JSON.stringify(error.run), /private-api-key-sentinel|OTHER_PRIVATE_SENTINEL|OTHER_TOKEN_SENTINEL|PRIVATE_SUFFIX/);
      if (original) assert.deepEqual(error.run, original);
      original = error.run;
      return true;
    });
  }
  assert.equal(creates, 1);
  for (const name of ['isingq_solve_poll', 'isingq_solve_result_get']) {
    assert.deepEqual(await tools.find(tool => tool.name === name).execute({ solve_id: original.solve_id }), original);
  }
});

test('unsafe, malformed, oversized and unreadable HTTP bodies preserve HTTP classification with no raw output', async t => {
  const previous = global.fetch;
  t.after(() => { global.fetch = previous; });
  const cases = [
    () => new Response('<html>PRIVATE_HTML</html>', { status: 400 }),
    () => new Response('PRIVATE_TEXT', { status: 400 }),
    () => Response.json({ message: '<html>PRIVATE_HTML</html>' }, { status: 400 }),
    () => Response.json({ message: 'Error: PRIVATE_STACK\n    at private.js:1:1' }, { status: 400 }),
    () => Response.json({ message: 'PRIVATE_BIG' }, { status: 400, headers: { 'content-length': '1048577' } }),
    () => new Response(JSON.stringify({ message: 'PRIVATE_BIG' + 'x'.repeat(1048576) }), { status: 400 }),
    () => ({ ok: false, status: 400, headers: new Headers(), text: async () => { throw new Error(PRIVATE_KEY); } }),
    () => ({ ok: false, status: 503, headers: new Headers(), text: async () => { throw new Error(PRIVATE_KEY); } }),
  ];
  for (const response of cases) {
    const f = fixture();
    let creates = 0;
    global.fetch = async url => {
      if (String(url).includes('getPostSignature')) return Response.json(SIGNATURE);
      if (String(url).includes('create-general')) { creates += 1; return response(); }
      return new Response('');
    };
    const args = { ...ARGS, solver_options: { use_credit: false } };
    await assert.rejects(() => f.service.start(args), error => {
      const status = error.run.error.http_status;
      assert.ok([400, 503].includes(status));
      assert.equal(error.run.status, status === 400 ? 'failed' : 'submission_unknown');
      assert.equal(error.run.error.provider_message, undefined);
      assert.doesNotMatch(JSON.stringify(error.run), /PRIVATE_|private-api-key-sentinel/);
      return true;
    });
    await assert.rejects(() => f.service.start(args));
    assert.equal(creates, 1);
  }
});
