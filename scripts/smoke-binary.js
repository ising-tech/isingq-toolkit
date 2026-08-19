#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const input = process.argv[2];
if (!input) throw new Error('缺少待验证的可执行文件路径（usage=node scripts/smoke-binary.js <binary>）');
const binary = path.resolve(input);
const requests = [
  {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1' } },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
];
const result = spawnSync(binary, ['serve'], {
  input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  timeout: 30_000,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, `binary exited with status=${result.status}, signal=${result.signal}, stderr=${result.stderr}`);
const responses = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const initialize = responses.find((response) => response.id === 1);
const tools = responses.find((response) => response.id === 2);
const resources = responses.find((response) => response.id === 3);
assert.equal(initialize?.result?.serverInfo?.name, 'isingq-mcp');
assert.equal(tools?.result?.tools?.length, 7);
assert.equal(resources?.result?.resources?.length, 13);
for (const tool of tools.result.tools) assert.equal(tool.outputSchema?.type, 'object', `invalid outputSchema for ${tool.name}`);
process.stdout.write(`Release smoke passed（binary=${binary}, tools=7, resources=13）\n`);
