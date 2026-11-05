'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SolveStore } = require('../src/store');
const { WorkspaceArtifacts } = require('../packages/core');
const { configureHosts, hostPaths, readJsonObject } = require('../src/hosts');
const MiB = 1024 * 1024;
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-file-limits-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environment = { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root, ...overrides };
  return { root, environment };
}
function record(bytes) {
  const run = { solve_id: 'solve_' + 'a'.repeat(32), idempotency_digest: 'b'.repeat(64), request_digest: 'c'.repeat(64), padding: '' };
  const padding = bytes - Buffer.byteLength(JSON.stringify(run) + '\n');
  run.padding = '中'.repeat(Math.floor(padding / 3)) + 'x'.repeat(padding % 3);
  return run;
}
test('C01: default file import is 128 MiB and accepts files above the former 20 MiB', t => {
  const { root, environment } = fixture(t);
  const workspace = new WorkspaceArtifacts({ root, round: 1, environment });
  assert.equal(workspace.maxFileBytes, 128 * MiB);
  const content = Buffer.alloc(21 * MiB, 120);
  workspace.write('output/large.bin', content);
  assert.equal(workspace.read('output/large.bin').length, content.length);
});
test('C02: custom history limit is shared by save, get, lookup and archive', t => {
  const { environment } = fixture(t, { ISINGQ_MAX_RECORD_BYTES: '1024' });
  const store = new SolveStore(environment);
  for (const bytes of [1023, 1024]) {
    const run = record(bytes);
    store.save(run);
    assert.deepEqual(store.get(run.solve_id), run);
    assert.deepEqual(store.findByIdempotency(run.idempotency_digest), run);
  }
  const before = fs.readFileSync(store.path(record(1024).solve_id));
  assert.throws(() => store.save(record(1025)), e => e.code === 'solve_record_too_large' && /bytes=1025.*max_bytes=1024/.test(e.message) && /ISINGQ_MAX_RECORD_BYTES/.test(e.message));
  assert.throws(() => store.archive(record(1024)), /归档失败/);
  assert.deepEqual(fs.readFileSync(store.path(record(1024).solve_id)), before);
  fs.appendFileSync(store.path(record(1024).solve_id), ' ');
  assert.throws(() => store.get(record(1024).solve_id), { code: 'solve_record_too_large' });
  assert.throws(() => store.findByIdempotency('d'.repeat(64)), { code: 'solve_record_too_large' });
});
test('C03: custom local file limit has UTF-8 -1/exact/+1 read and write boundaries', t => {
  const { root, environment } = fixture(t, { ISINGQ_MAX_LOCAL_FILE_BYTES: '8' });
  const workspace = new WorkspaceArtifacts({ root, round: 1, environment });
  for (const [name, text] of [['minus','中abcd'],['exact','中abcde']]) {
    workspace.write(`output/${name}`, text);
    assert.equal(workspace.read(`output/${name}`).toString(), text);
  }
  assert.throws(() => workspace.write('output/over', '中abcdef'), e => e.code === 'artifact_too_large' && /bytes=9.*max_bytes=8/.test(e.message) && /ISINGQ_MAX_LOCAL_FILE_BYTES/.test(e.message));
  assert.equal(fs.existsSync(path.join(root,'round1/output/over')), false);
  assert.throws(() => workspace.write('output/exact', '中abcdef'), /超|已存在/);
  assert.equal(workspace.read('output/exact').toString(), '中abcde');
  fs.writeFileSync(path.join(root,'round1/output/legacy'), '中abcdef');
  assert.throws(() => workspace.read('output/legacy'), { code: 'artifact_too_large' });
  assert.throws(() => workspace.read('output/exact', 9), { code: 'artifact_size_invalid' });
});
test('C04: Host config defaults to 10 MiB and custom limit applies before/after merge', t => {
  const { root, environment } = fixture(t);
  const paths = hostPaths(environment, 'linux');
  fs.mkdirSync(path.dirname(paths.workbuddy), { recursive: true });
  fs.writeFileSync(paths.workbuddy, JSON.stringify({ mcpServers: {}, padding: 'x'.repeat(2 * MiB) }));
  configureHosts(['workbuddy'], { command:'tool', args:[] }, paths, { environment, writeGeneric:false });
  assert.equal(readJsonObject(paths.workbuddy, 'mcpServers', environment).mcpServers.isingq.command, 'tool');
  const original = '{"mcpServers":{},"padding":"' + '中'.repeat(20) + '"}';
  fs.writeFileSync(paths.workbuddy, original);
  assert.throws(() => configureHosts(['workbuddy'], { command:'tool', args:[] }, paths,
    { environment: {...environment, ISINGQ_MAX_HOST_CONFIG_BYTES:'100'}, writeGeneric:false }), e => /max_bytes=100/.test(e.message) && /ISINGQ_MAX_HOST_CONFIG_BYTES/.test(e.message));
  assert.equal(fs.readFileSync(paths.workbuddy,'utf8'), original);
});
test('C05: invalid capacity settings fail explicitly without echoing input or writing files', t => {
  const { root, environment } = fixture(t);
  for (const value of ['', '0', '-1', '1.5', '1e6', ' 1024', '1024 ', 'Infinity', 'NaN', '9007199254740992', 'synthetic-private-value']) {
    for (const [key, construct] of [
      ['ISINGQ_MAX_RECORD_BYTES', env => new SolveStore(env)],
      ['ISINGQ_MAX_LOCAL_FILE_BYTES', env => new WorkspaceArtifacts({ root, round:1, environment:env })],
      ['ISINGQ_MAX_HOST_CONFIG_BYTES', env => configureHosts(['generic'], {command:'tool',args:[]}, hostPaths(env,'linux'), {environment:env})],
    ]) assert.throws(() => construct({...environment,[key]:value}), e => e.code === 'file_limit_invalid' && e.message.includes(key) && !e.message.includes('synthetic-private-value'));
  }
  assert.deepEqual(fs.readdirSync(root), []);
});
test('C06: raised limits work and existing instances retain their validated setting', t => {
  const { root, environment } = fixture(t, { ISINGQ_MAX_RECORD_BYTES: String(256*MiB), ISINGQ_MAX_LOCAL_FILE_BYTES:String(256*MiB) });
  const store = new SolveStore(environment);
  const workspace = new WorkspaceArtifacts({root,round:1,environment});
  environment.ISINGQ_MAX_RECORD_BYTES = '1'; environment.ISINGQ_MAX_LOCAL_FILE_BYTES = '1';
  assert.equal(store.maxRecordBytes, 256*MiB);
  assert.equal(workspace.maxFileBytes, 256*MiB);
  store.save(record(1024));
  workspace.write('output/example', '中文');
  assert.equal(workspace.read('output/example').toString(), '中文');
});

