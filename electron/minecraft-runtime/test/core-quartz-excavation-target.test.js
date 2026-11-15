'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { inspectStep } = require('../core/mining');
const { excavationDirections, chooseExcavationTarget } = require('../core/quartzExcavationTarget');

const origin = new Vec3(0, 0, 0), ore = new Vec3(8, -2, 0);
const modeKeys = () => [0, 1, 2, 3].flatMap((direction) => [`${direction}:down`, `${direction}:flat`]);

test('a lower ore offers four cardinal descents before four same-height entrance candidates', () => {
  const options = excavationDirections(origin, ore);
  assert.equal(options.length, 8);
  assert.equal(new Set(options.map((s) => s.attemptKey)).size, 8);
  assert.ok(options.slice(0, 4).every((s) => s.descend));
  assert.ok(options.slice(4).every((s) => !s.descend));
  for (const s of options) {
    assert.equal(s.next.y, s.descend ? -1 : 0);
    assert.equal(Math.abs(s.next.x) + Math.abs(s.next.z), 1);
    assert.equal(s.attemptKey, `${s.direction}:${s.descend ? 'down' : 'flat'}`);
  }
});

test('refusing a descent leaves the same heading flat candidate available', () => {
  const rejected = new Set([0, 1, 2, 3].map((d) => `${d}:down`));
  const options = excavationDirections(origin, ore, { rejected });
  assert.equal(options.length, 4);
  assert.equal(options[0].attemptKey, '0:flat');
  assert.ok(options.every((s) => !s.descend));
  rejected.add('0:flat');
  assert.equal(excavationDirections(origin, ore, { rejected }).some((s) => s.direction === 0), false);
});

test('flat refusal does not reject a still-untried descent, while legacy numeric refusal rejects both modes', () => {
  const options = excavationDirections(origin, ore, { rejected: new Set(['0:flat', 1]) });
  assert.equal(options.some((s) => s.attemptKey === '0:down'), true);
  assert.equal(options.some((s) => s.attemptKey === '0:flat'), false);
  assert.equal(options.some((s) => s.direction === 1), false);
});

test('an unchanged front exhausts at most eight unique refused modes and never resets them', () => {
  const rejected = new Set(), attempted = [];
  for (let n = 0; n < 16; n++) {
    const step = excavationDirections(origin, ore, { rejected })[0];
    if (!step) break;
    attempted.push(step.attemptKey);
    rejected.add(step.attemptKey);
  }
  assert.equal(attempted.length, 8);
  assert.equal(new Set(attempted).size, 8);
  assert.deepEqual([...rejected].sort(), modeKeys().sort());
  for (let n = 0; n < 100; n++) assert.deepEqual(excavationDirections(origin, ore, { rejected }), []);
});

for (const [name, used, down, flat] of [
  ['down exhausted', { down: 16 }, 0, 4],
  ['flat exhausted', { flat: 48 }, 4, 0],
  ['both categories exhausted', { down: 16, flat: 48 }, 0, 0],
  ['all feet spent', { feet: 64 }, 0, 0],
]) test(`mode candidates retain cumulative caps: ${name}`, () => {
  const before = JSON.stringify(used), options = excavationDirections(origin, ore, { used });
  assert.equal(options.filter((s) => s.descend).length, down);
  assert.equal(options.filter((s) => !s.descend).length, flat);
  assert.equal(JSON.stringify(used), before, 'planning never refunds or spends actual executor budgets');
});

test('old actual feet are excluded independently for flat and down, including attempted backtracking loops', () => {
  const visited = new Set(['1,-1,0', '-1,0,0']);
  const options = excavationDirections(origin, ore, { visited });
  assert.equal(options.some((s) => s.attemptKey === '0:down'), false);
  assert.equal(options.some((s) => s.attemptKey === '0:flat'), true);
  assert.equal(options.some((s) => s.attemptKey === '2:flat'), false);
  assert.equal(options.some((s) => s.attemptKey === '2:down'), true);
  for (const s of excavationDirections(origin, ore)) visited.add(`${s.next.x},${s.next.y},${s.next.z}`);
  assert.deepEqual(excavationDirections(origin, ore, { visited }), []);
});

test('coordinate distance telemetry is explicitly planned and does not fabricate motion or progress', () => {
  const from = origin.clone(), target = ore.clone(), used = { down: 2, flat: 3, feet: 5, digs: 9 };
  const before = JSON.stringify({ from, target, used });
  const options = excavationDirections(from, target, { used });
  for (const s of options) {
    assert.equal(s.plannedDistanceBefore, 10);
    assert.equal(s.plannedDistanceAfter, Math.abs(s.next.x - target.x) + Math.abs(s.next.y - target.y) + Math.abs(s.next.z - target.z));
    assert.equal(Object.hasOwn(s, 'progress'), false);
    assert.equal(Object.hasOwn(s, 'ok'), false);
  }
  assert.equal(options.find((s) => s.attemptKey === '2:flat').plannedDistanceAfter, 11, 'bounded entrance search may initially move farther');
  assert.equal(JSON.stringify({ from, target, used }), before);
});

