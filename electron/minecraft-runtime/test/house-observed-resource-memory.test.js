/* global require, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMinecraftTaskAgent}=require('../vendor/server/minecraftTaskAgent');
const {CancellationToken}=require('../vendor/server/minecraft/agentControl');
const {Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8'),Chunk=require('prismarine-chunk')(registry);
const {Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const {createHouseObservedResourceMemory}=require('../vendor/server/minecraft/houseObservedResourceMemory');
const {createLoadedDryGraph,selectSurfaceExplorationFrontier,runSurfaceGraphNativeProbe}=require('../vendor/server/minecraft/houseSurfaceGraph');
const copy=x=>JSON.parse(JSON.stringify(x)),anchor={x:0,y:2,z:0},key=p=>`${p.x},${p.y},${p.z}`;
function fixture(t,{nearProtected=0,budgetMs=1000,resourceName='oak_log'}={}) {
 let owner=true,memoryCP=null,graphCP={schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:64,nodes:{'0,2,0':{position:anchor,parent:null,expanded:true}},order:['0,2,0'],current:'0,2,0',resumeNode:'0,2,0',frontier:[],blockedEdges:[],visits:1,probes:0},clock=Date.now(),fullHook=null;
 const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),writes=[],moves=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},inventory:{slots:Array(46).fill(null),items:()=>[]},game:{dimension:'overworld',minY:-64,height:384},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,supportFeature:n=>registry.supportFeature(n),_client:Object.assign(new EventEmitter(),{state:'play',write:()=>{}}),entity:{position:new Vec3(.5,2,.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,height:1.8,width:.6,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 require('mineflayer/lib/plugins/blocks')(bot,{version:'1.21.8'});bot._client.emit('login',{worldState:{dimension:0,name:'minecraft:overworld'}});
 const stone=registry.blocksByName.stone.defaultState,log=registry.blocksByName[resourceName].defaultState;
 for(let x=-4;x<=10;x++)for(let z=-4;z<=4;z++){const column=new Chunk({minY:-64,worldHeight:384});for(let i=0;i<16;i++)for(let j=0;j<16;j++)column.setBlockStateId(new Vec3(i,1,j),stone);bot.world.setColumn(x,z,column);}
 const far=new Vec3(160,2,0);bot.world.setBlockStateId(far,log);
 for(let i=0;i<nearProtected;i++)bot.world.setBlockStateId(new Vec3(2+i%10,2,2+Math.floor(i/10)),log);
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(name,value)=>{writes.push({name,value,owner});controls[name]=value;};bot.clearControlStates=()=>{for(const n of Object.keys(controls))bot.setControlState(n,false);};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);const nativeGoto=bot.pathfinder.goto.bind(bot.pathfinder);
 const active=()=>{if(!owner)throw Object.assign(new Error('paused'),{code:'paused'});};
 const excluded=p=>{assert.ok(p,'Palette position must never be passed as an owned-resource coordinate');if(fullHook?.(p)===true)return true;return p.x>=2&&p.x<=11&&p.z>=2&&p.z<=8;};
 const memory=createHouseObservedResourceMemory({getBot:()=>bot,assertActive:active,isOwnerCurrent:()=>owner,getCP:()=>memoryCP,saveCP:s=>{memoryCP=copy(s);},getGraphState:()=>graphCP,isExcludedPosition:excluded,now:()=>clock},{resource:resourceName==='sand'?'sand':'any_log',names:[resourceName],queryBudgetMs:budgetMs});
 t.after(()=>{bot.pathfinder.setGoal(null);bot.clearControlStates();bot.removeAllListeners();});
 return {bot,memory,far,moves,writes,active,excluded,state:()=>memoryCP,graphState:()=>graphCP,setGraph:s=>{graphCP=copy(s);},pause:()=>{owner=false;},advanceClock:ms=>{clock+=ms;},hook:f=>{fullHook=f;},startGraph:()=>{
   graphCP=null;const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);bot.emit('physicsTick');},5);t.after(()=>clearInterval(timer));
   return createLoadedDryGraph({getBot:()=>bot,assertActive:active,isMovementOwner:()=>owner,getCP:()=>graphCP,saveCP:s=>{graphCP=copy(s);},getObservedResourceTarget:()=>memory.getTarget(),onObservedResourceApproach:v=>memory.observeApproach(v),onObservedResourceTargetBlocked:(target,facts)=>memory.defer(target,facts),actualnativegoto:async(goal,movements)=>{assert.equal(movements.canDig,false);assert.equal(movements.scafoldingBlocks.length,0);moves.push({x:goal.x,y:goal.y,z:goal.z});await nativeGoto(goal);}},{anchor,step:16,radius:64,maxNodes:16,maxEdges:128,legTimeoutMs:5000,timeoutMs:15000});
 }};
}
test('native sand observations guide toward an exposed source instead of an enclosed nearer deposit',t=>{
 const f=fixture(t,{resourceName:'sand'}),p=new Vec3(32,2,0);
 f.bot.world.setBlockStateId(p,registry.blocksByName.sand.defaultState);
 for(const d of [new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1),new Vec3(0,1,0)])
  f.bot.world.setBlockStateId(p.plus(d),registry.blocksByName.stone.defaultState);
 const q=f.memory.query();assert.equal(q.settled,true);assert.equal(q.confirmed,1);
 const target=f.memory.getTarget();assert.equal(target.name,'sand');assert.deepEqual(target.position,{x:160,y:2,z:0});
 assert.equal(target.resourceArrival,'NOT_CONFIRMED');assert.equal(f.moves.length,0);assert.equal(f.graphState().visits,1);
});
test('original loaded native Chunk findBlocks observes logs beyond96m without crediting movement',t=>{
 const f=fixture(t),before=copy(f.graphState());assert.deepEqual(f.bot.findBlocks({matching:registry.blocksByName.oak_log.id,maxDistance:96,count:24}),[]);
 const q=f.memory.query();assert.equal(q.radius,192);assert.equal(q.settled,true);assert.ok(q.paletteReads>0);assert.deepEqual(f.memory.getTarget().position,{x:160,y:2,z:0});
 assert.deepEqual(f.state().entries[0].seenFrom,{x:.5,y:2,z:.5});assert.equal(f.state().entries[0].seenFromNode,'0,2,0');assert.equal(f.state().entries[0].resourceArrival,'NOT_CONFIRMED');assert.deepEqual(f.graphState(),before);assert.equal(f.moves.length,0);assert.equal(f.writes.length,0);
});
test('full position exclusions run before native count24; protected structure logs do not hide a farther natural tree',t=>{
 const f=fixture(t,{nearProtected:60}),q=f.memory.query();assert.equal(q.settled,true);assert.equal(q.confirmed,1);assert.deepEqual(f.memory.getTarget().position,{x:160,y:2,z:0});assert.ok(q.fullReads>=60);assert.equal(f.state().entries.length,1);
});
test('unloaded or changed remembered block gives no fresh guidance while historical observation stays recorded',t=>{
 const f=fixture(t);f.memory.query();f.bot.world.unloadColumn(10,0);assert.equal(f.memory.getTarget(),null);assert.equal(f.state().entries[0].name,'oak_log');assert.equal(f.state().entries[0].resourceArrival,'NOT_CONFIRMED');
});
test('captured owner replacement during the original native query cannot publish old coordinates',t=>{
 const f=fixture(t);f.hook(()=>f.pause());assert.throws(()=>f.memory.query(),e=>e.code==='paused');assert.equal(f.state(),null);assert.equal(f.moves.length,0);assert.equal(f.writes.length,0);
});
test('finite native matcher budget remains an inconclusive observation and adds no result to CP',t=>{
 const f=fixture(t,{budgetMs:20}),native=f.bot.blockAt;let delayed=false;f.bot.blockAt=p=>{if(!delayed){delayed=true;const until=Date.now()+30;while(Date.now()<until){ /* bounded test-only native loaded-read latency */ }}return native(p);};
 const q=f.memory.query();assert.equal(q.settled,false);assert.equal(q.reason,'native_query_inconclusive');assert.equal(f.state().entries.length,0);assert.equal(f.state().lastQuery.settled,false);assert.equal(f.graphState().visits,1);assert.equal(f.moves.length,0);
});
test('partial approach defers a remembered source temporarily without inventing noPath or losing its coordinate',t=>{
 const f=fixture(t);f.memory.query();const target=f.memory.getTarget();f.memory.defer(target,{reason:'native_probe_inconclusive',probeStatus:'partial'});assert.equal(f.memory.getTarget(),null);assert.equal(f.state().entries[0].rejections[0].conclusiveNoPath,false);assert.equal(f.state().entries[0].name,'oak_log');f.advanceClock(30001);assert.ok(f.memory.getTarget());
});
test('an untraveled approach cannot acquire an arrival or support label',t=>{
 const f=fixture(t);f.memory.query();assert.throws(()=>f.memory.observeApproach({target:f.memory.getTarget(),actual:{x:16,y:2,z:0},nodeKey:'16,2,0'}),e=>e.code==='house_resource_memory_approach_unconfirmed');assert.equal(f.state().entries[0].lastApproach,undefined);assert.equal(f.graphState().visits,1);
});
test('observed target priority chooses an improving existing frontier; absent/stale target retains original coverage',()=>{
 const state={anchor,nodes:{'0,2,0':{position:anchor,parent:null}},order:['0,2,0'],current:'0,2,0',frontier:[{parent:'0,2,0',target:{x:0,y:2,z:32}},{parent:'0,2,0',target:{x:16,y:2,z:0}}]},before=copy(state),target={kind:'native_loaded_block_observation',position:{x:160,y:2,z:0},lastValidatedAt:Date.now()};
 assert.equal(selectSurfaceExplorationFrontier(state),0);assert.equal(selectSurfaceExplorationFrontier(state,anchor,target),1);assert.equal(selectSurfaceExplorationFrontier(state,anchor,{...target,lastValidatedAt:Date.now()-6000}),0);assert.deepEqual(state,before);
});
test('real installed native graph approaches an observed resource through a guarded waypoint and only actual arrival adds its visit',{timeout:10000},async t=>{
 const f=fixture(t);f.memory.query();const before=copy(f.graphState()),graph=f.startGraph();assert.equal(f.state().entries[0].resourceArrival,'NOT_CONFIRMED');const result=await graph.next();
 assert.equal(result.moved,true);assert.ok(result.actual.x>0);assert.equal(result.actual.z,0);assert.equal(graph.getState().visits,2);assert.deepEqual(f.state().entries[0].lastApproach.position,result.actual);assert.equal(f.state().entries[0].resourceArrival,'NOT_CONFIRMED');assert.equal(f.moves.some(p=>p.x===160),false);assert.equal(f.bot.inventory.items().length,0);assert.equal(before.visits,1);
});

