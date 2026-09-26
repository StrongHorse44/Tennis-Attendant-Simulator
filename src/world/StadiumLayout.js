import { SIZES } from '../utils/Constants.js';

/**
 * StadiumLayout — the analytic model of the sunken Centre Court bowl (map.json → the court
 * entry with a `stadium` block). Pure (only Constants.js), so Node (npm run validate) can use it.
 *
 * Frame: u = x − cx (east +), v = z − cz (north +). "d" is depth from the court centre on a
 * stand, "a" the along-stand coordinate (v on the w / e side stands, u on the n / s end stands).
 *
 *   stand  world (d, a)          seats face  seat yaw (0 = +z)
 *   w      (cx − d, cz + a)      +x          +π/2
 *   e      (cx + d, cz + a)      −x          −π/2
 *   n      (cx + a, cz + d)      −z          π
 *   s      (cx + a, cz − d)      +z          0
 *
 * The pit floor (|u| < U0, |v| < V0) is at court level surfY = center.y + courtSurfaceY. Rows
 * 0..N−1 are treads T deep: row k spans depth [U_k, U_k+1) on the side stands (V_k on the ends)
 * at height H_k = surfY + k·R, R = −surfY / (N − 1), so row 0 is level with the court and the
 * last row is flush with the lawn (y 0). The cut (physics hole) is the back of the last row.
 * Aisles cut through the rows with half-steps: on rows k ≤ N − 2 the back half of an aisle
 * tread is raised by R / 2, so every rise on an aisle is R / 2 (climbable) while row risers (R)
 * block walkers.
 *
 * Everything is allocation-free except the per-route planners.
 */

export class StadiumConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StadiumConfigError';
  }
}

const SURFACE_Y = SIZES.courtSurfaceY ?? 0.15;
const SIDES = ['w', 'e', 'n', 's'];
const SIDE_INDEX = { w: 0, e: 1, n: 2, s: 3 };
/** Seat / arch yaw per stand: facing the court (Seats.js convention, 0 = +z). */
const SIDE_YAW = [Math.PI / 2, -Math.PI / 2, Math.PI, 0];

const AISLE_TOP_OUT = 1.5;   // aisle top node: this far outside the cut (on the ring path)
const AISLE_LIP_IN = 0.3;    // lip node: this far inside the cut (on the last row, y 0)
const LAND_IN = 0.24;        // landing node: this far behind a row's front edge
const FOOT_IN = 0.45;        // foot node: this far in front of the first row (on the pit floor)

