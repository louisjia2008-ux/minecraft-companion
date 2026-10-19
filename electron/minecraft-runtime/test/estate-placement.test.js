/* global require, setTimeout, clearTimeout */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const Item = require('prismarine-item')(registry);
const injectInventory = require('mineflayer/lib/plugins/inventory');
const injectSimpleInventory = require('mineflayer/lib/plugins/simple_inventory');
const injectGenericPlace = require('mineflayer/lib/plugins/generic_place');
const injectPlaceBlock = require('mineflayer/lib/plugins/place_block');
const { createEstatePlacement } = require('../vendor/server/minecraft/estatePlacement');
const { matchesFurnishedHouseBlock } = require('../vendor/server/minecraft/furnishedHouseBuilder');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = p => `${p.x},${p.y},${p.z}`;
const specAt = x => ({ position: {x,y:64,z:1}, item: 'oak_stairs', properties: {facing:'east',half:'bottom',shape:'straight',waterlogged:false} });

// Real installed Mineflayer inventory, simple_inventory, generic_place and
// place_block. Server block/slot responses are simulated; this is a protocol
// regression, not live-server or physics acceptance.
function fixture(t, options = {}) {
  const contexts = new AsyncLocalStorage(), owner = {taskId:'estate-placement'};
  const state = {cancelled:false}, cells = new Map(), requested = new Map();
  const writes = [], selections = [], slotEvents = [], confirms = [], timers = new Set();
  const client = new EventEmitter(), bot = new EventEmitter();
  const later = (fn, ms) => { const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer); };
  const active = () => { if(state.cancelled)throw Object.assign(new Error('cancelled'),{code:'cancelled'}); };
  const put = (p,name,properties={}) => {
    const block=Block.fromProperties(registry.blocksByName[name].id,properties,0);block.position=new Vec3(p.x,p.y,p.z);
    const before=bot.blockAt(block.position);cells.set(key(p),block);bot.emit(`blockUpdate:${block.position}`,before,block);return block;
  };
  const updateSlot = (slot,count,name=options.item||'oak_stairs') => {
    const item=count ? Item.toNotch(new Item(registry.itemsByName[name].id,count)) : {itemCount:0};
    slotEvents.push({slot,count,name,at:Date.now()});
    client.emit('set_slot',{windowId:0,stateId:slotEvents.length,slot,item});
  };
  Object.assign(bot,{registry,version:'1.21.8',_client:client,QUICK_BAR_START:36,
    entity:{id:1,position:new Vec3(.5,64,.5),yaw:0,pitch:0},game:{gameMode:'survival'},
    supportFeature:name=>registry.supportFeature(name),swingArm:()=>{},lookAt:async()=>{},
    blockAt:p=>cells.get(key(p))||Object.assign(Block.fromProperties(registry.blocksByName[p.y<64?'stone':'air'].id,{},0),{position:new Vec3(p.x,p.y,p.z)}),
  });
  const originalWrite=function(name,data){
    writes.push({name,data,self:this,context:contexts.getStore(),at:Date.now()});
    if(name!=='block_place')return 'native-result';
    const face=[[0,-1,0],[0,1,0],[0,0,-1],[0,0,1],[-1,0,0],[1,0,0]][data.direction];
    if(!face)return 'native-result';
    const target={x:data.location.x+face[0],y:data.location.y+face[1],z:data.location.z+face[2]},spec=requested.get(key(target));
    if(!spec)return 'native-result';
    const slot=36+bot.quickBarSlot;
    let serverCount=bot.inventory.slots[slot]?.count||0;
    if(!options.noWorld)put(target,spec.item,spec.properties);
    for(const derived of spec.derivedBlocks||[])later(()=>put(derived.position,derived.item,derived.properties),options.derivedDelay??12);
    if(options.pickupInSource)later(()=>{serverCount+=2;updateSlot(slot,serverCount,spec.item);},5);
    if(options.unrelatedSlot)later(()=>updateSlot(37,Math.max(0,(bot.inventory.slots[37]?.count||0)-1),spec.item),5);
    if(!options.noAck)later(()=>{serverCount-=1;updateSlot(slot,serverCount,spec.item);},options.ackDelay??40);
    return 'native-result';
  };
  client.write=originalWrite;
  injectInventory(bot,{hideErrors:true});injectSimpleInventory(bot);injectGenericPlace(bot);injectPlaceBlock(bot);
  bot.quickBarSlot=0;
  updateSlot(36,options.count??1);updateSlot(37,options.spare??10);
  async function nativePlace(spec,onConfirmed){
    requested.set(key(spec.position),spec);
    const item=bot.inventory.items().find(i=>i.name===spec.item);
    if(!item)throw new Error('No available fixture material');
    selections.push({slot:item.slot,count:item.count,at:Date.now()});
    await bot.equip(item,'hand');
    if(options.lookDelay)await sleep(options.lookDelay);
    const reference=bot.blockAt(new Vec3(spec.position.x,spec.position.y-1,spec.position.z));
    await bot._placeBlockWithOptions(reference,new Vec3(0,1,0),{forceLook:'ignore'});
    const deadline=Date.now()+200;
    while(![spec,...spec.derivedBlocks||[]].every(s=>matchesFurnishedHouseBlock(bot.blockAt(new Vec3(s.position.x,s.position.y,s.position.z)),s))){
      active();if(Date.now()>=deadline)throw new Error('Native fixture world confirmation failed');await sleep(2);
    }
    onConfirmed?.();confirms.push({position:spec.position,at:Date.now()});
    if(options.cancelAfterWorld)state.cancelled=true;
    return 'native-confirmed';
  }
  const deps={getBot:()=>bot,assertActive:active,isOwnerContext:()=>contexts.getStore()===owner,
    placeNative:nativePlace,timeoutMs:options.timeoutMs??100};
  const placement=createEstatePlacement(deps);
  const place=(spec,callback)=>contexts.run(owner,()=>placement.place(spec,callback));
  t.after(()=>{for(const timer of timers)clearTimeout(timer);});
  return {bot,client,contexts,owner,state,cells,requested,writes,selections,slotEvents,confirms,put,updateSlot,originalWrite,nativePlace,deps,place};
}

