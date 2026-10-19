/* global require */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const { createHeuristicPlanner } = require('../vendor/server/minecraft/commandPlanner');
const { normalizeTaskScriptPlan } = require('../vendor/server/minecraft/learningState');
const { collectInvalidPlanStepSkills } = require('../vendor/server/minecraft/plannerSafety');

const registry = createMinecraftActionRegistry();
const planner = createHeuristicPlanner({ actionRegistry: registry });
const anchor = { x: -31, y: 64, z: 29 };
const copy = value => JSON.parse(JSON.stringify(value));
const planFor = (external = false, profile = 'medieval_castle') => registry.buildHeuristicTaskPlan('build_estate', {
  profile, anchor, useNearbySupplyChests: external,
  ...(external ? { depots: [{ x: -35, y: 64, z: 29 }] } : {}),
});
function successfulTaskBucket(plan, count = 1) {
  const bucket = registry.createTaskScriptBucket(registry.getTaskScriptKey(plan), plan.intent);
  for (let i = 0; i < count; i += 1) registry.rememberTaskScriptOutcome(bucket,
    { plan, completionPlan: copy(plan), userCommand: '建造完整庄园' }, 'completed', '', { normalizeTaskScriptPlan });
  return bucket;
}
function successfulStageBucket(plan, step = plan.steps[0]) {
  const bucket = registry.createStageScriptBucket(plan.intent, step);
  registry.rememberStageScriptOutcome(bucket, { intent: plan.intent, plan, completionPlan: copy(plan) }, step, 'completed');
  return bucket;
}
const compile = (plan, tasks = {}, stages = {}, context = {}) => registry.compileTaskScriptPlan(
  '建造完整庄园', plan, tasks, stages, { normalizeTaskScriptPlan, ...context });

test('public commands explicitly distinguish self acquisition from permitted external diagnostics', () => {
  for (const command of ['建一座城堡', '建河畔别墅', '造一座美观小屋', '造一座高级附魔小屋']) {
    const plan = planner(command);
    assert.ok(plan.steps.length);
    assert.ok(plan.steps.every(step => step.args.materialSource === 'self_gathered'), command);
    assert.match(plan.replyText, /自动采集、合成和冶炼/);
    assert.match(plan.replyText, /自己建造的仓库取回本任务物资/);
    assert.doesNotMatch(plan.replyText, /只使用背包里的材料/);
  }
  const external = planner('去 -31 64 29 从补给箱拿木板建城堡');
  assert.equal(external.steps[0].args.materialSource, 'external_depots');
  assert.equal(external.steps[0].args.useNearbySupplyChests, true);
  assert.deepEqual(external.steps[0].args.anchor, anchor);
  assert.equal(planner('建城堡，不要使用补给箱').steps[0].args.materialSource, 'self_gathered');
});

test('source identity changes task, stage, resource, target and objective keys without changing blueprint schema', () => {
  const self = planFor(); const external = planFor(true);
  assert.equal(self.steps[0].args.schema, 1);
  assert.equal(registry.getTaskScriptKey(self), 'build_estate:v2:medieval_castle:self_gathered');
  for (const method of ['getTaskScriptStepSignature', 'getStageResourceKey', 'getStageTargetKey', 'getStepObjectiveKey']) {
    assert.notEqual(registry[method](self.steps[0]), registry[method](external.steps[0]), method);
  }
  assert.notEqual(registry.getStageScriptKey(self.intent, self.steps[0]), registry.getStageScriptKey(external.intent, external.steps[0]));
});

test('a highly successful external task bucket cannot match or label a default self task as learned success', () => {
  const self = planFor(); const external = planFor(true);
  const bucket = successfulTaskBucket(external, 50);
  const tasks = { [bucket.key]: bucket };
  assert.equal(bucket.success, 50);
  assert.equal(registry.findBestLearnedTaskScript(self, '建造完整庄园', tasks), null);
  assert.equal(registry.getTaskScriptPlanningHints('建造完整庄园', self, tasks), null);
  const result = compile(self, tasks);
  assert.equal(result.scriptMeta.source, 'generated');
  assert.equal(result.scriptMeta.key, registry.getTaskScriptKey(self));
  assert.deepEqual(result.steps[0].args, self.steps[0].args);
});

test('structural self completion stays pending while external diagnostic records retain their own reuse scope', () => {
  const self = planFor(); const external = planFor(true);
  const a = successfulTaskBucket(self); const b = successfulTaskBucket(external, 20);
  const tasks = { [a.key]: a, [b.key]: b };
  for (const [plan, bucket] of [[self, a], [external, b]]) {
    const result = compile(plan, tasks);
    assert.equal(result.scriptMeta.source, plan === self ? 'generated' : 'learned_success');
    assert.equal(result.scriptMeta.key, bucket.key);
    assert.deepEqual(result.steps[0].args, plan.steps[0].args);
  }
  assert.equal(a.success, 0);
  assert.equal(a.componentSuccess, 1);
  assert.equal(a.reusable, false);
  assert.equal(a.lastSuccessfulPlan, null);
  assert.equal(b.success, 20);
});

