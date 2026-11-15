'use strict';
// Real installed Movements, path follower, core actions and vanilla movement
// simulator; model block acknowledgements only. No Java/server gameplay claim.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{EventEmitter}=require('node:events');
const fs=require('node:fs'),crypto=require('node:crypto');
const tracePath=process.env.QUARTZ_EXCAVATION_TRACE_PATH || path.join(require('node:os').tmpdir(),`minecraft-quartz-native-physics-${process.pid}-${Date.now()}.jsonl`);
const helperSHA256=crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../core/quartzExcavation'))).digest('hex');
let fixtureSequence=0;
const runtime = path.resolve(__dirname, '..');
const req=name=>require(path.join(runtime,'node_modules',name));
const {Vec3}=req('vec3'),data=req('minecraft-data')('1.21.8'),registry=req('prismarine-registry')('1.21.8');
const Block=req('prismarine-block')(registry),{Physics,PlayerState}=req('prismarine-physics'),{pathfinder,Movements,goals}=req('mineflayer-pathfinder');
const Item=req('prismarine-item')(registry);
const actions=require(path.join(runtime,'core/actions')), {inspectStep}=require(path.join(runtime,'core/mining'));
const {NEVER_BREAK}=require(path.join(runtime,'core/nether')),{createExcavation}=require('../core/quartzExcavation');
const key=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function physicalFixture({descend=false,cancelDuringMove=false,nativeDigging=false,branded=false,rootAdapter=false}={}) {
  const fixtureId=++fixtureSequence;
  const cells=new Map(),events=[],paths=[],samples=[],nativeDigs=[],packets=[],controls=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false]));
  const put=(p,name)=>cells.set(key(p),name),controller=new AbortController(),shore=new Vec3(0,70,0),portal=new Vec3(0,70,10);
  for(const y of [70,71])put(new Vec3(1,y,0),'basalt');put(portal,'nether_portal');
  const tool=new Item(registry.itemsByName.stone_pickaxe.id,1);tool.slot=36;
  const bot=Object.assign(new EventEmitter(),{registry,version:'1.21.8',health:20,food:20,game:{dimension:'the_nether',minY:0,height:256},
    entities:{},controlState:controls,jumpTicks:0,jumpQueued:false,fireworkRocketDuration:0,
    entity:{position:new Vec3(.5,70,.5),velocity:new Vec3(0,0,0),onGround:true,yaw:0,pitch:0,effects:{},attributes:{},height:1.8,width:.6,
      isInWater:false,isInLava:false,isInWeb:false,isCollidedHorizontally:false,isCollidedVertically:false,elytraFlying:false,eyeHeight:1.62},
    heldItem:tool,inventory:{items:()=>[tool],slots:Array(46).fill(null)},
    blockAt:p=>{p=p.floored();const name=cells.get(key(p))||(p.y<70?'basalt':'air');return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState),{position:p});},
    setControlState:(name,value)=>{controls[name]=value;},getControlState:name=>controls[name],
    clearControlStates:()=>{for(const n of Object.keys(controls))controls[n]=false;},
    canDigBlock:()=>true,equip:async item=>{bot.heldItem=item;},
    look:async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch;},
    lookAt:async point=>{const d=point.minus(bot.entity.position.offset(0,1.62,0));bot.entity.yaw=Math.atan2(-d.x,-d.z);bot.entity.pitch=Math.atan2(d.y,Math.hypot(d.x,d.z));},
  });
  bot.dig=async block=>{
    nativeDigs.push({cell:key(block.position),position:bot.entity.position.clone(),onGround:bot.entity.onGround,tool:bot.heldItem.name});
    const before=bot.blockAt(block.position);put(block.position,'air');bot.heldItem.durabilityUsed++;
    bot.emit('blockUpdate',before,bot.blockAt(block.position));await new Promise(resolve=>setImmediate(resolve));
  };
  bot.stopDigging=()=>{};
  bot._client={write:(name,packet)=>packets.push({name,packet,aborted:controller.signal.aborted,ticks:samples.length})};
  bot.getEquipmentDestSlot=()=>5;bot.swingArm=()=>{};
  bot._updateBlockState=(point)=>{const before=bot.blockAt(point);put(point,'air');const after=bot.blockAt(point);bot.emit('blockUpdate',before,after);bot.emit(`blockUpdate:${point}`,before,after);};
  if(nativeDigging)require(path.join(runtime,'node_modules/mineflayer/lib/plugins/digging.js'))(bot);
  const world={getBlock:p=>bot.blockAt(p)};bot.physics=Physics(data,world);pathfinder(bot);
  const m=new Movements(bot);Object.assign(m,{canDig:false,allowParkour:false,allow1by1towers:false,allowSprinting:false,maxDropDown:1,
    scafoldingBlocks:[],companionWalkOnly:true,companionNether:true});bot.pathfinder.setMovements(m);
  if(branded){
    const original=m.getNeighbors;
    const guard=function(node,...args){return Reflect.apply(original,this,[node,...args]).filter(n=>n.y>=node.y-1&&n.y<=node.y+1&&!n.toBreak?.length&&!n.toPlace?.length);};
    m.maxDropDown=2;m.infiniteLiquidDropdownDistance=false;m.companionPhysicalDropLimit=1;m.companionPhysicalDropGuard=guard;m.getNeighbors=guard;
  }
  let restoreRoot;
  if(rootAdapter){
    m.companionWalkOnly=false;m.maxDropDown=4;
    restoreRoot=require('../core/nether').applyWalkOnlyMovements(bot);
  }
  let offrouteExclusions=0;
  const originalExclusion=m.exclusionStep.bind(m);
  m.exclusionStep=block=>{const result=originalExclusion(block);if(result===Infinity)offrouteExclusions++;return result;};
  bot.on('path_update',r=>paths.push({status:r.status,path:r.path?.map(p=>({x:p.x,y:p.y,z:p.z})),ticks:samples.length}));
  let moveStarted=false;
  const ctx={signal:controller.signal,record:(type,event)=>{events.push({type,...event,tick:samples.length});if(event.stage==='move_start')moveStarted=true;}};
  const memory={},helper=createExcavation({bot,memory,shore,portal,inspectStep,Vec3,actions,makeGoal:p=>new goals.GoalBlock(p.x,p.y,p.z),
    foodCount:()=>4,threatened:()=>false,neverBreak:NEVER_BREAK});
  // Only initial state is assigned. Every subsequent pose/velocity/onGround
  // update is PlayerState.apply from uninterrupted simulator ticks.
  const timer=setInterval(()=>{
    const state=new PlayerState(bot,controls);bot.physics.simulatePlayer(state,world).apply(bot);
    samples.push({position:bot.entity.position.clone(),velocity:bot.entity.velocity.clone(),onGround:bot.entity.onGround,controls:{...controls}});
    bot.emit('physicsTick');
    if(cancelDuringMove&&moveStarted&&bot.entity.position.x>.57&&!controller.signal.aborted)controller.abort('native tick cancel');
  },5);
  return{bot,memory,helper,ctx,controller,events,samples,paths,nativeDigs,packets,controls,m,cells,put,
    get offrouteExclusions(){return offrouteExclusions;},
    close:()=>{
      clearInterval(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();
      fs.appendFileSync(tracePath,JSON.stringify({classification:'NATIVE_MODEL_CONTINUOUS_PHYSICS_NOT_JAVA_SERVER',fixtureId,
        options:{descend,cancelDuringMove,nativeDigging,branded,rootAdapter},helperSHA256,simulationTickMs:50,wallIntervalMs:5,
        noPoseAssignmentsAfterInitialState:true,samples,events,paths,nativeDigs,packets,offrouteExclusions,
        final:{position:bot.entity.position,velocity:bot.entity.velocity,onGround:bot.entity.onGround,controls:{...controls},
          route:memory.quartzExcavation?.route,routeIndex:memory.quartzExcavation?.routeIndex,used:memory.quartzExcavation?.used,
          confirmedDigCredit:memory.quartzExcavation?.confirmedDigCredit}})+'\n');
      restoreRoot?.();
    },
    direction:{direction:0,descend},waitTicks:async n=>{const until=samples.length+n;while(samples.length<until)await new Promise(r=>setTimeout(r,5));},
  };
}

