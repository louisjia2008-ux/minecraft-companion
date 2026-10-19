'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectSurvivalJob,createSurvivalScheduler,surfaceReserveTarget}=require('../vendor/server/minecraft/survivalScheduler');
const base={health:20,food:20,safe:true,threat:false,hasMeal:false,canProvision:true,reserveLow:false};
test('a loaded nearby food opportunity can stock a small reserve without making empty reserves a work prerequisite',()=>{
 assert.equal(selectSurvivalJob({...base,reserveLow:true,localFoodAvailable:true}),'provision');
 assert.equal(selectSurvivalJob({...base,reserveLow:true,localFoodAvailable:false}),'foreground');
 assert.equal(selectSurvivalJob({...base,reserveLow:false,localFoodAvailable:true}),'foreground');
 assert.equal(selectSurvivalJob({...base,reserveLow:true,localFoodAvailable:true,threat:true}),'defend');
 assert.equal(selectSurvivalJob({...base,reserveLow:true,localFoodAvailable:true,food:17,hasMeal:true}),'eat');
 assert.equal(selectSurvivalJob({...base,reserveLow:true,localFoodAvailable:true,safe:false}),'foreground');
});
test('survival priorities use actual condition, not foreground task kind',()=>{
 assert.equal(selectSurvivalJob({...base,health:4,threat:true,reserveLow:true}),'defend');
 assert.equal(selectSurvivalJob({...base,health:4,food:17,hasMeal:true}),'eat');
 assert.equal(selectSurvivalJob({...base,health:4}),'recover');
 assert.equal(selectSurvivalJob({...base,health:14,food:15}),'foreground');
 assert.equal(selectSurvivalJob({...base,reserveLow:true}),'foreground');
 assert.equal(selectSurvivalJob(base),'foreground');
 assert.equal(selectSurvivalJob({...base,safe:false,reserveLow:true}),'foreground');
 assert.equal(selectSurvivalJob({...base,health:0}),'unavailable');
});
test('defense interrupts food work; fresh observations resume recovery then original task',async()=>{
 const s={...base,health:4,food:16,hasMeal:true,threat:true,reserveLow:true},actions=[];
 const q=createSurvivalScheduler({observe:()=>s,assertActive(){},defend:async()=>{actions.push('defend');s.threat=false;},
 eat:async()=>{actions.push('eat');s.food=20;s.hasMeal=false;},recover:async()=>{actions.push('recover');s.health=18;},
 provision:async()=>{actions.push('provision');s.reserveLow=false;s.food=12;}});
 assert.deepEqual(await q.runBoundary(),{ready:true});assert.deepEqual(actions,['defend','eat','recover']);
});
test('concurrent observation cannot start a second movement owner; pause wins over automatic continuation',async()=>{
 let unblock,paused=false,writes=0;const s={...base,food:6,reserveLow:true};
 const q=createSurvivalScheduler({observe:()=>s,assertActive(){if(paused)throw Object.assign(Error('paused'),{code:'paused'});},
 provision:async()=>{writes++;await new Promise(r=>{unblock=r;});s.reserveLow=false;s.food=12;}});
 const pending=q.runBoundary();assert.equal(q.observe().activeJob,'provision');
 await assert.rejects(q.runBoundary(),{code:'survival_boundary_busy'});assert.equal(writes,1);
 paused=true;unblock();await assert.rejects(pending,{code:'paused'});assert.equal(q.observe().activeJob,null);
});
test('unchanged postcondition never silently completes or spins forever',async()=>{
 let writes=0;const q=createSurvivalScheduler({observe:()=>({...base,threat:true}),assertActive(){},defend:async()=>{writes++;}});
 await assert.rejects(q.runBoundary(),{code:'survival_boundary_limit'});assert.equal(writes,8);
});

test('surface provision stops at one useful cooked meal at working condition; deep reserves stay exact',()=>{
 const s={health:20,food:20,requestedPoints:8,maintenance:true};
 assert.equal(surfaceReserveTarget(s),4);
 for(const patch of [{health:5},{food:7},{maintenance:false}])assert.equal(surfaceReserveTarget({...s,...patch}),8);
 assert.equal(surfaceReserveTarget({...s,requestedPoints:24}),24);
 assert.equal(surfaceReserveTarget({...s,health:8,food:12}),4);
 assert.equal(selectSurvivalJob({...base,hasMeal:true,reserveLow:false}), 'foreground');
});

test('ordinary work tolerates partial health and zero spare food but critical deficits preempt',()=>{
 for(const health of [6,8,13,17,20])for(const food of [8,12,17,20])assert.equal(selectSurvivalJob({...base,health,food,reserveLow:true}),health<14?(food<18?'provision':'recover'):'foreground');
 assert.equal(selectSurvivalJob({...base,health:6.067,food:16}),'provision','Low health without regeneration must seek a meal before another bulk resource trip');
 assert.equal(selectSurvivalJob({...base,health:5,food:16}),'provision');
 assert.equal(selectSurvivalJob({...base,health:5,food:20}),'recover');
 assert.equal(selectSurvivalJob({...base,health:13,food:7}),'provision');
});

