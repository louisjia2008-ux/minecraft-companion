'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { EventEmitter } = require('node:events');
const { createNetherQuartzGoal, quartzPathPlan } = require('../core/goals/netherQuartz');
const { chooseExcavationTarget, excavationDirections, targetCost, oreSafetyFailure, shoreSafetyFailure } = require('../core/quartzExcavationTarget');

function selectionFixture() {
  const cells = new Map(), portal = new Vec3(-20, 0, 0), shore = new Vec3(0, 0, 0);
  const key = (p) => `${p.x},${p.y},${p.z}`;
  cells.set(key(portal), 'nether_portal');
  // Cold coordinate proposals now require a genuinely standable fixture:
  // known empty feet/head over a full natural2x2 floor, not a body in basalt.
  for (const x of [-1,0]) for (const z of [-1,0]) for (const y of [0,1]) cells.set(`${x},${y},${z}`, 'air');
  const ore = (x, y, z) => { const p = new Vec3(x, y, z); cells.set(key(p), 'nether_quartz_ore'); return p; };
  const bot = { registry, entity: { position: shore.offset(.5, 0, .5), onGround: true },
    blockAt(p) { p = p.floored(); const b = Block.fromStateId(registry.blocksByName[cells.get(key(p)) || 'basalt'].defaultState); b.position = p; return b; },
    findBlocks: () => [...cells].filter(([,n]) => n === 'nether_quartz_ore').map(([k]) => new Vec3(...k.split(',').map(Number))) };
  return { bot, shore, portal, ore, cells };
}

test('bounded quartz coordinate target comes from loaded actual ore, never a fixed mining coordinate', () => {
  const f = selectionFixture(); f.ore(3, 18, 0); const expected = f.ore(6, -12, -20);
  const chosen = chooseExcavationTarget(f);
  assert.equal(chosen.ok, true); assert.deepEqual(chosen.block.position, expected);
  assert.equal(chosen.cost.down, 12); assert.equal(chosen.cost.edges, 26);
  assert.deepEqual(f.bot.entity.position, new Vec3(.5,0,.5));
});

test('candidate planning keeps true portal radius,16 down,48 flat and64 cumulative feet caps', () => {
  const f = selectionFixture(); f.ore(100, 0, 0); f.ore(3, -17, 0);
  assert.equal(chooseExcavationTarget(f).reason, 'no_bounded_excavation_target');
  const candidate=f.ore(6,-12,-20);
  assert.equal(chooseExcavationTarget({...f,ledger:{used:{feet:39}}}).ok,false);
  assert.equal(chooseExcavationTarget({...f,ledger:{used:{down:5}}}).ok,false);
  assert.equal(chooseExcavationTarget({...f,ledger:{used:{flat:35}}}).ok,false);
  assert.deepEqual(chooseExcavationTarget({...f,ledger:{used:{feet:38,down:4,flat:34}}}).block.position,candidate);
});

test('protected supports, fortress exclusions, already attempted targets and missing portal refuse selection', () => {
  const f=selectionFixture(),p=f.ore(5,-2,0),key=`${p.x},${p.y},${p.z}`;
  assert.equal(chooseExcavationTarget({...f,ledger:{protectedFloors:new Set([key])}}).ok,false);
  assert.equal(chooseExcavationTarget({...f,excluded:()=>true}).ok,false);
  assert.equal(chooseExcavationTarget({...f,rejected:new Set([key])}).ok,false);
  f.bot.blockAt=()=>null;
  assert.equal(chooseExcavationTarget(f).reason,'excavation_anchor_unconfirmed');
});

test('a target directly below requires cardinal stairs and never a vertical shaft', () => {
  assert.deepEqual(targetCost(new Vec3(0,0,0),new Vec3(0,-16,0)),{edges:16,down:16,flat:0,score:17.6});
  const options=excavationDirections(new Vec3(0,0,0),new Vec3(0,-16,0));
  assert.equal(options.length,8);
  assert.equal(options.filter(step=>step.descend).length,4);
  for(const step of options){assert.equal(step.next.y,step.descend?-1:0);assert.equal(Math.abs(step.next.x)+Math.abs(step.next.z),1);}
});

test('direction options exclude old actual feet and rejected headings without resetting cumulative caps', () => {
  const from=new Vec3(0,0,0),target=new Vec3(8,-2,0);
  const options=excavationDirections(from,target,{visited:new Set(['1,-1,0']),rejected:new Set([1])});
  assert.deepEqual(options.map(s=>s.attemptKey),['2:down','3:down','0:flat','2:flat','3:flat']);
  assert.equal(excavationDirections(from,target,{used:{down:16}}).every(s=>!s.descend),true);
  assert.deepEqual(excavationDirections(from,target,{used:{feet:64}}),[]);
});

test('missing real portal has no implicit fallback; explicit shore-only mining has no portal claim', () => {
  const f=selectionFixture();f.ore(5,-2,0);
  assert.equal(chooseExcavationTarget({...f,portal:null}).ok,false);
  const plan=chooseExcavationTarget({...f,portal:null,anchorMode:'shore_only'});
  assert.equal(plan.ok,true);assert.equal(plan.anchorMode,'shore_only');
});

test('ore harvest safety requires actual quartz, all loaded margins and only confirmed underground openings',()=>{
  const f=selectionFixture(),p=f.ore(8,-2,0),front=new Vec3(7,-2,0);
  const ledger={surfaceY:0,route:[front],open:new Set(),protectedFloors:new Set()};
  f.cells.set('7,-2,0','air');f.cells.set('7,-1,0','air');
  assert.equal(oreSafetyFailure(f.bot,p,ledger),null);
  f.cells.set('8,-2,1','air');assert.equal(oreSafetyFailure(f.bot,p,ledger),'unconfirmed_cave_at_ore');
  ledger.open.add('8,-2,1');assert.equal(oreSafetyFailure(f.bot,p,ledger),null);
  const read=f.bot.blockAt;f.bot.blockAt=q=>q.floored().equals(p.offset(0,-1,0))?null:read(q);
  assert.equal(oreSafetyFailure(f.bot,p,ledger),'unknown_ore_margin');
});

