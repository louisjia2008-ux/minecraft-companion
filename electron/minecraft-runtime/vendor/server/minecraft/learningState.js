const { clamp, cloneSerializable } = require("./taskUtils");

function createDefaultLearningState() {
  return {
    schemaVersion: 2,
    migratedAt: null,
    indexes: {
      taskFeatures: {},
    },
    intents: {},
    resources: {},
    taskScripts: {},
    stageScripts: {},
    builds: {
      smallHouseScalePenalty: 0,
      smallHousePlaybookVersion: 1,
      smallHousePhaseStats: {},
    },
    recentInsights: [],
  };
}

function normalizeTaskScriptPlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") {
    return null;
  }
  const steps = Array.isArray(rawPlan.steps)
    ? rawPlan.steps
        .map((step) => {
          const skill = String(step?.skill || "").trim();
          if (!skill) {
            return null;
          }
          return {
            skill,
            args: step?.args && typeof step.args === "object" ? cloneSerializable(step.args, {}) || {} : {},
          };
        })
        .filter(Boolean)
    : [];
  if (!steps.length) {
    return null;
  }
  return {
    mode: "task",
    intent: String(rawPlan.intent || "").trim() || "generic_task",
    goal: String(rawPlan.goal || "").trim(),
    steps,
    postTaskMode: rawPlan.postTaskMode === "escort_player" ? "escort_player" : null,
    postTaskArgs:
      rawPlan.postTaskArgs && typeof rawPlan.postTaskArgs === "object"
        ? cloneSerializable(rawPlan.postTaskArgs, {}) || {}
        : null,
    replyText: String(rawPlan.replyText || "").trim(),
    scriptMeta:
      rawPlan.scriptMeta && typeof rawPlan.scriptMeta === "object"
        ? cloneSerializable(rawPlan.scriptMeta, {}) || {}
        : null,
  };
}

function createLearningStateTools(actionRegistry) {
  if (!actionRegistry || typeof actionRegistry.normalizeLearningState !== "function") {
    throw new Error("Minecraft learning state requires an action registry");
  }
  return {
    createDefaultLearningState,
    normalizeTaskScriptPlan,
    normalizeLearningTaskScripts(rawScripts) {
      return actionRegistry.normalizeLearningTaskScripts(rawScripts, {
        normalizeTaskScriptPlan,
      });
    },
    normalizeLearningStageScripts(rawScripts) {
      return actionRegistry.normalizeLearningStageScripts(rawScripts);
    },
    normalizeLearningState(raw) {
      return actionRegistry.normalizeLearningState(raw, {
        createDefaultLearningState,
        normalizeTaskScriptPlan,
        clamp,
      });
    },
  };
}

module.exports = {
  createDefaultLearningState,
  createLearningStateTools,
  normalizeTaskScriptPlan,
};
