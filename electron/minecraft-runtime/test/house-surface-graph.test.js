/* global require, Buffer, setTimeout, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {loadedSurfaceFeet,createLoadedDryGraph,createHouseSurfaceGraph,hasGroundedBodySupport,inspectSurfaceBody,inspectShoreSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shape=(name,p)=>Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p.floored()});
// OFFLINE original pathfinder + original physics. Initial state is configured
// once; every subsequent movement is Physics.simulatePlayer/PlayerState.apply.
// No Java/server, teleport, goal-position assignment, velocity patch or packet write.
function fixture(t,{worldAt,initialY=1,initialPosition,initialVelocity,checkpoint}={}) {
 const controls=[],points=[],waterTicks=[];let cancelled=false,cp=checkpoint;
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'DeskPet',health:20,food:20,oxygenLevel:20,game:{minY:-64,height:384,dimension:'overworld',gameMode:'survival'},entities:{},players:{},jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,player:{ping:1},_client:{state:'play',socket:{writable:true,destroyed:false}},controlState:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false])),entity:{position:initialPosition?.clone()||new Vec3(.5,initialY,.5),velocity:initialVelocity?.clone()||new Vec3(0,0,0),onGround:true,eyeHeight:1.62,height:1.8,width:.6,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false},inventory:{slots:Array(46).fill(null),items:()=>[]}});
 bot.blockAt=raw=>{const p=raw.floored(),value=worldAt?worldAt(p):(p.y<1?'stone':'air');return value===null?null:typeof value==='string'?shape(value,p):Object.assign(Block.fromProperties(registry.blocksByName[value.name].id,value.properties,0),{position:p});};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};
 bot.setControlState=(name,value)=>{controls.push({name,value,cancelled,at:Date.now()});bot.controlState[name]=value;};
 bot.clearControlStates=()=>{for(const name of Object.keys(bot.controlState))bot.setControlState(name,false);};
 bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);
 const nativeGoto=bot.pathfinder.goto.bind(bot.pathfinder),attempts=[];
 bot.pathfinder.goto=goal=>{attempts.push({x:goal.x,y:goal.y,z:goal.z});return nativeGoto(goal);};
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),{getBlock:bot.blockAt}).apply(bot);points.push(bot.entity.position.clone());if(bot.entity.isInWater)waterTicks.push(bot.entity.position.clone());bot.emit('physicsTick');},10);
 const deps={getBot:()=>bot,assertActive:()=>{if(cancelled)throw Object.assign(new Error('cancelled'),{code:'cancelled'});},getCheckpoint:()=>cp,setCheckpoint:value=>{cp=value;}};
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
 return {bot,deps,controls,points,waterTicks,attempts,cancel:()=>{cancelled=true;},checkpoint:()=>cp};
}
const curvedBank=p=>{const bank=(p.x>=-2&&p.x<=10&&p.z>=-2&&p.z<=2)||(p.x>=6&&p.x<=10&&p.z>=0&&p.z<=20);return p.y<0?'stone':p.y===0?(bank?'sand':'water'):'air';};
for(const unfinished of [false,true])test(`a distant food detour freshly walks to a recorded ancestor without inventing visits: unfinished=${unfinished}`,{timeout:15000},async t=>{
 const anchor={x:0,y:1,z:0},tip={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:tip,parent:'0,1,0',expanded:true}},
  order:['0,1,0','16,1,0'],frontier:[],blockedEdges:[],current:'16,1,0',resumeNode:'16,1,0',visits:2,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(100.5,1,.5)});
 let shortProbes=0;
 if(unfinished){
  const original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);
  f.bot.pathfinder.getPathFromTo=function*(profile,from,goal,options){
  yield* []; // Terminal-only modeled native iterator; no intermediate slice.
   const iterator=original(profile,from,goal,options);let result;
   for(let i=0;i<30;i++){const n=iterator.next();if(n.value)result=n.value;if(n.done||result?.result?.status!=='partial')break;}
   if(Math.hypot(goal.x-from.x,goal.z-from.z)>20&&result?.result?.status==='success')
    return {...result,result:{...result.result,status:'timeout',path:result.result.path.slice(0,12)}};
   shortProbes++;return result;
  };
 }
 const graph=createLoadedDryGraph(f.deps,{anchor,nativeReachableHints:true,legTimeoutMs:8000});
 const result=await graph.returnToAnchor({rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));
 assert.equal(graph.getState().visits,2);assert.equal(graph.getState().order.length,2);
 assert.ok(f.points.length>100);assert.equal(f.waterTicks.length,0);
 if(unfinished)assert.ok(shortProbes>5);
});
test('successive food searches retain native walked frontier instead of returning to camp each iteration',{timeout:12000},async t=>{
 const {advanceFoodFrontier}=require('../vendor/server/minecraft/houseFoodSearch');
 const f=fixture(t),anchor={x:0,y:1,z:0},paths=[];
 const graph=createLoadedDryGraph(f.deps,{anchor,legTimeoutMs:4000});let roots=0,rejoins=0;
 const deps={anchor,getPosition:()=>f.bot.entity.position,getCheckpoint:f.checkpoint,assertActive:f.deps.assertActive,
  returnToRoot:async()=>{roots++;assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));},
  rejoin:async()=>{rejoins++;await graph.returnToAnchor();},explore:()=>graph.next(),savePath:p=>paths.push(p)};
 assert.equal(await advanceFoodFrontier(deps),true);
 const first=f.bot.entity.position.clone(),priorVisits=graph.getState().visits;
 assert.equal(await advanceFoodFrontier(deps),true);
 assert.equal(roots,1);assert.equal(rejoins,0);
 assert.ok(graph.getState().visits>priorVisits);
 assert.ok(f.bot.entity.position.distanceTo(first)>=4);
 assert.ok(f.points.length>10);assert.equal(f.waterTicks.length,0);
 assert.ok(paths.length>=1);
});
test('a loaded two-rise corner return starts from an actual wall-contact pose',{timeout:7000},async t=>{
 const anchor={x:5,y:3,z:-4},id='5,3,-4';
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[],blockedEdges:[],current:id,resumeNode:id,visits:1,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(.46286548454586,1,.7),worldAt:p=>{
   const top=p.x>=1?3:p.x===0&&p.z>=1?2:p.x===0&&p.z===0?1:0;
   return p.y<top?(p.y===top-1?'grass_block':'dirt'):'air';
 }});
 const graph=createLoadedDryGraph(f.deps,{anchor,terrainRecovery:true,legTimeoutMs:4000});
 try{const result=await graph.returnToAnchor({rejoinInterruptedSuffix:true});assert.equal(result.confirmed,true);}
 catch(error){t.diagnostic(JSON.stringify({code:error.code,actual:f.bot.entity.position,attempts:f.attempts,observed:error.observedMovement}));throw error;}
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(5,3,-4));assert.equal(f.bot.entity.onGround,true);
 assert.equal(graph.getState().visits,1);assert.equal(graph.getState().order.length,1);
});
for(const pause of [false,true])test(`saved actual return stall opens a bounded natural passage without a graph visit: pause=${pause}`,{timeout:7000},async t=>{
 const anchor={x:5,y:3,z:-4},id='5,3,-4',cells=new Map(),digs=[];
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[],blockedEdges:[],current:id,resumeNode:id,visits:1,probes:0,
  lastReturnStall:{position:{x:0,y:1,z:0},target:anchor,reason:'executor_stalled',at:Date.now()}};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(.46286548454586,1,.7),worldAt:p=>{
  if(cells.has(p.toString()))return cells.get(p.toString());
  const top=p.x>=1?3:p.x===0&&p.z>=1?2:p.x===0&&p.z===0?1:0;
  return p.y<top?(p.y===top-1?'grass_block':'dirt'):'air';
 }});
 f.deps.canDigPassageBlock=()=>true;
 f.deps.digPassageBlock=async block=>{digs.push(block.position.clone());cells.set(block.position.toString(),'air');f.bot.emit('blockUpdate',block,f.bot.blockAt(block.position));if(pause)f.cancel();};
 const graph=createLoadedDryGraph(f.deps,{anchor,terrainRecovery:true,legTimeoutMs:4000});
 if(pause){await assert.rejects(graph.returnToAnchor({rejoinInterruptedSuffix:true}),{code:'cancelled'});assert.equal(digs.length,1);assert.equal(f.attempts.length,0);}
 else{await graph.returnToAnchor({rejoinInterruptedSuffix:true});assert.equal(digs.length,2);assert.deepEqual(f.attempts[0],{x:1,y:1,z:0});assert.deepEqual(f.bot.entity.position.floored(),new Vec3(5,3,-4));assert.equal(graph.getState().lastReturnStall,null);}
 assert.ok(digs.every(p=>p.x===1&&p.z===0&&[1,2].includes(p.y)));
 assert.equal(graph.getState().visits,1);assert.equal(graph.getState().order.length,1);
});
test('food detour freshly rejoins an existing branch when camp cursor is beyond local range',{timeout:12000},async t=>{
 const anchor={x:0,y:1,z:0},branch={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:branch,parent:'0,1,0',expanded:true}},
  order:['0,1,0','16,1,0'],frontier:[],blockedEdges:[],current:'0,1,0',resumeNode:'0,1,0',visits:2,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(40.5,1,16.5)}),graph=createLoadedDryGraph(f.deps,{anchor,legTimeoutMs:6000});
 await graph.returnToAnchor({anchor,rejoinInterruptedSuffix:true,via:[anchor,branch,{x:40,y:1,z:16}]});
 assert.deepEqual(f.attempts[0],branch);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));
 assert.equal(graph.getState().current,'0,1,0');assert.equal(graph.getState().visits,2);assert.equal(graph.getState().order.length,2);
 assert.equal(f.waterTicks.length,0);assert.equal(f.bot.entity.onGround,true);
});
for(const offset of [0,-3])test(`a failed old dry prefix rejoins a recorded node through actual observation or fresh native motion (${offset})`,{timeout:6000},async t=>{
 const anchor={x:0,y:1,z:0},other={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,1,0':{position:anchor,parent:null,expanded:false},'16,1,0':{position:other,parent:'0,1,0',expanded:true}},
  order:['0,1,0','16,1,0'],frontier:[],blockedEdges:[],current:'16,1,0',resumeNode:'16,1,0',visits:2,probes:0,
  pendingDryTrail:{schema:1,kind:'actual_dry_trail_prefix',originNode:'16,1,0',targetNode:'0,1,0',confirmedPrefix:[]}};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(offset+.5,1,.5)}),graph=createLoadedDryGraph(f.deps,{anchor,legTimeoutMs:4000});
 const result=await graph.next();assert.equal(result.moved,true);const state=graph.getState();
 assert.equal(state.pendingDryTrail,null);assert.equal(state.reconciledDryTrails[0].actualNode,'0,1,0');
 assert.equal(state.reconciledDryTrails[0].failedEdgeCompleted,false);assert.equal(state.reconciledDryTrails[0].newNodeOrVisitCredit,false);
 assert.equal(state.visits,3);assert.equal(state.order.length,3);
 if(offset)assert.deepEqual(f.attempts[0],anchor);
});
test('a failed prefix away from its origin freshly rejoins another actual recorded ancestor without completing the failed edge',{timeout:8000},async t=>{
 const anchor={x:0,y:1,z:0},middle={x:16,y:1,z:0},origin={x:32,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:middle,parent:'0,1,0',expanded:true},'32,1,0':{position:origin,parent:'16,1,0',expanded:true}},
  order:['0,1,0','16,1,0','32,1,0'],frontier:[],blockedEdges:[],current:'32,1,0',resumeNode:'32,1,0',visits:3,probes:0,
  pendingDryTrail:{schema:1,kind:'actual_dry_trail_prefix',originNode:'32,1,0',targetNode:'48,1,0',confirmedPrefix:[]}};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(17.5,1,.5)}),graph=createLoadedDryGraph(f.deps,{anchor,legTimeoutMs:4000,nativeReachableHints:true});
 await graph.returnToAnchor({rejoinInterruptedSuffix:true});const state=graph.getState();
 assert.deepEqual(f.attempts[0],middle);assert.equal(state.pendingDryTrail,null);assert.equal(state.visits,3);
 assert.equal(state.reconciledDryTrails[0].actualNode,'16,1,0');assert.equal(state.reconciledDryTrails[0].failedEdgeCompleted,false);
 assert.equal(state.nodes['48,1,0'],undefined);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));
});

test('fresh nearby resource guidance tries shorter local terrain steps before replaying an unhelpful old branch',{timeout:5000},async t=>{
 const anchor={x:0,y:1,z:0},current={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:current,parent:'0,1,0',expanded:true}},
  order:['0,1,0','16,1,0'],frontier:[{parent:'0,1,0',target:{x:0,y:1,z:8}}],blockedEdges:[],current:'16,1,0',resumeNode:'16,1,0',visits:2,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(16.5,1,.5),worldAt:p=>p.y<0?'stone':p.y===0?(p.x>=-2&&p.x<=18&&p.z>=-2&&p.z<=9?'stone':'water'):'air'});
 f.deps.getObservedResourceTarget=()=>({kind:'native_loaded_block_observation',position:{x:16,y:1,z:7},lastValidatedAt:Date.now()});
 const graph=createLoadedDryGraph(f.deps,{anchor,adaptiveLocalFrontier:true,legTimeoutMs:4000});
 const result=await graph.next();assert.equal(result.moved,true);assert.equal(result.actual.x,16);assert.equal(result.actual.z,8);
 assert.ok(f.attempts.every(p=>p.x>=16));assert.equal(graph.getState().visits,3);
});
test('an interrupted dry edge can recenter from actual adjacent support using native physics',{timeout:5000},async t=>{
 const {escapeEmergencyShore}=require('../vendor/server/minecraft/houseEmergencyShore');
 const {naturalWalkingFoot}=require('../vendor/server/minecraft/houseSurfaceGraph');
 const f=fixture(t,{initialPosition:new Vec3(.85,1,.5),worldAt:p=>p.y<0?'stone':p.y===0&&p.x>=1?'stone':'air'});
 assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),false);
 await escapeEmergencyShore({getBot:()=>f.bot,assertActive:f.deps.assertActive,Vec3,Movements,GoalBlock:goals.GoalBlock,
  isDryFoot:p=>naturalWalkingFoot(f.bot,p),isGrounded:()=>hasGroundedBodySupport(f.bot),goto:g=>f.bot.pathfinder.goto(g)});
 assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),true);assert.equal(hasGroundedBodySupport(f.bot),true);
});
test('combat foot navigation crosses supported beach sand using native physics without digging',{timeout:5000},async t=>{
 const {createMiningNavigator,inspectMiningStep}=require('../vendor/server/minecraft/miningNavigation');
 const f=fixture(t,{worldAt:p=>p.y<0?'stone':p.y===0?'sand':'air'});
 assert.equal(inspectMiningStep({blockAt:f.bot.blockAt,from:{x:0,y:1,z:0},direction:'east'}).ok,false);
 const nav=createMiningNavigator({getBot:()=>f.bot,allowStableGravitySupport:true,digBlock:async()=>{throw Error('no digging');}});
 await nav.advance('east');assert.equal(f.bot.entity.position.floored().x,1);assert.equal(f.bot.entity.onGround,true);
 for(const base of ['air','water',null]){
  const blockAt=p=>p.y===0?shape('sand',p):p.y<0?(base===null?null:shape(base,p)):shape('air',p);
  assert.equal(inspectMiningStep({blockAt,from:{x:0,y:1,z:0},direction:'east',allowStableGravitySupport:true}).ok,false);
 }
});
test('an owned survival detour suspends work observations without granting a continuous route trail',{timeout:8000},async t=>{
 const f=fixture(t);let suspended=false,detoured=false;
 f.deps.isMovementSuspended=()=>suspended;
 f.deps.actualnativegoto=async goal=>{
  suspended=true;await f.bot.pathfinder.goto(new goals.GoalBlock(0,1,4));detoured=true;suspended=false;
  return f.bot.pathfinder.goto(goal);
 };
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},legTimeoutMs:6000});
 const result=await graph.next();assert.equal(result.moved,true);assert.equal(detoured,true);
 assert.equal(graph.getState().nodes[graph.getState().current].dryParentTrail,undefined);
});
test('native graph dispatch supplies its original absolute leg deadline to the host',{timeout:8000},async t=>{
 const f=fixture(t);let captured;
 f.deps.actualnativegoto=async(goal,movements,budget)=>{
  assert.ok(Number.isFinite(budget?.deadline),'the host must not reset the graph leg budget');
  assert.ok(budget.deadline>Date.now());assert.ok(budget.deadline<=Date.now()+5000);
  captured=budget.deadline;assert.equal(f.bot.pathfinder.movements,movements);
  return f.bot.pathfinder.goto(goal);
 };
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},legTimeoutMs:5000});
 const result=await graph.next();assert.equal(result.moved,true);assert.ok(captured);assert.equal(graph.state().visits,2);
});
test('a finite loaded dry graph follows an L-shaped shore using original pathfinder and physical movement',{timeout:8000},async t=>{
 const f=fixture(t,{worldAt:curvedBank});const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0}});
 const result=await graph.next();assert.equal(result.moved,true);assert.equal(f.waterTicks.length,0);assert.ok(f.points.length>20);assert.ok(result.actual.z>=12);assert.equal(f.bot.entity.onGround,true);assert.ok(f.attempts.length>=1);assert.equal(graph.state().visits,2);assert.equal(Object.keys(graph.state().nodes).length,2);
 assert.ok(f.points.some(p=>p.x>5&&p.z<3),'native route went around the actual bank corner');
 assert.ok(f.points.some(p=>p.x>5&&p.z>10),'native route continued beside the shore after turning');
});
test('surface sampling rejects water-covered dry caves, unknown columns and rock-capped cavities but allows forest ground',()=>{
 const bot={blockAt:p=>shape(p.y===0?'stone':p.y===7?'oak_leaves':'air',p)};
 assert.ok(loadedSurfaceFeet(bot,0,0,1).some(p=>p.y===1));
 bot.blockAt=p=>shape(p.y===4?'water':p.y===0?'stone':'air',p);assert.equal(loadedSurfaceFeet(bot,0,0,1).length,0);
 bot.blockAt=p=>p.y===4?null:shape(p.y===0?'stone':'air',p);assert.equal(loadedSurfaceFeet(bot,0,0,1).length,0);
 bot.blockAt=p=>shape(p.y===4?'stone':p.y===0?'stone':'air',p);assert.equal(loadedSurfaceFeet(bot,0,0,1).some(p=>p.y===1),false);
 bot.blockAt=p=>shape('air',p);assert.equal(loadedSurfaceFeet(bot,0,0,1).length,0);
});
test('an unknown loaded-frontier candidate is not credited as a visit or a searched 384m disk',{timeout:3000},async t=>{
 const f=fixture(t,{worldAt:p=>p.x>=-2&&p.x<=2&&p.z>=-2&&p.z<=2?(p.y<1?'stone':'air'):null});
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0}}),result=await graph.next();
 assert.equal(result.moved,false);assert.equal(result.reason,'loaded_reachable_frontier_exhausted');assert.equal(f.attempts.length,0);assert.equal(graph.state().visits,1);assert.match(result.scope,/not proof/);
});
test('cancellation during a physical shore leg prevents any later positive native controls',{timeout:5000},async t=>{
 const f=fixture(t,{worldAt:curvedBank});let cancelledAt;
 f.bot.on('physicsTick',()=>{if(!cancelledAt&&f.bot.entity.position.x>1.5){cancelledAt=Date.now();f.cancel();}});
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0}});
 await assert.rejects(graph.next(),error=>error.code==='cancelled');assert.ok(cancelledAt);const attempts=f.attempts.length;
 await sleep(200);assert.equal(f.attempts.length,attempts);assert.equal(f.controls.filter(v=>v.cancelled&&v.value).length,0);assert.equal(graph.state().visits,1);assert.equal(f.bot.pathfinder.goal,null);
});
test('original pathfinder and vanilla physics can cross and return over a short one-block-deep still-water corridor',{timeout:8000},async t=>{
 const f=fixture(t,{initialY:2,worldAt:p=>p.y<1?'stone':p.y===1?(p.x>=2&&p.x<=5?'water':'stone'):'air'});
 const movements=new Movements(f.bot);movements.canDig=false;movements.scafoldingBlocks=[];movements.allowParkour=false;movements.allow1by1towers=false;movements.allowSprinting=false;movements.maxDropDown=2;movements.infiniteLiquidDropdownDistance=false;
 // Only this synthetic prevalidated strip can be used. Water stays a real
 // liquid with original collision/flow/physics; no getBlock or shape override.
 movements.exclusionAreasStep.push(block=>block.position.z===0&&block.position.x>=0&&block.position.x<=7?0:100);
 f.bot.pathfinder.setMovements(movements);
 const originalWater=f.bot.blockAt(new Vec3(3,1,0));assert.equal(Number(originalWater.getProperties().level),0);assert.equal(originalWater.boundingBox,'empty');
 await f.bot.pathfinder.goto(new goals.GoalBlock(7,2,0));
 for(let i=0;i<20&&!f.bot.entity.onGround;i++)await sleep(10);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(7,2,0));assert.equal(f.bot.entity.onGround,true);assert.ok(f.waterTicks.length>0);assert.equal(f.bot.entity.isInWater,false);
 await f.bot.pathfinder.goto(new goals.GoalBlock(0,2,0));for(let i=0;i<20&&!f.bot.entity.onGround;i++)await sleep(10);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,2,0));assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.isInWater,false);assert.equal(f.bot.blockAt(new Vec3(3,1,0)).name,'water');assert.equal(Number(f.bot.blockAt(new Vec3(3,1,0)).getProperties().level),0);
});

test('a new batch at camp replays physically observed parents before expanding a saved coastal child',{timeout:12000},async t=>{
 const worldAt=p=>{const bank=(p.x>=-2&&p.x<=10&&p.z>=-2&&p.z<=2)||(p.x>=6&&p.x<=10&&p.z>=0&&p.z<=50);return p.y<0?'stone':p.y===0?(bank?'sand':'water'):'air';};
 const f=fixture(t,{worldAt}),anchor={x:0,y:1,z:0};
 const firstGraph=createHouseSurfaceGraph(f.deps),first=await firstGraph.next({anchor});
 assert.equal(first.moved,true);assert.ok(first.actual.z>=12);assert.deepEqual(first.via,[anchor,first.actual]);
 const returnMoves=new Movements(f.bot);returnMoves.canDig=false;returnMoves.scafoldingBlocks=[];returnMoves.allowParkour=false;returnMoves.allowSprinting=false;returnMoves.blocksToAvoid.add(registry.blocksByName.water.id);
 f.bot.pathfinder.setMovements(returnMoves);await f.bot.pathfinder.goto(new goals.GoalBlock(0,1,0));
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));
 let second,resumed,from;
 for(let batch=0;batch<4;batch++) {
   from=f.attempts.length;resumed=createHouseSurfaceGraph(f.deps);second=await resumed.next({anchor});
   assert.equal(second.moved,true);
   if(second.via.length>=3)break;
   f.bot.pathfinder.setMovements(returnMoves);await f.bot.pathfinder.goto(new goals.GoalBlock(0,1,0));
 }
 assert.ok(second.via.length>=3,'a saved unexpanded child is eventually resumed instead of being forgotten at camp');
 const parent=second.via.at(-2);
 assert.ok(f.attempts.slice(from).some(p=>p.x===parent.x&&p.y===parent.y&&p.z===parent.z),'real goto replayed observed parent from camp before expansion');
 assert.equal(resumed.getState().visits,Object.keys(resumed.getState().nodes).length);assert.equal(f.waterTicks.length,0);assert.deepEqual(second.via[0],anchor);assert.deepEqual(second.via.at(-1),second.actual);
 await assert.rejects(resumed.next({anchor:{...anchor,x:1}}),e=>e.code==='dry_graph_checkpoint_changed');
});
test('hazard introduced along an actual dry native leg is fatal and cannot become a branch failure',{timeout:5000},async t=>{
 let hazardCell;
 const f=fixture(t,{worldAt:p=>hazardCell&&p.equals(hazardCell)?'lava':p.y<1?'stone':'air'});
 f.bot.on('physicsTick',()=>{if(!hazardCell&&f.bot.entity.position.x>1.5)hazardCell=f.bot.entity.position.floored();});
 const failures=[];f.deps.onFailure=e=>failures.push(e);
 const graph=createHouseSurfaceGraph(f.deps);
 await assert.rejects(graph.next({anchor:{x:0,y:1,z:0}}),e=>e.code==='dry_graph_hazard');
 assert.equal(failures.length,1);const diagnostic=failures[0].observedMovement;assert.equal(diagnostic.safetyFacts.feet.name,'lava');assert.ok(Number.isInteger(diagnostic.safetyFacts.feet.stateId));assert.equal(typeof diagnostic.isInWater,'boolean');assert.equal(typeof diagnostic.isInLava,'boolean');assert.ok(diagnostic.safetyFacts.body.cells.length<=12);assert.ok(diagnostic.safetyFacts.shore.supports.length<=12);
 const attempts=f.attempts.length;await sleep(100);assert.equal(f.attempts.length,attempts);assert.equal(graph.getState().visits,1);assert.equal(f.bot.pathfinder.goal,null);
});
test('superseded movement ownership preserves the replacement actor profile and goal',{timeout:5000},async t=>{
 const f=fixture(t);let owner=true,replacement,foreignGoal;
 f.deps.isMovementOwner=()=>owner;
 f.bot.on('physicsTick',()=>{if(owner&&f.bot.entity.position.x>1.5){owner=false;replacement=new Movements(f.bot);replacement.canDig=false;replacement.scafoldingBlocks=[];foreignGoal=new goals.GoalBlock(-3,1,0);f.bot.pathfinder.setMovements(replacement);f.bot.pathfinder.setGoal(foreignGoal);}});
 const graph=createHouseSurfaceGraph(f.deps);
 await assert.rejects(graph.next({anchor:{x:0,y:1,z:0}}),e=>e.code==='dry_graph_movement_preempted');
 assert.equal(f.bot.pathfinder.movements,replacement);assert.equal(f.bot.pathfinder.goal,foreignGoal);assert.equal(graph.getState().visits,1);
});

test('unknown installed Movements sentinels fail closed in exclusions and original getNeighbors',{timeout:3000},async t=>{
 const f=fixture(t,{worldAt:p=>p.x===0&&p.z===0?(p.y<1?'stone':'air'):null});
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0}}),movements=graph.movements;
 const sentinel=movements.getBlock(new Vec3(0,1,0),1,0,0);
 assert.equal(sentinel.position,undefined);assert.equal(sentinel.safe,false);assert.equal(movements.exclusionStep(sentinel),Infinity);
 const Move=require('mineflayer-pathfinder/lib/move');let neighbors;
 assert.doesNotThrow(()=>{neighbors=movements.getNeighbors(new Move(0,1,0,0,0));});assert.deepEqual(neighbors,[]);
 assert.doesNotThrow(()=>f.bot.pathfinder.getPathTo(movements,new goals.GoalBlock(16,1,0),100));
});
test('depth-first actual exploration advances 96m along a long dry shore in six bounded native legs',{timeout:12000},async t=>{
 const f=fixture(t,{worldAt:p=>p.y<0?'stone':p.y===0?(p.x>=-2&&p.x<=128&&p.z>=-2&&p.z<=2?'sand':'water'):'air'});
 const anchor={x:0,y:1,z:0},graph=createHouseSurfaceGraph(f.deps,{radius:192,maxNodes:32,maxEdges:8192});let previous=anchor;
 for(let n=0;n<6;n++) {
   const result=await graph.next({anchor});assert.equal(result.moved,true);assert.equal(result.actual.x,previous.x+16);assert.equal(result.actual.z,0);assert.equal(result.via.length,n+2);previous=result.actual;
 }
 assert.equal(previous.x,96);assert.equal(f.attempts.length,6);assert.ok(f.attempts.every((target,n)=>target.x===16*(n+1)));assert.equal(graph.getState().visits,7);assert.equal(f.waterTicks.length,0);assert.equal(graph.isObservedPosition(f.bot.entity.position),true);assert.equal(graph.isObservedPosition(new Vec3(111,1,0)),false);
});

test('the graph instance native neighbor policy forbids diagonal corner cutting without changing world shapes',async t=>{
 const f=fixture(t),graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0}});
 const Move=require('mineflayer-pathfinder/lib/move'),neighbors=graph.movements.getNeighbors(new Move(0,1,0,0,0));
 assert.equal(neighbors.length,4);assert.ok(neighbors.every(p=>p.x===0||p.z===0));
 const block=f.bot.blockAt(new Vec3(0,0,0));assert.equal(block.name,'stone');assert.deepEqual(block.shapes,[[0,0,0,1,1,1]]);
});

// Read-only extract from normally stopped natural-house-materials-05, seed
// 6239290801279771110. Actual blocks, including all original properties, in
// x74..99/y59..76/z-195..-176. Region r.0.-1.mca SHA256:
// d3cedef3e5e6c9a0576c3f47aaca1cdf205aee528b6651f4c14df1f306c657ed.
// Snapshot303482ms initializes the observed position/velocity once. Replayed
// physics is offline causal evidence; the exact historical guard tick is UNKNOWN.
const SAVED_GRAPH05_GEOMETRY = "H4sIAAAAAAAAE+2a226jMBCG32WuXYk2p42fpAdVkbtYaSRCIiA9KOLdV0mrVXcJZgiDPQaLm8h8io3n48c4OcLL7pDGOcgjbDfpPcjFVMBWfdyDXC7Fqe0B5Gx5bnsAuZif2x5B3twuZ+fW8+fFvBSwV4kuCg3y6Qip2mqQkKs0BgH7bLfXWbHRp47KUvw9/64Knf0PQKLfdAISIvjJqk2F/Hn61FVe7FJthF53WbGKs8/VOlN5bkILlSQ4MtYqXr0c8ldjz4e1yla/VXV8oNa6crGN+BzK8llArAoF8ikSp+NW3BmO6PuwwUwQVIRgJghq8n2YSGrGRAUGy9RTeJ/tOG/fZzMXfPaL8dHndkzweWhMZGB89LnZVDfrDW51HyPzZSqVz92dp8vnZqO51SIwY/W5mWpOVX61CIyZwjBYn+mcp8xnKp+7zSE9448/3BibrrZhaNYSvvrsOzN1Nh4XPnd/18OvjU2c+7oHhpqx6TPd3kXwOTD1Pvu3Fxd8dsfMmI2n6k/I5z5qyrvu1zPu1sbcfMa46srnOrJvZurJeDi4ytVnDEPlM3bPypU/Q2Wa74t+cv7LZj77z1if8Xtx/vs8s9gXr+dFfb26+mz7Px4ufbbpT2BMDKZeVX98XG+MKZ/9YS5b1g/Dx2ezq81UHz7XUXU1pcpwXs93Og/nRN/Tlgk+431u67w/jM1cHZvP1HtxOJ/5+TMuD330mTp7cT5jc5Vuni9R1zCXxt1XX9RjtjHPNnymzl4TQ7s25ufGUJkx+mwyuvmq+szVKuWW4eWqa+epfTYxZkv/HXO7fDY7j8nwLnN4DcPNn6EwtL+nRGIhfhlcxWV4E+fOecyzgO55MVSGg88457HvgyYGm+E8nae7L/h56IHzz+UfGfCGDelKAAA=";
function savedGraph05World() {
 const raw=require('node:zlib').gunzipSync(Buffer.from(SAVED_GRAPH05_GEOMETRY,'base64'));
 assert.equal(require('node:crypto').createHash('sha256').update(raw).digest('hex'), 'c1e37f255bf833523b49c5c8237a95b0f33b27f98eb90c3462626425f4b7cb26');
 const saved=JSON.parse(raw),b=saved.bounds,dy=b.maxY-b.minY+1,dz=b.maxZ-b.minZ+1;
 return p=>p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[saved.data[(p.x-b.minX)*dz*dy+(p.z-b.minZ)*dy+(p.y-b.minY)]];
}
test('saved05 native one-step slopes keep real AABB edge support that the old center-column guard rejected',{timeout:8000},async t=>{
 const anchor={x:96,y:72,z:-180},target={x:76,y:63,z:-192},id='96,72,-180';
 const cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[{parent:id,target,plannedSteps:32}],blockedEdges:[],current:id,resumeNode:id,visits:1,probes:0};
 const f=fixture(t,{worldAt:savedGraph05World(),checkpoint:cp,initialPosition:new Vec3(96.241145316375,72,-179.5426355775651),initialVelocity:new Vec3(-0.0985113764841292,-0.0784000015258789,0.005680130229342241)});
 const graph=createLoadedDryGraph(f.deps,{anchor}),goal=new goals.GoalBlock(target.x,target.y,target.z);
 const search=f.bot.pathfinder.getPathFromTo(graph.movements,f.bot.entity.position,goal,{timeout:1000,tickTimeout:10});
 let planned;for(let n=0;n<100;n++){const next=search.next();planned=next.value?.result;if(next.done||planned?.status!=='partial')break;}
 assert.equal(planned.status,'success');assert.ok(planned.path.every((p,n)=>!n||planned.path[n-1].y-p.y<=1),'original planner allows only one-step descent');
 const rejectedByOld=[];
 f.bot.on('physicsTick',()=>{
   const foot=f.bot.entity.position.floored(),oldSupported=[1,2].some(n=>{const b=f.bot.blockAt(foot.offset(0,-n,0));return b?.boundingBox==='block'&&b.shapes.some(s=>s[4]===1);});
   if(!oldSupported)rejectedByOld.push({position:f.bot.entity.position.clone(),grounded:f.bot.entity.onGround,bodySupported:hasGroundedBodySupport(f.bot)});
 });
 const result=await graph.next();assert.equal(result.moved,true);assert.deepEqual(result.actual,target);assert.equal(f.bot.entity.onGround,true);assert.ok(rejectedByOld.length>=1,'identical actual trajectory would fail the previous center-only guard');
 assert.ok(rejectedByOld.every(p=>p.grounded&&p.bodySupported));assert.ok(f.points.length>150);assert.equal(f.waterTicks.length,0);assert.equal(graph.getState().visits,2);
});
test('grounded metadata alone, nonoverlapping shapes, fluid, unknown or airborne contact never authorize edge support',()=>{
 const p=new Vec3(92.11960856157096,69,-189.1577418637875),air=where=>shape('air',where),solid=where=>shape('sand',where);
 const bot={entity:{position:p,width:.6,height:1.8,onGround:true,isInWater:false,isInLava:false},blockAt:where=>where.y===68&&where.z===-189?solid(where):air(where)};
 assert.equal(hasGroundedBodySupport(bot),true);
 bot.entity.onGround=false;assert.equal(hasGroundedBodySupport(bot),false);bot.entity.onGround=true;
 bot.blockAt=where=>where.y===66?solid(where):air(where);assert.equal(hasGroundedBodySupport(bot),false,'deeper shaft remains unsupported even if onGround is stale');
 bot.blockAt=where=>where.y===68&&where.z===-188?solid(where):air(where);assert.equal(hasGroundedBodySupport(bot),false,'a nearby shape without actual horizontal overlap is not support');
 bot.blockAt=where=>where.y===68&&where.z===-189?shape('magma_block',where):air(where);assert.equal(hasGroundedBodySupport(bot),false);
 bot.blockAt=where=>where.x===91&&where.y===69?null:where.y===68&&where.z===-189?solid(where):air(where);assert.equal(hasGroundedBodySupport(bot),false);
});
test('actual native movement still stops when its supported dry route becomes an airborne shaft',{timeout:5000},async t=>{
 let collapsed=false;
 // Only this loaded eastern strip is initially reachable, so geographic
 // exploration priority cannot silently bypass the intended real collapse.
 const f=fixture(t,{worldAt:p=>Math.abs(p.z)>1||p.x< -1||p.x>32?null:collapsed&&p.x>=1&&p.x<=4?'air':p.y<1?'stone':'air'});
 f.bot.on('physicsTick',()=>{if(f.bot.entity.position.x>1.5)collapsed=true;});
 const graph=createHouseSurfaceGraph(f.deps);
 await assert.rejects(graph.next({anchor:{x:0,y:1,z:0}}),e=>e.code==='dry_graph_airshaft');
 assert.equal(collapsed,true,'The installed native actor actually reached the dynamically collapsing strip');
 const attempts=f.attempts.length;await sleep(100);assert.equal(f.attempts.length,attempts);assert.equal(graph.getState().visits,1);assert.equal(f.bot.pathfinder.goal,null);
});

// Saved06 offline geometry: r.0.-1.mca=1e56ef7debe4fe358243c83b86e0c2b4233ee377cfd9f44d91f055f47dc15b61.
// x81..106/y58..70/z-196..-178, all original palette states/properties.
// Actual287906ms snapshot is the sole initial position/velocity configuration;
// exact historical guardtick is UNKNOWN. No original world is needed at runtime.
const SAVED_GRAPH06_GEOMETRY = "H4sIAAAAAAAAE+2Y7W6iQBSG72V+zyawWGW5km2bxoxlYk0QDWB3N8Z7XySpReYDPXM4TFrCHzLPCOM87zkoR7baHfK0ZMmRbTf5b5bEIWdb8bc+C4M5Pw8+suQhbgbrs0XQjD2x5Ef4a96MNueL+MTZXmSyqiRLno8sF9v6hJUiT1lNit1eFtVGnu90OvEL/yMqWXQnsEy+y6ymAWvPFRtlZhufb1VWu1xaJ73timqZFv+W60KUpW1qJbLstpnlYS2K5atQb83EWirfo3d6dDU9lSJdrg7lm7qEF85SUYl6wwMe8LA5fnaOgH8wPQk0JLowCOmyqDl0NDKy6Opo8+9CZpbP0NtWncJtq3Tsvfab0Nk2sck2rW2afj3ZxiQPYNt4tW3y5rNt877BdpSG2J7OPtg2Ox3Odpt/BeKaHSrbsBz02+5y3/yMTz7HZxfXenNjV73J92QbRuC2bU4n234Su20fOvlk+zYS3UCobNud6pm77Tbzz89QTm22fXg609v2OwduTn237fI/y2abzgK9Ob9tu1Swzba9TmG7EwEI7tVwVzCMbZwKxuvXlHvtM/HRdte3ac33VbBtdyIiMrZt9Vf58J1crd77a9vWyXUJwX4C+mMOZhvz7crnVed8oTi1Vb2ODpsDc6eA9RCfibttHTEZ7bdtq3raHMAS4oPTfkL1ntxu2zUHMVoOKDsFLnG1TZUDWD/A7xT4PYSK3JrEEGQbPwdjJwSWHRcSo1ytL4nX1GwbQsbvFLCEQAgkO9gr6MtBl+PapksILDvYfQeT3Lvqvo6ko+PbpuwUVAmhWAGk6sd36kM/oMoO9tpMzyxDEl5O/wGM7U839jMAAA==";
function savedGraph06World() {
 const raw=require('node:zlib').gunzipSync(Buffer.from(SAVED_GRAPH06_GEOMETRY,'base64'));
 assert.equal(require('node:crypto').createHash('sha256').update(raw).digest('hex'),"cdf619416a79e48516f50f7561f0b5d6a251e34e22f9d98454ba9ca24f4d826e");
 const saved=JSON.parse(raw),b=saved.bounds,dy=b.maxY-b.minY+1,dz=b.maxZ-b.minZ+1;
 return p=>p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ?null:saved.palette[saved.data[(p.x-b.minX)*dz*dy+(p.z-b.minZ)*dy+(p.y-b.minY)]];
}
test('saved06 native shore steps and short jumps keep the full body dry while its center briefly overhangs source water',{timeout:8000},async t=>{
 const anchor={x:103,y:63,z:-181},target={x:83,y:64,z:-192},id='103,63,-181';
 const cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[{parent:id,target,plannedSteps:34}],blockedEdges:[],current:id,resumeNode:id,visits:1,probes:0};
 const f=fixture(t,{worldAt:savedGraph06World(),checkpoint:cp,initialPosition:new Vec3(103.49964679661996,63,-180.11363996737234),initialVelocity:new Vec3(-1.046198014752242e-14,-0.0784000015258789,-0.09867499772596976)});
 const graph=createLoadedDryGraph(f.deps,{anchor}),planned=f.bot.pathfinder.getPathTo(graph.movements,new goals.GoalBlock(target.x,target.y,target.z),100);
 assert.equal(planned.status,'success');assert.ok(planned.path.every((p,n)=>!n||planned.path[n-1].y-p.y<=1));
 const oldHazards=[];f.bot.on('physicsTick',()=>{
  const foot=f.bot.entity.position.floored();if(f.bot.blockAt(foot.offset(0,-1,0))?.name==='water')oldHazards.push({position:f.bot.entity.position.clone(),onGround:f.bot.entity.onGround,inWater:f.bot.entity.isInWater,inLava:f.bot.entity.isInLava,bodyDry:inspectSurfaceBody(f.bot).dry});
 });
 const result=await graph.next().catch(error=>{error.message+=' '+JSON.stringify(error.observedMovement);throw error;});assert.equal(result.moved,true);assert.deepEqual(result.actual,target);assert.equal(f.waterTicks.length,0);assert.ok(oldHazards.some(tick=>tick.onGround===true));assert.ok(oldHazards.some(tick=>tick.onGround===false),'actual native jump is not relabelled as grounded');assert.ok(oldHazards.every(tick=>tick.inWater===false&&tick.inLava===false&&tick.bodyDry));assert.ok(f.points.length>150);assert.equal(f.bot.entity.onGround,true);
});

function shoreSnapshot(options={}) {
 const position=options.position||new Vec3(102.4,63,-189.1),center=position.floored();
 const bot={entity:{position,width:.6,height:1.8,onGround:options.onGround??true,isInWater:options.isInWater??false,isInLava:options.isInLava??false,velocity:options.velocity||new Vec3(0,-.0784,0)},blockAt:p=>{
  if(options.unknownBody&&p.x===center.x&&p.y===center.y+1&&p.z===center.z)return null;
  if(options.bodyHazard&&p.x===center.x&&p.y===center.y&&p.z===center.z)return shape(options.bodyHazard,p);
  if(options.waterloggedBody&&p.x===center.x&&p.y===center.y+1&&p.z===center.z)return Object.assign(Block.fromProperties(registry.blocksByName.oak_slab.id,{type:'bottom',waterlogged:true},0),{position:p});
  if(p.x===102&&p.z===-190&&p.y===62){
    if(options.unknownWater)return null;
    return options.belowHazard?shape(options.belowHazard,p):Object.assign(Block.fromProperties(registry.blocksByName.water.id,{level:options.level??0},0),{position:p});
  }
  if(options.unknownIntermediate&&p.x===102&&p.z===-190&&p.y===63)return null;
  if(options.shore!==false&&p.x===102&&p.z===-189&&p.y===(options.shoreY??62))return shape('sand',p);
  return shape('air',p);
 }};
 return bot;
}
function priorActualGrounded() {
 const bot=shoreSnapshot(),proof=inspectShoreSupport(bot,{tick:4});
 assert.equal(proof.accepted,true);return {tick:4,position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},contacts:proof.supports};
}
test('shore source water is limited to loaded below1/below2 and current grounded contact or recent actual native jump support',()=>{
 const grounded=inspectShoreSupport(shoreSnapshot(),{tick:4});assert.equal(grounded.accepted,true);assert.equal(grounded.reason,'grounded_shore_contact');assert.equal(grounded.selectedBelowDy,1);assert.equal(grounded.sourceWater.position.y,62);
 const airborne=inspectShoreSupport(shoreSnapshot({position:new Vec3(102.4,64.0013,-189.1),onGround:false,velocity:new Vec3(0,.16477,0)}),{tick:7,lastGrounded:priorActualGrounded()});
 assert.equal(airborne.accepted,true);assert.equal(airborne.reason,'bounded_native_jump_over_shore');assert.equal(airborne.selectedBelowDy,2);assert.equal(airborne.sourceWater.position.y,62);assert.equal(airborne.ticksSinceGrounded,3);assert.ok(airborne.supports.every(s=>s.position.y>=62&&s.position.y<=63));
 assert.equal(inspectShoreSupport(shoreSnapshot({position:new Vec3(102.4,64.0013,-189.1),onGround:false,unknownIntermediate:true}),{tick:7,lastGrounded:priorActualGrounded()}).accepted,false);
 assert.equal(inspectShoreSupport(shoreSnapshot({position:new Vec3(102.4,65.1,-189.1),onGround:false}),{tick:7,lastGrounded:priorActualGrounded()}).accepted,false,'source water deeper than original below2 never extends the guard range');
});
test('shore exception rejects actual fluid entry, hazardous or waterlogged body cells, and unknown body/water',()=>{
 for(const options of [{isInWater:true},{isInLava:true},{bodyHazard:'water'},{bodyHazard:'lava'},{bodyHazard:'magma_block'},{bodyHazard:'fire'},{waterloggedBody:true},{unknownBody:true},{unknownWater:true}]){
  const proof=inspectShoreSupport(shoreSnapshot(options),{tick:5,lastGrounded:priorActualGrounded()});assert.equal(proof.accepted,false,JSON.stringify(options));assert.ok(proof.body.cells.length<=12);assert.ok(proof.supports.length<=12);
 }
});
test('shore exception rejects missing or submerged dry shapes, flowing water and other underfoot hazards',()=>{
 for(const options of [{shore:false},{shoreY:61},{level:1},{level:8},{belowHazard:'lava'},{belowHazard:'magma_block'},{belowHazard:'fire'}])assert.equal(inspectShoreSupport(shoreSnapshot(options),{tick:5,lastGrounded:priorActualGrounded()}).accepted,false,JSON.stringify(options));
 const notContact=inspectShoreSupport(shoreSnapshot({position:new Vec3(102.4,63.4,-189.1)}),{tick:5,lastGrounded:priorActualGrounded()});assert.equal(notContact.accepted,false);assert.equal(notContact.reason,'grounded_without_contact');
});
test('airborne shore proof expires after16 ticks or1.75m and rejects missing proof or nonnative vertical velocity',()=>{
 const snapshot=()=>shoreSnapshot({position:new Vec3(102.4,63.7532,-189.1),onGround:false,velocity:new Vec3(0,.2481,0)}),prior=priorActualGrounded();
 assert.equal(inspectShoreSupport(snapshot(),{tick:20,lastGrounded:prior}).accepted,true);
 assert.equal(inspectShoreSupport(snapshot(),{tick:21,lastGrounded:prior}).accepted,false);
 assert.equal(inspectShoreSupport(snapshot(),{tick:5}).accepted,false);
 assert.equal(inspectShoreSupport(snapshot(),{tick:5,lastGrounded:{...prior,position:{...prior.position,x:prior.position.x-1.751}}}).accepted,false);
 for(const velocity of [new Vec3(0,-.901,0),new Vec3(0,.431,0),new Vec3(NaN,0,0)])assert.equal(inspectShoreSupport(shoreSnapshot({position:new Vec3(102.4,63.7532,-189.1),onGround:false,velocity}),{tick:5,lastGrounded:prior}).accepted,false);
});

test('native graph leg timer calls the shared failure hook once with exact deadline position facts', {timeout:3000}, async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',target={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[{parent:id,target,plannedSteps:16}],blockedEdges:[],current:id,resumeNode:id,visits:1,probes:0};
 const f=fixture(t,{checkpoint}),failures=[];
 f.deps.onFailure=error=>failures.push({error,actual:f.bot.entity.position.clone(),velocity:f.bot.entity.velocity.clone()});
 const graph=createLoadedDryGraph(f.deps,{anchor,legTimeoutMs:40});let failure;
 await assert.rejects(graph.next(),error=>{failure=error;return error.code==='dry_graph_leg_timeout';});
 assert.equal(failures.length,1);assert.equal(failure,failures[0].error,'The real timer Error itself must pass through instead of becoming a frontier retry');
 const facts=failures[0].error.observedMovement;
 assert.equal(facts.trigger,'deadline');assert.equal(facts.safetyFacts,null);assert.ok(Number.isFinite(facts.observedAt));
 assert.deepEqual(facts.position,{x:failures[0].actual.x,y:failures[0].actual.y,z:failures[0].actual.z});
 assert.deepEqual(facts.velocity,{x:failures[0].velocity.x,y:failures[0].velocity.y,z:failures[0].velocity.z});
 assert.deepEqual(facts.target,target);assert.equal(facts.fromNode,id);assert.equal(facts.health,20);assert.equal(facts.food,20);
 assert.equal(facts.isInWater,false);assert.equal(facts.isInLava,false);assert.ok(f.points.length>=1,'Installed physics actually ticked before the real timer expired');
 await sleep(100);assert.equal(f.attempts.length,1);assert.equal(graph.getState().visits,1);assert.equal(f.bot.pathfinder.goal,null);
});

test('explicit terrain recovery walks off a four block canopy using original physics',{timeout:8000},async t=>{
 const f=fixture(t,{initialY:5,worldAt:p=>p.y<1?'stone':p.y===4&&p.x<=0?'oak_leaves':'air'});
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:5,z:0},terrainRecovery:true,adaptiveLocalFrontier:true,legTimeoutMs:6000});
 const result=await graph.next();
 assert.equal(result.moved,true);assert.equal(f.bot.entity.onGround,true);assert.equal(result.actual.y,1);
 assert.ok(f.points.some(p=>p.y>1&&p.y<4));assert.equal(f.waterTicks.length,0);
 assert.equal(graph.movements.canDig,false,'ordinary native planner still cannot dig arbitrary blocks');
});
test('terrain recovery permits bounded survivable drops at partial health and keeps critical-health exploration constrained',t=>{
 for(const health of [6,8,13,18]){
  const f=fixture(t);f.bot.health=health;const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},terrainRecovery:true});
  assert.equal(graph.movements.maxDropDown,6);assert.equal(f.bot.health,health);assert.equal(f.attempts.length,0);
 }
 const f=fixture(t);f.bot.health=1;const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},terrainRecovery:true});
 assert.equal(graph.movements.maxDropDown,2);assert.equal(f.bot.health,1);assert.equal(f.attempts.length,0);
});
test('short passage recovery digs actual head and foot blocks before native movement',{timeout:8000},async t=>{
 const removed=new Set(),dug=[];
 const f=fixture(t,{worldAt:p=>p.y<1?'stone':p.z===0&&p.x===1&&p.y<=2&&!removed.has(`${p.x},${p.y},${p.z}`)?'dirt':p.x===0&&p.z===0?'air':p.x>=1&&p.z===0?'air':p.y<=3?'bedrock':'air'});
 f.deps.canDigPassageBlock=b=>b.name==='dirt';
 f.deps.digPassageBlock=async b=>{dug.push(b.position.clone());removed.add(`${b.position.x},${b.position.y},${b.position.z}`);};
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},terrainRecovery:true,adaptiveLocalFrontier:true});
 const result=await graph.next();
 assert.equal(result.moved,true);assert.equal(dug.length,2);assert.equal(graph.state().passageDigs,2);
 assert.ok(result.actual.x>=1);assert.equal(f.bot.entity.onGround,true);
});
for(const unsafe of ['too_deep','lava','unloaded']) test(`terrain recovery refuses ${unsafe} landing`,{timeout:5000},async t=>{
 const height=unsafe==='too_deep'?7:5;
 const f=fixture(t,{initialY:height,worldAt:p=>p.x===0&&p.z===0&&p.y===height-1?'oak_leaves':unsafe==='unloaded'&&p.y<height-1?null:p.y<1?(unsafe==='lava'?'lava':'stone'):'air'});
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:height,z:0},terrainRecovery:true,adaptiveLocalFrontier:true});
 const result=await graph.next();assert.equal(result.moved,false);assert.equal(f.attempts.length,0);assert.equal(f.bot.health,20);
});
for(const behavior of ['not_cleared','cancelled']) test(`passage recovery rejects ${behavior} host dig`,{timeout:5000},async t=>{
 const f=fixture(t,{worldAt:p=>p.y<1?'stone':p.z===0&&p.x===1&&p.y<=2?'dirt':p.x===0&&p.z===0?'air':p.x>=1&&p.z===0?'air':p.y<=3?'bedrock':'air'});
 let digs=0;f.deps.canDigPassageBlock=b=>b.name==='dirt';
 f.deps.digPassageBlock=async()=>{digs++;if(behavior==='cancelled')f.cancel();};
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},terrainRecovery:true,adaptiveLocalFrontier:true});
 await assert.rejects(graph.next(),e=>e.code===(behavior==='cancelled'?'cancelled':'dry_graph_passage_unconfirmed'));
 assert.equal(digs,1);assert.equal(f.attempts.length,0);assert.equal(graph.state().passageDigs,undefined);
});


test('saved whole45 native stale intermediate ground continues to a genuinely supported landing',t=>{
 const data=require('../test-support/whole45-saved-two-level-drop.json'),b=data.bounds;
 const f=fixture(t,{initialPosition:new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z),
  initialVelocity:new Vec3(data.initial.velocity.x,data.initial.velocity.y,data.initial.velocity.z),worldAt:p=>{
   if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
   const i=((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ),s=data.palette[data.indices[i]];
   return {name:s.name.replace(/^minecraft:/,''),properties:s.properties};
  }});
 Object.assign(f.bot.controlState,data.controls);Object.assign(f.bot.entity,{yaw:data.yaw,pitch:data.pitch,onGround:data.initial.onGround});
 f.bot.jumpTicks=data.jumpTicks;f.bot.jumpQueued=data.jumpQueued;
 const before=f.bot.entity.position.clone(),velocity=f.bot.entity.velocity.clone();
 const {inspectControlledDropSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
 const facts=inspectControlledDropSupport(f.bot,{tick:data.physicsTick,lastGrounded:data.lastGrounded});
 assert.equal(facts.accepted,true,JSON.stringify(facts));assert.ok(facts.unconfirmedGroundTicks>=1);
 assert.ok(facts.predictions.length>=7);assert.ok(facts.drop<=5.05);assert.ok(facts.maximumExpectedDamage<=2);
 assert.deepEqual(f.bot.entity.position,before);assert.deepEqual(f.bot.entity.velocity,velocity);
 assert.equal(facts.predictionApplied,false);assert.equal(f.attempts.length,0);
});


test('original native movement can descend a long stepped hillside with bounded drops',{timeout:10000},async t=>{
 const f=fixture(t,{initialY:10,worldAt:p=>p.y<(p.x<=0?10:Math.max(1,9-p.x))?'stone':'air'});
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:10,z:0},terrainRecovery:true,adaptiveLocalFrontier:true,legTimeoutMs:8000});
 const result=await graph.next();assert.equal(result.moved,true);assert.equal(f.bot.entity.onGround,true);assert.ok(result.actual.y<10);
});

test('saved whole47 downhill witness checks the native Y contact before horizontal departure',t=>{
 const data=require('../test-support/whole47-saved-stepped-drop.json'),b=data.bounds;
 const f=fixture(t,{initialPosition:new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z),
  initialVelocity:new Vec3(data.initial.velocity.x,data.initial.velocity.y,data.initial.velocity.z),worldAt:p=>{
   if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
   const i=((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ),s=data.palette[data.indices[i]];
   return {name:s.name.replace(/^minecraft:/,''),properties:s.properties};
  }});
 Object.assign(f.bot.controlState,data.controls);Object.assign(f.bot.entity,{yaw:data.yaw,pitch:data.pitch,onGround:data.initial.onGround});
 f.bot.jumpTicks=data.jumpTicks;f.bot.jumpQueued=data.jumpQueued;
 const before=f.bot.entity.position.clone(),velocity=f.bot.entity.velocity.clone();
 const {inspectControlledDropSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
 const facts=inspectControlledDropSupport(f.bot,{tick:data.physicsTick,lastGrounded:data.lastGrounded});
 assert.equal(facts.accepted,true,JSON.stringify(facts));assert.ok(facts.verticalContactBeforeHorizontal);
 assert.equal(facts.drop,2);assert.equal(facts.maximumExpectedDamage,0);assert.equal(facts.predictionApplied,false);
 assert.deepEqual(f.bot.entity.position,before);assert.deepEqual(f.bot.entity.velocity,velocity);assert.equal(f.attempts.length,0);
});


test('surface passage clearing can leave a loaded canopy pocket through actual leaves',{timeout:8000},async t=>{
 const removed=new Set(),dug=[];
 const f=fixture(t,{worldAt:p=>p.y<1?'spruce_leaves':p.z===0&&p.x===1&&p.y<=2&&!removed.has(`${p.x},${p.y},${p.z}`)?'spruce_leaves':p.x===0&&p.z===0?'air':p.x>=1&&p.z===0?'air':p.y<=3?'bedrock':'air'});
 f.deps.canDigPassageBlock=b=>b.name==='spruce_leaves';
 f.deps.digPassageBlock=async b=>{dug.push(b.position.clone());removed.add(`${b.position.x},${b.position.y},${b.position.z}`);};
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},terrainRecovery:true,adaptiveLocalFrontier:true});
 const result=await graph.next();assert.equal(result.moved,true);assert.equal(dug.length,2);
 assert.ok(result.actual.x>=1);assert.equal(f.bot.entity.onGround,true);assert.equal(graph.state().passageDigs,2);
 assert.equal(f.bot.blockAt(new Vec3(0,0,0)).name,'spruce_leaves','original floor is preserved');
});
test('the surface-only leaf floor option never widens ordinary mining or permits gravity/fluid floors',()=>{
 const {inspectMiningStep}=require('../vendor/server/minecraft/miningNavigation');
 const inspect=(name,flag)=>inspectMiningStep({blockAt:p=>shape(p.y<=0?name:'air',p),from:{x:0,y:1,z:0},direction:{x:1,z:0},allowLeafSupport:flag});
 assert.equal(inspect('spruce_leaves',false).code,'MINING_NO_SUPPORT');assert.equal(inspect('spruce_leaves',true).ok,true);
 for(const name of ['sand','gravel','powder_snow','lava','water'])assert.equal(inspect(name,true).ok,false);
});


test('saved whole52 dry coastal fall permits water environment reads without entering water',t=>{
 const data=require('../test-support/whole52-saved-coastal-drop.json'),b=data.bounds;let waterReads=0;
 const f=fixture(t,{initialPosition:new Vec3(data.initial.position.x,data.initial.position.y,data.initial.position.z),
  initialVelocity:new Vec3(data.initial.velocity.x,data.initial.velocity.y,data.initial.velocity.z),worldAt:p=>{
   if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
   const i=((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ),s=data.palette[data.indices[i]];
   if(s.name==='minecraft:water')waterReads++;
   return {name:s.name.replace(/^minecraft:/,''),properties:s.properties};
  }});
 Object.assign(f.bot.controlState,data.controls);Object.assign(f.bot.entity,{yaw:data.yaw,pitch:data.pitch,onGround:data.initial.onGround});
 f.bot.jumpTicks=data.jumpTicks;f.bot.jumpQueued=data.jumpQueued;
 const before=f.bot.entity.position.clone(),velocity=f.bot.entity.velocity.clone();
 const {inspectControlledDropSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
 const facts=inspectControlledDropSupport(f.bot,{tick:data.physicsTick,lastGrounded:data.lastGrounded});
 assert.equal(facts.accepted,true,JSON.stringify(facts));assert.ok(waterReads>0);
 assert.equal(facts.drop,5);assert.equal(facts.maximumExpectedDamage,2);assert.equal(facts.predictionApplied,false);
 assert.deepEqual(f.bot.entity.position,before);assert.deepEqual(f.bot.entity.velocity,velocity);assert.equal(f.attempts.length,0);
});
test('water environment reads cannot authorize a fall into actual water',t=>{
 const f=fixture(t,{initialPosition:new Vec3(1.4,5,.5),initialVelocity:new Vec3(0,-.0784,0),
  worldAt:p=>p.x===0&&p.z===0&&p.y===4?'oak_leaves':p.y<=0?'water':'air'});
 const {inspectControlledDropSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
 const facts=inspectControlledDropSupport(f.bot,{tick:1,lastGrounded:{tick:0,position:{x:.95,y:5,z:.5},
  contacts:[{position:{x:0,y:4,z:0},stateId:registry.blocksByName.oak_leaves.defaultState}]}});
 assert.equal(facts.accepted,false);assert.equal(facts.predictionApplied,false);assert.equal(f.attempts.length,0);
});


function whole55BrakeFixture(t) {
 const data=require('../test-support/whole55-saved-drop-braking.json'),b=data.bounds,
  start={x:476,y:66,z:278},target={x:473,y:64,z:282},key=p=>`${p.x},${p.y},${p.z}`;
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor:start,step:16,radius:64,
  nodes:{[key(start)]:{position:start,parent:null,expanded:true},[key(target)]:{position:target,parent:key(start),expanded:true}},
  order:[key(start),key(target)],current:key(start),resumeNode:key(start),visits:2,probes:0,frontier:[],blockedEdges:[]};
 const f=fixture(t,{initialPosition:new Vec3(476.5,66,278.5),checkpoint,worldAt:p=>{
  if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const i=((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ),s=data.palette[data.indices[i]];
  return {name:s.name.replace(/^minecraft:/,''),properties:s.properties};
 }});
 return {...f,start,target,key};
}
test('saved whole55 native drop brakes through actual gravity then resumes the same target',{timeout:10000},async t=>{
 const f=whole55BrakeFixture(t),landings=[];f.deps.onControlledDropBrake=p=>landings.push(p);
 const graph=createLoadedDryGraph(f.deps,{anchor:f.start,radius:64,terrainRecovery:true,legTimeoutMs:7000});
 const result=await graph.travelToObservedNode({nodeId:f.key(f.target),exactPosition:f.target});
 assert.equal(result.confirmed,true);assert.deepEqual(result.actual,f.target);assert.equal(landings.length,1);
 assert.equal(landings[0].actualGrounded,true);assert.equal(landings[0].positionOrVelocityWritten,false);
 assert.ok(f.attempts.length>=2);assert.ok(f.attempts.every(p=>f.key(p)===f.key(f.target)));
 assert.equal(f.waterTicks.length,0);assert.equal(graph.state().visits,2);
});
for(const takeover of ['cancel','foreign','critical_health'])test(`drop braking cannot resume after ${takeover} takeover`,{timeout:6000},async t=>{
 const f=whole55BrakeFixture(t);let owner=true,seen=false,replacement,foreignReady=false,clearsAfterForeign=0;
 f.deps.isMovementOwner=()=>owner;
 const clear=f.bot.clearControlStates.bind(f.bot);f.bot.clearControlStates=()=>{if(foreignReady)clearsAfterForeign++;return clear();};
 const setGoal=f.bot.pathfinder.setGoal.bind(f.bot.pathfinder);
 f.bot.pathfinder.setGoal=(goal,...args)=>{
  const result=setGoal(goal,...args);
  if(goal===null&&!seen&&f.attempts.length&&f.bot.entity.position.y>63.1) {
   seen=true;
   if(takeover==='cancel')f.cancel();
   else if(takeover==='critical_health')f.bot.health=5;
   else {owner=false;const profile=new Movements(f.bot),foreignGoal=new goals.GoalBlock(477,66,278);
    f.bot.pathfinder.setMovements(profile);setGoal(foreignGoal);f.bot.setControlState('right',true);replacement={profile,goal:foreignGoal};foreignReady=true;}
  }
  return result;
 };
 const graph=createLoadedDryGraph(f.deps,{anchor:f.start,radius:64,terrainRecovery:true,legTimeoutMs:4000});
 await assert.rejects(graph.travelToObservedNode({nodeId:f.key(f.target),exactPosition:f.target}));
 assert.equal(seen,true);assert.equal(f.attempts.length,1);assert.equal(graph.state().current,f.key(f.start));
 if(replacement){assert.equal(f.bot.pathfinder.movements,replacement.profile);assert.equal(f.bot.pathfinder.goal,replacement.goal);assert.equal(clearsAfterForeign,0);}
});


test('resource rejoin returns the actual reconciled recorded cursor rather than a stale pre-return target',async t=>{
 const anchor={x:0,y:1,z:0},child={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:64,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:child,parent:'0,1,0',expanded:true}},
  order:['0,1,0','16,1,0'],current:'16,1,0',resumeNode:'16,1,0',frontier:[],blockedEdges:[],visits:2,probes:0};
 const f=fixture(t,{checkpoint}),graph=createLoadedDryGraph(f.deps,{anchor,radius:64});
 const stale=graph.state().current;
 const result=await graph.returnToAnchor({returnToCurrentOnly:true,rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.equal(result.current,'0,1,0');assert.notEqual(result.current,stale);
 assert.deepEqual(result.actual,anchor);assert.equal(graph.state().current,result.current);
 assert.equal(graph.state().visits,2);assert.equal(f.attempts.length,0);assert.equal(hasGroundedBodySupport(f.bot),true);
});

for(const retained of [false,true])test(`an unfinished long native search offers only a separately probed short endpoint and keeps the original goal UNKNOWN: retained=${retained}`,{timeout:8000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0';
 const checkpoint=retained?{schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[],blockedEdges:[{from:id,target:{x:16,y:1,z:0},reason:'native_probe_inconclusive',observedProbe:{status:'timeout',conclusive:false}}],current:id,resumeNode:id,visits:1,probes:0}:undefined;
 const f=fixture(t,{checkpoint}),original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);let shortProbes=0;
 f.bot.pathfinder.getPathFromTo=function*(profile,from,goal,options){
  yield* []; // Terminal-only modeled native iterator; no intermediate slice.
  const iterator=original(profile,from,goal,options);let result;
  for(let i=0;i<20;i++){const n=iterator.next();if(n.value)result=n.value;if(n.done||result?.result?.status!=='partial')break;}
  if(Math.hypot(goal.x-from.x,goal.z-from.z)>=12&&result?.result?.status==='success'){
   return {...result,result:{...result.result,status:'timeout',path:result.result.path.slice(0,6)}};
  }
  shortProbes++;return result;
 };
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},nativeReachableHints:true});
 const moved=await graph.next();assert.equal(moved.moved,true);assert.ok(shortProbes>0);
 const state=graph.getState(),unresolved=state.blockedEdges.find(e=>e.reason==='native_probe_inconclusive');
 assert.ok(unresolved);assert.equal(unresolved.observedProbe.conclusive,false);
 assert.ok(Math.hypot(moved.actual.x,moved.actual.z)<12);assert.equal(state.visits,2);
 assert.ok(f.attempts.every(p=>Math.hypot(p.x,p.z)<12),'The unfinished original path/goal never becomes a physical goto');
});

for(const siteMode of [true,false])test(`unreturnable old branch defers during ${siteMode?'site':'material'} exploration while explicit camp return stays strict`,{timeout:10000},async t=>{
 const root={x:0,y:5,z:0},current={x:16,y:1,z:0},far={x:0,y:5,z:16},local={x:32,y:1,z:0},k=p=>`${p.x},${p.y},${p.z}`;
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor:root,step:16,radius:64,
  nodes:{[k(root)]:{position:root,parent:null,expanded:true},[k(current)]:{position:current,parent:k(root),expanded:true}},
  order:[k(root),k(current)],current:k(current),resumeNode:k(current),visits:2,probes:0,blockedEdges:[],
  frontier:[{parent:k(root),target:far,plannedSteps:16},{parent:k(current),target:local,plannedSteps:16}]};
 const f=fixture(t,{initialPosition:new Vec3(16.5,1,.5),checkpoint,worldAt:p=>
  p.x< -2||p.x>40||p.z< -2||p.z>18?null:p.y<(p.x<=0?5:1)?'stone':'air'});
 f.deps.getObservedResourceTarget=()=>({kind:'native_loaded_block_observation',position:far,lastValidatedAt:Date.now()});
 const graph=createLoadedDryGraph(f.deps,{anchor:root,radius:64,nativeReachableHints:siteMode});
 const result=await graph.next();assert.equal(result.moved,true);assert.deepEqual(result.actual,local);
 const deferred=graph.state().blockedEdges.find(e=>e.kind==='unconfirmed_site_parent_replay');
 assert.ok(deferred);assert.equal(deferred.actualMovementConfirmed,false);assert.equal(graph.state().visits,3);
 assert.equal(deferred.scope,'exploration_only');assert.ok(deferred.retryAfter>Date.now());
 assert.ok(f.attempts.every(p=>k(p)===k(local)),'unreachable reverse planning never becomes a native move');
 await assert.rejects(graph.returnToAnchor(),e=>['dry_graph_native_no_path','dry_graph_probe_inconclusive'].includes(e.code));
 assert.equal(graph.state().visits,3);
});

test('a destroyed old exploration floor is archived once and another actual branch proceeds',{timeout:10000},async t=>{
 const root={x:0,y:1,z:0},bad={x:16,y:1,z:0},rid='0,1,0',bid='16,1,0';
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor:root,step:16,radius:64,
  nodes:{[rid]:{position:root,parent:null,expanded:true},[bid]:{position:bad,parent:rid,expanded:false}},
  order:[rid,bid],current:rid,resumeNode:bid,visits:2,probes:0,frontier:[],blockedEdges:[]};
 const f=fixture(t,{checkpoint,worldAt:p=>p.y<1&&!(p.x===16&&p.z===0)?'stone':'air'});
 const graph=createLoadedDryGraph(f.deps,{anchor:root,radius:64});
 const result=await graph.next();assert.equal(result.moved,true);
 assert.ok(graph.state().nodes[bid].terrainUnavailable);assert.equal(graph.state().blockedEdges.filter(e=>e.kind==='terrain_changed_exploration_branch').length,1);
 assert.equal(f.attempts.some(p=>p.x===16&&p.z===0),false);
 assert.equal(f.waterTicks.length,0);assert.equal(hasGroundedBodySupport(f.bot),true);
});

test('a destroyed unstarted frontier is durably rejected before trying the next real branch',{timeout:10000},async t=>{
 const root={x:0,y:1,z:0},bad={x:16,y:1,z:0},good={x:0,y:1,z:16},rid='0,1,0';
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor:root,step:16,radius:64,
 nodes:{[rid]:{position:root,parent:null,expanded:true}},order:[rid],current:rid,resumeNode:rid,visits:1,probes:0,
 frontier:[{parent:rid,target:bad},{parent:rid,target:good}],blockedEdges:[]};
 const f=fixture(t,{checkpoint,worldAt:p=>p.y<1&&!(p.x===16&&p.z===0)?'stone':'air'});
 const graph=createLoadedDryGraph(f.deps,{anchor:root,radius:64});const result=await graph.next();
 assert.equal(result.moved,true);assert.equal(result.actual.z,16);assert.equal(f.checkpoint().blockedEdges[0].reason,'dry_graph_route_changed');
 assert.equal(f.checkpoint().frontier.some(e=>e.target.x===16&&e.target.z===0),false);assert.equal(f.attempts.some(p=>p.x===16&&p.z===0),false);
});

test('the actual development-world two-block ledge witness remains valid at partial health without health or pose writes',t=>{
 const {inspectControlledDropSupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
 const f=fixture(t,{initialPosition:new Vec3(-86.50027844788434,67,-28.446673400915603),initialVelocity:new Vec3(.000140106311461,-.0784000015258789,-.119209109088432),worldAt:p=>p.y<=64?'stone':p.z>=-28&&p.y<=66?'grass_block':'air'});
 f.bot.health=8;f.bot.entity.yaw=-.0026184199833751975;f.bot.controlState.forward=true;
 const before=f.bot.entity.position.clone(),health=f.bot.health;
 const result=inspectControlledDropSupport(f.bot,{tick:97,lastGrounded:{tick:96,position:{x:-86.50053505285038,y:67,z:-28.22834169928844},contacts:[{position:{x:-87,y:66,z:-28},stateId:registry.blocksByName.grass_block.defaultState}]}});
 assert.equal(result.accepted,true);assert.equal(result.drop,2);assert.equal(result.maximumExpectedDamage,0);assert.equal(result.predictionApplied,false);
 assert.deepEqual(f.bot.entity.position,before);assert.equal(f.bot.health,health);assert.equal(f.attempts.length,0);
});

test('a survivable drop can finish its original landing with15HP instead of waiting for full recovery',{timeout:6000},async t=>{
 const f=whole55BrakeFixture(t);let changed=false;const set=f.bot.pathfinder.setGoal.bind(f.bot.pathfinder);
 f.bot.pathfinder.setGoal=(goal,...args)=>{const r=set(goal,...args);if(goal===null&&!changed&&f.attempts.length&&f.bot.entity.position.y>63.1){changed=true;f.bot.health=15;}return r;};
 const graph=createLoadedDryGraph(f.deps,{anchor:f.start,radius:64,terrainRecovery:true,legTimeoutMs:4000});
 const r=await graph.travelToObservedNode({nodeId:f.key(f.target),exactPosition:f.target});assert.equal(r.confirmed,true);assert.equal(changed,true);assert.equal(f.bot.health,15);
});

test('a grounded food detour beyond waypoint spacing freshly walks a dry route around a pond',{timeout:12000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0';
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[],blockedEdges:[],current:id,resumeNode:id,visits:1,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(15.5,1,53.5),worldAt:p=>{
   if(p.y<0)return 'stone';
   if(p.y===0)return p.x>=8&&p.x<=18&&p.z>=35&&p.z<=42?'water':'grass_block';
   return 'air';
 }});
 const graph=createLoadedDryGraph(f.deps,{anchor,terrainRecovery:true,legTimeoutMs:10000});
 const result=await graph.returnToAnchor({rejoinInterruptedSuffix:true,via:[anchor]});
 assert.equal(result.confirmed,true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));
 assert.equal(f.waterTicks.length,0);assert.equal(graph.getState().visits,1);assert.equal(graph.getState().order.length,1);
});

test('an incompatible old suffix exposes a fresh recovery target after failed connectors without granting arrival credit',async t=>{
 const anchor={x:0,y:1,z:0},branch={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:branch,parent:'0,1,0',expanded:true}},
  order:['0,1,0','16,1,0'],frontier:[],blockedEdges:[],current:'16,1,0',resumeNode:'16,1,0',visits:2,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(40.5,1,16.5)});
 f.bot.pathfinder.getPathFromTo=function*(){yield* [];return {result:{status:'noPath',path:[]}};};
 const graph=createLoadedDryGraph(f.deps,{anchor,terrainRecovery:true});
 await assert.rejects(graph.returnToAnchor({rejoinInterruptedSuffix:true,via:[anchor]}),error=>{
  assert.equal(error.code,'dry_graph_rejoin_unconfirmed');assert.equal(error.reconnect.reason,'foreign_suffix_after_unconfirmed_connectors');
  assert.equal(error.reconnect.grounded,true);assert.equal(error.reconnect.naturalFoot,true);assert.deepEqual(error.reconnect.target,anchor);return true;
 });
 assert.equal(f.attempts.length,0);assert.equal(graph.getState().current,'16,1,0');assert.equal(graph.getState().visits,2);
 assert.deepEqual(f.bot.entity.position,new Vec3(40.5,1,16.5));
});

test('critical survival provisioning grants only its own fresh graph leg and return, then revokes the lower health threshold',{timeout:8000},async t=>{
 const f=fixture(t);f.bot.health=4.8;f.bot.food=12;
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},terrainRecovery:true,legTimeoutMs:5000});
 const result=await graph.next({survivalProvisioning:true});assert.equal(result.moved,true);
 const count=f.attempts.length;
 await assert.rejects(graph.next(),{code:'dry_graph_survival_limit'});assert.equal(f.attempts.length,count);
 const returned=await graph.returnToAnchor({survivalProvisioning:true,rejoinInterruptedSuffix:true});
 assert.equal(returned.confirmed,true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));
 await assert.rejects(graph.next(),{code:'dry_graph_survival_limit'});
});

test('food detour beyond one connector range rejoins by actual bounded dry legs without invented graph visits',{timeout:20000},async t=>{
 const anchor={x:0,y:1,z:0},current={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
 nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:current,parent:'0,1,0',expanded:true}},
 order:['0,1,0','16,1,0'],frontier:[],blockedEdges:[],current:'16,1,0',resumeNode:'16,1,0',visits:2,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(116.5,1,.5)});
 const graph=createLoadedDryGraph(f.deps,{anchor,nativeReachableHints:true,legTimeoutMs:8000});
 const result=await graph.returnToAnchor({rejoinInterruptedSuffix:true,via:[anchor,current]});
 assert.equal(result.confirmed,true);assert.ok(f.attempts.length>=3);
 assert.ok(Math.hypot(f.attempts[0].x-116.5,f.attempts[0].z-.5)<=16);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,0));
 assert.equal(graph.getState().visits,2);assert.deepEqual(graph.getState().order,['0,1,0','16,1,0']);
});

test('distant food return direction never authorizes a connector across unknown terrain',{timeout:5000},async t=>{
 const anchor={x:0,y:1,z:0},current={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
 nodes:{'0,1,0':{position:anchor,parent:null,expanded:true},'16,1,0':{position:current,parent:'0,1,0',expanded:true}},
 order:['0,1,0','16,1,0'],frontier:[],blockedEdges:[],current:'16,1,0',resumeNode:'16,1,0',visits:2,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(116.5,1,.5),worldAt:p=>p.x>30&&p.x<112?null:p.y<1?'stone':'air'});
 const graph=createLoadedDryGraph(f.deps,{anchor,nativeReachableHints:true,legTimeoutMs:3000});
 await assert.rejects(graph.returnToAnchor({rejoinInterruptedSuffix:true,via:[anchor,current]}),{code:'dry_graph_rejoin_unconfirmed'});
 assert.equal(f.attempts.length,0);assert.equal(graph.getState().visits,2);
 assert.equal(graph.getState().current,'16,1,0');
});

for(const mode of ['success','still_unknown','cancelled'])test(`formal06 selected native frontier recheck preserves UNKNOWN and ownership: ${mode}`,{timeout:10000},async t=>{
 const f=fixture(t),native=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder),calls=new Map(),probes=[];let retried=0;
 f.bot.pathfinder.getPathFromTo=function*(movements,from,goal,options){
  const id=`${goal.x},${goal.y},${goal.z}`,n=(calls.get(id)||0)+1;calls.set(id,n);
  if(options?.timeout===100&&n>1){for(let i=0;i<20;i++)yield {result:{status:'partial',path:[]}};}
  if(options?.timeout===500){retried++;if(mode==='cancelled')f.cancel();if(mode==='still_unknown'){for(let i=0;i<60;i++)yield {result:{status:'partial',path:[]}};}}
  yield* native(movements,from,goal,options);
 };
 f.deps.onProbe=facts=>probes.push(facts);
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},legTimeoutMs:5000});
 if(mode==='success'){
  const r=await graph.next();assert.equal(r.moved,true);assert.equal(graph.getState().visits,2);assert.ok(f.points.length>0);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>1);
 }else if(mode==='cancelled'){
  await assert.rejects(graph.next(),{code:'cancelled'});assert.equal(graph.getState().visits,1);assert.equal(f.attempts.length,0);
 }else{
  const r=await graph.next();assert.equal(r.moved,false);assert.equal(graph.getState().visits,1);assert.equal(f.attempts.length,0);
 }
 assert.ok(retried>0);if(mode!=='cancelled')assert.ok(probes.some(p=>p.selectedFrontierRetry&&p.budgetMs===500&&p.newNodeOrVisitCredit===false));
});

test('formal11 a failed multi-leg reverse replay must not bounce between the lower parent and its child instead of exploring locally',{timeout:12000},async t=>{
 const root={x:0,y:5,z:0},middle={x:16,y:1,z:0},tip={x:16,y:1,z:1},far={x:0,y:5,z:16},local={x:32,y:1,z:1},k=p=>`${p.x},${p.y},${p.z}`;
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor:root,step:16,radius:64,nodes:{[k(root)]:{position:root,parent:null,expanded:true},[k(middle)]:{position:middle,parent:k(root),expanded:true},[k(tip)]:{position:tip,parent:k(middle),expanded:true}},order:[k(root),k(middle),k(tip)],current:k(tip),resumeNode:k(tip),visits:3,probes:0,blockedEdges:[],frontier:[{parent:k(root),target:far,plannedSteps:16},{parent:k(tip),target:local,plannedSteps:16}]};
 const f=fixture(t,{initialPosition:new Vec3(16.5,1,1.5),checkpoint,worldAt:p=>p.x< -2||p.x>40||p.z< -2||p.z>18?null:p.y<(p.x<=0?5:1)?'stone':'air'});
 f.deps.getObservedResourceTarget=()=>({kind:'native_loaded_block_observation',position:far,lastValidatedAt:Date.now()});
 const graph=createLoadedDryGraph(f.deps,{anchor:root,radius:64,nativeReachableHints:true});
 const result=await graph.next();assert.equal(result.moved,true);assert.deepEqual(result.actual,local);
 const deferred=graph.state().blockedEdges.find(e=>e.kind==='unconfirmed_site_parent_replay');assert.ok(deferred);assert.equal(deferred.requestedFrom,k(tip));assert.equal(deferred.from,k(middle));
 assert.equal(graph.state().visits,4);assert.equal(graph.state().order.length,4);assert.ok(f.attempts.every(p=>k(p)!==k(root)));
 await assert.rejects(graph.returnToAnchor(),e=>['dry_graph_native_no_path','dry_graph_probe_inconclusive'].includes(e.code));
 assert.equal(graph.state().visits,4);
});

for (const code of ['house_surface_movement_timeout', 'paused', 'movement_preempted'])
test(`host deadline rejection before the timer preserves its cause: ${code}`, {timeout:3000}, async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',target={x:16,y:1,z:0};
 const checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],frontier:[{parent:id,target,plannedSteps:16}],blockedEdges:[],current:id,resumeNode:id,visits:1,probes:0};
 const f=fixture(t,{checkpoint}),failures=[];
 f.deps.onFailure=error=>failures.push(error);
 // MODELED host rejection at its shared deadline before the queued graph
 // timer runs. No arrival or physics movement credit is supplied by this seam.
 f.deps.actualnativegoto=async(goal,movements,{deadline})=>{
   while(Date.now()<deadline) { /* Keep the timer queued behind this rejection. */ }
   if(code!=='house_surface_movement_timeout')f.deps.assertActive=()=>{throw Object.assign(new Error(code),{code});};
   throw Object.assign(new Error(code),{code});
 };
 const graph=createLoadedDryGraph(f.deps,{anchor,legTimeoutMs:40});
 const expected=code==='house_surface_movement_timeout'?'dry_graph_leg_timeout':code;
 await assert.rejects(graph.next(),error=>error.code===expected);
 assert.equal(failures.length,code==='house_surface_movement_timeout'?1:0);
 if(failures.length)assert.equal(failures[0].observedMovement.trigger,'deadline');
 assert.equal(graph.getState().visits,1);assert.equal(f.attempts.length,0);
});

