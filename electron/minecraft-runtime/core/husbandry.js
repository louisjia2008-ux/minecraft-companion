'use strict';
// Animal pen skills: choose a flat spot, the pen's fence and gate cells, lure
// an animal in with its food, and breed two adults. Confirmed against the
// world: fences standing, the animal inside the fence line, a new baby.

const { Vec3 } = require('vec3');
const actions = require('./actions');
const { waitUntil, sleep } = require('./confirm');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const isAbort = (error) => error?.code === 'aborted';
const v = (p) => new Vec3(p.x, p.y, p.z);

// What each animal follows and breeds on.
const FOOD = {
  cow: ['wheat'], sheep: ['wheat'], mooshroom: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
  rabbit: ['carrot', 'dandelion'],
};

/**
 * A square pen with `size` cells per side, fence on its border, the gate in
 * the middle of the north side. `corner` is the north-west fence post on the
 * ground level the fences stand on.
 */
function penLayout(corner, size = 6) {
  const at = (dx, dz) => ({ x: corner.x + dx, y: corner.y, z: corner.z + dz });
  const fences = [];
  const gateDx = Math.floor(size / 2);
  for (let dx = 0; dx < size; dx += 1) {
    for (let dz = 0; dz < size; dz += 1) {
      const border = dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1;
      if (border && !(dz === 0 && dx === gateDx)) fences.push(at(dx, dz));
    }
  }
  return {
    corner: { ...corner }, size, fences,
    gate: at(gateDx, 0),
    outside: at(gateDx, -2),
    inside: at(gateDx, size - 2),
    // Strictly between the fence lines: an animal standing in the open gate
    // cell is not in the pen yet.
    contains: (p) => p.x > corner.x + 1 && p.x < corner.x + size - 1 && p.z > corner.z + 1 && p.z < corner.z + size - 1
      && Math.abs(p.y - corner.y) < 2,
  };
}

/** A flat, open spot for the pen near `center`: same ground level everywhere, nothing in the way. */
function choosePenSite(blockAt, center, { size = 6, radius = 20, exclude = () => false } = {}) {
  const c = { x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z) };
  let best = null;
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      for (const dy of [0, -1, 1, -2, 2]) {
        const corner = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        let ok = true;
        for (let x = -1; x <= size && ok; x += 1) {
          for (let z = -2; z <= size && ok; z += 1) {
            const ground = blockAt({ x: corner.x + x, y: corner.y - 1, z: corner.z + z });
            const cell = blockAt({ x: corner.x + x, y: corner.y, z: corner.z + z });
            const head = blockAt({ x: corner.x + x, y: corner.y + 1, z: corner.z + z });
            ok = ground?.boundingBox === 'block' && !/leaves|log/.test(ground.name)
              && cell?.boundingBox === 'empty' && head?.boundingBox === 'empty'
              && !/water|lava/.test(cell.name) && !exclude({ x: corner.x + x, y: corner.y, z: corner.z + z });
          }
        }
        if (!ok) continue;
        const cost = Math.hypot(dx, dz) + Math.abs(dy) * 3;
        if (!best || cost < best.cost) best = { corner, cost };
        break;
      }
    }
  }
  return best?.corner || null;
}

function isBaby(bot, entity) {
  const index = bot.registry.entitiesByName?.[entity.name]?.metadataKeys?.indexOf('baby') ?? -1;
  return index >= 0 && entity.metadata?.[index] === true;
}

function animalsIn(bot, pen, kind) {
  return Object.values(bot.entities).filter((e) => e.name === kind && e.position && pen.contains(e.position));
}

async function holdFood(bot, kind) {
  const item = bot.inventory.items().find((i) => FOOD[kind]?.includes(i.name));
  if (!item) return false;
  try { await bot.equip(item, 'hand'); } catch (_) { return false; }
  return true;
}

