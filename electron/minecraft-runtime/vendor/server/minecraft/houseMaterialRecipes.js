/* global module, setTimeout, clearTimeout */
'use strict';

// A recipe planner and bounded native-action coordinator. The planner's ledger
// describes costs only. Execution always re-reads the injected real inventory.
// Native hooks must be task-owned and bounded. An additional callback deadline
// is installed only when onOperationTimeout synchronously aborts that captured
// owner's token; racing a still-authorized callback is never a safe timeout.
const DEFAULT_RAW = Object.freeze(['oak_log', 'cobblestone', 'sand', 'dirt', 'coal',
  'white_wool', 'leather', 'sugar_cane', 'obsidian', 'diamond', 'raw_iron', 'wheat_seeds', 'water_bucket']);
const DEFAULT_SMELTS = Object.freeze({ glass: 'sand', iron_ingot: 'raw_iron', charcoal: 'oak_log' });
const failure = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const copyCounts = counts => Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, count]));

function positive(value, fallback, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw failure('house_materials_invalid_limit', '材料批次限制必须是有限正整数');
  return result;
}

function planHouseMaterialBatch(specs, { maxBlocks = 96, maxStacks = 12, stackSize = () => 64 } = {}) {
  maxBlocks = positive(maxBlocks, 96, 96); maxStacks = positive(maxStacks, 12, 12);
  if (!Array.isArray(specs)) throw failure('house_materials_invalid_batch', '材料批次必须是蓝图方块数组');
  const blocks = []; const requirements = {};
  for (const spec of specs) {
    if (!spec || typeof spec !== 'object') throw failure('house_materials_invalid_batch', '材料批次包含无效蓝图格');
    if (spec.derived) continue;
    if (!spec.item || typeof spec.item !== 'string') throw failure('house_materials_invalid_batch', '每个实体放置格必须声明物品');
    const next = { ...requirements, [spec.item]: (requirements[spec.item] || 0) + 1 };
    const stacks = Object.entries(next).reduce((sum, [name, count]) => sum + Math.ceil(count / positive(stackSize(name), 64, 99)), 0);
    if (blocks.length >= maxBlocks || stacks > maxStacks) break;
    blocks.push(spec); requirements[spec.item] = next[spec.item];
  }
  if (!blocks.length && specs.some(spec => !spec.derived)) throw failure('house_materials_invalid_batch', '首个建造物品无法放入有限批次');
  return { blocks, requirements };
}

