'use strict';
// Floating point guard for Mineflayer physics. When a collision stops the bot
// flush against a wall, its position is rebuilt as wall + 0.3 (half the body
// width), and x - 0.3 can round back to a hair *inside* the wall (32.3 - 0.3 =
// 31.999999999999996). The collision code then no longer sees the wall as
// beside the body, lets the next step move into it, and the server rejects the
// move and teleports the bot back, every tick, forever: the bot freezes in
// mid-air on a stair step. Pushing the edge back out by a micrometre breaks it.

const HALF_WIDTH = 0.3;
const SLACK = 1e-7; // only edges this close to a block face are touched
const PUSH = 1e-6;

// Returns the corrected coordinate, or the same value when no edge sits a hair
// past a block face.
function nudgeAxis(c, half = HALF_WIDTH) {
  const lo = c - half;
  const n = Math.round(lo);
  if (lo < n && n - lo < SLACK) return n + half + PUSH;
  const hi = c + half;
  const m = Math.round(hi);
  if (hi > m && hi - m < SLACK) return m - half - PUSH;
  return c;
}

function installEdgeNudge(bot) {
  const nudge = () => {
    const pos = bot.entity?.position;
    if (!pos || !Number.isFinite(pos.x)) return;
    pos.x = nudgeAxis(pos.x);
    pos.z = nudgeAxis(pos.z);
  };
  // physicsTick runs after the simulated move and before it is sent; forcedMove
  // after the server places the bot (its corrections carry the same rounding).
  bot.on('physicsTick', nudge);
  bot.on('forcedMove', nudge);
  return () => {
    bot.removeListener('physicsTick', nudge);
    bot.removeListener('forcedMove', nudge);
  };
}

module.exports = { nudgeAxis, installEdgeNudge };