test('ore harvest refuses liquids/fire/magma, every concrete powder and recorded return floors',()=>{
  const f=selectionFixture(),p=f.ore(8,-2,0),ledger={surfaceY:0,route:[],open:new Set(),protectedFloors:new Set()};
  const gravity=Object.keys(registry.blocksByName).filter(n=>n.endsWith('_concrete_powder'));
  assert.equal(gravity.length,16);
  for(const name of ['lava','water','bubble_column','fire','soul_fire','magma_block','campfire','soul_campfire',...gravity]){
    f.cells.set('8,-1,0',name);assert.equal(oreSafetyFailure(f.bot,p,ledger),'hazard_or_gravity_ore_margin',name);
  }
  f.cells.set('8,-1,0','basalt');ledger.protectedFloors.add('8,-2,0');
  assert.equal(oreSafetyFailure(f.bot,p,ledger),'protected_ore_or_route_floor');
});

test('ore after-readback accepts actual safe air and never a liquid changed-block acknowledgement',()=>{
  const f=selectionFixture(),p=f.ore(8,-2,0),ledger={surfaceY:0,route:[],open:new Set(),protectedFloors:new Set()};
  f.cells.set('8,-2,0','air');assert.equal(oreSafetyFailure(f.bot,p,ledger,'after'),null);
  for(const name of ['lava','fire','water']){f.cells.set('8,-2,0',name);assert.equal(oreSafetyFailure(f.bot,p,ledger,'after'),'ore_or_open_changed');}
});

function goalFixture() {
  const f=selectionFixture(),events=[],calls={gather:0,advance:0,return:0,known:0,harvest:0,factories:0};f.ore(8,-2,0);
  const items=[{name:'stone_pickaxe',count:1,type:registry.itemsByName.stone_pickaxe.id,maxDurability:131,durabilityUsed:0},
    {name:'cooked_beef',count:4,type:registry.itemsByName.cooked_beef.id}];
  const oldRead=f.bot.blockAt;
  f.bot=Object.assign(new EventEmitter(),f.bot,{version:'1.21.8',health:20,food:20,entities:{},
    game:{dimension:'the_nether',minY:0,height:256},inventory:{items:()=>items,slots:[]},
    blockAt(p){p=p.floored();if(p.y>=0&&!f.cells.has(`${p.x},${p.y},${p.z}`)){
      const b=Block.fromStateId(registry.blocksByName.air.defaultState);b.position=p;return b;
    }return oldRead(p);},clearControlStates(){},
    pathfinder:{movements:{canDig:false,allowParkour:false,allow1by1towers:false,scafoldingBlocks:[],maxDropDown:1,
      companionWalkOnly:true,exclusionAreasStep:[],exclusionAreasBreak:[],exclusionAreasPlace:[],blocksCantBreak:new Set()},setGoal(){}},
    findBlocks({matching}){const ids=Array.isArray(matching)?matching:[matching];return ids.includes(registry.blocksByName.nether_quartz_ore.id)
      ?[...f.cells].filter(([,n])=>n==='nether_quartz_ore').map(([k])=>new Vec3(...k.split(',').map(Number))):[];}});
  f.bot.world={getBlock:p=>f.bot.blockAt(p),raycast:()=>null};
  const engine={advance:async()=>{calls.advance++;return{ok:true,progress:false};},returnOne:async()=>{calls.return++;return{ok:true,progress:false};},
    walkKnownOne:async()=>{calls.known++;return{ok:true,progress:false};},harvestAtFront:async()=>{calls.harvest++;return{ok:true,progress:false};},
    describe:()=>({anchorMode:'shore_only',noPortalReturnCredit:true})};
  const actions={pickFood:()=>items[1]};
  const skills={gatherOne:async()=>{calls.gather++;return{ok:false,reason:'quartz_no_reachable_target',roundComplete:true};}};
  const factory={onCreate:null};
  const goal=createNetherQuartzGoal({bot:f.bot,skills,
    actions,excavationFactory:()=>{calls.factories++;factory.onCreate?.();return engine;}});
  const stateCounts={stone_pickaxe:1,cooked_beef:4};
  const ctx={signal:new AbortController().signal,record:(type,data)=>events.push({type,...data}),perceive:()=>({inventory:{...stateCounts},hostiles:[],health:20,food:20})};
  return{...f,goal,ctx,calls,events,engine,stateCounts,actions,skills,factory};
}

test('completed safe-search round schedules explicit excavation on a separate body run', async()=>{
  const f=goalFixture();try{
    const first=await f.goal.run(f.ctx);
    assert.equal(first.reason,'quartz_excavation_pending');assert.equal(f.calls.advance,0);assert.equal(f.calls.gather,1);
    await f.goal.run(f.ctx);
    assert.equal(f.calls.advance,1);assert.equal(f.calls.gather,1);
    assert.ok(f.events.some(e=>e.type==='quartz_excavation_mode'&&e.anchorMode==='shore_only'&&e.portal===null&&e.noPortalReturnCredit));
  }finally{f.goal.dispose();}
});

