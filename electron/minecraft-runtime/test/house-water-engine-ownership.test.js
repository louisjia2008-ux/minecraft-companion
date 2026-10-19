/* global require, setTimeout */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {engineFixture,Vec3,Movements,goals}=require('../test-support/house-water-engine-native-fixture.cjs');
const {routeFrame}=require('../vendor/server/minecraft/houseShallowWaterTraversal');
const {hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,ms=4000){const deadline=Date.now()+ms;while(!predicate()&&Date.now()<deadline)await sleep(3);assert.ok(predicate(),'bounded actual native condition observed');}
const wetInside=f=>f.bot.entity.isInWater&&routeFrame(f.route).u(f.bot.entity.position)>4;
const dryAt=(f,p)=>f.bot.entity.position.floored().equals(new Vec3(p.x,p.y,p.z))&&hasGroundedBodySupport(f.bot)&&!f.bot.entity.isInWater&&!f.bot.entity.isInLava;
async function createHold(f){const running=f.agent.__testHouseSurfaceWater(f.route).then(value=>({value}),error=>({error}));await until(()=>wetInside(f));f.setUnknownHead(true);const outcome=await running;assert.equal(outcome.error?.code,'house_surface_water_body_unsafe');const frame=f.agent.__testGetHouseWaterFrame();assert.ok(frame?.session.isHolding());assert.equal(frame.isPhysicalOwner(),true);assert.equal(f.bot.controlState.jump,true);return {frame,error:outcome.error};}

test('production water binding completes native narrow sandbank out/back and restores its profile',{timeout:8000},async t=>{
 const f=engineFixture(t);const out=await f.agent.__testHouseSurfaceWater(f.route);assert.equal(out.confirmed,true);assert.ok(dryAt(f,f.route.to));assert.equal(f.agent.__testGetHouseWaterFrame(),null);assert.equal(f.bot.pathfinder.movements,f.originalProfile);
 const back=await f.agent.__testHouseSurfaceWater({...f.route,from:f.route.to,to:f.route.from});assert.equal(back.confirmed,true);assert.ok(dryAt(f,f.route.from));assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.pathfinder.movements,f.originalProfile);
});
for(const action of['pause','cancel'])test(`public ${action} revokes generation/lease only after actual native dry retreat`,{timeout:8000},async t=>{
 const f=engineFixture(t),generation=f.task.executionGeneration,lease=f.task.movementLease;
 const running=f.agent.__testHouseSurfaceWater(f.route).then(value=>({value}),error=>({error}));await until(()=>wetInside(f));
 const stopping=f.agent.handleMessage({type:`mc_command_${action}`});
 assert.equal(f.task.executionGeneration,generation);assert.equal(f.agent.__testGetActiveMovementLease(),lease);assert.ok(f.agent.__testGetHouseWaterFrame());assert.equal(f.bot.entity.isInWater,true);
 await stopping;const outcome=await running;assert.equal(outcome.error?.code,action==='pause'?'paused':'cancelled');assert.ok(dryAt(f,f.route.from));assert.equal(f.agent.__testGetHouseWaterFrame(),null);assert.ok(f.task.executionGeneration>generation);assert.equal(f.agent.__testGetActiveMovementLease(),null);
 if(action==='pause')assert.equal(f.agent.__testGetReconnectTask(),f.task);else assert.equal(f.agent.__testGetReconnectTask(),null);
});

test('actual timeout returns dry without falsely marking the restored own profile as foreign',{timeout:8000},async t=>{
 const f=engineFixture(t),outcome=await f.agent.__testHouseSurfaceWater({...f.route,timeoutMs:180}).then(value=>({value}),error=>({error}));assert.equal(outcome.error?.code,'house_surface_water_timeout');assert.equal(outcome.error.houseWaterForeignActor===true,false);assert.ok(dryAt(f,f.route.from));assert.equal(f.bot.pathfinder.movements,f.originalProfile);
});

test('blocked native retreat retains exact HOLD through public pause and generic profile initialization',{timeout:8000},async t=>{
 const f=engineFixture(t),{frame}=await createHold(f),profile=f.bot.pathfinder.movements,lease=f.task.movementLease,generation=f.task.executionGeneration;
 const at=f.writes.length;assert.equal(f.agent.initializeBotRuntime(),true);await f.agent.handleMessage({type:'mc_command_pause'});await sleep(35);
 assert.equal(f.agent.__testGetHouseWaterFrame(),frame);assert.equal(frame.session.isHolding(),true);assert.equal(frame.isPhysicalOwner(),true);assert.equal(f.task.errorCode,'house_surface_water_cleanup_pending');assert.equal(f.task.executionGeneration,generation);assert.equal(f.agent.__testGetActiveMovementLease(),lease);assert.equal(f.bot.pathfinder.movements,profile);assert.equal(f.bot.controlState.jump,true);assert.deepEqual(f.writes.slice(at),[]);
});

