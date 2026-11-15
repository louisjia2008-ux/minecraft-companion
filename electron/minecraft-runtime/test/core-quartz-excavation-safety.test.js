'use strict';
// Pure model tests with the current runtime topology and 1.21.8 Block shapes.
// Fake action position changes are model acknowledgements, NEVER game/physics evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = path.resolve(__dirname, '..');
const { Vec3 } = require(path.join(runtime, 'node_modules/vec3'));
const registry = require(path.join(runtime, 'node_modules/minecraft-data'))('1.21.8');
const Block = require(path.join(runtime, 'node_modules/prismarine-block'))(registry);
const { inspectStep } = require(path.join(runtime, 'core/mining'));
const { NEVER_BREAK } = require(path.join(runtime, 'core/nether'));
const { createExcavation, CAPS } = require('../core/quartzExcavation');
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function fixture(options = {}) {
  const cells = new Map(), unknown = new Set(), events = [], calls = [], memory = {}, shore = new Vec3(0,70,0), portal = new Vec3(0,70,10);
  const put = (x,y,z,name,properties={}) => cells.set(`${x},${y},${z}`,{name,properties});
  for (const x of [-1,0]) for (const z of [-1,0]) for (const y of [70,71]) put(x,y,z,'air');
  put(0,70,10,'nether_portal',{axis:'x'});
  const blockAt = p => {
    p=p.floored(); if (unknown.has(key(p))) return null;
    const {name,properties}=cells.get(key(p))||{name:'basalt',properties:{axis:'y'}};
    const b=Block.fromProperties(registry.blocksByName[name].id,properties,0); b.position=p;return b;
  };
  const movements={companionWalkOnly:true,canDig:false,allowParkour:false,allow1by1towers:false,maxDropDown:1,scafoldingBlocks:[],
    exclusionAreasStep:[],exclusionAreasBreak:[],exclusionAreasPlace:[],getNeighbors:()=>[]};
  let items=[{name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,slot:36,maxDurability:131,durabilityUsed:0}];
  const bot={entity:{position:new Vec3(.5,70,.5),onGround:true},health:20,game:{dimension:'the_nether'},inventory:{items:()=>items},
    blockAt,pathfinder:{movements}};
  const controller=new AbortController(); let threatened=false;
  const ctx={signal:controller.signal,record:(type,data)=>events.push({type,...data})};
  bot.heldItem=items[0];
  bot.lookAt=async()=>{};bot._client={write:()=>{}};
  bot.equip=async tool=>{if(options.equipFailure)throw new Error('equip rejected');bot.heldItem=tool;};
  bot.dig=async b=>{
    bot._client.write('block_dig',{status:0,location:b.position});
    calls.push({kind:'dig',cell:key(b.position),tool:bot.heldItem?.name});
    if (!options.noDigMutation) put(b.position.x,b.position.y,b.position.z,'air');
    if(bot.heldItem&&!options.noWear)bot.heldItem.durabilityUsed++;
    await options.afterDig?.({bot,b,put,controller,calls});
    if(options.digFailure)throw new Error('native dig failed after wear');
  };
  const actions={
    async digBlock(_bot,_ctx,b,{tool}) {
      try{await bot.equip(tool);}catch{/* Match production's swallowed equip error. */}
      try{await bot.dig(b);}catch(e){if(e.code==='aborted')throw e;return{ok:false,reason:e.code||e.message};}
      return {ok:true}; },
    async goTo(_bot,_ctx,g) { calls.push({kind:'move',to:key(g)});
      assert.equal(movements.exclusionAreasStep.at(-1)({position:g}),0);
      assert.equal(movements.exclusionAreasStep.at(-1)({position:g.offset(1,0,1)}),Infinity);
      assert.equal(movements.exclusionAreasBreak.at(-1)({position:g}),Infinity);
      assert.equal(movements.exclusionAreasPlace.at(-1)({position:g}),Infinity);
      if (!options.noMoveMutation) bot.entity.position=g.offset(.5,0,.5);
      await options.afterMove?.({bot,controller,calls}); return {ok:true}; },
  };
  const configuration={bot,memory,shore,portal,inspectStep,Vec3,actions,makeGoal:p=>p,foodCount:()=>options.food??4,
    threatened:()=>threatened,neverBreak:NEVER_BREAK,allowDiamondFallback:options.allowDiamondFallback||false,
    ...(options.now?{now:options.now}:{})};
  const instance=createExcavation(configuration);
  return {bot,memory,put,unknown,events,calls,controller,ctx,instance,configuration,movements,items:value=>{items=value;},threat:value=>{threatened=value;}};
}

