import * as THREE from 'three';
import { COLORS } from '../utils/Constants.js';
import { mat } from '../graphics/Materials.js';
import { sphereGeo } from '../graphics/GeometryUtils.js';
import { BlobShadows, CameraTracker } from './CharacterModel.js';
import { BallFlight } from '../tennis/BallFlight.js';

export const BALL_RADIUS = 0.05;
export const GRAVITY = 9.8;

/**
 * TennisBall — one pooled ball per active court (MatchSystem). A small soft blob shadow
 * (shared BlobShadows instance) sits under it; the mesh grows a little with camera distance
 * so the ball stays readable from the overview.
 *
 * Two ways to fly it:
 *  - A real flight (`new TennisBall(scene, { flight: true })`, the member matches): the ball owns
 *    one preallocated BallFlight (tennis/BallFlight.js — gravity, drag, Magnus lift, spin decay,
 *    wind, the surface's friction bounce, the net / net cord, the back fence or a show court's end
 *    boards, the stands, rolling to rest). launchFlight() integrates the whole flight at once;
 *    at(t) reads it (bounces, rolling and the resting ball included), and the flight's events
 *    (flight.events) tell the match what happened when.
 *  - The analytic segment (launch / at / vyAt / timeToHeight / roll / stepRoll): a segment is
 *    (p0, v0, t0) under gravity, so any time t gives an exact position. Subclasses (the
 *    after-hours TennisBallSim) build on it.
 */
export class TennisBall {
  /**
   * @param {THREE.Scene} scene
   * @param {{ flight?: boolean }} [opts] flight: give the ball its own BallFlight (launchFlight)
   */
  constructor(scene, opts = null) {
    this.scene = scene;
    const material = mat(COLORS.tennisBall ?? 0xd4e157, {
      roughness: 1, emissive: 0x5d6b0c, emissiveIntensity: 0.35,
    });
    this.mesh = new THREE.Mesh(sphereGeo(BALL_RADIUS, 10, 8), material);
    this.mesh.name = 'TennisBall';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.noAO = true;
    this.mesh.userData.noMerge = true;
    this.mesh.userData.dynamic = true;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._blobs = BlobShadows.get(scene);
    this._blobSlot = this._blobs.alloc();
    this._blobs.hide(this._blobSlot);

    this.p0 = new THREE.Vector3();
    this.v0 = new THREE.Vector3();
    this.t0 = 0;
    this.pos = new THREE.Vector3();
    this.active = false;   // in play (flying / rolling)
    this.rolling = false;  // dead ball rolling on the ground (numeric; segment mode)
    this.inUse = false;    // claimed by a match
    this.groundY = 0.15;
    this.shown = false;

    // Real flight (opt-in): one preallocated BallFlight, read by at() while flightMode is on
    this.flight = opts && opts.flight ? new BallFlight() : null;
    this.flightMode = false;
    this.bounced = 0;      // bounces since the last racket contact (the match keeps it; FlightReader reads it)
    /** The flight state at the last at(t) in flight mode: { x, y, z, vx, vy, vz, wx, wy, wz, bounces, rolling }. */
    this.state = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, bounces: 0, rolling: false };
  }

  /**
   * Launch a real flight at time t0 from p with velocity v and spin W (m/s at the ball's surface,
   * world) in the court env (BallFlight: { surfY, frame, fence, surface, wind, groundAt, net });
   * the whole flight is integrated now. opts: BallFlight.launch options ({ gravityOnly, maxBounces }).
   */
  launchFlight(t0, px, py, pz, vx, vy, vz, wx, wy, wz, env, opts = null) {
    if (!this.flight) this.flight = new BallFlight();   // (only a ball built without { flight: true })
    this.flight.launch(t0, px, py, pz, vx, vy, vz, wx, wy, wz, env, opts);
    this.flightMode = true;
    this.p0.set(px, py, pz);
    this.v0.set(vx, vy, vz);
    this.t0 = t0;
    this.active = true;
    this.rolling = false;
    this.pos.set(px, py, pz);
    return this.flight;
  }

  /** Start an analytic flight segment at time t from p with velocity v (leaves flight mode). */
  launch(t, px, py, pz, vx, vy, vz) {
    this.flightMode = false;
    this.p0.set(px, py, pz);
    this.v0.set(vx, vy, vz);
    this.t0 = t;
    this.active = true;
    this.rolling = false;
    this.pos.copy(this.p0);
  }

  /** Position at time t (writes this.pos): the real flight in flight mode, else the segment. */
  at(t) {
    if (this.flightMode) {
      const s = this.flight.at(t, this.state);
      this.pos.set(s.x, s.y, s.z);
      return this.pos;
    }
    const d = t - this.t0;
    this.pos.set(
      this.p0.x + this.v0.x * d,
      this.p0.y + this.v0.y * d - 0.5 * GRAVITY * d * d,
      this.p0.z + this.v0.z * d,
    );
    return this.pos;
  }

  /** Vertical velocity at time t (the flight's in flight mode). */
  vyAt(t) {
    if (this.flightMode) return this.flight.at(t, this.state).vy;
    return this.v0.y - GRAVITY * (t - this.t0);
  }

  /** Time (> t0) when the ball comes down to height y (the flight's first descending crossing in flight mode), or Infinity. */
  timeToHeight(y) {
    if (this.flightMode) return this.flight.crossHeight(y, this.t0, this.flight.tEnd, true);
    const a = -0.5 * GRAVITY, b = this.v0.y, c = this.p0.y - y;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const r = (-b - Math.sqrt(disc)) / (2 * a); // later root (a < 0)
    return r > 1e-4 ? this.t0 + r : Infinity;
  }

  /** Dead ball: roll along the ground with friction from the current position (segment mode). */
  roll(t, vx, vz) {
    this.flightMode = false;
    this.p0.set(this.pos.x, this.groundY + BALL_RADIUS, this.pos.z);
    this.v0.set(vx, 0, vz);
    this.t0 = t;
    this.rolling = true;
    this.active = true;
  }

  stepRoll(dt) {
    const k = Math.exp(-1.6 * dt);
    this.v0.x *= k; this.v0.z *= k;
    this.p0.x += this.v0.x * dt; this.p0.z += this.v0.z * dt;
    this.pos.copy(this.p0);
  }

  hide() {
    this.active = false;
    this.rolling = false;
    this.flightMode = false;
    if (this.shown) {
      this.mesh.visible = false;
      this._blobs.hide(this._blobSlot);
      this.shown = false;
    }
  }

  /** Push this.pos to the mesh + blob. `visible` = LOD decision by the caller. */
  sync(visible) {
    if (!visible || !this.active) {
      if (this.shown) { this.mesh.visible = false; this._blobs.hide(this._blobSlot); this.shown = false; }
      return;
    }
    const p = this.pos;
    this.mesh.position.copy(p);
    let s = 1;
    if (CameraTracker.valid) {
      const c = CameraTracker.position;
      const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      s = Math.min(2.4, Math.max(1, d / 13));
    }
    this.mesh.scale.setScalar(s);
    this.mesh.visible = true;
    this.shown = true;
    const h = Math.max(0, p.y - this.groundY);
    const bs = (0.16 + 0.05 * s) / (1 + h * 0.6);
    this._blobs.set(this._blobSlot, p.x, p.z, bs, bs, 0, this.groundY + 0.022);
  }
}
