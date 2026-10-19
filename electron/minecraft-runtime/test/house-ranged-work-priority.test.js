'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {shouldInterruptWorkForRanged}=require('../vendor/server/minecraft/houseRangedCombat');
function fixture(distance,health=20){return {bot:{health,entity:{position:new Vec3(0,64,0)},inventory:{items:()=>[{name:'iron_sword'}],slots:[]},registry:{items:{}}},target:{isValid:true,position:new Vec3(distance,64,0)}};}
test('24m perception does not force repeated distant unprovoked work interruptions',()=>{const f=fixture(22);assert.equal(shouldInterruptWorkForRanged(f.bot,f.target),false);});
test('actual damage immediately enables the observed distant attacker response',()=>{const f=fixture(22,8);assert.equal(shouldInterruptWorkForRanged(f.bot,f.target,true),true);});
test('close contact interrupts at low health, while a viable nearby engagement still interrupts',()=>{
 const close=fixture(3,2),near=fixture(12);assert.equal(shouldInterruptWorkForRanged(close.bot,close.target),true);assert.equal(shouldInterruptWorkForRanged(near.bot,near.target),true);
});
