/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHouseResourceGatherer, houseResourceFrontier, houseMaterialAnimalAllowed } = require('../vendor/server/minecraft/houseResourceGatherer');

function fixture(name = 'oak_log') {
  let quantity = 0, cancelled = false, returned = 0, digCalls = 0, cp;
  const blocks = new Map();
  const block = (blockName, x, y = 64, z = 0) => ({ name: blockName, position: new Vec3(x, y, z) });
  const candidate = block(name, 3); blocks.set(candidate.position.toString(), candidate);
  const bot = { health: 20, entity: { position: new Vec3(0, 64, 0) }, entities: {}, registry: { entitiesByName: {} },
    inventory: { items: () => quantity ? [{ name, count: quantity }] : [] }, blockAt: p => blocks.get(p.toString()) || block('air', p.x, p.y, p.z), canDigBlock: () => true };
  const deps = { getBot: () => bot, assertActive: () => { if (cancelled) throw Object.assign(new Error('paused'), { code: 'paused' }); },
    getCheckpoint: () => cp, setCheckpoint: state => { cp = state; }, capacityFor: () => 64,
    withSurface: async fn => fn(), ensureFood: async () => {}, ensureWeapon: async () => {}, ensureTool: async () => {},
    findBlocks: () => [...blocks.values()].filter(b => b.name === name), reachDig: async () => {}, waitGround: async () => {},
    canDigSafely: () => true, dig: async b => { digCalls += 1; blocks.delete(b.position.toString()); },
    collectDrops: async () => { quantity += 1; }, returnCamp: async () => { returned += 1; }, explore: async () => false, safeFoot: () => true };
  return { bot, deps, block, blocks, candidate, cancel: () => { cancelled = true; }, counts: () => ({ quantity, returned, digCalls }), checkpoint: () => cp };
}

test('unproductive synchronous search batches yield to cancellation and network timers',async()=>{
 const f=fixture('sand');f.blocks.clear();let batches=0;
 f.deps.isExplorationPosition=()=>true;
 f.deps.nextExploration=async()=>{
  if(++batches>=100)throw Object.assign(new Error('microtask starvation'),{code:'starved'});
  return {moved:false,reason:'finite_attempt_batch_failed'};
 };
 const timer=setTimeout(()=>f.cancel(),0);
 try{await assert.rejects(createHouseResourceGatherer(f.deps).gather('sand',15,{anchor:{x:0,y:64,z:0}}),{code:'paused'});}
 finally{clearTimeout(timer);}
 assert.ok(batches<100);assert.equal(f.counts().digCalls,0);assert.equal(f.counts().returned,0);
});
test('emergency tool bootstrap yields at its material count and retains the crown for normal harvest',async()=>{
 const f=fixture();for(let y=65;y<=69;y++){const b=f.block('oak_log',3,y);f.blocks.set(b.position.toString(),b);}
 const gatherer=createHouseResourceGatherer(f.deps),anchor={x:0,y:64,z:0};
 const bootstrap=await gatherer.gather('oak_log',2,{anchor,finishTree:false,deferCampReturn:true});
 assert.equal(bootstrap.acquired,2);assert.equal(f.counts().returned,0);
 assert.equal(f.checkpoint().searches.oak_log.tree.pending.length,4);
 const ordinary=await gatherer.gather('oak_log',1,{anchor});
 assert.equal(ordinary.acquired,4);assert.equal(f.counts().quantity,6);
 assert.equal(f.checkpoint().searches.oak_log.tree.pending.length,0);assert.equal(f.counts().returned,1);
});

test('a two-log request finishes the observed trunk before leaving for another tree',async()=>{
 const f=fixture(),digs=[];
 for(let y=65;y<=69;y++){const b=f.block('oak_log',3,y);f.blocks.set(b.position.toString(),b);}
 const other=f.block('oak_log',1,64,4);f.blocks.set(other.position.toString(),other);
 const dig=f.deps.dig;f.deps.dig=async b=>{digs.push(b.position.toString());await dig(b);};
 const result=await createHouseResourceGatherer(f.deps).gather('oak_log',2,{anchor:{x:0,y:64,z:0}});
 assert.equal(result.acquired,6);assert.equal(f.counts().returned,1);
 assert.ok(digs.every(p=>p.startsWith('(3,')));assert.ok(f.blocks.has(other.position.toString()));
 assert.equal(f.checkpoint().searches.oak_log.tree.pending.length,0);
});

test('an unreachable crown is attempted once and does not block an already fulfilled wood batch',async()=>{
 const f=fixture(),attempts=[];
 for(let y=65;y<=69;y++){const b=f.block('oak_log',3,y);f.blocks.set(b.position.toString(),b);}
 f.deps.reachDig=async b=>{attempts.push(b.position.y);if(b.position.y>66)throw Object.assign(Error('crown unreachable'),{name:'NoPath'});};
 const result=await createHouseResourceGatherer(f.deps).gather('oak_log',2,{anchor:{x:0,y:64,z:0}});
 assert.equal(result.acquired,3);assert.deepEqual(attempts,[64,65,66,67,68,69]);
 assert.equal(f.checkpoint().searches.oak_log.tree,null);
});

test('cancellation while finishing a tree stops further digs and camp movement',async()=>{
 const f=fixture();for(let y=65;y<=68;y++){const b=f.block('oak_log',3,y);f.blocks.set(b.position.toString(),b);}
 const collect=f.deps.collectDrops;f.deps.collectDrops=async()=>{await collect();if(f.counts().quantity===2)f.cancel();};
 await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log',1,{anchor:{x:0,y:64,z:0}}),{code:'paused'});
 assert.equal(f.counts().digCalls,2);assert.equal(f.counts().returned,0);
});

