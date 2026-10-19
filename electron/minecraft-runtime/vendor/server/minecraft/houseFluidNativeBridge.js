/* global require, module, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask */
'use strict';
const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { classifyMiningBlock } = require('./miningNavigation');
const { inspectFluidSurfaceSupport } = require('./houseFluidResources');
const { hasGroundedBodySupport } = require('./houseSurfaceGraph');
const cancelScopes = new WeakMap(), frames = new WeakMap();
const point = p => ({x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)});
const same = (a,b) => a && b && ['x','y','z'].every(k=>a[k]===b[k]);
const fail = (code,message,extra={}) => Object.assign(new Error(message),{code,...extra});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

// Optional escape in the outer houseNativeSourceGuard, restricted to one
// synchronous invocation of the captured installed stopDigging function.
function isOwnedFluidNativeCancel(bot,name,data) {
  const session=cancelScopes.get(bot?._client);
  return Boolean(name==='block_dig' && data?.status===1 && session?.cancelling===true
    && session.bot===bot && session.client===bot._client && bot.targetDigBlock===session.block
    && bot.stopDigging===session.stopFunction && same(data.location,session.block.position));
}
function unwrap(fn) { while(frames.get(fn)?.active===false)fn=frames.get(fn).previous;return fn; }
function wrap(target,key,build) {
  const frame={previous:target[key],active:true};const own=build(frame);frames.set(own,frame);target[key]=own;
  return ()=>{frame.active=false;if(target[key]===own)target[key]=unwrap(frame.previous);};
}
function createHouseFluidNativeBridge(deps) {
  for(const name of ['getBot','captureOwner','assertOwner','isOwnerCurrent','isOwnerContext','runPhysicalAction','abortOwner','withMovements','restoreMovements','goto','waitGround','guardNative','equipNative']) {
    if(typeof deps[name]!=='function')throw fail('house_fluid_bridge_dependency',`流体桥接缺少 ${name}`);
  }
  if(deps.sourceGuardSupportsOwnedCancel!==true)throw fail('house_fluid_bridge_cancel_guard_pending','外层source guard必须先接通精确原生cancel例外');
  const owner=deps.captureOwner(),bot=deps.getBot(),client=bot._client;
  const assert=()=>{deps.assertOwner(owner);if(deps.getBot()!==bot||bot._client!==client)throw fail('house_fluid_owner_changed','旧流体桥接连接已更换');};
  let busy=false;
  async function digBlock(block,ctx) {
    assert();ctx.beforeSend();if(busy||bot.targetDigBlock)throw fail('house_fluid_native_busy','不能抢占其它原生挖掘');
    busy=true;
    const session={bot,client,block,owner,started:false,settled:false,cancelling:false,cancelAttempted:false,stopFunction:null,error:null,cleanupError:null,signal:null,lastSwing:0};
    let monitor,nativePromise,disposeWrite=()=>{},disposeLook=()=>{},disposed=false;
    function dispose(){if(disposed)return;disposed=true;clearInterval(monitor);disposeLook();disposeWrite();busy=false;}
    function captureStop(){if(session.started&&bot.targetDigBlock===block&&!session.stopFunction)session.stopFunction=bot.stopDigging;}
    function stopOwn(){
      captureStop();
      if(session.cancelAttempted||deps.getBot()!==bot||bot._client!==client||bot.targetDigBlock!==block||!session.stopFunction||bot.stopDigging!==session.stopFunction)return false;
      session.cancelAttempted=true;
      session.cancelling=true;cancelScopes.set(client,session);
      try{session.stopFunction.call(bot);return true;}catch(error){session.cleanupError={code:error.code||null,message:error.message};return false;}
      finally{session.cancelling=false;if(cancelScopes.get(client)===session)cancelScopes.delete(client);}
    }
    function rejectOwner(error){session.error ||= error;stopOwn();}
    async function actualNativeDig(signal){
      session.signal=signal;
      disposeLook=wrap(bot,'lookAt',frame=>function(...args){
        if(!frame.active||!deps.isOwnerContext(owner))return frame.previous.apply(this,args);
        assert();ctx.assertActive();
        return Promise.resolve(frame.previous.apply(this,args)).then(value=>{assert();ctx.assertActive();return value;});
      });
      disposeWrite=wrap(client,'write',frame=>function(name,data,...rest){
        if(!frame.active||!deps.isOwnerContext(owner))return frame.previous.call(this,name,data,...rest);
        if(name==='block_dig'&&same(data?.location,block.position)) {
          if(isOwnedFluidNativeCancel(bot,name,data))return frame.previous.call(this,name,data,...rest);
          try{assert();ctx.beforeSend();}catch(error){
            session.error ||= error;
            // finishDigging is a timer callback. Do not throw an uncaught
            // exception from it or leave diggingTask hanging; reject it via
            // the installed exact stop function and deny the finish packet.
            if(data.status===2){stopOwn();return;}
            throw error;
          }
          let result;try{result=frame.previous.call(this,name,data,...rest);}catch(error){session.error ||= error;if(data.status===2){stopOwn();return;}throw error;}
          if(data.status===0){session.started=true;signal('native_dig_started');queueMicrotask(captureStop);}
          if(data.status===2)signal('native_dig_finish_packet');
          return result;
        }
        if(name==='arm_animation'&&session.started&&bot.targetDigBlock===block&&Date.now()-session.lastSwing>=5000){
          try{assert();ctx.assertActive();}catch(error){rejectOwner(error);return;}session.lastSwing=Date.now();signal('native_dig_swing');
        }
        return frame.previous.call(this,name,data,...rest);
      });
      nativePromise=Promise.resolve().then(()=>{assert();ctx.beforeSend();return bot.dig(block,false,'raycast');});
      nativePromise.then(()=>{session.settled=true;},()=>{session.settled=true;});
      monitor=setInterval(()=>{try{assert();ctx.assertActive();captureStop();}catch(error){rejectOwner(error);}},20);
      let value;try{value=await nativePromise;}catch(error){throw session.error || error;}
      if(session.error)throw session.error;
      assert();ctx.assertActive();return value;
    }
    try {
      return await deps.runPhysicalAction('act','bot.dig.fluid',actualNativeDig,{timeoutMs:120000,requireStartupSignal:false,
        startupGraceMs:120000,stallMs:120000,allowCompleteAsSignal:false,stageKind:'gather',isOwnerCurrent:()=>deps.isOwnerCurrent(owner)});
    } catch(error) {
      session.error ||= error;stopOwn();
      if(nativePromise&&!session.settled){
        let timer;const done=await Promise.race([nativePromise.then(()=>true,()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);clearTimeout(timer);
        if(!done){
          const pending=fail('house_fluid_native_cleanup_pending','原生挖掘未确认结束，暂停并保留旧session保护',{nativeSettlement:'UNKNOWN',cause:{code:session.error.code,message:session.error.message},cleanupError:session.cleanupError});
          deps.abortOwner(pending,owner);
          // Never uninstall guards while an old native continuation can still
          // resume. It will be denied at look/start/finish; late settlement
          // disposes only our own wrappers and never an external replacement.
          clearInterval(monitor);nativePromise.then(dispose,dispose);throw pending;
        }
      }
      const primary=session.error;if(session.cleanupError)primary.nativeCleanupError=session.cleanupError;
      throw primary;
    } finally {if(!nativePromise||session.settled)dispose();}
  }
  async function moveTo(p,ctx) {
    assert();ctx.assertActive();const previous=bot.pathfinder.movements;
    const targetDry=()=>inspectFluidSurfaceSupport(q=>{assert();ctx.assertActive();return bot.blockAt(q);},{...p,y:p.y-1}).safe
      && [0,1].every(dy=>classifyMiningBlock(bot.blockAt(new Vec3(p.x,p.y+dy,p.z))).passable);
    if(!targetDry())throw fail('house_fluid_unsafe','原生流体目标没有确认完整静态支撑链与干燥身体净空');
    const movements=new Movements(bot);movements.canDig=false;movements.allowParkour=false;movements.allowFreeMotion=false;
    movements.allowSprinting=false;movements.allow1by1towers=false;movements.scafoldingBlocks=[];movements.maxDropDown=2;
    movements.infiniteLiquidDropdownDistance=false;movements.maxWaterDist=0;
    if(ctx.strictCardinal===true)movements.getMoveDiagonal=()=>{};
    movements.exclusionAreasStep.push(cell=>{
      if(!cell?.position||typeof cell.position.offset!=='function')return 100;
      if((ctx.avoidFloors||[]).some(q=>same(q,cell.position.offset(0,-1,0))))return 100;
      const floor=point(cell.position.offset(0,-1,0)),below=bot.blockAt(cell.position.offset(0,-1,0)),c=classifyMiningBlock(below);
      if(!below||c.hazard||c.gravity&&!inspectFluidSurfaceSupport(p=>{assert();ctx.assertActive();return bot.blockAt(p);},floor).safe)return 100;
      return [0,1].every(dy=>{const b=bot.blockAt(cell.position.offset(0,dy,0)),c=classifyMiningBlock(b);return b&&!c.hazard&&!c.gravity;})?0:100;
    });
    try{
      return await deps.withMovements(movements,async()=>{
        assert();ctx.assertActive();await deps.goto(new goals.GoalBlock(p.x,p.y,p.z),{timeoutMs:15000,lease:owner.lease,preserveMovements:true,isOwnerCurrent:()=>deps.isOwnerCurrent(owner)});
        await deps.waitGround(p,ctx);assert();ctx.assertActive();
        if(!same(point(bot.entity.position),p)||!hasGroundedBodySupport(bot)||!targetDry()||Math.abs(bot.entity.position.y-p.y)>0.075)throw fail('house_fluid_ground_unconfirmed','原生流体移动没有确认目标干燥落稳');
      },owner);
    } finally {if(deps.isOwnerCurrent(owner)&&deps.getBot()===bot&&bot._client===client&&bot.pathfinder.movements===movements)deps.restoreMovements(previous,movements,owner);}
  }
  const guarded=async(ctx,action)=>{assert();ctx.assertActive();const value=await deps.guardNative(owner,ctx,action);assert();ctx.assertActive();return value;};
  return {digBlock,moveTo,returnToCamp:moveTo,
    equipItem:(name,ctx)=>guarded(ctx,()=>deps.equipNative(name,ctx)),
    lookAt:async(p,ctx)=>{assert();ctx.assertActive();await bot.lookAt(new Vec3(p.x,p.y,p.z),false);assert();ctx.assertActive();},
    waitForTicks:async(n,ctx)=>{assert();await bot.waitForTicks(n);assert();ctx.assertActive();},
    activateItem:ctx=>guarded(ctx,()=>{ctx.beforeSend();bot.activateItem();}),
    collectDrops:async ctx=>{assert();ctx.assertActive();if(ctx.allowMovement!==false)throw fail('house_fluid_collector_invalid','流体拾取不能启动额外寻路');await bot.waitForTicks(12);assert();ctx.assertActive();},
    getOwner:()=>owner};
}
function createHouseFluidMaterialProvider(deps) {
  const owner=deps.ownerTask,source=deps.source,bridge=createHouseFluidNativeBridge(deps);
  const active=()=>deps.assertOwner(bridge.getOwner());
  const stock=name=>{
    const count=deps.getBot().inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);
    if(!Number.isSafeInteger(count)||count<0)throw fail('house_fluid_inventory_invalid',`真实 ${name} 数量未确认`);
    return count;
  };
  const durability=item=>Number(deps.getBot().registry.items[item.type]?.maxDurability)-Number(item.durabilityUsed||0);
  const provider=deps.createProvider({ ...bridge,getBot:deps.getBot,assertActive:active,
    getCP:()=>owner.materialSupply?.fluid,
    saveCP:value=>{active();owner.materialSupply={...owner.materialSupply,fluid:JSON.parse(JSON.stringify(value))};},
    getProtectedPositions:deps.getProtectedPositions,report:deps.report,
    ensureBucket:async(count,ctx)=>{active();ctx.assertActive();await source.ensure({bucket:count});active();ctx.assertActive();await deps.returnHouseCamp(ctx.anchor);active();ctx.assertActive();
      if(stock('bucket')<count)throw fail('house_fluid_bucket_unconfirmed','自采合成后未确认真实空桶');},
    ensureDiamondPickaxe:async ctx=>{active();ctx.assertActive();
      const valid=()=>deps.getBot().inventory.items().find(i=>i.name==='diamond_pickaxe'&&durability(i)>=ctx.minDurability);
      if(!valid())await source.ensure({diamond_pickaxe:stock('diamond_pickaxe')+1});
      active();ctx.assertActive();await deps.returnHouseCamp(ctx.anchor);active();ctx.assertActive();
      if(!valid())throw fail('house_fluid_tool_unconfirmed','未确认实际耐久充足的钻石镐');},
    onOperationTimeout:error=>{active();deps.abortOwner(error,bridge.getOwner());},
    limits:{operationTimeoutMs:1800000,timeoutMs:1800000,...deps.providerLimits} });
  return {async acquireRaw(name,additional,context){
    active();context.assertActive();if(!Number.isSafeInteger(additional)||additional<1||additional>64)throw fail('house_fluid_invalid_request','流体raw批次必须为1至64实际新增量');
    if(!['water_bucket','obsidian'].includes(name))throw fail('house_fluid_resource_invalid','流体bridge仅接收水桶或黑曜石');
    const camp=source.getCamp();if(!same(camp,context.anchor))throw fail('house_fluid_camp_changed','不能改变固定施工营地');
    if(name==='obsidian'&&stock('water_bucket')<1){
      const held=stock('obsidian');
      if(!Number.isSafeInteger(held)||held<0||held>4096)throw fail('house_fluid_inventory_invalid','已有黑曜石数量未确认');
      await source.ensure({water_bucket:1,...(held>0?{obsidian:held}:{})});active();context.assertActive();
      if(stock('water_bucket')<1||stock('obsidian')<held)throw fail('house_fluid_water_unconfirmed','未确认真实水桶或已持黑曜石共存');
    }
    await deps.prepareCapacity?.(name,additional,context);active();context.assertActive();await deps.returnHouseCamp(camp);active();context.assertActive();
    const target=stock(name)+additional;
    const method=name==='water_bucket'?'gatherWater':'gatherObsidian';const batch=name==='water_bucket'?2:4;
    for(let pass=0;stock(name)<target&&pass<32;pass+=1){
      const before=stock(name);await provider[method](Math.min(batch,target-before),{anchor:camp,excludeBounds:context.exclusionBounds||[],protectedPositions:[]});active();context.assertActive();
      if(stock(name)<=before)throw fail('house_fluid_no_progress','流体自采没有确认实际背包净增长');
    }
    active();if(stock(name)<target)throw fail('house_fluid_batch_limit','流体自采达到有限批次上限');return{confirmed:true,resource:name,actualAdditional:stock(name)-(target-additional)};
  },getProvider:()=>provider};
}
module.exports={createHouseFluidNativeBridge,createHouseFluidMaterialProvider,isOwnedFluidNativeCancel};