test('new excavation keeps its actual ledger through generic recovery instead of refunding progress or caps',()=>{
  const f=goalFixture();try{
    const ledger={used:{feet:7,digs:19,down:2,flat:5},route:[new Vec3(0,0,0),new Vec3(1,-1,0)],routeIndex:1};
    f.goal.memory.quartzExcavation=ledger;f.goal.recover();
    assert.equal(f.goal.memory.quartzExcavation,ledger);assert.equal(ledger.used.digs,19);
  }finally{f.goal.dispose();}
});

test('a real known-shore position after resupply walks the saved route forward despite a stale front index',async()=>{
  const f=goalFixture();try{
    f.goal.memory.quartzExcavationAnchor={shore:new Vec3(0,0,0),portal:null,anchorMode:'shore_only'};
    f.goal.memory.quartzExcavationTarget=new Vec3(8,-2,0);
    f.goal.memory.quartzExcavation={route:[new Vec3(0,0,0),new Vec3(1,-1,0)],routeIndex:1,
      used:{feet:1,down:1,flat:0,digs:3},routeFeet:new Set(['0,0,0','1,-1,0'])};
    await f.goal.run(f.ctx);
    assert.equal(f.calls.known,1);assert.equal(f.calls.advance,0);
  }finally{f.goal.dispose();}
});

test('native drop2 requires the exact active physical1 guard identity, never a bare relaxed profile',async()=>{
  const f=goalFixture();try{
    const m=f.bot.pathfinder.movements,goal={isEnd:p=>p.x===0&&p.y===0&&p.z===0};let queries=0;
    f.bot.pathfinder.getPathFromTo=function*(){queries++;yield{result:{status:'success',path:[]},astarContext:{}};};
    m.maxDropDown=2;m.infiniteLiquidDropdownDistance=false;
    assert.equal((await quartzPathPlan(f.bot,goal)).ok,false);assert.equal(queries,0);
    m.companionPhysicalDropLimit=1;m.companionPhysicalDropGuard=()=>[];m.getNeighbors=m.companionPhysicalDropGuard;
    assert.equal((await quartzPathPlan(f.bot,goal)).ok,true);assert.equal(queries,1);
    m.getNeighbors=()=>[];
    assert.equal((await quartzPathPlan(f.bot,goal)).ok,false);assert.equal(queries,1);
  }finally{f.goal.dispose();}
});

test('cancel before an excavation run dispatches no search, dig, edge or equipment action',async()=>{
  const f=goalFixture();try{
    const controller=new AbortController();controller.abort();f.ctx.signal=controller.signal;
    await assert.rejects(f.goal.run(f.ctx),{code:'aborted'});
    assert.equal(f.calls.gather,0);assert.equal(f.calls.advance,0);assert.equal(f.calls.known,0);
  }finally{f.goal.dispose();}
});

for(const ok of [true,false])test(`only a successful new actual edge propagates bounded progress to the materials parent (ok=${ok})`,async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);
    const s=f.goal.memory.quartzExcavation={used:{feet:0,digs:0,down:0,flat:0},confirmedDigCredit:0,
      route:[new Vec3(0,0,0)],routeIndex:0,routeFeet:new Set(['0,0,0'])};
    const before=f.goal.progress({inventory:{}});
    f.engine.advance=async()=>{s.used.feet++;s.confirmedDigCredit+=2;return{ok,progress:false,reason:ok?undefined:'actual_edge_arrival_unconfirmed'};};
    const result=await f.goal.run(f.ctx);
    assert.equal(result.progress,ok);assert.equal(f.goal.progress({inventory:{}})>before,ok);
    assert.equal(result.actualExcavationCreditDelta,ok?3:0);
  }finally{f.goal.dispose();}
});

test('harvest acknowledgement alone never credits quartz pickup or task completion',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);
    const p=f.ore(1,0,0);f.goal.memory.quartzExcavationTarget=p;
    f.goal.memory.quartzExcavation={used:{feet:0,digs:0,down:0,flat:0},confirmedDigCredit:0,
      route:[new Vec3(0,0,0)],routeIndex:0,routeFeet:new Set(['0,0,0'])};
    f.bot.world.raycast=()=>f.bot.blockAt(p);
    await f.goal.run(f.ctx);assert.equal(f.calls.harvest,1);
    assert.ok(f.goal.memory.quartzExcavationPickup);assert.equal(f.events.some(e=>e.type==='quartz_excavation_pickup'),false);
    assert.equal(f.goal.isDone(f.ctx.perceive()),false);
    f.stateCounts.quartz=1;
    const picked=await f.goal.run(f.ctx);assert.equal(picked.gained,1);
    assert.ok(f.events.some(e=>e.type==='quartz_excavation_pickup'&&e.actual===1&&e.proof==='observed_inventory_delta'));
    assert.equal(f.goal.isDone(f.ctx.perceive()),false);
  }finally{f.goal.dispose();}
});

test('off-centre natural shore gets a separate fresh-gated alignment run before any excavation edge',async()=>{
  const f=goalFixture();try{
    f.bot.entity.position.x=.8;
    await f.goal.run(f.ctx);let aligns=0;
    f.actions.recentre=async(_bot,_ctx,{accept})=>{
      aligns++;assert.equal(accept(new Vec3(0,0,0),f.bot.entity.position),true);
      f.cells.set('1,0,0','fire');assert.equal(accept(new Vec3(0,0,0),f.bot.entity.position),false);
      // This contract fixture never assigns a centre pose; failed physical
      // alignment must not become admission or movement credit.
    };
    const result=await f.goal.run(f.ctx);
    assert.equal(aligns,1);assert.equal(f.calls.advance,0);assert.equal(result.ok,false);assert.equal(result.progress,false);
  }finally{f.goal.dispose();}
});

