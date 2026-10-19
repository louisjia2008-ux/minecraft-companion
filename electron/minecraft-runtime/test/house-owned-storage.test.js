/* global require, queueMicrotask */
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {AsyncLocalStorage}=require('node:async_hooks');
const {Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8');
const Block=require('prismarine-block')(registry);
const Item=require('prismarine-item')(registry);
const windows=require('prismarine-windows')('1.21.8');
const injectInventory=require('mineflayer/lib/plugins/inventory');
const {createHouseOwnedStorage}=require('../vendor/server/minecraft/houseOwnedStorage');
const key=p=>`${p.x},${p.y},${p.z}`;
const clone=value=>JSON.parse(JSON.stringify(value));
const protection=[{minX:0,maxX:10,minY:62,maxY:80,minZ:0,maxZ:10},{minX:20,maxX:20,minY:63,maxY:64,minZ:20,maxZ:20}];
const defaultSites=[{x:-5,y:64,z:0},{x:-7,y:64,z:0}];
const count=(items,name)=>items.filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);

// Native inventory open/close/deposit/withdraw and real prismarine window
// ranges. A separate simulated server state accepts only emitted packets;
// optimistic client acceptClick mutations never become server evidence alone.
function fixture(options={}){
  const contexts=new AsyncLocalStorage(),owner={taskId:'owned-storage'};
  const state={cancelled:false,checkpoint:null,cancelClicksAfter:options.cancelClicksAfter,clicks:0,serverCursor:null};
  const cells=new Map(),containers=new Map(),writes=[],saved=[],calls=[],serverPlayer=new Array(46).fill(null);
  const bot=new EventEmitter(),client=new EventEmitter();let nextWindow=1;
  const item=(name,n)=>n?new Item(registry.itemsByName[name].id,n):null;
  const itemCopy=i=>i?Item.fromNotch(Item.toNotch(i)):null;
  const active=()=>{if(state.cancelled)throw Object.assign(new Error('cancelled'),{code:'cancelled'});};
  const put=(p,name,props={})=>{const b=Block.fromProperties(registry.blocksByName[name].id,props,0);b.position=new Vec3(p.x,p.y,p.z);cells.set(key(p),b);return b;};
  Object.assign(bot,{registry,version:'1.21.8',_client:client,QUICK_BAR_START:36,entity:{id:1,position:new Vec3(-3.5,64,.5),yaw:0,pitch:0},game:{gameMode:'survival'},
    supportFeature:name=>registry.supportFeature(name),lookAt:async()=>{},swingArm:()=>{},
    blockAt:p=>cells.get(key(p))||Object.assign(Block.fromProperties(registry.blocksByName[p.y<64?'grass_block':'air'].id,{},0),{position:new Vec3(p.x,p.y,p.z)})});
  function serverSlot(window,slot,value){
    if(slot<window.inventoryStart)containers.get(window.storageKey)[slot]=itemCopy(value);
    else serverPlayer[slot-(window.inventoryStart-9)]=itemCopy(value);
    if(!options.noRawAck)client.emit('set_slot',{windowId:window.id,stateId:state.clicks,slot,item:Item.toNotch(value)});
  }
  const originalWrite=function(name,data){
    writes.push({name,data,self:this,context:contexts.getStore(),cancelled:state.cancelled});
    if(name==='window_click'&&bot.currentWindow?.id===data.windowId){
      const window=bot.currentWindow;
      if(!options.rejectClicks){for(const changed of data.changedSlots||[])serverSlot(window,changed.location,Item.fromNotch(changed.item));state.serverCursor=Item.fromNotch(data.cursorItem);}
      state.clicks+=1;
      if(state.cancelClicksAfter===state.clicks)state.cancelled=true;
    }
    if(name==='close_window'&&bot.currentWindow?.id===data.windowId){
      if(state.serverCursor){const slot=serverPlayer.findIndex((i,n)=>n>=9&&n<45&&!i);assert.ok(slot>=0);serverPlayer[slot]=itemCopy(state.serverCursor);state.serverCursor=null;}
      queueMicrotask(()=>{for(let slot=9;slot<45;slot+=1)client.emit('set_slot',{windowId:0,stateId:state.clicks,slot,item:Item.toNotch(serverPlayer[slot])});});
    }
    return 'native-write-result';
  };
  client.write=originalWrite;injectInventory(bot,{hideErrors:true});bot.quickBarSlot=0;
  function give(name,n){const stack=registry.itemsByName[name].stackSize||64;for(let remaining=n;remaining>0;){const slot=serverPlayer.findIndex((i,k)=>k>=9&&k<45&&!i);assert.ok(slot>=0);const amount=Math.min(stack,remaining);serverPlayer[slot]=item(name,amount);client.emit('set_slot',{windowId:0,stateId:0,slot,item:Item.toNotch(serverPlayer[slot])});remaining-=amount;}}
  for(const [name,n]of Object.entries(options.inventory||{oak_planks:100,iron_pickaxe:1,cooked_porkchop:8}))give(name,n);
  async function openContainer(block){
    calls.push({kind:'open',position:clone(block.position)});
    const storageKey=key(block.position);
    if(!containers.has(storageKey))containers.set(storageKey,new Array(27).fill(null));
    const window=windows.createWindow(nextWindow++,'minecraft:generic_9x3','Robot owned');window.storageKey=storageKey;
    for(let slot=0;slot<27;slot+=1)window.updateSlot(slot,itemCopy(containers.get(storageKey)[slot]));
    for(let slot=9;slot<45;slot+=1)window.updateSlot(slot+18,itemCopy(serverPlayer[slot]));
    bot.currentWindow=window;
    const native=bot.openBlock(block);
    queueMicrotask(()=>bot.emit('windowOpen',window));
    const result=await native;
    if(options.cancelOnOpen){state.cancelled=true;options.cancelOnOpen=false;}
    return result;
  }
  const deps={getBot:()=>bot,assertActive:active,isOwnerContext:()=>contexts.getStore()===owner,
    getCheckpoint:()=>state.checkpoint,setCheckpoint:(next,meta)=>{if(!meta?.confirmedFact)active();saved.push({next:clone(next),meta,cancelled:state.cancelled});state.checkpoint=clone(next);},report:()=>{},
    chooseSites:async()=>{calls.push({kind:'choose'});return clone(options.sites||defaultSites);},
    acquireChestItem:async()=>{active();calls.push({kind:'acquire'});give('chest',1);},
    placeNative:async(spec,confirmed)=>{active();calls.push({kind:'place',spec:clone(spec)});put(spec.position,'chest',spec.properties);containers.set(key(spec.position),new Array(27).fill(null));
      const source=serverPlayer.findIndex(i=>i?.name==='chest');serverPlayer[source]=null;client.emit('set_slot',{windowId:0,stateId:0,slot:source,item:{itemCount:0}});confirmed();
      if(options.cancelAfterPlace)state.cancelled=true;},reach:async p=>{active();calls.push({kind:'reach',position:clone(p)});},openContainer,timeoutMs:40};
  const api=()=>createHouseOwnedStorage(deps);
  const run=fn=>contexts.run(owner,fn);
  const ensure=storage=>run(()=>storage.ensure({exclusionBounds:protection}));
  return {bot,client,state,owner,contexts,cells,containers,writes,saved,calls,serverPlayer,give,put,originalWrite,deps,api,run,ensure,item};
}

