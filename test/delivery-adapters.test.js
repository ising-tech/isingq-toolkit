'use strict';
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
