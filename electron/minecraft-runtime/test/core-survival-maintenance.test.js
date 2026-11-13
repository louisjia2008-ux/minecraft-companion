'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');
const { createBrain } = require('../core/brain');
const { sleep } = require('../core/confirm');
const { EventEmitter } = require('node:events');
const minecraftData = require('minecraft-data');

function setup(options = {}) {
  const bot = { entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    registry: { foodsByName: { beef: {}, cooked_beef: {}, rotten_flesh: {} } }, inventory: { slots: [] } };
  const state = { alive: true, health: 2.5, food: 16, inventory: {}, hostiles: [], isDay: true,
    sheltered: false, position: bot.entity.position };
  const behaviors = createSurvivalBehaviors({ bot, ...options });
  return { bot, state, behaviors, behavior: (name) => behaviors.find((b) => b.name === name) };
}

test('injured empty-bag provisioning covers the gap below regeneration food, then yields to recovery', () => {
  const s = setup();
  for (const food of [13, 14, 15, 16, 17]) {
    assert.ok(s.behavior('provision').want({ ...s.state, food }) > 0, `food ${food}`);
  }
  assert.equal(s.behavior('provision').want({ ...s.state, food: 18 }), 0);
  assert.ok(s.behavior('recover').want({ ...s.state, food: 18 }) > 0);
  assert.equal(s.behavior('provision').want({ ...s.state, health: 20 }), 0);
});

test('regeneration provisioning keeps the existing night, nearby threat, shelter and dimension limits', () => {
  const s = setup();
  const provision = s.behavior('provision');
  assert.equal(provision.want({ ...s.state, isDay: false }), 0);
  assert.equal(provision.want({ ...s.state, sheltered: true }), 0);
  for (const distance of [4, 10, 16]) {
    assert.equal(provision.want({ ...s.state, hostiles: [{ name: 'zombie', distance }] }), 0);
  }
  s.bot.game.dimension = 'the_nether';
  assert.equal(provision.want(s.state), 0);
});

test('carried food is eaten first, and an unusable risky item does not block safe provisioning', () => {
  const s = setup();
  const carrying = { ...s.state, inventory: { cooked_beef: 1 } };
  assert.equal(s.behavior('provision').want(carrying), 0);
  assert.ok(s.behavior('eat').want(carrying) > 0);
  // At health 9 / food 16, eat will not use rotten flesh. Treating it as a
  // complete food supply would recreate the same gap with a nonempty bag.
  const risky = { ...s.state, health: 9, inventory: { rotten_flesh: 1 } };
  assert.equal(s.behavior('eat').want(risky), 0);
  assert.ok(s.behavior('provision').want(risky) > 0);
});

test('a running device yields to injured provisioning and eating, preserving its goal', async () => {
  let state;
  let hunts = 0;
  let eats = 0;
  const s = setup({ skills: { huntOne: async () => {
    hunts += 1;
    state.inventory.beef = 1;
    return { ok: true };
  } }, actions: { eat: async () => {
    eats += 1;
    delete state.inventory.beef;
    state.food = 18;
    state.health = 10; // stand-in for the following regeneration, tested above
    return { ok: true };
  } } });
  state = s.state;
  let deviceSteps = 0;
  const events = [];
  const brain = createBrain({ perceive: () => state, behaviors: s.behaviors,
    onEvent: (event) => events.push(event) });
  brain.setGoal({ name: 'build_auto_smelter', isDone: () => deviceSteps >= 1,
    progress: () => deviceSteps, async run() { deviceSteps += 1; return { ok: true }; } });
  try {
    await brain.tick();
    for (let i = 0; i < 30 && !events.some((e) => e.type === 'goal_done'); i += 1) await sleep(1);
    assert.equal(hunts, 1);
    assert.equal(eats, 1);
    assert.equal(deviceSteps, 1);
    assert.deepEqual(events.filter((e) => e.type === 'behavior_started').map((e) => e.behavior),
      ['provision', 'eat', 'goal:build_auto_smelter']);
    assert.equal(events.filter((e) => e.type === 'goal_set').length, 1);
  } finally { await brain.dispose(); }
});

