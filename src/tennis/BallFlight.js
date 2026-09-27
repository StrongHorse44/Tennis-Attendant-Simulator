import { G, R, AERO, NET_POST, ROLL_VY, T_MAX, bounceBall, netTopAt, spinVector, SURFACES } from './TennisPhysics.js';

/**
 * BallFlight — a tennis ball's flight, integrated for real: gravity, air drag, Magnus lift of
 * the spin, spin decay and wind (RK4, dt 1/240 s), with every contact on the way solved at its
 * exact moment — the court (the Brody / Cross friction bounce of TennisPhysics.bounceBall), the
 * net (a clean crossing, a net cord that trickles over, or the net stopping it), the back fence
 * or a show court's end boards, and the stands of a sunken court (a dead ball). A flight is
 * computed once, when the ball leaves a racket (or a hand), into a preallocated sample buffer;
 * the ball, the AI, the timing aids and the landing marker all read that same flight
 * (at(t): Hermite interpolation between samples), so what they predict is exactly what happens.
 *
 * Pure JS (no three.js, no DOM): Node can import it (npm run validate runs its self-check).
 *
 * env = { surfY, frame, fence, surface, wind, groundAt, net }
 *   surfY    court surface world y (the ball's centre rests at surfY + R)
 *   frame    court frame { cx, cz, c, s } (+ optional lu / lv methods): u across, v along, net at v = 0
 *   fence    { v, top, halfU, open } back walls at |v| = fence.v (flat courts: top / halfU Infinity)
 *   surface  SURFACES entry (bounce e, mu, grip, keep)
 *   wind     { x, z } m/s (the air's velocity, held for the flight) or null
 *   groundAt (x, z) => ground y, or null: a ball whose bottom meets ground above the court
 *            (a sunken court's stands / the lawn) is a dead ball ('stands')
 *   net      false to leave the net out (default: the net is there when a frame is given)
 *
 * Events (time-ordered, flight.events[0 … nEvents − 1]): { type, t, x, y, z, vx, vy, vz, u, v, h, k }
 *   'bounce'  k = 0, 1, 2 … (vx/vy/vz = the incoming velocity)
 *   'cross'   crossed the net plane clean (h = centre height, u = where)
 *   'netcord' clipped the tape and went on over
 *   'net'     hit the net (it drops on the hitter's side)
 *   'fence'   met the back fence / end boards
 *   'stands'  came down on the stands or the lawn beyond a sunken court (dead, resting there)
 *   'rest'    stopped rolling
 */

const DT = 1 / 240;            // flight step (s)
const DT_PLAN = 1 / 120;       // planner step (s): RK4 at either step lands within a fraction of a millimetre
const MAX_T = 6;               // longest stored flight (s)
const CAP = Math.ceil(MAX_T / DT) + 80;
const ST = 10;                 // floats per sample: t, x, y, z, vx, vy, vz, wx, wy, wz
const MAX_EV = 24;
const MAX_B = 6;
const ROLL_K = 1.6;            // a rolling ball's decay (1/s), as TennisBall.stepRoll
const NET_BAND = 0.6;          // a centre within this × R under the tape still cords (clips it)

