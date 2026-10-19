/* global require, process, setInterval, clearInterval, setTimeout, clearTimeout */
'use strict';
// Explicit offline server transactions plus original installed dig/pathfinder/
// Physics. Voxel and checkpoint setup is synthetic contract evidence. Every
// later actor position/velocity update comes only from PlayerState.apply.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8');
const Block=require('prismarine-block')(registry),Item=require('prismarine-item')(registry);
const {Physics,PlayerState}=require('prismarine-physics'),{pathfinder}=require('mineflayer-pathfinder');
const WorldSync=require('prismarine-world/src/worldsync');
const {createMinecraftTaskAgent}=require('../vendor/server/minecraftTaskAgent');
const {CancellationToken}=require('../vendor/server/minecraft/agentControl');
const {hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
const {getSurfaceGraphProtectedPositions}=require('../vendor/server/minecraft/houseSurfaceGraph');
const key=p=>`${p.x},${p.y},${p.z}`,clone=v=>JSON.parse(JSON.stringify(v));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const camp={x:0,y:64,z:0},entry={x:8,y:64,z:0},house={x:40,y:64,z:40};
function fixture(t,options={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deskpet-quarry-entry-engine-'));
 const env={MC_AGENT_LEARNING_PATH:path.join(dir,'learning.json'),MC_AGENT_DIAGNOSTICS_DIR:path.join(dir,'diagnostics'),MC_AGENT_DISCONNECT_TRACE_PATH:path.join(dir,'disconnect.jsonl')};
 const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 const cells=new Map(),drops=[],digs=[],moves=[],equips=[],packets=[],poses=[],crafts=[],attacks=[],createdAt=Date.now();let unknown=false,ticks=0,digDefending,digDefenseTimer;
 const client=new EventEmitter();client.state='play';client.socket={writable:true,destroyed:false};
 const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'QuarryEngineContract',_client:client,
  health:20,food:20,player:{ping:1},game:{dimension:'overworld',gameMode:'survival',minY:-64,height:384},entities:{},players:{},
  jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,supportFeature:n=>registry.supportFeature(n),
  controlState:Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(k=>[k,false])),
  entity:{id:1,position:new Vec3(.5,64,.5),velocity:new Vec3(0,-.0784000015258789,0),onGround:true,
   width:.6,height:1.8,eyeHeight:1.62,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,
   isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
 const slots=Array(46).fill(null);slots[36]=new Item(registry.itemsByName[options.nested||options.hardClearance?'wooden_pickaxe':'iron_pickaxe'].id,1);slots[37]=new Item(registry.itemsByName.stick.id,16);
 if(options.defender)bot.entities[22]={id:22,name:'zombie',type:'hostile',entityType:registry.entitiesByName.zombie.id,
  position:new Vec3(128,64,128),height:1.95,isValid:true};
 bot.attack=entity=>{attacks.push({position:clone(bot.entity.position),profile:bot.pathfinder.movements});
  client.write('use_entity',{target:entity.id,mouse:1});delete bot.entities[entity.id];bot.emit('entityGone',entity);}; // Explicit offline entity-death transaction, not vanilla damage proof.
 bot.inventory={slots,items:()=>slots.filter(Boolean),count:type=>slots.filter(i=>i?.type===type).reduce((n,i)=>n+i.count,0),emptySlotCount:()=>slots.slice(9,45).filter(i=>!i).length};
 bot.heldItem=slots[36];
 bot.blockAt=raw=>{const p=raw.floored();if(unknown&&p.x>=7)return null;
  const name=cells.get(key(p))??(p.y>=64?'air':p.y>=61?(!options.allSand&&(options.stableCamp||p.x>=4)?'sandstone':'sand'):'stone');
  return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});};
 bot.findBlocks=query=>{
  const origin=query.point||bot.entity.position,radius=query.maxDistance||16;
  const matches=b=>b&&(typeof query.matching==='function'?query.matching(b):(Array.isArray(query.matching)?query.matching:[query.matching]).includes(b.type));
  const found=new Map(),add=p=>{const b=bot.blockAt(p);if(matches(b)&&p.distanceTo(origin)<=radius)found.set(key(p),p);};
  for(const id of cells.keys())add(new Vec3(...id.split(',').map(Number)));
  const probe=bot.blockAt(new Vec3(Math.floor(origin.x),Math.min(60,Math.floor(origin.y)-1),Math.floor(origin.z)));
  if(probe?.name==='stone'&&matches(probe)){
   assert.ok(radius<=16,'explicit offline resource loaded scan has a finite sixteen-block envelope');
   const center=origin.floored();for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++)for(let dz=-radius;dz<=radius;dz++)if(Math.hypot(dx,dy,dz)<=radius)add(center.offset(dx,dy,dz));
  }
  return [...found.values()].sort((a,b)=>a.distanceTo(origin)-b.distanceTo(origin)).slice(0,query.count||1);
 };
 bot.findBlock=query=>{const p=bot.findBlocks({...query,count:1})[0];return p?bot.blockAt(p):null;};
 const world=new WorldSync(()=>null);world.getBlock=p=>bot.blockAt(p);bot.world=world;
 bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;};
 bot.lookAt=async target=>{const delta=target.minus(bot.entity.position.offset(0,1.62,0));await bot.look(Math.atan2(-delta.x,-delta.z),Math.atan2(delta.y,Math.hypot(delta.x,delta.z)));};
 bot.setControlState=(name,value)=>{bot.controlState[name]=value;};bot.clearControlStates=()=>{for(const n of Object.keys(bot.controlState))bot.controlState[n]=false;};
 bot.deactivateItem=()=>{};bot.swingArm=()=>client.write('arm_animation',{hand:0});bot.getEquipmentDestSlot=()=>5;
 bot.equip=async item=>{equips.push({name:item.name,position:clone(bot.entity.position)});bot.heldItem=item;client.write('held_item_slot',{slot:0});};
 bot.canSeeBlock=cell=>{const eye=bot.entity.position.offset(0,1.62,0),delta=cell.position.offset(.5,.5,.5).minus(eye),length=delta.norm(),hit=world.raycast(eye,delta.scaled(1/length),length+.01);return hit?.position?.equals(cell.position)===true;};
 bot._updateBlockState=(position)=>{const old=bot.blockAt(position);cells.set(key(position),'air');const fresh=bot.blockAt(position);bot.emit('blockUpdate',old,fresh);bot.emit(`blockUpdate:${position}`,old,fresh);};
 client.write=(name,packet)=>{packets.push({name,packet,elapsedMs:Date.now()-createdAt,heldItem:bot.heldItem?.name});
 if(options.interruptDig&&name==='block_dig'&&packet.status===0&&!digDefenseTimer){
  digDefenseTimer=setTimeout(()=>{bot.entities[22].position=bot.entity.position.offset(2,0,0);
   digDefending=agent.__testHandleSurvivalCritical('test_quarry_dig_defense');digDefending.catch(()=>{});},20);
 }
 if(name==='block_dig'&&packet.status===2){
  const block=bot.blockAt(packet.location);digs.push({name:block.name,position:clone(block.position),feet:clone(bot.entity.position)});
  const item=registry.items[registry.blocksByName[block.name].drops[0]].name;
  drops.push({name:item,position:block.position.offset(.5,.2,.5)});
 }};
 require('mineflayer/lib/plugins/digging')(bot);
 require('mineflayer/lib/plugins/craft')(bot);
 // Crafting is an explicit offline server transaction with the original native
 // registry recipe/delta, real existing input slots and production readback.
 // This does not claim original native inventory-window or live-server proof.
 bot.craft=async(recipe,count,table)=>{
  assert.equal(count,1);assert.equal(table?.name,'crafting_table');assert.equal(hasGroundedBodySupport(bot),true);
  assert.ok(bot.entity.position.floored().equals(new Vec3(camp.x,camp.y,camp.z)));
  for(const delta of recipe.delta)if(delta.count<0)assert.ok(bot.inventory.count(delta.id)>=-delta.count);
  client.write('window_click',{windowId:0,slot:0});
  for(const delta of recipe.delta){let left=Math.abs(delta.count);if(delta.count<0){
   for(let i=0;i<slots.length&&left;i++)if(slots[i]?.type===delta.id){const n=Math.min(left,slots[i].count);slots[i].count-=n;left-=n;if(!slots[i].count)slots[i]=null;}
  }else if(delta.count>0){const old=slots.find(i=>i?.type===delta.id);if(old)old.count+=left;else slots[slots.findIndex((i,index)=>index>=9&&index<45&&!i)]=new Item(delta.id,left);}}
  crafts.push({name:registry.items[recipe.result.id].name,position:clone(bot.entity.position),delta:clone(recipe.delta)});bot.emit('inventoryUpdate');
 };
 if(options.nested){cells.set('8,63,0','iron_ore');cells.set('8,64,2','iron_ore');cells.set('-2,64,0','crafting_table');}
 if(options.hardClearance)cells.set('9,63,0','diamond_ore');
 bot.physics=Physics(registry,world);pathfinder(bot);
 const nativeGoto=bot.pathfinder.goto.bind(bot.pathfinder);
 bot.pathfinder.goto=goal=>{moves.push({x:goal.x,y:goal.y,z:goal.z});return nativeGoto(goal);};
 const timer=setInterval(()=>{
  bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),world).apply(bot);ticks++;poses.push({...clone(bot.entity.position),onGround:bot.entity.onGround});
  for(let i=drops.length-1;i>=0;i--){const drop=drops[i],p=bot.entity.position;
   if(Math.abs(drop.position.x-p.x)<=1.3&&Math.abs(drop.position.z-p.z)<=1.3&&drop.position.y>=p.y-.5&&drop.position.y<=p.y+2.3){
    const old=slots.find(item=>item?.name===drop.name);if(old)old.count++;else slots[slots.findIndex((item,index)=>index>=9&&index<45&&!item)]=new Item(registry.itemsByName[drop.name].id,1);
    bot.emit('inventoryUpdate');drops.splice(i,1);
   }
  }
  bot.emit('physicsTick');
 },5);
 const agent=createMinecraftTaskAgent({appPaths:{appDataDir:dir},readConfig:()=>({mcExecutorMode:'strict-executor',mcAgentAutoReconnect:false}),
  parseJsonObjectFromText:JSON.parse,broadcast:()=>{},broadcastMinecraftError:()=>{},allowAutonomousMaintenance:()=>false,requestPlannerCompletion:async()=>{throw Error('no provider in offline factory contract');}});
 agent.attachBot(bot);agent.initializeBotRuntime();
 const nodes={[key(camp)]:{position:camp,parent:null,expanded:true},[key(entry)]:{position:entry,parent:key(camp),expanded:true}};
 const graph={schema:2,kind:'loaded_dry_waypoint_graph',anchor:camp,radius:384,step:16,nodes,order:[key(camp),key(entry)],current:key(camp),resumeNode:key(entry),visits:2,probes:0,frontier:[],blockedEdges:[]};
 const task={taskId:'quarry-engine-entry',status:'running',source:'deskpet',intent:'build_furnished_house',logs:[],startedAt:Date.now(),currentStep:'build_furnished_house_phase',currentStepIndex:0,executionGeneration:0,cancellationToken:new CancellationToken(),plan:{steps:[{skill:'build_furnished_house_phase',args:{phase:'prepare_materials',profile:'cottage'}}]},
  materialSupply:{schema:1,profile:'cottage',houseAnchor:house,materialSource:'self_gathered',camp:{anchor:camp,stations:{crafting_table:{x:-2,y:64,z:0},furnace:{x:-2,y:64,z:2}},storageSites:[]},ownedStations:options.nested?{crafting_table:{item:'crafting_table',position:{x:-2,y:64,z:0},confirmedPlaced:true}}:{},
   storage:{schema:1,kind:'house_owned_storage',storageId:'explicit-offline-storage',chests:[]},activeSurfaceGraph:'any_log',surfaceGraphs:options.noGraph?{}:{any_log:graph}}};
 task.movementLease=agent.__testClaimMovementLease('task',task.taskId);agent.__testSetReconnectTask(task);
 t.after(()=>{if(options.nested)t.diagnostic(JSON.stringify({scope:'offline final native actor before teardown',elapsedMs:Date.now()-createdAt,
  position:bot.entity.position,velocity:bot.entity.velocity,onGround:bot.entity.onGround,controls:bot.controlState,goal:bot.pathfinder.goal,
  heldItem:bot.heldItem?.name,targetDig:bot.targetDigBlock?.name,progress:task.progressText,inventory:bot.inventory.items().map(i=>({name:i.name,count:i.count})),
  diggingPackets:packets.filter(p=>p.name==='block_dig').slice(-6),quarry:task.materialSupply.quarry}));
  clearInterval(timer);clearTimeout(digDefenseTimer);bot.stopDigging();agent.__testSetReconnectTask(null);agent.detachBot('manual_disconnect');agent.dispose();for(const k of Object.keys(env)){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}fs.rmSync(dir,{recursive:true,force:true});});
 return{agent,bot,task,cells,moves,digs,equips,packets,poses,crafts,attacks,digDefense:()=>digDefending,ticks:()=>ticks,setUnknown:()=>{unknown=true;},run:(amount,name='cobblestone')=>agent.__testHouseQuarryRaw(name,amount,{anchor:house}),takeover:()=>agent.__testClaimMovementLease('manual','foreign-entry-owner')};
}

