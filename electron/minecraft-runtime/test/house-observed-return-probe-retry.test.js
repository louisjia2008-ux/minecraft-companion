/* global require, process, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),{Physics,PlayerState}=require('prismarine-physics'),{pathfinder,Movements,goals}=require('mineflayer-pathfinder');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);
const api=require(process.env.HOUSE_RETURN_PROBE_RUNTIME?`${process.env.HOUSE_RETURN_PROBE_RUNTIME}/vendor/server/minecraft/houseSurfaceGraph.js`:'../vendor/server/minecraft/houseSurfaceGraph');
const clone=v=>JSON.parse(JSON.stringify(v)),anchor={x:0,y:2,z:0},key=p=>`${p.x},${p.y},${p.z}`;
function fixture(t,{originX=16,originY=2,actualX=originX+.5,fresh=false,waterGap=false,health=20,food=20,maxEdges=128,
  retryFault,lateRetryMs=0,lateNoPath=false,noArrival=false,coldProbe=true,facade=false}={}){
  const start={x:originX,y:originY,z:0},nodes={[key(anchor)]:{position:anchor,parent:null,expanded:true},[key(start)]:{position:start,parent:key(anchor),expanded:true}};
  let cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:16,radius:128,nodes,order:[key(anchor),key(start)],current:key(start),resumeNode:key(start),visits:2,probes:0,blockedEdges:[],frontier:fresh?[{parent:key(start),target:{x:32,y:2,z:0}}]:[]},owner=true;
  const controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false])),calls=[],moves=[],facts=[],writes=[],positions=[];
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health,food,entities:{},players:{},player:{ping:1},inventory:{slots:Array(46).fill(null),items:()=>[]},game:{minY:-64,height:384,dimension:'overworld'},
    controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,_client:{state:'play',socket:{writable:true,destroyed:false}},
    entity:{position:new Vec3(actualX,2,.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,yaw:0,pitch:0,width:.6,height:1.8,eyeHeight:1.62,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
  // The noPath witness is a genuinely small closed pocket, not a request to
  // exhaust ~100m of unrelated open corridor within a real100ms wall budget.
  // Keep the same12m water barrier and all original status/late-result checks.
  bot.blockAt=raw=>{const p=raw.floored();if(p.x < -4||p.x>(waterGap?20:112)||Math.abs(p.z)>1)return null;const name=waterGap&&p.x>=2&&p.x<=13&&p.y===1?'water':p.y<2?'stone':'air';return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
  bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};bot.setControlState=(name,value)=>{writes.push({name,value,owner});controls[name]=value;};
  bot.clearControlStates=()=>{for(const n of Object.keys(controls))bot.setControlState(n,false);};bot.stopDigging=()=>{};bot.deactivateItem=()=>{};
  const world={getBlock:p=>bot.blockAt(p)};bot.physics=Physics(registry,world);pathfinder(bot);
  const native=bot.pathfinder.goto.bind(bot.pathfinder),get=bot.pathfinder.getPathFromTo.bind(bot.pathfinder),previous=bot.pathfinder.movements;
  // This test-only wrapper always yields the installed native generator.
  // Explicit cold reads model wall-clock UNKNOWN, not a historical replay.
  bot.pathfinder.getPathFromTo=function*(m,p,g,options={}){
    calls.push({timeoutMs:options.timeout,goal:{x:g.x,y:g.y,z:g.z}});
    const read=bot.blockAt;let reads=0;
    if(options.timeout===500)bot.blockAt=q=>{
      if(++reads===1){if(lateRetryMs){const until=Date.now()+lateRetryMs;while(Date.now()<until){/* one declared native read latency */}}
        if(retryFault==='health')bot.health=15;
        if(retryFault==='foreign'){owner=false;const profile=new Movements(bot),goal=new goals.GoalBlock(8,2,0);bot.pathfinder.setMovements(profile);bot.pathfinder.setGoal(goal);f.foreign={profile,goal,writeCount:writes.length};}}
      return read(q);
    };
    try{yield*get(m,p,g,options);}finally{bot.blockAt=read;}
  };
  const deps={getBot:()=>bot,assertActive:()=>{},isMovementOwner:()=>owner,getCP:()=>cp,saveCP:s=>{cp=clone(s);},onProbe:r=>facts.push(clone(r)),
    pathprobe:(m,g,ms)=>{const read=bot.blockAt;let reads=0;bot.blockAt=q=>{if(++reads===1&&!waterGap&&coldProbe){const until=Date.now()+120;while(Date.now()<until){/* explicit finite cold-read counterexample */}}return read(q);};
      try{const result=bot.pathfinder.getPathTo(m,g,ms);
        if(lateNoPath){assert.equal(result.status,'noPath');const until=Date.now()+120;while(Date.now()<until){/* declared observer delay after the original native noPath */}}
        return result;}finally{bot.blockAt=read;}},
    actualnativegoto:async(g,m)=>{moves.push({x:g.x,y:g.y,z:g.z});assert.equal(m.canDig,false);assert.equal(m.allowParkour,false);assert.equal(m.scafoldingBlocks.length,0);if(!noArrival)await native(g);}};
  const graph=(facade?api.createHouseSurfaceGraph:api.createLoadedDryGraph)(deps,{anchor,radius:128,maxNodes:16,maxEdges,timeoutMs:10000,legTimeoutMs:3000});
  const timer=setInterval(()=>{bot.physics.simulatePlayer(new PlayerState(bot,controls),world).apply(bot);positions.push(bot.entity.position.clone());bot.emit('physicsTick');},5);
  t.after(()=>{clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();});
  const f={bot,graph,calls,moves,facts,writes,positions,previous,state:()=>cp};return f;
}

