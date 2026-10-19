/* global module */
'use strict';
const mutations = new Set(['window_click', 'block_place', 'use_item', 'use_entity', 'block_dig']);
const frames = new WeakMap();
async function withHouseNativeSourceGuard(bot, deps, action) {
  if (!bot?._client?.write || typeof deps.isOwnerContext !== 'function' || typeof deps.assertActive !== 'function') throw new TypeError('House source guard needs a native client and exact owner context');
  const client = bot._client, frame = { previous: client.write, active: true };
  function write(...args) {
    if (frame.active && mutations.has(args[0]) && deps.isOwnerContext() === true) {
      // Only a bridge-proven synchronous call of its exact native stop function
      // can cancel a revoked owner's dig. Start/finish and other mutations stay guarded.
      const ownedCancel = args[0] === 'block_dig' && args[1]?.status === 1
        && deps.allowNativeCancel?.(bot, args[0], args[1]) === true;
      if (!ownedCancel) {
        deps.assertActive();
        deps.beforeSend?.(bot, args[0], args[1]);
      }
    }
    return frame.previous.apply(this, args);
  }
  frames.set(write, frame); client.write = write;
  try { deps.assertActive(); return await action(); }
  finally {
    frame.active = false;
    if (client.write === write) {
      let previous = frame.previous;
      while (frames.get(previous)?.active === false) previous = frames.get(previous).previous;
      client.write = previous;
    }
  }
}
module.exports = { withHouseNativeSourceGuard };
