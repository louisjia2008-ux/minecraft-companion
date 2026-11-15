'use strict';
// Acknowledged movement/voxel fixtures establish admission, not real physics.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createPortalTrip } = require('../core/netherTrip');
const actions = require('../core/actions');
const end = require('../core/end');
function fixture() {
  const cells = new Map();
  const put = (x, y, z, name) => cells.set(`${x},${y},${z}`, name);
  for (let x = 0; x < 5; x++) put(x, 69, 0, 'cobblestone');
  for (let x = 5; x <= 9; x++) for (let z = 0; z <= 2; z++) put(x, 69, z, 'basalt');
  put(0, 70, -1, 'nether_portal');
  const moves = [];
  const profile = { maxDropDown: 4, canDig: true, allowParkour: true, allow1by1towers: true,
    blocksCantBreak: new Set(), exclusionAreasStep: [], scafoldingBlocks: [9], allowSprinting: true, getNeighbors: () => [] };
  const bot = { game: { dimension: 'the_nether' }, entity: { position: new Vec3(0.5, 70, 0.5), onGround: true },
    registry: { blocksByName: {}, itemsByName: {} }, pathfinder: { movements: profile },
    inventory: { items: () => [{ name: 'cobblestone', count: 500 }] },
    blockAt(p) { const q = p.floored(); const name = cells.get(`${q.x},${q.y},${q.z}`) || 'air';
      return { name, position: q, boundingBox: ['air', 'lava', 'nether_portal', 'fire'].includes(name) ? 'empty' : 'block' }; } };
  const memory = { netherPortal: new Vec3(0, 70, -1), ledgeStandingY: 70,
    ledgeRoute: Array.from({ length: 6 }, (_, x) => new Vec3(x, 70, 0)), ledgeLanding: new Vec3(5, 70, 0) };
  const commands = {
    goNear: async () => { throw new Error('unbounded native anchor approach is forbidden'); },
    goTo: async (_bot, _ctx, goal, options) => { moves.push({ x: goal.x, y: goal.y, z: goal.z });
      assert.equal(profile.canDig, false); assert.equal(profile.allowParkour, false); assert.deepEqual(profile.scafoldingBlocks, []);
      assert.equal(options.retryNoProgress, false);
      bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return { ok: true }; },
    haltBody: () => { bot.halted = true; },
  };
  return { bot, memory, put, cells, profile, moves, commands,
    trip: createPortalTrip({ bot, memory, actions: commands, walkOnly: true }), ctx: { record() {} } };
}
test('re-entry follows the existing freshly valid bridge to its natural landing', async (t) => {
  const f = fixture(); const traversed = [];
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, target) => { traversed.push(target.x);
    f.bot.entity.position = target.floored().offset(0.5, 0, 0.5); return { ok: true }; });
  const result = await f.trip.leaveLedge(f.ctx, f.trip.ledge());
  assert.equal(result.landed, true); assert.deepEqual(traversed, [1.5, 2.5, 3.5, 4.5, 5.5]); assert.equal(f.memory.ledgeTransit, false);
});
for (const changed of ['lava', null]) test(`outbound cached bridge refuses ${changed === null ? 'unknown' : 'changed'} support`, async (t) => {
  const f = fixture(); let moved = 0;
  if (changed === null) { const blockAt = f.bot.blockAt; f.bot.blockAt = (p) => p.floored().equals(new Vec3(3, 69, 0)) ? null : blockAt(p); }
  else f.put(3, 69, 0, changed);
  t.mock.method(end, 'bridgeStep', async () => { moved++; return { ok: true }; });
  const result = await f.trip.leaveLedge(f.ctx, [new Vec3(0, 70, 0)]);
  assert.equal(result.ok, false); assert.match(result.reason, /bridge_route_(unsafe|unknown)/); assert.equal(moved, 0);
});
test('quartz walk profile disables native mining, placing, towers and parkour and restores its owner', () => {
  const f = fixture(); const original = { ...f.profile };
  f.trip.enterNetherMode(); f.trip.enterNetherMode();
  assert.equal(f.profile.canDig, false); assert.equal(f.profile.allowParkour, false);
  assert.equal(f.profile.allow1by1towers, false); assert.deepEqual(f.profile.scafoldingBlocks, []);
  assert.equal(f.profile.maxDropDown, 2); // Native support depth, not physical fall distance.
  assert.equal(f.profile.companionPhysicalDropLimit, 1);
  assert.equal(f.profile.getNeighbors, f.profile.companionPhysicalDropGuard);
  assert.equal(f.profile.infiniteLiquidDropdownDistance, false);
  f.trip.leaveNetherMode();
  for (const k of ['canDig', 'allowParkour', 'allow1by1towers', 'maxDropDown', 'scafoldingBlocks', 'getNeighbors']) assert.deepEqual(f.profile[k], original[k]);
  assert.equal(Object.hasOwn(f.profile, 'companionPhysicalDropGuard'), false);
  assert.equal(Object.hasOwn(f.profile, 'companionPhysicalDropLimit'), false);
  assert.equal(Object.hasOwn(f.profile, 'infiniteLiquidDropdownDistance'), false);
});
test('return regains the landing over individually confirmed loaded dry neighbour cells', async (t) => {
  const f = fixture(); f.bot.entity.position = new Vec3(8.5, 70, 0.5);
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, target) => { f.bot.entity.position = target.floored().offset(0.5, 0, 0.5); return { ok: true }; });
  assert.equal((await f.trip.toOverworld(f.ctx)).retraced, true);
  assert.deepEqual(f.moves, [{ x: 7, y: 70, z: 0 }, { x: 6, y: 70, z: 0 }, { x: 5, y: 70, z: 0 }]); assert.equal(f.profile.canDig, true);
});
test('a lower isolated return cannot authorize native travel to a bridge seventeen blocks up', async () => {
  const f = fixture(); f.bot.entity.position = new Vec3(8.5, 53, 0.5); f.put(8, 52, 0, 'basalt');
  const result = await f.trip.toOverworld(f.ctx);
  assert.equal(result.ok, false); assert.match(result.reason, /shore_(no_path|route_unknown|route_unsafe)/); assert.equal(f.moves.length, 0);
});
test('shore geometry changed between neighbour acknowledgements stops before the changed leg', async (t) => {
  const f = fixture(); f.bot.entity.position = new Vec3(8.5, 70, 0.5);
  const move = f.commands.goTo; f.commands.goTo = async (...args) => { const r = await move(...args); f.put(6, 69, 0, 'lava'); return r; };
  t.mock.method(end, 'bridgeStep', async () => { throw new Error('must not start bridge'); });
  assert.equal((await f.trip.toOverworld(f.ctx)).reason, 'shore_route_unsafe'); assert.equal(f.moves.length, 1);
});
test('withClimbing cannot enable scaffold/towers inside the quartz walk-only scope', async () => {
  const f = fixture(); f.bot.entity.position = new Vec3(8.5, 50, 0.5);
  f.bot.blockAt = (p) => ({ name: 'stone', position: p.floored(), boundingBox: 'block' });
  f.profile.companionWalkOnly = true; f.profile.allow1by1towers = false; f.profile.scafoldingBlocks = [];
  f.bot.pathfinder.goto = async () => { assert.equal(f.profile.allow1by1towers, false); assert.deepEqual(f.profile.scafoldingBlocks, []); };
  const result = await actions.goTo(f.bot, f.ctx, { isEnd: () => false }, { targetY: 70, arrived: () => true });
  assert.equal(result.ok, true, 'goTo catches native errors, so the acknowledged result must also succeed');
});

