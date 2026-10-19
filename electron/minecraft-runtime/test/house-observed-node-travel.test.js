/* global require, setInterval, clearInterval, setTimeout */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const {createLoadedDryGraph,createHouseSurfaceGraph,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const clone=x=>JSON.parse(JSON.stringify(x)),key=p=>`${p.x},${p.y},${p.z}`,anchor={x:0,y:2,z:0};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function observed(positions=[anchor,{x:8,y:2,z:0},{x:8,y:2,z:8}]){
  const nodes={},order=[];for(const p of positions){const id=key(p);nodes[id]={position:clone(p),parent:order.at(-1)||null,expanded:true};order.push(id);}
  return{schema:2,kind:'loaded_dry_waypoint_graph',anchor:clone(anchor),step:16,radius:64,nodes,order,current:key(anchor),resumeNode:order.at(-1),frontier:[],blockedEdges:[],visits:order.length,probes:0};
}
// Component-only scenarios: saved node identities are initial fixture input.
// Every subsequent actor motion is installed pathfinder and native Physics.
function fixture(t,{checkpoint=observed(),initialPosition,worldAt,resolveWithoutMovement=false,coldProbe,
  water=false,pending=false,facade=false,foreignAfterLanding=false}={}){
  let cp=clone(checkpoint),paused=false,owner=true;const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false]));
  const moves=[],points=[],writes=[],crossings=[],saved=[],probeFacts=[];
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'ObservedNodeNative',health:20,food:20,oxygenLevel:20,
    entities:{},players:{},player:{ping:1},inventory:{items:()=>[],slots:Array(46).fill(null)},game:{dimension:'overworld',minY:-64,height:384,gameMode:'survival'},
    controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,_client:{state:'play',socket:{writable:true,destroyed:false}},
    entity:{position:initialPosition?.clone()||new Vec3(.5,2,.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,yaw:0,pitch:0,eyeHeight:1.62,
      height:1.8,width:.6,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
  bot.blockAt=raw=>{const p=raw.floored();let name;if(worldAt)name=worldAt(p);else if(water&&(Math.abs(p.z)>1||p.x < -2||p.x>14))return null;
    else name=p.y<1?'stone':p.y===1?(water&&p.x>=8&&p.x<=11?'water':p.x<3?'sand':'stone'):'air';
    if(name===null)return null;return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
  bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};
  bot.setControlState=(name,value)=>{writes.push({name,value,paused,owner});controls[name]=value;};
  bot.clearControlStates=()=>{for(const name of Object.keys(controls))bot.setControlState(name,false);};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
  const world={getBlock:bot.blockAt};bot.physics=Physics(registry,world);pathfinder(bot);const native=bot.pathfinder.goto.bind(bot.pathfinder),previous=bot.pathfinder.movements;
  const tokenCheck=()=>{if(paused)throw Object.assign(new Error('paused'),{code:'paused'});};
  const route={schema:1,kind:'loaded_source_water_wade',depth:1,width:4,surfaceY:2,from:{x:7,y:2,z:0},to:{x:12,y:2,z:0},waterStart:{x:8,z:0},direction:{x:1,z:0}};
  if(water){cp=observed([anchor,{x:12,y:2,z:0}]);cp.nodes['12,2,0'].transport={kind:'source_water_depth1',route:clone(route)};
    if(pending)cp.pendingWater={edge:{parent:key(anchor),target:{x:12,y:2,z:0},transport:clone(cp.nodes['12,2,0'].transport)},reverse:false,originNode:key(anchor)};}
  const deps={getBot:()=>bot,assertActive:tokenCheck,isMovementOwner:()=>owner,getCP:()=>cp,saveCP:s=>{cp=clone(s);saved.push(clone(s));},onProbe:f=>probeFacts.push(clone(f)),
    actualnativegoto:async(goal,movements)=>{assert.equal(movements.canDig,false);assert.equal(movements.allowParkour,false);assert.equal(movements.scafoldingBlocks.length,0);
      moves.push({x:goal.x,y:goal.y,z:goal.z});if(water)assert.ok(goal.x<=7,'Dry native goto cannot cross a typed river');
      if(!resolveWithoutMovement)await native(goal);
      if(foreignAfterLanding){owner=false;const profile=new Movements(bot),goal=new goals.GoalBlock(4,2,4);bot.pathfinder.setMovements(profile);bot.pathfinder.setGoal(goal);f.foreign={profile,goal,writeCount:writes.length};}
    }};
  if(coldProbe)deps.pathprobe=(movements,goal,ms)=>{const original=bot.blockAt;let reads=0;
    if(coldProbe(goal,bot.entity.position))bot.blockAt=p=>{if(++reads===1){const until=Date.now()+120;while(Date.now()<until){/* bounded cold native read */}}return original(p);};
    try{return bot.pathfinder.getPathTo(movements,goal,ms);}finally{bot.blockAt=original;}};
  if(water){deps.discoverWaterRoutes=()=>[];deps.traverseWater=async r=>{tokenCheck();assert.deepEqual({x:Math.floor(bot.entity.position.x),y:Math.floor(bot.entity.position.y),z:Math.floor(bot.entity.position.z)},r.from);
    const before=bot.pathfinder.movements,m=new Movements(bot);m.canDig=false;m.scafoldingBlocks=[];m.allowParkour=false;m.allowSprinting=false;m.allow1by1towers=false;
    m.maxDropDown=2;m.infiniteLiquidDropdownDistance=false;m.getMoveDiagonal=()=>{};m.exclusionAreasStep.push(b=>b?.position?.z===0&&b.position.x>=7&&b.position.x<=12?0:Infinity);
    bot.pathfinder.setMovements(m);crossings.push({from:clone(r.from),to:clone(r.to)});
    try{await native(new goals.GoalBlock(r.to.x,r.to.y,r.to.z));for(let n=0;n<100&&!hasGroundedBodySupport(bot);n++){tokenCheck();await sleep(5);}tokenCheck();assert.equal(hasGroundedBodySupport(bot),true);return{confirmed:true};}
    finally{if(owner&&bot.pathfinder.movements===m)bot.pathfinder.setMovements(before);}};}
  const graphOptions={anchor,step:16,radius:64,maxNodes:32,maxEdges:128,legTimeoutMs:4000,timeoutMs:20000};
  const graph=facade?createHouseSurfaceGraph(deps,graphOptions):createLoadedDryGraph(deps,graphOptions);
  const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);points.push({position:bot.entity.position.clone(),wet:bot.entity.isInWater});bot.emit('physicsTick');},5);
  t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
  const f={bot,graph,deps,moves,points,writes,crossings,saved,probeFacts,previous,state:()=>cp,pause:()=>{paused=true;},loseOwner:()=>{owner=false;},
    travel:args=>facade?graph.travelToObservedNode({anchor,...args}):graph.travelToObservedNode(args)};return f;
}
const invariant=s=>({anchor:s.anchor,resumeNode:s.resumeNode,visits:s.visits,order:s.order,parents:Object.fromEntries(Object.entries(s.nodes).map(([id,n])=>[id,n.parent]))});

