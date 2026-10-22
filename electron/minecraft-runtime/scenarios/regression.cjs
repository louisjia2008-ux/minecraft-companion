/* global module */
'use strict';
// Regression suites for `npm run regression`. Each entry runs one scenario
// `runs` times on its own fresh server; the suite fails when a scenario's pass
// rate drops below `minPassRate`. Gates sit at the rate the scenario reaches
// today, so a lower rate means the change made things worse.

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
  // Adds natural terrain and the whole homestead chain: several hours.
  full: [
    ...QUICK,
    { scenario: 'collect-logs-natural', runs: 3, minPassRate: 2 / 3 },
    { scenario: 'homestead-flat', runs: 1, minPassRate: 1 },
  ],
};

module.exports = { SUITES };
