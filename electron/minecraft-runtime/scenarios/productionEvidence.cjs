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

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockPattern = (p, field) => new RegExp(`(?:^|: )${p.x}, ${p.y}, ${p.z} has the following block data: (.*)|Found no elements matching ${field}|is not a block entity|not loaded`, 'm');

async function contents(server, p, options) {
  const result = await server.query(`data get block ${p.x} ${p.y} ${p.z} Items`,
    blockPattern(p, 'Items'), 5000, options);
  if (result[1] === undefined) throw new Error(`Missing output container at ${key(p)}: ${result[0]}`);
  return { counts: itemCounts(result[1]), raw: result[0] };
}

async function recipes(server, p, options) {
  const result = await server.query(`data get block ${p.x} ${p.y} ${p.z} RecipesUsed`,
    blockPattern(p, 'RecipesUsed'), 5000, options);
  if (result[1] === undefined && !/Found no elements/.test(result[0])) throw new Error(`Missing machine furnace at ${key(p)}`);
  let count = 0;
  for (const match of (result[1] || '').matchAll(/"minecraft:([^"\s]+)":\s*(\d+)/g)) {
    if (/^iron_ingot(?:_from_smelting_.*)?$/.test(match[1])) count += Number(match[2]);
  }
  return { count, raw: result[0] };
}