test('quartz explicit executor preserves the fixed accepted caps',()=>{
  assert.deepEqual(CAPS,{down:16,flat:48,feet:64,digs:192,diamondRock:64,nativeDigAttempts:192,
    outboundEdges:64,returnEdges:64,knownEdges:128,totalEdges:128,leaseMs:20000});
});
test('peer: known-forward must reserve all still-required actual return edges without refunds',async()=>{
  const f=fixture();f.items([{name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,slot:36,maxDurability:131,durabilityUsed:0}]);
  for(let i=0;i<48;i++)assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,true);
  for(let i=0;i<48;i++)assert.equal((await f.instance.returnOne(f.ctx)).ok,true);
  const s=f.memory.quartzExcavation;
  for(let i=0;i<16;i++)assert.equal((await f.instance.walkKnownOne(f.ctx,{towards:'front'})).ok,true);
  const calls=f.calls.length,r=await f.instance.walkKnownOne(f.ctx,{towards:'front'});
  assert.equal(r.reason,'return_reserve_required');assert.equal(f.calls.length,calls);assert.equal(s.routeIndex,16);
  for(let i=0;i<16;i++)assert.equal((await f.instance.returnOne(f.ctx)).ok,true);
  assert.equal(s.used.totalEdges,128);assert.equal(s.used.returnEdges,64);assert.equal(s.routeIndex,0);assert.equal(s.used.feet,48);
});
test('peer: failed cheap equip cannot spend a held diamond below its reserve or hide actual usage',async()=>{
  const f=fixture({equipFailure:true,allowDiamondFallback:true});
  const diamond={name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:37,maxDurability:1561,durabilityUsed:1520};
  const cheap={name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,slot:36,maxDurability:131,durabilityUsed:0};
  f.items([cheap,diamond]);f.bot.heldItem=diamond;
  const r=await f.instance.advance(f.ctx,{direction:0});assert.equal(r.ok,false);assert.equal(r.reason,'tool_equip_failed');
  assert.equal(f.calls.length,0);assert.equal(diamond.durabilityUsed,1520);assert.equal(f.memory.quartzExcavation.used.diamondRock,0);
});
test('peer: advance never revisits a confirmed historical foot or grows a looping route',async()=>{
  const f=fixture();await f.instance.advance(f.ctx,{direction:0});const calls=f.calls.length;
  const r=await f.instance.advance(f.ctx,{direction:2});assert.equal(r.reason,'revisited_route_refused');assert.equal(f.calls.length,calls);
  assert.equal(f.memory.quartzExcavation.route.length,2);assert.equal(f.memory.quartzExcavation.used.flat,1);
});
test('model one flat edge credits only read-back-open voxels and grounded arrival; reverse preserves budgets',async()=>{
  const f=fixture(),r=await f.instance.advance(f.ctx,{direction:0});assert.equal(r.ok,true);assert.equal(r.progress,false);
  assert.deepEqual(f.memory.quartzExcavation.used,{down:0,flat:1,feet:1,digs:2,diamondRock:0,nativeDigAttempts:2,
    outboundEdges:1,returnEdges:0,knownEdges:0,totalEdges:1,actualDiamondWear:0});
  assert.equal(f.calls.filter(x=>x.kind==='dig').length,2);assert.equal(f.calls.filter(x=>x.kind==='move').length,1);
  const b=await f.instance.returnOne(f.ctx);assert.equal(b.atActualShore,true);assert.equal(f.memory.quartzExcavation.used.feet,1);
  assert.equal(f.movements.exclusionAreasStep.length,0);assert.equal(f.movements.exclusionAreasBreak.length,0);assert.equal(f.movements.exclusionAreasPlace.length,0);
});
test('model one descent is three top-first digs and a reversible single edge, not physics proof',async()=>{
  const f=fixture(),r=await f.instance.advance(f.ctx,{direction:0,descend:true});assert.equal(r.ok,true);
  assert.deepEqual(f.calls.filter(x=>x.kind==='dig').map(x=>x.cell),['1,71,0','1,70,0','1,69,0']);
  assert.equal(f.memory.quartzExcavation.used.down,1);assert.equal((await f.instance.returnOne(f.ctx)).atActualShore,true);
});
for(const name of ['magma_block','lava','water','fire','soul_fire','powder_snow','oak_slab',...registry.blocksArray.filter(b=>b.name.endsWith('_concrete_powder')).map(b=>b.name)]) {
  test(`full-shape outer floor gate refuses ${name} before any action`,async()=>{
    const f=fixture();f.put(1,69,0,name,name==='oak_slab'?{type:'bottom',waterlogged:false}:{});
    assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,false);assert.equal(f.calls.length,0);
  });
}
for(const name of ['nether_gold_ore','gilded_blackstone','obsidian','chest','nether_portal','gravel']) {
  test(`ordinary-rock allowlist never opens ${name}`,async()=>{
    const f=fixture();f.put(1,70,0,name);assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,false);assert.equal(f.calls.length,0);
  });
}
test('unknown, adjacent lava, and an unrecorded cave below surface are all refusal',async()=>{
  for(const scenario of ['unknown','liquid','cave']) {
    const f=fixture();if(scenario==='unknown')f.unknown.add('2,70,0');if(scenario==='liquid')f.put(2,70,0,'lava');if(scenario==='cave')f.put(2,69,0,'air');
    assert.equal((await f.instance.advance(f.ctx,{direction:0,descend:scenario==='cave'})).ok,false);assert.equal(f.calls.length,0);
  }
});
test('a fake dig acknowledgement cannot create open or route credit',async()=>{
  const f=fixture({noDigMutation:true});assert.equal((await f.instance.advance(f.ctx,{direction:0})).reason,'actual_open_unconfirmed');
  assert.equal(f.memory.quartzExcavation.used.digs,0);assert.equal(f.memory.quartzExcavation.used.feet,0);assert.equal(f.memory.quartzExcavation.open.size,0);
});
test('a fake goto acknowledgement never credits a route foot',async()=>{
  const f=fixture({noMoveMutation:true});assert.equal((await f.instance.advance(f.ctx,{direction:0})).reason,'actual_edge_arrival_unconfirmed');
  assert.equal(f.memory.quartzExcavation.used.digs,2);assert.equal(f.memory.quartzExcavation.used.feet,0);
});
test('liquid after the first actual dig blocks the next dig and movement',async()=>{
  const f=fixture({afterDig:({put})=>put(1,70,0,'lava')});assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,false);
  assert.equal(f.calls.length,1);assert.equal(f.memory.quartzExcavation.used.digs,1);assert.equal(f.memory.quartzExcavation.used.feet,0);
  assert.equal(f.memory.quartzExcavation.confirmedDigCredit,0);
});
test('cancellation after a real model mutation accounts the voxel but never a route foot',async()=>{
  const f=fixture({afterDig:({controller})=>controller.abort('survival preemption')});
  await assert.rejects(f.instance.advance(f.ctx,{direction:0}),{code:'aborted'});
  assert.equal(f.calls.length,1);assert.equal(f.memory.quartzExcavation.used.digs,1);assert.equal(f.memory.quartzExcavation.used.feet,0);
});
test('cancellation during movement cleans exact hooks and gives no post-abort route credit',async()=>{
  const original=()=>0,f=fixture({afterMove:({controller})=>controller.abort('cancel')});f.movements.exclusionAreasStep.push(original);
  await assert.rejects(f.instance.advance(f.ctx,{direction:0}),{code:'aborted'});
  assert.equal(f.memory.quartzExcavation.used.feet,0);assert.deepEqual(f.movements.exclusionAreasStep,[original]);
  assert.deepEqual(f.movements.exclusionAreasBreak,[]);assert.deepEqual(f.movements.exclusionAreasPlace,[]);
});
test('cancelled-before-run and threat dispatch no new action',async()=>{
  const f=fixture();f.controller.abort();await assert.rejects(f.instance.advance(f.ctx,{direction:0}),{code:'aborted'});assert.equal(f.calls.length,0);
  const g=fixture();g.threat(true);assert.equal((await g.instance.advance(g.ctx,{direction:0})).reason,'threat_preempted');assert.equal(g.calls.length,0);
});
test('nearly broken, reserved-last16, or unknown-durability tools are not count-only supplies',async()=>{
  for(const durabilityUsed of [130,115,undefined]) {const f=fixture();f.items([{name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,maxDurability:131,durabilityUsed}]);
    assert.equal((await f.instance.advance(f.ctx,{direction:0})).reason,'needs_usable_pickaxe');assert.equal(f.calls.length,0);}
});
test('diamond fallback is explicit, logged, existing-only, and reserves its real wear margin',async()=>{
  const item=used=>({name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,maxDurability:1561,durabilityUsed:used});
  const a=fixture();a.items([item(0)]);assert.equal((await a.instance.advance(a.ctx,{direction:0})).reason,'needs_usable_pickaxe');
  const b=fixture({allowDiamondFallback:true});b.items([item(0)]);assert.equal((await b.instance.advance(b.ctx,{direction:0})).ok,true);
  assert.equal(b.memory.quartzExcavation.used.diamondRock,2);assert.equal(b.events.find(x=>x.stage==='dig_intent').toolKind,'existing_diamond_bounded_fallback');
  const c=fixture({allowDiamondFallback:true});c.items([item(1521)]);assert.equal((await c.instance.advance(c.ctx,{direction:0})).reason,'needs_usable_pickaxe');
});
test('ledger survives a new controller over the same memory and concurrent caps are enforced',async()=>{
  const f=fixture();await f.instance.advance(f.ctx,{direction:0});await f.instance.returnOne(f.ctx);
  const before={...f.memory.quartzExcavation.used};f.memory.quartzExcavation.used.flat=48;
  const resumed=createExcavation(f.configuration);
  assert.equal((await resumed.walkKnownOne(f.ctx,{towards:'front'})).atActualFront,true);
  assert.equal((await resumed.advance(f.ctx,{direction:0})).reason,'excavation_budget_retreat');assert.equal(f.memory.quartzExcavation.used.digs,before.digs);
});
test('old actual route can be walked back to front without newfeet or refunded budgets',async()=>{
  const f=fixture();await f.instance.advance(f.ctx,{direction:0});await f.instance.returnOne(f.ctx);
  const s=f.memory.quartzExcavation;assert.equal(s.route.length,2);assert.equal(s.routeIndex,0);
  const before={...s.used};assert.equal((await f.instance.walkKnownOne(f.ctx,{towards:'front'})).atActualFront,true);
  assert.equal(s.used.feet,before.feet);assert.equal(s.used.digs,before.digs);assert.equal(s.used.totalEdges,before.totalEdges+1);
});
test('explicit initialshore_only class has no portal credit and cannot downgrade an old portal ledger',async()=>{
  const f=fixture();f.put(0,70,10,'air');
  const local=createExcavation({...f.configuration,portal:null,anchorMode:'shore_only',portalEverObserved:false});
  const r=await local.advance(f.ctx,{direction:0});assert.equal(r.ok,true);assert.equal(r.noPortalReturnCredit,true);
  assert.equal(local.describe().portal,null);assert.equal(local.describe().anchorMode,'shore_only');
  const g=fixture();await g.instance.advance(g.ctx,{direction:0});
  assert.throws(()=>createExcavation({...g.configuration,portal:null,anchorMode:'shore_only',portalEverObserved:false}),/cannot downgrade/);
});
test('successful natural tool replenishment can resume a transient retreat without refunding the ledger',async()=>{
  const f=fixture();f.items([]);assert.equal((await f.instance.advance(f.ctx,{direction:0})).reason,'needs_usable_pickaxe');
  const s=f.memory.quartzExcavation,before={...s.used};assert.equal(s.retreat,true);
  f.items([{name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,slot:36,maxDurability:131,durabilityUsed:0}]);
  assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,true);assert.equal(s.used.feet,before.feet+1);assert.equal(s.used.digs,before.digs+2);
});
test('native2 requires exact actual1 base guard identity, including during the helper edge mask',async()=>{
  const bare=fixture();bare.movements.maxDropDown=2;
  assert.equal((await bare.instance.advance(bare.ctx,{direction:0})).reason,'walk_profile_changed');assert.equal(bare.calls.length,0);
  const f=fixture(),m=f.movements,guard=m.getNeighbors;
  Object.assign(m,{maxDropDown:2,infiniteLiquidDropdownDistance:false,companionPhysicalDropLimit:1,companionPhysicalDropGuard:guard});
  assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,true);assert.equal(m.getNeighbors,guard);assert.equal(m.maxDropDown,2);
  const g=fixture(),gm=g.movements,base=gm.getNeighbors;
  Object.assign(gm,{maxDropDown:2,infiniteLiquidDropdownDistance:false,companionPhysicalDropLimit:1,companionPhysicalDropGuard:base,getNeighbors:(...a)=>base(...a)});
  assert.equal((await g.instance.advance(g.ctx,{direction:0})).reason,'walk_profile_changed');assert.equal(g.calls.length,0);
});
test('an unjoined native equip retains the shared lease across abort and reconstructed controllers',async()=>{
  const f=fixture();let release,entered=false;
  f.bot.equip=()=>{entered=true;return new Promise(resolve=>{release=resolve;});};
  const pending=f.instance.advance(f.ctx,{direction:0});while(!entered)await new Promise(r=>setImmediate(r));
  f.controller.abort('root cancelled uncooperative equip');let settled=false;pending.then(()=>{settled=true;},()=>{settled=true;});
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.ok(f.memory.quartzExcavationLease);
  const replacement=createExcavation(f.configuration),fresh={signal:new AbortController().signal,record:f.ctx.record};
  assert.equal((await replacement.advance(fresh,{direction:0})).reason,'edge_in_flight');assert.equal(f.calls.length,0);
  release();await assert.rejects(pending,{code:'aborted'});assert.equal(f.memory.quartzExcavationLease,undefined);assert.equal(f.calls.length,0);
});
test('a spent 20s lease cannot start the next native action even before the timer gets a turn',async()=>{
  let clock=0;const f=fixture({now:()=>clock,afterDig:()=>{clock=20001;}});
  await assert.rejects(f.instance.advance(f.ctx,{direction:0}),{code:'aborted'});
  assert.equal(f.calls.length,1);assert.equal(f.memory.quartzExcavation.used.digs,1);assert.equal(f.memory.quartzExcavation.used.feet,0);
});
test('changed return support refuses a new route or any return excavation',async()=>{
  const f=fixture();await f.instance.advance(f.ctx,{direction:0});f.put(0,69,0,'air');const calls=f.calls.length;
  assert.equal((await f.instance.returnOne(f.ctx)).reason,'reverse_edge_no_longer_safe');assert.equal(f.calls.length,calls);
});
test('new return-side liquid is not hidden by a previously confirmed route',async()=>{
  const f=fixture();await f.instance.advance(f.ctx,{direction:0});f.put(0,70,1,'lava');const calls=f.calls.length;
  assert.equal((await f.instance.returnOne(f.ctx)).reason,'reverse_margin_changed');assert.equal(f.calls.length,calls);
});
test('missing actual portal, wrong dimension, unsafe hunger, and altered profile never start excavation',async()=>{
  for(const scenario of ['portal','dimension','food','profile']) {const f=fixture(scenario==='food'?{food:1}:{});
    if(scenario==='portal')f.put(0,70,10,'air');if(scenario==='dimension')f.bot.game.dimension='overworld';if(scenario==='profile')f.movements.canDig=true;
    assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,false);assert.equal(f.calls.length,0);}
});
test('lost portal refuses further excavation but never blocks a safe confirmed return',async()=>{
  const f=fixture();await f.instance.advance(f.ctx,{direction:0});f.put(0,70,10,'air');
  assert.equal((await f.instance.advance(f.ctx,{direction:0})).reason,'portal_unavailable');
  f.bot.health=4;assert.equal((await f.instance.returnOne(f.ctx)).atActualShore,true);
});
test('actual native guard rejects a tool switch hidden by the production internal equip catch',async()=>{
  const f=fixture({allowDiamondFallback:true});
  const cheap={name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,slot:36,maxDurability:131,durabilityUsed:0};
  const diamond={name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:37,maxDurability:1561,durabilityUsed:1520};
  f.items([cheap,diamond]);let equips=0;
  f.bot.equip=async tool=>{if(++equips===1){f.bot.heldItem=tool;return;}f.bot.heldItem=diamond;throw new Error('second equip failed');};
  const r=await f.instance.advance(f.ctx,{direction:0});assert.equal(r.ok,false);assert.equal(f.calls.length,0);
  assert.equal(f.memory.quartzExcavation.used.nativeDigAttempts,0);assert.equal(diamond.durabilityUsed,1520);
});
test('failed actual diamond dig still debits attempts and observed wear without fake mutation credit',async()=>{
  const f=fixture({allowDiamondFallback:true,digFailure:true,noDigMutation:true});
  const diamond={name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:37,maxDurability:1561,durabilityUsed:0};
  f.items([diamond]);const r=await f.instance.advance(f.ctx,{direction:0});assert.equal(r.ok,false);
  assert.equal(f.memory.quartzExcavation.used.nativeDigAttempts,1);assert.equal(f.memory.quartzExcavation.used.diamondRock,1);
  assert.equal(f.memory.quartzExcavation.used.actualDiamondWear,1);assert.equal(f.memory.quartzExcavation.used.digs,0);
  assert.equal(f.memory.quartzExcavation.confirmedDigCredit,0);
});
test('stale client damage cannot spend a 41-use diamond on a second rock past reserve40',async()=>{
  const f=fixture({allowDiamondFallback:true,noWear:true});
  f.items([{name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:37,maxDurability:1561,durabilityUsed:1520}]);
  assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,false);assert.equal(f.calls.length,1);
  assert.equal(f.memory.quartzExcavation.used.diamondRock,1);assert.equal(f.memory.quartzExcavation.used.digs,1);
});
test('ore harvesting shares both192 caps, confirms actualopen, never moves or invents routefeet',async()=>{
  const f=fixture(),validate=()=>({ok:true});f.put(1,70,0,'nether_quartz_ore');
  assert.equal((await f.instance.harvestAtFront(f.ctx,{position:new Vec3(1,70,0),validate})).ok,true);
  const s=f.memory.quartzExcavation;assert.equal(s.used.digs,1);assert.equal(s.used.nativeDigAttempts,1);assert.equal(s.used.feet,0);
  s.used.digs=191;s.used.nativeDigAttempts=191;f.put(1,71,0,'nether_quartz_ore');
  assert.equal((await f.instance.harvestAtFront(f.ctx,{position:new Vec3(1,71,0),validate})).ok,true);
  assert.equal(s.used.digs,192);assert.equal(s.used.nativeDigAttempts,192);assert.equal((await f.instance.advance(f.ctx,{direction:0})).ok,false);
  assert.equal(s.confirmedDigCredit,2);
  assert.equal(f.calls.filter(x=>x.kind==='move').length,0);assert.ok(s.open.has('1,70,0'));
});
test('ore validation is mandatory and protected actualroute floors are never mined',async()=>{
  const f=fixture();f.put(1,70,0,'nether_quartz_ore');
  assert.equal((await f.instance.harvestAtFront(f.ctx,{position:new Vec3(1,70,0)})).reason,'ore_validator_required');
  assert.equal((await f.instance.harvestAtFront(f.ctx,{position:new Vec3(1,70,0),validate:()=>({ok:false,reason:'unknown_los'})})).reason,'unknown_los');
  f.put(0,69,0,'nether_quartz_ore');
  assert.equal((await f.instance.harvestAtFront(f.ctx,{position:new Vec3(0,69,0),validate:()=>({ok:true})})).reason,'ore_front_or_protection_changed');
  assert.equal(f.calls.length,0);
});

