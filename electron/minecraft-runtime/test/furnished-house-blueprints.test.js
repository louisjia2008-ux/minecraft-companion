/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFurnishedHouseBlueprint, getFurnishedHouseMaterialBudget, FURNISHED_HOUSE_PHASES } = require('../vendor/server/minecraft/furnishedHouseBlueprints');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const { createHeuristicPlanner } = require('../vendor/server/minecraft/commandPlanner');
const key = (p) => `${p.x},${p.y},${p.z}`;
const anchor = { x: -19, y: 64, z: 30 };

for (const profile of ['cottage', 'enchanting_library']) {
  test(`${profile}: completed geometry encloses the room and preserves real furniture access`, () => {
    const b = createFurnishedHouseBlueprint(anchor, { profile });
    const cells = new Map(b.blocks.map((v) => [key(v.position), v]));
    assert.equal(cells.size, b.blocks.length, 'No silently overwritten structural or furniture cells');
    const { width, depth, maxY } = b.dimensions;
    for (let x = 0; x < width; x += 1) for (let z = 0; z < depth; z += 1) {
      const at = (y) => cells.get(key({ x: anchor.x + x, y: anchor.y + y, z: anchor.z + z }));
      assert.ok(at(0), 'Continuous floor');
      if (x === 0 || z === 0 || x === width - 1 || z === depth - 1) {
        for (let y = 1; y <= 3; y += 1) assert.ok(at(y), 'Wall, real door, or glass closes every wall cell');
      }
      assert.ok(Array.from({ length: maxY - 2 }, (_, i) => at(i + 3)).some((v) => v?.phase === 'roof'), 'No open roof column');
    }
    for (const empty of b.clearance) assert.equal(cells.has(key(empty.position)), false, empty.purpose);
    const seen = new Set(); const pending = [b.entrance.inside];
    while (pending.length) {
      const p = pending.shift();
      if (p.x <= anchor.x || p.z <= anchor.z || p.x >= anchor.x + width - 1 || p.z >= anchor.z + depth - 1 || seen.has(key(p))) continue;
      const body = cells.get(key(p));
      if (body && body.item !== 'torch') continue;
      if (cells.has(key({ ...p, y: p.y + 1 }))) continue;
      seen.add(key(p));
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) pending.push({ x: p.x + dx, y: p.y, z: p.z + dz });
    }
    for (const p of [b.furniture.bed.foot, b.furniture.craftingTable, b.furniture.chest, b.furniture.furnace, ...(b.furniture.enchantingTable ? [b.furniture.enchantingTable] : [])]) {
      assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => seen.has(key({ x: p.x + dx, y: p.y, z: p.z + dz }))), `Furniture is reachable from the front door: ${key(p)}`);
    }
    assert.equal(cells.get(key(b.furniture.bed.foot)).properties.part, 'foot');
    assert.equal(cells.get(key(b.furniture.bed.head)).properties.part, 'head');
    assert.equal(cells.get(key(b.furniture.door.upper)).properties.half, 'upper');
    assert.equal(b.furniture.lights.length, 4);
    const budget = getFurnishedHouseMaterialBudget(b);
    assert.equal(budget.white_bed, 1, 'Two bed cells consume one item');
    assert.equal(budget.oak_door, 1, 'Two door cells consume one item');
    assert.equal(Object.values(budget).reduce((a, n) => a + n, 0), b.blocks.filter((v) => !v.derived).length + b.scaffold.length);
  });

  test(`${profile}: temporary ramp has continuous ground support and one-block climb increments`, () => {
    const b = createFurnishedHouseBlueprint(anchor, { profile });
    const scaffold = new Set(b.scaffold.map((v) => key(v.position)));
    for (const block of b.scaffold) {
      if (block.position.y > anchor.y) assert.ok(scaffold.has(key({ ...block.position, y: block.position.y - 1 })), 'No floating support');
      assert.equal(b.blocks.some((entry) => key(entry.position) === key(block.position)), false,
        'Temporary steps never replace a finished building block');
    }
    for (let i = 0; i < b.scaffoldRoute.length; i += 1) {
      const p = b.scaffoldRoute[i];
      assert.ok(scaffold.has(key({ ...p, y: p.y - 1 })));
      assert.equal(scaffold.has(key(p)), false, 'Standing cell is empty');
      if (i) {
        const previous = b.scaffoldRoute[i - 1];
        assert.equal(p.y - previous.y, 1); assert.equal(Math.abs(p.z - previous.z), 1);
      }
    }
    const first = b.scaffoldRoute[0]; const last = b.scaffoldRoute.at(-1);
    assert.equal(first.y, anchor.y + 1); assert.equal(last.y, b.bounds.maxY);
    assert.ok(b.blocks.some((v) => v.position.x === last.x && v.position.z === last.z - 1 && v.position.y === last.y && v.item === 'oak_slab'));
    const platforms = b.scaffold.filter((v) => v.stage === 'frame');
    assert.equal(platforms.length, 24);
    for (const corner of b.blocks.filter((v) => v.phase === 'frame' && v.position.y === anchor.y + 3)) {
      const direction = corner.position.z === anchor.z ? -1 : 1;
      for (let step = 0; step < 3; step += 1) {
        const p = { x: corner.position.x, y: anchor.y + 2 - step, z: corner.position.z + direction * (step + 1) };
        assert.ok(platforms.some((entry) => key(entry.position) === key(p)),
          'Each wall-top corner has a directly adjacent staircase down in one-block increments');
        assert.equal(scaffold.has(key({ ...p, y: p.y + 1 })), false, 'The actual stair landing is empty');
      }
    }
  });
}

