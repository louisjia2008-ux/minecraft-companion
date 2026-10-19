/* global require */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.8');
const Item = require('prismarine-item')(registry);
const Block = require('prismarine-block')(registry);
const injectInventory = require('mineflayer/lib/plugins/inventory');
const { createHouseResourceGatherer } = require('../vendor/server/minecraft/houseResourceGatherer');

// Offline protocol contract: installed Mineflayer inventory handles modeled
// server set_slot packets. Reach, dig, world responses and pickup timing are
// dependency fixtures, not live movement, mining or survival acceptance.
function fixture(options = {}) {
  const name = options.name || 'oak_log';
  const client = new EventEmitter(), bot = new EventEmitter();
  const cells = new Map(), history = [], reaches = new Map(), digs = [];
  let activeError, foreignBot, checkpoint, revocationCheckpoint, returns = 0, explorations = 0, stateId = 0, lastDug;
  const key = p => `${p.x},${p.y},${p.z}`;
  const put = (x, blockName) => {
    const block = Block.fromProperties(registry.blocksByName[blockName].id, {}, 0);
    block.position = new Vec3(x, 64, 0); cells.set(key(block.position), block); return block;
  };
  const first = put(3, options.block || 'oak_log'), second = put(4, options.secondBlock || options.block || 'oak_log');
  Object.assign(bot, { registry, version: '1.21.8', _client: client, QUICK_BAR_START: 36,
    health: 20, food: 20, entities: {}, game: { gameMode: 'survival' },
    entity: { id: 1, position: new Vec3(.5, 64, .5), onGround: true },
    supportFeature: feature => registry.supportFeature(feature),
    blockAt: p => { history.push(['blockAt', key(p)]); return cells.get(key(p)) || null; },
    canDigBlock: block => { history.push(['canDigBlock', key(block.position)]); return true; } });
  client.write = () => { throw new Error('Offline fixture must not send client packets'); };
  injectInventory(bot, { hideErrors: true }); bot.quickBarSlot = 0;
  const inventoryCount = itemName => bot.inventory.items().filter(item => item.name === itemName).reduce((sum, item) => sum + item.count, 0);
  const slot = (count, itemName = name, index = 36) => {
    history.push(['set_slot', itemName, count]);
    client.emit('set_slot', { windowId: 0, stateId: ++stateId, slot: index,
      item: count ? Item.toNotch(new Item(registry.itemsByName[itemName].id, count)) : { itemCount: 0 } });
  };
  const deps = { getBot: () => foreignBot || bot,
    assertActive: () => { if (activeError) throw activeError; },
    getCheckpoint: () => checkpoint,
    setCheckpoint: value => { history.push(['save']); checkpoint = value; },
    capacityFor: () => 64, withSurface: action => action(), ensureFood: async () => {},
    ensureTool: async () => {}, waitGround: async () => {}, safeFoot: () => true,
    findBlocks: names => [...cells.values()].filter(block => names.includes(block.name)),
    reachDig: async block => {
      const id = key(block.position), attempt = (reaches.get(id) || 0) + 1;
      reaches.set(id, attempt); history.push(['reach', id, attempt]);
      if (id === key(first.position) && attempt === 1) throw Object.assign(new Error('temporary initial geometry rejection'), { code: 'NoPath' });
      await options.afterReach?.({ block, attempt, cells, put, bot });
    },
    canDigSafely: block => { history.push(['canDigSafely', key(block.position)]); return options.safe?.(block, reaches) ?? true; },
    dig: async block => { lastDug = block; digs.push(key(block.position)); history.push(['dig', key(block.position)]); cells.delete(key(block.position)); },
    collectDrops: async () => {
      history.push(['collect', key(lastDug.position)]);
      if (options.collect) await options.collect({ slot, inventoryCount, lastDug, cells, first, second, put, bot });
      else slot(inventoryCount(lastDug.name) + 1, lastDug.name, lastDug.name === 'birch_log' ? 37 : 36);
      if (options.revokeAfterPickup) {
        revocationCheckpoint=checkpoint===undefined?undefined:JSON.parse(JSON.stringify(checkpoint));
        activeError = Object.assign(new Error(options.revokeAfterPickup), { code: options.revokeAfterPickup });
        if (options.revokeAfterPickup === 'foreign_owner') foreignBot = { inventory: bot.inventory };
      }
    },
    returnCamp: async () => { returns += 1; history.push(['return']); },
    isExplorationPosition: () => true,
    nextExploration: async () => { explorations += 1; return { moved: false, reason: 'loaded_reachable_frontier_exhausted', via: [{ x: 0, y: 64, z: 0 }] }; } };
  const gather = amount => createHouseResourceGatherer(deps).gather(name, amount, { anchor: { x: 0, y: 64, z: 0 } });
  return { bot, client, deps, first, second, cells, history, reaches, digs, slot, inventoryCount, gather,
    counts: () => ({ returns, explorations, checkpoint, revocationCheckpoint }) };
}

