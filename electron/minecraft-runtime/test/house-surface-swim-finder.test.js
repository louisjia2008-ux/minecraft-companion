/* global require */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const req = require;
const { Vec3 } = req('vec3'), { pathfinder, Movements, goals } = req('mineflayer-pathfinder');
const registry = req('prismarine-registry')('1.21.8'), Block = req('prismarine-block')(registry), Entity = req('prismarine-entity')('1.21.8');
const { createLoadedSurfaceSwimFinder, routeIdentity } = require('../vendor/server/minecraft/houseSurfaceSwimFinder');
const { readHouseBotOxygen } = require('../vendor/server/minecraft/houseBotOxygen');

// OFFLINE immutable voxel geometry. Actual installed entities metadata and
// pathfinder A* are used, but no movement/controls/position or world edits occur
// after initial fixture setup. This is discovery, not native swim acceptance.
function fixture(width = 32, options = {}) {
  const d = options.direction || { x: 1, z: 0 }, tangent = { x: -d.z, z: d.x }, base = { x: 10, z: -12 };
  const local = p => ({ u: (p.x - base.x) * d.x + (p.z - base.z) * d.z, v: (p.x - base.x) * tangent.x + (p.z - base.z) * tangent.z });
  const world = (u, v = 0, y = 2) => new Vec3(base.x + d.x * u + tangent.x * v, y, base.z + d.z * u + tangent.z * v);
  let cancelled = false, current = true, calls = 0;
  const controls = [], reads = [], client = Object.assign(new EventEmitter(), { username: 'LoadedSwimFinder', state: 'play', write: () => {} });
  const bot = Object.assign(new EventEmitter(), { version: '1.21.8', registry, username: 'LoadedSwimFinder', _client: client,
    supportFeature: name => registry.supportFeature(name), health: 20, food: 20, game: { minY: -64, height: 384, dimension: 'overworld' },
    inventory: { slots: Array(46).fill(null), items: () => [] }, player: { ping: 1 } });
  req('mineflayer/lib/plugins/entities')(bot); client.emit('login', { entityId: 1 });
  Object.assign(bot.entity, { position: world(options.originU ?? -7, 0, options.originY ?? 2).offset(.5, 0, .5), velocity: new Vec3(0, 0, 0),
    onGround: true, isInWater: false, isInLava: false, isInWeb: false, height: 1.8, width: .6, eyeHeight: 1.62, yaw: 0, pitch: 0, effects: {}, attributes: {} });
  const metadata = (id, raw) => client.emit('entity_metadata', { entityId: id,
    metadata: [{ key: registry.entitiesByName[id === 1 ? 'player' : 'rabbit'].metadataKeys.indexOf('air_supply'), type: 'varint', value: raw }] });
  metadata(1, options.ownAir ?? 300);
  const geometry = (p, { u, v }) => {
    if (Math.abs(v) > 4 || u < -24 || u > width + 5 || p.y > 8 || p.y < -12) return null;
    const water = u >= 0 && u < width || options.narrow === true && (u === -1 || u === width) && v !== 0;
    if (p.y > 1) return 'air';
    if (water) return p.y === 1 ? 'water' : null; // Bottom stays UNKNOWN at any depth.
    if (u <= -2) return p.y >= -8 ? 'sand' : 'stone'; // Legal thick dry approach.
    return p.y >= 0 ? 'sand' : 'stone'; // Stable center bank2sand + solidbase.
  };
  bot.blockAt = raw => {
    const p = raw.floored(), coordinates = local(p); calls++; reads.push({ ...p });
    options.onRead?.({ p, coordinates, calls, cancel: () => { cancelled = true; }, replace: () => { current = false; } });
    if (options.unknown?.(p, coordinates)) return null;
    const override = options.override?.(p, coordinates), value = override === undefined ? geometry(p, coordinates) : override;
    if (value === null) return null;
    const name = typeof value === 'string' ? value : value.name, properties = typeof value === 'string' ? {} : value.properties || {};
    return Object.assign(Block.fromProperties(registry.blocksByName[name].id, properties, 0), { position: p });
  };
  bot.look = async () => { throw new Error('finder must not rotate'); };
  bot.setControlState = (name, value) => { controls.push({ name, value }); throw new Error('finder must not write controls'); };
  bot.clearControlStates = () => { throw new Error('finder must not clear controls'); };
  pathfinder(bot);
  const origin = { ...world(options.originU ?? -7, 0, options.originY ?? 2) }, initial = { position: { ...bot.entity.position }, velocity: { ...bot.entity.velocity }, profile: bot.pathfinder.movements, goal: bot.pathfinder.goal, blockAt: bot.blockAt };
  const deps = { getBot: () => bot, assertActive: () => { if (cancelled) throw Object.assign(new Error('paused'), { code: 'paused' }); if (!current) throw Object.assign(new Error('movement_preempted'), { code: 'movement_preempted' }); }, Vec3, Movements, GoalBlock: goals.GoalBlock };
  return { bot, client, metadata, local, world, origin, reads, controls, initial, deps, finder: createLoadedSurfaceSwimFinder(deps), calls: () => calls, cancel: () => { cancelled = true; } };
}
function unchanged(f) {
  assert.deepEqual({ ...f.bot.entity.position }, f.initial.position); assert.deepEqual({ ...f.bot.entity.velocity }, f.initial.velocity);
  assert.equal(f.bot.pathfinder.movements, f.initial.profile); assert.equal(f.bot.pathfinder.goal, f.initial.goal); assert.equal(f.bot.blockAt, f.initial.blockAt); assert.equal(f.controls.length, 0);
}
function find(f, options = {}) { return f.finder.find({ origin: f.origin, readLimit: 32768, scanTimeoutMs: 2000, resultLimit: 1, ...options }); }

