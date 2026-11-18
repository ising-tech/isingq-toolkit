'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const core=require('../packages/core');
const {SolveStore}=require('../packages/core/src/store');
const {WorkspaceArtifacts}=require('../packages/core/src/workspace');
const {createHandler}=require('../src/server');
const qubo={num_bits:2,linear:[{index:0,coefficient:-3},{index:1,coefficient:-2}],quadratic:[{i:0,j:1,coefficient:4}],offset:3,variables:[{index:0,name:'A',meaning:'选择A'},{index:1,name:'B',meaning:'选择B'}]};
const doc='## 业务模型\n变量：A、B表示两个项目是否选择。\n目标：最小化费用。\n约束：A+B=1。\n公式：min 3A+B。';
function fixture(t,{spacedRoot=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-artifacts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const environment={XDG_CONFIG_HOME:path.join(dir,'config'),XDG_DATA_HOME:path.join(dir,spacedRoot?'data with space (one) #tag':'data')};
 const state={submits:0,probes:0,csv:null,probeHook:null};
 const targetOptions={environment,catalogClientFactory:()=>({get:async()=>{throw Error('NO_CLOUD_NETWORK');}}),localTransportFactory:()=>({execution_mode:'live',prepareSubmission:()=>({}),probe:async()=>{state.probes++;state.probeHook?.(state.probes);return{config:{deviceName:'fixture',version:'1',maxScale:128,maxPrecision:'8bit'},runtime:{bootTimestamp:1},status:{status:'stable'}};},submit:async(file)=>{state.submits++;state.csv=file.content.toString();return{task_id:'artifact-fixture'};},poll:async()=>({status:'succeeded',bits:[0,1],energy:-100})})};
 const service=new core.SolverService({store:new SolveStore(environment),targetOptions});
 service.profileSave({name:'模型设备',api_base_url:'http://fixture.test/device'});
 return{dir,environment,state,service};
}
// refresh remains a Core API for regression checks, not a normal ready-menu item.
const call=(value,action)=>{const item=value.actions.find(x=>x.call.arguments.action===action);if(item)return item.call.arguments;if(action==='refresh')return{action,request_id:value.actions.find(x=>x.call.arguments.request_id).call.arguments.request_id};assert.fail('missing action '+action);};
const paths=value=>Object.fromEntries(value.modeling.files.map(x=>[path.basename(x.path),x.path]));
test('prepare exports actual model, normalized QUBO and exact source CSV with full business modeling display',async t=>{
 assert.equal(core.GUIDED_MODEL_ARTIFACT_CONTRACT_VERSION,'isingq-guided-model-artifacts-v1');
 const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'项目选择',model_markdown:doc});
 assert.equal(p.ready,true);assert.equal(p.modeling.status,'exported');assert.equal(p.modeling.display,'full');assert.equal(p.modeling.files.length,3);
 const files=paths(p);assert.deepEqual(JSON.parse(fs.readFileSync(files['qubo.json'],'utf8')),core.validateQubo(qubo).qubo);
 assert.deepEqual(fs.readFileSync(files['matrix.csv']),core.matrixDocument(qubo).content);
 assert.equal(p.modeling.markdown,fs.readFileSync(files['model.md'],'utf8'));assert.ok(p.modeling.markdown.includes(doc));
 assert.match(p.modeling.markdown,/x_\{0\}[\s\S]*x_\{1\}/);assert.match(p.modeling.markdown,/选择A/);assert.match(p.modeling.markdown,/选择B/);
 assert.match(p.modeling.note,/不证明.*业务等价/);assert.match(p.modeling.location,/Toolkit.*运行主机/);
 for(const file of p.modeling.files){assert.ok(p.modeling.files_markdown.includes(file.path));assert.ok(file.label);if(process.platform!=='win32')assert.equal(fs.statSync(file.path).mode&0o777,0o600);}
 assert.equal(f.state.submits,0);
});
test('missing prose remains compatible and repeated choices/status/refresh reuse files without suppressing unshown modeling',async t=>{
 const f=fixture(t);let writes=0;const original=WorkspaceArtifacts.prototype.write;
 WorkspaceArtifacts.prototype.write=function(...args){writes++;return original.apply(this,args);};t.after(()=>{WorkspaceArtifacts.prototype.write=original;});
 const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'矩阵输入'});const files=paths(p);
 assert.match(p.modeling.markdown,/业务.*未提供|未提供.*业务/);assert.match(p.modeling.markdown,/f\(x\)/);assert.equal(writes,3);
 const before=Object.fromEntries(Object.entries(files).map(([key,file])=>[key,fs.readFileSync(file)]));
 const selected=await f.service.guideSolve(call(p,'choose'));assert.equal(selected.modeling.display,'full');assert.equal(selected.modeling.markdown,p.modeling.markdown);
 const status=await f.service.guideSolve({action:'status',request_id:call(p,'refresh').request_id});
 assert.equal(status.modeling.display,'files_only');assert.equal(status.modeling.markdown,undefined);assert.equal(status.modeling.files.length,3);
 await f.service.guideSolve(call(p,'refresh'));assert.equal(writes,3);
 for(const [key,file] of Object.entries(files))assert.deepEqual(fs.readFileSync(file),before[key]);assert.equal(f.state.submits,0);
});
test('changed files block old confirmation; restoring bytes requires a new confirmation revision',async t=>{
 const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'产物绑定',model_markdown:doc});
 const csv=paths(p)['matrix.csv'],before=fs.readFileSync(csv),old=call(p,'confirm');fs.writeFileSync(csv,'corrupt\n');
 const blocked=await f.service.guideSolve(old);assert.equal(blocked.ready,false);assert.match(blocked.reply,/产物|文件/);assert.equal(f.state.submits,0);assert.equal(f.service.listRuns().total,0);
 fs.writeFileSync(csv,before);const restored=await f.service.guideSolve(call(blocked,'refresh'));assert.equal(restored.ready,true);
 assert.notEqual(call(restored,'confirm').confirmation_ref,old.confirmation_ref);
 await f.service.guideSolve(old);assert.equal(f.state.submits,0);
 await f.service.guideSolve(call(restored,'confirm'));assert.equal(f.state.submits,1);assert.equal(f.state.csv,before.toString());
});
test('artifact validation runs after the last asynchronous device preparation and before creating a task',async t=>{
 const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'最终文件检查',model_markdown:doc});
 const model=paths(p)['model.md'];f.state.probeHook=n=>{if(n===3)fs.appendFileSync(model,'\nchanged');};
 const blocked=await f.service.guideSolve(call(p,'confirm'));assert.equal(blocked.ready,false);assert.equal(f.state.submits,0);assert.equal(f.service.listRuns().total,0);
});
test('model action exports without target discovery, device checks, keys or task creation and prepares the same plan later',async t=>{
 const f=fixture(t);const list=f.service.listTargets,profiles=f.service.profileList;
 f.service.listTargets=()=>{throw Error('MODEL_MUST_NOT_LIST_TARGETS');};f.service.profileList=()=>{throw Error('MODEL_MUST_NOT_READ_CONNECTIONS');};
 const m=await f.service.guideSolve({action:'model',qubo,problem_summary:'仅建模',model_markdown:doc});
 assert.equal(m.status,'modeled');assert.equal(m.modeling.files.length,3);assert.equal(f.state.probes,0);assert.equal(f.state.submits,0);
 const files=paths(m);f.service.listTargets=list;f.service.profileList=profiles;
 const p=await f.service.guideSolve(call(m,'prepare'));assert.equal(p.ready,true);assert.deepEqual(paths(p),files);assert.equal(f.state.submits,0);
});
test('unsafe output paths and write failures do not claim successful files or overwrite partial artifacts',async t=>{
 await t.test('symlink path',async t=>{
  const f=fixture(t),outside=path.join(f.dir,'outside');fs.mkdirSync(outside);
  const round=path.join(f.service.store.directory,'.guided','round1');fs.mkdirSync(round,{recursive:true});fs.symlinkSync(outside,path.join(round,'output'));
  const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'路径检查',model_markdown:doc});
  assert.equal(p.ready,false);assert.equal(p.modeling.status,'unavailable');assert.equal(p.modeling.files.length,0);assert.deepEqual(fs.readdirSync(outside),[]);assert.equal(f.state.submits,0);
 });
 await t.test('partial write failure',async t=>{
  const f=fixture(t),original=WorkspaceArtifacts.prototype.write;let writes=0;
  WorkspaceArtifacts.prototype.write=function(relative,...rest){writes++;if(relative.endsWith('matrix.csv'))throw Error('fixture write failure');return original.call(this,relative,...rest);};
  let p;try{p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'写入检查'});}finally{WorkspaceArtifacts.prototype.write=original;}
  assert.equal(p.ready,false);assert.equal(p.modeling.status,'unavailable');assert.equal(p.modeling.files.length,0);assert.equal(writes,3);
  const refresh=await f.service.guideSolve(call(p,'refresh'));assert.equal(refresh.ready,false);assert.equal(f.state.submits,0);
 });
});

