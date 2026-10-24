/* global module */
'use strict';
// Regression suites for `npm run regression`. Each entry runs one scenario
// `runs` times on its own fresh server; the suite fails when a scenario's pass
// rate drops below `minPassRate`. The full acceptance suite requires every
// registered scenario and every round to pass. The scenario CLI also exits
// nonzero on any failed round, including in the historical quick suite.

const { SCENARIOS } = require('./index.cjs');

const QUICK = [
  { scenario: 'collect-logs-flat', runs: 3, minPassRate: 1 },
  { scenario: 'night-bed-flat', runs: 2, minPassRate: 1 },
  // 9/10 on 2026-10-22: a creeper can catch the bot back at work after dawn.
  { scenario: 'night-bunker-flat', runs: 2, minPassRate: 0.5 },
  { scenario: 'farm-flat', runs: 2, minPassRate: 1 },
  { scenario: 'ranch-flat', runs: 2, minPassRate: 1 },
];

const SUITES = {
  // Bed, bunker, farming and ranching skills: about half an hour with two at once.
  quick: QUICK,
  // Preserve the existing repeated rounds, then cover every other scenario.
  full: Object.keys(SCENARIOS).map((scenario) => ({ scenario,
    runs: QUICK.find((entry) => entry.scenario === scenario)?.runs
      || (scenario === 'collect-logs-natural' ? 3 : 1), minPassRate: 1 })),
};

module.exports = { SUITES };
