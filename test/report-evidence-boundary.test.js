'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {buildVerifiedReport}=require('../packages/core');
test('complete additive data are evaluated without inventing missing scheduling inputs',()=>{
 const d={report_contract_version:'isingq-verified-report-v1',model:{schema_version:'math-model-v1',id:'resource',variables:[{id:'x',domain:'binary'},{id:'y',domain:'binary'}],objective:{sense:'max',expression:{terms:[{coefficient:3,variables:['x']},{coefficient:7,variables:['y']}]}}},data:{a:2,b:4,limit:6},candidates:[{id:'both',assignment:{x:1,y:1}}]};
 d.model.constraints=[{id:'cumulative',expression:{terms:[{coefficient:{param:'a'},variables:['x']},{coefficient:{param:'b'},variables:['y']}]},relation:'le',rhs:{param:'limit'}}];
 const r=buildVerifiedReport(d);assert.equal(r.candidates[0].verification.status,'feasible');assert.equal(r.ranking[0].objective_value,10);
 assert.equal(r.evidence_boundary.natural_language_verified,false);
 assert.equal(r.evidence_boundary.additional_claims_verified,false);
 assert.equal(r.evidence_boundary.missing_data_assessment,'not_performed');
 delete d.data.a;assert.throws(()=>buildVerifiedReport(d));
});
