'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSync } = require('esbuild');
const { selectTargets, writeReleaseMetadata } = require('./release-targets');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const targets = selectTargets(process.argv.slice(2));

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
  for (const { target, name } of targets) {
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

const files = writeReleaseMetadata(output, targets, require('../package.json').version);
process.stdout.write(`Built ${Object.keys(files).length} binaries in ${output}\n`);
