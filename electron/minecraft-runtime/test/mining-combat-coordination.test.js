/* global require, process, setTimeout, clearTimeout, setInterval, clearInterval */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder } = require('mineflayer-pathfinder');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createMinecraftTaskAgent } = require('../vendor/server/minecraftTaskAgent');
const { createMiningNavigator } = require('../vendor/server/minecraft/miningNavigation');
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.ok(predicate(), 'Expected physical/coordination transition must occur within a finite deadline');
}

// Offline coordination regression, not real-server acceptance. The installed
// pathfinder and installed vanilla physics own all movement; there is no moveTo
// injection, teleport, target-position assignment or movement implementation stub.
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-mining-combat-'));
  const paths = { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'),
    MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') };
  const previousEnvironment = Object.fromEntries(Object.keys(paths).map((key) => [key, process.env[key]]));
  Object.assign(process.env, paths);
  const cells = new Map();
  const attempts = [];
  const attacks = [];
  const movementProfiles = [];
  const goals = [];
  const messages = [];
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', username: 'DeskPet', health: 20, food: 20,
    game: { minY: -64, height: 384, dimension: 'overworld', gameMode: 'survival' }, entities: {}, players: {},
    jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, player: { ping: 1 },
    _client: { state: 'play', socket: { writable: true, destroyed: false } },
    controlState: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map((name) => [name, false])),
    entity: { id: 1, position: options.startPosition?new Vec3(options.startPosition.x,options.startPosition.y,options.startPosition.z):new Vec3(0.5, 1, 0.5), velocity: options.initialVelocity?.clone()||new Vec3(0, 0, 0), onGround: true,
      eyeHeight: 1.62, height: 1.8, width: 0.6, yaw: 0, pitch: 0, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: true, elytraFlying: false },
  });
  const sword = { name: 'stone_sword', type: registry.itemsByName.stone_sword.id, count: 1, metadata: 0 };
  bot.inventory = { slots: Array(46).fill(null), items: () => [sword], count: (type) => Number(type === sword.type) };
  bot.heldItem = sword;
  bot.__shieldUses=[];
  if(options.shield)bot.inventory.slots[45]={name:'shield',type:registry.itemsByName.shield.id,count:1};
  bot.activateItem=offHand=>{bot.__shieldUses.push(offHand);bot.__shieldActive=offHand===true;};
  bot.blockAt = (raw) => {
    const position = raw.floored();
    if(options.worldAt)return options.worldAt(position);
    const name = cells.get(position.toString()) ?? (position.y < 1 ? 'stone' : 'air');
    return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState), { position });
  };
  bot.findBlock = () => null; bot.findBlocks = () => [];
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.lookAt = async () => {};
  bot.setControlState = (name, value) => { bot.controlState[name] = value; };
  bot.clearControlStates = () => { for (const name of Object.keys(bot.controlState)) bot.controlState[name] = false; };
  bot.stopDigging = () => {}; bot.deactivateItem = () => {bot.__shieldActive=false;};
  bot.equip = async (item) => { bot.heldItem = item; };
  bot.attack = (entity) => {
    attacks.push({ id: entity.id, at: Date.now(), position: bot.entity.position.clone(), movements: bot.pathfinder.movements,lease:agent.__testGetActiveMovementLease() });
    if (attacks.length >= (options.killAfter || 1)) {
      delete bot.entities[entity.id];
      bot.emit('entityGone', entity);
    }
  };
  const world = { getBlock: (point) => bot.blockAt(point) };
  bot.physics = Physics(registry, world);
  pathfinder(bot);
  const skeleton = { id: 2, name: 'skeleton', displayName: 'Skeleton', type: 'hostile',
    entityType: registry.entitiesByName.skeleton.id, height: 1.99, position: new Vec3(options.skeletonX ?? 2.5, 1, 0.5) };
  // Its spawn precedes attachBot's perception snapshot/cache, as on an already
  // loaded server. The explicit interruption starts only after native goto.
  if (options.interrupt !== false && !options.deferInitialThreat) bot.entities[skeleton.id] = skeleton;
  if (options.resourceThreat) bot.entities[4] = { id: 4, name: options.resourceThreat, type: 'hostile',
    entityType: registry.entitiesByName[options.resourceThreat].id, position: new Vec3(options.resourceThreat==='creeper'&&!options.shield?4:2.5, 1, .5), height: 1.95 };
  if(options.resourceThreat==='creeper'){
    const e=bot.entities[4],keys=registry.entitiesByName.creeper.metadataKeys;e.metadata=[];
    e.metadata[keys.indexOf('is_powered')]=false;e.metadata[keys.indexOf('is_ignited')]=false;
  }
  const installedGoto = bot.pathfinder.goto.bind(bot.pathfinder);
  bot.pathfinder.goto = (goal) => {
    attempts.push({ x: goal.x, y: goal.y, z: goal.z, at: Date.now(), movements: bot.pathfinder.movements });
    return installedGoto(goal);
  };
  const installedSetMovements = bot.pathfinder.setMovements.bind(bot.pathfinder);
  bot.pathfinder.setMovements = (movements) => { movementProfiles.push(movements); installedSetMovements(movements); };
  bot.on('goal_updated', (goal) => goals.push(goal));
  let ticks = 0;
  const physicsTimer = setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), world).apply(bot);
    ticks += 1;
    bot.emit('physicsTick');
  }, 20);
  const agent = (options.createAgent || createMinecraftTaskAgent)({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor', mcAgentAutoReconnect: false }),
    parseJsonObjectFromText: JSON.parse, broadcast: (message) => messages.push(message), broadcastMinecraftError: () => {},
    allowAutonomousMaintenance: () => false,
    requestPlannerCompletion: async () => { throw new Error('Unexpected planner during checked mining movement'); },
  });
  agent.attachBot(bot);
  agent.initializeBotRuntime();
  const task = { taskId: 'mining-combat', status: 'running', source: 'deskpet', intent: 'mine_diamond_resource',
    logs: [], startedAt: Date.now(), currentStepIndex: 0, currentStep: 'mine_resource', executionGeneration: 0,
    cancellationToken: new CancellationToken(), plan: { steps: [] } };
  task.movementLease = agent.__testClaimMovementLease('task', task.taskId);
  agent.__testSetReconnectTask(task);
  const assertActive = () => {
    if (agent.__testGetReconnectTask() !== task || task.executionGeneration !== 0) {
      const code = task.status === 'paused' ? 'paused' : 'cancelled';
      throw Object.assign(new Error(code), { code });
    }
    task.cancellationToken.throwIfRequested();
  };
  const navigator = createMiningNavigator({ getBot: () => bot, assertActive,
    movementTimeoutMs: options.movementTimeoutMs || 3000,
    ...(options.navigationOptions || {}),
    goto: (goal) => agent.__testMiningPathfinderGoto(goal),
    checkpoint: (state) => { task.diamondExpedition = { navigation: state }; },
    digBlock: async () => { throw new Error('A pre-cleared checked step must not dig'); },
  });
  let interruption;
  let interruptionError;
  let triggerTimer;
  let triggered = 0;
  const startInterruption = () => {
    // Native threat warnings can already have handled the initially loaded
    // actor before this scheduled hook. Only later declared interruptions
    // spawn another actor; the first hook must not resurrect a killed one.
    if (options.interruptions || triggered > 1) bot.entities[skeleton.id] = skeleton;
    interruption = agent.__testHandleSurvivalCritical('test_checked_route');
    interruption.catch((error) => { interruptionError = error; });
    return interruption;
  };
  if (options.interrupt !== false) bot.on('goal_updated', (goal) => {
    if (!goal || triggered >= (options.interruptions || 1)) return;
    triggered += 1;
    triggerTimer = setTimeout(() => startInterruption(), 20);
  });
  const change = (name, point) => {
    const previous = bot.blockAt(point);
    cells.set(point.floored().toString(), name);
    bot.emit('blockUpdate', previous, bot.blockAt(point));
  };
  t.after(async () => {
    clearInterval(physicsTimer); clearTimeout(triggerTimer);
    agent.__testSetReconnectTask(null); agent.detachBot('manual_disconnect'); agent.dispose();
    if (interruption) await interruption.catch(() => {});
    for (const key of Object.keys(paths)) {
      if (previousEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnvironment[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { bot, agent, task, navigator, attempts, attacks, goals, movementProfiles, messages, change,
    ticks: () => ticks, interruption: () => interruption, interruptionError: () => interruptionError };
}

test('a grounded self-supply camp escapes a creeper before damage using bounded native movement', { timeout: 7000 }, async t => {
  const f = fixture(t, { interrupt: false });
  f.task.materialSupply = { schema: 1, materialSource: 'self_gathered', camp: { anchor: { x: 0, y: 1, z: 0 } } };
  const originalProfile = f.bot.pathfinder.movements;
  f.bot.entities[3] = { id: 3, name: 'creeper', isValid: true, position: new Vec3(7, 1, .5) };
  await f.agent.__testHandleSurvivalCritical('test_idle_camp');
  assert.equal(f.attacks.length, 0);
  assert.ok(f.attempts.length > 0);
  assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[3].position) >= 8.5);
  assert.equal(f.bot.entity.onGround, true);
  assert.equal(f.bot.pathfinder.movements, originalProfile);
  assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
  assert.equal(f.goals.some(goal => goal?.constructor?.name === 'GoalFollow'), false);
  for (const { movements: p } of f.attempts) {
    assert.equal(p.canDig, false); assert.equal(p.allowParkour, false);
    assert.equal(p.allow1by1towers, false); assert.equal(p.scafoldingBlocks.length, 0);
  }
});

test('camp escape cancellation cannot restore a stale movement owner', { timeout: 7000 }, async t => {
  const f = fixture(t, { interrupt: false });
  f.task.materialSupply = { schema: 1, materialSource: 'self_gathered', camp: { anchor: { x: 0, y: 1, z: 0 } } };
  f.bot.entities[3] = { id: 3, name: 'creeper', isValid: true, position: new Vec3(7, 1, .5) };
  const escaping = f.agent.__testHandleSurvivalCritical('test_camp_cancel').then(value => ({ value }), error => ({ error }));
  await until(() => f.attempts.length > 0);
  await f.agent.handleMessage({ type: 'mc_command_cancel' });
  assert.ok((await escaping).error);
  assert.equal(f.agent.__testGetActiveMovementLease(), null);
  const count = f.attempts.length;
  await sleep(100);
  assert.equal(f.attempts.length, count);
  assert.equal(f.attacks.length, 0);
});

test('resource work waits for its own native defense and restores the exact safe profile before fresh decisions', { timeout: 7000 }, async t => {
  const f = fixture(t, { interrupt: false, killAfter: 2, resourceThreat: 'zombie' });
  await f.agent.__testWithHouseResourceWork(async host => {
    const originalProfile = f.bot.pathfinder.movements;
    const defending = f.agent.__testHandleSurvivalCritical('test_resource_interrupt');
    await until(() => f.attacks.length === 1);
    const deadline = Date.now() + 5000;
    const resumed = await host.resumeAfterSurvival(Object.assign(Error('preempted'), { code: 'movement_preempted' }), { deadline, bot: f.bot });
    await defending;
    assert.equal(resumed, true); assert.equal(f.attacks.length, 2);
    assert.equal(f.bot.entities[4], undefined);
    assert.equal(f.bot.pathfinder.movements, originalProfile);
    assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
    assert.equal(f.goals.some(goal => goal?.constructor?.name === 'GoalFollow'), false);
    assert.ok(Date.now() < deadline);
    for (const { movements: p } of f.attacks) { assert.equal(p.canDig, false); assert.equal(p.allowParkour, false); }
  });
});

test('user cancellation during a resource defense wait is never converted into automatic resume', { timeout: 7000 }, async t => {
  const f = fixture(t, { interrupt: false, killAfter: 4, resourceThreat: 'zombie' });
  const running = f.agent.__testWithHouseResourceWork(async host => {
    const defending = f.agent.__testHandleSurvivalCritical('test_resource_cancel').catch(() => {});
    await until(() => f.attacks.length === 1);
    const waiting = host.resumeAfterSurvival(Object.assign(Error('preempted'), { code: 'movement_preempted' }), { deadline: Date.now() + 5000, bot: f.bot });
    const rejected = assert.rejects(waiting, e => /cancelled|paused/.test(e.code));
    await f.agent.handleMessage({ type: 'mc_command_cancel' });
    await rejected;
    await defending;
  });
  await running;
  const attempts = f.attacks.length; await sleep(100); assert.equal(f.attacks.length, attempts);
  assert.equal(f.agent.__testGetActiveMovementLease(), null);
});

test('a late equipment acknowledgement after defense preemption causes fresh recovery without replay', { timeout: 7000 }, async t => {
  const f = fixture(t, { interrupt: false, killAfter: 2, resourceThreat: 'zombie' });
  const original={name:'wooden_pickaxe',type:registry.itemsByName.wooden_pickaxe.id,count:1};
  const sword=f.bot.inventory.items()[0];f.bot.inventory.items=()=>[sword,original];
  let calls = 0, defending;const equipped=[];
  f.bot.equip = async item => {
    calls++;equipped.push(item.name);
    if (calls === 1) {
      defending = f.agent.__testHandleSurvivalCritical('test_late_equip');
      await sleep(40);
    }
    f.bot.heldItem = item; // Explicit offline equipment ACK transaction.
  };
  await f.agent.__testWithHouseResourceWork(async host => {
    let interrupted;
    await assert.rejects(host.equip(original), e => { interrupted = e; return e.code === 'movement_preempted'; });
    assert.ok(interrupted.survivalInterrupt);
    assert.equal(await host.resumeAfterSurvival(interrupted, { deadline: Date.now() + 5000, bot: f.bot }), true);
    await defending;
    assert.equal(equipped.filter(name=>name===original.name).length,1,
      'Original equipment operation is never replayed; defense may re-equip after a late original ACK');
    assert.equal(f.attacks.length, 2);
    assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
  });
});

test('self-supplied house defense between primitive scopes preserves the current profile and never starts a chase', { timeout: 6000 }, async t => {
  const f = fixture(t);
  f.task.materialSupply = { schema: 1, materialSource: 'self_gathered' };
  const profile = f.bot.pathfinder.movements;
  await f.agent.__testHandleSurvivalCritical('test_house_stationary');
  assert.equal(f.attacks.length, 1);
  assert.equal(f.bot.pathfinder.movements, profile);
  assert.equal(f.attempts.length, 0);
  assert.equal(f.goals.some(goal => goal?.constructor?.name === 'GoalFollow'), false);
  assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
});
test('a touching zombie is attacked before chasing a ranged skeleton during house work', {timeout:6000},async t=>{
 const f=fixture(t,{skeletonX:6.5,shield:true});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4]={id:4,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(1.5,1,.5)};
 await f.agent.__testHandleSurvivalCritical('touching_melee_before_ranged');
 assert.deepEqual(f.attacks.map(a=>a.id),[4,2]);assert.equal(f.bot.entities[2],undefined);
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
 assert.equal(f.task.materialSupply.combatMode.resumeStep,f.task.currentStepIndex);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('ordinary distant creeper does not repeatedly preempt armed contact zombie defense', {timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true,killAfter:2});
 f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4].position=new Vec3(7.5,1,.5);
 f.bot.entities[5]={id:5,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(1.5,1,.5)};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('contact_before_distant_creeper'));
 assert.deepEqual(f.attacks.map(a=>a.id),[5,5]);
 assert.equal(f.bot.entities[5],undefined);assert.ok(f.bot.entities[4]);
 assert.equal(f.attempts.length,0);
});

test('known zero-health creeper death animation cannot preempt contact defense',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4].position=new Vec3(2.5,1,.5);
 f.bot.entities[4].metadata[registry.entitiesByName.creeper.metadataKeys.indexOf('health')]=0;
 f.bot.entities[5]={id:5,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(1.5,1,.5)};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('dead_creeper_contact'));
 assert.deepEqual(f.attacks.map(a=>a.id),[5]);assert.equal(f.attempts.length,0);
});

test('creeper entering five meters still preempts ongoing contact defense', {timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true,killAfter:20});
 f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4].position=new Vec3(7.5,1,.5);
 f.bot.entities[5]={id:5,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(1.5,1,.5)};
 const attack=f.bot.attack;f.bot.attack=e=>{attack(e);if(e.id===5)f.bot.entities[4].position=new Vec3(4.5,1,.5);};
 try{await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('closing_creeper_preempts_contact'));}
 catch(error){assert.ok(['movement_preempted','house_surface_defense_threat_remaining'].includes(error.code),error.code);}
 assert.equal(f.attacks[0]?.id,5);assert.equal(f.attacks.filter(a=>a.id===5).length,1);
 assert.ok(f.attempts.length>0,'Closing creeper starts actual native retreat');
 assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
});

for(const [key,value] of [['swell_dir',1],['is_ignited',true],['is_powered',true]])test(`distant ${key} creeper retains priority over contact defense`,{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4].position=new Vec3(7.5,1,.5);
 f.bot.entities[4].metadata[registry.entitiesByName.creeper.metadataKeys.indexOf(key)]=value;
 f.bot.entities[5]={id:5,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(1.5,1,.5)};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('dangerous_creeper_priority'));
 assert.equal(f.attacks.filter(a=>a.id===5).length,0);assert.ok(f.attempts.length>0);
});

for (const resource of ['house_site_cottage', 'any_log']) test(`unarmed ${resource} movement resumes after its actual contact-defense attack is acknowledged`, { timeout: 15000 }, async t => {
  const f = fixture(t, { interrupt: false, resourceThreat: 'zombie' });
  f.task.siteSearch = { kind: 'loaded_natural_house_site_search' };
  f.bot.inventory.items = () => []; f.bot.heldItem = null;
  const result = await f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 }, { resource });
  assert.equal(result.moved, true);
  assert.equal(f.attacks.length, 1);
  assert.equal(f.bot.entities[4], undefined);
  assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
  assert.equal(f.goals.some(goal => goal?.constructor?.name === 'GoalFollow'), false);
  assert.equal(f.bot.entity.onGround, true);
});

test('a checked physical step resumes the same target after bounded stationary self defense', { timeout: 6000 }, async (t) => {
  const f = fixture(t);
  const result = await f.navigator.advance('east');
  assert.equal(f.attacks.length, 1, 'Actual production self-defense invoked the attack primitive');
  assert.equal(f.bot.entities[2], undefined, 'The server-response fixture removed the attacked skeleton');
  assert.equal(f.attempts.length, 2, 'The interrupted native goto is retried exactly once');
  assert.deepEqual(f.attempts.map(({ x, y, z }) => [x, y, z]), [[1, 1, 0], [1, 1, 0]]);
  assert.ok(f.ticks() > 0);
  assert.deepEqual(f.bot.entity.position.floored(), new Vec3(1, 1, 0));
  assert.equal(f.bot.entity.onGround, true);
  assert.equal(result.state.moves, 1);
  assert.equal(result.state.routeIndex, 1);
  assert.equal(f.agent.__testGetActiveMovementLease().token, f.task.movementLease.token);
  assert.equal(f.goals.some((goal) => goal?.constructor?.name === 'GoalFollow'), false, 'Mining self-defense cannot chase a mob');
  // The final profile restores the previous idle profile after checkedMove.
  for (const movements of f.movementProfiles.slice(1, -1)) {
    assert.equal(movements.canDig, false);
    assert.equal(movements.allowParkour, false);
    assert.equal(movements.allow1by1towers, false);
    assert.equal(movements.scafoldingBlocks.length, 0);
  }
});

test('a checked mining step keeps a multi-hit house defense owner until the attacker is gone',{timeout:9000},async t=>{
 const f=fixture(t,{killAfter:4});f.task.materialSupply={materialSource:'self_gathered'};
 const result=await f.agent.__testWithHouseResourceWork(()=>f.navigator.advance('east'));
 assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[2],undefined);
 assert.equal(new Set(f.attacks.map(a=>a.lease)).size,1);
 assert.equal(result.state.moves,1);assert.equal(result.state.routeIndex,1);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.equal(f.interruptionError(),undefined);
});

