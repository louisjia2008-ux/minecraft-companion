/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const { createHeuristicPlanner } = require('../vendor/server/minecraft/commandPlanner');
const registry = createMinecraftActionRegistry();
const planner = createHeuristicPlanner({ actionRegistry: registry, getLearnedSearchRadius: (_, value) => value });
const anchor = { x: -31, y: 64, z: 29 };
const depots = [{ x: -35, y: 64, z: 29 }, { x: -35, y: 64, z: 30 }];
const planFor = (profile = 'medieval_castle', rest = {}) => registry.buildHeuristicTaskPlan('build_estate', { profile, ...rest });

test('public Chinese and English estate commands retain one complete requested building', () => {
  for (const [command, profile] of [
    ['造一座中世纪城堡', 'medieval_castle'], ['建城堡', 'medieval_castle'],
    ['盖一座城堡', 'medieval_castle'], ['build a medieval castle', 'medieval_castle'],
    ['建河畔木屋', 'riverside_villa'], ['造河边别墅', 'riverside_villa'],
    ['build a riverside villa', 'riverside_villa'], ['build a riverside wooden house', 'riverside_villa'],
    ['在河边建个房子', 'riverside_villa'], ['build a wooden house by the riverside', 'riverside_villa'],
  ]) {
    const plan = planner(command);
    assert.equal(plan.intent, 'build_estate', command);
    assert.equal(plan.steps.length, 1, command);
    assert.equal(plan.steps[0].skill, 'build_estate');
    assert.equal(plan.steps[0].args.profile, profile);
    assert.equal(plan.steps[0].args.schema, 1);
    assert.equal(plan.steps[0].args.useNearbySupplyChests, false);
    assert.equal(registry.validateStep(plan.steps[0]).valid, true);
  }
});

test('estate construction takes precedence over goto, withdraw and ordinary house parsing', () => {
  const plan = planner('去 -31 64 29 从补给箱拿木板建一座城堡');
  assert.equal(plan.intent, 'build_estate');
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].args.anchor, anchor);
  assert.equal(plan.steps[0].args.useNearbySupplyChests, true);
  const english = planner('go to -31,64,29 and build a riverside house using supply chests');
  assert.equal(english.steps[0].args.profile, 'riverside_villa');
  assert.deepEqual(english.steps[0].args.anchor, anchor);
  assert.equal(english.steps[0].args.useNearbySupplyChests, true);
});

test('supply chest access requires permission and explicit inventory-only commands override it', () => {
  for (const command of ['用补给箱材料造城堡', '从箱子取木板建城堡', 'build a castle with materials from nearby supply chests']) {
    assert.equal(planner(command).steps[0].args.useNearbySupplyChests, true, command);
  }
  for (const command of [
    '建城堡', '建城堡，补给箱材料不足', '不要用补给箱材料建城堡',
    '别用补给箱造城堡', '不准用箱子材料造城堡',
    '只用背包材料造城堡', 'build a castle without supply chests',
    "build a castle, don't use supply chests", 'build a castle inventory-only',
  ]) assert.equal(planner(command).steps[0].args.useNearbySupplyChests, false, command);
});

test('fractional text coordinates cannot become a different integer anchor', () => {
  assert.equal(planner('在 1.5 64 29 建城堡').steps[0].args.anchor, undefined);
  assert.equal(planner('在 -1 64 29.5 建城堡').steps[0].args.anchor, undefined);
});

test('existing small-house, inventory and position commands retain their original actions', () => {
  assert.equal(planner('造一座美观小屋').intent, 'build_furnished_house');
  assert.equal(planner('造一座带附魔台和书架的高级小屋').steps[0].args.profile, 'enchanting_library');
  assert.equal(planner('从箱子拿16个圆石').intent, 'withdraw_items');
  assert.equal(planner('去 -31 64 29').intent, 'go_to_position');
  assert.equal(planner('城堡看起来很漂亮').mode, 'chat');
});

test('estate runtime descriptor has a finite two-hour bound and no bootstrap side effects', () => {
  for (const profile of ['medieval_castle', 'riverside_villa']) {
    const step = planFor(profile, { anchor, depots, useNearbySupplyChests: true }).steps[0];
    const compiled = registry.compileStep(step);
    assert.equal(compiled.contractType, 'bounded');
    assert.equal(compiled.primitive, 'estate_builder');
    assert.deepEqual(compiled.requiredArgs, ['profile']);
    assert.deepEqual(compiled.learnableArgs, []);
    assert.deepEqual(registry.getWatchdogProfile(step), {
      idleTimeoutMs: 30000, hardTimeoutMs: 7200000, label: '完整庄园建造', continuous: false,
    });
    const descriptor = registry.getExecutionDescriptor(step);
    assert.equal(descriptor.dispatchKind, 'build_estate');
    assert.equal(descriptor.runtimeGroup, 'build_estate');
    assert.equal(descriptor.runtimeKey, profile);
    assert.deepEqual(descriptor.args, step.args);
    assert.equal(registry.getStageKind(step), 'build');
    assert.equal(registry.getPreparationDescriptor(step).ensureBasicAxe, false);
    assert.equal(registry.getPreparationDescriptor(step).ensureBasicPickaxe, false);
  }
});

