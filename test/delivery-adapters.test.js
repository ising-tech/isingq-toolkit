'use strict';
// Keep optional release metadata out of unrelated behavior fixtures.
process.env.ISINGQ_UPDATE_CHECK = 'off';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
test('default MCP and DSH discovery/delivery stay offline without constructing a solver; old branches remain lazy and cached', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-delivery-adapters-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const program = `
    process.env.ISINGQ_UPDATE_CHECK='off';
    const assert=require('node:assert/strict');
    const core=require(${JSON.stringify(path.join(root, 'packages/core'))});
    let constructions=0;
    core.SolverService=class{constructor(){constructions++}validate(q){return {legacy:q}}start(q){return {started:q}}poll(id){return {polled:id}}get(id){return {got:id}}};
    require('node:child_process').spawnSync=()=>{throw Error('SPAWN_FORBIDDEN')};
    require(${JSON.stringify(require.resolve('undici'))}).fetch=()=>{throw Error('NETWORK_FORBIDDEN')};
    for(const name of ['node:http','node:https']){const m=require(name);m.request=m.get=()=>{throw Error('NETWORK_FORBIDDEN')}}
    (async()=>{
      const {createHandler}=require(${JSON.stringify(path.join(root, 'src/server'))});
      const handle=createHandler();
      await handle({method:'initialize'});await handle({method:'tools/list'});
      const document={qubo:{num_bits:1,offset:2},candidate_bits:[1],business_solution:{anything:true}};
      const result=await handle({method:'tools/call',params:{name:'isingq_delivery_validate',arguments:{document}}});
      assert.deepEqual(result.structuredContent.data,core.validateDelivery(document));
      assert.equal(constructions,0);
      const dsh=await import(${JSON.stringify(require('node:url').pathToFileURL(path.join(root, 'packages/dsh-plugin/index.mjs')).href)});
      const tools=[];dsh.apply({tools:{register(t){tools.push(t)}}});
      const delivery=tools.find(t=>t.name==='isingq_delivery_validate');
      assert.deepEqual(await delivery.execute({document}),core.validateDelivery(document));
      let expected;try{core.validateDelivery({qubo:{num_bits:1},claimed_summary:{unknown:true}})}catch(e){expected=e}
      await assert.rejects(()=>delivery.execute({document:{qubo:{num_bits:1},claimed_summary:{unknown:true}}}),e=>e.code===expected.code&&e.message===expected.message);
      await assert.rejects(()=>delivery.execute({document,claimed_summary:{total:99}}),e=>e.code==='delivery_unknown_field');
      assert.equal(constructions,0);
      const request=(name,args)=>handle({method:'tools/call',params:{name,arguments:args}});
      assert.deepEqual((await request('isingq_qubo_validate',{qubo:{num_bits:1}})).structuredContent.data,{legacy:{num_bits:1}});
      assert.equal(constructions,1);
      assert.deepEqual((await request('isingq_solve_start',{qubo:{num_bits:1},model_summary:'unchanged',idempotency_key:'same'})).structuredContent.data.started,{qubo:{num_bits:1},model_summary:'unchanged',idempotency_key:'same'});
      assert.deepEqual((await request('isingq_solve_poll',{solve_id:'test'})).structuredContent.data,{polled:'test'});
      assert.deepEqual((await request('isingq_solve_result_get',{solve_id:'test'})).structuredContent.data,{got:'test'});
      assert.equal(constructions,1);
      process.stdout.write('offline adapters verified');
    })().catch(e=>{process.stderr.write(e.stack);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', program], { env: { HOME: home }, cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'offline adapters verified');
  assert.deepEqual(fs.readdirSync(home), [], 'new local branches must not create a solve store or credential state');
});

test('MCP and native DSH preserve precise delivery and missing-record diagnostics', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-tool-diagnostics-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const program = `
    const assert=require('node:assert/strict');
    const fs=require('node:fs');
    const core=require(${JSON.stringify(path.join(root, 'packages/core'))});
    const {roots}=require(${JSON.stringify(path.join(root, 'src/store'))});
    require(${JSON.stringify(require.resolve('undici'))}).fetch=()=>{throw Error('NETWORK_FORBIDDEN')};
    (async()=>{
      const {createHandler}=require(${JSON.stringify(path.join(root, 'src/server'))});
      const handle=createHandler();
      const call=(name,args)=>handle({method:'tools/call',params:{name,arguments:args}});
      const plugin=await import(${JSON.stringify(require('node:url').pathToFileURL(path.join(root, 'packages/dsh-plugin/index.mjs')).href)});
      const tools=[];plugin.apply({tools:{register(tool){tools.push(tool)}}});
      const native=name=>tools.find(tool=>tool.name===name);
      const guide=await native('isingq_modeling_guide_get').execute({});
      assert.match(guide.required_sequence.find(step=>step.includes('isingq_qubo_validate')),/校验不保存求解记录/);
      const document={qubo:{num_bits:2,linear:[{index:0,coefficient:0.1},{index:1,coefficient:0.2}]},candidate_bits:[1,1],claimed_objective_value:0.3};
      const failed=await call('isingq_delivery_validate',{document});
      assert.equal(failed.isError,true);
      assert.equal(failed.structuredContent.error.code,'delivery_claim_mismatch');
      assert.equal(failed.structuredContent.data,undefined);
      assert.match(failed.structuredContent.error.message,/claimed=0.3, computed=0.30000000000000004/);
      await assert.rejects(()=>native('isingq_delivery_validate').execute({document}),error=>error.message===failed.structuredContent.error.message);
      const withoutClaim={qubo:document.qubo,candidate_bits:document.candidate_bits};
      const accepted=await native('isingq_delivery_validate').execute({document:withoutClaim});
      assert.equal(accepted.summary.candidate_objective_value,0.30000000000000004);
      for(const name of ['isingq_solve_result_get','isingq_solve_poll']){
        const args={solve_id:'solve_'+'0'.repeat(32)};
        const response=await call(name,args);
        assert.equal(response.structuredContent.error.code,'solve_record_not_found');
        assert.equal(response.isError,true);
        assert(!response.structuredContent.error.message.includes(${JSON.stringify(home)}));
        await assert.rejects(()=>native(name).execute(args),error=>error.code==='solve_record_not_found'&&error.message===response.structuredContent.error.message);
      }
      assert.deepEqual(fs.readdirSync(require('node:path').join(roots().data,'runs')),[]);
      assert.equal(fs.existsSync(require('node:path').join(roots().config,'api-key')),false);
      process.stdout.write('diagnostics verified');
    })().catch(error=>{process.stderr.write(error.stack);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', program], {
    env: { XDG_DATA_HOME: home, XDG_CONFIG_HOME: home, ISINGQ_UPDATE_CHECK: 'off' },
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'diagnostics verified');
});
