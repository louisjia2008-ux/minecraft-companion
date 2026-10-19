/* global require, module */
'use strict';

const { Vec3 } = require('vec3');
const { createEstateBlueprint, ESTATE_PROFILES, ESTATE_PHASES } = require('./estateBlueprints');
const { planEstateMaterialBatch } = require('./estateMaterials');

const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['lava', 'water', 'fire', 'soul_fire', 'magma_block', 'powder_snow', 'cactus', 'campfire', 'soul_campfire']);
const VEGETATION = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'leaf_litter', 'snow']);
const SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'farmland']);
const DEFER = new Set(['house_no_anchor', 'placement_no_safe_stance']);
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const plain = p => ({ x: p.x, y: p.y, z: p.z });
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const properties = block => block?.getProperties?.() || {};
const wet = block => String(properties(block).waterlogged) === 'true';
const support = block => Boolean(block && block.boundingBox === 'block' && !HAZARDS.has(block.name) && !wet(block));

function matchesEstateBlock(block, spec) {
  return Boolean(block && block.name === spec.item && Object.entries(spec.properties || {})
    .every(([name, value]) => String(properties(block)[name]) === String(value)));
}

function getEstateScaffoldCleanupOrder(specs) {
  // Ranks are generated per route: the outer approach-side cell is removed
  // before an inner cell at the same Y, with the lower layer still intact.
  return [...specs].sort((a, b) => b.position.y - a.position.y || a.cleanupRank - b.cleanupRank ||
    a.position.x - b.position.x || a.position.z - b.position.z);
}

function getEstateDerivedBlocks(blueprint, spec) {
  if (spec.derived) return [];
  let target;
  if (spec.item === 'oak_door') target = { ...spec.position, y: spec.position.y + 1 };
  else if (spec.item === 'white_bed') {
    const delta = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[spec.properties?.facing];
    if (!delta) throw fail('estate_invalid_blueprint', `床缺少有效朝向：${spec.id}`);
    target = { ...spec.position, x: spec.position.x + delta[0], z: spec.position.z + delta[1] };
  } else return [];
  const derived = blueprint.blocks.find(entry => entry.derived && entry.item === spec.item && key(entry.position) === key(target));
  if (!derived) throw fail('estate_invalid_blueprint', `家具缺少对应派生格：${spec.id}`);
  return [derived];
}

