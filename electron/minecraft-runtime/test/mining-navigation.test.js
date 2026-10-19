/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const Move = require('mineflayer-pathfinder/lib/move');
const { createMiningNavigator, classifyMiningBlock } = require('../vendor/server/minecraft/miningNavigation');

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

for(const bad of [{canDig:true},{maxDropDown:undefined},{scafoldingBlocks:[1]}])test('preserving a captured navigation profile cannot borrow unsafe capabilities',async()=>{
 const f=worldFixture(),profile={canDig:false,scafoldingBlocks:[],allowParkour:false,allow1by1towers:false,allowSprinting:false,
  allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false,...bad};let moved=false;
 f.bot.pathfinder={movements:profile,goto:async()=>{moved=true;},setMovements:()=>{throw Error('Unsafe profile must be refused before mutation');}};
 const nav=createMiningNavigator({getBot:()=>f.bot,preserveMovements:true});
 await assert.rejects(nav.advance('east'),{code:'MINING_PROFILE_UNSAFE'});assert.equal(moved,false);assert.equal(f.bot.entity.position.x,.5);
});

function worldFixture(options = {}) {
  const surface = options.surface ?? 12;
  const cells = new Map();
  const unloaded = new Set();
  const actions = [];
  const stock = new Map();
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.21.8', health: 20, food: 20, entities: {},
    game: { dimension: 'overworld', minY: -64, height: 384 },
    entity: { position: new Vec3(0.5, surface, 0.5) },
    inventory: { items: () => [...stock].map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) },
    blockAt: (p) => {
      if (unloaded.has(key(p))) return null;
      const name = cells.get(key(p)) ?? (p.y < surface ? 'stone' : 'air');
      return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p.floored() });
    },
    canDigBlock: () => true,
  });
  let paused = false;
  let toolBroken = false;
  let stoppedDigs = 0;
  let motorStops = 0;
  bot.stopDigging = () => { stoppedDigs += 1; };
  let restoredState = options.restoredState;
  const block = (name, p) => cells.set(key(new Vec3(...p)), name);
  const state = () => ({ cells, unloaded, actions, stock, bot, block, navigator, stoppedDigs: () => stoppedDigs, motorStops: () => motorStops,
    pause: (value = true) => { paused = value; }, breakTool: (value = true) => { toolBroken = value; },
    recreate: () => { restoredState = navigator.getState(); navigator = create(); return navigator; } });
  const physicalMove = async (p) => {
    const from = bot.entity.position.floored();
    assert.ok(Math.abs(p.x - from.x) + Math.abs(p.z - from.z) <= 1, 'Movement must follow adjacent recorded cells');
    assert.ok(Math.abs(p.y - from.y) <= 1, 'No drops or vertical teleports');
    assert.equal(bot.blockAt(p).boundingBox, 'empty', `Feet cell ${key(p)} was not excavated`);
    assert.equal(bot.blockAt(p.offset(0, 1, 0)).boundingBox, 'empty', `Head cell ${key(p)} was not excavated`);
    assert.equal(bot.blockAt(p.offset(0, -1, 0)).boundingBox, 'block', 'Movement needs stable support');
    actions.push({ kind: 'move', position: p });
    bot.entity.position = p.offset(0.5, 0, 0.5);
    if (options.afterMove) options.afterMove(state());
  };
  if (options.productionMove) {
    bot.pathfinder = {
      setMovements: (movements) => { bot.pathfinder.movements = movements; }, setGoal: (goal) => { if (!goal) motorStops += 1; },
      goto: async (goal) => {
        if (options.beforeGoto) await options.beforeGoto(goal, state());
        const from = bot.entity.position.floored();
        const neighbors = bot.pathfinder.movements.getNeighbors(new Move(from.x, from.y, from.z, 0, 0));
        assert.ok(neighbors.some((n) => n.x === goal.x && n.y === goal.y && n.z === goal.z), 'Installed pathfinder must generate the checked staircase step');
        assert.ok(neighbors.every((n) => n.toBreak.length === 0 && n.toPlace.length === 0), 'Pathfinder cannot add its own excavation or bridge');
        await physicalMove(new Vec3(goal.x, goal.y, goal.z));
      },
    };
  }
  const create = () => createMiningNavigator({
    getBot: () => bot,
    restoredState,
    allowLeafSupport: options.allowLeafSupport === true,
    allowCeilingClearance: options.allowCeilingClearance === true,
    allowStableGravitySupport: options.allowStableGravitySupport === true,
    maxActions: options.maxActions ?? 4096,
    assertActive: () => {
      if (paused) { const error = new Error('paused'); error.code = 'paused'; throw error; }
    },
    sleep: async () => {},
    heartbeat: () => {},
    checkpoint: () => {},
    equipForBlock: async () => {
      if (toolBroken) { const error = new Error('tool broken'); error.code = 'MINING_TOOL'; throw error; }
      bot.heldItem = { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id };
    },
    digBlock: async (target) => {
      if (options.beforeDig) await options.beforeDig(target, state());
      assert.ok(target.position.distanceTo(bot.entity.position) <= 4.5, 'No remote excavation');
      assert.notEqual(key(target.position), key(bot.entity.position.offset(0, -1, 0)), 'Never dig the floor under the bot');
      assert.ok(!['lava', 'water', 'bedrock'].includes(target.name), `Unsafe dig ${target.name}`);
      actions.push({ kind: 'dig', name: target.name, position: target.position });
      cells.set(key(target.position), 'air');
      if (options.afterDig) await options.afterDig(target, state());
      if (target.name.includes('diamond_ore')) stock.set('diamond', (stock.get('diamond') || 0) + 1);
    },
    placeSupport: options.placeSupport === false ? undefined : async (p) => {
      assert.equal(bot.blockAt(p).name, 'air', 'Support placement requires known empty space');
      cells.set(key(p), 'cobblestone'); actions.push({ kind: 'support', position: p });
    },
    collectDrops: async () => {},
    moveTo: options.productionMove ? undefined : physicalMove,
  });
  let navigator = create();
  return state();
}

