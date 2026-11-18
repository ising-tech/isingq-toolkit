'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SolverService, writeMathModelReviewFile } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { createHandler } = require('../src/server');
const { matrixDocument, modelDigest } = require('../packages/core/src/qubo');
const qubo = { num_bits: 2, linear: [{ index: 0, coefficient: -3 }, { index: 1, coefficient: -2 }], quadratic: [{ i: 0, j: 1, coefficient: 8 }] };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const next = (value, action) => value.actions.find(item => item.call.arguments.action === action).call.arguments;
function fixture(t, environmentOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-qubo-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = { XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), ...environmentOverrides };
  const store = new SolveStore(environment), state = { probes: 0, catalogs: 0, submits: [] };
  const service = new SolverService({ store, targetOptions: { environment,
    catalogClientFactory: () => ({ get: async () => { state.catalogs++; throw Error('unexpected offline catalog call'); } }),
    localTransportFactory: () => ({ execution_mode: 'simulation', prepareSubmission: () => ({}),
      probe: async () => { state.probes++; return { config: { deviceName: 'fixture', version: '1', maxScale: 4095, maxPrecision: '8bit' }, runtime: { bootTimestamp: 1 }, status: { status: 'stable' } }; },
      submit: async (file, options) => { state.submits.push({ content: Buffer.from(file.content), options }); return { task_id: 'offline-fixture' }; },
      poll: async () => ({ status: 'succeeded', bits: [1, 0], energy: -3 }),
    }),
  } });
  service.profileSave({ name: '离线设备', api_base_url: 'http://fixture.test' });
  function write(content = JSON.stringify(qubo), name = 'qubo.json') {
    const file = path.join(root, name), bytes = Buffer.from(content);
    fs.writeFileSync(file, bytes);
    return { path: file, sha256: sha(bytes) };
  }
  const requestFiles = () => fs.existsSync(path.join(store.directory, '.guided')) ? fs.readdirSync(path.join(store.directory, '.guided')).filter(name => /^request_.*\.json$/.test(name)) : [];
  const plan = value => JSON.parse(fs.readFileSync(path.join(store.directory, '.guided', next(value, value.status === 'modeled' ? 'prepare' : 'confirm').request_id + '.json'), 'utf8'));
  return { root, service, state, store, write, requestFiles, plan, handler: createHandler(service) };
}
test('ordinary MCP imports a small QUBO descriptor with the same model and matrix as inline input', async t => {
  const f = fixture(t), descriptor = f.write();
  const result = await f.handler({ method: 'tools/call', params: { name: 'isingq_solve', arguments: { action: 'model', qubo_file: descriptor, problem_summary: '选择一个项目' } } });
  const imported = result.structuredContent.data;
  assert.equal(imported.status, 'modeled', JSON.stringify(imported));
  const inline = await f.service.guideSolve({ action: 'model', qubo, problem_summary: '选择一个项目' });
  assert.deepEqual(f.plan(imported).qubo, f.plan(inline).qubo);
  assert.equal(modelDigest(f.plan(imported).qubo).model_sha256, modelDigest(qubo).model_sha256);
  assert.equal(f.plan(imported).artifacts.files[2].sha256, matrixDocument(qubo).sha256);
  assert.equal(f.plan(imported).artifacts.files[2].sha256, f.plan(inline).artifacts.files[2].sha256);
  assert.deepEqual(f.state, { probes: 0, catalogs: 0, submits: [] });
});
test('file input rejects invalid sources before targets or request creation', async t => {
  const cases = [
    ['both inputs', f => ({ qubo, qubo_file: f.write() }), 'qubo_input_invalid'],
    ['missing input', () => ({}), 'qubo_input_invalid'],
    ['null descriptor', () => ({ qubo_file: null }), 'qubo_file_invalid'],
    ['missing hash', f => ({ qubo_file: { path: f.write().path } }), 'qubo_file_invalid'],
    ['extra field', f => ({ qubo_file: { ...f.write(), other: true } }), 'qubo_file_invalid'],
    ['bad hash', f => ({ qubo_file: { ...f.write(), sha256: '0'.repeat(64) } }), 'qubo_file_digest_mismatch'],
    ['invalid UTF-8', f => ({ qubo_file: f.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])) }), 'qubo_file_json_invalid'],
    ['invalid JSON', f => ({ qubo_file: f.write('{"secret":"must-not-echo",') }), 'qubo_file_json_invalid'],
    ['invalid QUBO', f => ({ qubo_file: f.write('{"num_bits":0}') }), 'model_invalid'],
    ['directory', f => ({ qubo_file: { path: f.root, sha256: '0'.repeat(64) } }), 'file_type_invalid'],
    ['symlink', f => { const file = f.write(), link = path.join(f.root, 'link.json'); fs.symlinkSync(file.path, link); return { qubo_file: { ...file, path: link } }; }, 'file_type_invalid'],
    ['missing file', f => ({ qubo_file: { path: path.join(f.root, 'missing.json'), sha256: '0'.repeat(64) } }), 'qubo_file_unavailable'],
    ['capacity exceeded', f => ({ qubo_file: f.write() }), 'file_too_large', { ISINGQ_MAX_LOCAL_FILE_BYTES: '10' }],
    ['capacity setting invalid', f => ({ qubo_file: f.write() }), 'file_limit_invalid', { ISINGQ_MAX_LOCAL_FILE_BYTES: '10MiB' }],
  ];
  for (const [name, input, code, environment] of cases) await t.test(name, async t => {
    const f = fixture(t, environment), result = await f.service.guideSolve({ action: 'prepare', problem_summary: '失败不准备目标', ...input(f) });
    assert.equal(result.status, 'blocked'); assert.equal(result.blockers[0].code, code, JSON.stringify(result));
    assert.doesNotMatch(JSON.stringify(result), /must-not-echo/);
    assert.deepEqual(f.requestFiles(), []); assert.deepEqual(f.state, { probes: 0, catalogs: 0, submits: [] });
  });
});
test('file input hashes and parses its only bounded read and accepts the exact byte limit', async t => {
  const content = JSON.stringify(qubo) + ' '.repeat(10000), f = fixture(t, { ISINGQ_MAX_LOCAL_FILE_BYTES: String(Buffer.byteLength(content)) }), descriptor = f.write(content);
  const open = fs.openSync, read = fs.readSync;
  let sourceFd, opens = 0, changed = false;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    const fd = open.call(fs, file, ...args);
    if (file === descriptor.path) { sourceFd = fd; opens++; }
    return fd;
  });
  t.mock.method(fs, 'readSync', function(fd, ...args) {
    const count = read.call(fs, fd, ...args);
    if (fd === sourceFd && count === 0 && !changed) { changed = true; fs.writeFileSync(descriptor.path, '{"num_bits":1}'); }
    return count;
  });
  const result = await f.service.guideSolve({ action: 'model', qubo_file: descriptor, problem_summary: '读取一次的固定快照' });
  assert.equal(result.status, 'modeled', JSON.stringify(result)); assert.equal(opens, 1); assert.equal(changed, true);
  assert.equal(modelDigest(f.plan(result).qubo).model_sha256, modelDigest(qubo).model_sha256);
});
test('ordinary discovery retains four tools and describes file input without changing follow-up calls', async t => {
  const f = fixture(t), { tools } = await f.handler({ method: 'tools/list' });
  assert.deepEqual(tools.map(tool => tool.name), ['isingq_api_key_setup','isingq_knowledge_get','isingq_modeling_guide_get','isingq_solve']);
  const tool = tools.find(tool => tool.name === 'isingq_solve');
  assert.deepEqual(tool.inputSchema.properties.qubo_file.required, ['path', 'sha256']);
  assert.equal(tool.inputSchema.properties.qubo_file.properties.sha256.pattern, '^[a-f0-9]{64}$');
  assert.match(tool.description, /本地建模程序生成qubo.json/);
  const guide = (await f.handler({ method: 'tools/call', params: { name: 'isingq_modeling_guide_get', arguments: {} } })).structuredContent.data;
  assert.match(guide.qubo_file_workflow, /review_file.*不能代替QUBO输入/);
  const result = await f.handler({ method: 'tools/call', params: { name: 'isingq_solve', arguments: { action: 'prepare', qubo_file: f.write(), problem_summary: '原生服务入口准备' } } });
  assert.equal(result.structuredContent.data.status, 'ready');
  assert.ok(result.structuredContent.data.actions.every(item => !Object.hasOwn(item.call.arguments, 'qubo_file')));
});
test('4095-variable file model and prepare responses keep only saved-request continuation calls', async t => {
  const f = fixture(t), large = { num_bits: 4095,
    linear: Array.from({ length: 4095 }, (_, index) => ({ index, coefficient: -1 })),
    variables: Array.from({ length: 4095 }, (_, index) => ({ index, name: 'AP' + (index + 1), meaning: '原业务数据中对应的设备分组变量，保留完整映射。' })),
  };
  const descriptor = f.write(JSON.stringify(large));
  assert.ok(fs.statSync(descriptor.path).size > 500000);
  for (const action of ['model', 'prepare']) {
    const args = { action, qubo_file: descriptor, problem_summary: '保留全部4095设备变量' };
    assert.ok(Buffer.byteLength(JSON.stringify(args)) < 1024);
    const response = await f.handler({ method: 'tools/call', params: { name: 'isingq_solve', arguments: args } }), result = response.structuredContent.data;
    assert.equal(result.status, action === 'model' ? 'modeled' : 'ready', JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 20 * 1024);
    assert.ok(result.actions.every(item => !Object.hasOwn(item.call.arguments, 'qubo') && !Object.hasOwn(item.call.arguments, 'qubo_file')));
    assert.equal(f.plan(result).qubo.variables.length, 4095);
  }
  assert.equal(f.state.submits.length, 0);
});
test('prepared file input uses its saved snapshot after source replacement and preserves review continuation', async t => {
  const f = fixture(t), descriptor = f.write();
  const reviewFile = await writeMathModelReviewFile({ directory: f.root, qubo, data: {},
    model: { schema_version: 'math-model-v1', id: 'project', variables: [{ id: 'x_0', domain: 'binary' }, { id: 'x_1', domain: 'binary' }],
      objective: { sense: 'max', expression: { terms: [{ coefficient: 3, variables: ['x_0'] }, { coefficient: 2, variables: ['x_1'] }] } }, constraints: [] } });
  const mismatch = f.write(JSON.stringify({ ...qubo, offset: 1 }), 'different-qubo.json');
  const blocked = await f.service.guideSolve({ action: 'prepare', qubo_file: mismatch, review_file: reviewFile, problem_summary: '不能更换业务核验绑定' });
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.blockers[0].code, 'review_candidate_mismatch');
  assert.deepEqual(f.requestFiles(), []); assert.deepEqual(f.state, { probes: 0, catalogs: 0, submits: [] });
  const prepared = await f.service.guideSolve({ action: 'prepare', qubo_file: descriptor, review_file: reviewFile, problem_summary: '项目收益', model_markdown: '$x_i \\in \\{0,1\\}$，最大化收益。' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const confirmation = next(prepared, 'confirm'), originalPlan = f.plan(prepared);
  assert.deepEqual(originalPlan.review_file, reviewFile);
  assert.match(prepared.modeling.markdown, /最大化收益/);
  fs.writeFileSync(descriptor.path, '{"num_bits":100}');
  const refreshed = await f.service.guideSolve({ action: 'refresh', request_id: confirmation.request_id });
  assert.equal(refreshed.status, 'ready'); assert.equal(next(refreshed, 'confirm').confirmation_ref, confirmation.confirmation_ref);
  fs.unlinkSync(descriptor.path);
  const submitted = await f.service.guideSolve(confirmation);
  assert.equal(submitted.status, 'submitted'); assert.equal(f.state.submits.length, 1);
  assert.deepEqual(f.state.submits[0].content, matrixDocument(qubo).content);
  const candidate = await f.service.guideSolve(next(submitted, 'status')), reviewCall = next(candidate, 'review');
  assert.deepEqual(reviewCall.review_file, reviewFile);
  const reviewed = await f.service.guideSolve(reviewCall);
  assert.equal(reviewed.status, 'result_reviewed', JSON.stringify(reviewed)); assert.equal(reviewed.review.objective.value, 3);
  await f.service.guideSolve(confirmation); assert.equal(f.state.submits.length, 1);
});

test('guided export fits a compact normalized QUBO under the same per-file capacity as the input and CSV', async t => {
  const f = fixture(t, { ISINGQ_MAX_LOCAL_FILE_BYTES: '4096' });
  const quadratic = Array.from({ length: 15 }, (_, i) => i)
    .flatMap(i => Array.from({ length: 14 - i }, (_, j) => ({ i, j: i + j + 1, coefficient: 1 })))
    .slice(0, 95);
  const input = { num_bits: 15, quadratic, variables: [{ index: 0, name: 'project', meaning: 'meaning' }] };
  input.variables[0].meaning += '.'.repeat(3249 - Buffer.byteLength(JSON.stringify(input)));
  const content = JSON.stringify(input), descriptor = f.write(content);
  const matrix = matrixDocument(input);
  assert.equal(Buffer.byteLength(content), 3249);
  assert.equal(matrix.content.length, 450);
  assert.ok(Buffer.byteLength(JSON.stringify(matrix.qubo, null, 2)) > 4096);

  const modeled = await f.service.guideSolve({ action: 'model', qubo_file: descriptor, problem_summary: '紧凑的规范化模型' });
  assert.equal(modeled.status, 'modeled', JSON.stringify(modeled.blockers));
  const files = Object.fromEntries(modeled.modeling.files.map(file => [path.basename(file.path), fs.readFileSync(file.path)]));
  assert.deepEqual(JSON.parse(files['qubo.json']), matrix.qubo);
  assert.deepEqual(files['matrix.csv'], matrix.content);
  const exactQuboBytes = Buffer.byteLength(JSON.stringify(matrix.qubo));
  assert.equal(files['qubo.json'].length, exactQuboBytes);
  assert.ok(Object.values(files).every(bytes => bytes.length <= exactQuboBytes));
  assert.deepEqual(f.state, { probes: 0, catalogs: 0, submits: [] });
  const exact = fixture(t, { ISINGQ_MAX_LOCAL_FILE_BYTES: String(exactQuboBytes) });
  const boundary = await exact.service.guideSolve({ action: 'model', qubo_file: exact.write(content), problem_summary: '刚好达到上限' });
  assert.equal(boundary.status, 'modeled', JSON.stringify(boundary.blockers));
});

test('guided export checks real UTF-8 output sizes before writing and reports the failing file', async t => {
  const cases = [
    { file: '矩阵CSV文件', input: { num_bits: 15 }, max: 30, bytes: 450 },
    { file: 'QUBO模型文件', input: { num_bits: 45, variables: [{ index: 0, name: 'project', meaning: 'a'.repeat(4020) }] }, max: 4096 },
    { file: '模型说明与公式', input: { num_bits: 1 }, prose: '中'.repeat(4096), max: 4096 },
  ];
  for (const item of cases) await t.test(item.file, async t => {
    const f = fixture(t, { ISINGQ_MAX_LOCAL_FILE_BYTES: String(item.max) });
    const input = JSON.stringify(item.input);
    assert.ok(Buffer.byteLength(input) <= item.max);
    const response = await f.service.guideSolve({
      action: 'prepare', qubo_file: f.write(input), model_markdown: item.prose, problem_summary: '导出字节边界',
    });
    assert.equal(response.status, 'blocked');
    const issue = response.blockers[0];
    assert.equal(issue.code, 'model_artifacts_export_failed', JSON.stringify(response));
    assert.match(issue.message, new RegExp(item.file));
    assert.match(issue.message, new RegExp('bytes=' + (item.bytes ?? '\\d+') + ', max_bytes=' + item.max));
    assert.equal(response.modeling.issue.code, issue.code);
    assert.deepEqual(response.modeling.files, []);
    assert.equal(fs.existsSync(path.join(f.store.directory, '.guided', 'round1', 'output')), false);
    const requestId = next(response, 'refresh').request_id;
    for (const action of ['status', 'refresh']) {
      const retried = await f.service.guideSolve({ action, request_id: requestId });
      assert.equal(retried.blockers[0].code, issue.code);
      assert.equal(retried.blockers[0].message, issue.message);
    }
    assert.deepEqual(f.state, { probes: 0, catalogs: 0, submits: [] });
  });
});

test('history and both review IDs preserve the originally bound model across restart, relocation and request aliasing', async t => {
  const f = fixture(t);
  const review = {
    model: { schema_version: 'math-model-v1', id: 'project',
      variables: [{ id: 'x_0', domain: 'binary' }, { id: 'x_1', domain: 'binary' }],
      objective: { sense: 'min', expression: { terms: [] } },
      constraints: [{ id: 'limit', expression: { terms: [{ coefficient: 1, variables: ['x_0'] }] }, relation: 'eq', rhs: 0 }] },
    data: {},
  };
  const alternative = { ...review, model: { ...review.model, constraints: [] } };
  const originalDir = path.join(f.root, 'original'), alternateDir = path.join(f.root, 'alternate');
  fs.mkdirSync(originalDir);
  fs.mkdirSync(alternateDir);
  const reviewFile = await writeMathModelReviewFile({ directory: originalDir, qubo, ...review });
  const otherFile = await writeMathModelReviewFile({ directory: alternateDir, qubo, ...alternative });
  const prepared = await f.service.guideSolve({ action: 'prepare', qubo, review_file: reviewFile, problem_summary: '原约束' });
  const confirmation = next(prepared, 'confirm');
  await f.service.guideSolve(next(await f.service.guideSolve(confirmation), 'status'));
  const run = f.store.list().records[0];
  const before = fs.readFileSync(f.store.path(run.solve_id));

  const alias = await f.service.guideSolve({ action: 'model', qubo, review_file: otherFile, problem_summary: '复用原任务的请求' });
  const aliasId = next(alias, 'prepare').request_id;
  const guidedDir = path.join(f.store.directory, '.guided');
  const planPath = id => path.join(guidedDir, id + '.json');
  const aliasPlan = JSON.parse(fs.readFileSync(planPath(aliasId)));
  aliasPlan.solve_id = run.solve_id;
  fs.writeFileSync(planPath(aliasId), JSON.stringify(aliasPlan));

  const forbidden = () => { throw Error('HISTORICAL_REVIEW_MUST_STAY_LOCAL'); };
  const restart = () => new SolverService({ store: f.store, targetOptions: {
    environment: f.service.targetEngine.environment, localTransportFactory: forbidden, catalogClientFactory: forbidden,
  } });
  const exercise = async service => {
    const handler = createHandler(service);
    const call = async args => (await handler({ method: 'tools/call', params: { name: 'isingq_solve', arguments: args } })).structuredContent.data;
    const get = f.store.get.bind(f.store);
    let reads = 0;
    f.store.get = id => { reads++; return get(id); };
    try {
      const swapped = await call({ action: 'review', solve_id: run.solve_id, review: alternative });
      assert.equal(swapped.status, 'blocked', JSON.stringify(swapped.review));
      assert.equal(swapped.blockers[0].code, 'review_source_changed');
      reads = 0;
      const history = await call({ action: 'history', limit: 1 });
      const historyReview = next(history.records[0], 'review');
      assert.deepEqual(historyReview, { action: 'review', solve_id: run.solve_id, review_file: reviewFile });
      assert.equal(reads, 1, 'history projects the page snapshot without a second per-row read');
      const getById = await call({ action: 'status', solve_id: run.solve_id });
      assert.deepEqual(next(getById, 'review'), historyReview);
      const getByAlias = await call({ action: 'status', request_id: aliasId });
      assert.deepEqual(next(getByAlias, 'review').review_file, reviewFile);
      for (const id of [{ solve_id: run.solve_id }, { request_id: confirmation.request_id }, { request_id: aliasId }]) {
        for (const replacement of [{ review: alternative }, { review_file: otherFile }]) {
          const blocked = await call({ action: 'review', ...id, ...replacement });
          assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
          assert.equal(blocked.blockers[0].code, 'review_source_changed');
        }
        const reviewed = await call({ action: 'review', ...id });
        assert.equal(reviewed.status, 'result_reviewed', JSON.stringify(reviewed));
        assert.equal(reviewed.review.status, 'infeasible');
      }
      const owner = path.dirname(reviewFile.manifest_path);
      const movedDir = path.join(f.root, 'relocated');
      fs.renameSync(owner, movedDir);
      const movedFile = { ...reviewFile, manifest_path: path.join(movedDir, path.basename(reviewFile.manifest_path)) };
      reads = 0;
      try {
        const relocated = await call({ ...historyReview, review_file: movedFile });
        assert.equal(relocated.status, 'result_reviewed', JSON.stringify(relocated));
        assert.equal(relocated.review.status, 'infeasible');
        assert.equal(reads, 1, 'binding and evaluation consume the same original snapshot');
      } finally { fs.renameSync(movedDir, owner); }
    } finally { f.store.get = get; }
  };

  await t.test('new record keeps its source even across a fresh service instance', async () => {
    await exercise(restart());
    assert.deepEqual(run.guided_review, { request_id: confirmation.request_id, file: reviewFile });
    assert.deepEqual(fs.readFileSync(f.store.path(run.solve_id)), before);
    f.store.save({ ...run, guided_review: { ...run.guided_review, file: null } });
    const damaged = await restart().guideSolve({ action: 'review', solve_id: run.solve_id, review: alternative });
    assert.equal(damaged.status, 'blocked');
    assert.equal(damaged.blockers[0].code, 'review_source_unavailable');
  });
  await t.test('old records recover the original source by submission identity before the original request is attached', async () => {
    delete run.guided_review;
    f.store.save(run);
    const oldPlan = JSON.parse(fs.readFileSync(planPath(confirmation.request_id)));
    delete oldPlan.solve_id;
    oldPlan.state = 'submitting';
    fs.writeFileSync(planPath(confirmation.request_id), JSON.stringify(oldPlan));
    const legacyBefore = fs.readFileSync(f.store.path(run.solve_id));
    const service = restart();
    await exercise(service);
    assert.deepEqual(fs.readFileSync(f.store.path(run.solve_id)), legacyBefore);
    const engine = service.guidedSolveEngine;
    const load = engine.load;
    engine.load = function () { assert.fail('repeated history pages must not reload the full guided model'); };
    try {
      assert.deepEqual(next((await service.guideSolve({ action: 'history', limit: 1 })).records[0], 'review').review_file, reviewFile);
      assert.equal((await service.guideSolve({ action: 'history', limit: 1, offset: 1 })).records.length, 0);
    } finally { engine.load = load; }
    const unbound = { ...run, solve_id: 'solve_' + 'b'.repeat(32), idempotency_digest: '0'.repeat(64) };
    f.store.save(unbound);
    const inline = await service.guideSolve({ action: 'review', solve_id: unbound.solve_id, review: alternative });
    assert.equal(inline.status, 'result_reviewed');
    assert.equal(inline.review.status, 'feasible');
    assert.equal(f.state.submits.length, 1);
  });
});

test('ordinary MCP preserves the original provider receipt when guided attachment and reading also fail', async t => {
  for (const savedReceipt of [true, false]) await t.test(savedReceipt ? 'only the receipt can be saved' : 'all persistence fails', async t => {
    const f = fixture(t), problem_summary = '受理成功与本机持久化故障';
    const call = handler => async args => (await handler({ method: 'tools/call', params: { name: 'isingq_solve', arguments: args } })).structuredContent.data;
    const prepared = await call(f.handler)({ action: 'prepare', qubo, problem_summary });
    const confirmed = next(prepared, 'confirm'), engine = f.service.guidedSolveEngine;
    const save = f.store.save.bind(f.store), get = f.store.get.bind(f.store), savePlan = engine.save.bind(engine);
    let reserved, failedReads = 0, failedAttachments = 0;
    const ioFailure = () => Object.assign(Error('isolated storage failure'), { code: 'EIO' });
    t.mock.method(f.store, 'save', run => {
      if (run.provider_task_id) throw ioFailure();
      if (run.status === 'submitting') reserved = run.solve_id;
      return save(run);
    });
    if (!savedReceipt) t.mock.method(f.store, 'saveSubmissionReceipt', () => { throw ioFailure(); });
    t.mock.method(f.store, 'get', id => {
      if (reserved) { failedReads++; throw ioFailure(); }
      return get(id);
    });
    t.mock.method(engine, 'save', plan => {
      if (plan.solve_id) { failedAttachments++; throw ioFailure(); }
      return savePlan(plan);
    });

    const acknowledged = await call(f.handler)(confirmed);
    assert.equal(acknowledged.status, 'submitted', JSON.stringify(acknowledged));
    assert.equal(acknowledged.task.task_number, 'offline-fixture');
    assert.deepEqual(acknowledged.task.target, { name: '离线设备', location: '本地' });
    assert.deepEqual(next(acknowledged, 'status'), { action: 'status', solve_id: reserved });
    assert.match(acknowledged.notice, savedReceipt ? /已受理.*完整记录写入失败.*已单独保存任务回执/ : /已受理.*回执未能落盘.*原服务核查.*禁止重提/);
    assert.equal(failedAttachments, 1);
    assert.equal(failedReads, 0);
    assert.equal(f.state.submits.length, 1);
    const savedRecord = JSON.parse(fs.readFileSync(f.store.path(reserved), 'utf8'));
    assert.equal(savedRecord.status, 'submitting');
    assert.equal(savedRecord.provider_task_id, null);

    const environment = f.service.targetEngine.environment;
    const forbidden = () => { assert.fail('receipt recovery must not contact a solver'); };
    const corruptName = 'solve_' + '0'.repeat(32) + '.json';
    const corrupt = path.join(f.store.directory, corruptName);
    fs.writeFileSync(corrupt, '{}');
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (directory, ...options) => {
      const names = readdir(directory, ...options);
      return directory === f.store.directory ? [corruptName, ...names.filter(name => name !== corruptName)] : names;
    });
    const restarted = new SolverService({ store: new SolveStore(environment),
      targetOptions: { environment, localTransportFactory: forbidden, catalogClientFactory: forbidden } });
    const replay = await call(createHandler(restarted))(confirmed);
    assert.equal(replay.status, savedReceipt ? 'submitted' : 'submission_unknown', JSON.stringify(replay));
    assert.equal(replay.task.task_number, savedReceipt ? 'offline-fixture' : null);
    assert.deepEqual(next(replay, 'status'), { action: 'status', solve_id: reserved });
    assert.equal(fs.readFileSync(corrupt, 'utf8'), '{}');
    assert.equal(f.state.submits.length, 1);
  });
});
