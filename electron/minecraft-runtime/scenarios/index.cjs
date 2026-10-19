/* global require, module */
'use strict';
const { collectLogsFlat, collectLogsNatural } = require('./collectLogs.cjs');

const SCENARIOS = Object.fromEntries([collectLogsFlat, collectLogsNatural].map((s) => [s.name, s]));

module.exports = { SCENARIOS };
