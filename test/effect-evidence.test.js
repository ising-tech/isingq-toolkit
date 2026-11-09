'use strict';
// Keep optional release metadata out of unrelated behavior fixtures.
process.env.ISINGQ_UPDATE_CHECK = 'off';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const core = require('../packages/core');
const { IsingQTransport, IsingQError } = require('../src/isingq');
const { createHandler } = require('../src/server');

const ARGS = { qubo: { num_bits: 1 }, model_summary: 'execution evidence', idempotency_key: 'effect-test', solver_options: { use_credit: false } };
function fixture(mode, taskId = 'plain-provider-task') {
  const records = new Map();
  const events = [];
  const store = { save(run) { events.push('save'); records.set(run.solve_id, structuredClone(run)); }, get(id) { return structuredClone(records.get(id)); }, findByIdempotency(digest) { return [...records.values()].find(run => run.idempotency_digest === digest); } };
  const transport = {
    ...(mode === undefined ? {} : { execution_mode: mode }),
    prepareSubmission() { events.push('credentials'); return {}; },
    async submit() { events.push('submit'); return { task_id: taskId }; },
    async poll() { events.push('poll'); return { status: 'succeeded', bits: [0], energy: 0 }; },
  };
  return { service: new core.SolverService({ store, transport }), store, transport, events };
}

test('effect evidence has a detectable shared contract and official transport declares live', () => {
  assert.equal(core.EFFECT_EVIDENCE_CONTRACT_VERSION, 'isingq-effect-evidence-v1');
  assert.equal(typeof core.normalizeSetupResult, 'function');
  assert.equal(new IsingQTransport({ apiKey: () => { throw new Error('must not read'); } }).execution_mode, 'live');
});

test('execution evidence survives start, cached hits, poll, storage and get without inferring from IDs', async () => {
  for (const [mode, id, source, billing] of [
    ['simulation', 'ordinary-task-1', 'simulation', 'not_applicable'],
    ['live', 'mock-looking-task', 'isingq_api', 'unverified'],
    [undefined, 'mock-looking-task', 'unknown', 'unverified'],
  ]) {
    const f = fixture(mode, id);
    const started = await f.service.start(ARGS);
    for (const run of [started, await f.service.start(ARGS), await f.service.poll(started.solve_id), f.service.get(started.solve_id), f.store.get(started.solve_id)]) {
      assert.equal(run.execution_mode, mode ?? 'unknown');
      assert.deepEqual(run.billing, { status: billing });
      if (run.provenance) assert.equal(run.provenance.source, source);
    }
    assert.equal(f.events.filter(event => event === 'submit').length, 1);
  }
});

test('legacy succeeded records remain unknown and unverified regardless of task name', async () => {
  const f = fixture('live', 'mock-legacy-task');
  const created = await f.service.start(ARGS);
  const legacy = f.store.get(created.solve_id);
  delete legacy.execution_mode;
  delete legacy.billing;
  legacy.status = 'succeeded';
  f.store.save(legacy);
  const run = f.service.get(created.solve_id);
  assert.equal(run.execution_mode, 'unknown');
  assert.equal(run.provenance.source, 'unknown');
  assert.deepEqual(run.billing, { status: 'unverified' });
});

test('invalid adapter execution mode is rejected before credentials, storage or submit', async () => {
  const f = fixture('GUESS_FROM_ID');
  await assert.rejects(() => f.service.start(ARGS), /execution_mode/);
  assert.deepEqual(f.events, []);
});

test('fresh and cached failure keep simulation evidence in core and MCP', async () => {
  const f = fixture('simulation');
  f.transport.submit = async () => { throw new IsingQError('test rejection', { phase: 'create_task', status: 400, submissionOutcome: 'rejected' }); };
  const handle = createHandler(f.service);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await handle({ method: 'tools/call', params: { name: 'isingq_solve_start', arguments: ARGS } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.data.execution_mode, 'simulation');
    assert.deepEqual(result.structuredContent.data.billing, { status: 'not_applicable' });
    assert.equal(result.structuredContent.data.provenance.source, 'simulation');
  }
});

test('setup normalizer cannot turn absent evidence or simulation into a real configured credential', () => {
  const simulation = { configured: false, status: 'simulation', execution_mode: 'simulation', credential_effect: 'not_written', remote_verification: 'not_applicable', no_real_credentials: true, credential_presence: 'not_checked' };
  assert.deepEqual(core.normalizeSetupResult(simulation), simulation);
  assert.throws(() => core.normalizeSetupResult({ ...simulation, configured: true }), /configured/);
  assert.throws(() => core.normalizeSetupResult({ ...simulation, credential_effect: 'written' }), /credential_effect/);
  const unknown = core.normalizeSetupResult({ configured: true, status: 'configured', test_runtime_marker: 'arbitrary', api_key: 'SECRET_MUST_NOT_ESCAPE' });
  assert.deepEqual(unknown, { configured: false, status: 'unknown', execution_mode: 'unknown', credential_effect: 'unknown', remote_verification: 'unverified', no_real_credentials: null, credential_presence: 'not_checked' });
  assert.doesNotMatch(JSON.stringify(unknown), /SECRET_MUST_NOT_ESCAPE|test_runtime_marker|api_key/);
  for (const status of ['configured', 'already_configured']) {
    const live = { configured: true, status, execution_mode: 'live', credential_effect: status === 'configured' ? 'written' : 'already_present', remote_verification: 'unverified', no_real_credentials: false, credential_presence: 'available' };
    assert.deepEqual(core.normalizeSetupResult(live), live);
    assert.throws(() => core.normalizeSetupResult({ ...live, remote_verification: 'verified' }), /remote_verification/);
  }
});

