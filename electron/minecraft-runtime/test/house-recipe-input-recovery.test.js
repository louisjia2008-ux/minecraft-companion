/* global require, queueMicrotask, setTimeout */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const {Vec3}=require('vec3'),registry=require('prismarine-registry')('1.21.8');
const Block=require('prismarine-block')(registry),Item=require('prismarine-item')(registry);
const windows=require('prismarine-windows')('1.21.8');
const {createHouseSelfSupplyRuntime}=require('../vendor/server/minecraft/houseSelfSupplyRuntime');
const {createHouseMaterialRecipes}=require('../vendor/server/minecraft/houseMaterialRecipes');
const point=p=>`${p.x},${p.y},${p.z}`;
const camp={x:0,y:64,z:0},table={x:2,y:64,z:0},chest={x:-4,y:64,z:0};
const house={x:40,y:64,z:40},bounds=[{minX:38,maxX:48,minY:61,maxY:73,minZ:36,maxZ:57}];

// Original recipe coordinator, source factory, owned-storage controller and
// Mineflayer inventory/window primitives. A separate offline server state
// accepts emitted clicks and supplies authoritative reopen/slot packets.
// Raw acquisition and crafting are explicitly modeled registry transactions;
// there is no Java, fluid provider, native crafting-window or motion proof.
function fixture(options={}){
 const contexts=new AsyncLocalStorage(),bot=new EventEmitter(),client=new EventEmitter();
 const serverPlayer=Array(46).fill(null),serverChest=Array(27).fill(null),calls=[],writes=[];
 let nextWindow=1,source,rawCompleted=false,cancelled=false,foreign=false;
 let checkpoint={schema:1,profile:'enchanting_library',houseAnchor:house,materialSource:'self_gathered',
  camp:{anchor:camp,stations:{crafting_table:table,furnace:{x:-2,y:64,z:0}},storageSites:[chest],logName:'oak_log',plankName:'oak_planks'},
  ownedStations:{crafting_table:{position:table,item:'crafting_table',confirmedPlaced:true}},
  storage:{schema:1,kind:'house_owned_storage',storageId:'offline-recipe-input-recovery',chests:[{position:chest,item:'chest',confirmedPlaced:true,
   emptyAuthorized:true,properties:{type:'single',facing:'north',waterlogged:false},stock:{}}],plannedSites:[chest],
   exclusionBounds:[...bounds,{minX:0,maxX:0,minY:63,maxY:66,minZ:0,maxZ:0},{minX:2,maxX:2,minY:63,maxY:66,minZ:0,maxZ:0}]} };
 const active=()=>{if(cancelled)throw Object.assign(new Error('paused recovery owner'),{code:'paused'});};
 const copyItem=i=>i?Item.fromNotch(Item.toNotch(i)):null;
 Object.assign(bot,{registry,version:'1.21.8',_client:client,QUICK_BAR_START:36,quickBarSlot:0,
  entity:{id:1,position:new Vec3(.5,64,.5),yaw:0,pitch:0},game:{gameMode:'survival'},
  supportFeature:name=>registry.supportFeature(name),lookAt:async()=>{},swingArm:()=>{},
  blockAt:p=>{
   if(rawCompleted&&options.unknownOnRecovery&&point(p)===point(chest))return null;
   const name=point(p)===point(chest)?'chest':point(p)===point(table)?'crafting_table':p.y<64?'grass_block':'air';
   const props=name==='chest'?{type:'single',facing:'north',waterlogged:false}:{};
   return Object.assign(Block.fromProperties(registry.blocksByName[name].id,props,0),{position:new Vec3(p.x,p.y,p.z)});
  }});
 const updatePlayer=slot=>client.emit('set_slot',{windowId:0,stateId:0,slot,item:Item.toNotch(serverPlayer[slot])});
 client.write=(name,data)=>{
  writes.push({name,data,owned:contexts.getStore()===source&&!foreign,rawCompleted});
  if(name==='window_click'&&bot.currentWindow?.id===data.windowId){
   const window=bot.currentWindow;
   if(!(rawCompleted&&options.rejectRecoveryClicks))for(const changed of data.changedSlots||[]){
    const value=Item.fromNotch(changed.item);
    if(changed.location<window.inventoryStart)serverChest[changed.location]=copyItem(value);
    else serverPlayer[changed.location-(window.inventoryStart-9)]=copyItem(value);
    client.emit('set_slot',{windowId:window.id,stateId:0,slot:changed.location,item:Item.toNotch(value)});
   }
  }
  if(name==='close_window'&&bot.currentWindow?.id===data.windowId)queueMicrotask(()=>{
   for(let slot=9;slot<45;slot++)updatePlayer(slot);
  });
 };
 require('mineflayer/lib/plugins/inventory')(bot,{hideErrors:true});
 require('mineflayer/lib/plugins/craft')(bot);
 const count=name=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);
 const give=(name,n)=>{
  while(n){const id=registry.itemsByName[name].id,stack=registry.itemsByName[name].stackSize;
   let slot=serverPlayer.findIndex((i,index)=>index>=9&&index<45&&i?.type===id&&i.count<stack);
   if(slot<0)slot=serverPlayer.findIndex((i,index)=>index>=9&&index<45&&!i);
   assert.ok(slot>=9);const amount=Math.min(n,stack-(serverPlayer[slot]?.count||0));
   if(serverPlayer[slot])serverPlayer[slot].count+=amount;else serverPlayer[slot]=new Item(id,amount);
   n-=amount;updatePlayer(slot);
  }
 };
 for(const [name,n]of Object.entries(options.inventory||{book:1,diamond:2}))give(name,n);
 const open=async block=>{
  active();calls.push({kind:'open',rawCompleted,position:point(block.position)});
  if(rawCompleted&&options.pauseOnRecoveryOpen){cancelled=true;active();}
  if(rawCompleted&&options.foreignOnRecoveryOpen)foreign=true;
  const window=windows.createWindow(nextWindow++,'minecraft:generic_9x3','Explicit offline owned chest');
  for(let slot=0;slot<27;slot++)window.updateSlot(slot,copyItem(serverChest[slot]));
  for(let slot=9;slot<45;slot++)window.updateSlot(slot+18,copyItem(serverPlayer[slot]));
  bot.currentWindow=window;const native=bot.openBlock(block);
  queueMicrotask(()=>bot.emit('windowOpen',window));return native;
 };
 const craft=async(recipe,repeats,context)=>{
  active();const inputs=Object.fromEntries(recipe.delta.filter(d=>d.count<0).map(d=>[registry.items[d.id].name,-d.count*repeats]));
  const missing=Object.entries(inputs).filter(([name,n])=>count(name)<n);
  calls.push({kind:'craft',item:context.item,inputs,before:Object.fromEntries(Object.keys(inputs).map(n=>[n,count(n)]))});
  if(missing.length)throw Object.assign(new Error('offline craft lacks earlier sibling input'),{code:'OFFLINE_MISSING_RECIPE_INPUT',missing:Object.fromEntries(missing)});
  for(const delta of recipe.delta)if(delta.count<0){let left=-delta.count*repeats;
   for(let slot=9;slot<45&&left;slot++)if(serverPlayer[slot]?.type===delta.id){const n=Math.min(left,serverPlayer[slot].count);
    left-=n;serverPlayer[slot].count-=n;if(!serverPlayer[slot].count)serverPlayer[slot]=null;updatePlayer(slot);}
  }
  for(const delta of recipe.delta)if(delta.count>0)give(registry.items[delta.id].name,delta.count*repeats);
 };
 const acquire=async(name,n,context)=>{
  active();calls.push({kind:'raw',name,n,requirements:{...context.requirements}});
  if(name==='obsidian'){
   await source.stash({...context.requirements,[name]:context.targetCount,stick:16});
   if(options.consumeBooksForShelf){
    // Explicit intervening legitimate recipe transaction for the partial-stock
    // case; it is not a claim about real fluid-provider tool requirements.
    await source.takeOwnedStock({book:3});await source.ensure({bookshelf:1});
   }
  }
  // Only this declared raw transaction models a provider result. The recovery
  // hook must withdraw real modeled-owned stock; it never grants ingredients.
  give(name,n);rawCompleted=true;
 };
 source=createHouseSelfSupplyRuntime({getBot:()=>bot,assertActive:active,getCheckpoint:()=>checkpoint,setCheckpoint:v=>{checkpoint=v;},
  isSourceContext:candidate=>contexts.getStore()===candidate&&!foreign,withContext:(runtime,_bounds,action)=>contexts.run(runtime,action),
  blockAt:p=>bot.blockAt(new Vec3(p.x,p.y,p.z)),returnCamp:async()=>active(),reach:async()=>active(),openContainer:open,
  acquireRaw:acquire,craftRecipe:craft},{profile:'enchanting_library',anchor:house},bounds);
 return{source,bot,client,calls,writes,count,checkpoint:()=>checkpoint,
  run:requirements=>source.withContext(()=>source.ensure(requirements)),
  legacy:()=>createHouseMaterialRecipes({registry,recipesAll:(...args)=>bot.recipesAll(...args),getItemCount:count,
   assertActive:active,acquireRaw:acquire,craftRecipe:craft,readbackMs:40,pollMs:5}),
  runContext:action=>source.withContext(action)};
}

