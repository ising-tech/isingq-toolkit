'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { SolverService, validateQubo, verifyMathModelFile, writeMathModelReviewFile, buildVerifiedReport, verificationCapacityBasis, verificationCapacity } = require('../packages/core');
const { SolveStore } = require('../packages/core/src/store');
const { ReviewChecksWriter, CHUNK_BYTES } = require('../packages/core/src/review-file-io');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-file-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = { XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config') };
  const store = new SolveStore(environment), calls = { network: 0 };
  const forbidden = () => { calls.network++; throw Error('NETWORK_FORBIDDEN'); };
  const service = new SolverService({ store, transport: { submit: forbidden, poll: forbidden },
    targetOptions: { environment, localTransportFactory: forbidden, catalogClientFactory: forbidden } });
  const qubo = { num_bits: 2, offset: 4, linear: [{ index: 0, coefficient: -7 }, { index: 1, coefficient: -6 }], quadratic: [{ i: 0, j: 1, coefficient: 8 }] };
  const run = { solve_id: 'solve_0123456789abcdef0123456789abcdef', idempotency_digest: 'a'.repeat(64), request_digest: 'b'.repeat(64),
    status: 'succeeded', execution_mode: 'simulation', target: { kind: 'local', name: '隔离记录' }, qubo,
    result: { bits: [1, 0], objective_value: -3 } };
  store.save(run);
  const terms = [{ coefficient: 3, variables: ['x_0'] }, { coefficient: 2, variables: ['x_1'] }].map(term => JSON.stringify(term) + '\n').join('');
  fs.writeFileSync(path.join(root, 'objective.jsonl'), terms);
  const manifest = { schema_version: 'isingq-review-file-v1', qubo_model_sha256: validateQubo(qubo).summary.model_sha256,
    model: { schema_version: 'math-model-v1', id: 'project', label: '项目收益', variables: [{ id: 'x_0', domain: 'binary' }, { id: 'x_1', domain: 'binary' }],
      objective: { sense: 'max', expression: { terms_file: { path: 'objective.jsonl', sha256: sha(terms) } } },
      constraints: [{ id: 'one', expression: { terms: [{ coefficient: 1, variables: ['x_0'] }, { coefficient: 1, variables: ['x_1'] }] }, relation: 'eq', rhs: 1 }] },
    data: {}, baseline: { x_0: 0, x_1: 1 } };
  const write = () => { const content = JSON.stringify(manifest) + '\n'; const manifest_path = path.join(root, 'review.json'); fs.writeFileSync(manifest_path, content); return { manifest_path, content_digest: sha(content) }; };
  const before = fs.readFileSync(store.path(run.solve_id));
  return { root, service, store, manifest, write, run, calls, before, environment };
}

test('ordinary MCP reviews a file-backed original model without another solve or rewriting the saved result', async t => {
  const f = fixture(t);
  const result = await f.service.guideSolve({ action: 'review', solve_id: f.run.solve_id, review_file: f.write() });
  assert.equal(result.status, 'result_reviewed', JSON.stringify(result.blockers || result.review));
  assert.equal(result.review.status, 'feasible'); assert.equal(result.review.objective.value, 3);
  assert.equal(result.review.constraints[0].passed, true); assert.equal(result.review.baseline.improvement, 1);
  assert.deepEqual(f.calls, { network: 0 }); assert.deepEqual(fs.readFileSync(f.store.path(f.run.solve_id)), f.before);
});

test('file budget is derived from a full 4095 upper-triangular model with explicit headroom', () => {
  const basis = verificationCapacityBasis();
  assert.equal(basis.reference_bits,4095); assert.equal(basis.unique_quadratic_and_linear_terms,8386560);
  assert.equal(basis.max_canonical_term_bytes,66); assert.equal(basis.dense_objective_bytes,553512960);
  assert.equal(verificationCapacity({}).max_input_bytes,basis.default_input_bytes);
  assert.ok(basis.default_input_bytes>=basis.dense_objective_bytes*basis.minimum_headroom_ratio);
  assert.ok(basis.dense_objective_bytes>require('node:buffer').constants.MAX_STRING_LENGTH);
  assert.ok(verificationCapacity({},8192).max_input_bytes>basis.default_input_bytes);
  assert.equal(verificationCapacity({ISINGQ_MAX_VERIFICATION_INPUT_BYTES:'12345'},8192).max_input_bytes,12345);
  for(const invalid of [0,-1,NaN,Infinity,{},Number.MAX_SAFE_INTEGER]) assert.throws(()=>verificationCapacityBasis(invalid),e=>e.code==='verification_capacity_invalid');
});

