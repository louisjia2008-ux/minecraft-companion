'use strict';
// PRIVATE candidate only. Host must supply native XP earning/material providers;
// no recipe XP arithmetic, account state, coordinates, world or movement writes.
const root=require('node:path').join(__dirname,'../electron/minecraft-runtime/node_modules/');
const {Vec3}=require(root+'vec3');
const ItemFactory=require(root+'prismarine-item');
const copy=value=>JSON.parse(JSON.stringify(value));
const point=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
const same=(a,b)=>point(a)&&point(b)&&['x','y','z'].every(k=>a[k]===b[k]);
const error=(code,message,facts={})=>Object.assign(new Error(message),{code,...facts});
const frames=new WeakMap(), activationFrames=new WeakMap();
function enchantmentFacts(item){
  if(!item)return [];
  const component=item.components?.find(c=>c.type==='enchantments');
  if(component)return (component.data?.enchantments||[]).filter(e=>Number.isInteger(e.id)&&e.id>=0&&Number.isInteger(e.level)&&e.level>0).map(e=>({id:e.id,level:e.level,encoding:'component'}));
  try{return (Array.isArray(item.enchants)?item.enchants:[]).filter(e=>e.name&&Number.isInteger(e.lvl)&&e.lvl>0).map(e=>({name:e.name,level:e.lvl,encoding:'nbt'}));}catch{return [];}
}
function createHouseNaturalEnchant(deps,limits={}){
  const bot=deps.getBot(),client=bot._client,Item=ItemFactory(bot.registry);
  const cfg={maxBatches:256,maxNoProgress:3,totalTimeoutMs:1200000,readbackMs:4000,nativeTimeoutMs:8000,materialsTimeoutMs:300000,xpBatchTimeoutMs:180000,campTimeoutMs:180000,pollMs:25,...limits};
  if(typeof deps.assertActive!=='function'||typeof deps.isOwnerContext!=='function'||!client?.write)throw new TypeError('Natural enchant candidate needs captured owner and native bot writer');
  const active=()=>{deps.assertActive();if(deps.getBot()!==bot)throw error('house_enchant_bot_changed','原附魔机器人连接已改变');};
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const xp=()=>{
    const value=bot.experience;
    if(!Number.isSafeInteger(value?.level)||value.level<0||!Number.isSafeInteger(value?.points)||value.points<0||!Number.isFinite(value?.progress)||value.progress<0||value.progress>1)throw error('house_xp_unconfirmed','尚未收到完整真实经验状态');
    return {level:value.level,points:value.points,progress:value.progress};
  };
  const healthy=()=>{active();if(!Number.isFinite(bot.health)||bot.health<16||!Number.isFinite(bot.food)||bot.food<14)throw error('house_xp_survival_limit','自然经验阶段生命或饱食不足，停止本轮');};
  let state;
  function initialize(anchor){
    active();if(!point(anchor))throw error('house_enchant_invalid_anchor','必须保留固定真实营地坐标');
    const prior=deps.getCP?.();
    if(prior&&(prior.schema!==1||prior.kind!=='natural_house_xp_enchant'||!same(prior.anchor,anchor)))throw error('house_enchant_checkpoint_changed','不能改变原经验任务或营地');
    state=prior?copy(prior):{schema:1,kind:'natural_house_xp_enchant',anchor:copy(anchor),xpBatches:[],phase:'initialized'};
  }
  const save=patch=>{active();state={...state,...copy(patch)};deps.saveCP?.(copy(state));};
  async function bounded(operation,label,timeout=cfg.nativeTimeoutMs,{onAbort}={}){
    active();let timer,interval;
    const control=new Promise((_,reject)=>{
      timer=setTimeout(()=>{const failure=error('house_enchant_timeout',`${label}没有在有限时间内确认`);onAbort?.(failure);try{deps.onOperationTimeout?.(failure);}catch{}reject(failure);},timeout);
      interval=setInterval(()=>{try{active();}catch(e){onAbort?.(e);reject(e);}},cfg.pollMs);
    });
    try{return await Promise.race([Promise.resolve().then(operation),control]);}finally{clearTimeout(timer);clearInterval(interval);}
  }
  async function waitFor(predicate,code,message,timeout=cfg.readbackMs){
    const deadline=Date.now()+timeout;
    for(;;){active();if(predicate())return;if(Date.now()>=deadline)throw error(code,message);await sleep(cfg.pollMs);}
  }
  function native(operation,{windowId,table,beforeSend}={}){
    // Keep this owner guard attached until the *underlying* native primitive
    // settles, even if bounded() already returned a pause/timeout. Native
    // enchant() may await ready before its actual enchant_item write.
    const frame={active:true,closed:false,previous:client.write};
    let rejectDetached,activationFrame,observeActivation;
    const detachedFailure=new Promise((_,reject)=>{rejectDetached=reject;});
    if(table&&windowId===undefined&&typeof bot.activateBlock==='function'){
      activationFrame={active:true,previous:bot.activateBlock};
      observeActivation=function(...args){
        const result=activationFrame.previous.apply(this,args);
        // Installed inventory.openBlock does not await activateBlock(). Attach
        // an observer to its original promise so a blocked deferred native
        // packet is handled and propagated, rather than becoming unhandled.
        if(activationFrame.active&&deps.isOwnerContext()===true&&same(args[0]?.position,table))Promise.resolve(result).catch(rejectDetached);
        return result;
      };
      activationFrames.set(observeActivation,activationFrame);bot.activateBlock=observeActivation;
    }
    function write(name,payload,...rest){
      const ownedWindow=payload?.windowId===windowId&&['window_click','enchant_item','close_window'].includes(name);
      const ownedTable=name==='block_place'&&same(payload?.location,table);
      if(frame.active&&(ownedWindow||ownedTable)&&deps.isOwnerContext()===true){if(frame.closed)throw error('house_enchant_native_closed','本次原生动作已超时或中断，禁止迟发交互');active();beforeSend?.(name,payload);}
      return frame.previous.call(this,name,payload,...rest);
    }
    frames.set(write,frame);client.write=write;
    const cleanup=()=>{
      frame.active=false;
      if(activationFrame){
        activationFrame.active=false;
        if(bot.activateBlock===observeActivation){let previous=activationFrame.previous;while(activationFrames.get(previous)?.active===false)previous=activationFrames.get(previous).previous;bot.activateBlock=previous;}
      }
      if(client.write===write){let previous=frame.previous;while(frames.get(previous)?.active===false)previous=frames.get(previous).previous;client.write=previous;}
    };
    const operationPromise=Promise.resolve().then(()=>{active();return operation();});
    operationPromise.then(cleanup,cleanup);
    return bounded(()=>Promise.race([operationPromise,detachedFailure]),'原生附魔交互',cfg.nativeTimeoutMs,{onAbort:()=>{frame.closed=true;}}).catch(error=>{frame.closed=true;throw error;});
  }
  async function returnCamp(anchor){
    active();await bounded(()=>deps.returncamp(anchor),'原路返回固定营地',cfg.campTimeoutMs);active();
    if(!same(bot.entity?.position?.floored?.(),anchor)||bot.entity.onGround!==true)throw error('house_enchant_camp_unconfirmed','没有在原营地真实落稳');
  }
  async function ensureLevels(target=30,{anchor}={}){
    if(!Number.isInteger(target)||target<1||target>30)throw error('house_xp_invalid_target','本候选仅支持1到30级有限经验目标');
    initialize(anchor);healthy();const started=Date.now();let noProgress=Number(state.xpNoProgress)||0;
    if(state.enchantPending)throw error('house_enchant_reconciliation_required','待核对的原生附魔尚未闭合，不能新增经验动作');
    if(xp().level>=target){await returnCamp(anchor);save({phase:'levels_confirmed',levelEvidence:xp()});return {confirmed:true,targetLevel:target,actual:xp(),earnedBatches:0};}
    if(typeof deps.earnXPBatch!=='function')throw error('house_xp_provider_pending','自然采矿或自建炉经验获取接口尚未接入');
    for(let batch=Number(state.xpAttempts)||0;batch<cfg.maxBatches;batch++){
      healthy();if(Date.now()-started>=cfg.totalTimeoutMs)throw error('house_xp_limit','自然经验获取达到本轮有限时间上限');
      const beforePreparation=xp();
      const preparation=await bounded(()=>deps.ensureMaterials?.({stage:'earn_xp',targetLevel:target,anchor:copy(anchor),batch}),'准备真实经验资源',Math.min(cfg.materialsTimeoutMs,cfg.totalTimeoutMs-(Date.now()-started)));healthy();
      if(preparation?.pending)throw error('house_xp_provider_pending',preparation.reason||'自然经验原料采集链尚未接入');
      if(xp().level>=target){await returnCamp(anchor);save({phase:'levels_confirmed',levelEvidence:xp(),preparationEvidence:{before:beforePreparation,after:xp()}});return {confirmed:true,targetLevel:target,actual:xp(),earnedBatches:0};}
      const before=xp();
      save({phase:'earning_xp',xpAttempts:batch+1,pendingBatch:{batch,before}});
      const outcome=await bounded(()=>deps.earnXPBatch({targetLevel:target,anchor:copy(anchor),batch,maxDurationMs:Math.min(cfg.xpBatchTimeoutMs,cfg.totalTimeoutMs-(Date.now()-started))}),'真实经验采集批次',Math.min(cfg.xpBatchTimeoutMs,cfg.totalTimeoutMs-(Date.now()-started)));healthy();
      if(outcome?.pending)throw error('house_xp_provider_pending',outcome.reason||'自然经验采集链尚未接入');
      try{await waitFor(()=>xp().level>before.level||xp().points>before.points,'house_xp_no_progress','原生批次后没有观察到真实经验增长');}
      catch(e){active();if(e.code!=='house_xp_no_progress')throw e;noProgress++;save({phase:'xp_no_progress',xpNoProgress:noProgress,pendingBatch:null,lastNoProgress:{batch,before,after:xp(),reason:outcome?.reason||null}});if(noProgress>=cfg.maxNoProgress)throw error('house_xp_no_progress','连续原生批次没有真实经验增长，保留已取得物资');continue;}
      const after=xp();noProgress=0;save({phase:'xp_batch_confirmed',xpNoProgress:0,pendingBatch:null,xpBatches:[...state.xpBatches,{batch,before,after}]});
      await returnCamp(anchor);healthy();
      if(xp().level>=target){save({phase:'levels_confirmed',levelEvidence:xp()});return {confirmed:true,targetLevel:target,actual:xp(),earnedBatches:batch+1};}
    }
    throw error('house_xp_limit','自然经验批次数达到有限上限，尚未取得目标等级');
  }
  async function enchant30({anchor,itemName='diamond_sword',table:requested}={}){
    initialize(anchor);healthy();
    if(state.enchantPending)throw error('house_enchant_reconciliation_required','原生附魔可能已发生，请先对原窗口和物品完成归属核对，禁止重放');
    if(xp().level<30)throw error('house_enchant_insufficient_levels','真实经验未到30级');
    if(!bot.registry.itemsByName[itemName])throw error('house_enchant_invalid_item','附魔目标物品未注册');
    const ownership=await bounded(()=>deps.ownedEnchantmentTable(),'读取本任务自建附魔台');active();
    const table=ownership?.position;
    if(!ownership?.confirmedOwned||!point(table)||requested&&!same(requested,table)||bot.blockAt(new Vec3(table.x,table.y,table.z))?.name!=='enchanting_table')throw error('house_enchant_wrong_owned_table','不能采用未归属、替换或不同坐标的附魔台');
    const prepared=await bounded(()=>deps.ensureMaterials?.({stage:'enchant30',requirements:{[itemName]:1,lapis_lazuli:3},anchor:copy(anchor)}),'准备原生附魔物品',cfg.materialsTimeoutMs);healthy();
    if(prepared?.pending)throw error('house_enchant_materials_pending',prepared.reason||'自然附魔材料链尚未接入');
    if(!bot.inventory.items().some(i=>i.name===itemName&&!enchantmentFacts(i).length)||bot.inventory.items().filter(i=>i.name==='lapis_lazuli').reduce((n,i)=>n+i.count,0)<3)throw error('house_enchant_materials_missing','背包缺少未附魔目标或至少3颗青金石');
    const beforePlayerLapis=bot.inventory.items().filter(i=>i.name==='lapis_lazuli').reduce((n,i)=>n+i.count,0);
    await bounded(()=>deps.reach(table),'前往自建附魔台');healthy();
    let window;
    const server={slots:new Map(),playerSlots:new Map(),initialItems:new Map(),xpEvents:0};
    const serverPlayerCount=name=>[...server.playerSlots.values()].filter(i=>i?.name===name).reduce((n,i)=>n+i.count,0);
    const serverHasOutput=()=>[...server.playerSlots.values()].some(i=>i?.name===itemName&&enchantmentFacts(i).length>0);
    const applyWindowItems=packet=>{
      server.slots.set(0,Item.fromNotch(packet.items[0]));server.slots.set(1,Item.fromNotch(packet.items[1]));
      for(let slot=window.inventoryStart;slot<window.inventoryEnd;slot++)server.playerSlots.set(slot-window.inventoryStart+9,Item.fromNotch(packet.items[slot]));
    };
    const onSlot=packet=>{
      if(packet.windowId===0&&packet.slot>=9&&packet.slot<45)server.playerSlots.set(packet.slot,Item.fromNotch(packet.item));
      if(window&&packet.windowId===window.id){
        if([0,1].includes(packet.slot))server.slots.set(packet.slot,Item.fromNotch(packet.item));
        else if(packet.slot>=window.inventoryStart&&packet.slot<window.inventoryEnd)server.playerSlots.set(packet.slot-window.inventoryStart+9,Item.fromNotch(packet.item));
      }
    };
    const onItems=packet=>{
      if(packet.windowId===0){for(let slot=9;slot<45;slot++)server.playerSlots.set(slot,Item.fromNotch(packet.items[slot]));}
      else if(window&&packet.windowId===window.id)applyWindowItems(packet);
      else server.initialItems.set(packet.windowId,packet);
    };
    const onXP=()=>{server.xpEvents++;};
    client.on('set_slot',onSlot);client.on('window_items',onItems);bot.on('experience',onXP);
    try{
      window=await native(()=>deps.openTable?deps.openTable(bot.blockAt(new Vec3(table.x,table.y,table.z))):bot.openEnchantmentTable(bot.blockAt(new Vec3(table.x,table.y,table.z))),{table});active();
      if(bot.currentWindow!==window||!window.type?.startsWith('minecraft:enchant')||window.slots[0]||window.slots[1])throw error('house_enchant_foreign_window','本次自建附魔窗口非空或发生改变，不能采用未归属内容');
      if(server.initialItems.has(window.id))applyWindowItems(server.initialItems.get(window.id));
      if(server.playerSlots.size!==36||serverPlayerCount('lapis_lazuli')!==beforePlayerLapis)throw error('house_enchant_player_snapshot_unconfirmed','本次窗口没有完整且一致的服务端玩家背包快照');
      const input=window.items().find(i=>i.name===itemName&&!enchantmentFacts(i).length),lapis=window.items().find(i=>i.name==='lapis_lazuli'&&i.count>=3);
      if(!input||!lapis)throw error('house_enchant_materials_missing','打开窗口后的真实物品位置不足');
      await native(()=>window.putTargetItem(input),{windowId:window.id,table});active();
      await native(()=>window.putLapis(window.items().find(i=>i.name==='lapis_lazuli'&&i.count>=3)),{windowId:window.id,table});active();
      await waitFor(()=>server.slots.get(0)?.name===itemName&&server.slots.get(1)?.name==='lapis_lazuli'&&server.slots.get(1).count>=3&&window.enchantments?.[2]?.level===30,'house_enchant_offer_unconfirmed','没有真实30级选项及服务端输入槽确认');
      const before=xp(),lapisBefore=server.slots.get(1).count,priorXP=server.xpEvents;
      save({phase:'enchant_native_requested',enchantPending:{table:copy(table),windowId:window.id,itemName,before,lapisBefore,index:2}});
      await native(()=>deps.nativeEnchant?deps.nativeEnchant(window,2):window.enchant(2),{windowId:window.id,table,beforeSend:name=>{
        if(name==='enchant_item'&&(bot.currentWindow!==window||xp().level<30||window.enchantments?.[2]?.level!==30||window.slots[0]?.name!==itemName||enchantmentFacts(window.slots[0]).length||(window.slots[1]?.count||0)<3))throw error('house_enchant_send_changed','实际发包前附魔窗口、等级或输入已改变');
      }});active();
      await waitFor(()=>server.slots.get(0)?.name===itemName&&enchantmentFacts(server.slots.get(0)).length>0
        &&(server.slots.get(1)?.count||0)===lapisBefore-3&&xp().level===before.level-3&&server.xpEvents>priorXP,
      'house_enchant_result_unconfirmed','没有同时确认附魔NBT/组件、3青金石和3级真实消耗');
      const enchanted=copy(enchantmentFacts(server.slots.get(0)));
      const lapisAfter = lapisBefore - 3;
      await native(()=>window.takeTargetItem(),{windowId:window.id,table});active();
      // Move any remaining owner lapis back with the original inventory plugin.
      if(window.slots[1])await native(()=>bot.putAway(1),{windowId:window.id,table});active();
      await native(()=>window.close(),{windowId:window.id,table});active();
      await waitFor(()=>bot.currentWindow===null&&serverHasOutput()&&serverPlayerCount('lapis_lazuli')===beforePlayerLapis-3&&bot.inventory.items().some(i=>i.name===itemName&&enchantmentFacts(i).length>0)&&bot.inventory.items().filter(i=>i.name==='lapis_lazuli').reduce((n,i)=>n+i.count,0)===beforePlayerLapis-3,'house_enchant_output_unconfirmed','关闭窗口后没有在真实背包读到附魔物品');
      await returnCamp(anchor);healthy();
      const result={confirmed:true,table:copy(table),itemName,index:2,requiredOfferLevel:30,beforeLevel:before.level,afterLevel:xp().level,lapisBefore,lapisAfter,beforePlayerLapis,afterPlayerLapis:beforePlayerLapis-3,enchanted,camp:copy(anchor)};
      save({phase:'enchant30_confirmed',enchantPending:null,enchantResult:result});return result;
    }finally{
      client.removeListener('set_slot',onSlot);client.removeListener('window_items',onItems);bot.removeListener('experience',onXP);
      // Paused/superseded calls never close a window or write recovery control.
      // A failed native operation's packet guard remains until it settles.
    }
  }
  return {ensureLevels,enchant30,getState:()=>copy(deps.getCP?.()||state||null)};
}
module.exports={createHouseNaturalEnchant,enchantmentFacts};
