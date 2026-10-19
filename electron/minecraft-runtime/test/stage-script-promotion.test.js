/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMinecraftActionRegistry } = require('../vendor/server/action/actionRegistry');
const registry = createMinecraftActionRegistry();
const copy = value => JSON.parse(JSON.stringify(value));
const originalStep = () => ({ skill: 'mine_resource', args: { block: 'coal_ore', count: 4, maxDistance: 24 } });
const taskFor = step => ({ intent: 'mine_resource', currentStepIndex: 0,
  plan: { mode: 'task', intent: 'mine_resource', steps: [step] } });
const context = { reviseStepForFailure: registry.reviseStepForFailure };
function record(bucket, step, outcome, reason = '', task = taskFor(step)) {
  return registry.rememberStageScriptOutcome(bucket, task, step, outcome, reason, {}, context);
}
function successful() {
  const step = originalStep();
  const bucket = registry.createStageScriptBucket('mine_resource', step);
  record(bucket, step, 'completed');
  return { bucket, step };
}
function retrieve(bucket, step = originalStep()) {
  return registry.findBestLearnedStageScript('mine_resource', step, { [bucket.key]: bucket });
}

test('a failed repair remains a candidate and cannot overwrite the last successful stage', () => {
  const { bucket, step } = successful();
  record(bucket, step, 'blocked', 'no_path');
  assert.deepEqual(bucket.lastSuccessfulStep, { skill: step.skill, args: step.args });
  assert.deepEqual(bucket.templateStep, step);
  assert.equal(bucket.candidateStep.args.maxDistance, 44);
  assert.equal(bucket.candidateStep.args.searchStrategy, 'prefer_near_standable');
  assert.equal(bucket.candidateStatus, 'pending');
  assert.equal(bucket.validatedRevision, 0);
  assert.equal(bucket.candidateRevision, 1);
  assert.equal(bucket.success, 1);
  assert.equal(bucket.blocked, 1);
  assert.equal(bucket.reasonCounts.no_path, 1);
  const fresh = { mode: 'task', intent: 'mine_resource', steps: [{ skill: step.skill, args: { block: 'coal_ore', count: 4 } }] };
  const result = registry.applyLearnedStageScripts(fresh, { [bucket.key]: bucket });
  assert.equal(result.steps[0].args.maxDistance, 24);
  assert.equal(result.steps[0].args.searchStrategy, undefined);
  assert.equal(result.scriptMeta.stageSource, 'learned_stages');
  assert.equal(result.scriptMeta.stageScriptMatches[0].revision, 0);
});

test('only successful execution of the exact candidate promotes that candidate revision', () => {
  const { bucket, step } = successful();
  record(bucket, step, 'blocked', 'no_path');
  const candidate = copy(bucket.candidateStep);
  record(bucket, candidate, 'completed');
  assert.deepEqual(bucket.lastSuccessfulStep, candidate);
  assert.deepEqual(bucket.templateStep, candidate);
  assert.equal(bucket.validatedRevision, 1);
  assert.equal(bucket.candidateStatus, 'validated');
  assert.equal(bucket.success, 2);
  assert.equal(retrieve(bucket).bucket, bucket);
  assert.ok(bucket.stepHistory.some(version => version.status === 'validated' && version.revision === 0
    && version.step.args.maxDistance === 24), 'retain the original successful version');
  assert.ok(bucket.stepHistory.some(version => version.outcome === 'blocked' && version.reason === 'no_path'));
});

test('completion of the old successful step does not promote an unexecuted candidate', () => {
  const { bucket, step } = successful();
  record(bucket, step, 'failed', 'no_path');
  const candidate = copy(bucket.candidateStep);
  record(bucket, step, 'completed');
  assert.deepEqual(bucket.lastSuccessfulStep, step);
  assert.deepEqual(bucket.candidateStep, candidate);
  assert.equal(bucket.validatedRevision, 0);
  assert.equal(bucket.candidateStatus, 'pending');
  assert.equal(bucket.failed, 1);
});

