import * as THREE from 'three';
import { getMaterial } from '../graphics/Materials.js';
import { getGeometry } from '../graphics/GeometryUtils.js';
import { Textures } from '../graphics/Textures.js';
import { CameraTracker } from '../entities/CharacterModel.js';

/**
 * TennisFX — flat court overlays for the after-hours mode: the landing marker for the
 * incoming ball (optional aid), the aim guide while a stroke is loaded (optional aid), drill
 * target rings, a small burst ring where a drill shot lands, the ball's trail (coloured by its
 * spin: gold topspin, ice-blue slice, white flat), the marks bounces leave on clay (one merged
 * mesh, the last MARKS kept) and dust puffs when you slide on clay. A handful of unlit meshes
 * (≤ 12 draw calls, only while the mode runs), with shared geometries and per-role materials
 * that use programs the game already has; nothing allocates per frame.
 */

const MAX_TARGETS = 3;
const Y_OFF = 0.02; // above the court surface (no z-fighting)
const MARKS = 12;   // clay ball marks kept
const MARK_SEG = 10;
const TRAIL = 9;    // trail samples (frames)
const PUFFS = 4;
const TRAIL_COLORS = { top: 0xffc15a, back: 0x8fd8ff, flat: 0xffffff };

function flatMat(key, color, opacity) {
  return getMaterial(key, () => {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog: false });
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
    return m;
  });
}