test('production factory physically supplies sand camp from observed stable entry and returns with natural dig transactions',{timeout:20000},async t=>{
 const f=fixture(t),before=clone(f.task.materialSupply.surfaceGraphs.any_log.order);
 await f.run(2);
 assert.deepEqual(f.task.materialSupply.camp.anchor,camp);assert.deepEqual(f.task.materialSupply.quarry.anchor,entry);
 assert.equal(f.task.materialSupply.quarryEntry.routeKind,'observed_graph_node');assert.equal(f.task.materialSupply.quarryEntry.status,'selected');
 assert.deepEqual(f.task.materialSupply.surfaceGraphs.any_log.order,before);assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits,2);
 assert.equal(f.task.materialSupply.surfaceGraphs.any_log.current,key(camp));assert.equal(f.task.materialSupply.surfaceGraphs.any_log.resumeNode,key(entry));
 assert.ok(f.bot.inventory.items().filter(i=>i.name==='cobblestone').reduce((n,i)=>n+i.count,0)>=2);
 assert.ok(f.digs.some(d=>d.position.y<63));assert.ok(f.poses.some(p=>p.y<64));assert.ok(f.moves.some(m=>m.x===0&&m.y===64),'Native return reaches camp after mining; an initial already-at-camp position needs no extra goto');
 assert.ok(f.equips.some(e=>Math.floor(e.position.x)===entry.x&&e.position.y===entry.y),'existing usable tool equips at actual entry without unnecessary camp trip');
 assert.ok(f.bot.entity.position.floored().equals(new Vec3(camp.x,camp.y,camp.z)));assert.equal(hasGroundedBodySupport(f.bot),true);
 assert.equal(f.task.materialSupply.observedResources?.any_log,undefined,'entry travel must not query resources');
});