test('native follower+continuousPhysics physically executes one excavated flat edge and returns',async()=>{
  const f=physicalFixture();try{
    await f.waitTicks(3);
    const out=await f.helper.advance(f.ctx,f.direction);assert.equal(out.ok,true,JSON.stringify({out,position:f.bot.entity.position,samples:f.samples.slice(-4),digs:f.nativeDigs,events:f.events.slice(-6),paths:f.paths}));
    assert.equal(f.memory.quartzExcavation.used.feet,1);assert.equal(f.bot.entity.onGround,true);
    assert.ok(f.samples.length>=3);assert.ok(f.samples.some(s=>s.position.x>.6&&s.position.x<1.2));
    const back=await f.helper.returnOne(f.ctx);assert.equal(back.atActualShore,true,JSON.stringify(back));
    assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,70,.5))<=.3);assert.equal(f.nativeDigs.length,2);
    assert.ok(f.offrouteExclusions>0);assert.ok(f.paths.some(p=>p.status==='success'));
    for(const p of f.paths)for(const n of p.path||[])assert.ok(['0,70,0','1,70,0'].includes(key(n)),JSON.stringify(n));
  }finally{f.close();}
});
test('native branded actual1 profile stays exactly branded after its own edge mask down and return',async()=>{
  const f=physicalFixture({descend:true,branded:true});try{
    await f.waitTicks(3);const guard=f.m.companionPhysicalDropGuard;
    assert.equal((await f.helper.advance(f.ctx,f.direction)).ok,true);
    assert.equal(f.m.maxDropDown,2);assert.equal(f.m.getNeighbors,guard);
    assert.equal((await f.helper.returnOne(f.ctx)).atActualShore,true);
    assert.equal(f.m.getNeighbors,guard);assert.equal(f.m.maxDropDown,2);assert.equal(f.m.companionPhysicalDropLimit,1);
    assert.equal(f.m.infiniteLiquidDropdownDistance,false);
  }finally{f.close();}
});
test('last synchronous native start guard closes the microtask gap after a fresh look resolves',async()=>{
  const f=physicalFixture({nativeDigging:true});try{
    await f.waitTicks(3);const originalRecord=f.ctx.record,originalLook=f.bot.lookAt,originalWrite=f.bot._client.write,originalDig=f.bot.dig;
    f.ctx.record=(type,event)=>{originalRecord(type,event);if(event.stage==='native_look_fresh')queueMicrotask(()=>f.controller.abort('abort queued after fresh look'));};
    await assert.rejects(f.helper.advance(f.ctx,f.direction),{code:'aborted'});
    assert.equal(f.packets.filter(p=>p.name==='block_dig'&&p.packet.status===0).length,0);
    assert.equal(f.bot.lookAt,originalLook);assert.equal(f.bot._client.write,originalWrite);assert.equal(f.bot.dig,originalDig);
    assert.equal(f.memory.quartzExcavation.confirmedDigCredit,0);
  }finally{f.close();}
});
test('actual installed native dig delayedlook cancellation never dispatches a new start after abort',async()=>{
  const f=physicalFixture({nativeDigging:true});try{
    await f.waitTicks(3);let looks=0;
    f.bot.lookAt=async()=>{looks++;await f.waitTicks(3);f.controller.abort('cancel during real native look');};
    await assert.rejects(f.helper.advance(f.ctx,f.direction),{code:'aborted'});
    assert.equal(looks,1);assert.equal(f.packets.filter(p=>p.name==='block_dig'&&p.packet.status===0).length,0);
    assert.equal(f.memory.quartzExcavation.confirmedDigCredit,0);assert.equal(f.memory.quartzExcavation.used.feet,0);
  }finally{f.close();}
});
test('actual installed native digging plugin completes the normal guarded path before nativePhysics walks the edge',async()=>{
  const f=physicalFixture({nativeDigging:true});try{
    await f.waitTicks(3);const out=await f.helper.advance(f.ctx,f.direction);assert.equal(out.ok,true,JSON.stringify(out));
    assert.equal(f.packets.filter(p=>p.name==='block_dig'&&p.packet.status===0).length,2);
    assert.equal(f.packets.filter(p=>p.name==='block_dig'&&p.packet.status===2).length,2);
    assert.equal(f.memory.quartzExcavation.confirmedDigCredit,2);assert.equal(f.memory.quartzExcavation.used.digs,2);
    assert.equal(f.memory.quartzExcavation.used.feet,1);assert.equal(f.bot.entity.onGround,true);
    assert.ok(f.samples.length>20);assert.ok(f.paths.some(p=>p.status==='success'));
  }finally{f.close();}
});
test('actual installed native dig delayedlook physically displaced body cannot dispatch a stale start',async()=>{
  const f=physicalFixture({nativeDigging:true});try{
    await f.waitTicks(3);let looks=0;
    f.bot.lookAt=async()=>{looks++;f.bot.setControlState('back',true);await f.waitTicks(12);f.bot.clearControlStates();};
    const r=await f.helper.advance(f.ctx,f.direction);assert.equal(r.ok,false);
    assert.equal(looks,1);assert.ok(f.samples.some(s=>Math.abs(s.position.z-.5)>.2));
    assert.equal(f.packets.filter(p=>p.name==='block_dig'&&p.packet.status===0).length,0);
    assert.equal(f.memory.quartzExcavation.confirmedDigCredit,0);assert.equal(f.memory.quartzExcavation.used.feet,0);
  }finally{f.close();}
});
test('nativePhysics owns descent and jump-up reverse, then known-route forward without newfoot credit',async()=>{
  const f=physicalFixture({descend:true});try{
    await f.waitTicks(3);
    const down=await f.helper.advance(f.ctx,f.direction);assert.equal(down.ok,true,JSON.stringify({down,position:f.bot.entity.position,samples:f.samples.slice(-4),events:f.events.slice(-6),paths:f.paths}));
    assert.equal(f.memory.quartzExcavation.used.down,1);assert.equal(f.bot.entity.onGround,true);assert.equal(Math.floor(f.bot.entity.position.y),69);
    assert.equal(f.m.maxDropDown,1);assert.equal(Object.hasOwn(f.m,'getNeighbors'),false);
    assert.ok(f.samples.some(s=>s.position.y<70&&s.position.y>69));
    const up=await f.helper.returnOne(f.ctx);assert.equal(up.atActualShore,true,JSON.stringify(up));
    assert.equal(f.bot.entity.onGround,true);assert.equal(Math.floor(f.bot.entity.position.y),70);
    assert.ok(f.samples.some(s=>s.controls.jump));const feet=f.memory.quartzExcavation.used.feet,digs=f.nativeDigs.length;
    const again=await f.helper.walkKnownOne(f.ctx,{towards:'front'});assert.equal(again.atActualFront,true,JSON.stringify(again));
    assert.equal(f.memory.quartzExcavation.used.feet,feet);assert.equal(f.nativeDigs.length,digs);
    assert.equal(f.memory.quartzExcavation.used.totalEdges,3);
    assert.equal(f.m.maxDropDown,1);assert.equal(Object.hasOwn(f.m,'getNeighbors'),false);
  }finally{f.close();}
});
test('cancel on a real movement tick joins the native follower and leaves no continuing controls or route credit',async()=>{
  const f=physicalFixture({cancelDuringMove:true});try{
    await f.waitTicks(3);
    await assert.rejects(f.helper.advance(f.ctx,f.direction),{code:'aborted'});
    assert.ok(f.samples.length>0);assert.equal(f.memory.quartzExcavation.used.feet,0);assert.equal(f.memory.quartzExcavation.used.totalEdges,0);
    const digs=f.nativeDigs.length;await f.waitTicks(20);assert.equal(f.nativeDigs.length,digs);
    assert.equal(f.bot.pathfinder.goal,null);assert.ok(Object.values(f.controls).every(v=>v===false));
    assert.equal(f.m.exclusionAreasStep.length,0);assert.equal(f.m.exclusionAreasBreak.length,0);assert.equal(f.m.exclusionAreasPlace.length,0);
    assert.equal(Object.hasOwn(f.m,'getNeighbors'),false);assert.equal(f.m.maxDropDown,1);
    assert.ok(f.bot.entity.velocity.norm()<.1);assert.equal(f.bot.entity.onGround,true);
  }finally{f.close();}
});
test('real core action swallowed second equip error cannot bypass the actual native dig entry guard',async()=>{
  const f=physicalFixture();try{
    await f.waitTicks(3);
    const cheap=f.bot.inventory.items()[0],diamond=new Item(registry.itemsByName.diamond_pickaxe.id,1);diamond.slot=37;diamond.durabilityUsed=1520;
    f.bot.inventory.items=()=>[cheap,diamond];let equips=0;
    f.bot.equip=async tool=>{if(++equips===1){f.bot.heldItem=tool;return;}f.bot.heldItem=diamond;throw new Error('real-action equip failure');};
    const r=await f.helper.advance(f.ctx,f.direction);assert.equal(r.ok,false);assert.equal(f.nativeDigs.length,0);
    assert.equal(diamond.durabilityUsed,1520);assert.equal(f.memory.quartzExcavation.used.nativeDigAttempts,0);
    assert.equal(f.memory.quartzExcavation.used.diamondRock,0);assert.ok(f.samples.length>20);
  }finally{f.close();}
});

