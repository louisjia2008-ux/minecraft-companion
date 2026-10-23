'use strict';
// Goal: build the button-driven carpet duplicator (blueprints/carpetDuper.js)
// and press it until `count` new carpets are in the inventory (goals/duper.js).

const { createCarpetDuper } = require('../blueprints/carpetDuper');
const { createDuperGoal, chooseDeviceSite, evaluateDeviceSite } = require('./duper');

const evaluateCarpetDuperSite = (blockAt, anchor, facing) => evaluateDeviceSite(createCarpetDuper, blockAt, anchor, facing);
/** Nearest flat spot; the anchor is the ground block under the piston. */
const chooseCarpetDuperSite = (blockAt, around, options) => chooseDeviceSite(createCarpetDuper, blockAt, around, options);

function createCarpetDuperGoal(options = {}) {
  return createDuperGoal({ ...options, name: 'carpet_duper', create: createCarpetDuper, product: 'white_carpet', seedKey: 'carpet' });
}

module.exports = { createCarpetDuperGoal, chooseCarpetDuperSite, evaluateCarpetDuperSite };
