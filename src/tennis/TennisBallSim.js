import * as THREE from 'three';
import { SIZES } from '../utils/Constants.js';
import { TennisBall } from '../entities/TennisBall.js';
import { CameraTracker } from '../entities/CharacterModel.js';
import { mat } from '../graphics/Materials.js';
import { createCanvasTexture } from '../graphics/Textures.js';
import { BallFlight } from './BallFlight.js';
import { R, netTopAt, SURFACES as SURF_TABLE } from './TennisPhysics.js';

/**
 * TennisBallSim — the after-hours ball. Every flight is a real one (BallFlight: gravity, drag,
 * Magnus lift of the spin, spin decay, wind, the friction bounce on the playing surface, the net,
 * the back fence or a show court's end boards, the stands of the sunken court), integrated once
 * when the ball leaves a racket or a hand into a preallocated buffer. The session, Rafa, the timing
 * aids and the landing marker all read that same flight (BallPredictor = BallFlight's FlightReader),
 * so what they predict is exactly what happens.
 *
 * The ball draws where the physics puts it, except in the last moment before a racket contact:
 * the strings are where the swing puts them, the true ball a few centimetres (or a stretch) away,
 * so the drawn ball eases onto the strings (reachTo) and back onto its new flight after the hit
 * (releaseOffset). `pos` is always the true ball (the physics); `drawPos` is what you see.
 *
 * Also re-exports the shared court constants and physics functions (TennisPhysics is the one
 * source of truth). Heights: SURF / BALL_Y are live bindings for the session's court
 * (setCourtBase): a flat court's frame sits at y 0 (SURF 0.15), the sunken Centre Court's at its
 * map.json center.y (SURF −2.85). Session-only state: no daytime system may import SURF / BALL_Y
 * (MatchSystem keeps its own court frames).
 */

export {
  G, R, HALF_L, SINGLES_W, SERVICE_L, NET_H0, NET_H1, NET_POST, FENCE_V, BASE_V, LINE_TOL, ROLL_VY, T_MAX,
  SURFACES, SPIN, AERO, bounceBall, spinVector, netTopAt,
} from './TennisPhysics.js';
export { FlightReader as BallPredictor, BallFlight, planShot } from './BallFlight.js';

export const SURF_REL = SIZES.courtSurfaceY ?? 0.15;   // court surface above the court's frame
export let SURF = SURF_REL;              // court surface (world y) of the session's court
export let BALL_Y = SURF + R;            // ball centre touching the court

/**
 * Move the playing surface to a court whose frame sits at world y `y0` (court.baseY: 0 for the
 * flat courts, below the lawn for the sunken show court). Every importer sees the new SURF /
 * BALL_Y (ES module live bindings); TennisSession._applyCourtBase calls it on a court change.
 */
export function setCourtBase(y0) {
  SURF = (Number.isFinite(y0) ? y0 : 0) + SURF_REL;
  BALL_Y = SURF + R;
}

/** Height of the net tape (world y) at court-local u on the session's court (it sags to the middle). */
export function netTop(u) { return netTopAt(SURF, u); }

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
const _o = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, bounces: 0, rolling: false };
const SPIN_VIS = 0.045;   // on-screen spin rate (× real): readable direction, no strobing
const OFF_OUT = 0.15;     // after a racket contact the drawn ball rejoins its flight over this long (s)
const smooth = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

export class TennisBallSim extends TennisBall {
  constructor(scene) {
    super(scene);
    this.mesh.name = 'AfterHoursBall';
    try {
      this.mesh.material = mat(0xffffff, { map: seamTexture(), roughness: 1, emissive: 0x5d6b0c, emissiveIntensity: 0.3 });
    } catch (e) { /* keep the plain ball */ }
    this.flight = new BallFlight();         // the one flight buffer, reused for every launch
    this.vel = new THREE.Vector3();         // velocity at the last at(t)
    this.w = new THREE.Vector3();           // spin ω·r (m/s, world) at the last at(t)
    this.drawPos = new THREE.Vector3();     // where the ball is drawn (pos + the racket-contact offset)
    this.spin = 'flat';                     // shot label of the current flight (HUD / coach / FX)
    this.bounced = 0;                       // bounces of the current flight the session has processed
    this.groundY = SURF;
    this.surface = SURF_TABLE.hard;         // SURFACES entry of the session's court (the session sets it)
    this.tLive = Infinity;                  // from here the ball is dead: the net, the back wall, the stands
    this.t0 = 0;                            // launch time of the current flight
    this.serial = 0;                        // +1 per launch (readers cache per flight)
    // Racket-contact display offset: D = racket − true ball at the contact, eased in before it
    // (mode 1: tIn → tHit) and out after it (mode 2: tHit → tHit + OFF_OUT, from weight w0)
    this._off = new THREE.Vector3();
    this._offMode = 0; this._offIn = 0; this._offHit = 0; this._offW0 = 0;
  }

