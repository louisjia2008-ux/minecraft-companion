'use strict';
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks'),{createRequire}=require('node:module');
const req=createRequire(require.resolve('../../package.json'));
const {Vec3}=req('vec3'),registry=req('prismarine-registry')('1.21.8'),Block=req('prismarine-block')(registry),Item=req('prismarine-item')(registry),windows=req('prismarine-windows')('1.21.8');
const injectInventory=req('mineflayer/lib/plugins/inventory'),injectEnchant=req('mineflayer/lib/plugins/enchantment_table'),injectXP=req('mineflayer/lib/plugins/experience');
const {createHouseNaturalEnchant,enchantmentFacts}=req('./vendor/server/minecraft/houseNaturalEnchant');
const table={x:3,y:64,z:0};
const plain=value=>JSON.parse(JSON.stringify(value));
async function settle(t,promise,maxMs=4000){let done=false,value,error;promise.then(v=>{done=true;value=v;},e=>{done=true;error=e;});for(let ms=0;!done&&ms<=maxMs;ms+=5){for(let n=0;n<8;n++)await Promise.resolve();t.mock.timers.tick(5);}for(let n=0;n<8;n++)await Promise.resolve();if(!done)throw new Error('test native operation did not settle');if(error)throw error;return value;}
async function advance(t,ms){for(let n=0;n<ms;n+=5){for(let k=0;k<8;k++)await Promise.resolve();t.mock.timers.tick(5);}for(let k=0;k<8;k++)await Promise.resolve();}
// OFFLINE original installed inventory/enchantment/experience plugins. A separate
// prismarine server window accepts only actual emitted native clicks. Authoritative
// set_slot/window_items/experience events are simulated protocol responses; this
// is no natural-server or XP-provider proof. No Java, world or physics is altered.
function fixture(t,options={}){
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1791900000000});
 const contexts=new AsyncLocalStorage(),owner={},foreign={},state={cancelled:false,superseded:false,cp:null,serverWindow:null,clicks:0,xpBatches:0,returns:0,lookWait:false};
 const bot=new EventEmitter(),client=new EventEmitter(),writes=[],saves=[],player=Array(46).fill(null);
 const item=(name,count=1)=>count?new Item(registry.itemsByName[name].id,count):null,cloneItem=i=>i?Item.fromNotch(Item.toNotch(i)):null;
 const xpPacket=(level,points=1395)=>client.emit('experience',{level,totalExperience:points,experienceBar:0});
 const putSlot=(slot,value,window=state.serverWindow)=>{window.updateSlot(slot,cloneItem(value));if(!options.noRawAck)client.emit('set_slot',{windowId:window.id,stateId:state.clicks,slot,item:Item.toNotch(window.slots[slot])});};
 function offers(){for(const [property,value]of [[0,1],[1,10],[2,options.offerLevel??30]])client.emit('craft_progress_bar',{windowId:7,property,value});}
 Object.assign(bot,{registry,version:'1.21.8',username:'PrivateEnchant',_client:client,QUICK_BAR_START:36,supportFeature:n=>registry.supportFeature(n),health:20,food:20,entity:{id:1,position:new Vec3(.5,64,.5),onGround:true,yaw:0,pitch:0},game:{gameMode:'survival'},lookAt:async()=>{if(options.pauseDuringLook){await new Promise(resolve=>setTimeout(resolve,40));state.cancelled=true;}},swingArm:()=>{},blockAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[p.x===table.x&&p.y===table.y&&p.z===table.z?(options.replacedTable?'stone':'enchanting_table'):p.y<64?'stone':'air'].defaultState),{position:p.floored()})});
 function openResponse(){
  const sw=windows.createWindow(7,'minecraft:enchantment','Owned candidate');state.serverWindow=sw;
  for(let slot=9;slot<45;slot++)sw.updateSlot(slot-7,cloneItem(player[slot]));
  if(options.foreignWindowContents)sw.updateSlot(0,item('diamond_sword'));
  client.emit('open_window',{windowId:7,inventoryType:'minecraft:enchantment',windowTitle:'Owned candidate'});
  client.emit('window_items',{windowId:7,stateId:0,items:sw.slots.map(Item.toNotch),carriedItem:Item.toNotch(null)});
 }
 const originalWrite=function(name,data){
  writes.push({name,data,self:this,context:contexts.getStore(),cancelled:state.cancelled});
  if(name==='block_place'&&data.location.x===table.x&&data.location.z===table.z)setTimeout(openResponse,5);
  if(name==='window_click'&&data.windowId===7&&state.serverWindow){
   const sw=state.serverWindow,click={slot:data.slot,mouseButton:data.mouseButton,mode:data.mode,item:sw.slots[data.slot]};
   if(options.rejectOutputRetrieval&&data.slot===0&&enchantmentFacts(sw.slots[0]).length){state.clicks++;return 'rejected native retrieval';}
   const changed=sw.acceptClick(click);state.clicks++;
   setTimeout(()=>{for(const slot of changed)putSlot(slot,sw.slots[slot]);if(sw.slots[0]?.name==='diamond_sword'&&sw.slots[1]?.name==='lapis_lazuli')offers();},5);
   if(options.cancelClick===state.clicks)state.cancelled=true;
  }
  if(name==='enchant_item'&&data.windowId===7&&contexts.getStore()===owner&&!options.offersOnly){
   assert.equal(data.enchantment,2);if(options.throwEnchant)throw new Error('native server write failed');
   const sw=state.serverWindow;
   setTimeout(()=>{
    let output=cloneItem(sw.slots[0]);
    if(!options.noEnchantment){output.components=[{type:'enchantments',data:{enchantments:[{id:registry.enchantmentsByName.sharpness.id,level:3}]}}];output.componentMap=new Map(output.components.map(c=>[c.type,c]));}
    putSlot(0,output);
    if(!options.noLapisDebit)putSlot(1,item('lapis_lazuli',(sw.slots[1]?.count||0)-3));
    if(!options.noXPDebit)xpPacket((options.level??30)-3);
    if(options.cancelAfterNativeResult)state.cancelled=true;
   },20);
  }
  if(name==='close_window'&&data.windowId===7){const sw=state.serverWindow;for(let slot=9;slot<45;slot++)player[slot]=cloneItem(sw.slots[slot-7]);setTimeout(()=>{for(let slot=9;slot<45;slot++)client.emit('set_slot',{windowId:0,stateId:state.clicks,slot,item:Item.toNotch(player[slot])});},5);}
  return 'unchanged native return';
 };
 client.write=originalWrite;injectInventory(bot,{hideErrors:true});injectEnchant(bot);injectXP(bot);bot.quickBarSlot=0;
 player[9]=item('diamond_sword');player[10]=item('lapis_lazuli',options.lapis??6);
 for(let slot=9;slot<45;slot++)client.emit('set_slot',{windowId:0,stateId:0,slot,item:Item.toNotch(player[slot])});
 xpPacket(options.level??30,options.points??1395);
 const active=()=>{if(state.cancelled)throw Object.assign(new Error('paused'),{code:'paused'});if(state.superseded)throw Object.assign(new Error('superseded'),{code:'movement_preempted'});};
 const deps={getBot:()=>bot,assertActive:active,isOwnerContext:()=>contexts.getStore()===owner,getCP:()=>state.cp,saveCP:value=>{active();saves.push({value:plain(value),cancelled:state.cancelled});state.cp=plain(value);},ensureMaterials:async()=>({confirmed:true}),earnXPBatch:async()=>{state.xpBatches++;return {confirmed:true};},ownedEnchantmentTable:async()=>({position:options.wrongOwned?{...table,x:4}:table,confirmedOwned:!options.notOwned}),reach:async()=>{},returncamp:async()=>{active();state.returns++;}};
 const api=()=>createHouseNaturalEnchant(deps,{readbackMs:100,nativeTimeoutMs:500,pollMs:5,maxNoProgress:2,maxBatches:4,totalTimeoutMs:2000});
 const run=fn=>contexts.run(owner,fn);
 t.after(()=>{t.mock.timers.reset();});
 return {bot,client,state,contexts,owner,foreign,writes,saves,player,originalWrite,api,deps,run,item,xpPacket,offers,putSlot};
}

module.exports={fixture,settle,advance};