test('existing native guarded travel reaches observed stone entry from sand camp and returns without moving the camp or exploration resume',{timeout:8000},async t=>{
  const f=fixture(t),before=invariant(f.state()),entry={x:8,y:2,z:0};
  assert.equal(f.bot.blockAt(new Vec3(0,1,0)).name,'sand');assert.equal(f.bot.blockAt(new Vec3(8,1,0)).name,'stone');
  const arrived=await f.travel({nodeId:key(entry)});assert.equal(arrived.confirmed,true);assert.deepEqual(arrived.actual,entry);
  assert.deepEqual(arrived.observedReturn,[anchor,entry]);assert.equal(hasGroundedBodySupport(f.bot),true);assert.deepEqual(invariant(f.state()),before);
  assert.equal(f.bot.pathfinder.movements,f.previous);assert.ok(f.points.length>20);assert.ok(f.points.every(p=>!p.wet));
  const returned=await f.graph.returnToAnchor();assert.deepEqual(returned.actual,anchor);assert.deepEqual(invariant(f.state()),before);
  assert.deepEqual(f.moves,[entry,anchor]);assert.equal(f.state().current,key(anchor));
});

test('facade exactPosition keeps its original fixed anchor and never creates a new observed node',{timeout:8000},async t=>{
  const f=fixture(t,{facade:true}),before=invariant(f.state());
  await f.travel({exactPosition:{x:8,y:2,z:0}});assert.deepEqual(invariant(f.state()),before);
  await assert.rejects(f.graph.travelToObservedNode({anchor:{x:1,y:2,z:0},nodeId:key(anchor)}),e=>e.code==='dry_graph_checkpoint_changed');
  const count=f.moves.length;await assert.rejects(f.travel({exactPosition:{x:5,y:2,z:0}}),e=>e.code==='dry_graph_observed_node_unconfirmed');
  assert.equal(f.moves.length,count);assert.deepEqual(invariant(f.state()),before);
});

