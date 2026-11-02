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
