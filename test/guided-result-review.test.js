'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SolverService } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { createHandler } = require('../src/server');

const qubo = { num_bits:2, offset:4, linear:[{index:0,coefficient:-7},{index:1,coefficient:-6}], quadratic:[{i:0,j:1,coefficient:8}],
  variables:[{index:0,name:'A',meaning:'选择项目A'},{index:1,name:'B',meaning:'选择项目B'}] };
function business() {
  return { model:{schema_version:'math-model-v1',id:'project-choice',label:'项目收益',variables:[{id:'x_0',domain:'binary',label:'项目A'},{id:'x_1',domain:'binary',label:'项目B'}],
    objective:{sense:'max',expression:{terms:[{coefficient:3,variables:['x_0']},{coefficient:2,variables:['x_1']}]}},
    constraints:[{id:'one',label:'只选一个项目',relation:'eq',rhs:1,expression:{terms:[{coefficient:1,variables:['x_0']},{coefficient:1,variables:['x_1']}]}}]},
    data:{},baseline:{x_0:0,x_1:1} };
}
function fixture(t,{maxScale=128}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'guided-review-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const environment={XDG_CONFIG_HOME:path.join(directory,'config'),XDG_DATA_HOME:path.join(directory,'data')};
  const state={submits:0,probes:0,polls:0,bits:[1,0]};
  const service=new SolverService({store:new SolveStore(environment),targetOptions:{environment,
    catalogClientFactory:()=>({get:async()=>{throw Error('NO_CLOUD_REQUEST');}}),
    localTransportFactory:()=>({execution_mode:'simulation',prepareSubmission:()=>({}),
      probe:async()=>{state.probes++;return{config:{deviceName:'fixture',version:'1',maxScale,maxPrecision:'8bit'},runtime:{bootTimestamp:1},status:{status:'stable'}};},
      submit:async()=>{state.submits++;return{task_id:'review-fixture'};},poll:async()=>{state.polls++;return{status:'succeeded',bits:state.bits,energy:-1000};}})}});
  service.profileSave({name:'隔离设备',api_base_url:'http://fixture.test'});
  const handler=createHandler(service);
  const call=async args=>(await handler({method:'tools/call',params:{name:'isingq_solve',arguments:args}})).structuredContent.data;
  return {service,state,call,environment};
}
function next(view,action){const found=view.actions.find(item=>item.call.arguments.action===action);assert.ok(found,`missing ${action} continuation`);return structuredClone(found.call.arguments);}
async function complete(f,model=qubo,problem='A和B只能选一个，收益分别为3和2') {
  const prepared=await f.call({action:'prepare',qubo:model,problem_summary:problem});
  const submitted=await f.call(next(prepared,'confirm'));
  return f.call(next(submitted,'status'));
}

test('ordinary MCP continues a returned candidate into decoded, checked business results without another solve or raw-record writes',async t=>{
  const f=fixture(t),done=await complete(f);
  assert.equal(done.status,'candidate_ready');
  const reviewCall=next(done,'review');
  const solveId=reviewCall.solve_id,record=f.service.store.get(solveId);
  const before=JSON.stringify(record),counts={...f.state};
  const checked=await f.call({...reviewCall,review:business()});
  assert.equal(checked.status,'result_reviewed');
  assert.equal(checked.review.status,'feasible');
  assert.equal(checked.review.objective.value,3);
  assert.equal(checked.result.objective,-3,'QUBO objective is not the business objective');
  assert.equal(checked.review.constraints[0].passed,true);
  assert.equal(checked.review.baseline.improvement,1);
  assert.deepEqual(checked.review.decisions.map(x=>x.value),[1,0]);
  assert.match(checked.reply,/项目A/);assert.match(checked.reply,/业务目标值.*3/);assert.match(checked.reply,/只选一个项目/);
  assert.deepEqual(f.state,counts,'review must not poll, probe, upload, or create');
  assert.equal(JSON.stringify(f.service.store.get(solveId)),before,'review must preserve the original record');
  assert.equal((await createHandler()({method:'tools/list'})).tools.length,4);
});

