'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { inspectStep } = require('../core/mining');
const { NEVER_BREAK } = require('../core/nether');
const { rankContinuations } = require('../core/quartzExcavationContinuation');
const geometry = require('../core/quartzExcavationGeometry');
const { excavationDirections, oreSafetyFailure } = require('../core/quartzExcavationTarget');
const { projectedQuartzVisible } = require('../core/quartzVisibility');

const { key } = geometry;
const banned = new Set(NEVER_BREAK);

function block(name, position) {
  const empty = name === 'air';
  return {
    name, position: position.floored(), boundingBox: empty ? 'empty' : 'block',
    shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], diggable: true,
    stateId: empty ? 0 : name === 'basalt' ? 1 : 2,
  };
}

function targetFixture() {
  // Translate the relevant candidate 13 layout to the first mineable tunnel
  // front. The old route approaches from the south. Its basalt floor still
  // blocks the ray after descending east, but two north/west steps expose ore.
  const from = new Vec3(0, 0, 0);
  const target = new Vec3(-1, -1, 0);
  const shore = new Vec3(0, 0, 2);
  const portal = new Vec3(0, 0, 8);
  const route = [shore, new Vec3(0, 0, 1), from];
  const cleared = new Set(route.flatMap((position) => [0, 1].map((y) => key(position.offset(0, y, 0)))));
  const floors = new Set(route.map((position) => key(position.offset(0, -1, 0))));
  const readBlock = (position) => block(key(position) === key(target) ? 'nether_quartz_ore'
    : cleared.has(key(position)) ? 'air' : 'basalt', position);
  const ledger = {
    surfaceY: 6, route, routeIndex: route.length - 1, routeFeet: new Set(route.map(key)), protectedFloors: floors,
    open: cleared, digCells: new Set(), confirmedDigCells: new Set(), confirmedDigCredit: 0,
    used: { down: 0, flat: 2, feet: 2, digs: 0, nativeDigAttempts: 0, outboundEdges: 2,
      returnEdges: 0, knownEdges: 0, totalEdges: 2, diamondRock: 0 },
  };
  const query = ({ readBlock: read, ledger: state, from: position, direction, descend }) => geometry.inspectExcavationGeometry({
    read, ledger: state, from: position, dir: direction, descend, Vec3, inspectStep, banned,
    bounds: (cell) => cell.distanceTo(portal) <= 96,
    protectedCell: (state, cell) => state.protectedFloors.has(key(cell)),
  });
  const candidates = excavationDirections(from, target, { used: ledger.used, visited: ledger.routeFeet });
  return {
    from, target, shore, portal, readBlock, ledger, candidates, now: () => 0,
    geometry: { ...geometry, Vec3, query, source: { sha256: 'target_visibility_fixture' }, oreSafety: oreSafetyFailure,
      futureRockAllowed: (b) => geometry.ROCK.has(b?.name) && !banned.has(b?.name), targetVisible: projectedQuartzVisible },
  };
}

test('ranks two legal edges to visible selected quartz above the closer-looking east descent', () => {
  const input = targetFixture();
  const legacy = rankContinuations({ ...input, target: undefined });
  assert.equal(legacy.preferred.direction, 0, 'legacy nearby-ore classification ties and takes east first');
  assert.equal(legacy.preferred.descend, true);

  const result = rankContinuations(input);
  assert.equal(result.orderPolicy, 'bounded_target_visibility_rank');
  assert.equal(result.preferred.direction, 3, 'a north edge approaches the actual selected ore');
  assert.equal(result.preferred.descend, true);
  assert.deepEqual(result.preferred.targetWitness, { target: '-1,-1,0', stance: '-1,-1,-1', steps: 2, secondAttemptKey: '2:flat' });
  const east = result.rows.find(({ attemptKey }) => attemptKey === '0:down');
  assert.equal(east.first.targetVisible, false);
  assert.equal(east.targetWitness, undefined);
  assert.equal(input.ledger.route.length, 3);
  assert.equal(input.ledger.used.feet, 2);
  assert.equal(input.ledger.confirmedDigCredit, 0);
  assert.equal(result.actualCreditDelta, 0);
});

test('never uses target quartz as ordinary tunnel rock or harvestable route support', () => {
  const input = targetFixture();
  const visibleFrom = [];
  input.geometry.targetVisible = (_readBlock, stance) => { visibleFrom.push(key(stance)); return true; };
  const result = rankContinuations({ ...input, candidates: input.candidates.filter(({ direction }) => direction === 2) });
  const byMode = Object.fromEntries(result.rows.map((row) => [row.attemptKey, row]));
  assert.equal(byMode['2:down'].first.reason, 'forbidden_obstacle');
  assert.equal(byMode['2:flat'].first.ok, true, 'the ore can still support a walking stance');
  assert.equal(byMode['2:flat'].targetWitness, undefined, 'harvesting that protected support is refused');
  assert.deepEqual(visibleFrom, [], 'the ore guard rejects the route support before testing visibility');
});

test('does not project a second descent when already at the selected ore height', () => {
  const input = targetFixture();
  const result = rankContinuations({ ...input, candidates: input.candidates.filter(({ attemptKey }) => attemptKey === '3:down') });
  const second = result.rows[0].second;
  const westDown = second.find(({ attemptKey }) => attemptKey === '2:down');
  const westFlat = second.find(({ attemptKey }) => attemptKey === '2:flat');
  assert.equal(westDown.ok, true, 'unconditional geometry alone would admit the descent');
  assert.equal(westDown.eligibleForTargetWitness, false, 'a live same-height goal can only propose flat');
  assert.equal(westDown.targetVisible, undefined);
  assert.equal(westFlat.eligibleForTargetWitness, true);
  assert.equal(westFlat.targetVisible, true);
});

test('an unknown selected ore sightline without a complete proof preserves legacy ranking', () => {
  const input = targetFixture();
  const legacy = rankContinuations({ ...input, target: undefined });
  input.geometry.targetVisible = (readBlock, stance, ore) => key(stance) === '-1,-1,-1' ? null
    : projectedQuartzVisible(readBlock, stance, ore);
  const result = rankContinuations(input);
  assert.equal(result.rankingUncertain, true);
  assert.equal(result.orderPolicy, legacy.orderPolicy);
  assert.deepEqual(result.preferred, legacy.preferred);
  assert.ok(result.rows.every((row) => !row.permanentRejection));
});

test('an unrelated unknown sightline cannot discard a fully observed target approach', () => {
  const input = targetFixture();
  input.geometry.targetVisible = (readBlock, stance, ore) => key(stance) === '1,-1,0' ? null
    : projectedQuartzVisible(readBlock, stance, ore);
  const result = rankContinuations(input);
  assert.equal(result.rankingUncertain, true);
  assert.equal(result.orderPolicy, 'bounded_target_visibility_rank');
  assert.equal(result.preferred.direction, 3);
  assert.equal(result.preferred.targetWitness.stance, '-1,-1,-1');
});

test('planned target visibility distinguishes occlusion and unloaded ray cells', () => {
  const stance = new Vec3(0, 0, 0);
  const ore = new Vec3(3, 0, 0);
  const view = (wall) => (position) => {
    if (key(position) === key(ore)) return block('nether_quartz_ore', position);
    if (position.x === 1 && wall === null) return null;
    return block(position.x === 1 && wall ? wall : 'air', position);
  };
  assert.equal(projectedQuartzVisible(view(), stance, ore), true);
  assert.equal(projectedQuartzVisible(view('basalt'), stance, ore), false);
  assert.equal(projectedQuartzVisible(view(null), stance, ore), null);
});
