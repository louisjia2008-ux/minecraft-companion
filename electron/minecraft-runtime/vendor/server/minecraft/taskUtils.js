function cloneSerializable(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message, fallbackTimeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message || "操作超时"));
    }, Math.max(1000, Number(timeoutMs) || fallbackTimeoutMs));
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createAbortError(reason = "cancelled") {
  const error = new Error(reason);
  error.code = reason;
  return error;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function limitArray(items, limit) {
  return Array.isArray(items) ? items.slice(Math.max(0, items.length - limit)) : [];
}

function normalizeVec3Input(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return { x, y, z };
}

module.exports = {
  clamp,
  cloneSerializable,
  createAbortError,
  limitArray,
  normalizeVec3Input,
  sleep,
  withTimeout,
};