test('chunked review output removes a partial file even when cleanup close fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-review-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writer = new ReviewChecksWriter(root), directory = writer.directory, ownedFd = writer.fd;
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(target, ...args) {
    if (target === ownedFd) {
      fs.writeSync(target, 'partial chunk');
      throw Object.assign(Error('synthetic chunk write failure'), { code: 'ENOSPC' });
    }
    return originalWrite.call(this, target, ...args);
  };
  try { assert.throws(() => writer.append({ value: 'x'.repeat(CHUNK_BYTES) }), { code: 'ENOSPC' }); }
  finally { fs.writeFileSync = originalWrite; }
  const originalClose = fs.closeSync;
  fs.closeSync = function(fd) {
    if (fd === ownedFd) { originalClose.call(this, fd); throw Object.assign(Error('synthetic close failure'), { code: 'EIO' }); }
    return originalClose.call(this, fd);
  };
  try { assert.throws(() => writer.discard(), { code: 'EIO' }); }
  finally { fs.closeSync = originalClose; }
  assert.equal(fs.existsSync(directory), false);
});

test('file exporter consumes iterable coefficients and constraints with the shared math semantics',async t=>{
  const f=fixture(t),inline={...f.manifest.model,objective:{sense:'max',expression:{terms:[{coefficient:{param:'benefit'},variables:['x_0']},{coefficient:2,variables:['x_1']}]}}};
  function* terms(){yield* inline.objective.expression.terms;}
  function* constraints(){yield* inline.constraints;}
  const ref=await writeMathModelReviewFile({directory:f.root,model:{...inline,objective:{sense:'max',expression:{terms:terms()}},constraints:constraints()},data:{benefit:3},baseline:f.manifest.baseline,qubo_model_sha256:f.manifest.qubo_model_sha256});
  const actual=await verifyMathModelFile(ref,{assignment:{x_0:1,x_1:0},outputDirectory:f.root});
  const expected=buildVerifiedReport({report_contract_version:'isingq-verified-report-v1',model:inline,data:{benefit:3},baseline:f.manifest.baseline,candidates:[{id:'candidate',assignment:{x_0:1,x_1:0}}]});
  assert.equal(actual.objective.value,expected.candidates[0].verification.objective_value);
  assert.equal(actual.status,expected.candidates[0].verification.status);assert.equal(actual.baseline.improvement,1);
  assert.equal(actual.file_statistics.objective_terms,2);assert.equal(actual.constraint_count,1);
  const checks=fs.readFileSync(actual.complete_diagnostics.path);assert.equal(sha(checks),actual.complete_diagnostics.content_digest);
  assert.equal(checks.toString().trim().split('\n').length,4);
});

test('file review snapshots caller-owned candidate and file references before asynchronous reads',async t=>{
  const f=fixture(t),ref=f.write(),expected=ref.content_digest,assignment={x_0:1,x_1:0};
  const pending=verifyMathModelFile(ref,{assignment,outputDirectory:f.root});
  assignment.x_0=0;assignment.x_1=1;ref.content_digest='0'.repeat(64);
  const result=await pending;assert.equal(result.objective.value,3);assert.equal(result.input_proof.manifest_sha256,expected);
});

