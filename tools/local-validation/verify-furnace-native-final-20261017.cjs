'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{once}=require('events'),{createRequire}=require('module');
const base=path.resolve(__dirname,'..'),runtime=path.resolve(base,'../personal-ai-deskpet-electron-work/electron/minecraft-runtime'),world=path.join(base,'worlds/natural-cottage-combat-20261017-new03'),out=path.join(world,'native-post-use/actual-furnace-standalone-20261017-08');
assert.ok(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
const req=createRequire(runtime+'/package.json'),mineflayer=req('mineflayer'),{pathfinder,Movements,goals}=req('mineflayer-pathfinder'),{Vec3}=req('vec3'),Item=req('prismarine-item')('1.21.8');
const {withMinecraftProtocolCompatibility,installMinecraftBedWakeCompatibility}=req('./protocolCompatibility'),{acknowledgePlayerLoaded}=req('./runtime'),{hasGroundedBodySupport}=req('./vendor/server/minecraft/houseSurfaceGraph');
const original=JSON.parse(fs.readFileSync(path.join(world,'development-checkpoint.json'))).task;assert.equal(original.status,'completed');
const blueprint=req('./vendor/server/minecraft/furnishedHouseBlueprints').createFurnishedHouseBlueprint(original.stepCheckpoint.furnishedHouse.anchor,{profile:'cottage'});
const settings=JSON.parse(fs.readFileSync(path.join(base,'installation.json'))),port=Number(fs.readFileSync(path.join(world,'server.properties'),'utf8').match(/^server-port=(\d+)$/m)[1]);
let bot,ended=false,deaths=0,guard,busy=false,lastAttack=0,raised=false,fault,serverFrames=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),counts=items=>items.filter(Boolean).reduce((a,i)=>(a[i.name]=(a[i.name]||0)+i.count,a),{}),inventory=()=>counts(bot.inventory.slots.filter(Boolean));
function record(type,data={}){fs.appendFileSync(path.join(out,'events.jsonl'),JSON.stringify({at:Date.now(),type,...data})+'\n');}
function active(){if(fault)throw fault;assert.ok(bot?.entity&&!ended&&deaths===0&&bot.health>0,'Actual player must remain alive and connected');}
async function wait(p,label,ms=10000){const end=Date.now()+ms;while(!p()){active();assert.ok(Date.now()<end,label);await sleep(50);}}
async function bounded(p,ms,label){let t;try{return await Promise.race([p,new Promise((_,r)=>t=setTimeout(()=>r(Error(label)),ms))]);}finally{clearTimeout(t);}}
async function go(goal,label){active();record('native_goal_started',{label,goalType:goal.constructor.name,goalPosition:{x:goal.pos?.x??goal.x,y:goal.pos?.y??goal.y,z:goal.pos?.z??goal.z},position:bot.entity.position});try{await bounded(bot.pathfinder.goto(goal),25000,label);}catch(e){record('native_goal_failed',{label,message:e.message,position:bot.entity.position,feet:bot.blockAt(bot.entity.position.floored())?.name,head:bot.blockAt(bot.entity.position.floored().offset(0,1,0))?.name});bot.pathfinder.setGoal(null);throw e;}await wait(()=>hasGroundedBodySupport(bot),'Actual dry supported endpoint',2000);}
async function gather(name,amount){
 if((inventory()[name]||0)>=amount)return;
 const candidates=bot.findBlocks({matching:b=>b?.name===name,maxDistance:192,count:24});record('loaded_input_candidates',{name,positions:candidates});let failure;
 for(const p of candidates){active();if((inventory()[name]||0)>=amount)return;
  try{
   await go(new goals.GoalLookAtBlock(p,bot.world,{reach:4.5}),'Native loaded input approach');active();
   assert.ok(!(p.y<Math.floor(bot.entity.position.y)&&Math.abs(p.x+.5-bot.entity.position.x)<.85&&Math.abs(p.z+.5-bot.entity.position.z)<.85),'Do not mine actual body support');
   const block=bot.blockAt(p);assert.equal(block.name,name);const before=inventory()[name]||0,tool=bot.pathfinder.bestHarvestTool(block);if(tool)await bot.equip(tool,'hand');
   raised=false;bot.deactivateItem();await bounded(bot.dig(block,true,'raycast'),10000,'Actual input digging');
   const end=Date.now()+5000;while((inventory()[name]||0)<=before&&Date.now()<end){active();const item=Object.values(bot.entities||{}).find(e=>e.name==='item'&&e.isValid!==false&&e.position?.distanceTo(bot.entity.position)<5&&e.getDroppedItem?.()?.name===name);if(item)await go(new goals.GoalNear(Math.floor(item.position.x),Math.floor(item.position.y),Math.floor(item.position.z),1),'Visible native input pickup');await sleep(150);}
   assert.ok((inventory()[name]||0)>before,'Actual positive input pickup');record('actual_self_gathered_input',{name,position:p,before,after:inventory()[name],granted:false});
  }catch(e){failure=e;record('input_candidate_failed',{name,position:p,message:e.message});}
 }
 assert.ok((inventory()[name]||0)>=amount,failure?.message||'No actually obtained input');
}
async function openFurnace(){
 const p=blueprint.furniture.furnace;await go(new goals.GoalLookAtBlock(new Vec3(p.x,p.y,p.z),bot.world,{reach:4}),'Native house furnace approach');
 const from=serverFrames.length,w=await bot.openFurnace(bot.blockAt(new Vec3(p.x,p.y,p.z)));await wait(()=>serverFrames.slice(from).some(f=>f.windowId===w.id),'Fresh authoritative furnace inventory');
 const packet=serverFrames.slice(from).filter(f=>f.windowId===w.id).at(-1),slots=packet.items.map(i=>Item.fromNotch(i));return {w,rawPlayer:counts(slots.slice(w.inventoryStart,w.inventoryEnd)),rawFurnace:counts(slots.slice(0,w.inventoryStart)),stateId:packet.stateId};
}
async function main(){
 bot=mineflayer.createBot(withMinecraftProtocolCompatibility({host:'127.0.0.1',port,username:'DeskPetSelfBuild',auth:'offline',respawn:false,version:settings.minecraft.version,hideErrors:false}));
 bot.on('death',()=>{deaths++;fault=Error('Actual verification death');record('death',{position:bot.entity.position});});bot.on('end',()=>ended=true);bot.on('error',e=>fault=e);
 bot._client.on('window_items',p=>{serverFrames.push(p);record('server_window_inventory',p);});bot._client.on('set_slot',p=>record('server_slot_ack',p));
 await bounded(once(bot,'spawn'),60000,'Spawn timeout');installMinecraftBedWakeCompatibility(bot);await acknowledgePlayerLoaded(bot);await bot.waitForChunksToLoad();assert.equal(bot.game.gameMode,'survival');
 bot.loadPlugin(pathfinder);const movement=new Movements(bot);movement.canDig=false;movement.allow1by1towers=false;movement.allowParkour=false;movement.maxDropDown=2;movement.scafoldingBlocks=[];movement.canOpenDoors=false;
 for(const name of ['water','lava','fire','soul_fire','magma_block','powder_snow','cactus','sweet_berry_bush']){const id=bot.registry.blocksByName[name]?.id;if(id!==undefined)movement.blocksToAvoid.add(id);}bot.pathfinder.setMovements(movement);bot.pathfinder.thinkTimeout=2000;bot.pathfinder.tickTimeout=20;bot.pathfinder.searchRadius=96;
 record('started',{domain:'INDEPENDENT_NATIVE_FURNACE_FUNCTION_ONLY',originalTaskStatus:original.status,position:bot.entity.position,inventory:inventory(),health:bot.health,food:bot.food});
 guard=setInterval(async()=>{if(busy||ended||deaths||fault)return;busy=true;try{const threat=Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position?.distanceTo(bot.entity.position)<7&&req('./vendor/server/minecraft/entitySemantics').isThreateningMobEntity(e,bot.registry)).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0];if(!threat)return;if(bot.currentWindow){fault=Error('Actual hostile interrupted furnace test');return;}await bot.lookAt(threat.position.offset(0,1,0),true);const weapon=bot.inventory.items().find(i=>i.name==='iron_sword');if(weapon&&threat.position.distanceTo(bot.entity.position)<3&&Date.now()-lastAttack>=700){bot.deactivateItem();raised=false;await bot.equip(weapon,'hand');bot.attack(threat);lastAttack=Date.now();record('native_contact_defense',{id:threat.id,name:threat.name});}if(bot.inventory.slots[45]?.name==='shield'&&!raised){bot.activateItem(true);raised=true;}}catch(e){fault=e;}finally{busy=false;}},100);
 await gather('sand',1);if((inventory().oak_planks||0)<1){await gather('oak_log',1);const recipe=bot.recipesFor(bot.registry.itemsByName.oak_planks.id,null,1,null)[0];assert.ok(recipe);await bot.craft(recipe,1,null);}
 const door=blueprint.furniture.door;await go(new goals.GoalBlock(blueprint.entrance.outside.x,blueprint.entrance.outside.y,blueprint.entrance.outside.z),'Native verified exterior entrance approach');if(!bot.blockAt(new Vec3(door.lower.x,door.lower.y,door.lower.z)).getProperties().open){await bot.activateBlock(bot.blockAt(new Vec3(door.lower.x,door.lower.y,door.lower.z)));await sleep(200);}
 let read=await openFurnace(),w=read.w,before=read.rawPlayer;assert.equal(w.inputItem(),null);assert.equal(w.outputItem(),null);assert.ok(before.sand>=1&&before.oak_planks>=1);
 await w.putInput(bot.registry.itemsByName.sand.id,null,1);await w.putFuel(bot.registry.itemsByName.oak_planks.id,null,1);await wait(()=>w.outputItem()?.name==='glass','Actual vanilla glass output',30000);const produced={name:w.outputItem().name,count:w.outputItem().count};await w.takeOutput();w.close();await sleep(200);
 read=await openFurnace();w=read.w;const after=read.rawPlayer;assert.equal(w.outputItem(),null);assert.equal(after.glass,(before.glass||0)+1);assert.equal(after.sand||0,before.sand-1);assert.equal(after.oak_planks||0,before.oak_planks-1);w.close();
 const result={schema:1,domain:'INDEPENDENT_NATIVE_FURNACE_FUNCTION_ONLY',world:'natural-cottage-combat-20261017-new03',confirmed:true,deaths,before,after,produced,position:bot.entity.position,health:bot.health,food:bot.food,proof:'Real native input/fuel/vanilla smelt/extraction; fresh raw server window_items player inventory before and after; no grants or state writes'};fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(e=>{fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({message:e.message,stack:e.stack,deaths},null,2));console.error(e.stack);process.exitCode=1;}).finally(async()=>{clearInterval(guard);while(busy)await sleep(10);try{bot?.pathfinder?.setGoal(null);bot?.clearControlStates();bot?.quit('Independent real furnace verification finished');}catch{}});
