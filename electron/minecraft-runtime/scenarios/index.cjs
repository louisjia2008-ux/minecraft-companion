/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { farmFlat } = require('./farm.cjs');
const { ranchFlat } = require('./ranch.cjs');
const { materialsCobblegenFlat, branchMineIronFlat, branchMineRedstoneFlat, branchMineDiamondFlat } = require('./materials.cjs');
const { netherQuartzGiven } = require('./nether.cjs');
const { cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat, caneFarmFlat, mobFarmFlat, carpetDuperFlat } = require('./devices.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  farmFlat, ranchFlat, netherQuartzGiven, cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat,
  materialsCobblegenFlat, branchMineIronFlat, branchMineRedstoneFlat, branchMineDiamondFlat, caneFarmFlat, mobFarmFlat, carpetDuperFlat]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
