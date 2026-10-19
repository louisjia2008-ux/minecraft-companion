/* global require */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Vec3}=require('vec3'),{Physics}=require('prismarine-physics');
const data=require('../test-support/whole27-saved-vine-descent.json');
const {inspectDryDescentSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(replacement){
 const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),controls=clone(data.controls),center=new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z).floored();
 const bot={version:'1.21.8',registry,jumpTicks:data.jumpTicks,jumpQueued:data.jumpQueued,fireworkRocketDuration:0,controlState:controls,inventory:{slots:Array(46).fill(null),items:()=>[]},entity:{...clone(data.initial),position:new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z),velocity:new Vec3(data.initial.velocity.x,data.initial.velocity.y,data.initial.velocity.z),yaw:data.yaw,pitch:data.pitch,height:1.8,width:.6,eyeHeight:1.62,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:false,elytraFlying:false,effects:{},attributes:{}}};
 bot.blockAt=raw=>{const p=raw.floored(),b=data.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)throw Object.assign(Error('Saved geometry unknown'),{code:'saved_fixture_unknown'});
  let state=data.palette[data.indices[((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ)]];
  if(replacement!==undefined&&p.x===center.x&&p.z===center.z&&p.y===center.y-1){if(replacement===null)return null;state={name:replacement,properties:{}};}
  return Object.assign(Block.fromProperties(registry.blocksByName[state.name.replace(/^minecraft:/,'')].id,state.properties,0),{position:p});};
 const world={getBlock:bot.blockAt};bot.physics=Physics(registry,world);return bot;
}
const inspect=bot=>inspectDryDescentSupport(bot,{tick:data.physicsTick,lastGrounded:clone(data.lastGrounded)});
test('whole27 actual vine descent needs a loaded same-floor native landing without modifying actor',()=>{
 const bot=fixture(),before=clone(bot.entity),result=inspect(bot);
 assert.equal(data.actualOldReason,'descent_center_not_dry_air');assert.equal(result.accepted,true,JSON.stringify(result));
 assert.equal(result.predictionApplied,false);assert.ok(result.predictions.some(p=>p.onGround&&p.sameFloor));assert.deepEqual(clone(bot.entity),before);
 assert.equal(bot.entity.onGround,false);assert.ok(result.supports.every(s=>s.name!=='vine'));
});
for(const value of [null,'water','lava','bubble_column','stone','powder_snow','sweet_berry_bush'])test(`vine descent rejects unsafe or colliding center ${value}`,()=>{
 assert.equal(inspect(fixture(value)).accepted,false);
});
test('vine is clearance only; a vanished real lower contact cannot authorize descent',()=>{
 const bot=fixture(),original=bot.blockAt;bot.blockAt=p=>{const b=original(p);return p.y<data.initial.position.y&&b?.boundingBox==='block'?null:b;};assert.equal(inspect(bot).accepted,false);
});
