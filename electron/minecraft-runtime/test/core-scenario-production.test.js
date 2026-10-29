'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installProductionEvidence, productionVerdict, transferCredit, itemCounts } = require('../scenarios/productionEvidence.cjs');

const key = (p) => `${p.x},${p.y},${p.z}`;

test('production disposal suppresses observation of a late native completion without waiting on an abandoned mutation', async () => {
  let complete;
  const events = [];
  const bot = { placeBlock() { return new Promise((resolve) => { complete = resolve; }); } };
  const ledger = installProductionEvidence({ bot, server: { query() { throw new Error('must not read after dispose'); } },
    username: 'Test', resolve: () => ({ kind: 'generator', output: { x: 0, y: 1, z: 0 }, item: 'cobblestone' }),
    write: (...args) => events.push(args) });
  const mutation = bot.placeBlock({ position: { x: 0, y: 0, z: 0 } }, { x: 0, y: 1, z: 0 });
  await ledger.dispose(); complete('native later');
  assert.equal(await mutation, 'native later'); assert.deepEqual(events, []);
});
function fixture({ smelter = false, confirmationMs = 200, pollMs = 1 } = {}) {
  const output = { x: 1, y: 64, z: 0 }, hopper = { x: 0, y: 64, z: 0 }, furnace = { x: -1, y: 64, z: 0 };
  const item = smelter ? 'iron_ingot' : 'cobblestone';
  const spec = { kind: smelter ? 'smelter' : 'generator', item, output,
    buffers: smelter ? [output, hopper, furnace] : [output, hopper], ...(smelter ? { furnace } : {}) };
  const world = { containers: { [key(hopper)]: {} }, player: { [item]: 100 }, recipes: 0, readsFail: false };
  const bot = { registry: { items: { 1: { name: item } } },
    placeBlock(reference, face) {
      assert.equal(this, bot);
      world.containers[key({ x: reference.position.x + face.x, y: reference.position.y + face.y,
        z: reference.position.z + face.z })] ||= {};
      return Promise.resolve('native placed');
    },
    openContainer(block) {
      assert.equal(this, bot);
      const window = {
        close() { world.closed = true; bot.currentWindow = null; },
        withdraw(_type, _metadata, count) {
          assert.equal(this, window);
          const transfer = () => {
            const bag = world.containers[key(block.position)];
            const amount = Math.min(count, bag[item] || 0);
            bag[item] -= amount; world.player[item] += amount;
          };
          if (world.deferTransfer) world.pendingTransfer = transfer;
          else transfer();
          return Promise.resolve('native withdrew');
        },
        deposit(_type, _metadata, count) {
          world.containers[key(block.position)][item] = (world.containers[key(block.position)][item] || 0) + count;
          world.player[item] -= count;
          return Promise.resolve('native deposited');
        },
      };
      world.lastWindow = window; bot.currentWindow = window;
      return Promise.resolve(window);
    } };
  const nativePlace = bot.placeBlock, nativeOpen = bot.openContainer;
  const server = { async query(command, pattern) {
    if (world.readsFail) throw new Error('server readback unavailable');
    let text;
    if (command.startsWith('clear ')) text = `Found ${world.player[item]} matching item(s) on player Test`;
    else if (command.endsWith(' RecipesUsed')) text = `-1, 64, 0 has the following block data: {"minecraft:iron_ingot_from_smelting_raw_iron": ${world.recipes}}`;
    else {
      const [, , , x, y, z] = command.split(' ');
      const bag = world.containers[`${x},${y},${z}`];
      text = bag ? `${x}, ${y}, ${z} has the following block data: [${Object.entries(bag).filter(([, n]) => n > 0)
        .map(([id, count]) => `{count: ${count}, Slot: 0b, id: "minecraft:${id}"}`).join(', ')}]` : 'Target is not a block entity';
    }
    // Test-only schedule: authoritative state can change after a console read
    // was evaluated, before the observer issues its next sequential read.
    if (world.afterQuery) await world.afterQuery(command);
    const match = text.match(pattern); assert.ok(match, command); return match;
  } };
  const ledger = installProductionEvidence({ bot, server, username: 'Test', confirmationMs, pollMs, resolve: (p) =>
    [output, furnace].some((q) => key(p) === key(q)) ? spec : null });
  const place = (p) => bot.placeBlock({ position: { x: p.x, y: p.y - 1, z: p.z } }, { x: 0, y: 1, z: 0 });
  return { bot, server, ledger, world, spec, item, output, furnace, place, nativePlace, nativeOpen };
}