test('unproductive off-node search rejoins exploration locally and returns camp only after actual pickup',async()=>{
 const f=fixture(),anchor={x:0,y:64,z:0};let rejoins=0,explorations=0;
 f.blocks.clear();f.bot.entity.position=new Vec3(20,64,0);
 f.deps.isExplorationPosition=()=>f.bot.entity.position.x===16||f.bot.entity.position.x===32;
 f.deps.returnExploration=async(a,options)=>{assert.deepEqual(a,anchor);assert.equal(options.resource,'oak_log');assert.equal(options.via.at(-1).x,20);rejoins++;f.bot.entity.position=new Vec3(16,64,0);};
 f.deps.nextExploration=async()=>{assert.equal(f.counts().returned,0);explorations++;f.bot.entity.position=new Vec3(32,64,0);const b=f.block('oak_log',33);f.blocks.set(b.position.toString(),b);return {moved:true,via:[anchor,{x:16,y:64,z:0},{x:32,y:64,z:0}]};};
 const result=await createHouseResourceGatherer(f.deps).gather('oak_log',1,{anchor});
 assert.equal(result.acquired,1);assert.equal(rejoins,1);assert.equal(explorations,1);assert.equal(f.counts().returned,1);
});
test('a failed local-only field bootstrap does not start a distant camp return or exploration',async()=>{
 const f=fixture();f.deps.reachDig=async()=>{throw Object.assign(Error('unreachable nearby wood'),{name:'NoPath'});};
 let explores=0;f.deps.explore=async()=>{explores++;return false;};
 await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log',4,{anchor:{x:0,y:64,z:0},localOnly:true,deferCampReturn:true}),{code:'house_resource_local_wood_unavailable'});
 assert.equal(f.counts().returned,0);assert.equal(explores,0);assert.equal(f.counts().quantity,0);
});

test('field bootstrap explicitly defers camp travel while confirming only actual backpack stock',async()=>{
 const f=fixture(),result=await createHouseResourceGatherer(f.deps).gather('oak_log',1,{anchor:{x:0,y:64,z:0},deferCampReturn:true});
 assert.equal(result.confirmed,true);assert.equal(result.available,1);assert.equal(result.returnedCamp,false);assert.equal(f.counts().returned,0);
});

test('qualified survival recovery rechecks the fresh target and does not blindly replay a completed dig', async () => {
  const f = fixture(); let resumed = 0, digs = 0;
  f.deps.dig = async b => { digs++; f.blocks.delete(b.position.toString()); throw Object.assign(Error('interrupted'), { code: 'movement_preempted' }); };
  f.deps.resumeAfterSurvival = async (_error, scope) => {
    assert.equal(scope.bot, f.bot); assert.ok(scope.deadline > Date.now());
    resumed++; await f.deps.collectDrops(); return true;
  };
  const result = await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.equal(result.acquired, 1); assert.equal(digs, 1); assert.equal(resumed, 1);
});

test('foreign movement preemption cannot be swallowed as an ordinary rejected resource target', async () => {
  const f = fixture(); let digs = 0, diagnostics = 0;
  f.deps.onCandidateFailure = () => { diagnostics++; };
  f.deps.ensureTool = async () => { throw Object.assign(Error('foreign owner'), { code: 'movement_preempted' }); };
  f.deps.resumeAfterSurvival = async () => false;
  f.deps.dig = async () => { digs++; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'movement_preempted' });
  assert.equal(digs, 0);
  assert.equal(diagnostics, 0);
});

test('bounded target diagnostics preserve failure facts without granting dig, inventory or callback authority', async () => {
  const f=fixture(),records=[];
  for(let x=4;x<=42;x++){const b=f.block('oak_log',x);f.blocks.set(b.position.toString(),b);}
  f.deps.reachDig=async()=>{throw Object.assign(Error('actual target not visible'),{code:'house_resource_unsafe_target',resourceTargetFacts:{loaded:true,canDig:true,visible:false,avoidsActualSupport:true}});};
  f.deps.onCandidateFailure=facts=>{records.push(facts);throw Error('diagnostic sink unavailable');};
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log',1,{anchor:{x:0,y:64,z:0}}),{code:'house_resource_search_exhausted'});
  assert.equal(records.length,32);assert.ok(records.every(r=>r.code==='house_resource_unsafe_target'&&r.facts.visible===false));
  assert.equal(f.counts().digCalls,0);assert.equal(f.counts().quantity,0);assert.deepEqual({...f.bot.entity.position},{x:0,y:64,z:0});
});

test('repeated survival interruptions remain within the original batch retry budget', async () => {
  const f = fixture(); let resumes = 0;
  f.deps.ensureTool = async () => { throw Object.assign(Error('interrupted'), { code: 'movement_preempted' }); };
  f.deps.resumeAfterSurvival = async () => { resumes++; return true; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'movement_preempted' });
  assert.equal(resumes, 4); assert.equal(f.counts().quantity, 0);
});

test('a native dig without authoritative picked-up inventory cannot satisfy a material goal', async () => {
  const f = fixture(); f.deps.collectDrops = async () => {};
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'house_resource_search_exhausted' });
  assert.equal(f.counts().quantity, 0); assert.equal(f.counts().digCalls, 1);
});

test('actual pickup and camp return satisfy only the requested bounded additional batch', async () => {
  const f = fixture();
  const result = await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.equal(result.confirmed, true); assert.equal(result.acquired, 1); assert.equal(f.counts().returned, 1);
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 65, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'house_resource_invalid_batch' });
});

test('a tree rejected from one bank is retried from a confirmed new graph stance and actual pickup is returned to camp', async () => {
  const f = fixture(), anchor = { x: 0, y: 64, z: 0 };
  let approaches = 0, explorations = 0, safetyChecks = 0;
  f.deps.reachDig = async block => {
    approaches += 1; assert.equal(block.position.toString(), f.candidate.position.toString());
    if (approaches === 1) throw Object.assign(new Error('tree cannot be reached from this bank'), { code: 'NoPath' });
    assert.ok(f.bot.entity.position.equals(new Vec3(4, 64, 0)));
  };
  f.deps.canDigSafely = () => { safetyChecks += 1; return true; };
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async () => {
    explorations += 1;
    if (explorations > 1) return { moved: false, reason: 'loaded_reachable_frontier_exhausted', via: [anchor, { x: 4, y: 64, z: 0 }] };
    // This dependency fixture records a completed native graph leg; it does
    // not simulate water physics or infer movement from the returned flag.
    f.bot.entity.position = new Vec3(4, 64, 0);
    return { moved: true, via: [anchor, { x: 4, y: 64, z: 0 }] };
  };
  const returnCamp = f.deps.returnCamp;
  f.deps.returnCamp = async (...args) => {
    assert.equal(f.counts().quantity, 1, 'return observes picked-up inventory rather than logical progress');
    await returnCamp(...args); f.bot.entity.position = new Vec3(0, 64, 0);
  };
  const result = await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor });
  assert.equal(result.acquired, 1); assert.equal(approaches, 2); assert.equal(explorations, 1); assert.equal(safetyChecks, 1);
  assert.deepEqual(f.counts(), { quantity: 1, returned: 1, digCalls: 1 });
  assert.ok(f.bot.entity.position.equals(new Vec3(0, 64, 0)));
});

