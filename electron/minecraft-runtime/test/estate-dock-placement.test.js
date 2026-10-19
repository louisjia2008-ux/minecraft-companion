/* global require, setInterval, clearInterval */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Block = require('prismarine-block')(registry);
const { Physics, PlayerState } = require('prismarine-physics');
const { goals } = require('mineflayer-pathfinder');
const WorldSync = require('prismarine-world/src/worldsync');
const { createEstateBlueprint } = require('../vendor/server/minecraft/estateBlueprints');
const { createEstateDockPlacement } = require('../vendor/server/minecraft/estateDockPlacement');
const key = p => `${p.x},${p.y},${p.z}`;
const error = code => Object.assign(new Error(code), { code });

function physicalFixture({ direction = 'south', condition = 'normal', offset = false } = {}) {
  const blueprint = createEstateBlueprint({ x: 0, y: 0, z: 0 }, { profile: 'riverside_villa' });
  const spec = blueprint.blocks.find(s => s.component === 'villa_dock' && s.phase === 'floor' && s.position.x === 5 && s.position.z === 20);
  const face = { south: new Vec3(0, 0, 1), north: new Vec3(0, 0, -1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) }[direction];
  const target = new Vec3(spec.position.x, spec.position.y, spec.position.z);
  const reference = target.minus(face);
  const cells = new Map(blueprint.blocks.filter(s => !['villa_dock', 'villa_furniture'].includes(s.component)).map(s => [key(s.position), s]));
  cells.set(key(reference), { item: 'oak_planks', position: reference });
  function at(point) {
    const position = point.floored(), value = cells.get(key(position));
    const river = blueprint.waterZones.some(({ bounds: b }) => position.y === b.minY && position.x >= b.minX && position.x <= b.maxX && position.z >= b.minZ && position.z <= b.maxZ);
    const name = value?.item || (river ? 'water' : position.y < 0 ? 'grass_block' : 'air');
    return Object.assign(Block.fromProperties(registry.blocksByName[name].id, value?.properties || (name === 'water' ? { level: 0 } : {}), 0), { position });
  }
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const center = reference.offset(.5, 1, .5);
  const bot = Object.assign(new EventEmitter(), { registry, version: '1.21.8', blockAt: at, controlState: controls,
    inventory: { slots: [], items: () => [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    getControlState: name => controls[name],
    entity: { position: center.offset(offset ? -.12 : 0, 0, offset ? .16 : 0), velocity: new Vec3(0, 0, 0), onGround: true,
      width: .6, height: 1.8, eyeHeight: 1.62, yaw: 0, pitch: 0, effects: {}, attributes: {}, isInWater: false, isInLava: false,
      isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: true, elytraFlying: false } });
  bot.world = { getBlock: at, raycast: WorldSync.prototype.raycast };
  function standingSafely(feet) {
    let supported = false;
    for (let x = Math.floor(feet.x - .3); x <= Math.floor(feet.x + .3); x += 1) for (let z = Math.floor(feet.z - .3); z <= Math.floor(feet.z + .3); z += 1) {
      for (let y = Math.floor(feet.y - .06); y <= Math.floor(feet.y + 1.8); y += 1) {
        const block = at(new Vec3(x, y, z));
        if (['water', 'lava'].includes(block.name)) return false;
        for (const s of block.shapes) {
          if (feet.x + .3 <= x + s[0] || feet.x - .3 >= x + s[3] || feet.z + .3 <= z + s[2] || feet.z - .3 >= z + s[5]) continue;
          const top = y + s[4];
          if (Math.abs(feet.y - top) < .07) supported = true;
          if (feet.y + .02 < top && feet.y + 1.8 > y + s[1] + .02) return false;
        }
      }
    }
    return supported;
  }
  function canPlace(ref, direction, to, feet) {
    if (feet.x + .3 > to.x && feet.x - .3 < to.x + 1 && feet.z + .3 > to.z && feet.z - .3 < to.z + 1 && feet.y < to.y + 1 && feet.y + 1.8 > to.y) return false;
    const eye = feet.offset(0, 1.62, 0), point = ref.position.offset(.5 + direction.x * .5, .5, .5 + direction.z * .5);
    const goal = new goals.GoalPlaceBlock(to, bot.world, { range: 4.5, faces: [direction.scaled(-1)] });
    return eye.distanceTo(point) <= 4.5 && goal.getFaceAndRef(eye) !== null;
  }
  const owner = { task: 'estate', generation: 1, lease: 1 };
  const current = { ...owner };
  const writes = [], timeline = [], reports = [];
  let paused = false, triggered = false, placeCalls = 0, ticks = 0;
  const active = () => { if (paused) throw error('paused'); };
  const identity = () => current.task === owner.task && current.generation === owner.generation && current.lease === owner.lease;
  const control = (name, value) => { writes.push({ name, value, generation: current.generation, lease: current.lease }); controls[name] = value; };
  const helper = createEstateDockPlacement({ getBot: () => bot, assertActive: active, isOwnerCurrent: identity,
    // The route prerequisite is already physically satisfied by this fixture.
    // Tests exercise real edge control, not claim real A* or server placement.
    moveTo: async () => {}, equip: async () => {}, standingSafely, canPlace,
    look: async (yaw, pitch) => { active(); bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    setControl: (name, value) => { active(); control(name, value); },
    waitTick: () => new Promise(resolve => bot.once('physicsTick', resolve)),
    stopOwnMovement: ({ controls: names, releaseSneak }) => {
      if (!identity()) return;
      for (const name of names) if (name !== 'sneak') control(name, false);
      if (releaseSneak) control('sneak', false);
    },
    placeAgainst: async (_ref, _face, _target, _item, options) => {
      if (condition === 'pause_before_packet') paused = true;
      options.beforeSend(); placeCalls += 1;
      throw error('PROOF_BEFORE_NATIVE_PLACE');
    }, report: (message, details) => reports.push({ message, details }),
  });
  const physics = Physics(registry, bot.world);
  // Initial zero-velocity fixture needs gravity to establish its contact flag.
  for (let i = 0; i < 3; i += 1) physics.simulatePlayer(new PlayerState(bot, controls), bot.world).apply(bot);
  const timer = setInterval(() => {
    // Catch-up emits five native simulations before Promise continuations.
    // Only the installed movement simulator updates position and velocity.
    for (let n = 0; n < 5; n += 1) {
      physics.simulatePlayer(new PlayerState(bot, controls), bot.world).apply(bot); ticks += 1;
      const d = bot.entity.position.minus(center), projected = d.x * face.x + d.z * face.z;
      if (!triggered && projected > .15 && !['normal', 'pause_before_packet'].includes(condition)) {
        triggered = true;
        if (condition === 'pause') paused = true;
        if (condition === 'new_generation') current.generation += 1;
        if (condition === 'foreign_lease') current.lease += 1;
        if (['new_generation', 'foreign_lease'].includes(condition)) { controls.forward = false; controls.sneak = false; }
        if (condition === 'source_change') cells.set(key(target.offset(0, -1, 0)), { item: 'lava', properties: { level: 0 } });
      }
      timeline.push({ position: bot.entity.position.clone(), onGround: bot.entity.onGround, water: bot.entity.isInWater });
      bot.emit('physicsTick');
    }
  }, 5);
  return { helper, bot, blueprint, spec, face, center, writes, timeline, reports, current,
    stats: () => ({ placeCalls, triggered, ticks }), close: () => clearInterval(timer) };
}

for (const direction of ['north', 'south', 'east', 'west']) {
  test(`${direction}: native physics reaches a supported visible side face and synchronously stops during catch-up ticks`, async () => {
    const f = physicalFixture({ direction });
    try {
      await assert.rejects(f.helper.place({ blueprint: f.blueprint, spec: f.spec }), { code: 'PROOF_BEFORE_NATIVE_PLACE' });
      assert.equal(f.stats().placeCalls, 1);
      assert.ok(f.timeline.every(t => t.onGround && !t.water && t.position.y === 1));
      const offset = f.bot.entity.position.minus(f.center), projection = offset.x * f.face.x + offset.z * f.face.z;
      assert.ok(projection > .5 && projection < .78);
      assert.equal(f.bot.controlState.forward, false); assert.equal(f.bot.controlState.sneak, false);
      assert.equal(f.bot.listenerCount('physicsTick'), 0);
    } finally { f.close(); }
  });
}

test('native center alignment from an off-center reference has its own bounded budget before the edge step', async () => {
  const f = physicalFixture({ offset: true });
  try {
    await assert.rejects(f.helper.place({ blueprint: f.blueprint, spec: f.spec }), { code: 'PROOF_BEFORE_NATIVE_PLACE' });
    assert.equal(f.stats().placeCalls, 1);
    assert.ok(f.reports.some(r => r.message.includes('中心')));
    assert.equal(f.bot.listenerCount('physicsTick'), 0);
  } finally { f.close(); }
});

for (const [condition, code] of [['pause', 'paused'], ['new_generation', 'estate_dock_owner_changed'],
  ['foreign_lease', 'estate_dock_owner_changed'], ['source_change', 'estate_dock_edge_changed'], ['pause_before_packet', 'paused']]) {
  test(`${condition}: no native placement and no stale ownership/control restoration`, async () => {
    const f = physicalFixture({ condition });
    try {
      await assert.rejects(f.helper.place({ blueprint: f.blueprint, spec: f.spec }), { code });
      assert.equal(f.stats().placeCalls, 0);
      if (condition === 'foreign_lease') {
        assert.equal(f.current.generation, 1, 'This is a SAME-generation foreign movement takeover');
        assert.equal(f.writes.some(w => w.lease === 2), false);
      }
      if (condition === 'new_generation') assert.equal(f.writes.some(w => w.generation === 2), false);
      assert.equal(f.bot.controlState.forward, false);
      assert.equal(f.bot.listenerCount('physicsTick'), 0);
    } finally { f.close(); }
  });
}

test('missing real runtime interfaces are rejected before beginning any operation', () => {
  assert.throws(() => createEstateDockPlacement({}), { code: 'estate_invalid_dock_runtime' });
});
