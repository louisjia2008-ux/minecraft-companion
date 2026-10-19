'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{goals}=require('mineflayer-pathfinder');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
const {settleNativeGoto}=require('../vendor/server/minecraft/houseNativeGotoSettlement'),{prepareStartupExplorationOrigin}=require('../vendor/server/minecraft/houseStartupExplorationOrigin');
function fixture(t){const f=native.exports.fixture(t);let state={target:3,confirmed:false,searchAnchor:{x:0,y:1,z:0},graph:{anchor:{x:0,y:1,z:0},order:['0,1,0'],nodes:{'0,1,0':{position:{x:0,y:1,z:0},parent:null}},visits:1,probes:3}};const writes=[],records=[];
 const deps={...f.deps,getState:()=>state,saveState:s=>{state=s;writes.push(s);},isMotorIdle:()=>true,record:r=>records.push(r)};return {...f,deps,writes,records,state:()=>state};}
test('after real native harvesting approach, startup archives the intact old fixed graph and starts from its actual dry stand',{timeout:4000},async t=>{
 const f=fixture(t),original=JSON.stringify(f.state().graph);await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(4,1,0),deadline:Date.now()+2000});const calls=f.attempts.length;
 const r=await prepareStartupExplorationOrigin(f.deps,{deadline:Date.now()+2000});assert.equal(r.changed,true);assert.deepEqual(f.state().searchAnchor,{x:4,y:1,z:0});assert.equal(f.state().graph,null);assert.equal(JSON.stringify(f.state().graphSegments[0].graph),original);assert.equal(f.records[0].oldTraversalCredit,false);assert.equal(f.records[0].requiredReturnToSpawn,false);assert.equal(f.records[0].materialCredit,false);assert.equal(f.attempts.length,calls);assert.equal(f.bot.inventory.items().length,0);
});
for(const mode of ['paused','pendingWater','pendingTrail','segmentCap','foreignClient','deadline','activeMotor'])test(`startup origin cannot discard history or claim a new root after ${mode}`,{timeout:4000},async t=>{
 const f=fixture(t);await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(2,1,0),deadline:Date.now()+1500});
 if(mode==='paused')f.cancel();if(mode==='pendingWater')f.state().graph.pendingWater={};if(mode==='pendingTrail')f.state().graph.pendingDryTrail={};if(mode==='segmentCap')f.state().graphSegments=Array(8).fill({});
 const deps={...f.deps,isMotorIdle:()=>mode!=='activeMotor',getState:()=>{if(mode==='foreignClient')f.bot._client={};return f.state();}};
 await assert.rejects(prepareStartupExplorationOrigin(deps,{deadline:Date.now()+(mode==='deadline'?-1:mode==='activeMotor'?30:2000)}));assert.equal(f.writes.length,0);assert.equal(f.records.length,0);
});

test('an uncreated first graph uses the settled actual origin rather than a pre-settle coordinate hint',{timeout:4000},async t=>{const f=fixture(t);f.state().graph=null;await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(3,1,0),deadline:Date.now()+2000});await prepareStartupExplorationOrigin(f.deps,{deadline:Date.now()+2000});assert.deepEqual(f.state().searchAnchor,{x:3,y:1,z:0});assert.equal(f.state().graphSegments,undefined);assert.equal(f.records.length,0);});

for(const count of [8,32])test(`explicit field origin segment budget preserves all ${count} earlier segments and remains finite`,{timeout:4000},async t=>{
 const f=fixture(t);await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(2,1,0),deadline:Date.now()+1500});
 const retained=Array.from({length:count},(_,id)=>({id,graph:{order:[`${id},1,0`],probes:3}}));f.state().graphSegments=retained;
 const run=prepareStartupExplorationOrigin(f.deps,{deadline:Date.now()+1500,maximumSegments:32});
 if(count===32){await assert.rejects(run,{code:'house_startup_origin_segment_limit'});assert.equal(f.writes.length,0);}
 else{await run;assert.deepEqual(f.state().graphSegments.slice(0,count),retained);assert.equal(f.state().graphSegments.length,count+1);assert.equal(f.records[0].maximumSegments,32);}
});

