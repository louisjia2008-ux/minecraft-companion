/* global module, setTimeout */
'use strict';

const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });

function planEstateMaterialBatch(specs, { maxBlocks = 96, maxStacks = 12, stackSize = () => 64 } = {}) {
  const blocks = [];
  const requirements = {};
  for (const spec of specs) {
    if (spec.derived) continue;
    const next = { ...requirements, [spec.item]: (requirements[spec.item] || 0) + 1 };
    const stacks = Object.entries(next).reduce((sum, [name, count]) => sum + Math.ceil(count / Math.max(1, stackSize(name))), 0);
    if (blocks.length >= maxBlocks || stacks > maxStacks) break;
    requirements[spec.item] = next[spec.item];
    blocks.push(spec);
  }
  if (!blocks.length && specs.some((spec) => !spec.derived)) throw failure('estate_invalid_batch', '建造批次无法放入有限背包预算');
  return { blocks, requirements };
}

function createEstateMaterialSupply(deps) {
  const assertActive = () => deps.assertActive();
  const count = (name) => deps.getBot().inventory.items().filter((item) => item.name === name)
    .reduce((sum, item) => sum + item.count, 0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function confirmInventory(name, expected) {
    const deadline = Date.now() + 2500;
    while (count(name) < expected) {
      assertActive();
      if (Date.now() >= deadline) throw failure('estate_inventory_unconfirmed', `取出 ${name} 后真实背包未确认，停止重复取料`);
      await sleep(50);
    }
    assertActive();
  }
  function capacityFor(name) {
    const bot = deps.getBot();
    const stack = Math.max(1, bot.registry.itemsByName[name]?.stackSize || 64);
    const slots = bot.inventory.slots;
    const start = Number.isInteger(bot.inventory.inventoryStart) ? bot.inventory.inventoryStart : 9;
    const end = Number.isInteger(bot.inventory.inventoryEnd) ? bot.inventory.inventoryEnd : 45;
    let capacity = 0;
    for (let index = start; index < end; index += 1) {
      const item = slots[index];
      if (!item) capacity += stack;
      else if (item.name === name) capacity += Math.max(0, stack - item.count);
    }
    return capacity;
  }
  async function ensure(requirements, depots = []) {
    assertActive();
    if (!Array.isArray(depots) || depots.length > 8 || depots.some((p) => !['x', 'y', 'z'].every((axis) => Number.isInteger(p?.[axis])))) {
      throw failure('estate_invalid_depot', '补给箱必须是明确且有限的整数坐标列表');
    }
    for (const [name, required] of Object.entries(requirements)) {
      assertActive();
      if (!Number.isInteger(required) || required < 0 || required > 4096 || !deps.getBot().registry.itemsByName[name]) {
        throw failure('estate_invalid_material', `无效建材预算：${name}`);
      }
      for (const position of depots) {
        if (count(name) >= required) break;
        assertActive();
        if (deps.isDepotAllowed?.(position) !== true) throw failure('estate_invalid_depot', '补给箱位于建筑、农田或未授权区域，不能使用');
        await deps.reachDepot(position);
        assertActive();
        let window;
        try {
          window = await deps.openDepot(position);
          assertActive();
          const available = window.containerItems().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
          const before = count(name);
          const take = Math.min(required - before, available, capacityFor(name));
          if (take <= 0) {
            if (available > 0) throw failure('estate_inventory_full', `背包无法容纳当前批次 ${name}，请腾出空间后恢复`);
            continue;
          }
          deps.report?.(`从指定补给箱取 ${name} ×${take}`);
          assertActive();
          await window.withdraw(deps.getBot().registry.itemsByName[name].id, null, take);
          assertActive();
          window.close();
          window = null;
          await confirmInventory(name, before + take);
        } finally {
          if (window) deps.closeDepot ? deps.closeDepot(window) : window.close();
        }
      }
    }
    const missingMaterials = Object.entries(requirements).filter(([name, required]) => count(name) < required)
      .map(([item, required]) => ({ item, required, available: count(item), missing: required - count(item) }));
    if (missingMaterials.length) throw failure('house_materials_missing',
      `当前建造批次缺料：${missingMaterials.map((item) => `${item.item} 缺 ${item.missing}`).join('，')}。请补充背包或已指定的补给箱后恢复。`, { missingMaterials });
    return { confirmed: true, requirements: { ...requirements } };
  }
  return { ensure, count, capacityFor };
}

module.exports = { planEstateMaterialBatch, createEstateMaterialSupply };