const _a = { x: 0, y: 0, z: 0 };
const _s = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _b = { vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
const _h = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

/** Acceleration of a ball with velocity v and spin W in a wind (writes out). */
export function airAccel(vx, vy, vz, wx, wy, wz, windX, windZ, liftOn, out) {
  const rx = vx - windX, ry = vy, rz = vz - windZ;
  const sp2 = rx * rx + ry * ry + rz * rz;
  let ax = 0, ay = -G, az = 0;
  if (sp2 > 1e-10) {
    const sp = Math.sqrt(sp2);
    let S = 0;
    if (liftOn) {
      // Magnus: a = K · (W × v) / (1 + 2S), i.e. K · CL · |v|² along Ŵ × v̂ with CL = S / (1 + 2S)
      const lx = wy * rz - wz * ry, ly = wz * rx - wx * rz, lz = wx * ry - wy * rx;
      S = Math.sqrt(lx * lx + ly * ly + lz * lz) / sp2;   // |W⊥| / |v|
      const k = AERO.K / (1 + 2 * S);
      ax += k * lx; ay += k * ly; az += k * lz;
    }
    const cd = Math.min(AERO.CD_MAX, AERO.CD + AERO.CD_SPIN * S);
    const d = AERO.K * cd * sp;
    ax -= d * rx; ay -= d * ry; az -= d * rz;
  }
  out.x = ax; out.y = ay; out.z = az;
  return out;
}

/** One RK4 step of the state s ({ x, y, z, vx, vy, vz }) with spin W held (the acceleration depends on v only). */
function rk4(s, dt, wx, wy, wz, windX, windZ, liftOn) {
  const vx1 = s.vx, vy1 = s.vy, vz1 = s.vz;
  airAccel(vx1, vy1, vz1, wx, wy, wz, windX, windZ, liftOn, _a);
  const a1x = _a.x, a1y = _a.y, a1z = _a.z;
  const h = dt * 0.5;
  const vx2 = vx1 + a1x * h, vy2 = vy1 + a1y * h, vz2 = vz1 + a1z * h;
  airAccel(vx2, vy2, vz2, wx, wy, wz, windX, windZ, liftOn, _a);
  const a2x = _a.x, a2y = _a.y, a2z = _a.z;
  const vx3 = vx1 + a2x * h, vy3 = vy1 + a2y * h, vz3 = vz1 + a2z * h;
  airAccel(vx3, vy3, vz3, wx, wy, wz, windX, windZ, liftOn, _a);
  const a3x = _a.x, a3y = _a.y, a3z = _a.z;
  const vx4 = vx1 + a3x * dt, vy4 = vy1 + a3y * dt, vz4 = vz1 + a3z * dt;
  airAccel(vx4, vy4, vz4, wx, wy, wz, windX, windZ, liftOn, _a);
  const k = dt / 6;
  s.x += k * (vx1 + 2 * vx2 + 2 * vx3 + vx4);
  s.y += k * (vy1 + 2 * vy2 + 2 * vy3 + vy4);
  s.z += k * (vz1 + 2 * vz2 + 2 * vz3 + vz4);
  s.vx += k * (a1x + 2 * a2x + 2 * a3x + _a.x);
  s.vy += k * (a1y + 2 * a2y + 2 * a3y + _a.y);
  s.vz += k * (a1z + 2 * a2z + 2 * a3z + _a.z);
}

// Cubic Hermite on [0, 1]: value and derivative (per unit s) from end values p and slopes m (= v·Δt)
function herm(p0, m0, p1, m1, s) {
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}
function hermD(p0, m0, p1, m1, s) {
  const s2 = s * s;
  return (6 * s2 - 6 * s) * p0 + (3 * s2 - 4 * s + 1) * m0 + (-6 * s2 + 6 * s) * p1 + (3 * s2 - 2 * s) * m1;
}
/** s ∈ [0, 1] where the Hermite curve reaches `target` (it crosses it inside the interval). */
function hermRoot(p0, m0, p1, m1, target) {
  let s = (p0 - target) / (p0 - p1);
  if (!(s >= 0 && s <= 1)) s = 0.5;
  for (let i = 0; i < 6; i++) {
    const f = herm(p0, m0, p1, m1, s) - target;
    const d = hermD(p0, m0, p1, m1, s);
    if (Math.abs(d) < 1e-9) break;
    const ns = s - f / d;
    s = ns < 0 ? s * 0.5 : ns > 1 ? (s + 1) * 0.5 : ns;
    if (Math.abs(f) < 1e-7) break;
  }
  return s;
}

const lvOf = (fr, x, z) => (x - fr.cx) * fr.s + (z - fr.cz) * fr.c;
const luOf = (fr, x, z) => (x - fr.cx) * fr.c - (z - fr.cz) * fr.s;

export class BallFlight {
  constructor(cap = CAP) {
    this.cap = cap;
    this.s = new Float64Array(cap * ST);
    this.n = 0;
    this.events = [];
    for (let i = 0; i < MAX_EV; i++) this.events.push({ type: '', t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, u: 0, v: 0, h: 0, k: 0 });
    this.nEvents = 0;
    this.nb = 0;                                  // bounces in this flight
    this.bT = new Float64Array(MAX_B);            // bounce times
    this.apexT = new Float64Array(MAX_B);         // peak after bounce k (time, height)
    this.apexY = new Float64Array(MAX_B);
    this.tStart = 0; this.tEnd = 0; this.tRoll = Infinity;
    this.valid = false;
    this.surfY = 0; this.ballY = R;
    this.windX = 0; this.windZ = 0;
  }

  _push(t, x, y, z, vx, vy, vz, wx, wy, wz) {
    if (this.n >= this.cap) return false;
    const o = this.n * ST, s = this.s;
    s[o] = t; s[o + 1] = x; s[o + 2] = y; s[o + 3] = z; s[o + 4] = vx; s[o + 5] = vy; s[o + 6] = vz;
    s[o + 7] = wx; s[o + 8] = wy; s[o + 9] = wz;
    this.n++;
    return true;
  }

  _event(type, t, x, y, z, vx, vy, vz, u, v, h, k) {
    if (this.nEvents >= MAX_EV) return null;
    const e = this.events[this.nEvents++];
    e.type = type; e.t = t; e.x = x; e.y = y; e.z = z; e.vx = vx; e.vy = vy; e.vz = vz; e.u = u; e.v = v; e.h = h; e.k = k;
    return e;
  }

  /**
   * Launch from p with velocity v and spin W (m/s) at time t0 and integrate the whole flight now.
   * opts: { gravityOnly: no lift (tosses; drag still acts), maxBounces: after this many the ball rolls (3) }
   */
  launch(t0, px, py, pz, vx, vy, vz, wx, wy, wz, env, opts = null) {
    const surfY = env.surfY ?? 0;
    const ballY = surfY + R;
    const fr = env.frame || null;
    const fence = env.fence || null;
    const surf = env.surface || SURFACES.hard;
    const wind = env.wind || null;
    const windX = wind ? wind.x || 0 : 0, windZ = wind ? wind.z || 0 : 0;
    const liftOn = !(opts && opts.gravityOnly);
    const maxB = opts && Number.isFinite(opts.maxBounces) ? opts.maxBounces : 3;
    const netOn = !!fr && env.net !== false;
    const groundAt = typeof env.groundAt === 'function' ? env.groundAt : null;
    this.surfY = surfY; this.ballY = ballY; this.windX = windX; this.windZ = windZ;
    this.n = 0; this.nEvents = 0; this.nb = 0; this.tRoll = Infinity;
    for (let k = 0; k < MAX_B; k++) { this.bT[k] = Infinity; this.apexT[k] = Infinity; this.apexY[k] = -Infinity; }
    this.tStart = t0;
    const s = _s;
    s.x = px; s.y = py; s.z = pz; s.vx = vx; s.vy = vy; s.vz = vz;
    let Wx = wx, Wy = wy, Wz = wz;
    let t = t0;
    let rolling = false;
    const tMax = t0 + MAX_T;
    const decay = Math.exp(-AERO.SPIN_DECAY * DT);
    this._push(t, s.x, s.y, s.z, s.vx, s.vy, s.vz, Wx, Wy, Wz);
    let guard = 0;
    while (t < tMax && this.n < this.cap - 3 && guard++ < CAP * 2) {
      if (rolling) {
        // Rolling: the horizontal speed decays, the ball stays on the court (TennisBall.stepRoll)
        const k = Math.exp(-ROLL_K * DT), f = (1 - k) / ROLL_K;
        const nx = s.x + s.vx * f, nz = s.z + s.vz * f;
        let stop = false;
        if (fr && fence) {
          const lv0 = lvOf(fr, s.x, s.z), lv1 = lvOf(fr, nx, nz);
          const lu1 = luOf(fr, nx, nz);
          if (Math.abs(lv0) <= fence.v && Math.abs(lv1) > fence.v && (!fence.open || Math.abs(lu1) < fence.halfU + R)) stop = true;
        }
        if (!stop && groundAt && groundAt(nx, nz) > surfY + 0.02) stop = true;   // the first riser of the stands
        if (stop) {
          t += DT;
          this._push(t, s.x, ballY, s.z, 0, 0, 0, 0, 0, 0);
          this._event('rest', t, s.x, ballY, s.z, 0, 0, 0, fr ? luOf(fr, s.x, s.z) : 0, fr ? lvOf(fr, s.x, s.z) : 0, ballY, -1);
          break;
        }
        s.x = nx; s.z = nz; s.vx *= k; s.vz *= k; s.y = ballY; s.vy = 0;
        t += DT;
        if (s.vx * s.vx + s.vz * s.vz < 0.0025) {
          this._push(t, s.x, ballY, s.z, 0, 0, 0, 0, 0, 0);
          this._event('rest', t, s.x, ballY, s.z, 0, 0, 0, fr ? luOf(fr, s.x, s.z) : 0, fr ? lvOf(fr, s.x, s.z) : 0, ballY, -1);
          break;
        }
        this._push(t, s.x, s.y, s.z, s.vx, 0, s.vz, 0, 0, 0);
        continue;
      }
      // One step in the air
      const x0 = s.x, y0 = s.y, z0 = s.z, vx0 = s.vx, vy0 = s.vy, vz0 = s.vz;
      rk4(s, DT, Wx, Wy, Wz, windX, windZ, liftOn);
      // Events inside the step (fraction of DT): the court, the net plane, the back wall, the stands
      let best = 2, kind = 0;
      if (s.y < ballY && y0 >= ballY - 1e-9 && vy0 <= 0.5) {
        const f = hermRoot(y0, vy0 * DT, s.y, s.vy * DT, ballY);
        if (f < best) { best = f; kind = 1; }
      }
      if (netOn) {
        const L0 = lvOf(fr, x0, z0), L1 = lvOf(fr, s.x, s.z);
        if ((L0 > 0) !== (L1 > 0) && L0 !== 0) {
          const m0 = (vx0 * fr.s + vz0 * fr.c) * DT, m1 = (s.vx * fr.s + s.vz * fr.c) * DT;
          const f = hermRoot(L0, m0, L1, m1, 0);
          if (f < best) { best = f; kind = 2; }
        }
      }
      if (fr && fence) {
        const L0 = lvOf(fr, x0, z0), L1 = lvOf(fr, s.x, s.z);
        if (Math.abs(L0) < fence.v && Math.abs(L1) >= fence.v) {
          const tgt = L1 > 0 ? fence.v : -fence.v;
          const m0 = (vx0 * fr.s + vz0 * fr.c) * DT, m1 = (s.vx * fr.s + s.vz * fr.c) * DT;
          const f = hermRoot(L0, m0, L1, m1, tgt);
          if (f < best) { best = f; kind = 3; }
        }
      }
      if (groundAt && s.y - R < surfY + 3.5) {
        const g1 = groundAt(s.x, s.z);
        if (g1 > surfY + 0.02 && s.y - R < g1 - 0.01) {
          // bisection on the step for where it met the ground above the court
          let lo = 0, hi = 1;
          for (let i = 0; i < 7; i++) {
            const mid = 0.5 * (lo + hi);
            const hx = herm(x0, vx0 * DT, s.x, s.vx * DT, mid), hy = herm(y0, vy0 * DT, s.y, s.vy * DT, mid), hz = herm(z0, vz0 * DT, s.z, s.vz * DT, mid);
            const gm = groundAt(hx, hz);
            if (gm > surfY + 0.02 && hy - R < gm - 0.01) hi = mid; else lo = mid;
          }
          if (hi < best) { best = hi; kind = 4; }
        }
      }
      // Spin decays slowly in the air
      Wx *= decay; Wy *= decay; Wz *= decay;
      if (!kind) {
        t += DT;
        this._push(t, s.x, s.y, s.z, s.vx, s.vy, s.vz, Wx, Wy, Wz);
        continue;
      }
      // The state at the event (Hermite position and velocity), then the contact
      const f = Math.min(1, Math.max(0, best));
      const te = t + f * DT;
      const h = _h;
      h.x = herm(x0, vx0 * DT, s.x, s.vx * DT, f);
      h.y = herm(y0, vy0 * DT, s.y, s.vy * DT, f);
      h.z = herm(z0, vz0 * DT, s.z, s.vz * DT, f);
      h.vx = hermD(x0, vx0 * DT, s.x, s.vx * DT, f) / DT;
      h.vy = hermD(y0, vy0 * DT, s.y, s.vy * DT, f) / DT;
      h.vz = hermD(z0, vz0 * DT, s.z, s.vz * DT, f) / DT;
      const u = fr ? luOf(fr, h.x, h.z) : 0, v = fr ? lvOf(fr, h.x, h.z) : 0;
      if (kind === 1) {
        // The court: the friction bounce
        h.y = ballY;
        this._push(te, h.x, h.y, h.z, h.vx, h.vy, h.vz, Wx, Wy, Wz);
        const k = this.nb;
        this._event('bounce', te, h.x, h.y, h.z, h.vx, h.vy, h.vz, u, v, h.y, k);
        if (k < MAX_B) this.bT[k] = te;
        this.nb++;
        const st = _b;
        st.vx = h.vx; st.vy = h.vy; st.vz = h.vz; st.wx = Wx; st.wy = Wy; st.wz = Wz;
        bounceBall(st, surf);
        s.x = h.x; s.y = ballY; s.z = h.z; s.vx = st.vx; s.vy = st.vy; s.vz = st.vz;
        Wx = st.wx; Wy = st.wy; Wz = st.wz;
        if (st.vy < ROLL_VY || this.nb > maxB) {
          rolling = true; s.vy = 0; this.tRoll = te;
          Wx = Wy = Wz = 0;
        } else if (k < MAX_B) {
          // Its peak (the moment to hit it: the session's ideal contact), from a free probe of the
          // rebound — a wall or the net later in the flight must not hide it
          probeApex(s.x, ballY, s.z, s.vx, s.vy, s.vz, Wx, Wy, Wz, windX, windZ, liftOn);
          this.apexT[k] = te + _apex.t; this.apexY[k] = _apex.y;
        }
      } else if (kind === 2) {
        // The net plane: over it clean, clipping the tape, or into the net
        const top = netTopAt(surfY, u);
        const outside = Math.abs(u) > NET_POST;
        this._push(te, h.x, h.y, h.z, h.vx, h.vy, h.vz, Wx, Wy, Wz);
        s.x = h.x; s.y = h.y; s.z = h.z; s.vx = h.vx; s.vy = h.vy; s.vz = h.vz;
        if (outside || h.y - R >= top) {
          this._event('cross', te, h.x, h.y, h.z, h.vx, h.vy, h.vz, u, 0, h.y, -1);
        } else {
          const f2 = (h.y - (top - NET_BAND * R)) / ((1 + NET_BAND) * R);  // 0 low in the band … 1 just clipped
          const lvel = h.vx * fr.s + h.vz * fr.c, uvel = h.vx * fr.c - h.vz * fr.s;
          const dir = lvel >= 0 ? 1 : -1;
          if (f2 >= 0.4) {
            // Net cord: it pops up off the tape and trickles over, slower, most of its spin scrubbed
            this._event('netcord', te, h.x, h.y, h.z, h.vx, h.vy, h.vz, u, 0, h.y, -1);
            const kv = 0.28 + 0.42 * f2;
            const nl = lvel * kv, nu = uvel * 0.6;
            s.vx = nu * fr.c + nl * fr.s; s.vz = -nu * fr.s + nl * fr.c;
            s.vy = Math.max(0.7, Math.abs(h.vy) * 0.3) + 1.1 * (f2 - 0.4);
            s.y = Math.max(h.y, top + R * 0.2);
            s.x += dir * 0.012 * fr.s; s.z += dir * 0.012 * fr.c;
            Wx *= 0.3; Wy *= 0.3; Wz *= 0.3;
          } else {
            // Into the net: it gives, and the ball drops back on the hitter's side
            this._event('net', te, h.x, h.y, h.z, h.vx, h.vy, h.vz, u, 0, h.y, -1);
            const nl = -lvel * 0.08, nu = uvel * 0.12;
            s.vx = nu * fr.c + nl * fr.s; s.vz = -nu * fr.s + nl * fr.c;
            s.vy = 0.3;
            s.x -= dir * 0.012 * fr.s; s.z -= dir * 0.012 * fr.c;
            s.y = Math.max(h.y, ballY);
            Wx = Wy = Wz = 0;
          }
          this._push(te, s.x, s.y, s.z, s.vx, s.vy, s.vz, Wx, Wy, Wz);
        }
      } else if (kind === 3) {
        // The back wall: a flat court's chain-link stops everything; a show court's end boards
        // only below their top and between their ends (over them it flies on toward the stands)
        this._push(te, h.x, h.y, h.z, h.vx, h.vy, h.vz, Wx, Wy, Wz);
        s.x = h.x; s.y = h.y; s.z = h.z; s.vx = h.vx; s.vy = h.vy; s.vz = h.vz;
        if (h.y - R < fence.top && Math.abs(u) < fence.halfU + R) {
          this._event('fence', te, h.x, h.y, h.z, h.vx, h.vy, h.vz, u, v, h.y, -1);
          const lvel = h.vx * fr.s + h.vz * fr.c, uvel = h.vx * fr.c - h.vz * fr.s;
          const nl = -lvel * 0.25, nu = uvel * 0.4;
          s.vx = nu * fr.c + nl * fr.s; s.vz = -nu * fr.s + nl * fr.c;
          s.vy = Math.min(h.vy, 0.5);
          const back = v > 0 ? -0.01 : 0.01;
          s.x += back * fr.s; s.z += back * fr.c;
          Wx *= 0.3; Wy *= 0.3; Wz *= 0.3;
          this._push(te, s.x, s.y, s.z, s.vx, s.vy, s.vz, Wx, Wy, Wz);
        }
      } else {
        // The stands / the lawn above a sunken court: a dead ball, resting where it came down
        const gy = groundAt(h.x, h.z);
        this._push(te, h.x, h.y, h.z, h.vx, h.vy, h.vz, Wx, Wy, Wz);
        this._event('stands', te, h.x, gy + R, h.z, h.vx, h.vy, h.vz, u, v, gy + R, -1);
        this._push(te + 1e-4, h.x, gy + R, h.z, 0, 0, 0, 0, 0, 0);
        s.x = h.x; s.y = gy + R; s.z = h.z;
        this._event('rest', te + 1e-4, h.x, gy + R, h.z, 0, 0, 0, u, v, gy + R, -1);
        t = te + 1e-4;
        break;
      }
      t = te;
    }
    this.tEnd = this.n ? this.s[(this.n - 1) * ST] : t0;
    this.valid = this.n > 0;
    return this;
  }

  /** Index of the last sample at or before t (binary search). */
  _find(t) {
    const s = this.s;
    let lo = 0, hi = this.n - 1;
    if (t <= s[0]) return 0;
    if (t >= s[hi * ST]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid * ST] <= t) lo = mid; else hi = mid;
    }
    return lo;
  }

  /**
   * State at time t → out { x, y, z, vx, vy, vz, wx, wy, wz, bounces, rolling }. Before the start:
   * the launch state; after the end: the last (resting) state.
   */
  at(t, out) {
    const s = this.s;
    if (!this.n) { out.x = out.y = out.z = out.vx = out.vy = out.vz = out.wx = out.wy = out.wz = 0; out.bounces = 0; out.rolling = false; return out; }
    const i = this._find(t);
    const o = i * ST;
    out.bounces = this.bouncesBefore(t);
    out.rolling = t >= this.tRoll;
    if (i >= this.n - 1 || t <= s[o]) {
      out.x = s[o + 1]; out.y = s[o + 2]; out.z = s[o + 3];
      const end = i >= this.n - 1 && t > s[o];
      out.vx = end ? 0 : s[o + 4]; out.vy = end ? 0 : s[o + 5]; out.vz = end ? 0 : s[o + 6];
      out.wx = s[o + 7]; out.wy = s[o + 8]; out.wz = s[o + 9];
      return out;
    }
    const p = o + ST;
    const dt = s[p] - s[o];
    const f = dt > 1e-9 ? (t - s[o]) / dt : 0;
    out.x = herm(s[o + 1], s[o + 4] * dt, s[p + 1], s[p + 4] * dt, f);
    out.y = herm(s[o + 2], s[o + 5] * dt, s[p + 2], s[p + 5] * dt, f);
    out.z = herm(s[o + 3], s[o + 6] * dt, s[p + 3], s[p + 6] * dt, f);
    if (dt > 1e-9) {
      out.vx = hermD(s[o + 1], s[o + 4] * dt, s[p + 1], s[p + 4] * dt, f) / dt;
      out.vy = hermD(s[o + 2], s[o + 5] * dt, s[p + 2], s[p + 5] * dt, f) / dt;
      out.vz = hermD(s[o + 3], s[o + 6] * dt, s[p + 3], s[p + 6] * dt, f) / dt;
    } else { out.vx = s[p + 4]; out.vy = s[p + 5]; out.vz = s[p + 6]; }
    out.wx = s[o + 7] + (s[p + 7] - s[o + 7]) * f;
    out.wy = s[o + 8] + (s[p + 8] - s[o + 8]) * f;
    out.wz = s[o + 9] + (s[p + 9] - s[o + 9]) * f;
    return out;
  }

  /** Bounces at or before time t. */
  bouncesBefore(t) {
    let n = 0;
    for (let k = 0; k < this.nb && k < MAX_B; k++) if (this.bT[k] <= t) n++;
    return n;
  }

  /** The first bounce event, or null. */
  firstBounce() {
    for (let i = 0; i < this.nEvents; i++) if (this.events[i].type === 'bounce') return this.events[i];
    return null;
  }

  /** The k-th bounce event, or null. */
  bounce(k) {
    for (let i = 0; i < this.nEvents; i++) { const e = this.events[i]; if (e.type === 'bounce' && e.k === k) return e; }
    return null;
  }

  /** The first net-plane event ('cross' | 'netcord' | 'net'), or null. */
  netCross() {
    for (let i = 0; i < this.nEvents; i++) {
      const e = this.events[i];
      if (e.type === 'cross' || e.type === 'netcord' || e.type === 'net') return e;
    }
    return null;
  }

  /** First event of a type, or null. */
  find(type) {
    for (let i = 0; i < this.nEvents; i++) if (this.events[i].type === type) return this.events[i];
    return null;
  }

  /** The peak after bounce k: { t, y } (reused object), or null if it rolled / there is none. */
  apex(k, out = _apexOut) {
    if (k < 0 || k >= MAX_B || !(this.apexT[k] < Infinity)) return null;
    out.t = this.apexT[k]; out.y = this.apexY[k];
    return out;
  }

  /**
   * First time ≥ t0 (up to t1) when the ball's height crosses y going down (descending) or up,
   * searched on the samples and refined; Infinity if it never does.
   */
  crossHeight(y, t0, t1, descending = true) {
    const s = this.s;
    let i = this._find(t0);
    for (; i < this.n - 1; i++) {
      const o = i * ST, p = o + ST;
      if (s[o] > t1) break;
      const y0 = s[o + 2], y1 = s[p + 2];
      const hit = descending ? (y0 >= y && y1 < y) : (y0 <= y && y1 > y);
      if (!hit) continue;
      const dt = s[p] - s[o];
      if (!(dt > 1e-9)) continue;
      const f = hermRoot(y0, s[o + 5] * dt, y1, s[p + 5] * dt, y);
      const tc = s[o] + f * dt;
      if (tc >= t0 && tc <= t1) return tc;
    }
    return Infinity;
  }
}
const _apexOut = { t: 0, y: 0 };