test('a graph moved flag without actual displacement cannot reset a failed tree approach', async () => {
  const f = fixture(), anchor = { x: 0, y: 64, z: 0 }; let approaches = 0;
  f.deps.reachDig = async () => { approaches += 1; throw Object.assign(new Error('same bank'), { code: 'NoPath' }); };
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async () => ({ moved: true, via: [anchor] });
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor }), { code: 'house_resource_search_exhausted' });
  assert.equal(approaches, 1); assert.equal(f.counts().digCalls, 0); assert.equal(f.counts().quantity, 0);
});

test('retrying a tree after a confirmed graph move still rechecks its current digging safety', async () => {
  const f = fixture(), anchor = { x: 0, y: 64, z: 0 }; let approaches = 0, explorations = 0;
  f.deps.reachDig = async () => { approaches += 1; if (approaches === 1) throw Object.assign(new Error('old bank blocked'), { code: 'NoPath' }); };
  f.deps.canDigSafely = () => false;
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async () => {
    explorations += 1; f.bot.entity.position = new Vec3(4, 64, 0);
    return { moved: explorations === 1, reason: 'loaded_reachable_frontier_exhausted', via: [anchor, { x: 4, y: 64, z: 0 }] };
  };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor }), { code: 'house_resource_search_exhausted' });
  assert.equal(approaches, 2); assert.equal(f.counts().digCalls, 0); assert.equal(f.counts().quantity, 0);
});

test('nested material gathering keeps both resource checkpoints and exact parent return context', async () => {
  const f = fixture();
  const context = new AsyncLocalStorage(), quantities = {}, returned = [], preparations = [];
  const sand = f.block('sand', 4); f.blocks.set(sand.position.toString(), sand);
  f.bot.inventory.items = () => Object.entries(quantities).filter(([, amount]) => amount > 0).map(([name, count]) => ({ name, count }));
  f.deps.findBlocks = names => [...f.blocks.values()].filter(block => names.includes(block.name));
  f.deps.withResource = (owner, action) => context.run(owner, action);
  f.deps.ensureFood = async request => { assert.equal(request.resource, context.getStore().resource); preparations.push(request.resource); };
  f.deps.returnCamp = async (_anchor, options) => { assert.equal(options.resource, context.getStore().resource); returned.push(options.resource); };
  const anchor = { x: 0, y: 64, z: 0 };
  let gatheredSand = false, dug;
  const gatherer = createHouseResourceGatherer(f.deps);
  f.deps.ensureTool = async name => {
    assert.equal(context.getStore().resource, name);
    if (name === 'oak_log' && !gatheredSand) {
      gatheredSand = true;
      const nested = await gatherer.gather('sand', 1, { anchor });
      assert.equal(nested.acquired, 1); assert.equal(context.getStore().resource, 'oak_log');
    }
  };
  f.deps.dig = async block => { assert.equal(context.getStore().resource, block.name); dug = block.name; f.blocks.delete(block.position.toString()); };
  f.deps.collectDrops = async () => { quantities[dug] = (quantities[dug] || 0) + 1; };
  const result = await gatherer.gather('oak_log', 1, { anchor });
  assert.equal(result.acquired, 1); assert.deepEqual(quantities, { sand: 1, oak_log: 1 });
  assert.deepEqual(preparations, ['oak_log', 'sand']); assert.deepEqual(returned, ['sand', 'oak_log']);
  assert.deepEqual(Object.keys(f.checkpoint().searches).sort(), ['oak_log', 'sand']);
  assert.equal(context.getStore(), undefined);
});

test('graph exploration preserves its actual winding parent route for camp return and bypasses straight-ray cursors', async () => {
  const f = fixture(); f.blocks.clear(); let returnedVia, rayCalls = 0;
  f.deps.explore = async () => { rayCalls += 1; return false; };
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async request => {
    assert.equal(request.resource, 'oak_log');
    f.bot.entity.position = new Vec3(8, 64, 16);
    f.blocks.set(f.candidate.position.toString(), f.candidate);
    return { moved: true, via: [{ x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, { x: 8, y: 64, z: 16 }] };
  };
  f.deps.returnCamp = async (_anchor, options) => { returnedVia = options.via; f.bot.entity.position = new Vec3(0, 64, 0); };
  const result = await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.equal(result.acquired, 1); assert.equal(rayCalls, 0);
  assert.deepEqual(returnedVia, [{ x: 0, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, { x: 8, y: 64, z: 16 }]);
  assert.equal(f.checkpoint().searches.oak_log.explorationKind, 'loaded_dry_waypoint_graph');
});

test('a partially failed graph batch continues its remaining frontier without counting a visit or searching rays', async () => {
  const f = fixture(); f.blocks.clear(); let calls = 0;
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async () => {
    calls += 1;
    return { moved: false, reason: calls === 1 ? 'finite_attempt_batch_failed' : 'loaded_reachable_frontier_exhausted',
      via: [{ x: 0, y: 64, z: 0 }], diagnostics: { visits: 1 } };
  };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }),
    error => error.code === 'house_resource_search_exhausted' && error.lastReason === 'loaded_reachable_frontier_exhausted');
  assert.equal(calls, 2); assert.equal(f.counts().digCalls, 0);
  assert.equal(f.checkpoint().searches.oak_log.cursor, 0);
});

