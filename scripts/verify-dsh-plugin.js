#!/usr/bin/env node
'use strict';

// Full-package acceptance for the native DSH adapter, on an isolated DSH_HOME.
// Installs the packed plugin tarball (not a copied index.mjs), loads it in the
// real host process, executes the three local tools, and records the resolved
// core path/version/digest plus a separate shutdown snapshot.
//
// Usage:
//   node scripts/verify-dsh-plugin.js --host desktop --host-version 0.2.2-rc.1 \
//     --dsh "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
//     --plugin /tmp/isingq-candidate/ising-tech-isingq-dsh-plugin-0.8.2.tgz \
//     --core /tmp/isingq-candidate/ising-tech-isingq-core-0.8.2.tgz \
//     --out /tmp/isingq-verify-desktop
//
// Exits 0 only when the plugin verified, the host stayed alive through the
// grace window, and the shutdown snapshot was written. A host that exits after
// registering tools fails the run; its plugin evidence is still preserved.

const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const inspectorSource = path.join(root, 'scripts/dsh-verify-inspector');

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) flags.add(key);
    else {
      values[key] = next;
      index += 1;
    }
  }
  return { values, flags };
}

function required(values, key) {
  if (!values[key]) throw new Error(`missing --${key}`);
  return values[key];
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sanitize(text) {
  return String(text || '')
    .replace(/Authorization:\s*[^\r\n]+/gi, 'Authorization: <redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/(token=)[^\s&]+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/(sk-[A-Za-z0-9_-]{6,})/g, '<redacted-key>')
    .slice(-800);
}

function coreSourceDigest(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  walk(path.join(root, 'src'));
  files.push(path.join(root, 'package.json'));
  files.sort((a, b) => (a < b ? -1 : 1));
  const hash = createHash('sha256');
  hash.update('isingq-core-source-v1\0');
  for (const file of files) {
    const key = path.relative(root, file).split(path.sep).join('/');
    const bytes = fs.readFileSync(file);
    hash.update(JSON.stringify([key, bytes.length]));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function coreExpectation(coreTarball) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-core-expect-'));
  try {
    const tar = spawnSync('tar', ['-xzf', coreTarball, '-C', directory], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`core tarball extract failed (exit=${tar.status})`);
    const root = path.join(directory, 'package');
    return {
      version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      sha256: coreSourceDigest(root),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function evaluate(summary, expected) {
  const ready = summary.evidence?.ready;
  const verified = summary.evidence?.verified;
  const checks = {
    install_plugin_exit_zero: summary.install?.plugin_exit === 0,
    ready_snapshot: Boolean(ready),
    ready_tools: ready?.isingq_tools?.length === expected.tools,
    verified_snapshot: Boolean(verified),
    plugin_passed: verified?.passed === true,
    tools_match: verified?.tools_match === true && verified?.isingq_tools?.length === expected.tools,
    core_version: verified?.artifacts?.core_version === expected.coreVersion,
    core_sha256: verified?.artifacts?.core_sha256 === expected.coreSha256,
    host_alive_after_grace: summary.host_run?.alive_after_grace === true,
    host_exit_zero: summary.host_run?.exit?.code === 0 && summary.host_run?.exit?.signal === null,
    closed_snapshot: summary.host_run?.closed_snapshot === true,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function commandFor(dsh) {
  return dsh.endsWith('.js') ? [process.execPath, dsh] : [dsh];
}

function run(command, args, env, options = {}) {
  return spawnSync(command, args, {
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 180000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await sleep(250);
  }
  return false;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const host = values.host || 'unknown';
  const hostVersion = required(values, 'host-version');
  const dsh = path.resolve(required(values, 'dsh'));
  const plugin = path.resolve(required(values, 'plugin'));
  const core = path.resolve(required(values, 'core'));
  const out = path.resolve(required(values, 'out'));
  const waitMs = Number(values['wait-ms'] || 60000);
  const graceMs = Number(values['grace-ms'] || 5000);
  const keep = flags.has('keep');

  fs.mkdirSync(out, { recursive: true });
  const evidence = path.join(out, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  for (const file of fs.readdirSync(evidence)) if (file.startsWith('snapshot-')) fs.rmSync(path.join(evidence, file));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-dsh-verify-'));
  const profile = path.join(home, 'profiles/verify');
  const env = {
    ...process.env,
    DSH_HOME: home,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    VERIFY_OUT: evidence,
    VERIFY_HOST: host,
    VERIFY_HOST_VERSION: hostVersion,
    VERIFY_BOOT_ID: new Date().toISOString().replace(/[:.]/g, '-'),
    VERIFY_PLUGIN_DIR: path.join(profile, 'node_modules/@ising-tech/isingq-dsh-plugin'),
  };
  const [command, ...prefix] = commandFor(dsh);
  const derived = coreExpectation(core);
  const expected = {
    tools: Number(values['expect-tools'] || 12),
    coreVersion: values['expect-core-version'] || derived.version,
    coreSha256: values['expect-core-sha256'] || derived.sha256,
  };
  const summary = {
    host, host_version: hostVersion, dsh, plugin, core,
    plugin_sha256: sha256(plugin), core_sha256_tarball: sha256(core),
    expectations: expected, install: {}, evidence: {}, host_run: {},
  };

  try {
    const init = run(command, [...prefix, 'plugin', '--profile', 'verify', 'add'], env);
    summary.install.profile_init_exit = init.status;
    if (!fs.existsSync(path.join(profile, 'package.json'))) throw new Error('profile initialization did not create package.json');

    const manifestPath = path.join(profile, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dsh = manifest.dsh || {};
    manifest.dsh.profile = manifest.dsh.profile || {};
    manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      'overrides:',
      `  "@ising-tech/isingq-core": "file:${core}"`,
      '',
    ].join('\n'));

    const installed = run(command, [...prefix, 'plugin', '--profile', 'verify', 'add', plugin], env);
    summary.install.plugin_exit = installed.status;
    summary.install.plugin_message = sanitize(`${installed.stderr || ''}${installed.stdout || ''}`);
    if (installed.status !== 0) throw new Error(`plugin install failed (exit=${installed.status})`);

    const inspector = run(command, [...prefix, 'plugin', '--profile', 'verify', 'add', inspectorSource], env);
    summary.install.inspector_exit = inspector.status;
    if (inspector.status !== 0) throw new Error(`inspector install failed (exit=${inspector.status})`);
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: dsh-verify-inspector',
      '      name: dsh-verify-inspector',
      '',
    ].join('\n'));

    const child = spawn(command, [...prefix, '--profile', 'verify', '--no-open', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-4000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    const verifiedFile = path.join(evidence, `snapshot-verified-${env.VERIFY_BOOT_ID}.json`);
    const closedFile = path.join(evidence, `snapshot-closed-${env.VERIFY_BOOT_ID}.json`);
    const readyFile = path.join(evidence, `snapshot-ready-${env.VERIFY_BOOT_ID}.json`);
    const verifiedAppeared = await waitForFile(verifiedFile, waitMs);
    summary.evidence.ready = readJson(readyFile);
    summary.evidence.verified = readJson(verifiedFile);

    await sleep(graceMs);
    const aliveAfterGrace = child.exitCode === null && child.signalCode === null;
    summary.host_run.alive_after_grace_ms = graceMs;
    summary.host_run.alive_after_grace = aliveAfterGrace;
    summary.host_run.stdout = sanitize(stdout);
    summary.host_run.stderr = sanitize(stderr);

    if (aliveAfterGrace) child.kill('SIGTERM');
    const exit = await Promise.race([exited, sleep(5000).then(() => undefined)]);
    if (!exit) child.kill('SIGKILL');
    const closedAppeared = await waitForFile(closedFile, 5000);
    summary.host_run.exit = exit || { code: null, signal: 'SIGKILL' };
    summary.evidence.closed = readJson(closedFile);
    summary.host_run.verified_snapshot = verifiedAppeared;
    summary.host_run.closed_snapshot = closedAppeared;

    const result = evaluate(summary, expected);
    summary.passed = result.passed;
    summary.checks = result.checks;
    const summaryFile = path.join(out, 'verify-summary.json');
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({
      passed: result.passed,
      checks: result.checks,
      host,
      host_version: hostVersion,
      tools: summary.evidence.verified?.isingq_tools?.length ?? 0,
      execution: Object.fromEntries(Object.entries(summary.evidence.verified?.execution || {}).map(([key, value]) => [key, value.passed])),
      summary: summaryFile,
    }));
    if (!result.passed) process.exitCode = 1;
  } finally {
    if (!keep) fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { sanitize, evaluate, coreExpectation, coreSourceDigest };

if (require.main === module) {
  main().catch((error) => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}