test('disposal during an output snapshot cannot install new window wrappers after restoration', async () => {
  const f = fixture(); await f.place(f.output);
  const query = f.server.query.bind(f.server);
  let release;
  f.server.query = async (...args) => {
    if (!release) await new Promise((resolve) => { release = resolve; });
    return query(...args);
  };
  const opening = f.bot.openContainer({ position: f.output });
  await new Promise((resolve) => setImmediate(resolve));
  const window = f.world.lastWindow, withdraw = window.withdraw, deposit = window.deposit;
  const disposal = f.ledger.dispose(); release();
  assert.equal(await opening, window); await disposal;
  assert.equal(window.withdraw, withdraw); assert.equal(window.deposit, deposit);
});

test('forged memory, pre-existing player stock, empty output and an uncollected product cannot pass', async () => {
  assert.equal(productionVerdict(null, 999, 8).pass, false);
  const f = fixture(); await f.place(f.output);
  assert.equal((await f.ledger.verify(f.spec, 999, 8)).pass, false);
  f.world.containers[key(f.output)][f.item] = 8;
  assert.equal((await f.ledger.verify(f.spec, 8, 8)).pass, false, 'items must actually be taken out');
  f.ledger.dispose();
});

test('correct collector withdrawal counts server source loss and player gain, excluding old player stock', async () => {
  const f = fixture(); await f.place(f.output);
  f.world.containers[key(f.output)][f.item] = 8;
  const window = await f.bot.openContainer({ position: f.output });
  assert.equal(await window.withdraw(1, null, 8), 'native withdrew');
  const result = await f.ledger.verify(f.spec, 8, 8);
  assert.equal(result.pass, true); assert.equal(result.collected, 8); assert.equal(f.world.player[f.item], 108);
  assert.equal((await f.ledger.verify(f.spec, 100, 8)).pass, false, 'memory/server disagreement fails');
  f.ledger.dispose(); assert.equal(f.bot.placeBlock, f.nativePlace); assert.equal(f.bot.openContainer, f.nativeOpen);
});

test('preloaded output, a wrong chest and deposits into the output do not impersonate production', async () => {
  const preloaded = fixture(); preloaded.world.containers[key(preloaded.output)] = { cobblestone: 8 };
  await preloaded.place(preloaded.output);
  await (await preloaded.bot.openContainer({ position: preloaded.output })).withdraw(1, null, 8);
  assert.equal((await preloaded.ledger.verify(preloaded.spec, 8, 8)).pass, false);
  preloaded.ledger.dispose();
  const wrong = fixture(); await wrong.place(wrong.output);
  const other = { x: 7, y: 64, z: 7 }; wrong.world.containers[key(other)] = { cobblestone: 8 };
  await (await wrong.bot.openContainer({ position: other })).withdraw(1, null, 8);
  assert.equal((await wrong.ledger.verify(wrong.spec, 8, 8)).pass, false); wrong.ledger.dispose();
  const deposit = fixture(); await deposit.place(deposit.output);
  const window = await deposit.bot.openContainer({ position: deposit.output });
  await window.deposit(1, null, 8); await window.withdraw(1, null, 8);
  assert.equal((await deposit.ledger.verify(deposit.spec, 8, 8)).pass, false); deposit.ledger.dispose();
});

test('smelter requires its own fresh recipe count increase and actual output withdrawal', async () => {
  const f = fixture({ smelter: true }); await f.place(f.output); await f.place(f.furnace);
  f.world.containers[key(f.output)][f.item] = 4;
  await (await f.bot.openContainer({ position: f.output })).withdraw(1, null, 4);
  assert.equal((await f.ledger.verify(f.spec, 4, 4)).pass, false, 'an output placed in a chest is not smelting');
  f.world.recipes = 4;
  assert.equal((await f.ledger.verify(f.spec, 4, 4)).pass, false, 'later production cannot legitimize earlier stock'); f.ledger.dispose();
  const actual = fixture({ smelter: true }); await actual.place(actual.output); await actual.place(actual.furnace);
  actual.world.recipes = 4; actual.world.containers[key(actual.output)][actual.item] = 4;
  await (await actual.bot.openContainer({ position: actual.output })).withdraw(1, null, 4);
  assert.equal((await actual.ledger.verify(actual.spec, 4, 4)).pass, true); actual.ledger.dispose();
  const old = fixture({ smelter: true }); old.world.recipes = 4;
  await old.place(old.output); await old.place(old.furnace);
  old.world.containers[key(old.output)][old.item] = 4;
  await (await old.bot.openContainer({ position: old.output })).withdraw(1, null, 4);
  assert.equal((await old.ledger.verify(old.spec, 4, 4)).pass, false, 'old furnace recipes are a baseline'); old.ledger.dispose();
});

