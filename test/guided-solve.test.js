'use strict';
const { runWithCleanup } = require('../packages/core/src/run-with-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SolverService, GUIDED_SOLVE_CONTRACT_VERSION } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { createHandler } = require('../src/server');
const qubo = { num_bits: 2, linear: [{ index: 0, coefficient: -1 }, { index: 1, coefficient: -2 }], quadratic: [{ i: 0, j: 1, coefficient: 4 }], offset: 3 };
function fixture(t, locals = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guided-solve-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { XDG_CONFIG_HOME: path.join(directory, 'config'), XDG_DATA_HOME: path.join(directory, 'data') };
  const state = { submits: [], probes: 0, opened: 0, price: 5, fixed: 0, maxScale: 32, failure: null, gate: null, catalogCalls: [] };
  const targetOptions = { environment,
    catalogClientFactory: (_settings, name) => ({ get: async () => { state.catalogCalls.push(name); return { schemaVersion: 1, uploadLimits: { maxCsvBytes: 1048576 }, computerTypes: [{ id: 3, name: '云设备', price: state.price, computeCreditCost: 2, spinNumber: '32', executionCapabilities: { problemTypes: ['qubo'], minDimension: 1, maxDimension: 32, inputFormats: ['csv'], maxCalculateCount: 3, fixedPostProcess: state.fixed, supportsH: false } }] }; } }),
    localTransportFactory: () => adapter('local'), cloudTransportFactory: () => adapter('cloud'),
  };
  function adapter(kind) { return { execution_mode: 'live', prepareSubmission: () => ({}),
    probe: async () => { state.probes++; return { config: { deviceName: 'device', version: '1', maxScale: state.maxScale, maxPrecision: '8bit' }, runtime: { bootTimestamp: 1 }, status: { status: 'stable' } }; },
    submit: async (file, options) => { state.submits.push({ kind, options, csv: file.content.toString() }); if (state.gate) await state.gate; if (state.failure) throw state.failure; return { task_id: 'fixture-task' }; },
    poll: async () => ({ status: 'succeeded', bits: [0, 1], energy: -1000 }),
  }; }
  function service() { const s = new SolverService({ store: new SolveStore(environment), targetOptions }); s.openTargetConfig = async () => { state.opened++; return { url: 'http://127.0.0.1:1234/config#private-session', pid: 9999 }; }; return s; }
  const initial = service();
  for (let i = 0; i < locals; i++) initial.profileSave({ name: '本地' + i, api_base_url: 'http://fixture.test/' + i, web_base_url: 'http://fixture.test/device/' + i });
  return { service: initial, restart: service, state, directory };
}
function requestId(value) { return value.actions?.map(a=>a.call.arguments).find(args=>args.request_id)?.request_id; }
function confirmCall(value) { const item=value.actions.find(x=>x.call.arguments.action==='confirm');assert.ok(item,'current reply must supply a confirmation call');return structuredClone(item.call.arguments); }
function solveId(value) { return value.actions?.map(a=>a.call.arguments).find(args=>args.solve_id)?.solve_id; }
function noAudit(value) {
  const forbidden = new Set(['task_mode','solver_options','execution_mode','environment','contract_version','provider_energy','preparation_token','idempotency_key','model_sha256','matrix_sha256','sha256','precision','encoding','adapter_version','post_process','calculate_count']);
  function visit(x) { if (!x || typeof x !== 'object') return; for (const [key, value] of Object.entries(x)) { assert.ok(!forbidden.has(key), 'ordinary output leaked ' + key); visit(value); } }
  visit(value);
}
test('guided local prepare owns defaults, requires confirmation, persists and replays one task without audit leakage', async t => {
  assert.equal(GUIDED_SOLVE_CONTRACT_VERSION, 'isingq-guided-solve-v1');
  const f = fixture(t);
  const prepared = await f.service.guideSolve({ action: 'prepare', qubo, problem_summary: '项目选择' });
  assert.equal(prepared.ready, true); assert.ok(requestId(prepared));
  assert.deepEqual(prepared.actions.map(a => a.call.arguments.action), ['confirm', 'choose', 'manage', 'cancel']);
  assert.equal(f.state.submits.length, 0); assert.equal(f.state.opened, 0); noAudit(prepared);
  const restarted = f.restart();
  const run = await restarted.guideSolve(confirmCall(prepared));
  const replay = await f.restart().guideSolve(confirmCall(prepared));
  assert.equal(solveId(run), solveId(replay)); assert.equal(f.state.submits.length, 1);
  assert.deepEqual(f.state.submits[0].options, { task_mode: 2 });
  const done = await f.restart().guideSolve({ action: 'status', request_id: requestId(prepared) });
  assert.equal(done.status, 'candidate_ready'); assert.deepEqual(done.result.bits, [0,1]); assert.equal(done.result.objective, 1);
  noAudit(done); assert.match(done.result.note, /业务.*核验/);
  const history = await f.service.guideSolve({ action: 'history' }); noAudit(history);
  assert.equal(history.records[0].task.task_number, 'fixture-task');
});
test('choices, management and pre-submit cancellation never create a task or lose the stored model', async t => {
  const f = fixture(t, 2);
  const p = await f.service.guideSolve({ action: 'prepare', qubo, problem_summary: '分配' });
  assert.equal(p.status, 'needs_target'); assert.ok(p.targets.length >= 2); noAudit(p);
  const choice = await f.service.guideSolve({ action: 'choose', request_id: requestId(p), target_id: p.targets.find(x => x.name === '本地1').call.arguments.target_id });
  assert.equal(choice.ready, true);
  const managed = await f.service.guideSolve({ action: 'manage', request_id: requestId(p) });
  assert.ok(managed.management.url); assert.equal(managed.management.pid, undefined);
  const refreshed = await f.service.guideSolve({ action: 'refresh', request_id: requestId(p) });
  assert.match(refreshed.reply,/本地1/);
  const cancelled = await f.service.guideSolve({ action: 'cancel', request_id: requestId(p) });
  assert.equal(cancelled.status, 'cancelled');
  const cannot = await f.service.guideSolve({ action: 'confirm', request_id: requestId(p) }); assert.notEqual(cannot.status, 'submitted');
  assert.equal(f.state.submits.length, 0); assert.equal(f.state.opened, 1);
});
test('paid cloud uses directory-fixed processing, explicit funding and re-confirmation on changed quote', async t => {
  const f = fixture(t, 0);
  const p = await f.service.guideSolve({ action: 'prepare', qubo, problem_summary: '排班' });
  const selected = await f.service.guideSolve({ action: 'choose', request_id: requestId(p), target_id: p.targets[0].call.arguments.target_id });
  assert.equal(selected.status, 'needs_payment'); noAudit(selected);
  assert.equal((await f.service.guideSolve({ action: 'confirm', request_id: requestId(p) })).status, 'needs_payment');
  const funded = await f.service.guideSolve({ action: 'funding', request_id: requestId(p), payment: 'credits' });
  assert.equal(funded.ready, true); assert.match(funded.reply,/本次付款来源：算力券/);
  f.state.price = 9;
  const changed = await f.service.guideSolve(confirmCall(funded));
  assert.equal(changed.ready, true); assert.equal(changed.status, 'ready'); assert.ok(changed.notice); assert.equal(f.state.submits.length, 0);
  const submitted = await f.service.guideSolve(confirmCall(changed)); assert.equal(submitted.status, 'submitted');
  assert.deepEqual(f.state.submits[0].options, { computer_type_id: 3, question_type: 1, calculate_count: 1, post_process: 0, use_credit: true });
  assert.ok(f.state.catalogCalls.every(name => name === 'prod')); noAudit(submitted);
});
test('concurrent confirmation and uncertain acceptance never issue a second submission after restart', async t => {
  const f = fixture(t); let release;
  f.state.gate = new Promise(r => { release = r; });
  const p = await f.service.guideSolve({ action: 'prepare', qubo, problem_summary: '路径' });
  const one = f.service.guideSolve(confirmCall(p));
  const two = f.restart().guideSolve(confirmCall(p));
  release(); const [a,b] = await Promise.all([one,two]);
  assert.equal(solveId(a), solveId(b)); assert.equal(f.state.submits.length, 1);
  const g = fixture(t); g.state.failure = Object.assign(new Error('private_task_mode_and_key_must_not_leak'), { submissionOutcome: 'unknown' });
  const q = await g.service.guideSolve({ action: 'prepare', qubo, problem_summary: '未知受理' });
  const failed = await g.service.guideSolve(confirmCall(q));
  assert.equal(failed.status, 'submission_unknown'); noAudit(failed); assert.doesNotMatch(JSON.stringify(failed), /private_task_mode_and_key/);
  await g.restart().guideSolve(confirmCall(q));
  assert.equal(g.state.submits.length, 1);
});

test('ordinary MCP confirms with one read per unchanged history record and recovers the original accepted run', async t => {
  const f = fixture(t), store = f.service.store;
  const call = service => {
    const handler = createHandler(service);
    return async args => (await handler({ method: 'tools/call', params: { name: 'isingq_solve', arguments: args } })).structuredContent.data;
  };
  const guided = call(f.service), prepared = await guided({ action: 'prepare', qubo, problem_summary: '普通确认与恢复' });
  const confirmation = confirmCall(prepared);
  const planFile = path.join(store.directory, '.guided', confirmation.request_id + '.json');
  const originalPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const files = new Map();
  for (let index = 1; index <= 12; index++) {
    const id = 'solve_' + index.toString(16).padStart(32, '0');
    files.set(store.path(id), id);
    store.save({ solve_id: id, idempotency_digest: '1'.repeat(64), request_digest: '2'.repeat(64),
      status: 'succeeded', execution_mode: 'simulation', qubo });
  }
  const readCounts = new Map(), parsedCounts = new Map(), historyIds = new Set(files.values());
  const open = fs.openSync, parse = JSON.parse;
  const openMock = t.mock.method(fs, 'openSync', (file, ...args) => {
    const id = files.get(file);
    if (id) readCounts.set(id, (readCounts.get(id) || 0) + 1);
    return open(file, ...args);
  });
  const parseMock = t.mock.method(JSON, 'parse', (value, ...args) => {
    const record = parse(value, ...args), id = record?.solve_id;
    if (historyIds.has(id)) parsedCounts.set(id, (parsedCounts.get(id) || 0) + 1);
    return record;
  });
  let submitted;
  try {
    submitted = await guided(confirmation);
    assert.equal(submitted.status, 'submitted', JSON.stringify(submitted));
    for (const id of historyIds) {
      assert.equal(readCounts.get(id), 1, id + ' open count');
      assert.equal(parsedCounts.get(id), 1, id + ' parse count');
    }
  } finally {
    openMock.mock.restore();
    parseMock.mock.restore();
  }
  const probesAfterSubmit = f.state.probes;
  for (const state of ['submitting', 'submission_unknown']) {
    // Restore the on-disk plan from the interval before the run ID was attached.
    fs.writeFileSync(planFile, JSON.stringify({ ...originalPlan, state }));
    const resumed = await call(f.restart())(confirmation);
    assert.equal(resumed.status, 'submitted', JSON.stringify(resumed));
    assert.equal(solveId(resumed), solveId(submitted));
    assert.equal(resumed.task.task_number, 'fixture-task');
  }
  assert.equal(f.state.probes, probesAfterSubmit);
  assert.equal(f.state.submits.length, 1);
});

test('normal MCP discovery and guide expose only business facade; technical profile and old explicit calls remain', async () => {
  const normal = createHandler({ guideSolve: async args => ({ status: 'ready', ready: true, actions: [], seen: args.action }) });
  const init = await normal({ method: 'initialize' });
  assert.ok(init.instructions.length < 1500); assert.doesNotMatch(init.instructions, /task_mode|post_process|preparation_token|target_submit/);
  const listed = await normal({ method: 'tools/list' });
  assert.deepEqual(listed.tools.map(t => t.name), ['isingq_api_key_setup','isingq_knowledge_get','isingq_modeling_guide_get','isingq_solve']);
  assert.equal(listed.tools.find(t => t.name === 'isingq_solve').annotations.readOnlyHint, false);
  const guide = (await normal({ method: 'tools/call', params: { name: 'isingq_modeling_guide_get', arguments: {} } })).structuredContent.data;
  noAudit(guide); assert.doesNotMatch(JSON.stringify(guide), /task_mode|post_process/);
  const tech = await createHandler({}, { tools_profile: 'technical' })({ method: 'tools/list' });
  assert.ok(tech.tools.some(t => t.name === 'isingq_target_solve_start'));
  const legacy = await createHandler({ listTargets: async () => ({ legacy: true }) })({ method: 'tools/call', params: { name: 'isingq_solver_targets_list', arguments: {} } });
  assert.equal(legacy.structuredContent.data.legacy, true);
});

test('normal model failures keep actionable indexes; profile resources and setup never restore raw rules', async t => {
  const f=fixture(t);
  const invalid=await f.service.guideSolve({action:'prepare',problem_summary:'坏模型',qubo:{num_bits:2,linear:[{index:2,coefficient:1}]}});
  assert.equal(invalid.status,'blocked');assert.match(invalid.blockers[0].message,/linear\[0\].index.*0.*1.*2/);noAudit(invalid);
  for(const args of [{action:'confirm',request_id:'request_bad',confirmed:true},{action:'history',limit:0},{action:'status',solve_id:'not-a-record'}]) assert.equal((await f.service.guideSolve(args)).status,'blocked');
  const ordinary=createHandler({});
  for(const uri of ['isingq://modeling/qubo','isingq://security/data-flow']) {
    const r=await ordinary({method:'resources/read',params:{uri}});
    assert.ok(r.contents[0].text.length<5000);assert.doesNotMatch(r.contents[0].text,/task_mode|solver_options|preparation_token|target_submit/);
  }
  const setup=createHandler({}, {configureApiKey:()=>({configured:true,status:'configured',execution_mode:'live',credential_effect:'written',credential_presence:'available',remote_verification:'unverified',no_real_credentials:false})});
  const configured=(await setup({method:'tools/call',params:{name:'isingq_api_key_setup',arguments:{}}})).structuredContent.data;
  noAudit(configured);assert.equal(configured.status,'saved');assert.equal(configured.remote_verified,false);
  assert.equal(f.state.submits.length,0);
});

test('a killed submit process restores the same reserved task and never submits again', {timeout:10000}, async t => {
  const f=fixture(t);
  const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'崩溃恢复'});
  const count=path.join(f.directory,'remote-count.txt');
  const script=path.join(f.directory,'crash-fixture.cjs');
  fs.writeFileSync(script,`const fs=require('node:fs');const {SolverService}=require(${JSON.stringify(path.resolve(__dirname,'../packages/core'))});const {SolveStore}=require(${JSON.stringify(path.resolve(__dirname,'../packages/core/src/store'))});const environment=${JSON.stringify({XDG_CONFIG_HOME:path.join(f.directory,'config'),XDG_DATA_HOME:path.join(f.directory,'data')})};const service=new SolverService({store:new SolveStore(environment),targetOptions:{environment,localTransportFactory:()=>({execution_mode:'live',prepareSubmission:()=>({}),probe:async()=>({config:{deviceName:'device',version:'1',maxScale:32,maxPrecision:'8bit'},runtime:{bootTimestamp:1},status:{status:'stable'}}),submit:async()=>{fs.appendFileSync(${JSON.stringify(count)},'created\\n');process.send('remote-started');await new Promise(()=>{});},poll:async()=>{throw Error('must not poll an unknown task')}})}});service.guideSolve(${JSON.stringify(confirmCall(p))}).then(value=>process.send(value));`);
  const child=require('node:child_process').fork(script,[],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>child.kill());
  let stderr='';child.stderr.on('data',x=>{stderr+=x;});
  await new Promise((resolve,reject)=>{child.on('message',m=>m==='remote-started'?resolve():reject(Error(JSON.stringify(m))));child.on('error',reject);child.on('exit',code=>reject(Error('early exit '+code+' '+stderr)));});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
  const restored=await f.restart().guideSolve(confirmCall(p));
  assert.equal(restored.status,'submission_unknown');assert.ok(solveId(restored));noAudit(restored);
  const again=await f.restart().guideSolve({action:'status',request_id:requestId(p)});
  assert.equal(solveId(again),solveId(restored));assert.equal(again.status,'submission_unknown');
  assert.equal(fs.readFileSync(count,'utf8').trim().split('\n').length,1);assert.equal(f.state.submits.length,0);
});