test('a dimension profile restored during a one-down await is not overwritten by the stale edge scope',async()=>{
  const restoredNeighbors=()=>[],f=fixture({afterMove:({bot})=>{
    bot.game.dimension='overworld';bot.pathfinder.movements.maxDropDown=2;
    bot.pathfinder.movements.getNeighbors=restoredNeighbors;bot.pathfinder.movements.canDig=true;
  }});
  const result=await f.instance.advance(f.ctx,{direction:0,descend:true});
  assert.equal(result.reason,'wrong_dimension');assert.equal(f.movements.maxDropDown,2);
  assert.equal(f.movements.getNeighbors,restoredNeighbors);assert.equal(f.movements.canDig,true);
});

test('permanent trip bridge ownership outlives placement TTL and cannot become excavation rock or natural shore',async()=>{
  const f=fixture();f.memory.ledgeSupports=new Set(['1,69,0']);f.put(1,69,0,'netherrack');
  const result=await f.instance.advance(f.ctx,{direction:0,descend:true});
  assert.equal(result.ok,false);assert.equal(f.calls.length,0);assert.equal(f.bot.blockAt(new Vec3(1,69,0)).name,'netherrack');
  const shore=fixture();shore.memory.ledgeSupports=new Set(['0,69,0']);shore.put(0,69,0,'netherrack');
  assert.equal((await shore.instance.advance(shore.ctx,{direction:0})).ok,false);assert.equal(shore.calls.length,0);
});
