/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { materialsCobblegenFlat, branchMineIronFlat } = require('./materials.cjs');
const { netherQuartzGiven } = require('./nether.cjs');
const { cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat } = require('./devices.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  netherQuartzGiven, cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat,
  materialsCobblegenFlat, branchMineIronFlat]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