function flatMesh(geo, material, order = 3) {
  const m = new THREE.Mesh(geo, material);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = order;
  m.visible = false;
  m.frustumCulled = false;
  m.userData.noAO = true; m.userData.noMerge = true; m.userData.dynamic = true;
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

export class TennisFX {
  constructor(scene) {
    this.root = new THREE.Group();
    this.root.name = 'TennisFX';
    scene.add(this.root);
    const ring = getGeometry('tennisRing|0.26|0.36', () => new THREE.RingGeometry(0.26, 0.36, 32));
    const dot = getGeometry('tennisDot|0.1', () => new THREE.CircleGeometry(0.1, 16));
    const tRing = getGeometry('tennisTarget', () => new THREE.RingGeometry(0.82, 1, 40));
    const burst = getGeometry('tennisBurst', () => new THREE.RingGeometry(0.8, 1, 32));

    this.markerMatIn = flatMat('tennisMarkerIn', 0xffe066, 0.9);
    this.markerMatOut = flatMat('tennisMarkerOut', 0xff7a5c, 0.9);
    this.marker = flatMesh(ring, this.markerMatIn, 4);
    this.markerDot = flatMesh(dot, this.markerMatIn, 4);
    this.root.add(this.marker, this.markerDot);

    this.targetMat = flatMat('tennisTargetMat', 0x7fe3a0, 0.75);
    this.targets = [];
    for (let i = 0; i < MAX_TARGETS; i++) {
      const m = flatMesh(tRing, this.targetMat, 3);
      this.root.add(m);
      this.targets.push(m);
    }
    // Aim guide: a crosshair ring on Rafa's side where the stick is pointing
    const aimRing = getGeometry('tennisAimRing', () => new THREE.RingGeometry(0.6, 0.78, 36));
    const aimDot = getGeometry('tennisAimDot', () => new THREE.CircleGeometry(0.16, 12));
    this.aimMat = flatMat('tennisAimMat', 0x9fe8ff, 0.85);
    this.aim = flatMesh(aimRing, this.aimMat, 4);
    this.aimDot = flatMesh(aimDot, this.aimMat, 4);
    this.root.add(this.aim, this.aimDot);
    this._aimOn = false;
    this.burstMat = getMaterial('tennisBurstMat', () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false, fog: false }));
    this.burst = flatMesh(burst, this.burstMat, 5);
    this.root.add(this.burst);
    this._burstT = 0;
    this._t = 0;
    this._markerOn = false;

    // Clay ball marks: MARKS small ellipses in one dynamic geometry (a fan each)
    const mv = MARKS * (MARK_SEG + 1);
    this._markPos = new Float32Array(mv * 3);
    // A skid mark: freshly smoothed, brighter clay in the middle, darker where it dug the edge
    const col = new Float32Array(mv * 3), cIn = new THREE.Color(0xf0a878), cOut = new THREE.Color(0x6a2410);
    for (let m = 0; m < MARKS; m++) {
      for (let k = 0; k <= MARK_SEG; k++) {
        const c = k === 0 ? cIn : cOut, o = (m * (MARK_SEG + 1) + k) * 3;
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    }
    const idx = [];
    for (let m = 0; m < MARKS; m++) {
      const o = m * (MARK_SEG + 1);
      for (let k = 0; k < MARK_SEG; k++) idx.push(o, o + 1 + ((k + 1) % MARK_SEG), o + 1 + k);
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(this._markPos, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    mg.setIndex(idx);
    this.marksMat = getMaterial('tennisClayMark', () => {
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, fog: false });
      m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
      return m;
    });
    this.marks = new THREE.Mesh(mg, this.marksMat);
    this.marks.renderOrder = 2;
    this.marks.visible = false; this.marks.frustumCulled = false;
    this.marks.userData.noAO = true; this.marks.userData.noMerge = true; this.marks.userData.dynamic = true;
    this.root.add(this.marks);
    this._markN = 0;
    this._markY = 0.15;

    // Ball trail: a camera-facing ribbon through the last TRAIL ball positions, tapering off
    const tv = TRAIL * 2;
    this._trailPos = new Float32Array(tv * 3);
    const tIdx = [];
    for (let i = 0; i < TRAIL - 1; i++) { const a = i * 2; tIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this._trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setIndex(tIdx);
    this.trailMat = getMaterial('tennisTrailMat', () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, fog: false }));
    this.trail = new THREE.Mesh(tg, this.trailMat);
    this.trail.renderOrder = 6;
    this.trail.visible = false; this.trail.frustumCulled = false;
    this.trail.userData.noAO = true; this.trail.userData.noMerge = true; this.trail.userData.dynamic = true;
    this.root.add(this.trail);
    this._hist = new Float32Array(TRAIL * 3);
    this._histN = 0;

    // Clay dust puffs (sprites: the same program as the name tags)
    this.puffs = [];
    const blob = Textures.radialBlob();
    for (let i = 0; i < PUFFS; i++) {
      const mtl = getMaterial('tennisDust' + i, () => new THREE.SpriteMaterial({ map: blob, color: 0xd9a27c, transparent: true, opacity: 0.6, depthWrite: false, fog: false }));
      const sp = new THREE.Sprite(mtl);
      sp.visible = false; sp.renderOrder = 5;
      sp.userData.noAO = true; sp.userData.noMerge = true; sp.userData.dynamic = true;
      this.root.add(sp);
      this.puffs.push({ sp, t: 0, vx: 0, vz: 0 });
    }
    this._puffNext = 0;
  }

  // ─────────────────────────── clay marks ───────────────────────────

  /** A bounce mark on clay at (x, z), stretched along the ball's travel (vx, vz). */
  mark(x, z, vx, vz, y = this._markY) {
    const i = this._markN % MARKS;
    this._markN++;
    const hs = Math.hypot(vx, vz) || 1, dx = vx / hs, dz = vz / hs;
    const L = 0.16 + Math.min(0.14, hs * 0.008), W = 0.085;   // (drawn ~1.7× real so it reads from the camera)
    const P = this._markPos, o = i * (MARK_SEG + 1) * 3, yy = y + Y_OFF * 0.4;
    P[o] = x; P[o + 1] = yy; P[o + 2] = z;
    for (let k = 0; k < MARK_SEG; k++) {
      const a = (k / MARK_SEG) * Math.PI * 2, ca = Math.cos(a) * L, sa = Math.sin(a) * W;
      const j = o + (k + 1) * 3;
      P[j] = x + dx * ca - dz * sa; P[j + 1] = yy; P[j + 2] = z + dz * ca + dx * sa;
    }
    this.marks.geometry.attributes.position.needsUpdate = true;
    this.marks.visible = true;
  }

  clearMarks() {
    this._markPos.fill(0);
    this.marks.geometry.attributes.position.needsUpdate = true;
    this.marks.visible = false;
    this._markN = 0;
  }

  // ─────────────────────────── clay dust ───────────────────────────

  /** A puff of clay dust at the feet (sliding), drifting along (vx, vz). */
  dust(x, z, vx, vz) {
    const p = this.puffs[this._puffNext];
    this._puffNext = (this._puffNext + 1) % PUFFS;
    p.sp.position.set(x, this._markY + 0.15, z);
    p.sp.scale.setScalar(0.3);
    p.sp.material.opacity = 0.6;
    p.sp.visible = true;
    p.t = 0.001; p.vx = vx * 0.25; p.vz = vz * 0.25;
  }

  // ─────────────────────────── ball trail ───────────────────────────

  /**
   * Per frame: the ball's position (x, y, z), whether it flies, its visual scale and its spin
   * about its own left axis (+ topspin, − slice) for the colour.
   */
  trailUpdate(on, x, y, z, scale, top) {
    if (!on) { if (this.trail.visible) this.trail.visible = false; this._histN = 0; return; }
    const H = this._hist;
    H.copyWithin(3, 0, (TRAIL - 1) * 3);
    H[0] = x; H[1] = y; H[2] = z;
    if (this._histN < TRAIL) this._histN++;
    const n = this._histN;
    if (n < 3 || !CameraTracker.valid) { this.trail.visible = false; return; }
    const c = CameraTracker.position, P = this._trailPos;
    const w0 = 0.05 * scale;
    for (let i = 0; i < TRAIL; i++) {
      const k = Math.min(i, n - 1), j = k * 3;
      const k2 = Math.min(k + 1, n - 1), j2 = k2 * 3, k0 = Math.max(k - 1, 0), j0 = k0 * 3;
      // direction along the trail and to the camera → the ribbon's side
      let dx = H[j0] - H[j2], dy = H[j0 + 1] - H[j2 + 1], dz = H[j0 + 2] - H[j2 + 2];
      const tx = c.x - H[j], ty = c.y - H[j + 1], tz = c.z - H[j + 2];
      let sx = dy * tz - dz * ty, sy = dz * tx - dx * tz, sz = dx * ty - dy * tx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const w = w0 * (1 - k / (TRAIL - 1)) / sl;
      sx *= w; sy *= w; sz *= w;
      const o = i * 6;
      P[o] = H[j] + sx; P[o + 1] = H[j + 1] + sy; P[o + 2] = H[j + 2] + sz;
      P[o + 3] = H[j] - sx; P[o + 4] = H[j + 1] - sy; P[o + 5] = H[j + 2] - sz;
      void dx; void dy; void dz;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trailMat.color.setHex(top > 3 ? TRAIL_COLORS.top : top < -2 ? TRAIL_COLORS.back : TRAIL_COLORS.flat);
    this.trail.visible = true;
  }

  showMarker(x, y, z, isIn) {
    const mt = isIn ? this.markerMatIn : this.markerMatOut;
    this.marker.material = mt; this.markerDot.material = mt;
    this.marker.position.set(x, y + Y_OFF, z);
    this.markerDot.position.set(x, y + Y_OFF, z);
    this.marker.visible = this.markerDot.visible = true;
    this._markerOn = true;
  }

  hideMarker() {
    this.marker.visible = this.markerDot.visible = false;
    this._markerOn = false;
  }

  showAim(x, y, z) {
    this.aim.position.set(x, y + Y_OFF * 1.2, z);
    this.aimDot.position.set(x, y + Y_OFF * 1.2, z);
    if (!this._aimOn) { this.aim.visible = this.aimDot.visible = true; this._aimOn = true; }
  }

  hideAim() {
    if (!this._aimOn) return;
    this.aim.visible = this.aimDot.visible = false;
    this._aimOn = false;
  }

  /** list: [{ x, z, r }] (world) — up to three rings. */
  setTargets(list, y) {
    for (let i = 0; i < MAX_TARGETS; i++) {
      const m = this.targets[i], t = list[i];
      if (!t) { m.visible = false; continue; }
      m.position.set(t.x, y + Y_OFF * 0.5, t.z);
      m.scale.setScalar(t.r);
      m.visible = true;
    }
  }

  burstAt(x, y, z, big) {
    this.burst.position.set(x, y + Y_OFF * 1.5, z);
    this.burstMat.color.setHex(big ? 0xffe066 : 0xffffff);
    this.burst.visible = true;
    this._burstT = 0.001;
    this._burstBig = big;
  }

  hideAll() {
    this.hideMarker();
    this.hideAim();
    for (const m of this.targets) m.visible = false;
    this.burst.visible = false;
    this._burstT = 0;
    this.trail.visible = false; this._histN = 0;
    for (const p of this.puffs) { p.sp.visible = false; p.t = 0; }
    this.clearMarks();
  }

  update(dt) {
    this._t += dt;
    if (this._markerOn) {
      const s = 1 + 0.18 * Math.sin(this._t * 9);
      this.marker.scale.setScalar(s);
    }
    if (this._burstT > 0) {
      this._burstT += dt;
      const k = this._burstT / 0.6;
      if (k >= 1) { this.burst.visible = false; this._burstT = 0; }
      else {
        this.burst.scale.setScalar((this._burstBig ? 0.4 : 0.25) + k * (this._burstBig ? 1.6 : 0.9));
        this.burstMat.opacity = 1 - k;
      }
    }
    if (this._aimOn) this.aim.scale.setScalar(1 + 0.08 * Math.sin(this._t * 12));
    const pulse = 0.6 + 0.2 * Math.sin(this._t * 3);
    this.targetMat.opacity = pulse;
    for (const p of this.puffs) {
      if (p.t <= 0) continue;
      p.t += dt;
      const k = p.t / 0.7;
      if (k >= 1) { p.sp.visible = false; p.t = 0; continue; }
      p.sp.position.x += p.vx * dt; p.sp.position.z += p.vz * dt; p.sp.position.y += 0.35 * dt;
      p.sp.scale.setScalar(0.3 + 0.9 * k);
      p.sp.material.opacity = 0.55 * (1 - k);
    }
  }
}
