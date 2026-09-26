import * as THREE from 'three';
import { SIZES } from '../utils/Constants.js';
import { TennisBall, BALL_RADIUS, GRAVITY } from '../entities/TennisBall.js';
import { CameraTracker } from '../entities/CharacterModel.js';
import { mat } from '../graphics/Materials.js';
import { createCanvasTexture } from '../graphics/Textures.js';

/**
 * TennisBallSim — the after-hours ball physics. A flight is a chain of analytic segments on the
 * session clock: each segment starts at (p0, v0, t0) and carries a constant acceleration `a`
 * (gravity + spin lift + air drag + wind, evaluated at launch), so every bounce, net crossing
 * and racket contact is an exact time the session plans ahead and the AI reads.
 *
 * Spin is a world vector W = ω·r (m/s at the ball's surface), built per shot from three parts
 * (hitter's view, right-handed players):
 *  - top  (+ topspin / − backspin): axis to the left of travel. Lift W × v pushes a topspin
 *    ball down (it dips, then kicks up and on), a slice up (it floats, then stays low).
 *  - side (+ curves to the hitter's left): vertical axis — the in-flight curve of a slice
 *    serve (wide on the deuce side), a backhand slice (left) or a forehand slice (right).
 *  - gyro (+ kicks to the hitter's right after the bounce): axis along the travel — no lift in
 *    the air, but the court grabs it: the kick serve jumps right, the slice serve skids left.
 * Lift uses a saturating coefficient C_L = S / (1 + 2S) of the spin parameter S = |W × v̂| / |v|,
 * drag slows the ball over its flight (it leaves faster than it arrives), wind pushes it.
 *
 * Bounces (bounceBall) are the Brody / Cross friction model on the playing surface (SURFACES):
 * the contact point slides (friction μ·N) or grips and rolls (a bit beyond rolling on biting
 * clay), so topspin keeps its pace and gains spin, a slice checks up (clay) or skids through
 * low and fast (grass), and gyro spin kicks sideways. The ball and BallPredictor share the same
 * functions, so the AI and the timing ring read exactly the flight that will happen.
 *
 * Also exports the court constants shared by the tennis modules.
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
export const ROLL_VY = 0.8;              // a rebound slower than this (m/s up) rolls

// Air: ½·ρ·A / m of a tennis ball (1/m) — lift and drag per unit mass per (m/s)². CD is below
// the real ~0.55 because each segment keeps its launch drag for the whole flight; WIND_K scales
// the wind's push for gameplay (lobs drift a metre or two in a stiff breeze).
export const AIR_K = 0.036;
export const CD = 0.3;
export const WIND_K = 1.6;

/**
 * Playing surfaces. Bounce: e = vertical restitution, mu = sliding friction, grip = how far the
 * contact point is brought to rolling (0.4 = exactly rolling for a hollow ball; more = bites),
 * keep = horizontal speed kept by the surface itself (loose clay). Movement (player): accel /
 * stop scale the acceleration and braking, slide = clay slides into wide balls.
 */
export const SURFACES = {
  hard: {
    key: 'hard', label: 'Hard', pace: 'Medium-fast',
    e: 0.76, mu: 0.5, grip: 0.42, keep: 1,
    move: { accel: 1, stop: 1, slide: 0 },
  },
  clay: {
    key: 'clay', label: 'Clay', pace: 'Slow, high bounce',
    e: 0.83, mu: 0.72, grip: 0.5, keep: 0.94,
    move: { accel: 0.9, stop: 0.62, slide: 1 },
  },
  grass: {
    key: 'grass', label: 'Grass', pace: 'Fast, low bounce',
    e: 0.66, mu: 0.34, grip: 0.34, keep: 1,
    move: { accel: 0.9, stop: 0.85, slide: 0 },
  },
};

/**
 * Spin profile per shot type at a nominal swing (hitter's frame, right-handed): top / side /
 * gyro in m/s (see the header). The session scales them with power, the spin stat and the
 * stroke (a slice from the forehand side mirrors side / gyro); `label` is what the HUD / coach
 * call it.
 */
export const SPIN = {
  flat: { top: 2, side: 0.3, gyro: 0 },
  topspin: { top: 8, side: 0, gyro: 0 },
  slice: { top: -7, side: 3.2, gyro: -1.2 },     // backhand slice: floats, curves left, skids low
  lob: { top: 3.5, side: 0, gyro: 0 },
  drop: { top: -8.5, side: 1.4, gyro: -0.5 },    // heavy backspin: floats, then dies
  smash: { top: 2.5, side: 0.5, gyro: 0 },
  serve: { top: 2.5, side: 1.2, gyro: 0.3 },     // flat first serve (a touch of natural slice)
  kick: { top: 9, side: 1.5, gyro: 6 },          // dips hard, jumps up and to the right
  slicesrv: { top: 1.5, side: 7, gyro: -1.2 },   // curves left (wide on the deuce side), skids low
  feed: { top: 4, side: 0, gyro: 0 },
  dead: { top: 0, side: 0, gyro: 0 },
};

