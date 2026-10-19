/* global require, module */
'use strict';
const { createHouseMaterialRecipes, DEFAULT_RAW } = require('./houseMaterialRecipes');
const { createHouseOwnedStorage, selectOwnedStorageSites } = require('./houseOwnedStorage');
const { classifyMiningBlock } = require('./miningNavigation');
const {goals}=require('mineflayer-pathfinder');
const {Vec3}=require('vec3');
const fail = (code, message) => Object.assign(new Error(message), { code });
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => a && b && ['x', 'y', 'z'].every(axis => a[axis] === b[axis]);
const pointBounds = p => ({ minX: p.x, maxX: p.x, minY: p.y - 1, maxY: p.y + 2, minZ: p.z, maxZ: p.z });
const isCampReplaceablePlant=b=>Boolean(b&&b.boundingBox==='empty'&&b.shapes?.length===0&&b.getProperties?.().waterlogged!==true
  &&(b.name==='snow'&&Number(b.getProperties?.().layers)===1||['short_grass','tall_grass','fern','large_fern','dead_bush','dandelion','poppy','blue_orchid','allium',
    'azure_bluet','red_tulip','orange_tulip','white_tulip','pink_tulip','oxeye_daisy','cornflower','lily_of_the_valley','pink_petals','wildflowers','leaf_litter',
    'bush','firefly_bush','short_dry_grass','tall_dry_grass'].includes(b.name)));
const campReplaceable=b=>Boolean(b&&(['air','cave_air','void_air'].includes(b.name)||isCampReplaceablePlant(b)));

