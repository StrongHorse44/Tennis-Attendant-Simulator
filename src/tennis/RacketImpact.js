/**
 * RacketImpact — what happens when the strings meet the ball (the Cross / Brody model).
 *
 * The racket is a body with an effective mass at the impact point: at the sweet spot it acts
 * like ~0.2 kg (apparent restitution e_A ≈ 0.47: the ball leaves at e_A·v_in + (1 + e_A)·V along
 * the face normal), toward the tip or the throat less, and an impact off the long axis twists the
 * head (the face turns toward that edge and the effective mass drops sharply — a frame shot).
 * Along the face the strings grip: the contact point's slip is taken toward rolling (a hollow
 * ball: 40 % of it, capped by the string friction), and that same impulse spins the ball — a
 * racket rising across the back of the ball gives topspin, one falling under it backspin, and
 * the incoming ball's own spin goes through the physics (a heavy topspin ball comes back as
 * backspin unless you brush up through it; pace on pace is the normal restitution).
 *
 * Every stroke is made in two steps:
 *  1. impactInverse: the racket velocity V and face normal n that send the ball out with the
 *     planned velocity and (as close as the stroke allows) the planned spin — the intention;
 *  2. execution: n turned by the timing error (strokeErrors / serveErrors: nothing inside the
 *     green window), V scaled, the real string contact (a, b) → impactForward gives what really
 *     comes off the strings.
 * Pure JS (no three.js / DOM): the session, the AI, the member matches and Node use it.
 *
 * Vectors are plain { x, y, z } objects; nothing here allocates per call (results go into the
 * `out` / `sol` objects the caller passes, scratch is module-level).
 */

