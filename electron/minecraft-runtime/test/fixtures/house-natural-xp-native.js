/* global require, setTimeout, clearTimeout */
'use strict';
const req=require('node:module').createRequire(require.resolve('../../package.json'));
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Vec3 } = req('vec3');
const registry = req('prismarine-registry')('1.21.8');
const Block = req('prismarine-block')(registry);
const Item = req('prismarine-item')(registry);
const injectInventory = req('mineflayer/lib/plugins/inventory');
const injectSimpleInventory = req('mineflayer/lib/plugins/simple_inventory');
const injectGenericPlace = req('mineflayer/lib/plugins/generic_place');
const injectPlaceBlock = req('mineflayer/lib/plugins/place_block');
const { createEstatePlacement } = req('./vendor/server/minecraft/estatePlacement');
const { matchesFurnishedHouseBlock } = req('./vendor/server/minecraft/furnishedHouseBuilder');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = p => `${p.x},${p.y},${p.z}`;

// PRIVATE fixture: installed Mineflayer inventory, simple_inventory, generic_place and
// place_block. Server block/slot responses are simulated; this is a protocol
// regression, not live-server or physics acceptance.
function fixture(t, options = {}) {
  const contexts = new AsyncLocalStorage(), owner = {taskId:'estate-placement'};
  const state = {cancelled:false}, cells = new Map(), requested = new Map();
  const digKinds=new Map();
  const writes = [], selections = [], slotEvents = [], confirms = [], timers = new Set();
  const client = new EventEmitter(), bot = new EventEmitter();
  const later = (fn, ms) => { const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer); };
  const active = () => { if(state.cancelled)throw Object.assign(new Error('cancelled'),{code:'cancelled'}); };
  const put = (p,name,properties={},raw=true) => {
    const block=Block.fromProperties(registry.blocksByName[name].id,properties,0);block.position=new Vec3(p.x,p.y,p.z);
    const before=bot.blockAt(block.position);cells.set(key(p),block);bot.emit(`blockUpdate:${block.position}`,before,block);bot.emit('blockUpdate',before,block);if(raw&&!options.noRawWorld)client.emit('block_change',{location:point(p),type:block.stateId});return block;
  };
  const updateSlot = (slot,count,name=options.item||'oak_stairs') => {
    const item=count ? Item.toNotch(new Item(registry.itemsByName[name].id,count)) : {itemCount:0};
    slotEvents.push({slot,count,name,at:Date.now()});
    client.emit('set_slot',{windowId:0,stateId:slotEvents.length,slot,item});
  };
  Object.assign(bot,{registry,version:'1.21.8',_client:client,QUICK_BAR_START:36,health:20,food:20,entities:{},players:{},player:{ping:1},
    entity:{id:1,position:new Vec3(.5,64,.5),velocity:new Vec3(0,-.0784,0),onGround:true,isInWater:false,isInLava:false,width:.6,height:1.8,eyeHeight:1.62,effects:{},attributes:{},yaw:0,pitch:0},game:{gameMode:'survival',minY:-64,height:384,dimension:'overworld'},
    supportFeature:name=>registry.supportFeature(name),swingArm:()=>{},lookAt:async()=>{},
    blockAt:p=>cells.get(key(p))||Object.assign(Block.fromProperties(registry.blocksByName[p.y===63?'sand':p.y<63?'stone':'air'].id,{},0),{position:new Vec3(p.x,p.y,p.z)}),
  });
  const originalWrite=function(name,data){
    writes.push({name,data,self:this,context:contexts.getStore(),at:Date.now()});
    if(name==='block_dig'&&data.status===2){later(()=>{if(!options.noDigWorld)put(data.location,'air');if(!options.noDrop){const name=digKinds.get(key(data.location));const slot=name==='cactus_flower'?10:36,old=bot.inventory.slots[slot]?.count||0;updateSlot(slot,old+1,name);}},25);}
    if(name==='block_dig'&&data.status===0)digKinds.set(key(data.location),bot.blockAt(new Vec3(data.location.x,data.location.y,data.location.z)).name);
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
  injectInventory(bot,{hideErrors:true});injectSimpleInventory(bot);injectGenericPlace(bot);injectPlaceBlock(bot);req('mineflayer/lib/plugins/digging')(bot);
  bot._updateBlockState=(p,id)=>{const b=Block.fromStateId(id);put(p,b.name,b.getProperties(),false);};
  bot.setControlState=()=>{throw new Error('Planning only: no controls');};bot.clearControlStates=()=>{throw new Error('Planning only: no controls');};req('mineflayer-pathfinder').pathfinder(bot);
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


const point=p=>({x:p.x,y:p.y,z:p.z});

module.exports={fixture,req,registry,Item,Block,Vec3};