test('installed native old selection race fails; source-slot ACK barrier selects the spare hotbar stack',async t=>{
  const old=fixture(t,{ackDelay:25,lookDelay:45});
  await old.nativePlace(specAt(1));
  await assert.rejects(old.nativePlace(specAt(2)),/must be holding an item/);
  assert.deepEqual(old.selections.map(s=>s.slot),[36,36]);
  assert.equal(old.bot.inventory.slots[37].count,10,'This is stale hand selection, not missing material');
  const f=fixture(t,{ackDelay:25,lookDelay:45});
  const baselineListeners=f.client.listenerCount('set_slot');
  await f.place(specAt(1));await f.place(specAt(2));
  assert.deepEqual(f.selections.map(s=>s.slot),[36,37]);
  assert.equal(f.bot.inventory.slots[36],null);assert.equal(f.bot.inventory.slots[37].count,9);
  assert.equal(f.writes.filter(w=>w.name==='block_place').length,2);
  assert.equal(f.client.write,f.originalWrite);
  assert.equal(f.client.listenerCount('set_slot'),baselineListeners);
});

test('the tap is removed after native world confirmation while the source-slot listener still waits for ACK',async t=>{
  const f=fixture(t,{ackDelay:60});
  const baseline=f.client.listenerCount('set_slot');
  let settled=false;
  const operation=f.place(specAt(1)).then(()=>{settled=true;});
  await sleep(10);
  assert.equal(f.confirms.length,1);assert.equal(settled,false);
  assert.equal(f.client.write,f.originalWrite);
  assert.equal(f.client.listenerCount('set_slot'),baseline+1);
  await operation;
  assert.equal(f.client.listenerCount('set_slot'),baseline);
  assert.ok(f.slotEvents.at(-1).at<=Date.now());
});

