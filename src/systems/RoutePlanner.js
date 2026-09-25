import * as CANNON from 'cannon-es';

/**
 * RoutePlanner — tiny walking planner for scripted NPC trips (walking onto a court, leaving it,
 * sheltering from rain). Obstacles are the static box bodies of the physics world that block a
 * walker (court back fences, nets, building walls, perimeter walls; thin posts / trunks are
 * left out), as axis-aligned rectangles grown by the walker radius. A path is an A* search over
 * the rectangle corners (visibility graph), built lazily on demand — a handful of routes per
 * match, never per frame.
 */

const MARGIN = 0.5;        // walker radius + a little air
const CORNER_OUT = 0.35;   // corner nodes sit this far outside the grown rectangle
const MIN_SIZE = 0.2;      // skip boxes thinner than this in both axes (fence wires, rails)
const _q = new CANNON.Quaternion();
const _v = new CANNON.Vec3();

export class RoutePlanner {
  constructor(physicsWorld) {
    this.world = physicsWorld;
    this.rects = null; // [{x0, z0, x1, z1}] grown by MARGIN
  }

  _build() {
    const rects = [];
    for (const body of this.world.bodies) {
      if (body.type !== CANNON.Body.STATIC) continue;
      for (let i = 0; i < body.shapes.length; i++) {
        const sh = body.shapes[i];
        if (!(sh instanceof CANNON.Box)) continue;
        const he = sh.halfExtents;
        const off = body.shapeOffsets[i];
        const ori = body.shapeOrientations[i];
        body.quaternion.mult(ori, _q);
        body.quaternion.vmult(off, _v);
        const cx = body.position.x + _v.x, cy = body.position.y + _v.y, cz = body.position.z + _v.z;
        // world AABB of the rotated box (rows of the rotation matrix)
        const m = quatToMat(_q);
        const ex = Math.abs(m[0]) * he.x + Math.abs(m[1]) * he.y + Math.abs(m[2]) * he.z;
        const ey = Math.abs(m[3]) * he.x + Math.abs(m[4]) * he.y + Math.abs(m[5]) * he.z;
        const ez = Math.abs(m[6]) * he.x + Math.abs(m[7]) * he.y + Math.abs(m[8]) * he.z;
        if (cy + ey < 0.35 || cy - ey > 1.3) continue;          // floor slabs / overhead
        if (ex * 2 < MIN_SIZE && ez * 2 < MIN_SIZE) continue;   // posts
        if (ex > 80 || ez > 80) continue;                        // giant ground boxes
        rects.push({ x0: cx - ex - MARGIN, z0: cz - ez - MARGIN, x1: cx + ex + MARGIN, z1: cz + ez + MARGIN });
      }
    }
    this.rects = rects;
  }

  /**
   * Plan a walk from (ax, az) to (bx, bz). Writes waypoints (excluding the start, including the
   * goal) into `out` as {x, z} objects and returns it. Falls back to the straight line.
   */
  plan(ax, az, bx, bz, out = []) {
    out.length = 0;
    if (!this.rects) this._build();
    // Standing inside a grown rect (hugging a wall): step out to its nearest edge first
    for (let k = 0; k < 3; k++) {
      const r = this.rects.find(q => inside(q, ax, az));
      if (!r) break;
      const dl = ax - r.x0, dr = r.x1 - ax, dn = az - r.z0, ds = r.z1 - az;
      const m = Math.min(dl, dr, dn, ds);
      if (m === dl) ax = r.x0 - 0.05; else if (m === dr) ax = r.x1 + 0.05;
      else if (m === dn) az = r.z0 - 0.05; else az = r.z1 + 0.05;
      out.push({ x: ax, z: az });
    }
    // Goal inside one (a spot right against a fence): pull it out the same way
    for (let k = 0; k < 3; k++) {
      const r = this.rects.find(q => inside(q, bx, bz));
      if (!r) break;
      const dl = bx - r.x0, dr = r.x1 - bx, dn = bz - r.z0, ds = r.z1 - bz;
      const m = Math.min(dl, dr, dn, ds);
      if (m === dl) bx = r.x0 - 0.05; else if (m === dr) bx = r.x1 + 0.05;
      else if (m === dn) bz = r.z0 - 0.05; else bz = r.z1 + 0.05;
    }
    // Obstacles near the trip only
    const pad = 30;
    const minX = Math.min(ax, bx) - pad, maxX = Math.max(ax, bx) + pad;
    const minZ = Math.min(az, bz) - pad, maxZ = Math.max(az, bz) + pad;
    const rects = [];
    for (const r of this.rects) {
      if (r.x1 < minX || r.x0 > maxX || r.z1 < minZ || r.z0 > maxZ) continue;
      rects.push(r);
    }
    if (segClear(rects, ax, az, bx, bz)) { out.push({ x: bx, z: bz }); return out; }

    const nodes = [{ x: ax, z: az }, { x: bx, z: bz }];
    for (const r of rects) {
      for (const [x, z] of [[r.x0 - CORNER_OUT, r.z0 - CORNER_OUT], [r.x1 + CORNER_OUT, r.z0 - CORNER_OUT],
        [r.x0 - CORNER_OUT, r.z1 + CORNER_OUT], [r.x1 + CORNER_OUT, r.z1 + CORNER_OUT]]) {
        let free = true;
        for (const o of rects) if (inside(o, x, z)) { free = false; break; }
        if (free) nodes.push({ x, z });
      }
    }
    // A* (lazy edges)
    const n = nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const h = (i) => Math.hypot(nodes[i].x - bx, nodes[i].z - bz);
    g[0] = 0; f[0] = h(0);
    const open = [0];
    let found = false, iter = 0;
    while (open.length && iter++ < 400) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
      const cur = open[bi];
      open.splice(bi, 1);
      if (cur === 1) { found = true; break; }
      closed[cur] = 1;
      const c = nodes[cur];
      for (let j = 1; j < n; j++) {
        if (closed[j] || j === cur) continue;
        const d = Math.hypot(nodes[j].x - c.x, nodes[j].z - c.z);
        const ng = g[cur] + d;
        if (ng >= g[j]) continue;
        if (!segClear(rects, c.x, c.z, nodes[j].x, nodes[j].z)) continue;
        g[j] = ng; f[j] = ng + h(j); prev[j] = cur;
        if (!open.includes(j)) open.push(j);
      }
    }
    if (!found) { out.push({ x: bx, z: bz }); return out; }
    const chain = [];
    for (let i = 1; i > 0; i = prev[i]) chain.push(i);
    for (let k = chain.length - 1; k >= 0; k--) out.push({ x: nodes[chain[k]].x, z: nodes[chain[k]].z });
    return out;
  }
}

function inside(r, x, z) { return x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1; }

/** Segment vs grown rects (Liang–Barsky slab test). */
function segClear(rects, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  for (const r of rects) {
    let t0 = 0, t1 = 1;
    if (!clip(-dx, ax - r.x0)) continue;
    if (!clip(dx, r.x1 - ax)) continue;
    if (!clip(-dz, az - r.z0)) continue;
    if (!clip(dz, r.z1 - az)) continue;
    if (t0 < t1) return false;
    function clip(p, q) {
      if (Math.abs(p) < 1e-9) return q > 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    }
  }
  return true;
}

function quatToMat(q) {
  const { x, y, z, w } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}
