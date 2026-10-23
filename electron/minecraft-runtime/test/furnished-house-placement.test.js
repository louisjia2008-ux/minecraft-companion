/* global require, process, setInterval, clearInterval, setTimeout, clearTimeout */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const WorldSync = require('prismarine-world/src/worldsync');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { createMinecraftTaskAgent, configureFurnishedHouseDoorTraversal } = require('../vendor/server/minecraftTaskAgent');
const { createFurnishedHouseBlueprint } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { getFurnishedHouseScaffoldCleanupOrder } = require('../vendor/server/minecraft/furnishedHouseBuilder');
const { CancellationToken } = require('../vendor/server/minecraft/agentControl');
const { createHouseMaterialRecipes } = require('../vendor/server/minecraft/houseMaterialRecipes');

function furnishedPlacementFixture(t, initialPosition, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-placement-physics-'));
  const env = { MC_AGENT_LEARNING_PATH: path.join(dir, 'learning.json'),
    MC_AGENT_DIAGNOSTICS_DIR: path.join(dir, 'diagnostics'), MC_AGENT_DISCONNECT_TRACE_PATH: path.join(dir, 'disconnect.jsonl') };
  const previousEnvironment = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const target = new Vec3(94, 63, 171);
  const cells = new Map();
  const actualProperties = new Map();
  const packets = [];
  const rotationPackets = [];
  const derivedResponses = [];
  let derivedTimer;
  let serverYaw = 0;
  const placedItem = options.item || 'furnace';
  if (options.interactiveAnchor) cells.set(target.offset(0, -1, 0).toString(), 'crafting_table');
  const controls = [];
  let windowsClosed = 0;
  let count = options.count ?? 1;
  const bot = Object.assign(new EventEmitter(), {
    registry, version: '1.21.8', username: 'DeskPet', health: 20, food: 20, isAlive: true,
    game: { minY: -64, height: 384, dimension: 'overworld', gameMode: 'survival' },
    entities: {}, players: {}, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    player: { ping: 1 }, _client: { state: 'play', socket: { writable: true, destroyed: false } },
    controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
    entity: { position: initialPosition.clone(), velocity: new Vec3(0, 0, 0), onGround: true,
      eyeHeight: 1.62, height: 1.8, width: 0.6, yaw: 0, pitch: 0, effects: {}, attributes: {},
      isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false,
      isCollidedVertically: true, elytraFlying: false },
  });
  const item = () => ({ name: placedItem, type: registry.itemsByName[placedItem].id, count, metadata: 0 });
  bot.inventory = { slots: [], items: () => count ? [item()] : [],
    count: (type) => type === registry.itemsByName[placedItem].id ? count : 0 };
  bot.blockAt = (point) => {
    const position = point.floored();
    const unsafe = options.noSafeStance && position.y === 62 && !position.equals(target.offset(0, -1, 0));
    const name = cells.get(position.toString()) ?? (position.y < 63 ? (unsafe ? 'magma_block' : 'grass_block') : 'air');
    return Object.assign(Block.fromProperties(registry.blocksByName[name].id, actualProperties.get(position.toString()) || {}, 0), { position });
  };
  bot.world = { getBlock: (point) => bot.blockAt(point), raycast: WorldSync.prototype.raycast };
  bot.findBlock = () => null;
  bot.findBlocks = () => [];
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.lookAt = async (point) => { const delta = point.minus(bot.entity.position.offset(0, 1.62, 0)); bot.entity.yaw = Math.atan2(-delta.x, -delta.z); };
  bot.setControlState = (key, value) => { controls.push({ key, value }); bot.controlState[key] = value; };
  bot.getControlState = (key) => bot.controlState[key];
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.controlState[key] = false; };
  bot.closeWindow = () => { windowsClosed += 1; bot.currentWindow = null; };
  bot.stopDigging = () => {};
  bot.deactivateItem = () => {};
  bot.equip = async () => { bot.heldItem = item(); };
  const overlaps = (point) => {
    const p = bot.entity.position;
    return p.x + 0.3 > point.x && p.x - 0.3 < point.x + 1 &&
      p.z + 0.3 > point.z && p.z - 0.3 < point.z + 1 && p.y + 1.8 > point.y && p.y < point.y + 1;
  };
  bot.supportFeature = (feature) => feature === 'blockPlaceHasInsideBlock';
  bot.swingArm = () => {};
  bot._client.write = (name, packet) => {
    if (['look', 'position_look'].includes(name)) {
      serverYaw = Math.atan2(Math.sin(Math.PI - packet.yaw * Math.PI / 180), Math.cos(Math.PI - packet.yaw * Math.PI / 180));
      rotationPackets.push({ name, yaw: packet.yaw, beforePlacements: packets.length });
    }
    if (name !== 'block_place') return;
    const position = packet.location.plus([new Vec3(0,-1,0), new Vec3(0,1,0), new Vec3(0,0,-1), new Vec3(0,0,1), new Vec3(-1,0,0), new Vec3(1,0,0)][packet.direction]);
    assert.equal(overlaps(position), false);
    assert.equal(bot.entity.onGround, true);
    const yaw = options.nativePhysics ? serverYaw : bot.entity.yaw;
    const direction = Math.abs(yaw) < 0.1 ? 'north' : Math.abs(Math.abs(yaw)-Math.PI) < 0.1 ? 'south' : yaw < 0 ? 'east' : 'west';
    const facing = ['chest', 'furnace'].includes(placedItem) ? {north:'south',south:'north',east:'west',west:'east'}[direction] : direction;
    // Vanilla pillars derive their axis from the clicked face, rather than the
    // requested blueprint properties. Keep this server response independent.
    const properties = placedItem === 'oak_log' ?
      { axis: packet.direction <= 1 ? 'y' : packet.direction <= 3 ? 'z' : 'x' } :
      { ...(options.properties || {}), facing };
    packets.push({ packet, yaw, facing, properties, feet: bot.entity.position.clone(), sneak: bot.controlState.sneak });
    cells.set(position.toString(), placedItem);
    actualProperties.set(position.toString(), properties);
    count -= 1;
    if (options.nativeMultiBlockResponse && !options.missingDerivedResponse) {
      // Emulate an independent later server update for the second door/bed
      // block. The response position follows the actual native facing packet.
      const step = { north: [0,0,-1], south: [0,0,1], east: [1,0,0], west: [-1,0,0] }[facing];
      const derivedPosition = placedItem === 'oak_door' ? position.offset(0,1,0) : position.offset(...step);
      const derivedProperties = placedItem === 'oak_door' ?
        { facing, half: 'upper', hinge: 'left', open: false, powered: false } :
        { facing, part: 'head', occupied: false };
      derivedTimer = setTimeout(() => {
        cells.set(derivedPosition.toString(),placedItem);
        actualProperties.set(derivedPosition.toString(),derivedProperties);
        derivedResponses.push({ at:Date.now(),position:derivedPosition,properties:derivedProperties });
      }, options.derivedDelayMs ?? 200);
    }
  };
  require('mineflayer/lib/plugins/generic_place')(bot);
  require('mineflayer/lib/plugins/place_block')(bot);
  if (options.nativePhysics) {
    bot._client = Object.assign(new EventEmitter(), bot._client);
    require('mineflayer/lib/plugins/physics')(bot, {});
    bot.emit('login');
    bot._client.emit('position', { x: initialPosition.x, y: initialPosition.y, z: initialPosition.z,
      yaw: 180, pitch: 0, flags: {} });
  } else bot.physics = Physics(registry, bot.world);
  pathfinder(bot);
  const timer = options.nativePhysics ? null : setInterval(() => {
    bot.physics.simulatePlayer(new PlayerState(bot, bot.controlState), bot.world).apply(bot);
    bot.emit('physicsTick');
  }, 10);
  const agent = createMinecraftTaskAgent({ appPaths: { appDataDir: dir },
    readConfig: () => ({ mcExecutorMode: 'strict-executor' }), parseJsonObjectFromText: JSON.parse,
    broadcast: () => {}, broadcastMinecraftError: () => {}, allowAutonomousMaintenance: () => false });
  agent.attachBot(bot);
  const task = { taskId: 'placement-physics', status: 'running', source: 'deskpet',
    executionGeneration: 0, cancellationToken: new CancellationToken(),
    logs: [], currentStepIndex: 0, currentStep: 'mine_resource', plan: { steps: [] } };
  task.movementLease = agent.__testClaimMovementLease('task', task.taskId);
  agent.__testSetReconnectTask(task);
  t.after(() => {
    clearInterval(timer);
    clearTimeout(derivedTimer);
    if (options.nativePhysics) bot.emit('end');
    agent.__testSetReconnectTask(null);
    agent.detachBot('manual_disconnect');
    agent.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { bot, agent, target, overlaps, controls, packets, rotationPackets, derivedResponses, cells, actualProperties, remaining: () => count, setCount: (next) => { count = next; },
    windowsClosed: () => windowsClosed };
}

test('only a complete, actually open door with a clear body column becomes a house navigation passage', (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5));
  const lower = new Vec3(96, 63, 171);
  const upper = lower.offset(0, 1, 0);
  const movements = configureFurnishedHouseDoorTraversal(new Movements(f.bot));
  const read = (p) => movements.getBlock(p, 0, 0, 0);
  for (const facing of ['north', 'south', 'east', 'west']) {
    for (const hinge of ['left', 'right']) {
      for (const [p, half] of [[lower, 'lower'], [upper, 'upper']]) {
        f.cells.set(p.toString(), 'oak_door');
        f.actualProperties.set(p.toString(), { facing, hinge, half, open: true, powered: false });
      }
      for (const p of [lower, upper]) {
        const before = f.bot.blockAt(p);
        assert.equal(before.boundingBox, 'block', 'The native open door still has a real collision panel');
        assert.equal(read(p).safe, true);
        assert.equal(read(p).physical, false);
        assert.equal(read(p).replaceable, false);
        assert.deepEqual(f.bot.blockAt(p).shapes, before.shapes);
        assert.equal(f.bot.blockAt(p).stateId, before.stateId);
      }
    }
  }
  const properties = { facing: 'north', hinge: 'left', open: true, powered: false };
  const restore = () => {
    f.cells.set(upper.toString(), 'oak_door');
    f.actualProperties.set(lower.toString(), { ...properties, half: 'lower' });
    f.actualProperties.set(upper.toString(), { ...properties, half: 'upper' });
  };
  for (const other of [{ open: false }, { facing: 'south' }, { hinge: 'right' }, { half: 'lower' }]) {
    restore();
    f.actualProperties.set(upper.toString(), { ...properties, half: 'upper', ...other });
    assert.equal(read(lower).safe, false, 'An inconsistent or closed other half cannot authorize a passage');
  }
  restore(); f.cells.set(upper.toString(), 'air');
  assert.equal(read(lower).safe, false);
  restore(); movements.blocksToAvoid.add(f.bot.blockAt(lower).type);
  assert.equal(read(lower).safe, false, 'Existing exclusions remain authoritative');
  movements.blocksToAvoid.clear();
  const blockAt = f.bot.blockAt;
  f.bot.blockAt = (p) => p.floored().equals(upper) ? null : blockAt(p);
  assert.equal(read(lower).safe, false, 'Unknown upper cells are not assumed open');
  f.bot.blockAt = (p) => {
    const block = blockAt(p);
    if (p.floored().equals(upper)) block.shapes = [[0, 0, 0, 1, 1, 1]];
    return block;
  };
  assert.equal(read(lower).safe, false, 'An open flag cannot override a full collision shape');
  f.bot.blockAt = (p) => {
    const block = blockAt(p);
    if (p.floored().equals(upper)) block.getProperties = () => ({ ...properties, half: 'upper', waterlogged: true });
    return block;
  };
  assert.equal(read(lower).safe, false, 'Waterlogged door cells remain blocked');
});

