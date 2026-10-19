function publicBackgroundAgenda(
  backgroundAgenda = null,
  { strictExecutor = false, suppressedByForeground = false } = {}
) {
  if (!backgroundAgenda) {
    return null;
  }
  return {
    intent: String(backgroundAgenda.intent || "").trim() || null,
    goal: String(backgroundAgenda.goal || "").trim() || "",
    phase: String(backgroundAgenda.phase || "").trim() || null,
    replyText: String(backgroundAgenda.replyText || "").trim() || "",
    updatedAt: Number(backgroundAgenda.updatedAt || 0) || null,
    suppressed: strictExecutor || suppressedByForeground === true,
  };
}

function createBackgroundAgenda(plan = null, { phase = "wait", now = Date.now() } = {}) {
  if (!plan || typeof plan !== "object") {
    return null;
  }
  return {
    intent: String(plan.intent || "").trim() || null,
    goal: String(plan.goal || "").trim() || "",
    phase: String(phase || plan.phase || "wait").trim() || "wait",
    replyText: String(plan.replyText || "").trim() || "",
    updatedAt: Number(now || 0) || Date.now(),
  };
}

function getPassiveEscortGoalText(passiveEscort = null) {
  if (!passiveEscort) {
    return "";
  }
  const playerLabel = passiveEscort.playerName || "玩家";
  return passiveEscort.lastHostileName
    ? `正在自动护卫 ${playerLabel}，并处理 ${passiveEscort.lastHostileName}`
    : `正在自动回到 ${playerLabel} 身边并护卫`;
}

function getAutonomousGoalText({
  currentTask = null,
  autonomousState = null,
  phaseLabels = {},
} = {}) {
  if (currentTask?.source === "autonomous") {
    return currentTask.progressText || currentTask.plan?.goal || "";
  }
  const lastPhase = String(autonomousState?.lastPhase || "").trim();
  if (!lastPhase) {
    return "";
  }
  const label = phaseLabels[lastPhase] || lastPhase;
  return `正在自动发育：${label}`;
}

function isBackgroundAgendaFresh(
  backgroundAgenda = null,
  backgroundAgendaPlan = null,
  { now = Date.now(), maxAgeMs = 3 * 60 * 1000 } = {}
) {
  return Boolean(
    backgroundAgendaPlan &&
      backgroundAgenda &&
      Number(now || 0) - Number(backgroundAgenda.updatedAt || 0) < Number(maxAgeMs || 0)
  );
}

module.exports = {
  createBackgroundAgenda,
  getAutonomousGoalText,
  getPassiveEscortGoalText,
  isBackgroundAgendaFresh,
  publicBackgroundAgenda,
};
