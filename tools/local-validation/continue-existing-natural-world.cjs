// Same-world continuation of a retained failed natural acceptance; no copy/reset.
'use strict';
// Trusted, private development continuation. Never emits clean E2E acceptance.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{createRequire}=require('node:module');
const base=path.resolve(__dirname,'..'),argv=process.argv.slice(2);
function arg(k,d){const i=argv.indexOf(k);return i<0?d:argv[i+1];}
const runtime=path.resolve(arg('--runtime-root',path.join(base,'../personal-ai-deskpet-electron-work/electron/minecraft-runtime')));
const origin=path.resolve(arg('--origin',path.join(base,'worlds/natural-public-cottage-self-57')));
const dev=path.resolve(arg('--development-world',path.join(base,'worlds/cottage-development-from57')));
assert.equal(path.dirname(dev),path.join(base,'worlds'));if(dev===origin){assert.ok(argv.includes('--attach-existing'),'Same-world continuation requires existing server');assert.ok(fs.existsSync(path.join(dev,'development-checkpoint.json')));assert.equal(JSON.parse(fs.readFileSync(path.join(dev,'result.json'))).stopped.normal,true);}else assert.notEqual(dev,origin);
const session=arg('--session');assert.match(session||'',/^[A-Za-z0-9_-]+$/);
const out=path.join(dev,'development-sessions',session),settings=JSON.parse(fs.readFileSync(path.join(base,'installation.json')));
const req=createRequire(path.join(runtime,'package.json')),mineflayer=req('mineflayer');
const {Movements,goals}=req('mineflayer-pathfinder');
const {createMinecraftTaskAgent}=req(path.join(runtime,'vendor/server/minecraftTaskAgent'));
const {createRuntimeTickLoop}=req(path.join(runtime,'vendor/server/minecraft/runtimeTickLoop'));
const {CancellationToken}=req(path.join(runtime,'vendor/server/minecraft/agentControl'));
const {withMinecraftProtocolCompatibility,installMinecraftBedWakeCompatibility}=req(path.join(runtime,'protocolCompatibility'));
const {acknowledgePlayerLoaded}=req(path.join(runtime,'runtime'));
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2),hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function tree(root){const result={};function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile())result[path.relative(root,f)]=hash(f);}}walk(root);return result;}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(p,ms,label){let t;try{return await Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(t);}}
let server,serverClosed,bot,agent,ticks,poll,stopRequested=false,death=false,ended=false,task,closed,error;
let savedConstruction=null,recoveryCombat=false,initialSpawnComplete=false,deathCount=0,actorRestartRequested=false,controlTimer,actorNumber=0;
let wake;const wakePromise=new Promise(r=>wake=r);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopRequested=true;wake();});
function record(type,data={}){fs.appendFileSync(path.join(out,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),type,...data})+'\n');}
function inventory(){return (bot?.inventory?.slots||[]).flatMap((i,slot)=>i&&slot>=5?[{name:i.name,count:i.count,slot}]:[]);}
const fields=['taskId','source','userCommand','intent','status','createdAt','startedAt','finishedAt','executionGeneration','currentStep','currentStepIndex','progressText','error','errorCode','plan','completionPlan','planApproval','submittedContext','siteSearch','stepCheckpoint','materialSupply','diagnostics','logs','recoveryCount','maxRecoveryAttempts','aiMidTaskRevisionCount','scriptKey','scriptMeta'];
function checkpoint(value){return value&&JSON.parse(json(Object.fromEntries(fields.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]))));}
function persist(value){if(!value)return;const tmp=path.join(dev,'development-checkpoint.tmp');fs.writeFileSync(tmp,json({schema:1,evidenceDomain:'DEVELOPMENT_CONTINUATION_ONLY',session,task:checkpoint(value)})+'\n',{mode:0o600});fs.renameSync(tmp,path.join(dev,'development-checkpoint.json'));}
function observe(){task=recoveryCombat?savedConstruction:(agent?.__testGetReconnectTask()||task);if(!task)return;persist(task);const data={status:task.status,step:task.currentStepIndex,phase:task.stepCheckpoint?.furnishedHouse?.phase,position:bot?.entity?.position,health:bot?.health,food:bot?.food,inventory:inventory(),error:task.error};record('snapshot',data);console.log(JSON.stringify(data));}
async function developmentSurvivalBoundary(){
  // Runs only between settled foreground operations, through the production
  // resource-work owner and production urgent defense. No server commands.
  task=agent.__testGetReconnectTask()||task;
  task.cancellationToken=new CancellationToken();task.status='running';
  task.movementLease=agent.__testClaimMovementLease('task',`${task.taskId}:development-survival`);
  const began=Date.now(),until=began+90000;
  try{await agent.__testWithHouseResourceWork(async work=>{
    let last=0;
    while(!stopRequested&&!actorRestartRequested&&!death&&!ended&&!closed&&Date.now()<until){
      await agent.__testHandleSurvivalCritical('development_survival_boundary');
      const lease=agent.__testGetActiveMovementLease();assert.equal(lease,task.movementLease,'Survival owner must settle before recovery');
      const {rangedCoverConfirmed}=req(path.join(runtime,'vendor/server/minecraft/houseRangedCover'));
      const threats=Object.values(bot.entities||{}).filter(e=>e.isValid!==false&&['creeper','spider','cave_spider','zombie','husk','drowned','skeleton','stray','bogged'].includes(e.name)&&e.position?.distanceTo(bot.entity.position)<(e.name==='creeper'?8.5:['skeleton','stray','bogged'].includes(e.name)?24:8.5)&&(!['skeleton','stray','bogged'].includes(e.name)||!rangedCoverConfirmed(bot,bot.entity.position,[e])));
      if(Date.now()-last>2000){record('development_survival_observed',{health:bot.health,food:bot.food,position:bot.entity.position,threats:threats.map(e=>({id:e.id,name:e.name,position:e.position}))});last=Date.now();}
      if(!threats.length&&bot.health>=18)return;
      if(!threats.length&&work.safeFoot(bot.entity.position)&&bot.food<20){
        const food=bot.inventory.items().find(i=>['cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken','bread','baked_potato'].includes(i.name));
        if(food){await bounded(agent.__testEnsureNutrition(Math.min(20,bot.food+Number(bot.registry.foodsByName[food.name]?.foodPoints||0))),7000,'Owned recovery food timeout');record('actual_recovery_meal',{item:food.name,health:bot.health,food:bot.food});}
        else if(bot.food<18)return; // Hand the actual deficit to ordinary provisioning.
      }
      await delay(250);
    }
  },{deadline:until});}finally{task.status='paused';task.movementLease=null;persist(task);}
}
async function main(){
  if(!fs.existsSync(dev)){
    const previous=JSON.parse(fs.readFileSync(path.join(origin,'result.json')));assert.equal(previous.stopped?.normal,true,'Origin must be normally saved and stopped');assert.ok(previous.task?.plan?.steps?.length);
    const before=tree(path.join(origin,'world'));fs.mkdirSync(dev);fs.cpSync(path.join(origin,'world'),path.join(dev,'world'),{recursive:true,errorOnExist:true,force:false});
    for(const name of ['server.properties','eula.txt'])fs.copyFileSync(path.join(origin,name),path.join(dev,name),fs.constants.COPYFILE_EXCL);
    fs.cpSync(path.join(origin,'deskpet-data'),path.join(dev,'deskpet-data'),{recursive:true,errorOnExist:true,force:false});
    assert.deepEqual(tree(path.join(dev,'world')),before);assert.deepEqual(tree(path.join(origin,'world')),before);
    fs.writeFileSync(path.join(dev,'development-origin.json'),json({origin,originalResultSha:hash(path.join(origin,'result.json')),worldFiles:before,seed:JSON.parse(fs.readFileSync(path.join(origin,'seed-allocation.json'))).seed,evidenceDomain:'DEVELOPMENT_ONLY_SAME_SEED',freshAcceptance:false})+'\n',{flag:'wx'});task=previous.task;persist(task);
  }
  assert.ok(!fs.existsSync(out),'Session names cannot be reused');fs.mkdirSync(out,{recursive:true});
  task=JSON.parse(fs.readFileSync(path.join(dev,'development-checkpoint.json'))).task;assert.ok(task?.plan?.steps?.length);assert.notEqual(task.status,'completed','Completed tasks require review, not automatic replay');
  const source={...Object.fromEntries(['package.json','package-lock.json','runtime.js','protocolCompatibility.js'].filter(f=>fs.existsSync(path.join(runtime,f))).map(f=>[f,hash(path.join(runtime,f))])),vendor:tree(path.join(runtime,'vendor'))};
  fs.writeFileSync(path.join(out,'source-start.json'),json(source)+'\n',{flag:'wx'});fs.writeFileSync(path.join(out,'checkpoint-start.json'),json(task)+'\n',{flag:'wx'});
  record('development_started',{runtime,origin,dev,source,cleanEndToEndAcceptance:false});
  const properties=fs.readFileSync(path.join(dev,'server.properties'),'utf8'),port=Number(properties.match(/^server-port=(\d+)$/m)?.[1]);assert.ok(port>0);
  let output='';
  if(argv.includes('--attach-existing')){
    assert.ok(!argv.includes('--view'),'Retain the existing observer; attach mode does not launch another client');
    await bounded(new Promise((resolve,reject)=>{const socket=require('node:net').createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.end();resolve();});socket.once('error',reject);}),15000,'Existing server readiness timeout');
    record('external_server_attached',{port,worldRestartedByRunner:false,ownsServer:false});
  }else{
    server=spawn(settings.java,['-Xms1G','-Xmx3G','-jar',settings.minecraft.jar,'nogui'],{cwd:dev,stdio:['pipe','pipe','pipe']});
    serverClosed=once(server,'close').then(([code,signal])=>closed={code,signal});for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{output+=chunk;fs.appendFileSync(path.join(out,'server.log'),chunk);});
    await bounded((async()=>{while(!/Done \([^)]+\)! For help/.test(output)){if(closed)throw Error('Server closed before ready');if(stopRequested)throw Error('Stop requested');await delay(200);}})(),240000,'Server readiness timeout');
  }
  // Optional human camera only. No OP permission, inventory grants, time/weather
  // changes, or construction commands are given to the survival actor.
  if(argv.includes('--view')){
    const config=JSON.parse(fs.readFileSync(path.join(base,'client-1.21.8/launch-config.json')));
    assert.equal(config.game[config.game.indexOf('--username')+1],'DeskPetView');
    const log=fs.openSync(path.join(out,'observer-client.log'),'wx');
    const viewer=spawn(config.java,[...config.jvm,...config.game,'--quickPlayMultiplayer',`127.0.0.1:${port}`],{cwd:config.cwd,detached:true,stdio:['ignore',log,log]});fs.closeSync(log);viewer.unref();
    let viewerError;viewer.once('error',e=>{viewerError=e;});
    const cursor=output.length;
    await bounded((async()=>{while(!output.slice(cursor).includes('DeskPetView joined the game')){if(viewerError)throw viewerError;if(closed||stopRequested)throw Error('Observer startup stopped');await delay(100);}})(),90000,'Observer client readiness timeout');
    record('observer_console_command',{command:'gamemode spectator DeskPetView',scope:'camera_only'});
    server.stdin.write('gamemode spectator DeskPetView\n');
    record('observer_client_ready',{pid:viewer.pid,port,username:'DeskPetView',acceptanceImpact:'Development observation only; spectator is separate from survival bot'});
  }
  const runActor=async()=>{
  const factory=req(path.join(runtime,'vendor/server/minecraftTaskAgent')).createMinecraftTaskAgent;
  agent=factory({appPaths:{appDataDir:path.join(dev,'deskpet-data')},readConfig:()=>({mcExecutorMode:'strict-executor',mcAgentAutoReconnect:false}),parseJsonObjectFromText:JSON.parse,broadcast:event=>record('agent_event',{event}),broadcastMinecraftError:message=>record('agent_error',{message}),allowAutonomousMaintenance:()=>false,requestPlannerCompletion:async()=>{record('unexpected_provider_request');throw Error('No model calls authorized');}});
  bot=mineflayer.createBot(withMinecraftProtocolCompatibility({host:'127.0.0.1',port,username:'DeskPetSelfBuild',auth:'offline',respawn:true,version:settings.minecraft.version,hideErrors:false}));
  bot._client.on('entity_status',packet=>{if(packet.entityId===bot.entity?.id&&[2,29,30].includes(packet.entityStatus))record('actual_self_status',{status:packet.entityStatus,health:bot.health,offhand:bot.inventory.slots[45]?.name,shieldDurabilityUsed:bot.inventory.slots[45]?.durabilityUsed});});
  bot.on('entityDead',entity=>record('actual_entity_death',{id:entity.id,name:entity.name,position:entity.position}));
  bot.on('error',e=>record('bot_error',{message:e.message}));bot.on('end',()=>{ended=true;wake();});bot.on('death',()=>{if(!initialSpawnComplete&&argv.includes('--recover-drops')){record('restored_dead_login',{position:bot.entity?.position});return;}record('actual_death',{position:bot.entity?.position,inventory:inventory()});death=true;deathCount++;
    if(argv.includes('--keep-running')){agent?.handleMessage({type:'mc_command_pause'}).catch(e=>record('death_pause_fault',{message:e.message}));return;}
    wake();try{bot.quit('Death: preserve dropped-item world state');}catch{}});
  bot.on('spawn',async()=>{if(!initialSpawnComplete)return;try{await acknowledgePlayerLoaded(bot);await bot.waitForChunksToLoad();death=false;record('normal_respawn_confirmed',{position:bot.entity.position,health:bot.health,food:bot.food,deathCount});if(argv.includes('--view')&&server.stdin.writable){record('observer_console_command',{command:'spectate DeskPetSelfBuild DeskPetView',scope:'camera_only'});server.stdin.write('spectate DeskPetSelfBuild DeskPetView\n');}}catch(e){record('respawn_fault',{message:e.message});}});
  await bounded(once(bot,'spawn'),60000,'Spawn timeout');initialSpawnComplete=true;installMinecraftBedWakeCompatibility(bot);await bounded(acknowledgePlayerLoaded(bot),60000,'Player-loaded timeout');await bounded(bot.waitForChunksToLoad(),60000,'Chunks timeout');assert.equal(bot.game.gameMode,'survival');
  if(argv.includes('--view')){record('observer_console_command',{command:'spectate DeskPetSelfBuild DeskPetView',scope:'camera_only'});server.stdin.write('spectate DeskPetSelfBuild DeskPetView\n');}
  if(argv.includes('--guarded-meal-first')){
    assert.equal(bot.inventory.slots[45]?.name,'shield');
    const food=bot.inventory.items().find(i=>['cooked_beef','cooked_porkchop','bread','cooked_mutton'].includes(i.name));assert.ok(food,'Need actual carried meal');
    record('native_guarded_meal_start',{health:bot.health,food:bot.food,item:food.name});
    await bot.equip(food,'hand');await bounded(bot.consume(),5000,'Native emergency meal timeout');
    const sword=bot.inventory.items().find(i=>i.name==='stone_sword');if(sword)await bot.equip(sword,'hand');
    const threats=()=>Object.values(bot.entities||{}).filter(e=>['zombie','husk','drowned','skeleton','stray','bogged'].includes(e.name)&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<16).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));
    let enemy=threats()[0];if(enemy)await bot.lookAt(enemy.position.offset(0,1.2,0),true);bot.activateItem(true);
    const until=Date.now()+120000;let last=0;
    while(bot.health<14&&!death&&!ended&&!stopRequested&&Date.now()<until){
      enemy=threats()[0];if(enemy)await bot.lookAt(enemy.position.offset(0,1.2,0),true);
      if(Date.now()-last>1000){record('native_guarded_regen',{health:bot.health,food:bot.food,position:bot.entity.position,shieldDamage:bot.inventory.slots[45]?.durabilityUsed,threats:threats().map(e=>({name:e.name,id:e.id,position:e.position}))});last=Date.now();}
      assert.ok(bot.health>0&&bot.food>=18,'Guarded regeneration needs actual life and food');await delay(50);
    }
    assert.ok(bot.health>=14&&!death&&!ended,'Native guarded recovery incomplete');record('native_guarded_meal_recovered',{health:bot.health,food:bot.food});
  }
  if(argv.includes('--surface-first')){
    if(!bot.pathfinder)bot.loadPlugin(req('mineflayer-pathfinder').pathfinder);
    const {Vec3}=req('vec3'),origin=bot.entity.position.floored(),air=new Set(['air','cave_air','void_air']);
    let top=null;for(let dy=0;dy<=10;dy++){const p=origin.offset(0,dy,0),b=bot.blockAt(p);assert.ok(b,'Surface recovery needs loaded column');if(air.has(b.name)&&air.has(bot.blockAt(p.offset(0,1,0))?.name)){top=p;break;}assert.equal(b.name,'water','Surface recovery refuses obstruction or other fluids');}
    assert.ok(top,'No observed air above this finite water column');
    record('actual_surface_recovery_started',{position:bot.entity.position,top,health:bot.health});
    const until=Date.now()+10000;bot.clearControlStates();bot.setControlState('jump',true);
    while(!air.has(bot.blockAt(bot.entity.position.offset(0,1.62,0).floored())?.name)){
      assert.ok(!stopRequested&&!death&&!ended&&bot.health>0&&Date.now()<until,'Surface recovery stopped');await delay(50);
    }
    const profile=new Movements(bot);profile.canDig=false;profile.scafoldingBlocks=[];profile.allowParkour=false;profile.allow1by1towers=false;profile.maxDropDown=2;bot.pathfinder.setMovements(profile);
    const {classifyMiningBlock}=req(path.join(runtime,'vendor/server/minecraft/miningNavigation'));
    const shores=[];for(let dx=-12;dx<=12;dx++)for(let dz=-12;dz<=12;dz++)for(let dy=-1;dy<=3;dy++){
      const p=new Vec3(origin.x+dx,top.y+dy,origin.z+dz);
      if(air.has(bot.blockAt(p)?.name)&&air.has(bot.blockAt(p.offset(0,1,0))?.name)&&classifyMiningBlock(bot.blockAt(p.offset(0,-1,0))).support)shores.push(p);
    }
    shores.sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position));assert.ok(shores.length,'No loaded dry shore');
    const goal=new goals.GoalBlock(shores[0].x,shores[0].y,shores[0].z);await bounded(bot.pathfinder.goto(goal),30000,'Native shore recovery timeout');
    assert.ok(goal.isEnd(bot.entity.position.floored()),'Shore arrival must actually match');bot.clearControlStates();
    assert.ok(air.has(bot.blockAt(bot.entity.position.floored())?.name),'Shore body must actually be out of water');
    record('actual_surface_recovery_confirmed',{position:bot.entity.position,health:bot.health,food:bot.food});
  }
  if(bot.inventory.slots[45]?.name==='shield'&&bot.health<18){bot.activateItem(true);record('actual_boot_shield_raised',{health:bot.health,yaw:bot.entity.yaw});}
  if(argv.includes('--dugout-first')){
    if(!bot.pathfinder)bot.loadPlugin(req('mineflayer-pathfinder').pathfinder);
    // Trusted development recovery uses only native game operations and live
    // loaded blocks. It never restores health, position or inventory fields.
    const {Vec3}=req('vec3'),{classifyMiningBlock,createMiningNavigator}=req(path.join(runtime,'vendor/server/minecraft/miningNavigation'));
    const {planEmergencyDugout,enterEmergencyDugout,emergencyDugoutConfirmed}=req(path.join(runtime,'vendor/server/minecraft/houseEmergencyDugout'));
    const {planHouseLocalRoute}=req(path.join(runtime,'vendor/server/minecraft/houseLocalRoute'));
    const alive=()=>assert.ok(!stopRequested&&!death&&!ended&&!closed&&bot.health>0,'Dugout recovery stopped on actual state');
    const at=p=>bot.blockAt(new Vec3(p.x,p.y,p.z));
    const mobs=()=>Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&['zombie','husk','drowned','skeleton','stray','bogged','creeper','spider','cave_spider'].includes(e.name));
    const observe=()=>({position:bot.entity.position,onGround:bot.entity.onGround,entities:mobs()});
    await bounded((async()=>{while(!bot.entity.onGround){alive();await delay(20);}})(),1200,'Dugout needs actual ground');
    const saved=task.materialSupply.emergencyDugout;
    const plan=saved?.plan||planEmergencyDugout({position:bot.entity.position,blockAt:at});assert.ok(plan,'No checked three-soil emergency column');
    task.materialSupply.emergencyDugout={plan,status:'entering'};persist(task);
    if(!emergencyDugoutConfirmed({plan,...observe(),blockAt:at}))await enterEmergencyDugout({assertActive:alive,observe,blockAt:at,
      dig:async block=>{alive();bot.deactivateItem();await bot.dig(block,true,'raycast');alive();},
      cap:async p=>{alive();const item=bot.inventory.items().find(i=>['cobblestone','dirt'].includes(i.name));assert.ok(item);await bot.equip(item,'hand');
        const refs=[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>({block:at({...p,x:p.x+dx,z:p.z+dz}),face:new Vec3(-dx,0,-dz)}));
        const ref=refs.find(r=>classifyMiningBlock(r.block).support);assert.ok(ref);await bot.placeBlock(ref.block,ref.face);alive();assert.equal(at(p)?.name,item.name);},
      onProgress:data=>record('actual_dugout_progress',data)},plan);
    task.materialSupply.emergencyDugout.status='sealed';persist(task);
    const deadline=Date.now()+120000;record('actual_dugout_recovery_started',{position:bot.entity.position,health:bot.health,food:bot.food});
    while(bot.health<19){alive();assert.ok(Date.now()<deadline,'Dugout natural regeneration timeout');assert.ok(emergencyDugoutConfirmed({plan,...observe(),blockAt:at}),'Actual sealed dugout geometry changed');
      if(bot.food<20){const food=bot.inventory.items().find(i=>['cooked_beef','cooked_porkchop','bread','cooked_mutton'].includes(i.name));if(food){await bot.equip(food,'hand');await bounded(bot.consume(),5000,'Native dugout meal timeout');record('actual_dugout_meal',{item:food.name,health:bot.health,food:bot.food});}}
      assert.ok(bot.food>=18,'Dugout carried food exhausted');await delay(250);
    }
    record('actual_dugout_recovered',{health:bot.health,food:bot.food,position:bot.entity.position});
    const threats=mobs().sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position)),e=threats[0];
    const dx=e?bot.entity.position.x-e.position.x:-1,dz=e?bot.entity.position.z-e.position.z:0;
    const dir=Math.abs(dx)>=Math.abs(dz)?{x:Math.sign(dx)||-1,z:0}:{x:0,z:Math.sign(dz)||-1};
    const goal={x:plan.origin.x+dir.x*5,y:plan.origin.y,z:plan.origin.z+dir.z*5};
    const exitDeadline=Date.now()+90000;
    for(let attempt=0;attempt<8&&bot.entity.position.y<plan.origin.y-.075;attempt++){
      alive();assert.ok(bot.health>=12&&Date.now()<exitDeadline,'Dugout exit survival/deadline boundary');
      const route=planHouseLocalRoute({blockAt:at,from:bot.entity.position,goal,maxDigs:18,
        protectedPosition:p=>p.x===plan.cap.x&&p.y===plan.cap.y&&p.z===plan.cap.z,
        canDig:b=>b.canHarvest(bot.pathfinder?.bestHarvestTool(b)?.type??null)});assert.ok(route,'No finite checked exit staircase');
      record('dugout_exit_plan',{path:route.path,digs:route.digs,actualMovementConfirmed:false});
      const nav=createMiningNavigator({getBot:()=>bot,assertActive:alive,maxActions:24,movementTimeoutMs:7000,allowLeafSupport:true,allowCeilingClearance:true,
        digBlock:async block=>{alive();assert.ok(!(block.position.x===plan.cap.x&&block.position.y===plan.cap.y&&block.position.z===plan.cap.z));assert.ok(/^(dirt|grass_block|rooted_dirt|coarse_dirt|stone|cobblestone)$/.test(block.name));const pick=bot.inventory.items().find(i=>i.name==='stone_pickaxe');if(!['dirt','grass_block','rooted_dirt','coarse_dirt'].includes(block.name)&&pick)await bot.equip(pick,'hand');await bot.dig(block,true,'raycast');alive();},
        checkpoint:data=>record('actual_dugout_exit_checkpoint',{data})});
      for(const step of route.path){alive();await nav.advance(step.direction,{ascend:step.ascend,descend:step.descend});}
    }
    assert.ok(bot.entity.position.y>=plan.origin.y-.075&&bot.entity.onGround,'Dugout exit needs actual surface arrival');
    assert.ok(classifyMiningBlock(at(plan.cap)).support,'Original route floor must be physically restored by the cap');
    task.materialSupply.emergencyDugout.status='exited';persist(task);record('actual_dugout_exited',{position:bot.entity.position,health:bot.health,food:bot.food});
  }
  // Login/chunk readiness precedes the first server-confirmed grounded ticks.
  await bounded(bot.waitForTicks(2),5000,'Initial physical settlement timeout');
  if(argv.includes('--repair-camp-first')){
    if(!bot.pathfinder)bot.loadPlugin(req('mineflayer-pathfinder').pathfinder);
    const {Vec3}=req('vec3'),{classifyMiningBlock}=req(path.join(runtime,'vendor/server/minecraft/miningNavigation'));
    const camp=task.materialSupply.camp.anchor,at=p=>bot.blockAt(new Vec3(p.x,p.y,p.z)),key=p=>`${p.x},${p.y},${p.z}`;
    const alive=()=>assert.ok(!stopRequested&&!death&&!ended&&!closed&&bot.health>=16,'Camp repair lost actual survival readiness');
    const loadedThreats=()=>Object.values(bot.entities||{}).filter(e=>['creeper','zombie','skeleton','husk','drowned','stray','bogged','spider','cave_spider'].includes(e.name)&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<8.5);
    const quarryAir=new Set(Object.values(task.materialSupply.quarry?.routes||{}).flatMap(r=>(r.navigation?.breadcrumbs||[]).flatMap(p=>[key(p),key({...p,y:p.y+1})])));
    const foot=bot.entity.position.floored();alive();assert.ok(Math.hypot(foot.x-camp.x,foot.z-camp.z)<=3&&camp.y-foot.y>=0&&camp.y-foot.y<=3,'Camp repair needs nearby shallow actual crater');
    if(foot.y<camp.y){
      assert.equal(loadedThreats().length,0,'Camp pillar repair requires no nearby loaded threat');
      const profile=new Movements(bot);profile.canDig=false;profile.allowParkour=false;profile.allowSprinting=false;profile.allowFreeMotion=false;profile.maxDropDown=1;
      profile.allow1by1towers=true;profile.scafoldingBlocks=['dirt','cobblestone'].map(n=>bot.registry.itemsByName[n].id);bot.pathfinder.setMovements(profile);
      // Native GoalBlock can resolve at jump apex before the last supporting
      // block exists. Aim one level farther, stop on the actual required floor
      // block ACK, then let original physics land at the intended camp level.
      const goal=new goals.GoalBlock(foot.x,camp.y+1,foot.z),plan=bot.pathfinder.getPathTo(profile,goal,100);
      assert.equal(plan.status,'success');assert.ok(plan.path.length<=4&&plan.path.every(p=>p.x===foot.x&&p.z===foot.z&&p.y>=foot.y&&p.y<=camp.y+1&&!p.toBreak?.length));
      record('camp_repair_native_pillar_plan',{from:bot.entity.position,target:{x:foot.x,y:camp.y,z:foot.z},steps:plan.path.length,actualMovementConfirmed:false});
      const pending=bot.pathfinder.goto(goal);let nativeError;pending.catch(e=>{nativeError=e;});
      await bounded((async()=>{while(!classifyMiningBlock(at({x:foot.x,y:camp.y-1,z:foot.z})).support){alive();if(nativeError)throw nativeError;await delay(20);}})(),12000,'Native camp pillar actual support timeout');
      if(bot.pathfinder.goal===goal){bot.pathfinder.setGoal(null);bot.clearControlStates();}await pending.catch(()=>{});
      await bounded((async()=>{while(!bot.entity.onGround){alive();await delay(20);}})(),1500,'Camp pillar actual landing timeout');
      alive();assert.equal(Math.floor(bot.entity.position.y),camp.y);record('actual_camp_repair_pillar',{position:bot.entity.position,health:bot.health});
    }
    const pending=[];for(let x=camp.x-2;x<=camp.x+2;x++)for(let z=camp.z-2;z<=camp.z+2;z++)pending.push({x,y:camp.y-1,z});
    for(const p of [...Object.values(task.materialSupply.camp.stations||{}),...(task.materialSupply.storage?.chests||[]).map(e=>e.position)])pending.push({...p,y:p.y-1});
    let placements=0;const until=Date.now()+20000;
    while(pending.length){
      if(loadedThreats().length){record('camp_repair_requires_defense',{threats:loadedThreats().map(e=>({name:e.name,position:e.position})),remaining:pending.length});break;}
      alive();assert.ok(Date.now()<until&&placements<40,'Finite camp floor repair exhausted');let progressed=false;
      for(let i=pending.length-1;i>=0;i--){const p=pending[i],cell=classifyMiningBlock(at(p));assert.ok(cell.loaded&&!cell.hazard&&!cell.gravity,'Camp repair refuses unknown/wet/gravity cell');
        if(cell.support||quarryAir.has(key(p))){pending.splice(i,1);progressed=true;continue;}assert.ok(cell.passable,'Camp repair cannot overwrite an obstruction');
        if(bot.entity.position.x+.3>p.x&&bot.entity.position.x-.3<p.x+1&&bot.entity.position.z+.3>p.z&&bot.entity.position.z-.3<p.z+1&&bot.entity.position.y+1.8>p.y&&bot.entity.position.y<p.y+1)continue;
        const refs=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0]].map(([x,y,z])=>({block:at({x:p.x+x,y:p.y+y,z:p.z+z}),face:new Vec3(-x,-y,-z)}));
        const ref=refs.find(r=>classifyMiningBlock(r.block).support&&r.block.position.plus(r.face.scaled(.5)).offset(.5,.5,.5).distanceTo(bot.entity.position.offset(0,1.62,0))<=4.5);if(!ref)continue;
        const item=['dirt','cobblestone'].map(n=>bot.inventory.items().find(i=>i.name===n)).find(Boolean);assert.ok(item,'No real carried repair blocks');await bot.equip(item,'hand');await bot.placeBlock(ref.block,ref.face);alive();assert.equal(at(p)?.name,item.name);
        record('actual_camp_floor_repaired',{position:p,item:item.name});placements++;pending.splice(i,1);progressed=true;
      }
      assert.ok(progressed,'Camp repair has no reachable native attachment');
    }
    assert.ok(classifyMiningBlock(at({...camp,y:camp.y-1})).support);record(pending.length?'actual_camp_repair_partial':'actual_camp_ground_repaired',{placements,remaining:pending.length,quarryAirPreserved:true,health:bot.health,inventory:inventory()});
  }
  record('actual_start',{inventory:inventory(),position:bot.entity.position,health:bot.health,food:bot.food,onGround:bot.entity.onGround,feetBlock:bot.blockAt(bot.entity.position.floored())?.name,belowBlock:bot.blockAt(bot.entity.position.floored().offset(0,-1,0))?.name});

  agent.attachBot(bot);agent.initializeBotRuntime();
  // Restore only observed semantic progress through a trusted test fixture hook.
  // Fresh token/lease are created by ordinary resume; no stage/material completion is invented.
  task={...task,source:task.source||'deskpet',status:'paused',logs:task.logs||[],cancellationToken:new CancellationToken(),movementLease:null};
  // Diagnostic file paths are host session state, never restored verbatim.
  record('diagnostic_lineage',{previous:task.diagnostics?.tracePath||null});
  task.diagnostics={traceId:`${task.taskId}-${session}`,tracePath:path.join(out,'task-diagnostics.jsonl'),startedAt:Date.now(),finishedAt:null,eventCount:0,lastEvent:null,lastError:null,lastDisconnectSource:null,lastWrite:null};
  agent.__testSetReconnectTask(task);
  if(argv.includes('--probe-shield')){
    assert.equal(bot.inventory.slots[45]?.name,'shield','Probe needs actually equipped shield');
    const began=Date.now(),startHealth=bot.health,write=bot._client.write;let hit=false,blocked=false;
    bot._client.write=function(name,data,...rest){if(name==='use_item'||name==='block_dig'&&data.status===5)record('shield_probe_write',{elapsedMs:Date.now()-began,name,hand:data.hand,rotation:data.rotation,status:data.status});return write.call(this,name,data,...rest);};
    const status=p=>{if(p.entityId===bot.entity.id){record('shield_probe_own_status',{elapsedMs:Date.now()-began,status:p.entityStatus});if(p.entityStatus===29)blocked=true;}};
    const metadata=p=>{if(p.entityId===bot.entity.id)record('shield_probe_own_metadata',{elapsedMs:Date.now()-began,metadata:p.metadata.filter(x=>[8,9].includes(x.key))});};
    const health=()=>{record('shield_probe_health',{elapsedMs:Date.now()-began,health:bot.health,food:bot.food});if(bot.health<startHealth)hit=true;};
    bot._client.on('entity_status',status);bot._client.on('entity_metadata',metadata);bot.on('health',health);
    const nearest=()=>Object.values(bot.entities||{}).filter(e=>['zombie','husk','drowned','skeleton','stray','bogged'].includes(e.name)&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<=16).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0];
    try{
      bot.activateItem(true);let target=nearest();
      while(!target&&!hit&&!death&&!ended&&Date.now()-began<1500){await delay(10);target=nearest();}
      if(target&&!hit){await bot.lookAt(target.position.offset(0,target.height||1.6,0),true);}
      record('shield_probe_started',{startHealth,target:target?{id:target.id,name:target.name,position:target.position}:null,position:bot.entity.position,yaw:bot.entity.yaw,pitch:bot.entity.pitch,usingHeldItem:bot.usingHeldItem});
      while(!hit&&!blocked&&!death&&!ended&&!stopRequested&&Date.now()-began<4000)await delay(10);
      record('shield_probe_ended',{elapsedMs:Date.now()-began,hit,blocked,health:bot.health,usingHeldItem:bot.usingHeldItem});
    }finally{bot._client.write=write;bot._client.removeListener('entity_status',status);bot._client.removeListener('entity_metadata',metadata);bot.removeListener('health',health);}
    return;
  }
  let recoveryAttempts=0,bagRecovered=false;
  async function recoverDroppedBag(){
  if(argv.includes('--recover-drops')&&!bagRecovered&&bot.health>=12&&recoveryAttempts<3){
    recoveryAttempts++;
    // Private semantic owner for actual drop recovery, not house-stage credit.
    task.status='running';task.movementLease=agent.__testClaimMovementLease('task',`${task.taskId}:development-drop-recovery`);
    try{await agent.__testWithHouseResourceWork(async()=>{
    const profile=bot.pathfinder.movements;
    record('private_recovery_source_survival_enabled',{timeOfDay:bot.time.timeOfDay,immediate:argv.includes('--recover-immediately')});
    const alive=()=>{assert.ok(!stopRequested&&!actorRestartRequested&&!death&&!ended&&!closed&&bot.health>=12&&agent.__testGetActiveMovementLease()===task.movementLease,'Recovery stopped on actual survival state or ownership');};
    const {planHouseLocalRoute}=req(path.join(runtime,'vendor/server/minecraft/houseLocalRoute'));
    const {createMiningNavigator}=req(path.join(runtime,'vendor/server/minecraft/miningNavigation'));
    const {getSurfaceGraphProtectedPositions}=req(path.join(runtime,'vendor/server/minecraft/houseSurfaceGraph'));
    const protectedCells=new Set(Object.values(task.materialSupply.surfaceGraphs||{}).flatMap(getSurfaceGraphProtectedPositions).map(p=>`${p.x},${p.y},${p.z}`));
    const protectedPosition=p=>protectedCells.has(`${p.x},${p.y},${p.z}`)||(task.materialSupply.quarry?.excludeBounds||[]).some(b=>p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ);
    const goto=async(p,label)=>{
      const deadline=Date.now()+180000;
      for(let attempt=0;attempt<3;attempt++){
        alive();record('actual_recovery_navigation',{label,target:p,attempt});const goal=p.exact?new goals.GoalBlock(p.x,p.y,p.z):p.y===undefined?new goals.GoalXZ(p.x,p.z):new goals.GoalNear(p.x,p.y,p.z,1);
        const pending=agent.__testHouseSurfacePathfinderGoto(goal,Math.min(60000,deadline-Date.now()),{deadline});pending.catch(()=>{});
        try{await bounded(pending,Math.min(60000,deadline-Date.now()),label+' native navigation timeout');await delay(100);alive();assert.ok(goal.isEnd(bot.entity.position.floored()),'Native completion without actual arrival');return;}
        catch(error){
          if(bot.pathfinder.goal===goal){bot.pathfinder.setGoal(null);bot.clearControlStates();}
          await bounded(pending.catch(()=>{}),2000,'Previous native goal must settle before route recovery');alive();if(attempt>=2||Date.now()>=deadline)throw error;
          const plan=planHouseLocalRoute({blockAt:q=>bot.blockAt(new (req('vec3').Vec3)(q.x,q.y,q.z)),from:bot.entity.position,goal:{...p,y:p.y??bot.entity.position.y},protectedPosition,maxDigs:18,
            canDig:block=>block.canHarvest(bot.pathfinder.bestHarvestTool(block)?.type??null)});
          if(!plan)throw error;
          record('local_route_recovery_planned',{label,path:plan.path,digs:plan.digs,actualMovementConfirmed:false});
          const nav=createMiningNavigator({getBot:()=>bot,assertActive:alive,maxActions:24,movementTimeoutMs:7000,allowLeafSupport:true,allowCeilingClearance:true,
            checkpoint:state=>record('actual_route_recovery_checkpoint',{state}),
            equipForBlock:async block=>{alive();const tool=bot.pathfinder.bestHarvestTool(block);if(tool)await bot.equip(tool,'hand');alive();},
            digBlock:async block=>{alive();assert.ok(!protectedPosition(block.position));assert.ok(/^(dirt|grass_block|rooted_dirt|coarse_dirt|stone|cobblestone)$/.test(block.name)||block.name.endsWith('_leaves'));await bot.dig(block,true,'raycast');alive();}});
          for(const step of plan.path){alive();assert.ok(Date.now()<deadline,'Local route recovery deadline');await nav.advance(step.direction,{ascend:step.ascend,descend:step.descend});}
          record('actual_route_recovery_completed',{position:bot.entity.position,dug:nav.getState().dug,moves:nav.getState().moves});
        }
      }
    };
    const recoveryFrom=arg('--recover-from',null);
    let bagTargets={cobblestone:51,oak_log:12,stone_pickaxe:1},deathArea={x:-83,z:-163};
    if(recoveryFrom){
      assert.match(recoveryFrom,/^[A-Za-z0-9_-]+$/);
      const evidencePath=path.join(dev,'development-sessions',recoveryFrom,'events.jsonl');
      const descriptor=fs.openSync(evidencePath,'r'),size=fs.fstatSync(descriptor).size,start=Math.max(0,size-16*1024*1024),buffer=Buffer.alloc(size-start);
      try{fs.readSync(descriptor,buffer,0,buffer.length,start);}finally{fs.closeSync(descriptor);}
      const events=buffer.toString('utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
      const actualDeath=events.findLast(e=>e.type==='actual_death');
      const aliveSnapshot=events.findLast(e=>e.type==='snapshot'&&e.health>0&&e.inventory?.length&&Date.parse(e.at)<=Date.parse(actualDeath?.at));
      assert.ok(actualDeath?.position&&aliveSnapshot,'Recovery needs recorded actual death and living inventory');
      deathArea={x:Math.floor(actualDeath.position.x),y:Math.floor(actualDeath.position.y),z:Math.floor(actualDeath.position.z)};
      const core=new Set(['cobblestone','oak_log','birch_log','wooden_sword','wooden_pickaxe','stone_pickaxe','stone_axe','stone_sword','shield','cooked_beef','iron_pickaxe','iron_chestplate','porkchop','cooked_mutton','chicken']);
      bagTargets={};for(const item of aliveSnapshot.inventory)if(core.has(item.name))bagTargets[item.name]=(bagTargets[item.name]||0)+item.count;
      if(bagTargets.stone_pickaxe)bagTargets.stone_pickaxe=1;
      record('recovery_from_observed_death',{session:recoveryFrom,deathArea,bagTargets});
    }
    assert.ok(Object.keys(bagTargets).length,'Observed death inventory has no recoverable target; never claim empty bag success');
    const hasBag=()=>Object.entries(bagTargets).every(([name,count])=>inventory().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)>=count);
    if(!hasBag()){
      const shelter=task.materialSupply.quarry?.routes?.raw_iron?.navigation?.breadcrumbs?.find(p=>p.y<=task.materialSupply.camp.anchor.y-14)||{x:-88,y:63,z:-8};if(!argv.includes('--recover-immediately')&&bot.time.timeOfDay>=12000){await goto(shelter,'previously excavated quarry shelter');bot.pathfinder.setGoal(null);bot.clearControlStates();}
      const waitUntil=Date.now()+720000;let last=0;
      while(!argv.includes('--recover-immediately')&&bot.time.timeOfDay>=12000){alive();assert.ok(Date.now()<waitUntil,'Natural daylight wait deadline');const threats=Object.values(bot.entities||{}).filter(e=>['creeper','skeleton','zombie','spider','husk','drowned','stray'].includes(e.name)&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<8);if(threats.length)record('recovery_shelter_threat',{actual:bot.entity.position,threats:threats.map(e=>({name:e.name,position:e.position,distance:e.position.distanceTo(bot.entity.position)}))});assert.equal(threats.length,0,'Actual hostile entered quarry shelter');if(Date.now()-last>10000){console.log(JSON.stringify({recovery:'waiting_for_natural_daylight',timeOfDay:bot.time.timeOfDay,health:bot.health}));last=Date.now();}await delay(250);}
      // Prefer an actual visible weapon/shield from the observed death area
      // over walking to its center and punching a guard mob bare-handed.
      const visibleCore=Object.values(bot.entities||{}).filter(e=>e.name==='item'&&e.isValid!==false&&e.position
        &&Math.hypot(e.position.x-deathArea.x,e.position.z-deathArea.z)<=12)
        .map(entity=>({entity,name:entity.getDroppedItem?.()?.name}))
        .filter(x=>['shield','stone_sword','stone_axe'].includes(x.name))
        .sort((a,b)=>['stone_sword','shield','stone_axe'].indexOf(a.name)-['stone_sword','shield','stone_axe'].indexOf(b.name)
          ||a.entity.position.distanceTo(bot.entity.position)-b.entity.position.distanceTo(bot.entity.position));
      if(visibleCore.length){const picked=visibleCore[0];record('observed_recovery_equipment_target',{name:picked.name,position:picked.entity.position});
        await goto(picked.entity.position.floored(),'actual visible recovery equipment');await delay(250);
        const sword=bot.inventory.items().find(i=>i.name==='stone_sword');if(sword){alive();await bot.equip(sword,'hand');alive();}
        const shield=bot.inventory.items().find(i=>i.name==='shield');if(shield){alive();await bot.equip(shield,'off-hand');alive();}
      }
      // Last observed living position; no NBT item locations enter movement.
      await goto(deathArea,'last recorded death area');
      const until=Date.now()+30000;
      while(!hasBag()&&Date.now()<until){alive();
        const shield=bot.inventory.items().find(i=>i.name==='shield');
        if(shield&&bot.inventory.slots[45]?.name!=='shield'){await bot.equip(shield,'off-hand');alive();record('actual_recovered_shield_equipped',{health:bot.health});}
        const items=Object.values(bot.entities||{}).filter(e=>e.name==='item'&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<12).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));if(!items.length){await delay(500);continue;}const p=items[0].position.floored();await goto(p,'actual visible dropped item');await delay(500);}
      assert.ok(hasBag(),'Actual dropped materials not fully recovered');record('actual_bag_recovered',{inventory:inventory(),health:bot.health});
    }
    const recoveredShield=bot.inventory.items().find(i=>i.name==='shield');if(recoveredShield){alive();await bot.equip(recoveredShield,'off-hand');alive();assert.equal(bot.inventory.slots[45]?.name,'shield');}
    bagRecovered=hasBag();
    await goto({...task.materialSupply.camp.anchor,exact:true},'return recovered inventory to camp');record('actual_recovery_returned_camp',{inventory:inventory(),position:bot.entity.position});
    });}catch(e){if(!argv.includes('--keep-running'))throw e;record('recovery_handoff',{message:e.message,health:bot.health,food:bot.food,position:bot.entity.position});}finally{task.status='paused';task.movementLease=null;}
  }
  }
  await recoverDroppedBag();
  if(argv.includes('--clear-nearby-hostiles')){
    const ranged=Object.values(bot.entities||{}).filter(e=>['skeleton','stray','bogged'].includes(e.name)&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<=10);
    if(ranged.length){
      savedConstruction=task;recoveryCombat=true;record('registered_combat_recovery_started',{targets:ranged.map(e=>({id:e.id,name:e.name,position:e.position}))});
      agent.__testSetReconnectTask(null);await agent.handleMessage({type:'mc_command_submit',command:'清理附近的骷髅',source:'deskpet'});
      let combat=agent.__testGetReconnectTask();assert.ok(combat,'Combat task must be registered');const until=Date.now()+65000;
      while(Date.now()<until&&!stopRequested&&!death&&!ended&&!closed){await delay(250);combat=agent.__testGetReconnectTask()||combat;if(['completed','failed','paused','cancelled'].includes(combat.status))break;}
      record('registered_combat_recovery_ended',{status:combat.status,health:bot.health,remaining:ranged.filter(e=>bot.entities[e.id]?.isValid!==false&&bot.entities[e.id]).map(e=>e.id)});
      assert.equal(combat.status,'completed','Registered combat recovery did not complete');assert.ok(ranged.every(e=>!bot.entities[e.id]||bot.entities[e.id].isValid===false),'Original ranged threat must actually disappear');
      task=savedConstruction;agent.__testSetReconnectTask(task);recoveryCombat=false;savedConstruction=null;
    }
  }
  if(argv.includes('--recover-health')&&bot.health<19){
    const deadline=Date.now()+120000,hostiles=new Set(['creeper','zombie','husk','drowned','skeleton','stray','witch','pillager','vindicator','ravager','spider','cave_spider','silverfish','endermite']);let reported=0;
    record('natural_recovery_started',{health:bot.health,food:bot.food});
    while(bot.health<19&&!stopRequested&&!death&&!ended&&!closed&&Date.now()<deadline){
      const threats=Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.isValid!==false&&hostiles.has(e.name)&&e.position?.distanceTo(bot.entity.position)<16);
      assert.equal(threats.length,0,'Natural recovery refused: loaded hostile within16m');
      if(bot.food<=18){const food=bot.inventory.items().find(i=>['cooked_beef','cooked_porkchop','cooked_mutton','cooked_chicken','bread','baked_potato'].includes(i.name));assert.ok(food,'Natural recovery needs already gathered cooked food');await bot.equip(food,'hand');await bounded(bot.consume(),5000,'Actual food consumption timeout');record('actual_recovery_meal',{item:food.name,health:bot.health,food:bot.food});}
      if(Date.now()-reported>10000){console.log(JSON.stringify({recovery:'natural_regeneration',health:bot.health,food:bot.food}));reported=Date.now();}
      await delay(250);
    }
    assert.ok(bot.health>=19&&!stopRequested&&!death&&!ended&&!closed,'Natural recovery incomplete; task kept paused');record('natural_recovery_confirmed',{health:bot.health,food:bot.food});
  }
  if(argv.includes('--keep-running')&&bot.health<18){try{await developmentSurvivalBoundary();}catch(e){record('survival_boundary_handoff',{code:e.code,message:e.message,health:bot.health});}}
  ticks=createRuntimeTickLoop({isReady:()=>Boolean(bot?.entity&&!ended&&!closed),tick:()=>agent.tickIdleBehavior(),onFault:e=>record('tick_fault',{code:e.code,message:e.message})});
  try{await agent.handleMessage({type:'mc_command_resume'});record('ordinary_resume_requested',{taskId:task.taskId,step:task.currentStepIndex});}catch(e){if(!argv.includes('--keep-running'))throw e;record('resume_handoff',{message:e.message});}
  poll=setInterval(observe,10000);const limit=Date.now()+Number(arg('--timeout-ms','7200000'));
  let lastRetry=null,lastRetryAt=0;
  while(Date.now()<limit&&!stopRequested&&!actorRestartRequested&&(!death||argv.includes('--keep-running'))&&!ended&&!closed){
    await delay(500);task=agent.__testGetReconnectTask()||task;
    if(death||bot.health<=0)continue;
    if(['paused','failed','cancelled','completed'].includes(task.status)){
      if(!argv.includes('--keep-running')||['cancelled','completed'].includes(task.status))break;
      // Do not spin on an unchanged unreachable objective. Retry only after a
      // fresh observed state, with an explicit interval, and retain all evidence.
      const signature=JSON.stringify({error:task.errorCode,p:bot.entity.position.floored(),hp:Math.floor(bot.health),food:bot.food,inventory:inventory(),time:Math.floor(bot.time.timeOfDay/200),threats:Object.values(bot.entities||{}).filter(e=>['spider','creeper','zombie','skeleton'].includes(e.name)&&e.position?.distanceTo(bot.entity.position)<12).map(e=>({id:e.id,p:e.position.floored()}))});
      if(Date.now()-lastRetryAt<5000||signature===lastRetry)continue;
      lastRetry=signature;lastRetryAt=Date.now();
      try{await developmentSurvivalBoundary();if(!death&&!ended&&!stopRequested){await recoverDroppedBag();await agent.handleMessage({type:'mc_command_resume'});record('continuous_resume_requested',{health:bot.health,food:bot.food,step:task.currentStepIndex});}}
      catch(e){record('continuous_recovery_blocked',{code:e.code,message:e.message,health:bot.health,food:bot.food});}
    }
  }
  if(Date.now()>=limit)record('development_timeout');
  };
  // Fixed semantic controls only: no evaluation, shell, arbitrary script or
  // privileged game commands. Reload replaces the actor after it settles;
  // the owned Minecraft server and human camera stay connected.
  let lastControl=0,controlBusy=false;
  if(argv.includes('--keep-running'))controlTimer=setInterval(async()=>{
    if(controlBusy)return;const file=path.join(dev,'development-control.json');if(!fs.existsSync(file))return;
    let command;try{command=JSON.parse(fs.readFileSync(file));}catch{return;}
    if(command.session!==session||!Number.isSafeInteger(command.seq)||command.seq<=lastControl||!['reload','resume','stop'].includes(command.action))return;
    controlBusy=true;lastControl=command.seq;
    try{record('development_control_received',command);
      if(command.action==='stop'){stopRequested=true;wake();}
      else if(command.action==='reload'){actorRestartRequested=true;await agent?.handleMessage({type:'mc_command_pause'});bot?.quit('Development actor reload; server retained');}
      else if(!actorRestartRequested&&['paused','failed'].includes(agent?.__testGetReconnectTask()?.status))await agent.handleMessage({type:'mc_command_resume'});
    }catch(e){record('development_control_failed',{message:e.message});}finally{controlBusy=false;}
  },250);
  do{
    ended=false;death=false;initialSpawnComplete=false;actorRestartRequested=false;actorNumber++;
    record('development_actor_started',{actorNumber,vendor:tree(path.join(runtime,'vendor'))});
    try{await runActor();}catch(e){if(!argv.includes('--keep-running'))throw e;record('development_actor_fault',{actorNumber,code:e.code,message:e.message});}
    finally{
      clearInterval(poll);
      try{if(agent&&['running','planning'].includes(agent.__testGetReconnectTask()?.status))await bounded(agent.handleMessage({type:'mc_command_pause'}),10000,'Actor pause timeout');await ticks?.stop();task=agent?.__testGetReconnectTask()||task;observe();persist(task);}catch(e){record('actor_cleanup_fault',{message:e.message});}
      try{agent?.__testSetReconnectTask(null);agent?.detachBot('manual_disconnect');agent?.dispose();const oldBot=bot;oldBot?.quit('Actor transport closed; owned server retained');if(oldBot&&!ended)await bounded(once(oldBot,'end'),5000,'Actor end timeout').catch(()=>{});}catch(e){record('actor_detach_fault',{message:e.message});}
    }
    if(!argv.includes('--keep-running')||stopRequested||closed||['completed','cancelled'].includes(task?.status))break;
    if(actorRestartRequested){for(const id of Object.keys(req.cache))if(id.startsWith(path.join(runtime,'vendor')+path.sep))delete req.cache[id];record('development_actor_reload',{actorNumber,nextVendor:tree(path.join(runtime,'vendor'))});}
    await delay(1000);
  }while(!stopRequested&&!closed);
}
main().catch(e=>{try{if(bot&&!death&&!ended)bot.quit('Development helper stopped: preserve current player state');}catch{}error={message:e.message,stack:e.stack};if(fs.existsSync(out))record('development_error',error);console.error(e.stack);process.exitCode=1;}).finally(async()=>{
  clearInterval(poll);clearInterval(controlTimer);try{if(agent&&['running','planning'].includes(agent.__testGetReconnectTask()?.status))await bounded(agent.handleMessage({type:'mc_command_pause'}),10000,'Pause timeout');await ticks?.stop();task=recoveryCombat?savedConstruction:(agent?.__testGetReconnectTask()||task);persist(task);if(fs.existsSync(out)){observe();fs.writeFileSync(path.join(out,'checkpoint-end.json'),json(checkpoint(task))+'\n',{flag:'wx'});}}catch(e){error||={message:e.message};console.error(e.message);}
  try{agent?.__testSetReconnectTask(null);agent?.detachBot('manual_disconnect');agent?.dispose();bot?.quit('Development checkpoint saved');}catch(e){console.error(e.message);}
  if(server&&!closed){server.stdin.write('stop\n');await bounded(serverClosed,60000,'Owned server normal stop timeout').catch(e=>{error||={message:e.message};console.error(e.message);process.exitCode=1;});}
  if(fs.existsSync(out)){
    const startFile=path.join(out,'source-start.json');let runtimeSourceUnchanged=null;if(fs.existsSync(startFile)){const before=JSON.parse(fs.readFileSync(startFile));const after={...Object.fromEntries(['package.json','package-lock.json','runtime.js','protocolCompatibility.js'].filter(f=>fs.existsSync(path.join(runtime,f))).map(f=>[f,hash(path.join(runtime,f))])),vendor:tree(path.join(runtime,'vendor'))};fs.writeFileSync(path.join(out,'source-end.json'),json(after)+'\n',{flag:'wx'});runtimeSourceUnchanged=json(before)===json(after);}
    fs.writeFileSync(path.join(out,'result.json'),json({runtimeSourceUnchanged,evidenceDomain:'DEVELOPMENT_CONTINUATION_ONLY',cleanEndToEndAcceptance:false,taskStatus:task?.status,step:task?.currentStepIndex,closed,stopRequested,death:death||deathCount>0,deathCount,error})+'\n',{flag:'wx'});}
});
