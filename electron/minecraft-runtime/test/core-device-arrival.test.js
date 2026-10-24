'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { enterStand } = require('../core/goals/cobbleGenerator');
const { createDeviceProjectGoal } = require('../core/goals/deviceProject');
const context = () => ({ signal: new AbortController().signal, record() {}, perceive: () => ({ inventory: {} }) });

test('horizontal path completion waits for the falling body to settle on the collector chest', async (t) => {
  const bot = { entity: { position: new Vec3(0, 64, 0), onGround: true } };
  let timer;
  t.after(() => clearTimeout(timer));
  const actions = { goTo: async () => {
    bot.entity.position = new Vec3(5.5, 63.766, 5.5); bot.entity.onGround = false;
    timer = setTimeout(() => { bot.entity.position.y = 62.875; bot.entity.onGround = true; }, 80);
    return { ok: false, reason: 'not_arrived' };
  } };
  assert.equal((await enterStand(bot, context(), new Vec3(5, 63, 5), actions)).ok, true);
  assert.equal(bot.entity.position.y, 62.875);
});

test('a fall past the intended floor is refused and arrival remains abortable', async () => {
  const bot = { entity: { position: new Vec3(5.5, 61, 5.5), onGround: true } };
  const actions = { goTo: async () => ({ ok: true }) };
  const result = await enterStand(bot, context(), new Vec3(5, 63, 5), actions);
  assert.deepEqual(result, { ok: false, reason: 'not_in_stand' });
  const controller = new AbortController(); controller.abort('test_cancel');
  await assert.rejects(enterStand(bot, { signal: controller.signal }, new Vec3(5, 63, 5), actions), { code: 'aborted' });
});

test('a retained mine is used at the material boundary and does not interrupt device work', async () => {
  const bot = { entity: { position: new Vec3(17, 64, 3) } };
  let builds = 0, walks = 0;
  const device = { name: 'fake', memory: { device: {} }, needs: () => [], isDone: () => false,
    progress: () => builds, run: async () => { builds += 1; return { ok: true }; } };
  const goal = createDeviceProjectGoal({ bot, name: 'build_fake', device,
    home: { chest: { x: 0, y: 64, z: 0 }, centre: { x: 3, y: 64, z: 3 } },
    actions: { goTo: async () => { walks += 1; return { ok: true }; } } });
  goal.memory.mine = { surfaceY: 64, cells: { '17,62,3': null, '18,63,3': '17,62,3' } };
  await goal.run(context()); // safely exited the mine on the surface
  bot.entity.position.y = 62.875; // device work now happens below that old surface
  await goal.run(context()); await goal.run(context());
  assert.equal(builds, 3);
  assert.equal(walks, 0);
});

test('device recovery performs a bounded physical recovery when no gather is active', async () => {
  const bot = { entity: { position: new Vec3(17, 64, 3) } };
  let unstuck = 0;
  const device = { name: 'fake', memory: { device: {} }, needs: () => [], isDone: () => false,
    progress: () => 0, run: async () => ({ ok: false, reason: 'not_in_stand' }) };
  const goal = createDeviceProjectGoal({ bot, name: 'build_fake', device,
    home: { chest: { x: 0, y: 64, z: 0 }, centre: { x: 3, y: 64, z: 3 } },
    actions: { unstick: async () => { unstuck += 1; return { ok: true }; } } });
  goal.recover(); await goal.run(context()); await goal.run(context());
  assert.equal(unstuck, 1);
});

test('finishing materials in the bag preserves progress when construction takes over', async () => {
  const bot = { entity: { position: new Vec3(17, 64, 3) } };
  let built = 0;
  const device = { name: 'fake', memory: { device: {} }, needs: () => [{ key: 'hopper', count: 1 }],
    isDone: () => false, progress: () => built, run: async () => { built += 1; return { ok: true }; } };
  const goal = createDeviceProjectGoal({ bot, name: 'build_fake', device,
    home: { chest: { x: 0, y: 64, z: 0 }, centre: { x: 3, y: 64, z: 3 } } });
  goal.memory.gather = { progress: () => 120 };
  const before = goal.progress({});
  const c = context(); c.perceive = () => ({ inventory: { hopper: 1 } });
  await goal.run(c);
  assert.equal(goal.memory.gather, null);
  assert.equal(goal.progress({}), before + 1);
  await goal.run(c);
  assert.equal(goal.progress({}), before + 2); // the completed gather is counted once
});

test('disposing a project releases its death handler on a reusable bot', () => {
  const { EventEmitter } = require('node:events');
  const bot = new EventEmitter(); bot.entity = { position: new Vec3(17, 64, 3) };
  const foreign = () => {}; bot.on('death', foreign);
  const device = { name: 'fake', memory: {}, needs: () => [], isDone: () => false, progress: () => 0, run() {} };
  const home = { chest: { x: 0, y: 64, z: 0 }, centre: { x: 3, y: 64, z: 3 } };
  for (let i = 0; i < 15; i += 1) {
    const goal = createDeviceProjectGoal({ bot, name: 'build_fake', device, home });
    assert.equal(bot.listenerCount('death'), 2);
    goal.dispose(); goal.dispose();
    assert.deepEqual(bot.listeners('death'), [foreign]);
  }
});
