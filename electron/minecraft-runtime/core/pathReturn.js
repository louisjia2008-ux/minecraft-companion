'use strict';
// mineflayer-pathfinder bridges by stepping back to the cell it came from
// ("returnPos") after placing a block, and keeps that spot in a closure that a
// new goal or a stopped path never clears. When the walk back fails (a death,
// a portal, a path reset mid-bridge), every later tick walks towards that old
// spot before any new path: after a nether trip the bot walked thousands of
// blocks across the overworld towards nether coordinates.
//
// Each bridge step's return spot is handed out as a Vec3 we keep hold of, so a
// halt can let go of it: from then on the spot is wherever the bot stands, so
// the next tick counts it as reached and the pathfinder drops it. Moving it
// once was not enough: a halt mid-jump left it 1.8 blocks over the floor, the
// bot landed below it, and walked into a wall towards it for 100 minutes.

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
          // moveToBlock clones the spot every tick before aiming at it.
          copy.clone = () => {
            if (!copy.companionDropped) return new Vec3(copy.x, copy.y, copy.z);
            const at = bot.entity?.position || copy;
            // moveToBlock aims at the spot's block centre (+0.5, 0, +0.5).
            return new Vec3(at.x - 0.5, at.y, at.z - 0.5);
          };
          bot.companionReturnPos = copy;
          return copy;
        };
        place.returnPos = spot;
      }
    }
    return moves;
  };
}

/** Makes a pending return spot follow the bot, so the pathfinder lets go of it. */
function dropReturnPosition(bot) {
  const spot = bot.companionReturnPos;
  if (!spot) return;
  spot.companionDropped = true;
  bot.companionReturnPos = null;
}

module.exports = { trackReturnPositions, dropReturnPosition };