test('readback failure is retained as a failing acceptance condition and native throws are preserved', async () => {
  const f = fixture(); f.world.readsFail = true;
  assert.equal(await f.place(f.output), 'native placed');
  f.world.readsFail = false;
  f.world.containers[key(f.output)][f.item] = 8;
  await (await f.bot.openContainer({ position: f.output })).withdraw(1, null, 8);
  assert.equal((await f.ledger.verify(f.spec, 8, 8)).pass, false); f.ledger.dispose();
  const error = new Error('native placement failed'); const bot = { placeBlock() { throw error; } };
  const ledger = installProductionEvidence({ bot, resolve: () => null });
  assert.throws(() => bot.placeBlock(), (caught) => caught === error); ledger.dispose();
});

test('transfer credit accounts for concurrent smelting and SNBT counts parse without changing item identity', () => {
  assert.equal(transferCredit({ player: 100, output: 5, recipes: 10 }, { player: 104, output: 3, recipes: 12 }), 4);
  assert.equal(transferCredit({ player: 100, output: 8, recipes: 0 }, { player: 200, output: 8, recipes: 0 }), 0);
  assert.deepEqual(itemCounts('[{count: 4, Slot: 0b, id: "minecraft:iron_ingot"}, {count: 8, id: "minecraft:cobblestone"}]'),
    { iron_ingot: 4, cobblestone: 8 });
});

// Controlled mechanism reproduction, not a claim about the historical packet order.
test('smelter confirms a torn first read against settled server state without losing the first of four products', async () => {
  const f = fixture({ smelter: true });
  await f.place(f.output); await f.place(f.furnace);
  for (let n = 1; n <= 4; n += 1) {
    f.world.recipes = n;
    f.world.containers[key(f.output)][f.item] = 1;
    const window = await f.bot.openContainer({ position: f.output });
    if (n === 1) {
      f.world.deferTransfer = true;
      f.world.afterQuery = (command) => {
        if (!f.world.pendingTransfer || command !== 'data get block 1 64 0 Items') return;
        // The read above captured output=1. Apply the actual server transfer
        // before the following player read, producing output=1/player=101.
        f.world.pendingTransfer();
        f.world.pendingTransfer = null; f.world.afterQuery = null;
        f.world.deferTransfer = false;
      };
    }
    assert.equal(await window.withdraw(1, null, 1), 'native withdrew');
  }
  const result = await f.ledger.verify(f.spec, 4, 4);
  assert.equal(f.world.player[f.item], 104, 'all four actual server transfers occurred');
  assert.equal(f.world.containers[key(f.output)][f.item], 0);
  assert.equal(result.produced, 4);
  assert.equal(result.collected, 4, 'first mixed snapshot must not permanently erase a real transfer');
  assert.equal(result.pass, true);
  await f.ledger.dispose();
});

async function readySmelter(options) {
  const f = fixture({ smelter: true, ...options });
  await f.place(f.output); await f.place(f.furnace);
  f.world.recipes = 4; f.world.containers[key(f.output)][f.item] = 4;
  const window = await f.bot.openContainer({ position: f.output });
  return { ...f, window };
}

test('smelter native success without transfer or with external player deposit never earns credit', async () => {
  for (const externalDeposit of [false, true]) {
    const f = await readySmelter(); f.world.deferTransfer = true;
    if (externalDeposit) f.world.player[f.item] += 4;
    assert.equal(await f.window.withdraw(1, null, 4), 'native withdrew');
    const result = await f.ledger.verify(f.spec, 4, 4);
    assert.equal(result.pass, false); assert.equal(result.collected, 0);
    assert.ok(result.evidence.errors.length, 'unconfirmed proof permanently invalidates entry');
    f.world.pendingTransfer(); f.world.deferTransfer = false;
    assert.equal((await f.ledger.verify(f.spec, 4, 4)).collected, 0, 'late actual transfer is not retroactively credited');
    await f.ledger.dispose();
  }
});

test('smelter accepts concurrent fresh production only with exact conservation', async () => {
  const f = await readySmelter();
  f.world.afterQuery = (command) => {
    if (command !== 'data get block 1 64 0 Items') return;
    f.world.afterQuery = null;
    f.world.recipes += 1; f.world.containers[key(f.output)][f.item] += 1;
  };
  await f.window.withdraw(1, null, 4);
  const result = await f.ledger.verify(f.spec, 4, 4);
  assert.equal(result.pass, true); assert.equal(result.collected, 4);
  assert.equal(result.evidence.latest.output, 1); await f.ledger.dispose();
});

