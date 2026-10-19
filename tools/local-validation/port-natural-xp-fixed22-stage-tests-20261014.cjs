'use strict';
const fs = require('node:fs');
const path = require('node:path');
const workspace = '.';
const file = path.join(workspace, 'personal-ai-deskpet-electron-work/electron/minecraft-runtime/test/house-natural-xp-stage.test.js');
if (fs.existsSync(file)) throw new Error('Stage regression namespace already occupied');
let source = fs.readFileSync(path.join(workspace, '.minecraft-local-test/evidence/estate-20261013/natural-xp-host-private-frozen-v2/deskpet-natural-xp-stage-policy-v2.test.cjs'), 'utf8');
source = source.replace('/* global require */', '/* global require, __dirname, setTimeout */')
  .replace("require('node:module').createRequire('./.minecraft-local-test/runtime-candidates/house-self17-coordinate-native-probe-20261014/package.json')", "require('node:module').createRequire(require.resolve('../package.json'))")
  .replace("require('./deskpet-natural-xp-stage-policy-v2.cjs')", "require('../vendor/server/minecraft/houseNaturalXPStagePolicy')")
  .replace("const createProbe=require('./deskpet-natural-xp-watchdog-probe-v2.cjs');", '')
  .replace("const no=()=>{},create=require('./deskpet-natural-xp-finish-probe-v2.cjs');", 'const no=()=>{},create=createPhaseProbe;')
  .replace('actual fixed17 planner', 'actual current planner');
