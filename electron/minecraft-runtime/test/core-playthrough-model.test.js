'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { playthroughNatural, STEPS, REARM, RECOVERY_BASE_KIT } = require('../scenarios/playthrough.cjs');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { planNext } = require('../core/planner');

test('a nether trip short of obsidian for its portal sends the model back for the gear', () => {
  const state = { gearDone: true, steps: STEPS.map((s) => ({ id: s.id, asks: 1, doneAt: s.id === 'nether' ? null : 1 })) };
  const gear = state.steps.find((e) => e.id === 'gear');
  // Lost in a fight: the gear stays done.
  playthroughNatural.onEvent({ type: 'goal_failed', goal: 'nether_expedition', reasons: ['death_loop'] }, state);
  assert.equal(gear.doneAt, 1);
  playthroughNatural.onEvent({ type: 'goal_failed', goal: 'nether_expedition', reasons: Array(30).fill('missing_obsidian') }, state);
  assert.equal(gear.doneAt, null);
  assert.equal(gear.asks, 0);
  assert.equal(state.gearDone, false);
});

function modelContext({ armour = [], step = 'pearls', goal = null, pick = false } = {}) {
  const slots = [];
  armour.forEach((name, i) => { slots[5 + i] = { name, count: 1 }; });
  const asked = [];
  const bot = { entity: { position: new Vec3(0, 64, 0) }, health: 20, food: 20, entities: {}, game: { dimension: 'minecraft:overworld' },
    time: { timeOfDay: 14000 }, inventory: { slots, items: () => (pick ? [{ name: 'iron_pickaxe', count: 1 }] : []), emptySlotCount: () => 20 } };
  const steps = STEPS.map((s, i) => ({ id: s.id, asks: s.id === step ? 1 : 0, doneAt: i < STEPS.findIndex((x) => x.id === step) ? 1 : null }));
  const state = { steps, goals: {}, gearDone: true, armorDone: true, snackEnd: Date.now() };
  const companion = { status: () => ({ goal }), submitTask: async (task, args) => { asked.push({ task, args }); } };
  const server = { query: async () => ['', 'Test failed'] };
  return { context: { companion, bot, state, server, username: 'x', write() {}, elapsedMs: 0 }, asked, state };
}