test('same-height and one-higher ore candidates never request a vertical shaft or upward excavation', () => {
  for (const target of [new Vec3(8, 0, 0), new Vec3(8, 1, 0)]) {
    const options = excavationDirections(origin, target);
    assert.equal(options.length, 4);
    assert.ok(options.every((s) => !s.descend && s.next.y === 0));
  }
});

test('MODELED real inspectStep can reject all immediate descents while a flat approach reaches a valid rock entrance', () => {
  // A full natural floor has a void beneath immediate neighbours. Two cells
  // east, an intact rock bank supports the first safe stair. This is topology
  // evidence only: no bot pose assignment, Java world or movement is simulated.
  const read = (x, y, z) => {
    const p = new Vec3(x, y, z), name = y >= 0 ? 'air' : y === -1 || x >= 2 ? 'basalt' : 'air';
    const b = Block.fromStateId(registry.blocksByName[name].defaultState); b.position = p; return b;
  };
  for (let d = 0; d < 4; d++) assert.equal(inspectStep(read, origin, d, { descend: true, surfaceY: 0 }).reason, 'cave');
  assert.equal(inspectStep(read, origin, 0, { descend: false, surfaceY: 0 }).ok, true);
  assert.equal(inspectStep(read, new Vec3(1, 0, 0), 0, { descend: true, surfaceY: 0 }).ok, true);
  const rejected = new Set([0, 1, 2, 3].map((d) => `${d}:down`));
  const offered = excavationDirections(origin, new Vec3(4, -2, 0), { rejected })[0];
  assert.equal(offered.attemptKey, '0:flat');
  assert.equal(offered.descend, false);
});

function safeTargetFixture() {
  const cells = new Map(), unknown = new Set(), shore = new Vec3(0, 0, 0), portal = new Vec3(-20, 0, 0);
  const key = p => `${p.x},${p.y},${p.z}`;
  cells.set(key(portal), 'nether_portal');
  const calls = { find: 0 };
  const bot = { registry, entity: { position: shore.offset(.5, 0, .5), onGround: true },
    blockAt(p) {
      p = p.floored(); if (unknown.has(key(p))) return null;
      const b = Block.fromStateId(registry.blocksByName[cells.get(key(p)) || (p.y >= 0 ? 'air' : 'basalt')].defaultState);
      b.position = p; return b;
    },
    findBlocks() { calls.find++; return [...cells].filter(([, n]) => n === 'nether_quartz_ore').map(([p]) => new Vec3(...p.split(',').map(Number))); },
  };
  const oreAt = (x, y, z) => { const p = new Vec3(x, y, z); cells.set(key(p), 'nether_quartz_ore'); return p; };
  return { bot, shore, portal, cells, unknown, calls, oreAt, key };
}

test('a loaded natural cave beside the nearest ore is filtered before a farther buried candidate is proposed', () => {
  const f = safeTargetFixture(), near = f.oreAt(4, -2, 0), buried = f.oreAt(8, -3, 0);
  f.cells.set(f.key(near.offset(0, 0, 1)), 'air');
  const selected = chooseExcavationTarget(f);
  assert.equal(selected.ok, true); assert.deepEqual(selected.block.position, buried);
  assert.equal(selected.stableRejectedCount, 1);
  assert.equal(selected.stableRejections[0].reason, 'unconfirmed_cave_at_ore');
  assert.equal(selected.safetyClass, 'six_solid_neighbors');
});

test('cold selection uses independently fresh actual shore knowledge without creating an actual route or progress', () => {
  const f = safeTargetFixture(); f.oreAt(8, -2, 0);
  const before = JSON.stringify({ position: f.bot.entity.position, cells: [...f.cells] });
  const selected = chooseExcavationTarget(f);
  assert.equal(selected.ok, true); assert.equal(selected.queryOnly, true); assert.equal(selected.progress, false);
  assert.equal(selected.knowledgeSource, 'fresh_actual_shore_only');
  assert.equal(Object.hasOwn(selected, 'ledger'), false); assert.equal(Object.hasOwn(selected, 'route'), false);
  assert.equal(JSON.stringify({ position: f.bot.entity.position, cells: [...f.cells] }), before);
});

for (const invalid of ['air floor', 'occupied head', 'unknown floor', 'owned floor']) {
  test(`cold selection cannot invent shore knowledge from an invalid actual stance: ${invalid}`, () => {
    const f = safeTargetFixture(); f.oreAt(8, -2, 0); const ownedSupports = new Set();
    if (invalid === 'air floor') f.cells.set('0,-1,0', 'air');
    if (invalid === 'occupied head') f.cells.set('0,1,0', 'basalt');
    if (invalid === 'unknown floor') f.unknown.add('0,-1,0');
    if (invalid === 'owned floor') ownedSupports.add('0,-1,0');
    const selected = chooseExcavationTarget({ ...f, ownedSupports });
    assert.equal(selected.ok, false); assert.equal(selected.uncertain, true); assert.equal(selected.progress, false);
    assert.equal(f.calls.find, 0, 'do not query ore before the actual cold shore is established');
  });
}

