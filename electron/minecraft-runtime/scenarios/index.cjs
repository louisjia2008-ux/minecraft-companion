/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { farmFlat } = require('./farm.cjs');
const { ranchFlat } = require('./ranch.cjs');
const { materialsCobblegenFlat, branchMineIronFlat, branchMineRedstoneFlat, branchMineDiamondFlat, materialsQuartzFlat } = require('./materials.cjs');
const { netherQuartzGiven } = require('./nether.cjs');
const { cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat, caneFarmFlat, mobFarmFlat, carpetDuperFlat, fishingFlat, railDuperFlat, ironFarmFlat } = require('./devices.cjs');
const { e2eFlat, machinesFlat } = require('./e2e.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  farmFlat, ranchFlat, netherQuartzGiven, cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat,
  materialsCobblegenFlat, branchMineIronFlat, caneFarmFlat, mobFarmFlat, carpetDuperFlat, fishingFlat, railDuperFlat, ironFarmFlat, e2eFlat, machinesFlat,
  branchMineRedstoneFlat, branchMineDiamondFlat, materialsQuartzFlat]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
