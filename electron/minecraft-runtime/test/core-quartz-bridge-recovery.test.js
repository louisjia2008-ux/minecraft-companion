'use strict';
// Acknowledged input transitions below are MODELED. No Java or live body is
// attached; original trip guards and return dispatch are exercised directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createPortalTrip } = require('../core/netherTrip');
const { createNetherQuartzGoal } = require('../core/goals/netherQuartz');
const end = require('../core/end');
const nether = require('../core/nether');
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function fixture() {
  const cells = new Map(), route = Array.from({ length: 11 }, (_, i) => new Vec3(0,70,-i));
  const portal = new Vec3(-1,70,0), owned = new Set(), events = [], calls = [];
  for (let z=-11;z<=1;z++) for (let x=-1;x<=1;x++) {
    cells.set(`${x},69,${z}`,'cobblestone'); if(z<0) owned.add(`${x},69,${z}`);
    if(x!==0) for(const y of [70,71]) cells.set(`${x},${y},${z}`,'cobblestone');
  }
  cells.set('0,69,0','obsidian'); cells.set(key(portal),'nether_portal');
  cells.set('0,70,-12','air'); cells.set('-1,69,-12','air'); cells.set('-1,70,-12','air');
  const m = { companionNether:true, companionWalkOnly:true, canDig:false, allowParkour:false,
    allow1by1towers:false, maxDropDown:1, scafoldingBlocks:[], getNeighbors:()=>[],
    exclusionAreasStep:[], exclusionAreasBreak:[], exclusionAreasPlace:[], blocksCantBreak:new Set() };
  let epoch=1, owner={}, reader;
  const bot = Object.assign(new EventEmitter(), { version:'1.21.8', registry, entities:{}, health:20,food:20,
    entity:{position:new Vec3(.5,70,-8.75),onGround:true,width:.6,height:1.8},
    game:{dimension:'the_nether',minY:0,height:256}, pathfinder:{movements:m,setGoal(){}},
    clearControlStates(){}, setControlState(){},
    inventory:{items:()=>[{name:'cooked_beef',count:4},{name:'stone_pickaxe',count:1}],slots:Array(46).fill(null)},
    blockAt(p){p=p.floored();const name=cells.get(key(p))||(p.y<70?'basalt':'air');if(name==='UNKNOWN')return null;
      const b=Block.fromStateId(registry.blocksByName[name].defaultState);b.position=p;return b;}, findBlocks:()=>[] });
  reader=()=>bot.companionBodyLife===reader?{owner,epoch}:null; bot.companionBodyLife=reader;
  bot.inventory.slots[5]={name:'golden_helmet',count:1};bot.world={getBlock:bot.blockAt,raycast:()=>null};
  const used={down:1,flat:0,feet:1,digs:1,nativeDigAttempts:1,outboundEdges:1,returnEdges:0,knownEdges:0,totalEdges:1,diamondRock:0,actualDiamondWear:0};
  const ledger={route:[new Vec3(0,70,-12),new Vec3(-1,69,-12)],routeIndex:1,routeFeet:new Set(['0,70,-12','-1,69,-12']),
    protectedFloors:new Set(['0,69,-12','-1,68,-12']),open:new Set(['-1,69,-12']),confirmedDigCredit:1,used};
  const goal=createNetherQuartzGoal({bot,actions:{pickFood:()=>({name:'cooked_beef'}),haltBody(){}},
    excavationFactory:()=>({returnOne:async()=>{calls.push('quarryReturn');return{ok:false,reason:'off_confirmed_route'};},
      walkKnownOne:async()=>{calls.push('quarryForward');return{ok:false,reason:'off_confirmed_route'};}})});
  Object.assign(goal.memory,{netherPortal:portal.clone(),overworldPortal:new Vec3(0,64,0),ledgeRoute:route.map(p=>p.clone()),ledgeSupports:new Set(owned),
    quartzExcavationAnchor:{shore:new Vec3(0,70,-12),portal:portal.clone(),anchorMode:'portal'},quartzExcavationTarget:new Vec3(-4,67,-14),quartzExcavation:ledger});
  const context=(controller=new AbortController())=>({signal:controller.signal,record:(type,data)=>events.push({type,...data}),
    perceive:()=>({health:20,food:20,hostiles:[],inventory:{stone_pickaxe:1,cooked_beef:4}})});
  const trip=createPortalTrip({bot,memory:goal.memory,actions:{},walkOnly:true,protectedBridge:true});
  return{bot,goal,trip,cells,route,portal,owned,events,calls,m,ledger,used,context,life:()=>reader(),
    die(){epoch++;bot.emit('death');},changeOwner(){owner={};epoch=0;},cleanup(){goal.dispose();trip.dispose();}};
}

