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
  const bodyCase = mode.startsWith('body-') ? mode.split('-').slice(1) : null;
  let cancelledUploads = 0;
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
      const currentPhase = req.url.includes('getPostSignature') ? 'signature' : req.url === '/upload' ? 'upload' : req.url.includes('create-general') ? 'create' : 'poll';
      if (bodyCase && currentPhase === bodyCase[0]) {
        const [, status, pace] = bodyCase;
        const payload = status === '200'
          ? JSON.stringify(currentPhase === 'signature' ? { data: { host: 'https://upload.invalid/upload', policy: 'fixture-policy', signature: 'fixture-signature', x_oss_credential: 'fixture-credential', x_oss_date: 'fixture-date', security_token: 'fixture-token' } } : currentPhase === 'create' ? { task_id: 'fixture-task' } : { data: { status: 1 } })
          : JSON.stringify({ message: 'try later; api_key=fixture-only-key' });
        res.writeHead(Number(status), { 'content-type': 'application/json' });
        res.flushHeaders();
        res.on('close', () => { if (currentPhase === 'upload') cancelledUploads++; });
        if (pace === 'hang') { res.write(payload.slice(0, 1)); return; }
        if (pace === 'fast') { res.write(payload.slice(0, 1)); setTimeout(() => res.end(payload.slice(1)), 20); return; }
        let offset = 0;
        const dripping = setInterval(() => {
          if (offset === payload.length) { clearInterval(dripping); res.end(); }
          else res.write(payload[offset++]);
        }, 25);
        res.on('close', () => clearInterval(dripping));
        return;
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
  const transport = new IsingQTransport({ apiKey: () => 'fixture-only-key', baseUrl: 'https://transport.invalid', timeoutSeconds: mode === 'timeout' || bodyCase ? 0.15 : 2 });
  try {
    if (bodyCase) {
      const [stage, status, pace] = bodyCase;
      const phase = { signature: 'upload_signature', upload: 'upload', create: 'create_task', poll: 'poll' }[stage];
      const operation = () => stage === 'poll' ? transport.poll('fixture-task', 2) : transport.submit({ content: Buffer.from('1,0\n0,1\n'), sha256: 'a'.repeat(64) }, { use_credit: false });
      const started = Date.now();
      if (status === '200' && (pace === 'fast' || stage === 'upload')) {
        const result = await operation();
        if (stage === 'poll') assert.equal(result.status, 'running');
        else assert.equal(result.task_id, 'fixture-task');
        if (stage === 'upload') {
          await new Promise(resolve => setTimeout(resolve, 20));
          assert.equal(cancelledUploads, 1, 'unused upload response body must be cancelled');
        }
      } else {
        await assert.rejects(operation, error => {
          assert.equal(error.phase, phase);
          assert.equal(error.status, status === '200' ? null : Number(status));
          const outcome = stage === 'create' ? (status === '401' ? 'rejected' : 'unknown') : 'not_created';
          assert.equal(error.submissionOutcome, outcome);
          assert.equal(error.submissionUnknown, outcome === 'unknown');
          assert.equal(error.retryable, status === '401' ? false : status === '429' || stage !== 'create');
          assert.doesNotMatch(JSON.stringify(error), /fixture-only-key/);
          return true;
        });
      }
      assert.ok(Date.now() - started < 1500, 'deadline must cover response body consumption');
      const successful = status === '200' && (pace === 'fast' || stage === 'upload');
      const expectedRequests = stage === 'poll' ? 1 : successful || stage === 'create' ? 3 : stage === 'signature' ? 1 : 2;
      assert.equal(requests, expectedRequests, 'no automatic resubmission');
    } else if (mode === 'attack') {
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
