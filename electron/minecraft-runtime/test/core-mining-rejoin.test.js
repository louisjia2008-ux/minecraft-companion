'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { walkTunnel } = require('../core/mining');
const realActions = require('../core/actions');
const { configureMovements } = require('../core/companion');
const { installEdgeNudge } = require('../core/edgeNudge');
const { uninstallOpenDoorPassage } = require('../core/openDoorPassage');
const { nativeBody } = require('./core-open-door-fixture');
const saved = require('./fixtures/core-mine-rejoin-saved.json');

function fixture(x = 23) {
  const states = new Map(saved.blocks.map(b => [`${b.position.x},${b.position.y},${b.position.z}`, b]));
  const unknown = new Set();
  const at = point => {
    const p = point.floored(), key = `${p.x},${p.y},${p.z}`, value = states.get(key);
    if (!value) { unknown.add(key); return null; }
    const block = Block.fromProperties(registry.blocksByName[value.name].id, value.properties || {}, 0);
    block.position = p; return block;
  };
  const bot = Object.assign(new EventEmitter(), { registry, blockAt: at, entities: {},
    entity: { effects: {}, position: new Vec3(x + .5, 15, 40.5), onGround: true },
    inventory: { items: () => [{ name: 'stone_pickaxe', type: registry.itemsByName.stone_pickaxe.id, count: 1, nbt: null }] },
    game: { minY: -64 }, clearControlStates() {} });
  require('mineflayer-pathfinder').pathfinder(bot);
  const profile = configureMovements(bot), { PlayerState } = nativeBody({ bot }), removeNudge = installEdgeNudge(bot);
  bot.lookAt = async point => {
    const d = point.minus(bot.entity.position.offset(0, 1.62, 0));
    await bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)));
  };
  const mutations = [];
  bot.dig = async b => { mutations.push(['dig', b.position]); throw new Error('fixture refuses digging'); };
  bot.placeBlock = async () => { mutations.push(['place']); throw new Error('fixture refuses placement'); };
  bot.activateBlock = async () => { mutations.push(['activate']); throw new Error('fixture refuses activation'); };
  bot.equip = async () => {};
  const target = { x: 22, y: 16, z: 38 };
  const mine = { entrance: target, front: target, surfaceY: 64, cells: { '22,16,38': null }, walkFailures: 2 };
  return { bot, profile, mine, target, unknown, mutations, states,
    tick() { bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), { getBlock: at }).apply(bot); bot.emit('physicsTick'); },
    dispose() { bot.pathfinder.setGoal(null); removeNudge(); uninstallOpenDoorPassage(bot, profile); } };
}