/** Height of the net tape at court-local u (sags to the middle). */
export function netTop(u) {
  const k = Math.min(1, Math.abs(u) / NET_POST);
  return SURF + NET_H0 + (NET_H1 - NET_H0) * k * k;
}

/**
 * Acceleration of a ball with velocity v and spin W (world, m/s) in `wind` ({ x, z } m/s or
 * null): gravity + lift (W × v_h, saturating) + drag (horizontal) + wind. Writes out.x/y/z.
 */
export function airAccel(vx, vy, vz, wx, wy, wz, wind, out) {
  const hs = Math.sqrt(vx * vx + vz * vz);
  const sp = Math.sqrt(hs * hs + vy * vy);
  // Lift from the horizontal velocity only (a constant vertical term would push a rising
  // launch forward for the whole flight): W × (vx, 0, vz)
  const lx = wy * vz, ly = wz * vx - wx * vz, lz = -wy * vx;
  const lm = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const S = lm / (Math.max(hs, 1) * Math.max(sp, 1));
  const k = AIR_K / (1 + 2 * S);
  const d = AIR_K * CD * sp;
  const wk = wind ? d * WIND_K : 0;
  out.x = k * lx - d * vx + (wind ? wk * wind.x : 0);
  out.y = -G + k * ly;
  out.z = k * lz - d * vz + (wind ? wk * wind.z : 0);
  return out;
}

/**
 * World spin vector from a hitter-frame profile { top, side, gyro } for travel along the
 * horizontal unit vector (ux, uz). Writes out.x/y/z.
 */
export function spinVector(top, side, gyro, ux, uz, out) {
  out.x = top * uz + gyro * ux;
  out.y = side;
  out.z = -top * ux + gyro * uz;
  return out;
}

/**
 * One bounce on surface `surf`: st = { vx, vy, vz, wx, wy, wz } (vy < 0 coming in) becomes
 * the rebound. The contact point's slip (v_h − W × ŷ) is removed toward rolling by the grip,
 * limited by friction μ·N; the same impulse changes the spin (hollow ball, I = ⅔·m·r²).
 */
export function bounceBall(st, surf) {
  const S = surf || SURFACES.hard;
  const vin = Math.max(0, -st.vy);
  // Backspin about the incoming direction's left axis keeps the bounce low (a slice / drop
  // shot stays down); harder impacts bounce relatively lower
  const hs = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
  const back = hs > 0.5 ? Math.max(0, -(st.wx * st.vz - st.wz * st.vx) / hs) : 0;
  const e = S.e * Math.min(1.04, Math.max(0.9, 1 - 0.012 * (vin - 5))) * (1 - 0.028 * Math.min(9, back));
  const N = (1 + e) * vin;
  const cx = st.vx + st.wz, cz = st.vz - st.wx;   // contact-point slip
  let jx = -S.grip * cx, jz = -S.grip * cz;
  const jm = Math.sqrt(jx * jx + jz * jz), cap = S.mu * N;
  if (jm > cap && jm > 1e-6) { const k = cap / jm; jx *= k; jz *= k; }
  st.vx = (st.vx + jx) * S.keep;
  st.vz = (st.vz + jz) * S.keep;
  st.vy = e * vin;
  // ΔW = (J × ŷ) / α, α = ⅔: J × ŷ = (−jz, 0, jx)
  st.wx -= 1.5 * jz;
  st.wz += 1.5 * jx;
  st.wy *= 0.8;                                    // the court scrubs some vertical-axis spin
  return st;
}

/**
 * Smallest time in (0, tMax] when the court-local v of a segment reaches `target` (frame from
 * TennisSession: lv(x, z) = (x − cx)·s + (z − cz)·c), or Infinity.
 */
