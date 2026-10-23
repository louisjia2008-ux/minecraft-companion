'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

test('an archer ten blocks off is chased by day but not at night', () => {
  const bot = { entity: { position: new Vec3(0, 64, 0) }, registry: { foodsByName: {} }, inventory: { slots: [] }, on() {} };
  const defend = createSurvivalBehaviors({ bot }).find((b) => b.name === 'defend');
  const skeleton = { id: 1, name: 'skeleton', distance: 10, position: new Vec3(10, 64, 0) };
  const state = { health: 20, food: 20, position: new Vec3(0, 64, 0), inventory: { iron_sword: 1 }, hostiles: [skeleton] };
  assert.equal(defend.want({ ...state, isDay: true }), 1);
  assert.equal(defend.want({ ...state, isDay: false }), 0);
  assert.equal(defend.want({ ...state, isDay: false, hostiles: [{ ...skeleton, distance: 4 }] }), 1);
});
