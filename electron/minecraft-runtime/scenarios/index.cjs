/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { cobbleGeneratorFlat } = require('./devices.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat,
  cobbleGeneratorFlat]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
