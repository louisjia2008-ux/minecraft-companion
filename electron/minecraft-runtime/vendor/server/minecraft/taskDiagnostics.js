const fs = require("fs");
const path = require("path");
const { cloneSerializable } = require("./taskUtils");

function createTaskDiagnostics(options = {}) {
  const diagnosticsDir = String(options.diagnosticsDir || "").trim();
  const broadcastMinecraftError =
    typeof options.broadcastMinecraftError === "function"
      ? options.broadcastMinecraftError
      : () => {};
  const getBotWriteSnapshot =
    typeof options.getBotWriteSnapshot === "function"
      ? options.getBotWriteSnapshot
      : () => null;
  let lastTaskDiagnostics = null;

  function getTaskDiagnosticsPath(taskId = "") {
    const safeId = String(taskId || "task")
      .replace(/[^a-z0-9_.-]+/gi, "_")
      .slice(0, 80);
    return path.join(diagnosticsDir, `${safeId || "task"}-${Date.now().toString(36)}.jsonl`);
  }

  function writeJsonLine(filePath, payload) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
      return true;
    } catch (error) {
      broadcastMinecraftError(`Minecraft 任务诊断写入失败：${error?.message || error}`);
      return false;
    }
  }

  function publicTaskDiagnostics(task = null) {
    const diag = task ? task.diagnostics : lastTaskDiagnostics;
    if (!diag || typeof diag !== "object") {
      return null;
    }
    return {
      traceId: String(diag.traceId || "").trim() || null,
      tracePath: String(diag.tracePath || "").trim() || null,
      startedAt: Number(diag.startedAt || 0) || null,
      finishedAt: Number(diag.finishedAt || 0) || null,
      eventCount: Number(diag.eventCount || 0) || 0,
      lastEvent: String(diag.lastEvent || "").trim() || null,
      lastError: String(diag.lastError || "").trim() || null,
      lastDisconnectSource: String(diag.lastDisconnectSource || "").trim() || null,
      lastWrite:
        diag.lastWrite && typeof diag.lastWrite === "object"
          ? cloneSerializable(diag.lastWrite, {}) || null
          : null,
    };
  }

  function startTaskDiagnostics(task, trigger = "task_created") {
    if (!task) {
      return null;
    }
    const traceId = `${task.taskId || "task"}-${Date.now().toString(36)}`;
    task.diagnostics = {
      traceId,
      tracePath: getTaskDiagnosticsPath(task.taskId || traceId),
      startedAt: Date.now(),
      finishedAt: null,
      eventCount: 0,
      lastEvent: null,
      lastError: null,
      lastDisconnectSource: null,
      lastWrite: null,
    };
    lastTaskDiagnostics = publicTaskDiagnostics(task);
    recordTaskDiagnostic(task, trigger, {
      command: task.userCommand,
      source: task.source,
    });
    return task.diagnostics;
  }

  function recordTaskDiagnostic(task, eventType = "", details = {}) {
    if (!task?.diagnostics) {
      return null;
    }
    const normalizedEvent = String(eventType || "event").trim() || "event";
    const lastWrite = getBotWriteSnapshot();
    const entry = {
      at: Date.now(),
      event: normalizedEvent,
      taskId: task.taskId || null,
      status: task.status || null,
      source: task.source || null,
      intent: task.intent || task.plan?.intent || null,
      currentStep: task.currentStep || null,
      currentStepIndex: Number.isFinite(task.currentStepIndex) ? task.currentStepIndex : null,
      actionState: task.actionState || null,
      recoveryCount: Number(task.recoveryCount || 0) || 0,
      aiMidTaskRevisionCount: Number(task.aiMidTaskRevisionCount || 0) || 0,
      scriptMeta:
        task.plan?.scriptMeta && typeof task.plan.scriptMeta === "object"
          ? cloneSerializable(task.plan.scriptMeta, {}) || null
          : null,
      activeStageScript:
        task.activeStageScript && typeof task.activeStageScript === "object"
          ? cloneSerializable(task.activeStageScript, {}) || null
          : null,
      reconnectState:
        task.reconnectState && typeof task.reconnectState === "object"
          ? cloneSerializable(task.reconnectState, {}) || null
          : null,
      scriptEngine:
        task.scriptEngine && typeof task.scriptEngine === "object"
          ? cloneSerializable(task.scriptEngine, {}) || null
          : null,
      lastWrite,
      details: cloneSerializable(details, {}) || {},
    };
    task.diagnostics.eventCount = Number(task.diagnostics.eventCount || 0) + 1;
    task.diagnostics.lastEvent = normalizedEvent;
    task.diagnostics.lastWrite = lastWrite;
    const errorText = String(details?.error || details?.message || "").trim();
    if (/fail|error|disconnect|reconnect|blocked|epipe|socket/i.test(normalizedEvent) || errorText) {
      task.diagnostics.lastError = errorText || String(details?.reason || normalizedEvent).trim();
    }
    const disconnectSource = String(details?.detailSource || details?.disconnectSource || "").trim();
    if (disconnectSource) {
      task.diagnostics.lastDisconnectSource = disconnectSource;
    }
    writeJsonLine(task.diagnostics.tracePath, entry);
    lastTaskDiagnostics = publicTaskDiagnostics(task);
    return entry;
  }

  function finishTaskDiagnostics(task, outcome = "") {
    if (!task?.diagnostics) {
      return;
    }
    task.diagnostics.finishedAt = Date.now();
    recordTaskDiagnostic(task, "task_finished", {
      outcome,
      error: task.error || "",
      errorCode: task.errorCode || "",
    });
    lastTaskDiagnostics = publicTaskDiagnostics(task);
  }

  return {
    finishTaskDiagnostics,
    getLastTaskDiagnostics: () => publicTaskDiagnostics(),
    getTaskDiagnosticsPath,
    publicTaskDiagnostics,
    recordTaskDiagnostic,
    startTaskDiagnostics,
    writeJsonLine,
  };
}

module.exports = {
  createTaskDiagnostics,
};
