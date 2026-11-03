'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const core=require('../packages/core');
function document(sense='max') {return {report_contract_version:'isingq-verified-report-v1',model:{schema_version:'math-model-v1',id:'generic-choice',variables:[{id:'u',domain:'binary'},{id:'v',domain:'binary'}],objective:{sense,expression:{constant:2,terms:[{coefficient:5,variables:['u']},{coefficient:3,variables:['v']},{coefficient:1,variables:['u','v']}]}},constraints:[{id:'limit',expression:{terms:[{coefficient:1,variables:['u']},{coefficient:1,variables:['v']}]},relation:'le',rhs:1}]},data:{},candidates:[{id:'a',assignment:{u:1,v:0}},{id:'b',assignment:{u:0,v:1}},{id:'bad',assignment:{u:1,v:1}},{id:'a-tie',assignment:{u:1,v:0}}]};}
for(const sense of ['max','min'])test(`${sense}: basis comes from same verified candidate and ranking, excluding infeasible alternatives`,()=>{
 const r=core.buildVerifiedReport(document(sense));
 for(const best of r.visible_summary.best_candidates){
  const v=r.candidates.find(x=>x.id===best.id),b=best.recommendation_basis;
  assert.equal(b.rank,r.ranking.find(x=>x.id===best.id).rank);assert.equal(b.scope,'provided_feasible_candidates');assert.equal(b.feasible_candidate_count,3);
  assert.equal(b.verification_status,v.verification.status);assert.equal(b.verification_status,'feasible');
  assert.deepEqual(b.objective_breakdown,v.verification.objective_breakdown);assert.deepEqual(b.constraint_diagnostics,v.verification.constraint_diagnostics);
  assert.equal(b.assignment_sha256,v.assignment_sha256);assert.equal(b.input_document_sha256,r.input_digests.document_sha256);
  assert.deepEqual(Object.keys(b).sort(),['rank','scope','feasible_candidate_count','verification_status','objective_breakdown','constraint_diagnostics','assignment_sha256','input_document_sha256'].sort());
 }
 assert.ok(r.report_markdown.includes(r.visible_summary_markdown));assert.match(r.visible_summary_markdown,/推荐依据/);
 assert.deepEqual(r.visible_summary.best_candidates.map(x=>x.id),sense==='max'?['a','a-tie']:['b']);
});
test('infeasible-only input never manufactures recommendation basis',()=>{
 const d=document();d.candidates=[d.candidates[2]];const r=core.buildVerifiedReport(d);
 assert.deepEqual(r.visible_summary.best_candidates,[]);assert.doesNotMatch(r.visible_summary_markdown,/推荐依据/);
});