test('ordinary setup preserves written, available, simulation and unknown evidence without private/audit fields', async () => {
  const fixtures=[
    [{configured:true,status:'configured',execution_mode:'live',credential_effect:'written',credential_presence:'available',remote_verification:'unverified',no_real_credentials:false},'saved',true],
    [{configured:true,status:'already_configured',execution_mode:'live',credential_effect:'already_present',credential_presence:'available',remote_verification:'unverified',no_real_credentials:false},'available',true],
    [{configured:false,status:'simulation',execution_mode:'simulation',credential_effect:'not_written',credential_presence:'not_checked',remote_verification:'not_applicable',no_real_credentials:true},'simulation',false],
    [{configured:false,status:'unknown',execution_mode:'unknown',credential_effect:'unknown',credential_presence:'not_checked',remote_verification:'unverified',no_real_credentials:null},'unknown',false],
  ];
  const {ordinarySetupResult,normalizeSetupResult}=require('../packages/core');
  for(const [raw,status,configured] of fixtures) {
    const handle=createHandler({}, {configureApiKey:()=>raw});
    const value=(await handle({method:'tools/call',params:{name:'isingq_api_key_setup',arguments:{}}})).structuredContent.data;
    assert.equal(value.status,status);assert.equal(value.configured,configured);assert.equal(value.remote_verified,false);noAudit(value);
    assert.deepEqual(value,ordinarySetupResult(normalizeSetupResult(raw)));
    assert.equal(value.credential_presence,undefined);assert.equal(value.runtime,undefined);
    if(status==='unknown')assert.match(value.message,/不能据此断定用户没有凭据/);
    if(status==='simulation')assert.match(value.message,/本次未保存真实凭据/);
  }
});

