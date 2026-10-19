/* global process, __dirname, setTimeout, clearTimeout */
'use strict';
// Same-world real reconnect idempotence verifier. Never starts/stops a server or uses
// game commands. Requires the original completed development checkpoint.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRequire}=require('node:module'),{once}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const base=path.resolve(__dirname,'..'),runtimeRoot=path.resolve(base,'../personal-ai-deskpet-electron-work/electron/minecraft-runtime');
const argv=process.argv.slice(2),i=argv.indexOf('--run-name'),runName=argv[i+1];assert.match(runName||'',/^[A-Za-z0-9_-]+$/);
assert.deepEqual(argv,['--run-name',runName]);
const world=path.join(base,'worlds/cottage-development-from57'),original=JSON.parse(fs.readFileSync(path.join(world,'development-checkpoint.json'))).task;
assert.equal(original.status,'completed','Do not connect over a running construction actor');
const profile='cottage',enchanting=false,isEstate=false;
const out=path.join(world,'native-post-use',runName);assert.equal(fs.existsSync(out),false);fs.mkdirSync(out,{recursive:true});
process.env.MC_AGENT_LEARNING_PATH=path.join(out,'learning.json');process.env.MC_AGENT_DIAGNOSTICS_DIR=path.join(out,'diagnostics');process.env.MC_AGENT_DISCONNECT_TRACE_PATH=path.join(out,'disconnect.jsonl');
const req=createRequire(path.join(runtimeRoot,'package.json')),mineflayer=req('mineflayer'),{Vec3}=req('vec3'),{goals}=req('mineflayer-pathfinder');
const Item=req('prismarine-item')('1.21.8'),{CancellationToken}=req(path.join(runtimeRoot,'vendor/server/minecraft/agentControl'));
const {withHouseNativeSourceGuard}=req(path.join(runtimeRoot,'vendor/server/minecraft/houseNativeSourceGuard'));
const {createRuntimeTickLoop}=req(path.join(runtimeRoot,'vendor/server/minecraft/runtimeTickLoop'));
const {withMinecraftProtocolCompatibility,installMinecraftBedWakeCompatibility}=req(path.join(runtimeRoot,'protocolCompatibility'));
const {acknowledgePlayerLoaded}=req(path.join(runtimeRoot,'runtime'));
const nativeOwner=new AsyncLocalStorage(),events=[],stages=[],maximumMs=180000,naturalNightMs=1250000;
let bot,agent,runtimeTicks,abortError=null,deaths=0,disconnected=false,signalReject,failureReject;
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v)),position=p=>p&&({x:p.x,y:p.y,z:p.z}),key=p=>`${p.x},${p.y},${p.z}`;
const typed=(code,message)=>Object.assign(Error(message),{code}),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const counts=items=>items.reduce((a,i)=>(a[i.name]=(a[i.name]||0)+i.count,a),{});
const inventory=()=>bot.inventory.slots.flatMap((item,slot)=>item&&slot>=5?[{name:item.name,count:item.count,slot,durabilityUsed:item.durabilityUsed||0}]:[]);
function record(type,facts={}){const e={at:Date.now(),type,...facts};events.push(e);fs.appendFileSync(path.join(out,'events.jsonl'),JSON.stringify(e)+'\n');if(type==='native_verification_stage')console.log(JSON.stringify(e));}
const signalPromise=new Promise((_,r)=>signalReject=r);signalPromise.catch(()=>{});
const failurePromise=new Promise((_,r)=>failureReject=r);failurePromise.catch(()=>{});
function requestAbort(e){abortError||=e;signalReject(abortError);}
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>requestAbort(typed('VERIFICATION_CANCELLED',sig)));
function fingerprint(){const result={};function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile())result[path.relative(runtimeRoot,p)]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}walk(path.join(runtimeRoot,'vendor'));for(const name of ['runtime.js','protocolCompatibility.js']){const p=path.join(runtimeRoot,name);if(fs.existsSync(p))result[name]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}return result;}

// Derived from v7 native checks; same-world repair and bounded survival handoff wait added.
function ownedTask(id) {
  const value = { taskId: id, status: 'running', source: 'deskpet', intent: 'natural_public_building_verification', executionGeneration: 1,
    logs: [], startedAt: Date.now(), currentStepIndex: 0, currentStep: 'natural_public_building_verification', cancellationToken: new CancellationToken(), plan: { steps: [] } };
  value.movementLease = agent.__testClaimMovementLease('task', id); agent.__testSetReconnectTask(value); return value;
}
async function runFurnitureUse(original,blueprint){
 const task=ownedTask(`${runName}-reconnect`),captured=bot;
 task.materialSupply=clone(original.materialSupply);task.stepCheckpoint=clone(original.stepCheckpoint);
 const active=()=>{task.cancellationToken.throwIfRequested();assert.equal(bot,captured);assert.equal(agent.__testGetReconnectTask(),task);assert.equal(agent.__testGetActiveMovementLease(),task.movementLease);if(abortError||deaths||disconnected)throw abortError||typed('RECONNECT_INTERRUPTED','Native reconnect interrupted');};
 const guarded=operation=>withHouseNativeSourceGuard(bot,{assertActive:active,isOwnerContext:()=>nativeOwner.getStore()===task},operation);
 return nativeOwner.run(task,()=>agent.__testWithHouseResourceWork(()=>agent.__testWithFurnishedHouseMovements(async()=>{
   active();const before=counts(inventory()),startPosition=position(bot.entity.position),updates=[];
   const structure=new Set(blueprint.blocks.filter(s=>s.item!=='oak_door').map(s=>key(s.position)));
   const changed=(old,next)=>{if(old&&next&&old.stateId!==next.stateId&&structure.has(key(next.position)))updates.push({position:position(next.position),before:old.stateId,after:next.stateId});};
   bot.on('blockUpdate',changed);
   try{await guarded(()=>agent.__testExecuteBuildFurnishedHousePhase({args:{phase:'verify',profile,anchor:blueprint.anchor}}));}finally{bot.off('blockUpdate',changed);}
   active();const after=counts(inventory());assert.deepEqual(after,before,'Reconnect verification must not consume or duplicate carried material');assert.deepEqual(updates,[],'Completed structure must receive no repeated replacement');
   const summary=task.stepCheckpoint.furnishedHouse.verificationSummary;assert.equal(summary.missingBlocks,0);assert.deepEqual(summary.stateMismatches,[]);assert.equal(summary.exteriorGrade.confirmed,true);
   const stage={stage:'native_reconnect_idempotent_house_verification',status:'PASS',required:true,evidence:{confirmed:true,before,after,startPosition,finalPosition:position(bot.entity.position),structuralBlockUpdates:updates,verification:summary,source:'Real new server connection; unchanged actual inventory and blueprint block states through normal verify'}};stages.push(stage);record('native_verification_stage',stage);
   return {confirmed:true,checks:{[stage.stage]:stage},materialSupply:clone(task.materialSupply),finalInventory:inventory(),finalPosition:position(bot.entity.position)};
 })));
}