test('encoded integer business decisions are decoded from the saved bits through explicit original mappings',async t=>{
  const f=fixture(t);
  const encoded={num_bits:2,offset:4,linear:[{index:0,coefficient:-3},{index:1,coefficient:-2}],quadratic:[{i:0,j:1,coefficient:4}],variables:[{index:0,name:'数量低位'},{index:1,name:'数量高位'}]};
  const done=await complete(f,encoded,'数量q取0到3的整数，最小化q，要求q至少为1；q=x_0+2x_1');
  const spec={model:{schema_version:'math-model-v1',id:'quantity',variables:[{id:'q',domain:'integer',lower:0,upper:3,label:'生产数量'}],objective:{sense:'min',expression:{terms:[{coefficient:1,variables:['q']}]}},constraints:[{id:'minimum',label:'至少生产1件',relation:'ge',rhs:1,expression:{terms:[{coefficient:1,variables:['q']}]}}]},data:{},
    bindings:{q:{terms:[{coefficient:1,variables:['x_0']},{coefficient:2,variables:['x_1']}]}},baseline:{q:2}};
  const checked=await f.call({...next(done,'review'),review:spec});
  assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.status,'feasible');
  assert.equal(checked.review.decisions[0].value,1);assert.equal(checked.review.objective.value,1);assert.equal(checked.review.baseline.improvement,1);
  assert.match(checked.reply,/生产数量/);
});

test('missing original business information keeps feasibility unknown while still decoding the candidate',async t=>{
  const f=fixture(t),done=await complete(f),counts={...f.state};
  const partial=await f.call(next(done,'review'));
  assert.equal(partial.status,'needs_review_model');assert.equal(partial.review.status,'needs_business_model');
  assert.equal(partial.review.qubo_objective,-3);assert.equal(partial.review.objective,undefined);
  assert.deepEqual(partial.review.decoded.map(x=>[x.name,x.value]),[['A',1],['B',0]]);
  assert.match(partial.reply,/原业务目标和约束尚待复核/);assert.doesNotMatch(partial.reply,/通过所声明业务模型/);
  assert.deepEqual(f.state,counts);
});

test('an infeasible provider candidate remains technically completed and is explained with the violated business constraint',async t=>{
  const f=fixture(t);f.state.bits=[1,1];const done=await complete(f);
  const checked=await f.call({...next(done,'review'),review:business()});
  assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.status,'infeasible');
  assert.equal(checked.review.objective.value,5);assert.equal(checked.review.constraints[0].actual,2);assert.equal(checked.review.constraints[0].passed,false);
  assert.equal(checked.review.baseline.status,'not_comparable');assert.equal(checked.review.baseline.improvement,undefined);
  assert.match(checked.reply,/不能直接作为满足要求的方案/);assert.match(checked.reply,/只选一个项目/);
  assert.equal(f.service.get(next(done,'review').solve_id).status,'succeeded');assert.equal(f.state.submits,1);
});

test('caller-supplied candidate values, out-of-range mappings and unsupported arithmetic cannot fabricate a verified result',async t=>{
  const f=fixture(t),done=await complete(f),call=next(done,'review');
  const invalid=[
    {...business(),candidates:[{id:'fake',assignment:{x_0:0,x_1:1}}]},
    {...business(),assignment:{x_0:0,x_1:1}},
    {...business(),bindings:{x_0:{terms:[{coefficient:1,variables:['x_99']}]},x_1:{terms:[]}}},
  ];
  const floating=business();floating.model.objective.expression.terms[0].coefficient=0.5;invalid.push(floating);
  const overflow=business();overflow.model.objective.expression.terms=[{coefficient:Number.MAX_SAFE_INTEGER,variables:['x_0']},{coefficient:1,variables:['x_0']}];invalid.push(overflow);
  const before=JSON.stringify(f.service.store.get(call.solve_id)),counts={...f.state};
  for(const review of invalid) {
    const blocked=await f.call({...call,review});
    assert.equal(blocked.status,'review_blocked');assert.equal(blocked.review.scope,'unverified');
    assert.ok(blocked.review.issue.code);assert.equal(blocked.review.objective,undefined);
  }
  assert.equal(JSON.stringify(f.service.store.get(call.solve_id)),before);assert.deepEqual(f.state,counts);
});