  /**
   * Launch a flight at time t from p with velocity v and spin w (world, m/s) in the court `env`
   * (BallFlight env: surfY, frame, fence, surface, wind, groundAt). opts: { gravityOnly } for
   * tosses. The whole flight is integrated now; returns it.
   */
  fly(t, px, py, pz, vx, vy, vz, wx, wy, wz, env, opts = null) {
    const f = this.flight;
    f.launch(t, px, py, pz, vx, vy, vz, wx, wy, wz, env, opts);
    this.serial++;
    this.t0 = t;
    this.active = true;
    this.rolling = false;
    this.bounced = 0;
    let tl = f.tEnd;
    for (let i = 0; i < f.nEvents; i++) {
      const ty = f.events[i].type;
      if (ty === 'net' || ty === 'fence' || ty === 'stands') { tl = f.events[i].t; break; }
    }
    this.tLive = tl;
    this.at(t);
    return f;
  }

  /** The true ball at time t: pos, vel, w (spin) and rolling. Returns pos. */
  at(t) {
    const o = this.flight.at(t, _o);
    this.pos.set(o.x, o.y, o.z);
    this.vel.set(o.vx, o.vy, o.vz);
    this.w.set(o.wx, o.wy, o.wz);
    this.rolling = o.rolling;
    return this.pos;
  }

  /** The flight's state at time t into out ({ x, y, z, vx, vy, vz, wx, wy, wz, bounces, rolling }): no side effects. */
  stateAt(t, out) { return this.flight.at(t, out); }

  /** Velocity at time t (writes the Vector3 out). */
  velAt(t, out) {
    const o = this.flight.at(t, _o);
    out.set(o.vx, o.vy, o.vz);
    return out;
  }

  vyAt(t) { return this.flight.at(t, _o).vy; }

  /** Time of the flight's bounce k (Infinity if it does not bounce that often). */
  bounceTime(k) {
    const f = this.flight;
    return k >= 0 && k < f.nb && k < f.bT.length ? f.bT[k] : Infinity;
  }

  // ─────────────────────────── racket-contact display offset ───────────────────────────

  /**
   * A racket will meet the ball at tc at (px, py, pz): draw the ball easing onto the strings
   * over the last moment before it (the physics keeps the true ball; the shot leaves from it).
   */
  reachTo(tc, px, py, pz) {
    const o = this.flight.at(tc, _o);
    this._off.set(px - o.x, py - o.y, pz - o.z);
    const d = this._off.length();
    this._offHit = tc;
    this._offIn = tc - Math.min(0.24, 0.1 + 0.1 * d);
    this._offMode = 1;
  }

  /** The contact happened (or will not): ease the drawn ball back onto the true flight from time t. */
  releaseOffset(t) {
    if (this._offMode === 0) return;
    this._offW0 = this._offWeight(t);
    this._offHit = t;
    this._offMode = this._offW0 > 1e-3 ? 2 : 0;
  }

  clearOffset() { this._offMode = 0; }

  _offWeight(t) {
    if (this._offMode === 1) return smooth((t - this._offIn) / Math.max(1e-3, this._offHit - this._offIn));
    if (this._offMode === 2) return this._offW0 * (1 - smooth((t - this._offHit) / OFF_OUT));
    return 0;
  }

  /** Per frame (after at(t)): where to draw the ball. */
  updateDraw(t) {
    const w = this._offMode ? this._offWeight(t) : 0;
    if (this._offMode === 2 && t >= this._offHit + OFF_OUT) this._offMode = 0;
    this.drawPos.copy(this.pos);
    if (w > 0) this.drawPos.addScaledVector(this._off, w);
    return this.drawPos;
  }

  /** Visual spin: turn the ball about its spin axis (slowed down so the direction reads). */
  turn(dt) {
    const w = this.w, m = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
    if (m < 0.2 || !this.shown) return;
    _ax.set(w.x / m, w.y / m, w.z / m);
    _q.setFromAxisAngle(_ax, (m / R) * SPIN_VIS * dt);
    this.mesh.quaternion.premultiply(_q);
  }

  /** Draw at drawPos (the star of the show: a bit larger with distance) with its blob shadow. */
  sync(visible) {
    if (!visible || !this.active) { super.sync(false); return; }
    const p = this.drawPos;
    this.mesh.position.copy(p);
    let s = 1.3;
    if (CameraTracker.valid) {
      const c = CameraTracker.position;
      const d = Math.sqrt((c.x - p.x) ** 2 + (c.y - p.y) ** 2 + (c.z - p.z) ** 2);
      s = Math.min(3.2, Math.max(1.3, d / 8));
    }
    this.mesh.scale.setScalar(s);
    this.mesh.visible = true;
    this.shown = true;
    const h = Math.max(0, p.y - this.groundY);
    const bs = (0.16 + 0.05 * Math.min(2.4, s)) / (1 + h * 0.6);
    this._blobs.set(this._blobSlot, p.x, p.z, bs, bs, 0, this.groundY + 0.022);
  }
}
