'use strict';
// Goal: carry a list of items, gathered from nothing if need be, and wear the
// armour among them. What a player gets ready before a trip (the nether, the
// End): a full iron set, a bow and arrows, buckets, obsidian, eyes of ender.
//
// The gathering is deviceProject.js's: whatever the bag lacks is gathered
// into the home chest (gatherMaterials.js) and taken out again. The "device"
// here builds nothing; once everything is carried it puts the armour on.
// Food is the exception: put in the chest it is not there to eat, and a bot
// gathering iron for an hour starved with its meat stored at home. It is
// hunted last, straight into the bag (stockFood.js).

const { createDeviceProjectGoal } = require('./deviceProject');
const { createStockFoodGoal } = require('./stockFood');
const { KNOWLEDGE, countKey } = require('../knowledge');

// Tools and weapons stay in the bag as they are made: stored, the bot spent
// hours mining with stone picks and fighting bare-handed beside a chest
// holding its iron sword and pickaxe.
const CARRY = /(_sword|_pickaxe|_axe)$|^(shield|bow)$/;
const ARMOR_SLOTS = [['head', 5, /_helmet$/], ['torso', 6, /_chestplate$/], ['legs', 7, /_leggings$/], ['feet', 8, /_boots$/]];
const OFF_HAND = 45;
const RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const rank = (name) => RANK.indexOf(name.split('_')[0]);
const isAbort = (error) => error?.code === 'aborted';

/** The armour (and shield) in the bag that beats what is worn, as [item, slot] pairs. */
function upgrades(bot) {
  const out = [];
  for (const [slot, index, pattern] of ARMOR_SLOTS) {
    const worn = bot.inventory.slots[index];
    const best = bot.inventory.items().filter((i) => pattern.test(i.name)).sort((a, b) => rank(b.name) - rank(a.name))[0];
    if (best && (!worn || rank(worn.name) < rank(best.name))) out.push([best, slot]);
  }
  const shield = bot.inventory.items().find((i) => i.name === 'shield');
  if (shield && bot.inventory.slots[OFF_HAND]?.name !== 'shield') out.push([shield, 'off-hand']);
  return out;
}

function createKit({ bot, items, kb = KNOWLEDGE }) {
  const carried = (state, r) => Math.min(r.count, countKey(r.key, state.inventory, kb));
  const food = items.find((r) => r.key === 'food');
  const gathered = items.filter((r) => r !== food);
  const hunt = food ? createStockFoodGoal({ bot, target: food.count, kb }) : null;
  return {
    name: 'kit',
    // A device with no site: deviceProject walks to a site only while this is unset.
    memory: { device: { kind: 'kit' } },
    needs: () => gathered,
    isDone: (state) => items.every((r) => carried(state, r) >= r.count) && upgrades(bot).length === 0,
    progress: (state) => items.reduce((n, r) => n + carried(state, r), 0) + (upgrades(bot).length === 0 ? 1 : 0),
    async run(ctx) {
      for (const [item, slot] of upgrades(bot)) {
        try {
          await bot.equip(item, slot);
          ctx.record('equip', { item: item.name, slot });
        } catch (error) {
          if (isAbort(error)) throw error;
          return { ok: false, reason: 'equip_failed', item: item.name };
        }
      }
      if (hunt && !hunt.isDone(ctx.perceive())) return hunt.run(ctx);
      return { ok: true };
    },
  };
}

/** `items`: [{ key, count }] in the knowledge's keys; `home`: { chest, stations, centre } of the finished house. */
function createOutfitGoal({ bot, items, home, kb = KNOWLEDGE, ...rest } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('items must be a non-empty list');
  for (const r of items) {
    if (!kb[r?.key] || !Number.isSafeInteger(r.count) || r.count < 1) throw new TypeError(`bad item ${JSON.stringify(r)}`);
  }
  const device = createKit({ bot, items, kb });
  return createDeviceProjectGoal({ bot, name: 'outfit', device, home, kb, carry: (key) => CARRY.test(key), ...rest });
}

module.exports = { createOutfitGoal, upgrades };
