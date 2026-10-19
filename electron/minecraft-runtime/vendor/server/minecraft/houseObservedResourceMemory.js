/* global require, module */
'use strict';
const { Vec3 } = require('vec3');
const { loadedSurfaceFeet } = require('./houseSurfaceGraph');
const integer = p => p && ['x','y','z'].every(a => Number.isSafeInteger(p[a]));
const key = p => `${p.x},${p.y},${p.z}`;
const point = p => ({x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)});
const copy = v => JSON.parse(JSON.stringify(v));
const fail = (code,message,facts={}) => Object.assign(new Error(message),{code,...facts});
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createHouseObservedResourceMemory(deps, {resource,names,queryRadius=192,queryCandidates=24,queryBudgetMs=1000,maxEntries=128,cooldownMs=30000,stagnantLimit=3,guidedMoveLimit=8}={}) {
  if(typeof resource!=='string'||!resource||!Array.isArray(names)||!names.length||names.length>32
    ||names.some(n=>typeof n!=='string'||!n)||!Number.isSafeInteger(queryRadius)||queryRadius<1||queryRadius>192
    ||!Number.isSafeInteger(queryCandidates)||queryCandidates<1||queryCandidates>24
    ||!Number.isSafeInteger(queryBudgetMs)||queryBudgetMs<1||queryBudgetMs>1500
    ||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>128
    ||!Number.isSafeInteger(cooldownMs)||cooldownMs<1||cooldownMs>120000
    ||!Number.isSafeInteger(stagnantLimit)||stagnantLimit<1||stagnantLimit>8
    ||!Number.isSafeInteger(guidedMoveLimit)||guidedMoveLimit<1||guidedMoveLimit>16)throw fail('house_resource_memory_invalid','Observed resource memory requires finite native query and attempt bounds');
  for(const n of ['getBot','assertActive','isOwnerCurrent','getCP','saveCP','getGraphState','isExcludedPosition'])if(typeof deps[n]!=='function')throw fail('house_resource_memory_dependency',`Missing ${n}`);
  const bot=deps.getBot(),client=bot?._client,dimension=bot?.game?.dimension,wanted=new Set(names);
  const active=()=>{deps.assertActive();if(deps.getBot()!==bot||bot._client!==client||bot.game?.dimension!==dimension||deps.isOwnerCurrent()!==true)throw fail('house_resource_memory_owner_changed','Resource observation owner changed');};
  const now=()=>deps.now?deps.now():Date.now();
  const excluded=p=>p ? deps.isExcludedPosition(p)===true : false;
  const candidateAllowed=block=>typeof deps.isCandidateAllowed!=="function"||deps.isCandidateAllowed(block)===true;
  const old=deps.getCP();
  let state=old?copy(old):{schema:1,kind:'native_loaded_resource_memory',resource,names:[...wanted],entries:[],queries:0};
  if(!Number.isSafeInteger(state.sectionCursor??0)||(state.sectionCursor??0)<0||(state.sectionCursor??0)>65536||!Number.isSafeInteger(state.queries)||state.queries<0||state.schema!==1||state.kind!=='native_loaded_resource_memory'||state.resource!==resource||JSON.stringify(state.names)!==JSON.stringify([...wanted])||!Array.isArray(state.entries)||state.entries.length>maxEntries
    ||state.entries.some(e=>!integer(e.position)||!wanted.has(e.name)||e.kind!=='native_loaded_block_observation'||!Number.isFinite(e.observedAt)))throw fail('house_resource_memory_checkpoint_changed','Invalid original resource observation checkpoint');
  const save=()=>{active();deps.saveCP(copy(state));};
  const graphNode=()=>{const g=deps.getGraphState(),p=point(bot.entity.position),id=key(p);return g?.current===id&&g.order?.includes(id)&&integer(g.nodes?.[id]?.position)&&key(g.nodes[id].position)===id?id:null;};
  function surfaceObservation(block, origin, check=active) {
    const p=block?.position;if(!integer(p)||Math.abs(p.y-Math.floor(origin.y))>32)return null;
    const air=b=>b&&['air','cave_air','void_air'].includes(b.name);
    const sides=[{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}];
    if(!sides.some(d=>{check();return air(bot.blockAt(new Vec3(p.x+d.x,p.y,p.z+d.z)));}))return null;
    const approaches=[];
    for(const d of sides){check();const feet=loadedSurfaceFeet(bot,p.x+d.x,p.z+d.z,Math.floor(origin.y));check();
      for(const q of feet){if(excluded(q)||Math.abs(q.y-Math.floor(origin.y))>32)continue;
        const eye=new Vec3(q.x+.5,q.y+(bot.entity.eyeHeight||1.62),q.z+.5);
        if(eye.distanceTo(new Vec3(p.x+.5,p.y+.5,p.z+.5))<=4.4){approaches.push(point(q));break;}}
      if(approaches.length>=4)break;
    }
    return approaches.length?{plausibleApproaches:approaches,standingArrival:'NOT_CONFIRMED',scope:'exposed loaded surface within original plus/minus32 height range; approach only'}:null;
  }
  function query() {
    active();if(typeof bot.findBlocks!=='function')throw fail('house_resource_memory_native_query_missing','Original loaded findBlocks unavailable');
    const started=Date.now(),origin=bot.entity.position.clone(),seenFrom={x:origin.x,y:origin.y,z:origin.z},seenFromNode=graphNode();let positions,fullReads=0,paletteReads=0,sectionQueries=0,sectionReads=0,metadataCandidateCount=0,sectionScanTruncated=false,nextSectionCursor=state.sectionCursor||0;const eligible=new Map();
    const budget=()=>{active();if(Date.now()-started>queryBudgetMs)throw fail('house_resource_memory_query_budget','Finite native resource observation deadline expired');};
    const matching=block=>{budget();if(!block||!wanted.has(block.name))return false;
      // The native palette matcher has no position. It must keep matching
      // sections; full native block positions apply ownership exclusions before
      // count=24, so nearby protected structures cannot fill all result slots.
      if(!block.position){paletteReads++;return true;}fullReads++;if(!integer(block.position)||distance(origin,block.position)>queryRadius||excluded(block.position)||!candidateAllowed(block))return false;
      const id=key(block.position);if(!eligible.has(id))eligible.set(id,surfaceObservation(block,origin,budget));return Boolean(eligible.get(id));};
    try {
      const columns=bot.world?.async?.columns;
      if(columns&&typeof columns==='object') {
        // Read only client-resident section metadata. Original findBlocks does
        // not prune native SingleValue AIR sections (palette is undefined).
        // A generic loaded section center is never a resource coordinate.
        const all=Object.keys(columns);if(all.length>4096)throw fail('house_resource_memory_query_budget','Finite resident-column metadata budget exhausted');
        const Block=require('prismarine-block')(bot.registry),stateMatches=new Map(),sections=[];
        for(const columnKey of all){budget();const parts=columnKey.split(',').map(Number);if(parts.length!==2||parts.some(v=>!Number.isSafeInteger(v)))continue;
          const [cx,cz]=parts,nearest=new Vec3(Math.max(cx*16,Math.min(origin.x,cx*16+15.999)),origin.y,Math.max(cz*16,Math.min(origin.z,cz*16+15.999)));
          if(nearest.distanceTo(origin)>queryRadius)continue;const column=bot.world.getColumn(cx,cz);if(!column||!Array.isArray(column.sections)||column.sections.length>64)continue;
          for(let i=0;i<column.sections.length;i++){budget();if(++sectionReads>65536)throw fail('house_resource_memory_query_budget','Finite resident-section budget exhausted');
            const section=column.sections[i],center=new Vec3(cx*16+8,(column.minY??bot.game.minY)+i*16+8,cz*16+8);
            if(!section||center.distanceTo(origin)>queryRadius+14||Math.abs(center.y-origin.y)>48)continue;
            const palette=Array.isArray(section.palette)?section.palette:Number.isSafeInteger(section.data?.value)?[section.data.value]:null;
            let possible=palette===null;
            if(palette){if(palette.length>4096)possible=true;else for(const stateId of palette){budget();if(!stateMatches.has(stateId))stateMatches.set(stateId,wanted.has(Block.fromStateId(stateId).name));if(stateMatches.get(stateId)){possible=true;break;}}}
            // Unknown/direct palettes remain candidates, never presumed AIR.
            if(possible)sections.push({center,distance:center.distanceTo(origin)});
          }
        }
        sections.sort((a,b)=>a.distance-b.distance);metadataCandidateCount=sections.length;positions=[];const seen=new Set();
        for(let offset=0;offset<sections.length;offset++){budget();if(sectionQueries>=8||positions.length>=queryCandidates)break;
          const cursor=((state.sectionCursor||0)+offset)%sections.length,section=sections[cursor];sectionQueries++;nextSectionCursor=(cursor+1)%sections.length;
          const found=bot.findBlocks({point:section.center,maxDistance:14,count:queryCandidates-positions.length,useExtraInfo:false,matching});budget();
          if(!Array.isArray(found)||found.length>queryCandidates)throw fail('house_resource_memory_native_result_invalid','Original section query exceeded candidate bound');
          for(const raw of found){if(!integer(raw)||seen.has(key(raw)))continue;seen.add(key(raw));positions.push(raw);if(positions.length>=queryCandidates)break;}
          // One completed positive native section is enough to guide the next
          // actual leg. Preserve unqueried sections as UNKNOWN and advance the
          // finite cursor instead of discarding good facts after a later timeout.
          if(positions.length)break;
        }
        sectionScanTruncated=sectionQueries<sections.length;
      } else { positions=bot.findBlocks({point:origin,maxDistance:queryRadius,count:queryCandidates,useExtraInfo:false,matching});budget(); }
      if(!Array.isArray(positions)||positions.length>queryCandidates)throw fail('house_resource_memory_native_result_invalid','Native query exceeded original candidate bound');
      const observations=[];
      for(const raw of positions){budget();if(!integer(raw)||distance(origin,raw)>queryRadius||excluded(raw))continue;
        const block=bot.blockAt(new Vec3(raw.x,raw.y,raw.z));budget();
        if(!block||!wanted.has(block.name)||!integer(block.position)||key(block.position)!==key(raw)||excluded(block.position))continue;
        const surface=surfaceObservation(block,origin,budget);if(!surface)continue;
        const id=key(raw),existing=state.entries.find(e=>key(e.position)===id),stamp=now();
        observations.push({...existing,kind:'native_loaded_block_observation',position:point(raw),name:block.name,stateId:Number.isInteger(block.stateId)?block.stateId:null,
          observedAt:stamp,seenFrom,seenFromNode,...surface,status:'observed_only',resourceArrival:'NOT_CONFIRMED',
          cooldownUntil:existing?.cooldownUntil||0,guidedMoves:existing?.guidedMoves||0,stagnantApproaches:existing?.stagnantApproaches||0,
          bestDistance:Math.min(existing?.bestDistance??Infinity,distance(origin,raw)),rejections:existing?.rejections||[]});
      }
      active();const incoming=new Map(observations.map(e=>[key(e.position),e]));
      state.entries=[...observations,...state.entries.filter(e=>!incoming.has(key(e.position)))].slice(0,maxEntries);
      state.sectionCursor=nextSectionCursor;state.queries+=1;state.lastQuery={from:seenFrom,seenFromNode,radius:queryRadius,candidates:positions.length,confirmed:observations.length,elapsedMs:Date.now()-started,paletteReads,fullReads,sectionQueries,sectionReads,metadataCandidateCount,sectionQueryLimit:8,truncated:sectionScanTruncated,nextSectionCursor,settled:!sectionScanTruncated};save();
      return copy(state.lastQuery);
    } catch(error){if(error.code!=='house_resource_memory_query_budget')throw error;active();
      const facts={from:seenFrom,seenFromNode,radius:queryRadius,candidates:0,confirmed:0,elapsedMs:Date.now()-started,paletteReads,fullReads,settled:false,reason:'native_query_inconclusive'};
      state.sectionCursor=nextSectionCursor;state.queries+=1;state.lastQuery={...facts,truncated:true,nextSectionCursor};save();deps.onQuery?.(copy(state.lastQuery));return copy(state.lastQuery);}
  }
  function getTarget() {
    active();const stamp=now(),candidates=[];
    for(const entry of [...state.entries].sort((a,b)=>distance(bot.entity.position,a.position)-distance(bot.entity.position,b.position)).slice(0,24)){if(entry.cooldownUntil>stamp||excluded(entry.position)||distance(bot.entity.position,entry.position)>queryRadius)continue;
      const block=bot.blockAt(new Vec3(entry.position.x,entry.position.y,entry.position.z));active();
      // Unloaded and changed observations remain historical memory. They grant
      // no current guidance, movement, support or material success.
      if(!block||!wanted.has(block.name)||block.name!==entry.name||!integer(block.position)||key(block.position)!==key(entry.position)||excluded(block.position))continue;
      if(!surfaceObservation(block,bot.entity.position))continue; candidates.push({entry,distance:distance(bot.entity.position,entry.position)});
    }
    candidates.sort((a,b)=>a.distance-b.distance||b.entry.observedAt-a.entry.observedAt);
    const entry=candidates[0]?.entry;if(!entry)return null;
    return {kind:'native_loaded_block_observation',resource,key:key(entry.position),position:copy(entry.position),name:entry.name,lastValidatedAt:stamp,
      observedAt:entry.observedAt,seenFrom:copy(entry.seenFrom),seenFromNode:entry.seenFromNode,resourceArrival:'NOT_CONFIRMED'};
  }
  function getHistoricalHint() {
    active();const stamp=now(),g=deps.getGraphState(),origin=g?.anchor||bot.entity.position;
    for(const entry of [...state.entries].sort((a,b)=>distance(bot.entity.position,a.position)-distance(bot.entity.position,b.position))){
      if(!/_log$/.test(entry.name)||entry.cooldownUntil>stamp||excluded(entry.position)||distance(origin,entry.position)>384)continue;
      const block=bot.blockAt(new Vec3(entry.position.x,entry.position.y,entry.position.z));active();
      // A changed loaded block is negative evidence. Only an UNLOADED old
      // observation may provide a direction, never a live target or route.
      if(block)continue;
      return {kind:'recorded_natural_resource_hint',resource,key:key(entry.position),name:entry.name,
        position:copy(entry.position),observedAt:entry.observedAt,observationRecorded:true,
        currentPresence:'UNKNOWN',resourceArrival:'NOT_CONFIRMED'};
    }
    return null;
  }
  function getLoadedCandidates() {
    active();const stamp=now(),began=Date.now(),candidates=[];
    const budget=()=>{active();if(Date.now()-began>500)throw fail('house_resource_memory_query_budget','Finite current-candidate validation exhausted');};
    try {
      for(const entry of [...state.entries].sort((a,b)=>distance(bot.entity.position,a.position)-distance(bot.entity.position,b.position))){
        budget();if(candidates.length>=queryCandidates)break;if(entry.cooldownUntil>stamp||excluded(entry.position)||distance(bot.entity.position,entry.position)>queryRadius)continue;
        const block=bot.blockAt(new Vec3(entry.position.x,entry.position.y,entry.position.z));budget();
        if(!block||!wanted.has(block.name)||block.name!==entry.name||!integer(block.position)||key(block.position)!==key(entry.position)||excluded(block.position))continue;
        if(candidateAllowed(block)&&surfaceObservation(block,bot.entity.position,budget))candidates.push(block);
      }
    }catch(error){if(error.code!=='house_resource_memory_query_budget')throw error;active();}
    active();return candidates.sort((a,b)=>distance(bot.entity.position,a.position)-distance(bot.entity.position,b.position));
  }
  function defer(target,{reason='approach_inconclusive',probeStatus=null,probeConclusive=false,edge=null}={}) {
    active();const entry=state.entries.find(e=>key(e.position)===target?.key);if(!entry)return;
    entry.cooldownUntil=now()+cooldownMs;entry.rejections=[...entry.rejections,{observedAt:now(),reason,probeStatus,edge:edge?copy(edge):null,conclusiveNoPath:probeStatus==='noPath'&&probeConclusive===true}].slice(-16);
    entry.status='temporarily_deferred';save();
  }
  function observeApproach({target,actual,nodeKey}) {
    active();const entry=state.entries.find(e=>key(e.position)===target?.key),g=deps.getGraphState();
    if(!entry)return;if(!integer(actual)||nodeKey!==key(actual)||g?.current!==nodeKey||!g.order?.includes(nodeKey)||key(g.nodes?.[nodeKey]?.position||{})!==nodeKey
      ||key(point(bot.entity.position))!==nodeKey||bot.entity.onGround!==true)throw fail('house_resource_memory_approach_unconfirmed','A plan is not an actual observed resource approach');
    const d=distance(bot.entity.position,entry.position);entry.stagnantApproaches=d<entry.bestDistance-1?0:entry.stagnantApproaches+1;entry.bestDistance=Math.min(entry.bestDistance,d);entry.guidedMoves+=1;
    entry.lastApproach={position:copy(actual),nodeKey,distance:d,observedAt:now(),resourceArrival:'NOT_CONFIRMED'};
    if(entry.stagnantApproaches>=stagnantLimit||entry.guidedMoves>=guidedMoveLimit){entry.cooldownUntil=now()+cooldownMs;entry.guidedMoves=0;entry.stagnantApproaches=0;entry.status='temporarily_deferred';}
    save();
  }
  return {query,getTarget,getHistoricalHint,getLoadedCandidates,defer,observeApproach,getState:()=>{active();return copy(state);}};
}
module.exports={createHouseObservedResourceMemory};
