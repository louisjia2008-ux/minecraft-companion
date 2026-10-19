'use strict';
// Host integration contract: real authority and registry code;
// modeled native receipts are not server or whole-house acceptance evidence.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,script,copy}=require('../test-support/house-whole-learning-authority-fixture.cjs');
const {createMinecraftActionRegistry:factory}=require('../vendor/server/action/actionRegistry');
const tools=require('../vendor/server/minecraft/learningState');
const taskFor=run=>({taskId:run.reference.taskId||run.context.taskId,executionGeneration:run.context.generation,
 intent:run.target.plan.intent,userCommand:'original whole build',plan:copy(run.target.plan),completionPlan:copy(run.target.plan),status:'completed'});
function bound(state,run){
 const task=taskFor({...run,context:state.contexts.get(run.reference)}),ctx=state.contexts.get(run.reference);
 const gate=()=>state.system.query.wholeLearningGate({binding:run.target.binding,plan:task.completionPlan,run:ctx});
 const registry=factory({wholeLearningGate:gate,legacyBucketGate:(bucket,plan)=>state.system.query.legacyBucketGate(bucket,{binding:run.target.binding,plan})});
 const key=registry.getTaskScriptKey(task.plan),bucket=registry.createTaskScriptBucket(key,task.intent);
 return {task,registry,key,bucket,ctx};
}
async function published(t,index=0){const state=fixture(t),run=await state.publish(script(index));return {state,run,...bound(state,run)};}

test('default issuer missing retains completed status and component only for all four self profiles',()=>{
 const registry=factory();for(let n=0;n<4;n++){
  const target=script(n),task={taskId:'without-issuer',executionGeneration:1,plan:target.plan,completionPlan:target.plan,intent:target.plan.intent,status:'completed'};
  const key=registry.getTaskScriptKey(task.plan),bucket=registry.createTaskScriptBucket(key,task.intent);
  registry.rememberTaskScriptOutcome(bucket,task,'completed');assert.equal(task.status,'completed');assert.equal(bucket.success,0);assert.equal(bucket.componentSuccess,1);assert.equal(bucket.reusable,false);assert.equal(bucket.lastSuccessfulPlan,null);
  const stats={};registry.recordTaskLearningOutcome(stats,task,'completed');assert.equal(stats.intents[task.intent].success,0);assert.equal(stats.intents[task.intent].componentSuccess,1);
  assert.equal(registry.compileTaskScriptPlan('',task.plan,{[key]:bucket},{}).scriptMeta.source,'generated');
 }
});

test('real authority issued sealed receipts promote current task and are reusable after normalization/restart',async t=>{
 for(let n=0;n<4;n++){
  const f=await published(t,n);f.registry.rememberTaskScriptOutcome(f.bucket,f.task,'completed');
  assert.equal(f.bucket.success,1);assert.equal(f.bucket.reusable,true);assert.equal(f.bucket.wholeLearningStatus,'whole_success');assert.equal(f.bucket.wholeAcceptance.runId,f.ctx.runId);
  const restored=tools.createLearningStateTools(f.registry).normalizeLearningTaskScripts({[f.key]:f.bucket});
  f.state.restart();assert.ok(f.registry.getTaskScriptPlanTemplate(restored[f.key],f.task.plan));
  assert.equal(f.registry.findBestLearnedTaskScript(f.task.plan,'',{[f.key]:restored[f.key]}).key,f.key);
  assert.equal(f.registry.compileTaskScriptPlan('',f.task.plan,restored,{}).scriptMeta.source,'learned_success');
  assert.ok(f.registry.getTaskScriptPlanningHints('',f.task.plan,restored));
 }
});

test('structural completed proof, copied JSON eligible flag and forged callback without reference do not promote',()=>{
 const target=script(),task={taskId:'a',executionGeneration:1,plan:target.plan,completionPlan:target.plan,intent:target.plan.intent,status:'completed',wholeAcceptance:{eligible:true}};
 for(const options of [{},{wholeLearningGate:()=>({eligible:true})},{wholeLearningGate:()=>({eligible:true,reference:{schema:1,runId:'forged'}})}]){
  const registry=factory(options),bucket=registry.createTaskScriptBucket(registry.getTaskScriptKey(task.plan),task.intent);
  registry.rememberTaskScriptOutcome(bucket,task,'completed');assert.equal(bucket.success,0);assert.equal(bucket.componentSuccess,1);assert.equal(bucket.lastSuccessfulPlan,null);
 }
});