/**
 * A BallPredictor-compatible reader over a ball's current flight (TennisAI, the timing aids):
 * from(ball) keeps a reference (no copy); at(t) writes x / y / z and vxr / vyr / vzr and returns
 * the bounces between from() and t (ball.bounced is the count already behind the ball).
 */
export class FlightReader {
  constructor() {
    this.flight = null;
    this.b0 = 0;
    this.x = 0; this.y = 0; this.z = 0;
    this.vxr = 0; this.vyr = 0; this.vzr = 0;
    this.wx = 0; this.wy = 0; this.wz = 0;
    this.rolling = false;
    this._o = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, bounces: 0, rolling: false };
  }

  from(ball) {
    const f = ball && ball.flight;
    this.flight = f && f.valid ? f : null;
    this.b0 = ball ? ball.bounced || 0 : 0;
    return this;
  }

  at(t) {
    const f = this.flight, o = this._o;
    if (!f) { this.rolling = false; return 0; }
    f.at(t, o);
    this.x = o.x; this.y = o.y; this.z = o.z;
    this.vxr = o.vx; this.vyr = o.vy; this.vzr = o.vz;
    this.wx = o.wx; this.wy = o.wy; this.wz = o.wz;
    this.rolling = o.rolling;
    return o.bounces - this.b0;
  }
}

