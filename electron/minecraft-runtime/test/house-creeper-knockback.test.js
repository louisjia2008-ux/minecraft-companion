'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3'),{EventEmitter}=require('node:events');
const {strikeCreeperBeforeRetreat,strikeImmediateCloseCreeper}=require('../vendor/server/minecraft/houseCreeperKnockback');
function fixture(){let clock=0,paused=false;const target={position:new Vec3(2.5,1,0)},bot=Object.assign(new EventEmitter(),{health:20,entity:{position:new Vec3(0,1,0)}});
 const writes=[],f={target,bot,writes,pause:()=>{paused=true;}};
 f.deps={getBot:()=>bot,getThreat:()=>target,assertActive(){if(paused)throw Object.assign(Error('paused'),{code:'paused'});},
 now:()=>clock,wait:async ms=>{clock+=ms;},look:async()=>{},equipSword:async()=>{writes.push('equip');},
 shield:async raised=>{writes.push(raised?'shield_on':'shield_off');},attack:async()=>{writes.push('attack');}};return f;}
for(const moved of [false,true])test(`one sword swing requires observed outward enemy movement for knockback credit (${moved})`,async()=>{
 const f=fixture();f.deps.attack=async()=>{f.writes.push('attack');if(moved){f.target.position.x+=.5;f.bot.emit('entityHurt',f.target);}};
 const r=await strikeCreeperBeforeRetreat(f.deps,{deadline:8000});assert.equal(r.knockbackObserved,moved);assert.equal(r.deathConfirmed,false);
 assert.deepEqual(f.writes,['equip','shield_off','attack','shield_on']);assert.equal(f.bot.entity.position.x,0);
});
test('pause or changed charged-creeper eligibility cannot send a late swing',async()=>{
 const f=fixture();f.deps.equipSword=async()=>{f.pause();};await assert.rejects(strikeCreeperBeforeRetreat(f.deps,{deadline:8000}),{code:'paused'});assert.deepEqual(f.writes,[]);
 const g=fixture();g.deps.canStrike=()=>false;const r=await strikeCreeperBeforeRetreat(g.deps,{deadline:8000});assert.equal(r.attacked,false);assert.deepEqual(g.writes,[]);
});
test('no fresh reachable target cannot become permission to chase or wait past the original budget',async()=>{
 const f=fixture();f.target.position.x=6;
 const r=await strikeCreeperBeforeRetreat(f.deps,{deadline:2500});assert.equal(r.attacked,false);assert.equal(r.reason,'bounded_approach_wait_expired');assert.deepEqual(f.writes,[]);
});

test('outward movement without target hurt receipt is never labeled confirmed knockback',async()=>{
 const f=fixture();f.deps.attack=async()=>{f.writes.push('attack');f.target.position.x+=.5;};
 const r=await strikeCreeperBeforeRetreat(f.deps,{deadline:8000});assert.equal(r.knockbackObserved,false);assert.equal(r.hurtObserved,false);assert.equal(r.observedOutwardDisplacement,.5);
 assert.equal(f.bot.listenerCount('entityHurt'),0);
});

test('emergency close strike uses an empty hand at low health without waiting for equipment or claiming knockback',async()=>{
 const f=fixture();f.target.name='creeper';f.target.id=2;f.bot.health=2;f.deps.canStrike=()=>true;
 const r=await strikeImmediateCloseCreeper(f.deps,{deadline:Date.now()+1000});
 assert.equal(r.attacked,true);assert.equal(r.knockbackObserved,false);assert.deepEqual(f.writes,['attack']);
 f.target.position.x=4;assert.equal((await strikeImmediateCloseCreeper(f.deps,{deadline:Date.now()+1000})).attacked,false);
 f.target.position.x=2;f.pause();await assert.rejects(strikeImmediateCloseCreeper(f.deps,{deadline:Date.now()+1000}),{code:'paused'});
 assert.equal(f.writes.length,1);
});
