'use strict';
// Bounded dry escape through installed pathfinder and native physics.
// Actual server acceptance is recorded separately from offline regressions.
const { Physics, PlayerState } = require('prismarine-physics');
const { Vec3 } = require('vec3'), { goals } = require('mineflayer-pathfinder');
const { naturalWalkingFoot: dryFoot, inspectSurfaceBody, hasGroundedBodySupport, inspectDryDescentSupport } = require('./houseSurfaceGraph');
const { isNaturalWalkingBodyFact, isNaturalWalkingBodyBlock } = require('./houseNaturalWalkingBody');
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const plain = p => ({ x: p.x, y: p.y, z: p.z });
const finite = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]));
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const center = p => ({ x: p.x + .5, y: p.y, z: p.z + .5 });
const key = p => `${p.x},${p.y},${p.z}`;
const gotoFrames = new WeakMap();

// Read-only observation of original Physics' Y-before-X grounded bit. A former
// contact may disappear horizontally for one tick before native gravity runs.
// This never applies a predicted state or grants actual-grounded credit.
const HAZARD = new Set(['water', 'lava', 'bubble_column', 'magma_block', 'fire', 'soul_fire', 'cactus', 'powder_snow', 'campfire', 'soul_campfire', 'sweet_berry_bush']);
function fullCube(block) {
  return block && !HAZARD.has(block.name) && ![true, 'true'].includes(block.getProperties?.().waterlogged)
    && block.boundingBox === 'block' && block.shapes?.some(s => s.length === 6 && s.every((v, i) => v === (i < 3 ? 0 : 1)));
}
function actualFullCubeContacts(bot, maximumGap = .075) {
  const e = bot.entity, p = e?.position, half = (e?.width ?? .6) / 2, result = [];
  if (!finite(p) || !Number.isFinite(half) || half <= 0 || half > .5) return result;
  for (let x = Math.floor(p.x - half + 1e-8); x <= Math.floor(p.x + half - 1e-8); x++) {
    for (let z = Math.floor(p.z - half + 1e-8); z <= Math.floor(p.z + half - 1e-8); z++) {
      for (let y = Math.floor(p.y - maximumGap) - 1; y <= Math.floor(p.y); y++) {
        const position = new Vec3(x, y, z), block = bot.blockAt(position), top = y + 1;
        if (fullCube(block) && top <= p.y + 1e-6 && p.y - top <= maximumGap
          && Math.min(p.x + half, x + 1) - Math.max(p.x - half, x) > 1e-8
          && Math.min(p.z + half, z + 1) - Math.max(p.z - half, z) > 1e-8) {
          result.push({ position: plain(position), name: block.name, stateId: block.stateId, top });
        }
      }
    }
  }
  return result;
}
function inspectNativeStaleGroundDescent(bot, { tick, lastGrounded, body = inspectSurfaceBody(bot),observeStoppedInput=false } = {}) {
  const e = bot.entity, p = e?.position, v = e?.velocity;
  const facts = { accepted: false, reason: 'native_stale_ground_unconfirmed', reads: 0,
    predictions: [], actualGrounded: false, predictionApplied: false };
  if (typeof observeStoppedInput!=='boolean'||e?.onGround !== true || !body.dry || !body.cells?.length || body.cells.some(c => !isNaturalWalkingBodyFact(c))
    || !finite(p) || !finite(v) || !Number.isFinite(e.yaw) || !Number.isFinite(e.pitch)
    || Math.abs(v.y - (-.0784000015258789)) > 1e-6 || Math.hypot(v.x, v.z) > .25
    || !Number.isSafeInteger(tick) || tick - lastGrounded?.tick !== 1 || !finite(lastGrounded.position)
    || !lastGrounded.contacts?.length || horizontal(p, lastGrounded.position) > .35
    || Math.abs(p.y - lastGrounded.position.y) > 1e-6 || actualFullCubeContacts(bot).length) return facts;
  const controls = {};
  for (const name of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
    if (typeof bot.controlState?.[name] !== 'boolean') { facts.reason = 'native_stale_ground_controls_unknown'; return facts; }
    controls[name] = observeStoppedInput?false:bot.controlState[name];
  }
  const cache = new Map();
  const loaded = Object.create(bot);
  loaded.blockAt = raw => {
    const q = raw.floored(), id = key(q);
    if (cache.has(id)) return cache.get(id);
    if (cache.size >= 512) throw fail('native_stale_ground_read_limit', 'Native observation read limit');
    const b = bot.blockAt(q); facts.reads++;
    if(!b)throw fail('native_stale_ground_unknown_or_hazard','Prediction requires loaded cells');
    // Native Physics samples below a solid ice floor. Water completely below
    // that confirmed floor cannot touch this one-step landing; still model it
    // honestly and reject any predicted wet body or missing floor below.
    const containedWater=b.name==='water'&&q.y<Math.floor(p.y)-2&&fullCube(loaded.blockAt(q.offset(0,1,0)));
    if((HAZARD.has(b.name)&&!containedWater)||[true,'true'].includes(b.getProperties?.().waterlogged))
      throw fail('native_stale_ground_unknown_or_hazard','Prediction cannot borrow exposed hazardous cells');
    cache.set(id, b); return b;
  };
  try {
    const foot = p.floored(), below1 = loaded.blockAt(foot.offset(0, -1, 0));
    const lower = loaded.blockAt(foot.offset(0, -2, 0)), lowerTop = foot.y - 1;
    if (!isNaturalWalkingBodyBlock(below1) || !fullCube(lower) || Math.abs(lowerTop - (p.y - 1)) > 1e-6 || p.y - lowerTop > 1.05) {
      facts.reason = 'native_stale_ground_not_one_lower_floor'; return facts;
    }
    if (!lastGrounded.contacts.every(contact => {
      const b = loaded.blockAt(new Vec3(contact.position.x, contact.position.y, contact.position.z));
      return fullCube(b) && b.stateId === contact.stateId && Math.abs(contact.position.y + 1 - contact.top) <= 1e-6;
    })) { facts.reason = 'native_stale_ground_old_support_changed'; return facts; }
    const state = new PlayerState(bot, controls);
    state.attributes = JSON.parse(JSON.stringify(state.attributes || {}));
    const world = { getBlock: loaded.blockAt }, physics = Physics(bot.registry, world);
    for (let n = 1; n <= 8; n++) {
      physics.simulatePlayer(state, world);
      const projected = Object.create(loaded);
      projected.entity = { ...e, position: state.pos, velocity: state.vel, onGround: state.onGround,
        isInWater: state.isInWater, isInLava: state.isInLava };
      const projectedBody = inspectSurfaceBody(projected);
      // Native horizontal motion can land on the adjacent column of the same
      // one-block-lower floor. Confirm its real loaded full-cube contact;
      // requiring the original column rejected ordinary descending strides.
      const landingContact = actualFullCubeContacts(projected).find(c => Math.abs(c.top - lowerTop) <= 1e-6
        && horizontal(state.pos, p) <= 2 && fullCube(loaded.blockAt(new Vec3(c.position.x,c.position.y,c.position.z)))
        && loaded.blockAt(new Vec3(c.position.x,c.position.y,c.position.z)).stateId === c.stateId);
      const sameFloor = Boolean(landingContact);
      facts.predictions.push({ tick: n, position: plain(state.pos), onGround: state.onGround === true, bodyDry: projectedBody.dry, sameFloor });
      if (!projectedBody.dry || projectedBody.cells.some(c => !isNaturalWalkingBodyFact(c)) || state.isInWater || state.isInLava
        || state.pos.y < lowerTop - 1e-6 || state.pos.y > p.y + 1e-6) { facts.reason = 'native_stale_ground_prediction_not_dry'; return facts; }
      if (state.onGround === true && sameFloor) {
        facts.brakeRequired=observeStoppedInput;facts.accepted = true; facts.reason = 'native_stale_ground_one_step_confirmed'; return facts;
      }
    }
    facts.reason = 'native_stale_ground_landing_unknown';
  } catch (error) { facts.reason = error.code || 'native_stale_ground_prediction_unavailable'; }
  return facts;
}


