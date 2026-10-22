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

/**
 * Leads one animal into the pen: food in hand, walk in short legs so it keeps
 * up, through the open gate to the far side, then put the food away, step
 * out and shut the gate behind.
 */
async function lure(bot, ctx, pen, entity) {
  const kind = entity.name;
  if (!await holdFood(bot, kind)) return fail('no_food');
  const near = await actions.goNear(bot, ctx, entity.position.clone(), 3, { timeoutMs: 60000 });
  if (!bot.entities[entity.id]) return fail('animal_gone');
  if (!near.ok && bot.entities[entity.id].position.distanceTo(bot.entity.position) > 6) return near;
  await holdFood(bot, kind);
  const opened = await setGate(bot, ctx, pen, true);
  if (!opened.ok) return opened;
  await holdFood(bot, kind);
  const following = () => bot.entities[entity.id] && bot.entities[entity.id].position.distanceTo(bot.entity.position) < 7;
  // Toward the gate, then inside, a few blocks at a time.
  for (const target of [pen.outside, pen.inside]) {
    for (let leg = 0; leg < 12; leg += 1) {
      const here = bot.entity.position;
      const goal = v(target).offset(0.5, 0, 0.5);
      if (here.distanceTo(goal) < 1.5) break;
      const step = here.plus(goal.minus(here).normalize().scaled(Math.min(3, here.distanceTo(goal))));
      await actions.goNear(bot, ctx, step, 1, { timeoutMs: 8000 });
      // Let the animal catch up.
      await waitUntil(following, { timeoutMs: 4000, signal: ctx.signal });
      if (!bot.entities[entity.id]) return fail('animal_gone');
    }
  }
  const inside = await waitUntil(() => bot.entities[entity.id] && pen.contains(bot.entities[entity.id].position),
    { timeoutMs: 10000, signal: ctx.signal });
  // Food away so it stops following, then out and shut.
  try { await bot.unequip('hand'); } catch (_) { /* nothing held */ }
  if (!inside) return fail('animal_not_inside');
  await sleep(500, ctx.signal);
  const out = await actions.goNear(bot, ctx, v(pen.outside).offset(0.5, 0, 0.5), 1, { timeoutMs: 20000 });
  const shut = await setGate(bot, ctx, pen, false);
  if (!shut.ok) return shut;
  if (!out.ok && pen.contains(bot.entity.position)) return out;
  return bot.entities[entity.id] && pen.contains(bot.entities[entity.id].position) ? { ok: true } : fail('animal_escaped');
}

/** Feeds two adults inside the pen; confirmed by a new baby appearing there. */
async function breed(bot, ctx, pen, kind) {
  const adults = animalsIn(bot, pen, kind).filter((e) => !isBaby(bot, e));
  if (adults.length < 2) return fail('not_enough_adults');
  const before = animalsIn(bot, pen, kind).length;
  if (!pen.contains(bot.entity.position)) {
    const opened = await setGate(bot, ctx, pen, true);
    if (!opened.ok) return opened;
    await actions.goNear(bot, ctx, v(pen.inside).offset(0.5, 0, 0.5), 1, { timeoutMs: 20000 });
    await setGate(bot, ctx, pen, false);
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

/** Out through the gate, shutting it behind (the pathfinder does not open gates). */
async function leave(bot, ctx, pen) {
  if (!pen.contains(bot.entity.position)) return { ok: true };
  const opened = await setGate(bot, ctx, pen, true);
  if (!opened.ok) return opened;
  const out = await actions.goNear(bot, ctx, v(pen.outside).offset(0.5, 0, 0.5), 1, { timeoutMs: 20000 });
  await setGate(bot, ctx, pen, false);
  return out;
}

module.exports = { FOOD, penLayout, choosePenSite, isBaby, animalsIn, holdFood, setGate, lure, breed, leave };