test('house proximity warning escapes a creeper before damage and resumes the original dry graph leg', { timeout: 10000 }, async t => {
  const f = fixture(t, { interrupt: false, shield:true });
  f.bot.entities[3] = { id: 3, name: 'creeper', type: 'hostile', isValid: true,
    entityType: registry.entitiesByName.creeper.id, height: 1.7, position: new Vec3(-7.5, 1, .5) };
  const dropLimits=[],nativeProbe=f.bot.pathfinder.getPathFromTo;
  f.bot.pathfinder.getPathFromTo=function(movements,...args) {
    dropLimits.push({lease:f.agent.__testGetActiveMovementLease()?.kind,limit:movements.maxDropDown});
    return nativeProbe.call(this,movements,...args);
  };
  const result = await f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 });
  assert.ok(dropLimits.some(p=>p.lease==='survival-critical'));
  assert.ok(dropLimits.filter(p=>p.lease==='survival-critical').every(p=>p.limit<=2),'escape never inherits ordinary survivable-drop permission');
  assert.ok(dropLimits.some(p=>p.lease!=='survival-critical'&&p.limit===6),'ordinary graph retains its explicit floor-bottom permission after handoff');
  assert.equal(result.moved, true);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 2);
  assert.equal(f.attacks.length, 0, 'The production interrupt must escape rather than attack a creeper');
  assert.ok(f.bot.__shieldUses.includes(true),'actual equipped offhand is raised before escape');
  assert.equal(f.bot.health, 20);
  assert.equal(f.bot.entity.onGround, true);
  assert.ok(f.attempts.length >= 3, 'Actual initial navigation, escape and original-leg continuation must run');
  assert.equal(f.bot.entities[3].isValid, true, 'This offline fixture does not fake a kill or despawn');
  assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
});

for(const natural of [false,true])test(`an immediately failed owned creeper escape preserves its cause after releasing its survival lease: natural=${natural}`, { timeout: 6000 }, async t => {
  const f = fixture(t, { interrupt: false, shield:true });
  if(natural){f.task.intent='build_furnished_house';f.task.materialSupply={materialSource:'self_gathered'};}
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 })
    .then(value => ({ value }), error => ({ error }));
  await until(() => f.attempts.length === 1);
  for (let id = 3; id < 20; id++) f.bot.entities[id] = { id, name: 'creeper', type: 'hostile', isValid: true,
    entityType: registry.entitiesByName.creeper.id, height: 1.7, position: new Vec3(-5.5, 1, .5) };
  // A real finite-threat refusal completes in microtasks before the stopped
  // original goto rejects. It must keep that cause without reviving a lease.
  const defense = f.agent.__testHandleSurvivalCritical('test_immediate_creeper_failure');
  await assert.rejects(defense, error => error.code === 'house_creeper_escape_threat_limit');
  assert.equal(f.bot.__shieldActive,true,'owned escape failure keeps the shield raised while its stopped original goal unwinds');
  for (let id = 3; id < 20; id++) delete f.bot.entities[id];
  const outcome = await running;
  assert.equal(outcome.error?.code, 'house_surface_creeper_escape_threat_limit');
  assert.equal(outcome.error?.originCode, 'house_creeper_escape_threat_limit');
  await sleep(100);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attacks.length, 0);
  assert.equal(f.agent.__testGetActiveMovementLease(), null);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
});

test('a replacement actor after immediate defense failure keeps its profile, goal and lease', { timeout: 6000 }, async t => {
  const f = fixture(t, { interrupt: false });
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 })
    .then(value => ({ value }), error => ({ error }));
  await until(() => f.attempts.length === 1);
  for (let id = 3; id < 20; id++) f.bot.entities[id] = { id, name: 'creeper', type: 'hostile', isValid: true,
    entityType: registry.entitiesByName.creeper.id, height: 1.7, position: new Vec3(-5.5, 1, .5) };
  await assert.rejects(f.agent.__testHandleSurvivalCritical('test_fast_failure_foreign'),
    error => error.code === 'house_creeper_escape_threat_limit');
  for (let id = 3; id < 20; id++) delete f.bot.entities[id];
  const lease = f.agent.__testClaimMovementLease('task', 'replacement-after-failure');
  const { Movements, goals: nativeGoals } = require('mineflayer-pathfinder');
  const replacement = new Movements(f.bot), goal = new nativeGoals.GoalBlock(-3, 1, 0);
  f.bot.pathfinder.setMovements(replacement); f.bot.pathfinder.setGoal(goal);
  assert.match((await running).error?.code || '', /movement_preempted/);
  await sleep(100);
  assert.equal(f.bot.pathfinder.movements, replacement);
  assert.equal(f.bot.pathfinder.goal, goal);
  assert.equal(f.agent.__testGetActiveMovementLease(), lease);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
  assert.equal(f.attacks.length, 0);
});

test('replacing only the task cancellation token cannot recover an old defense failure', { timeout: 6000 }, async t => {
  const f = fixture(t, { interrupt: false });
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 })
    .then(value => ({ value }), error => ({ error }));
  await until(() => f.attempts.length === 1);
  for (let id = 3; id < 20; id++) f.bot.entities[id] = { id, name: 'creeper', type: 'hostile', isValid: true,
    entityType: registry.entitiesByName.creeper.id, height: 1.7, position: new Vec3(-5.5, 1, .5) };
  await assert.rejects(f.agent.__testHandleSurvivalCritical('test_fast_failure_token'),
    error => error.code === 'house_creeper_escape_threat_limit');
  for (let id = 3; id < 20; id++) delete f.bot.entities[id];
  f.task.cancellationToken = new CancellationToken();
  assert.match((await running).error?.code || '', /movement_preempted/);
  await sleep(100);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.agent.__testGetActiveMovementLease(), null);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
});

for (const action of ['pause', 'cancel']) test(`public ${action} during self defense cannot restart movement or revive the old lease`, { timeout: 6000 }, async (t) => {
  const f = fixture(t, { killAfter: 2 });
  const running = f.navigator.advance('east').then((value) => ({ value }), (error) => ({ error }));
  await until(() => f.attacks.length === 1);
  await f.agent.handleMessage({ type: `mc_command_${action}` });
  assert.equal((await running).error?.code, action === 'pause' ? 'paused' : 'cancelled');
  await f.interruption().catch(() => {});
  await sleep(250);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attacks.length, 1, 'User control prevents subsequent native attack writes');
  assert.equal(f.navigator.getState().moves, 0);
  assert.equal(f.navigator.getState().routeIndex, 0);
  assert.notEqual(f.agent.__testGetActiveMovementLease()?.token, f.task.movementLease.token);
  assert.equal(f.messages.some((message) => message.type === 'mc_task_event'
    && message.event?.eventType === 'completed'), false);
});

test('low health during self defense prevents a checked mining retry', { timeout: 6000 }, async (t) => {
  const f = fixture(t, { killAfter: 2 });
  const running = f.navigator.advance('east').then((value) => ({ value }), (error) => ({ error }));
  await until(() => f.attacks.length === 1);
  f.bot.health = 5;
  const { error } = await running;
  assert.match(`${error?.code} ${error?.message}`, /low_health|LOW_HEALTH|生命|健康/);
  assert.equal(f.attacks.length,2,'The work low-health error must wait for its active contact defense to finish');
  assert.equal(f.bot.entities[2],undefined);
  await f.interruption().catch(() => {});
  assert.equal(f.attempts.length, 1);
  assert.equal(f.navigator.getState().moves, 0);
});

test('an unrelated movement lease preemption is never treated as self defense', { timeout: 6000 }, async (t) => {
  const f = fixture(t, { interrupt: false });
  const running = f.navigator.advance('east').then((value) => ({ value }), (error) => ({ error }));
  await until(() => f.attempts.length === 1);
  const stranger = f.agent.__testClaimMovementLease('task', 'other-task');
  f.bot.pathfinder.setGoal(null);
  assert.equal((await running).error?.code, 'movement_preempted');
  await sleep(150);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attacks.length, 0);
  assert.equal(f.agent.__testGetActiveMovementLease().token, stranger.token);
  assert.equal(f.navigator.getState().moves, 0);
});

test('the real house surface adapter resumes its exact graph target after stationary self defense', { timeout: 8000 }, async t => {
  const f = fixture(t,{interrupt:false});
  const running=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});running.catch(()=>{});
  await until(()=>f.attempts.length===1);
  // Introduce this one observed mob only once, after the original goal. The
  // former fixture reinserted its killed mob20ms after automatic detection.
  f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(2.5,1,.5)};
  await f.agent.__testHandleSurvivalCritical('single_surface_defense');
  const result = await running;
  assert.equal(result.moved, true);
  assert.equal(f.attacks.length, 1);
  assert.equal(f.attempts.length, 2);
  assert.deepEqual(f.attempts.map(({ x, y, z }) => [x, y, z]), [result.actual, result.actual].map(p => [p.x, p.y, p.z]));
  assert.equal(f.bot.entity.onGround, true);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 2);
  assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
  assert.equal(f.goals.some(goal => goal?.constructor?.name === 'GoalFollow'), false);
  for (const { movements: profile } of [...f.attempts, ...f.attacks]) {
    assert.equal(profile.canDig, false);
    assert.equal(profile.allowParkour, false);
    assert.equal(profile.allow1by1towers, false);
    assert.equal(profile.scafoldingBlocks.length, 0);
  }
});

for (const action of ['pause', 'cancel']) test(`house surface ${action} during self defense cannot resume or credit a node`, { timeout: 6000 }, async t => {
  const f = fixture(t, { killAfter: 2 });
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 }).then(value => ({ value }), error => ({ error }));
  await until(() => f.attacks.length === 1);
  await f.agent.handleMessage({ type: `mc_command_${action}` });
  const outcome = await running;
  assert.match(outcome.error?.code || '', /paused|cancelled/);
  await f.interruption().catch(() => {}); await sleep(150);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attacks.length, 1);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
  assert.notEqual(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
});

test('house surface foreign preemption preserves the replacement actor and never retries', { timeout: 6000 }, async t => {
  const f = fixture(t, { interrupt: false });
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 }).then(value => ({ value }), error => ({ error }));
  await until(() => f.attempts.length === 1);
  const stranger = f.agent.__testClaimMovementLease('task', 'new-surface-owner');
  const { Movements, goals: nativeGoals } = require('mineflayer-pathfinder');
  const replacement = new Movements(f.bot), goal = new nativeGoals.GoalBlock(-3, 1, 0);
  f.bot.pathfinder.setMovements(replacement); f.bot.pathfinder.setGoal(goal);
  assert.match((await running).error?.code || '', /movement_preempted/); await sleep(150);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attacks.length, 0);
  assert.equal(f.agent.__testGetActiveMovementLease(), stranger);
  assert.equal(f.bot.pathfinder.movements, replacement);
  assert.equal(f.bot.pathfinder.goal, goal);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
});

test('a new physical hazard during house self defense closes the pending graph move', { timeout: 6000 }, async t => {
  const f = fixture(t, { killAfter: 2 });
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 }).then(value => ({ value }), error => ({ error }));
  await until(() => f.attacks.length === 1);
  f.change('lava', f.bot.entity.position.floored());
  assert.match((await running).error?.code || '', /dry_graph_hazard|movement_preempted/);
  await f.interruption().catch(() => {}); await sleep(150);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
});

test('a transient lava guard failure cannot leave a delayed survival retry writing another goto', { timeout: 6000 }, async (t) => {
  const f = fixture(t, { killAfter: 2 });
  const running = f.navigator.advance('east').then((value) => ({ value }), (error) => ({ error }));
  await until(() => f.attacks.length === 1);
  const hazard = new Vec3(1, 1, 1);
  f.change('lava', hazard);
  assert.equal((await running).error?.code, 'MINING_FLUID');
  f.change('air', hazard);
  await f.interruption().catch(() => {});
  await sleep(500);
  assert.equal(f.attempts.length, 1, 'A guard-ended move stays ended after the temporary hazard disappears');
  assert.equal(f.navigator.getState().moves, 0);
  assert.equal(f.navigator.getState().routeIndex, 0);
  assert.equal(f.bot.pathfinder.goal, null);
});

test('the original navigation deadline remains active while self defense owns movement', { timeout: 6000 }, async (t) => {
  const f = fixture(t, { movementTimeoutMs: 1000, killAfter: 100 });
  const started = Date.now();
  await assert.rejects(f.navigator.advance('east'), (error) => error.code === 'MINING_MOVEMENT_TIMEOUT');
  assert.ok(Date.now() - started >= 900 && Date.now() - started < 2000,
    'The original navigation timer must not restart after an interruption');
  await f.interruption().catch(() => {});
  await sleep(500);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.navigator.getState().moves, 0);
  assert.equal(f.navigator.getState().routeIndex, 0);
  assert.equal(f.bot.pathfinder.goal, null);
});

test('a single checked step cannot recover more than two survival interruptions', { timeout: 6000 }, async (t) => {
  const f = fixture(t, { interruptions: 3, movementTimeoutMs: 5000 });
  await assert.rejects(f.navigator.advance('east'), (error) => error.code === 'movement_preempted');
  await f.interruption().catch(() => {});
  await sleep(250);
  assert.equal(f.attempts.length, 3, 'The original goto plus two retries is the strict per-step limit');
  assert.ok(f.attacks.length>=2&&f.attacks.length<=3, 'Two successful bounded recoveries; no defense beyond the third refused preemption');
  assert.equal(f.navigator.getState().moves, 0);
  assert.equal(f.navigator.getState().routeIndex, 0);
  assert.equal(f.bot.pathfinder.goal, null);
});

function captureHouseSurfaceDiagnostics(f) {
  const tracePath = path.join(process.env.MC_AGENT_DIAGNOSTICS_DIR, 'house-surface-combat.jsonl');
  f.task.diagnostics = { traceId: 'house-surface-combat', tracePath, startedAt: Date.now(), eventCount: 0 };
  return () => fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

test('house surface original leg deadline closes work while finite self defense retains its owner', { timeout: 12000 }, async t => {
  const f = fixture(t, { killAfter: 100 }), diagnostics = captureHouseSurfaceDiagnostics(f), started = Date.now();
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 }, { legTimeoutMs: 600 })
    .then(value => ({ value }), error => ({ error }));
  await until(() => f.attacks.length === 1);
  const defenseProfile = f.attacks[0].movements,defenseLease=f.attacks[0].lease;
  assert.equal(f.agent.__testGetActiveMovementLease().kind, 'survival-critical');
  const { error } = await running;
  assert.equal(error?.code, 'house_surface_dry_graph_leg_timeout', 'The original deadline reason must survive capability closure');
  assert.ok(Date.now() - started >= 500 && Date.now() - started < 1500, 'Self defense cannot reset the original leg deadline');
  assert.equal(f.agent.__testGetActiveMovementLease().kind, 'survival-critical', 'The original defense still owns its finite action at deadline');
  assert.equal(f.bot.pathfinder.movements, defenseProfile, 'An expired graph must not restore its previous/default profile over defense');
  const failure = diagnostics().find(entry => entry.event === 'house_surface_guard_failure');
  assert.equal(failure.details.code, 'dry_graph_leg_timeout');
  assert.equal(failure.details.observedMovement.trigger, 'deadline');
  assert.ok(['x', 'y', 'z'].every(axis => Number.isFinite(failure.details.observedMovement.position[axis])));
  assert.equal(failure.details.observedMovement.health, 20); assert.equal(failure.details.observedMovement.food, 20);
  // The original timer callback inherits the expired work context. Await
  // the actual defense from this fresh caller before asserting no late writes.
  await f.agent.__testHandleSurvivalCritical('await_actual_finite_defense').catch(() => {});
  const settledAttacks=f.attacks.filter(a=>a.lease===defenseLease).length;await sleep(250);
  assert.equal(f.attempts.length, 1);assert.ok(settledAttacks>=1);
  assert.equal(f.attacks.filter(a=>a.lease===defenseLease).length,settledAttacks,'The expired finite defense owner grants no late writes; fresh proximity defense requires its own lease');
  assert.ok(f.attacks.every(a=>a.lease?.kind==='survival-critical'));
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
  assert.notEqual(f.agent.__testGetActiveMovementLease(), f.task.movementLease);
  assert.equal(diagnostics().some(entry => entry.event === 'house_surface_self_defense_resumed'), false);
});

for (const [field, value] of [['health', 5], ['food', 5]]) test(`house surface ${field}=${value} during self defense cannot resume or credit a node`, { timeout: 6000 }, async t => {
  const f = fixture(t, { killAfter: 2 }), diagnostics = captureHouseSurfaceDiagnostics(f);
  const running = f.agent.__testHouseSurfaceGraphNext({ x: 0, y: 1, z: 0 }).then(result => ({ result }), error => ({ error }));
  await until(() => f.attacks.length === 1); f.bot[field] = value;
  const { error } = await running;
  assert.equal(error?.code, 'house_surface_dry_graph_survival_limit', 'Below-minimum ordinary work cannot resume after completing necessary self defense');
  assert.equal(f.bot[field],value,'The actual depleted health/food stays unchanged; work cannot claim recovery');
  await f.interruption().catch(() => {}); await sleep(150);
  assert.equal(f.attempts.length, 1); assert.equal(f.attacks.length, 2);
  assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits, 1);
  assert.equal(f.agent.__testGetActiveMovementLease(), f.task.movementLease,'Completed defense returns its own lease; below-minimum work remains refused');
  assert.equal(diagnostics().some(entry => entry.event === 'house_surface_self_defense_resumed'), false);
  assert.equal(f.bot.pathfinder.goal,null);assert.ok(Object.values(f.bot.controlState).every(value=>value===false));
});

function prepareHouseResourceGroup(f, second='husk') {
 f.task.intent='build_furnished_house';f.task.materialSupply={materialSource:'self_gathered'};
 if(second)f.bot.entities[5]={id:5,name:second,type:'hostile',entityType:registry.entitiesByName[second].id,position:new Vec3(3.5,1,.5),height:1.95};
}
test('a running safety response survives its ordinary work token becoming automatically paused',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:4});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(1.5,1,.5);
 const generation=f.task.executionGeneration,workToken=f.task.cancellationToken;
 const running=f.agent.__testHandleSurvivalCritical('running_then_work_auto_paused');
 await until(()=>f.attacks.length===1);const safetyLease=f.agent.__testGetActiveMovementLease();
 f.task.status='paused';f.task.automaticSurvivalRecovery=true;workToken.pause();
 await running;
 assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[4],undefined);
 assert.equal(f.task.status,'paused');assert.equal(workToken.pauseRequested,true);assert.equal(f.task.executionGeneration,generation);
 assert.equal(f.attempts.length,0);assert.notEqual(safetyLease,f.task.movementLease);
});
test('an automatically blocked house worker still defends while its work token stays paused',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie'});prepareHouseResourceGroup(f,null);
 f.task.status='paused';f.task.automaticSurvivalRecovery=true;f.task.cancellationToken.pause();f.task.movementLease=null;
 f.bot.entities[4].position=new Vec3(1.5,1,.5);
 await f.agent.__testHandleSurvivalCritical('automatic_blocked_defense');
 assert.equal(f.attacks.length,1);assert.equal(f.task.status,'paused');assert.equal(f.task.cancellationToken.pauseRequested,true);
});
test('resume cannot replace the execution generation or body lease of an active paused safety response',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:3});prepareHouseResourceGroup(f,null);
 f.task.status='paused';f.task.automaticSurvivalRecovery=true;f.task.cancellationToken.pause();f.task.movementLease=null;
 f.bot.entities[4].position=new Vec3(1.5,1,.5);
 const generation=f.task.executionGeneration,token=f.task.cancellationToken;
 const running=f.agent.__testHandleSurvivalCritical('automatic_resume_race');
 await until(()=>f.attacks.length>=1);const lease=f.agent.__testGetActiveMovementLease();
 await assert.rejects(f.agent.handleMessage({type:'mc_command_resume'}),{code:'house_survival_recovery_in_progress'});
 assert.equal(f.task.status,'paused');assert.equal(f.task.executionGeneration,generation);
 assert.equal(f.task.cancellationToken,token);assert.equal(token.pauseRequested,true);
 assert.equal(f.agent.__testGetActiveMovementLease(),lease);
 await running;assert.equal(f.attacks.length,3);assert.equal(f.bot.entities[4],undefined);
});
test('a user pause never borrows the automatic blocked-task survival capability',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie'});prepareHouseResourceGroup(f,null);
 f.task.status='paused';f.task.cancellationToken.pause();f.task.movementLease=null;
 assert.equal(await f.agent.__testHandleSurvivalCritical('manual_pause'),false);assert.equal(f.attacks.length,0);
});
test('automatic paused recovery cannot take a foreign manual lease',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie'});prepareHouseResourceGroup(f,null);
 f.task.status='paused';f.task.automaticSurvivalRecovery=true;f.task.cancellationToken.pause();f.task.movementLease=null;
 const lease=f.agent.__testClaimMovementLease('manual','human');
 assert.equal(await f.agent.__testHandleSurvivalCritical('foreign_manual'),false);assert.equal(f.attacks.length,0);
 assert.equal(f.agent.__testGetActiveMovementLease(),lease);
});
test('public pause revokes an already running automatic safety response',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:6});prepareHouseResourceGroup(f,null);
 f.task.status='paused';f.task.automaticSurvivalRecovery=true;f.task.cancellationToken.pause();f.task.movementLease=null;
 f.bot.entities[4].position=new Vec3(1.5,1,.5);
 const running=f.agent.__testHandleSurvivalCritical('automatic_then_manual').catch(e=>e);
 await until(()=>f.attacks.length>=1);await f.agent.handleMessage({type:'mc_command_pause'});await running;
 const count=f.attacks.length;await sleep(160);assert.equal(f.attacks.length,count);assert.equal(f.task.automaticSurvivalRecovery,false);
});
test('expired outer graph deadline cannot start native movement on a fresh inner budget',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false});
 await assert.rejects(f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(5,1,0),20000,{deadline:Date.now()-1}),{code:'house_surface_movement_timeout'});
 assert.equal(f.attempts.length,0);await sleep(80);assert.equal(f.attempts.length,0);
 assert.equal(f.bot.pathfinder.goal,null);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