test('C07: default local file -1/exact/+1 boundary preserves existing files', t => {
  const {root, environment} = fixture(t);
  const workspace = new WorkspaceArtifacts({root, round:1, environment});
  const content = Buffer.alloc(128*MiB+1, 120);
  for (const bytes of [128*MiB-1,128*MiB]) {
    workspace.write(`output/${bytes}`, content.subarray(0,bytes));
    assert.equal(workspace.read(`output/${bytes}`).length, bytes);
  }
  assert.throws(()=>workspace.write('output/over',content),{code:'artifact_too_large'});
  fs.writeFileSync(path.join(root,'round1/output/legacy'),content);
  assert.throws(()=>workspace.read('output/legacy'),{code:'artifact_too_large'});
  assert.equal(fs.statSync(path.join(root,'round1/output/legacy')).size,128*MiB+1);
});

test('C08: default and custom Host limits use final UTF-8 serialization at -1/exact/+1', t => {
  const {environment} = fixture(t);
  const paths = hostPaths(environment,'linux');
  fs.mkdirSync(path.dirname(paths.workbuddy),{recursive:true});
  for (const limit of [512,10*MiB]) {
    const env = limit===512 ? {...environment,ISINGQ_MAX_HOST_CONFIG_BYTES:String(limit)} : environment;
    for (const delta of [-1,0,1]) {
      const template={mcpServers:{isingq:{command:'tool',args:[],type:'stdio'}},padding:''};
      const n=limit+delta-Buffer.byteLength(JSON.stringify(template,null,2)+'\n');
      template.padding='中'.repeat(Math.floor(n/3))+'x'.repeat(n%3);
      const original=JSON.stringify(template);
      fs.writeFileSync(paths.workbuddy,original);
      const call=()=>configureHosts(['workbuddy'],{command:'tool',args:[]},paths,{environment:env,writeGeneric:false});
      if(delta===1){assert.throws(call,{code:'file_too_large'});assert.equal(fs.readFileSync(paths.workbuddy,'utf8'),original);}
      else{call();assert.equal(fs.statSync(paths.workbuddy).size,limit+delta);assert.equal(readJsonObject(paths.workbuddy,'mcpServers',env).padding,template.padding);}
    }
    fs.writeFileSync(paths.workbuddy,' '.repeat(limit+1));
    assert.throws(()=>readJsonObject(paths.workbuddy,'mcpServers',env),{code:'file_too_large'});
  }
});

