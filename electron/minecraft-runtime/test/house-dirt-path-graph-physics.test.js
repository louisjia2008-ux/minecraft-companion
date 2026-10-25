'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Vec3}=require('vec3');
const {createLoadedDryGraph}=require('../vendor/server/minecraft/houseSurfaceGraph'),{settleNativeGoto}=require('../vendor/server/minecraft/houseNativeGotoSettlement'),data=require('../test-support/fixtures/formal14-path-shape-jump.json');
const filename=path.join(__dirname,'house-surface-graph.test.js'),source=fs.readFileSync(filename,'utf8'),native=new Module(filename,module);native.filename=filename;native.paths=Module._nodeModulePaths(__dirname);native._compile(source.slice(0,source.indexOf('\nfor(const unfinished'))+'\nmodule.exports={fixture};\n',filename);
function fixture(t,{modeledEmptyPartial=false}={}){
 const anchor={x:303,y:67,z:-184},id='303,67,-184',target={x:320,y:75,z:-192},cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],current:id,resumeNode:id,visits:1,probes:0,blockedEdges:[],frontier:[{parent:id,target,plannedSteps:25}]};
 const f=native.exports.fixture(t,{initialPosition:new Vec3(303.5,67,-183.5),initialVelocity:new Vec3(0,-.0784000015258789,0),checkpoint:cp,worldAt:p=>{const b=data.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;return data.palette[data.states[`${p.x},${p.y},${p.z}`]||0];}});
 const settlements=[],nativeResolutions=[],budgets=[],nativeTrace=[];let calls=0,injected=0;
 // Preserve bounded evidence for real native failures. A wall-clock timeout,
 // an inconclusive probe and a NoPath while airborne are not interchangeable.
 const trace=(event,result)=>{
  const point=p=>p&&({x:p.x,y:p.y,z:p.z});
  nativeTrace.push({event,tick:f.points.length,at:Date.now(),status:result?.status,
   reason:typeof result==='string'?result:undefined,pathLength:result?.path?.length,
   first:point(result?.path?.[0]),last:point(result?.path?.at(-1)),
   position:point(f.bot.entity.position),onGround:f.bot.entity.onGround});
  if(nativeTrace.length>32)nativeTrace.shift();
 };
 const onPath=result=>trace('path_update',result),onReset=reason=>trace('path_reset',reason);
 f.bot.on('path_update',onPath);f.bot.on('path_reset',onReset);
 t.after(()=>{f.bot.removeListener('path_update',onPath);f.bot.removeListener('path_reset',onReset);});
 if(modeledEmptyPartial){
  const original=f.bot.pathfinder.goto;
  f.bot.pathfinder.goto=function(goal,...args){
   calls++;const promise=Reflect.apply(original,this,[goal,...args]);
   promise.then(()=>nativeResolutions.push({actual:{...f.bot.entity.position},goalReached:goal.isEnd(f.bot.entity.position.floored())}),()=>{});
   // EXPLICIT MODEL: installed goto receives an initial empty partial while
   // its actual native goal and Physics keep running. This is not CI telemetry.
   injected++;f.bot.emit('path_update',{status:'partial',path:[]});return promise;
  };
 }
 // Match TaskAgent's existing native settlement adapter, keeping the exact
 // graph-provided absolute deadline and original native motor invocation.
 f.deps.actualnativegoto=(goal,profile,budget)=>{
  assert.equal(f.bot.pathfinder.movements,profile);
  assert.ok(Number.isFinite(budget.deadline)&&budget.deadline>Date.now()&&budget.deadline<=Date.now()+12000);
  budgets.push(budget.deadline);
  return settleNativeGoto({...f.deps,isExpectedStop:budget.isExpectedNativeStop,allowPendingTimeout:budget.isExpectedNativeTimeout,
   record:facts=>settlements.push({...facts,deadline:budget.deadline})},{goal,deadline:budget.deadline});
 };
 return {...f,anchor,id,target,settlements,nativeResolutions,budgets,nativeTrace,calls:()=>calls,injected:()=>injected};
}
function graphFor(f){return createLoadedDryGraph(f.deps,{anchor:f.anchor,radius:384,nativeReachableHints:true,terrainRecovery:true,legTimeoutMs:12000});}
function assertOriginalArrival(f,graph,result){
 assert.equal(result.moved,true);assert.deepEqual(result.actual,f.target);assert.equal(graph.state().visits,2);
 assert.equal(f.bot.entity.onGround,true);assert.ok(f.points.length>30);assert.equal(f.waterTicks.length,0);
}
function observedNext(f,graph){return graph.next().catch(error=>{f.lastGraphError=error;throw error;});}
async function withFailureDiagnostics(t,f,graph,run){
 try{return await run();}catch(error){
  const cause=f.lastGraphError||error,e=f.bot.entity;
  t.diagnostic(JSON.stringify({testFailure:{name:error.name,code:error.code,message:error.message},
   originalGraphError:{name:cause.name,code:cause.code,message:cause.message,observedMovement:cause.observedMovement,
    observedLanding:cause.observedLanding,observedProbe:cause.observedProbe,observedDryLeg:cause.observedDryLeg},
   blockedEdges:graph.state().blockedEdges,current:graph.state().current,visits:graph.state().visits,
   body:{position:{...e.position},velocity:{...e.velocity},onGround:e.onGround,isInWater:e.isInWater,isInLava:e.isInLava,
    yaw:e.yaw,pitch:e.pitch,controls:{...f.bot.controlState},jumpTicks:f.bot.jumpTicks,jumpQueued:f.bot.jumpQueued,health:f.bot.health,food:f.bot.food},
   nativeResolutions:f.nativeResolutions,settlements:f.settlements,budgets:f.budgets,nativeTrace:f.nativeTrace}));
  throw error;
 }
}
test('formal14 the original native graph physically completes the recorded ascending dirt-path leg without disabling the support guard',{timeout:20000},async t=>{
 const f=fixture(t),graph=graphFor(f);
 await withFailureDiagnostics(t,f,graph,async()=>{const result=await observedNext(f,graph);assertOriginalArrival(f,graph,result);});
});
test('formal14 modeled initial empty partial uses production settlement until the exact ascending target actually arrives',{timeout:20000},async t=>{
 const f=fixture(t,{modeledEmptyPartial:true}),graph=graphFor(f);
 await withFailureDiagnostics(t,f,graph,async()=>{
  const result=await observedNext(f,graph);assertOriginalArrival(f,graph,result);
  assert.equal(f.calls(),1);assert.equal(f.injected(),1);assert.equal(f.nativeResolutions.length,1);
  assert.equal(f.nativeResolutions[0].goalReached,false);
  assert.equal(f.settlements.length,1);assert.equal(f.settlements[0].initialEmptyPartial,true);
  assert.equal(f.settlements[0].actualArrivalConfirmed,true);assert.equal(f.settlements[0].deadline,f.budgets[0]);
 });
});
test('formal14 modeled initial empty partial cannot credit a target after cancellation during actual native movement',{timeout:20000},async t=>{
 const f=fixture(t,{modeledEmptyPartial:true}),initial=f.bot.entity.position.clone();let cancelled=false;
 const cancelDuringMotion=()=>{if(!cancelled&&f.injected()&&f.bot.entity.position.distanceTo(initial)>.1
  &&!f.bot.entity.position.floored().equals(new Vec3(f.target.x,f.target.y,f.target.z))){cancelled=true;f.cancel();}};
 f.bot.on('physicsTick',cancelDuringMotion);t.after(()=>f.bot.removeListener('physicsTick',cancelDuringMotion));
 const graph=graphFor(f);
 await withFailureDiagnostics(t,f,graph,async()=>{
  await assert.rejects(observedNext(f,graph),{code:'cancelled'});
  assert.equal(cancelled,true);assert.ok(f.points.length>0);assert.equal(f.calls(),1);assert.equal(f.injected(),1);
  assert.equal(f.nativeResolutions.length,1);assert.equal(f.nativeResolutions[0].goalReached,false);
  assert.equal(f.settlements.length,0);assert.equal(graph.state().visits,1);assert.equal(graph.state().current,f.id);
  assert.equal(graph.state().nodes['320,75,-192'],undefined);assert.notDeepEqual(f.bot.entity.position.floored(),new Vec3(320,75,-192));
  assert.ok(Object.values(f.bot.controlState).every(value=>value===false));assert.equal(f.waterTicks.length,0);
 });
});