for(const name of ['seagrass','tall_seagrass','kelp','kelp_plant','bubble_column']) test(`resource native movements reject ${name} as a dry transit cell`,{timeout:7000},async t=>{
 const f=fixture(t,{interrupt:false});prepareHouseResourceGroup(f,null);
 f.change(name,new Vec3(2,1,0));
 let enteredWet=false;
 f.bot.on('physicsTick',()=>{if(f.bot.entity.position.floored().equals(new Vec3(2,1,0)))enteredWet=true;});
 await f.agent.__testWithHouseResourceWork(async({safeFoot})=>{
  const profile=f.bot.pathfinder.movements,block=f.bot.blockAt(new Vec3(2,1,0));
  assert.equal(safeFoot(new Vec3(2,1,0)),false,'wet cells cannot enter the observed dry return trace');
  assert.equal(safeFoot(new Vec3(0,1,0)),true);
  assert.ok(profile.exclusionAreasStep.some(check=>check(block)===Infinity),'wet plants must be forbidden, not a finite movement cost');
  await f.bot.pathfinder.goto(new(require('mineflayer-pathfinder').goals.GoalBlock)(5,1,0));
 },{deadline:Date.now()+6000});
 assert.equal(enteredWet,false);assert.equal(f.bot.entity.onGround,true);assert.equal(f.attacks.length,0);
 assert.equal(f.bot.entity.position.floored().x,5);
});
test('armed house resource work strikes actual contact then evades two observed melee types', {timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:100});prepareHouseResourceGroup(f);
 const original=f.task.movementLease;
 const result=await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('resource_group_test'),{deadline:Date.now()+8000});
 assert.equal(result,true);assert.equal(f.attacks.length,1);assert.ok(f.attempts.length>0);
 // Current bounded melee policy keeps the primary at6.5m and the second
 // observed contact threat at4.5m, unlike the creeper's8.5m requirement.
 for(const [id,minimum] of [[4,6.5],[5,4.5]])assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[id].position)>=minimum);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.agent.__testGetActiveMovementLease(),original);assert.equal(f.goals.some(g=>g?.constructor?.name==='GoalFollow'),false);
});
test('house resource creeper proximity uses its original bounded frame before stationary attack', {timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper'});prepareHouseResourceGroup(f,null);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('resource_creeper_test'),{deadline:Date.now()+8000});
 assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);assert.equal(f.bot.entity.onGround,true);
});
test('house food work with no resource deadline still uses finite creeper escape instead of stationary fighting',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper'});prepareHouseResourceGroup(f,null);f.task.intent='hunt_food';
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('food_scope_creeper'));
 assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
test('a healthy equipped house bot strikes once then actually retreats instead of waiting for four stationary swings',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true,killAfter:4});prepareHouseResourceGroup(f,null);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('creeper_knockback_test'));
 assert.equal(f.attacks.length,1);assert.ok(f.bot.entities[4]);assert.ok(f.attempts.length>=1);
 assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
 assert.ok(f.attacks[0].position.distanceTo(new Vec3(2.5,1,.5))<=3);
 assert.ok(f.bot.__shieldUses.length>=2);
});
test('foreground food failure waits for its captured creeper escape before pausing the task',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper'});prepareHouseResourceGroup(f,null);
 f.task.plan={steps:[{skill:'build_furnished_house_phase',args:{schema:2,profile:'cottage',phase:'prepare_materials',materialSource:'self_gathered'}}]};let defense;
 await f.agent.__testRunTaskExecution(f.task,{executeStep:async()=>f.agent.__testWithHouseResourceWork(async()=>{
   defense=f.agent.__testHandleSurvivalCritical('food_failure_race');defense.catch(()=>{});await until(()=>f.attempts.length>0);
   throw Object.assign(Error('Food reserve exhausted'),{code:'house_food_reserve_missing'});
 })});
 await defense;assert.equal(f.task.status,'paused');assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
 assert.equal(f.attacks.length,0);
});
test('confirmed native escape stop after earlier movement recoveries settles without another recovery', {timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper'});prepareHouseResourceGroup(f,null);
 // Whole35: prior unreachable canopy targets had already raised the recovery
 // counter. A deliberate GoalChanged then incorrectly entered the 360ms hard
 // reset, exceeding the escape's 250ms native-settlement check.
 f.task.physicalRecoveryCount=3;
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('whole35_expected_escape_stop'),{deadline:Date.now()+8000});
 assert.equal(f.task.physicalRecoveryCount,3);
 assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
 assert.equal(f.bot.pathfinder.goal,null);assert.equal(f.bot.entity.onGround,true);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
test('expired resource work budget cannot enter the callback or start a fresh escape capability',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie'});prepareHouseResourceGroup(f);let entered=false;
 await assert.rejects(f.agent.__testWithHouseResourceWork(()=>{entered=true;},{deadline:Date.now()-1}),{code:'house_resource_leg_limit'});
 assert.equal(entered,false);assert.equal(f.attempts.length,0);assert.equal(f.attacks.length,0);
});
test('pause during a real armed resource-group escape prevents a later goal or resource mutation', {timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:2});prepareHouseResourceGroup(f);let paused=false;
 f.bot.entities[4].position=new Vec3(3.5,1,.5);
 f.bot.on('physicsTick',()=>{if(!paused&&f.bot.entity.position.x<-.5){paused=true;f.task.cancellationToken.pause();}});
 await assert.rejects(f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('resource_group_pause'),{deadline:Date.now()+8000,gatheringHouse:true}),e=>e.code==='paused'||e.code==='cancelled');
 const attempts=f.attempts.length,attacks=f.attacks.length;await sleep(100);assert.equal(paused,true);assert.equal(f.attempts.length,attempts);assert.equal(f.attacks.length,attacks);
 assert.equal(f.bot.pathfinder.goal,null);assert.ok(Object.values(f.bot.controlState).every(value=>value===false));
});

test('a foreign lease adopting the exact escape goal keeps its profile, goal and controls during old cleanup', {timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:2});prepareHouseResourceGroup(f);let adopted,profile,foreign=false;
 f.bot.entities[4].position=new Vec3(3.5,1,.5);
 f.bot.on('physicsTick',()=>{if(!foreign&&f.bot.entity.position.x<-.5){foreign=true;adopted=f.bot.pathfinder.goal;profile=f.bot.pathfinder.movements;f.agent.__testClaimMovementLease('manual','adopted_escape_goal');}});
 await assert.rejects(f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('resource_group_foreign'),{deadline:Date.now()+8000}),e=>e.code==='cancelled'||e.code==='movement_preempted'||e.code==='house_creeper_escape_preempted');
 assert.equal(foreign,true);assert.equal(f.bot.pathfinder.goal,adopted);assert.equal(f.bot.pathfinder.movements,profile);assert.ok(Object.values(f.bot.controlState).some(Boolean));
 const attempts=f.attempts.length;await sleep(60);assert.equal(f.attempts.length,attempts);assert.equal(f.attacks.length,1,'One contact knockback precedes escape; foreign takeover receives no later attack');
});

test('host physical action admits an expected drop stop and resumes only after native grounded landing',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false}),data=require('../test-support/whole55-saved-drop-braking.json'),b=data.bounds,
  start={x:476,y:66,z:278},target={x:473,y:64,z:282},key=p=>`${p.x},${p.y},${p.z}`;
 // This is initial fixture setup before its first physics tick, not a move.
 f.bot.entity.position=new Vec3(476.5,66,278.5);f.bot.entity.velocity=new Vec3(0,0,0);
 f.bot.blockAt=raw=>{const p=raw.floored();
  if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const i=((p.x-b.minX)*(b.maxY-b.minY+1)+(p.y-b.minY))*(b.maxZ-b.minZ+1)+(p.z-b.minZ),s=data.palette[data.indices[i]];
  return Object.assign(Block.fromProperties(registry.blocksByName[s.name.replace(/^minecraft:/,'')].id,s.properties,0),{position:p});
 };
 f.task.materialSupply={schema:1,profile:'cottage',materialSource:'self_gathered',surfaceGraphs:{any_log:{schema:2,kind:'loaded_dry_waypoint_graph',anchor:start,step:16,radius:384,
  nodes:{[key(start)]:{position:start,parent:null,expanded:true},[key(target)]:{position:target,parent:key(start),expanded:true}},
  order:[key(start),key(target)],current:key(start),resumeNode:key(start),visits:2,probes:0,frontier:[],blockedEdges:[]}}};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 const result=await f.agent.__testHouseSurfaceGraphNext(start,{legTimeoutMs:6000,observedNode:{nodeId:key(target),position:target}});
 assert.equal(result.confirmed,true);assert.deepEqual(result.actual,target);
 const landings=diagnostics().filter(v=>v.event==='house_surface_controlled_drop_landed');
 assert.equal(landings.length,1);assert.equal(landings[0].details.actualGrounded,true);
 assert.ok(f.attempts.length>=2);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits,2);
});

test('surface defense physically closes ranged melee distance before attacking and resumes the same graph goal',{timeout:10000},async t=>{
 const f=fixture(t,{skeletonX:4.5});
 const result=await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});
 assert.equal(result.moved,true);assert.equal(f.attacks.length,1);assert.equal(f.bot.entities[2],undefined);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.ok(f.goals.some(g=>g?.constructor?.name==='GoalNear'));
 assert.ok(f.attacks[0].position.distanceTo(new Vec3(4.5,1,.5))<=3,'Attack must occur only after physical closing');
});

test('pause during the bounded surface melee approach prevents attacks and graph credit',{timeout:8000},async t=>{
 const f=fixture(t,{skeletonX:4.5});let paused=false;
 f.bot.on('goal_updated',goal=>{if(goal?.constructor?.name==='GoalNear'&&!paused){paused=true;void f.agent.handleMessage({type:'mc_command_pause'});}});
 await assert.rejects(f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0}));
 assert.equal(paused,true);assert.equal(f.attacks.length,0);assert.equal(f.task.materialSupply.surfaceGraphs.any_log.visits,1);
});

test('surface shield defense uses actual offhand between bounded melee strikes',{timeout:10000},async t=>{
 const f=fixture(t,{shield:true,killAfter:2});const result=await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});
 assert.equal(result.moved,true);assert.equal(f.attacks.length,2);assert.ok(f.bot.__shieldUses.length>=1);assert.ok(f.bot.__shieldUses.every(v=>v===true));
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

for(const step of [0,-1,1])test(`armed house detects a twelve-meter skeleton and uses checked ${step<0?'one-block descent':step>0?'one-block ascent':'flat'} approach before actual close strikes`,{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2});
 f.task.materialSupply={materialSource:'self_gathered'};
 if(step)for(let x=4;x<=18;x++)for(let z=-3;z<=3;z++)f.change(step>0?'stone':'air',new Vec3(x,step>0?1:0,z));
 const running=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});running.catch(()=>{});
 await until(()=>f.attempts.length===1);
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(12.5,1+step,.5)};
 await f.agent.__testHandleSurvivalCritical('observed_twelve_meter_ranged_threat');
 const result=await running;
 assert.equal(result.moved,true);assert.equal(f.attacks.length,2);assert.ok(f.bot.__shieldUses.includes(true));
 assert.ok(f.attacks.every(a=>a.position.distanceTo(new Vec3(12.5,1+step,.5))<=3));
 assert.ok(f.attacks.every(a=>Math.hypot(a.position.x-.5,a.position.z-.5)<=12.05));
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('pause during twelve-meter ranged approach stops further native steps and attacks',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true});f.task.materialSupply={materialSource:'self_gathered'};
 const running=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});running.catch(()=>{});
 await until(()=>f.attempts.length===1);f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(12.5,1,.5)};
 const defense=f.agent.__testHandleSurvivalCritical('twelve_meter_pause');defense.catch(()=>{});
 await until(()=>f.attempts.length>=3);f.task.status='paused';f.task.cancellationToken.pause();
 await assert.rejects(defense);await assert.rejects(running);const attempts=f.attempts.length;
 await sleep(100);assert.equal(f.attacks.length,0);assert.equal(f.attempts.length,attempts);
});

test('sixteen-meter ranged detection can actually close into reach and perform four sword strikes',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:4});f.task.materialSupply={materialSource:'self_gathered'};
 const target=new Vec3(16.5,1,.5);
 const running=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});running.catch(()=>{});await until(()=>f.attempts.length===1);
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:target};
 await f.agent.__testHandleSurvivalCritical('sixteen_meter_ranged');const result=await running;
 assert.equal(result.moved,true);assert.equal(f.attacks.length,4);assert.ok(f.attacks.every(a=>a.position.distanceTo(target)<=3));
 assert.ok(f.attacks.every(a=>Math.hypot(a.position.x-.5,a.position.z-.5)<=20.05));
});

for(const armed of [false,true])test(`material exploration respects its ranged combat budget instead of walking back into archer range: armed=${armed}`,{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 if(armed)f.bot.health=8;else{f.bot.inventory.items=()=>[];f.bot.heldItem=null;}
 const enemy={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(28.5,1,.5)};
 f.bot.entities[2]=enemy;let closest=Infinity;
 const observe=()=>{closest=Math.min(closest,f.bot.entity.position.distanceTo(enemy.position));};
 f.bot.on('physicsTick',observe);t.after(()=>f.bot.removeListener('physicsTick',observe));
 let result;try{result=await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});}
 catch(error){t.diagnostic(JSON.stringify({code:error.code,actual:f.bot.entity.position,leg:error.observedDryLeg,attempts:f.attempts.map(({x,y,z})=>({x,y,z})),graph:f.task.materialSupply.surfaceGraphs}));throw error;}
 assert.equal(result.moved,true);assert.ok(closest>=15.4);assert.ok(f.bot.entity.position.distanceTo(enemy.position)>16);
 assert.equal(f.attacks.length,0);
});

test('a real unarmed out-of-range retreat is accepted without resuming movement back into archer range',{timeout:30000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 const enemy={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(20.5,1,.5)};
 f.bot.entities[2]=enemy;
 let hurt=false;const trigger=()=>{if(!hurt&&f.bot.pathfinder.goal){hurt=true;f.bot.emit('entityHurt',f.bot.entity);}};
 f.bot.on('physicsTick',trigger);t.after(()=>f.bot.removeListener('physicsTick',trigger));
 try { await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0}); }
 catch(error) { assert.ok(['house_surface_dry_graph_native_no_path','house_surface_dry_graph_probe_inconclusive'].includes(error.code),error.code); }
 assert.ok(f.bot.entity.position.distanceTo(enemy.position)>16);assert.equal(f.attacks.length,0);
 const trace=fs.readFileSync(f.task.diagnostics.tracePath,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(trace.some(d=>d.event==='house_surface_self_defense_resumed'));
 assert.equal(trace.some(d=>d.details?.code==='house_surface_defense_unconfirmed'),false);
});

test('an armed survivor with no loaded creeper exit keeps striking within cooldown instead of stopping after one hit',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',killAfter:4});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4].position=new Vec3(2.5,1,.5);
 for(let y=1;y<=2;y++){
  for(let x=-1;x<=3;x++){f.change('stone',new Vec3(x,y,-1));f.change('stone',new Vec3(x,y,1));}
  f.change('stone',new Vec3(-1,y,0));f.change('stone',new Vec3(3,y,0));
 }
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('creeper_no_exit_contact'));
 assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[4],undefined);
 assert.ok(f.attacks.every(a=>a.position.distanceTo(new Vec3(.5,1,.5))<.2));
 for(let i=1;i<f.attacks.length;i++)assert.ok(f.attacks[i].at-f.attacks[i-1].at>=600);
});

test('the first native hurt event starts an unshielded18HP skeleton engagement without another hit or a manual defense call',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(18.5,1,.5)};
 f.bot.health=18;
 const hurtAt=Date.now();f.bot.emit('entityHurt',f.bot.entity);
 await until(()=>diagnostics().some(e=>e.event==='house_ranged_target_locked'),1000);
 const lock=diagnostics().find(e=>e.event==='house_ranged_target_locked').details;
 assert.equal(lock.trigger,'entity_hurt');assert.equal(lock.decision,'engage');assert.equal(lock.shield,false);
 assert.ok(lock.damageResponseMs<1000);assert.ok(Date.now()-hurtAt<1000);
 await until(()=>f.attacks.length===2,15000);
 assert.equal(f.bot.entities[2],undefined);assert.ok(f.attacks.every(a=>a.position.distanceTo(new Vec3(18.5,1,.5))<=3));
 await until(()=>f.agent.__testGetActiveMovementLease()===f.task.movementLease);
});

for(const remainingHealth of [16,11])test(`ranged approach takes verified cover after its actual cumulative damage budget: ${remainingHealth}`, {timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 for(let z=2;z<=8;z++)for(let y=1;y<=2;y++)f.change('stone',new Vec3(4,y,z));
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(20.5,1,.5)};
 let injured=false,shieldAtInjury=false;
 const hurt=()=>{if(!injured&&f.bot.entity.position.x>1.2){injured=true;shieldAtInjury=f.bot.__shieldActive===true;f.bot.health=remainingHealth;}};
 f.bot.on('physicsTick',hurt);t.after(()=>f.bot.removeListener('physicsTick',hurt));
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('actual_damage_ranged');});
 assert.equal(injured,true);assert.equal(shieldAtInjury,true);assert.equal(f.attacks.length,0);
 assert.equal(require('../vendor/server/minecraft/houseRangedCover').rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),true);
 assert.equal(f.bot.health,remainingHealth);
});

test('twenty-two-meter skeleton is locked before the old16m gate and physically approached with a sword',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 const target=new Vec3(22.5,1,.5);f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:target};
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('twenty_two_meter_ranged');});
 assert.equal(f.attacks.length,2);assert.ok(f.attacks.every(a=>a.position.distanceTo(target)<=3));
 assert.ok(f.attacks.every(a=>Math.hypot(a.position.x-.5,a.position.z-.5)<=28.05));
});

test('armed ranged defense climbs three actual one-block terrain steps instead of looping on a flat-height gate',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 for(let x=1;x<=10;x++)for(let z=-2;z<=2;z++)for(let y=1;y<=Math.min(Math.ceil(x/2),3);y++)f.change('stone',new Vec3(x,y,z));
 const target=new Vec3(8.5,4,.5);f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:target};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('three_step_terrain_ranged'));
 assert.equal(f.attacks.length,2);assert.ok(f.bot.entity.position.y>=3);
 assert.ok(f.attacks.every(a=>a.position.distanceTo(target)<=3));
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('an expiring ordinary resource budget does not truncate a started independent contact defense',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'spider',killAfter:4});f.task.materialSupply={materialSource:'self_gathered'};
 const deadline=Date.now()+1000;
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('independent_contact_budget'),{deadline});
 assert.equal(f.attacks.length,4);assert.ok(Date.now()>deadline);
 assert.equal(f.bot.entities[4],undefined);assert.equal(f.attempts.length,0);
});

test('an armed noPath approach switches to real cover within the same owner instead of returning to work',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 for(let z=2;z<=8;z++)for(let y=1;y<=2;y++)f.change('stone',new Vec3(4,y,z));
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(20.5,1,.5)};
 const original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);let approaches=0;
 f.bot.pathfinder.getPathFromTo=(profile,from,goal,options)=>{
  if(goal.constructor.name==='GoalNear'){approaches++;return(function*(){yield* [];return{result:{status:'noPath',path:[]}};})();}
  return original(profile,from,goal,options);
 };
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('blocked_armed_ranged');});
 assert.equal(approaches,1);assert.equal(f.attacks.length,0);
 assert.equal(require('../vendor/server/minecraft/houseRangedCover').rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),true);
});