test('actual accepted slot pickup reopens a temporary rejected tree with fresh reach and digging guards', async () => {
  const f = fixture();
  const result = await f.gather(2);
  assert.equal(result.confirmed, true); assert.equal(result.acquired, 2);
  assert.equal(f.inventoryCount('oak_log'), 2); assert.equal(f.reaches.get('3,64,0'), 2);
  assert.deepEqual(f.digs, ['4,64,0', '3,64,0']);
  assert.equal(f.counts().explorations, 0); assert.equal(f.counts().returns, 1);
  const resumedReach = f.history.findIndex(event => event[0] === 'reach' && event[1] === '3,64,0' && event[2] === 2);
  const pickup = f.history.findIndex(event => event[0] === 'set_slot' && event[1] === 'oak_log' && event[2] === 1);
  assert.ok(pickup < resumedReach);
  assert.deepEqual(f.history.slice(resumedReach + 1, resumedReach + 5).map(event => event[0]), ['blockAt', 'canDigBlock', 'canDigSafely', 'dig']);
});

test('any_log retries count actual registered species rather than a synthetic any_log item', async () => {
  const f = fixture({ name: 'any_log', secondBlock: 'birch_log' });
  const result = await f.gather(2);
  assert.deepEqual(result.actualItems, { oak_log: 1, birch_log: 1 });
  assert.equal(f.reaches.get('3,64,0'), 2); assert.equal(f.counts().explorations, 0);
});

for (const mode of ['no_packet', 'unrelated_item', 'unchanged_accepted_count']) {
  test(`${mode} after a successful dig promise does not reopen rejected candidates`, async () => {
    const f = fixture({ collect: async ({ slot }) => {
      if (mode === 'unrelated_item') slot(1, 'dirt');
      if (mode === 'unchanged_accepted_count') slot(0, 'oak_log');
    } });
    await assert.rejects(f.gather(2), { code: 'house_resource_search_exhausted' });
    assert.equal(f.reaches.get('3,64,0'), 1); assert.deepEqual(f.digs, ['4,64,0']);
    assert.equal(f.inventoryCount('oak_log'), 0); assert.equal(f.counts().explorations, 1);
  });
}

test('legitimate seed no-drop progress never reopens the prior rejected grass', async () => {
  const f = fixture({ name: 'wheat_seeds', block: 'short_grass', collect: async () => {} });
  await assert.rejects(f.gather(1), { code: 'house_resource_search_exhausted' });
  assert.equal(f.reaches.get('3,64,0'), 1); assert.deepEqual(f.digs, ['4,64,0']);
  assert.equal(f.inventoryCount('wheat_seeds'), 0); assert.equal(f.counts().checkpoint.searches.wheat_seeds.attempts, 1);
});

for (const code of ['paused', 'foreign_owner']) {
  test(`an accepted pickup followed by ${code} cannot retry, promote progress or issue a late camp return`, async () => {
    const f = fixture({ revokeAfterPickup: code });
    await assert.rejects(f.gather(2), { code });
    assert.equal(f.inventoryCount('oak_log'), 1); assert.equal(f.reaches.get('3,64,0'), 1);
    assert.equal(f.counts().returns, 0); assert.equal(f.counts().explorations, 0);
    // Earlier target-rejection facts may already be checkpointed. Revocation
    // must prevent NEW progress saves; it cannot erase legitimate prior facts.
    assert.deepEqual(f.counts().checkpoint,f.counts().revocationCheckpoint);
    const pickup=f.history.findLastIndex(e=>e[0]==='set_slot'&&e[1]==='oak_log');
    assert.equal(f.history.slice(pickup+1).some(e=>e[0]==='save'),false);
    assert.deepEqual(f.digs, ['4,64,0']);
  });
}

