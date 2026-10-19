/* global require, process, setTimeout, setInterval, clearInterval */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');

function fixture(t, initial = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-bootstrap-'));
  Object.assign(process.env, { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'), MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const stock = new Map(Object.entries(initial));
  const items = () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({
    name, displayName: name, count, type: registry.itemsByName[name].id, metadata: 0,
  }));
  const add = (name, count) => stock.set(name, (stock.get(name) || 0) + count);
  const changes = { digs: [], crafts: [], furnaceOpens: 0, clears: 0, goals: [], movements: [] };
  const world = new Map();
  const air = new Set();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const block = (name, position) => Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position });
  for (let i = 1; i <= 32; i += 1) world.set(`${i},64,0`, block('oak_log', new Vec3(i, 64, 0)));
  if (options.table !== false) world.set('0,64,2', block('crafting_table', new Vec3(0, 64, 2)));
  if (options.furnace) world.set('0,64,1', block('furnace', new Vec3(0, 64, 1)));
  if (options.iron) for (let i = 1; i <= 3; i += 1) {
    world.set(`${i},63,2`, block('iron_ore', new Vec3(i, 63, 2)));
  }
  if (options.diamond) world.set('3,63,3', block('diamond_ore', new Vec3(3, 63, 3)));
  if (options.foodCrops) for (let i = 1; i <= 8; i += 1) {
    const position = new Vec3(i, 64, 4);
    world.set(key(position), Object.assign(Block.fromProperties('carrots', { age: 7 }, 0), { position }));
    world.set(key(position.offset(0, -1, 0)), block('farmland', position.offset(0, -1, 0)));
  }
  const bot = new EventEmitter();
  Object.assign(bot, { username: 'DeskPet', health: 20, food: 20, registry, entities: {}, players: {},
    entity: { position: new Vec3(0, 64, 0), effects: {}, onGround: true },
    inventory: { items, count: (id) => items().filter((i) => i.type === id).reduce((sum, i) => sum + i.count, 0) },
    game: { dimension: 'overworld', gameMode: 'survival' }, player: { ping: 1 },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    clearControlStates: () => { changes.clears += 1; },
    blockAt: (p) => world.get(key(p)) || block(p.y < 64 && !air.has(key(p)) ? 'stone' : 'air', p.floored()),
    canDigBlock: () => true,
    lookAt: async () => {},
    equip: async (item) => { bot.heldItem = item; },
    placeBlock: async (reference, face) => {
      const p = reference.position.plus(face);
      const name = bot.heldItem.name;
      add(name, -1);
      world.set(key(p), block(name === 'carrot' ? 'carrots' : name, p));
    },
    dig: async (target) => {
      changes.digs.push(target.name);
      world.delete(key(target.position)); air.add(key(target.position));
      if (!target.canHarvest(bot.heldItem?.type ?? null)) return;
      add(target.name === 'carrots' ? 'carrot' : target.name === 'stone' ? 'cobblestone' : target.name === 'iron_ore' ? 'raw_iron' : target.name === 'diamond_ore' ? 'diamond' : target.name,
        target.name === 'carrots' && Number(target.getProperties().age) === 7 ? 3 : 1);
    },
  });
  const candidates = () => [...world.values(), ...Array.from({ length: 20 }, (_, index) => block('stone', new Vec3(index, 63, -1)))];
  bot.findBlocks = (query) => candidates().filter((b) => query.matching(b) && !air.has(key(b.position)))
    .slice(0, query.count || 1).map((b) => b.position);
  bot.findBlock = (query) => candidates().find((b) => query.matching(b) && !air.has(key(b.position))) || null;
  bot.pathfinder = { setGoal: () => {}, stop: () => {}, setMovements: (movements) => { changes.movements.push(movements);bot.pathfinder.movements=movements; },
    bestHarvestTool: (target) => items().filter((i) => target.canHarvest(i.type))
      .sort((a, b) => target.digTime(a.type, false, false, false) - target.digTime(b.type, false, false, false))[0] || null,
    goto: async (goal) => {
      changes.goals.push(goal);
      bot.entity.position = goal.entity ? goal.entity.position.offset(1, 0, 0)
        : new Vec3(goal.x ?? bot.entity.position.x, goal.y ?? bot.entity.position.y, goal.z ?? bot.entity.position.z);
    },
  };
  // Keep installed Mineflayer's real recipe lookup and output-count semantics.
  require('mineflayer/lib/plugins/craft')(bot);
  bot.craft = async (recipe, repeats) => {
    changes.crafts.push({ output: registry.items[recipe.result.id].name, repeats });
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const delta of recipe.delta) {
        const name = registry.items[delta.id].name;
        if ((stock.get(name) || 0) + delta.count < 0) throw new Error(`Missing recipe ingredient ${name}`);
      }
      for (const delta of recipe.delta) add(registry.items[delta.id].name, delta.count);
    }
  };
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: () => {}, broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false, requestPlannerCompletion: async () => { throw new Error('Unexpected planner'); },
  });
  agent.attachBot(bot);
  const task = { taskId: 'bootstrap-smelt', status: 'running', source: 'deskpet', logs: [],
    startedAt: Date.now(), currentStepIndex: 0, plan: { steps: [] } };
  agent.__testSetReconnectTask(task);
  t.after(() => { agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    t.mock.timers.reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function finish(promise, timeout = 180_000) {
    let settled = false, value, error;
    promise.then((v) => { value = v; settled = true; }, (e) => { error = e; settled = true; });
    for (let elapsed = 0; !settled && elapsed < timeout; elapsed += 100) {
      t.mock.timers.tick(100);
      for (let i = 0; i < 15; i += 1) await Promise.resolve();
    }
    assert.equal(settled, true, 'Fake world action must terminate within its bounded deadline');
    if (error) throw error;
    return value;
  }
  return { agent, bot, stock, add, changes, task, finish };
}

function furnaceFixture(state, options = {}) {
  let input = options.queued || 0, output = 0, fuelSlot = 0;
  let burn = options.burning || 0, progress = 0, last = Date.now();
  let fuelName = 'coal';
  const inputName = options.inputName || 'raw_iron';
  const outputName = options.outputName || 'iron_ingot';
  let inventoryStock = state.stock;
  const addInventory = (name, count) => {
    assert.ok((inventoryStock.get(name) || 0) + count >= 0, `Actual furnace window has enough ${name}`);
    inventoryStock.set(name, (inventoryStock.get(name) || 0) + count);
  };
  const update = () => {
    if (options.stalled) { last = Date.now(); return; }
    let elapsed = Date.now() - last; last = Date.now();
    while (elapsed > 0) {
      if (burn <= 0 && fuelSlot > 0) { fuelSlot -= 1; burn = fuelName.endsWith('_planks') ? 15_000 : 80_000; }
      if (burn <= 0) break;
      const step = Math.min(elapsed, burn, input > 0 ? 10_000 - progress : elapsed);
      burn -= step; elapsed -= step;
      if (input > 0) { progress += step; if (progress >= 10_000) { progress = 0; input -= 1; output += 1; } }
    }
  };
  const furnace = {
    // Mineflayer keeps a separate player inventory view while this window is open.
    items: () => [...inventoryStock].filter(([, count]) => count > 0).map(([name, count]) => ({
      name, count, type: registry.itemsByName[name].id, metadata: 0,
    })),
    get fuel() { update(); return options.stalled ? 0.8 : burn / 80_000; },
    get fuelSeconds() { update(); return options.stalled ? 64 : burn / 1000; },
    get progress() { update(); return options.stalled ? 0.2 : progress / 10_000; },
    inputItem: () => { update(); return input ? { name: inputName, count: input } : null; },
    outputItem: () => { update(); return output ? { name: outputName, count: output } : null; },
    fuelItem: () => { update(); return fuelSlot ? { name: fuelName, count: fuelSlot } : null; },
    putInput: async (_type, _metadata, count) => { addInventory(inputName, -count); input += count; },
    putFuel: async (type, _metadata, count) => { fuelName = registry.items[type].name; addInventory(fuelName, -count); fuelSlot += count; },
    takeOutput: async () => { addInventory(outputName, output); output = 0; },
    close: () => {
      if (options.separateInventory) {
        state.stock.clear();
        for (const [name, count] of inventoryStock) state.stock.set(name, count);
      }
    },
  };
  state.bot.openFurnace = async () => {
    state.changes.furnaceOpens += 1;
    if (options.separateInventory) inventoryStock = new Map(state.stock);
    return furnace;
  };
  return furnace;
}

for(const replacement of [false,true])test(`closed furnace interrupts promptly and preserves queued iron for reopen without closing a replacement: replacement=${replacement}`,async t=>{
 const state=fixture(t,{raw_iron:3,coal:1},{furnace:true});
 const furnace=furnaceFixture(state,{separateInventory:true});furnace.id=7;
 const open=state.bot.openFurnace,close=furnace.close;let closes=0;
 furnace.close=()=>{closes++;close();if(state.bot.currentWindow===furnace)state.bot.currentWindow=null;};
 state.bot.openFurnace=async()=>{const value=await open();state.bot.currentWindow=value;return value;};
 let foreign;
 setTimeout(()=>{furnace.close();foreign=replacement?{id:8}:null;state.bot.currentWindow=foreign;},2000);
 await assert.rejects(state.finish(state.agent.__testExecuteSmeltItem({args:{input:'raw_iron',output:'iron_ingot',additionalCount:3}}),10000),{code:'house_furnace_window_closed'});
 assert.equal(state.bot.currentWindow,foreign);assert.equal(closes,1);
 assert.equal((state.stock.get('raw_iron')||0)+(furnace.inputItem()?.count||0)+(furnace.outputItem()?.count||0),3);
 await state.finish(state.agent.__testExecuteSmeltItem({args:{input:'raw_iron',output:'iron_ingot',additionalCount:3}}));
 assert.equal(state.stock.get('iron_ingot'),3);assert.equal(furnace.inputItem(),null);
});

for(const mode of ['resumed','fighting','foreign_window','new_generation','pending_cover'])test(`owned smelt resumes only a settled same-owner combat closure: ${mode}`,async t=>{
 const state=fixture(t,{raw_iron:3,coal:1},{furnace:true});
 const furnace=furnaceFixture(state,{separateInventory:true});furnace.id=7;
 state.task.executionGeneration=1;
 state.task.materialSupply={materialSource:'self_gathered',ownedStations:{furnace:{confirmedPlaced:true,position:{x:0,y:64,z:1}}}};
 const open=state.bot.openFurnace,close=furnace.close;
 furnace.close=()=>{close();if(state.bot.currentWindow===furnace)state.bot.currentWindow=null;};
 state.bot.openFurnace=async()=>{const value=await open();state.bot.currentWindow=value;return value;};
 setTimeout(()=>{
  furnace.close();
  state.task.materialSupply.combatMode={phase:mode==='fighting'?'fighting':'resumed',startedAt:Date.now()-100,cleanupPending:mode==='pending_cover'?1:0};
  if(mode==='foreign_window')state.bot.currentWindow={id:8};
  if(mode==='new_generation')state.task.executionGeneration++;
 },2000);
 const running=state.finish(state.agent.__testExecuteSmeltItem({args:{input:'raw_iron',output:'iron_ingot',additionalCount:3}}));
 if(mode==='resumed'){
  await running;assert.equal(state.stock.get('iron_ingot'),3);assert.equal(state.stock.get('raw_iron'),0);
  assert.equal(state.changes.furnaceOpens,2);assert.equal(furnace.inputItem(),null);
 }else{
  await assert.rejects(running,{code:'house_furnace_window_closed'});assert.equal(state.changes.furnaceOpens,1);
  assert.equal((state.stock.get('raw_iron')||0)+(furnace.inputItem()?.count||0)+(furnace.outputItem()?.count||0),3);
 }
});

test('one remaining log is consumed, then real bootstrap gathers the missing house materials', async (t) => {
  const state = fixture(t, { oak_log: 1 });
  assert.equal(await state.finish(state.agent.__testEnsurePlanks(35)), true);
  assert.ok(state.stock.get('oak_planks') >= 35);
  assert.equal(state.changes.digs.length, 8);
});

test('empty inventory material demand larger than eight logs is fulfilled in bounded batches', async (t) => {
  const state = fixture(t);
  assert.equal(await state.finish(state.agent.__testEnsurePlanks(64)), true);
  assert.equal(state.stock.get('oak_planks'), 64);
  assert.equal(state.changes.digs.length, 16);
});

test('stick output count uses installed recipes and gathers enough planks for all recipe batches', async (t) => {
  const state = fixture(t, { oak_planks: 4 });
  assert.equal(await state.finish(state.agent.__testEnsureSticks(8)), true);
  assert.equal(state.stock.get('stick'), 8);
  assert.equal(state.changes.crafts.filter((craft) => craft.output === 'stick')
    .reduce((sum, craft) => sum + craft.repeats, 0), 2);
});

test('multi-tool crafting waits for delayed inventory and adds exactly the requested tools', async (t) => {
  const state = fixture(t, { cobblestone: 9, stick: 6, stone_pickaxe: 1 });
  const craft = state.bot.craft;
  state.bot.craft = async (recipe, repeats) => {
    assert.equal(repeats, 1, 'A fresh table session must own each recipe transaction');
    const previous = state.stock.get('stone_pickaxe');
    await craft(recipe, repeats);
    const updated = state.stock.get('stone_pickaxe');
    state.stock.set('stone_pickaxe', previous);
    setTimeout(() => state.stock.set('stone_pickaxe', updated), 250);
  };
  await state.finish(state.agent.__testCraftItemByName('stone_pickaxe', 3,
    state.bot.blockAt(new Vec3(0, 64, 2))));
  assert.equal(state.stock.get('stone_pickaxe'), 4);
  assert.equal(state.stock.get('cobblestone'), 0);
  assert.equal(state.stock.get('stick'), 0);
});

test('a craft with no observed output stops before consuming another recipe', async (t) => {
  const state = fixture(t, { cobblestone: 9, stick: 6 });
  let calls = 0;
  state.bot.craft = async () => { calls += 1; };
  await assert.rejects(state.finish(state.agent.__testCraftItemByName('stone_pickaxe', 3,
    state.bot.blockAt(new Vec3(0, 64, 2)))), /没有确认新增产物/);
  assert.equal(calls, 1);
});

test('wooden pickaxe preparation preserves three planks after sticks and station requirements', async (t) => {
  const state = fixture(t, { oak_log: 1 });
  await state.finish(state.agent.__testPrepareForCraftItem('wooden_pickaxe', 1));
  assert.ok(state.stock.get('oak_planks') >= 3);
  assert.ok(state.stock.get('stick') >= 2);
  assert.ok(state.bot.recipesFor(registry.itemsByName.wooden_pickaxe.id, null, 1, state.bot.findBlock({ matching: (b) => b.name === 'crafting_table' })).length > 0);
});

test('three iron ingots finish from an already burning empty fuel slot without spare inventory coal', async (t) => {
  const state = fixture(t, {}, { furnace: true });
  furnaceFixture(state, { queued: 3, burning: 64_000 });
  const step = { skill: 'smelt_item', args: { inputItems: ['raw_iron'], output: 'iron_ingot', count: 3 } };
  state.task.plan.steps = [step];
  await state.finish(state.agent.__testExecuteStepWithWatchdog(state.task, step));
  assert.equal(state.stock.get('iron_ingot'), 3);
  assert.equal(state.task.lastRecoveryReason, null);
});

test('smelting preserves building planks even when their inventory slot precedes coal',async t=>{
  const state=fixture(t,{oak_planks:6,raw_iron:1,coal:1},{furnace:true});
  furnaceFixture(state,{separateInventory:true});
  await state.finish(state.agent.__testExecuteSmeltItem({args:{inputItems:['raw_iron'],output:'iron_ingot',count:1}}));
  assert.equal(state.stock.get('iron_ingot'),1);
  assert.equal(state.stock.get('coal'),0);
  assert.equal(state.stock.get('oak_planks'),6);
});

test('partial output stock only needs the remaining raw inputs and one burning coal lasts the batch', async (t) => {
  const state = fixture(t, { iron_ingot: 1, raw_iron: 2, coal: 1 }, { furnace: true });
  furnaceFixture(state);
  await state.finish(state.agent.__testExecuteSmeltItem({ args: { inputItems: ['raw_iron'], output: 'iron_ingot', count: 3 } }));
  assert.equal(state.stock.get('iron_ingot'), 3);
});

test('smelting reads the active furnace inventory while the closed backpack view stays stale', async (t) => {
  const state = fixture(t, { raw_iron: 3, coal: 1 }, { furnace: true });
  const furnace = furnaceFixture(state, { separateInventory: true });
  const takeOutput = furnace.takeOutput;
  let outputs = 0;
  furnace.takeOutput = async () => {
    await takeOutput();
    outputs += 1;
    assert.equal(state.stock.get('raw_iron'), 3, 'Closed-window inventory remains unchanged until close');
    assert.equal(state.stock.get('iron_ingot') || 0, 0);
  };
  await state.finish(state.agent.__testExecuteSmeltItem({ args: {
    inputItems: ['raw_iron'], output: 'iron_ingot', count: 3,
  } }));
  assert.ok(outputs > 0);
  assert.equal(state.stock.get('iron_ingot'), 3);
  assert.equal(state.stock.get('raw_iron'), 0);
  assert.equal(state.stock.get('coal'), 0);
});

test('active furnace stock handles partial output and consuming the final wood fuel', async (t) => {
  const state = fixture(t, { iron_ingot: 1, raw_iron: 2, oak_planks: 2 }, { furnace: true });
  furnaceFixture(state, { separateInventory: true });
  await state.finish(state.agent.__testExecuteSmeltItem({ args: {
    inputItems: ['raw_iron'], output: 'iron_ingot', count: 3,
  } }));
  assert.equal(state.stock.get('iron_ingot'), 3);
  assert.equal(state.stock.get('raw_iron'), 0);
  assert.equal(state.stock.get('oak_planks'), 0);
  assert.equal(state.changes.furnaceOpens, 1, 'Consumed fuel must not be selected again from stale backpack stock');
});

test('explicit additional smelting produces eight more glass when the backpack already contains thirty-two', async (t) => {
  const state = fixture(t, { glass: 32, sand: 8, coal: 1 }, { furnace: true });
  furnaceFixture(state, { separateInventory: true, inputName: 'sand', outputName: 'glass' });
  await state.finish(state.agent.__testExecuteSmeltItem({ args: { input: 'sand', output: 'glass', additionalCount: 8 } }));
  assert.equal(state.stock.get('glass'), 40);
  assert.equal(state.stock.get('sand'), 0);
  await assert.rejects(state.agent.__testExecuteSmeltItem({ args: { input: 'sand', output: 'glass', additionalCount: 33 } }), { code: 'house_invalid_smelt_batch' });
});

test('smelting can replenish with wood fuel when no coal is available, reopening the same queued furnace', async (t) => {
  const state = fixture(t, { raw_iron: 3, oak_planks: 2 }, { furnace: true });
  furnaceFixture(state);
  await state.finish(state.agent.__testExecuteSmeltItem({ args: { inputItems: ['raw_iron'], output: 'iron_ingot', count: 3 } }));
  assert.equal(state.stock.get('iron_ingot'), 3);
});

test('natural food supply confirms animal death and picked meat, cooks it, and returns to camp', async (t) => {
  const state = fixture(t, { stone_sword: 1, oak_planks: 2 }, { furnace: true });
  furnaceFixture(state, { separateInventory: true, inputName: 'beef', outputName: 'cooked_beef' });
  const camp = state.bot.entity.position.clone();
  const cow = { id: 17, name: 'cow', type: 'animal', position: new Vec3(6, 64, 3), height: 1.4, metadata: {} };
  state.bot.entities[cow.id] = cow;
  const attacks = [];
  state.bot.attack = (target) => {
    attacks.push({ id: target.id, at: Date.now() });
    assert.equal(state.stock.get('cooked_beef') || 0, 0, 'Attack packets are not food');
    if (attacks.length === 2) {
      delete state.bot.entities[cow.id];
      state.add('beef', 3); // Controlled drop pickup fixture; live harness uses real server entities.
    }
  };
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(3, { anchor: camp, maxDistance: 16 })), true);
  assert.equal(attacks.length, 2);
  assert.ok(attacks[1].at - attacks[0].at >= 750, 'Sword swings respect attack cooldown');
  assert.equal(state.stock.get('cooked_beef'), 3);
  assert.equal(state.stock.get('beef'), 0);
  assert.equal(state.stock.get('oak_planks'), 0);
  assert.deepEqual(state.bot.entity.position.floored(), camp.floored());
  const huntingMovements = state.changes.movements.find((movement) => movement.canDig === false);
  assert.equal(huntingMovements.allowParkour, false);
  assert.equal(huntingMovements.scafoldingBlocks.length, 0);
  assert.ok(huntingMovements.blocksToAvoid.has(registry.blocksByName.water.id));
  assert.ok(huntingMovements.blocksToAvoid.has(registry.blocksByName.lava.id));
});