test('a skeleton already inside actual hitbox reach is struck without requesting a closer path',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:1});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(3.7,1,.5)};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('actual_hitbox_ranged'));
 assert.equal(f.attacks.length,1);assert.equal(diagnostics().some(e=>e.event==='house_ranged_approach_plan'),false);
});

test('unarmed field wood exploration uses the native observed graph without replacing camp resource routes',{timeout:15000},async t=>{
 const f=fixture(t,{interrupt:false});f.bot.entities={};f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 const legacy={retained:{schema:'original camp route'}};
 f.task.materialSupply={materialSource:'self_gathered',surfaceGraphs:legacy};let graph=null;
 const outcome=await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0},{resource:'house_field_wood',
  assertGraphActive:()=>f.task.cancellationToken.throwIfRequested(),graphCheckpoint:{get:()=>graph,save:value=>{graph=value;}}});
 assert.equal(outcome.moved,true);assert.ok(f.ticks()>0);assert.ok(graph.order.length>1);
 assert.deepEqual(f.task.materialSupply.surfaceGraphs,legacy);assert.equal(f.task.materialSupply.activeSurfaceGraph,undefined);
 assert.equal(graph.current,`${Math.floor(f.bot.entity.position.x)},${Math.floor(f.bot.entity.position.y)},${Math.floor(f.bot.entity.position.z)}`);
});

for(const shield of [false,true])test(`unarmed survivor locks a distant skeleton and moves behind observed collision cover without attacking: shield ${shield}`,{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield});f.task.materialSupply={materialSource:'self_gathered'};
 const diagnostics=captureHouseSurfaceDiagnostics(f);let firstCover;
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 for(let z=2;z<=8;z++)for(let y=1;y<=2;y++)f.change('stone',new Vec3(4,y,z));
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(20.5,1,.5)};
 const {rangedCoverConfirmed}=require('../vendor/server/minecraft/houseRangedCover');
 assert.equal(rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),false);
 const observeCover=()=>{if(Object.values(f.bot.controlState).some(Boolean))assert.equal(f.bot.__shieldActive===true,false,'A native retreat cannot keep the backwards-facing shield movement penalty');if(!firstCover&&f.bot.entity.onGround&&rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]))firstCover=f.bot.entity.position.floored();};
 f.bot.on('physicsTick',observeCover);
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('unarmed_ranged_cover');});
 f.bot.removeListener('physicsTick',observeCover);
 assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>1);
 assert.equal(rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),true);
 const planned=diagnostics().find(e=>e.event==='house_ranged_cover_planned').details.target;
 const observed=diagnostics().find(e=>e.event==='house_ranged_cover_observed').details;
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(planned.x,planned.y,planned.z));
 assert.equal(observed.retreatArrivalConfirmed,true);
 assert.ok(firstCover);assert.notDeepEqual(firstCover,f.bot.entity.position.floored(),'First temporary obstruction is not the completed retreat');
});

test('concurrent development recovery waits for the same active ranged defense instead of invalidating its movement owner',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(12.5,1,.5)};
 await f.agent.__testWithHouseResourceWork(async()=>{
  const defense=f.agent.__testHandleSurvivalCritical('first_ranged_owner');
  const recovery=f.agent.__testHandleSurvivalCritical('recovery_waits_same_owner');
  await Promise.all([defense,recovery]);
  assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 });
 assert.equal(f.attacks.length,2);
});
test('unarmed resource worker actually leaves a close drowned instead of waiting outside punching reach',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false});prepareHouseResourceGroup(f,null);f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 f.bot.entities[2]={id:2,name:'drowned',type:'hostile',isValid:true,entityType:registry.entitiesByName.drowned.id,height:1.99,position:new Vec3(4,1,.5)};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('unarmed_drowned_retreat'));
 assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>.5);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[2].position)>=4.5);
 const attempts=f.attempts.length;assert.equal(await f.agent.__testHandleSurvivalCritical('already_outside_contact'),false);assert.equal(f.attempts.length,attempts);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
test('installed goto resolving an empty native noPath never grants physical arrival',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false});
 for(let x=-1;x<=1;x++)for(let z=-1;z<=1;z++)if(x||z)for(let y=1;y<=4;y++)f.change('stone',new Vec3(x,y,z));
 await assert.rejects(f.agent.__testWithHouseResourceWork(()=>f.agent.__testMiningPathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(5,1,0))),{code:'NoPath'});
 assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))<.1);
});

test('recovering armed survivor may use one controlled creeper strike; charged entity falls back to retreat',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true,killAfter:4});prepareHouseResourceGroup(f,null);f.bot.health=14;
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('recovering_creeper_strike'));
 assert.equal(f.attacks.length,1);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
});
test('charged creeper contact uses one emergency strike without deliberate-combat eligibility',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true,killAfter:4});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].metadata[registry.entitiesByName.creeper.metadataKeys.indexOf('is_powered')]=true;
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('charged_creeper'));
 assert.equal(f.attacks.length,1);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
});

test('pinned native sparse boolean defaults permit an ordinary creeper strike, explicit charged flag still wins',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true,killAfter:4});prepareHouseResourceGroup(f,null);
 const metadata=f.bot.entities[4].metadata,keys=registry.entitiesByName.creeper.metadataKeys;
 delete metadata[keys.indexOf('is_powered')];delete metadata[keys.indexOf('is_ignited')];
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('native_sparse_creeper'));
 assert.equal(f.attacks.length,1);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
});

test('new creeper preempts an ongoing spider defense under the same lease before another ordinary swing',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'spider',shield:true,killAfter:20});prepareHouseResourceGroup(f,null);
 const originalAttack=f.bot.attack;
 f.bot.attack=target=>{
  originalAttack(target);
  if(target.name==='spider')f.bot.entities[8]={id:8,name:'creeper',type:'hostile',isValid:true,
    entityType:registry.entitiesByName.creeper.id,position:f.bot.entity.position.offset(-4.5,0,0),metadata:[],height:1.7};
 };
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('spider_then_creeper'));
 assert.equal(f.attacks.filter(x=>x.id===4).length,1,'No second ordinary attack after the new urgent threat');
 assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[8].position)>=8.5);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('an already reserved house site cannot treat an unarmed recovery journey as a new-site flee loop',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'spider',killAfter:1});prepareHouseResourceGroup(f,null);
 f.task.siteSearch={kind:'loaded_natural_house_site_search',reservation:{houseAnchor:{x:0,y:1,z:0}}};
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.entities[4].position=new Vec3(7.5,1,.5);
 await f.agent.__testWithHouseResourceWork(async()=>{
   assert.equal(await f.agent.__testHandleSurvivalCritical('reserved_site_unarmed_recovery'),false);
 });
 assert.equal(f.attacks.length,0);assert.equal(f.attempts.length,0);
});

test('production defense can hit a wide jumping spider whose feet exceed3m while its actual hitbox remains within reach',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'spider',killAfter:1});prepareHouseResourceGroup(f,null);
 const spider=f.bot.entities[4];spider.position=new Vec3(3.8,2,.5);spider.width=1.4;spider.height=.9;
 assert.ok(f.bot.entity.position.distanceTo(spider.position)>3);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('jumping_spider_hitbox'));
 assert.equal(f.attacks.length,1);assert.equal(f.bot.entities[4],undefined);assert.equal(f.attempts.length,0);
});

test('empty-handed hurt survivor sends one immediate close creeper strike then physically escapes',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',killAfter:99});prepareHouseResourceGroup(f,null);
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.health=5;f.bot.entities[4].position.x=2.5;
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('emergency_unarmed_creeper'));
 assert.equal(f.attacks.length,1);assert.ok(f.bot.entities[4]);assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('paused underwater survivor retains native upward buoyancy after cleared movement controls',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 for(let x=-4;x<=4;x++)for(let z=-4;z<=4;z++)for(let y=0;y<=2;y++)f.change('water',new Vec3(x,y,z));
 f.task.status='paused';f.task.cancellationToken.pause();f.bot.clearControlStates();
 assert.equal(f.bot.blockAt(f.bot.entity.position.offset(0,1.62,0)).name,'water');
 await until(()=>f.bot.blockAt(f.bot.entity.position.offset(0,1.62,0)).name==='air',3000);
 assert.equal(f.task.status,'paused');assert.ok(f.bot.entity.position.y>1.38);
 assert.equal(f.bot.getControlState?.('forward')??f.bot.controlState.forward,false);
 assert.equal(f.attacks.length,0);assert.equal(f.attempts.length,0);
 // Model another task timeout clearing controls while still wet: the reflex
 // must reapply native flotation on the next real physics observation.
 f.bot.clearControlStates();await sleep(100);assert.equal(f.bot.controlState.jump,true);
});

test('development recovery surface entry restores the captured dry profile after a nested navigator',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 await f.agent.__testWithHouseResourceWork(async()=>{
  const captured=f.bot.pathfinder.movements;
  const nested=new(require('mineflayer-pathfinder').Movements)(f.bot);f.bot.pathfinder.setMovements(nested);
  await f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(2,1,0),3000);
  assert.equal(f.attempts.length,1);assert.equal(f.attempts[0].movements,captured);
  assert.equal(captured.canDig,false);assert.equal(captured.allowParkour,false);assert.equal(captured.scafoldingBlocks.length,0);
  assert.equal(Math.floor(f.bot.entity.position.x),2);
 });
});

test('missed braking observations cannot leave an actually settled survivor idle beside a creeper',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4]={id:4,name:'creeper',type:'hostile',isValid:true,entityType:registry.entitiesByName.creeper.id,position:new Vec3(7,1,.5),height:1.7};
 // Initial native momentum plus a gap in event delivery. Original Physics
 // continues changing actual position/velocity; no projected state is applied.
 f.bot.entity.velocity.x=-.11781015234537406;
 const emit=f.bot.emit,until=Date.now()+1050;
 f.bot.emit=function(name,...args){if(name==='physicsTick'&&Date.now()<until)return false;return emit.call(this,name,...args);};
 const began=Date.now();
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('missed_braking_observations'));
 assert.ok(Date.now()-began>=1000);assert.ok(Date.now()-began<8000);
 assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=8.5);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('a shielded stone-sword survivor closes a near zombie on a one-block lower ledge instead of idling through its defense budget',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:4});prepareHouseResourceGroup(f,null);f.bot.health=14;
 for(let x=3;x<=7;x++)for(let z=-2;z<=2;z++)f.change('air',new Vec3(x,0,z));
 f.bot.entities[4]={id:4,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(4.5,0,.5)};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('near_zombie_lower_ledge'));
 if(f.attacks.length!==4)t.diagnostic(JSON.stringify({actual:f.bot.entity.position,task:f.agent.__testGetReconnectTask()?.materialSupply,events:diagnostics().map(e=>({event:e.event,details:e.details}))}));
 assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[4],undefined);
 assert.ok(f.attacks.every(a=>Math.hypot(a.position.x-.5,a.position.z-.5)<=3.05));
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('a new contact zombie preempts the old near target during checked approach without resetting the defense budget',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2});prepareHouseResourceGroup(f,null);f.bot.health=14;
 f.bot.entities[4]={id:4,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(4.5,1,.5)};
 const diagnostics=captureHouseSurfaceDiagnostics(f);let appeared=false;
 const appear=()=>{if(!appeared&&f.bot.entity.position.x>.6){appeared=true;f.bot.entities[7]={id:7,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:f.bot.entity.position.offset(.8,0,0)};}};
 f.bot.on('physicsTick',appear);t.after(()=>f.bot.removeListener('physicsTick',appear));
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('contact_preempts_approach'));
 assert.equal(appeared,true);assert.deepEqual(f.attacks.slice(0,2).map(a=>a.id),[7,7]);assert.ok(f.attacks.slice(2).every(a=>a.id===4));
 const retarget=diagnostics().find(e=>e.event==='survival_threat_escalated');assert.equal(retarget.details.threatId,7);
 assert.ok(retarget.details.originalDeadline);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('a failed exit retains one defense until the observed approaching drowned enters real attack reach',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'drowned',killAfter:2});prepareHouseResourceGroup(f,null);f.bot.health=2;
 const enemy=f.bot.entities[4];enemy.position=new Vec3(4.5,1,.5);
 for(let x=-1;x<=5;x++)for(let y=1;y<=3;y++){f.change('stone',new Vec3(x,y,-1));f.change('stone',new Vec3(x,y,1));}
 for(let y=1;y<=3;y++){f.change('stone',new Vec3(-1,y,0));f.change('stone',new Vec3(5,y,0));}
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(async()=>{
  let finished=false;const defense=f.agent.__testHandleSurvivalCritical('approaching_drowned_no_exit').finally(()=>finished=true);
  await until(()=>diagnostics().some(d=>d.event==='house_contact_defense_no_retreat'));
  await sleep(150);assert.equal(finished,false);assert.equal(f.attacks.length,0);
  enemy.position=new Vec3(2.5,1,.5);await defense;
  assert.equal(f.attacks.length,2);assert.equal(f.bot.entities[4],undefined);
  assert.equal(diagnostics().filter(d=>d.event==='house_contact_defense_no_retreat').length,1);
 });
});

test('unarmed low-health survivor boxed by loaded dry walls fights its contact attacker instead of idling on noPath',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:4});prepareHouseResourceGroup(f,null);
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.health=5;f.bot.entities[4].position=new Vec3(.9,1,.5);
 for(let x=-1;x<=1;x++)for(let z=-1;z<=1;z++)if(x||z)for(let y=1;y<=3;y++)f.change('stone',new Vec3(x,y,z));
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('boxed_unarmed_contact'));
 assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[4],undefined);
 assert.ok(f.attacks.every((a,i)=>!i||a.at-f.attacks[i-1].at>=250));
 assert.equal(f.goals.some(goal=>goal?.constructor?.name==='GoalFollow'),false);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

// Original installed physics/pathfinder, no position writes after setup.
test('unexpected immersion uses native loaded shore egress rather than waiting for dry support',{timeout:15000},async t=>{
 const f=fixture(t,{interrupt:false});f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++)f.change('water',new Vec3(x,1,z));
 await sleep(80);assert.equal(f.bot.entity.isInWater,true);
 const {escapeEmergencyShore}=require('../vendor/server/minecraft/houseEmergencyShore');
 const {Movements,goals}=require('mineflayer-pathfinder');
 const {dryFoot,hasGroundedBodySupport}=require('../vendor/server/minecraft/houseSurfaceGraph');
 const old=f.bot.pathfinder.movements,events=[];
 await escapeEmergencyShore({getBot:()=>f.bot,Vec3,Movements,GoalBlock:goals.GoalBlock,
  assertActive:()=>f.task.cancellationToken.throwIfRequested(),isDryFoot:p=>dryFoot(f.bot,p),isGrounded:()=>hasGroundedBodySupport(f.bot),
  goto:(g)=>f.bot.pathfinder.goto(g),record:type=>events.push(type)});
 assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(f.bot.entity.isInWater,false);
 assert.ok(Math.abs(f.bot.entity.position.x)>2||Math.abs(f.bot.entity.position.z)>2);
 assert.equal(f.bot.pathfinder.movements,old);assert.ok(events.includes('house_emergency_shore_confirmed'));
});

test('ranged defense recenters a genuinely supported body whose floored column is an air gap',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2,startPosition:{x:.9,y:1,z:.5}});
 prepareHouseResourceGroup(f,null);f.change('air',new Vec3(0,0,0));
 const {hasGroundedBodySupport,naturalWalkingFoot}=require('../vendor/server/minecraft/houseSurfaceGraph');
 await sleep(80);assert.equal(hasGroundedBodySupport(f.bot),true);assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),false);
 f.bot.entities[4]={id:4,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(2.5,1,.5)};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('supported_edge_archer'));
 assert.equal(f.attacks.length,2);assert.equal(f.bot.entities[4],undefined);
 assert.equal(naturalWalkingFoot(f.bot,f.bot.entity.position.floored()),true);
 const alignment=diagnostics().find(d=>d.event==='house_defense_dry_edge_alignment'&&d.details.aligned===true);
 assert.ok(alignment);assert.equal(alignment.details.graphNodeCredit,false);assert.equal(alignment.details.positionOrVelocityWritten,false);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('no shore keeps one water contact owner through knockback and the next drowned, lowering shield before each hit',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'drowned',shield:true,killAfter:100});prepareHouseResourceGroup(f,null);
 for(let x=-18;x<=18;x++)for(let z=-18;z<=18;z++)f.change('water',new Vec3(x,1,z));
 await sleep(80);assert.equal(f.bot.entity.isInWater,true);
 const diagnostics=captureHouseSurfaceDiagnostics(f),hits=new Map(),original=f.bot.attack;
 f.bot.attack=e=>{
  assert.notEqual(f.bot.__shieldActive,true,'Native attack packet follows shield release');
  original(e);const count=(hits.get(e.id)||0)+1;hits.set(e.id,count);
  if(count===2){e.position=f.bot.entity.position.offset(4,0,0);setTimeout(()=>{if(f.bot.entities[e.id])e.position=f.bot.entity.position.offset(1.5,0,0);},180);}
  if(count===4){delete f.bot.entities[e.id];f.bot.emit('entityGone',e);if(e.id===4)f.bot.entities[5]={...e,id:5,isValid:true,position:f.bot.entity.position.offset(1.5,0,0)};}
 };
 await f.agent.__testHandleSurvivalCritical('water_no_shore_contact_wave');
 assert.equal(hits.get(4),4);assert.equal(hits.get(5),4);
 assert.equal(new Set(f.attacks.map(a=>a.lease)).size,1);
 assert.ok(diagnostics().some(d=>d.event==='house_contact_navigation_failed_fighting'));
 assert.ok(diagnostics().some(d=>d.event==='house_combat_cleanup_result'));
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('retained private runner cannot repeat an obsolete fixed grave tour or impose its old full-health wait',async t=>{
 const f=fixture(t,{interrupt:false});prepareHouseResourceGroup(f,null);f.bot.health=13;f.bot.food=15;let calls=0;
 f.task.movementLease=f.agent.__testClaimMovementLease('task',`${f.task.taskId}:development-drop-recovery`);
 assert.throws(()=>f.agent.__testWithHouseResourceWork(async()=>{calls++;}),{code:'development_stale_drop_recovery_disabled'});
 assert.equal(calls,0);assert.equal(f.attempts.length,0);
 f.task.movementLease=f.agent.__testClaimMovementLease('task',`${f.task.taskId}:development-survival`);
 const result=await f.agent.__testWithHouseResourceWork(async()=>{calls++;});
 assert.equal(result.reason,'production_survival_workflow');assert.equal(calls,0);assert.equal(f.bot.health,13);assert.equal(f.bot.food,15);
 f.bot.health=4;f.bot.food=16;
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(16.5,1,.5)};
 const critical=await f.agent.__testWithHouseResourceWork(async()=>{calls++;});
 assert.equal(critical.reason,'production_survival_workflow');assert.equal(calls,0);assert.equal(f.bot.health,4);assert.equal(f.bot.food,16);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

for(const unarmed of [false,true])test(`contact attacker has priority over a distant skeleton even when unarmed=${unarmed}`,async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie'});prepareHouseResourceGroup(f,null);f.bot.health=5;
 f.bot.entities[4].position=new Vec3(.9,1,.5);
 if(unarmed){f.bot.inventory.items=()=>[];f.bot.heldItem=null;}
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(18.5,1,.5)};
 const attack=f.bot.attack;f.bot.attack=entity=>{const result=attack(entity);if(entity.id===4)delete f.bot.entities[2];return result;};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('mixed_contact_and_ranged'));
 assert.equal(f.attacks[0]?.id,4);assert.equal(f.bot.health,5);
});