async function setGate(bot, ctx, pen, open) {
  const gate = bot.blockAt(v(pen.gate));
  if (!gate?.name.endsWith('_fence_gate')) return fail('no_gate');
  const isOpen = () => bot.blockAt(v(pen.gate))?.getProperties?.().open === true;
  if (isOpen() === open) return { ok: true };
  if (!actions.withinReach(bot, v(pen.gate).offset(0.5, 0.5, 0.5), 4)) {
    const moved = await actions.goNear(bot, ctx, v(open ? pen.outside : pen.inside).offset(0.5, 0, 0.5), 1, { timeoutMs: 30000 });
    if (!moved.ok && !actions.withinReach(bot, v(pen.gate).offset(0.5, 0.5, 0.5), 4.5)) return moved;
  }
  try { await bot.activateBlock(gate); } catch (error) { if (isAbort(error)) throw error; }
  return await waitUntil(() => isOpen() === open, { timeoutMs: 1500, signal: ctx.signal }) ? { ok: true } : fail('gate_unconfirmed');
}

/** Walks straight at `target` (block centre, same level) without the pathfinder. */
async function walkStraight(bot, ctx, target, timeoutMs = 3000) {
  const flat = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z);
  const deadline = Date.now() + timeoutMs;
  try {
    while (flat() > 0.3 && Date.now() < deadline) {
      await bot.lookAt(new Vec3(target.x, bot.entity.position.y + 1.6, target.z), true);
      bot.setControlState('sprint', false);
      bot.setControlState('forward', true);
      await sleep(Math.min(150, flat() * 200), ctx.signal);
    }
  } finally {
    bot.setControlState('forward', false);
  }
  return flat() <= 0.5 ? { ok: true } : fail('walk_blocked');
}

/**
 * Through the open gate along its axis, one block at a time: the pathfinder
 * would rather open, close or dig the gate than walk through it. `wait` runs
 * after each block (an animal catching up).
 */
async function passGate(bot, ctx, pen, inward, wait = async () => {}) {
  const cells = [-1, 0, 1, 2].map((dz) => new Vec3(pen.gate.x + 0.5, pen.gate.y, pen.gate.z + dz + 0.5));
  if (!inward) cells.reverse();
  const moved = await actions.goNear(bot, ctx, cells[0], 0, { timeoutMs: 20000 });
  if (!moved.ok && bot.entity.position.distanceTo(cells[0]) > 1.5) return moved;
  for (const cell of cells.slice(1)) {
    const walked = await walkStraight(bot, ctx, cell);
    if (!walked.ok) return walked;
    await wait();
  }
  return { ok: true };
}

/**
 * Leads one animal into the pen with food in hand. Animals walk slower than
 * the bot and lose interest past about ten blocks, so every walk goes in
 * short legs that wait for it: to the gate, through it a block at a time (it
 * follows in a line instead of pressing against the fence beside it), on to
 * the far corner. Then the food goes away, it settles there, and the bot
 * steps out and shuts the gate behind.
 */
