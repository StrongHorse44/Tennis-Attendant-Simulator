import { SIZES } from '../utils/Constants.js';
import { TennisBall, BALL_RADIUS, GRAVITY } from '../entities/TennisBall.js';
import { CameraTracker } from '../entities/CharacterModel.js';

/**
 * TennisBallSim — the after-hours ball: an analytic TennisBall whose flight segments carry
 * their own vertical acceleration, so spin can be modelled without numeric integration.
 * Topspin (Magnus force down) = stronger "gravity": the ball dips late and kicks up and
 * forward off the court. Slice = weaker: it floats, then skids low. Every segment is still a
 * parabola on the session clock, so bounces, net crossings and racket contacts are exact
 * times that the session plans ahead (and the AI reads).
 *
 * Also exports the court constants shared by the tennis modules and the bounce model.
 */

export const G = GRAVITY;
export const R = BALL_RADIUS;
export const SURF = SIZES.courtSurfaceY ?? 0.15;
export const BALL_Y = SURF + R;          // ball centre touching the court
export const HALF_L = 12.3;              // baseline (court-local v)
export const SINGLES_W = 4.65;           // singles sideline (court-local u)
export const SERVICE_L = 6.62;           // service line
export const NET_H0 = 0.9, NET_H1 = 1.02, NET_POST = 7.8;
export const FENCE_V = 14.25;            // back fence (ball stops)
export const BASE_V = 12.9;              // baseline stand
export const LINE_TOL = R;               // a ball touching the line is in

/** Height of the net tape at court-local u (sags to the middle). */
export function netTop(u) {
  const k = Math.min(1, Math.abs(u) / NET_POST);
  return SURF + NET_H0 + (NET_H1 - NET_H0) * k * k;
}

/**
 * Spin model per shot type: g = vertical acceleration while flying (× G), and the bounce:
 * e = vertical restitution, kh = horizontal speed kept, g2 = acceleration after the bounce.
 */
export const SPIN = {
  flat: { g: 1.05, e: 0.72, kh: 0.72, g2: 1.0 },
  topspin: { g: 1.35, e: 0.8, kh: 0.8, g2: 1.08 },
  slice: { g: 0.78, e: 0.56, kh: 0.82, g2: 0.94 },
  lob: { g: 1.15, e: 0.76, kh: 0.66, g2: 1.0 },
  serve: { g: 1.1, e: 0.7, kh: 0.74, g2: 1.0 },
  kick: { g: 1.4, e: 0.82, kh: 0.72, g2: 1.06 },
  feed: { g: 1.1, e: 0.74, kh: 0.72, g2: 1.0 },
  dead: { g: 1.0, e: 0.6, kh: 0.7, g2: 1.0 },
};

export class TennisBallSim extends TennisBall {
  constructor(scene) {
    super(scene);
    this.mesh.name = 'AfterHoursBall';
    this.g = G;          // vertical acceleration of the current segment
    this.spin = 'flat';  // SPIN key of the current flight (bounce behaviour)
    this.bounced = 0;    // bounces since the last racket contact
    this.groundY = SURF;
  }

  /** Start a segment at time t from p with velocity v under acceleration g (default G). */
  launchG(t, px, py, pz, vx, vy, vz, g = G) {
    this.g = g;
    this.launch(t, px, py, pz, vx, vy, vz);
  }

  at(t) {
    const d = t - this.t0;
    this.pos.set(
      this.p0.x + this.v0.x * d,
      this.p0.y + this.v0.y * d - 0.5 * this.g * d * d,
      this.p0.z + this.v0.z * d,
    );
    return this.pos;
  }

  vyAt(t) { return this.v0.y - this.g * (t - this.t0); }

  /** Like TennisBall.sync, but the ball is the star here: drawn a bit larger with distance. */
  sync(visible) {
    if (!visible || !this.active) { super.sync(false); return; }
    super.sync(true);
    if (CameraTracker.valid) {
      const c = CameraTracker.position, p = this.pos;
      const d = Math.sqrt((c.x - p.x) ** 2 + (c.y - p.y) ** 2 + (c.z - p.z) ** 2);
      this.mesh.scale.setScalar(Math.min(3.2, Math.max(1.3, d / 8)));
    }
  }

  /** Time (> t0) when the segment comes down to height y, or Infinity. */
  timeToHeight(y) {
    const a = -0.5 * this.g, b = this.v0.y, c = this.p0.y - y;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const r = (-b - Math.sqrt(disc)) / (2 * a);
    return r > 1e-4 ? this.t0 + r : Infinity;
  }
}