test('food supply excludes baby animals, named pets, players and hostile mobs', async (t) => {
  const state = fixture(t, { stone_sword: 1 }, { furnace: true });
  const make = (id, name, metadata = {}) => ({ id, name, metadata, type: 'animal', position: new Vec3(2, 64, id) });
  state.bot.entities = {
    1: make(1, 'cow', { 16: true }), 2: make(2, 'pig', { 2: 'My pet' }),
    3: { ...make(3, 'cow'), username: 'Player' }, 4: make(4, 'zombie'),
  };
  let attacks = 0;
  state.bot.attack = () => { attacks += 1; };
  await assert.rejects(state.finish(state.agent.__testEnsureFoodSupply(1,
    { anchor: new Vec3(0, 64, 0), maxDistance: 16 })), /自然食源不足.*0\/1/);
  assert.equal(attacks, 0);
  assert.deepEqual(state.bot.entity.position.floored(), new Vec3(0, 64, 0));
});

test('self supply startup can hunt an adult rabbit without tools and confirm raw food restores hunger before a furnace exists', async (t) => {
  const state = fixture(t);
  state.bot.food = 11;
  const rabbit = { id: 18, name: 'rabbit', type: 'animal', position: new Vec3(3, 64, 2), height: 0.5,
    metadata: { 16: false, 9: 3, 2: null } };
  state.bot.entities[rabbit.id] = rabbit;
  let attacks = 0;
  state.bot.attack = () => { attacks += 1; if (attacks === 3) { delete state.bot.entities[rabbit.id]; state.add('rabbit', 2); } };
  state.bot.consume = async () => { assert.equal(state.bot.heldItem.name, 'rabbit'); state.add('rabbit', -1); state.bot.food = Math.min(20, state.bot.food + 3); };
  await state.finish(state.agent.__testWithHouseResourceBounds([], () => state.agent.__testHouseBootstrapFood(16)));
  assert.equal(attacks, 3); assert.equal(state.bot.food, 17); assert.equal(state.stock.get('rabbit'), 0);
  assert.equal(state.changes.furnaceOpens, 0); assert.equal(state.changes.crafts.length, 0);
  assert.ok(state.changes.movements.some(m => m.canDig === false && m.allowSprinting === false));
});