test('off-graph resource stance must return through actual observations before resuming a graph', async () => {
  const f = fixture(); f.blocks.clear(); f.bot.entity.position = new Vec3(3, 64, 0); const actions = [];
  f.deps.isExplorationPosition = () => false;
  f.deps.returnCamp = async () => { actions.push('return'); f.bot.entity.position = new Vec3(0, 64, 0); };
  f.deps.nextExploration = async () => {
    actions.push('graph'); assert.ok(f.bot.entity.position.equals(new Vec3(0, 64, 0)));
    return { moved: false, reason: 'loaded_reachable_frontier_exhausted', via: [{ x: 0, y: 64, z: 0 }] };
  };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'house_resource_search_exhausted' });
  assert.deepEqual(actions.slice(0, 2), ['return', 'graph']);
});

test('cancellation while graph movement resolves prevents route promotion, picking and a late return', async () => {
  const f = fixture(); f.blocks.clear();
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async () => { f.cancel(); return { moved: true, via: [{ x: 0, y: 64, z: 0 }] }; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'paused' });
  assert.equal(f.checkpoint(), undefined); assert.equal(f.counts().returned, 0); assert.equal(f.counts().digCalls, 0);
});

test('house, scaffold, station and warehouse exclusions block resource acquisition before movement or digging', async () => {
  const f = fixture(); let reach = 0; f.deps.reachDig = async () => { reach += 1; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 },
    exclusionBounds: [{ minX: 2, maxX: 4, minY: 0, maxY: 100, minZ: -1, maxZ: 1 }] }), { code: 'house_resource_search_exhausted' });
  assert.equal(reach, 0); assert.equal(f.counts().digCalls, 0);
});

test('cancellation during approach prevents late dig, pickup, return and checkpoint writes', async () => {
  const f = fixture(); f.deps.reachDig = async () => f.cancel();
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'paused' });
  assert.deepEqual(f.counts(), { quantity: 0, returned: 0, digCalls: 0 }); assert.equal(f.checkpoint(), undefined);
});

test('cane harvesting preserves bottom stalks and cannot count promise success as harvested sugar cane', async () => {
  const f = fixture('sugar_cane');
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('sugar_cane', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'house_resource_search_exhausted' });
  assert.equal(f.counts().digCalls, 0);
  const bottom = f.block('sugar_cane', 3, 63); f.blocks.set(bottom.position.toString(), bottom);
  const result = await createHouseResourceGatherer(f.deps).gather('sugar_cane', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.equal(result.acquired, 1); assert.equal(f.bot.blockAt(bottom.position).name, 'sugar_cane');
});

test('animal material selection requires authoritative adult, unnamed, live metadata and white unsheared wool', () => {
  const bot = { registry: { entitiesByName: { sheep: { metadataKeys: ['baby', 'custom_name', 'health', 'wool'] }, cow: { metadataKeys: ['baby', 'custom_name', 'health'] } } } };
  const sheep = { name: 'sheep', position: new Vec3(0, 64, 0), metadata: [false, null, 8, 0] };
  assert.equal(houseMaterialAnimalAllowed(bot, sheep, 'white_wool', () => true), true);
  for (const metadata of [[true, null, 8, 0], [false, 'pet', 8, 0], [false, null, 0, 0], [false, null, 8, 15], [false, null, 8, 16], []]) {
    assert.equal(houseMaterialAnimalAllowed(bot, { ...sheep, metadata }, 'white_wool', () => true), false);
  }
  assert.equal(houseMaterialAnimalAllowed(bot, { ...sheep, name: 'cow', metadata: [false, null, 10] }, 'leather', () => true), true);
  assert.equal(houseMaterialAnimalAllowed(bot, { ...sheep, name: 'pig' }, 'leather', () => true), false);
});
test('pinned vanilla sparse sheep defaults select a live adult white sheep while explicit or unknown facts refuse',()=>{
 const registry=require('prismarine-registry')('1.21.8'),bot={version:'1.21.8',registry},metadata=[];
 metadata[9]=8;
 const sheep={name:'sheep',entityType:registry.entitiesByName.sheep.id,position:new Vec3(0,64,0),metadata};
 assert.equal(houseMaterialAnimalAllowed(bot,sheep,'white_wool',()=>true),true);
 for(const [index,value] of [[16,true],[16,null],[17,15],[17,16],[17,null],[9,0],[9,undefined],[2,'pet']]){
  const changed=metadata.slice();changed[index]=value;
  assert.equal(houseMaterialAnimalAllowed(bot,{...sheep,metadata:changed},'white_wool',()=>true),false,`${index}:${value}`);
 }
 assert.equal(houseMaterialAnimalAllowed({...bot,version:'1.21.7'},sheep,'white_wool',()=>true),false);
 assert.equal(houseMaterialAnimalAllowed(bot,{...sheep,entityType:9999},'white_wool',()=>true),false);
 assert.equal(houseMaterialAnimalAllowed(bot,sheep,'white_wool',()=>false),false);
});

test('bounded exploration persists its frontier but a full backpack issues no world action', async () => {
  const points = houseResourceFrontier({ x: 0, y: 64, z: 0 }, 96);
  assert.ok(new Set(points.map(p => `${p.x},${p.z}`)).size < points.length, 'return legs deliberately revisit known waypoints');
  assert.equal(points.filter(p => p.returning && p.x === 0 && p.z === 0).length, 8);
  assert.ok(points.every(p => Math.abs(p.x) <= 96 && Math.abs(p.z) <= 96));
  const f = fixture(); f.deps.capacityFor = () => 0;
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'house_resource_inventory_full' });
  assert.equal(f.counts().digCalls, 0);
});

