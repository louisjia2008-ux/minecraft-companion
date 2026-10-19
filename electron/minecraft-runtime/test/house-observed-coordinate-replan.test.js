'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {selectSurfaceExplorationFrontier,createLoadedDryGraph,hasGroundedBodySupport,runSurfaceGraphNativeProbe}=require('../vendor/server/minecraft/houseSurfaceGraph');
const copy=x=>JSON.parse(JSON.stringify(x)),key=p=>`${p.x},${p.y},${p.z}`,anchor={x:0,y:2,z:0};
function observed(positions){const nodes={},order=[];for(const p of positions){const id=key(p);nodes[id]={position:p,parent:order.at(-1)||null,expanded:true};order.push(id);}return{schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:64,nodes,order,current:order.at(-1),resumeNode:order.at(-1),frontier:[],blockedEdges:[],visits:order.length,probes:0};}
function fixture(t,{obstacle=false,resolveWithoutMovement=false}={}){
 let checkpoint=observed([anchor,{x:8,y:2,z:0},{x:8,y:2,z:8},{x:0,y:2,z:8}]),paused=false;const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),moves=[],points=[],writes=[],probes=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},inventory:{items:()=>[],slots:Array(46).fill(null)},game:{dimension:'overworld',minY:-64,height:384},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,_client:{state:'play',socket:{writable:true,destroyed:false}},entity:{position:new Vec3(.5,2,8.5),velocity:new Vec3(0,0,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,height:1.8,width:.6,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot.blockAt=raw=>{const p=raw.floored();if(p.x < -10||p.x>18||p.z < -10||p.z>18)return null;const name=p.y<2||obstacle&&p.z===4&&Math.abs(p.x)<=1&&p.y<4?'stone':'air';return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(name,value)=>{writes.push({name,value,paused});controls[name]=value;};bot.clearControlStates=()=>{for(const name of Object.keys(controls))bot.setControlState(name,false);};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};bot.physics=Physics(registry,{getBlock:bot.blockAt});pathfinder(bot);
 const native=bot.pathfinder.goto.bind(bot.pathfinder),previousProfile=bot.pathfinder.movements;
 const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),{getBlock:bot.blockAt}).apply(bot);points.push(bot.entity.position.clone());bot.emit('physicsTick');},5);
 const deps={getBot:()=>bot,assertActive:()=>{if(paused)throw Object.assign(new Error('paused'),{code:'paused'});},isMovementOwner:()=>true,getCP:()=>checkpoint,saveCP:s=>{checkpoint=copy(s);},pathprobe:(movements,goal,ms)=>{const result=bot.pathfinder.getPathTo(movements,goal,ms);probes.push({goal:{x:goal.x,y:goal.y,z:goal.z},status:result.status});return result;},actualnativegoto:async(goal,movements)=>{assert.equal(movements.canDig,false);assert.equal(movements.allowParkour,false);assert.equal(movements.scafoldingBlocks.length,0);moves.push({x:goal.x,y:goal.y,z:goal.z});if(!resolveWithoutMovement)await native(goal);}};
 const graph=createLoadedDryGraph(deps,{anchor,step:16,radius:64,maxNodes:16,maxEdges:128,legTimeoutMs:4000,timeoutMs:10000});
 t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});return{bot,graph,moves,points,writes,probes,deps,previousProfile,pause:()=>{paused=true;},state:()=>checkpoint};
}
test('current observed node with uncovered outward candidate precedes a farther unrelated branch',()=>{
 const s=observed([anchor,...[16,32,48,64,80,96].map(x=>({x,y:2,z:0})),{x:0,y:2,z:8}]);
 s.frontier=[{parent:key({x:96,y:2,z:0}),target:{x:112,y:2,z:0}},{parent:s.current,target:{x:0,y:2,z:24}}];const before=copy(s);
 assert.equal(selectSurfaceExplorationFrontier(s),1);assert.deepEqual(s,before);
});
test('native dry replan reaches the recorded camp directly without replaying three historical parents',{timeout:6000},async t=>{
 const f=fixture(t),before=copy(f.state()),result=await f.graph.returnToAnchor();
 assert.equal(result.confirmed,true);assert.deepEqual(result.actual,anchor);assert.deepEqual(f.moves,[anchor]);assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(f.state().visits,before.visits);assert.deepEqual(f.state().order,before.order);assert.deepEqual(Object.fromEntries(Object.entries(f.state().nodes).map(([id,n])=>[id,n.parent])),Object.fromEntries(Object.entries(before.nodes).map(([id,n])=>[id,n.parent])));assert.equal(f.bot.pathfinder.movements,f.previousProfile);
});
test('a newly observed solid obstacle makes original pathfinder replan a dry detour to the same recorded coordinate',{timeout:6000},async t=>{
 const f=fixture(t,{obstacle:true}),result=await f.graph.returnToAnchor();assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[anchor]);assert.ok(f.points.some(p=>p.z>=4&&p.z<=5&&(p.x < -1.3||p.x>2.3)),'Actual native movement detoured around the new two-block wall');assert.equal(f.state().visits,4);assert.equal(f.points.some(p=>p.y<2),false);assert.equal(hasGroundedBodySupport(f.bot),true);
});
test('resolved native callback without actual movement cannot credit recorded-coordinate arrival',{timeout:4000},async t=>{
 const f=fixture(t,{resolveWithoutMovement:true});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_move_unconfirmed');assert.equal(f.state().current,'0,2,8');assert.equal(f.state().visits,4);assert.deepEqual(f.moves,[anchor]);
});
test('captured owner pause during direct native replan leaves no late target or positive controls',{timeout:5000},async t=>{
 const f=fixture(t);f.bot.on('physicsTick',()=>{if(f.bot.entity.position.z<7)f.pause();});
 await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='paused');const moves=f.moves.length;await new Promise(r=>setTimeout(r,100));assert.equal(f.moves.length,moves);assert.equal(f.writes.some(w=>w.paused&&w.value),false);assert.equal(f.state().current,'0,2,8');assert.equal(f.state().visits,4);
});
test('after real direct camp return a new batch directly rejoins the same observed resource area without adding visits',{timeout:6000},async t=>{
 const f=fixture(t),original=copy(f.state()),resume=copy(f.state().nodes[f.state().resumeNode].position);
 await f.graph.returnToAnchor();assert.equal(f.state().resumeNode,key(resume));
 const next=await f.graph.next();assert.equal(next.moved,false);assert.deepEqual(f.moves,[anchor,resume]);assert.equal(f.state().current,key(resume));assert.equal(f.state().visits,original.visits);assert.deepEqual(f.state().order,original.order);assert.equal(hasGroundedBodySupport(f.bot),true);
});
test('original native generator partial yields can settle success within the same finite logical probe',t=>{
 const f=fixture(t),goal=new (require('mineflayer-pathfinder').goals.GoalBlock)(16,2,16);
 // A single explicit slow read during original AStar.compute guarantees a
 // partial slice independently of JIT/machine speed. It is a test-only
 // planning counterexample, not evidence about a historical server delay.
 const original=f.bot.blockAt;let reads=0;
 f.bot.blockAt=p=>{if(++reads===2){const until=Date.now()+42;while(Date.now()<until){ /* deliberate single native read delay */ }}return original(p);};
 const observed=runSurfaceGraphNativeProbe(f.bot,f.graph.movements,goal,{assertActive:()=>{},isOwnerCurrent:()=>true});
 assert.equal(observed.result.status,'success');assert.ok(observed.facts.yieldStatuses.includes('partial'));assert.ok(observed.facts.slices>1&&observed.facts.slices<=16);assert.equal(observed.facts.conclusive,true);assert.equal(f.moves.length,0);
 assert.ok(observed.facts.elapsedMs<=100);
});

