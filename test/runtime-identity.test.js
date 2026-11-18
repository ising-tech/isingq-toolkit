'use strict';
process.env.ISINGQ_UPDATE_CHECK = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHandler} = require('../src/server');

test('readonly modeling reply exposes actual runtime identity and capability contracts without constructing a solver', async () => {
  const handler = createHandler(new Proxy({}, {get(){throw Error('SOLVER_FORBIDDEN');}}));
  const reply = await handler({method:'tools/call',params:{name:'isingq_modeling_guide_get',arguments:{problem_summary:'only model'}}});
  const identity = reply.structuredContent.runtime_identity;
  assert.equal(identity.contract_version,'isingq-runtime-identity-v1');
  assert.equal(identity.package_name,'@ising-tech/isingq-mcp');
  assert.equal(identity.package_version,require('../package.json').version);
  assert.match(identity.artifact_sha256,/^[a-f0-9]{64}$/);
  assert.equal(identity.capabilities.guided_solve,'isingq-guided-solve-v1');
  assert.equal(identity.capabilities.solver_target,'isingq-solver-target-v1');
  assert.equal(identity.capabilities.model_artifacts,'isingq-guided-model-artifacts-v1');
  assert.deepEqual(JSON.parse(reply.content[0].text),reply.structuredContent);
  assert.doesNotMatch(JSON.stringify(identity),/package_path|core_path|api_key|credentials|HOME/);
});
