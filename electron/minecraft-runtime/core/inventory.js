'use strict';
// Mineflayer 4.37.1 treats set_player_inventory's player-inventory index as
// an InventoryMenu index. Vanilla 1.21.8 sends this packet when closing a
// crafting grid returns its ingredients. Hotbar slot 8 otherwise becomes a
// phantom stack in the boots slot, surviving /clear and poisoning later goals.

const mineflayerVersion = require('mineflayer/package.json').version;
const installed = new WeakSet();

function affected(bot) {
  return bot?.version === '1.21.8' && mineflayerVersion === '4.37.1'
    && bot.registry && typeof bot._client?.emit === 'function' && typeof bot._setSlot === 'function';
}

function inventoryMenuSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 40) return null;
  if (slot < 9) return slot + 36;
  if (slot < 36) return slot;
  if (slot < 40) return 44 - slot;
  return 45;
}

function installInventoryCompatibility(bot) {
  if (!affected(bot)) return false;
  if (installed.has(bot)) return true;
  const client = bot._client;
  const emit = client.emit;
  // Normalize an owned copy before the pinned native inventory listener runs.
  // The decoder's original packet (including the generic `packet` event) stays
  // in wire coordinates. Ordinary set_slot/window_items are already menu slots.
  function compatibleEmit(name, ...args) {
    if (this === client && name === 'set_player_inventory') {
      const slot = inventoryMenuSlot(args[0]?.slotId);
      if (slot !== null) args[0] = { ...args[0], slotId: slot };
    }
    return emit.call(this, name, ...args);
  }
  client.emit = compatibleEmit;
  installed.add(bot);
  bot.once('end', () => {
    if (client.emit === compatibleEmit) client.emit = emit;
    installed.delete(bot);
  });
  return true;
}

async function withCursorConfirmation(bot, run) {
  if (!affected(bot)) return run();
  const Item = require('prismarine-item')(bot.registry);
  // Only reconcile while returning crafting leftovers, with native clicks
  // already settled. During ordinary equip/click sequences, delayed server
  // snapshots can precede later predicted clicks; applying them mid-sequence
  // would resurrect a cursor stack that a later click has already put away.
  const onCursor = (packet) => {
    if (!bot.currentWindow) bot.inventory.selectedItem = Item.fromNotch(packet.contents);
  };
  const onItems = (packet) => {
    if (!bot.currentWindow && packet.windowId === 0 && 'carriedItem' in packet) {
      bot.inventory.selectedItem = Item.fromNotch(packet.carriedItem);
    }
  };
  bot._client.on('set_cursor_item', onCursor);
  bot._client.on('window_items', onItems);
  try { return await run(); } finally {
    bot._client.removeListener('set_cursor_item', onCursor);
    bot._client.removeListener('window_items', onItems);
  }
}

module.exports = { installInventoryCompatibility, withCursorConfirmation };
