'use strict';
// Goal: find a village, dig the underground iron farm (goals/ironFarm.js) a
// short walk from it, and bring it three of the village's villagers by
// minecart, on rails made by the rail duplicator (goals/railDuper.js).
//
// Every run() looks at the world and does exactly one thing:
//   1. no village seen yet           -> walk on, looking for villagers or a bell
//   2. no farm site yet              -> choose solid rock 24-40 blocks from the village,
//                                       with the stairs' top facing it, and a duplicator site
//   3. not enough rails yet          -> build the rail duplicator and press it
//   4. the farm not built            -> one step of the farm goal (dig, parts, lava,
//                                       zombie, its own rails, the seal)
//   5. a villager riding a cart      -> push the cart toward the farm from behind; past
//                                       the stairs' top it rolls in by itself and the
//                                       corridor's activator rails drop the villager off
//   6. a villager over our rails     -> put a minecart on the rail under it: it gets in
//   7. otherwise                     -> lay the next rail from the line's end toward the
//                                       nearest grown villager (one rail a run, re-aimed
//                                       each time since villagers walk about)
//   8. three villagers in the farm   -> the farm goal again: wait for golems, pick up iron
// The line starts at the rail on the stairs' top and only ever grows from its
// end, so each new rail joins the previous one and curves shape themselves.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultSkills = require('../skills');
const defaultActions = require('../actions');
const { createIronFarmGoal, evaluateIronFarmSite } = require('./ironFarm');
const { createRailDuperGoal, chooseRailDuperSite } = require('./railDuper');
const { FACINGS } = require('../blueprints/cobbleGenerator');
const { isBaby } = require('../husbandry');
const { sleep, waitUntil } = require('../confirm');

const VILLAGERS = 3;
const NEAR = 24; // the farm's corridor at least this far from the village's middle
const FAR = 40;
const CLEAR = 16; // the stairs' top and the duplicator kept off the village's middle
const REFILL_RAILS = 24; // each later batch
const SPARE_RAILS = 16; // beyond the straight distance: the line bends after villagers
const MAX_PATH = 64;
const PUSH_MS = 1200;

const LIQUID = new Set(['water', 'lava', 'bubble_column']);
// Rails need a full top face under them.
const NOT_FULL = /(_slab|_stairs|farmland|_bed|chest|_fence|_wall|_pane|glass|leaves|composter|lectern|cauldron|bell|hopper|lantern|_carpet|^snow|_trapdoor|_door|_fence_gate|scaffolding|campfire|_leaves)$/;
const KEEP = /(rail|_door|_sign|torch|banner|_button|lever|pressure_plate|bell|_bed|lantern|tripwire|redstone_wire|repeater|comparator)$/;
const isAir = (block) => !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
const isRail = (block) => Boolean(block) && /(^|_)rail$/.test(block.name);
const key = (p) => `${p.x},${p.y},${p.z}`;
const v = (p) => new Vec3(p.x, p.y, p.z);
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Mineflayer adds the passengers a set_passengers packet lists but never
 * removes the ones it leaves out, so a villager dropped off by an activator
 * rail would still look seated. Clear those once per bot.
 */
function trackDismounts(bot) {
  if (bot.companionTracksDismounts || !bot._client?.on) return;
  bot.companionTracksDismounts = true;
  bot._client.on('set_passengers', ({ entityId, passengers }) => {
    const vehicle = bot.entities[entityId];
    if (!vehicle?.passengers) return;
    for (const rider of [...vehicle.passengers]) {
      if (passengers.includes(rider.id)) continue;
      vehicle.passengers.splice(vehicle.passengers.indexOf(rider), 1);
      if (rider.vehicle === vehicle) rider.vehicle = null;
    }
  });
}

/**
 * What a rail at `cell` needs: null when it can't go there, else
 * { path, fill }: `path` when the ground under it is a dirt path (a little
 * lower than a full block: dug, and dirt put back), `fill` when that ground is
 * missing over solid ground (a dug path whose dirt never went back).
 */