test('file failures are atomic, preserve source task bytes and never fall back to another model',async t=>{
  const f=fixture(t),call=ref=>f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
  const originalRef=f.write();let r=await call({...originalRef,content_digest:'0'.repeat(64)});assert.equal(r.status,'review_blocked');assert.equal(r.review.issue.code,'review_file_digest_mismatch');
  assert.equal(r.review.issue.detail.includes(originalRef.content_digest),false);
  for(const value of [null,0,'',false]){r=await call(value);assert.equal(r.status,'review_blocked');assert.equal(r.review.objective,undefined);}
  f.manifest.qubo_model_sha256='c'.repeat(64);r=await call(f.write());assert.equal(r.review.issue.code,'review_candidate_mismatch');
  f.manifest.qubo_model_sha256=validateQubo(f.run.qubo).summary.model_sha256;
  f.manifest.model.objective.expression.terms_file.path='../outside.jsonl';r=await call(f.write());assert.equal(r.review.issue.code,'review_file_unsafe');
  f.manifest.model.objective.expression.terms_file.path='objective.jsonl';
  f.manifest.model.objective.expression.terms_file.sha256='d'.repeat(64);r=await call(f.write());assert.equal(r.review.issue.code,'review_file_digest_mismatch');
  assert.equal(r.review.objective,undefined);assert.deepEqual(f.calls,{network:0});assert.deepEqual(fs.readFileSync(f.store.path(f.run.solve_id)),f.before);
  const output=f.service.guidedSolveEngine.directory;assert.deepEqual(fs.readdirSync(output).filter(name=>name.startsWith('file-review-')),[]);
});

test('file codec rejects duplicate keys, malformed records and unsupported inactive coefficients',async t=>{
  const f=fixture(t);
  for(const content of ['{"coefficient":3,"coefficient":4,"variables":["x_0"]}\n','not-json\n',JSON.stringify({coefficient:0.5,variables:['x_1']})+'\n',JSON.stringify({coefficient:Number.MAX_SAFE_INTEGER+1,variables:['x_1']})+'\n',JSON.stringify({coefficient:0,variables:['x_99']})+'\n']){
    fs.writeFileSync(path.join(f.root,'objective.jsonl'),content);f.manifest.model.objective.expression.terms_file.sha256=sha(content);
    const r=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:f.write()});
    assert.equal(r.status,'review_blocked');assert.equal(r.review.objective,undefined);assert.equal(r.review.scope,'unverified');
  }
  assert.deepEqual(f.calls,{network:0});
});

test('file paths reject leaf and parent symlinks and reference cycles including a final line without LF',async t=>{
  const f=fixture(t),actual=path.join(f.root,'objective.jsonl');
  fs.symlinkSync(actual,path.join(f.root,'alias.jsonl'));f.manifest.model.objective.expression.terms_file.path='alias.jsonl';
  let r=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:f.write()});assert.equal(r.review.issue.code,'review_file_unsafe');
  fs.mkdirSync(path.join(f.root,'real'));fs.symlinkSync(path.join(f.root,'real'),path.join(f.root,'linked'));
  f.manifest.model.objective.expression.terms_file.path='linked/objective.jsonl';
  r=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:f.write()});assert.equal(r.review.issue.code,'review_file_unsafe');
  f.manifest.model.objective.expression={terms:[]};delete f.manifest.model.constraints;
  const cycle=JSON.stringify({id:'loop',expression:{terms_file:{path:'loop.jsonl',sha256:'a'.repeat(64)}},relation:'le',rhs:1});
  fs.writeFileSync(path.join(f.root,'loop.jsonl'),cycle);f.manifest.model.constraints_file={path:'loop.jsonl',sha256:sha(cycle)};
  r=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:f.write()});assert.equal(r.review.issue.code,'review_file_cycle');
});

test('aggregate file budget includes actual source bytes and permits retry of the same record',async t=>{
  const f=fixture(t),ref=f.write(),setting='ISINGQ_MAX_VERIFICATION_INPUT_BYTES',previous=process.env[setting];
  const bytes=fs.statSync(ref.manifest_path).size+fs.statSync(path.join(f.root,'objective.jsonl')).size+Buffer.byteLength(JSON.stringify({x_0:1,x_1:0}));
  try{
    process.env[setting]=String(bytes-1);let r=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
    assert.equal(r.status,'review_blocked');assert.equal(r.review.issue.code,'unsupported_size');
    process.env[setting]=String(bytes);r=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
    assert.equal(r.status,'result_reviewed',JSON.stringify(r.review));assert.equal(r.review.capacity.input_bytes,bytes);
  }finally{if(previous===undefined)delete process.env[setting];else process.env[setting]=previous;}
  assert.deepEqual(f.calls,{network:0});assert.deepEqual(fs.readFileSync(f.store.path(f.run.solve_id)),f.before);
});