test('advanced library has fifteen effective ordinary bookshelves with both transmitter layers empty', () => {
  const b = createFurnishedHouseBlueprint(anchor, { profile: 'enchanting_library' });
  const table = b.furniture.enchantingTable;
  const cells = new Map(b.blocks.map((v) => [key(v.position), v]));
  let power = 0;
  for (const shelf of b.furniture.bookshelves) {
    const dx = shelf.x - table.x; const dz = shelf.z - table.z;
    assert.equal(Math.max(Math.abs(dx), Math.abs(dz)), 2);
    assert.equal(cells.get(key(shelf)).item, 'bookshelf');
    for (const dy of [0, 1]) assert.equal(cells.has(key({ x: table.x + Math.trunc(dx / 2), y: table.y + dy, z: table.z + Math.trunc(dz / 2) })), false);
    power += 1;
  }
  assert.equal(power, 15); assert.equal(getFurnishedHouseMaterialBudget(b).bookshelf, 15);
  assert.equal(cells.has(key({ x: table.x, y: table.y, z: table.z - 2 })), false, 'Access opening does not block the library');
});

test('invalid styles and fractional anchors cannot silently fall back to another house', () => {
  assert.throws(() => createFurnishedHouseBlueprint(anchor, { profile: 'castle' }));
  assert.throws(() => createFurnishedHouseBlueprint({ ...anchor, x: 0.1 }));
});

test('public construction commands select the full furnishings and preserve the requested tier', () => {
  const registry = createMinecraftActionRegistry();
  const planner = createHeuristicPlanner({ actionRegistry: registry, getLearnedSearchRadius: (_, v) => v });
  for (const [command, profile] of [['造一座美观小屋', 'cottage'], ['build a wooden house', 'cottage'], ['造一座带附魔台和书架的高级小屋', 'enchanting_library'], ['build an enchanting library house', 'enchanting_library']]) {
    const plan = planner(command);
    assert.equal(plan.intent, 'build_furnished_house');
    assert.deepEqual(plan.steps.map((v) => v.args.phase), FURNISHED_HOUSE_PHASES);
    assert.ok(plan.steps.every((v) => v.args.profile === profile && registry.validateStep(v).valid));
    assert.equal(registry.getExecutionDescriptor(plan.steps[5]).runtimeGroup, 'build_furnished_house_phase');
  }
  const step = { skill: 'build_furnished_house_phase', args: { phase: 'skip_furniture', profile: 'cottage' } };
  assert.equal(registry.validateStep(step).valid, false);
  assert.equal(registry.validateStep({ ...step, args: { phase: 'floor', profile: 'castle' } }).valid, false);
});

test('furnished-house recovery repairs the same tier and anchor while retaining the following return', () => {
  const a = createMinecraftActionRegistry();
  const original = a.buildHeuristicTaskPlan('build_furnished_house', { profile: 'enchanting_library' });
  const returnStep = { skill: 'go_to_position', args: { x: 2, y: 64, z: 3 } };
  const plan = { ...original, steps: [...original.steps, returnStep] };
  const task = { intent: plan.intent, plan, currentStepIndex: 11, stepCheckpoint: { furnishedHouse: { schema: 2, profile: 'enchanting_library', anchor } } };
  const recovery = a.buildRecoveryPlan(task, { code: 'completion_verification_failed' });
  assert.deepEqual(recovery.steps.at(-1), returnStep);
  assert.ok(recovery.steps.slice(0, -1).every((v) => v.args.profile === 'enchanting_library' && JSON.stringify(v.args.anchor) === JSON.stringify(anchor)));
  assert.equal(recovery.steps[0].args.phase, 'prepare_materials');
  assert.equal(recovery.steps.at(-2).args.phase, 'verify');
  const base = a.buildHeuristicTaskPlan('build_furnished_house', { profile: 'cottage' });
  assert.notEqual(a.getTaskScriptKey(original), a.getTaskScriptKey(base));
  assert.equal(a.scoreTaskScriptBucket({ intent: original.intent, lastSuccessfulPlan: original }, base), -1);
});
