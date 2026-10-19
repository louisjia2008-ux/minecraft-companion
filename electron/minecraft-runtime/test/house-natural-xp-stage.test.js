/* global require, __dirname, setTimeout */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const native=require('node:module').createRequire(require.resolve('../package.json'));
const registry=native('./vendor/server/action/actionRegistry').createMinecraftActionRegistry();
const policy=require('../vendor/server/minecraft/houseNaturalXPStagePolicy');

const copy=x=>JSON.parse(JSON.stringify(x));

// These two probes compile the CURRENT exact engine functions, rather than
// keeping a second copied implementation. Native furniture actions below are
// explicit order mocks; installed protocol contracts live in the host suite.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const engineSource=fs.readFileSync(path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),'utf8');
function compileActual(name,deps){
 const declaration=new RegExp('^  (?:async )?function '+name+'\\(', 'm').exec(engineSource);
 assert.ok(declaration,'Actual engine declaration '+name);
 const next=/\n  (?:async )?function /g;next.lastIndex=declaration.index+declaration[0].length;
 const end=next.exec(engineSource);assert.ok(end,'Actual engine next declaration '+name);
 const body=engineSource.slice(declaration.index,end.index).trim();
 return vm.compileFunction(body+'\nreturn '+name+';',Object.keys(deps))(...Object.values(deps));
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

function taskFor(intent='build_furnished_house',args={profile:'enchanting_library',materialSource:'self_gathered'}){
 const plan=registry.buildHeuristicTaskPlan(intent,args);
 const index=intent==='build_estate'?0:plan.steps.findIndex(step=>step.args.phase==='finish');
 return {taskId:'original-XP',completionPlan:copy(plan),plan,currentStepIndex:index};
}
function captureFrame(task,elapsed=0,hardTimeoutMs=policy.XP_STAGE_MS){
 const capture={task,bot:{},client:{},token:{},lease:{},generation:3};
 const startedAt=1791970000000;
 return {capture,frame:{...capture,step:task.plan.steps[task.currentStepIndex],stepIndex:task.currentStepIndex,startedAt,deadline:startedAt+hardTimeoutMs,hardTimeoutMs},now:startedAt+elapsed};
}
test('actual current planner retains every one of the12 advanced phases while only canonical self finish gets4h',()=>{
 const task=taskFor(),saved=JSON.stringify(task.plan),probe=createProbe({task,registry});
 assert.equal(task.plan.steps.length,12);
 for(const step of task.plan.steps){
  const actual=probe(step);
  const expected=step.args.phase==='finish'?policy.XP_STAGE_MS:step.args.phase==='prepare_materials'?21600000:1800000;
  assert.equal(actual.hardTimeoutMs,expected,step.args.phase);assert.equal(actual.idleTimeoutMs,30000);assert.equal(actual.continuous,false);
 }
 assert.equal(JSON.stringify(task.plan),saved);assert.equal(JSON.stringify(task.completionPlan),saved);
});
test('ordinary cottage, external and unmarked original finish retain30min and cannot be elevated by current args',()=>{
 for(const args of [{profile:'cottage',materialSource:'self_gathered'},{profile:'enchanting_library',materialSource:'external_depots'},{profile:'enchanting_library',materialSource:'self_gathered'}]){
  const task=taskFor('build_furnished_house',args),step=task.plan.steps[task.currentStepIndex];
  if(args.profile==='enchanting_library'&&args.materialSource==='self_gathered')for(const old of task.completionPlan.steps)delete old.args.materialSource;
  step.args.materialSource='self_gathered';
  const before=JSON.stringify(task.completionPlan);
  assert.equal(createProbe({task,registry})(step).hardTimeoutMs,1800000);
  assert.equal(JSON.stringify(task.completionPlan),before);
 }
});
test('original explicit anchor/profile are immutable and duplicate unauthorized finish is not a budget grant',()=>{
 const task=taskFor('build_furnished_house',{profile:'enchanting_library',materialSource:'self_gathered',anchor:{x:2,y:64,z:3}});
 const step=task.plan.steps[task.currentStepIndex];assert.equal(policy.isSelfGatheredLibraryFinish(task,step),true);
 step.args.anchor.x=4;assert.equal(policy.isSelfGatheredLibraryFinish(task,step),false);
 step.args.anchor.x=2;task.completionPlan.steps.push(copy(task.completionPlan.steps[task.currentStepIndex]));
 assert.equal(policy.isSelfGatheredLibraryFinish(task,step),false);
});
test('six-hour estate budget deducts actual construction time before capping XP allowance',()=>{
 const task=taskFor('build_estate',{profile:'medieval_castle',materialSource:'self_gathered'});
 assert.equal(createProbe({task,registry})(task.plan.steps[0]).hardTimeoutMs,21600000);
 const c=captureFrame(task,18000000,21600000),out=policy.readNaturalXPStageBudget(c.frame,c.capture,c.now);
 assert.equal(out.elapsedMs,18000000);assert.equal(out.remainingMs,3600000);assert.equal(out.xpBudgetMs,3600000);
 const earlier=policy.readNaturalXPStageBudget(c.frame,c.capture,c.frame.startedAt+1000);
 assert.equal(earlier.xpBudgetMs,14400000);assert.equal(earlier.remainingMs,21599000);
});
test('expired original deadline stays step_timeout and no-heartbeat or retry can replenish time',()=>{
 const c=captureFrame(taskFor());
 for(const now of [c.frame.deadline,c.frame.deadline+1000])assert.throws(()=>policy.readNaturalXPStageBudget(c.frame,c.capture,now),e=>e.code==='step_timeout'&&e.remainingMs===0);
 const out=policy.readNaturalXPStageBudget(c.frame,c.capture,c.frame.deadline-1);assert.equal(out.xpBudgetMs,1);
});
test('foreign client/token/lease/generation/step cannot borrow another owner original deadline',()=>{
 const c=captureFrame(taskFor());
 for(const field of ['client','token','lease','generation','bot','task']){
  const foreign={...c.capture,[field]:field==='generation'?4:{}};
  assert.throws(()=>policy.readNaturalXPStageBudget(c.frame,foreign,c.now),e=>e.code==='house_xp_stage_budget_pending');
 }
 const moved={...c.frame,stepIndex:c.frame.stepIndex+1};
 assert.throws(()=>policy.readNaturalXPStageBudget(moved,c.capture,c.now),e=>e.code==='house_xp_stage_budget_pending');
});
test('missing frame, future start, infinite timeout and external original estate remain typed pending',()=>{
 const c=captureFrame(taskFor());
 for(const frame of [null,{...c.frame,hardTimeoutMs:Infinity},{...c.frame,startedAt:c.now+1}])assert.throws(()=>policy.readNaturalXPStageBudget(frame,c.capture,c.now),e=>e.code==='house_xp_stage_budget_pending');
 const e=captureFrame(taskFor('build_estate',{profile:'riverside_villa',materialSource:'external_depots',useNearbySupplyChests:true}),0,21600000);
 assert.throws(()=>policy.readNaturalXPStageBudget(e.frame,e.capture,e.now),x=>x.code==='house_xp_stage_budget_pending');
});
function finishProbe(task,options={}){
 const log=[],anchor={x:2,y:64,z:3};task.stepCheckpoint={furnishedHouse:{schema:2,sourceProfile:task.plan.steps[task.currentStepIndex].args.profile,anchor,phase:'furniture'}};
 const no=()=>{},create=createPhaseProbe;
 const args={task,ensureBotReady:()=>({}),checkTaskSignal:no,updateTaskCheckpoint:no,toPlainPosition:x=>x,setTaskProgress:no,recordTaskHeartbeat:no,
 getItemCountByName:no,prepareFurnishedHouseMaterials:no,placeFurnishedHouseBlock:no,breakFurnishedHouseBlock:no,furnishedHouseMoveTo:no,safeBotActivateBlock:no,sleep:no,runBotWritableAction:no,withTimeout:no,physicalOpenContainer:no,physicalOpenFurnace:no,chooseFurnishedHouseAnchor:no,
 createFurnishedHouseBlueprint:native('./vendor/server/minecraft/furnishedHouseBlueprints').createFurnishedHouseBlueprint,
 withFurnishedHouseMovements:action=>action(),
 createFurnishedHouseBuilder:()=>({run:async args=>{log.push(args.phase);task.stepCheckpoint.furnishedHouse.phase=args.phase;return {phase:args.phase};},verifyFurniture:async()=>{log.push('native_furniture_check');if(options.failFurniture)throw Object.assign(new Error('not usable'),{code:'house_furniture_unusable'});}}),
 finishNaturalHouseXP:async(owner,blueprint)=>{assert.equal(owner,task);assert.deepEqual(blueprint.anchor,anchor);log.push('bounded_XP');}
 };
 return {log,run:create(args)};
}
test('exact candidate engine finish calls furniture then XP without executing or crediting final verify',async()=>{
 const task=taskFor(),probe=finishProbe(task),step=task.plan.steps[task.currentStepIndex];
 const before=JSON.stringify(task.completionPlan);
 const result=await probe.run(step);
 assert.deepEqual(probe.log,['finish','native_furniture_check','bounded_XP']);assert.equal(result.phase,'finish');
 assert.equal(task.stepCheckpoint.furnishedHouse.phase,'finish');assert.equal(task.stepCheckpoint.furnishedHouse.verificationSummary,undefined);
 assert.equal(JSON.stringify(task.completionPlan),before);
 const verify=task.plan.steps.find(s=>s.args.phase==='verify');await probe.run(verify);
 assert.deepEqual(probe.log,['finish','native_furniture_check','bounded_XP','verify']);
});
test('candidate furniture failure cannot start XP or turn finish into complete',async()=>{
 const task=taskFor(),probe=finishProbe(task,{failFurniture:true});
 await assert.rejects(probe.run(task.plan.steps[task.currentStepIndex]),e=>e.code==='house_furniture_unusable');
 assert.deepEqual(probe.log,['finish','native_furniture_check']);assert.notEqual(task.stepCheckpoint.furnishedHouse.phase,'complete');
});
test('exact candidate ordinary and external finish keep their original execution without XP side effects',async()=>{
 for(const args of [{profile:'cottage',materialSource:'self_gathered'},{profile:'enchanting_library',materialSource:'external_depots'}]){
  const task=taskFor('build_furnished_house',args),probe=finishProbe(task);await probe.run(task.plan.steps[task.currentStepIndex]);assert.deepEqual(probe.log,['finish']);
 }
});

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

function estateProbe(options={}){
 const materialSource=options.external?'external_depots':'self_gathered';
 const task=taskFor('build_estate',{profile:'medieval_castle',materialSource,useNearbySupplyChests:options.external===true});
 const step=task.plan.steps[0],anchor={x:2,y:64,z:3};
 const blueprint=native('./vendor/server/minecraft/estateBlueprints').createEstateBlueprint(anchor,{profile:'medieval_castle'});
 const f=blueprint.furniture,log=[],no=()=>{};
 const checks={craftingTable:{confirmed:true},enchantingTable:{confirmed:true},bookshelves:{confirmed:true,effectiveCount:15},
  chests:(f.chests||[f.chest]).map(()=>({confirmed:true})),furnaces:(f.furnaces||[f.furnace]).map(()=>({confirmed:true})),beds:(f.beds||[f.bed]).map(()=>({confirmed:true}))};
 if(options.partial)checks.bookshelves.confirmed=false;
 const adapter={verifyFurniture:async actual=>{assert.equal(actual,blueprint);log.push('actual_furniture_checks');
  if(options.failFurniture)throw Object.assign(new Error('not usable'),{code:'estate_furniture_unusable'});return checks;},verifyRoutes:no};
 const run=compileActual('executeBuildEstate',{
  currentTask:task,ensureBotReady:()=>({}),setTaskProgress:no,recordTaskHeartbeat:no,createEstateBlueprint:no,findNearestBlocksByNames:no,
  toPlainPosition:x=>x,updateTaskCheckpoint:no,createEstateMaterialSupply:()=>({}),furnishedHouseMoveTo:no,checkTaskSignal:no,toVec3:x=>x,
  physicalOpenContainer:no,runBotWritableAction:no,createEstateNativeRuntime:()=>adapter,
  createEstateBuilder:deps=>({run:async()=>{log.push('original_estate_run');const actual=await deps.verifyFurniture(blueprint);log.push('original_remaining_verification');return actual;}}),
  getItemCountByName:no,houseConstructionMaterialBounds:no,createHouseMaterialRuntime:no,placeEstateNativeBlock:no,breakFurnishedHouseBlock:no,
  safeBotActivateBlock:no,sleep:no,chooseEstateAnchor:no,ensureFoodSupply:no,ensureNutrition:no,withFurnishedHouseMovements:action=>action(),
  finishNaturalHouseXP:async(owner,actual)=>{assert.equal(owner,task);assert.equal(actual,blueprint);log.push('bounded_original_XP');},
 });
 return {task,step,run,log,checks};
}
test('actual current estate callback starts XP only after all original furniture checks and before remaining verify',async()=>{
 const f=estateProbe(),original=JSON.stringify(f.task.completionPlan);
 assert.equal(await f.run(f.step),f.checks);
 assert.deepEqual(f.log,['original_estate_run','actual_furniture_checks','bounded_original_XP','original_remaining_verification']);
 assert.equal(JSON.stringify(f.task.completionPlan),original);
});
test('partial confirmed estate furniture refuses XP before the builder can credit verification',async()=>{
 const f=estateProbe({partial:true});
 await assert.rejects(f.run(f.step),e=>e.code==='estate_furniture_unconfirmed');
 assert.deepEqual(f.log,['original_estate_run','actual_furniture_checks']);
});
test('actual estate furniture rejection cannot start XP or credit a later verification phase',async()=>{
 const f=estateProbe({failFurniture:true});
 await assert.rejects(f.run(f.step),e=>e.code==='estate_furniture_unusable');
 assert.deepEqual(f.log,['original_estate_run','actual_furniture_checks']);
});
test('actual external estate callback keeps original furniture result without an XP side effect',async()=>{
 const f=estateProbe({external:true});assert.equal(await f.run(f.step),f.checks);
 assert.deepEqual(f.log,['original_estate_run','actual_furniture_checks','original_remaining_verification']);
});
