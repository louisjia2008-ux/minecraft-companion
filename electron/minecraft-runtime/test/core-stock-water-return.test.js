'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { createStockWaterReturn } = require('../core/goals/stockWaterReturn');
const { standable } = require('../core/caveRetreat');

const solid = (name) => ({ name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] });
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const water = (level = 0) => ({ name: 'water', boundingBox: 'empty', shapes: [], getProperties: () => ({ level }) });

function corridor({ wet = water(), roof = false, hostile = false, shallowExit = false, daylight = true, timeOfDay = 1000,
  airSupply = 300, reserve = 8 } = {}) {
  const entity = { id: 1, onGround: true, position: new Vec3(.5, 63, .5), isInWater: false,
    metadata: [airSupply] };
  const bot = {
    entity,
    game: { dimension: 'overworld' },
    entities: { ...(hostile ? { 2: { id: 2, isValid: true, name: 'drowned', position: new Vec3(8, 59, 1) } } : {}) },
    registry: { entitiesByName: { player: { metadataKeys: ['air_supply'] } } },
    blockAt(p) {
      if (Math.abs(p.z) > 2 || p.x < -3 || p.x > (shallowExit ? 17 : 50)) return null;
      if (p.y === 62 && p.x > 0 && p.x < 17) return p.x === 8 ? wet : water();
      if (roof && p.x === 8 && p.y === 64) return solid('stone');
      if (p.y <= 62) return solid('dirt');
      return air;
    },
  };
  const events = [];
  const state = { isDay: daylight, timeOfDay, health: 20, food: 20, inventory: { iron_sword: 1, bread: reserve } };
  const ctx = { record: (type, data) => events.push({ type, ...data }), perceive: () => state };
  const exposed = (p) => standable((q) => bot.blockAt(q), p);
  const trip = createStockWaterReturn({ bot, centre: new Vec3(33, 63, 0), exposed, actions: {},
    safe: ({ inventory }) => inventory.bread >= 2 });
  return { trip, ctx, events };
}

test('stock return admits a loaded short source-water lane between dry banks with onward home progress', async () => {
  const { trip, ctx, events } = corridor();
  assert.equal(await trip.plan(ctx), true);
  assert.equal(trip.pending(), true);
  assert.equal(events[0].type, 'stock_water_return_plan');
  assert.equal(events[0].from.x, 0);
  assert.equal(events[0].to.x, 17);
  assert.ok(events[0].span <= 20);
});

test('stock return declines flowing and unknown water, low ceilings, drowned, and a stranded far shore', async () => {
  for (const input of [{ wet: water(1) }, { wet: null }, { roof: true }, { hostile: true }, { shallowExit: true }]) {
    const { trip, ctx, events } = corridor(input);
    assert.equal(await trip.plan(ctx), false);
    assert.deepEqual(events, []);
  }
});

test('stock return requires daytime, healthy breath and carried provisions before entering the lane', async () => {
  for (const input of [{ daylight: false }, { timeOfDay: 12000 }, { airSupply: 270 }, { reserve: 1 }]) {
    const { trip, ctx, events } = corridor(input);
    assert.equal(await trip.plan(ctx), false);
    assert.deepEqual(events, []);
  }
});