test('production same stable camp remains compatible without creating a surface graph',{timeout:10000},async t=>{
 const f=fixture(t,{stableCamp:true,noGraph:true});await f.run(1);
 assert.equal(f.task.materialSupply.quarryEntry.routeKind,'same_camp');assert.deepEqual(f.task.materialSupply.quarry.anchor,camp);
 assert.deepEqual(f.task.materialSupply.surfaceGraphs,{});assert.equal(hasGroundedBodySupport(f.bot),true);
});

test('sand camp without a prior graph discovers a native arrived stable entry before any mining',{timeout:30000},async t=>{
 const f=fixture(t,{noGraph:true});
 const originalCamp=clone(f.task.materialSupply.camp.anchor);
 await f.run(2);
 const graph=f.task.materialSupply.surfaceGraphs.any_log,selected=f.task.materialSupply.quarryEntry;
 assert.deepEqual(f.task.materialSupply.camp.anchor,originalCamp);
 assert.equal(selected.routeKind,'observed_graph_node');
 assert.ok(graph.visits>1);assert.ok(graph.order.includes(key(selected.position)));
 assert.ok(selected.position.x>=4,'Entry came from a stable native sandstone/stone column');
 assert.ok(f.poses.some(p=>Math.floor(p.x)===selected.position.x&&Math.floor(p.z)===selected.position.z&&p.onGround));
 assert.ok(f.digs.length>0);
 assert.ok(f.digs.every(d=>d.feet.x>=4),'No mining from the sand camp is authorized');
 assert.ok(f.bot.inventory.items().filter(i=>i.name==='cobblestone').reduce((n,i)=>n+i.count,0)>=2);
 assert.ok(f.bot.entity.position.floored().equals(new Vec3(camp.x,camp.y,camp.z)));
 assert.equal(hasGroundedBodySupport(f.bot),true);
});

