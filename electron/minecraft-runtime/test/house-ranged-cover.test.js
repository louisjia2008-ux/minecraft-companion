'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Vec3}=require('vec3');
const {findHouseRangedThreat,rangedCoverConfirmed,cardinalCoverPath}=require('../vendor/server/minecraft/houseRangedCover');
const {findExposedHouseRangedThreat,deferHouseRangedPursuit,clearHouseRangedPursuits}=require('../vendor/server/minecraft/houseRangedCover');
function pursuitFixture(){const target={id:1,name:'skeleton',isValid:true,position:new Vec3(23,0,0)};
 const bot={health:20,entity:{position:new Vec3(0,0,0)},entities:{1:target},blockAt:p=>({name:'air',position:p,shapes:[]})};return{bot,target};}
test('failed distant proactive pursuit yields to work while the observed attacker remains available',()=>{
 const {bot,target}=pursuitFixture();assert.equal(findExposedHouseRangedThreat(bot),target);
 assert.equal(deferHouseRangedPursuit(bot,target),true);assert.equal(findExposedHouseRangedThreat(bot),null);
 assert.equal(findHouseRangedThreat(bot),target);assert.equal(findExposedHouseRangedThreat(pursuitFixture().bot)?.id,1);
});
for(const trigger of ['damage_event','health_drop','close_contact','target_moved','retry_deadline'])test(`deferred pursuit rearms on ${trigger}`,()=>{
 const {bot,target}=pursuitFixture();deferHouseRangedPursuit(bot,target,trigger==='retry_deadline'?Date.now()-30001:Date.now());
 if(trigger==='damage_event')clearHouseRangedPursuits(bot);
 if(trigger==='health_drop')bot.health=19;
 if(trigger==='close_contact')target.position.x=8;
 if(trigger==='target_moved')target.position.x=19;
 assert.equal(findExposedHouseRangedThreat(bot),target);
});
test('native diagonal cover paths require an actually safe cardinal intermediate',()=>{
 const from={x:0,y:64,z:0},target={x:1,y:65,z:1};
 assert.deepEqual(cardinalCoverPath([target],from,p=>!(p.x===1&&p.z===0)),[
  {x:0,y:64,z:1},target]);
 assert.equal(cardinalCoverPath([target],from,p=>p.y===65),null);
 assert.equal(cardinalCoverPath([{x:1,y:62,z:0}],from,()=>true),null);
 assert.equal(cardinalCoverPath([{x:1,y:64,z:0}],from,()=>false),null);
});
test('a drowned with an observed trident receives ranged perception before it reaches melee range',()=>{
 const bot={entity:{position:new Vec3(0,0,0)},entities:{}};
 const e={id:1,name:'drowned',position:new Vec3(18,0,0),heldItem:{name:'trident'},isValid:true};bot.entities[1]=e;
 assert.equal(findHouseRangedThreat(bot),e);e.heldItem=null;assert.equal(findHouseRangedThreat(bot),null);
 e.equipment=[{name:'trident'}];assert.equal(findHouseRangedThreat(bot),e);e.isValid=false;assert.equal(findHouseRangedThreat(bot),null);
});
test('24m ranged perception is independent of inventory and keeps height, validity and loaded entity bounds',()=>{
 const bot={entity:{position:new Vec3(0,0,0)},entities:{},inventory:{items:()=>[]}};
 const target={id:1,name:'skeleton',isValid:true,position:new Vec3(23,0,0)};bot.entities[1]=target;
 assert.equal(findHouseRangedThreat(bot),target);
 target.position.x=24.01;assert.equal(findHouseRangedThreat(bot),null);
 target.position.set(10,9,0);assert.equal(findHouseRangedThreat(bot),null);
 target.position.set(10,0,0);target.isValid=false;assert.equal(findHouseRangedThreat(bot),null);
 target.isValid=true;target.name='cow';assert.equal(findHouseRangedThreat(bot),null);
});
test('cover needs real observed collision on every body ray; unknown air or a second exposed shooter cannot pass',()=>{
 let unknown=false;const bot={blockAt:p=>unknown?null:{position:p,shapes:p.x===4&&p.y>=0&&p.y<=2?[[0,0,0,1,1,1]]:[]}};
 const p=new Vec3(.5,0,.5),first={position:new Vec3(12.5,0,.5),height:1.99};
 assert.equal(rangedCoverConfirmed(bot,p,[first]),true);
 assert.equal(rangedCoverConfirmed(bot,p,[first,{position:new Vec3(-12.5,0,.5),height:1.99}]),false);
 unknown=true;assert.equal(rangedCoverConfirmed(bot,p,[first]),false);
 assert.equal(rangedCoverConfirmed(bot,p,[]),false);
});

test('a potion-throwing witch is perceived before melee range and an arrow ray wall cannot certify splash protection',()=>{
 const {bot,target}=pursuitFixture();target.name='witch';target.position.x=10;
 assert.equal(findHouseRangedThreat(bot),target);assert.equal(findExposedHouseRangedThreat(bot),target);
 bot.blockAt=p=>({position:p,shapes:[[0,0,0,1,1,1]]});
 assert.equal(rangedCoverConfirmed(bot,bot.entity.position,[target]),false);
 const {shouldPressHouseRanged,shouldInterruptWorkForRanged}=require('../vendor/server/minecraft/houseRangedCombat');
 bot.inventory={items:()=>[{name:'iron_sword'}],slots:Array(46).fill(null)};bot.registry={items:{}};
 assert.equal(shouldInterruptWorkForRanged(bot,target,true),true);
 bot.health=7;target.position.x=6;
 bot.inventory.slots[45]={name:'shield',type:1};bot.registry.items[1]={maxDurability:336};
 assert.equal(shouldPressHouseRanged(bot,target),false);
 bot.health=20;assert.equal(shouldPressHouseRanged(bot,target),true);
});
