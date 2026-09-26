/**
 * NavRooms — tiny door-aware walking graph for the club's buildings (no three.js, no physics).
 *
 * Each building registers its rooms (axis-aligned rects), the doors between them (a point on each
 * side; a side that lies in no room is "outside") and optional extra blockers (e.g. the pool).
 * planRoute(a, b) returns the walking points from a to b (excluding a, including b):
 *  - straight line when neither end is indoors and nothing registered is in the way (cheap path),
 *  - otherwise Dijkstra over door points: inside a room points connect directly; outside they
 *    connect when the segment clears every room / blocker rect (with corner nodes to walk around).
 * Straight lines inside a room are assumed walkable (rooms are furnished to leave door lanes).
 */

const GROW = 0.35;       // walker radius added to rects for the outside visibility test
const CORNER = 0.55;     // corner nodes sit this far outside the grown rects

const _rooms = [];       // { x0, x1, z0, z1 }
const _blockers = [];    // { x0, x1, z0, z1 } — rooms + extra blockers, grown by GROW
const _doors = [];       // { a: {x,z}, b: {x,z}, ra, rb } (room index or -1 = outside)
let _corners = null;     // outside corner nodes
let _dirty = true;

export function registerNav({ rooms = [], doors = [], blockers = [] }) {
  for (const r of rooms) _rooms.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 });
  for (const d of doors) _doors.push({ a: { x: d.a.x, z: d.a.z }, b: { x: d.b.x, z: d.b.z }, ra: -1, rb: -1 });
  for (const r of rooms.concat(blockers)) _blockers.push({ x0: r.x0 - GROW, x1: r.x1 + GROW, z0: r.z0 - GROW, z1: r.z1 + GROW });
  _dirty = true;
}

/** Forget everything (tests / world rebuilds). */
export function clearNav() {
  _rooms.length = 0; _blockers.length = 0; _doors.length = 0; _corners = null; _dirty = true;
}

export function roomAt(x, z) {
  for (let i = 0; i < _rooms.length; i++) {
    const r = _rooms[i];
    if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return i;
  }
  return -1;
}

function prepare() {
  if (!_dirty) return;
  _dirty = false;
  for (const d of _doors) { d.ra = roomAt(d.a.x, d.a.z); d.rb = roomAt(d.b.x, d.b.z); }
  _corners = [];
  for (const r of _blockers) {
    for (const [x, z] of [[r.x0 - CORNER, r.z0 - CORNER], [r.x1 + CORNER, r.z0 - CORNER], [r.x0 - CORNER, r.z1 + CORNER], [r.x1 + CORNER, r.z1 + CORNER]]) {
      if (roomAt(x, z) >= 0 || insideBlocker(x, z)) continue;
      _corners.push({ x, z });
    }
  }
}

function insideBlocker(x, z) {
  for (const r of _blockers) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return true;
  return false;
}

/**
 * Segment clear of every grown rect (Liang–Barsky). A rect whose grown margin holds an endpoint
 * (someone hugging a wall outside) is tested without the margin, so they can still walk away.
 */
function clearOutside(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  for (const g of _blockers) {
    const near = (g.x0 < ax && ax < g.x1 && g.z0 < az && az < g.z1) || (g.x0 < bx && bx < g.x1 && g.z0 < bz && bz < g.z1);
    const s = near ? GROW : 0;
    const r = { x0: g.x0 + s, x1: g.x1 - s, z0: g.z0 + s, z1: g.z1 - s };
    let t0 = 0, t1 = 1, ok = true;
    const clip = (p, q) => {
      if (Math.abs(p) < 1e-9) return q > 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    };
    ok = clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dz, az - r.z0) && clip(dz, r.z1 - az);
    if (ok && t0 < t1) return false;
  }
  return true;
}

/**
 * Walking route from (ax, az) to (bx, bz). Writes {x, z} points into `out` (reused) and returns it.
 */
export function planRoute(ax, az, bx, bz, out = []) {
  out.length = 0;
  if (!_rooms.length) { out.push({ x: bx, z: bz }); return out; }
  prepare();
  const ra = roomAt(ax, az), rb = roomAt(bx, bz);
  if ((ra === rb && ra >= 0) || (ra < 0 && rb < 0 && clearOutside(ax, az, bx, bz))) { out.push({ x: bx, z: bz }); return out; }

  // Nodes: 0 = start, 1 = goal, then door endpoints (2 per door), then outside corners.
  const nodes = [{ x: ax, z: az, r: ra }, { x: bx, z: bz, r: rb }];
  for (const d of _doors) { nodes.push({ x: d.a.x, z: d.a.z, r: d.ra }); nodes.push({ x: d.b.x, z: d.b.z, r: d.rb }); }
  const cornerStart = nodes.length;
  for (const c of _corners) nodes.push({ x: c.x, z: c.z, r: -1 });
  const n = nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[0] = 0;
  const partner = (i) => (i >= 2 && i < cornerStart ? (((i - 2) ^ 1) + 2) : -1);
  for (let it = 0; it < n; it++) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === 1) break;
    done[u] = 1;
    const U = nodes[u];
    const relax = (v) => {
      if (done[v]) return;
      const V = nodes[v];
      const nd = dist[u] + Math.hypot(V.x - U.x, V.z - U.z);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    };
    const p = partner(u);
    if (p >= 0) relax(p);                            // walk through the door
    for (let v = 1; v < n; v++) {
      if (v === u || done[v]) continue;
      const V = nodes[v];
      if (U.r !== V.r) continue;                     // same room (or both outside) only
      if (U.r < 0 && !clearOutside(U.x, U.z, V.x, V.z)) continue;
      relax(v);
    }
  }
  if (!Number.isFinite(dist[1])) { out.push({ x: bx, z: bz }); return out; }
  const chain = [];
  for (let i = 1; i > 0; i = prev[i]) chain.push(i);
  for (let k = chain.length - 1; k >= 0; k--) out.push({ x: nodes[chain[k]].x, z: nodes[chain[k]].z });
  return out;
}