test('nearby deep mineshaft logs cannot displace a farther exposed surface tree',t=>{
 const f=fixture(t),nativeLog=registry.blocksByName.oak_log.defaultState;
 f.bot.world.setBlockStateId(f.far,registry.blocksByName.air.defaultState);
 f.bot.world.setBlockStateId(new Vec3(160,-16,0),nativeLog);
 f.bot.world.setBlockStateId(new Vec3(164,2,0),nativeLog);
 f.memory.query();assert.deepEqual(f.memory.getTarget().position,{x:164,y:2,z:0});assert.equal(f.state().entries.some(e=>e.position.y<0),false);assert.equal(f.state().entries[0].standingArrival,'NOT_CONFIRMED');
});
test('the actual house direct-gather entry filters underground logs before native count24',async t=>{
 const f=fixture(t),log=registry.blocksByName.oak_log.defaultState,air=registry.blocksByName.air.defaultState;
 f.bot.world.setBlockStateId(f.far,air);
 const surface=new Vec3(70,2,0);f.bot.world.setBlockStateId(surface,log);
 for(let i=0;i<60;i++)f.bot.world.setBlockStateId(new Vec3(2+i%10,-46,-1-Math.floor(i/10)),log);
 const unfiltered=f.bot.findBlocks({matching:registry.blocksByName.oak_log.id,maxDistance:96,count:24});
 assert.equal(unfiltered.length,24);assert.ok(unfiltered.every(p=>p.y===-46),'the original nearest24 are all underground');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'house-surface-bridge-')),keys={MC_AGENT_LEARNING_PATH:path.join(dir,'learning.json'),MC_AGENT_DIAGNOSTICS_DIR:path.join(dir,'diagnostics'),MC_AGENT_DISCONNECT_TRACE_PATH:path.join(dir,'disconnect.jsonl')};
 const before=Object.fromEntries(Object.keys(keys).map(k=>[k,process.env[k]]));Object.assign(process.env,keys);f.bot._client.socket={writable:true,destroyed:false};
 let modelCalls=0;
 const agent=createMinecraftTaskAgent({appPaths:{appDataDir:dir},readConfig:()=>({mcExecutorMode:'strict-executor',mcAgentAutoReconnect:false}),parseJsonObjectFromText:JSON.parse,broadcast:()=>{},broadcastMinecraftError:()=>{},allowAutonomousMaintenance:()=>false,requestPlannerCompletion:async()=>{modelCalls++;throw Error('Unexpected model');}});
 agent.attachBot(f.bot);agent.initializeBotRuntime();
 const task={taskId:'direct-surface-bridge',status:'running',source:'deskpet',intent:'build_furnished_house',logs:[],startedAt:Date.now(),currentStepIndex:0,currentStep:'build_furnished_house_phase',executionGeneration:0,cancellationToken:new CancellationToken(),plan:{steps:[]},materialSupply:{schema:1,profile:'cottage',materialSource:'self_gathered',observedResources:{}}};
 task.movementLease=agent.__testClaimMovementLease('task',task.taskId);agent.__testSetReconnectTask(task);
 t.after(()=>{agent.__testSetReconnectTask(null);agent.detachBot('manual_disconnect');agent.dispose();for(const k in keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}fs.rmSync(dir,{recursive:true,force:true});});
 const found=await agent.__testWithHouseResourceWork(({findSurfaceBlocks})=>findSurfaceBlocks(['oak_log'],96,24));
 assert.deepEqual(found.map(b=>({x:b.position.x,y:b.position.y,z:b.position.z})),[{x:70,y:2,z:0}]);
 assert.equal(modelCalls,0);assert.equal(f.bot.inventory.items().length,0);assert.equal(f.moves.length,0);
 f.bot.world.setBlockStateId(surface,air);
 const changed=await agent.__testWithHouseResourceWork(({findSurfaceBlocks})=>findSurfaceBlocks(['oak_log'],96,24));assert.deepEqual(changed,[]);
 task.cancellationToken.pause();await assert.rejects(agent.__testWithHouseResourceWork(({findSurfaceBlocks})=>findSurfaceBlocks(['oak_log'],96,24)),e=>e.code==='paused');
});
test('unknown actual section palette is queried natively instead of being presumed AIR',t=>{
 const f=fixture(t),column=f.bot.world.getColumn(10,0),section=column.sections[4];section.palette=undefined;
 f.memory.query();assert.deepEqual(f.memory.getTarget().position,{x:160,y:2,z:0});assert.ok(f.state().lastQuery.sectionQueries>0);
});
test('one overall deadline spans multiple section queries and preserves UNKNOWN instead of restarting its budget',t=>{
 const f=fixture(t,{nearProtected:60,budgetMs:150}),native=f.bot.findBlocks;let calls=0;
 f.bot.findBlocks=options=>{calls++;const until=Date.now()+90;while(Date.now()<until){ /* one per-call native latency model */ }return native(options);};
 const q=f.memory.query();assert.equal(q.settled,false);assert.ok(q.elapsedMs>=150);assert.ok(calls<=2);assert.equal(f.state().entries.length,0);assert.equal(f.moves.length,0);
});
test('target guidance prefers an improving frontier at the current actual node over a closer old branch',()=>{
 const a={x:0,y:2,z:0},b={x:80,y:2,z:0},state={anchor:a,nodes:{[key(a)]:{position:a,parent:null},[key(b)]:{position:b,parent:key(a)}},order:[key(a),key(b)],current:key(a),frontier:[{parent:key(b),target:{x:96,y:2,z:0}},{parent:key(a),target:{x:16,y:2,z:0}}]},target={kind:'native_loaded_block_observation',position:{x:160,y:2,z:0},lastValidatedAt:Date.now()};
 assert.equal(selectSurfaceExplorationFrontier(state,a,target),1);
});

