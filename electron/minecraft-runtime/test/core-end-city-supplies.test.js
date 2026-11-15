'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { createBrain } = require('../core/brain');
const filename = require.resolve('../core/goals/endCity');
const localRequire = createRequire(filename);
function fixture({ stock = 8, island = false, noDelivery = false, bridgeAckNoMove = false } = {}) {
  let blocks = stock, pending = 0;
  const counts = { walks: 0, digs: 0, bridges: 0, records: [] };
  const supply = new Vec3(1042, 58, 183);
  const onIsland = (p) => Math.hypot(p.x - supply.x, p.z - supply.z) < 8;
  const bot = { entity: { position: island ? supply.offset(.5, 0, .5) : new Vec3(946.5, 58, 99.5), onGround: true },
    health: 20, food: 20, game: { dimension: 'the_end' },
    registry: { blocksByName: { end_stone: { id: 1 }, chest: { id: 2 } } },
    inventory: { items: () => blocks ? [{ name: 'end_stone', count: blocks }] : [] },
    blockAt(p) { return { name: p.y < 58 && onIsland(p) ? 'end_stone' : p.y < 58 ? 'cobblestone' : 'air',
      boundingBox: p.y < 58 ? 'block' : 'empty', position: p.floored() }; },
    findBlocks(options) {
      if (options.matching !== 1 || !onIsland(options.point || bot.entity.position)) return [];
      if (options.count === 24) return Array.from({ length: 20 }, (_, i) => supply.offset(i % 5 - 2, -1, Math.floor(i / 5) - 2));
      return [bot.entity.position.floored().offset(2, 0, 0)];
    } };
  const actions = { countItems: (_bot, match) => match('end_stone') ? blocks : 0,
    goNear: async () => { counts.walks += 1; return { ok: false, reason: 'NoPath' }; },
    goTo: async () => ({ ok: false, reason: 'NoPath' }), withinReach: () => true,
    digBlock: async () => { counts.digs += 1; pending += 1; return { ok: true }; },
    collectDrops: async () => { if (!noDelivery) { blocks += pending; pending = 0; } return { ok: !noDelivery }; } };
  const end = { goals, inEnd: () => bot.game.dimension === 'the_end', applyEndMovements: () => () => {}, wearArmor: async () => {},
    deepDrop: () => bridgeAckNoMove, surfaceAt: () => null,
    bridgeToward: async () => { counts.bridges += 1; return bridgeAckNoMove ? { ok: true, steps: 8 } : { ok: false, reason: 'no_bridge_blocks', steps: 0 }; } };
  const city = { findGateway: () => [], elytraFrames: () => [], findCity: () => null, cityChests: () => [], outward: () => new Vec3(1, 0, 0) };
  const module = { exports: {} };
  const customRequire = (name) => name === '../end' ? end : name === '../endCity' ? city : localRequire(name);
  const fn = new vm.Script('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename }).runInThisContext();
  fn(customRequire, module, module.exports);
  const goal = module.exports.createEndCityGoal({ bot, actions });
  goal.memory.lastStone = supply.clone();
  const ctx = { signal: new AbortController().signal, record: (type, data) => counts.records.push({ type, ...data }) };
  return { bot, goal, actions, end, counts, supply, ctx, stock: () => blocks };
}

test('failed supply return preserves its source, makes no progress, and can really restock on retry', async () => {
  const f = fixture();
  const initial = f.goal.progress();
  assert.equal((await f.goal.run(f.ctx)).reason, 'NoPath');
  assert.ok(f.goal.memory.lastStone?.equals(f.supply));
  assert.equal(f.goal.progress(), initial);
  assert.equal(f.goal.memory.explored, 0);
  assert.equal(f.counts.bridges, 0, 'failed return must not spend its reserve on blind exploration');
  f.actions.goNear = async () => { f.counts.walks += 1; f.bot.entity.position = f.supply.offset(.5, 0, .5); return { ok: true }; };
  assert.equal((await f.goal.run(f.ctx)).ok, true);
  assert.equal(f.counts.walks, 2);
  assert.ok(f.stock() > 8);
  assert.ok(f.goal.memory.lastStone);
  assert.equal(f.goal.memory.stoneCollected, f.stock() - 8);
  assert.ok(f.goal.progress() > initial);
});

test('repeated failed supply returns never count search attempts or bridged acknowledgements as progress', async () => {
  const f = fixture();
  const initial = f.goal.progress();
  for (let i = 0; i < 6; i += 1) assert.equal((await f.goal.run(f.ctx)).ok, false);
  assert.equal(f.goal.progress(), initial);
  assert.equal(f.goal.memory.explored, 0);
  assert.equal(f.counts.walks, 6);
  assert.equal(f.counts.bridges, 0);
});

test('an acknowledged return without actual island arrival cannot start mining or erase its source', async () => {
  const f = fixture();
  f.actions.goNear = async () => ({ ok: true });
  assert.equal((await f.goal.run(f.ctx)).reason, 'restock_not_arrived');
  assert.equal(f.counts.digs, 0);
  assert.ok(f.goal.memory.lastStone?.equals(f.supply));
  assert.equal(f.goal.memory.explored, 0);
});

test('dig acknowledgements without collected blocks do not mark a successful stock point or grant progress', async () => {
  const f = fixture({ island: true, stock: 0, noDelivery: true });
  const initial = f.goal.progress();
  await f.goal.run(f.ctx);
  assert.ok(f.counts.digs > 0);
  assert.equal(f.stock(), 0);
  assert.equal(f.goal.memory.stoneTriedAt, undefined);
  assert.equal(f.goal.memory.stoneCollected || 0, 0);
  assert.equal(f.goal.progress(), initial);
});

test('repeated bridge step acknowledgements without body movement do not refill the no-progress budget', async () => {
  const f = fixture({ stock: 64, bridgeAckNoMove: true });
  const initial = f.goal.progress();
  for (let i = 0; i < 6; i += 1) await f.goal.run(f.ctx);
  assert.ok(f.counts.bridges > 0);
  assert.equal(f.goal.memory.explored, 0);
  assert.equal(f.goal.progress(), initial);
});

test('original 24-step/three-recovery budgets terminate an unreachable supply source with real failure reasons', async () => {
  const f = fixture({ stock: 0 });
  const events = [];
  const brain = createBrain({ perceive: () => ({ alive: true, health: 20 }), goalRetryDelayMs: 0, onEvent: (event) => events.push(event) });
  assert.equal(f.goal.noProgressLimit, 24);
  assert.equal(f.goal.maxRecoveries, 3);
  try {
    brain.setGoal(f.goal);
    for (let i = 0; i < 150 && !events.some((event) => event.type === 'goal_failed'); i += 1) {
      await brain.tick();
      await new Promise(setImmediate);
    }
    const failed = events.find((event) => event.type === 'goal_failed');
    assert.ok(failed, 'unreachable supplies must fail within the existing finite recovery contract');
    assert.deepEqual(failed.reasons, Array(24).fill('NoPath'));
    assert.equal(events.filter((event) => event.type === 'goal_recovering').length, 3);
    assert.equal(f.counts.walks, 96);
    assert.equal(f.counts.bridges, 0);
    assert.equal(brain.status().goal, null);
    assert.ok(f.goal.memory.lastStone?.equals(f.supply));
  } finally { await brain.dispose(); }
});

test('actual arrival in a new search area earns progress, returning over the old area does not', async () => {
  const f = fixture({ stock: 512 });
  const origin = f.bot.entity.position.clone();
  f.actions.goTo = async () => { f.bot.entity.position = origin.offset(20, 0, 0); return { ok: true }; };
  assert.equal((await f.goal.run(f.ctx)).ok, true);
  assert.equal(f.goal.memory.explored, 1);
  assert.equal(f.goal.memory.searchAttempts, 1);
  const progress = f.goal.progress();
  f.actions.goTo = async () => { f.bot.entity.position = origin.clone(); return { ok: true }; };
  assert.equal((await f.goal.run(f.ctx)).ok, true);
  assert.equal(f.goal.memory.explored, 1);
  assert.equal(f.goal.memory.searchAttempts, 2);
  assert.equal(f.goal.progress(), progress);
});

test('a confirmed stock point is recorded only after the bag actually receives mined blocks', async () => {
  const f = fixture({ island: true, stock: 0 });
  assert.equal((await f.goal.run(f.ctx)).ok, true);
  assert.ok(f.goal.memory.stoneTriedAt?.equals(f.bot.entity.position.floored()));
  assert.equal(f.goal.memory.stoneCollected, f.stock());
  const stockEvent = f.counts.records.find((event) => event.type === 'stone_gathered');
  assert.equal(stockEvent.confirmed, true);
  assert.equal(stockEvent.gained, f.stock());
});

test('a successful overworld approach is not an End return until dimension actually changes', async () => {
  const f = fixture();
  f.bot.game.dimension = 'overworld';
  f.bot.companionEndPortal = { x: 2000, y: 58, z: 0 };
  f.actions.goTo = async () => { f.bot.entity.position = f.bot.entity.position.offset(64, 0, 0); return { ok: true }; };
  const initial = f.goal.progress();
  assert.equal((await f.goal.run(f.ctx)).ok, true);
  assert.equal(f.goal.memory.returnHops || 0, 0);
  assert.equal(f.goal.memory.explored, 0);
  assert.equal(f.goal.progress(), initial);
  f.actions.goTo = async () => {
    f.bot.entity.position = f.bot.entity.position.offset(64, 0, 0);
    f.bot.game.dimension = 'the_end';
    return { ok: true };
  };
  assert.equal((await f.goal.run(f.ctx)).ok, true);
  assert.equal(f.goal.memory.returnHops, 1);
});

test('main-island gateway approach does not claim an outer End city search area', async () => {
  const f = fixture({ stock: 512 });
  const items = f.bot.inventory.items;
  f.bot.inventory.items = () => [...items(), { name: 'ender_pearl', count: 32 }];
  f.bot.entity.position = new Vec3(0.5, 58, 0.5);
  f.end.exitPortalLit = () => true;
  f.end.stranded = () => false;
  f.end.surfaceAt = () => new Vec3(70, 58, 0);
  f.end.walkTo = async () => { f.bot.entity.position = new Vec3(70.5, 58, .5); return { ok: true }; };
  assert.equal((await f.goal.run(f.ctx)).ok, true);
  assert.equal(f.goal.memory.explored, 0);
  assert.equal(f.counts.records.filter((event) => event.type === 'city_area_reached').length, 0);
});
