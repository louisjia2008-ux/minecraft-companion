/* global require, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{Vec3}=require('vec3');
const {Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {selectSurfaceExplorationFrontier,createLoadedDryGraph,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const copy=x=>JSON.parse(JSON.stringify(x)),key=p=>`${p.x},${p.y},${p.z}`,anchor={x:0,y:2,z:0};
function state(positions,frontier=[]){const nodes={},order=[];for(const [i,p]of positions.entries()){const id=key(p);nodes[id]={position:p,parent:i?order.at(-1):null,expanded:true};order.push(id);}return{schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:64,nodes,order,frontier,blockedEdges:[],current:order.at(-1),resumeNode:order.at(-1),visits:order.length,probes:0};}

test('dense neighboring-bank ring with517 frontiers and136 observations cannot outrank a new coverage cell',()=>{
 // Synthetic observed-only geometry, no resource map. This reproduces the
 // coverage failure's shape and budgets without importing any world seed.
 const positions=[];for(let z=0;positions.length<135;z++)for(let x=0;x<=144&&positions.length<135;x+=16)positions.push({x,y:2,z});positions.push({x:146,y:2,z:0});
 const s=state(positions),parent=s.current;
 s.frontier=Array.from({length:516},(_,i)=>({parent,target:{x:142+i%4,y:2,z:13+Math.floor(i/4)%3},...(i%2?{transport:{kind:'source_water_surface'}}:{})}));
 const observedParent=s.order.find(id=>s.nodes[id].position.x===128&&s.nodes[id].position.z===12);
 s.frontier.push({parent:observedParent,target:{x:144,y:2,z:28}});
 const before=copy(s);assert.equal(s.visits,136);assert.equal(s.frontier.length,517);assert.ok(Math.max(...positions.map(p=>Math.hypot(p.x,p.z)))<=146);
 assert.equal(selectSurfaceExplorationFrontier(s),516);assert.deepEqual(s,before,'Ranking cannot credit a planned cell, node or visit');
});

test('real visited separation and outward gain precede frontier order or shallow/surface tags',()=>{
 const positions=[anchor,{x:16,y:2,z:0}],s=state(positions),a=key(anchor),last=s.current;
 s.frontier=[{parent:last,target:{x:17,y:2,z:0},transport:{kind:'source_water_surface'}},{parent:a,target:{x:-16,y:2,z:0}},{parent:last,target:{x:24,y:2,z:0}}];
 assert.equal(selectSurfaceExplorationFrontier(s),1,'A nearby fluid tag cannot displace geographic separation');
 s.frontier=[{parent:last,target:{x:0,y:2,z:16}},{parent:a,target:{x:-16,y:2,z:0}}];
 assert.equal(selectSurfaceExplorationFrontier(s),0,'Uncovered32m cell takes priority, independently of direction');
});

test('planned targets, pending transport and a changed visit counter do not grant coverage',()=>{
 const s=state([anchor]),a=key(anchor);s.frontier=[{parent:a,target:{x:32,y:2,z:0}},{parent:a,target:{x:1,y:2,z:0}}];
 s.pendingWater={edge:s.frontier[0]};s.visits=999;
 const before=copy(s);assert.equal(selectSurfaceExplorationFrontier(s),0);assert.deepEqual(s,before);assert.equal(s.order.length,1);
});

test('missing observed parent/position fails closed, while already observed targets cannot be new frontier credit',()=>{
 const s=state([anchor]),a=key(anchor);s.frontier=[{parent:a,target:anchor}];assert.equal(selectSurfaceExplorationFrontier(s),-1);
 s.frontier=[{parent:'not-observed',target:{x:16,y:2,z:0}}];assert.throws(()=>selectSurfaceExplorationFrontier(s),e=>e.code==='dry_graph_checkpoint_changed');
 s.frontier=[];delete s.nodes[a].position;assert.throws(()=>selectSurfaceExplorationFrontier(s),e=>e.code==='dry_graph_checkpoint_changed');
});

// Actual installed pathfinder/Physics. Only initial state is configured. Every
// later position/velocity update is exclusively simulatePlayer(...).apply(bot).
function nativeFixture(t,{noArrival=false,allObserved=false}={}){
 const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),moves=[],saves=[];let checkpoint=state([anchor,{x:16,y:2,z:0}]);
 checkpoint.nodes[checkpoint.current].expanded=false;checkpoint.frontier=[{parent:checkpoint.current,target:{x:20,y:2,z:0}},{parent:key(anchor),target:{x:-16,y:2,z:0}}];
 if(allObserved){checkpoint.nodes[checkpoint.current].expanded=true;checkpoint.frontier=[{parent:checkpoint.current,target:anchor}];}
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},inventory:{items:()=>[],slots:Array(46).fill(null)},
 game:{dimension:'overworld',minY:-64,height:384},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
 _client:{state:'play',socket:{writable:true,destroyed:false}},entity:{position:new Vec3(16.5,2,.5),velocity:new Vec3(0,0,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,height:1.8,width:.6,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot.blockAt=raw=>{const p=raw.floored();if(p.x < -40||p.x>24||Math.abs(p.z)>2)return null;return Object.assign(Block.fromStateId(registry.blocksByName[p.y<2?'stone':'air'].defaultState),{position:p});};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(name,value)=>{controls[name]=value;};bot.clearControlStates=()=>{for(const name of Object.keys(controls))controls[name]=false;};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);const original=bot.pathfinder.goto.bind(bot.pathfinder),profile=bot.pathfinder.movements;
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);bot.emit('physicsTick');},5);
 const deps={getBot:()=>bot,assertActive:()=>{},isMovementOwner:()=>true,getCP:()=>checkpoint,saveCP:v=>{checkpoint=copy(v);saves.push(copy(v));},
 pathprobe:(movements,goal)=>[0,-16,20].includes(goal.x)&&goal.z===0?bot.pathfinder.getPathTo(movements,goal,100):{status:'noPath',path:[]},
 actualnativegoto:async(goal,movements)=>{moves.push({target:{x:goal.x,y:goal.y,z:goal.z},visits:checkpoint.visits,currentExpanded:checkpoint.nodes[checkpoint.current].expanded});assert.equal(movements.canDig,false);if(!noArrival)await original(goal);}};
 const graph=createLoadedDryGraph(deps,{anchor,step:16,radius:64,maxNodes:16,legTimeoutMs:6000,timeoutMs:20000});
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});return{bot,graph,moves,saves,profile,state:()=>checkpoint};
}

test('original native replay returns by observed ancestor once, then credits only the actually reached new node',{timeout:10000},async t=>{
 const f=nativeFixture(t),result=await f.graph.next();assert.equal(result.moved,true);assert.deepEqual(result.actual,{x:-16,y:2,z:0});
 assert.deepEqual(f.moves.map(m=>m.target),[anchor,{x:-16,y:2,z:0}]);assert.ok(f.moves.every(m=>m.visits===2),'Replay and planning do not manufacture visits');assert.equal(f.moves[0].currentExpanded,true,'Actual current node expanded before selecting global frontier');
 assert.equal(f.state().visits,3);assert.equal(f.state().order.length,3);assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(f.bot.pathfinder.movements,f.profile);
 const home=await f.graph.returnToAnchor();assert.equal(home.confirmed,true);assert.deepEqual(home.actual,anchor);assert.equal(f.state().visits,3);assert.equal(f.moves.length,3);
});

test('resolved callback without actual ancestor arrival adds no coverage or visit',{timeout:4000},async t=>{
 const f=nativeFixture(t,{noArrival:true});await assert.rejects(f.graph.next(),e=>e.code==='dry_graph_move_unconfirmed');assert.equal(f.state().visits,2);assert.equal(f.state().order.length,2);assert.equal(f.state().nodes['-16,2,0'],undefined);assert.equal(f.moves.length,1);assert.equal(f.bot.pathfinder.movements,f.profile);
 const stale=nativeFixture(t,{allObserved:true}),result=await stale.graph.next();assert.equal(result.moved,false);assert.equal(result.reason,'loaded_reachable_frontier_exhausted');assert.equal(stale.state().frontier.length,0);assert.equal(stale.state().visits,2);assert.equal(stale.moves.length,0);
});

for(const mode of ['owned_cleanup','unowned','untyped','chest'])test(`world150 unloaded owned obstacle guides existing frontier only: ${mode}`,()=>{
 const s=state([anchor]);s.frontier=[{parent:s.current,target:{x:16,y:2,z:0}},{parent:s.current,target:{x:-8,y:2,z:0}}];
 const hint={kind:'recorded_owned_station_hint',name:mode==='chest'?'chest':'spruce_planks',position:{x:-323,y:67,z:-25},ownershipRecorded:mode!=='unowned',purpose:mode==='untyped'?undefined:'owned_combat_cleanup',currentPresence:'UNKNOWN',resourceArrival:'NOT_CONFIRMED'},before=copy(s);
 assert.equal(selectSurfaceExplorationFrontier(s,anchor,hint),['owned_cleanup','chest'].includes(mode)?1:0);assert.deepEqual(s,before);assert.equal(hint.currentPresence,'UNKNOWN');assert.equal(hint.resourceArrival,'NOT_CONFIRMED');
});