test('review before a result does not poll or submit, and saved results can be reviewed after a client restart',async t=>{
  const f=fixture(t),prepared=await f.call({action:'prepare',qubo,problem_summary:'先准备'});
  const early=await f.call({action:'review',request_id:next(prepared,'confirm').request_id,review:business()});
  assert.equal(early.status,'blocked');assert.equal(f.state.submits,0);assert.equal(f.state.polls,0);
  const submitted=await f.call(next(prepared,'confirm')),status=next(submitted,'status');
  const pending=await f.call({action:'review',solve_id:status.solve_id,review:business()});
  assert.equal(pending.status,'submitted');assert.equal(f.state.polls,0);
  const done=await f.call(status),args={...next(done,'review'),review:business()};
  const restarted=new SolverService({store:new SolveStore(f.environment),targetOptions:{environment:f.environment}});
  const reviewed=await restarted.guideSolve(args);
  assert.equal(reviewed.status,'result_reviewed');assert.equal(reviewed.review.objective.value,3);
  assert.deepEqual(await restarted.guideSolve(args),reviewed,'same original result and business input produce the same review');
});

test('normal MCP describes automatic local result follow-up and exposes the original-model review shape without adding tools',async()=>{
  const handler=createHandler(),menu=(await handler({method:'tools/list'})).tools;
  const initialize=await handler({method:'initialize',params:{}});
  assert.equal(menu.length,4);assert.match(initialize.instructions,/candidate_ready.*review/);
  const solve=menu.find(t=>t.name==='isingq_solve');
  assert.ok(solve.inputSchema.properties.review.properties.bindings);
  const modelSchema=solve.inputSchema.properties.review.properties.model;
  assert.deepEqual(modelSchema.required,['schema_version','id','variables','objective','constraints']);
  assert.equal(modelSchema.additionalProperties,false);
  assert.deepEqual(modelSchema.properties.objective.properties.sense.enum,['min','max']);
  assert.ok(modelSchema.properties.variables.items.oneOf.every(v=>v.additionalProperties===false));
  assert.equal(modelSchema.properties.objective.properties.expression.properties.terms.items.properties.variables.minItems,1);
  assert.equal(modelSchema.properties.constraints.items.properties.expression.properties.terms.items.properties.variables.minItems,1);
  assert.equal(solve.inputSchema.properties.review.properties.bindings.additionalProperties.properties.terms.items.properties.variables.minItems,1);
  assert.match(solve.description,/不再.*位串|不只.*位串/);
  const guide=(await handler({method:'tools/call',params:{name:'isingq_modeling_guide_get',arguments:{problem_summary:'结果解读'}}})).structuredContent.data;
  assert.equal(guide.result_review.example.model.schema_version,'math-model-v1');
  assert.equal(modelSchema.properties.variables.maxItems,undefined);
  assert.equal(modelSchema.properties.constraints.maxItems,undefined);
  assert.equal(modelSchema.properties.objective.properties.expression.properties.terms.maxItems,undefined);
  assert.equal(guide.result_review.capacity.policy,'aggregate_input_bytes');
  assert.equal(guide.result_review.capacity.max_input_bytes,1024*1024*1024);
});

test('business variable domain violations identify the actual value and allowed range',async t=>{
  const f=fixture(t),done=await complete(f);
  const spec=business();spec.model.variables[0]={id:'x_0',domain:'integer',lower:2,upper:3,label:'原变量范围'};
  const checked=await f.call({...next(done,'review'),review:spec});
  assert.equal(checked.review.status,'infeasible');
  assert.equal(checked.review.decisions[0].lower,2);assert.equal(checked.review.decisions[0].upper,3);
  assert.match(checked.reply,/2.*3.*不满足|不满足.*2.*3/);
});