test('ordinary prepare retains target-sized models above legacy limits and rejects parameter injection', async t => {
  const f=fixture(t);f.state.maxScale=4096;
  const p=await f.service.guideSolve({action:'prepare',qubo:{num_bits:2049,linear:[{index:2048,coefficient:-1}]},problem_summary:'大规模本地模型'});
  assert.equal(p.ready,true);noAudit(p);assert.equal(f.state.submits.length,0);
  const injected=await f.service.guideSolve({action:'confirm',request_id:requestId(p),solver_options:{task_mode:0}});
  assert.equal(injected.status,'blocked');assert.equal(f.state.submits.length,0);
  const file=path.join(f.service.store.directory,'.guided',requestId(p)+'.json');
  const plan=JSON.parse(fs.readFileSync(file));assert.equal(plan.qubo.num_bits,2049);assert.ok(plan.preparation.preparation_token);
  if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
});

test('viewing complete choices preserves an adopted local target and allows an explicit cloud switch', async t => {
  const f=fixture(t);
  const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'改选目标'});
  assert.match(p.reply,/所选目标：本地0/);
  const all=await f.service.guideSolve({action:'choose',request_id:requestId(p)});
  assert.match(all.reply,/所选目标：本地0/);assert.equal(all.ready,false);assert.equal(all.status,'needs_target');
  const cloud=all.targets.find(x=>x.location==='云端');assert.ok(cloud);
  const switched=await f.service.guideSolve({action:'choose',request_id:requestId(p),target_id:cloud.call.arguments.target_id});
  assert.equal(switched.status,'needs_payment');assert.match(switched.reply,/所选目标：云设备/);
  assert.equal(f.state.submits.length,0);
});