test('model preparation preserves the file reference through status, failure recovery and automatic review',async t=>{
  const f=fixture(t),state={submits:0,polls:0};
  const service=new SolverService({store:f.store,targetOptions:{environment:f.environment,catalogClientFactory:()=>({get:async()=>{throw Error('NO_CLOUD');}}),
    localTransportFactory:()=>({execution_mode:'simulation',prepareSubmission:()=>({}),probe:async()=>({config:{deviceName:'fixture',version:'1',maxScale:4095,maxPrecision:'8bit'},runtime:{bootTimestamp:1},status:{status:'stable'}}),
      submit:async()=>{state.submits++;return{task_id:'file-fixture'};},poll:async()=>{state.polls++;return{status:'succeeded',bits:[1,0],energy:0};}})}});
  service.profileSave({name:'隔离设备',api_base_url:'http://fixture.test'});
  const ref=f.write(),next=(r,action)=>r.actions.find(item=>item.call.arguments.action===action).call.arguments;
  const ready=await service.guideSolve({action:'prepare',qubo:f.run.qubo,problem_summary:'两个项目只选一个，收益分别3和2',review_file:ref});
  assert.equal(ready.status,'ready',JSON.stringify(ready.blockers));
  const submitted=await service.guideSolve(next(ready,'confirm')),status=next(submitted,'status');
  assert.ok(status.request_id,'continuation must preserve the original modeled request');
  const candidate=await service.guideSolve(status),reviewCall=next(candidate,'review');
  assert.deepEqual(reviewCall.review_file,ref);
  const result=await service.guideSolve(reviewCall);assert.equal(result.status,'result_reviewed');assert.equal(result.review.objective.value,3);
  const wrong=await service.guideSolve({...reviewCall,review_file:{...ref,content_digest:'0'.repeat(64)}});
  assert.equal(wrong.status,'blocked');assert.equal(wrong.blockers[0].code,'review_source_changed');
  const moved=path.join(f.root,'relocated');fs.mkdirSync(moved);fs.copyFileSync(ref.manifest_path,path.join(moved,'review.json'));fs.copyFileSync(path.join(f.root,'objective.jsonl'),path.join(moved,'objective.jsonl'));
  const restored=await service.guideSolve({...reviewCall,review_file:{content_digest:ref.content_digest,manifest_path:path.join(moved,'review.json')}});
  assert.equal(restored.status,'result_reviewed');assert.equal(restored.review.objective.value,3);
  const termsPath=path.join(f.root,'objective.jsonl'),originalTerms=fs.readFileSync(termsPath);
  const saved=f.store.list().records.find(record=>record.provider_task_id==='file-fixture'),originalRun=fs.readFileSync(f.store.path(saved.solve_id));
  fs.writeFileSync(termsPath,originalTerms.toString().replace('"coefficient":3','"coefficient":4'));
  const failed=await service.guideSolve(reviewCall);assert.equal(failed.status,'review_blocked');assert.equal(failed.review.issue.code,'review_file_digest_mismatch');
  const retry=next(failed,'review');assert.equal(retry.request_id,reviewCall.request_id);assert.deepEqual(retry.review_file,ref);
  fs.writeFileSync(termsPath,originalTerms);
  const recovered=await service.guideSolve(retry);assert.equal(recovered.status,'result_reviewed');assert.equal(recovered.review.objective.value,3);
  assert.deepEqual(fs.readFileSync(f.store.path(saved.solve_id)),originalRun);
  assert.deepEqual(state,{submits:1,polls:1});
});

test('streamed constraints keep all diagnostics and prioritize a late failure in the chat summary',async t=>{
  const f=fixture(t),constraints=Array.from({length:50},(_,i)=>({id:'c'+i,label:i===49?'最后一条违反约束':'正常约束'+i,
    expression:{terms:[{coefficient:1,variables:['x_0']}]},relation:'le',rhs:i===49?0:1}));
  const content=constraints.map(c=>JSON.stringify(c)+'\n').join('');fs.writeFileSync(path.join(f.root,'constraints.jsonl'),content);
  delete f.manifest.model.constraints;f.manifest.model.constraints_file={path:'constraints.jsonl',sha256:sha(content)};
  const result=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:f.write()});
  assert.equal(result.status,'result_reviewed');assert.equal(result.review.status,'infeasible');assert.equal(result.review.constraint_count,50);
  assert.equal(result.review.constraints.length,40);assert.equal(result.review.constraints[0].passed,false);
  assert.match(result.reply,/最后一条违反约束/);assert.match(result.reply,/另有 10 项/);assert.match(result.reply,/完整核验明细/);
  const records=fs.readFileSync(result.review.complete_diagnostics.path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(records.filter(r=>r.kind==='constraint').length,50);assert.equal(records.find(r=>r.id==='c49').violation,1);
  assert.equal(result.review.baseline.status,'not_comparable');
});