test('a checked sand column supports local passage digging and moving without digging that column',async()=>{
 const f=worldFixture({allowStableGravitySupport:true});
 f.block('sand',[0,11,0]);f.block('dirt',[1,12,0]);
 await f.navigator.advance('east');
 assert.ok(f.actions.some(a=>a.kind==='dig'&&a.name==='dirt'));
 assert.ok(f.actions.some(a=>a.kind==='move'));assert.equal(f.bot.blockAt(new Vec3(0,11,0)).name,'sand');
 const ordinary=worldFixture();ordinary.block('sand',[0,11,0]);ordinary.block('dirt',[1,12,0]);
 await assert.rejects(ordinary.navigator.advance('east'),{code:'MINING_NO_SUPPORT'});assert.equal(ordinary.actions.length,0);
});
test('loss of the actual sand-column base during passage digging stops before movement',async()=>{
 const f=worldFixture({allowStableGravitySupport:true,beforeDig:async(_target,w)=>{
  w.block('water',[0,10,0]);w.bot.emit('blockUpdate');
 }});
 f.block('sand',[0,11,0]);f.block('dirt',[1,12,0]);
 await assert.rejects(f.navigator.advance('east'),{code:'MINING_NO_SUPPORT'});
 assert.equal(f.actions.some(a=>a.kind==='move'),false);
});
test('a cleared dry corridor beside water permits retreat but a sealed wet dig face stays closed',async()=>{
 const f=worldFixture();f.block('water',[1,12,1]);
 await f.navigator.advance('east');await f.navigator.retreat();
 assert.equal(f.bot.entity.position.floored().x,0);
 const blocked=worldFixture();blocked.block('stone',[1,12,0]);blocked.block('water',[1,12,1]);
 await assert.rejects(blocked.navigator.advance('east'),{code:'MINING_FLUID'});
 assert.equal(blocked.bot.blockAt(new Vec3(1,12,0)).name,'stone');
});