test('current runtime physical-one-drop adapter composes with exact excavation masks and real digging plugin',async()=>{
  const f=physicalFixture({descend:true,nativeDigging:true,rootAdapter:true});try{
    await f.waitTicks(3);
    const guard=f.m.companionPhysicalDropGuard;
    assert.equal(f.m.maxDropDown,2);assert.equal(f.m.companionPhysicalDropLimit,1);assert.equal(f.m.getNeighbors,guard);
    assert.equal(f.m.infiniteLiquidDropdownDistance,false);
    const outward=await f.helper.advance(f.ctx,f.direction);assert.equal(outward.ok,true);
    assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.position.floored().y,69);
    assert.equal(f.memory.quartzExcavation.used.feet,1);assert.equal(f.memory.quartzExcavation.used.down,1);
    assert.ok(f.packets.some(p=>p.name==='block_dig'&&p.packet.status===0));
    assert.equal(f.m.getNeighbors,guard);assert.equal(f.m.canDig,false);assert.deepEqual(f.m.scafoldingBlocks,[]);
    const back=await f.helper.returnOne(f.ctx);assert.equal(back.ok,true);assert.equal(back.atActualShore,true);
    assert.equal(f.memory.quartzExcavation.used.feet,1);assert.equal(f.memory.quartzExcavation.routeIndex,0);
    assert.equal(f.m.getNeighbors,guard);assert.equal(f.m.maxDropDown,2);
  }finally{f.close();}
});