for(const action of ['pause','cancel'])test(`entry discovery ${action} before arrival cannot grant mining or leave late native goals`,{timeout:7000},async t=>{
 const f=fixture(t,{noGraph:true});
 const pending=f.run(1).then(value=>({value}),error=>({error}));
 const until=Date.now()+3000;
 while(!f.moves.length&&Date.now()<until)await sleep(5);
 assert.ok(f.moves.length>0,'Discovery really submitted its first native movement');
 await f.agent.handleMessage({type:`mc_command_${action}`});
 assert.ok((await pending).error);
 assert.equal(f.digs.length,0);assert.equal(f.task.materialSupply.quarry,undefined);
 assert.equal(f.task.materialSupply.quarryEntry,undefined);
 const moves=f.moves.length;await sleep(100);assert.equal(f.moves.length,moves);
 assert.equal(f.bot.pathfinder.goal,null);
});

test('a loaded all-sand region ends entry discovery after eight actual native advances without mining',{timeout:60000},async t=>{
 const f=fixture(t,{noGraph:true,allSand:true});
 await assert.rejects(f.run(1),e=>e.code==='house_quarry_entry_pending');
 const graph=f.task.materialSupply.surfaceGraphs.any_log;
 assert.equal(graph.order.length,9,'One actual camp root plus eight genuinely reached exploration nodes');
 assert.ok(f.poses.some(p=>Math.abs(p.x)>.5||Math.abs(p.z)>.5));
 assert.equal(f.digs.length,0);assert.equal(f.task.materialSupply.quarry,undefined);
 assert.equal(f.task.materialSupply.quarryEntry,undefined);
 const moves=f.moves.length;await sleep(100);assert.equal(f.moves.length,moves);
});