test('fresh owned bridge admission uses original full guard and accepts actual offset beyond quarry centre',()=>{
  const f=fixture();try{const r=f.trip.inspectConfirmedBridgeReturn();assert.equal(r.ok,true);assert.equal(r.index,9);
    assert.equal(r.nextTarget,'0,70,-8');assert.equal(r.actualPortalEndObserved,false);assert.equal(r.progress,false);
    assert.equal(f.bot.entity.position.z,-8.75);assert.equal(f.used.digs,1);}finally{f.cleanup();}
});

test('real goal off quarry on fresh confirmed bridge delegates original native return instead of quarry rejoin',async t=>{
  const f=fixture();try{t.mock.method(end,'bridgeStep',async()=>{f.calls.push('nativeBridge');return{ok:false,reason:'modeled_native_stop'};});
    const r=await f.goal.run(f.context());assert.equal(r.reason,'modeled_native_stop');assert.deepEqual(f.calls,['nativeBridge']);
    assert.equal(f.goal.memory.quartzExcavationReturning,true);assert.ok(f.goal.memory.quartzBridgeRecovery);
    assert.notEqual(f.goal.memory.quartzExcavationAtShore,true);assert.equal(r.progress,false);assert.equal(f.used.feet,1);
  }finally{f.cleanup();}
});

for(const fault of ['unknown','hazard','partial','no_shapes','unowned','not_bridge','airborne','bad_profile','no_life'])test(`bridge recovery refuses ${fault} without movement or quarry credit`,()=>{
  const f=fixture();try{
    if(fault==='unknown')f.cells.set('0,69,-8','UNKNOWN');
    if(fault==='hazard')f.cells.set('0,70,-7','fire');
    if(fault==='partial')f.cells.set('0,69,-8','cobblestone_slab');
    if(fault==='no_shapes'){const read=f.bot.blockAt;f.bot.blockAt=p=>{const b=read(p);if(key(p)==='0,69,-8')delete b.shapes;return b;};}
    if(fault==='unowned')f.goal.memory.ledgeSupports.delete('0,69,-9');
    if(fault==='not_bridge')f.bot.entity.position=new Vec3(4.5,70,-8.5);
    if(fault==='airborne')f.bot.entity.onGround=false;
    if(fault==='bad_profile')f.m.canDig=true;
    if(fault==='no_life')delete f.bot.companionBodyLife;
    assert.equal(f.trip.inspectConfirmedBridgeReturn().ok,false);assert.equal(f.used.feet,1);assert.deepEqual(f.calls,[]);
  }finally{f.cleanup();}
});

test('initial current-life fresh geometry may create witness from an older candidate cache, not old ACK authority',()=>{
  const f=fixture();try{f.changeOwner();const r=f.trip.inspectConfirmedBridgeReturn();assert.equal(r.ok,true);
    assert.equal(r.life.epoch,0);assert.equal(r.life.owner,f.life().owner);}finally{f.cleanup();}
});

test('fresh endpoint requires original same-life initial witness; retraced boolean grants nothing',()=>{
  const f=fixture();try{const initial=f.trip.inspectConfirmedBridgeReturn();f.bot.entity.position=new Vec3(.5,70,.5);
    assert.equal(f.trip.inspectConfirmedBridgeReturn().ok,false);
    const r=f.trip.inspectConfirmedBridgeReturn(initial.witness);assert.equal(r.ok,true);assert.equal(r.actualPortalEndObserved,true);
    f.die();assert.equal(f.trip.inspectConfirmedBridgeReturn(initial.witness).ok,false);
  }finally{f.cleanup();}
});

test('witness canonical portal or route changes and fresh support destruction are rejected',()=>{
  for(const fault of ['portal','route','floor','wall']){const f=fixture();try{
    const w=f.trip.inspectConfirmedBridgeReturn().witness;
    if(fault==='portal')f.cells.set(key(f.portal),'air');
    if(fault==='route')f.goal.memory.ledgeRoute[2]=new Vec3(1,70,-2);
    if(fault==='floor')f.cells.set('0,69,-8','air');
    if(fault==='wall')f.cells.set('1,71,-8','air');
    assert.equal(f.trip.inspectConfirmedBridgeReturn(w).ok,false,fault);
  }finally{f.cleanup();}}
});