test('an armed critically hurt worker still strikes an actual contact attacker without waiting for10HP',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie'});prepareHouseResourceGroup(f,null);f.bot.health=5;
 f.bot.entities[4].position=new Vec3(.9,1,.5);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('critical_armed_contact'));
 assert.equal(f.attacks.length,1);assert.equal(f.bot.entities[4],undefined);assert.equal(f.bot.health,5);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('a worker counterattacked during contact combat keeps defending below10HP and never starts a chase',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:4});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(1.5,1,.5);const attack=f.bot.attack;
 f.bot.attack=entity=>{attack(entity);if(f.attacks.length===1)f.bot.health=8;};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('contact_damage_during_fight'));
 assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[4],undefined);assert.equal(f.bot.health,8);
 assert.equal(f.goals.some(g=>g?.constructor?.name==='GoalFollow'),false);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('an actually observed half-health-point contact zombie is finished with an empty hand instead of starting another retreat',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:2});prepareHouseResourceGroup(f,null);f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 const target=f.bot.entities[4];target.position=new Vec3(1.5,1,.5);target.metadata=[];target.metadata[registry.entitiesByName.zombie.metadataKeys.indexOf('health')]=.495;
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('observed_finishing_contact'));
 assert.equal(f.attacks.length,2);assert.ok(f.attacks[1].at-f.attacks[0].at>=250);assert.equal(f.bot.entities[4],undefined);
 assert.equal(f.attempts.length,0);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('empty-handed hurt survivor punches a skeleton already in actual reach instead of endlessly seeking cover',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'skeleton',killAfter:4});prepareHouseResourceGroup(f,null);
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.health=8;
 f.bot.entities[4].position=new Vec3(1.5,1,.5);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('unarmed_ranged_actual_contact'));
 assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[4],undefined);
 assert.equal(f.attempts.length,0);assert.equal(f.bot.health,8);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

// Installed physics/pathfinder; emulate synchronous work immediately after
// the actual native packet, before physicalAttack returns to its caller.
test('contact attacks share actual-send cooldown even when publishing a hit is slow',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:4});
 prepareHouseResourceGroup(f,null);f.bot.entities[4].position=new Vec3(1.5,1,.5);
 const attack=f.bot.attack;let delays=0;
 f.bot.attack=entity=>{attack(entity);delays++;const end=Date.now()+250;while(Date.now()<end){/* Explicit modeled native attack latency. */}};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('slow_attack_publication'));
 assert.equal(f.attacks.length,4);assert.equal(delays,4);
 for(let i=1;i<f.attacks.length;i++){const delta=f.attacks[i].at-f.attacks[i-1].at;assert.ok(delta>=650,`early duplicate ${delta}ms`);assert.ok(delta<900,`publication extended cooldown ${delta}ms`);}
 assert.equal(f.bot.entities[4],undefined);
});

for(const pausedWork of [false,true])test(`retained runner cannot replace token or lease before its legacy callback while defense is active: ${pausedWork}`,{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:4});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(1.5,1,.5);const originalToken=f.task.cancellationToken,originalLease=f.task.movementLease;
 const running=f.agent.__testHandleSurvivalCritical('retained_runner_preclaim_race');running.catch(()=>{});
 await until(()=>f.attacks.length===1);const safety=f.agent.__testGetActiveMovementLease();
 if(pausedWork){f.task.status='paused';f.task.automaticSurvivalRecovery=true;originalToken.pause();}
 // Exact retained continue-cottage-development.cjs order, before its try/callback.
 f.task.cancellationToken=new CancellationToken();f.task.status='running';
 assert.throws(()=>{f.task.movementLease=f.agent.__testClaimMovementLease('task',`${f.task.taskId}:development-survival`);},{code:'house_survival_recovery_in_progress'});
 assert.equal(f.task.cancellationToken,originalToken);assert.equal(f.task.movementLease,originalLease);
 assert.equal(f.agent.__testGetActiveMovementLease(),safety);assert.equal(f.task.status,pausedWork?'paused':'running');
 await running;assert.equal(f.attacks.length,4);assert.equal(f.bot.entities[4],undefined);
});

test('field wood adapter physically rejoins its original graph without discarding visited nodes or frontier',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false});f.bot.entities={};f.task.materialSupply={materialSource:'self_gathered',surfaceGraphs:{unchanged:{original:true}}};
 const anchor={x:0,y:1,z:0};let graph={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,
  nodes:{'0,1,0':{position:anchor,parent:null,expanded:true}},order:['0,1,0'],frontier:[{parent:'0,1,0',target:{x:16,y:1,z:0}}],blockedEdges:[],current:'0,1,0',resumeNode:'0,1,0',visits:1,probes:0};
 const options={resource:'house_field_wood',assertGraphActive:()=>f.task.cancellationToken.throwIfRequested(),graphCheckpoint:{get:()=>graph,save:value=>{graph=value;}}};
 await f.bot.pathfinder.goto(new(require('mineflayer-pathfinder').goals.GoalBlock)(8,1,0));
 assert.equal(Math.floor(f.bot.entity.position.x),8);
 await f.agent.__testHouseSurfaceGraphNext(anchor,{...options,returnToAnchor:true,returnToCurrentOnly:true,rejoinInterruptedSuffix:true,via:[anchor]});
 assert.equal(Math.floor(f.bot.entity.position.x),0);assert.equal(graph.visits,1);assert.equal(graph.frontier.length,1);assert.deepEqual(graph.order,['0,1,0']);
 const result=await f.agent.__testHouseSurfaceGraphNext(anchor,options);
 assert.equal(result.moved,true);assert.equal(Math.floor(f.bot.entity.position.x),16);assert.equal(graph.visits,2);
 assert.deepEqual(f.task.materialSupply.surfaceGraphs,{unchanged:{original:true}});
});

for(const pause of [false,true])test(`ranged planning yields beyond ten native slices while retaining pause ownership: pause=${pause}`,{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[2]={id:2,name:'skeleton',isValid:true,type:'hostile',entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(12.5,1,.5)};
 const original=f.bot.pathfinder.getPathFromTo.bind(f.bot.pathfinder);let slices=0,pausing;
 f.bot.pathfinder.getPathFromTo=function*(profile,from,goal,options){
  if(goal.constructor.name==='GoalNear')for(let i=0;i<12;i++){
   slices++;if(pause&&i===1)setTimeout(()=>{pausing=f.agent.handleMessage({type:'mc_command_pause'});},0);
   yield {result:{status:'partial',path:[]}};
  }
  return yield* original(profile,from,goal,options);
 };
 const running=f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('native_sliced_ranged_plan'));
 if(pause){
  await assert.rejects(running,error=>/paused|cancelled|preempted/.test(error.code||''));await pausing;await sleep(100);
  assert.equal(f.task.status,'paused');
  assert.equal(f.attacks.length,0);assert.equal(f.attempts.length,0);
 }else{
  await running;assert.ok(slices>=12);assert.equal(f.attacks.length,2);assert.equal(f.bot.entities[2],undefined);
  assert.ok(f.attempts.length>0);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 }
});

test('a ranged warning during an actual native jump settles landing before checked approach instead of no-support abort',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.controlState.jump=true;await until(()=>f.bot.entity.position.y>2&&!f.bot.entity.onGround);f.bot.controlState.jump=false;
 f.bot.entities[2]={id:2,name:'skeleton',isValid:true,type:'hostile',entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(12.5,1,.5)};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('native_jump_ranged_warning'));
 assert.equal(f.attacks.length,2);assert.equal(f.bot.entities[2],undefined);assert.equal(f.bot.entity.onGround,true);
 assert.ok(f.attempts.length>0);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('public pause during the ranged landing wait cannot start an approach or later swing',{timeout:7000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.controlState.jump=true;await until(()=>f.bot.entity.position.y>2&&!f.bot.entity.onGround);f.bot.controlState.jump=false;
 f.bot.entities[2]={id:2,name:'skeleton',isValid:true,type:'hostile',entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(12.5,1,.5)};
 const running=f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('pause_native_jump_ranged'));
 running.catch(()=>{});await sleep(5);await f.agent.handleMessage({type:'mc_command_pause'});
 await assert.rejects(running,e=>['paused','cancelled','movement_preempted'].includes(e.code));
 await sleep(400);assert.equal(f.attempts.length,0);assert.equal(f.attacks.length,0);assert.equal(f.task.status,'paused');
});

test('cold UI context cannot run infrastructure scans before a contact-defense packet',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false});prepareHouseResourceGroup(f,null);
 await sleep(700);f.bot.entities[4]={id:4,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(1.5,1,.5)};let scans=0,scansAtPacket;const originalAttack=f.bot.attack;f.bot.attack=target=>{scansAtPacket=scans;originalAttack(target);};
 f.bot.findBlock=()=>{scans++;const until=Date.now()+35;while(Date.now()<until){/* Explicit modeled block-scan latency. */}return null;};
 const began=Date.now();await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('cold_context_contact'));
 assert.equal(f.attacks.length,1);assert.ok(f.attacks[0].at-began<150,`first packet waited ${f.attacks[0].at-began}ms for UI work`);
 const combatContexts=f.messages.filter(m=>m.type==='mc_world_context'&&m.context?.observationScope==='survival_lightweight');
 assert.ok(combatContexts.length>0);assert.equal(combatContexts.at(-1).context.self.health,20);
 assert.equal(scansAtPacket,0);t.diagnostic(`firstPacketMs=${f.attacks[0].at-began}, infrastructureScansBeforePacket=${scansAtPacket}`);
});

for(const pauseWork of [false,true])test(`self-gathered resource recovery waits on the separate survival token and preserves original work ownership: pause=${pauseWork}`,{timeout:9000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:3});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(1.5,1,.5);const token=f.task.cancellationToken;
 await f.agent.__testWithHouseResourceWork(async host=>{
  const defending=f.agent.__testHandleSurvivalCritical('independent_resource_handoff');defending.catch(()=>{});
  await until(()=>f.attacks.length===1);
  const resumed=host.resumeAfterSurvival(Object.assign(Error('preempted'),{code:'movement_preempted'}),{deadline:Date.now()+5000,bot:f.bot});
  if(pauseWork){const rejected=assert.rejects(resumed,e=>['paused','cancelled','movement_preempted'].includes(e.code));await f.agent.handleMessage({type:'mc_command_pause'});await rejected;await defending.catch(()=>{});}
  else{assert.equal(await resumed,true);await defending;assert.equal(f.attacks.length,3);assert.equal(f.bot.entities[4],undefined);assert.equal(f.task.cancellationToken,token);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);}
 });
});

for(const pauseWork of [false,true])test(`nested food/resource entry waits for an existing defense without replacing its native profile: pause=${pauseWork}`,{timeout:9000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:3});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(1.5,1,.5);let entered=false;
 await f.agent.__testWithHouseResourceWork(async()=>{
  const defending=f.agent.__testHandleSurvivalCritical('nested_food_boundary');defending.catch(()=>{});
  await until(()=>f.attacks.length===1);const profile=f.bot.pathfinder.movements;
  const nested=f.agent.__testWithHouseResourceWork(()=>{entered=true;assert.equal(f.bot.entities[4],undefined);});
  nested.catch(()=>{});await sleep(40);assert.equal(entered,false);assert.equal(f.bot.pathfinder.movements,profile);
  if(pauseWork){const rejected=assert.rejects(nested,e=>['paused','cancelled','movement_preempted'].includes(e.code));await f.agent.handleMessage({type:'mc_command_pause'});await rejected;await defending.catch(()=>{});assert.equal(entered,false);}
  else{await nested;await defending;assert.equal(entered,true);assert.equal(f.attacks.length,3);}
 });
});

for(const name of ['skeleton','zombie'])test(`actual zero-health ${name} death animation may remain loaded without falsely blocking survival handoff`,async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:name,killAfter:99});prepareHouseResourceGroup(f,null);
 const target=f.bot.entities[4];target.position=new Vec3(1.5,1,.5);target.metadata=[];
 const healthIndex=registry.entitiesByName[name].metadataKeys.indexOf('health');target.metadata[healthIndex]=5;
 const attack=f.bot.attack;f.bot.attack=entity=>{attack(entity);entity.metadata[healthIndex]=0;};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('native_zero_health_animation'));
 assert.equal(f.attacks.length,1);assert.equal(f.bot.entities[4],target);assert.equal(target.isValid,undefined);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.equal(await f.agent.__testHandleSurvivalCritical('already_observed_dead'),false);assert.equal(f.attacks.length,1);
});

test('low-health ranged defense constructs carried-block cover before wandering among failed natural positions',{timeout:15000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true});f.task.materialSupply={materialSource:'self_gathered'};f.bot.health=11;
 const target={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(15.5,1,.5)};
 f.bot.entities[2]=target;
 const originalItems=f.bot.inventory.items,dirt={name:'dirt',type:registry.itemsByName.dirt.id,count:48};
 f.bot.inventory.items=()=>[...originalItems(),...(dirt.count?[dirt]:[])];
 f.bot.world={raycast:(start,direction,length)=>{
   const {RaycastIterator}=require('prismarine-world/src/iterators'),iter=new RaycastIterator(start,direction,length);let p=start;
   while(p){const block=f.bot.blockAt(new Vec3(p.x,p.y,p.z));if(block&&iter.intersect(block.shapes,block.position))return block;p=iter.next();}return null;
 }};
 const placed=[],shieldAtPlacement=[];f.bot.placeBlock=async(reference,face)=>{shieldAtPlacement.push(f.bot.__shieldActive===true);const p=reference.position.plus(face);f.change('dirt',p);dirt.count--;placed.push(p);};
 f.bot._placeBlockWithOptions=f.bot.placeBlock;
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('low_health_constructed_cover');});
 assert.ok(placed.length>0);assert.equal(f.attacks.length,0);
 assert.equal(shieldAtPlacement.every(Boolean),true,'A real equipped offhand shield remains raised while stationary cover is built');
 assert.equal(require('../vendor/server/minecraft/houseRangedCover').rangedCoverConfirmed(f.bot,f.bot.entity.position,[target]),true);
 assert.ok(require('../vendor/server/minecraft/houseCombatMode').combatCover(f.task.materialSupply).length>0);
 assert.equal(f.bot.health,11);
 const cover=f.task.materialSupply.defensiveCover;assert.ok(cover?.plan);
 assert.equal(require('../vendor/server/minecraft/houseEmergencyShelter').emergencyShelterConfirmed({
   plan:cover.plan,position:f.bot.entity.position,blockAt:p=>f.bot.blockAt(new Vec3(p.x,p.y,p.z)),threats:[target],
   raycast:(from,to)=>{const start=new Vec3(from.x,from.y,from.z),delta=new Vec3(to.x,to.y,to.z).minus(start);return f.bot.world.raycast(start,delta.unit(),delta.norm());}}),true);
});

test('a receding creeper releases the same survival owner to a newly exposed skeleton',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true,killAfter:3});prepareHouseResourceGroup(f,null);
 const original=f.bot.attack;let appeared=false;
 f.bot.attack=target=>{
   original(target);
   if(target.name==='creeper'&&!appeared){
     appeared=true;target.position=f.bot.entity.position.offset(-16,0,0);
     f.bot.entities[9]={id:9,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:f.bot.entity.position.offset(0,0,5)};
   }
 };
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('old_creeper_new_skeleton'));
 assert.equal(appeared,true);assert.equal(f.attacks.filter(a=>a.id===4).length,1);
 assert.equal(f.attacks.filter(a=>a.id===9).length,2);assert.equal(f.bot.entities[9],undefined);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('nearby melee automatically takes control outside camp before any damage packet then resumes task', {timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered',camp:{anchor:{x:100,y:1,z:100}}};
 f.bot.entities[4]={id:4,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(2.5,1,.5)};
 await until(()=>f.attacks.some(a=>a.id===4));await until(()=>f.task.materialSupply.combatMode?.phase==='resumed');
 assert.equal(f.bot.health,20);assert.equal(f.task.materialSupply.combatMode.resumeTaskId,f.task.taskId);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.equal(f.task.currentStepIndex,0);
});

test('a disappearing retreat target requires settled native movement and fresh grounded state before task resumes',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper'});prepareHouseResourceGroup(f,null);
 const diagnostics=captureHouseSurfaceDiagnostics(f);let gone=false;
 const disappear=()=>{if(!gone&&Math.abs(f.bot.entity.position.x-.5)>.1){gone=true;delete f.bot.entities[4];}};
 f.bot.on('physicsTick',disappear);t.after(()=>f.bot.removeListener('physicsTick',disappear));
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('target_disappeared'));
 assert.equal(gone,true);assert.equal(f.bot.entity.onGround,true);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 const record=diagnostics().find(x=>x.event==='house_combat_target_absent_reobserved');
 assert.equal(record.details.killConfirmed,false);assert.equal(record.details.nativeSettlement,'SETTLED');
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
});

test('one combat owner clears five successive contact threats without giving work a turn between kills',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 let nextId=10;const add=()=>{const id=nextId++;f.bot.entities[id]={id,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:f.bot.entity.position.offset(1,0,0)};};
 add();const original=f.bot.attack;f.bot.attack=e=>{original(e);if(f.attacks.length<5)add();};
 await f.agent.__testHandleSurvivalCritical('contact_wave');
 assert.equal(f.attacks.length,5);assert.deepEqual(f.attacks.map(a=>a.id),[10,11,12,13,14]);
 assert.equal(new Set(f.attacks.map(a=>a.lease)).size,1);assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('construction return uses persisted native graph legs toward an observed owned house block',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false});
 f.bot.food=10;
 const blueprint=require('../vendor/server/minecraft/furnishedHouseBlueprints').createFurnishedHouseBlueprint({x:32,y:0,z:0},{profile:'cottage'});
 const spec=blueprint.blocks.find(s=>s.phase==='floor'&&s.item==='cobblestone');f.change('cobblestone',new Vec3(spec.position.x,spec.position.y,spec.position.z));
 f.task.stepCheckpoint={furnishedHouse:{phase:'furniture',ownedBlockIds:[spec.id]}};
 f.task.materialSupply={schema:1,materialSource:'self_gathered',profile:'cottage',houseAnchor:{x:32,y:0,z:0},camp:{anchor:{x:0,y:1,z:0},stations:{},storageSites:[]},ownedStations:{}};
 f.bot._client.write=()=>{};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testReturnHouseConstruction(new Vec3(32,1,0)));
 assert.ok(f.bot.entity.position.distanceTo(new Vec3(32,1,0))<=24);
 assert.ok(f.task.materialSupply.constructionReturn.graph.visits>1);
 assert.deepEqual(f.task.stepCheckpoint.furnishedHouse.ownedBlockIds,[spec.id]);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.attacks.length,0);
 assert.equal(f.bot.food,10,'Healthy partial hunger does not start a mandatory remote food search');
});

test('a diving native mob-type phantom triggers immediate contact retaliation and resumes the task',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[2]={id:2,name:'phantom',type:'mob',isValid:true,entityType:registry.entitiesByName.phantom.id,height:.5,position:new Vec3(2.2,1.5,.5)};
 const at=Date.now();f.bot.emit('entityHurt',f.bot.entity);
 await until(()=>f.attacks.length>0,1000);assert.ok(Date.now()-at<1000);
 await until(()=>f.attacks.length===2,3000);
 await until(()=>f.agent.__testGetActiveMovementLease()===f.task.movementLease);
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
 assert.ok(f.attacks.every(a=>a.id===2));
});

test('nearby approaching zombie takes priority over chasing a distant skeleton',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:1});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[2]={id:2,name:'skeleton',type:'mob',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(15.5,1,.5)};
 f.bot.entities[3]={id:3,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(5.7,1,.5)};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('mixed_near_melee'));
 assert.ok(f.attacks.length);assert.equal(f.attacks[0].id,3);
 assert.equal(f.bot.entities[3],undefined);
});

test('a sword breaking mid-fight switches to a real backup axe before sending any bare-handed attack',{timeout:7000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:3});f.task.materialSupply={materialSource:'self_gathered'};
 const sword=f.bot.heldItem,axe={name:'iron_axe',type:registry.itemsByName.iron_axe.id,count:1,durabilityUsed:0};let broken=false;
 f.bot.inventory.items=()=>broken?[axe]:[sword,axe];
 f.bot.entities[2]={id:2,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(2.2,1,.5)};
 const weapons=[],attack=f.bot.attack;f.bot.attack=e=>{weapons.push(f.bot.heldItem?.name||null);attack(e);if(weapons.length===1){broken=true;f.bot.heldItem=null;}};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('native_weapon_loss'));
 assert.deepEqual(weapons,['stone_sword','iron_axe','iron_axe']);
 assert.ok(f.attacks[1].at-f.attacks[0].at>=1100);assert.ok(f.attacks[2].at-f.attacks[1].at>=1100);
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
});

test('surrounded archers cannot authorize repeated uncovered twelve-meter retreat loops',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities={};
 for(const [id,x,z]of [[2,8.5,.5],[3,-7.5,.5],[4,.5,8.5]])f.bot.entities[id]={id,name:'skeleton',isValid:true,height:1.99,position:new Vec3(x,1,z)};
 const result=await f.agent.__testWithHouseResourceWork(()=>require('../vendor/server/minecraft/houseRangedCover').seekHouseRangedCover({
  getBot:()=>f.bot,assertActive:()=>{},goto:()=>{throw Error('No uncovered route should start');},
 },{deadline:Date.now()+3000,boundaryOrigin:f.bot.entity.position.clone()}));
 assert.equal(result.moved,false);assert.equal(result.covered,false);assert.equal(f.attempts.length,0);
});

