/* global require, module, setTimeout */
'use strict';
const { canRetryResource, rememberResourceFailure, forgetResourceFailuresNear } = require('./houseResourceFailures');
const { observeHouseTree } = require('./houseTreeHarvest');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const key = p => `${p.x},${p.y},${p.z}`;
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const FRONTIER_SPACING = 32;
const FRONTIER_OFFSET_RADIUS = 12;
const copyDiagnostics = value => { try { const text = JSON.stringify(value); return text && text.length <= 8192 ? JSON.parse(text) : null; } catch (_) { return null; } };
const OVERWORLD_LOGS = Object.freeze(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'].map(wood => `${wood}_log`));
const NATURAL_BLOCKS = Object.freeze({
  ...Object.fromEntries(OVERWORLD_LOGS.map(name => [name, [name]])), any_log: OVERWORLD_LOGS, cobblestone: ['stone', 'cobblestone'],
  sand: ['sand'], dirt: ['dirt', 'grass_block'],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  sugar_cane: ['sugar_cane'], wheat_seeds: ['short_grass', 'tall_grass'],
});

function houseResourceFrontier(anchor, radius = 384, spacing = 64) {
  if (!['x', 'y', 'z'].every(axis => Number.isInteger(anchor?.[axis]))) throw fail('house_resource_invalid_anchor', '资源营地坐标无效');
  if (!Number.isSafeInteger(radius) || radius < 1 || radius > 768 || !Number.isSafeInteger(spacing) || spacing < 1 || spacing > 64) {
    throw fail('house_resource_invalid_frontier', '资源射线需要1到768格半径和最多64格的小步');
  }
  const points = [];
  const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let ray = 0; ray < directions.length; ray += 1) {
    const [dx, dz] = directions[ray]; const diagonal = dx !== 0 && dz !== 0; const outbound = [];
    const limit = diagonal ? Math.floor(radius / Math.SQRT2) : radius;
    const hop = diagonal ? Math.max(1, Math.floor(spacing / Math.SQRT2)) : spacing;
    for (let offset = Math.min(hop, limit); limit > 0; offset = Math.min(limit, offset + hop)) {
      outbound.push({ x: anchor.x + dx * offset, y: anchor.y,
        z: anchor.z + dz * offset, ray, returning: false });
      if (offset === limit) break;
    }
    points.push(...outbound, ...outbound.slice(0, -1).reverse().map(point => ({ ...point, returning: true })),
      { ...anchor, ray, returning: true });
  }
  return points;
}

function houseMaterialAnimalAllowed(bot, entity, material, safeFoot) {
  if (!entity?.position || entity.isValid === false || entity.username || entity.type === 'player' || !safeFoot(entity.position)) return false;
  if (entity.name !== (material === 'leather' ? 'cow' : 'sheep')) return false;
  const keys = bot.registry.entitiesByName?.[entity.name]?.metadataKeys || [];
  const metadata = name => entity.metadata?.[keys.indexOf(name)];
  const nativeDefaults = bot.version === '1.21.8' && Array.isArray(entity.metadata)
    && entity.entityType === bot.registry.entitiesByName[entity.name]?.id
    && keys.indexOf('baby') === 16 && keys.indexOf('health') === 9 && keys.indexOf('custom_name') === 2;
  // This pinned vanilla snapshot omits unchanged adult/white defaults. Keep
  // positive observed health mandatory; unknown layouts/versions cannot infer
  // age or wool, and explicit baby/color/sheared/name values still refuse.
  const baby = metadata('baby') === undefined && nativeDefaults ? false : metadata('baby');
  if (keys.indexOf('baby') < 0 || baby !== false || !(Number(metadata('health')) > 0)
    || keys.indexOf('custom_name') < 0 || metadata('custom_name')) return false;
  if (material === 'white_wool') {
    const wool = metadata('wool') === undefined && nativeDefaults && keys.indexOf('wool') === 17 ? 0 : metadata('wool');
    if (!Number.isInteger(wool) || (wool & 15) !== 0 || (wool & 16) !== 0) return false;
  }
  return true;
}