test('estate action validates profiles, schema, integer coordinates and bounded depot arrays', () => {
  const valid = { schema: 1, profile: 'medieval_castle' };
  for (const args of [
    valid, { ...valid, anchor }, { ...valid, depots: [] },
    { ...valid, depots: Array.from({ length: 8 }, () => ({ ...anchor })), useNearbySupplyChests: true },
  ]) assert.equal(registry.validateStep({ skill: 'build_estate', args }).valid, true);
  for (const args of [
    {}, { profile: 'cottage' }, { ...valid, schema: 2 }, { ...valid, schema: '1' },
    { ...valid, anchor: { ...anchor, x: 0.5 } }, { ...valid, anchor: null },
    { ...valid, anchor: [1, 2, 3] }, { ...valid, anchor: { x: 1, z: 2 } },
    { ...valid, depots: null }, { ...valid, depots: 'nearby' },
    { ...valid, depots: [{ ...anchor, y: 2.5 }] },
    { ...valid, depots: Array.from({ length: 9 }, () => ({ ...anchor })) },
    { ...valid, useNearbySupplyChests: 'true' }, { ...valid, useNearbySupplyChests: null },
  ]) assert.equal(registry.validateStep({ skill: 'build_estate', args }).valid, false, JSON.stringify(args));
  assert.throws(() => planFor('small_castle'), /未知庄园款式/);
  assert.throws(() => planFor(undefined, { profile: undefined }), /缺少参数 profile/);
});

test('compiled estate defaults and plan payload are isolated from caller mutation', () => {
  const input = { profile: 'riverside_villa', anchor: { ...anchor }, depots: depots.map((p) => ({ ...p })) };
  const plan = registry.buildHeuristicTaskPlan('build_estate', input);
  input.anchor.x += 100; input.depots[0].z += 100;
  assert.deepEqual(plan.steps[0].args.anchor, anchor);
  assert.deepEqual(plan.steps[0].args.depots, depots);
  const descriptor = registry.getExecutionDescriptor({ skill: 'build_estate', args: { profile: 'riverside_villa' } });
  assert.equal(descriptor.args.schema, 1);
  assert.equal(descriptor.args.useNearbySupplyChests, false);
});

test('task and stage learning keys cannot reuse a castle plan as a villa', () => {
  const castle = planFor(); const villa = planFor('riverside_villa');
  const step = castle.steps[0];
  assert.equal(registry.getTaskScriptKey(castle), 'build_estate:v2:medieval_castle:self_gathered');
  assert.notEqual(registry.getTaskScriptKey(castle), registry.getTaskScriptKey(villa));
  assert.equal(registry.getTaskScriptStepSignature(step), 'build_estate:v2:medieval_castle:self_gathered');
  assert.equal(registry.getStageResourceKey(step), 'estate:medieval_castle:self_gathered');
  assert.equal(registry.getStageTargetKey(step), 'estate_v2:medieval_castle:self_gathered');
  const bucket = { intent: 'build_estate', success: 10, lastSuccessfulPlan: castle };
  assert.equal(registry.scoreTaskScriptBucket(bucket, villa), -1);
  const taskScripts = { [registry.getTaskScriptKey(villa)]: bucket };
  assert.equal(registry.findBestLearnedTaskScript(villa, 'build villa', taskScripts), null);
});

test('objective identity preserves estate profile, anchor, depots and supply permissions', () => {
  const base = planFor('medieval_castle', { anchor, depots, useNearbySupplyChests: true }).steps[0];
  for (const change of [
    { profile: 'riverside_villa' }, { anchor: { ...anchor, x: anchor.x + 1 } },
    { depots: depots.slice(0, 1) }, { useNearbySupplyChests: false },
  ]) assert.notEqual(registry.getStepObjectiveKey(base), registry.getStepObjectiveKey({ ...base, args: { ...base.args, ...change } }));
});

