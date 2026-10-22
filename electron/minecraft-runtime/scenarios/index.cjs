/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat } = require('./homestead.cjs');
const { farmFlat } = require('./farm.cjs');
const { ranchFlat } = require('./ranch.cjs');
const { mineNatural } = require('./mine.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural, nightBunkerFlat, nightBedFlat, farmFlat, ranchFlat, mineNatural]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
