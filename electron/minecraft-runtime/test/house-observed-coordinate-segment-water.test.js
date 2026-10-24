/* global require, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');
const { createLoadedDryGraph, dryFoot, hasGroundedBodySupport } = require('../vendor/server/minecraft/houseSurfaceGraph');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const point = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const key = p => `${p.x},${p.y},${p.z}`;
const anchor = { x: 0, y: 2, z: 0 };
const waterRoute = () => ({ schema: 1, kind: 'loaded_source_water_wade', depth: 1, width: 4,
  surfaceY: 2, from: { x: 7, y: 2, z: 0 }, to: { x: 12, y: 2, z: 0 },
  waterStart: { x: 8, z: 0 }, direction: { x: 1, z: 0 } });

// OFFLINE actual installed pathfinder + vanilla Physics/PlayerState. Only the
// initial entity position/velocity is configured; all later changes come from
// simulatePlayer(...).apply(bot). The voxel fixture remains immutable and no
// callback teleports, assigns a goal position or fabricates a positive arrival.
function fixture(t, options = {}) {
  const token = new CancellationToken(), samples = [], attempts = [], crossings = [], checkpoints = [], probeFacts = [];
  let checkpoint = null, owner = true, discovery = true, waterBehavior = options.waterBehavior, wideLoaded = false;
  const controls = Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, false]));
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', health: 20, food: 20, oxygenLevel: 20,
    username: 'WaterGraphUnit', game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    entities: {}, players: {}, player: { ping: 1 }, inventory: { slots: Array(46).fill(null), items: () => [] },
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, controlState: controls,
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    entity: { position: new Vec3(0.5, 2, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: true, elytraFlying: false },
  });
  bot.blockAt = raw => {
    const p = raw.floored();
    if ((wideLoaded ? p.x < -512 || p.x > 512 || Math.abs(p.z) > 512 : p.x < -12 || p.x > 15 || Math.abs(p.z) > 1) || p.y < -64 || p.y > 100) return null;
    const name = p.y < 1 ? 'stone' : p.y === 1 ? p.x >= 8 && p.x <= 11 ? 'water' : 'stone' : 'air';
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position: p });
  };
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.setControlState = (name, value) => { controls[name] = value; };
  bot.clearControlStates = () => { for (const name of Object.keys(controls)) controls[name] = false; };
  bot.stopDigging = () => {}; bot.deactivateItem = () => {};
  bot.physics = Physics(registry, { getBlock: bot.blockAt }); pathfinder(bot);
  const nativeGoto = bot.pathfinder.goto.bind(bot.pathfinder);
  bot.pathfinder.goto = goal => { attempts.push({ kind: 'direct', target: point(goal) }); return nativeGoto(goal); };
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, controls), { getBlock: bot.blockAt }).apply(bot);
    samples.push({ position: bot.entity.position.clone(), onGround: bot.entity.onGround, water: bot.entity.isInWater });
    bot.emit('physicsTick');
  }, 5);
  const active = () => token.throwIfRequested();
  async function nativeCross(route) {
    active(); assert.deepEqual(point(bot.entity.position), route.from);
    assert.equal(hasGroundedBodySupport(bot), true);
    // Exact static 3wide source-water, loaded bottom and headroom. Side cells
    // outside this strip are UNKNOWN, so native planning cannot go around it.
    for (let i = 0; i < route.width; i++) for (let lateral = -1; lateral <= 1; lateral++) {
      const p = new Vec3(route.waterStart.x + i, route.surfaceY - 1, lateral);
      assert.equal(bot.blockAt(p).name, 'water'); assert.equal(Number(bot.blockAt(p).getProperties().level), 0);
      assert.equal(bot.blockAt(p.offset(0, -1, 0)).name, 'stone');
      for (let h = 1; h <= 4; h++) assert.equal(bot.blockAt(p.offset(0, h, 0)).name, 'air');
    }
    const previous = bot.pathfinder.movements, movement = new Movements(bot);
    movement.canDig = false; movement.scafoldingBlocks = []; movement.allowParkour = false;
    movement.allow1by1towers = false; movement.allowSprinting = false; movement.allowFreeMotion = false;
    movement.maxDropDown = 2; movement.infiniteLiquidDropdownDistance = false; movement.getMoveDiagonal = () => {};
    movement.exclusionAreasStep.push(block => block?.position?.z === 0 && block.position.x >= 7 && block.position.x <= 12 ? 0 : Infinity);
    bot.pathfinder.setMovements(movement);
    const record = { from: clone(route.from), to: clone(route.to), startSample: samples.length }; crossings.push(record);
    let deadline, originalFailure = null;
    const inspect = () => {
      if (waterBehavior === 'failWet' && bot.entity.isInWater && bot.entity.position.x >= 9) {
        originalFailure = options.originalFailure || Object.assign(new Error('Native shallow transport interrupted'), { code: 'water_timeout' });
        if (owner && bot.pathfinder.movements === movement) { bot.pathfinder.setGoal(null); bot.clearControlStates(); }
      }
    };
    bot.on('physicsTick', inspect);
    try {
      await Promise.race([nativeGoto(new goals.GoalBlock(route.to.x, route.to.y, route.to.z)), new Promise((_resolve, reject) => {
        deadline = setTimeout(() => { if (owner && bot.pathfinder.movements === movement) bot.pathfinder.setGoal(null); reject(new Error('Native crossing fixture timed out')); }, 4000);
      })]);
      for (let n = 0; n < 100 && !hasGroundedBodySupport(bot); n++) { active(); await sleep(5); }
      active(); assert.equal(dryFoot(bot, route.to), true); assert.equal(hasGroundedBodySupport(bot), true);
      assert.deepEqual(point(bot.entity.position), route.to);
      record.actual = point(bot.entity.position); record.finishSample = samples.length;
      if (waterBehavior === 'foreignAfterLanding') {
        owner = false; const replacement = new Movements(bot); replacement.canDig = false;
        record.foreignMovements = replacement; record.foreignGoal = new goals.GoalBlock(14, 2, 0);
        bot.pathfinder.setMovements(replacement); bot.pathfinder.setGoal(record.foreignGoal);
      }
      return { confirmed: waterBehavior !== 'unconfirmed', actual: point(bot.entity.position) };
    } catch (error) { throw originalFailure || error; }
    finally {
      clearTimeout(deadline); bot.removeListener('physicsTick', inspect);
      if (owner && bot.pathfinder.movements === movement) bot.pathfinder.setMovements(previous);
    }
  }
  const deps = { getBot: () => bot, assertActive: active, isMovementOwner: () => owner, onProbe: facts => probeFacts.push(clone(facts)),
    getCP: () => checkpoint, saveCP: value => { checkpoint = value; checkpoints.push(clone(value)); },
    discoverWaterRoutes: ({ origin }) => discovery && key(origin) === key(anchor) ? [{ route: options.route || waterRoute() }] : [],
    traverseWater: async route => {
      if (waterBehavior === 'pauseAtEntry') { token.pause(); active(); }
      return nativeCross(route);
    },
    actualnativegoto: async (goal, movements) => {
      assert.equal(movements.canDig, false); assert.equal(movements.blocksToAvoid.has(registry.blocksByName.water.id), true);
      bot.pathfinder.setMovements(movements); attempts.push({ kind: 'dry', target: point(goal), at: point(bot.entity.position) });
      assert.ok(goal.x <= 7, 'Generic dry goto must never cross the water edge to its child bank');
      const result = await nativeGoto(goal);
      if (options.foreignAfterDry && goal.x === 7) {
        owner = false; const replacement = new Movements(bot); replacement.canDig = false;
        options.foreignAfterDry.movements = replacement; options.foreignAfterDry.goal = new goals.GoalBlock(3, 2, 0);
        bot.pathfinder.setMovements(replacement); bot.pathfinder.setGoal(options.foreignAfterDry.goal);
      }
      return result;
    },
  };
  const graph = () => createLoadedDryGraph(deps, { anchor, step: 8, radius: 32, maxNodes: 16, timeoutMs: 20000, legTimeoutMs: 5000 });
  t.after(() => { clearInterval(timer); bot.pathfinder.setGoal(null); bot.clearControlStates(); });
  return { bot, deps, graph, samples, attempts, crossings, checkpoints, probeFacts, state: () => checkpoint,
    resume: () => token.resume(), pause: () => token.pause(), behavior: value => { waterBehavior = value; },
    disableDiscovery: () => { discovery = false; }, widenLoaded: () => { wideLoaded = true; } };
}


test('an observed typed river return remains safe when native dry search is inconclusive', { timeout: 20000 }, async t => {
  const f = fixture(t), graph = f.graph();
  const first = await graph.next();
  assert.equal(first.moved, true); assert.deepEqual(first.actual, { x: 12, y: 2, z: 0 });
  const savedTransport = clone(graph.getState().nodes['12,2,0'].transport); f.widenLoaded();
  let returned, error;
  try { returned = await graph.returnToAnchor(); } catch (e) { error = { code:e.code, message:e.message, observedProbe:e.observedProbe }; }
  const receipt = {
    runtimeRoot: process.env.REVIEW_RUNTIME_ROOT || require('node:path').resolve(__dirname, '..'),
    returned: returned || null, error: error || null,
    actual: point(f.bot.entity.position), grounded: hasGroundedBodySupport(f.bot),
    waterCrossings:f.crossings.map(c => [c.from.x,c.to.x]), nativeProbeFacts:f.probeFacts,
    nativeDryAttempts:f.attempts.filter(a => a.kind==='dry'),
    visits:graph.getState().visits,
    preservedTransport:JSON.stringify(savedTransport)===JSON.stringify(graph.getState().nodes['12,2,0'].transport),
    scope:'Private synthetic loaded river; installed native pathfinder and PlayerState physics; not historical Whole09 evidence'
  };
  const fs = require('node:fs'), path = require('node:path');
  const receiptPath = process.env.REVIEW_RECEIPT || path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'house-coordinate-segment-water-')), 'receipt.json');
  fs.writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
  assert.equal(returned?.confirmed,true); assert.equal(error,undefined);
  assert.ok(f.probeFacts.some(p=>['timeout','partial'].includes(p.status)&&p.conclusive===false), 'Original installed dry planner must actually be inconclusive before typed return');
  assert.equal(receipt.preservedTransport,true);assert.equal(receipt.visits,2);
  assert.deepEqual(receipt.waterCrossings,[[7,12],[12,7]]);
});
