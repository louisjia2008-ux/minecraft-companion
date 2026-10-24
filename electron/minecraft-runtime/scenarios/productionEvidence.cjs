'use strict';

const key = (p) => `${p.x},${p.y},${p.z}`;

function itemCounts(text) {
  const counts = {};
  for (const object of text.match(/\{[^{}]*\}/g) || []) {
    const id = /id:\s*"minecraft:([a-z0-9_]+)"/.exec(object)?.[1];
    if (id) counts[id] = (counts[id] || 0) + Number(/(?:count|Count):\s*(\d+)/.exec(object)?.[1] || 1);
  }
  return counts;
}

async function contents(server, p) {
  const result = await server.query(`data get block ${p.x} ${p.y} ${p.z} Items`,
    /has the following block data: (.*)|Found no elements matching Items|is not a block entity|not loaded/);
  if (result[1] === undefined) throw new Error(`Missing output container at ${key(p)}: ${result[0]}`);
  return { counts: itemCounts(result[1]), raw: result[0] };
}

async function recipes(server, p) {
  const result = await server.query(`data get block ${p.x} ${p.y} ${p.z} RecipesUsed`,
    /has the following block data: (.*)|Found no elements matching RecipesUsed|is not a block entity|not loaded/);
  if (result[1] === undefined && !/Found no elements/.test(result[0])) throw new Error(`Missing machine furnace at ${key(p)}`);
  let count = 0;
  for (const match of (result[1] || '').matchAll(/"minecraft:([^"\s]+)":\s*(\d+)/g)) {
    if (/^iron_ingot(?:_from_smelting_.*)?$/.test(match[1])) count += Number(match[2]);
  }
  return { count, raw: result[0] };
}

async function playerCount(server, username, item) {
  const result = await server.query(`clear ${username} minecraft:${item} 0`,
    /Found (\d+) matching item|No items were found/);
  return Number(result[1] || 0);
}

function transferCredit(before, after) {
  const playerGain = after.player - before.player;
  const producedDuringTransfer = Math.max(0, after.recipes - before.recipes);
  const removedFromOutput = before.output + producedDuringTransfer - after.output;
  return Math.max(0, Math.min(playerGain, removedFromOutput));
}

function productionVerdict(entry, reported, required, { smelter = false } = {}) {
  const baselineEmpty = entry?.baseline?.output === 0;
  const collected = entry?.collected || 0;
  const produced = smelter && entry?.latest ? entry.latest.recipes - entry.recipeBaseline : null;
  const pass = Boolean(entry && baselineEmpty && !entry.deposited && !entry.errors.length
    && collected >= required && reported === collected
    && (!smelter || (Number.isFinite(entry.recipeBaseline) && produced >= required)));
  return { pass, collected, reported, required, produced, baselineEmpty,
    evidence: entry || null, reason: pass ? null : 'independent_production_not_confirmed' };
}

/** Read-only instrumentation around native operations. Native mutation methods
 * are invoked synchronously with their original receiver; no mutation is
 * queued behind an asynchronous read. Only their completion is observed. */
