import { SIZES, COLORS } from '../utils/Constants.js';

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
 * Besides the heights, the layout carries everything Stadium builds and the planners walk:
 *   seats / spectatorSeatSpecs   every visual seat; the reserved NPC seats (Seats.registerSeat args)
 *   boxes                        the physics boxes (stand rows, aisle half-steps, rim); their
 *                                max-of-tops is groundAt (selfCheck I3)
 *   openings / railRuns / bollards  the rim rail (gaps 0.9..1.2 m: walkers pass, the cart can't)
 *   planPitLeg / planLevelRoute  pit-floor and level-changing routes through the aisles
 *   selfCheck / validateStadiumMap  invariants I1-I6 and config ranges (npm run validate)
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

// Seats, rim and pit furniture (metres; the spec's numbers sheet)
const SEAT_TOP = 0.475;      // seat top above its tread (the bench seat top: the `sit` clip lines up)
const SEAT_APPROACH = 0.38;  // a sitter stands this far in front of the seat (lands on the row lane)
const BOLLARD_H = 0.9;       // Players' Walk bollard height (its size is the aisle's `bollard`)
const PIER_W = 0.55;         // arch piers: 0.55 × 2.9 × 0.55
const PIER_H = 2.9;
const SB_LEG_AT = 2.6;       // scoreboard legs at ±2.6 along the board, 0.35 square
const SB_LEG = 0.35;
const UMPIRE_HALF_U = 0.5;   // umpire chair body: 1.0 × 2.4 × 1.2 from the court surface
const UMPIRE_HALF_V = 0.6;
const UMPIRE_H = 2.4;
const PIT_GROW = 0.45;       // pit-leg obstacles grown by a walker radius + air

const SEAT_COLORS = {
  stand: COLORS.stadiumSeat ?? 0x2f6b45,
  front: COLORS.stadiumSeatFront ?? 0x24503a,
  box: COLORS.stadiumSeatBox ?? 0xefe3c2,
};

const snap = (v) => Math.round(v * 1e9) / 1e9;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Deterministic 0..1 hash of two integers (same mix as Textures.hash2; kept here so Node needs no three). */
function hash2(ix, iy) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** '#rrggbb' / 0xrrggbb → number (fallback when missing or malformed). */
function parseColor(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v & 0xffffff;
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim())) return parseInt(v.trim().replace('#', ''), 16);
  return fallback;
}

/** ±5 % value jitter of a colour by h (0..1). */
function jitterColor(c, h) {
  const f = 0.95 + 0.1 * h;
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}

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

/**
 * { errors, warnings } for the stadium block of a map (npm run validate): the block parses, the
 * config stays in its tested ranges (rows 6–9, tread ≥ 0.85, riser 0.40–0.50 so an aisle
 * half-step ≤ 0.25 is climbable — selfCheck I6's limit — and a row front is not, cut edges on even
 * metres, the pad + 0.8 inside the floor, aisles ≥ 1.2 wide inside their stand without overlaps
 * and clear of the camera wells,
 * every rail gap 0.9 ≤ gap < 1.2, masts and scoreboards outside the wells and the footprint, a
 * players' aisle, an aisle on every stand), then every selfCheck() invariant.
 */