test('entry discovery retains its original deadline and native profile through its captured defense',{timeout:30000},async t=>{
 const f=fixture(t,{noGraph:true,defender:true});let triggered=false,defending,triggerTimer;
 t.after(()=>clearTimeout(triggerTimer));
 f.bot.on('goal_updated',goal=>{
  if(!goal||triggered)return;triggered=true;
  triggerTimer=setTimeout(()=>{
   f.bot.entities[22].position=f.bot.entity.position.offset(2,0,0); // Independent offline NPC observation, never actor coordinates.
   defending=f.agent.__testHandleSurvivalCritical('test_entry_discovery_defense');defending.catch(()=>{});
  },20);
 });
 await f.run(1);await defending;
 assert.equal(f.attacks.length,1);assert.equal(f.bot.entities[22],undefined);
 assert.equal(f.attacks[0].profile.canDig,false);assert.equal(f.attacks[0].profile.allowParkour,false);
 assert.equal(f.task.materialSupply.quarryEntry.routeKind,'observed_graph_node');
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.ok(f.bot.entity.position.floored().equals(new Vec3(camp.x,camp.y,camp.z)));
});

test('production quarry shares protection for the actual discovered surface return trail',{timeout:30000},async t=>{
 const f=fixture(t,{noGraph:true});let protectedFloor;
 f.bot.on('physicsTick',()=>{
  const p=f.bot.entity.position;
  if(protectedFloor||!f.bot.entity.onGround||p.x<4||Math.abs(p.y-64)>.001||p.x-Math.floor(p.x)<.35)return;
  protectedFloor={x:Math.floor(p.x),y:63,z:Math.floor(p.z)};
  // Observe an actual native contact, not a guessed neighbor of a planned goal.
  f.cells.set(key(protectedFloor),'stone');
 });
 await f.run(2);
 assert.ok(protectedFloor);
 assert.ok(getSurfaceGraphProtectedPositions(f.task.materialSupply.surfaceGraphs.any_log).some(p=>key(p)===key(protectedFloor)));
 assert.equal(f.cells.get(key(protectedFloor)),'stone');
 assert.ok(f.digs.every(d=>key(d.position)!==key(protectedFloor)));
 assert.ok(f.digs.length>0);
 assert.ok(f.bot.inventory.items().filter(i=>i.name==='cobblestone').reduce((n,i)=>n+i.count,0)>=2);
 assert.ok(f.bot.entity.position.floored().equals(new Vec3(camp.x,camp.y,camp.z)));
 assert.equal(hasGroundedBodySupport(f.bot),true);
});

test('a quarry native dig interrupted by its own defense resumes fresh checked extraction without chasing or wall digging',{timeout:20000},async t=>{
 const f=fixture(t,{stableCamp:true,noGraph:true,defender:true,interruptDig:true});
 await f.run(2);await f.digDefense();
 assert.equal(f.attacks.length,1);assert.equal(f.bot.entities[22],undefined);
 assert.equal(f.attacks[0].profile.canDig,false);assert.equal(f.attacks[0].profile.allowParkour,false);
 assert.equal(f.attacks[0].profile.scafoldingBlocks.length,0);
 assert.ok(f.bot.inventory.items().filter(i=>i.name==='cobblestone').reduce((n,i)=>n+i.count,0)>=2);
 assert.ok(f.bot.entity.position.floored().equals(new Vec3(camp.x,camp.y,camp.z)));
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.ok(f.packets.some(p=>p.name==='block_dig'&&p.packet.status===1),'Original native dig actually stopped');
});

