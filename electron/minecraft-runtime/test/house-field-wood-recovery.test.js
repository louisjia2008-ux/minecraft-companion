'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {isDisplacedFieldWaterSearch}=require('../vendor/server/minecraft/houseFieldWoodRecovery');
const search=()=>({graph:{pendingWater:{edge:{transport:{route:{kind:'loaded_surface_swim',from:{x:0,y:63,z:0},to:{x:100,y:63,z:0}}}}}}});
test('displacement measures the entire water segment, including its middle, and preserves the incomplete route',()=>{
 const s=search(),before=JSON.stringify(s);
 assert.equal(isDisplacedFieldWaterSearch(s,{x:50,y:63,z:0}),false);
 assert.equal(isDisplacedFieldWaterSearch(s,{x:-33,y:63,z:0}),true);
 assert.equal(isDisplacedFieldWaterSearch(s,{x:50,y:63,z:33}),true);
 assert.equal(isDisplacedFieldWaterSearch(s,{x:50,y:63,z:32}),false);
 assert.equal(JSON.stringify(s),before);
});
test('unknown transport, invalid actual state and an outstanding dry trail cannot start a replacement search',()=>{
 const p={x:200,y:63,z:0},s=search();s.graph.pendingDryTrail={};assert.equal(isDisplacedFieldWaterSearch(s,p),false);
 delete s.graph.pendingDryTrail;assert.equal(isDisplacedFieldWaterSearch(s,{x:NaN,y:63,z:0}),false);
 delete s.graph.pendingWater.edge.transport.route.kind;assert.equal(isDisplacedFieldWaterSearch(s,p),false);
});