test('native noPath settling after100ms remains inconclusive in deferred target diagnostics',t=>{
 const f=fixture(t);f.memory.query();const target=f.memory.getTarget();
 for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]])for(const y of [2,3])f.bot.world.setBlockStateId(new Vec3(x,y,z),registry.blocksByName.stone.defaultState);
 f.bot.world.setBlockStateId(new Vec3(0,4,0),registry.blocksByName.stone.defaultState);
 const movement=new (require('mineflayer-pathfinder').Movements)(f.bot);movement.canDig=false;movement.scafoldingBlocks=[];movement.allowParkour=false;
 const native=f.bot.blockAt;let reads=0;f.bot.blockAt=p=>{if(++reads===1){const until=Date.now()+120;while(Date.now()<until){ /* before native AStar starts its timer */ }}return native(p);};
 const observed=runSurfaceGraphNativeProbe(f.bot,movement,new (require('mineflayer-pathfinder').goals.GoalBlock)(4,2,0),{assertActive:f.active,isOwnerCurrent:()=>true});
 assert.equal(observed.result.status,'noPath');assert.equal(observed.facts.conclusive,false);assert.ok(observed.facts.elapsedMs>100);
 f.memory.defer(target,{reason:'late_native_noPath',probeStatus:observed.facts.status,probeConclusive:observed.facts.conclusive});
 assert.equal(f.state().entries[0].rejections[0].conclusiveNoPath,false);assert.equal(f.moves.length,0);assert.equal(f.writes.length,0);
});

