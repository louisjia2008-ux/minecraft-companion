/* global module, setInterval, clearInterval */
'use strict';
// Shared by the product host and native acceptance host. No game authority,
// planner, or autonomous-goal policy is created by this scheduler.
function createRuntimeTickLoop({ isReady, tick, onFault = () => {}, intervalMs = 2000 }) {
  if (typeof isReady !== 'function' || typeof tick !== 'function' || typeof onFault !== 'function'
      || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new TypeError('Invalid runtime tick loop');
  let stopped = false, active = null;
  const run = () => {
    if (stopped || active || !isReady()) return;
    active = Promise.resolve().then(() => { if (!stopped && isReady()) return tick(); })
      .catch(error => { if (!stopped) return onFault(error); })
      .finally(() => { active = null; });
    // Fault reporting is host-owned; its own failure must never become an
    // unhandled rejection after the caller disconnects or closes the task.
    active.catch(() => {});
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); return active || Promise.resolve(); } };
}
module.exports = { createRuntimeTickLoop };