test('native door primary and delayed derived half consume one item; complete restoration consumes none',async t=>{
  const f=fixture(t,{item:'oak_door',count:2,spare:0,derivedDelay:25});
  const spec={position:{x:1,y:64,z:1},item:'oak_door',properties:{half:'lower',facing:'north',hinge:'left',open:false},
    derivedBlocks:[{position:{x:1,y:65,z:1},item:'oak_door',properties:{half:'upper',facing:'north',hinge:'left',open:false}}]};
  let owned=0;
  assert.equal(await f.place(spec,()=>{owned+=1;}),'native-confirmed');
  assert.equal(f.bot.inventory.slots[36].count,1);assert.equal(owned,1);
  const writes=f.writes.length;
  assert.deepEqual(await f.place(spec),{alreadyComplete:true,consumed:false});
  assert.equal(f.writes.length,writes);assert.equal(f.bot.inventory.slots[36].count,1);
});

test('actual source-slot pickup growth followed by one debit succeeds despite positive total material change',async t=>{
  const f=fixture(t,{count:3,spare:10,pickupInSource:true,ackDelay:30});
  const initial=f.bot.inventory.items().reduce((n,i)=>n+i.count,0);
  await f.place(specAt(1));
  assert.deepEqual(f.slotEvents.filter(e=>e.slot===36).map(e=>e.count),[3,5,4]);
  assert.equal(f.bot.inventory.items().reduce((n,i)=>n+i.count,0),initial+1);
});

test('a debit in another slot never satisfies the source-slot proof; missing ACK fails without replay',async t=>{
  const f=fixture(t,{count:2,spare:10,noAck:true,unrelatedSlot:true,timeoutMs:35});
  let confirmed=0;
  await assert.rejects(f.place(specAt(1),()=>{confirmed+=1;}),error=>error.code==='estate_placement_debit_unconfirmed');
  assert.equal(confirmed,1,'Already placed ownership is retained for explicit recovery');
  assert.equal(f.writes.filter(w=>w.name==='block_place').length,1);
  assert.equal(f.bot.inventory.slots[36].count,2);assert.equal(f.bot.inventory.slots[37].count,9);
  assert.deepEqual(await f.place(specAt(1)),{alreadyComplete:true,consumed:false});
  assert.equal(f.writes.filter(w=>w.name==='block_place').length,1);
  assert.equal(f.client.write,f.originalWrite);
});

test('cancellation after real world confirmation preserves ownership but removes listeners and issues no late action',async t=>{
  const f=fixture(t,{cancelAfterWorld:true,ackDelay:50});
  const baseline=f.client.listenerCount('set_slot');let owned=0;
  await assert.rejects(f.place(specAt(1),()=>{owned+=1;}),error=>error.code==='cancelled');
  const writes=f.writes.length;
  assert.equal(owned,1);assert.equal(f.client.write,f.originalWrite);
  assert.equal(f.client.listenerCount('set_slot'),baseline);
  await sleep(70);
  assert.equal(f.writes.length,writes,'A server ACK may arrive after cancel; no new native action is issued');
});

test('cancellation during native rotation blocks the first write; cancellation while waiting ACK never resends',async t=>{
  const beforeSend=fixture(t,{lookDelay:35});
  const pending=beforeSend.place(specAt(1));
  const rejected=assert.rejects(pending,error=>error.code==='cancelled');
  await sleep(5);beforeSend.state.cancelled=true;await rejected;
  assert.equal(beforeSend.writes.filter(w=>w.name==='block_place').length,0);
  assert.equal(beforeSend.client.write,beforeSend.originalWrite);
  const f=fixture(t,{ackDelay:80}),baseline=f.client.listenerCount('set_slot');
  const waiting=f.place(specAt(1));const cancelled=assert.rejects(waiting,error=>error.code==='cancelled');
  await sleep(10);assert.equal(f.confirms.length,1);f.state.cancelled=true;await cancelled;
  assert.equal(f.client.write,f.originalWrite);assert.equal(f.client.listenerCount('set_slot'),baseline);
  await sleep(90);assert.equal(f.writes.filter(w=>w.name==='block_place').length,1);
});

