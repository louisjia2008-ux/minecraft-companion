'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {createLoadedDryGraph,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const copy=x=>JSON.parse(JSON.stringify(x)),key=p=>`${p.x},${p.y},${p.z}`,anchor={x:0,y:2,z:0};
function observed(positions){const nodes={},order=[];for(const p of positions){const id=key(p);nodes[id]={position:p,parent:order.at(-1)||null,expanded:true};order.push(id);}return{schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:64,nodes,order,current:order.at(-1),resumeNode:order.at(-1),frontier:[],blockedEdges:[],visits:order.length,probes:0};}
function fixture(t,{obstacle=false,resolveWithoutMovement=false,positions=null,coldProbe=null}={}){
 let checkpoint=observed(positions || [anchor,{x:8,y:2,z:0},{x:8,y:2,z:8},{x:0,y:2,z:8}]),paused=false;const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),moves=[],points=[],writes=[],probes=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},inventory:{items:()=>[],slots:Array(46).fill(null)},game:{dimension:'overworld',minY:-64,height:384},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,_client:{state:'play',socket:{writable:true,destroyed:false}},entity:{position:new Vec3(checkpoint.nodes[checkpoint.current].position.x+.5,2,checkpoint.nodes[checkpoint.current].position.z+.5),velocity:new Vec3(0,0,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,height:1.8,width:.6,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot.blockAt=raw=>{const p=raw.floored();if(p.x < -256||p.x>256||p.z < -256||p.z>256)return null;const name=p.y<2||obstacle&&p.z===4&&Math.abs(p.x)<=1&&p.y<4?'stone':'air';return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(name,value)=>{writes.push({name,value,paused});controls[name]=value;};bot.clearControlStates=()=>{for(const name of Object.keys(controls))bot.setControlState(name,false);};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);
 const native=bot.pathfinder.goto.bind(bot.pathfinder),previousProfile=bot.pathfinder.movements;
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);points.push(bot.entity.position.clone());bot.emit('physicsTick');},5);
 const deps={getBot:()=>bot,assertActive:()=>{if(paused)throw Object.assign(new Error('paused'),{code:'paused'});},isMovementOwner:()=>true,getCP:()=>checkpoint,saveCP:s=>{checkpoint=copy(s);},pathprobe:(movements,goal,ms)=>{const original=bot.blockAt;let reads=0;if(coldProbe?.(goal,bot.entity.position))bot.blockAt=p=>{if(++reads===1){const until=Date.now()+120;while(Date.now()<until){ /* one native-read latency counterexample */ }}return original(p);};let result;try{result=bot.pathfinder.getPathTo(movements,goal,ms);}finally{bot.blockAt=original;}probes.push({goal:{x:goal.x,y:goal.y,z:goal.z},status:result.status});return result;},actualnativegoto:async(goal,movements)=>{assert.equal(movements.canDig,false);assert.equal(movements.allowParkour,false);assert.equal(movements.scafoldingBlocks.length,0);moves.push({x:goal.x,y:goal.y,z:goal.z});if(!resolveWithoutMovement)await native(goal);}};
 deps.onProbe=facts=>probes.push({observed:copy(facts)});const graph=createLoadedDryGraph(deps,{anchor,step:16,radius:64,maxNodes:16,maxEdges:128,legTimeoutMs:4000,timeoutMs:10000});
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});return{bot,graph,moves,points,writes,probes,deps,previousProfile,pause:()=>{paused=true;},state:()=>checkpoint};
}
test('long native planning deadline falls back to shorter observed coordinates while skipping historical nodes', {timeout:8000}, async t=>{
 const f=fixture(t,{positions:[0,12,24,36,48,60].map(x=>({x,y:2,z:0})),coldProbe:(goal,position)=>position.distanceTo(new Vec3(goal.x,goal.y,goal.z))>32});
 const before=copy(f.state()),result=await f.graph.returnToAnchor();
 assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[{x:36,y:2,z:0},{x:12,y:2,z:0},anchor]);
 assert.equal(f.state().visits,before.visits);assert.deepEqual(f.state().order,before.order);assert.deepEqual(Object.values(f.state().nodes).map(n=>n.parent),Object.values(before.nodes).map(n=>n.parent));
 assert.ok(f.probes.some(p=>p.observed?.stopReason==='wall_deadline'&&p.observed.conclusive===false));assert.equal(hasGroundedBodySupport(f.bot),true);
});
test('food handoff can physically return beyond32m at normal or low health along observed safe terrain',{timeout:10000},async t=>{
 const f=fixture(t,{positions:[0,16,32,48].map(x=>({x,y:2,z:0}))});f.bot.health=16.33;f.bot.food=17;
 const result=await f.graph.returnToAnchor({provisioningReturn:true});assert.equal(result.confirmed,true);
 assert.ok(f.points.length>20);assert.equal(Math.floor(f.bot.entity.position.x),0);assert.equal(f.bot.health,16.33);
 const low=fixture(t,{positions:[0,16,32,48].map(x=>({x,y:2,z:0}))});low.bot.health=5;low.bot.food=6;
 const returned=await low.graph.returnToAnchor({provisioningReturn:true});assert.equal(returned.confirmed,true);assert.ok(low.points.length>20);assert.equal(Math.floor(low.bot.entity.position.x),0);assert.equal(low.bot.health,5);
 await assert.rejects(low.graph.next(),{code:'dry_graph_survival_limit'});
});
test('four candidate bound reserves the immediate observed neighbor after three inconclusive shortcuts', {timeout:8000}, async t=>{
 const f=fixture(t,{positions:[0,4,8,12,16,20,24,28,32,36,40,44,48,56,60,64].map(x=>({x,y:2,z:0})),coldProbe:(goal,p)=>p.x>64&&([0,36,40,44].includes(goal.x))});
 const result=await f.graph.returnToAnchor();assert.equal(result.confirmed,true);assert.deepEqual(f.moves[0],{x:60,y:2,z:0});
 const observed=f.probes.filter(p=>p.observed);assert.deepEqual(observed.slice(1,4).map(p=>p.observed.target.x),[36,40,44]);assert.equal(f.state().visits,16);
});
test('all inconclusive direct and segmented plans remain UNKNOWN without actual movement or state credit', {timeout:8000}, async t=>{
 const f=fixture(t,{positions:[0,12,24,36,48,60].map(x=>({x,y:2,z:0})),coldProbe:()=>true}),before=copy(f.state());
 // Keep the original generator inconclusive for the guarded local-return
 // observation too; delaying only the old100ms hook no longer covers all plans.
 const original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);
 f.bot.pathfinder.getPathFromTo=function*(movements,position,goal,options={}){
  const read=f.bot.blockAt;let reads=0;
  if(options.timeout===500)f.bot.blockAt=p=>{if(++reads===1){const until=Date.now()+600;while(Date.now()<until){ /* declared original native cold-read latency */ }}return read(p);};
  try{yield*original(movements,position,goal,options);}finally{f.bot.blockAt=read;}
 };
 await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_probe_inconclusive'&&e.observedCoordinateSegments.directProbe.conclusive===false);
 assert.equal(f.moves.length,0);assert.equal(f.state().current,before.current);assert.equal(f.state().visits,before.visits);assert.deepEqual(f.state().order,before.order);
 assert.ok(f.probes.filter(p=>p.observed).every(p=>p.observed.conclusive===false));assert.equal(f.bot.pathfinder.movements,f.previousProfile);
});
test('segmented native callback without actual movement cannot credit an observed waypoint', {timeout:8000}, async t=>{
 const f=fixture(t,{positions:[0,12,24,36,48,60].map(x=>({x,y:2,z:0})),coldProbe:(goal,p)=>p.distanceTo(new Vec3(goal.x,goal.y,goal.z))>32,resolveWithoutMovement:true}),before=copy(f.state());
 await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_move_unconfirmed');assert.deepEqual(f.moves,[{x:36,y:2,z:0}]);assert.equal(f.state().current,before.current);assert.equal(f.state().visits,before.visits);
});
test('pause during segmented real native travel prevents late positive controls and waypoint credit', {timeout:8000}, async t=>{
 const f=fixture(t,{positions:[0,12,24,36,48,60].map(x=>({x,y:2,z:0})),coldProbe:(goal,p)=>p.distanceTo(new Vec3(goal.x,goal.y,goal.z))>32}),before=copy(f.state());
 f.bot.on('physicsTick',()=>{if(f.bot.entity.position.x<59)f.pause();});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='paused');await new Promise(r=>setTimeout(r,100));assert.equal(f.writes.some(w=>w.paused&&w.value),false);assert.equal(f.state().current,before.current);assert.equal(f.state().visits,before.visits);
});
