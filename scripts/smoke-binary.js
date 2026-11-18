#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { TOOL_DEFINITIONS } = require('../packages/core');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const input = process.argv[2];
if (!input) throw new Error('缺少待验证的可执行文件路径（usage=node scripts/smoke-binary.js <binary>）');
const binary = path.resolve(input);
const profile = process.argv[3] === '--technical' ? 'technical' : 'normal';
if (process.argv.length > 4 || (process.argv[3] && profile !== 'technical')) throw new Error('usage=node scripts/smoke-binary.js <binary-or-entry.js> [--technical]');
const expectedTools = (profile === 'technical' ? [...TOOL_DEFINITIONS.map(tool => tool.name), 'isingq_solve']
  : ['isingq_api_key_setup', 'isingq_knowledge_get', 'isingq_modeling_guide_get', 'isingq_solve']).sort();
const sourceEntry = /\.(?:c?js|mjs)$/i.test(binary);
const requests = [
  {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1' } },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
];
const result = spawnSync(sourceEntry ? process.execPath : binary, [...(sourceEntry ? [binary] : []), 'serve', ...(profile === 'technical' ? ['--technical'] : [])], {
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
assert.deepEqual(tools?.result?.tools?.map(tool => tool.name).sort(), expectedTools, `tool names differ for profile=${profile}`);
assert.equal(resources?.result?.resources?.length, 13);
for (const tool of tools.result.tools) assert.equal(tool.outputSchema?.type, 'object', `invalid outputSchema for ${tool.name}`);
process.stdout.write(`Release smoke passed（binary=${binary}, profile=${profile}, tools=${expectedTools.length}, resources=13）\n`);
