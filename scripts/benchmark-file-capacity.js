'use strict';

// Offline, fresh-process measurements. Peak RSS includes fixture construction;
// these are observations of this machine, never a performance SLA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { SolveStore } = require('../packages/core/src/store');
const { WorkspaceArtifacts, matrixDocument } = require('../packages/core');
const MiB = 1024 * 1024;
const scenarios = ['record-27MiB', 'raised-record-129MiB', 'local-128MiB', 'raised-local-129MiB', 'dense-qubo-1400', 'history-1000-mixed', 'history-10000'];

function runScenario(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-capacity-bench-'));
  const environment = { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, XDG_DATA_HOME: root,
    ...(name.startsWith('raised-') ? { ISINGQ_MAX_RECORD_BYTES: String(256*MiB), ISINGQ_MAX_LOCAL_FILE_BYTES: String(256*MiB) } : {}) };
  const measures = [];
  const result = { scenario: name, kind: 'capacity_only', operations: measures, network_calls: 0 };
  function measure(operation, fn) {
    const before = performance.now(); const value = fn();
    measures.push({operation, elapsed_ms: Number((performance.now()-before).toFixed(3))}); return value;
  }
  function record(index, paddingBytes = 0) {
    return {solve_id:'solve_'+index.toString(16).padStart(32,'0'),idempotency_digest:index.toString(16).padStart(64,'0'),request_digest:'f'.repeat(64),padding:'x'.repeat(paddingBytes)};
  }
  try {
    if(name.includes('record-')) {
      const store=new SolveStore(environment), run=record(1,(name.startsWith('raised-')?129:27)*MiB);
      result.effective_limit_bytes=store.maxRecordBytes;
      measure('save',()=>store.save(run)); result.file_bytes=fs.statSync(store.path(run.solve_id)).size;
      assert.equal(measure('get',()=>store.get(run.solve_id)).padding.length,run.padding.length);
      assert.equal(measure('lookup',()=>store.findByIdempotency(run.idempotency_digest)).solve_id,run.solve_id);
      measure('archive',()=>store.archive(run));
      assert.equal(measure('lookup_archived',()=>store.findByIdempotency(run.idempotency_digest,{includeArchived:true})).solve_id,run.solve_id);
    } else if(name.includes('local-')) {
      const workspace=new WorkspaceArtifacts({root,round:1,environment});
      const content=Buffer.alloc((name.startsWith('raised-')?129:128)*MiB,120);
      result.effective_limit_bytes=workspace.maxFileBytes;result.file_bytes=content.length;
      measure('write',()=>workspace.write('output/capacity.bin',content));
      const read=measure('read',()=>workspace.read('output/capacity.bin'));assert.equal(read.length,content.length);assert.equal(read[read.length-1],120);
    } else if(name==='dense-qubo-1400') {
      const qubo={num_bits:1400,quadratic:[]};
      for(let i=0;i<1400;i++)for(let j=i+1;j<1400;j++)qubo.quadratic.push({i,j,coefficient:1});
      const workspace=new WorkspaceArtifacts({root,round:1,environment});
      const json=JSON.stringify(qubo);result.file_bytes=Buffer.byteLength(json);result.num_bits=1400;result.quadratic_terms=qubo.quadratic.length;
      result.kind='valid_numerical_qubo_not_business_semantics';
      measure('write_json',()=>workspace.write('output/model.json',json));
      const input=measure('read_parse_json',()=>JSON.parse(workspace.read('output/model.json').toString('utf8')));
      const matrix=measure('validate_and_build_matrix',()=>matrixDocument(input));result.matrix_bytes=matrix.size_bytes;
      assert.equal(matrix.qubo.quadratic.length,qubo.quadratic.length);
    } else {
      const count=name==='history-10000'?10000:1000,store=new SolveStore(environment);
      result.record_count=count;result.large_records=name==='history-1000-mixed'?1:0;
      for(let i=1;i<=count;i++)store.save(record(i,i===1&&result.large_records?27*MiB:512));
      global.gc?.();
      assert.equal(measure('complete_miss_scan',()=>store.findByIdempotency('e'.repeat(64))),null);
      if(count===10000){store.save(record(10001));measure('10001_fail_closed',()=>assert.throws(()=>store.findByIdempotency('e'.repeat(64)),/count=10001.*limit=10000/));}
    }
    result.peak_rss_bytes=process.resourceUsage().maxRSS*1024;
    result.end_rss_bytes=process.memoryUsage().rss;result.status='pass';
    return result;
  } finally {fs.rmSync(root,{recursive:true,force:true});}
}

if(process.argv[2]==='--case') {
  assert.ok(scenarios.includes(process.argv[3]));
  process.stdout.write(JSON.stringify(runScenario(process.argv[3]))+'\n');
} else {
  const results=[];
  for(const name of scenarios){
    const child=spawnSync(process.execPath,['--expose-gc',__filename,'--case',name],{encoding:'utf8',timeout:60000});
    assert.equal(child.status,0,`${name}: ${child.stderr || child.error || child.signal}`);
    results.push(JSON.parse(child.stdout));
  }
  process.stdout.write(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,peak_scope:'fresh child process including fixture construction; maxRSS in KiB converted to bytes',results},null,2)+'\n');
}
