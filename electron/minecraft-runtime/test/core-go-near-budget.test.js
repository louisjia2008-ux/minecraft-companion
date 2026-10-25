'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { goNear } = require('../core/actions');

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
async function drain(t, promise, maxMs = 200000) {
  let settled = false, value, error;
  promise.then(result => { settled = true; value = result; }, reason => { settled = true; error = reason; });
  for (let elapsed = 0; !settled && elapsed <= maxMs; elapsed += 1000) {
    await flush();
    if (!settled) t.mock.timers.tick(1000);
  }
  await flush();
  assert.equal(settled, true, 'virtual operation must settle within the finite test budget');
  return { value, error };
}
function fixture(t, mode) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1000000 });
  const controller = new AbortController(), calls = [];
  let active = null;
  const bot = { entity: { position: new Vec3(.5, 64, .5) },
    // Isolate timeout classification: active native digging is explicitly a
    // watchdog exemption. No real world or physics engine is launched.
    targetDigBlock: {}, registry: { itemsByName: {} }, blockAt: () => null,
    lookAt: async () => {}, setControlState() {}, clearControlStates() {} };
  const finish = (error, move) => {
    const operation = active;
    if (!operation) return;
    active = null;
    clearTimeout(operation.timer);
    if (move) bot.entity.position = new Vec3(operation.goal.x + .5, operation.goal.y ?? 64, operation.goal.z + .5);
    if (error) operation.reject(error); else operation.resolve();
  };
  bot.pathfinder = {
    goal: null, movements: {},
    setGoal(goal) {
      this.goal = goal;
      if (goal !== null || !active) return;
      if (mode === 'delayed_cancel') {
        // Native stop is acknowledged only at65s, after the original60s
        // action deadline, regardless of repeated halt requests.
        if (!active.ackTimer) active.ackTimer = setTimeout(() => finish(Object.assign(new Error('native stopped late'), { name: 'PathStopped' })), Math.max(0, 65000 - (Date.now() - 1000000)));
        return;
      }
      finish(Object.assign(new Error('native stopped'), { name: 'PathStopped' }));
    },
    goto(goal) {
      this.goal = goal;
      calls.push({ at: Date.now(), kind: goal.constructor.name, x: goal.x, z: goal.z });
      return new Promise((resolve, reject) => {
        active = { goal, resolve, reject, timer: null };
        if (mode === 'recover' && calls.length > 1) { finish(null, true); return; }
        if (mode === 'empty_waypoint' && calls.length > 1) { finish(null, false); return; }
        if (mode === 'slow_close') {
          active.timer = setTimeout(() => finish(null, true), 40000); return;
        }
        if (mode === 'budget') {
          if (calls.length === 1) active.timer = setTimeout(() => finish(Object.assign(new Error('native finite planner timeout'), { name: 'Timeout' })), 55000);
          else bot.entity.position = bot.entity.position.offset(5, 0, 0);
        }
      });
    },
  };
  t.after(async () => { controller.abort('test_cleanup'); finish(Object.assign(new Error('cleanup'), { code: 'aborted' })); await flush(); });
  return { bot, calls, controller, ctx: { signal: controller.signal }, started: Date.now() };
}

test('native path_timeout on a long direct leg enters existing waypoints within the original60s', async t => {
  const f = fixture(t, 'recover');
  const result = await drain(t, goNear(f.bot, f.ctx, new Vec3(64.5, 64, .5), 4, { timeoutMs: 60000 }));
  assert.ifError(result.error); assert.equal(result.value.ok, true);
  assert.ok(f.calls.some(c => c.kind === 'GoalNearXZ'));
  assert.ok(Date.now() - f.started <= 60000);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(64.5,64,.5)) <= 5.5);
});

test('fallback does not renew the original deadline or start native work after it expires', async t => {
  const f = fixture(t, 'budget');
  const result = await drain(t, goNear(f.bot, f.ctx, new Vec3(200.5, 64, .5), 4, { timeoutMs: 60000 }));
  const elapsed = Date.now() - f.started;
  assert.ifError(result.error); assert.equal(result.value.ok, false);
  assert.equal(result.value.reason, 'path_timeout');
  assert.ok(elapsed <= 60000, 'all legs share the original60s');
  assert.ok(f.calls.every(c => c.at < f.started + 60000), 'no native retry starts after expiry');
});

test('a close direct trip keeps the original full60s without the far-leg cap', async t => {
  const f = fixture(t, 'slow_close');
  const result = await drain(t, goNear(f.bot, f.ctx, new Vec3(12.5, 64, .5), 4, { timeoutMs: 60000 }));
  assert.ifError(result.error); assert.equal(result.value.ok, true);
  assert.equal(Date.now() - f.started, 40000); assert.equal(f.calls.length, 1);
});

test('an empty resolved waypoint does not grant arrival or progress credit', async t => {
  const f = fixture(t, 'empty_waypoint');
  const result = await drain(t, goNear(f.bot, f.ctx, new Vec3(64.5, 64, .5), 4, { timeoutMs: 60000 }));
  assert.ifError(result.error); assert.equal(result.value.ok, false);
  assert.equal(result.value.reason, 'leg_blocked');
  assert.equal(f.bot.entity.position.x, .5);
});

test('parent cancellation is preserved and no later timeout restarts native work', async t => {
  const f = fixture(t, 'recover');
  const operation = goNear(f.bot, f.ctx, new Vec3(64.5, 64, .5), 4, { timeoutMs: 60000 });
  setTimeout(() => f.controller.abort('higher_priority'), 5000);
  const result = await drain(t, operation);
  assert.equal(result.error?.code, 'aborted');
  const count = f.calls.length; t.mock.timers.tick(120000); await flush();
  assert.equal(f.calls.length, count);
});

for (const parentAbortAt of [5000, 62000]) test(`root cancellation wins over own expiry after delayed native acknowledgement: parentAt=${parentAbortAt}`, async t => {
  const f = fixture(t, 'delayed_cancel');
  const operation = goNear(f.bot, f.ctx, new Vec3(64.5, 64, .5), 4, { timeoutMs: 60000 });
  setTimeout(() => f.controller.abort('root_cancel'), parentAbortAt);
  const result = await drain(t, operation);
  assert.equal(Date.now() - f.started, 65000, 'actual native cancellation acknowledgement remains awaited');
  assert.equal(result.error?.code, 'aborted', 'root cancellation must not become own path_timeout');
  assert.equal(result.error.message, 'root_cancel');
  assert.equal(f.calls.length, 1, 'no fallback may start after cancellation');
});


test('already-aborted root wins even when the requested action budget is zero', async t => {
  const f = fixture(t, 'recover'); f.controller.abort('root_cancel');
  const result = await drain(t, goNear(f.bot, f.ctx, new Vec3(64.5,64,.5), 4, { timeoutMs: 0 }));
  assert.equal(result.error?.code, 'aborted'); assert.equal(result.error.message, 'root_cancel');
  assert.equal(f.calls.length, 0);
});