test('missing owned chest is rebuilt empty with old stock archived and never credited twice',async()=>{
 const f=fixture(),storage=f.api();await f.ensure(storage);await f.run(()=>storage.stash({oak_planks:4,iron_pickaxe:Infinity,cooked_porkchop:Infinity}));
 const entry=f.state.checkpoint.chests[0];assert.equal(entry.stock.oak_planks,96);f.put(entry.position,'air');f.containers.delete(key(entry.position));
 await f.ensure(storage);assert.equal(storage.getStock().oak_planks||0,0);assert.equal(f.state.checkpoint.chests[0].emptyAuthorized,true);
 assert.equal(f.state.checkpoint.chests[0].replacements[0].previousStock.oak_planks,96);assert.equal(count(f.bot.inventory.items(),'oak_planks'),4);
 assert.equal(f.calls.filter(c=>c.kind==='place').length,2);
});
test('native placed empty single chest becomes owned; real window deposit and fresh reopen prove both inventories',async()=>{
  const f=fixture(),storage=f.api();await f.ensure(storage);
  assert.equal(f.calls.filter(c=>c.kind==='place').length,1);assert.equal(f.state.checkpoint.chests[0].emptyAuthorized,true);
  const result=await f.run(()=>storage.stash({oak_planks:4,iron_pickaxe:Infinity,cooked_porkchop:Infinity}));
  assert.equal(result.deposited,96);assert.equal(count(f.bot.inventory.items(),'oak_planks'),4);
  assert.equal(count(f.bot.inventory.items(),'iron_pickaxe'),1);assert.equal(count(f.bot.inventory.items(),'cooked_porkchop'),8);
  assert.equal(storage.getStock().oak_planks,96);
  assert.ok(f.calls.filter(c=>c.kind==='open').length>=3,'Transfer must be followed by a fresh server window read');
  assert.equal(f.bot.currentWindow,null);assert.equal(f.client.write,f.originalWrite);
  await f.run(()=>storage.withdraw({oak_planks:36}));
  assert.equal(count(f.bot.inventory.items(),'oak_planks'),36);assert.equal(storage.getStock().oak_planks,64);
  assert.equal(f.state.checkpoint.chests[0].pendingClosedInventory,null);
});