test('confirmed partial ore pickup avoids a redundant physical pickup branch', async () => {
  const f = worldFixture({ productionMove: true });
  f.block('diamond_ore', [2, 12, 0]);
  await f.navigator.mineVein(new Vec3(2, 12, 0), {
    maxBlocks: 1, goal: () => (f.stock.get('diamond') || 0) >= 5,
    getCollectedCount: () => f.stock.get('diamond') || 0,
  });
  assert.equal(f.stock.get('diamond'), 1);
  assert.equal(f.actions.filter(a => a.kind === 'move').length, 0);
  assert.equal(f.navigator.getState().routeIndex, 0);
});

test('unconfirmed pickup still follows checked cells despite completed excavation', async () => {
  const f = worldFixture({ productionMove: true });
  f.block('stone', [2, 12, 0]);
  await f.navigator.mineVein(new Vec3(2, 12, 0), {
    maxBlocks: 1, getCollectedCount: () => f.stock.get('cobblestone') || 0,
  });
  assert.equal(f.stock.get('cobblestone') || 0, 0);
  assert.ok(f.actions.some(a => a.kind === 'move'));
});

test('support disappearing during excavation is rechecked without a bridge capability', async () => {
  const f = worldFixture({ placeSupport: false, afterDig: (_target, world) => world.block('air', [1, 10, 0]) });
  await assert.rejects(f.navigator.advance({ x: 1, z: 0 }, { descend: true }), error => error.code === 'MINING_NO_SUPPORT' && !(error instanceof TypeError));
  assert.equal(f.actions.filter(a => a.kind === 'move' || a.kind === 'support').length, 0);
  assert.equal(f.actions.filter(a => a.kind === 'dig').length, 1);
  assert.deepEqual(f.bot.entity.position, new Vec3(.5, 12, .5));
});

test('natural cave descent plans a checked level detour, performs real excavation and can retrace it', async () => {
  const f = worldFixture({ placeSupport: false });
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.block('air', [x, 10, z]);
  const plan = f.navigator.planDescentDetour();
  assert.equal(f.actions.length, 0, 'Planning must not move, dig or add a support');
  assert.ok(plan && plan.length === 2);
  assert.equal(plan[0].descend, false);
  assert.equal(plan[1].descend, true);
  for (const step of plan) await f.navigator.advance(step.direction, { descend: step.descend });
  assert.equal(f.bot.entity.position.y, 11);
  assert.ok(f.actions.some((action) => action.kind === 'dig'));
  await f.navigator.retreat();
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 12, 0));
});

test('level detour planning remains bounded and refuses unknown or lava enclosed routes', () => {
  const f = worldFixture({ placeSupport: false });
  for (let x = -3; x <= 3; x += 1) for (let z = -3; z <= 3; z += 1) f.block('air', [x, 10, z]);
  assert.equal(f.navigator.planDescentDetour(undefined, 2), null);
  assert.equal(f.navigator.planDescentDetour(undefined, 3)?.length, 4);
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.unloaded.add(`${x},12,${z}`);
  assert.equal(f.navigator.planDescentDetour(), null);
  f.unloaded.clear();
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.block('lava', [x, 13, z]);
  assert.equal(f.navigator.planDescentDetour(), null);
  assert.equal(f.actions.length, 0, 'No unsafe attempt is made while planning');
});

test('a solid underground staircase is excavated one safe adjacent cell at a time and retraces to the surface', async () => {
  const f = worldFixture();
  for (let i = 0; i < 8; i += 1) await f.navigator.advance('east', { descend: true });
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(8, 4, 0));
  assert.ok(f.actions.filter((a) => a.kind === 'dig').length >= 15, 'Staircase clears feet and head through real stone');
  assert.equal(f.navigator.getState().moves, 8);
  await f.navigator.retreat();
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 12, 0));
});

test('prospecting opens a supported two-block-high branch instead of teleporting through stone', async () => {
  const f = worldFixture();
  for (let i = 0; i < 5; i += 1) await f.navigator.advance('east', { descend: true });
  for (let i = 0; i < 7; i += 1) await f.navigator.advance('south');
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(5, 7, 7));
  assert.ok(f.actions.filter((a) => a.kind === 'dig' && a.position.z > 0).length >= 14);
});