test('all Overworld log species are genuine raw providers and generic wood reports actual picked-up species', async () => {
  for (const wood of ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']) {
    const name = `${wood}_log`; const f = fixture(name); let radius;
    const original = f.deps.findBlocks;
    f.deps.findBlocks = (names, scanRadius) => { assert.ok(names.includes(name)); radius = scanRadius; return original(); };
    const result = await createHouseResourceGatherer(f.deps).gather(name, 1, { anchor: { x: 0, y: 64, z: 0 } });
    assert.equal(result.acquired, 1); assert.equal(radius, 96);
    const generic = fixture(name);
    const actual = await createHouseResourceGatherer(generic.deps).gather('any_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
    assert.deepEqual(actual.actualItems, { [name]: 1 });
    assert.equal(actual.available, 1);
    assert.equal(generic.bot.inventory.items()[0].name, name, 'provider never relabels real inventory as oak');
  }
});

test('sparse rays reach 384 metres in six outbound steps and return before changing heading', () => {
  const anchor = { x: -10, y: 64, z: 7 }; const points = houseResourceFrontier(anchor);
  assert.deepEqual(points.slice(0, 6).map(p => p.x - anchor.x), [64, 128, 192, 256, 320, 384]);
  let previous = anchor;
  for (const p of points) {
    assert.ok(Math.hypot(p.x - previous.x, p.z - previous.z) <= 64, 'each accepted geometric leg is at most 64m');
    if (p.ray !== previous.ray && previous.ray !== undefined) assert.deepEqual(
      { x: previous.x, y: previous.y, z: previous.z }, anchor);
    previous = p;
  }
  assert.ok(points.length < 200);
  assert.ok(houseResourceFrontier(anchor, 768).filter(p => !p.returning).length <= 104);
  assert.throws(() => houseResourceFrontier(anchor, 769), { code: 'house_resource_invalid_frontier' });
});

test('a partially failed ray retraces actual dry positions before trying the next direction', async () => {
  const f = fixture('acacia_log'); f.blocks.clear(); const movements = []; let path;
  f.deps.explore = async p => {
    movements.push(['explore', p.x, p.z]);
    if (p.x === 128) { f.bot.entity.position = new Vec3(90, 64, 0); return false; }
    f.bot.entity.position = new Vec3(p.x, p.y, p.z);
    if (p.z === 32) { const log = f.block('acacia_log', 3); f.blocks.set(log.position.toString(), log); }
    return true;
  };
  f.deps.returnCamp = async (_anchor, options) => {
    movements.push(['return', f.bot.entity.position.x, f.bot.entity.position.z]);
    if (f.bot.entity.position.x === 90) path = options.via;
    f.bot.entity.position = new Vec3(0, 64, 0);
  };
  const result = await createHouseResourceGatherer(f.deps).gather('any_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.equal(result.acquired, 1);
  assert.deepEqual(movements.slice(0, 6), [['explore', 32, 0], ['explore', 64, 0], ['explore', 96, 0], ['explore', 128, 0], ['return', 90, 0], ['explore', 0, 32]]);
  assert.deepEqual(path, [{ x: 0, y: 64, z: 0 }, { x: 32, y: 64, z: 0 }, { x: 64, y: 64, z: 0 }, { x: 96, y: 64, z: 0 }, { x: 90, y: 64, z: 0 }]);
  assert.equal(f.checkpoint().frontierVersion, 2);
  assert.equal(f.checkpoint().searches.any_log.frontierVersion, 2);
});

test('failed known-route return cannot silently jump into another ray', async () => {
  const f = fixture(); f.blocks.clear(); const attempted = [];
  f.deps.explore = async p => { attempted.push(p); f.bot.entity.position = new Vec3(20, 64, 0); return false; };
  f.deps.returnCamp = async () => { throw Object.assign(new Error('known return blocked'), { code: 'no_path' }); };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'no_path' });
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].ray, 0);
});

test('legacy dense-ring cursors restart the v2 frontier rather than interpreting an old index', async () => {
  const f = fixture(); f.blocks.clear(); const destinations = [];
  f.deps.getCheckpoint = () => ({ schema: 1, anchor: { x: 0, y: 64, z: 0 }, searches: { oak_log: { cursor: 9999, attempts: 2 } } });
  f.deps.explore = async p => { destinations.push(p); f.bot.entity.position = new Vec3(p.x, p.y, p.z); f.blocks.set(f.candidate.position.toString(), f.candidate); return true; };
  f.deps.returnCamp = async () => { f.bot.entity.position = new Vec3(0, 64, 0); };
  await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.equal(destinations[0].x, 32);
  assert.equal(f.checkpoint().searches.oak_log.cursor, 1);
  assert.equal(f.checkpoint().searches.oak_log.attempts, 2);
});

test('resuming v2 preserves the next leg and cancellation never advances it or issues a late return', async () => {
  const f = fixture(); f.blocks.clear(); let writes = 0, destination;
  const initial = { schema: 1, frontierVersion: 2, anchor: { x: 0, y: 64, z: 0 }, searches: {
    oak_log: { frontierVersion: 2, frontierSpacing: 32, cursor: 1, attempts: 0, observedPath: [{ x: 0, y: 64, z: 0 }, { x: 32, y: 64, z: 0 }] } } };
  f.bot.entity.position = new Vec3(32, 64, 0);
  f.deps.getCheckpoint = () => initial;
  f.deps.setCheckpoint = () => { writes += 1; };
  f.deps.explore = async p => { destination = p; f.cancel(); return true; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: initial.anchor }), { code: 'paused' });
  assert.equal(destination.x, 64);
  assert.equal(initial.searches.oak_log.cursor, 1);
  assert.equal(writes, 0);
  assert.equal(f.counts().returned, 0);
});

test('protected outbound waypoint stops that ray and a finite search never targets the protected cell', async () => {
  const f = fixture(); f.blocks.clear(); const visited = [];
  f.deps.explore = async p => { visited.push(p); return false; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 },
    exclusionBounds: [{ minX: 31, maxX: 33, minY: 0, maxY: 100, minZ: -1, maxZ: 1 }] }), { code: 'house_resource_search_exhausted' });
  assert.ok(visited.length <= 7);
  assert.equal(visited.some(p => p.ray === 0), false);
  assert.equal(f.checkpoint().searches.oak_log.cursor, houseResourceFrontier({ x: 0, y: 64, z: 0 }, 384, 32).length);
});