test('shore alignment sweep rejects neighbour fire contact, partial support and unknown body cells',()=>{
  const f=goalFixture();try{
    f.bot.entity.position.x=.8;assert.equal(shoreSafetyFailure(f.bot,new Vec3(0,0,0)),null);
    f.cells.set('1,0,0','fire');assert.equal(shoreSafetyFailure(f.bot,new Vec3(0,0,0)),'shore_body_sweep_unsafe');
    f.cells.delete('1,0,0');f.cells.set('1,-1,0','stone_slab');
    assert.equal(shoreSafetyFailure(f.bot,new Vec3(0,0,0)),'shore_body_sweep_unsafe');
    f.cells.delete('1,-1,0');const read=f.bot.blockAt;f.bot.blockAt=p=>p.floored().equals(new Vec3(1,1,0))?null:read(p);
    assert.equal(shoreSafetyFailure(f.bot,new Vec3(0,0,0)),'shore_body_sweep_unsafe');
  }finally{f.goal.dispose();}
});

test('retreat before first quarry admission does not invent a carved route or portal return credit',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);f.bot.inventory.items=()=>[];
    const result=await f.goal.run(f.ctx);
    assert.equal(result.reason,'nether_portal_lost');assert.equal(f.calls.advance,0);assert.equal(f.calls.return,0);
    assert.equal(f.goal.memory.quartzExcavation,undefined);
  }finally{f.goal.dispose();}
});

for(const branch of ['known','advance'])test(`helper ${branch} return-reserve refusal persists a return intent instead of retrying outward`,async()=>{
  const f=goalFixture();try{
    f.goal.memory.quartzExcavationAnchor={shore:new Vec3(0,0,0),portal:null,anchorMode:'shore_only'};
    f.goal.memory.quartzExcavationTarget=new Vec3(8,-2,0);
    const route=branch==='known'?Array.from({length:49},(_,x)=>new Vec3(x,0,0)):[new Vec3(0,0,0)];
    f.goal.memory.quartzExcavation={route,routeIndex:branch==='known'?16:0,used:{totalEdges:112,returnEdges:48,feet:48,flat:48,down:0},routeFeet:new Set(route.map(p=>`${p.x},${p.y},${p.z}`))};
    if(branch==='known')f.bot.entity.position.x=16.5;
    else f.goal.memory.quartzExcavation.used={totalEdges:0,returnEdges:0,feet:0,flat:0,down:0};
    f.engine[branch==='known'?'walkKnownOne':'advance']=async()=>{f.calls[branch]++;return{ok:false,progress:false,reason:'return_reserve_required'};};
    await f.goal.run(f.ctx);assert.equal(f.goal.memory.quartzExcavationReturning,true);
    await f.goal.run(f.ctx);assert.equal(f.calls.return,1);assert.equal(f.calls[branch],1);
    assert.equal(f.goal.memory.quartzExcavation.used.totalEdges,branch==='known'?112:0);
  }finally{f.goal.dispose();}
});

function attachLedger(f) {
  return f.goal.memory.quartzExcavation={used:{feet:0,digs:0,down:0,flat:0},confirmedDigCredit:0,
    route:[new Vec3(0,0,0)],routeIndex:0,routeFeet:new Set(['0,0,0']),protectedFloors:new Set(['0,-1,0']),open:new Set(),surfaceY:0};
}
test('death invalidates the uncollected pending phase and can select another actual ore without refunding the ledger',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f);s.used.digs=19;s.used.feet=7;
    f.goal.memory.quartzExcavationPickup={position:new Vec3(8,-2,0),before:7,epoch:0,attempts:0};
    f.cells.set('8,-2,0','air');const other=f.ore(3,-2,0);
    f.bot.emit('death');await f.goal.run(f.ctx);
    assert.equal(f.goal.memory.quartzExcavationPickup,null);assert.deepEqual(f.goal.memory.quartzExcavationTarget,other);
    assert.equal(s.used.digs,19);assert.equal(s.used.feet,7);assert.equal(f.events.some(e=>e.type==='quartz_excavation_pickup'),false);
  }finally{f.goal.dispose();}
});
test('death while awaiting a harvest cannot resurrect pending pickup or earn old-life progress after resolve',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f),p=f.ore(1,0,0);f.goal.memory.quartzExcavationTarget=p;
    f.bot.world.raycast=()=>f.bot.blockAt(p);
    f.engine.harvestAtFront=async()=>{s.used.digs++;s.confirmedDigCredit++;f.bot.emit('death');await new Promise(resolve=>setImmediate(resolve));return{ok:true,progress:false};};
    const result=await f.goal.run(f.ctx);
    assert.equal(result.ok,false);assert.equal(result.reason,'quartz_life_changed');assert.equal(result.progress,false);
    assert.equal(f.goal.memory.quartzExcavationPickup,null);assert.equal(f.goal.memory.quartzExcavationMilestones||0,0);
    assert.equal(s.used.digs,1);
  }finally{f.goal.dispose();}
});
test('bounded pickup-attempt expiry clears only pending intent and never invents an inventory gain',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f);s.used.digs=1;
    f.goal.memory.quartzExcavationPickup={position:new Vec3(8,-2,0),before:0,epoch:0,attempts:8};f.cells.set('8,-2,0','air');
    const result=await f.goal.run(f.ctx);
    assert.equal(f.goal.memory.quartzExcavationPickup,null);assert.equal(result.progress,false);assert.equal(s.used.digs,1);
    assert.ok(f.events.some(e=>e.type==='quartz_excavation_drop_invalidated'&&e.reason==='pickup_attempt_budget'));
    assert.equal(f.events.some(e=>e.type==='quartz_excavation_pickup'),false);
  }finally{f.goal.dispose();}
});