export const IMPACT = {
  M_BALL: 0.057,        // kg
  E_STRINGS: 0.85,      // ball–string-bed restitution against a fixed racket
  M_SWEET: 0.205,       // effective racket mass at the sweet spot (kg) → e_A ≈ 0.47
  M_TIP: 0.1,           // … at the tip edge (a = +1)
  M_THROAT: 0.26,       // … at the throat (a = −1)
  HALF_W: 0.125,        // half width of the head (m) at b = ±1
  I_ROLL: 0.0016,       // moment of inertia about the long axis (kg·m²): off-axis impacts twist
  GRIP: 0.4,            // share of the contact slip the strings take out (rolling for a hollow ball)
  MU: 0.42,             // string–ball friction
  ALPHA: 2 / 3,         // hollow ball: I = α·m·r²
  TWIST_K: 0.0045,      // face twist (rad) per unit b per m/s of normal impact speed
  V_MAX: 44,            // fastest racket head speed (m/s)
  BRUSH_MAX: 1.3,       // tangential / normal racket speed (a ~52° brush)
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Effective racket mass (kg) at string-bed position a (−1 throat … +1 tip), b (−1 … +1 across). */
export function effectiveMass(a, b) {
  const aa = clamp(a, -1.5, 1.5), bb = clamp(b, -1.5, 1.5) * IMPACT.HALF_W;
  const M = Math.max(0.05, aa >= 0
    ? IMPACT.M_SWEET + (IMPACT.M_TIP - IMPACT.M_SWEET) * aa * aa
    : IMPACT.M_SWEET + (IMPACT.M_THROAT - IMPACT.M_SWEET) * aa * aa);
  return 1 / (1 / M + (bb * bb) / IMPACT.I_ROLL);
}

/** Apparent coefficient of restitution at (a, b): the ball's rebound off the swinging racket. */
export function apparentCOR(a = 0, b = 0) {
  const M = effectiveMass(a, b), m = IMPACT.M_BALL;
  return Math.max(0.02, (IMPACT.E_STRINGS * M - m) / (M + m));
}

/** Sweet-spot quality 0..1 of a contact (1 = dead centre, 0 = the frame). */
export function sweetness(a, b) {
  return clamp(1 - Math.sqrt(a * a * 0.8 + b * b * 1.3), 0, 1);
}

const _n = { x: 0, y: 0, z: 0 };

/**
 * What comes off the strings. ball v / W, racket V, face normal n (unit, pointing from the face
 * toward where the ball goes), string contact (a, b), the head's across axis B (unit, n × long
 * axis; for the twist), extraGyro (m/s of spin about the outgoing direction the swing path adds:
 * a kick serve's brush across the ball — the face model alone makes spin ⟂ n).
 * Writes out { vx, vy, vz, wx, wy, wz, eA, un, capped } and returns it.
 */
export function impactForward(bv, bw, V, n, a, b, B, out, extraGyro = 0) {
  const eA = apparentCOR(a, b);
  let nx = n.x, ny = n.y, nz = n.z;
  let ux = bv.x - V.x, uy = bv.y - V.y, uz = bv.z - V.z;
  let un = ux * nx + uy * ny + uz * nz;
  // An off-axis impact twists the face toward the edge that was hit (it gives on that side)
  if (B && b) {
    const th = clamp(IMPACT.TWIST_K * b * Math.abs(un), -0.4, 0.4);
    const tn = Math.tan(th);
    nx += B.x * tn; ny += B.y * tn; nz += B.z * tn;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    un = ux * nx + uy * ny + uz * nz;
  }
  // (a ball not moving into the face: the racket just pushes it)
  if (un > -0.3) un = -0.3;
  // Normal: restitution off the swinging racket
  const dun = -(1 + eA) * un;
  // Tangential: the contact point's slip (u_t + n × W), gripped toward rolling
  const utx = ux - un * nx, uty = uy - un * ny, utz = uz - un * nz;
  const sx = utx + (ny * bw.z - nz * bw.y), sy = uty + (nz * bw.x - nx * bw.z), sz = utz + (nx * bw.y - ny * bw.x);
  let jx = -IMPACT.GRIP * sx, jy = -IMPACT.GRIP * sy, jz = -IMPACT.GRIP * sz;
  const jm = Math.sqrt(jx * jx + jy * jy + jz * jz), cap = IMPACT.MU * dun;
  let capped = false;
  if (jm > cap && jm > 1e-9) { const k = cap / jm; jx *= k; jy *= k; jz *= k; capped = true; }
  // The ball: V + u' (u' = u + Δu_n·n + Δu_t)
  out.vx = bv.x + dun * nx + jx;
  out.vy = bv.y + dun * ny + jy;
  out.vz = bv.z + dun * nz + jz;
  // Spin: ΔW = −(n × Δu_t) / α
  const ia = 1 / IMPACT.ALPHA;
  out.wx = bw.x - (ny * jz - nz * jy) * ia;
  out.wy = bw.y - (nz * jx - nx * jz) * ia;
  out.wz = bw.z - (nx * jy - ny * jx) * ia;
  if (extraGyro) {
    const sp = Math.sqrt(out.vx * out.vx + out.vy * out.vy + out.vz * out.vz) || 1;
    out.wx += extraGyro * out.vx / sp; out.wy += extraGyro * out.vy / sp; out.wz += extraGyro * out.vz / sp;
  }
  out.eA = eA; out.un = un; out.capped = capped;
  return out;
}

// Scratch for the inverse
const _e1 = { x: 0, y: 0, z: 0 }, _e2 = { x: 0, y: 0, z: 0 }, _d = { x: 0, y: 0, z: 0 };
const _t = { vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, Vx: 0, Vy: 0, Vz: 0, un: 0, cap: false, brush: 0 };

/** For face normal n: the racket velocity that sends the ball out at wantV (no cap), and the spin that results. */
function solveForFace(nx, ny, nz, bv, bw, wantV, eA, out) {
  const g = IMPACT.GRIP;
  const vbn = bv.x * nx + bv.y * ny + bv.z * nz;
  const von = wantV.x * nx + wantV.y * ny + wantV.z * nz;
  const Vn = (von + eA * vbn) / (1 + eA);
  // n × W_b
  const cwx = ny * bw.z - nz * bw.y, cwy = nz * bw.x - nx * bw.z, cwz = nx * bw.y - ny * bw.x;
  // tangential parts
  const vbtx = bv.x - vbn * nx, vbty = bv.y - vbn * ny, vbtz = bv.z - vbn * nz;
  const votx = wantV.x - von * nx, voty = wantV.y - von * ny, votz = wantV.z - von * nz;
  const Vtx = (votx - (1 - g) * vbtx + g * cwx) / g;
  const Vty = (voty - (1 - g) * vbty + g * cwy) / g;
  const Vtz = (votz - (1 - g) * vbtz + g * cwz) / g;
  out.Vx = Vn * nx + Vtx; out.Vy = Vn * ny + Vty; out.Vz = Vn * nz + Vtz;
  // slip and the spin it leaves: W_out = W_b + (g/α)(n × s)
  const sx = vbtx - Vtx + cwx, sy = vbty - Vty + cwy, sz = vbtz - Vtz + cwz;
  const k = g / IMPACT.ALPHA;
  out.wx = bw.x + k * (ny * sz - nz * sy);
  out.wy = bw.y + k * (nz * sx - nx * sz);
  out.wz = bw.z + k * (nx * sy - ny * sx);
  const un = vbn - Vn;
  out.un = un;
  const dun = -(1 + eA) * un;
  out.cap = g * Math.sqrt(sx * sx + sy * sy + sz * sz) > IMPACT.MU * Math.max(0, dun) + 1e-6;
  out.brush = Math.sqrt(Vtx * Vtx + Vty * Vty + Vtz * Vtz) / Math.max(0.5, Math.abs(Vn));
  return out;
}

/**
 * The intention: the racket velocity V and face normal n (sweet-spot contact with restitution eA)
 * that send a ball arriving with bv / bw out at wantV, with the spin as close as possible to wantW
 * in the plane across the flight (the component along the flight — gyro — is the swing path's,
 * returned as sol.gyro for impactForward's extraGyro). Newton on the face's two angles.
 * Writes sol { n: {x,y,z}, V: {x,y,z}, gyro, speed, brush, spinErr, ok, why } and returns it.
 * ok = false when the stroke is beyond a racket (too fast, too much brush, the strings would slip):
 * the caller asks for less spin (or pace) and plans again.
 */
export function impactInverse(bv, bw, wantV, wantW, eA, sol) {
  const sp = Math.sqrt(wantV.x * wantV.x + wantV.y * wantV.y + wantV.z * wantV.z) || 1;
  const d = _d; d.x = wantV.x / sp; d.y = wantV.y / sp; d.z = wantV.z / sp;
  // basis across the flight: e1 horizontal (left of travel), e2 = e1 × d (up-ish)
  let hx = -d.z, hz = d.x;                         // (ŷ × d) horizontal
  const hl = Math.sqrt(hx * hx + hz * hz);
  if (hl < 1e-6) { hx = 1; hz = 0; } else { hx /= hl; hz /= hl; }
  _e1.x = hx; _e1.y = 0; _e1.z = hz;
  _e2.x = _e1.y * d.z - _e1.z * d.y; _e2.y = _e1.z * d.x - _e1.x * d.z; _e2.z = _e1.x * d.y - _e1.y * d.x;
  // wanted spin across the flight
  const w1 = wantW.x * _e1.x + wantW.y * _e1.y + wantW.z * _e1.z;
  const w2 = wantW.x * _e2.x + wantW.y * _e2.y + wantW.z * _e2.z;
  const wd = wantW.x * d.x + wantW.y * d.y + wantW.z * d.z;
  let p = 0, q = 0;
  let r1 = 0, r2 = 0;
  const T = _t;
  const face = (pp, qq) => {
    let nx = d.x + pp * _e1.x + qq * _e2.x, ny = d.y + pp * _e1.y + qq * _e2.y, nz = d.z + pp * _e1.z + qq * _e2.z;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    _n.x = nx / l; _n.y = ny / l; _n.z = nz / l;
    return solveForFace(_n.x, _n.y, _n.z, bv, bw, wantV, eA, T);
  };
  for (let it = 0; it < 12; it++) {
    face(p, q);
    r1 = T.wx * _e1.x + T.wy * _e1.y + T.wz * _e1.z - w1;
    r2 = T.wx * _e2.x + T.wy * _e2.y + T.wz * _e2.z - w2;
    if (r1 * r1 + r2 * r2 < 1e-6) break;
    const h = 1e-4;
    face(p + h, q);
    const a11 = (T.wx * _e1.x + T.wy * _e1.y + T.wz * _e1.z - w1 - r1) / h;
    const a21 = (T.wx * _e2.x + T.wy * _e2.y + T.wz * _e2.z - w2 - r2) / h;
    face(p, q + h);
    const a12 = (T.wx * _e1.x + T.wy * _e1.y + T.wz * _e1.z - w1 - r1) / h;
    const a22 = (T.wx * _e2.x + T.wy * _e2.y + T.wz * _e2.z - w2 - r2) / h;
    const det = a11 * a22 - a12 * a21;
    if (!(Math.abs(det) > 1e-12)) break;
    let dp = -(a22 * r1 - a12 * r2) / det, dq = -(-a21 * r1 + a11 * r2) / det;
    const st = Math.sqrt(dp * dp + dq * dq);
    if (st > 0.35) { dp *= 0.35 / st; dq *= 0.35 / st; }
    p += dp; q += dq;
  }
  face(p, q);
  r1 = T.wx * _e1.x + T.wy * _e1.y + T.wz * _e1.z - w1;
  r2 = T.wx * _e2.x + T.wy * _e2.y + T.wz * _e2.z - w2;
  const n = sol.n || (sol.n = { x: 0, y: 0, z: 0 });
  const V = sol.V || (sol.V = { x: 0, y: 0, z: 0 });
  n.x = _n.x; n.y = _n.y; n.z = _n.z;
  V.x = T.Vx; V.y = T.Vy; V.z = T.Vz;
  // the swing path's gyro: what the face leaves along the flight vs what was wanted
  const natGyro = T.wx * d.x + T.wy * d.y + T.wz * d.z;
  sol.gyro = wd - natGyro;
  sol.speed = Math.sqrt(V.x * V.x + V.y * V.y + V.z * V.z);
  sol.brush = T.brush;
  sol.spinErr = Math.sqrt(r1 * r1 + r2 * r2);
  sol.ok = true; sol.why = '';
  if (T.un >= -0.3) { sol.ok = false; sol.why = 'face'; }
  else if (sol.speed > IMPACT.V_MAX) { sol.ok = false; sol.why = 'speed'; }
  else if (T.brush > IMPACT.BRUSH_MAX) { sol.ok = false; sol.why = 'brush'; }
  else if (T.cap) { sol.ok = false; sol.why = 'slip'; }
  else if (sol.spinErr > 0.35) { sol.ok = false; sol.why = 'spin'; }
  return sol;
}

/**
 * Turn a face normal: dYaw about world up (+ = toward the hitter's left, counter-clockwise from
 * above), dPitch toward up (+ = the face opens: the ball goes higher). Writes out, returns it.
 */
export function faceRotate(n, dYaw, dPitch, out) {
  let x = n.x, y = n.y, z = n.z;
  if (dYaw) {
    const c = Math.cos(dYaw), s = Math.sin(dYaw);
    const nx = x * c + z * s, nz = -x * s + z * c;
    x = nx; z = nz;
  }
  if (dPitch) {
    // tilt toward the component of up across n
    let tx = -y * x, ty = 1 - y * y, tz = -y * z;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl > 1e-6) {
      tx /= tl; ty /= tl; tz /= tl;
      const c = Math.cos(dPitch), s = Math.sin(dPitch);
      x = x * c + tx * s; y = y * c + ty * s; z = z * c + tz * s;
    }
  }
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  out.x = x / l; out.y = y / l; out.z = z / l;
  return out;
}