test('a new batch already back at camp replays small legs instead of jumping to its distant saved cursor', async () => {
  const f = fixture(); f.blocks.clear(); const visited = [];
  f.deps.getCheckpoint = () => ({ schema: 1, frontierVersion: 2, anchor: { x: 0, y: 64, z: 0 }, searches: {
    oak_log: { frontierVersion: 2, frontierSpacing: 32, cursor: 4, attempts: 0, observedPath: [{ x: 0, y: 64, z: 0 }] } } });
  f.deps.explore = async p => {
    assert.ok(Math.hypot(p.x - f.bot.entity.position.x, p.z - f.bot.entity.position.z) <= 64);
    visited.push(p.x); f.bot.entity.position = new Vec3(p.x, p.y, p.z);
    if (p.x === 160) f.blocks.set(f.candidate.position.toString(), f.candidate);
    return true;
  };
  f.deps.returnCamp = async () => { f.bot.entity.position = new Vec3(0, 64, 0); };
  await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.deepEqual(visited, [32, 64, 96, 128, 160]);
  assert.equal(f.checkpoint().searches.oak_log.furthestCursor, 4);
});

test('cancellation while retracing a blocked ray prevents another heading and later checkpoint writes', async () => {
  const f = fixture(); f.blocks.clear(); let explored = 0, writes = 0;
  f.deps.setCheckpoint = () => { writes += 1; };
  f.deps.explore = async () => { explored += 1; f.bot.entity.position = new Vec3(20, 64, 0); return false; };
  f.deps.returnCamp = async () => { assert.equal(writes, 1, 'actual dry path is persisted before retracing starts'); f.cancel(); };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'paused' });
  assert.equal(explored, 1);
  assert.equal(writes, 1, 'no further checkpoint writes after cancellation');
});

test('structured native failures preserve every ray reason and loaded-world diagnostics before returning', async () => {
  const f = fixture(); f.blocks.clear(); let explored = 0;
  f.deps.explore = async p => {
    explored += 1;
    return { moved: false, reason: p.ray === 0 ? 'no_loaded_dry_target' : 'native_no_path',
      diagnostics: { loadedColumns: 16, waterColumns: 12, ray: p.ray } };
  };
  f.deps.returnCamp = async () => {
    const failures = f.checkpoint().searches.oak_log.rayFailures;
    assert.ok(Object.keys(failures).length > 0, 'failure evidence exists before native return starts');
  };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }),
    error => error.code === 'house_resource_search_exhausted' && /native_no_path/.test(error.lastReason));
  const search = f.checkpoint().searches.oak_log;
  assert.equal(explored, 8, 'a truthy failure object must not advance deeper into a ray');
  assert.equal(Object.keys(search.rayFailures).length, 8);
  assert.equal(search.rayFailures[0].reason, 'no_loaded_dry_target');
  assert.deepEqual(search.rayFailures[0].requested, { x: 32, y: 64, z: 0 });
  assert.deepEqual(search.rayFailures[0].diagnostics, { loadedColumns: 16, waterColumns: 12, ray: 0 });
  assert.equal(search.frontierSpacing, 32);
  assert.equal(f.counts().quantity, 0);
});

test('a fulfilled native movement promise without actual displacement never counts as a successful frontier step', async () => {
  const f = fixture(); f.blocks.clear(); let calls = 0;
  f.deps.explore = async () => { calls += 1; return { moved: true, reason: 'native_goal_resolved' }; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'house_resource_search_exhausted' });
  assert.equal(calls, 8);
  assert.ok(Object.values(f.checkpoint().searches.oak_log.rayFailures).every(value => value.reason === 'no_actual_movement'));
  assert.deepEqual(f.checkpoint().searches.oak_log.observedPath, [{ x: 0, y: 64, z: 0 }]);
});

test('32m native legs accept safe lateral target offsets without resetting the ray into a loop', async () => {
  const f = fixture(); f.blocks.clear(); const requested = []; let returns = 0, observed;
  f.deps.explore = async p => {
    assert.equal(p.ray, 0);
    requested.push(p.x);
    const offset = requested.length % 2 ? -12 : 12;
    f.bot.entity.position = new Vec3(p.x + offset, p.y, -offset);
    if (p.x === 128) f.blocks.set(f.candidate.position.toString(), f.candidate);
    return { moved: true, diagnostics: { selectedOffset: { x: offset, z: -offset } } };
  };
  f.deps.returnCamp = async (_anchor, options) => { returns += 1; observed = options.via; f.bot.entity.position = new Vec3(0, 64, 0); };
  await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.deepEqual(requested, [32, 64, 96, 128]);
  assert.equal(returns, 1, 'lateral dry detours do not cause repeated camp resets');
  assert.deepEqual(observed.slice(1), [{ x: 20, y: 64, z: 12 }, { x: 76, y: 64, z: -12 },
    { x: 84, y: 64, z: 12 }, { x: 140, y: 64, z: -12 }]);
});

test('old v2 64m cursors are not reinterpreted as new 32m progress', async () => {
  const f = fixture(); f.blocks.clear(); let first;
  f.deps.getCheckpoint = () => ({ schema: 1, frontierVersion: 2, anchor: { x: 0, y: 64, z: 0 }, searches: {
    oak_log: { frontierVersion: 2, frontierSpacing: 64, cursor: 5, attempts: 3, observedPath: [{ x: 0, y: 64, z: 0 }] } } });
  f.deps.explore = async p => { first = p; f.bot.entity.position = new Vec3(p.x, p.y, p.z); f.blocks.set(f.candidate.position.toString(), f.candidate); return true; };
  f.deps.returnCamp = async () => { f.bot.entity.position = new Vec3(0, 64, 0); };
  await createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } });
  assert.equal(first.x, 32);
  assert.equal(f.checkpoint().searches.oak_log.cursor, 1);
  assert.equal(f.checkpoint().searches.oak_log.attempts, 3);
});

test('native failure diagnostics cannot create checkpoint writes or return actions after cancellation', async () => {
  const f = fixture(); f.blocks.clear(); let writes = 0, returns = 0;
  f.deps.setCheckpoint = () => { writes += 1; };
  f.deps.explore = async () => { f.cancel(); return { moved: false, reason: 'native_no_path', diagnostics: { loadedColumns: 8 } }; };
  f.deps.returnCamp = async () => { returns += 1; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), { code: 'paused' });
  assert.equal(writes, 0);
  assert.equal(returns, 0);
});

