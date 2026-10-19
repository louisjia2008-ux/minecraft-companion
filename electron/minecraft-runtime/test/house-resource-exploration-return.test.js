'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {returnHouseResourceExploration}=require('../vendor/server/minecraft/houseResourceExplorationReturn');
const {deferEscapedExplorationBranch}=require('../vendor/server/minecraft/houseResourceExplorationReturn');
const failure=code=>Object.assign(new Error(code),{code});
test('off-graph cave cannot repeat rejoin without attempting owned camp recovery',async()=>{
 const actions=[];let actual={x:-154,y:51,z:-154};
 await returnHouseResourceExploration({assertActive:()=>{},rejoin:async()=>{actions.push('rejoin');throw failure('house_surface_dry_graph_native_no_path');},
  onCampRecovery:()=>actions.push('fallback'),returnCamp:async()=>{actions.push('checked_dig_return');actual={x:-85,y:66,z:-141};}});
 assert.deepEqual(actions,['rejoin','fallback','checked_dig_return']);assert.equal(actual.y,66);
});
test('successful local rejoin does not force a camp detour',async()=>{
 let returns=0;await returnHouseResourceExploration({assertActive:()=>{},rejoin:async()=>{},returnCamp:async()=>returns++});assert.equal(returns,0);
});
for(const code of ['paused','cancelled','movement_preempted','house_surface_connection_changed','house_resource_unsafe_target'])
 test(`${code} never authorizes fallback movement`,async()=>{
  let returns=0;const error=failure(code);
  await assert.rejects(returnHouseResourceExploration({assertActive:()=>{},rejoin:async()=>{throw error;},returnCamp:async()=>returns++}),e=>e===error);
  assert.equal(returns,0);
 });
test('failed recovery propagates and cannot claim arrival',async()=>{
 const error=failure('house_local_route_timeout');
 await assert.rejects(returnHouseResourceExploration({assertActive:()=>{},rejoin:async()=>{throw failure('house_surface_dry_graph_rejoin_unconfirmed');},returnCamp:async()=>{throw error;}}),e=>e===error);
});
test('cancellation after failed probe prevents camp recovery',async()=>{
 let active=true,returns=0;
 await assert.rejects(returnHouseResourceExploration({assertActive:()=>{if(!active)throw failure('paused');},rejoin:async()=>{active=false;throw failure('house_surface_dry_graph_native_no_path');},returnCamp:async()=>returns++}),{code:'paused'});
 assert.equal(returns,0);
});
function escapedGraph(){return {anchor:{x:0,y:66,z:0},current:'0,66,0',resumeNode:'2,51,0',
 nodes:{'0,66,0':{position:{x:0,y:66,z:0},parent:null},'1,66,0':{position:{x:1,y:66,z:0},parent:'0,66,0'},
 '2,58,0':{position:{x:2,y:58,z:0},parent:'1,66,0'},'2,51,0':{position:{x:2,y:51,z:0},parent:'2,58,0'}},
 order:['0,66,0','1,66,0','2,58,0','2,51,0'],visits:4,
 frontier:[{parent:'2,51,0',target:{x:3,y:51,z:0}},{parent:'1,66,0',target:{x:3,y:66,z:0}}]};}
test('verified upward escape return preserves evidence but prevents replay into the trapped branch',()=>{
 const g=escapedGraph(),before=JSON.stringify(g.nodes['1,66,0']);
 assert.equal(deferEscapedExplorationBranch(g,66,{x:0,y:66,z:0}),true);
 assert.equal(g.resumeNode,g.current);assert.equal(g.visits,4);assert.equal(g.order.length,4);
 assert.equal(g.nodes['2,51,0'].terrainUnavailable.reason,'return_required_escape_digging');
 assert.equal(g.nodes['2,58,0'].terrainUnavailable.minimumY,66);
 assert.equal(JSON.stringify(g.nodes['1,66,0']),before);assert.equal(g.frontier.length,1);assert.equal(g.frontier[0].parent,'1,66,0');
});
for(const change of [g=>g.current='2,51,0',g=>g.pendingWater={},g=>g.pendingDryTrail={}])test('unconfirmed camp arrival or unfinished transport cannot retire a branch',()=>{
 const g=escapedGraph();change(g);const before=JSON.stringify(g);
 assert.equal(deferEscapedExplorationBranch(g,66,{x:0,y:66,z:0}),false);assert.equal(JSON.stringify(g),before);
});
test('ordinary same-height supply returns preserve the exploration resume target',()=>{
 const g=escapedGraph(),before=JSON.stringify(g);assert.equal(deferEscapedExplorationBranch(g,null,{x:0,y:66,z:0}),false);assert.equal(JSON.stringify(g),before);
});
