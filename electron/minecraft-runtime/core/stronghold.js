'use strict';
// Strongholds: eyes of ender point the way, the portal room is found in the
// chunk data once it is within view distance, and filling its twelve frames
// lights the end portal.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const actions = require('./actions');
const { waitUntil, sleep } = require('./confirm');
const { dimension } = require('./nether');
const { hold } = require('./end');

const FALLING = /sand|gravel|concrete_powder/;
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const flat = (v) => new Vec3(v.x, 0, v.z);

const eyesOf = (bot) => Object.values(bot.entities).filter((e) => e.name === 'eye_of_ender');

/**
 * Throws one eye of ender and follows it. The server sends it 12 blocks
 * toward the nearest stronghold (or straight to it when closer than that),
 * so its flight gives the heading; it then drops as an item or shatters.
 */
async function throwEye(bot, ctx) {
  if (!(await hold(bot, 'ender_eye'))) return fail('no_eye');
  actions.haltBody(bot);
  const known = new Set(eyesOf(bot).map((e) => e.id));
  const itemsBefore = new Set(Object.values(bot.entities).filter((e) => e.name === 'item').map((e) => e.id));
  const origin = bot.entity.position.clone();
  await bot.look(bot.entity.yaw, 0, true);
  await sleep(100, ctx.signal);
  bot.activateItem();
  let eye = null;
  await waitUntil(() => {
    eye = eyesOf(bot).find((e) => !known.has(e.id) && e.position.distanceTo(origin) < 6) || null;
    return eye !== null;
  }, { timeoutMs: 2000, signal: ctx.signal });
  if (!eye) return fail('eye_not_seen');
  const start = eye.position.clone();
  let last = start.clone();
  let peak = start.y;
  const until = Date.now() + 5000;
  while (Date.now() < until && bot.entities[eye.id]) {
    last = bot.entities[eye.id].position.clone();
    peak = Math.max(peak, last.y);
    await sleep(100, ctx.signal);
  }
  const travel = flat(last).distanceTo(flat(start));
  const heading = travel > 0.5 ? flat(last.minus(start)).scaled(1 / travel) : null;
  // A surviving eye drops where it stopped and falls to the ground; pick it up.
  let drop = null;
  await waitUntil(() => {
    // Not filtered by itemsBefore: the drop can arrive under an id seen before.
    drop = Object.values(bot.entities).find((e) => e.name === 'item'
      && Math.hypot(e.position.x - last.x, e.position.z - last.z) < 3 && e.position.y <= last.y + 1
      && actions.droppedItemName(e) === 'ender_eye') || null;
    return drop !== null;
  }, { timeoutMs: 1500, signal: ctx.signal });
  if (!drop) {
    ctx.record('eye_drop_missing', { last: `${last.x.toFixed(1)},${last.y.toFixed(1)},${last.z.toFixed(1)}`,
      items: Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(last) < 12)
        .map((e) => `${actions.droppedItemName(e)}@${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)}${itemsBefore.has(e.id) ? '(old)' : ''}`) });
  }
  let recovered = false;
  if (drop) {
    await waitUntil(() => !bot.entities[drop.id] || bot.entities[drop.id].onGround, { timeoutMs: 3000, signal: ctx.signal });
    const before = actions.countItems(bot, (n) => n === 'ender_eye');
    const spot = bot.entities[drop.id]?.position || drop.position;
    await actions.collectDrops(bot, ctx, spot, (n) => n === 'ender_eye', { radius: 4, timeoutMs: 15000 });
    recovered = actions.countItems(bot, (n) => n === 'ender_eye') > before;
  }
  return { ok: true, origin, start, last, travel, heading, recovered, dropped: Boolean(drop) };
}

/**
 * Where two eye sightings cross: each is a line from where it was thrown
 * along its heading. Null when they are nearly parallel or cross behind.
 */
function crossing(a, b) {
  const [p, r] = [a.start, a.heading];
  const [q, s] = [b.start, b.heading];
  const denom = r.x * s.z - r.z * s.x;
  if (Math.abs(denom) < Math.sin(2 * Math.PI / 180)) return null;
  const t = ((q.x - p.x) * s.z - (q.z - p.z) * s.x) / denom;
  const u = ((q.x - p.x) * r.z - (q.z - p.z) * r.x) / denom;
  if (t < 0 || u < 0) return null;
  return new Vec3(p.x + r.x * t, 0, p.z + r.z * t);
}

// ---- the portal room -------------------------------------------------------

function frameBlocks(bot, maxDistance = 128) {
  const id = bot.registry.blocksByName.end_portal_frame?.id;
  return bot.findBlocks({ matching: id, maxDistance, count: 24 }).map((p) => bot.blockAt(p)).filter(Boolean);
}

/** The ring of twelve frames around the portal (nearest ring if several). */
function portalRing(bot, maxDistance = 128) {
  const all = frameBlocks(bot, maxDistance);
  if (all.length < 12) return all.length ? { frames: all, center: null, complete: false } : null;
  const seed = all[0].position;
  const frames = all.filter((b) => b.position.distanceTo(seed) <= 6 && b.position.y === seed.y);
  const center = frames.reduce((acc, b) => acc.plus(b.position), new Vec3(0, 0, 0)).scaled(1 / frames.length);
  return { frames, center: new Vec3(Math.round(center.x), seed.y, Math.round(center.z)), complete: frames.length >= 12 };
}