function createEstateBuilder(deps) {
  let blueprint;
  let state;
  const active = () => deps.assertActive();
  const at = p => deps.getBot().blockAt(new Vec3(p.x, p.y, p.z));
  const ownedIds = () => new Set(state.ownedBlockIds || []);
  const scaffoldMatches = (block, spec) => block?.name === spec.item || spec.item === 'dirt' && ['grass_block', 'mycelium'].includes(block?.name);
  const replaceable = block => Boolean(block && !HAZARDS.has(block.name) && !wet(block) &&
    (AIR.has(block.name) || VEGETATION.has(block.name) && block.boundingBox === 'empty'));

  function save(patch = {}) {
    active();
    // Supply initialization captures authorized depot coordinates after the
    // first batch; do not overwrite those with an older local checkpoint.
    const latest = deps.getCheckpoint?.();
    const depots = latest?.schema === 1 && latest.sourceProfile === blueprint.profile ? latest.depots : state?.depots;
    state = { ...state, ...(depots ? { depots } : {}), ...patch, schema: 1, sourceProfile: blueprint.profile, anchor: plain(blueprint.anchor) };
    deps.setCheckpoint(state);
  }
  function report(message, patch = {}) { save(patch); deps.report(message); }
  function confirmedOwnership(spec, scaffold) {
    // Native placement can confirm immediately before a user cancellation.
    // Recording that fact is allowed; this callback performs no world action.
    if (scaffold) {
      if (!(state.ownedScaffold || []).some(entry => entry.id === spec.id)) {
        state = { ...state, ownedScaffold: [...(state.ownedScaffold || []), { ...spec, position: plain(spec.position) }] };
      }
    } else state = { ...state, ownedBlockIds: [...new Set([...(state.ownedBlockIds || []), spec.id])] };
    if (deps.recordOwnedBlock) deps.recordOwnedBlock(spec, scaffold);
    else deps.setCheckpoint(state);
  }
  function complete(spec) {
    return [spec, ...getEstateDerivedBlocks(blueprint, spec)].every(constructionMatches);
  }
  function constructionMatches(spec) {
    // A resumed native route check may have left a door open. Keep its two
    // real cells and let furniture verification close it; do not consume a
    // replacement door just because the harmless open property changed.
    if (spec.item !== 'oak_door') return matchesEstateBlock(at(spec.position), spec);
    const expected = { ...spec, properties: { ...spec.properties } };
    delete expected.properties.open;
    return ['true', 'false'].includes(String(properties(at(spec.position)).open)) && matchesEstateBlock(at(spec.position), expected);
  }
  function componentComplete(component) {
    return blueprint.blocks.filter(spec => spec.component === component.id).every(constructionMatches);
  }
  function hasAnchor(spec) {
    const offsets = ['white_bed', 'oak_door', 'torch', 'oak_log'].includes(spec.item) ? [[0, -1, 0]] :
      [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    return offsets.some(([x, y, z]) => support(at({ x: spec.position.x + x, y: spec.position.y + y, z: spec.position.z + z })));
  }

  function validateCheckpoint() {
    const specs = new Map(blueprint.scaffold.map(spec => [spec.id, spec]));
    const permanent = new Set(blueprint.blocks.map(spec => spec.id));
    if ((state.ownedBlockIds || []).some(id => !permanent.has(id))) throw fail('estate_checkpoint_mismatch', '已确认永久方块不属于当前蓝图');
    for (const entry of state.ownedScaffold || []) {
      const spec = specs.get(entry.id);
      if (!spec || key(entry.position) !== key(spec.position) || entry.item !== spec.item || entry.component !== spec.component || entry.routeId !== spec.routeId ||
        entry.cleanupRank !== spec.cleanupRank || entry.stage !== spec.stage || entry.approachDirection !== spec.approachDirection) {
        throw fail('estate_checkpoint_mismatch', '脚手架归属与当前蓝图不一致');
      }
    }
  }

  function inspectSite() {
    const expected = new Map(blueprint.blocks.map(spec => [key(spec.position), spec]));
    const owned = ownedIds();
    const temporary = new Map((state.ownedScaffold || []).map(spec => [key(spec.position), spec]));
    const soils = new Set(blueprint.farms.flatMap(plot => plot.soil.map(key)));
    const waters = new Set(blueprint.farms.map(plot => key(plot.water)));
    const crops = new Set(blueprint.farms.flatMap(plot => plot.crops.map(crop => key(crop.position))));
    const removals = [];
    const b = blueprint.workBounds;
    // This complete read-only pass precedes supply retrieval and any digging.
    for (let y = b.minY; y <= b.maxY + 2; y += 1) for (let x = b.minX; x <= b.maxX; x += 1) for (let z = b.minZ; z <= b.maxZ; z += 1) {
      active();
      const position = { x, y, z }; const id = key(position); const block = at(position);
      if (!block) throw fail('estate_unsafe_site', `施工范围尚未加载：${id}`, { position });
      if (state.farmStarted && waters.has(id) && block.name === 'water' && Number(properties(block).level) === 0) continue;
      if (HAZARDS.has(block.name) || wet(block)) throw fail('estate_unsafe_site', `施工范围存在 ${block.name}：${id}`, { position });
      if (AIR.has(block.name)) continue;
      const spec = expected.get(id); const scaffold = temporary.get(id);
      if (spec && constructionMatches(spec) || scaffold && scaffoldMatches(block, scaffold)) continue;
      if (soils.has(id) && SOIL.has(block.name) || state.farmStarted && crops.has(id) && block.name === 'wheat') continue;
      if (spec && owned.has(spec.id) && block.name === spec.item) continue;
      if (replaceable(block)) { removals.push(position); continue; }
      throw fail('estate_site_occupied', `施工范围被未归属的 ${block.name} 占用：${id}`, { position });
    }
    for (const position of blueprint.siteRequirements.dryGroundCells) {
      active();
      if (!support(at(position))) throw fail('estate_unsafe_ground', `干燥施工地基缺少真实支撑：${key(position)}`, { position });
    }
    for (const zone of blueprint.waterZones) {
      const river = zone.bounds;
      for (let x = river.minX; x <= river.maxX; x += 1) for (let z = river.minZ; z <= river.maxZ; z += 1) {
        const position = { x, y: river.minY, z };
        if (at(position)?.name !== 'water' || Number(properties(at(position)).level) !== 0) throw fail('estate_unsafe_river', `声明的河面不是同高度静水源：${key(position)}`);
      }
    }
    return removals.sort((a, b) => b.y - a.y);
  }

  async function clearVegetation(removals) {
    for (const position of removals) {
      active();
      const block = at(position);
      if (AIR.has(block?.name)) continue;
      if (!replaceable(block)) throw fail('estate_site_changed', `清理前施工格已改变：${key(position)}`);
      report('正在清理已预检的地表植物', { phase: 'clear_site', currentPosition: plain(position) });
      await deps.breakBlock(position, { maxFeetY: position.y });
      active();
      if (!AIR.has(at(position)?.name)) throw fail('estate_clear_unconfirmed', `地表植物没有确认清除：${key(position)}`);
    }
  }

  function checkDock(spec) {
    if (spec.component !== 'villa_dock' || spec.phase !== 'floor') return;
    if (!AIR.has(at(spec.position)?.name)) throw fail('estate_unsafe_dock', '码头木板必须侧放到真实空气格');
    const adjacent = blueprint.blocks.filter(entry => entry.item === 'oak_planks' && entry.phase === 'floor' &&
      entry.position.y === spec.position.y && Math.abs(entry.position.x - spec.position.x) + Math.abs(entry.position.z - spec.position.z) === 1);
    if (!adjacent.some(entry => matchesEstateBlock(at(entry.position), entry) && !wet(at(entry.position)))) {
      throw fail('house_no_anchor', '码头尚无已确认的相邻干燥木板');
    }
    const below = { ...spec.position, y: spec.position.y - 1 };
    if (at(below)?.name !== 'water') throw fail('estate_unsafe_dock', '码头下方已不符合声明水面');
  }

  async function place(spec, scaffold = false) {
    active();
    if (scaffold ? scaffoldMatches(at(spec.position), spec) && (state.ownedScaffold || []).some(entry => entry.id === spec.id) : complete(spec)) return;
    const related = scaffold ? [] : getEstateDerivedBlocks(blueprint, spec);
    const actual = at(spec.position);
    if (!actual || HAZARDS.has(actual.name) || wet(actual)) throw fail('estate_unsafe_site', `放置目标未加载或存在危险：${key(spec.position)}`);
    if (!replaceable(actual)) {
      if (scaffold || !ownedIds().has(spec.id) || actual.name !== spec.item) throw fail('estate_site_changed', `放置目标出现未归属方块：${key(spec.position)}`);
      // Repair only a confirmed owned primary; native bed/door destruction
      // removes its associated derived cell, which is checked again below.
      await deps.breakBlock(spec.position, { maxFeetY: spec.position.y });
      active();
    }
    for (const entry of [spec, ...related]) if (!replaceable(at(entry.position))) {
      throw fail('estate_site_changed', `家具本体或派生格被占用：${key(entry.position)}`);
    }
    checkDock(spec);
    let recorded = false;
    const confirmed = () => {
      if (recorded || at(spec.position)?.name !== spec.item) return;
      recorded = true;
      confirmedOwnership(spec, scaffold);
      if (!scaffold) for (const entry of related) if (at(entry.position)?.name === entry.item) confirmedOwnership(entry, false);
    };
    await deps.placeBlock({ ...spec, derivedBlocks: related }, confirmed);
    confirmed();
    active();
    if (![spec, ...related].every(entry => matchesEstateBlock(at(entry.position), entry))) throw fail('house_state_mismatch', `原生放置后方块状态不符：${spec.id}`);
    save();
  }

  async function supply(specs, component, phase) {
    const batch = planEstateMaterialBatch(specs, { maxBlocks: 96, maxStacks: 12,
      stackSize: name => deps.getBot().registry?.itemsByName?.[name]?.stackSize || 64 });
    report(`正在补充 ${component.label} ${phase} 当前批次建材`, { component: component.id, phase, requirements: batch.requirements, missingMaterials: [], verificationSummary: null });
    await deps.prepareMaterials(batch.requirements, { component: component.id, phase });
    active();
    const missingMaterials = Object.entries(batch.requirements).filter(([name, n]) => deps.getItemCount(name) < n)
      .map(([item, required]) => ({ item, required, available: deps.getItemCount(item), missing: required - deps.getItemCount(item) }));
    save({ missingMaterials });
    if (missingMaterials.length) throw fail('house_materials_missing', '当前施工批次真实背包材料不足，请补料后恢复', { missingMaterials });
    return batch.blocks;
  }

  async function buildSpecs(specs, component, phase, scaffold = false) {
    let pending = specs.filter(spec => scaffold ? !(state.ownedScaffold || []).some(entry => entry.id === spec.id && scaffoldMatches(at(spec.position), spec)) : !complete(spec))
      .sort((a, b) => a.position.y - b.position.y || (phase === 'roof'
        ? a.position.x - b.position.x || a.position.z - b.position.z
        : a.position.z - b.position.z || a.position.x - b.position.x));
    while (pending.length) {
      active();
      // Reserve the next bounded group, including its future upper cells.
      // Adjacent support is checked just before each actual placement, so a
      // thirteen-level ramp needs one dirt supply trip rather than thirteen.
      let queue = await supply(pending, component, phase);
      while (queue.length) {
        let progressed = 0;
        let lastError;
        const done = new Set();
        for (const spec of queue) {
          if (!hasAnchor(spec)) continue;
          report(`正在建造 ${component.label}：${phase}`, { component: component.id, phase, currentBlockId: spec.id });
          try { await place(spec, scaffold); done.add(spec.id); progressed += 1; }
          catch (error) { active(); if (!DEFER.has(error.code)) throw error; lastError = error; }
        }
        queue = queue.filter(spec => !done.has(spec.id));
        pending = pending.filter(spec => !done.has(spec.id));
        if (progressed || !queue.length) continue;
        // A later gable/reference can seed an otherwise unsupported first
        // group. Rebudget it FIRST with the remaining queue, still <=96 and
        // <=12 stacks; displaced cells remain pending for a later batch.
        const queued = new Set(queue.map(spec => spec.id));
        for (const seed of pending.filter(spec => !queued.has(spec.id) && hasAnchor(spec))) {
          const alternative = await supply([seed, ...queue], component, phase);
          try {
            await place(seed, scaffold);
            pending = pending.filter(spec => spec.id !== seed.id);
            queue = alternative.filter(spec => spec.id !== seed.id);
            progressed += 1;
            break;
          } catch (error) { active(); if (!DEFER.has(error.code)) throw error; lastError = error; }
        }
        if (!progressed) throw lastError || fail('house_no_anchor', `组件 ${component.id} 没有可继续施工的真实邻接支撑`, { pendingBlockIds: queue.map(spec => spec.id) });
      }
    }
  }

  async function buildScaffold(component, stage) {
    const supportedPhases = stage === 'roof' ? ['roof'] : ['frame', 'walls', 'windows', 'roof'];
    // On resumed cleanup, a completed roof must not recreate removed dirt
    // merely because later furniture or farm work is still outstanding.
    if (!blueprint.blocks.some(spec => spec.component === component.id && supportedPhases.includes(spec.phase) && !constructionMatches(spec))) return;
    await buildSpecs(blueprint.scaffold.filter(spec => spec.component === component.id && spec.stage === stage), component, `scaffold_${stage}`, true);
  }

  async function cleanup(component) {
    const owners = blueprint.components.filter(entry => (entry.cleanupAfterComponent || entry.id) === component.id).map(entry => entry.id);
    const owned = (state.ownedScaffold || []).filter(spec => owners.includes(spec.component));
    if (!owned.length) return;
    save({ component: component.id, phase: 'cleanup', scaffoldCleanupStarted: true });
    const routes = blueprint.scaffoldRoutes.filter(route => owned.some(spec => spec.routeId === route.id));
    // Exit while all support is still present, then descend each route from
    // its permanent/ground approach. Never issue cleanup in a finally block.
    for (const route of routes) {
      active();
      await deps.moveTo(route.cleanupStart);
      active();
      for (const spec of getEstateScaffoldCleanupOrder(owned.filter(entry => entry.routeId === route.id))) {
        active();
        const actual = at(spec.position);
        if (!actual || HAZARDS.has(actual.name) || wet(actual)) throw fail('estate_unsafe_site', `清理格未加载或存在危险：${key(spec.position)}`);
        if (!AIR.has(actual.name)) {
          if (!scaffoldMatches(actual, spec)) throw fail('house_scaffold_changed', `脚手架被改为 ${actual.name}，拒绝清理：${key(spec.position)}`);
          await deps.breakBlock(spec.position, { maxFeetY: spec.position.y });
          active();
          if (!AIR.has(at(spec.position)?.name)) throw fail('estate_cleanup_unconfirmed', '脚手架没有确认移除');
        }
        save({ ownedScaffold: (state.ownedScaffold || []).filter(entry => entry.id !== spec.id) });
      }
    }
  }

  function structureSummary() {
    const missingBlockIds = []; const stateMismatches = [];
    for (const spec of blueprint.blocks) {
      const actual = at(spec.position);
      if (actual?.name !== spec.item) missingBlockIds.push(spec.id);
      else if (!matchesEstateBlock(actual, spec)) stateMismatches.push(spec.id);
    }
    const clearanceViolations = blueprint.clearance.filter(entry => !AIR.has(at(entry.position)?.name)).map(entry => ({ ...entry, position: plain(entry.position) }));
    const scaffoldRemaining = blueprint.scaffold.filter(spec => !AIR.has(at(spec.position)?.name)).map(spec => spec.id);
    return { schema: 1, sourceProfile: blueprint.profile, anchor: plain(blueprint.anchor), totalBlocks: blueprint.blocks.length,
      missingBlocks: missingBlockIds.length, missingBlockIds, stateMismatches, clearanceViolations,
      scaffoldRemaining,
      furnitureVerified: false, routeVerified: false, farmVerified: false };
  }
  function requireStructure(summary, allowOpenDoors = false) {
    const mismatches = allowOpenDoors ? summary.stateMismatches.filter(id => !constructionMatches(blueprint.blocks.find(spec => spec.id === id))) : summary.stateMismatches;
    if (summary.missingBlocks || mismatches.length || summary.clearanceViolations.length) {
      throw fail('estate_verification_failed', `庄园缺块 ${summary.missingBlocks}、状态不符 ${summary.stateMismatches.length}、净空阻挡 ${summary.clearanceViolations.length}`, { verificationSummary: summary });
    }
    if (summary.scaffoldRemaining.length) throw fail('house_scaffold_remaining', '真实世界中仍有临时施工格被占用', { verificationSummary: summary });
  }
  function verifyFarmState() {
    return blueprint.farms.every(plot => at(plot.water)?.name === 'water' && Number(properties(at(plot.water)).level) === 0 &&
      plot.crops.every(crop => at(crop.soilPosition)?.name === 'farmland' && Number(properties(at(crop.soilPosition)).moisture) === plot.hydration && at(crop.position)?.name === crop.block));
  }

  async function verify() {
    report('正在逐块校验庄园、永久通路、家具和农田', { phase: 'verify', verified: false, routeVerified: false, farmVerified: false });
    let summary = structureSummary();
    save({ verificationSummary: summary });
    requireStructure(summary, true);
    if ((state.ownedScaffold || []).length || summary.scaffoldRemaining.length) throw fail('house_scaffold_remaining', '庄园临时脚手架尚未全部移除');
    const routes = await deps.verifyRoutes(blueprint);
    active();
    if (routes?.confirmed !== true || !blueprint.routes.every(route => routes.checks?.some(check => check.id === route.id && check.traversed === true))) {
      throw fail('estate_routes_unconfirmed', '永久路线没有逐条真实走通');
    }
    save({ routeVerified: true, routeChecks: routes });
    const furniture = await deps.verifyFurniture(blueprint);
    active();
    const f = blueprint.furniture;
    if (furniture?.craftingTable?.confirmed !== true || furniture?.enchantingTable?.confirmed !== true || furniture?.bookshelves?.confirmed !== true ||
      furniture.bookshelves.effectiveCount < 15 || furniture.chests?.length !== (f.chests || [f.chest]).length || furniture.furnaces?.length !== (f.furnaces || [f.furnace]).length ||
      furniture.beds?.length !== (f.beds || [f.bed]).length || ![...(furniture.chests || []), ...(furniture.furnaces || []), ...(furniture.beds || [])].every(check => check.confirmed === true)) {
      throw fail('estate_furniture_unconfirmed', '全部原生家具窗口、床和有效书架没有确认');
    }
    if (!verifyFarmState() || state.farmChecks?.farmVerified !== true) throw fail('estate_farms_unconfirmed', '两块农田的真实水源、湿度、耕地和作物没有确认');
    summary = { ...structureSummary(), routeVerified: true, furnitureVerified: true, farmVerified: true, routeChecks: routes, furnitureChecks: furniture, farmChecks: state.farmChecks };
    requireStructure(summary);
    save({ verificationSummary: summary, verified: true, routeVerified: true, farmVerified: true, phase: 'complete', component: null });
    deps.report('庄园结构、永久路线、原生家具和两块灌溉农田已全部确认');
    return summary;
  }

  async function run(args = {}) {
    active();
    for (const method of ['getBot', 'assertActive', 'getCheckpoint', 'setCheckpoint', 'report', 'getItemCount',
      'selectSite', 'prepareMaterials', 'placeBlock', 'breakBlock', 'moveTo', 'verifyRoutes', 'verifyFurniture', 'buildFarm']) {
      if (typeof deps[method] !== 'function') throw fail('estate_invalid_runtime', `庄园缺少真实运行接口：${method}`);
    }
    if (args.schema != null && args.schema !== 1) throw fail('estate_invalid_args', '庄园任务 schema 必须为 1');
    const old = deps.getCheckpoint?.() || {};
    const profile = args.profile || old.sourceProfile || 'medieval_castle';
    if (!ESTATE_PROFILES.includes(profile)) throw fail('estate_invalid_profile', '未知庄园款式');
    const sameProfile = old.schema === 1 && old.sourceProfile === profile;
    let anchor = args.anchor || (sameProfile ? old.anchor : null);
    if ((old.ownedBlockIds?.length || old.ownedScaffold?.length) && (!sameProfile || args.anchor && key(args.anchor) !== key(old.anchor))) {
      throw fail('estate_checkpoint_mismatch', '恢复必须保持原款式和锚点，已有归属方块不能迁移到另一建筑');
    }
    if (!anchor) anchor = await deps.selectSite(profile);
    active();
    blueprint = createEstateBlueprint(anchor, { profile });
    state = sameProfile && old.anchor && key(old.anchor) === key(anchor) ? old : {};
    save({ verified: false, routeVerified: false, farmVerified: false, verificationSummary: null, phase: 'inspect_site' });
    validateCheckpoint();
    const removals = inspectSite();
    save({ siteInspected: true });
    await clearVegetation(removals);
    for (const component of blueprint.components) {
      active();
      report(`正在施工：${component.label}`, { component: component.id, phase: 'prepare_component' });
      for (const dependency of component.dependencies) {
        const required = blueprint.components.find(entry => entry.id === dependency);
        if (!required || !componentComplete(required)) throw fail('estate_dependency_incomplete', `前置组件尚未实际完成：${dependency}`);
      }
      for (const phase of ESTATE_PHASES) {
        if (phase === 'frame') await buildScaffold(component, 'frame');
        if (phase === 'roof') await buildScaffold(component, 'roof');
        await buildSpecs(blueprint.blocks.filter(spec => spec.component === component.id && spec.phase === phase && !spec.derived), component, phase);
      }
      if (!componentComplete(component)) throw fail('estate_component_unconfirmed', `组件未通过实际方块确认：${component.id}`);
      if (!component.cleanupAfterComponent) await cleanup(component);
      save({ completedComponents: [...new Set([...(state.completedComponents || []), component.id])] });
    }
    report('正在建设两块真实灌溉农田', { component: 'farms', phase: 'farm', farmStarted: true, farmVerified: false });
    const farmChecks = await deps.buildFarm({ schema: 1, id: `${profile}:${key(anchor)}:farms`, plots: blueprint.farms });
    active();
    if (farmChecks?.farmVerified !== true || !verifyFarmState()) throw fail('estate_farms_unconfirmed', '原生农田施工没有确认完整灌溉和播种');
    save({ farmChecks, farmVerified: true });
    return verify();
  }

  return { run };
}

module.exports = { createEstateBuilder, matchesEstateBlock, getEstateDerivedBlocks, getEstateScaffoldCleanupOrder };
