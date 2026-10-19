'use strict';
// Relative native crop provider, with the original guarded crop core preserved.
const runtimeRequire=require;
const {Vec3}=require('vec3'),{Movements,goals}=require('mineflayer-pathfinder'),NativeMove=require('mineflayer-pathfinder/lib/move');
const {dryBody}=require('./houseNaturalXPProvider');
const {naturalWalkingFoot:dryFoot}=require('./houseSurfaceGraph');
const {createEstatePlacement}=require('./estatePlacement');
const {inspectRecordedNaturalXPFoundation}=require('./houseNaturalXPSupport');
const frames=new WeakMap(),cancelScopes=new WeakMap();
const air=b=>b&&['air','cave_air','void_air'].includes(b.name),point=p=>({x:p.x,y:p.y,z:p.z});
const integer=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
const same=(a,b)=>integer(a)&&integer(b)&&['x','y','z'].every(k=>a[k]===b[k]);
const key=p=>`${p.x},${p.y},${p.z}`,copy=x=>JSON.parse(JSON.stringify(x));
const fail=(code,message,facts={})=>Object.assign(new Error(message),{code,...facts});
const hazards=new Set(['water','lava','bubble_column','magma_block','fire','soul_fire','campfire','soul_campfire','powder_snow','cactus','sweet_berry_bush']);
const safe=b=>b&&!hazards.has(b.name)&&![true,'true'].includes(b.getProperties?.().waterlogged);
const excluded=(p,bounds)=>(bounds||[]).some(b=>p.x>=b.minX&&p.x<=b.maxX&&p.y>=b.minY&&p.y<=b.maxY&&p.z>=b.minZ&&p.z<=b.maxZ);
const at=(bot,p)=>bot.blockAt(new Vec3(p.x,p.y,p.z));
function column(bot,bottom){
 if(!integer(bottom)||at(bot,bottom)?.name!=='cactus'||!['sand','red_sand'].includes(at(bot,{...bottom,y:bottom.y-1})?.name))return null;
 const blocks=[];for(let n=0;n<=3;n++){
  const p={...bottom,y:bottom.y+n},b=at(bot,p);if(!b)return null;
  if(b.name==='cactus'){if(n===3)return null;blocks.push({position:p,stateId:b.stateId,age:Number(b.getProperties?.().age)});continue;}
  if(!air(b)&&b.name!=='cactus_flower')return null;
  if(b.name==='cactus_flower'&&!air(at(bot,{...p,y:p.y+1})))return null;
  return{bottom:point(bottom),height:blocks.length,blocks,targets:blocks.slice(1).reverse(),flower:b.name==='cactus_flower'?{position:p,stateId:b.stateId}:null};
 }
 return null;
}
function findMatureNaturalColumns(bot,{maximum=64,maxDistance=96,excludeBounds=[],isProtectedPosition=()=>false,readLimit=16384,timeoutMs=1000}={}){
 if(!Number.isInteger(maximum)||maximum<1||maximum>128||!Number.isInteger(maxDistance)||maxDistance<1||maxDistance>96)throw fail('cactus_discovery_limits','Finite natural upper-only discovery required');
 const began=Date.now();let reads=0;
 const read=p=>{if(++reads>readLimit||Date.now()-began>=timeoutMs)throw fail('cactus_discovery_budget','Finite loaded upper-only discovery budget');return at(bot,p);};
 const result=[],seen=new Set();
 // Actual upper predicate is evaluated BEFORE native count truncation. The
 // nearest64 retained bottoms cannot shadow a farther harvestable column.
 const candidates=bot.findBlocks({matching:bot.registry.blocksByName.cactus.id,useExtraInfo:b=>b&&integer(b.position)&&read({...b.position,y:b.position.y-1})?.name==='cactus',maxDistance,count:Math.min(256,maximum*2)});
 for(const raw of candidates){
  let bottom=point(raw);for(let n=0;n<3;n++){const p={...bottom,y:bottom.y-1};if(read(p)?.name!=='cactus')break;bottom=p;}
  if(seen.has(key(bottom)))continue;seen.add(key(bottom));
  const tree=column(bot,bottom);if(!tree||tree.height<2||[...tree.blocks.map(b=>b.position),...(tree.flower?[tree.flower.position]:[])].some(p=>excluded(p,excludeBounds)||isProtectedPosition(p)))continue;
  result.push(tree);if(result.length>=maximum)break;
 }
 return{columns:result,reads,elapsedMs:Date.now()-began,actualMovementPerformed:false,unseenWorld:'UNKNOWN'};
}
function isOwnedRenewableCactusCancel(bot,name,data){
 const s=cancelScopes.get(bot?._client);
 return Boolean(name==='block_dig'&&data?.status===1&&s?.cancelling&&s.bot===bot&&s.client===bot._client&&bot.targetDigBlock===s.block&&bot.stopDigging===s.stop&&same(data.location,s.block.position));
}
function planLoadedCactusSites(bot,{anchor,targetColumns=128,radius=32,excludeBounds=[],isProtectedPosition=()=>false,readLimit=65536,probeLimit=128,timeoutMs=5000}={}){
 if(!integer(anchor)||!Number.isInteger(targetColumns)||targetColumns<1||targetColumns>128||!Number.isInteger(radius)||radius<3||radius>32)throw fail('cactus_site_limits','Fixed camp within32m/maximum128 owned columns required');
 const began=Date.now(),profile=new Movements(bot),sites=[],rejections={};let reads=0,probes=0;
 const reject=c=>rejections[c]=(rejections[c]||0)+1;
 const read=p=>{if(++reads>readLimit||Date.now()-began>=timeoutMs)throw fail('cactus_site_budget','Finite loaded site/probe budget');return at(bot,p);};
 const loaded=Object.create(bot);loaded.blockAt=read;
 profile.bot=loaded;profile.canDig=false;profile.scafoldingBlocks=[];profile.allowParkour=false;profile.allow1by1towers=false;profile.allowSprinting=false;profile.allowFreeMotion=false;profile.maxDropDown=2;profile.getMoveDiagonal=()=>{};
 for(const name of hazards){const id=bot.registry.blocksByName[name]?.id;if(id!==undefined)profile.blocksToAvoid.add(id);}
 profile.exclusionAreasStep.push(b=>b?.position&&integer(b.position)&&air(read(b.position))?0:Infinity);
 const offsets=[];for(let x=-radius;x<=radius;x+=3)for(let z=-radius;z<=radius;z+=3)if(Math.hypot(x,z)>=4&&Math.hypot(x,z)<=radius)offsets.push({x,z,distance:Math.hypot(x,z)});
 offsets.sort((a,b)=>a.distance-b.distance||a.x-b.x||a.z-b.z);
 let stopReason=null;
 try{for(const o of offsets){
  if(sites.length>=targetColumns)break;
  let selected=null;
  for(const dy of[0,1,-1,2,-2]){
   const p={x:anchor.x+o.x,y:anchor.y+dy,z:anchor.z+o.z},floor={...p,y:p.y-1};
   if(excluded(p,excludeBounds)||excluded(floor,excludeBounds)||isProtectedPosition(floor)){reject('protected');continue;}
   if(!['sand','red_sand'].includes(read(floor)?.name)){reject('not_natural_sand');continue;}
   const foundation=[];let supported=false;
   for(let down=0;down<16;down++){const q={...floor,y:floor.y-down},b=read(q);if(!safe(b)||b.boundingBox!=='block'||!b.shapes?.some(s=>s.length===6&&s.every((v,n)=>v===(n<3?0:1))))break;foundation.push({position:q,name:b.name,stateId:b.stateId});if(!['sand','red_sand','gravel'].includes(b.name)){supported=true;break;}}
   if(!supported){reject('foundation_unknown_or_unstable');continue;}
   if(!inspectRecordedNaturalXPFoundation({support:foundation[0],foundation,blockAt:read,assertActive:()=>{}}).safe){reject('foundation_unknown_or_unstable');continue;}
   let clear=true;for(let up=0;up<4;up++)for(const [dx,dz]of[[0,0],[1,0],[-1,0],[0,1],[0,-1]])if(!air(read({x:p.x+dx,y:p.y+up,z:p.z+dz})))clear=false;
   if(!clear){reject('loaded_air_clearance');continue;}
   for(const [dx,dz]of[[1,0],[-1,0],[0,1],[0,-1]]){
    const access={x:p.x+dx,y:p.y,z:p.z+dz};if(!dryFoot(loaded,access))continue;
    if(++probes>probeLimit)throw fail('cactus_site_probe_budget','Finite native dry approach probes');
    const iterator=bot.pathfinder.getPathFromTo(profile,bot.entity.position,new goals.GoalBlock(access.x,access.y,access.z),{startMove:new NativeMove(Math.floor(bot.entity.position.x),Math.floor(bot.entity.position.y),Math.floor(bot.entity.position.z),0,0),optimizePath:false,timeout:100,tickTimeout:10,searchRadius:48});
    let out;for(let n=0;n<16;n++){const v=iterator.next();out=v.value?.result;if(v.done||!out||out.status!=='partial')break;}
    if(out?.status!=='success'||out.path?.some(n=>!integer(n)||n.toBreak?.length||n.toPlace?.length||!dryFoot(loaded,n))){reject('native_approach_unreachable');continue;}
    selected={position:p,support:foundation[0],foundation,access,approach:{nativeStatus:'success',plannedPath:(out.path||[]).map(point),actualConfirmed:false}};break;
   }
   if(selected)break;
  }
  if(selected)sites.push(selected);
 }}catch(error){if(['cactus_site_budget','cactus_site_probe_budget'].includes(error.code))stopReason=error.code;else throw error;}
 return{schema:1,anchor:point(anchor),sites,targetColumns,actualMovementPerformed:false,actualPlacementPerformed:false,diagnostics:{reads,readLimit,probes,probeLimit,stopReason,rejections,elapsedMs:Date.now()-began},source:'actual_loaded_world_only'};
}
function createRenewableCactusProvider(deps,limits={}){
 for(const name of['getBot','assertActive','isOwnerContext','getCP','saveCP','ensureFood','returnCamp','reachDry','placeNative','digNative','collectDrops','onOperationAbort','recordConfirmedFact'])if(typeof deps?.[name]!=='function')throw new TypeError(`Renewable cactus host dependency ${name} required`);
 if(typeof deps.ownerId!=='string'||!deps.ownerId)throw new TypeError('Original captured task ownerId required');
 const bot=deps.getBot(),client=bot._client,Item=runtimeRequire('prismarine-item')(bot.registry),Block=runtimeRequire('prismarine-block')(bot.registry);
 const cfg={totalMs:14400000,noGrowthMs:1800000,actionMs:10000,workMs:180000,seedMs:1200000,readbackMs:5000,pollMs:1000,maximumHarvests:4096,...limits};
 for(const [k,v]of Object.entries(cfg))if(!Number.isSafeInteger(v)||v<1||v>14400000)throw new TypeError(`Finite cactus budget ${k}`);
 if(cfg.maximumHarvests>8192)throw new TypeError('Finite cactus harvest ledger required');
 let state=null,terminal=null,running=false,rawInventory=0,rawBlocks=0,activeDig=null; const namedInventory=new Map();
 const count=name=>bot.inventory.items().reduce((n,i)=>n+(i.name===name?i.count:0),0);
 const active=()=>{if(terminal)throw terminal;deps.assertActive();if(deps.getBot()!==bot||bot._client!==client)throw fail('cactus_owner_changed','Captured bot/client changed');};
 const survival=()=>{active();if(!Number.isFinite(bot.health)||bot.health<16||!Number.isFinite(bot.food)||bot.food<14)throw fail('cactus_survival_limit','Real health16/food14 required');};
 const init=anchor=>{active();if(!integer(anchor))throw fail('cactus_anchor_invalid','Fixed native camp required');const old=deps.getCP();if(old&&(old.schema!==1||old.kind!=='owned_renewable_cactus'||old.ownerId!==deps.ownerId||!same(old.anchor,anchor)))throw fail('cactus_checkpoint_changed','Original owner/camp contract changed');state=old?copy(old):{schema:1,kind:'owned_renewable_cactus',ownerId:deps.ownerId,anchor:point(anchor),columns:[],harvests:[],pending:null,growthObservations:0};if(state.pending)throw fail('cactus_reconciliation_required','Previous native planting/dig may have occurred; preserve pending fact, never replay');};
 const save=patch=>{active();state={...state,...copy(patch)};deps.saveCP(copy(state));};
 const foundation=entry=>{const proof=inspectRecordedNaturalXPFoundation({...entry,blockAt:p=>at(bot,p),assertActive:active});if(!proof.safe)throw fail('cactus_foundation_pending','Recorded cactus support needs fresh loaded full stable foundation',{foundationReason:proof.reason,position:proof.position});};
 const layoutFoundations=()=>{for(const site of state?.layout?.sites||[])foundation(site);};
 const unwrap=p=>{while(frames.get(p)?.active===false)p=frames.get(p).previous;return p;};
 function cancelDig(){const d=activeDig;if(!d||deps.isNativeCancelOwnerCurrent?.()!==true||bot.targetDigBlock!==d.block||bot.stopDigging!==d.stop)return;d.cancelling=true;try{d.stop.call(bot);}finally{d.cancelling=false;}}
 async function native(operation,label,ms=cfg.actionMs,beforeSend=()=>{},monitorSafety=()=>{}){
  active();const frame={active:true,closed:false,previous:client.write};let timer,poll,tickListener;
  function write(name,data,...rest){if(isOwnedRenewableCactusCancel(bot,name,data))return frame.previous.call(this,name,data,...rest);if(frame.active&&['block_dig','block_place','use_item','window_click','held_item_slot','close_window'].includes(name)&&deps.isOwnerContext()===true){if(frame.closed)throw terminal||fail('cactus_native_closed','Closed native action');active();beforeSend(name,data);}return frame.previous.call(this,name,data,...rest);}
  frames.set(write,frame);client.write=write;
  const restore=()=>{frame.active=false;if(client.write===write)client.write=unwrap(frame.previous);};
  const pending=Promise.resolve().then(()=>{active();return operation();});pending.then(restore,restore);
  const aborted=new Promise((_resolve,reject)=>{
   const stop=e=>{if(frame.closed)return;frame.closed=true;terminal||=e;try{cancelDig();}catch(cleanupError){e.cleanupFailure={code:cleanupError.code||null,message:cleanupError.message};}try{deps.onOperationAbort(e);}catch{}reject(e);};
   timer=setTimeout(()=>stop(fail('cactus_native_timeout',`${label} finite native deadline`)),ms);
   tickListener=()=>{try{active();monitorSafety();}catch(e){stop(e);}};bot.on('physicsTick',tickListener);
   poll=setInterval(tickListener,Math.min(100,cfg.pollMs));
  });
  try{const out=await Promise.race([pending,aborted]);active();return out;}catch(error){frame.closed=true;let settlementTimer;const settled=await Promise.race([pending.then(()=>true,()=>true),new Promise(r=>{settlementTimer=setTimeout(()=>r(false),5000);})]);clearTimeout(settlementTimer);if(!settled)throw fail('cactus_native_cleanup_pending',`${label} native settlement UNKNOWN; closed guard retained`,{nativeSettlement:'UNKNOWN',cause:error});throw error;}finally{clearTimeout(timer);clearInterval(poll);if(tickListener)bot.removeListener('physicsTick',tickListener);}
 }
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 async function wait(predicate,code,message,ms=cfg.readbackMs){const deadline=Date.now()+ms;while(true){active();if(predicate())return;if(Date.now()>=deadline)throw fail(code,message);await sleep(Math.min(cfg.pollMs,Math.max(1,deadline-Date.now())));}}
 const rawItem=p=>{if(p.windowId!==0)return;rawInventory++;for(const raw of p.items||[p.item]){try{const item=Item.fromNotch(raw);if(item&&['cactus','cactus_flower'].includes(item.name))namedInventory.set(item.name,rawInventory);}catch{/* Malformed or unrelated ACK never credits a pickup. */}}};
 const observations=new Map();
 function rawBlock(p,stateId){if(!state||!(same(state.pending?.position,p)||state.columns.some(c=>p.x===c.position.x&&p.z===c.position.z&&p.y>=c.position.y&&p.y<=c.position.y+4)))return;const b=Block.fromStateId(stateId);rawBlocks++;observations.set(key(p),{sequence:rawBlocks,name:b.name,stateId,properties:b.getProperties()});}
 const single=p=>rawBlock(p.location,p.type);
 const multi=p=>{for(const r of p.records||[]){const packed=bot.supportFeature('usesMultiblockSingleLong'),base=bot.supportFeature('usesMultiblock3DChunkCoords')?p.chunkCoordinates:{x:p.chunkX,y:0,z:p.chunkZ};rawBlock({x:base.x*16+(packed?(r>>8)&15:(r.horizontalPos>>4)&15),y:base.y*16+(packed?r&15:r.y),z:base.z*16+(packed?(r>>4)&15:r.horizontalPos&15)},packed?r>>12:r.blockId);}};
 const watch=()=>{client.on('set_slot',rawItem);client.on('window_items',rawItem);client.on('block_change',single);client.on('multi_block_change',multi);};
 const unwatch=()=>{client.removeListener('set_slot',rawItem);client.removeListener('window_items',rawItem);client.removeListener('block_change',single);client.removeListener('multi_block_change',multi);};
 const remaining=(end,max)=>{const n=end-Date.now();if(n<=0)throw fail('cactus_total_timeout','Finite total supply deadline');return Math.min(n,max);};
 async function food(end){await native(()=>deps.ensureFood({anchor:state.anchor,purpose:'renewable_cactus',preserveOwnedColumns:copy(state.columns)}),'owned food',remaining(end,cfg.workMs));survival();}
 function ownColumn(entry){foundation(entry);const support=at(bot,entry.support.position);if(!entry.confirmedOwned||support?.name!==entry.support.name||support.stateId!==entry.support.stateId)throw fail('cactus_owned_floor_changed','Owned cactus floor replaced; preserve it');const value=column(bot,entry.position);if(!value)throw fail('cactus_owned_column_changed','Owned seed/bottom/type changed; cannot adopt replacement');return value;}
 function stance(p){survival();const e=bot.entity;if(e.onGround!==true||!dryBody(bot)||Math.hypot(e.position.x-p.x-.5,e.position.z-p.z-.5)>1.5||e.position.offset(0,e.eyeHeight||1.62,0).distanceTo(new Vec3(p.x+.5,p.y+.5,p.z+.5))>4.5)throw fail('cactus_stance_unconfirmed','Real supported dry native reach/pickup stance required');}
 async function approach(p,end){await native(()=>deps.reachDry(p,{range:1.5,canDig:false,canPlace:false,preserveOwnedColumns:copy(state.columns)}),'loaded dry crop approach',remaining(end,cfg.workMs));stance(p);}
 async function dig(entry,p,item,end){
  await approach(p,end);const before=count(item),inventorySequence=rawInventory,sequence=rawBlocks,block=at(bot,p);let started=false,finished=false;
  if(block?.name!==item||item==='cactus'&&p.y<=entry.position.y||deps.isProtectedPosition?.(p)||excluded(p,state.excludeBounds||[]))throw fail('cactus_dig_protected','Bottom, route or foreign block cannot be dug');
  if(deps.sourceGuardSupportsOwnedCancel!==true||typeof deps.isNativeCancelOwnerCurrent!=='function')throw fail('cactus_cancel_guard_pending','Captured parent must admit exact owned native status1 cancellation');
  save({pending:{kind:'harvest',position:point(p),item,before}});
  const session={bot,client,block,stop:null,cancelling:false};const initialStop=bot.stopDigging;
  const captureStop=()=>{if(!session.stop&&started&&deps.getBot()===bot&&bot._client===client&&deps.isNativeCancelOwnerCurrent()===true&&bot.targetDigBlock===block&&bot.stopDigging!==initialStop)session.stop=bot.stopDigging;};activeDig=session;cancelScopes.set(client,session);
  try{
   await native(()=>deps.digNative(block),'owned flower/upper native dig',remaining(end,cfg.actionMs),(name,data)=>{if(name==='block_dig'&&[0,2].includes(data?.status)){stance(p);ownColumn(entry);if(!same(data.location,p)||at(bot,p)?.name!==item||p.y<=entry.position.y)throw fail('cactus_send_changed','Native dig target/source changed');if(data.status===0){started=true;Promise.resolve().then(captureStop);}if(data.status===2)finished=true;}},()=>{stance(p);ownColumn(entry);});
   await wait(()=>started&&finished&&observations.get(key(p))?.sequence>sequence&&observations.get(key(p))?.name==='air'&&air(at(bot,p)),'cactus_air_ack_unconfirmed','Native dig lacks raw server AIR ACK');
   await native(()=>deps.collectDrops({position:point(p),items:[item],radius:1.5,allowMovement:false,timeoutMs:4500}),'actual crop pickup',remaining(end,cfg.actionMs));
   await wait(()=>namedInventory.get(item)>inventorySequence&&count(item)>before,'cactus_pickup_unconfirmed','Actual raw inventory pickup not confirmed');
   ownColumn(entry);const fact={kind:'owned_cactus_harvest',position:point(p),bottom:entry.position,item,before,after:count(item),at:Date.now()};deps.recordConfirmedFact(copy(fact));
   save({pending:null,harvests:[...state.harvests,fact].slice(-cfg.maximumHarvests)});return fact;
  }finally{if(cancelScopes.get(client)===session)cancelScopes.delete(client);if(activeDig===session)activeDig=null;}
 }
 async function provision({anchor,plan,targetColumns=128,excludeBounds=[]}={}){
  init(anchor);survival();const end=Date.now()+cfg.totalMs;watch();
  try{
   await food(end);const layout=plan||planLoadedCactusSites(bot,{anchor,targetColumns,excludeBounds,isProtectedPosition:deps.isProtectedPosition});
   if(!layout||layout.schema!==1||!same(layout.anchor,anchor)||layout.sites.length<targetColumns)throw fail('cactus_site_unavailable','Finite actual loaded sand sites insufficient',{available:layout?.sites?.length||0,requested:targetColumns});
   save({excludeBounds:copy(excludeBounds),layout:{sites:copy(layout.sites.slice(0,targetColumns)),targetColumns}});
   layoutFoundations();
   const missing=state.layout.sites.filter(s=>!state.columns.some(c=>same(c.position,s.position)));
   while(count('cactus')<missing.length){
    if(typeof deps.acquireNaturalSeedUpper!=='function')throw fail('cactus_seed_provider_pending','Natural upper-only seed collector not bound');
    const before=count('cactus'),sequence=rawInventory,needed=Math.min(32,missing.length-before);
    await native(()=>deps.acquireNaturalSeedUpper(needed,{anchor,excludeBounds,preserveBottom:true,selector:findMatureNaturalColumns}),'natural native seed pickup',remaining(end,cfg.seedMs));
    layoutFoundations();
    await wait(()=>namedInventory.get('cactus')>sequence&&count('cactus')>=before+needed,'cactus_seed_ack_unconfirmed','Seed supplier label cannot replace real pickup');
   }
   const placement=createEstatePlacement({getBot:()=>bot,assertActive:active,isOwnerContext:deps.isOwnerContext,timeoutMs:cfg.readbackMs,placeNative:deps.placeNative});
   for(const site of state.layout.sites){
    if(state.columns.some(c=>same(c.position,site.position))){ownColumn(state.columns.find(c=>same(c.position,site.position)));continue;}
    await food(end);foundation(site);await approach(site.position,end);foundation(site);
    if(!air(at(bot,site.position))||at(bot,site.support.position)?.stateId!==site.support.stateId||excluded(site.position,excludeBounds)||deps.isProtectedPosition?.(site.support.position))throw fail('cactus_site_changed','Site no longer original owned candidate');
    const sequence=rawBlocks;save({pending:{kind:'plant',position:site.position,support:site.support}});
    await native(()=>placement.place({position:site.position,item:'cactus'},()=>{}),'actual cactus seed placement',remaining(end,cfg.actionMs),(name,data)=>{if(name==='block_place'){foundation(site);stance(site.position);if(data.direction!==1||!same(data.location,site.support.position)||!air(at(bot,site.position))||at(bot,site.support.position)?.stateId!==site.support.stateId)throw fail('cactus_site_changed','Native seed packet must still target its real supported AIR cell');}},()=>{foundation(site);stance(site.position);});foundation(site);
    await wait(()=>observations.get(key(site.position))?.sequence>sequence&&observations.get(key(site.position))?.name==='cactus'&&at(bot,site.position)?.name==='cactus','cactus_plant_ack_unconfirmed','New seed lacks raw world ACK');
    foundation(site);
    const entry={...copy(site),confirmedOwned:true,nativePlantConfirmedAt:Date.now(),initialObservedAge:Number(at(bot,site.position).getProperties().age)};
    deps.recordConfirmedFact({kind:'owned_cactus_seed',position:entry.position,support:entry.support,confirmedAt:entry.nativePlantConfirmedAt});
    save({pending:null,columns:[...state.columns,entry]});
   }
   await native(()=>deps.returnCamp(anchor,{resource:'cactus',purpose:'renewable'}),'actual camp return',remaining(end,cfg.workMs));survival();
   if(!same(bot.entity.position.floored(),anchor)||!dryBody(bot)||bot.entity.onGround!==true)throw fail('cactus_camp_unconfirmed','Fixed actual dry camp return missing');
   return{confirmed:true,ownedColumns:state.columns.length,actualSeedPlacements:missing.length,anchor:point(anchor),naturalGrowthConfirmed:false};
  }finally{unwatch();}
 }
 async function gather(additional,{anchor,maxDurationMs=cfg.totalMs}={}){
  init(anchor);survival();if(!Number.isInteger(additional)||additional<1||additional>256||!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1)throw fail('cactus_gather_limits','Finite1..256 actual additional cactus required');
  if(!state.columns.length)throw fail('cactus_owned_farm_missing','No native-confirmed owned seeds; cannot adopt nearby wild/player farm');
  const before=count('cactus'),goal=before+additional,end=Date.now()+Math.min(maxDurationMs,cfg.totalMs);let lastProgress=Date.now(),waits=0,observedUpdates=0;
  watch();try{while(count('cactus')<goal){
   await food(end);let progressed=false;
   for(const entry of state.columns){
    let tree=ownColumn(entry);if(tree.flower){await dig(entry,tree.flower.position,'cactus_flower',end);tree=ownColumn(entry);progressed=true;}
    for(const target of tree.targets){await dig(entry,target.position,'cactus',end);progressed=true;lastProgress=Date.now();if(count('cactus')>=goal)break;}
    if(count('cactus')>=goal)break;
   }
   if(count('cactus')>=goal)break;
   survival();if(Date.now()>=end)throw fail('cactus_total_timeout','Finite renewal supply deadline');
   if(Date.now()-lastProgress>=cfg.noGrowthMs)throw fail('cactus_growth_unobserved','Finite loaded natural growth wait produced no actual upper harvest',{collected:count('cactus')-before,waits});
   const previous=rawBlocks;deps.report?.('等待自建仙人掌的真实原生生长',{ownedColumns:state.columns.length,actualStock:count('cactus'),required:goal,waits,elapsedMs:Date.now()-lastProgress});
   // Only actual client block updates or real wall-clock polling wake this
   // scheduler. No age mutation, clock advance or XP calculation occurs.
   await sleep(Math.min(cfg.pollMs,remaining(end,cfg.pollMs)));active();waits++;observedUpdates+=rawBlocks-previous;
   if(progressed)lastProgress=Math.max(lastProgress,Date.now()-cfg.pollMs);
  }
  await native(()=>deps.returnCamp(anchor,{resource:'cactus',purpose:'renewable'}),'real renewable camp return',remaining(end,cfg.workMs));survival();
  if(!same(bot.entity.position.floored(),anchor)||bot.entity.onGround!==true||!dryBody(bot))throw fail('cactus_camp_unconfirmed','Actual camp return missing');
  const result={confirmed:true,actualAdditional:count('cactus')-before,before,after:count('cactus'),ownedColumns:state.columns.length,waits,observedRawBlockUpdates:observedUpdates,naturalGrowthTimingProven:false,source:'owned_native_renewal_with_actual_readback'};
  save({growthObservations:state.growthObservations+observedUpdates,lastSupply:result});return result;
  }finally{unwatch();}
 }
 async function exclusive(fn){if(running)throw fail('cactus_native_busy','One captured native farm job at a time');running=true;try{return await fn();}finally{running=false;}}
 return{plan:options=>{active();return planLoadedCactusSites(bot,options);},provision:o=>exclusive(()=>provision(o)),gather:(n,o)=>exclusive(()=>gather(n,o)),getState:()=>state&&copy(state)};
}
module.exports={createRenewableCactusProvider,findMatureNaturalColumns,planLoadedCactusSites,column,isOwnedRenewableCactusCancel};
