'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('serves newline-delimited MCP initialize and tools/list', async () => {
  const executable = path.resolve(__dirname, '..', 'bin', 'isingq-mcp.js');
  const child = spawn(process.execPath, [executable, 'serve'], {
    env: { ...process.env, ISINGQ_API_KEY: 'must-not-leak' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      messages.push(JSON.parse(stdout.slice(0, newline)));
      stdout = stdout.slice(newline + 1);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} })}\n`);
  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(exitCode, 0);
  assert.equal(messages[0].result.serverInfo.name, 'isingq-mcp');
  assert.match(messages[0].result.serverInfo.title, /伊辛智能/);
  assert.equal(messages[1].result.tools.length, 7);
  assert.equal(messages[2].result.resources.length, 13);
  assert.equal(JSON.stringify(messages).includes('must-not-leak'), false);
  assert.equal(stderr.includes('must-not-leak'), false);
});
