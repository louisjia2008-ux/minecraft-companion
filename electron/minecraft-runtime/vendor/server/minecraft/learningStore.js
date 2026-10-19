const fs = require("fs");
const path = require("path");
const { atomicWriteJson } = require('./atomicJsonStore');
const {
  createDefaultLearningState,
} = require("./learningState");

function migrateLegacyLearningStateIfNeeded(options = {}) {
  const learningStatePath = String(options.learningStatePath || "").trim();
  const legacyLearningStatePath = String(options.legacyLearningStatePath || "").trim();
  if (!learningStatePath || !legacyLearningStatePath) {
    return false;
  }
  if (options.envLearningPath) {
    return false;
  }
  if (path.resolve(legacyLearningStatePath) === path.resolve(learningStatePath)) {
    return false;
  }
  if (!fs.existsSync(legacyLearningStatePath) || fs.existsSync(learningStatePath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(learningStatePath), { recursive: true });
  fs.copyFileSync(legacyLearningStatePath, learningStatePath);
  const backupPath = path.join(
    path.dirname(learningStatePath),
    "minecraft-agent-learning.legacy-backup.json"
  );
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(legacyLearningStatePath, backupPath);
  }
  return true;
}

function createLearningStateStore(options = {}) {
  const learningStatePath = String(options.learningStatePath || "").trim();
  const legacyLearningStatePath = String(options.legacyLearningStatePath || "").trim();
  const normalizeLearningState = options.normalizeLearningState;
  const broadcastMinecraftError = options.broadcastMinecraftError;
  const now = options.now || Date.now;
  const saveDelayMs = Math.max(0, Number(options.saveDelayMs) || 250);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let learningSaveTimer = null;
  let pendingState = null;
  let writable = true;

  function load() {
    try {
      const migratedLegacy = migrateLegacyLearningStateIfNeeded({
        learningStatePath,
        legacyLearningStatePath,
        envLearningPath: options.getEnvLearningPath?.() || process.env.MC_AGENT_LEARNING_PATH,
      });
      if (!learningStatePath || !fs.existsSync(learningStatePath)) {
        return {
          state: createDefaultLearningState(),
          raw: null,
          migratedLegacy,
          shouldSave: false,
        };
      }
      const raw = JSON.parse(fs.readFileSync(learningStatePath, "utf8"));
      const state =
        typeof normalizeLearningState === "function"
          ? normalizeLearningState(raw)
          : raw;
      const shouldSave = migratedLegacy || Number(raw?.schemaVersion || 0) < 2;
      if (shouldSave) {
        state.migratedAt = now();
      }
      return {
        state,
        raw,
        migratedLegacy,
        shouldSave,
      };
    } catch (error) {
      writable = false;
      broadcastMinecraftError?.(
        `Minecraft 学习档读取失败，回退空学习状态：${error?.message || error}`
      );
      return {
        state: createDefaultLearningState(),
        raw: null,
        migratedLegacy: false,
        shouldSave: false,
        error,
      };
    }
  }

  function flush() {
    if (learningSaveTimer) clearTimer(learningSaveTimer);
    learningSaveTimer = null;
    if (!pendingState) return true;
    if (!writable) {
      broadcastMinecraftError?.('Minecraft 学习档不可读，保留原文件并拒绝覆盖；需要先恢复有效档案。');
      return false;
    }
    try {
      const state = typeof pendingState === 'function' ? pendingState() : pendingState;
      atomicWriteJson(learningStatePath, state);
      pendingState = null;
      return true;
    } catch (error) {
      broadcastMinecraftError?.(`Minecraft 学习档保存失败：${error?.message || error}`);
      return false;
    }
  }

  function scheduleSave(getState) {
    pendingState = getState;
    if (learningSaveTimer) {
      clearTimer(learningSaveTimer);
    }
    learningSaveTimer = setTimer(() => {
      learningSaveTimer = null;
      flush();
    }, saveDelayMs);
  }

  function dispose() {
    return flush();
  }

  return {
    load,
    scheduleSave,
    flush,
    dispose,
  };
}

module.exports = {
  createLearningStateStore,
  migrateLegacyLearningStateIfNeeded,
};