// ─────────────────────────── the planner ───────────────────────────

const _q = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _apex = { t: 0, y: 0 };
/** Free flight from a rebound until it stops rising: _apex = { t (after the start), y }. */
function probeApex(x, y, z, vx, vy, vz, wx, wy, wz, windX, windZ, liftOn) {
  const q = _q;
  q.x = x; q.y = y; q.z = z; q.vx = vx; q.vy = vy; q.vz = vz;
  _apex.t = 0; _apex.y = y;
  if (!(vy > 0)) return _apex;
  for (let i = 0; i < 480; i++) {
    const y0 = q.y, vy0 = q.vy;
    rk4(q, DT, wx, wy, wz, windX, windZ, liftOn);
    if (q.vy <= 0) {
      const f = Math.min(1, Math.max(0, vy0 / (vy0 - q.vy)));
      _apex.t = (i + f) * DT;
      _apex.y = herm(y0, vy0 * DT, q.y, q.vy * DT, f);
      return _apex;
    }
  }
  _apex.t = 480 * DT; _apex.y = q.y;
  return _apex;
}

const _p = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _net = { t: Infinity, h: 0, u: 0 };
const _w = { x: 0, y: 0, z: 0 };
const _J = new Float64Array(9);

/**
 * Free flight (no contacts) of T seconds from C with v and W: final position in _p; the first
 * crossing of the net plane (lv = 0) in _net (t Infinity when none). Planner step DT_PLAN.
 */