test('actual harvest visibility uses the actual offset player eye rather than a hypothetical centred stance',async()=>{
  const f=goalFixture();try{
    f.bot.entity.position=new Vec3(.31,0,.31);
    const p=f.ore(-3,0,3);f.cells.set('-1,1,0','basalt');
    f.bot.world.raycast=require('prismarine-world/src/worldsync').prototype.raycast.bind(f.bot.world);
    await f.goal.run(f.ctx);attachLedger(f);f.goal.memory.quartzExcavationTarget=p;
    await f.goal.run(f.ctx);
    assert.equal(f.calls.harvest,0,'centred ray is visible but actual offset eye is occluded');
    assert.equal(f.calls.advance,1);
  }finally{f.goal.dispose();}
});

test('the goal removes its owned death listener on idempotent disposal and leaves old ledger facts intact',()=>{
  const f=goalFixture(),s=attachLedger(f);s.used.digs=3;
  assert.equal(f.bot.listenerCount('death'),1);f.goal.dispose();f.goal.dispose();
  assert.equal(f.bot.listenerCount('death'),0);f.bot.emit('death');
  assert.equal(f.goal.memory.quartzDeathEpoch,undefined);assert.equal(s.used.digs,3);
});
test('a harvest resolving after goal disposal cannot write pending phase or progress into the retired goal',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f),p=f.ore(1,0,0);f.goal.memory.quartzExcavationTarget=p;
    f.bot.world.raycast=()=>f.bot.blockAt(p);
    f.engine.harvestAtFront=async()=>{s.used.digs++;f.goal.dispose();await new Promise(resolve=>setImmediate(resolve));return{ok:true};};
    const result=await f.goal.run(f.ctx);
    assert.equal(result.reason,'quartz_life_changed');assert.equal(result.progress,false);
    assert.equal(f.goal.memory.quartzExcavationPickup,null);assert.equal(f.goal.memory.quartzExcavationMilestones||0,0);
    assert.equal(s.used.digs,1);assert.equal(f.bot.listenerCount('death'),0);
  }finally{f.goal.dispose();}
});

test('four refused pickup headings invalidate pending before retreat even before the eight-attempt cap',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f);s.used.digs=1;
    f.goal.memory.quartzExcavationPickup={position:new Vec3(8,-2,0),before:0,epoch:0,attempts:4};f.cells.set('8,-2,0','air');
    f.goal.memory.quartzExcavationHeadingScope='0,0,0:8,-2,0';f.goal.memory.quartzExcavationHeadings=new Set([0,1,2,3]);
    const result=await f.goal.run(f.ctx);
    assert.equal(result.reason,'quartz_drop_not_safely_collectable');assert.equal(f.goal.memory.quartzExcavationPickup,null);
    assert.equal(f.goal.memory.quartzExcavationReturning,true);assert.equal(s.used.digs,1);
    assert.ok(f.events.some(e=>e.type==='quartz_excavation_drop_invalidated'&&e.reason==='no_safe_pickup_heading'&&!e.pickupCredit));
  }finally{f.goal.dispose();}
});

test('a cached quartz goal reactivates policies and exactly its listeners across repeated joined retirements',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f);s.used.digs=19;s.used.feet=7;
    await f.goal.run(f.ctx);const initialFactories=f.calls.factories;
    for(let i=0;i<3;i++){
      f.goal.dispose();assert.equal(f.bot.listenerCount('death'),0);assert.equal(f.bot.listenerCount('blockUpdate'),0);assert.equal(f.bot.listenerCount('game'),0);
      f.bot.game.dimension='the_nether';
      const result=await f.goal.run(f.ctx);assert.notEqual(result.reason,'disposed');assert.equal(f.bot.pathfinder.movements.companionNether,true);
      assert.equal(f.bot.listenerCount('death'),1);assert.equal(f.bot.listenerCount('blockUpdate'),1);assert.equal(f.bot.listenerCount('game'),1);
      assert.equal(f.goal.memory.quartzExcavation,s);assert.equal(s.used.digs,19);assert.equal(s.used.feet,7);
      f.bot.game.dimension='overworld';f.bot.emit('game');assert.equal(f.bot.pathfinder.movements.companionNether,false);
    }
    assert.equal(f.calls.factories,initialFactories+3);
  }finally{f.goal.dispose();}
});

test('retirement during unjoined gold equip blocks reactivation and the old context cannot record after settlement',async()=>{
  const f=goalFixture();let release;try{
    const original=f.bot.inventory.items(),gold={name:'golden_helmet',type:registry.itemsByName.golden_helmet.id,count:1};
    f.bot.inventory.items=()=>[...original,gold];
    f.bot.equip=()=>new Promise(resolve=>{release=resolve;});
    const oldRun=f.goal.run(f.ctx);const joined=oldRun.catch(error=>error);
    assert.equal(typeof release,'function');f.goal.dispose();
    const blocked=await f.goal.run(f.ctx);assert.equal(blocked.reason,'quartz_retirement_pending');
    assert.equal(f.bot.listenerCount('game'),0);assert.equal(f.bot.listenerCount('death'),0);
    release();const oldResult=await joined;assert.equal(oldResult.code==='aborted'||oldResult.reason==='quartz_life_changed',true);
    assert.equal(f.events.some(e=>e.type==='equip'),false,'old post-await event is suppressed after retirement');
    f.bot.inventory.items=()=>original;f.bot.equip=async()=>{};
    await f.goal.run(f.ctx);assert.equal(f.bot.pathfinder.movements.companionNether,true);
  }finally{release?.();f.goal.dispose();}
});

