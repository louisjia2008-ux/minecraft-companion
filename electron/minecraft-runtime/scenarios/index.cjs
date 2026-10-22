/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { netherQuartzGiven } = require('./nether.cjs');
const { cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat, caneFarmFlat } = require('./devices.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  netherQuartzGiven, cobbleGeneratorFlat, cobbleGeneratorHopperFlat, autoSmelterFlat, caneFarmFlat]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
