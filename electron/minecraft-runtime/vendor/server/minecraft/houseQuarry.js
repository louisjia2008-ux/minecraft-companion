/* global require, module */
'use strict';

const { Vec3 } = require('vec3');
const {hasGroundedBodySupport}=require('./houseSurfaceGraph');
const {createFishbone,nextFishboneAction,confirmFishboneAdvance,confirmFishboneReturn}=require('./houseFishbone');
const { createMiningNavigator, CARDINALS, classifyMiningBlock, inspectMiningStep } = require('./miningNavigation');
const RESOURCES = Object.freeze({
  cobblestone: { blocks: ['stone', 'cobblestone'], items: ['cobblestone'], level: null },
  raw_iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], items: ['raw_iron', 'iron_ore'], level: 16 },
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], items: ['coal'], level: 48 },
  lapis_lazuli: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], items: ['lapis_lazuli'], level: 0 },
});
const INCIDENTAL_ORES = Object.freeze({
  coal: ['coal_ore', 'deepslate_coal_ore'], raw_iron: ['iron_ore', 'deepslate_iron_ore'],
  raw_copper: ['copper_ore', 'deepslate_copper_ore'], raw_gold: ['gold_ore', 'deepslate_gold_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'], lapis_lazuli: ['lapis_ore', 'deepslate_lapis_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'], emerald: ['emerald_ore', 'deepslate_emerald_ore'],
});
const clone = value => JSON.parse(JSON.stringify(value));
const key = p => `${p.x},${p.y},${p.z}`;
const vec = p => new Vec3(p.x, p.y, p.z);
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const integerPosition = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]));
const same = (a, b) => a && b && ['x', 'y', 'z'].every(axis => a[axis] === b[axis]);
const inBounds = (p, b) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ;
const ROUTE_REJECTIONS = new Set(['MINING_FLUID', 'MINING_GRAVITY', 'MINING_NO_SUPPORT', 'MINING_OBSTRUCTED',
  'MINING_UNLOADED', 'MINING_OUT_OF_REACH', 'MINING_TOOL_REQUIRED', 'HOUSE_QUARRY_PROTECTED', 'HOUSE_QUARRY_VISITED', 'house_resource_protected']);