test('surface route exclusions reject intermediate magma, head hazards and unloaded blocks', async (t) => {
  const state = fixture(t, { cooked_beef: 1 });
  const blockAt = state.bot.blockAt;
  state.bot.blockAt = (position) => {
    const p = position.floored();
    if (p.equals(new Vec3(3, 63, 0))) return Object.assign(Block.fromStateId(registry.blocksByName.magma_block.defaultState), { position: p });
    if (p.equals(new Vec3(3, 64, 0))) return Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState), { position: p });
    if (p.equals(new Vec3(4, 65, 0))) return Object.assign(Block.fromStateId(registry.blocksByName.fire.defaultState), { position: p });
    if (p.x === 5) return null;
    return blockAt(position);
  };
  await state.finish(state.agent.__testEnsureFoodSupply(1, { anchor: new Vec3(0, 64, 0) }));
  const movement = state.changes.movements.find((candidate) => candidate.canDig === false);
  const cost = (x, y = 64) => movement.exclusionStep({ position: new Vec3(x, y, 0) });
  assert.equal(cost(0), 0, 'Ordinary walkable feet remain allowed');
  assert.equal(cost(0, 65), 0, 'Head-clearance checks must not require a solid support floor');
  assert.ok(cost(3) >= 100, 'A safe final goal does not make an intermediate magma support safe');
  assert.ok(cost(4) >= 100);
  assert.ok(cost(5) >= 100);
  const unknown = movement.getBlock(new Vec3(4, 64, 0), 1, 0, 0);
  assert.equal(unknown.position, undefined, 'Installed pathfinder uses a coordinate-less unknown sentinel');
  assert.ok(movement.exclusionStep(unknown) >= 100, 'Unknown sentinel is rejected without crashing the physics event');
  assert.ok(movement.exclusionStep(null) >= 100);
  const unknownNeighbors = movement.getNeighbors(new (require('mineflayer-pathfinder/lib/move'))(4, 64, 0, 0, 0));
  assert.equal(unknownNeighbors.some(node => node.x === 5), false, 'Unknown chunk neighbors never become walkable');
  const Move = require('mineflayer-pathfinder/lib/move');
  const entersMagma = () => movement.getNeighbors(new Move(2, 64, 0, 0, 0))
    .some((node) => node.x === 3 && node.y === 64 && node.z === 0);
  assert.equal(entersMagma(), false, 'Installed pathfinder must reject the intermediate magma step');
  movement.exclusionAreasStep = [];
  assert.equal(entersMagma(), true, 'Negative control: a blocksToAvoid-only policy permits this magma support');
});

