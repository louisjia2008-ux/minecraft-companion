'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { eat, goToDig, swimAshore } = require('../core/actions');
const { waitUntil, runCancellable } = require('../core/confirm');

// Fake bot whose server effects arrive as separate, delayed packets.
function fakeEatingBot({ foodPacketMs, inventoryPacketMs, consumeRejects = false, applies = true }) {
  const bot = new EventEmitter();
  let bread = 3;
  bot.food = 10;
  bot.registry = { foodsByName: { bread: { foodPoints: 5 } } };
  bot.inventory = { items: () => (bread > 0 ? [{ name: 'bread', count: bread }] : []) };
  bot.equip = async () => {};
  bot.deactivateItem = () => {};
  bot.consume = async () => {
    if (applies) {
      setTimeout(() => { bot.food = 15; }, foodPacketMs);
      setTimeout(() => { bread -= 1; }, inventoryPacketMs);
    }
    if (consumeRejects) throw new Error('Consuming cancelled due to timeout');
  };
  return { bot, breadCount: () => bread };
}

const ctx = () => ({ signal: new AbortController().signal });

test('eat waits for hunger AND inventory packets regardless of their order', async () => {
  for (const [foodPacketMs, inventoryPacketMs] of [[0, 43], [43, 0], [20, 20]]) {
    const { bot, breadCount } = fakeEatingBot({ foodPacketMs, inventoryPacketMs });
    const result = await eat(bot, ctx());
    assert.deepEqual(result, { ok: true, ate: 'bread' });
    assert.equal(breadCount(), 2);
  }
});

test('eat trusts observed state over a rejected consume()', async () => {
  const { bot } = fakeEatingBot({ foodPacketMs: 10, inventoryPacketMs: 30, consumeRejects: true });
  const result = await eat(bot, ctx());
  assert.equal(result.ok, true);
});

test('eat reports unconfirmed when the server never applied the meal', async () => {
  const { bot } = fakeEatingBot({ foodPacketMs: 0, inventoryPacketMs: 0, applies: false });
  const result = await eat(bot, ctx());
  assert.deepEqual(result, { ok: false, reason: 'eat_unconfirmed', ate: 'bread' });
});

test('eat refuses risky food unless starving', async () => {
  const bot = new EventEmitter();
  bot.food = 12;
  bot.registry = { foodsByName: { rotten_flesh: { foodPoints: 4 } } };
  bot.inventory = { items: () => [{ name: 'rotten_flesh', count: 2 }] };
  assert.deepEqual(await eat(bot, ctx()), { ok: false, reason: 'no_food' });
});

test('waitUntil times out false and rejects on abort', async () => {
  assert.equal(await waitUntil(() => false, { timeoutMs: 30 }), false);
  const controller = new AbortController();
  setTimeout(() => controller.abort('preempted'), 10);
  await assert.rejects(waitUntil(() => false, { timeoutMs: 1000, signal: controller.signal }), { code: 'aborted' });
});

test('runCancellable calls cancel and rejects on timeout', async () => {
  let cancelled = false;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const result = runCancellable(() => pending, { timeoutMs: 20, timeoutCode: 'dig_timeout',
    cancel: () => { cancelled = true; release(); } });
  await assert.rejects(result, { code: 'dig_timeout' });
  assert.equal(cancelled, true);
});


test('guarded dig path must select and physically land at an accepted stance', async () => {
  const bad = new Vec3(0, 64, 0);
  const safe = new Vec3(1, 64, 0);
  const block = { position: new Vec3(2, 64, 0), boundingBox: 'block' };
  const bot = {
    entity: { position: bad.offset(.5, 0, .5), onGround: true },
    world: { raycast: () => block },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
    pathfinder: { goto: async (goal) => {
      assert.equal(goal.isEnd(bad), false);
      assert.equal(goal.isEnd(safe), true);
    } },
  };
  const options = { acceptStand: (p) => p.equals(safe), retryNoProgress: false };
  assert.deepEqual(await goToDig(bot, ctx(), block, options), { ok: false, reason: 'not_arrived' });
  bot.entity.position = safe.offset(.5, .25, .5);
  bot.entity.onGround = false;
  setTimeout(() => {
    bot.entity.position = safe.offset(.5, 0, .5);
    bot.entity.onGround = true;
  }, 25);
  assert.deepEqual(await goToDig(bot, ctx(), block, options), { ok: true });
  assert.equal(bot.entity.onGround, true);

  const controller = new AbortController();
  bot.entity.onGround = false;
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(goToDig(bot, { signal: controller.signal }, block, options), { code: 'aborted' });
});