test('a brief melee knockback does not bounce between two attackers before either is defeated',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'drowned',shield:true,killAfter:100});prepareHouseResourceGroup(f,null);
 for(let x=-18;x<=18;x++)for(let z=-18;z<=18;z++)f.change('water',new Vec3(x,1,z));
 await sleep(80);const hits=new Map(),original=f.bot.attack;
 f.bot.attack=e=>{
  assert.notEqual(f.bot.__shieldActive,true);original(e);
  const count=(hits.get(e.id)||0)+1;hits.set(e.id,count);
  if(e.id===4&&count===2){
   e.position=f.bot.entity.position.offset(4,0,0);
   f.bot.entities[5]={...e,id:5,isValid:true,position:f.bot.entity.position.offset(-2.4,0,0)};
   setTimeout(()=>{if(f.bot.entities[4])e.position=f.bot.entity.position.offset(1.5,0,0);},180);
  }
  if(count===4){delete f.bot.entities[e.id];f.bot.emit('entityGone',e);}
 };
 await f.agent.__testHandleSurvivalCritical('two_attacker_knockback');
 const order=f.attacks.map(a=>a.id).filter((id,i,all)=>i===0||id!==all[i-1]);
 assert.deepEqual(order,[4,5]);
 assert.ok(hits.get(4)>=4&&hits.get(5)>=4);
 assert.equal(f.bot.entities[4],undefined);assert.equal(f.bot.entities[5],undefined);
 assert.equal(new Set(f.attacks.map(a=>a.lease)).size,1);
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
});

test('an exposed witch takes the ranged combat owner instead of allowing provisioning to stand under potion attacks',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'witch',shield:true,killAfter:4});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(7.5,1,.5);
 const d=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('witch_potion_damage'));
 assert.ok(f.attacks.length>=4);assert.equal(f.bot.entities[4],undefined);
 assert.ok(d().some(r=>r.event==='house_ranged_target_locked'&&r.details.targetId===4));
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('generic fallback cannot repeatedly preempt house work for a cold creeper four levels below the actual worker',async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(1.7,-3,1.7);
 const lease=f.agent.__testGetActiveMovementLease();
 assert.equal(await f.agent.__testHandleSurvivalCritical('other_cave_layer'),false);
 assert.equal(f.agent.__testGetActiveMovementLease(),lease);assert.equal(f.attacks.length,0);
});

test('a positively ignited creeper still takes ownership across the layer boundary and public cancellation revokes it',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true});prepareHouseResourceGroup(f,null);
 const e=f.bot.entities[4];e.position=new Vec3(1.7,-3,1.7);
 e.metadata[registry.entitiesByName.creeper.metadataKeys.indexOf('is_ignited')]=true;
 const d=captureHouseSurfaceDiagnostics(f),pending=f.agent.__testHandleSurvivalCritical('ignited_other_layer');pending.catch(()=>{});
 await until(()=>d().some(r=>r.event==='house_combat_mode_started'),1000);
 f.task.cancellationToken.pause();await assert.rejects(pending,e=>['paused','cancelled','movement_preempted'].includes(e.code));
 const count=f.attacks.length;await sleep(60);assert.equal(f.attacks.length,count);
});

test('a cold lower cave creeper behind loaded stone cannot repeatedly interrupt a native house movement',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'creeper',shield:true});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(2.5,-2,.5);
 const lease=f.agent.__testGetActiveMovementLease();
 assert.equal(await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('natural_cave_separation')),false);
 assert.equal(f.agent.__testGetActiveMovementLease(),lease);assert.equal(f.attacks.length,0);
 assert.equal(await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('natural_cave_separation_repeat')),false);
});

test('healthy worn iron chestplate and usable shield finish two ordinary zombies under one owner before resuming work',{timeout:15000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:100});f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.inventory.slots[6]={name:'iron_chestplate',type:registry.itemsByName.iron_chestplate.id,count:1,durabilityUsed:0};
 for(const [id,x]of [[4,5],[5,6]])f.bot.entities[id]={id,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(x,1,.5)};
 const attack=f.bot.attack,hits=new Map();f.bot.attack=e=>{attack(e);hits.set(e.id,(hits.get(e.id)||0)+1);if(hits.get(e.id)===2){delete f.bot.entities[e.id];e.isValid=false;f.bot.emit('entityDead',e);f.bot.emit('entityGone',e);}};
 const diagnostic=captureHouseSurfaceDiagnostics(f);
 try{await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('armored_zombie_pair'));}catch(error){console.log(JSON.stringify({pairWitness:{position:f.bot.entity.position,hits:[...hits],events:diagnostic().filter(e=>/pair|approach|defense|escalat/.test(e.event)).map(e=>({event:e.event,details:e.details})).slice(-8)}}));throw error;}
 assert.deepEqual([...hits.entries()],[[4,2],[5,2]]);assert.equal(new Set(f.attacks.map(a=>a.lease)).size,1);
 assert.ok(f.bot.entity.position.x>1,'Installed pathfinder and native physics actually approach instead of fleeing');
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('hurt armored worker keeps one shielded contact owner while an angry enderman briefly leaves reach',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:3});f.task.materialSupply={materialSource:'self_gathered'};f.bot.health=8;
 const metadata=[];metadata[registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')]=true;
 const enemy={id:93,name:'enderman',type:'hostile',isValid:true,entityType:registry.entitiesByName.enderman.id,height:2.9,position:new Vec3(2.5,1,.5),metadata};
 f.bot.entities[93]=enemy;
 const attack=f.bot.attack;let shieldObserved=false;
 f.bot.attack=e=>{attack(e);if(f.attacks.length===1){e.position=new Vec3(5,1,.5);setTimeout(()=>{shieldObserved=f.bot.__shieldActive===true;e.position=new Vec3(2.5,1,.5);},350);}};
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('enderman_observed_low_health'));
 assert.equal(f.attacks.length,3);assert.equal(shieldObserved,true);
 assert.equal(new Set(f.attacks.map(a=>a.lease)).size,1);
 assert.equal(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))<.15,true,'Low life must not chase the briefly separated enderman');
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

for(const pauseWork of [false,true])test(`original furniture profile entry drains survival before taking control and respects cancellation: pause=${pauseWork}`,{timeout:9000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:3});prepareHouseResourceGroup(f,null);
 f.bot.entities[4].position=new Vec3(1.5,1,.5);let entered=false;
 await f.agent.__testWithHouseResourceWork(async()=>{
  const original=f.bot.pathfinder.movements,defending=f.agent.__testHandleSurvivalCritical('furniture_profile_boundary');defending.catch(()=>{});
  await until(()=>f.attacks.length===1);const profile=f.bot.pathfinder.movements;
  const nested=f.agent.__testWithFurnishedHouseMovements(()=>{entered=true;assert.equal(f.bot.entities[4],undefined);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);});
  nested.catch(()=>{});await sleep(40);assert.equal(entered,false);assert.equal(f.bot.pathfinder.movements,profile);
  if(pauseWork){const rejected=assert.rejects(nested,e=>['paused','cancelled','movement_preempted'].includes(e.code));await f.agent.handleMessage({type:'mc_command_pause'});await rejected;await defending.catch(()=>{});assert.equal(entered,false);}
  else{await nested;await defending;assert.equal(entered,true);assert.equal(f.attacks.length,3);assert.equal(f.bot.pathfinder.movements,original);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);}
 });
});

test('formal05 airborne failed-resource handoff waits for native landing before graph registration',{timeout:5000},async t=>{
 const f=fixture(t,{interrupt:false,startPosition:{x:16.465145423325232,y:67.53584062504456,z:-93.50272767506281}});f.bot.entities={};
 for(let x=14;x<=19;x++)for(let z=-97;z<=-90;z++)f.change('stone',new Vec3(x,66,z));
 f.bot.entity.onGround=false;f.bot.entity.velocity.y=-.2;f.task.materialSupply={materialSource:'self_gathered',surfaceGraphs:{}};
 let graph=null,saves=0;const anchor={x:16,y:67,z:-94};
 const result=await f.agent.__testHouseSurfaceGraphNext(anchor,{resource:'house_field_wood',returnToAnchor:true,
  assertGraphActive:()=>f.task.cancellationToken.throwIfRequested(),graphCheckpoint:{get:()=>graph,save:value=>{
   assert.equal(f.bot.entity.onGround,true,'No airborne node registration');saves++;graph=value;
  }}});
 assert.ok(saves>0);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.position.y,67);assert.equal(graph.current,'16,67,-94');assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.ok(result);
});

test('formal07 contact zombie preempts a ranged approach under the same survival owner and receives an immediate weapon attack',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,shield:true,killAfter:1});f.task.materialSupply={materialSource:'self_gathered'};let contactAt=0;
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(18.5,1,.5)};
 const incoming=()=>{if(!contactAt&&f.bot.entity.position.x>1.2){contactAt=Date.now();f.bot.entities[4]={id:4,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:f.bot.entity.position.offset(1.1,0,0)};f.bot.health=16;f.bot.emit('entityHurt',f.bot.entity);}};
 f.bot.on('physicsTick',incoming);t.after(()=>f.bot.off('physicsTick',incoming));
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('formal07_ranged_contact');});
 assert.ok(contactAt>0);assert.equal(f.attacks[0].id,4);assert.ok(f.attacks[0].at-contactAt<1000);assert.equal(f.attacks[0].lease.kind,'survival-critical');assert.equal(f.bot.entities[4],undefined);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.health,16);
});

test('formal09 mining defense drains its own temporary shore profile before reclaiming the original movement', {timeout:12000}, async t=>{
 let defending;
 const f=fixture(t,{killAfter:4,interrupt:false,navigationOptions:{isOwnedDefenseActive:()=>Boolean(defending && f.agent.__testGetActiveMovementLease()?.kind==='survival-critical'),settleOwnedDefense:async()=>{await defending;}}});f.task.materialSupply={materialSource:'self_gathered'};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 const nativeAttack=f.bot.attack;let immersed=false;
 f.bot.attack=entity=>{nativeAttack(entity);if(!immersed){immersed=true;f.change('water',f.bot.entity.position.floored());f.bot.entity.isInWater=true;}};
 f.bot.once('goal_updated',()=>{setTimeout(()=>{
  f.bot.entities[4]={id:4,name:'spider',isValid:true,position:new Vec3(2.5,1,.5),height:.9};
  defending=f.agent.__testHandleSurvivalCritical('formal09_native_hurt');defending.catch(()=>{});
 },20);});
 const outcome=await f.navigator.advance('east').then(value=>({value}),error=>({error}));
 await defending;
 assert.ok(diagnostics().some(d=>d.event==='house_emergency_shore_confirmed'),'The real native shore path must execute; a plain melee battle cannot satisfy this regression');
 assert.ok(immersed);assert.ok(f.attacks.length>=1);
 assert.notEqual(outcome.error?.code,'movement_preempted','A temporary profile owned by this exact defense must drain before checking the work profile');
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.match(outcome.error?.code||'',/^MINING_(?:ROUTE_CHANGED|FLUID)$/,'The flooded old edge cannot receive completion credit');
 assert.equal(f.navigator.getState().moves,0);
});

for(const control of ['pause','cancel'])test(`formal09 user ${control} during temporary shore defense cannot restore the original mining lease`,{timeout:12000},async t=>{
 let defending;
 const f=fixture(t,{killAfter:4,interrupt:false,navigationOptions:{isOwnedDefenseActive:()=>Boolean(defending && f.agent.__testGetActiveMovementLease()?.kind==='survival-critical'),settleOwnedDefense:async()=>{await defending;}}});
 f.task.materialSupply={materialSource:'self_gathered'};
 const nativeAttack=f.bot.attack;let immersed=false;
 f.bot.attack=entity=>{nativeAttack(entity);if(!immersed){immersed=true;f.change('water',f.bot.entity.position.floored());f.bot.entity.isInWater=true;}};
 f.bot.once('goal_updated',()=>setTimeout(()=>{
  f.bot.entities[4]={id:4,name:'spider',isValid:true,position:new Vec3(2.5,1,.5),height:.9};
  defending=f.agent.__testHandleSurvivalCritical('formal09_native_hurt');defending.catch(()=>{});
 },20));
 const running=f.navigator.advance('east').then(value=>({value}),error=>({error}));
 await until(()=>immersed && f.bot.pathfinder.movements.maxDropDown===1);
 await f.agent.handleMessage({type:`mc_command_${control}`});
 const outcome=await running;await defending.catch(()=>{});
 assert.ok(outcome.error);assert.equal(f.navigator.getState().moves,0);
 assert.notEqual(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 const attacks=f.attacks.length;await sleep(100);assert.equal(f.attacks.length,attacks);
});

test('formal09 after a receding water block and actual dry shore arrival the same task finishes its original checked step',{timeout:12000},async t=>{
 let defending;
 const f=fixture(t,{killAfter:4,interrupt:false,navigationOptions:{isOwnedDefenseActive:()=>Boolean(defending && f.agent.__testGetActiveMovementLease()?.kind==='survival-critical'),settleOwnedDefense:async()=>{await defending;}}});
 f.task.materialSupply={materialSource:'self_gathered'};const diagnostics=captureHouseSurfaceDiagnostics(f);
 const nativeAttack=f.bot.attack;let immersed=false;
 f.bot.attack=entity=>{nativeAttack(entity);if(!immersed){
  immersed=true;const water=f.bot.entity.position.floored();f.change('water',water);f.bot.entity.isInWater=true;
  // A server block update retracts this fixture's transient water. No body
  // position or goto result is assigned; installed native physics must return.
  f.bot.once('goal_updated',()=>{f.change('air',water);});
 }};
 f.bot.once('goal_updated',()=>setTimeout(()=>{
  f.bot.entities[4]={id:4,name:'spider',isValid:true,position:new Vec3(2.5,1,.5),height:.9};
  defending=f.agent.__testHandleSurvivalCritical('formal09_native_hurt');defending.catch(()=>{});
 },20));
 const result=await f.navigator.advance('east');await defending;
 assert.ok(diagnostics().some(d=>d.event==='house_emergency_shore_confirmed'));
 assert.equal(f.bot.entities[4],undefined);assert.equal(result.state.moves,1);assert.equal(result.state.routeIndex,1);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('formal13 same survival owner temporarily retraces a recorded protected mine prefix and retires the interrupted exposed step',{timeout:12000},async t=>{
 const terrain=require('../test-support/fixtures/formal13-ranged-quarry.json'),o=terrain.origin;
 const prefix=Array.from({length:6},(_,i)=>({x:38+i,y:16,z:-69}));let defending;
 const f=fixture(t,{interrupt:false,startPosition:o,worldAt:p=>{
  const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const state=terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];return Object.assign(Block.fromProperties(registry.blocksByName[state.name].id,state.properties,0),{position:p});
 },navigationOptions:{restoredState:{breadcrumbs:prefix,routeIndex:5,moves:5,dug:12},
  isOwnedDefenseActive:()=>Boolean(defending&&f.agent.__testGetActiveMovementLease()?.kind==='survival-critical'),settleOwnedDefense:async()=>{await defending;}}});
 f.task.materialSupply={materialSource:'self_gathered',quarry:{schema:1,activeResource:'raw_iron',routes:{raw_iron:{navigation:{breadcrumbs:prefix,routeIndex:5,moves:5,dug:12}}}}};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 f.bot.once('goal_updated',()=>setTimeout(()=>{f.bot.entities[3068]={id:3068,name:'skeleton',height:1.99,isValid:true,position:new Vec3(44.5,12,-60.9)};defending=f.agent.__testHandleSurvivalCritical('formal13_mine_lip');defending.catch(()=>{});},20));
 const outcome=await f.agent.__testWithHouseResourceWork(()=>f.navigator.advance('east')).then(value=>({value}),error=>({error}));
 await defending;
 assert.equal(outcome.error?.observedMiningRetreat,true,JSON.stringify({error:outcome.error?.code,events:diagnostics().slice(-4).map(d=>({event:d.event,details:d.details}))}));
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.attacks.length,0);
 const beforeConfirm=f.navigator.getState(),nativeBlockAt=f.bot.blockAt,floor=f.bot.entity.position.floored().offset(0,-1,0);
 f.bot.blockAt=p=>p.floored().equals(floor)?Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState),{position:floor}):nativeBlockAt(p);
 assert.throws(()=>f.navigator.confirmObservedRetreat(),{code:'MINING_ROUTE_CHANGED'});assert.deepEqual(f.navigator.getState(),beforeConfirm);f.bot.blockAt=nativeBlockAt;
 const observed=f.navigator.confirmObservedRetreat();assert.ok(observed.state.routeIndex<5);assert.equal(observed.state.moves,5);assert.equal(observed.state.dug,12);assert.equal(observed.newMoveCredit,false);assert.ok(f.bot.entity.position.x<43);
});

test('formal16 a non-goto resource interruption carries the actual protected-prefix retreat into quarry recovery',{timeout:12000},async t=>{
 const terrain=require('../test-support/fixtures/formal13-ranged-quarry.json'),o=terrain.origin;
 const prefix=Array.from({length:6},(_,i)=>({x:38+i,y:16,z:-69}));let defending;
 const f=fixture(t,{interrupt:false,startPosition:o,worldAt:p=>{
  const b=terrain.bounds;if(p.x<b.minX||p.x>b.maxX||p.y<b.minY||p.y>b.maxY||p.z<b.minZ||p.z>b.maxZ)return null;
  const state=terrain.palette[terrain.states[`${p.x},${p.y},${p.z}`]||0];return Object.assign(Block.fromProperties(registry.blocksByName[state.name].id,state.properties,0),{position:p});
 },navigationOptions:{restoredState:{breadcrumbs:prefix,routeIndex:5,moves:5,dug:12},
  isOwnedDefenseActive:()=>Boolean(defending&&f.agent.__testGetActiveMovementLease()?.kind==='survival-critical'),settleOwnedDefense:async()=>{await defending;}}});
 f.task.materialSupply={materialSource:'self_gathered',quarry:{schema:1,activeResource:'raw_iron',routes:{raw_iron:{navigation:{breadcrumbs:prefix,routeIndex:5,moves:5,dug:12}}}}};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 let interruption;
 const outcome=await f.agent.__testWithHouseResourceWork(async ({resumeAfterSurvival})=>{
  f.bot.entities[3068]={id:3068,name:'skeleton',height:1.99,isValid:true,position:new Vec3(44.5,12,-60.9)};
  defending=f.agent.__testHandleSurvivalCritical('formal16_non_goto_mine_lip');
  defending.catch(()=>{});
  await until(()=>f.agent.__testGetActiveMovementLease()?.kind==='survival-critical');
  interruption=Object.assign(Error('movement_preempted'),{code:'movement_preempted'});
  await resumeAfterSurvival(interruption,{deadline:Date.now()+10000,bot:f.bot});
  return interruption;
 }).then(value=>({error:value}),error=>({error}));
 await defending;
 assert.equal(outcome.error?.observedMiningRetreat,true,JSON.stringify({error:outcome.error?.code,events:diagnostics().slice(-4).map(d=>({event:d.event,details:d.details}))}));
 assert.equal(f.task.materialSupply.combatMode.phase,'resumed');assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.attacks.length,0);
 const beforeConfirm=f.navigator.getState(),nativeBlockAt=f.bot.blockAt,floor=f.bot.entity.position.floored().offset(0,-1,0);
 f.bot.blockAt=p=>p.floored().equals(floor)?Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState),{position:floor}):nativeBlockAt(p);
 assert.throws(()=>f.navigator.confirmObservedRetreat(),{code:'MINING_ROUTE_CHANGED'});assert.deepEqual(f.navigator.getState(),beforeConfirm);f.bot.blockAt=nativeBlockAt;
 const observed=f.navigator.confirmObservedRetreat();assert.ok(observed.state.routeIndex<5);assert.equal(observed.state.moves,5);assert.equal(observed.state.dug,12);assert.equal(observed.newMoveCredit,false);assert.ok(f.bot.entity.position.x<43);
});