test('nearby player chest is never discovered or adopted; exact foreign candidate is rejected without acquire/place',async()=>{
  const f=fixture({sites:[defaultSites[0]]});f.put(defaultSites[0],'chest',{type:'single'});
  await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_foreign_block');
  assert.equal(f.calls.filter(c=>['open','acquire','place'].includes(c.kind)).length,0);
});

test('finite sites exclude building/camp and adjacency before any native action',async()=>{
  for(const sites of [[{x:20,y:64,z:20}],[{x:3,y:64,z:3}],[defaultSites[0],{...defaultSites[0],x:-6}],Array.from({length:9},(_,i)=>({x:-5-i*2,y:64,z:0}))]){
    const f=fixture({sites});await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_invalid_site');assert.equal(f.calls.filter(c=>c.kind==='place').length,0);
  }
  const f=fixture({sites:[defaultSites[0]]});f.put({...defaultSites[0],x:-6},'chest',{type:'single'});
  await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_adjacent_chest');
});

test('restored ownership tolerates slot reorder but rejects additions, depletion and changed native block',async()=>{
  const f=fixture(),storage=f.api();await f.ensure(storage);await f.run(()=>storage.stash({iron_pickaxe:Infinity,cooked_porkchop:Infinity}));
  const slots=f.containers.get(key(defaultSites[0]));[slots[0],slots[8]]=[slots[8],slots[0]];
  await f.ensure(f.api());
  slots[10]=f.item('diamond',1);await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_foreign_contents');
  assert.equal(f.state.checkpoint.chests[0].stock.diamond,undefined);slots[10]=null;
  const filled=slots.findIndex(i=>i?.name==='oak_planks');slots[filled].count-=1;
  await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_foreign_contents');slots[filled].count+=1;
  f.put(defaultSites[0],'furnace');await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_changed');
});

test('cancel after native placement records only ownership facts and resumes empty authorization without placing again',async()=>{
  const f=fixture({cancelAfterPlace:true}),storage=f.api();
  await assert.rejects(f.ensure(storage),error=>error.code==='cancelled');
  assert.equal(f.state.checkpoint.chests.length,1);assert.equal(f.state.checkpoint.chests[0].emptyAuthorized,false);
  assert.equal(f.calls.filter(c=>c.kind==='open').length,0);
  assert.ok(f.saved.some(s=>s.meta?.confirmedFact&&s.next.chests.length===1));
  f.state.cancelled=false;await f.ensure(f.api());
  assert.equal(f.calls.filter(c=>c.kind==='place').length,1);assert.equal(f.state.checkpoint.chests[0].emptyAuthorized,true);
});

test('unverified newly placed chest cannot authorize foreign contents on resume',async()=>{
  const f=fixture({cancelAfterPlace:true});await assert.rejects(f.ensure(f.api()),/cancelled/);
  f.state.cancelled=false;f.containers.get(key(defaultSites[0]))[0]=f.item('diamond',1);
  await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_foreign_contents');
  assert.equal(f.state.checkpoint.chests[0].emptyAuthorized,false);
});

test('installed click cancellation blocks the second native write and never records its optimistic client deposit',async()=>{
  const f=fixture({inventory:{oak_planks:64},cancelClicksAfter:1}),storage=f.api();await f.ensure(storage);
  const baselineSlots=f.client.listenerCount('set_slot'),baselineItems=f.client.listenerCount('window_items');
  await assert.rejects(f.run(()=>storage.stash({})),error=>error.code==='cancelled');
  assert.equal(f.writes.filter(w=>w.name==='window_click').length,1);
  assert.equal(f.state.checkpoint.chests[0].stock.oak_planks,undefined,'Optimistic acceptClick must not become confirmed stock');
  assert.equal(f.containers.get(key(defaultSites[0])).filter(Boolean).length,0);
  assert.equal(f.client.write,f.originalWrite);assert.equal(f.client.listenerCount('set_slot'),baselineSlots);assert.equal(f.client.listenerCount('window_items'),baselineItems);
  // The task controller, not the paused warehouse, closes its interrupted UI.
  f.bot.currentWindow.close();f.state.cancelled=false;await f.ensure(f.api());
  assert.equal(count(f.bot.inventory.items(),'oak_planks'),64);assert.equal(f.state.checkpoint.chests[0].pendingTransfer,null);
});