test('MCP applies the shared setup normalizer to injected adapters rather than echoing unknown fields', async () => {
  const handle = createHandler({}, { configureApiKey: () => ({ configured: true, status: 'configured', test_runtime_marker: 'SECRET_MUST_NOT_ESCAPE' }) });
  const result = await handle({ method: 'tools/call', params: { name: 'isingq_api_key_setup', arguments: {} } });
  assert.equal(result.structuredContent.data.execution_mode, 'unknown');
  assert.equal(result.structuredContent.data.configured, false);
  assert.equal(result.structuredContent.data.credential_presence, 'not_checked');
  assert.doesNotMatch(JSON.stringify(result), /SECRET_MUST_NOT_ESCAPE|test_runtime_marker/);
});

test('request fields and submit payload cannot forge trusted execution or billing evidence', async () => {
  const f = fixture('simulation');
  f.transport.submit = async () => ({ task_id: 'ordinary-task', execution_mode: 'live', billing: { status: 'charged', amount: 100 } });
  const result = await f.service.start({ ...ARGS, execution_mode: 'live', billing: { status: 'charged' } });
  assert.equal(result.execution_mode, 'simulation');
  assert.equal(result.provenance.source, 'simulation');
  assert.deepEqual(result.billing, { status: 'not_applicable' });
});

test('native DSH normalizes injected legacy setup output and hides arbitrary credential fields', () => {
  const root = path.resolve(__dirname, '..');
  const program = `
    const assert = require('node:assert/strict');
    const core = require(${JSON.stringify(path.join(root, 'packages/core'))});
    let calls=0;
    core.configureApiKeyAsync = async () => calls++ === 0
      ? {configured:true,status:'configured',api_key:'SECRET_DSH_SENTINEL',test_runtime_marker:'untrusted text'}
      : {configured:false,status:'simulation',execution_mode:'simulation',credential_effect:'not_written',remote_verification:'not_applicable',no_real_credentials:true,credential_presence:'not_checked',api_key:'SECRET_DSH_SENTINEL'};
    require(${JSON.stringify(require.resolve('undici'))}).fetch=()=>{throw Error('NETWORK_FORBIDDEN')};
    (async()=>{
      const plugin=await import(${JSON.stringify(require('node:url').pathToFileURL(path.join(root, 'packages/dsh-plugin/index.mjs')).href)});
      const tools=[];plugin.apply({tools:{register(t){tools.push(t)}}});
      const result=await tools.find(t=>t.name==='isingq_api_key_setup').execute({});
      assert.deepEqual(result,{configured:false,status:'unknown',execution_mode:'unknown',credential_effect:'unknown',remote_verification:'unverified',no_real_credentials:null,credential_presence:'not_checked'});
      assert.doesNotMatch(JSON.stringify(result),/SECRET_DSH_SENTINEL|api_key|test_runtime_marker/);
      const simulated=await tools.find(t=>t.name==='isingq_api_key_setup').execute({});
      assert.equal(simulated.credential_presence,'not_checked');assert.equal(simulated.configured,false);
      assert.doesNotMatch(JSON.stringify(simulated),/SECRET_DSH_SENTINEL|api_key/);
      process.stdout.write('DSH_EFFECTS_NORMALIZED');
    })().catch(e=>{process.stderr.write(e.stack);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', program], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS || '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'DSH_EFFECTS_NORMALIZED');
});

test('credential presence is explicit and cannot be inferred from a simulated no-real-credentials operation', () => {
  const simulation = { configured: false, status: 'simulation', execution_mode: 'simulation', credential_effect: 'not_written', remote_verification: 'not_applicable', no_real_credentials: true, credential_presence: 'not_checked' };
  assert.equal(core.normalizeSetupResult(simulation).credential_presence, 'not_checked');
  for (const credential_presence of [undefined, 'missing', 'available']) assert.throws(() => core.normalizeSetupResult({ ...simulation, credential_presence }), /credential_presence/);
  const live = { configured: true, status: 'already_configured', execution_mode: 'live', credential_effect: 'already_present', remote_verification: 'unverified', no_real_credentials: false, credential_presence: 'available' };
  assert.equal(core.normalizeSetupResult(live).credential_presence, 'available');
  assert.throws(() => core.normalizeSetupResult({ ...live, credential_presence: 'not_checked' }), /credential_presence/);
});
