/* global require, setTimeout, setInterval, clearInterval */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{AsyncLocalStorage}=require('node:async_hooks');
const {Vec3}=require('vec3'),{pathfinder,Movements}=require('mineflayer-pathfinder'),registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry),Item=require('prismarine-item')(registry),WorldSync=require('prismarine-world/src/worldsync');
const api=require('../vendor/server/minecraft/houseFluidNativeBridge');
const {withHouseNativeSourceGuard}=require('../vendor/server/minecraft/houseNativeSourceGuard');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),key=p=>`${p.x},${p.y},${p.z}`;
async function until(predicate,ms=3000){const end=Date.now()+ms;while(!predicate()&&Date.now()<end)await sleep(5);assert.ok(predicate(),'native condition reached within bound');}
function fixture(t,options={}){
  const storage=new AsyncLocalStorage(),cells=new Map(),writes=[],signals=[],physical=[];let current,tokenPaused=false,currentBot,failCancel=false;
  const owner={task:{id:'ownerA'},generation:0,lease:{token:1},context:{id:'ctxA'}},client=Object.assign(new EventEmitter(),{state:'play'});
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',username:'BridgeUnit',_client:client,QUICK_BAR_START:36,health:20,food:20,isAlive:true,entities:{},players:{},
    supportFeature:n=>registry.supportFeature(n),game:{dimension:'overworld',minY:-64,height:384,gameMode:'survival'},
    entity:{id:1,position:new Vec3(.5,64,.5),velocity:new Vec3(0,0,0),onGround:true,eyeHeight:1.62,height:1.8,width:.6,yaw:0,pitch:0,effects:{},attributes:{},isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:true,elytraFlying:false}});
  current=owner;currentBot=bot;
  client.write=(name,data)=>{if(name==='block_dig'&&data.status===1&&failCancel)throw Object.assign(new Error('transport rejected native cancel'),{code:'SOCKET_CANCEL'});writes.push({name,data,at:Date.now()});};
  bot.blockAt=p=>{const q=p.floored(),name=cells.get(key(q))||(q.y<64?'stone':'air');return Object.assign(Block.fromProperties(registry.blocksByName[name].id,{},0),{position:q});};
  bot.world={getBlock:p=>bot.blockAt(p),raycast:WorldSync.prototype.raycast};
  bot._updateBlockState=(p,id)=>{const before=bot.blockAt(p),name=Block.fromStateId(id).name;cells.set(key(p),name);const after=bot.blockAt(p);bot.emit(`blockUpdate:${p}`,before,after);bot.emit('blockUpdate',before,after);};
  require('mineflayer/lib/plugins/inventory')(bot,{});require('mineflayer/lib/plugins/simple_inventory')(bot);bot.quickBarSlot=0;
  const slots=Array.from({length:46},()=>Item.toNotch(null));slots[36]=Item.toNotch(new Item(registry.itemsByName.diamond_pickaxe.id,1));client.emit('window_items',{windowId:0,stateId:1,items:slots,carriedItem:Item.toNotch(null)});
  bot.swingArm=()=>client.write('arm_animation',{hand:0});
  require('mineflayer/lib/plugins/physics')(bot,{});pathfinder(bot);require('mineflayer/lib/plugins/digging')(bot);
  bot.emit('login');client.emit('position',{x:.5,y:64,z:.5,yaw:180,pitch:0,flags:{}});const ready=bot.waitForTicks(2);
  const active=()=>{if(tokenPaused)throw Object.assign(new Error('paused'),{code:'paused'});if(current!==owner||currentBot!==bot)throw Object.assign(new Error('movement_preempted'),{code:'movement_preempted'});};
  const ctx={assertActive:active,beforeSend:()=>{options.beforeSend?.({bot,writes,pause:()=>{tokenPaused=true;}});active();},strictCardinal:true,avoidFloors:[]};
  const deps={getBot:()=>currentBot,captureOwner:()=>owner,assertOwner:active,isOwnerCurrent:()=>current===owner&&!tokenPaused&&currentBot===bot,isOwnerContext:()=>storage.getStore()===owner.context,
    sourceGuardSupportsOwnedCancel:true,abortOwner:()=>{tokenPaused=true;},
    runPhysicalAction:async(_kind,_primitive,op,config)=>{physical.push(config);assert.equal(config.timeoutMs,120000);assert.equal(config.requireStartupSignal,false);let timer;try{return await Promise.race([op(s=>signals.push(s)),new Promise((_r,reject)=>{timer=setInterval(()=>{try{active();}catch(e){reject(e);}},20);})]);}finally{clearInterval(timer);}},
    withMovements:async(m,action)=>{bot.pathfinder.setMovements(m);return action();},restoreMovements:(previous)=>bot.pathfinder.setMovements(previous),
    goto:goal=>bot.pathfinder.goto(goal),waitGround:async(p,ctx)=>{ctx.assertActive();await until(()=>{ctx.assertActive();return bot.entity.onGround&&bot.entity.position.floored().equals(new Vec3(p.x,p.y,p.z));});},
    guardNative:(_owner,_ctx,action)=>action(),equipNative:()=>{},...options.deps};
  const bridge=api.createHouseFluidNativeBridge(deps);
  const run=async fn=>{await ready;return storage.run(owner.context,()=>withHouseNativeSourceGuard(bot,{assertActive:active,isOwnerContext:()=>storage.getStore()===owner.context,allowNativeCancel:api.isOwnedFluidNativeCancel},fn));};
  t.after(()=>{tokenPaused=true;bot.pathfinder.setGoal(null);bot.clearControlStates();bot.emit('end');});
  function block(name='stone',p=new Vec3(2,64,0)){cells.set(key(p),name);return bot.blockAt(p);}
  return{bot,client,bridge,ctx,run,owner,storage,writes,signals,physical,block,deps,ready,pause:()=>{tokenPaused=true;},replaceOwner:()=>{current={task:{id:'ownerB'},context:{id:'ctxB'}};return current;},failCancel:()=>{failCancel=true;}};
}
test('installed native dig is awaited and only native packets provide start/finish signals',{timeout:5000},async t=>{
  const f=fixture(t),block=f.block();await f.run(()=>f.bridge.digBlock(block,f.ctx));
  assert.deepEqual(f.writes.filter(w=>w.name==='block_dig').map(w=>w.data.status),[0,2]);assert.equal(f.bot.targetDigBlock,null);
  assert.deepEqual(f.signals.filter(s=>s!=='native_dig_swing'),['native_dig_started','native_dig_finish_packet']);
});
test('pause uses exact installed cancel, settles native promise and cannot emit late finish',{timeout:5000},async t=>{
  const f=fixture(t),pending=f.run(()=>f.bridge.digBlock(f.block('obsidian'),f.ctx));pending.catch(()=>{});
  await until(()=>f.writes.some(w=>w.name==='block_dig'&&w.data.status===0));f.pause();
  await assert.rejects(pending,e=>e.code==='paused');assert.equal(f.bot.targetDigBlock,null);
  assert.deepEqual(f.writes.filter(w=>w.name==='block_dig').map(w=>w.data.status),[0,1]);await sleep(100);assert.equal(f.writes.filter(w=>w.name==='block_dig'&&w.data.status===2).length,0);
});
test('a revoked owner at the native finish timer is cancelled without an uncaught exception or completion',{timeout:5000},async t=>{
  const f=fixture(t,{beforeSend:({writes,pause})=>{const start=writes.find(w=>w.name==='block_dig'&&w.data.status===0);if(start&&Date.now()-start.at>240)pause();}});
  await assert.rejects(f.run(()=>f.bridge.digBlock(f.block(),f.ctx)),e=>e.code==='paused');
  assert.deepEqual(f.writes.filter(w=>w.name==='block_dig').map(w=>w.data.status),[0,1]);assert.equal(f.bot.targetDigBlock,null);
});
test('late pre-start look cannot stop a new owner native dig or restore its replaced look method',{timeout:5000},async t=>{
  const f=fixture(t);await f.ready;const look=f.bot.lookAt;let lookStarted=false;
  f.bot.lookAt=async(...args)=>{lookStarted=true;await look.apply(f.bot,args);await sleep(220);};
  const pending=f.run(()=>f.bridge.digBlock(f.block('obsidian'),f.ctx));pending.catch(()=>{});await until(()=>lookStarted);
  const next=f.replaceOwner(),foreignLook=(...args)=>look.apply(f.bot,args);f.bot.lookAt=foreignLook;
  const nextBlock=f.block('stone',new Vec3(1,64,1)),second=f.storage.run(next.context,()=>f.bot.dig(nextBlock,false,'raycast'));
  await assert.rejects(pending,e=>e.code==='movement_preempted');await second;
  const packets=f.writes.filter(w=>w.name==='block_dig');assert.equal(packets.filter(w=>w.data.status===0&&w.data.location.equals(new Vec3(2,64,0))).length,0);
  assert.equal(packets.filter(w=>w.data.status===1).length,0);assert.equal(f.bot.lookAt,foreignLook);
});
test('foreign writer replacement is never overwritten by old cancellation cleanup',{timeout:5000},async t=>{
  const f=fixture(t),pending=f.run(()=>f.bridge.digBlock(f.block('obsidian'),f.ctx));pending.catch(()=>{});await until(()=>f.writes.some(w=>w.name==='block_dig'&&w.data.status===0));
  const previous=f.client.write,foreign=function(...args){return previous.apply(this,args);};f.client.write=foreign;f.pause();
  await assert.rejects(pending,e=>e.code==='paused');assert.equal(f.client.write,foreign);assert.equal(f.bot.targetDigBlock,null);
});
test('cancel transport failure is bounded UNKNOWN and preserves the original control reason',{timeout:8000},async t=>{
  const f=fixture(t),pending=f.run(()=>f.bridge.digBlock(f.block('obsidian'),f.ctx));pending.catch(()=>{});await until(()=>f.writes.some(w=>w.name==='block_dig'&&w.data.status===0));f.failCancel();f.pause();
  await assert.rejects(pending,e=>e.code==='house_fluid_native_cleanup_pending'&&e.nativeSettlement==='UNKNOWN'&&e.cause.code==='paused'&&e.cleanupError.code==='SOCKET_CANCEL');
  assert.equal(f.writes.some(w=>w.name==='block_dig'&&w.data.status===2),false);
});
test('real native movement uses no-dig cardinal profile and restores only its owned instance',{timeout:5000},async t=>{
  const f=fixture(t),old=f.bot.pathfinder.movements;await f.run(()=>f.bridge.moveTo({x:1,y:64,z:0},f.ctx));
  assert.equal(f.bot.pathfinder.movements,old);assert.equal(f.bot.entity.onGround,true);assert.ok(f.bot.entity.position.floored().equals(new Vec3(1,64,0)));
});
test('a replaced owner/profile is not overwritten when an old movement settles',{timeout:5000},async t=>{
  let resolve;const f=fixture(t,{deps:{goto:()=>new Promise(r=>{resolve=r;})}}),pending=f.run(()=>f.bridge.moveTo({x:1,y:64,z:0},f.ctx));pending.catch(()=>{});await until(()=>resolve);
  f.replaceOwner();const foreign=new Movements(f.bot);f.bot.pathfinder.setMovements(foreign);resolve();
  await assert.rejects(pending,e=>e.code==='movement_preempted');assert.equal(f.bot.pathfinder.movements,foreign);
});

