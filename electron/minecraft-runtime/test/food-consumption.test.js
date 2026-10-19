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
const Item = require('prismarine-item')(registry);
const injectInventory = require('mineflayer/lib/plugins/inventory');
const injectHealth = require('mineflayer/lib/plugins/health');
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');

// Protocol-level regression, not a real-server acceptance fixture. In particular,
// consume(), heldItem, slot updates and health packets use installed Mineflayer.
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-food-consumption-'));
  const paths = { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'),
    MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') };
  const previousEnvironment = Object.fromEntries(Object.keys(paths).map((key) => [key, process.env[key]]));
  Object.assign(process.env, paths);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  const writes = [];
  const events = [];
  const messages = [];
  const bot = new EventEmitter();
  const client = new EventEmitter();
  Object.assign(client, { state: 'play', socket: { writable: true, destroyed: false } });
  const block = (name, position) => Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position });
  Object.assign(bot, { username: 'DeskPet', version: '1.21.8', registry, entities: {}, players: {},
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, effects: {}, onGround: true },
    game: { dimension: 'overworld', gameMode: 'survival' }, player: { ping: 1 },
    _client: client, QUICK_BAR_START: 36, supportFeature: (name) => registry.supportFeature(name),
    clearControlStates: () => {}, stopDigging: () => {}, findBlock: () => null, findBlocks: () => [],
    blockAt: (position) => block(position.y < 64 ? 'stone' : 'air', position.floored()),
    lookAt: async () => {},
    // Food is already selected; no synthetic heldItem setter or consume stub.
    equip: async (item) => { assert.equal(item.type, bot.heldItem.type); },
    pathfinder: { setGoal: () => {}, stop: () => {}, setMovements: () => {} },
  });
  const updateSlot = (slot, name, count, stateId) => client.emit('set_slot', {
    windowId: 0, slot, stateId, item: Item.toNotch(new Item(registry.itemsByName[name].id, count)),
  });
  client.write = (name, data) => {
    writes.push({ name, data, at: Date.now() });
    if (name !== 'use_item') return;
    // A late acknowledgement for an unrelated inventory slot is enough to
    // resolve native consume() before Vanilla's normal eating duration.
    setTimeout(() => {
      updateSlot(15, 'stone_pickaxe', 1, 1);
      events.push({ name: 'unrelated_slot', at: Date.now() });
    }, 2);
    if (options.serverMeal !== false) setTimeout(() => {
      // Model a server that stopped the use action after public pause/cancel.
      const stopped = writes.some((packet) => packet.at >= writes.find((packet) => packet.name === 'use_item').at
        && packet.name === 'block_dig' && packet.data.status === 5);
      if (stopped) return;
      updateSlot(39, 'cooked_porkchop', 2, 2);
      client.emit('update_health', { health: 20, food: 20, foodSaturation: 8 });
      client.emit('entity_status', { entityId: 1, entityStatus: 9 });
      events.push({ name: 'server_meal', at: Date.now() });
    }, 1600);
  };
  injectInventory(bot, { hideErrors: true });
  injectHealth(bot, { respawn: false });
  bot.quickBarSlot = 3;
  updateSlot(39, 'cooked_porkchop', 3, 0);
  client.emit('update_health', { health: 20, food: 18, foodSaturation: 0 });
  const plan = { mode: 'task', intent: 'maintain_self', goal: '补足饥饿值', requiresConfirmation: false,
    missingResources: [], safetyRisk: '', replyText: '正在执行进食时序任务。',
    steps: [{ skill: 'maintain_self', args: { action: 'eat_if_needed', minFood: 20 } }] };
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: options.publicTask ? 'experimental-autonomy' : 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: (message) => messages.push(message), broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false, requestPlannerCompletion: async () => JSON.stringify(plan),
  });
  agent.attachBot(bot);
  if (!options.publicTask) agent.__testSetReconnectTask({ taskId: 'food-consumption', status: 'running', source: 'deskpet',
    logs: [], startedAt: Date.now(), currentStepIndex: 0, plan: { steps: [] } });
  t.after(() => {
    agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    t.mock.timers.reset();
    for (const key of Object.keys(paths)) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function advance(milliseconds) {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 25) {
      t.mock.timers.tick(Math.min(25, milliseconds - elapsed));
      for (let i = 0; i < 25; i += 1) await Promise.resolve();
    }
  }
  async function until(predicate, timeout = 10_000) {
    for (let elapsed = 0; !predicate() && elapsed < timeout; elapsed += 25) await advance(25);
    assert.ok(predicate(), 'Operation must reach its expected state within the bounded deadline');
  }
  async function finish(promise, timeout = 10_000) {
    let settled = false, value, error;
    promise.then((result) => { value = result; settled = true; }, (reason) => { error = reason; settled = true; });
    await until(() => settled, timeout);
    if (error) throw error;
    return value;
  }
  return { agent, bot, writes, events, messages, advance, until, finish };
}

