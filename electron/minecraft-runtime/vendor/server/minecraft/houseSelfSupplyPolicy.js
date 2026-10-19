/* global module */
'use strict';
function isSelfSuppliedHouseTask(task, context = {}) {
  if (context.selfSupplyOnly === true) return true;
  const original = task?.completionPlan || task?.plan;
  const steps = original?.steps || [];
  return steps.some(step => step.skill === 'build_furnished_house_phase' ||
    step.skill === 'build_estate' && (step.args?.useNearbySupplyChests !== true || step.args?.materialSource === 'self_gathered'));
}
function assertHouseExternalWithdrawalAllowed(task, context = {}) {
  if (isSelfSuppliedHouseTask(task, context)) throw Object.assign(new Error('本任务必须自行采集材料，不能自动从玩家箱子取物资'), { code: 'house_external_supply_forbidden' });
}
module.exports = { isSelfSuppliedHouseTask, assertHouseExternalWithdrawalAllowed };