for (const direction of [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]) test(`native dry probe discovers deep-UNKNOWN-bottom surface route32 ${direction.x},${direction.z} without moving`, () => {
  const f = fixture(32, { direction }), found = find(f);
  assert.equal(found.routes.length, 1, JSON.stringify(found.diagnostics));
  const r = found.routes[0]; assert.equal(r.route.kind, 'loaded_surface_swim'); assert.equal(r.route.depth, 'surface_only'); assert.equal(r.route.width, 32); assert.deepEqual(r.route.direction, direction);
  assert.equal(r.geometry.confirmedSurfaceGeometry, true); assert.equal(r.geometry.riverBottomObserved, false); assert.equal(r.actualTraversalConfirmed, false);
  assert.equal(r.approach.nativeStatus, 'success'); assert.ok(r.approach.plannedPath.length >= 5); assert.ok(r.approach.plannedLength <= 16);
  assert.equal(r.approach.actualConfirmed, false); assert.equal(found.actualMovementPerformed, false);
  assert.equal(found.diagnostics.reads, f.calls(), 'all actual client block reads, including native A*, share the bounded cache');
  assert.equal(routeIdentity(r.route), routeIdentity({ ...r.route, from: r.route.to, to: r.route.from })); unchanged(f);
});

test('width64 is supported while65 is explicit unsupported geometry, not a widened bound', () => {
  const f = fixture(64), found = find(f); assert.equal(found.routes.length, 1, JSON.stringify(found.diagnostics)); assert.equal(found.routes[0].route.width, 64); unchanged(f);
  const tooWide = fixture(65), rejected = find(tooWide, { horizontalRadius: 8, verticalRadius: 1 });
  assert.equal(rejected.routes.length, 0); assert.ok(rejected.diagnostics.rejections.surface_swim_discovery_width_unsupported); unchanged(tooWide);
  assert.throws(() => f.finder.find({ origin: f.origin, maximumWidth: 65 }), error => error.code === 'surface_swim_discovery_invalid_limit');
});

test('narrow center bank accepts loaded safe source-water side floors without fabricating a wide dry shore', () => {
  const f = fixture(32, { narrow: true }), found = find(f);
  assert.equal(found.routes.length, 1, JSON.stringify(found.diagnostics)); const r = found.routes[0];
  assert.deepEqual(r.route.from, { ...f.world(-1) });
  for (const side of [-1, 1]) assert.equal(f.bot.blockAt(f.world(-1, side, 1)).name, 'water');
  assert.equal(r.approach.actualConfirmed, false); assert.equal(r.geometry.actualTraversalConfirmed, false); unchanged(f);
});