const insertion = `
// These two probes compile the CURRENT exact engine functions, rather than
// keeping a second copied implementation. Native furniture actions below are
// explicit order mocks; installed protocol contracts live in the host suite.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const engineSource=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8');
function compileActual(name,deps){
 const declaration=new RegExp('^  (?:async )?function '+name+'\\\\(', 'm').exec(engineSource);
 assert.ok(declaration,'Actual engine declaration '+name);
 const next=/\\n  (?:async )?function /g;next.lastIndex=declaration.index+declaration[0].length;
 const end=next.exec(engineSource);assert.ok(end,'Actual engine next declaration '+name);
 const body=engineSource.slice(declaration.index,end.index).trim();
 return vm.compileFunction(body+'\\nreturn '+name+';',Object.keys(deps))(...Object.values(deps));
}
function createProbe({task,registry}){
 return compileActual('getStepWatchdogProfile',{currentTask:task,actionRegistry:registry,
 cloneSerializable:x=>JSON.parse(JSON.stringify(x)),getResourceLearningKey:x=>x,
 clamp:(n,a,b)=>Math.max(a,Math.min(b,n)),isStrictExecutorMode:()=>true,
 isSelfGatheredLibraryFinish:policy.isSelfGatheredLibraryFinish});
}
function createPhaseProbe(deps){
 return compileActual('executeBuildFurnishedHousePhase',{...deps,currentTask:deps.task,
 DEFAULT_CONTAINER_TIMEOUT_MS:1000,isSelfGatheredLibraryFinish:policy.isSelfGatheredLibraryFinish});
}
`;
source = source.replace('const copy=x=>JSON.parse(JSON.stringify(x));', 'const copy=x=>JSON.parse(JSON.stringify(x));\n' + insertion);
const added = `
function actualWatchdog(task,execute){
 const bot={_client:{}},token={throwIfRequested(){}},lease={},frames=new WeakMap();
 task.executionGeneration=5;task.cancellationToken=token;task.movementLease=lease;task.startedAt=Date.now();
 const context={task,token,movementLease:lease,runGeneration:5};
 const capture={task,bot,client:bot._client,token,lease,generation:5};
 const executeStep=compileActual('executeStepWithWatchdog',{
 getExecutionContext:()=>context,getStepWatchdogProfile:createProbe({task,registry}),currentTask:task,currentBot:bot,
 getCurrentMovementLease:()=>lease,naturalXPStepWatchdogFrames:frames,activeMovementSession:null,
 setTaskRegistryAction:()=>({actionId:'build_furnished_house_phase',contractType:'transaction'}),
 updateTaskCheckpoint:(owner,patch)=>{owner.stepCheckpoint={...owner.stepCheckpoint,...patch};},
 setTaskActionState:(owner,value)=>{owner.actionState=value;},prepareForSkillStep:async()=>{},
 checkTaskSignal:()=>{token.throwIfRequested();if(task.watchdogAbortMessage)throw Object.assign(new Error(task.watchdogAbortMessage),{code:task.watchdogAbortCode});},
 executeSkill:step=>execute({step,task,bot,token,lease,frames,capture}),isStrictExecutorMode:()=>true,
 markTaskRecovery:()=>{},softResetBotRuntime:async()=>{},addTaskLog:()=>{},brain:{clearRegistryAction(){}},
 });
 return {executeStep,frames,capture,context};
}
test('actual executeStepWithWatchdog captures its own real clock and discards any checkpoint deadline',async()=>{
 const task=taskFor(),step=task.plan.steps[task.currentStepIndex];
 task.stepCheckpoint={naturalXP:{startedAt:0,deadline:Infinity,hardTimeoutMs:Infinity}};
 const began=Date.now();let captured;
 const probe=actualWatchdog(task,async current=>{
  const frame=current.frames.get(task);captured=frame;
  assert.equal(frame.task,task);assert.equal(frame.step,step);assert.equal(frame.bot,current.bot);
  assert.equal(frame.token,current.token);assert.equal(frame.lease,current.lease);assert.equal(frame.generation,5);
  assert.ok(frame.startedAt>=began&&frame.startedAt<=Date.now());
  assert.equal(frame.deadline,frame.startedAt+policy.XP_STAGE_MS);
  const before=policy.readNaturalXPStageBudget(frame,current.capture);
  await new Promise(resolve=>setTimeout(resolve,20));
  const after=policy.readNaturalXPStageBudget(frame,current.capture);
  assert.ok(after.elapsedMs>=before.elapsedMs+10);assert.ok(after.remainingMs<before.remainingMs);
 });
 const original=JSON.stringify(task.completionPlan);await probe.executeStep(task,step);
 assert.ok(captured);assert.equal(probe.frames.has(task),false);
 assert.equal(JSON.stringify(task.completionPlan),original);
});
test('actual watchdog finally never deletes a newer task frame after foreign replacement',async()=>{
 const task=taskFor(),step=task.plan.steps[task.currentStepIndex],replacement={owner:'newer'};
 const probe=actualWatchdog(task,async current=>{current.frames.set(task,replacement);throw Object.assign(new Error('foreign'),{code:'movement_preempted'});});
 await assert.rejects(probe.executeStep(task,step),e=>e.code==='movement_preempted');
 assert.equal(probe.frames.get(task),replacement);
});
test('captured real watchdog rejects different current step and foreign physical identity',async()=>{
 const task=taskFor(),step=task.plan.steps[task.currentStepIndex];
 const probe=actualWatchdog(task,async current=>{
  const frame=current.frames.get(task);
  for(const field of ['client','token','lease','generation','bot','task']){
   const foreign={...current.capture,[field]:field==='generation'?6:{}};
   assert.throws(()=>policy.readNaturalXPStageBudget(frame,foreign),e=>e.code==='house_xp_stage_budget_pending');
  }
  const index=task.currentStepIndex;task.currentStepIndex=index+1;
  assert.throws(()=>policy.readNaturalXPStageBudget(frame,current.capture),e=>e.code==='house_xp_stage_budget_pending');
  task.currentStepIndex=index;
  assert.throws(()=>policy.readNaturalXPStageBudget(frame,current.capture,frame.deadline),e=>e.code==='step_timeout');
 });
 await probe.executeStep(task,step);assert.equal(probe.frames.has(task),false);
});
test('XP station floor and owned cactus seed become protected only in the original self source context',()=>{
 const {getNaturalXPProtectedPositions}=require('../vendor/server/minecraft/houseNaturalXPHost');
 const task={materialSupply:{naturalXPHost:{schema:1,kind:'natural_house_xp_host',stations:[
  {position:{x:5,y:64,z:0},support:{position:{x:5,y:63,z:0}},foundation:[{position:{x:5,y:62,z:0}}]}],
  renewable:{columns:[{position:{x:8,y:64,z:0},support:{position:{x:8,y:63,z:0}},foundation:[]}]}
 },surfaceGraphs:{}}};
 let context={task,houseSelfSupply:{},houseResourceExclusionBounds:[]};
 const excluded=compileActual('houseResourcePositionExcluded',{getExecutionContext:()=>context,currentTask:task,
 getNaturalXPProtectedPositions,getSurfaceGraphProtectedPositions:()=>[]});
 for(const p of [{x:5,y:64,z:0},{x:5,y:63,z:0},{x:5,y:62,z:0},{x:8,y:64,z:0},{x:8,y:63,z:0}])assert.equal(excluded(p),true);
 assert.equal(excluded({x:8,y:65,z:0}),false,'Actual cactus upper harvest remains permitted');
 context={task,houseResourceExclusionBounds:[]};assert.equal(excluded({x:5,y:63,z:0}),false);
});
`;
source += added;
if (/\/private\/tmp|\/Volumes\//.test(source)) throw new Error('Absolute private dependency remained in stage suite');
fs.writeFileSync(file, source, { flag: 'wx' });
console.log(JSON.stringify({ file, copiedPolicyContracts: true, currentEngineFunctionProbes: true, actualClockWatchdogTests: 3, javaStarted: false }));