test('paused and cancelled candidates do not become successful or alter the last validated step', () => {
  for (const outcome of ['paused', 'cancelled']) {
    const { bucket, step } = successful();
    record(bucket, step, 'blocked', 'no_path');
    const candidate = copy(bucket.candidateStep);
    record(bucket, candidate, outcome);
    assert.equal(bucket.success, 1);
    assert.deepEqual(bucket.lastSuccessfulStep, step);
    assert.equal(bucket.validatedRevision, 0);
    assert.deepEqual(bucket.candidateStep, candidate);
    assert.equal(bucket.candidateStatus, 'pending');
  }
});

test('a stale completed callback for another current stage cannot promote its old candidate', () => {
  const { bucket, step } = successful();
  record(bucket, step, 'blocked', 'no_path');
  const candidate = copy(bucket.candidateStep);
  const current = { ...copy(candidate), args: { ...candidate.args, count: 8 } };
  record(bucket, candidate, 'completed', '', taskFor(current));
  assert.equal(bucket.success, 1);
  assert.deepEqual(bucket.lastSuccessfulStep, step);
  assert.equal(bucket.candidateStatus, 'pending');
});

test('repeated candidate failures preserve prior revisions and actual failure counters', () => {
  const { bucket, step } = successful();
  record(bucket, step, 'blocked', 'no_path');
  const first = copy(bucket.candidateStep);
  record(bucket, first, 'failed', 'timeout');
  assert.deepEqual(bucket.lastSuccessfulStep, step);
  assert.equal(bucket.candidateRevision, 2);
  assert.equal(bucket.candidateStep.args.maxDistance, 56);
  assert.equal(bucket.blocked, 1);
  assert.equal(bucket.failed, 1);
  assert.equal(bucket.reasonCounts.no_path, 1);
  assert.equal(bucket.reasonCounts.timeout, 1);
  assert.ok(bucket.stepHistory.some(version => version.revision === 1 && version.step.args.maxDistance === 44
    && version.outcome === 'failed' && version.reason === 'timeout'));
});

test('a failed first attempt has no reusable successful stage even if a candidate exists', () => {
  const step = originalStep();
  const bucket = registry.createStageScriptBucket('mine_resource', step);
  record(bucket, step, 'blocked', 'no_path');
  assert.equal(bucket.lastSuccessfulStep, null);
  assert.equal(bucket.success, 0);
  assert.equal(retrieve(bucket), null);
  const result = registry.applyLearnedStageScripts(taskFor(step).plan, {}, {
    findBestLearnedStageScript: () => ({ key: bucket.key, score: 999, bucket }),
  });
  assert.equal(result.scriptMeta?.scriptLibraryHit || 0, 0);
});

test('save and reload retain the validated step, isolated candidate and all revision history', () => {
  const { bucket, step } = successful();
  record(bucket, step, 'blocked', 'no_path');
  const restored = registry.normalizeLearningStageScripts(JSON.parse(JSON.stringify({ [bucket.key]: bucket })))[bucket.key];
  for (const key of ['lastSuccessfulStep', 'validatedRevision', 'candidateStep', 'candidateRevision', 'candidateStatus', 'stepHistory']) {
    assert.deepEqual(restored[key], bucket[key], key);
  }
  assert.equal(retrieve(restored).bucket, restored);
  assert.deepEqual(restored.templateStep, step);
});

