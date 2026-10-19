/* global process, __dirname, setTimeout, clearTimeout */
'use strict';
// Same-world post-construction verifier. Never starts/stops a server or uses
// game commands. Requires a completed checkpoint in the explicitly named saved development world.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRequire}=require('node:module'),{once}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const base=path.resolve(__dirname,'..'),runtimeRoot=path.resolve(base,'../personal-ai-deskpet-electron-work/electron/minecraft-runtime');
const argv=process.argv.slice(2),runName=argv[1],worldName=argv[3];
assert.deepEqual(argv,['--run-name',runName,'--world',worldName]);
for(const value of [runName,worldName])assert.match(value||'',/^[A-Za-z0-9_-]+$/);
const world=path.join(base,'worlds',worldName),original=JSON.parse(fs.readFileSync(path.join(world,'development-checkpoint.json'))).task;
assert.ok(fs.existsSync(path.join(world,'development-origin.json')),'Explicit saved development lineage required');
const materialReceiptFile=path.join(world,'verified-material-receipt-20261017.json');
const materialReceipt=JSON.parse(fs.readFileSync(materialReceiptFile));
assert.equal(materialReceipt.domain,'READONLY_EXACT_PRIOR_RECEIPT_RECONCILIATION');assert.equal(materialReceipt.world,worldName);
assert.ok(materialReceipt.proof.length>0&&materialReceipt.proof.every(p=>p.exactMatch===true));
for(const receipt of materialReceipt.provenance)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(receipt.file)).digest('hex'),receipt.sha256);
original.materialSupply=cloneMaterial(materialReceipt.materialSupply);
function cloneMaterial(value){return JSON.parse(JSON.stringify(value));}

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
async function runFurnitureUse(original, blueprint) {
  const useTask=ownedTask(`${runName}-native-use`), capturedBot=bot;
  useTask.materialSupply=clone(original.materialSupply);
  useTask.stepCheckpoint=clone(original.stepCheckpoint||{});
  const f=blueprint.furniture, use={profile,source:'self_gathered',checks:{},materialSupply:null};
  const at=p=>bot.blockAt(new Vec3(p.x,p.y,p.z));
  const count=name=>counts(inventory())[name]||0;
  const active=()=>{useTask.cancellationToken.throwIfRequested();assert.equal(bot,capturedBot);assert.equal(agent.__testGetReconnectTask(),useTask);assert.equal(agent.__testGetActiveMovementLease(),useTask.movementLease);if(abortError)throw abortError;if(deaths||disconnected)throw typed('NATIVE_VERIFICATION_INTERRUPTED','Death or disconnect during native verification');};
  let naturalCropOnly=false;
  const guarded=(operation,extra=()=>{})=>withHouseNativeSourceGuard(bot,{assertActive:()=>{active();if(naturalCropOnly&&bot.heldItem?.name==='bone_meal')throw typed('NATURAL_FARM_BONE_MEAL_FORBIDDEN','No bone meal interaction is authorized in natural crop verification');extra();},isOwnerContext:()=>nativeOwner.getStore()===useTask},operation);
  async function ready(){
    const until=Date.now()+45000;
    while(agent.__testGetActiveMovementLease()!==useTask.movementLease){
      if(abortError||deaths||disconnected)throw abortError||typed('NATIVE_VERIFICATION_INTERRUPTED','Interrupted');
      const lease=agent.__testGetActiveMovementLease();
      if(agent.__testGetReconnectTask()!==useTask||lease?.kind!=='survival-critical'||Date.now()>=until)
        {record('native_owner_not_restored',{lease,expected:useTask.movementLease,currentTask:agent.__testGetReconnectTask()?.taskId,status:useTask.status});throw typed('NATIVE_VERIFICATION_OWNER_NOT_RESTORED','Survival handoff did not return original owner');}
      await Promise.race([sleep(50),signalPromise,failurePromise]);
    }
    active();
  }
  async function waitActual(predicate,label,ms=10000){const end=Date.now()+ms;for(;;){active();if(predicate())return;if(Date.now()>=end)throw typed('NATIVE_READBACK_TIMEOUT',label);await Promise.race([sleep(50),signalPromise,failurePromise]);}}
  async function native(operation,label,ms=15000,guard=()=>{}){await ready();active();let open=true,timer;const pending=guarded(operation,()=>{if(!open)throw typed('NATIVE_OPERATION_CLOSED','Late write after closed native operation');guard();});try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{open=false;const e=typed('NATIVE_OPERATION_TIMEOUT',label);useTask.cancellationToken.pause();requestAbort(e);reject(e);},ms);}),signalPromise]);}finally{open=false;clearTimeout(timer);}}
  async function attempt(name,operation){
    await ready();let entry;
    try{const evidence=await operation();await ready();active();if(evidence?.confirmed!==true)throw typed('NATIVE_VERIFICATION_UNCONFIRMED',name);entry={stage:name,status:'PASS',required:true,evidence};}
    catch(error){record('native_attempt_error',{name,code:error.code,message:error.message,stack:error.stack,lease:agent.__testGetActiveMovementLease(),expected:useTask.movementLease});if(abortError||deaths||disconnected||useTask.cancellationToken.cancelled||useTask.cancellationToken.pauseRequested)throw error;
      await ready();active();entry={stage:name,status:/pending|unsupported|not_observed|not_implemented|insufficient_levels|unavailable/i.test(error.code||'')?'PENDING':'FAIL',required:true,code:error.code||'NATIVE_VERIFICATION_FAILED',message:error.message};
      if(bot.currentWindow)await native(()=>bot.closeWindow(bot.currentWindow),'Close owned failed verification window',5000).catch(()=>{});
      if(agent.__testGetActiveMovementLease()===useTask.movementLease){bot.pathfinder.setGoal(null);bot.clearControlStates();}
    }
    stages.push(entry);use.checks[name]=entry;record('native_verification_stage',entry);return entry;
  }
  async function supply(requirements,label){active();if(Object.entries(requirements).every(([name,n])=>count(name)>=n)){record('native_verification_carried_inputs_confirmed',{label,requirements,actual:inventory()});return;}record('native_verification_self_supply',{label,requirements,anchor:blueprint.anchor,profile});await native(()=>agent.__testHouseSelfSupply(requirements,{anchor:blueprint.anchor,profile}),`Native verification self supply ${label}`,maximumMs);active();}
  async function maintainFood(){
    active();if(bot.health<16)throw typed('NATIVE_VERIFICATION_LOW_HEALTH','Natural verification stopped below16 health');
    if(bot.food>=14)return;
    const safe=['cooked_beef','cooked_porkchop','cooked_mutton','cooked_rabbit','cooked_chicken','bread','apple','carrot','rabbit','beef','porkchop','mutton'];
    const item=bot.inventory.items().find(i=>safe.includes(i.name));if(!item)throw typed('NATURAL_VERIFICATION_FOOD_PENDING','No already self-obtained food during natural wait');
    const foodBefore=bot.food,stock=count(item.name),from=events.length;
    await native(()=>bot.equip(item,'hand'),'Equip own natural food');await native(()=>bot.consume(),'Consume own natural food');
    await waitActual(()=>bot.food>foodBefore&&count(item.name)<stock&&events.slice(from).some(e=>e.type==='self_entity_status'&&e.status===9),'Actual natural food replenishment');
    record('natural_verification_food_confirmed',{item:item.name,foodBefore,foodAfter:bot.food,stockBefore:stock,stockAfter:count(item.name)});
  }
  async function walk(point,range=0.85){
    active();await native(()=>agent.__testReturnHouseConstruction(point),'Observed return to house waypoint',180000);const goal=new goals.GoalBlock(Math.floor(point.x),Math.floor(point.y),Math.floor(point.z));
    await native(()=>bot.pathfinder.goto(goal),'Native permanent waypoint',20000);
    await waitActual(()=>bot.entity.onGround===true&&agent.__testFurnishedHouseStandingSafely(bot.entity.position),'Native waypoint grounded',2500);
    assert.ok(Math.hypot(bot.entity.position.x-point.x-0.5,bot.entity.position.z-point.z-0.5)<=range&&Math.abs(bot.entity.position.y-point.y)<=1.1,'Native waypoint actual endpoint');
    return {target:point,actual:position(bot.entity.position),onGround:bot.entity.onGround};
  }
  async function approach(point){await ready();active();await native(()=>agent.__testReturnHouseConstruction(point),'Observed return to furniture',180000);await native(()=>bot.pathfinder.goto(new goals.GoalNear(point.x,point.y,point.z,2)),'Native furniture approach',20000);await bot.waitForTicks(3);active();assert.equal(bot.entity.onGround,true);assert.ok(agent.__testFurnishedHouseStandingSafely(bot.entity.position));}
  const doors=f.doors||[f.door];
  async function setDoor(door,open,guard=()=>{}){
    active();guard();for(const p of [door.lower,door.upper])assert.equal(at(p)?.name,'oak_door');
    if(at(door.lower).getProperties().open!==open)await native(()=>bot.activateBlock(at(door.lower)),'Native door activation',8000,guard);
    await waitActual(()=>[door.lower,door.upper].every(p=>at(p)?.getProperties().open===open),'Door two-half state');
  }
  async function freshWindow(p,method,label){
    await approach(p);const from=events.length,w=await native(()=>bot[method](at(p)),label);
    await waitActual(()=>events.slice(from).some(e=>e.type==='server_window_inventory'&&e.windowId===w.id),'Fresh authoritative window_items',5000);
    const packet=events.slice(from).filter(e=>e.type==='server_window_inventory'&&e.windowId===w.id).at(-1),decoded=packet.items.map(i=>Item.fromNotch(i));
    const toCounts=items=>counts(items.filter(Boolean).map(i=>({name:i.name,count:i.count})));
    return {window:w,rawPlayer:toCounts(decoded.slice(w.inventoryStart,w.inventoryEnd)),rawContainer:toCounts(decoded.slice(0,w.inventoryStart)),rawWindowId:w.id};
  }
  async function rawPlayerSnapshot(){const read=await freshWindow(f.chest,'openContainer','Own chest authoritative player snapshot');await native(()=>read.window.close(),'Snapshot window close');return read.rawPlayer;}
  const openDoors=async()=>{for(const door of doors){await approach(door.lower);await setDoor(door,true);}};
  async function waitNaturalNight(){const end=Date.now()+naturalNightMs;while(!(bot.time.timeOfDay>=12542&&bot.time.timeOfDay<=23460)){active();await maintainFood();if(Date.now()>=end)throw typed('NATURAL_NIGHT_NOT_OBSERVED','No natural night within finite wait');await Promise.race([sleep(500),signalPromise,failurePromise]);}}
  function bookshelfEvidence(){const table=f.enchantingTable;const cells=(f.bookshelves||[]).map(p=>{const dx=p.x-table.x,dz=p.z-table.z,gap={x:table.x+Math.trunc(dx/2),y:table.y,z:table.z+Math.trunc(dz/2)};return {position:p,actual:at(p)?.name,gap,clear:air(at(gap))&&air(at({...gap,y:gap.y+1}))};});return {confirmed:cells.filter(c=>c.actual==='bookshelf'&&c.clear).length>=15,effectiveCount:cells.filter(c=>c.actual==='bookshelf'&&c.clear).length,cells};}
  await nativeOwner.run(useTask,()=>agent.__testWithHouseResourceWork(()=>agent.__testWithFurnishedHouseMovements(async()=>{
    await attempt('native_house_repair_and_equipment',async()=>{
      await native(()=>agent.__testExecuteBuildFurnishedHousePhase({args:{profile,anchor:blueprint.anchor,phase:'verify'}}),'Original-world native repair and field cleanup',600000);
      return {confirmed:useTask.stepCheckpoint.furnishedHouse.verificationSummary?.missingBlocks===0,verification:clone(useTask.stepCheckpoint.furnishedHouse.verificationSummary)};
    });
    await attempt('native_permanent_routes',async()=>{await openDoors();const routes=blueprint.routes||[{id:'entrance_and_furniture',waypoints:[blueprint.entrance.outside,blueprint.entrance.inside]}];const traversed=[];for(const route of routes){const points=[];for(const p of route.waypoints)points.push(await walk(p));traversed.push({id:route.id,points});}return {confirmed:traversed.length===routes.length,traversed};});
    await attempt('native_3x3_craft',async()=>{
      await supply({oak_planks:4,stick:2},'3x3-crafting');await openDoors();const before=await rawPlayerSnapshot();await approach(f.craftingTable);
      const recipe=bot.recipesFor(bot.registry.itemsByName.wooden_pickaxe.id,null,1,at(f.craftingTable)).find(r=>r.requiresTable);assert.ok(recipe);
      await native(()=>bot.craft(recipe,1,at(f.craftingTable)),'Native3x3 crafting',25000);const after=await rawPlayerSnapshot();
      assert.equal(after.wooden_pickaxe,(before.wooden_pickaxe||0)+1);assert.equal(after.oak_planks||0,(before.oak_planks||0)-3);assert.equal(after.stick||0,(before.stick||0)-2);
      return {confirmed:true,before,after,requiresTable:true,inventoryProof:'Actual fresh server window_items before and after native crafting'};
    });
    await attempt('native_all_chests_roundtrip',async()=>{
      await supply({oak_planks:1},'own-chest-marker');await openDoors();const results=[];
      for(const p of f.chests||[f.chest]){let read=await freshWindow(p,'openContainer','Native chest authoritative baseline');let w=read.window;const before=read.rawPlayer.oak_planks||0,old=read.rawContainer.oak_planks||0;assert.ok(before>=1);
        await native(()=>w.deposit(bot.registry.itemsByName.oak_planks.id,null,1),'Native own marker deposit');await native(()=>w.close(),'Chest close');
        read=await freshWindow(p,'openContainer','Fresh chest deposit readback');w=read.window;const deposited=read.rawContainer.oak_planks||0;assert.equal(deposited,old+1);assert.equal(read.rawPlayer.oak_planks||0,before-1);
        await native(()=>w.withdraw(bot.registry.itemsByName.oak_planks.id,null,1),'Native own marker withdraw');await native(()=>w.close(),'Chest close');
        read=await freshWindow(p,'openContainer','Fresh chest withdrawal readback');w=read.window;const after=read.rawContainer.oak_planks||0;assert.equal(after,old);assert.equal(read.rawPlayer.oak_planks||0,before);await native(()=>w.close(),'Chest close');
        results.push({position:p,beforePlayer:before,afterPlayer:read.rawPlayer.oak_planks||0,old,deposited,finalStock:after,proof:'Fresh raw server window_items on all three opens'});
      }return {confirmed:results.length===(f.chests||[f.chest]).length,results};
    });
    await attempt('native_all_furnaces_smelt',async()=>{
      const furnaces=f.furnaces||[f.furnace];await supply({sand:furnaces.length,oak_planks:furnaces.length},'all-native-furnace-inputs');await openDoors();const results=[];
      for(const p of furnaces){let read=await freshWindow(p,'openFurnace','Native furnace authoritative baseline'),w=read.window;const before=read.rawPlayer;assert.equal(w.inputItem(),null);assert.equal(w.outputItem(),null);
        await native(()=>w.putInput(bot.registry.itemsByName.sand.id,null,1),'Native sand input');await native(()=>w.putFuel(bot.registry.itemsByName.oak_planks.id,null,1),'Native own fuel');
        await waitActual(()=>w.outputItem()?.name==='glass','Actual vanilla smelting',30000);const output={name:w.outputItem().name,count:w.outputItem().count};await native(()=>w.takeOutput(),'Native output extraction');await native(()=>w.close(),'Furnace close');
        read=await freshWindow(p,'openFurnace','Fresh furnace output/player readback');w=read.window;const after=read.rawPlayer;assert.equal(w.outputItem(),null);assert.equal(after.glass,(before.glass||0)+1);assert.equal(after.sand||0,before.sand-1);assert.equal(after.oak_planks||0,before.oak_planks-1);await native(()=>w.close(),'Furnace close');results.push({position:p,before,after,output,proof:'Fresh raw server player inventory after native output extraction'});
      }return {confirmed:results.length===furnaces.length,results};
    });
    await attempt('native_all_beds_sleep_wake',async()=>{
      await openDoors();const results=[];
      for(const bed of f.beds||[f.bed]){await waitNaturalNight();await approach(bed.foot);const from=events.length;await native(()=>bot.sleep(at(bed.foot)),'Native natural-night sleep',8000);await waitActual(()=>bot.isSleeping===true&&events.slice(from).some(e=>e.type==='native_sleep'),'Native bed sleeping',3000);
        const occupied=[bed.foot,bed.head].map(p=>({position:p,name:at(p)?.name,properties:at(p)?.getProperties()}));assert.ok(occupied.some(b=>b.properties.occupied===true));
        await native(()=>bot.wake(),'Native bed wake',8000);await waitActual(()=>bot.isSleeping===false&&events.slice(from).some(e=>e.type==='native_wake'),'Native real wake',8000);results.push({bed,occupied,timeOfDay:bot.time.timeOfDay,woke:true});
      }return {confirmed:results.length===(f.beds||[f.bed]).length,results};
    });
    if(enchanting){
      await attempt('fifteen_effective_bookshelves',async()=>bookshelfEvidence());
      await attempt('natural_xp_and_native_level30_enchantment',async()=>{
        if((bot.experience?.level||0)<30)throw typed('NATURAL_XP_PROVIDER_PENDING','No integrated natural XP30 provider; real observed level remains below30');
        const privateModule='/private/tmp/deskpet-house-natural-enchant.cjs';if(!fs.existsSync(privateModule))throw typed('NATIVE_ENCHANT_ADAPTER_PENDING','Private strictly native enchant verifier unavailable');
        const {createHouseNaturalEnchant}=require(privateModule);let xpCP=null;
        const tableSpec=blueprint.blocks.find(s=>s.item==='enchanting_table'&&key(s.position)===key(f.enchantingTable));
        const owned=!!tableSpec&&(stateFor(original)?.ownedBlockIds||[]).includes(tableSpec.id);
        const candidate=createHouseNaturalEnchant({getBot:()=>bot,assertActive:active,isOwnerContext:()=>nativeOwner.getStore()===useTask,getCP:()=>xpCP,saveCP:v=>{active();xpCP=clone(v);record('natural_xp_verification_checkpoint',{checkpoint:xpCP});},onOperationTimeout:error=>{useTask.cancellationToken.pause();requestAbort(error);},
          returncamp:async camp=>{await openDoors();await walk(camp);},reach:async p=>{await openDoors();await approach(p);},ownedEnchantmentTable:async()=>({confirmedOwned:owned,position:f.enchantingTable}),
          ensureMaterials:async options=>{if(options.stage!=='enchant30')return {pending:true,reason:'Active natural XP acquisition not implemented'};try{await supply(options.requirements,'natural-level30-enchant-inputs');return {confirmed:true};}catch(e){if(/unsupported|pending/.test(e.code||''))return {pending:true,reason:e.message};throw e;}}});
        const camp=original.materialSupply?.camp?.anchor;assert.ok(camp&&['x','y','z'].every(axis=>Number.isSafeInteger(camp[axis])),'Actual self-owned camp anchor required');const before=clone(bot.experience);await candidate.ensureLevels(30,{anchor:camp});const result=await candidate.enchant30({anchor:camp,itemName:'wooden_pickaxe',table:f.enchantingTable});active();return {confirmed:result.confirmed===true,before,after:clone(bot.experience),native:result,provenance:'Actual raw experience updates; no XP setup or arithmetic substitution'};
      });
    }
    if(isEstate){
      await attempt('natural_age7_harvest_pickup_replant_and_seed_reserve',async()=>{
        await supply({wheat_seeds:2},'self-obtained-replant-reserve');await openDoors();const spec={schema:1,id:`${profile}:${key(blueprint.anchor)}:farms`,plots:blueprint.farms};
        const end=Date.now()+naturalGrowthMs,targets=[];
        for(const plot of blueprint.farms){await walk(plot.access[0]);let chosen;while(!chosen){active();await maintainFood();chosen=plot.crops.find(c=>at(c.position)?.name==='wheat'&&Number(at(c.position).getProperties().age)===7);if(chosen)break;if(Date.now()>=end)throw typed('NATURAL_CROP_MATURITY_NOT_OBSERVED','No naturally age7 crop in every plot within budget');await Promise.race([sleep(1000),signalPromise,failurePromise]);}targets.push(chosen.position);record('natural_crop_age7_observed',{plot:plot.id,position:chosen.position,properties:at(chosen.position).getProperties()});}
        if(targets.some(p=>Number(at(p)?.getProperties().age)!==7))throw typed('NATURAL_CROP_MATURITY_NOT_OBSERVED','A selected crop changed before harvest');
        const reserve=()=>count('wheat_seeds')+(useTask.materialSupply?.storage?.chests||[]).reduce((n,c)=>n+(c.stock?.wheat_seeds||0),0);
        const beforeReserve=reserve(),from=events.length;let summary;naturalCropOnly=true;try{summary=await native(()=>agent.__testEstateFarm(spec,{postPublicTask:true,allowBoneMeal:true,targets}),'Natural native harvest/replant',180000);}finally{naturalCropOnly=false;}active();
        const afterReserve=reserve();assert.equal(summary.validationVerified,true);assert.equal(summary.boneMealUsed,0);assert.equal(summary.cycles.length,2);assert.ok(summary.cycles.every(c=>c.ageMature===7&&c.ageAfterReplant===0&&c.seedConsumedForReplant===1&&c.wheatCollected>=1&&c.boneMealUsed===0));
        const forbidden=events.slice(from).filter(e=>e.type==='native_outbound'&&['use_item','block_place'].includes(e.name)&&e.heldItem?.name==='bone_meal');assert.equal(forbidden.length,0);
        if(afterReserve<beforeReserve)throw typed('FARM_RENEWABILITY_NOT_DEMONSTRATED',`Observed seed reserve decreased ${beforeReserve}->${afterReserve}; no supplementary seed added within cycle`);
        return {confirmed:true,targets,summary,beforeReserve,afterReserve,netSeedReserve:afterReserve-beforeReserve,sampleCount:summary.cycles.length,boneMealPackets:forbidden.length,limits:'Finite observed cycles only; no claim of guaranteed infinite renewability'};
      });
    }
    if(profile==='riverside_villa')await attempt('actual_natural_riverside_and_dock_out_and_back',async()=>{
      const dock=blueprint.blocks.filter(s=>s.component==='villa_dock'&&s.item==='oak_planks'),biomes=dock.map(s=>{const b=at({...s.position,y:s.position.y-1});return {position:s.position,block:b?.name,biome:typeof b?.biome==='string'?b.biome:b?.biome?.name||bot.registry.biomes[b?.biome]?.name||null};});
      if(!biomes.some(b=>/river/.test(b.biome||'')))throw typed('NATURAL_RIVERSIDE_BIOME_PENDING','Loaded world has not established a natural river biome; water alone is insufficient');
      const route=blueprint.routes.find(r=>r.id==='dock_access');assert.ok(route);const points=[];for(const p of [...route.waypoints,...route.waypoints.slice().reverse()]){points.push(await walk(p));assert.notEqual(bot.entity.isInWater,true);assert.notEqual(bot.entity.isInLava,true);}return {confirmed:true,biomes,points};
    });
    await attempt('native_final_door_closure_and_exit',async()=>{
      const plan=isEstate?planEstateDoorClosure(blueprint):[{door:f.door,side:'outside',approach:blueprint.entrance.outside,escapePurpose:'leave_public_house'}],closed=[];
      for(const step of plan){await walk(step.approach,0.85);const [dx,dz]={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]}[step.door.facing];
        const side=()=>{active();const p=bot.entity.position,n=(p.x-step.door.lower.x-0.5)*dx+(p.z-step.door.lower.z-0.5)*dz;assert.equal(bot.entity.onGround,true);assert.ok(step.side==='outside'?n>0.35:n< -0.35);};
        await setDoor(step.door,false,side);closed.push(step);
      }await walk(blueprint.entrance.outside);return {confirmed:doors.every(d=>[d.lower,d.upper].every(p=>at(p)?.getProperties().open===false)),closed,actualExit:position(bot.entity.position)};
    });
  })));
  use.materialSupply=clone(useTask.materialSupply);use.finalInventory=inventory();use.finalPosition=position(bot.entity.position);use.experience=clone(bot.experience);
  const expected=['native_house_repair_and_equipment','native_permanent_routes','native_3x3_craft','native_all_chests_roundtrip','native_all_furnaces_smelt','native_all_beds_sleep_wake','native_final_door_closure_and_exit',...(enchanting?['fifteen_effective_bookshelves','natural_xp_and_native_level30_enchantment']:[]),...(isEstate?['natural_age7_harvest_pickup_replant_and_seed_reserve']:[]),...(profile==='riverside_villa'?['actual_natural_riverside_and_dock_out_and_back']:[])];use.requiredStages=expected;use.confirmed=expected.length>0&&expected.every(name=>use.checks[name]?.status==='PASS');return use;
}


