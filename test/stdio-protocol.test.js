'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

async function childMessages(input, extraEnv = {}) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/isingq-mcp.js'), 'serve'], {
    env: { ...process.env, ISINGQ_UPDATE_CHECK: 'off', ISINGQ_MANAGED_MCP_ID: '', ISINGQ_MANAGED_MCP_TOKEN: '', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  const timer = setTimeout(() => child.kill(), 5000);
  child.stdin.end(input);
  assert.equal(await completed, 0, stderr);
  return stdout.trim() ? stdout.trim().split('\n').map(JSON.parse) : [];
}

const ping = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' });

test('actual stdio process validates envelopes, suppresses notifications and recovers', async () => {
  const malformed = [null, [], 1, true, {}, { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 5 }, { jsonrpc: '2.0', id: 3, method: {} },
    { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'ping', params: null },
    { jsonrpc: '2.0', id: 5, method: 'ping', params: 'bad' },
    { jsonrpc: '2.0', id: 6, method: 'ping', params: [] },
    { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: 1.5, method: 'ping' }];
  const lines = ['{broken', ...malformed.map(JSON.stringify),
    JSON.stringify({ jsonrpc: '2.0', method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'missing' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: 3 }),
    JSON.stringify({ jsonrpc: '2.0', id: 'unknown', method: 'missing' }), ping('after')];
  const messages = await childMessages(lines.join('\n') + '\n');
  assert.equal(messages.length, malformed.length + 3);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[0].id, null);
  for (const message of messages.slice(1, malformed.length + 1)) assert.equal(message.error.code, -32600);
  assert.equal(messages.at(-2).error.code, -32601);
  assert.equal(messages.at(-2).id, 'unknown');
  assert.deepEqual(messages.at(-1), { jsonrpc: '2.0', id: 'after', result: {} });
});

test('actual stdio process rejects overlong UTF-8 lines then handles CRLF and EOF', async () => {
  const messages = await childMessages(' '.repeat(1025) + '\r\n\r\n' + ping('恢复') + '\r\n' + ping('eof'), {
    ISINGQ_MAX_LOCAL_FILE_BYTES: '1024',
  });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].error.code, -32600);
  assert.match(messages[0].error.message, /max_bytes=1024/);
  assert.equal(messages[1].id, '恢复');
  assert.equal(messages[2].id, 'eof');
});

test('line framing bounds bytes before decoding and handles chunk boundaries', async () => {
  const { readFrames } = require('../src/stdio-protocol');
  const utf8 = Buffer.from('中');
  const chunks = [Buffer.from('a\r'), Buffer.from('\n'), utf8.subarray(0, 1), utf8.subarray(1),
    Buffer.from('\n12345'), Buffer.from('6\r\n{}\n\nlast')];
  const frames = [];
  for await (const frame of readFrames(Readable.from(chunks), 5)) frames.push(frame);
  assert.deepEqual(frames.filter(f => !f.error).map(f => f.line), ['a\r', '中', '{}', '', 'last']);
  assert.equal(frames.filter(f => f.error).length, 1);
  const oversizedEof = [];
  for await (const frame of readFrames(Readable.from([Buffer.from('123456')]), 5)) oversizedEof.push(frame);
  assert.equal(oversizedEof[0].error.code, -32600);
});

test('one input chunk stays serial and waits for stdout before starting the next request', async () => {
  const { runStdio } = require('../src/stdio-protocol');
  let handled = 0, startedSecondChunk = false, acknowledge;
  const written = [];
  async function* input() {
    yield Buffer.from(ping(1) + '\n' + ping(2) + '\n');
    startedSecondChunk = true;
    yield Buffer.from(ping(3) + '\n');
  }
  const output = new Writable({ highWaterMark: 1, write(data, encoding, callback) {
    written.push(JSON.parse(data));
    acknowledge = callback;
  } });
  const running = runStdio({ input: input(), output, maxLineBytes: 1024, handle: async () => { handled++; return {}; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, 1);
  assert.equal(startedSecondChunk, false);
  acknowledge();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, 2);
  assert.equal(startedSecondChunk, false);
  acknowledge();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, 3);
  acknowledge();
  await running;
  assert.deepEqual(written.map(message => message.id), [1, 2, 3]);
});


test('UTF-8 byte ceiling, invalid encoding, empty input and terminal oversized line are bounded', async () => {
  const { readFrames } = require('../src/stdio-protocol');
  const frames = [];
  for await (const frame of readFrames(Readable.from([Buffer.from('12345\n中中\n'), Buffer.from([0xff, 10]), Buffer.from('ok')]), 5)) frames.push(frame);
  assert.equal(frames[0].line, '12345');
  assert.equal(frames[1].error.code, -32600);
  assert.equal(frames[2].error.code, -32700);
  assert.equal(frames[3].line, 'ok');
  const empty = [];
  for await (const frame of readFrames(Readable.from([]), 5)) empty.push(frame);
  assert.deepEqual(empty, []);
  const messages = await childMessages(Buffer.concat([Buffer.from([0xff, 10]), Buffer.from(ping('after-invalid-utf8') + '\n' + 'x'.repeat(1025))]), { ISINGQ_MAX_LOCAL_FILE_BYTES: '1024' });
  assert.deepEqual(messages.map(message => message.error?.code || message.id), [-32700, 'after-invalid-utf8', -32600]);
});

