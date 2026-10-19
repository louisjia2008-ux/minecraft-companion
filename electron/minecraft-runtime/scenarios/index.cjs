/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');
const { homesteadFlat, homesteadNatural } = require('./homestead.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural, homesteadFlat, homesteadNatural]
  .map((s) => [s.name, s]));

module.exports = { SCENARIOS };