test('unknown acceptance across handles preserves the original target and history does not invent missing origins', async t => {
  const f=fixture(t,2);f.state.failure=Object.assign(new Error('fixture acceptance unknown'),{submissionOutcome:'unknown'});
  const first=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'原目标',preferred_target:'本地0'});
  const unknown=await f.service.guideSolve(confirmCall(first));
  const next=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'改目标',preferred_target:'本地1'});
  const guarded=await f.service.guideSolve(confirmCall(next));
  assert.equal(solveId(guarded),solveId(unknown));assert.equal(guarded.task.target.name,'本地0');assert.match(guarded.reply,/所选目标：本地0/);
  assert.equal(f.state.submits.length,1);
  const raw=f.service.store.get(solveId(unknown));raw.schema='isingq-mcp-solve/v1';delete raw.target;delete raw.view;f.service.store.save(raw);
  const history=await f.service.guideSolve({action:'history'});assert.equal(history.records[0].task.target.location,'未记录');
  assert.equal(history.records[0].task.view.url,null);noAudit(history);
});

test('real stdio launcher selects short normal discovery and explicit technical compatibility', {timeout:10000}, async t => {
  const {spawn}=require('node:child_process'),readline=require('node:readline');
  for(const technical of [false,true]) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guided-stdio-'));
    const child=spawn(process.execPath,[path.resolve(__dirname,'../bin/isingq-mcp.js'),'serve',...(technical?['--technical']:[])],{env:{...process.env,XDG_CONFIG_HOME:path.join(dir,'config'),XDG_DATA_HOME:path.join(dir,'data'),ISINGQ_UPDATE_CHECK:'off'},stdio:['pipe','pipe','pipe']});
    t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
    const replies=new Map();let seq=0;
    readline.createInterface({input:child.stdout}).on('line',line=>{const msg=JSON.parse(line);replies.get(msg.id)?.(msg);replies.delete(msg.id);});
    const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('stdio timed out')),3000);replies.set(id,value=>{clearTimeout(timer);resolve(value.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    const tools=await rpc('tools/list');assert.equal(tools.tools.length,technical?20:4);
    assert.equal(tools.tools.some(tool=>tool.name==='isingq_target_solve_start'),technical);
    const init=await rpc('initialize');assert.equal(init.instructions.includes('target_submit'),technical);
    const resource=await rpc('resources/read',{uri:'isingq://modeling/qubo'});
    assert.equal(resource.contents[0].text.includes('task_mode'),technical);
    child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));
  }
});