test('door waypoint compatibility is idempotent, house-scoped, and removed when its bot ends', (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5));
  for (const [y, half] of [[63, 'lower'], [64, 'upper']]) {
    const p = new Vec3(96, y, 171);
    f.cells.set(p.toString(), 'oak_door');
    f.actualProperties.set(p.toString(), { facing: 'north', hinge: 'left', half, open: true, powered: false });
  }
  const before = f.bot.listenerCount('path_update');
  const house = configureFurnishedHouseDoorTraversal(new Movements(f.bot));
  assert.equal(configureFurnishedHouseDoorTraversal(house), house);
  configureFurnishedHouseDoorTraversal(new Movements(f.bot));
  assert.equal(f.bot.listenerCount('path_update'), before + 1);
  const waypoint = () => ({ x: 96.296875, y: 64, z: 171.5, toBreak: [], toPlace: [] });
  const original = waypoint();
  f.bot.pathfinder.setMovements(new Movements(f.bot));
  const ordinary = { path: [waypoint()] };
  f.bot.emit('path_update', ordinary);
  assert.deepEqual(ordinary.path[0], original, 'Other tasks retain their original pathfinder behavior');
  f.bot.pathfinder.setMovements(house);
  const actual = f.bot.blockAt(new Vec3(96, 63, 171));
  const adjusted = { path: [waypoint()] };
  f.bot.emit('path_update', adjusted);
  assert.equal(adjusted.path[0].y, 63, 'Doorway feet stay on the floor rather than on top of the door panel');
  assert.equal(adjusted.path[0].x, 96.59375, 'The point lies in the center of the actual clear opening');
  assert.equal(f.bot.blockAt(actual.position).stateId, actual.stateId);
  assert.deepEqual(f.bot.blockAt(actual.position).shapes, actual.shapes);
  f.actualProperties.set(new Vec3(96, 64, 171).toString(), { facing: 'north', hinge: 'left', half: 'upper', open: false });
  const closed = { path: [waypoint()] };
  f.bot.emit('path_update', closed);
  assert.deepEqual(closed.path[0], original, 'A late closing update cannot authorize a passage');
  f.bot.emit('end');
  assert.equal(f.bot.listenerCount('path_update'), before);
});

