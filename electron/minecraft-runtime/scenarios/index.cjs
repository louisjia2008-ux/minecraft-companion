/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { farmFlat } = require('./farm.cjs');
const { ranchFlat } = require('./ranch.cjs');
const { materialsCobblegenFlat, branchMineIronFlat, branchMineRedstoneFlat, branchMineDiamondFlat, materialsQuartzFlat } = require('./materials.cjs');
const { netherQuartzGiven, netherStructuresGiven, netherFortressGiven, netherBastionGiven } = require('./nether.cjs');
const { endDragonGiven, endDragonDeath, endPortalNatural, endCityGiven, endFullNatural, endWaterLanding } = require('./end.cjs');
const { cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat, caneFarmFlat, mobFarmFlat, carpetDuperFlat, fishingFlat, railDuperFlat, ironFarmFlat, ironFarmVillageFlat } = require('./devices.cjs');
const { e2eFlat, machinesFlat } = require('./e2e.cjs');
const { playthroughNatural } = require('./playthrough.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  farmFlat, ranchFlat, netherQuartzGiven, netherStructuresGiven, netherFortressGiven, netherBastionGiven, endDragonGiven, endDragonDeath, endPortalNatural, endCityGiven, endFullNatural, endWaterLanding, cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat,
  materialsCobblegenFlat, branchMineIronFlat, caneFarmFlat, mobFarmFlat, carpetDuperFlat, fishingFlat, railDuperFlat, ironFarmFlat, ironFarmVillageFlat, e2eFlat, machinesFlat,
  branchMineRedstoneFlat, branchMineDiamondFlat, materialsQuartzFlat, playthroughNatural]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
