/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { materialsCobblegenFlat, branchMineIronFlat } = require('./materials.cjs');
const { netherQuartzGiven } = require('./nether.cjs');
const { cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat } = require('./devices.cjs');
const { farmFlat } = require('./farm.cjs');
const { ranchFlat } = require('./ranch.cjs');
const { e2eFlat, machinesFlat } = require('./e2e.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  netherQuartzGiven, cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat, materialsCobblegenFlat, branchMineIronFlat,
  farmFlat, ranchFlat, e2eFlat, machinesFlat]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
