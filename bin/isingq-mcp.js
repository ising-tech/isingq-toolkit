#!/usr/bin/env node
'use strict';

const { apiKey, roots, saveApiKey } = require('../src/store');
const { configureHosts, detectHosts } = require('../src/hosts');
const { VERSION, serve } = require('../src/server');

const PACKAGE_SPEC = '@ising-tech/isingq-mcp';

function isStandaloneExecutable() {
  if (process.versions.pkg) return true;
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
}

function mcpCommand() {
  return isStandaloneExecutable()
    ? { command: process.execPath, args: ['serve'] }
    : { command: process.execPath, args: [__filename, 'serve'] };
}

function npxMcpCommand() {
  return { command: 'npx', args: ['-y', PACKAGE_SPEC, 'serve'] };
}

function usage() {
  return `isingq-mcp ${VERSION}

Usage:
  isingq-mcp serve
  isingq-mcp onboard
  isingq-mcp setup
  isingq-mcp setup --stdin
  isingq-mcp configure-host --name <workbuddy|codex|claude-code|cursor|vscode|generic> [--npx]
  isingq-mcp configure-hosts --detected [--npx]
  isingq-mcp self-check --json
  isingq-mcp config --json [--npx]
`;
}

async function readSecretFromStdin() {
  if (process.stdin.isTTY) throw new Error('setup --stdin 只接受管道输入；交互配置请运行 isingq-mcp setup');
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) throw new Error('stdin 中的 API Key 超过 64 KiB');
  }
  return value.trim();
}

function readTerminal(prompt, hidden = true) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('setup 必须在交互终端运行；Headless 管理员可在启动进程前注入 ISINGQ_API_KEY');
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    }
    function onData(chunk) {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('用户取消'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          if (value && !hidden) process.stderr.write('\b \b');
          value = value.slice(0, -1);
        } else {
          value += character;
          if (!hidden) process.stderr.write(character);
        }
      }
    }
    process.stdin.on('data', onData);
  });
}

function readSecret(prompt) {
  return readTerminal(prompt, true);
}

async function onboard() {
  const key = await readSecret('IsingQ API Key: ');
  const file = saveApiKey(key);
  const detected = detectHosts();
  let selected = detected.length ? detected : ['generic'];
  if (detected.length > 1) {
    const answer = (await readTerminal(
      `检测到 Agent Host：${detected.join(', ')}。配置哪些 Host [all]: `,
      false,
    )).trim();
    if (answer && answer !== 'all') {
      selected = [...new Set(answer.split(',').map((value) => value.trim()).filter(Boolean))];
      for (const host of selected) {
        if (!detected.includes(host)) throw new Error(`选择的 Agent Host 未检测到（host=${host}, detected=${detected.join(',')}）`);
      }
      if (!selected.length) throw new Error('至少选择一个 Agent Host');
    }
  }
  const configuredHosts = configureHosts(selected, mcpCommand());
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'configured',
    api_key_file: file,
    configured_hosts: configuredHosts,
  })}\n`);
}

function configureDetectedHosts(command = mcpCommand()) {
  const detected = detectHosts();
  const selected = detected.length ? detected : ['generic'];
  const configuredHosts = configureHosts(selected, command);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'configured',
    configured_hosts: configuredHosts,
  })}\n`);
}

function configureNamedHost(name, command = mcpCommand()) {
  const supported = ['workbuddy', 'codex', 'claude-code', 'cursor', 'vscode', 'generic'];
  if (!supported.includes(name)) {
    throw new Error(`不支持的 Agent Host（host=${name}, supported=${supported.join(',')}）`);
  }
  const configuredHosts = configureHosts([name], command, undefined, { writeGeneric: false });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'configured',
    configured_hosts: configuredHosts,
  })}\n`);
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === 'serve')) {
    await serve();
    return 0;
  }
  if (argv.length === 1 && ['-h', '--help', 'help'].includes(argv[0])) {
    process.stdout.write(usage());
    return 0;
  }
  if (argv.length === 1 && ['-v', '--version'].includes(argv[0])) {
    process.stdout.write(`isingq-mcp ${VERSION}\n`);
    return 0;
  }
  if (argv.length === 1 && argv[0] === 'setup') {
    const key = await readSecret('IsingQ API Key: ');
    const file = saveApiKey(key);
    process.stdout.write(`${JSON.stringify({ ok: true, status: 'configured', api_key_file: file })}\n`);
    return 0;
  }
  if (argv.length === 2 && argv[0] === 'setup' && argv[1] === '--stdin') {
    const key = await readSecretFromStdin();
    const file = saveApiKey(key);
    process.stdout.write(`${JSON.stringify({ ok: true, status: 'configured', api_key_file: file })}\n`);
    return 0;
  }
  if (argv.length === 1 && argv[0] === 'onboard') {
    await onboard();
    return 0;
  }
  if ((argv.length === 2 || argv.length === 3) && argv[0] === 'configure-hosts' && argv[1] === '--detected') {
    if (argv.length === 3 && argv[2] !== '--npx') throw new Error(`不支持的选项（option=${argv[2]}）`);
    configureDetectedHosts(argv.includes('--npx') ? npxMcpCommand() : mcpCommand());
    return 0;
  }
  if ((argv.length === 3 || argv.length === 4) && argv[0] === 'configure-host' && argv[1] === '--name') {
    if (argv.length === 4 && argv[3] !== '--npx') throw new Error(`不支持的选项（option=${argv[3]}）`);
    configureNamedHost(argv[2], argv.includes('--npx') ? npxMcpCommand() : mcpCommand());
    return 0;
  }
  if (argv.length === 2 && argv[0] === 'self-check' && argv[1] === '--json') {
    try {
      apiKey();
      process.stdout.write(`${JSON.stringify({ ok: true, version: VERSION, api_key: 'configured' })}\n`);
      return 0;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, version: VERSION, problems: [error.message] })}\n`);
      return 1;
    }
  }
  if ((argv.length === 2 || argv.length === 3) && argv[0] === 'config' && argv[1] === '--json') {
    if (argv.length === 3 && argv[2] !== '--npx') throw new Error(`不支持的选项（option=${argv[2]}）`);
    process.stdout.write(`${JSON.stringify({
      mcpServers: { isingq: argv.includes('--npx') ? npxMcpCommand() : mcpCommand() },
      dataDirectory: roots().data,
    }, null, 2)}\n`);
    return 0;
  }
  throw new Error(`不支持的命令（argv=${JSON.stringify(argv)}）\n${usage()}`);
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'ISINGQ_MCP_FAILED', message: error.message } })}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  configureDetectedHosts,
  configureNamedHost,
  isStandaloneExecutable,
  main,
  mcpCommand,
  npxMcpCommand,
  onboard,
  readSecret,
  readSecretFromStdin,
  readTerminal,
};
