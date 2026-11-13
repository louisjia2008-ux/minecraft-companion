'use strict';

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { posKey } = require('../blacklist');
const { standable } = require('../caveRetreat');
const { inspectStep, DIRS, pickFor } = require('../mining');
const { waitUntil } = require('../confirm');

const DEPTH = 5;
const COVER = /^(stone|cobblestone|deepslate|cobbled_deepslate|andesite|granite|diorite|dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|snow_block|tuff|calcite|clay|moss_block|[a-z_]+_ore)$/;
const RISK = /^(water|lava|bubble_column|fire|soul_fire|magma_block|cactus|powder_snow|sweet_berry_bush|campfire|soul_campfire|sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const AIR = { name: 'air', boundingBox: 'empty', shapes: [] };
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const fail = (reason) => ({ ok: false, reason });
const vec = (p) => new Vec3(p.x, p.y, p.z);
const key = (origin, direction) => `${posKey(origin)}:${direction}`;
const dry = (block) => block && !RISK.test(block.name) && block.getProperties?.()?.waterlogged !== true;
const open = (block) => dry(block) && block.boundingBox === 'empty' && !block.shapes?.length;

function createStoneQuarry({ bot, actions, avoid, blacklist }) {
  const read = (p) => bot.blockAt(p);
  let site = null;

  function geometry(from, direction, active, projected = read) {
    const check = inspectStep((x, y, z) => projected(new Vec3(x, y, z)), from, direction,
      { descend: true, surfaceY: active.entry.y - 1, known: (p) => active.open.has(posKey(p)) });
    if (!check.ok) return null;
    const target = vec(check.target);
    // A descending stair has three swept cells. Once more than two levels
    // below the entry, explicitly remove the loaded natural lip up to its
    // original surface too, so the shallow quarry never becomes a tunnel.
    const cuts = check.dig.map(vec);
    const lip = [];
    for (let y = active.entry.y - 1; y > target.y + 2; y -= 1) {
      const p = new Vec3(target.x, y, target.z);
      if (!open(projected(p))) lip.push(p);
    }
    cuts.unshift(...lip);
    if (avoid(target) || cuts.some((p) => avoid(p) || active.floors.has(posKey(p)))) return null;
    for (const p of cuts) {
      const block = projected(p);
      if (!dry(block) || !COVER.test(block.name) || block.diggable !== true || bot.companionProtectBlock?.(block)
        || !FACES.every(([x, y, z]) => {
          const near = p.offset(x, y, z);
          const next = projected(near);
          return dry(next) && (near.y >= active.entry.y - 1 || !open(next) || active.open.has(posKey(near)));
        })) return null;
    }
    const after = (p) => cuts.some((cut) => cut.equals(p)) ? AIR : projected(p);
    if (!standable(after, target)) return null;
    // Keep the whole cut open above its headroom, rather than creating a
    // covered tunnel when terrain rises ahead of the stair.
    for (let y = target.y + 2; y <= Math.max(active.entry.y, target.y) + 12; y += 1) {
      const block = after(new Vec3(target.x, y, target.z));
      if (!open(block) && !(dry(block) && block.name.endsWith('_leaves'))) return null;
    }
    return { target, cuts };
  }

  function plan(origin, direction, match, limit) {
    const opened = new Set();
    const floors = new Set([posKey(origin.offset(0, -1, 0))]);
    const active = { entry: origin, open: opened, floors };
    const projected = (p) => opened.has(posKey(p)) ? AIR : read(p);
    let from = origin;
    let cost = 0;
    for (let index = 0; index < DEPTH; index += 1) {
      const next = geometry(from, direction, active, projected);
      if (!next || next.target.y < limit) break;
      const found = next.cuts.some((p) => match(projected(p)?.name));
      for (const p of next.cuts) opened.add(posKey(p));
      cost += next.cuts.length;
      if (found) return cost;
      floors.add(posKey(next.target.offset(0, -1, 0)));
      from = next.target;
    }
    return null;
  }

  function findSite(surface, match) {
    const here = bot.entity.position.floored();
    let selected = null;
    let previousRadius = -1;
    for (const radius of [3, 6, 10, 15, 22]) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) <= previousRadius) continue;
          for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
            const entry = here.offset(dx, dy, dz);
            if (avoid(entry) || !surface.isStand(entry)) continue;
            for (let direction = 0; direction < DIRS.length; direction += 1) {
              if (blacklist.has(`quarry:${key(entry, direction)}`)) continue;
              const cost = plan(entry, direction, match, surface.floor);
              if (cost === null) continue;
              const score = cost + entry.distanceTo(here) * .4;
              if (!selected || score < selected.score) selected = { entry, direction, score };
            }
          }
        }
      }
      if (selected) break;
      previousRadius = radius;
    }
    if (!selected) return null;
    return { ...selected, route: [selected.entry], open: new Set(), floors: new Set([posKey(selected.entry.offset(0, -1, 0))]),
      closed: false, pendingDrops: [] };
  }

  function sideStone(from, active, match) {
    const [dx, dz] = DIRS[active.direction];
    for (const lateral of [1, -1]) {
      const edge = from.offset(-dz * lateral, 0, dx * lateral);
      const head = edge.offset(0, 1, 0);
      const block = read(edge);
      if (!match(block?.name) || !pickFor(bot, block)) continue;
      const cuts = [head, edge].filter((p) => !open(read(p)));
      if (cuts.some((p) => {
        const current = read(p);
        return avoid(p) || active.floors.has(posKey(p)) || !dry(current) || !COVER.test(current.name)
          || current.diggable !== true || bot.companionProtectBlock?.(current)
          || !FACES.every(([x, y, z]) => {
            const near = p.offset(x, y, z);
            const b = read(near);
            return dry(b) && (near.y >= active.entry.y - 1 || !open(b) || active.open.has(posKey(near)));
          });
      })) continue;
      if (!standable((p) => cuts.some((cut) => cut.equals(p)) ? AIR : read(p), edge)) continue;
      return { cut: cuts[0], stand: edge };
    }
    return null;
  }

  const here = () => bot.entity.position.floored();
  const landed = (p) => bot.entity.onGround && here().equals(p) && standable(read, p);
  async function move(ctx, target, surface, exactEdge = false) {
    if (!standable(read, target)) return fail('quarry_route_changed');
    const current = here();
    if (exactEdge && (Math.abs(current.x - target.x) + Math.abs(current.z - target.z) !== 1
      || Math.abs(current.y - target.y) > 1 || !standable(read, current)
      || !open(read((target.y > current.y ? current : target).offset(0, 2, 0))))) return fail('quarry_route_changed');
    const result = await surface.walk(() => actions.goTo(bot, ctx, new goals.GoalBlock(target.x, target.y, target.z),
      { timeoutMs: exactEdge ? 7000 : 30000, retryNoProgress: false }),
    exactEdge ? (p) => p.equals(target) && standable(read, p) : () => true);
    if (result.ok) await waitUntil(() => landed(target), { timeoutMs: 600, signal: ctx.signal });
    return landed(target) ? { ok: true } : fail(result.ok ? 'quarry_arrival_unconfirmed' : result.reason);
  }

  async function collect(ctx, from, pending, surface, dropMatch) {
    const step = pending.stand;
    const side = !step.equals(from) && standable(read, step)
      && Math.abs(step.x - from.x) + Math.abs(step.z - from.z) === 1 && step.y === from.y;
    if (side && !site.route.some((p) => p.equals(step))) {
      // A newly opened side pocket is a temporary leg. Remember its route
      // back before moving so a survival interruption cannot strand us.
      const index = site.route.findIndex((p) => p.equals(from));
      site.pocket = { at: step, from: site.route[index] };
    }
    return surface.walk(() => actions.collectDrops(bot, ctx, pending.position.offset(.5, .5, .5), dropMatch,
      { radius: 2, timeoutMs: 2500 }), (p) => p.equals(from) || side && p.equals(step));
  }

  async function leave(ctx, surface) {
    if (!site) return null;
    if (site.pocket?.at.equals(here())) {
      const result = await move(ctx, site.pocket.from, surface, true);
      if (result.ok) ctx.record('quarry_exit', { position: site.pocket.from });
      return result;
    }
    site.pocket = null;
    const index = site.route.findIndex((p) => p.equals(here()));
    if (index <= 0) return null;
    const to = site.route[index - 1];
    const result = await move(ctx, to, surface, true);
    if (result.ok) ctx.record('quarry_exit', { position: to });
    return result;
  }

  function abandon(ctx, reason) {
    ctx.record('quarry_blocked', { entry: site.entry, reason });
    blacklist.add(`quarry:${key(site.entry, site.direction)}`, reason);
    site.closed = true;
    return fail(reason);
  }

  async function run(ctx, surface, match, dropMatch) {
    if (site?.closed) {
      const exited = await leave(ctx, surface);
      if (exited) return exited;
      site = null;
    }
    if (!site) {
      site = findSite(surface, match);
      if (!site) return fail('quarry_no_site');
      ctx.record('quarry_start', { position: site.entry, direction: site.direction });
    }
    const current = here();
    if (site.pocket?.at.equals(current)) return move(ctx, site.pocket.from, surface, true);
    site.pocket = null;
    const index = site.route.findIndex((p) => p.equals(current));
    if (index < 0) {
      const moved = await move(ctx, site.entry, surface);
      return moved.ok ? moved : abandon(ctx, moved.reason);
    }
    if (index < site.route.length - 1) {
      const moved = await move(ctx, site.route[index + 1], surface, true);
      return moved.ok ? moved : abandon(ctx, moved.reason);
    }
    if (!landed(current)) return fail('quarry_stance_unconfirmed');
    const pending = site.pendingDrops.find(({ from }) => from.equals(current));
    if (pending) {
      const picked = await collect(ctx, current, pending, surface, dropMatch);
      site.pendingDrops.splice(site.pendingDrops.indexOf(pending), 1);
      if (picked.ok) return picked;
      ctx.record('quarry_pickup_pending', { position: pending.position, reason: picked.reason });
    }
    const side = site.route.length > 1 && sideStone(current, site, match);
    const next = !side && site.route.length <= DEPTH && geometry(current, site.direction, site);
    if (!side && (!next || next.target.y < Math.max(site.entry.y - DEPTH, surface.floor))) return abandon(ctx, 'quarry_exhausted');
    const target = side?.cut || next.cuts[0];
    if (target) {
      const block = read(target);
      const wanted = match(block?.name);
      const tool = wanted || block?.harvestTools ? pickFor(bot, block) : null;
      if ((wanted || block?.harvestTools) && !tool) return fail('quarry_no_harvest_tool');
      const dug = await surface.walk(() => actions.digBlock(bot, ctx, block, { tool }));
      if (!dug.ok || !open(read(target))) return abandon(ctx, dug.reason || 'quarry_dig_unconfirmed');
      site.open.add(posKey(target));
      ctx.record('quarry_dig', { position: target, from: current, block: block.name });
      if (wanted) site.pendingDrops.push({ position: target, from: side ? current : next.target,
        stand: side ? side.stand : next.target });
      return { ok: true };
    }
    // Add the freshly cleared destination to the route before movement. A
    // cancellation can leave the body on that stair; it still has a way out.
    site.route.push(next.target);
    site.floors.add(posKey(next.target.offset(0, -1, 0)));
    const moved = await move(ctx, next.target, surface, true);
    if (!moved.ok) return abandon(ctx, moved.reason);
    ctx.record('quarry_step', { position: next.target });
    return moved;
  }

  return { run, leave, active: () => Boolean(site && !site.closed),
    inside: () => site?.pocket?.at.equals(here()) || site?.route.slice(1).some((p) => p.equals(here())),
    reset: () => { site = null; } };
}

module.exports = { createStoneQuarry };