for (const open of [true, false]) {
  test(`native house physics ${open ? 'exits and re-enters through an opened door' : 'cannot cross a closed door'}`, { timeout: 8000 }, async (t) => {
    const f = furnishedPlacementFixture(t, new Vec3(96.5, 63, 172.5), { count: 0 });
    for (let x = 94; x <= 98; x += 1) {
      for (let z = 170; z <= 176; z += 1) {
        if (x !== 94 && x !== 98 && z !== 170 && z !== 176) continue;
        for (const y of [63, 64]) f.cells.set(new Vec3(x, y, z).toString(), 'cobblestone');
      }
    }
    for (const [y, half] of [[63, 'lower'], [64, 'upper']]) {
      const p = new Vec3(96, y, 170);
      f.cells.set(p.toString(), 'oak_door');
      f.actualProperties.set(p.toString(), { facing: 'north', hinge: 'left', half, open, powered: false });
    }
    const paths = [];
    f.bot.on('path_update', (update) => paths.push({ status: update.status, path: update.path }));
    await f.agent.__testWithFurnishedHouseMovements(async () => {
      assert.equal(f.bot.pathfinder.movements.canDig, false);
      await f.bot.pathfinder.goto(new goals.GoalBlock(96, 63, 169)).catch((error) => {
        if (open) throw error;
      });
      if (open) {
        assert.ok(f.bot.entity.position.z < 170, 'Actual physical feet must reach the exterior');
        await f.bot.pathfinder.goto(new goals.GoalBlock(96, 63, 172));
        assert.ok(f.bot.entity.position.z > 171, 'Actual physical feet must return inside');
      } else {
        assert.ok(paths.some((entry) => entry.status === 'noPath'));
        assert.ok(f.bot.entity.position.z > 171);
      }
    });
    assert.equal(f.bot.blockAt(new Vec3(96, 63, 170)).getProperties().open, open);
    assert.equal(f.packets.length, 0, 'Traversal does not place or interact with additional blocks');
    assert.ok(paths.every((update) => update.path.every((node) => !node.toBreak.length && !node.toPlace.length)));
  });
}

function installTallCornerWorld(fixture, backCorner, platform) {
  const corner = new Vec3(100, 66, backCorner ? 179 : 171);
  for (let x = 94; x <= 100; x += 1) {
    for (let z = 171; z <= 179; z += 1) fixture.cells.set(new Vec3(x,63,z).toString(), 'oak_planks');
  }
  fixture.cells.set(corner.offset(0,-2,0).toString(), 'oak_log');
  fixture.cells.set(corner.offset(0,-1,0).toString(), 'oak_log');
  if (platform) {
    fixture.cells.set(new Vec3(103,63,corner.z).toString(), 'dirt');
    fixture.cells.set(new Vec3(102,63,corner.z).toString(), 'dirt');
    fixture.cells.set(new Vec3(102,64,corner.z).toString(), 'dirt');
  }
  return corner;
}

for (const backCorner of [false, true]) {
  test(`native physics uses a supported two-level platform for the ${backCorner ? 'back' : 'front'} high pillar`, { timeout: 16000 }, async (t) => {
    const start = new Vec3(97.5,64,175.5);
    const f = furnishedPlacementFixture(t, start, { item: 'oak_log', nativePhysics: true });
    const target = installTallCornerWorld(f, backCorner, true);
    const route = [];
    f.bot.on('path_update', (update) => route.push({ status: update.status,
      path: update.path.map((node) => ({ x: node.x, y: node.y, z: node.z })) }));
    await f.bot.waitForTicks(1);
    await f.agent.__testPlaceFurnishedHouseBlock({ id: 'supported-high-corner', item: 'oak_log', position: target, properties: { axis: 'y' } });
    assert.equal(f.packets.length, 1);
    const placement = f.packets[0];
    assert.equal(placement.packet.direction, 1, 'Vertical log must click the real top face');
    assert.deepEqual(placement.properties, { axis: 'y' });
    assert.equal(f.bot.blockAt(target).getProperties().axis, 'y');
    assert.ok(Math.abs(placement.feet.y - 65) < 0.07, 'Actual physics raises the feet one block above the house floor');
    assert.ok(placement.feet.distanceTo(start) > 3, 'The installed pathfinder must physically travel to the platform');
    assert.ok(route.some((update) => update.status === 'success' && update.path.some((node) => node.y === 65)));
    assert.equal(f.agent.__testFurnishedHouseStandingSafely(placement.feet), true);
    assert.equal(f.remaining(), 0);
  });
}

test('a ground-only high pillar rejects an invisible top face without sending placement', { timeout: 4000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(97.5,64,175.5), { item: 'oak_log', nativePhysics: true });
  const target = installTallCornerWorld(f, true, false);
  await f.bot.waitForTicks(1);
  await assert.rejects(f.agent.__testPlaceFurnishedHouseBlock({ id: 'unsupported-high-corner', item: 'oak_log', position: target, properties: { axis: 'y' } }),
    (error) => error.code === 'placement_no_safe_stance');
  assert.equal(f.packets.length, 0);
  assert.equal(f.bot.blockAt(target).name, 'air');
  assert.equal(f.remaining(), 1);
});

