'use strict';
// Acknowledged movement fixtures test bridge route admission and retirement;
// actual terrain traversal still needs the real-server acceptance campaign.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createPortalTrip } = require('../core/netherTrip');
const end = require('../core/end');
const nether = require('../core/nether');

function fixture({ route = true, broken, unknown } = {}) {
  const moves = [];
  const controls = { forward: false };
  const profile = { allowParkour: true, maxDropDown: 3 };
  const faults = { broken, unknown };
  const memory = { netherPortal: new Vec3(0, 70, 0),
    ...(route ? { ledgeRoute: Array.from({ length: 6 }, (_, x) => new Vec3(x, 70, 0)), ledgeLanding: new Vec3(5, 70, 0) } : {}) };
  const bot = { game: { dimension: 'the_nether' }, pathfinder: { movements: profile },
    entity: { position: new Vec3(40.5, 70, 0.5), onGround: true },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt(p) {
      const q = p.floored();
      if (q.x === faults.unknown && q.y === 69 && q.z === 0) return null;
      const name = q.y === 69 && q.z === 0 && q.x >= 0 && q.x <= 5 ? (q.x === faults.broken ? 'lava' : 'cobblestone')
        : q.x === 0 && q.y === 70 && q.z === 0 ? 'nether_portal' : 'air';
      return { name, position: q, boundingBox: name === 'cobblestone' ? 'block' : 'empty' };
    } };
  const actions = {
    goNear: async (_bot, _ctx, target) => {
      moves.push({ target, parkour: profile.allowParkour, drop: profile.maxDropDown });
      bot.entity.position = target.floored().offset(0.5, 0, 0.5);
      return { ok: true };
    },
    haltBody: () => { controls.forward = false; },
  };
  return { bot, memory, moves, controls, profile, faults, trip: createPortalTrip({ bot, memory, actions }) };
}

test('a known bridge returns via its confirmed landing and reverses every supported cell', async (t) => {
  const f = fixture();
  const reversed = [];
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, target, options) => {
    assert.equal(options.keepWalls, true);
    reversed.push(target.x);
    f.bot.entity.position = target.floored().offset(0.5, 0, 0.5);
    return { ok: true };
  });
  const result = await f.trip.toOverworld({ signal: new AbortController().signal, record() {} });
  assert.equal(f.moves[0].target.x, 5, 'ordinary GoalNear(portal) must not bypass the landing and bridge');
  assert.deepEqual([f.moves[0].parkour, f.moves[0].drop], [false, 1]);
  assert.deepEqual(reversed, [4.5, 3.5, 2.5, 1.5, 0.5]);
  assert.equal(result.retraced, true);
  assert.deepEqual(f.profile, { allowParkour: true, maxDropDown: 3 });
});

for (const fault of ['broken', 'unknown']) test(`a ${fault} bridge is rejected before any return movement`, async () => {
  const f = fixture({ [fault]: 3 });
  const result = await f.trip.toOverworld({ signal: new AbortController().signal, record() {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, fault === 'broken' ? 'bridge_route_unsafe' : 'bridge_route_unknown');
  assert.equal(f.moves.length, 0, 'historic coordinates never authorize a now-invalid route');
  assert.deepEqual(f.profile, { allowParkour: true, maxDropDown: 3 });
});

test('a bridge cell changed after the anchor approach is rechecked before the next step', async (t) => {
  const f = fixture();
  let calls = 0;
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, target) => {
    calls++;
    f.bot.entity.position = target.floored().offset(0.5, 0, 0.5);
    f.faults.broken = 2;
    return { ok: true };
  });
  assert.equal((await f.trip.toOverworld({ signal: new AbortController().signal, record() {} })).reason, 'bridge_route_unsafe');
  assert.equal(calls, 1, 'changed geometry cannot reuse the admission of an earlier step');
});

test('a discontinuous historical route never authorizes an automatic gap crossing', async () => {
  const f = fixture();
  f.memory.ledgeRoute.splice(2, 1);
  assert.equal((await f.trip.toOverworld({ signal: new AbortController().signal, record() {} })).reason, 'bridge_route_discontinuous');
  assert.equal(f.moves.length, 0);
});

test('already at the actual portal end, a broken remote bridge does not block a normal portal exit', async (t) => {
  const f = fixture({ broken: 3 });
  f.bot.entity.position = new Vec3(0.5, 70, 0.5);
  t.mock.method(nether, 'travel', async () => ({ ok: false, reason: 'fixture_portal_crossing' }));
  assert.equal((await f.trip.toOverworld({ signal: new AbortController().signal, record() {} })).reason, 'fixture_portal_crossing');
  assert.equal(f.moves.length, 0);
});

test('crossing dimensions cannot restore a stale Nether drop limit over the overworld profile', async (t) => {
  const f = fixture();
  f.bot.entity.position = new Vec3(0.5, 70, 0.5);
  t.mock.method(nether, 'travel', async () => {
    f.bot.game.dimension = 'overworld';
    f.profile.maxDropDown = 4; // leaveNetherMode restores the overworld profile
    return { ok: true };
  });
  t.mock.method(nether, 'findPortal', () => null);
  t.mock.method(nether, 'leavePortal', async () => ({ ok: true }));
  assert.equal((await f.trip.toOverworld({ record() {} })).ok, true);
  assert.deepEqual(f.profile, { allowParkour: true, maxDropDown: 4 });
});

test('return cancellation stops controls and restores the caller movement profile', async (t) => {
  const f = fixture();
  const controller = new AbortController();
  t.mock.method(end, 'bridgeStep', async (_bot, ctx) => {
    f.controls.forward = true;
    controller.abort('cancel_return');
    assert.equal(ctx.signal.aborted, true);
    throw Object.assign(new Error('aborted'), { code: 'aborted' });
  });
  await assert.rejects(f.trip.toOverworld({ signal: controller.signal, record() {} }), { code: 'aborted' });
  assert.equal(f.controls.forward, false);
  assert.deepEqual(f.profile, { allowParkour: true, maxDropDown: 3 });
});

test('a trip with no confirmed bridge retains the normal portal return path', async () => {
  const f = fixture({ route: false });
  assert.equal((await f.trip.toOverworld({ signal: new AbortController().signal, record() {} })).ok, true);
  assert.equal(f.moves[0].target.x, 0);
  assert.deepEqual([f.moves[0].parkour, f.moves[0].drop], [true, 3]);
});