for (const [x, roof, fraction = .5] of [[23, []], [24, []], [23, [], .305494146271545], [24, [], .269768477186815],
  [23, ['23,18,40']], [23, ['23,18,39']], [23, ['23,18,40', '23,18,39']]]) {
  test(`off-route ore cavity rejoins with native physics from x=${x + fraction}, ceiling=${roof.join(';') || 'original'}`, async t => {
    const f = fixture(x); t.after(() => f.dispose());
    f.bot.entity.position.x = x + fraction;
    for (const key of roof) f.states.set(key, { name: 'stone' });
    const controller = new AbortController(), events = [], calls = [], paths = [];
    f.bot.on('path_update', r => paths.push(r));
    const ctx = { signal: controller.signal, record: (type, data) => events.push({ type, ...data }) };
    let first = true;
    // The original native no_progress was independently observed in the same
    // saved shape fixture. Only trigger that recovery boundary here; every
    // candidate leg uses the original native goto and actual physics.
    const actions = { ...realActions, goTo: async (bot, scope, goal, options) => {
      calls.push({ goal, options });
      if (first) { first = false; return { ok: false, reason: 'no_progress' }; }
      return realActions.goTo(bot, scope, goal, options);
    } };
    let settled = false, result, failure;
    const going = walkTunnel(f.bot, ctx, f.mine, 'out', actions).then(r => { settled = true; result = r; }, e => { settled = true; failure = e; });
    for (let tick = 0; tick < 200 && !settled; tick++) {
      f.tick();
      // This off-centre start exercises the production recentre's timed body
      // action, so its physics ticks also run at the real50ms cadence.
      if (fraction === .269768477186815) await new Promise(resolve => setTimeout(resolve, 50));
      else await new Promise(setImmediate);
    }
    if (!settled) controller.abort('fixture simulation exhausted');
    await going;
    if (failure) throw failure;
    assert.equal(result.ok, true);
    assert.equal(f.bot.entity.position.floored().equals(new Vec3(22, 16, 38)), true);
    assert.equal(f.mine.walkFailures, 0);
    assert.equal(calls[0].options.retryNoProgress, false);
    assert.ok(calls.length >= 4 && calls.length <= 5);
    assert.ok(paths.length >= 3 && paths.every(p => p.status === 'success'));
    assert.ok(paths.every(p => p.path.every(n => !n.toBreak.length && !n.toPlace.length)));
    assert.deepEqual(f.mutations, []);
    assert.equal(f.profile.canDig, true);
    assert.equal(f.profile.canOpenDoors, true);
    assert.equal(f.profile.allow1by1towers, false);
    assert.ok(events.some(e => e.type === 'mine_rejoin'));
  });
}

function simpleStep() {
  const cells = new Map();
  const put = (x, y, z, name) => cells.set(`${x},${y},${z}`, name);
  put(0, -1, 0, 'stone'); for (let y = 0; y <= 3; y++) put(0, y, 0, 'air');
  put(0, 0, -1, 'stone'); for (let y = 1; y <= 3; y++) put(0, y, -1, 'air');
  const bot = { blockAt(p) {
    const name = cells.get(`${p.x},${p.y},${p.z}`); if (!name) return null;
    const b = Block.fromProperties(registry.blocksByName[name].id, {}, 0); b.position = p; return b;
  } };
  return { bot, cells, put, from: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 1, z: -1 } };
}

test('cardinal selector accepts a loaded supported one-step ascent', () => {
  const f = simpleStep();
  assert.deepEqual(require('../core/mining').cardinalRejoin(f.bot, f.from, f.target), [f.target]);
});

for (const hazard of ['magma_block', 'cactus', 'campfire', 'water', 'lava', 'gravel', 'white_concrete_powder']) {
  test(`cardinal selector rejects ${hazard} support with real registry shapes`, () => {
    const f = simpleStep(); f.put(0, 0, -1, hazard);
    assert.equal(require('../core/mining').cardinalRejoin(f.bot, f.from, f.target), null);
  });
}

for (const hazard of ['magma_block', 'water', 'gravel', 'white_concrete_powder']) {
  test(`cardinal selector refuses hazardous ${hazard} at the apex`, () => {
    const f = simpleStep(); f.put(0, 3, 0, hazard);
    assert.equal(require('../core/mining').cardinalRejoin(f.bot, f.from, f.target), null);
  });
}

for (const [name, point] of [['UNKNOWN support', [0, 0, -1]], ['UNKNOWN head', [0, 2, -1]],
  ['UNKNOWN apex ceiling', [0, 3, 0]], ['takeoff head obstruction', [0, 2, 0]], ['landing head obstruction', [0, 2, -1]]]) {
  test(`cardinal selector refuses ${name}`, () => {
    const f = simpleStep();
    if (name.startsWith('UNKNOWN')) f.cells.delete(point.join(',')); else f.put(...point, 'stone');
    assert.equal(require('../core/mining').cardinalRejoin(f.bot, f.from, f.target), null);
  });
}

test('cardinal selector refuses a fence shape in the body and distant or multi-height joins', () => {
  const f = simpleStep(); f.put(0, 1, -1, 'oak_fence');
  const select = require('../core/mining').cardinalRejoin;
  assert.equal(select(f.bot, f.from, f.target), null);
  assert.equal(select(f.bot, f.from, { x: 0, y: 2, z: -1 }), null);
  assert.equal(select(f.bot, f.from, { x: 5, y: 1, z: 0 }), null);
});