for (const backCorner of [false, true]) {
  test(`native physics escapes the ${backCorner ? 'back' : 'front'} wall top over three adjacent one-block steps`, { timeout: 14000 }, async (t) => {
    const corner = new Vec3(100,66,backCorner ? 179 : 171);
    const start = corner.offset(0.5,1,0.5);
    const f = furnishedPlacementFixture(t, start, { nativePhysics: true });
    for (let x=94; x<=100; x+=1) {
      for (let z=171; z<=179; z+=1) f.cells.set(new Vec3(x,63,z).toString(), 'oak_planks');
    }
    for (let y=64; y<=66; y+=1) f.cells.set(new Vec3(corner.x,y,corner.z).toString(),'oak_log');
    const direction = backCorner ? 1 : -1;
    for (let distance=1; distance<=3; distance+=1) {
      for (let level=0; level<4-distance; level+=1) {
        f.cells.set(new Vec3(corner.x,63+level,corner.z+direction*distance).toString(),'dirt');
      }
    }
    const target = new Vec3(corner.x,63,corner.z+direction*4);
    const routes=[]; const groundedHeights=[];
    f.bot.on('path_update',(update)=>routes.push({status:update.status,
      nodes:update.path.map((node)=>({x:node.x,y:node.y,z:node.z}))}));
    f.bot.on('physicsTick',()=>{if(f.bot.entity.onGround)groundedHeights.push(f.bot.entity.position.y);});
    await f.bot.waitForTicks(1);
    await f.agent.__testWithFurnishedHouseMovements(async()=>{
      assert.equal(f.bot.pathfinder.movements.maxDropDown,2,'Installed movement floor semantics allow only a real one-block drop');
      assert.equal(f.bot.pathfinder.movements.allowParkour,false);
      assert.equal(f.bot.pathfinder.movements.canDig,false);
      assert.deepEqual(f.bot.pathfinder.movements.scafoldingBlocks,[]);
      await f.bot.pathfinder.goto(new goals.GoalBlock(target.x,target.y,target.z));
      // Native goto can resolve during the final 0.92-block descent. Observe
      // real physics reaching support; never assign a target position/velocity.
      await f.bot.waitForTicks(5);
    });
    assert.equal(f.bot.entity.onGround,true);
    assert.ok(Math.abs(f.bot.entity.position.y-target.y)<0.07);
    assert.ok(f.bot.entity.position.distanceTo(target.offset(0.5,0,0.5))<0.4);
    const successful=routes.find((route)=>route.status==='success');
    assert.ok(successful,'The installed pathfinder must produce a real route');
    for(const y of [66,65,64,63]) assert.ok(successful.nodes.some((node)=>node.y===y),`Safe exit traverses actual foot level ${y}`);
    let previous=start.y;
    for(const node of successful.nodes){assert.ok(previous-node.y<=1,'No route edge may skip a stair and drop two blocks');previous=node.y;}
    for(const y of [66,65,64,63]) assert.ok(groundedHeights.some((height)=>Math.abs(height-y)<0.07),`Actual physics lands on support at ${y}`);
    assert.equal(f.packets.length,0,'Escape cannot place, dig, bridge, or teleport');
  });
}


for (const [item, facing] of [['oak_stairs', 'south'], ['chest', 'west']]) {
  test(`native physics sends the server rotation before placing ${item}`, { timeout: 6000 }, async (t) => {
    const properties = item === 'oak_stairs' ? { facing, half: 'bottom', shape: 'straight', waterlogged: false } : { facing };
    const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5), { item, properties, nativePhysics: true });
    await f.bot.waitForTicks(1);
    await f.agent.__testPlaceFurnishedHouseBlock({ id: 'server-rotation-order', item, position: f.target, properties });
    assert.equal(f.packets.length, 1);
    assert.equal(f.packets[0].facing, facing, 'Placement must use the last rotation actually sent, never the local client angle');
    assert.ok(f.rotationPackets.some((packet) => packet.beforePlacements === 0 &&
      Math.abs(Math.atan2(Math.sin(Math.PI - packet.yaw * Math.PI / 180 - f.packets[0].yaw),
        Math.cos(Math.PI - packet.yaw * Math.PI / 180 - f.packets[0].yaw))) < 0.01));
  });
}

test('native placement sends rotation even when an earlier forced look already set the local angle', { timeout: 6000 }, async (t) => {
  const properties = { facing: 'south', half: 'bottom', shape: 'straight', waterlogged: false };
  const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5), { item: 'oak_stairs', properties, nativePhysics: true });
  await f.bot.waitForTicks(1);
  await f.bot.look(Math.PI, 0, true);
  assert.equal(f.rotationPackets.length, 1, 'Forced look changes local state without sending a server rotation');
  await f.agent.__testPlaceFurnishedHouseBlock({ id: 'server-rotation-already-local', item: 'oak_stairs', position: f.target, properties });
  assert.equal(f.packets.length, 1);
  assert.equal(f.packets[0].facing, 'south');
  assert.ok(f.rotationPackets.slice(1).some((packet) => packet.beforePlacements === 0 && Math.abs(packet.yaw) < 0.01));
});

for (const [item, facing, yaw] of [['furnace', 'west', -Math.PI/2], ['chest', 'west', -Math.PI/2], ['oak_stairs', 'east', -Math.PI/2], ['white_bed', 'north', 0], ['oak_door', 'north', 0]]) {
  test(`native generic placement preserves cardinal yaw for ${item}`, { timeout: 6000 }, async (t) => {
    const properties = item === 'oak_stairs' ? { facing, half: 'bottom', shape: 'straight', waterlogged: false } : { facing };
    const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5), { item, properties, interactiveAnchor: true });
    await f.agent.__testPlaceFurnishedHouseBlock({ id: 'native-directional', item, position: f.target, properties });
    assert.equal(f.packets.length, 1);
    assert.equal(f.packets[0].yaw, yaw);
    assert.equal(f.packets[0].facing, facing);
    assert.equal(f.packets[0].packet.direction, 1);
    assert.equal(f.packets[0].sneak, true);
    assert.equal(f.bot.controlState.sneak, false);
    assert.equal(f.remaining(), 0);
  });
}

