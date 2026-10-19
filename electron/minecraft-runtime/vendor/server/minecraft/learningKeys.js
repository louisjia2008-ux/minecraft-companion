const { LOG_TO_PLANK } = require("./taskCatalog");

function normalizeLearningIntent(intent = "") {
  return String(intent || "")
    .trim()
    .replace(/_recovery$/, "");
}

function isWoodBlockName(name = "") {
  return Object.prototype.hasOwnProperty.call(LOG_TO_PLANK, String(name || "").trim());
}

function getResourceLearningKey(rawName = "") {
  const normalized = String(rawName || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (["diamond", "diamond_ore", "deepslate_diamond_ore"].includes(normalized)) {
    return "diamond";
  }
  if (["iron_ore", "deepslate_iron_ore", "raw_iron", "iron_ingot"].includes(normalized)) {
    return "iron";
  }
  if (["coal", "coal_ore", "deepslate_coal_ore", "charcoal"].includes(normalized)) {
    return "coal";
  }
  if (
    normalized === "wood" ||
    isWoodBlockName(normalized) ||
    Object.values(LOG_TO_PLANK).includes(normalized)
  ) {
    return "wood";
  }
  if (["stone", "cobblestone"].includes(normalized)) {
    return "stone";
  }
  return normalized;
}

function createLearningKeyTools(actionRegistry, options = {}) {
  if (!actionRegistry || typeof actionRegistry.getTaskScriptKey !== "function") {
    throw new Error("Minecraft learning key tools require an action registry");
  }

  const resolveBuildMaterial =
    typeof options.resolveBuildMaterial === "function"
      ? options.resolveBuildMaterial
      : (value) => String(value || "").trim().toLowerCase();

  function getTaskScriptKey(plan, command = "") {
    return actionRegistry.getTaskScriptKey(plan, command, {
      normalizeLearningIntent,
      resolveBuildMaterial,
      getResourceLearningKey,
    });
  }

  function tokenizeTaskCommand(command = "") {
    return actionRegistry.tokenizeTaskCommand(command);
  }

  function getTaskScriptStepSignature(step) {
    return actionRegistry.getTaskScriptStepSignature(step);
  }

  function getStageScriptResourceKey(step = {}) {
    return actionRegistry.getStageResourceKey(step, {
      getResourceLearningKey,
      resolveBuildMaterial,
    });
  }

  function getStageScriptTargetKey(step = {}) {
    return actionRegistry.getStageTargetKey(step, {
      getResourceLearningKey,
      resolveBuildMaterial,
    });
  }

  function getStageKindForStep(step = {}) {
    return actionRegistry.getStageKind(step);
  }

  function getStageScriptKey(intent = "", step = {}) {
    return actionRegistry.getStageScriptKey(intent, step, {
      normalizeLearningIntent,
      getTaskScriptStepSignature,
    });
  }

  return {
    getResourceLearningKey,
    getStageKindForStep,
    getStageScriptKey,
    getStageScriptResourceKey,
    getStageScriptTargetKey,
    getTaskScriptKey,
    getTaskScriptStepSignature,
    normalizeLearningIntent,
    tokenizeTaskCommand,
  };
}

module.exports = {
  createLearningKeyTools,
  getResourceLearningKey,
  isWoodBlockName,
  normalizeLearningIntent,
};