// These are dependency contracts with explicitly modeled window_items ACKs;
// they do not claim real-server raw acquisition or an integrated house build.
function commitStock(f,items){const slots=Array.from({length:46},()=>Item.toNotch(null));items.forEach((i,n)=>{const item=new Item(registry.itemsByName[i.name].id,i.count);if(i.damage!=null)item.components=[{type:'damage',data:i.damage}];slots[36+n]=Item.toNotch(item);});f.client.emit('window_items',{windowId:0,stateId:2,items:slots,carriedItem:Item.toNotch(null)});}
test('material factory prepares actual bucket/tool contracts and merges fluid CP without erasing nested quarry updates',{timeout:5000},async t=>{
  const f=fixture(t),anchor={x:0,y:64,z:0},task=f.owner.task;task.materialSupply={schema:1,quarry:{before:true}};
  // This modeled component starts after the water dependency has been met;
  // acquisition from an empty water slot has a separate original-provider test.
  commitStock(f,[{name:'diamond_pickaxe',count:1,damage:1557},{name:'water_bucket',count:1}]);const ensured=[],returned=[];let config;
  const source={getCamp:()=>anchor,ensure:async requirements=>{ensured.push(requirements);task.materialSupply={...task.materialSupply,quarry:{nestedConfirmed:true}};
    commitStock(f,[{name:'diamond_pickaxe',count:1,damage:1557},...(requirements.diamond_pickaxe?[{name:'diamond_pickaxe',count:1}]:[]),{name:'bucket',count:requirements.bucket||2}]);}};
  const runtimeProvider=api.createHouseFluidMaterialProvider({...f.deps,ownerTask:task,source,report:()=>{},getProtectedPositions:()=>[],
    returnHouseCamp:async p=>{await f.bridge.moveTo(p,f.ctx);returned.push(p);},createProvider:c=>{config=c;return{gatherObsidian:async()=>{await c.ensureBucket(2,{...f.ctx,anchor});await c.ensureDiamondPickaxe({...f.ctx,anchor,minDurability:10});c.saveCP({schema:1,anchor,confirmed:true});commitStock(f,[{name:'obsidian',count:1},{name:'diamond_pickaxe',count:1},{name:'bucket',count:2}]);}};}});
  const result=await f.run(()=>runtimeProvider.acquireRaw('obsidian',1,{...f.ctx,anchor,exclusionBounds:[]}));
  assert.equal(result.actualAdditional,1);assert.deepEqual(ensured,[{bucket:2},{diamond_pickaxe:2}]);assert.ok(returned.length>=3);
  assert.equal(task.materialSupply.quarry.nestedConfirmed,true);assert.equal(task.materialSupply.fluid.confirmed,true);assert.equal(config.limits.operationTimeoutMs,1800000);
});
test('material factory only completes bounded batches after actual interpreted inventory increases',{timeout:5000},async t=>{
  const f=fixture(t),anchor={x:0,y:64,z:0},task=f.owner.task;task.materialSupply={schema:1};let amount=0;const batches=[];
  // Modeled starting stock satisfies the preceding water dependency.
  commitStock(f,[{name:'diamond_pickaxe',count:1},{name:'water_bucket',count:1}]);
  const provider=api.createHouseFluidMaterialProvider({...f.deps,ownerTask:task,source:{getCamp:()=>anchor,ensure:async()=>{}},report:()=>{},
    returnHouseCamp:async()=>{},createProvider:()=>({gatherObsidian:async n=>{batches.push(n);amount+=n;commitStock(f,[{name:'obsidian',count:amount},{name:'diamond_pickaxe',count:1}]);}})});
  const result=await f.run(()=>provider.acquireRaw('obsidian',5,{...f.ctx,anchor}));assert.deepEqual(batches,[4,1]);assert.equal(result.actualAdditional,5);
  await assert.rejects(f.run(()=>provider.acquireRaw('obsidian',NaN,{...f.ctx,anchor})),e=>e.code==='house_fluid_invalid_request');
});
test('material factory rejects a callback claiming success without a real inventory increase',{timeout:5000},async t=>{
  const f=fixture(t),anchor={x:0,y:64,z:0};f.owner.task.materialSupply={schema:1};
  // Modeled starting stock satisfies the preceding water dependency.
  commitStock(f,[{name:'diamond_pickaxe',count:1},{name:'water_bucket',count:1}]);
  const provider=api.createHouseFluidMaterialProvider({...f.deps,ownerTask:f.owner.task,source:{getCamp:()=>anchor,ensure:async()=>{}},report:()=>{},returnHouseCamp:async()=>{},createProvider:()=>({gatherObsidian:async()=>({confirmed:true})})});
  await assert.rejects(f.run(()=>provider.acquireRaw('obsidian',1,{...f.ctx,anchor})),e=>e.code==='house_fluid_no_progress');
});

test('parent pause cleanup throwing at its first cancelled-owner status1 is repaired by one exact native cancel',{timeout:5000},async t=>{
  const f=fixture(t),pending=f.run(()=>f.bridge.digBlock(f.block('obsidian'),f.ctx));pending.catch(()=>{});
  await until(()=>f.writes.some(w=>w.name==='block_dig'&&w.data.status===0));f.pause();
  f.storage.run(f.owner.context,()=>assert.throws(()=>f.bot.stopDigging(),e=>e.code==='paused'));
  await assert.rejects(pending,e=>e.code==='paused');assert.equal(f.bot.targetDigBlock,null);
  assert.deepEqual(f.writes.filter(w=>w.name==='block_dig').map(w=>w.data.status),[0,1]);
});
