'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {inspectDryJumpSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const data=require('../test-support/development08-saved-airborne.json');
function fixture(){
 const {bot}=require('../test-support/whole11-saved-dry-jump.cjs').createSavedJumpFixture({controls:data.controls});
 const b=data.bounds,ny=b.maxY-b.minY+1,nz=b.maxZ-b.minZ+1;
 bot.blockAt=q=>{const p=q.floored();if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;const s=data.palette[data.indices[(p.x-b.minX)*ny*nz+(p.y-b.minY)*nz+p.z-b.minZ]];return Object.assign(Block.fromProperties(registry.blocksByName[s.name.replace(/^minecraft:/,'')].id,s.properties,0),{position:p});};
 bot.entity.position=new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z);bot.entity.velocity=new Vec3(data.initial.velocity.x,data.initial.velocity.y,data.initial.velocity.z);Object.assign(bot.entity,{onGround:data.initial.onGround,isInWater:data.initial.isInWater,isInLava:data.initial.isInLava,yaw:data.yaw,pitch:data.pitch});bot.jumpTicks=data.jumpTicks;bot.jumpQueued=data.jumpQueued;
 return {bot,options:{tick:data.physicsTick,lastGrounded:JSON.parse(JSON.stringify(data.lastGrounded)),allowSteppedJump:true}};
}
test('saved stepped apex predicts actual dry one-level landing without writing the actor',()=>{
 const {bot,options}=fixture(),before=JSON.stringify({entity:bot.entity,controls:bot.controlState});
 const result=inspectDryJumpSupport(bot,options);assert.equal(result.accepted,true);assert.equal(result.predictionApplied,false);assert.equal(result.predictions.at(-1).position.y,63);assert.equal(result.predictions.at(-1).bodyDry,true);
 assert.equal(JSON.stringify({entity:bot.entity,controls:bot.controlState}),before);
});
test('ordinary jump callers retain the original height limit',()=>{const {bot,options}=fixture();assert.equal(inspectDryJumpSupport(bot,{...options,allowSteppedJump:false}).accepted,false);});
test('stepped observation cannot authorize a stronger fresh upward impulse',()=>{const {bot,options}=fixture();bot.entity.velocity.y=.2;assert.equal(inspectDryJumpSupport(bot,options).accepted,false);});
for(const unsafe of ['water','lava','unknown'])test(`stepped jump refuses ${unsafe} landing`,()=>{
 const {bot,options}=fixture(),read=bot.blockAt;bot.blockAt=q=>{const p=q.floored();if(p.x===-111&&p.y===62&&p.z===-129)return unsafe==='unknown'?null:Object.assign(Block.fromStateId(registry.blocksByName[unsafe].defaultState),{position:p});return read(q);};assert.equal(inspectDryJumpSupport(bot,options).accepted,false);
});
test('stepped observation cannot borrow a foreign movement owner',()=>{const {bot,options}=fixture();assert.equal(inspectDryJumpSupport(bot,{...options,isOwnerCurrent:()=>false}).accepted,false);});
