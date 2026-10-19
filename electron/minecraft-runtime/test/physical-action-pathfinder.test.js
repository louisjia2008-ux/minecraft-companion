/* global require, process, setInterval, clearInterval */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, goals } = require('mineflayer-pathfinder');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');

// Unlike the voxel expedition fixtures, this uses the installed pathfinder's
// goto/stop lifecycle and actual player physics; no movement callback teleports
// the bot to a goal or silently clears the pathfinder's deferred stop flag.
function physicsBot(t) {
  const registry = require('prismarine-registry')('1.21.8');
  const Block = require('prismarine-block')(registry);
  const stock = new Map([['oak_planks', 8]]);
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.21.8', username: 'DeskPet', health: 20, food: 20,
    game: { minY: -64, height: 384, dimension: 'overworld', gameMode: 'survival' },
    entities: {}, players: {}, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    player: { ping: 1 }, _client: { state: 'play', socket: { writable: true, destroyed: false } },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    entity: { position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
      eyeHeight: 1.62, height: 1.8, width: 0.6, yaw: 0, pitch: 0, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: true, elytraFlying: false },
  });
  bot.inventory = { slots: Array(46).fill(null), items: () => [...stock]
    .filter(([, count]) => count > 0)
    .map(([name, count]) => ({ name, type: registry.itemsByName[name].id, metadata: 0, count })) };
  bot.inventory.count = (type) => bot.inventory.items()
    .filter((item) => item.type === type).reduce((total, item) => total + item.count, 0);
  bot.blockAt = (raw) => {
    const position = raw.floored();
    return Object.assign(Block.fromStateId(registry.blocksByName[position.y < 1 ? 'stone' : 'air'].defaultState), { position });
  };
  bot.findBlock = () => null;
  bot.findBlocks = () => [];
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.lookAt = async () => {};
  bot.setControlState = (key, value) => { bot.controlState[key] = value; };
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.controlState[key] = false; };
  bot.stopDigging = () => {};
  bot.deactivateItem = () => {};
  bot.physics = Physics(registry, { getBlock: bot.blockAt });
  pathfinder(bot);
  require('mineflayer/lib/plugins/craft')(bot);
  bot.craft = async (recipe, repeats) => {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const delta of recipe.delta) {
        const name = registry.items[delta.id].name;
        const count = (stock.get(name) || 0) + delta.count;
        assert.ok(count >= 0, 'Crafting must consume actual recipe ingredients');
        stock.set(name, count);
      }
    }
  };
  const timer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), { getBlock: bot.blockAt }).apply(bot);
    bot.emit('physicsTick');
  }, 10);
  t.after(() => clearInterval(timer));
  return { bot, stock };
}

test('crafting while pathfinder is idle leaves the next real movement usable', { timeout: 5000 }, async (t) => {
  const { bot, stock } = physicsBot(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-pathfinder-lifecycle-'));
  process.env.MC_AGENT_LEARNING_PATH = path.join(dir, 'learning.json');
  process.env.MC_AGENT_DIAGNOSTICS_DIR = path.join(dir, 'diagnostics');
  process.env.MC_AGENT_DISCONNECT_TRACE_PATH = path.join(dir, 'disconnect.jsonl');
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor' }), parseJsonObjectFromText: JSON.parse,
    broadcast: () => {}, broadcastMinecraftError: () => {}, allowAutonomousMaintenance: () => false });
  const task = { taskId: 'craft-move', status: 'running', intent: 'mine_diamond_resource',
    logs: [], currentStepIndex: 0, currentStep: 'mine_resource', plan: { steps: [] } };
  t.after(() => {
    agent.__testSetReconnectTask(null);
    agent.detachBot('manual_disconnect');
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  agent.attachBot(bot);
  agent.initializeBotRuntime();
  agent.__testSetReconnectTask(task);
  await agent.__testEnsureSticks(4);
  assert.equal(stock.get('stick'), 4);
  assert.equal(bot.pathfinder.isMoving(), false);
  await bot.pathfinder.goto(new goals.GoalBlock(2, 1, 0));
  assert.deepEqual(bot.entity.position.floored(), new Vec3(2, 1, 0));
  // The bug also affected consecutive crafts before the next gathering trip.
  await agent.__testEnsureSticks(8);
  assert.equal(stock.get('stick'), 8);
  await bot.pathfinder.goto(new goals.GoalBlock(-2, 1, 0));
  assert.deepEqual(bot.entity.position.floored(), new Vec3(-2, 1, 0));
});
