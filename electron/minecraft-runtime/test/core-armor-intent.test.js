'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { upgrades } = require('../core/armor');
const { createRecovery } = require('../core/behaviors/recovery');
const { createBrain } = require('../core/brain');
const { abortError } = require('../core/confirm');
const end = require('../core/end');

function fixture(dimension = 'the_end') {
  const items = ['carved_pumpkin', 'iron_helmet', 'diamond_chestplate', 'shield'].map((name) => ({ name, count: 1 }));
  const bot = Object.assign(new EventEmitter(), { game: { dimension }, health: 20, food: 20,
    entity: { position: new Vec3(.5, 64, .5), onGround: true },
    inventory: { items: () => items, slots: Array(46).fill(null), emptySlotCount: () => 30 } });
  const equipped = [];
  bot.equip = async (item, destination) => {
    equipped.push(`${item.name}@${destination}`);
    bot.inventory.slots[{ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination]] = item;
  };
  return { bot, items, equipped };
}

test('End pumpkin and maintenance armour do not repeatedly undo each other', async () => {
  const f = fixture(); const wear = createRecovery({ bot: f.bot }).behaviors.find((b) => b.name === 'wear_armor');
  const state = { hostiles: [], inventory: {}, freeSlots: 30 };
  for (let i = 0; i < 5; i += 1) {
    await end.wearArmor(f.bot);
    if (wear.want(state)) await wear.run({ perceive: () => state, record() {} });
  }
  assert.equal(f.bot.inventory.slots[5].name, 'carved_pumpkin');
  assert.equal(f.equipped.filter((x) => x.endsWith('@head')).length, 1);
});

test('End head protection still permits body armour and shield upgrades', () => {
  const f = fixture('minecraft:the_end'); f.bot.inventory.slots[5] = f.items[0];
  assert.deepEqual(upgrades(f.bot).map(([i, slot]) => `${i.name}@${slot}`), ['diamond_chestplate@torso', 'shield@off-hand']);
});

test('a pumpkin no longer blocks an ordinary overworld helmet upgrade', () => {
  const f = fixture('overworld'); f.bot.inventory.slots[5] = f.items[0];
  assert.ok(upgrades(f.bot).some(([i, slot]) => i.name === 'iron_helmet' && slot === 'head'));
});

test('Nether maintenance preserves one actual gold piece while upgrading the others', async () => {
  const f = fixture('minecraft:the_nether');
  f.items.push({ name: 'diamond_helmet', count: 1 });
  f.bot.inventory.slots[5] = { name: 'golden_helmet', count: 1 };
  f.bot.inventory.slots[6] = { name: 'golden_chestplate', count: 1 };
  for (const [item, slot] of upgrades(f.bot)) await f.bot.equip(item, slot);
  assert.equal(f.bot.inventory.slots[5].name, 'golden_helmet');
  assert.equal(f.bot.inventory.slots[6].name, 'diamond_chestplate');
});

test('Nether protection is not fabricated when no gold is actually worn', () => {
  const f = fixture('the_nether');
  assert.ok(upgrades(f.bot).some(([i, slot]) => i.name === 'iron_helmet' && slot === 'head'));
});

test('the real brain can finish a pumpkin-wearing End action without armour preemption', async () => {
  const f = fixture(); f.bot.inventory.slots[5] = f.items.find((i) => i.name === 'iron_helmet');
  f.items.splice(f.items.findIndex((i) => i.name === 'diamond_chestplate'), 1);
  f.items.splice(f.items.findIndex((i) => i.name === 'shield'), 1);
  const recovery = createRecovery({ bot: f.bot });
  const events = []; let reached; let release; let finished = 0;
  const entered = new Promise((r) => { reached = r; });
  const perceive = () => ({ alive: true, position: f.bot.entity.position.clone(), hostiles: [], inventory: {}, freeSlots: 30,
    health: 20, food: 20, isDay: true, sheltered: false });
  const brain = createBrain({ perceive, behaviors: recovery.behaviors, goalRetryDelayMs: 0,
    onEvent: (e) => { recovery.observe(e); events.push(e); } });
  recovery.attach(brain);
  brain.setGoal({ name: 'end_armor_action', isDone: () => finished > 0, progress: () => finished,
    async run(ctx) {
      await end.wearArmor(f.bot);
      if (ctx.signal.aborted) throw abortError(ctx.signal);
      await new Promise((resolve, reject) => { release = resolve; reached();
        ctx.signal.addEventListener('abort', () => reject(abortError(ctx.signal)), { once: true }); });
      finished += 1; return { ok: true };
    } });
  try {
    await brain.tick(); await entered;
    await brain.tick(); release(); await brain.idle(); await brain.tick();
    assert.equal(events.some((e) => e.type === 'behavior_started' && e.behavior === 'wear_armor'), false);
    assert.equal(finished, 1);
  } finally { await brain.dispose(); recovery.dispose(); }
});
