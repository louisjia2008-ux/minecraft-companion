'use strict';
// mineflayer-pathfinder bridges by stepping back to the cell it came from
// ("returnPos") after placing a block, and keeps that spot in a closure that a
// new goal or a stopped path never clears. When the walk back fails (a death,
// a portal, a path reset mid-bridge), every later tick walks towards that old
// spot before any new path: after a nether trip the bot walked thousands of
// blocks across the overworld towards nether coordinates.
//
// Each bridge step's return spot is handed out as a Vec3 we keep hold of, so a
// halt can move it under the bot's feet: the next tick counts it as reached and
// the pathfinder drops it.

const { Vec3 } = require('vec3');

function trackReturnPositions(bot, movements) {
  const neighbors = movements.getNeighbors;
  movements.getNeighbors = function getNeighbors(node) {
    const moves = neighbors.call(this, node);
    for (const move of moves) {
      for (const place of move.toPlace || []) {
        if (!place.returnPos || place.returnPos.companionTracked) continue;
        const spot = new Vec3(place.returnPos.x, place.returnPos.y, place.returnPos.z);
        spot.companionTracked = true;
        spot.clone = () => {
          const copy = new Vec3(spot.x, spot.y, spot.z);
          bot.companionReturnPos = copy;
          return copy;
        };
        place.returnPos = spot;
      }
    }
    return moves;
  };
}

/** Puts a pending return spot where the bot stands, so the pathfinder lets go of it. */
function dropReturnPosition(bot) {
  const spot = bot.companionReturnPos;
  const at = bot.entity?.position;
  if (!spot || !at) return;
  // moveToBlock aims at the spot's block centre (+0.5, 0, +0.5).
  spot.set(at.x - 0.5, at.y, at.z - 0.5);
  bot.companionReturnPos = null;
}

module.exports = { trackReturnPositions, dropReturnPosition };