test('a new goal on the same bot reuses only the freshly valid cached route', async (t) => {
  const f = fixture();
  f.bot.companionNetherBridgeRoutes = new Map([['the_nether:0,70,-1', {
    route: f.memory.ledgeRoute, standingY: 70, landing: f.memory.ledgeLanding, supports: ['1,69,0'],
  }]]);
  const memory = { netherPortal: new Vec3(0, 70, -1) };
  const trip = createPortalTrip({ bot: f.bot, memory, actions: f.commands, walkOnly: true });
  trip.netherPortal();
  const traversed = [];
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, target) => { traversed.push(target.x); f.bot.entity.position = target.floored().offset(0.5, 0, 0.5); return { ok: true }; });
  assert.equal((await trip.leaveLedge(f.ctx, trip.ledge())).landed, true);
  assert.deepEqual(traversed, [1.5, 2.5, 3.5, 4.5, 5.5]);
  assert.notEqual(memory.ledgeRoute, f.memory.ledgeRoute);
});
test('outbound geometry is fresh again after each acknowledged neighbour', async (t) => {
  const f = fixture(); let moves = 0;
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, target) => { moves++; f.bot.entity.position = target.floored().offset(0.5, 0, 0.5); f.put(3, 69, 0, 'lava'); return { ok: true }; });
  assert.equal((await f.trip.leaveLedge(f.ctx, f.trip.ledge())).reason, 'bridge_route_unsafe'); assert.equal(moves, 1);
});
test('outbound cancellation clears body ownership before any later route leg', async (t) => {
  const f = fixture(); const controller = new AbortController();
  t.mock.method(end, 'bridgeStep', async () => { controller.abort('MODELED_cancel'); throw Object.assign(new Error('aborted'), { code: 'aborted' }); });
  await assert.rejects(f.trip.leaveLedge({ ...f.ctx, signal: controller.signal }, f.trip.ledge()), { code: 'aborted' });
  assert.equal(f.bot.halted, true);
});
test('shore cancellation removes corridor restrictions and restores the native profile', async () => {
  const f = fixture(); const controller = new AbortController(); f.bot.entity.position = new Vec3(8.5, 70, 0.5);
  f.commands.goTo = async () => { controller.abort('MODELED_cancel'); throw Object.assign(new Error('aborted'), { code: 'aborted' }); };
  await assert.rejects(f.trip.toOverworld({ ...f.ctx, signal: controller.signal }), { code: 'aborted' });
  assert.equal(f.bot.halted, true); assert.equal(f.profile.canDig, true); assert.equal(f.profile.allowParkour, true);
  assert.equal(f.profile.maxDropDown, 4); assert.deepEqual(f.profile.exclusionAreasStep, []); assert.equal(f.profile.companionWalkOnly, undefined);
});
test('an ordinary Nether trip retains its native excavation and scaffold policy', () => {
  const f = fixture(); const trip = createPortalTrip({ bot: f.bot, memory: {}, actions: f.commands });
  trip.enterNetherMode(); assert.equal(f.profile.maxDropDown, 3); assert.equal(f.profile.canDig, true);
  assert.equal(f.profile.allowParkour, true); assert.equal(f.profile.allow1by1towers, true);
  trip.leaveNetherMode(); assert.equal(f.profile.maxDropDown, 4);
});
test('a quartz trip crossing dimensions restores overworld parkour and excavation too', async (t) => {
  const f = fixture(); const nether = require('../core/nether'); f.trip.enterNetherMode();
  t.mock.method(nether, 'travel', async () => { f.bot.game.dimension = 'overworld'; return { ok: true }; });
  t.mock.method(nether, 'findPortal', () => null); t.mock.method(nether, 'leavePortal', async () => ({ ok: true }));
  assert.equal((await f.trip.toOverworld(f.ctx)).ok, true);
  assert.equal(f.profile.canDig, true); assert.equal(f.profile.allowParkour, true); assert.equal(f.profile.maxDropDown, 4);
  assert.deepEqual(f.profile.scafoldingBlocks, [9]);
});