test('a pearl hunt already below the home can recover on the daylight tick', () => {
  const hunt = STEPS.find((step) => step.id === 'pearls');
  const { context } = modelContext({ step: 'pearls' });
  const house = createStarterHouse({ x: -105, y: 64, z: -182 });
  context.companion.director = { memory: { homestead: { memory: { house } } } };
  context.bot.time.timeOfDay = 1000;
  context.bot.entity.position = new Vec3(-102, 34, -183);
  assert.equal(hunt.when(context), true);
  context.bot.entity.position.y = 57;
  context.bot.blockAt = () => ({ name: 'air', boundingBox: 'empty', skyLight: 0 });
  assert.equal(hunt.when(context), true);
  context.bot.entity.position.y = 61;
  context.bot.blockAt = (p) => p.y === 60 ? { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    : { name: 'air', boundingBox: 'empty', skyLight: 7, shapes: [] };
  assert.equal(hunt.when(context), false);
  context.bot.entity.position.y = 64;
  assert.equal(hunt.when(context), false);
});

test('daylight can dispatch a surfaced hunter home and will back off a failed route for the same day', () => {
  const hunt = STEPS.find((step) => step.id === 'pearls');
  const { context, state } = modelContext({ step: 'pearls' });
  const house = createStarterHouse({ x: -105, y: 64, z: -182 });
  context.companion.director = { memory: { homestead: { memory: { house } } } };
  context.bot.entity = { position: new Vec3(-115.5, 66, -221.5), onGround: true };
  context.bot.blockAt = (p) => p.y < 66 ? { name: 'grass_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    : { name: 'air', boundingBox: 'empty', shapes: [] };
  context.bot.time = { timeOfDay: 2000, day: 6 };
  assert.equal(hunt.when(context), true);
  state.goals.pearls = { memory: { homeReturnBlockedDay: 6 } };
  assert.equal(hunt.when(context), false);
  context.bot.time.timeOfDay = 14000;
  assert.equal(hunt.when(context), true);
  context.bot.time = { timeOfDay: 1000, day: 7 };
  assert.equal(hunt.when(context), true);
  context.bot.entity.isInWater = true;
  assert.equal(hunt.when(context), false);
});

test('pearl scouting widens only with three distinct dry nights and a carried food reserve', () => {
  const hunt = STEPS.find((step) => step.id === 'pearls');
  const { context, state } = modelContext({ step: 'pearls',
    armour: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], pick: true });
  context.bot.inventory.slots[45] = { name: 'shield', count: 1 };
  context.bot.food = 19;
  let carried = 3;
  const pearls = { name: 'ender_pearl', count: 0 };
  context.bot.inventory.items = () => [{ name: 'iron_sword', count: 1 }, { name: 'bread', count: carried }, pearls];
  state.pearlDryNights = [40, 40, 41];
  assert.equal(hunt.args(context).scoutRadius, undefined);
  state.pearlDryNights.push(42);
  carried = 2;
  assert.equal(hunt.args(context).scoutRadius, undefined);
  carried = 3;
  assert.equal(hunt.args(context).scoutRadius, 80);
  assert.equal(hunt.args(context).scoutSector, 'south');
  pearls.count = 1;
  assert.equal(hunt.done(context), false);
  assert.equal(hunt.args(context).scoutRadius, 80);
});

test('a living Nether food return refills the carried reserve and resumes the same rod goal', async () => {
  const { context, asked, state } = modelContext({ step: 'nether', armour: ['iron_helmet', 'iron_chestplate'], pick: true });
  const bag = [{ name: 'iron_pickaxe', count: 1 }, { name: 'blaze_rod', count: 4 }, { name: 'bread', count: 2 }];
  context.bot.inventory.items = () => bag;
  const receipt = { type: 'expedition_resupply_required', behavior: 'goal:nether_expedition', rods: 4 };
  playthroughNatural.onEvent(receipt, state);
  await playthroughNatural.onTick(context);
  assert.equal(asked[0].task, 'outfit');
  assert.deepEqual(asked[0].args.items, [{ key: 'food', count: 12 }]);
  playthroughNatural.onEvent(receipt, state);
  assert.equal(state.netherFoodRestock.asks, 1);
  bag.find((item) => item.name === 'bread').count = 12;
  await playthroughNatural.onTick(context);
  assert.equal(state.netherFoodRestock, null);
  assert.deepEqual(asked[1], { task: 'netherExpedition', args: { blazeRods: 7, witherSkulls: 0, trades: 0 } });
  assert.equal(bag.find((item) => item.name === 'blaze_rod').count, 4);
});

test('armour worn through: the model asks for a new set before the next step, and only once an hour', async () => {
  const { context, asked, state } = modelContext({ armour: [] });
  await playthroughNatural.onTick(context);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].task, 'outfit');
  assert.ok(asked[0].args.items.some((r) => r.key === 'iron_chestplate'));
  assert.equal(state.steps.find((e) => e.id === 'pearls').asks, 1, 'not one of the step\'s asks');
  // Done (or given up): back to the step, with no new set asked for at once.
  await playthroughNatural.onTick(context);
  await playthroughNatural.onTick(context);
  assert.ok(asked.slice(1).every((a) => a.task !== 'outfit'), JSON.stringify(asked));
});

test('armour still on and a pickaxe carried: no new set', async () => {
  const { context, asked } = modelContext({ armour: ['iron_helmet', 'iron_chestplate', 'iron_leggings'], pick: true });
  await playthroughNatural.onTick(context);
  assert.ok(asked.every((a) => a.task !== 'outfit'));
});

test('every pickaxe worn out: the new set comes with one', async () => {
  const { context, asked } = modelContext({ armour: ['iron_helmet', 'iron_chestplate', 'iron_leggings'] });
  await playthroughNatural.onTick(context);
  assert.equal(asked[0]?.task, 'outfit');
  assert.ok(asked[0].args.items.some((r) => r.key === 'iron_pickaxe'));
});

