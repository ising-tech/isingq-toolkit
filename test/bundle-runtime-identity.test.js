'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {buildSync}=require('esbuild');
const {bundleOptions}=require('../scripts/bundle-options');
const {runtimeIdentity}=require('../packages/core/src/runtime-identity');
test('the official single-file bundle serves without a source tree and reports its bound original runtime identity',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'isingq-bundle-identity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bundle=path.join(root,'isolated','isingq.bundle.cjs');fs.mkdirSync(path.dirname(bundle));
  buildSync(bundleOptions(bundle));
  const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'isingq_modeling_guide_get',arguments:{problem_summary:'bundle identity'}}}];
  const reply=spawnSync(process.execPath,[bundle,'serve'],{cwd:root,env:{PATH:process.env.PATH,HOME:root,ISINGQ_UPDATE_CHECK:'off'},input:requests.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:10000});
  assert.equal(reply.status,0,reply.stderr);assert.equal(reply.stderr,'');
  const packets=reply.stdout.trim().split('\n').map(JSON.parse);assert.equal(packets.find(x=>x.id===2).result.tools.length,4);
  const expected=runtimeIdentity(path.resolve(__dirname,'..')),actual=packets.find(x=>x.id===3).result.structuredContent.runtime_identity;
  assert.equal(actual.artifact_sha256,expected.artifact_sha256);assert.equal(actual.artifact_digest_version,expected.artifact_digest_version);
  assert.equal(actual.package_version,require('../package.json').version);assert.equal(fs.existsSync(path.join(root,'package.json')),false);
});