function railCell(blockAt, cell) {
  const below = blockAt(cell.x, cell.y - 1, cell.z);
  if (!below || LIQUID.has(below.name)) return null;
  const path = below.name === 'dirt_path';
  let fill = false;
  if (isAir(below)) {
    const under = blockAt(cell.x, cell.y - 2, cell.z);
    if (!under || under.boundingBox !== 'block' || LIQUID.has(under.name)) return null;
    fill = true;
  } else if (!path && (below.boundingBox !== 'block' || NOT_FULL.test(below.name))) {
    return null;
  }
  const here = blockAt(cell.x, cell.y, cell.z);
  if (!isAir(here) && (here.boundingBox !== 'empty' || LIQUID.has(here.name) || KEEP.test(here.name))) return null;
  const above = blockAt(cell.x, cell.y + 1, cell.z);
  if (!isAir(above) && (above.boundingBox !== 'empty' || LIQUID.has(above.name))) return null;
  return { path, fill };
}

/**
 * Shortest run of rail cells (same level, four directions) from the rail at
 * `start` to `target`, not counting `start`. A cell next to someone else's
 * rail is skipped: the new rail could join that one instead. Rails in `ours`
 * (the line and the farm's) are each joined at both ends already, all but
 * `start`, and a new rail only ever joins a rail with a free end. With
 * `targetIsRail` the target holds a rail already (pass it in `ours`): the path
 * ends on it and the rail before it joins it.
 */
