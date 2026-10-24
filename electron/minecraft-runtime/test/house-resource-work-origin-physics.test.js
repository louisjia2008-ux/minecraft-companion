'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph'),{settleNativeGoto}=require('../vendor/server/minecraft/houseNativeGotoSettlement');
for(const mode of ['actual','paused','foreign','wrong_cursor','pendingWater','pendingDryTrail','node_budget','critical_before','critical_after_ready','hungry_after_ready'])test(`resource work observes only the actual native settled actor without old-edge credit: ${mode}`,{timeout:5000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],current:id,resumeNode:id,visits:1,probes:3,frontier:[],blockedEdges:[]};
 if(mode==='pendingWater'||mode==='pendingDryTrail')cp[mode]={originNode:id,mustReconcile:true};
 if(mode==='node_budget'){for(let n=1;n<4;n++){const k=`-${n},1,0`;cp.nodes[k]={position:{x:-n,y:1,z:0},parent:id,expanded:true};cp.order.push(k);}cp.visits=4;}
 const f=native.exports.fixture(t,{checkpoint:cp}),graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:mode==='node_budget'?4:96,adaptiveLocalFrontier:true,preferActualLocalFrontier:true});
 await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(4,1,0),deadline:Date.now()+2000});const attempts=f.attempts.length;
 if(mode==='paused')f.cancel();if(mode==='foreign')f.deps.isMovementOwner=()=>false;
 if(mode==='critical_before')f.bot.health=4;
 let readyCalls=0;
 if(mode==='critical_after_ready'||mode==='hungry_after_ready')f.deps.ready=async()=>{
  // Change the server observation before the awaited readiness promise
  // returns, without requiring another physicsTick to deliver a guard.
  if(++readyCalls===2){if(mode==='critical_after_ready')f.bot.health=4;else f.bot.food=5;}
 };
 const run=graph.observeResourceWorkOrigin({observedCurrent:mode==='wrong_cursor'?'stale-node':id});
 if(['critical_before','critical_after_ready','hungry_after_ready'].includes(mode)){
  await assert.rejects(run,{code:'dry_graph_survival_limit'});
  assert.deepEqual(graph.state(),cp);assert.equal(f.attempts.length,attempts);return;
 }
 if(mode==='paused'||mode==='foreign'||mode==='node_budget'){await assert.rejects(run);assert.equal(graph.state().visits,mode==='node_budget'?4:1);return;}
 const result=await run;
 if(['wrong_cursor','pendingWater','pendingDryTrail'].includes(mode)){assert.equal(result.confirmed,false);assert.equal(graph.state().visits,1);return;}
 assert.equal(result.confirmed,true);assert.equal(result.current,'4,1,0');assert.equal(result.oldEdgeTraversalCredit,false);assert.equal(result.materialCredit,false);
 assert.equal(graph.state().visits,2);assert.equal(graph.state().probes,3);assert.deepEqual(graph.state().nodes[id],cp.nodes[id]);assert.deepEqual(graph.state().anchor,anchor);assert.equal(f.attempts.length,attempts);
 const next=await graph.next();assert.equal(next.moved,true);assert.equal(graph.state().visits,3);assert.equal(f.bot.entity.onGround,true);
});

for(const proof of [true,false])test(`native defense at the idle expansion boundary requires its exact receipt: ${proof}`,{timeout:6000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:false}},order:[id],current:id,resumeNode:id,visits:1,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{checkpoint:cp});let calls=0,receipt;
 f.deps.ready=async()=>{if(++calls===4){await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(4,1,0),deadline:Date.now()+2000});
  receipt={kind:'actual_owned_graph_boundary_defense',from:{...anchor},actual:{x:f.bot.entity.position.x,y:f.bot.entity.position.y,z:f.bot.entity.position.z},observedAt:Date.now(),originalDeadline:Date.now()+4000,oldTargetReached:false};}};
 f.deps.takeBoundaryDefenseRelocation=()=>{const r=proof?receipt:null;receipt=null;return r;};
 const graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:96,adaptiveLocalFrontier:true,preferActualLocalFrontier:true,deferInconclusiveExplorationReplay:true});
 if(!proof){await assert.rejects(graph.next(),{code:'dry_graph_wrong_expansion_origin'});assert.equal(graph.state().visits,1);return;}
 const result=await graph.next();assert.equal(result.moved,true);
 const state=graph.state();assert.equal(state.nodes['4,1,0'].survivalRelocation.oldEdgeTraversalCredit,false);
 assert.equal(state.nodes[id].expanded,false);assert.deepEqual(state.anchor,anchor);assert.ok(state.visits>=3);
});