test('a native terminal success arriving after the original budget remains inconclusive and sends no movement',t=>{
 const f=fixture(t),goal=new (require('mineflayer-pathfinder').goals.GoalBlock)(1,2,8);
 const original=f.bot.blockAt;let reads=0;
 // This first read occurs before upstream AStar starts its own timer.
 f.bot.blockAt=p=>{if(++reads===1){const until=Date.now()+120;while(Date.now()<until){ /* bounded test-only cold read */ }}return original(p);};
 const observed=runSurfaceGraphNativeProbe(f.bot,f.graph.movements,goal,{assertActive:()=>{},isOwnerCurrent:()=>true});
 assert.equal(observed.result.status,'success');assert.ok(observed.facts.elapsedMs>100);
 assert.equal(observed.facts.conclusive,false);assert.equal(observed.facts.stopReason,'wall_deadline');
 assert.equal(f.moves.length,0);assert.equal(f.bot.pathfinder.goal,null);
});
test('native timeout or slice-limit facts remain inconclusive and never become a false noPath',t=>{
 const f=fixture(t),goal=new (require('mineflayer-pathfinder').goals.GoalBlock)(200,2,200);
 const observed=runSurfaceGraphNativeProbe(f.bot,f.graph.movements,goal,{assertActive:()=>{},isOwnerCurrent:()=>true,timeoutMs:2,tickTimeoutMs:.5});
 assert.ok(['partial','timeout'].includes(observed.result?.status));assert.equal(observed.facts.conclusive,false);assert.ok(observed.facts.slices<=16);assert.equal(f.moves.length,0);assert.deepEqual(observed.facts.target,{x:200,y:2,z:200});
});
test('owner cancellation after an actual native yield stops later slices and sends no movement',t=>{
 const f=fixture(t),goal=new (require('mineflayer-pathfinder').goals.GoalBlock)(16,2,16);let checks=0;
 assert.throws(()=>runSurfaceGraphNativeProbe(f.bot,f.graph.movements,goal,{assertActive:()=>{if(++checks===3)throw Object.assign(new Error('paused'),{code:'paused'});},isOwnerCurrent:()=>true,tickTimeoutMs:1}),e=>e.code==='paused'&&e.observedProbe.slices===1);
 assert.equal(f.moves.length,0);assert.equal(f.bot.pathfinder.goal,null);
 let ownershipChecks=0;
 assert.throws(()=>runSurfaceGraphNativeProbe(f.bot,f.graph.movements,goal,{assertActive:()=>{},isOwnerCurrent:()=>++ownershipChecks<3,tickTimeoutMs:1}),e=>e.code==='dry_graph_movement_preempted'&&e.observedProbe.slices===1);
 assert.equal(f.moves.length,0);assert.equal(f.bot.pathfinder.goal,null);
});
