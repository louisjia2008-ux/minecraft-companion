'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrain, BAND } = require('../core/brain');
const { sleep } = require('../core/confirm');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const waitingGoal = (run, extra = {}) => ({ name: 'same', progress: () => 0, isDone: () => false, run, ...extra });

test('a late replaced run cannot spend the new goal budget or publish stale records', async () => {
  const events = [], oldRun = deferred();
  let oldContext;
  const brain = createBrain({ perceive: () => ({ alive: true }), noProgressLimit: 1, onEvent: (event) => events.push(event) });
  brain.setGoal(waitingGoal((ctx) => { oldContext = ctx; return oldRun.promise; }), { taskId: 'old' });
  await brain.tick();
  const settled = brain.idle();
  brain.setGoal(waitingGoal((ctx) => sleep(10000, ctx.signal)), { taskId: 'new' });
  oldContext.record('goal_done', { goal: 'same', taskId: 'new' });
  oldRun.resolve({ ok: false, reason: 'old_failure' });
  await settled;
  assert.equal(brain.status().goal.taskId, 'new');
  assert.equal(brain.status().goal.stalls, 0);
  assert.deepEqual(brain.status().cooldowns, []);
  assert.equal(events.some((event) => ['goal_done', 'goal_failed', 'behavior_finished'].includes(event.type)), false);
  await brain.dispose();
});

test('resubmitting the exact same definition still creates a separate generation', async () => {
  const events = [], first = deferred();
  let calls = 0;
  const goal = waitingGoal((ctx) => ++calls === 1 ? first.promise : sleep(10000, ctx.signal));
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent: (event) => events.push(event) });
  brain.setGoal(goal, { taskId: 'one' });
  await brain.tick();
  const oldGeneration = brain.status().goal.generation;
  brain.setGoal(goal, { taskId: 'two' });
  const switching = brain.tick();
  first.resolve({ ok: false, reason: 'old_failure' });
  await switching;
  assert.equal(calls, 2);
  assert.equal(brain.status().goal.stalls, 0);
  assert.ok(brain.status().goal.generation > oldGeneration);
  assert.equal(events.some((event) => event.type === 'behavior_finished' && event.taskId === 'two'), false);
  await brain.dispose();
});

test('goal events, behavior events and records retain immutable task correlation', async () => {
  const events = [], metadata = { taskId: 'accepted' };
  let done = false, context;
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent: (event) => events.push(event) });
  brain.setGoal(waitingGoal((ctx) => {
    context = ctx;
    ctx.record('progress', { taskId: 'forged', generation: 999, behavior: 'forged' });
    done = true;
    return { ok: true };
  }, { isDone: () => done }), metadata);
  metadata.taskId = 'changed';
  await brain.tick();
  await brain.idle();
  const correlated = events.filter((event) => ['goal_set', 'behavior_started', 'progress', 'goal_done', 'behavior_finished'].includes(event.type));
  assert.equal(correlated.length, 5);
  assert.ok(correlated.every((event) => event.taskId === 'accepted' && event.generation === 1));
  assert.equal(events.find((event) => event.type === 'progress').behavior, 'goal:same');
  const count = events.length;
  context.record('late_after_finish');
  assert.equal(events.length, count);
  await brain.dispose();
});

test('goal metadata is optional and supported without a second argument', async () => {
  const brain = createBrain({ perceive: () => ({ alive: true }) });
  brain.setGoal(waitingGoal(() => {}, { metadata: { taskId: 'from_definition' } }));
  assert.equal(brain.status().goal.taskId, 'from_definition');
  await brain.dispose();
});

test('a terminal-event observer may install the next goal without it being erased', async () => {
  const events = [];
  let done = false;
  const replacement = waitingGoal((ctx) => sleep(10000, ctx.signal));
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent(event) {
    events.push(event);
    if (event.type === 'goal_done') brain.setGoal(replacement, { taskId: 'replacement' });
  } });
  brain.setGoal(waitingGoal(() => { done = true; }, { isDone: () => done }), { taskId: 'first' });
  await brain.tick();
  await brain.idle();
  assert.equal(brain.status().goal.taskId, 'replacement');
  assert.equal(events.some((event) => event.type === 'behavior_finished' && event.taskId === 'first'), false);
  await brain.dispose();
});

test('pausing preserves a goal while safety continues, and resume replans it', async () => {
  let threat = false, safetyRuns = 0, goalRuns = 0;
  const brain = createBrain({ perceive: () => ({ alive: true }), behaviors: [{
    name: 'safety', band: BAND.ESCAPE, want: () => threat ? 1 : 0,
    run: () => { safetyRuns++; threat = false; return { ok: true }; },
  }] });
  brain.setGoal(waitingGoal((ctx) => { goalRuns++; return sleep(10000, ctx.signal); }), { taskId: 'paused_task' });
  await brain.tick();
  await brain.pauseGoal();
  assert.equal(brain.status().paused, true);
  assert.equal(brain.status().goal.taskId, 'paused_task');
  threat = true;
  await brain.tick();
  await brain.idle();
  assert.equal(safetyRuns, 1);
  assert.equal(goalRuns, 1);
  await brain.resumeGoal();
  // Aborting a goal must not give it a retry cooldown on resume.
  assert.equal(goalRuns, 2);
  assert.equal(brain.status().goal.stalls, 0);
  await brain.dispose();
});

