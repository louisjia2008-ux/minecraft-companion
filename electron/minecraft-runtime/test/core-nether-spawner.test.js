'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { createNetherExpeditionGoal } = require('../core/goals/netherExpedition');

function fixture({ reported = true, guardedRoute = true } = {}) {
  const origin = new Vec3(0, 74, 0);
  const spawner = new Vec3(120, 74, 0);
  const start = new Vec3(10, 74, 0);
  const neighbours = () => [];
  const movements = { getNeighbors: neighbours, allowParkour: true, allow1by1towers: true,
    exclusionAreasStep: [], blocksCantBreak: new Set(), scafoldingBlocks: [] };
  let chosen;
  const records = [], walks = [];
  const cube = [[0, 0, 0, 1, 1, 1]];
  const air = { name: 'air', boundingBox: 'empty', shapes: [] };
  const inventory = { iron_sword: 1, netherrack: 64 };
  const bot = Object.assign(new EventEmitter(), {
    game: { dimension: 'the_nether' },
    entity: { position: start.clone(), onGround: true, isInLava: false },
    inventory: { slots: [], items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
    entities: {},
    registry: { itemsByName: { netherrack: { id: 1 } }, blocksByName: { nether_bricks: { id: 1 }, spawner: { id: 2 } } },
    blockAt(p) {
      if (p.equals(spawner)) return { name: 'spawner', boundingBox: 'block', shapes: cube };
      if (p.y === 73) return { name: 'nether_bricks', boundingBox: 'block', shapes: cube };
      return air;
    },
    findBlocks({ matching, point }) {
      if (matching === 2) return reported ? [spawner] : [];
      return [point.offset(1, -1, 0), point.offset(14, -1, 0)];
    },
    pathfinder: {
      movements,
      *getPathFromTo(profile, here, goal) {
        chosen = { here, goal, profile };
        if (!guardedRoute) { yield { result: { status: 'noPath', path: [] } }; return; }
        assert.equal(goal.isEnd(spawner.offset(-15, 0, 0)), false);
        assert.equal(goal.isEnd(spawner.offset(-14, 0, 0)), true);
        const neighbours = profile.getNeighbors(here);
        assert.ok(neighbours.every((move) => !move.toBreak.length && !move.toPlace.length));
        yield { result: { status: 'success', path: Array.from({ length: 95 }, (_, i) => here.offset(i + 1, 0, 0)) } };
      },
    },
  });
  const actions = {
    async goTo(_bot, _ctx, target, { arrived }) {
      walks.push({ move: 'goTo', target: target.x, guarded: movements.getNeighbors !== neighbours,
        towers: movements.allow1by1towers });
      bot.entity.position = new Vec3(target.x, target.y, target.z);
      bot.emit('move');
      assert.equal(arrived(), true);
      return { ok: true };
    },
    async goNear() {
      walks.push({ move: 'patrol' });
      return { ok: true };
    },
  };
  const goal = createNetherExpeditionGoal({ bot, blazeRods: 7, witherSkulls: 0, trades: 0, actions });
  goal.memory.fortress = origin;
  goal.memory.netherPortal = new Vec3(-40, 74, 0);
  const ctx = { record: (type, info) => records.push({ type, ...info }),
    perceive: () => ({ inventory, health: 20, food: 20, hostiles: [] }) };
  return { goal, records, walks, ctx, start, chosen: () => chosen, movements, neighbours };
}

test('on a fortress deck the spawner search uses live position and follows reversible bounded legs', async () => {
  const { goal, records, walks, ctx, start, chosen, movements, neighbours } = fixture();
  try {
    await goal.run(ctx);
    await goal.run(ctx);
    assert.equal(records.find((e) => e.type === 'spawner').from, '10,74,0');
    assert.equal(records.find((e) => e.type === 'spawner').position, '120,74,0');
    assert.equal(chosen().here.equals(start), true);
    assert.deepEqual(walks, [
      { move: 'goTo', target: 18, guarded: true, towers: false },
      { move: 'goTo', target: 26, guarded: true, towers: false },
    ]);
    assert.equal(goal.memory.crumbs.length, 2);
    assert.equal(movements.getNeighbors, neighbours);
  } finally { goal.dispose(); }
});

test('a missing or disconnected spawner falls back to ordinary patrol', async () => {
  for (const input of [{ reported: false }, { guardedRoute: false }]) {
    const { goal, records, walks, ctx } = fixture(input);
    try {
      await goal.run(ctx);
      assert.ok(records.some((e) => e.type === 'patrol'));
      assert.ok(!records.some((e) => e.type === 'structure_detour'));
      assert.deepEqual(walks, [{ move: 'patrol' }]);
      assert.equal(goal.memory.spawner, null);
    } finally { goal.dispose(); }
  }
});
