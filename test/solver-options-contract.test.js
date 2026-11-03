'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createRequire } = require('node:module');
const path = require('node:path');
const fixed = createRequire(path.resolve(__dirname, '../package.json'));
const { SolverService, validateSolverOptions } = fixed('@ising-tech/isingq-mcp/core');
const { createHandler } = fixed('@ising-tech/isingq-mcp');
const fields = ['computer_type_id','question_type','calculate_count','post_process','use_credit','gear'];
const invalid = [{calculate_cout:25},{api_key:'SECRET_SENTINEL'},...fields.map(field=>({[field]:null}))];
const args = { qubo:{num_bits:1}, model_summary:'选项契约 mock', idempotency_key:'options-contract' };
const defaults = {computer_type_id:1,question_type:1,calculate_count:1,post_process:false,use_credit:false,gear:2};
function fixture() {
  const events=[];let saved;
  const service=new SolverService({store:{findByIdempotency(){events.push('lookup');return null;},save(run){saved=run;events.push('save');return run;}},transport:{prepareSubmission(){events.push('credentials');return {};},async submit(matrix,options){events.push({submit:options});return {task_id:'mock-options-task'};}}});
  return {service,events,get saved(){return saved;}};
}
test('public solver options validator rejects unknown fields and explicit null without exposing values',()=>{
  for(const opts of invalid) assert.throws(()=>validateSolverOptions(opts),error=>{assert.doesNotMatch(error.message,/SECRET_SENTINEL/);return /solver_options/.test(error.message);});
  assert.deepEqual(validateSolverOptions(),defaults);
  assert.deepEqual(validateSolverOptions(null),defaults); // Existing API-level omitted/null root compatibility.
});
for(const entry of ['core','MCP']) {
  test(`${entry} rejects malformed solver options before lookup, storage, credentials or submission`,async()=>{
    for(const opts of invalid) {
      const f=fixture();
      if(entry==='core') await assert.rejects(()=>f.service.start({...args,solver_options:{use_credit:false,...opts}}),error=>{assert.doesNotMatch(error.message,/SECRET_SENTINEL/);return /solver_options/.test(error.message);});
      else {
        const result=await createHandler(f.service)({method:'tools/call',params:{name:'isingq_solve_start',arguments:{...args,solver_options:{use_credit:false,...opts}}}});
        assert.equal(result.isError,true);assert.equal(result.structuredContent.ok,false);assert.equal(result.structuredContent.error.code,'validation_error');assert.doesNotMatch(JSON.stringify(result),/SECRET_SENTINEL/);
      }
      assert.deepEqual(f.events,[]);assert.equal(f.saved,undefined);
    }
  });
  test(`${entry} preserves valid explicit solver option values exactly`,async()=>{
    const f=fixture();const opts={computer_type_id:3,question_type:2,calculate_count:25,post_process:true,use_credit:true,gear:0};
    let run;
    if(entry==='core') run=await f.service.start({...args,solver_options:opts});
    else {const r=await createHandler(f.service)({method:'tools/call',params:{name:'isingq_solve_start',arguments:{...args,solver_options:opts}}});assert.equal(r.isError,false);run=r.structuredContent.data;}
    assert.deepEqual(run.solver_options,opts);assert.deepEqual(f.events.find(value=>typeof value==='object'),{submit:opts});assert.deepEqual(f.saved.solver_options,opts);
  });
}