test('actual half slab support is accepted only at its collision top with empty headroom', (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5));
  const position = new Vec3(96,63,171);
  f.cells.set(position.toString(), 'oak_slab');
  f.actualProperties.set(position.toString(), { type: 'bottom', waterlogged: false });
  assert.equal(f.agent.__testFurnishedHouseStandingSafely(position.offset(0.5,0.5,0.5)), true);
  assert.equal(f.agent.__testFurnishedHouseStandingSafely(position.offset(0.5,1,0.5)), false, 'Floating above a bottom slab has no actual support');
  f.cells.set(position.offset(0,1,0).toString(), 'oak_planks');
  assert.equal(f.agent.__testFurnishedHouseStandingSafely(position.offset(0.5,0.5,0.5)), false, 'A solid head collision is unsafe');
});

test('late settlement from an old construction cannot replace a newer task movement profile', async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5));
  let finish;
  const pending = f.agent.__testWithFurnishedHouseMovements(() => new Promise((resolve) => { finish = resolve; }));
  const newer = { taskId: 'new-construction', status: 'running', executionGeneration: 7, logs: [], plan: { steps: [] } };
  f.agent.__testSetReconnectTask(newer);
  const newMovements = new Movements(f.bot);
  newMovements.canDig = false;
  f.bot.pathfinder.setMovements(newMovements);
  finish();
  await pending;
  assert.equal(f.bot.pathfinder.movements, newMovements);
});

test('advanced material planning reports exact native raw inputs for self acquisition without placing a block', (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5, 63, 173.5));
  require('mineflayer/lib/plugins/craft')(f.bot);
  const planner = createHouseMaterialRecipes({ registry, recipesAll: (...args) => f.bot.recipesAll(...args),
    getItemCount: name => f.bot.inventory.items().filter(item => item.name === name).reduce((n, item) => n + item.count, 0) });
  const missing = planner.plan({ enchanting_table: 1 }).rawRequirements;
  assert.equal(missing.diamond, 2);
  assert.equal(missing.obsidian, 4);
  assert.equal(missing.leather, 1);
  assert.equal(missing.sugar_cane, 3);
  assert.equal(f.packets.length, 0);
});

test('real physics moves off a scaffold support before production digs it', { timeout: 10000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5, 67, 171.5));
  const target = new Vec3(94,66,171);
  for (let y = 63; y <= 66; y += 1) f.cells.set(new Vec3(94,y,171).toString(), 'dirt');
  for (let y = 63; y <= 65; y += 1) f.cells.set(new Vec3(95,y,171).toString(), 'dirt');
  const digs = [];
  f.bot.canDigBlock = () => true;
  f.bot.dig = async (block) => {
    const feet = f.bot.entity.position.clone();
    assert.equal(f.bot.entity.onGround, true);
    assert.equal(Math.abs(feet.y-target.y-1) < 0.07 && feet.x > target.x-0.3 && feet.x < target.x+1.3 &&
      feet.z > target.z-0.3 && feet.z < target.z+1.3, false, 'Never dig the shape currently supporting our feet');
    digs.push(feet);
    f.cells.set(block.position.toString(), 'air');
  };
  await f.agent.__testBreakFurnishedHouseBlock(target);
  assert.equal(digs.length, 1);
  assert.ok(digs[0].distanceTo(new Vec3(94.5,67,171.5)) > 0.5, 'Native pathfinder and physics, rather than coordinate assignment, leave the support');
  assert.equal(f.bot.blockAt(target).name, 'air');
});

test('production scaffold removal reaches the actual half slab surface before digging its old support', { timeout: 4000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5,67,171.5));
  const target = new Vec3(94,66,171);
  for (let y = 63; y <= 66; y += 1) f.cells.set(new Vec3(94,y,171).toString(), 'dirt');
  for (let y = 63; y <= 65; y += 1) f.cells.set(new Vec3(95,y,171).toString(), 'dirt');
  const slab = new Vec3(95,66,171);
  f.cells.set(slab.toString(), 'oak_slab');
  f.actualProperties.set(slab.toString(), { type: 'bottom', waterlogged: false });
  const digs = [];
  f.bot.canDigBlock = () => true;
  f.bot.dig = async (block) => {
    const feet = f.bot.entity.position.clone();
    assert.equal(f.bot.entity.onGround, true);
    assert.ok(feet.distanceTo(slab.offset(0.5,0.5,0.5)) < 0.07, 'Installed pathfinder and physics must actually arrive on the half slab');
    assert.equal(f.agent.__testFurnishedHouseStandingSafely(feet), true);
    digs.push(feet);
    f.cells.set(block.position.toString(), 'air');
  };
  await f.agent.__testBreakFurnishedHouseBlock(target);
  assert.equal(digs.length, 1);
  assert.equal(f.bot.blockAt(target).name, 'air');
  assert.equal(f.bot.blockAt(slab).name, 'oak_slab');
});

test('partial house material gathering ignores its own frame and digs the natural tree outside construction bounds', { timeout: 10000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5,63,173.5), { item: 'oak_log', count: 0 });
  const frame = new Vec3(94,63,171);
  const protectedPlatform = new Vec3(94,63,168);
  const tree = new Vec3(88,63,171);
  f.cells.set(frame.toString(), 'oak_log');
  f.cells.set(protectedPlatform.toString(), 'oak_log');
  f.cells.set(tree.toString(), 'oak_log');
  f.bot.findBlocks = ({ matching }) => [frame, protectedPlatform, tree].filter((position) => matching(f.bot.blockAt(position)));
  f.bot.canDigBlock = () => true;
  const digs = [];
  f.bot.dig = async (block) => {
    digs.push(block.position.toString());
    f.cells.set(block.position.toString(), 'air');
    f.setCount(1);
  };
  const blueprint = createFurnishedHouseBlueprint(frame, { profile: 'cottage' });
  const protectedCells = [...blueprint.blocks, ...blueprint.scaffold].map(s => s.position);
  const bounds = { minX: Math.min(...protectedCells.map(p => p.x)) - 1, maxX: Math.max(...protectedCells.map(p => p.x)) + 1,
    minZ: Math.min(...protectedCells.map(p => p.z)) - 1, maxZ: Math.max(...protectedCells.map(p => p.z)) + 1,
    minY: frame.y - 3, maxY: blueprint.bounds.maxY + 2 };
  await f.agent.__testWithHouseResourceBounds([bounds], () => f.agent.__testExecuteMineResource({ args: {
    block: 'oak_log', count: 1, skipToolPreparation: true, excludeBounds: [bounds],
  } }));
  assert.deepEqual(digs, [tree.toString()]);
  assert.equal(f.bot.blockAt(frame).name, 'oak_log');
  assert.equal(f.bot.blockAt(protectedPlatform).name, 'oak_log', 'The expanded temporary-platform footprint is protected too');
});