test('a low-health hunting failure immediately returns to camp without exploring another target', async (t) => {
  const state = fixture(t, { stone_sword: 1 }, { furnace: true });
  const camp = new Vec3(0, 64, 0);
  state.bot.entities = { 17: { id: 17, name: 'cow', type: 'animal', position: new Vec3(6, 64, 3), metadata: {} } };
  const goto = state.bot.pathfinder.goto;
  state.bot.pathfinder.goto = async (goal) => { await goto(goal); if (goal.entity) state.bot.health = 10; };
  let attacks = 0;
  state.bot.attack = () => { attacks += 1; };
  await assert.rejects(state.finish(state.agent.__testEnsureFoodSupply(3, { anchor: camp, maxDistance: 16 })),
    (error) => error.code === 'food_supply_low_health');
  assert.equal(attacks, 0);
  assert.equal(state.changes.goals.filter((goal) => goal.entity).length, 1);
  const huntedAt = state.changes.goals.findIndex((goal) => goal.entity);
  assert.equal(state.changes.goals.slice(huntedAt + 1).filter((goal) => goal.constructor.name === 'GoalBlock').length, 0,
    'Safety failure must not become a search for another animal');
  assert.deepEqual(state.bot.entity.position.floored(), camp);
});

test('hunting waits for landing before its first attack after an airborne goto result', async (t) => {
  const state = fixture(t, { stone_sword: 1, oak_planks: 1 }, { furnace: true });
  furnaceFixture(state, { inputName: 'beef', outputName: 'cooked_beef' });
  const cow = { id: 17, name: 'cow', type: 'animal', position: new Vec3(6, 64, 3), metadata: {} };
  state.bot.entities[cow.id] = cow;
  const goto = state.bot.pathfinder.goto;
  let landed = false;
  state.bot.pathfinder.goto = async (goal) => {
    await goto(goal);
    if (goal.entity) {
      state.bot.entity.onGround = false;
      setTimeout(() => { state.bot.entity.onGround = true; landed = true; }, 300);
    }
  };
  let attacks = 0;
  state.bot.attack = () => {
    assert.equal(landed, true);
    assert.equal(state.bot.entity.onGround, true);
    attacks += 1;
    delete state.bot.entities[cow.id];
    state.add('beef', 1);
  };
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(1, { anchor: new Vec3(0, 64, 0) })), true);
  assert.equal(attacks, 1);
});