test('rejected native bed clicks release only their own sleep and message witnesses', async () => {
  const { useBed } = require('../core/skills');
  const bot = new EventEmitter();
  const position = new Vec3(1, 64, 1);
  const block = { name: 'white_bed', position };
  bot.game = { dimension: 'minecraft:overworld' };
  bot.entity = { position: new Vec3(1.5, 64, 2.5) };
  bot.blockAt = () => block;
  bot.sleep = () => assert.fail('sleep has no timeout listener cleanup in the pinned Mineflayer');
  const existing = () => {};
  bot.once('sleep', existing);
  bot.on('message', existing);
  let attempts = 0;
  bot.activateBlock = async (clicked) => {
    assert.equal(clicked, block);
    attempts += 1;
    bot.emit('message', { json: { translate: 'block.minecraft.bed.not_safe' } }, 'game_info');
  };

  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.deepEqual(await useBed(bot, ctx(), { position }), { ok: false, reason: 'bed_blocked',
      spawnSet: true, messages: ['block.minecraft.bed.not_safe'], refused: null });
    assert.deepEqual(bot.listeners('sleep'), [existing]);
    assert.deepEqual(bot.listeners('message'), [existing]);
  }
  assert.equal(attempts, 12);
});

test('native bed confirmation preserves a rapid sleep/wake and daytime spawn', async () => {
  const { useBed } = require('../core/skills');
  const bot = new EventEmitter();
  const position = new Vec3(1, 64, 1);
  bot.game = { dimension: 'overworld' };
  bot.entity = { position: new Vec3(1.5, 64, 2.5) };
  bot.blockAt = () => ({ name: 'white_bed', position });
  bot.activateBlock = async () => {
    bot.isSleeping = true;
    bot.emit('sleep');
    bot.isSleeping = false;
    bot.emit('wake');
  };
  assert.deepEqual(await useBed(bot, ctx(), { position }), { ok: true, slept: true, spawnSet: true, messages: [] });
  bot.activateBlock = async () => bot.emit('message', { translate: 'block.minecraft.bed.no_sleep' }, 'game_info');
  assert.deepEqual(await useBed(bot, ctx(), { position }), { ok: true, spawnSet: true, messages: ['block.minecraft.bed.no_sleep'] });
  assert.equal(bot.listenerCount('sleep'), 0);
  assert.equal(bot.listenerCount('message'), 0);
});

test('explicit shoreline control aims across one wet edge, stops on confirmed dry feet and clears movement', async () => {
  const feet = new Vec3(0, 62, 0), bank = new Vec3(0, 63, 1);
  const controls = {};
  let looks = 0;
  const bot = { entity: { position: feet.offset(.5, 0, .5), onGround: true, isInWater: true },
    blockAt: (p) => ({ name: p.equals(feet) ? 'seagrass' : 'air' }),
    setControlState(name, value) {
      controls[name] = value;
      if (name === 'jump' && value) {
        bot.entity.position = bank.offset(.5, 0, .5);
        bot.entity.isInWater = false;
      }
    },
    async lookAt(target) {
      looks += 1;
      assert.equal(target.x, bank.x + .5);
      assert.equal(target.z, bank.z + .5);
      assert.ok(target.y > feet.y);
    } };
  assert.equal(await swimAshore(bot, ctx(), { bank: bank.offset(0, 0, 1), acceptBank: () => true, maxTicks: 3 }), false);
  assert.equal(await swimAshore(bot, ctx(), { bank, acceptBank: (p) => p.equals(bank), maxTicks: 3 }), true);
  assert.equal(looks, 1);
  assert.deepEqual(controls, { sprint: false, forward: false, jump: false });
});