export function validateStadiumMap(map) {
  const errors = [], warnings = [];
  const courts = map && isObj(map.areas) && Array.isArray(map.areas.courts) ? map.areas.courts : [];
  const list = courts.filter(c => isObj(c) && isObj(c.stadium));
  if (!list.length) return { errors, warnings };
  if (list.length > 1) errors.push(`stadium: only one court may have a stadium block (${list.map(c => c.id).join(', ')})`);
  const c = list[0];
  const tag = `stadium (${c.id})`;
  let L;
  try {
    L = computeStadiumLayout(c);
  } catch (e) {
    errors.push(`${tag}: ${e && e.message ? e.message : e}`);
    return { errors, warnings };
  }
  const N = L.N, E = 1e-9;
  if (N < 6 || N > 9) errors.push(`${tag}: rows ${N} outside 6..9`);
  if (L.T < 0.85 - E) errors.push(`${tag}: tread ${L.T} m is under 0.85`);
  // R ≤ 0.50: every aisle step is R / 2, and selfCheck I6 allows 0.25 at most; R ≥ 0.40 keeps row fronts unclimbable
  if (L.R < 0.40 - E || L.R > 0.50 + E) {
    errors.push(`${tag}: riser ${L.R.toFixed(3)} m outside 0.40..0.50 (it is -(center.y + ${SURFACE_Y}) / (rows - 1); an aisle half-step R / 2 must stay ≤ 0.25, a row front ≥ 0.40)`);
  }
  for (const k of ['x0', 'x1', 'z0', 'z1']) {
    const v = L.cut[k];
    if (Math.abs(v / 2 - Math.round(v / 2)) > 1e-6) errors.push(`${tag}: cut edge ${k} = ${v} is not on even metres (floorHalf + rows × tread from the centre)`);
  }
  const padU = L.pad.x1 - L.cx, padV = L.pad.z1 - L.cz;
  if (L.U[0] < padU + 0.8 - E || L.V[0] < padV + 0.8 - E) {
    errors.push(`${tag}: floorHalf (${L.U[0]}, ${L.V[0]}) must be ≥ the pad (${padU}, ${padV}) + 0.8`);
  }
  // aisles
  const wellHalf = (L.wells[0].x1 - L.wells[0].x0) / 2;
  if (!L.aisles.some(a => a.players)) errors.push(`${tag}: no aisle has "players": true (the Players' Walk)`);
  for (let si = 0; si < 4; si++) {
    const side = SIDES[si], list2 = L.aisles.filter(a => a.sideIndex === si);
    if (!list2.length) errors.push(`${tag}: stand ${side} has no aisle`);
    const ext = si < 2 ? L.V[0] : L.U[0];
    for (const a of list2) {
      if (a.width < 1.2 - E) errors.push(`${tag}: aisle ${a.id} is ${a.width} m wide (min 1.2)`);
      if (Math.abs(a.at) + a.half > ext + E) errors.push(`${tag}: aisle ${a.id} runs past its stand (|at| + width/2 > ${ext})`);
      if (si >= 2 && Math.abs(a.at) - a.half < wellHalf - E) errors.push(`${tag}: end aisle ${a.id} cuts into the camera well (|at| − width/2 < ${wellHalf})`);
      if (a.bollard > 0 && !(a.bollard < a.width)) errors.push(`${tag}: aisle ${a.id} bollard is wider than the aisle`);
      for (const l of a.lanes) if (Math.abs(l) >= a.half) errors.push(`${tag}: aisle ${a.id} lane ${l} is outside the aisle`);
    }
    for (let i = 0; i < list2.length; i++) {
      for (let j = i + 1; j < list2.length; j++) {
        const a = list2[i], b = list2[j];
        if (Math.abs(a.at - b.at) < a.half + b.half + E) errors.push(`${tag}: aisles ${a.id} and ${b.id} overlap`);
      }
    }
  }
  const r = L.rail;
  if (!(r.d0 >= 0 && r.d1 > r.d0)) errors.push(`${tag}: rail needs 0 ≤ d0 < d1`);
  if (r.d1 >= L.footprintPad) warnings.push(`${tag}: the rail (d1 ${r.d1}) reaches past the footprint pad ${L.footprintPad}`);
  if (r.height < 0.9) warnings.push(`${tag}: rail height ${r.height} m is low`);
  for (const o of L.openings) {
    const w = o.a1 - o.a0;
    if (w < 0.9 - E || w >= 1.2) errors.push(`${tag}: rail gap at aisle ${o.aisleId} is ${w.toFixed(3)} m (want 0.9 ≤ gap < 1.2: walkers pass, the cart can't)`);
  }
  // end boards: on the pad, clear of the court and the floor edge
  const eb = L.endBoards;
  if (!(eb.v0 < eb.v1) || eb.v0 <= SIZES.courtDepth / 2 || eb.v1 >= L.V[0] || eb.halfU >= L.U[0]) {
    errors.push(`${tag}: endBoards must sit behind the baselines on the floor (courtDepth/2 < v0 < v1 < floorHalf.v, halfU < floorHalf.u)`);
  }
  // masts and scoreboards: outside the camera wells and the footprint
  const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
  const fp = L.footprint;
  for (const b of L.blockers) {
    if (b.tag !== 'building') continue;
    const rect = { x0: b.cx - b.hx, x1: b.cx + b.hx, z0: b.cz - b.hz, z1: b.cz + b.hz };
    if (overlaps(rect, fp)) errors.push(`${tag}: mast / scoreboard at (${b.cx}, ${b.cz}) is inside the footprint`);
    for (const w of L.wells) if (overlaps(rect, w)) errors.push(`${tag}: mast / scoreboard at (${b.cx}, ${b.cz}) stands in a camera well`);
  }
  if (L.arch === null && isObj(c.stadium.arch)) warnings.push(`${tag}: arch aisle not found`);
  if (!L.seats.length) warnings.push(`${tag}: no seats fit`);
  if (L.spectatorSeatSpecs.length < 12) warnings.push(`${tag}: only ${L.spectatorSeatSpecs.length} NPC seats (spectators need more)`);
  const crowd = isObj(c.stadium.crowd) ? c.stadium.crowd : {};
  for (const k of ['capacity', 'capacityLow']) {
    if (crowd[k] !== undefined && !(Number.isInteger(crowd[k]) && crowd[k] >= 0 && crowd[k] <= 600)) errors.push(`${tag}: crowd.${k} must be an integer 0..600`);
  }
  for (const m of L.selfCheck()) errors.push(`${tag}: ${m}`);
  return { errors, warnings };
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

    // Court furniture that stands on the pit floor (Court.js show-court mode; planPitLeg obstacles)
    this.umpireChair = c.umpireChair === true || c.id === 'court1';
    this.umpire = { u0: -(SIZES.courtWidth / 2 + 0.95) - UMPIRE_HALF_U, u1: -(SIZES.courtWidth / 2 + 0.95) + UMPIRE_HALF_U, halfV: UMPIRE_HALF_V, height: UMPIRE_H };

    this._buildRail();
    this._buildSeats();
    this._buildBoxes();
    this._buildPitObstacles();
  }

  // ───────────────────────────── rim: rail runs and openings ─────────────────────────────

  /**
   * The rim rail sits just outside the cut (depth cut + d0 .. cut + d1 on each stand). Every
   * aisle gets an opening: a 1.4 m aisle the rail's `opening` (1.1 m, narrower than a cart), an
   * aisle with a bollard (the Players' Walk) its full width split in two by the bollard. Runs are
   * the rail pieces between openings; the four sides overlap at the corners.
   *   this.openings: { si, side, aisleId, a0, a1 } one per gap (a = along-stand coordinate)
   *   this.railRuns: { si, side, a0, a1 }
   *   this.bollards: { si, side, aisleId, a, size }
   */
  _buildRail() {
    const N = this.N, r = this.rail;
    this.openings = [];
    this.railRuns = [];
    this.bollards = [];
    for (let si = 0; si < 4; si++) {
      const side = SIDES[si];
      const ext = (si < 2 ? this.V[N] : this.U[N]) + r.d1;
      const breaks = [];   // stretches of the rail left out: one per aisle
      for (const a of this._aislesBySide[si]) {
        if (a.bollard > 0) {
          // the whole aisle width, split in two by the bollard (it stands in for the rail between the gaps)
          const hb = a.bollard / 2;
          breaks.push({ a0: a.at - a.half, a1: a.at + a.half });
          this.openings.push({ si, side, aisleId: a.id, a0: snap(a.at - a.half), a1: snap(a.at - hb) });
          this.openings.push({ si, side, aisleId: a.id, a0: snap(a.at + hb), a1: snap(a.at + a.half) });
          this.bollards.push({ si, side, aisleId: a.id, a: a.at, size: a.bollard });
        } else {
          const w = Math.min(r.opening, a.width) / 2;
          breaks.push({ a0: a.at - w, a1: a.at + w });
          this.openings.push({ si, side, aisleId: a.id, a0: snap(a.at - w), a1: snap(a.at + w) });
        }
      }
      breaks.sort((p, q) => p.a0 - q.a0);
      let s = -ext;
      for (const g of breaks) {
        if (g.a0 - s > 1e-6) this.railRuns.push({ si, side, a0: snap(s), a1: snap(g.a0) });
        s = Math.max(s, g.a1);
      }
      if (ext - s > 1e-6) this.railRuns.push({ si, side, a0: snap(s), a1: snap(ext) });
    }
  }

  // ───────────────────────────── seats ─────────────────────────────

  /**
   * Every visual seat (this.seats) and the reserved, NPC-sittable subset (this.spectatorSeatSpecs,
   * registered by Stadium through Seats.registerSeat). Seats sit on a global along grid
   * a = (i + 0.5)·pitch, keep |a| ≤ A_k − cornerClear (A_k = V_k on the side stands, U_k on the
   * ends: the corner squares stay empty) and clear every aisle by aisleClear. Centre depth
   * front_{k+1} − 0.30, seat top H_k + SEAT_TOP (the bench seat top, so the `sit` clip lines up).
   */
  _buildSeats() {
    const cfg = isObj(this.config.seats) ? this.config.seats : {};
    const pitch = num(cfg.pitch, 0.55, 'seats.pitch');
    const aisleClear = num(cfg.aisleClear, 0.25, 'seats.aisleClear');
    const cornerClear = num(cfg.cornerClear, 0.45, 'seats.cornerClear');
    if (!(pitch >= 0.4)) throw new StadiumConfigError('stadium: seats.pitch must be ≥ 0.4');
    const colors = isObj(cfg.colors) ? cfg.colors : {};
    const colStand = parseColor(colors.stand, SEAT_COLORS.stand);
    const colFront = parseColor(colors.front, SEAT_COLORS.front);
    const colBox = parseColor(colors.box, SEAT_COLORS.box);
    const mb = isObj(this.config.membersBox) ? this.config.membersBox : null;
    const box = mb ? {
      si: SIDE_INDEX[mb.side] ?? 0,
      rows: pair(mb.rows, [2, 4], 'membersBox.rows'),
      half: num(mb.halfAlong, 6.2, 'membersBox.halfAlong'),
    } : null;
    if (box) {
      const pa = this._aislesBySide[box.si].find(a => a.players) || null;
      box.at = pa ? pa.at : 0;
    }

    const N = this.N;
    const seats = [];
    this._seatRows = [];   // [si][k] → seats of that stand row, sorted by along
    for (let si = 0; si < 4; si++) {
      const front = si < 2 ? this.U : this.V, ext = si < 2 ? this.V : this.U;
      const aisles = this._aislesBySide[si];
      const rows = [];
      for (let k = 0; k < N; k++) {
        const d = front[k + 1] - 0.30;
        const lim = ext[k] - cornerClear;
        const iMax = Math.ceil(lim / pitch) + 1;
        const row = [];
        for (let i = -iMax - 1; i <= iMax; i++) {
          const a = snap((i + 0.5) * pitch);
          if (Math.abs(a) > lim + 1e-9) continue;
          let clear = true;
          for (let j = 0; j < aisles.length; j++) {
            if (Math.abs(a - aisles[j].at) < aisles[j].half + aisleClear) { clear = false; break; }
          }
          if (!clear) continue;
          const p = this.standToWorld(si, d, a, { x: 0, z: 0 });
          const inBox = !!box && box.si === si && k >= box.rows[0] && k <= box.rows[1] && Math.abs(a - box.at) <= box.half + 1e-9;
          let color;
          if (inBox) color = colBox;
          else if (k === 0) color = colFront;
          else color = jitterColor(colStand, hash2(i * 7 + si * 1013, k * 31 + 17));
          const seat = {
            x: snap(p.x), y: this.H[k] + SEAT_TOP, z: snap(p.z), yaw: SIDE_YAW[si],
            side: SIDES[si], si, row: k, along: a, depth: d, box: inBox, registered: false, color,
            baseY: this.H[k], index: seats.length,
          };
          row.push(seat);
          seats.push(seat);
        }
        rows.push(row);
      }
      this._seatRows.push(rows);
    }
    this.seats = seats;

    // Reserved NPC seats: the nearest few each side of every aisle, in row order (row 0 first)
    const ss = isObj(this.config.spectatorSeats) ? this.config.spectatorSeats : {};
    const sideRows = pair(ss.sideRows, [0, 4], 'spectatorSeats.sideRows');
    const endRows = pair(ss.endRows, [1, 3], 'spectatorSeats.endRows');
    const sideN = num(ss.sidePerAisleSide, 3, 'spectatorSeats.sidePerAisleSide');
    const endN = num(ss.endPerAisleSide, 2, 'spectatorSeats.endPerAisleSide');
    const specs = [];
    for (let k = 0; k < N; k++) {
      for (const aisle of this.aisles) {
        const si = aisle.sideIndex, isSide = si < 2;
        const rr = isSide ? sideRows : endRows;
        if (k < rr[0] || k > rr[1]) continue;
        const per = isSide ? sideN : endN;
        const row = this._seatRows[si][k];
        for (const sgn of [-1, 1]) {
          const cand = row.filter(s => !s.registered && (s.along - aisle.at) * sgn > 0)
            .sort((p, q) => Math.abs(p.along - aisle.at) - Math.abs(q.along - aisle.at));
          for (let n = 0; n < per && n < cand.length; n++) {
            const s = cand[n];
            s.registered = true;
            specs.push({
              x: s.x, y: s.y, z: s.z, yaw: s.yaw,
              id: `court:${this.id}@stand:${s.side}:${k}:${aisle.id}:${sgn > 0 ? '+' : '-'}${n + 1}`,
              opts: {
                reserved: true, approach: SEAT_APPROACH,
                stadium: { side: s.side, row: k, aisleId: aisle.id, along: s.along, box: s.box },
              },
              seatIndex: s.index,
            });
          }
        }
      }
    }
    this.spectatorSeatSpecs = specs;
  }

  // ───────────────────────────── physics boxes ─────────────────────────────

  /**
   * World-space boxes { cx, cy, cz, hx, hy, hz, stand } — the only source of the bowl's physics
   * shapes (Stadium adds one compound per stand plus one for the rim). Their max-of-tops equals
   * groundAt everywhere in the cut (selfCheck):
   *   side rows (w, e) k = 1..N−1: depth [U_k, U_N], |v| ≤ V_N, top H_k, bottom surfY − 0.5
   *   end rows (n, s)  k = 1..N−1: depth [V_k, V_N], |u| ≤ U_N
   *   aisle half-steps k = 0..N−2: depth [front_k + T/2, front_k+1] across the aisle, top H_k + R/2
   *   rim: rail runs, bollards, arch piers, mast columns, scoreboard legs (all outside the cut)
   */
  _buildBoxes() {
    const N = this.N, T = this.T, cx = this.cx, cz = this.cz;
    const Uc = this.U[N], Vc = this.V[N], bottom = this.surfY - 0.5;
    const boxes = [];
    const add = (x0, x1, y0, y1, z0, z1, stand) => boxes.push({
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, cz: (z0 + z1) / 2,
      hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2, stand,
      x0, x1, y0, y1, z0, z1,
    });
    // stand-local (d0..d1, a0..a1) → world rect on stand si
    const addStand = (si, d0, d1, a0, a1, y0, y1, stand) => {
      let x0, x1, z0, z1;
      switch (si) {
        case 0: x0 = cx - d1; x1 = cx - d0; z0 = cz + a0; z1 = cz + a1; break;
        case 1: x0 = cx + d0; x1 = cx + d1; z0 = cz + a0; z1 = cz + a1; break;
        case 2: x0 = cx + a0; x1 = cx + a1; z0 = cz + d0; z1 = cz + d1; break;
        default: x0 = cx + a0; x1 = cx + a1; z0 = cz - d1; z1 = cz - d0; break;
      }
      add(snap(x0), snap(x1), y0, y1, snap(z0), snap(z1), stand);
    };
    for (let si = 0; si < 4; si++) {
      const side = SIDES[si], isSide = si < 2;
      const front = isSide ? this.U : this.V, cutD = isSide ? Uc : Vc, ext = isSide ? Vc : Uc;
      for (let k = 1; k < N; k++) addStand(si, front[k], cutD, -ext, ext, bottom, this.H[k], side);
      for (const a of this._aislesBySide[si]) {
        for (let k = 0; k < N - 1; k++) {
          addStand(si, front[k] + T / 2, front[k + 1], a.at - a.half, a.at + a.half, this.H[k] - 0.3, this.H[k] + this.R / 2, side);
        }
      }
    }
    // Rim (outside the cut)
    const r = this.rail;
    for (const run of this.railRuns) {
      const cutD = run.si < 2 ? Uc : Vc;
      addStand(run.si, cutD + r.d0, cutD + r.d1, run.a0, run.a1, 0, r.height, 'rim');
    }
    for (const b of this.bollards) {
      const cutD = b.si < 2 ? Uc : Vc, dm = cutD + (r.d0 + r.d1) / 2, h = b.size / 2;
      addStand(b.si, dm - h, dm + h, b.a - h, b.a + h, 0, BOLLARD_H, 'rim');
    }
    if (this.arch) {
      for (const p of this.arch.piers) add(snap(p.x - PIER_W / 2), snap(p.x + PIER_W / 2), 0, PIER_H, snap(p.z - PIER_W / 2), snap(p.z + PIER_W / 2), 'rim');
    }
    for (const m of this.masts) add(snap(m.x - 0.3), snap(m.x + 0.3), 0, 3, snap(m.z - 0.3), snap(m.z + 0.3), 'rim');
    for (const b of this.scoreboards) {
      for (const sx of [-1, 1]) {
        const lx = b.x + sx * SB_LEG_AT;
        add(snap(lx - SB_LEG / 2), snap(lx + SB_LEG / 2), 0, b.bottom, snap(b.z - SB_LEG / 2), snap(b.z + SB_LEG / 2), 'rim');
      }
    }
    this.boxes = boxes;
  }

  // ───────────────────────────── pit legs ─────────────────────────────

  _buildPitObstacles() {
    const cx = this.cx, cz = this.cz, eb = this.endBoards, G = PIT_GROW;
    const raw = [];
    raw.push({ x0: cx - 8.1, x1: cx + 8.1, z0: cz - 0.1, z1: cz + 0.1 });                                  // net
    if (this.umpireChair) raw.push({ x0: cx + this.umpire.u0, x1: cx + this.umpire.u1, z0: cz - this.umpire.halfV, z1: cz + this.umpire.halfV });
    raw.push({ x0: cx - eb.halfU, x1: cx + eb.halfU, z0: cz + eb.v0, z1: cz + eb.v1 });                 // end boards
    raw.push({ x0: cx - eb.halfU, x1: cx + eb.halfU, z0: cz - eb.v1, z1: cz - eb.v0 });
    this._pitObs = raw.map(o => ({
      x0: o.x0 - G, x1: o.x1 + G, z0: o.z0 - G, z1: o.z1 + G,
      r0: o.x0 - 0.02, r1: o.x1 + 0.02, s0: o.z0 - 0.02, s1: o.z1 + 0.02,   // raw (for an endpoint inside the grown rect)
    }));
    const wu = this.U[0] + this.T / 2, wv = this.V[0] + this.T / 2;
    this._pitWalk = { x0: cx - wu, x1: cx + wu, z0: cz - wv, z1: cz + wv };
    const corners = [];
    for (const o of this._pitObs) {
      for (const [x, z] of [[o.x0 - 0.05, o.z0 - 0.05], [o.x1 + 0.05, o.z0 - 0.05], [o.x0 - 0.05, o.z1 + 0.05], [o.x1 + 0.05, o.z1 + 0.05]]) {
        const w = this._pitWalk;
        if (x < w.x0 || x > w.x1 || z < w.z0 || z > w.z1) continue;
        if (this._pitObs.some(q => x > q.x0 && x < q.x1 && z > q.z0 && z < q.z1)) continue;
        corners.push(x, z);
      }
    }
    this._pitCorners = new Float64Array(corners);
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

  // ───────────────────────────── routes ─────────────────────────────

  /**
   * Pit-floor walk from A to B around the net, the umpire chair and the end boards: a visibility
   * graph over those obstacles grown by 0.45 (corner nodes pushed out 0.05; only corners inside the
   * walkable rect |u| ≤ U0 + T/2, |v| ≤ V0 + T/2), Dijkstra on preallocated arrays, Liang–Barsky
   * segment tests. An endpoint inside a grown rect (standing at the net) is tested against that
   * obstacle's own rect instead. Clears and fills `out` ({x, z}, start excluded, goal included)
   * and returns it. Per route, never per frame.
   */
  planPitLeg(ax, az, bx, bz, out) {
    out.length = 0;
    this._pitLegInto(ax, az, bx, bz, out);
    return out;
  }

  /** planPitLeg, appending to `out`. */
  _pitLegInto(ax, az, bx, bz, out) {
    // An end inside an obstacle itself (only a teleport could put it there): step out first / stop short
    if (this._pitOut(ax, az, _pitA)) { ax = _pitA.x; az = _pitA.z; pushPt(out, ax, az); }
    if (this._pitOut(bx, bz, _pitA)) { bx = _pitA.x; bz = _pitA.z; }
    if (this._pitClear(ax, az, bx, bz)) { pushPt(out, bx, bz); return out; }
    const cn = this._pitCorners, nc = cn.length >> 1, n = Math.min(PIT_MAX, nc + 2);
    const X = _PX, Z = _PZ, D = _PD, prev = _PP, done = _PDone;
    X[0] = ax; Z[0] = az; X[1] = bx; Z[1] = bz;
    for (let i = 2; i < n; i++) { X[i] = cn[2 * (i - 2)]; Z[i] = cn[2 * (i - 2) + 1]; }
    for (let i = 0; i < n; i++) { D[i] = Infinity; prev[i] = -1; done[i] = 0; }
    D[0] = 0;
    for (;;) {
      let cur = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && D[i] < best) { best = D[i]; cur = i; }
      if (cur < 0 || cur === 1) break;
      done[cur] = 1;
      for (let j = 1; j < n; j++) {
        if (done[j]) continue;
        const d = best + Math.hypot(X[j] - X[cur], Z[j] - Z[cur]);
        if (d >= D[j]) continue;
        if (!this._pitClear(X[cur], Z[cur], X[j], Z[j])) continue;
        D[j] = d;
        prev[j] = cur;
      }
    }
    if (prev[1] < 0) { pushPt(out, bx, bz); return out; }   // boxed in: straight (the rescue pass is the net)
    let len = 0;
    for (let i = 1; i > 0 && len < PIT_MAX; i = prev[i]) _PChain[len++] = i;
    for (let k = len - 1; k >= 0; k--) pushPt(out, X[_PChain[k]], Z[_PChain[k]]);
    return out;
  }

  /** (x, z) inside an obstacle's own rect → nearest point just outside it in `out`; returns whether it moved. */
  _pitOut(x, z, out) {
    let moved = false;
    for (let k = 0; k < 3; k++) {
      let hit = null;
      for (const o of this._pitObs) if (x > o.r0 && x < o.r1 && z > o.s0 && z < o.s1) { hit = o; break; }
      if (!hit) break;
      const dl = x - hit.r0, dr = hit.r1 - x, dn = z - hit.s0, ds = hit.s1 - z, m = Math.min(dl, dr, dn, ds);
      if (m === dl) x = hit.r0 - 0.03; else if (m === dr) x = hit.r1 + 0.03; else if (m === dn) z = hit.s0 - 0.03; else z = hit.s1 + 0.03;
      moved = true;
    }
    out.x = x;
    out.z = z;
    return moved;
  }

  _pitClear(ax, az, bx, bz) {
    const obs = this._pitObs, dx = bx - ax, dz = bz - az;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      let x0 = o.x0, x1 = o.x1, z0 = o.z0, z1 = o.z1;
      if ((ax > x0 && ax < x1 && az > z0 && az < z1) || (bx > x0 && bx < x1 && bz > z0 && bz < z1)) {
        x0 = o.r0; x1 = o.r1; z0 = o.s0; z1 = o.s1;
      }
      if (segHitsRect(ax, az, dx, dz, x0, x1, z0, z1)) return false;
    }
    return true;
  }

  /**
   * See Ground.planLevelRoute. Null when neither endpoint is in the cut; otherwise clears and
   * fills `out` with {x, z} points (start excluded, goal included) through the aisles:
   *   ground → pit     the aisle with the least |A − top| + |foot − B| (opts.prefer 'players'
   *                    takes 6 m off the Players' Walk): groundLeg(A → top), lip, land[N−1..0],
   *                    foot, then planPitLeg(foot → B); pit → ground is the reverse
   *   ground ↔ stand   the stand's aisle nearest along the row: top, lip, landings down to the row
   *   stand ↔ pit      the stand's aisle: landings, foot, planPitLeg
   *   stand ↔ stand    same row: [B]; same stand: via the landings; other stand: via the pit
   *   pit ↔ pit        planPitLeg
   * An endpoint inside an aisle column counts as that aisle's row. The Players' Walk descends on
   * its + lane and climbs on its − lane (keep right); other aisles use their centre line.
   * groundLeg(ax, az, bx, bz, tmp) is the caller's ground planner (fills tmp, start excluded).
   */
  planLevelRoute(ax, az, bx, bz, out, groundLeg, opts = null) {
    if (!Number.isFinite(ax) || !Number.isFinite(az) || !Number.isFinite(bx) || !Number.isFinite(bz)) return null;
    if (!this.inCut(ax, az) && !this.inCut(bx, bz)) return null;
    out.length = 0;
    const A = this._classify(ax, az, _clsA), B = this._classify(bx, bz, _clsB);
    const prefer = !!(opts && opts.prefer === 'players');
    const LA = A.level, LB = B.level, N = this.N;
    const p = _nodeTmp;
    if (LA === 'pit' && LB === 'pit') {
      this._pitLegInto(ax, az, bx, bz, out);
    } else if (LA === 'ground' && LB === 'pit') {
      const ai = this._bestAisle(ax, az, bx, bz, prefer), lane = laneOf(ai, true);
      this._aisleNode(ai, lane, 'top', 0, p);
      this._groundInto(ax, az, p.x, p.z, groundLeg, out);
      this._pushNode(ai, lane, 'lip', 0, out);
      for (let k = N - 1; k >= 0; k--) this._pushNode(ai, lane, 'land', k, out);
      this._aisleNode(ai, lane, 'foot', 0, p);
      pushPt(out, p.x, p.z);
      this._pitLegInto(p.x, p.z, bx, bz, out);
    } else if (LA === 'pit' && LB === 'ground') {
      const ai = this._bestAisle(bx, bz, ax, az, prefer), lane = laneOf(ai, false);
      this._aisleNode(ai, lane, 'foot', 0, p);
      this._pitLegInto(ax, az, p.x, p.z, out);
      for (let k = 0; k < N; k++) this._pushNode(ai, lane, 'land', k, out);
      this._pushNode(ai, lane, 'lip', 0, out);
      this._aisleNode(ai, lane, 'top', 0, p);
      pushPt(out, p.x, p.z);
      this._groundInto(p.x, p.z, bx, bz, groundLeg, out);
    } else if (LA === 'ground' && LB === 'stand') {
      const ai = this._standAisle(B), lane = laneOf(ai, true);
      this._aisleNode(ai, lane, 'top', 0, p);
      this._groundInto(ax, az, p.x, p.z, groundLeg, out);
      this._pushNode(ai, lane, 'lip', 0, out);
      for (let k = N - 1; k >= B.row; k--) this._pushNode(ai, lane, 'land', k, out);
      pushPt(out, bx, bz);
    } else if (LA === 'stand' && LB === 'ground') {
      const ai = this._standAisle(A), lane = laneOf(ai, false);
      for (let k = A.row; k < N; k++) this._pushNode(ai, lane, 'land', k, out);
      this._pushNode(ai, lane, 'lip', 0, out);
      this._aisleNode(ai, lane, 'top', 0, p);
      pushPt(out, p.x, p.z);
      this._groundInto(p.x, p.z, bx, bz, groundLeg, out);
    } else if (LA === 'stand' && LB === 'pit') {
      const ai = this._standAisle(A), lane = laneOf(ai, true);
      for (let k = A.row; k >= 0; k--) this._pushNode(ai, lane, 'land', k, out);
      this._aisleNode(ai, lane, 'foot', 0, p);
      pushPt(out, p.x, p.z);
      this._pitLegInto(p.x, p.z, bx, bz, out);
    } else if (LA === 'pit' && LB === 'stand') {
      const ai = this._standAisle(B), lane = laneOf(ai, false);
      this._aisleNode(ai, lane, 'foot', 0, p);
      this._pitLegInto(ax, az, p.x, p.z, out);
      for (let k = 0; k <= B.row; k++) this._pushNode(ai, lane, 'land', k, out);
      pushPt(out, bx, bz);
    } else if (LA === 'stand' && LB === 'stand') {
      if (A.si === B.si && A.row === B.row) {
        pushPt(out, bx, bz);
      } else if (A.si === B.si) {
        let ai = A.aisle || B.aisle, bestC = Infinity;
        if (!ai) {
          for (const a of this._aislesBySide[A.si]) {
            const cst = Math.abs(A.along - a.at) + Math.abs(B.along - a.at);
            if (cst < bestC) { bestC = cst; ai = a; }
          }
        }
        if (!ai) ai = this._standAisle(A);
        const lane = laneOf(ai, B.row < A.row);
        if (B.row > A.row) for (let k = A.row; k <= B.row; k++) this._pushNode(ai, lane, 'land', k, out);
        else for (let k = A.row; k >= B.row; k--) this._pushNode(ai, lane, 'land', k, out);
        pushPt(out, bx, bz);
      } else {
        const aA = this._standAisle(A), aB = this._standAisle(B);
        const lA = laneOf(aA, true), lB = laneOf(aB, false);
        for (let k = A.row; k >= 0; k--) this._pushNode(aA, lA, 'land', k, out);
        this._aisleNode(aA, lA, 'foot', 0, p);
        pushPt(out, p.x, p.z);
        const fx = p.x, fz = p.z;
        this._aisleNode(aB, lB, 'foot', 0, p);
        this._pitLegInto(fx, fz, p.x, p.z, out);
        for (let k = 0; k <= B.row; k++) this._pushNode(aB, lB, 'land', k, out);
        pushPt(out, bx, bz);
      }
    } else {
      // ground ↔ ground never gets here (one end is in the cut); keep the goal reachable anyway
      pushPt(out, bx, bz);
    }
    return out;
  }

  /** { level: 'ground'|'pit'|'stand', si, row, along, aisle } of (x, z), written into `o`. */
  _classify(x, z, o) {
    o.si = -1; o.row = -1; o.along = 0; o.aisle = null;
    if (!this.inCut(x, z)) { o.level = 'ground'; return o; }
    if (Math.abs(this.groundAt(x, z) - this.surfY) < 0.01) { o.level = 'pit'; return o; }
    const sp = this.standPoint(x, z, _spC);
    o.level = 'stand';
    o.si = SIDE_INDEX[sp.side];
    o.row = sp.row;
    o.along = sp.along;
    o.aisle = sp.aisle;
    return o;
  }

  /** Aisle between ground point g and pit point p: least |g − top| + |foot − p| (− 6 for the players' aisle). */
  _bestAisle(gx, gz, px, pz, prefer) {
    let best = null, bc = Infinity;
    for (const a of this.aisles) {
      const c = Math.hypot(gx - a.top.x, gz - a.top.z) + Math.hypot(a.foot.x - px, a.foot.z - pz) - (prefer && a.players ? 6 : 0);
      if (c < bc) { bc = c; best = a; }
    }
    return best;
  }

  /** The aisle a stand point uses: its own column, else the nearest along its row on its stand. */
  _standAisle(cls) {
    if (cls.aisle) return cls.aisle;
    let best = null, bd = Infinity;
    const list = cls.si >= 0 ? this._aislesBySide[cls.si] : this.aisles;
    for (const a of list) {
      const d = Math.abs(cls.along - a.at);
      if (d < bd) { bd = d; best = a; }
    }
    return best || this.aisles[0];
  }

  /** World point of an aisle node on `lane`: 'top' | 'lip' | 'land' (row k) | 'foot'. */
  _aisleNode(aisle, lane, which, k, out) {
    const front = aisle.sideIndex < 2 ? this.U : this.V, cutD = front[this.N];
    let d;
    if (which === 'top') d = cutD + AISLE_TOP_OUT;
    else if (which === 'lip') d = cutD - AISLE_LIP_IN;
    else if (which === 'land') d = front[k] + LAND_IN;
    else d = front[0] - FOOT_IN;
    return this.aislePoint(aisle, lane, d, out);
  }

  _pushNode(aisle, lane, which, k, out) {
    this._aisleNode(aisle, lane, which, k, _nodeTmp2);
    pushPt(out, _nodeTmp2.x, _nodeTmp2.z);
  }

  /** The caller's ground planner from A to B, appended to `out` (B always ends the leg). */
  _groundInto(ax, az, bx, bz, groundLeg, out) {
    _legTmp.length = 0;
    let pts = null;
    if (typeof groundLeg === 'function') {
      try {
        const r = groundLeg(ax, az, bx, bz, _legTmp);
        pts = Array.isArray(r) ? r : _legTmp;
      } catch (e) {
        pts = null;
      }
    }
    if (pts) {
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i];
        if (q && Number.isFinite(q.x) && Number.isFinite(q.z)) pushPt(out, q.x, q.z);
      }
    }
    pushPt(out, bx, bz);
    _legTmp.length = 0;
  }

  // ───────────────────────────── invariants ─────────────────────────────

  /**
   * Invariant checks (CI via validateStadiumMap; Stadium.debugCheck covers the live bodies):
   *   I1 cut edges on even metres
   *   I2 within 0.5 m inside the cut edge: groundAt 0 and a stand box with top 0 under it
   *   I3 every point of a 0.25 m grid in the cut: support (max stand-box top, or the pit plane)
   *      equals groundAt exactly (points on a box edge are checked just either side of it)
   *   I4 rim boxes entirely outside the cut; every rail opening 0.9 ≤ gap < 1.2
   *   I5 nothing above y 0 inside the cut (stand boxes, end boards, umpire chair)
   *   I6 along every aisle line (every 0.05 m) consecutive groundAt steps ≤ 0.25; row fronts off
   *      the aisles rise ≥ 0.40
   * Returns a list of problems ([] = all good).
   */
  selfCheck() {
    const errs = [];
    const add = (m) => { if (errs.length < 40) errs.push(m); else if (errs.length === 40) errs.push('… more problems'); };
    const N = this.N, c = this.cut, EPS = 1e-9;
    // I1
    for (const k of ['x0', 'x1', 'z0', 'z1']) {
      const v = c[k];
      if (Math.abs(v / 2 - Math.round(v / 2)) > 1e-9) add(`I1: cut.${k} = ${v} is not on even metres`);
    }
    const stand = this.boxes.filter(b => b.stand !== 'rim');
    const rim = this.boxes.filter(b => b.stand === 'rim');
    const support = (x, z) => {
      let s = this.surfY;
      for (let i = 0; i < stand.length; i++) {
        const b = stand[i];
        if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.y1 > s) s = b.y1;
      }
      return s;
    };
    const agree = (x, z) => Math.abs(support(x, z) - this.groundAt(x, z)) < EPS;
    const agreeNear = (x, z) => {
      if (agree(x, z)) return true;
      const e = 1e-5;
      return agree(x + e, z + e) && agree(x - e, z + e) && agree(x + e, z - e) && agree(x - e, z - e);
    };
    // I3
    const nx = Math.round((c.x1 - c.x0) / 0.25), nz = Math.round((c.z1 - c.z0) / 0.25);
    let bad = 0;
    for (let i = 1; i < nx; i++) {
      const x = c.x0 + i * 0.25;
      for (let j = 1; j < nz; j++) {
        const z = c.z0 + j * 0.25;
        if (agreeNear(x, z)) continue;
        if (bad++ < 8) add(`I3: support ${support(x, z).toFixed(4)} ≠ groundAt ${this.groundAt(x, z).toFixed(4)} at (${x}, ${z})`);
      }
    }
    if (bad > 8) add(`I3: ${bad} grid points disagree in all`);
    // I2
    const rimZero = (x, z) => this.groundAt(x, z) === 0 && Math.abs(support(x, z)) <= EPS;
    for (const inset of [0.01, 0.25, 0.49]) {
      for (let x = c.x0 + inset; x <= c.x1 - inset + 1e-9; x += 0.25) {
        for (const z of [c.z0 + inset, c.z1 - inset]) if (!rimZero(x, z)) add(`I2: support at (${x.toFixed(2)}, ${z.toFixed(2)}) is not 0`);
      }
      for (let z = c.z0 + inset; z <= c.z1 - inset + 1e-9; z += 0.25) {
        for (const x of [c.x0 + inset, c.x1 - inset]) if (!rimZero(x, z)) add(`I2: support at (${x.toFixed(2)}, ${z.toFixed(2)}) is not 0`);
      }
    }
    // I4
    for (const b of rim) {
      if (b.x1 > c.x0 && b.x0 < c.x1 && b.z1 > c.z0 && b.z0 < c.z1) add(`I4: rim box at (${b.cx.toFixed(2)}, ${b.cz.toFixed(2)}) reaches into the cut`);
    }
    for (const o of this.openings) {
      const w = o.a1 - o.a0;
      if (w < 0.9 - EPS || w >= 1.2) add(`I4: rail opening at aisle ${o.aisleId} is ${w.toFixed(3)} m (want 0.9 ≤ gap < 1.2)`);
    }
    // I5
    for (const b of stand) if (b.y1 > EPS) add(`I5: stand box top ${b.y1} above the lawn`);
    const boardTop = this.baseY + SURFACE_Y + this.endBoards.height;
    if (!(boardTop < 0)) add(`I5: end boards reach y ${boardTop.toFixed(3)} (must stay below the lawn)`);
    if (this.umpireChair && !(this.surfY + this.umpire.height < 0)) add('I5: umpire chair reaches above the lawn');
    // I6: aisle lines
    const q = { x: 0, z: 0 };
    for (const a of this.aisles) {
      const lanes = a.lanes.includes(0) ? a.lanes : [0].concat(a.lanes);
      for (const lane of lanes) {
        const pts = [];
        this._aisleNode(a, lane, 'top', 0, q); pts.push(q.x, q.z);
        this._aisleNode(a, lane, 'lip', 0, q); pts.push(q.x, q.z);
        for (let k = N - 1; k >= 0; k--) { this._aisleNode(a, lane, 'land', k, q); pts.push(q.x, q.z); }
        this._aisleNode(a, lane, 'foot', 0, q); pts.push(q.x, q.z);
        let prev = this.groundAt(pts[0], pts[1]), worst = 0;
        for (let s = 2; s < pts.length; s += 2) {
          const x0 = pts[s - 2], z0 = pts[s - 1], x1 = pts[s], z1 = pts[s + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.05));
          for (let t = 1; t <= n; t++) {
            const h = this.groundAt(x0 + (x1 - x0) * t / n, z0 + (z1 - z0) * t / n);
            worst = Math.max(worst, Math.abs(h - prev));
            prev = h;
          }
        }
        if (worst > 0.25 + EPS) add(`I6: aisle ${a.id} lane ${lane} has a ${worst.toFixed(3)} m step`);
        if (Math.abs(prev - this.surfY) > EPS) add(`I6: aisle ${a.id} foot is not on the pit floor`);
      }
    }
    // I6: row fronts away from the aisles
    for (let si = 0; si < 4; si++) {
      const front = si < 2 ? this.U : this.V, ext = si < 2 ? this.V[0] : this.U[0];
      const aisles = this._aislesBySide[si];
      let worst = Infinity;
      for (let a = -ext + 0.3; a <= ext - 0.3; a += 0.5) {
        if (aisles.some(ai => Math.abs(a - ai.at) < ai.half + 0.05)) continue;
        for (let k = 1; k < N; k++) {
          this.standToWorld(si, front[k] + 0.01, a, q);
          const hi = this.groundAt(q.x, q.z);
          this.standToWorld(si, front[k] - 0.01, a, q);
          worst = Math.min(worst, hi - this.groundAt(q.x, q.z));
        }
      }
      if (worst < 0.40 - EPS) add(`I6: a ${SIDES[si]} row front rises only ${worst.toFixed(3)} m (walkers could climb it)`);
    }
    return errs;
  }
}

