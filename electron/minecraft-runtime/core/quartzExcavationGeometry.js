'use strict';
// Shared read-only geometry. Actual stance/lease/native gates stay in the actuator.
const CAPS = Object.freeze({ down: 16, flat: 48, feet: 64, digs: 192, diamondRock: 64, nativeDigAttempts: 192,
  outboundEdges: 64, returnEdges: 64, knownEdges: 128, totalEdges: 128, leaseMs: 20000 });
const ROCK = new Set(['basalt', 'polished_basalt', 'smooth_basalt', 'netherrack', 'blackstone', 'polished_blackstone']);
const DANGER = /^(water|lava|bubble_column|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|powder_snow|nether_portal)$/;
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder)$/;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
const same = (a, b) => key(a) === key(b);
const fail = (reason, extra = {}) => ({ ok: false, progress: false, reason, ...extra });
const full = b => Boolean(b?.boundingBox === 'block' && b.shapes?.length === 1 && b.shapes[0].length === 6
  && b.shapes[0].every((v, i) => v === [0, 0, 0, 1, 1, 1][i]));
const empty = b => Boolean(b && b.boundingBox === 'empty' && b.shapes?.length === 0 && !DANGER.test(b.name));


function inspectExcavationGeometry({read,from,dir,descend,ledger:s,bounds,protectedCell,banned,inspectStep,Vec3,requireOpen=false}) {
  const v=p=>new Vec3(Math.floor(p.x),Math.floor(p.y),Math.floor(p.z));
    const inner = inspectStep((x, y, z) => read(new Vec3(x, y, z)), from, dir,
      { descend, surfaceY: s.surfaceY, known: p => s.open.has(key(p)) || s.route.some(at => [0, 1, 2].some(y => same(at.offset(0, y, 0), p))) });
    if (!inner.ok) return fail(`topology_${inner.reason}`);
    const target = v(inner.target);
    if (!bounds(target)) return fail('portal_radius');
    const floor = read(target.offset(0, -1, 0));
    if (!full(floor) || DANGER.test(floor.name) || GRAVITY.test(floor.name)) return fail('unsafe_full_floor');
    const clear = (descend ? [2, 1, 0] : [1, 0]).map(y => target.offset(0, y, 0));
    const known = p => s.open.has(key(p)) || s.route.some(at => [0, 1, 2].some(y => same(at.offset(0, y, 0), p)));
    for (const cell of clear) {
      const b = read(cell);
      if (!b) return fail('unknown_clearance');
      if (DANGER.test(b.name) || GRAVITY.test(b.name)) return fail('hazard_or_gravity');
      if (!empty(b) && (!full(b) || !ROCK.has(b.name) || banned.has(b.name) || b.diggable === false || protectedCell(s, cell))) return fail('forbidden_obstacle');
      if (requireOpen && !empty(b)) return fail('clearance_not_open');
      // Topology's skipped clear/behind exceptions are still loaded/hazard checked.
      for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const near = cell.offset(dx, dy, dz), n = read(near);
        if (!n) return fail('unknown_margin');
        if (DANGER.test(n.name) || GRAVITY.test(n.name)) return fail('hazard_margin');
        const planned = clear.some(p => same(p, near));
        if (!planned && empty(n) && near.y < s.surfaceY && !known(near)) return fail('unknown_cave');
      }
    }
    // Full floor is kept intact; unknown or liquid one cell below/along it still refuses admission.
    for (const [dx, dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
      const b = read(target.offset(dx, -2, dz));
      if (!b) return fail('unknown_underfloor_margin');
      if (DANGER.test(b.name) || GRAVITY.test(b.name)) return fail('hazard_underfloor_margin');
    }
    return { ok: true, target, dig: clear.filter(p => !empty(read(p))), clear };
}
module.exports={CAPS,ROCK,DANGER,GRAVITY,DIRS,key,same,fail,full,empty,inspectExcavationGeometry};
