'use strict';
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;
const fail = () => Object.assign(Error('鱼骨矿道的实际确认与计划不符'), { code: 'house_quarry_fishbone_unconfirmed' });
function createFishbone(position, direction) {
  return { schema: 1, origin: { ...position }, cursor: { ...position }, direction: { ...direction },
    spacing: 3, length: 12, stage: 'main', progress: 0, junction: null, junctionIndex: null, pending: null };
}
function nextFishboneAction(plan) {
  if (plan.stage.startsWith('return_')) return { kind: 'return', position: plan.junction, index: plan.junctionIndex };
  const d = plan.direction;
  const direction = plan.stage === 'left' ? { x: d.z, z: -d.x }
    : plan.stage === 'right' ? { x: -d.z, z: d.x } : d;
  return { kind: 'advance', direction, from: { ...plan.cursor },
    target: { x: plan.cursor.x + direction.x, y: plan.cursor.y, z: plan.cursor.z + direction.z } };
}
function confirmFishboneAdvance(plan, from, to, fromIndex, toIndex) {
  const action = nextFishboneAction(plan);
  if (action.kind !== 'advance' || !same(from, action.from) || !same(to, action.target) || toIndex !== fromIndex + 1) throw fail();
  plan.cursor = { ...to }; plan.progress++; plan.pending = null;
  if (plan.stage === 'main' && plan.progress === plan.spacing) {
    plan.junction = { ...to }; plan.junctionIndex = toIndex; plan.stage = 'left'; plan.progress = 0;
  } else if (plan.stage !== 'main' && plan.progress === plan.length) plan.stage = `return_${plan.stage}`;
}
function confirmFishboneReturn(plan, position, index) {
  if (!plan.stage.startsWith('return_') || !same(position, plan.junction) || index !== plan.junctionIndex) throw fail();
  plan.stage = plan.stage === 'return_left' ? 'right' : 'main'; plan.progress = 0; plan.cursor = { ...position }; plan.pending = null;
}
function belongsToAbandonedNavigation(plan,navigation,abandoned){
  return Boolean(plan?.cursor&&Array.isArray(navigation?.breadcrumbs)
    &&!navigation.breadcrumbs.some(p=>same(p,plan.cursor))
    &&(abandoned||[]).some(old=>old.navigation?.breadcrumbs?.some(p=>same(p,plan.cursor))));
}
module.exports = { createFishbone, nextFishboneAction, confirmFishboneAdvance, confirmFishboneReturn, belongsToAbandonedNavigation };
