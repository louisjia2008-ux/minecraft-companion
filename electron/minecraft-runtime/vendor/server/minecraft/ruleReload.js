const fs = require("fs");

function createRuleReloadEvent(eventType, label, details = {}, options = {}) {
  const rulesCount = Array.isArray(details.rules) ? details.rules.length : undefined;
  const sourceLabel =
    details.source === "file" ? "YAML 文件" : details.source === "default" ? "内建默认规则" : "";
  const baseMessage =
    eventType === "rules_reload_failed"
      ? `${label}规则热重载失败：${details.errorMessage || "未知错误"}`
      : `${label}规则已热重载${sourceLabel ? `，当前来源：${sourceLabel}` : ""}`;
  return {
    type: "mc_task_event",
    event: {
      eventType,
      taskId: options.taskId || null,
      timestamp: Number(options.timestamp || Date.now()),
      message: baseMessage,
      ruleSet: label,
      rulesCount,
      rulesSource: details.source || null,
      ...(details.errorMessage ? { errorMessage: details.errorMessage } : {}),
    },
  };
}

function createRuleReloadWatcher(options = {}) {
  const debounceMs = Math.max(0, Number(options.debounceMs) || 250);
  const watchFile = options.watchFile || fs.watchFile;
  const unwatchFile = options.unwatchFile || fs.unwatchFile;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const watchedFiles = [];

  function emitRuleReloadEvent(eventType, label, details = {}) {
    options.broadcast?.(
      createRuleReloadEvent(eventType, label, details, {
        taskId: options.getCurrentTaskId?.() || null,
        timestamp: options.now?.() || Date.now(),
      })
    );
  }

  function watchRuleFile(label, filePath, reload) {
    let debounceTimer = null;
    const scheduleReload = () => {
      if (debounceTimer) {
        clearTimer(debounceTimer);
      }
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        try {
          const result = reload();
          if (!result.changed) {
            return;
          }
          emitRuleReloadEvent("rules_reloaded", label, result);
        } catch (error) {
          const errorMessage = error?.message || String(error || "未知错误");
          options.broadcastMinecraftError?.(`Minecraft ${label}规则热重载失败：${errorMessage}`);
          emitRuleReloadEvent("rules_reload_failed", label, { errorMessage });
        }
      }, debounceMs);
    };

    const listener = (current, previous) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size &&
        current.ctimeMs === previous.ctimeMs
      ) {
        return;
      }
      scheduleReload();
    };
    watchFile(filePath, { interval: 500 }, listener);
    watchedFiles.push({ filePath, listener });
    return () => unwatchFile(filePath, listener);
  }

  function dispose() {
    for (const watcher of watchedFiles.splice(0)) {
      unwatchFile(watcher.filePath, watcher.listener);
    }
  }

  return {
    emitRuleReloadEvent,
    watchRuleFile,
    dispose,
  };
}

module.exports = {
  createRuleReloadEvent,
  createRuleReloadWatcher,
};