function flyFree(T, cx, cy, cz, vx, vy, vz, wx, wy, wz, windX, windZ, liftOn, fr) {
  const n = Math.max(2, Math.ceil(T / DT_PLAN));
  const dt = T / n;
  const s = _p;
  s.x = cx; s.y = cy; s.z = cz; s.vx = vx; s.vy = vy; s.vz = vz;
  _net.t = Infinity;
  let L0 = fr ? lvOf(fr, cx, cz) : 0;
  const decay = Math.exp(-AERO.SPIN_DECAY * dt);
  for (let i = 0; i < n; i++) {
    const x0 = s.x, y0 = s.y, z0 = s.z, vx0 = s.vx, vy0 = s.vy, vz0 = s.vz;
    rk4(s, dt, wx, wy, wz, windX, windZ, liftOn);
    wx *= decay; wy *= decay; wz *= decay;
    if (fr && _net.t === Infinity) {
      const L1 = lvOf(fr, s.x, s.z);
      if ((L0 > 0) !== (L1 > 0) && L0 !== 0) {
        const f = hermRoot(L0, (vx0 * fr.s + vz0 * fr.c) * dt, L1, (s.vx * fr.s + s.vz * fr.c) * dt, 0);
        _net.t = (i + f) * dt;
        _net.h = herm(y0, vy0 * dt, s.y, s.vy * dt, f);
        _net.u = luOf(fr, herm(x0, vx0 * dt, s.x, s.vx * dt, f), herm(z0, vz0 * dt, s.z, s.vz * dt, f));
      }
      L0 = L1;
    }
  }
  return s;
}

