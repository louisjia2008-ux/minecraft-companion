'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {observeHouseTree}=require('../vendor/server/minecraft/houseTreeHarvest');
function world(points){const cells=new Map(points.map(([x,y,z,name='oak_log'])=>[`${x},${y},${z}`,{name,position:new Vec3(x,y,z)}]));return{blockAt:p=>cells.get(`${p.x},${p.y},${p.z}`)||null};}
test('loaded diagonal branches stay with their trunk but separated trees and other wood do not',()=>{
 const bot=world([[0,64,0],[0,65,0],[1,66,0],[2,67,1],[0,66,0,'birch_log'],[4,64,0]]);
 const plan=observeHouseTree(bot,bot.blockAt(new Vec3(0,64,0)));
 assert.equal(plan.pending.length,4);assert.ok(plan.pending.some(p=>p.x===2&&p.z===1));
});
test('protected logs stop connectivity without reading beyond an excluded boundary',()=>{
 const bot=world([[0,64,0],[0,65,0],[0,66,0]]);
 const plan=observeHouseTree(bot,bot.blockAt(new Vec3(0,64,0)),p=>p.y===65);
 assert.deepEqual(plan.pending,[{x:0,y:64,z:0}]);
});
test('a connected forest observation stays inside finite count and spatial limits',()=>{
 const bot={blockAt:p=>({name:'oak_log',position:p})};
 const plan=observeHouseTree(bot,bot.blockAt(new Vec3(0,64,0)));
 assert.equal(plan.pending.length,64);assert.ok(plan.pending.every(p=>Math.abs(p.x)<=4&&Math.abs(p.z)<=4&&Math.abs(p.y-64)<=24));
});
