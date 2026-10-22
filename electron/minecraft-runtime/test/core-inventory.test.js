'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const protocol = require('minecraft-protocol');
const { installInventoryCompatibility, withCursorConfirmation } = require('../core/inventory');
const { ownedItems, countInventory } = require('../core/perception');
const { planNext } = require('../core/planner');
const { craft } = require('../core/skills');

function nativeBot(version = '1.21.8') {
  const bot = new EventEmitter();
  bot.version = version;
  bot.registry = require('prismarine-registry')(version);
  bot.supportFeature = bot.registry.supportFeature;
  bot._client = new EventEmitter();
  bot._client.write = () => {};
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true });
  require('mineflayer/lib/plugins/craft')(bot);
  const Item = require('prismarine-item')(bot.registry);
  const stack = (name, count) => new Item(bot.registry.itemsByName[name].id, count);
  const packet = (slotId, name, count) => ({ slotId, contents: Item.toNotch(name ? stack(name, count) : null) });
  bot.entity = { position: new Vec3(0.5, 64, 0.5) };
  bot.blockAt = (position) => ({ name: 'crafting_table', position });
  return { bot, stack, packet };
}

function wirePacket(packet, name = 'set_player_inventory') {
  const serializer = protocol.createSerializer({ state: 'play', version: '1.21.8', isServer: true });
  const parser = protocol.createDeserializer({ state: 'play', version: '1.21.8', isServer: false });
  return parser.parsePacketBuffer(serializer.createPacketBuffer({ name, params: packet })).data.params;
}

const counts = (bot) => countInventory(ownedItems(bot));
const context = () => ({ signal: new AbortController().signal });

test('real packet coordinates reproduce phantom boots and clear/reconnect failure in the native plugin', () => {
  const stock = nativeBot();
  stock.bot._client.emit('set_player_inventory', wirePacket(stock.packet(8, 'birch_planks', 16)));
  assert.equal(stock.bot.inventory.slots[8].name, 'birch_planks');
  stock.bot._client.emit('set_slot', { windowId: 0, slot: 44, item: stock.packet(8, 'birch_planks', 5).contents });
  assert.equal(counts(stock.bot).birch_planks, 21);
  stock.bot._client.emit('set_slot', { windowId: 0, slot: 44, item: stock.packet(8, null).contents });
  assert.deepEqual(countInventory(stock.bot.inventory.items()), {});
  assert.equal(counts(stock.bot).birch_planks, 16);
  assert.equal(planNext({ inventory: counts(stock.bot), requirements: [{ key: 'stone_sword', count: 1 }] }).item, 'stick');
  assert.deepEqual(counts(nativeBot().bot), {});
});

test('compatibility maps every player slot without phantom armor or lost offhand equipment', () => {
  const { bot, packet } = nativeBot();
  installInventoryCompatibility(bot);
  const expected = [...Array.from({ length: 9 }, (_, i) => i + 36),
    ...Array.from({ length: 27 }, (_, i) => i + 9), 8, 7, 6, 5, 45];
  for (let raw = 0; raw <= 40; raw++) {
    bot._client.emit('set_player_inventory', wirePacket(packet(raw, 'shield', 1)));
    assert.equal(bot.inventory.slots[expected[raw]]?.name, 'shield', `wire slot ${raw}`);
    bot._client.emit('set_player_inventory', wirePacket(packet(raw, null)));
    assert.equal(bot.inventory.slots[expected[raw]], null);
  }
  assert.deepEqual(counts(bot), {});
});

test('five real planks plan more planks; clearing a reused bot plans logs just like a fresh bot', () => {
  const { bot, packet } = nativeBot();
  installInventoryCompatibility(bot);
  bot._client.emit('set_player_inventory', wirePacket(packet(8, 'birch_planks', 16)));
  bot._client.emit('set_slot', { windowId: 0, slot: 44, item: packet(8, 'birch_planks', 5).contents });
  bot._client.emit('set_slot', { windowId: 0, slot: 37, item: packet(1, 'birch_log', 2).contents });
  const chest = planNext({ inventory: counts(bot), requirements: [{ key: 'chest', count: 1 }], stations: { crafting_table: true } });
  assert.equal(chest.item, 'birch_planks');
  for (const slot of [37, 44]) bot._client.emit('set_slot', { windowId: 0, slot, item: packet(0, null).contents });
  assert.deepEqual(counts(bot), {});
  const step = planNext({ inventory: counts(bot), requirements: [{ key: 'stone_sword', count: 1 }] });
  assert.deepEqual([step.kind, step.key], ['gather', 'log']);
});

