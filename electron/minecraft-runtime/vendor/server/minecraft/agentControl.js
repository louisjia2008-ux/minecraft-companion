const { goals } = require("mineflayer-pathfinder");
const { createAbortError, sleep } = require("./taskUtils");

class CancellationToken {
  constructor() {
    this.cancelled = false;
    this.pauseRequested = false;
    this.cancelReason = "cancelled";
  }

  cancel(reason = "cancelled") {
    this.cancelled = true;
    this.cancelReason = String(reason || "cancelled");
  }

  pause() {
    this.pauseRequested = true;
  }

  resume() {
    this.pauseRequested = false;
  }

  throwIfRequested() {
    if (this.cancelled) {
      throw createAbortError(this.cancelReason || "cancelled");
    }
    if (this.pauseRequested) {
      throw createAbortError("paused");
    }
  }
}

class ReflexManager {
  constructor(options = {}) {
    this.options = options;
    this.unsubscribers = [];
    this.inhibitAI = false;
    this.activeReflex = null;
    this.cooldowns = new Map();
    this.ruleEngine = options.ruleEngine || null;
    this.actionRegistry = options.actionRegistry || null;
  }

  getState() {
    return {
      inhibitAI: this.inhibitAI,
      activeReflex: this.activeReflex,
    };
  }

  shouldInhibitAI() {
    return this.inhibitAI === true;
  }

  reset() {
    this.inhibitAI = false;
    this.activeReflex = null;
    this.cooldowns.clear();
  }

  bind(eventManager) {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch (_) {}
    }
    this.unsubscribers.push(
      eventManager.on({
        type: "*",
        priority: 100,
        handler: async (event) => {
          const rules =
            this.ruleEngine?.evaluateEvent?.(event, {
              hasUserTask: this.options.hasUserTask?.() === true,
            }) || [];
          for (const rule of rules) {
            const handled = await this.runRuleReflex(rule, event);
            if (handled) {
              break;
            }
          }
        },
      })
    );
  }

  maybeBuildReflexPlan(command, context = {}) {
    const rule = this.ruleEngine?.evaluateCommand?.(command, context);
    if (!rule) {
      return null;
    }
    if (String(rule.reflexPlan || "").trim() === "follow_player") {
      const step = this.actionRegistry?.createActionStep?.("follow_player", {
        playerName: context.playerName || "",
        distance: Number(rule.args?.distance) || 2,
      });
      if (!step) {
        return null;
      }
      return {
        mode: "task",
        intent: String(rule.intent || "reflex_follow_player"),
        goal: "follow the player immediately",
        replyText: String(rule.replyText || "我直接跟上你。"),
        steps: [step],
      };
    }
    return null;
  }

  getActionHandler(name) {
    const normalized = String(name || "").trim();
    if (normalized === "evade_hostile") {
      return (event) => this.evadeHostile(event);
    }
    if (normalized === "pickup_item") {
      return (event) => this.pickupNearbyItem(event);
    }
    return null;
  }

  async runRuleReflex(rule, event) {
    const name = String(rule.reflex || "").trim();
    const handler = this.getActionHandler(name);
    if (!handler) {
      return false;
    }
    return this.runReflex(name, event, () => handler(event), {
      inhibitAI: rule.inhibitAI !== false,
      cooldownMs: Number(rule.cooldownMs) || 1500,
      cooldownKey:
        String(rule.cooldownKey || "").trim() ||
        `${name}:${event?.payload?.entityId || event?.type || "default"}`,
      ruleId: String(rule.id || "").trim(),
    });
  }

  async runReflex(name, event, handler, options = {}) {
    const cooldownKey =
      String(options.cooldownKey || "").trim() ||
      `${name}:${event?.payload?.entityId || "default"}`;
    const cooldownMs = Number(options.cooldownMs) || 1500;
    if (this.activeReflex?.name === name && !this.isCooldownReady(cooldownKey, cooldownMs)) {
      return false;
    }
    if (this.activeReflex && this.activeReflex.name !== name) {
      return false;
    }
    const shouldInhibitAI = options.inhibitAI !== false;
    this.inhibitAI = shouldInhibitAI;
    this.activeReflex = {
      name,
      eventType: event?.type || "unknown",
      startedAt: Date.now(),
      ruleId: String(options.ruleId || "").trim() || null,
    };
    try {
      const result = await handler();
      if (result) {
        this.markCooldown(cooldownKey);
        this.options.onReflexNotice?.(`触发快速反应：${name}`);
      }
      return result;
    } finally {
      this.inhibitAI = false;
      this.activeReflex = null;
    }
  }

  isCooldownReady(key, cooldownMs = 1500) {
    const nextAllowedAt = Number(this.cooldowns.get(key) || 0);
    return Date.now() >= nextAllowedAt + cooldownMs;
  }

  markCooldown(key) {
    this.cooldowns.set(key, Date.now());
  }

  async evadeHostile(event) {
    if (this.options.hasUserTask?.()) {
      return false;
    }
    const bot = this.options.getBot?.();
    if (!bot?.entity || !bot?.pathfinder) {
      return false;
    }
    const hostile = bot.entities?.[event.payload?.entityId];
    if (!hostile?.position) {
      return false;
    }
    const lease = this.options.claimMovementLease?.(
      "reflex",
      `evade:${event.payload?.entityId || "unknown"}`
    );
    try {
      this.options.setPathfinderGoal?.(
        new goals.GoalInvert(new goals.GoalFollow(hostile, 4)),
        true,
        lease
      );
      await sleep(1200);
      if (!this.options.hasUserTask?.()) {
        this.options.clearPathfinderGoal?.(lease);
      }
    } finally {
      this.options.releaseMovementLease?.(lease);
    }
    return true;
  }

  async pickupNearbyItem(event) {
    if (this.options.hasUserTask?.()) {
      return false;
    }
    const bot = this.options.getBot?.();
    if (!bot?.entity || !bot?.pathfinder || !event.payload?.position) {
      return false;
    }
    const position = event.payload.position;
    const lease = this.options.claimMovementLease?.(
      "reflex",
      `pickup:${event.payload?.entityId || "item"}`
    );
    try {
      await this.options.pathfinderGoto?.(
        new goals.GoalNear(position.x, position.y, position.z, 1),
        12000,
        "前往掉落物超时",
        lease
      );
    } finally {
      this.options.releaseMovementLease?.(lease);
    }
    return true;
  }
}

module.exports = {
  CancellationToken,
  ReflexManager,
};