test('valid falsy ids and bursts survive an earlier unsupported notification method request', async () => {
  const input = [JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'notifications/initialized' }), ...[0, '', -1, ...Array.from({ length: 200 }, (_, i) => i + 10)].map(ping)].join('\n');
  const messages = await childMessages(input);
  assert.equal(messages[0].error.code, -32601);
  assert.deepEqual(messages.slice(1).map(message => message.id), [0, '', -1, ...Array.from({ length: 200 }, (_, i) => i + 10)]);
});

test('a handler rejection or failed activity cleanup does not terminate later messages', async () => {
  const { runStdio } = require('../src/stdio-protocol');
  const messages = [], cleanupErrors = [];
  const output = new Writable({ write(data, encoding, done) { messages.push(JSON.parse(data)); done(); } });
  await runStdio({ input: Readable.from([Buffer.from([ping(1), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fixture-submit' } }), ping(3)].join('\n'))]), output, maxLineBytes: 1024,
    handle: async request => { if (request.id === 1) throw null; return request.id === 2 ? { task_id: 'accepted-task', submissionOutcome: 'accepted' } : {}; },
    begin: request => () => { if (request.id === 2) throw new Error('fixture cleanup failure'); },
    onCleanupError: error => cleanupErrors.push(error.message),
  });
  assert.deepEqual(messages.map(message => message.error?.code || message.id), [-32603, 2, 3]);
  assert.deepEqual(cleanupErrors, ['fixture cleanup failure']);
  assert.deepEqual(messages[1].result, { task_id: 'accepted-task', submissionOutcome: 'accepted' });
});

test('closed stdout rejects the session without pulling another input chunk', async () => {
  const { runStdio } = require('../src/stdio-protocol');
  let pulled = 0, released = 0;
  async function* input() { pulled++; yield Buffer.from(ping(1) + '\n'); pulled++; yield Buffer.from(ping(2)); }
  const output = new Writable({ write(data, encoding, done) { done(Object.assign(new Error('fixture closed pipe'), { code: 'EPIPE' })); } });
  await assert.rejects(() => runStdio({ input: input(), output, handle: async () => ({}), begin: () => () => { released++; }, maxLineBytes: 1024 }), { code: 'EPIPE' });
  assert.equal(pulled, 1);
  assert.equal(released, 1);
});


test('serve attempts activity release and close after stdout EPIPE even if release fails', () => {
  const script = `
    const managed = require('./packages/core/src/managed-mcp-state');
    managed.serverControl = () => ({
      begin: () => () => { process.stderr.write('FIXTURE_RELEASED\\n'); throw new Error('DO_NOT_EXPOSE_RAW_CLEANUP'); },
      close: () => process.stderr.write('FIXTURE_CLOSED\\n'),
    });
    process.stdout.write = (value, done) => { process.nextTick(() => done(Object.assign(new Error('closed'), { code: 'EPIPE' }))); return false; };
    require('./src/server').serve().then(() => { process.exitCode = 3; }, error => { if (error.code !== 'EPIPE') process.exitCode = 4; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), input: ping(1) + '\n', encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ISINGQ_UPDATE_CHECK: 'off', ISINGQ_MANAGED_MCP_ID: '', ISINGQ_MANAGED_MCP_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /FIXTURE_RELEASED/);
  assert.match(result.stderr, /FIXTURE_CLOSED/);
  assert.match(result.stderr, /活动登记未能收尾/);
  assert.doesNotMatch(result.stderr, /DO_NOT_EXPOSE_RAW_CLEANUP/);
});


test('managed cleanup failure preserves accepted task id and blocks later tool work', () => {
  const script = `
    let submitted = 0;
    require('./packages/core/src/managed-mcp-state').serverControl = () => ({
      begin: () => () => { throw new Error('DO_NOT_EXPOSE_RAW_CLEANUP'); }, close() {},
    });
    require('./src/server').serve({ guideSolve: async () => { submitted++; return { task_id: 'accepted-task' }; } })
      .then(() => process.stderr.write('SUBMITTED=' + submitted + '\\n'), () => { process.exitCode = 2; });
  `;
  const call = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'isingq_solve', arguments: {} } });
  const guide = JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'isingq_modeling_guide_get', arguments: {} } });
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), input: [call(1), call(2), ping(3), guide].join('\n'), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ISINGQ_UPDATE_CHECK: 'off', ISINGQ_MANAGED_MCP_ID: '', ISINGQ_MANAGED_MCP_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(messages[0].result.structuredContent.data.task_id, 'accepted-task');
  assert.equal(messages[1].error.code, -32001);
  assert.deepEqual(messages[2].result, {});
  assert.equal(messages[3].result.structuredContent.ok, true);
  assert.match(result.stderr, /SUBMITTED=1/);
  assert.doesNotMatch(result.stderr, /DO_NOT_EXPOSE_RAW_CLEANUP/);
});


test('tools/call solve_start notification cannot create a task or send a response', () => {
  const script = `
    let starts = 0;
    require('./src/server').serve({ start: async () => { starts++; return { task_id: 'MUST_NOT_CREATE' }; } })
      .then(() => process.stderr.write('STARTS=' + starts + '\\n'), () => { process.exitCode = 2; });
  `;
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'isingq_solve_start', arguments: { solver_options: { use_credit: false } } } });
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), input: notification + '\n' + ping('after-notification'), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, ISINGQ_UPDATE_CHECK: 'off', ISINGQ_MANAGED_MCP_ID: '', ISINGQ_MANAGED_MCP_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), [{ jsonrpc: '2.0', id: 'after-notification', result: {} }]);
  assert.match(result.stderr, /STARTS=0/);
});