test('old scoped planner contexts are aborted and cannot record or perceive after a later valid activation',async()=>{
  const f=goalFixture();try{
    let oldContext;const gather=f.skills.gatherOne;
    f.skills.gatherOne=async(bot,ctx,options)=>{oldContext=ctx;return gather(bot,ctx,options);};
    await f.goal.run(f.ctx);const retired=oldContext;assert.equal(retired.signal.aborted,true);
    f.goal.dispose();const controller=new AbortController();controller.abort('new request already cancelled');
    await assert.rejects(f.goal.run({...f.ctx,signal:controller.signal}),{code:'aborted'});
    assert.equal(f.bot.listenerCount('game'),0);assert.equal(f.bot.listenerCount('death'),0);
    await f.goal.run(f.ctx);assert.equal(f.bot.listenerCount('game'),1);
    const events=f.events.length;retired.record('old_scope_late_event',{});
    assert.equal(f.events.length,events);assert.throws(()=>retired.perceive(),{code:'aborted'});
  }finally{f.goal.dispose();}
});

test('an unjoined planner promise also blocks reactivation without releasing or refunding its owner',async()=>{
  const f=goalFixture();let release;try{
    f.skills.gatherOne=()=>new Promise(resolve=>{release=resolve;});
    const old=f.goal.run(f.ctx);const joined=old.catch(error=>error);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');f.goal.dispose();
    const blocked=await f.goal.run(f.ctx);assert.equal(blocked.reason,'quartz_retirement_pending');assert.equal(blocked.blocked,true);
    assert.equal(f.bot.listenerCount('blockUpdate'),0);assert.equal(f.bot.pathfinder.movements.companionNether,false);
    release({ok:false,reason:'quartz_no_reachable_target',roundComplete:true});await joined;
    assert.equal(f.goal.memory.quartzExcavationAnchor,undefined,'old result cannot schedule a new quarry phase');
    f.skills.gatherOne=async()=>({ok:false,reason:'quartz_no_reachable_target',roundComplete:true});
    await f.goal.run(f.ctx);assert.equal(f.bot.pathfinder.movements.companionNether,true);
  }finally{release?.({ok:false,reason:'aborted'});f.goal.dispose();}
});

test('caller-only abort invalidates an uncooperative planner result before it can schedule a new quarry',async()=>{
  const f=goalFixture();let release;try{
    const controller=new AbortController();f.ctx.signal=controller.signal;
    f.skills.gatherOne=()=>new Promise(resolve=>{release=resolve;});
    const old=f.goal.run(f.ctx);await new Promise(resolve=>setImmediate(resolve));controller.abort('caller cancellation only');
    release({ok:false,reason:'quartz_no_reachable_target',roundComplete:true});const result=await old;
    assert.equal(result.ok,false);assert.equal(result.progress,false);
    assert.equal(f.goal.memory.quartzExcavationAnchor,undefined);assert.equal(f.goal.memory.quartzExcavationTarget,undefined);
    assert.equal(f.calls.advance,0);
  }finally{release?.({ok:false,reason:'aborted'});f.goal.dispose();}
});

test('caller-only abort invalidates late harvest acknowledgement without refunding native usage',async()=>{
  const f=goalFixture();let release;try{
    await f.goal.run(f.ctx);const s=attachLedger(f),p=f.ore(1,0,0);f.goal.memory.quartzExcavationTarget=p;
    f.bot.world.raycast=()=>f.bot.blockAt(p);
    const controller=new AbortController();f.ctx.signal=controller.signal;
    f.engine.harvestAtFront=()=>new Promise(resolve=>{s.used.digs++;s.confirmedDigCredit++;release=resolve;});
    const old=f.goal.run(f.ctx);await new Promise(resolve=>setImmediate(resolve));controller.abort('caller cancellation only');
    release({ok:true});const result=await old;
    assert.equal(result.ok,false);assert.equal(result.progress,false);
    assert.equal(f.goal.memory.quartzExcavationPickup||null,null);assert.equal(f.goal.memory.quartzExcavationMilestones||0,0);
    assert.equal(s.used.digs,1);
  }finally{release?.({ok:false,reason:'aborted'});f.goal.dispose();}
});

test('caller abort during a centred alignment await prevents dispatching a return engine with a newly captured aborted token',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);attachLedger(f);f.bot.inventory.items=()=>[];
    const controller=new AbortController();f.ctx.signal=controller.signal;
    f.factory.onCreate=()=>queueMicrotask(()=>controller.abort('cancel before aligned continuation'));
    f.engine.returnOne=async()=>{f.calls.return++;return{ok:true,atActualShore:true,progress:false};};
    const result=await f.goal.run(f.ctx);
    assert.equal(result.ok,false);assert.equal(f.calls.return,0);assert.equal(f.goal.memory.quartzExcavationAtShore,undefined);
  }finally{f.goal.dispose();}
});

test('late frontier movement after caller abort cannot mutate blocked hints or clear its completed search round',async()=>{
  const f=goalFixture();let release;try{
    f.cells.set('8,-2,0','air');f.ore(3,-17,0);
    f.goal.memory.explore.heading=0;f.goal.memory.explore.blocked=false;
    f.bot.pathfinder.movements.companionWalkOnly=false;f.bot.pathfinder.movements.getNeighbors=()=>[];
    const round=f.goal.memory.quartzRound={id:97,complete:true};
    f.bot.pathfinder.getPathFromTo=function*(_m,_origin,goal){yield{result:{status:'success',path:[
      ...Array.from({length:goal.x},(_,i)=>new Vec3(i+1,0,0)),
      ...Array.from({length:goal.z},(_,i)=>new Vec3(goal.x,0,i+1))]},astarContext:{}};};
    f.actions.goTo=()=>new Promise(resolve=>{release=resolve;});
    const controller=new AbortController();f.ctx.signal=controller.signal;const old=f.goal.run(f.ctx);
    for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(typeof release,'function',JSON.stringify(f.events));controller.abort('cancel frontier await');release({ok:true});const result=await old;
    assert.equal(result.ok,false);assert.equal(f.goal.memory.explore.blocked,false);assert.equal(f.goal.memory.quartzRound,round);
  }finally{release?.({ok:false,reason:'aborted'});f.goal.dispose();}
});

