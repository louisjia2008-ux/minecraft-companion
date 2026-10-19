'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectSurfaceExplorationFrontier:select}=require('../vendor/server/minecraft/houseSurfaceGraph');
test('construction return keeps elevation rather than mistaking a nearer horizontal ravine for progress',()=>{
 const root={x:0,y:64,z:0},id='0,64,0',state={anchor:root,current:id,order:[id],nodes:{[id]:{position:root,parent:null}},step:16,
  frontier:[{parent:id,target:{x:16,y:50,z:0}},{parent:id,target:{x:0,y:64,z:16}}]};
 const hint={kind:'native_loaded_block_observation',name:'cobblestone',position:{x:32,y:64,z:0},lastValidatedAt:Date.now()};
 assert.equal(select(state,root,hint),0);
 assert.equal(select(state,root,{...hint,purpose:'construction_return'}),1);
 assert.equal(state.order.length,1,'Goal ordering grants no node visit or arrival');
});

for(const kind of ['native_loaded_block_observation','recorded_owned_station_hint'])test(`owned stock return preserves elevation with ${kind}`,()=>{
 const root={x:0,y:68,z:0},id='0,68,0',state={anchor:root,current:id,order:[id],nodes:{[id]:{position:root,parent:null}},step:16,
 frontier:[{parent:id,target:{x:20,y:58,z:0}},{parent:id,target:{x:8,y:68,z:16}}]};
 const hint={kind,name:'chest',position:{x:52,y:67,z:0},lastValidatedAt:Date.now(),ownershipRecorded:true,purpose:'owned_stock_return'};
 assert.equal(select(state,root,hint),1);assert.deepEqual(state.order,[id]);
});
