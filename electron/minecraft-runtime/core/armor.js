'use strict';
// Armour (and a shield) in the bag that beats what is worn: what to put on.

const ARMOR_SLOTS = [['head', 5, /_helmet$/], ['torso', 6, /_chestplate$/], ['legs', 7, /_leggings$/], ['feet', 8, /_boots$/]];
const OFF_HAND = 45;
const RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const rank = (name) => RANK.indexOf(name.split('_')[0]);

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

module.exports = { upgrades };
