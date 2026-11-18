'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const core=require('../packages/core');
const {SolveStore}=require('../packages/core/src/store');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'math-format-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const environment={XDG_DATA_HOME:path.join(dir,'data'),XDG_CONFIG_HOME:path.join(dir,'config')};const service=new core.SolverService({store:new SolveStore(environment),targetOptions:{environment}});service.profileList=()=>{throw Error('MATH_MODEL_MUST_NOT_READ_TARGETS');};return service;}
const files=p=>Object.fromEntries(p.modeling.files.map(file=>[path.basename(file.path),file.path]));
const section=p=>p.modeling.markdown.split('## QUBO数学表达\n')[1].split('## 变量映射')[0];
test('new numeric QUBO math uses display LaTeX with exact signs, scientific notation and braced multi-digit indices',async t=>{
 const service=fixture(t),qubo={num_bits:12,offset:-2.5e-7,linear:[{index:0,coefficient:1},{index:1,coefficient:-1},{index:2,coefficient:0},{index:10,coefficient:2.5},{index:11,coefficient:1e-7}],quadratic:[{i:1,j:10,coefficient:-1},{i:2,j:11,coefficient:-3.25e21}]};
 const prose='目标原文 max Σ_(i,j) w_ij 保留，不猜写。\n已有公式 $x_{10}$ 与 $$\\sum_i x_i$$ 也原样保留。';
 const p=await service.guideSolve({action:'model',qubo,problem_summary:'数学格式',model_markdown:prose});
 assert.equal(p.modeling.math_format,'latex');assert.ok(p.modeling.markdown.includes(prose));
 const math=section(p);assert.match(math,/\$\$\n\\begin\{aligned\}/);assert.match(math,/\\end\{aligned\}\n\$\$/);assert.doesNotMatch(math,/```|Σ_|x_10|\d[eE][+-]?\d/);
 assert.match(math,/x_\{10\}/);assert.match(math,/x_\{11\}/);assert.match(math,/- 2\.5 \\times 10\^\{-7\}/);assert.match(math,/10\^\{-7\} x_\{11\}/);assert.match(math,/- x_\{1\}/);assert.match(math,/- 3\.25 \\times 10\^\{21\}/);assert.doesNotMatch(math,/\+\s*-|1 x_\{0\}|0 x_\{2\}/);
 const out=files(p);assert.deepEqual(fs.readFileSync(out['matrix.csv']),core.matrixDocument(qubo).content);assert.equal(fs.readFileSync(out['qubo.json'],'utf8'),JSON.stringify(core.validateQubo(qubo).qubo));assert.equal(fs.readFileSync(out['model.md'],'utf8'),p.modeling.markdown);
});
test('zero, unit constants and round-trip decimal extremes render as values without changing source artifacts',async t=>{
 const service=fixture(t);
 for(const value of [0,-0,1,-1,1e-7,-1e-7,Number.MIN_VALUE,Number.MAX_VALUE]){
  const qubo={num_bits:1,offset:value,linear:[],quadratic:[]};const p=await service.guideSolve({action:'model',qubo,problem_summary:'常量表达'});
  assert.equal(p.modeling.math_format,'latex');assert.match(section(p),/f\(x\) &=[\s\S]*x_\{i\}/);assert.doesNotMatch(section(p),/```|\d[eE][+-]?\d/);
  const line=section(p).split('\n').find(x=>x.startsWith('f(x) &='));
  let numeric=line.slice('f(x) &='.length).replace(/\\\\\s*$/,'').trim(),sign=1;
  if(numeric.startsWith('- ')){sign=-1;numeric=numeric.slice(2);}
  const scientific=numeric.match(/^(?:(\d+(?:\.\d+)?) \\times )?10\^\{(-?\d+)\}$/);
  const decoded=sign*(scientific?Number((scientific[1] || '1')+'e'+scientific[2]):Number(numeric));
  assert.equal(decoded,value===0?0:value,'displayed constant must round-trip to the original numeric value');
  const actual=JSON.parse(fs.readFileSync(files(p)['qubo.json'],'utf8'));assert.equal(JSON.stringify(actual.offset),JSON.stringify(value));assert.deepEqual(fs.readFileSync(files(p)['matrix.csv']),core.matrixDocument(qubo).content);
 }
});
test('large QUBO uses exact LaTeX sums with bounded text and source QUBO/CSV bytes stay unchanged',async t=>{
 const service=fixture(t),qubo={num_bits:50,offset:0,linear:Array.from({length:50},(_,index)=>({index,coefficient:index-25})),quadratic:[]};
 const p=await service.guideSolve({action:'model',qubo,problem_summary:'大模型表达'});assert.match(section(p),/\\sum_\{\(i,a\)\\in \\mathcal\{L\}\}/);assert.match(section(p),/\\sum_\{\(i,j,b\)\\in \\mathcal\{Q\}\}/);assert.ok(section(p).length<2000);assert.doesNotMatch(section(p),/```/);
 assert.deepEqual(fs.readFileSync(files(p)['matrix.csv']),core.matrixDocument(qubo).content);assert.equal(fs.readFileSync(files(p)['qubo.json'],'utf8'),JSON.stringify(core.validateQubo(qubo).qubo));
});
test('legacy manifest, pretty QUBO and text artifact remain byte-identical and are not silently reformatted',async t=>{
 const service=fixture(t),qubo={num_bits:1,linear:[{index:0,coefficient:-1}]};const p=await service.guideSolve({action:'model',qubo,problem_summary:'旧产物'}),id=p.actions.find(x=>x.call.arguments.request_id).call.arguments.request_id;
 const planFile=path.join(service.store.directory,'.guided',id+'.json'),plan=JSON.parse(fs.readFileSync(planFile));
 const legacy='## QUBO数学表达\n\n```text\nf(x) = 0 + (-1) x_0\nx_i ∈ {0,1}\n```\n';
 const oldFiles = { 'model.md': legacy, 'qubo.json': JSON.stringify(plan.qubo,null,2)+'\n' }, out = files(p);
 for (const [name, content] of Object.entries(oldFiles)) {
  fs.writeFileSync(out[name], content);
  const entry = plan.artifacts.files.find(file => path.basename(file.relative_path) === name);
  entry.sha256 = crypto.createHash('sha256').update(content).digest('hex');
  entry.size_bytes = Buffer.byteLength(content);
 }
 delete plan.artifacts.math_format;plan.artifacts.markdown=legacy;fs.writeFileSync(planFile,JSON.stringify(plan));
 const refreshed=await service.guideSolve({action:'refresh',request_id:id});assert.equal(refreshed.modeling.math_format,'legacy_text');assert.equal(refreshed.modeling.markdown,legacy);
 for (const [name, content] of Object.entries(oldFiles)) assert.equal(fs.readFileSync(out[name], 'utf8'), content);
});

test('a prior export that predates the saved manifest verifies its exact pretty-printed QUBO', async t => {
 const service=fixture(t), model=await service.guideSolve({action:'model',qubo:{num_bits:1},problem_summary:'未保存旧产物索引'});
 const id=model.actions.find(item=>item.call.arguments.request_id).call.arguments.request_id;
 const planFile=path.join(service.store.directory,'.guided',id+'.json'),plan=JSON.parse(fs.readFileSync(planFile));
 const quboFile=files(model)['qubo.json'], prior=JSON.stringify(plan.qubo,null,2)+'\n';
 fs.writeFileSync(quboFile,prior);delete plan.artifacts;fs.writeFileSync(planFile,JSON.stringify(plan));
 const refreshed=await service.guideSolve({action:'refresh',request_id:id});
 assert.equal(refreshed.modeling.integrity,'current_verified');
 assert.equal(fs.readFileSync(quboFile,'utf8'),prior);
});


test('normal model schema and guide ask for real LaTeX math while files-only exposes only the bound format marker',async t=>{
 const {createHandler}=require('../src/server'),handle=createHandler({});
 const tools=(await handle({method:'tools/list'})).tools,desc=tools.find(x=>x.name==='isingq_solve').inputSchema.properties.model_markdown.description;
 assert.ok(desc.includes('$...$'));assert.ok(desc.includes('$$...$$'));assert.ok(desc.includes(String.raw`\sum`));assert.ok(!desc.includes(String.raw`\\sum`));
 const guide=(await handle({method:'tools/call',params:{name:'isingq_modeling_guide_get',arguments:{}}})).structuredContent.data;
 assert.match(guide.steps.join(' '),/LaTeX/);
 const service=fixture(t),p=await service.guideSolve({action:'model',qubo:{num_bits:1},problem_summary:'格式标记'}),id=p.actions.find(x=>x.call.arguments.request_id).call.arguments.request_id;
 const status=await service.guideSolve({action:'status',request_id:id});assert.equal(status.modeling.math_format,'latex');assert.equal(status.modeling.markdown,undefined);
});
