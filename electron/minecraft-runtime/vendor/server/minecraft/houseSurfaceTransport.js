/* global module */
'use strict';
const key = p => `${p?.x},${p?.y},${p?.z}`;
const integerPoint = p => p && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(p[axis]));
const invalid = message => Object.assign(new Error(message), { code: 'dry_graph_transport_invalid' });

// Saved surface-only swimming is a separate capability from bottom-checked
// shallow wading. Neither tag can borrow the other capability's limits/proof.
function validateHouseSurfaceTransport(edge, { nodes, excluded = () => false, waterEnabled, supportedKinds = ['source_water_depth1'] } = {}) {
  const transport = edge?.transport, route = transport?.route, parent = nodes?.[edge?.parent];
  if (!transport) return null;
  const shallow = transport.kind === 'source_water_depth1' && route?.kind === 'loaded_source_water_wade' && route.depth === 1;
  const surface = transport.kind === 'source_water_surface' && route?.kind === 'loaded_surface_swim' && route.depth === 'surface_only';
  if (!waterEnabled || !Array.isArray(supportedKinds) || !supportedKinds.includes(transport.kind)
    || !parent || !integerPoint(parent.position) || !(shallow || surface) || route.schema !== 1
    || !Number.isSafeInteger(route.width) || route.width < 1 || route.width > (surface ? 64 : 12)
    || !Number.isSafeInteger(route.surfaceY) || !integerPoint(route.from) || !integerPoint(route.to)
    || !route.waterStart || !['x', 'z'].every(axis => Number.isSafeInteger(route.waterStart[axis]))
    || !route.direction || !['x', 'z'].every(axis => Number.isSafeInteger(route.direction[axis]))
    || Math.abs(route.direction.x) + Math.abs(route.direction.z) !== 1
    || route.from.y !== route.surfaceY || route.to.y !== route.surfaceY
    || key(route.to) !== key(edge.target || edge.position)
    || Math.hypot(...['x', 'y', 'z'].map(axis => route.from[axis] - parent.position[axis])) > 16) {
    throw invalid('Transport requires its exact supported family, finite native adapter and observed dry parent/banks');
  }
  const d = route.direction, tangent = { x: -d.z, z: d.x };
  const along = p => (p.x - route.waterStart.x) * d.x + (p.z - route.waterStart.z) * d.z;
  const lateral = p => (p.x - route.waterStart.x) * tangent.x + (p.z - route.waterStart.z) * tangent.z;
  const start = along(route.from), end = along(route.to);
  if (lateral(route.from) !== 0 || lateral(route.to) !== 0
    || !((start === -1 && end === route.width) || (end === -1 && start === route.width))) {
    throw invalid('Only exact adjacent same-level cardinal banks may bracket a saved water edge');
  }
  for (const p of [route.from, route.to]) if (excluded(p)) throw invalid('Water bank is protected');
  for (let i = 0; i < route.width; i++) for (let j = -1; j <= 1; j++) {
    for (let dy = surface ? -1 : -2; dy <= 3; dy++) {
      if (excluded({ x: route.waterStart.x + d.x * i + tangent.x * j,
        y: route.surfaceY + dy, z: route.waterStart.z + d.z * i + tangent.z * j })) {
        throw invalid('Water route crosses a protected walking cell');
      }
    }
  }
  return JSON.parse(JSON.stringify(route));
}
module.exports = { validateHouseSurfaceTransport };
