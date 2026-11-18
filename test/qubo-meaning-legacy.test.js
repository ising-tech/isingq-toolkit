'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SolverService, validateQubo, modelDigest, decodeBits, objectiveEnergy } = require('../packages/core');
function qubo(meaning) { return { num_bits: 1, linear: [{ index: 0, coefficient: -2 }], quadratic: [], offset: 3,
  variables: [{ index: 0, name: 'x', meaning }] }; }
test('new QUBO meaning accepts only omitted/null/string and rejects size without echo or coercion', () => {
  let calls = 0;
  for (const meaning of [{ toString() { calls++; return 'private'; } }, [], 7, false, () => 'private', 'private'.repeat(586)]) {
    assert.throws(() => validateQubo(qubo(meaning)), error => /variables\[0\]\.meaning/.test(error.message) && !error.message.includes('private'));
  }
  assert.equal(calls, 0);
  for (const meaning of [undefined, null, '', '  选择  ', '字'.repeat(4096)]) {
    const normalized = validateQubo(qubo(meaning)).qubo;
    assert.equal(normalized.variables[0].meaning, meaning == null ? null : meaning.trim());
    assert.deepEqual(modelDigest(normalized), modelDigest(qubo(meaning)));
  }
});

test('candidate review keeps historical sum semantics and checks the version of new results', () => {
  const { reviewCandidate } = require('../packages/core/src/guided-result-review');
  const { QUBO_OBJECTIVE_ENERGY_VERSION } = require('../packages/core/src/qubo');
  const stored = { qubo: { num_bits: 3, linear: [
    { index: 0, coefficient: 1e16 }, { index: 1, coefficient: 1 }, { index: 2, coefficient: -1e16 },
  ] }, result: { bits: [1, 1, 1], objective_value: 0 } };
  assert.equal(reviewCandidate(stored).qubo_objective, 0);
  assert.equal(objectiveEnergy(stored.qubo, stored.result.bits), 1);
  const current = { ...stored, objective_energy_version: QUBO_OBJECTIVE_ENERGY_VERSION };
  assert.throws(() => reviewCandidate(current), { code: 'review_candidate_mismatch' });
  current.result = { ...stored.result, objective_value: 1 };
  assert.equal(reviewCandidate(current).qubo_objective, 1);
});

test('actual SolverService poll/get preserve legacy long meaning, stored digests and request identity', async () => {
  const meaning = '旧任务业务说明'.repeat(1000), storedQubo = qubo(meaning);
  const requestDigest = crypto.createHash('sha256').update(JSON.stringify({ qubo: storedQubo, solver_options: {} })).digest('hex');
  const record = { schema: 'isingq-mcp-solve/v1', solve_id: 'solve_legacy', status: 'submitted', execution_mode: 'simulation',
    model_summary: 'legacy', qubo: storedQubo, matrix: { num_bits: 1, sha256: 'a'.repeat(64), size_bytes: 2 }, solver_options: {},
    request_digest: requestDigest, idempotency_digest: 'b'.repeat(64), provider_task_id: 'old-task', created_at: '2020-01-01', updated_at: '2020-01-01', submitted_at: '2020-01-01' };
  const before = structuredClone(record); let saves = 0, polls = 0;
  const service = new SolverService({ store: { get() { return record; }, save(value) { assert.equal(value, record); saves++; } },
    transport: { execution_mode: 'simulation', async poll() { polls++; return { status: 'succeeded', bits: [1], energy: -1 }; } } });
  assert.equal(service.get(record.solve_id).status, 'submitted');
  const result = await service.poll(record.solve_id);
  assert.equal(result.status, 'succeeded'); assert.equal(result.result.variables[0].meaning, meaning); assert.equal(result.result.objective_value, 1);
  assert.equal(saves, 1); assert.equal(polls, 1);
  assert.deepEqual(record.qubo, before.qubo); assert.equal(record.request_digest, before.request_digest); assert.equal(record.idempotency_digest, before.idempotency_digest);
  assert.deepEqual(await service.poll(record.solve_id), service.get(record.solve_id)); assert.equal(polls, 1);
  assert.equal(decodeBits(storedQubo, [1])[0].meaning, meaning); assert.equal(objectiveEnergy(storedQubo, [1]), 1);
  assert.throws(() => validateQubo(storedQubo), /meaning/);
});
test('guided file review binds the original digest of a legacy long-meaning record without rewriting it', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { writeMathModelReviewFile } = require('../packages/core');
  const { SolveStore } = require('../packages/core/src/store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qubo-meaning-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = { XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config') };
  const storedQubo = qubo('旧任务业务说明'.repeat(1000));
  // Original isingq-model-v1 canonical order, independently reconstructed from
  // the persisted normalized model; no new-input validation or content editing.
  const originalModelDigest = crypto.createHash('sha256').update(JSON.stringify({ model_digest_version: 'isingq-model-v1',
    num_bits: storedQubo.num_bits, offset: storedQubo.offset, linear: storedQubo.linear, quadratic: storedQubo.quadratic, variables: storedQubo.variables })).digest('hex');
  const store = new SolveStore(environment), record = { solve_id: 'solve_0123456789abcdef0123456789abcdef',
    idempotency_digest: 'a'.repeat(64), request_digest: 'b'.repeat(64), model_sha256: originalModelDigest,
    status: 'succeeded', execution_mode: 'simulation', target: { kind: 'local', name: '历史记录' }, qubo: storedQubo,
    result: { bits: [1], objective_value: 1 } };
  store.save(record); const before = fs.readFileSync(store.path(record.solve_id)); let calls = 0;
  const forbidden = () => { calls++; throw new Error('UNEXPECTED_NETWORK'); };
  const service = new SolverService({ store, transport: { submit: forbidden, poll: forbidden },
    targetOptions: { environment, localTransportFactory: forbidden, catalogClientFactory: forbidden } });
  const model = { schema_version: 'math-model-v1', id: 'legacy-business', variables: [{ id: 'x_0', domain: 'binary' }],
    objective: { sense: 'min', expression: { constant: 3, terms: [{ coefficient: -2, variables: ['x_0'] }] } }, constraints: [] };
  const ref = await writeMathModelReviewFile({ directory: root, model, data: {}, qubo_model_sha256: originalModelDigest });
  const result = await service.guideSolve({ action: 'review', solve_id: record.solve_id, review_file: ref });
  assert.equal(result.status, 'result_reviewed', JSON.stringify(result));
  assert.equal(result.review.objective.value, 1); assert.equal(result.review.decoded[0].meaning, storedQubo.variables[0].meaning);
  assert.deepEqual(fs.readFileSync(store.path(record.solve_id)), before); assert.equal(calls, 0);
});