function endermanFixture(creepy) {
  const registry = minecraftData('1.21.8');
  const index = registry.entitiesByName.enderman.metadataKeys.indexOf('creepy');
  assert.ok(index >= 0, 'use the installed protocol metadata key, not an assumed index');
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0) }, registry,
    inventory: { slots: [] }, entities: {} });
  const mob = { id: 9, name: 'enderman', position: new Vec3(1, 64, 0), metadata: { [index]: creepy } };
  bot.entities[mob.id] = mob;
  let attacks = 0;
  let goal = null;
  const behaviors = createSurvivalBehaviors({ bot, activeGoal: () => goal,
    actions: { attack: async () => { attacks += 1; return { ok: true }; } } });
  const state = { alive: true, health: 20, food: 20, isDay: true, sheltered: false,
    inventory: { iron_sword: 1 }, position: bot.entity.position, hostiles: [{ ...mob, distance: 1 }] };
  return { bot, mob, state, attacks: () => attacks, setGoal: (name) => { goal = name; }, behavior: (name) => behaviors.find((b) => b.name === name) };
}

test('a calm nearby enderman is never an attack target, including inside shelter and after unrelated damage', async () => {
  const s = endermanFixture(false);
  s.bot.emit('entityHurt', s.bot.entity); // no attack evidence: an arrow/fall is not provocation
  const defend = s.behavior('defend');
  assert.equal(defend.want(s.state), 0);
  assert.equal(defend.want({ ...s.state, sheltered: true }), 0);
  assert.equal(s.behavior('escape').want({ ...s.state, health: 2.5 }), 0);
  assert.equal(s.behavior('hide').want(s.state), 0);
  // Also exercise the executor's fresh predicate rather than only its want.
  await defend.run({ perceive: () => s.state, record() {} });
  assert.equal(s.attacks(), 0);
});

test('an angry enderman retains hiding, low-health escape and close self-defense', () => {
  const s = endermanFixture(true);
  assert.ok(s.behavior('hide').want(s.state) > 0);
  assert.ok(s.behavior('escape').want({ ...s.state, health: 2.5 }) > 0);
  assert.ok(s.behavior('defend').want({ ...s.state, sheltered: true }) > 0);
});

test('a melee swing followed by damage retains enderman self-defense even before angry metadata arrives', () => {
  const s = endermanFixture(false);
  s.bot.emit('entitySwingArm', s.mob);
  assert.equal(s.behavior('defend').want(s.state), 0, 'a swing alone does not identify an attacker');
  s.bot.emit('entityHurt', s.bot.entity);
  assert.ok(s.behavior('hide').want(s.state) > 0);
  assert.ok(s.behavior('escape').want({ ...s.state, health: 2.5 }) > 0);
  assert.ok(s.behavior('defend').want({ ...s.state, sheltered: true }) > 0);
});

test('hurt in water: no healing in place (it sinks), and up for air before the air runs low', () => {
  const s = setup();
  const wet = { ...s.state, food: 18, inWater: true, oxygen: 15 };
  assert.equal(s.behavior('recover').want(wet), 0);
  assert.ok(s.behavior('breathe').want(wet) > 0);
  assert.equal(s.behavior('breathe').want({ ...wet, health: 20 }), 0);
  assert.equal(s.behavior('breathe').want({ ...wet, oxygen: 20 }), 0);
  // A bubble or two lost to a meal does not cut the meal short.
  assert.equal(s.behavior('breathe').want({ ...wet, oxygen: 18 }), 0);
  assert.ok(s.behavior('recover').want({ ...wet, inWater: false }) > 0);
});