test('closing confirmation applies real cursor packets and removes its listeners afterward', async () => {
  const { bot, stack, packet } = nativeBot();
  bot.inventory.selectedItem = stack('birch_log', 1);
  const empty = wirePacket({ contents: packet(0, null).contents }, 'set_cursor_item');
  bot._client.emit('set_cursor_item', empty);
  assert.equal(bot.inventory.selectedItem.name, 'birch_log');
  installInventoryCompatibility(bot);
  await withCursorConfirmation(bot, async () => bot._client.emit('set_cursor_item', empty));
  assert.equal(bot.inventory.selectedItem, null);
  await withCursorConfirmation(bot, async () => {
    bot._client.emit('set_cursor_item', wirePacket({ contents: packet(0, 'birch_planks', 3).contents }, 'set_cursor_item'));
  });
  assert.equal(bot.inventory.selectedItem.name, 'birch_planks');
  assert.equal(bot.inventory.selectedItem.count, 3);
  assert.equal(bot._client.listenerCount('set_cursor_item'), 0);
});

test('cursor confirmation accepts closing snapshots without replaying old cursor state during normal equip', async () => {
  const { bot, stack, packet } = nativeBot();
  installInventoryCompatibility(bot);
  bot.inventory.selectedItem = stack('birch_log', 1);
  await withCursorConfirmation(bot, async () => {
    bot._client.emit('window_items', { windowId: 0, stateId: 1, items: [], carriedItem: packet(0, null).contents });
  });
  assert.equal(bot.inventory.selectedItem, null);
  // A delayed first-click snapshot after moveSlotItem's second predicted
  // click must not put the already-equipped pickaxe back on the cursor.
  bot._client.emit('window_items', { windowId: 0, stateId: 2, items: [], carriedItem: packet(0, 'stone_pickaxe', 1).contents });
  bot._client.emit('set_cursor_item', { contents: packet(0, 'stone_pickaxe', 1).contents });
  assert.equal(bot.inventory.selectedItem, null);
  bot._client.emit('window_items', { windowId: 8, stateId: 3, items: [], carriedItem: packet(0, null).contents });
  assert.equal(bot.inventory.selectedItem, null);
  assert.equal(bot._client.listenerCount('window_items'), 2, 'only the native stateId and slot listeners remain');
});

test('installation is per bot and idempotent, preserves wire objects/other packets, and releases its hook at end', () => {
  const { bot, packet } = nativeBot();
  const other = nativeBot().bot;
  const emit = bot._client.emit;
  assert.equal(installInventoryCompatibility(bot), true);
  const wrapped = bot._client.emit;
  for (let n = 0; n < 10; n++) assert.equal(installInventoryCompatibility(bot), true);
  assert.equal(bot._client.emit, wrapped);
  assert.equal(bot.listenerCount('end'), 1);
  const p = packet(8, 'birch_planks', 5);
  bot._client.emit('set_player_inventory', p);
  assert.equal(p.slotId, 8);
  assert.equal(bot.inventory.slots[8], null);
  assert.equal(other._client.emit, emit);
  bot._client.emit('set_slot', { windowId: 0, slot: 8, item: packet(0, 'iron_boots', 1).contents });
  assert.equal(bot.inventory.slots[8].name, 'iron_boots');
  bot.emit('end');
  assert.equal(bot._client.emit, emit);
  assert.equal(bot.listenerCount('end'), 0);
  assert.equal(installInventoryCompatibility(nativeBot('1.21.5').bot), false);
  assert.equal(installInventoryCompatibility({ version: '1.21.8' }), false);
});

