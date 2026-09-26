import * as THREE from 'three';
import { HALF_L } from './TennisBallSim.js';

/**
 * TennisCamera — the broadcast-style view from behind the player's baseline: high enough
 * to see the far baseline and Rafa, following the player sideways a little and leaning
 * toward the ball, and moving in part of the way when the player comes to the net. Portrait
 * phones get a higher, further view so the whole court width fits the narrow frame. After a
 * change of ends it swings round to the other end.
 */

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();

export class TennisCamera {
  constructor(camera) {
    this.camera = camera;
    this.look = new THREE.Vector3();
    this._swing = 0; // > 0 while swinging round after a change of ends
  }

  _pose(s, outPos, outLook) {
    const f = s.frame, side = s.sides[0];
    const aspect = this.camera.aspect || 1.6;
    const portrait = aspect < 0.8;
    const narrow = aspect < 1.2;
    const back = portrait ? 12.2 : narrow ? 10 : 8.4;
    const up = portrait ? 9.2 : narrow ? 7.4 : 6.1;
    let follow = portrait ? 0.62 : 0.4;
    let pu = s.pl.u;
    // Lean toward the ball in the air
    const b = s.ball;
    if (b && b.active && b.shown) pu = pu * 0.75 + f.lu(b.pos.x, b.pos.z) * 0.25;
    const cu = THREE.MathUtils.clamp(pu * follow, -3.5, 3.5);
    // Follow the player in toward the net (at most ~4 m, never past the back fence)
    const fwd = Math.min(4, Math.max(0, HALF_L - Math.abs(s.pl.v)) * 0.36);
    const cv = side * (HALF_L + back - fwd);
    outPos.set(f.wx(cu, cv), up - fwd * 0.2, f.wz(cu, cv));
    const lv = side * ((portrait ? -1.5 : 0.5) - fwd * 0.4);
    outLook.set(f.wx(cu * 0.55, lv), portrait ? 0.2 : 0.7, f.wz(cu * 0.55, lv));
  }

  snap(s) {
    this._pose(s, _pos, _look);
    this.camera.position.copy(_pos);
    this.look.copy(_look);
    this.camera.lookAt(this.look);
    this._swing = 0;
  }

  /** Change of ends: glide round (over the net) instead of cutting. */
  flip() { this._swing = 1; }

  update(s, dt) {
    this._pose(s, _pos, _look);
    const cam = this.camera;
    if (this._swing > 0) {
      // Rise over the court while moving to the other end
      this._swing = Math.max(0, this._swing - dt / 1.4);
      const k = Math.min(1, dt * 2.6);
      cam.position.lerp(_pos, k);
      cam.position.y += Math.sin(this._swing * Math.PI) * 4 * k;
      this.look.lerp(_look, k);
    } else {
      cam.position.lerp(_pos, Math.min(1, dt * 3.2));
      this.look.lerp(_look, Math.min(1, dt * 4));
    }
    cam.lookAt(this.look);
  }
}