test('large models use an exact bounded expression and normal MCP distinguishes model artifacts from host-side business modeling',async t=>{
 const f=fixture(t),large={num_bits:50,linear:Array.from({length:50},(_,index)=>({index,coefficient:index+1})),variables:Array.from({length:50},(_,index)=>({index,name:'业务变量'+index,meaning:'用户提供的映射'+index}))};
 const p=await f.service.guideSolve({action:'model',qubo:large,problem_summary:'大模型'});
 assert.equal(p.modeling.files.length,3);assert.match(p.modeling.markdown,/\\sum_/);assert.ok(p.modeling.markdown.length<3000);
 assert.deepEqual(JSON.parse(fs.readFileSync(paths(p)['qubo.json'],'utf8')),core.validateQubo(large).qubo);
 const handle=createHandler({});const tools=(await handle({method:'tools/list'})).tools;
 assert.equal(tools.length,4);const schema=tools.find(x=>x.name==='isingq_solve').inputSchema;
 assert.ok(schema.properties.action.enum.includes('model'));assert.equal(schema.properties.model_markdown.type,'string');assert.equal(schema.properties.root,undefined);
 const security=(await handle({method:'resources/read',params:{uri:'isingq://security/data-flow'}})).contents[0].text;
 assert.match(security,/业务建模由宿主Agent完成.*是否联网由宿主决定/);assert.match(security,/QUBO校验.*Toolkit运行主机/);
 assert.doesNotMatch(security,/建模与准备在工具本地完成/);assert.equal(f.state.submits,0);assert.equal(f.state.probes,0);
});