test('ordinary thick sand remains a legal native dry approach, while an unstable deep sand center bank is rejected', () => {
  const good = fixture(12), found = find(good); assert.equal(found.routes.length, 1, JSON.stringify(found.diagnostics));
  assert.ok(found.routes[0].approach.plannedPath.some(p => good.local(p).u <= -2)); unchanged(good);
  const bad = fixture(12, { override: (p, l) => l.u === -1 && p.y >= -4 && p.y <= 1 ? 'sand' : undefined });
  const rejected = find(bad, { horizontalRadius: 8, verticalRadius: 1 }); assert.equal(rejected.routes.length, 0); assert.ok(rejected.diagnostics.rejections.surface_swim_discovery_near_bank_unsafe); unchanged(bad);
});

test('unknown source side, flow, lava, missing air, unknown far bank or dangerous bank sides produce no candidate for that lane', () => {
  const cases = [
    { unknown: (p, l) => l.u === 4 && l.v === 0 && p.y === 1 },
    { override: (p, l) => l.u === 4 && l.v === 0 && p.y === 1 ? { name: 'water', properties: { level: 1 } } : undefined },
    { override: (p, l) => l.u === 4 && l.v === 0 && p.y === 1 ? 'lava' : undefined },
    { unknown: (p, l) => l.u === 5 && l.v === 1 && p.y === 4 },
    { unknown: (p, l) => l.u === 12 && l.v === 0 && p.y === 1 },
    { narrow: true, override: (p, l) => l.u === -1 && l.v === 1 && p.y === 1 ? 'lava' : undefined },
  ];
  for (const options of cases) {
    const f = fixture(12, options), expected = { schema: 1, kind: 'loaded_surface_swim', depth: 'surface_only', from: { ...f.world(-1) }, to: { ...f.world(12) }, waterStart: { x: f.world(0).x, z: f.world(0).z }, direction: { x: 1, z: 0 }, surfaceY: 2, width: 12 };
    const found = find(f, { horizontalRadius: 8, verticalRadius: 1 }); assert.ok(found.routes.every(r => r.id !== routeIdentity(expected)), JSON.stringify(found.diagnostics)); unchanged(f);
  }
});

test('geometrically valid water cannot pass an unreachable dry-bank approach', () => {
  const f = fixture(12, { override: (p, l) => l.u === -3 && p.y >= 2 && p.y <= 5 ? 'stone' : undefined }), found = find(f, { horizontalRadius: 8, verticalRadius: 1 });
  assert.equal(found.routes.length, 0); assert.ok(found.diagnostics.rejections.surface_swim_discovery_approach_unreachable || found.diagnostics.rejections.surface_swim_discovery_path_unsafe); unchanged(f);
});

test('read/probe limits and duplicate route ids are explicit, without fake exhaustion or visits', () => {
  const f = fixture(32), exhausted = find(f, { readLimit: 1 }); assert.equal(exhausted.routes.length, 0); assert.equal(exhausted.diagnostics.stopReason, 'surface_swim_discovery_read_budget'); assert.equal(exhausted.diagnostics.reads, 1); assert.equal(f.calls(), 1); unchanged(f);
  const available = fixture(32), first = find(available); assert.equal(first.routes.length, 1);
  const repeated = find(available, { seenRouteIds: [first.routes[0].id], readLimit: 512 }); assert.ok(repeated.routes.every(r => r.id !== first.routes[0].id)); unchanged(available);
});