test('eight-section truncation stays UNKNOWN and the next query advances to an observed ninth surface section',t=>{
 const f=fixture(t);for(let x=16;x<=128;x+=16)f.bot.world.setBlockStateId(new Vec3(x,2,0),registry.blocksByName.oak_log.defaultState);
 f.hook(p=>p.y===2&&p.z===0&&p.x>=16&&p.x<=128);
 const first=f.memory.query();assert.equal(first.settled,false);assert.equal(first.truncated,true);assert.ok(first.metadataCandidateCount>=9);assert.equal(first.confirmed,0);assert.ok(first.nextSectionCursor>0);assert.equal(f.memory.getTarget(),null);
 const second=f.memory.query();assert.ok(second.confirmed>0);assert.deepEqual(f.memory.getTarget().position,{x:160,y:2,z:0});assert.equal(f.moves.length,0);assert.equal(f.graphState().visits,1);
});

test('older nearby wood stays retrievable behind more than24 newer distant observations',t=>{
 const f=fixture(t);f.memory.query();const cp=f.memory.getState(),template=cp.entries[0];
 const positions=[...Array.from({length:25},(_,i)=>({x:128+i,y:2,z:0})),{x:4,y:2,z:0}];
 for(const p of positions)f.bot.world.setBlockStateId(new Vec3(p.x,p.y,p.z),registry.blocksByName.oak_log.defaultState);
 cp.entries=positions.map(position=>({...copy(template),position,observedAt:Date.now()}));
 const memory=createHouseObservedResourceMemory({getBot:()=>f.bot,assertActive:f.active,isOwnerCurrent:()=>true,getCP:()=>cp,
  getGraphState:f.graphState,saveCP:()=>{},isExcludedPosition:f.excluded},{resource:'any_log',names:['oak_log']});
 assert.deepEqual(memory.getTarget().position,{x:4,y:2,z:0});
 assert.deepEqual(memory.getLoadedCandidates()[0].position,new Vec3(4,2,0));assert.equal(f.moves.length,0);
});

