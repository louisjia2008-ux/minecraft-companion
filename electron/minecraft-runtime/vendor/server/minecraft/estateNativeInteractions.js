/* global module */
'use strict';

const guards = new WeakMap();
const INTERACTION_PACKETS = new Set(['block_place', 'use_item']);

// Mineflayer's native interaction may await lookAt before emitting its packet.
// Check only the owning estate context at that actual write boundary; preserve
// native payloads and unrelated actors' protocol/physics writes.
async function withEstateNativeInteractionGuard(bot, options, operation) {
  const client = bot?._client;
  if (typeof client?.write !== 'function' || typeof options?.assertActive !== 'function'
    || typeof options?.isOwnerContext !== 'function' || typeof operation !== 'function') {
    throw new TypeError('Estate native interaction requires a client writer, ownership check and operation');
  }
  const frame = { previous: client.write, active: true };
  function guardedWrite(...args) {
    if (frame.active && INTERACTION_PACKETS.has(args[0]) && options.isOwnerContext() === true) options.assertActive();
    return frame.previous.apply(this, args);
  }
  guards.set(guardedWrite, frame);
  client.write = guardedWrite;
  try {
    return await operation();
  } finally {
    frame.active = false;
    if (client.write === guardedWrite) {
      let previous = frame.previous;
      // Overlapping native calls can finish out of order. Do not resurrect an
      // already completed guard when the still-active inner call unwinds.
      while (guards.get(previous)?.active === false) previous = guards.get(previous).previous;
      client.write = previous;
    }
  }
}

module.exports = { withEstateNativeInteractionGuard };