test('installed Mineflayer consume resolves on an unrelated slot packet before a server meal', async (t) => {
  const state = fixture(t, { serverMeal: false });
  const started = Date.now();
  let resolvedAt;
  const eating = state.bot.consume().then(() => { resolvedAt = Date.now(); });
  await state.advance(2);
  assert.equal(resolvedAt - started, 2, 'The actual plugin resolves on the 2ms slot acknowledgement');
  await eating;
  assert.equal(state.events.filter((event) => event.name === 'unrelated_slot').length, 1);
  assert.equal(state.bot.food, 18);
  assert.equal(state.bot.heldItem.count, 3);
  assert.equal(state.writes.filter((packet) => packet.name === 'use_item').length, 1);
});
test('food acquisition preserves its primary failure when the final return also fails',async t=>{
 const state=fixture(t);let calls=0;
 // Explicit executor faults, not a real pathfinding or world acceptance claim.
 state.bot.pathfinder.goto=async()=>{throw new Error(++calls===1?'primary-food-operation':'return-anchor-failed');};
 await assert.rejects(state.finish(state.agent.__testEnsureFoodSupply(8)),error=>{
  assert.equal(error.message,'primary-food-operation');
  assert.equal(error.foodReturnFailure.message,'return-anchor-failed');return true;
 });
 assert.equal(calls,2);
});

test('production nutrition waits for delayed server health after native consume resolves early', async (t) => {
  const state = fixture(t);
  let settled = false;
  const nutrition = state.agent.__testEnsureNutrition(20);
  nutrition.then(() => { settled = true; }, () => { settled = true; });
  await state.until(() => state.events.some((event) => event.name === 'unrelated_slot'));
  await state.advance(1000);
  assert.equal(state.bot.usingHeldItem, false, 'The original inventory plugin has already finished its eating task');
  assert.equal(settled, false, 'Native completion without food growth cannot finish production nutrition');
  assert.equal(state.bot.food, 18);
  assert.equal(await state.finish(nutrition), true);
  assert.equal(state.bot.food, 20);
  assert.equal(state.bot.heldItem.count, 2);
  assert.equal(state.events.filter((event) => event.name === 'server_meal').length, 1);
  assert.equal(state.writes.filter((packet) => packet.name === 'use_item').length, 1, 'Wait on the original use action without resending');
});

test('production nutrition fails within its deadline when native completion has no server food growth', async (t) => {
  const state = fixture(t, { serverMeal: false });
  const started = Date.now();
  await assert.rejects(state.finish(state.agent.__testEnsureNutrition(20)), /食用后没有确认饥饿值恢复/);
  assert.ok(Date.now() - started >= 4000 && Date.now() - started < 7000, 'No-growth failure is bounded by the physical action deadline');
  await state.advance(3000);
  assert.equal(state.bot.food, 18);
  assert.equal(state.bot.heldItem.count, 3);
  assert.equal(state.writes.filter((packet) => packet.name === 'use_item').length, 1, 'Failure never consumes repeatedly');
});

