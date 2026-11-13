'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { eat, goToDig } = require('../core/actions');
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