function boundedNativeAirborneMotion(bot,{tick,lastGrounded,sprinting=false}={}){
 const e=bot.entity;
 return e?.onGround===false&&finite(e.position)&&finite(e.velocity)&&finite(lastGrounded?.position)
  &&Number.isSafeInteger(tick)&&Number.isSafeInteger(lastGrounded.tick)&&tick>=lastGrounded.tick&&tick-lastGrounded.tick<=16
  &&horizontal(e.position,lastGrounded.position)<=(sprinting?3.5:1.75)&&e.velocity.y>=-.9&&e.velocity.y<=.43;
}

function createHouseCreeperEscape(deps, limits = {}) {
  for (const name of ['getBot', 'assertActive', 'isOwnerCurrent', 'getThreat']) if (typeof deps[name] !== 'function') throw new TypeError(`Captured creeper escape requires ${name}`);
  const bot = deps.getBot(), client = bot?._client, profile = bot?.pathfinder?.movements;
  const cfg = { safeDistance: 8.5, arrivalMargin: .25, maximumDistance: 12, maximumSteps: 16, timeoutMs: 4000, maximumProbes: 8, planningMs: 120, threatName: 'creeper', emergencyRetreat: false, emergencySprinting:false, ...limits };
  const observedNeutral = !['creeper', 'zombie', 'zombie_villager', 'husk', 'drowned', 'spider', 'cave_spider'].includes(cfg.threatName);
  const nativeNeutralThreat=e=>require('./entitySemantics').isObservedSelfAggressor(e)
    ||e?.name==='enderman'&&require('./entitySemantics').isThreateningMobEntity(e,bot.registry);
  if (observedNeutral && !(deps.getThreat()?.name===cfg.threatName
    &&nativeNeutralThreat(deps.getThreat())))
    throw new TypeError('Dry escape requires a known melee threat or the exact native self-damage source');
  if (!Number.isFinite(cfg.safeDistance) || cfg.safeDistance < (cfg.threatName==='creeper'?8.5:4.5) || cfg.safeDistance > 12 || !Number.isFinite(cfg.arrivalMargin) || cfg.arrivalMargin < 0 || cfg.arrivalMargin > .5
    || cfg.maximumDistance !== 12 || cfg.maximumSteps !== 16 || !Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 50 || cfg.timeoutMs > 4000
    || !Number.isInteger(cfg.maximumProbes) || cfg.maximumProbes < 1 || cfg.maximumProbes > 8 || !Number.isInteger(cfg.planningMs) || cfg.planningMs < 20 || cfg.planningMs > 150) throw new TypeError('Creeper escape limits may not relax dry12m/16step/4s contract');
  if(typeof cfg.emergencySprinting!=='boolean'||cfg.emergencySprinting&&!cfg.emergencyRetreat)throw new TypeError('Sprint retreat requires explicit emergency ownership');
  if (typeof cfg.emergencyRetreat !== 'boolean') throw new TypeError('Emergency retreat must be explicit');
  const minimumHealth = cfg.emergencyRetreat ? Number.MIN_VALUE : 16, minimumFood = cfg.emergencySprinting?7:cfg.emergencyRetreat ? 0 : 14;
  let sprintGranted=false,nativeGoalIssued=false;
  const safeProfile = () => profile && profile.canDig === false && profile.scafoldingBlocks?.length === 0 && profile.allowParkour === false && profile.allow1by1towers === false
    && profile.allowSprinting === sprintGranted && profile.allowFreeMotion === false && Number.isFinite(profile.maxDropDown) && profile.maxDropDown >= 0 && profile.maxDropDown <= 2 && profile.infiniteLiquidDropdownDistance === false && profile.exclusionAreasStep?.length;
  if (!safeProfile()) throw fail('house_creeper_escape_profile', '原移动profile必须已禁止挖掘、搭桥、跑酷、冲刺、路径shortcut和额外坠落');
  let closed = false, activeGoal = null, lastGround = null;
  let remainingDistance=cfg.maximumDistance,remainingSteps=cfg.maximumSteps,remainingProbes=cfg.maximumProbes,remainingPlanning=cfg.planningMs,planningMargin=1.25;
  const record = (kind, value) => deps.record?.(kind, value);
  const owner = () => deps.getBot() === bot && bot._client === client && deps.isOwnerCurrent() === true && bot.pathfinder.movements === profile;
  const active = () => { if (closed) throw fail('house_creeper_escape_closed', '本次避让能力已关闭'); deps.assertActive(); if (!owner()) throw fail('house_creeper_escape_preempted', '避让所有权、连接或原profile已改变'); if (!safeProfile()) throw fail('house_creeper_escape_profile', '原profile安全策略被改变'); };
  function threat() {
    const e = deps.getThreat();
    if (!e || e.name !== cfg.threatName || e.isValid === false || require('./entitySemantics').getObservedEntityHealth(e,bot.registry)===0 || !Number.isInteger(e.id) || !finite(e.position)
      ||observedNeutral&&!nativeNeutralThreat(e)) throw fail('house_creeper_escape_threat_lost', '原威胁没有可确认的实时实体');
    return e;
  }
  const threats = primary => {
    const others = typeof deps.getThreats === 'function' ? deps.getThreats() : Object.values(bot.entities || {});
    if (!Array.isArray(others) || others.length > 4096) throw fail('house_creeper_escape_threat_unknown', '威胁集合必须是有限实际实体');
    const names = ['creeper', 'zombie', 'zombie_villager', 'husk', 'drowned', 'spider', 'cave_spider', 'skeleton', 'stray', 'bogged'];
    const actual = [...new Map([primary, ...others.filter(e => names.includes(e?.name) && e.isValid !== false && Number.isInteger(e.id) && finite(e.position)
      // Surface escape must not project a mob48 blocks underground onto this
      // walking plane. Recompute actual3D proximity on every guard tick; a mob
      // entering the nearby sphere still immediately participates.
      && Math.abs(bot.entity.position.y-e.position.y)<4 && bot.entity.position.distanceTo(e.position) <= 16)].map(e => [e.id, e])).values()];
    if (actual.length > 16) throw fail('house_creeper_escape_threat_limit', '附近实际苦力怕超过本次有限处理上限');
    return actual;
  };
  // Secondary walking mobs have contact range, not the primary creeper's
  // blast boundary. They remain observed on every native physics tick.
  const safeDistanceFor=e=>e.name==='creeper'?Math.max(8.5,cfg.safeDistance):e.id!==deps.getThreat()?.id&&['zombie','zombie_villager','husk','drowned','spider','cave_spider'].includes(e.name)?4.5:cfg.safeDistance;
  const safeMarginFor=e=>safeDistanceFor(e)+cfg.arrivalMargin;
  const secondaryYieldFloors=new Map(),contactPackFloors=new Map(),primaryLateralFloors=new Map();
  const ordinaryContact=e=>['zombie','zombie_villager','husk','drowned'].includes(e?.name);
  // A contact pack can block every monotonic route while the player is
  // already taking melee damage. Only an unarmed ordinary-melee emergency
  // may cross an existing ordinary-melee pack; this does not grant approach
  // to creepers or ranged mobs. Native proof and shared limits stay.
  const contactPack=cfg.emergencyRetreat&&cfg.emergencySprinting&&ordinaryContact(deps.getThreat())
    &&horizontal(bot.entity.position,deps.getThreat().position)<=2.75
    &&Object.values(bot.entities||{}).filter(e=>ordinaryContact(e)&&e.isValid!==false&&finite(e.position)&&bot.entity.position.distanceTo(e.position)<4.75).length>=2
    &&!(bot.inventory?.items?.()||[]).some(i=>/_(sword|axe)$/.test(i.name)||['trident','mace'].includes(i.name));
  // previousDistance is measured against the CURRENT mob pose, so a native
  // mob update may reduce it independently of the player's own movement.
  // A cached initial yield floor must never forbid movement already away
  // from that newly closer threat. Static-plan approach caps stay unchanged.
  const retreatFloor=(e,previousDistance)=>{
    // A cliff can require a small lateral turn before distance increases.
    // Only an ordinary, non-fusing primary creeper already beyond6.5m may
    // yield at most .5m from its INITIAL distance, never cumulatively per node.
    // The actual final8.5m proof and all other threat floors remain unchanged.
    if(e===deps.getThreat()&&e.name==='creeper'&&cfg.emergencyRetreat&&cfg.emergencySprinting&&bot.health>=12){
      const keys=bot.registry.entitiesByName.creeper?.metadataKeys||[];
      const ordinary=bot.version==='1.21.8'&&Boolean(e.metadata)
        &&['is_powered','is_ignited'].every(k=>{const i=keys.indexOf(k),v=e.metadata[i];return i>=0&&(v===undefined||v===false||v===0);})
        &&keys.includes('swell_dir')&&[undefined,-1,0].includes(e.metadata[keys.indexOf('swell_dir')]);
      if(!primaryLateralFloors.has(e)){
        const initial=horizontal(bot.entity.position,e.position),floor=ordinary&&initial>=6.5&&initial<safeMarginFor(e)?Math.max(6,initial-.5):null;
        primaryLateralFloors.set(e,floor);
        if(floor!==null)record('dry_escape_primary_lateral_floor',{id:e.id,initialDistance:initial,minimumDistance:floor,maximumApproach:.5});
      }
      const floor=primaryLateralFloors.get(e);if(ordinary&&floor!==null)return Math.min(previousDistance,floor);
    }
    if(contactPack&&ordinaryContact(e)){
      if(!contactPackFloors.has(e)){
        const initial=horizontal(bot.entity.position,e.position);
        const floor=initial<4.75?Math.min(initial,.5):null;
        contactPackFloors.set(e,floor);
        if(floor!==null)record('dry_escape_contact_pack_floor',{id:e.id,name:e.name,initialDistance:initial,minimumDistance:floor,maximumApproach:initial-floor,primary:cfg.threatName});
      }
      const floor=contactPackFloors.get(e);if(floor!==null)return Math.min(previousDistance,floor);
    }
    if(cfg.threatName==='creeper'&&cfg.emergencyRetreat&&cfg.emergencySprinting&&bot.health>=12
      &&e.id!==deps.getThreat()?.id&&['zombie','zombie_villager','husk','drowned'].includes(e.name)){
      if(!secondaryYieldFloors.has(e)){
        const initial=horizontal(bot.entity.position,e.position);
        const closeYield=initial>=3.25&&initial<safeMarginFor(e)+.5;
        const lateralPrimary=primaryLateralFloors.get(deps.getThreat())!=null;
        const approach=lateralPrimary&&initial>=4.5?1:.5;
        secondaryYieldFloors.set(e,closeYield?Math.max(lateralPrimary?3.5:2.75,initial-approach):null);
        if(closeYield)record('dry_escape_secondary_yield_floor',{id:e.id,name:e.name,initialDistance:initial,
          minimumDistance:secondaryYieldFloors.get(e),maximumApproach:approach,primary:'creeper'});
      }
      const floor=secondaryYieldFloors.get(e);if(floor!==null)return Math.min(previousDistance,floor);
    }
    return Math.min(previousDistance,safeMarginFor(e));
  };
  const allSafe=(position,live,margin=0)=>live.every(e=>horizontal(position,e.position)>=safeDistanceFor(e)+margin);
  function supportedDry(tick = 0) {
    const entity = bot.entity, p = entity?.position;
    if (!finite(p) || !finite(entity.velocity) || !inspectSurfaceBody(bot).dry) throw fail('house_creeper_escape_hazard', '避让身体接触未知、水、岩浆或危险方块');
    const half = (entity.width || .6) / 2, height = entity.height || 1.8;
    for (let x = Math.floor(p.x - half + 1e-8); x <= Math.floor(p.x + half - 1e-8); x++) for (let z = Math.floor(p.z - half + 1e-8); z <= Math.floor(p.z + half - 1e-8); z++) {
      for (let y = Math.floor(p.y); y <= Math.floor(p.y + height - 1e-8); y++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        for (const s of b?.shapes || []) if (p.x + half > x + s[0] && p.x - half < x + s[3] && p.z + half > z + s[2] && p.z - half < z + s[5]
          && p.y + .02 < y + s[4] && p.y + height - .02 > y + s[1]) throw fail('house_creeper_escape_hazard', '实际身体与实心方块碰撞');
      }
    }
    if (hasGroundedBodySupport(bot)) { lastGround = { position: plain(p), tick, contacts: actualFullCubeContacts(bot) }; return; }
    const foot = p.floored(), near = [1, 2].some(dy => {
      const b = bot.blockAt(foot.offset(0, -dy, 0));
      return b && !['water', 'lava', 'bubble_column', 'magma_block', 'fire', 'soul_fire', 'cactus', 'powder_snow'].includes(b.name)
        && ![true, 'true'].includes(b.getProperties?.().waterlogged) && b.shapes?.some(s => s[4] === 1);
    });
    if (entity.onGround === true && near) {
      const transition = inspectNativeStaleGroundDescent(bot, { tick, lastGrounded: lastGround });
      if (transition.accepted) { record('creeper_escape_native_edge_observed', transition); return; }
      if(activeGoal&&cfg.emergencySprinting){
        const stopped=inspectNativeStaleGroundDescent(bot,{tick,lastGrounded:lastGround,observeStoppedInput:true});
        if(stopped.accepted){record('creeper_escape_native_descent_brake',stopped);return stopped;}
      }
    }
    if (!near && entity.onGround === false) {
      const descent = inspectDryDescentSupport(bot, { tick, lastGrounded: lastGround });
      if (descent.accepted) { record('creeper_escape_native_descent_observed', descent); return; }
    }
    if (!near || !boundedNativeAirborneMotion(bot,{tick,lastGrounded:lastGround,sprinting:cfg.emergencySprinting})) throw fail('house_creeper_escape_airshaft', '避让离开真实有限支撑或处于深坑',
      {airborneFacts:{nearSupport:near,onGround:entity.onGround,actual:plain(p),velocity:plain(entity.velocity),tick,lastGrounded:lastGround,actualContacts:actualFullCubeContacts(bot),emergencySprinting:cfg.emergencySprinting}});
  }
  async function settleDryMomentum(began, primary, budget={distance:cfg.maximumDistance,steps:cfg.maximumSteps}) {
    const speed = () => Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z);
    if (speed() <= .03) return { traveled: 0, ticks: 0,steps:0 };
    const origin = plain(bot.entity.position), initialHealth = bot.health;
    const iceBrake=cfg.emergencySprinting&&actualFullCubeContacts(bot).some(c=>['ice','frosted_ice','packed_ice','blue_ice'].includes(c.name));
    const risingBrake=cfg.emergencyRetreat&&cfg.emergencySprinting&&hasGroundedBodySupport(bot)
      &&bot.entity.velocity.y>0&&bot.entity.velocity.y<=.43&&speed()<=.4;
    const brakeLimits=risingBrake?{distance:3.5,ticks:16,time:1200,speed:.4}:iceBrake?{distance:3.5,ticks:34,time:1700,speed:.35}:{distance:.6,ticks:6,time:1000,speed:.25};
    const brakeDeadline = Math.min(began + cfg.timeoutMs, Date.now() + brakeLimits.time);
    let previous = origin, traveled = 0, ticks = 0,steps=0,previousCell=key(bot.entity.position.floored());
    return new Promise((resolve, reject) => {
      let timer, onTick, finished = false;
      const finish = error => {
        if (finished) return; finished = true; clearTimeout(timer); if (onTick) bot.removeListener('physicsTick', onTick);
        if (error) { reject(error); return; }
        const result = { traveled, ticks,steps,iceBrake,risingBrake, elapsedMs: Date.now() - began, actual: plain(bot.entity.position), velocity: plain(bot.entity.velocity) };
        try { record('dry_escape_braking_confirmed', result); } catch { /* Diagnostics cannot retain a physical observer. */ }
        resolve(result);
      };
      const inspect = () => {
        try {
          active();
          if (Date.now() >= brakeDeadline) throw fail('house_creeper_escape_braking_timeout','原生减速未在本次有限观察时限内确认');
          supportedDry(ticks);
          const observed=deps.getThreat();
          const absent=!observed||observed===primary&&(observed.isValid===false||require('./entitySemantics').getObservedEntityHealth(observed,bot.registry)===0);
          // A removed/dead target does not cancel the no-input native coast.
          // Finish its same finite friction observation before reporting loss.
          if ((!absent&&threat() !== primary) || bot.pathfinder.goal !== null ||
              ['forward','back','left','right','jump','sprint','sneak'].some(name => bot.controlState?.[name] !== false) ||
              (!risingBrake&&!hasGroundedBodySupport(bot)) || speed() > brakeLimits.speed || bot.health < initialHealth || bot.food < minimumFood)
            throw fail('house_creeper_escape_braking_unconfirmed', '原生减速缺少无输入、干地支撑或原执行归属');
          const actual = plain(bot.entity.position); traveled += Math.hypot(actual.x-previous.x,actual.y-previous.y,actual.z-previous.z); previous=actual;
          const cell=key(bot.entity.position.floored());if(cell!==previousCell){steps++;previousCell=cell;}
          // Emergency proximity is the reason to escape, including a creeper.
          // It cannot by itself cancel the bounded friction handoff. Actual
          // damage, terrain, ownership and original motion/time limits remain.
          if (traveled > Math.min(brakeLimits.distance,budget.distance) || steps>budget.steps || ticks > brakeLimits.ticks || threats(primary).some(e => horizontal(actual,e.position) < (e.name === 'creeper' ? 4.5 : 3.5)
            && !cfg.emergencyRetreat))
            throw fail('house_creeper_escape_braking_limit', '原生减速达到位移、帧数或威胁间距边界',{brakingFacts:{traveled,steps,ticks,speed:speed(),iceBrake,risingBrake,limits:brakeLimits,remainingDistance:budget.distance,remainingSteps:budget.steps,actual:plain(actual)}});
          if (speed() <= .03 && hasGroundedBodySupport(bot)) finish();
        } catch (error) { finish(error); }
      };
      onTick = () => { ticks++; inspect(); };
      // No motor writes: only installed physics may dissipate the old velocity.
      // Keep every actual physics tick observed, including network catch-up.
      bot.prependListener('physicsTick', onTick);
      timer = setTimeout(() => finish(fail('house_creeper_escape_braking_timeout','原生减速未在本次有限观察时限内确认')),Math.max(1,brakeDeadline-Date.now()));
      inspect();
    });
  }
  function validatePath(path, origin, liveThreats) {
    if (!Array.isArray(path) || path.length < 1 || path.length > remainingSteps) return null;
    let previous = origin, length = 0;
    const distances = liveThreats.map(e => horizontal(origin, e.position)), checked = [];
    for (const step of path) {
      if (!step || !['x', 'y', 'z'].every(k => Number.isSafeInteger(step[k])) || step.toBreak?.length || step.toPlace?.length || !dryFoot(bot, step)) return null;
      const p = center(step), dx = Math.abs(step.x - Math.floor(previous.x)), dz = Math.abs(step.z - Math.floor(previous.z)), dy = Math.abs(step.y - Math.floor(previous.y));
      if (dx + dz > 1 || dy > 1) return null;
      length += Math.hypot(p.x - previous.x, p.y - previous.y, p.z - previous.z) + (contactPack?0:p.y>previous.y?1: p.y<previous.y?.35:0);
      if (length > remainingDistance + 1e-7) return null;
      for (let i = 0; i < liveThreats.length; i++) {
        const d = horizontal(p, liveThreats[i].position);
        if (d + .025 < retreatFloor(liveThreats[i],distances[i])) return null;
        distances[i] = d;
      }
      checked.push({ x: step.x, y: step.y, z: step.z }); previous = p;
    }
    return { path: checked, length, end: checked.at(-1), endDistance: Math.min(...distances) };
  }
  function solve(primary) {
    active(); const origin = plain(bot.entity.position), foot = bot.entity.position.floored(), liveThreats = threats(primary);
    record('dry_escape_threats_observed', { primaryId: primary.id, scope: 'actual_3d_16m',
      threats: liveThreats.map(e => ({ id: e.id, name: e.name, position: plain(e.position),
        actualDistance: bot.entity.position.distanceTo(e.position) })) });
    // Surface sampling never changes actor/world/profile.
    // Its new node/read limits do not expand12m/16step/4s/8probes/120ms.
    const began = Date.now(), planningDeadline = began + remainingPlanning;
    const stats = { surfaceNodes: 0, surfaceReads: 0, surfaceReadLimit: 4096,
      surfaceNodeLimit: 512, unknownCells: 0, rejectedDry: 0, rejectedCloser: 0,
      candidates: 0, nativeProbes: 0, planningElapsedMs: 0, stopReason: null };
    const cache = new Map(), dryView = Object.create(bot);
    const withinBudget = () => { active(); return Date.now() < planningDeadline-(cfg.emergencySprinting?Math.min(25,remainingPlanning/3):0) && stats.surfaceNodes < stats.surfaceNodeLimit && stats.surfaceReads < stats.surfaceReadLimit; };
    dryView.blockAt = raw => {
      const p = raw.floored(), id = key(p);
      if (cache.has(id)) return cache.get(id);
      if (stats.surfaceReads >= stats.surfaceReadLimit) return null;
      stats.surfaceReads++; const block = bot.blockAt(p); if (!block) stats.unknownCells++;
      cache.set(id, block); return block;
    };
    const initialDistances = liveThreats.map(e => horizontal(origin, e.position));
    const start = { position: { x: foot.x, y: foot.y, z: foot.z }, previous: origin, length: 0, steps: 0, distances: initialDistances };
    const queue = [start], best = new Map([[key(start.position), 0]]), candidates = [];
    const iceCorridor=cfg.emergencySprinting&&actualFullCubeContacts(bot).some(c=>['ice','frosted_ice','packed_ice','blue_ice'].includes(c.name));
    const lateral=n=>Math.min(Math.abs(n.position.x-foot.x),Math.abs(n.position.z-foot.z));
    const emergencyOrder=(a,b)=>(iceCorridor?lateral(a)-lateral(b):0)
      ||Math.min(...b.distances.map((d,i)=>d-safeMarginFor(liveThreats[i])))-Math.min(...a.distances.map((d,i)=>d-safeMarginFor(liveThreats[i])))||a.length-b.length;
    // Cost ordered finite surface search visits actual one-block cardinal
    // up/down neighbors. Native pathfinder still independently plans the move.
    while (queue.length && withinBudget()) {
      queue.sort((a,b) => a.length - b.length || Math.min(...b.distances) - Math.min(...a.distances));
      const node = queue.shift(); if (node.length > best.get(key(node.position)) + 1e-7) continue;
      stats.surfaceNodes++;
      // Native GoalBlock can finish before the exact center, and a live
      // creeper can approach during travel. Plan beyond the real stop radius;
      // actual safety still comes only from the unchanged current-body guard.
      if (node.steps > 0 && node.distances.every((distance,i)=>distance>=safeMarginFor(liveThreats[i])+planningMargin)) {
        candidates.push(node); stats.candidates++;
        if(cfg.emergencySprinting){
          candidates.sort(emergencyOrder);
          if(candidates.length>24)candidates.length=24;
        }else if (candidates.length >= 24) break;
      }
      if (node.steps >= remainingSteps) continue;
      for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) for (const dy of [0,1,-1]) {
        active(); if (Date.now() >= planningDeadline || stats.surfaceReads >= stats.surfaceReadLimit) break;
        const p = { x: node.position.x+d[0], y: node.position.y+dy, z: node.position.z+d[1] }, c = center(p);
        if (horizontal(c,origin) > remainingDistance + 1e-7 || Math.abs(p.y-foot.y)>cfg.maximumSteps) continue;
        const length = node.length + Math.hypot(c.x-node.previous.x,c.y-node.previous.y,c.z-node.previous.z)
          + (contactPack?0:c.y>node.previous.y?1:c.y<node.previous.y?.35:0);
        if (length > remainingDistance + 1e-7) continue;
        const distances = liveThreats.map(e => horizontal(c,e.position));
        if (distances.some((distance,i) => distance + .025 < retreatFloor(liveThreats[i],node.distances[i]))) { stats.rejectedCloser++; continue; }
        if (!dryFoot(dryView,p)) { stats.rejectedDry++; continue; }
        const id = key(p); if (best.has(id) && best.get(id) <= length + 1e-7) continue;
        best.set(id,length); queue.push({position:p,previous:c,length,steps:node.steps+1,distances});
      }
    }
    if (Date.now() >= planningDeadline) stats.stopReason = 'planning_deadline';
    else if (stats.surfaceNodes >= stats.surfaceNodeLimit) stats.stopReason = 'surface_node_limit';
    else if (stats.surfaceReads >= stats.surfaceReadLimit) stats.stopReason = 'surface_read_limit';
    else stats.stopReason = candidates.length >=24 ? 'candidate_budget' : 'surface_frontier_exhausted';
    candidates.sort((a,b) => cfg.emergencySprinting
      ?emergencyOrder(a,b)
      :a.length-b.length || Math.min(...b.distances)-Math.min(...a.distances));
    for (const candidate of candidates) {
      active(); if (stats.nativeProbes >= remainingProbes || Date.now() >= planningDeadline) break;
      const target=candidate.position; if (!dryFoot(bot,target)) continue;
      stats.nativeProbes++;
      const iterator=bot.pathfinder.getPathFromTo(profile,bot.entity.position,new goals.GoalBlock(target.x,target.y,target.z),{optimizePath:false,timeout:Math.min(40,Math.max(1,planningDeadline-Date.now())),tickTimeout:5,searchRadius:16});
      let result;
      for(let i=0;i<16;i++){active();if(Date.now()>=planningDeadline)break;const next=iterator.next();result=next.value?.result;if(next.done||result?.status!=='partial')break;}
      if(result?.status!=='success')continue;
      const checked=validatePath(result.path,origin,liveThreats);if(!checked)continue;
      stats.planningElapsedMs=Date.now()-began;stats.stopReason='native_plan_confirmed';
      record('creeper_escape_plan',{threatId:primary.id,origin,target,probes:stats.nativeProbes,...checked,planStats:{...stats},plannedArrivalBuffer:planningMargin,iceCorridorPreferred:iceCorridor,actualMovementConfirmed:false});
      return {...checked,probes:stats.nativeProbes,target,planStats:{...stats}};
    }
    stats.planningElapsedMs=Date.now()-began;
    if(Date.now()>=planningDeadline)stats.stopReason='planning_deadline';else if(stats.nativeProbes>=remainingProbes)stats.stopReason='native_probe_limit';
    throw fail('house_creeper_escape_no_path','有限已加载干地中没有不靠近苦力怕的原生逃离路线',{probes:stats.nativeProbes,initialDistance:horizontal(origin,primary.position),planStats:{...stats}});
  }
  async function escapeLeg(shared) {
    closed=false;active(); const began = shared.began, primary = threat(), primaryId = primary.id;
    if (!Number.isFinite(bot.health) || bot.health < minimumHealth || !Number.isFinite(bot.food) || bot.food < minimumFood) throw fail('house_creeper_escape_survival_limit', '避让生命或饱食低于当前动作阈值');
    supportedDry();
    const initialDistance = Math.min(...threats(primary).map(e=>horizontal(bot.entity.position,e.position)));
    const braking = await settleDryMomentum(began, primary,{distance:cfg.maximumDistance-shared.traveled,steps:cfg.maximumSteps-shared.steps}); active();
    if(threat()!==primary)throw fail('house_creeper_escape_threat_lost','原目标身份在减速后改变');
    if (allSafe(bot.entity.position,threats(primary),cfg.arrivalMargin) && hasGroundedBodySupport(bot)) { closed = true; return { confirmed: true, alreadySafe: true, threatId: primaryId, initialDistance, finalDistance: Math.min(...threats(primary).filter(e=>safeDistanceFor(e)===cfg.safeDistance).map(e=>horizontal(bot.entity.position,e.position))), traveled: shared.traveled+braking.traveled, elapsedMs: Date.now()-began, actual: plain(bot.entity.position) }; }
    remainingDistance=cfg.maximumDistance-shared.traveled-braking.traveled;
    remainingSteps=cfg.maximumSteps-shared.steps-(braking.steps||0);remainingProbes=cfg.maximumProbes-shared.probes;remainingPlanning=cfg.planningMs-shared.planningMs;
    const movedThreat=shared.previousThreatPosition&&horizontal(primary.position,shared.previousThreatPosition)>.15;
    // A settled live replan with less than3m left must not require the
    // extra planning buffer beyond its actual arrival margin. The native
    // 8.5m stop proof, moving-threat guards and shared12m/4s limits remain.
    planningMargin=contactPack||shared.leg>0&&remainingDistance<3?0:shared.leg===0||movedThreat?1.25:0;shared.previousThreatPosition=plain(primary.position);
    const plan = solve(primary); shared.probes+=plan.probes;shared.planningMs+=plan.planStats.planningElapsedMs;active();
    // A native end goal across consecutive down-steps can carry momentum past
    // the intermediate floor. Keep the already validated first descent as the
    // current goal; the existing settled-owner replan shares all old limits.
    let previousY=Math.floor(bot.entity.position.y);
    for(const step of plan.path){
      if(step.y<previousY){
        plan.plannedFinalTarget={...plan.target};plan.target={...step};plan.stopAtFirstDescent=true;
        record('creeper_escape_descent_boundary',{target:plan.target,plannedFinalTarget:plan.plannedFinalTarget,
          actualArrivalConfirmed:false,originalDeadline:shared.began+cfg.timeoutMs});break;
      }
      previousY=step.y;
    }
    if (Date.now() - began >= cfg.timeoutMs) throw fail('house_creeper_escape_timeout', '原生探路已耗尽本次总避让时间');
    const goal = new goals.GoalBlock(plan.target.x, plan.target.y, plan.target.z); activeGoal = goal;
    let timer, rejectGuard, resolveGuard, guardError = null, safeStop = false, dropBrake=false, ticks = 0, traveled = shared.traveled+braking.traveled, previous = plain(bot.entity.position), actualSteps=shared.steps+(braking.steps||0),previousCell=key(bot.entity.position.floored());
    const guard = new Promise((resolve, reject) => { resolveGuard = resolve; rejectGuard = reject; });
    const stopOwn = () => {
      const cleanupOwner = deps.getBot() === bot && bot._client === client && bot.pathfinder.movements === profile
        && (owner() || deps.isCleanupOwnerCurrent?.() === true);
      if (cleanupOwner && bot.pathfinder.goal === goal) { bot.pathfinder.setGoal(null); bot.clearControlStates(); }
    };
    const abort = error => {
      if (guardError || safeStop) return; guardError = error; closed = true;
      error.observedEscape = { threatId: primaryId, actual: plain(bot.entity.position), velocity: plain(bot.entity.velocity), onGround: bot.entity.onGround,
        health: bot.health, food: bot.food, traveled, ticks, elapsedMs: Date.now() - began, target: plan.target };
      stopOwn(); try { deps.onFailure?.(error); } catch {} rejectGuard(error);
    };
    const inspect = () => {
      if (safeStop || guardError) return;
      try {
        active(); const current = threat(); if (current.id !== primaryId || current !== primary) throw fail('house_creeper_escape_threat_changed', '原苦力怕实体已替换');
        if (bot.health < minimumHealth || bot.food < minimumFood || !Number.isFinite(bot.health) || !Number.isFinite(bot.food)) throw fail('house_creeper_escape_survival_limit', '实际避让生命或饱食下降');
        ticks++;const support=supportedDry(ticks);
        if(support?.brakeRequired&&!dropBrake){dropBrake=true;stopOwn();resolveGuard({nativeDropBrake:true});}
        const cell=key(bot.entity.position.floored());if(cell!==previousCell){actualSteps++;previousCell=cell;}
        if(actualSteps>cfg.maximumSteps)throw fail('house_creeper_escape_step_limit','实际避让达到原16步总上限');
        const actual = plain(bot.entity.position), liveThreats = threats(current), delta = Math.hypot(actual.x - previous.x, actual.y - previous.y, actual.z - previous.z); traveled += delta;
        if (traveled > cfg.maximumDistance + 1e-7) throw fail('house_creeper_escape_distance_limit', '本次实际避让达到12m上限');
        // Nearby threats still require monotonic retreat. A farther threat
        // cannot veto a corridor that remains outside the same safe boundary.
        for (const e of liveThreats) if (horizontal(actual, e.position) + .075 < retreatFloor(e,horizontal(previous,e.position))) throw fail('house_creeper_escape_approaching', '实际机器人移动正在靠近苦力怕');
        const distance = Math.min(...liveThreats.map(e => horizontal(actual, e.position)));
        record('creeper_escape_tick', { actual, threat: plain(current.position), distance, ownMotion: delta, traveled, ticks }); previous = actual;
        if (allSafe(actual,liveThreats,cfg.arrivalMargin) && hasGroundedBodySupport(bot)) { safeStop = true; stopOwn(); resolveGuard({ safeStop: true }); }
      } catch (error) { abort(error); }
    };
    const checkActualPath = update => {
      if (safeStop || guardError || !Array.isArray(update?.path) || !update.path.length) return;
      try {
        active(); const p = threat();
        // Installed goto postProcessPath converts full-cube cells to x/z+.5.
        // Validate its actual cells; source exclusion areas disable shortcuts.
        const cells = update.path.map(step => ({ ...step, x: Math.floor(step.x), y: Math.floor(step.y), z: Math.floor(step.z) }));
        if (!validatePath(cells, plain(bot.entity.position), threats(p))) throw fail('house_creeper_escape_path_changed', '原生执行路径不再满足干地、有限、逐步远离条件');
      }
      catch (error) { abort(error); }
    };
    bot.prependListener('physicsTick', inspect); bot.on('path_update', checkActualPath);
    timer = setTimeout(() => abort(fail('house_creeper_escape_timeout', '本次原生避让总时间达到4秒以内限额')), Math.max(1, cfg.timeoutMs - (Date.now() - began)));
    let pending;
    const gotoFrame = { previous: bot.pathfinder.goto, active: true };
    function guardedGoto(candidate, ...args) {
      // Only this exact captured goal is guarded. A foreign actor's different
      // goal is untouched; a delayed old host callback cannot revive ours.
      if(candidate===goal){if(!gotoFrame.active)throw fail('house_creeper_escape_closed','旧原生目标已关闭');active();}
      return gotoFrame.previous.call(this, candidate, ...args);
    }
    const cleanupGoto = () => {
      gotoFrame.active = false;
      if (bot.pathfinder.goto === guardedGoto) { let previousGoto = gotoFrame.previous; while (gotoFrames.get(previousGoto)?.active === false) previousGoto = gotoFrames.get(previousGoto).previous; bot.pathfinder.goto = previousGoto; }
    };
    gotoFrames.set(guardedGoto, gotoFrame); bot.pathfinder.goto = guardedGoto;
    try {
      pending = Promise.resolve().then(() => { active(); nativeGoalIssued=true; return deps.actualNativeGoto ? deps.actualNativeGoto(goal, {
        timeoutMs: Math.max(1, cfg.timeoutMs - (Date.now() - began)), preserveMovements: true,
        isOwnerCurrent: () => !closed && owner(), assertActive: active,
        isExpectedNativeStop: () => (safeStop||dropBrake) && !guardError && !closed && owner()
          && deps.getBot() === bot && bot._client === client
          && bot.pathfinder.movements === profile && bot.pathfinder.goal === null
          &&(dropBrake?inspectSurfaceBody(bot).dry&&['forward','back','left','right','jump','sprint','sneak'].every(k=>bot.controlState[k]===false):hasGroundedBodySupport(bot)),
      }) : bot.pathfinder.goto(goal); }); pending.then(cleanupGoto, cleanupGoto);
      const nativeResult = await Promise.race([pending.then(value => ({ nativeResult: value })), guard]);
      if(!safeStop){
        // Native GoalBlock can resolve when feet enter its integer cell while
        // the final step-up is still airborne. Keep the SAME physics guard and
        // total budget until it actually lands; no new movement or arrival credit.
        const landingUntil=Math.min(began+cfg.timeoutMs,Date.now()+650);
        while(!safeStop&&!guardError&&(dropBrake||!hasGroundedBodySupport(bot))&&Date.now()<landingUntil){
          active();if(dropBrake&&hasGroundedBodySupport(bot)&&Math.hypot(bot.entity.velocity.x,bot.entity.velocity.z)<=.03)break;await new Promise(resolve=>setTimeout(resolve,10));
        }
        if(guardError)throw guardError;
        if(!safeStop)inspect();
        if(guardError)throw guardError;
        if(!safeStop)throw fail('house_creeper_escape_unconfirmed','原生goto返回但实际苦力怕距离仍不安全',{nativeSettlement:'SETTLED'});
      }
      active();
      let settleTimer;
      const settled = await Promise.race([pending.then(() => true, () => true), new Promise(resolve => { settleTimer = setTimeout(() => resolve(false), 250); })]); clearTimeout(settleTimer);
      active(); if (!settled) throw fail('house_creeper_escape_native_unsettled', '旧原生goto未确认停止', { nativeSettlement: 'UNKNOWN' });
      const current = threat(), finalDistance = Math.min(...threats(current).filter(e=>safeDistanceFor(e)===cfg.safeDistance).map(e=>horizontal(bot.entity.position,e.position)));
      if (!hasGroundedBodySupport(bot) || !allSafe(bot.entity.position,threats(current))) throw fail('house_creeper_escape_unconfirmed', '停止后实际干地或8.5m间距没有保持',{nativeSettlement:'SETTLED'});
      const result = { confirmed: true, threatId: primaryId, threatName: primary.name, initialDistance, finalDistance, traveled, ticks, elapsedMs: Date.now() - began, actual: plain(bot.entity.position), nativeStoppedEarly: !!nativeResult.safeStop, plan };
      record('creeper_escape_confirmed', result); return result;
    } catch (error) {
      stopOwn();
      error.observedEscape ||= {actual:plain(bot.entity.position),health:bot.health,food:bot.food,traveled,steps:actualSteps,elapsedMs:Date.now()-began,target:plan.target};
      if((guardError||error).code==='house_creeper_escape_threat_lost'){
        let settlementTimer;
        const settled=!pending||await Promise.race([pending.then(()=>true,()=>true),new Promise(resolve=>{settlementTimer=setTimeout(()=>resolve(false),250);})]);
        clearTimeout(settlementTimer);
        (guardError||error).nativeSettlement=settled?'SETTLED':'UNKNOWN';
      }
      if (guardError) throw guardError;
      deps.assertActive();
      if (!owner()) throw fail('house_creeper_escape_preempted', '旧避让原生goto因其他actor接管而结束', { cause: { code: error.code || error.name, message: error.message } });
      throw error;
    } finally {
      shared.traveled=traveled;shared.steps=actualSteps;
      closed = true; activeGoal = null; clearTimeout(timer); bot.removeListener('physicsTick', inspect); bot.removeListener('path_update', checkActualPath);
      if (!pending) cleanupGoto();
    }
  }
  let used=false;
  async function escape(){
    if(used)throw fail('house_creeper_escape_closed','本次避让能力已经使用');used=true;
    active();
    try{
    if(cfg.emergencySprinting){
      if(!Number.isFinite(bot.food)||bot.food<7)throw fail('house_creeper_escape_survival_limit','冲刺撤退需要原生饥饿值大于6');
      sprintGranted=true;profile.allowSprinting=true;
      record('dry_escape_sprint_granted',{maximumDistance:cfg.maximumDistance,timeoutMs:cfg.timeoutMs,maximumSteps:cfg.maximumSteps,parkourGranted:false});
    }
    const shared={began:Date.now(),traveled:0,steps:0,probes:0,planningMs:0};
    const maximumLegs=Math.min(cfg.maximumProbes,cfg.maximumSteps);
    for(let leg=0;leg<maximumLegs;leg++){
      shared.leg=leg;
      try{return await escapeLeg(shared);}
      catch(error){
        if(leg===maximumLegs-1||error.code!=='house_creeper_escape_unconfirmed'||error.nativeSettlement!=='SETTLED'
          ||Date.now()-shared.began>=cfg.timeoutMs-50||shared.traveled>=cfg.maximumDistance-1
          ||shared.steps>=cfg.maximumSteps||shared.probes>=cfg.maximumProbes||shared.planningMs>=cfg.planningMs||!owner()||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)throw error;
        deps.assertActive();
        record('creeper_escape_live_replan',{originalDeadline:shared.began+cfg.timeoutMs,traveled:shared.traveled,steps:shared.steps,probes:shared.probes,actual:plain(bot.entity.position)});
      }
    }
    }catch(error){
      if(error.code==='house_creeper_escape_threat_lost'&&!nativeGoalIssued&&!activeGoal&&owner()
        &&bot.pathfinder.goal===null&&['forward','back','left','right','jump','sprint','sneak'].every(n=>bot.controlState?.[n]===false)
        &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry&&Math.hypot(bot.entity.velocity.x,bot.entity.velocity.z)<=.03){
        error.nativeSettlement='SETTLED';error.nativeGoalIssued=false;error.nativeIdleObserved=true;
      }
      throw error;
    }finally{
      const cleanupOwner=deps.isCleanupOwnerCurrent?deps.isCleanupOwnerCurrent():deps.isOwnerCurrent();
      if(sprintGranted&&deps.getBot()===bot&&bot._client===client&&bot.pathfinder.movements===profile&&cleanupOwner===true&&profile.allowSprinting===true)
        profile.allowSprinting=false;
    }
  }
  return { escape, getActiveGoal: () => activeGoal };
}
module.exports = { createHouseCreeperEscape, inspectNativeStaleGroundDescent, actualFullCubeContacts, boundedNativeAirborneMotion };
