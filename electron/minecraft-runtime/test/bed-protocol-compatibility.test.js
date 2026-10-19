/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const minecraftData = require('minecraft-data');
const minecraftProtocol = require('minecraft-protocol');
const injectBed = require('mineflayer/lib/plugins/bed');
const { installMinecraftBedWakeCompatibility } = require('../protocolCompatibility');

function nativeBedBot(version = '1.21.8', mapper = true) {
  const bot = new EventEmitter();
  bot.version = version;
  bot.entity = { id: 17, metadata: { pose: 2, sleeping_pos: { x: 3, y: 64, z: 4 } } };
  bot.supportFeature = (name) => name === 'entityActionUsesStringMapper' && mapper;
  bot._client = new EventEmitter();
  const packets = [];
  bot._client.write = (name, params) => packets.push({ name, params });
  injectBed(bot);
  bot.emit('entitySleep', bot.entity);
  return { bot, packets };
}

function wireAction(packet) {
  const serializer = minecraftProtocol.createSerializer({ state: 'play', version: '1.21.8', isServer: false });
  const parser = minecraftProtocol.createDeserializer({ state: 'play', version: '1.21.8', isServer: true });
  const buffer = serializer.createPacketBuffer(packet);
  return { buffer, parsed: parser.parsePacketBuffer(buffer).data };
}

test('installed native wake encodes stop_sprinting; scoped replacement encodes the real leave_bed action', async () => {
  const originalSchema = JSON.stringify(minecraftData('1.21.8').protocol);
  const stock = nativeBedBot();
  await stock.bot.wake();
  const wrong = wireAction(stock.packets[0]);
  assert.equal(wrong.buffer.toString('hex'), '29110200');
  assert.equal(wrong.parsed.params.actionId, 'stop_sprinting');

  const fixed = nativeBedBot();
  assert.equal(installMinecraftBedWakeCompatibility(fixed.bot), true);
  await fixed.bot.wake();
  const correct = wireAction(fixed.packets[0]);
  assert.equal(correct.buffer.toString('hex'), '29110000');
  assert.equal(correct.parsed.params.actionId, 'leave_bed');
  assert.equal(correct.parsed.params.entityId, fixed.bot.entity.id);
  assert.equal(fixed.packets.length, 1);
  assert.equal(JSON.stringify(minecraftData('1.21.8').protocol), originalSchema);
});

test('wake does not fabricate waking, change metadata, or complete a real sleep-state transition', async () => {
  const { bot } = nativeBedBot();
  const metadata = bot.entity.metadata;
  let wakes = 0;
  bot.on('wake', () => { wakes += 1; });
  installMinecraftBedWakeCompatibility(bot);
  await bot.wake();
  assert.equal(bot.isSleeping, true, 'Only the native plugin server event may change this flag');
  assert.equal(bot.entity.metadata, metadata);
  assert.deepEqual(metadata, { pose: 2, sleeping_pos: { x: 3, y: 64, z: 4 } });
  assert.equal(wakes, 0);
  // Explicit offline server-event fixture: the installed bed plugin, rather
  // than our compatibility wrapper, owns this existing event transition.
  bot.emit('entityWake', bot.entity);
  assert.equal(bot.isSleeping, false);
  assert.equal(wakes, 1);
});

test('installation is idempotent and affects only the exact bot instance', async () => {
  const first = nativeBedBot();
  const second = nativeBedBot();
  const secondWake = second.bot.wake;
  installMinecraftBedWakeCompatibility(first.bot);
  const once = first.bot.wake;
  assert.equal(installMinecraftBedWakeCompatibility(first.bot), true);
  assert.equal(first.bot.wake, once);
  assert.equal(second.bot.wake, secondWake);
  await first.bot.wake();
  await second.bot.wake();
  assert.equal(wireAction(first.packets[0]).parsed.params.actionId, 'leave_bed');
  assert.equal(wireAction(second.packets[0]).parsed.params.actionId, 'stop_sprinting');
  await assert.rejects(first.bot.wake.call(second.bot), /another bot/);
  assert.equal(first.packets.length, 1);
  assert.equal(second.packets.length, 1);
});

test('awake calls reject without sending a packet', async () => {
  const { bot, packets } = nativeBedBot();
  installMinecraftBedWakeCompatibility(bot);
  bot.emit('entityWake', bot.entity);
  await assert.rejects(bot.wake(), /^Error: already awake$/);
  assert.equal(packets.length, 0);
});

test('unsupported versions, missing mapper support, and incomplete bots preserve their native wake', async () => {
  for (const [version, mapper] of [['1.21.5', false], ['1.21.6', true], ['1.21.9', true], ['1.21.8', false]]) {
    const { bot, packets } = nativeBedBot(version, mapper);
    const native = bot.wake;
    assert.equal(installMinecraftBedWakeCompatibility(bot), false);
    assert.equal(bot.wake, native);
    await bot.wake();
    assert.equal(packets[0].params.actionId, 2);
  }
  assert.equal(installMinecraftBedWakeCompatibility(null), false);
  assert.equal(installMinecraftBedWakeCompatibility({ version: '1.21.8' }), false);
});

test('auto-detection applies only after the full actual version and native bed plugin are ready', () => {
  const { bot } = nativeBedBot(false);
  const native = bot.wake;
  assert.equal(installMinecraftBedWakeCompatibility(bot), false);
  assert.equal(bot.wake, native);
  bot.version = '1.21.8';
  assert.equal(installMinecraftBedWakeCompatibility(bot), true);
  assert.notEqual(bot.wake, native);
  assert.equal(require('../runtime').installMinecraftBedWakeCompatibility, installMinecraftBedWakeCompatibility);
});
