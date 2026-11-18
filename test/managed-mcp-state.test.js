'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const state=require('../packages/core/src/managed-mcp-state');
const {spawn,spawnSync}=require('node:child_process');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'managed-mcp-state-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const environment={ISINGQ_RUNTIME_DIR:root,ISINGQ_MANAGED_MCP_ID:'fixture',ISINGQ_MANAGED_MCP_TOKEN:'a'.repeat(64)};
  return {root,environment,files:state.locations(root,'fixture')};
}
const call={method:'tools/call',params:{name:'isingq_solve',arguments:{action:'model'}}};
test('unmanaged MCP remains unaffected and creates no lifecycle files',t=>{
  const f=fixture(t);assert.equal(state.serverControl({ISINGQ_RUNTIME_DIR:f.root}),null);assert.deepEqual(fs.readdirSync(f.root),[]);
});
test('handoff blocks new business calls but preserves the active call and allows identity lookup',t=>{
  const f=fixture(t),control=state.serverControl(f.environment);t.after(()=>control.close());
  const release=control.begin(call);assert.equal(state.read(f.files.live).busy,1);
  state.write(f.files.handoff,{schema:state.SCHEMA,connection_id:'fixture',token:f.environment.ISINGQ_MANAGED_MCP_TOKEN,expires_at:Date.now()+10000});
  assert.throws(()=>control.begin(call),e=>e.code===-32001);assert.equal(state.read(f.files.live).busy,1);
  const metadata=control.begin({method:'tools/call',params:{name:'isingq_modeling_guide_get'}});metadata();
  release();release();assert.equal(state.read(f.files.live).busy,0);
});
test('the old server cannot remove the new server activity record, and expired handoffs do not hold it',t=>{
  const f=fixture(t),old=state.serverControl(f.environment);t.after(()=>old.close());
  const next=state.serverControl({...f.environment,ISINGQ_MANAGED_MCP_TOKEN:'b'.repeat(64)});t.after(()=>next.close());
  assert.throws(()=>old.begin(call),e=>e.code===-32001);
  old.close();assert.equal(state.read(f.files.live).token,'b'.repeat(64));
  state.write(f.files.handoff,{schema:state.SCHEMA,connection_id:'fixture',token:'b'.repeat(64),expires_at:0});
  const release=next.begin(call);assert.equal(state.read(f.files.live).busy,1);release();
  next.close();assert.equal(fs.existsSync(f.files.live),false);
});

test('a busy owner cannot be replaced and dead known locks recover without removing a live lock',t=>{
  const f=fixture(t),control=state.serverControl(f.environment);t.after(()=>control.close());
  const finish=control.begin(call),before=fs.readFileSync(f.files.live);
  assert.throws(()=>state.serverControl({...f.environment,ISINGQ_MANAGED_MCP_TOKEN:'b'.repeat(64)}),/busy/);
  assert.deepEqual(fs.readFileSync(f.files.live),before);finish();
  const departed=spawnSync(process.execPath,['-e',''],{encoding:'utf8'});assert.equal(departed.status,0);assert.equal(state.alive(departed.pid),false);
  const file=path.join(f.root,'owned.lock');fs.writeFileSync(file,JSON.stringify({pid:departed.pid,token:'a'.repeat(24)}));
  const release=state.acquire(file,{timeoutMs:100});const current=fs.readFileSync(file);
  assert.throws(()=>state.acquire(file,{timeoutMs:0}),e=>e.code==='managed_state_busy');assert.deepEqual(fs.readFileSync(file),current);
  release();assert.equal(fs.existsSync(file),false);
});

test('startup ownership and a concurrent business begin share the same atomic boundary',async t=>{
  const f=fixture(t),old=state.serverControl(f.environment);t.after(()=>old.close());
  const marker=path.join(f.root,'claim-started'),modulePath=require.resolve('../packages/core/src/managed-mcp-state');
  const source=`const fs=require('node:fs');const read=fs.readSync;let delayed=false;fs.readSync=function(fd,...args){const n=read.call(this,fd,...args);if(!delayed){delayed=true;fs.writeFileSync(${JSON.stringify(marker)},'claim');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);}return n};const s=require(${JSON.stringify(modulePath)}).serverControl(${JSON.stringify({...f.environment,ISINGQ_MANAGED_MCP_TOKEN:'b'.repeat(64)})});setTimeout(()=>s.close(),1000);`;
  const child=spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>{errors+=d});t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});
  const end=Date.now()+3000;while(!fs.existsSync(marker)){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5))}
  assert.throws(()=>old.begin(call),e=>e.code===-32001);
  assert.equal(state.read(f.files.live).token,'b'.repeat(64));assert.equal(state.read(f.files.live).busy,0);
  await new Promise(resolve=>child.once('close',resolve));assert.equal(errors,'');
});
test('invalid activity state is preserved instead of being overwritten',t=>{
  const f=fixture(t);state.write(f.files.live,{schema:'unknown',pid:process.pid,busy:0});const before=fs.readFileSync(f.files.live);
  assert.throws(()=>state.serverControl(f.environment),/invalid managed/);assert.deepEqual(fs.readFileSync(f.files.live),before);
});

test('same-generation clients coexist and every active call prevents a generation change',t=>{
  const f=fixture(t),a=state.serverControl(f.environment),b=state.serverControl(f.environment);t.after(()=>a.close());t.after(()=>b.close());
  const doneA=a.begin(call),doneB=b.begin(call);assert.equal(state.activity(f.files.live,'fixture').instances.length,2);assert.equal(state.read(f.files.live).busy,2);
  assert.equal(a.close(),false);doneA();assert.equal(a.close(),true);assert.equal(state.read(f.files.live).busy,1);
  assert.throws(()=>state.serverControl({...f.environment,ISINGQ_MANAGED_MCP_TOKEN:'b'.repeat(64)}),/busy/);
  doneB();assert.equal(b.close(),true);assert.equal(fs.existsSync(f.files.live),false);
});

test('a late old client cannot reclaim activity after the desired generation changes',t=>{
  const f=fixture(t),nextEnv={...f.environment,ISINGQ_MANAGED_MCP_TOKEN:'b'.repeat(64),ISINGQ_MANAGED_MCP_REQUIRE_RECORD:'1'};
  state.write(f.files.record,{schema:state.MAINTENANCE_SCHEMA,connection_id:'fixture',token:nextEnv.ISINGQ_MANAGED_MCP_TOKEN});
  const next=state.serverControl(nextEnv);t.after(()=>next.close());
  const late=state.serverControl({...f.environment,ISINGQ_MANAGED_MCP_REQUIRE_RECORD:'1'});t.after(()=>late.close());
  assert.equal(state.activity(f.files.live,'fixture').token,nextEnv.ISINGQ_MANAGED_MCP_TOKEN);
  assert.throws(()=>late.begin(call),e=>e.code===-32001);
  const finish=next.begin(call);finish();
});

test('completion waits for a transient activity lock and concurrent completion retries decrement only once',async t=>{
  const f=fixture(t),control=state.serverControl(f.environment);t.after(()=>control.close());
  const finish=control.begin(call),unlock=state.acquire(f.files.activity);
  const timer=setTimeout(unlock,1200);t.after(()=>{clearTimeout(timer);unlock()});
  const first=Promise.resolve().then(finish),second=Promise.resolve().then(finish);
  await Promise.all([first,second]);
  assert.equal(state.activity(f.files.live,'fixture').busy,0);
  assert.equal(control.close(),true);assert.equal(fs.existsSync(f.files.live),false);
});
