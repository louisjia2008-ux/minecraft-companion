function cloneSerializable(value, fallback = null) {
  if (value == null) {
    return fallback;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function createMinecraftBrain(options = {}) {
  const notify = typeof options.onStateChange === "function" ? options.onStateChange : () => {};
  const state = {
    turnState: null,
    turnKind: null,
    queueDepth: 0,
    inhibitedByReflex: false,
    inhibitReason: null,
    currentTaskId: null,
    currentIntent: null,
    lastTurnStartedAt: 0,
    lastTurnCompletedAt: 0,
    lastTurnStatus: null,
    lastFailureCode: null,
    lastLearnReason: null,
    lastQueuedSource: null,
    currentRegistryAction: null,
    actionContractType: null,
  };

  function emitChange() {
    try {
      notify();
    } catch (_) {}
  }

  function enqueueTurn(meta = {}) {
    state.queueDepth += 1;
    state.lastQueuedSource = String(meta.source || meta.kind || "").trim() || null;
    emitChange();
  }

  function beginTurn(task = null, turnState = "observe", meta = {}) {
    state.queueDepth = Math.max(0, Number(state.queueDepth || 0) - 1);
    state.turnState = String(turnState || "").trim() || "observe";
    state.turnKind = String(meta.kind || task?.source || "").trim() || null;
    state.currentTaskId = String(task?.taskId || meta.taskId || "").trim() || null;
    state.currentIntent = String(task?.intent || meta.intent || "").trim() || null;
    state.lastTurnStartedAt = Date.now();
    state.lastTurnStatus = "running";
    emitChange();
  }

  function advanceTurn(task = null, turnState = "", meta = {}) {
    state.turnState = String(turnState || "").trim() || state.turnState || "observe";
    state.currentTaskId = String(task?.taskId || meta.taskId || state.currentTaskId || "").trim() || null;
    state.currentIntent = String(task?.intent || meta.intent || state.currentIntent || "").trim() || null;
    if (typeof meta.inhibitedByReflex === "boolean") {
      state.inhibitedByReflex = meta.inhibitedByReflex;
    }
    if (typeof meta.inhibitReason === "string") {
      state.inhibitReason = meta.inhibitReason.trim() || null;
    }
    emitChange();
  }

  function setInhibitedByReflex(inhibited = false, reason = "") {
    state.inhibitedByReflex = inhibited === true;
    state.inhibitReason = String(reason || "").trim() || null;
    emitChange();
  }

  function setRegistryAction(action = null, meta = {}) {
    state.currentRegistryAction = action ? cloneSerializable(action, {}) || {} : null;
    state.actionContractType = String(
      meta.contractType || action?.contractType || state.actionContractType || ""
    ).trim() || null;
    emitChange();
  }

  function clearRegistryAction() {
    state.currentRegistryAction = null;
    state.actionContractType = null;
    emitChange();
  }

  function recordLearning(reason = "") {
    state.lastLearnReason = String(reason || "").trim() || null;
    emitChange();
  }

  function completeTurn(task = null, meta = {}) {
    state.lastTurnCompletedAt = Date.now();
    state.lastTurnStatus = String(meta.status || "completed").trim() || "completed";
    state.lastFailureCode = null;
    state.currentTaskId = String(task?.taskId || meta.taskId || state.currentTaskId || "").trim() || null;
    if (meta.clearRegistryAction !== false) {
      state.currentRegistryAction = null;
      state.actionContractType = null;
    }
    emitChange();
  }

  function failTurn(task = null, code = "", meta = {}) {
    state.lastTurnCompletedAt = Date.now();
    state.lastTurnStatus = String(meta.status || "failed").trim() || "failed";
    state.lastFailureCode = String(code || "").trim() || null;
    state.currentTaskId = String(task?.taskId || meta.taskId || state.currentTaskId || "").trim() || null;
    if (meta.clearRegistryAction !== false) {
      state.currentRegistryAction = null;
      state.actionContractType = null;
    }
    emitChange();
  }

  function getSnapshot() {
    return cloneSerializable(state, {}) || {};
  }

  return {
    enqueueTurn,
    beginTurn,
    advanceTurn,
    setInhibitedByReflex,
    setRegistryAction,
    clearRegistryAction,
    recordLearning,
    completeTurn,
    failTurn,
    getSnapshot,
  };
}

module.exports = {
  createMinecraftBrain,
};
