/* MODELED goal phase contracts. These do not simulate a Java server or authorize movement. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {EventEmitter}=require('node:events');
const {Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.8'),Block=require('prismarine-block')(registry);

function fixture(){
  const calls={tripOwners:0,trip:0,outbound:0,quarry:0,factories:0,toNether:0},events=[],blocks=new Map();
  let portalLedge=false,returnImpl=null,tripImpl=null;
  const bot=Object.assign(new EventEmitter(),{entity:{position:new Vec3(.5,70,.5),onGround:true},
    game:{dimension:'the_nether'},health:20,food:20,
    blockAt(p){p=p.floored();const k=`${p.x},${p.y},${p.z}`;if(blocks.has(k)&&blocks.get(k)===null)return null;
      const b=Block.fromStateId(registry.blocksByName[blocks.get(k)||(p.y<70?'basalt':'air')].defaultState);b.position=p;return b;},
    inventory:{items:()=>[{name:'stone_pickaxe',count:1},{name:'cooked_beef',count:4}],slots:[]},registry:{foodsByName:{cooked_beef:{}}}});
  const filename=path.resolve(__dirname,'../core/goals/netherQuartz.js'),loaded=new Module(filename,module),native=Module.createRequire(filename);
  loaded.filename=filename;loaded.paths=module.paths;
  loaded.require=id=>id==='../netherTrip'?{createPortalTrip:({memory})=>{
    calls.tripOwners++;return{enterNetherMode(){},leaveNetherMode(){},netherPortal:()=>memory.netherPortal,
      wearGold:async()=>{},portalProgress:()=>0,bridgeBlocks:()=>450,setBridgeResupply:v=>{memory.ledgeResupply=v;},
      ledge:()=>portalLedge?[]:null,leaveLedge:async()=>{calls.outbound++;return{ok:true,progress:false,outbound:true};},
      toNether:async()=>{calls.toNether++;return{ok:true};},
      toOverworld:async ctx=>{calls.trip++;return tripImpl?tripImpl(ctx):{ok:true,progress:false,tripRun:true};},dispose(){}};
  }}:native(id);
  loaded._compile(fs.readFileSync(filename,'utf8'),filename);
  const engine={returnOne:async ctx=>{calls.quarry++;if(returnImpl)return returnImpl(ctx);
    return bot.entity.position.floored().equals(new Vec3(0,70,0))?{ok:true,atActualShore:true,progress:false}:{ok:false,reason:'off_confirmed_route',progress:false};}};
  const goal=loaded.exports.createNetherQuartzGoal({bot,actions:{pickFood:()=>({name:'cooked_beef'})},
    excavationFactory:()=>{calls.factories++;return engine;}});
  const used={down:1,flat:0,feet:1,digs:1,nativeDigAttempts:1,totalEdges:2,returnEdges:1};
  const ledger={route:[new Vec3(0,70,0),new Vec3(1,69,0)],routeIndex:0,used,confirmedDigCredit:1};
  Object.assign(goal.memory,{fortress:new Vec3(1000,70,1000),netherPortal:new Vec3(10,70,0),quartzExcavationAnchor:{shore:new Vec3(0,70,0),portal:new Vec3(10,70,0),anchorMode:'portal'},
    quartzExcavation:ledger,quartzExcavationReturning:true,quartzExcavationExhausted:true});
  const ctx={signal:new AbortController().signal,record:(type,data)=>events.push({type,...data}),perceive:()=>({inventory:{cooked_beef:4},hostiles:[]})};
  return{bot,goal,calls,ctx,ledger,used,events,blocks,setPortalLedge:v=>{portalLedge=v;},setReturn:fn=>{returnImpl=fn;},setTrip:fn=>{tripImpl=fn;}};
}

async function confirmedShore(f){
  const result=await f.goal.run(f.ctx);assert.equal(result.atActualShore,true);assert.equal(f.calls.quarry,1);assert.equal(f.calls.trip,0);
  assert.equal(f.goal.memory.quartzExcavationAtShore,true);return result;
}

test('a confirmed quarry return at the portal ledge continues inward instead of selecting outbound leaveLedge',async()=>{
  const f=fixture();try{
    await confirmedShore(f);
    // A distinct actual trip position in this MODELED phase fixture, never a live bot.
    f.bot.entity.position=new Vec3(10.5,70,.5);f.setPortalLedge(true);
    const result=await f.goal.run(f.ctx);
    assert.equal(f.calls.outbound,0);assert.equal(f.calls.quarry,1);assert.equal(f.calls.trip,1);assert.equal(result.tripRun,true);
  }finally{f.goal.dispose();}
});

test('multi-run protected bridge travel after actual shore handoff never re-enters the quarry executor',async()=>{
  const f=fixture();try{
    await confirmedShore(f);
    for(const x of [2.5,5.5,8.5]){f.bot.entity.position=new Vec3(x,70,.5);const result=await f.goal.run(f.ctx);assert.equal(result.tripRun,true);}
    assert.equal(f.calls.quarry,1);assert.equal(f.calls.trip,3);assert.equal(f.calls.outbound,0);
    assert.equal(f.goal.memory.quartzExcavation,f.ledger);assert.deepEqual(f.used,{down:1,flat:0,feet:1,digs:1,nativeDigAttempts:1,totalEdges:2,returnEdges:1});
  }finally{f.goal.dispose();}
});

test('joined cached cancellation preserves same-life shore handoff while fresh trip owners validate subsequent bridge runs',async()=>{
  const f=fixture();try{
    await confirmedShore(f);f.bot.entity.position=new Vec3(5.5,70,.5);f.goal.dispose();
    const result=await f.goal.run(f.ctx);
    assert.equal(result.tripRun,true);assert.equal(f.calls.tripOwners,2);assert.equal(f.calls.quarry,1);assert.equal(f.calls.factories,1);
    assert.equal(f.goal.memory.quartzExcavation,f.ledger);assert.equal(f.used.nativeDigAttempts,1);assert.equal(f.goal.memory.quartzExcavationAtShore,true);
  }finally{f.goal.dispose();}
});

test('death invalidates old actual-shore evidence even when an immediately full-health body is still outside the quarry route',async()=>{
  const f=fixture();try{
    await confirmedShore(f);f.bot.entity.position=new Vec3(5.5,70,.5);f.bot.emit('death');
    assert.equal(f.goal.memory.quartzExcavationAtShore,false);
    const result=await f.goal.run(f.ctx);assert.equal(result.reason,'off_confirmed_route');assert.equal(f.calls.trip,0);assert.equal(f.calls.quarry,2);
    assert.equal(f.goal.memory.quartzExcavation,f.ledger);assert.equal(f.used.digs,1);
  }finally{f.goal.dispose();}
});

test('an unconfirmed return or arbitrary off-route body never receives bridge handoff credit',async()=>{
  for(const offRoute of [false,true]){
    const f=fixture();try{
      if(offRoute)f.bot.entity.position=new Vec3(5.5,70,.5);
      else f.setReturn(async()=>({ok:true,progress:false,atActualShore:false}));
      const result=await f.goal.run(f.ctx);
      assert.notEqual(f.goal.memory.quartzExcavationAtShore,true);assert.equal(f.calls.trip,0);assert.equal(f.calls.outbound,0);
      if(offRoute)assert.equal(result.reason,'off_confirmed_route');
      assert.equal(f.used.feet,1);assert.equal(f.used.nativeDigAttempts,1);
    }finally{f.goal.dispose();}
  }
});

test('actual overworld observation clears only return handoff flags and retains terminal exhaustion and spent ledger',async()=>{
  const f=fixture();try{
    await confirmedShore(f);f.goal.memory.ledgeResupply=true;f.bot.game.dimension='minecraft:overworld';
    const result=await f.goal.run(f.ctx);
    assert.equal(result.reason,'quartz_excavation_budget_or_targets_exhausted');
    assert.equal(f.goal.memory.quartzExcavationAtShore,false);assert.equal(f.goal.memory.quartzExcavationReturning,false);
    assert.equal(f.goal.memory.ledgeResupply,true,'construction stock intent keeps its original450-block gate independently of quarry handoff');
    assert.equal(f.goal.memory.quartzExcavationExhausted,true);assert.equal(f.goal.memory.quartzExcavation,f.ledger);assert.equal(f.used.digs,1);
    assert.equal(f.calls.trip,0);assert.equal(f.calls.outbound,0);
  }finally{f.goal.dispose();}
});

test('caller abort rejects a late portal return result without clearing handoff or granting progress',async()=>{
  const f=fixture();let release;try{
    await confirmedShore(f);const controller=new AbortController();let entered;
    const started=new Promise(resolve=>{entered=resolve;});
    f.setTrip(async ctx=>{entered();await new Promise(resolve=>{release=resolve;});ctx.record('late_portal_result',{ok:true});return{ok:true,progress:true};});
    const running=f.goal.run({...f.ctx,signal:controller.signal});await started;controller.abort('cancel portal charge');release();
    const result=await running;assert.equal(result.ok,false);assert.equal(result.progress,false);assert.equal(f.events.some(e=>e.type==='late_portal_result'),false);
    assert.equal(f.goal.memory.quartzExcavationAtShore,true);assert.equal(f.goal.memory.quartzExcavationReturning,true);assert.equal(f.used.digs,1);
  }finally{release?.();f.goal.dispose();}
});


test('a late atActualShore result cannot grant handoff after the actual body has moved off the shore',async()=>{
  const f=fixture();try{
    f.setReturn(async()=>{f.bot.entity.position=new Vec3(5.5,70,.5);return{ok:true,atActualShore:true,progress:false};});
    const result=await f.goal.run(f.ctx);
    assert.equal(result.ok,false);assert.equal(result.reason,'quartz_shore_arrival_unconfirmed');
    assert.notEqual(f.goal.memory.quartzExcavationAtShore,true);assert.equal(f.calls.trip,0);assert.equal(f.used.digs,1);
  }finally{f.goal.dispose();}
});

test('death during a pending trip clears handoff and suppresses its old successful continuation',async()=>{
  const f=fixture();let release;try{
    await confirmedShore(f);let entered;const started=new Promise(resolve=>{entered=resolve;});
    f.setTrip(async ctx=>{entered();await new Promise(resolve=>{release=resolve;});ctx.record('late_dead_trip',{ok:true});return{ok:true,progress:true};});
    const running=f.goal.run(f.ctx);await started;f.bot.emit('death');release();
    const result=await running;
    assert.equal(result.ok,false);assert.equal(result.progress,false);assert.equal(f.goal.memory.quartzExcavationAtShore,false);
    assert.equal(f.events.some(e=>e.type==='late_dead_trip'),false);assert.equal(f.goal.memory.quartzExcavation,f.ledger);assert.equal(f.used.nativeDigAttempts,1);
  }finally{release?.();f.goal.dispose();}
});


for(const [cell,changed] of [
  ['0,69,0','air'],['0,69,0','stone_slab'],['0,69,0','gravel'],['0,69,0',null],
  ['0,70,0','basalt'],['0,71,0','fire'],['0,71,0','soul_fire'],['0,71,0','bubble_column'],['0,71,0',null],
])test(`handoff rechecks actual shore floor and body after the return await (${cell}:${changed})`,async()=>{
  const f=fixture();try{
    f.setReturn(async()=>{f.blocks.set(cell,changed);return{ok:true,atActualShore:true,progress:false};});
    const result=await f.goal.run(f.ctx);assert.equal(result.ok,false);assert.equal(result.reason,'quartz_shore_arrival_unconfirmed');
    assert.notEqual(f.goal.memory.quartzExcavationAtShore,true);assert.equal(f.calls.trip,0);assert.equal(f.used.nativeDigAttempts,1);
  }finally{f.goal.dispose();}
});

test('an unexpected non-Nether dimension cannot clear handoff proof or begin another portal trip',async()=>{
  const f=fixture();try{
    await confirmedShore(f);f.goal.memory.quartzExcavationExhausted=false;f.bot.game.dimension='the_end';
    const result=await f.goal.run(f.ctx);assert.equal(result.reason,'wrong_dimension');
    assert.equal(f.goal.memory.quartzExcavationAtShore,true);assert.equal(f.goal.memory.quartzExcavationReturning,true);
    assert.equal(f.calls.toNether,0);assert.equal(f.calls.trip,0);assert.equal(f.used.digs,1);
  }finally{f.goal.dispose();}
});


test('a full quartz inventory completes only in an actually observed overworld dimension',()=>{
  const f=fixture();try{
    const state={inventory:{quartz:16}};
    for(const dimension of ['the_nether','minecraft:the_nether','the_end','minecraft:the_end','',undefined]){
      f.bot.game.dimension=dimension;assert.equal(f.goal.isDone(state),false,String(dimension));
    }
    for(const dimension of ['overworld','minecraft:overworld']){
      f.bot.game.dimension=dimension;assert.equal(f.goal.isDone(state),true,dimension);
    }
    assert.equal(f.goal.isDone({inventory:{quartz:15}}),false);
  }finally{f.goal.dispose();}
});