async function main(){
 const before=fingerprint(),settings=JSON.parse(fs.readFileSync(path.join(base,'installation.json')));
 const props=fs.readFileSync(path.join(world,'server.properties'),'utf8'),port=Number(props.match(/^server-port=(\d+)$/m)?.[1]);assert.ok(Number.isSafeInteger(port)&&port>1024&&port<65536,'Actual saved server port required');
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
 record('verified_material_receipt_used',{file:materialReceiptFile,sha256:crypto.createHash('sha256').update(fs.readFileSync(materialReceiptFile)).digest('hex'),proof:materialReceipt.proof});
 record('same_world_native_use_started',{originalStatus:original.status,sourceFingerprint:before,world:worldName,port,keepInventory:'NOT_INFERRED_FROM_CLIENT',limits:'Saved development continuation only; previous strict final result retained; not clean empty-inventory E2E'});
 const use=await runFurnitureUse(original,blueprint);assert.deepEqual(fingerprint(),before,'Runtime changed during verification');
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({schema:1,domain:'SAVED_DEVELOPMENT_WORLD_POST_USE_ONLY',world:worldName,port,confirmed:use.confirmed,deaths,stages,use,sourceFingerprint:before},null,2)+'\n',{flag:'wx'});
 if(!use.confirmed)process.exitCode=1;
}
main().catch(e=>{fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({code:e.code,message:e.message,stack:e.stack,deaths,stages},null,2)+'\n',{flag:'wx'});console.error(e.stack);process.exitCode=1;}).finally(async()=>{await runtimeTicks?.stop();try{agent?.__testSetReconnectTask(null);agent?.detachBot('manual_disconnect');agent?.dispose();bot?.quit('Same-world post-use finished; server retained');}catch(e){console.error(e.message);}});
