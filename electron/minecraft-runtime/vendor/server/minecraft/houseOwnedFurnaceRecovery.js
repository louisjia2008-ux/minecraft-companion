/* global module, setTimeout */
'use strict';

// Reclaim actual owned furnace contents before expanding a missing recipe.
// A saved intent or callback result never counts as a material receipt.
async function recoverOwnedFurnace(deps, { position, input, output }) {
  const bot = deps.getBot(), client = bot._client;
  const active = () => {
    deps.assertActive();
    if (deps.getBot() !== bot || bot._client !== client || !deps.isOwnerCurrent(position)) {
      throw Object.assign(Error('自有熔炉恢复归属已改变'), { code: 'house_furnace_owner_changed' });
    }
  };
  const count = name => bot.inventory.items().reduce((sum, item) => sum + (item.name === name ? item.count : 0), 0);
  active();
  if (deps.blockAt(position)?.name !== 'furnace') return false;
  await deps.reach(position); active();
  const before = { [input]: count(input), [output]: count(output) };
  const furnace = await deps.openFurnace(deps.blockAt(position));
  let expectedTotal = before[input] + before[output];
  try {
    active();
    const pending = furnace.inputItem();
    const result = furnace.outputItem();
    expectedTotal += (pending?.name === input ? pending.count : 0) + (result?.name === output ? result.count : 0);
    // Remove input first: further cooking cannot race the output read. For
    // these one-to-one vanilla smelts a final tick may convert input to output;
    // require the actual combined receipt instead of predicting that split.
    if (pending?.name === input) {
      await deps.transfer(() => furnace.takeInput()); active();
    }
    if (furnace.outputItem()?.name === output) {
      await deps.transfer(() => furnace.takeOutput()); active();
    }
  } finally {
    furnace.close();
  }
  const deadline = Date.now() + 2500;
  while (true) {
    active();
    if (count(input) + count(output) >= expectedTotal) break;
    if (Date.now() >= deadline) throw Object.assign(Error('未确认熔炉内容实际进入背包'), { code: 'house_furnace_recovery_unconfirmed' });
    await (deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))))(50);
  }
  return count(input) + count(output) > before[input] + before[output];
}

module.exports = { recoverOwnedFurnace };
