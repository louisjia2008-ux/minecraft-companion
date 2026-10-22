'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrain } = require('../core/brain');
const { createDirector, chooseNext } = require('../core/director');
const { sleep } = require('../core/confirm');

const day = { alive: true, health: 20, food: 20, isDay: true, inventory: {} };

function card(id, need, extra = {}) {
  return { id, stage: 0, risk: 'low', need: typeof need === 'function' ? need : () => need,
    create: () => ({ name: id, isDone: () => true, progress: () => 0, run: async () => ({ ok: true }) }), ...extra };
}

test('chooseNext picks the most needed card and reports every score', () => {
  const choice = chooseNext(day, {}, [card('a', 40), card('b', 70), card('c', 0)]);
  assert.equal(choice.card.id, 'b');
  assert.deepEqual(choice.scores.map((s) => s.score), [40, 70, 0]);
});

test('chooseNext leaves out cards above the stage, failing requirements or cooling down', () => {
  const cards = [card('late', 90, { stage: 2 }), card('blocked', 80, { requires: () => false }),
    card('cooling', 70), card('ok', 10)];
  const cooldowns = new Map([['cooling', { count: 1, until: 2000 }]]);
  const choice = chooseNext(day, {}, cards, { stage: 1, cooldowns, now: 1000 });
  assert.equal(choice.card.id, 'ok');
  assert.deepEqual(choice.scores.map((s) => s.skipped), ['stage', 'requires', 'cooldown', undefined]);
});

test('risky cards wait for daylight and a healthy body', () => {
  const cards = [card('nether', 90, { risk: 'high' }), card('hunt', 60, { risk: 'medium' }), card('farm', 30)];
  assert.equal(chooseNext(day, {}, cards).card.id, 'nether');
  const night = { ...day, isDay: false };
  const choice = chooseNext(night, {}, cards);
  assert.equal(choice.card.id, 'farm'); // hunt 60 * 0.4 = 24 < 30
  assert.equal(choice.scores[0].score, 0);
  assert.equal(chooseNext({ ...day, health: 8 }, {}, cards).card.id, 'hunt');
});

test('a card that throws is skipped, not fatal', () => {
  const choice = chooseNext(day, {}, [card('bad', () => { throw new Error('boom'); }), card('ok', 5)]);
  assert.equal(choice.card.id, 'ok');
  assert.equal(choice.scores[0].skipped, 'error:boom');
});

// A small world: each goal adds one unit of its resource per run.
function setup({ cards, clock = { t: 0 }, ...options }) {
  const world = { wood: 0, food: 0 };
  const perceive = () => ({ ...day, wood: world.wood, foodStock: world.food });
  const events = [];
  let director;
  const brain = createBrain({ perceive, goalRetryDelayMs: 0, now: () => clock.t,
    onEvent: (e) => { events.push(e); director?.handleEvent(e); } });
  director = createDirector({ brain, perceive, cards: cards(world), now: () => clock.t, idleMs: 0,
    onEvent: (e) => events.push(e), ...options });
  return { world, brain, director, events, clock };
}

function resourceGoal(world, key, target, { fail = false } = {}) {
  return {
    name: `stock_${key}`,
    isDone: () => world[key] >= target,
    progress: () => world[key],
    noProgressLimit: 2,
    async run(ctx) {
      await sleep(1, ctx.signal);
      if (fail) return { ok: false, reason: 'no_target' };
      world[key] += 1;
      return { ok: true };
    },
  };
}

async function drive({ brain, director }, until, steps = 400) {
  for (let i = 0; i < steps && !until(); i += 1) {
    director.tick();
    await brain.tick();
    await sleep(1);
  }
}

test('the director runs one goal to its end, then picks the next most needed', async () => {
  const s = setup({ cards: (world) => [
    card('wood', () => (world.wood >= 3 ? 0 : 80), { create: () => resourceGoal(world, 'wood', 3) }),
    card('food', () => (world.food >= 2 ? 0 : 50), { create: () => resourceGoal(world, 'food', 2) }),
  ] });
  s.director.enable();
  await drive(s, () => s.events.some((e) => e.type === 'autonomy_idle'));
  const choices = s.events.filter((e) => e.type === 'autonomy_choice').map((e) => e.card);
  assert.deepEqual(choices, ['wood', 'food']);
  assert.equal(s.world.wood, 3);
  assert.equal(s.world.food, 2);
  await s.brain.dispose();
});

test('a failed goal cools down and the director moves on to something else', async () => {
  const s = setup({ cards: (world) => [
    card('wood', 80, { create: () => resourceGoal(world, 'wood', 99, { fail: true }) }),
    card('food', () => (world.food >= 1 ? 0 : 50), { create: () => resourceGoal(world, 'food', 1) }),
  ] });
  s.director.enable();
  await drive(s, () => s.world.food >= 1);
  const choices = s.events.filter((e) => e.type === 'autonomy_choice').map((e) => e.card);
  assert.deepEqual(choices, ['wood', 'food']);
  const cooldown = s.director.status().cooldowns.find((c) => c.id === 'wood');
  assert.equal(cooldown.until, s.clock.t + 5 * 60000);
  // Failing again after the cooldown doubles it.
  s.clock.t += 5 * 60000;
  await drive(s, () => s.events.filter((e) => e.type === 'autonomy_cooldown').length >= 2);
  assert.equal(s.director.status().cooldowns[0].count, 2);
  assert.equal(s.director.status().cooldowns[0].until - s.clock.t, 10 * 60000);
  await s.brain.dispose();
});

test('a player goal takes over and autonomy resumes only after a pause', async () => {
  const s = setup({ cards: (world) => [card('wood', 80, { create: () => resourceGoal(world, 'wood', 99) })] });
  s.director.enable();
  s.director.tick();
  assert.equal(s.brain.status().goal.name, 'stock_wood');
  s.director.notePlayerGoal();
  s.brain.setGoal(resourceGoal(s.world, 'food', 2));
  await drive(s, () => s.world.food >= 2 && !s.brain.status().goal);
  assert.equal(s.director.tick(), null); // still within the 30 s pause
  s.clock.t += 30000;
  assert.equal(s.director.tick(), 'wood');
  await s.brain.dispose();
});

test('disabling clears only the goal the director chose', async () => {
  const s = setup({ cards: (world) => [card('wood', 80, { create: () => resourceGoal(world, 'wood', 99) })] });
  s.director.enable();
  s.director.tick();
  await s.director.disable();
  assert.equal(s.brain.status().goal, null);
  assert.equal(s.director.tick(), null);
  s.director.enable();
  s.director.notePlayerGoal();
  s.brain.setGoal(resourceGoal(s.world, 'food', 99));
  await s.director.disable();
  assert.equal(s.brain.status().goal.name, 'stock_food');
  await s.brain.dispose();
});
