'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planNext } = require('../core/planner');
const { countKey, KNOWLEDGE } = require('../core/knowledge');
const { createStarterHouse } = require('../core/blueprints/starterHouse');
const { chooseSite, siteWork } = require('../core/site');

const gear = [{ key: 'stone_sword', count: 1 }, { key: 'stone_tier_pickaxe', count: 1 }];

test('empty inventory starts by gathering logs', () => {
  const step = planNext({ requirements: gear, inventory: {} });
  assert.equal(step.kind, 'gather');
  assert.equal(step.key, 'log');
});

test('with logs, planks are crafted before anything else', () => {
  const step = planNext({ requirements: gear, inventory: { birch_log: 4 } });
  assert.deepEqual([step.kind, step.item], ['craft', 'birch_planks']);
});

test('a crafting table is crafted and placed before table recipes', () => {
  assert.deepEqual(planNext({ requirements: gear, inventory: { oak_planks: 12, stick: 4 } }).item, 'crafting_table');
  const place = planNext({ requirements: gear, inventory: { oak_planks: 8, stick: 4, crafting_table: 1 } });
  assert.deepEqual(place, { kind: 'place_station', station: 'crafting_table', for: 'stone_sword' });
});

test('cobblestone needs a pickaxe first; the wooden pickaxe is crafted at the placed table', () => {
  const step = planNext({ requirements: gear, inventory: { oak_planks: 8, stick: 4 }, stations: { crafting_table: true } });
  assert.deepEqual([step.kind, step.item], ['craft', 'wooden_pickaxe']);
  const mine = planNext({ requirements: gear, inventory: { oak_planks: 5, stick: 2, wooden_pickaxe: 1 },
    stations: { crafting_table: true } });
  assert.deepEqual([mine.kind, mine.key, mine.tool], ['gather', 'cobblestone', 'pickaxe']);
});

test('tools are not consumed by the plan: one pickaxe serves every stone requirement', () => {
  const step = planNext({ requirements: [...gear, { key: 'furnace', count: 1 }],
    inventory: { stick: 4, wooden_pickaxe: 1, cobblestone: 5 }, stations: { crafting_table: true } });
  assert.deepEqual([step.kind, step.item], ['craft', 'stone_sword']);
});

test('a better tool satisfies a lower requirement', () => {
  const step = planNext({ requirements: gear, inventory: { iron_sword: 1, iron_pickaxe: 1 } });
  assert.equal(step, null);
});

test('iron needs a stone pickaxe, a placed furnace and fuel, in that order', () => {
  const base = { stone_pickaxe: 1, stick: 4, oak_planks: 2 };
  const iron = [{ key: 'iron_sword', count: 1 }];
  const mine = planNext({ requirements: iron, inventory: base, stations: { crafting_table: true } });
  assert.deepEqual([mine.kind, mine.key], ['gather', 'raw_iron']);
  const furnace = planNext({ requirements: iron, inventory: { ...base, raw_iron: 2, cobblestone: 8 }, stations: { crafting_table: true } });
  assert.deepEqual([furnace.kind, furnace.item], ['craft', 'furnace']);
  const fuel = planNext({ requirements: iron, inventory: { stone_pickaxe: 1, stick: 1, raw_iron: 2 },
    stations: { crafting_table: true, furnace: true } });
  assert.deepEqual([fuel.kind, fuel.key], ['gather', 'log']);
  const smelt = planNext({ requirements: iron, inventory: { stone_pickaxe: 1, stick: 1, raw_iron: 2, coal: 1 },
    stations: { crafting_table: true, furnace: true } });
  assert.deepEqual([smelt.kind, smelt.input, smelt.count], ['smelt', 'raw_iron', 2]);
});

test('earmarked items are not double counted across requirements', () => {
  // The chest takes all 8 planks, so the table it needs must come from a new log.
  const step = planNext({ requirements: [{ key: 'chest', count: 1 }], inventory: { oak_planks: 8 } });
  assert.deepEqual([step.kind, step.key], ['gather', 'log']);
});

test('a bed needs three wool of one color', () => {
  assert.equal(countKey('wool', { white_wool: 2, black_wool: 1 }), 2);
  const step = planNext({ requirements: [{ key: 'bed', count: 1 }], inventory: { white_wool: 2, black_wool: 1, oak_planks: 3 },
    stations: { crafting_table: true } });
  assert.deepEqual([step.kind, step.mobs], ['hunt', ['sheep']]);
  const craft = planNext({ requirements: [{ key: 'bed', count: 1 }], inventory: { white_wool: 3, oak_planks: 3 },
    stations: { crafting_table: true } });
  assert.deepEqual([craft.kind, craft.item], ['craft', 'white_bed']);
});