/**
 * Allocation-free trajectory predictor: copies a ball segment and walks it forward through
 * bounces (spin-aware) to give the position at any later time. Used for the swing-timing
 * evaluation, the timing ring and the auto-move assist.
 */
export class BallPredictor {
  constructor() {
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.t0 = 0; this.g = G; this.spin = 'flat';
    this.bounces = 0;
    this.x = 0; this.y = 0; this.z = 0;   // result
    this.bouncedAt = -1;                   // index of bounces passed for the last query
    this._s = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, t0: 0, g: G, b: 0 };
  }

  /** Snapshot a ball's current segment. */
  from(ball) {
    this.px = ball.p0.x; this.py = ball.p0.y; this.pz = ball.p0.z;
    this.vx = ball.v0.x; this.vy = ball.v0.y; this.vz = ball.v0.z;
    this.t0 = ball.t0; this.g = ball.g; this.spin = ball.spin;
    this.bounces = ball.bounced;
    return this;
  }

  /** Position at time t (>= t0), walking up to 3 bounces. Writes x/y/z, returns bounces passed. */
  at(t) {
    const s = this._s;
    s.px = this.px; s.py = this.py; s.pz = this.pz; s.vx = this.vx; s.vy = this.vy; s.vz = this.vz;
    s.t0 = this.t0; s.g = this.g; s.b = 0;
    const sp = SPIN[this.spin] || SPIN.flat;
    for (let k = 0; k < 4; k++) {
      // time this segment lands
      const a = -0.5 * s.g, b = s.vy, c = s.py - BALL_Y;
      const disc = b * b - 4 * a * c;
      const tl = disc >= 0 ? s.t0 + (-b - Math.sqrt(disc)) / (2 * a) : Infinity;
      if (t <= tl || !(tl > s.t0 + 1e-4)) {
        const d = t - s.t0;
        this.x = s.px + s.vx * d; this.y = s.py + s.vy * d - 0.5 * s.g * d * d; this.z = s.pz + s.vz * d;
        if (this.y < BALL_Y) this.y = BALL_Y;
        return s.b;
      }
      const d = tl - s.t0;
      const vyl = s.vy - s.g * d;
      s.px += s.vx * d; s.pz += s.vz * d; s.py = BALL_Y;
      const first = this.bounces + s.b === 0;
      const e = first ? sp.e : 0.72, kh = first ? sp.kh : 0.74;
      s.vx *= kh; s.vz *= kh; s.vy = -vyl * e;
      s.g = G * (first ? sp.g2 : 1);
      s.t0 = tl;
      s.b++;
      if (s.vy < 0.6) { // rolling: stop predicting motion upward
        const d2 = t - s.t0;
        this.x = s.px + s.vx * d2; this.y = BALL_Y; this.z = s.pz + s.vz * d2;
        return s.b;
      }
    }
    this.x = s.px; this.y = BALL_Y; this.z = s.pz;
    return s.b;
  }
}

/**
 * Plan a flight from C to land at (bx, bz) with apex/net clearance control.
 * Writes out = { vx, vy, vz, T, g, hNet, tNet } and returns it.
 *  - pace: horizontal speed wanted (m/s); the flight is never faster than that
 *  - margin: net clearance wanted above the tape (m); may be negative → the ball hits the net
 *  - netU, netF: where the path crosses the net (court-local u) and at which fraction of the path
 *  - minT: lower bound on the flight time (lobs)
 */
export function planFlight(out, cx, cy, cz, bx, bz, pace, g, margin, netF, netU, minT = 0) {
  const D = Math.hypot(bx - cx, bz - cz);
  let T = Math.max(0.18, D / Math.max(3, pace), minT);
  if (netF > 0.02 && netF < 0.98) {
    // h(net) = cy + f (BALL_Y - cy) + 0.5 g T² f (1 - f)  → T for the wanted clearance
    const need = netTop(netU) + R + margin;
    const base = cy + netF * (BALL_Y - cy);
    const k = 0.5 * g * netF * (1 - netF);
    const tNeed = need > base ? Math.sqrt((need - base) / k) : 0;
    if (margin >= 0) T = Math.max(T, tNeed);
    else T = Math.max(D / (Math.max(3, pace) * 1.5), tNeed); // an error: that low (never absurdly fast)
  }
  out.T = T;
  out.g = g;
  out.vx = (bx - cx) / T;
  out.vz = (bz - cz) / T;
  out.vy = (BALL_Y - cy + 0.5 * g * T * T) / T;
  if (netF > 0 && netF < 1) {
    const tn = netF * T;
    out.tNet = tn;
    out.hNet = cy + out.vy * tn - 0.5 * g * tn * tn;
  } else { out.tNet = Infinity; out.hNet = Infinity; }
  return out;
}
