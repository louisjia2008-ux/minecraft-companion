'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { verifyHouseFurnitureUse, INPUTS } = require('../vendor/server/minecraft/houseFurnitureUse');
function fixture() {
 const bot = new EventEmitter(), client = new EventEmitter(), positions = { door: { lower:{x:0,y:1,z:0},upper:{x:0,y:2,z:0} }, craftingTable:{x:2,y:1,z:2},chest:{x:2,y:1,z:3},furnace:{x:2,y:1,z:4},bed:{foot:{x:1,y:1,z:2},head:{x:1,y:1,z:1}} };
 const blueprint = { furniture:positions, entrance:{outside:{x:0,y:0,z:-2},inside:{x:0,y:1,z:1}} }, stock={...INPUTS}, chest={}, writes=[], records=[];
 let owner=true, open=false, now=0, windowId=0, output=null, input=null, slept=false, interrupt=false, burnUntil=0;
 const key=p=>`${p.x},${p.y},${p.z}`, doorKeys=[key(positions.door.lower),key(positions.door.upper)], bedKeys=[key(positions.bed.foot),key(positions.bed.head)];
 Object.assign(bot,{_client:client, time:{timeOfDay:1000},registry:{itemsByName:{wooden_pickaxe:{id:1},oak_planks:{id:2},sand:{id:3}}},isSleeping:false,
 blockAt:p=>({position:p,getProperties:()=>doorKeys.includes(key(p))?{open}:bedKeys.includes(key(p))?{occupied:slept}:key(p)===key(positions.furnace)?{lit:now<burnUntil}:{} }),
 activateBlock:async()=>{open=!open;},recipesFor:()=>[{requiresTable:true}],
 sleep:async()=>{slept=true;bot.isSleeping=true;bot.emit('sleep');},wake:async()=>{slept=false;bot.isSleeping=false;bot.emit('wake');}});
 const frame=container=>({windowId:windowId,items:[...Object.entries(container).map(([name,count])=>({name,count})),...Object.entries(stock).filter(([,n])=>n).map(([name,count])=>({name,count}))]});
 const makeWindow=async(furnace=false)=>{
  if(!furnace&&chest.oak_planks===0)delete chest.oak_planks;
  windowId++;const container=furnace?{}:chest,w={id:windowId,inventoryStart:Object.keys(container).length,inventoryEnd:Object.keys(container).length+Object.keys(stock).filter(k=>stock[k]).length,
  close:async()=>{},deposit:async(_id,_meta,n)=>{stock.oak_planks-=n;chest.oak_planks=(chest.oak_planks||0)+n;},withdraw:async(_id,_meta,n)=>{stock.oak_planks+=n;chest.oak_planks-=n;},
  inputItem:()=>input,outputItem:()=>output,putInput:async()=>{stock.sand--;input={name:'sand'};},putFuel:async()=>{stock.oak_planks--;input=null;burnUntil=now+5000;output={name:'glass',count:1};},takeOutput:async()=>{stock.glass=(stock.glass||0)+1;output=null;}};
  if(!furnace&&chest.oak_planks===0)delete chest.oak_planks;
  // Real plugins resolve open after receiving the initial authoritative frame.
  client.emit('window_items',frame(container));return w;
 };
 bot.openContainer=()=>makeWindow(false);bot.openFurnace=()=>makeWindow(true);
 const identity=()=>{if(!owner)throw Object.assign(Error('replaced owner'),{code:'movement_preempted'});};
 const host={getBot:()=>bot,taskId:'original-task',now:()=>now,sleep:async ms=>{now+=ms;},vec:p=>p,assertIdentity:identity,assertOwner:identity,
 ready:async()=>{identity();if(interrupt){writes.push('wait_defense');interrupt=false;writes.push('cleanup_air_ack');}},
 ensure:async items=>assert.deepEqual(items,INPUTS),maintain:async()=>{bot.time.timeOfDay=13000;},position:()=>blueprint.entrance.inside,decodeItem:i=>i,
 move:async()=>{identity();},reach:async()=>{identity();},craft:async()=>{stock.oak_planks-=3;stock.stick-=2;stock.wooden_pickaxe=(stock.wooden_pickaxe||0)+1;},
 native:async(name,action,active)=>{active();identity();writes.push(name);return action();},record:(name,evidence)=>records.push({name,evidence})};
 return {bot,client,host,blueprint,writes,records,stock,revoke:()=>{owner=false;},interrupt:()=>{interrupt=true;}};
}
test('one original task actually crafts, stores, smelts, sleeps and traverses; every container proof uses a fresh packet',async()=>{
 const f=fixture(),r=await verifyHouseFurnitureUse(f.host,f.blueprint);assert.equal(r.confirmed,true);assert.equal(r.originalTaskId,'original-task');assert.equal(f.stock.glass,1);assert.equal(f.stock.sand,0);assert.equal(f.stock.wooden_pickaxe,1);assert.equal(r.checks.furnace.extinguished,true);assert.ok(f.host.now()>=5000,'Actual burnout observation precedes completion');assert.equal(r.checks.door.closed,true);assert.equal(f.client.listenerCount('window_items'),0);assert.deepEqual(f.records.map(r=>r.name),['routes','crafting','chest','furnace','bed','door']);
});
test('survival handoff is drained and owned obstacles cleaned before original furniture owner writes',async()=>{
 const f=fixture();const original=f.host.native;let injected=false;
 f.host.native=async(name,action,active)=>{const result=await original(name,action,active);if(name==='craft'&&!injected){injected=true;f.interrupt();}return result;};
 const r=await verifyHouseFurnitureUse(f.host,f.blueprint);assert.equal(r.confirmed,true);const i=f.writes.indexOf('wait_defense');assert.ok(i>=0);assert.equal(f.writes[i+1],'cleanup_air_ack');assert.equal(f.writes[i+2],'openContainer');
});
test('owner replacement between input and fuel forbids further writes and cannot turn partial furnace work into PASS',async()=>{
 const f=fixture(),original=f.host.native;f.host.native=async(name,action,active)=>{const r=await original(name,action,active);if(name==='putInput')f.revoke();return r;};
 await assert.rejects(verifyHouseFurnitureUse(f.host,f.blueprint),{code:'movement_preempted'});assert.ok(!f.writes.includes('putFuel'));assert.ok(!f.records.some(r=>r.name==='furnace'));assert.equal(f.client.listenerCount('window_items'),0);
});
test('a previous packet with a reused window id cannot prove a new window inventory',async()=>{
 const f=fixture();f.bot.openContainer=async()=>({id:1,inventoryStart:0,inventoryEnd:0,close:()=>{}});f.client.emit('window_items',{windowId:1,items:[]});
 await assert.rejects(verifyHouseFurnitureUse(f.host,f.blueprint),{code:'house_furniture_readback_timeout'});assert.equal(f.records.some(r=>r.name==='crafting'),false);
});

test('a transient native nearby-monster sleep refusal retries under the original owner without replaying completed furniture work',async()=>{
 const f=fixture(),sleep=f.bot.sleep;let attempts=0;
 f.bot.sleep=async(...args)=>{attempts++;if(attempts===1)throw Error('there are monsters nearby');return sleep(...args);};
 const r=await verifyHouseFurnitureUse(f.host,f.blueprint);assert.equal(r.confirmed,true);assert.equal(attempts,2);assert.equal(f.stock.glass,1);assert.equal(f.stock.wooden_pickaxe,1);assert.equal(f.writes.filter(w=>w==='putInput').length,1);assert.equal(f.writes.filter(w=>w==='craft').length,1);
});