function createHouseResourceGatherer(deps) {
  const active = () => deps.assertActive();
  const acceptedItems = name => name === 'any_log' ? OVERWORLD_LOGS : [name];
  const count = name => deps.getBot().inventory.items().reduce((sum, item) => sum + (acceptedItems(name).includes(item.name) ? item.count : 0), 0);
  const excluded = (p, bounds) => bounds.some(b => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);

  async function gatherResource(name, additionalCount, options) {
    active();
    if (!NATURAL_BLOCKS[name] && !['leather', 'white_wool'].includes(name)) throw fail('house_resource_unsupported', `没有注册自然采集脚本：${name}`);
    if (!Number.isInteger(additionalCount) || additionalCount < 1 || additionalCount > 64) throw fail('house_resource_invalid_batch', '自然采集每批必须为1到64件');
    const bot = deps.getBot();
    const rescueOrigin=bot.entity.position.clone();
    let animalObservationRecorded = false;
    const anchor = plain(options.anchor);
    const bounds = options.exclusionBounds || [];
    const target = count(name) + additionalCount;
    const frontier = houseResourceFrontier(anchor, options.searchRadius ?? 384, FRONTIER_SPACING);
    const old = deps.getCheckpoint?.() || {};
    if (old.schema && (old.schema !== 1 || key(old.anchor) !== key(anchor))) throw fail('house_resource_checkpoint_changed', '资源采集营地与原任务不符');
    let state = { ...old, schema: 1, frontierVersion: 2, frontierSpacing: FRONTIER_SPACING, anchor, searches: { ...(old.searches || {}) } };
    const prior = state.searches[name] || {};
    const search = prior.frontierVersion === 2 && prior.frontierSpacing === FRONTIER_SPACING
      ? { ...prior, observedPath: [...(prior.observedPath || [])] }
      : { cursor: 0, attempts: Number(prior.attempts) || 0, observedPath: [] };
    search.frontierVersion = 2;
    search.frontierSpacing = FRONTIER_SPACING;
    search.rayFailures = { ...(prior.rayFailures || {}) };
    if (!Number.isSafeInteger(search.cursor) || search.cursor < 0 || search.cursor > frontier.length ||
        !search.observedPath.every(p => ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p?.[axis])))) {
      throw fail('house_resource_checkpoint_changed', '资源射线检查点无效');
    }
    search.failedTargets = Array.isArray(prior.failedTargets) ? prior.failedTargets : [];
    const wood = name === 'any_log' || OVERWORLD_LOGS.includes(name);
    // Persist the remaining observed crown across ordinary task interruption.
    // A checkpoint grants ordering only; fresh blocks and safety are mandatory.
    search.tree = wood && NATURAL_BLOCKS[name].includes(prior.tree?.name)
      && Array.isArray(prior.tree?.pending) && prior.tree.pending.length <= 64
      && prior.tree.pending.every(p=>['x','y','z'].every(axis=>Number.isSafeInteger(p?.[axis])))
      ? {...prior.tree,pending:prior.tree.pending.map(p=>({...p}))} : null;
    const rejected = new Set();
    const animalAttempts = new Map();
    const deadline = Math.min(Date.now() + (deps.maxLegMs ?? 1200000),Number.isFinite(options.deadline)?options.deadline:Infinity);
    let lastReason = '尚未找到安全、可触达的天然资源';
    let rejectionDiagnostics = 0;
    const save = () => {
      active();
      const latest = deps.getCheckpoint?.() || {};
      if (latest.schema && (latest.schema !== 1 || key(latest.anchor) !== key(anchor))) {
        throw fail('house_resource_checkpoint_changed', '嵌套资源采集改变了原营地合同');
      }
      state = { ...state, ...latest, schema: 1, frontierVersion: 2, frontierSpacing: FRONTIER_SPACING, anchor,
        searches: { ...state.searches, ...latest.searches, [name]: { ...search, lastReason } } };
      deps.setCheckpoint?.(state);
    };
    const observe = () => {
      active();
      const position = bot.entity?.position;
      if (!position || !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis])) || bot.entity.onGround === false || deps.safeFoot(position) !== true) return;
      const actual = plain(position);
      if (key(actual) === key(anchor)) search.observedPath = [actual];
      else if (key(search.observedPath.at(-1) || {}) !== key(actual)) search.observedPath.push(actual);
    };
    const returnKnown = async () => {
      active(); observe(); save();
      await deps.returnCamp(anchor, { resource: name, via: search.observedPath.map(p => ({ ...p })) });
      active(); observe();
    };
    const recordExplorationFailure = (destination, reason, diagnostics = null) => {
      active();
      lastReason = `射线 ${destination.ray + 1}：${String(reason || 'native_exploration_failed')}`;
      search.rayFailures[destination.ray] = { reason: String(reason || 'native_exploration_failed'),
        diagnostics: copyDiagnostics(diagnostics), requested: { x: destination.x, y: destination.y, z: destination.z },
        actualPosition: plain(bot.entity.position), cursor: search.cursor, at: Date.now() };
    };
    const skipRay = ray => {
      while (search.cursor < frontier.length && frontier[search.cursor].ray === ray) search.cursor += 1;
    };
    observe();
    const recheck = () => {
      active();
      if (deps.getBot() !== bot) throw fail('house_resource_connection_changed', '采集期间机器人连接已改变');
      const localRescueWood = wood && options.survivalBootstrap === true && options.localOnly === true
        && additionalCount <= 3 && deps.allowSurvivalBootstrap?.() === true;
      if (Number.isFinite(bot.health) && bot.health < 6 && !localRescueWood) throw fail('house_resource_low_health', '采集时生命过低，停止外出并保存任务');
      if (Date.now() >= deadline) throw fail('house_resource_leg_limit', `本轮 ${name} 采集达到时间上限，保存探索前沿后继续`, { available: count(name), target, lastReason });
    };
    let survivalRecoveries = 0;
    const recheckAfterFailure = async error => {
      // Programming defects are not evidence that a different natural tree
      // is unreachable. Preserve the first stack instead of wandering through
      // more candidates while silently hiding the broken production callback.
      if(['ReferenceError','TypeError','SyntaxError'].includes(error?.name))throw error;
      if (error.code === 'movement_preempted') {
        // Extra handoffs require an actual inventory increase in this batch.
        // Keep the original deadline and a finite cap even while progressing.
        const recoveryLimit = count(name) > target - additionalCount ? 8 : 4;
        if (survivalRecoveries >= recoveryLimit || typeof deps.resumeAfterSurvival !== 'function'
            || await deps.resumeAfterSurvival(error, { deadline, bot }) !== true) throw error;
        survivalRecoveries += 1;
        recheck(); observe(); save();
        return true;
      }
      // A movement guardian's observed failure is the reason this action
      // stopped. Preserve it even if its cleanup has already revoked the
      // ordinary work lease, and never continue with another resource target.
      if (/^(?:house_surface_|dry_graph_|mining_low_health$)/.test(String(error.code || ''))) {
        try { recheck(); } catch (ownerError) {
          error.cleanupOwnerFailure = { code: ownerError.code, message: ownerError.message };
        }
        throw error;
      }
      recheck();
    };
    try {
      return await deps.withSurface(async () => {
        while (count(name) < target || options.finishTree!==false&&search.tree?.pending.length) {
          recheck();
          // Synchronous native scans plus already-resolved async callbacks can
          // otherwise keep this loop entirely in the microtask queue, starving
          // socket keepalives, physics and cancellation timers.
          await new Promise(resolve=>setTimeout(resolve,0));
          recheck();
          try { await deps.ensureFood?.({ resource: name, anchor, via: search.observedPath.map(p => ({ ...p })) }); }
          catch (error) { if (await recheckAfterFailure(error)) continue; throw error; }
          recheck(); observe();
          if(typeof deps.opportunistic==='function'){
            await deps.opportunistic({resource:name});recheck();observe();
          }
          if (count(name) >= target && deps.capacityFor(name) < 1) { search.tree = null; save(); break; }
          if (deps.capacityFor(name) < target - count(name)) throw fail('house_resource_inventory_full', `采集 ${name} 前需要存放多余物资`, { item: name, missing: target - count(name) });
          deps.report?.(`自动采集 ${name}：${count(name)}/${target}`);
          let acted = false;
          if (['leather', 'white_wool'].includes(name)) {
            try { await deps.ensureWeapon({ resource: name, anchor, via: search.observedPath.map(p => ({ ...p })) }); }
            catch (error) { if (await recheckAfterFailure(error)) continue; throw error; }
            recheck(); observe();
            if (!animalObservationRecorded && typeof deps.observeAnimals === 'function') {
              const animals=Object.values(bot.entities||{}).filter(e=>e.name===(name==='leather'?'cow':'sheep')&&e.position?.distanceTo(bot.entity.position)<=64).slice(0,8);
              if(animals.length){
                animalObservationRecorded=true;
                deps.observeAnimals({material:name,version:bot.version,animals:animals.map(e=>{
                  const keys=bot.registry.entitiesByName[e.name]?.metadataKeys||[],value=k=>e.metadata?.[keys.indexOf(k)];
                  return {id:e.id,entityType:e.entityType,position:plain(e.position),health:value('health')??null,baby:value('baby')??null,wool:value('wool')??null,
                    metadataKeys:Object.keys(e.metadata||{}),named:Boolean(value('custom_name')),safeFoot:deps.safeFoot(e.position),accepted:houseMaterialAnimalAllowed(bot,e,name,deps.safeFoot)};
                })});
              }
            }
            const candidates = Object.values(bot.entities || {}).filter(entity =>
              houseMaterialAnimalAllowed(bot, entity, name, deps.safeFoot) && !excluded(entity.position, bounds)
              && (animalAttempts.get(entity.id) || 0) < 3 && entity.position.distanceTo(bot.entity.position) <= 64)
              .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
            for (const entity of candidates) {
              recheck(); animalAttempts.set(entity.id, (animalAttempts.get(entity.id) || 0) + 1);
              const before = count(name);
              try {
                // The native hunter validates every follow, attack, death and
                // actual pickup; disappearance alone never grants a resource.
                await deps.hunt(entity, bot.entity.position.clone(), 96, { material: name });
                recheck(); observe();
                acted = count(name) > before;
                if (acted) break;
                lastReason = `狩猎后未拾取 ${name}`;
              } catch (error) { const resumed = await recheckAfterFailure(error); observe(); lastReason = error.message;
                if (resumed) { acted = true; break; } }
            }
          } else {
            const continuingTree = Boolean(search.tree?.pending.length);
            const base = bot.entity.position.floored();
            const treeCandidates = continuingTree ? search.tree.pending.map(p=>bot.blockAt(base.offset(
              p.x-base.x,p.y-base.y,p.z-base.z)))
              .filter(b=>b?.name===search.tree.name) : null;
            const candidates = (treeCandidates || deps.findBlocks(NATURAL_BLOCKS[name], 96, 24))
              .filter(block => (!options.survivalBootstrap || block.position.distanceTo(rescueOrigin)<=6)
                && !excluded(block.position, bounds) && !rejected.has(key(block.position))
                && canRetryResource(search.failedTargets,block,bot.entity.position,{approachRevision:deps.approachRevision})
                // Loaded distant blocks guide the observed graph. They are not
                // permission for repeated long direct goals across unknown water.
                && (typeof deps.nextExploration!=='function'||block.position.distanceTo(bot.entity.position)<=24));
            while(candidates.length) {
              recheck();
              const readySoil=name==='dirt'&&typeof deps.isCurrentDigTargetReady==='function'
                ?new Set(candidates.filter(b=>deps.isCurrentDigTargetReady(b)===true)):null;
              candidates.sort((a,b)=>(readySoil?Number(readySoil.has(b))-Number(readySoil.has(a)):0)
                ||a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position));
              const candidate=candidates.shift();
              const block = bot.blockAt(candidate.position);
              if (!block || !NATURAL_BLOCKS[name].includes(block.name) || excluded(block.position, bounds)) continue;
              if (wood && !continuingTree) search.tree = observeHouseTree(bot, block, p=>excluded(p,bounds));
              if (search.tree) {
                search.tree.pending = search.tree.pending.filter(p=>key(p)!==key(block.position));
              }
              // Keep every natural cane's bottom segment alive. Only upper
              // segments provide harvest stock for books or future planting.
              if (name === 'sugar_cane' && bot.blockAt(block.position.offset(0, -1, 0))?.name !== 'sugar_cane') continue;
              const attemptOrigin = bot.entity.position.clone();
              try {
                await deps.ensureTool(name, block); recheck(); observe();
                await deps.reachDig(block); recheck();
                await deps.waitGround(); recheck(); observe();
                const fresh = bot.blockAt(block.position);
                if (fresh?.name !== block.name || excluded(block.position, bounds) || !bot.canDigBlock(fresh)
                  || deps.canDigSafely(fresh) !== true) throw fail('house_resource_unsafe_target', '天然采集目标或支撑已改变');
                const before = count(name);
                await deps.dig(fresh); recheck();
                if (bot.blockAt(fresh.position)?.stateId !== fresh.stateId)
                  search.failedTargets = forgetResourceFailuresNear(search.failedTargets,fresh.position);
                await deps.collectDrops({ position: fresh.position, radius: 6, timeoutMs: 4500 }); recheck(); observe();
                if (count(name) > before) { acted = true; rejected.clear(); break; }
                // Grass legitimately drops no seeds. Bound the number of
                // such digs instead of treating each as acquired inventory.
                if (name === 'wheat_seeds') { acted = true; search.attempts += 1; break; }
                lastReason = `开采后没有确认拾取 ${name}`;
              } catch (error) { const resumed = await recheckAfterFailure(error); observe(); lastReason = error.message;
                if (resumed) { acted = true; rejected.clear(); break; }
                if (rejectionDiagnostics < 32) {
                  rejectionDiagnostics++;
                  try { deps.onCandidateFailure?.({ resource: name, target: plain(block.position), code: error.code || null,
                    reason: error.message, facts: error.resourceTargetFacts || null }); } catch { /* Diagnostics grant no action authority. */ }
                }
              }
              search.failedTargets = rememberResourceFailure(search.failedTargets,block,attemptOrigin,{approachRevision:deps.approachRevision});
              rejected.add(key(block.position)); save();
            }
            if (!acted && continuingTree) { search.tree = null; save(); }
          }
          if (acted) {
            save();
            if (name === 'wheat_seeds' && search.attempts > 4096) throw fail('house_resource_seed_limit', '采草后仍未取得足够种子，保留实际库存和任务');
            continue;
          }
          if (count(name) >= target) break;
          if (wood && options.localOnly === true) throw fail('house_resource_local_wood_unavailable','当前附近天然木材不可达，保留现场并更换恢复策略');
          if (typeof deps.nextExploration === 'function') {
            // The graph owns its confirmed parent route. A resource approach
            // can leave that route, so return along actual observations before
            // resuming it; never treat a saved node as the current position.
            if (deps.isExplorationPosition?.(name, plain(bot.entity.position), anchor) !== true) {
              if(typeof deps.returnExploration==='function'){
                observe();save();
                await deps.returnExploration(anchor,{resource:name,via:search.observedPath.map(p=>({...p}))});
                recheck();observe();
              }else await returnKnown();
              recheck();
            }
            const beforeMove = bot.entity.position.clone();
            const outcome = await deps.nextExploration({ anchor, excludeBounds: bounds, resource: name }); recheck();
            const via = outcome?.via;
            if (via) {
              if (!Array.isArray(via) || !via.length || !via.every(p => ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p?.[axis])))
                || key(via[0]) !== key(anchor) || key(via.at(-1)) !== key(plain(bot.entity.position))) {
                throw fail('house_resource_graph_route_unconfirmed', '地表图返回的路线与本次实际站位不符');
              }
              search.observedPath = via.map(p => ({ ...p }));
            }
            observe();
            search.explorationKind = 'loaded_dry_waypoint_graph';
            const moved = outcome?.moved === true && bot.entity.position.distanceTo(beforeMove) >= 0.1
              && bot.entity.onGround !== false && deps.safeFoot(bot.entity.position) === true;
            if (moved) { rejected.clear(); save(); continue; }
            lastReason = String(outcome?.reason || '地表图没有确认实际移动');
            search.graphFailure = { reason: lastReason, diagnostics: outcome?.diagnostics || null,
              actualPosition: plain(bot.entity.position), at: Date.now() };
            save();
            if (lastReason === 'finite_attempt_batch_failed') continue;
            throw fail('house_resource_search_exhausted', `本轮已加载可达地表搜索暂未采齐 ${name}`,
              { available: count(name), target, lastReason, diagnostics: outcome?.diagnostics });
          }
          let moved = false;
          while (search.cursor < frontier.length) {
            recheck();
            const destination = frontier[search.cursor];
            if (destination.returning || excluded(destination, bounds)) {
              if (!destination.returning) recordExplorationFailure(destination, 'protected_frontier');
              await returnKnown(); recheck();
              skipRay(destination.ray); save();
              moved = true; break;
            }
            const actual = bot.entity.position;
            if (Math.hypot(actual.x - destination.x, actual.z - destination.z) > FRONTIER_SPACING + Math.SQRT2 * FRONTIER_OFFSET_RADIUS + 2) {
              // A preceding material batch or resource approach may have ended
              // back at camp. Replay this ray's small legs instead of using its
              // saved cursor as permission for a distant unloaded jump.
              await returnKnown(); recheck();
              search.furthestCursor = Math.max(Number(search.furthestCursor) || 0, search.cursor);
              search.cursor = frontier.findIndex(point => point.ray === destination.ray && !point.returning);
              save(); continue;
            }
            deps.report?.(`搜索天然 ${name}：射线 ${destination.ray + 1}/8，距营地 ${Math.round(Math.hypot(destination.x - anchor.x, destination.z - anchor.z))} 格`);
            const before = { x: actual.x, y: actual.y, z: actual.z };
            let outcome;
            try { outcome = await deps.explore(destination); recheck(); }
            catch (error) { await recheckAfterFailure(error); outcome = { moved: false, reason: error.code || error.message, diagnostics: error.diagnostics }; }
            const declaredMove = outcome === true || outcome?.moved === true;
            const after = bot.entity.position;
            const actualMove = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) >= 0.1;
            const safelyGrounded = bot.entity.onGround !== false && deps.safeFoot(after) === true;
            moved = declaredMove && actualMove && safelyGrounded;
            observe();
            if (!moved) recordExplorationFailure(destination,
              declaredMove ? (actualMove ? 'native_not_safely_grounded' : 'no_actual_movement') : outcome?.reason || 'native_exploration_failed', outcome?.diagnostics);
            if (moved) { rejected.clear(); search.cursor += 1; save(); break; }
            // A failed native path can still have moved partway. Record actual
            // dry positions and retrace them before any other heading is tried.
            await returnKnown(); recheck();
            skipRay(destination.ray); save();
          }
          if (!moved) throw fail('house_resource_search_exhausted', `已完成本轮安全搜索，${name} 尚未采齐`, { available: count(name), target, lastReason, rayFailures: copyDiagnostics(search.rayFailures) });
        }
        recheck();
        for (;options.deferCampReturn!==true;) {
          try { await returnKnown(); break; }
          catch (error) { if (!await recheckAfterFailure(error)) throw error; }
        }
        recheck();
        if (count(name) < target) throw fail('house_resource_return_deficit', `返回营地后 ${name} 少于本批目标`);
        save();
        return { confirmed: true, ...(options.deferCampReturn===true?{returnedCamp:false}:{}),item: name, acquired: count(name) - (target - additionalCount), available: count(name),
          ...(name === 'any_log' ? { actualItems: Object.fromEntries(OVERWORLD_LOGS.map(item => [item,
            bot.inventory.items().filter(value => value.name === item).reduce((sum, value) => sum + value.count, 0)]).filter(([, amount]) => amount)) } : {}) };
      }, { deadline, resource: name });
    } catch (error) {
      // Return on resource exhaustion only while still owned and active.
      // A paused/superseded actor must never issue a late pathfinder action.
      const assertCleanupOwner = () => {
        try { active(); } catch (ownerError) {
          if (/^(?:house_surface_|dry_graph_|mining_low_health$)/.test(String(error.code || ''))) {
            error.cleanupOwnerFailure = { code: ownerError.code, message: ownerError.message }; throw error;
          }
          throw ownerError;
        }
      };
      assertCleanupOwner();
      if(options.deferCampReturn!==true)try { await returnKnown(); } catch (returnError) { assertCleanupOwner(); error.returnReason = returnError.message; }
      throw error;
    }
  }
  const gather = (name, amount, options) => typeof deps.withResource === 'function'
    ? deps.withResource({ resource: name, anchor: options?.anchor }, () => gatherResource(name, amount, options))
    : gatherResource(name, amount, options);
  return { gather };
}

module.exports = { createHouseResourceGatherer, houseResourceFrontier, houseMaterialAnimalAllowed, OVERWORLD_LOGS };
