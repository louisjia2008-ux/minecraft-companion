/* global require, Buffer, setTimeout, clearTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const Item = require('prismarine-item')(registry);
const WorldSync = require('prismarine-world/src/worldsync');
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');
const { withEstateNativeInteractionGuard } = require('../vendor/server/minecraft/estateNativeInteractions');
const { createHouseFluidResources } = require('../vendor/server/minecraft/houseFluidResources');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = p => `${p.x},${p.y},${p.z}`;

// Protocol/physics regression, not a real-server acceptance fixture. Installed
// inventory/physics/pathfinder own native use_item, actual slot interpretation,
// rotations and movement. Explicit server transactions model voxel/drops ACKs.
function fixture(t, options = {}) {
  const cells = new Map(), properties = new Map(), writes = [], uses = [], digs = [], moves = [], drops = [], timers = new Set(), looks = [], waitedTicks = [];
  let checkpoint = null, currentBot, stateId = 0, tick = 0, equipSelected = 'bucket', usedMutation = false;
  const token = new CancellationToken();
  const client = Object.assign(new EventEmitter(), { state: 'play', socket: { writable: true, destroyed: false } });
  const anchor = options.anchor || { x: 0, y: 64, z: 0 };
  const initial = options.initial || {x:anchor.x+0.5,y:anchor.y,z:anchor.z+0.5};
  if (options.geometry) for (const [cell, data] of options.geometry) { cells.set(cell,data.name); properties.set(cell,data.properties || {}); }
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', username: 'FluidUnit', _client: client,
    QUICK_BAR_START: 36, food: 20, health: 20, entities: {}, players: {}, isAlive: true,
    game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(initial.x,initial.y,initial.z), velocity: new Vec3(0, 0, 0), onGround: true,
      eyeHeight: 1.62, height: 1.8, width: 0.6, yaw: 0, pitch: 0, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true, elytraFlying: false },
    supportFeature: name => registry.supportFeature(name), swingArm: () => {},
  });
  currentBot = bot;
  bot.blockAt = point => {
    const p = point.floored(), name = cells.get(key(p)) ?? (options.geometry ? 'UNLOADED' : p.y < 64 ? 'stone' : 'air');
    if (name === 'UNLOADED') return null;
    return Object.assign(Block.fromProperties(registry.blocksByName[name].id, properties.get(key(p)) || {}, 0), { position: p });
  };
  bot.world = { getBlock: p => bot.blockAt(p), raycast: WorldSync.prototype.raycast };
  bot.canDigBlock = block => block.diggable && bot.entity.position.offset(0, 1.65, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 5.1;
  bot.findBlocks = ({ matching, point, maxDistance, count }) => [...cells.keys()].map(s => new Vec3(...s.split(',').map(Number)))
    .filter(p => p.distanceTo(point) <= maxDistance && matching(bot.blockAt(p))).sort((a, b) => a.distanceTo(point) - b.distanceTo(point)).slice(0, count);
  const stock = () => bot.inventory.items().reduce((result, item) => ({ ...result, [item.name]: (result[item.name] || 0) + item.count }), {});
  const commit = (next, selected = equipSelected) => {
    const items = Array.from({ length: 46 }, () => Item.toNotch(null)), remaining = { ...next };
    if (remaining[selected] > 0) { items[36] = Item.toNotch(new Item(registry.itemsByName[selected].id, 1)); remaining[selected] -= 1; }
    let slot = 9;
    for (const [name, amount] of Object.entries(remaining)) {
      let n = amount;
      while (n > 0) { const take = Math.min(n, registry.itemsByName[name].stackSize); items[slot++] = Item.toNotch(new Item(registry.itemsByName[name].id, take)); n -= take; }
    }
    equipSelected = selected;
    client.emit('window_items', { windowId: 0, stateId: ++stateId, items, carriedItem: null });
  };
  const update = (position, name, attrs = {}) => {
    const p = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z), previous = bot.blockAt(p);
    cells.set(key(p), name); properties.set(key(p), attrs); bot.emit('blockUpdate', previous, bot.blockAt(p));
  };
  const schedule = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
  const sourceWater = b => b?.name === 'water' && Number(b.getProperties().level) === 0;
  const sourceLava = b => b?.name === 'lava' && Number(b.getProperties().level) === 0;
  const packetRay = (packet, pickup) => {
    const yaw = Math.PI - packet.rotation.x * Math.PI / 180, pitch = -packet.rotation.y * Math.PI / 180;
    const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    return bot.world.raycast(bot.entity.position.offset(0, 1.62, 0), direction, 4.5, pickup ? (b, iterator) => sourceWater(b)
      || sourceLava(b) || Boolean(iterator.intersect(b.shapes, b.position)) : null);
  };
  client.write = (name, data) => {
    writes.push({ name, data, tick, at: Date.now() });
    if (name !== 'use_item') return;
    assert.equal(bot.entity.onGround, true, 'Native bucket packet only after real physical landing');
    const held = bot.heldItem.name, hit = packetRay(data, held === 'bucket');
    uses.push({ held, target: hit?.position?.clone(), face: hit?.face, tick, at: Date.now(), feet: bot.entity.position.clone() });
    if (held === 'bucket' && sourceWater(hit)) schedule(() => {
      const next = stock();
      if (!options.noWaterAck) { next.bucket -= 1; next.water_bucket = (next.water_bucket || 0) + 1; commit(next, 'water_bucket'); }
      if (!options.persistSource) update(hit.position, 'air');
      if (options.flowPosition && cells.get(key(options.flowPosition)) === 'water') schedule(() => update(options.flowPosition, 'air'), options.flowDelayMs ?? 60);
    }, 5);
    if (held === 'water_bucket' && hit?.face === 1) schedule(() => {
      const p = hit.position.offset(0, 1, 0), next = stock();
      next.water_bucket -= 1; next.bucket = (next.bucket || 0) + 1; commit(next, 'bucket'); update(p, 'water', { level: 0 });
      const sides = [new Vec3(1,0,0), new Vec3(-1,0,0), new Vec3(0,0,1), new Vec3(0,0,-1)];
      if (!options.noConversion) for (const direction of sides) {
        const lava = bot.blockAt(p.plus(direction));
        if (sourceLava(lava)) { update(lava.position, 'obsidian'); if (options.flowPosition) update(options.flowPosition, 'water', { level: 1 }); }
      }
      if (options.pauseAfterPour) token.pause();
    }, 5);
  };
  require('mineflayer/lib/plugins/inventory')(bot, { hideErrors: true }); bot.quickBarSlot = 0;
  commit({ bucket: options.bucketCount ?? 0, water_bucket: options.waterCount ?? 0, diamond_pickaxe: 1 }, 'diamond_pickaxe');
  require('mineflayer/lib/plugins/physics')(bot, {}); pathfinder(bot);
  bot.on('physicsTick', () => {
    tick += 1; options.onPhysicsTick?.(bot);
    for (let i = drops.length - 1; i >= 0; i -= 1) if (drops[i].position.distanceTo(bot.entity.position) < 1.5) {
      const next = stock(); next[drops[i].name] = (next[drops[i].name] || 0) + 1; commit(next, equipSelected); drops.splice(i, 1);
    }
  });
  bot.emit('login'); client.emit('position', { x: initial.x, y: initial.y, z: initial.z, yaw: 180, pitch: 0, flags: {} });
  async function moveTo(p, context) {
    context.assertActive(); moves.push({ ...p });
    options.onMove?.(p,context,bot);
    const movements = new Movements(bot); movements.canDig = false; movements.allowParkour = false;
    movements.allow1by1towers = false; movements.allowSprinting = false; movements.maxDropDown = 2; movements.scafoldingBlocks = [];
    if (context.strictCardinal) movements.getMoveDiagonal = () => {};
    movements.exclusionAreasStep.push(block => {
      if (!block?.position) return 100;
      for (const dy of [-1, 0, 1]) { const b = bot.blockAt(block.position.offset(0, dy, 0)); if (!b || ['water','lava','magma_block','fire'].includes(b.name)) return 100; }
      return 0;
    });
    bot.pathfinder.setMovements(movements); await bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z));
    for (let n = 0; bot.entity.onGround !== true && n < 40; n += 1) { await bot.waitForTicks(1); context.assertActive(); }
    context.assertActive();
  }
  const deps = { getBot: () => currentBot, assertActive: () => token.throwIfRequested(), getCP: () => checkpoint, getProtectedPositions: () => options.protectedPositions || [],
    saveCP: cp => { checkpoint = JSON.parse(JSON.stringify(cp)); }, report: () => {}, moveTo,
    returnToCamp: (p, ctx) => moveTo(p, ctx),
    ensureBucket: async (target, ctx) => { ctx.assertActive(); const next = stock(); next.bucket = Math.max(next.bucket || 0, target); commit(next); },
    ensureDiamondPickaxe: async ctx => { ctx.assertActive(); assert.ok(stock().diamond_pickaxe >= 1); },
    equipItem: async (name, ctx) => { ctx.assertActive(); assert.ok(stock()[name] > 0); commit(stock(), name); },
    lookAt: async (p, ctx) => { ctx.assertActive(); await bot.lookAt(new Vec3(p.x, p.y, p.z), false); looks.push({ tick, point: p }); },
    waitForTicks: async (n, ctx) => { const before = tick; await bot.waitForTicks(n); ctx.assertActive(); waitedTicks.push({ before, after: tick }); },
    activateItem: ctx => withEstateNativeInteractionGuard(bot, { assertActive: ctx.beforeSend, isOwnerContext: () => true }, async () => {
      if (options.useDelayMs) await sleep(options.useDelayMs);
      if (options.pauseBeforeUse) token.pause();
      if (options.replaceBeforeUse) currentBot = {};
      if (options.turnBeforeUse) bot.entity.yaw += Math.PI;
      if (options.mutateBeforeUse && !usedMutation) { usedMutation = true; options.mutateBeforeUse({ cells, properties, update }); }
      bot.activateItem();
    }),
    digBlock: async (block, ctx) => {
      options.beforeDig?.(block,{bot,token,update});
      ctx.beforeSend(); assert.equal(block.canHarvest(bot.heldItem.type), true); assert.equal(bot.entity.onGround, true);
      digs.push({ position: block.position.clone(), at: Date.now(), name: block.name, feet:bot.entity.position.clone() }); update(block.position, 'air');
      if (!options.noObsidianDrop || block.name !== 'obsidian') drops.push({name:block.name === 'obsidian' ? 'obsidian' : block.name === 'stone' ? 'cobblestone' : 'dirt',position:block.position.offset(...(options.actualDropOffset || [0.5, 0.2, 0.5]))});
      options.afterDig?.(block,{bot,token,update});
    },
    collectDrops: async ctx => { ctx.assertActive(); assert.equal(ctx.allowMovement, false); await bot.waitForTicks(1); ctx.assertActive(); },
    onOperationTimeout: error => { options.aborts?.push(error.code); token.pause(); },
    limits: { searchRadius: options.geometry ? 20 : 8, candidates: 16, readbackMs: 200, flowMs: 400, pollMs: 10, timeoutMs: 20000,
      operationTimeoutMs: options.operationTimeoutMs ?? 4000 },
  };
  const nativeProvider = createHouseFluidResources(deps);
  // The native initial clientbound position clears onGround. Begin each
  // operation only after real spawn physics has landed, like the engine.
  const ready = bot.waitForTicks(2);
  const provider = { ...nativeProvider,
    gatherWater: async (...args) => { await ready; return nativeProvider.gatherWater(...args); },
    gatherObsidian: async (...args) => { await ready; return nativeProvider.gatherObsidian(...args); },
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); bot.pathfinder.setGoal(null); bot.clearControlStates(); bot.emit('end'); });
  function bowl() {
    const lava = new Vec3(3, 64, 0), water = new Vec3(2, 64, 0);
    update(lava, 'lava', { level: 0 });
    for (const p of [new Vec3(1,64,0), new Vec3(2,64,1), new Vec3(2,64,-1)]) update(p, 'stone');
    return { lava, water };
  }
  return { bot, provider, token, deps, anchor, cells, properties, writes, uses, digs, moves, looks, waitedTicks, stock, update, bowl,
    checkpoint: () => checkpoint, ticks: () => tick };
}

test('native source-water bucket use waits for rotation and a real tick, ACKs slots, and walks back to camp', { timeout: 15000 }, async t => {
  const f = fixture(t); const water = new Vec3(2, 63, 0); f.update(water, 'water', { level: 0 });
  const result = await f.provider.gatherWater(1, { anchor: f.anchor });
  assert.equal(result.additional, 1); assert.equal(f.stock().water_bucket, 1); assert.equal(f.stock().bucket || 0, 0);
  assert.equal(f.uses.length, 1); assert.ok(f.uses[0].target.equals(water));
  const rotation = f.writes.filter(w => ['look','position_look'].includes(w.name) && w.at < f.uses[0].at).at(-1);
  assert.ok(rotation); assert.ok(f.waitedTicks[0].after > f.looks[0].tick);
  assert.ok(f.uses[0].tick >= f.waitedTicks[0].after);
  assert.equal(f.bot.entity.onGround, true); assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0,64,0));
});

test('two requested water buckets require two separate actual native bucket transactions', { timeout: 15000 }, async t => {
  const f = fixture(t, { bucketCount: 3 }); f.update(new Vec3(2,63,0), 'water', { level: 0 }); f.update(new Vec3(3,63,0), 'water', { level: 0 });
  await f.provider.gatherWater(2, { anchor: f.anchor });
  assert.equal(f.uses.length, 2); assert.equal(f.stock().water_bucket, 2); assert.equal(f.stock().bucket, 1, 'Existing spare bucket is preserved without crafting unnecessary buckets');
});

test('a truly replenishable two-neighbor infinite source may remain source-water after its native inventory ACK', { timeout: 15000 }, async t => {
  const f = fixture(t, { persistSource: true }); const p = new Vec3(2,63,0);
  for (const water of [p, p.offset(1,0,0), p.offset(0,0,1)]) f.update(water, 'water', { level: 0 });
  await f.provider.gatherWater(1, { anchor: f.anchor });
  assert.equal(f.stock().water_bucket, 1); assert.equal(f.checkpoint().confirmedWater[0].mayRefill, true);
  assert.equal(f.checkpoint().confirmedWater[0].sourceStillPresent, true);
});

test('flowing or protected water is not a source candidate and sends no use packet', { timeout: 15000 }, async t => {
  const f = fixture(t); f.update(new Vec3(2,63,0), 'water', { level: 1 });
  await assert.rejects(f.provider.gatherWater(1, { anchor: f.anchor }), e => e.code === 'house_fluid_source_not_found');
  assert.equal(f.uses.length, 0);
  f.update(new Vec3(2,63,0), 'water', { level: 0 });
  await assert.rejects(f.provider.gatherWater(1, { anchor: f.anchor, excludeBounds: [{ minX: 2,maxX: 2,minY: 63,maxY: 63,minZ: 0,maxZ: 0 }] }), e => e.code === 'house_fluid_source_not_found');
  assert.equal(f.uses.length, 0);
});

test('a bucket callback without an authoritative inventory increase fails bounded and never resends', { timeout: 15000 }, async t => {
  const f = fixture(t, { noWaterAck: true }); f.update(new Vec3(2,63,0), 'water', { level: 0 });
  await assert.rejects(f.provider.gatherWater(1, { anchor: f.anchor }), e => e.code === 'house_fluid_water_unconfirmed');
  assert.equal(f.uses.length, 1); assert.equal(f.stock().water_bucket || 0, 0); assert.equal(f.checkpoint().lastGather, undefined);
});

test('the final native-write guard rejects a source that changed during the asynchronous interaction', { timeout: 15000 }, async t => {
  const f = fixture(t, { mutateBeforeUse: ({ update }) => update(new Vec3(2,63,0), 'stone') }); f.update(new Vec3(2,63,0), 'water', { level: 0 });
  await assert.rejects(f.provider.gatherWater(1, { anchor: f.anchor }), e => e.code === 'house_fluid_source_not_found');
  assert.equal(f.writes.filter(w => w.name === 'use_item').length, 0);
});

test('the final bucket guard checks the actual current native rotation rather than an imagined target ray', { timeout: 15000 }, async t => {
  const f = fixture(t, { turnBeforeUse: true }); f.update(new Vec3(2,63,0), 'water', { level: 0 });
  await assert.rejects(f.provider.gatherWater(1, { anchor: f.anchor }), e => e.code === 'house_fluid_source_not_found');
  assert.equal(f.writes.filter(w => w.name === 'use_item').length, 0);
});

for (const [name, options, code] of [['pause', { pauseBeforeUse: true }, 'paused'], ['owner replacement', { replaceBeforeUse: true }, 'house_fluid_owner_changed']]) {
  test(`${name} at the native bucket send boundary cannot emit a use packet or late movement`, { timeout: 15000 }, async t => {
    const f = fixture(t, options); f.update(new Vec3(2,63,0), 'water', { level: 0 });
    await assert.rejects(f.provider.gatherWater(1, { anchor: f.anchor }), e => e.code === code);
    const moves = f.moves.length; await sleep(100); assert.equal(f.moves.length, moves); assert.equal(f.uses.length, 0);
  });
}

test('loaded dry existing obsidian uses a real harvestable diamond pick and native pickup movement', { timeout: 15000 }, async t => {
  const f = fixture(t); const p = new Vec3(2,63,0); f.update(p, 'obsidian');
  const result = await f.provider.gatherObsidian(1, { anchor: f.anchor });
  assert.equal(result.additional, 1); assert.equal(f.stock().obsidian, 1); assert.equal(f.digs.length, 1); assert.equal(f.uses.length, 0);
  assert.ok(f.moves.some(m => m.x === p.x && m.y === p.y && m.z === p.z));
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(0,64,0));
});

test('obsidian adjacent to actual fluid or an unknown neighbor is not excavated', { timeout: 15000 }, async t => {
  const f = fixture(t); const p = new Vec3(2,63,0); f.update(p, 'obsidian'); f.update(p.offset(1,0,0), 'lava', { level: 0 });
  await assert.rejects(f.provider.gatherObsidian(1, { anchor: f.anchor }), e => ['house_fluid_materials_missing','house_fluid_no_safe_source'].includes(e.code));
  assert.equal(f.digs.length, 0); assert.equal(f.uses.length, 0);
  f.update(p.offset(1,0,0), 'UNLOADED');
  await assert.rejects(f.provider.gatherObsidian(1, { anchor: f.anchor }), e => ['house_fluid_materials_missing','house_fluid_no_safe_source'].includes(e.code));
  assert.equal(f.digs.length, 0);
});

test('shallow bounded water cooling confirms obsidian, retrieves its own source and waits for real fluid drainage before dig', { timeout: 15000 }, async t => {
  const flow = new Vec3(3,65,0); const f = fixture(t, { waterCount: 1, flowPosition: flow, flowDelayMs: 80 }); const plan = f.bowl();
  await f.provider.gatherObsidian(1, { anchor: f.anchor })
    .catch(error => { error.message += ` ${JSON.stringify({ rejected: error.rejected, uses: f.uses, pos: f.bot.entity.position, cp: f.checkpoint() })}`; throw error; });
  assert.equal(f.uses.length, 2); assert.deepEqual(f.uses.map(u => u.held), ['water_bucket','bucket']);
  assert.equal(f.stock().water_bucket, 1); assert.equal(f.stock().obsidian, 1); assert.equal(f.stock().bucket || 0, 0);
  assert.ok(f.digs[0].at - f.uses[1].at >= 80); assert.equal(f.bot.blockAt(flow).name, 'air');
  assert.equal(f.checkpoint().pendingConversion, null); assert.equal(f.checkpoint().conversions[0].waterRecovered, true);
  assert.equal(f.checkpoint().conversions[0].converted, true); assert.ok(f.bot.blockAt(plan.water).name === 'air');
});

test('uncontained/deep source-lava geometry is rejected without pouring or pretending conversion', { timeout: 15000 }, async t => {
  const f = fixture(t, { waterCount: 1 }); f.update(new Vec3(3,63,0), 'lava', { level: 0 }); f.update(new Vec3(3,62,0), 'lava', { level: 0 });
  await assert.rejects(f.provider.gatherObsidian(1, { anchor: f.anchor }), e => e.code === 'house_fluid_no_safe_source');
  assert.equal(f.uses.length, 0); assert.equal(f.digs.length, 0); assert.equal(f.stock().water_bucket, 1);
});

test('failed natural conversion still retrieves confirmed owned water and cannot mark obsidian completion', { timeout: 15000 }, async t => {
  const f = fixture(t, { waterCount: 1, noConversion: true }); const plan = f.bowl();
  await assert.rejects(f.provider.gatherObsidian(1, { anchor: f.anchor }), e => e.code === 'house_fluid_conversion_failed');
  assert.equal(f.uses.length, 2); assert.equal(f.stock().water_bucket, 1); assert.equal(f.digs.length, 0);
  assert.equal(f.bot.blockAt(plan.lava).name, 'lava'); assert.equal(f.checkpoint().lastGather, undefined);
});

test('pause after the real pour ACK saves pending facts, performs no cleanup writes, and resumes through actual recovery', { timeout: 20000 }, async t => {
  const options = { waterCount: 1, pauseAfterPour: true }; const f = fixture(t, options); f.bowl();
  await assert.rejects(f.provider.gatherObsidian(1, { anchor: f.anchor }), e => e.code === 'paused');
  assert.equal(f.uses.length, 1); assert.equal(f.digs.length, 0); assert.equal(f.checkpoint().pendingConversion.sendAttempted, true);
  await sleep(100); assert.equal(f.uses.length, 1);
  options.pauseAfterPour = false; f.token.resume();
  await f.deps.returnToCamp(f.anchor, { assertActive: () => f.token.throwIfRequested() });
  await f.provider.gatherObsidian(1, { anchor: f.anchor });
  assert.equal(f.uses.length, 2); assert.equal(f.stock().water_bucket, 1); assert.equal(f.stock().obsidian, 1);
  assert.equal(f.checkpoint().pendingConversion, null);
});

test('operation timeout synchronously aborts the captured token before a delayed native callback can write', { timeout: 15000 }, async t => {
  const aborts = []; const f = fixture(t, { useDelayMs: 600, operationTimeoutMs: 300, aborts }); f.update(new Vec3(2,63,0), 'water', { level: 0 });
  await assert.rejects(f.provider.gatherWater(1, { anchor: f.anchor }), e => e.code === 'house_fluid_operation_timeout');
  await sleep(700); assert.deepEqual(aborts, ['house_fluid_operation_timeout']); assert.equal(f.uses.length, 0);
});

test('requests are bounded and native dig without an actual obsidian drop never satisfies the target', { timeout: 15000 }, async t => {
  const f = fixture(t, { noObsidianDrop: true }); f.update(new Vec3(2,63,0), 'obsidian');
  await assert.rejects(f.provider.gatherWater(3, { anchor: f.anchor }), e => e.code === 'house_fluid_invalid_request');
  await assert.rejects(f.provider.gatherObsidian(5, { anchor: f.anchor }), e => e.code === 'house_fluid_invalid_request');
  await assert.rejects(f.provider.gatherObsidian(1, { anchor: f.anchor }), e => e.code === 'house_fluid_drop_unconfirmed');
  assert.equal(f.stock().obsidian || 0, 0); assert.equal(f.checkpoint().lastGather, undefined);
});


// Read-only capture of the normally stopped fluid02 collision scene. This
// compressed fixture is self-contained; no test accesses a saved world or host path.
const FLUID02_VOXELS_GZIP = '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415rjHutMe61xrjXGuNea4x7rTFMawzQGgO0xnitNca91hj3WmPca41xrzXGvdYY91pj3GuNYVpjgNYYoDXGa60x7rXGuNca415rjHutMe61xrjXGuNeawzTGgO0xgCtMV5rjXGvNca91hj3WmPca41xrzXGvdYY91pjmNYYoDUGaI3xWmuMe60x7rXGuNca415rjHutMe61xrjXGsO0xgCtMUBrjNdaY9xrjXGvNca91hj3WmPca41xrzXGvdYYpjUGaI0BWmO81hrjXmuMe60x7rXGuNca415rjHutMe61xjCtMUBrDNAa47XWGPdaY9xrjXGvNca91hj3WmPca41xrzUmao0pWmOK1pjvtcYErTFBa0zQGhO0xgStMUFrTNAaE7XGFK0xRWvM91pjgtaYoDUmaI0JWmOC1pigNSZojYlaY4rWmKI15nutMUFrTNAaE7TGBK0xQWtM0BoTtMZErTFFa0zRGvO91pigNSZojQlaY4LWmKA1JmiNCVpjotaYojWmaI35XmtM0BoTtMYErTFBa0zQGhO0xgStMVFrTNEaU7TGfK81JmiNCVpjgtaYoDUmaI0JWmOC1pioNaZojSlaY77XGhO0xgStMUFrTNAaE7TGBK0xQWtM1BpTtMYUrTHfa40JWmOC1pigNSZojQlaY4LWmKA1pmmNCVpjgtaYr7XGvNca815rzHutMe+1xrzXGvNea8x7rTFNa0zQGhO0xnytNea91pj3WmPea415rzXmvdaY91pj3muNaVpjgtaYoDXma60x77XGvNca815rzHutMe+1xrzXGvNea0zTGhO0xgStMV9rjXmvNea91pj3WmPea415rzXmvdaY91pjmtaYoDUmaI35WmvMe60x77XGvNca815rzHutMe+1xrzXGtO0xgStMUFrzNdaY95rjXmvNea91pj3WmPea415rzXmvdaYpjUmaI0JWmO+1hrzXmvMe60x77XGvNca815rzHutMe+1xjStMUFrTNAa87XWmPdaY95rjXmvNea91pj3WmPea415rzWmaY0JWmOC1pivtca81xrzXmvMe60x77XGvNca815rzHutsVBrLNEaS7TGeq81FmiNBVpjgdZYoDUWaI0FWmOB1lioNZZojSVaY73XGgu0xgKtsUBrLNAaC7TGAq2xQGss1BpLtMYSrbHea40FWmOB1ligNRZojQVaY4HWWKA1FmqNJVpjidZY77XGAq2xQGss0BoLtMYCrbFAayzQGgu1xhKtsURrrPdaY4HWWKA1FmiNBVpjgdZYoDUWaI2FWmOJ1liiNdZ7rbFAayzQGgu0xgKtsUBrLNAaC7TGQq2xRGss0RrrvdZYoDUWaI0FWmOB1ligNRZojQVaY6HWWKI1lmiN9V5rLNAaC7TGAq2xQGss0BoLtMYCrbFMayzQGgu0xnqtNda91lj3WmPda411rzXWvdZY91pj3WuNZVpjgdZYoDXWa62x7rXGutca615rrHutse61xrrXGuteayzTGgu0xgKtsV5rjXWvNda91lj3WmPda411rzXWvdZY91pjmdZYoDUWaI31Wmuse62x7rXGutca615rrHutse61xrrXGsu0xgKtsUBrrNdaY91rjXWvNda91lj3WmPda411rzXWvdZYpjUWaI0FWmO91hrrXmuse62x7rXGutca615rrHutse61xjKtsUBrLNAa67XWWPdaY91rjXWvNda91lj3WmPda411rzWWaY0FWmOB1livtca61xrrXmuse62x7rXGutca615rrHutsUxrLNAaC7TGeq011r3WWPdaY91rjXWvNda91lj3WmPda42NWmOL1tiiNfZ7rbFBa2zQGhu0xgatsUFrbNAaG7TGRq2xRWts0Rr7vdbYoDU2aI0NWmOD1tigNTZojQ1aY6PW2KI1tmiN/V5rbNAaG7TGBq2xQWts0BobtMYGrbFRa2zRGlu0xn6vNTZojQ1aY4PW2KA1NmiNDVpjg9bYqDW2aI0tWmO/1xobtMYGrbFBa2zQGhu0xgatsUFrbNQaW7TGFq2x32uNDVpjg9bYoDU2aI0NWmOD1tigNTZqjS1aY4vW2O+1xgatsUFrbNAaG7TGBq2xQWts0BobtcYWrbFFa+z3WmOD1tigNTZojQ1aY4PW2KA1NmiNbVpjg9bYf6U1/iM3NO78wb7HGvsea+x7rLHvsca+xxr7Hmvse6yxDWtswBobsMZ+jTX2PdbY91hj32ONfY819j3W2PdYY99jjW1YYwPW2IA19musse+xxr7HGvsea+x7rLHvsca+xxr7HmtswxobsMYGrLFfY419jzX2PdbY91hj32ONfY819j3W2PdYYxvW2IA1NmCN/Rpr7Husse+xxr7HGvsea+x7rLHvsca+xxrbsMYGrLEBa+zXWGPfY419jzX2PdbY91hj32ONfY819j3W2IY1NmCNDVhjv8Ya+x5r7Husse+xxr7HGvsea+x7rLHvscY2rLEBa2zAGvs11tj3WGPfY419jzX2PdbY91hj32ONfY81tmGNDVhjA9bYr7HGvsca+x5r7Husse+xxr7HGvsea+x7rHEQaxzBGkewxnmPNQ5gjQNY4wDWOIA1DmCNA1jjANY4iDWOYI0jWOO8xxoHsMYBrHEAaxzAGgewxgGscQBrHMQaR7DGEaxx3mONA1jjANY4gDUOYI0DWOMA1jiANQ5ijSNY4wjWOO+xxgGscQBrHMAaB7DGAaxxAGscwBoHscYRrHEEa5z3WOMA1jiANQ5gjQNY4wDWOIA1DmCNg1jjCNY4gjXOe6xxAGscwBoHsMYBrHEAaxzAGgewxkGscQRrHMEa5z3WOIA1DmCNA1jjANY4gDUOYI0DWOMg1jiCNY5gjfMeaxzAGgewxgGscQBrHMAaB7DGAaxxDGscwBoHqjXO62qNc681zr3WOPda49xrjXOvNc691jj3WuOY1jigNQ5ojfNaa5x7rXHutca51xrnXmuce61x7rXGudcax7TGAa1xQGuc11rj3GuNc681zr3WOPda49xrjXOvNc691jimNQ5ojQNa47zWGudea5x7rXHutca51xrnXmuce61x7rXGMa1xQGsc0BrntdY491rj3GuNc681zr3WOPda49xrjXOvNY5pjQNa44DWOK+1xrnXGudea5x7rXHutca51xrnXmuce61xTGsc0BoHtMZ5rTXOvdY491rj3GuNc681zr3WOPda49xrjWNa44DWOKA1zmutce61xrnXGudea5x7rXHutca51xrnXmsc0xoHtMYBrXFea41zrzXOvdY491rj3GuNc681zr3WOPdaIx7kGr/8gWuv8cvVSVe/FBu//B23ZONPF1+bjV8u3nLxkounXDzk4oaLSW78OQuLsrAoC+uDLCzJwpIsLMnCkiwsycKSLCzJwtQsTMrCpCzMD7IwJQtTsjAlC1OyMCULU7IwJQtDszAoC4OyMD7IwpAsDMnCkCwMycKQLAzJwpAstGahKQtNWegPstCShZYstGShJQstWWjJQksWSrNQlIWiLNQHWSjJQkkWSrJQkoWSLJRkoSQLqVlIykJSFvKDLKRkISULKVlIyUJKFlKykJKF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';
const FLUID02_VOXELS_SHA256 = 'd28e05ba31a74ebdc120a6df08ab5b2c34ff9794c0cc4206bcda955528a28853';
async function actualFluid02Geometry() {
  const { gunzipSync } = require('node:zlib');
  const { createHash } = require('node:crypto');
  const bytes = gunzipSync(Buffer.from(FLUID02_VOXELS_GZIP, 'base64'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert.equal(digest(bytes), FLUID02_VOXELS_SHA256);
  const cells = new Map(JSON.parse(bytes));
  assert.equal(cells.size, 6171);
  return { cells, assertUnchanged: () => assert.equal(digest(JSON.stringify([...cells])), FLUID02_VOXELS_SHA256) };
}
function bodyCollisions(bot) {
  const p=bot.entity.position,half=Math.fround(0.6)/2,epsilon=1e-6,collisions=[];
  for(let x=Math.floor(p.x-half);x<=Math.floor(p.x+half);x+=1)for(let z=Math.floor(p.z-half);z<=Math.floor(p.z+half);z+=1)for(let y=Math.floor(p.y);y<=Math.floor(p.y+1.8);y+=1){
    const b=bot.blockAt(new Vec3(x,y,z));
    for(const s of b?.shapes||[])if(p.x+half>x+s[0]+epsilon&&p.x-half<x+s[3]-epsilon&&p.y+1.8>y+s[1]+epsilon&&p.y<y+s[4]-epsilon&&p.z+half>z+s[2]+epsilon&&p.z-half<z+s[5]-epsilon){collisions.push({name:b.name,position:b.position,player:p.clone()});break;}
  }
  return collisions;
}
test('actual fluid02 MCA geometry uses dynamically planned native cardinal pickup and camp return without corner penetration', {timeout:20000}, async t=>{
  const saved=await actualFluid02Geometry(),collisions=[],legs=[];
  // The stopped world already contains the actual mined hole; a local unit
  // transaction restores only its ore to exercise gathering again. No saved
  // world is changed, and the modeled inventory ACK is not live acceptance.
  const f=fixture(t,{geometry:saved.cells,anchor:{x:10,y:-60,z:2},initial:{x:10.32123618124316,y:-60,z:2.5072587395094312},waterCount:1,actualDropOffset:[0.125,0,0.125],
    onMove:(target,ctx,bot)=>{assert.equal(ctx.strictCardinal,true);const start=bot.entity.position.floored();const distance=Math.abs(target.x-start.x)+Math.abs(target.z-start.z);
      assert.ok(distance===1||distance===0&&target.y===start.y,'Each dependency gets one dynamically planned cardinal leg or an already reached camp');legs.push({start,target});},
    onPhysicsTick:bot=>collisions.push(...bodyCollisions(bot))});
  f.update(new Vec3(8,-61,0),'obsidian');
  const result=await f.provider.gatherObsidian(1,{anchor:f.anchor});
  assert.equal(result.additional,1);assert.equal(f.stock().obsidian,1);assert.equal(f.digs.length,1);
  assert.equal(f.bot.entity.onGround,true);assert.ok(f.bot.entity.position.floored().equals(new Vec3(10,-60,2)));
  assert.ok(legs.length>5,'Actual geometry requires several independently native legs');assert.deepEqual(collisions,[]);
  assert.equal(f.checkpoint().lastGather.returnedToCamp,true);saved.assertUnchanged();
});

test('native cardinal planning rejects an unrouteable loaded dry destination without consuming a drop or fabricating camp return', {timeout:15000},async t=>{
  const geometry=new Map();
  for(let x=-3;x<=6;x+=1)for(let z=-3;z<=3;z+=1)for(let y=62;y<=67;y+=1)geometry.set(`${x},${y},${z}`,{name:y<64?'stone':x===2?'bedrock':'air',properties:{}});
  const f=fixture(t,{waterCount:1,geometry}); f.update(new Vec3(4,63,0),'obsidian');
  await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),error=>error.code==='house_fluid_no_safe_source'&&error.rejected.length>0);
  assert.equal(f.stock().obsidian||0,0);assert.equal(f.digs.length,0);assert.equal(f.checkpoint().lastGather,undefined);
});


function closedPocket(f,plugName='stone') {
  const lava=new Vec3(3,64,0),plug=new Vec3(2,64,0);f.update(lava,'lava',{level:0});
  for(const p of [plug,new Vec3(1,64,0),new Vec3(2,64,1),new Vec3(2,64,-1),new Vec3(4,64,0),new Vec3(3,64,1),new Vec3(3,64,-1)])f.update(p,'stone');
  f.update(plug,plugName);return {lava,plug};
}
test('provider itself opens a stable natural stone pocket then pours from the same real dry stance and picks obsidian', {timeout:20000},async t=>{
  const f=fixture(t,{waterCount:1}),{lava,plug}=closedPocket(f);
  assert.equal(f.bot.blockAt(plug).name,'stone');const result=await f.provider.gatherObsidian(1,{anchor:f.anchor});
  assert.equal(result.additional,1);assert.equal(f.stock().obsidian,1);assert.equal(f.stock().water_bucket,1);
  assert.deepEqual(f.digs.map(d=>d.name),['stone','obsidian']);
  assert.deepEqual(f.checkpoint().openedNaturalPlugs,[{position:{x:plug.x,y:plug.y,z:plug.z},from:'stone',dug:true}]);
  const plugDig=f.digs[0],pour=f.uses.find(u=>u.held==='water_bucket');assert.ok(pour.at>plugDig.at);
  assert.ok(pour.feet.equals(plugDig.feet),'No movement between native plug opening and native water pour');
  assert.ok(f.moves.every(p=>!(p.x===plug.x&&p.y-1===plug.y&&p.z===plug.z)),'No leg uses the intended plug as route support');
  assert.equal(f.bot.blockAt(lava).name,'air');assert.equal(f.bot.blockAt(plug).name,'air');assert.equal(f.checkpoint().pendingConversion,null);
});
test('a stable natural dirt plug is collected as terrain and never counted as obsidian', {timeout:20000},async t=>{
  const f=fixture(t,{waterCount:1});closedPocket(f,'dirt');await f.provider.gatherObsidian(1,{anchor:f.anchor});
  assert.equal(f.stock().obsidian,1);assert.equal(f.digs.filter(d=>d.name==='obsidian').length,1);assert.equal(f.digs[0].name,'dirt');
});
test('player furniture, manufactured cobble and gravity plugs cannot be opened', {timeout:20000},async t=>{
  for(const name of ['crafting_table','cobblestone','sand']){
    const f=fixture(t,{waterCount:1});closedPocket(f,name);
    await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),e=>e.code==='house_fluid_no_safe_source');
    assert.equal(f.digs.length,0);assert.equal(f.uses.length,0);
  }
});
test('explicit and dynamically read known route supports are protected from native plug digging', {timeout:20000},async t=>{
  for(const dynamic of [false,true]){
    const protectedPositions=dynamic?[{x:2,y:64,z:0}]:[],f=fixture(t,{waterCount:1,protectedPositions});closedPocket(f);
    await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor,protectedPositions:dynamic?[]:[{x:2,y:64,z:0}]}),e=>e.code==='house_fluid_no_safe_source');
    assert.equal(f.digs.length,0);assert.equal(f.uses.length,0);
  }
});
test('pause after a real plug dig causes no delayed bucket use or false obsidian confirmation', {timeout:15000},async t=>{
  const f=fixture(t,{waterCount:1,afterDig:(block,{token})=>{if(block.name==='stone')token.pause();}});closedPocket(f);
  await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),e=>e.code==='paused');
  await sleep(100);assert.equal(f.digs.length,1);assert.equal(f.uses.length,0);assert.equal(f.stock().obsidian||0,0);assert.equal(f.checkpoint().lastGather,undefined);
});
test('a newly flowing lava plug after native opening is rejected before any water packet', {timeout:15000},async t=>{
  const f=fixture(t,{waterCount:1,afterDig:(block,{update})=>{if(block.name==='stone')update(block.position,'lava',{level:1});}});closedPocket(f);
  await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),e=>e.code==='house_fluid_plug_unconfirmed');
  assert.equal(f.digs.length,1);assert.equal(f.uses.length,0);assert.equal(f.stock().obsidian||0,0);
});

test('a plug supporting the actual player is never removed', {timeout:15000},async t=>{
  const f=fixture(t,{waterCount:1,anchor:{x:2,y:65,z:0}});closedPocket(f);
  await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),e=>e.code==='house_fluid_no_safe_source');
  assert.equal(f.digs.length,0);assert.equal(f.uses.length,0);assert.equal(f.bot.entity.onGround,true);
});
test('unknown walls, extra fluid and an unsupported lava floor fail before any plug dig', {timeout:20000},async t=>{
  for(const change of ['unknown','fluid','floor']){
    const f=fixture(t,{waterCount:1}),{lava,plug}=closedPocket(f);
    if(change==='unknown')f.update(plug.offset(0,0,1),'UNLOADED');
    if(change==='fluid')f.update(lava.offset(0,1,0),'water',{level:1});
    if(change==='floor')f.update(lava.offset(0,-1,0),'air');
    await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),e=>e.code==='house_fluid_no_safe_source');
    assert.equal(f.digs.length,0);assert.equal(f.uses.length,0);
  }
});
test('a newly protected route floor is rechecked at the native plug send boundary', {timeout:15000},async t=>{
  const protectedPositions=[],f=fixture(t,{waterCount:1,protectedPositions,beforeDig:(block)=>{if(block.name==='stone')protectedPositions.push({x:2,y:64,z:0});}});closedPocket(f);
  await assert.rejects(f.provider.gatherObsidian(1,{anchor:f.anchor}),e=>e.code==='house_fluid_no_safe_source');
  assert.equal(f.digs.length,0);assert.equal(f.uses.length,0);assert.equal(f.stock().obsidian||0,0);
});