test('native own-entity metadata prevents another animal from supplying or suppressing swimmer oxygen', () => {
  const f = fixture(12); const rabbit = new Entity(2); rabbit.name = 'rabbit'; f.bot.entities[2] = rabbit;
  f.metadata(2, 135); assert.equal(f.bot.oxygenLevel, 9); assert.equal(readHouseBotOxygen(f.bot).oxygenLevel, 20);
  assert.equal(find(f).routes.length, 1);
  f.metadata(1, 255); f.metadata(2, 300); assert.equal(f.bot.oxygenLevel, 20); assert.equal(readHouseBotOxygen(f.bot).oxygenLevel, 17);
  assert.throws(() => find(f), error => error.code === 'surface_swim_discovery_oxygen_low'); unchanged(f);
  const unknown = fixture(12); delete unknown.bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')]; unknown.bot.oxygenLevel = 20;
  const unknownPlan = find(unknown); assert.equal(unknownPlan.routes.length, 1); assert.equal(readHouseBotOxygen(unknown.bot).oxygenLevel, null, 'unknown self air is never filled from global animal oxygen'); assert.equal(unknownPlan.originOxygen.oxygenLevel, null); assert.equal(unknownPlan.originOxygen.source, 'own_entity_metadata_unknown'); assert.equal(unknownPlan.actualMovementPerformed, false); unchanged(unknown);
});

test('cancellation, owner replacement and non-actual origin never return a plan after invalidation', () => {
  const paused = fixture(12, { onRead: ({ calls, cancel }) => { if (calls === 10) cancel(); } });
  assert.throws(() => find(paused), error => error.code === 'paused'); unchanged(paused);
  const replaced = fixture(12, { onRead: ({ calls, replace }) => { if (calls === 10) replace(); } });
  assert.throws(() => find(replaced), error => error.code === 'movement_preempted'); unchanged(replaced);
  const f = fixture(12); assert.throws(() => f.finder.find({ origin: { ...f.origin, x: f.origin.x + 1 } }), error => error.code === 'surface_swim_discovery_origin_not_actual');
  assert.throws(() => f.finder.find({ origin: { ...f.origin, y: 2.5 } }), error => error.code === 'surface_swim_discovery_origin_unknown'); unchanged(f);
});


test('native cardinal approach may descend one real foot level using installed floor-count semantics', () => {
  const f = fixture(12, { originU: -4, originY: 3, override: (p, l) => l.u <= -2 && p.y === 2 ? 'sand' : undefined });
  const found = find(f, { verticalRadius: 2 }); assert.equal(found.routes.length, 1, JSON.stringify(found.diagnostics));
  assert.ok(found.routes[0].approach.plannedPath.some((p, n, path) => n && p.y === path[n - 1].y - 1));
  assert.equal(found.routes[0].approach.profile.maxDropDown, 2); unchanged(f);
});

test('native probing has a separate finite attempt budget and an expired loaded scan is explicit', t => {
  const blocked = fixture(12, { override: (p, l) => l.u === -3 && p.y >= 2 && p.y <= 5 ? 'stone' : undefined });
  const outcome = find(blocked, { probeLimit: 1, resultLimit: 4, horizontalRadius: 8, verticalRadius: 1 });
  assert.equal(outcome.routes.length, 0); assert.equal(outcome.diagnostics.probes, 1); assert.equal(outcome.diagnostics.stopReason, 'surface_swim_discovery_probe_budget'); unchanged(blocked);
  t.mock.timers.enable({ apis: ['Date'], now: 1791980000000 });
  const expired = fixture(12, { onRead: ({ calls }) => { if (calls === 1) t.mock.timers.tick(2); } });
  const timed = find(expired, { scanTimeoutMs: 1 });
  assert.equal(timed.routes.length, 0); assert.equal(timed.diagnostics.stopReason, 'surface_swim_discovery_deadline'); unchanged(expired);
  t.mock.timers.reset();
});

test('a winding original dry path longer than16m cannot be shortened by the water-route planner', () => {
  const f = fixture(12, { originU: -13, override: (p, l) => l.u >= -8 && l.u <= -5 && Math.abs(l.v) <= 2 && p.y >= 2 && p.y <= 5 ? 'stone' : undefined });
  const found = find(f, { resultLimit: 8 });
  assert.ok(found.diagnostics.rejections.surface_swim_discovery_approach_over16, JSON.stringify(found.diagnostics));
  assert.ok(found.routes.every(r => r.approach.plannedLength <= 16)); unchanged(f);
});
