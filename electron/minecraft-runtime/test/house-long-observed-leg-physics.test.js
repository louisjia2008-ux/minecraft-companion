'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished')).replace("bot.emit('physicsTick');},10)","bot.emit('physicsTick');},50)")+'\nmodule.exports={fixture};\n',filename);
const {settleNativeGoto}=require('../vendor/server/minecraft/houseNativeGotoSettlement');
const graphFile=path.resolve(__dirname,'../vendor/server/minecraft/houseSurfaceGraph.js'),fixed=require(graphFile),old=new Module(graphFile,module);old.filename=graphFile;old.paths=Module._nodeModulePaths(path.dirname(graphFile));old._compile(fs.readFileSync(graphFile,'utf8').replace('adjacent?visitStartedAt+legTimeoutMs:Infinity','adjacent?visitStartedAt+Math.min(legTimeoutMs,15000):Infinity'),graphFile);
for(const modeledEmptyPartial of [false,true])for(const baseline of [true,false])test(`an observed adjacent coordinate reached by a long native detour keeps its configured finite leg budget: baseline=${baseline}, modeledEmptyPartial=${modeledEmptyPartial}`,{timeout:26000},async t=>{
 const anchor={x:0,y:1,z:16},start={x:0,y:1,z:0},cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{'0,1,16':{position:anchor,parent:null,expanded:true},'0,1,0':{position:start,parent:'0,1,16',expanded:true}},order:['0,1,16','0,1,0'],current:'0,1,0',resumeNode:'0,1,0',visits:2,probes:0,frontier:[],blockedEdges:[]};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(.5,1,.5),checkpoint:cp,worldAt:p=>p.y<1&&p.x>=0&&p.x<=28&&p.z>=0&&p.z<=16&&(p.z===0||p.z===16||p.x===28)?'stone':'air'});
 const settlements=[],nativeResolutions=[],budgets=[];let injections=0;
 if(modeledEmptyPartial){
  const original=f.bot.pathfinder.goto;
  f.bot.pathfinder.goto=function(goal,...args){
   const pending=Reflect.apply(original,this,[goal,...args]);
   pending.then(()=>nativeResolutions.push({actual:{...f.bot.entity.position},goalReached:goal.isEnd(f.bot.entity.position.floored())}),()=>{});
   // EXPLICIT MODEL, not a replay of CI: installed goto resolves on this
   // empty partial while the original goal, follower and Physics keep running.
   injections++;f.bot.emit('path_update',{status:'partial',path:[]});return pending;
  };
 }
 // Use the same existing adapter as TaskAgent, with the graph's unchanged
 // absolute deadline. A raw goto can resolve before its follower arrives.
 f.deps.actualnativegoto=(goal,profile,budget)=>{
  assert.equal(f.bot.pathfinder.movements,profile);
  assert.ok(Number.isFinite(budget.deadline)&&budget.deadline>Date.now()&&budget.deadline<=Date.now()+22000);
  budgets.push(budget.deadline);
  return settleNativeGoto({...f.deps,isExpectedStop:budget.isExpectedNativeStop,allowPendingTimeout:budget.isExpectedNativeTimeout,
   record:facts=>settlements.push({...facts,deadline:budget.deadline})},{goal,deadline:budget.deadline});
 };
 const graph=(baseline?old.exports:fixed).createLoadedDryGraph(f.deps,{anchor,radius:384,nativeReachableHints:true,legTimeoutMs:22000}),started=Date.now();
 let originalError;const running=graph.travelToObservedNode({exactPosition:anchor}).catch(error=>{originalError=error;throw error;});
 try{
 if(baseline){await assert.rejects(running,{code:'dry_graph_leg_timeout'});assert.ok(Date.now()-started>=14000);assert.notDeepEqual(f.bot.entity.position.floored(),new Vec3(0,1,16));}
 else{const r=await running;assert.equal(r.confirmed,true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,1,16));assert.equal(f.bot.entity.onGround,true);assert.ok(Date.now()-started>15000);assert.equal(graph.state().visits,2);}
  assert.equal(graph.state().visits,2);assert.equal(f.attempts.length,1);assert.equal(f.waterTicks.length,0);
  if(modeledEmptyPartial){
   assert.equal(injections,1);assert.equal(nativeResolutions.length,1);assert.equal(nativeResolutions[0].goalReached,false);
   if(!baseline){assert.equal(settlements.length,1);assert.equal(settlements[0].initialEmptyPartial,true);
    assert.equal(settlements[0].actualArrivalConfirmed,true);assert.equal(settlements[0].deadline,budgets[0]);}
  }
 }catch(error){
  const e=f.bot.entity,cause=originalError||error;
  t.diagnostic(JSON.stringify({failure:{name:error.name,code:error.code,message:error.message},
   graphError:{name:cause.name,code:cause.code,message:cause.message,observedProbe:cause.observedProbe,
    observedMovement:cause.observedMovement,observedLanding:cause.observedLanding,observedDryLeg:cause.observedDryLeg},
   elapsed:Date.now()-started,baseline,modeledEmptyPartial,budgets,settlements,nativeResolutions,injections,
   body:{position:{...e.position},velocity:{...e.velocity},onGround:e.onGround,controls:{...f.bot.controlState}},
   state:graph.state(),attempts:f.attempts,physicsTicks:f.points.length,lastPhysics:f.points.slice(-8)}));
  throw error;
 }
});