// Timing-error sensitivity (per second of error beyond the green window)
export const STROKE_K = {
  ground: { yaw: 4.2, pitch: 1.1, speed: 1.4 },
  volley: { yaw: 3.0, pitch: 1.6, speed: 1.0 },
  smash: { yaw: 2.6, pitch: 3.0, speed: 1.2 },
};

/**
 * A groundstroke / volley / smash's execution error from the timing error e (s; − early,
 * + late) and the green half-width gw: inside the window nothing (the stroke adapts); beyond it
 * the face is turned — early pulls (a forehand to the hitter's left), late pushes (the other way
 * on the backhand) — and tilted (early closes it: lower; late opens it: higher), and the swing
 * loses a little speed. wing 'fh' | 'bh'; kind 'ground' | 'volley' | 'smash'.
 * Writes out { x (the excess, s), dYaw, dPitch, speedK } and returns it.
 */
export function strokeErrors(e, gw, wing, kind, out) {
  const x = e > gw ? e - gw : e < -gw ? e + gw : 0;
  const k = STROKE_K[kind] || STROKE_K.ground;
  const ws = wing === 'bh' ? -1 : 1;
  out.x = x;
  out.dYaw = -ws * k.yaw * x;
  out.dPitch = k.pitch * x;
  out.speedK = Math.max(0.6, 1 - k.speed * Math.abs(x));
  return out;
}

