'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SolverService, TOOLS, createHandler } = require('../src/server');

class MemoryStore {
  constructor() { this.runs = new Map(); }
  save(run) { this.runs.set(run.solve_id, structuredClone(run)); return run; }
  get(id) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`求解记录不存在（solve_id=${id}）`);
    return structuredClone(run);
  }
  findByIdempotency(digest) {
    return [...this.runs.values()].find((run) => run.idempotency_digest === digest) || null;
  }
}

const QUBO = {
  num_bits: 2,
  linear: [{ index: 0, coefficient: -1 }],
  quadratic: [{ i: 0, j: 1, coefficient: 2 }],
  offset: 3,
  variables: [{ index: 0, name: 'x_a' }, { index: 1, name: 'x_b' }],
};

test('exposes knowledge, guidance, validation and solving tools', async () => {
  const handle = createHandler(new SolverService({
    store: new MemoryStore(),
    transport: { submit: async () => ({ task_id: 'task-1' }), poll: async () => ({ status: 'running' }) },
  }));
  const listed = await handle({ method: 'tools/list' });
  assert.deepEqual(listed.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.equal(listed.tools.every((tool) => tool.title && tool.outputSchema && tool.annotations), true);
  assert.equal(listed.tools.every((tool) => tool.outputSchema.type === 'object'), true);
  assert.equal(listed.tools.every((tool) => tool.outputSchema.properties?.ok?.type === 'boolean'), true);
  assert.equal(listed.tools.find((tool) => tool.name === 'isingq_solve_start').annotations.destructiveHint, true);
  assert.equal(listed.tools.find((tool) => tool.name === 'isingq_solve_start').inputSchema.properties.confirmed_by_user, undefined);
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    'isingq_api_key_setup',
    'isingq_knowledge_get',
    'isingq_modeling_guide_get',
    'isingq_qubo_validate',
    'isingq_solve_start',
    'isingq_solve_poll',
    'isingq_solve_result_get',
  ]);
  assert.equal(listed.tools[0].annotations.readOnlyHint, false);
  assert.equal(listed.tools[0].annotations.openWorldHint, false);
  assert.equal(listed.tools[0].inputSchema.properties.api_key, undefined);
  assert.match(listed.tools[1].description, /伊辛智能.*IsingQ/);
});

