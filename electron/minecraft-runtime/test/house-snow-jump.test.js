/* global require */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Vec3}=require('vec3'),{Physics}=require('prismarine-physics');
const data=require('../test-support/whole30-saved-snow-jump.json');
const {inspectDryJumpSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(replacement, down=1){
 const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),controls=clone(data.controls),center=new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z).floored();
 const bot={version:'1.21.8',registry,jumpTicks:data.jumpTicks,jumpQueued:data.jumpQueued,fireworkRocketDuration:0,controlState:controls,inventory:{slots:Array(46).fill(null),items:()=>[]},entity:{...clone(data.initial),position:new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z),velocity:new Vec3(data.initial.velocity.x,data.initial.velocity.y,data.initial.velocity.z),yaw:data.yaw,pitch:data.pitch,height:1.8,width:.6,eyeHeight:1.62,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:false,elytraFlying:false,effects:{},attributes:{}}};
 bot.blockAt=raw=>{const p=raw.floored(),b=data.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)throw Object.assign(Error('Saved geometry unknown'),{code:'saved_fixture_unknown'});
  let state=data.palette[data.indices[((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ)]];
  if(replacement!==undefined&&p.x===center.x&&p.z===center.z&&p.y===center.y-down){if(replacement===null)return null;state=typeof replacement==='string'?{name:replacement,properties:{}}:replacement;}
  return Object.assign(Block.fromProperties(registry.blocksByName[state.name.replace(/^minecraft:/,'')].id,state.properties,0),{position:p});};
 const world={getBlock:bot.blockAt};bot.physics=Physics(registry,world);return bot;
}
const inspect=bot=>inspectDryJumpSupport(bot,{tick:data.physicsTick,lastGrounded:clone(data.lastGrounded)});
test('whole30 actual snow1 jump needs a loaded same-floor native landing without modifying actor',()=>{
 const bot=fixture(),before=clone(bot.entity),result=inspect(bot);
 assert.equal(data.actualOldReason,'jump_center_not_dry_air');assert.equal(result.accepted,true,JSON.stringify(result));
 assert.equal(result.predictionApplied,false);assert.ok(result.predictions.some(p=>p.onGround&&p.contacts.length));assert.deepEqual(clone(bot.entity),before);
 assert.equal(bot.entity.onGround,false);assert.ok(result.supports.every(s=>s.name!=='snow'));
});
for(const value of [null,'water','lava','bubble_column','stone','powder_snow','sweet_berry_bush'])test(`snow jump rejects unsafe or colliding center ${value}`,()=>{
 assert.equal(inspect(fixture(value)).accepted,false);
});
test('snow1 is clearance only; a vanished real lower contact cannot authorize jump',()=>{
 const bot=fixture(),original=bot.blockAt;bot.blockAt=p=>{const b=original(p);return p.y<data.initial.position.y&&b?.boundingBox==='block'?null:b;};assert.equal(inspect(bot).accepted,false);
});
test('snow layers2 through8 remain colliding clearance and never borrow the snow1 exception',()=>{
 for(let layers=2;layers<=8;layers++) assert.equal(inspect(fixture({name:'snow',properties:{layers:String(layers)}},2)).accepted,false);
});
test('actual snow jump retains the captured owner checks throughout pure native prediction',()=>{
 const bot=fixture(),before=clone(bot.entity);let reads=0;
 const result=inspectDryJumpSupport(bot,{tick:data.physicsTick,lastGrounded:clone(data.lastGrounded),isOwnerCurrent:()=>++reads<5});
 assert.equal(result.accepted,false);assert.equal(result.reason,'dry_graph_movement_preempted');assert.deepEqual(clone(bot.entity),before);
});