test('full model views verify current bytes, revoke stale confirmation, and preserve an already accepted task',async t=>{
 await t.test('unsubmitted view detects same-length edits without rewriting and requires a fresh confirmation',async t=>{
  const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'显示一致性',model_markdown:doc});
  const file=paths(p)['model.md'],original=fs.readFileSync(file,'utf8'),edited=original.replace('业务模型','业务模形'),old=call(p,'confirm');
  assert.equal(Buffer.byteLength(edited),Buffer.byteLength(original));fs.writeFileSync(file,edited);
  const view=await f.service.guideSolve(call(p,'choose'));
  assert.equal(view.ready,false,'a full stale model view must not remain confirmable');assert.equal(view.modeling.status,'unavailable');
  assert.equal(view.modeling.integrity,'failed');assert.equal(view.modeling.markdown,undefined);assert.ok(!view.actions.some(x=>x.call.arguments.action==='confirm'));
  assert.equal(fs.readFileSync(file,'utf8'),edited);assert.equal(f.state.submits,0);
  fs.writeFileSync(file,original);await f.service.guideSolve(old);assert.equal(f.state.submits,0);
  const refreshed=await f.service.guideSolve(call(view,'refresh'));assert.equal(refreshed.ready,true);assert.notEqual(call(refreshed,'confirm').confirmation_ref,old.confirmation_ref);
 });
 await t.test('accepted task status and original input remain unchanged when its current artifact view fails',async t=>{
  const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'原记录',model_markdown:doc});
  const submitted=await f.service.guideSolve(call(p,'confirm')),id=call(submitted,'status').solve_id;
  const raw=fs.readFileSync(f.service.store.path(id)),file=paths(p)['model.md'];fs.appendFileSync(file,'\nuser edit');
  const viewed=await f.service.guideSolve(call(p,'confirm'));
  assert.equal(viewed.status,submitted.status);assert.equal(viewed.modeling.status,'unavailable');assert.equal(viewed.modeling.markdown,undefined);assert.doesNotMatch(viewed.modeling.note,/重新确认/);
  assert.deepEqual(fs.readFileSync(f.service.store.path(id)),raw);assert.equal(f.state.submits,1);
 });
});

