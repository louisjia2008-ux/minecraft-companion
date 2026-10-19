"use strict";

const { createMiningNavigator } = require("./miningNavigation");
const { Vec3 } = require("vec3");

const DIRECTIONS = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
];
const IRON_BLOCKS = ["iron_ore", "deepslate_iron_ore"];
const DIAMOND_BLOCKS = ["diamond_ore", "deepslate_diamond_ore"];
const IRON_INPUTS = ["raw_iron", "iron_ore", "deepslate_iron_ore"];
const STONE_MATERIALS = ["cobblestone", "cobbled_deepslate", "blackstone"];
const PICKAXES = ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe", "wooden_pickaxe"];
const DIAMOND_PICKAXES = ["iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"];
// Equivalent to eight carrots or three cooked porkchops. Count actual edible
// hunger points so a sparse herd is not exhausted to obtain eight rich meals.
const EXPEDITION_FOOD_POINTS = 24;

function bounded(value, fallback, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback));
}

function plain(position) {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function miningError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// Prefer the height advertised by the server. Modded/custom dimensions can use
// heights which do not match their protocol version, so a version alone is not
// enough to choose a safe digging floor.
function getMiningLevels(bot, args = {}) {
  const dimension = String(bot.game?.dimension || "overworld").replace(/^minecraft:/, "");
  if (dimension !== "overworld") {
    throw miningError("mining_wrong_dimension", "钻石开矿任务需要在主世界执行，请先带我回到主世界再继续。");
  }
  const version = String(bot.version || bot.registry?.version?.minecraftVersion || "1.18");
  const parts = version.split(".").map(Number);
  const modern = parts[0] > 1 || (parts[0] === 1 && parts[1] >= 18);
  const minY = Number.isFinite(bot.game?.minY) ? Number(bot.game.minY) : modern ? -64 : 0;
  const height = Number.isFinite(bot.game?.height) ? Number(bot.game.height) : modern ? 384 : 256;
  if (height < 24 || minY < -2048 || minY + height > 4096) {
    throw miningError("mining_world_height", "服务器的世界高度信息异常，无法确定安全下矿范围。");
  }
  const targetMaximum = Math.min(16, minY + height - 4);
  if (targetMaximum < minY + 6) {
    throw miningError("mining_world_height", "当前主世界的高度范围不包含可安全探查的钻石层。");
  }
  return {
    minY,
    maxY: minY + height - 1,
    // Eleven blocks above the floor keeps the default route clear of bedrock
    // and avoids intentionally entering the deepest lava aquifers.
    targetY: bounded(args.targetY, minY + 11, minY + 6, targetMaximum),
    ironY: bounded(args.ironY, 16, minY + 12, minY + height - 4),
  };
}

function remainingDurability(item, registry) {
  const maximum = Number(item?.maxDurability || registry?.itemsByName?.[item?.name]?.maxDurability);
  if (!maximum) return 1;
  let damage = 0;
  try { damage = Number(item.durabilityUsed ?? item.metadata ?? 0) || 0; } catch (_) {}
  return Math.max(0, maximum - damage);
}

function hasSilkTouch(item) {
  try { return (item.enchants || []).some((enchant) => String(enchant.name).replace(/^minecraft:/, "") === "silk_touch"); }
  catch (_) { return false; }
}

function createDiamondExpedition(deps) {
  if (!deps || typeof deps.getBot !== "function") throw new TypeError("Diamond expedition requires getBot");
  const active = () => deps.assertActive?.();
  let state;
  let navigator;
  let searchLimit;
  let lastPublished = "";
  let maintainingTool = false;

  const bot = () => deps.getBot();
  const foodOptions = () => ({ anchor: state.base, minFoodPoints: EXPEDITION_FOOD_POINTS });
  const items = () => bot().inventory?.items?.() || [];
  const count = (names) => {
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    return items().reduce((total, item) => total + (wanted.has(item.name) ? Number(item.count) || 0 : 0), 0);
  };
  const usablePickaxe = (names, minimum = 8, canHarvest = () => true) => items()
    .filter((item) => names.includes(item.name) && remainingDurability(item, bot().registry) >= minimum)
    .filter((item) => !DIAMOND_PICKAXES.includes(item.name) || !hasSilkTouch(item))
    .filter(canHarvest)
    .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name) || remainingDurability(b, bot().registry) - remainingDurability(a, bot().registry))[0];

  function publish(text, progressed = false) {
    active();
    state.y = Math.floor(bot().entity.position.y);
    state.diamonds = count("diamond");
    if (navigator) state.navigation = navigator.getState();
    deps.saveCheckpoint?.(copy(state));
    const signature = JSON.stringify([state.phase, state.y, state.diamonds, state.searchSteps,
      state.navigation?.dugBlocks ?? state.navigation?.dug, state.navigation?.moves, text]);
    if (signature !== lastPublished || progressed) {
      lastPublished = signature;
      deps.report?.(text || state.message || "正在执行钻石开矿任务", copy(state), progressed);
    }
  }

  function phase(name, text) {
    state.phase = name;
    state.message = text;
    publish(text);
  }

  async function supply(action, description) {
    active();
    try {
      const result = await action();
      active();
      publish(description, true);
      return result;
    } catch (error) {
      active(); // Pause/cancel/generation errors must retain their original code.
      if (String(error?.code || "").startsWith("mining_")) throw error;
      throw miningError("mining_supply", `${description}失败：${error?.message || "材料不足"}。补充材料后可继续原任务。`, error);
    }
  }

  async function atBase(action, text) {
    if (navigator) await navigator.retreat({ preserveRoute: true });
    active();
    const result = await supply(action, text);
    active();
    if (navigator) await navigator.returnToFrontier();
    return result;
  }

  async function makePickaxe(name, amount = 1) {
    await atBase(async () => {
      const table = await deps.ensureCraftingTableAvailable(state.base);
      await deps.ensureSticks(2 * amount);
      if (name === "wooden_pickaxe") await deps.ensurePlanks(3 * amount);
      await deps.craftItemByName(name, amount, table);
      if (!usablePickaxe([name], 8)) throw new Error(`合成后没有可用的 ${name}`);
    }, name === "iron_pickaxe" ? "正在补充铁镐" : "正在补充开矿用镐子");
  }

  async function ensureDiggingTool(minimum = 8) {
    active();
    if (usablePickaxe(["stone_pickaxe"], minimum)) return;
    // The installed recipe table accepts cobbled deepslate and blackstone in
    // modern worlds. Use one material per batch so recipesFor can satisfy a
    // real recipe even when several partial stacks are present.
    const stoneCount = Math.max(...STONE_MATERIALS.map((name) => count(name)));
    if (stoneCount >= 3 && count("stick") >= 2) {
      if (maintainingTool) throw miningError("mining_tool_supply", "补充镐子时仍缺少可用工具，请补充石镐后继续。");
      maintainingTool = true;
      try {
        const amount = Math.max(1, Math.min(4, Math.floor(stoneCount / 3), Math.floor(count("stick") / 2)));
        await makePickaxe("stone_pickaxe", amount);
      } finally { maintainingTool = false; }
      return;
    }
    if (usablePickaxe(PICKAXES, minimum)) return;
    if (count("stick") < 2) {
      throw miningError("mining_tool_supply", "备用木棍已经用完。已保存矿道进度，请补充木棍或镐子后继续。");
    }
    if (!maintainingTool) {
      maintainingTool = true;
      try { await makePickaxe("wooden_pickaxe"); } finally { maintainingTool = false; }
      return;
    }
    throw miningError("mining_tool_supply", "没有足够耐久的镐子，已停止继续开矿。");
  }

  async function equipForBlock(block) {
    active();
    if (Number.isFinite(bot().health) && bot().health <= 10) {
      throw miningError("mining_low_health", "采矿过程中生命值偏低，已停止挖掘并尝试沿已知矿道撤回。");
    }
    const diamond = DIAMOND_BLOCKS.includes(block.name);
    const iron = IRON_BLOCKS.includes(block.name);
    const accepted = diamond ? DIAMOND_PICKAXES : iron
      ? ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"] : PICKAXES;
    const minimum = diamond ? 1 : 4;
    // Tool preference only applies among tools which can actually harvest this
    // block. Natural redstone/gold in a tunnel needs iron even when stone remains.
    const tool = usablePickaxe(accepted, minimum,
      (item) => typeof block.canHarvest !== "function" || block.canHarvest(item.type));
    if (!tool) {
      if (!diamond && !iron && usablePickaxe(accepted, minimum)) {
        throw miningError("MINING_OBSTRUCTED", `现有工具无法安全采出 ${block.name}，保留方块并寻找其他矿道方向。`);
      }
      throw miningError("mining_tool_required", diamond
        ? "发现钻石，但没有可采出钻石的铁镐或更好镐子。已保存位置，请补充工具后继续。"
        : `目前的镐子不能安全采集 ${block.name}，请补充对应工具后继续。`);
    }
    if (deps.equipItem) await deps.equipItem(tool);
    else await deps.equipBestTool(block);
    active();
    if (typeof block.canHarvest === "function" && !block.canHarvest(bot().heldItem?.type ?? tool.type)) {
      throw miningError("mining_tool_required", "装备后的工具不能采出目标方块，已停止开采。");
    }
  }

  async function survival() {
    active();
    if (Number.isFinite(bot().health) && bot().health <= 10) {
      throw miningError("mining_low_health", "生命值偏低，已停止开矿并尝试沿已知矿道撤回。恢复生命后可以继续。");
    }
    if (Number.isFinite(bot().food) && bot().food < 18) {
      const previousPhase = state.phase;
      const previousMessage = state.message;
      phase("resupply_food", "饥饿值偏低，正在沿矿道返回补充食物");
      await atBase(async () => {
        for (let attempt = 0; attempt < 4 && bot().food < 18; attempt += 1) {
          active();
          const previous = bot().food;
          await deps.ensureNutrition(20, foodOptions());
          if (bot().food <= previous) break;
        }
        if (bot().food < 18) throw new Error("没有足够食物支持继续开矿");
      }, "正在补充开矿口粮");
      state.phase = previousPhase;
      state.message = previousMessage;
    }
    const inventory = bot().inventory;
    if (typeof inventory.emptySlotCount === "function" && inventory.emptySlotCount() <= 1) {
      throw miningError("mining_inventory_full", "背包空间不足，已停止开矿。请清理圆石等材料并留出至少两个空格后继续。");
    }
  }

  function positionKey(position) { return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`; }

  async function advance(direction, descend = false, options = {}) {
    active();
    await survival();
    await ensureDiggingTool();
    if (state.searchSteps >= searchLimit) {
      throw miningError("mining_search_exhausted", `本轮已推进 ${searchLimit - state.runStartSteps} 格矿道，仍未拿齐目标钻石。已保存深度、矿道和工具进度，点击继续可从当前位置扩展搜索。`);
    }
    const result = await navigator.advance(direction, { descend, ...options });
    state.searchSteps += 1;
    publish(`${state.message}；当前 Y=${Math.floor(bot().entity.position.y)}，钻石 ${count("diamond")}/${state.targetCount}`, true);
    return result;
  }

  function canChangeRoute(error) {
    return /^MINING_(?:FLUID|GRAVITY|NO_SUPPORT|OBSTRUCTED|UNSAFE|OUT_OF_REACH|NOT_EXPOSED)$/.test(String(error?.code || ""));
  }

  async function alternateAdvance(descend) {
    const preferred = state.heading;
    let lastError;
    const rejectedReasons = [];
    const position = plain(bot().entity.position);
    const visited = new Set((navigator.getState().breadcrumbs || []).map(positionKey));
    for (const index of [preferred, (preferred + 1) % 4, (preferred + 3) % 4, (preferred + 2) % 4]) {
      const direction = DIRECTIONS[index];
      const destination = { x: position.x + direction.x, y: position.y - (descend ? 1 : 0), z: position.z + direction.z };
      if (visited.has(positionKey(destination))) continue;
      try {
        await advance(direction, descend);
        state.heading = index;
        return true;
      } catch (error) {
        active();
        if (!canChangeRoute(error)) throw error;
        lastError = error;
        rejectedReasons.push(String(error.message || error.code));
        state.avoidedHazards += 1;
        publish(`前方存在危险或不稳定地形，正在改换开矿方向：${error.message}`);
      }
    }
    if (descend) {
      const indices = [preferred, (preferred + 1) % 4, (preferred + 3) % 4, (preferred + 2) % 4];
      const detour = navigator.planDescentDetour(indices.map((index) => DIRECTIONS[index]));
      if (detour?.length) {
        publish(`直接下降被天然地形阻挡，正在沿安全同层通道绕行后继续下矿；本次阻挡原因：${[...new Set(rejectedReasons)].join("；")}`);
        for (const step of detour) {
          await advance(step.direction, step.descend);
          state.heading = DIRECTIONS.findIndex((direction) => direction.x === step.direction.x && direction.z === step.direction.z);
        }
        return true;
      }
    }
    throw lastError || miningError("mining_no_safe_route", "四个方向都没有新的安全通路，已保留矿道进度。请清理危险或移动到安全位置再继续。");
  }

  async function approachOre(candidate, names, targetReached) {
    const originCount = count(names === IRON_BLOCKS ? IRON_INPUTS : "diamond");
    const maximum = 20;
    for (let step = 0; step < maximum; step += 1) {
      active();
      if (targetReached()) return true;
      const current = plain(bot().entity.position);
      const target = candidate.position;
      const dx = Math.floor(target.x) - current.x;
      const dy = Math.floor(target.y) - current.y;
      const dz = Math.floor(target.z) - current.z;
      const targetBlock = bot().blockAt(new Vec3(target.x, target.y, target.z));
      if (!targetBlock || !names.includes(targetBlock.name)) return count(names === IRON_BLOCKS ? IRON_INPUTS : "diamond") > originCount;
      if (Math.hypot(dx, dy, dz) <= 4.2) {
        try {
          await navigator.mineVein(target, { goal: targetReached, maxBlocks: 32 });
          publish(`正在采集矿脉；钻石 ${count("diamond")}/${state.targetCount}`, true);
          return count(names === IRON_BLOCKS ? IRON_INPUTS : "diamond") > originCount;
        } catch (error) {
          active();
          if (!/^MINING_(?:OUT_OF_REACH|NOT_EXPOSED|OBSTRUCTED)$/.test(String(error?.code || ""))) throw error;
        }
      }
      // Carve a corridor toward the loaded ore instead of asking a pathfinder
      // to tunnel through arbitrary rock. Never excavate straight below us.
      const direction = Math.abs(dx) >= Math.abs(dz) && dx !== 0
        ? { x: Math.sign(dx), z: 0 } : dz !== 0 ? { x: 0, z: Math.sign(dz) } : DIRECTIONS[state.heading];
      const descend = dy < 0 && current.y > state.levels.minY + 6;
      const ascend = dy > 1;
      await advance(direction, descend, ascend ? { ascend: true } : {});
    }
    return false;
  }

  async function harvestNearby(names, targetReached) {
    active();
    if (targetReached()) return true;
    const ignored = new Set(state.ignoredOres || []);
    const candidates = navigator.scanNearby(names, 12).filter((candidate) => !ignored.has(positionKey(candidate.position)));
    for (const candidate of candidates.slice(0, 8)) {
      active();
      if (names === DIAMOND_BLOCKS && !usablePickaxe(DIAMOND_PICKAXES,
        Math.max(1, Math.min(32, state.targetCount - count("diamond"))))) return false;
      try {
        await survival();
        await ensureDiggingTool(40);
        if (await approachOre(candidate, names, targetReached)) {
          if (targetReached()) return true;
        }
      } catch (error) {
        active();
        if (!canChangeRoute(error)) throw error;
        state.avoidedHazards += 1;
        publish(`这段矿脉附近存在危险，保留位置并寻找其他矿脉：${error.message}`);
      }
      ignored.add(positionKey(candidate.position));
      state.ignoredOres = [...ignored].slice(-256);
    }
    return targetReached();
  }

  async function bootstrap() {
    phase("prepare_wood", "正在准备木材、工作台和备用木棍");
    // 64 sticks support 32 replacement stone picks; enough for the bounded
    // expedition without depending on trees at diamond depth.
    await supply(() => deps.ensurePlanks(64), "正在准备开矿木材");
    await supply(() => deps.ensureSticks(64), "正在准备备用木棍");
    if (!state.base) state.base = plain(bot().entity.position);
    const table = await supply(() => deps.ensureCraftingTableAvailable(state.base), "正在准备开矿工作台");
    state.base = plain(bot().entity.position);
    if (!usablePickaxe(PICKAXES)) {
      await supply(() => deps.craftItemByName("wooden_pickaxe", 1, table), "正在制作第一把木镐");
    }
    if (!usablePickaxe(PICKAXES)) throw miningError("mining_tool_supply", "木镐制作后没有可用工具，不能开始下矿。");
    state.prepared = true;
    publish("木材和工具已准备，开始建立安全阶梯矿道", true);
  }

  async function prepareStoneAndFurnace() {
    phase("quarry_stone", "正在沿阶梯开采圆石，准备石镐和熔炉");
    while (count("cobblestone") < 20) {
      await alternateAdvance(true);
      if (Math.floor(bot().entity.position.y) <= state.levels.minY + 12 && count("cobblestone") < 20) {
        throw miningError("mining_stone_supply", "在安全深度内没有采集到足够圆石，无法继续制作石镐和熔炉。");
      }
    }
    await makePickaxe("stone_pickaxe", 3);
    await atBase(() => deps.ensureFurnaceAvailable(state.base), "正在制作并安放开矿熔炉");
    state.stonePrepared = true;
    publish("石镐和熔炉已经备好，开始寻找铁矿", true);
  }

  async function prepareFood() {
    phase("prepare_food", "正在营地附近寻找并准备自然生存口粮");
    await atBase(async () => {
      if (typeof deps.ensureFoodSupply !== "function"
        || !await deps.ensureFoodSupply(8, foodOptions())) {
        throw miningError("mining_food_supply", "未能取得足够生存口粮，不能空腹深入矿道。");
      }
      if (Number.isFinite(bot().food) && bot().food < 20) {
        for (let attempt = 0; attempt < 4 && bot().food < 20; attempt += 1) {
          const before = bot().food;
          await deps.ensureNutrition(20, foodOptions());
          if (bot().food <= before) break;
        }
      }
      // Meals consumed at camp no longer belong to the underground reserve.
      if (!await deps.ensureFoodSupply(8, foodOptions())) {
        throw miningError("mining_food_supply", "进食后剩余口粮不足，已停在营地保留矿道。");
      }
    }, "正在准备下矿口粮");
    state.foodPrepared = true;
    publish("口粮已准备，继续寻找铁矿和钻石", true);
  }

  async function prepareIron() {
    if (usablePickaxe(DIAMOND_PICKAXES, Math.max(8, Math.min(32, state.targetCount)))) return;
    phase("find_iron", "正在阶梯下矿并探查铁矿");
    if (Number.isFinite(state.ironRouteIndex) && bot().entity.position.y < state.levels.ironY - 8) {
      const navigation = navigator.getState();
      if (state.ironRouteIndex <= navigation.routeIndex) {
        await navigator.retreat({ steps: navigation.routeIndex - state.ironRouteIndex, preserveRoute: true });
        // A replacement iron search can make a new route from the known iron
        // layer. Its subsequent diamond branches receive fresh route indices.
        state.branch = null;
      }
    }
    const ironReady = () => count("iron_ingot") + count(IRON_INPUTS) >= 3;
    let branchSteps = 0;
    while (!ironReady()) {
      if (await harvestNearby(IRON_BLOCKS, ironReady)) break;
      const descend = Math.floor(bot().entity.position.y) > state.levels.ironY;
      await alternateAdvance(descend);
      if (!descend && ++branchSteps >= 192) {
        throw miningError("mining_iron_not_found", "已在铁矿层探查 192 格，仍未找到足够安全铁矿。矿道已保存，点击继续可扩展探矿。");
      }
    }
    state.ironRouteIndex = navigator.getState().routeIndex;
    phase("smelt_iron", "已收集铁矿，正在返回熔炉冶炼铁镐");
    await atBase(async () => {
      if (count("iron_ingot") < 3) {
        await deps.executeSmeltItem({ args: { inputItems: IRON_INPUTS, output: "iron_ingot", count: 3 } });
      }
      const table = await deps.ensureCraftingTableAvailable(state.base);
      await deps.ensureSticks(2);
      await deps.craftItemByName("iron_pickaxe", 1, table);
      if (!usablePickaxe(DIAMOND_PICKAXES, 8)) throw new Error("铁镐制作后没有可用工具");
    }, "正在冶炼并制作铁镐");
    state.ironPrepared = true;
    publish("铁镐准备完成，开始深入钻石层", true);
  }

  async function prospect() {
    const descendToDiamondLayer = async () => {
      phase("descend_diamond", `正在开挖阶梯矿道，目标钻石层 Y=${state.targetY}`);
      while (Math.floor(bot().entity.position.y) > state.targetY) {
        if (!usablePickaxe(DIAMOND_PICKAXES, Math.max(8, Math.min(32, state.targetCount - count("diamond"))))) {
          await prepareIron();
        }
        if (await harvestNearby(DIAMOND_BLOCKS, () => count("diamond") >= state.targetCount)) return true;
        await alternateAdvance(true);
      }
      return false;
    };
    if (await descendToDiamondLayer()) return;
    phase("prospect_diamond", `已到达钻石层，正在主矿道与分支矿道探矿`);
    state.branch = state.branch || { phase: "main", steps: 0, origin: null, heading: state.heading };
    while (count("diamond") < state.targetCount) {
      active();
      if (!usablePickaxe(DIAMOND_PICKAXES, Math.max(8, Math.min(32, state.targetCount - count("diamond"))))) {
        await prepareIron();
        if (await descendToDiamondLayer()) return;
        state.branch = { phase: "main", steps: 0, origin: null, heading: state.heading };
        phase("prospect_diamond", "铁镐已补齐，正在继续钻石层探矿");
      }
      if (await harvestNearby(DIAMOND_BLOCKS, () => count("diamond") >= state.targetCount)) break;
      const branch = state.branch;
      if (branch.phase === "main") {
        await alternateAdvance(false);
        if (++branch.steps >= 3) {
          branch.phase = "left";
          branch.steps = 0;
          branch.origin = navigator.getState().routeIndex;
          branch.heading = state.heading;
        }
      } else {
        const directionIndex = (branch.heading + (branch.phase === "left" ? 3 : 1)) % 4;
        let finished = branch.steps >= 24;
        if (!finished) {
          try {
            await advance(DIRECTIONS[directionIndex]);
            branch.steps += 1;
          } catch (error) {
            active();
            if (!canChangeRoute(error)) throw error;
            state.avoidedHazards += 1;
            finished = true;
            publish(`分支前方存在危险，正在返回主矿道：${error.message}`);
          }
        }
        if (finished) {
          const index = navigator.getState().routeIndex;
          await navigator.retreat({ steps: Math.max(0, index - branch.origin), preserveRoute: true });
          branch.phase = branch.phase === "left" ? "right" : "main";
          branch.steps = 0;
          state.heading = branch.heading;
          if (branch.phase === "main") branch.origin = null;
        }
      }
      publish(state.message);
    }
  }

  async function run(step = {}) {
    active();
    const args = step.args || {};
    const levels = getMiningLevels(bot(), args);
    const targetCount = bounded(args.count, 1, 1, 256);
    const restored = deps.getCheckpoint?.();
    state = restored?.schema === 1 && restored.targetCount === targetCount ? copy(restored) : {
      schema: 1, phase: "starting", targetCount, levels, targetY: levels.targetY,
      heading: 0, searchSteps: 0, avoidedHazards: 0, ignoredOres: [], base: null,
    };
    if (state.levels.minY !== levels.minY || state.levels.maxY !== levels.maxY) {
      throw miningError("mining_world_changed", "世界高度与已保存矿道不一致，无法直接恢复这段开矿任务。");
    }
    state.runStartSteps = Number(state.searchSteps) || 0;
    searchLimit = state.runStartSteps + bounded(args.maxSearchSteps, 768, 8, 2048);
    state.lastError = null;
    delete state.retreatError;
    delete state.reason;
    lastPublished = "";
    try {
      if (!state.prepared && count("diamond") < targetCount) await bootstrap();
      active();
      navigator = createMiningNavigator({
        getBot: deps.getBot,
        assertActive: deps.assertActive,
        restoredState: state.navigation,
        checkpoint: (navigation) => { state.navigation = navigation; deps.saveCheckpoint?.(copy(state)); },
        heartbeat: () => publish(state.message, true),
        equipForBlock,
        digBlock: deps.digBlock,
        // Navigation owns all movement around drops. The legacy collector can
        // pathfind through fluids or excavate outside the checked corridor.
        collectDrops: deps.collectDrops,
        maxActions: bounded(args.maxActions, 4096, 32, 12000),
        minY: levels.minY,
        height: levels.maxY - levels.minY + 1,
        ...(deps.navigationOptions || {}),
      });
      if (state.navigation?.breadcrumbs?.length && count("diamond") < targetCount) {
        await navigator.returnToFrontier();
      }
      if (count("diamond") < targetCount) {
        if (!state.stonePrepared) await prepareStoneAndFurnace();
        if (!state.foodPrepared) await prepareFood();
        await prepareIron();
        await prospect();
      }
      if (count("diamond") < targetCount) throw miningError("mining_goal_unconfirmed", "尚未在背包中确认目标数量的钻石，任务不会标记完成。");
      phase("return_home", `已获得 ${count("diamond")} 个钻石，正在沿安全矿道返回`);
      await navigator.retreat({ preserveRoute: true });
      active();
      if (Number.isFinite(bot().food) && bot().food < 20) {
        for (let attempt = 0; attempt < 4 && bot().food < 20; attempt += 1) {
          const before = bot().food;
          await supply(() => deps.ensureNutrition(20, foodOptions()), "正在营地补充返程后的食物");
          if (bot().food <= before) break;
        }
      }
      if (count("diamond") < targetCount) throw miningError("mining_goal_unconfirmed", "返回后背包里的钻石不足目标数量，请检查物品后继续。");
      state.phase = "complete";
      state.message = `开矿完成：已获得 ${count("diamond")} 个钻石并沿矿道返回。`;
      publish(state.message, true);
      return { diamonds: count("diamond"), targetCount, checkpoint: copy(state) };
    } catch (error) {
      active();
      let failure = error;
      if (/^MINING_/.test(String(error?.code || ""))) {
        failure = miningError(String(error.code).toLowerCase(), `${error.message}。已保存矿道与任务目标，处理后可以继续。`, error);
      } else if (!String(error?.code || "").startsWith("mining_")) {
        failure = miningError("mining_execution", `开矿中断：${error?.message || "未知错误"}。已保存进度，可以继续原任务。`, error);
      }
      state.lastError = { code: failure.code, message: failure.message };
      state.reason = failure.message;
      state.resumePhase = state.phase;
      state.phase = "blocked";
      if (navigator && !/^mining_(?:route_changed|unloaded)$/.test(failure.code)) {
        try { await navigator.retreat({ preserveRoute: true }); }
        catch (retreatError) { active(); state.retreatError = String(retreatError.message || retreatError); }
      }
      publish(failure.message);
      throw failure;
    }
  }

  return { run };
}

module.exports = { createDiamondExpedition, getMiningLevels, remainingDurability };