test('the production movement configuration generates real installed-pathfinder staircase neighbors without dig or placement actions', async () => {
  const f = worldFixture({ productionMove: true });
  await f.navigator.advance('east', { descend: true });
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(1, 11, 0));
  const movements = f.bot.pathfinder.movements;
  assert.equal(movements.canDig, false);
  assert.equal(movements.scafoldingBlocks.length, 0);
  movements.maxDropDown = 1;
  assert.equal(movements.getNeighbors(new Move(0, 12, 0, 0, 0)).some((n) => n.x === 1 && n.y === 11 && n.z === 0), false,
    'The negative control catches the installed API floor-height convention');
});

for (const [name, position, code] of [
  ['lava', [1, 11, 0], 'MINING_FLUID'],
  ['lava', [2, 11, 0], 'MINING_FLUID'],
  ['water', [1, 11, 1], 'MINING_FLUID'],
  ['gravel', [1, 13, 0], 'MINING_GRAVITY'],
  ['sand', [1, 13, 0], 'MINING_GRAVITY'],
  ['bedrock', [1, 11, 0], 'MINING_OBSTRUCTED'],
]) {
  test(`a staircase refuses ${name} at ${position.join(',')} before excavating or moving`, async () => {
    const f = worldFixture(); f.block(name, position);
    await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === code);
    assert.equal(f.actions.length, 0);
    assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 12, 0));
  });
}

test('unloaded cells are unknown terrain and cannot be treated as air', async () => {
  const f = worldFixture(); f.unloaded.add('1,11,0');
  await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === 'MINING_UNLOADED');
  assert.equal(f.actions.length, 0);
});

test('an unsupported cave is rejected when no support material callback exists', async () => {
  const f = worldFixture({ placeSupport: false }); f.block('air', [1, 10, 0]);
  await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === 'MINING_NO_SUPPORT');
  assert.equal(f.actions.some((a) => a.kind === 'move'), false);
});

test('a dry one-block support gap is filled before the staircase enters it', async () => {
  const f = worldFixture(); f.block('air', [1, 10, 0]);
  await f.navigator.advance('east', { descend: true });
  const support = f.actions.findIndex((a) => a.kind === 'support');
  const movement = f.actions.findIndex((a) => a.kind === 'move');
  assert.ok(support >= 0 && support < movement);
  assert.equal(f.bot.blockAt(new Vec3(1, 10, 0)).name, 'cobblestone');
});

for (const unknown of [false, true]) {
  test(`a potential bridge refuses ${unknown ? 'unknown terrain' : 'lava'} below its support placement`, async () => {
    const f = worldFixture(); f.block('air', [1, 10, 0]);
    if (unknown) f.unloaded.add('1,9,0'); else f.block('lava', [1, 9, 0]);
    await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === (unknown ? 'MINING_UNLOADED' : 'MINING_FLUID'));
    assert.equal(f.actions.length, 0);
  });
}

test('vein mining stops after actual inventory gain and leaves the supporting ore underfoot intact', async () => {
  const f = worldFixture();
  await f.navigator.advance('east', { descend: true });
  f.block('diamond_ore', [1, 10, 0]);
  f.block('diamond_ore', [2, 11, 0]);
  f.block('diamond_ore', [2, 12, 0]);
  await f.navigator.mineVein(new Vec3(2, 11, 0), { goal: () => (f.stock.get('diamond') || 0) >= 1 });
  assert.equal(f.stock.get('diamond'), 1);
  assert.equal(f.bot.blockAt(new Vec3(1, 10, 0)).name, 'diamond_ore');
  assert.equal(f.actions.filter((a) => a.name === 'diamond_ore').length, 1);
});

test('ore with lava hidden directly behind it is left sealed instead of opening a fluid channel', async () => {
  const f = worldFixture();
  await f.navigator.advance('east', { descend: true });
  f.block('diamond_ore', [2, 11, 0]); f.block('lava', [3, 11, 0]);
  await assert.rejects(f.navigator.mineVein(new Vec3(2, 11, 0)), (error) => error.code === 'MINING_FLUID');
  assert.equal(f.bot.blockAt(new Vec3(2, 11, 0)).name, 'diamond_ore');
  assert.equal(f.stock.get('diamond') || 0, 0);
});

