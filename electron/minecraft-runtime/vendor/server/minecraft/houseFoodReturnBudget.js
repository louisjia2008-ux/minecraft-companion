'use strict';
// Food search is bounded to a local area, but its native walking route can
// detour around hills/water. Allocate a fixed leg budget before movement,
// retaining a finite ceiling; this is not arrival or reachability evidence.
function foodReturnTimeoutMs(from, anchor) {
  if(![from,anchor].every(p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]))))
    throw new TypeError('Food return requires finite observed positions');
  const distance=Math.hypot(from.x-anchor.x,from.y-anchor.y,from.z-anchor.z);
  return Math.min(60000,Math.max(20000,Math.ceil(distance/2+10)*1000));
}
module.exports={foodReturnTimeoutMs};
