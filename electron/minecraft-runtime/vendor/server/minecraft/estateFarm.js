/* global require, module, setTimeout */
'use strict';

// All writes are injected native, task-owned actions. This module only reads
// the actual bot world/inventory; it never supplies block states or positions.
const { Vec3 } = require('vec3');
const crypto = require('node:crypto');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const SOIL = new Set(['grass_block', 'dirt']);
const HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow', 'campfire', 'soul_campfire']);
const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'golden_hoe', 'wooden_hoe'];
const key = p => `${p.x},${p.y},${p.z}`;
const error = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const props = b => b?.getProperties?.() || b?.properties || {};
const plain = p => ({ x: p.x, y: p.y, z: p.z });

function normalizeFarmSpec(spec) {
  if (spec?.schema !== 1 || typeof spec.id !== 'string' || !spec.id || !Array.isArray(spec.plots) || spec.plots.length !== 2) {
    throw error('farm_invalid_spec', '农田必须声明唯一编号与两块5×5田地');
  }
  const all = new Set();
  const ids = new Set();
  const position = p => {
    if (!p || !['x', 'y', 'z'].every(k => Number.isInteger(p[k])) || p.y < -63 || p.y > 318) throw error('farm_invalid_spec', '农田坐标必须是可用世界范围内的整数');
    return plain(p);
  };
  const plots = spec.plots.map(plot => {
    if (!plot.id || ids.has(plot.id)) throw error('farm_invalid_spec', '农田分区编号重复或缺失');
    ids.add(plot.id);
    const water = position(plot.water);
    if (!Array.isArray(plot.soil) || plot.soil.length !== 24) throw error('farm_invalid_spec', '每块田地必须有24格耕地和中央水源');
    const expected = new Set();
    for (let dx = -2; dx <= 2; dx += 1) for (let dz = -2; dz <= 2; dz += 1) if (dx || dz) expected.add(key({ x: water.x + dx, y: water.y, z: water.z + dz }));
    const soil = plot.soil.map(position);
    for (const p of [water, ...soil]) {
      if (all.has(key(p))) throw error('farm_invalid_spec', '两块农田的归属坐标不能重叠');
      all.add(key(p));
    }
    if (new Set(soil.map(key)).size !== 24 || soil.some(p => !expected.has(key(p)))) throw error('farm_invalid_spec', '耕地必须覆盖中央水孔以外的完整5×5范围');
    const crops = plot.crops || soil.map(p => ({ soilPosition: p, position: { ...p, y: p.y + 1 }, item: 'wheat_seeds', block: 'wheat' }));
    if (!Array.isArray(crops) || crops.length !== 24) throw error('farm_invalid_spec', '每块田地必须有24个播种目标');
    const cropKeys = new Set();
    const normalized = crops.map(crop => {
      const soilPosition = position(crop.soilPosition);
      const p = position(crop.position);
      if (!expected.has(key(soilPosition)) || p.x !== soilPosition.x || p.z !== soilPosition.z || p.y !== soilPosition.y + 1
        || (crop.item || 'wheat_seeds') !== 'wheat_seeds' || (crop.block || 'wheat') !== 'wheat' || cropKeys.has(key(p))) throw error('farm_invalid_spec', '播种目标必须一一对应归属耕地上方的小麦');
      cropKeys.add(key(p));
      return { soilPosition, position: p, item: 'wheat_seeds', block: 'wheat' };
    });
    return { id: String(plot.id), water, soil, crops: normalized, access: (plot.access || []).map(plain) };
  });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(plots.map(p => ({ id: p.id, water: p.water,
    soil: [...p.soil].sort((a, b) => key(a).localeCompare(key(b))) })))).digest('hex');
  return { schema: 1, id: spec.id, plots, fingerprint };
}