test('first Nether return requires seven actual rods and fourteen pearls supply the full eye reserve', () => {
  const { context } = modelContext();
  const [nether, pearls, eyes] = ['nether', 'pearls', 'eyes'].map((id) => STEPS.find((step) => step.id === id));
  const bag = { blaze_rod: 6, ender_pearl: 12, blaze_powder: 2, ender_eye: 2 };
  context.bot.inventory.items = () => Object.entries(bag).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count }));
  assert.equal(nether.args().blazeRods, 7);
  assert.equal(nether.done(context), false);
  bag.blaze_rod = 7;
  context.bot.game.dimension = 'minecraft:the_nether';
  assert.equal(nether.done(context), false);
  context.bot.game.dimension = 'minecraft:overworld';
  assert.equal(nether.done(context), true);

  assert.equal(pearls.args(context).count, 12, 'physically crafted eyes already contain a pearl');
  assert.equal(pearls.done(context), true);
  delete bag.ender_eye;
  delete bag.blaze_powder;
  assert.equal(pearls.args(context).count, 14);
  assert.equal(pearls.done(context), false);

  const requirements = [eyes.args().items.find(({ key }) => key === 'ender_eye')];
  assert.deepEqual(requirements, [{ key: 'ender_eye', count: 14 }]);
  assert.deepEqual(planNext({ requirements, inventory: bag }), {
    kind: 'hunt', key: 'ender_pearl', mobs: ['enderman'], count: 2, for: 'ender_eye',
  });
  bag.ender_pearl = 14;
  assert.equal(pearls.done(context), true);
  assert.deepEqual(planNext({ requirements, inventory: bag }), {
    kind: 'craft', key: 'blaze_powder', item: 'blaze_powder', times: 7, table: false, for: 'ender_eye',
  });
  delete bag.blaze_rod;
  bag.blaze_powder = 14;
  assert.deepEqual(planNext({ requirements, inventory: bag }), {
    kind: 'craft', key: 'ender_eye', item: 'ender_eye', times: 14, table: false, for: 'ender_eye',
  });
});

test('the Nether trip requires portal supplies; the eyes stage waits for fourteen eyes, a bow and a stack of arrows', async () => {
  const gear = STEPS.find((step) => step.id === 'gear').args().items;
  assert.ok(gear.some(({ key }) => key === 'obsidian'));
  assert.ok(gear.some(({ key }) => key === 'flint_and_steel'));
  assert.equal(gear.some(({ key }) => key === 'bow' || key === 'arrow'), false);

  const { context, asked, state } = modelContext({ step: 'eyes', armour: ['iron_helmet', 'iron_chestplate'], pick: true });
  const eyes = STEPS.find((step) => step.id === 'eyes');
  const inventory = eyes.args().items.filter(({ key }) => key !== 'bow').map(({ key, count }) => ({
    name: key === 'food' ? 'bread' : key, count: ['arrow', 'ender_eye'].includes(key) ? count - 1 : count,
  }));
  context.bot.inventory.items = () => [...inventory, { name: 'iron_pickaxe', count: 1 }];
  await playthroughNatural.onTick(context);
  assert.equal(asked[0]?.task, 'outfit', 'eyes alone do not finish the kit');
  assert.deepEqual(asked[0].args.items.filter(({ key }) => key === 'bow' || key === 'arrow'),
    [{ key: 'bow', count: 1 }, { key: 'arrow', count: 64 }]);
  inventory.push({ name: 'bow', count: 1 });
  await playthroughNatural.onTick(context);
  assert.equal(state.steps.find((step) => step.id === 'eyes').doneAt, null);
  inventory.find(({ name }) => name === 'arrow').count = 64;
  await playthroughNatural.onTick(context);
  assert.equal(state.steps.find((step) => step.id === 'eyes').doneAt, null);
  inventory.find(({ name }) => name === 'ender_eye').count = 14;
  await playthroughNatural.onTick(context);
  assert.ok(state.steps.find((step) => step.id === 'eyes').doneAt);
});