test('a partial food reserve never counts as the requested complete expedition provision', async (t) => {
  const state = fixture(t, { stone_sword: 1, cooked_beef: 6 }, { furnace: true });
  await assert.rejects(state.finish(state.agent.__testEnsureFoodSupply(8,
    { anchor: new Vec3(0, 64, 0), maxDistance: 16 })), /自然食源不足.*6\/8/);
});

test('optional food-point reserve accepts three cooked pork or eight carrots, never raw meat', async (t) => {
  const state = fixture(t, { cooked_porkchop: 3 });
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(8,
    { anchor: new Vec3(0, 64, 0), minFoodPoints: 24 })), true);
  state.stock.clear(); state.add('carrot', 8);
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(8,
    { anchor: new Vec3(0, 64, 0), minFoodPoints: 24 })), true);
  assert.equal(state.changes.digs.length, 0);
});

test('raw pork fulfills a food-point reserve only after confirmed cooking output', async (t) => {
  const state = fixture(t, { porkchop: 3, oak_planks: 2 }, { furnace: true });
  furnaceFixture(state, { inputName: 'porkchop', outputName: 'cooked_porkchop', separateInventory: true });
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(8,
    { anchor: new Vec3(0, 64, 0), minFoodPoints: 24 })), true);
  assert.equal(state.stock.get('porkchop'), 0);
  assert.equal(state.stock.get('cooked_porkchop'), 3);
  assert.equal(state.changes.furnaceOpens, 1, 'Raw food is not an early completion');
});

test('a naturally distant animal gets enough bounded time for ordinary progress beyond six seconds', async (t) => {
  const state = fixture(t, { stone_sword: 1, oak_planks: 1 }, { furnace: true });
  furnaceFixture(state, { inputName: 'porkchop', outputName: 'cooked_porkchop' });
  const pig = { id: 17, name: 'pig', type: 'animal', position: new Vec3(40, 64, 3), metadata: {} };
  state.bot.entities[pig.id] = pig;
  const goto = state.bot.pathfinder.goto;
  let approachStarted;
  state.bot.pathfinder.goto = async (goal) => {
    if (!goal.entity) return goto(goal);
    approachStarted = Date.now();
    // Controlled travel ticks exercise the real executor's progress and timeout gates.
    const travel = setInterval(() => { state.bot.entity.position.x += 3; }, 1000);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    clearInterval(travel);
    return goto(goal);
  };
  let attacks = 0;
  state.bot.attack = () => {
    assert.ok(Date.now() - approachStarted >= 12_000);
    attacks += 1; delete state.bot.entities[pig.id]; state.add('porkchop', 1);
  };
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(1,
    { anchor: new Vec3(0, 64, 0) })), true);
  assert.equal(attacks, 1);
});

test('a temporary animal NoPath cools down then retries the same food source', async (t) => {
  const state = fixture(t, { stone_sword: 1, oak_planks: 1 }, { furnace: true });
  furnaceFixture(state, { inputName: 'porkchop', outputName: 'cooked_porkchop' });
  const pig = { id: 17, name: 'pig', type: 'animal', position: new Vec3(8, 64, 3), metadata: {} };
  state.bot.entities[pig.id] = pig;
  const goto = state.bot.pathfinder.goto;
  const approaches = [];
  let cooldownExplorations = 0;
  state.bot.pathfinder.goto = async (goal) => {
    if (goal.constructor.name === 'GoalBlock' && approaches.length === 1) cooldownExplorations += 1;
    if (goal.entity) {
      approaches.push(Date.now());
      if (approaches.length === 1) throw new Error('NoPath');
    }
    return goto(goal);
  };
  state.bot.attack = () => { delete state.bot.entities[pig.id]; state.add('porkchop', 1); };
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(1,
    { anchor: new Vec3(0, 64, 0), maxDistance: 16 })), true);
  assert.equal(approaches.length, 2);
  assert.ok(approaches[1] - approaches[0] >= 5000);
  assert.equal(cooldownExplorations, 0,
    'Cooldown must not send the bot around exploration rings while known food remains');
});