async function main(){
 const before=fingerprint(),settings=JSON.parse(fs.readFileSync(path.join(base,'installation.json')));
 const props=fs.readFileSync(path.join(world,'server.properties'),'utf8'),port=Number(props.match(/^server-port=(\d+)$/m)?.[1]);assert.equal(port,57630);
 agent=req(path.join(runtimeRoot,'vendor/server/minecraftTaskAgent')).createMinecraftTaskAgent({appPaths:{appDataDir:path.join(out,'deskpet-data')},readConfig:()=>({mcExecutorMode:'strict-executor',mcAgentAutoReconnect:false}),parseJsonObjectFromText:JSON.parse,broadcast:event=>record('agent_event',{event}),broadcastMinecraftError:message=>record('agent_error',{message}),allowAutonomousMaintenance:()=>false,requestPlannerCompletion:async()=>{throw typed('PROVIDER_FORBIDDEN','No model calls authorized');}});
 bot=mineflayer.createBot(withMinecraftProtocolCompatibility({host:'127.0.0.1',port,username:'DeskPetSelfBuild',auth:'offline',respawn:false,version:settings.minecraft.version,hideErrors:false}));
 bot.on('death',()=>{deaths++;requestAbort(typed('VERIFICATION_DEATH','Actual native death'));});
 bot.on('end',()=>{disconnected=true;requestAbort(typed('VERIFICATION_DISCONNECTED','Actual native disconnect'));});
 bot.on('error',e=>failureReject(e));
 bot._client.on('window_items',p=>record('server_window_inventory',{windowId:p.windowId,stateId:p.stateId,items:p.items}));
 bot._client.on('set_slot',p=>record('server_slot_ack',{windowId:p.windowId,stateId:p.stateId,slot:p.slot,item:p.item}));
 bot._client.on('entity_status',p=>{if(p.entityId===bot.entity?.id)record('self_entity_status',{status:p.entityStatus});});
 bot.on('sleep',()=>record('native_sleep',{position:position(bot.entity.position),time:bot.time.timeOfDay}));bot.on('wake',()=>record('native_wake',{position:position(bot.entity.position),time:bot.time.timeOfDay}));
 await Promise.race([once(bot,'spawn'),signalPromise,new Promise((_,r)=>setTimeout(()=>r(typed('SPAWN_TIMEOUT','Spawn timeout')),60000))]);
 installMinecraftBedWakeCompatibility(bot);await acknowledgePlayerLoaded(bot);await bot.waitForChunksToLoad();assert.equal(bot.game.gameMode,'survival');
 agent.attachBot(bot);agent.initializeBotRuntime();
 runtimeTicks=createRuntimeTickLoop({isReady:()=>Boolean(bot.entity&&!disconnected&&!deaths),tick:()=>agent.tickIdleBehavior(),onFault:e=>record('tick_fault',{code:e.code,message:e.message})});
 const blueprint=req(path.join(runtimeRoot,'vendor/server/minecraft/furnishedHouseBlueprints')).createFurnishedHouseBlueprint(original.stepCheckpoint.furnishedHouse.anchor,{profile});
 record('same_world_native_use_started',{originalStatus:original.status,sourceFingerprint:before,keepInventory:true,limits:'Development world only; historical deaths retained; not clean empty-inventory E2E'});
 const use=await runFurnitureUse(original,blueprint);assert.deepEqual(fingerprint(),before,'Runtime changed during verification');
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({schema:1,domain:'ORIGINAL_DEVELOPMENT_WORLD_POST_USE_ONLY',confirmed:use.confirmed,deaths,stages,use,sourceFingerprint:before},null,2)+'\n',{flag:'wx'});
 if(!use.confirmed)process.exitCode=1;
}
main().catch(e=>{fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({code:e.code,message:e.message,stack:e.stack,deaths,stages},null,2)+'\n',{flag:'wx'});console.error(e.stack);process.exitCode=1;}).finally(async()=>{await runtimeTicks?.stop();try{agent?.__testSetReconnectTask(null);agent?.detachBot('manual_disconnect');agent?.dispose();bot?.quit('Same-world post-use finished; server retained');}catch(e){console.error(e.message);}});
