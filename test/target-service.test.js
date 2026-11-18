'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../packages/core');

test('a finite input whose recomputed objective overflows is a result validation issue, not a successful business value', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-target-overflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = { id: 1, name: 'isolated', spinNumber: '2', price: 0, computeCreditCost: 0,
    executionCapabilities: { problemTypes: ['qubo'], minDimension: 1, maxDimension: 2, inputFormats: ['csv'], maxCalculateCount: 1, supportsH: false, fixedPostProcess: null } };
  const service = new core.SolverService({ store: new SolveStore({ XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory }), targetOptions: {
    catalogClientFactory: () => ({ get: async () => ({ schemaVersion: 1, uploadLimits: { maxCsvBytes: 1048576 }, computerTypes: [entry] }) }),
    cloudTransportFactory: () => ({ execution_mode: 'unknown', prepareSubmission: () => ({}),
      submit: async () => ({ task_id: 'finite-input-fixture' }),
      poll: async () => ({ status: 'succeeded', provider_status: 2, bits: [1, 1], energy: 0 }) }),
  } });
  const input = { target: { kind: 'cloud', environment: 'sit', computer_type_id: 1 },
    qubo: { num_bits: 2, linear: [{ index: 0, coefficient: 1e308 }, { index: 1, coefficient: 1e308 }] },
    solver_options: { post_process: 0, use_credit: false } };
  const preparation = await service.prepareTarget(input);
  const run = await service.startTarget({ ...input, preparation_token: preparation.preparation_token, model_summary: 'finite input', idempotency_key: 'finite-input' });
  const observed = await service.poll(run.solve_id);
  assert.equal(observed.status, 'result_invalid');
  assert.equal(observed.provider_status, 2);
  assert.equal(observed.result, null);
  assert.match(observed.error.message, /复算.*有限/);
});


test('explicit solver targets expose a versioned capability separate from legacy cloud start', () => {
  assert.equal(core.SOLVER_TARGET_CONTRACT_VERSION, 'isingq-solver-target-v1');
  for (const name of ['listTargets', 'prepareTarget', 'startTarget', 'listRuns', 'profileList', 'profileSave', 'profileDelete', 'openTargetConfig']) {
    assert.equal(typeof core.SolverService.prototype[name], 'function', name);
  }
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SolveStore } = require('../packages/core/src/store');
const { IsingQError } = require('../packages/core/src/isingq');

test('unknown uploaded problem cannot be resubmitted by changing only offset or variable labels and a fresh key', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-target-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SolveStore({ XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory });
  const entry = { id: 1, name: 'isolated', spinNumber: '2', price: 0, computeCreditCost: 0,
    executionCapabilities: { problemTypes: ['qubo'], minDimension: 1, maxDimension: 2, inputFormats: ['csv', 'npz'],
      maxCalculateCount: 1, supportsH: false, fixedPostProcess: null } };
  let creates = 0;
  const service = new core.SolverService({ store, targetOptions: {
    catalogClientFactory: () => ({ get: async () => ({ schemaVersion: 1, uploadLimits: { maxCsvBytes: 1048576 }, computerTypes: [entry] }) }),
    cloudTransportFactory: () => ({ execution_mode: 'unknown', prepareSubmission: () => ({}),
      submit: async () => { creates += 1; throw new IsingQError('isolated missing receipt', { phase: 'create_task', submissionOutcome: 'unknown' }); } }),
  } });
  const input = { target: { kind: 'cloud', environment: 'sit', computer_type_id: 1 },
    qubo: { num_bits: 2, linear: [{ index: 0, coefficient: -1 }], offset: 3, variables: [{ index: 0, name: 'A' }] },
    solver_options: { post_process: 0, use_credit: false } };
  const prepared = await service.prepareTarget(input);
  await assert.rejects(service.startTarget({ ...input, preparation_token: prepared.preparation_token, model_summary: 'fixture', idempotency_key: 'original' }));
  for (const qubo of [
    { ...input.qubo, offset: 9 },
    { ...input.qubo, variables: [{ index: 0, name: 'renamed' }] },
  ]) {
    const variant = { ...input, qubo };
    const ready = await service.prepareTarget(variant);
    assert.equal(ready.ready, true);
    await assert.rejects(service.startTarget({ ...variant, preparation_token: ready.preparation_token,
      model_summary: 'metadata changed only', idempotency_key: 'changed-' + String(qubo.offset) + qubo.variables[0].name }),
      error => error.code === 'target_unresolved_submission');
  }
  assert.equal(creates, 1, 'offset and labels are absent from the actual uploaded matrix');
});
