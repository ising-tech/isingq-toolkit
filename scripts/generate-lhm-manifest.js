#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHandler } = require('../src/server');
const pkg = require('../package.json');
const manifestPath = path.resolve(__dirname, '..', 'lhm.plugin.json');

// This is the complete capability catalogue, not the ordinary four-tool menu.
// Use the same public protocol producer as the explicit technical MCP profile.
async function generateLobeManifest(metadata) {
  const handle = createHandler({}, { tools_profile: 'technical' });
  const [{ tools }, { resources }] = await Promise.all([
    handle({ method: 'tools/list' }),
    handle({ method: 'resources/list' }),
  ]);
  return { ...metadata, tools, resources, version: pkg.version };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) {
    throw new Error(`用法：node scripts/generate-lhm-manifest.js [--check]（argument_count=${argv.length}）；本命令不接收凭据或输出路径`);
  }
  const original = fs.readFileSync(manifestPath, 'utf8');
  const generated = await generateLobeManifest(JSON.parse(original));
  const expected = `${JSON.stringify(generated, null, 2)}\n`;
  if (argv[0] === '--check') {
    if (original !== expected) {
      throw new Error(`LobeHub能力快照与源码技术模式不一致（path=${manifestPath}）；请运行 node scripts/generate-lhm-manifest.js 后核对差异`);
    }
    process.stdout.write(`LobeHub能力快照一致：${generated.tools.length}个工具、${generated.resources.length}个资源；普通MCP发现配置未改变\n`);
    return;
  }
  fs.writeFileSync(manifestPath, expected);
  process.stdout.write(`已生成 ${manifestPath}：${generated.tools.length}个工具、${generated.resources.length}个资源；请人工核对差异\n`);
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { generateLobeManifest };
