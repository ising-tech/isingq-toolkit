'use strict';

// BUG-20261029-001: one business model through first use, failure, retry,
// a fresh conversation and successful mock solving. Never a live cloud test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SolverService, objectiveEnergy } = require('../packages/core');
const { IsingQTransport } = require('../src/isingq');
const { createHandler } = require('../src/server');

const QUBO = { num_bits: 2, linear: [{ index: 0, coefficient: -2 }, { index: 1, coefficient: -4 }],
  quadratic: [{ i: 0, j: 1, coefficient: 10 }], offset: 5,
  variables: [{ index: 0, name: 'A' }, { index: 1, name: 'B' }] };

test('first-use payment and HTTP400 regression on exactly-one supplier solving', async t => {
  // Business oracle is deliberately independent of the QUBO evaluator.
  const states = [[0,0],[0,1],[1,0],[1,1]].map(([a,b]) => ({ bits:[a,b], feasible:a+b===1, cost:3*a+b }));
  const optimum = states.filter(x => x.feasible).sort((a,b) => a.cost-b.cost)[0];
  assert.deepEqual(optimum, { bits:[0,1], feasible:true, cost:1 });
  for (const row of states) assert.equal(objectiveEnergy(QUBO,row.bits), row.cost+5*(row.bits[0]+row.bits[1]-1)**2);

  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const runs = new Map(), events = [], created = [];
  const store = {
    findByIdempotency(digest) { events.push('lookup'); return [...runs.values()].find(r => r.idempotency_digest===digest); },
    save(run) { events.push('save'); runs.set(run.solve_id,structuredClone(run)); },
    get(id) { return structuredClone(runs.get(id)); },
  };
  global.fetch = async (url, options) => {
    const path = String(url);
    if (path==='https://api.isingq.example/files/getPostSignatureForOssUpload') {
      events.push('mock_signature');
      return Response.json({data:{host:'https://oss.example/upload',policy:'fixture',signature:'fixture',
        x_oss_credential:'fixture',x_oss_date:'fixture',security_token:'fixture'}});
    }
    if (path==='https://oss.example/upload') { events.push('mock_upload'); return new Response(''); }
    if (path==='https://api.isingq.example/tasks/create-general') {
      const body=JSON.parse(options.body);created.push(body.useCredit);events.push('mock_create');
      return body.useCredit ? Response.json({data:{taskId:'fixture-task-1'}})
        : Response.json({message:'您的账户余额不足，请确认付款来源。'},{status:400});
    }
    if (path==='https://api.isingq.example/tasks/fixture-task-1') {
      events.push('mock_poll');return Response.json({data:{status:2,result:{bits:[0,1],energy:1}}});
    }
    throw new Error('Unexpected mock endpoint: no network fallback');
  };
  const transport = new IsingQTransport({baseUrl:'https://api.isingq.example',apiKey:()=>{events.push('fixture_credentials');return 'fixture-only';}});
  const service=new SolverService({store,transport});
  const args={qubo:QUBO,model_summary:'Exactly one supplier: A costs 3, B costs 1.',idempotency_key:'fixture-balance'};
  const call=(handler,name,arguments_)=>handler({method:'tools/call',params:{name,arguments:arguments_}});
  let handle=createHandler(service);
  const missing=await call(handle,'isingq_solve_start',args);
  assert.equal(missing.isError,true);assert.equal(missing.structuredContent.ok,false);
  assert.match(missing.structuredContent.error.message,/use_credit.*付款/);assert.deepEqual(events,[]);

  const explicitBalance={...args,solver_options:{use_credit:false}};
  const rejected=await call(handle,'isingq_solve_start',explicitBalance);
  assert.equal(rejected.isError,true);assert.equal(rejected.structuredContent.ok,false);
  assert.equal(rejected.structuredContent.data.submission_outcome,'rejected');
  assert.equal(rejected.structuredContent.data.error.http_status,400);
  assert.match(rejected.structuredContent.error.message,/余额不足/);
  const cached=await call(handle,'isingq_solve_start',explicitBalance);
  assert.deepEqual(cached,rejected);assert.deepEqual(created,[false]);
  const changed=await call(handle,'isingq_solve_start',{...args,solver_options:{use_credit:true}});
  assert.equal(changed.isError,true);assert.match(changed.structuredContent.error.message,/模型或求解参数/);
  assert.deepEqual(created,[false]);

  handle=createHandler(service); // Simulated fresh conversation, no inherited payment choice.
  const countBefore=events.length;
  const fresh=await call(handle,'isingq_solve_start',{...args,idempotency_key:'fixture-new-conversation'});
  assert.equal(fresh.isError,true);assert.equal(events.length,countBefore);
  const credit={...args,idempotency_key:'fixture-explicit-credit',solver_options:{use_credit:true}};
  const accepted=await call(handle,'isingq_solve_start',credit);
  assert.equal(accepted.isError,false);assert.equal(accepted.structuredContent.data.status,'submitted');
  const same=await call(handle,'isingq_solve_start',credit);
  assert.equal(same.structuredContent.data.solve_id,accepted.structuredContent.data.solve_id);
  assert.deepEqual(created,[false,true]);
  const done=await call(handle,'isingq_solve_poll',{solve_id:accepted.structuredContent.data.solve_id});
  assert.equal(done.structuredContent.data.status,'succeeded');
  assert.deepEqual(done.structuredContent.data.result.bits,optimum.bits);
  assert.equal(done.structuredContent.data.result.objective_value,optimum.cost);
  t.diagnostic(JSON.stringify({scope:'mock HTTP only',business_optimum:optimum,first_use_blocked:true,
    new_conversation_blocked:true,http400_reason_preserved:true,cached_failure_is_error:true,
    duplicate_create_prevented:true,mock_payment_sequence:created,real_network_requests:0}));
});