test('a real normal stdio MCP process returns checked business results from the original saved record',async t=>{
  const f=fixture(t),done=await complete(f);
  const request={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'isingq_solve',arguments:{...next(done,'review'),review:business()}}};
  const result=spawnSync(process.execPath,[path.resolve(__dirname,'../bin/isingq-mcp.js'),'serve'],{
    input:[{jsonrpc:'2.0',id:1,method:'initialize',params:{}},request,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'isingq_modeling_guide_get',arguments:{problem_summary:'原结果核对'}}}].map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:10000,
    env:{PATH:process.env.PATH,HOME:os.homedir(),...f.environment,ISINGQ_UPDATE_CHECK:'off'},maxBuffer:2*1024*1024});
  assert.equal(result.status,0,result.stderr);
  const lines=result.stdout.trim().split('\n').map(x=>JSON.parse(x));
  const reply=lines.find(x=>x.id===2).result;
  assert.equal(reply.structuredContent.ok,true);assert.equal(reply.structuredContent.data.status,'result_reviewed');
  assert.equal(reply.structuredContent.data.review.objective.value,3);
  assert.equal(lines.find(x=>x.id===3).result.structuredContent.runtime_identity.capabilities.result_review,'isingq-guided-result-review-v1');
  assert.equal(f.state.submits,1);assert.equal(f.state.polls,1);
});

test('a long constraint list cannot hide its failing rows behind the default display limit',async t=>{
  const f=fixture(t),done=await complete(f),spec=business();
  spec.model.constraints=Array.from({length:40},(_,i)=>({id:'valid-'+i,label:'已满足约束'+i,relation:'ge',rhs:0,expression:{terms:[{coefficient:1,variables:['x_0']}]}}));
  spec.model.constraints.push({id:'last-invalid',label:'末位不满足约束必须展示',relation:'eq',rhs:0,expression:{terms:[{coefficient:1,variables:['x_0']}]}});
  const checked=await f.call({...next(done,'review'),review:spec});
  assert.equal(checked.review.status,'infeasible');assert.equal(checked.review.constraints.length,41);
  assert.match(checked.reply,/末位不满足约束必须展示/);
  assert.ok(checked.reply.indexOf('不能直接作为满足要求的方案')<checked.reply.indexOf('业务目标值'));
});

test('one business variable can decode more than 256 original bits without consuming the business-variable quota',async t=>{
  for(const count of [256,257]) await t.test(String(count)+' original bits',async t=>{
    const f=fixture(t,{maxScale:512});f.state.bits=Array(count).fill(1);
    const encoded={num_bits:count,linear:Array.from({length:count},(_,index)=>({index,coefficient:-1}))};
    const done=await complete(f,encoded,'用原始一元编码 q=sum(x_i) 表示一个整数，最大化q');
    const spec={model:{schema_version:'math-model-v1',id:'unary-quantity',variables:[{id:'q',domain:'integer',lower:0,upper:count}],objective:{sense:'max',expression:{terms:[{coefficient:1,variables:['q']}]}},constraints:[]},data:{},
      bindings:{q:{terms:Array.from({length:count},(_,i)=>({coefficient:1,variables:['x_'+i]}))}}};
    const args={...next(done,'review'),review:spec},before=JSON.stringify(f.service.store.get(args.solve_id)),calls={...f.state};
    const checked=await f.call(args);
    assert.equal(checked.status,'result_reviewed',JSON.stringify(checked.review?.issue));assert.equal(checked.review.status,'feasible');
    assert.equal(checked.review.decisions.length,1);assert.equal(checked.review.decisions[0].value,count);
    assert.equal(checked.review.objective.value,count);assert.deepEqual(f.state,calls);
    assert.equal(JSON.stringify(f.service.store.get(args.solve_id)),before);
  });
});