test('only safe edible food prevents a snack detour to the existing ripe farm', async () => {
  const { context, asked, state } = modelContext({ step: 'gear', goal: { name: 'outfit' }, pick: true });
  const house = createStarterHouse({ x: -105, y: 64, z: -182 });
  context.companion.director = { memory: { homestead: { memory: { house } } } };
  state.gearDone = false;
  state.snackEnd = 0;
  context.bot.food = 11;
  const bag = [{ name: 'bread', count: 1 }, { name: 'chicken', count: 5 }];
  context.bot.inventory.items = () => bag;
  const center = { x: -117, y: 64, z: -179 };
  const plots = [new Vec3(-113, 62, -180), new Vec3(-113, 62, -178), new Vec3(-113, 62, -177)];
  state.goals.farm = { memory: { center, plots } };
  let age = 6;
  context.bot.blockAt = () => ({ name: 'wheat', getProperties: () => ({ age }) });
  await playthroughNatural.onTick(context);
  assert.deepEqual(asked, [], 'carried bread can be eaten');
  bag.shift();
  await playthroughNatural.onTick(context);
  assert.deepEqual(asked, [], 'the loaded farm has no ripe wheat yet');
  age = 7;
  await playthroughNatural.onTick(context);
  assert.deepEqual(asked, [{ task: 'farm', args: { bread: 2, center,
    snackPlots: plots.map(({ x, y, z }) => ({ x, y, z })), home: { table: house.furniture.crafting_table.position } } }]);
  assert.equal(state.snack, true);
  await playthroughNatural.onTick(context);
  assert.equal(asked.length, 1, 'raw chicken does not end the new farm task');
  context.bot.food = 18;
  await playthroughNatural.onTick(context);
  assert.equal(state.snack, false);
  assert.equal(asked[1]?.task, 'outfit');
  assert.deepEqual(asked[1].args.items.find(({ key }) => key === 'food'), { key: 'food', count: 12 });
});

test('an angry Enderman must finish the fight before a hungry pearl hunter returns to the farm', async () => {
  const { context, asked, state } = modelContext({ step: 'pearls', goal: { name: 'hunt_pearls' },
    armour: ['iron_helmet', 'iron_chestplate'], pick: true });
  const house = createStarterHouse({ x: -105, y: 64, z: -182 });
  context.companion.director = { memory: { homestead: { memory: { house } } } };
  state.snackEnd = 0;
  context.bot.health = 13;
  context.bot.food = 16;
  context.bot.registry = { entitiesByName: { enderman: { metadataKeys: ['creepy', 'health'] } } };
  context.bot.entities = { 7: { name: 'enderman', type: 'hostile', position: new Vec3(3, 64, 0), metadata: [true, 16] } };
  state.goals.farm = { memory: { center: new Vec3(-117, 64, -179),
    plots: [new Vec3(-113, 62, -180), new Vec3(-113, 62, -178), new Vec3(-113, 62, -177)] } };
  context.bot.blockAt = () => ({ name: 'wheat', getProperties: () => ({ age: 7 }) });
  await playthroughNatural.onTick(context);
  assert.deepEqual(asked, []);
  assert.equal(state.snack, undefined);
  context.bot.entities[7].metadata[1] = 0;
  await playthroughNatural.onTick(context);
  assert.equal(asked[0].task, 'farm');
  assert.equal(state.snack, true);
});

test('a lost bow after eyes preparation restocks the End weapons without recrafting spent eyes', async () => {
  const { context, asked, state } = modelContext({ step: 'end', armour: ['iron_helmet', 'iron_chestplate'], pick: true });
  state.rearm = true;
  let goal = null;
  context.companion.status = () => ({ goal });
  context.companion.submitTask = async (task, args) => {
    asked.push({ task, args });
    goal = { name: task };
  };
  const inventory = [{ name: 'iron_pickaxe', count: 1 }, { name: 'arrow', count: 63 }];
  context.bot.inventory.items = () => inventory;
  await playthroughNatural.onTick(context);
  assert.equal(state.rearm, false);
  assert.equal(state.steps.find((step) => step.id === 'eyes').doneAt, null);
  assert.deepEqual(asked, []);
  await playthroughNatural.onTick(context);
  assert.deepEqual(asked[0], { task: 'outfit', args: { items: [{ key: 'bow', count: 1 }, { key: 'arrow', count: 64 }] } });
  inventory.push({ name: 'bow', count: 1 }, { name: 'arrow', count: 1 });
  await playthroughNatural.onTick(context);
  await playthroughNatural.onTick(context);
  assert.equal(asked[1]?.task, 'endJourney');
});

