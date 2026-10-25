/* global require, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createLoadedDryGraph, hasGroundedBodySupport } = require('../vendor/server/minecraft/houseSurfaceGraph');
const { createNaturalShallowWaterTraversal } = require('../vendor/server/minecraft/houseShallowWaterTraversal');
const anchor = { x: 0, y: 2, z: 0 };
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const clone = v => JSON.parse(JSON.stringify(v));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// OFFLINE return-contract fixture. Static loaded source-water voxels, installed
// pathfinder, production shallow-water traversal and unmodified Physics own all
// movement. Only initial spawn position/velocity are assigned. No workstation,
// resource or live-server acceptance is inferred from this controlled geometry.
function fixture(t, options = {}) {
  const controls = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(k => [k, false]));
  const dryMoves = [], waterMoves = [], samples = [], checkpoints = [];
  let checkpoint = null,reverseInterrupted=false;
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', health: 20, food: 20, oxygenLevel: 20,
    username: 'SurfaceWaterReturn', _client: { state: 'play', socket: { writable: true, destroyed: false } },
    game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    inventory: { slots: Array(46).fill(null), items: () => [] }, entities: {}, players: {}, player: { ping: 1 },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, controlState: controls,
    entity: { id: 1, position: new Vec3(.5, 2, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true,
      yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: .6, effects: {}, attributes: {}, elytraFlying: false },
  });
  bot.blockAt = raw => {
    const p = raw.floored();
    if (p.x < (options.minX??-12) || p.x > 32 || Math.abs(p.z) > 1 || p.y < -64 || p.y > 100) return null;
    const name = p.y < 1 ? 'stone' : p.y === 1 ? p.x >= 8 && p.x <= 11 ? 'water' : 'stone' : 'air';
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p });
  };
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.setControlState = (key, value) => { controls[key] = value; };
  bot.clearControlStates = () => { for (const key of Object.keys(controls)) controls[key] = false; };
  bot.deactivateItem = () => {}; bot.stopDigging = () => {};
  bot.physics = Physics(registry, { getBlock: bot.blockAt }); pathfinder(bot);
  const initial = new Movements(bot); initial.canDig = false; initial.scafoldingBlocks = [];
  bot.pathfinder.setMovements(initial);
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), { getBlock: bot.blockAt }).apply(bot);
    samples.push({ position: plain(bot.entity.position), actualX: bot.entity.position.x, wet: bot.entity.isInWater, grounded: bot.entity.onGround });
    bot.emit('physicsTick');
  }, 5);
  const route = { schema: 1, kind: 'loaded_source_water_wade', depth: 1, width: 4,
    surfaceY: 2, from: { x: 7, y: 2, z: 0 }, to: { x: 12, y: 2, z: 0 }, waterStart: { x: 8, z: 0 }, direction: { x: 1, z: 0 }, timeoutMs: 4000 };
  const owner = {};
  if(options.pendingDeparture)checkpoint={schema:2,kind:'loaded_dry_waypoint_graph',anchor,step:8,radius:40,
    nodes:{'0,2,0':{position:anchor,parent:null,expanded:true}},order:['0,2,0'],frontier:[],blockedEdges:[],
    current:'0,2,0',resumeNode:'0,2,0',visits:1,probes:0,
    pendingWater:{originNode:'0,2,0',reverse:false,edge:{parent:'0,2,0',target:route.to,transport:{kind:'source_water_depth1',route}}}};
  const graph = createLoadedDryGraph({ getBot: () => bot, assertActive: () => {
    if(options.stopAfterPendingRecovery&&checkpoint?.pendingWater===null)
      throw Object.assign(Error('Stop before any new exploration'),{code:'fixture_recovered'});
  }, isMovementOwner: () => true,
    getCP: () => checkpoint, saveCP: cp => { checkpoint = cp; checkpoints.push(clone(cp)); },
    discoverWaterRoutes: ({ origin }) => origin.x === 0 && origin.y === 2 && origin.z === 0 ? [{ route: clone(route) }] : [],
    traverseWater: async (r, waterOptions = {}) => {
      if(options.interruptBeforeReverse&&r.from.x===12&&!reverseInterrupted){reverseInterrupted=true;throw Object.assign(Error('actual reverse paused on original bank'),{code:'paused'});}
      const record = { from: clone(r.from), to: clone(r.to), before: plain(bot.entity.position) }; waterMoves.push(record);
      const native = createNaturalShallowWaterTraversal({ getBot: () => bot, getOwner: () => owner,
        recoveryReturn: waterOptions.recoveryReturn === true || waterOptions.survivalProvisioning === true, isOwnerCurrent: current => current === owner, Vec3, Movements, GoalBlock: goals.GoalBlock });
      const result = await native.traverse(r); record.after = plain(bot.entity.position);
      if(options.interruptAfterWater&&waterMoves.length===1)throw Object.assign(Error('interrupted after actual crossing'),{code:'paused'});
      return result;
    },
    actualnativegoto: (goal, movements) => {
      assert.equal(bot.pathfinder.movements, movements);
      const move = { from: plain(bot.entity.position), target: { x: goal.x, y: goal.y, z: goal.z }, sample: samples.length }; dryMoves.push(move);
      return bot.pathfinder.goto(goal);
    },
  }, { anchor, step: 8, radius: 40, maxNodes: 16, maxEdges: 768, timeoutMs: 20000, legTimeoutMs: 4000 });
  async function nativeLocal(x) {
    await bot.pathfinder.goto(new goals.GoalBlock(x, 2, 0));
    const deadline = Date.now() + 500;
    while (!hasGroundedBodySupport(bot) && Date.now() < deadline) await sleep(5);
    assert.equal(hasGroundedBodySupport(bot), true); assert.equal(Math.floor(bot.entity.position.x), x);
  }
  t.after(() => { clearInterval(timer); bot.pathfinder.setGoal(null); bot.clearControlStates(); });
  return { bot, graph, dryMoves, waterMoves, samples, nativeLocal, checkpoints };
}

test('a displaced actor22m back along the departure shore reconnects dry without a fictitious crossing',{timeout:12000},async t=>{
 const f=fixture(t,{pendingDeparture:true,minX:-26,stopAfterPendingRecovery:true});
 assert.ok(f.graph.getState().pendingWater);
 await f.nativeLocal(-22);
 const before=f.dryMoves.length;
 await assert.rejects(f.graph.next(),e=>e.code==='fixture_recovered');
 assert.deepEqual(plain(f.bot.entity.position),anchor);assert.equal(hasGroundedBodySupport(f.bot),true);
 assert.equal(f.graph.getState().pendingWater,null);assert.equal(f.waterMoves.length,0);
 assert.ok(f.dryMoves.slice(before).some(m=>m.from.x===-22&&m.target.x===0));
 assert.equal(f.graph.getState().visits,1);assert.equal(f.graph.getState().nodes['12,2,0'],undefined);
});

test('off-graph adjacent cell below2m physically rejoins exact water child before typed reverse return', { timeout: 12000 }, async t => {
  const f = fixture(t), first = await f.graph.next(); assert.equal(first.actual.x, 12);
  await f.nativeLocal(13); const actual = plain(f.bot.entity.position);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(12, 2, 0)) < 2, 'This is the old proximity-skip counterexample');
  const before = f.dryMoves.length;
  const result = await f.graph.returnToAnchor({ via: [...first.via, actual] });
  assert.equal(result.confirmed, true); assert.deepEqual(plain(f.bot.entity.position), anchor);
  assert.deepEqual(f.dryMoves.slice(before).map(m => [m.from.x, m.target.x]), [[13, 12], [7, 0]]);
  assert.deepEqual(f.waterMoves.map(m => [m.from.x, m.to.x]), [[7, 12], [12, 7]]);
  assert.equal(f.graph.getState().visits, 2); assert.equal(f.graph.getState().nodes['13,2,0'], undefined);
});

test('fresh off-graph connector spends its bounded retry before replaying the exact water route',{timeout:12000},async t=>{
 const f=fixture(t),first=await f.graph.next();await f.nativeLocal(13);
 const original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder),budgets=[];
 f.bot.pathfinder.getPathFromTo=function*(movements,start,goal,options){
  budgets.push(options.timeout);
  if(options.timeout===100&&Math.floor(start.x)===13){for(let i=0;i<24;i++)yield{result:{status:'partial',path:[]}};return;}
  yield* original(movements,start,goal,options);
 };
 const result=await f.graph.returnToAnchor({rejoinInterruptedSuffix:true,via:[...first.via,plain(f.bot.entity.position)]});
 assert.equal(result.confirmed,true);assert.deepEqual(plain(f.bot.entity.position),anchor);
 assert.ok(budgets.includes(500));assert.deepEqual(f.waterMoves.map(m=>[m.from.x,m.to.x]),[[7,12],[12,7]]);
});

test('missing or wrong-current off-graph suffix refuses before any native return movement', { timeout: 12000 }, async t => {
  const f = fixture(t); await f.graph.next(); await f.nativeLocal(13);
  const before = f.dryMoves.length, waterBefore = f.waterMoves.length;
  for (const via of [[], [anchor, { x: 13, y: 2, z: 0 }], [anchor, { x: 12, y: 2, z: 0 }, { x: 14, y: 2, z: 0 }]]) {
    await assert.rejects(f.graph.returnToAnchor({ via }), e => e.code === 'dry_graph_rejoin_unconfirmed');
  }
  assert.equal(f.dryMoves.length, before); assert.equal(f.waterMoves.length, waterBefore); assert.equal(f.graph.getState().current, '12,2,0');
});

test('pending actual crossing on the far bank keeps its typed reverse when no fresh dry camp path exists',{timeout:12000},async t=>{
 const f=fixture(t,{interruptAfterWater:true});
 await assert.rejects(f.graph.next(),e=>e.code==='paused');
 const result=await f.graph.returnToAnchor({rejoinInterruptedSuffix:true,via:[anchor]});
 assert.equal(result.confirmed,true);assert.deepEqual(plain(f.bot.entity.position),anchor);
 assert.deepEqual(f.waterMoves.map(m=>[m.from.x,m.to.x]),[[7,12],[12,7]]);
});

test('only current-node suffix rejoins dry; typed water ancestor remains transport on parent replay', { timeout: 12000 }, async t => {
  const f = fixture(t); await f.graph.next(); const second = await f.graph.next();
  const current = second.actual.x;
  assert.ok(current > 12); assert.deepEqual(second.via.map(p => p.x), [0, 12, current]);
  await f.nativeLocal(current + 1); const before = f.dryMoves.length;
  await f.graph.returnToAnchor({ via: [...second.via, plain(f.bot.entity.position)] });
  assert.deepEqual(f.dryMoves.slice(before).map(m => [m.from.x, m.target.x]), [[current + 1, current], [current, 12], [7, 0]]);
  assert.deepEqual(f.waterMoves.map(m => [m.from.x, m.to.x]), [[7, 12], [12, 7]]);
  assert.equal(f.graph.getState().visits, 3); assert.equal(f.graph.getState().nodes[`${current + 1},2,0`], undefined);
  assert.deepEqual(plain(f.bot.entity.position), anchor);
});

test('old water child after already-returned camp is stale, never an off-graph dry workstation suffix', { timeout: 12000 }, async t => {
  const f = fixture(t), first = await f.graph.next(); await f.graph.returnToAnchor(); await f.nativeLocal(1);
  const before = f.dryMoves.length, waterBefore = f.waterMoves.length;
  await assert.rejects(f.graph.returnToAnchor({ via: [...first.via, plain(f.bot.entity.position)] }), e => e.code === 'dry_graph_rejoin_unconfirmed');
  assert.equal(f.dryMoves.length, before); assert.equal(f.waterMoves.length, waterBefore); assert.equal(f.graph.getState().current, '0,2,0');
  assert.equal(Math.floor(f.bot.entity.position.x), 1);
});

test('fresh actual camp-local workstation suffix remains valid with older water nodes saved elsewhere', { timeout: 12000 }, async t => {
  const f = fixture(t); await f.graph.next(); await f.graph.returnToAnchor(); await f.nativeLocal(1);
  const before = f.dryMoves.length, waterBefore = f.waterMoves.length;
  const result = await f.graph.returnToAnchor({ via: [anchor, plain(f.bot.entity.position)] });
  assert.equal(result.confirmed, true); assert.deepEqual(f.dryMoves.slice(before).map(m => [m.from.x, m.target.x]), [[1, 0]]);
  assert.equal(f.waterMoves.length, waterBefore); assert.equal(f.graph.getState().visits, 2); assert.deepEqual(plain(f.bot.entity.position), anchor);
});
test('interrupted stale crossing reconnects freshly to an actually reached ancestor before typed water replay',{timeout:12000},async t=>{
 const f=fixture(t);await f.graph.next();const second=await f.graph.next();await f.nativeLocal(13);
 const via=[...second.via,{x:12,y:2,z:0},{x:13,y:2,z:0}],before=f.dryMoves.length,visits=f.graph.getState().visits;
 await assert.rejects(f.graph.returnToAnchor({via}),e=>e.code==='dry_graph_rejoin_unconfirmed');assert.equal(f.dryMoves.length,before);
 const r=await f.graph.returnToAnchor({via,rejoinInterruptedSuffix:true});assert.equal(r.confirmed,true);
 assert.deepEqual(f.dryMoves.slice(before).map(m=>[m.from.x,m.target.x]),[[13,12],[7,0]]);
 assert.equal(f.graph.getState().visits,visits);assert.equal(f.graph.getState().nodes['13,2,0'],undefined);
 assert.deepEqual(f.waterMoves.map(m=>[m.from.x,m.to.x]),[[7,12],[12,7]]);
});
test('explicit nearby provisioning return can reach camp below ordinary working health without permitting new exploration',{timeout:12000},async t=>{
 const f=fixture(t);await f.graph.next();await f.graph.returnToAnchor();await f.nativeLocal(1);f.bot.health=4;
 await assert.rejects(f.graph.returnToAnchor({via:[anchor,{x:1,y:2,z:0}]}),e=>e.code==='dry_graph_survival_limit');
 const r=await f.graph.returnToAnchor({via:[anchor,{x:1,y:2,z:0}],provisioningReturn:true});assert.equal(r.confirmed,true);
 assert.deepEqual(plain(f.bot.entity.position),anchor);await assert.rejects(f.graph.next(),e=>e.code==='dry_graph_survival_limit');
});
test('reduced-health recorded return crosses water without enabling new exploration',{timeout:12000},async t=>{
 const f=fixture(t),first=await f.graph.next();await f.nativeLocal(13);f.bot.health=4;const waterCount=f.waterMoves.length;
 const result=await f.graph.returnToAnchor({via:[...first.via,{x:13,y:2,z:0}],provisioningReturn:true});
 assert.equal(result.confirmed,true);assert.equal(f.waterMoves.length,waterCount+1);assert.deepEqual(plain(f.bot.entity.position),anchor);
 await assert.rejects(f.graph.next(),{code:'dry_graph_survival_limit'});
});
test('hurt survivor can retrace an observed local camp work leg to food without acquiring exploration or water permission',{timeout:12000},async t=>{
 const f=fixture(t);await f.graph.next();await f.graph.returnToAnchor();await f.nativeLocal(4);f.bot.health=5;const priorWater=f.waterMoves.length;
 const result=await f.graph.returnToAnchor({via:[anchor,{x:4,y:2,z:0}],provisioningReturn:true,rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.equal(f.bot.health,5);assert.deepEqual(plain(f.bot.entity.position),anchor);
 assert.equal(f.waterMoves.length,priorWater);await assert.rejects(f.graph.next(),{code:'dry_graph_survival_limit'});
});

test('fresh actual dry camp arrival retires an obsolete interrupted transport without replaying the river',{timeout:12000},async t=>{
 const f=fixture(t,{interruptAfterWater:true});await assert.rejects(f.graph.next(),{code:'paused'});
 assert.ok(f.graph.getState().pendingWater);await f.nativeLocal(1);
 const waterBefore=f.waterMoves.length,visits=f.graph.getState().visits;
 const r=await f.graph.returnToAnchor({rejoinInterruptedSuffix:true});
 assert.equal(r.confirmed,true);assert.deepEqual(plain(f.bot.entity.position),anchor);
 assert.equal(f.waterMoves.length,waterBefore);assert.equal(f.graph.getState().visits,visits);
 assert.equal(f.graph.getState().pendingWater,null);assert.equal(f.graph.getState().lastAbandonedTransport.reason,'actual_fresh_dry_camp_return');
});


function waitForNativeDrySpawn(f) {
  // Initial onGround is spawn data. Require consecutive observations produced
  // by the installed unmodified Physics, within the existing12s test boundary.
  return new Promise((resolve,reject)=>{
    let ticks=0,stableTicks=0;const started=Date.now();
    const finish=(error,result)=>{clearTimeout(timer);f.bot.removeListener('physicsTick',observe);if(error)reject(error);else resolve(result);};
    const observe=()=>{
      ticks++;
      const dry=f.bot.entity.onGround===true&&hasGroundedBodySupport(f.bot)&&!f.bot.entity.isInWater&&!f.bot.entity.isInLava
        &&f.bot.pathfinder.goal===null&&Object.values(f.bot.controlState).every(value=>value===false);
      stableTicks=dry?stableTicks+1:0;
      if(stableTicks>=2)finish(null,{ticks,stableTicks,elapsedMs:Date.now()-started,actual:f.bot.entity.position.clone(),velocity:f.bot.entity.velocity.clone()});
    };
    const timer=setTimeout(()=>finish(Object.assign(Error('Original native spawn did not settle on its dry support'),{code:'fixture_spawn_not_settled'})),1000);
    f.bot.on('physicsTick',observe);
  });
}

test('explicit emergency food exploration crosses loaded typed water below the ordinary work health threshold',{timeout:12000},async t=>{
 const f=fixture(t);const settled=await waitForNativeDrySpawn(f);assert.ok(settled.stableTicks>=2);f.bot.health=4;f.bot.food=8;
 await assert.rejects(f.graph.next(),{code:'dry_graph_survival_limit'});
 const result=await f.graph.next({survivalProvisioning:true});assert.equal(result.moved,true);
 assert.equal(f.waterMoves.length,1);assert.deepEqual(plain(f.bot.entity.position),{x:12,y:2,z:0});
 assert.equal(f.bot.health,4);assert.equal(f.bot.food,8);
 await assert.rejects(f.graph.next(),{code:'dry_graph_survival_limit'});
 const back=await f.graph.returnToAnchor({provisioningReturn:true});assert.equal(back.confirmed,true);
 assert.equal(f.waterMoves.length,2);assert.deepEqual(plain(f.bot.entity.position),anchor);
});


test('the first ungrounded native spawn tick grants no emergency exploration credit before actual settled water traversal',{timeout:12000},async t=>{
 const f=fixture(t);f.bot.health=4;f.bot.food=8;
 await new Promise(resolve=>f.bot.once('physicsTick',resolve));
 const first={actual:f.bot.entity.position.clone(),velocity:f.bot.entity.velocity.clone(),onGround:f.bot.entity.onGround,support:hasGroundedBodySupport(f.bot)};
 assert.equal(f.samples.length,1);assert.equal(first.onGround,false);assert.equal(first.support,false);assert.ok(first.velocity.y<0);
 assert.deepEqual(first.actual,new Vec3(.5,2,.5));assert.equal(f.bot.blockAt(first.actual.floored().offset(0,-1,0)).name,'stone');
 assert.equal(f.graph.getState().visits,0);assert.deepEqual(f.graph.getState().order,[]);
 await assert.rejects(f.graph.next({survivalProvisioning:true}),{code:'dry_graph_not_on_surface'});
 assert.equal(f.dryMoves.length,0);assert.equal(f.waterMoves.length,0);assert.equal(f.graph.getState().visits,0);
 assert.deepEqual(f.graph.getState().nodes,{});assert.deepEqual(f.graph.getState().order,[]);assert.equal(f.graph.getState().current,null);
 assert.equal(f.bot.pathfinder.goal,null);assert.ok(Object.values(f.bot.controlState).every(value=>value===false));
 const settled=await waitForNativeDrySpawn(f);assert.ok(settled.stableTicks>=2);assert.equal(f.bot.entity.onGround,true);assert.equal(hasGroundedBodySupport(f.bot),true);
 assert.deepEqual(plain(f.bot.entity.position),anchor);assert.equal(f.dryMoves.length,0);assert.equal(f.waterMoves.length,0);
 await assert.rejects(f.graph.next(),{code:'dry_graph_survival_limit'});
 const result=await f.graph.next({survivalProvisioning:true});assert.equal(result.moved,true);
 assert.equal(f.waterMoves.length,1);assert.deepEqual(plain(f.bot.entity.position),{x:12,y:2,z:0});
 assert.equal(f.bot.health,4);assert.equal(f.bot.food,8);
 await assert.rejects(f.graph.next(),{code:'dry_graph_survival_limit'});
 const back=await f.graph.returnToAnchor({provisioningReturn:true});assert.equal(back.confirmed,true);
 assert.equal(f.waterMoves.length,2);assert.deepEqual(plain(f.bot.entity.position),anchor);
 t.diagnostic(JSON.stringify({scope:'actual first native Physics tick refusal, then two consecutive real grounded ticks before original low-health typed-water traversal; not exact CI replay',first,settled,waterTraversals:f.waterMoves.length,actual:f.bot.entity.position,health:f.bot.health,food:f.bot.food}));
});

test('a mismatched old resource suffix uses a fresh actual ancestor connector before its recorded water return',{timeout:12000},async t=>{
 const f=fixture(t);await f.graph.next();await f.nativeLocal(13);
 const before=f.waterMoves.length;const result=await f.graph.returnToAnchor({via:[anchor],rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.deepEqual(plain(f.bot.entity.position),anchor);
 assert.equal(f.waterMoves.length,before+1);assert.equal(f.graph.getState().visits,2);
});


test('pending reverse on its original bank retries finite UNKNOWN before claiming it is outside the dry return',{timeout:12000},async t=>{
 const f=fixture(t,{interruptBeforeReverse:true});await f.graph.next();
 await assert.rejects(f.graph.returnToAnchor(),{code:'paused'});await f.nativeLocal(18);
 const original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder),budgets=[];
 f.bot.pathfinder.getPathFromTo=function*(m,start,goal,options){budgets.push(options.timeout);
  if(options.timeout===100&&Math.floor(start.x)===18&&goal.x===12){for(let i=0;i<24;i++)yield{result:{status:'partial',path:[]}};return;}
  yield*original(m,start,goal,options);
 };
 const result=await f.graph.returnToAnchor({rejoinInterruptedSuffix:true});
 assert.equal(result.confirmed,true);assert.deepEqual(plain(f.bot.entity.position),anchor);assert.ok(budgets.includes(500));
 assert.deepEqual(f.waterMoves.map(m=>[m.from.x,m.to.x]),[[7,12],[12,7]]);assert.equal(f.graph.getState().visits,2);
});

test('actual native dry-bank arrival is persisted before the remaining parent leg',{timeout:10000},async t=>{
 const f=fixture(t);await f.graph.next();
 const arrived=f.checkpoints.find(cp=>cp.pendingWater?.bankArrival?.nativeTraversalConfirmed===true);
 assert.ok(arrived);assert.deepEqual(arrived.pendingWater.bankArrival.position,{x:12,y:2,z:0});
 assert.ok(f.waterMoves.some(m=>m.after?.x===12));assert.ok(f.samples.some(p=>p.wet));
});
