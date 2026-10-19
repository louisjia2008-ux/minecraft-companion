/* global require */
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validateHouseSurfaceTransport } = require('../vendor/server/minecraft/houseSurfaceTransport');
const { getSurfaceGraphProtectedPositions } = require('../vendor/server/minecraft/houseSurfaceGraph');
const copy = value => JSON.parse(JSON.stringify(value));
function edge(surface = false, width = 4) {
  return { parent: 'origin', target: { x: width + 1, y: 2, z: 0 }, transport: {
    kind: surface ? 'source_water_surface' : 'source_water_depth1', route: {
      schema: 1, kind: surface ? 'loaded_surface_swim' : 'loaded_source_water_wade',
      depth: surface ? 'surface_only' : 1, width, surfaceY: 2,
      from: { x: 0, y: 2, z: 0 }, to: { x: width + 1, y: 2, z: 0 },
      waterStart: { x: 1, z: 0 }, direction: { x: 1, z: 0 },
    } } };
}
const options = { nodes: { origin: { position: { x: 0, y: 2, z: 0 } } }, waterEnabled: true,
  supportedKinds: ['source_water_depth1','source_water_surface'] };
const denied = value => assert.throws(() => validateHouseSurfaceTransport(value, options), e => e.code === 'dry_graph_transport_invalid');

test('saved water families retain distinct depth and width limits without granting actual crossing credit', () => {
  for (const [surface, width] of [[false,12],[true,64]]) {
    const value = edge(surface, width), route = validateHouseSurfaceTransport(value, options);
    assert.deepEqual(route, value.transport.route); assert.notEqual(route, value.transport.route);
    assert.equal(route.confirmed, undefined);
  }
  denied(edge(false,13)); denied(edge(true,65));
});
test('surface-only proof cannot masquerade as shallow bottom-checked proof or vice versa', () => {
  const a = edge(true); a.transport.kind = 'source_water_depth1'; denied(a);
  const b = edge(false); b.transport.kind = 'source_water_surface'; denied(b);
  const c = edge(true); c.transport.route.depth = 1; denied(c);
  const d = edge(false); d.transport.route.depth = 'surface_only'; denied(d);
});
test('saved transport needs both native adapters and its exact observed finite dry parent', () => {
  assert.throws(() => validateHouseSurfaceTransport(edge(true), { ...options, supportedKinds: ['source_water_depth1'] }), e => e.code === 'dry_graph_transport_invalid');
  assert.throws(() => validateHouseSurfaceTransport(edge(true), { ...options, waterEnabled: false }), e => e.code === 'dry_graph_transport_invalid');
  assert.throws(() => validateHouseSurfaceTransport(edge(true), { ...options, nodes: {} }), e => e.code === 'dry_graph_transport_invalid');
  assert.throws(() => validateHouseSurfaceTransport(edge(true), { ...options, nodes: { origin: { position: { x: -17, y: 2, z: 0 } } } }), e => e.code === 'dry_graph_transport_invalid');
});
test('both families reject fractional, noncardinal, altered endpoint and unbracketed banks', () => {
  for (const surface of [false,true]) for (const mutate of [
    e => { e.transport.route.from.x = .5; }, e => { e.transport.route.direction.z = 1; },
    e => { e.target.x++; }, e => { e.transport.route.from.y++; },
    e => { e.transport.route.from.x--; }, e => { e.transport.route.to.z++; e.target.z++; },
  ]) { const value = edge(surface); mutate(value); denied(value); }
});
test('surface-only transport protects water and head space without inventing a checked riverbed', () => {
  const value = edge(true);
  for (const p of [{x:0,y:2,z:0},{x:2,y:1,z:0},{x:2,y:5,z:1}]) {
    assert.throws(() => validateHouseSurfaceTransport(value, { ...options, excluded: q => ['x','y','z'].every(k => q[k] === p[k]) }), e => e.code === 'dry_graph_transport_invalid');
  }
  assert.deepEqual(validateHouseSurfaceTransport(value, { ...options, excluded: q => q.x === 2 && q.y === 0 && q.z === 0 }), value.transport.route);
  const shallow = edge(false);
  assert.throws(() => validateHouseSurfaceTransport(shallow, { ...options, excluded: q => q.x === 2 && q.y === 0 && q.z === 0 }), e => e.code === 'dry_graph_transport_invalid');
});
test('surface route mutation protection reserves its banks and surface but no imaginary bottom; shallow still reserves its bed', () => {
  const value = edge(true), state = { nodes: { child: { position: value.target, transport: value.transport } } };
  const protectedSet = new Set(getSurfaceGraphProtectedPositions(state).map(p => `${p.x},${p.y},${p.z}`));
  assert.ok(protectedSet.has('0,-2,0')); assert.ok(protectedSet.has('2,1,0'));
  assert.equal(protectedSet.has('2,0,0'), false);
  const deep = copy(state); deep.nodes.child.transport = edge(false).transport;
  assert.ok(getSurfaceGraphProtectedPositions(deep).some(p => p.x === 2 && p.y === 0 && p.z === 0));
});