test('missing recipe inputs use only craftable main inventory, even if an equipment slot holds a ghost stack', async () => {
  const { bot, stack } = nativeBot();
  bot.inventory.updateSlot(44, stack('birch_planks', 5));
  bot.inventory.updateSlot(8, stack('birch_planks', 16));
  const events = [];
  const result = await craft(bot, { ...context(), record: (type, data) => events.push({ type, ...data }) },
    { item: 'chest', tablePosition: { x: 2, y: 64, z: 0 } });
  assert.deepEqual(result, { ok: false, reason: 'missing_ingredients', missing: [{ name: 'birch_planks', short: 3 }] });
  assert.deepEqual(events[0].inventory, { birch_planks: 5 });
});

test('preemption waits for the in-flight click, stops later clicks, and closes the original crafting window once', async () => {
  const { bot, stack } = nativeBot();
  const windows = require('prismarine-windows')(bot.version);
  const window = windows.createWindow(7, 'minecraft:crafting', 'Crafting');
  bot.inventory.updateSlot(44, stack('birch_planks', 16));
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let clicks = 0;
  let closes = 0;
  const click = bot.clickWindow = async () => { clicks++; entered(); await gate; };
  const close = bot.closeWindow = (target) => { assert.equal(target, window); closes++; bot.currentWindow = null; };
  bot.craft = async () => {
    bot.currentWindow = window;
    try {
      await bot.clickWindow(45, 0, 0);
      await bot.clickWindow(1, 1, 0);
    } finally {
      bot.closeWindow(window);
      bot.closeWindow(window); // A late native close must not copy stale slots.
    }
  };
  const pending = craft(bot, { signal: controller.signal }, { item: 'chest', tablePosition: { x: 2, y: 64, z: 0 } });
  await started;
  controller.abort('test_preemption');
  assert.equal(bot.currentWindow, window);
  assert.equal(closes, 0);
  release();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(clicks, 1);
  assert.equal(closes, 1);
  assert.equal(bot.clickWindow, click);
  assert.equal(bot.closeWindow, close);
  assert.deepEqual(counts(bot), { birch_planks: 16 });
});

test('an aborted 2x2 recipe still returns grid/cursor contents before the next behavior can plan', async () => {
  const { bot, stack } = nativeBot();
  bot.inventory.updateSlot(44, stack('birch_log', 1));
  const controller = new AbortController();
  bot.craft = async () => {
    bot.inventory.updateSlot(44, null);
    bot.inventory.updateSlot(1, stack('birch_log', 1));
    bot.inventory.selectedItem = stack('birch_log', 1);
    controller.abort('test_preemption');
    await bot.clickWindow(1, 0, 0);
  };
  let returned = false;
  bot.closeWindow = () => {
    setTimeout(() => {
      bot.inventory.updateSlot(1, null);
      bot.inventory.selectedItem = null;
      bot.inventory.updateSlot(44, stack('birch_log', 1));
      returned = true;
    }, 40);
  };
  await assert.rejects(craft(bot, { signal: controller.signal }, { item: 'birch_planks' }), { code: 'aborted' });
  assert.equal(returned, true);
  assert.deepEqual(counts(bot), { birch_log: 1 });
});

test('an unconfirmed dirty crafting grid prevents starting another recipe', async () => {
  const { bot, stack } = nativeBot();
  bot.inventory.updateSlot(1, stack('birch_log', 1));
  bot.closeWindow = () => {};
  bot.craft = () => assert.fail('must not craft over unreturned ingredients');
  assert.deepEqual(await craft(bot, context(), { item: 'birch_planks' }), { ok: false, reason: 'crafting_grid_unconfirmed' });
});

test('disposing companions on a reused bot releases old survival death listeners', async () => {
  const { bot } = nativeBot();
  bot.pathfinder = { setMovements() {}, setGoal() {} };
  bot.clearControlStates = () => {};
  const { createCompanion } = require('../core/companion');
  for (let n = 0; n < 10; n++) {
    const companion = createCompanion({ bot });
    assert.equal(bot.listenerCount('death'), 3);
    await companion.dispose();
    assert.equal(bot.listenerCount('death'), 0);
    assert.equal(bot.listenerCount('end'), 1);
  }
});