test('the starter house is fully self-gatherable', () => {
  const house = createStarterHouse({ x: 0, y: 1, z: 0 });
  assert.deepEqual(house.materials(), { cobblestone: 70, planks: 49, torch: 2 });
  const requirements = [
    ...Object.entries(house.materials()).map(([key, count]) => ({ key, count })),
    { key: 'bed', count: 1 }, { key: 'chest', count: 1 }, { key: 'door', count: 1 },
  ];
  // Simulate: apply each step's effect to the inventory until nothing is left to do.
  const inventory = {};
  const stations = {};
  const add = (name, n) => { inventory[name] = (inventory[name] || 0) + n; };
  const recipes = {
    oak_planks: [{ oak_log: 1 }, 4], stick: [{ oak_planks: 2 }, 4], crafting_table: [{ oak_planks: 4 }, 1],
    wooden_pickaxe: [{ oak_planks: 3, stick: 2 }, 1], torch: [{ coal: 1, stick: 1 }, 4],
    white_bed: [{ white_wool: 3, oak_planks: 3 }, 1], chest: [{ oak_planks: 8 }, 1], oak_door: [{ oak_planks: 6 }, 3],
  };
  const drops = { log: 'oak_log', cobblestone: 'cobblestone', coal: 'coal', wool: 'white_wool' };
  for (let i = 0; i < 2000; i += 1) {
    const step = planNext({ requirements, inventory, stations });
    if (!step) break;
    if (step.kind === 'gather' || step.kind === 'hunt') add(drops[step.key], 1);
    else if (step.kind === 'place_station') { stations[step.station] = true; inventory[step.station] -= 1; }
    else if (step.kind === 'craft') {
      const [needs, yields] = recipes[step.item];
      for (const [name, n] of Object.entries(needs)) {
        assert.ok((inventory[name] || 0) >= n, `missing ${name} for ${step.item}`);
        inventory[name] -= n;
      }
      add(step.item, yields);
    } else assert.fail(`unexpected step ${JSON.stringify(step)}`);
  }
  assert.equal(planNext({ requirements, inventory, stations }), null);
  for (const { key, count } of requirements) assert.ok(countKey(key, inventory, KNOWLEDGE) >= count, key);
});

// A tiny voxel world: flat grass at y=0, optional bumps/holes/trees/water.
function voxelWorld(edits = {}) {
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (key in edits) return edits[key] && { name: edits[key], boundingBox: edits[key] === 'air' || edits[key] === 'short_grass' ? 'empty' : 'block' };
    if (y < 0) return { name: 'dirt', boundingBox: 'block' };
    if (y === 0) return { name: 'grass_block', boundingBox: 'block' };
    return { name: 'air', boundingBox: 'empty' };
  };
}

test('site selection picks flat ground near the bot and skips trees and water', () => {
  const site = chooseSite(voxelWorld(), { x: 0.5, y: 1, z: 0.5 }, { radius: 6 });
  assert.equal(site.anchor.y, 1);
  assert.equal(site.fills + site.digs, 0);
  const trees = {};
  for (let x = -12; x <= 12; x += 1) trees[`${x},1,0`] = 'oak_log';
  const avoided = chooseSite(voxelWorld(trees), { x: 0.5, y: 1, z: 0.5 }, { radius: 6 });
  const covers = (s, x, z) => x >= s.anchor.x && x < s.anchor.x + 7 && z >= s.anchor.z && z < s.anchor.z + 7;
  assert.ok(!covers(avoided, 0, 0));
});

test('site work is derived from the world: bumps to dig, holes to fill', () => {
  const house = createStarterHouse({ x: 0, y: 1, z: 0 });
  const world = voxelWorld({ '2,1,2': 'dirt', '4,0,4': 'air', '3,1,3': 'short_grass' });
  const work = siteWork(world, house, () => false);
  assert.deepEqual(work.digs.map((d) => d.name).sort(), ['dirt', 'short_grass']);
  assert.deepEqual(work.fills.map((f) => f.position), [{ x: 4, y: 0, z: 4 }]);
});