test('known local return can retry one complete original500ms probe after finite100ms UNKNOWN and physically arrive',{timeout:6000},async t=>{
  const f=fixture(t),before=clone(f.state());const r=await f.graph.returnToAnchor();assert.equal(r.confirmed,true);assert.deepEqual(r.actual,anchor);
  assert.equal(f.calls.filter(c=>c.timeoutMs===500).length,1);assert.deepEqual(f.moves,[anchor]);assert.ok(f.positions.length>20);
  assert.ok(f.facts.some(r=>r.observedReturnRetryPending&&r.budgetMs===100&&!r.conclusive));
  const proof=f.facts.find(r=>r.observedReturnRetry);assert.equal(proof.budgetMs,500);assert.equal(proof.retryIndex,1);assert.equal(proof.status,'success');assert.equal(proof.conclusive,true);
  assert.equal(proof.initialProbe.budgetMs,100);assert.equal(proof.initialProbe.conclusive,false);assert.ok(proof.slices<=50);
  assert.equal(f.state().visits,before.visits);assert.deepEqual(f.state().order,before.order);assert.equal(f.state().resumeNode,before.resumeNode);assert.equal(f.bot.pathfinder.movements,f.previous);
});

test('extended observed retry is private; the exported exploration probe still rejects500ms/50slice',t=>{
  const f=fixture(t);assert.throws(()=>api.runSurfaceGraphNativeProbe(f.bot,f.graph.movements,new goals.GoalBlock(0,2,0),{
    assertActive:()=>{},isOwnerCurrent:()=>true,timeoutMs:500,tickTimeoutMs:10,maxSlices:50}),e=>e.code==='dry_graph_invalid_probe');assert.equal(f.calls.length,0);assert.equal(f.moves.length,0);
});

test('conclusive original noPath receives no extended retry or movement',async t=>{
  const f=fixture(t,{waterGap:true});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_native_no_path');
  assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.moves.length,0);assert.equal(f.state().current,'16,2,0');
});

