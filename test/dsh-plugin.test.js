'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const corePackage = require('../packages/core/package.json');
const dshPackage = require('../packages/dsh-plugin/package.json');
const mcpPackage = require('../package.json');
const { TOOL_DEFINITIONS } = require('../packages/core');

async function loadTools() {
  const plugin = await import(pathToFileURL(path.join(root, 'packages/dsh-plugin/index.mjs')));
  const tools = [];
  plugin.apply({ tools: { register(tool) { tools.push(tool); } } });
  return { plugin, tools };
}

test('keeps MCP, shared core and native DSH adapter as separate packages', () => {
  assert.deepEqual(mcpPackage.workspaces, ['packages/core', 'packages/dsh-plugin']);
  assert.equal(mcpPackage.dependencies?.['@deepseek-ai/dsh-tools'], undefined);
  assert.equal(mcpPackage.dsh, undefined);
  assert.equal(corePackage.name, '@ising-tech/isingq-core');
  assert.equal(dshPackage.name, '@ising-tech/isingq-dsh-plugin');
  assert.equal(dshPackage.dependencies['@ising-tech/isingq-core'], corePackage.version);
  assert.equal(dshPackage.peerDependencies['@deepseek-ai/dsh-tools'], '>=0.1.0-rc.7 <0.2.0-0');
  assert.equal(dshPackage.devDependencies['@deepseek-ai/dsh-tools'], '0.1.0-rc.8');
  assert.equal(mcpPackage.version, corePackage.version);
  assert.equal(corePackage.version, dshPackage.version);
});

test('loads nine native DSH tools from the shared seven-tool catalog', async () => {
  const { plugin, tools } = await loadTools();
  assert.equal(plugin.name, 'isingq-dsh-plugin');
  assert.deepEqual(tools.slice(0, 7).map((tool) => tool.name), TOOL_DEFINITIONS.map((tool) => tool.name));
  assert.deepEqual(tools.slice(7).map((tool) => tool.name), ['isingq_resource_list', 'isingq_resource_read']);
  assert.equal(tools.length, 9);
  for (const [index, definition] of TOOL_DEFINITIONS.entries()) {
    assert.equal(tools[index].description, definition.description);
  }
});

test('translates optional and required MCP inputs to valid DSH parameters', async () => {
  const { tools } = await loadTools();
  const setup = tools.find((tool) => tool.name === 'isingq_api_key_setup');
  const knowledge = tools.find((tool) => tool.name === 'isingq_knowledge_get');
  assert.equal(setup.parameters.properties.force.required, undefined);
  assert.deepEqual(knowledge.parameters.required, ['topic']);
  assert.equal(knowledge.parameters.properties.locale.required, undefined);
});

test('executes local knowledge and resource tools through the native adapter', async () => {
  const { tools } = await loadTools();
  const knowledge = tools.find((tool) => tool.name === 'isingq_knowledge_get');
  const resourceList = tools.find((tool) => tool.name === 'isingq_resource_list');
  const result = await knowledge.execute({ topic: 'company', locale: 'zh-CN' });
  assert.equal(result.topic, 'company');
  assert.match(result.answer, /北京伊辛智能科技有限公司/);
  assert.equal((await resourceList.execute({})).length, 13);
});