// ───────────────────────────── scratch (routes; never per frame) ─────────────────────────────

const PIT_MAX = 32;
const _PX = new Float64Array(PIT_MAX), _PZ = new Float64Array(PIT_MAX), _PD = new Float64Array(PIT_MAX);
const _PP = new Int32Array(PIT_MAX), _PDone = new Uint8Array(PIT_MAX), _PChain = new Int32Array(PIT_MAX);
const _clsA = { level: 'ground', si: -1, row: -1, along: 0, aisle: null };
const _clsB = { level: 'ground', si: -1, row: -1, along: 0, aisle: null };
const _spC = { side: null, row: -1, along: 0, depth: 0, aisle: null };
const _nodeTmp = { x: 0, z: 0 };
const _nodeTmp2 = { x: 0, z: 0 };
const _pitA = { x: 0, z: 0 };
const _legTmp = [];

/** Descending (into the bowl) the Players' Walk uses its + lane, climbing its − lane; others their centre. */
function laneOf(aisle, down) {
  const L = aisle.lanes;
  if (!L || !L.length) return 0;
  if (L.length === 1) return L[0];
  let lo = L[0], hi = L[0];
  for (let i = 1; i < L.length; i++) { if (L[i] < lo) lo = L[i]; if (L[i] > hi) hi = L[i]; }
  return down ? hi : lo;
}

/** Append {x, z} unless it repeats the last point. */
function pushPt(out, x, z) {
  const n = out.length;
  if (n) {
    const l = out[n - 1];
    if (Math.abs(l.x - x) < 1e-6 && Math.abs(l.z - z) < 1e-6) return;
  }
  out.push({ x, z });
}

let _lb0 = 0, _lb1 = 1;
function lbClip(p, q) {
  if (Math.abs(p) < 1e-12) return q > 0;
  const t = q / p;
  if (p < 0) { if (t > _lb1) return false; if (t > _lb0) _lb0 = t; } else { if (t < _lb0) return false; if (t < _lb1) _lb1 = t; }
  return true;
}

/** Does the segment (a, a + d) pass through the open rect's interior? (Liang–Barsky) */
function segHitsRect(ax, az, dx, dz, x0, x1, z0, z1) {
  _lb0 = 0; _lb1 = 1;
  if (!lbClip(-dx, ax - x0) || !lbClip(dx, x1 - ax) || !lbClip(-dz, az - z0) || !lbClip(dz, z1 - az)) return false;
  return _lb1 - _lb0 > 1e-9;
}
