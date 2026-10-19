const { clamp } = require("./taskUtils");
const { isDroppedItemEntity } = require("./entitySemantics");

class EventManager {
  constructor(options = {}) {
    this.listeners = [];
    this.sourceDisposers = [];
    this.eventCounter = 1;
    this.logger =
      typeof options.logger === "function"
        ? options.logger
        : () => {};
  }

  on({ type = "*", priority = 0, filter = null, handler }) {
    if (typeof handler !== "function") {
      return () => {};
    }
    const listener = {
      type: Array.isArray(type) ? type : [type],
      priority: Number(priority) || 0,
      filter: typeof filter === "function" ? filter : null,
      handler,
    };
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  async emit(event = {}) {
    const normalized = {
      id: `evt-${this.eventCounter++}`,
      type: String(event.type || "unknown"),
      source: String(event.source || "internal"),
      priority: Number.isFinite(event.priority) ? Number(event.priority) : 0,
      timestamp: Number.isFinite(event.timestamp) ? Number(event.timestamp) : Date.now(),
      payload: event.payload && typeof event.payload === "object" ? event.payload : {},
      tags: Array.isArray(event.tags)
        ? event.tags.map((tag) => String(tag || "").trim()).filter(Boolean)
        : [],
    };
    const listeners = [...this.listeners].sort((a, b) => b.priority - a.priority);
    for (const listener of listeners) {
      const typeMatched =
        listener.type.includes("*") || listener.type.includes(normalized.type);
      if (!typeMatched) {
        continue;
      }
      if (listener.filter && listener.filter(normalized) !== true) {
        continue;
      }
      try {
        await listener.handler(normalized);
      } catch (error) {
        this.logger(error?.message || String(error || "事件处理失败"));
      }
    }
    return normalized;
  }

  detachSources() {
    for (const dispose of this.sourceDisposers.splice(0)) {
      try {
        dispose();
      } catch (_) {}
    }
  }

  bindMineflayer(bot) {
    this.detachSources();
    if (!bot || typeof bot.on !== "function") {
      return;
    }
    const addBinding = (eventName, adapter) => {
      const listener = (...args) => {
        Promise.resolve(adapter(...args))
          .then((event) => {
            if (event) {
              return this.emit(event);
            }
            return null;
          })
          .catch((error) => {
            this.logger(error?.message || String(error || `事件 ${eventName} 处理失败`));
          });
      };
      bot.on(eventName, listener);
      this.sourceDisposers.push(() => {
        try {
          bot.removeListener(eventName, listener);
        } catch (_) {}
      });
    };

    addBinding("spawn", () => ({
      type: "perception.bot_spawned",
      source: "mineflayer",
      priority: 40,
      payload: {},
      tags: ["lifecycle"],
    }));
    addBinding("playerJoined", (player) => ({
      type: "perception.player_joined",
      source: "mineflayer",
      priority: 25,
      payload: {
        username: String(player?.username || "").trim(),
      },
      tags: ["player"],
    }));
    addBinding("playerLeft", (player) => ({
      type: "perception.player_left",
      source: "mineflayer",
      priority: 25,
      payload: {
        username: String(player?.username || "").trim(),
      },
      tags: ["player"],
    }));
    addBinding("chat", (username, message) => ({
      type: "perception.chat",
      source: "mineflayer",
      priority: 35,
      payload: {
        username: String(username || "").trim(),
        message: String(message || "").trim(),
      },
      tags: ["chat"],
    }));
    addBinding("death", () => ({
      type: "perception.bot_death",
      source: "mineflayer",
      priority: 90,
      payload: {},
      tags: ["combat", "lifecycle"],
    }));
    addBinding("entityHurt", (entity) => ({
      type: "perception.entity_hurt",
      source: "mineflayer",
      priority: entity?.id === bot?.entity?.id ? 85 : 55,
      payload: {
        entityId: Number(entity?.id || 0),
        username: String(entity?.username || entity?.name || "").trim(),
        name: String(entity?.name || "").trim(),
        displayName: String(entity?.displayName || entity?.username || entity?.name || "").trim(),
        entityType: String(entity?.type || "").trim(),
      },
      tags: ["combat", "entity"],
    }));
    addBinding("health", () => ({
      type: "perception.bot_health",
      source: "mineflayer",
      priority: 88,
      payload: {
        health: Number.isFinite(bot?.health) ? Number(bot.health) : null,
        food: Number.isFinite(bot?.food) ? Number(bot.food) : null,
      },
      tags: ["combat", "health"],
    }));
    addBinding("entityDead", (entity) => ({
      type: "perception.entity_dead",
      source: "mineflayer",
      priority: 30,
      payload: {
        entityId: Number(entity?.id || 0),
        name: String(entity?.name || "").trim(),
        displayName: String(entity?.displayName || entity?.name || "").trim(),
        entityType: String(entity?.type || "").trim(),
      },
      tags: ["entity"],
    }));
    addBinding("itemDrop", (entity) => ({
      type: "perception.item_drop",
      source: "mineflayer",
      priority: 45,
      payload: {
        entityId: Number(entity?.id || 0),
        name: String(entity?.getDroppedItem?.()?.name || entity?.name || "").trim(),
        position:
          entity?.position && Number.isFinite(entity.position.x)
            ? {
                x: Number(entity.position.x),
                y: Number(entity.position.y),
                z: Number(entity.position.z),
              }
            : null,
      },
      tags: ["item"],
    }));
  }
}

class WorldQuery {
  constructor(options = {}) {
    this.options = options;
  }