test('file verification preserves the six independently specified business fixture results',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'isingq-file-fixtures-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(__dirname,'fixtures/math-model-v1');
  for(const name of fs.readdirSync(directory).sort()){
    const read=kind=>JSON.parse(fs.readFileSync(path.join(directory,name,kind+'.json'),'utf8'));
    const model=read('model'),data=read('data'),candidates=read('candidates'),expected=read('expected');
    const ref=await writeMathModelReviewFile({directory:root,model,data,baseline:candidates.baseline});
    const result=await verifyMathModelFile(ref,{assignment:candidates.improved,outputDirectory:root});
    assert.equal(result.status,expected.candidate_expectations.improved.status,name);
    assert.equal(result.objective.value,expected.candidate_expectations.improved.objective_value,name);
    assert.equal(result.baseline.improvement,expected.absolute_improvement,name);
  }
});

test('file-backed original integer encodings share domain and overflow rules',async t=>{
  const f=fixture(t),model={schema_version:'math-model-v1',id:'encoded',variables:[{id:'q',domain:'integer',lower:0,upper:3}],
    objective:{sense:'min',expression:{terms:[{coefficient:1,variables:['q']}]}},constraints:[]};
  function* mapping(){yield{coefficient:1,variables:['x_0']};yield{coefficient:2,variables:['x_1']};}
  const ref=await writeMathModelReviewFile({directory:f.root,model,data:{},qubo:f.run.qubo,bindings:{q:{terms:mapping()}}});
  const result=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
  assert.equal(result.status,'result_reviewed');assert.equal(result.review.decisions[0].value,1);
  const manifest=JSON.parse(fs.readFileSync(ref.manifest_path,'utf8'));
  manifest.bindings.q={constant:Number.MAX_SAFE_INTEGER,terms:[{coefficient:1,variables:['x_0']},{coefficient:-Number.MAX_SAFE_INTEGER,variables:['x_0']}]};
  const content=JSON.stringify(manifest)+'\n';fs.writeFileSync(ref.manifest_path,content);
  const blocked=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:{manifest_path:ref.manifest_path,content_digest:sha(content)}});
  assert.equal(blocked.status,'review_blocked');assert.equal(blocked.review.issue.code,'unsupported_numeric');
});

test('a source edited after its bytes were read cannot produce a verified report',async t=>{
  const f=fixture(t),ref=f.write(),original=fs.promises.open;let edited=false;
  fs.promises.open=async function(file,...args){
    const handle=await original.call(this,file,...args);
    if(fs.realpathSync(file)===fs.realpathSync(path.join(f.root,'objective.jsonl'))){
      const read=handle.read.bind(handle);handle.read=async(...values)=>{
        const result=await read(...values);
        if(!edited && result.bytesRead){edited=true;const data=fs.readFileSync(file);data[data.indexOf(Buffer.from(':3'))+1]=52;fs.writeFileSync(file,data);const time=new Date(Date.now()+1000);fs.utimesSync(file,time,time);}
        return result;
      };
    }
    return handle;
  };
  try{
    const result=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
    assert.equal(edited,true);assert.equal(result.status,'review_blocked');assert.equal(result.review.issue.code,'review_file_changed');
    assert.equal(result.review.objective,undefined);assert.deepEqual(fs.readFileSync(f.store.path(f.run.solve_id)),f.before);
  }finally{fs.promises.open=original;}
});