export function crossTime(frame, px, pz, vx, vz, ax, az, target, tMax) {
  const L0 = frame.lv(px, pz) - target;
  const Lv = vx * frame.s + vz * frame.c;
  const La = ax * frame.s + az * frame.c;
  let t = Infinity;
  if (Math.abs(La) < 1e-6) {
    if (Math.abs(Lv) > 1e-6) { const r = -L0 / Lv; if (r > 1e-5) t = r; }
  } else {
    const disc = Lv * Lv - 2 * La * L0;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const r1 = (-Lv - sq) / La, r2 = (-Lv + sq) / La;
      const lo = Math.min(r1, r2), hi = Math.max(r1, r2);
      t = lo > 1e-5 ? lo : hi > 1e-5 ? hi : Infinity;
    }
  }
  return t <= tMax ? t : Infinity;
}

/** Landing time offset (> 0) of a segment from height py with vy, ay down to y, or Infinity. */
function landIn(py, vy, ay, y) {
  const a = 0.5 * ay, b = vy, c = py - y;
  if (Math.abs(a) < 1e-6) return b < -1e-6 ? -c / b : Infinity;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const r1 = (-b - sq) / (2 * a), r2 = (-b + sq) / (2 * a);
  const r = Math.max(r1, r2);   // the later root: coming down
  return r > 1e-4 ? r : Infinity;
}

let _seamTex = null;
function seamTexture() {
  if (_seamTex) return _seamTex;
  // Felt yellow-green with the white seam: one period of the classic curve, equirectangular
  _seamTex = createCanvasTexture(128, (ctx, w, rand, h) => {
    ctx.fillStyle = '#d4e157';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(255,255,220,0.18)' : 'rgba(120,140,20,0.16)';
      ctx.fillRect(rand() * w, rand() * h, 2, 2);
    }
    ctx.strokeStyle = '#f7f7ea';
    ctx.lineWidth = Math.max(2, h * 0.07);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const y = h * (0.5 + 0.3 * Math.sin((x / w) * Math.PI * 4));
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, { key: 'tennisBallSeam', height: 64 });
  return _seamTex;
}

const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const SPIN_VIS = 0.045;   // on-screen spin rate (× real): readable direction, no strobing

export class TennisBallSim extends TennisBall {
  constructor(scene) {
    super(scene);
    this.mesh.name = 'AfterHoursBall';
    try {
      this.mesh.material = mat(0xffffff, { map: seamTexture(), roughness: 1, emissive: 0x5d6b0c, emissiveIntensity: 0.3 });
    } catch (e) { /* keep the plain ball */ }
    this.a = new THREE.Vector3(0, -G, 0);   // acceleration of the current segment
    this.w = new THREE.Vector3();           // spin ω·r (m/s, world)
    this.spin = 'flat';                     // shot label of the current flight (HUD / coach / FX)
    this.bounced = 0;                       // bounces since the last racket contact
    this.groundY = SURF;
    this.surface = SURFACES.hard;
    this.wind = null;                       // { x, z } m/s, or null (calm)
  }

  /** Downward acceleration of the current segment (legacy readers). */
  get g() { return -this.a.y; }

  /** Gravity-only segment (tosses, feeds, dead balls): no spin, no drag. */
  launchG(t, px, py, pz, vx, vy, vz, g = G) {
    this.a.set(0, -g, 0);
    this.w.set(0, 0, 0);
    this.launch(t, px, py, pz, vx, vy, vz);
  }

  /** Segment with spin W: the acceleration comes from gravity, lift, drag and the wind. */
  launchSpin(t, px, py, pz, vx, vy, vz, wx, wy, wz) {
    this.w.set(wx, wy, wz);
    airAccel(vx, vy, vz, wx, wy, wz, this.wind, this.a);
    this.launch(t, px, py, pz, vx, vy, vz);
  }

  /** Re-aim from p with a new velocity, keeping the current acceleration and spin. */
  launchKeep(t, px, py, pz, vx, vy, vz) {
    this.launch(t, px, py, pz, vx, vy, vz);
  }

  at(t) {
    const d = t - this.t0, a = this.a;
    this.pos.set(
      this.p0.x + this.v0.x * d + 0.5 * a.x * d * d,
      this.p0.y + this.v0.y * d + 0.5 * a.y * d * d,
      this.p0.z + this.v0.z * d + 0.5 * a.z * d * d,
    );
    return this.pos;
  }

  /** Velocity at time t on the current segment (writes out). */
  velAt(t, out) {
    if (this.rolling) { out.set(this.v0.x, 0, this.v0.z); return out; }
    const d = t - this.t0, a = this.a;
    out.set(this.v0.x + a.x * d, this.v0.y + a.y * d, this.v0.z + a.z * d);
    return out;
  }

  vyAt(t) { return this.v0.y + this.a.y * (t - this.t0); }