test('official recipe composition leaves final planks and every crafted component available together', { timeout: 15000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5,63,173.5));
  const stock = new Map([['oak_log',20], ['crafting_table',1]]);
  const item = (name, count) => ({ name, count, type: registry.itemsByName[name].id, metadata: 0, stackSize: 64 });
  f.bot.inventory.items = () => [...stock].filter(([,count]) => count > 0).map(([name,count]) => item(name,count));
  f.bot.inventory.count = (id) => stock.get(registry.items[id]?.name) || 0;
  const station = new Vec3(92,63,173);
  f.cells.set(station.toString(), 'crafting_table');
  f.bot.findBlock = ({ matching }) => matching(f.bot.blockAt(station)) ? f.bot.blockAt(station) : null;
  f.bot.findBlocks = ({ matching }) => matching(f.bot.blockAt(station)) ? [station] : [];
  require('mineflayer/lib/plugins/craft')(f.bot);
  const crafts = [];
  // This fixture tests the material ledger against installed official recipes;
  // actual window clicks and server crafting are separate live acceptance.
  f.bot.craft = async (recipe, repeats) => {
    for (const entry of recipe.delta.filter((entry) => entry.count < 0)) {
      assert.ok((stock.get(registry.items[entry.id].name) || 0) >= -entry.count * repeats);
    }
    for (const entry of recipe.delta) {
      const name = registry.items[entry.id].name;
      stock.set(name, (stock.get(name) || 0) + entry.count * repeats);
    }
    crafts.push(recipe.result.id);
  };
  const required = { oak_planks: 8, oak_stairs: 8, oak_slab: 6, chest: 1, crafting_table: 1, oak_log: 2 };
  const recipes = createHouseMaterialRecipes({ registry, recipesAll: (...args) => f.bot.recipesAll(...args),
    getItemCount: name => stock.get(name) || 0,
    craftRecipe: (recipe, repeats) => f.bot.craft(recipe, repeats) });
  await recipes.ensure(required);
  for (const [name,count] of Object.entries(required)) assert.ok(stock.get(name) >= count, `${name} must coexist after component crafting`);
  assert.ok(crafts.includes(registry.itemsByName.oak_planks.id), 'Native recipes produce the planks retained alongside all crafted components');
});

test('public furnished house preserves its complete goal when no safe self-supply camp exists', { timeout: 10000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5,63,173.5));
  f.agent.__testSetReconnectTask(null);
  require('mineflayer/lib/plugins/craft')(f.bot);
  const originalBlockAt = f.bot.blockAt;
  const expected = createFurnishedHouseBlueprint({ x: 96, y: 63, z: 175 }, { profile: 'enchanting_library' });
  const cells = [...expected.blocks, ...expected.scaffold].map(s => s.position);
  const lowX = Math.min(...cells.map(p => p.x)), highX = Math.max(...cells.map(p => p.x));
  const lowZ = Math.min(...cells.map(p => p.z)), highZ = Math.max(...cells.map(p => p.z));
  f.bot.blockAt = point => {
    const block = originalBlockAt(point);
    if (point.y < 63 && (point.x < lowX || point.x > highX || point.z < lowZ || point.z > highZ)) {
      return Object.assign(Block.fromProperties('magma_block', {}, 0), { position: point.floored() });
    }
    return block;
  };
  await f.agent.handleMessage({ type: 'mc_command_submit', command: '造一座带附魔台和书架的高级小屋', source: 'deskpet' });
  // This existing contract starts after a modeled site selection. The original
  // planner yields before execution, so install only its schema2 house anchor;
  // do not create a site-search reservation, camp, materials or ownership.
  const accepted = f.agent.__testGetReconnectTask();
  assert.equal(accepted.status, 'planning');
  accepted.stepCheckpoint = { furnishedHouse: { schema: 2, sourceProfile: 'enchanting_library',
    anchor: { ...expected.anchor }, phase: 'select_site' } };
  for (let elapsed = 0; elapsed < 5000 && f.agent.__testGetReconnectTask()?.status !== 'paused'; elapsed += 25) {
    await new Promise((resolve) => setTimeout(resolve,25));
  }
  const task = f.agent.__testGetReconnectTask();
  assert.equal(task.status, 'paused');
  assert.equal(task.errorCode, 'house_self_supply_no_camp');
  assert.match(task.error, /安全营地/);
  assert.equal(task.completionPlan.steps[0].args.profile, 'enchanting_library');
  assert.equal(task.recoveryCount || 0, 0);
  assert.equal(task.stepCheckpoint.furnishedHouse.phase, 'prepare_materials');
  assert.equal(f.packets.length, 0);
  assert.equal(task.completionPlan.steps.length, 12);
  assert.equal(task.siteSearch?.reservation, undefined);
  assert.equal(task.materialSupply, undefined);
  assert.equal(task.stepCheckpoint.furnishedHouse.ownedBlockIds, undefined);
});

