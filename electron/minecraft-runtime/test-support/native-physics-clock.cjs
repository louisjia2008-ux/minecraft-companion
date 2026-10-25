'use strict';

const assert = require('node:assert/strict');
const { setTimeout: hostTimeout, clearTimeout: clearHostTimeout, setImmediate: hostImmediate } = require('node:timers');
const hostTurn = () => new Promise(resolve => hostImmediate(resolve));

// Drive an offline native Physics fixture at its original 10/20ms cadence.
// Date and fixture timers share logical time; AStar performance.now and the
// independent host watchdog remain real. No pose, motor or path result is mocked.
// This follows runNativeCoordinationClock, with an explicit fixture step size.
async function runNativePhysicsClock(t, operation, { maximumMs, stepMs, stop }) {
  assert.ok(Number.isInteger(maximumMs) && maximumMs > 0);
  assert.ok(Number.isInteger(stepMs) && stepMs > 0 && maximumMs % stepMs === 0);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  let settled = false, outcome, hostExpired = false;
  const observed = Promise.resolve().then(operation).then(value => { settled = true; outcome = { value }; },
    error => { settled = true; outcome = { error }; });
  const watchdog = hostTimeout(() => { hostExpired = true; stop(); }, Math.min(8000, maximumMs));
  try {
    await hostTurn();
    for (let elapsed = 0; elapsed < maximumMs && !settled && !hostExpired; elapsed += stepMs) {
      t.mock.timers.tick(stepMs); await hostTurn();
    }
    for (let turn = 0; turn < 20 && !settled && !hostExpired; turn++) {
      t.mock.timers.tick(0); await hostTurn();
    }
    assert.equal(hostExpired, false, 'The native fixture retains an independent real host watchdog');
    assert.equal(settled, true, 'The operation must settle within its original logical test limit');
    await observed;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  } finally {
    clearHostTimeout(watchdog);
    if (!settled) {
      stop();
      for (let turn = 0; turn < 20 && !settled; turn++) { t.mock.timers.tick(0); await hostTurn(); }
      assert.equal(settled, true, 'Cancelled native work must join without another task or Physics budget');
    }
  }
}

module.exports = { runNativePhysicsClock };