test('native surface expansion delivers queued event-loop observations between independent path probes',{timeout:6000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:false}},order:[id],current:id,resumeNode:id,visits:1,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{checkpoint:cp});let probes=0,delivered=false;const observed=[];
 const nativeProbe=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);
 f.bot.pathfinder.getPathFromTo=function*(...args){if(++probes===1)setTimeout(()=>{delivered=true;},0);else observed.push(delivered);return yield* nativeProbe(...args);};
 const graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:96,adaptiveLocalFrontier:true,preferActualLocalFrontier:true,deferInconclusiveExplorationReplay:true});
 const result=await graph.next();assert.equal(result.moved,true);assert.ok(probes>=2);assert.ok(observed.every(Boolean),'queued native receive/timer turn must run between A* probes');assert.equal(f.bot.entity.onGround,true);
});

test('resource target reads recheck the exact owner after an asynchronous native expansion returns',{timeout:6000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:false}},order:[id],current:id,resumeNode:id,visits:1,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{checkpoint:cp});let pending=false,reads=0;
 const probe=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);
 f.bot.pathfinder.getPathFromTo=function*(...args){pending=true;return yield* probe(...args);};
 f.deps.ready=async()=>{pending=false;};
 f.deps.getObservedResourceTarget=()=>{reads++;assert.equal(pending,false,'readiness must be checked after expansion, before resource reads');return null;};
 const graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:96,adaptiveLocalFrontier:true,preferActualLocalFrontier:true,deferInconclusiveExplorationReplay:true});
 assert.equal((await graph.next()).moved,true);assert.ok(reads>0);assert.equal(f.bot.entity.onGround,true);
});

for(const proof of [true,false])test(`multi-threat defense reobserves its bounded actual native landing without old-edge credit: ${proof}`,{timeout:6000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:false}},order:[id],current:id,resumeNode:id,visits:1,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{checkpoint:cp});let calls=0,receipt;
 f.deps.ready=async()=>{if(++calls===4){await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(20,1,0),deadline:Date.now()+2000});
  receipt={kind:'actual_owned_graph_boundary_defense',from:{...anchor},actual:{x:f.bot.entity.position.x,y:f.bot.entity.position.y,z:f.bot.entity.position.z},observedAt:Date.now(),originalDeadline:Date.now()+4000,maximumDisplacement:32,maximumVerticalDisplacement:8.05,oldTargetReached:false};}};
 f.deps.takeBoundaryDefenseRelocation=()=>{const r=proof?receipt:null;receipt=null;return r;};
 const graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:96,adaptiveLocalFrontier:true,preferActualLocalFrontier:true,deferInconclusiveExplorationReplay:true});
 if(!proof){await assert.rejects(graph.next(),{code:'dry_graph_wrong_expansion_origin'});assert.equal(graph.state().visits,1);return;}
 const result=await graph.next();assert.equal(result.moved,true);
 const state=graph.state();assert.equal(state.nodes['20,1,0'].survivalRelocation.oldEdgeTraversalCredit,false);
 assert.equal(state.nodes[id].expanded,false);assert.deepEqual(state.anchor,anchor);assert.ok(state.visits>=3);
});


// This is the graph's internal captured provisioning capability, not the
// host's public fieldFoodExploration flag. Native motion remains unchanged.
test('explicit survival provisioning accepts an owned native boundary landing at4HP and revokes the threshold afterwards',{timeout:6000},async t=>{
 const anchor={x:0,y:1,z:0},id='0,1,0',cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:false}},order:[id],current:id,resumeNode:id,visits:1,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{checkpoint:cp});let calls=0,receipt;
 f.deps.ready=async()=>{if(++calls===4){
  await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(4,1,0),deadline:Date.now()+2000});
  f.bot.health=4;
  receipt={kind:'actual_owned_graph_boundary_defense',from:{...anchor},actual:{x:f.bot.entity.position.x,y:f.bot.entity.position.y,z:f.bot.entity.position.z},observedAt:Date.now(),originalDeadline:Date.now()+4000,oldTargetReached:false};
 }};
 f.deps.takeBoundaryDefenseRelocation=()=>{const r=receipt;receipt=null;return r;};
 const graph=createLoadedDryGraph(f.deps,{anchor,maxNodes:96,adaptiveLocalFrontier:true,preferActualLocalFrontier:true,deferInconclusiveExplorationReplay:true});
 const result=await graph.next({survivalProvisioning:true});assert.equal(result.moved,true);assert.equal(f.bot.health,4);
 const state=graph.state();assert.equal(state.nodes['4,1,0'].survivalRelocation.oldEdgeTraversalCredit,false);
 assert.equal(f.bot.entity.onGround,true);const attempts=f.attempts.length;
 await assert.rejects(graph.next(),{code:'dry_graph_survival_limit'});
 assert.deepEqual(graph.state(),state);assert.equal(f.attempts.length,attempts);
});
