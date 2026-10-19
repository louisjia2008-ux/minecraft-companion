/* global require, module, setTimeout, clearTimeout */
'use strict';
const { Vec3 } = require('vec3');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const vec = p => new Vec3(p.x, p.y, p.z);

function createEstateDockPlacement(deps) {
  for (const method of ['getBot', 'assertActive', 'isOwnerCurrent', 'moveTo', 'standingSafely', 'canPlace',
    'equip', 'placeAgainst', 'setControl', 'look', 'waitTick', 'stopOwnMovement']) {
    if (typeof deps?.[method] !== 'function') throw fail('estate_invalid_dock_runtime', `码头施工缺少真实运行接口：${method}`);
  }
  async function place({ blueprint, spec, onConfirmed }) {
    const bot = deps.getBot();
    const identity = () => deps.getBot() === bot && deps.isOwnerCurrent(bot) === true;
    const active = () => { deps.assertActive(); if (!identity()) throw fail('estate_dock_owner_changed', '码头施工执行归属已变化'); };
    const at = p => bot.blockAt(vec(p));
    const dryPlank = p => at(p)?.name === 'oak_planks' && String(at(p).getProperties?.().waterlogged) !== 'true';
    const sourceWater = p => at(p)?.name === 'water' && Number(at(p).getProperties?.().level) === 0;
    const ownedControls = new Set();
    let ownsSneak = false;
    async function control(name, value) {
      active();
      if (value && (name !== 'sneak' || ownsSneak)) ownedControls.add(name);
      await deps.setControl(name, value);
      active();
    }
    async function tick(deadline) {
      active();
      if (Date.now() >= deadline) throw fail('estate_dock_edge_timeout', '码头边缘真实步进超时');
      await deps.waitTick(Math.max(1, deadline - Date.now()));
      active();
    }
    async function walkUntil(test, deadline) {
      // Native physics can emit several catch-up ticks in one callback.
      // Stop synchronously within that event, before its next simulation;
      // a Promise continuation after once(physicsTick) can arrive too late.
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true; bot.removeListener('physicsTick', check); clearTimeout(timer);
          let stop;
          try { if (identity()) stop = deps.stopOwnMovement({ controls: ['forward'], releaseSneak: false }); }
          catch (e) { error ||= e; }
          Promise.resolve(stop).then(() => error ? reject(error) : resolve(), reject);
        };
        const check = () => { try { active(); if (test()) finish(); } catch (error) { finish(error); } };
        const timer = setTimeout(() => finish(fail('estate_dock_edge_timeout', '码头边缘真实步进超时')), Math.max(1, deadline - Date.now()));
        bot.on('physicsTick', check); check();
      });
    }
    function stable() {
      if (!bot.entity.onGround || !deps.standingSafely(bot.entity.position) || bot.entity.isInWater || bot.entity.isInLava) {
        throw fail('estate_dock_unsafe_stance', '码头施工失去干燥真实支撑或进入流体');
      }
    }
    active();
    if (blueprint?.schema !== 1 || blueprint.profile !== 'riverside_villa' || spec?.component !== 'villa_dock' ||
      spec.phase !== 'floor' || spec.item !== 'oak_planks' || !blueprint.blocks.some(s => s.id === spec.id && s.position.x === spec.position.x && s.position.y === spec.position.y && s.position.z === spec.position.z)) {
      throw fail('estate_invalid_dock_placement', '侧放步进仅用于当前河畔别墅码头地板');
    }
    const target = vec(spec.position);
    const below = target.offset(0, -1, 0);
    const readyTarget = () => AIR.has(at(target)?.name) && sourceWater(below);
    if (!readyTarget()) throw fail('estate_dock_target_changed', '码头目标必须是源水面上方的已加载空气');
    const candidates = blueprint.blocks.filter(s => s.item === 'oak_planks' && s.phase === 'floor' && s.position.y === target.y &&
      Math.abs(s.position.x - target.x) + Math.abs(s.position.z - target.z) === 1 && dryPlank(s.position));
    if (!candidates.length) throw fail('house_no_anchor', '码头没有已确认相邻干木板');
    const reference = vec(candidates.sort((a, b) => vec(a.position).distanceTo(bot.entity.position) - vec(b.position).distanceTo(bot.entity.position))[0].position);
    const face = target.minus(reference);
    const center = reference.offset(.5, 1, .5);
    const edge = center.plus(face.scaled(.6));
    try {
      await deps.moveTo({ x: reference.x, y: reference.y + 1, z: reference.z }, .65);
      active(); stable();
      if (Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z) > .7 || Math.abs(bot.entity.position.y - center.y) > .07) {
        throw fail('estate_dock_reference_unconfirmed', '没有到达已确认木板参考面');
      }
      await deps.equip('oak_planks'); active();
      ownsSneak = bot.getControlState?.('sneak') !== true;
      await control('sneak', true);
      const centerDeadline = Date.now() + 3000;
      // Native goto can stop within its block before reaching the center.
      // Align with real sneaking controls on the dry reference, never by
      // changing entity coordinates or weakening the support test.
      const centerDelta = center.minus(bot.entity.position);
      if (Math.hypot(centerDelta.x, centerDelta.z) > .1) {
        await deps.look(Math.atan2(-centerDelta.x, -centerDelta.z), 0); active();
        await control('forward', true);
        await walkUntil(() => {
          stable();
          if (!dryPlank(reference) || !readyTarget()) throw fail('estate_dock_target_changed', '边缘步进前参考木板或水面改变');
          return Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z) <= .1;
        }, centerDeadline);
        await control('forward', false);
        for (let i = 0; i < 3; i += 1) { await tick(centerDeadline); stable(); }
      }
      if (Math.hypot(bot.entity.position.x - center.x, bot.entity.position.z - center.z) > .18) throw fail('estate_dock_reference_unconfirmed', '原生步进没有收敛到干木板中心');
      deps.report?.('码头参考木板中心已确认', { reference, target, actualFeet: bot.entity.position.clone(), onGround: bot.entity.onGround });
      await deps.look(Math.atan2(-face.x, -face.z), 0); active();
      const deadline = Date.now() + 3000;
      await control('forward', true);
      const inspect = () => {
        active(); stable();
        const offset = bot.entity.position.minus(center);
        const projection = offset.x * face.x + offset.z * face.z;
        const lateral = Math.abs(offset.x * face.z - offset.z * face.x);
        if (!dryPlank(reference) || !readyTarget() || Math.abs(offset.y) > .07 || lateral > .18 || projection < -.2 || projection > .78) {
          const error = fail('estate_dock_edge_changed', '码头边缘支撑、目标或实际位置超出安全范围');
          error.details = { position: bot.entity.position.clone(), reference, target, offset, projection, lateral,
            referenceBlock: at(reference)?.name, targetBlock: at(target)?.name, waterBlock: at(below)?.name, waterProperties: at(below)?.getProperties?.() };
          throw error;
        }
        return projection >= .58 && deps.canPlace(at(reference), face, target, bot.entity.position) === true;
      };
      await walkUntil(inspect, deadline);
      await control('forward', false);
      for (let i = 0; i < 3; i += 1) { await tick(deadline); inspect(); }
      if (!inspect()) throw fail('estate_dock_edge_unconfirmed', '停步后没有确认真实侧面视线');
      deps.report?.('码头原生潜行边缘站位已确认', { reference, target, intendedEdge: edge, actualFeet: bot.entity.position.clone() });
      await deps.placeAgainst(at(reference), face, target, 'oak_planks', { onConfirmed, beforeSend: () => {
        if (!inspect()) throw fail('estate_dock_edge_unconfirmed', '原生发包前侧面站位没有保持');
      } });
      active(); stable();
      if (!dryPlank(target) || !sourceWater(below)) throw fail('estate_dock_placement_unconfirmed', '原生侧放后木板和下方源水没有确认');
      await deps.stopOwnMovement({ controls: [...ownedControls], releaseSneak: ownsSneak }); active();
      ownedControls.clear(); ownsSneak = false;
      await deps.moveTo({ x: reference.x, y: reference.y + 1, z: reference.z }, .65);
      active(); stable();
      deps.report?.('码头放置后已原生返回原参考木板', { reference, target, actualFeet: bot.entity.position.clone(), onGround: bot.entity.onGround });
      return { confirmed: true, target: { ...spec.position }, reference: { x: reference.x, y: reference.y, z: reference.z } };
    } finally {
      // Stop this owner's controls even after its own pause, but never write
      // or restore old controls after another bot/task/generation takes over.
      if (identity() && (ownedControls.size || ownsSneak)) await deps.stopOwnMovement({ controls: [...ownedControls], releaseSneak: ownsSneak });
    }
  }
  return { place };
}
module.exports = { createEstateDockPlacement };
