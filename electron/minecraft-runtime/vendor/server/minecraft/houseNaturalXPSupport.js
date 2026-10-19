'use strict';
const { classifyMiningBlock } = require('./miningNavigation');
const integer = p => p && ['x', 'y', 'z'].every(k => Number.isSafeInteger(p[k]));
const same = (a, b) => integer(a) && integer(b) && ['x', 'y', 'z'].every(k => a[k] === b[k]);
const gravityLayers = new Set(['sand', 'red_sand', 'gravel']);

// Geometry facts only: a remembered foundation never grants stock or ownership.
// Keep the existing planners' sixteen-cell bound and full-cube support contract.
function inspectRecordedNaturalXPFoundation({ support, foundation, blockAt, assertActive }) {
  const reject = (reason, position = null) => ({ safe: false, reason, position });
  if (typeof blockAt !== 'function' || typeof assertActive !== 'function') return reject('invalid_reader');
  assertActive();
  if (!integer(support?.position) || !Array.isArray(foundation) || foundation.length < 1 || foundation.length > 16
    || !same(foundation[0]?.position, support.position) || foundation[0].name !== support.name || foundation[0].stateId !== support.stateId) return reject('invalid_record');
  for (let index = 0; index < foundation.length; index++) {
    const fact = foundation[index], expected = { ...support.position, y: support.position.y - index };
    if (!same(fact?.position, expected) || typeof fact.name !== 'string' || !Number.isSafeInteger(fact.stateId) || fact.stateId < 0) return reject('invalid_record', expected);
    assertActive(); const block = blockAt(expected); assertActive();
    const classification = classifyMiningBlock(block);
    if (!classification.loaded) return reject('unloaded_foundation', expected);
    if (block.name !== fact.name || block.stateId !== fact.stateId) return reject('changed_foundation', expected);
    const fullCube = Array.isArray(block.shapes) && block.shapes.some(shape => shape.length === 6 && shape.every((n, i) => n === (i < 3 ? 0 : 1)));
    if (!fullCube || classification.hazard) return reject('unsupported_shape_or_hazard', expected);
    if (index === foundation.length - 1) {
      if (!classification.support || classification.gravity) return reject('missing_stable_base', expected);
    } else if (!classification.gravity || !gravityLayers.has(classification.name)) return reject('invalid_gravity_chain', expected);
  }
  assertActive();
  return { safe: true, reason: 'fresh_recorded_full_support', position: null };
}
module.exports = { inspectRecordedNaturalXPFoundation };