test('mining a vein preserves ore which supports an earlier staircase cell needed for the return trip', async () => {
  const f = worldFixture();
  for (let i = 0; i < 3; i += 1) await f.navigator.advance('east', { descend: true });
  f.block('diamond_ore', [2, 9, 0]);
  await assert.rejects(f.navigator.mineVein(new Vec3(2, 9, 0)), (error) => error.code === 'MINING_NO_SUPPORT');
  assert.equal(f.bot.blockAt(new Vec3(2, 9, 0)).name, 'diamond_ore');
  await f.navigator.retreat();
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 12, 0));
});

test('a paused expedition performs no dig, placement, or movement and can resume its recorded staircase', async () => {
  const f = worldFixture();
  for (let i = 0; i < 3; i += 1) await f.navigator.advance('east', { descend: true });
  f.pause(); const count = f.actions.length;
  await assert.rejects(f.navigator.advance('east', { descend: true }), /paused/);
  assert.equal(f.actions.length, count);
  f.pause(false); f.recreate();
  await f.navigator.advance('east', { descend: true });
  await f.navigator.retreat();
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 12, 0));
});

test('a broken pickaxe cannot silently destroy an ore block or move into uncleared terrain', async () => {
  const f = worldFixture(); f.breakTool();
  await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === 'MINING_TOOL');
  assert.equal(f.actions.length, 0);
  assert.equal(f.bot.blockAt(new Vec3(1, 11, 0)).name, 'stone');
});

test('changed retreat terrain is rejected without digging through a newly formed lava flow', async () => {
  const f = worldFixture();
  await f.navigator.advance('east', { descend: true });
  await f.navigator.advance('east', { descend: true });
  f.block('lava', [1, 11, 0]); const count = f.actions.length;
  await assert.rejects(f.navigator.retreat(), (error) => ['MINING_FLUID', 'MINING_ROUTE_CHANGED'].includes(error.code));
  assert.equal(f.actions.length, count);
});

test('the finite excavation budget cannot report an unbounded search as complete', async () => {
  const f = worldFixture({ maxActions: 3 });
  await assert.rejects(async () => {
    for (let i = 0; i < 10; i += 1) await f.navigator.advance('east', { descend: true });
  }, (error) => error.code === 'MINING_LIMIT');
  assert.ok(f.navigator.getState().moves < 10);
  assert.equal(f.stock.get('diamond') || 0, 0);
});

test('exhausting the excavation budget still reserves a safe retreat along already excavated cells', async () => {
  const f = worldFixture({ maxActions: 3 });
  await f.navigator.advance('east', { descend: true });
  await assert.rejects(f.navigator.advance('east', { descend: true }), (error) => error.code === 'MINING_LIMIT');
  await f.navigator.retreat();
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 12, 0));
});

test('fluids, falling blocks, and damaging support cells are classified as unsafe even with a solid collision box', () => {
  const f = worldFixture();
  for (const name of ['lava', 'water']) {
    f.block(name, [1, 12, 0]);
    assert.equal(classifyMiningBlock(f.bot.blockAt(new Vec3(1, 12, 0))).fluid, true);
  }
  for (const name of ['gravel', 'sand']) {
    f.block(name, [1, 12, 0]);
    assert.equal(classifyMiningBlock(f.bot.blockAt(new Vec3(1, 12, 0))).gravity, true);
  }
  for (const name of ['magma_block', 'campfire', 'fire', 'cactus']) {
    f.block(name, [1, 12, 0]);
    assert.equal(classifyMiningBlock(f.bot.blockAt(new Vec3(1, 12, 0))).hazard, true);
  }
});

test('lava appearing during a pending dig stops digging before the bot enters the new flow', async () => {
  let started;
  const digging = new Promise((resolve) => { started = resolve; });
  const f = worldFixture({ beforeDig: async () => { started(); await new Promise(() => {}); } });
  const running = f.navigator.advance('east', { descend: true });
  await digging;
  f.block('lava', [2, 11, 0]);
  f.bot.emit('blockUpdate', f.bot.blockAt(new Vec3(2, 11, 0)), f.bot.blockAt(new Vec3(2, 11, 0)));
  await assert.rejects(running, (error) => error.code === 'MINING_FLUID');
  assert.ok(f.stoppedDigs() > 0);
  assert.equal(f.actions.length, 0);
});