test('joined cancellation at actual route0 before retraced ACK retains witness, then native portal can complete',async t=>{
  const f=fixture(),controller=new AbortController();try{
    let release,started;
    const held=new Promise(resolve=>{release=resolve;});const begin=new Promise(resolve=>{started=resolve;});
    t.mock.method(end,'bridgeStep',async()=>{f.calls.push('nativeBridge');// MODELED post-cancel input at route0, not a claim this stub traversed intermediate cells.
      f.bot.entity.position=new Vec3(.5,70,.5);controller.abort('cancel_at_origin');started();await held;return{ok:false,reason:'modeled_cancel_before_ack'};});
    const running=f.goal.run(f.context(controller));
    assert.equal(await Promise.race([begin.then(()=>true),running.then(()=>false)]),true,'native return must begin before retirement');f.goal.dispose();
    assert.equal((await f.goal.run(f.context())).reason,'quartz_retirement_pending');
    release();await running;const witness=f.goal.memory.quartzBridgeRecovery;assert.ok(witness);assert.notEqual(f.goal.memory.quartzExcavationAtShore,true);
    t.mock.method(nether,'travel',async()=>{f.calls.push('nativePortal');f.bot.game.dimension='overworld';return{ok:true};});
    t.mock.method(nether,'leavePortal',async()=>({ok:true}));t.mock.method(nether,'findPortal',()=>null);
    const result=await f.goal.run(f.context());assert.equal(result.ok,true);assert.ok(f.calls.includes('nativePortal'));
    assert.equal(f.goal.memory.quartzBridgeRecovery,null);assert.equal(f.used.digs,1);assert.equal(f.used.feet,1);
    assert.ok(f.events.some(x=>x.type==='quartz_bridge_recovery'&&x.actualPortalEndObserved===true));
  }finally{f.cleanup();}
});

test('death while cached goal is inactive invalidates endpoint and pickup without ledger refund',async t=>{
  const f=fixture();try{t.mock.method(end,'bridgeStep',async()=>({ok:false,reason:'modeled_native_stop'}));
    await f.goal.run(f.context());f.goal.memory.quartzExcavationAtShore=true;f.goal.memory.quartzExcavationAtShoreEpoch=0;
    f.goal.memory.quartzExcavationPickup={position:new Vec3(-4,67,-14),before:7,epoch:0,attempts:0};
    f.goal.dispose();f.die();f.bot.entity.position=new Vec3(.5,70,.5);
    const r=await f.goal.run(f.context());assert.equal(r.reason,'off_confirmed_route');
    assert.equal(f.goal.memory.quartzBridgeRecovery,null);assert.equal(f.goal.memory.quartzExcavationAtShore,false);
    assert.equal(f.goal.memory.quartzExcavationPickup,null);assert.equal(f.used.digs,1);assert.equal(f.used.totalEdges,1);
  }finally{f.cleanup();}
});

test('caller abort on late portal result cannot manufacture OW handoff or restore old recovery state',async t=>{
  const f=fixture(),controller=new AbortController();try{
    t.mock.method(end,'bridgeStep',async()=>{controller.abort('late_portal_cancel');return{ok:false,reason:'modeled_native_stop'};});
    const r=await f.goal.run(f.context(controller));assert.equal(r.ok,false);
    assert.notEqual(f.goal.memory.quartzExcavationAtShore,true);assert.equal(f.used.digs,1);
    assert.equal(f.events.filter(x=>x.type==='quartz_bridge_recovery').length,1,'only synchronous initial admission recorded');
  }finally{f.cleanup();}
});

test('last read life replacement invalidates a proposal before witness creation',()=>{
  const f=fixture();try{let reads=0;const read=f.bot.blockAt;
    f.bot.blockAt=p=>{if(++reads===20)f.changeOwner();return read(p);};
    const r=f.trip.inspectConfirmedBridgeReturn();assert.equal(r.ok,false);assert.equal(r.reason,'bridge_observation_changed');
    assert.equal(f.goal.memory.quartzBridgeRecovery,undefined);
  }finally{f.cleanup();}
});

test('direct quartz goal without reliable connection owner cannot create a new bridge recovery witness',async t=>{
  const f=fixture();try{delete f.bot.companionBodyLife;
    t.mock.method(end,'bridgeStep',async()=>{f.calls.push('nativeBridge');return{ok:true};});
    const r=await f.goal.run(f.context());assert.equal(r.reason,'off_confirmed_route');
    assert.equal(f.calls.includes('nativeBridge'),false);assert.ok(!f.goal.memory.quartzBridgeRecovery);
    assert.equal(f.used.digs,1);
  }finally{f.cleanup();}
});

