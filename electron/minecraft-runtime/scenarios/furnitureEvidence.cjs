'use strict';

const { score } = require('./acceptance.cjs');
const key = (p) => `${p.x},${p.y},${p.z}`;

async function installFurnitureEvidence({ bot, server, username, write = () => {} }) {
  const initial = { table: await score(server, username, 'table'), furnace: await score(server, username, 'furnace') };
  const previous = { ...initial };
  const evidence = { initial, interactions: [], errors: [] };
  const pending = new Set();
  const restore = [];
  let disposed = false;
  for (const [method, kind, block, target] of [['craft', 'table', 'crafting_table', (args) => args[2]?.position],
    ['openFurnace', 'furnace', 'furnace', (args) => args[0]?.position]]) {
    const native = bot[method];
    if (typeof native !== 'function') continue;
    const wrapper = function (...args) {
      const result = native.apply(this, args); // never defer or repeat a native operation
      const position = target(args);
      if (!position) return result;
      return Promise.resolve(result).then((value) => {
        if (disposed) return value;
        const reading = (async () => {
        try {
          const present = await server.query(`execute if block ${position.x} ${position.y} ${position.z} minecraft:${block}`,
            /Test (passed|failed)|(not loaded)/);
          const current = await score(server, username, kind);
          const event = { kind, position: { x: position.x, y: position.y, z: position.z }, before: previous[kind],
            after: current, blockConfirmed: present[1] === 'passed', confirmed: present[1] === 'passed' && current > previous[kind] };
          previous[kind] = current;
          evidence.interactions.push(event); write('furniture_server_interaction', event);
        } catch (error) {
          const reason = String(error?.message || error); evidence.errors.push(reason);
          write('furniture_readback_error', { kind, position, reason });
        }
        return value;
        })();
        pending.add(reading);
        return reading.finally(() => pending.delete(reading));
      });
    };
    bot[method] = wrapper;
    restore.push(() => { if (bot[method] === wrapper) bot[method] = native; });
  }
  return { evidence,
    async verify(furniture) {
      await Promise.allSettled([...pending]);
      const confirmed = (kind, position) => evidence.errors.length === 0
        && evidence.interactions.some((event) => event.kind === kind && event.confirmed && key(event.position) === key(position));
      return { tableUsed: confirmed('table', furniture.crafting_table.position),
        furnaceUsed: confirmed('furnace', furniture.furnace.position), evidence };
    },
    async dispose() { disposed = true; for (const undo of restore.reverse()) undo(); await Promise.allSettled([...pending]); },
  };
}

module.exports = { installFurnitureEvidence };
