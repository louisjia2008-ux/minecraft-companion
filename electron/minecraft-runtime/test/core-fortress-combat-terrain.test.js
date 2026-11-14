'use strict';

const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { withFortressCombatTerrain } = require('../core/nether');
const { sleep } = require('../core/confirm');

const rock = { name: 'nether_bricks', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const lava = { name: 'lava', boundingBox: 'empty', shapes: [] };
const portal = { name: 'nether_portal', boundingBox: 'empty', shapes: [] };
const point = (x, y, z) => new Vec3(x, y, z);
const move = (x, y, z, toBreak = [], toPlace = []) => Object.assign(point(x, y, z), { toBreak, toPlace });

function world() {
  const bot = new EventEmitter();
  const blocks = new Map();
  bot.blockAt = (p) => blocks.has(p.toString()) ? blocks.get(p.toString()) : (p.y < 74 ? rock : air);
  bot.game = { dimension: 'the_nether' };
  bot.entity = { position: point(-284.5, 74, -208.5), velocity: point(0, 0, 0), onGround: true, yaw: 0 };
  bot.controlState = {};
  bot.setControlState = (key, active) => { bot.controlState[key] = active; };
  bot.clearControlStates = () => { bot.controlState = {}; };
  const movements = { getNeighbors() { return []; }, canDig: true, allowFreeMotion: true, allowSprinting: true,
    allowParkour: true, allow1by1towers: true, maxDropDown: 3, scafoldingBlocks: [1] };
  bot.pathfinder = { movements, goal: null, enablePathShortcut: true,
    setGoal(goal) { this.goal = goal; } };
  const set = (x, y, z, block) => blocks.set(point(x, y, z).toString(), block);
  return { bot, movements, set };
}

test('fortress combat retains real dry melee stances and rejects native cliff, lava and construction moves', async () => {
  const { bot, movements, set } = world();
  const dry = move(-286, 74, -209);
  const oneDown = move(-285, 73, -210);
  const diagonal = move(-284, 74, -208);
  const cliff = move(-285, 62, -208);
  const cut = move(-285, 74, -208, [point(-285, 74, -208)]);
  const scaffold = move(-284, 74, -209, [], [{}]);
  for (let y = 62; y < 74; y += 1) set(-285, y, -208, air);
  set(-285, 73, -210, air);
  const native = movements.getNeighbors = () => [dry, oneDown, diagonal, cliff, cut, scaffold];
  const value = await withFortressCombatTerrain(bot, {}, async ({ signal }) => {
    assert.equal(signal.aborted, false);
    for (const key of ['canDig', 'allowSprinting', 'allowParkour', 'allowFreeMotion', 'allow1by1towers']) {
      assert.equal(movements[key], false, key);
    }
    assert.equal(bot.pathfinder.enablePathShortcut, false);
    assert.deepEqual(movements.getNeighbors(point(-285, 74, -209)), [dry, oneDown]);
    set(-286, 74, -208, lava);
    set(-285, 73, -210, portal);
    assert.deepEqual(movements.getNeighbors(point(-285, 74, -209)), []);
    return { ok: true, hits: 1 };
  });
  assert.deepEqual(value, { ok: true, hits: 1 });
  assert.equal(movements.getNeighbors, native);
  assert.equal(movements.maxDropDown, 3);
  assert.deepEqual(movements.scafoldingBlocks, [1]);
  assert.equal(movements.allowFreeMotion, true);
  assert.equal(movements.allowSprinting, true);
  assert.equal(bot.pathfinder.enablePathShortcut, true);
  assert.equal(bot.listenerCount('physicsTick'), 0);
});

test('live swept width brakes an approaching body while its centre is still supported', async () => {
  const { bot, set } = world();
  for (let y = 62; y < 74; y += 1) set(-285, y, -208, air);
  const records = [];
  const result = await withFortressCombatTerrain(bot, { record: (...args) => records.push(args) }, async ({ signal }) => {
    bot.pathfinder.setGoal('rising blaze over the shaft');
    bot.entity.position.z = -208.44;
    bot.entity.velocity.z = .15;
    bot.controlState.forward = true;
    bot.emit('physicsTick');
    assert.equal(Math.floor(bot.entity.position.z), -209);
    assert.equal(bot.entity.onGround, true);
    assert.equal(signal.aborted, true);
    assert.equal(bot.pathfinder.goal, null);
    assert.equal(bot.controlState.forward, undefined);
    await sleep(50, signal);
  });
  assert.deepEqual(result, { ok: false, reason: 'fortress_combat_unsafe_footing' });
  assert.equal(records[0][0], 'fortress_combat_terrain_blocked');
});

test('a physical one-block descent is allowed and a direct deep grounded correction is stopped', async () => {
  const { bot, set } = world();
  set(-285, 73, -208, air);
  const result = await withFortressCombatTerrain(bot, {}, async ({ signal }) => {
    bot.entity.position = point(-284.5, 73.7, -208.22);
    bot.entity.onGround = false;
    bot.emit('physicsTick');
    assert.equal(signal.aborted, false);
    bot.entity.position = point(-284.5, 73, -207.5);
    bot.entity.onGround = true;
    bot.emit('physicsTick');
    assert.equal(signal.aborted, false);
    for (let y = 62; y < 72; y += 1) set(-285, y, -207, air);
    bot.entity.position = point(-284.5, 62, -206.5);
    bot.emit('forcedMove');
    assert.equal(signal.reason, 'fortress_combat_unsafe_footing');
  });
  assert.deepEqual(result, { ok: false, reason: 'fortress_combat_unsafe_footing' });
});

test('combat preserves the parent abort and never starts with an airborne body', async () => {
  const { bot } = world();
  const abort = new AbortController();
  await assert.rejects(withFortressCombatTerrain(bot, { signal: abort.signal }, async ({ signal }) => {
    abort.abort('preempted');
    await sleep(50, signal);
  }), { code: 'aborted', message: 'preempted' });
  bot.entity.onGround = false;
  const result = await withFortressCombatTerrain(bot, {}, () => assert.fail('airborne combat must wait'));
  assert.deepEqual(result, { ok: false, reason: 'fortress_combat_unsafe_footing' });
  assert.equal(bot.listenerCount('forcedMove'), 0);
});

test('combat rejects both planning and native displacement beyond its local footing radius', async () => {
  const { bot, movements } = world();
  const inside = move(-273, 74, -209);
  const outside = move(-272, 74, -209);
  movements.getNeighbors = () => [inside, outside];
  const result = await withFortressCombatTerrain(bot, {}, async ({ signal }) => {
    assert.deepEqual(movements.getNeighbors(point(-273, 74, -209)), []);
    assert.deepEqual(movements.getNeighbors(point(-274, 74, -209)), [inside]);
    bot.entity.position.x += 12.01;
    bot.emit('forcedMove');
    assert.equal(signal.reason, 'fortress_combat_move_limit');
  });
  assert.deepEqual(result, { ok: false, reason: 'fortress_combat_move_limit' });
});
