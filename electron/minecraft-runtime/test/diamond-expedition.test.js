/* global require, process, setInterval, clearInterval */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { createDiamondExpedition, getMiningLevels, remainingDurability } = require('../vendor/server/minecraft/diamondExpedition');

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

// A solid voxel world: movement is possible only through two-block-high cells
// already excavated by the runtime. Ore lookup cannot see the underground seams
// from the initial surface chunk. Recipes and harvest requirements come from the
// installed Mineflayer / prismarine registry rather than a parallel recipe table.
function fixture(t, options = {}) {
  const version = options.version || '1.21.8';
  const registry = require('prismarine-registry')(version);
  const Block = require('prismarine-block')(registry);
  const Item = require('prismarine-item')(registry);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-expedition-'));
  Object.assign(process.env, { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'), MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const minY = version === '1.16.5' ? 0 : -64;
  const surface = options.surface ?? 80;
  const targetY = minY + 11;
  const stock = new Map(Object.entries(options.initial || {}));
  const toolStacks = new Map();
  let toolId = 1;
  for (const [name, count] of stock) if (name.endsWith('_pickaxe')) {
    toolStacks.set(name, Array.from({ length: count }, () => ({ id: toolId++, damage: options.initialDamage?.[name] || 0 })));
  }
  const cells = new Map();
  const matureCrops = new Set();
  const unknown = new Set();
  const templates = new Map();
  const pendingDrops = new Map();
  let dropId = 1;
  const changes = { digs: [], crafts: [], moves: [], placements: [], smelts: 0, brokenTools: [] };
  const add = (name, count) => {
    stock.set(name, (stock.get(name) || 0) + count);
    if (name.endsWith('_pickaxe') && count > 0) {
      if (!toolStacks.has(name)) toolStacks.set(name, []);
      for (let i = 0; i < count; i += 1) toolStacks.get(name).push({ id: toolId++, damage: 0 });
    }
  };
  const items = () => [...stock].filter(([, count]) => count > 0).flatMap(([name, count]) => name.endsWith('_pickaxe')
    ? (toolStacks.get(name) || []).map((tool) => ({ name, displayName: name, count: 1, type: registry.itemsByName[name].id,
      metadata: 0, durabilityUsed: tool.damage, toolId: tool.id }))
    : [{ name, displayName: name, count, type: registry.itemsByName[name].id, metadata: 0 }]);
  for (let x = -7; x <= 7; x += 2) for (let z = -7; z <= 7; z += 2) {
    if (Math.abs(x) + Math.abs(z) < 4) continue;
    for (let y = surface; y < surface + 3; y += 1) cells.set(`${x},${y},${z}`, 'oak_log');
  }
  // Existing controlled-fixture resources, just like the trees and ore seams:
  // food is obtained only by harvesting real mature crop blocks and collecting
  // their item entities. Starting inventory remains empty in from-zero cases.
  if (options.food !== false) for (let x = -6; x <= 6; x += 1) {
    cells.set(`${x},${surface - 1},10`, 'farmland');
    cells.set(`${x},${surface},10`, 'carrots');
    matureCrops.add(`${x},${surface},10`);
  }
  const generatedName = (p) => {
    if (p.y < minY + 2) return 'bedrock';
    if (p.y >= surface) return 'air';
    if (options.lavaWall && p.x === 15) return 'lava';
    if (options.iron !== false && (p.y === 16 || p.y === 17) && p.x % 7 === 0 && p.z % 7 === 0) return 'iron_ore';
    if (options.diamond !== false && p.y === targetY && ((p.x - 5) % 11 === 0) && ((p.z - 5) % 11 === 0)) {
      return minY < 0 ? 'deepslate_diamond_ore' : 'diamond_ore';
    }
    return p.y < 0 ? 'deepslate' : 'stone';
  };
  const blockAt = (raw) => {
    const p = raw.floored();
    if (unknown.has(key(p))) return null;
    const name = cells.get(key(p)) ?? generatedName(p);
    const templateKey = name === 'carrots' ? `${name}:${matureCrops.has(key(p)) ? 7 : 0}` : name;
    if (!templates.has(templateKey)) templates.set(templateKey, name === 'carrots'
      ? Block.fromProperties(name, { age: matureCrops.has(key(p)) ? 7 : 0 }, 0)
      : name === 'farmland' ? Block.fromProperties(name, { moisture: 7 }, 0)
        : Block.fromStateId(registry.blocksByName[name].defaultState));
    return Object.assign(Object.create(templates.get(templateKey)), { position: p });
  };
  const bot = new EventEmitter();
  const pickup = () => {
    for (const [id, drop] of pendingDrops) {
      if (bot.entity.position.distanceTo(drop.entity.position) > 1.6) continue;
      add(drop.name, 1); pendingDrops.delete(id); delete bot.entities[id];
      bot.emit('playerCollect', bot.entity, drop.entity);
    }
  };
  const dropItem = (name, position) => {
    // Item entities fall through the freshly excavated column before pickup.
    let y = position.y;
    while (y > minY && blockAt(new Vec3(position.x, y - 1, position.z))?.boundingBox === 'empty') y -= 1;
    const entity = { id: dropId++, name: 'item', type: registry.entitiesByName.item.type,
      entityType: registry.entitiesByName.item.id, position: new Vec3(position.x + 0.5, y + 0.1, position.z + 0.5), metadata: [] };
    entity.metadata[registry.supportFeature('metadataIxOfItem')] = Item.toNotch(new Item(registry.itemsByName[name].id, 1));
    pendingDrops.set(entity.id, { name, entity }); bot.entities[entity.id] = entity;
    bot.emit('itemDrop', entity);
    pickup();
  };
  Object.assign(bot, { username: 'DeskPet', version, health: 20, food: 20, registry, entities: {}, players: {},
    entity: { position: new Vec3(0.5, surface, 0.5), effects: {}, onGround: true },
    inventory: { items, count: (id) => items().filter((i) => i.type === id).reduce((sum, i) => sum + i.count, 0) },
    game: { dimension: 'overworld', gameMode: 'survival', minY, height: minY < 0 ? 384 : 256 }, player: { ping: 1 },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    clearControlStates: () => {}, stopDigging: () => {}, blockAt,
    canDigBlock: (block) => block.position.distanceTo(bot.entity.position) <= 4.5,
    equip: async (item) => { bot.heldItem = item; },
    lookAt: async () => {},
    placeBlock: async (reference, face) => {
      const p = reference.position.plus(face); const item = bot.heldItem;
      assert.ok(reference.position.distanceTo(bot.entity.position) <= 4.5, 'No remote block placement');
      assert.equal(blockAt(p).boundingBox, 'empty');
      assert.ok((stock.get(item.name) || 0) > 0);
      const placedName = item.name === 'carrot' ? 'carrots' : item.name;
      add(item.name, -1); cells.set(key(p), placedName); matureCrops.delete(key(p));
      changes.placements.push({ name: placedName, position: p });
    },
    dig: async (target) => {
      assert.ok(target.position.distanceTo(bot.entity.position) <= 4.5, 'No remote ore collection');
      assert.notEqual(key(target.position), key(bot.entity.position.offset(0, -1, 0)), 'Never excavate beneath the bot');
      assert.ok(!['lava', 'water', 'bedrock'].includes(target.name));
      changes.digs.push({ name: target.name, position: target.position }); cells.set(key(target.position), 'air');
      if (target.canHarvest(bot.heldItem?.type ?? null)) {
        const drop = target.name === 'carrots' ? 'carrot' : target.name === 'stone' ? 'cobblestone' : target.name === 'deepslate' ? 'cobbled_deepslate' :
          target.name.includes('iron_ore') ? (minY < 0 ? 'raw_iron' : 'iron_ore') : target.name.includes('diamond_ore') ? 'diamond' : target.name;
        const amount = target.name === 'carrots' && Number(target.getProperties().age) === 7 ? 3 : 1;
        for (let index = 0; index < amount; index += 1) dropItem(drop, target.position);
        matureCrops.delete(key(target.position));
      }
      if (options.breakStoneTool && bot.heldItem?.name === 'stone_pickaxe') {
        const stack = toolStacks.get('stone_pickaxe').find((tool) => tool.id === bot.heldItem.toolId);
        stack.damage += 1; bot.heldItem.durabilityUsed = stack.damage;
        if (stack.damage >= 131) {
          stock.set('stone_pickaxe', stock.get('stone_pickaxe') - 1);
          toolStacks.set('stone_pickaxe', toolStacks.get('stone_pickaxe').filter((tool) => tool.id !== stack.id)); bot.heldItem = null;
          changes.brokenTools.push('stone_pickaxe');
        }
      }
      if (options.afterDig) options.afterDig({ bot, cells, changes, stock, target });
    },
  });
  const candidates = () => {
    const positions = [...cells.keys()].filter((k) => cells.get(k) !== 'air').map((k) => new Vec3(...k.split(',').map(Number)));
    const center = bot.entity.position.floored();
    // Loaded chunk neighborhood only; an initial 96-block lookup cannot inspect
    // the eventual iron or diamond seam through an unloaded vertical column.
    for (const y of [16, 17, targetY]) if (Math.abs(y - center.y) <= 24) {
      for (let x = center.x - 24; x <= center.x + 24; x += 1) for (let z = center.z - 24; z <= center.z + 24; z += 1) {
        const p = new Vec3(x, y, z);
        if (generatedName(p).includes('_ore')) positions.push(p);
      }
    }
    for (let dx = -3; dx <= 3; dx += 1) for (let dz = -3; dz <= 3; dz += 1) for (let dy = -3; dy <= 1; dy += 1) {
      positions.push(center.offset(dx, dy, dz));
    }
    return positions.filter((p) => p.distanceTo(bot.entity.position) <= 32).sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
  };
  bot.findBlocks = (query) => candidates().filter((p) => {
    const b = blockAt(p);
    return b && p.distanceTo(bot.entity.position) <= (query.maxDistance || 16) &&
      (typeof query.matching === 'function' ? query.matching(b) : Array.isArray(query.matching) ? query.matching.includes(b.type) : b.type === query.matching);
  }).slice(0, query.count || 1);
  bot.findBlock = (query) => { const p = bot.findBlocks({ ...query, count: 1 })[0]; return p ? blockAt(p) : null; };
  const walkable = (p) => blockAt(p)?.boundingBox === 'empty' && blockAt(p.offset(0, 1, 0))?.boundingBox === 'empty' &&
    blockAt(p.offset(0, -1, 0))?.boundingBox === 'block' && !['lava', 'water', 'magma_block', 'gravel'].includes(blockAt(p.offset(0, -1, 0))?.name);
  const goto = async (goal) => {
    const start = bot.entity.position.floored();
    const queue = [start], seen = new Set([key(start)]), parents = new Map();
    let end;
    for (let n = 0; n < queue.length && n < 8000; n += 1) {
      const p = queue[n];
      if (goal.isEnd ? goal.isEnd(p) : p.distanceTo(new Vec3(goal.x, goal.y, goal.z)) <= (goal.range || 0)) { end = p; break; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1, -1]) {
        const next = p.offset(dx, dy, dz); const k = key(next);
        if (seen.has(k) || !walkable(next) || next.distanceTo(start) > 160) continue;
        seen.add(k); parents.set(k, p); queue.push(next);
      }
    }
    if (!end) throw new Error(`No excavated path from ${key(start)} to ${goal.x},${goal.y},${goal.z}`);
    const route = [];
    for (let p = end; key(p) !== key(start); p = parents.get(key(p))) route.push(p);
    for (const p of route.reverse()) { assert.equal(walkable(p), true); bot.entity.position = p.offset(0.5, 0, 0.5); changes.moves.push(p); pickup(); }
  };
  bot.pathfinder = { setGoal: () => {}, stop: () => {}, setMovements: (movements) => { bot.pathfinder.movements = movements; },
    bestHarvestTool: (target) => items().filter((i) => target.canHarvest(i.type))
      .sort((a, b) => target.digTime(a.type, false, false, false) - target.digTime(b.type, false, false, false))[0] || null,
    goto,
  };
  require('mineflayer/lib/plugins/craft')(bot);
  bot.craft = async (recipe, repeats, table) => {
    assert.ok(!table || blockAt(table.position).name === 'crafting_table');
    changes.crafts.push({ name: registry.items[recipe.result.id].name, repeats, table: table?.position });
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const delta of recipe.delta) assert.ok((stock.get(registry.items[delta.id].name) || 0) + delta.count >= 0, 'Missing real recipe ingredient');
      for (const delta of recipe.delta) add(registry.items[delta.id].name, delta.count);
    }
  };
  const furnaceStates = new Map();
  bot.openFurnace = async (furnaceBlock) => {
    assert.equal(blockAt(furnaceBlock.position).name, 'furnace');
    const furnaceKey = key(furnaceBlock.position);
    let f = furnaceStates.get(furnaceKey);
    if (!f) { f = { input: 0, output: 0, fuel: 0, burn: 0, progress: 0, last: Date.now(), fuelName: 'coal' }; furnaceStates.set(furnaceKey, f); }
    const update = () => {
      let elapsed = Date.now() - f.last; f.last = Date.now();
      while (elapsed > 0) {
        if (f.burn <= 0 && f.fuel > 0) { f.fuel -= 1; f.burn = f.fuelName.endsWith('_planks') ? 15_000 : 80_000; }
        if (f.burn <= 0) break;
        const step = Math.min(elapsed, f.burn, f.input > 0 ? 10_000 - f.progress : elapsed);
        f.burn -= step; elapsed -= step;
        if (f.input > 0) { f.progress += step; if (f.progress >= 10_000) { f.progress = 0; f.input -= 1; f.output += 1; changes.smelts += 1; } }
      }
    };
    return {
      get fuel() { update(); return f.burn / 80_000; }, get fuelSeconds() { update(); return f.burn / 1000; },
      get progress() { update(); return f.progress / 10_000; },
      inputItem: () => { update(); return f.input ? { name: minY < 0 ? 'raw_iron' : 'iron_ore', count: f.input } : null; },
      outputItem: () => { update(); return f.output ? { name: 'iron_ingot', count: f.output } : null; },
      fuelItem: () => { update(); return f.fuel ? { name: f.fuelName, count: f.fuel } : null; },
      putInput: async (type, _meta, count) => { add(registry.items[type].name, -count); f.input += count; },
      putFuel: async (type, _meta, count) => { f.fuelName = registry.items[type].name; add(f.fuelName, -count); f.fuel += count; },
      takeOutput: async () => { update(); add('iron_ingot', f.output); f.output = 0; }, close: () => {},
    };
  };
  let plannerRequests = 0;
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: options.mode || 'strict-executor', mcAgentAutoReconnect: false }), parseJsonObjectFromText: JSON.parse,
    broadcast: () => {}, broadcastMinecraftError: () => {}, allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { plannerRequests += 1; throw new Error('Expedition must complete without an AI provider'); },
  });
  const physicsInterval = setInterval(pickup, 50);
  agent.attachBot(bot);
  const step = { skill: 'mine_resource', args: { block: 'diamond', count: options.count || 1, expedition: true,
    maxSearchSteps: options.maxSearchSteps ?? 1000, maxActions: options.maxActions ?? 4096 } };
  const task = { taskId: 'diamond-expedition', source: 'deskpet', status: 'running', startedAt: Date.now(),
    intent: 'mine_diamond_resource', logs: [], currentStepIndex: 0, currentStep: 'mine_resource',
    plan: { intent: 'mine_diamond_resource', goal: '从零开始挖到钻石', steps: [step] } };
  // Direct executor hooks bypass runTaskExecution, which normally claims this
  // lease before starting a task. Use the real engine owner in this fixture too.
  task.movementLease = agent.__testClaimMovementLease('task', task.taskId);
  agent.__testSetReconnectTask(task);
  t.after(() => { clearInterval(physicsInterval); agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    t.mock.timers.reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  const finish = async (promise, timeout = 3_600_000) => {
    let settled = false, value, error;
    promise.then((v) => { value = v; settled = true; }, (e) => { error = e; settled = true; });
    for (let elapsed = 0; !settled && elapsed < timeout; elapsed += 100) {
      t.mock.timers.tick(100); for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    assert.equal(settled, true, 'Expedition must terminate within its bounded deadline');
    if (error) {
      error.message += ` [fixture: position=${key(bot.entity.position)}, phase=${task.diamondExpedition?.phase}, ` +
        `cause=${error.cause?.message || ''}, causePosition=${JSON.stringify(error.cause?.position)}, ` +
        `stations=${JSON.stringify(changes.placements.filter((p) => ['crafting_table', 'furnace'].includes(p.name)))}, ` +
        `lastMoves=${JSON.stringify(changes.moves.slice(-4))}]`;
      throw error;
    }
    return value;
  };
  const until = async (predicate, timeout = 600_000) => {
    for (let elapsed = 0; elapsed < timeout; elapsed += 100) {
      if (predicate()) return;
      t.mock.timers.tick(100); for (let i = 0; i < 20; i += 1) await Promise.resolve();
    }
    assert.fail(`Task transition did not arrive: ${agent.__testGetReconnectTask()?.status}, ${agent.__testGetReconnectTask()?.progressText}`);
  };
  return { bot, agent, task, step, stock, cells, changes, unknown, finish, until, surface, targetY,
    plannerRequests: () => plannerRequests };
}

for (const version of ['1.21.8', '1.16.5']) {
  test(`from zero on Java ${version}: craft stations and tools, descend, prospect buried ore, smelt, and collect an actual diamond`, async (t) => {
    const f = fixture(t, { version });
    assert.equal(f.stock.size, 0, 'Food and tools must also start absent from the inventory');
    assert.equal(f.bot.findBlocks({ matching: (b) => b.name.includes('diamond_ore'), maxDistance: 96, count: 1 }).length, 0);
    assert.equal(f.bot.findBlocks({ matching: (b) => b.name.includes('iron_ore'), maxDistance: 96, count: 1 }).length, 0);
    await f.finish(f.agent.__testExecuteMineResource(f.step));
    assert.ok(f.changes.digs.some((dig) => dig.name === 'carrots'), 'Prepared food comes from harvested world resources');
    assert.ok((f.stock.get('carrot') || 0) >= 8, 'The initial food reserve is actually picked up');
    assert.ok((f.stock.get('diamond') || 0) >= 1, 'Completion requires collected inventory, not finding an ore block');
    for (const name of ['crafting_table', 'furnace']) assert.ok(f.changes.placements.some((p) => p.name === name), `${name} was made and placed from scratch`);
    for (const name of ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe']) assert.ok(f.changes.crafts.some((c) => c.name === name), `Real recipe crafted ${name}`);
    assert.ok(f.changes.smelts >= 3);
    assert.ok(f.changes.moves.some((p) => p.y <= f.targetY), 'The bot physically descends to the diamond band');
    assert.ok(f.changes.digs.some((d) => d.name.includes('diamond_ore') && d.position.y === f.targetY));
    assert.ok(f.changes.digs.filter((d) => d.name === 'stone' || d.name === 'deepslate').length > 100, 'The underground route was actually excavated');
    assert.ok(f.changes.moves.some((p) => p.y === f.targetY && p.z !== 0), 'A branch reaches buried ore away from the descending shaft');
  });
}

test('a finite no-ore search preserves failure and never invents diamond completion', async (t) => {
  const f = fixture(t, { initial: { iron_pickaxe: 1, oak_planks: 64, stick: 64 }, diamond: false, maxSearchSteps: 24, surface: 20 });
  await assert.rejects(f.finish(f.agent.__testExecuteMineResource(f.step)), /钻石|搜索|探矿|预算|矿|search|limit/i);
  assert.equal(f.stock.get('diamond') || 0, 0);
  assert.ok(f.task.stepCheckpoint || f.task.diamondExpedition, 'The route remains available for retry / resume');
});

// These short route regressions restore an already supplied expedition. The
// real registry harvest requirements and checked voxel navigation still run;
// unrelated bootstrap/smelting is covered by the from-zero cases above.
function suppliedExpedition(f) {
  const levels = getMiningLevels(f.bot, { targetY: 16 });
  let checkpoint = { schema: 1, targetCount: 1, levels, targetY: levels.targetY,
    heading: 0, searchSteps: 0, avoidedHazards: 0, ignoredOres: [],
    base: { x: 0, y: f.surface, z: 0 }, prepared: true, stonePrepared: true, foodPrepared: true };
  const expedition = createDiamondExpedition({ getBot: () => f.bot,
    getCheckpoint: () => checkpoint, saveCheckpoint: (state) => { checkpoint = state; },
    equipItem: (item) => f.bot.equip(item), digBlock: (block) => f.bot.dig(block) });
  return { run: () => expedition.run({ args: { count: 1, targetY: 16, maxSearchSteps: 8 } }),
    checkpoint: () => checkpoint };
}

test('natural redstone and gold use iron before stone preference, while obsidian is safely bypassed', async (t) => {
  const harvested = [];
  const f = fixture(t, { surface: 20, iron: false, diamond: false,
    initial: { stone_pickaxe: 1, iron_pickaxe: 1 },
    afterDig: ({ bot, target }) => { harvested.push({ name: target.name, tool: bot.heldItem?.name }); } });
  for (const [position, name] of [['1,19,0', 'redstone_ore'], ['2,18,0', 'gold_ore'], ['3,17,0', 'obsidian']]) {
    f.cells.set(position, name);
  }
  const expedition = suppliedExpedition(f);
  await assert.rejects(f.finish(expedition.run()), (error) => error.code === 'mining_search_exhausted');
  for (const name of ['redstone_ore', 'gold_ore']) {
    assert.deepEqual(harvested.filter((dig) => dig.name === name).map((dig) => dig.tool), ['iron_pickaxe']);
  }
  assert.ok(harvested.some((dig) => dig.name === 'stone' && dig.tool === 'stone_pickaxe'), 'Preference still conserves iron on ordinary stone');
  assert.equal(f.cells.get('3,17,0'), 'obsidian', 'No diamond pickaxe means the obstruction remains intact');
  assert.equal(harvested.some((dig) => dig.name === 'obsidian'), false);
  assert.ok(expedition.checkpoint().avoidedHazards >= 1);
  assert.ok(f.changes.moves.some((position) => position.z !== 0), 'The bounded search proceeds through an alternate safe corridor');
  assert.equal(f.bot.entity.position.y, f.surface, 'The route still supports a confirmed retreat after the budget ends');
});

test('natural redstone and gold are bypassed intact when only a stone pickaxe is available', async (t) => {
  const f = fixture(t, { surface: 20, iron: false, diamond: false, initial: { stone_pickaxe: 1 } });
  f.cells.set('1,19,0', 'redstone_ore');
  f.cells.set('0,19,1', 'gold_ore');
  const expedition = suppliedExpedition(f);
  await assert.rejects(f.finish(expedition.run()), (error) => error.code === 'mining_search_exhausted');
  assert.equal(f.cells.get('1,19,0'), 'redstone_ore');
  assert.equal(f.cells.get('0,19,1'), 'gold_ore');
  assert.equal(f.changes.digs.some((dig) => ['redstone_ore', 'gold_ore'].includes(dig.name)), false);
  assert.ok(expedition.checkpoint().avoidedHazards >= 2);
  assert.ok(f.changes.moves.some((position) => position.z < 0), 'The iron search continues past both unharvestable candidate directions');
  assert.equal(f.bot.entity.position.y, f.surface);
});

test('stone pickaxe wear does not strand a full progression before the diamond band', async (t) => {
  const f = fixture(t, { breakStoneTool: true });
  await f.finish(f.agent.__testExecuteMineResource(f.step));
  assert.ok((f.stock.get('diamond') || 0) >= 1);
  assert.ok(f.changes.brokenTools.length > 0 || f.changes.crafts.filter((c) => c.name === 'stone_pickaxe').length > 1,
    'Long underground excavation must replenish or reserve tools');
});

test('a newly detected low-health condition stops the expedition and retreats instead of continuing the ore chase', async (t) => {
  let injected = false;
  const f = fixture(t, { initial: { iron_pickaxe: 1, oak_planks: 64, stick: 64 }, surface: 20,
    afterDig: ({ bot, changes }) => { if (!injected && changes.moves.some((p) => p.y < 16)) { injected = true; bot.health = 5; } } });
  await assert.rejects(f.finish(f.agent.__testExecuteMineResource(f.step)), /生命|健康|撤退|安全|health|retreat/i);
  assert.equal(injected, true);
  assert.equal(f.stock.get('diamond') || 0, 0);
  assert.ok(f.bot.entity.position.y >= 19, 'The bot should safely retrace the staircase to its starting base');
});

test('three requested diamonds require three actual pickups and a confirmed return, even in hybrid mode', async (t) => {
  const f = fixture(t, { count: 3, mode: 'experimental-autonomy' });
  await f.finish(f.agent.__testExecuteMineResource(f.step));
  assert.ok((f.stock.get('diamond') || 0) >= 3);
  assert.equal(f.task.diamondExpedition.targetCount, 3);
  assert.equal(f.task.diamondExpedition.phase, 'complete');
  assert.ok(f.bot.entity.position.y >= f.surface, 'Completion includes following the recorded route home');
  assert.equal(f.plannerRequests(), 0);
});

test('public hybrid submission uses the built-in expedition, preserves its depth on pause, and completes after resume', async (t) => {
  const f = fixture(t, { mode: 'experimental-autonomy' });
  f.agent.__testSetReconnectTask(null);
  await f.agent.handleMessage({ type: 'mc_command_submit', command: '从零开始挖到钻石', source: 'deskpet' });
  await f.until(() => f.bot.entity.position.y < 40);
  const running = f.agent.__testGetReconnectTask();
  assert.equal(running.plan.steps.some((step) => step.args?.block === 'diamond' && step.args?.expedition === true), true);
  const originalPlan = JSON.parse(JSON.stringify(running.plan));
  await f.finish(f.agent.handleMessage({ type: 'mc_command_pause' }));
  const pausedDepth = f.bot.entity.position.y;
  const actions = JSON.stringify([f.changes.digs.length, f.changes.moves.length, f.changes.placements.length]);
  for (let i = 0; i < 20; i += 1) { t.mock.timers.tick(100); for (let j = 0; j < 20; j += 1) await Promise.resolve(); }
  assert.equal(running.status, 'paused');
  assert.equal(JSON.stringify([f.changes.digs.length, f.changes.moves.length, f.changes.placements.length]), actions, 'A paused task dispatches no physical world writes');
  assert.equal(f.bot.entity.position.y, pausedDepth);
  assert.deepEqual(running.plan, originalPlan);
  await f.finish(f.agent.handleMessage({ type: 'mc_command_resume' }));
  await f.until(() => ['completed', 'failed', 'blocked'].includes(running.status), 3_600_000);
  assert.equal(running.status, 'completed', running.error || running.progressText);
  assert.ok((f.stock.get('diamond') || 0) >= 1);
  assert.equal(f.plannerRequests(), 0);
});

test('cancelling a public underground expedition stops world writes and cannot later report completion', async (t) => {
  const f = fixture(t);
  f.agent.__testSetReconnectTask(null);
  await f.agent.handleMessage({ type: 'mc_command_submit', command: '从零开始挖到钻石', source: 'deskpet' });
  await f.until(() => f.bot.entity.position.y < 40);
  const running = f.agent.__testGetReconnectTask();
  await f.finish(f.agent.handleMessage({ type: 'mc_command_cancel' }));
  const actions = JSON.stringify([f.changes.digs.length, f.changes.moves.length, f.changes.placements.length]);
  for (let i = 0; i < 30; i += 1) { t.mock.timers.tick(100); for (let j = 0; j < 20; j += 1) await Promise.resolve(); }
  assert.equal(running.status, 'cancelled');
  assert.equal(f.agent.__testGetReconnectTask(), null);
  assert.equal(JSON.stringify([f.changes.digs.length, f.changes.moves.length, f.changes.placements.length]), actions);
  assert.equal(f.stock.get('diamond') || 0, 0);
});

test('mining depth respects server-advertised custom heights and refuses a non-overworld dimension', () => {
  assert.equal(getMiningLevels({ version: '1.21.8', game: { dimension: 'overworld', minY: -32, height: 256 } }).targetY, -21);
  assert.equal(getMiningLevels({ version: '1.16.5', game: { dimension: 'overworld' } }).targetY, 11);
  assert.equal(getMiningLevels({ version: '1.21.8', game: { dimension: 'overworld' } }).targetY, -53);
  assert.throws(() => getMiningLevels({ game: { dimension: 'the_nether', minY: 0, height: 256 } }), (error) => error.code === 'mining_wrong_dimension');
  assert.throws(() => getMiningLevels({ game: { dimension: 'overworld', minY: -64, height: 0 } }), (error) => error.code === 'mining_world_height');
});

test('pickaxe durability uses the installed registry and actual per-item wear', () => {
  const registry = require('prismarine-registry')('1.21.8');
  assert.equal(remainingDurability({ name: 'stone_pickaxe', durabilityUsed: 128 }, registry), 3);
  assert.equal(remainingDurability({ name: 'iron_pickaxe', durabilityUsed: 250 }, registry), 0);
  assert.equal(remainingDurability({ name: 'stone_pickaxe', durabilityUsed: 0 }, registry), 131);
});

test('a deep lava wall changes the mine direction while the expedition still reaches and collects a diamond', async (t) => {
  const f = fixture(t, { surface: 20, lavaWall: true,
    initial: { oak_planks: 64, stick: 64, cobblestone: 20, stone_pickaxe: 3, iron_pickaxe: 1 } });
  await f.finish(f.agent.__testExecuteMineResource(f.step));
  assert.ok((f.stock.get('diamond') || 0) >= 1);
  assert.ok(f.task.diamondExpedition.avoidedHazards > 0);
  assert.equal(f.changes.digs.some((d) => d.name === 'lava'), false);
  assert.equal(f.changes.moves.some((p) => p.x >= 15), false, 'The bot stays on the safe side of the lava wall');
  assert.equal(f.task.diamondExpedition.phase, 'complete');
});

test('a search-budget interruption resumes the original mine and completes without rebuilding the finished bootstrap', async (t) => {
  const f = fixture(t, { surface: 20, maxSearchSteps: 24,
    initial: { oak_planks: 64, stick: 64, cobblestone: 20, stone_pickaxe: 3, iron_pickaxe: 1 } });
  await assert.rejects(f.finish(f.agent.__testExecuteMineResource(f.step)), (error) => error.code === 'mining_search_exhausted');
  const originalRoute = JSON.parse(JSON.stringify(f.task.diamondExpedition.navigation.breadcrumbs));
  const stations = f.changes.placements.filter((p) => ['crafting_table', 'furnace'].includes(p.name)).length;
  assert.equal(f.stock.get('diamond') || 0, 0);
  f.step.args.maxSearchSteps = 1000;
  await f.finish(f.agent.__testExecuteMineResource(f.step));
  assert.ok((f.stock.get('diamond') || 0) >= 1);
  assert.deepEqual(f.task.diamondExpedition.navigation.breadcrumbs.slice(0, originalRoute.length), originalRoute);
  assert.equal(f.changes.placements.filter((p) => ['crafting_table', 'furnace'].includes(p.name)).length, stations);
  assert.equal(f.task.diamondExpedition.targetCount, 1);
});

test('a nearly exhausted iron pickaxe is replaced before attempting diamond ore', async (t) => {
  const f = fixture(t, { surface: 20, initialDamage: { iron_pickaxe: 245 },
    initial: { oak_planks: 64, stick: 64, cobblestone: 20, stone_pickaxe: 3, iron_pickaxe: 1 } });
  await f.finish(f.agent.__testExecuteMineResource(f.step));
  assert.ok(f.changes.crafts.some((c) => c.name === 'iron_pickaxe'));
  assert.ok((f.stock.get('diamond') || 0) >= 1);
});