test('ordinary human reply and complete ready-made calls keep handles out of business display', async t => {
  const f=fixture(t);
  const technicalSummary='技术摘要 marker：系数-955，理论下界17，能量方程和内部诊断不应成为用户回复。';
  const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:technicalSummary});
  assert.equal(typeof p.reply,'string','program must produce the display reply');
  assert.equal(p.request_id,undefined);assert.equal(p.solve_id,undefined);assert.equal(p.summary,undefined);
  assert.doesNotMatch(p.reply,/marker|955|下界17|局部极值|task_mode|request_|solve_/);
  assert.match(p.reply,/本地0/);assert.match(p.reply,/2.*变量/);assert.match(p.reply,/fixture\.test/);assert.match(p.reply,/占用/);
  for(const item of p.actions) {
    assert.equal(item.call.tool,'isingq_solve');assert.ok(item.call.arguments.action);assert.ok(p.reply.includes(item.label));
    if(!['history'].includes(item.call.arguments.action))assert.ok(item.call.arguments.request_id);
  }
  assert.ok(p.actions.some(item=>item.call.arguments.action==='manage'));
  assert.ok(p.actions.some(item=>item.call.arguments.action==='cancel'));
  const savedId=p.actions.find(item=>item.call.arguments.action==='confirm').call.arguments.request_id;
  const plan=JSON.parse(fs.readFileSync(path.join(f.service.store.directory,'.guided',savedId+'.json')));
  assert.equal(plan.problem_summary,technicalSummary);assert.deepEqual(plan.qubo.variables,[]);
  const handle=createHandler(f.service);
  const refreshed=await handle({method:'tools/call',params:{name:'isingq_solve',arguments:p.actions.find(x=>x.call.arguments.action==='choose').call.arguments}});
  const textResult=JSON.parse(refreshed.content[0].text);
  assert.equal(textResult.reply,refreshed.structuredContent.data.reply);
  assert.deepEqual(textResult.actions,refreshed.structuredContent.data.actions);
  assert.ok(refreshed.structuredContent.data.actions.every(x=>x.call));
  assert.equal(f.state.submits.length,0);
});

