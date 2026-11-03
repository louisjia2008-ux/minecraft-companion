'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { playthroughNatural, STEPS } = require('../scenarios/playthrough.cjs');

test('a nether trip short of obsidian for its portal sends the model back for the gear', () => {
  const state = { gearDone: true, steps: STEPS.map((s) => ({ id: s.id, asks: 1, doneAt: s.id === 'nether' ? null : 1 })) };
  const gear = state.steps.find((e) => e.id === 'gear');
  // Lost in a fight: the gear stays done.
  playthroughNatural.onEvent({ type: 'goal_failed', goal: 'nether_expedition', reasons: ['death_loop'] }, state);
  assert.equal(gear.doneAt, 1);
  playthroughNatural.onEvent({ type: 'goal_failed', goal: 'nether_expedition', reasons: Array(30).fill('missing_obsidian') }, state);
  assert.equal(gear.doneAt, null);
  assert.equal(gear.asks, 0);
  assert.equal(state.gearDone, false);
});

function modelContext({ armour = [], step = 'pearls', goal = null } = {}) {
  const { Vec3 } = require('vec3');
  const slots = [];
  armour.forEach((name, i) => { slots[5 + i] = { name, count: 1 }; });
  const asked = [];
  const bot = { entity: { position: new Vec3(0, 64, 0) }, health: 20, food: 20, entities: {}, game: { dimension: 'minecraft:overworld' },
    time: { timeOfDay: 14000 }, inventory: { slots, items: () => [], emptySlotCount: () => 20 } };
  const steps = STEPS.map((s, i) => ({ id: s.id, asks: s.id === step ? 1 : 0, doneAt: i < STEPS.findIndex((x) => x.id === step) ? 1 : null }));
  const state = { steps, goals: {}, gearDone: true, armorDone: true, snackEnd: Date.now() };
  const companion = { status: () => ({ goal }), submitTask: async (task, args) => { asked.push({ task, args }); } };
  const server = { query: async () => ['', 'Test failed'] };
  return { context: { companion, bot, state, server, username: 'x', write() {}, elapsedMs: 0 }, asked, state };
}

test('armour worn through: the model asks for a new set before the next step, and only once an hour', async () => {
  const { context, asked, state } = modelContext({ armour: [] });
  await playthroughNatural.onTick(context);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].task, 'outfit');
  assert.ok(asked[0].args.items.some((r) => r.key === 'iron_chestplate'));
  assert.equal(state.steps.find((e) => e.id === 'pearls').asks, 1, 'not one of the step\'s asks');
  // Done (or given up): back to the step, with no new set asked for at once.
  await playthroughNatural.onTick(context);
  await playthroughNatural.onTick(context);
  assert.ok(asked.slice(1).every((a) => a.task !== 'outfit'), JSON.stringify(asked));
});

test('armour still on: no new set', async () => {
  const { context, asked } = modelContext({ armour: ['iron_helmet', 'iron_chestplate', 'iron_leggings'] });
  await playthroughNatural.onTick(context);
  assert.ok(asked.every((a) => a.task !== 'outfit'));
});