test('a newly chosen target retains its first refused mode and tries at most eight distinct modes from one front',async()=>{
  const f=goalFixture(),attempts=[];try{
    await f.goal.run(f.ctx);const s=attachLedger(f);
    f.goal.memory.quartzExcavationTarget=null;
    f.engine.advance=async(_ctx,step)=>{attempts.push(`${step.direction}:${step.descend?'down':'flat'}`);return{ok:false,reason:'topology_cave'};};
    for(let n=0;n<12;n++)await f.goal.run(f.ctx);
    assert.equal(attempts.length,8);assert.equal(new Set(attempts).size,8,'the null-to-selected target transition cannot forget the first refusal');
    assert.ok(attempts.slice(0,4).every(k=>k.endsWith(':down')));assert.ok(attempts.slice(4).every(k=>k.endsWith(':flat')));
    assert.equal(s.used.digs,0);assert.equal(s.used.feet,0);assert.equal(f.goal.memory.quartzExcavationMilestones||0,0);
  }finally{f.goal.dispose();}
});

test('excavation proposal trace labels planned distance and exact refused mode without claiming actual movement',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);attachLedger(f);
    f.engine.advance=async()=>({ok:false,reason:'topology_cave'});
    await f.goal.run(f.ctx);
    const event=f.events.find(e=>e.type==='quartz_excavation_navigation');
    assert.equal(event.attemptKey,'0:down');assert.equal(event.plannedDistanceBefore,10);assert.equal(event.plannedDistanceAfter,8);
    assert.equal(event.plannedOnly,true);assert.deepEqual(event.actual,{x:.5,y:0,z:.5});assert.equal(event.progressCredit,0);
    assert.equal(f.goal.memory.quartzExcavationHeadings.has('0:down'),true);
  }finally{f.goal.dispose();}
});

test('an already aborted entrance-search request cannot try either flat or down or reset spent budgets',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f);s.used.digs=19;s.used.feet=7;
    const controller=new AbortController();controller.abort('cancel before target fallback');
    await assert.rejects(f.goal.run({...f.ctx,signal:controller.signal}),{code:'aborted'});
    assert.equal(f.calls.advance,0);assert.equal(s.used.digs,19);assert.equal(s.used.feet,7);
  }finally{f.goal.dispose();}
});


function caveRefusalFixture(){
  const f=goalFixture();
  return{...f,async prepare(){
    await f.goal.run(f.ctx);const s=attachLedger(f);s.surfaceY=0;s.open=new Set();s.protectedFloors=new Set(['0,-1,0']);
    f.cells.set('8,-2,0','air');const p=f.ore(1,-1,0);f.cells.set('2,-1,0','air');
    f.goal.memory.quartzExcavationTarget=p;f.bot.world.raycast=()=>f.bot.blockAt(p);
    f.engine.harvestAtFront=async(_ctx,{position,validate})=>{f.calls.harvest++;return validate({position,stage:'before',memory:s});};
    return{s,p};
  }};
}

test('a stable unconfirmed cave edge is refused once then finitely exhausts safe targets instead of harvesting it80times',async()=>{
  const f=caveRefusalFixture();try{
    const{s,p}=await f.prepare();const spent=JSON.stringify(s.used);
    const first=await f.goal.run(f.ctx);assert.equal(first.reason,'unconfirmed_cave_at_ore');
    for(let n=0;n<80;n++){f.bot.emit('blockUpdate',{position:new Vec3(900+n,20,900)},{position:new Vec3(900+n,20,900)});await f.goal.run(f.ctx);}
    assert.equal(f.calls.harvest,1);assert.equal(f.goal.memory.quartzExcavationTarget,null);
    assert.equal(f.goal.memory.quartzExcavationReturning,true);assert.equal(f.goal.memory.quartzExcavationExhausted,true);
    assert.equal(JSON.stringify(s.used),spent);assert.equal(f.goal.memory.quartzExcavationMilestones||0,0);
    assert.equal(oreSafetyFailure(f.bot,p,s),'unconfirmed_cave_at_ore','the strict original cave admission remains unchanged');
    assert.ok(f.events.some(e=>e.type==='quartz_excavation_ore_refused'&&e.classification==='stable_cave'&&e.progress===false));
  }finally{f.goal.dispose();}
});

test('a cave refusal whose actual margin becomes unknown stays uncertain and never exhausts or permanently rejects that ore',async()=>{
  const f=caveRefusalFixture();try{
    const{s,p}=await f.prepare(),read=f.bot.blockAt;
    f.engine.harvestAtFront=async(_ctx,{position,validate})=>{
      f.calls.harvest++;const result=validate({position,stage:'before',memory:s});
      f.bot.blockAt=q=>q.floored().equals(new Vec3(2,-1,0))?null:read(q);return result;
    };
    const first=await f.goal.run(f.ctx);assert.equal(first.reason,'quartz_target_unknown');assert.equal(first.progress,false);
    for(let n=0;n<8;n++){const result=await f.goal.run(f.ctx);assert.equal(result.reason,'quartz_target_unknown');assert.equal(result.progress,false);}
    assert.equal(f.calls.harvest,1);assert.notEqual(f.goal.memory.quartzExcavationExhausted,true);assert.notEqual(f.goal.memory.quartzExcavationReturning,true);
    assert.equal(f.goal.memory.quartzExcavationRejected?.has(`${p.x},${p.y},${p.z}`)||false,false);
    assert.equal(s.used.digs,0);assert.equal(s.used.feet,0);
  }finally{f.goal.dispose();}
});