test('restored primary can await its previous derived response without sending or consuming another item',async t=>{
  const f=fixture(t,{item:'oak_door',count:0,spare:0});
  const spec={position:{x:1,y:64,z:1},item:'oak_door',properties:{half:'lower',facing:'north'},
    derivedBlocks:[{position:{x:1,y:65,z:1},item:'oak_door',properties:{half:'upper',facing:'north'}}]};
  f.put(spec.position,spec.item,spec.properties);
  f.deps.placeNative=async()=>{await sleep(10);const upper=spec.derivedBlocks[0];f.put(upper.position,upper.item,upper.properties);return 'previous-derived-confirmed';};
  assert.equal(await f.place(spec),'previous-derived-confirmed');
  assert.equal(f.writes.length,0);assert.equal(f.bot.inventory.items().length,0);
});

test('foreign-context target packets pass unchanged but cannot prove this task placement',async t=>{
  const f=fixture(t),foreign={taskId:'foreign'};
  f.deps.placeNative=(spec,onConfirmed)=>f.contexts.run(foreign,()=>f.nativePlace(spec,onConfirmed));
  await assert.rejects(f.place(specAt(1)),error=>error.code==='estate_placement_debit_unconfirmed');
  const packet=f.writes.find(w=>w.name==='block_place');
  assert.equal(packet.context,foreign);assert.equal(packet.self,f.client);
  assert.equal(packet.data.location.x,1);assert.equal(packet.data.location.y,63);assert.equal(packet.data.direction,1);
  assert.equal(f.client.write,f.originalWrite);
});

test('unrelated protocol/target packets retain payload identity and a later writer replacement is not overwritten',async t=>{
  const f=fixture(t);let replacement,payload={id:9},native=f.deps.placeNative;
  f.deps.placeNative=async(spec,onConfirmed)=>{
    assert.equal(f.client.write('keep_alive',payload),'native-result');
    f.client.write('block_place',{location:new Vec3(50,63,50),direction:1});
    const tapped=f.client.write;
    replacement=function(...args){return tapped.apply(this,args);};f.client.write=replacement;
    return native(spec,onConfirmed);
  };
  await f.place(specAt(1));
  assert.equal(f.writes[0].data,payload);assert.equal(f.writes[0].self,f.client);
  assert.equal(f.client.write,replacement);
  f.state.cancelled=true;
  f.contexts.run(f.owner,()=>f.client.write('block_place',{location:new Vec3(1,63,1),direction:1}));
  assert.equal(f.writes.filter(w=>w.name==='block_place').length,3,'Completed retained tap must be inert');
});

test('wrong selected material is rejected at actual native send before any placement packet',async t=>{
  const f=fixture(t);f.deps.placeNative=async spec=>{
    f.updateSlot(36,1,'stone');
    return f.bot._genericPlace(f.bot.blockAt(new Vec3(spec.position.x,63,spec.position.z)),new Vec3(0,1,0),{forceLook:'ignore'});
  };
  await assert.rejects(f.place(specAt(1)),error=>error.code==='estate_placement_debit_unconfirmed');
  assert.equal(f.writes.filter(w=>w.name==='block_place').length,0);
  assert.equal(f.client.write,f.originalWrite);
});

test('native exceptions clean up the tap/listener without replacing an already installed writer',async t=>{
  const f=fixture(t),baseline=f.client.listenerCount('set_slot');
  f.deps.placeNative=async()=>{throw new Error('native rejected');};
  await assert.rejects(f.place(specAt(1)),/native rejected/);
  assert.equal(f.client.write,f.originalWrite);assert.equal(f.client.listenerCount('set_slot'),baseline);
});
