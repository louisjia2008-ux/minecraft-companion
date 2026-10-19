'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {approachHouseRanged}=require('../vendor/server/minecraft/houseMeleeApproach');
for(const health of [16,9])test(`engagement callback cannot override observed pursuit damage budget at health ${health}`,async()=>{
 const bot={health:20,entity:{position:new Vec3(0,64,0)},pathfinder:{movements:{}},_client:{},entities:{}};
 const target={position:new Vec3(15,64,0)};
 await assert.rejects(approachHouseRanged({getBot:()=>bot,getThreat:()=>target,
  assertActive:()=>{bot.health=health;},canContinueEngagement:()=>true},
 {origin:bot.entity.position,deadline:Date.now()+10000}),{code:'house_surface_ranged_injured'});
});