test('C09: config ceiling rejects impossible runtime sizes and does not allocate at configuration time', () => {
  const {fileLimit,FILE_LIMITS,MAX_CONFIGURABLE_BYTES}=require('../packages/core/src/file-limits');
  for(const kind of Object.keys(FILE_LIMITS)){
    const key=FILE_LIMITS[kind].environment;
    assert.equal(fileLimit(kind,{}),FILE_LIMITS[kind].bytes);
    assert.equal(fileLimit(kind,{[key]:String(MAX_CONFIGURABLE_BYTES)}),MAX_CONFIGURABLE_BYTES);
    assert.throws(()=>fileLimit(kind,{[key]:String(MAX_CONFIGURABLE_BYTES+1)}),{code:'file_limit_invalid'});
  }
});

test('C10: failed artifact write removes only its partial new file and preserves earlier outputs', t => {
  const {root,environment}=fixture(t);
  const workspace=new WorkspaceArtifacts({root,round:1,environment});
  workspace.write('output/original','keep');
  const write=fs.writeFileSync;
  fs.writeFileSync=(fd,...rest)=>{if(typeof fd==='number'){fs.writeSync(fd,'partial');throw Object.assign(Error('synthetic-secret'),{code:'ENOSPC'});}return write(fd,...rest);};
  try {assert.throws(()=>workspace.write('output/new','content'),{code:'artifact_io_error'});}
  finally{fs.writeFileSync=write;}
  assert.equal(workspace.read('output/original').toString(),'keep');
  assert.equal(fs.existsSync(path.join(root,'round1/output/new')),false);
});

test('C11: custom record limit preserves new submissions, idempotency and unknown outcomes', async t => {
  const {SolverService}=require('../packages/core');
  const {environment}=fixture(t,{ISINGQ_MAX_RECORD_BYTES:'4096'});
  const store=new SolveStore(environment);let submits=0;
  const transport={execution_mode:'simulation',async submit(){submits++;if(submits===2)throw Error('simulated ambiguous create');return {task_id:'simulated'};}};
  const service=new SolverService({store,transport});
  const args={qubo:{num_bits:1},model_summary:'limit regression',idempotency_key:'one',solver_options:{use_credit:false}};
  const first=await service.start(args);
  assert.equal((await service.start(args)).solve_id,first.solve_id);
  await assert.rejects(()=>service.start({...args,qubo:{num_bits:1,offset:1}}),/不同模型/);
  const unknown={...args,idempotency_key:'two'};
  await assert.rejects(()=>service.start(unknown),e=>e.run?.status==='submission_unknown');
  const restarted=new SolverService({store:new SolveStore(environment),transport});
  await assert.rejects(()=>restarted.start(unknown),e=>e.run?.status==='submission_unknown');
  assert.equal(submits,2);
});

test('C12: maximum supported 2048-bit result fits the independent HTTP limit', async t => {
  const http=require('undici');const {IsingQTransport}=require('../src/isingq');
  const body=JSON.stringify({data:{status:2,result:{spin_config:Array(2048).fill(-1),energy:-1}}});
  t.diagnostic(JSON.stringify({kind:'synthetic_supported_provider_shape_not_live_capture',num_bits:2048,response_bytes:Buffer.byteLength(body),http_limit_bytes:MiB}));
  assert.ok(Buffer.byteLength(body)<MiB);
  const fetch=http.fetch;t.after(()=>{http.fetch=fetch;});http.fetch=async()=>new Response(body);
  const result=await new IsingQTransport({apiKey:()=> 'synthetic-key'}).poll('synthetic',2048);
  assert.equal(result.bits.length,2048);assert.equal(result.status,'succeeded');
});
