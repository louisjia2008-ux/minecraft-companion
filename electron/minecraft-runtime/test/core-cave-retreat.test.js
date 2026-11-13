'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Vec3 } = require('vec3');
const { advanceCaveRetreat, evadeInCave, planRetreat, returnFromCave } = require('../core/caveRetreat');
const { createSurvivalBehaviors } = require('../core/behaviors/survival');

const key = (p) => `${p.x},${p.y},${p.z}`;
const stone = { name: 'stone', diggable: true, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
const air = { name: 'air', boundingBox: 'empty', shapes: [] };
const water = { name: 'water', boundingBox: 'empty', shapes: [] };

function fixture() {
  const origin = new Vec3(0, 0, 0);
  const cells = new Map([['0,0,0', air], ['0,1,0', air]]);
  const bot = {
    entity: { position: origin.offset(.5, 0, .5), onGround: true },
    game: { dimension: 'overworld' },
    blockAt: (p) => ({ ...(cells.get(key(p.floored())) || stone), position: p.floored() }),
    canDigBlock: () => true,
    pathfinder: { movements: { getNeighbors: () => [], canDig: true } },
    inventory: { items: () => [] },
  };
  return { bot, cells, origin };
}

test('a liquid touching a proposed cut rules out that heading', () => {
  const { bot, cells, origin } = fixture();
  const home = new Vec3(15, 8, 0);
  assert.equal(planRetreat(bot, origin, home).target.x, 1);
  cells.set('2,1,0', water);
  const plan = planRetreat(bot, origin, home);
  assert.ok(plan);
  assert.notEqual(plan.target.x, 1);
});

test('a projected staircase into a chamber loses to a narrower cut with solid side cover', () => {
  const { bot, cells, origin } = fixture();
  const home = new Vec3(15, 8, 0);
  assert.equal(planRetreat(bot, origin, home).target.x, 1);
  for (let x = 2; x <= 5; x += 1) for (let y = 1; y <= 6; y += 1) {
    for (let z = -2; z <= 2; z += 1) cells.set(`${x},${y},${z}`, air);
  }
  for (let y = 3; y <= 6; y += 1) cells.set(`1,${y},0`, air);
  const plan = planRetreat(bot, origin, home);
  assert.ok(plan);
  assert.notEqual(plan.target.x, 1);
});

test('an empty-handed bot clears one checked stair cell and then physically ascends', async () => {
  const { bot, cells, origin } = fixture();
  const logs = [];
  const ctx = { record: (...args) => logs.push(args) };
  const actions = {
    async digBlock(_bot, _ctx, block) {
      assert.ok(block.position.y >= origin.y + 1);
      cells.set(key(block.position), air);
      return { ok: true };
    },
    async goTo(_bot, _ctx, goal) {
      assert.equal(bot.pathfinder.movements.canDig, false);
      bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
      return { ok: true };
    },
  };
  const home = new Vec3(15, 8, 0);
  for (let n = 0; n < 3; n += 1) {
    const cut = await advanceCaveRetreat(bot, ctx, actions, home);
    assert.equal(cut.dug, true);
    assert.equal(bot.entity.position.y, 0);
    assert.equal(logs.length, n + 1);
  }
  const step = await advanceCaveRetreat(bot, ctx, actions, home);
  assert.equal(step.ok, true);
  assert.deepEqual(step.to, new Vec3(1, 1, 0));
  assert.equal(bot.pathfinder.movements.canDig, true);
});

test('critical underground escape starts without a nearby threat and excludes the house roof', () => {
  const { bot } = fixture();
  const state = { health: 2, food: 0, position: bot.entity.position, inventory: {}, hostiles: [] };
  const behaviors = (home) => createSurvivalBehaviors({ bot, home: () => home, actions: { underground: () => true } });
  assert.ok(behaviors(new Vec3(15, 8, 0)).find((b) => b.name === 'cave_retreat').want(state));
  assert.equal(behaviors(new Vec3(0, 0, 0)).find((b) => b.name === 'cave_retreat').want(state), 0);
});

test('emergency evasion takes one supported step toward cover and ignores a deeper direct drop', async () => {
  const { bot, cells } = fixture();
  for (let x = 1; x < 4; x += 1) {
    cells.set(`${x},0,0`, air);
    cells.set(`${x},1,0`, air);
  }
  for (let y = -5; y < 3; y += 1) cells.set(`0,${y},1`, air);
  const threat = { id: 3, name: 'zombie', position: new Vec3(-2, 0, .5) };
  const receipts = [];
  const result = await evadeInCave(bot, { record: (...args) => receipts.push(args) }, {
    async goTo(_bot, _ctx, goal) {
      assert.equal(bot.pathfinder.movements.maxDropDown, 2);
      assert.equal(bot.pathfinder.movements.canDig, false);
      bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
      return { ok: true };
    },
  }, threat, (_mob, position) => position.x < 2, () => threat);
  assert.deepEqual(result.to, new Vec3(1, 0, 0));
  assert.deepEqual(receipts.map(([type]) => type), ['cave_evasion_threat', 'cave_evasion_step']);
});

test('critical surface resupply evasion holds the ledge, with ordinary flee unchanged', async (t) => {
  const check = async ({ resupplying = true, flat = false, onGround = true, mob = 'zombie', expected }) => {
    const { bot, cells } = fixture();
    bot.entity.onGround = onGround;
    for (let x = 1; x <= 3; x += 1) {
      cells.set(`${x},0,0`, air);
      cells.set(`${x},1,0`, air);
    }
    // Behind the bot is a dry drop that would normally increase separation.
    for (const y of [-1, 0, 1]) cells.set(`-1,${y},0`, air);
    if (flat) for (const y of [0, 1]) cells.set(`0,${y},1`, air);
    const threat = { id: 3, name: mob, position: new Vec3(3.5, 0, .5), distance: 3 };
    const state = { health: 2, food: 0, position: bot.entity.position, inventory: {}, hostiles: [threat] };
    const records = [];
    const paths = [];
    const actions = {
      underground: () => false,
      async goTo(_bot, _ctx, goal) {
        assert.equal(bot.pathfinder.movements.canDig, false);
        paths.push(['guarded', goal.x, goal.y, goal.z]);
        bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
        return { ok: true };
      },
      async fleeFrom(_bot, _ctx, from) {
        paths.push(['generic', from.x, from.y, from.z]);
        return { ok: true };
      },
    };
    const escape = createSurvivalBehaviors({ bot, actions, resupplying: () => resupplying })
      .find((behavior) => behavior.name === 'escape');
    assert.equal(escape.want(state), 1);
    const result = await escape.run({ perceive: () => state, record: (...args) => records.push(args) });
    assert.deepEqual(paths, expected);
    const waitsForGround = !onGround && resupplying && mob !== 'creeper';
    assert.equal(result.ok, expected.length > 0 || waitsForGround);
    if (waitsForGround) assert.equal(result.reason, 'resupply_escape_wait_for_ground');
    if (!result.ok) assert.equal(result.reason, 'cave_evasion_no_safe_step');
    assert.equal(records.some(([name]) => name === 'resupply_escape_guarded'), resupplying);
  };
  await t.test('takes a dry lateral step', () => check({ flat: true, expected: [['guarded', 0, 0, 1]] }));
  await t.test('holds a ledge where the only route away descends', () => check({ expected: [] }));
  await t.test('holds while airborne after an approach abort', () => check({ flat: true, onGround: false, expected: [] }));
  await t.test('retains normal surface flight outside resupply', () => check({
    resupplying: false, expected: [['generic', 3.5, 0, .5]],
  }));
  await t.test('retains the close creeper fallback with no guarded step', () => check({
    mob: 'creeper', expected: [['generic', 3.5, 0, .5]],
  }));
});

test('a visible archer beyond ordinary flee range triggers a safe escape from grounded farmland', async () => {
  const { bot, cells } = fixture();
  const farmland = { ...stone, name: 'farmland', shapes: [[0, 0, 0, 1, 15 / 16, 1]] };
  cells.set('0,0,0', farmland);
  for (let x = -3; x <= 15; x += 1) {
    cells.set(`${x},1,0`, air);
    cells.set(`${x},2,0`, air);
  }
  // This apparent side exit is one block lower than the full-height path.
  for (const y of [0, 1, 2]) cells.set(`0,${y},1`, air);
  bot.entity.position.y = 15 / 16;
  const skeleton = { id: 5, name: 'skeleton', position: new Vec3(14.5, 1, .5), distance: 14 };
  const zombie = { id: 3, name: 'zombie', position: new Vec3(.5, 1, 5.5), distance: 5 };
  const state = { health: 2, food: 0, position: bot.entity.position, inventory: {}, hostiles: [zombie, skeleton] };
  const actions = {
    underground: () => false,
    async goTo(_bot, _ctx, goal) {
      assert.deepEqual([goal.x, goal.y, goal.z], [-1, 1, 0]);
      assert.equal(bot.pathfinder.movements.canDig, false);
      bot.entity.position = new Vec3(goal.x + .5, goal.y, goal.z + .5);
      return { ok: true };
    },
    async fleeFrom() { assert.fail('critical resupply evasion cannot use generic flight'); },
  };
  const escape = (resupplying, underground = false) => createSurvivalBehaviors({
    bot, actions: { ...actions, underground: () => underground }, resupplying: () => resupplying,
  }).find((behavior) => behavior.name === 'escape');
  assert.equal(escape(false).want({ ...state, hostiles: [skeleton] }), 0);
  assert.equal(escape(true, true).want({ ...state, hostiles: [skeleton] }), 0);
  const guarded = escape(true);
  assert.equal(guarded.want(state), 1);
  const records = [];
  const result = await guarded.run({ perceive: () => state, record: (name, data) => records.push({ name, ...data }) });
  assert.deepEqual(result.to, new Vec3(-1, 1, 0));
  assert.equal(records[0].mob, 'skeleton');
  assert.equal(records[1].partialFloor, 'farmland');
  assert.equal(records[2].distance, 15);
  for (const y of [1, 2]) cells.set(`4,${y},0`, stone);
  assert.equal(guarded.want({ ...state, position: bot.entity.position, hostiles: [skeleton] }), 0);
});

test('critical home resupply defends within native strike reach without approaching or collecting drops', async () => {
  const { bot } = fixture();
  bot.world = { raycast: () => null };
  const zombie = { id: 3, name: 'zombie', position: new Vec3(5.5, 0, .5), width: .6, height: 1.95, isValid: true };
  bot.entities = { [zombie.id]: zombie };
  const state = { health: 2, food: 0, position: bot.entity.position, inventory: {},
    hostiles: [{ id: zombie.id, name: zombie.name, position: zombie.position, distance: 5 }] };
  const calls = [];
  const actions = {
    async attack(_bot, _ctx, id, options) {
      calls.push([id, options]);
      return { ok: true };
    },
    async collectDrops() { calls.push('drops'); },
  };
  let resupplying = true;
  const defend = createSurvivalBehaviors({ bot, actions, resupplying: () => resupplying })
    .find((behavior) => behavior.name === 'defend');
  const ctx = { perceive: () => state, record() {} };
  assert.equal(defend.want(state), 0);
  await defend.run(ctx);
  assert.deepEqual(calls, []);
  zombie.position.x = 2.5;
  state.hostiles[0].distance = 2;
  assert.equal(defend.want(state), 1);
  await defend.run(ctx);
  assert.deepEqual(calls, [[zombie.id, { pursue: false }]]);
  zombie.position.x = 5.5;
  state.hostiles[0].distance = 5;
  resupplying = false;
  assert.equal(defend.want(state), 1);
  await defend.run(ctx);
  assert.deepEqual(calls, [[zombie.id, { pursue: false }], [zombie.id, undefined], 'drops']);
});

test('home retreat accepts the plain saved house centre and confirms a grounded arrival', async () => {
  const { bot, cells } = fixture();
  cells.set('8,0,0', air);
  cells.set('8,1,0', air);
  const home = { x: 8.5, y: 0, z: .5 };
  const result = await returnFromCave(bot, {}, {
    async goTo(_bot, _ctx, goal) {
      assert.deepEqual([goal.x, goal.y, goal.z], [8, 0, 0]);
      bot.entity.position = new Vec3(8.5, 0, .5);
      return { ok: true };
    },
  }, home);
  assert.deepEqual(result, { ok: true, atHome: true });
});

test('critical retreat pauses on dry cover for carried safe food, while a visible threat still wins', async () => {
  const { bot, cells } = fixture();
  const state = { health: 2, food: 15, position: bot.entity.position, inventory: { rabbit: 2 }, hostiles: [] };
  const records = [];
  let bites = 0;
  let cuts = 0;
  const actions = {
    underground: () => true,
    pickFood: () => ({ name: 'rabbit' }),
    async eat() { bites += 1; state.food += 2; return { ok: true, ate: 'rabbit' }; },
    async digBlock(_bot, _ctx, block) {
      cuts += 1;
      cells.set(key(block.position), air);
      return { ok: true };
    },
  };
  const behaviors = createSurvivalBehaviors({ bot, actions });
  const retreat = behaviors.find((b) => b.name === 'cave_retreat');
  const escape = behaviors.find((b) => b.name === 'escape');
  const ctx = { perceive: () => ({ ...state }), record: (...args) => records.push(args) };
  assert.equal((await retreat.run(ctx)).ok, true);
  assert.equal(bites, 1);
  assert.equal(cuts, 0);
  assert.deepEqual(records[0], ['cave_retreat_ate', { at: new Vec3(0, 0, 0), food: 'rabbit', foodBefore: 15, foodAfter: 17 }]);
  for (let x = 1; x <= 3; x += 1) {
    cells.set(`${x},1,0`, air);
    cells.set(`${x},0,0`, air);
  }
  state.hostiles = [{ id: 3, name: 'zombie', position: new Vec3(3.5, 0, .5), distance: 3 }];
  assert.ok(escape.want(state));
  assert.ok(escape.band > retreat.band);
  await retreat.run(ctx);
  assert.equal(bites, 1, 'a visible nearby threat interrupts eating');
});
