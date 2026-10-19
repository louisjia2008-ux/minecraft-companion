/* global require, process, setInterval, clearInterval, setTimeout, clearTimeout */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const api=require(process.env.HOUSE_DRY_TRAIL_RUNTIME?`${process.env.HOUSE_DRY_TRAIL_RUNTIME}/vendor/server/minecraft/houseSurfaceGraph.js`:'../vendor/server/minecraft/houseSurfaceGraph');
const clone=v=>JSON.parse(JSON.stringify(v)),key=p=>`${p.x},${p.y},${p.z}`;
function fixture(t,{siteMode=false,drop=false,fresh=true,noArrival=false,slowLandingMs=0,stopLanding=false,legTimeoutMs=12000,maxEdges=512,offset={x:0,y:0,z:0},terrain='stone'}={}){
 const anchor={x:offset.x,y:offset.y+(drop?3:2),z:offset.z},target={x:offset.x+16,y:offset.y+2,z:offset.z},origin=key(anchor),id=key(target),controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false]));
 let cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:64,nodes:{[origin]:{position:anchor,parent:null,expanded:true}},order:[origin],current:origin,resumeNode:origin,visits:1,probes:0,blockedEdges:[],frontier:fresh?[{parent:origin,target}]:[]},owner=true,paused=false,coldWhole=false,smallFailureX=null,afterRetry=null;
 if(!fresh){cp.nodes[id]={position:target,parent:origin,expanded:true};cp.order.push(id);cp.visits=2;cp.resumeNode=id;}
 const poses=[],writes=[],moves=[],facts=[],saved=[],calls=[],edits=new Map(),goalReceipts=[];
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,entities:{},players:{},player:{ping:1},inventory:{items:()=>[],slots:Array(46).fill(null)},game:{minY:-64,height:384,dimension:'overworld'},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
  _client:{state:'play',socket:{writable:true,destroyed:false}},entity:{position:new Vec3(anchor.x+.5,anchor.y,anchor.z+.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,yaw:0,pitch:0,width:.6,height:1.8,eyeHeight:1.62,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 bot.blockAt=raw=>{const p=raw.floored(),x=p.x-offset.x,z=p.z-offset.z;if(x < -4||x>24||Math.abs(z)>1)return null;const change=edits.get(key(p));if(change===null)return null;const top=offset.y+(drop&&x<16?2:1),name=change||(p.y<=top?terrain:'air');return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(name,value)=>{writes.push({name,value,owner,paused,graph:new Error().stack.includes('houseSurfaceGraph.js')});controls[name]=value;};bot.clearControlStates=()=>{for(const n of Object.keys(controls))bot.setControlState(n,false);};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
 const world={getBlock:p=>bot.blockAt(p)};bot.physics=Physics(registry,world);pathfinder(bot);
 const native=bot.pathfinder.goto.bind(bot.pathfinder),get=bot.pathfinder.getPathFromTo.bind(bot.pathfinder),previous=bot.pathfinder.movements;
 // All route generators remain the installed original. Declared wall-clock
 // read latency creates UNKNOWN; no partial path or pose is fabricated.
 bot.pathfinder.getPathFromTo=function*(m,p,g,o={}){calls.push({timeout:o.timeout,target:{x:g.x,y:g.y,z:g.z}});const read=bot.blockAt;let reads=0;
  if(coldWhole&&o.timeout===500&&p.distanceTo(new Vec3(g.x,g.y,g.z))>3)bot.blockAt=q=>{if(++reads===1){const until=Date.now()+600;while(Date.now()<until){/* declared slow original read */}}return read(q);};
  try{yield*get(m,p,g,o);}finally{bot.blockAt=read;if(o.timeout===500)afterRetry?.();}
 };
 const deps={getBot:()=>bot,assertActive:()=>{if(paused)throw Object.assign(Error('paused'),{code:'paused'});},isMovementOwner:()=>owner,getCP:()=>cp,saveCP:s=>{cp=clone(s);saved.push(clone(s));},onProbe:r=>facts.push(clone(r)),
  pathprobe:(m,g,ms)=>{const read=bot.blockAt;let reads=0;const cold=coldWhole&&(bot.entity.position.distanceTo(new Vec3(g.x,g.y,g.z))>3||g.x===smallFailureX);
   if(cold)bot.blockAt=q=>{if(++reads===1){const until=Date.now()+120;while(Date.now()<until){/* explicit100ms UNKNOWN fixture */}}return read(q);};try{return bot.pathfinder.getPathTo(m,g,ms);}finally{bot.blockAt=read;}},
  actualnativegoto:async(g,m)=>{moves.push({x:g.x,y:g.y,z:g.z});assert.equal(m.canDig,false);assert.equal(m.allowParkour,false);assert.equal(m.scafoldingBlocks.length,0);if(!noArrival)await native(g);}};
 let graph=api.createLoadedDryGraph(deps,{anchor,radius:64,maxNodes:32,maxEdges,timeoutMs:60000,legTimeoutMs,deferInconclusiveExplorationReplay:siteMode});
 let timer,lateTimer;const tick=()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);poses.push({x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z,onGround:bot.entity.onGround});bot.emit('physicsTick');};timer=setInterval(tick,5);
 bot.on('goal_reached',g=>{goalReceipts.push({at:Date.now(),target:{x:g.x,y:g.y,z:g.z},position:bot.entity.position.clone(),onGround:bot.entity.onGround});
  if((slowLandingMs||stopLanding)&&g.x===target.x){clearInterval(timer);timer=null;if(!stopLanding)timer=setInterval(tick,slowLandingMs);}});
 t.after(()=>{clearInterval(timer);clearTimeout(lateTimer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
 return{anchor,target,origin,id,bot,poses,writes,moves,facts,saved,calls,edits,goalReceipts,previous,get graph(){return graph;},state:()=>cp,
  cold:()=>{coldWhole=true;},failSmall:x=>{smallFailureX=x;},pause:()=>{paused=true;},loseOwner:()=>{owner=false;},
  afterRetry:fn=>{afterRetry=fn;},
  later:(fn,ms)=>{lateTimer=setTimeout(fn,ms);},reload:mutate=>{mutate(cp);graph=api.createLoadedDryGraph(deps,{anchor,radius:64,maxNodes:32,maxEdges,timeoutMs:60000,legTimeoutMs,deferInconclusiveExplorationReplay:siteMode});},
  async learn(){return fresh?graph.next():graph.travelToObservedNode({nodeId:id});}};
}
const stable=s=>({anchor:s.anchor,order:s.order,visits:s.visits,resumeNode:s.resumeNode,parents:Object.fromEntries(Object.entries(s.nodes).map(([id,n])=>[id,n.parent]))});

test('successful original Physics leg records only genuinely grounded foot observations and source states',{timeout:12000},async t=>{
 const f=fixture(t);let sent=false;f.bot.on('physicsTick',()=>{if(!sent&&f.bot.entity.position.x>5){sent=true;f.bot.emit('path_update',{status:'success',path:[{x:999,y:2,z:999}]});}});
 await f.learn();const trail=f.state().nodes[f.id].dryParentTrail;assert.ok(trail);assert.equal(trail.kind,'actual_successful_dry_parent_edge');assert.equal(trail.from,f.origin);assert.equal(trail.to,f.id);assert.ok(trail.points.length>10&&trail.points.length<=128);
 assert.ok(trail.points.every(p=>Math.abs(p.actual.y-p.position.y)<=.07&&p.supports.every(s=>Number.isSafeInteger(s.stateId)&&s.stateId===registry.blocksByName.stone.defaultState)));
 for(const p of trail.points.slice(1,-1))assert.ok(f.poses.some(q=>q.onGround&&q.x===p.actual.x&&q.y===p.actual.y&&q.z===p.actual.z));
 assert.ok(trail.points.every(p=>p.position.x<100));assert.equal(f.state().visits,2);assert.equal(f.state().order.length,2);
});
test('wholeedge100+500 UNKNOWN can replay actual tiny foot coordinates with real arrival and no extra graph credit',{timeout:15000},async t=>{
 const f=fixture(t);await f.learn();const before=stable(f.state()),oldMoves=f.moves.length;f.cold();const r=await f.graph.returnToAnchor();
 assert.equal(r.confirmed,true);assert.deepEqual(r.actual,f.anchor);assert.deepEqual(stable(f.state()),before);assert.equal(f.state().current,f.origin);assert.equal(f.state().pendingDryTrail,null);
 assert.ok(f.calls.some(c=>c.timeout===500));assert.ok(f.moves.slice(oldMoves).length>10);assert.ok(f.moves.slice(oldMoves).slice(0,-1).every(p=>!before.order.includes(key(p))));
 assert.ok(f.saved.some(s=>s.pendingDryTrail?.confirmedPrefix.length>2&&s.current===f.id));assert.equal(f.bot.pathfinder.movements,f.previous);
});
test('actual trails and native replay use the same rules at translated origins heights and natural terrain states',{timeout:18000},async t=>{
 for(const options of [{offset:{x:-64,y:-4,z:128},terrain:'dirt'},{offset:{x:37,y:65,z:-41},terrain:'grass_block'}]){
  const f=fixture(t,options);await f.learn();const before=stable(f.state()),trail=f.state().nodes[f.id].dryParentTrail;
  assert.ok(trail);assert.equal(trail.points[0].position.y,options.offset.y+2);assert.ok(trail.points.every(p=>p.supports.every(s=>s.stateId===registry.blocksByName[options.terrain].defaultState)));
  f.cold();const r=await f.graph.returnToAnchor();assert.deepEqual(r.actual,f.anchor);assert.deepEqual(stable(f.state()),before);
 }
});
for(const value of ['dirt',null,'magma_block'])test(`changed or unknown recorded support ${value} denies replay before any new goto`,{timeout:10000},async t=>{
 const f=fixture(t);await f.learn();const before=stable(f.state()),count=f.moves.length;
 if(value===null)f.afterRetry(()=>f.edits.set('8,1,0',null));else f.edits.set('8,1,0',value);
 f.cold();await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_trail_route_changed');assert.equal(f.moves.length,count);assert.deepEqual(stable(f.state()),before);
});
test('partial real prefix remains uncredited and later cleanup cannot borrow another registered node',{timeout:12000},async t=>{
 const f=fixture(t);await f.learn();f.reload(cp=>{cp.nodes['14,2,0']={position:{x:14,y:2,z:0},parent:f.origin,expanded:true};cp.order.push('14,2,0');cp.visits++;});const before=stable(f.state());f.cold();f.failSmall(13);
 await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_probe_inconclusive'&&e.observedDryTrailReplay?.confirmedPrefix.length>=3);
 assert.equal(key(f.bot.entity.position.floored()),'14,2,0');assert.equal(f.state().current,f.id);assert.deepEqual(stable(f.state()),before);assert.ok(f.state().pendingDryTrail.confirmedPrefix.length>=3);
 const count=f.moves.length;await assert.rejects(f.graph.returnToAnchor({via:[f.target,{x:14,y:2,z:0}]}),e=>e.code==='dry_graph_trail_reconciliation_required');await assert.rejects(f.graph.next(),e=>e.code==='dry_graph_trail_reconciliation_required');assert.equal(f.moves.length,count);assert.deepEqual(stable(f.state()),before);
});
test('pause during a real replay prefix sends no late graph controls or endpoint credit',{timeout:12000},async t=>{
 const f=fixture(t);await f.learn();const before=stable(f.state());f.cold();f.bot.on('physicsTick',()=>{if(f.bot.entity.position.x<14.9)f.pause();});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='paused');await new Promise(r=>setTimeout(r,80));
 assert.equal(f.writes.some(w=>w.paused&&w.graph&&w.value),false);assert.equal(f.state().current,f.id);assert.deepEqual(stable(f.state()),before);assert.ok(f.state().pendingDryTrail);
});
test('foreign owner during a real prefix preserves its replacement goal and profile with no late graph writes',{timeout:12000},async t=>{
 const f=fixture(t);await f.learn();const before=stable(f.state());f.cold();let foreign;
 f.bot.on('physicsTick',()=>{if(!foreign&&f.bot.entity.position.x<14.9){f.loseOwner();foreign={profile:new Movements(f.bot),goal:new goals.GoalBlock(90,2,0)};f.bot.pathfinder.setMovements(foreign.profile);f.bot.pathfinder.setGoal(foreign.goal);}});
 await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_movement_preempted'||e.name==='GoalChanged');
 assert.ok(foreign);assert.equal(f.bot.pathfinder.movements,foreign.profile);assert.equal(f.bot.pathfinder.goal,foreign.goal);assert.equal(f.writes.some(w=>!w.owner&&w.graph&&w.value),false);assert.deepEqual(stable(f.state()),before);assert.equal(f.state().current,f.id);assert.ok(f.state().pendingDryTrail);
});
test('original global probe budget stops a real prefix without granting any micro node',{timeout:12000},async t=>{
 const f=fixture(t,{maxEdges:6});await f.learn();const before=stable(f.state());f.cold();await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_probe_limit');
 assert.deepEqual(stable(f.state()),before);assert.equal(f.state().current,f.id);assert.ok(f.state().pendingDryTrail);assert.equal(Object.keys(f.state().nodes).length,2);
});
test('shared original edge deadline accounts for the preceding100 and500 probes',{timeout:6000},async t=>{
 const f=fixture(t,{legTimeoutMs:750});await f.learn();const count=f.moves.length,before=stable(f.state());f.cold();await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_leg_timeout');
 assert.equal(f.moves.length,count);assert.deepEqual(stable(f.state()),before);assert.equal(f.state().current,f.id);
});
test('an original conclusive noPath cannot borrow an old successful trace',{timeout:8000},async t=>{
 const f=fixture(t);await f.learn();const count=f.moves.length,before=stable(f.state());for(let x=2;x<=13;x++)for(let z=-1;z<=1;z++)f.edits.set(`${x},1,${z}`,'water');
 await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_native_no_path');assert.equal(f.moves.length,count);assert.equal(f.calls.some(c=>c.timeout===500),false);assert.deepEqual(stable(f.state()),before);
});
test('owner loss in the initial pure target read leaks no physics or path listeners',async t=>{
 const f=fixture(t),read=f.bot.blockAt,counts={physics:f.bot.listenerCount('physicsTick'),path:f.bot.listenerCount('path_update'),reset:f.bot.listenerCount('path_reset')};let changed=false,foreign;
 f.bot.blockAt=(p,...args)=>{if(!changed&&p.x===16&&p.y===2){changed=true;f.loseOwner();foreign=new Movements(f.bot);f.bot.pathfinder.setMovements(foreign);}return read(p,...args);};
 await assert.rejects(f.learn(),e=>e.code==='dry_graph_movement_preempted');assert.equal(f.bot.listenerCount('physicsTick'),counts.physics);assert.equal(f.bot.listenerCount('path_update'),counts.path);assert.equal(f.bot.listenerCount('path_reset'),counts.reset);assert.equal(f.bot.pathfinder.movements,foreign);assert.equal(f.moves.length,0);assert.equal(f.writes.some(w=>!w.owner&&w.graph&&w.value),false);
});
test('malformed planned/oversized/gapped saved trails receive no replay authority',async t=>{
 for(const mutate of [cp=>cp.nodes['16,2,0'].dryParentTrail.kind='planned_path',cp=>cp.nodes['16,2,0'].dryParentTrail.points=Array(129).fill(cp.nodes['16,2,0'].dryParentTrail.points[0]),cp=>cp.nodes['16,2,0'].dryParentTrail.points.splice(1,8)]){
  const f=fixture(t);await f.learn();assert.throws(()=>f.reload(mutate),e=>e.code==='dry_graph_checkpoint_changed');
 }
});
test('a resolved native callback without actual movement never stores a successful edge trace',async t=>{
 const f=fixture(t,{noArrival:true});const r=await f.graph.next();assert.equal(r.moved,false);assert.equal(f.state().nodes[f.id],undefined);assert.equal(f.state().order.length,1);assert.equal(f.state().visits,1);
});
test('post-goal slow native descending Physics can land safely after1500ms within the original leg budget',{timeout:12000},async t=>{
 const f=fixture(t,{drop:true,fresh:false,slowLandingMs:600});const r=await f.learn(),receipt=f.goalReceipts.find(r=>r.target.x===16);
 assert.equal(r.confirmed,true);assert.deepEqual(r.actual,f.target);assert.ok(receipt);assert.equal(receipt.onGround,false);assert.ok(Date.now()-receipt.at>1500);assert.equal(f.bot.entity.onGround,true);assert.equal(f.state().current,f.id);assert.equal(f.state().visits,2);
});
test('post-goal unresolved landing cannot acquire credit beyond5000ms',{timeout:10000},async t=>{
 const f=fixture(t,{drop:true,fresh:false,stopLanding:true});await assert.rejects(f.learn(),e=>e.code==='dry_graph_move_unconfirmed'&&e.observedLanding?.nativeGotoResolved===true&&e.observedLanding.elapsedMs>=4900);assert.equal(f.state().current,f.origin);assert.equal(f.state().nodes[f.id].dryParentTrail,undefined);
});
test('post-goal slow landing keeps its original shorter leg deadline',{timeout:5000},async t=>{
 const f=fixture(t,{drop:true,fresh:false,slowLandingMs:600,legTimeoutMs:1200});await assert.rejects(f.learn(),e=>e.code==='dry_graph_leg_timeout'||e.code==='dry_graph_move_unconfirmed');assert.equal(f.state().current,f.origin);assert.equal(f.state().nodes[f.id].dryParentTrail,undefined);
});
for(const mode of ['pause','foreign','health'])test(`post-goal slow landing rejects ${mode} without late graph controls or credit`,{timeout:5000},async t=>{
 const f=fixture(t,{drop:true,fresh:false,slowLandingMs:600});let scheduled=false,foreign;
 f.bot.on('goal_reached',()=>{if(!scheduled){scheduled=true;f.later(()=>{if(mode==='pause')f.pause();else if(mode==='health')f.bot.health=5;else{f.loseOwner();foreign={profile:new Movements(f.bot),goal:new goals.GoalBlock(90,2,0)};f.bot.pathfinder.setMovements(foreign.profile);f.bot.pathfinder.setGoal(foreign.goal);}},40);}});
 await assert.rejects(f.learn(),e=>mode==='pause'?e.code==='paused':mode==='health'?e.code==='dry_graph_survival_limit':e.code==='dry_graph_movement_preempted');
 assert.equal(f.state().current,f.origin);assert.equal(f.state().nodes[f.id].dryParentTrail,undefined);assert.equal(f.writes.some(w=>(w.paused||!w.owner)&&w.graph&&w.value),false);
 if(foreign){assert.equal(f.bot.pathfinder.movements,foreign.profile);assert.equal(f.bot.pathfinder.goal,foreign.goal);}
});

test('formal23 site exploration defers an unmoved UNKNOWN old branch while explicit camp return still physically replays its actual trail',{timeout:18000},async t=>{
 const f=fixture(t,{siteMode:true});await f.learn();const before=f.moves.length;
 f.reload(cp=>{cp.resumeNode=f.origin;cp.nodes[f.id].expanded=true;cp.frontier=[{parent:f.id,target:{x:18,y:2,z:0},plannedSteps:2}];});f.cold();
 const next=await f.graph.next();assert.equal(next.moved,true);assert.deepEqual(next.actual,{x:18,y:2,z:0});
 assert.ok(f.moves.slice(before).every(p=>p.x>=16),'Optional old-root replay cannot move the site search backward');
 assert.ok(f.state().blockedEdges.some(e=>e.kind==='unconfirmed_site_parent_replay'&&e.targetNode===f.origin));
 assert.equal(Boolean(f.state().pendingDryTrail),false);assert.equal(f.state().visits,3);
 const returned=await f.graph.returnToAnchor();assert.equal(returned.confirmed,true);assert.equal(key(f.bot.entity.position.floored()),f.origin);assert.equal(f.bot.entity.onGround,true);assert.equal(f.state().visits,3);
});
