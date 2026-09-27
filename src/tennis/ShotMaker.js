import { planShot, BallFlight } from './BallFlight.js';
import { SURFACES, spinVector } from './TennisPhysics.js';
import {
  impactInverse, impactForward, apparentCOR, faceRotate, strokeErrors, serveErrors, sweetness,
} from './RacketImpact.js';

/**
 * ShotMaker — one pipeline for every racket shot in the game (the player, Coach Rafa, tour
 * opponents, the members' daytime matches), so a shot always comes out of the same physics:
 *
 *  1. The intention: a target, a spin profile, a speed (or pace), a net margin.
 *  2. planShot: the launch that lands on the target (the real integrator: drag, lift, wind).
 *  3. impactInverse: the racket velocity and face that make that launch from the ball as it
 *     really arrives (its speed and spin) — asking for less spin (then less speed) when the
 *     stroke would be beyond a racket.
 *  4. Execution: inside the green window (|e| ≤ gw, on the strings) the stroke adapts — a weaker
 *     contact is still aimed right (the inverse used that contact's restitution), so the ball
 *     lands on target; outside it the timing error turns and tilts the face (strokeErrors /
 *     serveErrors), the swing loses speed and an off-axis contact twists the head.
 *  5. impactForward: what really comes off the strings → the launch the caller flies with
 *     BallFlight.launch.
 *
 * Pure JS; the result objects are the caller's (nothing allocated per shot).
 */

const _plan = {};
const _sol = {};
const _imp = {};
const _err = {};
const _n = { x: 0, y: 0, z: 0 };
const _V = { x: 0, y: 0, z: 0 };
const _bv = { x: 0, y: 0, z: 0 };
const _bw = { x: 0, y: 0, z: 0 };
const _pv = { x: 0, y: 0, z: 0 };
const _pw = { x: 0, y: 0, z: 0 };
const _prof = { top: 0, side: 0, gyro: 0 };
const _C = { x: 0, y: 0, z: 0 };
const _B = { x: 0, z: 0 };
const _opts = { speed: 0, pace: 0, margin: 0, minT: 0, gravityOnly: false };

// makeShot's spin / speed search state (module scratch: no closure per shot)
const _try = { p0: null, intent: null, env: null, eA: 0, spinScale: 1, speedScale: 1, tries: 0 };

/** Plan the shot with the spin scaled by k (and the speed by _try.speedScale); can the racket make it? */
function tryScale(k) {
  const T = _try, p0 = T.p0, intent = T.intent;
  T.spinScale = k;
  _prof.top = p0.top * k; _prof.side = p0.side * k; _prof.gyro = p0.gyro * k;
  _opts.speed = intent.speed ? intent.speed * T.speedScale : 0;
  _opts.pace = intent.pace ? intent.pace * T.speedScale : 0;
  planShot(_plan, _C, _B, _prof, _opts, T.env);
  _pv.x = _plan.vx; _pv.y = _plan.vy; _pv.z = _plan.vz;
  _pw.x = _plan.wx; _pw.y = _plan.wy; _pw.z = _plan.wz;
  impactInverse(_bv, _bw, _pv, _pw, T.eA, _sol);
  T.tries++;
  return _sol.ok;
}

/**
 * Make a shot.
 *  ball   { x, y, z, vx, vy, vz, wx, wy, wz } — the ball at the moment of contact (BallFlight.at)
 *  intent { tx, tz (landing target, world), profile { top, side, gyro } (hitter frame),
 *           speed (launch m/s) or pace (average m/s), margin (m over the tape), minT,
 *           kind 'ground' | 'volley' | 'smash' | 'serve', wing 'fh' | 'bh' }
 *  exec   { e (timing error, s: − early, + late), gw (green half-width, s), a, b (string contact:
 *           −1…+1 each, beyond ±1 = the frame), B (the head's across axis, for the twist; optional),
 *           outSign (serves: +1 when the wide side is the hitter's left, −1 when it is the right) }
 *  env    the BallFlight env of the court
 * Writes res = { vx, vy, vz, wx, wy, wz (the launch), green, frame, perfect, eA, sweet, spinScale,
 *   speedScale, racket (racket speed m/s), n { x, y, z } (the face at contact), dYaw, dPitch,
 *   planT, planClear, ok } and returns it.
 */