const hasEye = (block) => block?.getProperties?.().eye === true || block?.getProperties?.().eye === 'true';

function portalLit(bot, center) {
  if (!center) return false;
  const id = bot.registry.blocksByName.end_portal?.id;
  return bot.findBlocks({ matching: id, maxDistance: 8, count: 9, point: center }).length >= 9;
}

/**
 * A goal: stand on a cell from which `target` is in reach, outside the ring
 * (never over the lava pool in the middle).
 */
class GoalBesideFrame extends goals.Goal {
  constructor(target, center, reach = 3.6) {
    super();
    this.target = target;
    this.center = center;
    this.reach = reach;
  }
  heuristic(node) {
    const dx = node.x - this.target.x; const dy = node.y - this.target.y; const dz = node.z - this.target.z;
    return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - this.reach + 1);
  }
  isEnd(node) {
    const eyeAt = new Vec3(node.x + 0.5, node.y + 1.62, node.z + 0.5);
    if (eyeAt.distanceTo(this.target.offset(0.5, 0.5, 0.5)) > this.reach + 0.6) return false;
    // Outside the ring: frames are 2 cells from the centre on each axis.
    return Math.max(Math.abs(node.x - this.center.x), Math.abs(node.z - this.center.z)) >= 3
      && node.y >= this.target.y && node.y <= this.target.y + 1;
  }
}

/** Puts one eye into `frame`. Confirmed by the block's eye property. */
async function fillFrame(bot, ctx, frame, center) {
  if (hasEye(frame)) return { ok: true, already: true };
  if (!actions.withinReach(bot, frame.position, 4.2)) {
    const moved = await actions.goTo(bot, ctx, new GoalBesideFrame(frame.position, center), {
      timeoutMs: 60000, arrived: () => actions.withinReach(bot, frame.position, 4.4),
    });
    if (!moved.ok && !actions.withinReach(bot, frame.position, 4.4)) return moved;
  }
  if (!(await hold(bot, 'ender_eye'))) return fail('no_eye');
  try {
    await bot.lookAt(frame.position.offset(0.5, 0.8, 0.5), true);
    await bot.activateBlock(bot.blockAt(frame.position), new Vec3(0, 1, 0));
  } catch (error) {
    if (error?.code === 'aborted') throw error;
  }
  const filled = await waitUntil(() => hasEye(bot.blockAt(frame.position)), { timeoutMs: 2000, signal: ctx.signal });
  return filled ? { ok: true } : fail('frame_not_filled');
}

/**
 * Hops over a frame into the lit portal. Confirmed by the dimension.
 */
async function enterPortal(bot, ctx, ring) {
  const from = dimension(bot);
  const center = ring.center;
  // Stand outside the middle of one side, facing the centre.
  const sides = [[3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dz]) => center.offset(dx, 0, dz));
  const here = bot.entity.position.clone();
  sides.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  for (const side of sides) {
    const stand = [side, side.offset(0, 1, 0)].find((p) => bot.blockAt(p)?.boundingBox === 'empty'
      && bot.blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty' && bot.blockAt(p.offset(0, -1, 0))?.boundingBox === 'block');
    if (!stand) continue;
    const moved = await actions.goTo(bot, ctx, new goals.GoalBlock(stand.x, stand.y, stand.z), { timeoutMs: 30000 });
    if (!moved.ok) continue;
    await bot.lookAt(center.offset(0.5, 0.5, 0.5), true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    try {
      const moved2 = await waitUntil(() => dimension(bot) !== from, { timeoutMs: 3000, signal: ctx.signal });
      if (moved2) break;
    } finally {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
  }
  const arrived = await waitUntil(() => dimension(bot) !== from, { timeoutMs: 15000, signal: ctx.signal });
  if (!arrived) return fail('portal_no_transfer');
  try { await bot.waitForChunksToLoad(); } catch { /* the goal re-checks the ground */ }
  await sleep(500, ctx.signal);
  return { ok: true, dimension: dimension(bot) };
}

/**
 * Dry ground near `center` to dig down from: a column whose top is land, not
 * water (a stronghold under the sea is reached from the nearest shore).
 */
function landNear(bot, center, { maxRadius = 160 } = {}) {
  const here = bot.entity.position.clone();
  let best = null;
  for (let r = 0; r <= maxRadius; r += 8) {
    const n = r === 0 ? 1 : 24;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.round(center.x + Math.cos(a) * r);
      const z = Math.round(center.z + Math.sin(a) * r);
      for (let y = 140; y > 40; y -= 1) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) break;
        if (b.name === 'air' || b.name === 'cave_air' || b.boundingBox === 'empty' && !/water|lava/.test(b.name) && !b.name.endsWith('leaves')) continue;
        if (/water|lava|ice|kelp|seagrass|leaves/.test(b.name) || b.boundingBox !== 'block') break;
        // Sand and gravel cave in on a staircase dug through them.
        if ([0, 1, 2, 3].some((d) => FALLING.test(bot.blockAt(new Vec3(x, y - d, z))?.name || ''))) break;
        const p = new Vec3(x, y + 1, z);
        const score = r * 2 + p.distanceTo(here) * 0.5;
        if (!best || score < best.score) best = { p, score };
        break;
      }
    }
    if (best && r >= 16) break;
  }
  return best?.p || null;
}

module.exports = { landNear, throwEye, crossing, frameBlocks, portalRing, hasEye, portalLit, fillFrame, enterPortal, GoalBesideFrame };