test('death during active expedition prep holds gear until home supplies and worn iron kit are observed', async () => {
  const { context, state } = modelContext({ step: 'gear' });
  const { companion, bot } = context;
  const items = [];
  const requests = [];
  const events = [];
  let goal = { name: 'outfit', generation: 1 };
  let generation = 1;
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  companion.director = { memory: { homestead: { memory: { house } } } };
  companion.status = () => ({ goal });
  companion.submitTask = async (task, args) => {
    requests.push({ task, args });
    goal = { name: 'outfit', generation: ++generation };
  };
  companion.cancelTask = async () => { goal = null; };
  bot.inventory.items = () => items;
  bot.entity.position = new Vec3(3.5, 64, 3.5);
  state.audit = { deaths: [{ id: 1, at: 1 }], taskEvents: [] };
  const plots = [{ x: -11, y: 62, z: -7 }];
  state.goals.farm = { memory: { plots } };
  context.server.query = async (command, pattern) => (command.endsWith(' Health') ? 'data: 0' : 'Test failed').match(pattern);
  // Until the real respawn is known, even the still active old request is not continued.
  bot.health = 0;
  context.write = (type, data) => events.push({ type, ...data });
  state.gearDone = false;
  await playthroughNatural.onTick(context);
  assert.deepEqual(requests, []);
  state.audit.deaths[0].respawn = { alive: true };
  bot.health = 20;
  await playthroughNatural.onTick(context);
  await playthroughNatural.onTick(context);
  assert.deepEqual(requests, [{ task: 'outfit', args: { items: RECOVERY_BASE_KIT, recoverAtHome: true, farmPlots: plots } }]);
  items.push({ name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'bread', count: 12 });
  bot.entity.position = new Vec3(4, 10, 4);
  await playthroughNatural.onTick(context);
  assert.equal(state.deathRecovery.phase, 'base', 'gear in a cave is not verified home resupply');
  bot.entity.position = new Vec3(3.5, 64, 3.5);
  await playthroughNatural.onTick(context);
  await playthroughNatural.onTick(context);
  assert.deepEqual(requests[1], { task: 'outfit', args: { items: REARM, expeditionFood: true, farmPlots: plots } });
  items.push(...REARM.filter(({ key }) => key !== 'food').map(({ key }) => ({ name: key, count: 1 })));
  await playthroughNatural.onTick(context);
  assert.equal(requests.length, 2, 'carrying the armour without wearing it cannot release the gear gate');
  ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'].forEach((name, i) => {
    bot.inventory.slots[i === 4 ? 45 : 5 + i] = { name, count: 1 };
    items.splice(items.findIndex((item) => item.name === name), 1);
  });
  const reserve = items.find(({ name }) => name === 'bread');
  reserve.name = 'chicken';
  await playthroughNatural.onTick(context);
  assert.equal(state.deathRecovery.phase, 'iron', 'unsafe food does not complete the expedition kit');
  reserve.name = 'bread';
  await playthroughNatural.onTick(context);
  assert.equal(requests[2].task, 'outfit');
  assert.ok(requests[2].args.items.some(({ key }) => key === 'obsidian'));
  assert.equal(requests[2].args.items.some(({ key }) => key === 'bow'), false);
  assert.deepEqual(events.filter((e) => e.type === 'playthrough_death_recovery_verified').map(({ phase }) => phase), ['base', 'iron']);
});