test('foreign lease after settled HOLD drops only old frame; native new owner returns dry and new task can cross',{timeout:10000},async t=>{
 const f=engineFixture(t),{frame}=await createHold(f);f.setUnknownHead(false);const foreign=f.takeover();
 await f.agent.handleMessage({type:'mc_command_cancel'});assert.equal(f.agent.__testGetHouseWaterFrame(),null);assert.equal(frame.closed,true);assert.equal(f.agent.__testGetActiveMovementLease(),foreign.lease);assert.equal(f.bot.pathfinder.movements,foreign.profile);assert.equal(f.bot.controlState.jump,true);assert.deepEqual(f.writes.slice(foreign.traceIndex),[]);
 // New owner uses original native pathfinder/Physics; no position patch or
 // successful-arrival stub is used to regain the dry start.
 const dry=new Movements(f.bot);dry.canDig=false;dry.scafoldingBlocks=[];dry.allowParkour=false;dry.allowSprinting=false;dry.getMoveDiagonal=()=>{};f.bot.pathfinder.setMovements(dry);
 await f.bot.pathfinder.goto(new goals.GoalBlock(f.route.from.x,f.route.from.y,f.route.from.z));await until(()=>dryAt(f,f.route.from));
 f.makeTask('water-new-owner');const next=await f.agent.__testHouseSurfaceWater(f.route);assert.equal(next.confirmed,true);assert.ok(dryAt(f,f.route.to));assert.equal(f.agent.__testGetHouseWaterFrame(),null);
});

for(const kind of['manual','escort'])test(`actual full task catch preserves same-generation foreign ${kind} actor controls/profile/lease`,{timeout:8000},async t=>{
 const f=engineFixture(t);const running=f.agent.__testRunTaskExecution(f.task,{executeStep:()=>f.agent.__testHouseSurfaceWater(f.route)});
 await until(()=>wetInside(f));const generation=f.task.executionGeneration,foreign=f.takeover(kind);await running;await sleep(25);
 assert.equal(f.task.executionGeneration,generation);assert.equal(f.task.status,'paused');assert.equal(f.agent.__testGetActiveMovementLease(),foreign.lease);assert.equal(f.bot.pathfinder.movements,foreign.profile);assert.equal(f.bot.controlState.jump,true);assert.deepEqual(f.writes.slice(foreign.traceIndex),[]);assert.equal(f.agent.__testGetHouseWaterFrame(),null);
 if(kind==='escort')assert.equal(f.agent.__testHasPassiveEscort(),true);
});

test('full task native HOLD retains safety controls and lease through typed house-error cleanup',{timeout:8000},async t=>{
 const f=engineFixture(t),running=f.agent.__testRunTaskExecution(f.task,{executeStep:()=>f.agent.__testHouseSurfaceWater(f.route)});
 await until(()=>wetInside(f));f.setUnknownHead(true);await running;
 const frame=f.agent.__testGetHouseWaterFrame();assert.ok(frame?.session.isHolding());assert.equal(frame.isPhysicalOwner(),true);assert.equal(f.task.status,'paused');assert.equal(f.task.errorCode,'house_surface_water_body_unsafe');assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.controlState.jump,true);
 const before=f.writes.length;f.agent.initializeBotRuntime();await sleep(25);assert.deepEqual(f.writes.slice(before),[]);
});

test('generation takeover during actual water cannot pause or reset its newer generation',{timeout:8000},async t=>{
 const f=engineFixture(t),running=f.agent.__testRunTaskExecution(f.task,{executeStep:()=>f.agent.__testHouseSurfaceWater(f.route)});
 await until(()=>wetInside(f));f.task.executionGeneration+=1;const generation=f.task.executionGeneration,foreign=f.takeover();await running;await sleep(25);
 assert.equal(f.task.executionGeneration,generation);assert.equal(f.task.status,'running');assert.equal(f.agent.__testGetActiveMovementLease(),foreign.lease);assert.equal(f.bot.pathfinder.movements,foreign.profile);assert.equal(f.bot.controlState.jump,true);assert.deepEqual(f.writes.slice(foreign.traceIndex),[]);assert.equal(f.agent.__testGetHouseWaterFrame(),null);
});

test('same bot replacement client drops the old frame without modifying the replacement actor',{timeout:8000},async t=>{
 const f=engineFixture(t),running=f.agent.__testRunTaskExecution(f.task,{executeStep:()=>f.agent.__testHouseSurfaceWater(f.route)});
 await until(()=>wetInside(f));f.bot._client={state:'play',socket:{writable:true,destroyed:false}};const foreign=f.takeover();f.agent.attachBot(f.bot);await running;await sleep(25);
 assert.equal(f.agent.__testGetHouseWaterFrame(),null);assert.equal(f.agent.__testGetActiveMovementLease(),foreign.lease);assert.equal(f.bot.pathfinder.movements,foreign.profile);assert.equal(f.bot.controlState.jump,true);assert.deepEqual(f.writes.slice(foreign.traceIndex),[]);
});

test('public replacement cannot abandon actual wet HOLD to start a different task',{timeout:8000},async t=>{
 const f=engineFixture(t),{frame}=await createHold(f),lease=f.task.movementLease,profile=f.bot.pathfinder.movements;
 await assert.rejects(f.agent.handleMessage({type:'mc_command_replace',command:'跟着我',context:{playerName:'ForeignPlayer'}}),error=>error.code==='house_surface_water_cleanup_pending');
 assert.equal(f.agent.__testGetReconnectTask(),f.task);assert.equal(f.agent.__testGetHouseWaterFrame(),frame);assert.equal(frame.isPhysicalOwner(),true);assert.equal(f.agent.__testGetActiveMovementLease(),lease);assert.equal(f.bot.pathfinder.movements,profile);assert.equal(f.bot.controlState.jump,true);
});