test('absent recovery dependency retains the original sibling-stash counterexample',async()=>{
 const f=fixture(),legacy=f.legacy();
 await assert.rejects(f.runContext(()=>legacy.ensure({enchanting_table:1})),e=>e.code==='OFFLINE_MISSING_RECIPE_INPUT');
 assert.equal(f.count('book'),0);assert.equal(f.count('diamond'),0);assert.equal(f.count('obsidian'),4);
 assert.deepEqual(f.source.storage.getStock(),{book:1,diamond:2});
});

test('real generic source hook withdraws original selected recipe inputs before the readback snapshot',async()=>{
 const f=fixture();await f.run({enchanting_table:1});
 assert.equal(f.count('enchanting_table'),1);assert.equal(f.count('book'),0);assert.equal(f.count('diamond'),0);assert.equal(f.count('obsidian'),0);
 assert.equal(f.source.storage.getStock().book||0,0);assert.equal(f.source.storage.getStock().diamond||0,0);
 const craft=f.calls.find(c=>c.kind==='craft');assert.deepEqual(craft.inputs,{book:1,diamond:2,obsidian:4});assert.deepEqual(craft.before,craft.inputs);
 assert.equal(f.calls.filter(c=>c.kind==='raw').length,1,'owned ingredients must be withdrawn, never reacquired or granted');
 assert.ok(f.writes.some(w=>w.name==='window_click'&&w.rawCompleted));assert.ok(f.writes.filter(w=>w.name==='window_click').every(w=>w.owned));
 assert.equal(f.bot.currentWindow,null);assert.equal(f.checkpoint().storage.chests[0].pendingTransfer,null);
});

