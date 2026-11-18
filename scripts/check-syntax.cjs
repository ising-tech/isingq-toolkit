'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function filesUnder(input) {
  const metadata = fs.lstatSync(input);
  if (metadata.isSymbolicLink()) return [];
  if (metadata.isFile()) return /\.(?:js|cjs|mjs)$/.test(input) ? [input] : [];
  return fs.readdirSync(input, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .flatMap(entry => filesUnder(path.join(input, entry.name)));
}

let checked = 0;
for (const input of process.argv.slice(2)) {
  for (const file of filesUnder(path.resolve(input)).sort()) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      process.stderr.write(`语法检查未通过（path=${file}, exit=${result.status ?? 'unknown'}）；请修正上述错误后重试。\n`);
      process.exit(1);
    }
    checked++;
  }
}
if (!checked) throw new Error('未找到需要语法检查的文件；请提供有效的源文件或目录');
process.stdout.write(`语法检查通过（files=${checked}）。\n`);