test('a concrete surface guardian error survives revoked cleanup ownership with its original cause and no late return', async () => {
  for (const code of ['house_surface_dry_graph_hazard', 'dry_graph_survival_limit', 'mining_low_health']) {
    const f = fixture(); f.blocks.clear(); let revoked = false, writes = 0, returns = 0, graphCalls = 0;
    const nativeCause = Object.assign(new Error('Observed native safety failure'), { code: 'actual_safety_failure' });
    const facts = { health: 0.33922767639160156, onGround: false, trigger: 'physics_tick' };
    const original = Object.assign(new Error('Concrete surface guardian stopped the actual move'), { code, cause: nativeCause, observedMovement: facts });
    const ownerError = Object.assign(new Error('Captured movement lease was revoked'), { code: 'movement_preempted' });
    f.deps.assertActive = () => { if (revoked) throw ownerError; };
    f.deps.setCheckpoint = () => { writes += 1; };
    f.deps.returnCamp = async () => { returns += 1; };
    f.deps.isExplorationPosition = () => true;
    f.deps.nextExploration = async () => { graphCalls += 1; await Promise.resolve(); revoked = true; throw original; };
    await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), error => {
      assert.equal(error, original); assert.equal(error.code, code); assert.equal(error.cause, nativeCause);
      assert.equal(error.observedMovement, facts);
      assert.deepEqual(error.cleanupOwnerFailure, { code: ownerError.code, message: ownerError.message });
      return true;
    });
    await Promise.resolve(); assert.equal(graphCalls, 1); assert.equal(returns, 0); assert.equal(writes, 0);
    assert.deepEqual(f.counts(), { quantity: 0, returned: 0, digCalls: 0 }); assert.equal(f.checkpoint(), undefined);
  }
});

test('ordinary cancellation after a native non-guardian failure keeps the pause reason and starts no cleanup action', async () => {
  const f = fixture(); f.blocks.clear(); let writes = 0, returns = 0;
  const original = Object.assign(new Error('Ordinary native path stopped'), { code: 'NoPath' });
  f.deps.setCheckpoint = () => { writes += 1; };
  f.deps.returnCamp = async () => { returns += 1; };
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async () => { await Promise.resolve(); f.cancel(); throw original; };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), error => {
    assert.equal(error.code, 'paused'); assert.notEqual(error, original); return true;
  });
  assert.equal(original.cleanupOwnerFailure, undefined); assert.equal(returns, 0); assert.equal(writes, 0);
  assert.equal(f.counts().digCalls, 0); assert.equal(f.checkpoint(), undefined);
});

test('guardian cause is also retained if ownership is revoked while an initially permitted return settles', async () => {
  const f = fixture(); f.blocks.clear(); let revoked = false, returnStarts = 0, writes = 0;
  const original = Object.assign(new Error('Original checked surface lost its floor'), { code: 'house_surface_dry_graph_airshaft', cause: new Error('Actual unsupported body') });
  const ownerError = Object.assign(new Error('Owner replaced during native return'), { code: 'movement_preempted' });
  f.deps.assertActive = () => { if (revoked) throw ownerError; };
  f.deps.setCheckpoint = () => { assert.equal(revoked, false, 'No stale checkpoint write'); writes += 1; };
  f.deps.isExplorationPosition = () => true;
  f.deps.nextExploration = async () => { throw original; };
  f.deps.returnCamp = async () => {
    assert.equal(revoked, false, 'The first native return was still authorized'); returnStarts += 1;
    await Promise.resolve(); revoked = true; throw ownerError;
  };
  await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), error => {
    assert.equal(error, original); assert.deepEqual(error.cleanupOwnerFailure, { code: ownerError.code, message: ownerError.message }); return true;
  });
  await Promise.resolve(); assert.equal(returnStarts, 1); assert.equal(writes, 1); assert.equal(f.counts().digCalls, 0);
});

test('inner tool preparation preserves a concrete guardian error before rechecking the revoked owner', async () => {
  for (const code of ['house_surface_dry_graph_hazard', 'dry_graph_survival_limit', 'mining_low_health']) {
    const f = fixture(); let revoked = false, writes = 0, returns = 0, toolCalls = 0, reaches = 0;
    const cause = Object.assign(new Error('Nested native tool route failed'), { code: 'actual_native_guard' });
    const original = Object.assign(new Error('Original tool guardian'), { code, cause, observedMovement: { health: 8 } });
    const ownerError = Object.assign(new Error('Tool callback owner revoked'), { code: 'movement_preempted' });
    f.deps.assertActive = () => { if (revoked) throw ownerError; };
    f.deps.ensureTool = async () => { toolCalls += 1; await Promise.resolve(); revoked = true; throw original; };
    f.deps.reachDig = async () => { reaches += 1; };
    f.deps.setCheckpoint = () => { writes += 1; }; f.deps.returnCamp = async () => { returns += 1; };
    await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log', 1, { anchor: { x: 0, y: 64, z: 0 } }), error => {
      assert.equal(error, original); assert.equal(error.cause, cause); assert.equal(error.code, code);
      assert.deepEqual(error.cleanupOwnerFailure, { code: ownerError.code, message: ownerError.message }); return true;
    });
    assert.equal(toolCalls, 1); assert.equal(reaches, 0); assert.equal(writes, 0); assert.equal(returns, 0);
    assert.deepEqual(f.counts(), { quantity: 0, returned: 0, digCalls: 0 });
  }
});