function createHouseMaterialRecipes(deps) {
  const registry = deps.registry;
  if (!registry?.itemsByName || !registry.items || typeof deps.recipesAll !== 'function' || typeof deps.getItemCount !== 'function') {
    throw failure('house_materials_dependency_missing', '材料配方需要真实registry、recipesAll与库存读取');
  }
  const limits = {
    maxDepth: positive(deps.limits?.maxDepth, 12, 24),
    maxOperations: positive(deps.limits?.maxOperations, 512, 4096),
    maxPasses: positive(deps.limits?.maxPasses, 4, 8),
    maxRawBatch: positive(deps.limits?.maxRawBatch, 64, 64),
    maxIngredientCount: positive(deps.limits?.maxIngredientCount, 64, 64),
    maxCraftOutputs: positive(deps.limits?.maxCraftOutputs, 96, 96),
    maxStacks: positive(deps.limits?.maxStacks, 12, 12),
    operationTimeoutMs: positive(deps.limits?.operationTimeoutMs, 600000, 7200000),
  };
  const readbackMs = positive(deps.readbackMs, 2500, 30000);
  const pollMs = positive(deps.pollMs, 50, 1000);
  const raw = new Set(deps.rawItems || DEFAULT_RAW);
  const smelts = { ...DEFAULT_SMELTS, ...(deps.smelts || {}) };
  const wait = deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const active = () => deps.assertActive?.();
  const item = name => {
    const value = registry.itemsByName[name];
    if (!value) throw failure('house_materials_unknown_item', `未知材料：${name}`);
    return value;
  };
  const count = name => {
    const value = deps.getItemCount(name);
    if (!Number.isSafeInteger(value) || value < 0) throw failure('house_materials_inventory_invalid', `实际库存读取无效：${name}`);
    return value;
  };
  const requirementsOf = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('house_materials_invalid_budget', '材料预算必须是物品数量对象');
    const result = {};
    for (const [name, amount] of Object.entries(input)) {
      item(name);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 4096) throw failure('house_materials_invalid_budget', `材料预算超限：${name}`);
      if (amount) result[name] = amount;
    }
    return result;
  };
  const snapshot = supplied => {
    if (supplied !== undefined) return requirementsOf(supplied);
    return Object.fromEntries(Object.keys(registry.itemsByName).map(name => [name, count(name)]).filter(([, n]) => n));
  };
  function inputsFor(recipe, repetitions = 1) {
    const inputs = {};
    if (!Array.isArray(recipe?.delta) || !Number.isSafeInteger(recipe.result?.count) || recipe.result.count < 1) throw failure('house_materials_invalid_recipe', '原生配方没有有效输入和产出');
    for (const entry of recipe.delta) if (entry.count < 0) {
      const name = registry.items[entry.id]?.name;
      if (!name || !Number.isSafeInteger(entry.count)) throw failure('house_materials_invalid_recipe', '原生配方包含未知输入');
      inputs[name] = (inputs[name] || 0) - entry.count * repetitions;
    }
    if (!Object.keys(inputs).length) throw failure('house_materials_invalid_recipe', '不能执行没有材料消耗的配方');
    return inputs;
  }
  const allRecipes = name => deps.recipesAll(item(name).id, null, true) || [];
  const recipeKey = recipe => JSON.stringify(Object.entries(inputsFor(recipe)).sort(([a], [b]) => a.localeCompare(b)));
  const weight = name => {
    const custom = deps.rawCost?.(name);
    if (custom !== undefined) {
      if (!Number.isFinite(custom) || custom < 0) throw failure('house_materials_invalid_raw_cost', `自然材料成本无效：${name}`);
      return custom;
    }
    return ['oak_log', 'cobblestone', 'sand', 'dirt', 'coal'].includes(name) ? 1 : 100;
  };
  function costItem(name, needed, ledger, stack) {
    const used = Math.min(ledger[name] || 0, needed); ledger[name] = (ledger[name] || 0) - used;
    const missing = needed - used;
    if (!missing) return 0;
    if (raw.has(name)) return missing * weight(name);
    if (stack.includes(name) || stack.length >= limits.maxDepth) return Infinity;
    if (smelts[name]) return costItem(smelts[name], missing, ledger, [...stack, name]) + missing * 0.01;
    const candidate = select(name, missing, ledger, stack);
    if (!candidate) return Infinity;
    const repetitions = Math.ceil(missing / candidate.result.count);
    let total = 0;
    for (const [ingredient, amount] of Object.entries(inputsFor(candidate, repetitions))) total += costItem(ingredient, amount, ledger, [...stack, name]);
    ledger[name] = (ledger[name] || 0) + repetitions * candidate.result.count - missing;
    return total;
  }
  function costOf(recipe, repetitions, ledger, stack = []) {
    let cost = 0;
    for (const [name, amount] of Object.entries(inputsFor(recipe, repetitions))) cost += costItem(name, amount, ledger, stack);
    return cost;
  }
  function select(name, needed, counts, stack = []) {
    const candidates = allRecipes(name).map(recipe => {
      const repetitions = Math.ceil(needed / recipe.result.count);
      return { recipe, cost: costOf(recipe, repetitions, copyCounts(counts), [...stack, name]), key: recipeKey(recipe) };
    }).filter(candidate => Number.isFinite(candidate.cost));
    candidates.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key));
    return candidates[0]?.recipe || null;
  }
  function recipeCost(recipe, repetitions = 1, options = {}) {
    positive(repetitions, 1, 4096);
    return costOf(recipe, repetitions, snapshot(options.inventoryCounts));
  }
  function selectRecipe(name, amount = 1, options = {}) {
    positive(amount, 1, 4096); item(name);
    return select(name, amount, snapshot(options.inventoryCounts));
  }
  function recipeBatchRepetitions(recipe, wanted) {
    const singleInputs = inputsFor(recipe);
    let repetitions = Math.min(wanted, Math.floor(limits.maxCraftOutputs / recipe.result.count));
    for (const needed of Object.values(singleInputs)) repetitions = Math.min(repetitions, Math.floor(limits.maxIngredientCount / needed));
    while (repetitions > 0 && Object.entries(inputsFor(recipe, repetitions)).reduce((sum, [ingredient, amount]) =>
      sum + Math.ceil(amount / item(ingredient).stackSize), 0) > limits.maxStacks) repetitions -= 1;
    if (!repetitions) throw failure('house_materials_invalid_batch', '配方无法放入有限材料批次');
    return repetitions;
  }
  function plan(input, options = {}) {
    const requirements = requirementsOf(input); const ledger = snapshot(options.inventoryCounts);
    const rawRequirements = {}; const crafts = []; const smeltTasks = [];
    function expand(name, amount, stack = []) {
      const use = Math.min(ledger[name] || 0, amount); ledger[name] = (ledger[name] || 0) - use;
      const missing = amount - use;
      if (!missing) return;
      if (stack.includes(name) || stack.length >= limits.maxDepth) throw failure('house_materials_recipe_cycle', `材料依赖循环或过深：${[...stack, name].join(' → ')}`);
      if (raw.has(name)) { rawRequirements[name] = (rawRequirements[name] || 0) + missing; return; }
      if (smelts[name]) {
        expand(smelts[name], missing, [...stack, name]);
        for (let left = missing; left > 0; left -= 32) smeltTasks.push({ input: smelts[name], output: name, count: Math.min(32, left) });
        return;
      }
      const recipe = select(name, missing, ledger, stack);
      if (!recipe) throw failure('house_materials_unsupported', `没有可自给的原版配方或raw provider：${name}`);
      const repetitions = Math.ceil(missing / recipe.result.count);
      for (const [ingredient, amount] of Object.entries(inputsFor(recipe, repetitions))) expand(ingredient, amount, [...stack, name]);
      ledger[name] = (ledger[name] || 0) + repetitions * recipe.result.count - missing;
      for (let left = repetitions; left > 0;) {
        const batch = recipeBatchRepetitions(recipe, left);
        crafts.push({ item: name, recipe, repetitions: batch, inputs: inputsFor(recipe, batch), outputCount: batch * recipe.result.count });
        left -= batch;
      }
    }
    for (const [name, amount] of Object.entries(requirements)) expand(name, amount);
    return { requirements, rawRequirements, crafts, smelts: smeltTasks,
      surplus: Object.fromEntries(Object.entries(ledger).filter(([, n]) => n > 0)) };
  }
  async function ensure(input, recovery) {
    const requirements = requirementsOf(input);
    const budget = recovery?.budget || { operations: 0 }, recoveryDepth = recovery?.depth || 0;
    if (recoveryDepth > limits.maxDepth) throw failure('house_materials_recipe_cycle', '合成输入恢复超过原材料依赖深度上限');
    let finished = false;
    const ensureActive = () => {
      active();
      if (finished) throw failure('house_materials_aborted', '本轮材料准备已结束，不能继续旧回调动作');
    };
    const operate = async (name, callback) => {
      ensureActive();
      if (++budget.operations > limits.maxOperations) throw failure('house_materials_operation_limit', '材料准备达到本轮有限操作数');
      let timer;
      try {
        const pending = Promise.resolve().then(() => { ensureActive(); return callback(); });
        const value = typeof deps.onOperationTimeout === 'function' ? await Promise.race([pending, new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = failure('house_materials_operation_timeout', `材料原生动作超时：${name}`);
            try { deps.onOperationTimeout(error); }
            catch (abortError) { error.cause = abortError; }
            reject(error);
          }, limits.operationTimeoutMs);
        })]) : await pending;
        ensureActive(); return value;
      } finally { clearTimeout(timer); }
    };
    const confirmed = async (predicate, description, transaction = null) => {
      const deadline = Date.now() + readbackMs;
      while (true) {
        ensureActive();
        if (predicate()) return;
        if (Date.now() >= deadline) throw failure('house_materials_no_progress', `没有确认真实材料变化：${description}`,transaction?{materialTransaction:transaction()}:{});
        await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      }
    };
    async function ensureItem(name, target, stack = []) {
      ensureActive();
      if (count(name) >= target) return;
      // Consult finished owned stock before expanding its raw dependencies.
      // A provider return value is never inventory evidence. Recovery uses
      // this ensure's original operation/cancellation limits and exact target.
      if (!raw.has(name) && typeof deps.restoreOwnedItem === 'function') {
        await operate(`重取自有 ${name}`, () => deps.restoreOwnedItem(name, target, { assertActive: ensureActive }));
        if (count(name) >= target) return;
      }
      if (stack.includes(name) || stack.length >= limits.maxDepth) throw failure('house_materials_recipe_cycle', `材料依赖循环或过深：${[...stack, name].join(' → ')}`);
      while (count(name) < target) {
        ensureActive(); const before = count(name); const missing = target - before;
        deps.report?.(`正在自行准备 ${name} ${before}/${target}`);
        if (raw.has(name)) {
          if (typeof deps.acquireRaw !== 'function') throw failure('house_materials_dependency_missing', `未接入自然采集provider：${name}`);
          const amount = Math.min(missing, limits.maxRawBatch);
          await operate(name, () => deps.acquireRaw(name, amount, { targetCount: before + amount,
            assertActive: ensureActive, requirements: { ...requirements },
            ensureIngredient: (ingredient, goal) => ensureItem(ingredient, goal, [...stack, name]) }));
          await confirmed(() => count(name) >= before + amount, `${name} 自然采集 +${amount}`);
          continue;
        }
        if (smelts[name]) {
          if (typeof deps.smeltBatch !== 'function') throw failure('house_materials_dependency_missing', `未接入真实冶炼：${name}`);
          const inputName = smelts[name]; const amount = Math.min(missing, 32);
          await ensureItem(inputName, amount + (requirements[inputName] || 0), [...stack, name]);
          const beforeInput = count(inputName);
          await operate(name, () => deps.smeltBatch({ input: inputName, output: name, count: amount }, { assertActive: ensureActive }));
          await confirmed(() => count(name) >= before + amount && count(inputName) <= beforeInput - amount, `${inputName} → ${name} +${amount}`);
          continue;
        }
        const recipe = select(name, missing, snapshot(), stack);
        if (!recipe) throw failure('house_materials_unsupported', `没有可自给的原版配方：${name}`);
        const repetitions = recipeBatchRepetitions(recipe, Math.ceil(missing / recipe.result.count));
        if (typeof deps.beforeRecipe === 'function') await operate(`准备 ${name} 的原生合成设施`, () => deps.beforeRecipe(recipe,
          { item: name, requiresTable: recipe.requiresTable === true, assertActive: ensureActive }));
        const inputs = inputsFor(recipe, repetitions);
        const inputGoals = Object.fromEntries(Object.entries(inputs).map(([ingredient, amount]) =>
          [ingredient, amount + (requirements[ingredient] || 0)]));
        const prepareInputs = typeof deps.prepareCraftInputs === 'function';
        // The optional recovery hook consumes the original selected recipe's
        // finite targets; never accept a second set from a provider or script.
        if (prepareInputs) {
          for (const [ingredient, goal] of Object.entries(inputGoals)) if (!Number.isSafeInteger(goal) || goal < 1
            || goal > 4096 + limits.maxIngredientCount) throw failure('house_materials_invalid_budget', `合成输入目标超限：${ingredient}`);
          // Already coexisting inputs preserve the original no-op behavior.
          // Missing recovery targets must fit the original ensure contract.
          if (!Object.entries(inputGoals).every(([ingredient, goal]) => count(ingredient) >= goal)) requirementsOf(inputGoals);
        }
        for (const [ingredient, goal] of Object.entries(inputGoals)) await ensureItem(ingredient, goal, [...stack, name]);
        if (typeof deps.craftRecipe !== 'function') throw failure('house_materials_dependency_missing', `未接入原生合成：${name}`);
        if (prepareInputs) {
          await operate(`确认 ${name} 的原生合成输入`, () => {
            if (!Object.entries(inputGoals).every(([ingredient, goal]) => count(ingredient) >= goal)) requirementsOf(inputGoals);
            return deps.prepareCraftInputs(recipe, {
              item: name, inputs: { ...inputs }, inputGoals: { ...inputGoals }, requirements: { ...requirements }, assertActive: ensureActive,
              // Only this closed-over coordinator can supply targets/budgets.
              // A recovery never starts a fresh unbounded operation counter.
              ensureInputs: () => { ensureActive(); return ensure(inputGoals, { budget, depth: recoveryDepth + 1 }); },
            });
          });
          await confirmed(() => Object.entries(inputGoals).every(([ingredient, goal]) => count(ingredient) >= goal), `${name} 合成输入共存`);
        }
        // Preparing ingredients/stations can consume or store pre-existing
        // output (e.g. planks used as smelting fuel). Verify this exact craft
        // from its actual immediate baseline, then recheck the final target.
        if(count(name)>=target)continue;
        const beforeCraft=count(name);
        const beforeInputs = Object.fromEntries(Object.keys(inputs).map(ingredient => [ingredient, count(ingredient)]));
        const expected = recipe.result.count * repetitions;
        await operate(name, () => deps.craftRecipe(recipe, repetitions, { item: name, outputCount: expected,
          requiresTable: recipe.requiresTable === true, inputs: { ...inputs }, assertActive: ensureActive }));
        await confirmed(() => count(name) >= beforeCraft + expected && Object.entries(inputs).every(([ingredient, amount]) =>
          count(ingredient) <= beforeInputs[ingredient] - amount), `${name} 合成 +${expected}`,()=>({
            item:name,beforePlanning:before,beforeCraft,expected,actualOutput:count(name),inputs,beforeInputs,
            actualInputs:Object.fromEntries(Object.keys(inputs).map(ingredient=>[ingredient,count(ingredient)]))}));
      }
    }
    try {
      for (let pass = 0; pass < limits.maxPasses; pass += 1) {
        ensureActive();
        const before = Object.fromEntries(Object.keys(requirements).map(name => [name, count(name)]));
        for (const [name, amount] of Object.entries(requirements)) await ensureItem(name, amount);
        ensureActive();
        const actual = Object.fromEntries(Object.keys(requirements).map(name => [name, count(name)]));
        if (Object.entries(requirements).every(([name, amount]) => actual[name] >= amount)) return { confirmed: true, requirements, actual, operations: budget.operations, passes: pass + 1 };
        if (JSON.stringify(actual) === JSON.stringify(before)) throw failure('house_materials_no_progress', '材料共存检查没有真实进展');
      }
      throw failure('house_materials_no_progress', '有限材料准备后仍无法保留完整本批需求');
    } finally { finished = true; }
  }
  async function prefetchRaw(input) {
    active();
    const batch = plan(input);
    // These are additional costs from the real inventory snapshot, rather
    // than absolute inventory goals. Keep existing raw stock as well.
    const targets = Object.fromEntries(Object.entries(batch.rawRequirements)
      .map(([name, missing]) => [name, count(name) + missing]));
    // Quarry preparation can consume wood for sticks. Acquire wood first,
    // then each remaining raw batch without demanding consumed wood coexist
    // as logs again. The original ensure still verifies every final craft.
    const entries=Object.entries(targets).sort(([a],[b])=>Number(b.endsWith('_log'))-Number(a.endsWith('_log')));
    for(const [name,target] of entries){active();await ensure({[name]:target});}
    active();
    return { requirements: batch.requirements, targets };
  }
  return { plan, prefetchRaw, ensure: input => ensure(input), recipeCost, selectRecipe, inputsFor, limits: { ...limits } };
}

module.exports = { createHouseMaterialRecipes, planHouseMaterialBatch, DEFAULT_RAW, DEFAULT_SMELTS };