  /** Time (> t0) when the segment comes down to height y, or Infinity. */
  timeToHeight(y) {
    const r = landIn(this.p0.y, this.v0.y, this.a.y, y);
    return r === Infinity ? Infinity : this.t0 + r;
  }

  /** Visual spin: turn the ball about its spin axis (slowed down so the direction reads). */
  turn(dt) {
    const w = this.w, m = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    if (m < 0.2 || !this.shown) return;
    _ax.set(w.x / m, w.y / m, w.z / m);
    _q.setFromAxisAngle(_ax, (m / R) * SPIN_VIS * dt);
    this.mesh.quaternion.premultiply(_q);
  }

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
}

/**
 * Allocation-free trajectory predictor: copies a ball segment and walks it forward through
 * bounces (the same bounceBall / airAccel as the ball) to give the position at any later
 * time. Used for the swing-timing evaluation, the timing ring, the auto-move assist and the AI.
 */
export class BallPredictor {
  constructor() {
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.ax = 0; this.ay = -G; this.az = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;
    this.t0 = 0; this.spin = 'flat';
    this.bounces = 0;
    this.rolling = false;
    this.surf = SURFACES.hard;
    this.wind = null;
    this.x = 0; this.y = 0; this.z = 0;    // result
    this.vxr = 0; this.vyr = 0; this.vzr = 0; // velocity at the queried time (result)
    this._s = { px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: -G, az: 0, wx: 0, wy: 0, wz: 0, t0: 0 };
    this._a = { x: 0, y: 0, z: 0 };
  }

  /** Snapshot a ball's current segment. */
  from(ball) {
    this.px = ball.p0.x; this.py = ball.p0.y; this.pz = ball.p0.z;
    this.vx = ball.v0.x; this.vy = ball.v0.y; this.vz = ball.v0.z;
    const a = ball.a, w = ball.w;
    if (a) { this.ax = a.x; this.ay = a.y; this.az = a.z; } else { this.ax = 0; this.ay = -G; this.az = 0; }
    if (w) { this.wx = w.x; this.wy = w.y; this.wz = w.z; } else { this.wx = this.wy = this.wz = 0; }
    this.t0 = ball.t0; this.spin = ball.spin;
    this.bounces = ball.bounced;
    this.rolling = !!ball.rolling;
    this.surf = ball.surface || SURFACES.hard;
    this.wind = ball.wind || null;
    return this;
  }

  /** Position (x/y/z) and velocity (vxr/vyr/vzr) at time t (>= t0), walking up to 3 bounces. Returns bounces passed. */
  at(t) {
    const s = this._s;
    s.px = this.px; s.py = this.py; s.pz = this.pz; s.vx = this.vx; s.vy = this.vy; s.vz = this.vz;
    s.ax = this.ax; s.ay = this.ay; s.az = this.az; s.wx = this.wx; s.wy = this.wy; s.wz = this.wz;
    s.t0 = this.t0;
    let nb = 0;
    if (this.rolling) return this._roll(t, nb);
    for (let k = 0; k < 4; k++) {
      const dl = landIn(s.py, s.vy, s.ay, BALL_Y);
      const tl = s.t0 + dl;
      if (t <= tl || dl === Infinity) {
        const d = t - s.t0;
        this.x = s.px + s.vx * d + 0.5 * s.ax * d * d;
        this.y = s.py + s.vy * d + 0.5 * s.ay * d * d;
        this.z = s.pz + s.vz * d + 0.5 * s.az * d * d;
        this.vxr = s.vx + s.ax * d; this.vyr = s.vy + s.ay * d; this.vzr = s.vz + s.az * d;
        if (this.y < BALL_Y) this.y = BALL_Y;
        return nb;
      }
      // to the bounce, then the rebound
      s.px += s.vx * dl + 0.5 * s.ax * dl * dl;
      s.pz += s.vz * dl + 0.5 * s.az * dl * dl;
      s.py = BALL_Y;
      s.vx += s.ax * dl; s.vy += s.ay * dl; s.vz += s.az * dl;
      bounceBall(s, this.surf);
      airAccel(s.vx, s.vy, s.vz, s.wx, s.wy, s.wz, this.wind, this._a);
      s.ax = this._a.x; s.ay = this._a.y; s.az = this._a.z;
      s.t0 = tl;
      nb++;
      if (s.vy < ROLL_VY) return this._roll(t, nb);
    }
    this.x = s.px; this.y = BALL_Y; this.z = s.pz;
    this.vxr = this.vyr = this.vzr = 0;
    return nb;
  }

