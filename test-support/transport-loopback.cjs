'use strict';

// Run in a subprocess: a vulnerable decoder can terminate the entire process.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const undici = require('undici');
const { IsingQTransport } = require('../packages/core/src/isingq');

const mode = process.argv[2];
const depth = Number(process.argv[3] || 6);
const builtinFetch = global.fetch;
if (process.argv.includes('--baseline-global-fetch')) {
  // Explicit negative control, isolated to this test subprocess only.
  undici.fetch = builtinFetch;
} else {
  global.fetch = () => { throw new Error('GLOBAL_FETCH_MUST_NOT_RUN'); };
}

(async () => {
  let requests = 0;
  const received = [];
  const server = mode === 'attack'
    ? net.createServer(socket => socket.once('data', () => {
      requests += 1;
      socket.end('HTTP/1.1 200 OK\r\nContent-Encoding: ' + Array(depth).fill('gzip').join(', ') + '\r\nContent-Length: 1\r\nConnection: close\r\n\r\n');
    }))
    : http.createServer(async (req, res) => {
      requests += 1;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      received.push({ url: req.url, headers: req.headers, body });
      if (mode === 'timeout') return;
      if (mode === 'redirect') {
        res.writeHead(302, { location: 'https://must-never-connect.invalid/leak' });
        return res.end();
      }
      if (mode === 'error') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message: 'try later; api_key=fixture-only-key' }));
      }
      let payload;
      if (req.url.includes('getPostSignature')) {
        payload = { data: { host: 'https://upload.invalid/upload', policy: 'fixture-policy', signature: 'fixture-signature', x_oss_credential: 'fixture-credential', x_oss_date: 'fixture-date', security_token: 'fixture-token' } };
      } else if (req.url === '/upload') {
        res.writeHead(200);
        return res.end();
      } else if (req.url.includes('create-general')) {
        payload = { task_id: 'fixture-task' };
      } else {
        payload = { data: { status: 2, result: { bits: [0, 1], energy: -3 } } };
      }
      const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': encoded.length });
      res.end(encoded);
    });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dispatcher = new undici.Agent({
    connect(options, callback) {
      // Even redirects cannot escape loopback or trigger external DNS.
      assert.ok(['transport.invalid', 'upload.invalid'].includes(options.hostname), `unexpected hostname=${options.hostname}`);
      const socket = net.connect(server.address().port, '127.0.0.1');
      const onError = error => callback(error, null);
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        callback(null, socket);
      });
    },
  });
  const previous = undici.getGlobalDispatcher();
  undici.setGlobalDispatcher(dispatcher);
  const transport = new IsingQTransport({ apiKey: () => 'fixture-only-key', baseUrl: 'https://transport.invalid', timeoutSeconds: mode === 'timeout' ? 0.15 : 2 });
  try {
    if (mode === 'attack') {
      await assert.rejects(() => transport.poll('fixture-task', 2));
      assert.equal(requests, 1, 'malicious response must reach the real transport');
      // Allow decoder destroy/error callbacks to run after the handled rejection.
      await new Promise(resolve => setTimeout(resolve, 100));
    } else if (mode === 'normal') {
      const content = Buffer.from('1,0\n0,1\n');
      const submitted = await transport.submit({ content, sha256: 'a'.repeat(64) }, { use_credit: false });
      assert.equal(submitted.task_id, 'fixture-task');
      assert.deepEqual(await transport.poll(submitted.task_id, 2), { status: 'succeeded', bits: [0, 1], energy: -3 });
      assert.equal(requests, 4);
      const upload = received[1];
      assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
      assert.match(upload.body, /name="file"; filename="isingq-mcp-qubo.csv"/);
      assert.ok(upload.body.includes(content.toString()));
      for (const value of ['fixture-policy', 'fixture-signature', 'fixture-credential', 'fixture-date', 'fixture-token']) assert.ok(upload.body.includes(value));
      assert.equal(upload.headers.authorization, undefined);
      assert.equal(received[0].headers.authorization, 'fixture-only-key');
      assert.equal(received[2].headers.authorization, 'fixture-only-key');
      assert.equal(JSON.parse(received[2].body).useCredit, false);
    } else {
      await assert.rejects(() => transport.poll('fixture-task', 2), error => {
        assert.equal(error.phase, 'poll');
        assert.equal(error.retryable, true);
        assert.equal(error.submissionOutcome, 'not_created');
        assert.equal(error.status, mode === 'error' ? 429 : null);
        assert.doesNotMatch(JSON.stringify(error), /fixture-only-key/);
        if (mode === 'error') assert.match(error.providerMessage, /try later.*REDACTED/);
        return true;
      });
      assert.equal(requests, 1);
    }
    process.stdout.write(JSON.stringify({ mode, depth, requests, survived: true, node: process.version, undici: require('undici/package.json').version }) + '\n');
  } finally {
    undici.setGlobalDispatcher(previous);
    await dispatcher.destroy();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
setTimeout(() => { console.error('LOOPBACK_TEST_TIMEOUT'); process.exit(2); }, 5000).unref();