test('late original noPath remains UNKNOWN and receives no extended retry or movement',async t=>{
  const f=fixture(t,{waterGap:true,lateNoPath:true});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_probe_inconclusive'&&e.observedProbe.status==='noPath'&&!e.observedProbe.conclusive);
  assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.moves.length,0);assert.equal(f.state().current,'16,2,0');assert.equal(f.state().visits,2);
});

test('fresh exploration frontier cannot borrow the recorded return budget',{timeout:4000},async t=>{
  const f=fixture(t,{fresh:true});const r=await f.graph.next();assert.equal(r.moved,false);
  assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,2);assert.equal(f.state().nodes['32,2,0'],undefined);
});

test('recorded destination farther than32m cannot borrow the extended local budget',{timeout:4000},async t=>{
  const f=fixture(t,{originX:100});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_probe_inconclusive');
  assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,2);
});

test('an actual offgraph resource suffix gets one complete probe then physically rejoins its original node',{timeout:6000},async t=>{
  const f=fixture(t,{actualX:17.5});const result=await f.graph.returnToAnchor({via:[{x:16,y:2,z:0},{x:17,y:2,z:0}]});
  assert.equal(result.confirmed,true);assert.ok(f.facts.some(v=>v.observedSuffixRetry&&v.status==='success'&&v.conclusive));
  assert.equal(f.state().visits,2);assert.deepEqual(f.state().order,['0,2,0','16,2,0']);assert.deepEqual(f.moves,[{x:16,y:2,z:0},anchor]);
});
test('an observed resource approach up to96m retains one bounded retry without expanding graph range',{timeout:8000},async t=>{
 const f=fixture(t,{actualX:65.5});const result=await f.graph.returnToAnchor({via:[{x:16,y:2,z:0},{x:65,y:2,z:0}]});
 assert.equal(result.confirmed,true);assert.ok(f.facts.some(v=>v.observedSuffixRetry));assert.equal(f.state().visits,2);
});
test('a suffix outside96m cannot borrow a resource return retry',{timeout:4000},async t=>{
 const f=fixture(t,{actualX:112.5});await assert.rejects(f.graph.returnToAnchor({via:[{x:16,y:2,z:0},{x:112,y:2,z:0}]}),e=>e.code==='dry_graph_probe_inconclusive');
 assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,2);
});
test('a suffix without its original node receives no retry or movement',async t=>{
 const f=fixture(t,{actualX:17.5});await assert.rejects(f.graph.returnToAnchor({via:[{x:17,y:2,z:0}]}),e=>e.code==='dry_graph_rejoin_unconfirmed');
 assert.equal(f.calls.length,0);assert.equal(f.moves.length,0);
});

for(const opts of [{health:15},{food:13}])test(`insufficient survival state ${JSON.stringify(opts)} cannot extend a known return`,async t=>{
  const f=fixture(t,opts);await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_survival_limit');assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.moves.length,0);
});

test('health loss during an original retry slice denies goto and node credit',{timeout:4000},async t=>{
  const f=fixture(t,{retryFault:'health'});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_survival_limit');
  assert.equal(f.calls.filter(c=>c.timeoutMs===500).length,1);assert.equal(f.moves.length,0);assert.equal(f.state().current,'16,2,0');assert.equal(f.state().visits,2);
});

test('foreign owner during a native retry slice preserves replacement profile goal and controls',{timeout:4000},async t=>{
  const f=fixture(t,{retryFault:'foreign'});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_movement_preempted');
  assert.equal(f.moves.length,0);assert.equal(f.bot.pathfinder.movements,f.foreign.profile);assert.equal(f.bot.pathfinder.goal,f.foreign.goal);
  assert.deepEqual(f.writes.slice(f.foreign.writeCount),[]);assert.equal(f.state().current,'16,2,0');assert.equal(f.state().visits,2);
});

