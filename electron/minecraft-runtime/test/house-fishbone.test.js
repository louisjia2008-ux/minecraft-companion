'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createFishbone, nextFishboneAction, confirmFishboneAdvance, confirmFishboneReturn } = require('../vendor/server/minecraft/houseFishbone');
test('fishbone geometry leaves two solid columns between paired 12m branches', () => {
  const plan = createFishbone({ x: 0, y: 16, z: 0 }, { x: 1, z: 0 });
  let index = 0; const endpoints = [], junctions = [];
  for (let i = 0; i < 58; i++) {
    const action = nextFishboneAction(plan);
    if (action.kind === 'return') {
      endpoints.push({ ...plan.cursor }); junctions.push({ ...action.position });
      index = action.index; confirmFishboneReturn(plan, action.position, index);
    } else {
      confirmFishboneAdvance(plan, action.from, action.target, index, index + 1); index++;
    }
  }
  assert.deepEqual(endpoints.slice(0, 4), [
    { x: 3, y: 16, z: -12 }, { x: 3, y: 16, z: 12 },
    { x: 6, y: 16, z: -12 }, { x: 6, y: 16, z: 12 },
  ]);
  assert.deepEqual(junctions.slice(0, 2), [{ x: 3, y: 16, z: 0 }, { x: 3, y: 16, z: 0 }]);
});
test('planning alone and serialized interrupted steps grant no successful movement', () => {
  const plan = createFishbone({ x: 4, y: -54, z: 7 }, { x: 0, z: -1 });
  const before = JSON.stringify(plan), action = nextFishboneAction(plan);
  assert.equal(JSON.stringify(plan), before);
  plan.pending = { ...action, fromIndex: 8 };
  const restored = JSON.parse(JSON.stringify(plan)); assert.equal(restored.progress, 0);
  assert.throws(() => confirmFishboneAdvance(restored, action.from, { ...action.target, y: -53 }, 8, 9), { code: 'house_quarry_fishbone_unconfirmed' });
  confirmFishboneAdvance(restored, action.from, action.target, 8, 9);
  assert.equal(restored.progress, 1); assert.equal(restored.pending, null);
  assert.throws(() => confirmFishboneAdvance(restored, action.from, action.target, 8, 9), { code: 'house_quarry_fishbone_unconfirmed' });
});
test('return acknowledgement requires the exact physical junction and recorded index', () => {
  const plan = createFishbone({ x: 0, y: 16, z: 0 }, { x: 1, z: 0 });
  plan.stage = 'return_left'; plan.junction = { x: 3, y: 16, z: 0 }; plan.junctionIndex = 3;
  assert.throws(() => confirmFishboneReturn(plan, { x: 3, y: 16, z: 1 }, 3), { code: 'house_quarry_fishbone_unconfirmed' });
  assert.throws(() => confirmFishboneReturn(plan, plan.junction, 4), { code: 'house_quarry_fishbone_unconfirmed' });
  confirmFishboneReturn(plan, plan.junction, 3); assert.equal(plan.stage, 'right');
});

test('an old fishbone can retire only when its cursor belongs to a genuinely archived different navigation',()=>{
 const {belongsToAbandonedNavigation:retire}=require('../vendor/server/minecraft/houseFishbone');
 const plan=createFishbone({x:0,y:16,z:0},{x:1,z:0}),old={navigation:{breadcrumbs:[plan.cursor]}},current={breadcrumbs:[{x:30,y:16,z:0}]};
 assert.equal(retire(plan,current,[old]),true);
 assert.equal(retire(plan,{breadcrumbs:[plan.cursor]},[old]),false);
 assert.equal(retire(plan,current,[]),false);
 assert.equal(retire(plan,current,[{navigation:{breadcrumbs:[{x:1,y:16,z:0}]}}]),false);
});