test('a genuinely changed local ore margin invalidates its stable cave refusal and permits a fresh safe query without pickup credit',async()=>{
  const f=caveRefusalFixture();try{
    const{s}=await f.prepare();await f.goal.run(f.ctx);assert.equal(f.calls.harvest,1);
    f.cells.set('2,-1,0','basalt');
    const result=await f.goal.run(f.ctx);
    assert.equal(f.calls.harvest,2);assert.equal(result.ok,true);assert.equal(result.actualExcavationCreditDelta,0);
    assert.equal(f.events.some(e=>e.type==='quartz_excavation_pickup'),false);assert.equal(s.used.digs,0);
  }finally{f.goal.dispose();}
});

test('unknown harvest results never add permanent ore exclusions or refund an actual spent native attempt',async()=>{
  const f=caveRefusalFixture();try{
    const{s,p}=await f.prepare();
    f.engine.harvestAtFront=async()=>{f.calls.harvest++;s.used.digs++;s.used.nativeDigAttempts=1;return{ok:false,reason:'unknown_ore_margin',progress:false};};
    const result=await f.goal.run(f.ctx);assert.equal(result.ok,false);
    assert.equal(f.goal.memory.quartzExcavationRejected?.has(`${p.x},${p.y},${p.z}`)||false,false);
    assert.notEqual(f.goal.memory.quartzExcavationExhausted,true);assert.equal(s.used.digs,1);assert.equal(s.used.nativeDigAttempts,1);
    assert.equal(f.goal.memory.quartzExcavationMilestones||0,0);
  }finally{f.goal.dispose();}
});


test('an unknown edge margin remains an untried mode instead of permanently discarding its heading',async()=>{
  const f=goalFixture();try{
    await f.goal.run(f.ctx);const s=attachLedger(f);
    f.engine.advance=async()=>{f.calls.advance++;s.used.nativeDigAttempts=1;return{ok:false,reason:'unknown_shape_margin',progress:false};};
    const result=await f.goal.run(f.ctx);assert.equal(result.reason,'unknown_shape_margin');
    assert.equal(f.goal.memory.quartzExcavationHeadings.size,0);assert.equal(f.goal.memory.quartzExcavationRejected?.size||0,0);
    assert.equal(s.used.nativeDigAttempts,1);assert.equal(f.goal.memory.quartzExcavationMilestones||0,0);
  }finally{f.goal.dispose();}
});

test('continuation query has its own no-progress run and next actual edge/log use the selected flat direction',async()=>{
  const f=goalFixture();try{
    let queries=0,actual;
    f.engine.proposeDirections=(_ctx,{candidates,current})=>{queries++;assert.equal(current(),true);const chosen=candidates.find(s=>s.direction===2&&!s.descend);assert.ok(chosen);return{preferred:chosen,fingerprint:'fixture',rankingUncertain:false,orderPolicy:'bounded_continuation_rank',counts:{firstQueries:8,secondQueries:8}};};
    f.engine.advance=async(_ctx,step)=>{actual=step;f.calls.advance++;return{ok:true,progress:false};};
    await f.goal.run(f.ctx);
    const query=await f.goal.run(f.ctx);assert.equal(query.queryOnly,true);assert.equal(query.progress,false);assert.equal(f.calls.advance,0);assert.equal(queries,1);
    await f.goal.run(f.ctx);assert.equal(f.calls.advance,1);assert.equal(queries,1);assert.deepEqual(actual,{direction:2,descend:false});
    const logged=f.events.filter(e=>e.type==='quartz_excavation_navigation').at(-1);assert.equal(logged.direction,2);assert.equal(logged.descend,false);assert.equal(logged.attemptKey,'2:flat');
  }finally{f.goal.dispose();}
});
test('late cancelled direction query cannot store or dispatch a selected proposal',async()=>{
  const f=goalFixture();try{
    const controller=new AbortController();f.ctx.signal=controller.signal;
    f.engine.proposeDirections=()=>{controller.abort('query cancelled');return{preferred:{direction:2,descend:false}};};
    await f.goal.run(f.ctx);const out=await f.goal.run(f.ctx);assert.equal(out.ok,false);assert.equal(out.progress,false);assert.equal(f.calls.advance,0);
    assert.equal(f.events.some(e=>e.type==='quartz_excavation_continuation'),false);
  }finally{f.goal.dispose();}
});
test('null/all-refused direction queries still reach finite original actual heading refusals',async()=>{
 const f=goalFixture();try{
  let queries=0;f.engine.proposeDirections=()=>{queries++;return{preferred:null,queryOnly:true,rankingUncertain:false};};
  f.engine.advance=async()=>{f.calls.advance++;return{ok:false,progress:false,reason:'forbidden_obstacle'};};
  await f.goal.run(f.ctx);for(let i=0;i<16;i++)await f.goal.run(f.ctx);
  assert.equal(queries,8);assert.equal(f.calls.advance,8);assert.equal(f.goal.memory.quartzExcavationHeadings.size,8);
  const exhausted=await f.goal.run(f.ctx);assert.equal(exhausted.reason,'quartz_excavation_no_safe_heading');assert.equal(exhausted.progress,undefined);assert.equal(f.goal.memory.quartzExcavationTarget,null);
 }finally{f.goal.dispose();}
});