test('respawn restores overworld movement before a parent starts its supply plan, and dispose removes the hook', () => {
  const f = fixture(); const { EventEmitter } = require('node:events');
  const emitter = new EventEmitter(); f.bot.on = emitter.on.bind(emitter); f.bot.removeListener = emitter.removeListener.bind(emitter);
  const trip = createPortalTrip({ bot: f.bot, memory: {}, walkOnly: true });
  assert.equal(emitter.listenerCount('game'), 1);
  trip.enterNetherMode(); assert.equal(f.profile.canDig, false);
  f.bot.game.dimension = 'overworld'; emitter.emit('game');
  assert.equal(f.profile.canDig, true); assert.equal(f.profile.maxDropDown, 4); assert.equal(f.profile.companionWalkOnly, undefined);
  trip.dispose(); assert.equal(emitter.listenerCount('game'), 0);
});

test('protected quartz stock accounts for real stone and the wider guarded bridge cost', async () => {
  const f = fixture(); const { createNetherQuartzGoal } = require('../core/goals/netherQuartz');
  f.bot.game.dimension = 'overworld'; f.bot.health = 20; f.bot.food = 20; f.bot.inventory.slots = [];
  f.bot.registry.foodsByName = { cooked_beef: {} };
  f.bot.inventory.items = () => [{ name: 'stone_pickaxe', count: 1 }, { name: 'cooked_beef', count: 4 },
    { name: 'cobblestone', count: 449 }, { name: 'dirt', count: 1000 }];
  const events = []; let gathers = 0;
  const goal = createNetherQuartzGoal({ bot: f.bot, skills: { gatherOne: async () => { gathers++; return { ok: true }; } } });
  goal.memory.ledgeSeen = true;
  const result = await goal.run({ record: (type, data) => events.push({ type, ...data }), perceive: () => ({ inventory: {} }) });
  assert.equal(result.ok, true); assert.equal(gathers, 1);
  assert.deepEqual(events.find((e) => e.type === 'stock_bridge'), { type: 'stock_bridge', have: 449, want: 450 });
  goal.dispose();
});