test('unloaded ore margins remain UNKNOWN and can be reconsidered after they actually load', () => {
  const f = safeTargetFixture(), ore = f.oreAt(8, -2, 0), rejected = new Set();
  f.unknown.add('8,-2,1');
  const unknown = chooseExcavationTarget({ ...f, rejected });
  assert.equal(unknown.ok, false); assert.equal(unknown.reason, 'quartz_target_unknown');
  assert.equal(unknown.uncertain, true); assert.equal(unknown.unknownCandidates, 1); assert.equal(rejected.size, 0);
  f.unknown.clear();
  const loaded = chooseExcavationTarget({ ...f, rejected });
  assert.equal(loaded.ok, true); assert.deepEqual(loaded.block.position, ore); assert.equal(rejected.size, 0);
});

test('a changed ore read is uncertain rather than a permanent cave rejection or NoPath', () => {
  const f = safeTargetFixture(), ore = f.oreAt(8, -2, 0), original = f.bot.blockAt; let reads = 0;
  f.bot.blockAt = p => {
    if (p.floored().equals(ore) && ++reads > 1) { const b = Block.fromStateId(registry.blocksByName.air.defaultState); b.position = p.floored(); return b; }
    return original(p);
  };
  const selected = chooseExcavationTarget(f);
  assert.equal(selected.ok, false); assert.equal(selected.reason, 'quartz_target_unknown');
  assert.equal(selected.uncertain, true); assert.equal(selected.stableRejectedCount, 0);
});

test('an unknown nearby candidate does not hide a separately confirmed buried candidate', () => {
  const f = safeTargetFixture(); f.oreAt(4, -2, 0); const buried = f.oreAt(8, -3, 0);
  f.unknown.add('4,-2,1');
  const selected = chooseExcavationTarget(f);
  assert.equal(selected.ok, true); assert.deepEqual(selected.block.position, buried); assert.equal(selected.unknownCandidates, 1);
});

test('all stable cave refusals have a finite explicit classification without mutating rejection history', () => {
  const f = safeTargetFixture(), ore = f.oreAt(8, -2, 0), rejected = new Set();
  f.cells.set(f.key(ore.offset(0, 0, 1)), 'air');
  for (let n = 0; n < 4; n++) {
    const selected = chooseExcavationTarget({ ...f, rejected });
    assert.equal(selected.ok, false); assert.equal(selected.reason, 'no_safe_excavation_target');
    assert.equal(selected.uncertain, false); assert.equal(selected.checkedCandidates, 1);
    assert.equal(selected.stableRejectedCount, 1); assert.equal(selected.progress, false);
  }
  assert.equal(rejected.size, 0);
});

test('actual confirmed route openings remain eligible while completely buried ore has first preference', () => {
  const f = safeTargetFixture(), near = f.oreAt(4, -2, 0), buried = f.oreAt(8, -2, 0);
  const route = [f.shore, new Vec3(1, -1, 0), new Vec3(2, -2, 0), new Vec3(3, -2, 0)];
  for (const p of route) for (const y of [0, 1]) f.cells.set(f.key(p.offset(0, y, 0)), 'air');
  f.bot.entity.position = new Vec3(3.5, -2, .5);
  const ledger = { surfaceY: 0, route, open: new Set(), protectedFloors: new Set(route.map(p => f.key(p.offset(0, -1, 0)))), used: { feet: 3, down: 2, flat: 1 } };
  const selected = chooseExcavationTarget({ ...f, ledger });
  assert.equal(selected.ok, true); assert.deepEqual(selected.block.position, buried); assert.equal(selected.options, 2);
  assert.equal(selected.knowledgeSource, 'actual_quarry_ledger');
  f.cells.delete(f.key(buried));
  const opening = chooseExcavationTarget({ ...f, ledger });
  assert.equal(opening.ok, true); assert.deepEqual(opening.block.position, near); assert.equal(opening.safetyClass, 'original_guard_pass');
});

test('one read-only target scan is capped at64 candidates even when a caller returns a larger list', () => {
  const f = safeTargetFixture();
  for (let x = 1; x <= 8; x++) for (let z = 0; z < 10; z++) { f.oreAt(x, -2, z); f.cells.set(`${x},-1,${z}`, 'air'); }
  const selected = chooseExcavationTarget(f);
  assert.equal(selected.ok, false); assert.equal(selected.checkedCandidates, 64); assert.equal(selected.stableRejectedCount, 64);
});
