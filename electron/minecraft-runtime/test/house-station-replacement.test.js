'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {chooseLocalStationReplacement:choose}=require('../vendor/server/minecraft/houseSelfSupplyRuntime');
const camp={anchor:{x:0,y:64,z:0},stations:{crafting_table:{x:-2,y:64,z:0},furnace:{x:0,y:64,z:-2}}};
const b=name=>Block.fromStateId(registry.blocksByName[name].defaultState);
test('destroyed furnace with a deep crater gets a local stable air site without changing camp or old stations',()=>{
 const old=JSON.stringify(camp),p=choose({camp,item:'furnace',position:{x:.5,y:64,z:.5},blockAt:p=>b(p.x===0&&p.z===-2?'air':p.y<64?'stone':'air'),excluded:p=>p.x===-1});
 assert.ok(p);assert.equal(p.y,64);assert.notDeepEqual(p,camp.stations.furnace);assert.notDeepEqual(p,camp.anchor);assert.notEqual(p.x,-1);assert.equal(JSON.stringify(camp),old);
});
test('unknown, fluid, gravity and occupied alternatives cannot authorize a replacement station',()=>{
 for(const floor of [null,'water','sand'])assert.equal(choose({camp,item:'furnace',position:{x:.5,y:64,z:.5},blockAt:p=>p.y<64?(floor?b(floor):null):b('air')}),null);
 assert.equal(choose({camp,item:'furnace',position:{x:.5,y:64,z:.5},blockAt:p=>b(p.y<64?'stone':'chest')}),null);
});