  /** Rolling from the scratch state (TennisBall.stepRoll decay, integrated exactly). */
  _roll(t, nb) {
    const s = this._s, d = Math.max(0, t - s.t0);
    const k = Math.exp(-1.6 * d), f = (1 - k) / 1.6;
    this.x = s.px + s.vx * f; this.y = BALL_Y; this.z = s.pz + s.vz * f;
    this.vxr = s.vx * k; this.vyr = 0; this.vzr = s.vz * k;
    return nb;
  }
}

/**
 * Plan a flight from C to land at (bx, bz) with spin, pace and net clearance.
 * Writes out = { vx, vy, vz, ax, ay, az, wx, wy, wz, T, tNet, hNet, netU } and returns it.
 *  - pace: average horizontal speed wanted (m/s); the flight is never faster than that
 *  - spin: hitter-frame profile { top, side, gyro } (m/s), turned into a world vector W along C→B
 *  - margin: net clearance wanted above the tape (m); negative = a shot into the net
 *  - minT: lower bound on the flight time (lobs)
 *  - frame: the court frame (net line lv = 0); wind: { x, z } m/s the hitter allows for, or null
 * The acceleration depends on the launch velocity (lift, drag), so the solve iterates; the
 * sidespin curve, drag and wind are all inside the solution (the ball lands on B).
 */
export function planFlight(out, cx, cy, cz, bx, bz, pace, spin, margin, minT, frame, wind) {
  const dx = bx - cx, dz = bz - cz;
  const D = Math.max(0.01, Math.sqrt(dx * dx + dz * dz));
  const ux = dx / D, uz = dz / D;
  const W = spinVector(spin ? spin.top : 0, spin ? spin.side : 0, spin ? spin.gyro : 0, ux, uz, _w);
  out.wx = W.x; out.wy = W.y; out.wz = W.z;
  const P = Math.max(3, pace);
  const T0 = Math.max(0.18, D / P, minT || 0);
  let T = T0;
  const L0 = frame ? frame.lv(cx, cz) : 0, L1 = frame ? frame.lv(bx, bz) : 0;
  const crosses = !!frame && (L0 > 0) !== (L1 > 0) && Math.abs(L1 - L0) > 1e-3;
  const A = _acc; A.x = 0; A.y = -G; A.z = 0;
  let vx = 0, vy = 0, vz = 0;
  for (let it = 0; it < 7; it++) {
    vx = (dx - 0.5 * A.x * T * T) / T;
    vy = (BALL_Y - cy - 0.5 * A.y * T * T) / T;
    vz = (dz - 0.5 * A.z * T * T) / T;
    airAccel(vx, vy, vz, W.x, W.y, W.z, wind, A);
    if (!crosses) continue;
    vx = (dx - 0.5 * A.x * T * T) / T;
    vz = (dz - 0.5 * A.z * T * T) / T;
    const tn = crossTime(frame, cx, cz, vx, vz, A.x, A.z, 0, T);
    if (tn === Infinity) continue;
    const f = tn / T, g = -A.y;
    const nu = frame.lu(cx + vx * tn + 0.5 * A.x * tn * tn, cz + vz * tn + 0.5 * A.z * tn * tn);
    const need = netTop(nu) + R + margin;
    const base = cy + f * (BALL_Y - cy);
    const k = 0.5 * g * f * (1 - f);
    const tNeed = need > base && k > 1e-4 ? Math.sqrt((need - base) / k) : 0;
    const Tn = margin >= 0 ? Math.max(T0, tNeed) : Math.max(D / (P * 1.5), tNeed);
    T = it < 3 ? Tn : 0.5 * (T + Tn);     // (damped once it is close)
  }
  vx = (dx - 0.5 * A.x * T * T) / T;
  vy = (BALL_Y - cy - 0.5 * A.y * T * T) / T;
  vz = (dz - 0.5 * A.z * T * T) / T;
  out.vx = vx; out.vy = vy; out.vz = vz;
  out.ax = A.x; out.ay = A.y; out.az = A.z;
  out.T = T;
  out.tNet = Infinity; out.hNet = Infinity; out.netU = 0;
  if (crosses) {
    const tn = crossTime(frame, cx, cz, vx, vz, A.x, A.z, 0, T);
    if (tn !== Infinity) {
      out.tNet = tn;
      out.hNet = cy + vy * tn + 0.5 * A.y * tn * tn;
      out.netU = frame.lu(cx + vx * tn + 0.5 * A.x * tn * tn, cz + vz * tn + 0.5 * A.z * tn * tn);
    }
  }
  return out;
}
const _w = { x: 0, y: 0, z: 0 };
const _acc = { x: 0, y: 0, z: 0 };
