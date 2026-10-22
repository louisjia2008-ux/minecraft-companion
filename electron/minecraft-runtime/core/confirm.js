'use strict';
// Server state arrives in separate packets (food, inventory, position, block
// updates) with no ordering guarantee. An action is only "done" once every
// fact it promises is observed together; one early packet proves nothing.

function abortError(signal) {
  const error = new Error(String(signal?.reason || 'aborted'));
  error.code = 'aborted';
  return error;
}

/** Abortable sleep. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Polls `check` until it returns truthy. Resolves true when confirmed, false on
 * timeout, and rejects with code "aborted" if the signal fires.
 */
async function waitUntil(check, { timeoutMs = 3000, intervalMs = 50, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal);
  }
}

/**
 * Runs a promise-returning operation that can be cancelled. `cancel` is called
 * on abort or timeout and must make the operation settle (e.g. stop digging).
 */
async function runCancellable(start, { signal, timeoutMs, cancel = () => {}, timeoutCode = 'timeout' } = {}) {
  if (signal?.aborted) throw abortError(signal);
  let timer = null;
  let interrupted = null;
  const interrupt = (error) => {
    if (interrupted) return;
    interrupted = error;
    try { cancel(); } catch (_) { /* best effort */ }
  };
  const onAbort = () => interrupt(abortError(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => interrupt(Object.assign(new Error(timeoutCode), { code: timeoutCode })), timeoutMs);
  }
  try {
    const value = await start();
    if (interrupted) throw interrupted;
    return value;
  } catch (error) {
    throw interrupted || error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

module.exports = { sleep, waitUntil, runCancellable, abortError };
