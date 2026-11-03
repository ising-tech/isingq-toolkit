'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SolverService } = require('../packages/core');
const { IsingQError } = require('../packages/core/src/isingq');
const { createHandler } = require('../src/server');
const args = { qubo: {num_bits: 1}, model_summary: 'recovery', idempotency_key: 'stable', solver_options: {use_credit: false} };
function fixture(outcome) {
  const rows = new Map(); let submits = 0, polls = 0;
  const store = { save(r) {rows.set(r.solve_id, structuredClone(r));}, get(id) {return structuredClone(rows.get(id));},
    findByIdempotency(key) {return [...rows.values()].find(r=>r.idempotency_digest===key && !r.archived_at) || [...rows.values()].find(r=>r.idempotency_digest===key);},
    archive(r) {this.save({...r, archived_at: 'archived'});} };
  const service = new SolverService({store, transport: {execution_mode: 'live', async submit() { submits++; if(submits===1 && outcome!=='created') throw new IsingQError('fixture', {phase: outcome==='not_created'?'upload':'create_task',status: outcome==='rejected'?400:503,submissionOutcome: outcome,retryable: outcome!=='rejected'}); return {task_id:'remote-1'};}, async poll() {polls++;return {status:'running'};}}});
  return {service,store,counts:()=>({submits,polls})};
}
for (const outcome of ['unknown','rejected','not_created']) test(`${outcome}: recovery agrees with actual retry and local reads`, async()=>{
  const f=fixture(outcome), handle=createHandler(f.service);
  const response=await handle({method:'tools/call',params:{name:'isingq_solve_start',arguments:args}});
  const run=response.structuredContent.data;
  assert.equal(run.recovery.contract_version,'isingq-recovery-v1');
  assert.equal(run.recovery.same_key_retry_allowed,outcome==='not_created');
  assert.equal(run.recovery.idempotency_scope,'local_store');
  assert.equal(run.recovery.remote_deduplication,'unverified');
  assert.equal(run.billing.status,'unverified');
  assert.equal(run.recovery.action,outcome==='not_created'?'repair_then_retry_same_request':outcome==='rejected'?'diagnose_rejection':'reconcile_externally');
  for(const read of [()=>f.service.get(run.solve_id),()=>f.service.poll(run.solve_id)]) {
    const result=await read();assert.equal(result.observation.source,'local_record');assert.equal(result.observation.remote_request_performed,false);
  }
  assert.equal(f.counts().polls,0);
  if(outcome==='not_created') assert.equal((await f.service.start(args)).status,'submitted');
  else { await assert.rejects(()=>f.service.start(args)); f.store.archive(f.store.get(run.solve_id));await assert.rejects(()=>f.service.start(args)); }
  assert.equal(f.counts().submits,outcome==='not_created'?2:1);
});
test('created poll records this-call remote observation; get is still a local read',async()=>{
 const f=fixture('created'),run=await f.service.start(args);
 assert.equal((await f.service.poll(run.solve_id)).observation.remote_request_performed,true);
 assert.equal(f.service.get(run.solve_id).observation.remote_request_performed,false);
 assert.equal(f.counts().polls,1);
});
test('in-flight reservation without provider ID never polls null remotely',async()=>{
 const f=fixture('created'),run=await f.service.start(args),saved=f.store.get(run.solve_id);
 Object.assign(saved,{status:'submitting',submission_outcome:'unknown',provider_task_id:null,submitted_at:null});f.store.save(saved);
 const observed=await f.service.poll(run.solve_id);
 assert.equal(f.counts().polls,0);assert.equal(observed.recovery.same_key_retry_allowed,false);
});
for (const outcome of ['unknown','rejected']) test(`${outcome}: archiving cannot authorize a second submit`,async()=>{
 const f=fixture(outcome);let failed;
 await assert.rejects(()=>f.service.start(args),e=>{failed=e.run;return true;});
 f.store.archive(f.store.get(failed.solve_id));
 await assert.rejects(()=>f.service.start(args));assert.equal(f.counts().submits,1);
});
