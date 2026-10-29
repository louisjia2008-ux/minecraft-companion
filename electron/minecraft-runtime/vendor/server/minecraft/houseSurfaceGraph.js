/* global require, module, setTimeout, clearTimeout */
'use strict';
const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { Physics, PlayerState } = require('prismarine-physics');
const { validateHouseSurfaceTransport } = require('./houseSurfaceTransport');
const { isNaturalWalkingBodyBlock, isNaturalWalkingBodyFact, isNaturalWalkingBodyName } = require('./houseNaturalWalkingBody');
const { classifyMiningBlock } = require('./miningNavigation');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARD = new Set(['water', 'lava', 'bubble_column', 'magma_block', 'fire', 'soul_fire', 'cactus', 'powder_snow', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose']);
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const plain = p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const vec = p => new Vec3(p.x, p.y, p.z);
const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, facts = {}) => Object.assign(new Error(message), { code, ...facts });
const vegetation = block => /_(?:log|leaves)$/.test(block.name) || block.boundingBox === 'empty';
const safeBlock = block => block && !HAZARD.has(block.name) && ![true, 'true'].includes(block.getProperties?.().waterlogged);
const supported = block => safeBlock(block) && block.boundingBox === 'block' && block.shapes?.some(shape => shape[4] === 1);
const surfaceEdgeFrames = new WeakMap();
const surfaceEdgeFact = block => (block?.name==='powder_snow'?1:0) |
  (block?.name==='lava'?2:0) | (block?.name==='water'&&![0,'0'].includes(block.getProperties?.().level)?4:0);
function stableDryFloor(bot, position) {
  for(let depth=1;depth<=17;depth++){
    const b=bot.blockAt(vec(position).offset(0,-depth,0)),cell=classifyMiningBlock(b);
    if(cell.support)return true;
    if(!cell.gravity||cell.hazard||!b?.shapes?.some(s=>s.length===6&&s.every((n,i)=>n===(i<3?0:1))))return false;
  }
  return false;
}
function avoidsKnownPowderSnowEdge(bot, position) {
  if (!position || !['x', 'y', 'z'].every(k => Number.isFinite(position[k]))) return false;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (bot.blockAt(vec(position).offset(dx, -1, dz))?.name === 'powder_snow') return false;
  }
  return true;
}
function avoidsKnownSurfaceHazardEdge(bot, position) {
  if (!position || !['x','y','z'].every(k=>Number.isFinite(position[k]))) return false;
  const foot=vec(position);let floorStable;
  for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++){
    const fact=surfaceEdgeFact(bot.blockAt(foot.offset(dx,dy,dz)));
    if(dy===-1&&(fact&1))return false;
    if(fact&2)return false;
    // Water below a proved solid walking floor cannot touch a dry body.
    // Keep flowing water at feet/head height excluded, including the saved
    // whole41 falling-edge failure; this grants no swimming capability.
    if(fact&4){if(dy!==-1)return false;floorStable??=stableDryFloor(bot,foot);if(!floorStable)return false;}
  }
  return true;
}
function createSurfaceHazardEdgePolicy(bot) {
  let frame=surfaceEdgeFrames.get(bot);
  if(!frame){
    frame={facts:new Map(),edges:new Map(),floors:new Map(),epoch:0,pending:false,bound:new Set()};
    frame.invalidate=()=>{frame.epoch++;frame.facts.clear();frame.edges.clear();frame.floors.clear();};
    surfaceEdgeFrames.set(bot,frame);
  }
  for(const event of ['blockUpdate','chunkColumnLoad','chunkColumnUnload','physicsTick']){
    if(typeof bot.on==='function'&&(!frame.bound.has(event)||typeof bot.listeners==='function'&&!bot.listeners(event).includes(frame.invalidate))){bot.on(event,frame.invalidate);frame.bound.add(event);}
  }
  return position=>{
    if(!position||!['x','y','z'].every(k=>Number.isFinite(position[k])))return false;
    if(frame.read!==bot.blockAt||frame.world!==bot.world||frame.client!==bot._client||frame.dimension!==bot.game?.dimension){
      frame.invalidate();frame.read=bot.blockAt;frame.world=bot.world;frame.client=bot._client;frame.dimension=bot.game?.dimension;
    }
    // A synchronous native planning slice observes one world state. Never
    // carry these geometry facts into another microtask, physics tick, block
    // update, chunk event or connection. Permission/owner checks stay uncached.
    if(!frame.pending){frame.pending=true;queueMicrotask(()=>{frame.pending=false;frame.invalidate();});}
    const id=key(position);if(frame.edges.has(id))return frame.edges.get(id);
    if(frame.edges.size>=512||frame.facts.size>=4096){frame.edges.clear();frame.facts.clear();frame.floors.clear();}
    const epoch=frame.epoch,foot=vec(plain(position));let allowed=true;
    outer:for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(let dy=-1;dy<=1;dy++){
      const p=foot.offset(dx,dy,dz),k=key(p);
      if(!frame.facts.has(k)){
        if(frame.facts.size>=4096){frame.facts.clear();frame.edges.clear();}
        frame.facts.set(k,surfaceEdgeFact(bot.blockAt(p)));
      }
      const fact=frame.facts.get(k);if((dy===-1&&(fact&1))||(fact&2)){allowed=false;break outer;}
      if(fact&4){
        if(dy!==-1){allowed=false;break outer;}
        if(!frame.floors.has(id))frame.floors.set(id,stableDryFloor(bot,foot));
        if(!frame.floors.get(id)){allowed=false;break outer;}
      }
    }
    if(frame.epoch!==epoch||frame.read!==bot.blockAt||frame.world!==bot.world||frame.client!==bot._client||frame.dimension!==bot.game?.dimension)return false;
    frame.edges.set(id,allowed);return allowed;
  };
}
function getSurfaceGraphProtectedPositions(state) {
  const positions = new Map();
  const add = p => { if (p && ['x','y','z'].every(axis => Number.isSafeInteger(p[axis]))) positions.set(key(p), { ...p }); };
  // Reserving a captured pending route prevents recursive food/tool work from
  // digging its bank or bed. Protection does not credit an uncompleted visit.
  const pending = state?.pendingWater?.edge;
  for (const node of [...Object.values(state?.nodes || {}), ...(pending ? [pending] : [])]) {
    if (node.position) add({ ...node.position, y: node.position.y - 1 });
    for (const p of node.supportPositions || []) add(p);
    for (const point of node.dryParentTrail?.points || []) for (const support of point.supports || []) add(support.position);
    const route = node.transport?.route;
    const shallow = route?.kind === 'loaded_source_water_wade' && route.depth === 1;
    const surface = route?.kind === 'loaded_surface_swim' && route.depth === 'surface_only';
    if (!(shallow || surface) || !Number.isSafeInteger(route.width)
      || route.width < 1 || route.width > (surface ? 64 : 12) || !route.direction || Math.abs(route.direction.x) + Math.abs(route.direction.z) !== 1) continue;
    const d = route.direction, tangent = { x: -d.z, z: d.x };
    for (const p of [route.from, route.to]) if (p) for (let down = 1; down <= 4; down++) add({ ...p, y: p.y - down });
    for (let i = 0; i < route.width; i++) for (let j = -1; j <= 1; j++) for (let down = surface ? 1 : 2; down <= (surface ? 1 : 5); down++) {
      add({ x: route.waterStart?.x + d.x * i + tangent.x * j,
        y: route.surfaceY - down, z: route.waterStart?.z + d.z * i + tangent.z * j });
    }
  }
  for (const point of state?.pendingDryTrail?.confirmedPrefix || []) for (const support of point.supports || []) add(support.position);
  return [...positions.values()];
}
function dryFoot(bot, p) {
  return [bot.blockAt(vec(p)), bot.blockAt(vec(p).offset(0, 1, 0))].every(b => safeBlock(b) && AIR.has(b.name)) && supported(bot.blockAt(vec(p).offset(0, -1, 0)));
}
function naturalWalkingFoot(bot, p) {
  return [bot.blockAt(vec(p)), bot.blockAt(vec(p).offset(0, 1, 0))].every(b => safeBlock(b) && isNaturalWalkingBodyBlock(b))
    && supported(bot.blockAt(vec(p).offset(0, -1, 0)));
}
function blockFact(block, position) {
  return { position: plain(position), loaded: Boolean(block), name: block?.name || null,
    stateId: Number.isInteger(block?.stateId) ? block.stateId : null,
    waterlogged: block?.getProperties?.().waterlogged ?? null, level: block?.getProperties?.().level ?? null,
    layers: block?.getProperties?.().layers ?? null,
    boundingBox: block?.boundingBox ?? null, shapes: Array.isArray(block?.shapes) ? block.shapes.map(shape => [...shape]) : null };
}
function inspectSurfaceBody(bot) {
  const e = bot.entity, p = e?.position, width = e?.width ?? 0.6, height = e?.height ?? 1.8;
  const facts = { dry: false, isInWater: e?.isInWater ?? null, isInLava: e?.isInLava ?? null, cells: [] };
  if (!p || !['x', 'y', 'z'].every(k => Number.isFinite(p[k])) || !Number.isFinite(width) || width <= 0 || width > 1
    || !Number.isFinite(height) || height <= 0 || height > 2) return facts;
  const half = width / 2;
  let dry = e.isInWater === false && e.isInLava === false;
  for (let x = Math.floor(p.x - half + 1e-8); x <= Math.floor(p.x + half - 1e-8); x++) {
    for (let z = Math.floor(p.z - half + 1e-8); z <= Math.floor(p.z + half - 1e-8); z++) {
      for (let y = Math.floor(p.y); y <= Math.floor(p.y + height - 1e-8); y++) {
        const position = new Vec3(x, y, z), block = bot.blockAt(position);
        facts.cells.push(blockFact(block, position));
        if (!safeBlock(block) || (block?.boundingBox === 'empty' || isNaturalWalkingBodyName(block?.name)) && !isNaturalWalkingBodyBlock(block)) dry = false;
      }
    }
  }
  facts.dry = dry;
  return facts;
}
function bodyShapeSupports(bot, minY, maxY, minimumTop = -Infinity, maximumGap = 2) {
  const p = bot.entity?.position, width = bot.entity?.width ?? 0.6;
  if (!p || !['x', 'y', 'z'].every(k => Number.isFinite(p[k])) || !Number.isFinite(width) || width <= 0 || width > 1) return [];
  const half = width / 2, contacts = [];
  for (let x = Math.floor(p.x - half + 1e-8); x <= Math.floor(p.x + half - 1e-8); x++) {
    for (let z = Math.floor(p.z - half + 1e-8); z <= Math.floor(p.z + half - 1e-8); z++) {
      for (let y = minY; y <= maxY; y++) {
        const position = new Vec3(x, y, z), block = bot.blockAt(position);
        if (!safeBlock(block) || block.boundingBox !== 'block') continue;
        for (const shape of block.shapes || []) {
          const top = y + shape[4];
          const overlapX = Math.min(p.x + half, x + shape[3]) - Math.max(p.x - half, x + shape[0]);
          const overlapZ = Math.min(p.z + half, z + shape[5]) - Math.max(p.z - half, z + shape[2]);
          if (overlapX > 1e-8 && overlapZ > 1e-8 && top >= minimumTop - 1e-6 && top <= p.y + 1e-6 && p.y - top <= maximumGap
            && contacts.length < 12) contacts.push({ ...blockFact(block, position), top, gap: p.y - top, overlapX, overlapZ });
        }
      }
    }
  }
  return contacts;
}
// A native player can remain grounded while its center crossed a ledge.
// Require actual body/shape contact, never infer support from onGround alone.
function hasGroundedBodySupport(bot) {
  const p = bot.entity?.position;
  return bot.entity?.onGround === true && inspectSurfaceBody(bot).dry
    && bodyShapeSupports(bot, Math.floor(p.y - 0.075) - 1, Math.floor(p.y), -Infinity, 0.075).length > 0;
}
const DRY_TRAIL_LIMIT = 128;
function dryTrailHop(a, b) {
  return Math.hypot(a.x-b.x,a.z-b.z)<=3 && Math.abs(a.y-b.y)<=2 && key(a)!==key(b);
}
function validDryParentTrail(trail, nodes, childId) {
  const integer=p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k]));
  const child=nodes[childId], parent=child?.parent;
  if (!trail || trail.schema!==1 || trail.kind!=='actual_successful_dry_parent_edge' || trail.complete!==true || child?.transport
    || !parent || !nodes[parent] || ![parent,childId].includes(trail.from) || ![parent,childId].includes(trail.to) || trail.from===trail.to
    || !Array.isArray(trail.points) || trail.points.length<2 || trail.points.length>DRY_TRAIL_LIMIT
    || key(trail.points[0]?.position||{})!==trail.from || key(trail.points.at(-1)?.position||{})!==trail.to) return false;
  return trail.points.every((p,i)=>integer(p.position) && p.actual && ['x','y','z'].every(k=>Number.isFinite(p.actual[k]))
    && Math.floor(p.actual.x)===p.position.x && Math.floor(p.actual.z)===p.position.z && Math.abs(p.actual.y-p.position.y)<=.07
    && Array.isArray(p.supports) && p.supports.length>0 && p.supports.length<=12
    && p.supports.every(s=>integer(s.position)&&Number.isSafeInteger(s.stateId)&&s.stateId>=0)
    && (!i || dryTrailHop(trail.points[i-1].position,p.position)));
}
function inspectShoreSupport(bot, { tick = 0, lastGrounded = null, body = inspectSurfaceBody(bot) } = {}) {
  const e = bot.entity, p = e?.position;
  const facts = { accepted: false, reason: 'body_not_dry', physicsTick: tick, lastGrounded: lastGrounded ? copy(lastGrounded) : null,
    body, below: null, sourceWater: null, selectedBelowDy: null, belowSearch: [], supports: [] };
  if (!body.dry) return facts;
  const foot = p.floored();
  let sourcePosition = null;
  for (const dy of [1, 2]) {
    const position = foot.offset(0, -dy, 0), block = bot.blockAt(position), fact = blockFact(block, position);
    facts.belowSearch.push(fact);
    if (dy === 1) facts.below = fact;
    if (safeBlock(block) && AIR.has(block.name)) continue;
    if (block?.name === 'water' && [0, '0'].includes(block.getProperties?.().level) && position.y + 1 <= p.y + 1e-6) {
      sourcePosition = position; facts.sourceWater = fact; facts.selectedBelowDy = dy;
    }
    break;
  }
  if (!sourcePosition) { facts.reason = 'below_not_loaded_source_water'; return facts; }
  // Only the original below1/below2 range is inspected. The shore must stay
  // above the water surface and actually overlap the body's horizontal AABB.
  facts.supports = bodyShapeSupports(bot, foot.y - 2, foot.y - 1, sourcePosition.y + 1, 2);
  if (!facts.supports.length) { facts.reason = 'no_dry_shore_shape'; return facts; }
  if (e.onGround === true) {
    facts.accepted = facts.supports.some(support => support.gap <= 0.075);
    facts.reason = facts.accepted ? 'grounded_shore_contact' : 'grounded_without_contact'; return facts;
  }
  const v = e.velocity;
  if (e.onGround !== false || !lastGrounded || !Number.isInteger(lastGrounded.tick) || !lastGrounded.contacts?.length
    || !['x', 'y', 'z'].every(k => Number.isFinite(lastGrounded.position?.[k]))) {
    facts.reason = 'airborne_without_grounded_proof'; return facts;
  }
  facts.ticksSinceGrounded = tick - lastGrounded.tick;
  facts.horizontalFromGrounded = Math.hypot(p.x - lastGrounded.position.x, p.z - lastGrounded.position.z);
  if (facts.ticksSinceGrounded < 0 || facts.ticksSinceGrounded > 16 || facts.horizontalFromGrounded > 1.75
    || !v || !['x', 'y', 'z'].every(k => Number.isFinite(v[k])) || v.y < -0.9 || v.y > 0.43) {
    facts.reason = 'airborne_shore_limit'; return facts;
  }
  facts.accepted = true; facts.reason = 'bounded_native_jump_over_shore'; return facts;
}
// A falling native body can straddle the edge of a lower dry block while
// its center column is air. This narrowly checks a one-level descent, without
// reclassifying the actor as grounded or applying a predicted PlayerState.
function inspectDryDescentSupport(bot, { tick = 0, lastGrounded = null, body = inspectSurfaceBody(bot) } = {}) {
  const e = bot.entity, p = e?.position, v = e?.velocity;
  const facts = { accepted: false, reason: 'descent_state_unconfirmed', physicsTick: tick,
    supports: [], predictions: [], reads: 0, actualGrounded: false, predictionApplied: false };
  if (!body.dry || !body.cells.length || body.cells.some(c => !isNaturalWalkingBodyFact(c)) || e.onGround !== false
    || !p || !v || !['x','y','z'].every(k => Number.isFinite(p[k]) && Number.isFinite(v[k]))
    || !Number.isFinite(e.yaw) || !Number.isFinite(e.pitch) || v.y > 0 || v.y < -.5 || Math.hypot(v.x, v.z) > .25
    || !Number.isSafeInteger(tick) || !Number.isSafeInteger(lastGrounded?.tick)
    || !lastGrounded.contacts?.length || !['x','y','z'].every(k => Number.isFinite(lastGrounded.position?.[k]))) return facts;
  facts.ticksSinceGrounded = tick - lastGrounded.tick;
  facts.horizontalFromGrounded = Math.hypot(p.x - lastGrounded.position.x, p.z - lastGrounded.position.z);
  facts.descentFromGrounded = lastGrounded.position.y - p.y;
  if (facts.ticksSinceGrounded < 0 || facts.ticksSinceGrounded > 8 || facts.horizontalFromGrounded > 1.5
    || facts.descentFromGrounded < -1e-6 || facts.descentFromGrounded > 1.05) {
    facts.reason = 'descent_recent_ground_limit'; return facts;
  }
  const controls = {};
  for (const name of ['forward','back','left','right','jump','sprint','sneak']) {
    if (typeof bot.controlState?.[name] !== 'boolean') { facts.reason = 'descent_controls_unknown'; return facts; }
    controls[name] = bot.controlState[name];
  }
  const cache = new Map();
  const loaded = Object.create(bot);
  loaded.blockAt = raw => {
    const q = raw.floored(), id = key(q);
    if (cache.has(id)) return cache.get(id);
    if (cache.size >= 512) throw fail('dry_descent_read_limit', 'Finite native descent observation budget exhausted');
    const b = bot.blockAt(q); facts.reads++;
    if (!safeBlock(b)) throw fail('dry_descent_unknown_or_hazard', 'Prediction cannot borrow unknown or hazardous cells');
    cache.set(id, b); return b;
  };
  try {
    const foot = p.floored();
    // Center clearance can contain verified noncolliding terrestrial flora.
    // Flora supplies no landing contact; the full-cube/native prediction below
    // still has to establish a bounded landing on the actual lower support.
    for (const dy of [1,2]) if (!isNaturalWalkingBodyBlock(loaded.blockAt(foot.offset(0,-dy,0)))) {
      facts.reason = 'descent_center_not_dry_clearance'; return facts;
    }
    // The recent actual contact must still exist. A collapsed old ledge cannot
    // be used to authorize an airborne route over a newly opened shaft.
    if (!lastGrounded.contacts.every(c => {
      const b = loaded.blockAt(vec(c.position));
      return b.stateId === c.stateId && supported(b) && b.shapes.some(shape =>
        Math.abs(c.position.y + shape[4] - c.top) <= 1e-6);
    })) { facts.reason = 'descent_old_support_changed'; return facts; }
    facts.supports = bodyShapeSupports(loaded, foot.y - 2, foot.y - 1, lastGrounded.position.y - 1, .5)
      .filter(c => loaded.blockAt(vec(c.position)).shapes.some(shape => shape.length === 6
        && shape.every((value, i) => value === (i < 3 ? 0 : 1))));
    if (!facts.supports.length) { facts.reason = 'descent_no_loaded_lower_contact'; return facts; }
    const state = new PlayerState(bot, controls);
    // Installed Physics modifies attribute modifier arrays. Prediction must
    // operate on its own copy, as it does for cloned position and velocity.
    state.attributes = copy(state.attributes || {});
    const world = { getBlock: loaded.blockAt }, physics = Physics(bot.registry, world);
    for (let n = 1; n <= 2; n++) {
      physics.simulatePlayer(state, world);
      const projected = Object.create(loaded);
      projected.entity = { ...e, position: state.pos, velocity: state.vel, onGround: state.onGround,
        isInWater: state.isInWater, isInLava: state.isInLava };
      const projectedBody = inspectSurfaceBody(projected), contacts = bodyShapeSupports(projected,
        Math.floor(state.pos.y - .075) - 1, Math.floor(state.pos.y), lastGrounded.position.y - 1, .075);
      const sameFloor = contacts.some(c => facts.supports.some(s => key(c.position) === key(s.position)
        && c.stateId === s.stateId && Math.abs(c.top - s.top) <= 1e-6));
      facts.predictions.push({ tick: n, position: { x: state.pos.x, y: state.pos.y, z: state.pos.z },
        onGround: state.onGround === true, bodyDry: projectedBody.dry, sameFloor, contacts });
      if (!projectedBody.dry || state.isInWater || state.isInLava) {
        facts.reason = 'descent_prediction_not_dry'; return facts;
      }
      if (state.onGround === true && sameFloor) {
        facts.accepted = true; facts.reason = 'bounded_native_lower_edge_prediction'; return facts;
      }
    }
    facts.reason = 'descent_native_landing_unconfirmed';
  } catch (error) { facts.reason = error.code || 'descent_prediction_unavailable'; }
  return facts;
}
// A deliberate short drop may take ordinary Survival damage. Simulate the
// installed physics on a detached state; only an observed dry landing can
// authorize continued native falling, never a position/velocity write.
function inspectControlledDropSupport(bot, { tick, lastGrounded, body = inspectSurfaceBody(bot),
  assertActive = () => {}, isOwnerCurrent = () => true, excluded = () => false, maximumControlledDrop = 5 } = {}) {
  const facts = { accepted: false, reason: 'drop_unconfirmed', predictionApplied: false, predictions: [] };
  const e = bot.entity, p = e?.position, v = e?.velocity;
  if (!Number.isInteger(maximumControlledDrop) || maximumControlledDrop < 1 || maximumControlledDrop > 5) return facts;
  if (!body.dry || !p || !v || typeof e.onGround !== 'boolean' || hasGroundedBodySupport(bot) || !lastGrounded?.contacts?.length
    || !Number.isSafeInteger(tick) || !Number.isSafeInteger(lastGrounded.tick)
    || tick-lastGrounded.tick < 0 || tick-lastGrounded.tick > 24
    || ![p.x,p.y,p.z,v.x,v.y,v.z].every(Number.isFinite) || v.y > 0 || v.y < -1.5
    || Math.hypot(v.x,v.z) > .25 || Math.hypot(p.x-lastGrounded.position.x,p.z-lastGrounded.position.z)>3
    || lastGrounded.position.y-p.y < 0 || lastGrounded.position.y-p.y > maximumControlledDrop+.05
    || !Number.isFinite(bot.health) || bot.health <= 0) return facts;
  const check = () => { assertActive(); if (!isOwnerCurrent()) throw fail('dry_graph_movement_preempted','Drop lost its owner'); };
  const controls = {};
  for (const name of ['forward','back','left','right','jump','sprint','sneak']) {
    if (typeof bot.controlState?.[name] !== 'boolean') return facts;
    controls[name] = bot.controlState[name];
  }
  let reads=0;
  const view=Object.create(bot);
  view.blockAt=q=>{ check(); if (++reads>2048 || excluded(q)) throw fail('drop_read_limit','Unknown or protected drop corridor');
    const b=bot.blockAt(q);
    // Native fluid-state sampling reads neighboring water too. Preserve that
    // real environment data; projected body/state and dry landing checks below
    // still deny entering water. Other hazards and unknown reads remain denied.
    if (!safeBlock(b) && b?.name!=='water') throw fail('drop_unknown_or_hazard','Drop corridor is unknown or hazardous'); return b; };
  try {
    check();
    if (!lastGrounded.contacts.every(c=>view.blockAt(vec(c.position)).stateId===c.stateId)) return facts;
    const state=new PlayerState(bot,controls); state.attributes=copy(state.attributes||{});
    const world={getBlock:view.blockAt},physics=Physics(bot.registry,world);
    for(let n=1;n<=24;n++) {
      check();const before=state.pos.clone();physics.simulatePlayer(state,world);
      const projected=Object.create(view);projected.entity={...e,position:state.pos,velocity:state.vel,onGround:state.onGround};
      const drop=lastGrounded.position.y-state.pos.y;
      if (drop>maximumControlledDrop+.05 || Math.hypot(state.pos.x-lastGrounded.position.x,state.pos.z-lastGrounded.position.z)>3
        || !inspectSurfaceBody(projected).dry || state.isInWater || state.isInLava) return facts;
      facts.predictions.push({tick:n,position:{x:state.pos.x,y:state.pos.y,z:state.pos.z},onGround:state.onGround===true});
      if(state.onGround) {
        const damage=Math.max(0,Math.ceil(drop-3));
        facts.drop=drop;facts.maximumExpectedDamage=damage;
        // Budget conservative unarmored fall damage against actual health.
        // A harmless ledge departure does not require17HP. Keep at least one
        // health point, or the actual lower fractional health for a zero-damage
        // landing. No armor, enchantment or water credit.
        // Native onGround can remain true for the tick whose horizontal
        // motion has already left a narrow intermediate ledge. Continue the
        // same bounded prediction until actual AABB support exists; the next
        // drop still spends the original total height/damage/read budget.
        if (!hasGroundedBodySupport(projected)) {
          facts.unconfirmedGroundTicks=(facts.unconfirmedGroundTicks||0)+1;
          // Installed vanilla physics resolves vertical collision before X/Z.
          // A real collision on a narrow step can precede the same tick's
          // horizontal departure. Verify its loaded shape at that collision
          // position instead of treating onGround alone as a landing proof.
          const verticalContact=Object.create(view);
          verticalContact.entity={...projected.entity,position:new Vec3(before.x,state.pos.y,before.z)};
          if (!hasGroundedBodySupport(verticalContact)) continue;
          facts.verticalContactBeforeHorizontal={x:before.x,y:state.pos.y,z:before.z};
        }
        if(drop>=0 && bot.health-damage>=Math.min(1,bot.health)) {
          check();facts.accepted=true;facts.reason='bounded_survivable_native_drop';
        }
        return facts;
      }
    }
  } catch(error) { facts.reason=error.code||'drop_prediction_unavailable'; }
  return facts;
}
// Normal native jumps can begin on a genuine AABB edge contact while their
// center column already sees only air. Require that recent real contact and
// a bounded installed-Physics landing witness, without applying PlayerState.
function inspectDryJumpSupport(bot, { tick = 0, lastGrounded = null, body = inspectSurfaceBody(bot),
  isOwnerCurrent = () => true, assertActive = () => {}, excluded = () => false, allowSteppedJump = false } = {}) {
  const e = bot.entity, p = e?.position, v = e?.velocity;
  const facts = { accepted: false, reason: 'jump_state_unconfirmed', physicsTick: tick,
    supports: [], predictions: [], reads: 0, actualGrounded: false, predictionApplied: false };
  if (!body.dry || !body.cells.length || body.cells.some(c => !isNaturalWalkingBodyFact(c)) || e.onGround !== false
    || !p || !v || !['x','y','z'].every(k => Number.isFinite(p[k]) && Number.isFinite(v[k]))
    || !Number.isFinite(e.yaw) || !Number.isFinite(e.pitch) || v.y > .43 || v.y < -.5 || Math.hypot(v.x, v.z) > .25
    || !Number.isSafeInteger(tick) || !Number.isSafeInteger(lastGrounded?.tick)
    || !lastGrounded.contacts?.length || !['x','y','z'].every(k => Number.isFinite(lastGrounded.position?.[k]))) return facts;
  facts.ticksSinceGrounded = tick - lastGrounded.tick;
  facts.horizontalFromGrounded = Math.hypot(p.x - lastGrounded.position.x, p.z - lastGrounded.position.z);
  facts.heightFromGrounded = p.y - lastGrounded.position.y;
  const maximumHeight = allowSteppedJump && facts.heightFromGrounded > 1.3 && v.y <= .1 ? 2.3 : 1.3;
  if (facts.ticksSinceGrounded < 1 || facts.ticksSinceGrounded > 16 || facts.horizontalFromGrounded > 1.75
    || facts.heightFromGrounded < -1e-6 || facts.heightFromGrounded > maximumHeight) {
    facts.reason = 'jump_recent_ground_limit'; return facts;
  }
  const controls = {};
  for (const name of ['forward','back','left','right','jump','sprint','sneak']) {
    if (typeof bot.controlState?.[name] !== 'boolean') { facts.reason = 'jump_controls_unknown'; return facts; }
    controls[name] = bot.controlState[name];
  }
  const check = () => { assertActive(); if (!isOwnerCurrent()) throw fail('dry_graph_movement_preempted', 'Jump observation lost its captured movement owner'); };
  const fullCube = b => supported(b) && b.shapes.some(shape => shape.length === 6
    && shape.every((value, i) => value === (i < 3 ? 0 : 1)));
  // Native dirt paths/farmland have a full footprint but a 15/16 top.
  // This remains a support-only fact; body clearance is never granted.
  const fractionalSupport = b => safeBlock(b)&&['dirt_path','farmland'].includes(b.name)
    &&b.shapes?.length===1&&b.shapes[0].every((n,i)=>n===[0,0,0,1,15/16,1][i]);
  const walkingSupport = b => fullCube(b)||fractionalSupport(b);
  const cache = new Map(), loaded = Object.create(bot);
  loaded.blockAt = raw => {
    check();
    const q = raw.floored(), id = key(q);
    if (cache.has(id)) return cache.get(id);
    if (cache.size >= 512) throw fail('dry_jump_read_limit', 'Finite native jump observation budget exhausted');
    const b = bot.blockAt(q); facts.reads++; check();
    if (!safeBlock(b)) throw fail('dry_jump_unknown_or_hazard', 'Jump prediction requires every queried cell to be loaded and safe');
    cache.set(id, b); return b;
  };
  try {
    check();
    const foot = p.floored();
    for (const dy of [1,2]) {
      const below=loaded.blockAt(foot.offset(0,-dy,0));
      if(!isNaturalWalkingBodyBlock(below)&&!(fractionalSupport(below)
        &&below.position.y+15/16<=p.y&&p.y-(below.position.y+15/16)<=1.3+1/16)){
        facts.reason = 'jump_center_not_dry_clearance'; return facts;
      }
    }
    if (!lastGrounded.contacts.every(c => {
      const b = loaded.blockAt(vec(c.position));
      return b.stateId === c.stateId && walkingSupport(b) && Number.isFinite(c.top)
        && Math.abs(c.top - lastGrounded.position.y) <= .075
        && b.shapes.some(shape => Math.abs(c.position.y + shape[4] - c.top) <= 1e-6);
    })) { facts.reason = 'jump_old_support_changed'; return facts; }
    facts.supports = bodyShapeSupports(loaded, foot.y - 2, foot.y - 1, lastGrounded.position.y - 1, 1.3)
      .filter(c => walkingSupport(loaded.blockAt(vec(c.position))));
    if (!facts.supports.length) { facts.reason = 'jump_no_loaded_edge_contact'; return facts; }
    const state = new PlayerState(bot, controls);
    state.attributes = copy(state.attributes || {});
    const world = { getBlock: loaded.blockAt }, physics = Physics(bot.registry, world);
    for (let n = 1; n <= 16; n++) {
      check(); physics.simulatePlayer(state, world); check();
      const horizontal = Math.hypot(state.pos.x - lastGrounded.position.x, state.pos.z - lastGrounded.position.z);
      if (horizontal > 2.5 || state.pos.y < lastGrounded.position.y - 1.05 || state.pos.y > lastGrounded.position.y + maximumHeight
        || excluded(plain(state.pos))) { facts.reason = 'jump_prediction_outside_edge_limit'; return facts; }
      const projected = Object.create(loaded);
      projected.entity = { ...e, position: state.pos, velocity: state.vel, onGround: state.onGround,
        isInWater: state.isInWater, isInLava: state.isInLava };
      const projectedBody = inspectSurfaceBody(projected), contacts = bodyShapeSupports(projected,
        Math.floor(state.pos.y - .075) - 1, Math.floor(state.pos.y), lastGrounded.position.y - 1, .075)
        .filter(c => walkingSupport(loaded.blockAt(vec(c.position))) && c.top <= lastGrounded.position.y + 1 + (lastGrounded.contacts.some(contact => fractionalSupport(loaded.blockAt(vec(contact.position)))) ? 1/16 : 0) + 1e-6
          && !excluded({ ...c.position, y: c.top }));
      facts.predictions.push({ tick: n, position: { x: state.pos.x, y: state.pos.y, z: state.pos.z },
        onGround: state.onGround === true, bodyDry: projectedBody.dry, contacts });
      if (!projectedBody.dry || projectedBody.cells.some(c => !isNaturalWalkingBodyFact(c)
        &&!(fractionalSupport(loaded.blockAt(vec(c.position)))&&c.position.y+15/16<=state.pos.y+1e-6)) || state.isInWater || state.isInLava) {
        facts.reason = 'jump_prediction_not_dry'; return facts;
      }
      if (state.onGround === true && contacts.length) {
        check(); facts.accepted = true; facts.reason = 'bounded_native_dry_jump_landing'; return facts;
      }
    }
    facts.reason = 'jump_native_landing_unconfirmed';
  } catch (error) { facts.reason = error.code || 'jump_prediction_unavailable'; }
  return facts;
}
function loadedSurfaceFeet(bot, x, z, fromY, { up = 32, down = 32 } = {}) {
  const top = Math.floor(fromY) + up, bottom = Math.floor(fromY) - down, result = [], column = new Map();
  for (let y = bottom - 1; y <= top + 1; y++) column.set(y, bot.blockAt(new Vec3(x, y, z)));
  // Scan from the real loaded column top. A dry cave below water, unknown
  // data or a rock/sand cap is not an exposed surface. Canopy stays allowed.
  for (let y = top; y >= bottom; y--) {
    const p = new Vec3(x, y, z);
    if (!naturalWalkingFoot(bot, p)) continue;
    let exposed = true;
    for (let above = y + 2; above <= top + 1; above++) {
      const block = column.get(above);
      if (!safeBlock(block) || (!AIR.has(block.name) && !vegetation(block))) { exposed = false; break; }
    }
    if (exposed) result.push(p);
  }
  return result.sort((a, b) => Math.abs(a.y - fromY) - Math.abs(b.y - fromY) || a.y - b.y);
}
// A planned frontier does not cover a cell or add a visit. Priority is derived
// only from confirmed positions; native movement and arrival checks stay below.
function runSurfaceGraphNativeProbe(bot, movements, goal, options = {}) {
  return observeSurfaceGraphNativeProbe(bot, movements, goal, options);
}
function runGroundedDryConnectorProbe(bot,movements,goal,options={}) {
  const target={x:goal.x,y:goal.y,z:goal.z};
  if(!options.observedOrigin||key(options.observedOrigin)!==key(bot.entity.position)
    ||!Object.values(target).every(Number.isSafeInteger)||vec(target).distanceTo(bot.entity.position)>96
    ||!naturalWalkingFoot(bot,target)||!hasGroundedBodySupport(bot)||!inspectSurfaceBody(bot).dry)
    throw fail('dry_graph_invalid_probe','Dry connector requires a fresh actual grounded origin and loaded supported target');
  return observeSurfaceGraphNativeProbe(bot,movements,goal,{...options,timeoutMs:500,tickTimeoutMs:10,maxSlices:50},500,50);
}
function runRecordedConstructionConnectorProbe(bot,movements,goal,options={}) {
  const target={x:goal.x,y:goal.y,z:goal.z};
  if(!options.recordedEntry||key(options.recordedEntry)!==key(target)
    ||!Object.values(target).every(Number.isSafeInteger)||vec(target).distanceTo(bot.entity.position)>96
    ||!naturalWalkingFoot(bot,target)||!hasGroundedBodySupport(bot))
    throw fail('dry_graph_invalid_probe','Recorded construction connector lacks a fresh supported endpoint');
  return observeSurfaceGraphNativeProbe(bot,movements,goal,{...options,timeoutMs:500,tickTimeoutMs:10,maxSlices:50},500,50);
}
// The exported exploration probe always retains its original 100 ms cap.
// Dedicated grounded connectors and the guarded recorded-return branch may
// supply 500/50. A selected, previously native-probed frontier may also make
// one bounded fresh recheck below; UNKNOWN never grants physical movement.
function observeSurfaceGraphNativeProbe(bot, movements, goal, { assertActive, isOwnerCurrent, pathprobe, timeoutMs = 100, tickTimeoutMs = 10, maxSlices = 16 } = {}, budgetMs = 100, budgetSlices = 16) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > budgetMs || !Number.isFinite(tickTimeoutMs) || tickTimeoutMs <= 0 || tickTimeoutMs > 10
    || !Number.isSafeInteger(maxSlices) || maxSlices < 1 || maxSlices > budgetSlices) throw fail('dry_graph_invalid_probe', 'Native probe slices must fit their captured finite observation budget');
  const started = Date.now(), from = plain(bot.entity.position), statuses = []; let generator, result, slices = 0, stopReason = null;
  const facts = () => ({ target: { x: goal.x, y: goal.y, z: goal.z }, from,
    elapsedMs: Date.now() - started, status: result?.status || 'unknown', pathCount: result?.path?.length || 0, slices,
    settled: ['success', 'noPath', 'timeout'].includes(result?.status), conclusive: ['success', 'noPath'].includes(result?.status),
    stopReason, yieldStatuses: [...statuses] });
  const check = () => { assertActive(); if (!isOwnerCurrent()) throw fail('dry_graph_movement_preempted', 'Native probe owner changed before a movement could start'); };
  try {
    check();
    if (pathprobe) {
      result = pathprobe(movements, goal, timeoutMs); slices = 1;
      if (!result || typeof result.then === 'function') throw fail('dry_graph_invalid_probe', 'A native synchronous path result is required');
      statuses.push(result.status); check();
    } else {
      generator = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal,
        { optimizePath: false, timeout: timeoutMs, tickTimeout: tickTimeoutMs });
      while (slices < maxSlices) {
        check();
        if (Date.now() - started >= timeoutMs) { stopReason = 'wall_deadline'; break; }
        const step = generator.next(); result = step.value?.result; slices++;
        if (!result || typeof result.then === 'function') throw fail('dry_graph_invalid_probe', 'Original pathfinder yielded no synchronous path result');
        statuses.push(result.status); check();
        if (result.status !== 'partial') break;
      }
      if (result?.status === 'partial' && !stopReason) stopReason = 'slice_limit';
    }
    const observed = facts();
    if (observed.elapsedMs > timeoutMs) {
      observed.conclusive = false;
      observed.stopReason = 'wall_deadline';
    }
    return { result, facts: observed };
  } catch (error) { error.observedProbe = facts(); throw error; }
  finally { generator?.return?.(); }
}
function selectSurfaceExplorationFrontier(state, anchor = state?.anchor, observedTarget = null) {
  const integer = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]));
  if (!integer(anchor) || !Array.isArray(state?.order) || !Array.isArray(state?.frontier)
    || state.order.length > 512 || state.frontier.length > 8192) {
    throw fail('dry_graph_checkpoint_changed', 'Exploration priority requires the original observed graph');
  }
  const observed = state.order.map(id => state.nodes?.[id]?.position);
  if (!observed.length || observed.some(p => !integer(p))) {
    throw fail('dry_graph_checkpoint_changed', 'Exploration coverage has no confirmed positions');
  }
  const cell = p => `${Math.floor((p.x - anchor.x + 16) / 32)},${Math.floor((p.z - anchor.z + 16) / 32)}`;
  const covered = new Set(observed.map(cell));
  const cellCounts = new Map();
  for (const p of observed) cellCounts.set(cell(p), (cellCounts.get(cell(p)) || 0) + 1);
  const radius = p => Math.hypot(p.x - anchor.x, p.z - anchor.z);
  const current = new Map(), replays = new Map(); let length = 0;
  for (let id = state.current; id && !current.has(id); id = state.nodes?.[id]?.parent) current.set(id, length++);
  const replayLength = parent => {
    if (replays.has(parent)) return replays.get(parent);
    const seen = new Set(); let reverse = 0;
    for (let id = parent; id && !seen.has(id); id = state.nodes?.[id]?.parent) {
      if (current.has(id)) { const result = reverse + current.get(id); replays.set(parent, result); return result; }
      seen.add(id); reverse++;
    }
    replays.set(parent, Infinity);
    return Infinity;
  };
  const candidates = state.frontier.map((edge, index) => {
    const parent = state.nodes?.[edge.parent]?.position, target = edge.target;
    if (!integer(parent) || !integer(target)) throw fail('dry_graph_checkpoint_changed', 'An exploration frontier lost its observed parent or target');
    if (state.nodes[key(target)]) return null;
    return { index, parentId: edge.parent, target, uncovered: !covered.has(cell(target)),
      outwardGain: radius(target) - radius(parent), radius: radius(target), replay: replayLength(edge.parent) };
  }).filter(Boolean);
  // Guidance changes only priority among already native-probed frontier
  // edges. A remembered block is not a visited waypoint or a safe standing cell.
  const nativeTarget = ['native_loaded_block_observation','native_loaded_entity_observation'].includes(observedTarget?.kind) && integer(observedTarget.position)
    && Number.isFinite(observedTarget.lastValidatedAt) && Date.now() - observedTarget.lastValidatedAt >= 0
    && Date.now() - observedTarget.lastValidatedAt <= 5000 ? observedTarget.position : null;
  // A recorded owned station can guide frontier ordering while its chunk is
  // unloaded. It does not enter the native direct-hint/probe path below and
  // never confirms the station still exists or grants arrival/stock credit.
  const historicalTarget=observedTarget?.kind==='recorded_owned_station_hint'&&observedTarget.ownershipRecorded===true
    &&(observedTarget.name==='chest'||observedTarget.purpose==='owned_combat_cleanup')&&integer(observedTarget.position)?observedTarget.position:null;
  const historicalResourceTarget=observedTarget?.kind==='recorded_natural_resource_hint'
    &&observedTarget.observationRecorded===true&&/_log$/.test(observedTarget.name||'')
    &&Number.isFinite(observedTarget.observedAt)&&observedTarget.currentPresence==='UNKNOWN'
    &&integer(observedTarget.position)?observedTarget.position:null;
  const target=nativeTarget||historicalTarget||historicalResourceTarget;
  const actual = state.nodes?.[state.current]?.position;
  if(target&&['construction_return','owned_stock_return','owned_combat_cleanup'].includes(observedTarget.purpose)){
    // A known construction destination is not outward resource coverage.
    // Prefer existing probed frontiers that retain useful elevation; a low
    // ravine is not progress merely because its X/Z is closer to the house.
    const score=c=>Math.hypot(c.target.x-target.x,c.target.z-target.z)+Math.max(0,target.y-c.target.y)*4+c.replay*2;
    const directed=candidates.filter(c=>Number.isFinite(c.replay)).sort((a,b)=>score(a)-score(b)||a.index-b.index);
    if(directed.length)return directed[0].index;
  }
  if (target && integer(actual)) {
    const squared = p => (p.x-target.x)**2+(p.z-target.z)**2;
    const currentDistance = squared(actual);
    const guided = candidates.filter(c => squared(c.target) < currentDistance - 1);
    const localGuided=guided.filter(c=>c.parentId===state.current),priority=localGuided.length?localGuided:guided;
    priority.sort((a,b) => squared(a.target)-squared(b.target) || a.replay-b.replay || a.index-b.index);
    if (priority.length) return priority[0].index;
  }
  // One observed point in a 32 m cell can hide the next genuine 16 m step.
  // Permit only a local outward full step into a singly observed cell, with
  // at least one step's separation from every actual node. Actual arrival then
  // makes that cell dense and removes this exception; plans never add coverage.
  const localOutward = candidates.filter(c => c.parentId === state.current && c.uncovered && c.outwardGain > 0);
  const hop = [8,16,24].includes(state.step) ? state.step : null;
  const separation = candidate => {
    if (candidate.separationSquared !== undefined) return candidate.separationSquared;
    let nearest = Infinity;
    for (const p of observed) {
      const dx = candidate.target.x - p.x, dz = candidate.target.z - p.z;
      nearest = Math.min(nearest, dx * dx + dz * dz);
      if (nearest === 0) break;
    }
    candidate.separationSquared = nearest; return nearest;
  };
  const localBridge = hop === null ? [] : candidates.filter(c => c.parentId === state.current && !c.uncovered
    && c.outwardGain > 0 && cellCounts.get(cell(c.target)) === 1 && separation(c) >= hop*hop);
  // Fresh local coverage keeps first priority. Dense covered cells cannot
  // displace any unseen cell; the original finite comparison bound is intact.
  const tier = localOutward.length ? localOutward : localBridge.length ? localBridge
    : candidates.some(c => c.uncovered) ? candidates.filter(c => c.uncovered) : candidates;
  for (const candidate of tier) separation(candidate);
  tier.sort((a, b) => b.separationSquared - a.separationSquared
    || b.outwardGain - a.outwardGain || b.radius - a.radius || a.replay - b.replay || a.index - b.index);
  return tier[0]?.index ?? -1;
}
function createLoadedDryGraph(deps, { anchor, step = 16, radius = 384, maxNodes = 96, maxEdges = 768, timeoutMs = 120000, legTimeoutMs = 15000, adaptiveLocalFrontier = false, nativeReachableHints = false, terrainRecovery = false, deferInconclusiveExplorationReplay = false, maximumControlledDrop = 5, preferActualLocalFrontier = false } = {}) {
  const bot = deps.getBot(), started = Date.now();
  const guardFailures = new WeakSet();
  const outboundBankDefense = new WeakMap(), recoveredOutboundWater = new WeakMap();
  // Only this graph's live native leg can mint a post-defense policy refusal.
  // No serialized checkpoint/error grants permission to adopt a displaced body.
  const rangedTargetRefusals = new WeakMap();
  let continuationDeadline = Infinity, continuationObservation = null;
  if (!anchor || !['x', 'y', 'z'].every(k => Number.isInteger(anchor[k])) || ![8, 16, 24].includes(step)
    || !Number.isInteger(radius) || radius < step || radius > 768 || !Number.isInteger(maxNodes) || maxNodes < 2 || maxNodes > 512
    || !Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 8192 || typeof adaptiveLocalFrontier !== 'boolean'
    || typeof nativeReachableHints !== 'boolean' || typeof terrainRecovery !== 'boolean' || typeof preferActualLocalFrontier !== 'boolean'
    || !Number.isInteger(maximumControlledDrop) || maximumControlledDrop < 1 || maximumControlledDrop > 5) throw fail('dry_graph_invalid_request', 'Invalid fixed anchor or finite graph budget');
  let exclusions = deps.exclusionBounds || [];
  const excluded = p => !p || !['x', 'y', 'z'].every(k => Number.isFinite(p[k])) || exclusions.some(b => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);
  const movements = new Movements(bot);
  movements.canDig = false; movements.allow1by1towers = false; movements.allowParkour = false; movements.allowFreeMotion = false;
  // Planner policy only: diagonal corner cutting can be accepted client-side
  // while the real server rejects the body collision. Native physics is intact.
  movements.getMoveDiagonal = () => {};
  movements.allowSprinting = false; // Native getLandingBlock measures feet-to-floor-cell-bottom, including
  // the landing block itself. Six therefore permits at most five feet of
  // actual descent, matching the bounded native controlled-drop guard.
  movements.maxDropDown = terrainRecovery && bot.health >= 6 ? maximumControlledDrop+1 : 2; movements.infiniteLiquidDropdownDistance = false; movements.scafoldingBlocks = [];
  for (const name of HAZARD) { const id = bot.registry.blocksByName[name]?.id; if (id !== undefined) movements.blocksToAvoid.add(id); }
  movements.exclusionAreasStep.push(block => !excluded(block?.position) && [-1, 0, 1].every(dy => safeBlock(bot.blockAt(vec(block.position).offset(0, dy, 0)))) ? 0 : Infinity);
  // Native movement can round a cardinal waypoint while its real feet cross
  // a neighboring floor column. Keep a one-cell buffer around known powder
  // snow; a central dry/support check alone cannot make that edge traversable.
  // Other unknown/body/support checks and the actual movement guard remain.
  const surfaceEdgeAllowed=createSurfaceHazardEdgePolicy(bot);
  movements.exclusionAreasStep.push(block => surfaceEdgeAllowed(block?.position) ? 0 : Infinity);
  if (typeof deps.isStepAllowed === 'function') movements.exclusionAreasStep.push(block => deps.isStepAllowed(block?.position) === true ? 0 : Infinity);
  let state = (deps.getCP || deps.getCheckpoint)?.();
  if (state) {
    state = copy(state);
    if (state.schema !== 2 || state.kind !== 'loaded_dry_waypoint_graph' || key(state.anchor) !== key(anchor) || state.step !== step || state.radius !== radius
      || !Array.isArray(state.order) || !Array.isArray(state.frontier) || !Array.isArray(state.blockedEdges) || typeof state.nodes !== 'object') throw fail('dry_graph_checkpoint_changed', 'Original graph anchor, spacing or schema changed');
    for (const id of state.order) {
      const node = state.nodes[id];
      if (!node || key(node.position) !== id || !['x', 'y', 'z'].every(k => Number.isInteger(node.position[k]))
        || (node.parent !== null && !state.nodes[node.parent])
        || node.supportPositions !== undefined && (!Array.isArray(node.supportPositions) || node.supportPositions.length > 2048
          || node.supportPositions.some(p => !p || !['x','y','z'].every(axis => Number.isSafeInteger(p[axis]))))) {
        throw fail('dry_graph_checkpoint_changed', 'Unconfirmed graph checkpoint node or support observations');
      }
      // Legacy hint-only rings were incorrectly recorded as all-direction rings.
      // Preserve those observations and their spent probes, but let the actual
      // stand test its remaining directions under the same lifetime budget.
      if(node.resourceLocalFrontierExpanded&&node.localFrontierObservation&&!node.localFrontierObservation.directionCoverage){
        node.legacyHintLocalFrontierObservation=copy(node.localFrontierObservation);
        node.localFrontierObservation={testedRanges:[],domain:'NATIVE_PLAN_ONLY',directionCoverage:'all_eight',actualMovementConfirmed:false};
        node.localFrontierExpanded=false;
      }
      const seen = new Set();
      for (let parent = id; parent; parent = state.nodes[parent]?.parent) { if (seen.has(parent)) throw fail('dry_graph_checkpoint_changed', 'Graph parent route contains a cycle'); seen.add(parent); }
    }
    for (const id of state.order) if (state.nodes[id].dryParentTrail && !validDryParentTrail(state.nodes[id].dryParentTrail,state.nodes,id)) {
      throw fail('dry_graph_checkpoint_changed','Saved dry parent trail is not a bounded successful actual edge');
    }
  } else state = { schema: 2, kind: 'loaded_dry_waypoint_graph', anchor: { ...anchor }, radius, step, nodes: {}, order: [], frontier: [], blockedEdges: [], current: null, resumeNode: null, visits: 0, probes: 0 };
  const active = () => { deps.assertActive(); if (deps.getBot() !== bot) throw fail('dry_graph_bot_changed', 'Bot changed'); if (Date.now() - started > timeoutMs) throw fail('dry_graph_timeout', 'Finite loaded graph search expired');
    if (Number.isFinite(continuationDeadline) && Date.now() >= continuationDeadline) throw fail('dry_graph_leg_timeout', 'Post-defense continuation exhausted its original native leg deadline'); };
  const ready = async () => {
    const capped=Number.isFinite(continuationDeadline);
    if (capped) active();
    const defended=capped ? await deps.ready?.({ deadline: continuationDeadline }) : await deps.ready?.();
    active();return defended;
  };
  const save = () => { active(); (deps.saveCP || deps.setCheckpoint)?.(copy(state)); };
  let provisioningReturn=false;
  let survivalProvisioning=false;
  const assertVitals = () => { active(); if (!Number.isFinite(bot.health) || bot.health < (provisioningReturn||survivalProvisioning?1:6) || !Number.isFinite(bot.food) || bot.food < (provisioningReturn||survivalProvisioning?0:6))
    throw fail('dry_graph_survival_limit', 'Actual health or hunger is below the current exploration/return threshold'); };
  const owner = () => deps.isMovementOwner ? deps.isMovementOwner() === true : deps.getBot() === bot;
  const routeToAnchor = () => { const route = []; for (let id = state.current; id; id = state.nodes[id]?.parent) route.push(copy(state.nodes[id].position)); return route; };
  const waterEnabled = typeof deps.discoverWaterRoutes === 'function' && typeof deps.traverseWater === 'function';
  let lastNativeSupports = [], lastNativeTrail = null, lastProbeFacts = null, lastProbeResult = null;
  function refusePendingDryTrail() {
    if(state.pendingDryTrail){
      let facts;
      try{facts={actual:plain(bot.entity.position),anchor:plain(anchor),current:state.current,
        actualKnown:Boolean(state.nodes[key(bot.entity.position)]),ownerCurrent:owner(),onGround:bot.entity.onGround,
        grounded:hasGroundedBodySupport(bot),naturalFoot:naturalWalkingFoot(bot,bot.entity.position.floored()),
        body:inspectSurfaceBody(bot),velocity:{...bot.entity.velocity},goal:bot.pathfinder.goal?.constructor?.name||null,
        controls:{...bot.controlState},pendingWater:Boolean(state.pendingWater)};}catch{facts={observation:'UNKNOWN'};}
      throw fail('dry_graph_trail_reconciliation_required','A failed actual dry-trail prefix needs explicit reconciliation before any other graph route',
        {observedDryTrailPending:copy(state.pendingDryTrail),trailReconciliation:facts,
          actualPosition:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z}});
    }
  }
  async function reconcilePendingDryTrail(){
    if(!state.pendingDryTrail)return;
    assertVitals();if(!owner()||!hasGroundedBodySupport(bot)||!naturalWalkingFoot(bot,bot.entity.position.floored()))return refusePendingDryTrail();
    const pending=copy(state.pendingDryTrail),actual=key(bot.entity.position),previous=bot.pathfinder.movements;
    const known=state.nodes[actual];
    if(known&&!nativeReachableHints&&actual!==key(anchor)&&actual!==pending.originNode)return refusePendingDryTrail();
    const candidates=known?[actual]:[...new Set([key(anchor),pending.originNode])].filter(id=>state.nodes[id]
      &&vec(state.nodes[id].position).distanceTo(bot.entity.position)<=12&&naturalWalkingFoot(bot,state.nodes[id].position));
    if(!candidates.length&&nativeReachableHints){
      for(const id of state.order.filter(id=>state.nodes[id]?.position&&vec(state.nodes[id].position).distanceTo(bot.entity.position)<=32
        &&naturalWalkingFoot(bot,state.nodes[id].position)).sort((a,b)=>vec(state.nodes[a].position).distanceTo(bot.entity.position)-vec(state.nodes[b].position).distanceTo(bot.entity.position))){
        const seen=new Set();let cursor=id;
        while(cursor&&cursor!==key(anchor)&&seen.size<512&&!seen.has(cursor)){seen.add(cursor);cursor=state.nodes[cursor]?.parent;}
        if(cursor===key(anchor))candidates.push(id);
        if(candidates.length>=8)break;
      }
    }
    if(!candidates.length)return refusePendingDryTrail();
    bot.pathfinder.setMovements(movements);
    try{
      // Rejoin only an already recorded node through a NEW native dry leg.
      // Never initialize a node at a partial pose or credit the failed edge.
      const id=candidates[0];if(id!==actual)await nativeMove(state.nodes[id].position,{captureTrail:false});
      assertVitals();if(!owner()||key(bot.entity.position)!==id||!hasGroundedBodySupport(bot)
        ||!naturalWalkingFoot(bot,bot.entity.position.floored()))return refusePendingDryTrail();
      state.reconciledDryTrails=[...(state.reconciledDryTrails||[]).slice(-7),{...pending,reconciledAt:Date.now(),actualNode:id,
        failedEdgeCompleted:false,newNodeOrVisitCredit:false}];
      state.current=id;state.resumeNode=id;state.pendingDryTrail=null;save();
    }finally{if(owner()&&bot.pathfinder.movements===movements)bot.pathfinder.setMovements(previous);}
  }
  function commitNativeTrail(from,to) {
    if (!lastNativeTrail || lastNativeTrail.from!==from || lastNativeTrail.to!==to) return;
    const child=state.nodes[to]?.parent===from?to:state.nodes[from]?.parent===to?from:null;
    if (child && validDryParentTrail(lastNativeTrail,state.nodes,child)) state.nodes[child].dryParentTrail=copy(lastNativeTrail);
  }
  function trailReader(deadline=Infinity) {
    const check=()=>{assertVitals();if(Date.now()>=deadline)throw fail('dry_graph_leg_timeout','Actual dry trail exhausted its original edge deadline');
      if(!owner()||bot.pathfinder.movements!==movements)throw fail('dry_graph_movement_preempted','Actual dry trail lost its captured owner/profile');};
    const view=Object.create(bot);
    view.blockAt=(p,...args)=>{check();const block=bot.blockAt(p,...args);check();return block;};
    return {view,check};
  }
  function actualDryTrailPoint(reader) {
    reader.check();const p=bot.entity.position,position={x:Math.floor(p.x),y:Math.round(p.y),z:Math.floor(p.z)};
    if(Math.abs(p.y-position.y)>.07 || excluded(position) || !naturalWalkingFoot(reader.view,position) || !hasGroundedBodySupport(reader.view))return null;
    const contacts=bodyShapeSupports(reader.view,Math.floor(p.y-.075)-1,Math.floor(p.y),-Infinity,.075),supports=new Map();
    for(const c of contacts){if(!Number.isSafeInteger(c.stateId)||c.stateId<0)return null;supports.set(key(c.position),{position:plain(c.position),stateId:c.stateId});}
    reader.check();return supports.size?{position,actual:{x:p.x,y:p.y,z:p.z},supports:[...supports.values()]}:null;
  }
  function revalidateTrailPoint(point,reader) {
    reader.check();if(excluded(point.position)||!naturalWalkingFoot(reader.view,point.position))throw fail('dry_graph_trail_route_changed','Recorded dry foot cell is protected, changed or unloaded');
    for(const support of point.supports){const b=reader.view.blockAt(vec(support.position));if(!safeBlock(b)||b.stateId!==support.stateId)throw fail('dry_graph_trail_route_changed','Recorded actual support state changed or is unloaded');}
    // Read-only geometry at the old observed body pose. This does not move or
    // simulate the actor; actual arrival is checked separately after native goto.
    const bodyView=Object.create(reader.view);bodyView.entity={...bot.entity,position:vec(point.actual)};
    if(!inspectSurfaceBody(bodyView).dry || !bodyShapeSupports(bodyView,Math.floor(point.actual.y-.075)-1,Math.floor(point.actual.y),-Infinity,.075).length)throw fail('dry_graph_trail_route_changed','Recorded body clearance or support shape changed');
    reader.check();
  }
  const deferredSiteReplays=new Set(state.blockedEdges.filter(edge=>edge.kind==='unconfirmed_site_parent_replay'
    &&Number.isFinite(edge.retryAfter)&&edge.retryAfter>Date.now()&&edge.retryAfter<=Date.now()+120000)
    .flatMap(edge=>[`${edge.from}>${edge.targetNode}`,...(edge.requestedFrom?[`${edge.requestedFrom}>${edge.targetNode}`]:[])]));
  let exploring=false;
  let observedResourceTarget = null;
  function selectFrontier() {
    active(); observedResourceTarget = deps.getObservedResourceTarget?.() || null;
    let choices=state.frontier.map((edge,index)=>({edge,index}))
      .filter(({edge})=>(!Number.isFinite(continuationDeadline)||edge.parent===state.current&&!edge.transport)
        &&!state.nodes[edge.parent]?.terrainUnavailable&&!deferredSiteReplays.has(`${state.current}>${edge.parent}`)
        &&!(edge.transport&&deps.isWaterRouteThreatened?.(edge.transport.route)===true));
    if(preferActualLocalFrontier){
      const local=choices.filter(({edge})=>edge.parent===state.current),p=observedResourceTarget?.position,current=state.nodes[state.current]?.position;
      const validHint=p&&['x','y','z'].every(k=>Number.isFinite(p[k]));
      const d=q=>(q.x-p.x)**2+(q.z-p.z)**2;
      if(local.length&&(!validHint||local.some(({edge})=>d(edge.target)<d(current)-1)))choices=local;
    }
    const selected=selectSurfaceExplorationFrontier({...state,frontier:choices.map(v=>v.edge)},anchor,observedResourceTarget);
    const at=choices[selected]?.index??-1;
    if (observedResourceTarget && at >= 0) {
      const p = observedResourceTarget.position, current = state.nodes[state.current]?.position, edge = state.frontier[at];
      const squared = q => (q.x-p.x)**2+(q.z-p.z)**2;
      if (!p || !current || squared(edge.target) >= squared(current)-1) {
        deps.onObservedResourceTargetBlocked?.(observedResourceTarget, { reason: 'no_improving_frontier', probeStatus: null });
        observedResourceTarget = null;
      }
    }
    return at;
  }

  function waterTransport(edge) {
    return validateHouseSurfaceTransport(edge, { nodes: state.nodes, excluded, waterEnabled,
      supportedKinds: deps.waterTransportKinds || ['source_water_depth1'] });
  }
  // A saved fluid edge is never replayed as an ordinary dry goto. Without its
  // exact adapter the checkpoint is unavailable, including on a later resume.
  for (const node of Object.values(state.nodes)) if (node.transport) waterTransport(node);
  for (const edge of state.frontier) if (edge.transport) waterTransport(edge);
  function probe(target, { observedReturnRetry = false, observedSuffix = null, frontierWitness = null, assertProbeActive: assertRequestedProbeActive = active } = {}) {
    const healthAtProbe = bot.health;
    const assertProbeActive = () => {
      assertRequestedProbeActive(); assertVitals();
      if (bot.health < healthAtProbe - .01) throw fail('dry_graph_survival_limit', 'Actual damage invalidated the captured native reachability probe');
    };
    lastProbeResult = null;
    active(); state.probes++;
    if (state.probes > maxEdges) throw fail('dry_graph_probe_limit', 'Finite native reachability budget exhausted');
    if (excluded(target)) {
      lastProbeFacts = { target: plain(target), from: plain(bot.entity.position), elapsedMs: 0,
        status: 'excluded', pathCount: 0, slices: 0, settled: false, conclusive: false,
        stopReason: 'target_excluded', yieldStatuses: [] };
      try { deps.onProbe?.(copy(lastProbeFacts)); } catch {}
      active(); return null;
    }
    const goal = new goals.GoalBlock(target.x, target.y, target.z);
    const observed = runSurfaceGraphNativeProbe(bot, movements, goal, { assertActive: assertProbeActive, isOwnerCurrent: owner, pathprobe: deps.pathprobe });
    let result = observed.result; lastProbeFacts = observed.facts;
    if (observedReturnRetry && !lastProbeFacts.conclusive && lastProbeFacts.status !== 'noPath') {
      assertProbeActive();
      if (!owner() || bot.pathfinder.movements !== movements) throw fail('dry_graph_movement_preempted', 'Recorded return probe lost its captured native owner/profile');
      const originId = key(bot.entity.position), targetId = key(target);
      const knownNodes = state.current === originId && state.order.includes(originId) && state.nodes[originId]
        && state.order.includes(targetId) && state.nodes[targetId] && vec(target).distanceTo(bot.entity.position) <= 32;
      // Only returnToAnchor can create this ephemeral witness, after validating
      // the actual observed suffix ends here and rejoins its original node.
      // Resource approaches search within96m; this spends one original probe,
      // not extra movement time or permission to call UNKNOWN reachable.
      const knownSuffix = observedSuffix && observedSuffix.nodeId===state.current
        && state.order.includes(state.current) && state.nodes[state.current]
        && key(observedSuffix.from)===originId && key(observedSuffix.to)===targetId
        && vec(target).distanceTo(bot.entity.position)<=96;
      const knownLocal = (knownNodes || knownSuffix)
        && !excluded(plain(bot.entity.position)) && naturalWalkingFoot(bot, plain(bot.entity.position)) && hasGroundedBodySupport(bot)
        && !excluded(target) && naturalWalkingFoot(bot, target);
      assertProbeActive();
      if (knownLocal) {
        if (!owner() || bot.pathfinder.movements !== movements) throw fail('dry_graph_movement_preempted', 'Recorded return observation changed owner/profile before retry');
        const initialProbe = { ...copy(lastProbeFacts), budgetMs: 100 };
        try { deps.onProbe?.({ ...copy(initialProbe), observedReturnRetryPending: true }); } catch {}
        assertProbeActive();
        if (++state.probes > maxEdges) throw fail('dry_graph_probe_limit', 'Recorded return retry consumes the original finite native probe budget');
        const retry = observeSurfaceGraphNativeProbe(bot, movements, goal, {
          assertActive: assertProbeActive, isOwnerCurrent: () => owner() && bot.pathfinder.movements === movements,
          timeoutMs: 500, tickTimeoutMs: 10, maxSlices: 50 }, 500, 50);
        result = retry.result;
        lastProbeFacts = { ...retry.facts, budgetMs: 500, observedReturnRetry: true, observedSuffixRetry: Boolean(knownSuffix), retryIndex: 1, initialProbe,
          nativePathHead: Array.isArray(result?.path) ? result.path.slice(0,8).map(p=>({x:p.x,y:p.y,z:p.z})) : null };
        try { deps.onProbe?.(copy(lastProbeFacts)); } catch {}
        assertProbeActive();
        if (!owner() || bot.pathfinder.movements !== movements) throw fail('dry_graph_movement_preempted', 'Recorded return retry finished after owner/profile changed');
      }
    }
    if (frontierWitness && !lastProbeFacts.conclusive && lastProbeFacts.status !== 'noPath' && typeof deps.pathprobe !== 'function') {
      assertProbeActive();
      const actual = plain(bot.entity.position), targetId = key(target);
      const freshFrontier = frontierWitness.parent === state.current && state.order.includes(state.current)
        && state.nodes[state.current] && key(actual) === state.current && !state.nodes[targetId]
        && key(frontierWitness.target) === targetId && Number.isSafeInteger(frontierWitness.plannedSteps) && frontierWitness.plannedSteps > 0
        && vec(target).distanceTo(bot.entity.position) <= 32 && owner() && bot.pathfinder.movements === movements
        && !excluded(actual) && !excluded(target) && naturalWalkingFoot(bot, actual) && naturalWalkingFoot(bot, target) && hasGroundedBodySupport(bot);
      if (freshFrontier) {
        const initialProbe = { ...copy(lastProbeFacts), budgetMs: 100 };
        if (++state.probes > maxEdges) throw fail('dry_graph_probe_limit', 'Selected frontier recheck consumes the original finite probe budget');
        const retry = observeSurfaceGraphNativeProbe(bot, movements, goal, {
          assertActive: assertProbeActive, isOwnerCurrent: () => owner() && bot.pathfinder.movements === movements,
          timeoutMs: 500, tickTimeoutMs: 10, maxSlices: 50 }, 500, 50);
        result = retry.result; lastProbeFacts = { ...retry.facts, budgetMs: 500, selectedFrontierRetry: true, retryIndex: 1, initialProbe, newNodeOrVisitCredit: false };
        try { deps.onProbe?.(copy(lastProbeFacts)); } catch {}
        assertProbeActive();
        if (!owner() || bot.pathfinder.movements !== movements) throw fail('dry_graph_movement_preempted', 'Selected frontier changed owner during fresh recheck');
      }
    }
    if (result?.status !== 'success' || !lastProbeFacts.conclusive) { try { deps.onProbe?.(copy(lastProbeFacts)); } catch {} active(); }
    lastProbeResult = result;
    return result?.status === 'success' && lastProbeFacts.conclusive ? result : null;
  }
  function offerNativeReachableHint(parent, failedTarget) {
    active();
    const knownFailure=lastProbeFacts?.status==='noPath'&&lastProbeFacts.conclusive;
    const unfinished=['timeout','partial'].includes(lastProbeFacts?.status)&&lastProbeFacts.conclusive===false;
    if (!nativeReachableHints || !(knownFailure||unfinished)
      || !Array.isArray(lastProbeResult?.path) || lastProbeResult.path.length < 1 || lastProbeResult.path.length > 512) return false;
    const route = lastProbeResult.path;
    if (route.some(p => !p || !['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k])) || p.toBreak?.length || p.toPlace?.length)) return false;
    const hint = plain(route.at(-1)), origin = state.nodes[parent]?.position;
    if (!origin || parent !== state.current || key(bot.entity.position) !== parent || !owner()
      || Math.hypot(hint.x - origin.x, hint.z - origin.z) < 4 || excluded(hint)
      || Math.hypot(hint.x - anchor.x, hint.z - anchor.z) > radius || !naturalWalkingFoot(bot, hint)
      || state.nodes[key(hint)] || state.frontier.some(e => key(e.target) === key(hint))) return false;
    // An unsuccessful/unfinished result supplies only a hint. Its original
    // goal remains noPath/UNKNOWN; never execute or credit that returned path.
    // The endpoint needs its own fresh conclusive successful native probe.
    const confirmed = probe(hint);
    if (!confirmed) return false;
    state.frontier.push({ parent, target: hint, plannedSteps: confirmed.path.length,
      nativeReachableHint: { failedGoal: plain(failedTarget), endpointSeparatelyProbed: true, actualArrivalConfirmed: false } });
    return true;
  }
  // Receipts stay private to this graph instance; only its native failure
  // handler can authorize observing a partial, directed site-search landing.
  const partialSiteLandings=new WeakMap();
  function adoptPartialSiteLanding(error) {
    const receipt=partialSiteLandings.get(error);if(!receipt)return false;
    active();const actual=plain(bot.entity.position),id=key(actual),from=state.current;
    if(!deferInconclusiveExplorationReplay||!exploring||guardFailures.has(error)||!owner()
      ||bot.pathfinder.movements!==movements||state.pendingWater||state.pendingDryTrail
      ||receipt.from!==from||receipt.actual!==id||Date.now()>=receipt.deadline
      ||bot.entity.onGround!==true||!hasGroundedBodySupport(bot)||!naturalWalkingFoot(bot,actual)
      ||!inspectSurfaceBody(bot).dry||excluded(actual)||Math.hypot(actual.x-anchor.x,actual.z-anchor.z)>radius)return false;
    if(id===from)return false;
    if(!state.nodes[id]){
      if(state.visits>=maxNodes)throw fail('dry_graph_node_limit','Finite actual node visits reached');
      state.nodes[id]={position:actual,parent:from,expanded:false,
        partialNativeLanding:{kind:'actual_native_no_path_landing',fromNode:from,oldTargetReached:false,oldEdgeTraversalCredit:false}};
      state.order.push(id);state.visits++;
    }
    state.current=id;state.resumeNode=id;lastNativeTrail=null;
    state.blockedEdges.push({kind:'actual_native_no_path_landing',from,target:copy(receipt.target),actual:copy(actual),oldTargetReached:false,oldEdgeTraversalCredit:false});save();
    deps.onPartialSiteLanding?.({from,actual:copy(actual),oldTargetReached:false,oldEdgeTraversalCredit:false});
    return true;
  }
  async function nativeMove(target, { observedReturnRetry = false, observedSuffix = null, frontierWitness = null, sharedDeadlineMs = Infinity, captureTrail = true } = {}) {
    assertVitals(); if (!owner()) throw fail('dry_graph_movement_preempted', 'Graph no longer owns movement');
    const legStartedAt=Date.now(),legDeadline=Math.min(legStartedAt+legTimeoutMs,sharedDeadlineMs,continuationDeadline),fromNode=state.current,fromId=key(bot.entity.position);
    if (!naturalWalkingFoot(bot, target) || excluded(target)) {
      const error=fail('dry_graph_route_changed','Known dry target changed', { observedRouteTarget: {
        target:plain(target),actual:plain(bot.entity.position),fromNode:state.current,excluded:excluded(target),
        feet:blockFact(bot.blockAt(vec(target)),target),head:blockFact(bot.blockAt(vec(target).offset(0,1,0)),vec(target).offset(0,1,0)),
        below:blockFact(bot.blockAt(vec(target).offset(0,-1,0)),vec(target).offset(0,-1,0)) } });
      try { deps.onRouteUnavailable?.(error.observedRouteTarget); } catch { /* Diagnostics grant no movement. */ }
      throw error;
    }
    const goal = new goals.GoalBlock(target.x, target.y, target.z); let guardError, timer, rejectGuard, physicsTick = 0, lastGrounded = null, guardFacts = null, gotoSettled = false, dropBraking = false, expectedDropStop = false, dropBrakes = 0, legClosed = false, mintedRefusal = false;
    // Native goto clears its goal at arrival before a final airborne body has
    // landed. A foreign goal still cannot borrow this captured leg's witness.
    const ownsJumpObservation = () => owner() && bot.pathfinder.movements === movements
      && (bot.pathfinder.goal === goal || (gotoSettled || dropBraking) && bot.pathfinder.goal === null);
    let nativePath = null, nativePathFacts = { available: false, reason: 'native_path_update_not_observed' };
    // Installed pathfinder shifts this exact array as it consumes waypoints.
    // Retain the read-only reference, then snapshot only on failure, before stop.
    const observePath = result => {
      if (!owner() || bot.pathfinder.movements !== movements || bot.pathfinder.goal !== goal) return;
      nativePath = Array.isArray(result?.path) ? result.path : null;
      nativePathFacts = { available: Boolean(nativePath), status: result?.status ?? null, observedAt: Date.now() };
    };
    const observePathReset = reason => { nativePath = null; nativePathFacts = { available: false, reason: String(reason), observedAt: Date.now() }; };
    const moveSupports = new Map(); lastNativeSupports = [];lastNativeTrail=null;
    const trailPoints=[],trailReaderView=trailReader(legDeadline);
    let trailComplete=captureTrail && fromNode===fromId && state.order.includes(fromId) && Boolean(state.nodes[fromId]);
    const recordTrailPoint=(force=false)=>{
      if(!trailComplete)return;
      const p=bot.entity.position,cell={x:Math.floor(p.x),y:Math.round(p.y),z:Math.floor(p.z)};
      if(!force && trailPoints.length && key(trailPoints.at(-1).position)===key(cell))return;
      const point=actualDryTrailPoint(trailReaderView);if(!point)return;
      if(trailPoints.length && key(trailPoints.at(-1).position)===key(point.position)){if(force)trailPoints[trailPoints.length-1]=point;return;}
      if(trailPoints.length>=DRY_TRAIL_LIMIT || trailPoints.length && !dryTrailHop(trailPoints.at(-1).position,point.position)){trailComplete=false;return;}
      trailPoints.push(point);
    };
    const recordGrounded = () => {
      if (hasGroundedBodySupport(bot)) lastGrounded = { tick: physicsTick, position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        contacts: bodyShapeSupports(bot, Math.floor(bot.entity.position.y - 0.075) - 1, Math.floor(bot.entity.position.y), -Infinity, 0.075) };
      for (const contact of lastGrounded?.contacts || []) moveSupports.set(key(contact.position), plain(contact.position));
      recordTrailPoint();
    };
    recordGrounded();
    const guardPromise = new Promise((_, reject) => { rejectGuard = reject; });
    const stopOwn = () => { if (owner() && bot.pathfinder.movements === movements && bot.pathfinder.goal === goal) { bot.pathfinder.setGoal(null); if(owner() && bot.pathfinder.movements===movements && bot.pathfinder.goal===null)bot.clearControlStates(); } };
    const failMove = (error, trigger) => {
      if (guardError) return;
      guardError = error;
      guardFailures.add(error);
      const e = bot.entity;
      error.observedMovement = { position: { x: e.position.x, y: e.position.y, z: e.position.z },
        velocity: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
        onGround: e.onGround, isInWater: e.isInWater ?? null, isInLava: e.isInLava ?? null,
        yaw: Number.isFinite(e.yaw) ? e.yaw : null, pitch: Number.isFinite(e.pitch) ? e.pitch : null,
        controls: Object.fromEntries(['forward','back','left','right','jump','sprint','sneak']
          .map(name => [name, typeof bot.controlState?.[name] === 'boolean' ? bot.controlState[name] : null])),
        jumpTicks: bot.jumpTicks ?? null, jumpQueued: bot.jumpQueued ?? null,
        pendingPath: { ...nativePathFacts, remainingCount: nativePath?.length ?? null,
          points: nativePath ? nativePath.slice(0, 32).map(point => ({ x: point.x, y: point.y, z: point.z,
            parkour: point.parkour === true })) : null, truncated: nativePath ? nativePath.length > 32 : null },
        health: bot.health, food: bot.food, target: plain(target), fromNode: state.current,
        trigger, observedAt: Date.now(), safetyFacts: trigger === 'physics_tick' ? guardFacts : null };
      try { deps.onFailure?.(error); } catch { /* Diagnostic failure cannot weaken the movement stop. */ }
      stopOwn(); rejectGuard(error);
    };
    const guard = () => { try {
      guardFacts = null;
      active();
      if (!owner()) throw fail('dry_graph_movement_preempted', 'Graph movement owner changed');
      // The exact higher-priority survival owner validates its own movement.
      // Its goal is deliberately different from this suspended work goal.
      // Do not cancel defense as a failed work jump or persist its detour as
      // an uninterrupted dry parent trail. The original leg deadline remains.
      if(deps.isMovementSuspended?.()===true){
        trailComplete=false;lastGrounded=null;
        const body=inspectSurfaceBody(bot);guardFacts={body};
        if(body.isInLava||body.cells.some(cell=>HAZARD.has(cell.name)&&!['water','bubble_column'].includes(cell.name)))
          throw fail('dry_graph_hazard','Actual survival detour touched a known physical hazard');
        return;
      }
      if(bot.pathfinder.movements!==movements)throw fail('dry_graph_movement_preempted','Graph movement profile changed');
      assertVitals();
      physicsTick += 1;
      const feet = bot.entity.position.floored(), body = inspectSurfaceBody(bot);
      recordGrounded();
      const shore = inspectShoreSupport(bot, { tick: physicsTick, lastGrounded, body });
      const footBlock = bot.blockAt(feet), headBlock = bot.blockAt(feet.offset(0, 1, 0)), belowBlock = bot.blockAt(feet.offset(0, -1, 0));
      guardFacts = { physicsTick, body, shore, feet: blockFact(footBlock, feet), head: blockFact(headBlock, feet.offset(0, 1, 0)),
        below: blockFact(belowBlock, feet.offset(0, -1, 0)) };
      if (excluded(feet) || !body.dry || !safeBlock(footBlock) || !safeBlock(headBlock) || (!safeBlock(belowBlock) && !shore.accepted)) {
        throw fail('dry_graph_hazard', 'Actual route touched protected, unknown, fluid or hazard');
      }
      if (!supported(belowBlock) && !supported(bot.blockAt(feet.offset(0, -2, 0))) && !hasGroundedBodySupport(bot) && !shore.accepted) {
        const descent = inspectDryDescentSupport(bot, { tick: physicsTick, lastGrounded, body });
        guardFacts.descent = descent;
        if (!descent.accepted) {
          const jump = inspectDryJumpSupport(bot, { tick: physicsTick, lastGrounded, body, assertActive: active,
            isOwnerCurrent: ownsJumpObservation, excluded, allowSteppedJump: terrainRecovery });
          guardFacts.jump = jump;
          active();
          if (!ownsJumpObservation()) {
            throw fail('dry_graph_movement_preempted', 'Dry jump observation lost its captured movement owner or goal');
          }
          if (!jump.accepted) {
            const drop=terrainRecovery ? inspectControlledDropSupport(bot,{tick:physicsTick,lastGrounded,body,maximumControlledDrop,
              assertActive:active,isOwnerCurrent:ownsJumpObservation,excluded}) : {accepted:false};
            guardFacts.controlledDrop=drop;
            if (!drop.accepted) {
              // A deep native drop can retain forward input past its landing
              // waypoint. A verified neutral-input landing permits a bounded owned
              // pause, using ordinary controls and original gravity only.
              const neutral=Object.create(bot);
              neutral.controlState=Object.fromEntries(['forward','back','left','right','jump','sprint','sneak'].map(n=>[n,false]));
              const coast=terrainRecovery && dropBrakes<8 && !dropBraking && bot.pathfinder.goal===goal
                ? inspectControlledDropSupport(neutral,{tick:physicsTick,lastGrounded,body,maximumControlledDrop,assertActive:active,isOwnerCurrent:ownsJumpObservation,excluded})
                : {accepted:false};
              guardFacts.controlledDropBrake=coast;
              active();
              if(coast.accepted && ownsJumpObservation()) {
                dropBrakes++;dropBraking=true;expectedDropStop=true;stopOwn();return;
              }
              throw fail('dry_graph_airshaft', 'Actual dry path lost nearby support');
            }
          }
        }
      }
    } catch (error) { failMove(error, 'physics_tick'); } };
    bot.prependListener('physicsTick', guard);
    bot.on('path_update', observePath); bot.on('path_reset', observePathReset);
    const assertProbeActive = () => {
      assertVitals();
      if (Date.now() >= legDeadline) throw fail('dry_graph_leg_timeout', 'Recorded return observation exhausted its original native leg deadline');
    };
    timer = setTimeout(() => failMove(fail('dry_graph_leg_timeout', 'Native graph movement timed out'), 'deadline'), Math.max(0,legDeadline-Date.now()));
    try {
      assertProbeActive();const ready=probe(target, { observedReturnRetry, observedSuffix, frontierWitness, assertProbeActive });assertProbeActive();
      if (!ready) throw fail(lastProbeFacts?.status === 'noPath' && lastProbeFacts.conclusive ? 'dry_graph_native_no_path' : 'dry_graph_probe_inconclusive',
        lastProbeFacts?.status === 'noPath' ? 'No original pathfinder route to target' : 'Finite native probe did not establish whether this route is reachable',
        { observedProbe: copy(lastProbeFacts) });
      if (observedReturnRetry) assertProbeActive();
      const canRevalidateRetreat = exploring && frontierWitness && frontierWitness.parent === fromNode
        && key(frontierWitness.target) === key(target) && fromId === fromNode && typeof deps.isStepAllowed === 'function'
        && deps.isStepAllowed(target) === true;
      const onOwnedRangedRetreat = witness => {
        try {
        assertProbeActive();
        if (!canRevalidateRetreat || legClosed || mintedRefusal || guardError || !owner()
          || bot.pathfinder.movements !== movements || deps.isMovementSuspended?.() === true
          || state.current !== fromNode || state.pendingWater || state.pendingDryTrail
          || witness?.kind !== 'actual_owned_ranged_retreat' || witness.bot !== bot || witness.goal !== goal
          || witness.movements !== movements || witness.deadline !== legDeadline
          || !Number.isFinite(witness.observedAt) || Date.now() < witness.observedAt || Date.now() - witness.observedAt > 2000
          || ![witness.from,witness.actual].every(p => p && ['x','y','z'].every(axis => Number.isFinite(p[axis])))
          || !Number.isFinite(witness.maximumDisplacement) || witness.maximumDisplacement < 0 || witness.maximumDisplacement > 32
          || !Number.isFinite(witness.maximumVerticalDisplacement) || witness.maximumVerticalDisplacement < 0 || witness.maximumVerticalDisplacement > 8
          || vec(witness.actual).distanceTo(bot.entity.position) > 1e-7
          || Math.hypot(bot.entity.position.x-witness.from.x,bot.entity.position.z-witness.from.z) > witness.maximumDisplacement+.05
          || Math.abs(bot.entity.position.y-witness.from.y) > witness.maximumVerticalDisplacement+.05)
          throw fail('dry_graph_ranged_return_invalid','Post-defense target revalidation lost its original live leg');
        // Reuse the exact live safety policy already installed in native A*.
        // A still-admissible goal keeps the original resume path and budgets.
        if (deps.isStepAllowed(target) === true) { assertProbeActive(); return; }
        assertProbeActive();
        const actual={x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z};
        const error=fail('dry_graph_post_defense_target_changed','Owned ranged retreat changed original target admission');
        mintedRefusal=true;
        rangedTargetRefusals.set(error,{goal,movements,target:plain(target),fromNode,fromId,deadline:legDeadline,
          actual,observedAt:Date.now(),maximumDisplacement:witness.maximumDisplacement,
          maximumVerticalDisplacement:witness.maximumVerticalDisplacement,defenseFrom:{...witness.from}});
        throw error;
        } catch (error) {
          if (!rangedTargetRefusals.has(error)) guardFailures.add(error);
          throw error;
        }
      };
      while(true) {
        try {
          const move = deps.actualnativegoto ? deps.actualnativegoto(goal, movements, { deadline: legDeadline,
            ...(canRevalidateRetreat ? {onOwnedRangedRetreat} : {}),
            isExpectedNativeTimeout:()=>!guardError&&owner()&&bot.pathfinder.movements===movements
              &&bot.pathfinder.goal===goal&&nativePathFacts.status==='timeout'&&deps.isMovementSuspended?.()!==true,
            isExpectedNativeNoPath:()=>deferInconclusiveExplorationReplay&&exploring&&!guardError
              &&owner()&&bot.pathfinder.movements===movements&&bot.pathfinder.goal===goal
              &&nativePathFacts.status==='noPath'&&deps.isMovementSuspended?.()!==true,
            isExpectedNativeStop:()=>expectedDropStop && dropBraking && ownsJumpObservation() && bot.pathfinder.goal===null }) : bot.pathfinder.goto(goal);
          await Promise.race([move, guardPromise]);gotoSettled=true;active();break;
        } catch(error) {
          if(!expectedDropStop || !dropBraking || !['GoalChanged','PathStopped'].includes(error.name)
            || !ownsJumpObservation() || bot.pathfinder.goal!==null)throw error;
          const settleDeadline=Math.min(legDeadline,Date.now()+1800);
          while(!hasGroundedBodySupport(bot) && Date.now()<settleDeadline) {
            assertProbeActive();
            if(!ownsJumpObservation() || bot.pathfinder.goal!==null)throw fail('dry_graph_movement_preempted','Drop braking lost its captured owner/goal');
            await Promise.race([new Promise(resolve=>setTimeout(resolve,20)),guardPromise]);
          }
          assertProbeActive();
          if(!ownsJumpObservation() || bot.pathfinder.goal!==null)throw fail('dry_graph_movement_preempted','Drop landing lost its captured owner/goal');
          if(terrainRecovery&&hasGroundedBodySupport(bot)&&!naturalWalkingFoot(bot,bot.entity.position.floored())){
            // Neutral braking may finish with real AABB support beside an
            // empty center column. Reuse the bounded native alignment instead
            // of declaring that observed grounded landing airborne/unsafe.
            const previousDrop=movements.maxDropDown;
            movements.maxDropDown=Math.min(2,previousDrop);
            try{
              await require('./houseGraphOriginAlignment').alignHouseGraphOrigin({getBot:()=>bot,
                assertActive:()=>{assertProbeActive();if(!owner()||bot.pathfinder.movements!==movements)
                  throw fail('dry_graph_movement_preempted','Drop alignment lost its original owner/profile');},
                goto:(alignmentGoal,budget)=>deps.actualnativegoto
                  ?deps.actualnativegoto(alignmentGoal,movements,{deadline:Math.min(legDeadline,Date.now()+budget)})
                  :bot.pathfinder.goto(alignmentGoal),
                record:facts=>deps.onGroundedDropAlignment?.({...facts,originalDeadline:legDeadline,graphNodeCredit:false}),
              },{deadline:legDeadline,excluded});
            }finally{
              if(owner()&&bot.pathfinder.movements===movements&&movements.maxDropDown===Math.min(2,previousDrop))movements.maxDropDown=previousDrop;
            }
            assertProbeActive();if(!ownsJumpObservation())throw fail('dry_graph_movement_preempted','Aligned drop lost its original goal');
          }
          if(!hasGroundedBodySupport(bot) || !naturalWalkingFoot(bot,bot.entity.position.floored())) {
            const failure=fail('dry_graph_drop_brake_unconfirmed','Neutral drop did not actually land on a dry stand');
            guardFailures.add(failure);throw failure;
          }
          try { deps.onControlledDropBrake?.({actual:plain(bot.entity.position),health:bot.health,originalDeadline:legDeadline,
            actualGrounded:true,positionOrVelocityWritten:false,brakes:dropBrakes}); } catch {}
          dropBraking=false;expectedDropStop=false;
          assertProbeActive();
          if(!probe(target,{observedReturnRetry,observedSuffix,assertProbeActive}))throw fail('dry_graph_probe_inconclusive','Post-drop native route remains unconfirmed',{observedProbe:copy(lastProbeFacts)});
        }
      }
      if (!owner()) throw fail('dry_graph_movement_preempted', 'Movement settled after its captured owner changed');
      // Original goto can resolve while descending. Keep guards live until
      // actual dry grounded landing; no position, velocity or world writes.
      const landingStartedAt=Date.now(),deadline=Math.min(landingStartedAt+5000,legDeadline),landingStartTick=physicsTick;
      const arrived=()=>bot.entity.onGround===true && key(bot.entity.position)===key(target)
        && naturalWalkingFoot(bot,bot.entity.position.floored()) && hasGroundedBodySupport(bot);
      while (!arrived() && Date.now()<deadline && physicsTick-landingStartTick<24) {
        assertProbeActive();if(!ownsJumpObservation())throw fail('dry_graph_movement_preempted','Post-goal landing lost its original native owner/profile/goal');
        await Promise.race([new Promise(resolve => setTimeout(resolve, 20)), guardPromise]); active();
      }
      if (!arrived()) throw fail('dry_graph_move_unconfirmed', 'Native dry endpoint was not confirmed',
        {observedLanding:{nativeGotoResolved:true,elapsedMs:Date.now()-landingStartedAt,physicsTicks:physicsTick-landingStartTick,
          deadline,legDeadline,actual:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},onGround:bot.entity.onGround}});
      if (!owner()) throw fail('dry_graph_movement_preempted', 'Dry landing finished after its captured owner changed');
      if(!ownsJumpObservation())throw fail('dry_graph_movement_preempted','Dry landing completed after its original goal/profile changed');
      assertProbeActive();recordTrailPoint(true);
      lastNativeSupports = [...moveSupports.values()];
      if(trailComplete && trailPoints.length>1 && key(trailPoints[0].position)===fromId && key(trailPoints.at(-1).position)===key(target)
        && key(bot.entity.position)===key(target))lastNativeTrail={schema:1,kind:'actual_successful_dry_parent_edge',complete:true,from:fromId,to:key(target),points:trailPoints};
      return plain(bot.entity.position);
    } catch (error) {
      // The host adapter enforces this same absolute deadline. Its awaited
      // rejection can win the timer callback in the same event-loop turn.
      // Close the graph through its original deadline guard before any later
      // owner check can replace that reason with the resulting preemption.
      if (!guardError && error.code === 'house_surface_movement_timeout' && Date.now() >= legDeadline)
        failMove(fail('dry_graph_leg_timeout', 'Native graph movement timed out'), 'deadline');
      if(!guardError&&['NoPath','Timeout'].includes(error.name)&&deferInconclusiveExplorationReplay&&exploring
        &&owner()&&bot.pathfinder.movements===movements&&bot.pathfinder.goal===goal){
        // Native search may consume a partial path before NoPath or Timeout.
        // Stop its controls, then retain the original live safety/deadline
        // guards until a real dry landing. Never credit the requested goal.
        gotoSettled=true;stopOwn();
        const settleUntil=Math.min(legDeadline,Date.now()+1800);
        while((!hasGroundedBodySupport(bot)||!naturalWalkingFoot(bot,bot.entity.position.floored())
          ||Math.hypot(bot.entity.velocity.x,bot.entity.velocity.z)>.02)&&Date.now()<settleUntil){
          assertProbeActive();if(!ownsJumpObservation())throw fail('dry_graph_movement_preempted','Partial native landing lost its owner');
          await Promise.race([new Promise(resolve=>setTimeout(resolve,20)),guardPromise]);
        }
        assertProbeActive();
        if(ownsJumpObservation()&&bot.entity.onGround===true&&hasGroundedBodySupport(bot)
          &&naturalWalkingFoot(bot,bot.entity.position.floored())&&inspectSurfaceBody(bot).dry){
          error.code=error.name==='Timeout'?'dry_graph_native_probe_timeout':'dry_graph_native_no_path';
          partialSiteLandings.set(error,{from:fromNode,actual:key(bot.entity.position),target:plain(target),deadline:legDeadline});
        }
      }
      stopOwn();const failure=guardError||error;failure.observedDryLeg={fromNode,from:fromId,target:plain(target),startedAt:legStartedAt,deadline:legDeadline};throw failure; } finally {
      legClosed=true; clearTimeout(timer); bot.removeListener('physicsTick', guard);
      bot.removeListener('path_update', observePath); bot.removeListener('path_reset', observePathReset);
    }
  }
  async function observeResourceWorkOrigin({observedCurrent,sharedDeadlineMs=Infinity}={}) {
    await ready();assertVitals();if(!owner())throw fail('dry_graph_movement_preempted','Resource observation lost its captured movement owner');
    const from=state.current,origin=state.nodes[from]?.position;
    if(!origin||observedCurrent!==from||state.pendingWater||state.pendingDryTrail)return {confirmed:false,reason:'original_transport_or_cursor_changed'};
    const iceCoast=require('./houseCreeperEscape').actualFullCubeContacts(bot).some(c=>['ice','frosted_ice','packed_ice','blue_ice'].includes(c.name));
    const originalDeadline=Math.min(Date.now()+35000,sharedDeadlineMs);
    let deadline=Math.min(originalDeadline,Date.now()+(iceCoast?3000:1200));
    while(Date.now()<deadline){
      const defended=await ready();assertVitals();
      if(defended===true)deadline=Math.min(originalDeadline,Date.now()+(iceCoast?3000:1200));
      if(Date.now()>=deadline)break;
      if(!owner())throw fail('dry_graph_movement_preempted','Resource observation lost its captured movement owner');
      const p=bot.entity.position,actual=plain(p),id=key(actual);
      if(bot.pathfinder.goal===null&&['forward','back','left','right','jump','sprint','sneak'].every(k=>bot.controlState?.[k]===false)
        &&bot.entity.onGround===true&&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,actual)&&inspectSurfaceBody(bot).dry
        &&bot.entity.velocity.x===0&&bot.entity.velocity.z===0){
        if(excluded(actual)||vec(actual).distanceTo(vec(origin))>32||Math.hypot(actual.x-anchor.x,actual.z-anchor.z)>radius)
          return {confirmed:false,reason:'outside_original_observation_envelope'};
        const isNew=!state.nodes[id];
        if(isNew){
          if(state.visits>=maxNodes)throw fail('dry_graph_node_limit','Actual resource landing consumes the original visited-node budget');
          state.nodes[id]={position:actual,parent:from,expanded:false,
            resourceWorkLanding:{fromNode:from,oldEdgeTraversalCredit:false,actualGroundedObservation:true}};
          state.order.push(id);state.visits++;
          state.blockedEdges.push({kind:'resource_work_landing',from,target:actual,edgeTraversalConfirmed:false});
        }
        state.current=id;state.resumeNode=id;save();
        const result={confirmed:true,current:id,actual,newActualNode:isNew,oldEdgeTraversalCredit:false,materialCredit:false};
        deps.onResourceWorkLanding?.(result);return result;
      }
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    return {confirmed:false,reason:'native_resource_actor_not_settled'};
  }
  function initialize() {
    active();refusePendingDryTrail(); const actual = plain(bot.entity.position);
    if (!naturalWalkingFoot(bot, actual) || bot.entity.onGround !== true || excluded(actual)) throw fail('dry_graph_not_on_surface', 'Graph starts only at a real grounded dry position');
    const id = key(actual);
    if (!state.current) {
      if (id !== key(anchor)) throw fail('dry_graph_start_not_anchor', 'First graph observation must be the fixed camp');
      state.nodes[id] = { position: actual, parent: null, expanded: false }; state.order.push(id); state.current = id; state.resumeNode = id; state.visits = 1; save();
    } else if (!state.nodes[id]) throw fail('dry_graph_resume_position', 'Actual resumed position is not an observed graph node');
    else { state.current = id; save(); }
  }
  async function expand(id) {
    active(); if (state.current !== id || key(bot.entity.position) !== id) throw fail('dry_graph_wrong_expansion_origin', 'Only an actually visited current node can be expanded',
      {graphOrigin:{expected:id,current:state.current,actual:plain(bot.entity.position),ownerCurrent:owner(),pendingWater:Boolean(state.pendingWater),pendingDryTrail:Boolean(state.pendingDryTrail)}});
    const node = state.nodes[id]; if (node.expanded) return;
    const directions = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (const [dx, dz] of directions) {
      let chosen = false;
      for (const side of [0, 4, -4, 8, -8]) {
        active(); const x = node.position.x + dx * step - dz * side, z = node.position.z + dz * step + dx * side;
        if (Math.hypot(x - anchor.x, z - anchor.z) > radius) continue;
        for (const target of loadedSurfaceFeet(bot, x, z, node.position.y).slice(0, 2)) {
          if (excluded(target) || state.nodes[key(target)] || state.frontier.some(v => key(v.target) === key(target))) continue;
          await new Promise(resolve=>setTimeout(resolve,0));await readyExplorationBoundary();
          if(state.current!==id||key(bot.entity.position)!==id)return false;
          const path = probe(target);
          if (!path) {
            state.blockedEdges.push({ from: id, target: plain(target), reason: lastProbeFacts?.status === 'noPath' && lastProbeFacts.conclusive ? 'native_no_path' : 'native_probe_inconclusive', observedProbe: copy(lastProbeFacts) });
            if (offerNativeReachableHint(id, target)) { chosen = true; break; }
            continue;
          }
          state.frontier.push({ parent: id, target: plain(target), plannedSteps: path.path.length }); chosen = true; break;
        }
        if (chosen) break;
      }
    }
    if (waterEnabled && !Number.isFinite(continuationDeadline)) {
      const candidates = deps.discoverWaterRoutes({ origin: copy(node.position), anchor: copy(anchor), excludeBounds: copy(exclusions), maxDistance: 16 });
      if (!Array.isArray(candidates) || candidates.length > 4) throw fail('dry_graph_transport_invalid', 'Native shallow-route discovery must return a finite synchronous batch');
      for (const candidate of candidates) {
        const edge = { parent: id, target: copy(candidate?.route?.to || {}),
          transport: { kind: candidate?.route?.kind === 'loaded_surface_swim' ? 'source_water_surface' : 'source_water_depth1',
            route: copy(candidate?.route || {}) } };
        waterTransport(edge);
        if (Math.hypot(edge.target.x - anchor.x, edge.target.z - anchor.z) > radius
          || state.nodes[key(edge.target)] || state.frontier.some(value => key(value.target) === key(edge.target))) continue;
        if (!naturalWalkingFoot(bot, edge.transport.route.from) || !naturalWalkingFoot(bot, edge.target) || !probe(edge.transport.route.from)) continue;
        state.frontier.push(edge);
      }
    }
    const incoming = node.parent ? { x: node.position.x - state.nodes[node.parent].position.x, z: node.position.z - state.nodes[node.parent].position.z } : null;
    const alignment = edge => {
      if (!incoming) return 0;
      const dx = edge.target.x - node.position.x, dz = edge.target.z - node.position.z;
      return (incoming.x * dx + incoming.z * dz) / (Math.hypot(incoming.x, incoming.z) * Math.hypot(dx, dz));
    };
    const outgoing = state.frontier.filter(edge => edge.parent === id).sort((a, b) => Number(Boolean(b.transport)) - Number(Boolean(a.transport)) || alignment(b) - alignment(a)
      || Math.hypot(b.target.x - anchor.x, b.target.z - anchor.z) - Math.hypot(a.target.x - anchor.x, a.target.z - anchor.z));
    state.frontier = [...outgoing, ...state.frontier.filter(edge => edge.parent !== id)];
    node.expanded = true; save();
  }
  const needsActualLocalRefinement=node=>preferActualLocalFrontier
    &&Array.isArray(node?.localFrontierObservation?.testedRanges)&&(!node.localFrontierObservation.testedRanges.includes(1)
      ||node.localFrontierObservation.nativeShortProbeRevision!==1&&state.blockedEdges.some(e=>e.from===key(node.position)&&e.reason==='native_probe_inconclusive'));
  function needsSiteLocalRefinement(node) {
    return deferInconclusiveExplorationReplay && Array.isArray(node?.localFrontierObservation?.testedRanges)
      && !node.localFrontierObservation.testedRanges.includes(1);
  }
  async function expandLocalFrontier(id,resourceHint=null) {
    active();
    if (!adaptiveLocalFrontier) return;
    if (state.current !== id || key(bot.entity.position) !== id || !owner())
      throw fail('dry_graph_wrong_expansion_origin', 'Local frontier requires the actual observed current owner/node',
        {graphOrigin:{expected:id,current:state.current,actual:plain(bot.entity.position),ownerCurrent:owner(),pendingWater:Boolean(state.pendingWater),pendingDryTrail:Boolean(state.pendingDryTrail)}});
    const node = state.nodes[id];
    if (!node || (resourceHint?node.resourceLocalFrontierExpanded:node.localFrontierExpanded&&!needsSiteLocalRefinement(node)&&!needsActualLocalRefinement(node))) return;
    let directions=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]];
    if(resourceHint){
      const dx=resourceHint.position.x-node.position.x,dz=resourceHint.position.z-node.position.z;
      directions=directions.filter(([x,z])=>x*dx+z*dz>0).sort(([x,z],[a,b])=>(a*dx+b*dz)/Math.hypot(a,b)-(x*dx+z*dz)/Math.hypot(x,z)).slice(0,2);
    }
    // Site exploration may consume a productive coarse ring before a later
    // one-way replay fails. Keep the smaller untried rings available under
    // the same original node/probe/deadline budgets, including saved graphs.
    const testedRanges = !resourceHint&&deferInconclusiveExplorationReplay
      ? [...new Set((node.localFrontierObservation?.testedRanges||[]).filter(n=>[8,4,2,1].includes(n)))] : [];
    if(!resourceHint&&preferActualLocalFrontier&&!deferInconclusiveExplorationReplay)
      testedRanges.push(...new Set((node.localFrontierObservation?.testedRanges||[]).filter(n=>[8,4,2,1].includes(n))));
    if(!resourceHint&&preferActualLocalFrontier&&node.localFrontierObservation?.nativeShortProbeRevision!==1
      &&state.blockedEdges.some(e=>e.from===id&&e.reason==='native_probe_inconclusive')){
      for(let i=testedRanges.length-1;i>=0;i--)if(testedRanges[i]<=2)testedRanges.splice(i,1);
    }
    let shortRetries=0;
    for (const distance of [8, 4, 2, 1].filter(n=>!testedRanges.includes(n))) {
      active(); testedRanges.push(distance); let planned = 0;
      for (const [dx, dz] of directions) {
        active(); const x = node.position.x + dx * distance, z = node.position.z + dz * distance;
        if (Math.hypot(x-anchor.x,z-anchor.z) > radius) continue;
        for (const target of loadedSurfaceFeet(bot,x,z,node.position.y,{up:8,down:8}).slice(0,2)) {
          active(); if (excluded(target) || state.nodes[key(target)] || state.frontier.some(edge=>key(edge.target)===key(target))) continue;
          await new Promise(resolve=>setTimeout(resolve,0));await readyExplorationBoundary();
          if(state.current!==id||key(bot.entity.position)!==id)return false;
          let path = probe(target);
          if(!path&&distance<=2&&shortRetries<4&&!lastProbeFacts?.conclusive&&typeof deps.pathprobe!=='function'
            &&naturalWalkingFoot(bot,target)&&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
            active();shortRetries++;if(++state.probes>maxEdges)throw fail('dry_graph_probe_limit','Short native recheck consumes the original probe budget');
            const retry=observeSurfaceGraphNativeProbe(bot,movements,new goals.GoalBlock(target.x,target.y,target.z),
              {assertActive:active,isOwnerCurrent:owner,timeoutMs:500,tickTimeoutMs:10,maxSlices:50},500,50);
            lastProbeFacts={...retry.facts,budgetMs:500,shortLocalRetry:true,newNodeOrVisitCredit:false};lastProbeResult=retry.result;
            deps.onProbe?.(copy(lastProbeFacts));active();
            if(retry.result?.status==='success'&&retry.facts.conclusive)path=retry.result;
          }
          if (!path) {
            state.blockedEdges.push({from:id,target:plain(target),adaptiveLocalRadius:distance,
              reason:lastProbeFacts?.status==='noPath'&&lastProbeFacts.conclusive?'native_no_path':'native_probe_inconclusive',observedProbe:copy(lastProbeFacts)});
            continue;
          }
          // A short native plan is only a candidate. nativeMove, owner/body
          // guards, actual arrival, parent trails and visit credit remain below.
          state.frontier.push({parent:id,target:plain(target),plannedSteps:path.path.length,adaptiveLocalRadius:distance});
          planned++; break;
        }
      }
      if (planned) break;
    }
    active(); if(resourceHint)node.resourceLocalFrontierExpanded=true;else node.localFrontierExpanded = !deferInconclusiveExplorationReplay||testedRanges.includes(1);
    if(!resourceHint&&preferActualLocalFrontier)node.localFrontierExpanded=testedRanges.includes(1);
    if(resourceHint)node.resourceLocalFrontierObservation={testedRanges,domain:'NATIVE_PLAN_ONLY',directionCoverage:'hint_only',actualMovementConfirmed:false};
    else node.localFrontierObservation = {testedRanges,domain:'NATIVE_PLAN_ONLY',directionCoverage:'all_eight',nativeShortProbeRevision:1,actualMovementConfirmed:false};
    save();
  }
  async function moveEdge(edge, reverse = false) {
    const route = waterTransport(edge);
    if (!route) return nativeMove(edge.target || edge.position);
    if(exploring&&!reverse&&deps.isWaterRouteThreatened?.(route)===true)throw fail('dry_graph_transport_threat','Observed hostile blocks this outbound water route');
    lastNativeSupports = [];lastNativeTrail=null;
    assertVitals(); if (!owner()) throw fail('dry_graph_movement_preempted', 'Water edge no longer owns movement');
    state.pendingWater = { edge: copy(edge), reverse, originNode: state.current }; save();
    const destination = reverse ? state.nodes[edge.parent].position : route.to;
    if (reverse) { const original = route.from; route.from = route.to; route.to = original; }
    if (key(bot.entity.position) !== key(route.from)) {
      if (reverse) throw fail('dry_graph_transport_origin', 'Reverse water travel must start on its actually observed child bank');
      let actual;
      try { actual = await nativeMove(route.from); }
      catch(error){
        if(!reverse&&error.code==='house_site_defense_relocated'&&state.pendingWater?.edge
          &&state.pendingWater.originNode===state.current&&!state.pendingWater.bankArrival
          &&key(error.observedDryLeg?.target)===key(route.from))
          outboundBankDefense.set(error,{pending:state.pendingWater,target:copy(route.from)});
        throw error;
      }
      if (key(actual) !== key(route.from)) throw fail('dry_graph_transport_origin', 'The dry approach did not actually reach its entry bank');
    }
    assertVitals();
    let result;
    try{result = await deps.traverseWater(copy(route), { recoveryReturn: provisioningReturn && reverse, survivalProvisioning });}
    catch(error){
      if(exploring&&deferInconclusiveExplorationReplay&&!reverse&&route.kind==='loaded_surface_swim'
        &&['surface_swim_no_progress','house_surface_surface_swim_no_progress'].includes(error.code)
        &&error.recoveredToDryBank===true&&error.holding===false&&!error.houseWaterForeignActor
        &&owner()&&bot.pathfinder.movements===movements&&!state.pendingWater?.bankArrival&&!state.pendingDryTrail
        &&state.pendingWater?.originNode===state.current&&state.current===edge.parent
        &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,bot.entity.position.floored())&&inspectSurfaceBody(bot).dry
        &&vec(plain(bot.entity.position)).distanceTo(vec(route.from))<=2.5)
        recoveredOutboundWater.set(error,{pending:state.pendingWater,from:copy(route.from)});
      throw error;
    }
    assertVitals();
    if (!owner()) throw fail('dry_graph_movement_preempted', 'Water traversal settled after its captured owner changed');
    if (result?.confirmed !== true || key(bot.entity.position) !== key(route.to) || !naturalWalkingFoot(bot, route.to)
      || !hasGroundedBodySupport(bot)) throw fail('dry_graph_transport_unconfirmed', 'A native shallow crossing requires actual dry grounded arrival');
    state.pendingWater.bankArrival={position:copy(route.to),confirmedAt:Date.now(),nativeTraversalConfirmed:true};save();
    if (reverse && key(destination) !== key(route.to)) return nativeMove(destination);
    return plain(bot.entity.position);
  }
  async function recoverPendingWater() {
    const pending = state.pendingWater;
    if (!pending) return;
    if (pending.originNode !== state.current || typeof pending.reverse !== 'boolean' || !state.nodes[state.current]) {
      throw fail('dry_graph_transport_invalid', 'Pending water operation lost its original observed node');
    }
    if (!pending.reverse && pending.edge?.parent !== pending.originNode
      || pending.reverse && key(pending.edge?.position || pending.edge?.target || {}) !== pending.originNode) {
      throw fail('dry_graph_transport_invalid', 'Pending water operation is not the original forward or reverse edge');
    }
    let route = waterTransport(pending.edge);
    if (!route) throw fail('dry_graph_transport_invalid', 'Pending water operation has no captured route');
    if (pending.reverse) route = { ...route, from: route.to, to: route.from };
    assertVitals(); if (!owner()) throw fail('dry_graph_movement_preempted', 'Pending recovery no longer owns movement');
    if (!naturalWalkingFoot(bot, plain(bot.entity.position)) || !hasGroundedBodySupport(bot)) {
      throw fail('dry_graph_transport_resume_unsafe', 'Interrupted water work can resume only from an actual dry supported position');
    }
    const original = state.nodes[state.current].position;
    // A native-confirmed reverse crossing already returned to the parent side.
    // Reconnect directly to its recorded parent after a dry defense detour;
    // replaying water to the child would undo that actual crossing.
    const parent=pending.reverse&&pending.bankArrival?.nativeTraversalConfirmed===true
      &&key(pending.bankArrival.position)===key(route.to)&&state.nodes[pending.edge.parent];
    if(parent&&deferInconclusiveExplorationReplay&&!state.pendingDryTrail
      &&vec(plain(bot.entity.position)).distanceTo(vec(parent.position))<=32
      &&probe(parent.position)){
      const actual=await nativeMove(parent.position,{observedReturnRetry:true});
      active();if(!owner()||key(actual)!==key(parent.position)||!hasGroundedBodySupport(bot))
        throw fail('dry_graph_transport_unconfirmed','Completed reverse crossing requires actual parent reconnect');
      state.current=pending.edge.parent;state.resumeNode=state.current;state.pendingWater=null;save();
      deps.onSiteDefenseRelocation?.({actual:copy(actual),completedReverseCrossing:true,newCrossingCredit:false,oldTargetReached:true});
      return;
    }
    if (key(bot.entity.position) !== key(original)) {
      const rewindWater = async () => {
        const result = await deps.traverseWater({ ...route, from: route.to, to: route.from }, { recoveryReturn: provisioningReturn||survivalProvisioning });
        assertVitals(); if (!owner()) throw fail('dry_graph_movement_preempted', 'Pending recovery settled after ownership changed');
        if (result?.confirmed !== true || key(bot.entity.position) !== key(route.from) || !hasGroundedBodySupport(bot)) {
          throw fail('dry_graph_transport_unconfirmed', 'Pending water recovery did not reach its real original bank');
        }
      };
      if (key(bot.entity.position) === key(route.to)) {
        await rewindWater();
      } else if(!pending.reverse&&vec(plain(bot.entity.position)).distanceTo(vec(route.to))<=16
        &&vec(plain(bot.entity.position)).distanceTo(vec(route.to))<vec(plain(bot.entity.position)).distanceTo(vec(route.from))){
        // A completed crossing can be interrupted a few dry blocks beyond
        // its bank (for example by knockback). Confirm a fresh dry reconnect
        // to that bank, then use the captured typed water route to rewind.
        // Proximity alone never establishes either arrival or a crossing.
        const bank=await nativeMove(route.to);
        if(key(bank)!==key(route.to))throw fail('dry_graph_transport_unconfirmed','Interrupted forward dry leg did not reach its observed bank');
        await rewindWater();
      } else if (pending.reverse) {
        // Reverse travel may have crossed already and then paused on the dry
        // entry-bank-to-parent leg. The original child lies across the water;
        // first return dry to this side's bank, then use the reversed transport.
        const reconnectOptions={observedReturnRetry:true,
          observedSuffix:{nodeId:state.current,from:plain(bot.entity.position),to:plain(original)}};
        if (vec(plain(bot.entity.position)).distanceTo(vec(original))<=16&&probe(original,reconnectOptions))
          await nativeMove(original,reconnectOptions);
        else if (vec(plain(bot.entity.position)).distanceTo(vec(route.to)) <= 16) {
          const bank = await nativeMove(route.to);
          if (key(bank) !== key(route.to)) throw fail('dry_graph_transport_unconfirmed', 'Interrupted reverse dry leg did not reach its observed bank');
          await rewindWater();
        } else throw fail('dry_graph_transport_origin', 'Interrupted reverse transport is outside its finite dry return');
      } else if (vec(plain(bot.entity.position)).distanceTo(vec(original)) <= 32) {
        // Combat can displace an actor back along this bank's dry approach.
        // Revalidate a bounded dry connector to the original observed node;
        // being farther from the water entry does not require another swim.
        // No crossing/visit credit is assigned by this physical reconnect.
        await nativeMove(original,{observedReturnRetry:true,
          observedSuffix:{nodeId:state.current,from:plain(bot.entity.position),to:plain(original)}});
      } else if (vec(plain(bot.entity.position)).distanceTo(vec(route.from)) > 16) {
        throw fail('dry_graph_transport_origin', 'Interrupted transport is outside its finite dry approach');
      }
      if (key(bot.entity.position) !== key(original)) {
        const returned = await nativeMove(original);
        if (key(returned) !== key(original)) throw fail('dry_graph_transport_unconfirmed', 'Interrupted water work did not retrace its observed parent');
      }
    }
    const pendingTarget=pending.edge.target||pending.edge.position;
    if(!pendingTarget||!['x','y','z'].every(axis=>Number.isSafeInteger(pendingTarget[axis])))throw fail('dry_graph_transport_invalid','Pending water operation has no bounded target');
    if (!pending.reverse && !state.nodes[key(pendingTarget)]
      && !state.frontier.some(edge => edge.parent === pending.edge.parent && key(edge.target) === key(pendingTarget))) {
      if (state.frontier.length >= maxEdges) throw fail('dry_graph_probe_limit', 'Pending water retry exceeds the finite saved frontier');
      state.frontier.unshift({...copy(pending.edge),target:copy(pendingTarget)});
    }
    state.pendingWater = null; save();
  }
  async function replayRecordedDryEdge(targetId,error) {
    const proof=error.observedProbe,originId=state.current,origin=state.nodes[originId],target=state.nodes[targetId];
    const child=target?.parent===originId?targetId:origin?.parent===targetId?originId:null;
    if(error.code!=='dry_graph_probe_inconclusive'||proof?.observedReturnRetry!==true||proof.budgetMs!==500||proof.conclusive
      ||proof.status==='noPath'||proof.initialProbe?.conclusive||proof.initialProbe?.status==='noPath'
      ||!child||state.nodes[child].transport||!validDryParentTrail(state.nodes[child].dryParentTrail,state.nodes,child))throw error;
    const deadline=error.observedDryLeg?.deadline;
    if(!Number.isFinite(deadline)||error.observedDryLeg.fromNode!==originId||key(bot.entity.position)!==originId
      ||!state.order.includes(originId)||!state.order.includes(targetId))throw error;
    const reader=trailReader(deadline);reader.check();
    if(!naturalWalkingFoot(reader.view,origin.position)||!hasGroundedBodySupport(reader.view)||!naturalWalkingFoot(reader.view,target.position)
      ||excluded(origin.position)||excluded(target.position))throw fail('dry_graph_trail_route_changed','Registered dry trail endpoints are no longer actually safe');
    const trail=state.nodes[child].dryParentTrail,points=trail.from===originId?trail.points:[...trail.points].reverse();
    for(const point of points)revalidateTrailPoint(point,reader);
    const first=actualDryTrailPoint(reader);if(!first||key(first.position)!==originId)throw error;
    state.pendingDryTrail={schema:1,kind:'actual_dry_trail_prefix',originNode:originId,targetNode:targetId,
      confirmedPrefix:[first],observedAt:Date.now(),reason:'native_replay_started'};reader.check();save();reader.check();
    const replaySupports=new Map();
    try{
      for(const point of points.slice(1)){
        revalidateTrailPoint(point,reader);
        const actual=await nativeMove(point.position,{sharedDeadlineMs:deadline,captureTrail:false});reader.check();
        const observed=actualDryTrailPoint(reader);
        if(!observed||key(actual)!==key(point.position)||key(observed.position)!==key(point.position))throw fail('dry_graph_trail_replay_unconfirmed','A saved actual foot waypoint was not really reached');
        for(const p of lastNativeSupports)replaySupports.set(key(p),p);
        state.pendingDryTrail={...state.pendingDryTrail,confirmedPrefix:[...state.pendingDryTrail.confirmedPrefix,observed],observedAt:Date.now()};save();reader.check();
      }
      if(key(bot.entity.position)!==targetId||!hasGroundedBodySupport(reader.view))throw fail('dry_graph_trail_replay_unconfirmed','The original registered endpoint was not actually reached');
      lastNativeSupports=[...replaySupports.values()];
      return plain(bot.entity.position);
    }catch(failure){
      failure.observedDryTrailReplay={originNode:originId,targetNode:targetId,registeredCurrent:state.current,
        confirmedPrefix:copy(state.pendingDryTrail?.confirmedPrefix||[]),actualPosition:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},
        actualNode:key(bot.entity.position),endpointConfirmed:false,deadline,originalProbe:copy(proof)};
      // Keep a truthful prefix marker even if pause/foreign ownership prevents
      // saving another fact. A later cleanup cannot initialize another saved
      // node at that partial pose and accidentally skip its typed transport.
      try{reader.check();if(key(bot.entity.position)===originId&&hasGroundedBodySupport(reader.view)){state.pendingDryTrail=null;save();}}catch{}
      throw failure;
    }
  }
  async function observedReturnMove(target, options = {}) {
    assertVitals();
    const deadline=Math.min(Date.now()+legTimeoutMs,options.sharedDeadlineMs??Infinity);
    const stalled=state.lastReturnStall;
    if(stalled&&key(stalled.position)===key(bot.entity.position)&&key(stalled.target)===key(target)){
      await recoverLocalPassage({fromActual:true,toward:target,sharedDeadlineMs:deadline});
      assertVitals();
    }
    try{
      const result=await nativeMove(target,{...options,sharedDeadlineMs:deadline,
        ...(options.observedSuffix?{observedSuffix:{nodeId:state.current,from:plain(bot.entity.position),to:plain(target)}}:{})});
      if(state.lastReturnStall){state.lastReturnStall=null;save();}
      return result;
    }catch(error){
      if(['executor_stalled','house_executor_stalled','dry_graph_leg_timeout','dry_graph_move_unconfirmed'].includes(error.code)
        &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,bot.entity.position.floored())){
        try{active();state.lastReturnStall={position:plain(bot.entity.position),target:plain(target),reason:error.code,at:Date.now()};save();}catch{ /* Preserve the original movement failure. */ }
      }
      throw error;
    }
  }
  async function knownDryMove(targetId,deadline=Infinity) {
    try{return await observedReturnMove(state.nodes[targetId].position,{observedReturnRetry:true,sharedDeadlineMs:deadline});}
    catch(error){
      // A site search has no cargo or required camp return. Let its existing
      // unchanged-origin deferral choose a fresh frontier after UNKNOWN global
      // replanning, instead of spending the whole leg retracing an optional
      // old branch. Explicit return still requires the actual recorded trail.
      if(deferInconclusiveExplorationReplay&&exploring&&error.code==='dry_graph_probe_inconclusive')throw error;
      return replayRecordedDryEdge(targetId,error);
    }
  }
  async function visitParent(parent) {
    const visitStartedAt=Date.now();
    // Nearby coordinates can require a long native detour around a cliff.
    // Keep the caller's configured finite leg budget instead of silently
    // replacing it with15s; neither probing nor recovery resets this deadline.
    if (parent === state.current) return;
    // An observed coordinate is the target. Replan only through the existing
    // loaded dry no-dig/no-place profile; a failed dry plan keeps exact typed
    // parent transports as fallback, rather than pretending water is dry.
    const target = state.nodes[parent];
    if (!target) throw fail('dry_graph_disconnected', 'Target is not an actually observed node');
    if (probe(target.position)) {
      const from=state.current,adjacent=target.parent===from||state.nodes[from]?.parent===parent;
      const actual = await knownDryMove(parent,adjacent?visitStartedAt+legTimeoutMs:Infinity); active();
      if (!owner()) throw fail('dry_graph_movement_preempted', 'Observed-coordinate return finished after ownership changed');
      if (key(actual) !== parent) throw fail('dry_graph_replay_unconfirmed', 'Observed target coordinate was not actually reached');
      const supports = new Map([...(target.supportPositions || []), ...lastNativeSupports].map(p => [key(p), p]));
      target.supportPositions = [...supports.values()];
      commitNativeTrail(from,parent);state.current = parent; state.pendingWater = null;state.pendingDryTrail=null; save();
      return;
    }
    // A 100 ms global replan can remain UNKNOWN. Independently revalidate
    // shorter segments to coordinates already observed on the saved tree;
    // neither a timeout nor the historical route grants movement credit.
    const directProbe = copy(lastProbeFacts);
    const ancestors = [], seen = new Set();
    for (let id = state.current; id; id = state.nodes[id]?.parent) {
      if (seen.has(id) || !state.nodes[id] || ancestors.length >= 512) throw fail('dry_graph_disconnected', 'Observed segment route is cyclic or exceeds its finite node bound');
      seen.add(id); ancestors.push(id);
    }
    const down = []; let common = parent;
    while (!ancestors.includes(common)) {
      if (!state.nodes[common] || down.includes(common) || down.length >= 512) throw fail('dry_graph_disconnected', 'No finite verified parent route');
      down.push(common); common = state.nodes[common].parent;
      if (!common) throw fail('dry_graph_disconnected', 'No verified parent route');
    }
    const path = [...ancestors.slice(1, ancestors.indexOf(common) + 1), ...down.reverse()];
    if (path.length > 512) throw fail('dry_graph_disconnected', 'Observed segment route exceeds its finite node bound');
    let index = 0;
    while (index < path.length) {
      const edgeDeadline=Date.now()+legTimeoutMs;
      assertVitals(); if (!owner()) throw fail('dry_graph_movement_preempted', 'Observed segment owner changed');
      // Try at most four short observed coordinates. Reserve the immediate
      // next node so a farther inconclusive shortcut cannot strand a safe leg.
      const candidates = [];
      for (let i = path.length - 1; i >= index; i--) {
        if (vec(state.nodes[path[i]].position).distanceTo(bot.entity.position) <= 32) candidates.push(i);
      }
      const nextWithinRange = candidates.includes(index);
      const selected = candidates.filter(i => i !== index).slice(0, nextWithinRange ? 3 : 4);
      if (nextWithinRange) selected.push(index);
      let reached = false, segmentProbe = null;
      for (const candidate of selected) {
        assertVitals(); if (!owner()) throw fail('dry_graph_movement_preempted', 'Observed shortcut owner changed');
        const id = path[candidate], node = state.nodes[id];
        if (!probe(node.position)) { segmentProbe = copy(lastProbeFacts); continue; }
        const from=state.current,actual = await knownDryMove(id,candidate===index?edgeDeadline:Infinity); active();
        if (!owner()) throw fail('dry_graph_movement_preempted', 'Observed shortcut finished after ownership changed');
        if (key(actual) !== id) throw fail('dry_graph_replay_unconfirmed', 'Observed shortcut coordinate was not actually reached');
        const supports = new Map([...(node.supportPositions || []), ...lastNativeSupports].map(p => [key(p), p]));
        node.supportPositions = [...supports.values()];
        commitNativeTrail(from,id);state.current = id; state.pendingWater = null;state.pendingDryTrail=null; save();
        index = candidate + 1; reached = true; break;
      }
      if (reached) continue;
      const id = path[index], current = state.nodes[state.current], next = state.nodes[id];
      const reverse = current.parent === id;
      // Exact typed water remains separate from a dry shortcut. Every dry
      // fallback is re-probed and guarded by the original nativeMove.
      let actual;
      try {
        actual = reverse && current.transport ? await moveEdge(current, true)
          : !reverse && next.transport ? await moveEdge(next) : await knownDryMove(id,edgeDeadline);
      } catch (error) {
        error.observedCoordinateSegments = { directProbe, segmentProbe, routeIndex: index,
          routeLength: path.length, actualNode: state.current, targetNode: parent };
        throw error;
      }
      if (!owner()) throw fail('dry_graph_movement_preempted', 'Observed typed fallback finished after ownership changed');
      if (key(actual) !== id) throw fail('dry_graph_replay_unconfirmed', 'Previously observed typed node was not actually reached');
      const supports = new Map([...(next.supportPositions || []), ...lastNativeSupports].map(p => [key(p), p]));
      next.supportPositions = [...supports.values()];
      commitNativeTrail(state.current,id);state.current = id; state.pendingWater = null;state.pendingDryTrail=null; save();
      index++;
    }
  }
  async function tryExplorationReplay(id) {
    const requestedFrom=state.current;
    if(deferredSiteReplays.has(`${state.current}>${id}`))return false;
    try {await visitParent(id);return true;}
    catch(error) {
      if(adoptPartialSiteLanding(error)){
        const from=state.current;deferredSiteReplays.add(`${from}>${id}`);deferredSiteReplays.add(`${requestedFrom}>${id}`);
        return false;
      }
      if(error.code==='dry_graph_transport_threat'&&!state.pendingWater&&!state.pendingDryTrail&&owner()
        &&key(bot.entity.position)===state.current&&naturalWalkingFoot(bot,bot.entity.position.floored())&&hasGroundedBodySupport(bot)){
        deferredSiteReplays.add(`${state.current}>${id}`);state.resumeNode=state.current;save();return false;
      }
      // Explosions and player edits invalidate historical exploration targets.
      // Keep their evidence, but never repeatedly replay a missing floor. Only
      // abandon a branch while physically at a safe registered node outside it.
      if(error.code==='dry_graph_route_changed'&&error.observedRouteTarget){
        active();const bad=key(error.observedRouteTarget.target),invalid=new Set([bad]);
        // A missing historical parent does not invalidate a descendant where
        // this same actor is still actually standing on a loaded safe floor.
        // Retain those visits and their parent history; fresh native movement
        // must prove every future edge, including any route around the gap.
        if(exploring&&!state.pendingDryTrail&&!state.pendingWater&&owner()&&bot.pathfinder.movements===movements
          &&!invalid.has(state.current)&&state.nodes[state.current]&&key(bot.entity.position)===state.current
          &&naturalWalkingFoot(bot,bot.entity.position.floored())&&hasGroundedBodySupport(bot)){
          for(const node of invalid)if(state.nodes[node])state.nodes[node].terrainUnavailable={at:Date.now(),reason:error.code,facts:copy(error.observedRouteTarget)};
          state.frontier=state.frontier.filter(edge=>!invalid.has(edge.parent)&&!invalid.has(key(edge.target)));
          state.resumeNode=state.current;state.nodes[state.current].expanded=false;state.nodes[state.current].localFrontierExpanded=false;
          state.blockedEdges.push({kind:'terrain_changed_exploration_branch',from:state.current,targetNode:bad,reason:error.code,actualMovementConfirmed:false});
          deferredSiteReplays.add(`${state.current}>${id}`);deferredSiteReplays.add(`${requestedFrom}>${id}`);
          save();return false;
        }
      }
      // Falling can make the observed tree directed. All exploration may
      // choose another branch after a failed, unmoved parent replay. Explicit
      // camp/material return still requires its real route and cannot defer it.
      if(!exploring || guardFailures.has(error)
        ||!['dry_graph_native_no_path','dry_graph_probe_inconclusive'].includes(error.code))throw error;
      active();const leg=error.observedDryLeg;
      if(state.pendingDryTrail||state.pendingWater||!owner()||bot.pathfinder.movements!==movements
        ||!leg||leg.fromNode!==state.current||leg.from!==key(bot.entity.position)
        ||!state.nodes[state.current]||key(state.nodes[state.current].position)!==key(bot.entity.position)
        ||!naturalWalkingFoot(bot,bot.entity.position.floored())||!hasGroundedBodySupport(bot))throw error;
      const from=state.current;
      // A reverse route may physically reach a lower common ancestor before
      // its next upward leg proves impossible. Defer the ORIGINAL requested
      // replay too, so resuming its child cannot immediately select it again.
      // Keep the real current node and all original visit/probe budgets.
      deferredSiteReplays.add(`${from}>${id}`);deferredSiteReplays.add(`${requestedFrom}>${id}`);
      state.resumeNode=state.current;
      state.blockedEdges.push({kind:'unconfirmed_site_parent_replay',from,requestedFrom,targetNode:id,reason:error.code,
        scope:'exploration_only',retryAfter:Date.now()+(error.observedProbe?.conclusive===true?120000:15000),
        observedProbe:copy(error.observedProbe||null),actualMovementConfirmed:false});save();
      try {deps.onProbe?.({observedParentReplayDeferred:true,from,targetNode:id,reason:error.code,
        actualPosition:plain(bot.entity.position),reverseReachability:'UNCONFIRMED',actualMovementPerformed:false});}catch{}
      return false;
    }
  }
  async function recoverLocalPassage({fromActual=false,toward=null,sharedDeadlineMs=Infinity}={}) {
    if (!terrainRecovery || typeof deps.digPassageBlock !== 'function') return false;
    assertVitals();const id=fromActual?key(bot.entity.position):state.current;
    const recoveryKey=`${id}>${toward?key(toward):''}`;
    const node=fromActual?{position:plain(bot.entity.position),passageRecoveryTried:state.returnPassageRecoveries?.includes(recoveryKey)}:state.nodes[id];
    if(!node || node.passageRecoveryTried || key(bot.entity.position)!==id || !hasGroundedBodySupport(bot)) return false;
    if(fromActual&&(state.returnPassageAttempts||0)>=8)return false;
    if(fromActual){state.returnPassageRecoveries||=[];state.returnPassageAttempts=(state.returnPassageAttempts||0)+1;}
    node.passageRecoveryTried=true;save();
    const { inspectMiningStep }=require('./miningNavigation');
    const allowed=b=>b && (/^(?:dirt|grass_block|rooted_dirt|coarse_dirt|stone|cobblestone)$/.test(b.name)||b.name.endsWith('_leaves'));
    const directions=[[1,0],[0,1],[-1,0],[0,-1]];
    if(toward)directions.sort(([ax,az],[bx,bz])=>((node.position.x+ax-toward.x)**2+(node.position.z+az-toward.z)**2)-((node.position.x+bx-toward.x)**2+(node.position.z+bz-toward.z)**2));
    for(const [x,z] of directions) {
      active();if(!owner())throw fail('dry_graph_movement_preempted','Passage recovery lost its owner');
      const inspect=()=>inspectMiningStep({blockAt:bot.blockAt.bind(bot),from:node.position,direction:{x,z},allowLeafSupport:true,minY:bot.game?.minY??-64,maxY:(bot.game?.minY??-64)+(bot.game?.height??384)-1});
      let plan=inspect();
      if(!plan.ok || plan.needsSupport || excluded(plan.target) || !surfaceEdgeAllowed(plan.target))continue;
      const blocks=plan.clearance.map(p=>bot.blockAt(vec(p))).filter(b=>!isNaturalWalkingBodyBlock(b));
      if(!blocks.length || blocks.length>2 || blocks.some(b=>!allowed(b)||excluded(b.position)
        || b.position.distanceTo(bot.entity.position)>4.5 || deps.canDigPassageBlock?.(b)!==true)) continue;
      for(const original of blocks) {
        assertVitals();if(!owner() || key(bot.entity.position)!==id)throw fail('dry_graph_movement_preempted','Passage origin changed');
        plan=inspect();const block=bot.blockAt(original.position);
        if(!plan.ok || plan.needsSupport || block?.stateId!==original.stateId || !allowed(block)
          || excluded(block.position) || deps.canDigPassageBlock(block)!==true) throw fail('dry_graph_passage_changed','Passage changed before digging');
        const passageDeadline=Math.min(started+timeoutMs,sharedDeadlineMs,Date.now()+35000);
        try{await deps.digPassageBlock(block,movements);}
        catch(error){
          if(error.code!=='movement_preempted'||(state.passageDefenseResumes||0)>=8
            ||!await deps.resumeInterruptedPassage?.(error,{deadline:passageDeadline}))throw error;
          await readyExplorationBoundary();assertVitals();
          state.passageDefenseResumes=(state.passageDefenseResumes||0)+1;save();
          if(key(bot.entity.position)!==id||state.current!==id)return true;
          // The interrupted block grants no clearing credit. Reinspect from
          // the same actual owned stand under this unchanged deadline.
          node.passageRecoveryTried=false;
          return recoverLocalPassage({fromActual,toward,sharedDeadlineMs:passageDeadline});
        }
        assertVitals();
        if(!owner() || key(bot.entity.position)!==id)throw fail('dry_graph_movement_preempted','Passage dig finished after origin/owner changed');
        if(!isNaturalWalkingBodyBlock(bot.blockAt(original.position)))throw fail('dry_graph_passage_unconfirmed','Dig did not clear the actual passage');
        state.passageDigs=(state.passageDigs||0)+1;save();
      }
      if(naturalWalkingFoot(bot,plan.target)) {
        if(fromActual){
          await nativeMove(plan.target,{sharedDeadlineMs,captureTrail:false});assertVitals();
          state.returnPassageRecoveries.push(recoveryKey);save();
          try{deps.onProbe?.({observedReturnPassageConfirmed:true,from:node.position,actual:plain(bot.entity.position),
            target:toward,dug:blocks.length,newNodeOrVisitCredit:false});}catch{ /* Diagnostics grant no movement. */ }
          return true;
        }
        if(preferActualLocalFrontier){
          const path=probe(plan.target);if(!path)return false;
          if(!state.nodes[key(plan.target)]&&!state.frontier.some(edge=>key(edge.target)===key(plan.target)))
            state.frontier.push({parent:id,target:plain(plan.target),plannedSteps:path.path.length,actualClearedPassageEndpoint:true});
          save();return true;
        }
        node.localFrontierExpanded=false;await expandLocalFrontier(id);return true;
      }
    }
    if(fromActual){state.returnPassageRecoveries.push(recoveryKey);save();}
    return false;
  }
  async function readyExplorationBoundary(){
    await ready();
    if (Number.isFinite(continuationDeadline)) return;
    const receipt=deps.takeBoundaryDefenseRelocation?.();
    if(!receipt||!deferInconclusiveExplorationReplay||!state.current||key(bot.entity.position)===state.current)return;
    const actual=plain(bot.entity.position),from=state.current;
    if(receipt.kind!=='actual_owned_graph_boundary_defense'||!state.nodes[from]||!receipt.from
      ||vec(receipt.from).distanceTo(vec(state.nodes[from].position))>32
      ||!receipt.actual||vec(receipt.actual).distanceTo(bot.entity.position)>3||receipt.oldTargetReached!==false
      ||!Number.isFinite(receipt.observedAt)||Date.now()-receipt.observedAt<0||Date.now()-receipt.observedAt>2000
      ||Date.now()>=receipt.originalDeadline||state.pendingWater||state.pendingDryTrail
      ||Math.hypot(actual.x-receipt.from.x,actual.z-receipt.from.z)>(receipt.maximumDisplacement===32?32:12.05)
      ||(receipt.maximumVerticalDisplacement===32?Math.abs(actual.y-receipt.from.y)>32
        :receipt.maximumVerticalDisplacement===8.05?Math.abs(actual.y-receipt.from.y)>8.05
        :actual.y-receipt.from.y>1.25||receipt.from.y-actual.y>2.05)){
      deps.onSiteDefenseRelocation?.({confirmed:false,reason:'boundary_receipt_not_accepted',fromNode:from,actual,
        receiptFrom:receipt.from,receiptActual:receipt.actual,originalDeadline:receipt.originalDeadline,oldTargetReached:false});return;
    }
    const result=await observeResourceWorkOrigin({observedCurrent:from,sharedDeadlineMs:receipt.originalDeadline});
    if(result.confirmed){
      const node=state.nodes[state.current];
      if(node.resourceWorkLanding){delete node.resourceWorkLanding;
        node.survivalRelocation={kind:receipt.kind,fromNode:from,oldEdgeTraversalCredit:false};save();}
      deps.onSiteDefenseRelocation?.({...result,fromNode:from,boundaryDefense:true,oldTargetReached:false});
    }else deps.onSiteDefenseRelocation?.({...result,fromNode:from,boundaryDefense:true,actual:plain(bot.entity.position),oldTargetReached:false});
  }
  async function next({ excludeBounds = exclusions, survivalProvisioning: requestedSurvivalProvisioning = false } = {}) {
    const previousProvisioning=survivalProvisioning;
    const previousContinuationDeadline=continuationDeadline, previousContinuationObservation=continuationObservation;
    survivalProvisioning=requestedSurvivalProvisioning===true;
    try {
    await readyExplorationBoundary();active();exclusions = excludeBounds;await reconcilePendingDryTrail();await readyExplorationBoundary();refusePendingDryTrail(); const previous = bot.pathfinder.movements;
    if (!owner()) throw fail('dry_graph_movement_preempted', 'Graph no longer owns movement');
    bot.pathfinder.setMovements(movements);
    exploring=true;
    survivalProvisioning=requestedSurvivalProvisioning===true;
    const previousDropLimit=movements.maxDropDown;
    if(Number.isFinite(bot.health)&&bot.health>0)
      movements.maxDropDown=Math.min(previousDropLimit,3+Math.floor(Math.max(0,bot.health-1)));
    try {
      await recoverPendingWater();await readyExplorationBoundary(); initialize(); let tries = 0;
      while (tries < 8) {
        await new Promise(resolve=>setTimeout(resolve,0));
        await readyExplorationBoundary();assertVitals(); if (state.visits >= maxNodes) throw fail('dry_graph_node_limit', 'Finite actual node visits reached');
        // Expand the actual new observation before selecting another branch.
        // A resource batch returning camp may leave its last actual child
        // unexpanded; replay only the known parent route to inspect it first.
        if (state.resumeNode && state.current !== state.resumeNode) {
          if(!await tryExplorationReplay(state.resumeNode)){state.resumeNode=state.current;save();tries++;}
        }
        const expansionOrigin=state.current,currentNode=state.nodes[state.current];
        if(nativeReachableHints&&currentNode.expanded&&!currentNode.partialHintRefresh
          &&state.blockedEdges.some(edge=>(edge.from||edge.parent)===state.current&&edge.reason==='native_probe_inconclusive')){
          // A retained graph may have expanded before independently probed
          // partial endpoints were supported. Refresh this actual node once,
          // preserving its old UNKNOWN observations and every visited node.
          currentNode.expanded=false;currentNode.partialHintRefresh=true;
        }
        if (!currentNode.expanded) await expand(state.current);
        await readyExplorationBoundary();
        if(state.current!==expansionOrigin)continue;
        state.frontier = state.frontier.filter(edge => !state.nodes[key(edge.target)]);
        const hint=deps.getObservedResourceTarget?.();
        if(adaptiveLocalFrontier&&hint?.position&&['native_loaded_block_observation','native_loaded_entity_observation'].includes(hint.kind)
          &&Number.isFinite(hint.lastValidatedAt)&&Date.now()-hint.lastValidatedAt>=0&&Date.now()-hint.lastValidatedAt<=5000
          &&!state.nodes[state.current].resourceLocalFrontierExpanded){
          const current=state.nodes[state.current].position,distance=p=>(p.x-hint.position.x)**2+(p.z-hint.position.z)**2;
          if(!state.frontier.some(edge=>edge.parent===state.current&&distance(edge.target)<distance(current)-1))await expandLocalFrontier(state.current,hint);
        }
        // Older branches cannot starve the actual current stand's untried
        // close rings. Failed reverse probes remain UNKNOWN, not a camp return.
        const hasCurrentFrontier=()=>state.frontier.some(edge=>edge.parent===state.current
          &&!(edge.transport&&deps.isWaterRouteThreatened?.(edge.transport.route)===true));
        if(preferActualLocalFrontier&&adaptiveLocalFrontier&&!hasCurrentFrontier()){
          const node=state.nodes[state.current];
          if(!node.localFrontierExpanded||needsActualLocalRefinement(node))await expandLocalFrontier(state.current);
          if(!hasCurrentFrontier()&&!Number.isFinite(continuationDeadline))await recoverLocalPassage();
        }
        if(state.current!==expansionOrigin)continue;
        let at = selectFrontier();
        if (at < 0 && adaptiveLocalFrontier && (!state.nodes[state.current].localFrontierExpanded||needsSiteLocalRefinement(state.nodes[state.current]))) {
          await expandLocalFrontier(state.current);if(state.current!==expansionOrigin)continue; at = selectFrontier();
        }
        if (at < 0 && !Number.isFinite(continuationDeadline) && await recoverLocalPassage()) at=selectFrontier();
        if (at < 0) {
          // A refused post-defense edge grants no permission to replay an old
          // camp/branch. Only a fresh frontier from the actual landing may run.
          if (Number.isFinite(continuationDeadline)) break;
          const unexpanded = state.order.find(id => !state.nodes[id].terrainUnavailable
            &&(!state.nodes[id].expanded||deferInconclusiveExplorationReplay&&adaptiveLocalFrontier
              &&(!state.nodes[id].localFrontierExpanded||needsSiteLocalRefinement(state.nodes[id])))
            &&!deferredSiteReplays.has(`${state.current}>${id}`));
          if (!unexpanded) break;
          if(!await tryExplorationReplay(unexpanded)){tries++;continue;}
          await expand(unexpanded);if(state.current!==unexpanded)continue;
          if(deferInconclusiveExplorationReplay&&adaptiveLocalFrontier
            &&(!state.nodes[unexpanded].localFrontierExpanded||needsSiteLocalRefinement(state.nodes[unexpanded]))){
            // visitParent physically confirmed this old observation. It now
            // owns the unfinished site search, rather than bouncing back to
            // the previous outward tip before inspecting its smaller rings.
            state.resumeNode=state.current;save();await expandLocalFrontier(unexpanded);if(state.current!==unexpanded)continue;
          }
          at = selectFrontier();
          if (at < 0) continue;
        }
        const edge = state.frontier[at], resourceTarget = observedResourceTarget ? copy(observedResourceTarget) : null;
        // Parent replay can pause while retracing a water edge. Retain the
        // unstarted target until its observed origin is actually reached.
        if(!await tryExplorationReplay(edge.parent)){tries++;continue;}
        active();
        if (!owner()) throw fail('dry_graph_movement_preempted', 'Frontier replay finished after ownership changed');
        const edgeIndex = state.frontier.indexOf(edge);
        if (edgeIndex < 0) throw fail('dry_graph_checkpoint_changed', 'Selected frontier changed during its observed parent replay');
        state.frontier.splice(edgeIndex, 1); if (state.nodes[key(edge.target)]) continue; tries++;
        const before = bot.entity.position.clone();
        try {
          const actual = edge.transport ? await moveEdge(edge) : await nativeMove(edge.target, { frontierWitness: edge });
          if (!owner()) throw fail('dry_graph_movement_preempted', 'Only the captured graph owner can confirm a new node');
          if (bot.entity.position.distanceTo(before) < 0.1) throw fail('dry_graph_no_actual_movement', 'A promise is not an observed edge');
          const id = key(actual); if (state.nodes[id]) throw fail('dry_graph_move_unconfirmed', 'Native movement did not reach a new graph node');
          state.nodes[id] = { position: actual, parent: edge.parent, expanded: false,
            supportPositions: copy(lastNativeSupports),
            ...(edge.transport ? { transport: copy(edge.transport) } : {}) }; state.order.push(id);commitNativeTrail(edge.parent,id); state.current = id; state.resumeNode = id; state.visits++; state.pendingWater = null; save();
          if (resourceTarget) deps.onObservedResourceApproach?.({ target: resourceTarget, actual: copy(actual), nodeKey: id });

          if (continuationObservation) deps.onPostDefenseContinuation?.({
            ...copy(continuationObservation),target:copy(edge.target),actual:copy(actual),
            originalDeadline:continuationDeadline,arrivalConfirmed:true,observedAt:Date.now() });
          deps.report?.(`沿已加载干燥地表探索：${state.visits}/${maxNodes} 个真实站位`);
          return { moved: true, actual, via: routeToAnchor().reverse(), scope: 'loaded reachable dry graph only', visits: state.visits };
        } catch (error) {
          // The failure callback already closed this exact pending move. Do
          // not replace its hazard/deadline reason with the resulting lease
          // change, or treat that failed capability as another frontier edge.
          if (guardFailures.has(error) || error.code==='dry_graph_ranged_return_invalid') throw error;
          if (rangedTargetRefusals.has(error) || error.code === 'dry_graph_post_defense_target_changed') {
            const proof=rangedTargetRefusals.get(error);
            rangedTargetRefusals.delete(error); // Consume once, even if validation refuses.
            if (!proof || edge.transport || !exploring || !owner() || bot.pathfinder.movements!==proof.movements
              || proof.movements!==movements || proof.fromNode!==state.current || proof.fromId!==state.current
              || edge.parent!==proof.fromNode || key(edge.target)!==key(proof.target)
              || proof.goal.x!==proof.target.x || proof.goal.y!==proof.target.y || proof.goal.z!==proof.target.z
              || !Number.isFinite(proof.deadline) || Date.now()>=proof.deadline
              || Date.now()<proof.observedAt || Date.now()-proof.observedAt>2000
              || state.pendingWater || state.pendingDryTrail || key(bot.entity.position)===state.current
              || vec(proof.actual).distanceTo(bot.entity.position)>1e-7
              || bot.pathfinder.goal!==null || !['forward','back','left','right','jump','sprint','sneak'].every(k=>bot.controlState?.[k]===false)
              || bot.entity.velocity.x!==0 || bot.entity.velocity.z!==0 || bot.entity.onGround!==true
              || !hasGroundedBodySupport(bot) || !naturalWalkingFoot(bot,plain(bot.entity.position)) || !inspectSurfaceBody(bot).dry
              || excluded(plain(bot.entity.position)) || deps.isStepAllowed?.(proof.target)===true)
              throw fail('dry_graph_ranged_return_invalid','Post-defense refusal cannot adopt this actor or leg');
            // All subsequent readiness, expansion, probes and physical legs in
            // this invocation share the interrupted leg's absolute deadline.
            continuationDeadline=Math.min(continuationDeadline,proof.deadline);
            const landing=await observeResourceWorkOrigin({observedCurrent:proof.fromNode,sharedDeadlineMs:proof.deadline});
            active();assertVitals();
            if (!landing.confirmed || !owner() || bot.pathfinder.movements!==movements
              || key(bot.entity.position)!==landing.current || vec(proof.actual).distanceTo(bot.entity.position)>1e-7)
              throw fail('dry_graph_ranged_return_invalid','Owned ranged retreat did not yield an unchanged dry observation');
            state.blockedEdges.push({...copy(edge),reason:'post_defense_target_policy_changed',actual:copy(landing.actual),
              originalDeadline:proof.deadline,oldTargetReached:false,oldEdgeTraversalCredit:false,materialCredit:false});
            const landed=state.nodes[landing.current];
            if (landed.resourceWorkLanding?.fromNode===proof.fromNode) {
              delete landed.resourceWorkLanding;
              landed.survivalRelocation={kind:'actual_owned_ranged_retreat',fromNode:proof.fromNode,
                abandonedTarget:copy(proof.target),oldEdgeTraversalCredit:false};
            }
            lastNativeTrail=null;
            continuationObservation={fromNode:proof.fromNode,retreatActual:copy(landing.actual),abandonedTarget:copy(proof.target),
              oldTargetReached:false,oldEdgeTraversalCredit:false,materialCredit:false};
            save();
            deps.onPostDefenseTargetChanged?.({fromNode:proof.fromNode,actual:copy(landing.actual),abandonedTarget:copy(proof.target),
              originalDeadline:proof.deadline,oldTargetReached:false,oldEdgeTraversalCredit:false,materialCredit:false,visits:state.visits});
            continue;
          }
          // This leg already owns the exact native relocation receipt. Drain
          // remaining defense first, but do not let the boundary observer
          // commit the same body as a new graph origin before validating the
          // original leg's fromNode below.
          if(error.code==='house_site_defense_relocated'){await ready();}
          else {await readyExplorationBoundary();active();}
          // A completed defense may restore the work lease before the next
          // physics tick. Recheck the current capability before any graph
          // landing/visit is adopted, including ordinary and provisioning work.
          assertVitals();
          const recovered=recoveredOutboundWater.get(error);
          if(recovered&&recovered.pending===state.pendingWater&&owner()&&bot.pathfinder.movements===movements){
            // The adapter proved a return to its original bank, not a crossing.
            // Reconnect the recorded parent through fresh native movement;
            // preserve the failed edge and select another existing frontier.
            await recoverPendingWater();active();
            state.frontier=state.frontier.filter(e=>!(e.parent===edge.parent&&key(e.target)===key(edge.target)));
            state.blockedEdges.push({...copy(edge),reason:'surface_crossing_recovered_to_original_bank',
              originalCode:error.code,oldTargetReached:false,waterTraversalCredit:false,actual:plain(bot.entity.position)});
            save();deps.onWaterRecovery?.({kind:'surface_crossing_recovered_to_original_bank',actual:plain(bot.entity.position),
              originalCode:error.code,oldTargetReached:false,waterTraversalCredit:false});continue;
          }
          if(adoptPartialSiteLanding(error))return {moved:true,actual:copy(state.nodes[state.current].position),via:routeToAnchor().reverse(),
            scope:'actual partial native site landing; requested target not reached',visits:state.visits};
          if(deferInconclusiveExplorationReplay&&error.code==='house_site_defense_relocated'&&(!edge.transport||outboundBankDefense.has(error))){
            const receipt=error.siteDefenseRelocation,actual=plain(bot.entity.position),id=key(actual),leg=error.observedDryLeg;
            const bankDefense=outboundBankDefense.get(error),expectedTarget=bankDefense?bankDefense.target:edge.target;
            if(receipt?.kind!=='actual_owned_site_defense_relocation'||receipt.arrivalConfirmed!==true||receipt.oldTargetReached!==false
              ||key(receipt.actual)!==id||!receipt.from||!['x','y','z'].every(axis=>Number.isFinite(receipt.from[axis]))
              ||Math.hypot(bot.entity.position.x-receipt.from.x,bot.entity.position.z-receipt.from.z)>(receipt.nativeShoreRecovery===true?16.1:12.05)
              ||(receipt.nativeShoreRecovery===true?Math.abs(bot.entity.position.y-receipt.from.y)>8.05
                :bot.entity.position.y-receipt.from.y>1.25||receipt.from.y-bot.entity.position.y>2.05)
              ||key(receipt.originalGoal)!==key(expectedTarget)||!leg||leg.fromNode!==state.current
              ||receipt.originalDeadline!==leg.deadline||Date.now()>=leg.deadline||!Number.isFinite(receipt.observedAt)
              ||Date.now()-receipt.observedAt<0||Date.now()-receipt.observedAt>2000||!owner()||bot.pathfinder.movements!==movements
              ||(state.pendingWater&&(!bankDefense||bankDefense.pending!==state.pendingWater||state.pendingWater.bankArrival))||state.pendingDryTrail||excluded(actual)||Math.hypot(actual.x-anchor.x,actual.z-anchor.z)>radius
              ||!hasGroundedBodySupport(bot)||bot.entity.onGround!==true||!naturalWalkingFoot(bot,actual)||!inspectSurfaceBody(bot).dry)
              throw error;
            const from=state.current;
            if(bankDefense)state.pendingWater=null; // Entry approach only; no water traversal or bank-arrival credit.
            state.blockedEdges.push({...edge,reason:'actual_owned_site_defense_relocation',oldTargetReached:false,
              actual:copy(actual),originalDeadline:leg.deadline});
            if(!state.nodes[id]){
              if(state.visits>=maxNodes)throw fail('dry_graph_node_limit','Finite actual node visits reached');
              state.nodes[id]={position:actual,parent:from,expanded:false,
                supportPositions:bodyShapeSupports(bot,Math.floor(bot.entity.position.y-.075)-1,Math.floor(bot.entity.position.y),-Infinity,.075).map(c=>plain(c.position)),
                survivalRelocation:{kind:receipt.kind,fromNode:from,abandonedTarget:copy(edge.target),oldEdgeTraversalCredit:false}};
              state.order.push(id);state.visits++;
            }
            state.current=id;state.resumeNode=id;lastNativeTrail=null;save();
            deps.onSiteDefenseRelocation?.({actual:copy(actual),fromNode:from,abandonedTarget:copy(edge.target),
              actualArrivalConfirmed:true,oldTargetReached:false,oldEdgeTraversalCredit:false,visits:state.visits,originalDeadline:leg.deadline});
            if(id===from)continue;
            deps.report?.('自卫撤离已落稳，从当前真实站位继续探索');
            return {moved:true,actual,via:routeToAnchor().reverse(),scope:'actual owned site defense relocation; old target not reached',visits:state.visits};
          }
          if(error.code==='dry_graph_route_changed'&&!edge.transport&&error.observedRouteTarget
            &&!state.pendingDryTrail&&!state.pendingWater&&owner()&&key(bot.entity.position)===state.current
            &&naturalWalkingFoot(bot,bot.entity.position.floored())&&hasGroundedBodySupport(bot)){
            state.blockedEdges.push({...edge,reason:error.code,message:error.message,facts:copy(error.observedRouteTarget),actualMovementConfirmed:false});save();continue;
          }
          if (edge.transport || ['dry_graph_hazard', 'dry_graph_airshaft', 'dry_graph_movement_preempted', 'dry_graph_survival_limit', 'dry_graph_route_changed', 'dry_graph_probe_limit', 'dry_graph_invalid_probe','dry_graph_ranged_return_invalid'].includes(error.code)) throw error;
          if (resourceTarget) deps.onObservedResourceTargetBlocked?.(resourceTarget, {
            reason: error.code || error.name, probeStatus: error.observedProbe?.status || null, probeConclusive: error.observedProbe?.conclusive===true,
            edge: { parent: edge.parent, target: copy(edge.target) } });
          state.blockedEdges.push({ ...edge, reason: error.code || error.name, message: error.message }); save();
          if (key(bot.entity.position) !== state.current) {
            // Partial noPath motion is not a parent visit. Re-probe/retrace the
            // short dry leg before selecting any other branch; failure stops.
            if (!naturalWalkingFoot(bot, bot.entity.position.floored()) || bot.entity.onGround !== true) throw fail('dry_graph_route_lost', 'Partial failed movement did not leave a safe grounded return point');
            const returned = await nativeMove(state.nodes[state.current].position);
            if (key(returned) !== state.current) throw fail('dry_graph_route_lost', 'Partial native movement could not retrace its parent');
          }
        }
      }
      save(); return { moved: false, reason: state.frontier.length ? 'finite_attempt_batch_failed' : 'loaded_reachable_frontier_exhausted', via: routeToAnchor().reverse(), scope: 'not proof that a 384m disk was searched', diagnostics: { visits: state.visits, probes: state.probes, blockedEdges: copy(state.blockedEdges).slice(-16) } };
    } finally { exploring=false;survivalProvisioning=false;if (owner() && bot.pathfinder.movements === movements) {movements.maxDropDown=previousDropLimit;bot.pathfinder.setMovements(previous);} }
    } finally { survivalProvisioning=previousProvisioning;continuationDeadline=previousContinuationDeadline;continuationObservation=previousContinuationObservation; }
  }
  async function returnToAnchor({ excludeBounds = exclusions, via = [], rejoinInterruptedSuffix = false, rejoinMinimumY = null, returnToCurrentOnly = false, provisioningReturn: requestedProvisioningReturn = false, survivalProvisioning: requestedSurvivalProvisioning = false } = {}) {
    const previousProvisioning=survivalProvisioning;
    survivalProvisioning=requestedSurvivalProvisioning===true;
    try {
    await deps.ready?.();active();exclusions = excludeBounds;await reconcilePendingDryTrail();await deps.ready?.();refusePendingDryTrail();
    const previous = bot.pathfinder.movements;
    const previousDropLimit=movements.maxDropDown;
    if (!owner()) throw fail('dry_graph_movement_preempted', 'Graph no longer owns its observed return route');
    bot.pathfinder.setMovements(movements);
    // Distance does not decide whether a hurt companion may return. Explicit
    // recovery retraces freshly checked observed terrain under the same owner,
    // route, hazard, threat, segment and time budgets. Exploration stays separate.
    provisioningReturn=requestedProvisioningReturn===true&&!returnToCurrentOnly;
    if(provisioningReturn&&Number.isFinite(bot.health)&&bot.health>0)
      movements.maxDropDown=Math.min(previousDropLimit,3+Math.floor(Math.max(0,bot.health-1)));
    try {
      // Death/respawn or another actually completed recovery can leave an old
      // transport pending while this actor is already beside camp. Prove a
      // NEW dry return first; never force it back to the old river merely to
      // unwind that obsolete operation. No old crossing/visit gets credit.
      if(state.pendingWater&&rejoinInterruptedSuffix&&!returnToCurrentOnly
        &&hasGroundedBodySupport(bot)&&naturalWalkingFoot(bot,bot.entity.position.floored())){
        const reconnect={}; // A fresh camp connector has no historical retry authority.
        // A pending old crossing is not proof of a dry camp route. Probe the
        // new connector first; if water separates us, keep its typed recovery.
        if(probe(anchor,reconnect)){
          await nativeMove(anchor,reconnect);active();
          if(key(bot.entity.position)!==key(anchor)||!hasGroundedBodySupport(bot))
            throw fail('dry_graph_replay_unconfirmed','Fresh camp recovery did not actually arrive');
          state.lastAbandonedTransport={reason:'actual_fresh_dry_camp_return',pending:copy(state.pendingWater)};
          state.pendingWater=null;initialize();save();
        }
      }
      await recoverPendingWater();
      // Prefer a short freshly verified approach or a nearby recorded branch
      // before attempting a longer independent connector after a food detour.
      // Preserve an exact local suffix when it can actually be rejoined.
      // A stale/foreign/distant suffix remains only context for choosing a
      // separately probed fresh connector to a real recorded ancestor.
      const suffixIndex=Array.isArray(via)?via.findLastIndex(p=>p&&key(p)===state.current):-1;
      const localSuffix=suffixIndex>=0&&via.length>0&&via.every(p=>p&&['x','y','z'].every(k=>Number.isSafeInteger(p[k])))
        &&!via.slice(suffixIndex+1).some(p=>state.nodes[key(p)])
        &&via.slice(suffixIndex).some(p=>(!Number.isSafeInteger(rejoinMinimumY)||p.y>=rejoinMinimumY)&&vec(p).distanceTo(bot.entity.position)<=32);
      if (!returnToCurrentOnly && rejoinInterruptedSuffix && !localSuffix && state.current && !state.nodes[key(bot.entity.position)]
        && (!Number.isSafeInteger(rejoinMinimumY)||anchor.y>=rejoinMinimumY)
        && Math.hypot(bot.entity.position.x-anchor.x,bot.entity.position.y-anchor.y,bot.entity.position.z-anchor.z)<=32
        && probe(anchor)
        && hasGroundedBodySupport(bot) && naturalWalkingFoot(bot,bot.entity.position.floored())) {
        await observedReturnMove(anchor); active();
      }
      // A checked escape staircase may leave the actor above its old cave
      // node. Reconnect freshly to a recorded ancestor instead of descending
      // to that node just to begin the return again. This grants no old-edge
      // traversal or visit credit, and keeps typed water replay separate.
      if(rejoinInterruptedSuffix&&Number.isSafeInteger(rejoinMinimumY)
        &&state.nodes[state.current]?.position.y<rejoinMinimumY&&!state.nodes[key(bot.entity.position)]){
        const candidates=[],seen=new Set();
        for(let id=state.nodes[state.current].parent;id&&seen.size<512;id=state.nodes[id]?.parent){
          if(seen.has(id))throw fail('dry_graph_disconnected','Cyclic recorded return route');
          seen.add(id);const point=state.nodes[id]?.position;
          if(point&&point.y>=rejoinMinimumY&&vec(point).distanceTo(bot.entity.position)<=32)candidates.push(point);
        }
        candidates.sort((a,b)=>vec(a).distanceTo(bot.entity.position)-vec(b).distanceTo(bot.entity.position));
        if(!candidates.length)throw fail('dry_graph_rejoin_unconfirmed','No local recorded ancestor above the escape floor');
        await nativeMove(candidates[0]);active();
      }
      // Fresh physical connectors are independent of an old resource suffix.
      // Never reinterpret a saved transport node as a dry waypoint; first
      // reach one actual ancestor through a new fully checked dry path.
      if(rejoinInterruptedSuffix&&!localSuffix&&state.current&&!state.nodes[key(bot.entity.position)]
        &&hasGroundedBodySupport(bot)&&inspectSurfaceBody(bot).dry){
        // A settled combat/reconnect leg can have a different dry suffix. That
        // never authorizes replaying the wrong trace. Probe a new connector to
        // an actually recorded ancestor, then resume its exact typed route.
        const candidates=[],seen=new Set();
        for(let id=state.current;id&&seen.size<512;id=state.nodes[id]?.parent){
          if(seen.has(id))throw fail('dry_graph_disconnected','Reconnect ancestor route is cyclic');seen.add(id);
          const node=state.nodes[id],p=node?.position;
          if(p&&!node.terrainUnavailable&&(!Number.isSafeInteger(rejoinMinimumY)||p.y>=rejoinMinimumY)&&vec(p).distanceTo(bot.entity.position)<=32)candidates.push(p);
        }
        // Provisioning can leave the actor near a previously visited branch
        // after the graph cursor returned to camp. Rejoin an existing node
        // through a NEW physical dry connector, then replay its typed parents.
        const nearby=state.order.filter(id=>!seen.has(id)&&state.nodes[id]?.position&&!state.nodes[id].terrainUnavailable)
          .map(id=>({id,p:state.nodes[id].position})).filter(({p})=>(!Number.isSafeInteger(rejoinMinimumY)||p.y>=rejoinMinimumY)&&vec(p).distanceTo(bot.entity.position)<=32)
          .sort((a,b)=>vec(a.p).distanceTo(bot.entity.position)-vec(b.p).distanceTo(bot.entity.position)).slice(0,32);
        for(const {id,p} of nearby){
          const chain=new Set();let cursor=id;
          while(cursor&&cursor!==key(anchor)&&chain.size<512&&!chain.has(cursor)){
            chain.add(cursor);cursor=state.nodes[cursor]?.parent;
          }
          if(cursor===key(anchor))candidates.push(p);
        }
        candidates.sort((a,b)=>vec(a).distanceTo(bot.entity.position)-vec(b).distanceTo(bot.entity.position));
        const connectorOptions=()=>({});
        const reachable=candidates.slice(0,8).find(p=>naturalWalkingFoot(bot,p)&&probe(p,connectorOptions(p)));
        if(reachable){await nativeMove(reachable,connectorOptions(reachable));active();initialize();}
        else if(nativeReachableHints){
          // A nearby canopy route can remain UNKNOWN too. Rejoin a recorded
          // ancestor within the existing 96m probe envelope through a NEW
          // conclusive dry connector, preserving its old typed parent route.
          const farther=[...seen].map(id=>state.nodes[id]).filter(node=>node&&!node.terrainUnavailable
            &&vec(node.position).distanceTo(bot.entity.position)<=radius
            &&(!Number.isSafeInteger(rejoinMinimumY)||node.position.y>=rejoinMinimumY))
            .sort((a,b)=>vec(a.position).distanceTo(bot.entity.position)-vec(b.position).distanceTo(bot.entity.position));
          const destination=farther.find(node=>naturalWalkingFoot(bot,node.position))?.position;
          const attempted=new Set();
          for(let segment=0;destination&&segment<8;segment++){
            active();
            if(vec(destination).distanceTo(bot.entity.position)>80){
              // A sequence of food targets can finish beyond the single
              // connector envelope. The recorded ancestor is direction only:
              // independently probe and physically execute a loaded <=16m leg.
              // No long probe, teleport, old edge or new visit gets credit.
              const start=bot.entity.position.floored(),dx=destination.x-start.x,dz=destination.z-start.z;
              const horizontal=Math.hypot(dx,dz),distance=vec(destination).distanceTo(bot.entity.position),hints=[];
              if(horizontal>=4){
                const center=start.offset(Math.round(dx/horizontal*12),0,Math.round(dz/horizontal*12));
                for(const dy of [0,1,-1,2,-2,3,-3])for(const [ox,oz] of [[0,0],[2,0],[-2,0],[0,2],[0,-2]]){
                  const p=center.offset(ox,dy,oz);
                  if(!attempted.has(key(p))&&!excluded(p)&&naturalWalkingFoot(bot,p)
                    &&p.distanceTo(bot.entity.position)<=16&&p.distanceTo(vec(destination))<distance-4)hints.push(p);
                }
              }
              hints.sort((a,b)=>a.distanceTo(vec(destination))-b.distanceTo(vec(destination)));
              const hint=hints.slice(0,6).find(p=>probe(p,connectorOptions(p)));
              if(!hint)break;
              attempted.add(key(hint));await observedReturnMove(hint,connectorOptions(hint));active();continue;
            }
            if(probe(destination,connectorOptions(destination))){
              await observedReturnMove(destination,connectorOptions(destination));active();initialize();break;
            }
            // A long UNKNOWN route is never executable proof. Its short
            // endpoint is only a hint, requiring an independent successful
            // probe and a guarded physical leg before observing again.
            const route=lastProbeResult?.path;
            if(!['timeout','partial'].includes(lastProbeFacts?.status)||!Array.isArray(route)||route.length>512
              ||route.some(p=>!p||!['x','y','z'].every(k=>Number.isSafeInteger(p[k]))||p.toBreak?.length||p.toPlace?.length))break;
            const hint=[...route].reverse().find(p=>!attempted.has(key(p))&&!excluded(p)&&naturalWalkingFoot(bot,p)
              &&vec(p).distanceTo(bot.entity.position)>=4&&vec(p).distanceTo(bot.entity.position)<=16);
            if(!hint||!probe(hint,connectorOptions(hint)))break;
            attempted.add(key(hint));await observedReturnMove(hint,connectorOptions(hint));active();
          }
        }
        if(!state.nodes[key(bot.entity.position)]&&!returnToCurrentOnly&&vec(anchor).distanceTo(bot.entity.position)<=96&&naturalWalkingFoot(bot,anchor)
          &&probe(anchor,connectorOptions(anchor))){
          // The 32m waypoint spacing must not strand a grounded survivor after
          // food/combat. With no nearby recorded connector, try the existing
          // bounded 96m resource-probe range. No old edge/visit gets credit.
          await observedReturnMove(anchor,connectorOptions(anchor));active();initialize();
        }
      }
      if (state.current && !state.nodes[key(bot.entity.position)]) {
        if (!Array.isArray(via) || !via.length || !via.every(p => p && ['x','y','z'].every(axis => Number.isSafeInteger(p[axis]))))
          throw fail('dry_graph_rejoin_unconfirmed', 'Off-graph return needs its actual observed dry suffix');
        const at = via.findLastIndex(p => key(p) === state.current);
        if (at < 0) throw fail('dry_graph_rejoin_unconfirmed', 'The resource suffix lost its exact original graph node', {
          reconnect: { allowed: rejoinInterruptedSuffix, grounded: hasGroundedBodySupport(bot),
            naturalFoot: naturalWalkingFoot(bot,bot.entity.position.floored()),
            distance: vec(anchor).distanceTo(bot.entity.position), actual: plain(bot.entity.position),
            target: plain(anchor), reason: 'foreign_suffix_after_unconfirmed_connectors' }
        });
        if (via.slice(at + 1).some(point => state.nodes[key(point)])) {
          throw fail('dry_graph_rejoin_unconfirmed', 'A dry off-graph suffix cannot replay another saved transport node',{reconnect:{actual:plain(bot.entity.position),fromNode:state.current,grounded:hasGroundedBodySupport(bot),naturalFoot:naturalWalkingFoot(bot,bot.entity.position.floored()),body:inspectSurfaceBody(bot),recordedSuffixNodes:via.slice(at+1).filter(p=>state.nodes[key(p)]).map(key)}});
        }
        if (key(via.at(-1)) !== key(bot.entity.position)) {
          // Pause/reconnect may end a native leg between recorded waypoints.
          // This is a NEW bounded route, not evidence that the old suffix was
          // traversed. Keep ordinary fresh probing and every physical guard.
          const actual = bot.entity.position;
          if (rejoinInterruptedSuffix) {
            // An interrupted RETURN may already have passed the tail of the
            // saved outbound trace. Reconnect to the nearest recorded point;
            // physically reaching it proves only that new connector, never
            // traversal of the discarded outbound tail.
            let nearest=-1,best=Infinity;
            for(let i=at;i<via.length;i++){
              if(Number.isSafeInteger(rejoinMinimumY)&&via[i].y<rejoinMinimumY)continue;
              const d=Math.hypot(via[i].x-actual.x,via[i].y-actual.y,via[i].z-actual.z);
              if(d<best){best=d;nearest=i;}
            }
            if(nearest<0)throw fail('dry_graph_rejoin_unconfirmed','No recorded return waypoint above the recovered escape floor');
            via=via.slice(0,nearest+1);
          }
          const last = via.at(-1);
          if (!rejoinInterruptedSuffix || !hasGroundedBodySupport(bot) || !naturalWalkingFoot(bot,actual.floored())
            || Math.hypot(last.x-actual.x,last.y-actual.y,last.z-actual.z)>32)
            throw fail('dry_graph_rejoin_unconfirmed', 'Interrupted resource leg needs a local grounded reconnect', { reconnect: { allowed:rejoinInterruptedSuffix, grounded:hasGroundedBodySupport(bot), naturalFoot:naturalWalkingFoot(bot,actual.floored()), distance:Math.hypot(last.x-actual.x,last.y-actual.y,last.z-actual.z), actual:plain(actual), target:copy(last) } });
          const arrived = await nativeMove(last);
          if (key(arrived)!==key(last)) throw fail('dry_graph_rejoin_unconfirmed', 'Fresh suffix reconnect did not physically arrive');
          active();
        }
        for (const point of via.slice(at).reverse()) {
          if (key(bot.entity.position) === key(point) && hasGroundedBodySupport(bot)) continue;
          const actual = await nativeMove(point, { observedReturnRetry:true,
            observedSuffix:{nodeId:state.current,from:plain(bot.entity.position),to:plain(point)} });
          if (key(actual) !== key(point)) throw fail('dry_graph_rejoin_unconfirmed', 'The resource suffix did not really reach its exact dry waypoint');
        }
      }
      initialize();
      if(returnToCurrentOnly)return {confirmed:true,actual:plain(bot.entity.position),current:state.current};
      const observedReturn = routeToAnchor();
      await visitParent(key(anchor)); assertVitals();
      if (!owner() || key(bot.entity.position) !== key(anchor) || !hasGroundedBodySupport(bot)) {
        throw fail('dry_graph_replay_unconfirmed', 'The fixed camp return was not actually observed');
      }
      return { confirmed: true, actual: plain(bot.entity.position), observedReturn };
    } finally { provisioningReturn=false;if (owner() && bot.pathfinder.movements === movements) {movements.maxDropDown=previousDropLimit;bot.pathfinder.setMovements(previous);} }
    } finally { survivalProvisioning=previousProvisioning; }
  }
  async function travelToObservedNode({ nodeId, exactPosition, excludeBounds = exclusions } = {}) {
    await deps.ready?.();active();exclusions = excludeBounds;await reconcilePendingDryTrail();await deps.ready?.();refusePendingDryTrail();
    if (nodeId !== undefined && typeof nodeId !== 'string'
      || exactPosition !== undefined && (!exactPosition || !['x','y','z'].every(k => Number.isSafeInteger(exactPosition[k])))
      || nodeId === undefined && exactPosition === undefined
      || nodeId !== undefined && exactPosition !== undefined && nodeId !== key(exactPosition)) {
      throw fail('dry_graph_observed_node_invalid', 'Travel requires one exact observed node identity');
    }
    const targetId = nodeId ?? key(exactPosition), target = state.nodes[targetId];
    if (!target || !state.order.includes(targetId) || key(target.position) !== targetId
      || !['x','y','z'].every(k => Number.isSafeInteger(target.position[k]))) {
      throw fail('dry_graph_observed_node_unconfirmed', 'Travel cannot register or infer an unvisited node');
    }
    const assertCurrent = () => {
      assertVitals();
      if (!owner()) throw fail('dry_graph_movement_preempted', 'Observed-node travel lost its captured owner');
      const actual = plain(bot.entity.position);
      if (!state.current || !state.order.includes(state.current) || !state.nodes[state.current]
        || key(actual) !== state.current) throw fail('dry_graph_rejoin_unconfirmed', 'Observed-node travel requires its actual current node; an unrecorded suffix cannot be borrowed');
      if (excluded(actual) || !naturalWalkingFoot(bot, actual) || !hasGroundedBodySupport(bot)) {
        throw fail('dry_graph_not_on_surface', 'Observed-node travel requires actual loaded dry grounded support');
      }
      assertVitals();
      if (!owner()) throw fail('dry_graph_movement_preempted', 'Current-node observation lost its captured owner');
    };
    assertCurrent();
    if (excluded(target.position) || !naturalWalkingFoot(bot, target.position)) {
      throw fail('dry_graph_route_changed', 'The recorded node no longer has loaded safe dry support');
    }
    assertCurrent();
    const previous = bot.pathfinder.movements;
    bot.pathfinder.setMovements(movements);
    try {
      await recoverPendingWater(); initialize(); assertCurrent();
      const ancestors = routeToAnchor(), ancestorIds = ancestors.map(key), down = [];
      let common = targetId;
      while (!ancestorIds.includes(common)) {
        if (!state.nodes[common] || down.includes(common) || down.length >= 512) {
          throw fail('dry_graph_disconnected', 'Observed-node travel has no finite recorded parent connection');
        }
        down.push(common); common = state.nodes[common].parent;
        if (!common) throw fail('dry_graph_disconnected', 'Observed-node travel has no recorded common parent');
      }
      // Historical observed tree coordinates describe the authorized route;
      // visitParent may independently revalidate a shorter native dry route.
      const observedReturn = [...ancestors.slice(0, ancestorIds.indexOf(common) + 1),
        ...down.reverse().map(id => copy(state.nodes[id].position))];
      await visitParent(targetId); assertCurrent();
      if (state.current !== targetId || key(bot.entity.position) !== targetId) {
        throw fail('dry_graph_replay_unconfirmed', 'The exact observed target node was not physically reached');
      }
      return { confirmed: true, nodeId: targetId, actual: plain(bot.entity.position), observedReturn };
    } finally { if (owner() && bot.pathfinder.movements === movements) bot.pathfinder.setMovements(previous); }
  }
  return { next, returnToAnchor, travelToObservedNode, observeResourceWorkOrigin, getState: () => copy(state), state: () => copy(state), getReturnRoute: () => routeToAnchor(),
    isObservedPosition: (position = bot.entity.position) => !excluded(position) && !!state.nodes[key(position)], movements };
}
function createHouseSurfaceGraph(deps, options = {}) {
  let graph, fixedAnchor;
  const forAnchor = anchor => {
    if (!graph) { fixedAnchor = { ...anchor }; graph = createLoadedDryGraph(deps, { ...options, anchor }); }
    else if (key(anchor) !== key(fixedAnchor)) throw fail('dry_graph_checkpoint_changed', 'Original fixed camp cannot be rewritten');
    return graph;
  };
  return {
    async next({ anchor, excludeBounds = [], survivalProvisioning = false } = {}) {
      return forAnchor(anchor).next({ excludeBounds, survivalProvisioning });
    },
    async returnToAnchor({ anchor, excludeBounds = [], via = [], rejoinInterruptedSuffix = false, rejoinMinimumY = null, returnToCurrentOnly = false, provisioningReturn = false, survivalProvisioning = false } = {}) {
      return forAnchor(anchor).returnToAnchor({ excludeBounds, via, rejoinInterruptedSuffix, rejoinMinimumY, returnToCurrentOnly, provisioningReturn, survivalProvisioning });
    },
    async travelToObservedNode({ anchor, nodeId, exactPosition, excludeBounds = [] } = {}) {
      return forAnchor(anchor).travelToObservedNode({ nodeId, exactPosition, excludeBounds });
    },
    async observeResourceWorkOrigin({anchor,observedCurrent}={}) {
      return forAnchor(anchor).observeResourceWorkOrigin({observedCurrent});
    },
    getState: () => graph ? graph.getState() : copy((deps.getCP || deps.getCheckpoint)?.() || null),
    getReturnRoute: () => graph ? graph.getReturnRoute() : [],
    isObservedPosition(position = deps.getBot().entity.position) {
      if (graph) return graph.isObservedPosition(position);
      const state = (deps.getCP || deps.getCheckpoint)?.();
      return !!position && ['x', 'y', 'z'].every(k => Number.isFinite(position[k])) && !!state?.nodes?.[key(position)];
    },
  };
}
module.exports = { loadedSurfaceFeet, dryFoot, naturalWalkingFoot, avoidsKnownPowderSnowEdge, avoidsKnownSurfaceHazardEdge, createSurfaceHazardEdgePolicy, hasGroundedBodySupport, inspectSurfaceBody, inspectShoreSupport, inspectDryDescentSupport, inspectDryJumpSupport, inspectControlledDropSupport, getSurfaceGraphProtectedPositions, runSurfaceGraphNativeProbe, runGroundedDryConnectorProbe, runRecordedConstructionConnectorProbe, selectSurfaceExplorationFrontier, createLoadedDryGraph, createHouseSurfaceGraph };