function railPath(blockAt, start, target, { blocked = new Set(), ours = new Set(), max = MAX_PATH, stats = null, targetIsRail = false } = {}) {
  if (target.y !== start.y) return null;
  const goalKey = key(target);
  if (goalKey === key(start)) return [];
  const startKey = key(start);
  const foreignRail = (cell, from) => STEPS.some(([dx, dz]) => {
    const n = { x: cell.x + dx, z: cell.z + dz };
    if (n.x === from.x && n.z === from.z) return false;
    return [-1, 0, 1].some((dy) => !ours.has(key({ x: n.x, y: cell.y + dy, z: n.z })) && isRail(blockAt(n.x, cell.y + dy, n.z)));
  });
  const previous = new Map([[startKey, null]]);
  let frontier = [start];
  for (let depth = 0; depth < max && frontier.length; depth += 1) {
    const next = [];
    for (const from of frontier) {
      for (const [dx, dz] of STEPS) {
        const cell = { x: from.x + dx, y: start.y, z: from.z + dz };
        const k = key(cell);
        if (previous.has(k) || blocked.has(k)) continue;
        // A rail already there (a parked cart's) is joined, not built.
        const joining = targetIsRail && k === goalKey;
        if (!joining && (!railCell(blockAt, cell) || foreignRail(cell, from))) continue;
        previous.set(k, from);
        if (stats) stats.explored = (stats.explored || 0) + 1;
        if (k === goalKey) {
          const path = [];
          for (let c = cell; c && key(c) !== startKey; c = previous.get(key(c))) path.unshift(c);
          return path;
        }
        next.push(cell);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Farm sites around the village: solid rock NEAR..FAR blocks from its middle,
 * the stairs' top on the village's side (the line then runs straight at it).
 */
function chooseVillageFarmSite(blockAt, village, { radius = 4 } = {}) {
  const c = { x: Math.floor(village.x), y: Math.floor(village.y), z: Math.floor(village.z) };
  let best = null;
  for (let distance = NEAR; distance <= FAR && !best; distance += 8) {
    for (let a = 0; a < 16; a += 1) {
      const angle = (a / 16) * Math.PI * 2;
      const ox = Math.round(c.x + Math.cos(angle) * distance);
      const oz = Math.round(c.z + Math.sin(angle) * distance);
      for (let dx = -radius; dx <= radius; dx += 2) {
        for (let dz = -radius; dz <= radius; dz += 2) {
          let y = null;
          for (let top = c.y + 4; top >= c.y - 6; top -= 1) {
            const block = blockAt(ox + dx, top, oz + dz);
            if (!block) break;
            if (isAir(block) || block.boundingBox === 'empty') continue;
            y = top;
            break;
          }
          if (y === null) continue;
          for (const facing of Object.keys(FACINGS)) {
            const farm = evaluateIronFarmSite(blockAt, { x: ox + dx, y, z: oz + dz }, facing);
            if (!farm) continue;
            const top = farm.cells.stairsTop;
            const fromVillage = Math.hypot(top.x - c.x, top.z - c.z);
            const corridor = Math.hypot(farm.anchor.x - c.x, farm.anchor.z - c.z);
            // The stairs' top nearer the village than the farm is, but not in it.
            if (corridor < NEAR || fromVillage >= corridor || fromVillage < CLEAR) continue;
            const score = fromVillage;
            if (!best || score < best.score) best = { farm, score };
          }
        }
      }
    }
  }
  return best ? best.farm : null;
}

function createVillageIronFarmGoal({ bot, count = 3, skills = defaultSkills, actions = defaultActions } = {}) {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('count must be a positive integer');
  const memory = { village: null, farmGoal: null, duperGoal: null, line: null, explore: {},
    loaded: 0, delivered: 0, pushes: 0, skip: new Map(), stocked: false, refill: null, made: 0 };
  // Rails laid leave the inventory, so what the duplicator made is frozen once
  // stocked and topped up by each refill's presses: laying never looks like a loss.
  const duperProgress = () => (memory.stocked ? memory.made : memory.duperGoal?.progress() || 0) + (memory.refill?.memory.presses || 0);
  const blockAt = (p) => bot.blockAt(v(p));
  const blockXYZ = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const rails = () => actions.countItems(bot, (n) => n === 'rail');
  const feet = () => bot.entity.position.floored();
  const farm = () => memory.farmGoal?.memory.farm || null;
  const cellOf = (e) => ({ x: Math.floor(e.position.x), y: Math.floor(e.position.y + 0.2), z: Math.floor(e.position.z) });

  // Where each villager was last seen standing still: one that has not moved
  // for a moment is still there when the rail and the cart go in.
  const still = new Map();
  const standingStill = (e, ms = 1500) => {
    const seen = still.get(e.id);
    const now = Date.now();
    if (!seen || seen.position.distanceTo(e.position) > 0.25) {
      still.set(e.id, { position: e.position.clone(), since: now });
      return false;
    }
    return now - seen.since >= ms;
  };
  const villagersAround = () => Object.values(bot.entities).filter((e) => e.name === 'villager' && e.position && !isBaby(bot, e));
  const inFarm = (e) => {
    const f = farm();
    return Boolean(f) && e.position.y < f.levels.ground - 2 && Math.hypot(e.position.x - f.anchor.x, e.position.z - f.anchor.z) < 16;
  };
  // Still riding means not dropped off yet, wherever the cart is (a cart can stop in the tunnel).
  const riding = () => villagersAround().filter((e) => e.vehicle && e.vehicle.name === 'minecart');
  const candidates = () => villagersAround().filter((e) => !e.vehicle && !inFarm(e) && memory.village
    && Math.hypot(e.position.x - memory.village.x, e.position.z - memory.village.z) < 48
    && (memory.skip.get(e.id) || 0) <= Date.now());

  function findVillage() {
    const bell = bot.registry.blocksByName.bell && bot.findBlock({ matching: bot.registry.blocksByName.bell.id, maxDistance: 96 });
    const grown = villagersAround();
    if (bell) return { x: bell.position.x, y: bell.position.y, z: bell.position.z, by: 'bell', villagers: grown.length };
    if (grown.length < VILLAGERS) return null;
    const mid = grown.reduce((s, e) => s.plus(e.position), new Vec3(0, 0, 0)).scaled(1 / grown.length);
    return { x: Math.floor(mid.x), y: Math.floor(mid.y), z: Math.floor(mid.z), by: 'villagers', villagers: grown.length };
  }

  const ours = () => new Set([...memory.line, ...farm().rails.map((r) => r.position)].map(key));

  // Cells the line keeps away from: the duplicator and a block around it.
  function blockedCells() {
    const d = memory.duperGoal?.memory.device;
    const out = new Set();
    if (!d) return out;
    const cells = [...d.parts.map((p) => p.position), ...(d.floor || []), ...(d.clear || []), ...(d.hollow || [])];
    for (const c of cells) for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) out.add(key({ x: c.x + dx, y: c.y + dy, z: c.z + dz }));
    }
    return out;
  }

  async function goStand(ctx, p, timeoutMs = 20000) {
    const there = () => feet().x === p.x && feet().z === p.z && Math.abs(bot.entity.position.y - p.y) < 0.6;
    if (there()) return { ok: true };
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(p.x, p.y, p.z), { timeoutMs, arrived: there });
    return there() ? { ok: true } : (moved.ok ? { ok: false, reason: 'not_in_stand' } : moved);
  }

  async function layLineRail(ctx, cell) {
    const need = railCell(blockXYZ, cell);
    if (!need) return { ok: false, reason: 'rail_cell_blocked' };
    if (need.path) {
      // A dirt path is a little lower than a full block: dig it, put the dirt back.
      const ground = blockAt({ ...cell, y: cell.y - 1 });
      const reach = await actions.goToDig(bot, ctx, ground);
      if (!reach.ok) return reach;
      const dug = await actions.digBlock(bot, ctx, ground);
      if (!dug.ok) return dug;
      await sleep(300, ctx.signal);
    }
    if (need.path || need.fill) {
      const filled = await skills.placeAt(bot, ctx, { ...cell, y: cell.y - 1 }, (n) => n === 'dirt' || n === 'cobblestone',
        { faces: [new Vec3(0, -1, 0)] });
      ctx.record('village_rail_ground', { at: cell, ok: filled.ok, reason: filled.reason });
      if (!filled.ok) return filled;
    }
    const result = await skills.placeAt(bot, ctx, cell, (n) => n === 'rail', { faces: [new Vec3(0, -1, 0)], passable: true });
    if (result.ok) memory.line.push({ ...cell });
    ctx.record('village_rail', { at: cell, ok: result.ok, reason: result.reason, line: memory.line.length,
      shape: blockAt(cell)?.getProperties?.().shape });
    return result;
  }

  const inCell = (e, cell) => e?.position && Math.floor(e.position.x) === cell.x && Math.floor(e.position.z) === cell.z;

  async function loadVillager(ctx, villager, cell) {
    const cart = bot.inventory.items().find((i) => i.name === 'minecart');
    if (!cart) return { ok: false, reason: 'no_material', missing: [{ name: 'minecart', short: 1 }] };
    if (!actions.withinReach(bot, v(cell))) {
      const moved = await actions.goNear(bot, ctx, v(cell).offset(0.5, 0, 0.5), 2, { timeoutMs: 15000 });
      if (!moved.ok) return moved;
    }
    const current = bot.entities[villager.id];
    if (!inCell(current, cell)) return { ok: false, reason: 'villager_moved' };
    if (!isRail(blockAt(cell))) {
      // A rail of its own under it: rails have no collision, so it goes in under the villager.
      const placed = await skills.placeAt(bot, ctx, cell, (n) => n === 'rail', { faces: [new Vec3(0, -1, 0)], passable: true });
      if (!placed.ok) return placed;
      if (!ours().has(key(cell))) memory.stub = { ...cell };
      if (!inCell(bot.entities[villager.id], cell)) return { ok: false, reason: 'villager_moved' };
    }
    try {
      await bot.equip(cart, 'hand');
      await bot.lookAt(v(cell).offset(0.5, 0.1, 0.5), true);
      await bot.activateBlock(blockAt(cell), new Vec3(0, 1, 0), new Vec3(0.5, 0.1, 0.5));
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { ok: false, reason: 'cart_failed' };
    }
    const aboard = await waitUntil(() => bot.entities[villager.id]?.vehicle?.name === 'minecart', { timeoutMs: 5000, signal: ctx.signal });
    if (aboard) memory.loaded += 1;
    if (aboard && memory.loaded === 1) {
      // Once: how the farm's rails shaped themselves, and whether the corridor's are powered.
      ctx.record('village_route_state', { rails: farm().rails.map((r) => {
        const block = blockAt(r.position);
        const p = block?.getProperties?.() || {};
        return `${block?.name === 'activator_rail' ? 'A' : block?.name === 'rail' ? 'R' : block?.name}:${p.shape}${p.powered === true || p.powered === 'true' ? '+' : ''}`;
      }).join(' ') });
    }
    ctx.record('village_cart_loaded', { ok: aboard, villager: villager.id, at: cell, stub: Boolean(memory.stub) });
    return aboard ? { ok: true } : { ok: false, reason: 'villager_not_aboard' };
  }

  // An empty cart left off the line (its villager walked off before it got in): break it and take it back.
  async function takeBackCart(ctx, cart) {
    const moved = await actions.goNear(bot, ctx, cart.position.clone(), 2, { timeoutMs: 15000 });
    if (!moved.ok) return moved;
    // A cart breaks once its damage passes 40. Each hit adds ten times its
    // damage and it heals one a tick, so a fist (1) never gets there: one
    // full-strength hit with a pickaxe, axe or sword (5 or more) does.
    const tool = bot.inventory.items().find((i) => /_(sword|axe|pickaxe)$/.test(i.name) && !/^(wooden|golden)_/.test(i.name));
    if (tool) await bot.equip(tool, 'hand').catch(() => {});
    for (let hit = 0; hit < 6 && bot.entities[cart.id]; hit += 1) {
      try { await bot.attack(bot.entities[cart.id]); } catch (_) { break; }
      await sleep(1000, ctx.signal);
    }
    const gone = !bot.entities[cart.id];
    if (gone) {
      const drop = Object.values(bot.entities).find((e) => e.name === 'item' && e.position.distanceTo(cart.position) < 3);
      if (drop) await actions.goNear(bot, ctx, drop.position.clone(), 0.5, { timeoutMs: 6000 });
    }
    ctx.record('village_cart_taken_back', { ok: gone, distance: +cart.position.distanceTo(bot.entity.position).toFixed(1) });
    return gone ? { ok: true } : { ok: false, reason: 'cart_not_broken' };
  }

  // A villager in a cart off the line: run the line to the rail it stands on,
  // or under the cart if the villager's push as it got in rolled it off that rail.
  async function reachParked(ctx, cart) {
    const end = memory.line[memory.line.length - 1];
    const at = { ...cellOf(cart), y: end.y };
    const stub = memory.stub;
    const stubThere = stub && isRail(blockAt(stub)) && !ours().has(key(stub));
    const onStub = stubThere && at.x === stub.x && at.z === stub.z;
    if (stubThere && !onStub) {
      // Rolled off: take its rail back, or the line could join that instead.
      const block = blockAt(stub);
      const reach = await actions.goToDig(bot, ctx, block);
      if (!reach.ok) return reach;
      const dug = await actions.digBlock(bot, ctx, block);
      if (dug.ok) memory.stub = null;
      return dug;
    }
    const target = onStub ? stub : at;
    const mine = ours();
    if (onStub) mine.add(key(stub));
    const stats = {};
    const path = railPath(blockXYZ, end, target, { blocked: blockedCells(), ours: mine, targetIsRail: onStub, stats });
    if (!path?.length) {
      ctx.record('village_no_route_to_cart', { end, target, onStub, explored: stats.explored || 0,
        ground: blockAt({ ...target, y: target.y - 1 })?.name, here: blockAt(target)?.name });
      // No way to it: break the cart (its villager gets out) and leave that one be for a while.
      for (const e of cart.passengers || []) memory.skip.set(e.id, Date.now() + 120000);
      const back = await takeBackCart(ctx, cart);
      if (back.ok && memory.stub && isRail(blockAt(memory.stub))) return { ok: true };
      return back.ok ? { ok: true } : { ok: false, reason: 'no_route_to_cart' };
    }
    const next = path[0];
    if (onStub && key(next) === key(stub)) {
      memory.line.push({ ...stub });
      memory.stub = null;
      ctx.record('village_rail', { at: next, ok: true, joined: true, line: memory.line.length, shape: blockAt(next)?.getProperties?.().shape });
      return { ok: true };
    }
    return layLineRail(ctx, next);
  }

  // The line from the corridor's end out to the line's end: index 0 is where carts stop.
  const route = () => [...farm().rails.map((r) => r.position), ...memory.line.slice(1)];

  async function push(ctx, cart) {
    const r = route();
    const at = cellOf(cart);
    const k = r.findIndex((c) => c.x === at.x && c.z === at.z && Math.abs(c.y - at.y) <= 1);
    if (k < 0) return reachParked(ctx, cart);
    // In the corridor its activator rails drop the villager off: nothing to push.
    if (k <= 2) {
      const block = blockAt(r[k]);
      ctx.record('village_cart_in_corridor', { k, rail: block?.name, powered: block?.getProperties?.().powered,
        velocity: cart.velocity ? +cart.velocity.norm().toFixed(3) : null });
      await sleep(2000, ctx.signal);
      return { ok: false, reason: 'cart_in_corridor', waited: true };
    }
    // Behind the cart: the next cell out along the line, or one more step past
    // its end; failing that (a fence, a hay bale) a cell beside that one, from
    // where a push still has some of its push along the rails.
    const ahead = r[k - 1] || r[k];
    const back = { x: r[k].x - ahead.x, z: r[k].z - ahead.z };
    const behind = r[k + 1] || { x: r[k].x + back.x, y: r[k].y, z: r[k].z + back.z };
    const open = (c) => {
      const body = [blockAt(c), blockAt({ ...c, y: c.y + 1 })];
      return body.every((b) => isAir(b) || b.boundingBox === 'empty') && blockAt({ ...c, y: c.y - 1 })?.boundingBox === 'block';
    };
    const stands = [behind, { x: behind.x + back.z, y: behind.y, z: behind.z + back.x },
      { x: behind.x - back.z, y: behind.y, z: behind.z - back.x }].filter((c, i) => i === 0 || open(c));
    let moved = null;
    for (const stand of stands) {
      moved = await goStand(ctx, stand, 15000);
      if (moved.ok) break;
      ctx.record('village_push_stand', { stand, reason: moved.reason });
    }
    if (!moved.ok) return moved;
    const before = k;
    const target = bot.entities[cart.id]?.position || cart.position;
    await bot.lookAt(new Vec3(target.x, bot.entity.position.y + 1.6, target.z), true);
    bot.setControlState('forward', true);
    try { await sleep(PUSH_MS, ctx.signal); } finally { bot.setControlState('forward', false); }
    memory.pushes += 1;
    const moving = await waitUntil(() => {
      const now = bot.entities[cart.id];
      if (!now?.position) return true;
      const c = cellOf(now);
      const i = r.findIndex((p) => p.x === c.x && p.z === c.z && Math.abs(p.y - c.y) <= 1);
      return i >= 0 && i < before;
    }, { timeoutMs: 2000, signal: ctx.signal });
    ctx.record('village_push', { from: before, moved: moving, pushes: memory.pushes });
    // Let it roll before deciding where to push from next.
    await sleep(2500, ctx.signal);
    if (moving) return { ok: true };
    // Up against the carts already parked in the corridor: the villagers in
    // there knock them about, so it gets through; keep pushing without a stall.
    if (k <= 3) return { ok: false, reason: 'corridor_full', waited: true };
    return { ok: false, reason: 'cart_did_not_move' };
  }

  async function transport(ctx) {
    const carried = riding();
    if (carried.length) {
      const cart = carried[0].vehicle;
      const from = cart.position.clone();
      await sleep(500, ctx.signal);
      // Still rolling (down the stairs, along the tunnel): let it.
      if (bot.entities[cart.id]?.position && bot.entities[cart.id].position.distanceTo(from) > 0.3) return { ok: true, waited: true };
      return push(ctx, cart);
    }
    // An empty cart on the stub: its villager walked off. Take the cart and the rail back.
    const stub = memory.stub;
    if (stub) {
      const empty = Object.values(bot.entities).find((e) => e.name === 'minecart' && !e.passengers?.length
        && e.position && Math.hypot(e.position.x - stub.x - 0.5, e.position.z - stub.z - 0.5) < 2);
      if (empty) return takeBackCart(ctx, empty);
      if (isRail(blockAt(stub))) {
        const block = blockAt(stub);
        const reach = await actions.goToDig(bot, ctx, block);
        if (!reach.ok) return reach;
        const dug = await actions.digBlock(bot, ctx, block);
        if (dug.ok) memory.stub = null;
        return dug;
      }
      memory.stub = null;
    }
    if (bot.inventory.items().every((i) => i.name !== 'minecart')) return { ok: false, reason: 'no_material', missing: [{ name: 'minecart', short: 1 }] };
    const end = memory.line[memory.line.length - 1];
    const near = (e) => Math.hypot(e.position.x - end.x, e.position.z - end.z);
    // Grown villagers out in the open at the line's level, nearest the line's end first.
    const free = candidates().filter((e) => {
      const cell = cellOf(e);
      if (cell.y !== end.y) return false;
      if (isRail(blockAt(cell))) return true;
      const need = railCell(blockXYZ, cell);
      return Boolean(need) && !need.path && !need.fill;
    }).sort((a, b) => near(a) - near(b));
    // Walk over to the nearest while watching who stands still. The line only
    // grows from its end, so a far one costs rails: take one well past the
    // nearest only after half a minute without a nearer one stopping.
    if (!memory.choosingSince) memory.choosingSince = Date.now();
    const patience = Date.now() - memory.choosingSince > 30000;
    const reach = free.length ? near(free[0]) + 12 : 0;
    const waiting = free.filter((e) => standingStill(e) && (patience || near(e) <= reach));
    if (!waiting.length) {
      if (free.length && bot.entity.position.distanceTo(free[0].position) > 6) {
        await actions.goNear(bot, ctx, free[0].position.clone(), 4, { timeoutMs: 10000 });
      } else {
        await sleep(500, ctx.signal);
      }
      for (const e of free) standingStill(e);
      if (!free.length) ctx.record('village_no_villager', { around: villagersAround().length, candidates: candidates().length });
      // Waiting for a villager to stop is no lack of progress (the brain doesn't count it).
      return { ok: false, reason: free.length ? 'villagers_walking' : 'no_villager', waited: true };
    }
    // Only one the line can reach from its end.
    const blocked = blockedCells();
    const mine = ours();
    const villager = waiting.sort((a, b) => near(a) - near(b)).find((e) => {
      const cell = cellOf(e);
      if (railPath(blockXYZ, end, cell, { blocked, ours: mine })) return true;
      memory.skip.set(e.id, Date.now() + 30000);
      return false;
    });
    if (!villager) {
      ctx.record('village_no_reachable_villager', { waiting: waiting.length, end });
      return { ok: false, reason: 'no_reachable_villager', waited: true };
    }
    memory.choosingSince = null;
    const result = await loadVillager(ctx, villager, cellOf(villager));
    if (!result.ok && result.reason !== 'no_material') memory.skip.set(villager.id, Date.now() + 10000);
    return result;
  }

  function choose(ctx) {
    const f = chooseVillageFarmSite(blockXYZ, memory.village);
    if (!f) return false;
    const top = f.cells.stairsTop;
    // The duplicator off to the side of the stairs, away from the farm and the village.
    const along = FACINGS[f.facing];
    const lane = { x: -along.z, z: along.x };
    const village = memory.village;
    // Open ground all round it (no house, fence or field within two blocks):
    // the bot walks round it to place parts and pick up what it throws.
    const open = (d) => {
      memory.why = null;
      const cells = [...d.parts.map((p) => p.position), ...(d.floor || [])];
      const xs = cells.map((c) => c.x);
      const zs = cells.map((c) => c.z);
      for (let x = Math.min(...xs) - 2; x <= Math.max(...xs) + 2; x += 1) {
        for (let z = Math.min(...zs) - 2; z <= Math.max(...zs) + 2; z += 1) {
          const ground = blockXYZ(x, d.anchor.y, z);
          if (!ground || ground.boundingBox !== 'block' || NOT_FULL.test(ground.name) || ground.name === 'dirt_path') {
            memory.why = { x, y: d.anchor.y, z, block: ground?.name };
            return false;
          }
          for (let y = d.anchor.y + 1; y <= d.anchor.y + 3; y += 1) {
            const b = blockXYZ(x, y, z);
            if (!isAir(b) && (b.boundingBox !== 'empty' || LIQUID.has(b.name) || KEEP.test(b.name))) {
              memory.why = { x, y, z, block: b.name };
              return false;
            }
          }
        }
      }
      return true;
    };
    const clear = (d) => {
      memory.why = 'near_village';
      return Math.hypot(d.anchor.x - village.x, d.anchor.z - village.z) >= CLEAR && open(d);
    };
    // Spots on a grid round the stairs' top, nearest first, not toward the farm.
    const arounds = [];
    for (let dx = -24; dx <= 24; dx += 8) {
      for (let dz = -24; dz <= 24; dz += 8) {
        if ((dx * lane.x + dz * lane.z) > 0) continue;
        arounds.push({ x: top.x + dx, y: top.y, z: top.z + dz });
      }
    }
    arounds.sort((a, b) => Math.hypot(a.x - top.x, a.z - top.z) - Math.hypot(b.x - top.x, b.z - top.z));
    let device = null;
    const tried = [];
    for (const around of arounds) {
      const found = chooseRailDuperSite(blockXYZ, around, { radius: 4 });
      if (found && clear(found)) { device = found; break; }
      if (tried.length < 6) tried.push({ around: { x: around.x, z: around.z }, found: found?.anchor || null, why: found ? memory.why : null });
    }
    if (!device) {
      ctx.record('village_no_duper_site', { farm: f.anchor, facing: f.facing, tried: tried.slice(0, 6) });
      return false;
    }
    memory.farmGoal = createIronFarmGoal({ bot, anchor: f.anchor, facing: f.facing, count, villagersBy: 'minecart', skills, actions });
    const straight = Math.abs(top.x - memory.village.x) + Math.abs(top.z - memory.village.z);
    const needed = memory.farmGoal.memory.farm.rails.filter((r) => r.block === 'rail').length + straight + SPARE_RAILS;
    memory.duperGoal = createRailDuperGoal({ bot, anchor: device.anchor, facing: device.facing, count: needed, skills, actions });
    memory.line = [{ ...top }];
    ctx.record('village_farm_site', { anchor: f.anchor, facing: f.facing, stairsTop: top, duper: device.anchor, rails: needed });
    return true;
  }

  const farmVillagers = () => memory.farmGoal?.villagers() || 0;

  return {
    name: 'village_iron_farm',
    memory,
    noProgressLimit: 60,
    isDone: () => Boolean(memory.farmGoal?.isDone()),
    progress: () => (memory.village ? 1 : 0) + (memory.farmGoal?.progress() || 0) + duperProgress()
      + (memory.line?.length || 0) + memory.loaded * 4 + memory.pushes,
    async run(ctx) {
      trackDismounts(bot);
      if (!memory.village) {
        const village = findVillage();
        if (!village) return skills.explore(bot, ctx, memory.explore);
        memory.village = village;
        ctx.record('village_found', village);
      }
      if (!memory.farmGoal) {
        if (Math.hypot(bot.entity.position.x - memory.village.x, bot.entity.position.z - memory.village.z) > 24) {
          return actions.goTo(bot, ctx, new goals.GoalNearXZ(memory.village.x, memory.village.z, 12), { timeoutMs: 60000 });
        }
        if (!choose(ctx)) {
          await sleep(3000, ctx.signal);
          return { ok: false, reason: 'no_site' };
        }
      }
      const fg = memory.farmGoal;
      const f = fg.memory.farm;
      bot.companionSpare = (entity) => entity.name === 'zombie' && entity.position.distanceTo(v(f.cells.zombie).offset(0.5, 0, 0.5)) <= 1.5;
      // Rails first: the farm's own and enough for the line.
      const transporting = fg.memory.awaiting && !fg.memory.ready && farmVillagers() < VILLAGERS;
      if (!memory.stocked) {
        if (!memory.duperGoal.isDone()) return memory.duperGoal.run(ctx);
        memory.made = memory.duperGoal.progress();
        memory.stocked = true;
      }
      // Out of rails on the way: a top-up, not the whole first batch again.
      if (transporting && rails() === 0 && !memory.refill) {
        const d = memory.duperGoal.memory.device;
        memory.refill = createRailDuperGoal({ bot, anchor: d.anchor, facing: d.facing, count: REFILL_RAILS, skills, actions });
      }
      if (memory.refill) {
        if (!memory.refill.isDone()) return memory.refill.run(ctx);
        memory.made += memory.refill.memory.presses;
        memory.refill = null;
      }
      if (fg.memory.ready || !fg.memory.awaiting || farmVillagers() >= VILLAGERS) return fg.run(ctx);
      return transport(ctx);
    },
  };
}

module.exports = { createVillageIronFarmGoal, chooseVillageFarmSite, railPath, railCell, trackDismounts };
