/* global process */
'use strict';
// Offline original Physics/pathfinder, production engine and immutable voxel
// fixtures. No Java, injected moveTo, goal-position/velocity writes or world API
// patching. Explicit unknown geometry simulates an unloaded safety observation.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture,Vec3,Movements,goals}=require('./shallow-water-native-fixture.cjs');
const {createMinecraftTaskAgent}=require('../vendor/server/minecraftTaskAgent');
const {CancellationToken}=require('../vendor/server/minecraft/agentControl');
function engineFixture(t,options={}){
 let unknownHead=false;
 const native=fixture(t,12,{unknown:(p,l)=>unknownHead&&p.y===2&&l.u>=0&&l.u<12});
 const bot=native.bot,dir=fs.mkdtempSync(path.join(os.tmpdir(),'deskpet-water-engine-'));
 const paths={MC_AGENT_LEARNING_PATH:path.join(dir,'learning.json'),MC_AGENT_DIAGNOSTICS_DIR:path.join(dir,'diagnostics'),MC_AGENT_DISCONNECT_TRACE_PATH:path.join(dir,'disconnect.jsonl')};
 const previous=Object.fromEntries(Object.keys(paths).map(k=>[k,process.env[k]]));Object.assign(process.env,paths);
 bot.findBlock=()=>null;bot.findBlocks=()=>[];
 const writes=[],messages=[];
 for(const name of['setGoal','setMovements']){const original=bot.pathfinder[name].bind(bot.pathfinder);bot.pathfinder[name]=(...args)=>{writes.push({name,args});return original(...args);};}
 const clear=bot.clearControlStates;bot.clearControlStates=()=>{writes.push({name:'clearControlStates'});return clear();};
 const agent=createMinecraftTaskAgent({appPaths:{appDataDir:dir},readConfig:()=>({mcExecutorMode:'strict-executor',mcAgentAutoReconnect:false}),parseJsonObjectFromText:JSON.parse,broadcast:message=>messages.push(message),broadcastMinecraftError:()=>{},allowAutonomousMaintenance:()=>false,requestPlannerCompletion:async()=>{throw new Error('No planner is used by explicit native ownership tests');}});
 agent.attachBot(bot);agent.initializeBotRuntime();
 const makeTask=(id='water-engine')=>{const task={taskId:id,status:'running',source:'deskpet',intent:'build_furnished_house',logs:[],startedAt:Date.now(),currentStepIndex:0,currentStep:'build_furnished_house_phase',executionGeneration:0,cancellationToken:new CancellationToken(),plan:{steps:[{skill:'build_furnished_house_phase',args:{phase:'prepare_materials',profile:'cottage'}}]},materialSupply:{surfaceGraphs:{}}};task.movementLease=agent.__testClaimMovementLease('task',id);agent.__testSetReconnectTask(task);return task;};
 const task=makeTask(options.id),originalProfile=bot.pathfinder.movements;
 t.after(()=>{unknownHead=false;agent.__testSetReconnectTask(null);agent.detachBot('manual_disconnect');agent.dispose();for(const k of Object.keys(paths)){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}fs.rmSync(dir,{recursive:true,force:true});});
 const takeover=(kind='manual')=>{
  if(kind==='escort')agent.__testActivatePassiveEscort({playerName:'ForeignPlayer'});
  else agent.__testClaimMovementLease('manual','foreign-same-generation');
  const lease=agent.__testGetActiveMovementLease(),profile=new Movements(bot);profile.canDig=false;profile.scafoldingBlocks=[];profile.allowParkour=false;profile.allowSprinting=false;profile.getMoveDiagonal=()=>{};
  bot.pathfinder.setGoal(null);bot.pathfinder.setMovements(profile);bot.clearControlStates();bot.setControlState('jump',true);
  return {lease,profile,traceIndex:writes.length};
 };
 return {...native,agent,task,makeTask,writes,messages,originalProfile,takeover,setUnknownHead:value=>{unknownHead=value;}};
}
module.exports={engineFixture,Vec3,Movements,goals};
