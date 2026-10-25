'use strict';
// Back to the End after dying there: the bot wakes up in the overworld with
// nothing on it. Walk to the end portal it came through (remembered on the
// bot, or any one in sight) and jump in; the drops wait on the island for the
// survival behavior that collects them.

const { Vec3 } = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const defaultActions = require('../actions');
const stronghold = require('../stronghold');
const { dimension } = require('../nether');

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/** Middle of the end portal blocks in sight, or null. */
function portalInSight(bot, maxDistance = 160) {
  const id = bot.registry.blocksByName.end_portal?.id;
  if (!Number.isInteger(id)) return null;
  const found = bot.findBlocks({ matching: id, maxDistance, count: 9 });
  if (found.length === 0) return null;
  const first = found[0];
  const near = found.filter((p) => p.distanceTo(first) <= 3);
  const sum = near.reduce((s, p) => s.plus(p), new Vec3(0, 0, 0));
  return new Vec3(Math.round(sum.x / near.length), first.y, Math.round(sum.z / near.length));
}

/** Remembers where the bot left the overworld for the End. */
function rememberPortal(bot, center) {
  if (center) bot.companionEndPortal = { x: center.x, y: center.y, z: center.z };
}

async function returnToEnd(bot, ctx, { actions = defaultActions } = {}) {
  if (dimension(bot) !== 'overworld') return fail('not_in_overworld');
  const seen = portalInSight(bot);
  if (seen) {
    rememberPortal(bot, seen);
    ctx.record('end_return', { portal: `${seen.x},${seen.y},${seen.z}` });
    return stronghold.enterPortal(bot, ctx, { center: seen });
  }
  const known = bot.companionEndPortal;
  if (!known) return fail('not_in_end');
  // Out of sight: head that way in long hops, the chunks load on the way.
  const here = bot.entity.position;
  const d = Math.hypot(known.x - here.x, known.z - here.z);
  const step = Math.min(64, d) / (d || 1);
  const to = new Vec3(here.x + (known.x - here.x) * step, here.y, here.z + (known.z - here.z) * step);
  ctx.record('end_return_walk', { portal: `${known.x},${known.y},${known.z}`, distance: Math.round(d) });
  const moved = await actions.goTo(bot, ctx, new goals.GoalNearXZ(to.x, to.z, 3), { timeoutMs: 90000, arrived: () => true });
  return bot.entity.position.distanceTo(here) >= 6 ? { ok: true } : fail(moved.reason || 'end_return_blocked');
}

module.exports = { returnToEnd, rememberPortal, portalInSight };