for(const kind of ['unknown','paused','foreign'])test(`production ${kind} entry cannot start movement or digging from saved coordinates`,{timeout:5000},async t=>{
 const f=fixture(t);if(kind==='unknown')f.setUnknown();if(kind==='paused')f.task.cancellationToken.pause();if(kind==='foreign')f.takeover();
 const before=f.moves.length;await assert.rejects(f.run(1));assert.equal(f.moves.length,before);assert.equal(f.digs.length,0);
 assert.equal(f.task.materialSupply.quarry,undefined);
});

test('actual camp pose cannot rewrite a stale remote graph current to authorize entry travel',async t=>{
 const f=fixture(t);f.task.materialSupply.surfaceGraphs.any_log.current=key(entry);
 const before=clone(f.task.materialSupply.surfaceGraphs.any_log),moves=f.moves.length;
 await assert.rejects(f.run(1),e=>e.code==='house_surface_dry_graph_rejoin_unconfirmed');
 assert.equal(f.digs.length,0);assert.equal(f.moves.length,moves);assert.deepEqual(f.task.materialSupply.surfaceGraphs.any_log,before);
});

test('preparation-only wooden tool does not authorize a real higher-tier clearance block',{timeout:15000},async t=>{
 const f=fixture(t,{hardClearance:true});
 assert.equal(Boolean(f.bot.blockAt(new Vec3(9,63,0)).canHarvest(registry.itemsByName.wooden_pickaxe.id)),false);
 const running=f.run(1).then(value=>({value}),error=>({error})),deadline=Date.now()+10000;
 const supplyRequest=/正在自行准备 (?:[a-z_]+_pickaxe|crafting_table|[a-z_]+_planks)|自动采集 [a-z_]+_log/;
 while(!supplyRequest.test(f.task.progressText||'')&&Date.now()<deadline)await sleep(5);
 assert.match(f.task.progressText,supplyRequest,'actual forbidden face must request legitimate tool supplies rather than start digging');
 await f.agent.handleMessage({type:'mc_command_pause'});
 const outcome=await running;assert.ok(outcome.error);
 assert.equal(f.digs.filter(d=>d.name==='diamond_ore').length,0);
 assert.ok(!f.bot.inventory.items().some(i=>i.name==='diamond'));
 assert.ok(f.packets.every(p=>p.name!=='block_dig'||p.packet.location.x!==9||p.packet.location.y!==63||p.packet.location.z!==0),'native start/finish must never bypass actual canHarvest');
});

test('production tool crafting nests real cobblestone quarry before iron harvest and retains both actual routes',{timeout:90000},async t=>{
 const f=fixture(t,{nested:true});
 const diagnostic=setTimeout(()=>t.diagnostic(JSON.stringify({scope:'offline nested contract progress sample at twelve seconds',progress:f.task.progressText,
  inventory:f.bot.inventory.items().map(i=>({name:i.name,count:i.count})),digs:f.digs,moves:f.moves.slice(-6),crafts:f.crafts,quarry:f.task.materialSupply.quarry})),12000);
 try{await f.run(1,'raw_iron');}finally{clearTimeout(diagnostic);}
 const supply=f.task.materialSupply;
 assert.deepEqual(supply.camp.anchor,camp);assert.deepEqual(supply.quarry.anchor,entry);
 assert.ok(supply.quarry.routes.cobblestone?.navigation?.breadcrumbs?.length>1);
 assert.ok(supply.quarry.routes.raw_iron?.navigation?.breadcrumbs?.length);
 assert.equal(supply.quarry.routes.cobblestone.navigation.routeIndex,0);assert.equal(supply.quarry.routes.raw_iron.navigation.routeIndex,0);
 assert.ok(f.digs.some(d=>d.name==='stone'));assert.ok(f.digs.some(d=>d.name==='iron_ore'));
 assert.ok(f.crafts.some(c=>c.name==='stone_pickaxe'&&Math.floor(c.position.x)===camp.x));
 assert.ok(f.bot.inventory.items().some(i=>i.name==='raw_iron'&&i.count>=1));
 assert.ok(f.bot.entity.position.floored().equals(new Vec3(camp.x,camp.y,camp.z)));assert.equal(hasGroundedBodySupport(f.bot),true);
 assert.equal(supply.surfaceGraphs.any_log.visits,2);assert.deepEqual(supply.surfaceGraphs.any_log.order,[key(camp),key(entry)]);
});
