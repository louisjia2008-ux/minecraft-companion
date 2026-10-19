/* global require, setInterval, clearInterval, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder } = require('mineflayer-pathfinder');
const WorldSync = require('prismarine-world/src/worldsync');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');
const { createHouseQuarry } = require('../vendor/server/minecraft/houseQuarry');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = p => `${p.x},${p.y},${p.z}`;

// Offline voxel/drops unit fixture. Installed pathfinder plus installed vanilla
// Physics/PlayerState own every position/velocity update. No moveTo injection,
// teleport, target coordinate assignment or fabricated navigation checkpoint.
// Drop-to-inventory rules are explicit fixture transactions, not live evidence.
function fixture(t, options = {}) {
  const y = options.y ?? 64; const cells = new Map(); const stock = {}; const drops = [];
  const digs = []; const moves = []; const profiles = []; const provisions = []; const reports = []; const sharedPolicyChecks = [];
  const scanOrigins = []; const explorationSteps = []; let expectedScanOrigin = { x: 0, y, z: 0 };
  const token = new CancellationToken(); let checkpoint = null; let ticks = 0;
  const controls = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, false]));
  const pick = { name: 'iron_pickaxe', type: registry.itemsByName.iron_pickaxe.id, count: 1, durabilityUsed: 0 };
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', username: 'QuarryUnit', food: options.food ?? 20, health: options.health ?? 20,
    game: { dimension: 'overworld', minY: -64, height: 384 }, entities: {}, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    controlState: controls, heldItem: pick,
    entity: { position: new Vec3(0.5, y, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: 0, pitch: 0, effects: {}, attributes: {}, eyeHeight: 1.62, width: 0.6, height: 1.8,
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true, elytraFlying: false },
    setControlState: (name, value) => { controls[name] = value; },
    clearControlStates: () => { for (const name of Object.keys(controls)) controls[name] = false; },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
  });
  bot.inventory = { slots: Array(46).fill(null),
    items: () => [pick, ...Object.entries(stock).filter(([, count]) => count).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id }))],
    emptySlotCount: () => options.fullInventory ? 0 : 35 - Object.values(stock).reduce((sum, amount) => sum + Math.ceil(amount / 64), 0),
  };
  bot.blockAt = point => {
    const p = point.floored();
    const name = cells.get(key(p)) ?? options.worldAt?.(p) ?? (p.y >= y ? 'air' : p.y >= y - (options.dirtDepth ?? 3) ? 'dirt' : 'stone');
    if (name === 'UNLOADED') return null;
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p });
  };
  const world = new WorldSync(() => null); world.getBlock = point => bot.blockAt(point); bot.world = world;
  bot.canSeeBlock = cell => {
    const eye = bot.entity.position.offset(0, 1.62, 0); const delta = cell.position.offset(0.5, 0.5, 0.5).minus(eye);
    const distance = delta.norm();
    const hit = world.raycast(eye, delta.normalize(), distance + 0.01);
    return hit?.position?.equals(cell.position) === true;
  };
  // Match installed Mineflayer digging.canDigBlock. Navigation separately
  // limits checked dig reach to 4.5 and vein extraction checks actual sight.
  bot.canDigBlock = cell => cell?.diggable && bot.entity.position.offset(0, 1.65, 0).distanceTo(cell.position.offset(0.5, 0.5, 0.5)) <= 5.1;
  bot.findBlocks = ({ matching, maxDistance, count }) => {
    const origin = bot.entity.position.floored(); const found = [];
    scanOrigins.push({ actual: { x: origin.x, y: origin.y, z: origin.z }, expected: { ...expectedScanOrigin } });
    for (let dx = -maxDistance; dx <= maxDistance; dx += 1) for (let dy = -maxDistance; dy <= maxDistance; dy += 1) for (let dz = -maxDistance; dz <= maxDistance; dz += 1) {
      if (Math.hypot(dx, dy, dz) > maxDistance) continue;
      const p = origin.offset(dx, dy, dz); const cell = bot.blockAt(p);
      if (cell && (typeof matching === 'function' ? matching(cell) : matching.includes(cell.type))) found.push(p);
    }
    return found.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin)).slice(0, count);
  };
  bot.physics = Physics(registry, world); pathfinder(bot);
  const nativeGoto = bot.pathfinder.goto.bind(bot.pathfinder);
  bot.pathfinder.goto = goal => { const p = bot.pathfinder.movements;
    moves.push({ x: goal.x, y: goal.y, z: goal.z, canDig: p.canDig, parkour: p.allowParkour, towers: p.allow1by1towers, scaffold: p.scafoldingBlocks.length }); return nativeGoto(goal); };
  const nativeSetMovements = bot.pathfinder.setMovements.bind(bot.pathfinder);
  bot.pathfinder.setMovements = movements => { profiles.push(movements); nativeSetMovements(movements); };
  const pickup = () => {
    for (let i = drops.length - 1; i >= 0; i -= 1) {
      const item = drops[i], feet = bot.entity.position;
      if (Math.abs(item.position.x - feet.x) <= 1.3 && Math.abs(item.position.z - feet.z) <= 1.3 && item.position.y >= feet.y - 0.5 && item.position.y <= feet.y + 2.3) {
        stock[item.name] = (stock[item.name] || 0) + item.count; drops.splice(i, 1);
      }
    }
  };
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot); ticks += 1; pickup(); bot.emit('physicsTick');
  }, 5);
  const deps = { getBot: () => bot, assertActive: () => token.throwIfRequested(), getCP: () => checkpoint,
    saveCP: state => { checkpoint = JSON.parse(JSON.stringify(state)); }, report: message => {
      reports.push(message);
      if (message.startsWith('正在自然采集')) {
        const p = bot.entity.position.floored(); expectedScanOrigin = { x: p.x, y: p.y, z: p.z };
        explorationSteps.push({ from: { ...scanOrigins.at(-1).actual }, to: { ...expectedScanOrigin } });
      }
    },
    isProtectedDig: p => { sharedPolicyChecks.push({ x: p.x, y: p.y, z: p.z }); return options.sharedProtected?.(p) ?? false; },
    ensureSticks: async () => {}, ensurePickaxe: async () => { bot.heldItem = pick; },
    ensureFood: async opts => { provisions.push(opts); }, equipItem: async item => { bot.heldItem = item; },
    digBlock: async cell => {
      token.throwIfRequested(); assert.equal(bot.entity.onGround, true, 'Native dig begins after actual physics landing');
      if (options.sharedProtected?.(cell.position)) throw Object.assign(Error('host protected transport floor'), { code: 'house_resource_protected' });
      digs.push({ name: cell.name, position: cell.position.clone(), feet: bot.entity.position.clone() });
      const previous = bot.blockAt(cell.position); cells.set(key(cell.position), 'air');
      const name = { stone: 'cobblestone', cobblestone: 'cobblestone', iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
        gold_ore: 'raw_gold', copper_ore: 'raw_copper', diamond_ore: 'diamond', coal_ore: 'coal', deepslate_coal_ore: 'coal', lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli', dirt: 'dirt' }[cell.name];
      if (name && !options.noDrops) drops.push({ position: cell.position.offset(0.5, 0.2, 0.5), name, count: name === 'lapis_lazuli' ? 6 : 1 });
      bot.emit('blockUpdate', previous, bot.blockAt(cell.position));
      if (options.pauseOnFirstDig && digs.length === 1) token.pause();
    },
    collectDrops: async () => { await sleep(15); pickup(); },
    navigationOptions: { goto: goal => bot.pathfinder.goto(goal), movementTimeoutMs: 2500, sleep: ms => sleep(Math.min(ms, 5)) },
    limits: { branchSteps: 4, descentSteps: 16, ...(options.limits || {}) },
  };
  const quarry = (options.quarryFactory || createHouseQuarry)(deps);
  t.after(() => { clearInterval(timer); bot.pathfinder.setGoal(null); bot.clearControlStates(); });
  return { bot, quarry, stock, cells, digs, moves, profiles, provisions, reports, sharedPolicyChecks, scanOrigins, explorationSteps, token, deps,
    anchor: { x: 0, y, z: 0 }, checkpoint: () => checkpoint, ticks: () => ticks };
}

test('bulk quarry prepares torches before descending and lights its physically walked route', { timeout: 20000 },async t=>{
 const f=fixture(t,{limits:{branchSteps:16}}),placements=[];let prepared=false;
 f.deps.ensureLighting=async()=>{assert.equal(f.bot.entity.position.floored().equals(new Vec3(0,64,0)),true);f.stock.torch=16;prepared=true;};
 const dig=f.deps.digBlock;f.deps.digBlock=async b=>{assert.equal(prepared,true);await dig(b);};
 f.deps.lightRoute=(nav,previous)=>require('../vendor/server/minecraft/houseQuarryLighting').lightHouseQuarry({
  getBot:()=>f.bot,assertActive:()=>f.token.throwIfRequested(),isExcluded:()=>false,
  place:async p=>{assert.equal(f.bot.entity.onGround,true);f.cells.set(key(p),'torch');f.stock.torch--;placements.push({...p});},
 },nav,previous);
 const result=await f.quarry.gather('cobblestone',24,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.ok(placements.length>0);assert.ok(f.ticks()>0);
 assert.ok(f.checkpoint().routes.cobblestone.lighting.length>0);
 f.deps.hasFurnace=()=>true;prepared=false;
 await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 assert.equal(prepared,true,'A later small batch with a real furnace must also prepare lighting');
});

test('shallow empty-camp stone bootstrap digs through natural dirt, collects actual drops and physically returns', { timeout: 15000 }, async t => {
  const f = fixture(t); const result = await f.quarry.gather('cobblestone', 8, { anchor: f.anchor })
    .catch(error => { error.message += ` ${JSON.stringify(error.rejections || f.checkpoint())}`; throw error; });
  assert.equal(result.confirmed, true); assert.ok(f.stock.cobblestone >= 8);
  assert.ok(f.digs.some(d => d.position.y < f.anchor.y - 2));
  assert.ok(f.ticks() > 0 && f.moves.length > 0); assert.equal(f.bot.entity.onGround, true);
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 64, 0));
  assert.equal(f.checkpoint().routes.cobblestone.navigation.routeIndex, 0);
  assert.equal(f.provisions.length, 0, 'First furnace stone cannot recursively demand a cooked-food furnace');
  assert.ok(f.moves.every(m => !m.canDig && !m.parkour && !m.towers && m.scaffold === 0));
});

test('a deep dirt hillside lowers the bounded stone search only after actual barren level steps', { timeout: 20000 }, async t => {
  const f = fixture(t, { dirtDepth: 10, limits: { branchSteps: 16, descentSteps: 24 } });
  const result = await f.quarry.gather('cobblestone', 4, { anchor: f.anchor });
  assert.equal(result.confirmed, true);
  assert.ok(f.stock.cobblestone >= 4);
  assert.ok(f.checkpoint().routes.cobblestone.stoneSearch.targetY < f.anchor.y - 5);
  assert.ok(f.digs.some(d => d.position.y < f.anchor.y - 10));
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5, f.anchor.y, .5)) < .2);
  const floors = new Set(f.checkpoint().routes.cobblestone.navigation.breadcrumbs.map(p => `${p.x},${p.y - 1},${p.z}`));
  assert.ok(f.digs.every(d => !floors.has(key(d.position))), 'Even harvest never mines its own recorded return floor');
});

test('shared host transport floors are filtered before native vein harvest while other stone remains collectible', { timeout: 20000 }, async t => {
  const protectedPoint = '0,63,1';
  const f = fixture(t, { dirtDepth: 1, sharedProtected: p => key(p) === protectedPoint });
  f.cells.set(protectedPoint, 'stone');
  const result = await f.quarry.gather('cobblestone', 2, { anchor: f.anchor });
  assert.equal(result.confirmed, true); assert.ok(f.stock.cobblestone >= 2);
  assert.ok(f.sharedPolicyChecks.length > 0, 'Quarry itself consulted the shared host policy before native dig');
  assert.equal(f.cells.get(protectedPoint), 'stone');
  assert.ok(f.digs.every(d => key(d.position) !== protectedPoint));
  assert.equal(f.bot.entity.onGround, true);
});

test('an unknown shared protection result cannot authorize extraction or grant inventory', { timeout: 10000 }, async t => {
  const f = fixture(t); f.deps.isProtectedDig = () => undefined;
  await assert.rejects(f.quarry.gather('cobblestone', 1, { anchor: f.anchor }), { code: 'house_quarry_no_safe_route' });
  assert.equal(f.digs.length, 0); assert.equal(f.stock.cobblestone || 0, 0);
  assert.equal(f.bot.entity.onGround, true);
});

for (const [name, y, ore, additional] of [
  ['raw_iron', 20, 'iron_ore', 2], ['coal', 52, 'coal_ore', 2], ['lapis_lazuli', 4, 'lapis_ore', 6],
]) test(`${name}: native descent exposes the real ore layer, confirms additional inventory and retreats`, { timeout: 15000 }, async t => {
  const f = fixture(t, { y, dirtDepth: 1 });
  const level = { raw_iron: 16, coal: 48, lapis_lazuli: 0 }[name];
  // The lower ore remains a legitimate floor when native pickup climbs onto
  // it. Include a second exposed upper ore rather than demanding excavation
  // of that saved return-route support.
  f.cells.set(`4,${level},1`, ore); f.cells.set(`4,${level + 1},1`, ore); f.cells.set(`5,${level + 1},1`, ore);
  const result = await f.quarry.gather(name, additional, { anchor: f.anchor })
    .catch(error => { error.message += ` ${JSON.stringify({ stock: f.stock, oreDigs: f.digs.filter(d => d.name === ore), cp: f.checkpoint() })}`; throw error; });
  assert.ok(result.after >= additional); assert.ok(f.digs.some(d => d.name === ore));
  assert.equal(f.provisions.length, 1); assert.equal(f.provisions[0].minFoodPoints, 24);
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, y, 0));
});

test('a protected east construction footprint changes the actual quarry direction before any dig', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const bounds = { minX: 1, maxX: 12, minY: -64, maxY: 320, minZ: -1, maxZ: 1 };
  await f.quarry.gather('cobblestone', 4, { anchor: f.anchor, excludeBounds: [bounds] });
  assert.ok(f.moves.some(m => m.x < 0));
  assert.ok(f.digs.every(d => !(d.position.x >= bounds.minX && d.position.x <= bounds.maxX && d.position.z >= -1 && d.position.z <= 1)));
});

test('loaded lava rejects an unsafe descent and no fluid is excavated or entered', { timeout: 15000 }, async t => {
  const f = fixture(t); f.cells.set('1,63,0', 'lava');
  await f.quarry.gather('cobblestone', 4, { anchor: f.anchor });
  assert.ok(f.moves.some(m => m.x < 0)); assert.ok(f.digs.every(d => d.name !== 'lava'));
  assert.equal(f.cells.get('1,63,0'), 'lava'); assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 64, 0));
});

test('four lava-blocked down steps use the unchanged bounded level detour before descending', { timeout: 15000 }, async t => {
  const f = fixture(t, { limits: { branchSteps: 8 } });
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.cells.set(`${x},62,${z}`, 'lava');
  await f.quarry.gather('cobblestone', 4, { anchor: f.anchor });
  assert.ok(f.reports.some(message => message.includes('同层矿道绕行') && message.includes('lava')));
  assert.ok(f.moves.some(m => m.y === f.anchor.y && (m.x !== 0 || m.z !== 0)));
  assert.ok(f.stock.cobblestone >= 4); assert.ok(f.digs.every(d => d.name !== 'lava'));
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 64, 0));
});

test('switching resource routes preserves every actual floor of the previous quarry breadcrumb', { timeout: 15000 }, async t => {
  const f = fixture(t);
  f.cells.set('1,62,0', 'coal_ore');
  f.cells.set('-1,63,0', 'coal_ore'); f.cells.set('-1,64,0', 'coal_ore'); f.cells.set('-2,64,0', 'coal_ore');
  await f.quarry.gather('cobblestone', 4, { anchor: f.anchor });
  const oldRoute = f.checkpoint().routes.cobblestone.navigation;
  const floors = oldRoute.breadcrumbs.map(p => new Vec3(p.x, p.y - 1, p.z));
  assert.ok(floors.some(p => key(p) === '1,62,0'), 'The first real route actually relies on the protected ore floor');
  const before = new Map(floors.map(p => [key(p), f.bot.blockAt(p).name])); const digStart = f.digs.length;
  await f.quarry.gather('coal', 2, { anchor: f.anchor })
    .catch(error => { error.message += ` ${JSON.stringify({ stock: f.stock, coalDigs: f.digs.filter(d => d.name === 'coal_ore'), cp: f.checkpoint() })}`; throw error; });
  assert.ok(f.stock.coal >= 2); assert.equal(f.checkpoint().activeResource, 'coal');
  assert.deepEqual(f.checkpoint().routes.cobblestone.navigation.breadcrumbs, oldRoute.breadcrumbs);
  for (const p of floors) assert.equal(f.bot.blockAt(p).name, before.get(key(p)));
  assert.ok(f.digs.slice(digStart).every(d => !before.has(key(d.position))));
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 64, 0));
});
test('a stale other-resource frontier index reconciles only at the real fixed entry without replay or movement credit',{timeout:15000},async t=>{
 const f=fixture(t);f.cells.set('1,62,0','coal_ore');f.cells.set('-1,63,0','coal_ore');f.cells.set('-1,64,0','coal_ore');f.cells.set('-2,64,0','coal_ore');
 await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 const old=f.checkpoint().routes.cobblestone.navigation,before=JSON.parse(JSON.stringify(old));
 old.routeIndex=old.breadcrumbs.length-1;assert.ok(old.routeIndex>0);
 await f.quarry.gather('coal',2,{anchor:f.anchor});
 const saved=f.checkpoint().routes.cobblestone;
 assert.equal(saved.navigation.routeIndex,0);assert.equal(saved.navigation.moves,before.moves);assert.equal(saved.navigation.dug,before.dug);
 assert.deepEqual(saved.navigation.breadcrumbs,before.breadcrumbs);assert.equal(saved.entryReconciliations[0].newMoveOrDigCredit,false);
 assert.ok(f.stock.coal>=2);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
});

test('small furnace stone batches stop pickup excursions after actual inventory gain', { timeout: 15000 }, async t => {
  const f = fixture(t, { y: 20, dirtDepth: 1 });
  const result = await f.quarry.gather('cobblestone', 8, { anchor: f.anchor });
  assert.equal(result.confirmed, true);
  assert.ok(f.stock.cobblestone >= 8);
  assert.equal(f.checkpoint().routes.cobblestone.navigation.routeIndex, 0);
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 20, 0));
  // Negative control disables only inventory-receipt pickup optimization;
  // both runs retain the same real raycast range and original physics.
  const Module = require('node:module'), fs = require('node:fs');
  const filename = require.resolve('../vendor/server/minecraft/houseQuarry');
  const control = new Module(filename, module); control.filename = filename; control.paths = module.paths;
  const nativeRequire = control.require.bind(control);
  control.require = name => {
    const value = nativeRequire(name);
    if (name !== './miningNavigation') return value;
    return { ...value, createMiningNavigator: deps => {
      const nav = value.createMiningNavigator(deps), mine = nav.mineVein;
      nav.mineVein = (position, options) => mine(position, { ...options, getCollectedCount: undefined });
      return nav;
    } };
  };
  control._compile(fs.readFileSync(filename, 'utf8'), filename);
  const baseline = fixture(t, { y: 20, dirtDepth: 1, quarryFactory: control.exports.createHouseQuarry });
  const before = await baseline.quarry.gather('cobblestone', 8, { anchor: baseline.anchor });
  assert.equal(before.confirmed, true);
  assert.ok(f.moves.length < baseline.moves.length, `Actual receipt saves native walks: ${f.moves.length} versus ${baseline.moves.length}`);
});

test('nested tool preparation merges a separately gathered real stone route and protects its ore floor', { timeout: 15000 }, async t => {
  // Bedrock walls force actual corridor extension; a broad visible stone vein
  // may legitimately satisfy the second batch without extending any route.
  const f = fixture(t, { y: 20, dirtDepth: 1, worldAt: p => p.z !== 0 && p.y < 20 ? 'bedrock' : undefined });
  f.cells.set('1,18,0', 'iron_ore');
  f.cells.set('-1,19,0', 'iron_ore'); f.cells.set('-1,20,0', 'iron_ore'); f.cells.set('-2,20,0', 'iron_ore');
  const nativeEnsure = f.deps.ensurePickaxe;
  let innerRoute, innerFloors, digStart;
  f.deps.ensurePickaxe = async (block, options) => {
    if (!innerRoute && options.resource === 'raw_iron') {
      const nested = createHouseQuarry({ ...f.deps, ensurePickaxe: nativeEnsure });
      await nested.gather('cobblestone', 2, { anchor: f.anchor });
      const originalLength = f.checkpoint().routes.cobblestone.navigation.breadcrumbs.length;
      await nested.gather('cobblestone', 16, { anchor: f.anchor });
      innerRoute = f.checkpoint().routes.cobblestone.navigation;
      assert.ok(innerRoute.breadcrumbs.length > originalLength, 'The nested resource really extends its own saved route');
      innerFloors = new Map(innerRoute.breadcrumbs.map(p => {
        const floor = new Vec3(p.x, p.y - 1, p.z); return [key(floor), f.bot.blockAt(floor).name];
      }));
      digStart = f.digs.length;
    }
    await nativeEnsure(block, options);
  };
  await f.quarry.gather('raw_iron', 2, { anchor: f.anchor });
  assert.ok(innerFloors.has('1,18,0'), 'Nested native movement really depends on the protected ore floor');
  assert.deepEqual(f.checkpoint().routes.cobblestone.navigation, innerRoute, 'Outer save keeps the new nested checkpoint');
  assert.ok(f.stock.raw_iron >= 2); assert.ok(f.stock.cobblestone >= 4);
  assert.ok(f.digs.slice(digStart).every(d => !innerFloors.has(key(d.position))));
  for (const [position, name] of innerFloors) assert.equal(f.bot.blockAt(new Vec3(...position.split(',').map(Number))).name, name);
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 20, 0));
});

test('all protected directions fail bounded and preserve a real grounded camp without dig', async t => {
  const f = fixture(t);
  const excluded = { minX: -20, maxX: 20, minY: -64, maxY: 63, minZ: -20, maxZ: 20 };
  await assert.rejects(f.quarry.gather('cobblestone', 4, { anchor: f.anchor, excludeBounds: [excluded] }), e => e.code === 'house_quarry_no_safe_route');
  assert.equal(f.digs.length, 0); assert.equal(f.moves.length, 0); assert.equal(f.bot.entity.onGround, true);
});

test('low health preserves the original safe retreat contract instead of starting new excavation', async t => {
  const f = fixture(t, { health: 4 });
  await assert.rejects(f.quarry.gather('cobblestone', 4, { anchor: f.anchor }), e => e.code === 'house_quarry_low_health');
  assert.equal(f.digs.length, 0); assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0, 64, 0));
});

test('a real pause during the first native dig cannot start another dig or delayed goto', async t => {
  const f = fixture(t, { pauseOnFirstDig: true });
  await assert.rejects(f.quarry.gather('cobblestone', 4, { anchor: f.anchor }), e => e.code === 'paused');
  const moves = f.moves.length; await sleep(50);
  assert.equal(f.digs.length, 1); assert.equal(f.moves.length, moves);
});

test('actual inventory capacity and resource-search limits cannot be replaced by successful logical counters', { timeout: 15000 }, async t => {
  const full = fixture(t, { fullInventory: true });
  await assert.rejects(full.quarry.gather('cobblestone', 4, { anchor: full.anchor }), e => e.code === 'house_quarry_inventory_full');
  assert.equal(full.digs.length, 0);
  const noOre = fixture(t, { y: 17, dirtDepth: 1, limits: { branchSteps: 1 } });
  await assert.rejects(noOre.quarry.gather('raw_iron', 1, { anchor: noOre.anchor }), e => e.code === 'house_quarry_search_limit');
  assert.equal(noOre.stock.raw_iron, undefined); assert.deepEqual(noOre.bot.entity.position.floored(), new Vec3(0, 17, 0));
});

test('repeated real gathers retain the fixed camp and add to actual stock through saved native breadcrumbs', { timeout: 20000 }, async t => {
  const f = fixture(t); await f.quarry.gather('cobblestone', 4, { anchor: f.anchor });
  const before = f.stock.cobblestone;
  const result = await f.quarry.gather('cobblestone', 4, { anchor: f.anchor });
  assert.equal(result.before, before); assert.ok(result.after >= before + 4);
  await assert.rejects(f.quarry.gather('cobblestone', 1, { anchor: { ...f.anchor, x: 1 } }), e => e.code === 'house_quarry_checkpoint_mismatch');
});

test('critical hunger cannot be replaced by fabricated provisioning or injected navigation', async t => {
  const f = fixture(t, { food: 7 });
  await assert.rejects(f.quarry.gather('cobblestone', 8, { anchor: f.anchor }), e => e.code === 'house_quarry_food_required');
  assert.equal(f.provisions.length, 1); assert.equal(f.provisions[0].bootstrap, true); assert.equal(f.digs.length, 0);
  assert.throws(() => createHouseQuarry({ ...f.deps, navigationOptions: { moveTo: () => {} } }), e => e.code === 'house_quarry_invalid_navigation');
});

test('native vein pickup excursions return to the actual exploration frontier before another scan', { timeout: 20000 }, async t => {
  const f = fixture(t, { dirtDepth: 1, noDrops: true, limits: { branchSteps: 2, descentSteps: 8 } });
  await assert.rejects(f.quarry.gather('cobblestone', 8, { anchor: f.anchor }), error => error.code === 'house_quarry_search_limit');
  assert.ok(f.scanOrigins.length >= 3, 'Multiple real exploration legs and vein scans occurred');
  assert.ok(f.moves.length > f.scanOrigins.length * 2, 'Native pickup made checked movement excursions');
  for (const scan of f.scanOrigins) assert.deepEqual(scan.actual, scan.expected, 'Pickup endpoint cannot replace the exploration frontier');
  for (const step of f.explorationSteps) {
    assert.equal(Math.abs(step.to.x-step.from.x)+Math.abs(step.to.z-step.from.z),1,'Each exploration step starts at its captured scan origin');
    assert.ok(step.to.y===step.from.y||step.to.y===step.from.y-1);
  }
  assert.equal(f.bot.entity.onGround, true); assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0,64,0));
  assert.equal(f.stock.cobblestone || 0, 0, 'Missing drops remain missing, despite actual dig and movement');
});

function deadEndFixture(t,branchSteps=8) {
  const f=fixture(t,{limits:{branchSteps,descentSteps:20}});
  for(let x=1;x<=5;x++)for(let z=-2;z<=2;z++)for(let y=57;y<=67;y++)f.cells.set(`${x},${y},${z}`,'bedrock');
  for(let x=1;x<=3;x++){
    const y=64-x;
    for(let h=y;h<=y+2;h++)f.cells.set(`${x},${h},0`,'dirt');
    f.cells.set(`${x},${y-1},0`,'dirt');
  }
  return f;
}
test('a real bedrock dead end backtracks its recorded stairs and explores an unvisited safe branch', { timeout: 20000 }, async t => {
  const f=deadEndFixture(t);
  await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
  assert.ok(f.moves.some(p=>p.x===3&&p.y===61),'Installed native movement actually reached the dead end');
  assert.ok(f.moves.some(p=>p.x<0),'Another branch was actually reached after retreat');
  assert.ok(f.stock.cobblestone>=4);assert.ok(f.digs.every(d=>d.name!=='bedrock'));
  assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));assert.equal(f.bot.entity.onGround,true);
  assert.ok(f.checkpoint().routes.cobblestone.searchBacktracks>=3);
});
test('dead-end retreat consumes the original branch budget and cannot reset search until successful', { timeout: 10000 }, async t => {
 const f=deadEndFixture(t,1);
 await assert.rejects(f.quarry.gather('cobblestone',4,{anchor:f.anchor}),{code:'house_quarry_search_limit'});
 assert.equal(f.checkpoint().routes.cobblestone.searchBacktracks,1);assert.equal(f.stock.cobblestone||0,0);
 assert.ok(f.moves.every(p=>p.x>=0));assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));assert.equal(f.bot.entity.onGround,true);
});
test('pause after an actual dead-end retreat cannot excavate another branch or send a late native goal', { timeout: 10000 }, async t => {
 const f=deadEndFixture(t),report=f.deps.report;
 f.deps.report=(message,...args)=>{report(message,...args);if(message.includes('矿道尽头受阻'))f.token.pause();};
 await assert.rejects(f.quarry.gather('cobblestone',4,{anchor:f.anchor}),{code:'paused'});
 const count=f.moves.length,digs=f.digs.length;await sleep(80);
 assert.equal(f.moves.length,count);assert.equal(f.digs.length,digs);assert.equal(f.checkpoint().routes.cobblestone.searchBacktracks,1);
 assert.equal(f.bot.entity.onGround,true);assert.ok(f.moves.every(p=>p.x>=0));
});

test('partial health and hunger permit actual shallow tool-stone gathering',{timeout:15000},async t=>{
 const f=fixture(t,{health:8,food:12});const r=await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 assert.ok(r.after>=r.before+4);assert.ok(f.digs.length>0);
});

test('a newly flooded saved branch is retired only after a real return, then a dry alternative yields stone',{timeout:15000},async t=>{
 const f=fixture(t);await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 const old=f.checkpoint().routes.cobblestone.navigation,first=old.breadcrumbs[1];
 f.cells.set(key(first),'water');const before=f.stock.cobblestone;
 const result=await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 assert.ok(result.after>=before+4);assert.equal(f.bot.blockAt(new Vec3(first.x,first.y,first.z)).name,'water');
 assert.equal(f.checkpoint().routes.cobblestone.abandonedNavigations.at(-1).reason,'MINING_FLUID');
 assert.equal(f.bot.entity.onGround,true);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,f.anchor.y,.5))<.2);
});

test('a destroyed old quarry branch is archived only while actually at entry, then fresh stone is acquired',{timeout:15000},async t=>{
 const f=fixture(t);await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 const cp=f.checkpoint(),old=cp.routes.cobblestone.navigation,first=old.breadcrumbs[1];assert.ok(first);
 old.breadcrumbs=old.breadcrumbs.slice(0,2);old.routeIndex=0;
 f.cells.set(`${first.x},${first.y-1},${first.z}`,'air');const before=f.stock.cobblestone;
 const result=await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 assert.ok(result.after>=before+4);assert.equal(f.checkpoint().routes.cobblestone.abandonedNavigations.length,1);
 assert.equal(f.checkpoint().routes.cobblestone.abandonedNavigations[0].reason,'MINING_ROUTE_CHANGED');
 assert.ok(f.checkpoint().routes.cobblestone.abandonedNavigations[0].visited.length>0);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
});

test('legacy retired excavation visits cannot forbid every fresh safe entry direction',{timeout:15000},async t=>{
 const f=fixture(t);await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 const route=f.checkpoint().routes.cobblestone;
 const stale=[{x:1,y:63,z:0},{x:-1,y:63,z:0},{x:0,y:63,z:1},{x:0,y:63,z:-1}];
 route.abandonedNavigations=[{at:1,reason:'MINING_ROUTE_CHANGED',navigation:{breadcrumbs:stale,routeIndex:0}}];
 route.navigation={breadcrumbs:[{x:0,y:64,z:0}],routeIndex:0,dug:0,moves:0};
 route.visited=stale.map(key);delete route.visitedNavigationSchema;
 const before=f.stock.cobblestone;const result=await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 assert.ok(result.after>=before+4);
 const saved=f.checkpoint().routes.cobblestone;
 assert.equal(saved.visitedNavigationSchema,1);
 assert.deepEqual(saved.previousVisited.at(-1).visited,stale.map(key));
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
});

test('descent detour plans around host-protected walking floors before committing to a branch',{timeout:15000},async t=>{
 const protectedFloor=p=>p.y===63&&Math.abs(p.x)<=2&&Math.abs(p.z)<=2;
 const f=fixture(t,{dirtDepth:1,sharedProtected:protectedFloor});
 const result=await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 assert.ok(result.after>=4);assert.ok(f.moves.some(p=>Math.abs(p.x)>2||Math.abs(p.z)>2));
 assert.ok(f.digs.every(d=>!protectedFloor(d.position)));assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
});

for (const policy of ['normal','protected','wrong_tool','no_receipt','no_capacity']) test(`incidental visible copper uses the same checked native trip: ${policy}`,{timeout:20000},async t=>{
 const ore = '-1,64,0';
 const f=fixture(t,{dirtDepth:1,sharedProtected:p=>policy==='protected'&&key(p)===ore,noDrops:false});
 f.deps.hasFurnace=()=>true;
 f.cells.set(ore,policy==='wrong_tool'?'diamond_ore':'copper_ore');
 if(policy==='wrong_tool'){
   const pick=f.bot.inventory.items()[0];pick.name='stone_pickaxe';pick.type=registry.itemsByName.stone_pickaxe.id;
 }
 if(policy==='no_capacity')f.bot.inventory.emptySlotCount=()=>3;
 if(policy==='no_receipt'){
   const dig=f.deps.digBlock;
   f.deps.digBlock=async block=>{await dig(block);};
   // Realistic lost copper drops: stone receipts still drive the main goal.
   // The fixture drop map uses an uncollected replacement item for this case.
   const inventory=f.bot.inventory.items;
   f.bot.inventory.items=()=>inventory().filter(item=>item.name!=='raw_copper');
 }
 const result=await f.quarry.gather('cobblestone',2,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
 const receipts=f.checkpoint().routes.cobblestone.incidentalReceipts||[];
 if(policy==='normal'){
   assert.ok(f.stock.raw_copper>=1);assert.ok(receipts.some(r=>r.resource==='raw_copper'&&r.after>r.before));
 }else if(policy==='no_receipt'){
   assert.ok(receipts.some(r=>r.resource==='raw_copper'&&r.mined>0&&r.after===r.before));
 }else{
   assert.equal(f.cells.get(ore),policy==='wrong_tool'?'diamond_ore':'copper_ore');assert.equal(f.stock.raw_copper||0,0);
 }
 const floors=new Set(f.checkpoint().routes.cobblestone.navigation.breadcrumbs.map(p=>`${p.x},${p.y-1},${p.z}`));
 assert.ok(f.digs.every(d=>!floors.has(key(d.position))));
});

test('an upgraded pick harvests visible gold on outbound replay without truncating the recorded future',{timeout:20000},async t=>{
 const f=fixture(t,{dirtDepth:1,limits:{branchSteps:16}});f.deps.hasFurnace=()=>true;
 await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 const before=f.checkpoint().routes.cobblestone.navigation.breadcrumbs;
 assert.ok(before.length>1);
 f.cells.set('-1,64,0','gold_ore');
 const result=await f.quarry.gather('cobblestone',2,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.equal(f.cells.get('-1,64,0'),'air');
 const receipts=f.checkpoint().routes.cobblestone.incidentalReceipts||[];
 assert.ok(receipts.some(r=>r.resource==='raw_gold'&&r.replay===true&&r.mined>0));
 const after=f.checkpoint().routes.cobblestone.navigation.breadcrumbs;
 assert.deepEqual(after.slice(0,before.length),before);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
 assert.ok(f.stock.raw_gold>=1,'Native simulated pickup on the original return route acquired the adjacent gold');
});

test('a boxed fishbone main physically backs out and finds ore without replaying the dead tip',{timeout:20000},async t=>{
 const f=fixture(t,{y:17,dirtDepth:1,limits:{branchSteps:64}});f.deps.hasFurnace=()=>true;
 for(const [x,z]of [[3,0],[2,1],[2,-1]])f.cells.set(`${x},15,${z}`,'air');
 f.cells.set('1,16,-6','iron_ore');
 const result=await f.quarry.gather('raw_iron',1,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.ok(f.stock.raw_iron>=1);
 const route=f.checkpoint().routes.raw_iron;
 assert.ok(route.searchBacktracks>=1);
 assert.ok(route.previousFishbones.some(p=>p.retiredReason==='actual_dead_end_backtrack'));
 assert.ok(f.digs.some(d=>d.position.z<0));
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,17,0));
 assert.ok(f.digs.every(d=>![[3,0],[2,1],[2,-1]].some(([x,z])=>d.position.x===x&&d.position.y===15&&d.position.z===z)));
});

test('native ore exploration opens a paired fishbone branch and physically returns to its main junction',{timeout:20000},async t=>{
 const f=fixture(t,{y:17,dirtDepth:1,limits:{branchSteps:64}});f.deps.hasFurnace=()=>true;
 f.cells.set('5,16,5','iron_ore');f.cells.set('5,17,5','iron_ore');
 const result=await f.quarry.gather('raw_iron',2,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.ok(f.stock.raw_iron>=2);
 const route=f.checkpoint().routes.raw_iron,branches=route.finishedFishboneBranches||[];
 assert.ok(branches.some(branch=>branch.returned&&branch.points.length===13));
 assert.deepEqual(branches[0].points[0],{x:4,y:16,z:0});
 assert.deepEqual(branches[0].points.at(-1),{x:4,y:16,z:-12});
 assert.ok(f.digs.some(d=>d.position.z>0));
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,17,0));
 const floors=new Set(branches.flatMap(branch=>branch.points).map(p=>`${p.x},${p.y-1},${p.z}`));
 assert.ok(f.digs.every(d=>!floors.has(key(d.position))));
});

test('a pause after a real fishbone step preserves pending confirmation and resumes the same branch',{timeout:20000},async t=>{
 const f=fixture(t,{y:17,dirtDepth:1,limits:{branchSteps:64}});f.deps.hasFurnace=()=>true;
 f.cells.set('5,16,5','iron_ore');f.cells.set('5,17,5','iron_ore');
 let interrupted=false;const save=f.deps.saveCP;
 f.deps.saveCP=state=>{
   save(state);const pending=state.routes.raw_iron?.fishbone?.pending;
   if(!interrupted&&pending?.target.z===-1&&state.routes.raw_iron.navigation.routeIndex===pending.fromIndex+1){
     interrupted=true;f.token.pause();
   }
 };
 await assert.rejects(f.quarry.gather('raw_iron',2,{anchor:f.anchor}),{code:'paused'});
 assert.equal(interrupted,true);
 const plan=f.checkpoint().routes.raw_iron.fishbone;
 assert.equal(plan.stage,'left');assert.equal(plan.progress,0);assert.ok(plan.pending);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(4,16,-1));
 f.token.resume();
 const result=await f.quarry.gather('raw_iron',2,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.ok(f.stock.raw_iron>=2);
 assert.equal(f.checkpoint().routes.raw_iron.fishbone.pending,null);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,17,0));
});

test('a nearly worn iron pick is reserved for tier-required ores while native stone extraction uses its real stone backup',{timeout:15000},async t=>{
 const f=fixture(t),iron=f.bot.inventory.items()[0];iron.durabilityUsed=200;
 const stone={name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,count:1,durabilityUsed:0};
 const items=f.bot.inventory.items;f.bot.inventory.items=()=>[...items(),stone];
 let stoneDigs=0;const dig=f.deps.digBlock;
 f.deps.digBlock=async block=>{if(block.name==='stone'){assert.equal(f.bot.heldItem.name,'stone_pickaxe');stoneDigs++;}await dig(block);};
 const result=await f.quarry.gather('cobblestone',4,{anchor:f.anchor});
 assert.ok(result.after>=4);assert.ok(stoneDigs>=4);assert.equal(iron.durabilityUsed,200);
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
});
test('reserving an iron pick never substitutes an unharvestable stone tool for visible gold',()=>{
 const {canSpendQuarryPickaxe:spend}=require('../vendor/server/minecraft/houseQuarry');
 const iron={name:'iron_pickaxe',type:registry.itemsByName.iron_pickaxe.id,count:1,durabilityUsed:200};
 const stone={name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,count:1,durabilityUsed:0};
 const bot={registry};const b=name=>Block.fromStateId(registry.blocksByName[name].defaultState);
 assert.equal(spend(bot,b('stone'),iron),false);assert.equal(spend(bot,b('stone'),stone),true);
 assert.equal(spend(bot,b('iron_ore'),iron),false);assert.equal(spend(bot,b('iron_ore'),stone),true);
 assert.equal(spend(bot,b('gold_ore'),iron),true);assert.equal(spend(bot,b('gold_ore'),stone),false);
 assert.equal(spend(bot,null,iron),false);iron.durabilityUsed=249;assert.equal(spend(bot,b('gold_ore'),iron),false);
});

for(const mode of ['resume','cancel','failed_defense'])test(`formal12 interrupted tool provisioning preserves its entry/frontier and owner: ${mode}`,{timeout:20000},async t=>{
 const f=fixture(t,{soilDepth:0,limits:{branchSteps:16}}),nativeDig=f.deps.digBlock,deadlines=[];let interrupted=false,rejoined=0,crafts=0,afterResumeDigs=0;
 const witness={label:'same-original-successful-defense'};
 const profile=new (require('mineflayer-pathfinder').Movements)(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allow1by1towers:false,allowSprinting:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});f.bot.pathfinder.setMovements(profile);
 f.bot.lookAt=async point=>{const delta=point.minus(f.bot.entity.position.offset(0,1.62,0));await f.bot.look(Math.atan2(-delta.x,-delta.z),Math.atan2(delta.y,Math.hypot(delta.x,delta.z)));};
 f.deps.digBlock=async b=>{if(rejoined){assert.ok(f.bot.entity.position.y<64,'Supply completion cannot turn camp into an ore scan origin');afterResumeDigs++;}await nativeDig(b);if(f.digs.length===4)f.bot.inventory.items()[0].durabilityUsed=249;};
 f.deps.ensurePickaxe=async(_b,options)=>{
  if(options.preparationOnly||f.stock.stone_pickaxe)return;
  assert.equal(f.bot.entity.position.floored().equals(new Vec3(0,64,0)),true);
  await f.bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalBlock)(0,64,8));
  f.stock.stone_pickaxe=1;f.stock.cobblestone-=3;crafts++;interrupted=true;if(mode==='cancel')f.token.pause();
  throw Object.assign(Error('movement_preempted'),{code:'movement_preempted',survivalInterrupt:witness});
 };
 f.deps.resumeAfterSurvival=async(error,{deadline})=>{assert.equal(error.survivalInterrupt,witness);deadlines.push(deadline);f.token.throwIfRequested();if(mode==='failed_defense')throw Object.assign(Error('defense failed'),{code:'house_surface_defense_failed'});return true;};
 f.deps.returnEntryAfterSurvival=async()=>{assert.ok(interrupted);await f.bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalBlock)(0,64,0));assert.equal(f.bot.entity.onGround,true);rejoined++;};
 const running=f.quarry.gather('cobblestone',24,{anchor:f.anchor});
 if(mode!=='resume'){
  await assert.rejects(running,{code:mode==='cancel'?'paused':'house_surface_defense_failed'});
  assert.equal(rejoined,0);assert.equal(crafts,1);assert.equal(afterResumeDigs,0);return;
 }
 const result=await running;
 assert.equal(result.confirmed,true);assert.equal(crafts,1);assert.equal(rejoined,1);assert.ok(afterResumeDigs>0);assert.equal(deadlines.length,1);assert.ok(f.stock.cobblestone>=24);assert.ok(f.ticks()>0);
});

test('formal13 an actual recorded-prefix retreat retires its exposed future and the original quarry continues into a different safe branch',{timeout:20000},async t=>{
 const f=fixture(t,{soilDepth:0,limits:{branchSteps:16}}),nativeDig=f.deps.digBlock,assertWork=f.deps.assertActive;
 let interrupted=false,resumed=0,defending=false,retreat;
 const profile=new (require('mineflayer-pathfinder').Movements)(f.bot);Object.assign(profile,{canDig:false,scafoldingBlocks:[],allowParkour:false,allow1by1towers:false,allowSprinting:false,allowFreeMotion:false,maxDropDown:2,infiniteLiquidDropdownDistance:false});f.bot.pathfinder.setMovements(profile);
 const witness={miningRetreatThreat:{id:99,position:{x:10,y:61,z:0}}};
 // MODELED survival lease: ordinary work must be suspended during the native
 // retreat. Otherwise its still-active dig guard races the foreign pose and
 // invents MINING_NO_SUPPORT, unlike the real runtime's lease preemption.
 f.deps.assertActive=()=>{assertWork();if(defending)throw Object.assign(Error('movement_preempted'),{code:'movement_preempted',survivalInterrupt:witness});};
 f.deps.digBlock=async block=>{
  await nativeDig(block);
  const nav=f.checkpoint()?.routes.cobblestone?.navigation;
  if(!interrupted&&nav?.routeIndex>=2){
   interrupted=true;defending=true;
   retreat=require('../vendor/server/minecraft/houseMiningRangedRetreat').withRecordedMiningRangedRetreat({getBot:()=>f.bot,assertActive:()=>f.token.throwIfRequested(),setActive(){},positions:nav.breadcrumbs.slice(0,nav.routeIndex+1),deadline:Date.now()+8000},async()=>{
    await f.bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals.GoalBlock)(0,64,0));
    const until=Date.now()+1200;
    while(!f.bot.entity.onGround||Math.abs(f.bot.entity.position.y-64)>.075){
     f.token.throwIfRequested();assert.ok(Date.now()<until,'The acknowledged retreat must actually settle under native physics');await sleep(10);
    }
    assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));
   });
   await retreat;
   throw Object.assign(Error('movement_preempted'),{code:'movement_preempted',survivalInterrupt:witness});
  }
 };
 // Acknowledgment waits for the real retreat/landing before marking it. This
 // component seam supplies no live combat or independent ownership evidence.
 f.deps.resumeAfterSurvival=async error=>{assert.equal(error.survivalInterrupt,witness);await retreat;defending=false;error.observedMiningRetreat=true;resumed++;return true;};
 const result=await f.quarry.gather('cobblestone',24,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.equal(resumed,1);assert.equal(interrupted,true);assert.ok(f.stock.cobblestone>=24);
 assert.ok(f.checkpoint().routes.cobblestone.abandonedNavigations.some(n=>n.reason==='actual_confirmed_ranged_retreat'));
 assert.ok(f.digs.some(d=>d.feet.x<0||Math.abs(d.feet.z)>.5),'The same quarry must really progress along another branch');
});

for(const progress of [true,false])test(`formal18 repeated owned defense resumes only when actual quarry work replenishes the consecutive retry guard: progress=${progress}`,{timeout:20000},async t=>{
 const f=fixture(t,{soilDepth:0,limits:{branchSteps:16}}),dig=f.deps.digBlock;let interruptions=0,resumes=0;
 f.deps.digBlock=async block=>{
  if(progress){await dig(block);await f.deps.collectDrops();}
  if(interruptions<6){interruptions++;throw Object.assign(Error('movement_preempted'),{code:'movement_preempted'});}
  if(!progress)await dig(block);
 };
 f.deps.resumeAfterSurvival=async()=>{f.token.throwIfRequested();resumes++;return true;};
 const running=f.quarry.gather('cobblestone',24,{anchor:f.anchor});
 if(!progress){await assert.rejects(running,{code:'movement_preempted'});assert.equal(resumes,4);assert.equal(f.digs.length,0);}
 else{assert.equal((await running).confirmed,true);assert.equal(interruptions,6);assert.equal(resumes,6);assert.ok(f.stock.cobblestone>=24);assert.ok(f.ticks()>0);}
});

test('formal20 a rich optional copper vein cannot consume the requested material search budget',{timeout:20000},async t=>{
 const f=fixture(t,{soilDepth:0,limits:{branchSteps:16}});f.deps.hasFurnace=()=>true;
 for(let z=-2;z<=14;z++)for(let y=63;y<=65;y++)f.cells.set(`-1,${y},${z}`,'copper_ore');
 const r=await f.quarry.gather('cobblestone',24,{anchor:f.anchor});
 assert.equal(r.confirmed,true);assert.ok(f.stock.cobblestone>=24);
 const copper=f.digs.filter(d=>d.name==='copper_ore');assert.ok(copper.length>0);assert.ok(copper.length<=8,`optional native digs=${copper.length}`);
 assert.ok([...f.cells.values()].some(name=>name==='copper_ore'),'Untasked optional ore remains after the main goal completes');
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(0,64,0));assert.ok(f.ticks()>0);
});

test('formal30 quarry progress accounting cannot demand the suspended work lease before draining its exact defense',{timeout:12000},async t=>{
 const f=fixture(t,{soilDepth:0,limits:{branchSteps:16}}),active=f.deps.assertActive,dig=f.deps.digBlock;
 let defending=false,interrupted=false,resumes=0;
 f.deps.assertActive=()=>{active();if(defending)throw Object.assign(Error('suspended task lease'),{code:'movement_preempted'});};
 f.deps.digBlock=async block=>{
  if(!interrupted){interrupted=true;defending=true;throw Object.assign(Error('movement_preempted'),{code:'movement_preempted'});}
  await dig(block);
 };
 f.deps.resumeAfterSurvival=async()=>{assert.equal(defending,true);resumes++;await sleep(40);defending=false;return true;};
 const result=await f.quarry.gather('cobblestone',8,{anchor:f.anchor});
 assert.equal(result.confirmed,true);assert.equal(resumes,1);assert.ok(f.stock.cobblestone>=8);assert.ok(f.ticks()>0);
});