test('wrong-item and retired-window mutations cannot earn smelter credit', async () => {
  const wrong = await readySmelter();
  await wrong.window.withdraw(999, null, 4);
  assert.equal((await wrong.ledger.verify(wrong.spec, 4, 4)).collected, 0); await wrong.ledger.dispose();
  const stale = await readySmelter();
  await stale.bot.openContainer({ position: stale.output });
  await stale.window.withdraw(1, null, 4);
  const result = await stale.ledger.verify(stale.spec, 4, 4);
  assert.equal(result.pass, false); assert.equal(result.collected, 0); await stale.ledger.dispose();
});

test('overlapping observed smelter mutations invalidate evidence rather than double credit', async () => {
  const f = await readySmelter();
  await Promise.all([f.window.withdraw(1, null, 2), f.window.withdraw(1, null, 2)]);
  const result = await f.ledger.verify(f.spec, 4, 4);
  assert.equal(result.pass, false); assert.equal(result.collected, 0); await f.ledger.dispose();
});

test('disposal cancels a blocked server read without waiting for abandoned query or committing credit', async () => {
  const f = await readySmelter(); let release, reads = 0;
  const query = f.server.query.bind(f.server);
  f.server.query = async (...args) => { reads += 1; await new Promise((resolve) => { release = resolve; }); return query(...args); };
  const withdrawing = f.window.withdraw(1, null, 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1); await f.ledger.dispose();
  assert.equal(await withdrawing, 'native withdrew');
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1, 'no new query after disposal');
});

test('foreign-coordinate or foreign-player console replies cannot confirm this production', async () => {
  for (const foreign of ['block', 'player']) {
    const f = await readySmelter(); const query = f.server.query.bind(f.server);
    f.server.query = async (command, pattern, ...args) => {
      if ((foreign === 'block' && command.endsWith(' Items')) || (foreign === 'player' && command.startsWith('clear '))) {
        const text = foreign === 'block' ? '99, 64, 0 has the following block data: []' : 'Found 104 matching item(s) on player Other';
        const match = text.match(pattern);
        assert.equal(match, null, 'foreign identity must not match the read request');
        throw new Error('foreign reply rejected');
      }
      return query(command, pattern, ...args);
    };
    await f.window.withdraw(1, null, 4);
    assert.equal((await f.ledger.verify(f.spec, 4, 4)).pass, false); await f.ledger.dispose();
  }
});

test('closed smelter window cannot supply a later withdrawal proof', async () => {
  const f = await readySmelter(); f.window.close();
  await f.window.withdraw(1, null, 4);
  const result = await f.ledger.verify(f.spec, 4, 4);
  assert.equal(result.pass, false); assert.equal(result.collected, 0); await f.ledger.dispose();
});

test('two stable pre-ack zero-credit samples do not finish before authoritative transfer arrives', async () => {
  const f = await readySmelter(); let outputReads = 0; f.world.deferTransfer = true;
  f.world.afterQuery = (command) => {
    if (command !== 'data get block 1 64 0 Items') return;
    outputReads += 1;
    if (outputReads !== 3) return;
    f.world.pendingTransfer(); f.world.pendingTransfer = null; f.world.afterQuery = null;
  };
  await f.window.withdraw(1, null, 4);
  const result = await f.ledger.verify(f.spec, 4, 4);
  assert.equal(result.pass, true); assert.equal(result.collected, 4);
  assert.ok(result.evidence.transfers[0].confirmations.length >= 5);
  await f.ledger.dispose();
});

test('a single qualifying sample followed by contradictory stable state never commits credit', async () => {
  const f = await readySmelter();
  f.world.afterQuery = (command) => {
    if (!command.startsWith('clear ')) return;
    f.world.afterQuery = null;
    // This query captured player104, completing one apparent qualifying sample.
    // Subsequent authoritative reads disprove it; stable-pair confirmation must fail.
    f.world.player[f.item] = 100; f.world.containers[key(f.output)][f.item] = 4;
  };
  await f.window.withdraw(1, null, 4);
  const result = await f.ledger.verify(f.spec, 4, 4);
  assert.equal(result.pass, false); assert.equal(result.collected, 0); await f.ledger.dispose();
});

test('server-forced current window loss during confirmation prevents credit', async () => {
  const f = await readySmelter();
  f.world.afterQuery = () => { f.world.afterQuery = null; f.bot.currentWindow = null; };
  await f.window.withdraw(1, null, 4);
  const result = await f.ledger.verify(f.spec, 4, 4);
  assert.equal(result.pass, false); assert.equal(result.collected, 0); await f.ledger.dispose();
});