function installProductionEvidence({ bot, server, username, resolve, write = () => {} }) {
  const entries = new Map();
  const restore = [];
  const errors = [];
  const readbacks = new Set();
  let disposed = false;
  const observe = (result, operation) => Promise.resolve(result).then((value) => {
    if (disposed) return value;
    const reading = operation(value);
    readbacks.add(reading);
    return reading.finally(() => readbacks.delete(reading));
  });
  const entryFor = (spec) => {
    const id = `${spec.kind}:${key(spec.output)}`;
    if (!entries.has(id)) entries.set(id, { id, spec, baseline: null, recipeBaseline: null,
      collected: 0, deposited: false, errors: [], placements: [], transfers: [] });
    return entries.get(id);
  };
  const recordError = (entry, error) => {
    const message = String(error?.message || error);
    (entry?.errors || errors).push(message);
    write('production_readback_error', { id: entry?.id, reason: message });
  };
  async function snapshot(entry) {
    const containers = [];
    for (const p of entry.spec.buffers) containers.push({ position: p, ...await contents(server, p) });
    const recipe = entry.spec.furnace ? await recipes(server, entry.spec.furnace) : { count: 0 };
    return { at: Date.now(), output: containers.reduce((n, c) => n + (c.counts[entry.spec.item] || 0), 0),
      player: await playerCount(server, username, entry.spec.item), recipes: recipe.count, containers, recipe };
  }
  const replace = (object, name, make) => {
    const original = object[name];
    if (typeof original !== 'function') return;
    const wrapper = make(original);
    object[name] = wrapper;
    restore.push(() => { if (object[name] === wrapper) object[name] = original; });
  };
  replace(bot, 'placeBlock', (native) => function (...args) {
    const result = native.apply(this, args); // preserve synchronous throws
    const [reference, face] = args;
    const target = reference?.position && face && { x: reference.position.x + face.x,
      y: reference.position.y + face.y, z: reference.position.z + face.z };
    return observe(result, async (value) => {
      const spec = target && resolve(target);
      if (!spec) return value;
      const entry = entryFor(spec);
      try {
        if (key(target) === key(spec.output)) {
          const initial = await contents(server, spec.output);
          const baseline = { at: Date.now(), output: initial.counts[spec.item] || 0, position: spec.output, ...initial };
          entry.baseline ||= baseline;
          entry.placements.push(baseline);
          write('production_baseline', { id: entry.id, baseline });
        }
        if (spec.furnace && key(target) === key(spec.furnace)) {
          const initial = await recipes(server, spec.furnace);
          entry.recipeBaseline ??= initial.count;
          write('production_recipe_baseline', { id: entry.id, position: spec.furnace, initial });
        }
      } catch (error) { recordError(entry, error); }
      return value;
    });
  });
  replace(bot, 'openContainer', (native) => function (...args) {
    const result = native.apply(this, args);
    const position = args[0]?.position;
    return observe(result, async (window) => {
      const spec = position && resolve(position);
      if (!spec || key(position) !== key(spec.output)) return window;
      const entry = entryFor(spec);
      let before = null;
      try { before = await snapshot(entry); } catch (error) { recordError(entry, error); }
      if (disposed) return window; // dispose may have restored methods while snapshot awaited
      for (const method of ['withdraw', 'deposit']) replace(window, method, (operation) => function (...transferArgs) {
        const nativeResult = operation.apply(this, transferArgs);
        return observe(nativeResult, async (value) => {
          try {
            const after = await snapshot(entry);
            const item = bot.registry.items[transferArgs[0]]?.name;
            if (method === 'deposit' && item === spec.item) entry.deposited = true;
            let credited = method === 'withdraw' && item === spec.item && before ? transferCredit(before, after) : 0;
            if (spec.furnace) credited = Number.isFinite(entry.recipeBaseline)
              ? Math.min(credited, Math.max(0, after.recipes - entry.recipeBaseline - entry.collected)) : 0;
            const event = { position, method, item, requested: transferArgs[2], before, after, credited };
            entry.collected += credited;
            entry.latest = after;
            entry.transfers.push(event);
            write('production_transfer', { id: entry.id, ...event });
            before = after;
          } catch (error) { recordError(entry, error); }
          return value;
        });
      });
      return window;
    });
  });
  return {
    async verify(spec, reported, required) {
      await Promise.allSettled([...readbacks]);
      const entry = entries.get(`${spec.kind}:${key(spec.output)}`);
      if (entry) {
        try { entry.latest = await snapshot(entry); } catch (error) { recordError(entry, error); }
        if (errors.length) entry.errors.push(...errors);
      }
      return productionVerdict(entry, reported, required, { smelter: Boolean(spec.furnace) });
    },
    errors,
    async dispose() { disposed = true; for (const undo of restore.reverse()) undo(); await Promise.allSettled([...readbacks]); },
  };
}

module.exports = { itemCounts, contents, recipes, transferCredit, productionVerdict, installProductionEvidence };