test('native terminal success after the500ms wall deadline stays UNKNOWN without a goto',{timeout:4000},async t=>{
  const f=fixture(t,{lateRetryMs:600});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_probe_inconclusive'&&e.observedProbe.observedReturnRetry&&e.observedProbe.conclusive===false);
  assert.equal(f.calls.filter(c=>c.timeoutMs===500).length,1);assert.equal(f.moves.length,0);assert.equal(f.state().current,'16,2,0');assert.equal(f.state().visits,2);
});

test('retry consumes the unchanged global finite native probe count',{timeout:4000},async t=>{
  const f=fixture(t,{maxEdges:3});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_probe_limit');
  assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.moves.length,0);assert.equal(f.state().visits,2);
});

test('complete probe evidence alone cannot credit a promise without actual native arrival',{timeout:4000},async t=>{
  const f=fixture(t,{noArrival:true});await assert.rejects(f.graph.returnToAnchor(),e=>e.code==='dry_graph_move_unconfirmed');
  assert.equal(f.calls.filter(c=>c.timeoutMs===500).length,1);assert.equal(f.moves.length,1);assert.equal(f.state().current,'16,2,0');assert.equal(f.state().visits,2);
});


test('interrupted suffix uses a fresh guarded physical connector before replay, without node credit',{timeout:8000},async t=>{
 const f=fixture(t,{actualX:20.5,coldProbe:false,facade:true}),before=clone(f.state());
 const result=await f.graph.returnToAnchor({anchor,via:[{x:16,y:2,z:0},{x:17,y:2,z:0}],rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[{x:17,y:2,z:0},{x:16,y:2,z:0},anchor]);
 assert.equal(f.calls.some(c=>c.timeoutMs===500),false);assert.equal(f.state().visits,before.visits);assert.deepEqual(f.state().order,before.order);
});
test('interrupted suffix reconnect needs explicit permission from trusted caller',async t=>{
 const f=fixture(t,{actualX:20.5,coldProbe:false});await assert.rejects(f.graph.returnToAnchor({via:[{x:16,y:2,z:0},{x:17,y:2,z:0}]}),e=>e.code==='dry_graph_rejoin_unconfirmed');assert.equal(f.moves.length,0);
});
test('interrupted suffix beyond32m cannot start a connector',async t=>{
 const f=fixture(t,{actualX:65.5,coldProbe:false});await assert.rejects(f.graph.returnToAnchor({via:[{x:16,y:2,z:0},{x:17,y:2,z:0}],rejoinInterruptedSuffix:true}),e=>e.code==='dry_graph_rejoin_unconfirmed');assert.equal(f.moves.length,0);
});
test('fresh connector cannot borrow the historical500ms retry after UNKNOWN',async t=>{
 const f=fixture(t,{actualX:20.5});await assert.rejects(f.graph.returnToAnchor({via:[{x:16,y:2,z:0},{x:17,y:2,z:0}],rejoinInterruptedSuffix:true}),e=>e.code==='dry_graph_probe_inconclusive');assert.equal(f.moves.length,0);assert.equal(f.calls.some(c=>c.timeoutMs===500),false);
});
test('fresh connector without physical arrival cannot replay the old suffix',async t=>{
 const f=fixture(t,{actualX:20.5,coldProbe:false,noArrival:true});await assert.rejects(f.graph.returnToAnchor({via:[{x:16,y:2,z:0},{x:17,y:2,z:0}],rejoinInterruptedSuffix:true}),e=>e.code==='dry_graph_move_unconfirmed');assert.deepEqual(f.moves,[{x:17,y:2,z:0}]);assert.equal(f.state().visits,2);
});

test('a current-node-only suffix supports fresh local return without borrowing a stale resource tour',{timeout:6000},async t=>{
 const f=fixture(t,{actualX:17.5,coldProbe:false,facade:true});
 const result=await f.graph.returnToAnchor({anchor,via:[{x:16,y:2,z:0}],rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[{x:16,y:2,z:0},anchor]);assert.equal(f.state().visits,2);
});

test('interrupted return reconnects to nearest observed waypoint rather than the distant outbound tail',{timeout:6000},async t=>{
 const f=fixture(t,{actualX:20.5,coldProbe:false,facade:true});
 const result=await f.graph.returnToAnchor({anchor,via:[{x:16,y:2,z:0},{x:17,y:2,z:0},{x:80,y:2,z:0}],rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[{x:17,y:2,z:0},{x:16,y:2,z:0},anchor]);assert.equal(f.state().visits,2);
});

test('near-camp reconnect freshly reaches fixed root without a distant stale outbound suffix',{timeout:6000},async t=>{
 const f=fixture(t,{actualX:1.5,coldProbe:false,facade:true});
 const result=await f.graph.returnToAnchor({anchor,rejoinInterruptedSuffix:true});assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[anchor]);assert.equal(f.state().current,'0,2,0');assert.equal(f.state().visits,2);
});

test('upward escape reconnect skips a nearer cave waypoint below its preserved floor',{timeout:6000},async t=>{
 const f=fixture(t,{actualX:20.5,coldProbe:false,facade:true});
 const result=await f.graph.returnToAnchor({anchor,via:[{x:16,y:2,z:0},{x:20,y:1,z:0}],rejoinInterruptedSuffix:true,rejoinMinimumY:2});
 assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[{x:16,y:2,z:0},anchor]);assert.equal(f.state().visits,2);
});

test('escape floor with no eligible recorded waypoint cannot start an unchecked connector',async t=>{
 const f=fixture(t,{actualX:20.5,coldProbe:false,facade:true});
 await assert.rejects(f.graph.returnToAnchor({anchor,via:[{x:16,y:2,z:0},{x:20,y:1,z:0}],rejoinInterruptedSuffix:true,rejoinMinimumY:3}),e=>e.code==='dry_graph_rejoin_unconfirmed');
 assert.equal(f.moves.length,0);
});

test('escaped cave node freshly rejoins its higher recorded ancestor without replaying the cave',{timeout:6000},async t=>{
 const f=fixture(t,{originY:1,actualX:20.5,coldProbe:false,facade:true});
 const result=await f.graph.returnToAnchor({anchor,via:[{x:16,y:1,z:0}],rejoinInterruptedSuffix:true,rejoinMinimumY:2});
 assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[anchor]);assert.equal(f.state().visits,2);
 assert.equal(f.calls.some(c=>c.timeoutMs===500),false);
});

