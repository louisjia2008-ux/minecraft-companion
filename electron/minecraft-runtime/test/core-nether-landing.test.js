'use strict';
// Voxel/action fixtures verify ownership of the bridge-to-land handoff. These
// tests do not establish native physics or a real-server traversal result.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createPortalTrip } = require('../core/netherTrip');
const end = require('../core/end');
const actions = require('../core/actions');

function fixture() {
  const cells = new Map();
  const put = (x, y, z, name) => cells.set(`${x},${y},${z}`, name);
  const bot = { game: { dimension: 'the_nether' }, entity: { position: new Vec3(0.5, 70, 0.5), onGround: true },
    inventory: { items: () => [{ name: 'cobblestone', count: 64 }] },
    blockAt(p) {
      const q = p.floored();
      const name = cells.get(`${q.x},${q.y},${q.z}`) || (q.y <= 31 ? 'lava' : 'air');
      return { name, position: q, boundingBox: /^(air|lava|nether_portal)$/.test(name) ? 'empty' : 'block' };
    } };
  put(0, 69, 0, 'obsidian');
  return { bot, put, trip: createPortalTrip({ bot, memory: {} }) };
}

test('a lower basalt shelf near the bridge is not a level landing; choose the supported level island', () => {
  const f = fixture();
  for (let x = 3; x <= 6; x++) for (let z = 0; z <= 2; z++) f.put(x, 66, z, 'basalt');
  for (let x = 10; x <= 14; x++) for (let z = 0; z <= 2; z++) f.put(x, 69, z, 'netherrack');
  const target = f.trip.landFrom([new Vec3(0, 70, 0)]);
  assert.equal(target.y, 69, 'landing floor must match the bridge support height');
  assert.ok(target.x >= 10, 'a shelf three blocks below cannot be handed to ordinary mining');
});