const snap = (v) => Math.round(v * 1e9) / 1e9;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !ArrayBuffer.isView(o) && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function num(v, fallback, what) {
  if (v === undefined || v === null) {
    if (fallback === undefined) throw new StadiumConfigError(`stadium: ${what} is required`);
    return fallback;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new StadiumConfigError(`stadium: ${what} must be a finite number`);
  return v;
}

function pair(v, fallback, what) {
  if (v === undefined || v === null) return fallback.slice();
  if (!Array.isArray(v) || v.length !== 2) throw new StadiumConfigError(`stadium: ${what} must be [a, b]`);
  return [num(v[0], undefined, `${what}[0]`), num(v[1], undefined, `${what}[1]`)];
}

/** First areas.courts entry with a `stadium` object, or null. */
export function findStadiumCourt(map) {
  const courts = map && isObj(map.areas) && Array.isArray(map.areas.courts) ? map.areas.courts : null;
  if (!courts) return null;
  for (const c of courts) if (isObj(c) && isObj(c.stadium)) return c;
  return null;
}

/** Frozen StadiumLayout for a court entry with a `stadium` block, or throws StadiumConfigError. */
export function computeStadiumLayout(courtCfg) {
  if (!isObj(courtCfg)) throw new StadiumConfigError('stadium: court entry missing');
  if (!isObj(courtCfg.stadium)) throw new StadiumConfigError(`stadium: ${courtCfg.id} has no stadium block`);
  return deepFreeze(new StadiumLayout(courtCfg));
}

/** { errors, warnings } for the stadium block of a map (npm run validate). */
export function validateStadiumMap(map) { // eslint-disable-line no-unused-vars
  // Skeleton: stream A2 adds the config ranges, placement and selfCheck() checks
  return { errors: [], warnings: [] };
}

// Scratch for sameLevel (standPoint results)
const _spA = { side: null, row: -1, along: 0, depth: 0, aisle: null };
const _spB = { side: null, row: -1, along: 0, depth: 0, aisle: null };

export class StadiumLayout {
  constructor(courtCfg) {
    const c = courtCfg, s = c.stadium;
    if (typeof c.id !== 'string' || !c.id) throw new StadiumConfigError('stadium: court id missing');
    if (!isObj(c.center)) throw new StadiumConfigError(`stadium: ${c.id} has no center`);
    const rot = num(c.rotation, 0, 'rotation');
    if (rot !== 0) throw new StadiumConfigError(`stadium: ${c.id} rotation must be 0`);

    this.id = c.id;
    this.cx = num(c.center.x, undefined, 'center.x');
    this.cz = num(c.center.z, undefined, 'center.z');
    this.baseY = num(c.center.y, undefined, 'center.y');
    this.surfY = snap(this.baseY + SURFACE_Y);
    if (!(this.surfY < -0.1)) throw new StadiumConfigError(`stadium: ${c.id} center.y must sink the court below the ground`);

    if (!isObj(s.floorHalf)) throw new StadiumConfigError('stadium: floorHalf { u, v } is required');
    const fu = num(s.floorHalf.u, undefined, 'floorHalf.u'), fv = num(s.floorHalf.v, undefined, 'floorHalf.v');
    if (!(fu > 0 && fv > 0)) throw new StadiumConfigError('stadium: floorHalf must be positive');
    const N = num(s.rows, undefined, 'rows');
    if (!Number.isInteger(N) || N < 2 || N > 32) throw new StadiumConfigError('stadium: rows must be an integer 2..32');
    const T = num(s.tread, undefined, 'tread');
    if (!(T > 0)) throw new StadiumConfigError('stadium: tread must be positive');
    this.N = N;
    this.T = T;
    this.R = -this.surfY / (N - 1);

    this.U = new Float64Array(N + 1);
    this.V = new Float64Array(N + 1);
    this.H = new Float64Array(N);
    for (let k = 0; k <= N; k++) {
      this.U[k] = snap(fu + k * T);
      this.V[k] = snap(fv + k * T);
    }
    for (let k = 0; k < N; k++) this.H[k] = this.surfY + k * this.R;
    this.H[0] = this.surfY;
    this.H[N - 1] = 0;   // exact: the last row is flush with the lawn

    const cx = this.cx, cz = this.cz, Uc = this.U[N], Vc = this.V[N];
    this.footprintPad = num(s.footprintPad, 0.6, 'footprintPad');
    if (this.footprintPad < 0) throw new StadiumConfigError('stadium: footprintPad must be ≥ 0');
    const rect = (hx, hz) => ({ x0: snap(cx - hx), x1: snap(cx + hx), z0: snap(cz - hz), z1: snap(cz + hz) });
    this.cut = rect(Uc, Vc);
    this.floor = rect(this.U[0], this.V[0]);
    this.footprint = rect(Uc + this.footprintPad, Vc + this.footprintPad);
    // Court.js pad of a non-clay court: the 16-wide slab + 2 m surround, the fence line at depth/2 + 0.5
    this.pad = rect(SIZES.courtWidth / 2 + 2, SIZES.courtDepth / 2 + 0.5);

    // ── rim / extras (parsed with the spec defaults) ──
    const rail = isObj(s.rail) ? s.rail : {};
    this.rail = {
      d0: num(rail.d0, 0.05, 'rail.d0'), d1: num(rail.d1, 0.45, 'rail.d1'),
      height: num(rail.height, 1.05, 'rail.height'), opening: num(rail.opening, 1.1, 'rail.opening'),
    };
    this.concourse = num(s.concourse, 2.2, 'concourse');
    const eb = isObj(s.endBoards) ? s.endBoards : {};
    this.endBoards = {
      v0: num(eb.v0, 14.3, 'endBoards.v0'), v1: num(eb.v1, 14.45, 'endBoards.v1'),
      halfU: num(eb.halfU, 9.0, 'endBoards.halfU'), height: num(eb.height, 1.0, 'endBoards.height'),
    };

    // ── aisles ──
    if (!Array.isArray(s.aisles) || !s.aisles.length) throw new StadiumConfigError('stadium: aisles[] is required');
    this.aisles = [];
    this._aislesBySide = [[], [], [], []];
    const ids = new Set();
    for (const a of s.aisles) {
      if (!isObj(a) || typeof a.id !== 'string' || !a.id) throw new StadiumConfigError('stadium: every aisle needs an id');
      if (ids.has(a.id)) throw new StadiumConfigError(`stadium: duplicate aisle id "${a.id}"`);
      ids.add(a.id);
      const si = SIDE_INDEX[a.side];
      if (si === undefined) throw new StadiumConfigError(`stadium: aisle "${a.id}" side must be w, e, n or s`);
      const at = num(a.at, undefined, `aisle ${a.id}.at`);
      const width = num(a.width, undefined, `aisle ${a.id}.width`);
      if (!(width > 0)) throw new StadiumConfigError(`stadium: aisle "${a.id}" width must be positive`);
      let lanes = [0];
      if (a.lanes !== undefined) {
        if (!Array.isArray(a.lanes) || !a.lanes.length) throw new StadiumConfigError(`stadium: aisle "${a.id}" lanes must be a list`);
        lanes = a.lanes.map((l, i) => num(l, undefined, `aisle ${a.id}.lanes[${i}]`));
      }
      const aisle = {
        id: a.id, side: a.side, sideIndex: si, indexOnSide: this._aislesBySide[si].length,
        at, width, half: width / 2, players: !!a.players, lanes,
        bollard: num(a.bollard, 0, `aisle ${a.id}.bollard`),
        top: null, lip: null, land: [], foot: null,
      };
      const sideStand = si < 2;
      const front = sideStand ? this.U : this.V;
      const cutD = front[N];
      aisle.top = this._node(si, cutD + AISLE_TOP_OUT, at, 0);
      aisle.lip = this._node(si, cutD - AISLE_LIP_IN, at, 0);
      for (let k = 0; k < N; k++) aisle.land.push(this._node(si, front[k] + LAND_IN, at, this.H[k]));
      aisle.foot = this._node(si, front[0] - FOOT_IN, at, this.surfY);
      this.aisles.push(aisle);
      this._aislesBySide[si].push(aisle);
    }

    // ── camera wells, masts, scoreboards, arch, rim benches ──
    const cw = isObj(s.cameraWells) ? s.cameraWells : {};
    const wHalf = num(cw.halfU, 4.5, 'cameraWells.halfU');
    const wv = pair(cw.v, [16, 27], 'cameraWells.v');
    this.wells = [
      { side: 'n', x0: snap(cx - wHalf), x1: snap(cx + wHalf), z0: snap(cz + wv[0]), z1: snap(cz + wv[1]) },
      { side: 's', x0: snap(cx - wHalf), x1: snap(cx + wHalf), z0: snap(cz - wv[1]), z1: snap(cz - wv[0]) },
    ];

    const ms = isObj(s.masts) ? s.masts : {};
    const mu = num(ms.u, 22.8, 'masts.u'), mv = num(ms.v, 28.8, 'masts.v'), mh = num(ms.height, 16, 'masts.height');
    this.masts = [
      { x: snap(cx - mu), z: snap(cz + mv), height: mh },
      { x: snap(cx + mu), z: snap(cz + mv), height: mh },
      { x: snap(cx - mu), z: snap(cz - mv), height: mh },
      { x: snap(cx + mu), z: snap(cz - mv), height: mh },
    ];

    const sb = isObj(s.scoreboards) ? s.scoreboards : {};
    const sv = num(sb.v, 29.5, 'scoreboards.v');
    const sw = num(sb.width, 7.0, 'scoreboards.width'), sh = num(sb.height, 3.3, 'scoreboards.height');
    const sbot = num(sb.bottom, 2.2, 'scoreboards.bottom');
    this.scoreboards = [
      { side: 'n', x: cx, z: snap(cz + sv), yaw: Math.PI, w: sw, h: sh, bottom: sbot },   // behind the north end, facing −z
      { side: 's', x: cx, z: snap(cz - sv), yaw: 0, w: sw, h: sh, bottom: sbot },         // behind the south end, facing +z
    ];

    this.arch = null;
    if (isObj(s.arch)) {
      const aisle = this.aisles.find(a => a.id === s.arch.aisle) || this.aisles.find(a => a.players) || null;
      if (aisle) {
        const pa = num(s.arch.pierAlong, 1.55, 'arch.pierAlong'), ad = num(s.arch.d, 0.3, 'arch.d');
        const cutD = aisle.sideIndex < 2 ? Uc : Vc;
        const p1 = this.standToWorld(aisle.sideIndex, cutD + ad, aisle.at + pa, { x: 0, z: 0 });
        const p2 = this.standToWorld(aisle.sideIndex, cutD + ad, aisle.at - pa, { x: 0, z: 0 });
        p1.x = snap(p1.x); p1.z = snap(p1.z); p2.x = snap(p2.x); p2.z = snap(p2.z);
        this.arch = {
          aisleId: aisle.id, side: aisle.side, x: p1.x, z1: p1.z, z2: p2.z,
          yaw: SIDE_YAW[aisle.sideIndex], pierAlong: pa, d: ad, piers: [p1, p2],
        };
      }
    }

    this.rimBenches = [];
    if (Array.isArray(s.rimBenches)) {
      s.rimBenches.forEach((b, i) => {
        if (!isObj(b)) throw new StadiumConfigError(`stadium: rimBenches[${i}] must be { x, z, face }`);
        this.rimBenches.push({
          x: num(b.x, undefined, `rimBenches[${i}].x`), z: num(b.z, undefined, `rimBenches[${i}].z`),
          yaw: num(b.face, 0, `rimBenches[${i}].face`) * Math.PI / 180,
        });
      });
    }

    // ── placement blockers (World._collectBlockers appends these) ──
    const blk = (bx, bz, hx, hz, tag) => ({ cx: bx, cz: bz, hx, hz, tag });
    this.blockers = [
      blk(cx, cz, SIZES.courtWidth / 2 + 2.5, SIZES.courtDepth / 2 + 1.5, 'stadiumCourt'),
      blk(cx, cz, Uc + 1, Vc + 1, 'stadium'),
      blk(cx, cz, Uc + 8, Vc + 8, 'stadiumClear'),
    ];
    for (const w of this.wells) this.blockers.push(blk((w.x0 + w.x1) / 2, (w.z0 + w.z1) / 2, (w.x1 - w.x0) / 2, (w.z1 - w.z0) / 2, 'cameraWell'));
    for (const m of this.masts) this.blockers.push(blk(m.x, m.z, 0.9, 0.9, 'building'));
    for (const b of this.scoreboards) this.blockers.push(blk(b.x, b.z, b.w / 2 + 0.2, 0.6, 'building'));

    // The raw block (seats, spectatorSeats, membersBox, crowd, ... are read by StadiumLayout / Stadium)
    this.config = JSON.parse(JSON.stringify(s));

    // Filled by the full layout (stream A2); empty in the skeleton
    this.seats = [];
    this.spectatorSeatSpecs = [];
    this.boxes = [];
  }

  // ───────────────────────────── frame helpers ─────────────────────────────

  /** World {x, z} of stand-local (d, a) on stand side index si (0 w, 1 e, 2 n, 3 s). */
  standToWorld(si, d, a, out) {
    switch (si) {
      case 0: out.x = this.cx - d; out.z = this.cz + a; break;
      case 1: out.x = this.cx + d; out.z = this.cz + a; break;
      case 2: out.x = this.cx + a; out.z = this.cz + d; break;
      default: out.x = this.cx + a; out.z = this.cz - d; break;
    }
    return out;
  }

  _node(si, d, a, y) {
    const p = this.standToWorld(si, d, a, { x: 0, z: 0, y });
    p.x = snap(p.x);
    p.z = snap(p.z);
    return p;
  }

  /** World {x, z} of `aisle` at depth d on lane offset `lane` (along = at + lane). */
  aislePoint(aisle, lane, d, out) {
    return this.standToWorld(aisle.sideIndex, d, aisle.at + lane, out);
  }

  // ───────────────────────────── heights ─────────────────────────────

  groundAt(x, z) {
    if (!(x > this.cut.x0 && x < this.cut.x1 && z > this.cut.z0 && z < this.cut.z1)) return 0;
    const du = x - this.cx, dv = z - this.cz, u = Math.abs(du), v = Math.abs(dv), N = this.N, T = this.T;
    const ru = u < this.U[0] ? -1 : Math.min(N - 1, Math.floor((u - this.U[0]) / T));
    const rv = v < this.V[0] ? -1 : Math.min(N - 1, Math.floor((v - this.V[0]) / T));
    const k = ru > rv ? ru : rv;
    if (k < 0) return this.surfY;
    if (k < N - 1) {
      const sideOwns = ru >= rv, s = sideOwns ? (du < 0 ? 0 : 1) : (dv > 0 ? 2 : 3); // 0 w, 1 e, 2 n, 3 s
      if ((sideOwns ? u - this.U[k] : v - this.V[k]) >= T * 0.5) {
        const along = sideOwns ? dv : du, list = this._aislesBySide[s];
        for (let i = 0; i < list.length; i++) if (Math.abs(along - list[i].at) < list[i].half) return this.H[k] + this.R * 0.5;
      }
    }
    return this.H[k];
  }

  groundMinAround(x, z, r) {
    let m = this.groundAt(x, z), g;
    if ((g = this.groundAt(x - r, z)) < m) m = g;
    if ((g = this.groundAt(x + r, z)) < m) m = g;
    if ((g = this.groundAt(x, z - r)) < m) m = g;
    if ((g = this.groundAt(x, z + r)) < m) m = g;
    return m;
  }

  inCut(x, z) {
    const c = this.cut;
    return x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1;
  }

  inFootprint(x, z, margin = 0) {
    const f = this.footprint;
    return x > f.x0 - margin && x < f.x1 + margin && z > f.z0 - margin && z < f.z1 + margin;
  }

  isWanderable(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    return !this.inFootprint(x, z, 0.5);
  }

  levelOf(x, z) {
    if (!this.inCut(x, z)) return 'ground';
    return Math.abs(this.groundAt(x, z) - this.surfY) < 0.01 ? 'pit' : 'stand';
  }

  sameLevel(ax, az, bx, bz) {
    const la = this.levelOf(ax, az);
    if (la !== this.levelOf(bx, bz)) return false;
    if (la !== 'stand') return true;
    const a = this.standPoint(ax, az, _spA), b = this.standPoint(bx, bz, _spB);
    return a.side === b.side && a.row === b.row;
  }

  /**
   * Where (x, z) sits on the stands, written into `out` and returned:
   * { side: 'w'|'e'|'n'|'s' | null (pit floor / outside the cut), row: 0..N−1 (−1 when side is
   *   null), along: a, depth: d (on the owning stand, as in groundAt), aisle: the aisle whose
   *   column holds the point on that stand, or null }.
   */
  standPoint(x, z, out) {
    out.side = null; out.row = -1; out.along = 0; out.depth = 0; out.aisle = null;
    if (!this.inCut(x, z)) return out;
    const du = x - this.cx, dv = z - this.cz, u = Math.abs(du), v = Math.abs(dv), N = this.N, T = this.T;
    const ru = u < this.U[0] ? -1 : Math.min(N - 1, Math.floor((u - this.U[0]) / T));
    const rv = v < this.V[0] ? -1 : Math.min(N - 1, Math.floor((v - this.V[0]) / T));
    const k = ru > rv ? ru : rv;
    const sideOwns = ru >= rv;
    const s = sideOwns ? (du < 0 ? 0 : 1) : (dv > 0 ? 2 : 3);
    out.along = sideOwns ? dv : du;
    out.depth = sideOwns ? u : v;
    if (k < 0) return out;
    out.side = SIDES[s];
    out.row = k;
    const list = this._aislesBySide[s];
    for (let i = 0; i < list.length; i++) {
      if (Math.abs(out.along - list[i].at) < list[i].half) { out.aisle = list[i]; break; }
    }
    return out;
  }

  // ───────────────────────────── exits ─────────────────────────────

  /** Nearest aisle top (lane 0) to (x, z): writes {x, z, y: 0} into `out` and returns it. */
  nearestExit(x, z, out) {
    let best = null, bd = Infinity;
    for (let i = 0; i < this.aisles.length; i++) {
      const t = this.aisles[i].top;
      const dx = t.x - x, dz = t.z - z, d = dx * dx + dz * dz;
      if (d < bd || !best) { bd = d; best = t; }
    }
    if (!best) return null;
    out.x = best.x;
    out.z = best.z;
    out.y = 0;
    return out;
  }

  /** Out of the footprint grown by `margin` to its nearest edge ({x, z} unchanged when outside). */
  pushOutOfFootprint(x, z, margin, out) {
    const f = this.footprint, m = margin || 0;
    const x0 = f.x0 - m, x1 = f.x1 + m, z0 = f.z0 - m, z1 = f.z1 + m;
    out.x = x;
    out.z = z;
    if (!(x > x0 && x < x1 && z > z0 && z < z1)) return out;
    const dl = x - x0, dr = x1 - x, dn = z - z0, ds = z1 - z;
    const d = Math.min(dl, dr, dn, ds);
    if (d === dl) out.x = x0;
    else if (d === dr) out.x = x1;
    else if (d === dn) out.z = z0;
    else out.z = z1;
    return out;
  }

  // ───────────────────────────── routes (stream A2 completes) ─────────────────────────────

  /** Pit-floor walk from A to B around the net, umpire chair and end boards (skeleton: straight). */
  planPitLeg(ax, az, bx, bz, out) {
    out.length = 0;
    out.push({ x: bx, z: bz });
    return out;
  }

  /** See Ground.planLevelRoute (skeleton: null, callers use their ground planner). */
  planLevelRoute(ax, az, bx, bz, out, groundLeg, opts = null) { // eslint-disable-line no-unused-vars
    return null;
  }

  /** Invariant checks of heights vs the physics boxes: a list of problems (skeleton: none). */
  selfCheck() {
    return [];
  }
}