test('real stdio MCP file review uses the saved candidate with network and credential reads forbidden',t=>{
  const f=fixture(t),counter=path.join(f.root,'effect-count.json'),guard=path.join(f.root,'guard.cjs');
  fs.writeFileSync(guard,`const fs=require('node:fs'),path=require('node:path');let network=0,credentials=0;
    const deny=()=>{network++;throw Error('NETWORK_FORBIDDEN');};require('node:net').Socket.prototype.connect=deny;
    const open=fs.openSync;fs.openSync=function(file,...args){if(typeof file==='string'&&/^api[-_]?key(?:\\.txt)?$/i.test(path.basename(file))){credentials++;throw Error('CREDENTIAL_READ_FORBIDDEN');}return open.call(this,file,...args);};
    process.on('exit',()=>fs.writeFileSync(${JSON.stringify(counter)},JSON.stringify({network,credentials})));`);
  const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'isingq_solve',arguments:{action:'review',solve_id:f.run.solve_id,review_file:f.write()}}};
  const reply=spawnSync(process.execPath,[path.resolve(__dirname,'../bin/isingq-mcp.js'),'serve'],{input:JSON.stringify(request)+'\n',encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024,
    env:{PATH:process.env.PATH,HOME:f.root,...f.environment,ISINGQ_UPDATE_CHECK:'off',NODE_OPTIONS:'--require '+JSON.stringify(guard)}});
  assert.equal(reply.status,0,reply.stderr);const result=JSON.parse(reply.stdout.trim()).result.structuredContent.data;
  assert.equal(result.status,'result_reviewed');assert.equal(result.review.objective.value,3);
  assert.deepEqual(JSON.parse(fs.readFileSync(counter,'utf8')),{network:0,credentials:0});assert.deepEqual(fs.readFileSync(f.store.path(f.run.solve_id)),f.before);
});

test('cloud preparation continues to enforce its own declared dimension, format and CSV rules',()=>{
  const {matrixDocument}=require('../packages/core'),{prepareCloudTarget}=require('../packages/core/src/cloud-target');
  const setting='ISINGQ_MAX_VERIFICATION_INPUT_BYTES',previous=process.env[setting];
  const entry={id:8,name:'declared-test',spinNumber:'4',price:258,computeCreditCost:1,executionCapabilities:{problemTypes:['qubo'],inputFormats:['csv','npz'],minDimension:1,maxDimension:4,maxCalculateCount:1,supportsH:false,fixedPostProcess:1}};
  const catalog={schemaVersion:1,uploadLimits:{maxCsvBytes:1},computerTypes:[entry]};
  try{
    process.env[setting]='1';
    const ready=prepareCloudTarget(matrixDocument({num_bits:4}),entry,catalog,{calculate_count:1,post_process:1,use_credit:false});
    assert.equal(ready.file.format,'npz');assert.equal(ready.solver_options.calculate_count,1);
    assert.throws(()=>prepareCloudTarget(matrixDocument({num_bits:5}),entry,catalog,{calculate_count:1,post_process:1,use_credit:false}),/dimension=5.*max=4/);
    const csvOnly={...entry,executionCapabilities:{...entry.executionCapabilities,inputFormats:['csv']}};
    assert.throws(()=>prepareCloudTarget(matrixDocument({num_bits:4}),csvOnly,{...catalog,computerTypes:[csvOnly]},{calculate_count:1,post_process:1,use_credit:false}),/format=npz/);
  }finally{if(previous===undefined)delete process.env[setting];else process.env[setting]=previous;}
});

test('invalid file descriptor values cannot execute conversion hooks',async t=>{
  const f=fixture(t),ref=f.write();let calls=0;
  const forged={...ref,content_digest:{toString(){calls++;return ref.content_digest;}}};
  const result=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:forged});
  assert.equal(result.status,'review_blocked');assert.equal(calls,0);
});

test('file results bound variable projection without hiding the last domain failure',async t=>{
  const f=fixture(t),model={schema_version:'math-model-v1',id:'domains',variables:Array.from({length:50},(_,i)=>i===49?{id:'x_'+i,domain:'integer',lower:1,upper:1}:{id:'x_'+i,domain:'binary'}),objective:{sense:'min',expression:{terms:[]}},constraints:[]};
  const ref=await writeMathModelReviewFile({directory:f.root,model,data:{}});
  const result=await verifyMathModelFile(ref,{assignment:Object.fromEntries(model.variables.map(v=>[v.id,0])),outputDirectory:f.root});
  assert.equal(result.status,'infeasible');assert.equal(result.decision_count,50);assert.equal(result.domain_violation_count,1);
  assert.equal(result.decisions.length,40);assert.equal(result.decisions[0].variable,'x_49');
  assert.equal(fs.readFileSync(result.complete_diagnostics.path,'utf8').trim().split('\n').filter(line=>JSON.parse(line).kind==='variable').length,50);
});

