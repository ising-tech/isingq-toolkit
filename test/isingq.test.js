'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IsingQTransport } = require('../src/isingq');
const { SolverService } = require('../src/core');

test('pins the default solver transport to the official IsingQ API', () => {
  const previous = process.env.ISINGQ_BASE_URL;
  process.env.ISINGQ_BASE_URL = 'https://redirect.example';
  try {
    const service = new SolverService({ store: {} });
    assert.equal(service.transport.baseUrl, 'https://api.isingq.com');
  } finally {
    if (previous === undefined) delete process.env.ISINGQ_BASE_URL;
    else process.env.ISINGQ_BASE_URL = previous;
  }
});

test('uses SDK HTTPS contract for signature, OSS upload, task creation and poll', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const responses = [
    new Response(JSON.stringify({
      data: {
        host: 'https://oss.example/upload',
        policy: 'policy',
        signature: 'signature',
        x_oss_credential: 'credential',
        x_oss_date: '20260813T000000Z',
        security_token: 'security-token',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response('', { status: 200 }),
    new Response(JSON.stringify({ data: { taskId: 'task-1' } }), { status: 200 }),
    new Response(JSON.stringify({
      data: { status: 2, result: { spin_config: [-1, 1], energy: -3 } },
    }), { status: 200 }),
  ];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  };
  try {
    const transport = new IsingQTransport({
      apiKey: () => 'private-key',
      baseUrl: 'https://api.isingq.example',
    });
    const submitted = await transport.submit({
      content: Buffer.from('1,0\n0,1\n'),
      sha256: 'a'.repeat(64),
    }, {});
    const result = await transport.poll(submitted.task_id, 2);

    assert.equal(calls[0].url, 'https://api.isingq.example/files/getPostSignatureForOssUpload');
    assert.equal(calls[1].url, 'https://oss.example/upload');
    assert.equal(calls[2].url, 'https://api.isingq.example/tasks/create-general');
    assert.equal(calls[3].url, 'https://api.isingq.example/tasks/task-1');
    assert.equal(calls.every((call) => call.options.redirect === 'error'), true);
    assert.equal(calls[0].options.headers.Authorization, 'private-key');
    assert.equal(calls[1].options.headers, undefined);
    assert.equal(calls[2].options.headers.Authorization, 'private-key');
    assert.equal(calls[3].options.headers.Authorization, 'private-key');
    assert.equal(JSON.parse(calls[2].options.body).caculateCount, 1);
    assert.deepEqual(result, { status: 'succeeded', bits: [0, 1], energy: -3 });
    assert.equal(JSON.stringify(result).includes('private-key'), false);
  } finally {
    global.fetch = originalFetch;
  }
});