test('native continuous Physics executes ranked flat entrance and its next flat edge with original hard mask',async()=>{
 const f=physicalFixture({branded:true});try{
  f.put(new Vec3(2,69,1),'air');f.put(new Vec3(1,69,-2),'air');await f.waitTicks(3);
  const before=f.bot.entity.position.clone();const proposal=f.helper.proposeDirections(f.ctx,{candidates:[{direction:0,descend:true},{direction:0,descend:false}]});
  assert.equal(proposal.preferred.descend,false);assert.equal(proposal.progress,false);assert.equal(f.memory.quartzExcavation,undefined);assert.deepEqual(f.bot.entity.position,before);assert.equal(f.nativeDigs.length,0);
  const first=await f.helper.advance(f.ctx,{direction:proposal.preferred.direction,descend:proposal.preferred.descend});assert.equal(first.ok,true,JSON.stringify(first));
  await f.waitTicks(3);const secondProposal=f.helper.proposeDirections(f.ctx,{candidates:[{direction:0,descend:false}]});assert.equal(secondProposal.preferred?.descend,false);
  const second=await f.helper.advance(f.ctx,{direction:0,descend:false});assert.equal(second.ok,true,JSON.stringify(second));
  assert.equal(f.memory.quartzExcavation.used.feet,2);assert.equal(f.memory.quartzExcavation.used.flat,2);assert.equal(f.memory.quartzExcavation.used.down,0);assert.equal(f.bot.entity.onGround,true);
  assert.ok(f.samples.some(s=>s.position.x>.6&&s.position.x<1.2));assert.ok(f.samples.some(s=>s.position.x>1.6&&s.position.x<2.2));assert.ok(f.nativeDigs.length>=2);
  assert.equal((await f.helper.returnOne(f.ctx)).ok,true);assert.equal((await f.helper.returnOne(f.ctx)).atActualShore,true);assert.equal(f.memory.quartzExcavation.used.feet,2);
 }finally{f.close();}
});
test('native continuous Physics UNKNOWN query preserves original order without controls, movement or ledger credit',async()=>{
 const f=physicalFixture({branded:true});try{
  f.put(new Vec3(2,69,1),'air');f.put(new Vec3(1,69,-2),'air');await f.waitTicks(3);
  const original=f.bot.blockAt;f.bot.blockAt=p=>key(p)==='4,70,0'?null:original(p);const before=f.bot.entity.position.clone(),tool=f.bot.heldItem.durabilityUsed;
  const proposal=f.helper.proposeDirections(f.ctx,{candidates:[{direction:0,descend:true},{direction:0,descend:false}]});
  assert.equal(proposal.rankingUncertain,true);assert.equal(proposal.preferred.descend,true);assert.equal(proposal.orderPolicy,'original_first_admitted_on_uncertainty');
  assert.deepEqual(f.bot.entity.position,before);assert.equal(f.memory.quartzExcavation,undefined);assert.equal(f.nativeDigs.length,0);assert.equal(f.bot.heldItem.durabilityUsed,tool);assert.equal(Object.values(f.controls).some(Boolean),false);
  f.bot.blockAt=original;
 }finally{f.close();}
});
