'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {SolverService}=require('../packages/core');
const {IsingQError}=require('../packages/core/src/isingq');
const {createHandler}=require('../src/server');
for(const mode of ['simulation','live','unknown']) for(const message of [null,'参数不符合要求']) test(`${mode}: diagnostic message ${message===null?'absent':'present'}`,async()=>{
 const runs=new Map();let calls=0;
 const store={save:r=>runs.set(r.solve_id,structuredClone(r)),get:id=>runs.get(id),findByIdempotency:()=>[...runs.values()][0]};
 const service=new SolverService({store,transport:{execution_mode:mode,async submit(){calls++;throw new IsingQError('rejected',{phase:'create_task',status:400,submissionOutcome:'rejected',providerMessage:message});}}});
 const handle=createHandler(service);const request={method:'tools/call',params:{name:'isingq_solve_start',arguments:{qubo:{num_bits:1},model_summary:'diagnostic provenance',idempotency_key:'fixed',solver_options:{use_credit:false}}}};
 const first=await handle(request),again=await handle(request);assert.deepEqual(again,first);assert.equal(calls,1);
 const r=first.structuredContent.data;assert.equal(r.error.phase,'create_task');assert.equal(r.error.http_status,400);assert.equal(r.recovery.same_key_retry_allowed,false);
 assert.deepEqual(r.recovery.diagnostic_evidence,{provider_message_present:message!==null,provider_message_source:message===null?'absent':mode==='live'?'isingq_api':mode,available_error_fields:message===null?['phase','http_status']:['phase','http_status','provider_message']});
 if(message===null){assert.equal(r.error.provider_message,undefined);assert.match(r.recovery.instructions,/未提供 provider_message/);assert.doesNotMatch(first.structuredContent.error.message,/平台提示：/);}
 else {assert.equal(r.error.provider_message,message);assert.match(first.structuredContent.error.message,mode==='simulation'?/模拟诊断：/:mode==='live'?/平台提示：/:/来源未核实的诊断：/);}
 assert.equal(r.observation.scope,'status_query');assert.match(r.observation.interpretation,/不证明创建历史/);
 if(mode==='simulation'){assert.equal(r.billing.status,'not_applicable');assert.match(r.recovery.billing_instruction,/本次模拟操作不涉及真实计费/);assert.doesNotMatch(r.recovery.billing_instruction,/实际费用未知/);}else{assert.equal(r.billing.status,'unverified');assert.match(r.recovery.billing_instruction,/实际费用未知/);}
 assert.deepEqual((await service.poll(r.solve_id)).recovery,r.recovery);assert.deepEqual(service.get(r.solve_id).recovery,r.recovery);
});
