'use strict';
// Modeled console responses exercise the acceptance boundary. These are not
// gameplay passes and cannot replace the fresh-world 16-hour scenario.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { playthroughNatural, STEPS, readPlayer, verifyFarm, verifyRanch, observeReturn, observeRecovery } = require('../scenarios/playthrough.cjs');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { penLayout } = require('../core/husbandry');

function fixture(options = {}) {
  const facts = { health: 20, dimension: 'overworld', position: { x: 3.5, y: 64, z: 3.5 }, farmland: 8,
    crops: 8, wheat: 5, bread: 3, bred: 1, cows: 3, fence: true, gate: true, keepInventory: false, dragon: true, ...options };
  const house = createStarterHouse({ x: 0, y: 64, z: 0 });
  const plots = Array.from({ length: 8 }, (_, i) => ({ x: -12 + i, y: 64, z: 3 }));
  const pen = penLayout({ x: 20, y: 64, z: 20 });
  const items = [];
  const bot = { entity: { position: new Vec3(3.5, 64, 3.5) }, health: 20, food: 20, entities: {},
    game: { dimension: 'minecraft:overworld' }, inventory: { slots: [], items: () => items, emptySlotCount: () => 20 } };
  const calls = [];
  const server = { async query(command, pattern) {
    calls.push(command);
    let line;
    if (command.startsWith('forceload')) line = 'Marked chunk [0, 0] to be force loaded';
    else if (command.endsWith(' Health')) line = `Test has the following entity data: ${facts.health}f`;
    else if (command.endsWith(' Pos')) line = `Test has the following entity data: [${facts.position.x}d, ${facts.position.y}d, ${facts.position.z}d]`;
    else if (command.endsWith(' Dimension')) line = `Test has the following entity data: "minecraft:${facts.dimension}"`;
    else if (command === 'gamerule keepInventory') line = `Gamerule keepInventory is currently set to: ${facts.keepInventory}`;
    else if (command.startsWith('scoreboard players get')) {
      const objective = command.split(' ').at(-1);
      const value = ({ mcPlayWheat: facts.wheat, mcPlayBread: facts.bread, mcPlayBred: facts.bred })[objective] ?? 1;
      line = `Test has ${value} [${objective}]`;
    } else if (command.includes('type=minecraft:cow')) line = facts.cows > 0 ? `Test passed, count: ${facts.cows}` : 'Test failed';
    else if (command.includes('advancements=')) line = facts.dragon ? 'Test passed, count: 1' : 'Test failed';
    else if (command.startsWith('execute if block')) {
      const [, x, y, z, predicate] = command.match(/^execute if block (-?\d+) (-?\d+) (-?\d+) (.+)$/);
      const index = plots.findIndex((p) => p.x === +x && p.z === +z);
      const passed = predicate === 'minecraft:farmland' ? index >= 0 && +y === 64 && index < facts.farmland
        : predicate === 'minecraft:wheat' ? index >= 0 && +y === 65 && index < facts.crops
          : predicate === '#minecraft:fences' ? facts.fence
            : predicate === '#minecraft:fence_gates[open=false]' ? facts.gate : true;
      line = passed ? 'Test passed' : 'Test failed';
    } else if (command.startsWith('clear ')) line = 'Found 1 matching item on player Test';
    else if (command.includes('respawn.pos')) {
      const bed = house.furniture.bed.position;
      line = `Test has the following entity data: [I; ${bed.x}, ${bed.y}, ${bed.z}]`;
    } else if (command.startsWith('data get block')) line = 'Chest has the following block data: [{count: 1, id: "minecraft:dirt"}]';
    else throw new Error(`Unexpected modeled command: ${command}`);
    const match = line.match(pattern);
    assert.ok(match, `${command}: ${line}`);
    return match;
  } };
  const farm = { memory: { plots, center: plots[0] }, isDone: () => true };
  const companion = { director: { memory: { homestead: { memory: { house } },
    cobbleGenerator: { memory: { device: { device: { anchor: { x: 40, y: 64, z: 40 }, facing: 'north' }, harvested: 8, regenerated: 8 } } },
    autoSmelter: { memory: { device: { device: { anchor: { x: 50, y: 64, z: 50 }, facing: 'north' }, taken: 4 } } } } } };
  const events = [];
  const state = { dragon: true, goals: { farm, ranch: { memory: { pen } } },
    steps: STEPS.map((s) => ({ id: s.id, asks: 1, doneAt: 1, minute: 1 })),
    audit: { deaths: [], taskEvents: [] }, lastEndExitAt: 10,
    returnedOverworld: { pass: true, at: 15 },
    returnedHome: { pass: true, houseAnchor: house.anchor, at: 20 },
    returnFarmBaseline: { crops: 8, wheatHarvested: 5 }, postReturnFarm: { pass: true }, postReturnHouse: { pass: true },
    furnitureEvidence: { verify: async () => ({ tableUsed: true, furnaceUsed: true }) },
    production: { verify: async () => ({ pass: true }) } };
  const context = { state, companion, server, bot, username: 'Test', deaths: 0,
    write: (type, data) => events.push({ type, ...data }) };
  return { context, facts, state, events, calls, items, farm, pen };
}