test('a reopened target becoming unloaded during its second approach remains unknown and cannot be dug', async () => {
  const f = fixture({ afterReach: async ({ block, attempt, cells }) => {
    if (block.position.x === 3 && attempt === 2) cells.delete('3,64,0');
  } });
  await assert.rejects(f.gather(2), { code: 'house_resource_search_exhausted' });
  assert.equal(f.inventoryCount('oak_log'), 1); assert.equal(f.reaches.get('3,64,0'), 2);
  assert.deepEqual(f.digs, ['4,64,0']);
});

test('a reopened target still needs the original fresh digging safety predicate', async () => {
  const f = fixture({ safe: block => block.position.x !== 3 });
  await assert.rejects(f.gather(2), { code: 'house_resource_search_exhausted' });
  assert.equal(f.inventoryCount('oak_log'), 1); assert.equal(f.reaches.get('3,64,0'), 2);
  assert.deepEqual(f.digs, ['4,64,0']);
});

test('after one real pickup, a subsequent no-drop rejected retry is not reopened again at the same stance', async () => {
  const f = fixture({ collect: async ({ slot, lastDug }) => { if (lastDug.position.x === 4) slot(1, 'oak_log'); } });
  await assert.rejects(f.gather(2), { code: 'house_resource_search_exhausted' });
  assert.equal(f.inventoryCount('oak_log'), 1); assert.equal(f.reaches.get('3,64,0'), 2);
  assert.deepEqual(f.digs, ['4,64,0', '3,64,0']); assert.equal(f.counts().explorations, 1);
});

for (const scenario of [
  { progress: true, interruptions: 5, limit: 5, success: true },
  { progress: false, interruptions: 5, limit: 4, success: false },
  { progress: true, interruptions: 9, limit: 8, success: false }
]) {
  test(`survival handoff bounded by actual inventory progress ${JSON.stringify(scenario)}`, async () => {
    let interruptions = 0, resumes = 0;
    const f = fixture({ name: 'dirt', block: 'dirt', afterReach: async () => {
      if ((!scenario.progress || f.inventoryCount('dirt') > 0) && interruptions < scenario.interruptions) {
        interruptions++;
        throw Object.assign(new Error('modeled owned defense preemption'), { code: 'movement_preempted' });
      }
    } });
    f.deps.resumeAfterSurvival = async () => { resumes++; return true; };
    if (scenario.success) assert.equal((await f.gather(2)).confirmed, true);
    else await assert.rejects(f.gather(2), { code: 'movement_preempted' });
    assert.equal(resumes, scenario.limit);
    assert.equal(f.inventoryCount('dirt'), scenario.success ? 2 : scenario.progress ? 1 : 0);
    assert.equal(f.digs.length, scenario.success ? 2 : scenario.progress ? 1 : 0);
  });
}

test('loaded ready surface soil is attempted before a nearer occluded soil candidate',async()=>{
 const f=fixture({name:'dirt',block:'dirt'});f.deps.isCurrentDigTargetReady=b=>b.position.x===4;
 const r=await f.gather(1);assert.equal(r.confirmed,true);assert.equal(f.inventoryCount('dirt'),1);
 assert.equal(f.reaches.has('3,64,0'),false);assert.deepEqual(f.digs,['4,64,0']);
});
test('current soil priority grants no permission past the final dig safety predicate',async()=>{
 const f=fixture({name:'dirt',block:'dirt',safe:()=>false});f.deps.isCurrentDigTargetReady=b=>b.position.x===4;
 await assert.rejects(f.gather(1),{code:'house_resource_search_exhausted'});
 assert.equal(f.inventoryCount('dirt'),0);assert.deepEqual(f.digs,[]);
});
