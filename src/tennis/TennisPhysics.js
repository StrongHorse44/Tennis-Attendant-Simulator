/**
 * TennisPhysics — the pure constants and functions every tennis ball shares: the court
 * geometry, the playing surfaces, the shot spin profiles, the bounce model and the spin
 * frame. No three.js, no DOM: BallFlight, RacketImpact, the after-hours session, the member
 * matches and `npm run validate` (Node) all import it.
 *
 * Units: metres, seconds, m/s. Spin is a world vector W = ω·r (m/s at the ball's surface),
 * see spinVector. Court-local frame: u across, v along (the net is v = 0).
 */

export const G = 9.81;                  // gravity (m/s²)
export const R = 0.05;                  // ball radius for contacts (the drawn ball; aero uses the real 33.5 mm)
export const HALF_L = 12.3;             // baseline (court-local v)
export const SINGLES_W = 4.65;          // singles sideline (court-local u)
export const SERVICE_L = 6.62;          // service line
export const NET_H0 = 0.9, NET_H1 = 1.02, NET_POST = 7.8; // tape height at the centre / at the posts (u = ±NET_POST)
export const FENCE_V = 14.25;           // a flat court's back fence (the ball's centre at the chain-link)
export const BASE_V = 12.9;             // baseline stand
export const LINE_TOL = R;              // a ball touching the line is in
export const ROLL_VY = 0.8;             // a rebound slower than this (m/s up) rolls
export const T_MAX = 3.0;               // longest planned flight (s)

/**
 * Air (real values for a 67 mm, 57 g ball): K = ½·ρ·A / m (1/m). Drag CD 0.55 (+ a little with
 * spin), Magnus lift CL = S / (1 + 2S) with the spin parameter S = |W⊥| / |v|, spin decays a few
 * per cent per second. The wind is the air's velocity: drag and lift act on v − wind.
 */
export const AERO = { K: 0.0366, CD: 0.55, CD_SPIN: 0.15, CD_MAX: 0.75, SPIN_DECAY: 0.03 };

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
 * gyro in m/s.
 *  - top  (+ topspin / − backspin): axis to the left of travel (topspin dips, backspin floats).
 *  - side (+ curves to the hitter's left): vertical axis — a slice serve's curve, a backhand slice.
 *  - gyro (+ kicks to the hitter's right after the bounce): axis along the travel.
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

/** Height of the net tape (world y) at court-local u on a court whose surface is at surfY (it sags to the middle). */
export function netTopAt(surfY, u) {
  const k = Math.min(1, Math.abs(u) / NET_POST);
  return surfY + NET_H0 + (NET_H1 - NET_H0) * k * k;
}

/**
 * World spin vector from a hitter-frame profile { top, side, gyro } for travel along the
 * horizontal unit vector (ux, uz). Writes out.x/y/z. (Travel +x: the hitter's left is −z.)
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