test('an empty-handed survivor at7HP chooses local prerequisites rather than a distant old route',()=>{
 const {shouldBootstrapField}=require('../vendor/server/minecraft/survivalScheduler');
 const facts={health:6.833,food:17,campDistance:105,hasWeapon:false,hasPick:false,grounded:true,dryFoot:true};
 assert.equal(shouldBootstrapField(facts),true);
 for(const change of [{health:0},{food:7},{campDistance:12},{hasWeapon:true},{hasPick:true},{grounded:false},{dryFoot:false}])assert.equal(shouldBootstrapField({...facts,...change}),false);
});

test('empty-handed maintenance restores a locally eaten meal without claiming spare food or requiring camp return',async()=>{
 const {restoreLocalSurvivalMeal}=require('../vendor/server/minecraft/survivalScheduler');
 const facts={maintenance:true,hasWeapon:false,health:7,food:17};let calls=0;
 const deps={assertActive(){},observe:()=>({...facts}),acquireAndEat:async()=>{calls++;facts.food=20;}};
 const result=await restoreLocalSurvivalMeal(deps);assert.equal(calls,1);assert.equal(result.food,20);assert.equal(result.reserveConfirmed,false);assert.equal(facts.health,7);
 assert.equal(await restoreLocalSurvivalMeal(deps),null);
 facts.food=17;deps.acquireAndEat=async()=>{};await assert.rejects(restoreLocalSurvivalMeal(deps),{code:'house_local_meal_unconfirmed'});
 facts.hasWeapon=true;assert.equal(await restoreLocalSurvivalMeal(deps),null);
});

test('actual carried emergency chicken is edible at7HP/16food, while safer ready food wins and dead actors refuse',()=>{
 const {selectBootstrapFood}=require('../vendor/server/minecraft/survivalScheduler');
 const chicken={name:'chicken',count:2},flesh={name:'rotten_flesh',count:1},bread={name:'bread',count:1},cooked={name:'cooked_chicken',count:1};
 assert.equal(selectBootstrapFood([chicken],{health:7.233,food:16}),chicken);
 assert.equal(selectBootstrapFood([flesh,chicken],{health:7,food:17}),chicken);
 assert.equal(selectBootstrapFood([chicken,bread],{health:7,food:16}),bread);
 assert.equal(selectBootstrapFood([chicken,cooked],{health:7,food:16}),cooked);
 assert.equal(selectBootstrapFood([chicken],{health:14,food:16}),chicken);
 assert.equal(selectBootstrapFood([chicken],{health:20,food:16}),null);
 assert.equal(selectBootstrapFood([flesh],{health:12.7,food:17}),flesh);
 assert.equal(selectBootstrapFood([chicken],{health:14,food:6}),chicken);
 assert.equal(selectBootstrapFood([bread],{health:0,food:6}),null);
});

test('observed half-health hunger deficit seeks food, then recovers to14 before ordinary work',()=>{
 assert.equal(selectSurvivalJob({...base,health:10.853,food:16,hasMeal:false}),'provision');
 assert.equal(selectSurvivalJob({...base,health:10.853,food:18,hasMeal:false}),'recover');
});

test('an armed7HP survivor eats already carried emergency food locally before a remote food hunt',async()=>{
 const {restoreLocalSurvivalMeal}=require('../vendor/server/minecraft/survivalScheduler');
 let food=17,eaten=0;const result=await restoreLocalSurvivalMeal({assertActive:()=>{},
  observe:()=>({maintenance:true,hasWeapon:true,hasEmergencyMeal:true,health:7.6165,food}),
  acquireAndEat:async()=>{eaten++;food=20;}});
 assert.equal(eaten,1);assert.equal(result.localMealConfirmed,true);assert.equal(result.reserveConfirmed,false);assert.equal(result.food,20);
 let wrongCalls=0;assert.equal(await restoreLocalSurvivalMeal({assertActive:()=>{},
  observe:()=>({maintenance:true,hasWeapon:true,hasEmergencyMeal:false,health:7.6,food:17}),acquireAndEat:async()=>{wrongCalls++;}}),null);
 assert.equal(wrongCalls,0);
});

test('recorded9.8HP and2.52HP with19 hunger recover before ordinary work',()=>{for(const health of [9.8,2.52])assert.equal(selectSurvivalJob({...base,health,food:19}),'recover');assert.equal(selectSurvivalJob({...base,health:14,food:19}),'foreground');});

test('a usable owned bootstrap-stock visit hint avoids field wood harvesting without granting carried materials',()=>{
 const {shouldBootstrapField}=require('../vendor/server/minecraft/survivalScheduler');
 const facts={health:20,food:20,campDistance:58,hasWeapon:false,hasPick:false,grounded:true,dryFoot:true};
 assert.equal(shouldBootstrapField(facts),true);assert.equal(shouldBootstrapField({...facts,ownedBootstrapStockHint:true}),false);
 assert.equal(facts.hasWeapon,false);assert.equal(facts.hasPick,false);
});
