'use strict';
// Functional acceptance belongs to the original construction task. The host
// supplies its existing movement/physical-action capabilities, never a new actor.
const INPUTS = Object.freeze({ oak_planks: 5, stick: 2, sand: 1 });
const fail = (code, message) => Object.assign(new Error(message), { code });
const counts = items => items.filter(Boolean).reduce((out, item) => {
  out[item.name] = (out[item.name] || 0) + item.count; return out;
}, {});
async function verifyHouseFurnitureUse(host, blueprint) {
  const bot = host.getBot(), client = bot._client, frames = [], facts = {};
  const deadline = host.now() + 1500000;
  let closed = false, sequence = 0;
  const active = () => {
    host.assertIdentity();
    if (closed || host.now() >= deadline) throw fail('house_furniture_use_timeout', '家具实际使用达到原任务有限时限');
  };
  const onWindow = packet => { frames.push({ sequence: ++sequence, packet }); if (frames.length > 128) frames.shift(); };
  client.on('window_items', onWindow);
  const boundary = async () => { active(); await host.ready(); active(); host.assertOwner(); };
  const wait = async (predicate, label, ms = 10000) => {
    const until = Math.min(deadline, host.now() + ms);
    while (true) {
      await boundary(); if (predicate()) return;
      if (host.now() >= until) throw fail('house_furniture_readback_timeout', label);
      await host.sleep(50);
    }
  };
  const native = async (name, operation) => {
    await boundary(); active();
    // The host guard also checks immediately before every native mutation.
    const result = await host.native(name, operation, active);
    await boundary(); return result;
  };
  const at = p => bot.blockAt(host.vec(p));
  const record = (name, evidence) => { active(); facts[name] = { confirmed: true, ...evidence }; host.record(name, facts[name]); };
  const door = blueprint.furniture.door;
  const setDoor = async open => {
    await host.move(door.lower, 2); await boundary();
    if (at(door.lower)?.getProperties().open !== open) await native('door', () => bot.activateBlock(at(door.lower)));
    await wait(() => [door.lower, door.upper].every(p => at(p)?.getProperties().open === open), '门的双格实际状态未确认');
  };
  const enter = async () => { await setDoor(true); await host.move(blueprint.entrance.inside); await boundary(); };
  const fresh = async (p, method) => {
    await host.reach(p); await boundary();
    const from = sequence, window = await native(method, () => bot[method](at(p)));
    await wait(() => frames.some(frame => frame.sequence > from && frame.packet.windowId === window.id), '容器缺少新的服务器库存帧', 5000);
    const packet = frames.filter(frame => frame.sequence > from && frame.packet.windowId === window.id).at(-1).packet;
    const slots = packet.items.map(host.decodeItem);
    return { window, player: counts(slots.slice(window.inventoryStart, window.inventoryEnd)), container: counts(slots.slice(0, window.inventoryStart)) };
  };
  const close = window => native('closeWindow', () => window.close());
  const player = async () => { const read = await fresh(blueprint.furniture.chest, 'openContainer'); await close(read.window); return read.player; };
  try {
    await boundary(); await host.ensure(INPUTS); await boundary();
    await enter(); await host.move(blueprint.entrance.outside); await host.move(blueprint.entrance.inside); await boundary();
    record('routes', { actual: host.position(), originalTaskId: host.taskId });
    const table = blueprint.furniture.craftingTable, beforeCraft = await player();
    await host.reach(table); await boundary();
    const recipe = bot.recipesFor(bot.registry.itemsByName.wooden_pickaxe.id, null, 1, at(table)).find(r => r.requiresTable);
    if (!recipe) throw fail('house_furniture_recipe_unavailable', '实际工作台合成配方不可用');
    await native('craft', () => host.craft(recipe, at(table))); const afterCraft = await player();
    if (afterCraft.wooden_pickaxe !== (beforeCraft.wooden_pickaxe || 0) + 1 || (afterCraft.oak_planks || 0) !== beforeCraft.oak_planks - 3 || (afterCraft.stick || 0) !== beforeCraft.stick - 2)
      throw fail('house_furniture_craft_unconfirmed', '服务器库存未确认工作台合成的消耗和产物');
    record('crafting', { before: beforeCraft, after: afterCraft, requiresTable: true });
    const chest = blueprint.furniture.chest;
    let read = await fresh(chest, 'openContainer'), basePlayer = read.player.oak_planks || 0, baseStock = read.container.oak_planks || 0;
    if (basePlayer < 1) throw fail('house_furniture_marker_missing', '缺少自行取得的箱子往返材料');
    await native('deposit', () => read.window.deposit(bot.registry.itemsByName.oak_planks.id, null, 1)); await close(read.window);
    read = await fresh(chest, 'openContainer');
    if ((read.container.oak_planks || 0) !== baseStock + 1 || (read.player.oak_planks || 0) !== basePlayer - 1) throw fail('house_furniture_deposit_unconfirmed', '服务器未确认箱子存入');
    await native('withdraw', () => read.window.withdraw(bot.registry.itemsByName.oak_planks.id, null, 1)); await close(read.window);
    read = await fresh(chest, 'openContainer');
    if ((read.container.oak_planks || 0) !== baseStock || (read.player.oak_planks || 0) !== basePlayer) throw fail('house_furniture_withdraw_unconfirmed', '服务器未确认箱子取回');
    await close(read.window); record('chest', { beforePlayer: basePlayer, afterPlayer: read.player.oak_planks, beforeStock: baseStock, afterStock: read.container.oak_planks || 0 });
    const furnace = blueprint.furniture.furnace;
    read = await fresh(furnace, 'openFurnace'); let window = read.window; const beforeSmelt = read.player;
    if (window.inputItem() || window.outputItem() || !beforeSmelt.sand || !beforeSmelt.oak_planks) throw fail('house_furniture_furnace_not_empty', '家具熔炉或自行取得的加工原料状态不符');
    await native('putInput', () => window.putInput(bot.registry.itemsByName.sand.id, null, 1));
    await native('putFuel', () => window.putFuel(bot.registry.itemsByName.oak_planks.id, null, 1));
    await wait(() => window.outputItem()?.name === 'glass', '熔炉没有实际烧出玻璃', 30000);
    await native('takeOutput', () => window.takeOutput()); await close(window);
    read = await fresh(furnace, 'openFurnace'); window = read.window;
    if (window.outputItem() || read.player.glass !== (beforeSmelt.glass || 0) + 1 || (read.player.sand || 0) !== beforeSmelt.sand - 1 || (read.player.oak_planks || 0) !== beforeSmelt.oak_planks - 1)
      throw fail('house_furniture_smelt_unconfirmed', '服务器库存未确认熔炉投料烧制和取出');
    await close(window);
    // A plank burns for longer than one glass recipe. Read the actual vanilla
    // burnout before final structure verification requires the unlit blueprint.
    await wait(() => at(furnace)?.getProperties().lit === false, '熔炉剩余燃料尚未实际烧尽', 20000);
    record('furnace', { before: beforeSmelt, after: read.player, output: { name: 'glass', count: 1 }, extinguished: true });
    // Stay inside the completed, lit house during the normal daylight wait.
    await setDoor(false); await host.move(blueprint.entrance.inside); await boundary();
    while (!(bot.time.timeOfDay >= 12542 && bot.time.timeOfDay <= 23460)) {
      await host.maintain(); await boundary(); host.heartbeat?.(); await host.sleep(500);
    }
    await host.reach(blueprint.furniture.bed.foot); await boundary();
    let slept = false, woke = false; const onSleep = () => { slept = true; }, onWake = () => { woke = true; };
    bot.on('sleep', onSleep); bot.on('wake', onWake);
    try {
      const sleepDeadline = Math.min(deadline, host.now() + 180000);
      for (;;) {
        try { await native('sleep', () => bot.sleep(at(blueprint.furniture.bed.foot))); break; }
        catch (error) {
          // A nearby mob/death animation is a fresh native refusal, not a
          // failed recipe or permission to credit sleep. Let normal survival
          // and actual mob movement settle, then ask the original native API.
          if (!/there are monsters nearby/i.test(error.message || '')) throw error;
          await boundary();
          if (host.now() >= sleepDeadline) throw error;
          await host.maintain(); await boundary(); host.heartbeat?.(); await host.sleep(500);
        }
      }
      await wait(() => slept && bot.isSleeping === true, '床缺少实际睡眠事件', 3000);
      const occupied = [blueprint.furniture.bed.foot, blueprint.furniture.bed.head].map(p => at(p)?.getProperties());
      if (!occupied.some(p => p?.occupied === true)) throw fail('house_furniture_bed_unconfirmed', '床缺少服务器占用状态');
      await native('wake', () => bot.wake()); await wait(() => woke && bot.isSleeping === false, '床缺少实际醒来事件', 8000);
      record('bed', { slept, woke, occupied });
    } finally { bot.off('sleep', onSleep); bot.off('wake', onWake); }
    await setDoor(true); await host.move(blueprint.entrance.outside); await setDoor(false); await boundary();
    record('door', { traversed: true, closed: [door.lower, door.upper].every(p => at(p)?.getProperties().open === false), actual: host.position() });
    const required = ['routes', 'crafting', 'chest', 'furnace', 'bed', 'door'];
    return { schema: 1, confirmed: required.every(name => facts[name]?.confirmed === true), originalTaskId: host.taskId, required, checks: facts, proof: 'Original public construction task; real native operations and fresh raw server inventory frames; no verification actor' };
  } finally { closed = true; client.off('window_items', onWindow); }
}
module.exports = { verifyHouseFurnitureUse, INPUTS };