test('resource approach rejoins its actual exploration node and stays there instead of returning camp',{timeout:6000},async t=>{
 const f=fixture(t,{actualX:20.5,coldProbe:false,facade:true});
 const result=await f.graph.returnToAnchor({anchor,via:[{x:16,y:2,z:0},{x:17,y:2,z:0}],rejoinInterruptedSuffix:true,returnToCurrentOnly:true});
 assert.equal(result.confirmed,true);assert.deepEqual(f.moves,[{x:17,y:2,z:0},{x:16,y:2,z:0}]);
 assert.equal(f.state().current,'16,2,0');assert.equal(f.state().visits,2);
});

test('recorded construction connector has a bounded endpoint-guarded probe and no movement credit',t=>{
 const f=fixture(t),goal=new goals.GoalBlock(0,2,0),options={assertActive:()=>{},isOwnerCurrent:()=>true,recordedEntry:{x:0,y:2,z:0}};
 const r=api.runRecordedConstructionConnectorProbe(f.bot,f.graph.movements,goal,options);
 assert.equal(r.result.status,'success');assert.ok(r.facts.slices<=50);assert.equal(f.moves.length,0);
 assert.throws(()=>api.runRecordedConstructionConnectorProbe(f.bot,f.graph.movements,goal,{...options,recordedEntry:{x:1,y:2,z:0}}),{code:'dry_graph_invalid_probe'});
 assert.throws(()=>api.runRecordedConstructionConnectorProbe(f.bot,f.graph.movements,goal,{...options,isOwnerCurrent:()=>false}),{code:'dry_graph_movement_preempted'});
});