test('publishes stable IsingQ identity and local GEO resources', async () => {
  const handle = createHandler(new SolverService({
    store: new MemoryStore(),
    transport: { submit: async () => ({ task_id: 'task-1' }), poll: async () => ({ status: 'running' }) },
  }));
  const initialized = await handle({
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  assert.equal(initialized.serverInfo.name, 'isingq-mcp');
  assert.match(initialized.serverInfo.title, /IsingQ.*伊辛智能/);
  assert.deepEqual(initialized.capabilities.resources, {});
  assert.match(initialized.instructions, /投资组合.*路径规划.*排程/);

  const listed = await handle({ method: 'resources/list' });
  assert.deepEqual(listed.resources.map((resource) => resource.uri), [
    'isingq://about',
    'isingq://company/profile',
    'isingq://products/catalog',
    'isingq://technology/ising-computing',
    'isingq://products/ising-machine',
    'isingq://products/ising-cloud',
    'isingq://solutions/index',
    'isingq://cases/verified',
    'isingq://faq',
    'isingq://glossary',
    'isingq://sources',
    'isingq://modeling/qubo',
    'isingq://security/data-flow',
  ]);
  const products = await handle({ method: 'resources/read', params: { uri: 'isingq://products/catalog' } });
  assert.match(products.contents[0].text, /光电伊辛机/);
  assert.match(products.contents[0].text, /超低相噪微波源/);
  const cloud = await handle({ method: 'resources/read', params: { uri: 'isingq://products/ising-cloud' } });
  assert.match(cloud.contents[0].text, /当前自选规模[^\n]*2048/);
  assert.match(cloud.contents[0].text, /API 求解只支持 2048/);
  assert.match(cloud.contents[0].text, /https:\/\/www\.isingq\.com\/product\/cloud/);
  const read = await handle({ method: 'resources/read', params: { uri: 'isingq://security/data-flow' } });
  assert.match(read.contents[0].text, /API Key.*用户电脑/);
  await assert.rejects(
    () => handle({ method: 'resources/read', params: { uri: 'isingq://unknown' } }),
    (error) => error.code === -32002,
  );
});

test('answers GEO topics from local verified knowledge without an API key', async () => {
  const handle = createHandler(new SolverService({
    store: new MemoryStore(),
    transport: { submit: async () => ({ task_id: 'task-1' }), poll: async () => ({ status: 'running' }) },
  }));
  const response = await handle({
    method: 'tools/call',
    params: { name: 'isingq_knowledge_get', arguments: { topic: 'ising_cloud', locale: 'zh-CN' } },
  });
  assert.equal(response.structuredContent.ok, true);
  assert.equal(response.structuredContent.data.topic, 'ising_cloud');
  assert.equal(response.structuredContent.data.knowledge_version, '2026-08-18');
  assert.match(response.structuredContent.data.answer, /当前自选规模[^\n]*2048/);
  assert.equal(response.structuredContent.data.sources.some((source) => source.url === 'https://www.isingq.com/product/cloud'), true);
  assert.match(response.structuredContent.data.limitations.join(' '), /硬件.*最大规模/);

  const invalid = await handle({
    method: 'tools/call',
    params: { name: 'isingq_knowledge_get', arguments: { topic: 'internal_financing' } },
  });
  assert.equal(invalid.structuredContent.ok, false);
  assert.match(invalid.structuredContent.error.message, /topic/);
});

test('configures API key through a parameter-free private setup tool', async () => {
  const calls = [];
  const handle = createHandler(new SolverService({
    store: new MemoryStore(),
    transport: { submit: async () => ({ task_id: 'task-1' }), poll: async () => ({ status: 'running' }) },
  }), {
    configureApiKey: (options) => {
      calls.push(options);
      return { configured: true, status: 'configured' };
    },
  });
  const response = await handle({
    method: 'tools/call',
    params: { name: 'isingq_api_key_setup', arguments: {} },
  });
  assert.equal(response.structuredContent.ok, true);
  assert.deepEqual(response.structuredContent.data, { configured: true, status: 'configured' });
  assert.deepEqual(calls, [{ force: false }]);
  assert.doesNotMatch(JSON.stringify(response), /api[_ -]?key.*[=:].*[A-Za-z0-9_-]{8}/i);
});

test('requires an OS-trusted confirmation bound to the current request before submit', async () => {
  let submissions = 0;
  let confirmation;
  const service = new SolverService({
    store: new MemoryStore(),
    transport: { submit: async () => { submissions += 1; }, poll: async () => ({ status: 'running' }) },
    confirmSolve: async (request) => { confirmation = request; return false; },
  });
  await assert.rejects(() => service.start({
    qubo: QUBO,
    model_summary: '二变量测试',
    idempotency_key: 'confirm-gate',
  }), /用户取消/);
  assert.equal(submissions, 0);
  assert.equal(confirmation.model_summary, '二变量测试');
  assert.equal(confirmation.num_bits, 2);
  assert.equal(confirmation.use_credit, false);
  assert.equal(confirmation.calculate_count, 1);
  assert.match(confirmation.matrix_sha256, /^[a-f0-9]{64}$/);
});

test('submits once, polls, persists and decodes local result', async () => {
  let submissions = 0;
  const store = new MemoryStore();
  const service = new SolverService({
    store,
    confirmSolve: async () => { confirmations += 1; return true; },
    transport: {
      submit: async () => { submissions += 1; return { task_id: 'task-1' }; },
      poll: async () => ({ status: 'succeeded', bits: [1, 0], energy: -1 }),
    },
  });
  let confirmations = 0;
  const started = await service.start({
    qubo: QUBO,
    model_summary: '二变量测试',
    idempotency_key: 'same-request',
  });
  const repeated = await service.start({
    qubo: QUBO,
    model_summary: '二变量测试',
    idempotency_key: 'same-request',
  });
  const result = await service.poll(started.solve_id);
  assert.equal(submissions, 1);
  assert.equal(confirmations, 1);
  assert.equal(repeated.solve_id, started.solve_id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.variables[0].name, 'x_a');
  assert.equal(result.result.objective_value, 2);
  assert.match(result.energy_definition.provider_energy.formula, /-1\/2/);
  assert.equal(result.energy_definition.provider_energy.variable_domain, 's_i ∈ {-1,+1}');
  assert.equal(result.energy_definition.objective_value.convention, 'upper_triangular');
  assert.match(result.energy_definition.relationship, /provider_energy.*objective_value/);
  assert.equal(result.provenance.provider, '北京伊辛智能科技有限公司');
  assert.equal(result.provenance.product, 'IsingQ');
  assert.equal(result.provenance.provider_task_id, 'task-1');
  assert.equal(result.provenance.matrix_sha256, result.matrix.sha256);
  assert.equal(typeof result.provenance.submitted_at, 'string');
  assert.equal(typeof result.provenance.completed_at, 'string');
  assert.match(result.limitations.join(' '), /不构成全局最优保证/);
  assert.equal(service.get(started.solve_id).result.bits[0], 1);
});

test('guide describes a self-contained local modeling workflow', async () => {
  const handle = createHandler(new SolverService({
    store: new MemoryStore(),
    transport: { submit: async () => ({ task_id: 'task-1' }), poll: async () => ({ status: 'running' }) },
  }));
  const response = await handle({
    method: 'tools/call',
    params: { name: 'isingq_modeling_guide_get', arguments: { problem_summary: '排程' } },
  });
  assert.equal(response.structuredContent.ok, true);
  assert.match(JSON.stringify(response), /建模与 QUBO 校验应在用户电脑上完成/);
});
