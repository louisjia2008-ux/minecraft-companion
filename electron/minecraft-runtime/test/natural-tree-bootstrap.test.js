/* global require, process, setTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');

function treeFixture(t, logPositions, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-natural-trees-'));
  const paths = { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'), MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') };
  const previousEnvironment = Object.fromEntries(Object.keys(paths).map((name) => [name, process.env[name]]));
  Object.assign(process.env, paths);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const key = (point) => point.floored().toString();
  const stock = new Map();
  const world = new Map();
  const moves = [];
  const digs = [];
  const block = (name, position) => Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: position.floored() });
  for (const coordinates of logPositions) {
    const position = new Vec3(...coordinates);
    world.set(key(position), block('oak_log', position));
  }
  const items = () => [...stock].filter(([, count]) => count > 0).map(([name, count]) => ({
    name, count, type: registry.itemsByName[name].id, metadata: 0,
  }));
  const bot = Object.assign(new EventEmitter(), {
    username: 'DeskPet', health: 20, food: 20, registry, version: '1.21.8', entities: {}, players: {},
    entity: { position: new Vec3(0.5, 64, 0.5), effects: {}, onGround: true },
    inventory: { items, count: (type) => items().filter((item) => item.type === type).reduce((sum, item) => sum + item.count, 0) },
    game: { dimension: 'overworld', gameMode: 'survival' }, player: { ping: 1 },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    clearControlStates: () => {},
    blockAt: (position) => world.get(key(position)) || block(position.y < 64 ? 'stone' : 'air', position),
    canDigBlock: (target) => (!options.inaccessible || !options.inaccessible(target))
      && bot.entity.position.offset(0, 1.62, 0).distanceTo(target.position.offset(0.5, 0.5, 0.5)) <= 4.5,
    dig: async (target) => {
      assert.ok(bot.canDigBlock(target), 'Only reachable logs may be harvested');
      assert.equal(target.canHarvest(bot.heldItem?.type ?? null), true, 'Real block metadata must permit the held tool');
      digs.push(target.position.clone());
      world.delete(key(target.position));
      stock.set('oak_log', (stock.get('oak_log') || 0) + 1);
    },
    equip: async (item) => { bot.heldItem = item; },
  });
  const candidates = (query) => [...world.values()].filter((target) => query.matching(target)
    && target.position.distanceTo(bot.entity.position) <= query.maxDistance)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  bot.findBlocks = (query) => candidates(query).slice(0, query.count || 1).map((target) => target.position);
  bot.findBlock = (query) => candidates(query)[0] || null;
  bot.pathfinder = {
    setGoal: () => {}, stop: () => {}, setMovements: () => {}, bestHarvestTool: () => null,
    goto: async (goal) => {
      moves.push({ x: goal.x, y: goal.y, z: goal.z });
      if (options.goto) await options.goto(goal, bot, task);
      else {
        if (goal.y > 65) { const error = new Error('No path to a floating tree crown'); error.name = 'NoPath'; throw error; }
        bot.entity.position = new Vec3(goal.x - 1, 64, goal.z + 0.5);
      }
    },
  };
  // The production tree helper runs with actual registry/Block harvesting
  // metadata; no recipe or tool capability table is reimplemented here.
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: () => {}, broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { throw new Error('Unexpected provider request'); },
  });
  const task = { taskId: 'natural-tree-bootstrap', status: 'running', source: 'deskpet', logs: [],
    startedAt: Date.now(), currentStepIndex: 0, plan: { steps: [] } };
  agent.attachBot(bot);
  agent.__testSetReconnectTask(task);
  t.after(() => {
    agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    t.mock.timers.reset();
    for (const name of Object.keys(paths)) {
      if (previousEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnvironment[name];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function finish(promise) {
    let settled = false, value, error;
    promise.then((result) => { settled = true; value = result; }, (failure) => { settled = true; error = failure; });
    for (let elapsed = 0; !settled && elapsed < 180_000; elapsed += 100) {
      t.mock.timers.tick(100);
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    }
    assert.equal(settled, true, 'Tree acquisition must end within a bounded candidate search');
    if (error) throw error;
    return value;
  }
  return { agent, bot, task, stock, moves, digs, finish };
}

test('an unreachable nearby crown does not block a reachable ground-level tree', async (t) => {
  const f = treeFixture(t, [[0, 70, 0], [8, 64, 0]], {
    inaccessible: (target) => target.position.y > 68,
  });
  assert.equal(await f.finish(f.agent.__testBootstrapWoodLogs(1, 48)), true);
  assert.deepEqual(f.digs, [new Vec3(8, 64, 0)]);
  assert.equal(f.stock.get('oak_log'), 1);
});

test('a high log already in digging reach is harvested without an aerial navigation goal', async (t) => {
  const f = treeFixture(t, [[1, 67, 0]], {
    goto: async () => { throw new Error('Reachable log must not trigger an unnecessary air goal'); },
  });
  assert.equal(await f.finish(f.agent.__testBootstrapWoodLogs(1, 48)), true);
  assert.equal(f.moves.length, 0);
  assert.deepEqual(f.digs, [new Vec3(1, 67, 0)]);
});

test('NoPath for the first tree allows acquisition from another loaded tree', async (t) => {
  const f = treeFixture(t, [[4, 64, 0], [8, 64, 0]], {
    inaccessible: (target) => target.position.x === 4,
    goto: async (goal, bot) => {
      if (goal.x === 4) { const error = new Error('No path to first tree'); error.name = 'NoPath'; throw error; }
      bot.entity.position = new Vec3(goal.x - 1, 64, 0.5);
    },
  });
  assert.equal(await f.finish(f.agent.__testBootstrapWoodLogs(1, 48)), true);
  assert.deepEqual(f.digs, [new Vec3(8, 64, 0)]);
});

test('a world containing only unreachable logs fails clearly without harvesting', async (t) => {
  const f = treeFixture(t, [[0, 70, 0], [2, 71, 0]], {
    inaccessible: () => true,
    goto: async () => { const error = new Error('No path to any tree'); error.name = 'NoPath'; throw error; },
  });
  await assert.rejects(f.finish(f.agent.__testBootstrapWoodLogs(1, 48)), /原木|可达|采集/u);
  assert.equal(f.digs.length, 0);
  assert.equal(f.stock.size, 0);
});

test('cancellation while approaching a tree is propagated instead of trying another tree', async (t) => {
  const f = treeFixture(t, [[5, 64, 0], [8, 64, 0]], {
    goto: async (_goal, _bot, task) => {
      task.watchdogAbortMessage = 'Task cancelled while approaching tree';
      task.watchdogAbortCode = 'cancelled';
      const error = new Error(task.watchdogAbortMessage); error.code = 'cancelled'; throw error;
    },
  });
  await assert.rejects(f.finish(f.agent.__testBootstrapWoodLogs(1, 48)), (error) => error.code === 'cancelled');
  assert.equal(f.moves.length, 1);
  assert.equal(f.digs.length, 0);
});

test('tree harvesting waits for grounded physics after goto returns in the air', async (t) => {
  let landedAt = 0;
  const f = treeFixture(t, [[8, 64, 0]], {
    goto: async (_goal, bot) => {
      bot.entity.position = new Vec3(7, 64.4, 0.5);
      bot.entity.onGround = false;
      setTimeout(() => { bot.entity.position = new Vec3(7, 64, 0.5); bot.entity.onGround = true; landedAt = Date.now(); }, 300);
    },
  });
  const dig = f.bot.dig;
  f.bot.dig = async (target) => {
    assert.equal(f.bot.entity.onGround, true);
    assert.ok(landedAt > 0, 'A successful goto alone must not authorize an airborne dig');
    await dig(target);
  };
  assert.equal(await f.finish(f.agent.__testBootstrapWoodLogs(1, 48)), true);
  assert.equal(f.digs.length, 1);
});

test('a tree remains unharvested when physics never confirms landing', async (t) => {
  const f = treeFixture(t, [[8, 64, 0]], {
    goto: async (_goal, bot) => { bot.entity.position = new Vec3(7, 64.4, 0.5); bot.entity.onGround = false; },
  });
  await assert.rejects(f.finish(f.agent.__testBootstrapWoodLogs(1, 48)), /落稳/u);
  assert.equal(f.digs.length, 0);
});

// Engine contract fixtures use the installed registry, block shapes, GoalBlock
// and execution wrappers. Their goto service models server movement explicitly;
// these tests are neither native-physics nor live-server acceptance evidence.
const terrainBlock = (name, position) => Object.assign(
  Block.fromStateId(registry.blocksByName[name].defaultState), { position: position.floored() });
function surfaceFixture(t, options = {}) {
  const f = treeFixture(t, [], options);
  f.task.cancellationToken = new CancellationToken();
  f.task.executionGeneration = 1;
  f.task.movementLease = f.agent.__testClaimMovementLease('task', f.task.taskId);
  f.explore = (detailed = true) => f.agent.__testWithHouseResourceBounds([], () =>
    f.agent.__testExploreNextSurfacePosition([new Vec3(32, 64, 0)], { detailed }));
  return f;
}

test('self-supply surface exploration reaches a dry alternative when the nominal column is water', async (t) => {
  const f = surfaceFixture(t, { goto: async (goal, bot) => {
    bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    bot.entity.onGround = true;
  } });
  f.bot.blockAt = position => terrainBlock(position.x === 32 && position.z === 0
    ? 'water' : position.y < 64 ? 'sand' : 'air', position);
  const result = await f.finish(f.explore());
  assert.equal(result.moved, true);
  assert.deepEqual(f.moves, [{ x: 40, y: 64, z: 0 }]);
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(40, 64, 0));
  assert.equal(f.bot.entity.onGround, true);
  assert.ok(result.diagnostics.rejected.hazard > 0);
  assert.equal(result.diagnostics.attempts.length, 0);
});

for (const kind of ['unknown', 'fluid']) {
  test(`self-supply ${kind} columns return a detailed false result without a goto`, async (t) => {
    const f = surfaceFixture(t);
    f.bot.blockAt = position => kind === 'unknown' ? null : terrainBlock('water', position);
    const result = await f.finish(f.explore());
    assert.equal(result.moved, false);
    assert.equal(f.moves.length, 0);
    assert.equal(result.diagnostics.attempts.length, 0);
    assert.equal(result.diagnostics.rejected[kind === 'unknown' ? 'unloaded' : 'hazard'], 9 * 65);
    assert.match(result.reason, kind === 'unknown' ? /未加载 585/ : /危险或流体 585/);
    assert.deepEqual(f.bot.entity.position, new Vec3(0.5, 64, 0.5));
  });
}

test('all native NoPath failures retain each attempted dry target and the original error reason', async (t) => {
  const f = surfaceFixture(t, { goto: async () => {
    const error = new Error('Fixture native pathfinder rejected the dry target'); error.name = 'NoPath'; throw error;
  } });
  const result = await f.finish(f.explore());
  assert.equal(result.moved, false);
  assert.equal(f.moves.length, 9);
  assert.equal(result.diagnostics.attempts.length, 9);
  assert.deepEqual(result.diagnostics.attempts.map(attempt => attempt.target), f.moves);
  assert.ok(result.diagnostics.attempts.every(attempt => attempt.code === 'NoPath'
    && attempt.message.includes('Fixture native pathfinder rejected')));
  assert.match(result.reason, /全部 9 个干燥替代目标原生寻路失败/);
  assert.match(result.reason, /Fixture native pathfinder rejected/);
});

for (const kind of ['no displacement', 'never grounded']) {
  test(`a goto promise with ${kind} cannot confirm surface movement`, async (t) => {
    const f = surfaceFixture(t, { goto: async (goal, bot) => {
      if (kind === 'never grounded') {
        bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
        bot.entity.onGround = false;
      }
    } });
    const result = await f.finish(f.explore());
    assert.equal(result.moved, false);
    assert.equal(f.moves.length, 9);
    assert.equal(result.diagnostics.attempts.length, 9);
    assert.ok(result.diagnostics.attempts.every(attempt => attempt.code ===
      (kind === 'no displacement' ? 'NoPath' : 'surface_not_grounded')), JSON.stringify(result.diagnostics.attempts));
    if (kind === 'no displacement') assert.ok(result.diagnostics.attempts.every(attempt => /实际位置未到达目标/u.test(attempt.message)));
    if (kind === 'no displacement') assert.deepEqual(f.bot.entity.position, new Vec3(0.5, 64, 0.5));
    else assert.equal(f.bot.entity.onGround, false);
  });
}

for (const [messageType, code] of [['mc_command_pause', 'paused'], ['mc_command_cancel', 'cancelled']]) {
  test(`public ${code} during the first surface goto prevents every later dry alternative`, async (t) => {
    let agent;
    const f = surfaceFixture(t, { goto: async () => { await agent.handleMessage({ type: messageType }); } });
    agent = f.agent;
    await assert.rejects(f.finish(f.explore()), error => error.code === code);
    assert.equal(f.moves.length, 1);
    assert.equal(f.digs.length, 0);
    assert.deepEqual(f.bot.entity.position, new Vec3(0.5, 64, 0.5));
    if (code === 'paused') assert.equal(f.task.status, 'paused');
    else assert.equal(f.agent.__testGetReconnectTask(), null);
  });
}

test('ordinary surface consumers still receive boolean false rather than a truthy detailed failure object', async (t) => {
  const f = surfaceFixture(t);
  f.bot.blockAt = () => null;
  const result = await f.finish(f.explore(false));
  assert.equal(result, false);
  assert.equal(typeof result, 'boolean');
  assert.equal(f.moves.length, 0);
});