test('return evidence requires the server to place a live player at the original house, following an exit without death', async () => {
  for (const options of [{ dimension: 'the_nether' }, { health: 0 }, { position: { x: 1000, y: 64, z: 1000 } }]) {
    const f = fixture(options);
    f.state.returnedHome = null;
    f.state.returnedOverworld = null;
    await observeReturn(f.context);
    assert.equal(f.state.returnedHome, null);
    if (options.position) assert.equal(f.state.returnedOverworld.pass, true, 'world spawn is a valid exit, followed by the explicit walk-home task');
  }
  const f = fixture();
  f.state.returnedHome = null;
  f.state.returnedOverworld = null;
  f.state.audit.deaths.push({ id: 1, at: 11 });
  await observeReturn(f.context);
  assert.equal(f.state.returnedHome, null, 'dying to respawn at bed is not an exit-portal return');
  f.state.lastEndExitAt = 12;
  await observeReturn(f.context);
  assert.equal(f.state.returnedHome.pass, true);
  assert.equal(f.state.returnedOverworld.pass, true);
  assert.equal(f.events.at(-1).type, 'playthrough_return_home_verified');
  assert.ok(f.calls.some((command) => command.endsWith(' Pos')));
  assert.equal((await readPlayer(f.context)).dimension, 'overworld');
});

test('farm readback rejects a forged goal, counts crops only on real farmland and records actual harvests', async () => {
  const f = fixture({ farmland: 7, crops: 8 });
  assert.equal((await verifyFarm({ ...f.context, goal: f.farm })).pass, false);
  f.facts.farmland = 8;
  f.facts.crops = 0;
  assert.equal((await verifyFarm({ ...f.context, goal: f.farm })).pass, false);
  f.facts.wheat = 6;
  const harvesting = await verifyFarm({ ...f.context, goal: f.farm, afterReturn: f.state.returnFarmBaseline });
  assert.equal(harvesting.pass, true, 'a recorded crop followed by server-confirmed harvesting need not all stand at once');
  assert.equal(harvesting.harvestedAfterReturn, 1);
  assert.equal(harvesting.crops, 0);
  assert.equal(harvesting.farmland, 8);
});

test('a remembered pen is insufficient without three server-counted cows and its actual enclosing blocks', async () => {
  for (const options of [{ cows: 0 }, { cows: 2 }, { fence: false }, { gate: false }]) {
    const f = fixture(options);
    assert.equal((await verifyRanch({ ...f.context, goal: f.state.goals.ranch })).pass, false, JSON.stringify(options));
  }
  const f = fixture({ bred: 0 });
  const verdict = await verifyRanch({ ...f.context, goal: f.state.goals.ranch });
  assert.equal(verdict.pass, true, 'preserve the original target of three cows; breeding is separately observed');
  assert.equal(verdict.inPen, 3);
  assert.equal(verdict.bred, 0);
});

test('server-confirmed respawn remains separate from client-observed rearm supplies and lost-drop recovery', async () => {
  const f = fixture({ health: 0 });
  f.state.audit.deaths.push({ id: 1, at: 1 });
  await observeRecovery(f.context);
  assert.equal(f.state.audit.deaths[0].respawn, undefined, 'client health is not authoritative');
  f.facts.health = 20;
  await observeRecovery(f.context);
  const death = f.state.audit.deaths[0];
  assert.equal(death.respawn.alive, true);
  assert.equal(death.kitObserved, undefined, 'empty bag is not equipment recovery');
  f.items.push(...['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'iron_sword', 'shield', 'iron_pickaxe']
    .map((name) => ({ name, count: 1 })), { name: 'cooked_beef', count: 12 });
  await observeRecovery(f.context);
  assert.ok(death.kitObserved);
  assert.match(f.events.at(-1).note, /does not prove original drops/);
});

test('final verdict retains all original goals and rejects incomplete steps, false life/dimension, empty ranch and diagnostic death rules', async () => {
  const baseline = fixture();
  assert.equal((await playthroughNatural.verify(baseline.context)).pass, true);
  for (const options of [{ health: 0 }, { dimension: 'the_nether' }, { farmland: 7 }, { cows: 0 }, { keepInventory: true }]) {
    const f = fixture(options);
    const verdict = await playthroughNatural.verify(f.context);
    assert.equal(verdict.pass, false, JSON.stringify(options));
    assert.ok(verdict.details.unmet.length > 0);
  }
  const f = fixture({ crops: 0, wheat: 6 });
  assert.equal((await playthroughNatural.verify(f.context)).pass, true, 'final harvesting interval retains the post-return crop proof');
  f.state.steps.find((e) => e.id === 'farm_after_end').doneAt = null;
  const incomplete = await playthroughNatural.verify(f.context);
  assert.equal(incomplete.pass, false);
  assert.ok(incomplete.details.unmet.includes('allStepsDone'));
});

test('post-return repair stages preserve the house-first order and failures are retained even when gear is requested again', () => {
  const ids = STEPS.map((s) => s.id);
  assert.ok(ids.indexOf('house') < ids.indexOf('end'));
  assert.ok(ids.indexOf('farm') < ids.indexOf('end'));
  assert.ok(ids.indexOf('house_after_end') > ids.indexOf('end'));
  assert.ok(ids.indexOf('farm_after_end') > ids.indexOf('house_after_end'));
  const f = fixture();
  const event = { type: 'goal_failed', goal: 'nether_expedition', reasons: ['missing_obsidian'], generation: 3 };
  playthroughNatural.onEvent(event, f.state);
  assert.equal(f.state.steps.find((e) => e.id === 'gear').doneAt, null);
  assert.deepEqual(f.state.audit.taskEvents[0].reasons, ['missing_obsidian']);
  assert.equal(f.state.audit.taskEvents[0].generation, 3);
});