function scope() { return { signal: new AbortController().signal, record() {} }; }

test('healthy direct joins and in-route legs retain their existing goals without fallback', async t => {
  const f = fixture(); t.after(() => f.dispose()); let calls = 0;
  const actions = { goTo: async (_bot, _ctx, goal) => { calls++; assert.deepEqual([goal.x, goal.y, goal.z], [22, 16, 38]); return { ok: true }; } };
  assert.deepEqual(await walkTunnel(f.bot, scope(), f.mine, 'out', actions), { ok: true });
  assert.equal(calls, 1);
  f.bot.entity.position = new Vec3(22.5, 16, 38.5);
  assert.equal(await walkTunnel(f.bot, scope(), f.mine, 'out', actions), null);
  assert.equal(calls, 1);
});

test('off-route NoPath does not opt into the ascent fallback', async t => {
  const f = fixture(); t.after(() => f.dispose()); let calls = 0;
  const result = await walkTunnel(f.bot, scope(), f.mine, 'out', { goTo: async () => { calls++; return { ok: false, reason: 'NoPath' }; } });
  assert.equal(result.reason, 'NoPath'); assert.equal(calls, 1);
});

test('join and all cardinal legs consume one original 20-second deadline', async t => {
  const f = fixture(); t.after(() => f.dispose()); let now = 1000; t.mock.method(Date, 'now', () => now);
  const budgets = []; let first = true;
  const result = await walkTunnel(f.bot, scope(), f.mine, 'out', { goTo: async (_bot, _ctx, goal, options) => {
    budgets.push(options.timeoutMs);
    if (first) { first = false; now += 19000; return { ok: false, reason: 'no_progress' }; }
    assert.equal(f.profile.canDig, false); assert.equal(f.profile.canOpenDoors, false);
    assert.equal(f.profile.allow1by1towers, false); assert.deepEqual(f.profile.scafoldingBlocks, []);
    now += 600; f.bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5); return { ok: true };
  } });
  assert.deepEqual(budgets, [20000, 1000, 400]);
  assert.equal(result.reason, 'path_timeout'); assert.equal(f.profile.canDig, true);
});

test('expired first attempt cannot start a cardinal leg or credit a late success', async t => {
  const f = fixture(); t.after(() => f.dispose()); let now = 1000; t.mock.method(Date, 'now', () => now); let calls = 0;
  const result = await walkTunnel(f.bot, scope(), f.mine, 'out', { goTo: async () => { calls++; now += 20001; return { ok: true }; } });
  assert.equal(result.reason, 'path_timeout'); assert.equal(calls, 1); assert.equal(f.mine.walkFailures, 2);
});

test('root cancellation before the join starts has no native side effect', async t => {
  const f = fixture(); t.after(() => f.dispose()); const controller = new AbortController(); controller.abort('parent stopped'); let calls = 0;
  await assert.rejects(walkTunnel(f.bot, { signal: controller.signal }, f.mine, 'out', { goTo: async () => { calls++; } }), { code: 'aborted' });
  assert.equal(calls, 0);
});

for (const acknowledge of ['resolve', 'reject']) test(`parent abort outranks local expiry after late native ${acknowledge}`, async t => {
  const f = fixture(); t.after(() => f.dispose()); const controller = new AbortController();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let release, reject, halts = 0;
  const going = walkTunnel(f.bot, { signal: controller.signal, record() {} }, f.mine, 'out', {
    haltBody() { halts++; }, goTo: async () => new Promise((yes, no) => { release = yes; reject = no; }),
  });
  controller.abort('parent stopped'); t.mock.timers.tick(20001);
  if (acknowledge === 'resolve') release({ ok: true }); else reject(new Error('native acknowledged late'));
  await assert.rejects(going, { code: 'aborted', message: 'parent stopped' }); assert.equal(halts, 1);
});

