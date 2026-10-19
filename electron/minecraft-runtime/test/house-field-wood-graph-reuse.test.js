'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reuseNearbyFieldWoodGraph}=require('../vendor/server/minecraft/houseFieldWoodGraphReuse');
const graph=x=>({schema:2,kind:'loaded_dry_waypoint_graph',current:`${x},1,0`,nodes:{[`${x},1,0`]:{position:{x,y:1,z:0},parent:null}},order:[`${x},1,0`],visits:1,probes:7});
for(const mode of ['actual','active_transport','candidate_transport','far','already_near'])test(`retained field graph selection preserves all original evidence and budgets: ${mode}`,()=>{
 const selected=graph(4),old=graph(100),history=Array.from({length:31},(_,i)=>({anchor:{x:i?100+i:4,y:1,z:0},graph:i?graph(100+i):selected,marker:i}));
 const search={anchor:{x:100,y:1,z:0},graph:old};
 if(mode==='active_transport')old.pendingWater={originNode:old.current};
 if(mode==='candidate_transport')selected.pendingDryTrail={mustReconcile:true};
 const actual={x:mode==='far'?-100:mode==='already_near'?100:0,y:1,z:0};
 const before=JSON.stringify({history,search});const result=reuseNearbyFieldWoodGraph({search,history,actual});
 assert.equal(JSON.stringify({history,search}),before);
 if(mode!=='actual'){assert.equal(result,null);return;}
 assert.equal(result.search.graph,selected);assert.equal(result.history.length,31);assert.ok(result.history.some(s=>s.graph===old));
 const original=history.map(s=>s.graph).concat(old),after=result.history.map(s=>s.graph).concat(result.search.graph);
 assert.deepEqual(after.map(g=>JSON.stringify(g)).sort(),original.map(g=>JSON.stringify(g)).sort());
 assert.equal(result.evidence.newNodeOrVisitCredit,false);assert.equal(result.evidence.budgetsReset,false);
});
