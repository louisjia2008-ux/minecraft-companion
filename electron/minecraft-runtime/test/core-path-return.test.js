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
  dropReturnPosition(bot);
  // moveToBlock aims at the spot's centre: that is now the bot's own position.
  assert.ok(returning.offset(0.5, 0, 0.5).distanceTo(bot.entity.position) < 1e-9);
  assert.equal(bot.companionReturnPos, null);
  dropReturnPosition(bot);
});