for(const resumable of [true,false])test(`interrupted passage digging rechecks physical blocks only after owned survival resumes: ${resumable}`,{timeout:8000},async t=>{
 const removed=new Set(),dug=[];let interrupted=false,resumes=0;
 const f=fixture(t,{worldAt:p=>p.y<1?'stone':p.z===0&&p.x===1&&p.y<=2&&!removed.has(`${p.x},${p.y},${p.z}`)?'dirt':p.x===0&&p.z===0?'air':p.x>=1&&p.z===0?'air':p.y<=3?'bedrock':'air'});
 f.deps.canDigPassageBlock=b=>b.name==='dirt';
 f.deps.digPassageBlock=async b=>{if(!interrupted){interrupted=true;throw Object.assign(Error('native defense took dig ownership'),{code:'movement_preempted'});}dug.push(b.position.clone());removed.add(`${b.position.x},${b.position.y},${b.position.z}`);};
 f.deps.resumeInterruptedPassage=async(e,budget)=>{assert.equal(e.code,'movement_preempted');assert.ok(budget.deadline>Date.now());resumes++;assert.equal(dug.length,0);assert.equal(removed.size,0);return resumable;};
 const graph=createLoadedDryGraph(f.deps,{anchor:{x:0,y:1,z:0},terrainRecovery:true,adaptiveLocalFrontier:true});
 if(!resumable){await assert.rejects(graph.next(),{code:'movement_preempted'});assert.equal(graph.state().passageDigs,undefined);return;}
 assert.equal((await graph.next()).moved,true);assert.equal(resumes,1);assert.equal(dug.length,2);
 assert.equal(graph.state().passageDigs,2);assert.equal(graph.state().passageDefenseResumes,1);assert.equal(f.bot.entity.onGround,true);
});