test('an unreachable animal is attempted at most three times before a bounded supply failure', async (t) => {
  const state = fixture(t, { stone_sword: 1 }, { furnace: true });
  state.bot.entities[17] = { id: 17, name: 'pig', type: 'animal', position: new Vec3(8, 64, 3), metadata: {} };
  const goto = state.bot.pathfinder.goto;
  let approaches = 0;
  state.bot.pathfinder.goto = async (goal) => {
    if (goal.entity) { approaches += 1; throw new Error('NoPath'); }
    return goto(goal);
  };
  await assert.rejects(state.finish(state.agent.__testEnsureFoodSupply(1,
    { anchor: new Vec3(0, 64, 0), maxDistance: 16 })), /自然食源不足/);
  assert.equal(approaches, 3);
  assert.deepEqual(state.bot.entity.position.floored(), new Vec3(0, 64, 0));
});

test('a wounded hungry first catch is cooked and eaten at camp before hunting more, and eaten meat is not reserve', async (t) => {
  const state = fixture(t, { stone_sword: 1, oak_planks: 3 }, { furnace: true });
  state.bot.health=16; // Wounded recovery eats the first catch; healthy hunters may batch.
  furnaceFixture(state, { inputName: 'porkchop', outputName: 'cooked_porkchop', separateInventory: true });
  const camp = new Vec3(0, 64, 0);
  const pigs = [17, 18].map((id, index) => ({ id, name: 'pig', type: 'animal',
    position: new Vec3(6 + index * 4, 64, 3), metadata: {} }));
  for (const pig of pigs) state.bot.entities[pig.id] = pig;
  let meals = 0;
  const killed = [];
  state.bot.attack = (pig) => {
    if (pig.id === 18) assert.equal(meals, 1, 'Small first catch must feed the bot before another hunt');
    killed.push(pig.id); delete state.bot.entities[pig.id];
    state.add('porkchop', pig.id === 17 ? 3 : 1);
    if (pig.id === 17) state.bot.food = 14; // Controlled exhaustion model, not live evidence.
  };
  state.bot.consume = async () => {
    assert.ok(state.bot.entity.position.floored().distanceTo(camp) <= 1, 'Meal is taken inside the camp refuge');
    assert.equal(state.bot.heldItem.name, 'cooked_porkchop');
    meals += 1; state.add('cooked_porkchop', -1);
    state.bot.food = Math.min(20, state.bot.food + registry.foodsByName.cooked_porkchop.foodPoints);
  };
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(8,
    { anchor: camp, maxDistance: 16, minFoodPoints: 24 })), true);
  assert.deepEqual(killed, [17, 18]);
  assert.equal(meals, 1);
  assert.equal(state.bot.food, 20);
  assert.equal(state.stock.get('cooked_porkchop'), 3, '24 food points remain after the actual meal');
  assert.equal(state.stock.get('porkchop'), 0);
  assert.deepEqual(state.bot.entity.position.floored(), camp);
});

test('food-point supply after a camp meal restores the net backpack reserve', async (t) => {
  const state = fixture(t, { cooked_porkchop: 3, porkchop: 1, oak_planks: 1 }, { furnace: true });
  furnaceFixture(state, { inputName: 'porkchop', outputName: 'cooked_porkchop', separateInventory: true });
  state.bot.food = 17;
  state.bot.consume = async () => {
    state.add('cooked_porkchop', -1);
    state.bot.food = Math.min(20, state.bot.food + registry.foodsByName.cooked_porkchop.foodPoints);
  };
  const foodOptions = { anchor: new Vec3(0, 64, 0), minFoodPoints: 24 };
  assert.equal(await state.finish(state.agent.__testEnsureNutrition(20, foodOptions)), true);
  assert.equal(state.stock.get('cooked_porkchop'), 2);
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(8, foodOptions)), true);
  assert.equal(state.stock.get('cooked_porkchop'), 3);
  assert.equal(state.stock.get('porkchop'), 0);
});

test('low hunger crop collection does not recursively request food before harvesting food', async (t) => {
  const state = fixture(t, {}, { foodCrops: true });
  state.bot.food = 10;
  assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(8, { anchor: new Vec3(0, 64, 0) })), true);
  assert.ok(state.stock.get('carrot') >= 8);
  assert.equal(state.bot.food, 10, 'Provisioning does not fabricate a hunger increase');
  assert.equal(state.changes.digs.filter((name) => name === 'carrots').length, 8);
});

test('nutrition consumes as many real food items as required to reach its requested hunger', async (t) => {
  const state = fixture(t, { bread: 4 });
  state.bot.food = 8;
  let meals = 0;
  state.bot.consume = async () => {
    meals += 1;
    state.add(state.bot.heldItem.name, -1);
    state.bot.food = Math.min(20, state.bot.food + registry.foodsByName.bread.foodPoints);
  };
  assert.equal(await state.finish(state.agent.__testEnsureNutrition(20)), true);
  assert.equal(state.bot.food, 20);
  assert.equal(meals, 3);
  assert.equal(state.stock.get('bread'), 1);
});

test('nutrition stops if consumption returns without an observed hunger increase', async (t) => {
  const state = fixture(t, { bread: 4 });
  state.bot.food = 8;
  let meals = 0;
  state.bot.consume = async () => { meals += 1; };
  await assert.rejects(state.finish(state.agent.__testEnsureNutrition(20)), /没有确认饥饿值恢复/);
  assert.equal(meals, 1);
});

test('a furnace with unchanged progress still triggers the idle watchdog rather than fake heartbeats', async (t) => {
  const state = fixture(t, {}, { furnace: true });
  furnaceFixture(state, { queued: 3, stalled: true });
  const step = { skill: 'smelt_item', args: { inputItems: ['raw_iron'], output: 'iron_ingot', count: 3 } };
  state.task.plan.steps = [step];
  await assert.rejects(state.finish(state.agent.__testExecuteStepWithWatchdog(state.task, step)), /停滞|真实动作/);
  assert.equal(state.task.lastRecoveryReason, 'executor_stalled');
  assert.equal(state.stock.get('iron_ingot') || 0, 0);
});