test('learned script merging and failure revision preserve the current complete estate target', () => {
  const fresh = planFor('riverside_villa', { anchor, depots, useNearbySupplyChests: false });
  const old = planFor('medieval_castle', { anchor: { x: 1, y: 2, z: 3 }, useNearbySupplyChests: true });
  const merged = registry.mergeTaskScriptPlan(old, fresh);
  assert.deepEqual(merged.steps[0].args, fresh.steps[0].args);
  for (const code of ['timeout', 'step_timeout', 'executor_stalled', 'no_path', 'insufficient_material', 'generic_failure']) {
    assert.deepEqual(registry.reviseStepForFailure(fresh.steps[0], { code }).args, fresh.steps[0].args, code);
    assert.equal(registry.buildStageRevisionPlan({ plan: fresh, intent: fresh.intent, currentStepIndex: 0 }, { code }), null);
  }
});

test('estate recovery retains the exact profile, anchor, depots, permission and following steps', () => {
  const plan = planFor('riverside_villa', { anchor, depots, useNearbySupplyChests: true });
  const suffix = registry.createActionStep('go_to_position', { x: 5, y: 64, z: 7 });
  const task = { intent: plan.intent, plan: { ...plan, steps: [...plan.steps, suffix] }, currentStepIndex: 0,
    stepCheckpoint: { estate: { schema: 1, sourceProfile: 'riverside_villa', anchor, depots } } };
  for (const code of ['timeout', 'no_path', 'generic_failure', 'completion_verification_failed', 'insufficient_material']) {
    const repair = registry.buildRecoveryPlan(task, { code });
    assert.equal(repair.intent, 'build_estate');
    assert.equal(repair.steps.length, 2);
    assert.deepEqual(repair.steps[0].args, plan.steps[0].args, code);
    assert.deepEqual(repair.steps[1], suffix);
  }
});

test('estate recovery uses the actual selected anchor and depot checkpoint without granting supply access', () => {
  const plan = planFor();
  const task = { intent: plan.intent, plan, currentStepIndex: 0,
    stepCheckpoint: { estate: { schema: 1, sourceProfile: 'medieval_castle', anchor, depots } } };
  const recovered = registry.buildRecoveryPlan(task, { code: 'generic_failure' });
  assert.deepEqual(recovered.steps[0].args.anchor, anchor);
  assert.deepEqual(recovered.steps[0].args.depots, depots);
  assert.equal(recovered.steps[0].args.useNearbySupplyChests, false);
});

test('estate recovery refuses conflicting checkpoint profiles or anchors', () => {
  const plan = planFor('medieval_castle', { anchor });
  for (const checkpoint of [
    { sourceProfile: 'riverside_villa', anchor },
    { sourceProfile: 'medieval_castle', anchor: { ...anchor, x: 0 } },
    { sourceProfile: 'medieval_castle', anchor: { ...anchor, y: 0.5 } },
    { sourceProfile: 'medieval_castle', anchor, depots: Array(9).fill(anchor) },
  ]) assert.equal(registry.buildRecoveryPlan({ plan, intent: plan.intent, currentStepIndex: 0,
    stepCheckpoint: { estate: checkpoint } }, { code: 'generic_failure' }), null);
});

test('the original completion objective survives a changed retry plan and return-only verification recovery', () => {
  const original = planFor('riverside_villa', { anchor, depots, useNearbySupplyChests: false });
  const changed = planFor('medieval_castle', { useNearbySupplyChests: true });
  const checkpoint = { estate: { schema: 1, sourceProfile: 'riverside_villa', anchor } };
  const task = { intent: original.intent, plan: changed, completionPlan: original, currentStepIndex: 0, stepCheckpoint: checkpoint };
  assert.deepEqual(registry.buildRecoveryPlan(task, { code: 'generic_failure' }).steps[0].args, original.steps[0].args);
  const returning = registry.createActionStep('go_to_position', { x: 0, y: 64, z: 0 });
  task.plan = { ...original, steps: [returning] };
  const recovered = registry.buildRecoveryPlan(task, { code: 'completion_verification_failed' });
  assert.equal(recovered.steps.length, 2);
  assert.deepEqual(recovered.steps[0].args, original.steps[0].args);
  assert.deepEqual(recovered.steps[1], returning);
  assert.equal(recovered.goal, original.goal);
});

test('estate and farm failures retain specific blocking codes and disconnected sessions do not recover', () => {
  const plan = planFor(); const step = plan.steps[0];
  for (const code of ['estate_materials_missing', 'estate_route_changed', 'farm_water_missing', 'farm_replant_failed']) {
    assert.deepEqual(registry.classifyErrorForStep(step, { code, message: 'specific failure' }), {
      status: 'blocked', code, message: 'specific failure',
    });
  }
  assert.equal(registry.buildRecoveryPlan({ plan, intent: plan.intent, currentStepIndex: 0 }, { code: 'bot_connection_lost' }), null);
});
