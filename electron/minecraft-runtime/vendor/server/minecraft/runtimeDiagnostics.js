const fs = require("fs");
const path = require("path");
const { cloneSerializable, limitArray } = require("./taskUtils");

function describeRuntimeFaultMessage(error) {
  return String(error?.message || error || "未知运行时错误").trim() || "未知运行时错误";
}

function createRuntimeDiagnostics(options = {}) {
  const disconnectTracePath = String(options.disconnectTracePath || "").trim();
  const getCurrentTask =
    typeof options.getCurrentTask === "function" ? options.getCurrentTask : () => null;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  let lastDisconnectEventTrail = [];
  let lastRuntimeFault = "";
  let lastRuntimeFaultAt = 0;
  let lastBotWritePrimitive = "";
  let lastBotWriteAt = 0;
  let lastBotWriteContext = null;

  function recordRuntimeFault(code = "runtime_fault", error = null) {
    const normalizedCode = String(code || "runtime_fault").trim() || "runtime_fault";
    const message = describeRuntimeFaultMessage(error);
    lastRuntimeFault = `${normalizedCode}: ${message}`;
    lastRuntimeFaultAt = now();
    return {
      reason: lastRuntimeFault,
      code: normalizedCode,
      message,
      at: lastRuntimeFaultAt,
    };
  }

  function resetRuntimeFault() {
    lastRuntimeFault = "";
    lastRuntimeFaultAt = 0;
  }

  function getRuntimeFaultSnapshot() {
    return {
      reason: String(lastRuntimeFault || "").trim() || "",
      at: Number(lastRuntimeFaultAt || 0) || 0,
    };
  }

  function getBotWriteSnapshot() {
    return {
      primitive: String(lastBotWritePrimitive || "").trim() || "",
      at: Number(lastBotWriteAt || 0) || 0,
      context:
        lastBotWriteContext && typeof lastBotWriteContext === "object"
          ? cloneSerializable(lastBotWriteContext, {}) || {}
          : null,
    };
  }

  function resetBotWrite() {
    lastBotWritePrimitive = "";
    lastBotWriteAt = 0;
    lastBotWriteContext = null;
  }

  function getDisconnectEventTrail() {
    return Array.isArray(lastDisconnectEventTrail)
      ? lastDisconnectEventTrail.map((event) => cloneSerializable(event, {}) || {})
      : [];
  }

  function resetDisconnectEventTrail() {
    lastDisconnectEventTrail = [];
  }

  function rememberDisconnectEvent(eventType = "", detail = "", extra = {}) {
    const task = getCurrentTask();
    const normalized =
      cloneSerializable(
        {
          at: now(),
          type: String(eventType || "").trim() || "disconnect_event",
          detail: String(detail || "").trim() || "",
          taskId: task?.taskId || null,
          currentStep: task?.currentStep || null,
          actionState: task?.actionState || null,
          lastRecoveryReason: task?.lastRecoveryReason || null,
          lastBotWritePrimitive: String(lastBotWritePrimitive || "").trim() || null,
          lastBotWriteAt: Number(lastBotWriteAt || 0) || null,
          ...extra,
        },
        {}
      ) || {};
    lastDisconnectEventTrail = limitArray([...(lastDisconnectEventTrail || []), normalized], 12);
    if (disconnectTracePath) {
      try {
        fs.mkdirSync(path.dirname(disconnectTracePath), { recursive: true });
        fs.appendFileSync(disconnectTracePath, `${JSON.stringify(normalized)}\n`, "utf8");
      } catch (_) {}
    }
    return normalized;
  }

  function rememberBotWrite(primitive = "", context = {}) {
    const task = getCurrentTask();
    lastBotWritePrimitive = String(primitive || "").trim() || "";
    lastBotWriteAt = now();
    lastBotWriteContext =
      context && typeof context === "object"
        ? cloneSerializable(
            {
              taskId: task?.taskId || null,
              currentStep: task?.currentStep || null,
              actionState: task?.actionState || null,
              lastRecoveryReason: task?.lastRecoveryReason || null,
              ...context,
            },
            {}
          ) || null
        : null;
    return getBotWriteSnapshot();
  }

  function exportState() {
    return cloneSerializable(
      {
        lastDisconnectEventTrail,
        lastRuntimeFault,
        lastRuntimeFaultAt,
        lastBotWritePrimitive,
        lastBotWriteAt,
        lastBotWriteContext,
      },
      {}
    ) || {};
  }

  function importState(state = {}) {
    lastDisconnectEventTrail = Array.isArray(state.lastDisconnectEventTrail)
      ? state.lastDisconnectEventTrail.map((event) => cloneSerializable(event, {}) || {})
      : [];
    lastRuntimeFault = String(state.lastRuntimeFault || "").trim();
    lastRuntimeFaultAt = Number(state.lastRuntimeFaultAt || 0) || 0;
    lastBotWritePrimitive = String(state.lastBotWritePrimitive || "").trim();
    lastBotWriteAt = Number(state.lastBotWriteAt || 0) || 0;
    lastBotWriteContext =
      state.lastBotWriteContext && typeof state.lastBotWriteContext === "object"
        ? cloneSerializable(state.lastBotWriteContext, {}) || null
        : null;
  }

  return {
    describeRuntimeFaultMessage,
    exportState,
    getBotWriteSnapshot,
    getDisconnectEventTrail,
    getRuntimeFaultSnapshot,
    importState,
    recordRuntimeFault,
    rememberBotWrite,
    rememberDisconnectEvent,
    resetBotWrite,
    resetDisconnectEventTrail,
    resetRuntimeFault,
  };
}

module.exports = {
  createRuntimeDiagnostics,
  describeRuntimeFaultMessage,
};