test('nearby locally rejected crowns cannot occupy all24 current-candidate slots ahead of another actual tree',t=>{
 const f=fixture(t);f.memory.query();const cp=f.memory.getState(),template=cp.entries[0],log=registry.blocksByName.oak_log.defaultState;
 const points=[...Array.from({length:25},(_,i)=>({x:2+i,y:2,z:0})),{x:70,y:2,z:0}];
 for(const p of points)f.bot.world.setBlockStateId(new Vec3(p.x,p.y,p.z),log);
 cp.entries=points.map(position=>({...copy(template),position,observedAt:Date.now()}));
 let allowedReads=0;const memory=createHouseObservedResourceMemory({getBot:()=>f.bot,assertActive:f.active,isOwnerCurrent:()=>true,getCP:()=>cp,saveCP:()=>{},getGraphState:f.graphState,isExcludedPosition:f.excluded,
  isCandidateAllowed:block=>{assert.ok(block.position);allowedReads++;return block.position.x>=60;}},{resource:'any_log',names:['oak_log'],queryRadius:96});
 assert.deepEqual(memory.getLoadedCandidates().map(b=>b.position),[new Vec3(70,2,0)]);assert.ok(allowedReads<=128);
 const query=memory.query();assert.notEqual(query.status,'failed');assert.deepEqual(memory.getLoadedCandidates().map(b=>b.position),[new Vec3(70,2,0)]);
 assert.equal(f.moves.length,0);assert.equal(f.writes.length,0);
});