for(const shield of [false])test(`formal25 empty site explorer without material supply reacts to its first ranged hurt and reaches actual collision cover: shield ${shield}`,{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield});f.task.currentStep='build_furnished_house_phase';f.task.siteSearch={kind:'loaded_natural_house_site_search',reservation:null,ownerIdentity:{taskId:f.task.taskId,generation:0}};
 const diagnostics=captureHouseSurfaceDiagnostics(f);let firstCover;
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 for(let z=2;z<=8;z++)for(let y=1;y<=2;y++)f.change('stone',new Vec3(4,y,z));
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(20.5,1,.5)};
 const {rangedCoverConfirmed}=require('../vendor/server/minecraft/houseRangedCover');
 assert.equal(rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),false);
 const observeCover=()=>{if(Object.values(f.bot.controlState).some(Boolean))assert.equal(f.bot.__shieldActive===true,false,'A native retreat cannot keep the backwards-facing shield movement penalty');if(!firstCover&&f.bot.entity.onGround&&rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]))firstCover=f.bot.entity.position.floored();};
 f.bot.on('physicsTick',observeCover);
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('unarmed_ranged_cover');});
 f.bot.removeListener('physicsTick',observeCover);
 assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>1);
 assert.equal(rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),true);
 const planned=diagnostics().find(e=>e.event==='house_ranged_cover_planned').details.target;
 const observed=diagnostics().find(e=>e.event==='house_ranged_cover_observed').details;
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(planned.x,planned.y,planned.z));
 assert.equal(observed.retreatArrivalConfirmed,true);
 assert.ok(firstCover);assert.notDeepEqual(firstCover,f.bot.entity.position.floored(),'First temporary obstruction is not the completed retreat');
});

for(const shield of [false])test(`formal25 wounded site explorer holds the original defense through server-modeled recovery before work resumes: shield ${shield}`,{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,shield});f.task.currentStep='build_furnished_house_phase';f.task.siteSearch={kind:'loaded_natural_house_site_search',reservation:null,ownerIdentity:{taskId:f.task.taskId,generation:0}};
 const diagnostics=captureHouseSurfaceDiagnostics(f);let firstCover;
 f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.health=15;
 // Modeled server health packet only; no actor pose/control is assigned.
 const regen=setTimeout(()=>{f.bot.health=16;f.bot.emit('health');},4500);t.after(()=>clearTimeout(regen));
 for(let z=2;z<=8;z++)for(let y=1;y<=2;y++)f.change('stone',new Vec3(4,y,z));
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(20.5,1,.5)};
 const {rangedCoverConfirmed}=require('../vendor/server/minecraft/houseRangedCover');
 assert.equal(rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),false);
 const observeCover=()=>{if(Object.values(f.bot.controlState).some(Boolean))assert.equal(f.bot.__shieldActive===true,false,'A native retreat cannot keep the backwards-facing shield movement penalty');if(!firstCover&&f.bot.entity.onGround&&rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]))firstCover=f.bot.entity.position.floored();};
 f.bot.on('physicsTick',observeCover);
 await f.agent.__testWithHouseResourceWork(()=>{f.bot.emit('entityHurt',f.bot.entity);return f.agent.__testHandleSurvivalCritical('unarmed_ranged_cover');});
 f.bot.removeListener('physicsTick',observeCover);
 assert.equal(f.bot.health,16);assert.ok(diagnostics().some(e=>e.event==='house_site_survival_restored'));assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>1);
 assert.equal(rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),true);
 const planned=diagnostics().find(e=>e.event==='house_ranged_cover_planned').details.target;
 const observed=diagnostics().find(e=>e.event==='house_ranged_cover_observed').details;
 assert.deepEqual(f.bot.entity.position.floored(),new Vec3(planned.x,planned.y,planned.z));
 assert.equal(observed.retreatArrivalConfirmed,true);
 assert.ok(firstCover);assert.notDeepEqual(firstCover,f.bot.entity.position.floored(),'First temporary obstruction is not the completed retreat');
});

test('formal28 native self-hurt source triggers empty-site polar bear retaliation and returns the original graph goal, leaving the cub alone',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:1});
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 f.task.siteSearch={kind:'loaded_natural_house_site_search',ownerIdentity:{taskId:f.task.taskId,generation:0}};
 f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 const bear={id:497,name:'polar_bear',type:'mob',entityType:registry.entitiesByName.polar_bear.id,isValid:true,height:1.4,position:new Vec3(2.5,1,.5)};
 const cub={...bear,id:498,position:new Vec3(4,1,.5)};f.bot.entities[497]=bear;f.bot.entities[498]=cub;
 const running=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});running.catch(()=>{});
 await until(()=>f.attempts.length===1);const hurtAt=Date.now();
 // MODELED decoded native event; installed Mineflayer resolves packet498 to
 // source497 (ID+1). The installed native pathfinder/physics own the resumption.
 f.bot.emit('entityHurt',f.bot.entity,bear);
 const result=await running;
 assert.equal(result.moved,true);assert.equal(f.attacks.length,1);assert.equal(f.attacks[0].id,497);
 assert.ok(f.attacks[0].at-hurtAt<1000);assert.equal(f.bot.entities[498],cub);
 assert.equal(f.attempts.length,2);assert.deepEqual(f.attempts.map(a=>[a.x,a.y,a.z]),[result.actual,result.actual].map(p=>[p.x,p.y,p.z]));
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.entity.onGround,true);
});

for(const mode of ['success','foreign','pause'])test(`formal30 same work drains its stationary defense across its captured mining profile: ${mode}`,{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};
 const diagnostics=captureHouseSurfaceDiagnostics(f);let replacement,foreign;
 const result=await f.agent.__testWithHouseResourceWork(async({resumeAfterSurvival})=>{
  const {Movements}=require('mineflayer-pathfinder'),miningProfile=new Movements(f.bot);
  Object.assign(miningProfile,{canDig:false,allowParkour:false,allowSprinting:false,allowFreeMotion:false,allow1by1towers:false,maxDropDown:2,scafoldingBlocks:[],infiniteLiquidDropdownDistance:false});
  // MODELED owned navigation profile boundary, no position/velocity changes.
  f.bot.pathfinder.setMovements(miningProfile);
  const zombie={id:4,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(2.5,1,.5)};f.bot.entities[4]=zombie;
  const defense=f.agent.__testHandleSurvivalCritical('stationary_quarry_boundary');defense.catch(()=>{});
  await until(()=>f.attacks.length===1);assert.ok(diagnostics().some(e=>e.event==='house_camp_defense_started'));
  if(mode==='foreign'){
   foreign=f.agent.__testClaimMovementLease('task','replacement-owner');replacement=new Movements(f.bot);f.bot.pathfinder.setMovements(replacement);
  }else if(mode==='pause')f.task.cancellationToken.pause();
  const resume=resumeAfterSurvival(Object.assign(Error('movement_preempted'),{code:'movement_preempted'}),{deadline:Date.now()+5000,bot:f.bot});
  if(mode!=='success'){await assert.rejects(resume,e=>['movement_preempted','paused','cancelled'].includes(e.code));await defense.catch(()=>{});return false;}
  assert.equal(await resume,true);await defense;assert.equal(f.bot.pathfinder.movements,miningProfile);return true;
 });
 if(mode==='success'){assert.equal(result,true);assert.equal(f.attacks.length,2);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);}
 if(mode==='foreign'){assert.equal(f.agent.__testGetActiveMovementLease(),foreign);assert.equal(f.bot.pathfinder.movements,replacement);assert.equal(f.attacks.length,1);}
 if(mode==='pause')assert.equal(f.attacks.length,1);
});

for(const mode of ['relocate','pause','foreign'])test(`formal33 site escape hands off its real dry observation without replaying the threatened goal: ${mode}`,{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:100});f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 f.task.siteSearch={kind:'loaded_natural_house_site_search',ownerIdentity:{taskId:f.task.taskId,generation:0}};
 f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 f.bot.entities[4]={id:4,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(5.5,1,2.5)};
 let cp,changed=false,foreign,profile;const diagnostics=captureHouseSurfaceDiagnostics(f);
 const steer=()=>{if(changed||mode==='relocate'||f.agent.__testGetActiveMovementLease()?.kind!=='survival-critical')return;changed=true;
  if(mode==='pause')f.task.cancellationToken.pause();else{foreign=f.agent.__testClaimMovementLease('task','foreign-site');profile=new(require('mineflayer-pathfinder').Movements)(f.bot);f.bot.pathfinder.setMovements(profile);}};
 f.bot.on('physicsTick',steer);t.after(()=>f.bot.removeListener('physicsTick',steer));
 const run=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0},{resource:'house_site_cottage',graphCheckpoint:{get:()=>cp,save:value=>{cp=value;}},assertGraphActive:()=>f.task.cancellationToken.throwIfRequested()});
 if(mode!=='relocate'){
  await assert.rejects(run,e=>/paused|cancelled|movement_preempted/.test(e.code||''));assert.equal(cp.visits,1);assert.equal(cp.order.length,1);
  if(mode==='foreign'){assert.equal(f.agent.__testGetActiveMovementLease(),foreign);assert.equal(f.bot.pathfinder.movements,profile);}return;
 }
 const result=await run;assert.equal(result.moved,true);assert.equal(cp.visits,2);assert.equal(cp.order.length,2);
 assert.equal(f.bot.entity.onGround,true);assert.equal(cp.current,`${Math.floor(f.bot.entity.position.x)},1,${Math.floor(f.bot.entity.position.z)}`);
 const receipt=diagnostics().find(e=>e.event==='house_site_defense_relocated').details;
 assert.equal(receipt.oldTargetReached,false);assert.equal(receipt.oldEdgeTraversalCredit,false);
 assert.notEqual(cp.current,`${receipt.abandonedTarget.x},${receipt.abandonedTarget.y},${receipt.abandonedTarget.z}`);
 const relocated=Object.values(cp.nodes).find(node=>node.survivalRelocation);
 if(relocated)assert.equal(relocated.survivalRelocation.oldEdgeTraversalCredit,false);
 else {
  // A boundary defense may finish before this graph leg begins. The graph
  // then records a separately completed native dry leg from that real stand.
  const trail=cp.nodes[cp.current].dryParentTrail;
  assert.equal(trail.kind,'actual_successful_dry_parent_edge');assert.equal(trail.complete,true);
  assert.equal(trail.from,'0,1,0');assert.equal(trail.to,cp.current);
  assert.ok(trail.points.length>1&&trail.points.every(p=>p.actual&&p.supports?.length));
 }
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(diagnostics().filter(e=>e.event==='house_surface_defense_started').length,1);
 assert.deepEqual(cp.anchor,{x:0,y:1,z:0});assert.ok(f.attempts.length>=2);assert.equal(f.attacks.length,0);
});

for(const baseline of [true,false])test(`formal36 combined native creeper escape then ranged retreat uses its recorded cumulative recovery bound: baseline=${baseline}`,{timeout:30000},async t=>{
 let createAgent=createMinecraftTaskAgent;
 if(baseline){const Module=require('node:module'),file=path.join(__dirname,'../vendor/server/minecraftTaskAgent.js'),old=new Module(file,module);old.filename=file;old.paths=Module._nodeModulePaths(path.dirname(file));
  const current='const displacementLimit = rangedRecovery ? rangedRecovery.maximumDisplacement+.05 : interrupt.creeperEscape?.confirmed === true ? 12 :',previous='const displacementLimit = interrupt.creeperEscape?.confirmed === true ? 12 : rangedRecovery ? rangedRecovery.maximumDisplacement+.05 :',text=fs.readFileSync(file,'utf8');assert.ok(text.includes(current));old._compile(text.replace(current,previous),file);createAgent=old.exports.createMinecraftTaskAgent;}
 const f=fixture(t,{interrupt:false,createAgent});f.task.materialSupply={materialSource:'self_gathered'};
 const running=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0});running.catch(()=>{});
 await until(()=>f.attempts.length===1);
 const origin=f.bot.entity.position.clone();
 f.bot.entities[4]={id:4,name:'creeper',type:'hostile',isValid:true,entityType:registry.entitiesByName.creeper.id,height:1.7,position:origin.offset(5,0,0),metadata:[]};
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:origin.offset(10,0,0)};
 // Model the server losing this archer from loaded perception after the
 // cumulative real native retreat, as observed in the failed formal36 run.
 let peakDisplacement=0;f.bot.on('physicsTick',()=>{peakDisplacement=Math.max(peakDisplacement,f.bot.entity.position.distanceTo(origin));if(peakDisplacement>13.5){delete f.bot.entities[2];delete f.bot.entities[4];}});
 // Explicit modeled decoded arrow injury supplies the current observed-hit
 // contract; merely seeing a distant archer no longer forces a retreat.
 f.bot.health=14;f.bot.emit('entityHurt',f.bot.entity,f.bot.entities[2]);
 await f.agent.__testHandleSurvivalCritical('formal36_combined_escape');
 let failure;try{await running;}catch(error){failure=error;}
 const trace=fs.readFileSync(f.task.diagnostics.tracePath,'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(trace.some(d=>d.event==='creeper_escape_confirmed'));
 assert.ok(trace.some(d=>d.event==='house_ranged_cover_observed'&&d.details.threatGone),JSON.stringify({peakDisplacement,failure:failure?.code,events:trace.filter(d=>/ranged|escape|surface_self|surface_defense/.test(d.event)).map(d=>({event:d.event,details:d.details}))}));
 if(baseline){assert.ok(f.task.materialSupply.surfaceGraphs.any_log.blockedEdges.some(e=>e.reason==='house_surface_defense_unconfirmed'));assert.equal(trace.some(d=>d.event==='house_surface_self_defense_resumed'),false);assert.ok(peakDisplacement>13.5);return;}
 assert.ok(trace.some(d=>d.event==='house_surface_self_defense_resumed'),JSON.stringify({failure:failure?.code,events:trace.slice(-8)}));
 assert.equal(trace.some(d=>d.details?.code==='house_surface_defense_unconfirmed'),false);
 assert.ok(peakDisplacement>13.5);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

for(const mode of ['relocate','pause','foreign'])test(`temporary field search hands off actual defense relocation without claiming its old target: ${mode}`,{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:100});f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 f.task.materialSupply={materialSource:'self_gathered'};f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 // Spawn only after the interrupted native leg has actually started; an
 // already loaded threat is now correctly handled at the graph boundary.
 f.bot.once('goal_updated',()=>{f.bot.entities[4]={id:4,name:'zombie',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(3.5,1,2.5)};});
 let cp,changed=false,foreign,profile;const diagnostics=captureHouseSurfaceDiagnostics(f);
 const steer=()=>{if(changed||mode==='relocate'||f.agent.__testGetActiveMovementLease()?.kind!=='survival-critical')return;changed=true;
  if(mode==='pause')f.task.cancellationToken.pause();else{foreign=f.agent.__testClaimMovementLease('task','foreign-field');profile=new(require('mineflayer-pathfinder').Movements)(f.bot);f.bot.pathfinder.setMovements(profile);}};
 f.bot.on('physicsTick',steer);t.after(()=>f.bot.removeListener('physicsTick',steer));
 const run=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0},{resource:'house_field_wood',graphCheckpoint:{get:()=>cp,save:value=>{cp=value;}},assertGraphActive:()=>f.task.cancellationToken.throwIfRequested()});
 if(mode!=='relocate'){
  // Foreign control can be observed first by either the owner or strict profile guard.
  await assert.rejects(run,e=>/paused|cancelled|movement_preempted/.test(e.code||'')
    ||mode==='foreign'&&['house_creeper_escape_profile','house_surface_creeper_escape_profile'].includes(e.code));assert.equal(cp.visits,1);assert.equal(cp.order.length,1);
  if(mode==='foreign'){assert.equal(f.agent.__testGetActiveMovementLease(),foreign);assert.equal(f.bot.pathfinder.movements,profile);}return;
 }
 const result=await run;assert.equal(result.moved,true);assert.equal(cp.visits,2);assert.equal(cp.order.length,2);
 const receipt=diagnostics().find(e=>e.event==='house_site_defense_relocated').details;
 assert.equal(receipt.oldTargetReached,false);assert.equal(receipt.oldEdgeTraversalCredit,false);
 const relocated=Object.values(cp.nodes).find(node=>node.survivalRelocation);assert.ok(relocated);assert.equal(relocated.survivalRelocation.oldEdgeTraversalCredit,false);
 assert.equal(cp.nodes[`${receipt.abandonedTarget.x},${receipt.abandonedTarget.y},${receipt.abandonedTarget.z}`],undefined);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.entity.onGround,true);assert.equal(f.attacks.length,0);
});

test('failed resource defense cannot let the old provisioning action equip food after its lease is released',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false});prepareHouseResourceGroup(f,null);
 await f.agent.__testWithHouseResourceWork(async api=>{
  for(let id=3;id<20;id++)f.bot.entities[id]={id,name:'creeper',type:'hostile',isValid:true,
   entityType:registry.entitiesByName.creeper.id,height:1.7,position:new Vec3(-5.5,1,.5)};
  await assert.rejects(f.agent.__testHandleSurvivalCritical('resource_failed_owner'),{code:'house_creeper_escape_threat_limit'});
  for(let id=3;id<20;id++)delete f.bot.entities[id];
  let equips=0;f.bot.equip=async()=>{equips++;};
  await assert.rejects(api.equip({name:'rabbit',type:registry.itemsByName.rabbit.id,count:1}),{code:'house_creeper_escape_threat_limit'});
  assert.equal(equips,0);assert.equal(f.agent.__testGetActiveMovementLease(),null);
 });
});

test('automatic paused safety uses its own captured lease for a real surface stance without resuming paused work',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie',killAfter:3});prepareHouseResourceGroup(f,null);
 f.task.status='paused';f.task.automaticSurvivalRecovery=true;const token=f.task.cancellationToken;token.pause();f.task.movementLease=null;
 f.bot.entities[4].position=new Vec3(1.5,1,.5);const generation=f.task.executionGeneration;
 let moved=false;const equip=f.bot.equip;
 f.bot.equip=async(...args)=>{if(!moved){moved=true;await f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(-1,1,0),2000);assert.ok(f.bot.entity.position.x<0);assert.equal(f.agent.__testGetActiveMovementLease()?.kind,'survival-critical');}return equip(...args);};
 await f.agent.__testHandleSurvivalCritical('paused_cover_stance');
 assert.equal(moved,true);assert.ok(f.attempts.length>=1);assert.equal(f.attacks.length,3);
 assert.equal(f.task.status,'paused');assert.equal(f.task.cancellationToken,token);assert.equal(token.pauseRequested,true);
 assert.equal(f.task.executionGeneration,generation);assert.equal(f.task.movementLease,null);assert.equal(f.agent.__testGetActiveMovementLease(),null);
});

for(const nutrition of [false,true])test(`field graph drains native shore defense while rejecting an untrusted critical-health provisioning flag: nutrition=${nutrition}`,{timeout:12000},async t=>{
 const f=fixture(t,{killAfter:4,interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';let cp,defending,immersed=false;
 const diagnostics=captureHouseSurfaceDiagnostics(f),attack=f.bot.attack;
 f.bot.attack=e=>{attack(e);if(!immersed){immersed=true;if(nutrition)f.bot.health=4;f.change('water',f.bot.entity.position.floored());f.bot.entity.isInWater=true;}};
 f.bot.once('goal_updated',()=>setTimeout(()=>{f.bot.entities[4]={id:4,name:'spider',isValid:true,entityType:registry.entitiesByName.spider.id,position:new Vec3(2.5,1,.5),height:.9};
  defending=f.agent.__testHandleSurvivalCritical('surface_owned_shore');defending.catch(()=>{});},20));
 const running=f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0},{resource:nutrition?'survival_food':'house_field_wood',fieldFoodExploration:nutrition,graphCheckpoint:{get:()=>cp,save:v=>{cp=v;}},assertGraphActive:()=>f.task.cancellationToken.throwIfRequested()});
 if(nutrition){
  // This fixture has no foodSupplyRunning/houseSelfSupply authority. A public
  // exploration flag cannot authorize continued graph work at4HP.
  await assert.rejects(running,{code:'house_surface_dry_graph_survival_limit'});await defending;
  assert.equal(immersed,true);assert.equal(f.bot.entity.onGround,true);
  assert.ok(diagnostics().some(e=>e.event==='house_emergency_shore_confirmed'));
  assert.equal(cp.visits,1);assert.equal(cp.order.length,1);assert.equal(f.bot.health,4);
  assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);return;
 }
 const result=await running;await defending;
 assert.equal(immersed,true);assert.equal(result.moved,true);assert.equal(f.bot.entity.onGround,true);
 assert.ok(diagnostics().some(e=>e.event==='house_emergency_shore_confirmed'));
 assert.ok(diagnostics().some(e=>e.event==='house_site_defense_relocated'&&e.details.oldTargetReached===false));
 assert.equal(cp.nodes[cp.current].survivalRelocation.oldEdgeTraversalCredit,false);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('surface continuation drains a second exact defense that claims the lease before its awaited handoff',{timeout:10000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:99});f.task.materialSupply={materialSource:'self_gathered'};
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 const diagnostics=captureHouseSurfaceDiagnostics(f);let first,second,n=0;
 f.bot.attack=e=>{n++;if(e.id===88||n>=3){delete f.bot.entities[e.id];f.bot.emit('entityGone',e);}};
 const make=id=>({id,name:'zombie',isValid:true,entityType:f.bot.registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(2.5,1,.5)});
 f.bot.once('goal_updated',()=>setTimeout(()=>{f.bot.entities[88]=make(88);
  first=f.agent.__testHandleSurvivalCritical('first_exact_surface_owner');
  first.then(()=>{f.bot.entities[89]=make(89);second=f.agent.__testHandleSurvivalCritical('second_exact_surface_owner');second.catch(()=>{});});first.catch(()=>{});
 },20));
 await f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(5,1,0),6000);
 await first;await second;assert.ok(n>=3);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.ok(diagnostics().some(r=>r.event==='house_surface_chained_defense_wait'));
 assert.ok(Math.abs(f.bot.entity.position.x-5.5)<1);assert.equal(f.bot.pathfinder.goal,null);
});