// Serve sensitivity: early — the face is still closing and the arm pulls across (net or wide);
// late — the ball has dropped: first the face is open (long), then you hit down on it (net); the
// arm pushes it wide either way
export const SERVE_K = { earlyDown: 1.6, earlyOut: 2.2, lateUp: 1.25, lateFlip: 0.045, lateDown: 3.6, lateOut: 1.8, speed: 1.2 };

/**
 * A serve's execution error from the timing error e (s; − early, + late) and the green
 * half-width gw. Inside the window nothing. Writes out { x, dPitch (+ up), dOut (+ = toward the
 * wide side, radians), speedK } — the caller turns dOut into a yaw on the box side it serves to.
 */
export function serveErrors(e, gw, out) {
  const x = e > gw ? e - gw : e < -gw ? e + gw : 0;
  const K = SERVE_K;
  out.x = x;
  if (x < 0) {
    out.dPitch = -K.earlyDown * -x;
    out.dOut = K.earlyOut * -x;
  } else if (x > 0) {
    out.dPitch = K.lateUp * Math.min(x, K.lateFlip) - K.lateDown * Math.max(0, x - K.lateFlip);
    out.dOut = K.lateOut * x;
  } else { out.dPitch = 0; out.dOut = 0; }
  out.speedK = Math.max(0.6, 1 - K.speed * Math.abs(x));
  return out;
}

