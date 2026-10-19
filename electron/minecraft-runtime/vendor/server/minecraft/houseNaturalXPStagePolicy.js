/* global module */
'use strict';
const XP_STAGE_MS = 4 * 60 * 60 * 1000;
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
const same = (a, b) => integer(a) && integer(b) && ['x', 'y', 'z'].every(k => a[k] === b[k]);
const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
function originalConstruction(task) {
  const plan = task?.completionPlan || task?.plan;
  if (!plan || !Array.isArray(plan.steps)) return null;
  const step = plan.steps.find(entry => ['build_furnished_house_phase', 'build_estate'].includes(entry?.skill));
  if (step?.args?.materialSource !== 'self_gathered' || step.args.useNearbySupplyChests === true) return null;
  return { plan, step };
}
function isSelfGatheredLibraryFinish(task, step) {
  const original = originalConstruction(task);
  if (!original || original.plan.intent !== 'build_furnished_house' || original.step.skill !== 'build_furnished_house_phase'
    || original.step.args.profile !== 'enchanting_library' || step?.skill !== 'build_furnished_house_phase'
    || step.args?.profile !== 'enchanting_library' || step.args.materialSource !== 'self_gathered'
    || step.args.useNearbySupplyChests === true || step.args.phase !== 'finish') return false;
  const authorized = original.plan.steps.filter(entry => entry?.skill === step.skill && entry.args?.phase === 'finish');
  if (authorized.length !== 1 || authorized[0].args.profile !== 'enchanting_library'
    || authorized[0].args.materialSource !== 'self_gathered' || authorized[0].args.useNearbySupplyChests === true) return false;
  if (authorized[0].args.anchor && (!step.args.anchor || !same(authorized[0].args.anchor, step.args.anchor))) return false;
  return true;
}
function isSelfGatheredEstate(task, step) {
  const original = originalConstruction(task);
  if (!original || original.plan.intent !== 'build_estate' || original.step.skill !== 'build_estate'
    || step?.skill !== 'build_estate' || !['medieval_castle', 'riverside_villa'].includes(original.step.args.profile)
    || step.args?.profile !== original.step.args.profile || step.args.materialSource !== 'self_gathered'
    || step.args.useNearbySupplyChests === true) return false;
  return !original.step.args.anchor || step.args.anchor && same(original.step.args.anchor, step.args.anchor);
}
function readNaturalXPStageBudget(frame, capture, now = Date.now()) {
  if (!frame || frame.task !== capture.task || frame.bot !== capture.bot || frame.client !== capture.client
    || frame.token !== capture.token || frame.lease !== capture.lease || frame.generation !== capture.generation
    || frame.stepIndex !== capture.task.currentStepIndex || frame.step !== capture.task.plan?.steps?.[frame.stepIndex]) {
    throw fail('house_xp_stage_budget_pending', 'No matching captured current watchdog frame');
  }
  const allowed = isSelfGatheredLibraryFinish(frame.task, frame.step) || isSelfGatheredEstate(frame.task, frame.step);
  if (!allowed || !Number.isSafeInteger(frame.startedAt) || !Number.isSafeInteger(frame.deadline)
    || !Number.isSafeInteger(frame.hardTimeoutMs) || frame.hardTimeoutMs < XP_STAGE_MS
    || frame.deadline !== frame.startedAt + frame.hardTimeoutMs || !Number.isFinite(now) || now < frame.startedAt) {
    throw fail('house_xp_stage_budget_pending', 'Original advanced source and finite actual watchdog deadline required');
  }
  const remainingMs = Math.max(0, Math.floor(frame.deadline - now));
  if (remainingMs <= 0) throw fail('step_timeout', 'Original advanced construction watchdog deadline reached',
    { elapsedMs: Math.floor(now - frame.startedAt), actualStageBudgetMs: frame.hardTimeoutMs, remainingMs: 0 });
  return { elapsedMs: Math.floor(now - frame.startedAt), actualStageBudgetMs: frame.hardTimeoutMs,
    remainingMs, xpBudgetMs: Math.min(XP_STAGE_MS, remainingMs), deadline: frame.deadline };
}
module.exports = { XP_STAGE_MS, originalConstruction, isSelfGatheredLibraryFinish, isSelfGatheredEstate, readNaturalXPStageBudget };
