'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fieldWoodUsage,beginFieldWoodBudget,chargeFieldWoodBudget}=require('../vendor/server/minecraft/houseFieldWoodPlanningBudget');
const graph=(nodes,probes)=>({order:Array.from({length:nodes},(_,i)=>String(i)),probes});
test('historical death/debug search graphs remain byte-identical while a formal resumed generation gets finite new planning work',()=>{
 const history=[{graph:graph(100,8000),graphSegments:[{graph:graph(60,1200)}]}],search={graph:graph(30,1000)},before=JSON.stringify({history,search});
 const usage=fieldWoodUsage(search,history),budget=beginFieldWoodBudget(null,{generation:129,usage,deadline:100000,now:1000});
 assert.deepEqual(usage,{nodes:190,probes:10200,segments:3});assert.deepEqual(chargeFieldWoodBudget(budget,{...usage,nodes:191,probes:10210}).spent,{nodes:1,probes:10});assert.equal(JSON.stringify({history,search}),before);
});
test('same execution generation cannot renew its baseline, spent probes or original deadline',()=>{
 const usage={nodes:190,probes:10200,segments:3};let b=beginFieldWoodBudget(null,{generation:129,usage,deadline:100000,now:1000});b=chargeFieldWoodBudget(b,{...usage,nodes:200,probes:10300});
 const resumed=beginFieldWoodBudget(b,{generation:129,usage:{nodes:200,probes:10300,segments:3},deadline:200000,now:2000});assert.equal(resumed.deadline,100000);assert.deepEqual(resumed.baseline,usage);assert.deepEqual(resumed.spent,{nodes:10,probes:100});
 assert.throws(()=>chargeFieldWoodBudget(resumed,{...usage,nodes:199,probes:10299}),{code:'house_field_wood_origin_budget_limit'});
 assert.throws(()=>beginFieldWoodBudget(resumed,{generation:129,usage,deadline:200000,now:100001}),{code:'house_field_wood_origin_budget_limit'});
});
for(const extra of [{nodes:257,probes:0},{nodes:0,probes:8193}])test(`new generation budget still refuses ${JSON.stringify(extra)}`,()=>{
 const usage={nodes:190,probes:10200,segments:3},b=beginFieldWoodBudget(null,{generation:129,usage,deadline:100000,now:1000});assert.throws(()=>chargeFieldWoodBudget(b,{...usage,nodes:usage.nodes+extra.nodes,probes:usage.probes+extra.probes}),{code:'house_field_wood_origin_budget_limit'});
});
test('a public next execution retains all historical usage as its baseline without extending the prior execution',()=>{
 const usage={nodes:190,probes:10200,segments:3},b=beginFieldWoodBudget(null,{generation:129,usage,deadline:100000,now:1000});
 const fresh=beginFieldWoodBudget(b,{generation:130,usage:{nodes:200,probes:10300,segments:4},deadline:1000000,now:2000});assert.equal(fresh.deadline,602000);assert.equal(b.deadline,100000);assert.equal(fresh.baseline.probes,10300);assert.equal(fresh.historicalUsagePreserved,true);
});