test('independent native defenses retain the original leg deadline beyond the obsolete 8.5 second handoff cap',{timeout:18000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:99});f.task.materialSupply={materialSource:'self_gathered'};
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 const diagnostics=captureHouseSurfaceDiagnostics(f);let first,second,n=0;const hits=new Map(),started=Date.now();
 f.bot.attack=e=>{n++;const count=(hits.get(e.id)||0)+1;hits.set(e.id,count);if(count>=9){delete f.bot.entities[e.id];f.bot.emit('entityGone',e);}};
 const make=id=>({id,name:'zombie',isValid:true,entityType:f.bot.registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(2.5,1,.5)});
 f.bot.once('goal_updated',()=>setTimeout(()=>{f.bot.entities[88]=make(88);
  first=f.agent.__testHandleSurvivalCritical('first_exact_surface_owner');
  first.then(()=>{f.bot.entities[89]=make(89);second=f.agent.__testHandleSurvivalCritical('second_exact_surface_owner');second.catch(()=>{});});first.catch(()=>{});
 },20));
 await f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(5,1,0),15000);
 await first;await second;assert.ok(n>=18);assert.ok(Date.now()-started>8500);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 assert.ok(diagnostics().some(r=>r.event==='house_surface_chained_defense_wait'));
 assert.ok(Math.abs(f.bot.entity.position.x-5.5)<1);assert.equal(f.bot.pathfinder.goal,null);
});

test('nearby actual resource landing reuses its owned graph with 32 retained segments without resetting budgets',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 const anchor={x:0,y:1,z:0},id='0,1,0';let cp={schema:2,kind:'loaded_dry_waypoint_graph',anchor,radius:384,step:16,nodes:{[id]:{position:anchor,parent:null,expanded:true}},order:[id],current:id,resumeNode:id,visits:1,probes:7,frontier:[],blockedEdges:[]};
 const retained=Array.from({length:32},(_,i)=>({anchor:{x:-i-1,y:1,z:0},historicalEvidence:true}));
 f.task.materialSupply.fieldWoodSearchHistory=retained;const before=JSON.stringify(retained);
 await f.agent.__testWithHouseResourceWork(async()=>{
  await f.bot.pathfinder.goto(new(require('mineflayer-pathfinder').goals.GoalBlock)(4,1,0));
  const attempts=f.attempts.length;
  const result=await f.agent.__testHouseSurfaceGraphNext(anchor,{resource:'house_field_wood',observeResourceWorkOrigin:id,
   assertGraphActive:()=>f.task.cancellationToken.throwIfRequested(),graphCheckpoint:{get:()=>cp,save:value=>{cp=value;}}});
  assert.equal(result.confirmed,true);assert.equal(cp.current,'4,1,0');assert.equal(cp.visits,2);assert.equal(cp.probes,7);
  assert.equal(result.oldEdgeTraversalCredit,false);assert.equal(f.attempts.length,attempts);
 },{deadline:Date.now()+6000});
 assert.equal(JSON.stringify(f.task.materialSupply.fieldWoodSearchHistory),before);assert.equal(f.bot.entity.onGround,true);
});
test('local route retires a genuinely interrupted checked edge and replans under its original deadline and action budget',{timeout:12000},async t=>{
 const f=fixture(t,{killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};const diagnostics=captureHouseSurfaceDiagnostics(f),deadline=Date.now()+10000;
 const moved=await f.agent.__testWithHouseResourceWork(()=>f.agent.__testRecoverHouseLocalRoute({x:4,y:1,z:0},deadline));
 assert.equal(moved,true);assert.ok(f.attacks.length>=2);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
 const replans=diagnostics().filter(e=>e.event==='house_local_route_defense_replanned');assert.ok(replans.length>0);
 assert.equal(replans[0].details.originalDeadline,deadline);assert.ok(replans[0].details.remainingActions<24);assert.equal(replans[0].details.originalStepCompleted,false);assert.equal(replans[0].details.materialCredit,false);
 assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.entity.position.floored().equals(new Vec3(4,1,0)),true);
});
test('local passage interrupted during a modeled native dig waits for real defense ownership then reinspects the unchanged block',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:2});f.task.materialSupply={materialSource:'self_gathered'};const diagnostics=captureHouseSurfaceDiagnostics(f),deadline=Date.now()+10000;
 // The modeled server cancels the first native dig; it does not grant an AIR
 // ACK. The second dig must follow the actual original-Physics defense.
 let digs=0,rejectDig,defense;f.change('dirt',new Vec3(1,1,0));f.change('stone',new Vec3(1,3,0));
 for(let x=-1;x<=5;x++)for(const z of [-1,1])for(let y=1;y<=3;y++)f.change('stone',new Vec3(x,y,z));
 f.bot.canDigBlock=()=>true;f.bot.canSeeBlock=()=>true;f.bot.digTime=()=>100;
 f.bot.stopDigging=()=>{rejectDig?.(Object.assign(Error('native dig interrupted'),{code:'movement_preempted'}));};
 f.bot.dig=async block=>{digs++;if(digs===1){const pending=new Promise((_resolve,reject)=>{rejectDig=reject;});setTimeout(()=>{f.bot.entities[2]={id:2,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.99,position:new Vec3(-1.5,1,.5)};defense=f.agent.__testHandleSurvivalCritical('local_dig_interruption');defense.catch(()=>{});},10);return pending;}f.change('air',block.position);f.bot.emit('diggingCompleted',block);};
 const moved=await f.agent.__testWithHouseResourceWork(()=>f.agent.__testRecoverHouseLocalRoute({x:3,y:1,z:0},deadline));if(defense)await defense;
 assert.equal(moved,true);assert.ok(digs>=2);assert.equal(f.bot.blockAt(new Vec3(1,1,0)).name,'air');assert.equal(f.attacks.length,2);
 assert.ok(diagnostics().some(e=>e.event==='house_local_route_defense_replanned'&&e.details.remainingActions<24));assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
test('bare13HP armed survivor chooses an actual covered native route before charging a7m archer',{timeout:12000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};f.bot.health=13;f.bot.inventory.slots[45]=null;
 const weapon={name:'wooden_sword',type:registry.itemsByName.wooden_sword.id,count:1};f.bot.inventory.items=()=>[weapon];f.bot.heldItem=weapon;
 for(let z=2;z<=8;z++)for(let y=1;y<=2;y++)f.change('stone',new Vec3(4,y,z));
 f.bot.entities[2]={id:2,name:'skeleton',type:'hostile',isValid:true,entityType:registry.entitiesByName.skeleton.id,height:1.99,position:new Vec3(7,1,.5)};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('bare13HP_precontact_cover'));
 assert.equal(f.attacks.length,0);assert.ok(f.bot.entity.position.distanceTo(new Vec3(.5,1,.5))>1);
 assert.equal(require('../vendor/server/minecraft/houseRangedCover').rangedCoverConfirmed(f.bot,f.bot.entity.position,[f.bot.entities[2]]),true);
 assert.ok(diagnostics().some(e=>e.event==='house_ranged_target_locked'&&e.details.decision==='cover'));assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
test('three separately completed native defenses can resume one surface goal under its same original deadline',{timeout:10000},async t=>{
 const f=fixture(t,{interruptions:3,deferInitialThreat:true});f.task.materialSupply={materialSource:'self_gathered'};f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 const diagnostics=captureHouseSurfaceDiagnostics(f),started=Date.now();
 await f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(5,1,0),7000);
 if(f.interruption())await f.interruption();const resumed=diagnostics().filter(e=>e.event==='house_surface_self_defense_resumed');
 assert.ok(resumed.length>=3);assert.equal(new Set(resumed.map(e=>e.details.originalDeadline)).size,1);assert.ok(Date.now()-started<7000);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.entity.position.floored().equals(new Vec3(5,1,0)),true);
});
test('real step watchdog accepts owned native physics motion even when rapid child interruptions never published a heartbeat',{timeout:13000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 const step={skill:'build_furnished_house_phase',args:{schema:2,profile:'cottage',phase:'prepare_materials',materialSource:'self_gathered'}};f.task.plan.steps=[step];f.task.lastHeartbeatAt=null;const diagnostics=captureHouseSurfaceDiagnostics(f),started=Date.now();
 await assert.rejects(f.agent.__testExecuteStepWithWatchdog(f.task,step,{beforePrepare:async()=>{
  f.task.actionState='waiting_for_physical_signal';f.bot.pathfinder.movements.allowSprinting=false;
  await f.bot.pathfinder.goto(new(require('mineflayer-pathfinder').goals.GoalBlock)(90,1,0));
  assert.equal(f.task.watchdogAbortMessage,'');assert.equal(f.task.lastHeartbeatAt,null);throw Object.assign(Error('native observer complete'),{code:'native_observer_complete'});
 }}),{code:'native_observer_complete'});
 assert.ok(Date.now()-started>6500);assert.ok(diagnostics().some(e=>e.event==='step_owned_native_motion_observed'&&e.details.taskProgressWritten===false));assert.equal(f.bot.entity.position.floored().equals(new Vec3(90,1,0)),true);
});
test('same real house step still rejects a truly stationary startup with no owned defense or native physical signal',{timeout:11000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';
 const step={skill:'build_furnished_house_phase',args:{schema:2,profile:'cottage',phase:'prepare_materials',materialSource:'self_gathered'}};f.task.plan.steps=[step];f.task.lastHeartbeatAt=null;
 await assert.rejects(f.agent.__testExecuteStepWithWatchdog(f.task,step,{beforePrepare:async()=>{f.task.actionState='waiting_for_physical_signal';await sleep(8000);}}),{code:'executor_stalled'});
 assert.equal(f.bot.entity.position.floored().equals(new Vec3(0,1,0)),true);
});
test('a7m ordinary zombie does not repeatedly preempt an empty-handed surface leg after safe separation',{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false});f.task.materialSupply={materialSource:'self_gathered'};f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.bot.inventory.items=()=>[];f.bot.heldItem=null;
 f.bot.entities[24]={id:24,name:'zombie',type:'hostile',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.99,position:new Vec3(2.5,1,7.3)};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(5,1,0),4000));
 assert.equal(f.bot.entity.position.floored().equals(new Vec3(5,1,0)),true);assert.equal(f.attacks.length,0);assert.equal(diagnostics().filter(e=>e.event==='house_combat_mode_started').length,0);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});
for(const mode of ['removed','native_health_zero'])test(`same task safely resumes when its target vanishes during pre-goal native friction: ${mode}`,{timeout:6000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:99,resourceThreat:'creeper',initialVelocity:new Vec3(.06128314330408908,-.0784000015258789,-.06174936656721651)});prepareHouseResourceGroup(f,null);f.bot.entities[4].position=new Vec3(7,1,.5);
 const diagnostics=captureHouseSurfaceDiagnostics(f);let changed=false;
 const disappear=()=>{if(changed)return;changed=true;if(mode==='removed')delete f.bot.entities[4];else{f.bot.entities[4].metadata[registry.entitiesByName.creeper.metadataKeys.indexOf('health')]=0;}};
 f.bot.prependListener('physicsTick',disappear);t.after(()=>f.bot.removeListener('physicsTick',disappear));
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('initial_coast_target_loss'));
 assert.equal(changed,true);assert.equal(f.attempts.length,0);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.entity.onGround,true);
 const record=diagnostics().find(e=>e.event==='house_combat_target_absent_reobserved');assert.ok(record);assert.equal(record.details.killConfirmed,false);assert.equal(record.details.nativeGoalIssued,false);assert.equal(record.details.nativeIdleObserved,true);assert.equal(f.task.materialSupply.combatMode.phase,'resumed');
});
test('a low-health unarmed survivor recognizes zombie_villager before native injury and retreats without a chase error',{timeout:7000},async t=>{
 const f=fixture(t,{interrupt:false,resourceThreat:'zombie_villager',killAfter:99});prepareHouseResourceGroup(f,null);f.bot.health=9;f.bot.food=16;f.bot.inventory.items=()=>[];f.bot.heldItem=null;f.bot.entities[4].position=new Vec3(4.5,1,.5);
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHandleSurvivalCritical('zombie_villager_before_injury'));
 assert.ok(f.bot.entity.position.distanceTo(f.bot.entities[4].position)>=5);assert.equal(f.bot.entity.onGround,true);assert.equal(f.bot.health,9);assert.equal(f.bot.entities[4].isValid!==false,true);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.ok(diagnostics().some(e=>e.event==='creeper_escape_confirmed'&&e.details.threatName==='zombie_villager'));assert.equal(diagnostics().some(e=>e.event==='native_self_aggressor_observed'),false);
});

test('world123 empty-hand pair retires knockback target chatter into joint native retreat',{timeout:25000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:100});delete f.bot.entities[2];delete f.bot.entities[3];f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 for(const [id,x,z] of [[4,3.6,.5],[5,3.6,1.2]])f.bot.entities[id]={id,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,width:.6,position:new Vec3(x,1,z)};
 // MODELED native mob knockback packets, never writes the bot actor.
 const attack=f.bot.attack;f.bot.attack=async target=>{attack(target);target.position=new Vec3(4.4,1,.5);const other=f.bot.entities[target.id===4?5:4];if(other)other.position=new Vec3(3.3,1,1.2);await sleep(1050);};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(-8,1,0),8000,{fieldExploration:false}));
 assert.ok(diagnostics().some(e=>e.event==='creeper_escape_confirmed'));
 assert.ok(diagnostics().filter(e=>e.event==='survival_threat_escalated').length<3);
 assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.equal(f.bot.entity.onGround,true);
});

test('world124 native self damage claims defense before the next physics callback',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:1});delete f.bot.entities[2];delete f.bot.entities[3];
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered'};
 const mob={id:4,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(2.5,1,.5)};f.bot.entities[4]=mob;
 await f.agent.__testWithHouseResourceWork(async()=>{
  f.bot.emit('entityHurt',f.bot.entity,mob);
  assert.equal(f.agent.__testGetActiveMovementLease()?.kind,'survival-critical','native event must synchronously reserve defense before any later tick');
  await until(()=>f.agent.__testGetActiveMovementLease()===f.task.movementLease,5000);
 });
 assert.ok(f.attacks.length);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('world124 known nearby melee is handled before the first ordinary surface goal',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:100});delete f.bot.entities[2];delete f.bot.entities[3];
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 f.bot.entities[4]={id:4,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(4.5,1,.5)};
 const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testWithHouseResourceWork(()=>f.agent.__testHouseSurfacePathfinderGoto(new(require('mineflayer-pathfinder').goals.GoalBlock)(-8,1,0),8000));
 const mode=diagnostics().find(e=>e.event==='house_combat_mode_started');assert.equal(mode.details.trigger,'house_surface_preflight');
 assert.ok(diagnostics().some(e=>e.event==='creeper_escape_confirmed'));assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('world127 native ice defense settles before registering its final graph origin',{timeout:12000},async t=>{
 const Block=require('prismarine-block')(registry);
 const f=fixture(t,{interrupt:false,killAfter:100,worldAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[p.y<1?'ice':'air'].defaultState),{position:p})});
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered'};
 f.task.siteSearch={kind:'loaded_natural_house_site_search',ownerIdentity:{taskId:f.task.taskId,generation:0}};
 f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 const e={id:4,name:'creeper',type:'mob',isValid:true,entityType:registry.entitiesByName.creeper.id,height:1.7,position:new Vec3(5.5,1,2.5),metadata:[]};f.bot.entities[4]=e;
 let cp,registration;const diagnostics=captureHouseSurfaceDiagnostics(f);
 await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0},{resource:'house_site_cottage',graphCheckpoint:{get:()=>cp,save:v=>{cp=v;const n=v.nodes?.[v.current];if(!registration&&(n?.survivalRelocation||n?.resourceWorkLanding))registration={current:v.current,actual:`${Math.floor(f.bot.entity.position.x)},1,${Math.floor(f.bot.entity.position.z)}`,vx:f.bot.entity.velocity.x,vz:f.bot.entity.velocity.z};}},assertGraphActive:()=>f.task.cancellationToken.throwIfRequested()});
 assert.ok(registration);assert.equal(registration.vx,0);assert.equal(registration.vz,0);assert.equal(registration.current,registration.actual);
 assert.ok(diagnostics().some(e=>e.event==='house_site_defense_relocated'&&e.details.oldTargetReached===false));
});

test('world129 stationary house planning observes a6m creeper before any movement goal',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:100});delete f.bot.entities[2];f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 f.bot.entities[4]={id:4,name:'creeper',type:'mob',isValid:true,entityType:registry.entitiesByName.creeper.id,height:1.7,position:new Vec3(6.5,1,.5),metadata:[]};
 const diagnostics=captureHouseSurfaceDiagnostics(f);assert.equal(f.bot.pathfinder.goal,null);
 assert.equal(await f.agent.__testHandleSurvivalCritical('house_graph_query_preflight'),true);
 assert.ok(diagnostics().some(e=>e.event==='creeper_escape_confirmed'));assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);
});

test('world133 unattributed native self hurt still immediately reserves the same defense owner',{timeout:8000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:1});f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered'};
 f.bot.entities[4]={id:4,name:'zombie',type:'mob',isValid:true,entityType:registry.entitiesByName.zombie.id,height:1.95,position:new Vec3(2.5,1,.5)};
 await f.agent.__testWithHouseResourceWork(async()=>{f.bot.emit('entityHurt',f.bot.entity);assert.equal(f.agent.__testGetActiveMovementLease()?.kind,'survival-critical');await until(()=>f.agent.__testGetActiveMovementLease()===f.task.movementLease,5000);});
 assert.ok(f.attacks.length);
});

test('world137 renewed exact defense during native ice origin settling returns to the same graph owner',{timeout:20000},async t=>{
 const f=fixture(t,{interrupt:false,killAfter:100,worldAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[p.y<1?'ice':'air'].defaultState),{position:p})});
 f.task.intent='build_furnished_house';f.task.currentStep='build_furnished_house_phase';f.task.materialSupply={materialSource:'self_gathered'};f.task.siteSearch={kind:'loaded_natural_house_site_search',ownerIdentity:{taskId:f.task.taskId,generation:0}};
 f.bot.inventory.items=()=>[];f.bot.inventory.count=()=>0;f.bot.heldItem=null;
 const mob={id:4,name:'creeper',type:'mob',isValid:true,entityType:registry.entitiesByName.creeper.id,height:1.7,position:new Vec3(5.5,1,2.5),metadata:[]};f.bot.entities[4]=mob;
 let cp,renewed=false;const diagnostics=captureHouseSurfaceDiagnostics(f);
 const chase=()=>{if(!renewed&&f.agent.__testGetActiveMovementLease()===f.task.movementLease&&diagnostics().some(e=>e.event==='creeper_escape_confirmed')){renewed=true;mob.position=f.bot.entity.position.offset(6.5,0,0);}};
 f.bot.on('physicsTick',chase);t.after(()=>f.bot.removeListener('physicsTick',chase));
 await f.agent.__testHouseSurfaceGraphNext({x:0,y:1,z:0},{resource:'house_site_cottage',graphCheckpoint:{get:()=>cp,save:v=>{cp=v;}},assertGraphActive:()=>f.task.cancellationToken.throwIfRequested()});
 assert.ok(renewed);assert.ok(diagnostics().filter(e=>e.event==='creeper_escape_confirmed').length>=2);assert.equal(f.agent.__testGetActiveMovementLease(),f.task.movementLease);assert.ok(cp.visits>=2);
});
