/* global require, module, setTimeout */
'use strict';
const { randomUUID } = require('node:crypto');
const { Vec3 } = require('vec3');
const AIR = new Set(['air','cave_air','void_air']);
const HAZARDS = new Set(['water','lava','fire','soul_fire','magma_block','cactus','powder_snow','campfire','soul_campfire']);
const frames = new WeakMap();
const key = p => `${p.x},${p.y},${p.z}`;
const copy = value => JSON.parse(JSON.stringify(value));
const failure = (code,message,details={}) => Object.assign(new Error(message),{code,...details});
const counts = items => (items||[]).reduce((out,item)=>{if(item)out[item.name]=(out[item.name]||0)+item.count;return out;},{});
const canonical = stock => JSON.stringify(Object.entries(stock).filter(([,n])=>n!==0).sort(([a],[b])=>a.localeCompare(b)));
const equalStock = (a,b) => canonical(a)===canonical(b);
const usableEquipment=(bot,item)=>{
 const maximum=bot.registry.items[item.type]?.maxDurability;
 if(!Number.isFinite(maximum))return true;
 const damage=Number(item.durabilityUsed||0),reserve=/_(?:helmet|chestplate|leggings|boots)$/.test(item.name)||item.name==='shield'?32:16;
 return Number.isFinite(damage)&&damage>=0&&maximum-damage>reserve;
};
const usableCounts=(bot,items)=>counts(items.filter(item=>usableEquipment(bot,item)));
const retiredEquipment=(bot,item)=>{
 const maximum=bot.registry.items[item.type]?.maxDurability,damage=Number(item.durabilityUsed||0);
 return Number.isFinite(maximum)&&Number.isFinite(damage)&&damage>=0&&maximum-damage<=8;
};
const properties = block => block?.getProperties?.()||{};

// The camp chooser proposes alternatives; the strict storage contract below
// still validates every selected site before any placement or inventory write.
function selectOwnedStorageSites(candidates,exclusions){
 if(!Array.isArray(candidates)||candidates.length>8||!Array.isArray(exclusions))throw TypeError('Expected bounded owned camp candidates and protections');
 const selected=[];
 for(const p of candidates){
  if(!p||!['x','y','z'].every(k=>Number.isSafeInteger(p[k]))||p.y< -63||p.y>318)continue;
  if(exclusions.some(b=>p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ))continue;
  if(selected.some(q=>key(q)===key(p)||p.y===q.y&&Math.abs(p.x-q.x)+Math.abs(p.z-q.z)<2))continue;
  selected.push({x:p.x,y:p.y,z:p.z});
 }
 return selected;
}