test('breathing swims to an open water column before attempting to drain a shore overhang', async () => {
  const controls = [];
  const looks = [];
  let drains = 0;
  let digs = 0;
  const s = setup({ actions: {
    drainPocket: async () => { drains += 1; return true; },
    digBlock: async () => { digs += 1; },
  } });
  Object.assign(s.bot, {
    oxygenLevel: 4,
    blockAt: (p) => {
      const open = p.x === 1 && p.z === 0 && p.y >= 64;
      const name = open ? (p.y < 66 ? 'water' : 'air') : 'stone';
      return { name, boundingBox: open ? 'empty' : 'block' };
    },
    lookAt: async (p) => { looks.push(p); },
    setControlState: (key, value) => {
      controls.push([key, value]);
      if (key === 'forward' && value) { s.bot.oxygenLevel = 20; s.bot.entity.isInWater = false; }
    },
    canDigBlock: () => true,
  });
  s.bot.entity.isInWater = true;
  const result = await s.behavior('breathe').run({ signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.equal(drains, 0, 'the reachable air column takes priority over draining');
  assert.equal(digs, 0, 'the shore overhang is left intact');
  assert.equal(looks[0].x, 1.5);
  assert.ok(controls.some(([key, value]) => key === 'forward' && value));
  assert.deepEqual(controls.slice(-2), [['jump', false], ['forward', false]]);
});

test('breathing with no air column drains first, then gives a slow lid dig its measured time', async () => {
  const calls = [];
  const s = setup({ actions: {
    drainPocket: async () => { calls.push('drain'); return false; },
    digBlock: async (_bot, _ctx, _block, options) => {
      calls.push(options.timeoutMs);
      s.bot.oxygenLevel = 20;
      s.bot.entity.isInWater = false;
    },
  } });
  Object.assign(s.bot, {
    oxygenLevel: 4,
    blockAt: (p) => ({ name: p.y < 66 ? 'water' : 'stone', boundingBox: p.y < 66 ? 'empty' : 'block' }),
    setControlState() {},
    canDigBlock: () => true,
    digTime: () => 20000,
  });
  s.bot.entity.isInWater = true;
  assert.equal((await s.behavior('breathe').run({ signal: new AbortController().signal })).ok, true);
  assert.deepEqual(calls, ['drain', 21500]);
});

test('a goal that brings its own food (the farm) keeps provisioning out of its way', () => {
  let feeding = false;
  const s = setup({ feeding: () => feeding });
  const hungry = { ...s.state, health: 20, food: 4 };
  assert.ok(s.behavior('provision').want(hungry) > 0);
  feeding = true;
  assert.equal(s.behavior('provision').want(hungry), 0);
  s.bot.entities = { 1: { name: 'cow', position: new Vec3(10, 64, 0) } };
  assert.ok(s.behavior('provision').want(hungry) > 0, 'a cow close by is still hunted');
  s.bot.entities = { 1: { name: 'cow', position: new Vec3(80, 64, 0) } };
  assert.equal(s.behavior('provision').want(hungry), 0);
});

test('a search for food keeps within reach of home', async () => {
  const seen = [];
  const s = setup({ home: () => new Vec3(100, 64, -20), skills: {
    huntOne: async () => ({ ok: false, reason: 'no_mob_in_range' }),
    pickBerries: async () => ({ ok: false, reason: 'no_berries' }),
    explore: async (_bot, _ctx, memory) => { seen.push(memory.around); return { ok: true }; } } });
  await s.behavior('provision').run({ record() {}, perceive: () => s.state, signal: new AbortController().signal });
  assert.deepEqual(seen, [{ x: 100, z: -20, radius: 160 }]);
});

test('generic provisioning yields to home resupply while eating remains available', () => {
  const s = setup({ resupplying: () => true });
  assert.equal(s.behavior('provision').want({ ...s.state, food: 0 }), 0);
  assert.ok(s.behavior('eat').want({ ...s.state, food: 0, inventory: { cooked_beef: 1 } }) > 0);
});

test('explore past its radius heads back towards the centre', async () => {
  const skills = require('../core/skills');
  const actions = require('../core/actions');
  const goTo = actions.goTo;
  let target = null;
  const bot = { entity: { position: new Vec3(400, 64, 0) } };
  actions.goTo = async (_b, _c, goal) => { target = goal; bot.entity.position = new Vec3(370, 64, 0); return { ok: true }; };
  try {
    const memory = { heading: Math.PI / 2, around: { x: 0, z: 0, radius: 160 } };
    assert.ok((await skills.explore(bot, { record() {} }, memory)).ok);
    assert.ok(target.x < 400 && Math.abs(target.z) < 1, JSON.stringify(target));
  } finally { actions.goTo = goTo; }
});

test('right after a kill with more animals close by, provision hunts a few more for the bag', async () => {
  const s = setup({ skills: { huntOne: async () => { s.state.inventory.beef = (s.state.inventory.beef || 0) + 1; return { ok: true }; } } });
  const fed = () => ({ ...s.state, health: 20, food: 20 });
  s.bot.entities = { 1: { name: 'cow', position: new Vec3(10, 64, 0) } };
  // Not hungry, nothing hunted yet: no reason to.
  assert.equal(s.behavior('provision').want(fed()), 0);
  s.state.food = 4;
  await s.behavior('provision').run({ record() {}, perceive: () => s.state, signal: new AbortController().signal });
  assert.equal(s.state.inventory.beef, 1);
  assert.ok(s.behavior('provision').want(fed()) > 0, 'one beef, a cow 10 blocks off');
  s.bot.entities = { 1: { name: 'cow', position: new Vec3(60, 64, 0) } };
  assert.equal(s.behavior('provision').want(fed()), 0, 'the next cow is far');
  s.bot.entities = { 1: { name: 'cow', position: new Vec3(10, 64, 0) } };
  s.state.inventory.beef = 6;
  assert.equal(s.behavior('provision').want(fed()), 0, 'the bag is stocked');
});

test('drops are gone back for only when something dropped, and never into the lava that killed', () => {
  const bot = Object.assign(new EventEmitter(), { entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    registry: { foodsByName: {} }, inventory: { slots: [], items: () => items }, blockAt: () => ({ name: feet }) });
  let items = [];
  let feet = 'air';
  const recoverDrops = createSurvivalBehaviors({ bot }).find((b) => b.name === 'recover_drops');
  const state = { alive: true, health: 20, food: 20, inventory: {}, hostiles: [], isDay: true, sheltered: false,
    position: new Vec3(10, 64, 0) };
  // Respawned with an empty bag: the drops lie where it died.
  bot.emit('death');
  bot.emit('spawn');
  assert.ok(recoverDrops.want(state) > 0);
  // keepInventory: back alive with everything, nothing to go back for.
  items = [{ name: 'diamond_pickaxe' }];
  bot.emit('death');
  bot.emit('spawn');
  assert.equal(recoverDrops.want(state), 0);
  // Burnt in lava: nothing left there either.
  items = [];
  feet = 'lava';
  bot.emit('death');
  bot.emit('spawn');
  assert.equal(recoverDrops.want(state), 0);
});

test('a cave death does not draw an unarmed respawn back underground', async () => {
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 12, 0) }, game: { dimension: 'overworld' }, companionSurfaceY: 64,
    registry: { foodsByName: { cooked_beef: {} } }, inventory: { slots: [], items: () => [] },
    blockAt: () => ({ name: 'air' }),
  });
  let moved = 0;
  const recoverDrops = createSurvivalBehaviors({ bot, actions: {
    goNear: async () => { moved += 1; return { ok: true }; },
    collectDrops: async () => ({ ok: true }),
  } }).find((behavior) => behavior.name === 'recover_drops');
  const state = {
    alive: true, health: 20, food: 20, inventory: {}, hostiles: [], sheltered: false, position: new Vec3(3, 64, 0),
  };
  bot.emit('death');
  assert.equal(recoverDrops.want(state), 0, 'wait for the new life before deciding whether to retrieve items');
  bot.emit('spawn');
  const ctx = { perceive: () => state, record() {}, signal: new AbortController().signal };
  assert.equal(recoverDrops.want(state), 0);
  assert.equal((await recoverDrops.run(ctx)).reason, 'drop_recovery_not_ready');
  assert.equal(moved, 0);

  state.inventory = { stone_pickaxe: 1, stone_sword: 1, cooked_beef: 2, iron_chestplate: 1 };
  assert.equal(recoverDrops.want(state), 0, 'carrying armour does not protect the bot');
  bot.inventory.slots[6] = { name: 'iron_chestplate' };
  assert.ok(recoverDrops.want(state) > 0);
  assert.equal((await recoverDrops.run(ctx)).ok, true);
  assert.equal(moved, 1);
  recoverDrops.dispose();
});

test('hurt but not badly, with nothing to eat and too full to heal, the bot gets food', () => {
  const s = setup();
  const hurt = { ...s.state, health: 10.8, food: 16, inventory: { chicken: 5 } };
  assert.ok(s.behavior('provision').want(hurt) > 0);
  assert.equal(s.behavior('provision').want({ ...hurt, health: 17 }), 0);
  assert.equal(s.behavior('provision').want({ ...hurt, food: 18 }), 0);
});

test('hunting pearls, an angry enderman is fought rather than hidden from, hurt or not', () => {
  const s = endermanFixture(true);
  s.setGoal('hunt_pearls');
  assert.equal(s.behavior('hide').want(s.state), 0);
  assert.ok(s.behavior('defend').want(s.state) > 0);
  assert.equal(s.behavior('hide').want({ ...s.state, health: 8 }), 0, 'a hole dug mid-fight is death');
  s.setGoal('outfit');
  assert.ok(s.behavior('hide').want(s.state) > 0, 'other work hides as before');
});
