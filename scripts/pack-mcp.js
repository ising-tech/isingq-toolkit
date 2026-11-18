'use strict';
const { runWithCleanupSync } = require('../packages/core/src/run-with-cleanup');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function npmCli() {
  const directory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(directory, 'node_modules/npm/bin/npm-cli.js'),
  ];
  const cli = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!cli) throw new Error('未找到 npm CLI；请确认已安装 npm，并通过 npm run pack:mcp 运行。');
  return cli;
}

function packMcp({ destination = path.join(root, 'dist') } = {}) {
  const cli = npmCli();
  const output = path.resolve(destination);
  const pages = ['README.md', 'README.en.md'];
  const readmes = pages.map(file => fs.readFileSync(path.join(root, 'packages/mcp', file)));
  const run = (args, cwd) => JSON.parse(execFileSync(process.execPath, [cli, 'pack', '--ignore-scripts', '--json', '--workspaces=false', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const [plan] = run(['--dry-run'], root);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-npm-'));
  return runWithCleanupSync(() => {
    for (const { path: file } of plan.files) {
      const source = path.resolve(root, file);
      const target = path.resolve(stage, file);
      if (!source.startsWith(root + path.sep) || !target.startsWith(stage + path.sep)) {
        throw new Error(`npm 打包清单包含越界路径（path=${file}）；请检查 package.json 的 files 配置。`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      fs.chmodSync(target, fs.statSync(source).mode & 0o777);
    }
    pages.forEach((file, i) => fs.writeFileSync(path.join(stage, file), readmes[i]));
    fs.mkdirSync(output, { recursive: true });
    return run(['--pack-destination', output], stage);
  }, () => {
    fs.rmSync(stage, { recursive: true, force: true });
  });
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--pack-destination' || !args[1].trim())) {
      throw new Error('用法：npm run pack:mcp -- [--pack-destination <输出目录>]；此命令只打包，不发布。');
    }
    process.stdout.write(JSON.stringify(packMcp(args.length ? { destination: args[1] } : {}), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.status !== undefined
      ? `MCP 打包失败（exit=${error.status}）；请核对 Node.js/npm、文件权限及 package.json 的 files 配置。\n`
      : String(error.message || error) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { packMcp };