test('coexisting inputs take the source hook no-op path without window or raw operations',async()=>{
 const f=fixture({inventory:{book:1,diamond:2,obsidian:4}});await f.run({enchanting_table:1});
 assert.equal(f.count('enchanting_table'),1);assert.ok(f.calls.every(c=>c.kind==='craft'));
 assert.equal(f.writes.filter(w=>w.name==='window_click').length,0);
});

for(const mode of ['pauseOnRecoveryOpen','foreignOnRecoveryOpen','unknownOnRecovery','rejectRecoveryClicks'])test(`${mode} prevents crafting from unconfirmed recovered inputs`,async()=>{
 const f=fixture({[mode]:true});await assert.rejects(f.run({enchanting_table:1}));
 assert.equal(f.calls.filter(c=>c.kind==='craft').length,0);assert.equal(f.count('enchanting_table'),0);
});

test('source hook legitimately ensures a missing input without recursively re-entering for inputs already present',async()=>{
 const f=fixture({inventory:{book:3,diamond:2},consumeBooksForShelf:true});
 await f.run({enchanting_table:1});assert.equal(f.count('enchanting_table'),1);
 assert.equal(f.count('bookshelf'),1);assert.equal(f.source.storage.getStock().diamond||0,0);
 assert.equal(f.calls.filter(c=>c.kind==='raw'&&c.name==='diamond').length,0,'available diamonds must come from actual owned stock');
 assert.equal(f.calls.filter(c=>c.kind==='craft'&&c.item==='book').length,1,'missing book must use the original recipe chain exactly once');
 assert.ok(f.calls.some(c=>c.kind==='raw'&&c.name==='leather'));
 assert.ok(f.calls.some(c=>c.kind==='raw'&&c.name==='sugar_cane'));
});

function coordinator(overrides={}){
 const stock={oak_planks:4},calls=[];
 const deps={registry,recipesAll:require('prismarine-recipe')(registry).Recipe.find,getItemCount:n=>stock[n]||0,assertActive:()=>{},
  readbackMs:40,pollMs:5,acquireRaw:async(name,n)=>{calls.push({kind:'raw',name,n});stock[name]=(stock[name]||0)+n;},
  craftRecipe:async(recipe,repeats)=>{calls.push({kind:'craft'});for(const delta of recipe.delta){const name=registry.items[delta.id].name;stock[name]=(stock[name]||0)+delta.count*repeats;}},...overrides};
 return{stock,calls,api:createHouseMaterialRecipes(deps)};
}