test('cancel immediately after server-confirmed deposit reconciles captured stock fact without another click or close',async()=>{
  const f=fixture({inventory:{oak_planks:64},cancelClicksAfter:2}),storage=f.api();await f.ensure(storage);
  const beforeClose=f.writes.filter(w=>w.name==='close_window').length;
  await assert.rejects(f.run(()=>storage.stash({})),error=>error.code==='cancelled');
  assert.equal(f.state.checkpoint.chests[0].stock.oak_planks,64);
  assert.equal(f.writes.filter(w=>w.name==='window_click').length,2);assert.equal(f.writes.filter(w=>w.name==='close_window').length,beforeClose);
  assert.ok(f.saved.some(s=>s.cancelled&&s.meta?.confirmedFact&&s.next.chests[0]?.stock.oak_planks===64));
  f.bot.currentWindow.close();f.state.cancelled=false;await f.ensure(f.api());
  assert.equal(f.state.checkpoint.chests[0].pendingTransfer,null);assert.equal(f.state.checkpoint.chests[0].pendingClosedInventory,null);
});

test('fresh reopen catches rejected server clicks despite optimistic successful native transfer',async()=>{
  const f=fixture({inventory:{oak_planks:8},rejectClicks:true,noRawAck:true}),storage=f.api();await f.ensure(storage);
  await assert.rejects(f.run(()=>storage.stash({})),error=>error.code==='house_storage_transfer_unconfirmed');
  assert.equal(storage.getStock().oak_planks,undefined);assert.equal(count(f.bot.inventory.items(),'oak_planks'),8);
  assert.equal(f.containers.get(key(defaultSites[0])).filter(Boolean).length,0);
});

test('withdraw missing stock and full player inventory fail explicitly without repeated clicks',async()=>{
  const f=fixture(),storage=f.api();await f.ensure(storage);
  await assert.rejects(f.run(()=>storage.withdraw({diamond:1})),error=>error.code==='house_storage_missing');
  await f.run(()=>storage.stash({iron_pickaxe:Infinity,cooked_porkchop:Infinity}));
  while(f.bot.inventory.emptySlotCount()>0)f.give('stone',64);
  const before=f.writes.filter(w=>w.name==='window_click').length;
  await assert.rejects(f.run(()=>storage.withdraw({oak_planks:64})),error=>error.code==='house_storage_inventory_full');
  assert.equal(f.writes.filter(w=>w.name==='window_click').length,before);
});

test('finite full warehouse reports storage full and never loops or overwrites a foreign box',async()=>{
  const f=fixture({sites:[defaultSites[0]],inventory:{oak_planks:64}}),storage=f.api();await f.ensure(storage);
  const slots=f.containers.get(key(defaultSites[0]));for(let i=0;i<27;i+=1)slots[i]=f.item('stone',64);
  f.state.checkpoint.chests[0].stock={stone:1728};
  await assert.rejects(f.run(()=>storage.stash({})),error=>error.code==='house_storage_full');
  assert.equal(f.calls.filter(c=>c.kind==='place').length,1);assert.equal(f.writes.filter(w=>w.name==='window_click').length,0);
});

test('a full owned chest expands only to the next finite non-adjacent native placed empty chest',async()=>{
  const f=fixture({inventory:{oak_planks:64}}),storage=f.api();await f.ensure(storage);
  const slots=f.containers.get(key(defaultSites[0]));for(let i=0;i<27;i+=1)slots[i]=f.item('stone',64);
  f.state.checkpoint.chests[0].stock={stone:1728};
  await f.run(()=>storage.stash({}));
  assert.equal(f.calls.filter(c=>c.kind==='place').length,2);assert.equal(f.state.checkpoint.chests.length,2);
  assert.equal(f.state.checkpoint.chests[0].stock.stone,1728);assert.equal(f.state.checkpoint.chests[1].stock.oak_planks,64);
  assert.deepEqual(f.state.checkpoint.chests.map(e=>e.position),defaultSites);
});

