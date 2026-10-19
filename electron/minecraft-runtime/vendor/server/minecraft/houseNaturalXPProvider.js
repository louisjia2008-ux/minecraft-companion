/* global require, module, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask */
'use strict';
// Migrated from frozen natural-XP v2. Native movement, acquisition and exact
// owner callbacks are supplied by the host; no theoretical XP is credited.
const nodeRequire = require;
const { Vec3 } = nodeRequire('vec3');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['water', 'lava', 'fire', 'soul_fire', 'magma_block', 'bubble_column', 'powder_snow', 'cactus', 'campfire', 'soul_campfire']);
const frames = new WeakMap(), activations = new WeakMap(), cancelScopes = new WeakMap();
const plain = p => ({ x: p.x, y: p.y, z: p.z });
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
const same = (a, b) => integer(a) && integer(b) && ['x', 'y', 'z'].every(k => a[k] === b[k]);
const key = p => `${p.x},${p.y},${p.z}`;
const copy = v => JSON.parse(JSON.stringify(v));
const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
const props = b => b?.getProperties?.() || {};
function excluded(p, bounds) {
  return (bounds || []).some(b => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);
}
function dryBody(bot) {
  const e = bot.entity, p = e?.position;
  if (!p || e.isInWater !== false || e.isInLava !== false) return false;
  const half = (e.width || .6) / 2, height = e.height || 1.8;
  let support = false;
  for (let x = Math.floor(p.x - half); x <= Math.floor(p.x + half - 1e-7); x++) for (let z = Math.floor(p.z - half); z <= Math.floor(p.z + half - 1e-7); z++) {
    for (let y = Math.floor(p.y - .07); y <= Math.floor(p.y + height - 1e-7); y++) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b || HAZARDS.has(b.name) || props(b).waterlogged === true) return false;
      for (const s of b.shapes || []) {
        if (p.x + half <= x + s[0] || p.x - half >= x + s[3] || p.z + half <= z + s[2] || p.z - half >= z + s[5]) continue;
        const top = y + s[4];
        if (Math.abs(p.y - top) <= .075) support = true;
        if (top > p.y + .02 && y + s[1] < p.y + height - .02) return false;
      }
    }
  }
  return e.onGround === true ? support : true;
}
function cactusColumn(bot, raw, bounds = [], protectedFloor = () => false) {
  if (!integer(raw)) return null;
  const at = p => bot.blockAt(new Vec3(p.x, p.y, p.z));
  if (at(raw)?.name !== 'cactus') return null;
  let bottom = plain(raw), scanned = 0;
  while (at({ ...bottom, y: bottom.y - 1 })?.name === 'cactus' && scanned++ < 16) bottom.y--;
  if (scanned >= 16 || !['sand', 'red_sand'].includes(at({ ...bottom, y: bottom.y - 1 })?.name)) return null;
  const column = []; let p = plain(bottom);
  for (let n = 0; n < 16; n++, p.y++) {
    const b = at(p);
    if (!b) return null;
    if (b.name !== 'cactus') {
      if (!AIR.has(b.name)) return null;
      break;
    }
    if (excluded(p, bounds) || protectedFloor(p)) return null;
    column.push(plain(p));
  }
  if (column.length < 2 || column.length >= 16) return null;
  for (const target of column.slice(1)) for (const d of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]]) {
    const b=at({x:target.x+d[0],y:target.y+d[1],z:target.z+d[2]});
    if (!b || props(b).waterlogged === true || HAZARDS.has(b.name) && !(b.name==='cactus' && d[0]===0 && d[2]===0)) return null;
  }
  return { bottom, targets: column.slice(1).reverse() };
}
// Only one synchronous call of the exact captured installed stop function may
// pass status1 through parent source guards. This never authorizes status0/2.
function isOwnedXPNativeCancel(bot,name,packet) {
  const session=cancelScopes.get(bot?._client);
  return Boolean(name==='block_dig' && packet?.status===1 && session?.cancelling===true
    && session.bot===bot && session.client===bot._client && bot.targetDigBlock===session.block
    && bot.stopDigging===session.stopFunction && same(packet.location,session.block.position));
}
function createHouseNaturalXPProvider(deps, limits = {}) {
  const bot = deps.getBot(), client = bot?._client, Item = nodeRequire('prismarine-item')(bot.registry), Block = nodeRequire('prismarine-block')(bot.registry);
  if (!client?.write || typeof deps.assertActive !== 'function' || typeof deps.isOwnerContext !== 'function' || typeof deps.onOperationAbort !== 'function') throw new TypeError('XP provider needs actual bot, captured owner and owned native abort cleanup');
  const cfg = { batchSize: 8, maximumBatchMs: 180000, nativeMs: 10000, readbackMs: 5000, gatherMs: 180000,
    maxColumns: 32, maxExplorations: 8, maxNoProgress: 3, pollMs: 50, ...limits };
  for (const name of ['batchSize','maxColumns','maxExplorations','maxNoProgress']) if(!Number.isSafeInteger(cfg[name]) || cfg[name]<1 || cfg[name]>(name==='batchSize'?32:256)) throw new TypeError('XP provider finite count limit required: '+name);
  for (const name of ['maximumBatchMs','nativeMs','readbackMs','gatherMs','pollMs']) if(!Number.isSafeInteger(cfg[name]) || cfg[name]<1 || cfg[name]>43200000) throw new TypeError('XP provider finite time limit required: '+name);
  let state, closedReason = null, activeDigSession = null;
  const active = () => { if (closedReason) throw closedReason; deps.assertActive(); if (deps.getBot() !== bot) throw fail('house_xp_bot_changed', '原经验机器人已更换'); };
  const survival = () => { active(); if (!Number.isFinite(bot.health) || bot.health < 16 || !Number.isFinite(bot.food) || bot.food < 14) throw fail('house_xp_survival_limit', '经验采集生命或饱食不足'); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const count = name => bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0);
  const xp = () => {
    const x = bot.experience;
    if (!Number.isSafeInteger(x?.level) || x.level < 0 || !Number.isSafeInteger(x?.points) || x.points < 0 || !Number.isFinite(x?.progress) || x.progress < 0 || x.progress > 1) throw fail('house_xp_state_unconfirmed', '真实经验状态尚未完整');
    return { level: x.level, points: x.points, progress: x.progress };
  };
  const grew = (a, b) => b.level > a.level || b.points > a.points || b.level === a.level && b.progress > a.progress;
  function initialize(anchor) {
    active(); if (!integer(anchor)) throw fail('house_xp_invalid_anchor', '经验任务必须保留固定营地');
    const old = deps.getCP?.();
    if (old && (old.schema !== 1 || old.kind !== 'natural_house_xp_provider' || !same(old.anchor, anchor))) throw fail('house_xp_checkpoint_changed', '经验记录与原营地不符');
    state = old ? copy(old) : { schema: 1, kind: 'natural_house_xp_provider', anchor: plain(anchor), batches: [], cactusHarvests: [], noProgress: 0 };
    if (state.pendingBatch) throw fail('house_xp_reconciliation_required', '原生炉子批次可能已发生，必须先核对，不可重复投料或取出');
  }
  function save(patch) { active(); state = { ...state, ...copy(patch) }; deps.saveCP?.(copy(state)); }
  async function bounded(operation, label, ms, onAbort = () => {}) {
    active(); let timer, poll, abortNotified=false;
    const abort = e => { onAbort(); if(!abortNotified) { abortNotified=true; try { deps.onOperationAbort(e); } catch {} } };
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => { const e = fail('house_xp_timeout', `${label}未在有限时间内完成`); closedReason ||= e; abort(e); try { deps.onOperationTimeout?.(e); } catch {} reject(e); }, ms);
      poll = setInterval(() => { try { active(); } catch (e) { abort(e); reject(e); } }, cfg.pollMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => { active(); return operation(); }), stop]); }
    finally { clearTimeout(timer); clearInterval(poll); }
  }
  function native(operation, label, ms = cfg.nativeMs, beforeSend = () => {}) {
    const frame = { active: true, closed: false, previous: client.write }; let activation, rejectDetached, hadDig=false;
    const detached = new Promise((_, reject) => { rejectDetached = reject; });
    if (typeof bot.activateBlock === 'function') {
      activation = { active: true, previous: bot.activateBlock };
      activation.fn = function (...args) { const p = activation.previous.apply(this, args); if (activation.active && deps.isOwnerContext() === true) Promise.resolve(p).catch(rejectDetached); return p; };
      activations.set(activation.fn, activation); bot.activateBlock = activation.fn;
    }
    function write(name, packet, ...rest) {
      if(name==='block_dig'&&packet?.status===0&&deps.isOwnerContext()===true)hadDig=true;
      if (isOwnedXPNativeCancel(bot,name,packet)) return frame.previous.call(this,name,packet,...rest);
      if (frame.active && ['block_place', 'use_item', 'block_dig', 'window_click', 'close_window', 'held_item_slot'].includes(name) && deps.isOwnerContext() === true) {
        if (frame.closed) throw fail('house_xp_native_closed', '原生经验动作已关闭，拒绝迟发交互'); active(); beforeSend();
      }
      return frame.previous.call(this, name, packet, ...rest);
    }
    client.write = write; frames.set(write, frame);
    const cleanup = () => {
      frame.active = false;
      if (activation) { activation.active = false; if (bot.activateBlock === activation.fn) { let p = activation.previous; while (activations.get(p)?.active === false) p = activations.get(p).previous; bot.activateBlock = p; } }
      if (client.write === write) { let p = frame.previous; while (frames.get(p)?.active === false) p = frames.get(p).previous; client.write = p; }
    };
    const pending = Promise.resolve().then(() => { active(); return operation(); }); pending.then(cleanup, cleanup);
    return bounded(() => Promise.race([pending, detached]), label, ms, () => { frame.closed = true; }).catch(async e => { frame.closed = true;const dig=activeDigSession;if(dig)await settleDig(dig,e);if(dig||hadDig)await waitNativeSettlement(pending,e);throw e; });
  }
  async function wait(predicate, code, label, ms = cfg.readbackMs) {
    const end = Date.now() + ms;
    for (;;) { active(); if (predicate()) return; if (Date.now() >= end) throw fail(code, label); await sleep(cfg.pollMs); }
  }
  async function food() { active(); await bounded(() => deps.ensureFood?.(), '经验任务口粮保护', cfg.nativeMs); survival(); }
  async function camp(anchor) {
    active(); if (typeof deps.returnCamp !== 'function') throw fail('house_xp_provider_pending', '原路返营接口尚未接入');
    await native(() => deps.returnCamp(anchor), '经验采集原路返营', cfg.nativeMs); survival();
    if (!same(bot.entity.position.floored(), anchor) || bot.entity.onGround !== true || !dryBody(bot)) throw fail('house_xp_camp_unconfirmed', '没有在固定营地真实落稳');
  }

  async function waitNativeSettlement(pending,error) {
    let timer;const done=await Promise.race([pending.then(()=>true,()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000)})]);clearTimeout(timer);
    if(!done)throw fail('house_xp_native_cleanup_pending','原生调用链尚未确认结束，保留旧守卫并停止',{nativeSettlement:'UNKNOWN',cause:{code:error.code||null,message:error.message}});
  }
  async function settleDig(session,error) {
    session.error ||= error; session.stopOwn();
    if(session.settlement)return session.settlement;
    session.settlement=(async()=>{
      let timer;const pending=session.nativePromise||session.operationPromise;
      if(!pending)return;
      const done=await Promise.race([pending.then(()=>true,()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000)})]);clearTimeout(timer);
      if(!done){
        const unknown=fail('house_xp_native_cleanup_pending','原生仙人掌挖掘尚未确认结束，保留旧session守卫并停止',{nativeSettlement:'UNKNOWN',cause:{code:session.error.code||null,message:session.error.message},cleanupError:session.cleanupError||null});
        try{deps.onOperationTimeout?.(unknown)}catch{};
        throw unknown;
      }
    })();
    return session.settlement;
  }
  async function digCactusNative(block,check) {
    active();check();
    if(deps.sourceGuardSupportsOwnedCancel!==true)throw fail('house_xp_cancel_guard_pending','外层source guard必须先接通本模块精确status1取消许可');
    if(activeDigSession||bot.targetDigBlock)throw fail('house_xp_native_busy','不能抢占已有原生挖掘');
    const session={bot,client,block,started:false,settled:false,cancelling:false,stopFunction:null,error:null,cancelAttempted:false,cleanupError:null,nativePromise:null,operationPromise:null};
    activeDigSession=session;let monitor,disposed=false;
    const writerFrame={active:true,previous:client.write},digFrame={active:true,previous:bot.dig};
    const captureStop=()=>{if(session.started&&bot.targetDigBlock===block&&!session.stopFunction)session.stopFunction=bot.stopDigging;};
    session.stopOwn=()=>{
      captureStop();
      if(session.cancelAttempted||deps.getBot()!==bot||bot._client!==client||bot.targetDigBlock!==block||!session.stopFunction||bot.stopDigging!==session.stopFunction)return false;
      session.cancelAttempted=true;session.cancelling=true;cancelScopes.set(client,session);
      try{session.stopFunction.call(bot);return true}catch(e){session.cleanupError={code:e.code||null,message:e.message};return false}
      finally{session.cancelling=false;if(cancelScopes.get(client)===session)cancelScopes.delete(client)}
    };
    const dispose=()=>{
      if(disposed)return;disposed=true;clearInterval(monitor);writerFrame.active=false;digFrame.active=false;
      if(client.write===write){let p=writerFrame.previous;while(frames.get(p)?.active===false)p=frames.get(p).previous;client.write=p;}
      if(bot.dig===dig){let p=digFrame.previous;while(frames.get(p)?.active===false)p=frames.get(p).previous;bot.dig=p;}
      if(activeDigSession===session)activeDigSession=null;
    };
    function write(name,packet,...rest){
      if(!writerFrame.active||deps.isOwnerContext()!==true||name!=='block_dig'||!same(packet?.location,block.position))return writerFrame.previous.call(this,name,packet,...rest);
      if(isOwnedXPNativeCancel(bot,name,packet))return writerFrame.previous.call(this,name,packet,...rest);
      try{active();check()}catch(e){session.error ||= e;if(packet.status===2){session.stopOwn();return;}throw e;}
      let value;try{value=writerFrame.previous.call(this,name,packet,...rest)}catch(e){session.error ||= e;if(packet.status===2){session.stopOwn();return;}throw e;}
      if(packet.status===0){session.started=true;queueMicrotask(captureStop)}return value;
    }
    function dig(...args){
      const result=digFrame.previous.apply(this,args);
      if(digFrame.active&&deps.isOwnerContext()===true&&args[0]===block){
        session.nativePromise=Promise.resolve(result);session.nativePromise.then(()=>{session.settled=true;dispose()},()=>{session.settled=true;dispose()});
      }
      return result;
    }
    frames.set(write,writerFrame);frames.set(dig,digFrame);client.write=write;bot.dig=dig;
    monitor=setInterval(()=>{try{active();check();captureStop()}catch(e){session.error ||= e;session.stopOwn()}},10);
    session.operationPromise=Promise.resolve().then(()=>{active();check();return deps.nativeDig(block)});
    try{const value=await session.operationPromise;if(session.error)throw session.error;active();check();return value}
    catch(e){session.error ||= e;await settleDig(session,e);throw session.error}
    finally{if(session.settled||!session.nativePromise)dispose();else session.nativePromise.then(dispose,dispose)}
  }

  function watchDry(operation) {
    let fault = null, ticks = 0, lastGround = null;
    const inspect = () => {
      try {
        survival(); const e = bot.entity;
        if (!dryBody(bot)) throw fail('house_xp_unsafe_body', '仙人掌采集身体触碰危险、未知或失去真实支撑');
        if (e.onGround === true) lastGround = { position: plain(e.position), tick: ticks };
        else if (!lastGround || ticks - lastGround.tick > 16 || Math.hypot(e.position.x - lastGround.position.x, e.position.z - lastGround.position.z) > 1.75
          || !['x', 'y', 'z'].every(k => Number.isFinite(e.velocity?.[k])) || e.velocity.y < -.9 || e.velocity.y > .43) throw fail('house_xp_unsafe_airborne', '仙人掌采集离开近期真实干地支撑');
      } catch (e) { if (!fault) { fault = e; closedReason ||= e; try { deps.onOperationAbort(e); deps.onUnsafeMovement?.(e); } catch {} } }
    };
    inspect(); if (fault) return Promise.reject(fault);
    const listener = () => { ticks++; inspect(); }; bot.on('physicsTick', listener);
    return native(async () => { try { await operation(() => { active(); if (fault) throw fault; }); } catch (e) { if (fault) throw fault; throw e; } if (fault) throw fault; }, '仙人掌原生安全动作', cfg.nativeMs, () => { if (fault) throw fault; })
      .finally(() => bot.removeListener('physicsTick', listener));
  }
  async function gatherCactusImpl(additionalCount, { anchor, excludeBounds = [] } = {}) {
    initialize(anchor); if (!Number.isInteger(additionalCount) || additionalCount < 1 || additionalCount > 32) throw fail('house_xp_invalid_batch', '仙人掌每批只能1到32件');
    await food(); const before = count('cactus'), goal = before + additionalCount, end = Date.now() + cfg.gatherMs;
    const capacity = bot.inventory.slots.slice(9,45).reduce((n,i) => n + (!i ? 64 : i.name === 'cactus' ? 64-i.count : 0), 0);
    if (capacity < additionalCount) throw fail('house_xp_inventory_full', '采集仙人掌前必须先由自建仓库保留工具和口粮并腾出容量');
    if (typeof deps.reachDry !== 'function' || typeof deps.nativeDig !== 'function' || typeof deps.collectDrops !== 'function') throw fail('house_xp_cactus_provider_pending', '仙人掌安全靠近、原生挖掘或拾取接口尚未接入');
    const seen = new Set(); let columns = 0, explored = 0;
    while (count('cactus') < goal && Date.now() < end && columns < cfg.maxColumns) {
      await food(); active();
      const candidates = typeof deps.findCactus === 'function' ? await deps.findCactus(96, 64)
        : bot.findBlocks({ matching: bot.registry.blocksByName.cactus.id, maxDistance: 96, count: 64 });
      active(); let progressed = false;
      for (const candidate of candidates || []) {
        const column = cactusColumn(bot, candidate.position || candidate, excludeBounds, deps.isProtectedPosition);
        if (!column || seen.has(key(column.bottom))) continue;
        seen.add(key(column.bottom)); columns++;
        for (const p of column.targets) {
          if (count('cactus') >= goal) break;
          await food(); active();
          let digBefore;
          await watchDry(async check => {
            await deps.reachDry(p, { range: 1.5, cactusBottom: column.bottom, excludeBounds, canDig: false }); check();
            const e = bot.entity, distance = Math.hypot(e.position.x - p.x - .5, e.position.z - p.z - .5);
            if (e.onGround !== true || !dryBody(bot) || distance > 1.5) throw fail('house_xp_cactus_stance', '必须先到达仙人掌旁的干燥安全拾取站位');
            const current = cactusColumn(bot, p, excludeBounds, deps.isProtectedPosition), block = bot.blockAt(new Vec3(p.x, p.y, p.z));
            if (!current || !same(current.bottom, column.bottom) || !same(current.targets[0], p) || block?.name !== 'cactus'
              || bot.entity.position.offset(0,bot.entity.eyeHeight||1.62,0).distanceTo(block.position.offset(.5,.5,.5))>4.5 || typeof bot.canDigBlock !== 'function' || !bot.canDigBlock(block) || typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(block)) throw fail('house_xp_cactus_changed', '天然仙人掌顶节、视线或保护范围改变');
            digBefore = count('cactus'); let airAck = false, dropAck = false;
            const airUpdate = (position, id) => { if (same(plain(position),p) && AIR.has(Block.fromStateId(id).name)) airAck = true; };
            const onBlock = packet => airUpdate(packet.location, packet.type);
            const onMulti = packet => { for (const record of packet.records || []) {
              const single = bot.supportFeature('usesMultiblockSingleLong'), base = bot.supportFeature('usesMultiblock3DChunkCoords') ? packet.chunkCoordinates : {x:packet.chunkX,y:0,z:packet.chunkZ};
              const x = single ? (record >> 8) & 15 : (record.horizontalPos >> 4) & 15, z = single ? (record >> 4) & 15 : record.horizontalPos & 15, y = single ? record & 15 : record.y;
              airUpdate({x:base.x*16+x,y:base.y*16+y,z:base.z*16+z},single ? record >> 12 : record.blockId);
            } };
            const onPickup = packet => { if(packet.windowId === 0 && count('cactus') > digBefore) dropAck = true; };
            client.on('block_change',onBlock); client.on('multi_block_change',onMulti); client.on('set_slot',onPickup); client.on('window_items',onPickup);
            try {
              await digCactusNative(block,check); check();
              await wait(() => airAck && AIR.has(bot.blockAt(new Vec3(p.x, p.y, p.z))?.name), 'house_xp_cactus_dig_unconfirmed', '仙人掌顶节没有服务端实际挖空确认'); check();
              await deps.collectDrops({ position: p, items: ['cactus'], radius: 1.5, allowMovement: false, timeoutMs: 4500 }); check();
              await wait(() => dropAck && count('cactus') > digBefore, 'house_xp_cactus_pickup_unconfirmed', '未真实拾取仙人掌，掉落可能被底节销毁'); check();
            } finally { client.removeListener('block_change',onBlock); client.removeListener('multi_block_change',onMulti); client.removeListener('set_slot',onPickup); client.removeListener('window_items',onPickup); }
            if (bot.blockAt(new Vec3(column.bottom.x, column.bottom.y, column.bottom.z))?.name !== 'cactus') throw fail('house_xp_cactus_bottom_changed', '不能破坏仙人掌底节');
          });
          active(); progressed = true; save({ cactusHarvests: [...state.cactusHarvests, { position: p, bottom: column.bottom, before: digBefore, after: count('cactus') }] });
        }
        if (count('cactus') >= goal || columns >= cfg.maxColumns) break;
      }
      if (count('cactus') >= goal) break;
      if (!deps.nextExploration || explored++ >= cfg.maxExplorations) break;
      const out = await native(() => deps.nextExploration({ anchor, resource: 'cactus', excludeBounds }), '寻找天然仙人掌', cfg.nativeMs);
      active(); if (!out || out.moved === false && out.exhausted !== false || out === false) break;
      if (!progressed && Date.now() >= end) break;
    }
    active(); await camp(anchor);
    if (count('cactus') < goal) throw fail('house_xp_cactus_unavailable', '有限真实搜索没有采齐仙人掌，保留底节和已有物资', { collected: count('cactus') - before, requested: additionalCount });
    return { confirmed: true, item: 'cactus', collected: count('cactus') - before, before, after: count('cactus'), columns, explored };
  }
  async function earnBatch({ anchor, targetLevel = 30, maxDurationMs = cfg.maximumBatchMs, provider = 'auto', excludeBounds = [] } = {}) {
    initialize(anchor); survival(); if(!Number.isInteger(targetLevel)||targetLevel<1||targetLevel>30)throw fail('house_xp_invalid_target','自然经验候选仅支持1到30级'); if ((state.noProgress || 0) >= cfg.maxNoProgress) throw fail('house_xp_no_progress', '连续真实批次没有经验增长，停止重复');
    if (!['auto', 'cactus', 'coal'].includes(provider)) throw fail('house_xp_invalid_provider', '未知自然经验来源');
    const before = xp(), packets = []; let xpSequence=0; const onXP = packet => { try { const actual=xp();xpSequence++;packets.push({sequence:xpSequence,packet:copy(packet),actual});if(packets.length>32)packets.shift(); } catch { /* Invalid native XP cannot satisfy progress. */ } };
    client.on('experience', onXP);
    const started = Date.now(), duration = Math.min(maxDurationMs, cfg.maximumBatchMs);
    if (!Number.isFinite(duration) || duration < 1) { client.removeListener('experience', onXP); throw fail('house_xp_invalid_batch', '经验批次需要有限时限'); }
    const confirmed = () => packets.some(p => grew(before, p.actual)) && grew(before, xp());
    const finish = async (source, details) => {
      active(); await camp(anchor); active();
      if (!confirmed()) throw fail('house_xp_no_progress', '没有观察到真实经验包增长');
      const result = { confirmed: true, source, before, after: xp(), packets, xpPacketsObserved:xpSequence, ...details };
      save({ pendingBatch: null, noProgress: 0, batches: [...state.batches, result] }); return result;
    };
    try {
      await food();
      if (provider !== 'coal') {
        try { if (count('cactus') < cfg.batchSize) await gatherCactus(cfg.batchSize - count('cactus'), { anchor, excludeBounds }); }
        catch (e) { active(); if (provider === 'cactus' || !['house_xp_cactus_unavailable', 'house_xp_cactus_provider_pending'].includes(e.code)) throw e; }
        if (count('cactus') > 0) {
          if (typeof deps.ensureStation !== 'function' || typeof deps.ownedFurnace !== 'function' || typeof deps.ensureMaterials !== 'function') throw fail('house_xp_furnace_provider_pending', '自建熔炉、燃料来源或归属接口尚未接入');
          await bounded(() => deps.ensureStation('furnace'), '准备自建熔炉', duration);
          const fuelName = deps.fuelName || 'oak_planks', inputCount = Math.min(cfg.batchSize, count('cactus'));
          if (!fuelName.endsWith('_planks')) throw fail('house_xp_invalid_fuel', '单炉候选仅接受自然木板燃料');
          await bounded(() => deps.ensureMaterials({ [fuelName]: Math.ceil(inputCount / 1.5) }, { preserve: { cactus: inputCount }, stage: 'earn_xp' }), '真实采集或合成燃料', duration); survival();
          if (confirmed() && xp().level >= targetLevel) return await finish('natural_material_preparation', {});
          const owned = await deps.ownedFurnace(); active();
          if (!owned?.confirmedOwned || !integer(owned.position) || bot.blockAt(new Vec3(owned.position.x, owned.position.y, owned.position.z))?.name !== 'furnace') throw fail('house_xp_foreign_furnace', '不能采用未归属或替换的熔炉');
          await native(() => deps.reachDry(owned.position, { action: 'open_furnace', range: 4.5 }), '靠近自建经验熔炉'); survival();
          if (bot.entity.onGround !== true || !dryBody(bot) || bot.entity.position.offset(0,bot.entity.eyeHeight||1.62,0).distanceTo(new Vec3(owned.position.x+.5,owned.position.y+.5,owned.position.z+.5))>4.5) throw fail('house_xp_furnace_unsafe_stance','经验炉交互没有实际落稳干燥近身站位');
          const windowPackets = new Map(), serverSlots = new Map(); let window;
          const apply = packet => { for (let i = 0; i < packet.items.length; i++) serverSlots.set(i, Item.fromNotch(packet.items[i])); };
          const onItems = packet => { if (window && packet.windowId === window.id) apply(packet); else windowPackets.set(packet.windowId, packet); };
          const onSlot = packet => { if (window && packet.windowId === window.id) serverSlots.set(packet.slot, Item.fromNotch(packet.item)); };
          const playerCount = name => [...serverSlots].reduce((n, [slot, item]) => n + (slot >= window.inventoryStart && slot < window.inventoryEnd && item?.name === name ? item.count : 0), 0);
          client.on('window_items', onItems); client.on('set_slot', onSlot);
          try {
            window = await native(() => bot.openFurnace(bot.blockAt(new Vec3(owned.position.x, owned.position.y, owned.position.z))), '打开自建经验熔炉'); active();
            if (windowPackets.has(window.id)) apply(windowPackets.get(window.id));
            if (bot.currentWindow !== window || window.type !== 'minecraft:furnace' || serverSlots.size !== window.slots.length) throw fail('house_xp_furnace_snapshot_unconfirmed', '没有完整真实熔炉窗口快照');
            if ([0, 2].some(slot => serverSlots.get(slot))) throw fail('house_xp_furnace_not_empty', '经验熔炉有未归属或未核对材料，保留内容');
            const remainingFuel=serverSlots.get(1), fuelFact=state.furnaceFuel;
            if (fuelFact && (!same(fuelFact.position,owned.position) || fuelFact.name!==(remainingFuel?.name||null) || fuelFact.count!==(remainingFuel?.count||0)) || remainingFuel && (!fuelFact || remainingFuel.name!==fuelName)) throw fail('house_xp_furnace_not_empty','经验炉燃料不是原批次真实保存的归属余料');
            const beforeGreen = playerCount('green_dye'), beforeCactus = playerCount('cactus'), beforeFuel = playerCount(fuelName), fuelCount = Math.max(0,Math.ceil(inputCount / 1.5)-(remainingFuel?.count||0));
            if (beforeCactus < inputCount || beforeFuel < fuelCount) throw fail('house_xp_materials_missing', '真实窗口缺少仙人掌或木板燃料', {beforeCactus,beforeFuel,inputCount,fuelCount});
            save({ pendingBatch: { position: owned.position, inputCount, fuelName, fuelCount, before, stage: 'input_requested' } });
            await native(() => window.putInput(bot.registry.itemsByName.cactus.id, null, inputCount), '放入真实仙人掌');
            await wait(() => serverSlots.get(0)?.name === 'cactus' && serverSlots.get(0).count === inputCount && playerCount('cactus') === beforeCactus - inputCount, 'house_xp_input_unconfirmed', '没有真实投料窗口ACK');
            if(fuelCount)await native(() => window.putFuel(bot.registry.itemsByName[fuelName].id, null, fuelCount), '放入真实木板燃料');
            const end = Math.min(started + duration, Date.now() + inputCount * 12000 + 15000);
            await wait(() => serverSlots.get(2)?.name === 'green_dye' && serverSlots.get(2).count === inputCount && !serverSlots.get(0), 'house_xp_smelt_unconfirmed', '有限单炉批次未实际完成仙人掌冶炼', Math.max(1, end - Date.now()));
            const extractBefore = xp(), extractSequence = xpSequence;
            await native(() => window.takeOutput(), '真实取出绿色染料');
            await wait(() => !serverSlots.get(2) && playerCount('green_dye') === beforeGreen + inputCount, 'house_xp_output_unconfirmed', '取出产物没有真实服务端窗口ACK');
            await wait(() => xpSequence>extractSequence && packets.some(p => p.sequence>extractSequence && grew(extractBefore,p.actual)) && grew(extractBefore, xp()), 'house_xp_no_progress', '真实取出产物后没有经验包增长');
            const fuelAfter=serverSlots.get(1);save({furnaceFuel:{position:plain(owned.position),name:fuelAfter?.name||null,count:fuelAfter?.count||0}});
            await native(() => window.close(), '关闭经验炉窗口'); window = null;
            await wait(() => count('green_dye') === beforeGreen + inputCount, 'house_xp_closed_inventory_unconfirmed', '关闭炉子后背包没有真实产物');
            return await finish('owned_single_furnace_cactus', { position: owned.position, inputCount, greenDyeBefore: beforeGreen, greenDyeAfter: count('green_dye') });
          } finally {
            client.removeListener('window_items', onItems); client.removeListener('set_slot', onSlot);
            if (window) { try { active(); await native(() => window.close(), '关闭未完成的自建炉窗口'); } catch { /* No write after cancel/timeout; host owns cleanup. */ } }
          }
        }
      }
      if (typeof deps.gatherCoal !== 'function') throw fail('house_xp_provider_pending', '有限仙人掌搜索后没有可用自然煤矿经验接口');
      save({ pendingBatch: { source: 'coal', before, stage: 'native_quarry_requested' } });
      const coalBefore = count('coal');
      await bounded(() => deps.gatherCoal(cfg.batchSize, { anchor, excludeBounds, maxDurationMs: Math.max(1, started + duration - Date.now()) }), '原生自然煤矿经验批次', Math.max(1, started + duration - Date.now())); survival();
      await wait(() => count('coal') > coalBefore, 'house_xp_coal_unconfirmed', '原生采煤返回后没有实际煤炭背包增长');
      await wait(confirmed, 'house_xp_no_progress', '煤矿批次返回后没有实际经验包增长');
      return await finish('native_coal_quarry', {coalBefore,coalAfter:count('coal')});
    } catch (e) {
      active(); if (e.code === 'house_xp_no_progress') save({ pendingBatch: state.pendingBatch, noProgress: (state.noProgress || 0) + 1, lastNoProgress: { before, after: xp(), packets } });
      throw e;
    } finally { client.removeListener('experience', onXP); }
  }
  function gatherCactus(additionalCount,options = {}) {
    return native(() => gatherCactusImpl(additionalCount,options),'有限天然仙人掌采集',cfg.gatherMs+cfg.nativeMs);
  }
  function earnXPBatch(options = {}) {
    const duration = Math.min(options.maxDurationMs ?? cfg.maximumBatchMs, cfg.maximumBatchMs);
    if (!Number.isFinite(duration) || duration < 1) return Promise.reject(fail('house_xp_invalid_batch', '经验批次需要有限时限'));
    return native(() => earnBatch(options), '自然经验原生总批次', duration);
  }
  return { gatherCactus, earnXPBatch, getState: () => state && copy(state) };
}
module.exports = { createHouseNaturalXPProvider, cactusColumn, dryBody, isOwnedXPNativeCancel };