/**
 * Where the ball met the strings from the ball's offset d (world, m) from the racket's sweet spot
 * at contact: a along the head's long axis L (+ toward the tip), b across it along B; `reach` (m)
 * of positioning error maps to the edge of the head (the game's forgiving scale). Writes out { a, b }.
 */
export function stringOffset(dx, dy, dz, L, B, reach, out) {
  out.a = (dx * L.x + dy * L.y + dz * L.z) / reach;
  out.b = (dx * B.x + dy * B.y + dz * B.z) / reach;
  return out;
}

/** Self-check (npm run validate): the inverse and the forward model agree; the sweet spot is the liveliest. */
export function impactSelfCheck() {
  const errs = [];
  const sol = {}, out = {};
  const cases = [
    { bv: { x: 0, y: -2, z: 18 }, bw: { x: 7, y: 0, z: 0 }, want: { x: 1.5, y: 5, z: -25 }, wantW: { x: -8, y: 0, z: 0 } },     // topspin off a topspin ball
    { bv: { x: 1, y: -3, z: 15 }, bw: { x: 0, y: 0, z: 0 }, want: { x: -2, y: 3, z: -24 }, wantW: { x: 2, y: 0.3, z: 0 } },     // flat
    { bv: { x: 0, y: 1, z: 20 }, bw: { x: 5, y: 0, z: 0 }, want: { x: 0, y: 5, z: -18 }, wantW: { x: 7, y: 3, z: 0 } },       // slice
    { bv: { x: 0, y: -1, z: 0.5 }, bw: { x: 0, y: 0, z: 0 }, want: { x: 3, y: -0.5, z: -36 }, wantW: { x: -2.5, y: 1.2, z: 0.3 } }, // serve off the toss
  ];
  for (const c of cases) {
    const eA = apparentCOR(0, 0);
    impactInverse(c.bv, c.bw, c.want, c.wantW, eA, sol);
    impactForward(c.bv, c.bw, sol.V, sol.n, 0, 0, null, out, sol.gyro);
    const dv = Math.hypot(out.vx - c.want.x, out.vy - c.want.y, out.vz - c.want.z);
    if (dv > 1e-6) errs.push(`impact: forward(inverse) velocity off by ${dv.toExponential(2)}`);
    if (sol.spinErr > 0.35 && sol.ok) errs.push('impact: spin error flagged ok');
  }
  const e0 = apparentCOR(0, 0), et = apparentCOR(1, 0), eb = apparentCOR(0, 0.6);
  if (!(e0 > 0.42 && e0 < 0.52)) errs.push(`impact: sweet-spot e_A ${e0.toFixed(3)} (want ≈ 0.47)`);
  if (!(et < e0 && eb < e0)) errs.push('impact: the tip / an off-axis hit must be deader than the sweet spot');
  return errs;
}
