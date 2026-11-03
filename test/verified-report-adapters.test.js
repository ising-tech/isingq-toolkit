'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { TOOL_DEFINITIONS } = require('../packages/core');
const { createHandler } = require('../src/server');

test('MCP advertises a strict local verified report document contract', async () => {
  const handle = createHandler(new Proxy({}, { get() { throw Error('SOLVER_FORBIDDEN'); } }));
  const tools = (await handle({ method: 'tools/list' })).tools;
  const definition = tools.find(tool => tool.name === 'isingq_report_verify');
  assert.ok(definition, 'local report verification must be discoverable');
  assert.equal(TOOL_DEFINITIONS.some(tool => tool.name === definition.name), true);
  assert.deepEqual(definition.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(definition.inputSchema.additionalProperties, false);
  const document = definition.inputSchema.properties.document;
  assert.deepEqual(document.required, ['report_contract_version', 'model', 'data', 'candidates']);
  assert.equal(document.additionalProperties, false);
  assert.deepEqual(Object.keys(document.properties).sort(), ['report_contract_version', 'model', 'data', 'candidates', 'baseline', 'top_k'].sort());
  assert.equal(document.properties.candidates.items.additionalProperties, false);
});

test('MCP and DSH report adapters reuse core data and typed errors offline without constructing SolverService', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-report-adapters-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const program = `
    const assert=require('node:assert/strict');
    const core=require(${JSON.stringify(path.join(root, 'packages/core'))});
    const fs=require('node:fs');
    const {createRequire}=require('node:module');
    const dshRequire=createRequire(${JSON.stringify(path.join(root, 'packages/dsh-plugin/index.mjs'))});
    assert.equal(fs.realpathSync(dshRequire.resolve('@ising-tech/isingq-core')),fs.realpathSync(${JSON.stringify(path.join(root, 'packages/core/src/index.js'))}),'DSH must load the isolated core under test');
    core.SolverService=class{constructor(){throw Error('SOLVER_FORBIDDEN')}};
    core.configureApiKeyAsync=()=>{throw Error('CREDENTIAL_FORBIDDEN')};
    require('node:child_process').spawnSync=()=>{throw Error('SPAWN_FORBIDDEN')};
    global.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};
    for(const p of ['node:http','node:https']){const m=require(p);m.request=m.get=()=>{throw Error('NETWORK_FORBIDDEN')}}
    (async()=>{
      const handle=require(${JSON.stringify(path.join(root, 'src/server'))}).createHandler(undefined,{configureApiKey(){throw Error('CREDENTIAL_FORBIDDEN')}});
      const tools=[];
      const dsh=await import(${JSON.stringify(require('node:url').pathToFileURL(path.join(root, 'packages/dsh-plugin/index.mjs')).href)});
      dsh.apply({tools:{register(tool){tools.push(tool)}}});
      assert.ok(tools.every(tool=>typeof tool.execute==='function'),'shared discovery must have matching executable adapters');
      const report=tools.find(tool=>tool.name==='isingq_report_verify');
      const document={report_contract_version:'isingq-verified-report-v1',model:{schema_version:'math-model-v1',id:'demo',variables:[{id:'x',domain:'binary'}],objective:{sense:'min',expression:{terms:[{coefficient:1,variables:['x']}]}},constraints:[]},data:{},candidates:[{id:'a',assignment:{x:0}}]};
      const call=args=>handle({method:'tools/call',params:{name:'isingq_report_verify',arguments:args}});
      assert.deepEqual((await call({document})).structuredContent.data,core.buildVerifiedReport(document));
      assert.deepEqual(await report.execute({document}),core.buildVerifiedReport(document));
      for(const invalid of [{...document,extra:true},{...document,candidates:[{id:'a',assignment:{x:true}}]},{...document,evidence_ref:'/must-not-read-evidence'}]){
        let expected;try{core.buildVerifiedReport(invalid)}catch(e){expected=e}
        const result=await call({document:invalid});
        assert.equal(result.isError,true);assert.deepEqual(result.structuredContent.error,{code:expected.code,message:expected.message});
        assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
        await assert.rejects(()=>report.execute({document:invalid}),e=>e.code===expected.code&&e.message===expected.message);
      }
      for(const args of [{document,extra:true},[],false]){
        assert.equal((await call(args)).structuredContent.ok,false);
        await assert.rejects(()=>report.execute(args));
        if(!Array.isArray(args)&&args&&typeof args==='object')await assert.rejects(()=>report.execute(args),e=>e instanceof core.VerifiedReportError);
      }
      const instructions=(await handle({method:'initialize'})).instructions;
      for(const pattern of [/isingq_report_verify/,/input_digests/,/report_markdown/,/provided_candidates/,/待核验/])assert.match(instructions,pattern);
      process.stdout.write('offline reports verified');
    })().catch(e=>{process.stderr.write(e.stack);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', program], { env: { HOME: home }, cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'offline reports verified');
  assert.deepEqual(fs.readdirSync(home), [], 'report must not create credential state or solve storage');
});

test('MCP and DSH hide unexpected report failures rather than exposing private runtime details', async () => {
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..');
  const program = `
    const assert=require('node:assert/strict');
    const core=require(${JSON.stringify(path.join(root, 'packages/core'))});
    core.buildVerifiedReport=()=>{throw Error('private-runtime-internal-must-not-appear')};
    (async()=>{
      const handle=require(${JSON.stringify(path.join(root, 'src/server'))}).createHandler();
      const result=(await handle({method:'tools/call',params:{name:'isingq_report_verify',arguments:{document:{}}}})).structuredContent;
      assert.equal(result.error.code,'report_failed');assert.doesNotMatch(JSON.stringify(result),/private-runtime-internal-must-not-appear/);
      const tools=[];const dsh=await import(${JSON.stringify(require('node:url').pathToFileURL(path.join(root, 'packages/dsh-plugin/index.mjs')).href)});
      dsh.apply({tools:{register(tool){tools.push(tool)}}});
      await assert.rejects(()=>tools.find(tool=>tool.name==='isingq_report_verify').execute({document:{}}),e=>e.code==='report_failed'&&e.message===result.error.message);
    })().catch(e=>{process.stderr.write(e.stack);process.exitCode=1});
  `;
  const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('LobeHub static report capability matches the live MCP definition', () => {
  const { TOOLS } = require('../src/server');
  const manifest = require('../lhm.plugin.json');
  assert.deepEqual(manifest.tools.find(tool => tool.name === 'isingq_report_verify'), TOOLS.find(tool => tool.name === 'isingq_report_verify'));
});
