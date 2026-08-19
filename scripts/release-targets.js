'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TARGETS = Object.freeze([
  { target: 'node22-macos-arm64', name: 'isingq-mcp-darwin-arm64' },
  { target: 'node22-macos-x64', name: 'isingq-mcp-darwin-x64' },
  { target: 'node22-linux-x64', name: 'isingq-mcp-linux-x64' },
  { target: 'node22-linux-arm64', name: 'isingq-mcp-linux-arm64' },
  { target: 'node22-win-x64', name: 'isingq-mcp-windows-x64.exe' },
]);

function selectTargets(argv) {
  if (!argv.length) return TARGETS;
  const requested = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--target' || !argv[index + 1]) {
      throw new Error(`无效构建参数（argv=${JSON.stringify(argv)}）；仅支持重复使用 --target <pkg-target>`);
    }
    requested.push(argv[index + 1]);
    index += 1;
  }
  return requested.map((target) => {
    const definition = TARGETS.find((candidate) => candidate.target === target);
    if (!definition) {
      throw new Error(`未知构建目标（target=${target}, supported=${TARGETS.map((item) => item.target).join(',')})`);
    }
    return definition;
  });
}

function writeReleaseMetadata(output, targets, version) {
  const files = {};
  for (const { name } of targets) {
    const file = path.join(output, name);
    if (!fs.existsSync(file)) throw new Error(`Release 产物不存在（file=${file}）`);
    const content = fs.readFileSync(file);
    files[name] = {
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      size: content.length,
    };
  }
  fs.writeFileSync(
    path.join(output, 'manifest.json'),
    `${JSON.stringify({ schema: 'isingq-mcp-release/v1', version, files }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(output, 'SHA256SUMS'),
    `${Object.entries(files).map(([name, metadata]) => `${metadata.sha256}  ${name}`).join('\n')}\n`,
  );
  return files;
}

module.exports = { TARGETS, selectTargets, writeReleaseMetadata };
