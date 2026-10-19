const { cloneSerializable, limitArray } = require("./taskUtils");

function publicTaskLog(log) {
  if (!log) {
    return null;
  }
  return {
    id: log.id,
    taskId: log.taskId,
    level: log.level,
    message: log.message,
    timestamp: log.timestamp,
    stepIndex: Number.isFinite(log.stepIndex) ? log.stepIndex : null,
  };
}

function getTaskPublicScriptMeta(task) {
  const base =
    task?.plan?.scriptMeta && typeof task.plan.scriptMeta === "object"
      ? cloneSerializable(task.plan.scriptMeta, {}) || {}
      : {};
  if (task?.activeStageScript && typeof task.activeStageScript === "object") {
    return {
      ...base,
      activeStageKey: String(task.activeStageScript.key || "").trim() || null,
      activeStageRevision: Number(task.activeStageScript.revision || 0) || 0,
      activeStageKind: String(task.activeStageScript.stageKind || "").trim() || null,
      activeStageSource: String(task.activeStageScript.source || "").trim() || null,
      revisionReason:
        String(task.activeStageScript.revisionReason || "").trim() ||
        base.revisionReason ||
        null,
    };
  }
  return Object.keys(base).length ? base : null;
}

function publicTaskLogs(logs, limit = 20) {
  return limitArray(logs || [], limit).map(publicTaskLog).filter(Boolean);
}

function publicPhysicalAction(action) {
  if (!action) {
    return null;
  }
  return {
    id: String(action.id || "").trim(),
    kind: String(action.kind || "").trim(),
    primitive: String(action.primitive || "").trim(),
    stageKind: String(action.stageKind || "").trim() || null,
    ownerTaskId: String(action.ownerTaskId || "").trim() || null,
    stepIndex: Number.isFinite(action.stepIndex) ? action.stepIndex : null,
    startedAt: Number(action.startedAt || 0) || null,
    firstSignalAt: Number(action.firstSignalAt || 0) || null,
    lastSignalAt: Number(action.lastSignalAt || 0) || null,
    physicalSignal: String(action.physicalSignal || "").trim() || null,
    lastPositionDelta: Number.isFinite(action.lastPositionDelta)
      ? Number(action.lastPositionDelta.toFixed(3))
      : null,
    lastDistanceDelta: Number.isFinite(action.lastDistanceDelta)
      ? Number(action.lastDistanceDelta.toFixed(3))
      : null,
    recoveryReason: String(action.recoveryReason || "").trim() || null,
  };
}

