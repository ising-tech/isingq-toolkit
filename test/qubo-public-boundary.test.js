'use strict';

// Intercept the HTTP implementation used by core; never fall through to cloud.
const http = require('undici');
const test=require('node:test');const assert=require('node:assert/strict');
const core=require('../packages/core');const {IsingQTransport}=require('../packages/core/src/isingq');
const omitted={num_bits:2,linear:[{index:0,coefficient:-1}]};
const explicit={...omitted,quadratic:[],offset:0,variables:[]};
test('guide distinguishes required input, defaults, normalized output and remote payload',()=>{
 const c=core.modelingGuide().qubo_contract;
 assert.deepEqual(c.input_schema.required,['num_bits']);
 for(const n of ['linear','quadratic','variables'])assert.deepEqual(c.input_schema.properties[n].default,[]);
 assert.equal(c.input_schema.properties.offset.default,0);
 assert.equal(c.schema_role,'illustrative_example_not_validation_schema');
 assert.deepEqual(c.normalized_output_fields,['num_bits','linear','quadratic','offset','variables']);
 assert.equal(c.transport_boundary.input_representation,'normalized_qubo');
 assert.equal(c.transport_boundary.upload_representation,'matrix_csv');
 assert.equal(c.transport_boundary.create_task_model_field,'inputJFile');
 assert.equal(c.transport_boundary.original_qubo_json_sent,false);
 for(const n of ['isingq_qubo_validate','isingq_solve_start'])assert.deepEqual(core.TOOL_DEFINITIONS.find(t=>t.name===n).inputSchema.properties.qubo,c.input_schema);
});
test('omitted and explicit defaults normalize identically and reuse one logical submission',async()=>{
 assert.deepEqual(core.validateQubo(omitted),core.validateQubo(explicit));
 assert.deepEqual(core.matrixDocument(omitted),core.matrixDocument(explicit));
 let stored,calls=0;const service=new core.SolverService({store:{save:r=>stored=structuredClone(r),findByIdempotency:()=>stored},transport:{async submit(){calls++;return {task_id:'t1'};}}});
 const args={model_summary:'same semantic request',idempotency_key:'stable',solver_options:{use_credit:false}};
 const a=await service.start({...args,qubo:omitted}),b=await service.start({...args,qubo:explicit});assert.equal(a.solve_id,b.solve_id);assert.equal(calls,1);
});
test('transport uploads identical CSV and never sends original QUBO JSON defaults',async t=>{
 const old=http.fetch;t.after(()=>http.fetch=old);const uploads=[],payloads=[];
 http.fetch=async(url,init)=>{
  if(String(url).includes('getPostSignature'))return Response.json({data:{host:'https://oss.example/upload',policy:'p',signature:'s',x_oss_credential:'c',x_oss_date:'date',security_token:'t'}});
  if(String(url)==='https://oss.example/upload'){uploads.push(await init.body.get('file').text());return new Response('');}
  if(String(url).includes('create-general')){payloads.push(JSON.parse(init.body));return Response.json({task_id:'t1'});}
  throw Error('unexpected mocked endpoint');
 };
 const transport=new IsingQTransport({apiKey:()=> 'test-key'});
 for(const q of [omitted,explicit])await transport.submit(core.matrixDocument(q),{use_credit:false});
 assert.equal(uploads[0],uploads[1]);
 for(const p of payloads){assert.match(p.inputJFile,/https:\/\/oss.example\/upload\/.+\/isingq-mcp-qubo.csv/);for(const k of ['qubo','offset','quadratic','linear','variables'])assert.equal(Object.hasOwn(p,k),false);}
 // Upload object names are intentionally unique; compare semantic payload fields, not generated URLs.
 const canonical=p=>({...p,inputJFile:'same CSV content'});assert.deepEqual(canonical(payloads[0]),canonical(payloads[1]));
});
test('unknown rejection reason requests diagnosis, not an equivalent-input repair submission',async()=>{
 const {IsingQError}=require('../packages/core/src/isingq');let saved,calls=0;
 const service=new core.SolverService({store:{save:r=>saved=structuredClone(r),findByIdempotency:()=>saved},transport:{execution_mode:'simulation',async submit(){calls++;throw new IsingQError('fixture',{phase:'create_task',status:400,submissionOutcome:'rejected'});}}});
 const args={qubo:omitted,model_summary:'unknown cause',idempotency_key:'same',solver_options:{use_credit:false}};
 await assert.rejects(()=>service.start(args),e=>{assert.equal(e.run.recovery.action,'diagnose_rejection');assert.equal(e.run.recovery.root_cause_status,'unverified');assert.equal(e.run.recovery.equivalent_normalization_is_repair,false);return true;});
 await assert.rejects(()=>service.start({...args,qubo:explicit}));assert.equal(calls,1);
});
