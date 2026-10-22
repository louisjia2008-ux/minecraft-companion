'use strict';
// Targets that just failed are skipped for a while instead of being repaired.
// Choosing another tree is almost always cheaper than fixing a bad route.

function createBlacklist({ ttlMs = 120000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    add(key, reason, ttl = ttlMs) {
      entries.set(String(key), { until: now() + ttl, reason });
    },
    has(key) {
      const entry = entries.get(String(key));
      if (!entry) return false;
      if (entry.until <= now()) {
        entries.delete(String(key));
        return false;
      }
      return true;
    },
    size() {
      for (const key of [...entries.keys()]) this.has(key);
      return entries.size;
    },
    delete: (key) => entries.delete(String(key)),
    clear: () => entries.clear(),
  };
}

const posKey = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

module.exports = { createBlacklist, posKey };
