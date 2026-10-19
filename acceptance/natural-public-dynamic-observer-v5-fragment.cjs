// Pure observation: no native API replacement, motor/world writes or requests.
function nativeMotionEvidence(observedBot) {
  const read = (object, name, kind) => {
    try { const value = object?.[name]; return kind === 'number' ? Number.isFinite(value) ? value : null
      : typeof value === 'boolean' ? value : null; } catch { return null; }
  };
  let entity, controls;
  try { entity = observedBot?.entity; } catch { /* Unknown native entity. */ }
  try { controls = observedBot?.controlState; } catch { /* Unknown native controls. */ }
  return { yaw: read(entity, 'yaw', 'number'), pitch: read(entity, 'pitch', 'number'),
    controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(name => [name, read(controls, name, 'boolean')])),
    jumpTicks: read(observedBot, 'jumpTicks', 'number'), jumpQueued: read(observedBot, 'jumpQueued', 'boolean') };
}
function installDynamicObservers(observedBot, emitRecord, duringExecution) {
  const seen = new Map();
  const point = value => value && ['x', 'y', 'z'].every(name => Number.isFinite(value[name]))
    ? { x: value.x, y: value.y, z: value.z } : null;
  const frame = () => ({ position: point(observedBot.entity?.position), velocity: point(observedBot.entity?.velocity),
    onGround: typeof observedBot.entity?.onGround === 'boolean' ? observedBot.entity.onGround : null,
    ...nativeMotionEvidence(observedBot), nativeGoal: goalEvidence(observedBot.pathfinder?.goal), duringExecution: duringExecution() });
  const passive = (nativeOrigin, operation) => {
    try { operation(); }
    catch { try { emitRecord('dynamic_observation_error', { nativeOrigin,
      message: 'Native observation read or evidence storage failed' }); } catch { /* Evidence faults never interrupt native listeners. */ } }
  };
  const pathUpdate = result => passive('bot.path_update', () => {
    const path = Array.isArray(result?.path) ? result.path : null;
    const points = [];
    if (path) for (let i = 0; i < Math.min(64, path.length); i++) points.push(point(path[i]));
    emitRecord('native_path_update', { nativeOrigin: 'bot.path_update', status: typeof result?.status === 'string' ? result.status.slice(0, 80) : null,
      pathLength: path ? path.length : null, pathTruncated: path ? path.length > 64 : null, points, ...frame() });
  });
  const pathReset = reason => passive('bot.path_reset', () => emitRecord('native_path_reset', {
    nativeOrigin: 'bot.path_reset', reason: typeof reason === 'string' ? reason.slice(0, 80) : null, ...frame() }));
  const goalReached = goal => passive('bot.goal_reached', () => emitRecord('native_goal_reached', {
    nativeOrigin: 'bot.goal_reached', reachedGoal: goalEvidence(goal), ...frame() }));
  function creeper(origin, entity) {
    passive(origin, () => {
      if (entity?.name !== 'creeper' || !Number.isSafeInteger(entity.id)) return;
      const value = { entityId: entity.id, name: 'creeper', isValid: typeof entity.isValid === 'boolean' ? entity.isValid : null, creeperPosition: point(entity.position) };
      const signature = JSON.stringify(value);
      if (origin === 'bot.entityGone') {
        if (seen.has(entity.id)) { emitRecord('native_creeper_gone', { nativeOrigin: origin, ...value, ...frame() }); seen.delete(entity.id); }
        return;
      }
      if (seen.get(entity.id) === signature) return;
      if (!seen.has(entity.id) && seen.size >= 128) seen.delete(seen.keys().next().value);
      seen.set(entity.id, signature);
      emitRecord(origin === 'bot.entityMoved' ? 'native_creeper_moved' : 'native_creeper_observed', {
        nativeOrigin: origin, ...value, ...frame() });
    });
  }
  const spawn = entity => creeper('bot.entitySpawn', entity);
  const moved = entity => creeper('bot.entityMoved', entity);
  const gone = entity => creeper('bot.entityGone', entity);
  const listeners = [['path_update', pathUpdate], ['path_reset', pathReset], ['goal_reached', goalReached],
    ['entitySpawn', spawn], ['entityMoved', moved], ['entityGone', gone]];
  for (const [event, listener] of listeners) passive('observer.install_listener', () => observedBot.on(event, listener));
  passive('observer.install_existing_creepers', () => {
    let entities; try { entities = observedBot.entities; } catch { return; }
    if (!entities) return;
    for (const id of Object.keys(entities)) {
      if (seen.size >= 128) break;
      const entity = entities[id]; if (entity?.name === 'creeper') creeper('observer.install_existing_creepers', entity);
    }
  });
  return () => {
    for (const [event, listener] of listeners) {
      try { observedBot.removeListener(event, listener); } catch { /* Own task cleanup remains independent. */ }
    }
    seen.clear();
  };
}