test('files-only views state their unverified scope and valid Markdown links preserve actual spaced paths',async t=>{
 await t.test('files-only does not rehash large files or claim current verification',async t=>{
  const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'只看进度'});
  const {GuidedModelArtifacts}=require('../packages/core/src/guided-model-artifacts'),original=GuidedModelArtifacts.prototype.verify;let checked=0;
  GuidedModelArtifacts.prototype.verify=function(...args){checked++;return original.apply(this,args);};
  let status;try{status=await f.service.guideSolve({action:'status',request_id:call(p,'refresh').request_id});}finally{GuidedModelArtifacts.prototype.verify=original;}
  assert.equal(checked,0);assert.equal(status.modeling.status,'not_checked');assert.equal(status.modeling.integrity,'not_checked');assert.equal(status.modeling.markdown,undefined);assert.match(status.modeling.note,/未重新核对/);
 });
 await t.test('space and reserved characters in supported storage roots produce three usable destinations',async t=>{
  const f=fixture(t,{spacedRoot:true});const p=await f.service.guideSolve({action:'model',qubo,problem_summary:'文件链接'});
  const destinations=p.modeling.files_markdown.split('\n').map(line=>line.match(/^- \[[^\]]+\]\(<([^<>]+)>\)$/)?.[1]);
  assert.equal(destinations.length,3);assert.ok(destinations.every(Boolean),'use valid angle-bracket Markdown destinations');
  for(let i=0;i<3;i++){assert.equal(decodeURIComponent(destinations[i]),p.modeling.files[i].path);assert.ok(fs.existsSync(p.modeling.files[i].path));}
 });
});

test('ordinary facade has one solve presentation source while preserving model, controls, candidates and history',async t=>{
 const f=fixture(t);const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'唯一求解摘要',model_markdown:doc});
 assert.equal(p.summary,undefined,'do not return a duplicate solve summary beside reply');assert.match(p.reply,/模型设备/);assert.match(p.reply,/规模上限/);assert.ok(p.modeling.markdown);assert.ok(p.actions.length);
 const submitted=await f.service.guideSolve(call(p,'confirm')),result=await f.service.guideSolve(call(submitted,'status'));
 assert.equal(result.summary,undefined);assert.deepEqual(result.result.bits,[0,1]);assert.equal(result.result.objective,1);assert.ok(result.task.target.name);
 const history=await f.service.guideSolve({action:'history'});assert.equal(history.records[0].summary,undefined);assert.ok(history.records[0].task.task_number);
});

test('model-only artifact view failures and restoration never enter target discovery without explicit prepare',async t=>{
 const f=fixture(t);const list=f.service.listTargets,profiles=f.service.profileList;
 f.service.listTargets=()=>{throw Error('MODEL_VIEW_MUST_NOT_DISCOVER');};f.service.profileList=()=>{throw Error('MODEL_VIEW_MUST_NOT_READ_TARGETS');};
 const m=await f.service.guideSolve({action:'model',qubo,problem_summary:'只建模恢复',model_markdown:doc});
 const file=paths(m)['model.md'],original=fs.readFileSync(file);fs.appendFileSync(file,'\nchanged');
 const id=call(m,'prepare').request_id;
 const changed=await f.service.guideSolve({action:'status',request_id:id});assert.equal(changed.ready,false);assert.equal(changed.modeling.status,'unavailable');
 fs.writeFileSync(file,original);const restored=await f.service.guideSolve(call(changed,'refresh'));
 assert.equal(restored.status,'modeled');assert.equal(restored.modeling.status,'exported');assert.equal(f.state.probes,0);assert.equal(f.state.submits,0);
 f.service.listTargets=list;f.service.profileList=profiles;
 const prepared=await f.service.guideSolve(call(restored,'prepare'));assert.equal(prepared.ready,true);assert.ok(f.state.probes>0);assert.equal(f.state.submits,0);
});

test('ready has four business operations and management supplies the explicit recheck continuation',async t=>{
 const f=fixture(t);f.service.openTargetConfig=async()=>({url:'http://127.0.0.1:1234/config'});
 const p=await f.service.guideSolve({action:'prepare',qubo,problem_summary:'四个业务操作'});
 assert.deepEqual(p.actions.map(x=>x.call.arguments.action),['confirm','choose','manage','cancel']);assert.equal(p.targets,undefined);
 const choices=await f.service.guideSolve(call(p,'choose'));assert.equal(choices.status,'needs_target');assert.equal(choices.ready,false);assert.ok(choices.targets.length);
 const ready=await f.service.guideSolve(choices.targets[0].call.arguments);assert.equal(ready.ready,true);assert.equal(ready.actions.length,4);assert.equal(ready.targets,undefined);
 const managed=await f.service.guideSolve(call(ready,'manage'));const follow=managed.actions.find(x=>x.call.arguments.action==='refresh');
 assert.ok(follow);assert.equal(follow.label,'配置完成，继续检查');assert.ok(!managed.actions.some(x=>x.call.arguments.action==='confirm'));
 const resumed=await f.service.guideSolve(follow.call.arguments);assert.equal(resumed.ready,true);assert.equal(resumed.actions.length,4);assert.equal(f.state.submits,0);
});