test('automatic furnished house selection rejects a hazardous actual spawn while preserving its complete goal without native writes', { timeout: 10000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5,63,173.5));
  f.agent.__testSetReconnectTask(null);
  const originalBlockAt = f.bot.blockAt, originalWrite = f.bot._client.write;
  const nativeWrites = [];
  f.bot.blockAt = point => point.floored().equals(new Vec3(94,62,173))
    ? Object.assign(Block.fromStateId(registry.blocksByName.magma_block.defaultState), { position: point.floored() })
    : originalBlockAt(point);
  assert.equal(f.bot.blockAt(f.bot.entity.position.floored().offset(0,-1,0)).name, 'magma_block');
  assert.equal(f.bot.entity.onGround, true);
  assert.equal(f.bot.entity.isInWater, false);
  assert.equal(f.bot.entity.isInLava, false);
  f.bot._client.write = (name, packet) => { nativeWrites.push({ name, packet }); return originalWrite(name, packet); };
  await f.agent.handleMessage({ type: 'mc_command_submit', command: '造一座带附魔台和书架的高级小屋', source: 'deskpet' });
  for (let elapsed = 0; elapsed < 5000 && f.agent.__testGetReconnectTask()?.status !== 'paused'; elapsed += 25) {
    await new Promise((resolve) => setTimeout(resolve,25));
  }
  const task = f.agent.__testGetReconnectTask();
  assert.equal(task.status, 'paused');
  assert.equal(task.errorCode, 'house_site_search_not_grounded');
  assert.equal(task.completionPlan.steps.length, 12);
  assert.equal(task.completionPlan.steps.every(step => step.skill === 'build_furnished_house_phase'
    && step.args.profile === 'enchanting_library'), true);
  assert.equal(task.recoveryCount || 0, 0);
  assert.equal(task.materialSupply, undefined);
  assert.equal(task.siteSearch?.reservation, undefined);
  assert.equal(task.stepCheckpoint?.furnishedHouse, undefined);
  assert.deepEqual(nativeWrites, []);
  assert.equal(f.packets.length, 0);
});

test('house pathfinder profile produces no route for an actual two-block scaffold drop', { timeout: 4000 }, async (t) => {
  const f = furnishedPlacementFixture(t, new Vec3(94.5,67,171.5));
  for (let y=63; y<=66; y+=1) f.cells.set(new Vec3(94,y,171).toString(), 'dirt');
  for (let y=63; y<=64; y+=1) f.cells.set(new Vec3(95,y,171).toString(), 'dirt');
  const paths = [];
  f.bot.on('path_update', (update) => paths.push({ status: update.status, path: update.path }));
  await f.agent.__testWithFurnishedHouseMovements(() => f.bot.pathfinder.goto(new goals.GoalBlock(95,65,171)));
  // Installed goto resolves on an empty noPath result; inspect its real route
  // and physical position instead of treating promise resolution as movement.
  assert.ok(paths.some((entry) => entry.status === 'noPath' && entry.path.length === 0));
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(94.5,67,171.5)) < 0.01);
});

function installCompletedCottage(fixture, profile = 'cottage') {
  const blueprint = createFurnishedHouseBlueprint({ x: 94, y: 63, z: 171 }, { profile });
  for (const spec of [...blueprint.blocks, ...blueprint.scaffold]) {
    const position = new Vec3(spec.position.x, spec.position.y, spec.position.z);
    fixture.cells.set(position.toString(), spec.item);
    if (spec.properties) fixture.actualProperties.set(position.toString(), spec.properties);
  }
  return blueprint;
}

for (const profile of ['cottage', 'enchanting_library']) {
test(`native physics dismantles all ${profile} scaffolding from lower supported stances and reaches the entrance`, { timeout: 180000 }, async (t) => {
  // Production first reaches the entrance while all scaffold is intact.
  // Begin at that actual cleanup boundary; subsequent ascent, digging and
  // return positions all come from the installed physics/pathfinder plugins.
  const start = profile === 'cottage' ? new Vec3(97.5,63,169.5) : new Vec3(98.5,63,169.5);
  const f = furnishedPlacementFixture(t, start, { nativePhysics: true });
  const blueprint = installCompletedCottage(f, profile);
  const scaffold = getFurnishedHouseScaffoldCleanupOrder(blueprint, blueprint.scaffold);
  assert.equal(scaffold.length,profile === 'cottage' ? 52 : 60);
  const digs = [];
  const groundedHeights = [];
  f.bot.on('physicsTick', () => {
    if (f.bot.entity.onGround) groundedHeights.push(f.bot.entity.position.y);
  });
  f.bot.canDigBlock = () => true;
  f.bot.dig = async (block) => {
    const feet = f.bot.entity.position.clone();
    assert.equal(block.name,'dirt');
    assert.equal(f.bot.entity.onGround,true);
    assert.equal(f.agent.__testFurnishedHouseStandingSafely(feet),true);
    assert.ok(feet.y <= block.position.y+0.07,
      'Cleanup must stand at least one block below the target top, never return to the roof to cut off its next landing');
    assert.equal(f.overlaps(block.position),false);
    digs.push({ target:block.position.clone(),feet });
    f.cells.set(block.position.toString(),'air');
  };
  await f.bot.waitForTicks(1);
  assert.equal(f.agent.__testFurnishedHouseStandingSafely(start),true);
  for (const spec of scaffold) {
    try {
      await f.agent.__testBreakFurnishedHouseBlock(spec.position,{maxFeetY:spec.position.y});
    } catch (error) {
      t.diagnostic(JSON.stringify({ profile, target: spec.position, feet: f.bot.entity.position, completedDigs: digs }));
      throw error;
    }
    assert.equal(f.bot.blockAt(new Vec3(spec.position.x,spec.position.y,spec.position.z)).name,'air');
  }
  await f.agent.__testWithFurnishedHouseMovements(async () => {
    assert.equal(f.bot.pathfinder.movements.maxDropDown,2);
    assert.equal(f.bot.pathfinder.movements.canDig,false);
    assert.equal(f.bot.pathfinder.movements.allowParkour,false);
    assert.deepEqual(f.bot.pathfinder.movements.scafoldingBlocks,[]);
    const p=blueprint.entrance.outside;
    await f.bot.pathfinder.goto(new goals.GoalBlock(p.x,p.y,p.z));
    await f.bot.waitForTicks(5);
  });
  assert.equal(digs.length,scaffold.length);
  assert.ok(groundedHeights.some((height) => height > start.y + 1), 'The real bot must ascend the ramp to reach high scaffold');
  assert.equal(f.bot.entity.onGround,true);
  assert.ok(Math.abs(f.bot.entity.position.y-blueprint.entrance.outside.y)<0.07);
  assert.ok(f.bot.entity.position.distanceTo(new Vec3(blueprint.entrance.outside.x+0.5,
    blueprint.entrance.outside.y,blueprint.entrance.outside.z+0.5))<0.4);
  assert.equal(f.packets.length,0,'Cleanup may not replace removed dirt or place any new block');
  for(const spec of blueprint.blocks) {
    assert.equal(f.bot.blockAt(new Vec3(spec.position.x,spec.position.y,spec.position.z)).name,spec.item,
      `The completed house remains intact at ${spec.id}`);
  }
});
}