function canSpendQuarryPickaxe(bot,block,item,minDurability=8){
  if(!block||!item?.name?.endsWith('_pickaxe')||!(item.count>0))return false;
  const maximum=bot.registry.items[item.type]?.maxDurability,remaining=Number.isFinite(maximum)?maximum-Number(item.durabilityUsed||0):Infinity;
  if(remaining<minDurability||typeof block.canHarvest==='function'&&!block.canHarvest(item.type))return false;
  const stone=bot.registry.itemsByName.stone_pickaxe?.id;
  return !(/^(iron|diamond|netherite)_pickaxe$/.test(item.name)&&remaining<=64&&stone!=null&&block.canHarvest?.(stone)===true);
}
function createHouseQuarry(deps) {
  for (const name of ['getBot', 'assertActive', 'getCP', 'saveCP', 'ensurePickaxe', 'ensureFood', 'digBlock']) {
    if (typeof deps[name] !== 'function') throw fail('house_quarry_dependency_missing', `自然采石缺少原生依赖：${name}`);
  }
  if (deps.navigationOptions?.moveTo) throw fail('house_quarry_invalid_navigation', '自然采石必须使用原装pathfinder物理，不能注入坐标移动');
  const maximum = (value, fallback, ceiling) => {
    const n = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) throw fail('house_quarry_invalid_limit', '采石上限必须是有限正整数');
    return n;
  };
  const limits = { branchSteps: maximum(deps.limits?.branchSteps, 192, 192),
    descentSteps: maximum(deps.limits?.descentSteps, 192, 384),
    supplyTrips: maximum(deps.limits?.supplyTrips, 8, 16),
    timeoutMs: maximum(deps.limits?.timeoutMs, 900000, 7200000) };
  let state = null;
  const active = () => deps.assertActive();
  const bot = () => { active(); return deps.getBot(); };
  const count = name => {
    const value = bot().inventory.items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0);
    if (!Number.isSafeInteger(value) || value < 0) throw fail('house_quarry_inventory_invalid', '采石实际库存读取无效');
    return value;
  };
  // Tool/food preparation can run another resource quarry using the same
  // persisted checkpoint. Keep this invocation's route, but never replace or
  // overlook the other quarry's newly confirmed return floors.
  function syncOtherRoutes() {
    active();
    const latest = deps.getCP();
    if (!state || !latest?.schema) return;
    if (latest.schema !== 1 || !same(latest.anchor, state.anchor)) {
      throw fail('house_quarry_checkpoint_mismatch', '嵌套采石补给不能更换固定营地或checkpoint版本');
    }
    for (const [name, route] of Object.entries(latest.routes || {})) {
      if (name !== state.activeResource) state.routes[name] = clone(route);
    }
    state.excludeBounds = [...new Map([...(state.excludeBounds || []), ...(latest.excludeBounds || [])]
      .map(b => [JSON.stringify(b), clone(b)])).values()];
  }
  const save = () => { active(); syncOtherRoutes(); deps.saveCP(clone(state)); };
  const report = (message, extra = {}) => { active(); deps.report?.(message, { resource: state.activeResource, ...extra }); };
  const at = p => bot().blockAt(vec(p));
  function campConfirmed(anchor) {
    const e = bot().entity;
    const origin = plain(e.position);
    if (!same(origin, anchor) || Math.abs(e.position.y - anchor.y) > 0.075 || e.onGround === false
      || !classifyMiningBlock(at({ ...anchor, y: anchor.y - 1 })).support
      || !classifyMiningBlock(at(anchor)).passable || !classifyMiningBlock(at({ ...anchor, y: anchor.y + 1 })).passable) {
      throw fail('house_quarry_not_at_camp', '原生采石必须实际落稳回到固定营地矿道起点');
    }
  }
  async function gather(name, additional, { anchor, excludeBounds = [] } = {}) {
    active();
    const resource = RESOURCES[name];
    if (!resource || !Number.isSafeInteger(additional) || additional < 1 || additional > 64 || !integerPosition(anchor)) {
      throw fail('house_quarry_invalid_request', '采石需要已支持资源、1至64新增量和整数营地锚点');
    }
    if (!Array.isArray(excludeBounds) || excludeBounds.some(b => !b || !['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every(axis => Number.isSafeInteger(b[axis]))
      || b.minX > b.maxX || b.minY > b.maxY || b.minZ > b.maxZ)) throw fail('house_quarry_invalid_request', '受保护区域必须是有限整数包围盒');
    const previous = deps.getCP() || {};
    if (previous.schema != null && previous.schema !== 1 || previous.anchor && !same(previous.anchor, anchor)) throw fail('house_quarry_checkpoint_mismatch', '采石恢复不得更换营地或checkpoint版本');
    state = previous.schema === 1 ? clone(previous) : { schema: 1, anchor: { ...anchor }, routes: {} };
    state.routes ||= {};
    state.excludeBounds = [...new Map([...(state.excludeBounds || []), ...excludeBounds].map(b => [JSON.stringify(b), clone(b)])).values()];
    const activeBot = bot();
    const initial = count(name); const target = initial + additional;
    const bootstrap = name === 'cobblestone' && additional <= 20 && deps.hasFurnace?.() !== true;
    const foodThreshold = 8;
    const deadline = Date.now() + limits.timeoutMs;
    let supplyTrips = 0; let navigator; let route;
    const minY = Number.isFinite(activeBot.game?.minY) ? activeBot.game.minY : -64;
    const height = Number.isFinite(activeBot.game?.height) ? activeBot.game.height : 384;
    let targetY = Math.max(minY + 2, Math.min(anchor.y - 1, resource.level == null ? anchor.y - 5 : resource.level));
    const protectedDig = point => {
      syncOtherRoutes();
      if (typeof deps.isProtectedDig === 'function' && deps.isProtectedDig(point) !== false) {
        throw fail('HOUSE_QUARRY_PROTECTED', '不能挖断宿主已确认的地表运输、营地或建筑支撑', { position: point });
      }
      if (state.excludeBounds.some(b => inBounds(point, b))) throw fail('HOUSE_QUARRY_PROTECTED', `不能采集建筑或营地受保护位置：${key(point)}`, { position: point });
      for (const [other, value] of Object.entries(state.routes)) {
        if ([...(value.navigation?.breadcrumbs || []), ...(value.finishedFishboneBranches || []).flatMap(branch => branch.points)].some(p => p.x === point.x && p.z === point.z && p.y - 1 === point.y)) {
          throw fail('HOUSE_QUARRY_PROTECTED', '不能挖掉已记录矿道的回程地板', { position: point, resource: other });
        }
      }
    };
    const checkDeadline = () => {
      active();
      if (Date.now() >= deadline) throw fail('house_quarry_search_timeout', '本轮自然采石达到有限时限，保留实际矿道与材料');
    };
    const itemDurability = item => {
      const max = activeBot.registry.items[item.type]?.maxDurability;
      return Number.isFinite(max) ? max - Number(item.durabilityUsed || 0) : Infinity;
    };
    const compareTools = (a, b) => {
      const rank = item => ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(item.name.split('_')[0]);
      return rank(b) - rank(a) || itemDurability(b) - itemDurability(a);
    };
    let survivalRecoveries = 0, survivalRecoveryProgress = null, totalSurvivalRecoveries = 0;
    async function resumeSurvival(error) {
      if (error.code !== 'movement_preempted' || typeof deps.resumeAfterSurvival !== 'function') return false;
      const nav=navigator.getState();
      // The four-retry guard limits repeated interruptions without quarry
      // progress, not unrelated successful battles over this whole gather.
      // Only actual navigation/dig counters or observed resource inventory can
      // replenish it. Combat, elapsed time and a retreat alone cannot do so.
      // This is a passive progress snapshot while the exact survival owner
      // may still hold movement. count() asserts the suspended work lease and
      // would abort before resumeAfterSurvival can validate/drain that owner.
      const observedCount=activeBot.inventory.items().filter(i=>i.name===name).reduce((sum,i)=>sum+i.count,0);
      if(!Number.isSafeInteger(observedCount)||observedCount<0)throw fail('house_quarry_inventory_invalid','采石实际库存读取无效');
      const progress=JSON.stringify([nav.moves,nav.dug,observedCount]);
      if(progress!==survivalRecoveryProgress){survivalRecoveries=0;survivalRecoveryProgress=progress;}
      if(survivalRecoveries>=4||totalSurvivalRecoveries>=64)return false;
      if (await deps.resumeAfterSurvival(error, { deadline, bot: activeBot }) !== true) return false;
      survivalRecoveries += 1; totalSurvivalRecoveries += 1; active(); checkDeadline();
      if(error.observedMiningRetreat===true){
        const confirmed=navigator.confirmObservedRetreat();
        route.abandonedNavigations=[...(route.abandonedNavigations||[]).slice(-7),{
          at:Date.now(),reason:'actual_confirmed_ranged_retreat',navigation:confirmed.previous,actual:confirmed.actual}];
        if(route.fishbone)route.previousFishbones=[...(route.previousFishbones||[]).slice(-31),{
          ...clone(route.fishbone),retiredReason:'actual_confirmed_ranged_retreat',branchCompleted:false}];
        route.fishbone=null;
        const threat=error.survivalInterrupt?.miningRetreatThreat?.position;
        if(threat)route.heading=CARDINALS.map((direction,index)=>({index,distance:
          Math.hypot(confirmed.actual.x+direction.x-threat.x,confirmed.actual.z+direction.z-threat.z)}))
          .sort((a,b)=>b.distance-a.distance)[0].index;
        save();report('实际退回原矿道遮挡，保留旧支线记录并从当前站位规划安全分支',{
          actual:confirmed.actual,previousIndex:confirmed.previous.routeIndex,currentIndex:confirmed.state.routeIndex,
          newMoveCredit:false,newDigCredit:false,originalDeadline:deadline});
      }
      return true;
    }
    async function atCamp(action, returnToFrontier = true) {
      checkDeadline();
      if (++supplyTrips > limits.supplyTrips) throw fail('house_quarry_supply_limit', '本轮采石补给往返达到上限');
      const frontierIndex = navigator.getState().routeIndex;
      await navigator.retreat({ preserveRoute: true }); active(); campConfirmed(anchor);
      for (;;) {
        try { await action(); active(); break; }
        catch (error) {
          if (!await resumeSurvival(error)) throw error;
          // A completed defense may leave us at the workshop, not the quarry
          // entry. Rejoin that real entry before retrying goal-based supply;
          // keep frontierIndex and the original gather deadline intact.
          if(typeof deps.returnEntryAfterSurvival!=='function')throw error;
          await deps.returnEntryAfterSurvival();checkDeadline();campConfirmed(anchor);
        }
      }
      active(); syncOtherRoutes(); campConfirmed(anchor);
      if (returnToFrontier) {
        await navigator.returnToFrontier(); active();
        const restored = navigator.getState().routeIndex;
        if (restored < frontierIndex) throw fail('house_quarry_extraction_route_changed', '补给后丢失原探矿位置');
        if (restored > frontierIndex) await navigator.retreat({ steps: restored - frontierIndex, preserveRoute: true });
        active();
      }
    }
    async function equipForBlock(block) {
      protectedDig(block.position); active();
      let tool = activeBot.inventory.items().filter(i => canSpendQuarryPickaxe(activeBot,block,i)).sort(compareTools)[0];
      if (!tool && typeof block.canHarvest === 'function' && block.canHarvest(null)) return;
      if (!tool) {
        await atCamp(async () => { await deps.ensurePickaxe(block, { resource: name, minDurability: 16, anchor: { ...anchor }, preparationOnly: false,preserveIronReserve:true }); });
        tool = activeBot.inventory.items().filter(i => canSpendQuarryPickaxe(activeBot,block,i)).sort(compareTools)[0];
      }
      if (!tool) throw fail('house_quarry_tool_required', `没有确认可采出 ${block.name} 的真实镐子`);
      if (deps.equipItem) await deps.equipItem(tool);
      active(); protectedDig(block.position);
      if (typeof block.canHarvest === 'function' && !block.canHarvest(activeBot.heldItem?.type ?? null)) throw fail('house_quarry_tool_required', '装备后没有确认正确采集工具');
    }
    // Optional ores must leave the original finite gather budget for its
    // requested material. A rich copper vein is not a new task objective.
    const incidentalLimit = 8;
    let incidentalBlocks = 0, incidentalBusy = false;
    async function collectOreOpportunities(nav, ownRoute, replay = false) {
      if (bootstrap || incidentalBusy || incidentalBlocks >= incidentalLimit) return;
      checkDeadline();
      if (activeBot.health < 10 || activeBot.food < 12 || typeof activeBot.inventory.emptySlotCount !== 'function'
        || activeBot.inventory.emptySlotCount() <= 3) return;
      incidentalBusy = true;
      const originIndex = nav.getState().routeIndex, origin = plain(activeBot.entity.position);
      const ignored = new Set(ownRoute.ignoredOres || []);
      try {
        const itemByBlock = Object.fromEntries(Object.entries(INCIDENTAL_ORES)
          .filter(([item]) => replay || item !== name).flatMap(([item, blocks]) => blocks.map(block => [block, item])));
        const seen = nav.scanNearby(Object.keys(itemByBlock), 6).filter(candidate => candidate.visible);
        ownRoute.oreOpportunities = [...new Map([...(ownRoute.oreOpportunities || []), ...seen.map(candidate => ({
          position: candidate.position, block: candidate.name, resource: itemByBlock[candidate.name],
        }))].filter(candidate => at(candidate.position)?.name === candidate.block).map(candidate => [key(candidate.position), candidate])).values()].slice(-64);
        save();
        for (const candidate of seen.filter(value => value.reachable && !ignored.has(key(value.position))).slice(0, 2)) {
          checkDeadline();
          if (incidentalBlocks >= incidentalLimit || activeBot.health < 10 || activeBot.food < 12 || activeBot.inventory.emptySlotCount() <= 3) break;
          const item = itemByBlock[candidate.name];
          if (item === name && count(name) >= target) continue;
          const block = at(candidate.position);
          const tool = activeBot.inventory.items().filter(value => canSpendQuarryPickaxe(activeBot,block,value,10)).sort(compareTools)[0];
          if (!tool) continue;
          const before = count(item);
          try {
            protectedDig(candidate.position);
            const result = await nav.mineVein(candidate.position, {
              maxBlocks: Math.min(16, incidentalLimit - incidentalBlocks, Math.floor(itemDurability(tool) - 8)),
              getCollectedCount: () => count(item),
              // Advancing a vein-pickup branch would truncate the unwalked
              // recorded suffix. During replay stay on the original route;
              // ordinary subsequent movement can pick up adjacent drops.
              allowPickupMovement: !replay,
              goal: () => activeBot.health < 10 || activeBot.food < 12 || activeBot.inventory.emptySlotCount() <= 3
                || item === name && count(name) >= target,
            });
            active(); incidentalBlocks += result.mined;
            const receipt = { resource: item, before, after: count(item), mined: result.mined, position: candidate.position, replay };
            ownRoute.incidentalReceipts = [...(ownRoute.incidentalReceipts || []).slice(-31), receipt]; save();
            report('矿道顺手采集已检查的可见矿石', receipt);
          } catch (error) {
            active(); if (!ROUTE_REJECTIONS.has(error.code)) throw error;
            ignored.add(key(candidate.position)); ownRoute.ignoredOres = [...ignored].slice(-256); save();
          }
          const current = nav.getState();
          if (current.routeIndex < originIndex) throw fail('house_quarry_extraction_route_changed', '顺手采矿不能丢失原记录矿道');
          if (current.routeIndex > originIndex) await nav.retreat({ steps: current.routeIndex - originIndex, preserveRoute: false });
          active();
          if (!same(plain(activeBot.entity.position), origin) || activeBot.entity.onGround !== true)
            throw fail('house_quarry_extraction_return_unconfirmed', '顺手采矿后没有实际返回原矿道');
        }
      } finally { incidentalBusy = false; }
    }
    function createNavigator(resourceName) {
      const ownRoute = state.routes[resourceName];
      const nav = createMiningNavigator({ ...(deps.navigationOptions || {}),
        getBot: bot, assertActive: active, minY, height, restoredState: ownRoute?.navigation,
        maxActions: 4096, equipForBlock,
        digBlock: async block => { active(); protectedDig(block.position); await deps.digBlock(block); active(); },
        collectDrops: async options => { active(); await deps.collectDrops?.(options); active(); },
        checkpoint: navigation => {
          active(); state.routes[resourceName] ||= { visited: [], ignoredOres: [], heading: 0, searchSteps: 0 };
          state.routes[resourceName].navigation = clone(navigation); save();
        },
        heartbeat: evidence => { active(); report('自然矿道已确认真实挖掘或移动', evidence); },
        afterRecordedMove: async (navigation, movement = {}) => {
          // Backfill the old dark route during actual replay/retreat. Never
          // block an emergency retreat just to obtain more lighting supplies.
          if (!bootstrap && deps.lightRoute && count('torch') > 0) {
            ownRoute.lighting = await deps.lightRoute(navigation,ownRoute.lighting||[]);active();save();
          }
          // Replaying a known outbound route must not walk past the gold a
          // previous stone-pick trip could not harvest. Emergency retreat never
          // starts optional work; nested pickup/return legs cannot recurse.
          if (movement.retreating === false && resourceName === name)
            await collectOreOpportunities(nav, ownRoute, true);
        },
      });
      return nav;
    }
    function reconcileActualEntry(resourceName){
      const saved=state.routes[resourceName],navigation=saved?.navigation;
      if(!navigation||!(navigation.routeIndex>0)||!same(plain(activeBot.entity.position),anchor))return;
      campConfirmed(anchor);
      if(!same(navigation.breadcrumbs?.[0],anchor))throw fail('house_quarry_checkpoint_mismatch','原矿道起点与实际固定入口不符');
      saved.entryReconciliations=[...(saved.entryReconciliations||[]).slice(-7),{at:Date.now(),previousRouteIndex:navigation.routeIndex,
        actualPosition:plain(activeBot.entity.position),newMoveOrDigCredit:false}];
      saved.navigation={...navigation,routeIndex:0};save();
    }
    try {
      // A paused resource can be underground when the next requested material
      // differs. Its own saved route must bring us home before switching.
      if (state.activeResource && state.activeResource !== name && state.routes[state.activeResource]?.navigation) {
        reconcileActualEntry(state.activeResource);
        navigator = createNavigator(state.activeResource);
        await navigator.retreat({ preserveRoute: true }); active(); campConfirmed(anchor);
      }
      state.activeResource = name;
      state.routes[name] ||= { visited: [], ignoredOres: [], heading: 0, searchSteps: 0 };
      route = state.routes[name];
      // Old checkpoints kept one visited set across retired excavations. That
      // made already walked, still safe entry cells permanently forbidden even
      // after their navigation was archived. Scope loop prevention to the live
      // excavation; retain the historical facts without granting new moves.
      if (route.visitedNavigationSchema !== 1) {
        const retired = new Set((route.abandonedNavigations || []).flatMap(entry =>
          (entry.navigation?.breadcrumbs || []).map(key)));
        const current = new Set((route.navigation?.breadcrumbs || []).map(key));
        route.previousVisited = [...(route.previousVisited || []).slice(-7),
          { at: Date.now(), reason: 'visited_scope_migration', visited: [...(route.visited || [])] }];
        route.visited = (route.visited || []).filter(id => !retired.has(id) || current.has(id));
        route.visitedNavigationSchema = 1;
        save();
      }
      reconcileActualEntry(name);
      navigator = createNavigator(name);
      if (route.navigation?.routeIndex > 0) { await navigator.retreat({ preserveRoute: true }); active(); }
      campConfirmed(anchor);
      await deps.prepareCapacity?.({ resource: name, additional, targetCount: target, preserve: { [name]: target }, anchor: { ...anchor } });
      active(); campConfirmed(anchor);
      await deps.ensureSticks?.(2); active(); campConfirmed(anchor);
      // The protected entry floor is an origin fact, never an extraction target.
      // Prepare this resource's minimum tool tier before reading actual dig faces.
      await deps.ensurePickaxe(at({ ...anchor, y: anchor.y - 1 }), { resource: name, minDurability: 16, anchor: { ...anchor }, preparationOnly: true });
      active(); campConfirmed(anchor);
      // The first short stone trip bootstraps the furnace needed for charcoal.
      // Every subsequent bulk/deep trip prepares real lighting before descent.
      if (!bootstrap) { await deps.ensureLighting?.(); active(); campConfirmed(anchor); }
      if (!bootstrap || Number.isFinite(activeBot.food) && activeBot.food < foodThreshold) {
        await deps.ensureFood({ anchor: { ...anchor }, minFood: 20, minFoodPoints: 24, bootstrap }); active(); campConfirmed(anchor);
        if (Number.isFinite(activeBot.food) && activeBot.food < foodThreshold) throw fail('house_quarry_food_required', '实际采石口粮不足，不能递归启动无炉烹饪');
      }
      save();
      if (route.navigation?.breadcrumbs?.length > 1) {
        try{await navigator.returnToFrontier();active();}
        catch(error){
          active();
          if(!['MINING_ROUTE_CHANGED','MINING_FLUID','MINING_GRAVITY','MINING_NO_SUPPORT'].includes(error.code))throw error;
          // A known flooded/blocked old branch may have a dry valid prefix.
          // Physically retrace that prefix before retiring this route; never
          // restart a branch from a predicted camp or an unknown wet position.
          if(!same(plain(activeBot.entity.position),anchor)){await navigator.retreat({preserveRoute:true});active();}
          campConfirmed(anchor);
          // The actor really remained at its fixed entry. A changed old branch
          // grants no route credit; archive it and start one fresh guarded
          // excavation from this real origin, preserving inventory and facts.
          route.abandonedNavigations=[...(route.abandonedNavigations||[]).slice(-7),{at:Date.now(),reason:error.code,position:error.position||null,navigation:clone(route.navigation),visited:clone(route.visited||[])}];
          if(route.fishbone){route.previousFishbones=[...(route.previousFishbones||[]).slice(-31),{...clone(route.fishbone),retiredReason:'actual_entry_navigation_abandoned',branchCompleted:false}];route.fishbone=null;}
          route.navigation=null;route.visited=[];route.heading=(route.heading+1)%4;
          navigator=createNavigator(name);save();
          report('旧采石分支地形已改变，从实际入口重新规划，不重复旧落脚点');
        }
      }
      const visited = new Set(route.visited || []);
      visited.add(key(plain(activeBot.entity.position)));
      let descended = 0; let branches = 0;
      const survival = async () => {
        checkDeadline();
        if (!bootstrap && deps.lightRoute) {
          if (count('torch') < 1) await atCamp(async()=>{await deps.ensureLighting();active();});
          route.lighting = await deps.lightRoute(navigator.getState(),route.lighting||[]);active();save();
        }
        if (Number.isFinite(activeBot.health) && activeBot.health < 6) throw fail('house_quarry_low_health', '低血停止采石并沿已知矿道返回营地');
        if (bootstrap && Number.isFinite(activeBot.food) && activeBot.food < foodThreshold) throw fail('house_quarry_food_required', '短程无炉采石饥饿值不足，停止递归补给并返营');
        if (Number.isFinite(activeBot.food) && (activeBot.food < foodThreshold || !bootstrap&&activeBot.health<10&&activeBot.food<18)) await atCamp(async () => {
          await deps.ensureFood({ anchor: { ...anchor }, minFood: 20, minFoodPoints: 24, bootstrap });
          if (Number.isFinite(activeBot.food) && activeBot.food < foodThreshold) throw fail('house_quarry_food_required', '实际补给后饥饿值仍不足');
        });
        if (typeof activeBot.inventory.emptySlotCount === 'function' && activeBot.inventory.emptySlotCount() <= 2) {
          if (typeof deps.prepareCapacity !== 'function') throw fail('house_quarry_inventory_full', '采石需要真实空格，不能丢弃或伪造库存');
          await atCamp(() => deps.prepareCapacity({ resource: name, additional, targetCount: target, preserve: { [name]: target }, anchor: { ...anchor } }));
          if (activeBot.inventory.emptySlotCount() <= 2) throw fail('house_quarry_inventory_full', '自有营地存取后仍没有足够实际背包空间');
        }
      };
      const advance = async (descend, forcedHeading = null) => {
        const rejections = [];
        const perform = async (direction, step, heading) => {
          const from = plain(activeBot.entity.position);
          const inspection = inspectMiningStep({ blockAt: activeBot.blockAt.bind(activeBot), from, direction,
            ...step, minY, maxY: minY + height - 1 });
          if (!inspection.ok) throw fail(inspection.code, inspection.reason, { position: inspection.position });
          if (visited.has(key(inspection.target))) throw fail('HOUSE_QUARRY_VISITED', '这格已在本矿道访问，寻找新方向');
          for (const point of inspection.clearance) if (!classifyMiningBlock(at(point)).passable) protectedDig(point);
          if (inspection.needsSupport) throw fail('MINING_NO_SUPPORT', '自然采石不自动铺桥，保留空洞并寻找其它方向');
          await navigator.advance(direction, step); active();
          route.heading = heading; visited.add(key(plain(activeBot.entity.position)));
          route.visited = [...visited].slice(-2048); route.searchSteps = (route.searchSteps || 0) + 1;
          route.lastRejections = clone(rejections); save();
        };
        for (let offset = 0; offset < (forcedHeading == null ? CARDINALS.length : 1); offset += 1) {
          const heading = forcedHeading ?? (route.heading + offset) % CARDINALS.length; const direction = CARDINALS[heading];
          try {
            await perform(direction, { descend }, heading);
            return;
          } catch (error) {
            if (!ROUTE_REJECTIONS.has(error.code)) throw error;
            active();
            rejections.push({ code: error.code, reason: error.message, position: error.position || null });
          }
        }
        if (descend) {
          const directions = CARDINALS.map((_value, i) => CARDINALS[(route.heading + i) % CARDINALS.length]);
          const detour = navigator.planDescentDetour(directions, 8,step=>{
            active();if(visited.has(key(step.target))||step.needsSupport)return false;
            try{for(const point of step.clearance)if(!classifyMiningBlock(at(point)).passable)protectedDig(point);return true;}
            catch(error){if(ROUTE_REJECTIONS.has(error.code))return false;throw error;}
          });
          if (detour?.length > 1) {
            try {
              report(`当前下降面被真实障碍阻挡，沿已检查同层矿道绕行：${[...new Set(rejections.map(e => e.reason))].join('；')}`);
              for (const step of detour) {
                await survival();
                if (!step.descend && ++branches > limits.branchSteps) throw fail('house_quarry_search_limit', '有限同层绕行达到探矿上限');
                const heading = CARDINALS.findIndex(d => d.x === step.direction.x && d.z === step.direction.z);
                await perform(step.direction, { descend: step.descend }, heading);
              }
              return;
            } catch (error) {
              if (!ROUTE_REJECTIONS.has(error.code)) throw error; active();
              rejections.push({ code: error.code, reason: error.message, position: error.position || null });
            }
          }
        }
        route.lastRejections = rejections; save();
        throw fail('house_quarry_no_safe_route', '四个自然矿道方向均不可安全通行', { rejections });
      };
      const harvest = async () => {
        const originIndex = navigator.getState().routeIndex;
        const origin = plain(activeBot.entity.position);
        const returnFromExtraction = async () => {
          checkDeadline();
          const current = navigator.getState();
          if (current.routeIndex < originIndex) throw fail('house_quarry_extraction_route_changed', '采集支线不能丢失原探矿位置');
          if (current.routeIndex > originIndex) {
            // Vein pickup may walk along several checked cells, including back
            // towards camp. Resume exploration at the captured scan origin;
            // never mistake the end of that pickup excursion for the frontier.
            await navigator.retreat({ steps: current.routeIndex - originIndex, preserveRoute: false });
          }
          active();
          if (!same(plain(activeBot.entity.position), origin) || activeBot.entity.onGround !== true) {
            throw fail('house_quarry_extraction_return_unconfirmed', '矿脉拾取后未沿原记录路线真实回到探矿位置');
          }
        };
        const ignored = new Set(route.ignoredOres || []);
        const candidates = navigator.scanNearby(resource.blocks, 12).filter(c => c.reachable && !ignored.has(key(c.position)));
        for (const candidate of candidates.slice(0, 8)) {
          await survival(); if (count(name) >= target) break;
          try {
            protectedDig(candidate.position);
            await navigator.mineVein(candidate.position, { goal: () => count(name) >= target,
              // Stone has many exposed alternatives, including small furnace
              // batches. Actual inventory gain avoids redundant pickup walks.
              // Sparse ore veins
              // still enter their checked pickup branch to expose the next
              // ore face, even when the first drop was already collected.
              getCollectedCount: name === 'cobblestone' ? () => count(name) : undefined,
              maxBlocks: Math.min(32, target - count(name)) });
            active();
          } catch (error) {
            if (await resumeSurvival(error)) return 'resumed';
            active(); if (!ROUTE_REJECTIONS.has(error.code)) throw error;
            ignored.add(key(candidate.position)); route.ignoredOres = [...ignored].slice(-256); save();
          }
          await returnFromExtraction();
        }
        try { await collectOreOpportunities(navigator, route); }
        catch (error) { if (await resumeSurvival(error)) return 'resumed'; throw error; }
      };
      let fishboneBends = 0;
      const fishboneStep = async () => {
        let plan = route.fishbone;
        const actual = plain(activeBot.entity.position), navigation = navigator.getState();
        if(require('./houseFishbone').belongsToAbandonedNavigation(plan,navigation,route.abandonedNavigations)){
          route.previousFishbones=[...(route.previousFishbones||[]).slice(-31),{...clone(plan),retiredReason:'confirmed_abandoned_navigation_lineage',branchCompleted:false}];
          route.fishbone=null;plan=null;save();report('旧鱼骨支巷属于已退役矿道，从当前实际探矿点开始新主巷');
        }
        if (!plan || plan.schema !== 1 || plan.cursor.y !== actual.y) {
          if (plan) route.previousFishbones = [...(route.previousFishbones || []).slice(-3), plan];
          plan = route.fishbone = createFishbone(actual, CARDINALS[route.heading]); save();
        }
        if (plan.pending) {
          const p = plan.pending;
          if (same(actual, p.target) && navigation.routeIndex === p.fromIndex + 1) {
            confirmFishboneAdvance(plan, p.from, actual, p.fromIndex, navigation.routeIndex); save();
          } else if (same(actual, p.from) && navigation.routeIndex === p.fromIndex) { plan.pending = null; save(); }
          else throw fail('house_quarry_fishbone_unconfirmed', '中断的鱼骨分支需要实际接回原探矿位置');
        }
        const action = nextFishboneAction(plan);
        if (action.kind === 'return') {
          if (navigation.routeIndex < action.index) throw fail('house_quarry_fishbone_unconfirmed', '鱼骨支巷丢失真实主巷连接');
          const points = navigation.breadcrumbs.slice(action.index, navigation.routeIndex + 1);
          await navigator.retreat({ steps: navigation.routeIndex - action.index, preserveRoute: true }); active();
          confirmFishboneReturn(plan, plain(activeBot.entity.position), navigator.getState().routeIndex);
          route.finishedFishboneBranches = [...(route.finishedFishboneBranches || []).slice(-31), { points, returned: true }]; save();
          // Retire this completed branch's future suffix only after real
          // return and archive; resume must reach the main junction, not walk
          // back to the old branch tip before starting the opposite branch.
          await navigator.retreat({ steps: 0, preserveRoute: false }); active();
          report('鱼骨支巷已沿原记录退回主巷，继续对侧或下一组'); return;
        }
        const heading = CARDINALS.findIndex(d => d.x === action.direction.x && d.z === action.direction.z);
        plan.pending = { ...action, fromIndex: navigation.routeIndex }; save();
        try { await advance(false, heading); }
        catch (error) {
          if (error.code !== 'house_quarry_no_safe_route' || error.rejections?.some(r => r.code === 'MINING_UNLOADED')) throw error;
          plan.pending = null;
          if (plan.stage !== 'main') {
            plan.blocked = { position: actual, rejections: clone(error.rejections || []) };
            plan.stage = `return_${plan.stage}`; save();
            report('鱼骨支巷遇到真实障碍，保留该支路并退回主巷'); return;
          }
          const turn = [{ x: plan.direction.z, z: -plan.direction.x }, { x: -plan.direction.z, z: plan.direction.x }].find(direction => {
            const step = inspectMiningStep({ blockAt: activeBot.blockAt.bind(activeBot), from: actual, direction, minY, maxY: minY + height - 1 });
            return step.ok && !step.needsSupport && !visited.has(key(step.target))
              && step.clearance.every(p => { try { if (!classifyMiningBlock(at(p)).passable) protectedDig(p); return true; } catch { return false; } });
          });
          if (!turn || ++fishboneBends > 4) { error.fishboneExhausted = true; save(); throw error; }
          route.previousFishbones = [...(route.previousFishbones || []).slice(-3), clone(plan)];
          route.fishbone = createFishbone(actual, turn); save(); report('主巷受阻，记录障碍后沿已检查的垂直方向开新主巷'); return;
        }
        active(); confirmFishboneAdvance(plan, action.from, plain(activeBot.entity.position), navigation.routeIndex, navigator.getState().routeIndex); save();
      };
      let lastYield = count(name), barrenLevelSteps = 0;
      while (count(name) < target) {
        await survival(); if (await harvest() === 'resumed') continue;
        if (count(name) >= target) break;
        const actualYield = count(name);
        if (actualYield > lastYield) barrenLevelSteps = 0;
        lastYield = actualYield;
        // A fixed offset below camp can still be an entire hillside of dirt.
        // Only actual failed-yield level advances justify a deeper search;
        // the original descent, branch, time and excavation budgets still apply.
        if (name === 'cobblestone' && barrenLevelSteps >= 4 && targetY > minY + 2) {
          targetY = Math.max(minY + 2, targetY - 4);
          barrenLevelSteps = 0;
          route.stoneSearch = { targetY, reason: 'four_level_steps_without_inventory_gain' };
          save();
        }
        const descend = Math.floor(activeBot.entity.position.y) > targetY;
        if (descend) {
          if (++descended > limits.descentSteps) throw fail('house_quarry_search_limit', '自然下降达到本轮有限步数');
        } else if (++branches > limits.branchSteps) throw fail('house_quarry_search_limit', '探矿分支达到192步以内的本轮上限');
        try { if (!descend && name !== 'cobblestone') await fishboneStep(); else await advance(descend); }
        catch (error) {
          if (await resumeSurvival(error)) continue;
          if (error.code !== 'house_quarry_no_safe_route' || error.rejections?.some(r => r.code === 'MINING_UNLOADED')
            || navigator.getState().routeIndex < 1) throw error;
          // A safe dead end is not permission to dig through water, gravity
          // blocks or return floors. Revisit one actual recorded stair instead,
          // keeping visited targets excluded and charging the original budget.
          if (++branches > limits.branchSteps) throw fail('house_quarry_search_limit', '原记录矿道回退达到本轮有限探矿步数');
          const blockedPosition = plain(activeBot.entity.position);
          await navigator.retreat({ steps: 1, preserveRoute: !error.fishboneExhausted }); active(); checkDeadline();
          if(error.fishboneExhausted){
            // Retire the dead main only after physically backing out. Keeping
            // its future navigation suffix replays the same dead tip on resume.
            route.previousFishbones=[...(route.previousFishbones||[]).slice(-31),{
              ...clone(route.fishbone),retiredReason:'actual_dead_end_backtrack',blockedPosition}];
            route.fishbone=null;fishboneBends=0;
          }
          route.searchBacktracks = (route.searchBacktracks || 0) + 1;
          route.lastDeadEnd = { position: blockedPosition, rejections: clone(error.rejections || []),
            actualReturn: plain(activeBot.entity.position), reason: 'actual_recorded_stair_then_unvisited_branch' };
          save(); report('矿道尽头受阻，沿实际记录退一格后寻找未访问方向');
          continue;
        }
        if (!descend && count(name) === lastYield) barrenLevelSteps += 1;
        report(`正在自然采集 ${name} ${count(name) - initial}/${additional}，Y=${Math.floor(activeBot.entity.position.y)}`);
      }
      await navigator.retreat({ preserveRoute: true }); active(); campConfirmed(anchor);
      const after = count(name);
      if (after < target) throw fail('house_quarry_inventory_unconfirmed', '回营后没有确认本批实际新增矿料');
      state.lastGather = { resource: name, before: initial, after, actualAdditional: after - initial, returnedToCamp: true };
      save();
      return { confirmed: true, resource: name, before: initial, after, additional: after - initial,
        anchor: { ...anchor }, navigation: navigator.getState() };
    } catch (error) {
      // Pause/cancel/new owner must stop; ordinary low health/search errors can
      // still use the same guarded route to leave the quarry safely.
      let mayRetreat = deps.getBot() === activeBot;
      try { active(); } catch { mayRetreat = false; }
      if (mayRetreat && navigator) {
        try { await navigator.retreat({ preserveRoute: true }); campConfirmed(anchor); }
        catch (retreatError) { error.retreatError = { code: retreatError.code, message: retreatError.message }; }
      }
      throw error;
    }
  }
  return { gather, getState: () => state ? clone(state) : null };
}

module.exports = { createHouseQuarry, RESOURCES, canSpendQuarryPickaxe };