test('foreign chest appearing during material acquisition or native complete-skip never becomes ownership',async()=>{
  const f=fixture({sites:[defaultSites[0]]}),nativeAcquire=f.deps.acquireChestItem;
  f.deps.acquireChestItem=async()=>{await nativeAcquire();f.put(defaultSites[0],'chest',{type:'single',facing:'north'});};
  await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_foreign_block');assert.equal(f.state.checkpoint.chests.length,0);
  const g=fixture({sites:[defaultSites[0]]});
  g.deps.placeNative=async spec=>{g.put(spec.position,'chest',spec.properties);};
  await assert.rejects(g.ensure(g.api()),error=>error.code==='house_storage_placement_unconfirmed');
  assert.equal(g.state.checkpoint.chests.length,0,'Seeing a chest without the native confirmation callback is not ownership');
});

test('foreign-window packets and later writer replacement stay intact; completed guard retained by another actor is inert',async()=>{
  const f=fixture({inventory:{oak_planks:16}}),storage=f.api(),open=f.deps.openContainer;
  let replacement,payload;
  f.deps.openContainer=async block=>{
    const window=await open(block),deposit=window.deposit;
    window.deposit=async(...args)=>{
      payload={windowId:999,stateId:1,slot:0,mouseButton:0,mode:0,changedSlots:[],cursorItem:{itemCount:0}};
      f.contexts.run({taskId:'other-actor'},()=>f.client.write('window_click',payload));
      f.client.write('keep_alive',{id:8});
      const guarded=f.client.write;replacement=function(...packet){return guarded.apply(this,packet);};f.client.write=replacement;
      return deposit(...args);
    };return window;
  };
  await f.ensure(storage);await f.run(()=>storage.stash({}));
  assert.equal(f.client.write,replacement);assert.equal(f.writes.find(w=>w.data===payload)?.context.taskId,'other-actor');
  f.state.cancelled=true;
  f.run(()=>f.client.write('window_click',{windowId:1234}));
  assert.equal(f.writes.at(-1).cancelled,true);
});

test('foreign actor touching the owned window is passed through but prevents quiet pending-transfer adoption',async()=>{
  const f=fixture({inventory:{oak_planks:16}}),storage=f.api(),open=f.deps.openContainer;
  f.deps.openContainer=async block=>{const window=await open(block),deposit=window.deposit;
    window.deposit=(...args)=>f.contexts.run({taskId:'foreign'},()=>deposit(...args));return window;};
  await f.ensure(storage);
  await assert.rejects(f.run(()=>storage.stash({})),error=>error.code==='house_storage_transfer_unconfirmed');
  assert.equal(f.state.checkpoint.chests[0].stock.oak_planks,undefined);
  assert.equal(f.state.checkpoint.chests[0].pendingTransfer.foreignInterference,true);
  assert.ok(f.writes.filter(w=>w.name==='window_click').every(w=>w.context.taskId==='foreign'));
  await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_foreign_contents');
});

test('all 36 player slots can be occupied while native transfer merges into an existing same-item partial stack',async()=>{
  const f=fixture(),storage=f.api();await f.ensure(storage);
  await f.run(()=>storage.stash({oak_planks:4,iron_pickaxe:Infinity,cooked_porkchop:Infinity}));
  while(f.bot.inventory.emptySlotCount()>0)f.give('stone',64);
  assert.equal(f.bot.inventory.emptySlotCount(),0);assert.equal(count(f.bot.inventory.items(),'oak_planks'),4);
  await f.run(()=>storage.withdraw({oak_planks:10}));
  assert.equal(f.bot.inventory.emptySlotCount(),0);assert.equal(count(f.bot.inventory.items(),'oak_planks'),10);
  assert.equal(storage.getStock().oak_planks,90);assert.equal(f.bot.currentWindow,null);
});

test('native placement fact cannot overwrite a replacement task checkpoint',async()=>{
  const f=fixture({sites:[defaultSites[0]]});
  const replacement={schema:1,kind:'house_owned_storage',storageId:'another-task',chests:[],plannedSites:[],exclusionBounds:protection};
  f.deps.placeNative=async(spec,confirmed)=>{f.put(spec.position,'chest',spec.properties);f.state.checkpoint=clone(replacement);confirmed();};
  await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_owner_changed');
  assert.deepEqual(f.state.checkpoint,replacement);
});