test('stale confirmation calls never upgrade to another target or a changed quote', async t => {
  await t.test('old target callback cannot create the new target and post-submit replay only reads the original task',async t=>{
    const f=fixture(t,2);
    const a=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'内容绑定',preferred_target:'本地0'});
    const old=a.actions.find(x=>x.call.arguments.action==='confirm').call.arguments;
    const list=await f.service.guideSolve(a.actions.find(x=>x.call.arguments.action==='choose').call.arguments);
    const b=await f.service.guideSolve(list.targets.find(x=>x.name==='本地1').call.arguments);
    const current=b.actions.find(x=>x.call.arguments.action==='confirm').call.arguments;
    const blocked=await f.service.guideSolve(old);
    assert.equal(f.state.submits.length,0,'saved confirm for A must not submit B');assert.ok(blocked.notice);
    await f.restart().guideSolve(old);assert.equal(f.state.submits.length,0);
    assert.notDeepEqual(old,current);assert.ok(current.confirmation_ref);
    const submitted=await f.service.guideSolve(current);assert.equal(f.state.submits.length,1);
    for(const args of [old,current]) {
      const replay=await f.restart().guideSolve(args);assert.equal(solveId(replay),solveId(submitted));
      assert.equal(replay.task.target.name,'本地1');assert.equal(f.state.submits.length,1);
    }
  });
  await t.test('replaying the old callback after quote refresh never submits the revised quote',async t=>{
    const f=fixture(t,0);
    const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'报价绑定'});
    const selected=await f.service.guideSolve(p.targets[0].call.arguments);
    const ready=await f.service.guideSolve(selected.actions.find(x=>x.call.arguments.payment==='credits').call.arguments);
    const old=ready.actions.find(x=>x.call.arguments.action==='confirm').call.arguments;
    f.state.price=9;
    const changed=await f.service.guideSolve(old);assert.equal(f.state.submits.length,0);
    const current=changed.actions.find(x=>x.call.arguments.action==='confirm').call.arguments;
    await f.service.guideSolve(old);assert.equal(f.state.submits.length,0,'second replay must not silently accept the new quote');
    await f.restart().guideSolve(old);assert.equal(f.state.submits.length,0);
    assert.notDeepEqual(old,current);assert.ok(current.confirmation_ref);
    const submitted=await f.service.guideSolve(current);assert.equal(submitted.status,'submitted');assert.equal(f.state.submits.length,1);
    const replay=await f.restart().guideSolve(current);assert.equal(solveId(replay),solveId(submitted));assert.equal(f.state.submits.length,1);
  });
});