function createEstateFarm(deps) {
  let state;
  let plan;
  const active = () => deps.assertActive();
  const bot = () => deps.getBot();
  const at = p => {
    const value = bot().blockAt(new Vec3(p.x, p.y, p.z));
    if (!value) throw error('farm_unloaded', `农田方块未加载：${key(p)}`);
    return value;
  };
  const inventory = () => (bot().inventory?.items?.() || []).reduce((out, item) => {
    out[item.name] = (out[item.name] || 0) + item.count;
    return out;
  }, {});
  const count = name => inventory()[name] || 0;
  const save = patch => { active(); state = { ...state, ...patch }; deps.setCheckpoint(state); };
  const report = message => { active(); deps.report?.(message); };
  const native = async (name, ...args) => {
    active();
    if (typeof deps[name] !== 'function') throw error('farm_dependency_missing', `农田原生动作未接入：${name}`);
    const value = await deps[name](...args);
    active();
    return value;
  };
  async function waitFor(predicate, code, message, timeout = deps.worldTimeoutMs || 5000) {
    const deadline = Date.now() + timeout;
    while (true) {
      active();
      if (predicate()) return;
      if (Date.now() >= deadline) throw error(code, message);
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
  }
  function initialize(spec) {
    active(); plan = normalizeFarmSpec(spec);
    const old = deps.getCheckpoint?.() || {};
    if (old.specFingerprint && (old.id !== plan.id || old.specFingerprint !== plan.fingerprint)) throw error('farm_checkpoint_mismatch', '农田恢复坐标与原任务不一致');
    state = old.specFingerprint ? { ...old } : { schema: 1, id: plan.id, specFingerprint: plan.fingerprint,
      phase: 'inspect', waterSources: [], tilledSoil: [], plantedCrops: [] };
  }
  function safeStance() {
    const entity = bot().entity;
    if (!entity?.position || entity.onGround === false) throw error('farm_unsafe_stance', '农田操作需要真实落稳站位');
    const p = entity.position, half = (entity.width || 0.6) / 2, height = entity.height || 1.8;
    let support = false;
    for (let x = Math.floor(p.x - half); x <= Math.floor(p.x + half); x += 1) for (let z = Math.floor(p.z - half); z <= Math.floor(p.z + half); z += 1) {
      for (let y = Math.floor(p.y - 0.06); y <= Math.floor(p.y + height); y += 1) {
        const b = at({ x, y, z });
        if (HAZARDS.has(b.name) || props(b).waterlogged === true) throw error('farm_unsafe_stance', '农田操作站位必须远离流体和危险方块');
        const shapes = b.shapes || (b.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : []);
        for (const s of shapes) {
          if (p.x + half <= x + s[0] || p.x - half >= x + s[3] || p.z + half <= z + s[2] || p.z - half >= z + s[5]) continue;
          const top = y + s[4];
          if (Math.abs(p.y - top) < 0.08) support = true;
          if (p.y + 0.02 < top && p.y + height > y + s[1] + 0.02) throw error('farm_unsafe_stance', '农田操作站位与实际方块碰撞');
        }
      }
    }
    if (!support) throw error('farm_unsafe_stance', '农田操作站位缺少真实支撑');
  }
  async function reach(p, action, plot, range = 4.5) {
    const reached = await native('reach', p, { action, range, allowedWaterSources: plan.plots.map(q => plain(q.water)), access: plot.access,
      avoidSupportBlock: action === 'dig_water_hole' ? plain(p) : undefined });
    if (reached === false || reached?.confirmed === false) throw error('farm_unreachable', '农田原生动作没有可达的干燥安全站位');
    safeStance();
  }
  async function equip(name) {
    if (count(name) < 1) throw error('farm_materials_missing', `农田材料不足：${name}`, { missing: [{ item: name, count: 1 }] });
    await native('equip', name);
    if (bot().heldItem?.name !== name) throw error('farm_equip_failed', `没有确认手持 ${name}`);
  }
  const sourceWater = p => at(p).name === 'water' && Number(props(at(p)).level) === 0;
  const supportsWater = block => block.boundingBox === 'block' && !HAZARDS.has(block.name)
    && !Object.prototype.hasOwnProperty.call(props(block), 'waterlogged')
    && (block.shapes || [[0, 0, 0, 1, 1, 1]]).some(s => s[0] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1);
  const cropPresent = p => at(p).name === 'wheat' && Number.isInteger(Number(props(at(p)).age)) && Number(props(at(p)).age) >= 0 && Number(props(at(p)).age) <= 7;
  const addConfirmed = (field, p) => save({ [field]: [...new Set([...(state[field] || []), key(p)])] });
  function notSupportingPlayer(p) {
    const e = bot().entity, half = (e.width || 0.6) / 2;
    if (e.position.x + half > p.x && e.position.x - half < p.x + 1 && e.position.z + half > p.z && e.position.z - half < p.z + 1
      && Math.abs(e.position.y - (p.y + 1)) < 0.12) throw error('farm_supporting_player', '不能挖掉机器人脚下的水孔支撑');
  }
  async function water(plot) {
    const p = plot.water;
    if (sourceWater(p)) { addConfirmed('waterSources', p); return; }
    const current = at(p);
    if (SOIL.has(current.name) || current.name === 'farmland') {
      await reach(p, 'dig_water_hole', plot);
      notSupportingPlayer(p);
      save({ phase: 'dig_water_hole', plotId: plot.id, target: plain(p) });
      await native('dig', at(p));
      await waitFor(() => AIR.has(at(p).name), 'farm_water_hole_failed', '水孔没有确认挖空');
    } else if (!AIR.has(current.name) && current.name !== 'water') throw error('farm_terrain_obstructed', `水孔被 ${current.name} 占用`);
    const below = { ...p, y: p.y - 1 };
    if (!supportsWater(at(below))) throw error('farm_water_support_missing', '水孔下方缺少干燥、不可含水的完整支撑');
    await reach(p, 'pour_water', plot);
    await equip('water_bucket');
    const before = inventory();
    save({ phase: 'pour_water', plotId: plot.id, target: plain(p) });
    await native('lookAt', { x: p.x + 0.5, y: p.y + 0.01, z: p.z + 0.5 });
    await native('activateItem');
    await waitFor(() => sourceWater(p) && count('water_bucket') === (before.water_bucket || 0) - 1
      && count('bucket') === (before.bucket || 0) + 1, 'farm_water_source_failed', '没有同时确认中央静止水源与水桶消耗');
    addConfirmed('waterSources', p);
  }
  async function plant(crop, plot) {
    if (at(crop.soilPosition).name !== 'farmland') throw error('farm_soil_changed', '播种位置已不再是归属耕地');
    if (cropPresent(crop.position)) { addConfirmed('plantedCrops', crop.position); return; }
    if (!AIR.has(at(crop.position).name)) throw error('farm_crop_obstructed', '播种格被其他方块占用');
    await reach(crop.soilPosition, 'plant_crop', plot);
    await equip('wheat_seeds');
    const before = count('wheat_seeds');
    save({ phase: 'plant_crop', plotId: plot.id, target: plain(crop.position) });
    await native('activateBlock', at(crop.soilPosition), new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
    await waitFor(() => cropPresent(crop.position) && count('wheat_seeds') === before - 1,
      'farm_seed_not_confirmed', '没有同时确认原生播种方块与种子消耗');
    addConfirmed('plantedCrops', crop.position);
  }
  async function build(spec) {
    initialize(spec);
    let neededWater = 0, neededSeeds = 0, neededDirt = 0, needsHoe = false;
    for (const plot of plan.plots) {
      const center = at(plot.water);
      if (!SOIL.has(center.name) && center.name !== 'farmland' && !AIR.has(center.name) && center.name !== 'water') {
        throw error('farm_terrain_obstructed', `水孔被 ${center.name} 占用`);
      }
      if (!supportsWater(at({ ...plot.water, y: plot.water.y - 1 }))) throw error('farm_water_support_missing', '水孔底部支撑缺失或可能被水桶含水修改');
      if (!sourceWater(plot.water)) neededWater += 1;
      for (const crop of plot.crops) {
        const soil = at(crop.soilPosition), top = at(crop.position);
        if (AIR.has(soil.name)) neededDirt += 1;
        else if (!SOIL.has(soil.name) && soil.name !== 'farmland') throw error('farm_terrain_obstructed', `耕地被 ${soil.name} 占用`);
        if (!AIR.has(top.name) && !cropPresent(crop.position)) throw error('farm_crop_obstructed', '归属播种格被其他方块占用');
        if (soil.name !== 'farmland') needsHoe = true;
        if (!cropPresent(crop.position)) neededSeeds += 1;
      }
    }
    const hoe = HOES.find(name => count(name) > 0);
    const missing = Object.entries({ water_bucket: neededWater, wheat_seeds: neededSeeds, dirt: neededDirt })
      .filter(([name, amount]) => count(name) < amount).map(([item, amount]) => ({ item, count: amount - count(item) }));
    if (needsHoe && !hoe) missing.push({ item: 'hoe', count: 1 });
    if (missing.length) throw error('farm_materials_missing', `农田材料不足：${missing.map(m => `${m.item}×${m.count}`).join('、')}`, { missing });
    save({ phase: 'prepare', requirements: { water_bucket: neededWater, wheat_seeds: neededSeeds, dirt: neededDirt, hoe: needsHoe ? 1 : 0 } });
    // Close every missing soil cell before pouring. Otherwise an adjacent hole
    // lets a new source flow beyond its explicitly owned water coordinate.
    for (const plot of plan.plots) for (const crop of plot.crops) {
      if (!AIR.has(at(crop.soilPosition).name)) continue;
      await reach(crop.soilPosition, 'fill_soil', plot);
      const before = count('dirt');
      save({ phase: 'fill_soil', plotId: plot.id, target: crop.soilPosition });
      await native('placeBlock', { position: crop.soilPosition, item: 'dirt', properties: {} });
      await waitFor(() => at(crop.soilPosition).name === 'dirt' && count('dirt') === before - 1, 'farm_soil_fill_failed', '没有确认填土方块与泥土消耗');
    }
    for (const plot of plan.plots) await water(plot);
    for (const plot of plan.plots) for (const crop of plot.crops) {
      active(); report(`农田 ${plot.id}：正在锄地和播种 ${key(crop.soilPosition)}`);
      if (at(crop.soilPosition).name !== 'farmland') {
        if (!SOIL.has(at(crop.soilPosition).name)) throw error('farm_soil_changed', '锄地前归属土壤发生变化');
        await reach(crop.soilPosition, 'till_soil', plot);
        await equip(hoe);
        save({ phase: 'till_soil', plotId: plot.id, target: crop.soilPosition });
        await native('activateBlock', at(crop.soilPosition), new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5));
        await waitFor(() => at(crop.soilPosition).name === 'farmland', 'farm_till_not_confirmed', '原生锄地没有变成真实耕地');
      }
      addConfirmed('tilledSoil', crop.soilPosition);
      await plant(crop, plot);
    }
    active();
    if (plan.plots.some(p => !sourceWater(p.water) || p.crops.some(c => at(c.soilPosition).name !== 'farmland' || !cropPresent(c.position)))) throw error('farm_verification_failed', '农田最终水源、耕地或作物状态不完整');
    const summary = { schema: 1, id: plan.id, specFingerprint: plan.fingerprint, farmVerified: true,
      waterSourceCount: 2, soilCount: 48, plantedCount: 48, moisture: plan.plots.flatMap(p => p.soil.map(s => ({ position: s, value: Number(props(at(s)).moisture) }))) };
    save({ phase: 'complete', buildSummary: summary });
    report('两块农田已完成真实水源、锄地和播种校验');
    return summary;
  }
  async function validate(spec, options = {}) {
    active();
    if (options.postPublicTask !== true || options.allowBoneMeal !== true) {
      throw error('farm_validation_not_authorized', '催熟和收割验证只能在公开任务结束后的独立验收阶段显式执行');
    }
    initialize(spec);
    const candidates = plan.plots.flatMap(plot => plot.crops.map(crop => ({ plot, crop })));
    const requested = options.targets || plan.plots.map(plot => plot.crops[0].position);
    if (!Array.isArray(requested) || !requested.length || requested.length > 48
      || requested.some(p => !p || !['x', 'y', 'z'].every(k => Number.isInteger(p[k])))
      || new Set(requested.map(key)).size !== requested.length) {
      throw error('farm_invalid_validation', '验收目标必须是互不重复的归属作物坐标');
    }
    const targets = requested.map(p => {
      const entry = candidates.find(c => key(c.crop.position) === key(p));
      if (!entry) throw error('farm_invalid_validation', '不能催熟或收割农田范围外的作物');
      return entry;
    });
    if (plan.plots.some(plot => !sourceWater(plot.water) || plot.soil.some(p => at(p).name !== 'farmland'))) {
      throw error('farm_verification_failed', '收割验收前水源和48格耕地必须保持完整');
    }
    if (candidates.some(t => !cropPresent(t.crop.position) && !(state.validationPending
      && key(state.validationPending.position) === key(t.crop.position) && AIR.has(at(t.crop.position).name)
      && ['harvest_requested', 'collect_drops', 'replant_requested'].includes(state.validationPending.stage)))) {
      throw error('farm_verification_failed', '独立验收前48格作物必须完整，或只缺少原任务已记录的待补种目标');
    }
    const completed = [...(state.validationCycles || [])];
    const todo = targets.filter(t => !completed.some(c => key(c.position) === key(t.crop.position)));
    const pendingFor = t => state.validationPending && key(state.validationPending.position) === key(t.crop.position)
      ? state.validationPending : null;
    const boneNeeded = todo.reduce((sum, t) => sum + (pendingFor(t)?.stage && pendingFor(t).stage !== 'maturing' ? 0
      : cropPresent(t.crop.position) ? Math.ceil((7 - Number(props(at(t.crop.position)).age)) / 2) : 0), 0);
    const seedsNeeded = todo.filter(t => !(pendingFor(t)?.stage === 'replant_requested' && cropPresent(t.crop.position)
      && count('wheat_seeds') === pendingFor(t).beforePlantSeeds - 1)).length;
    const missing = [];
    if (count('bone_meal') < boneNeeded) missing.push({ item: 'bone_meal', count: boneNeeded - count('bone_meal') });
    if (count('wheat_seeds') < seedsNeeded) missing.push({ item: 'wheat_seeds', count: seedsNeeded - count('wheat_seeds') });
    if (missing.length) throw error('farm_materials_missing', '独立收割验收缺少骨粉或补种备用种子', { missing });
    for (const { plot, crop } of targets) {
      active();
      if (completed.some(c => key(c.position) === key(crop.position))) {
        if (!cropPresent(crop.position)) throw error('farm_crop_changed', '已完成验收的补种作物发生变化');
        continue;
      }
      let pending = state.validationPending;
      if (pending && key(pending.position) !== key(crop.position)) throw error('farm_validation_resume_mismatch', '请先恢复原先暂停的收割目标');
      const beforeCycle = pending?.beforeCycle || inventory();
      if (!pending) {
        if (!cropPresent(crop.position)) throw error('farm_crop_changed', '独立验收目标不是实际种植的小麦');
        pending = { position: crop.position, stage: 'maturing', beforeCycle, ageBefore: Number(props(at(crop.position)).age) };
        save({ phase: 'validate_maturing', validationPending: pending });
      }
      if (pending.stage === 'maturing') {
        if (!cropPresent(crop.position)) throw error('farm_crop_changed', '催熟中的小麦被移除或替换');
        let uses = 0;
        while (Number(props(at(crop.position)).age) < 7) {
          if (!cropPresent(crop.position) || uses >= 4) throw error('farm_growth_not_confirmed', '小麦没有在有限原生骨粉使用内成熟');
          await reach(crop.position, 'bone_meal', plot);
          await equip('bone_meal');
          const age = Number(props(at(crop.position)).age), before = count('bone_meal');
          await native('activateBlock', at(crop.position), new Vec3(0, 1, 0), new Vec3(0.5, 0.5, 0.5));
          await waitFor(() => cropPresent(crop.position) && Number(props(at(crop.position)).age) > age
            && count('bone_meal') === before - 1, 'farm_growth_not_confirmed', '没有同时确认真实作物长大与骨粉消耗');
          uses += 1;
        }
        pending = { ...pending, stage: 'harvest_requested', beforeHarvest: inventory(), ageMature: Number(props(at(crop.position)).age) };
        save({ phase: 'validate_harvest', validationPending: pending });
      }
      if (pending.stage === 'harvest_requested') {
        if (cropPresent(crop.position)) {
          if (Number(props(at(crop.position)).age) !== 7) throw error('farm_crop_changed', '不能收割未成熟的小麦');
          await reach(crop.position, 'harvest_crop', plot);
          await native('dig', at(crop.position));
        } else if (!AIR.has(at(crop.position).name)) throw error('farm_crop_changed', '收割目标被其他方块替换');
        await waitFor(() => AIR.has(at(crop.position).name), 'farm_harvest_not_confirmed', '原生收割后作物格没有清空');
        pending = { ...pending, stage: 'collect_drops' };
        save({ phase: 'validate_pickup', validationPending: pending });
      }
      if (pending.stage === 'collect_drops') {
        if (count('wheat') < (pending.beforeHarvest.wheat || 0) + 1) {
          if (typeof deps.collectDrops === 'function') await native('collectDrops', crop.position,
            { items: ['wheat', 'wheat_seeds'], minimumWheat: 1, allowedWaterSources: plan.plots.map(p => p.water), timeoutMs: 8000 });
          else await reach(crop.position, 'collect_drops', plot, 0.8);
        }
        await waitFor(() => count('wheat') >= (pending.beforeHarvest.wheat || 0) + 1,
          'farm_pickup_not_confirmed', '没有实际拾取成熟小麦掉落物');
        // Item drops arrive independently. Wait for inventory to settle before
        // measuring the seed consumed by replanting; never award the drops.
        let previous = JSON.stringify(inventory()), stableAt = Date.now();
        const deadline = Date.now() + 2000;
        while (Date.now() - stableAt < 250 && Date.now() < deadline) {
          active(); await new Promise(resolve => setTimeout(resolve, 25)); active();
          const current = JSON.stringify(inventory());
          if (current !== previous) { previous = current; stableAt = Date.now(); }
        }
        pending = { ...pending, stage: 'replant_requested', afterHarvest: inventory(), beforePlantSeeds: count('wheat_seeds') };
        save({ phase: 'validate_replant', validationPending: pending });
      }
      if (pending.stage === 'replant_requested') {
        if (cropPresent(crop.position)) {
          if (count('wheat_seeds') !== pending.beforePlantSeeds - 1) throw error('farm_seed_not_confirmed', '恢复补种时没有确认原生种子消耗');
        } else await plant(crop, plot);
        active();
        const after = inventory();
        const cycle = { position: crop.position, ageBefore: pending.ageBefore, ageMature: pending.ageMature,
          ageAfterReplant: Number(props(at(crop.position)).age), beforeCycle: pending.beforeCycle,
          beforeHarvest: pending.beforeHarvest, afterHarvest: pending.afterHarvest, afterReplant: after,
          wheatCollected: (pending.afterHarvest.wheat || 0) - (pending.beforeHarvest.wheat || 0),
          seedsCollected: (pending.afterHarvest.wheat_seeds || 0) - (pending.beforeHarvest.wheat_seeds || 0),
          boneMealUsed: (pending.beforeCycle.bone_meal || 0) - (pending.beforeHarvest.bone_meal || 0),
          seedConsumedForReplant: pending.beforePlantSeeds - (after.wheat_seeds || 0), confirmed: true };
        if (!cropPresent(crop.position) || cycle.seedConsumedForReplant !== 1) throw error('farm_seed_not_confirmed', '收割后没有确认实际补种');
        completed.push(cycle);
        save({ phase: 'validate_cycle_complete', validationPending: null, validationCycles: [...completed] });
        report(`农田 ${plot.id} 已确认真实催熟、收割、拾取和补种`);
      }
    }
    if (candidates.some(t => !cropPresent(t.crop.position) || at(t.crop.soilPosition).name !== 'farmland')
      || plan.plots.some(p => !sourceWater(p.water))) throw error('farm_verification_failed', '独立收割后农田没有保持完整');
    const summary = { schema: 1, id: plan.id, validationVerified: true, controlledPostPublicTest: true,
      cycles: completed, harvestedWheat: completed.reduce((sum, c) => sum + c.wheatCollected, 0),
      boneMealUsed: completed.reduce((sum, c) => sum + c.boneMealUsed, 0) };
    save({ phase: 'validated', validationSummary: summary });
    return summary;
  }
  return { build, validate };
}

module.exports = { createEstateFarm, normalizeFarmSpec };
