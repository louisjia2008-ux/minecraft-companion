/* global module */
'use strict';

const FACING = Object.freeze({ north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] });
const key = p => `${p?.x},${p?.y},${p?.z}`;
const invalid = message => Object.assign(new Error(message), { code: 'estate_invalid_door_closure' });
const integerPosition = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]));

function planEstateDoorClosure(blueprint) {
  if (!['medieval_castle', 'riverside_villa'].includes(blueprint?.profile) || blueprint.schema !== 1 || !integerPosition(blueprint.anchor)) {
    throw invalid('关门计划仅支持当前 schema1 城堡和河畔别墅');
  }
  const input = blueprint.furniture?.doors;
  if (!Array.isArray(input) || input.length !== (blueprint.profile === 'riverside_villa' ? 5 : 1)) throw invalid('庄园房门数量与当前款式不符');
  const doors = input.map(door => {
    if (!integerPosition(door?.lower) || !integerPosition(door?.upper) || !FACING[door.facing] ||
      door.upper.x !== door.lower.x || door.upper.z !== door.lower.z || door.upper.y !== door.lower.y + 1) {
      throw invalid('房门双格坐标或朝向无效');
    }
    return { lower: { ...door.lower }, upper: { ...door.upper }, facing: door.facing };
  });
  if (new Set(doors.map(door => key(door.lower))).size !== doors.length) throw invalid('关门计划包含重复房门');
  const main = doors.find(door => key(door.lower) === key(blueprint.furniture.door?.lower));
  if (!main || key(main.upper) !== key(blueprint.furniture.door.upper) || main.facing !== blueprint.furniture.door.facing) throw invalid('主出口未对应真实蓝图房门');
  function step(door, side, escapePurpose) {
    const direction = FACING[door.facing];
    const sign = side === 'outside' ? 1 : -1;
    return { door, side, approach: { x: door.lower.x + direction[0] * sign, y: door.lower.y,
      z: door.lower.z + direction[1] * sign }, escapePurpose };
  }
  if (blueprint.profile === 'medieval_castle') return [step(main, 'outside', 'finish_outside_main_door')];

  const upper = doors.filter(door => door.lower.y === blueprint.anchor.y + 5);
  const ground = doors.filter(door => door.lower.y === blueprint.anchor.y + 1);
  const exit = upper.find(door => door.facing === 'west' && door.lower.x === blueprint.anchor.x);
  if (upper.length !== 2 || ground.length !== 3 || !exit || !ground.includes(main) || main.facing !== 'north') {
    throw invalid('别墅上层外梯出口或一层主出口与现蓝图不符');
  }
  // The rear balcony has no separate ground stair. Close that leaf from the
  // interior while the west exit stays open, then cross the west door onto
  // its permanent stair landing before closing it. Keep the main ground
  // door open until every other ground leaf has been closed from inside.
  return [
    ...upper.filter(door => door !== exit).sort((a, b) => b.lower.y - a.lower.y)
      .map(door => step(door, 'inside', 'leave_upper_via_open_west_door')),
    step(exit, 'outside', 'descend_permanent_west_stairs'),
    ...ground.filter(door => door !== main).map(door => step(door, 'inside', 'leave_ground_via_open_main_door')),
    step(main, 'outside', 'finish_outside_main_door'),
  ];
}

module.exports = { planEstateDoorClosure };