test('entry travel leaves the next resource batch to physically resume its original observed exploration node',{timeout:8000},async t=>{
  const f=fixture(t),before=invariant(f.state());await f.travel({nodeId:'8,2,0'});
  const next=await f.graph.next();assert.equal(next.moved,false);assert.equal(f.state().current,'8,2,8');
  assert.deepEqual(f.moves,[{x:8,y:2,z:0},{x:8,y:2,z:8}]);assert.deepEqual(invariant(f.state()),before);assert.equal(hasGroundedBodySupport(f.bot),true);
});

test('direct return to an observed sibling uses the existing native coordinate replan and reports the recorded tree connection',{timeout:8000},async t=>{
  const cp=observed([anchor,{x:8,y:2,z:0},{x:8,y:2,z:8}]);cp.nodes['0,2,8']={position:{x:0,y:2,z:8},parent:key(anchor),expanded:true};cp.order.push('0,2,8');cp.visits++;
  cp.current='8,2,8';const f=fixture(t,{checkpoint:cp,initialPosition:new Vec3(8.5,2,8.5)}),before=invariant(f.state());
  const r=await f.travel({nodeId:'0,2,8'});assert.deepEqual(r.observedReturn,[{x:8,y:2,z:8},{x:8,y:2,z:0},anchor,{x:0,y:2,z:8}]);
  assert.deepEqual(f.moves,[{x:0,y:2,z:8}]);assert.deepEqual(invariant(f.state()),before);assert.equal(f.state().current,'0,2,8');
});

test('long inconclusive native plan falls back to the same existing guarded observed segments',{timeout:10000},async t=>{
  const cp=observed([0,12,24,36,48,60].map(x=>({x,y:2,z:0}))),f=fixture(t,{checkpoint:cp,coldProbe:(g,p)=>p.distanceTo(new Vec3(g.x,g.y,g.z))>32}),before=invariant(f.state());
  const r=await f.travel({nodeId:'60,2,0'});assert.deepEqual(r.actual,{x:60,y:2,z:0});
  assert.ok(f.moves.length>=2);assert.ok(f.moves.every(p=>cp.nodes[key(p)]));assert.deepEqual(invariant(f.state()),before);
  assert.ok(f.probeFacts.some(p=>p.stopReason==='wall_deadline'&&!p.conclusive));
});

for(const args of [{},{nodeId:123},{exactPosition:{x:8.5,y:2,z:0}},{nodeId:'8,2,0',exactPosition:anchor}])
  test(`invalid exact node request ${JSON.stringify(args)} sends no movement`,async t=>{
    const f=fixture(t),before=clone(f.state());await assert.rejects(f.travel(args),e=>e.code==='dry_graph_observed_node_invalid');
    assert.equal(f.moves.length,0);assert.deepEqual(f.state(),before);assert.equal(f.bot.pathfinder.movements,f.previous);
  });

test('nodes outside the confirmed order and actor off the recorded current node fail closed without suffix borrowing',async t=>{
  const cp=observed();cp.nodes['6,2,0']={position:{x:6,y:2,z:0},parent:key(anchor),expanded:true};
  const f=fixture(t,{checkpoint:cp});await assert.rejects(f.travel({nodeId:'6,2,0'}),e=>e.code==='dry_graph_observed_node_unconfirmed');assert.equal(f.moves.length,0);
  const off=fixture(t,{initialPosition:new Vec3(4.5,2,.5)}),before=clone(off.state());
  await assert.rejects(off.travel({nodeId:'8,2,0'}),e=>e.code==='dry_graph_rejoin_unconfirmed');assert.equal(off.moves.length,0);assert.deepEqual(off.state(),before);
});

test('empty graph cannot turn a travel request into a first visit or target registration',async t=>{
  const cp=observed();cp.nodes={};cp.order=[];cp.current=null;cp.resumeNode=null;cp.visits=0;
  const f=fixture(t,{checkpoint:cp}),before=clone(f.state());await assert.rejects(f.travel({exactPosition:anchor}),e=>e.code==='dry_graph_observed_node_unconfirmed');
  assert.deepEqual(f.state(),before);assert.equal(f.moves.length,0);assert.equal(f.bot.pathfinder.movements,f.previous);
});

for(const changed of [null,'water','lava','air'])test(`changed old node support ${changed} is rejected before moving`,async t=>{
  const f=fixture(t,{worldAt:p=>p.x===8&&p.y===1&&p.z===0?changed:p.y<2?'stone':'air'}),before=clone(f.state());
  await assert.rejects(f.travel({nodeId:'8,2,0'}),e=>e.code==='dry_graph_route_changed');assert.equal(f.moves.length,0);assert.deepEqual(f.state(),before);assert.equal(f.bot.pathfinder.movements,f.previous);
});