for(const maxVertical of [8.05,32])test(`world132 completed owned boundary observes a10m lower actual stand with envelope=${maxVertical}`,{timeout:3000},async t=>{
 const anchor={x:0,y:11,z:0},checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,11,0':{position:anchor,parent:null,expanded:true}},order:['0,11,0'],frontier:[],blockedEdges:[],current:'0,11,0',resumeNode:'0,11,0',visits:1,probes:0};
 const f=fixture(t,{checkpoint,worldAt:p=>p.y<1||p.x===0&&p.z===0&&p.y===10?'stone':'air'});let used=false;
 // MODELED private completed-owner receipt. Actual lower pose is configured
 // once at fixture spawn; this tests observation only, not a claimed fall.
 f.deps.takeBoundaryDefenseRelocation=()=>used?null:(used=true,{kind:'actual_owned_graph_boundary_defense',from:anchor,actual:{x:0,y:1,z:0},observedAt:Date.now(),originalDeadline:Date.now()+2000,maximumDisplacement:32,maximumVerticalDisplacement:maxVertical,oldTargetReached:false});
 const graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:2,deferInconclusiveExplorationReplay:true});
 await assert.rejects(graph.next());
 if(maxVertical===32){assert.equal(graph.getState().current,'0,1,0');assert.equal(graph.getState().visits,2);assert.equal(graph.getState().nodes['0,1,0'].survivalRelocation.oldEdgeTraversalCredit,false);}
 else{assert.equal(graph.getState().current,'0,11,0');assert.equal(graph.getState().visits,1);}
 assert.equal(f.attempts.length,0);assert.ok(graph.getState().nodes['0,11,0']);
});