test('nearby-only diamond primitive points to the expedition command rather than inventing completion', async (t) => {
  const state = fixture(t, { iron_pickaxe: 1 });
  await assert.rejects(state.finish(state.agent.__testExecuteMineResource({ args: { block: 'diamond', count: 1 } })), /本步骤只扫描附近矿物.*从零开始挖到钻石/);
  assert.equal(state.stock.get('diamond') || 0, 0);
});

test('empty inventory reaches an iron pickaxe through the real tool chain when local ore and stations exist', async (t) => {
  const state = fixture(t, {}, { furnace: true, iron: true });
  furnaceFixture(state);
  const step = { skill: 'craft_item', args: { item: 'iron_pickaxe', count: 1 } };
  state.task.plan.steps = [step];
  await state.finish(state.agent.__testExecuteStepWithWatchdog(state.task, step));
  assert.equal(state.stock.get('iron_pickaxe'), 1);
  assert.equal(state.changes.digs.filter((name) => name === 'iron_ore').length, 3);
  assert.ok(state.changes.crafts.some((craft) => craft.output === 'stone_pickaxe'));
  assert.equal(state.stock.get('coal') || 0, 0, 'wood fuel can sustain the local progression without coal');
});

test('empty inventory diamond intent delegates all prerequisite and exploration phases to one resumable expedition', (t) => {
  const state = fixture(t, {});
  const plan = state.agent.__testExpandPlanWithPrerequisites({ mode: 'task', intent: 'mine_diamond_resource',
    goal: 'collect 1 diamond', steps: [{ skill: 'mine_resource', args: { block: 'diamond', count: 1 } },
      { skill: 'follow_player', args: { playerName: 'Owner', once: true } }] });
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].args.expedition, true);
  assert.equal(plan.steps[0].args.count, 1);
  assert.equal(plan.steps[1].args.playerName, 'Owner');
  assert.equal(plan.goal, 'collect 1 diamond');
});

test('low-health empty-handed emergency provisioning eats raw safe food and observes recovery before tools or fuel',async t=>{
 const state=fixture(t,{}, {table:false});state.bot.health=3;state.bot.food=17;state.bot._client.write=()=>{};Object.assign(state.bot.entity,{isInWater:false,isInLava:false,width:.6,height:1.8});
 state.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:32,y:64,z:32},camp:{anchor:{x:0,y:64,z:0},stations:{},storageSites:[]},storage:{chests:[]}};
 const rabbit={id:71,name:'rabbit',type:'animal',position:new Vec3(2,64,3),height:.5,metadata:{}};state.bot.entities[71]=rabbit;
 let attacks=0,ate=false;state.bot.attack=()=>{if(++attacks===3){delete state.bot.entities[71];state.add('rabbit',3);}};
 state.bot.consume=async()=>{assert.equal(state.bot.heldItem.name,'rabbit');state.add('rabbit',-1);state.bot.food=Math.min(20,state.bot.food+3);ate=true;};
 const timer=setInterval(()=>{if(ate&&state.bot.food>=18&&state.bot.health<6)state.bot.health+=1;},1000);t.after(()=>clearInterval(timer));
 await state.finish(state.agent.__testEmergencyFoodRecovery());
 assert.equal(ate,true);assert.equal(state.bot.health,6);assert.equal(state.bot.food,20);
 assert.equal(state.changes.crafts.length,0);assert.equal(state.changes.digs.length,0);assert.equal(state.changes.furnaceOpens,0);
});

test('critical hunger at healthy life eats nearby raw food before any furnace prerequisite',async t=>{
 const state=fixture(t,{}, {table:false});state.bot.health=20;state.bot.food=7;state.bot._client.write=()=>{};Object.assign(state.bot.entity,{isInWater:false,isInLava:false,width:.6,height:1.8});
 state.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:32,y:64,z:32},camp:{anchor:{x:0,y:64,z:0},stations:{},storageSites:[]},storage:{chests:[]}};
 state.bot.entities[71]={id:71,name:'rabbit',type:'animal',position:new Vec3(2,64,3),height:.5,metadata:{}};
 let attacks=0,meals=0;state.bot.attack=()=>{if(++attacks===3){delete state.bot.entities[71];state.add('rabbit',3);}};
 state.bot.consume=async()=>{assert.equal(state.bot.heldItem.name,'rabbit');state.add('rabbit',-1);state.bot.food=Math.min(20,state.bot.food+3);meals++;};
 await state.finish(state.agent.__testEmergencyFoodRecovery());
 assert.equal(state.bot.health,20);assert.ok(state.bot.food>=12);assert.equal(meals,2);
 assert.equal(state.changes.crafts.length,0);assert.equal(state.changes.digs.length,0);assert.equal(state.changes.furnaceOpens,0);
});

test('a hurt surface worker eats carried fallback food without searching or requiring full health',async t=>{
 const state=fixture(t,{rotten_flesh:1},{table:false});state.bot.health=8;state.bot.food=16;state.bot._client.write=()=>{};
 state.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:32,y:64,z:32},camp:{anchor:{x:0,y:64,z:0},stations:{},storageSites:[]},storage:{chests:[]}};
 let meals=0;state.bot.consume=async()=>{assert.equal(state.bot.heldItem.name,'rotten_flesh');state.add('rotten_flesh',-1);state.bot.food=20;meals++;};
 await state.finish(state.agent.__testEnsureNutrition(20));
 assert.equal(meals,1);assert.equal(state.bot.health,8);assert.equal(state.bot.food,20);
 assert.equal(state.changes.crafts.length,0);assert.equal(state.changes.digs.length,0);assert.equal(state.changes.furnaceOpens,0);
});

test('healthy expedition batches small catches before a camp meal and keeps24 real food points afterward',async t=>{
 const state=fixture(t,{stone_sword:1,oak_planks:3},{furnace:true});
 furnaceFixture(state,{inputName:'porkchop',outputName:'cooked_porkchop',separateInventory:true});
 const pigs=[17,18,19,20].map((id,index)=>({id,name:'pig',type:'animal',position:new Vec3(3+index,64,3),metadata:{}}));
 for(const pig of pigs)state.bot.entities[pig.id]=pig;let meals=0;const killed=[];
 state.bot.attack=pig=>{if(killed.length<3)assert.equal(meals,0);killed.push(pig.id);delete state.bot.entities[pig.id];state.add('porkchop',1);if(killed.length===1)state.bot.food=14;};
 state.bot.consume=async()=>{assert.equal(state.bot.heldItem.name,'cooked_porkchop');meals++;state.add('cooked_porkchop',-1);state.bot.food=Math.min(20,state.bot.food+8);};
 assert.equal(await state.finish(state.agent.__testEnsureFoodSupply(8,{anchor:new Vec3(0,64,0),maxDistance:16,minFoodPoints:24})),true);
 assert.deepEqual([...killed].sort((a,b)=>a-b),[17,18,19,20]);assert.equal(meals,1);assert.equal(state.stock.get('cooked_porkchop'),3);
});