async function lure(bot, ctx, pen, entity, { followGap = 3.5 } = {}) {
  const kind = entity.name;
  if (!await holdFood(bot, kind)) return fail('no_food');
  const animal = () => bot.entities[entity.id];
  const gap = () => (animal() ? animal().position.distanceTo(bot.entity.position) : Infinity);
  const close = () => gap() <= followGap;
  const catchUp = () => waitUntil(close, { timeoutMs: 5000, signal: ctx.signal });
  const near = await actions.goNear(bot, ctx, entity.position.clone(), 2, { timeoutMs: 60000 });
  if (!animal()) return fail('animal_gone');
  if (!near.ok && gap() > 6) return near;
  await holdFood(bot, kind);

  // To the spot in front of the gate, two blocks at a time.
  const front = new Vec3(pen.gate.x + 0.5, pen.gate.y, pen.gate.z - 1.5);
  for (let leg = 0; leg < 40 && bot.entity.position.distanceTo(front) > 1.5; leg += 1) {
    if (!animal()) return fail('animal_gone');
    if (gap() > 8) {
      // Left behind: go back for it.
      await actions.goNear(bot, ctx, animal().position.clone(), 2, { timeoutMs: 15000 });
      await holdFood(bot, kind);
      continue;
    }
    const here = bot.entity.position;
    const step = here.plus(front.minus(here).normalize().scaled(Math.min(2, here.distanceTo(front))));
    await actions.goNear(bot, ctx, step, 0.5, { timeoutMs: 6000 });
    await catchUp();
  }
  if (!await catchUp()) return fail('animal_not_following', { gap: Math.round(gap()) });
  const opened = await setGate(bot, ctx, pen, true);
  if (!opened.ok) return opened;
  await holdFood(bot, kind);
  const through = await passGate(bot, ctx, pen, true, catchUp);
  if (!through.ok) {
    // Shut again so the ones already penned stay in.
    try { await bot.unequip('hand'); } catch (_) { /* nothing held */ }
    await setGate(bot, ctx, pen, false);
    return through;
  }
  // On to the far corner: it stops a couple of blocks short, well inside.
  const far = new Vec3(pen.corner.x + pen.size - 1.5, pen.corner.y, pen.corner.z + pen.size - 1.5);
  await actions.goNear(bot, ctx, far, 0, { timeoutMs: 6000 });
  const inside = await waitUntil(() => animal() && pen.contains(animal().position) && close(),
    { timeoutMs: 10000, signal: ctx.signal });
  if (!inside) {
    try { await bot.unequip('hand'); } catch (_) { /* nothing held */ }
    // Out (or just shut the gate) so the ones already penned stay in.
    const out = pen.contains(bot.entity.position) ? await leave(bot, ctx, pen) : await setGate(bot, ctx, pen, false);
    return out.ok ? fail('animal_not_inside', { gap: Math.round(gap()) }) : out;
  }
  // Shut it in while the food still holds it by the bot, away from the
  // opening; only then put the food away and step out.
  const gateCentre = new Vec3(pen.gate.x + 0.5, pen.gate.y, pen.gate.z + 0.5);
  const fromGate = () => (animal() ? Math.hypot(animal().position.x - gateCentre.x, animal().position.z - gateCentre.z) : Infinity);
  await waitUntil(() => fromGate() > 1.2, { timeoutMs: 5000, signal: ctx.signal });
  const shut = await setGate(bot, ctx, pen, false);
  try { await bot.unequip('hand'); } catch (_) { /* nothing held */ }
  if (!shut.ok) return shut;
  await sleep(1000, ctx.signal);
  const out = await leave(bot, ctx, pen);
  if (!out.ok) return out;
  return animal() && pen.contains(animal().position) ? { ok: true } : fail('animal_escaped');
}

/** Feeds two adults inside the pen; confirmed by a new baby appearing there. */
async function breed(bot, ctx, pen, kind) {
  const adults = animalsIn(bot, pen, kind).filter((e) => !isBaby(bot, e));
  if (adults.length < 2) return fail('not_enough_adults');
  const before = animalsIn(bot, pen, kind).length;
  if (!pen.contains(bot.entity.position)) {
    const opened = await setGate(bot, ctx, pen, true);
    if (!opened.ok) return opened;
    const entered = await passGate(bot, ctx, pen, true);
    await setGate(bot, ctx, pen, false);
    if (!entered.ok) return entered;
  }
  for (const animal of adults.slice(0, 2)) {
    if (!await holdFood(bot, kind)) return fail('no_food');
    const target = bot.entities[animal.id];
    if (!target) continue;
    await actions.goNear(bot, ctx, target.position.clone(), 2, { timeoutMs: 10000 });
    try {
      await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.6, 0), true);
      await bot.activateEntity(target);
    } catch (error) { if (isAbort(error)) throw error; }
    await sleep(300, ctx.signal);
  }
  const born = await waitUntil(() => animalsIn(bot, pen, kind).length > before, { timeoutMs: 10000, signal: ctx.signal });
  try { await bot.unequip('hand'); } catch (_) { /* nothing held */ }
  await leave(bot, ctx, pen);
  return born ? { ok: true, born: true } : fail('no_baby');
}

/** Out through the gate, shutting it behind. */
async function leave(bot, ctx, pen) {
  if (!pen.contains(bot.entity.position)) return { ok: true };
  const opened = await setGate(bot, ctx, pen, true);
  if (!opened.ok) return opened;
  const out = await passGate(bot, ctx, pen, false);
  // An open gate lets the herd walk out again: that failure outranks the walk.
  const shut = await setGate(bot, ctx, pen, false);
  return shut.ok ? out : shut;
}

module.exports = { FOOD, penLayout, choosePenSite, isBaby, animalsIn, holdFood, setGate, passGate, lure, breed, leave };