test('local expiry halts the body and refuses late native success', async t => {
  const f = fixture(); t.after(() => f.dispose()); t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  let release, halts = 0;
  const going = walkTunnel(f.bot, scope(), f.mine, 'out', { haltBody() { halts++; }, goTo: async () => new Promise(yes => { release = yes; }) });
  t.mock.timers.tick(20001); release({ ok: true });
  assert.equal((await going).reason, 'path_timeout'); assert.equal(halts, 1);
});

test('aborting a cardinal leg restores the owned movement profile', async t => {
  const f = fixture(); t.after(() => f.dispose()); const controller = new AbortController(); let first = true;
  const originalScaffold = f.profile.scafoldingBlocks;
  await assert.rejects(walkTunnel(f.bot, { signal: controller.signal, record() {} }, f.mine, 'out', { goTo: async () => {
    if (first) { first = false; return { ok: false, reason: 'no_progress' }; }
    assert.equal(f.profile.canDig, false); controller.abort('cancel leg'); throw new Error('native cancellation');
  } }), { code: 'aborted', message: 'cancel leg' });
  assert.equal(f.profile.canDig, true); assert.equal(f.profile.canOpenDoors, true);
  assert.equal(f.profile.scafoldingBlocks, originalScaffold);
});

test('a foreign movement replacement stops further legs without being overwritten', async t => {
  const f = fixture(); t.after(() => f.dispose()); let first = true, legs = 0;
  const foreign = new (require('mineflayer-pathfinder').Movements)(f.bot);
  foreign.canDig = 'foreign'; foreign.canOpenDoors = 'foreign';
  const result = await walkTunnel(f.bot, scope(), f.mine, 'out', { goTo: async (_bot, _ctx, goal) => {
    if (first) { first = false; return { ok: false, reason: 'no_progress' }; }
    legs++; f.bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
    f.bot.pathfinder.setMovements(foreign); return { ok: true };
  } });
  assert.equal(result.reason, 'no_progress'); assert.equal(legs, 1);
  assert.equal(f.bot.pathfinder.movements, foreign); assert.equal(foreign.canDig, 'foreign'); assert.equal(foreign.canOpenDoors, 'foreign');
  assert.equal(f.profile.canDig, true); assert.equal(f.profile.canOpenDoors, true);
});

test('geometry changed between legs fails closed before another native action', async t => {
  const f = fixture(); t.after(() => f.dispose()); let first = true, legs = 0;
  const result = await walkTunnel(f.bot, scope(), f.mine, 'out', { goTo: async (_bot, _ctx, goal) => {
    if (first) { first = false; return { ok: false, reason: 'no_progress' }; }
    legs++; f.bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
    f.states.set('22,17,39', { name: 'stone' }); return { ok: true };
  } });
  assert.equal(result.reason, 'no_progress'); assert.equal(legs, 1); assert.equal(f.profile.canDig, true);
});

for (const retry of [false, undefined]) test(`goTo no_progress internal retry option ${String(retry)} preserves its explicit policy`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000 });
  let calls = 0, rejectCurrent;
  const bot = { entity: { position: new Vec3(.5, 1, .5) }, blockAt: () => null, clearControlStates() {},
    pathfinder: { goto: () => { calls++; return new Promise((_yes, no) => { rejectCurrent = no; }); },
      setGoal: () => rejectCurrent?.(new Error('native stopped')) } };
  const going = realActions.goTo(bot, scope(), { isEnd: () => false }, { timeoutMs: 20000, retryNoProgress: retry });
  t.mock.timers.tick(13001); for (let i = 0; i < 10; i++) await Promise.resolve();
  if (retry === undefined) { assert.equal(calls, 2); t.mock.timers.tick(13001); }
  const result = await going; assert.equal(result.reason, 'no_progress'); assert.equal(calls, retry === false ? 1 : 2);
});