test('quarry torch top-up translates a total reserve into only missing additional recipe output',async t=>{
 const state=fixture(t,{torch:16,charcoal:4,stick:4});
 await state.finish(require('../vendor/server/minecraft/houseQuarryLighting').craftQuarryLighting({
  assertActive:()=>{},count:()=>state.stock.get('torch')||0,
  craft:additional=>state.agent.__testCraftItemByName('torch',additional,state.bot.blockAt(new Vec3(0,64,2))),
 }));
 assert.equal(state.stock.get('torch'),32);assert.equal(state.stock.get('charcoal'),0);assert.equal(state.stock.get('stick'),0);
 assert.equal(state.changes.crafts.filter(c=>c.output==='torch').reduce((n,c)=>n+c.repeats,0),4);
});

test('eight-log charcoal batch keeps its target output instead of burning freshly made charcoal as replacement fuel',async t=>{
 const state=fixture(t,{oak_log:8,oak_planks:8},{furnace:true});
 const furnace=furnaceFixture(state,{separateInventory:true,inputName:'oak_log',outputName:'charcoal'}),fuels=[],put=furnace.putFuel;
 furnace.putFuel=async(type,meta,count)=>{fuels.push(registry.items[type].name);return put(type,meta,count);};
 await state.finish(state.agent.__testExecuteSmeltItem({args:{input:'oak_log',output:'charcoal',additionalCount:8}}));
 assert.equal(state.stock.get('charcoal'),8);assert.equal(state.stock.get('oak_log'),0);
 assert.ok(fuels.length>=2);assert.ok(fuels.every(name=>name==='oak_planks'));
});

 test('one emergency meal reaching19 hunger preserves regeneration without demanding another unavailable meal',async t=>{
 const state=fixture(t,{rotten_flesh:1},{table:false});state.bot.health=9.8;state.bot.food=15;state.bot._client.write=()=>{};
 Object.assign(state.bot.entity,{isInWater:false,isInLava:false,width:.6,height:1.8});
 assert.equal(require('../vendor/server/minecraft/houseSurfaceGraph').hasGroundedBodySupport(state.bot),true);
 state.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:32,y:64,z:32},camp:{anchor:{x:0,y:64,z:0},stations:{},storageSites:[]},storage:{chests:[]}};
 state.bot.consume=async()=>{state.add('rotten_flesh',-1);state.bot.food=19;};
 assert.equal(await state.finish(state.agent.__testEnsureNutrition(20,{recoveryThresholdOnly:true})),true);
 assert.equal(state.bot.food,19);assert.equal(state.bot.health,9.8);assert.equal(state.stock.get('rotten_flesh'),0);
 assert.equal(state.changes.digs.length,0);assert.equal(state.changes.furnaceOpens,0);
 });

test('resumed furnished-house stage consumes its carried meal and confirms14HP before foreground work',async t=>{
 const state=fixture(t,{rotten_flesh:1},{table:false});state.bot.health=9.8;state.bot.food=15;state.bot._client.write=()=>{};
 Object.assign(state.bot.entity,{isInWater:false,isInLava:false,width:.6,height:1.8});
 assert.equal(require('../vendor/server/minecraft/houseSurfaceGraph').hasGroundedBodySupport(state.bot),true);
 state.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:32,y:64,z:32},camp:{anchor:{x:0,y:64,z:0},stations:{},storageSites:[]},storage:{chests:[]}};
 state.task.movementLease=state.agent.__testClaimMovementLease('task',state.task.taskId);
 state.bot.consume=async()=>{state.add('rotten_flesh',-1);state.bot.food=19;};
 const timer=setInterval(()=>{if(state.bot.food>=18)state.bot.health=Math.min(14,state.bot.health+1);},1000);t.after(()=>clearInterval(timer));
 await state.finish(state.agent.__testExecuteBuildFurnishedHousePhase({args:{schema:2,profile:'cottage',phase:'inspect_inventory',materialSource:'self_gathered',anchor:{x:32,y:64,z:32}}}));
 assert.deepEqual({health:state.bot.health,food:state.bot.food,rotten:state.stock.get('rotten_flesh')},{health:14,food:19,rotten:0});
 assert.equal(state.changes.digs.length,0);assert.equal(state.changes.crafts.length,0);
});

test('injured material phase confirms actual meal and16HP before allowing any foreground crafting or digging',async t=>{
 // Modeled inventory and regeneration ACKs; this is not Java acceptance.
 const state=fixture(t,{rabbit:3},{table:false});state.bot.health=8;state.bot.food=17;state.bot._client.write=()=>{};
 Object.assign(state.bot.entity,{isInWater:false,isInLava:false,width:.6,height:1.8});
 state.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:32,y:64,z:32},camp:{anchor:{x:0,y:64,z:0},stations:{},storageSites:[]},storage:{chests:[]}};
 state.task.movementLease=state.agent.__testClaimMovementLease('task',state.task.taskId);let meals=0;
 state.bot.consume=async()=>{assert.equal(state.bot.heldItem.name,'rabbit');state.add('rabbit',-1);state.bot.food=20;meals++;};
 const timer=setInterval(()=>{if(state.bot.food>=18){state.bot.health=Math.min(16,state.bot.health+1);if(state.bot.health===16)state.agent.handleMessage({type:'mc_command_pause'}).catch(()=>{});}},1000);t.after(()=>clearInterval(timer));
 await assert.rejects(state.finish(state.agent.__testExecuteBuildFurnishedHousePhase({args:{schema:2,profile:'cottage',phase:'prepare_materials',materialSource:'self_gathered',anchor:{x:32,y:64,z:32}}})),e=>['paused','movement_preempted'].includes(e.code));
 assert.equal(state.task.status,'paused');assert.equal(state.bot.health,16);assert.equal(meals,1);assert.equal(state.changes.digs.length,0);assert.equal(state.changes.crafts.length,0);
});