test('exact-key aliases and AI-selected external task matches cannot bypass source checks', () => {
  const self = planFor(); const external = planFor(true);
  const bucket = successfulTaskBucket(external, 30);
  const forced = { key: registry.getTaskScriptKey(self), score: 999, bucket };
  assert.equal(registry.findBestLearnedTaskScript(self, '', { [forced.key]: bucket }), null);
  const result = compile(self, {}, {}, { findBestLearnedTaskScript: () => forced });
  assert.equal(result.scriptMeta.source, 'generated');
  assert.deepEqual(result.steps, normalizeTaskScriptPlan(self).steps);
});

test('old inventory fixture records cannot become new self task records even under a renamed key', () => {
  const self = planFor(); const legacy = copy(self);
  delete legacy.steps[0].args.materialSource;
  assert.equal(registry.validateStep(legacy.steps[0]).valid, true, 'legacy component actions remain executable');
  assert.match(registry.getTaskScriptKey(legacy), /legacy_inventory$/);
  for (const key of ['build_estate:v1:medieval_castle', registry.getTaskScriptKey(self)]) {
    const bucket = { ...successfulTaskBucket(legacy), key };
    assert.equal(registry.findBestLearnedTaskScript(self, '', { [key]: bucket }), null);
  }
  const bucket = registry.createTaskScriptBucket(registry.getTaskScriptKey(self), self.intent);
  registry.rememberTaskScriptOutcome(bucket, { plan: legacy, completionPlan: legacy }, 'completed');
  assert.equal(bucket.success, 0);
  assert.equal(bucket.lastSuccessfulPlan, null);
});

test('stage matching rejects external or mismatched profiles even when its exact dictionary key is forged', () => {
  const self = planFor(); const external = planFor(true);
  for (const wrong of [external, planFor(false, 'riverside_villa')]) {
    const bucket = successfulStageBucket(wrong);
    const key = registry.getStageScriptKey(self.intent, self.steps[0]);
    assert.equal(registry.scoreStageScriptBucket(bucket, self.intent, self.steps[0]), -1);
    assert.equal(registry.findBestLearnedStageScript(self.intent, self.steps[0], { [key]: bucket }), null);
    const result = registry.applyLearnedStageScripts(self, {}, {
      findBestLearnedStageScript: () => ({ key, score: 999, bucket }),
    });
    assert.equal(result.scriptMeta?.scriptLibraryHit || 0, 0);
    assert.deepEqual(result.steps[0].args, self.steps[0].args);
  }
  const good = successfulStageBucket(self);
  assert.equal(registry.findBestLearnedStageScript(self.intent, self.steps[0], { [good.key]: good }).bucket, good);
});

test('furnished-house controlled records remain separate and source cannot be truncated from long phase keys', () => {
  for (const profile of ['cottage', 'enchanting_library']) {
    const self = registry.buildHeuristicTaskPlan('build_furnished_house', { profile, anchor });
    const legacy = copy(self);
    for (const step of legacy.steps) delete step.args.materialSource;
    const old = successfulTaskBucket(legacy, 10);
    assert.equal(registry.findBestLearnedTaskScript(self, '', { [old.key]: old }), null);
    const good = successfulTaskBucket(self);
    assert.equal(compile(self, { [good.key]: good }).scriptMeta.source, 'generated');
    assert.equal(good.success, 0);
    assert.equal(good.componentSuccess, 1);
    assert.equal(good.reusable, false);
    for (let i = 0; i < self.steps.length; i += 1) {
      assert.equal(self.steps[i].args.schema, 2);
      const key = registry.getStageScriptKey(self.intent, self.steps[i]);
      assert.match(key, /:self_gathered:/);
      assert.ok(key.length <= 96);
      assert.notEqual(key, registry.getStageScriptKey(legacy.intent, legacy.steps[i]));
      const badStage = successfulStageBucket(legacy, legacy.steps[i]);
      assert.equal(registry.findBestLearnedStageScript(self.intent, self.steps[i], { [key]: badStage }), null);
    }
  }
});

test('task and stage success recording cannot relabel legacy or externally changed executions as self', () => {
  const original = planFor(); const changed = planFor(true);
  const task = { intent: original.intent, plan: changed, completionPlan: original };
  const bucket = registry.createTaskScriptBucket(registry.getTaskScriptKey(original), original.intent);
  registry.rememberTaskScriptOutcome(bucket, task, 'completed');
  assert.equal(bucket.success, 0);
  const stage = registry.createStageScriptBucket(original.intent, original.steps[0]);
  registry.rememberStageScriptOutcome(stage, task, changed.steps[0], 'completed');
  assert.equal(stage.success, 0);
});