export function makeShot(res, ball, intent, exec, env) {
  const a = exec && Number.isFinite(exec.a) ? exec.a : 0;
  const b = exec && Number.isFinite(exec.b) ? exec.b : 0;
  const e = exec && Number.isFinite(exec.e) ? exec.e : 0;
  const gw = exec && Number.isFinite(exec.gw) ? exec.gw : 0.05;
  const frame = Math.abs(a) > 1 || Math.abs(b) > 1;
  const green = Math.abs(e) <= gw && !frame;
  const kind = intent.kind || 'ground';
  // The stroke is shaped for the contact it gets inside the window, for a clean one outside it
  const eAplan = green ? apparentCOR(a, b) : apparentCOR(0, 0);
  _bv.x = ball.vx; _bv.y = ball.vy; _bv.z = ball.vz;
  _bw.x = ball.wx || 0; _bw.y = ball.wy || 0; _bw.z = ball.wz || 0;
  _C.x = ball.x; _C.y = ball.y; _C.z = ball.z;
  _B.x = intent.tx; _B.z = intent.tz;
  const p0 = intent.profile || _prof;
  _opts.speed = intent.speed || 0; _opts.pace = intent.pace || 0;
  _opts.margin = Number.isFinite(intent.margin) ? intent.margin : 0.4;
  _opts.minT = intent.minT || 0; _opts.gravityOnly = false;
  let ok = false;
  // The stroke must be one a racket can make: too fast → ask for less speed; too much brush /
  // slip (e.g. topspin off a heavy topspin ball) → bisect the spin down to the most it allows
  // (a few plans at most; the last feasible one is kept)
  const T = _try;
  T.p0 = p0; T.intent = intent; T.env = env; T.eA = eAplan;
  T.spinScale = 1; T.speedScale = 1; T.tries = 0;
  let lo = -1, hi = 1;
  while (T.tries < 8) {
    if (tryScale(hi)) { ok = true; break; }
    if (_sol.why === 'speed' && T.speedScale > 0.55) { T.speedScale *= 0.88; continue; }
    // (spin: bisect between the last feasible scale lo and the failed hi)
    const next = lo < 0 ? (hi > 0.5 ? 0.5 : 0) : 0.5 * (lo + hi);
    if (lo < 0 && hi === 0) break;                 // even no spin fails: keep the attempt
    if (lo >= 0 && hi - lo < 0.12) { tryScale(lo); ok = _sol.ok; break; }
    if (tryScale(next)) { lo = next; ok = true; if (hi - next < 0.2) break; hi = 0.5 * (next + hi); if (tryScale(hi)) break; tryScale(lo); break; }
    hi = next;
  }
  const spinScale = T.spinScale, speedScale = T.speedScale;
  T.p0 = null; T.intent = null; T.env = null;
  // Execution
  let dYaw = 0, dPitch = 0, speedK = 1;
  if (!green) {
    if (kind === 'serve') {
      serveErrors(e, gw, _err);
      dPitch = _err.dPitch;
      dYaw = _err.dOut * (exec && exec.outSign ? exec.outSign : 1);
      speedK = _err.speedK;
    } else {
      strokeErrors(e, gw, intent.wing || 'fh', kind === 'serve' ? 'ground' : kind, _err);
      dYaw = _err.dYaw; dPitch = _err.dPitch; speedK = _err.speedK;
    }
  }
  const n = res.n || (res.n = { x: 0, y: 0, z: 0 });
  faceRotate(_sol.n, dYaw, dPitch, _n);
  n.x = _n.x; n.y = _n.y; n.z = _n.z;
  _V.x = _sol.V.x * speedK; _V.y = _sol.V.y * speedK; _V.z = _sol.V.z * speedK;
  impactForward(_bv, _bw, _V, _n, a, b, green ? null : (exec && exec.B) || null, _imp, _sol.gyro * speedK);
  res.vx = _imp.vx; res.vy = _imp.vy; res.vz = _imp.vz;
  res.wx = _imp.wx; res.wy = _imp.wy; res.wz = _imp.wz;
  res.green = green; res.frame = frame; res.perfect = green && Math.abs(e) <= 0.35 * gw;
  res.eA = _imp.eA; res.sweet = sweetness(a, b);
  res.spinScale = spinScale; res.speedScale = speedScale;
  res.racket = _sol.speed * speedK;
  res.dYaw = dYaw; res.dPitch = dPitch;
  res.planT = _plan.T; res.planClear = _plan.clear;
  res.ok = ok;
  return res;
}

/**
 * Pipeline self-check (npm run validate): shots released inside the green window land on their
 * targets (so the player's aim, clamped inside the lines, is always in); early and late errors
 * go the way the game promises. Returns [] or error strings.
 */