  getBot() {
    return this.options.getBot?.() || null;
  }

  getCurrentTask() {
    return this.options.getCurrentTask?.() || null;
  }

  listNearbyPlayers(limit = 8) {
    const players = this.options.getNearbyPlayers?.() || [];
    return players.slice(0, Math.max(1, limit));
  }

  listNearbyHostiles(limit = 8) {
    const hostiles = this.options.getNearbyHostiles?.() || [];
    return hostiles.slice(0, Math.max(1, limit));
  }

  listNearbyBlocks(limit = 12) {
    const blocks = this.options.getNearbyBlocks?.() || [];
    return blocks.slice(0, Math.max(1, limit));
  }

  listInventory() {
    return this.options.getInventorySnapshot?.() || [];
  }

  listAvailableItems(limit = 32) {
    return this.listInventory()
      .map((item) => ({
        name: item.name,
        displayName: item.displayName || item.name,
        count: Number(item.count || 0),
      }))
      .slice(0, Math.max(1, limit));
  }

  listKnownPlayers(limit = 8) {
    const players = this.options.getKnownPlayers?.() || [];
    return players
      .slice()
      .sort((a, b) => Number(b.seenAt || 0) - Number(a.seenAt || 0))
      .slice(0, Math.max(1, limit));
  }

  listNearbyEntities(maxDistance = 20, limit = 16) {
    const bot = this.getBot();
    if (!bot?.entities || !bot?.entity) {
      return [];
    }
    return Object.values(bot.entities)
      .filter((entity) => entity && entity !== bot.entity)
      .map((entity) => ({
        entityId: Number(entity.id || 0),
        name: String(entity.name || "").trim(),
        displayName: String(entity.displayName || entity.name || "").trim(),
        type: String(entity.type || "").trim(),
        distance: Number(bot.entity.position.distanceTo(entity.position).toFixed(1)),
        position: {
          x: Number(entity.position.x.toFixed(1)),
          y: Number(entity.position.y.toFixed(1)),
          z: Number(entity.position.z.toFixed(1)),
        },
      }))
      .filter((entity) => entity.distance <= clamp(Number(maxDistance) || 20, 2, 64))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.max(1, limit));
  }

  listNearbyItems(maxDistance = 8, limit = 8) {
    return this.listNearbyEntities(maxDistance, 24)
      .filter((entity) => isDroppedItemEntity(entity, this.getBot()?.registry))
      .slice(0, Math.max(1, limit));
  }

  getSelfStatus() {
    const bot = this.getBot();
    if (!bot?.entity) {
      return {
        connected: false,
        username: "",
        health: null,
        food: null,
        dimension: null,
        position: null,
      };
    }
    return {
      connected: true,
      username: String(bot.username || "").trim(),
      health: Number.isFinite(bot.health) ? Number(bot.health) : null,
      food: Number.isFinite(bot.food) ? Number(bot.food) : null,
      dimension: bot.game?.dimension || null,
      position: {
        x: Number(bot.entity.position.x.toFixed(1)),
        y: Number(bot.entity.position.y.toFixed(1)),
        z: Number(bot.entity.position.z.toFixed(1)),
      },
    };
  }

  listTaskHistory(limit = 8) {
    const history = this.options.getTaskHistory?.() || [];
    return history
      .slice(Math.max(0, history.length - limit))
      .map((task) => ({
        taskId: task.taskId,
        intent: task.intent,
        status: task.status,
        userCommand: task.userCommand,
        progressText: task.progressText,
        error: task.error || "",
        finishedAt: task.finishedAt || null,
      }));
  }

  listTaskMemory(limit = 8) {
    const memory = this.options.getTaskMemory?.() || [];
    return memory.slice(0, Math.max(1, limit));
  }

  listPerceptionRules(limit = 16) {
    const rules = this.options.getPerceptionRules?.() || [];
    return rules.slice(0, Math.max(1, limit));
  }

  listReflexRules(limit = 16) {
    const rules = this.options.getReflexRules?.() || [];
    return rules.slice(0, Math.max(1, limit));
  }

  createPlanningContext(extra = {}) {
    return {
      self: this.getSelfStatus(),
      currentTask: this.getCurrentTask(),
      nearbyPlayers: this.listNearbyPlayers(),
      nearbyHostiles: this.listNearbyHostiles(),
      nearbyEntities: this.listNearbyEntities(),
      nearbyBlocks: this.listNearbyBlocks(),
      inventory: this.listInventory(),
      availableItems: this.listAvailableItems(),
      knownPlayers: this.listKnownPlayers(),
      recentTaskHistory: this.listTaskHistory(),
      recentMemories: this.listTaskMemory(),
      learningProfile: this.options.getLearningSnapshot?.() || null,
      perceptionRules: this.listPerceptionRules(),
      reflexRules: this.listReflexRules(),
      ...extra,
    };
  }
}

module.exports = {
  EventManager,
  WorldQuery,
};