test('protected target and unsafe current body cannot authorize observed travel',async t=>{
  const f=fixture(t);await assert.rejects(f.travel({nodeId:'8,2,0',excludeBounds:[{minX:8,maxX:8,minY:2,maxY:2,minZ:0,maxZ:0}]}),e=>e.code==='dry_graph_route_changed');
  assert.equal(f.moves.length,0);
  const unsafe=fixture(t,{worldAt:p=>p.x===0&&p.y===1?'water':p.y<2?'stone':'air'});
  await assert.rejects(unsafe.travel({nodeId:'8,2,0'}),e=>e.code==='dry_graph_not_on_surface');assert.equal(unsafe.moves.length,0);
});

test('promise resolution without native arrival cannot credit an old target node',{timeout:5000},async t=>{
  const f=fixture(t,{resolveWithoutMovement:true}),before=invariant(f.state());await assert.rejects(f.travel({nodeId:'8,2,0'}),e=>e.code==='dry_graph_move_unconfirmed');
  assert.deepEqual(invariant(f.state()),before);assert.equal(f.state().current,key(anchor));assert.equal(f.bot.pathfinder.movements,f.previous);
});

test('pause during actual native travel prevents late positive controls and registration',{timeout:6000},async t=>{
  const f=fixture(t),before=invariant(f.state());f.bot.on('physicsTick',()=>{if(f.bot.entity.position.x>2)f.pause();});
  await assert.rejects(f.travel({nodeId:'8,2,0'}),e=>e.code==='paused');await sleep(100);
  assert.equal(f.writes.some(w=>w.paused&&w.value),false);assert.deepEqual(invariant(f.state()),before);assert.equal(f.state().current,key(anchor));assert.equal(f.bot.pathfinder.goal,null);
});

test('foreign movement owner and profile after native arrival stay intact without late target credit',{timeout:6000},async t=>{
  const f=fixture(t,{foreignAfterLanding:true}),before=invariant(f.state());await assert.rejects(f.travel({nodeId:'8,2,0'}),e=>e.code==='dry_graph_movement_preempted');
  assert.equal(f.bot.pathfinder.movements,f.foreign.profile);assert.equal(f.bot.pathfinder.goal,f.foreign.goal);
  assert.deepEqual(invariant(f.state()),before);assert.equal(f.state().current,key(anchor));
  assert.deepEqual(f.writes.slice(f.foreign.writeCount),[],'old travel cannot clear or change the replacement owner controls');
});

test('pre-existing pause or foreign owner sends no profile replacement or movement',async t=>{
  for(const pause of [false,true]){const f=fixture(t),before=clone(f.state());if(pause)f.pause();else f.loseOwner();
    await assert.rejects(f.travel({nodeId:'8,2,0'}),e=>e.code===(pause?'paused':'dry_graph_movement_preempted'));
    assert.equal(f.moves.length,0);assert.equal(f.bot.pathfinder.movements,f.previous);assert.deepEqual(f.state(),before);}
});

test('observed water child and reverse travel still require their exact dedicated transport',{timeout:12000},async t=>{
  const f=fixture(t,{water:true}),before=invariant(f.state());
  const out=await f.travel({nodeId:'12,2,0'});assert.deepEqual(out.actual,{x:12,y:2,z:0});
  const back=await f.travel({nodeId:key(anchor)});assert.deepEqual(back.actual,anchor);
  assert.deepEqual(f.crossings.map(c=>[c.from.x,c.to.x]),[[7,12],[12,7]]);assert.ok(f.points.some(p=>p.wet));
  assert.ok(f.moves.every(p=>p.x<=7));assert.deepEqual(invariant(f.state()),before);assert.equal(hasGroundedBodySupport(f.bot),true);
});

test('safe recorded origin recovers pending typed operation before observed travel and retains original resume plan',{timeout:10000},async t=>{
  const f=fixture(t,{water:true,pending:true}),before=invariant(f.state());const r=await f.travel({nodeId:'12,2,0'});
  assert.equal(r.confirmed,true);assert.equal(f.crossings.length,1);assert.equal(f.state().pendingWater,null);
  assert.deepEqual(invariant(f.state()),before);assert.equal(f.saved.some(cp=>cp.pendingWater===null&&cp.current===key(anchor)),true);
});

test('saved typed child without its dedicated adapter is rejected before any travel',async t=>{
  const f=fixture(t,{water:true});delete f.deps.traverseWater;
  assert.throws(()=>createLoadedDryGraph(f.deps,{anchor,step:16,radius:64}),e=>e.code==='dry_graph_transport_invalid');assert.equal(f.moves.length,0);assert.equal(f.crossings.length,0);
});
