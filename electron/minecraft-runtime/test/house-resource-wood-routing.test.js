'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {createHouseResourceGatherer}=require('../vendor/server/minecraft/houseResourceGatherer');
const {LOG_TO_PLANK}=require('../vendor/server/minecraft/taskCatalog');
test('the actual mixed-log query remains eligible for the wood-specific surface collector',async()=>{
 const bot={entity:{position:new Vec3(0,64,0),onGround:true},health:20,food:20,inventory:{items:()=>[]}};
 let actualNames;
 const gatherer=createHouseResourceGatherer({getBot:()=>bot,assertActive(){},capacityFor:()=>64,withSurface:f=>f(),safeFoot:()=>true,
  findBlocks:names=>{actualNames=names;throw Error('captured actual query');}});
 await assert.rejects(gatherer.gather('any_log',1,{anchor:{x:0,y:64,z:0}}),/captured actual query/);
 assert.ok(actualNames.length>=9);assert.ok(actualNames.every(n=>Object.hasOwn(LOG_TO_PLANK,n)));
 assert.deepEqual(actualNames,require('../vendor/server/minecraft/houseResourceGatherer').OVERWORLD_LOGS,'Field guidance must reuse the exact canonical query and persisted resource-memory contract');
 assert.equal(LOG_TO_PLANK.pale_oak_log,'pale_oak_planks');
});
