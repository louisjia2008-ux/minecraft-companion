/* global require */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registry = require('prismarine-registry')('1.21.8');
const injectEntities = require('mineflayer/lib/plugins/entities');
const Entity = require('prismarine-entity')('1.21.8');
const { readHouseBotOxygen } = require('../vendor/server/minecraft/houseBotOxygen');

function nativeFixture() {
  const client = Object.assign(new EventEmitter(), { username: 'OwnAir', write() {} });
  const bot = Object.assign(new EventEmitter(), { version: '1.21.8', registry, _client: client,
    supportFeature: name => registry.supportFeature(name) });
  injectEntities(bot);
  client.emit('login', { entityId: 1 });
  const rabbit = new Entity(2); rabbit.name = 'rabbit'; bot.entities[2] = rabbit;
  const metadata = (id, raw) => client.emit('entity_metadata', { entityId: id,
    metadata: [{ key: registry.entitiesByName[id === 1 ? 'player' : 'rabbit'].metadataKeys.indexOf('air_supply'), type: 'varint', value: raw }] });
  return { bot, metadata };
}

test('installed entities plugin contaminates global oxygen with another entity; unknown own air remains UNKNOWN', () => {
  const f = nativeFixture(); f.metadata(2, 135);
  assert.equal(f.bot.oxygenLevel, 9, 'The actual upstream plugin reproduces the whole03 failure trigger');
  assert.deepEqual(readHouseBotOxygen(f.bot), { entityId: 1, rawAirSupply: null, oxygenLevel: null, source: 'own_entity_metadata_unknown' });
});

test('another entity cannot lower or replenish the player own observed air', () => {
  const f = nativeFixture(); f.metadata(1, 300); f.metadata(2, 135);
  assert.equal(f.bot.oxygenLevel, 9); assert.equal(readHouseBotOxygen(f.bot).oxygenLevel, 20);
  f.metadata(1, 255); f.metadata(2, 300);
  assert.equal(f.bot.oxygenLevel, 20); assert.equal(readHouseBotOxygen(f.bot).oxygenLevel, 17);
  assert.equal(readHouseBotOxygen(f.bot).rawAirSupply, 255);
});

test('own raw air keeps the native 15 ticks per displayed oxygen unit and validates missing/malformed metadata', () => {
  const f = nativeFixture();
  for (const [raw, level] of [[300,20],[285,19],[270,18],[255,17],[0,0],[-20,-1]]) {
    f.metadata(1, raw); assert.equal(readHouseBotOxygen(f.bot).oxygenLevel, level);
  }
  for (const raw of [undefined, NaN, '300', 301, -21]) {
    f.bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')] = raw;
    assert.equal(readHouseBotOxygen(f.bot).oxygenLevel, null);
  }
});
