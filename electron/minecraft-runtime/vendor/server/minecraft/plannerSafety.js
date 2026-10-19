const { clamp, cloneSerializable } = require("./taskUtils");

const DEFAULT_MAX_PLAN_STEPS = 32;
const DEFAULT_MAX_MISSING_RESOURCES = 16;

function normalizePlannerResult(payload, fallbackReply = "", options = {}) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const maxSteps = clamp(
    Number(options.maxSteps) || DEFAULT_MAX_PLAN_STEPS,
    1,
    DEFAULT_MAX_PLAN_STEPS
  );
  const maxMissingResources = clamp(
    Number(options.maxMissingResources) || DEFAULT_MAX_MISSING_RESOURCES,
    0,
    DEFAULT_MAX_MISSING_RESOURCES
  );
  const mode = payload.mode === "chat" ? "chat" : "task";
  const steps = Array.isArray(payload.steps)
    ? payload.steps
        .slice(0, maxSteps)
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
  return {
    mode,
    intent: String(payload.intent || "").trim() || "generic_task",
    goal: String(payload.goal || "").trim(),
    requiresConfirmation: payload.requiresConfirmation === true,
    steps,
    postTaskMode: payload.postTaskMode === "escort_player" ? "escort_player" : null,
    postTaskArgs:
      payload.postTaskArgs && typeof payload.postTaskArgs === "object"
        ? cloneSerializable(payload.postTaskArgs, {}) || {}
        : null,
    missingResources: Array.isArray(payload.missingResources)
      ? payload.missingResources
          .slice(0, maxMissingResources)
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [],
    safetyRisk: String(payload.safetyRisk || "").trim(),
    replyText: String(payload.replyText || fallbackReply || "").trim(),
    reasoning: String(payload.reasoning || "").trim().slice(0, 1200),
    planSummary: String(payload.planSummary || "").trim().slice(0, 400),
    scriptlet:
      typeof payload.scriptlet === "string"
        ? payload.scriptlet.slice(0, 8000)
        : typeof payload.jsScript === "string"
          ? payload.jsScript.slice(0, 8000)
          : "",
    scriptMeta:
      payload.scriptMeta && typeof payload.scriptMeta === "object"
        ? cloneSerializable(payload.scriptMeta, {}) || {}
        : null,
    resumeFromStepIndex: (() => {
      const raw = payload.resumeFromStepIndex ?? payload.resume_step_index;
      if (raw === undefined || raw === null || String(raw).trim() === "") {
        return null;
      }
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n) || !steps.length) {
        return null;
      }
      return clamp(n, 0, Math.max(0, steps.length - 1));
    })(),
  };
}

function getRegistryActionIdSet(actionRegistry) {
  return new Set(
    (actionRegistry?.listActions?.() || [])
      .map((action) => String(action?.actionId || "").trim())
      .filter(Boolean)
  );
}

function collectInvalidPlanStepSkills(plan, actionRegistry) {
  const allowed = getRegistryActionIdSet(actionRegistry);
  const bad = [];
  for (const step of plan?.steps || []) {
    const id = String(step?.skill || "").trim();
    if (id && !allowed.has(id)) {
      bad.push(id);
    }
  }
  return Array.from(new Set(bad));
}

function getPlanApprovalReasons(plan) {
  const reasons = [];
  if (plan?.requiresConfirmation === true) {
    reasons.push("模型要求用户确认");
  }
  const safetyRisk = String(plan?.safetyRisk || "").trim();
  if (safetyRisk) {
    reasons.push(`安全风险：${safetyRisk}`);
  }
  const missingResources = Array.isArray(plan?.missingResources)
    ? plan.missingResources.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (missingResources.length) {
    reasons.push(`缺少资源：${missingResources.join("、")}`);
  }
  return reasons;
}

function rejectPlannerScriptlet(source = "") {
  if (String(source || "").trim()) {
    throw new Error("出于安全原因，Minecraft 任务规划器不再支持 JavaScript scriptlet");
  }
}

function materializePlannerScriptlet(plan) {
  const scriptlet = String(plan?.scriptlet || "").trim();
  rejectPlannerScriptlet(scriptlet);
  return plan;
}

function shouldAttemptAiRefinement(heuristicPlan) {
  if (!heuristicPlan || heuristicPlan.mode !== "task") {
    return false;
  }
  return ["build_small_house", "mine_diamond_resource", "craft_item"].includes(
    String(heuristicPlan.intent || "").trim()
  );
}

function createPlannerSafety(actionRegistry) {
  return {
    collectInvalidPlanStepSkills: (plan) => collectInvalidPlanStepSkills(plan, actionRegistry),
    getPlanApprovalReasons,
    getRegistryActionIdSet: () => getRegistryActionIdSet(actionRegistry),
    materializePlannerScriptlet,
    normalizePlannerResult,
    rejectPlannerScriptlet,
    shouldAttemptAiRefinement,
  };
}

module.exports = {
  collectInvalidPlanStepSkills,
  createPlannerSafety,
  getPlanApprovalReasons,
  getRegistryActionIdSet,
  materializePlannerScriptlet,
  normalizePlannerResult,
  rejectPlannerScriptlet,
  shouldAttemptAiRefinement,
};
