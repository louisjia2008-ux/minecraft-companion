'use strict';
// The goals the director may pick on its own, one card each (see director.js).
// A new goal joins autonomy by adding a card here; it needs no director changes.
//
// Stages are read from the world every time, never stored:
//   0  no finished home yet
//   1  home, bed, furniture and iron gear done

const { createHomesteadGoal } = require('./homestead');
const { createStockFoodGoal } = require('./stockFood');
const { KNOWLEDGE, countKey } = require('../knowledge');

const FOOD_TARGET = 16;

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

  const stageOf = (state, memory) => (memory.homestead?.isDone(state) ? 1 : 0);
  return { cards, stageOf };
}

module.exports = { createDefaultCards, FOOD_TARGET };
