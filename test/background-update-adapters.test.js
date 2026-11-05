'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHandler } = require('../src/server');
const notice = { current_version:'0.8.0',latest_version:'0.9.0',text:'Fixture update notice',requires_response:false };
const request = {method:'tools/call',params:{name:'isingq_modeling_guide_get',arguments:{problem_summary:'local task'}}};

test('ordinary MCP result exposes only a completed actionable notice, without invoking manual check',async()=>{
  let reads=0;
  const handle=createHandler(undefined,{backgroundUpdates:{takeNotice(){return reads++===0?notice:null;},start(){throw Error('must not launch checks inside business tool');}}});
  const first=await handle(request);assert.equal(first.structuredContent.ok,true);assert.deepEqual(first.structuredContent.update_notice,notice);
  const next=await handle(request);assert.equal(next.structuredContent.ok,true);assert.equal(Object.hasOwn(next.structuredContent,'update_notice'),false);
  assert.equal(next.structuredContent.data.problem_summary,'local task');
});

test('missing and failed optional notifications leave the business payload untouched',async()=>{
  const plain=await createHandler()(request);
  for(const takeNotice of [()=>null,()=>{throw Error('cache unavailable');}]) {
    const actual=await createHandler(undefined,{backgroundUpdates:{takeNotice}})(request);
    assert.deepEqual(actual,plain);
  }
});

test('native DSH starts background work once but does not await it', {timeout:1000},async()=>{
  const plugin=await import(pathToFileURL(path.resolve(__dirname,'../packages/dsh-plugin/index.mjs')));
  let starts=0, reads=0;const tools=[];
  plugin.apply({tools:{register:x=>tools.push(x)}},{backgroundUpdates:{start(){starts++;return new Promise(()=>{});},takeNotice(){return reads++===0?notice:null;}}});
  const guide=tools.find(x=>x.name==='isingq_modeling_guide_get');
  const first=await guide.execute({problem_summary:'local task'});assert.deepEqual(first.update_notice,notice);
  assert.equal(Object.hasOwn(await guide.execute({problem_summary:'next task'}),'update_notice'),false);assert.equal(starts,1);
});
