/* global require, module */
const { Vec3 } = require("vec3");

const BUILD_PHASES = ["floor", "frame", "walls", "windows", "roof", "furniture", "finish"];
const PHASES = ["inspect_inventory", "select_site", "prepare_materials", "clear_site", ...BUILD_PHASES, "verify"];
const AIR = new Set(["air", "cave_air", "void_air"]);
const HAZARDS = new Set(["lava", "water", "fire", "soul_fire", "magma_block", "powder_snow", "cactus", "campfire", "soul_campfire"]);
const { isNaturalHouseTerrain } = require('./houseNaturalTerrain');

const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const plain = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const vector = (p) => new Vec3(p.x, p.y, p.z);
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });

function matchesFurnishedHouseBlock(block, spec) {
  if (!block || block.name !== spec.item) return false;
  const actual = block.getProperties?.() || {};
  return Object.entries(spec.properties || {}).every(([name, expected]) => String(actual[name]) === String(expected));
}

function getFurnishedHouseScaffoldCleanupOrder(blueprint, owned) {
  const { anchor, dimensions } = blueprint;
  const exteriorDistance = ({ position: p }) => Math.max(0, anchor.x - p.x,
    p.x - (anchor.x + dimensions.width - 1), anchor.z - p.z,
    p.z - (anchor.z + dimensions.depth - 1));
  // Remove each horizontal layer from its outer edge toward the house. The
  // next lower layer stays intact as support, and outer blocks cannot hide
  // inner ones from the dig ray. Front and rear ramps face opposite ways.
  return [...owned].sort((a, b) => b.position.y - a.position.y || exteriorDistance(b) - exteriorDistance(a) ||
    a.position.z - b.position.z || a.position.x - b.position.x);
}

