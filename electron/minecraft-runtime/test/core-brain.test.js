'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrain, BAND } = require('../core/brain');
const { sleep } = require('../core/confirm');

// A tiny world: survival wants the body while `threat` is true; the goal adds
// one log per run until `logs` reaches the target.
function makeWorld() {
  const world = { logs: 0, threat: false, alive: true };
  const perceive = () => ({ alive: world.alive, logs: world.logs, threat: world.threat });
  return { world, perceive };
}

function logGoal(world, target, { stepMs = 5, fail = false } = {}) {
  return {
    name: 'logs',
    isDone: (s) => s.logs >= target,
    progress: (s) => s.logs,
    async run(ctx) {
      await sleep(stepMs, ctx.signal);
      if (fail) return { ok: false, reason: 'no_path' };
      world.logs += 1;
      return { ok: true };
    },
  };
}

async function runUntil(brain, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await brain.tick();
    await sleep(2);
  }
}

test('goal runs until the world shows it is done', async () => {
  const { world, perceive } = makeWorld();
  const events = [];
  const brain = createBrain({ perceive, onEvent: (e) => events.push(e) });
  brain.setGoal(logGoal(world, 3));
  await runUntil(brain, () => events.some((e) => e.type === 'goal_done'));
  assert.equal(world.logs, 3);
  assert.equal(brain.status().goal, null);
  await brain.dispose();
});

test('survival preempts the goal and the goal re-plans from state afterwards', async () => {
  const { world, perceive } = makeWorld();
  const events = [];
  let defended = 0;
  const defend = {
    name: 'defend', band: BAND.DEFENSE,
    want: (s) => (s.threat ? 1 : 0),
    async run(ctx) {
      await sleep(10, ctx.signal);
      defended += 1;
      world.threat = false;
      return { ok: true };
    },
  };
  const brain = createBrain({ perceive, behaviors: [defend], onEvent: (e) => events.push(e) });
  brain.setGoal(logGoal(world, 4, { stepMs: 40 }));
  await brain.tick();
  assert.equal(brain.status().running, 'goal:logs');
  world.threat = true;
  await brain.tick();
  assert.equal(brain.status().running, 'defend');
  const aborted = events.find((e) => e.type === 'behavior_finished' && e.behavior === 'goal:logs');
  assert.equal(aborted.reason, 'aborted');
  await runUntil(brain, () => events.some((e) => e.type === 'goal_done'));
  assert.equal(defended, 1);
  assert.equal(world.logs, 4);
  // An interruption is not counted as a stall.
  assert.ok(!events.some((e) => e.type === 'goal_failed'));
  await brain.dispose();
});

test('a goal that makes no progress fails with its reasons instead of retrying forever', async () => {
  const { world, perceive } = makeWorld();
  const events = [];
  const brain = createBrain({ perceive, noProgressLimit: 3, onEvent: (e) => events.push(e) });
  brain.setGoal(logGoal(world, 2, { fail: true, stepMs: 1 }));
  await runUntil(brain, () => events.some((e) => e.type === 'goal_failed'));
  const failed = events.find((e) => e.type === 'goal_failed');
  assert.deepEqual(failed.reasons, ['no_path', 'no_path', 'no_path']);
  assert.equal(events.filter((e) => e.type === 'behavior_started').length, 3);
  await brain.dispose();
});

test('a goal with a recovery gets that many fresh budgets before failing', async () => {
  const { world, perceive } = makeWorld();
  const events = [];
  const brain = createBrain({ perceive, noProgressLimit: 2, onEvent: (e) => events.push(e) });
  let recovered = 0;
  brain.setGoal({ ...logGoal(world, 2, { fail: true, stepMs: 1 }), maxRecoveries: 2, recover: () => { recovered += 1; } });
  await runUntil(brain, () => events.some((e) => e.type === 'goal_failed'));
  assert.equal(recovered, 2);
  assert.equal(events.filter((e) => e.type === 'goal_recovering').length, 2);
  assert.equal(events.filter((e) => e.type === 'behavior_started').length, 6);
  await brain.dispose();
});

test('a failing reflex backs off so it cannot monopolize the body', async () => {
  const { world, perceive } = makeWorld();
  let now = 0;
  let eatAttempts = 0;
  const eat = {
    name: 'eat', band: BAND.MAINTENANCE, want: () => 1,
    async run() { eatAttempts += 1; return { ok: false, reason: 'eat_unconfirmed' }; },
  };
  const brain = createBrain({ perceive, behaviors: [eat], now: () => now, failureCooldownMs: 1000 });
  brain.setGoal(logGoal(world, 1, { stepMs: 1 }));
  await brain.tick();
  await brain.idle();
  assert.equal(eatAttempts, 1);
  // While eat is cooling down the goal gets the body and finishes.
  await runUntil(brain, () => world.logs === 1);
  assert.equal(eatAttempts, 1);
  now += 1001;
  await brain.tick();
  await brain.idle();
  assert.equal(eatAttempts, 2);
  await brain.dispose();
});

test('same-band behaviors do not preempt each other', async () => {
  const { perceive } = makeWorld();
  let secondWanted = false;
  const first = { name: 'a', band: BAND.MAINTENANCE, want: () => 1, run: (ctx) => sleep(30, ctx.signal).then(() => ({ ok: true })) };
  const second = { name: 'b', band: BAND.MAINTENANCE, want: () => (secondWanted ? 2 : 0), run: async () => ({ ok: true }) };
  const brain = createBrain({ perceive, behaviors: [first, second] });
  await brain.tick();
  secondWanted = true;
  await brain.tick();
  assert.equal(brain.status().running, 'a');
  await brain.dispose();
});

test('stop clears the goal and aborts the running behavior', async () => {
  const { world, perceive } = makeWorld();
  const events = [];
  const brain = createBrain({ perceive, onEvent: (e) => events.push(e) });
  brain.setGoal(logGoal(world, 10, { stepMs: 200 }));
  await brain.tick();
  await brain.stop('user');
  assert.equal(brain.status().running, null);
  assert.equal(brain.status().goal, null);
  assert.equal(world.logs, 0);
  await brain.tick();
  assert.equal(brain.status().running, null);
  await brain.dispose();
});

test('death or missing state aborts whatever is running', async () => {
  const { world, perceive } = makeWorld();
  const brain = createBrain({ perceive });
  brain.setGoal(logGoal(world, 5, { stepMs: 200 }));
  await brain.tick();
  world.alive = false;
  await brain.tick();
  assert.equal(brain.status().running, null);
  await brain.dispose();
});