test('a learned plan cannot change the current source, anchor, profile or append old depot work', () => {
  const old = planFor(true); const fresh = planFor(false, 'riverside_villa');
  old.steps.unshift(registry.createActionStep('withdraw_items', { item: 'oak_planks', count: 64 }));
  const merged = registry.mergeTaskScriptPlan(old, fresh, {
    normalizeTaskScriptPlan, getTaskScriptStepSignature: registry.getTaskScriptStepSignature,
  });
  assert.deepEqual(merged.steps, normalizeTaskScriptPlan(fresh).steps);
  const good = successfulTaskBucket(fresh);
  const result = compile(fresh, { [good.key]: good }, {}, {
    mergeTaskScriptPlan: () => old, applyLearnedStageScripts: value => value,
  });
  assert.deepEqual(result.steps, normalizeTaskScriptPlan(fresh).steps);
  assert.equal(result.goal, fresh.goal);
});

test('estate recovery and generic AI repairs retain the original contract and reject arbitrary withdrawal prefixes', () => {
  const original = planFor(); const changed = planFor(true, 'riverside_villa');
  const suffix = registry.createActionStep('go_to_position', { x: 5, y: 64, z: 7 });
  const task = { intent: original.intent, completionPlan: copy(original),
    plan: { ...changed, steps: [...changed.steps, suffix] }, currentStepIndex: 0,
    stepCheckpoint: { estate: { schema: 1, sourceProfile: 'medieval_castle', materialSource: 'self_gathered', anchor } } };
  for (const result of [registry.buildRecoveryPlan(task, { code: 'generic_failure' }),
    registry.continueTaskPlan(task, [registry.createActionStep('withdraw_items', { item: 'oak_log', count: 64 }), changed.steps[0]])]) {
    assert.deepEqual(result.steps[0].args, original.steps[0].args);
    assert.deepEqual(result.steps[1], suffix);
    assert.equal(result.goal, original.goal);
    assert.equal(result.steps.some(step => step.skill === 'withdraw_items'), false);
  }
  task.stepCheckpoint.estate.materialSource = 'external_depots';
  assert.equal(registry.buildRecoveryPlan(task, { code: 'generic_failure' }), null);
});

test('furnished-house recovery uses original tier and anchor and keeps legacy source unverified', () => {
  const original = registry.buildHeuristicTaskPlan('build_furnished_house', { profile: 'enchanting_library', anchor });
  const changed = registry.buildHeuristicTaskPlan('build_furnished_house', { profile: 'cottage' });
  const task = { intent: original.intent, completionPlan: original, plan: changed, currentStepIndex: 0,
    stepCheckpoint: { furnishedHouse: { schema: 2, sourceProfile: 'enchanting_library', materialSource: 'self_gathered', anchor } } };
  const result = registry.continueTaskPlan(task, [registry.createActionStep('withdraw_items', { item: 'bookshelf', count: 15 })]);
  assert.ok(result.steps.every(step => step.args.profile === 'enchanting_library' && step.args.materialSource === 'self_gathered'));
  assert.ok(result.steps.every(step => JSON.stringify(step.args.anchor) === JSON.stringify(anchor)));
  task.stepCheckpoint.furnishedHouse.anchor = { ...anchor, x: 99 };
  assert.equal(registry.buildRecoveryPlan(task, { code: 'generic_failure' }), null);
  const legacy = copy(original);
  for (const step of legacy.steps) delete step.args.materialSource;
  const recovered = registry.buildRecoveryPlan({ intent: legacy.intent, plan: legacy,
    completionPlan: legacy, currentStepIndex: legacy.steps.length - 1 }, { code: 'completion_verification_failed' });
  assert.ok(recovered.steps.every(step => step.args.materialSource === undefined));
  assert.match(registry.getTaskScriptKey(recovered), /legacy_inventory$/);
});

test('source/permission conflicts fail validation while a source change remains a different AI objective', () => {
  const self = planFor().steps[0];
  for (const args of [
    { ...self.args, materialSource: 'external_depots' },
    { ...self.args, useNearbySupplyChests: true },
    { ...self.args, materialSource: 'unknown' },
  ]) assert.equal(registry.validateStep({ skill: self.skill, args }).valid, false);
  assert.notEqual(registry.getStepObjectiveKey(self), registry.getStepObjectiveKey(planFor(true).steps[0]));
});

test('construction script changes retain the existing unknown-action rejection boundary', () => {
  const fresh = planFor();
  fresh.steps.push({ skill: 'unregistered_supply_macro', args: {} });
  const result = compile(fresh);
  assert.deepEqual(collectInvalidPlanStepSkills(result, registry), ['unregistered_supply_macro']);
  assert.equal(registry.compileStep(result.steps[1]).valid, false);
  const old = planFor();
  old.steps.push({ skill: 'unregistered_supply_macro', args: {} });
  const merged = registry.mergeTaskScriptPlan(old, planFor(), { normalizeTaskScriptPlan });
  assert.deepEqual(collectInvalidPlanStepSkills(merged, registry), []);
  assert.equal(merged.steps.length, 1, 'unknown old scripts cannot append a primitive to the current task');
});