test('pause during a pending dig cancels the physical operation and leaves the route resumable', async () => {
  let started;
  const digging = new Promise((resolve) => { started = resolve; });
  const f = worldFixture({ beforeDig: async () => { started(); await new Promise(() => {}); } });
  const running = f.navigator.advance('east', { descend: true });
  await digging;
  f.pause(); f.bot.emit('blockUpdate', null, null);
  await assert.rejects(running, /paused/);
  assert.ok(f.stoppedDigs() > 0);
  assert.equal(f.actions.length, 0);
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 12, 0));
});

test('retreat and return revalidate a preserved mine route and stop when another player blocks it', async () => {
  const f = worldFixture();
  for (let i = 0; i < 4; i += 1) await f.navigator.advance('east', { descend: true });
  await f.navigator.retreat();
  assert.equal(f.navigator.getState().routeIndex, 0);
  assert.equal(f.navigator.getState().breadcrumbs.length, 5);
  await f.navigator.returnToFrontier();
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(4, 8, 0));
  await f.navigator.retreat(); f.block('lava', [2, 10, 0]);
  await assert.rejects(f.navigator.returnToFrontier(), (error) => ['MINING_FLUID', 'MINING_ROUTE_CHANGED'].includes(error.code));
  assert.ok(f.bot.entity.position.x < 2);
});

test('a stale pending move cannot stop or restore movements after a resumed execution takes ownership', async () => {
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  const f = worldFixture({ productionMove: true, beforeGoto: async () => { started(); await new Promise(() => {}); } });
  const oldRun = f.navigator.advance('east', { descend: true });
  await pending;
  const replacement = { owner: 'resumed execution' };
  f.bot.pathfinder.setMovements(replacement);
  const stops = f.motorStops();
  f.pause(); f.bot.emit('blockUpdate', null, null);
  await assert.rejects(oldRun, /paused/);
  assert.equal(f.bot.pathfinder.movements, replacement, 'Old cleanup cannot restore the prior movement configuration over a newer run');
  assert.equal(f.motorStops(), stops, 'Old cleanup cannot clear the newer run goal');
});

test('surface recovery can explicitly use actual leaf support while ordinary mining keeps rejecting it',async()=>{
 const ordinary=worldFixture();ordinary.block('oak_leaves',[1,11,0]);await assert.rejects(ordinary.navigator.advance({x:1,z:0}));
 const surface=worldFixture({allowLeafSupport:true});surface.block('oak_leaves',[1,11,0]);const result=await surface.navigator.advance({x:1,z:0});assert.equal(result.position.x,1);assert.equal(surface.actions.filter(a=>a.kind==='dig').length,0);
});

test('explicit escape staircase clears the verified ceiling before an actual upward step',async()=>{
 const f=worldFixture({allowCeilingClearance:true});f.block('stone',[0,14,0]);f.block('stone',[1,12,0]);
 const result=await f.navigator.advance({x:1,z:0},{ascend:true});assert.equal(result.position.y,13);assert.ok(f.actions.some(a=>a.kind==='dig'&&a.position.x===0&&a.position.y===14));
});

for(const name of ['ice','frosted_ice'])test(`mining may walk on ${name} but cannot open it into a fluid source`,()=>{
 const {inspectMiningStep}=require('../vendor/server/minecraft/miningNavigation');
 const make=(n,p)=>Object.assign(Block.fromStateId(registry.blocksByName[n].defaultState),{position:p});
 const floor=p=>make(p.y<=0?name:'air',p),from={x:0,y:1,z:0},direction={x:1,z:0};
 assert.equal(classifyMiningBlock(floor(new Vec3(0,0,0))).support,true);
 assert.equal(inspectMiningStep({blockAt:floor,from,direction,minY:-64,maxY:319}).ok,true);
 const obstacle=p=>p.x===1&&p.y===1&&p.z===0?make(name,p):floor(p);
 const plan=inspectMiningStep({blockAt:obstacle,from,direction,minY:-64,maxY:319});assert.equal(plan.ok,false);assert.equal(plan.code,'MINING_OBSTRUCTED');
});