for (const outcome of ['success','failure','throw']) test(`inspection ${outcome} keeps durable support identity and contents unchanged`,()=>{
  const f=fixture();try{
    const original=f.goal.memory.ledgeSupports;
    for(const x of [-1,1])for(const z of [-10,-9,-8])original.delete(`${x},69,${z}`);
    const before=[...original];let reads=0;
    f.bot.companionPlacedRecently=()=>{if(outcome==='throw'&&++reads===2)throw Error('modeled_read_error');return true;};
    if(outcome==='failure')f.cells.set('1,71,-8','air');
    if(outcome==='throw')assert.throws(()=>f.trip.inspectConfirmedBridgeReturn(),/modeled_read_error/);
    else assert.equal(f.trip.inspectConfirmedBridgeReturn().ok,outcome==='success');
    assert.equal(f.goal.memory.ledgeSupports,original);assert.deepEqual([...original],before);
  }finally{f.cleanup();}
});

test('a callback replacement of supports is preserved and rejects inspection instead of clobbering new owner',()=>{
  const f=fixture();try{
    const original=f.goal.memory.ledgeSupports,newer=new Set(['new_owner']),before=[...original];let replaced=false;
    f.bot.companionPlacedRecently=()=>{if(!replaced){replaced=true;f.goal.memory.ledgeSupports=newer;}return true;};
    const r=f.trip.inspectConfirmedBridgeReturn();assert.equal(r.ok,false);assert.equal(r.reason,'bridge_observation_changed');
    assert.equal(f.goal.memory.ledgeSupports,newer);assert.deepEqual([...newer],['new_owner']);assert.deepEqual([...original],before);
  }finally{f.cleanup();}
});

test('a nested inspection cannot use private recent-support observations as durable admission',()=>{
  const f=fixture();try{let nested;f.bot.companionPlacedRecently=()=>{if(!nested)nested=f.trip.inspectConfirmedBridgeReturn();return true;};
    assert.equal(f.trip.inspectConfirmedBridgeReturn().ok,true);assert.equal(nested.ok,false);assert.equal(nested.reason,'bridge_inspection_reentrant');
  }finally{f.cleanup();}
});

test('original native guard observation still records durable placed supports outside readonly inspection',()=>{
  const f=fixture();try{
    const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),file=path.resolve(__dirname,'../core/netherTrip.js');
    const loaded=new Module(file,module);loaded.filename=file;loaded.paths=module.paths;
    loaded._compile(fs.readFileSync(file,'utf8').replace('return { memory, enterNetherMode,','return { nativeGuardPlan: guardPlan, memory, enterNetherMode,'),file);
    const support='1,69,-9';f.goal.memory.ledgeSupports.delete(support);f.bot.companionPlacedRecently=p=>key(p)===support;
    const trip=loaded.exports.createPortalTrip({bot:f.bot,memory:f.goal.memory,walkOnly:true,protectedBridge:true});
    try{const r=trip.nativeGuardPlan({feet:new Vec3(0,70,-9),ahead:new Vec3(0,70,-8),dir:new Vec3(0,0,1)});
      assert.equal(r.ok,true);assert.equal(f.goal.memory.ledgeSupports.has(support),true,'original native tracking is retained');}
    finally{trip.dispose();}
  }finally{f.cleanup();}
});

test('synchronous cancellation by admission record prevents entering the next trip operation',async t=>{
  const f=fixture(),controller=new AbortController();try{let lateReads=0,native=0;
    t.mock.method(end,'bridgeStep',async()=>{native++;return{ok:true};});
    const ctx=f.context(controller),record=ctx.record;ctx.record=(type,data)=>{record(type,data);
      if(type==='quartz_bridge_recovery'&&data.phase==='fresh_admission'){
        controller.abort('record_cancel');const read=f.bot.blockAt;
        f.bot.blockAt=p=>{if(controller.signal.aborted)lateReads++;return read(p);};
      }};
    let result;try{result=await f.goal.run(ctx);}catch(error){result={ok:false,reason:error.code};}
    assert.equal(result.ok,false);assert.equal(native,0);assert.equal(lateReads,0,'no old-scope trip entry reads after callback cancellation');
    assert.equal(f.used.feet,1);assert.equal(f.used.digs,1);
  }finally{f.cleanup();}
});