test('overlapping file reviews do not reread a large record, spawn work or claim feasibility',async t=>{
  const f=fixture(t),ref=f.write(),original=f.store.get.bind(f.store);let reads=0;
  f.store.get=id=>{reads++;return original(id);};
  const first=verifyMathModelFile(ref,{assignment:{x_0:1,x_1:0},outputDirectory:f.root});
  const pending=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
  assert.equal(pending.status,'reviewing');assert.equal(pending.review.status,'pending');assert.equal(pending.review.objective,undefined);assert.equal(reads,0);
  await assert.rejects(()=>verifyMathModelFile(ref,{assignment:{x_0:1,x_1:0},outputDirectory:f.root}),e=>e.code==='review_file_busy');
  await first;
  const resumed=await f.service.guideSolve(pending.actions[0].call.arguments);
  assert.equal(resumed.status,'result_reviewed');assert.equal(resumed.review.objective.value,3);assert.equal(reads,1);
  assert.deepEqual(f.calls,{network:0});
});

test('file encoding keeps long business identifiers and parameter names once in metadata',async t=>{
  const f=fixture(t),id='business_variable_'.repeat(20),parameter='original_parameter_'.repeat(20);
  const model={schema_version:'math-model-v1',id:'long-identifiers',variables:[{id,domain:'binary',label:'业务含义保留'}],
    objective:{sense:'max',expression:{terms:[{coefficient:{param:parameter},variables:[id]}]}},constraints:[]};
  const ref=await writeMathModelReviewFile({directory:f.root,model,data:{[parameter]:7}});
  const manifest=JSON.parse(fs.readFileSync(ref.manifest_path,'utf8')),body=fs.readFileSync(path.join(path.dirname(ref.manifest_path),manifest.model.objective.expression.terms_file.path),'utf8');
  assert.ok(body.length<100);assert.match(body,/param_index/);assert.equal(body.includes(id),false);assert.equal(body.includes(parameter),false);
  const result=await verifyMathModelFile(ref,{assignment:{[id]:1},outputDirectory:f.root});
  assert.equal(result.objective.value,7);assert.equal(result.decisions[0].variable,id);assert.equal(result.decisions[0].label,'业务含义保留');
});

test('a reloaded core module shares the same active file worker',async t=>{
  const f=fixture(t),ref=f.write(),filename=require.resolve('../packages/core/src/review-file'),cached=require.cache[filename];
  const first=verifyMathModelFile(ref,{assignment:{x_0:1,x_1:0},outputDirectory:f.root});
  let reloaded;
  try{delete require.cache[filename];reloaded=require(filename);}finally{require.cache[filename]=cached;}
  await assert.rejects(()=>reloaded.verifyMathModelFile(ref,{assignment:{x_0:1,x_1:0},outputDirectory:f.root}),e=>e.code==='review_file_busy');
  await first;
  const result=await reloaded.verifyMathModelFile(ref,{assignment:{x_0:1,x_1:0},outputDirectory:f.root});assert.equal(result.objective.value,3);
});

test('checks creation failure cleans its empty directory and releases the file worker for retry',async t=>{
  const f=fixture(t),ref=f.write(),open=fs.openSync;let attempts=0;
  fs.openSync=function(file,...args){
    if(typeof file==='string' && path.basename(file)==='checks.jsonl' && path.basename(path.dirname(file)).startsWith('file-review-')){attempts++;throw Object.assign(new Error('fixture fd failure'),{code:'EMFILE'});}
    return open.call(this,file,...args);
  };
  try{
    const failed=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
    assert.equal(failed.status,'review_blocked');assert.equal(failed.review.issue.code,'review_file_output_unavailable');assert.equal(attempts,1);
    assert.equal(fs.readdirSync(f.service.guidedSolveEngine.directory).some(name=>name.startsWith('file-review-')),false);
    assert.deepEqual(fs.readFileSync(f.store.path(f.run.solve_id)),f.before);
  }finally{fs.openSync=open;}
  const result=await f.service.guideSolve({action:'review',solve_id:f.run.solve_id,review_file:ref});
  assert.equal(result.status,'result_reviewed');assert.equal(result.review.objective.value,3);assert.deepEqual(f.calls,{network:0});
});

module.exports = { fixture };
