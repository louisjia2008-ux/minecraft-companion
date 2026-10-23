'use strict';
// Goal: build the rail duplicator (blueprints/railDuper.js) and press it until
// `count` new rails are in the inventory (goals/duper.js). The carpets it
// makes on the side are picked up too.

const { createRailDuper } = require('../blueprints/railDuper');
const { createDuperGoal, chooseDeviceSite, evaluateDeviceSite } = require('./duper');

const evaluateRailDuperSite = (blockAt, anchor, facing) => evaluateDeviceSite(createRailDuper, blockAt, anchor, facing);
/** Nearest flat spot; the anchor is the ground block under the piston pillar. */
const chooseRailDuperSite = (blockAt, around, options) => chooseDeviceSite(createRailDuper, blockAt, around, options);

function createRailDuperGoal(options = {}) {
  return createDuperGoal({ ...options, name: 'rail_duper', create: createRailDuper, product: 'rail', seedKey: 'rail',
    pickup: (n) => n === 'rail' || n === 'white_carpet' });
}

module.exports = { createRailDuperGoal, chooseRailDuperSite, evaluateRailDuperSite };
