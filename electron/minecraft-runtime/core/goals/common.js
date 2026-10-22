'use strict';
// Shared by the smaller goals (farm, ranch): run one planner step (gather,
// craft, place a crafting table nearby) with the same failure handling the
// homestead uses, without a house to put the table in.

const { Vec3 } = require('vec3');
const { familyOf } = require('../knowledge');

const DOWN = [new Vec3(0, -1, 0)];

function createPlannerRunner({ bot, skills, kb, memory, blacklist, avoid = () => false }) {
  const blockAt = (p) => bot.blockAt(new Vec3(p.x, p.y, p.z));
  memory.shortfall = memory.shortfall || {};

  const tableHere = () => Boolean(memory.table) && blockAt(memory.table)?.name === 'crafting_table';

  async function placeTableNearby(ctx) {
    const here = bot.entity.position.floored();
    for (let r = 2; r <= 4; r += 1) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        const p = here.offset(dx, 0, dz);
        if (blockAt(p)?.name !== 'air' || blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block' || avoid(p)) continue;
        const placed = await skills.placeAt(bot, ctx, p, (n) => n === 'crafting_table', { faces: DOWN });
        if (placed.ok) memory.table = { x: p.x, y: p.y, z: p.z };
        return placed;
      }
    }
    return { ok: false, reason: 'no_table_spot' };
  }

  /** The inventory as the planner should see it: short items recently reported missing are discounted. */
  function inventoryFor(state) {
    const inventory = { ...state.inventory };
    for (const [family, s] of Object.entries(memory.shortfall)) {
      if (s.until < Date.now()) { delete memory.shortfall[family]; continue; }
      const name = Object.keys(inventory).find((n) => kb[family]?.match(n));
      if (name) inventory[name] = Math.max(0, inventory[name] - s.extra);
    }
    return inventory;
  }

  async function step(ctx, planned) {
    ctx.record('plan_step', { kind: planned.kind, key: planned.key, for: planned.for, item: planned.item });
    switch (planned.kind) {
      case 'gather': {
        const result = await skills.gatherOne(bot, ctx, { blocks: planned.blocks, dropMatch: kb[planned.key].match, blacklist, exclude: avoid });
        if (result.reason === 'no_target_in_range') return skills.explore(bot, ctx, memory);
        return result;
      }
      case 'craft': {
        const result = await skills.craft(bot, ctx, { item: planned.item, times: planned.times,
          tablePosition: planned.table ? memory.table : null });
        for (const m of result.missing || []) {
          const family = familyOf(m.name, kb);
          if (family) memory.shortfall[family] = { extra: m.short, until: Date.now() + 120000 };
        }
        return result;
      }
      case 'place_station':
        return planned.station === 'crafting_table' ? placeTableNearby(ctx) : { ok: false, reason: `no_station:${planned.station}` };
      default:
        return { ok: false, reason: `unplannable:${planned.key}:${planned.kind}` };
    }
  }

  return { step, inventoryFor, tableHere, placeTableNearby };
}

module.exports = { createPlannerRunner, DOWN };