test('inner passive animal hunting preserves its native guardian cause when ownership is revoked', async () => {
  for (const code of ['house_surface_dry_graph_hazard', 'dry_graph_survival_limit', 'mining_low_health']) {
    const f = fixture('leather'); let revoked = false, writes = 0, returns = 0, hunts = 0;
    const cow = { id: 42, name: 'cow', type: 'animal', position: new Vec3(3, 64, 0), metadata: [false, null, 10], isValid: true };
    f.bot.registry.entitiesByName.cow = { metadataKeys: ['baby', 'custom_name', 'health'] }; f.bot.entities[cow.id] = cow;
    const cause = new Error('Actual hunting safety guard');
    const original = Object.assign(new Error('Original hunting guardian'), { code, cause });
    const ownerError = Object.assign(new Error('Hunt owner revoked'), { code: 'movement_preempted' });
    f.deps.assertActive = () => { if (revoked) throw ownerError; };
    f.deps.hunt = async target => { assert.equal(target, cow); hunts += 1; await Promise.resolve(); revoked = true; throw original; };
    f.deps.setCheckpoint = () => { writes += 1; }; f.deps.returnCamp = async () => { returns += 1; };
    await assert.rejects(createHouseResourceGatherer(f.deps).gather('leather', 1, { anchor: { x: 0, y: 64, z: 0 } }), error => {
      assert.equal(error, original); assert.equal(error.cause, cause); assert.equal(error.code, code);
      assert.deepEqual(error.cleanupOwnerFailure, { code: ownerError.code, message: ownerError.message }); return true;
    });
    assert.equal(hunts, 1); assert.equal(writes, 0); assert.equal(returns, 0); assert.equal(f.counts().quantity, 0);
  }
});

test('ordinary inner tool and hunt cancellation still reports pause rather than a non-guardian path error', async () => {
  for (const material of ['oak_log', 'leather']) {
    const f = fixture(material); let returns = 0, writes = 0;
    const nativeError = Object.assign(new Error('Ordinary interrupted path'), { code: 'NoPath' });
    const stop = async () => { await Promise.resolve(); f.cancel(); throw nativeError; };
    if (material === 'leather') {
      f.bot.registry.entitiesByName.cow = { metadataKeys: ['baby', 'custom_name', 'health'] };
      f.bot.entities[42] = { id: 42, name: 'cow', type: 'animal', position: new Vec3(3, 64, 0), metadata: [false, null, 10] };
      f.deps.hunt = stop;
    } else f.deps.ensureTool = stop;
    f.deps.returnCamp = async () => { returns += 1; }; f.deps.setCheckpoint = () => { writes += 1; };
    await assert.rejects(createHouseResourceGatherer(f.deps).gather(material, 1, { anchor: { x: 0, y: 64, z: 0 } }), error => error.code === 'paused' && error !== nativeError);
    assert.equal(nativeError.cleanupOwnerFailure, undefined); assert.equal(writes, 0); assert.equal(returns, 0);
  }
});

test('unreachable resource is not retried after small exploration or checkpoint restart',async()=>{
 const f=fixture();f.candidate.stateId=123;let reaches=0,moves=0;
 f.deps.reachDig=async()=>{reaches++;throw Object.assign(Error('No path'),{name:'NoPath'});};
 f.deps.isExplorationPosition=()=>true;
 f.deps.nextExploration=async()=>{moves++;if(moves===1){f.bot.entity.position=new Vec3(16,64,0);return {moved:true};}return {moved:false,reason:'loaded_reachable_frontier_exhausted'};};
 const options={anchor:{x:0,y:64,z:0}};
 await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log',1,options),{code:'house_resource_search_exhausted'});
 assert.equal(reaches,1);assert.equal(f.checkpoint().searches.oak_log.failedTargets.length,1);
 await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log',1,options),{code:'house_resource_search_exhausted'});assert.equal(reaches,1);
});

test('distant loaded wood guides exploration before direct reach and is harvested only after actual approach',async()=>{
 const f=fixture(),anchor={x:0,y:64,z:0};f.blocks.clear();const tree=f.block('oak_log',40);f.blocks.set(tree.position.toString(),tree);
 let moves=0,reaches=0;f.deps.isExplorationPosition=()=>true;
 f.deps.nextExploration=async()=>{moves++;f.bot.entity.position=new Vec3(32,64,0);return {moved:true,via:[anchor,{x:32,y:64,z:0}]};};
 f.deps.reachDig=async()=>{reaches++;assert.equal(moves,1);assert.ok(tree.position.distanceTo(f.bot.entity.position)<=24);};
 const result=await createHouseResourceGatherer(f.deps).gather('oak_log',1,{anchor});
 assert.equal(result.acquired,1);assert.equal(reaches,1);assert.equal(moves,1);
});

for(const mode of ['allowed','no_permission','threat','too_many','not_local','not_wood','too_far'])test(`critical local survival wood remains bounded and explicitly authorized: ${mode}`,async()=>{
 const f=fixture(mode==='not_wood'?'dirt':'oak_log');f.bot.health=4;f.bot.food=16;
 for(let y=65;y<=66;y++){const b=f.block('oak_log',3,y);f.blocks.set(b.position.toString(),b);}
 if(mode==='too_far'){f.blocks.clear();const b=f.block('oak_log',9);f.blocks.set(b.position.toString(),b);}
 if(mode!=='no_permission')f.deps.allowSurvivalBootstrap=()=>mode!=='threat';
 const gatherer=createHouseResourceGatherer(f.deps),request=gatherer.gather(mode==='not_wood'?'dirt':'oak_log',mode==='too_many'?4:3,
  {anchor:{x:0,y:64,z:0},localOnly:mode!=='not_local',survivalBootstrap:true,finishTree:false,deferCampReturn:true});
 if(mode==='allowed'){const result=await request;assert.equal(result.acquired,3);assert.equal(f.counts().returned,0);}
 else{await assert.rejects(request,{code:mode==='too_far'?'house_resource_local_wood_unavailable':'house_resource_low_health'});assert.equal(f.counts().digCalls,0);}
});

for(const Kind of [ReferenceError,TypeError,SyntaxError])test(`world159 programming ${Kind.name} cannot be swallowed as a different-tree retry`,async()=>{
 const f=fixture(),failure=new Kind('production callback defect');let approaches=0;
 f.deps.reachDig=async()=>{approaches++;throw failure;};
 await assert.rejects(createHouseResourceGatherer(f.deps).gather('oak_log',1,{anchor:{x:0,y:64,z:0},localOnly:true,finishTree:false,deferCampReturn:true}),e=>e===failure);
 assert.equal(approaches,1);assert.equal(f.counts().digCalls,0);assert.equal(f.counts().returned,0);
});