for(const mode of ['actual','pendingWater','pendingDryTrail','paused'])test(`a real return to a previously visited field node updates only actual current: ${mode}`,{timeout:4000},async t=>{
 const f=fixture(t),g=f.state().graph;g.current='0,1,0';g.resumeNode='0,1,0';g.nodes['4,1,0']={position:{x:4,y:1,z:0},parent:'0,1,0'};g.order.push('4,1,0');g.visits=2;
 const before=JSON.parse(JSON.stringify(g));await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(4,1,0),deadline:Date.now()+2000});
 if(mode==='pendingWater'||mode==='pendingDryTrail')g[mode]={};if(mode==='paused')f.cancel();
 const run=prepareStartupExplorationOrigin(f.deps,{deadline:Date.now()+1500});
 if(mode!=='actual'){await assert.rejects(run);assert.equal(f.writes.length,0);return;}
 await run;assert.equal(f.state().graph.current,'4,1,0');assert.equal(f.state().graph.resumeNode,'4,1,0');
 assert.deepEqual(f.state().graph.nodes,before.nodes);assert.deepEqual(f.state().graph.order,before.order);assert.equal(f.state().graph.visits,2);assert.equal(f.state().graph.probes,3);
 assert.equal(f.state().graphSegments,undefined);assert.equal(f.records[0].reobservedVisitedNode,true);assert.equal(f.records[0].oldTraversalCredit,false);assert.equal(f.records[0].newNodeOrVisitCredit,false);
});

test('native ice coast reaches actual zero velocity before startup origin registration under its original deadline',{timeout:6000},async t=>{
 const file=path.join(__dirname,'house-creeper-escape.test.js'),src=fs.readFileSync(file,'utf8'),mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(__dirname);mod._compile(src.slice(0,src.indexOf('\ntest('))+'\nmodule.exports={fixture};\n',file);
 const {Vec3}=require('vec3'),f=mod.exports.fixture(t,{initialVelocity:new Vec3(.177,0,0),physicsMs:50});
 for(let x=-16;x<=16;x++)for(let z=-16;z<=16;z++)f.cells.set(new Vec3(x,0,z).toString(),'ice');
 let state={searchAnchor:{x:0,y:1,z:0},graph:null};const start=Date.now(),deadline=start+4000;
 const result=await prepareStartupExplorationOrigin({...f.deps,getState:()=>state,saveState:s=>{state=s;},isMotorIdle:()=>true},{deadline});
 assert.ok(Date.now()-start>1200);assert.ok(Date.now()<deadline);assert.equal(f.bot.entity.velocity.x,0);assert.equal(f.bot.entity.velocity.z,0);
 assert.equal(state.searchAnchor.x,Math.floor(f.bot.entity.position.x));assert.equal(result.changed,false);assert.equal(f.attempts.length,0);assert.equal(f.bot.entity.onGround,true);
});

test('startup defensive settling never extends its original deadline or writes an unconfirmed root',{timeout:2000},async t=>{
 const f=fixture(t),deadline=Date.now()+70;
 await assert.rejects(prepareStartupExplorationOrigin({...f.deps,isMotorIdle:()=>false,ready:async()=>{await new Promise(r=>setTimeout(r,20));return true;}},{deadline}),e=>e.code==='house_startup_origin_unconfirmed'&&e.originFacts.originalDeadline===deadline);
 assert.equal(f.writes.length,0);assert.equal(f.attempts.length,0);
});

for(const mode of ['archive','pause','deadline','motor','cap'])test(`world125 cleanup retains unresolved transport branch at actual dry origin: ${mode}`,{timeout:4000},async t=>{
 const f=fixture(t);await settleNativeGoto(f.deps,{goal:new goals.GoalBlock(4,1,0),deadline:Date.now()+2000});
 f.state().graph.pendingWater={reverse:true,originNode:'0,1,0',bankArrival:{nativeTraversalConfirmed:true,position:{x:0,y:1,z:0}}};const original=JSON.stringify(f.state().graph);
 if(mode==='pause')f.cancel();if(mode==='cap')f.state().graphSegments=Array(32).fill({});
 const run=prepareStartupExplorationOrigin({...f.deps,isMotorIdle:()=>mode!=='motor'},{deadline:Date.now()+(mode==='deadline'?-1:mode==='motor'?30:1500),maximumSegments:32,unresolvedTransportReason:'house_surface_dry_graph_transport_origin'});
 if(mode!=='archive'){await assert.rejects(run);assert.equal(f.writes.length,0);return;}
 await run;assert.equal(f.state().graph,null);assert.deepEqual(f.state().searchAnchor,{x:4,y:1,z:0});assert.equal(JSON.stringify(f.state().graphSegments[0].graph),original);
 assert.equal(f.state().graphSegments[0].unresolvedTransport.arrivalConfirmed,false);assert.equal(f.records[0].unresolvedTransportPreserved,true);
});
