/* global require, module */
'use strict';
const { Vec3 } = require('vec3');
const { createEstateFarm } = require('./estateFarm');
const { matchesFurnishedHouseBlock } = require('./furnishedHouseBuilder');
const { planEstateDoorClosure } = require('./estateDoorClosure');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const vec = p => new Vec3(p.x, p.y, p.z);

// Crops have no collision ray shape. Interactions still address the native
// crop block, but a reachable soil top supplies the sight/stance proof.
function estateFarmActionTarget(bot, position, action) {
  let cell = vec(position);
  if (['bone_meal', 'harvest_crop'].includes(action)) cell = cell.offset(0, -1, 0);
  if (['pour_water', 'fill_soil'].includes(action)) cell = cell.offset(0, -1, 0);
  const block = bot.blockAt(cell);
  const top = Math.max(0, ...(block?.shapes || []).map(s => s[4]));
  return { cell, point: cell.offset(0.5, Math.max(0.01, top - 0.001), 0.5) };
}

function createEstateNativeAdapter(deps) {
  const active = () => deps.assertActive();
  const bot = () => deps.getBot();
  const at = p => bot().blockAt(vec(p));
  const report = message => { active(); deps.report(message); };
  const count = name => bot().inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  async function reach(position, options) {
    active();
    const target = estateFarmActionTarget(bot(), position, options.action);
    const canAct = feet => {
      if (options.avoidSupportBlock && !deps.digAvoidsSupport(vec(options.avoidSupportBlock), feet)) return false;
      if (options.action === 'collect_drops') return Math.hypot(feet.x - position.x - 0.5, feet.z - position.z - 0.5) <= options.range
        && Math.abs(feet.y - position.y) <= 1.1;
      const eye = feet.offset(0, Number(bot().entity.eyeHeight) || 1.62, 0);
      const delta = target.point.minus(eye);
      if (delta.norm() > options.range || !delta.norm()) return false;
      const hit = bot().world.raycast(eye, delta.normalize(), options.range);
      return hit?.position?.equals(target.cell) === true;
    };
    await deps.reach(vec(position), canAct, `农田 ${options.action}`);
    active();
    return { confirmed: canAct(bot().entity.position) && deps.standingSafely(bot().entity.position) };
  }
  function farmFor(owner) {
    return createEstateFarm({
      getBot: bot, assertActive: active,
      getCheckpoint: () => deps.getFarmCheckpoint(owner),
      setCheckpoint: state => deps.setFarmCheckpoint(owner, state), report,
      reach,
      equip: async name => { active(); await deps.equip(name); active(); },
      dig: async block => {
        active();
        const crop = block.name === 'wheat';
        const position = block.position;
        if (!crop && !deps.digAvoidsSupport(position, bot().entity.position)) throw fail('farm_supporting_player', '不能挖掉脚下支撑');
        await reach(position, { action: crop ? 'harvest_crop' : 'dig_water_hole', range: 4.5,
          avoidSupportBlock: crop ? undefined : position });
        active();
        const current = at(position);
        if (!current || current.name !== block.name || !bot().canDigBlock(current)) throw fail('farm_dig_unconfirmed', '原生农田挖掘目标已改变或不可挖');
        await deps.dig(current);
        active();
      },
      placeBlock: deps.placeBlock,
      lookAt: p => deps.lookAt(vec(p)), activateItem: deps.activateItem,
      activateBlock: (block, face, cursor) => deps.activateBlock(block, face, cursor),
      collectDrops: async (position, options) => {
        active();
        const before = count('wheat');
        const deadline = Date.now() + options.timeoutMs;
        while (count('wheat') < before + options.minimumWheat && Date.now() < deadline) {
          // Border paving is one cell from the nearest crop. Pick up from
          // there before considering a lower farmland stance that can be
          // trampled by a jump; native inventory remains the success proof.
          await reach(position, { action: 'collect_drops', range: 1.3 });
          active(); await deps.wait(180); active();
        }
        if (!deps.standingSafely(bot().entity.position)) throw fail('farm_unsafe_stance', '拾取后没有确认安全支撑');
      },
    });
  }
  async function windowAt(position, method, label) {
    active();
    await deps.moveTo(position, 2);
    active();
    let opened;
    try {
      opened = await deps[method](at(position));
      active();
      if (!opened || typeof opened.close !== 'function') throw fail('estate_furniture_unusable', `${label}没有实际打开`);
      return { confirmed: true, position: { ...position } };
    } finally {
      if (opened) opened.close();
    }
  }
  async function setDoor(door, open, options = {}) {
    active();
    if (!options.skipMove) await deps.moveTo(door.lower, 2);
    active();
    options.checkSide?.();
    if (at(door.lower)?.getProperties?.().open !== open) await deps.activateBlock(at(door.lower), undefined, undefined, options.checkSide);
    const deadline = Date.now() + 1500;
    while (at(door.lower)?.getProperties?.().open !== open || at(door.upper)?.getProperties?.().open !== open) {
      active();
      if (Date.now() >= deadline) throw fail('estate_door_unconfirmed', '房门双格开关状态没有确认');
      await deps.wait(50);
    }
    active();
  }
  async function openConstructionDoors(blueprint) {
    for (const door of blueprint.furniture.doors || [blueprint.furniture.door]) {
      active();
      const lower = at(door.lower), upper = at(door.upper);
      if (lower?.name !== 'oak_door' && upper?.name !== 'oak_door') continue;
      const lo = lower?.getProperties?.(), hi = upper?.getProperties?.();
      if (lower?.name !== 'oak_door' || upper?.name !== 'oak_door' || lo?.half !== 'lower' || hi?.half !== 'upper'
        || lo.facing !== door.facing || hi.facing !== door.facing || lo.hinge !== hi.hinge || lo.open !== hi.open) {
        throw fail('estate_door_unconfirmed', '已建房门的两格状态发生变化，不能自动开门');
      }
      if (lo.open !== true) await setDoor(door, true);
    }
  }
  async function verifyRoutes(blueprint) {
    active();
    // Open from the current side before any route asks A* to cross a door.
    for (const door of blueprint.furniture.doors || [blueprint.furniture.door]) await setDoor(door, true);
    const checks = [];
    for (const route of blueprint.routes) {
      for (const point of route.waypoints) { active(); await deps.moveTo(point, 0.65); active(); }
      checks.push({ id: route.id, traversed: true, waypoints: route.waypoints.length });
    }
    return { confirmed: true, checks };
  }
  async function verifyFurniture(blueprint) {
    active();
    const f = blueprint.furniture;
    for (const door of f.doors || [f.door]) await setDoor(door, true);
    const checks = { craftingTable: await windowAt(f.craftingTable, 'openCraftingTable', '工作台'),
      chests: [], furnaces: [], beds: [] };
    for (const p of f.chests || [f.chest]) checks.chests.push(await windowAt(p, 'openContainer', '箱子'));
    for (const p of f.furnaces || [f.furnace]) checks.furnaces.push(await windowAt(p, 'openFurnace', '熔炉'));
    for (const bed of f.beds || [f.bed]) {
      const confirmed = matchesFurnishedHouseBlock(at(bed.foot), { item: 'white_bed', properties: { part: 'foot', facing: bed.facing, occupied: false } })
        && matchesFurnishedHouseBlock(at(bed.head), { item: 'white_bed', properties: { part: 'head', facing: bed.facing, occupied: false } });
      if (!confirmed) throw fail('estate_furniture_unusable', '床双格状态没有确认');
      await deps.moveTo(bed.foot, 2);
      checks.beds.push({ confirmed, position: bed.foot, sleepUseObserved: false });
    }
    checks.enchantingTable = await windowAt(f.enchantingTable, 'openEnchantmentTable', '附魔台');
    const effective = f.bookshelves.filter(p => {
      const dx = p.x - f.enchantingTable.x, dz = p.z - f.enchantingTable.z;
      const gap = { x: f.enchantingTable.x + Math.trunc(dx / 2), y: f.enchantingTable.y, z: f.enchantingTable.z + Math.trunc(dz / 2) };
      return at(p)?.name === 'bookshelf' && AIR.has(at(gap)?.name) && AIR.has(at({ ...gap, y: gap.y + 1 })?.name);
    });
    checks.bookshelves = { confirmed: effective.length >= 15, effectiveCount: effective.length };
    if (!checks.bookshelves.confirmed) throw fail('estate_enchanting_obstructed', '有效附魔书架不足15个');
    checks.doorClosure = [];
    for (const step of planEstateDoorClosure(blueprint)) {
      active();
      await deps.moveTo(step.approach, 0.3);
      active();
      const direction = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[step.door.facing];
      const checkSide = () => {
        active();
        const feet = bot().entity.position;
        const side = (feet.x - step.door.lower.x - 0.5) * direction[0] + (feet.z - step.door.lower.z - 0.5) * direction[1];
        if (!bot().entity.onGround || !deps.standingSafely(feet) || (step.side === 'outside' ? side <= 0.35 : side >= -0.35)) {
          throw fail('estate_door_escape_unconfirmed', '关门前没有到达保留退路的一侧安全站位');
        }
      };
      await setDoor(step.door, false, { skipMove: true, checkSide });
      checks.doorClosure.push({ confirmed: true, position: step.door.lower, side: step.side, escapePurpose: step.escapePurpose });
    }
    await deps.moveTo(blueprint.entrance.outside);
    if (!(f.doors || [f.door]).every(door => at(door.lower)?.getProperties?.().open === false && at(door.upper)?.getProperties?.().open === false)) {
      throw fail('estate_door_unconfirmed', '退出建筑后没有确认所有房门双格关闭');
    }
    active();
    return checks;
  }
  return { farmFor, reachFarm: reach, verifyFurniture, verifyRoutes, openConstructionDoors };
}
module.exports = { createEstateNativeAdapter, estateFarmActionTarget };