test('native scaffold cleanup rejects a foreign replacement before any dig or rebuild', { timeout: 15000 }, async (t) => {
  const f=furnishedPlacementFixture(t,new Vec3(97.5,63,169.5),{nativePhysics:true});
  const blueprint=installCompletedCottage(f);
  const target=blueprint.scaffold.find((spec)=>spec.stage!=='frame'&&spec.position.y===69);
  const position=new Vec3(target.position.x,target.position.y,target.position.z);
  f.cells.set(position.toString(),'chest');
  f.actualProperties.set(position.toString(),{facing:'west',type:'single',waterlogged:false});
  let digs=0;
  f.bot.canDigBlock=()=>true;
  f.bot.dig=async()=>{digs+=1;};
  const task=f.agent.__testGetReconnectTask();
  task.stepCheckpoint={furnishedHouse:{schema:2,sourceProfile:'cottage',anchor:blueprint.anchor,
    phase:'roof',scaffoldCleanupStarted:true,ownedBlockIds:blueprint.blocks.map((spec)=>spec.id),
    ownedScaffold:[{position:target.position,item:'dirt'}]}};
  await f.bot.waitForTicks(1);
  await assert.rejects(f.agent.__testExecuteBuildFurnishedHousePhase({args:{phase:'roof',profile:'cottage'}}),
    (error)=>error.code==='house_scaffold_changed');
  assert.equal(digs,0);
  assert.equal(f.packets.length,0);
  assert.equal(f.bot.blockAt(position).name,'chest');
});

test('public cancellation during native cleanup descent prevents the first dig and late resumption', { timeout: 12000 }, async (t) => {
  const f=furnishedPlacementFixture(t,new Vec3(97.5,70.5,180.5),{nativePhysics:true});
  const blueprint=installCompletedCottage(f);
  const target=blueprint.scaffold.find((spec)=>spec.stage!=='frame'&&spec.position.y===69);
  const task=f.agent.__testGetReconnectTask();
  task.executionGeneration=0;
  task.cancellationToken=new CancellationToken();
  task.movementLease=f.agent.__testClaimMovementLease('task',task.taskId);
  let digs=0;
  let cancellation;
  f.bot.canDigBlock=()=>true;
  f.bot.dig=async()=>{digs+=1;};
  f.bot.once('path_update',()=>{cancellation=f.agent.handleMessage({type:'mc_command_cancel'});});
  await f.bot.waitForTicks(1);
  await assert.rejects(f.agent.__testBreakFurnishedHouseBlock(target.position,{maxFeetY:target.position.y}),
    (error)=>error.code==='cancelled');
  assert.ok(cancellation,'The actual pathfinder must have begun a descent before cancellation');
  await cancellation;
  const controlsAfterCancel=f.controls.length;
  await f.bot.waitForTicks(8);
  assert.equal(digs,0);
  assert.equal(f.packets.length,0);
  assert.ok(f.controls.slice(controlsAfterCancel).every((entry)=>entry.value===false),'A cancelled cleanup cannot restart native movement controls');
  assert.equal(f.bot.blockAt(new Vec3(target.position.x,target.position.y,target.position.z)).name,'dirt');
});

for (const item of ['oak_door','white_bed']) {
  test(`native ${item} placement waits for the delayed authoritative second block`, { timeout: 6000 }, async (t) => {
    const properties=item==='oak_door' ?
      {facing:'north',half:'lower',hinge:'left',open:false,powered:false} :
      {facing:'north',part:'foot',occupied:false};
    const f=furnishedPlacementFixture(t,new Vec3(94.5,63,173.5),
      {item,properties,nativePhysics:true,nativeMultiBlockResponse:true,derivedDelayMs:220});
    const position=item==='oak_door' ? f.target.offset(0,1,0) : f.target.offset(0,0,-1);
    const derived={id:'delayed-second',item,position,derived:true,properties:item==='oak_door' ?
      {facing:'north',half:'upper',hinge:'left',open:false,powered:false} :
      {facing:'north',part:'head',occupied:false}};
    await f.bot.waitForTicks(1);
    let completed=false;
    const placement=f.agent.__testPlaceFurnishedHouseBlock({id:'delayed-primary',item,position:f.target,
      properties,derivedBlocks:[derived]}).then(()=>{completed=true;});
    for(let i=0;i<500&&f.packets.length===0;i+=1) await new Promise((resolve)=>setTimeout(resolve,5));
    assert.equal(f.packets.length,1,'A native placement was really sent');
    assert.equal(f.bot.blockAt(f.target).name,item,'The lower/foot response has arrived');
    assert.equal(f.bot.blockAt(position).name,'air','The second server update is still pending');
    await new Promise((resolve)=>setTimeout(resolve,80));
    assert.equal(completed,false,'Seeing only the primary block cannot complete the action');
    await placement;
    assert.equal(f.derivedResponses.length,1);
    assert.equal(f.bot.blockAt(position).name,item);
    for(const [key,value]of Object.entries(derived.properties)) assert.equal(String(f.bot.blockAt(position).getProperties()[key]),String(value));
    assert.equal(f.remaining(),0);
    assert.equal(f.packets.length,1,'Waiting must not duplicate the physical placement');
  });
}

test('native door placement refuses a permanently missing upper block within the finite confirmation deadline', { timeout: 6000 }, async (t) => {
  const properties={facing:'north',half:'lower',hinge:'left',open:false,powered:false};
  const f=furnishedPlacementFixture(t,new Vec3(94.5,63,173.5),
    {item:'oak_door',properties,nativePhysics:true,nativeMultiBlockResponse:true,missingDerivedResponse:true});
  const position=f.target.offset(0,1,0);
  const began=Date.now();
  await f.bot.waitForTicks(1);
  await assert.rejects(f.agent.__testPlaceFurnishedHouseBlock({id:'missing-door-upper',item:'oak_door',position:f.target,
    properties,derivedBlocks:[{id:'upper',item:'oak_door',position,derived:true,
      properties:{facing:'north',half:'upper',hinge:'left',open:false,powered:false}}]}),
  (error)=>error.code==='house_state_mismatch');
  assert.ok(Date.now()-began<4500,'No missing secondary block can wait indefinitely');
  assert.equal(f.bot.blockAt(f.target).name,'oak_door');
  assert.equal(f.bot.blockAt(position).name,'air');
  assert.equal(f.packets.length,1);
  assert.equal(f.derivedResponses.length,0);
  assert.equal(f.remaining(),0);
});