function createTaskPublicStateTools(options = {}) {
  const turnPhaseLabels = options.turnPhaseLabels || {};
  const getTaskDiagnostics =
    typeof options.getTaskDiagnostics === "function"
      ? options.getTaskDiagnostics
      : () => null;
  const getActivePhysicalAction =
    typeof options.getActivePhysicalAction === "function"
      ? options.getActivePhysicalAction
      : () => null;

  function publicTaskSummary(task) {
    if (!task) {
      return null;
    }
    return {
      taskId: task.taskId,
      source: task.source,
      userCommand: task.userCommand,
      intent: task.intent,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt || null,
      finishedAt: task.finishedAt || null,
      progressText: task.progressText || "",
      error: task.error || "",
      replyText: task.replyText || "",
      recoveryCount: Number.isFinite(task.recoveryCount) ? task.recoveryCount : 0,
      aiMidTaskRevisionCount: Number.isFinite(task.aiMidTaskRevisionCount)
        ? task.aiMidTaskRevisionCount
        : 0,
      escortState: String(task.escortState || "").trim() || null,
      combatReadiness: String(task.combatReadiness || "").trim() || null,
      lastGuardScanResult: String(task.lastGuardScanResult || "").trim() || null,
      actionContractType: String(task.actionContractType || "").trim() || null,
      currentRegistryAction:
        task.currentRegistryAction && typeof task.currentRegistryAction === "object"
          ? cloneSerializable(task.currentRegistryAction, {}) || {}
          : null,
      turnPhase: String(task.turnPhase || "").trim() || null,
      turnPhaseLabel:
        task.turnPhase && turnPhaseLabels[task.turnPhase]
          ? turnPhaseLabels[task.turnPhase]
          : null,
      plan: task.plan?.goal
        ? {
            goal: task.plan.goal,
          }
        : null,
      scriptEngine:
        task.scriptEngine && typeof task.scriptEngine === "object"
          ? cloneSerializable(task.scriptEngine, {}) || null
          : null,
      scriptMatch:
        task.scriptMatch && typeof task.scriptMatch === "object"
          ? cloneSerializable(task.scriptMatch, {}) || null
          : null,
      reconnectState:
        task.reconnectState && typeof task.reconnectState === "object"
          ? cloneSerializable(task.reconnectState, {}) || null
          : null,
      diagnostics: getTaskDiagnostics(task),
      scriptMeta: task.activeStageScript
        ? {
            activeStageKey: String(task.activeStageScript.key || "").trim() || null,
            activeStageRevision: Number(task.activeStageScript.revision || 0) || 0,
            activeStageKind: String(task.activeStageScript.stageKind || "").trim() || null,
            activeStageSource: String(task.activeStageScript.source || "").trim() || null,
            revisionReason:
              String(task.activeStageScript.revisionReason || "").trim() || null,
          }
        : getTaskPublicScriptMeta(task),
    };
  }

  function publicTask(task) {
    if (!task) {
      return null;
    }
    const activePhysicalAction = getActivePhysicalAction();
    return {
      taskId: task.taskId,
      source: task.source,
      userCommand: task.userCommand,
      intent: task.intent,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt || null,
      finishedAt: task.finishedAt || null,
      currentStep: task.currentStep,
      currentStepIndex: Number.isFinite(task.currentStepIndex)
        ? task.currentStepIndex
        : null,
      progressText: task.progressText || "",
      error: task.error || "",
      plan: task.plan || null,
      scriptMeta: getTaskPublicScriptMeta(task),
      scriptEngine:
        task.scriptEngine && typeof task.scriptEngine === "object"
          ? cloneSerializable(task.scriptEngine, {}) || null
          : null,
      scriptMatch:
        task.scriptMatch && typeof task.scriptMatch === "object"
          ? cloneSerializable(task.scriptMatch, {}) || null
          : null,
      reconnectState:
        task.reconnectState && typeof task.reconnectState === "object"
          ? cloneSerializable(task.reconnectState, {}) || null
          : null,
      diagnostics: getTaskDiagnostics(task),
      contextSnapshot: null,
      replyText: task.replyText || "",
      recoveryCount: Number.isFinite(task.recoveryCount) ? task.recoveryCount : 0,
      aiMidTaskRevisionCount: Number.isFinite(task.aiMidTaskRevisionCount)
        ? task.aiMidTaskRevisionCount
        : 0,
      turnPhase: String(task.turnPhase || "").trim() || null,
      turnPhaseLabel:
        task.turnPhase && turnPhaseLabels[task.turnPhase]
          ? turnPhaseLabels[task.turnPhase]
          : null,
      actionState: String(task.actionState || "").trim() || null,
      stageKind: String(task.stageKind || "").trim() || null,
      stepCheckpoint:
        task.stepCheckpoint && typeof task.stepCheckpoint === "object"
          ? cloneSerializable(task.stepCheckpoint, {}) || {}
          : null,
      playbookPhase: String(task.stepCheckpoint?.playbookPhase || "").trim() || null,
      playbookStepLabel: String(task.stepCheckpoint?.playbookStepLabel || "").trim() || null,
      materialSummary:
        task.stepCheckpoint?.materialSummary && typeof task.stepCheckpoint.materialSummary === "object"
          ? cloneSerializable(task.stepCheckpoint.materialSummary, {}) || null
          : null,
      verificationSummary:
        task.stepCheckpoint?.verificationSummary && typeof task.stepCheckpoint.verificationSummary === "object"
          ? cloneSerializable(task.stepCheckpoint.verificationSummary, {}) || null
          : null,
      waitingForPhysicalSignalSince: Number(task.waitingForPhysicalSignalSince || 0) || null,
      lastHeartbeatAt: Number(task.lastHeartbeatAt || 0) || null,
      lastPhysicalHeartbeatAt: Number(task.lastPhysicalHeartbeatAt || 0) || null,
      lastPrimitiveStartedAt: Number(task.lastPrimitiveStartedAt || 0) || null,
      lastRecoveryReason: String(task.lastRecoveryReason || "").trim() || null,
      escortState: String(task.escortState || "").trim() || null,
      combatReadiness: String(task.combatReadiness || "").trim() || null,
      lastGuardScanResult: String(task.lastGuardScanResult || "").trim() || null,
      actionContractType: String(task.actionContractType || "").trim() || null,
      currentRegistryAction:
        task.currentRegistryAction && typeof task.currentRegistryAction === "object"
          ? cloneSerializable(task.currentRegistryAction, {}) || {}
          : null,
      activeAction:
        activePhysicalAction && activePhysicalAction.ownerTaskId === task.taskId
          ? publicPhysicalAction(activePhysicalAction)
          : null,
      logs: publicTaskLogs(task.logs || [], 20),
    };
  }

  return {
    getTaskPublicScriptMeta,
    publicTaskLog,
    publicTaskLogs,
    publicPhysicalAction,
    publicTask,
    publicTaskSummary,
  };
}

module.exports = {
  createTaskPublicStateTools,
  getTaskPublicScriptMeta,
  publicPhysicalAction,
  publicTaskLog,
  publicTaskLogs,
};