test('binding substitution retains intermediate overflow and invalid inactive-coefficient checks',async t=>{
  const f=fixture(t),done=await complete(f),base={model:{schema_version:'math-model-v1',id:'quantity',variables:[{id:'q',domain:'integer',lower:0,upper:10}],objective:{sense:'min',expression:{terms:[{coefficient:1,variables:['q']}]}},constraints:[]},data:{}};
  const expressions=[
    [{constant:Number.MAX_SAFE_INTEGER,terms:[{coefficient:1,variables:['x_0']},{coefficient:-Number.MAX_SAFE_INTEGER,variables:['x_0']}]},'unsupported_numeric'],
    [{terms:[{coefficient:Number.MAX_SAFE_INTEGER+1,variables:['x_1']}]},'unsupported_numeric'],
    [{terms:[{coefficient:0.5,variables:['x_1']}]},'input_error'],
    [{terms:[{coefficient:0,variables:['x_99']}]},'review_mapping_required'],
    [{terms:[{coefficient:7,variables:[]}]},'unsupported'],
  ];
  for(const [expression,code] of expressions){const checked=await f.call({...next(done,'review'),review:{...base,bindings:{q:expression}}});assert.equal(checked.status,'review_blocked');assert.equal(checked.review.scope,'unverified');assert.equal(checked.review.issue.code,code);}
  const constant=await f.call({...next(done,'review'),review:{...base,bindings:{q:{constant:7,terms:[]}}}});
  assert.equal(constant.status,'result_reviewed');assert.equal(constant.review.decisions[0].value,7);
  assert.equal(f.state.submits,1);
});

test('former business count boundaries no longer block complete wide-bit model review',async t=>{
  const f=fixture(t,{maxScale:512});f.state.bits=Array(257).fill(1);
  const done=await complete(f,{num_bits:257},'各层容量边界隔离检查'),args=next(done,'review'),calls={...f.state};
  const model=count=>({schema_version:'math-model-v1',id:'limits',variables:Array.from({length:count},(_,i)=>({id:'x_'+i,domain:'binary'})),objective:{sense:'min',expression:{terms:[{coefficient:0,variables:['x_0']}]}},constraints:[]});
  let checked=await f.call({...args,review:{model:model(256),data:{}}});
  assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.decisions.length,256);
  checked=await f.call({...args,review:{model:model(257),data:{}}});
  assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.decisions.length,257);
  const constraints=model(1);constraints.constraints=Array.from({length:1024},(_,i)=>({id:'c'+i,expression:{terms:[{coefficient:1,variables:['x_0']}]},relation:'le',rhs:1}));
  checked=await f.call({...args,review:{model:constraints,data:{}}});assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.constraints.length,1024);
  constraints.constraints.push({id:'extra',expression:{terms:[]},relation:'le',rhs:1});
  checked=await f.call({...args,review:{model:constraints,data:{}}});assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.constraints.length,1025);
  const terms=model(1);terms.objective.expression.terms=Array.from({length:20000},()=>({coefficient:0,variables:['x_0']}));
  checked=await f.call({...args,review:{model:terms,data:{}}});assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.objective.value,0);
  terms.constraints.push({id:'one-more-term',expression:{terms:[{coefficient:0,variables:['x_0']}]},relation:'le',rhs:1});
  checked=await f.call({...args,review:{model:terms,data:{}}});assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.objective.value,0);
  assert.deepEqual(f.state,calls);
});

test('mapping terms beyond the former aggregate count remain intact under the shared input capacity',async t=>{
  const f=fixture(t),done=await complete(f),args=next(done,'review');
  const spec={model:{schema_version:'math-model-v1',id:'mapping-limits',variables:['a','b'].map(id=>({id,domain:'integer',lower:0,upper:20000})),objective:{sense:'min',expression:{terms:[{coefficient:1,variables:['a']},{coefficient:1,variables:['b']}]}},constraints:[]},data:{},
    bindings:{a:{terms:Array.from({length:10000},()=>({coefficient:0,variables:['x_0']}))},b:{terms:Array.from({length:10000},()=>({coefficient:0,variables:['x_0']}))}}};
  const checked=await f.call({...args,review:spec});assert.equal(checked.status,'result_reviewed');assert.equal(checked.review.objective.value,0);
  spec.bindings.b.terms.push({coefficient:0,variables:['x_0']});
  const expanded=await f.call({...args,review:spec});assert.equal(expanded.status,'result_reviewed');assert.equal(expanded.review.objective.value,0);
  assert.equal(f.state.submits,1);
});
