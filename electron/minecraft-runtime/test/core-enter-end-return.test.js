'use strict';
// The observed failure was a lit room 69/90 blocks below a respawned bot.
// These are planner/control models; no server, grants or teleports occur.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { createEnterEndGoal } = require('../core/goals/enterEnd');
const stronghold = require('../core/stronghold');
const end = require('../core/end');
const defaultActions = require('../core/actions');
const { sleep } = require('../core/confirm');

function fixture(t, { depth = 69, pickaxe = true, lit = true, realEntry = false } = {}) {
  const center = new Vec3(-1243, -28, 1196);
  const frames = [[-1, -2], [0, -2], [1, -2], [-1, 2], [0, 2], [1, 2],
    [-2, -1], [-2, 0], [-2, 1], [2, -1], [2, 0], [2, 1]].map(([x, z]) => ({ position: center.offset(x, 0, z) }));
  const ring = { center, frames, complete: true };
  const bag = pickaxe ? { diamond_pickaxe: 1 } : {};
  const controls = {};
  const bot = { health: 20, food: 20, game: { dimension: 'overworld' },
    entity: { position: center.offset(3, depth, 0) },
    registry: { itemsByName: { diamond_pickaxe: { maxDurability: 1561 } }, blocksByName: {} },
    findBlock: () => null,
    inventory: { slots: [], items: () => Object.entries(bag).filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, maxDurability: name === 'diamond_pickaxe' ? 1561 : 0 })) },
    blockAt(p) {
      const frame = frames.find((f) => f.position.equals(p.floored()));
      return frame ? { name: 'end_portal_frame', position: p, getProperties: () => ({ eye: lit }) }
        : { name: p.y < center.y ? 'stone' : 'air', boundingBox: p.y < center.y ? 'block' : 'empty', position: p };
    },
    lookAt: async () => {}, setControlState: (key, value) => { controls[key] = value; },
  };
  const events = [];
  const calls = { enter: 0, down: 0, gather: 0, walk: [] };
  const actions = {
    digStairsDown: async () => { calls.down += 1; return 4; },
    goNear: async (_b, _c, p) => { calls.walk.push(p); return { ok: true }; },
  };
  const skills = { gatherOne: async () => { calls.gather += 1; return { ok: false, reason: 'modeled_no_tree' }; } };
  t.mock.method(stronghold, 'portalRing', () => ring);
  t.mock.method(stronghold, 'portalLit', () => lit);
  t.mock.method(stronghold, 'landNear', () => null);
  t.mock.method(end, 'wearArmor', async () => []);
  if (!realEntry) t.mock.method(stronghold, 'enterPortal', async () => {
    calls.enter += 1; return { ok: false, reason: 'modeled_no_transfer' };
  });
  const goal = createEnterEndGoal({ bot, actions, skills });
  const ac = new AbortController();
  const ctx = { signal: ac.signal, record: (type, data) => events.push({ type, ...data }),
    perceive: () => ({ inventory: { ...bag } }) };
  return { goal, bot, bag, ctx, ac, ring, actions, calls, events, controls };
}

for (const depth of [69, 90]) test(`a lit portal ${depth} blocks below still requires a real descent before entry`, async (t) => {
  const f = fixture(t, { depth });
  await f.goal.run(f.ctx);
  assert.equal(f.calls.down, 1);
  assert.equal(f.calls.enter, 0);
  assert.equal(f.events.some((e) => e.type === 'portal_enter'), false);
  assert.equal(f.goal.isDone(), false, 'a planned descent is not an observed dimension transfer');
});

test('an empty respawn bag prepares a pickaxe for the remembered lit room without needing new eyes', async (t) => {
  const f = fixture(t, { pickaxe: false });
  f.goal.memory.toolsReady = true; // preparation belonged to the previous life
  const result = await f.goal.run(f.ctx);
  assert.equal(result.reason, 'modeled_no_tree');
  assert.equal(f.calls.gather, 1);
  assert.equal(f.calls.down, 0);
  assert.equal(f.calls.enter, 0);
  assert.ok(f.events.some((e) => e.type === 'plan_step' && e.for === 'stone_pickaxe'));
});

test('tool readiness is rechecked when a previously sufficient pickaxe is lost', async (t) => {
  const f = fixture(t);
  await f.goal.run(f.ctx);
  assert.equal(f.goal.memory.toolsReady, true);
  f.goal.memory.toolSteps = 60; // even an old exhausted preparation budget belongs to that life
  delete f.bag.diamond_pickaxe; // deterministic model of the observed death loss
  await f.goal.run(f.ctx);
  assert.equal(f.calls.gather, 1);
  assert.equal(f.calls.down, 1, 'no second descent by hand after losing the kit');
  assert.equal(f.calls.enter, 0);
});

test('a blocked descent from high above a lit portal does not fall through to an entry attempt', async (t) => {
  const f = fixture(t);
  f.actions.digStairsDown = async () => { f.calls.down += 1; return 0; };
  const result = await f.goal.run(f.ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'portal_room_unreachable');
  assert.equal(f.calls.down, 1);
  assert.equal(f.calls.enter, 0);
});

test('a wet blocked descent approaches the existing dry-land start before attempting entry', async (t) => {
  const f = fixture(t);
  f.bot.entity.isInWater = true;
  f.actions.digStairsDown = async () => 0;
  const land = f.bot.entity.position.offset(12, 0, 0);
  t.mock.method(stronghold, 'landNear', () => land);
  await f.goal.run(f.ctx);
  assert.deepEqual(f.calls.walk, [land]);
  assert.equal(f.calls.enter, 0);
});

test('beside a lit portal an empty bag enters directly without new eyes or pickaxes', async (t) => {
  const f = fixture(t, { depth: 1, pickaxe: false });
  const result = await f.goal.run(f.ctx);
  assert.equal(result.reason, 'modeled_no_transfer');
  assert.equal(f.calls.enter, 1);
  assert.equal(f.calls.down, 0);
  assert.equal(f.calls.gather, 0);
  assert.equal(f.goal.isDone(), false);
});

test('unlit frames still require eyes when the bot is already beside the ring', async (t) => {
  const f = fixture(t, { depth: 1, pickaxe: false, lit: false });
  const result = await f.goal.run(f.ctx);
  assert.equal(result.reason, 'not_enough_eyes');
  assert.equal(f.calls.enter, 0);
});

test('cancelling the existing lit-portal entry still clears forward and jump controls', async (t) => {
  const f = fixture(t, { depth: 1, pickaxe: false, realEntry: true });
  t.mock.method(defaultActions, 'goTo', async () => ({ ok: true }));
  f.bot.setControlState = (key, value) => {
    f.controls[key] = value;
    if (key === 'jump' && value) f.ac.abort('modelled_cancel');
  };
  await assert.rejects(f.goal.run(f.ctx), { code: 'aborted' });
  assert.equal(f.controls.forward, false);
  assert.equal(f.controls.jump, false);
});

test('cancelling during descent propagates abort and does not start a later entry', async (t) => {
  const f = fixture(t);
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  f.actions.digStairsDown = async (_bot, ctx) => {
    f.controls.forward = true; started();
    try { await sleep(10000, ctx.signal); } finally { f.controls.forward = false; }
  };
  const result = f.goal.run(f.ctx);
  try {
    await Promise.race([running, result.then(() => assert.fail('descent must run before entering'))]);
    f.ac.abort('modelled_cancel');
    await assert.rejects(result, { code: 'aborted' });
    assert.equal(f.controls.forward, false);
    assert.equal(f.calls.enter, 0);
  } finally { f.ac.abort('cleanup'); await result.catch(() => {}); }
});