function createHouseSelfSupplyRuntime(deps, blueprint, constructionBounds) {
  const bot = deps.getBot();
  const active = () => deps.assertActive();
  const count = name => bot.inventory.items().reduce((n, item) => n + (item.name === name ? item.count : 0), 0);
  const state = () => deps.getCheckpoint();
  let source;
  const save = (patch, options) => {
    if (!options?.confirmedFact) active();
    const current = state();
    if (current?.schema !== 1 || current.profile !== blueprint.profile || !same(current.houseAnchor, blueprint.anchor)) throw fail('house_self_supply_owner_changed', '自给材料记录与原房屋任务不符');
    deps.setCheckpoint({ ...current, ...copy(patch) }, options);
  };
  const storageBounds = () => [...constructionBounds, pointBounds(state().camp.anchor), ...Object.values(state().camp.stations).map(pointBounds),
    ...(state().retiredCamps||[]).filter(entry=>!same(entry.camp?.anchor,state().camp.anchor))
      .flatMap(entry=>[...Object.values(entry.ownedStations||{}),...(entry.storage?.chests||[])].filter(p=>p.position).map(p=>pointBounds(p.position)))];
  const resourceBounds = () => [...storageBounds(), ...state().camp.storageSites.map(pointBounds),
    ...(state().respawnCamp?.placed===true?[state().respawnCamp.foot,state().respawnCamp.head,state().respawnCamp.access].filter(Boolean).map(pointBounds):[])];
  const campWork = action => typeof deps.withCampWork === 'function' ? deps.withCampWork(action) : action();
  const ownedPlacement = async (spec, callback) => campWork(() => deps.placeNative(spec, callback));
  const nativeStorage = createHouseOwnedStorage({
    getBot: () => deps.getBot(), assertActive: active,
    getCheckpoint: () => state()?.storage,
    setCheckpoint: (value, options) => save({ storage: value }, options),
    report: deps.report,
    archivedStock: (entry,storageId) => (state()?.retiredCamps||[])
      .filter(r=>same(r.camp?.anchor,state().camp.anchor)&&r.storage?.storageId===storageId)
      .flatMap(r=>r.storage.chests||[]).filter(c=>same(c.position,entry.position)&&c.emptyAuthorized===true&&!c.pendingTransfer&&!c.pendingClosedInventory)
      .map(c=>c.stock||{}),
    isOwnerContext: () => deps.isSourceContext(source),
    chooseSites: async exclusions => selectOwnedStorageSites(state().camp.storageSites,exclusions),
    acquireChestItem: () => recipes.ensure({ chest: 1 }),
    placeNative: ownedPlacement, reach: deps.reach, openContainer: deps.openContainer,
    restoreOwnedSupport:position=>repairOwnedSupport(position),
  });
  const storage = { ...nativeStorage,
    ensure: options => {deps.onPreparationStage?.('storage_ensure',{caller:Error().stack});return campWork(() => nativeStorage.ensure(options));},
    stash: options => campWork(async()=>{await nativeStorage.stashUnusableEquipment();active();return nativeStorage.stash(options);}),
    withdraw: options => campWork(() => nativeStorage.withdraw(options)),
  };
  async function takeOwnedStock(requirements) {
    if(state()?.storage?.chests?.length){
      const stock=storage.getStock();
      const targets=Object.fromEntries(Object.entries(requirements).map(([name,target])=>[name,
        Math.min(target,count(name)+(stock[name]||0))]).filter(([name,target])=>target>count(name)));
      if(Object.keys(targets).length)await storage.withdraw(targets);
    }
    // A moved camp still owns earlier verified chests. Reuse at most two
    // nearby, actually loaded, natively reachable receipts before mining again.
    if(bot.game?.dimension!=='overworld'||bot.pathfinder?.movements?.canDig!==false)return;
    const seen=new Set([state().storage?.storageId]),retired=state().retiredCamps||[];let opened=0;
    for(const old of retired.slice(-32).reverse()){
      active();const id=old.storage?.storageId;if(!id||seen.has(id))continue;seen.add(id);
      for(const entry of old.storage.chests||[]){
        active();if(opened>=2)return;
        const targets=Object.fromEntries(Object.entries(requirements).map(([name,target])=>[name,
          Math.min(target,count(name)+((entry.usableStock||entry.stock)?.[name]||0))]).filter(([name,target])=>target>count(name)));
        if(!Object.keys(targets).length||entry.emptyAuthorized!==true||entry.pendingTransfer||entry.pendingClosedInventory)continue;
        const position=new Vec3(entry.position.x,entry.position.y,entry.position.z);
        if(bot.entity.position.distanceTo(position)>32||deps.blockAt(entry.position)?.name!=='chest')continue;
        const plan=bot.pathfinder.getPathTo(bot.pathfinder.movements,new goals.GoalNear(position.x,position.y,position.z,2),100);
        active();if(plan?.status!=='success'||!Array.isArray(plan.path)||plan.path.length>64||plan.path.some(p=>p.toBreak?.length||p.toPlace?.length))continue;
        const latest=()=>{const list=state().retiredCamps||[],index=list.findLastIndex(r=>r.storage?.storageId===id);
          if(index<0)throw fail('house_storage_owner_changed','旧自有仓库归属已改变');return {list,index,entry:list[index]};};
        const archived=createHouseOwnedStorage({getBot:deps.getBot,assertActive:active,isOwnerContext:()=>deps.isSourceContext(source),
          getCheckpoint:()=>{const cp=latest().entry.storage;return {...cp,chests:cp.chests.filter(c=>same(c.position,entry.position))};},
          setCheckpoint:(value,meta)=>{const current=latest(),cp=current.entry.storage;
            const next={...cp,...value,plannedSites:cp.plannedSites,chests:cp.chests.map(c=>same(c.position,entry.position)?value.chests.find(v=>same(v.position,c.position))||c:c)};
            save({retiredCamps:current.list.map((r,i)=>i===current.index?{...r,storage:next}:r)},meta);},
          report:deps.report,reach:deps.reach,openContainer:deps.openContainer,
          chooseSites:async()=>{throw fail('house_storage_archive_read_only','旧仓库复用不能规划新箱子');},
          acquireChestItem:async()=>{throw fail('house_storage_archive_read_only','旧仓库复用不能制造新箱子');},
          placeNative:async()=>{throw fail('house_storage_archive_read_only','旧仓库复用不能放置新箱子');},
        });
        opened++;
        try{await campWork(()=>archived.withdraw(targets));active();}
        catch(error){
          active();const missing=Object.entries(targets).filter(([name,target])=>count(name)<target),usable=archived.getStock();
          if(error.code!=='house_storage_missing'||!missing.length||!missing.every(([name])=>Number.isFinite(bot.registry.itemsByName[name]?.maxDurability)&&!usable[name]))throw error;
          deps.onPreparationStage?.('nearby_owned_unusable_equipment_skipped',{position:entry.position,items:missing.map(([name])=>name),withdrawnAsUsable:false});
          continue;
        }
        deps.onPreparationStage?.('nearby_owned_stock_reused',{position:entry.position,targets,actualCounts:Object.fromEntries(Object.keys(targets).map(name=>[name,count(name)]))});
      }
    }
  }
  let restoreOwnedItemHook;
  const recipes = createHouseMaterialRecipes({
    registry: bot.registry, recipesAll: (...args) => bot.recipesAll(...args), getItemCount: count,
    rawItems: [...new Set([...DEFAULT_RAW, ...['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
      .map(name => `${name}_log`).filter(name => bot.registry.itemsByName[name])])],
    rawCost: name => name.endsWith('_log') ? count(name)>0||storage.getStock()[name]>0 ? .01 : name === state()?.camp?.logName ? 1 : 1.01 : undefined,
    assertActive: active, report: deps.report,
    limits: { operationTimeoutMs: 7200000 }, onOperationTimeout: deps.onOperationTimeout,
    restoreOwnedItem: restoreOwnedItemHook = async (name, target, context) => {
      context.assertActive(); await takeOwnedStock({ [name]: target }); context.assertActive();
      if(name==='white_wool'&&count(name)<target){
        const reuse=()=>require('./houseWoolReuse').reuseOwnedWool(target,{
          active:context.assertActive,count,stock:()=>storage.getStock(),
          coloredCount:()=>bot.inventory.items().reduce((n,i)=>n+(i.name.endsWith('_wool')&&i.name!=='white_wool'?i.count:0),0),
          withdraw:takeOwnedStock,
          recipe:item=>{const id=bot.registry.itemsByName[item].id;
            return bot.recipesFor(id,null,1,null)?.find(r=>!r.requiresTable&&r.delta?.some(i=>i.id===id&&i.count>0));},
          craft:(item,recipe)=>campWork(()=>deps.craftRecipe(recipe,1,{item,assertActive:context.assertActive})),
        });
        await reuse();context.assertActive();
        if(count(name)<target&&typeof deps.restorePriorCamp==='function'){
          const restored=await deps.restorePriorCamp(state(),{woolReuse:true,requirements:{white_wool:target}});context.assertActive();
          if(restored){
            const prior=state();
            save({camp:restored.camp,ownedStations:restored.ownedStations,storage:restored.storage,
              surfaceGraphs:restored.surfaceGraphs||{},surfaceResources:restored.surfaceResources||null,
              quarry:restored.quarry||null,quarryEntry:restored.quarryEntry||null,activeSurfaceGraph:null,localRouteRecovery:null,
              retiredCamps:[...(prior.retiredCamps||[]),{camp:prior.camp,ownedStations:prior.ownedStations,storage:prior.storage,
                surfaceGraphs:prior.surfaceGraphs,surfaceResources:prior.surfaceResources,quarry:prior.quarry,quarryEntry:prior.quarryEntry,
                reason:'actual_owned_wool_stock_camp_revisited'}]});
            deps.updateResourceBounds?.(resourceBounds());
            await ensureStorage();context.assertActive();
            await takeOwnedStock({white_wool:target});context.assertActive();
            await reuse();context.assertActive();
          }
        }
      }
      const input = { iron_ingot: 'raw_iron', glass: 'sand', charcoal: state()?.camp?.logName || 'oak_log' }[name];
      const owned = state()?.ownedStations?.furnace;
      if (input && count(name) < target && owned?.confirmedPlaced === true && typeof deps.recoverOwnedFurnace === 'function') {
        await campWork(() => deps.recoverOwnedFurnace({ position: owned.position, input, output: name }, context));
        context.assertActive();
      }
    },
    beforeRecipe: async (_recipe, context) => { context.assertActive(); if (context.requiresTable) await ensureStation('crafting_table'); context.assertActive(); },
    prepareCraftInputs: async (_recipe, context) => {
      context.assertActive();
      const goals = context.inputGoals;
      const ready = () => Object.entries(goals).every(([name, target]) => count(name) >= target);
      if (ready()) return;
      // Capacity work can store an earlier sibling ingredient. Recover only
      // this original recipe's targets before the coordinator snapshots inputs.
      await takeOwnedStock(goals); context.assertActive();
      if (!ready()) { await context.ensureInputs(); context.assertActive(); }
      await takeOwnedStock(goals); context.assertActive();
      if (!ready()) throw fail('house_materials_no_progress', '自建仓库重取后仍未确认本次原生合成输入共存');
    },
    craftRecipe: async (recipe, repetitions, context) => {
      context.assertActive();
      const table = context.requiresTable ? await ensureStation('crafting_table') : null;
      await campWork(() => deps.craftRecipe(recipe, repetitions, { ...context, table })); context.assertActive();
    },
    smeltBatch: async (batch, context) => {
      context.assertActive(); await ensureStation('furnace'); context.assertActive();
      // Wood is obtained by the same guarded raw-material chain. Existing
      // finished building planks can be consumed only if later reconciled.
      const coalCapacity=8*(count('coal')+count('charcoal'))+80*count('coal_block');
      const woodSmelts=Math.max(0,batch.count-coalCapacity);
      if(woodSmelts)await recipes.ensure({ [state().camp.plankName || 'oak_planks']: Math.ceil(woodSmelts / 1.5) + 2 }); context.assertActive();
      await campWork(() => deps.smeltBatch(batch, context)); context.assertActive();
    },
    acquireRaw: async (name, amount, context) => {
      context.assertActive();
      const target = context.targetCount;
      await takeOwnedStock({ [name]: target }); context.assertActive();
      if(name==='white_wool'&&count(name)<target){await restoreOwnedItemHook(name,target,context);context.assertActive();}
      if (count(name) >= target) return;
      await deps.acquireRaw(name, target - count(name), { ...context, anchor: state().camp.anchor,
        exclusionBounds: resourceBounds(), source }); context.assertActive();
    },
  });
  async function repairOwnedSupport(position) {
    active();const pending=[];let p={...position,y:position.y-1};
    for(let depth=0;depth<=3;depth++,p={...p,y:p.y-1}){
      const cell=classifyMiningBlock(deps.blockAt(p));
      if(cell.support)break;
      if(depth===3||!cell.loaded||!cell.passable||cell.hazard)throw fail('house_camp_repair_unsafe','自有设施地基缺少有限干燥支撑');
      pending.push({...p});
    }
    for(const p of pending.reverse()){
      active();const material=['dirt','cobblestone'].find(name=>count(name)>0)||'cobblestone';
      await recipes.ensure({[material]:1});active();let recorded=false;
      await ownedPlacement({id:`camp-repair:${p.x},${p.y},${p.z}`,item:material,position:p,properties:{}},()=>{
        if(recorded||deps.blockAt(p)?.name!==material)return;recorded=true;
        save({campRepairs:[...(state().campRepairs||[]).slice(-63),{position:p,item:material,confirmedPlaced:true}]},{confirmedFact:true});
      });active();if(!recorded)throw fail('house_camp_repair_unconfirmed','自有设施地基补建未实际确认');
    }
  }
  async function ensureStation(item) {
    active();
    if (!['crafting_table', 'furnace'].includes(item)) throw fail('house_self_supply_station_invalid', '没有注册这类自建施工设施');
    let position = state()?.camp?.stations?.[item];
    if (!position) throw fail('house_self_supply_camp_missing', '自给施工营地尚未选定');
    const owned = state().ownedStations?.[item];
    let actual = deps.blockAt(position);
    deps.onPreparationStage?.('station_site',{item,position,actual:actual?.name||null,owned:Boolean(owned)});
    if (owned) {
      if (!same(owned.position, position) || !actual || actual.name!==item&&!campReplaceable(actual)) throw fail('house_self_supply_station_changed', '自建施工设施已改变，保留现场并停止');
      if(actual.name===item)return actual;
      try{await repairOwnedSupport(position);active();}
      catch(error){
        active();if(error.code!=='house_camp_repair_unsafe')throw error;
        const current=state(),routeFeet=[...Object.values(current.surfaceGraphs||{}).flatMap(g=>Object.values(g.nodes||{}).map(n=>n.position)),
          ...Object.values(current.quarry?.routes||{}).flatMap(r=>r.navigation?.breadcrumbs||[])].filter(Boolean);
        const replacement=chooseLocalStationReplacement({camp:current.camp,item,position:bot.entity.position,
          blockAt:deps.blockAt,excluded:p=>constructionBounds.some(b=>p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ)
            ||current.storage?.chests?.some(c=>same(c.position,p))
            ||routeFeet.some(q=>p.x===q.x&&p.z===q.z&&(p.y===q.y||p.y===q.y+1))});
        if(!replacement)throw error;
        // Only a missing owned station may move; preserve the actual camp,
        // chest ownership and every mine/transport checkpoint.
        const latest=deps.blockAt(position);if(!latest||!campReplaceable(latest))throw error;
        const stations={...current.ownedStations};delete stations[item];
        save({camp:{...current.camp,stations:{...current.camp.stations,[item]:replacement}},ownedStations:stations,
          retiredStations:[...(current.retiredStations||[]).slice(-15),{...owned,reason:'missing_station_unsafe_foundation',actual:latest.name}]});
        deps.updateResourceBounds?.(resourceBounds());
        deps.onPreparationStage?.('station_relocated',{item,old:position,replacement,oldFoundationRepaired:false,transportReset:false});
        position=replacement;actual=deps.blockAt(position);
      }
    }
    if (!campReplaceable(actual)) throw fail('house_self_supply_foreign_station', '不能采用或覆盖未归属的施工设施');
    if(isCampReplaceablePlant(actual)){
      if(typeof deps.clearStationVegetation!=='function')throw fail('house_camp_vegetation_clear_missing','设施位置的自然植物需要原生清理能力');
      await campWork(()=>deps.clearStationVegetation(position));active();actual=deps.blockAt(position);
      if(!['air','cave_air','void_air'].includes(actual?.name))throw fail('house_camp_vegetation_not_cleared','设施位置的植物尚未实际清理');
    }
    await recipes.ensure({ [item]: 1 }); active();
    let recorded = false;
    const confirmed = () => {
      if (recorded || deps.blockAt(position)?.name !== item) return;
      recorded = true;
      save({ ownedStations: { ...state().ownedStations, [item]: { item, position: { ...position }, confirmedPlaced: true } } }, { confirmedFact: true });
    };
    await ownedPlacement({ id: `camp:${item}`, item, position, ...(item === 'furnace' ? { properties: { facing: 'north', lit: false } } : {}) }, confirmed);
    confirmed(); active();
    if (!recorded || deps.blockAt(position)?.name !== item) throw fail('house_self_supply_station_unconfirmed', '未确认自建施工设施的真实方块');
    return deps.blockAt(position);
  }
  async function ensureStorage() {
    // Older restores merged the active camp's archived chest point into the
    // persisted exclusion union. Remove only that exact generated point bound,
    // and only when today's construction/station protections do not retain it.
    const current=state(),storageState=current?.storage;
    if(storageState?.exclusionBounds){
      const now=new Set(storageBounds().map(b=>JSON.stringify(b)));
      const duplicate=new Set((current.retiredCamps||[]).filter(r=>same(r.camp?.anchor,current.camp.anchor))
        .flatMap(r=>(r.storage?.chests||[]).map(c=>JSON.stringify(pointBounds(c.position)))));
      const reconciled=storageState.exclusionBounds.filter(b=>now.has(JSON.stringify(b))||!duplicate.has(JSON.stringify(b)));
      if(reconciled.length!==storageState.exclusionBounds.length)save({storage:{...storageState,exclusionBounds:reconciled}});
    }
    active(); await storage.ensure({ exclusionBounds: storageBounds() }); active();
    return deps.blockAt(state().storage.chests[0].position);
  }
  const keepCounts = requirements => {
    const keep = { ...requirements };
    for (const item of bot.inventory.items()) {
      if (/_(?:pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/.test(item.name)
        || ['shield', 'shears', 'bucket', 'water_bucket', 'flint_and_steel'].includes(item.name)
        || bot.registry.foodsByName?.[item.name]) keep[item.name] = Infinity;
    }
    keep.stick = Math.max(keep.stick || 0, 16);
    keep.torch = Math.max(keep.torch || 0, 16);
    // Mining byproducts are a real combat resource. Do not stash every block
    // and leave a worker unable to build its registered defensive screen.
    keep.cobblestone = Math.max(keep.cobblestone || 0, 32);
    keep.dirt = Math.max(keep.dirt || 0, 16);
    return keep;
  };
  async function initialize() {
    active();
    const current = state();
    if (current) {
      if (current.schema !== 1 || current.profile !== blueprint.profile || !same(current.houseAnchor, blueprint.anchor)
        || current.materialSource !== 'self_gathered') throw fail('house_self_supply_contract_changed', '不能改变原定房屋、自给来源或营地');
      // Resume a physically confirmed relocation saved by the previous schema:
      // old camp search cursors cannot be replayed against the new anchor.
      if(current.surfaceResources?.anchor&&!same(current.surfaceResources.anchor,current.camp.anchor)
        &&current.retiredCamps?.some(entry=>same(entry.camp.anchor,current.surfaceResources.anchor))){
        const retired=current.retiredCamps.map(entry=>same(entry.camp.anchor,current.surfaceResources.anchor)?{...entry,
          surfaceResources:current.surfaceResources,quarry:current.quarry,quarryEntry:current.quarryEntry}:entry);
        save({surfaceResources:null,quarry:null,quarryEntry:null,retiredCamps:retired});
      }
      return;
    }
    const camp = await deps.chooseCamp(blueprint, constructionBounds); active();
    deps.setCheckpoint({ schema: 1, profile: blueprint.profile, houseAnchor: { ...blueprint.anchor },
      materialSource: 'self_gathered', camp: copy(camp), ownedStations: {} });
  }
  async function run(requirements, options = {}) {
    await initialize();
    return deps.withContext(source, resourceBounds(), async () => {
      active();
      if (!options.requireFullEquipment && Object.entries(requirements).every(([name, needed]) => count(name) >= needed)){await deps.provision?.(state().camp.anchor,{expedition:false});active();return { confirmed: true, requirements: { ...requirements } };}
      await deps.leaveConstructionInterior?.();active();
      const deficits=Object.entries(requirements).filter(([name,needed])=>count(name)<needed);
      if(deficits.length===1&&deficits[0][0]==='oak_planks'&&deficits[0][1]-count('oak_planks')<=4
        &&typeof deps.prepareFieldPlanks==='function'&&bot.health>=12&&bot.food>=12){
        await deps.prepareFieldPlanks(deficits[0][1],resourceBounds());active();
        if(Object.entries(requirements).every(([name,needed])=>count(name)>=needed))return {confirmed:true,requirements:{...requirements}};
      }
      deps.onPreparationStage?.('critical_recovery'); await deps.recoverBeforeReturn?.(); active();
      if(state().provisioningReturnNeeded||Number.isFinite(bot.health)&&bot.health<6&&bot.food<18||Number.isFinite(bot.food)&&bot.food<8){
        deps.onPreparationStage?.('urgent_provision');await deps.provision?.(state().camp.anchor);active();
      }
      await deps.survivalBeforeReturn?.(); active();
      const fieldBootstrap=(await deps.shouldBootstrapField?.())===true;active();
      // Finding a usable archived camp is not worth an exposed empty-handed
      // trip before local tools. Preserve every prior station and receipt.
      const needsOwnedWool=Number(requirements.white_bed||0)>count('white_bed')
        &&bot.inventory.items().some(i=>i.name.endsWith('_wool')&&i.name!=='white_wool');
      const restored=fieldBootstrap?null:await deps.restorePriorCamp?.(state(),{requirements,woolReuse:needsOwnedWool});active();
      const adoptRestoredCamp=async restored=>{
        if(!restored)return false;
        const prior=state();
        save({camp:restored.camp,ownedStations:restored.ownedStations,storage:restored.storage,
          surfaceGraphs:restored.surfaceGraphs||{},surfaceResources:restored.surfaceResources||null,
          quarry:restored.quarry||null,quarryEntry:restored.quarryEntry||null,activeSurfaceGraph:null,localRouteRecovery:null,
          retiredCamps:[...(prior.retiredCamps||[]),{camp:prior.camp,ownedStations:prior.ownedStations,storage:prior.storage,
            surfaceGraphs:prior.surfaceGraphs,surfaceResources:prior.surfaceResources,quarry:prior.quarry,quarryEntry:prior.quarryEntry,reason:'provisional_camp_replaced_after_actual_owned_camp_return'}]});
        deps.updateResourceBounds?.(resourceBounds());
        // Ownership was re-observed, but archived stock was deliberately
        // cleared. Read/close the real owned chest before acquiring more wood
        // for equipment so surviving supplies can be reused immediately.
        if(restored.storage?.chests?.length)await ensureStorage();active();
        return true;
      };
      await adoptRestoredCamp(restored);
      const relocated=await deps.relocateDestroyedCamp?.(state().camp);active();
      const adoptCamp=(camp,reason)=>{
        const prior=state();
        save({camp:{...camp,logName:prior.camp.logName,plankName:prior.camp.plankName},ownedStations:{},storage:null,
          surfaceGraphs:{},surfaceResources:null,quarry:null,quarryEntry:null,activeSurfaceGraph:null,localRouteRecovery:null,
          retiredCamps:[...(prior.retiredCamps||[]),{camp:prior.camp,ownedStations:prior.ownedStations,storage:prior.storage,
            surfaceGraphs:prior.surfaceGraphs,surfaceResources:prior.surfaceResources,quarry:prior.quarry,quarryEntry:prior.quarryEntry,reason}]});
        deps.updateResourceBounds?.(resourceBounds());
      };
      if(relocated)adoptCamp(relocated,'destroyed_camp_relocated');else await deps.repairCampAccess?.();active();
      const resumingBootstrap=fieldBootstrap||!state().ownedStations?.crafting_table
        &&same(state().surfaceResources?.anchor,state().camp.anchor)&&state().surfaceResources?.searches?.any_log;
      // A suspended wood search already has an anchored transport contract.
      // Resume it from actual observations; its gatherer still confirms the
      // physical return before any camp crafting. Returning first repeats an
      // exposed journey without obtaining the tools needed to survive it.
      if(!resumingBootstrap){deps.onPreparationStage?.('return_camp'); await deps.returnCamp(state().camp.anchor,{allowNearbyWork:true}); active();}
      if (fieldBootstrap || !state().ownedStations?.crafting_table || deps.blockAt(state().camp.stations.crafting_table)?.name!=='crafting_table' && !bot.inventory.items().some(i=>i.name.endsWith('_log')||i.name.endsWith('_planks'))) {
        const wood = await deps.bootstrapWood({ anchor: state().camp.anchor, exclusionBounds: resourceBounds() }); active();
        if (!wood || !bot.registry.itemsByName[wood.plankName] || !bot.registry.itemsByName[wood.logName]
          || count(wood.logName) + count(wood.plankName) <= 0) throw fail('house_self_supply_wood_unconfirmed', '没有确认自然启动木材，不能提前选择木板配方');
        save({ camp: { ...state().camp, logName: wood.logName, plankName: wood.plankName } });
        // Harvesting may have physically brought an empty-handed survivor
        // beside its own intact former outpost. Reopen that nearby owned box
        // before creating another camp or reacquiring its already stored iron.
        const nearbyOwned=await deps.restorePriorCamp?.(state(),{localOnly:true});active();
        if(!await adoptRestoredCamp(nearbyOwned)){
          const fieldCamp=await deps.relocateDestroyedCamp?.(state().camp,{fieldBootstrap:true});active();
          if(fieldCamp)adoptCamp(fieldCamp,'bootstrap_resources_nearby');
        }
      }
      deps.onPreparationStage?.('crafting_table'); await ensureStation('crafting_table'); active();
      deps.onPreparationStage?.('basic_equipment'); await deps.prepareBasicEquipment?.(); active();
      deps.onPreparationStage?.('furnace'); await ensureStation('furnace'); active();
      deps.onPreparationStage?.('storage');
      // Storage keeps its strict AIR-only write contract. Clear only the
      // candidate's observed replaceable surface before asking it to place.
      for(const position of state().camp.storageSites||[])for(const dy of [1,0]){
        active();const p={...position,y:position.y+dy},block=deps.blockAt(p);
        if(isCampReplaceablePlant(block)){
          if(typeof deps.clearStationVegetation!=='function')throw fail('house_camp_vegetation_clear_missing','仓库用地需要原生地表清理');
          await campWork(()=>deps.clearStationVegetation(p));active();
          if(!['air','cave_air','void_air'].includes(deps.blockAt(p)?.name))throw fail('house_camp_vegetation_not_cleared','仓库用地尚未实际清理');
        }
      }
      await ensureStorage(); active();
      // Persist bulk progress before the first deep iron trip. Keep a small
      // real building/fuel reserve and all tools/food/torches; later recipes
      // withdraw their exact inputs through the same verified owned storage.
      await storage.stash(keepCounts({[state().camp.logName||'oak_log']:2,[state().camp.plankName||'oak_planks']:8,cobblestone:8,dirt:8}));active();
      // The first shield itself needs an iron expedition. Provision before
      // that dependency chain, rather than waiting until after it succeeds.
      deps.onPreparationStage?.('expedition_provision');
      await deps.provision?.(state().camp.anchor,{expedition:true});active();
      if(typeof deps.activateCampBed==='function'){deps.onPreparationStage?.('camp_respawn');await source.prepareRespawn();active();}
      deps.onPreparationStage?.('defense'); await deps.prepareDefense?.(); active();
      await deps.provision?.(state().camp.anchor); active();
      await storage.stash(keepCounts(requirements)); active();
      await takeOwnedStock(requirements); active();
      const result = await recipes.ensure(requirements); active();
      deps.onPreparationStage?.('return_camp'); await deps.returnCamp(state().camp.anchor,{allowNearbyWork:true}); active();
      return result;
    });
  }
  source = {
    run, ensure: input => recipes.ensure(input), ensureStation, ensureStorage,
    prepareRespawn:()=>require('./houseCampBed').prepareHouseCampBed({getBot:deps.getBot,assertActive:active,
      getCamp:()=>state().camp.anchor,getCheckpoint:()=>state().respawnCamp,
      save:record=>{save({respawnCamp:record});deps.updateResourceBounds?.(resourceBounds());},
      ensure:requirements=>recipes.ensure(requirements),excluded:p=>resourceBounds().some(b=>p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ),
      place:ownedPlacement,reach:deps.reach,activate:deps.activateCampBed,sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
      record:record=>deps.onPreparationStage?.('camp_respawn_confirmed',record)}),
    prepareSurvivalTools: async (options = {}) => {
      active(); if (deps.canPrepareSurvivalTools?.() !== true) return false;
      const ownedTable=state().ownedStations?.crafting_table;
      const workshopFailure=state().survivalWorkshopFailure;
      const sameFailedApproach=workshopFailure?.position&&Date.now()-workshopFailure.at<60000
        &&Math.hypot(...['x','y','z'].map(k=>deps.getBot().entity.position[k]-workshopFailure.position[k]))<16;
      if(ownedTable?.confirmedPlaced===true&&ownedTable.position
        &&(!options.localWorkshopOnly||Math.hypot(...['x','y','z'].map(k=>deps.getBot().entity.position[k]-ownedTable.position[k]))<=12)
        &&deps.blockAt(ownedTable.position)?.name==='crafting_table'&&!sameFailedApproach){
        // Reuse actual carried/owned camp stock before harvesting again. A
        // critically hurt survivor beside its own intact workshop needs no
        // second outpost and no full-health gate to craft a basic weapon.
        try{
          await ensureStation('crafting_table'); active();
          await recipes.ensure({wooden_sword:1}); active();
          await deps.equipSurvivalWeapon?.(); active();
          await recipes.ensure({wooden_pickaxe:1}); active();
          if(state().storage?.chests?.some(chest=>chest.confirmedPlaced===true&&deps.blockAt(chest.position)?.name==='chest')){
            await takeOwnedStock({dirt:12,cobblestone:12}); active();
          }
          return count('wooden_sword')>=1&&count('wooden_pickaxe')>=1;
        }catch(error){
          active();
          if(!/^house_surface_dry_graph_(rejoin_unconfirmed|native_no_path|probe_inconclusive|movement_timeout|leg_timeout)$/.test(String(error.code||'')))throw error;
          const p=deps.getBot().entity.position;
          save({survivalWorkshopFailure:{at:Date.now(),position:{x:p.x,y:p.y,z:p.z},code:error.code}});
          deps.onPreparationStage?.('survival_workshop_unreachable',{code:error.code,strategy:'local_tools',arrivalConfirmed:false});
        }
      }
      const deadline=Math.min(Date.now()+(options.localWorkshopOnly?600000:60000),Number.isFinite(options.deadline)?options.deadline-5000:Infinity);
      if(deadline<=Date.now())return false;
      const wood = await deps.bootstrapWood({ anchor: state().camp.anchor, exclusionBounds: resourceBounds(), survivalBootstrap: true, deadline }); active();
      if (!wood) return false;
      const camp = await deps.relocateDestroyedCamp?.(state().camp, { fieldBootstrap: true }); active();
      if (!camp) throw fail('house_survival_tools_camp_missing', '就地自救工具需要真实安全工作点');
      const prior = state();
      save({ camp: { ...camp, logName: wood.logName, plankName: wood.plankName }, ownedStations: {}, storage: null,
        surfaceGraphs: {}, surfaceResources: null, quarry: null, quarryEntry: null, activeSurfaceGraph: null, localRouteRecovery: null,
        retiredCamps: [...(prior.retiredCamps || []), { camp: prior.camp, ownedStations: prior.ownedStations, storage: prior.storage,
          surfaceGraphs: prior.surfaceGraphs, surfaceResources: prior.surfaceResources, quarry: prior.quarry, quarryEntry: prior.quarryEntry,
          reason: 'local_survival_tools_before_food_search' }] });
      deps.updateResourceBounds?.(resourceBounds());
      await ensureStation('crafting_table'); active();
      await recipes.ensure({ wooden_sword: 1 }); active();
      await deps.equipSurvivalWeapon?.(); active();
      await recipes.ensure({ wooden_pickaxe: 1 }); active();
      if (count('wooden_sword') < 1 || count('wooden_pickaxe') < 1) throw fail('house_survival_tools_unconfirmed', '自救工具没有实际入包');
      return true;
    },
    ensureAnyPlanks: count => recipes.ensure({ [state()?.camp?.plankName || 'oak_planks']: count }),
    withContext: async action => { await initialize(); return deps.withContext(source, resourceBounds(), action); },
    takeOwnedStock, storage, recipes, keepCounts, resourceBounds,
    getCamp: () => state()?.camp?.anchor,
    returnCamp: (options={}) => deps.returnCamp(state().camp.anchor,options),
    stash: (requirements = {}) => storage.stash(keepCounts(requirements)),
  };
  return source;
}
function chooseLocalStationReplacement({camp,item,position,blockAt,excluded=()=>false}){
 const result=[];
 for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++)for(const dy of [0,1,-1]){
  const p={x:camp.anchor.x+dx,y:camp.anchor.y+dy,z:camp.anchor.z+dz};
  if(same(p,camp.anchor)||Object.values(camp.stations||{}).some(q=>same(p,q))||excluded(p)
    ||Math.hypot(p.x+.5-position.x,p.y-position.y,p.z+.5-position.z)>4
    ||Math.abs(p.x+.5-position.x)<.8&&Math.abs(p.z+.5-position.z)<.8)continue;
  const cell=blockAt(p),head=classifyMiningBlock(blockAt({...p,y:p.y+1})),floor=classifyMiningBlock(blockAt({...p,y:p.y-1}));
  if(!['air','cave_air','void_air'].includes(cell?.name)||!head.loaded||!head.passable||head.hazard||!floor.support||floor.hazard||floor.gravity)continue;
  result.push(p);
 }
 return result.sort((a,b)=>Math.hypot(a.x-position.x,a.y-position.y,a.z-position.z)-Math.hypot(b.x-position.x,b.y-position.y,b.z-position.z))[0]||null;
}
module.exports = { createHouseSelfSupplyRuntime, isCampReplaceablePlant, chooseLocalStationReplacement };