test('water support and blocked lid are rejected before chest acquisition or native placement',async()=>{
  for(const issue of ['water','lid']){
    const f=fixture({sites:[defaultSites[0]]}),p=defaultSites[0];
    if(issue==='water')f.put({...p,y:63},'water',{level:0});else f.put({...p,y:65},'stone');
    await assert.rejects(f.ensure(f.api()),error=>error.code==='house_storage_unsafe_site');
    assert.equal(f.calls.filter(c=>['acquire','place','open'].includes(c.kind)).length,0);
  }
});

test('camp alternatives discard protected, duplicate and adjacent sites before the strict storage layer',()=>{
 const {selectOwnedStorageSites}=require('../vendor/server/minecraft/houseOwnedStorage');
 const p={x:-5,y:64,z:0},q={x:-7,y:64,z:0},r={x:-9,y:64,z:0};
 assert.deepEqual(selectOwnedStorageSites([{x:1,y:64,z:1},p,p,{x:-6,y:64,z:0},q,r],protection),[p,q,r]);
 assert.deepEqual(selectOwnedStorageSites([{x:1,y:64,z:1}],protection),[]);
});

function setModeledServerDamage(f,slot,damage){
 const raw=Item.toNotch(f.serverPlayer[slot]);raw.components=[{type:'damage',data:damage}];raw.addedComponentCount=1;
 f.serverPlayer[slot]=Item.fromNotch(raw);
 f.client.emit('set_slot',{windowId:0,stateId:0,slot,item:raw});
}
test('retiring old tools deposits the exact damaged native slot, preserves fresh tools and excludes retired stock from recipes',async()=>{
 const f=fixture({inventory:{iron_pickaxe:2,stone_pickaxe:1}}),storage=f.api();
 setModeledServerDamage(f,9,244);await f.ensure(storage);
 const result=await f.run(()=>storage.stashUnusableEquipment());
 assert.equal(result.deposited,1);assert.equal(count(f.bot.inventory.items(),'iron_pickaxe'),1);
 assert.equal(f.bot.inventory.items().find(i=>i.name==='iron_pickaxe').durabilityUsed,0);
 assert.equal(count(f.bot.inventory.items(),'stone_pickaxe'),1);
 const entry=f.state.checkpoint.chests[0],items=f.containers.get(key(entry.position)).filter(Boolean);
 assert.equal(items.find(i=>i.name==='iron_pickaxe').durabilityUsed,244);assert.equal(entry.stock.iron_pickaxe,1);
 assert.equal(storage.getStock().iron_pickaxe||0,0);
 assert.equal((await f.run(()=>storage.stashUnusableEquipment())).deposited,0,'Repeated retirement is idempotent');
});
test('withdrawing a usable tool skips an earlier nearly broken tool of the same native item type',async()=>{
 const f=fixture({inventory:{iron_pickaxe:2}}),storage=f.api();setModeledServerDamage(f,9,244);
 await f.ensure(storage);await f.run(()=>storage.stash({}));assert.equal(storage.getStock().iron_pickaxe,1);
 await f.run(()=>storage.withdraw({iron_pickaxe:1}));
 assert.equal(f.bot.inventory.items().find(i=>i.name==='iron_pickaxe').durabilityUsed,0);
 assert.equal(f.containers.get(key(f.state.checkpoint.chests[0].position)).filter(Boolean)[0].durabilityUsed,244);
 assert.equal(storage.getStock().iron_pickaxe||0,0);
});
test('retired tools cannot be withdrawn as usable recipe equipment',async()=>{
 const f=fixture({inventory:{iron_pickaxe:1}}),storage=f.api();setModeledServerDamage(f,9,244);
 await f.ensure(storage);await f.run(()=>storage.stashUnusableEquipment());
 await assert.rejects(f.run(()=>storage.withdraw({iron_pickaxe:1})),{code:'house_storage_missing'});
 assert.equal(count(f.bot.inventory.items(),'iron_pickaxe'),0);assert.equal(f.state.checkpoint.chests[0].stock.iron_pickaxe,1);
});
test('cancelled retirement keeps confirmed server receipts without authorizing further inventory clicks',async()=>{
 const f=fixture({inventory:{iron_pickaxe:2},cancelClicksAfter:1}),storage=f.api();
 setModeledServerDamage(f,9,244);setModeledServerDamage(f,10,243);await f.ensure(storage);
 await assert.rejects(f.run(()=>storage.stashUnusableEquipment()),{code:'cancelled'});
 assert.equal(f.writes.filter(w=>w.name==='window_click').length,1);
 assert.ok(f.saved.some(s=>s.next.chests.some(c=>c.pendingTransfer||c.pendingClosedInventory)));
});
