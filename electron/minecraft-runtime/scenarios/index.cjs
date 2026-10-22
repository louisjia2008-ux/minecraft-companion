/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { materialsCobblegenFlat, branchMineIronFlat } = require('./materials.cjs');
const { netherQuartzGiven } = require('./nether.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  netherQuartzGiven, materialsCobblegenFlat, branchMineIronFlat]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