test('busy valid requests retain a safe status call and capacity uses current declarations rather than names', async t => {
  await t.test('busy continuation is read-only and resumable',async t=>{
    const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'忙碌续接'});
    const lock=path.join(f.service.store.directory,'.guided',requestId(p)+'.json.lock');
    fs.writeFileSync(lock,String(process.pid));
    let busy;
    await runWithCleanup(async () => {
      busy=await f.service.guideSolve(confirmCall(p));
    }, async () => {
      fs.unlinkSync(lock);
    });
    const status=busy.actions.find(x=>x.call.arguments.action==='status');
    assert.ok(status,'busy request must retain the exact read-only continuation');
    assert.equal(status.call.arguments.request_id,requestId(p));assert.equal(status.call.arguments.confirmation_ref,undefined);
    const resumed=await f.service.guideSolve(status.call.arguments);assert.equal(resumed.ready,true);assert.equal(f.state.submits.length,0);
  });
  await t.test('capacity is from actual current device and remains unknown when undeclared',async t=>{
    const f=fixture(t);f.state.maxScale=2049;
    const profile=f.service.profileList()[0];f.service.profileSave({...profile,name:'4096全连接示例名'});
    const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'规模核对'});
    assert.equal(p.summary,undefined);assert.match(p.reply,/本次规模符合已核实的规模限制/);assert.match(p.reply,/规模上限[^\n]*2049/);
    assert.doesNotMatch(p.reply,/规模上限[^\n]*4096/);assert.equal(f.state.submits.length,0);
    const g=fixture(t,0);const choices=await g.service.guideSolve({action:'prepare',qubo,problem_summary:'尚未选目标'});
    assert.equal(choices.summary,undefined);assert.equal(choices.status,'needs_target');assert.doesNotMatch(choices.reply,/规模上限[0-9]/);
  });
});

