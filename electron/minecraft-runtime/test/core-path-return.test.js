'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { trackReturnPositions, dropReturnPosition } = require('../core/pathReturn');

test('a bridge step return spot is let go when the body halts', () => {
  const bot = { entity: { position: new Vec3(-16543.5, 64, -255.5) } };
  const movements = { getNeighbors: () => [{ toPlace: [{ x: 384, y: 52, z: -432, returnPos: new Vec3(384, 53, -432) }] }, { toPlace: [] }] };
  trackReturnPositions(bot, movements);
  const [move] = movements.getNeighbors({});
  // What the pathfinder keeps after placing the block.
  const returning = move.toPlace[0].returnPos.clone();
  assert.deepEqual(returning.toArray(), [384, 53, -432]);
  assert.deepEqual(returning.clone().toArray(), [384, 53, -432]);
  dropReturnPosition(bot);
  // moveToBlock clones the spot and aims at its centre: that is now the bot's own position.
  assert.ok(returning.clone().offset(0.5, 0, 0.5).distanceTo(bot.entity.position) < 1e-9);
  assert.equal(bot.companionReturnPos, null);
  dropReturnPosition(bot);
});

test('a return spot let go in mid-air still counts as reached after landing', () => {
  const bot = { entity: { position: new Vec3(-2525.52, 33.77, -1665.7) } };
  const movements = { getNeighbors: () => [{ toPlace: [{ x: -2526, y: 32, z: -1667, returnPos: new Vec3(-2526, 33, -1667) }] }] };
  trackReturnPositions(bot, movements);
  const returning = movements.getNeighbors({})[0].toPlace[0].returnPos.clone();
  dropReturnPosition(bot);
  // Landed a block and a half lower, then knocked aside.
  bot.entity.position = new Vec3(-2524.1, 32, -1663.3);
  assert.ok(returning.clone().offset(0.5, 0, 0.5).distanceTo(bot.entity.position) < 1e-9);
});