test('recorded owned station guides only existing frontier ordering without native presence or visit credit',()=>{
 const state={anchor,nodes:{'0,2,0':{position:anchor,parent:null}},order:['0,2,0'],current:'0,2,0',frontier:[{parent:'0,2,0',target:{x:0,y:2,z:32}},{parent:'0,2,0',target:{x:16,y:2,z:0}}]},before=copy(state);
 const hint={kind:'recorded_owned_station_hint',name:'chest',ownershipRecorded:true,position:{x:160,y:2,z:0},currentPresence:'UNKNOWN'};
 assert.equal(selectSurfaceExplorationFrontier(state,anchor,hint),1);
 assert.equal(selectSurfaceExplorationFrontier(state,anchor,{...hint,ownershipRecorded:false}),0);
 assert.deepEqual(state,before);assert.equal(hint.currentPresence,'UNKNOWN');
});

test('unloaded native wood observation can separately suggest frontier direction without fresh target credit',t=>{
 const f=fixture(t);f.memory.query();const before=copy(f.state());f.bot.world.unloadColumn(10,0);
 assert.equal(f.memory.getTarget(),null);
 const hint=f.memory.getHistoricalHint();assert.equal(hint.kind,'recorded_natural_resource_hint');
 assert.equal(hint.currentPresence,'UNKNOWN');assert.equal(hint.resourceArrival,'NOT_CONFIRMED');
 assert.deepEqual(hint.position,{x:160,y:2,z:0});assert.equal(hint.observationRecorded,true);
 assert.deepEqual(f.state(),before);assert.equal(f.moves.length,0);assert.equal(f.writes.length,0);
 f.pause();assert.throws(()=>f.memory.getHistoricalHint(),{code:'paused'});
});
test('loaded changed wood memory cannot suggest a historical tree direction',t=>{
 const f=fixture(t);f.memory.query();f.bot.world.setBlockStateId(new Vec3(160,2,0),registry.blocksByName.air.defaultState);
 assert.equal(f.memory.getHistoricalHint(),null);
});
test('historical natural wood hint only orders existing frontier and cannot claim loaded presence',()=>{
 const state={anchor,nodes:{'0,2,0':{position:anchor,parent:null}},order:['0,2,0'],current:'0,2,0',frontier:[{parent:'0,2,0',target:{x:0,y:2,z:32}},{parent:'0,2,0',target:{x:16,y:2,z:0}}]},before=copy(state);
 const hint={kind:'recorded_natural_resource_hint',name:'oak_log',position:{x:160,y:2,z:0},observedAt:Date.now(),observationRecorded:true,currentPresence:'UNKNOWN',resourceArrival:'NOT_CONFIRMED'};
 assert.equal(selectSurfaceExplorationFrontier(state,anchor,hint),1);
 assert.equal(selectSurfaceExplorationFrontier(state,anchor,{...hint,observationRecorded:false}),0);
 assert.equal(selectSurfaceExplorationFrontier(state,anchor,{...hint,name:'oak_planks'}),0);
 assert.deepEqual(state,before);assert.equal(hint.currentPresence,'UNKNOWN');
});
