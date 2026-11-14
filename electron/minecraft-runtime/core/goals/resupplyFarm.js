'use strict';

const { Vec3 } = require('vec3');
const { posKey } = require('../blacklist');
const { standable } = require('../caveRetreat');
const { plotState } = require('../farming');

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const CUBE = [0, 0, 0, 1, 1, 1];
const SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt']);
const RIM_BLOCK = /^(cobblestone|cobbled_deepslate|dirt|stone|netherrack)$/;
const air = (b) => b?.name === 'air' || b?.name === 'cave_air';
const full = (b) => b?.shapes?.length === 1 && b.shapes[0].length === CUBE.length
  && b.shapes[0].every((n, i) => n === CUBE[i]) && b.getProperties?.()?.waterlogged !== true
  && !/^(magma_block|sand|red_sand|gravel|.*_concrete_powder)$/.test(b.name);
const within = (water, plot) => water.y >= plot.y && water.y <= plot.y + 1
  && Math.max(Math.abs(water.x - plot.x), Math.abs(water.z - plot.z)) <= 4;

function createResupplyIrrigation({ bot, actions, skills, centre, anchor }) {
  const home = new Vec3(centre.x, centre.y, centre.z);
  const attempted = new Set();
  const read = (p) => bot.blockAt(p);
  const items = () => bot.inventory?.items?.() || [];
  const carryWater = () => items().some((item) => item.name === 'water_bucket');
  const house = (p) => anchor && p.x >= anchor.x && p.x < anchor.x + 7 && p.z >= anchor.z && p.z < anchor.z + 7;
  const protectedSite = (p, b) => house(p) || bot.companionHomeSite?.(p) || bot.companionProtectBlock?.(b);
  const sides = (p) => SIDES.map(([x, z]) => p.offset(x, 0, z));
  const basin = (p) => !protectedSite(p, read(p)) && air(read(p.offset(0, 1, 0))) && air(read(p.offset(0, 2, 0)))
    && full(read(p.offset(0, -1, 0)));
  const sealed = (p) => basin(p) && sides(p).every((q) => full(read(q)));
  const drySoil = (block) => SOIL.has(block?.name) && !bot.companionProtectBlock?.(block);

  function missingRim(p) {
    const missing = sides(p).filter((q) => !full(read(q)));
    if (missing.length !== 1 || !items().some((item) => RIM_BLOCK.test(item.name))) return null;
    const gap = missing[0];
    if (!air(read(gap)) || protectedSite(gap, read(gap))) return null;
    const faces = sides(gap).filter((q) => !q.equals(p) && full(read(q))).map((q) => q.minus(gap));
    return faces.length ? { gap, faces } : null;
  }

  function plan(plots) {
    if (!carryWater()) return null;
    const growing = plots.map((p) => new Vec3(p.x, p.y, p.z)).filter((p) => plotState(bot, p) === 'growing'
      && Number(read(p).getProperties?.()?.moisture) === 0);
    if (!growing.length) return null;
    const known = new Set();
    let nearest = null;
    for (const plot of growing) {
      for (let x = -4; x <= 4; x += 1) for (let z = -4; z <= 4; z += 1) {
        const p = plot.offset(x, 0, z);
        const key = posKey(p);
        if (known.has(key) || attempted.has(key)) continue;
        known.add(key);
        const distance = p.distanceTo(home);
        const block = read(p);
        if (!basin(p) || !(air(block) || drySoil(block))) continue;
        const coverage = growing.filter((crop) => within(p, crop)).length;
        const closed = sealed(p);
        if (!closed && !(air(block) && missingRim(p))) continue;
        if (nearest && (coverage < nearest.coverage
          || coverage === nearest.coverage && (nearest.closed && !closed || nearest.closed === closed && distance >= nearest.distance))) continue;
        nearest = { position: p, coverage, closed, distance };
      }
    }
    return nearest?.position || null;
  }

  async function run(ctx, p) {
    const fail = (reason) => ({ ok: false, reason });
    attempted.add(posKey(p));
    if (!carryWater() || !basin(p)) return fail('resupply_basin_changed');
    const current = read(p);
    if (!sealed(p)) {
      const rim = air(current) && missingRim(p);
      if (!rim) return fail('resupply_basin_changed');
      const placed = await skills.placeAt(bot, ctx, rim.gap, (name) => RIM_BLOCK.test(name), { faces: rim.faces });
      if (!placed.ok || !sealed(p)) return fail(placed.reason || 'resupply_basin_not_sealed');
      ctx.record('resupply_farm_rim', { position: rim.gap, basin: p });
    }
    if (!air(current)) {
      if (!drySoil(current)) return fail('resupply_basin_changed');
      const rim = SIDES.map(([x, z]) => p.offset(x, 1, z))
        .filter((stand) => standable(read, stand))
        .sort((a, b) => a.distanceTo(home) - b.distanceTo(home))[0];
      if (!rim) return fail('resupply_basin_no_rim');
      const moved = await actions.goNear(bot, ctx, rim.offset(.5, 0, .5), 0, { timeoutMs: 15000 });
      if (!moved.ok || !bot.entity.position.floored().equals(rim) || !bot.entity.onGround || !sealed(p)) {
        return fail(moved.reason || 'resupply_basin_no_rim');
      }
      const block = read(p);
      if (!drySoil(block)) return fail('resupply_basin_changed');
      const dug = await actions.digBlock(bot, ctx, block);
      if (!dug.ok) return dug;
    }
    if (!sealed(p) || !air(read(p))) return fail('resupply_basin_changed');
    const result = await skills.pourLiquid(bot, ctx, p, 'water');
    if (result.ok) ctx.record('resupply_farm_water', { position: p });
    return result;
  }

  return { plan, run };
}

module.exports = { createResupplyIrrigation };
