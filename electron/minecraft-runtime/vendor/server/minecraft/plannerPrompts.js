const DEFAULT_MAX_USER_CONTENT_LENGTH = 16000;

function normalizeAvailableActionIds(availableActionIds) {
  if (!Array.isArray(availableActionIds)) {
    return [];
  }
  return availableActionIds
    .map((actionId) => String(actionId || "").trim())
    .filter(Boolean);
}

function getRegistryActionIds(actionRegistry) {
  if (!actionRegistry || typeof actionRegistry.listActions !== "function") {
    return [];
  }
  return normalizeAvailableActionIds(
    actionRegistry.listActions().map((action) => action?.actionId)
  );
}

function stringifyPlannerPayload(payload, maxLength = DEFAULT_MAX_USER_CONTENT_LENGTH) {
  let content = "";
  try {
    content = JSON.stringify(payload, null, 2);
  } catch (_) {
    content = "{}";
  }
  const boundedLength = Number.isFinite(maxLength)
    ? Math.max(0, Math.floor(maxLength))
    : DEFAULT_MAX_USER_CONTENT_LENGTH;
  if (content.length > boundedLength) {
    return `${content.slice(0, boundedLength)}\n…(truncated)`;
  }
  return content;
}

function buildAiPlannerPromptMessages({
  command = "",
  contextSnapshot = null,
  availableActionIds = [],
} = {}) {
  const actionIds = normalizeAvailableActionIds(availableActionIds);
  return [
    {
      role: "system",
      content: [
        "你是 Minecraft 陪玩任务规划器。",
        "你的职责是把玩家自然语言指令转换成严格 JSON 任务计划。",
        "不要输出 markdown，不要输出代码块，只输出一个 JSON 对象（不要其它包裹文字）。",
        `可用 skill: ${JSON.stringify(actionIds)}`,
        '输出格式: {"mode":"task|chat","intent":"","goal":"","requiresConfirmation":false,"steps":[{"skill":"","args":{}}],"missingResources":[],"safetyRisk":"","replyText":"","reasoning":"","planSummary":""}',
        "只能使用 JSON steps 表达任务，禁止输出 JavaScript、scriptlet、表达式或其它可执行代码。",
        "reasoning：用 2～5 句中文写清子目标分解、依赖与主要风险（仅出现在 JSON 字段里，便于日志展示）。",
        "planSummary：一句中文给用户看的执行摘要（可与 replyText 互补，更短更口语）。",
        "如果无法执行就输出 mode=chat，并在 replyText 里说明缺少什么信息。",
        "优先规划成单主任务，不要并发；如果高阶目标依赖工具、燃料、矿物或冶炼，请先规划前置条件链。",
        "造房子使用 build_furnished_house 意图和 build_furnished_house_phase，schema=2；profile=cottage 或 enchanting_library。阶段依次 inspect_inventory/select_site/prepare_materials/clear_site/floor/frame/walls/windows/roof/furniture/finish/verify，不可省略家具、封闭屋顶或最终核验。",
        "基础小屋必须有床、工作台、箱子、熔炉、门窗和照明；高级小屋还要附魔台和15个有效间距的普通书架。不能退化为旧的小型空壳；材料不足要具体说明，不能假设库存或省略设施。",
        "安全约束：禁止规划跳进岩浆、虚空、自杀、攻击玩家、破坏明显属于玩家基地的核心方块、无理由使用TNT/火、故意丢弃重要物资。",
        "如果任务有明显危险、信息不足、或者需要更好的装备/材料，请输出 mode=chat 或在 missingResources / safetyRisk 中明确写出原因。",
        "你只能做规划，不能假设世界状态；请基于上下文中的 nearbyPlayers / nearbyHostiles / nearbyBlocks / inventory / recentTaskHistory / recentMemories 做保守规划。",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          command,
          context: contextSnapshot,
        },
        null,
        2
      ),
    },
  ];
}

function buildAiRevisionPromptMessages({
  availableActionIds = [],
  userPayload = {},
  maxUserContentLength = DEFAULT_MAX_USER_CONTENT_LENGTH,
} = {}) {
  const actionIds = normalizeAvailableActionIds(availableActionIds);
  return [
    {
      role: "system",
      content: [
        "你是 Minecraft 任务执行中的「修规划器」。",
        "当前脚本已在某一步失败。请根据失败原因与上下文，输出**一个 JSON**，给出**完整可执行**的新 steps（不是 diff），以便继续完成玩家原始目标。",
        "不要 markdown，不要代码块，只输出 JSON。",
        `可用 skill 必须来自: ${JSON.stringify(actionIds)}`,
        '格式: {"mode":"task|chat","intent":"","goal":"","steps":[{"skill":"","args":{}}],"replyText":"","reasoning":"","resumeFromStepIndex":0}',
        "只能修订 JSON steps，禁止输出 JavaScript、scriptlet、表达式或其它可执行代码。",
        "mode=task 时必须给出非空 steps；intent/goal 应与当前任务一致或可更精确，不得引入与玩家指令无关的新目标。",
        "resumeFromStepIndex：从第几步开始重跑（0 基）；若不写则默认从失败步开始。若你重写了前置链，可从 0 开始。",
        "保守：不要假设上下文中未出现的方块/实体；不要规划危险/违规操作（岩浆自杀、炸玩家基地等）。",
        "若信息不足以安全修订，输出 mode=chat 并在 replyText 说明原因。",
      ].join("\n"),
    },
    {
      role: "user",
      content: stringifyPlannerPayload(userPayload, maxUserContentLength),
    },
  ];
}

function createPlannerPromptTools(actionRegistry, options = {}) {
  const maxUserContentLength =
    Number.isFinite(options.maxUserContentLength) && options.maxUserContentLength >= 0
      ? Math.floor(options.maxUserContentLength)
      : DEFAULT_MAX_USER_CONTENT_LENGTH;

  return {
    getAvailableActionIds: () => getRegistryActionIds(actionRegistry),
    buildAiPlannerPromptMessages: ({ command, contextSnapshot } = {}) =>
      buildAiPlannerPromptMessages({
        command,
        contextSnapshot,
        availableActionIds: getRegistryActionIds(actionRegistry),
      }),
    buildAiRevisionPromptMessages: ({ userPayload } = {}) =>
      buildAiRevisionPromptMessages({
        availableActionIds: getRegistryActionIds(actionRegistry),
        userPayload,
        maxUserContentLength,
      }),
  };
}

module.exports = {
  DEFAULT_MAX_USER_CONTENT_LENGTH,
  buildAiPlannerPromptMessages,
  buildAiRevisionPromptMessages,
  createPlannerPromptTools,
  getRegistryActionIds,
  stringifyPlannerPayload,
};
