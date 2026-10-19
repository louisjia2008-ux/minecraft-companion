const { TaskState } = require("./taskState");
const { clamp } = require("./taskUtils");

const RECOVERABLE_TASK_ERROR_CODES = Object.freeze([
  "timeout",
  "no_path",
  "target_not_found",
  "resource_not_found",
  "player_not_found",
  "no_hostile_in_range",
  "insufficient_material",
  "executor_stalled",
  "movement_preempted",
  "step_timeout",
  "crop_not_ready",
  "planting_input_missing",
  "generic_failure",
]);

const recoverableTaskErrorCodeSet = new Set(RECOVERABLE_TASK_ERROR_CODES);

function normalizeTaskFailureStatus(status = "") {
  return status === "blocked"
    ? TaskState.BLOCKED
    : status === "failed"
      ? TaskState.FAILED
      : status;
}

function classifyTaskError({
  task = null,
  error = null,
  actionRegistry,
  disconnectDetailSource = "",
  disconnectPath = "",
} = {}) {
  const activeStep = task?.plan?.steps?.[Number(task?.currentStepIndex) || 0] || {};
  const code = String(error?.code || "").trim();
  const message = String(error?.message || error || "").trim();
  if (["socket_not_writable", "bot_connection_lost", "socket_write_epipe"].includes(code)) {
    const disconnectDetail = String(disconnectDetailSource || "").trim();
    const resolvedPath = String(disconnectPath || "").trim();
    const resolvedMessage =
      message && message !== code
        ? message
        : disconnectDetail === "server_kick"
          ? "Minecraft 已被服务器断开，当前任务已停止"
          : disconnectDetail === "socket_write_epipe" || resolvedPath === "socket_write_epipe"
            ? "Minecraft 底层连接已中断，移动/交互写入已被停止"
            : "Minecraft 底层连接已断开，当前任务已停止";
    return {
      status: TaskState.FAILED,
      code,
      message: resolvedMessage,
    };
  }
  const classified = actionRegistry.classifyErrorForStep(activeStep, error);
  return {
    ...classified,
    status: normalizeTaskFailureStatus(classified.status),
  };
}

function buildRecoveryPlan(task, classified, context = {}) {
  const recoveryCount = clamp(Number(task?.recoveryCount) || 0, 0, 12);
  const maxRecoveryAttempts = clamp(Number(task?.maxRecoveryAttempts) || 0, 0, 12);
  if (recoveryCount >= maxRecoveryAttempts) {
    return null;
  }

  const actionRegistry = context.actionRegistry;
  const code = String(classified?.code || "").trim();
  const activeStep = task?.plan?.steps?.[Number(task?.currentStepIndex) || 0] || null;

  if (task?.source === "autonomous") {
    const altPlan =
      typeof context.buildAutonomousMaintenancePlan === "function"
        ? context.buildAutonomousMaintenancePlan({
            excludeIntents: [task.intent],
          })
        : null;
    return altPlan || null;
  }

  if (!recoverableTaskErrorCodeSet.has(code)) {
    return null;
  }

  if (actionRegistry.getRecoveryPolicy(activeStep, code)?.skipRecovery) {
    return null;
  }

  const stageRevisionPlan =
    typeof context.buildStageRevisionPlan === "function"
      ? context.buildStageRevisionPlan(task, classified)
      : null;
  if (stageRevisionPlan) {
    return stageRevisionPlan;
  }

  return actionRegistry.buildRecoveryPlan(task, classified, {
    buildCraftRecoveryPlan: context.buildCraftRecoveryPlan,
    hasDiamondMiningPickaxe: context.hasDiamondMiningPickaxe,
    buildToolProgressionPlan: actionRegistry.buildToolProgressionPlan,
    buildIronPickaxeProgressionSteps: context.buildIronPickaxeProgressionSteps,
    getLearnedSearchRadius: context.getLearnedSearchRadius,
  });
}

function createTaskRecoveryTools(context = {}) {
  return {
    classifyTaskError: (error) =>
      classifyTaskError({
        task: context.getCurrentTask?.() || null,
        error,
        actionRegistry: context.actionRegistry,
        disconnectDetailSource: context.getDisconnectDetailSource?.() || "",
        disconnectPath: context.getDisconnectPath?.() || "",
      }),
    buildRecoveryPlan: (task, classified) =>
      buildRecoveryPlan(task, classified, {
        ...context,
        actionRegistry: context.actionRegistry,
      }),
  };
}

module.exports = {
  RECOVERABLE_TASK_ERROR_CODES,
  buildRecoveryPlan,
  classifyTaskError,
  createTaskRecoveryTools,
  normalizeTaskFailureStatus,
};
