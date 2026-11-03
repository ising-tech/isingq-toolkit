'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const core=require('../packages/core');
function document(){return {report_contract_version:'isingq-verified-report-v1',model:{schema_version:'math-model-v1',id:'generic-plan',variables:[{id:'pick',label:'Choose',domain:'binary'},{id:'reserve',label:'Reserve',domain:'binary'}],objective:{sense:'max',expression:{terms:[{coefficient:7,variables:['pick']}]}},constraints:[]},data:{},candidates:[{id:'one',assignment:{pick:1,reserve:0}},{id:'tie',assignment:{pick:1,reserve:0}}]};}
test('existing renderer preserves all decisions and gains a deterministic input and byte binding',()=>{
 const d=document(),r=core.buildVerifiedReport(d);
 assert.deepEqual(r.candidates.map(c=>[c.id,c.verification.variable_diagnostics.map(v=>[v.id,v.value])]),[['one',[['pick',1],['reserve',0]]],['tie',[['pick',1],['reserve',0]]]]);
 assert.match(r.report_markdown,/Reserve.*0/);assert.equal(r.report_artifact.content_sha256,crypto.createHash('sha256').update(r.report_markdown).digest('hex'));
 assert.equal(r.report_artifact.input_document_sha256,r.input_digests.document_sha256);
 assert.deepEqual(core.buildVerifiedReport(d),r);
});
test('artifact comparison rejects changed variable, stale input and arbitrary unverified prose',()=>{
 const d=document(),r=core.buildVerifiedReport(d);
 assert.equal(core.verifyReportArtifact(d,Buffer.from(r.report_markdown)).match,true);
 const changedValue=r.report_markdown.replace('| 0 | binary |','| 1 | binary |');assert.notEqual(changedValue,r.report_markdown);
 for(const altered of [changedValue,r.report_markdown.replace('目标值','方案数'),r.report_markdown+'\nEverything verified',r.report_markdown.replace('Reserve','Changed label'),'unrelated conclusion'])assert.throws(()=>core.verifyReportArtifact(d,Buffer.from(altered)),e=>e.code==='report_artifact_mismatch');
 const changed=structuredClone(d);changed.candidates[0].assignment.reserve=1;
 assert.throws(()=>core.verifyReportArtifact(changed,r.report_markdown),e=>e.code==='report_artifact_mismatch');
 assert.throws(()=>core.buildVerifiedReport({...d,markdown:'claim'}));
});
test('visible summary reuses verified quantities and units and is embedded verbatim in artifact',()=>{
 const d=document(),r=core.buildVerifiedReport(d),s=r.visible_summary;
 assert.equal(s.counts.provided.value,r.selection.provided_count);assert.equal(s.counts.provided.unit,'candidate');
 assert.equal(s.counts.feasible.value,r.selection.feasible_count);assert.equal(s.counts.feasible.unit,'candidate');
 for(const best of s.best_candidates){const candidate=r.candidates.find(c=>c.id===best.id);assert.equal(best.objective.value,candidate.verification.objective_value);assert.equal(best.objective.unit,'model_objective_unit_unspecified');assert.deepEqual(best.decisions,candidate.verification.variable_diagnostics);}
 assert.equal(s.input_document_sha256,r.input_digests.document_sha256);
 assert.ok(r.report_markdown.includes(r.visible_summary_markdown));
 assert.match(r.visible_summary_markdown,/目标值/);assert.match(r.visible_summary_markdown,/个候选/);
 assert.equal(r.report_artifact.visible_summary_sha256,crypto.createHash('sha256').update(r.visible_summary_markdown).digest('hex'));
 assert.equal(s.global_optimality_verified,false);
});