/** Solve the 3×3 system J·d = e (row-major J), writing d into out (x, y, z); false if singular. */
function solve3(J, ex, ey, ez, out) {
  const a = J[0], b = J[1], c = J[2], d = J[3], e = J[4], f = J[5], g = J[6], h = J[7], i = J[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return false;
  const inv = 1 / det;
  out.x = (A * ex + (c * h - b * i) * ey + (b * f - c * e) * ez) * inv;
  out.y = (B * ex + (a * i - c * g) * ey + (c * d - a * f) * ez) * inv;
  out.z = (C * ex + (b * g - a * h) * ey + (a * e - b * d) * ez) * inv;
  return true;
}
const _d = { x: 0, y: 0, z: 0 };

/** Launch velocity (vx, vy, vz) landing at (bx, ballY, bz) after exactly T (Newton, numeric Jacobian). Writes out; returns the miss (m). */
function solveLanding(out, T, cx, cy, cz, bx, ballY, bz, wx, wy, wz, windX, windZ, liftOn, fr) {
  // drag-free start
  let vx = (bx - cx) / T, vz = (bz - cz) / T, vy = (ballY - cy + 0.5 * G * T * T) / T;
  if (Number.isFinite(out.vx) && out._T > 0 && Math.abs(out._T - T) < 0.35 * T && out._ok) { vx = out.vx; vy = out.vy; vz = out.vz; }
  let err = Infinity;
  let haveJ = false;
  for (let it = 0; it < 12; it++) {
    const P = flyFree(T, cx, cy, cz, vx, vy, vz, wx, wy, wz, windX, windZ, liftOn, null);
    const ex = bx - P.x, ey = ballY - P.y, ez = bz - P.z;
    err = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (err < 0.0015) break;
    if (!haveJ || it % 4 === 3) {
      const px = P.x, py = P.y, pz = P.z, dv = 0.04;
      let Q = flyFree(T, cx, cy, cz, vx + dv, vy, vz, wx, wy, wz, windX, windZ, liftOn, null);
      _J[0] = (Q.x - px) / dv; _J[3] = (Q.y - py) / dv; _J[6] = (Q.z - pz) / dv;
      Q = flyFree(T, cx, cy, cz, vx, vy + dv, vz, wx, wy, wz, windX, windZ, liftOn, null);
      _J[1] = (Q.x - px) / dv; _J[4] = (Q.y - py) / dv; _J[7] = (Q.z - pz) / dv;
      Q = flyFree(T, cx, cy, cz, vx, vy, vz + dv, wx, wy, wz, windX, windZ, liftOn, null);
      _J[2] = (Q.x - px) / dv; _J[5] = (Q.y - py) / dv; _J[8] = (Q.z - pz) / dv;
      haveJ = true;
    }
    if (!solve3(_J, ex, ey, ez, _d)) { vx += ex / T; vy += ey / T; vz += ez / T; continue; }
    // (a long step is damped: the problem is smooth but not linear)
    const step = Math.sqrt(_d.x * _d.x + _d.y * _d.y + _d.z * _d.z);
    const k = step > 12 ? 12 / step : 1;
    vx += _d.x * k; vy += _d.y * k; vz += _d.z * k;
  }
  out.vx = vx; out.vy = vy; out.vz = vz;
  return err;
}

/**
 * Plan a shot: the launch velocity from C that lands at B (ball centre at surfY + R) with the
 * spin `profile` (hitter frame, turned along C → B). Speed: `speed` = launch speed (m/s, the
 * racket's doing), or `pace` = average horizontal speed C → B; either way it flies higher (and
 * slower) when it has to, to clear the net by `margin` (m above the tape; < 0 = into the tape) or
 * to stay up at least `minT` (lobs). The flight is the one BallFlight.launch integrates.
 * Writes out = { vx, vy, vz, wx, wy, wz, T, netH, netU, clear, miss, ok } and returns it.
 */
export function planShot(out, C, B, profile, opts, env) {
  const surfY = env.surfY ?? 0, ballY = surfY + R;
  const fr = env.frame || null;
  const wind = env.wind || null;
  const windX = wind ? wind.x || 0 : 0, windZ = wind ? wind.z || 0 : 0;
  const liftOn = !(opts && opts.gravityOnly);
  const dx = B.x - C.x, dz = B.z - C.z;
  const D = Math.max(0.01, Math.sqrt(dx * dx + dz * dz));
  const ux = dx / D, uz = dz / D;
  const W = spinVector(profile ? profile.top : 0, profile ? profile.side : 0, profile ? profile.gyro : 0, ux, uz, _w);
  const wx = W.x, wy = W.y, wz = W.z;
  const pace = Math.max(3, opts && opts.pace ? opts.pace : 12);
  const margin = opts && Number.isFinite(opts.margin) ? opts.margin : 0.3;
  const minT = opts && opts.minT ? opts.minT : 0;
  const maxT = Math.min(T_MAX, opts && opts.maxT ? opts.maxT : T_MAX);
  const crosses = !!fr && (lvOf(fr, C.x, C.z) > 0) !== (lvOf(fr, B.x, B.z) > 0);
  out._T = 0; out._ok = false;
  out.vx = NaN;
  let Tfast = D / pace;
  const speed = opts && opts.speed > 0 ? opts.speed : 0;
  if (speed) {
    // The flight time whose launch speed is `speed` (the direct, low trajectory): |v0| ∝ ~1/T
    let Ts = Math.min(maxT, Math.max(0.16, D / (0.82 * speed)));
    for (let i = 0; i < 8; i++) {
      solveLanding(out, Ts, C.x, C.y, C.z, B.x, ballY, B.z, wx, wy, wz, windX, windZ, liftOn, null);
      out._T = Ts; out._ok = true;
      const sp = Math.sqrt(out.vx * out.vx + out.vy * out.vy + out.vz * out.vz);
      if (Math.abs(sp - speed) < 0.04) break;
      Ts = Math.min(maxT, Math.max(0.16, Ts * Math.pow(sp / speed, 1.1)));
    }
    Tfast = Ts;
  }
  const Tpace = Math.min(maxT, Math.max(0.16, Tfast, minT));
  let T = Tpace;
  let miss = Infinity, clear = Infinity, netH = Infinity, netU = 0;
  let Tlo = -1, clo = 0, Thi = -1, chi = 0;          // bracket of the clearance root
  for (let outer = 0; outer < 8; outer++) {
    miss = solveLanding(out, T, C.x, C.y, C.z, B.x, ballY, B.z, wx, wy, wz, windX, windZ, liftOn, fr);
    out._T = T; out._ok = miss < 0.05;
    if (!crosses) { clear = Infinity; netH = Infinity; break; }
    flyFree(T, C.x, C.y, C.z, out.vx, out.vy, out.vz, wx, wy, wz, windX, windZ, liftOn, fr);
    if (_net.t === Infinity) { clear = Infinity; netH = Infinity; break; }
    netH = _net.h; netU = _net.u;
    clear = netH - R - netTopAt(surfY, netU);
    const want = margin;
    const diff = clear - want;
    if (Math.abs(diff) < 0.006) break;
    if (diff > 0 && T <= Tpace + 1e-6 && margin >= 0) break;     // clears by more than asked at full pace: fine
    if (diff < 0) { Tlo = T; clo = diff; } else { Thi = T; chi = diff; }
    let Tn;
    if (Tlo > 0 && Thi > 0) Tn = Tlo + (Thi - Tlo) * (-clo) / (chi - clo);   // secant inside the bracket
    else {
      // parabola estimate: extra height at the net for a longer flight ≈ ½·g·f·(1−f)·(T'² − T²)
      const f = Math.min(0.9, Math.max(0.1, _net.t / T));
      const t2 = T * T - 2 * diff / (G * f * (1 - f));
      Tn = Math.sqrt(Math.max(0.0256, t2));
    }
    const lo = margin >= 0 ? Tpace : Math.max(0.16, Tfast / 1.7);
    Tn = Math.min(maxT, Math.max(lo, Tn));
    if (Math.abs(Tn - T) < 1e-4) break;
    T = Tn;
  }
  out.wx = wx; out.wy = wy; out.wz = wz;
  out.T = T; out.netH = netH; out.netU = netU; out.clear = clear; out.miss = miss;
  out.ok = miss < 0.05 && (!crosses || clear >= margin - 0.03);
  return out;
}

/**
 * Self-check (npm run validate): the planner lands where it plans through the real integrator,
 * a topspin drive dips, drag slows the ball, the net and a bounce are found. Returns [] or errors.
 */
export function flightSelfCheck() {
  const errs = [];
  const fr = { cx: 0, cz: 0, c: 1, s: 0 };
  const env = { surfY: 0.15, frame: fr, fence: { v: 14.25, top: Infinity, halfU: Infinity, open: false }, surface: SURFACES.hard, wind: null, groundAt: null };
  const f = new BallFlight();
  const out = {};
  const cases = [
    { C: { x: 1, y: 1.0, z: 12.6 }, B: { x: -2.5, z: -9.5 }, prof: { top: 8, side: 0, gyro: 0 }, pace: 15, margin: 0.7 },
    { C: { x: -2, y: 0.9, z: 12.4 }, B: { x: 3, z: -10.5 }, prof: { top: -7, side: 3.2, gyro: -1.2 }, pace: 13, margin: 0.3 },
    { C: { x: 0.9, y: 2.5, z: 12.6 }, B: { x: -2.3, z: -5.8 }, prof: { top: 2.5, side: 1.2, gyro: 0.3 }, pace: 19, margin: 0.12 },
    { C: { x: 0, y: 0.8, z: 12.8 }, B: { x: 1, z: -10.6 }, prof: { top: 3.5, side: 0, gyro: 0 }, pace: 9, margin: 2.8, minT: 1.6 },
  ];
  for (const k of cases) {
    planShot(out, k.C, k.B, k.prof, { pace: k.pace, margin: k.margin, minT: k.minT || 0 }, env);
    if (!out.ok) errs.push(`planShot failed (miss ${out.miss.toFixed(3)}, clear ${out.clear.toFixed(2)}) for ${JSON.stringify(k.B)}`);
    f.launch(0, k.C.x, k.C.y, k.C.z, out.vx, out.vy, out.vz, out.wx, out.wy, out.wz, env);
    const b = f.firstBounce();
    if (!b) { errs.push('no bounce'); continue; }
    const d = Math.hypot(b.x - k.B.x, b.z - k.B.z);
    if (d > 0.03) errs.push(`landing off the plan by ${d.toFixed(3)} m`);
    const nc = f.netCross();
    if (!nc || nc.type !== 'cross') errs.push(`expected a clean net crossing, got ${nc && nc.type}`);
    const sp0 = Math.hypot(out.vx, out.vy, out.vz), sp1 = Math.hypot(b.vx, b.vy, b.vz);
    if (!(sp1 < sp0)) errs.push('drag did not slow the ball');
  }
  // A ball hit into the tape low stops in the net
  f.launch(0, 0, 0.6, 10, 0, 0.5, -20, 0, 0, 0, env);
  const nc = f.netCross();
  if (!nc || nc.type !== 'net') errs.push(`a low ball should hit the net (${nc && nc.type})`);
  return errs;
}
