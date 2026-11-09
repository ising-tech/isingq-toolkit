import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

export const name = 'dsh-verify-inspector';
export const inject = ['tools'];

const EXPECTED_TOOLS = [
  'isingq_api_key_setup',
  'isingq_delivery_validate',
  'isingq_knowledge_get',
  'isingq_modeling_guide_get',
  'isingq_qubo_validate',
  'isingq_report_verify',
  'isingq_resource_list',
  'isingq_resource_read',
  'isingq_solve_poll',
  'isingq_solve_result_get',
  'isingq_solve_start',
  'isingq_update_check',
].sort();
const EXPECTED_RESOURCES = 13;

function packageRoot(entry) {
  let current = dirname(entry);
  while (!existsSync(join(current, 'package.json'))) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`package root not found for ${entry}`);
    current = parent;
  }
  return current;
}

function coreDigest(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  walk(join(root, 'src'));
  files.push(join(root, 'package.json'));
  files.sort((a, b) => (a < b ? -1 : 1));
  const hash = createHash('sha256');
  hash.update('isingq-core-source-v1\0');
  for (const file of files) {
    const key = relative(root, file).split(sep).join('/');
    const bytes = readFileSync(file);
    hash.update(JSON.stringify([key, bytes.length]));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function inspectArtifacts() {
  try {
    const pluginRoot = process.env.VERIFY_PLUGIN_DIR;
    if (!pluginRoot || !existsSync(join(pluginRoot, 'package.json'))) throw new Error('VERIFY_PLUGIN_DIR missing');
    const pluginEntry = join(pluginRoot, JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).main || 'index.mjs');
    const coreEntry = createRequire(pluginEntry).resolve('@ising-tech/isingq-core');
    const coreRoot = packageRoot(coreEntry);
    return {
      plugin_path: pluginRoot,
      plugin_version: JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version,
      core_path: coreRoot,
      core_version: JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8')).version,
      core_sha256: coreDigest(coreRoot),
      digest_algorithm: 'isingq-core-source-v1',
    };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

export function apply(ctx) {
  const outDir = process.env.VERIFY_OUT;
  mkdirSync(outDir, { recursive: true });
  const bootId = process.env.VERIFY_BOOT_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const host = process.env.VERIFY_HOST || 'unknown';
  const hostVersion = process.env.VERIFY_HOST_VERSION || 'unknown';
  const startedAt = new Date().toISOString();

  const execution = {};
  const errors = [];
  let verified = false;

  const tools = () => [...ctx.tools.view().visible.keys()].sort();
  const isingq = () => tools().filter((tool) => tool.startsWith('isingq_'));
  const base = () => ({
    boot_id: bootId,
    host,
    host_version: hostVersion,
    host_pid: process.pid,
    node_version: process.version,
    captured_at: new Date().toISOString(),
    tools: tools(),
    isingq_tools: isingq(),
    expected_tools: EXPECTED_TOOLS,
    tools_match: JSON.stringify(isingq()) === JSON.stringify(EXPECTED_TOOLS),
    artifacts: inspectArtifacts(),
  });
  const write = (name, value) => {
    writeFileSync(join(outDir, `snapshot-${name}-${bootId}.json`), `${JSON.stringify(value, null, 2)}\n`);
  };

  const call = async (label, toolName, args, check) => {
    try {
      const tool = ctx.tools.view().visible.get(toolName);
      if (!tool) throw new Error(`missing tool ${toolName}`);
      const value = await tool.execute(args);
      const checks = check(value);
      const passed = Object.values(checks).every((entry) => entry === true);
      execution[label] = { called: true, passed, checks, error: null };
      if (!passed) errors.push({ label, message: 'field assertion failed', checks });
    } catch (error) {
      execution[label] = { called: false, passed: false, checks: {}, error: { code: error?.code || null, message: String(error?.message || error) } };
      errors.push({ label, message: String(error?.message || error) });
    }
  };

  const verify = async () => {
    if (verified) return;
    verified = true;
    await call('knowledge', 'isingq_knowledge_get', { topic: 'company', locale: 'zh-CN' }, (value) => ({
      topic_company: value?.topic === 'company',
      answer_has_company: typeof value?.answer === 'string' && value.answer.includes('北京伊辛智能科技有限公司'),
      sources_present: Array.isArray(value?.sources) && value.sources.length > 0,
      knowledge_version_present: typeof value?.knowledge_version === 'string' && value.knowledge_version.length > 0,
    }));
    await call('guide', 'isingq_modeling_guide_get', { problem_summary: 'minimal verification' }, (value) => ({
      required_sequence_array: Array.isArray(value?.required_sequence),
      qubo_contract_object: Boolean(value?.qubo_contract) && typeof value.qubo_contract === 'object',
      intent_routes_object: Boolean(value?.intent_routes) && typeof value.intent_routes === 'object',
    }));
    await call('qubo', 'isingq_qubo_validate', { qubo: { num_bits: 1 } }, (value) => ({
      num_bits_one: value?.num_bits === 1,
      linear_terms_number: typeof value?.linear_terms === 'number',
      quadratic_terms_number: typeof value?.quadratic_terms === 'number',
      matrix_sha256_hex: typeof value?.matrix_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.matrix_sha256),
      model_sha256_hex: typeof value?.model_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.model_sha256),
      digest_version: value?.model_digest_version === 'isingq-model-v1',
    }));
    await call('resources', 'isingq_resource_list', {}, (value) => ({
      count_13: Array.isArray(value) && value.length === EXPECTED_RESOURCES,
    }));
    write('verified', {
      ...base(),
      started_at: startedAt,
      verified_at: new Date().toISOString(),
      execution,
      errors,
      passed: isingq().length === EXPECTED_TOOLS.length && Object.values(execution).every((entry) => entry.passed) && errors.length === 0,
    });
  };

  let firstWritten = false;
  let readyWritten = false;
  const onChange = () => {
    if (!firstWritten) {
      firstWritten = true;
      write('first-tools', base());
    }
    if (!readyWritten && JSON.stringify(isingq()) === JSON.stringify(EXPECTED_TOOLS)) {
      readyWritten = true;
      write('ready', base());
      verify().catch((error) => {
        errors.push({ label: 'verify', message: String(error?.message || error) });
        write('verified', { ...base(), execution, errors, passed: false, verified_at: new Date().toISOString() });
      });
    }
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    write('closed', {
      boot_id: bootId,
      host,
      host_version: hostVersion,
      closed_at: new Date().toISOString(),
      tools_at_close: tools(),
      verified,
      execution,
      errors,
    });
  };

  ctx.on('tools/change', onChange);
  ctx.on('ready', onChange);
  try { ctx.effect(() => close); } catch { /* older hosts: fall back to the dispose event */ }
  ctx.on('dispose', close);
  process.on('exit', close);
}
