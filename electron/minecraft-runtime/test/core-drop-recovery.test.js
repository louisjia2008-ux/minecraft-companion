'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

function fixture(version = '1.21.8') {
  const slots = new Array(46).fill(null);
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(), version, isAlive: true,
    entity: { id: 5, position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' },
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean) },
    registry: { foodsByName: {} }, blockAt: () => ({ name: 'air' }),
  });
  const state = { alive: true, health: 20, food: 20, inventory: {}, hostiles: [],
    sheltered: false, position: new Vec3(10, 64, 0) };
  const recover = createSurvivalBehaviors({ bot }).find((behavior) => behavior.name === 'recover_drops');
  const finishDeath = () => {
    bot.isAlive = false;
    bot.emit('death');
    bot.isAlive = true;
    bot.emit('spawn');
    return recover.want(state);
  };
  return { bot, slots, recover, finishDeath };
}

test('an empty verified 1.21.8 death skips a return for drops and releases its packet listener', () => {
  const { bot, recover, finishDeath } = fixture();
  assert.equal(bot._client.listenerCount('death_combat_event'), 1);
  bot._client.emit('death_combat_event', { playerId: bot.entity.id });
  assert.equal(finishDeath(), 0);
  recover.dispose();
  assert.equal(bot._client.listenerCount('death_combat_event'), 0);
});

test('cleared slots at the later death event cannot hide previously carried, worn, or off-hand equipment', () => {
  for (const slot of [36, 6, 45]) {
    const { bot, slots, recover, finishDeath } = fixture();
    slots[slot] = { name: 'iron_gear', count: 1 };
    bot._client.emit('death_combat_event', { playerId: bot.entity.id });
    slots[slot] = null;
    assert.ok(finishDeath() > 0, `item in slot ${slot} might have dropped`);
    recover.dispose();
  }
});

test('unknown, foreign-player and prior-life snapshots keep the existing drop policy', () => {
  const foreign = fixture();
  foreign.bot._client.emit('death_combat_event', { playerId: 6 });
  assert.ok(foreign.finishDeath() > 0);

  const stale = fixture();
  stale.bot._client.emit('death_combat_event', { playerId: stale.bot.entity.id });
  stale.bot.emit('spawn');
  assert.ok(stale.finishDeath() > 0);

  const partial = fixture();
  delete partial.slots[6];
  partial.bot._client.emit('death_combat_event', { playerId: partial.bot.entity.id });
  assert.ok(partial.finishDeath() > 0);

  const other = fixture('1.21.7');
  other.bot._client.emit('death_combat_event', { playerId: other.bot.entity.id });
  assert.ok(other.finishDeath() > 0);
  for (const { recover } of [foreign, stale, partial, other]) recover.dispose();
});
