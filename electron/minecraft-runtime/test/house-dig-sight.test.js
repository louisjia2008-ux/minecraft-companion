'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Chunk=require('prismarine-chunk')(registry),World=require('prismarine-world')(registry);
const {canSeeHouseDigTarget}=require('../vendor/server/minecraft/houseDigSight');
function fixture(){const world=new World(()=>new Chunk({minY:-64,worldHeight:384})),chunk=new Chunk({minY:-64,worldHeight:384});world.sync.setColumn(0,0,chunk);
 const set=(name,x,y,z)=>chunk.setBlockStateId(new Vec3(x,y,z),registry.blocksByName[name].defaultState);
 const bot={entity:{eyeHeight:1.62},blockAt:p=>world.sync.getBlock(p),world:world.sync};return{bot,set,feet:new Vec3(.5,64,.5),target:new Vec3(2,64,0)};}
test('native empty-shape short grass permits a clear dig ray without requiring a solid hit',()=>{
 const f=fixture();f.set('short_grass',2,64,0);assert.equal(f.bot.blockAt(f.target).shapes.length,0);
 assert.equal(canSeeHouseDigTarget(f.bot,f.target,f.feet),true);
 f.set('stone',1,65,0);f.set('stone',1,64,0);assert.equal(canSeeHouseDigTarget(f.bot,f.target,f.feet),false);
});
test('solid targets still need their own first collision and stay within reach',()=>{
 const f=fixture();f.set('stone',2,64,0);assert.equal(canSeeHouseDigTarget(f.bot,f.target,f.feet),true);
 f.set('stone',1,65,0);f.set('stone',1,64,0);assert.equal(canSeeHouseDigTarget(f.bot,f.target,f.feet),false);
 assert.equal(canSeeHouseDigTarget(f.bot,new Vec3(9,64,0),f.feet),false);
});