test('restored host authority re-enables a still sealed whole script after a temporary issuer outage',async t=>{
 const f=await published(t);f.registry.rememberTaskScriptOutcome(f.bucket,f.task,'completed');
 const missing=factory(),archived=missing.normalizeLearningTaskScripts({[f.key]:f.bucket});
 assert.equal(archived[f.key].reusable,false);assert.equal(archived[f.key].wholeLearningStatus,'legacy_unverified');
 assert.equal(missing.getTaskScriptPlanTemplate(archived[f.key],f.task.plan),null);
 f.state.restart();
 assert.ok(f.registry.getTaskScriptPlanTemplate(archived[f.key],f.task.plan),'Current native proof revalidation can recover derived outage state');
 const restored=f.registry.normalizeLearningTaskScripts(archived);
 assert.equal(restored[f.key].reusable,true);assert.equal(restored[f.key].success,1);
 assert.equal(restored[f.key].wholeLearningStatus,'whole_success');
 assert.equal(f.registry.compileTaskScriptPlan('',f.task.plan,restored,{}).scriptMeta.source,'learned_success');
 const forged=copy(archived[f.key]);forged.wholeAcceptance.sourceDigest='b'.repeat(64);
 assert.equal(f.registry.getTaskScriptPlanTemplate(forged,f.task.plan),null);
 assert.equal(f.registry.normalizeLearningTaskScripts({[f.key]:forged})[f.key].reusable,false);
});

test('old counters with no receipt are archived legacy_unverified and every lookup refuses them',()=>{
 const registry=factory(),target=script(),key=registry.getTaskScriptKey(target.plan);
 const old={key,intent:target.plan.intent,success:22,reusable:true,lastSuccessfulPlan:target.plan,templatePlan:target.plan};
 const normalized=registry.normalizeLearningTaskScripts({[key]:old})[key];
 assert.equal(normalized.success,22);assert.deepEqual(normalized.lastSuccessfulPlan,target.plan);assert.equal(normalized.wholeLearningStatus,'legacy_unverified');assert.equal(normalized.reusable,false);
 for(const bucket of [old,normalized]){
  assert.equal(registry.getTaskScriptPlanTemplate(bucket,target.plan),null);assert.equal(registry.findBestLearnedTaskScript(target.plan,'',{[key]:bucket}),null);assert.equal(registry.getTaskScriptPlanningHints('',target.plan,{[key]:bucket}),null);
  assert.equal(registry.compileTaskScriptPlan('',target.plan,{[key]:bucket},{}).scriptMeta.source,'generated');
 }
});

test('forced and AI-style matcher cannot bypass reload receipt revalidation',async t=>{
 const f=await published(t);f.registry.rememberTaskScriptOutcome(f.bucket,f.task,'completed');
 for(const mutate of [b=>{b.wholeAcceptance.generation++;},b=>{b.wholeAcceptance.sourceDigest='b'.repeat(64);},b=>{b.wholeAcceptance.eligible=true;},b=>{b.lastSuccessfulPlan.steps[0].args.profile='enchanting_library';}]){
  const forged=copy(f.bucket);mutate(forged);const restored=f.registry.normalizeLearningTaskScripts({[f.key]:forged});
  assert.equal(restored[f.key].reusable,false);assert.equal(f.registry.findBestLearnedTaskScript(f.task.plan,'',restored),null);
  const compiled=f.registry.compileTaskScriptPlan('',f.task.plan,restored,{}, {findBestLearnedTaskScript:()=>({key:f.key,bucket:forged,score:999999})});
  assert.equal(compiled.scriptMeta.source,'generated');assert.deepEqual(compiled.steps,f.task.plan.steps);
 }
});

test('deleting native receipt bytes revokes even intact stored JSON and does not rewrite archive',async t=>{
 const f=await published(t);f.registry.rememberTaskScriptOutcome(f.bucket,f.task,'completed');
 const before=copy(f.bucket),file=fs.readdirSync(f.state.directory).find(n=>n.endsWith('saved_server.json'));fs.unlinkSync(path.join(f.state.directory,file));
 assert.equal(f.registry.findBestLearnedTaskScript(f.task.plan,'',{[f.key]:f.bucket}),null);
 assert.deepEqual(f.bucket,before);const cp=f.registry.normalizeLearningTaskScripts({[f.key]:f.bucket});assert.equal(cp[f.key].reusable,false);assert.equal(cp[f.key].success,1);
});

test('pending next run cannot increment whole success or overwrite older accepted script/reference',async t=>{
 const f=await published(t);f.registry.rememberTaskScriptOutcome(f.bucket,f.task,'completed');const accepted=copy(f.bucket);
 const pending=f.state.begin(f.run.target),next=bound(f.state,pending);
 next.registry.rememberTaskScriptOutcome(f.bucket,next.task,'completed');assert.equal(f.bucket.success,1);assert.equal(f.bucket.componentSuccess,1);
 assert.deepEqual(f.bucket.lastSuccessfulPlan,accepted.lastSuccessfulPlan);assert.deepEqual(f.bucket.wholeAcceptance,accepted.wholeAcceptance);
 assert.equal(f.bucket.reusable,true);assert.equal(f.bucket.lastWholeOutcome,'pending');
});

test('changed source/task generation/revision cannot count earlier proof as current completed task',async t=>{
 const f=await published(t);
 for(const patch of [{taskId:'replacement'},{executionGeneration:f.task.executionGeneration+1},{completionPlan:script(0,1).plan}]){
  const task={...f.task,...patch},bucket=f.registry.createTaskScriptBucket(f.key,task.intent);f.registry.rememberTaskScriptOutcome(bucket,task,'completed');assert.equal(bucket.success,0);assert.equal(bucket.lastSuccessfulPlan,null);
 }
 f.state.setSource('b'.repeat(64));const bucket=f.registry.createTaskScriptBucket(f.key,f.task.intent);f.registry.rememberTaskScriptOutcome(bucket,f.task,'completed');assert.equal(bucket.success,0);
});