test('dispose during an awaiting preemption cannot start another behavior', async () => {
  const run = deferred();
  let threat = false, safetyRuns = 0;
  const brain = createBrain({ perceive: () => ({ alive: true }), behaviors: [{
    name: 'safety', band: BAND.ESCAPE, want: () => threat ? 1 : 0, run: () => { safetyRuns++; },
  }] });
  brain.setGoal(waitingGoal(() => run.promise));
  await brain.tick();
  threat = true;
  const switching = brain.tick();
  const disposing = brain.dispose();
  assert.equal(brain.dispose(), disposing);
  run.resolve({ ok: true });
  await Promise.all([switching, disposing]);
  await brain.tick();
  assert.equal(safetyRuns, 0);
  assert.equal(brain.status().disposed, true);
  assert.throws(() => brain.setGoal(waitingGoal(() => {})), { code: 'disposed' });
  await assert.rejects(brain.resumeGoal(), { code: 'disposed' });
});

test('clearGoal after replacement aborts the still-running older generation', async () => {
  let signal;
  const brain = createBrain({ perceive: () => ({ alive: true }) });
  brain.setGoal(waitingGoal((ctx) => { signal = ctx.signal; return sleep(10000, ctx.signal); }), { taskId: 'old' });
  await brain.tick();
  brain.setGoal(waitingGoal(() => {}), { taskId: 'new' });
  await brain.clearGoal();
  assert.equal(signal.aborted, true);
  assert.equal(brain.status().goal, null);
  assert.equal(brain.status().running, null);
  await brain.dispose();
});

test('a throwing completion evaluator fails its task once and releases the body', async () => {
  const events = [];
  let ran = false;
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent: (event) => events.push(event) });
  brain.setGoal(waitingGoal(() => { ran = true; return { ok: true }; }, {
    isDone: () => { if (ran) throw new Error('world read failed'); return false; },
  }), { taskId: 'broken-evaluator' });
  await brain.tick();
  await brain.idle();
  await brain.tick();
  assert.equal(brain.status().running, null);
  assert.equal(brain.status().goal, null);
  const failures = events.filter((event) => event.type === 'goal_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].taskId, 'broken-evaluator');
  assert.match(failures[0].reasons[0], /goal_evaluation_error: world read failed/);
  assert.equal(events.some((event) => event.type === 'goal_done'), false);
  await brain.dispose();
});

test('a throwing initial evaluator terminates before running instead of remaining pending', async () => {
  const events = [];
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent: (event) => events.push(event) });
  brain.setGoal(waitingGoal(() => assert.fail('broken evaluator must never run'), {
    isDone: () => { throw new Error('initial state unavailable'); },
  }), { taskId: 'initial-evaluator' });
  await brain.tick();
  assert.equal(brain.status().goal, null);
  assert.equal(events.filter((event) => event.type === 'goal_failed').length, 1);
  assert.equal(events.find((event) => event.type === 'goal_failed').taskId, 'initial-evaluator');
  await brain.dispose();
});

test('a rejected asynchronous evaluator fails rather than completing from a truthy Promise', async () => {
  const events = [];
  const brain = createBrain({ perceive: () => ({ alive: true }), onEvent: (event) => events.push(event) });
  brain.setGoal(waitingGoal(() => assert.fail('invalid evaluator must never run'), {
    isDone: async () => { throw new Error('rejected evaluator'); },
  }), { taskId: 'async-evaluator' });
  await brain.tick();
  await brain.idle();
  assert.equal(brain.status().goal, null);
  assert.equal(events.some((event) => event.type === 'goal_done'), false);
  assert.match(events.find((event) => event.type === 'goal_failed').reasons[0], /isDone must be synchronous/);
  await brain.dispose();
});

for (const asynchronous of [false, true]) test(`${asynchronous ? 'rejected' : 'throwing'} recovery fails only its owning task and releases safety`, async () => {
  const events = [];
  let safetyWanted = false, safetyRuns = 0;
  const brain = createBrain({ perceive: () => ({ alive: true }), noProgressLimit: 1, onEvent: (event) => events.push(event),
    behaviors: [{ name: 'safety', band: BAND.ESCAPE, want: () => safetyWanted ? 1 : 0,
      run: () => { safetyRuns++; safetyWanted = false; return { ok: true }; } }] });
  const fail = () => { throw new Error('recovery failed'); };
  brain.setGoal(waitingGoal(() => ({ ok: false, reason: 'no_path' }), {
    maxRecoveries: 1, recover: asynchronous ? async () => fail() : fail,
  }), { taskId: 'broken-recovery' });
  await brain.tick();
  await brain.idle();
  const failures = events.filter((event) => event.type === 'goal_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].taskId, 'broken-recovery');
  assert.match(failures[0].reasons[0], /goal_recovery_error: recovery failed/);
  assert.equal(brain.status().running, null);
  assert.equal(brain.status().goal, null);
  safetyWanted = true;
  await brain.tick();
  await brain.idle();
  assert.equal(safetyRuns, 1);
  await brain.dispose();
});
