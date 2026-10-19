/* global require, queueMicrotask, setInterval, clearInterval, setTimeout */
"use strict";
// Contract tests, not official-server acceptance. The original inventory,
// crafting, windows, recipes, pathfinder and Physics implementations execute.
// A separate modeled server provides raw slot ACKs, placed-block facts and raw
// resource arrivals; those providers do not prove natural-world acquisition.
const test = require("node:test"),
  assert = require("node:assert/strict");
const { EventEmitter } = require("node:events"),
  { AsyncLocalStorage } = require("node:async_hooks");
const { Vec3 } = require("vec3"),
  registry = require("prismarine-registry")("1.21.8"),
  Block = require("prismarine-block")(registry),
  Item = require("prismarine-item")(registry),
  windows = require("prismarine-windows")("1.21.8");
const { Physics, PlayerState } = require("prismarine-physics"),
  { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const {
  createHouseSelfSupplyRuntime,
} = require("../vendor/server/minecraft/houseSelfSupplyRuntime");
const {
  hasGroundedBodySupport,
} = require("../vendor/server/minecraft/houseSurfaceGraph");
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`,
  clone = (v) => JSON.parse(JSON.stringify(v)),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const camp = {
  anchor: { x: -3, y: 64, z: 0 },
  stations: {
    crafting_table: { x: -1, y: 64, z: 0 },
    furnace: { x: -3, y: 64, z: 2 },
  },
  storageSites: [
    { x: -6, y: 64, z: 0 },
    { x: -8, y: 64, z: 0 },
  ],
};
function fixture(t, options = {}) {
  const contexts = new AsyncLocalStorage(),
    cells = new Map(),
    containers = new Map(),
    serverPlayer = Array(46).fill(null),
    packets = [],
    calls = [],
    checkpoints = [],
    moves = [];
  const state = {
    checkpoint: null,
    cancelled: false,
    cursor: null,
    activeRecipe: null,
    window: 1,
  };
  const client = new EventEmitter(),
    bot = Object.assign(new EventEmitter(), {
      registry,
      version: "1.21.8",
      username: "CampContract",
      _client: client,
      QUICK_BAR_START: 36,
      health: 20,
      food: 20,
      game: {
        gameMode: "survival",
        minY: -64,
        height: 384,
        dimension: "overworld",
      },
      entities: {},
      players: {},
      jumpTicks: 0,
      jumpQueued: false,
      fireworkRocketDuration: 0,
      player: { ping: 1 },
      supportFeature: (n) => registry.supportFeature(n),
      controlState: Object.fromEntries(
        ["forward", "back", "left", "right", "jump", "sprint", "sneak"].map(
          (n) => [n, false],
        ),
      ),
      entity: {
        id: 1,
        position: new Vec3(-2.5, 64, 0.5),
        velocity: new Vec3(0, 0, 0),
        onGround: true,
        eyeHeight: 1.62,
        height: 1.8,
        width: 0.6,
        yaw: 0,
        pitch: 0,
        effects: {},
        attributes: {},
        isInWater: false,
        isInLava: false,
        isInWeb: false,
        isCollidedHorizontally: false,
        isCollidedVertically: true,
        elytraFlying: false,
      },
    });
  const active = () => {
    if (state.cancelled)
      throw Object.assign(new Error("cancelled"), { code: "cancelled" });
  };
  const item = (name, count) =>
      count ? new Item(registry.itemsByName[name].id, count) : null,
    copyItem = (i) => (i ? Item.fromNotch(Item.toNotch(i)) : null);
  const put = (p, name, properties = {}) => {
    const b = Object.assign(
      Block.fromProperties(registry.blocksByName[name].id, properties, 0),
      { position: new Vec3(p.x, p.y, p.z) },
    );
    cells.set(key(p), b);
    return b;
  };
  if(options.furnaceTerrain)put(camp.stations.furnace,options.furnaceTerrain);
  bot.blockAt = (raw) => {
    const p = raw.floored();
    return (
      cells.get(key(p)) ||
      Object.assign(
        Block.fromStateId(
          registry.blocksByName[p.y < 64 ? "stone" : "air"].defaultState,
        ),
        { position: p },
      )
    );
  };
  bot.look = async (yaw, pitch) => {
    bot.entity.yaw = yaw;
    bot.entity.pitch = pitch;
  };
  bot.lookAt = async () => {};
  bot.swingArm = () => {};
  bot.setControlState = (name, value) => {
    bot.controlState[name] = value;
  };
  bot.clearControlStates = () => {
    for (const name of Object.keys(bot.controlState))
      bot.controlState[name] = false;
  };
  bot.stopDigging = () => {};
  bot.deactivateItem = () => {};
  function slotWrite(window, slot, value) {
    if (window.id === 0) serverPlayer[slot] = copyItem(value);
    else if (slot < window.inventoryStart)
      window.serverSlots[slot] = copyItem(value);
    else serverPlayer[slot - (window.inventoryStart - 9)] = copyItem(value);
    client.emit("set_slot", {
      windowId: window.id,
      stateId: packets.length,
      slot,
      item: Item.toNotch(value),
    });
  }
  function currentSlots(window) {
    return window.id === 0 ? serverPlayer : window.serverSlots;
  }
  const originalWrite = function (name, data) {
    packets.push({ name, data, receiver: this });
    if (name === "window_click") {
      const window = data.windowId === 0 ? bot.inventory : bot.currentWindow;
      assert.equal(window?.id, data.windowId);
      const output =
        state.activeRecipe && data.slot === 0 && data.mouseButton === 0;
      if (output) {
        const serverSlots = currentSlots(window),
          inputs = {};
        for (const value of serverSlots.slice(1, window.id === 0 ? 5 : 10))
          if (value)
            inputs[value.type] = (inputs[value.type] || 0) + value.count;
        for (const delta of state.activeRecipe.delta)
          if (delta.count < 0)
            assert.ok(
              (inputs[delta.id] || 0) >= -delta.count,
              "Modeled server independently confirms installed recipe input",
            );
      }
      for (const changed of data.changedSlots || [])
        slotWrite(window, changed.location, Item.fromNotch(changed.item));
      state.cursor = Item.fromNotch(data.cursorItem);
      if (
        state.activeRecipe &&
        data.slot >= 1 &&
        data.slot < (window.id === 0 ? 5 : 10)
      ) {
        const inputs = {};
        for (const value of currentSlots(window).slice(
          1,
          window.id === 0 ? 5 : 10,
        ))
          if (value)
            inputs[value.type] = (inputs[value.type] || 0) + value.count;
        const recipe = state.activeRecipe,
          ready = recipe.delta
            .filter((d) => d.count < 0)
            .every((d) => (inputs[d.id] || 0) >= -d.count);
        // Native clickWindow waits for a subsequent server crafting-result ACK;
        // client acceptClick alone cannot provide this modeled server response.
        queueMicrotask(() =>
          slotWrite(
            window,
            0,
            ready
              ? new Item(
                  recipe.result.id,
                  recipe.result.count,
                  recipe.result.metadata,
                )
              : null,
          ),
        );
      }
      if (output) {
        assert.equal(state.cursor?.type, state.activeRecipe.result.id);
        assert.equal(state.cursor?.count, state.activeRecipe.result.count);
        for (let slot = 1; slot < (window.id === 0 ? 5 : 10); slot++)
          slotWrite(window, slot, null);
        calls.push({
          kind: "nativeCraftOutput",
          name: registry.items[state.activeRecipe.result.id].name,
        });
      }
    }
    if (name === "close_window") {
      const window = bot.currentWindow;
      if (window?.storageKey)
        containers.set(window.storageKey, window.serverSlots.map(copyItem));
      if (state.cursor) {
        const slot = serverPlayer.findIndex((i, n) => n >= 9 && n < 45 && !i);
        assert.ok(slot >= 0);
        serverPlayer[slot] = copyItem(state.cursor);
        state.cursor = null;
      }
      queueMicrotask(() => {
        for (let slot = 9; slot < 45; slot++)
          client.emit("set_slot", {
            windowId: 0,
            stateId: packets.length,
            slot,
            item: Item.toNotch(serverPlayer[slot]),
          });
      });
    }
  };
  client.write = originalWrite;
  require("mineflayer/lib/plugins/inventory")(bot, { hideErrors: true });
  bot.quickBarSlot = 0;
  require("mineflayer/lib/plugins/craft")(bot);
  const stock = (name) =>
    bot.inventory
      .items()
      .filter((i) => i.name === name)
      .reduce((sum, i) => sum + i.count, 0);
  const rawSet = (slot, value) => {
    serverPlayer[slot] = copyItem(value);
    client.emit("set_slot", {
      windowId: 0,
      stateId: packets.length,
      slot,
      item: Item.toNotch(value),
    });
  };
  const arrive = (name, amount) => {
    while (amount > 0) {
      let slot = serverPlayer.findIndex(
        (i, n) =>
          n >= 9 &&
          n < 45 &&
          i?.name === name &&
          i.count < (registry.itemsByName[name].stackSize || 64),
      );
      if (slot < 0)
        slot = serverPlayer.findIndex((i, n) => n >= 9 && n < 45 && !i);
      assert.ok(slot >= 0);
      const before = serverPlayer[slot]?.count || 0,
        n = Math.min(
          amount,
          (registry.itemsByName[name].stackSize || 64) - before,
        );
      rawSet(slot, item(name, before + n));
      amount -= n;
    }
  };
  function open(block) {
    const crafting = block.name === "crafting_table",
      window = windows.createWindow(
        state.window++,
        crafting ? "minecraft:crafting" : "minecraft:generic_9x3",
        "modeled camp",
      );
    window.serverSlots = crafting
      ? Array(10).fill(null)
      : (containers.get(key(block.position)) || Array(27).fill(null)).map(
          copyItem,
        );
    if (!crafting) window.storageKey = key(block.position);
    for (let slot = 0; slot < window.inventoryStart; slot++)
      window.updateSlot(slot, copyItem(window.serverSlots[slot]));
    for (let slot = 9; slot < 45; slot++)
      window.updateSlot(
        slot + window.inventoryStart - 9,
        copyItem(serverPlayer[slot]),
      );
    bot.currentWindow = window;
    queueMicrotask(() => bot.emit("windowOpen", window));
    return window;
  }
  bot.activateBlock = (block) => {
    calls.push({
      kind: "nativeOpen",
      name: block.name,
      position: clone(block.position),
    });
    open(block);
  };
  bot.physics = Physics(registry, { getBlock: bot.blockAt });
  pathfinder(bot);
  const movement = new Movements(bot);
  movement.canDig = false;
  movement.scafoldingBlocks = [];
  movement.allowParkour = false;
  movement.allowSprinting = false;
  movement.getMoveDiagonal = () => {};
  bot.pathfinder.setMovements(movement);
  const timer = setInterval(() => {
    bot.physics
      .simulatePlayer(new PlayerState(bot, bot.controlState), {
        getBlock: bot.blockAt,
      })
      .apply(bot);
    bot.emit("physicsTick");
  }, 5);
  const isCamp = () =>
    bot.entity.position
      .floored()
      .equals(new Vec3(camp.anchor.x, camp.anchor.y, camp.anchor.z)) &&
    hasGroundedBodySupport(bot);
  const move = async (p) => {
    active();
    moves.push({ from: clone(bot.entity.position), to: clone(p) });
    await bot.pathfinder.goto(new goals.GoalBlock(p.x, p.y, p.z));
    for (let i = 0; i < 300 && !hasGroundedBodySupport(bot); i++)
      await sleep(3);
    active();
    assert.ok(hasGroundedBodySupport(bot));
    assert.ok(bot.entity.position.floored().equals(new Vec3(p.x, p.y, p.z)));
  };
  const returnCamp = async () => {
    calls.push({ kind: "returnCamp", from: clone(bot.entity.position) });
    await move(camp.anchor);
    assert.ok(isCamp());
  };
  const withCampWork = async (action) => {
    await returnCamp();
    calls.push({ kind: "campWorkStart" });
    const result = await action();
    active();
    await returnCamp();
    calls.push({
      kind: "campWorkEnd",
      position: clone(bot.entity.position),
      onGround: bot.entity.onGround,
      grounded: hasGroundedBodySupport(bot),
    });
    return result;
  };
  let source;
  const deps = {
    getBot: () => bot,
    assertActive: active,
    getCheckpoint: () => state.checkpoint,
    setCheckpoint: (next, meta) => {
      if (!meta?.confirmedFact) active();
      state.checkpoint = clone(next);
      checkpoints.push({ state: clone(next), meta });
    },
    isSourceContext: (candidate) => contexts.getStore() === candidate,
    withContext: (runtime, _bounds, action) => contexts.run(runtime, action),
    blockAt: (p) => bot.blockAt(new Vec3(p.x, p.y, p.z)),
    chooseCamp: async () => clone(camp),
    shouldBootstrapField:()=>options.asyncFieldRecovery?Promise.resolve(options.fieldRecovery===true):options.fieldRecovery===true,
    restorePriorCamp:async(_state,request={})=>{if(options.failOnArchiveRestore)throw Error('A local empty-handed bootstrap must precede archived-camp travel');if(request.localOnly&&options.nearbyOwnedCamp){calls.push({kind:'nearbyOwnedRestored'});return clone(options.nearbyOwnedCamp);}return null;},
    prepareBasicEquipment:async()=>{calls.push({kind:"basicEquipment"});assert.ok(state.checkpoint.ownedStations.crafting_table);},
    prepareDefense:async()=>{calls.push({kind:'defense'});if(options.assertStoredBeforeDefense){assert.ok(state.checkpoint.storage?.chests[0]?.confirmedPlaced);assert.ok(Object.values(state.checkpoint.storage.chests[0].stock).some(n=>n>0),'Bulk material must be in the actual owned chest before deep defense preparation');}},
    provision:async(_anchor,request={})=>{calls.push({kind:"provision",expedition:request.expedition===true});if(options.stopAtUrgentProvision)throw Object.assign(Error('urgent provision reached before equipment'),{code:'fixture_urgent_provision'});assert.ok(calls.some(c=>c.kind==="basicEquipment"));if(request.expedition&&options.failExpeditionProvision)throw Object.assign(Error('no confirmed expedition food'),{code:'fixture_expedition_food_missing'});},
    returnCamp,
    clearStationVegetation:async p=>{active();calls.push({kind:'clearVegetation',name:bot.blockAt(new Vec3(p.x,p.y,p.z)).name});put(p,'air');},
    canPrepareSurvivalTools:()=>options.survivalTools===true||options.allowSurvivalTools===true,
    relocateDestroyedCamp:options.survivalTools?async()=>({anchor:{x:-19,y:64,z:0},stations:{crafting_table:{x:-17,y:64,z:0},furnace:{x:-19,y:64,z:2}},storageSites:[{x:-22,y:64,z:0}]}):undefined,
    bootstrapWood: async request => {
      if(options.survivalTools){assert.deepEqual(request.anchor,camp.anchor);assert.equal(request.survivalBootstrap,true);assert.ok(Array.isArray(request.exclusionBounds));}

      calls.push({ kind: "bootstrap" });
      if(options.stopAtFieldBootstrap)throw Object.assign(Error('field bootstrap before distant return'),{code:'fixture_field_bootstrap'});
      arrive("oak_log", options.bootstrapLogs ?? 8);
      return { logName: "oak_log", plankName: "oak_planks" };
    },
    acquireRaw: async (name, amount) => {
      if(options.requireSwordBeforeNewLogs && name.endsWith("_log"))assert.ok(calls.some(c=>c.kind==="survivalWeaponEquipped"),"third log must follow actual sword craft and equipment handoff");
      if (options.withCampWork !== false)
        assert.ok(
          isCamp(),
          `Next raw ${name} must start at actual camp, not a workstation/chest stance`,
        );
      calls.push({ kind: "raw", name, amount, atCamp: isCamp() });
      arrive(name, amount);
    },
    craftRecipe: async (recipe, repetitions, context) => {
      calls.push({
        kind: "craft",
        name: registry.items[recipe.result.id].name,
      });
      if (context.table)
        await move({
          x: context.table.position.x - 1,
          y: 64,
          z: context.table.position.z + 1,
        });
      state.activeRecipe = recipe;
      try {
        await bot.craft(recipe, repetitions, context.table);
      } finally {
        state.activeRecipe = null;
      }
    },
    placeNative: async (spec, confirmed) => {
      active();
      calls.push({ kind: "place", name: spec.item });
      await move({ x: spec.position.x - 1, y: 64, z: spec.position.z });
      const held = bot.inventory.items().find((i) => i.name === spec.item);
      assert.ok(held);
      rawSet(
        held.slot,
        held.count === 1 ? null : item(held.name, held.count - 1),
      );
      put(spec.position, spec.item, spec.properties);
      if (spec.item === "chest")
        containers.set(key(spec.position), Array(27).fill(null));
      confirmed();
      if (options.cancelAfterPlace === spec.item) state.cancelled = true;
    },
    reach: async (p) => {
      await move({ x: p.x + 1, y: p.y, z: p.z });
    },
    openContainer: (block) => bot.openBlock(block),
    smeltBatch: async () => {
      throw new Error(
        "This fixture does not model furnace smelting or claim native furnace use",
      );
    },
    report: () => {},
  };
  if (options.withCampWork !== false) deps.withCampWork = withCampWork;
  source = createHouseSelfSupplyRuntime(
    deps,
    { profile: "cottage", anchor: { x: 3, y: 64, z: 3 } },
    [{ minX: 0, maxX: 10, minY: 62, maxY: 80, minZ: 0, maxZ: 10 }],
  );
  t.after(() => {
    state.cancelled = true;
    clearInterval(timer);
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    bot.emit("end");
  });
  return {
    deps,
    bot,
    source,
    state,
    put,
    packets,
    calls,
    checkpoints,
    moves,
    containers,
    serverPlayer,
    stock,
    isCamp,
    run: (fn) => contexts.run(source, fn),
    returnCamp,
  };
}

test('restoring a camp does not classify its own confirmed chest as retired foreign property',{timeout:15000},async t=>{
 const f=fixture(t);await f.source.run({oak_planks:1});
 const cp=f.state.checkpoint;cp.retiredCamps=[{camp:clone(cp.camp),ownedStations:clone(cp.ownedStations),storage:clone(cp.storage)}];
 const before=clone(cp.storage.chests[0].position);
 cp.storage.exclusionBounds.push({minX:before.x,maxX:before.x,minY:before.y-1,maxY:before.y+2,minZ:before.z,maxZ:before.z});
 await f.run(()=>f.source.ensureStorage());
 assert.deepEqual(f.state.checkpoint.storage.chests[0].position,before);
 assert.equal(f.bot.blockAt(new Vec3(before.x,before.y,before.z)).name,'chest');
});

for(const sameIdentity of [true,false])test(`cleared restored stock accepts only a matching earlier owned receipt: ${sameIdentity}`,{timeout:15000},async t=>{
 const f=fixture(t);await f.source.run({oak_planks:24});
 await f.run(()=>f.source.stash({oak_planks:4}));
 assert.equal(f.source.storage.getStock().oak_planks,20);
 const cp=f.state.checkpoint,archived=clone(cp.storage);
 if(!sameIdentity)archived.storageId='foreign-storage';
 cp.retiredCamps=[{camp:clone(cp.camp),ownedStations:clone(cp.ownedStations),storage:archived}];
 cp.storage.chests[0].stock={};
 if(sameIdentity){await f.run(()=>f.source.ensureStorage());assert.equal(f.source.storage.getStock().oak_planks,20);assert.equal(f.stock('oak_planks'),4);}
 else await assert.rejects(f.run(()=>f.source.ensureStorage()),{code:'house_storage_foreign_contents'});
});

test('an authoritative async empty-handed field decision bootstraps before returning to an already owned distant camp',{timeout:15000},async t=>{
 const options={},f=fixture(t,options);await f.source.run({oak_planks:1});
 const start=f.calls.length;f.bot.health=7;f.bot.food=17;options.fieldRecovery=true;options.asyncFieldRecovery=true;options.stopAtFieldBootstrap=true;options.failOnArchiveRestore=true;
 await assert.rejects(f.source.run({cobblestone:4}),{code:'fixture_field_bootstrap'});
 const calls=f.calls.slice(start);assert.equal(calls[0].kind,'bootstrap');assert.equal(calls.some(c=>c.kind==='returnCamp'),false);
 assert.ok(f.state.checkpoint.ownedStations.crafting_table);
});

test('a real owned chest receives surplus stock before the defense mining chain begins',{timeout:15000},async t=>{
 const f=fixture(t,{assertStoredBeforeDefense:true});await f.source.run({oak_planks:24});
 assert.ok(f.calls.some(c=>c.kind==='defense'));assert.ok(f.stock('oak_planks')>=24);
 assert.ok(f.calls.findIndex(c=>c.kind==='provision'&&c.expedition)<f.calls.findIndex(c=>c.kind==='defense'));
});

test('first-shield mining waits for expedition food after tools and storage, at partial health',{timeout:15000},async t=>{
 const f=fixture(t,{failExpeditionProvision:true});f.bot.health=12.5;f.bot.food=15;
 await assert.rejects(f.source.run({oak_planks:24}),{code:'fixture_expedition_food_missing'});
 assert.ok(f.calls.some(c=>c.kind==='basicEquipment'));
 assert.ok(f.state.checkpoint.storage.chests[0].confirmedPlaced);
 assert.ok(f.calls.some(c=>c.kind==='provision'&&c.expedition));
 assert.equal(f.calls.some(c=>c.kind==='defense'),false);
 assert.equal(f.bot.health,12.5);
});

test('critical food deficit reaches provisioning before any tool, station or raw-material action',async t=>{
 const f=fixture(t,{stopAtUrgentProvision:true});f.bot.health=4;f.bot.food=16;
 await assert.rejects(f.run(()=>f.source.run({cobblestone:1})),e=>e.code==='fixture_urgent_provision');
 assert.equal(f.calls.filter(c=>c.kind==='provision').length,1);
 assert.equal(f.calls.some(c=>['basicEquipment','place','nativeCraftOutput','raw'].includes(c.kind)),false);
 assert.equal(f.bot.health,4);assert.equal(f.bot.food,16);
});
test('natural non-colliding grass at a chosen furnace site is replaceable while a foreign chest remains protected',{timeout:15000},async t=>{
 const grass=fixture(t,{furnaceTerrain:'short_grass'});await grass.source.run({oak_planks:1});
 assert.equal(grass.state.checkpoint.ownedStations.furnace.confirmedPlaced,true);
 assert.equal(grass.calls.filter(c=>c.kind==='clearVegetation').length,1);
 assert.ok(grass.calls.findIndex(c=>c.kind==='clearVegetation')<grass.calls.findIndex(c=>c.kind==='place'&&c.name==='furnace'));
 const chest=fixture(t,{furnaceTerrain:'chest'});await assert.rejects(chest.source.run({oak_planks:1}),{code:'house_self_supply_foreign_station'});
 assert.equal(chest.state.checkpoint.ownedStations.furnace,undefined);
 assert.equal(chest.calls.some(c=>c.kind==='clearVegetation'),false);
 assert.equal(chest.bot.blockAt(new Vec3(camp.stations.furnace.x,camp.stations.furnace.y,camp.stations.furnace.z)).name,'chest');
});
test('camp vegetation clearance never authorizes fluid, fire, fixtures, terrain or unknown blocks',()=>{
 const {isCampReplaceablePlant}=require('../vendor/server/minecraft/houseSelfSupplyRuntime');
 for(const name of ['water','lava','fire','torch','chest','crafting_table','sand','grass_block'])assert.equal(isCampReplaceablePlant(Block.fromStateId(registry.blocksByName[name].defaultState)),false,name);
 assert.equal(isCampReplaceablePlant(null),false);
 for(const name of ['short_grass','azure_bluet'])assert.equal(isCampReplaceablePlant(Block.fromStateId(registry.blocksByName[name].defaultState)),true,name);
});

test(
  "camp work wraps original craft/place and owned native storage; next raw starts at actual camp",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    assert.equal(f.bot.inventory.items().length, 0);
    await f.source.run({ oak_planks: 24, white_wool: 3 });
    assert.ok(f.isCamp());
    assert.equal(f.stock("oak_planks"), 24);
    assert.equal(f.stock("white_wool"), 3);
    assert.ok(f.state.checkpoint.ownedStations.crafting_table.confirmedPlaced);
    assert.ok(f.state.checkpoint.ownedStations.furnace.confirmedPlaced);
    assert.ok(f.state.checkpoint.storage.chests[0].emptyAuthorized);
    assert.ok(
      f.calls.some((c) => c.kind === "nativeCraftOutput" && c.name === "chest"),
    );
    assert.ok(
      f.calls.some(
        (c) => c.kind === "nativeCraftOutput" && c.name === "furnace",
      ),
    );
    assert.ok(f.calls.filter((c) => c.kind === "raw").every((c) => c.atCamp));
    assert.ok(
      f.calls
        .filter((c) => c.kind === "campWorkEnd")
        .every(
          (c) =>
            c.grounded &&
            Math.floor(c.position.x) === camp.anchor.x &&
            Math.floor(c.position.z) === camp.anchor.z,
        ),
    );
    assert.ok(f.moves.length > 10);
    await f.run(() => f.source.stash({ oak_planks: 4, white_wool: 3 }));
    assert.ok(f.isCamp());
    assert.equal(f.stock("oak_planks"), 4);
    assert.equal(f.source.storage.getStock().oak_planks, 20);
    const before = f.packets.filter((p) => p.name === "window_click").length;
    await f.run(() => f.source.takeOwnedStock({ oak_planks: 12 }));
    assert.ok(f.isCamp());
    assert.equal(f.stock("oak_planks"), 12);
    assert.equal(f.source.storage.getStock().oak_planks, 12);
    assert.ok(
      f.packets.filter((p) => p.name === "window_click").length > before,
    );
    assert.equal(f.bot.currentWindow, null);
    assert.equal(
      f.state.checkpoint.storage.chests[0].pendingClosedInventory,
      null,
    );
  },
);
test(
  "optional absent withCampWork keeps the existing runtime dependency contract compatible",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t, { withCampWork: false });
    await f.source.run({ white_wool: 1 });
    assert.ok(f.isCamp());
    assert.equal(f.stock("white_wool"), 1);
    assert.ok(f.state.checkpoint.storage.chests[0].emptyAuthorized);
    assert.ok(
      f.calls.some(
        (c) => c.kind === "nativeCraftOutput" && c.name === "crafting_table",
      ),
    );
    assert.equal(
      f.calls.some((c) => c.kind === "campWorkStart"),
      false,
    );
  },
);
test(
  "cancel after modeled native placement retains only confirmed station ownership and never starts new raw",
  { timeout: 8000 },
  async (t) => {
    const f = fixture(t, { cancelAfterPlace: "crafting_table" });
    await assert.rejects(
      f.source.run({ white_wool: 1 }),
      (error) => error.code === "cancelled",
    );
    assert.equal(
      f.state.checkpoint.ownedStations.crafting_table.confirmedPlaced,
      true,
    );
    assert.ok(
      f.checkpoints.some(
        (c) => c.meta?.confirmedFact && c.state.ownedStations?.crafting_table,
      ),
    );
    assert.equal(
      f.calls.some((c) => c.kind === "raw"),
      false,
    );
    assert.equal(f.state.checkpoint.ownedStations.furnace, undefined);
  },
);

test('a relocated camp skips protected former chest candidates while preserving the old actual chest',{timeout:15000},async t=>{
 const f=fixture(t);await f.source.run({oak_planks:1});const cp=f.state.checkpoint;
 const former=clone(cp.storage),position=former.chests[0].position;
 cp.retiredCamps=[{camp:{...clone(cp.camp),anchor:{...cp.camp.anchor,x:cp.camp.anchor.x+20}},storage:former,ownedStations:{}}];cp.storage=null;
 await f.run(()=>f.source.ensureStorage());
 assert.notDeepEqual(f.state.checkpoint.storage.chests[0].position,position);
 assert.equal(f.bot.blockAt(new Vec3(position.x,position.y,position.z)).name,'chest');
 assert.ok(f.state.checkpoint.storage.exclusionBounds.some(b=>position.x>=b.minX&&position.x<=b.maxX&&position.z>=b.minZ&&position.z<=b.maxZ));
});

test('wood obtained beside an intact owned outpost reopens its actual chest before duplicating camp facilities',{timeout:15000},async t=>{
 const options={},f=fixture(t,options);await f.source.run({oak_planks:1});
 const cp=f.state.checkpoint,old=clone(cp),placed=f.calls.filter(c=>c.kind==='place').length;
 cp.retiredCamps=[old];cp.camp={...cp.camp,anchor:{...cp.camp.anchor,x:cp.camp.anchor.x+40}};cp.ownedStations={};cp.storage=null;
 options.fieldRecovery=true;options.nearbyOwnedCamp=old;
 await f.source.run({cobblestone:4});
 assert.ok(f.calls.some(c=>c.kind==='nearbyOwnedRestored'));assert.deepEqual(f.state.checkpoint.camp.anchor,old.camp.anchor);
 assert.equal(f.calls.filter(c=>c.kind==='place').length,placed);assert.equal(f.stock('cobblestone'),4);
 assert.ok(f.state.checkpoint.storage.chests[0].emptyAuthorized);
});

test('nearby earlier owned chest is reopened and its actual stock reused without adopting or placing another camp',{timeout:15000},async t=>{
 const f=fixture(t);f.bot.game.dimension='overworld';await f.source.run({cobblestone:12});await f.run(()=>f.source.storage.stash({cobblestone:0}));
 const cp=f.state.checkpoint,old=clone(cp),position=old.storage.chests[0].position;
 cp.retiredCamps=[old];cp.storage=null;
 const placements=f.calls.filter(c=>c.kind==='place').length;
 await f.run(()=>f.source.takeOwnedStock({cobblestone:8}));
 assert.equal(f.stock('cobblestone'),8);assert.equal(f.state.checkpoint.storage,null);
 assert.equal(f.state.checkpoint.retiredCamps.at(-1).storage.chests[0].stock.cobblestone,4);
 assert.equal(f.calls.filter(c=>c.kind==='place').length,placements);assert.equal(f.bot.blockAt(new Vec3(position.x,position.y,position.z)).name,'chest');
 assert.ok(f.isCamp());
});

for(const mode of ['changed_contents','unloaded'])test(`earlier owned-stock reuse refuses unavailable or mismatched real chest evidence: ${mode}`,{timeout:15000},async t=>{
 const f=fixture(t);f.bot.game.dimension='overworld';await f.source.run({cobblestone:12});await f.run(()=>f.source.storage.stash({cobblestone:0}));
 const cp=f.state.checkpoint,old=clone(cp),position=old.storage.chests[0].position;cp.retiredCamps=[old];cp.storage=null;
 if(mode==='changed_contents'){
  const stored=f.containers.get(`${position.x},${position.y},${position.z}`);stored[0]=new Item(registry.itemsByName.stick.id,1);
  await assert.rejects(f.run(()=>f.source.takeOwnedStock({cobblestone:8})),{code:'house_storage_foreign_contents'});
 }else{
  const blockAt=f.bot.blockAt;f.bot.blockAt=p=>p.x===position.x&&p.y===position.y&&p.z===position.z?null:blockAt(p);
  await f.run(()=>f.source.takeOwnedStock({cobblestone:8}));
 }
 assert.equal(f.stock('cobblestone'),0);assert.equal(f.state.checkpoint.storage,null);
});

test('critical local tool preparation passes its existing anchor, archives camp and confirms native wooden tools',{timeout:20000},async t=>{
 const f=fixture(t,{survivalTools:true,withCampWork:false});
 const result=await f.source.withContext(()=>f.source.prepareSurvivalTools());
 assert.equal(result,true);
 assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_sword'&&i.count===1));
 assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_pickaxe'&&i.count===1));
 assert.equal(f.state.checkpoint.retiredCamps.at(-1).reason,'local_survival_tools_before_food_search');
 assert.deepEqual(f.state.checkpoint.retiredCamps.at(-1).camp.anchor,camp.anchor);
 assert.ok(f.state.checkpoint.ownedStations.crafting_table);
 assert.equal(f.calls.some(c=>c.kind==='place'&&['furnace','chest'].includes(c.name)),false);
});

test('critical survivor reuses an intact owned workshop and actual planks before another tree or outpost',{timeout:20000},async t=>{
 const f=fixture(t,{allowSurvivalTools:true});
 await f.source.run({oak_planks:20});
 const before=f.calls.filter(c=>c.kind==='bootstrap').length;
 const result=await f.source.withContext(()=>f.source.prepareSurvivalTools());
 assert.equal(result,true);assert.equal(f.calls.filter(c=>c.kind==='bootstrap').length,before);
 assert.equal(f.state.checkpoint.retiredCamps?.length||0,0);
 assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_sword'));
 assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_pickaxe'));
});

test('a proven workshop route failure switches to actual local tools and retains the old stock archive',{timeout:20000},async t=>{
 const f=fixture(t,{allowSurvivalTools:true});await f.source.run({oak_planks:20});
 f.deps.relocateDestroyedCamp=async()=>({anchor:{x:-19,y:64,z:0},stations:{crafting_table:{x:-17,y:64,z:0},furnace:{x:-19,y:64,z:2}},storageSites:[{x:-22,y:64,z:0}]});
 const oldCamp=JSON.parse(JSON.stringify(f.state.checkpoint.camp));
 const before=f.calls.filter(c=>c.kind==='bootstrap').length;
 f.deps.withCampWork=async()=>{delete f.deps.withCampWork;throw Object.assign(Error('old camp is across an unreachable river'),{code:'house_surface_dry_graph_rejoin_unconfirmed'});};
 const result=await f.source.withContext(()=>f.source.prepareSurvivalTools());
 assert.equal(result,true);assert.equal(f.calls.filter(c=>c.kind==='bootstrap').length,before+1);
 assert.deepEqual(f.state.checkpoint.retiredCamps.at(-1).camp,oldCamp);
 assert.equal(f.state.checkpoint.survivalWorkshopFailure.code,'house_surface_dry_graph_rejoin_unconfirmed');
 assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_sword'));
});

test('small carried plank deficit attempts bounded field work before camp return and propagates failure without success credit',async t=>{
 const f=fixture(t);let invoked=false;
 f.deps.prepareFieldPlanks=async(target,bounds)=>{invoked=true;assert.equal(target,1);assert.ok(bounds.length>0);throw Object.assign(Error('no reachable local wood'),{code:'fixture_local_wood_unavailable'});};
 await assert.rejects(f.source.run({oak_planks:1}),{code:'fixture_local_wood_unavailable'});
 assert.equal(invoked,true);assert.equal(f.moves.length,0);assert.equal(f.stock('oak_planks'),0);
});

test('raw wool resolves owned reuse before invoking a new natural wool hunt',async t=>{
 const f=fixture(t);let visited=false;
 f.deps.restorePriorCamp=async(_state,request)=>{if(request.woolReuse){visited=true;throw Object.assign(Error('owned wool visit requested'),{code:'fixture_owned_wool_visit'});}return null;};
 await assert.rejects(f.source.run({white_wool:3}),{code:'fixture_owned_wool_visit'});
 assert.equal(visited,true);assert.ok(!f.calls.some(c=>c.kind==='raw'&&c.name==='white_wool'));
});

test('bed preparation with real carried colored wool visits matching owned stock before returning to the old camp',async t=>{
 const f=fixture(t);const item=new Item(registry.itemsByName.black_wool.id,1);
 f.bot._client.emit('set_slot',{windowId:0,stateId:1,slot:9,item:Item.toNotch(item)});
 assert.equal(f.stock('black_wool'),1);let selected=false;
 f.deps.restorePriorCamp=async(_state,request)=>{assert.equal(request.woolReuse,true);selected=true;throw Object.assign(Error('direct wool stock route'),{code:'fixture_direct_wool_stock'});};
 await assert.rejects(f.source.run({white_bed:1}),{code:'fixture_direct_wool_stock'});
 assert.equal(selected,true);assert.equal(f.moves.length,0);
});

test('mandatory final equipment check cannot be bypassed by an empty already-satisfied material request',async t=>{
 const f=fixture(t);await f.source.run({oak_planks:20});let checks=0;
 f.deps.prepareDefense=async()=>{checks++;throw Object.assign(Error('actual kit missing'),{code:'house_defense_equipment_missing'});};
 assert.equal((await f.source.run({})).confirmed,true);assert.equal(checks,0);
 await assert.rejects(f.source.run({},{requireFullEquipment:true}),{code:'house_defense_equipment_missing'});
 assert.equal(checks,1);
});

test('destroyed owned furnace changes only its local site when crater support is unsafe',{timeout:20000},async t=>{
 const f=fixture(t);await f.source.run({oak_planks:1});
 const cp=f.state.checkpoint,old=clone(cp.camp.stations.furnace),anchorBefore=clone(cp.camp.anchor);
 cp.quarry={schema:1,sentinel:'retain-real-mine'};const storageBefore=clone(cp.storage);
 for(let dy=0;dy<=5;dy++)f.put({...old,y:old.y-dy},'air');
 await f.run(()=>f.source.ensureStation('furnace'));
 const after=f.state.checkpoint,newSite=after.camp.stations.furnace;
 assert.notDeepEqual(newSite,old);assert.equal(f.bot.blockAt(new Vec3(newSite.x,newSite.y,newSite.z)).name,'furnace');
 assert.deepEqual(after.camp.anchor,anchorBefore);assert.deepEqual(after.quarry,{schema:1,sentinel:'retain-real-mine'});
 assert.deepEqual(after.storage,storageBefore);assert.equal(after.retiredStations.at(-1).reason,'missing_station_unsafe_foundation');
 assert.equal(f.bot.blockAt(new Vec3(old.x,old.y-1,old.z)).name,'air','Crater is preserved instead of invented support credit');
});

test('ordinary owned storage keeps real mining byproducts for combat instead of stashing every building block',{timeout:15000},async t=>{
 const f=fixture(t);await f.source.run({cobblestone:40});
 await f.run(()=>f.source.stash({}));
 assert.equal(f.stock('cobblestone'),32);assert.equal(f.source.storage.getStock().cobblestone,8);
});

test('legacy archived worn-tool counts are inspected but cannot block fresh equipment acquisition',{timeout:15000},async t=>{
 const f=fixture(t);f.bot.game.dimension='overworld';await f.source.run({stone_pickaxe:1});
 const slot=f.serverPlayer.findIndex(i=>i?.name==='stone_pickaxe'),raw=Item.toNotch(f.serverPlayer[slot]);
 raw.components=[{type:'damage',data:125}];raw.addedComponentCount=1;f.serverPlayer[slot]=Item.fromNotch(raw);
 f.bot._client.emit('set_slot',{windowId:0,stateId:0,slot,item:raw});
 await f.run(()=>f.source.storage.stashUnusableEquipment());
 const cp=f.state.checkpoint,old=clone(cp);for(const c of old.storage.chests)delete c.usableStock;
 cp.retiredCamps=[old];cp.storage=null;
 await f.run(()=>f.source.takeOwnedStock({stone_pickaxe:1}));
 assert.equal(f.stock('stone_pickaxe'),0);assert.equal(f.state.checkpoint.storage,null);
 assert.equal(f.state.checkpoint.retiredCamps.at(-1).storage.chests.reduce((n,c)=>n+(c.stock.stone_pickaxe||0),0),1);
});

test('thin snow at prospective furnace and storage slots is actually cleared before strict native placement',async t=>{
 const f=fixture(t,{furnaceTerrain:'snow'});for(const p of camp.storageSites)f.put(p,'snow');
 await f.source.run({oak_planks:1});assert.equal(f.state.checkpoint.ownedStations.furnace.confirmedPlaced,true);
 assert.equal(f.calls.filter(c=>c.kind==='clearVegetation'&&c.name==='snow').length,camp.storageSites.length+1);
 assert.ok(f.state.checkpoint.storage.chests.length>=1);
 for(const p of camp.storageSites)assert.ok(['air','chest'].includes(f.bot.blockAt(new Vec3(p.x,p.y,p.z)).name));
});

test('two-log survival bootstrap crafts and hands off its sword before fetching pickaxe wood',{timeout:20000},async t=>{
 const f=fixture(t,{survivalTools:true,withCampWork:false,bootstrapLogs:2,requireSwordBeforeNewLogs:true});
 f.deps.equipSurvivalWeapon=async()=>{assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_sword'));f.calls.push({kind:'survivalWeaponEquipped'});};
 assert.equal(await f.source.withContext(()=>f.source.prepareSurvivalTools()),true);
 const equipped=f.calls.findIndex(c=>c.kind==='survivalWeaponEquipped'),raw=f.calls.findIndex(c=>c.kind==='raw'&&c.name.endsWith('_log'));
 assert.ok(equipped>=0);assert.ok(raw>equipped);assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_pickaxe'));
});

test('world134 cleanup tools skip distant loaded workshop and preserve pending owned cover',{timeout:20000},async t=>{
 const f=fixture(t,{allowSurvivalTools:true});await f.source.run({oak_planks:20});
 f.state.checkpoint.ownedStations.crafting_table.position={x:100,y:64,z:0};f.put({x:100,y:64,z:0},'crafting_table');
 const cover={item:'oak_planks',position:{x:150,y:64,z:0}};f.state.checkpoint.defensiveCoverBlocks=[cover];
 const before=f.calls.filter(c=>c.kind==='bootstrap').length,work=f.deps.withCampWork;
 f.deps.withCampWork=async action=>{if(f.calls.filter(c=>c.kind==='bootstrap').length===before)throw Object.assign(Error('distant workshop visited before local weapon'),{code:'fixture_remote_workshop'});return work(action);};
 f.deps.relocateDestroyedCamp=async()=>({anchor:{x:-19,y:64,z:0},stations:{crafting_table:{x:-17,y:64,z:0},furnace:{x:-19,y:64,z:2}},storageSites:[{x:-22,y:64,z:0}]});
 const bootstrap=f.deps.bootstrapWood;f.deps.bootstrapWood=async options=>{assert.ok(options.deadline-Date.now()>500000);assert.ok(options.deadline-Date.now()<=600000);return bootstrap(options);};
 assert.equal(await f.source.withContext(()=>f.source.prepareSurvivalTools({localWorkshopOnly:true,deadline:Date.now()+600000})),true);
 assert.ok(f.bot.inventory.items().some(i=>i.name==='wooden_sword'));
 assert.equal(f.calls.filter(c=>c.kind==='bootstrap').length,before+1);assert.deepEqual(f.state.checkpoint.defensiveCoverBlocks,[cover]);
 assert.equal(f.moves.some(p=>p.x>50),false);
});