test('factory host gates take precedence over per-call spoofed callbacks',()=>{
 const target=script(),registry=factory({wholeLearningGate:()=>({eligible:false}),legacyBucketGate:()=>({eligible:false})}),key=registry.getTaskScriptKey(target.plan);
 const bucket=registry.createTaskScriptBucket(key,target.plan.intent),task={taskId:'a',executionGeneration:1,plan:target.plan,completionPlan:target.plan,intent:target.plan.intent};
 registry.rememberTaskScriptOutcome(bucket,task,'completed','',{wholeLearningGate:()=>({eligible:true,reference:{eligible:true}})});
 assert.equal(bucket.success,0);assert.equal(bucket.componentSuccess,1);
});

test('external and legacy diagnostic records keep old contracts but never match self source',()=>{
 const registry=factory();for(const materialSource of ['external_depots','legacy_inventory']){
  const target=registry.buildHeuristicTaskPlan('build_estate',{profile:'medieval_castle',...(materialSource==='external_depots'?{materialSource,useNearbySupplyChests:true}:{materialSource:undefined,useNearbySupplyChests:false})});
  if(materialSource==='legacy_inventory')delete target.steps[0].args.materialSource;
  const key=registry.getTaskScriptKey(target),bucket=registry.createTaskScriptBucket(key,target.intent),task={taskId:'diagnostic',intent:target.intent,plan:target,completionPlan:target};registry.rememberTaskScriptOutcome(bucket,task,'completed');
  assert.equal(bucket.success,1);assert.equal(registry.compileTaskScriptPlan('',target,{[key]:bucket},{}).scriptMeta.source,'learned_success');
  const self=script(2).plan;assert.equal(registry.findBestLearnedTaskScript(self,'',{[key]:bucket}),null);
 }
});

test('ordinary successful mining and independently completed stage remain reusable without whole gate',()=>{
 const registry=factory(),plan={mode:'task',intent:'mine_resource',steps:[{skill:'mine_resource',args:{block:'coal_ore',count:1,maxDistance:24}}]},task={taskId:'coal',intent:plan.intent,plan,currentStepIndex:0},key=registry.getTaskScriptKey(plan),bucket=registry.createTaskScriptBucket(key,plan.intent);
 registry.rememberTaskScriptOutcome(bucket,task,'completed');assert.equal(bucket.success,1);assert.equal(registry.compileTaskScriptPlan('',plan,{[key]:bucket},{}).scriptMeta.source,'learned_success');
 const house=script().plan,step=house.steps[0],stage=registry.createStageScriptBucket(house.intent,step);
 registry.rememberStageScriptOutcome(stage,{taskId:'component',intent:house.intent,plan:house,currentStepIndex:0},step,'completed');assert.equal(stage.success,1);assert.ok(stage.lastSuccessfulStep);
});

test('return-only recovery retains original self contract for aggregate learning and cannot retrieve unproven template',()=>{
 const registry=factory(),original=script().plan,recovery={...original,steps:[{skill:'go_to_position',args:{x:0,y:2,z:0}}]},task={taskId:'return-only',intent:original.intent,plan:recovery,completionPlan:original,status:'completed'},stats={};
 registry.recordTaskLearningOutcome(stats,task,'completed');assert.equal(stats.intents[original.intent].success,0);assert.equal(stats.intents[original.intent].componentSuccess,1);
 const bucket={success:5,reusable:true,lastSuccessfulPlan:original};assert.equal(registry.getTaskScriptPlanTemplate(bucket,recovery),null);
});

test('throwing, asynchronous and UNKNOWN host gates fail closed without converting completed task to failure',()=>{
 for(const wholeLearningGate of [()=>{throw new Error('issuer unavailable');},async()=>({eligible:true}),()=>({eligible:'UNKNOWN'})]){
  const registry=factory({wholeLearningGate}),target=script(),key=registry.getTaskScriptKey(target.plan),bucket=registry.createTaskScriptBucket(key,target.plan.intent),task={taskId:'pending',executionGeneration:1,intent:target.plan.intent,plan:target.plan,completionPlan:target.plan,status:'completed'};
  registry.rememberTaskScriptOutcome(bucket,task,'completed');assert.equal(bucket.success,0);assert.equal(bucket.failed,0);assert.equal(task.status,'completed');assert.equal(bucket.componentSuccess,1);
 }
});

test('normalizing new candidate buckets with no template preserves unrelated state and does not throw',()=>{
 const registry=factory(),target=script(),key=registry.getTaskScriptKey(target.plan),fresh=registry.createTaskScriptBucket(key,target.plan.intent);
 const loaded=registry.normalizeLearningTaskScripts({[key]:fresh});assert.equal(loaded[key].success,0);assert.equal(loaded[key].lastSuccessfulPlan,null);assert.equal(registry.findBestLearnedTaskScript(target.plan,'',loaded),null);
});