function createHouseOwnedStorage(deps) {
  if(typeof deps.isOwnerContext!=='function')throw new TypeError('Owned storage requires an exact execution-context check');
  let state;
  const active = () => deps.assertActive();
  const bot = () => deps.getBot();
  const at = p => bot().blockAt(new Vec3(p.x,p.y,p.z));
  const playerCounts = () => counts(bot().inventory.items());
  const canAct = () => {try{active();return true;}catch{return false;}};
  const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
  function load() {
    active();const previous=deps.getCheckpoint?.();
    if(!previous?.storageId)throw failure('house_storage_not_initialized','请先为本任务建立明确的自建施工仓库');
    if(previous.schema!==1||previous.kind!=='house_owned_storage'||!Array.isArray(previous.chests)||previous.chests.length>8)throw failure('house_storage_checkpoint_invalid','施工仓库归属记录无效');
    state=copy(previous);return state;
  }
  function save(patch) {active();state={...state,...patch};deps.setCheckpoint(copy(state));}
  function factChest(position,patch) {
    const current=deps.getCheckpoint();
    if(current?.storageId!==state.storageId)throw failure('house_storage_owner_changed','原施工仓库任务已改变，不能写入新的任务记录');
    const existing=current.chests.find(entry=>key(entry.position)===key(position));
    const next={...current,chests:existing?current.chests.map(entry=>key(entry.position)===key(position)?{...entry,...copy(patch)}:entry)
      :[...current.chests,{position:copy(position),item:'chest',...copy(patch)}]};
    deps.setCheckpoint(next,{confirmedFact:true,storageId:state.storageId});state=copy(next);
  }
  const entryAt = position => state.chests.find(entry=>key(entry.position)===key(position));
  function validateCounts(input,allowInfinity=false) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw failure('house_storage_invalid_counts','仓库物品预算必须是明确的名称数量表');
    for(const [name,n] of Object.entries(input))if(!bot().registry.itemsByName[name]||!(allowInfinity&&n===Infinity)&&(!Number.isInteger(n)||n<0||n>65536))throw failure('house_storage_invalid_counts',`无效仓库物品预算：${name}`);
    return {...input};
  }
  function bounds(input) {
    const list=Array.isArray(input)?input:input?[input]:[];
    if(!list.length||list.length>256||list.some(b=>!['minX','maxX','minY','maxY','minZ','maxZ'].every(k=>Number.isSafeInteger(b?.[k]))
      ||b.minX>b.maxX||b.minY>b.maxY||b.minZ>b.maxZ))throw failure('house_storage_invalid_bounds','必须明确建筑、脚手架、农田和营地的保护范围');
    return copy(list);
  }
  function position(p) {
    if(!p||!['x','y','z'].every(k=>Number.isSafeInteger(p[k]))||p.y< -63||p.y>318)throw failure('house_storage_invalid_site','仓库位置必须是有效整数坐标');
    return {x:p.x,y:p.y,z:p.z};
  }
  const excluded = p => state.exclusionBounds.some(b=>p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ);
  function site(p,existing=false) {
    position(p);
    if(excluded(p))throw failure('house_storage_site_excluded','仓库位置进入了建筑、农田、脚手架或营地保护范围');
    const block=at(p),above=at({...p,y:p.y+1}),below=at({...p,y:p.y-1});
    if(!block||!above||!below)throw failure('house_storage_unloaded','仓库位置未真实加载');
    if(!AIR.has(above.name)||HAZARDS.has(below.name)||properties(below).waterlogged===true
      ||!(below.shapes||[]).some(s=>s[0]===0&&s[2]===0&&s[3]===1&&s[4]===1&&s[5]===1))throw failure('house_storage_unsafe_site','仓库需要干燥完整地基与可开盖净空');
    for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const neighbor=at({x:p.x+dx,y:p.y,z:p.z+dz});
      if(!neighbor||['chest','trapped_chest'].includes(neighbor.name))throw failure('house_storage_adjacent_chest','仓库箱不能与任何其他箱子相邻或合并');
    }
    if(existing) {
      const expected=entryAt(p);
      if(!expected?.confirmedPlaced||block.name!=='chest'||properties(block).type!=='single'||properties(block).waterlogged===true
        ||expected.properties&&Object.entries(expected.properties).some(([k,v])=>String(properties(block)[k])!==String(v)))throw failure('house_storage_changed','自建仓库方块已改变，保留现场并停止');
    } else if(!AIR.has(block.name))throw failure('house_storage_foreign_block','候选位置已有方块，不能接管或覆盖玩家箱子');
  }
  async function close(window) {
    if(bot().currentWindow===window){active();await window.close();}
  }
  async function confirmClosed(name,expected) {
    const deadline=Date.now()+(deps.timeoutMs??2500);
    while((playerCounts()[name]||0)!==expected) {
      active();if(Date.now()>=deadline)throw failure('house_storage_player_unconfirmed',`关闭箱子后 ${name} 的真实背包数量未确认`);
      await sleep(25);
    }
  }
  function pendingProof(entry,stock,player) {
    const pending=entry.pendingTransfer;
    if(!pending||pending.foreignInterference)return null;
    const sign=pending.direction==='deposit'?1:-1;
    const moved=sign*((stock[pending.item]||0)-(pending.beforeStock[pending.item]||0));
    const expected={...pending.beforeStock,[pending.item]:(pending.beforeStock[pending.item]||0)+sign*moved};
    if(moved<0||moved>pending.amount||!equalStock(stock,expected)
      ||(player[pending.item]||0)!==pending.beforePlayerCount-sign*moved)return null;
    return {moved,expectedPlayer:pending.beforePlayerCount-sign*moved};
  }
  async function open(entry) {
    active();site(entry.position,true);await deps.reach(entry.position);active();
    const window=await deps.openContainer(at(entry.position));
    try{
      active();
      if(!window||window.inventoryStart!==27||typeof window.containerItems!=='function'||typeof window.items!=='function'
        ||typeof window.close!=='function'||window.selectedItem)throw failure('house_storage_window_invalid','没有确认单箱真实窗口或光标仍持有物品');
      const actual=counts(window.containerItems());
      if(entry.emptyAuthorized!==true) {
        if(Object.keys(actual).length)throw failure('house_storage_foreign_contents','新放置箱子未确认空箱，不能采用现有物品');
        factChest(entry.position,{emptyAuthorized:true,stock:{}});
      } else if(entry.pendingTransfer) {
        const proof=pendingProof(entry,actual,counts(window.items()));
        if(!proof)throw failure('house_storage_foreign_contents','中断后的仓库与原生存取意图、真实背包不符，不能采用外来内容',{expected:entry.stock,actual});
        factChest(entry.position,{stock:actual,pendingTransfer:null,pendingClosedInventory:{item:entry.pendingTransfer.item,expected:proof.expectedPlayer}});
      } else if(!equalStock(actual,entry.stock||{})) {
        // A previous camp restoration cleared the cached stock. Reconcile only
        // an exact earlier receipt of this same owned storage identity. Fresh
        // or nonempty mismatches never gain permission to adopt foreign items.
        const receipts=Object.keys(entry.stock||{}).length===0?deps.archivedStock?.(entry,state.storageId)||[]:[];
        if(!receipts.some(stock=>equalStock(actual,stock)))throw failure('house_storage_foreign_contents','仓库内容与机器人存入账目不符，保留全部物品并停止',{expected:entry.stock,actual});
        factChest(entry.position,{stock:actual});
      }
      factChest(entry.position,{usableStock:usableCounts(bot(),window.containerItems())});
      return window;
    }catch(error){if(window&&typeof window.close==='function'&&canAct())await close(window);throw error;}
  }
  async function inspect(entry) {
    let window;
    try {
      window=await open(entry);
      await close(window);window=null;
      const pending=entryAt(entry.position).pendingClosedInventory;
      if(pending){await confirmClosed(pending.item,pending.expected);factChest(entry.position,{pendingClosedInventory:null});}
    } finally {if(window&&canAct())await close(window);}
  }
  async function createNext() {
    active();
    const candidates=state.plannedSites.filter(p=>!state.chests.some(c=>key(c.position)===key(p)));
    let lastError;
    for(const p of candidates) {
      active();
      try{site(p);}catch(error){lastError=error;continue;}
      await deps.acquireChestItem();active();
      if((playerCounts().chest||0)<1)throw failure('house_storage_chest_missing','没有实际取得用于自建仓库的箱子');
      site(p);
      const spec={id:`storage:${key(p)}`,position:copy(p),item:'chest',properties:{type:'single',facing:'north',waterlogged:false}};
      let recorded=false;
      const confirmed=()=>{
        if(recorded||at(p)?.name!=='chest')return;
        recorded=true;factChest(p,{confirmedPlaced:true,emptyAuthorized:false,properties:copy(spec.properties),stock:{}});
      };
      await deps.placeNative(spec,confirmed);active();
      if(!recorded)throw failure('house_storage_placement_unconfirmed','自建箱子没有真实放置确认');
      await inspect(entryAt(p));return entryAt(p);
    }
    throw lastError||failure('house_storage_full','有限的自建仓库位置已全部使用，不能继续无限扩建');
  }
  async function ensure({exclusionBounds}={}) {
    active();const protectedBounds=bounds(exclusionBounds),previous=deps.getCheckpoint?.();
    if(previous?.storageId){load();save({exclusionBounds:[...new Map([...state.exclusionBounds,...protectedBounds].map(b=>[JSON.stringify(b),b])).values()]});}
    else {
      state={schema:1,kind:'house_owned_storage',storageId:randomUUID(),exclusionBounds:protectedBounds,chests:[],plannedSites:[]};save({phase:'select_sites'});
    }
    if(!state.plannedSites.length){
      const sites=await deps.chooseSites(copy(state.exclusionBounds));active();
      if(!Array.isArray(sites)||!sites.length||sites.length>8)throw failure('house_storage_invalid_site','自建仓库必须使用1至8个明确位置');
      const planned=sites.map(position);
      if(new Set(planned.map(key)).size!==planned.length||planned.some((p,i)=>excluded(p)||planned.slice(0,i).some(q=>p.y===q.y&&Math.abs(p.x-q.x)+Math.abs(p.z-q.z)<2)))throw failure('house_storage_invalid_site','仓库位置重复、相邻或进入保护范围');
      save({plannedSites:planned,phase:'inspect'});
    }
    for(const entry of [...state.chests]){
      if(at(entry.position)&&AIR.has(at(entry.position).name)){
        // Rebuild only a missing owned chest at its original authorized site.
        // The destroyed stock is archived, never credited to the replacement.
        await deps.restoreOwnedSupport?.(entry.position);active();site(entry.position);await deps.acquireChestItem();active();
        if((playerCounts().chest||0)<1)throw failure('house_storage_chest_missing','没有实际取得补建自有仓库所需的箱子');
        const spec={id:`storage-replacement:${key(entry.position)}`,position:copy(entry.position),item:'chest',properties:{type:'single',facing:'north',waterlogged:false}};
        let recorded=false;
        await deps.placeNative(spec,()=>{if(recorded||at(entry.position)?.name!=='chest')return;recorded=true;
          factChest(entry.position,{confirmedPlaced:true,emptyAuthorized:false,stock:{},pendingTransfer:null,pendingClosedInventory:null,properties:copy(spec.properties),
            replacements:[...(entry.replacements||[]).slice(-15),{at:Date.now(),previousStock:copy(entry.stock||{}),reason:'owned_chest_missing'}]});});
        active();if(!recorded)throw failure('house_storage_placement_unconfirmed','补建自有箱子未获得真实放置确认');
      }
      await inspect(entryAt(entry.position));
    }
    if(!state.chests.length)await createNext();
    save({phase:'ready'});return {owned:true,chests:copy(state.chests),stock:getStock()};
  }
  function capacity(slots,start,end,name) {
    const stack=bot().registry.itemsByName[name].stackSize||64;
    let n=0;for(let i=start;i<end;i+=1){const item=slots[i];if(!item)n+=stack;else if(item.name===name)n+=Math.max(0,stack-item.count);}return n;
  }
  async function transfer(window,entry,name,amount,direction,selectedItem=null) {
    active();const beforeStock=counts(window.containerItems()),beforePlayer=counts(window.items()),sign=direction==='deposit'?1:-1;
    const expectedStock={...beforeStock,[name]:(beforeStock[name]||0)+sign*amount};
    const expectedPlayer=(beforePlayer[name]||0)-sign*amount;
    const intent={item:name,amount,direction,beforeStock,beforePlayerCount:beforePlayer[name]||0};
    save({chests:state.chests.map(c=>key(c.position)===key(entry.position)?{...c,pendingTransfer:copy(intent)}:c)});
    const client=bot()._client,frame={previous:client.write,active:true},Item=require('prismarine-item')(bot().registry);
    let ownedClicks=0,foreignWindowClick=false;
    // Chest clicks optimistically mutate Mineflayer's window before writing.
    // Keep a separate snapshot changed only by actual inbound server packets.
    const snapshot=item=>item?{name:item.name,type:item.type,count:item.count,durabilityUsed:Number(item.durabilityUsed||0)}:null;
    let authoritative=window.slots.map(snapshot);
    const onSlot=packet=>{if(packet.windowId===window.id){try{authoritative[packet.slot]=snapshot(Item.fromNotch(packet.item));}catch{/* Fresh reopen remains required. */}}};
    const onItems=packet=>{if(packet.windowId===window.id){try{authoritative=packet.items.map(raw=>snapshot(Item.fromNotch(raw)));}catch{/* Preserve the previous confirmed snapshot. */}}};
    function write(...args){if(frame.active&&args[0]==='window_click'&&args[1]?.windowId===window.id){if(deps.isOwnerContext()===true){active();ownedClicks+=1;}else foreignWindowClick=true;}return frame.previous.apply(this,args);}
    function restore(){frame.active=false;if(client.write===write){let previous=frame.previous;while(frames.get(previous)?.active===false)previous=frames.get(previous).previous;client.write=previous;}}
    frames.set(write,frame);client.write=write;client.on('set_slot',onSlot);client.on('window_items',onItems);
    let fresh;
    try {
      let operationError;
      try{
        if(selectedItem){
          const start=direction==='deposit'?window.inventoryStart:0,end=direction==='deposit'?window.inventoryEnd:window.inventoryStart;
          if(!Number.isSafeInteger(selectedItem.slot)||selectedItem.slot<start||selectedItem.slot>=end
            ||window.slots[selectedItem.slot]!==selectedItem||selectedItem.name!==name||selectedItem.count<amount)
            throw failure('house_storage_selected_item_changed','指定旧工具槽位已变化，保留物品');
          await bot().transfer({window,itemType:bot().registry.itemsByName[name].id,metadata:null,count:amount,
            sourceStart:selectedItem.slot,sourceEnd:selectedItem.slot+1,
            destStart:direction==='deposit'?0:window.inventoryStart,destEnd:direction==='deposit'?window.inventoryStart:window.inventoryEnd});
        }else if(direction==='withdraw'&&bot().inventory.emptySlotCount?.()===0&&typeof bot().transfer==='function') {
          // Native window.withdraw unnecessarily rejects a full inventory
          // even when a matching partial stack can receive the items. Its
          // public native transfer primitive supports that actual capacity.
          await bot().transfer({window,itemType:bot().registry.itemsByName[name].id,metadata:null,count:amount,
            sourceStart:0,sourceEnd:window.inventoryStart,destStart:window.inventoryStart,destEnd:window.inventoryEnd});
        } else await window[direction](bot().registry.itemsByName[name].id,null,amount);
      }catch(error){operationError=error;}finally{restore();}
      const observedStock=counts(authoritative.slice(0,window.inventoryStart)),observedPlayer=counts(authoritative.slice(window.inventoryStart,window.inventoryEnd));
      const proof=pendingProof(entryAt(entry.position),observedStock,observedPlayer);
      if(ownedClicks>0&&!foreignWindowClick&&proof?.moved>0)factChest(entry.position,{stock:observedStock,
        usableStock:usableCounts(bot(),authoritative.slice(0,window.inventoryStart).filter(Boolean)),pendingClosedInventory:{item:name,expected:proof.expectedPlayer}});
      if(foreignWindowClick)factChest(entry.position,{pendingTransfer:{...intent,foreignInterference:true}});
      if(operationError)throw operationError;
      active();
      if(!ownedClicks||foreignWindowClick)throw failure('house_storage_transfer_unconfirmed','原生仓库存取没有唯一的本任务点击归属，停止自动认领');
      await close(window);active();
      // A successful 1.21.8 chest click need not send an ACK. A new native open
      // yields authoritative window_items for both container and player slots.
      fresh=await open(entryAt(entry.position));
      const afterStock=counts(fresh.containerItems()),afterPlayer=counts(fresh.items());
      if(!equalStock(afterStock,expectedStock)||(afterPlayer[name]||0)!==expectedPlayer)throw failure('house_storage_transfer_unconfirmed','重新打开后未同时确认箱内与真实背包变化，停止重复操作',{direction,name,amount,beforeStock,afterStock,beforePlayer,afterPlayer});
      await close(fresh);fresh=null;
      await confirmClosed(name,expectedPlayer);
      factChest(entry.position,{pendingClosedInventory:null});active();
      return amount;
    } finally {
      restore();client.removeListener('set_slot',onSlot);client.removeListener('window_items',onItems);
      if(fresh&&canAct())await close(fresh);
    }
  }
  async function stash(keepCounts) {
    load();const keep=validateCounts(keepCounts,true);let deposited=0;
    for(const entry of [...state.chests])if(entry.pendingClosedInventory||entry.pendingTransfer)await inspect(entry);
    for(const name of Object.keys(playerCounts()).sort()) {
      const retained=keep[name]??0;
      if(retained===Infinity)continue;
      let index=0;
      while((playerCounts()[name]||0)>retained) {
        active();if(index>=state.chests.length)await createNext();
        const entry=state.chests[index++];let window;
        try {
          window=await open(entry);
          const amount=Math.min(Math.max(0,(counts(window.items())[name]||0)-retained),capacity(window.slots,0,window.inventoryStart,name));
          if(!amount){await close(window);window=null;continue;}
          deps.report?.(`存入自建仓库 ${name} ×${amount}`);active();
          deposited+=await transfer(window,entry,name,amount,'deposit');window=null;
        } finally{if(window&&canAct())await close(window);}
      }
    }
    save({phase:'ready'});return {deposited,stock:getStock()};
  }
  async function stashUnusableEquipment(){
    load();let deposited=0;
    for(let moved=0;moved<36;moved++){
      active();if(!bot().inventory.items().some(item=>retiredEquipment(bot(),item)))break;
      let stored=false;
      for(let index=0;index<=state.chests.length;index++){
        active();if(index===state.chests.length)await createNext();
        const entry=state.chests[index];let window;
        try{
          window=await open(entry);
          const item=window.items().find(value=>retiredEquipment(bot(),value));
          if(!item){await close(window);window=null;break;}
          if(capacity(window.slots,0,window.inventoryStart,item.name)<1){await close(window);window=null;continue;}
          deps.report?.(`存放低耐久旧工具 ${item.name}`);
          deposited+=await transfer(window,entry,item.name,1,'deposit',item);window=null;stored=true;break;
        }finally{if(window&&canAct())await close(window);}
      }
      if(!stored)break;
    }
    return {deposited,stock:getStock()};
  }
  async function withdraw(requirements) {
    load();const needed=validateCounts(requirements);let withdrawn=0;
    for(const entry of [...state.chests])if(entry.pendingClosedInventory||entry.pendingTransfer)await inspect(entry);
    for(const [name,required] of Object.entries(needed)) {
      for(const entry of [...state.chests]) {
        if((playerCounts()[name]||0)>=required)break;
        active();let window;
        try {
          window=await open(entry);
          const equipment=Number.isFinite(bot().registry.itemsByName[name].maxDurability);
          const selected=equipment?window.containerItems().find(item=>item.name===name&&usableEquipment(bot(),item)):null;
          const amount=Math.min(required-(counts(window.items())[name]||0),equipment?(selected?.count||0):counts(window.containerItems())[name]||0,
            capacity(window.slots,window.inventoryStart,window.inventoryEnd,name));
          if(amount<=0){await close(window);window=null;continue;}
          deps.report?.(`从自建仓库取 ${name} ×${amount}`);active();
          withdrawn+=await transfer(window,entry,name,amount,'withdraw',selected);window=null;
        } finally{if(window&&canAct())await close(window);}
      }
      if((playerCounts()[name]||0)<required)throw failure((getStock()[name]||0)>0?'house_storage_inventory_full':'house_storage_missing',`自建仓库无法补足 ${name}`,{item:name,required,available:playerCounts()[name]||0,stock:getStock()[name]||0});
    }
    save({phase:'ready'});return {withdrawn,stock:getStock()};
  }
  function getStock(){return(state?.chests||deps.getCheckpoint?.()?.chests||[]).reduce((sum,entry)=>{
    for(const [name,n]of Object.entries(entry.stock||{})){
      const available=Number.isFinite(bot().registry.itemsByName[name]?.maxDurability)&&entry.usableStock
        ?Math.min(n,entry.usableStock[name]||0):n;
      if(available)sum[name]=(sum[name]||0)+available;
    }return sum;},{});}
  return {ensure,stash,stashUnusableEquipment,withdraw,getStock};
}
module.exports={createHouseOwnedStorage,selectOwnedStorageSites};