for(const mode of ['owned','far_start','far_final','foreign'])test(`world140 chained completed defense observes actual origin without granting old edge: ${mode}`,{timeout:3000},async t=>{
 const anchor={x:0,y:11,z:0},checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,11,0':{position:anchor,parent:null,expanded:true}},order:['0,11,0'],frontier:[],blockedEdges:[],current:'0,11,0',resumeNode:'0,11,0',visits:1,probes:0};
 const f=fixture(t,{checkpoint,initialPosition:new Vec3(4.5,1,.5),worldAt:p=>p.y<1||p.x===0&&p.z===0&&p.y===10?'stone':'air'});let used=false;
 // MODELED private finished defense provenance. This tests registration of
 // actual configured stand, never claims an unobserved fall or old traversal.
 f.deps.takeBoundaryDefenseRelocation=()=>used?null:(used=true,{kind:'actual_owned_graph_boundary_defense',from:{x:mode==='far_start'?100:2,y:4,z:0},actual:{x:mode==='far_final'?100:3.9,y:1,z:.5},observedAt:Date.now(),originalDeadline:Date.now()+2000,maximumDisplacement:32,maximumVerticalDisplacement:32,oldTargetReached:false});
 f.deps.isMovementOwner=()=>mode!=='foreign';
 const graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:2,deferInconclusiveExplorationReplay:true});await assert.rejects(graph.next());
 if(mode==='owned'){assert.equal(graph.getState().current,'4,1,0');assert.equal(graph.getState().nodes['4,1,0'].survivalRelocation.oldEdgeTraversalCredit,false);}
 else assert.equal(graph.getState().current,'0,11,0');
 assert.equal(f.attempts.length,0);assert.ok(graph.getState().nodes['0,11,0']);
});
