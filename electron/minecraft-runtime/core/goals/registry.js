'use strict';
// The goals the director may pick on its own, one card each (see director.js).
// A new goal joins autonomy by adding a card here; it needs no director changes.
//
// Stages are read from the world every time, never stored:
//   0  no finished home yet
//   1  home, bed, furniture and iron gear done: food, then the machines
//      (a cobblestone generator with a hopper, then the hopper-fed furnace),
//      each built beside the house from materials gathered into its chest

const { createHomesteadGoal } = require('./homestead');
const { createStockFoodGoal } = require('./stockFood');
const { createCobbleGeneratorGoal } = require('./cobbleGenerator');
const { createAutoSmelterGoal } = require('./autoSmelter');
const { createDeviceProjectGoal } = require('./deviceProject');
const { KNOWLEDGE, countKey } = require('../knowledge');

const FOOD_TARGET = 16;
const GENERATOR_HARVEST = 8;
const SMELT_COUNT = 4;

/** The finished house as machines need it: chest, stations and centre; null before there is one. */
function homeOf(memory) {
  const house = memory.homestead?.memory?.house;
  if (!house) return null;
  const f = house.furniture;
  return { chest: f.chest.position, stations: { crafting_table: f.crafting_table.position, furnace: f.furnace.position },
    centre: house.interiorCenter, anchor: house.anchor };
}

// Machines stay off the house (and its doorstep) and off each other.
function avoidFor(memory, home, self) {
  const a = home.anchor;
  return (p) => {
    if (p.x >= a.x - 2 && p.x <= a.x + 8 && p.z >= a.z - 4 && p.z <= a.z + 8) return true;
    for (const id of ['cobbleGenerator', 'autoSmelter']) {
      const d = id !== self && memory[id]?.memory.device?.device;
      if (!d) continue;
      const cells = d.kind === 'auto_smelter' ? [...d.dig, ...d.floor, ...d.clearAbove, ...d.parts.map((x) => x.position)]
        : [...d.open, ...d.seal, ...d.clearAbove, ...d.parts.map((x) => x.position)];
      if (cells.some((c) => Math.abs(c.x - p.x) <= 1 && Math.abs(c.z - p.z) <= 1 && Math.abs(c.y - p.y) <= 2)) return true;
    }
    return false;
  };
}

function createDefaultCards({ bot, kb = KNOWLEDGE, homestead = {}, foodTarget = FOOD_TARGET } = {}) {
  // One homestead for the whole run: it holds the chosen site and which
  // furniture has been used, so every later pick continues the same house.
  const home = (memory) => (memory.homestead ||= createHomesteadGoal({ bot, ...homestead }));

  const cards = [
    {
      id: 'homestead',
      stage: 0,
      risk: 'low', // handles nights itself (bunker, then the house)
      need: (state, memory) => (memory.homestead?.isDone(state) ? 0 : 100),
      create: home,
    },
    {
      id: 'stock_food',
      stage: 1,
      risk: 'medium', // walks far after animals
      need: (state) => {
        const food = countKey('food', state.inventory, kb);
        return food >= foodTarget ? 0 : 40 + Math.round(50 * (1 - food / foodTarget));
      },
      create: () => createStockFoodGoal({ bot, target: foodTarget, kb }),
    },
  ];

  // One project per machine for the whole run, like the homestead.
  const machine = (id, makeDevice, headingOffset) => (memory) => {
    if (memory[id]) return memory[id];
    const home = homeOf(memory);
    const device = makeDevice(avoidFor(memory, home, id));
    memory[id] = createDeviceProjectGoal({ bot, name: id === 'cobbleGenerator' ? 'build_cobble_generator' : 'build_auto_smelter',
      device, home: { ...home, headingOffset }, kb });
    return memory[id];
  };
  const built = (memory, id, state) => Boolean(memory[id]?.isDone(state));
  cards.push(
    {
      id: 'cobble_generator',
      stage: 1,
      risk: 'medium', // pours lava
      requires: (state, memory) => Boolean(homeOf(memory)),
      need: (state, memory) => (built(memory, 'cobbleGenerator', state) ? 0 : 60),
      create: machine('cobbleGenerator', (avoid) => createCobbleGeneratorGoal({ bot, harvest: GENERATOR_HARVEST, collector: true, avoid }), 0),
    },
    {
      id: 'auto_smelter',
      stage: 1,
      risk: 'low',
      requires: (state, memory) => Boolean(homeOf(memory)) && built(memory, 'cobbleGenerator', state),
      need: (state, memory) => (built(memory, 'autoSmelter', state) ? 0 : 55),
      create: machine('autoSmelter', (avoid) => createAutoSmelterGoal({ bot, count: SMELT_COUNT, avoid }), Math.PI),
    },
  );

  const stageOf = (state, memory) => (memory.homestead?.isDone(state) ? 1 : 0);
  return { cards, stageOf };
}

module.exports = { createDefaultCards, homeOf, FOOD_TARGET, GENERATOR_HARVEST, SMELT_COUNT };
