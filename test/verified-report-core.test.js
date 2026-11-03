'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildVerifiedReport, VERIFIED_REPORT_CONTRACT_VERSION } = require('../packages/core');
function document() {
  return {report_contract_version:'isingq-verified-report-v1',model:{schema_version:'math-model-v1',id:'quantity',variables:[{id:'q',domain:'integer',lower:0,upper:10}],objective:{sense:'min',expression:{terms:[{coefficient:1,variables:['q']}]}},constraints:[{id:'minimum',label:'最低数量',expression:{terms:[{coefficient:1,variables:['q']}]},relation:'ge',rhs:1}]},data:{},baseline:{q:3},candidates:[{id:'baseline',assignment:{q:3}},{id:'lower',assignment:{q:2}},{id:'infeasible-cheap',assignment:{q:0}}]};
}
module.exports={document};
test('recomputes all candidates and ranks only feasible supplied assignments',()=>{
  assert.equal(VERIFIED_REPORT_CONTRACT_VERSION,'isingq-verified-report-v1');
  const d=document(),snapshot=structuredClone(d),r=buildVerifiedReport(d);
  assert.equal(r.scope,'provided_candidates');assert.deepEqual(r.ranking.map(x=>[x.id,x.rank,x.objective_value]),[['lower',1,2],['baseline',2,3]]);
  assert.equal(r.candidates.find(x=>x.id==='infeasible-cheap').verification.status,'infeasible');
  assert.equal(r.candidates.find(x=>x.id==='lower').baseline_comparison.absolute_improvement,1);
  assert.equal(r.ranking.some(x=>x.id==='infeasible-cheap'),false);
  assert.match(r.report_markdown,/lower/);assert.match(r.report_markdown,/最低数量/);assert.match(r.report_markdown,/仅.*候选/);
  assert.deepEqual(d,snapshot);assert.deepEqual(buildVerifiedReport(d),r);
});
test('ties share competition rank, stable IDs and inclusive top-k boundary',()=>{
  const d=document();d.top_k=1;d.candidates.push({id:'a-tie',assignment:{q:2}});
  const r=buildVerifiedReport(d);assert.deepEqual(r.ranking.map(x=>[x.id,x.rank]),[['a-tie',1],['lower',1]]);
  assert.equal(r.selection.returned_count,2);assert.equal(r.selection.boundary_ties_included,true);assert.equal(r.selection.feasible_count,3);
  assert.match(r.report_markdown,/2/);
  d.top_k=3;assert.deepEqual(buildVerifiedReport(d).ranking.map(x=>x.rank),[1,1,3]);
  d.model.objective.sense='max';assert.equal(buildVerifiedReport(d).ranking[0].id,'baseline');
});
test('active means numeric equality and does not imply marginal value or redundancy',()=>{
  const d=document();d.candidates=[{id:'tight',assignment:{q:1}}];d.model.objective.expression={constant:7,terms:[]};
  const r=buildVerifiedReport(d),c=r.candidates[0].verification.constraint_diagnostics[0];
  assert.equal(c.active,true);assert.equal(c.slack,0);assert.equal(c.violation,0);
  assert.match(r.report_markdown,/取等/);assert.doesNotMatch(r.report_markdown,/冗余|影子价格|真实收益/);assert.equal(r.visible_summary.global_optimality_verified,false);
});
test('strict report input rejects forged verification, unknown fields and duplicate IDs',()=>{
  for(const mutate of [d=>d.report_contract_version='bad',d=>delete d.report_contract_version,d=>d.report_markdown='fake',d=>d.verified={status:'feasible'},d=>d.candidates[0].objective_value=-100,d=>d.candidates[1].id=d.candidates[0].id,d=>d.top_k=0,d=>d.top_k=1.5,d=>d.candidates=new Array(1)]){
    const d=document();mutate(d);assert.throws(()=>buildVerifiedReport(d),e=>!!e.code&&!!e.path);
  }
});
test('model, data, and assignment digests bind all report facts and escape labels',()=>{
  const d=document(),r=buildVerifiedReport(d);d.candidates[0].assignment.q=4;
  const changed=buildVerifiedReport(d);assert.notEqual(changed.input_digests.candidates_sha256,r.input_digests.candidates_sha256);
  assert.notEqual(changed.candidates.find(x=>x.id==='baseline').assignment_sha256,r.candidates.find(x=>x.id==='baseline').assignment_sha256);
  d.model.constraints[0].rhs={param:'minimum'};d.data={minimum:1};const p=buildVerifiedReport(d);d.data.minimum=2;assert.notEqual(buildVerifiedReport(d).input_digests.data_sha256,p.input_digests.data_sha256);
  const html=document();html.model.label='<script>alert(1)</script> | [claim](https://bad.test)';html.candidates[0].id='**fake**\n| next';
  const text=buildVerifiedReport(html).report_markdown;assert.doesNotMatch(text,/<script>|\[claim\]\(https/);assert.match(text,/&lt;script&gt;/);assert.match(text,/\\\*/);
});
test('infeasible baseline never creates benefits and zero/negative baseline has no percent',()=>{
  const d=document();d.baseline={q:0};let r=buildVerifiedReport(d);assert.ok(r.candidates.every(c=>c.baseline_comparison.status==='not_comparable'));
  for(const constant of [0,-3]){d.model.objective.expression={constant,terms:[{coefficient:1,variables:['q']}]};d.baseline={q:1};d.model.objective.expression.constant=constant-1;r=buildVerifiedReport(d);assert.ok(r.candidates.every(c=>c.baseline_comparison.status==='not_comparable'||c.baseline_comparison.improvement_percent===null));}
});
test('any late numeric overflow aborts entire report instead of returning partial success',()=>{
  const d=document();delete d.baseline;d.model.objective.expression.terms[0].coefficient=2;d.candidates.push({id:'overflow',assignment:{q:Number.MAX_SAFE_INTEGER}});
  assert.throws(()=>buildVerifiedReport(d),e=>e.code==='unsupported_numeric');
});
test('report digest is stable under JSON object key order but tracks labels and model changes',()=>{
  const d=document(),r=buildVerifiedReport(d);
  const reorder=JSON.parse(JSON.stringify(d),(_,value)=>value && !Array.isArray(value) && typeof value==='object' ? Object.fromEntries(Object.entries(value).reverse()) : value);
  assert.deepEqual(buildVerifiedReport(reorder),r);
  d.model.label='new display label';assert.notEqual(buildVerifiedReport(d).input_digests.model_sha256,r.input_digests.model_sha256);
});
test('empty supplied candidate set and infeasible-only set produce no manufactured rank',()=>{
  const d=document();delete d.baseline;d.candidates=[];
  let r=buildVerifiedReport(d);assert.deepEqual(r.ranking,[]);assert.equal(r.selection.returned_count,0);
  d.candidates=[{id:'optimal',assignment:{q:0}}];r=buildVerifiedReport(d);assert.deepEqual(r.ranking,[]);
  assert.equal(r.candidates[0].verification.status,'infeasible');assert.match(r.report_markdown,/没有可行候选/);
});
test('non-JSON array prototypes cannot suppress impossible constraints or ranking checks',()=>{
  let calls=0;
  const d=document();delete d.baseline;
  d.model.constraints=[{id:'impossible',expression:{terms:[]},relation:'eq',rhs:1}];
  Object.setPrototypeOf(d.model.constraints,Object.assign(Object.create(Array.prototype),{map(){calls++;return [];}}));
  assert.throws(()=>buildVerifiedReport(d),error=>error.code==='input_error');
  assert.equal(calls,0);
  const candidates=document();Object.setPrototypeOf(candidates.candidates,Object.assign(Object.create(Array.prototype),{entries(){calls++;return [][Symbol.iterator]();}}));
  assert.throws(()=>buildVerifiedReport(candidates),error=>error.code==='input_error');assert.equal(calls,0);
});
