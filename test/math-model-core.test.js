'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { MATH_MODEL_CONTRACT_VERSION, validateMathModel, evaluateMathCandidate, compareMathCandidates } = require('../packages/core');
// Frozen math-model-v1 prototype JSON snapshots; independent expected answers, no business branches.
const fs = require('node:fs');
const path = require('node:path');
const fixtureRoot = path.join(__dirname, 'fixtures/math-model-v1');
const cases = Object.fromEntries(fs.readdirSync(fixtureRoot).sort().map(name => [name,
  Object.fromEntries(['model','data','candidates','expected'].map(kind => [kind, JSON.parse(fs.readFileSync(path.join(fixtureRoot,name,`${kind}.json`),'utf8'))]))]));
function fixture() {
  return {schema_version:'math-model-v1', id:'anonymous', variables:[{id:'x', domain:'binary'}, {id:'q',domain:'integer',lower:-2,upper:3}],
    objective:{sense:'min',expression:{constant:7,terms:[{coefficient:2,variables:['q','q']},{coefficient:-3,variables:['x','q']}]}},
    constraints:[{id:'balance',expression:{terms:[{coefficient:1,variables:['q']}]},relation:'ge',rhs:0}]};
}
module.exports = { fixture, cases };
test('math model contract exports and signed quadratic decomposition', () => {
  assert.equal(MATH_MODEL_CONTRACT_VERSION, 'math-model-v1');
  const result=evaluateMathCandidate(fixture(), {}, {x:1,q:2});
  assert.equal(result.status,'feasible'); assert.equal(result.objective_value,9);
  assert.deepEqual(result.objective_breakdown.terms.map(t=>t.value),[8,-6]);
  assert.equal(result.objective_breakdown.constant,7);
  assert.equal(evaluateMathCandidate(fixture(), {}, {x:1,q:-2}).violations[0].violation,2);
});
test('six frozen cross-business fixtures keep expected math and comparisons', () => {
  for (const [name,c] of Object.entries(cases)) {
    for (const [id,assignment] of Object.entries(c.candidates)) {
      const r=evaluateMathCandidate(c.model,c.data,assignment), e=c.expected.candidate_expectations[id];
      assert.equal(r.status,e.status,`${name}/${id}`); assert.equal(r.objective_value,e.objective_value,`${name}/${id}`);
    }
    assert.equal(compareMathCandidates(c.model,c.data,c.candidates.baseline,c.candidates.improved).absolute_improvement,c.expected.absolute_improvement,name);
  }
});
test('all relations use exact equality for active and signed slack', () => {
  for (const [relation,rhs,status,slack,active,violation] of [['le',2,'feasible',0,true,0],['ge',2,'feasible',0,true,0],['eq',2,'feasible',0,true,0],['eq',3,'infeasible',-1,false,1],['le',1,'infeasible',-1,false,1],['ge',3,'infeasible',-1,false,1]]) {
    const m=fixture(); Object.assign(m.constraints[0],{relation,rhs}); const r=evaluateMathCandidate(m,{}, {x:0,q:2});
    assert.equal(r.status,status); assert.deepEqual({...r.constraint_diagnostics[0],label:undefined}, {id:'balance',label:undefined,lhs:2,rhs,relation,slack,active,violation});
  }
});
test('strict fields, references, parameters and unsupported mathematics fail explicitly', () => {
  for (const target of ['top','objective','expression','term','variable','constraint']) {
    const m=fixture(); ({top:m,objective:m.objective,expression:m.objective.expression,term:m.objective.expression.terms[0],variable:m.variables[0],constraint:m.constraints[0]})[target].extra=5;
    assert.throws(()=>validateMathModel(m,{}), e=>e.code==='input_error' && !!e.path);
  }
  for(const [mutate,code] of [
    [m=>m.variables[0].domain='real','unsupported'],[m=>m.objective.sense='min_then_max','unsupported'],
    [m=>m.constraints[0].relation='lt','unsupported'],[m=>m.constraints[0].expression.terms[0].variables=['q','q'],'unsupported'],
    [m=>m.objective.expression.terms[0].variables=['q','q','q'],'unsupported'],[m=>m.objective.expression.terms[0].variables=['typo'],'input_error'],
    [m=>m.variables.push({...m.variables[0]}),'input_error'],[m=>m.constraints.push({...m.constraints[0]}),'input_error']]) {
    const m=fixture(); mutate(m); assert.throws(()=>validateMathModel(m,{}),e=>e.code===code);
  }
  const m=fixture(); m.variables[1].upper={param:'cap'};
  assert.deepEqual(validateMathModel(m,{cap:4}).variables.q,[-2,4]);
  for(const d of [{},{cap:4,extra:2},{cap:true},{cap:1.5}]) assert.throws(()=>validateMathModel(m,d));
  m.variables[1].upper.fallback=3; assert.throws(()=>validateMathModel(m,{cap:4}));
});
test('candidate input completeness, numeric boundaries and no partial overflow result', () => {
  for(const c of [{x:1},{x:1,q:0,extra:1},{x:true,q:0},{x:1,q:1.5},new Date()]) assert.throws(()=>evaluateMathCandidate(fixture(),{},c));
  for(const value of [true,1.1,NaN,Infinity,'2*x',null]) {const m=fixture();m.objective.expression.constant=value;assert.throws(()=>validateMathModel(m,{}));}
  for(const m of [fixture(),fixture()]) {
    m.objective.expression={terms:[{coefficient:2,variables:['x']}]};
    assert.throws(()=>evaluateMathCandidate(m,{}, {x:Number.MAX_SAFE_INTEGER,q:0}),e=>e.code==='unsupported_numeric');
  }
  const m=fixture(); m.variables[1].lower=-Number.MAX_SAFE_INTEGER;m.variables[1].upper=Number.MAX_SAFE_INTEGER;
  assert.throws(()=>validateMathModel(m,{}),e=>e.code==='unsupported_numeric');
  const sum=fixture();sum.objective.expression={constant:Number.MAX_SAFE_INTEGER,terms:[{coefficient:1,variables:['x']}]};
  assert.throws(()=>evaluateMathCandidate(sum,{}, {x:1,q:0}),e=>e.code==='unsupported_numeric');
  const residual=fixture();residual.constraints[0].rhs=-Number.MAX_SAFE_INTEGER;
  assert.throws(()=>evaluateMathCandidate(residual,{}, {x:0,q:2}),e=>e.code==='unsupported_numeric');
});
test('finite integer size limits do not enumerate assignments and reject malformed arrays', () => {
  const m=fixture();m.variables[1].upper=1000000;assert.equal(evaluateMathCandidate(m,{}, {x:1,q:2}).status,'feasible');
  for(const mutate of [m=>m.variables=Array.from({length:257},(_,i)=>({id:`v${i}`,domain:'binary'})),m=>m.constraints=Array(1025).fill(m.constraints[0]),m=>m.objective.expression.terms=Array(20001).fill(m.objective.expression.terms[0])]) {
    const copy=fixture();mutate(copy);assert.throws(()=>validateMathModel(copy,{}),e=>e.code==='unsupported_size');
  }
  const sparse=fixture();sparse.variables=new Array(1);assert.throws(()=>validateMathModel(sparse,{}));
});
test('baseline semantics use feasible shared model and exact safe integer percentage', () => {
  const m=fixture();let r=compareMathCandidates(m,{}, {x:0,q:2},{x:1,q:1});
  assert.equal(r.absolute_improvement,9);assert.deepEqual(r.improvement_percent,{numerator:900,denominator:15});
  m.objective.sense='max'; assert.equal(compareMathCandidates(m,{}, {x:0,q:2},{x:1,q:1}).absolute_improvement,-9);
  assert.equal(compareMathCandidates(m,{}, {x:0,q:-1},{x:1,q:1}).status,'not_comparable');
  for(const constant of [0,-5]) {m.objective.expression={constant,terms:[{coefficient:1,variables:['q']}]};assert.equal(compareMathCandidates(m,{}, {x:0,q:0},{x:0,q:1}).improvement_percent,null);}
  m.objective.expression={constant:1,terms:[{coefficient:Number.MAX_SAFE_INTEGER-1,variables:['x']}]};
  assert.throws(()=>compareMathCandidates(m,{}, {x:1,q:0},{x:0,q:0}),e=>e.code==='unsupported_numeric');
});
test('JSON object boundaries do not accept inherited fields, accessors or symbol claims', () => {
  const m=fixture();
  for (const candidate of [Object.create({x:1,q:0}), {x:1,q:0,[Symbol('hidden')]:1}, Object.defineProperty({q:0},'x',{get(){throw new Error('must not execute');},enumerable:true})]) {
    assert.throws(()=>evaluateMathCandidate(m,{},candidate),error=>error.code==='input_error');
  }
  const malformed=fixture();malformed.objective.expression.terms.extra=1;
  assert.throws(()=>validateMathModel(malformed,{}),error=>error.code==='input_error');
  assert.throws(()=>compareMathCandidates(null,{}, {},{}),error=>error.code==='input_error');
  // Legal JSON names that match Object.prototype remain distinct own identifiers.
  const names=JSON.parse('{"schema_version":"math-model-v1","id":"names","variables":[{"id":"__proto__","domain":"binary"},{"id":"constructor","domain":"binary"}],"objective":{"sense":"min","expression":{"terms":[{"coefficient":1,"variables":["__proto__"]},{"coefficient":2,"variables":["constructor"]}]}},"constraints":[]}');
  assert.equal(evaluateMathCandidate(names,{},JSON.parse('{"__proto__":1,"constructor":1}')).objective_value,3);
});
test('invalid integer objects are rejected without invoking conversion hooks', () => {
  let calls=0;
  const callable=()=>{};callable.toString=()=>{calls++;return '1';};
  for(const value of [JSON.parse('{"toString":0}'),{toString(){calls++;return '1';}},callable]) {
    assert.throws(()=>evaluateMathCandidate(fixture(),{}, {x:value,q:0}),error=>error.code==='input_error');
  }
  assert.equal(calls,0);
});
test('custom array prototypes cannot override mathematical evaluation', () => {
  let calls=0;
  const m=fixture();m.constraints=[{id:'impossible',expression:{terms:[]},relation:'eq',rhs:1}];
  Object.setPrototypeOf(m.constraints,Object.assign(Object.create(Array.prototype),{map(){calls++;return [];},entries(){calls++;return [][Symbol.iterator]();}}));
  assert.throws(()=>evaluateMathCandidate(m,{}, {x:0,q:0}),error=>error.code==='input_error');
  assert.equal(calls,0);
});
