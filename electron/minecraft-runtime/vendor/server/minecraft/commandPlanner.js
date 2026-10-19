// Specific operation verbs take precedence over resource words. Keep this parser
// independently testable because a valid JSON plan can still represent the wrong task.
const { parseTaskQuantity } = require("./taskQuantity");

function createHeuristicPlanner({ actionRegistry, getLearnedSearchRadius }) {
  return function heuristicPlanner(command, context = {}) {
    const text = String(command || "").normalize('NFKC').trim();
    const lower = text.toLowerCase();
    const quantity = parseTaskQuantity(text);
    const countMatch = quantity.present && quantity.valid;
    const count = countMatch ? quantity.value : 16;
    const craftRequest = /做|合成|\bcraft\b/.test(lower);
    if ((!quantity.valid || (craftRequest && countMatch && count > 32)) && /挖|采|收集|砍|拿|取|做|合成|\b(?:mine|dig|collect|gather|chop|withdraw|fetch|craft)\b/.test(lower) &&
        !/(?:去|前往|走到|\bgoto\b|\bgo\s+to\b)/.test(lower)) {
      return { mode: 'chat', intent: 'invalid_quantity', goal: '', steps: [],
        replyText: craftRequest ? '合成数量必须是 1 到 32 的整数。' : '数量必须是 1 到 256 的整数，请明确要采集或取出的数量。' };
    }

    // Construction owns the complete sentence even when it also mentions going
    // to coordinates or taking materials out of a supply chest.
    const wantsCastle = /城堡|\bcastle\b/.test(lower);
    const wantsVilla = /别墅|\bvilla\b/.test(lower) ||
      (/河畔|河边|\briverside\b/.test(lower) && /木屋|小屋|房屋|房子|\b(?:house|hut|cottage)\b/.test(lower));
    if (/造|建|盖|\bbuild\b/.test(lower) && (wantsCastle || wantsVilla)) {
      const anchorMatch = text.match(/(?<![\d.\-])(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)(?![\d.])/);
      const forbidsSupply = /(?:不(?:要|准|允许)?|别|无需)(?:使用|用|从|拿|取).{0,12}(?:补给箱|材料箱|箱子)|只(?:使用|用).{0,10}背包|\binventory[- ]only\b|\b(?:do not|don't|without)\b.{0,25}\b(?:supply\s+)?chests?\b/.test(lower);
      const allowsSupply = /(?:使用|用|从|拿|取).{0,20}(?:补给箱|材料箱|箱子)|\b(?:using|use|from|with)\b.{0,40}\b(?:supply\s+)?chests?\b/.test(lower);
      return actionRegistry.buildHeuristicTaskPlan('build_estate', {
        profile: wantsCastle ? 'medieval_castle' : 'riverside_villa',
        useNearbySupplyChests: !forbidsSupply && allowsSupply,
        materialSource: !forbidsSupply && allowsSupply ? 'external_depots' : 'self_gathered',
        ...(anchorMatch ? { anchor: { x: Number(anchorMatch[1]), y: Number(anchorMatch[2]), z: Number(anchorMatch[3]) } } : {}),
      });
    }

    if (/跟着我|跟随我|\bfollow\s+me\b|跟我走|跟我/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("follow_player", {
        playerName: context.playerName || "",
      }, {
        playerName: context.playerName || "",
      });
    }

    if (/护卫我|保护我|守着我|\b(?:escort|guard)\b/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("escort_player", {
        playerName: context.playerName || "",
      }, {
        playerName: context.playerName || "",
      });
    }

    const xyzMatch = text.match(/(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/);
    if (/(?:去(?:到|往)?|前往|走到|\bgoto\b|\bgo\s+to\b)/.test(lower) && xyzMatch) {
      return actionRegistry.buildHeuristicTaskPlan("go_to_position", {
        x: Number(xyzMatch[1]),
        y: Number(xyzMatch[2]),
        z: Number(xyzMatch[3]),
      });
    }

    if (/做|合成|\bcraft\b/.test(lower) && /(木镐|\bwooden(?:\s+|_)pickaxe\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("craft_wooden_pickaxe", { count: countMatch ? count : 1 });
    }

    if (/做|合成|\bcraft\b/.test(lower) && /(铁镐|\biron(?:\s+|_)pickaxe\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("craft_iron_pickaxe", { count: countMatch ? count : 1 });
    }

    if (/做|合成|\bcraft\b/.test(lower) && /(石镐|\bstone(?:\s+|_)pickaxe\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("craft_stone_pickaxe", { count: countMatch ? count : 1 });
    }

    if (/存箱|放箱子|放进箱子|把东西放箱子|\b(?:deposit|store)\b/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("deposit_items", {});
    }

    if (
      /拿|取|\b(?:withdraw|fetch)\b/.test(lower) &&
      /(圆石|木板|木头|原木|食物|面包|苹果|石镐|木镐|\b(?:cobble(?:stone)?|planks?|wood|logs?|food|bread|apple|(?:stone|wooden)(?:\s+|_)pickaxe)\b)/.test(lower)
    ) {
      const itemName = /圆石|\bcobble(?:stone)?\b/.test(lower)
        ? "cobblestone"
        : /木板|\bplanks?\b/.test(lower)
          ? "oak_planks"
          : /木头|原木|\b(?:wood|logs?)\b/.test(lower)
            ? "oak_log"
            : /面包|bread/.test(lower)
              ? "bread"
              : /苹果|apple/.test(lower)
                ? "apple"
                : /石镐|stone pickaxe|stone_pickaxe/.test(lower)
                  ? "stone_pickaxe"
                  : /木镐|wooden pickaxe|wooden_pickaxe/.test(lower)
                    ? "wooden_pickaxe"
                    : "bread";
      return actionRegistry.buildHeuristicTaskPlan("withdraw_items", {
        item: itemName,
        count,
      });
    }

    if (/造|盖|\bbuild\b/.test(lower) && /(房|屋|\b(?:house|hut)\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan('build_furnished_house', {
        profile: /高级|附魔|书架|圖書|图书|\b(?:advanced|enchant(?:ing|ment)?|librar(?:y|ies)|bookshel(?:f|ves))\b/.test(lower)
          ? 'enchanting_library' : 'cottage',
      });
    }

    if (/(?:挖|采|收集|\b(?:mine|dig|collect|gather)\b)/.test(lower) && /(?:圆石|石头|\b(?:cobble(?:stone)?|stone)\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("mine_cobblestone", {
        count,
        playerName: context.playerName || "",
      }, {
        playerName: context.playerName || "",
      });
    }

    if (/(?:挖|采|收集|\b(?:mine|dig|collect|gather)\b)/.test(lower) && /(钻石|\bdiamonds?\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("mine_diamond", {
        count: countMatch ? count : 1,
        playerName: context.playerName || "",
      }, {
        playerName: context.playerName || "",
        getLearnedSearchRadius,
      });
    }

    if (/(?:挖|采|收集|\b(?:mine|dig|collect|gather)\b)/.test(lower) && /(铁|铁矿|\biron\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("mine_iron", {
        count,
        playerName: context.playerName || "",
      }, {
        playerName: context.playerName || "",
        getLearnedSearchRadius,
      });
    }

    if (/(?:挖|采|收集|\b(?:mine|dig|collect|gather)\b)/.test(lower) && /(煤|煤炭|\bcoal\b)/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("mine_coal", {
        count,
        playerName: context.playerName || "",
      }, {
        playerName: context.playerName || "",
        getLearnedSearchRadius,
      });
    }

    if (
      /收|割|harvest|farm/.test(lower) &&
      /(小麦|麦子|胡萝卜|土豆|作物|crop|wheat|carrot|potato)/.test(lower)
    ) {
      const cropNames = [];
      if (/小麦|麦子|wheat/.test(lower)) {
        cropNames.push("wheat");
      }
      if (/胡萝卜|carrot/.test(lower)) {
        cropNames.push("carrots");
      }
      if (/土豆|potato/.test(lower)) {
        cropNames.push("potatoes");
      }
      if (!cropNames.length) {
        cropNames.push("wheat", "carrots", "potatoes");
      }
      return actionRegistry.buildHeuristicTaskPlan("harvest_crops", {
        crops: cropNames,
        count: count || 6,
        maxDistance: 20,
        replant: true,
      });
    }

    if (
      /补种|种回去|播种|plant/.test(lower) &&
      /(小麦|麦子|胡萝卜|土豆|作物|crop|wheat|carrot|potato|农田)/.test(lower)
    ) {
      const cropNames = [];
      if (/小麦|麦子|wheat/.test(lower)) {
        cropNames.push("wheat");
      }
      if (/胡萝卜|carrot/.test(lower)) {
        cropNames.push("carrots");
      }
      if (/土豆|potato/.test(lower)) {
        cropNames.push("potatoes");
      }
      if (!cropNames.length) {
        cropNames.push("wheat", "carrots", "potatoes");
      }
      return actionRegistry.buildHeuristicTaskPlan("plant_crops", {
        crops: cropNames,
        count: count || 6,
        maxDistance: 20,
      });
    }

    if (/怪|僵尸|骷髅|creeper|zombie|skeleton|attack/.test(lower) && /打|清|attack|kill/.test(lower)) {
      return actionRegistry.buildHeuristicTaskPlan("attack_hostile", {});
    }

    if (/砍树/.test(lower) || (/(?:挖|采|收集|砍|\b(?:collect|gather|chop|mine|dig)\b)/.test(lower) && /(?:木头|原木|\b(?:wood|logs?|timber)\b)/.test(lower))) {
      return actionRegistry.buildHeuristicTaskPlan("gather_wood", {
        count,
        playerName: context.playerName || "",
      }, {
        playerName: context.playerName || "",
      });
    }

    return {
      mode: "chat",
      intent: "chat",
      goal: "",
      steps: [],
      replyText:
        "我暂时没把这句话识别成明确任务。你可以直接说“跟着我”“去 10 64 -5”“挖 16 个圆石”“挖点铁矿”“挖点煤炭”“帮我打附近怪物”“造一个小木屋”。",
    };
  };
}

module.exports = { createHeuristicPlanner };