test('hook input targets are the same native delta plus same-name outer requirements',async()=>{
 let observed;const f=coordinator({prepareCraftInputs:async(_recipe,ctx)=>{observed=ctx;}});
 f.stock.oak_planks=6;await f.api.ensure({crafting_table:1,oak_planks:2});
 assert.deepEqual(observed.inputs,{oak_planks:4});assert.deepEqual(observed.inputGoals,{oak_planks:6});
 assert.equal(f.stock.oak_planks,2);
});

test('hook cannot replace internal targets by mutating its context and false recovery cannot emit craft',async()=>{
 const f=coordinator({prepareCraftInputs:async(_recipe,ctx)=>{ctx.inputGoals.oak_planks=0;f.stock.oak_planks=0;}});
 await assert.rejects(f.api.ensure({crafting_table:1}),e=>e.code==='house_materials_no_progress');
 assert.equal(f.calls.filter(c=>c.kind==='craft').length,0);
});

test('recovery closes over the original operation budget rather than resetting it',async()=>{
 let first=true;const f=coordinator({limits:{maxOperations:2},prepareCraftInputs:async(_recipe,ctx)=>{
  if(first){first=false;f.stock.oak_planks=0;await ctx.ensureInputs();}
 }});
 await assert.rejects(f.api.ensure({crafting_table:1}),e=>e.code==='house_materials_operation_limit');
 assert.equal(f.calls.filter(c=>c.kind==='craft').length,0);
});

test('recovery retains the original ingredient dependency depth limit',async()=>{
 const f=coordinator({limits:{maxDepth:1},prepareCraftInputs:async(_recipe,ctx)=>ctx.ensureInputs()});
 await assert.rejects(f.api.ensure({chest:1}),e=>e.code==='house_materials_unsupported');
 assert.equal(f.calls.filter(c=>c.kind==='craft').length,0);
 const prior=coordinator({limits:{maxDepth:1}});
 await assert.rejects(prior.api.ensure({chest:1}),e=>e.code==='house_materials_unsupported');
 assert.equal(prior.calls.filter(c=>c.kind==='craft').length,0);
});

test('invalid summed input goals reject before recovery and preserve the existing finite requirement contract',async()=>{
 const f=coordinator({prepareCraftInputs:async()=>assert.fail('invalid targets must not enter recovery')});
 f.stock.oak_planks=4099;
 await assert.rejects(f.api.ensure({crafting_table:1,oak_planks:4096}),e=>e.code==='house_materials_invalid_budget');
 assert.equal(f.calls.length,0);
});

test('already coexisting summed targets above the recovery limit retain the old no-op behavior',async()=>{
 let invoked=0;const f=coordinator({prepareCraftInputs:async()=>{invoked++;}});f.stock.oak_planks=4100;
 await f.api.ensure({crafting_table:1,oak_planks:4096});
 assert.equal(invoked,1);assert.equal(f.stock.oak_planks,4096);assert.equal(f.stock.crafting_table,1);
 assert.equal(f.calls.filter(c=>c.kind==='raw').length,0);
});

test('hook remains inside the captured operation timeout and cannot craft after the owner abort',async()=>{
 let aborted=false,lateError;const f=coordinator({limits:{operationTimeoutMs:20},assertActive:()=>{
  if(aborted)throw Object.assign(new Error('aborted owner'),{code:'paused'});
 },onOperationTimeout:()=>{aborted=true;},prepareCraftInputs:async(_recipe,ctx)=>{
  await new Promise(resolve=>setTimeout(resolve,40));try{await ctx.ensureInputs();}catch(error){lateError=error;}
 }});
 await assert.rejects(f.api.ensure({crafting_table:1}),e=>e.code==='house_materials_operation_timeout');
 await new Promise(resolve=>setTimeout(resolve,50));assert.equal(lateError?.code,'paused');
 assert.equal(f.calls.filter(c=>c.kind==='craft').length,0);
});

test('mining lighting reuses already crafted owned torches before asking for new fuel or logs',{timeout:12000},async()=>{
 const f=fixture();await f.run({torch:54});
 await f.runContext(()=>f.source.stash({}));assert.equal(f.count('torch'),16);
 const before=f.calls.length;
 await f.runContext(()=>f.source.takeOwnedStock({torch:32,coal:4,charcoal:4,stick:4}));
 assert.equal(f.count('torch'),32);
 assert.equal(f.calls.slice(before).filter(c=>c.kind==='raw'||c.kind==='craft').length,0);
 assert.ok(f.checkpoint().storage.chests[0].stock.torch>=0);
});