test('legacy successful records whose latest template was repaired or is unknown are quarantined without losing history', () => {
  for (const lastOutcome of ['failed', 'blocked', 'cancelled', null]) {
    const step = originalStep();
    const raw = registry.createStageScriptBucket('mine_resource', step);
    for (const key of ['validationSchema', 'lastSuccessfulStep', 'validatedRevision', 'candidateStep', 'candidateRevision', 'candidateStatus', 'stepHistory']) delete raw[key];
    Object.assign(raw, { success: 7, failed: 2, blocked: 3, revision: 4, lastOutcome,
      reasonCounts: { no_path: 3, timeout: 2 }, templateStep: { ...step, args: { ...step.args, maxDistance: 96 } } });
    assert.equal(retrieve(raw), null, 'direct legacy access cannot bypass migration');
    const restored = registry.normalizeLearningStageScripts({ [raw.key]: raw })[raw.key];
    assert.equal(restored.lastSuccessfulStep, null);
    assert.equal(restored.candidateStatus, 'legacy_unverified');
    assert.deepEqual(restored.candidateStep, raw.templateStep);
    assert.equal(restored.success, 7);
    assert.equal(restored.failed, 2);
    assert.equal(restored.blocked, 3);
    assert.deepEqual(restored.reasonCounts, raw.reasonCounts);
    assert.equal(retrieve(restored), null);
    const summary = registry.getStageScriptLibrarySummary({ [restored.key]: restored });
    assert.equal(summary.successful, 0);
    assert.equal(summary.recentSuccessfulStages.length, 0);
  }
});

test('legacy latest-completed templates migrate as their confirmed successful version', () => {
  const step = originalStep();
  const raw = registry.createStageScriptBucket('mine_resource', step);
  for (const key of ['validationSchema', 'lastSuccessfulStep', 'validatedRevision', 'candidateStep', 'candidateRevision', 'candidateStatus', 'stepHistory']) delete raw[key];
  Object.assign(raw, { success: 3, failed: 2, revision: 2, lastOutcome: 'completed' });
  const restored = registry.normalizeLearningStageScripts({ [raw.key]: raw })[raw.key];
  assert.deepEqual(restored.lastSuccessfulStep, step);
  assert.equal(restored.validatedRevision, 2);
  assert.equal(retrieve(restored).bucket, restored);
  record(restored, step, 'blocked', 'no_path');
  assert.deepEqual(restored.lastSuccessfulStep, step);
  assert.equal(restored.candidateRevision, 3);
});

test('a quarantined legacy template can become reusable only after its exact current stage succeeds', () => {
  const step = originalStep();
  const raw = registry.createStageScriptBucket('mine_resource', step);
  for (const key of ['validationSchema', 'lastSuccessfulStep', 'validatedRevision', 'candidateStep', 'candidateRevision', 'candidateStatus', 'stepHistory']) delete raw[key];
  Object.assign(raw, { success: 3, failed: 2, revision: 2, lastOutcome: 'failed' });
  const restored = registry.normalizeLearningStageScripts({ [raw.key]: raw })[raw.key];
  assert.equal(retrieve(restored), null);
  record(restored, step, 'completed');
  assert.equal(restored.candidateStatus, 'validated');
  assert.equal(restored.validatedRevision, 2);
  assert.equal(retrieve(restored).bucket, restored);
  assert.equal(restored.success, 4);
  assert.equal(restored.failed, 2);
  assert.ok(restored.stepHistory.some(version => version.status === 'legacy_unverified'));
});

test('candidate and validated construction versions retain source and profile matching boundaries', () => {
  const selfPlan = registry.buildHeuristicTaskPlan('build_estate', { profile: 'medieval_castle', useNearbySupplyChests: false });
  const step = selfPlan.steps[0];
  const task = { intent: selfPlan.intent, plan: selfPlan, completionPlan: copy(selfPlan), currentStepIndex: 0 };
  const bucket = registry.createStageScriptBucket(task.intent, step);
  registry.rememberStageScriptOutcome(bucket, task, step, 'completed');
  registry.rememberStageScriptOutcome(bucket, task, step, 'blocked', 'no_path', {}, {
    reviseStepForFailure: value => ({ ...value, args: { ...value.args, profile: 'riverside_villa', materialSource: 'external_depots', useNearbySupplyChests: true } }),
  });
  assert.deepEqual(bucket.lastSuccessfulStep, { skill: step.skill, args: step.args });
  assert.equal(bucket.candidateStep, null, 'reject a repair that changes source/profile');
  const external = registry.buildHeuristicTaskPlan('build_estate', { profile: 'medieval_castle', useNearbySupplyChests: true });
  assert.equal(registry.findBestLearnedStageScript(external.intent, external.steps[0], { [bucket.key]: bucket }), null);
});