function createFurnishedHouseBuilder(deps) {
  const blockAt = (position) => deps.getBot().blockAt(vector(position));
  const assertActive = () => deps.assertActive();
  let state;
  let blueprint;

  function save(patch = {}) {
    assertActive();
    state = { ...state, ...patch, schema: 2, sourceProfile: blueprint.profile, anchor: plain(blueprint.anchor) };
    deps.setCheckpoint(state);
    return state;
  }

  function report(message, patch = {}) {
    assertActive();
    save(patch);
    deps.report(message);
  }

  function safeSupport(block) {
    return Boolean(block && block.boundingBox === "block" && !block.name.endsWith("_leaves") && !HAZARDS.has(block.name) && block.getProperties?.().waterlogged !== true);
  }

  function replaceable(block) {
    return Boolean(block && (AIR.has(block.name) || block.boundingBox === "empty") && !HAZARDS.has(block.name));
  }

  function ownedIds() { return new Set(state.ownedBlockIds || []); }
  const ownedFoundationPositions=()=>[...ownedIds()].filter(id=>id.startsWith('support:')).map(id=>id.slice(8));
  function foundationPlan(){
    assertActive();const plan=deps.planFoundation({blueprint,blockAt,ownedFoundationPositions:ownedFoundationPositions()});assertActive();
    if(!plan?.valid)throw failure('house_unsafe_site','地基挖填方案已变化或没有已加载的实体底座',{reason:plan?.reason,unloaded:Boolean(plan?.position&&!blockAt(plan.position))});
    return plan;
  }


  function matchesOwnedScaffold(block, spec) {
    // Vanilla spreads grass or mycelium onto placed dirt. Ownership stays on
    // the confirmed position, while foreign replacement blocks stay protected.
    return block?.name === spec.item || spec.item === "dirt" && ["grass_block", "mycelium"].includes(block?.name);
  }

  function outstanding() {
    return blueprint.blocks.filter((spec) => !matchesFurnishedHouseBlock(blockAt(spec.position), spec));
  }

  function roofComplete() {
    return blueprint.blocks.filter((spec) => spec.phase === "roof")
      .every((spec) => matchesFurnishedHouseBlock(blockAt(spec.position), spec));
  }

  function requirements({ structureOnly = false, initialOnly = false, allowUnloadedFoundationEstimate = false } = {}) {
    const items = {};
    for (const spec of outstanding()) {
      if(structureOnly&&["furniture","finish"].includes(spec.phase))continue;
      if(initialOnly&&!["floor","frame"].includes(spec.phase))continue;
      if (!spec.derived) items[spec.item] = (items[spec.item] || 0) + 1;
    }
    for (const scaffold of roofComplete() ? [] : blueprint.scaffold || []) {
      if (!safeSupport(blockAt(scaffold.position))) items[scaffold.item] = (items[scaffold.item] || 0) + 1;
    }
    if(deps.planFoundation){
      let count;
      try{count=foundationPlan().foundation.length;}
      catch(error){
        const estimate=allowUnloadedFoundationEstimate&&error.code==='house_unsafe_site'&&error.unloaded===true
          ?deps.getFoundationEstimate?.({blueprint}):null;
        if(!Number.isSafeInteger(estimate)||estimate<0||estimate>256)throw error;
        count=estimate;save({foundationMaterialEstimate:{count,observation:'UNLOADED',actualPrepared:false}});
      }
      items.cobblestone=(items.cobblestone||0)+count;
    }
    else for (const floor of blueprint.blocks.filter((spec) => spec.phase === "floor")) {
      const below = { ...floor.position, y: floor.position.y - 1 };
      if (!safeSupport(blockAt(below))) items.cobblestone = (items.cobblestone || 0) + 1;
    }
    return items;
  }

  function materialDeficits(items) {
    return Object.entries(items).map(([item, required]) => ({ item, required, available: deps.getItemCount(item) }))
      .filter((entry) => entry.available < entry.required)
      .map((entry) => ({ ...entry, missing: entry.required - entry.available }));
  }

  async function prepareMaterials() {
    const items = requirements({structureOnly:blueprint.profile==="cottage",initialOnly:blueprint.profile==="cottage",allowUnloadedFoundationEstimate:true});
    report("正在准备地板、框架和临时脚手架；后续材料按施工阶段补齐", { requirements: items });
    await deps.prepareMaterials(items, { anchor: blueprint.anchor, profile: blueprint.profile });
    assertActive();
    const missing = materialDeficits(items);
    save({ missingMaterials: missing });
    if (missing.length) {
      throw failure("house_materials_missing", `建房材料不足：${missing.map((entry) => `${entry.item} 缺 ${entry.missing}`).join("，")}`, { missingMaterials: missing });
    }
  }

  async function place(spec) {
    assertActive();
    const derivedBlocks = blueprint.blocks.filter((entry) => entry.derived && entry.item === spec.item &&
      Math.abs(entry.position.x - spec.position.x) + Math.abs(entry.position.y - spec.position.y) +
        Math.abs(entry.position.z - spec.position.z) === 1);
    const expected = [spec, ...derivedBlocks];
    if (expected.every((entry) => matchesFurnishedHouseBlock(blockAt(entry.position), entry))) return;
    if (spec.derived) throw failure("house_state_mismatch", `家具派生方块没有更新：${spec.id}`, { position: spec.position });
    const alreadyPlaced = matchesFurnishedHouseBlock(blockAt(spec.position), spec);
    const existing = blockAt(spec.position);
    if (!existing || HAZARDS.has(existing.name)) throw failure("house_unsafe_site", `建造目标未加载或有危险：${key(spec.position)}`);
    if (!alreadyPlaced && !replaceable(existing)) {
      if (!ownedIds().has(spec.id)||existing.name!==spec.item) throw failure("house_state_mismatch", `目标 ${key(spec.position)} 已有 ${existing.name}，不能直接覆盖未确认归属的方块`);
      await deps.breakBlock(spec.position);
      assertActive();
    }
    let recorded = false;
    const confirmed = () => {
      if (alreadyPlaced || recorded || blockAt(spec.position)?.name !== spec.item) return;
      recorded = true;
      state = { ...state, ownedBlockIds: [...new Set([...(state.ownedBlockIds || []), spec.id])] };
      if (deps.recordOwnedBlock) deps.recordOwnedBlock(spec, false);
      else deps.setCheckpoint(state);
    };
    await deps.placeBlock({ ...spec, derivedBlocks }, confirmed);
    confirmed();
    assertActive();
    if (!expected.every((entry) => matchesFurnishedHouseBlock(blockAt(entry.position), entry))) {
      throw failure("house_state_mismatch", `放置 ${spec.item} 后服务端方块状态不符：${key(spec.position)}`, { spec });
    }
    save();
  }

  function assertNoLeafFloorSupport() {
    for (const floor of blueprint.blocks.filter(spec => spec.phase === "floor")) {
      assertActive();
      const position = { ...floor.position, y: floor.position.y - 1 };
      if (blockAt(position)?.name.endsWith("_leaves")) {
        throw failure("house_unsafe_site", `地基不能借用会变化的树叶支撑：${key(position)}`);
      }
    }
  }

  async function clearSite() {
    assertNoLeafFloorSupport();
    // Planned soil cuts are authorized only after materials/tools were
    // gathered, and freshly re-read before any native mutation. A site plan
    // never credits cleared terrain or an actually built foundation.
    let preparation = null;
    if (deps.planSitePreparation && [...ownedIds()].every(id=>id.startsWith('support:'))) {
      assertActive();preparation=deps.planSitePreparation({anchor:blueprint.anchor,profile:blueprint.profile,blockAt,ownedFoundationPositions:ownedFoundationPositions()});assertActive();
      if(!preparation?.valid)throw failure('house_unsafe_site','整地前地形已变化或超出浅层挖填范围',{reason:preparation?.reason});
      save({sitePreparation:{...preparation.terrainPreparation,actualPrepared:false}});
    }
    const expected = new Map(blueprint.blocks.map((spec) => [key(spec.position), spec]));
    const owned = ownedIds();
    const ownedScaffold = new Map((state.ownedScaffold || []).map((spec) => [key(spec.position), spec]));
    const { bounds } = blueprint;
    const removals = [];
    // Inspect the entire site before the first dig. A blocked chest or fluid
    // must not be discovered only after part of a player's building was cut.
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        for (let z = bounds.minZ; z <= bounds.maxZ; z += 1) {
          assertActive();
          const position = { x, y, z };
          const actual = blockAt(position);
          const spec = expected.get(key(position));
          const scaffold = ownedScaffold.get(key(position));
          if (!actual || HAZARDS.has(actual.name) || actual.getProperties?.().waterlogged === true) {
            throw failure("house_unsafe_site", `建造范围未加载或存在 ${actual?.name || "未知方块"}：${key(position)}`);
          }
          if (AIR.has(actual.name) || spec && matchesFurnishedHouseBlock(actual, spec) ||
            scaffold && matchesOwnedScaffold(actual, scaffold)) continue;
          if (!isNaturalHouseTerrain(actual.name) && !(spec && owned.has(spec.id))) {
            throw failure("house_site_occupied", `建造范围已有 ${actual.name}，请另选空地：${key(position)}`);
          }
          removals.push(position);
        }
      }
    }
    // The selected work yard includes entrance and ramp headroom outside the
    // building body. All cells were freshly checked before any first dig.
    if(preparation){const seen=new Set(removals.map(key));for(const p of preparation.removals){if(!seen.has(key(p))){removals.push(p);seen.add(key(p));}}}
    const plannedFoundation=deps.planFoundation?foundationPlan():null;
    const plannedFoundationKeys=new Set((plannedFoundation?.foundation||[]).map(key)),ownedFoundationKeys=new Set(ownedFoundationPositions());
    const scaffoldCells = new Map((blueprint.scaffold || []).map((spec) => [key(spec.position), spec]));
    for (const spec of blueprint.scaffold || []) {
      const actual = blockAt(spec.position);
      const below = { ...spec.position, y: spec.position.y - 1 };
      if (!actual || HAZARDS.has(actual.name) || actual.getProperties?.().waterlogged === true ||
        (!replaceable(actual) && (!safeSupport(actual) || (!isNaturalHouseTerrain(actual.name) &&
          !(state.ownedScaffold || []).some((entry) => key(entry.position) === key(spec.position) && entry.item === actual.name))))) {
        throw failure("house_unsafe_site", `脚手架范围不安全：${key(spec.position)}`);
      }
      if (!scaffoldCells.has(key(below)) && !plannedFoundationKeys.has(key(below)) &&
          (!safeSupport(blockAt(below)) || !isNaturalHouseTerrain(blockAt(below).name) &&
            !(ownedFoundationKeys.has(key(below)) && blockAt(below).name==='cobblestone'))) {
        throw failure("house_unsafe_site", `脚手架地基没有安全支撑：${key(below)}`);
      }
    }
    // Top-down clearing avoids freeing sand/gravel onto the player's head.
    removals.sort((a, b) => b.y - a.y);
    for (let index = 0; index < removals.length; index += 1) {
      report(`${deps.planSitePreparation?'正在自主整地：清理':'正在清理小屋空地'} ${index + 1}/${removals.length}`);
      await deps.breakBlock(removals[index]);
      assertActive();
      if(deps.planSitePreparation&&!AIR.has(blockAt(removals[index])?.name))
        throw failure('house_site_preparation_unconfirmed','原生挖掘后清理格尚未确认空气',{position:removals[index]});
    }
    if(deps.planFoundation){
      const fresh=foundationPlan();
      for(const position of fresh.foundation){
        assertActive();if(!replaceable(blockAt(position))||!safeSupport(blockAt({...position,y:position.y-1})))
          throw failure('house_unsafe_site','逐层补基前没有实际相邻实体支撑',{position});
        report(`正在自主整地：逐层补齐地基 ${key(position)}`);
        await place({id:`support:${key(position)}`,position,item:'cobblestone',phase:'floor'});
      }
      const actual=foundationPlan();if(actual.foundation.length)throw failure('house_site_preparation_unconfirmed','尚有地基补齐未获得原生确认');
    }
    else for (const floor of blueprint.blocks.filter((spec) => spec.phase === "floor")) {
      assertActive();
      const position = { ...floor.position, y: floor.position.y - 1 };
      if (safeSupport(blockAt(position))) continue;
      if (!replaceable(blockAt(position)) || !safeSupport(blockAt({ ...position, y: position.y - 1 }))) {
        throw failure("house_unsafe_site", `地基下方没有可安全补齐的支撑：${key(position)}`);
      }
      await place({ id: `support:${key(position)}`, position, item: "cobblestone", phase: "floor" });
    }
    if(deps.planSitePreparation){
      for(const spec of blueprint.blocks.filter(s=>s.phase==='floor')){
        assertActive();if(!safeSupport(blockAt({...spec.position,y:spec.position.y-1})))
          throw failure('house_site_preparation_unconfirmed','整地后地基支撑未确认');
      }
      for(const p of [blueprint.entrance.outside,...blueprint.scaffoldRoute])for(const y of [p.y,p.y+1]){
        assertActive();if(!AIR.has(blockAt({...p,y})?.name))throw failure('house_site_preparation_unconfirmed','整地后入口或施工通道被阻挡');
      }
      const facts={...(state.sitePreparation||{}),actualPrepared:true,clearedCells:removals.length,
        confirmedFoundationCells:(state.ownedBlockIds||[]).filter(id=>id.startsWith('support:')).length,
        houseAccepted:false};assertActive();save({sitePreparation:facts});deps.onSitePrepared?.(facts);
    }
  }

  async function buildScaffold(specs = blueprint.scaffold || []) {
    for (const spec of specs) {
      assertActive();
      const actual = blockAt(spec.position);
      const below = { ...spec.position, y: spec.position.y - 1 };
      if (blockAt(below)?.name.endsWith("_leaves")) {
        throw failure("house_unsafe_site", `脚手架不能借用树叶支撑：${key(below)}`);
      }
      if (safeSupport(actual)) {
        if (!isNaturalHouseTerrain(actual.name) && !(state.ownedScaffold || []).some((entry) =>
          key(entry.position) === key(spec.position) && entry.item === actual.name)) {
          throw failure("house_unsafe_site", `脚手架位置出现未归属的 ${actual.name}：${key(spec.position)}`);
        }
        continue;
      }
      if (!replaceable(actual)) throw failure("house_unsafe_site", `脚手架位置被占用：${key(spec.position)}`);
      const placement = { ...spec, id: `scaffold:${key(spec.position)}` };
      let recorded = false;
      const confirmed = () => {
        if (recorded || blockAt(spec.position)?.name !== spec.item) return;
        recorded = true;
        state = { ...state, ownedScaffold: [...(state.ownedScaffold || []), { position: plain(spec.position), item: spec.item }] };
        if (deps.recordOwnedBlock) deps.recordOwnedBlock(placement, true);
        else deps.setCheckpoint(state);
      };
      await deps.placeBlock(placement, confirmed);
      confirmed();
      assertActive();
      if (blockAt(spec.position)?.name !== spec.item) throw failure("house_state_mismatch", "临时脚手架未确认放稳");
      save();
    }
  }

  async function removeScaffold() {
    if (!(state.ownedScaffold || []).length) return;
    // Always descend before taking away any owned support. Cancellation does
    // not enter this cleanup, so it cannot initiate a late move or dig.
    assertActive();
    await deps.moveTo(blueprint.entrance.outside);
    const owned = getFurnishedHouseScaffoldCleanupOrder(blueprint, state.ownedScaffold);
    save({ scaffoldCleanupStarted: true });
    for (const spec of owned) {
      assertActive();
      const actual = blockAt(spec.position);
      if (!actual || HAZARDS.has(actual.name) || actual.getProperties?.().waterlogged === true) {
        throw failure("house_unsafe_site", `脚手架清理格未加载或存在危险：${key(spec.position)}`);
      }
      if (!AIR.has(actual.name)) {
        if (!matchesOwnedScaffold(actual, spec)) throw failure("house_scaffold_changed", `脚手架位置被改为 ${actual.name}，不能移除未知归属方块：${key(spec.position)}`);
        // Reach must stay below the block's top. Otherwise it can climb back
        // onto the roof and cut the next landing out of its own exit route.
        await deps.breakBlock(spec.position, { maxFeetY: spec.position.y });
      }
      save({ ownedScaffold: (state.ownedScaffold || []).filter((entry) => key(entry.position) !== key(spec.position)) });
    }
  }

  const structurePhases=new Set(['floor','frame','walls','windows','roof']);
  function damagedStructure(loadedOnly=false){
    const known=new Set(state.observedStructureDamageIds||[]);
    for(const s of blueprint.blocks.filter(s=>!s.derived&&structurePhases.has(s.phase)&&ownedIds().has(s.id))){
      const b=blockAt(s.position);if(!b)continue;
      if(matchesFurnishedHouseBlock(b,s))known.delete(s.id);else known.add(s.id);
    }
    save({observedStructureDamageIds:[...known]});
    return blueprint.blocks.filter(s=>!s.derived&&structurePhases.has(s.phase)&&ownedIds().has(s.id)&&known.has(s.id)
      &&(!loadedOnly||blockAt(s.position)));
  }
  function exteriorPlan(){
    const fresh=require('./houseExteriorGrade').planHouseExteriorGrade(blueprint,blockAt);
    const plan=[...new Map([...(state.exteriorGradePlan||[]),...fresh].map(s=>[key(s.position),s])).values()];
    if(plan.length||state.exteriorGradePlan)save({exteriorGradePlan:plan});return plan;
  }
  async function repairStructure(){
    let pending=damagedStructure();
    if(!pending.length)return;
    for(const s of pending){const b=blockAt(s.position);
      if(!b||HAZARDS.has(b.name)||(!replaceable(b)&&b.name!==s.item))throw failure('house_structure_repair_blocked',`房屋修补位置未加载、有危险或被其他方块占用：${key(s.position)}`);
    }
    const needed={};for(const s of pending)needed[s.item]=(needed[s.item]||0)+1;
    if(materialDeficits(needed).length){await deps.prepareMaterials(needed,{anchor:blueprint.anchor,profile:blueprint.profile});assertActive();}
    if(materialDeficits(needed).length)throw failure('house_materials_missing','房屋实际损坏的修补材料尚未齐备');
    pending.sort((a,b)=>a.position.y-b.position.y);
    while(pending.length){
      const deferred=[];let progress=0,lastError;
      for(const s of pending){
        report(`修补已确认受损的房屋方块 ${s.id}`);
        try{await place(s);progress++;}catch(error){assertActive();if(!['house_no_anchor','placement_no_safe_stance'].includes(error.code))throw error;deferred.push(s);lastError=error;}
      }
      if(!progress&&deferred.length)throw lastError;pending=deferred;
    }
    save({structureRepairVerified:true});
  }
  async function buildPhase(phase) {
    assertNoLeafFloorSupport();
    const needsScaffold = ["frame", "roof"].includes(phase) && !roofComplete();
    if(blueprint.profile==="cottage"||["furniture","finish"].includes(phase)||needsScaffold){
      const needed={};
      for(const spec of outstanding().filter(s=>s.phase===phase&&!s.derived))needed[spec.item]=(needed[spec.item]||0)+1;
      // A prior preparation does not reserve carried dirt: later work may use
      // it. Budget the remaining actual scaffold cells on every phase resume.
      // Existing native support and a completed roof need no replacement dirt.
      if(needsScaffold)for(const spec of blueprint.scaffold||[]){
        if(phase==="frame"&&spec.stage!=="frame")continue;
        if(!safeSupport(blockAt(spec.position)))needed[spec.item]=(needed[spec.item]||0)+1;
      }
      if(phase==='furniture'||phase==='finish')for(const spec of damagedStructure())needed[spec.item]=(needed[spec.item]||0)+1;
      if(phase==='furniture'&&blueprint.profile==='cottage'){
        // A previously observed repair budget remains a supply goal while
        // travelling outside the house's loaded chunks. Unknown is not fixed.
        if(state.requirements?.white_bed)for(const name of ['cobblestone','oak_log','oak_planks','glass','dirt']){
          const prior=name==='dirt'&&state.exteriorGradePlan?state.exteriorGradePlan.filter(s=>!matchesOwnedScaffold(blockAt(s.position),s)).length:state.requirements[name];
          if(Number.isSafeInteger(prior)&&prior>0&&(name==='dirt'?!state.exteriorGradeVerified:!state.structureRepairVerified))
            needed[name]=Math.max(needed[name]||0,prior);
        }
        for(const spec of outstanding().filter(s=>s.phase==='finish'&&!s.derived))needed[spec.item]=(needed[spec.item]||0)+1;
        const exterior=exteriorPlan();
        const soil=exterior.filter(s=>!matchesOwnedScaffold(blockAt(s.position),s)).length;
        if(soil)needed.dirt=Math.max(needed.dirt||0,soil);
      }
      if(materialDeficits(needed).length){
        report(`补齐 ${phase} 阶段实际缺少的材料`,{phase,requirements:needed});
        await deps.prepareMaterials(needed,{anchor:blueprint.anchor,profile:blueprint.profile});assertActive();
        const missing=materialDeficits(needed);save({missingMaterials:missing});
        if(missing.length)throw failure("house_materials_missing","当前家具材料尚未实际取得",{missingMaterials:missing});
      }
    }
    if(phase==='furniture'||phase==='finish'){
      await deps.moveTo(blueprint.entrance.outside);assertActive();await repairStructure();
    }
    // A recovered cleanup needs no new dirt, even if removed drops were not
    // collected. Recheck the actual roof rather than trusting a phase flag.
    if (phase === "frame" && !roofComplete()) await buildScaffold((blueprint.scaffold || []).filter((spec) => spec.stage === "frame"));
    if (phase === "roof" && !roofComplete()) await buildScaffold();
    let pending = blueprint.blocks.filter((spec) => spec.phase === phase && !spec.derived)
      .sort((a, b) => a.position.y - b.position.y);
    const total = pending.length;
    let completed = 0;
    while (pending.length) {
      const deferred = [];
      let progress = 0;
      let lastError;
      for (const spec of pending) {
        report(`正在建造${phase} ${completed + 1}/${total}`, { phase, currentBlockId: spec.id });
        try {
          await place(spec);
          completed += 1;
          progress += 1;
        } catch (error) {
          assertActive();
          if (!["house_no_anchor", "placement_no_safe_stance"].includes(error.code)) throw error;
          deferred.push(spec);
          lastError = error;
        }
      }
      if (!progress && deferred.length) throw lastError;
      pending = deferred;
    }
    if (phase === "roof") await removeScaffold();
  }

  function verifyStructure() {
    const missing = [];
    const stateMismatches = [];
    for (const spec of blueprint.blocks) {
      const block = blockAt(spec.position);
      if (!block || block.name !== spec.item) missing.push(spec.id);
      else if (!matchesFurnishedHouseBlock(block, spec)) stateMismatches.push(spec.id);
    }
    const clearanceViolations = (blueprint.clearance || []).filter((entry) => !AIR.has(blockAt(entry.position)?.name))
      .map((entry) => ({ position: entry.position, purpose: entry.purpose }));
    return { schema: 2, sourceProfile: blueprint.profile, anchor: plain(blueprint.anchor), totalBlocks: blueprint.blocks.length,
      missingBlocks: missing.length, missingBlockIds: missing, stateMismatches, clearanceViolations };
  }

  async function checkWindow(position, method, label) {
    assertActive();
    const block = blockAt(position);
    await deps.moveTo(position, 2);
    assertActive();
    const window = await deps[method](block);
    assertActive();
    if (!window || typeof window.close !== "function") throw failure("house_furniture_unusable", `${label}未能真实打开`);
    window.close();
    assertActive();
    return { confirmed: true, position: plain(position) };
  }

  async function verifyFurniture() {
    const furniture = blueprint.furniture;
    const checks = {};
    // Door placement can finish inside the house. Approach and open it from
    // the current side before asking pathfinder to cross the front wall.
    await deps.moveTo(furniture.door.lower, 2);
    assertActive();
    if (blockAt(furniture.door.lower)?.getProperties?.().open !== true) {
      await deps.activateBlock(blockAt(furniture.door.lower));
      assertActive();
    }
    if (blockAt(furniture.door.lower)?.getProperties?.().open !== true) throw failure("house_furniture_unusable", "门没有确认开启");
    await deps.moveTo(blueprint.entrance.outside);
    assertActive();
    await deps.moveTo(blueprint.entrance.inside);
    assertActive();
    checks.craftingTable = await checkWindow(furniture.craftingTable, "openCraftingTable", "工作台");
    checks.chest = await checkWindow(furniture.chest, "openContainer", "箱子");
    checks.furnace = await checkWindow(furniture.furnace, "openFurnace", "熔炉");
    checks.bed = { confirmed: matchesFurnishedHouseBlock(blockAt(furniture.bed.foot), { item: "white_bed", properties: { part: "foot", facing: furniture.bed.facing } }) &&
      matchesFurnishedHouseBlock(blockAt(furniture.bed.head), { item: "white_bed", properties: { part: "head", facing: furniture.bed.facing } }),
    useObserved: false, reason: "双格床与上方空隙已校验；实际睡眠另需夜间且无附近怪物" };
    if (!checks.bed.confirmed) throw failure("house_furniture_unusable", "床的双格状态没有通过校验");
    if (furniture.enchantingTable) {
      checks.enchantingTable = await checkWindow(furniture.enchantingTable, "openEnchantmentTable", "附魔台");
      const table = furniture.enchantingTable;
      const effective = (furniture.bookshelves || []).filter((position) => {
        if (blockAt(position)?.name !== "bookshelf") return false;
        const dx = position.x - table.x;
        const dz = position.z - table.z;
        const gap = { x: table.x + Math.trunc(dx / 2), y: table.y, z: table.z + Math.trunc(dz / 2) };
        return AIR.has(blockAt(gap)?.name) && AIR.has(blockAt({ ...gap, y: gap.y + 1 })?.name);
      });
      checks.bookshelves = { confirmed: effective.length >= 15, effectiveCount: effective.length };
      if (!checks.bookshelves.confirmed) throw failure("house_enchanting_obstructed", `有效附魔书架不足：${effective.length}/15`);
    }
    await deps.moveTo(blueprint.entrance.outside);
    assertActive();
    if (blockAt(furniture.door.lower)?.getProperties?.().open === true) await deps.activateBlock(blockAt(furniture.door.lower));
    assertActive();
    if (blockAt(furniture.door.lower)?.getProperties?.().open !== false) throw failure("house_furniture_unusable", "门没有确认关闭");
    checks.door = { confirmed: true, traversed: true };
    return checks;
  }

  async function run(args = {}) {
    assertActive();
    const old = deps.getCheckpoint?.() || {};
    const profile = args.profile || old.sourceProfile || "cottage";
    let anchor = args.anchor || (old.schema === 2 && old.sourceProfile === profile ? old.anchor : null);
    if (!anchor) anchor = await deps.chooseAnchor(profile);
    assertActive();
    blueprint = deps.getBlueprint(anchor, { profile });
    if (blueprint.schema !== 2 || !Array.isArray(blueprint.blocks)) throw failure("house_invalid_blueprint", "精装小屋蓝图格式无效");
    state = old.schema === 2 && old.sourceProfile === blueprint.profile && old.anchor && key(old.anchor) === key(anchor) ? old : {};
    save({ phase: args.phase || state.phase || "inspect_inventory" });
    const phases = args.phase ? [args.phase] : PHASES;
    for (const phase of phases) {
      assertActive();
      if (!PHASES.includes(phase)) throw failure("house_invalid_phase", `未知精装小屋阶段：${phase}`);
      report(`精装小屋：${phase}`, { phase, verificationSummary: null });
      if (phase === "inspect_inventory") save({ requirements: requirements(), missingMaterials: materialDeficits(requirements()) });
      else if (phase === "select_site") save({ anchor: plain(anchor) });
      else if (phase === "prepare_materials") await prepareMaterials();
      else if (phase === "clear_site") await clearSite();
      else if (BUILD_PHASES.includes(phase)) await buildPhase(phase);
      else if (phase === "verify") {
        // Field cleanup may resume after a death inside the finished house.
        // Open the actual owned entrance before asking the outdoor transport
        // planner to leave; a closed door is not an unreachable field route.
        const fieldDoor=blueprint.furniture?.door?.lower;
        if(fieldDoor&&state.ownedBlockIds.includes(blueprint.blocks.find(s=>s.position.x===fieldDoor.x&&s.position.y===fieldDoor.y&&s.position.z===fieldDoor.z)?.id)
          &&blockAt(fieldDoor)?.name==='oak_door'&&blockAt(fieldDoor)?.getProperties?.().open!==true){
          await deps.moveTo(fieldDoor,2);assertActive();await deps.activateBlock(blockAt(fieldDoor));assertActive();
          if(blockAt(fieldDoor)?.getProperties?.().open!==true)throw failure('house_furniture_unusable','野外清理前房门尚未实际开启');
        }
        if(fieldDoor&&blockAt(fieldDoor)?.getProperties?.().open===true){
          await deps.moveTo(blueprint.entrance.outside);assertActive();
        }
        // Finish outstanding field equipment and temporary combat structures
        // before committing to the final house readback journey.
        if(deps.prepareFinalEquipment){await deps.prepareFinalEquipment();assertActive();}
        // A resumed task may still be at its resource camp. Unloaded house
        // cells are unknown, not evidence of damage or foreign soil changes.
        // Reach the actual entrance before any final native block readback.
        if(!blockAt(blueprint.entrance.outside)||blueprint.blocks.some(s=>!blockAt(s.position))
          ||(state.exteriorGradePlan||[]).some(s=>!blockAt(s.position))){
          await deps.moveTo(blueprint.entrance.outside);assertActive();
          if(blueprint.blocks.some(s=>!blockAt(s.position))||(state.exteriorGradePlan||[]).some(s=>!blockAt(s.position)))
            throw failure('house_chunk_unloaded','已到房屋附近，但最终核验区块尚未实际加载');
        }
        await repairStructure();
        const door=blueprint.furniture?.door?.lower;
        if(door&&blockAt(door)?.name==='oak_door'&&blockAt(door)?.getProperties?.().open!==true){
          await deps.moveTo(door,2);assertActive();await deps.activateBlock(blockAt(door));assertActive();
          if(blockAt(door)?.getProperties?.().open!==true)throw failure('house_furniture_unusable','修屋前房门尚未实际开启');
        }
        if(blueprint.profile==='cottage'){
          const exterior=exteriorPlan();
          save({exteriorGradePlan:exterior});
          const remaining=exterior.filter(s=>!matchesOwnedScaffold(blockAt(s.position),s));
          if(remaining.length&&deps.getItemCount('dirt')<remaining.length){
            await deps.prepareMaterials({dirt:remaining.length},{anchor:blueprint.anchor,profile:blueprint.profile});assertActive();
          }
          if(remaining.length&&deps.getItemCount('dirt')<remaining.length)
            throw failure('house_materials_missing',`外围分级回填还缺泥土 ${remaining.length-deps.getItemCount('dirt')}`);
          for(const spec of remaining){
            if(!AIR.has(blockAt(spec.position)?.name))throw failure('house_exterior_changed','外围回填位置发生变化，保留现场');
            if(!safeSupport(blockAt({...spec.position,y:spec.position.y-1})))throw failure('house_exterior_changed','外围回填下方支撑已改变');
            await place(spec);
          }
          if(exterior.some(s=>!matchesOwnedScaffold(blockAt(s.position),s)))throw failure('house_exterior_unconfirmed','外围回填未全部确认');
          save({exteriorGradeVerified:true});
        }
        if(deps.prepareFinalEquipment){await deps.moveTo(blueprint.entrance.outside);assertActive();}
        if(door&&blockAt(door)?.getProperties?.().open===true){
          await deps.moveTo(door,2);assertActive();await deps.activateBlock(blockAt(door));assertActive();
          if(blockAt(door)?.getProperties?.().open!==false)throw failure('house_furniture_unusable','修屋后房门尚未实际关闭');
        }
        const summary = verifyStructure();
        if(blueprint.profile==='cottage')summary.exteriorGrade={confirmed:state.exteriorGradeVerified===true,soilBlocks:state.exteriorGradePlan.length};
        save({ verificationSummary: summary });
        if (summary.missingBlocks || summary.stateMismatches.length || summary.clearanceViolations.length) {
          throw failure("house_verification_failed", `房屋校验未通过：缺块 ${summary.missingBlocks}，状态不符 ${summary.stateMismatches.length}，通路阻挡 ${summary.clearanceViolations.length}`, { verificationSummary: summary });
        }
        if ((state.ownedScaffold || []).length) throw failure("house_scaffold_remaining", "临时脚手架尚未拆除");
        summary.furnitureChecks = await verifyFurniture();
        assertActive();
        if (deps.verifyActualFurnitureUse) {
          const actualUse = await deps.verifyActualFurnitureUse(blueprint); assertActive();
          if (actualUse) {
            save({ actualFurnitureUse: actualUse });
            if (actualUse.confirmed !== true) throw failure('house_furniture_use_unconfirmed', '正式任务的家具实际使用尚未全部通过');
            summary.actualFurnitureUse = actualUse;
          }
        }
        const final = verifyStructure();
        if (final.missingBlocks || final.stateMismatches.length || final.clearanceViolations.length) throw failure("house_verification_failed", "家具使用后房屋状态没有保持完整");
        summary.furnitureVerified = true;
        save({ verificationSummary: summary, phase: "complete" });
        deps.report("精装小屋与家具已完成真实校验");
        return summary;
      }
    }
    return state;
  }

  return { run, verifyFurniture };
}

module.exports = { createFurnishedHouseBuilder, matchesFurnishedHouseBlock, getFurnishedHouseScaffoldCleanupOrder,
  FURNISHED_HOUSE_PHASES: PHASES };
