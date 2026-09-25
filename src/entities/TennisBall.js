import * as THREE from 'three';
import { COLORS } from '../utils/Constants.js';
import { mat } from '../graphics/Materials.js';
import { sphereGeo } from '../graphics/GeometryUtils.js';
import { BlobShadows, CameraTracker } from './CharacterModel.js';

export const BALL_RADIUS = 0.05;
export const GRAVITY = 9.8;

/**
 * TennisBall — one pooled ball per active court (MatchSystem). The flight is analytic: a
 * segment is (p0, v0, t0) under gravity, so any time t gives an exact position (the match
 * logic plans bounces and racket contacts on the same clock). A small soft blob shadow
 * (shared BlobShadows instance) sits under it; the mesh grows a little with camera distance
 * so the ball stays readable from the overview.
 */
export class TennisBall {
  constructor(scene) {
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
    this.rolling = false;  // dead ball rolling on the ground (numeric)
    this.inUse = false;    // claimed by a match
    this.groundY = 0.15;
    this.shown = false;
  }

  /** Start a flight segment at time t from p with velocity v. */
  launch(t, px, py, pz, vx, vy, vz) {
    this.p0.set(px, py, pz);
    this.v0.set(vx, vy, vz);
    this.t0 = t;
    this.active = true;
    this.rolling = false;
    this.pos.copy(this.p0);
  }

  /** Position at time t on the current segment (writes this.pos). */
  at(t) {
    const d = t - this.t0;
    this.pos.set(
      this.p0.x + this.v0.x * d,
      this.p0.y + this.v0.y * d - 0.5 * GRAVITY * d * d,
      this.p0.z + this.v0.z * d,
    );
    return this.pos;
  }

  /** Vertical velocity at time t on the current segment. */
  vyAt(t) { return this.v0.y - GRAVITY * (t - this.t0); }

  /** Time (> t0) when the segment comes down to height y, or Infinity. */
  timeToHeight(y) {
    const a = -0.5 * GRAVITY, b = this.v0.y, c = this.p0.y - y;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return Infinity;
    const r = (-b - Math.sqrt(disc)) / (2 * a); // later root (a < 0)
    return r > 1e-4 ? this.t0 + r : Infinity;
  }

  /** Dead ball: roll along the ground with friction from the current position. */
  roll(t, vx, vz) {
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
