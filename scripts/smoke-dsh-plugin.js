#!/usr/bin/env node
'use strict';

// Runs the native DSH adapter against an isolated @deepseek-ai/dsh-tools install.
// The workspace keeps its pinned devDependency for reproducible tests; this
// script answers the other question: does the same source still load and run
// on another DSH runtime, e.g. the `next` dist-tag?
//
// Usage: node scripts/smoke-dsh-plugin.js [dist-tag|version]   (default: next)

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { TOOL_DEFINITIONS } = require('../packages/core');

const spec = process.argv[2] || 'next';
const root = path.resolve(__dirname, '..');
const directory = mkdtempSync(path.join(tmpdir(), 'isingq-dsh-smoke-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function install() {
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'isingq-dsh-smoke',
    private: true,
    type: 'module',
  }));
  const result = spawnSync(npm, [
    'install', '--no-audit', '--no-fund', '--no-package-lock',
    `@deepseek-ai/dsh-tools@${spec}`, path.join(root, 'packages/core'),
  ], { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install failed with status=${result.status}`);
  return JSON.parse(readFileSync(path.join(directory, 'node_modules/@deepseek-ai/dsh-tools/package.json'), 'utf8')).version;
}

async function main() {
  const installed = install();
  cpSync(path.join(root, 'packages/dsh-plugin/index.mjs'), path.join(directory, 'plugin.mjs'));
  process.env.XDG_DATA_HOME = path.join(directory, 'data');
  process.env.XDG_CONFIG_HOME = path.join(directory, 'config');

  const plugin = await import(pathToFileURL(path.join(directory, 'plugin.mjs')));
  const tools = [];
  plugin.apply({ tools: { register(tool) { tools.push(tool); } } });

  const expected = [
    ...TOOL_DEFINITIONS.map((definition) => definition.name),
    'isingq_resource_list',
    'isingq_resource_read',
  ].sort();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), expected);

  const knowledge = tools.find((tool) => tool.name === 'isingq_knowledge_get');
  const answer = await knowledge.execute({ topic: 'company', locale: 'zh-CN' });
  assert.equal(answer.topic, 'company');
  assert.match(answer.answer, /北京伊辛智能科技有限公司/);

  const resources = tools.find((tool) => tool.name === 'isingq_resource_list');
  assert.equal((await resources.execute({})).length, 13);

  const validate = tools.find((tool) => tool.name === 'isingq_qubo_validate');
  const summary = await validate.execute({ qubo: { num_bits: 1 } });
  assert.equal(summary.num_bits, 1);

  console.log(`ok: ${tools.length} tools on @deepseek-ai/dsh-tools@${installed}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(directory, { recursive: true, force: true }));
