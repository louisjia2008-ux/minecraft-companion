'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {isCombatCleanupThreat:threat}=require('../vendor/server/minecraft/houseCombatCleanupThreat');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
function fixture(){const bot={health:20,entity:{position:new Vec3(.5,1,.5)},inventory:{items:()=>[{name:'iron_sword'}],slots:[]},registry,
 blockAt:p=>Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState),{position:p})};
 return {bot,material:{},enemy:{name:'skeleton',isValid:true,height:1.99,position:new Vec3(10.5,1,.5)}};}
test('actual19m-below-ground skeleton witness cannot freeze surface cleanup',()=>{
 const f=fixture();f.bot.entity.position=new Vec3(-102.471,63,-115.5);f.enemy.position=new Vec3(-97.7,44,-117.47);
 assert.equal(threat(f.bot,f.enemy,f.material,{ranged:true}),false);
});
test('exposed nearby or newly shooting archers still preempt cleanup; unknown terrain is not cover',()=>{
 const f=fixture();assert.equal(threat(f.bot,f.enemy,f.material,{ranged:true}),true);
 f.enemy.position.x=20;assert.equal(threat(f.bot,f.enemy,f.material,{ranged:true}),false);
 f.bot.blockAt=()=>null;assert.equal(threat(f.bot,f.enemy,f.material,{ranged:true,recentDamage:true}),true);
});
for(const owned of [false,true])test(`a solid wall permits cleanup only if it remains after temporary cover removal: owned=${owned}`,()=>{
 const f=fixture(),air=f.bot.blockAt;
 f.bot.blockAt=p=>p.x===4?Object.assign(Block.fromStateId(registry.blocksByName.cobblestone.defaultState),{position:p}):air(p);
 if(owned)f.material.defensiveCoverBlocks=[0,1,2,3].map(y=>({item:'cobblestone',position:{x:4,y,z:0}}));
 assert.equal(threat(f.bot,f.enemy,f.material,{ranged:true}),owned);
});
test('contact and creeper ranges match urgent defense instead of counting inaccessible cave mobs',()=>{
 const f=fixture();f.enemy.name='zombie';f.enemy.position=new Vec3(4,1,.5);assert.equal(threat(f.bot,f.enemy,f.material),true);
 f.enemy.position.x=9;assert.equal(threat(f.bot,f.enemy,f.material),false);
 f.enemy.position=new Vec3(.5,-6,.5);assert.equal(threat(f.bot,f.enemy,f.material),false);
 f.enemy.name='creeper';f.enemy.position=new Vec3(8,1,.5);assert.equal(threat(f.bot,f.enemy,f.material),true);
});

test('a cold lower-layer creeper behind actual natural terrain cannot freeze work, but unknown, changed, own cover, fuse or damage never prove separation',()=>{
 const {naturalTerrainSeparatesMelee:separated}=require('../vendor/server/minecraft/houseCombatCleanupThreat');
 const f=fixture();f.bot.version='1.21.8';f.enemy.name='creeper';f.enemy.metadata=[];
 f.enemy.position=new Vec3(4.5,-2,.5);const air=f.bot.blockAt;
 f.bot.blockAt=p=>p.y===0?Object.assign(Block.fromStateId(registry.blocksByName.stone.defaultState),{position:p}):air(p);
 assert.equal(separated(f.bot,f.enemy,f.material),true);
 assert.equal(separated(f.bot,f.enemy,f.material,{recentDamage:true}),false);
 f.enemy.metadata[registry.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')]=1;assert.equal(separated(f.bot,f.enemy,f.material),false);
 f.enemy.metadata=[];f.bot.blockAt=()=>null;assert.equal(separated(f.bot,f.enemy,f.material),false);
 f.bot.blockAt=air;assert.equal(separated(f.bot,f.enemy,f.material),false);
 f.bot.blockAt=p=>p.x===2?Object.assign(Block.fromStateId(registry.blocksByName.dirt.defaultState),{position:p}):air(p);
 f.enemy.position=new Vec3(4.5,1,.5);assert.equal(separated(f.bot,f.enemy,f.material),true);
 f.material.defensiveCoverBlocks=[0,1,2,3].map(y=>({item:'dirt',position:{x:2,y,z:0}}));
 assert.equal(separated(f.bot,f.enemy,f.material),false);
});

test('fresh arrow damage retains protection even when a static natural wall ray looks covered',()=>{
 const f=fixture(),air=f.bot.blockAt;
 f.bot.blockAt=p=>p.x===4?Object.assign(Block.fromStateId(registry.blocksByName.stone.defaultState),{position:p}):air(p);
 assert.equal(threat(f.bot,f.enemy,f.material,{ranged:true}),false);
 assert.equal(threat(f.bot,f.enemy,f.material,{ranged:true,recentDamage:true}),true);
});
