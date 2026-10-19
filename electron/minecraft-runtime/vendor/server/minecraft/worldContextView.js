const { cloneSerializable } = require("./taskUtils");

function formatBrainContext(brainSnapshot = {}) {
  return {
    turnState: String(brainSnapshot.turnState || "").trim() || null,
    turnKind: String(brainSnapshot.turnKind || "").trim() || null,
    queueDepth: Number(brainSnapshot.queueDepth || 0) || 0,
    inhibitedByReflex: brainSnapshot.inhibitedByReflex === true,
    inhibitReason: String(brainSnapshot.inhibitReason || "").trim() || null,
    currentTaskId: String(brainSnapshot.currentTaskId || "").trim() || null,
    currentIntent: String(brainSnapshot.currentIntent || "").trim() || null,
    lastTurnStatus: String(brainSnapshot.lastTurnStatus || "").trim() || null,
    lastFailureCode: String(brainSnapshot.lastFailureCode || "").trim() || null,
    lastLearnReason: String(brainSnapshot.lastLearnReason || "").trim() || null,
  };
}

function formatActionContext(activeRegistryAction = null, actionContractType = "") {
  return {
    currentRegistryAction:
      activeRegistryAction && typeof activeRegistryAction === "object"
        ? cloneSerializable(activeRegistryAction, {}) || {}
        : null,
    actionContractType: String(actionContractType || "").trim() || null,
  };
}

function buildDisconnectedWorldContext(options = {}) {
  const brainSnapshot = options.brainSnapshot || {};
  return {
    connected: false,
    players: [],
    hostiles: [],
    nearbyBlocks: [],
    inventory: [],
    self: null,
    brain: formatBrainContext(brainSnapshot),
    action: formatActionContext(
      brainSnapshot.currentRegistryAction,
      brainSnapshot.actionContractType
    ),
  };
}