test('gear and eyes ask for the full safe food reserve using the known farm plots', () => {
  const { context, state } = modelContext({ step: 'gear', pick: true });
  state.gearDone = false;
  state.goals.farm = { memory: { plots: [new Vec3(-112, 62, -178)] } };
  const gear = STEPS.find((step) => step.id === 'gear');
  const eyes = STEPS.find((step) => step.id === 'eyes');
  for (const [step, food] of [[gear, 12], [eyes, 24]]) {
    const args = step.args(context);
    assert.equal(args.expeditionFood, true);
    assert.deepEqual(args.farmPlots, [{ x: -112, y: 62, z: -178 }]);
    assert.equal(args.items.find(({ key }) => key === 'food').count, food);
    const bag = args.items.filter(({ key }) => key !== 'food').map(({ key, count }) => ({ name: key, count }));
    const reserve = { name: 'chicken', count: food };
    context.bot.inventory.items = () => [...bag, reserve];
    assert.equal(step.done(context), false, 'raw chicken will not feed the expedition');
    reserve.name = 'cooked_chicken';
    assert.equal(step.done(context), true);
  }
});

test('a later pearl hunt prefers a fresh sector opposite the last observed search', () => {
  const { context, state } = modelContext({ step: 'pearls' });
  const pearls = STEPS.find((step) => step.id === 'pearls');
  assert.equal(pearls.args(context).scoutSector, undefined);
  state.goals.pearls = { memory: { scoutCoverage: { south: 30, east: 8 } } };
  assert.equal(pearls.args(context).scoutSector, 'north');
  state.pearlScoutCoverage = { north: 15 };
  assert.equal(pearls.args(context).scoutSector, 'west');
});

test('pearl rearm verifies a full iron kit and local rations back at the house', async () => {
  const { context, asked, state } = modelContext({
    step: 'pearls', armour: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
  });
  const { bot, companion } = context;
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  companion.director = { memory: { homestead: { memory: { house } } } };
  bot.inventory.slots[45] = { name: 'shield', count: 1 };
  bot.inventory.items = () => [{ name: 'iron_pickaxe', count: 1 }, { name: 'iron_sword', count: 1 }, { name: 'bread', count: 3 }];
  state.audit = { deaths: [{ id: 1, at: 1, respawn: { alive: true } }], taskEvents: [] };
  state.deathRecovery = { death: 1, phase: 'iron', attempts: 0 };
  bot.entity.position = new Vec3(48, 64, 0);
  await playthroughNatural.onTick(context);
  assert.equal(state.deathRecovery.phase, 'iron');
  assert.equal(asked[0].args.recoverAtHome, true);
  assert.equal(asked[0].args.items.find(({ key }) => key === 'food').count, 3);
  bot.entity.position = new Vec3(3.5, 64, 3.5);
  await playthroughNatural.onTick(context);
  assert.equal(state.deathRecovery.phase, 'done');
  assert.equal(asked[1].task, 'huntPearls');
});

test('unexpected Nether entry during rearm returns through the portal before taking another outfit', async () => {
  const { context, asked, state } = modelContext({ step: 'nether' });
  const { bot, companion } = context;
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  companion.director = { memory: { homestead: { memory: { house } } } };
  let goal = { name: 'outfit', generation: 1 };
  companion.status = () => ({ goal });
  companion.submitTask = async (task, args) => {
    asked.push({ task, args });
    goal = { name: task, generation: goal.generation + 1 };
  };
  state.audit = { deaths: [{ id: 1, at: 1, respawn: { alive: true } }], taskEvents: [] };
  bot.game.dimension = 'minecraft:the_nether';
  await playthroughNatural.onTick(context);
  await playthroughNatural.onTick(context);
  assert.deepEqual(asked, [{ task: 'netherExpedition', args: { blazeRods: 0, witherSkulls: 0, trades: 0 } }]);
  bot.game.dimension = 'minecraft:overworld';
  await playthroughNatural.onTick(context);
  assert.deepEqual(asked[1], { task: 'outfit', args: { items: RECOVERY_BASE_KIT, recoverAtHome: true, farmPlots: [] } });
});
