/**
 * Ground — the one place that answers "how high is the walkable ground here?" for the whole
 * club. Pure (no three / cannon imports), so Node scripts (npm run validate) can use it too.
 *
 * The club is flat (y 0) except inside the sunken Centre Court bowl (court6), whose analytic
 * model is the StadiumLayout that World hands to setGroundModel() first thing. Without a model
 * every function returns the flat answer, and every height rule returns today's value outside
 * the bowl's cut (groundAt = 0), so nothing outside the bowl behaves differently.
 *
 * Everything here is allocation-free except planLevelRoute (per route, never per frame).
 * Use groundAt(x, z), never a literal 0, for "the ground under this point".
 */

/**
 * Physics collision groups. The y = 0 plane is GROUND_TOP while a bowl exists (dynamic bodies
 * inside the cut drop it from their mask and fall through the hole), the pit floor plane is
 * PIT_FLOOR, and ghost spectators are SPECTATOR (every dynamic mask excludes it).
 */
export const GROUND_GROUPS = Object.freeze({ WORLD: 1, GROUND_TOP: 2, PIT_FLOOR: 4, SPECTATOR: 8 });

/** Default visual ground extents (the 240 × 200 ground plane centred on the origin). */
const DEFAULT_EXTENTS = Object.freeze({ x0: -120, x1: 120, z0: -100, z1: 100 });

let _model = null;
const _extents = { x0: DEFAULT_EXTENTS.x0, x1: DEFAULT_EXTENTS.x1, z0: DEFAULT_EXTENTS.z0, z1: DEFAULT_EXTENTS.z1 };

/** World calls this first thing: a StadiumLayout (computeStadiumLayout) or null for a flat club. */
export function setGroundModel(layoutOrNull) {
  _model = layoutOrNull || null;
}

/** The StadiumLayout in use, or null (flat club). */
export function getGroundModel() {
  return _model;
}

/** Id of the sunken court ('court6'), or null without a bowl. */
export function stadiumCourtId() {
  return _model ? _model.id : null;
}

/** Walk-surface y at (x, z): 0 without a model, outside the cut, or for NaN. */
export function groundAt(x, z) {
  return _model ? _model.groundAt(x, z) : 0;
}

/** Lowest walk surface of the centre and the four points ±r in x and z. */
export function groundMinAround(x, z, r) {
  return _model ? _model.groundMinAround(x, z, r) : 0;
}

/** Strictly inside the bowl's physics hole (the cut). False without a model or for NaN. */
export function inCut(x, z) {
  return _model ? _model.inCut(x, z) : false;
}

/** Inside the cut grown by footprintPad (0.6) + margin. False without a model or for NaN. */
export function inFootprint(x, z, margin = 0) {
  return _model ? _model.inFootprint(x, z, margin) : false;
}

/** Somewhere a wandering member may walk to: outside the footprint + 0.5. False for NaN. */
export function isWanderable(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  return _model ? _model.isWanderable(x, z) : true;
}

/** 'ground' (outside the cut), 'pit' (court level) or 'stand' (a raised row / aisle step). */
export function levelOf(x, z) {
  return _model ? _model.levelOf(x, z) : 'ground';
}

/** Both points on the same level; for 'stand' also the same stand side and row. */
export function sameLevel(ax, az, bx, bz) {
  return _model ? _model.sameLevel(ax, az, bx, bz) : true;
}

/** Writes {x, z, y: 0} of the nearest aisle top into `out` and returns it; null without a bowl. */
export function nearestExit(x, z, out) {
  return _model ? _model.nearestExit(x, z, out) : null;
}

/**
 * Pushes (x, z) out of the footprint grown by `margin` to its nearest edge. Writes {x, z}
 * into `out` (unchanged when already outside) and returns it.
 */
export function pushOutOfFootprint(x, z, margin, out) {
  if (_model) return _model.pushOutOfFootprint(x, z, margin, out);
  out.x = x;
  out.z = z;
  return out;
}

/**
 * Route between levels of the bowl (ground ↔ pit ↔ stand rows through the aisles).
 * Returns null when neither endpoint is in the cut (use the ground planner), otherwise clears
 * and fills `out` with {x, z} waypoints (start excluded, goal included) and returns it.
 * groundLeg(ax, az, bx, bz, tmp) is the caller's ground planner (fills tmp the same way).
 */
export function planLevelRoute(ax, az, bx, bz, out, groundLeg, opts = null) {
  return _model ? _model.planLevelRoute(ax, az, bx, bz, out, groundLeg, opts) : null;
}

/** Visual ground plane extents {x0, x1, z0, z1} (World sets them when it builds the plane). */
export function setGroundExtents(ext) {
  if (!ext) return;
  for (const k of ['x0', 'x1', 'z0', 'z1']) {
    if (Number.isFinite(ext[k])) _extents[k] = ext[k];
  }
}

/** Current ground extents (a shared object: read, don't keep or mutate). */
export function getGroundExtents() {
  return _extents;
}
