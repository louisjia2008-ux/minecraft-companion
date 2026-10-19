/* global module */
'use strict';
// The host installs one physical safety frame around both dry alignment and
// water travel. A business cancellation cannot slip between the two stages.
function createBankAlignedWaterSession(deps) {
  for (const name of ['createAlignment', 'createTraversal', 'validateRoute', 'assertActive', 'getBot']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`Aligned water session requires ${name}`);
  }
  const alignment = deps.createAlignment(deps), water = deps.createTraversal(deps);
  let stage = 'idle', requested = null, usedWater = false;
  const assertNotCancelled = () => {
    if (requested) throw Object.assign(new Error('Transport cancelled on its dry entry bank'), { code: requested });
  };
  return {
    async traverse(route) {
      if (stage !== 'idle') throw Object.assign(new Error('A transport session is single use'), { code: 'water_session_busy' });
      deps.assertActive(); assertNotCancelled();
      // Physical geometry is checked before moving even within the bank.
      deps.validateRoute(deps.getBot(), route, deps.Vec3);
      deps.assertActive(); assertNotCancelled();
      stage = 'alignment';
      try {
        await alignment.align(route.from);
        deps.assertActive();
        assertNotCancelled();
        stage = 'water'; usedWater = true;
        return await water.traverse(route);
      } finally { stage = 'settled'; }
    },
    requestCancel(code = 'water_cancelled') {
      requested ||= code;
      alignment.requestCancel(code); water.requestCancel(code);
    },
    isActive: () => stage === 'alignment' || stage === 'water' || alignment.isActive() || water.isActive(),
    isHolding: () => alignment.isHolding() || water.isHolding(),
    release: () => usedWater ? water.release() : alignment.release(),
  };
}
module.exports = { createBankAlignedWaterSession };