test('a bridge ends only after standing on continuous natural land, not one cell short of it', async (t) => {
  const f = fixture();
  for (let x = 1; x <= 4; x++) f.put(x, 69, 0, 'cobblestone');
  for (let x = 5; x <= 8; x++) for (let z = 0; z <= 2; z++) f.put(x, 69, z, 'netherrack');
  let steps = 0;
  t.mock.method(end, 'bridgeStep', async () => {
    // An acknowledged one-cell body step; world geometry is unchanged.
    f.bot.entity.position = f.bot.entity.position.offset(1, 0, 0);
    steps++;
    return { ok: true, moved: 1 };
  });
  const result = await f.trip.leaveLedge({ record() {} }, [new Vec3(0, 70, 0)]);
  assert.equal(steps, 5, 'the final cell onto land is part of the bridge action');
  assert.equal(result.landed, true);
  assert.equal(f.trip.memory.ledgeTransit, false);
  assert.deepEqual(f.trip.memory.ledgeRoute.map((p) => p.x), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(f.trip.memory.ledgeLanding, new Vec3(5, 70, 0));
  assert.equal(f.bot.blockAt(f.bot.entity.position.offset(0, -1, 0)).name, 'netherrack');
});

test('partial bridge progress retains transit ownership instead of authorizing ordinary mining', async (t) => {
  const f = fixture();
  for (let x = 1; x <= 4; x++) f.put(x, 69, 0, 'cobblestone');
  for (let x = 5; x <= 8; x++) for (let z = 0; z <= 2; z++) f.put(x, 69, z, 'netherrack');
  let calls = 0;
  t.mock.method(end, 'bridgeStep', async () => {
    if (++calls > 2) return { ok: false, reason: 'no_bridge_blocks' };
    f.bot.entity.position = f.bot.entity.position.offset(1, 0, 0);
    return { ok: true, moved: 1 };
  });
  const result = await f.trip.leaveLedge({ record() {} }, [new Vec3(0, 70, 0)]);
  assert.equal(result.landed, false);
  assert.equal(f.trip.memory.ledgeTransit, true);
  assert.equal(result.reason, 'ledge_no_blocks');
});

test('recentre on a narrow supported bridge never presses forward without sneak', async () => {
  const f = fixture();
  f.bot.entity.position = new Vec3(0.8, 70, 0.5);
  const control = {};
  f.bot.controlState = control;
  f.bot.lookAt = async () => {};
  f.bot.setControlState = (key, value) => {
    if (key === 'forward' && value) assert.equal(control.sneak, true, 'a bridge centring pulse must be edge-protected');
    control[key] = value;
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('fixture_end'), 5);
  try { await assert.rejects(actions.recentre(f.bot, { signal: controller.signal }), { code: 'aborted' }); }
  finally { clearTimeout(timer); }
  assert.equal(control.forward, false);
  assert.equal(control.sneak, false);
});

test('an unsupported in-transit body retains the bridge handoff instead of returning to mining', async () => {
  const f = fixture();
  f.trip.memory.ledgeTransit = true;
  f.bot.entity.onGround = false;
  const ownedCells = f.trip.ledge();
  assert.ok(ownedCells, 'transit cannot disappear merely because the body is falling');
  assert.equal((await f.trip.leaveLedge({ record() {} }, ownedCells)).reason, 'bridge_not_grounded');
  assert.equal(f.trip.memory.ledgeTransit, true);
});

test('a replacement goal on the same bot regains the observed bridge but still rejects changed geometry', async (t) => {
  const f = fixture();
  f.trip.memory.netherPortal = new Vec3(0, 70, 0);
  f.put(0, 70, 0, 'nether_portal');
  for (let x = 1; x <= 4; x++) f.put(x, 69, 0, 'cobblestone');
  for (let x = 5; x <= 8; x++) for (let z = 0; z <= 2; z++) f.put(x, 69, z, 'netherrack');
  t.mock.method(end, 'bridgeStep', async () => {
    f.bot.entity.position = f.bot.entity.position.offset(1, 0, 0);
    return { ok: true };
  });
  assert.equal((await f.trip.leaveLedge({ record() {} }, [new Vec3(0, 70, 0)])).landed, true);
  const next = createPortalTrip({ bot: f.bot, memory: { netherPortal: new Vec3(0, 70, 0) } });
  next.netherPortal();
  assert.deepEqual(next.memory.ledgeRoute.map((p) => p.x), [0, 1, 2, 3, 4, 5]);
  assert.notEqual(next.memory.ledgeRoute, f.trip.memory.ledgeRoute, 'goal instances do not share mutable route arrays');
  const reverse = [];
  t.mock.method(end, 'bridgeStep', async (_bot, _ctx, target) => {
    reverse.push(target.x);
    f.bot.entity.position = target.floored().offset(0.5, 0, 0.5);
    return { ok: true };
  });
  assert.equal((await next.toOverworld({ record() {} })).retraced, true);
  assert.deepEqual(reverse, [4.5, 3.5, 2.5, 1.5, 0.5]);
  f.bot.entity.position = new Vec3(5.5, 70, 0.5);
  f.put(2, 69, 0, 'lava');
  assert.equal((await next.toOverworld({ record() {} })).reason, 'bridge_route_unsafe');
  const freshBot = { ...f.bot };
  delete freshBot.companionNetherBridgeRoutes;
  const fresh = createPortalTrip({ bot: freshBot, memory: { netherPortal: new Vec3(0, 70, 0) } });
  fresh.netherPortal();
  assert.equal(fresh.memory.ledgeRoute, undefined, 'a new bot has no persistent bridge observations');
});

test('recentre leaves swimming, ladders and unsupported bodies to the native planner', async () => {
  const f = fixture();
  f.bot.entity.position = new Vec3(0.8, 70, 0.5);
  f.bot.entity.onGround = false;
  f.bot.lookAt = async () => {};
  f.bot.setControlState = () => assert.fail('an unsupported body must not be manually pushed');
  await actions.recentre(f.bot, { signal: new AbortController().signal });
});

for (const ownership of ['recent', 'recorded']) test(`a 2x2 self-placed netherrack platform is not natural land (${ownership})`, async () => {
  const f = fixture();
  const supports = new Set();
  for (const x of [0, 1]) for (const z of [0, 1]) {
    f.put(x, 69, z, 'netherrack');
    supports.add(`${x},69,${z}`);
  }
  f.trip.memory.ledgeTransit = true;
  f.bot.companionPlacedRecently = (p) => ownership === 'recent' && supports.has(`${p.x},${p.y},${p.z}`);
  if (ownership === 'recorded') f.trip.memory.ledgeSupports = new Set(supports);
  assert.ok(f.trip.ledge(), 'a self-built platform must retain transit ownership');
  assert.notEqual((await f.trip.leaveLedge({ record() {} }, [new Vec3(0, 70, 0)])).landed, true);
  assert.equal(f.trip.memory.ledgeTransit, true);
});

test('an acknowledged bridge step that actually lands three blocks low never authorizes mining', async (t) => {
  const f = fixture();
  for (let x = 5; x <= 8; x++) for (let z = 0; z <= 2; z++) f.put(x, 69, z, 'netherrack');
  for (const x of [1, 2]) for (const z of [0, 1]) f.put(x, 66, z, 'basalt');
  t.mock.method(end, 'bridgeStep', async () => {
    // A native action acknowledgement is not proof of the body's landing.
    f.bot.entity.position = new Vec3(1.5, 67, 0.5);
    return { ok: true };
  });
  const result = await f.trip.leaveLedge({ record() {} }, [new Vec3(0, 70, 0)]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bridge_step_unconfirmed');
  assert.equal(result.landed, false);
  assert.equal(f.trip.memory.ledgeTransit, true);
  assert.deepEqual(f.trip.memory.ledgeRoute, [new Vec3(0, 70, 0)], 'the unconfirmed lower leg is never recorded as a safe route');
  assert.ok(f.trip.ledge(), 'standing on a lower natural patch does not clear the original transit');
});

test('observed netherrack bridge supports survive placement TTL expiry and a replacement goal', async (t) => {
  const f = fixture();
  f.trip.memory.netherPortal = new Vec3(0, 70, 0);
  f.put(0, 70, 0, 'nether_portal');
  for (let x = 5; x <= 8; x++) for (let z = 0; z <= 2; z++) f.put(x, 69, z, 'netherrack');
  t.mock.method(end, 'bridgeStep', async () => {
    const next = f.bot.entity.position.floored().offset(1, 0, 0);
    if (f.bot.blockAt(next.offset(0, -1, 0)).boundingBox !== 'block') f.put(next.x, next.y - 1, next.z, 'netherrack');
    f.bot.entity.position = next.offset(0.5, 0, 0.5);
    return { ok: true };
  });
  assert.equal((await f.trip.leaveLedge({ record() {} }, [new Vec3(0, 70, 0)])).landed, true);
  assert.equal(f.trip.memory.ledgeSupports.has('1,69,0'), true);
  assert.equal(f.trip.memory.ledgeSupports.has('5,69,0'), false, 'the actual preexisting natural shore is not marked as scaffolding');
  f.bot.companionPlacedRecently = () => false; // the short placement memory has expired
  const next = createPortalTrip({ bot: f.bot, memory: { netherPortal: new Vec3(0, 70, 0), ledgeTransit: true } });
  next.netherPortal();
  assert.equal(next.memory.ledgeSupports.has('1,69,0'), true);
  f.put(1, 69, 1, 'netherrack');
  f.put(2, 69, 1, 'netherrack');
  f.bot.entity.position = new Vec3(1.5, 70, 0.5);
  assert.ok(next.ledge(), 'an expanded own bridge is not a newly discovered natural landing');
  assert.equal(next.memory.ledgeTransit, true);
});