test('confirmation revisions survive unchanged refresh but not a blocked stage or funding change',async t=>{
  await t.test('read-only refresh is stable; transient blocking revokes the previous stage',async t=>{
    const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'阶段绑定'});
    const old=confirmCall(p);
    const same=await f.service.guideSolve({action:'refresh',request_id:requestId(p)});
    assert.deepEqual(confirmCall(same),old);
    f.state.maxScale=1;
    const blocked=await f.service.guideSolve({action:'refresh',request_id:requestId(same)});
    assert.equal(blocked.ready,false);
    f.state.maxScale=32;
    const restored=await f.restart().guideSolve(blocked.actions.find(x=>x.call.arguments.action==='refresh').call.arguments);
    assert.equal(restored.ready,true);assert.notDeepEqual(confirmCall(restored),old);
    await f.service.guideSolve(old);assert.equal(f.state.submits.length,0);
    await f.service.guideSolve(confirmCall(restored));assert.equal(f.state.submits.length,1);
  });
  await t.test('changing payment revokes the old funded callback',async t=>{
    const f=fixture(t,0);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'付款内容绑定'});
    const selected=await f.service.guideSolve(p.targets[0].call.arguments);
    const credits=await f.service.guideSolve(selected.actions.find(x=>x.call.arguments.payment==='credits').call.arguments);
    const old=confirmCall(credits);
    const balance=await f.service.guideSolve(selected.actions.find(x=>x.call.arguments.payment==='balance').call.arguments);
    await f.service.guideSolve(old);assert.equal(f.state.submits.length,0);assert.notDeepEqual(confirmCall(balance),old);
    await f.service.guideSolve(confirmCall(balance));assert.equal(f.state.submits.length,1);assert.equal(f.state.submits[0].options.use_credit,false);
  });
});

test('ordinary MCP guidance completes already explicit preparation choices before waiting for the user',async()=>{
  const {ORDINARY_PREPARATION_FLOW}=require('../packages/core/src/guided-tools');
  assert.equal(typeof ORDINARY_PREPARATION_FLOW,'string','prepare continuation must have one canonical stage contract');
  const handle=createHandler(new Proxy({}, {get(){throw Error('GUIDANCE_MUST_NOT_CALL_SOLVER');}}));
  const initialized=await handle({method:'initialize'});
  const guide=(await handle({method:'tools/call',params:{name:'isingq_modeling_guide_get',arguments:{}}})).structuredContent.data;
  const listed=await handle({method:'tools/list'});
  const resource=await handle({method:'resources/read',params:{uri:'isingq://modeling/qubo'}});
  for(const text of [initialized.instructions,guide.steps.join(' '),listed.tools.find(x=>x.name==='isingq_solve').description,resource.contents[0].text]) {
    assert.ok(text.includes(ORDINARY_PREPARATION_FLOW),'actual normal consumer must use the same continuation contract');
    assert.match(text,/已(?:经)?明确.*业务选择/);
    assert.match(text,/名称.*来源.*无歧义.*现成call.*继续准备/);
    assert.match(text,/不重复追问/);
    assert.match(text,/已有.*付款.*复用/);
    assert.match(text,/选择不等于提交/);
    assert.match(text,/仅.*缺少目标或付款.*硬性阻断.*ready.*确认.*呈现reply.*等待用户/);
    assert.doesNotMatch(text,/先prepare，直接呈现本步reply/);
  }
});
