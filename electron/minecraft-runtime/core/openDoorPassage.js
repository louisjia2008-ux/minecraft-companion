'use strict';

const installed = new WeakMap();
function uninstallOpenDoorPassage(bot, movements) {
  const current = installed.get(bot);
  if (current && (!movements || current.movements === movements)) current.dispose();
}

// Planner-only adapter for an already open, loaded, two-block door. Native
// collision geometry and bot.blockAt remain untouched. Ordinary moves retain
// the installed pathfinder implementation and exclusion callbacks.
function installOpenDoorPassage(bot, movements) {
  const previous = installed.get(bot);
  if (previous?.movements === movements && bot.pathfinder.getPathFromTo === previous.wrapper) return movements;
  previous?.dispose();
  let disposed = false;
  const waypoint = Symbol('validatedOpenDoorWaypoint');
  const isDoor = (block) => !!block && /_door$/.test(block.name || '');
  const at = (point) => bot.blockAt(point, false);
  const axis = { north: 'z', south: 'z', east: 'x', west: 'x' };
  // Swept 0.6-wide player body, not merely the centre point: movement spans
  // the whole door cell along its normal, while the tangent stays .2..8.
  const intersectsPassage = (shape, normal) => shape[1] < 1 && shape[4] > 0 &&
    (normal === 'x' ? shape[2] < .8 && shape[5] > .2 : shape[0] < .8 && shape[3] > .2);
  function passage(point) {
    const lower = at(point);
    if (!isDoor(lower)) return null;
    const lo = lower.getProperties();
    if (lo.half !== 'lower' || lo.open !== true || !axis[lo.facing]) return null;
    const upper = at(lower.position.offset(0, 1, 0));
    if (!upper || upper.type !== lower.type || !isDoor(upper)) return null;
    const hi = upper.getProperties();
    if (hi.half !== 'upper' || ['open', 'facing', 'hinge', 'powered'].some((key) => hi[key] !== lo[key])) return null;
    if (![lower, upper].every((block) => Array.isArray(block.shapes) && block.shapes.length > 0 &&
      block.shapes.every((shape) => Array.isArray(shape) && shape.length === 6 && shape.every(Number.isFinite) && !intersectsPassage(shape, axis[lo.facing])))) return null;
    return { lower, upper, axis: axis[lo.facing] };
  }
  function normalStep(from, to) {
    // Native postprocessing centres nodes that remain in a partial AStar
    // context. Compare their grid columns; keep the exact vertical guard.
    if (from.y !== to.y) return false;
    from = from.floored();
    to = to.floored();
    if (from.y !== to.y || Math.abs(to.x - from.x) + Math.abs(to.z - from.z) !== 1) return false;
    const doors = [from, to].filter((point) => isDoor(at(point)));
    return doors.length > 0 && doors.every((point) => {
      const door = passage(point);
      return door && (door.axis === 'x' ? from.z === to.z : from.x === to.x);
    });
  }

  // Native Movements.getBlock annotates its input. Give it an independent
  // planner view so even those annotations never reach cached world blocks.
  const nativeGetBlock = movements.getBlock;
  const planner = Object.create(movements);
  planner.bot = Object.create(bot);
  planner.bot.blockAt = (...args) => {
    const block = bot.blockAt(...args);
    return block && Object.assign(Object.create(Object.getPrototypeOf(block)), block);
  };
  let admitted = null;
  const wrappedGetBlock = function (...args) {
    if (disposed) return nativeGetBlock.apply(this, args);
    const block = nativeGetBlock.apply(planner, args);
    if (block.position && admitted?.some((door) => door.lower.position.equals(block.position) || door.upper.position.equals(block.position))) {
      return Object.assign(Object.create(Object.getPrototypeOf(block)), block, {
        safe: true, physical: false, replaceable: false, openable: false, height: block.position.y,
      });
    }
    return block;
  };
  movements.getBlock = wrappedGetBlock;
  const nativeForward = movements.getMoveForward;
  const wrappedForward = function (node, direction, neighbors) {
    if (disposed) return nativeForward.call(this, node, direction, neighbors);
    const next = node.offset(direction.x, 0, direction.z).floored();
    const touched = [node, next].filter((point) => isDoor(at(point)));
    if (!touched.length) return nativeForward.call(this, node, direction, neighbors);
    if (!normalStep(node, next)) return;
    admitted = touched.map(passage);
    const count = neighbors.length;
    try {
      nativeForward.call(this, node, direction, neighbors);
      if (isDoor(at(next))) for (const move of neighbors.slice(count)) {
        move[waypoint] = { x: next.x, y: next.y, z: next.z };
      }
    } finally { admitted = null; }
  };
  movements.getMoveForward = wrappedForward;
  const nativeNeighbors = movements.getNeighbors;
  const wrappedNeighbors = function (node) {
    if (disposed) return nativeNeighbors.call(this, node);
    return nativeNeighbors.call(this, node).filter((next) => {
      if (!isDoor(at(node)) && !isDoor(at(next))) return true;
      return normalStep(node, next);
    });
  };
  movements.getNeighbors = wrappedNeighbors;
  // Initial getPathTo uses getPathFromTo; native partial continuation instead
  // postprocesses its existing AStar context, then emits this same path before
  // assigning it to the follower. Both need the same narrow correction.
  const correctPath = (result) => {
    if (disposed) return;
    for (const move of Array.isArray(result?.path) ? result.path : []) {
      const point = move[waypoint];
      if (point) { move.x = point.x + .5; move.y = point.y; move.z = point.z + .5; }
    }
  };
  const nativeFromTo = bot.pathfinder.getPathFromTo;
  let wrapper;
  if (typeof nativeFromTo === 'function') {
    wrapper = function * (profile, start, goal, options = {}) {
      for (const entry of nativeFromTo.call(this, profile, start, goal, options)) {
        if (profile === movements && options.optimizePath !== false) correctPath(entry.result);
        yield entry;
      }
    };
    bot.pathfinder.getPathFromTo = wrapper;
  }
  const onPath = (result) => {
    if (bot.pathfinder.movements === movements) correctPath(result);
  };
  bot.prependListener('path_update', onPath);
  const record = { movements, wrapper, dispose() {
    if (disposed) return;
    disposed = true;
    bot.removeListener('path_update', onPath);
    if (movements.getBlock === wrappedGetBlock) movements.getBlock = nativeGetBlock;
    if (movements.getMoveForward === wrappedForward) movements.getMoveForward = nativeForward;
    if (movements.getNeighbors === wrappedNeighbors) movements.getNeighbors = nativeNeighbors;
    if (wrapper && bot.pathfinder.getPathFromTo === wrapper) bot.pathfinder.getPathFromTo = nativeFromTo;
    if (installed.get(bot) === record) installed.delete(bot);
  } };
  installed.set(bot, record);
  return movements;
}
module.exports = { installOpenDoorPassage, uninstallOpenDoorPassage };
