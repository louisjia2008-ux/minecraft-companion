'use strict';

// Quartz-only explicit excavation: real state gates, bounded edges and a
// confirmed reversible route. Native automatic digging stays disabled.
// Only inspectStep is reused; mineStep/walkTunnel are deliberately not called.
const {CAPS,ROCK,DANGER,GRAVITY,DIRS,key,same,fail,full,empty,inspectExcavationGeometry}=require('./quartzExcavationGeometry');
const {rankContinuations,cloneLedger}=require('./quartzExcavationContinuation');
const {oreSafetyFailure}=require('./quartzExcavationTarget');

function createExcavation({ bot, memory, shore, portal, inspectStep, Vec3, actions, makeGoal,
  foodCount, threatened, neverBreak = [], allowDiamondFallback = false, diamondReserveUses = 40,
  anchorMode = 'portal', portalEverObserved = Boolean(portal), now = Date.now } = {}) {
  for (const fn of [inspectStep, makeGoal, foodCount, threatened]) if (typeof fn !== 'function') throw new TypeError('Explicit safety dependencies required');
  if (!bot || !memory || !actions || !Vec3 || !shore) throw new TypeError('Explicit bot/memory/shore required');
  if(!['portal','shore_only'].includes(anchorMode) || (anchorMode==='portal'&&!portal)
    || (anchorMode==='shore_only'&&(portal||portalEverObserved||memory.netherPortal||memory.overworldPortal
      || memory.quartzExcavation?.portal || memory.quartzExcavation?.anchorMode==='portal')))
    throw new TypeError('Explicit immutable anchor mode: known portal cannot downgrade to shore_only');
  if (!Number.isSafeInteger(diamondReserveUses) || diamondReserveUses < 16) throw new TypeError('Diamond reserve must cover eight ore plus return margin');
  const v = p => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  shore = v(shore); portal = portal ? v(portal) : null;
  const boundAnchor=portal||shore,noPortalReturnCredit=anchorMode==='shore_only';
  const banned = new Set(neverBreak), read = p => bot.blockAt(v(p));
  const record = (ctx, stage, details = {}) => ctx.record?.('quartz_excavation', { stage, anchorMode, noPortalReturnCredit, ...details });
  const abort = signal => { if (signal?.aborted) throw Object.assign(new Error(String(signal.reason || 'aborted')), { code: 'aborted' }); };
  let inFlight = false, ownedEdgeProfile = null, pendingProposal = null;

  function standing(p) {
    const b = read(p.offset(0, -1, 0));
    if (!full(b) || DANGER.test(b.name) || GRAVITY.test(b.name)) return false;
    return empty(read(p)) && empty(read(p.offset(0, 1, 0)));
  }
  function actualAt(p) {
    const at = bot.entity?.position;
    return Boolean(at && bot.entity.onGround && same(at, p) && Math.abs(at.y - p.y) < .02
      && Math.abs(at.x - p.x - .5) <= .2 && Math.abs(at.z - p.z - .5) <= .2 && standing(p));
  }
  function profileOK() {
    const m = bot.pathfinder?.movements;
    const branded = m?.companionPhysicalDropLimit===1 && typeof m.companionPhysicalDropGuard==='function'
      && m.infiniteLiquidDropdownDistance===false && (m.getNeighbors===m.companionPhysicalDropGuard
        || (ownedEdgeProfile?.movements===m && m.getNeighbors===ownedEdgeProfile.mask
          && ownedEdgeProfile.originalNeighbors===m.companionPhysicalDropGuard));
    return Boolean(m?.companionWalkOnly && m.canDig === false && m.allowParkour === false
      && m.allow1by1towers === false && m.scafoldingBlocks?.length === 0 && (m.maxDropDown <= 1 || (m.maxDropDown<=2&&branded)));
  }
  function dimensionOK() { return /(^|:)the_nether$/.test(bot.game?.dimension || ''); }
  function admissionReceipt() {
    const at=bot.entity?.position,floor=read(shore.offset(0,-1,0));
    return{anchorMode,noPortalReturnCredit,shore:key(shore),portal:portal?key(portal):null,
      actualPosition:at?{...at}:null,onGround:bot.entity?.onGround||false,
      centreOffset:at?{x:at.x-shore.x-.5,y:at.y-shore.y,z:at.z-shore.z-.5}:null,
      shoreFullFloor:full(floor),shoreFloor:floor?.name||null,shoreBody:[read(shore)?.name||null,read(shore.offset(0,1,0))?.name||null],
      currentDimension:bot.game?.dimension||null,portalBlock:portal?read(portal)?.name||null:null};
  }
  function bounds(p) { return p.distanceTo(boundAnchor) <= 96; }
  function keepsReturnReserve(s,nextIndex,{known=false,returning=false}={}) {
    return s.used.totalEdges+1+nextIndex<=CAPS.totalEdges
      && s.used.knownEdges+(known?1:0)+nextIndex<=CAPS.knownEdges
      && s.used.returnEdges+(returning?1:0)+nextIndex<=CAPS.returnEdges;
  }
  function safety(signal, { returning = false } = {}) {
    abort(signal);
    const threat = threatened();
    if (threat !== false) return threat ? 'threat_preempted' : 'threat_status_unknown';
    if (!dimensionOK()) return 'wrong_dimension';
    if (!profileOK()) return 'walk_profile_changed';
    if (!Number.isFinite(bot.health) || bot.health <= (returning ? 0 : 8)) return 'health_retreat';
    if (!returning && anchorMode==='portal' && read(portal)?.name !== 'nether_portal') return 'portal_unavailable';
    const food = foodCount(bot);
    if (!returning && (!Number.isSafeInteger(food) || food <= 1)) return 'food_retreat';
    return null;
  }
  function initialLedger() {
    if (!actualAt(shore) || !bounds(shore) || (anchorMode==='portal' && read(portal)?.name !== 'nether_portal')) return null;
    // Require an actual natural 2x2 patch, not a planned or recently built pad.
    const patch = [[-1, -1], [-1, 0], [0, -1], [0, 0]].some(([x, z]) =>
      [0, 1].every(dx => [0, 1].every(dz => {
        const p = shore.offset(x + dx, 0, z + dz), floor = read(p.offset(0, -1, 0));
        return standing(p) && ROCK.has(floor?.name) && !memory.ledgeSupports?.has(key(floor.position))
          && !bot.companionPlacedRecently?.(floor.position);
      })));
    if (!patch) return null;
    return { version: 2, anchorMode, noPortalReturnCredit, shore: key(shore), portal: portal?key(portal):null, surfaceY: shore.y,
      route: [shore.clone()], routeIndex: 0, routeFeet: new Set([key(shore)]), protectedFloors: new Set([key(shore.offset(0,-1,0))]), open: new Set(), digCells: new Set(),
      confirmedDigCells: new Set(), confirmedDigCredit: 0,
      used: { down: 0, flat: 0, feet: 0, digs: 0, diamondRock: 0, nativeDigAttempts: 0,
        outboundEdges: 0, returnEdges: 0, knownEdges: 0, totalEdges: 0, actualDiamondWear: 0 }, retreat: false };
  }
  function initialize() {
    if (memory.quartzExcavation) return memory.quartzExcavation;
    const s=initialLedger();if(s)memory.quartzExcavation=s;return s;
  }
  function ledger() {
    const s = initialize();
    if (!s || s.version !== 2 || s.shore !== key(shore) || s.anchorMode!==anchorMode || s.portal !== (portal?key(portal):null)) return null;
    const index=s.route.findIndex(at=>actualAt(at));
    if(index>=0 && s.routeIndex!==index) {
      s.routeIndex=index;
      // Fresh observation of an already recorded cell, never new movement credit.
    }
    return s;
  }
  function protectedCell(s, p) {
    return s.protectedFloors.has(key(p)) || memory.ledgeSupports?.has(key(p)) || bot.companionProtectBlock?.(read(p))
      || bot.companionPlacedRecently?.(p);
  }
  function outer(s, from, dir, descend, { requireOpen = false } = {}) {
    if (!actualAt(from)) return fail('not_at_confirmed_front');
    return inspectExcavationGeometry({read,from,dir,descend,ledger:s,bounds,protectedCell,banned,inspectStep,Vec3,requireOpen});
  }
  function ledgerFingerprint(s) {
    return JSON.stringify(s ? {route:s.route.map(key),open:[...s.open].sort(),protectedFloors:[...s.protectedFloors].sort(),used:s.used} : null);
  }
  function proposalReadEvidence(p,b) {
    return {cell:key(p),name:b?.name||null,stateId:b?.stateId??null,boundingBox:b?.boundingBox??null,shapes:b?.shapes??null,
      ownedSupport:Boolean(memory.ledgeSupports?.has(key(p))),recentlyPlaced:Boolean(bot.companionPlacedRecently?.(p)),protectedBlock:Boolean(b&&bot.companionProtectBlock?.(b))};
  }
  function proposeDirections(ctx,{candidates,current=()=>true}={}) {
    abort(ctx.signal);pendingProposal=null;
    if(inFlight||memory.quartzExcavationLease)return fail('edge_in_flight',{preferred:null,queryOnly:true});
    const unsafe=safety(ctx.signal);if(unsafe)return fail(unsafe,{preferred:null,queryOnly:true});
    const actual=memory.quartzExcavation,s=actual||initialLedger();
    if(!s||s.version!==2||s.shore!==key(shore)||s.anchorMode!==anchorMode||s.portal!==(portal?key(portal):null))return fail('query_shore_unconfirmed',{preferred:null,queryOnly:true});
    const from=s.route.at(-1);if(!actualAt(from))return fail('not_at_confirmed_front',{preferred:null,queryOnly:true});
    const geometry={CAPS,Vec3,full,empty,oreSafety:oreSafetyFailure,source:{sha256:'shared_excavation_geometry_v1'},
      futureRockAllowed:b=>ROCK.has(b?.name)&&!banned.has(b?.name)&&b?.diggable!==false,
      query:({readBlock,ledger,from,direction,descend,ownedSupports,recentlyPlaced,protectedBlock})=>inspectExcavationGeometry({read:readBlock,ledger,from,dir:direction,descend,bounds,banned,inspectStep,Vec3,
        protectedCell:(state,p)=>state.protectedFloors.has(key(p))||ownedSupports.has(key(p))||protectedBlock(readBlock(p))||recentlyPlaced(p)})};
    const result=rankContinuations({geometry,readBlock:read,ledger:cloneLedger(s),from,shore,portal,candidates,
      ownedSupports:memory.ledgeSupports,recentlyPlaced:p=>Boolean(bot.companionPlacedRecently?.(p)),protectedBlock:b=>Boolean(bot.companionProtectBlock?.(b)),
      signal:ctx.signal,contextCurrent:current,maxMs:50});
    abort(ctx.signal);if(!current())return fail('query_context_changed',{preferred:null,queryOnly:true});
    if(result.preferred)pendingProposal={direction:result.preferred.direction,descend:result.preferred.descend,from:key(from),
      actualLedger:actual,ledgerFingerprint:ledgerFingerprint(actual),fingerprint:result.fingerprint,
      reads:result.readEvidence.filter(e=>e.provenance==='actual_snapshot')};
    return result;
  }
  function consumeProposal(ctx,direction,descend,remaining) {
    const proposal=pendingProposal;pendingProposal=null;if(!proposal)return null;
    remaining();abort(ctx.signal);
    if(proposal.direction!==direction||proposal.descend!==descend||key(bot.entity.position)!==proposal.from
      ||memory.quartzExcavation!==proposal.actualLedger||ledgerFingerprint(memory.quartzExcavation)!==proposal.ledgerFingerprint)return fail('direction_proposal_changed');
    // This fresh snapshot check is inside the existing absolute20s lease.
    // It never replaces actualAt, outer, per-dig look/start or landing gates.
    for(const expected of proposal.reads){remaining();const p=v({x:+expected.cell.split(',')[0],y:+expected.cell.split(',')[1],z:+expected.cell.split(',')[2]}),actual=proposalReadEvidence(p,read(p));
      if(JSON.stringify(actual)!==JSON.stringify(Object.fromEntries(Object.entries(expected).filter(([k])=>k!=='provenance'))))return fail('direction_proposal_changed');}
    return null;
  }
  function toolFor(s, block, kind = 'rock') {
    const usable = i => Number.isInteger(i.maxDurability) && Number.isInteger(i.durabilityUsed)
      && i.durabilityUsed >= 0 && i.maxDurability - i.durabilityUsed > 1
      && (!block.harvestTools || block.harvestTools[i.type]);
    const items = bot.inventory.items();
    if(kind==='ore') {
      for(const name of ['wooden_pickaxe','stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe']) {
        const tool=items.find(i=>i.name===name&&usable(i)&&i.maxDurability-i.durabilityUsed>8);
        if(tool)return{tool,kind:'existing_ore_pick'};
      }
      return null;
    }
    const cheap = ['wooden_pickaxe', 'stone_pickaxe'].flatMap(name => items.filter(i => i.name === name))
      .find(i => usable(i) && i.maxDurability - i.durabilityUsed > 16);
    if (cheap) return { tool: cheap, kind: 'existing_cheap' };
    const diamond = items.find(i => i.name === 'diamond_pickaxe' && usable(i)
      && i.maxDurability - i.durabilityUsed > diamondReserveUses);
    return allowDiamondFallback && s.used.diamondRock < CAPS.diamondRock && diamond
      ? { tool: diamond, kind: 'existing_diamond_bounded_fallback' } : null;
  }
  function actualTool(s, expected, block, kind = 'rock', reservedAttempt = 0) {
    if(!block)return null;
    const held = bot.heldItem;
    if (!held || held.name !== expected.name || held.type !== expected.type
      || !Number.isInteger(held.maxDurability) || !Number.isInteger(held.durabilityUsed)
      || held.durabilityUsed < 0 || (block.harvestTools && !block.harvestTools[held.type])) return null;
    const remaining = held.maxDurability-held.durabilityUsed;
    if(kind==='ore' && /^(wooden|stone|iron|diamond|netherite)_pickaxe$/.test(held.name) && remaining>8)return{held,kind:'existing_ore_pick'};
    if (['wooden_pickaxe','stone_pickaxe'].includes(held.name) && remaining > 16) return {held,kind:'existing_cheap'};
    if (held.name==='diamond_pickaxe' && allowDiamondFallback && remaining>diamondReserveUses && s.used.diamondRock-reservedAttempt<CAPS.diamondRock) {
      s.diamondReserveStart=Math.min(s.diamondReserveStart??Infinity,remaining+s.used.diamondRock);
      if(s.diamondReserveStart-(s.used.diamondRock-reservedAttempt)>diamondReserveUses)return{held,kind:'existing_diamond_bounded_fallback'};
    }
    return null;
  }
  function diamondWear() {
    const items=bot.inventory.items().filter(i=>i.name==='diamond_pickaxe');
    return {count:items.length,known:items.every(i=>Number.isInteger(i.durabilityUsed)),sum:items.reduce((n,i)=>n+(i.durabilityUsed||0),0)};
  }
  async function digCell(ctx,s,cell,{kind,remaining,checkFresh}) {
    remaining();const unsafe=safety(ctx.signal);if(unsafe)return fail(unsafe);
    let fresh=checkFresh('before');if(!fresh?.ok)return fresh||fail('fresh_validator_refused');
    const block=read(cell);if(!block)return fail('unknown_dig_cell');
    if(s.used.digs>=CAPS.digs || s.used.nativeDigAttempts>=CAPS.nativeDigAttempts)return fail('excavation_dig_budget');
    const choice=toolFor(s,block,kind);if(!choice){s.retreat=true;return fail('needs_usable_pickaxe');}
    try{await bot.equip(choice.tool,'hand');}
    catch(error){abort(ctx.signal);record(ctx,'equip_rejected',{tool:choice.tool.name,error:error.message});return fail('tool_equip_failed');}
    abort(ctx.signal);remaining();const unsafeAfterEquip=safety(ctx.signal);if(unsafeAfterEquip)return fail(unsafeAfterEquip);
    fresh=checkFresh('before');if(!fresh?.ok)return fresh||fail('fresh_validator_refused');
    if(!actualTool(s,choice.tool,read(cell),kind))return fail('actual_held_tool_unconfirmed');
    record(ctx,'dig_intent',{cell:key(cell),block:block.name,kind,tool:choice.tool.name,toolKind:choice.kind,
      damageBefore:bot.heldItem.durabilityUsed,diamondReserveUses,remainingMs:remaining(),used:{...s.used}});
    let result;const nativeDig=bot.dig,wearBefore=diamondWear(),attemptsBefore=s.used.nativeDigAttempts;
    if(typeof nativeDig!=='function')return fail('native_dig_contract_missing');
    let reservedDiamondAttempt=0;
    function assertFreshNative(useReservation = true) {
      remaining();const unsafe=safety(ctx.signal);if(unsafe)throw Object.assign(new Error(unsafe),{code:unsafe});
      const checked=checkFresh('before'),current=read(cell),actual=actualTool(s,choice.tool,current,kind,useReservation?reservedDiamondAttempt:0);
      if(!checked?.ok || !current || current.name!==block.name || !actual)
        throw Object.assign(new Error('actual_tool_or_world_changed'),{code:'actual_tool_or_world_changed'});
      return actual;
    }
    const nativeLook=bot.lookAt,client=bot._client,nativeWrite=client?.write;
    if(typeof nativeLook!=='function'||typeof nativeWrite!=='function')return fail('native_look_dispatch_contract_missing');
    async function guardedLook(...args) {
      const result=await Reflect.apply(nativeLook,this,args);
      assertFreshNative();record(ctx,'native_look_fresh',{cell:key(cell)});return result;
    }
    function guardedWrite(...args) {
      // Only reject an existing native start packet. Do not modify, synthesize,
      // delay or add protocol packets; cancellation/finish writes pass through.
      if(args[0]==='block_dig' && args[1]?.status===0) {
        if(!args[1].location || !same(args[1].location,cell))throw Object.assign(new Error('unexpected_dig_target'),{code:'unexpected_dig_target'});
        assertFreshNative();
      }
      const result=Reflect.apply(nativeWrite,this,args);
      if(args[0]==='block_dig'&&args[1]?.status===0)record(ctx,'actual_dig_dispatch',{cell:key(cell),nativePacketUnmodified:true});
      return result;
    }
    function guardedDig(...args) {
      const actual=assertFreshNative(false);
      if(!args[0]?.position || !same(args[0].position,cell) || s.used.nativeDigAttempts>=CAPS.nativeDigAttempts)
        throw Object.assign(new Error('actual_tool_or_world_changed'),{code:'actual_tool_or_world_changed'});
      s.used.nativeDigAttempts++;
      if(kind==='rock' && actual.held.name==='diamond_pickaxe'){s.used.diamondRock++;reservedDiamondAttempt=1;}
      record(ctx,'native_dig_attempt',{cell:key(cell),kind,held:actual.held.name,damage:actual.held.durabilityUsed,actualKind:actual.kind,used:{...s.used}});
      return Reflect.apply(nativeDig,this,args);
    }
    bot.dig=guardedDig;
    if(typeof nativeLook==='function')bot.lookAt=guardedLook;
    if(typeof nativeWrite==='function')client.write=guardedWrite;
    try{result=await actions.digBlock(bot,ctx,block,{tool:choice.tool,timeoutMs:Math.min(12000,remaining())});}
    finally{
      if(bot.dig===guardedDig)bot.dig=nativeDig;
      if(bot.lookAt===guardedLook)bot.lookAt=nativeLook;
      if(client?.write===guardedWrite)client.write=nativeWrite;
      const after=read(cell);
      if(after && after.name!==block.name){s.digCells.add(key(cell));s.used.digs++;if(empty(after))s.open.add(key(cell));}
      const wearAfter=diamondWear(),known=wearBefore.known&&wearAfter.known&&wearBefore.count===wearAfter.count;
      const observedDiamondWearDelta=known?Math.max(0,wearAfter.sum-wearBefore.sum):null;
      if(observedDiamondWearDelta!==null)s.used.actualDiamondWear+=observedDiamondWearDelta;
      record(ctx,'dig_readback',{cell:key(cell),kind,after:after?.name||null,actualOpen:empty(after),
        heldAfter:bot.heldItem?.name||null,damageAfter:bot.heldItem?.durabilityUsed??null,observedDiamondWearDelta,
        wearMeaning:'Current client snapshots only. Zero is not independent server proof of zero wear; native attempts debit reserve conservatively.',used:{...s.used},aborted:ctx.signal.aborted});
    }
    abort(ctx.signal);remaining();
    if(!result?.ok || !empty(read(cell)))return fail(result?.reason||'actual_open_unconfirmed');
    const after=checkFresh('after');if(!after?.ok)return after||fail('post_dig_validator_refused');
    const newCredit=s.used.nativeDigAttempts>attemptsBefore&&!s.confirmedDigCells.has(key(cell));
    if(newCredit){s.confirmedDigCells.add(key(cell));s.confirmedDigCredit++;}
    return{ok:true,progress:false,actualOpen:key(cell),safeNewDig:newCredit?1:0};
  }
  async function lease(ctx, run) {
    abort(ctx.signal);
    if (inFlight || memory.quartzExcavationLease) return fail('edge_in_flight');
    inFlight = true;
    const leaseToken={};memory.quartzExcavationLease=leaseToken;
    const controller = new AbortController(), onAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort('excavation_edge_lease_expired'), CAPS.leaseMs), until = now() + CAPS.leaseMs;
    const child = { ...ctx, signal: controller.signal }, remaining = () => {
      if (now() >= until) controller.abort('excavation_edge_lease_expired');
      abort(controller.signal); return Math.max(1, until - now());
    };
    try { const result=await run(child, remaining);return{...result,anchorMode,noPortalReturnCredit}; }
    finally {
      clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort);
      // The caller must keep the brain body lease until this joined finally.
      bot.pathfinder?.setGoal?.(null); bot.clearControlStates?.(); inFlight = false;
      if(memory.quartzExcavationLease===leaseToken)delete memory.quartzExcavationLease;
    }
  }
  async function moveEdge(ctx, s, from, to, remaining) {
    const m = bot.pathfinder.movements, allowed = new Set([key(from), key(to)]);
    // Native exclusionStep is also called for head/sweep blocks. It cannot
    // itself distinguish a valid head voxel from an invalid standing node.
    const readVolume=new Set([from,to].flatMap(p=>[0,1,2].map(y=>key(p.offset(0,y,0)))));
    const mask = b => b?.position && readVolume.has(key(b.position)) ? 0 : Infinity;
    const noMutation = () => Infinity;
    const arrays = [['exclusionAreasStep', mask], ['exclusionAreasBreak', noMutation], ['exclusionAreasPlace', noMutation]];
    if (arrays.some(([k]) => !Array.isArray(m[k])) || typeof m.getNeighbors!=='function') return fail('missing_native_exclusion_hooks');
    const originalNeighbors=m.getNeighbors,hadOwnNeighbors=Object.hasOwn(m,'getNeighbors');
    function edgeNeighbors(...args) {
      return Reflect.apply(originalNeighbors,this,args).filter(node=>allowed.has(key(node))&&!node.parkour
        && !node.toBreak?.length&&!node.toPlace?.length);
    }
    m.getNeighbors=edgeNeighbors;
    const previousEdgeProfile=ownedEdgeProfile;
    ownedEdgeProfile={movements:m,mask:edgeNeighbors,originalNeighbors};
    for (const [k, fn] of arrays) m[k].push(fn);
    record(ctx, 'move_start', { from: key(from), to: key(to), allowedFeet: [...allowed], nativeHardMask: true,
      actualFeetDeltaY:to.y-from.y,nativeDropSupportDepth:to.y<from.y?2:m.maxDropDown });
    try {
      // Native maxDropDown measures depth to SUPPORT, not the resulting feet.
      // This exact validated one-down Move needs support depth2. The neighbor
      // filter still permits only the two observed/approved standing cells.
      const savedDrop=m.maxDropDown;let result;
      if(to.y===from.y-1)m.maxDropDown=2;
      try{result=await actions.goTo(bot,ctx,makeGoal(to),{timeoutMs:remaining(),retryNoProgress:false});}
      finally{
        if(to.y===from.y-1 && m.maxDropDown===2 && m.getNeighbors===edgeNeighbors
          && ownedEdgeProfile?.movements===m && ownedEdgeProfile.mask===edgeNeighbors)m.maxDropDown=savedDrop;
      }
      abort(ctx.signal);
      if(result.ok && !bot.entity.onGround) {
        bot.pathfinder.setGoal?.(null);bot.clearControlStates?.();
        while(!bot.entity.onGround && remaining()>0) {
          const unsafe=safety(ctx.signal,{returning:true});if(unsafe)return fail(unsafe);
          await new Promise(resolve=>setTimeout(resolve,10));abort(ctx.signal);
        }
      }
      const unsafe = safety(ctx.signal, { returning: true });
      if (unsafe || bot.pathfinder.movements !== m) return fail(unsafe || 'profile_owner_changed');
      if (!result.ok || !actualAt(to)) return fail(result.reason || 'actual_edge_arrival_unconfirmed');
      for(const p of [to,to.offset(0,1,0)])for(const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const b=read(p.offset(dx,dy,dz));if(!b||DANGER.test(b.name)||GRAVITY.test(b.name))return fail('actual_edge_margin_changed');
      }
      return { ok: true };
    } finally {
      if(m.getNeighbors===edgeNeighbors){if(hadOwnNeighbors)m.getNeighbors=originalNeighbors;else delete m.getNeighbors;}
      ownedEdgeProfile=previousEdgeProfile;
      for (const [k, fn] of arrays) { const i = m[k].indexOf(fn); if (i >= 0) m[k].splice(i, 1); }
    }
  }
  async function advance(ctx, { direction, descend = false } = {}) {
    if (!Number.isInteger(direction) || !DIRS[direction]) return fail('invalid_cardinal_direction');
    return lease(ctx, async (child, remaining) => {
      const stale=consumeProposal(child,direction,descend,remaining);if(stale)return stale;
      const s = ledger(); if (!s) return fail('fresh_natural_shore_and_portal_required',{admission:admissionReceipt()});
      const unsafe = safety(child.signal); if (unsafe) { s.retreat = true; return fail(unsafe); }
      // A transient food/tool/health retreat is not a refunded budget, nor a
      // permanent deadlock after natural resupply. Actual counters decide caps.
      s.retreat=false;
      if(s.routeIndex!==s.route.length-1)return fail('known_route_front_required');
      const from = s.route.at(-1), category = descend ? 'down' : 'flat';
      if (s.used[category] >= CAPS[category] || s.used.feet >= CAPS.feet || s.used.digs >= CAPS.digs
        || s.used.outboundEdges>=CAPS.outboundEdges || s.used.totalEdges>=CAPS.totalEdges
        || s.used.nativeDigAttempts>=CAPS.nativeDigAttempts) { s.retreat = true; return fail('excavation_budget_retreat'); }
      const [dx,dz]=DIRS[direction], target=from.offset(dx,descend?-1:0,dz);
      if(s.routeFeet.has(key(target)))return fail('revisited_route_refused');
      if(!keepsReturnReserve(s,s.route.length)){s.retreat=true;return fail('return_reserve_required');}
      let plan = outer(s, from, direction, descend); if (!plan.ok) return plan;
      if (plan.dig.length > CAPS.digs - s.used.digs) { s.retreat = true; return fail('excavation_dig_budget'); }
      for (const cell of plan.dig) {
        if(empty(read(cell)))continue;
        const dug=await digCell(child,s,cell,{kind:'rock',remaining,checkFresh:()=>outer(s,from,direction,descend)});
        if(!dug.ok)return dug;
      }
      plan = outer(s, from, direction, descend, { requireOpen: true }); if (!plan.ok) return plan;
      const unsafeBeforeMove = safety(child.signal); if (unsafeBeforeMove) return fail(unsafeBeforeMove);
      const moved = await moveEdge(child, s, from, plan.target, remaining); if (!moved.ok) return moved;
      if (!s.routeFeet.has(key(plan.target))) { s.routeFeet.add(key(plan.target)); s.used.feet++; s.used[category]++; }
      s.protectedFloors.add(key(plan.target.offset(0,-1,0)));s.used.outboundEdges++;s.used.totalEdges++;
      s.route.push(plan.target.clone());s.routeIndex=s.route.length-1;record(child, 'actual_landed', { at: key(plan.target), used: { ...s.used } });
      return { ok: true, progress: false, actualFeet: key(plan.target), used: { ...s.used } };
    });
  }
  async function harvestAtFront(ctx,{position,validate}={}) {
    if(!position || typeof validate!=='function')return fail('ore_validator_required');
    return lease(ctx,async(child,remaining)=>{
      const s=ledger();if(!s)return fail('no_confirmed_route');
      if(s.routeIndex!==s.route.length-1)return fail('known_route_front_required');
      const front=s.route.at(-1),cell=v(position);
      const checkFresh=stage=>{
        const unsafe=safety(child.signal);if(unsafe)return fail(unsafe);
        if(!actualAt(front) || !bounds(cell) || protectedCell(s,cell))return fail('ore_front_or_protection_changed');
        const b=read(cell);if(!b)return fail('unknown_ore');
        if(stage==='before' && (b.name!=='nether_quartz_ore' || !full(b)))return fail('not_actual_quartz_ore');
        if(stage==='after' && !empty(b))return fail('ore_not_actual_open');
        if(bot.entity.position.offset(0,1.62,0).distanceTo(cell.offset(.5,.5,.5))>4.5)return fail('ore_out_of_reach');
        const verdict=validate({ctx:child,front:front.clone(),position:cell.clone(),block:b,stage,memory:s});
        return verdict?.ok?{ok:true}:fail(verdict?.reason||'ore_validator_refused');
      };
      return digCell(child,s,cell,{kind:'ore',remaining,checkFresh});
    });
  }
  async function walkKnownOne(ctx,{towards='front'}={}) {
    if(!['front','shore'].includes(towards))return fail('invalid_known_route_direction');
    return lease(ctx, async (child, remaining) => {
      const s=ledger();if(!s)return fail('no_confirmed_route');
      const unsafe=safety(child.signal,{returning:true});if(unsafe)return fail(unsafe);
      if(!Number.isInteger(s.routeIndex)||!actualAt(s.route[s.routeIndex]))return fail('off_confirmed_route');
      const nextIndex=s.routeIndex+(towards==='front'?1:-1);
      if(nextIndex<0 || nextIndex>=s.route.length)return{ok:true,progress:false,
        atActualShore:s.routeIndex===0&&actualAt(shore),atActualFront:s.routeIndex===s.route.length-1};
      if(s.used.totalEdges>=CAPS.totalEdges || s.used.knownEdges>=CAPS.knownEdges
        || (towards==='shore'&&s.used.returnEdges>=CAPS.returnEdges))return fail('known_edge_budget');
      if(!keepsReturnReserve(s,nextIndex,{known:true,returning:towards==='shore'}))return fail('return_reserve_required');
      const from=s.route[s.routeIndex],to=s.route[nextIndex];
      if(Math.abs(from.x-to.x)+Math.abs(from.z-to.z)!==1||Math.abs(from.y-to.y)>1||!standing(to)||!bounds(to))return fail('reverse_edge_no_longer_safe');
      const sweep=[from.offset(0,1,0),to,to.offset(0,1,0),...(to.y>from.y?[from.offset(0,2,0)]:[])];
      for(const p of sweep){
        if(!empty(read(p)))return fail('reverse_clearance_changed');
        for(const [dx,dy,dz]of[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
          const b=read(p.offset(dx,dy,dz));if(!b||DANGER.test(b.name)||GRAVITY.test(b.name))return fail('reverse_margin_changed');
        }
      }
      const moved=await moveEdge(child,s,from,to,remaining);if(!moved.ok)return moved;
      s.routeIndex=nextIndex;s.used.knownEdges++;s.used.totalEdges++;if(towards==='shore')s.used.returnEdges++;
      record(child,'actual_known_edge',{at:key(to),towards,routeIndex:nextIndex,used:{...s.used},newMovementCredit:false});
      return{ok:true,progress:false,atActualShore:nextIndex===0&&actualAt(shore),atActualFront:nextIndex===s.route.length-1};
    });
  }
  const returnOne=ctx=>walkKnownOne(ctx,{towards:'shore'});

  return { advance, returnOne, walkKnownOne, harvestAtFront, proposeDirections, memory, caps: CAPS,
    describe:()=>({anchorMode,noPortalReturnCredit,shore:key(shore),portal:portal?key(portal):null,boundRadius:96}) };
}

module.exports = { createExcavation, CAPS, full, empty };