function getFirstText(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function getCurrentGoal(options = {}) {
  return getFirstText(
    options.foregroundTask?.progressText,
    options.foregroundTask?.plan?.goal,
    options.backgroundTask?.progressText,
    options.backgroundTask?.plan?.goal,
    options.backgroundAgenda?.goal,
    options.passiveEscortGoalText,
    options.autonomousGoalText
  );
}

function formatDisconnectReasonText(detailSource = "", disconnectPath = "") {
  const values = [String(detailSource || "").trim(), String(disconnectPath || "").trim()]
    .filter(Boolean)
    .filter((value, index, allValues) => allValues.indexOf(value) === index);
  return values.length ? values.join("：") : null;
}

function buildExecutorContext(options = {}) {
  const foregroundTask = options.foregroundTask || null;
  const backgroundTask = options.backgroundTask || null;
  const currentTask = options.currentTask || null;
  const runtimeFault = options.runtimeFaultSnapshot || {};
  const botWrite = options.botWriteSnapshot || {};
  const activeMovementSession = options.activeMovementSession || null;
  const activeAction = options.activeActionSnapshot || null;
  return {
    mode: String(options.mode || "").trim() || "strict-executor",
    modeSource: String(options.modeSource || "").trim() || "saved",
    autonomyArmedAt: Number(options.autonomyArmedAt || 0) || null,
    autonomySafeUntil: Number(options.autonomySafeUntil || 0) || null,
    lastDisconnectPath: String(options.lastDisconnectPath || "").trim() || null,
    disconnectDetailSource: String(options.disconnectDetailSource || "").trim() || null,
    disconnectReasonText: formatDisconnectReasonText(
      options.disconnectDetailSource,
      options.lastDisconnectPath
    ),
    lastDisconnectEventTrail: Array.isArray(options.lastDisconnectEventTrail)
      ? options.lastDisconnectEventTrail.map((event) => cloneSerializable(event, {}) || {})
      : [],
    lastRuntimeFault: String(runtimeFault.reason || "").trim() || null,
    lastRuntimeFaultAt: Number(runtimeFault.at || 0) || null,
    lastBotWritePrimitive: String(botWrite.primitive || "").trim() || null,
    lastBotWriteAt: Number(botWrite.at || 0) || null,
    lastBotWriteContext:
      botWrite.context && typeof botWrite.context === "object"
        ? cloneSerializable(botWrite.context, {}) || {}
        : null,
    lastSurvivalInterruptAt: Number(options.lastSurvivalInterruptAt || 0) || null,
    movementSessionId: String(activeMovementSession?.id || "").trim() || null,
    movementSessionKind: String(activeMovementSession?.kind || "").trim() || null,
    movementSessionStable: activeMovementSession?.stable === true,
    stepState: getFirstText(
      foregroundTask?.actionState,
      backgroundTask?.actionState,
      currentTask?.actionState
    ) || null,
    lastHeartbeatAt:
      Number(
        foregroundTask?.lastHeartbeatAt ||
          backgroundTask?.lastHeartbeatAt ||
          currentTask?.lastHeartbeatAt ||
          0
      ) || null,
    lastRecoveryReason: getFirstText(
      foregroundTask?.lastRecoveryReason,
      backgroundTask?.lastRecoveryReason,
      currentTask?.lastRecoveryReason
    ) || null,
    activeActionId: activeAction?.id || null,
    activeActionKind: activeAction?.kind || null,
    activePrimitive: activeAction?.primitive || null,
    physicalSignal: activeAction?.physicalSignal || null,
    lastPositionDelta: activeAction?.lastPositionDelta ?? null,
    lastDistanceDelta: activeAction?.lastDistanceDelta ?? null,
    stageRevision:
      Number(
        currentTask?.activeStageScript?.revision ||
          foregroundTask?.scriptMeta?.activeStageRevision ||
          currentTask?.plan?.scriptMeta?.revision ||
          foregroundTask?.scriptMeta?.revision ||
          0
      ) || null,
    waitingForPhysicalSignalSince:
      Number(
        foregroundTask?.waitingForPhysicalSignalSince ||
          backgroundTask?.waitingForPhysicalSignalSince ||
          currentTask?.waitingForPhysicalSignalSince ||
          0
      ) || null,
    recoveryCount:
      Number(
        foregroundTask?.recoveryCount ||
          backgroundTask?.recoveryCount ||
          currentTask?.recoveryCount ||
          0
      ) || 0,
    escortState: getFirstText(
      foregroundTask?.escortState,
      backgroundTask?.escortState,
      currentTask?.escortState
    ) || null,
    combatReadiness: getFirstText(
      foregroundTask?.combatReadiness,
      backgroundTask?.combatReadiness,
      currentTask?.combatReadiness
    ) || null,
    lastGuardScanResult: getFirstText(
      foregroundTask?.lastGuardScanResult,
      backgroundTask?.lastGuardScanResult,
      currentTask?.lastGuardScanResult
    ) || null,
    lastHostileSeenAt:
      Number(
        foregroundTask?.lastHostileSeenAt ||
          backgroundTask?.lastHostileSeenAt ||
          currentTask?.lastHostileSeenAt ||
          0
      ) || null,
  };
}

function buildPlannerContext(config = {}, options = {}) {
  return {
    effectiveAiProvider: String(config.aiProvider || "").trim() || null,
    effectiveAiModel: String(config.aiModel || "").trim() || null,
    providerSource: String(config.aiProviderSource || "").trim() || null,
    mode:
      options.currentTask?.plan?.scriptMeta?.plannerMode ||
      options.backgroundTask?.plan?.scriptMeta?.plannerMode ||
      null,
  };
}

function publicWorldContext(context, options = {}) {
  if (!context || typeof context !== "object") {
    return context;
  }
  const includeHeavy = options.includeHeavy !== false;
  const payload = {
    ...context,
    players: Array.isArray(context.players) ? context.players.slice(0, includeHeavy ? 8 : 4) : [],
    hostiles: Array.isArray(context.hostiles) ? context.hostiles.slice(0, includeHeavy ? 8 : 4) : [],
    nearbyBlocks: Array.isArray(context.nearbyBlocks)
      ? context.nearbyBlocks.slice(0, includeHeavy ? 12 : 6)
      : [],
    inventory: Array.isArray(context.inventory) ? context.inventory.slice(0, includeHeavy ? 32 : 12) : [],
  };
  if (!includeHeavy) {
    delete payload.learning;
    delete payload.recentMemories;
    delete payload.dragonProgression;
  }
  return payload;
}

function buildStatusFields(options = {}) {
  const runtimeFault = options.runtimeFaultSnapshot || {};
  const botWrite = options.botWriteSnapshot || {};
  return {
    agentMode: String(options.agentMode || "idle").trim() || "idle",
    currentTaskId: options.foregroundTask?.taskId || options.currentTask?.taskId || null,
    currentGoal: getCurrentGoal(options),
    inhibitAI: options.inhibitAI === true,
    activeReflex: options.activeReflex || null,
    lastRuntimeFault: String(runtimeFault.reason || "").trim(),
    lastRuntimeFaultAt: Number(runtimeFault.at || 0) || 0,
    lastBotWritePrimitive: String(botWrite.primitive || "").trim(),
    lastBotWriteAt: Number(botWrite.at || 0) || 0,
    lastBotWriteContext:
      botWrite.context && typeof botWrite.context === "object"
        ? cloneSerializable(botWrite.context, {}) || {}
        : null,
    lastDisconnectEventTrail: Array.isArray(options.lastDisconnectEventTrail)
      ? options.lastDisconnectEventTrail.map((event) => cloneSerializable(event, {}) || {})
      : [],
    diagnostics: options.diagnostics || null,
  };
}

module.exports = {
  buildDisconnectedWorldContext,
  buildExecutorContext,
  buildPlannerContext,
  buildStatusFields,
  formatActionContext,
  formatBrainContext,
  formatDisconnectReasonText,
  getCurrentGoal,
  publicWorldContext,
};