export async function shotSelfCheck() {
  const errs = [];
  const fr = { cx: 0, cz: 0, c: 1, s: 0 };
  const env = { surfY: 0.15, frame: fr, fence: { v: 14.25, top: Infinity, halfU: Infinity, open: false }, surface: SURFACES.hard, wind: null, groundAt: null };
  const f = new BallFlight(), res = {}, o = {};
  let worst = 0, n = 0;
  const W = {};
  for (let i = 0; i < 60; i++) {
    // an incoming topspin rally ball from the far side, taken at its peak
    const tx = -4 + (i % 9), tz = -6.5 - (i % 5) * 1.1;
    spinVector(6 + (i % 3), 0, 0, 0, 1, W);
    const ball = { x: (i % 5) - 2, y: 0.95 + (i % 4) * 0.1, z: 12.4, vx: 0, vy: 0.2, vz: 15, wx: W.x, wy: W.y, wz: W.z };
    const prof = [{ top: 8, side: 0, gyro: 0 }, { top: 2, side: 0.3, gyro: 0 }, { top: -7, side: 3.2, gyro: -1.2 }][i % 3];
    const intent = { tx, tz, profile: prof, speed: 20 + (i % 7) * 1.5, margin: 0.5, kind: 'ground', wing: i % 2 ? 'fh' : 'bh' };
    const exec = { e: ((i % 7) - 3) * 0.012, gw: 0.045, a: ((i % 5) - 2) * 0.3, b: ((i % 3) - 1) * 0.3, B: { x: 0, y: 1, z: 0 } };
    makeShot(res, ball, intent, exec, env);
    if (!res.green) continue;
    f.launch(0, ball.x, ball.y, ball.z, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, env);
    const bnc = f.firstBounce(), nc = f.netCross();
    if (!nc || nc.type === 'net') { errs.push(`green shot ${i} hit the net`); continue; }
    if (!bnc) { errs.push(`green shot ${i} never landed`); continue; }
    const d = Math.hypot(bnc.x - tx, bnc.z - tz);
    worst = Math.max(worst, d); n++;
  }
  if (!n) errs.push('shot check: no green shots sampled');
  if (worst > 0.08) errs.push(`shot check: a green shot landed ${worst.toFixed(3)} m off its target`);
  // An early forehand pulls to the hitter's left (a hitter at +z faces −z: the left is −x)
  spinVector(7, 0, 0, 0, 1, W);
  const ball = { x: 0, y: 1, z: 12.4, vx: 0, vy: 0, vz: 15, wx: W.x, wy: W.y, wz: W.z };
  const intent = { tx: 0, tz: -9, profile: { top: 8, side: 0, gyro: 0 }, speed: 24, margin: 0.6, kind: 'ground', wing: 'fh' };
  makeShot(res, ball, intent, { e: -0.08, gw: 0.04, a: 0, b: 0 }, env);
  f.launch(0, ball.x, ball.y, ball.z, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, env);
  const bE = f.firstBounce();
  if (!bE || !(bE.x < -0.5)) errs.push('shot check: an early forehand should pull to the left');
  makeShot(res, ball, intent, { e: 0.08, gw: 0.04, a: 0, b: 0 }, env);
  f.launch(0, ball.x, ball.y, ball.z, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, env);
  const bL = f.firstBounce();
  if (!bL || !(bL.x > 0.5)) errs.push('shot check: a late forehand should push to the right');
  // Serves (to the deuce box, the server's left: wide is −x): green lands in the box; early →
  // lower (net) and wide; late → longer and wide
  const sb = { x: 0.9, y: 2.45, z: 12.65, vx: 0, vy: -0.4, vz: 0, wx: 0, wy: 0, wz: 0 };
  const si = { tx: -2.6, tz: -5.2, profile: { top: 2.5, side: 1.2, gyro: 0.3 }, speed: 34, margin: 0.15, kind: 'serve', wing: 'fh' };
  makeShot(res, sb, si, { e: 0.02, gw: 0.04, a: 0, b: 0, outSign: 1 }, env);
  f.launch(0, sb.x, sb.y, sb.z, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, env);
  let bs = f.firstBounce();
  if (!bs || Math.hypot(bs.x - si.tx, bs.z - si.tz) > 0.08) errs.push('shot check: a green serve missed its target');
  makeShot(res, sb, si, { e: -0.1, gw: 0.04, a: 0, b: 0, outSign: 1 }, env);
  f.launch(0, sb.x, sb.y, sb.z, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, env);
  const ne = f.netCross(); bs = f.firstBounce();
  if (!(ne && ne.type === 'net') && !(bs && bs.x < si.tx - 0.4)) errs.push('shot check: an early serve should net or go wide');
  makeShot(res, sb, si, { e: 0.085, gw: 0.04, a: 0, b: 0, outSign: 1 }, env);
  f.launch(0, sb.x, sb.y, sb.z, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, env);
  bs = f.firstBounce();
  if (!(bs && (bs.z < si.tz - 0.4 || bs.x < si.tx - 0.4))) errs.push('shot check: a late serve should go long or wide');
  void o;
  return errs;
}
