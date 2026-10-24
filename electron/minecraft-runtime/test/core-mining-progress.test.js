'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { mineStep, leaveMine } = require('../core/mining');

const key = (p) => `${p.x},${p.y},${p.z}`;
const ctx = () => ({ signal: new AbortController().signal, record() {} });

function tunnel() {
  const cells = { '14,5,0': null, '15,5,0': '14,5,0' };
  const world = new Map();
  for (const k of Object.keys(cells)) {
    const [x, y, z] = k.split(',').map(Number);
    world.set(k, 'air'); world.set(`${x},${y + 1},${z}`, 'air');
  }
  // The end opens onto caves in every direction except the old tunnel west.
  for (const [x, z] of [[16, 0], [15, 1], [15, -1]]) world.set(`${x},5,${z}`, 'cave_air');
  const bot = {
    entity: { position: new Vec3(15.5, 5, 0.5) }, registry: { blocksByName: {} },
    inventory: { emptySlotCount: () => 20, items: () => [{ name: 'stone_pickaxe', type: 1 }] },
    blockAt(p) { const name = world.get(key(p)) || 'stone'; return { name, position: p,
      boundingBox: name.endsWith('air') ? 'empty' : 'block' }; },
  };
  const memory = { mine: { entrance: { x: 14, y: 5, z: 0 }, front: { x: 15, y: 5, z: 0 },
    surfaceY: 64, y: 5, dir: 0, phase: 'main', mainSteps: 2, steps: 2, turns: 0, branch: null,
    cells, walkFailures: 0 } };
  const dug = [];
  const actions = {
    goTo: async (_b, _c, goal) => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return { ok: true }; },
    digBlock: async (_b, _c, block) => { dug.push(key(block.position)); world.set(key(block.position), 'air'); return { ok: true }; },
  };
  return { bot, memory, actions, dug };
}

test('a two-cell cave-end cycle cannot claim excavation or reset its turn budget', async () => {
  const { bot, memory, actions, dug } = tunnel();
  const context = ctx();
  const options = { blocks: () => false, dropMatch: () => false, y: 5, blacklist: { has: () => false }, actions };
  for (let i = 0; i < 4; i += 1) {
    const result = await mineStep(bot, context, memory, options);
    assert.equal(result.progress, false);
    assert.equal(memory.mine.steps, 2);
    assert.deepEqual(bot.entity.position, new Vec3(15.5, 5, 0.5));
  }
  assert.equal(dug.length, 0);
  // It selects a genuinely untried exit at the preceding cell, then walks
  // there and excavates. It never counts the old 14 <-> 15 leg as mining.
  for (let i = 0; i < 10 && !dug.length; i += 1) await mineStep(bot, context, memory, options);
  assert.ok(dug.length > 0);
  assert.equal(memory.mine.steps, 3);
  assert.ok(Object.keys(memory.mine.cells).length > 2);
});

test('a successful path response without body movement is not route progress', async () => {
  const { bot, memory } = tunnel();
  bot.entity.position = new Vec3(14.5, 5, 0.5);
  const result = await mineStep(bot, ctx(), memory, { blocks: () => false, dropMatch: () => false, y: 5,
    blacklist: { has: () => false }, actions: { goTo: async () => ({ ok: true }) } });
  assert.equal(result.ok, true);
  assert.equal(result.progress, false);
});

test('an unloaded candidate waits without permanently exhausting that exit', async () => {
  const { bot, memory, actions } = tunnel();
  bot.entity.position = new Vec3(14.5, 5, 0.5);
  memory.mine.front = { x: 14, y: 5, z: 0 }; memory.mine.dir = 2;
  let loaded = false;
  const original = bot.blockAt;
  bot.blockAt = (p) => p.x === 13 && !loaded ? null : original(p);
  const options = { blocks: () => false, dropMatch: () => false, y: 5, blacklist: { has: () => false }, actions };
  assert.equal((await mineStep(bot, ctx(), memory, options)).reason, 'mine_chunk_unloaded');
  assert.equal(memory.mine.tried['14,5,0:level:2'], undefined);
  loaded = true;
  assert.equal((await mineStep(bot, ctx(), memory, options)).mined, '13,5,0');
});