test('concurrent same-owner nutrition shares one real native consume and one authoritative meal',async t=>{
 const state=fixture(t);let nativeCalls=0;
 const consume=state.bot.consume.bind(state.bot);state.bot.consume=(...args)=>{nativeCalls++;return consume(...args);};
 const first=state.agent.__testEnsureNutrition(20),second=state.agent.__testEnsureNutrition(20);
 const result=await state.finish(Promise.all([first,second]));
 assert.deepEqual(result,[true,true]);assert.equal(nativeCalls,1);
 assert.equal(state.writes.filter(p=>p.name==='use_item').length,1);
 assert.equal(state.events.filter(e=>e.name==='server_meal').length,1);
 assert.equal(state.bot.food,20);assert.equal(state.bot.heldItem.count,2);
});

test('a second nutrition request after native use starts cannot stop or replace the first meal',async t=>{
 const state=fixture(t);const first=state.agent.__testEnsureNutrition(20);
 await state.until(()=>state.writes.some(p=>p.name==='use_item'));await state.advance(150);
 const second=state.agent.__testEnsureNutrition(20);
 assert.deepEqual(await state.finish(Promise.all([first,second])),[true,true]);
 assert.equal(state.writes.filter(p=>p.name==='use_item').length,1);
 assert.equal(state.events.filter(e=>e.name==='server_meal').length,1);assert.equal(state.bot.food,20);
});

test('public pause cancels a pending real-plugin meal without another use or false completion', async (t) => {
  const state = fixture(t, { publicTask: true });
  await state.finish(state.agent.handleMessage({ type: 'mc_command_submit', command: '执行自定义协议时序任务', source: 'deskpet' }));
  await state.until(() => state.events.some((event) => event.name === 'unrelated_slot'));
  const task = state.agent.__testGetReconnectTask();
  assert.equal(task.status, 'running');
  await state.finish(state.agent.handleMessage({ type: 'mc_command_pause' }));
  await state.advance(7000);
  assert.equal(task.status, 'paused');
  assert.equal(state.bot.food, 18);
  assert.equal(state.bot.heldItem.count, 3);
  assert.equal(state.events.filter((event) => event.name === 'server_meal').length, 0);
  assert.equal(state.writes.filter((packet) => packet.name === 'use_item').length, 1);
  assert.equal(state.messages.some((message) => message.type === 'mc_task_event'
    && message.event?.eventType === 'completed'), false);
});

test('food exploration preserves its parent deadline and cannot consume another column after expiry',async t=>{
 const f=fixture(t),columns=[new Vec3(16,64,0)];let moves=0;
 f.bot.pathfinder.goto=async()=>{moves++;};
 await assert.rejects(f.agent.__testExploreNextSurfacePosition(columns,{deadline:Date.now()-1}),{code:'house_food_search_timeout'});
 assert.equal(moves,0);assert.equal(columns.length,1);assert.equal(f.writes.filter(p=>p.name==='use_item').length,0);
});

test('food supply consumes the immediate meal before confirming the independent spare reserve',async t=>{
 const state=fixture(t);
 Object.assign(state.bot.entity,{isInWater:false,isInLava:false});
 state.bot.pathfinder.goto=async goal=>{assert.equal(goal.isEnd(state.bot.entity.position.floored()),true,'This protocol fixture never requests movement away from its actual anchor');};
 const result=await state.finish(state.agent.__testEnsureFoodSupply(8,{minFoodPoints:16}));
 assert.equal(result,true);assert.equal(state.bot.food,20);
 assert.equal(state.bot.heldItem.count,2);
 assert.equal(state.events.filter(e=>e.name==='server_meal').length,1);
 assert.equal(state.writes.filter(e=>e.name==='use_item').length,1);
});
