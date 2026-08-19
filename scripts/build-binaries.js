'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const targets = [
  ['node22-macos-arm64', 'isingq-mcp-darwin-arm64'],
  ['node22-macos-x64', 'isingq-mcp-darwin-x64'],
  ['node22-linux-x64', 'isingq-mcp-linux-x64'],
  ['node22-linux-arm64', 'isingq-mcp-linux-arm64'],
  ['node22-win-x64', 'isingq-mcp-windows-x64.exe'],
];

fs.mkdirSync(output, { recursive: true });
const buildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-release-'));
const bundle = path.join(buildDirectory, 'isingq-mcp.bundle.cjs');
try {
  buildSync({
    absWorkingDir: root,
    entryPoints: ['bin/isingq-mcp.js'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    outfile: bundle,
  });
  for (const [target, name] of targets) {
    const result = spawnSync(
      process.execPath,
      [require.resolve('@yao-pkg/pkg/lib-es5/bin.js'), '--sea', bundle, '--target', target, '--output', path.join(output, name)],
      { cwd: buildDirectory, stdio: 'inherit' },
    );
    if (result.status !== 0) process.exit(result.status || 1);
  }
} finally {
  fs.rmSync(buildDirectory, { recursive: true, force: true });
}

const files = {};
for (const [, name] of targets) {
  const file = path.join(output, name);
  const content = fs.readFileSync(file);
  files[name] = {
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    size: content.length,
  };
}
fs.writeFileSync(
  path.join(output, 'manifest.json'),
  `${JSON.stringify({ schema: 'isingq-mcp-release/v1', version: require('../package.json').version, files }, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(output, 'SHA256SUMS'),
  `${Object.entries(files).map(([name, metadata]) => `${metadata.sha256}  ${name}`).join('\n')}\n`,
);
process.stdout.write(`Built ${Object.keys(files).length} binaries in ${output}\n`);