async function playerCount(server, username, item, options) {
  const result = await server.query(`clear ${username} minecraft:${item} 0`,
    new RegExp(`(?:^|: )(?:Found (\\d+) matching item(?:\\(s\\)|s)? on player ${escapeRegex(username)}|No items were found on player ${escapeRegex(username)})(?=\\r?$)`, 'm'), 5000, options);
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
function installProductionEvidence({ bot, server, username, resolve, write = () => {}, confirmationMs = 2000, pollMs = 50 }) {
  const entries = new Map();
  const restore = [];
  const errors = [];
  const readbacks = new Set();
  let disposed = false;
  let activeWindow = null, windowGeneration = 0, mutationGeneration = 0;
  const lifetime = new AbortController();
  const context = (guard = () => {}) => ({ deadline: Date.now() + confirmationMs, signal: lifetime.signal, guard });
  function check(ctx) {
    if (disposed || ctx.signal.aborted) throw new Error('Production observer disposed');
    if (Date.now() >= ctx.deadline) throw new Error('Production confirmation deadline exceeded');
    ctx.guard();
  }
  async function bounded(ctx, operation) {
    check(ctx);
    let timer, abort;
    const canceled = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Production confirmation deadline exceeded')), Math.max(0, ctx.deadline - Date.now()));
      abort = () => reject(new Error('Production observer disposed'));
      ctx.signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { check(ctx); return operation(); }), canceled]);
      check(ctx); return value;
    } finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); }
  }
  async function pause(ctx) {
    await bounded(ctx, () => new Promise((resolve) => setTimeout(resolve, pollMs)));
  }
  const signature = (sample) => JSON.stringify([sample.player, sample.recipes,
    ...sample.containers.map((container) => container.counts[sample.item] || 0)]);

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
  async function snapshot(entry, ctx = context()) {
    const containers = [];
    for (const p of entry.spec.buffers) containers.push({ position: p, ...await bounded(ctx, () => contents(server, p, ctx)) });
    const recipe = entry.spec.furnace ? await bounded(ctx, () => recipes(server, entry.spec.furnace, ctx)) : { count: 0 };
    return { at: Date.now(), output: containers.reduce((n, c) => n + (c.counts[entry.spec.item] || 0), 0),
      item: entry.spec.item, player: await bounded(ctx, () => playerCount(server, username, entry.spec.item, ctx)), recipes: recipe.count, containers, recipe };
  }
  async function stableSnapshot(entry, ctx, before, requested) {
    let previous;
    const samples = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sample = await snapshot(entry, ctx); check(ctx);
      samples.push(sample);
      let proven = !before;
      if (before) {
        const gain = sample.player - before.player;
        const produced = sample.recipes - before.recipes;
        const loss = before.output + produced - sample.output;
        const available = sample.recipes - entry.recipeBaseline - entry.collected;
        proven = produced >= 0 && gain === requested && loss === requested
          && Number.isFinite(entry.recipeBaseline) && available >= requested;
      }
      if (previous && signature(previous) === signature(sample) && proven) return { sample, samples };
      previous = sample;
      await pause(ctx);
    }
    throw new Error('Production confirmation did not settle within sample limit');
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
      const ctx = context();
      try {
        if (key(target) === key(spec.output)) {
          const initial = await bounded(ctx, () => contents(server, spec.output, ctx)); check(ctx);
          const baseline = { at: Date.now(), output: initial.counts[spec.item] || 0, position: spec.output, ...initial };
          entry.baseline ||= baseline;
          entry.placements.push(baseline);
          write('production_baseline', { id: entry.id, baseline });
        }
        if (spec.furnace && key(target) === key(spec.furnace)) {
          const initial = await bounded(ctx, () => recipes(server, spec.furnace, ctx)); check(ctx);
          entry.recipeBaseline ??= initial.count;
          write('production_recipe_baseline', { id: entry.id, position: spec.furnace, initial });
        }
      } catch (error) { recordError(entry, error); }
      return value;
    });
  });
  replace(bot, 'openContainer', (native) => function (...args) {
    const openingGeneration = ++windowGeneration;
    activeWindow = null;
    const result = native.apply(this, args);
    const position = args[0]?.position;
    return observe(result, async (window) => {
      const spec = position && resolve(position);
      if (!spec || key(position) !== key(spec.output)) return window;
      const entry = entryFor(spec);
      let before = null;
      const opening = context(() => {
        if (windowGeneration !== openingGeneration || bot.currentWindow !== window) throw new Error('Production window superseded');
      });
      try { before = spec.furnace ? (await stableSnapshot(entry, opening)).sample : await snapshot(entry, opening); }
      catch (error) { recordError(entry, error); }
      if (windowGeneration !== openingGeneration) return window;
      if (disposed) return window; // disposal may have restored methods during the snapshot
      activeWindow = window;
      replace(window, 'close', (close) => function (...closeArgs) {
        const value = close.apply(this, closeArgs);
        if (activeWindow === window) { activeWindow = null; windowGeneration += 1; }
        return value;
      });
      for (const method of ['withdraw', 'deposit']) replace(window, method, (operation) => function (...transferArgs) {
        const owned = this === window && activeWindow === window && bot.currentWindow === window && windowGeneration === openingGeneration;
        const generation = ++mutationGeneration;
        const nativeResult = operation.apply(this, transferArgs);
        return observe(nativeResult, async (value) => {
          const item = bot.registry.items[transferArgs[0]]?.name;
          const ctx = context(() => {
            if (!owned || activeWindow !== window || bot.currentWindow !== window || windowGeneration !== openingGeneration
              || mutationGeneration !== generation) throw new Error('Production window ownership or mutation overlap lost');
          });
          try {
            check(ctx);
            const requested = transferArgs[2];
            const strict = spec.furnace && method === 'withdraw' && item === spec.item;
            if (strict && (!before || entry.errors.length || !Number.isSafeInteger(requested) || requested <= 0))
              throw new Error('Production withdrawal lacks a valid original anchor or requested count');
            const confirmation = strict ? await stableSnapshot(entry, ctx, before, requested) : null;
            const after = confirmation ? confirmation.sample : await snapshot(entry, ctx);
            check(ctx);
            if (method === 'deposit' && item === spec.item) entry.deposited = true;
            let credited = method === 'withdraw' && item === spec.item && before ? transferCredit(before, after) : 0;
            if (spec.furnace) credited = Number.isFinite(entry.recipeBaseline)
              ? Math.min(credited, Math.max(0, after.recipes - entry.recipeBaseline - entry.collected)) : 0;
            const event = { position, method, item, requested: transferArgs[2], before, after, credited,
              ...(confirmation ? { confirmations: confirmation.samples } : {}) };
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
        const ctx = context();
        try { const latest = await snapshot(entry, ctx); check(ctx); entry.latest = latest; } catch (error) { recordError(entry, error); }
        if (errors.length) entry.errors.push(...errors);
      }
      return productionVerdict(entry, reported, required, { smelter: Boolean(spec.furnace) });
    },
    errors,
    async dispose() { disposed = true; lifetime.abort(); activeWindow = null; for (const undo of restore.reverse()) undo(); await Promise.allSettled([...readbacks]); },
  };
}

module.exports = { itemCounts, contents, recipes, transferCredit, productionVerdict, installProductionEvidence };