test('the material planner does not refill its stall budget for successful non-progress actions', async () => {
  const { createGatherMaterialsGoal } = require('../core/goals/gatherMaterials');
  const { createBrain } = require('../core/brain');
  const state = { alive: true, inventory: { wooden_pickaxe: 1 }, position: new Vec3(0.5, 64, 0.5) };
  const bot = { entity: { position: state.position }, inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }] },
    blockAt: () => ({ name: 'chest' }) };
  const goal = createGatherMaterialsGoal({ bot, chest: { x: 0, y: 64, z: 0 }, requirements: [{ key: 'cobblestone', count: 2 }],
    actions: {}, skills: { gatherOne: async () => ({ ok: true, progress: false }) } });
  goal.memory.chest = {};
  goal.noProgressLimit = 3; goal.maxRecoveries = 0;
  const events = [];
  const brain = createBrain({ perceive: () => state, behaviors: [], goalRetryDelayMs: 0, onEvent: (e) => events.push(e) });
  try {
    brain.setGoal(goal); await brain.tick();
    for (let i = 0; i < 10 && brain.status().goal; i += 1) await brain.idle();
    assert.equal(goal.progress(), 0);
    assert.equal(brain.status().goal, null);
    assert.ok(events.some((e) => e.type === 'goal_failed'));
  } finally { await brain.dispose(); }
});

test('an unrelated device pit below surface level does not trigger an old mine exit', () => {
  const { bot, memory } = tunnel();
  bot.entity.position = new Vec3(40.5, 62.875, 20.5);
  let walks = 0;
  assert.equal(leaveMine(bot, ctx(), memory, { goTo: async () => { walks += 1; return { ok: true }; } }), null);
  assert.equal(walks, 0);
  assert.ok(memory.mine); // keep the route for the next material trip
});

test('ore beneath a recorded walking cell is sealed before mining continues', async () => {
  const { bot, memory, actions } = tunnel();
  const ore = new Vec3(15, 4, 0);
  let floor = 'iron_ore';
  const original = bot.blockAt;
  bot.registry.blocksByName.iron_ore = { id: 1, name: 'iron_ore' };
  bot.findBlocks = () => [ore];
  bot.blockAt = (p) => key(p) === key(ore)
    ? { name: floor, position: ore, boundingBox: floor === 'air' ? 'empty' : 'block' } : original(p);
  bot.inventory.items = () => [{ name: 'cobblestone', count: 64 }];
  actions.goToDig = async () => ({ ok: true });
  actions.digBlock = async () => { floor = 'air'; return { ok: true }; };
  actions.collectDrops = async () => ({ ok: true, collected: 1 });
  let verified = false;
  const skills = { placeAt: async (_b, _c, p, match, options) => {
    assert.equal(key(p), key(ore)); assert.ok(match('cobblestone'));
    floor = 'cobblestone'; verified = options.verify(); return { ok: verified };
  } };
  const result = await mineStep(bot, ctx(), memory, { blocks: (n) => n === 'iron_ore', dropMatch: () => true, y: 5,
    blacklist: { has: () => false }, actions, skills });
  assert.equal(result.ok, true);
  assert.equal(verified, true);
  assert.equal(floor, 'cobblestone');
  assert.equal(memory.mine.open[key(ore)], undefined);
});

test('failed route-floor repair remains pending and is retried before any new excavation', async () => {
  const { bot, memory, actions, dug } = tunnel();
  const position = new Vec3(15, 4, 0);
  memory.mine.floorRepair = { x: 15, y: 4, z: 0 };
  memory.mine.open = { [key(position)]: true };
  let floor = 'air', attempts = 0;
  const original = bot.blockAt;
  bot.blockAt = (p) => key(p) === key(position)
    ? { name: floor, position, boundingBox: floor === 'air' ? 'empty' : 'block' } : original(p);
  bot.inventory.items = () => [{ name: 'cobblestone', count: 1 }];
  const skills = { placeAt: async (_b, _c, _p, _match, { verify }) => {
    attempts += 1;
    if (attempts === 1) return { ok: false, reason: 'placement_denied' };
    floor = 'cobblestone'; return { ok: verify() };
  } };
  const options = { blocks: () => false, dropMatch: () => false, y: 5, blacklist: { has: () => false }, actions, skills };
  assert.equal((await mineStep(bot, ctx(), memory, options)).reason, 'placement_denied');
  assert.deepEqual(memory.mine.floorRepair, { x: 15, y: 4, z: 0 });
  assert.equal(memory.mine.steps, 2);
  assert.equal((await mineStep(bot, ctx(), memory, options)).ok, true);
  assert.equal(attempts, 2);
  assert.equal(memory.mine.floorRepair, null);
  assert.equal(floor, 'cobblestone');
  assert.equal(dug.length, 0);
});
