'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareHouseRecovery}=require('../vendor/server/minecraft/houseRecoveryPreparation');
function fixture(){let clock=0;const state={health:12,food:17,safe:true,threat:false},f={state,meals:0,waits:0};
 f.deps={assertActive:()=>{},observe:()=>({...state}),hasFood:()=>true,eat:async()=>{f.meals++;state.food=20;},now:()=>clock,wait:async ms=>{clock+=ms;f.waits++;state.health++;}};return f;}
test('carried food and observed natural health increments precede return readiness',async()=>{const f=fixture(),r=await prepareHouseRecovery(f.deps);assert.equal(r.health,18);assert.equal(r.initialHealth,12);assert.equal(f.meals,1);assert.equal(f.waits,6);});
test('safe armed provisioning can continue when the available health is adequate but carried food is exhausted',async()=>{
 const f=fixture();f.state.health=15;f.deps.hasFood=()=>false;f.deps.canProvision=()=>true;
 const r=await prepareHouseRecovery(f.deps);assert.equal(r.needsProvision,true);assert.equal(r.recovered,false);assert.equal(f.waits,0);
});
test('critical recovery can hand off to no-tool food acquisition without waiting for furnace or full health',async()=>{
 const f=fixture();f.state.health=4;f.state.food=17;f.deps.targetHealth=6;f.deps.hasFood=()=>false;
 f.deps.canProvision=()=>true;f.deps.provisionMinimumHealth=()=>1;
 const result=await prepareHouseRecovery(f.deps);assert.equal(result.needsProvision,true);assert.equal(f.waits,0);assert.equal(f.meals,0);
 assert.equal(f.state.health,4);assert.equal(f.state.food,17);
});
for(const mode of ['low-health','unavailable-provision','threat'])test(`food handoff refuses ${mode}`,async()=>{
 const f=fixture();f.state.health=mode==='low-health'?13:15;f.state.threat=mode==='threat';f.deps.hasFood=()=>false;f.deps.canProvision=()=>mode!=='unavailable-provision';
 await assert.rejects(prepareHouseRecovery(f.deps),{code:mode==='threat'?'house_recovery_unsafe':'house_recovery_food_missing'});
});
test('owned shield posture can observe recovery under one ranged threat without lowering shield to eat',async()=>{
 const f=fixture();f.state.food=19;f.state.threat=true;let blocks=0;
 f.deps.defend=async()=>{blocks++;f.state.blocking=true;};
 const r=await prepareHouseRecovery(f.deps);assert.equal(r.health,18);assert.ok(blocks>0);assert.equal(f.meals,0);
});
test('shield posture never hides actual damage while waiting',async()=>{
 const f=fixture();f.state.food=19;f.state.threat=true;f.deps.defend=async()=>{f.state.blocking=true;};f.deps.wait=async()=>{f.state.health--;};
 await assert.rejects(prepareHouseRecovery(f.deps),{code:'house_recovery_damage'});
});
test('actually confirmed cover permits eating without pretending the ranged enemy disappeared',async()=>{
 const f=fixture();f.state.threat=true;f.state.covered=true;const r=await prepareHouseRecovery(f.deps);
 assert.equal(r.health,18);assert.equal(f.state.threat,true);assert.equal(f.meals,1);
});
for(const mode of ['threat','unsafe','food','damage','timeout','cancel'])test(`passive recovery refuses ${mode} without granting readiness`,async()=>{
 const f=fixture();let expected;
 if(mode==='threat'){f.state.threat=true;expected='house_recovery_unsafe';}
 if(mode==='unsafe'){f.state.safe=false;expected='house_recovery_unsafe';}
 if(mode==='food'){f.deps.hasFood=()=>false;expected='house_recovery_food_missing';}
 if(mode==='damage'){f.deps.wait=async()=>{f.state.health--;};expected='house_recovery_damage';}
 if(mode==='timeout'){f.deps.wait=async()=>{};let n=0;f.deps.now=()=>n++?60000:0;expected='house_recovery_timeout';}
 if(mode==='cancel'){f.deps.eat=async()=>{f.deps.assertActive=()=>{throw Object.assign(Error('paused'),{code:'paused'});};};expected='paused';}
 await assert.rejects(prepareHouseRecovery(f.deps),{code:expected});
});

test('surface critical recovery stops at six actual health, without waiting for full recovery',async()=>{
 const f=fixture();f.state.health=3;f.deps.targetHealth=6;const result=await prepareHouseRecovery(f.deps);
 assert.equal(result.health,6);assert.equal(f.waits,3);
 const ordinary=fixture();ordinary.deps.targetHealth=6;await prepareHouseRecovery(ordinary.deps);assert.equal(ordinary.waits,0);assert.equal(ordinary.meals,0);
});

test('an actually living fractional-health survivor hands off to guarded no-tool food rather than waiting forever',async()=>{
 const f=fixture();f.state.health=1/6;f.state.food=16;f.deps.targetHealth=6;f.deps.hasFood=()=>false;f.deps.canProvision=()=>true;f.deps.provisionMinimumHealth=()=>Number.MIN_VALUE;
 const result=await prepareHouseRecovery(f.deps);assert.equal(result.needsProvision,true);assert.equal(result.health,1/6);assert.equal(f.waits,0);assert.equal(f.meals,0);
 f.state.health=0;await assert.rejects(prepareHouseRecovery(f.deps),{code:'house_recovery_unknown'});
});

for(const mode of ['handled','unhandled','pause','unsafe','deadline'])test(`world133 native damage hands passive recovery back only after owned defense: ${mode}`,async()=>{
 const f=fixture();f.state.food=20;let first=true,defended=0,expired=false;const wait=f.deps.wait,now=f.deps.now;f.deps.now=()=>expired?60001:now();
 f.deps.wait=async ms=>{await wait(ms);if(first){first=false;f.state.health-=3;}};
 f.deps.defend=async()=>{defended++;if(mode==='pause')throw Object.assign(Error('paused'),{code:'paused'});if(mode==='unsafe')f.state.safe=false;if(mode==='deadline')expired=true;return mode!=='unhandled';};
 if(mode==='handled'){const r=await prepareHouseRecovery(f.deps);assert.equal(r.health,18);assert.equal(defended,1);assert.ok(f.waits>6);}
 else await assert.rejects(prepareHouseRecovery(f.deps),{code:{unhandled:'house_recovery_damage',pause:'paused',unsafe:'house_recovery_unsafe',deadline:'house_recovery_timeout'}[mode]});
});
