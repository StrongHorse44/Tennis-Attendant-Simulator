import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxGeo, getGeometry, mergeParts, makeMatrix } from '../graphics/GeometryUtils.js';
import { sharedDepthMaterial } from '../graphics/Materials.js';

/**
 * Crowd impostors — seated figures for stands, shared by the Centre Court bowl (Stadium.js) and
 * the Junior Tour's other clubs (Venues.js).
 *
 * The geometry (cached, shared): a seated figure in two parts on ONE instance matrix — the shirt
 * (torso, sleeves, shorts over the thighs) and the skin (head on a neck, forearms resting on the
 * thighs, shins down to the tread) — so a crowd of any size is two draw calls, 144 triangles a
 * figure, instance colours only (the stadium seat material, `instancingColor` program). Origin =
 * the seat top, +z toward the court.
 *
 *   const crowd = new CrowdImpostors(root, spots, { material, name: 'VenueCrowd' });
 *   crowd.setFraction(0.6, true);   // show 60 % of the spots (the first ones: spots are best-first)
 *   crowd.cheer(1);                 // a short lift of every third figure
 *   crowd.update(dt);               // ramp + cheer (allocation-free)
 *   crowd.dispose();                // instance buffers only (the geometry is cached)
 */

export const CROWD_SHIRTS = [0xf4efe6, 0xe9dfc6, 0x2f3e5c, 0x8fae8b, 0x9cc3e0, 0xe8b4b8, 0xd9a441, 0x2d5a3d];
export const CROWD_SKINS = [0xf1c9a5, 0xd9a47e, 0xa8744f, 0x7a4f33];

const CHEER_TIME = 0.35;     // crowd lift duration (s)
const CROWD_RATE = 6;        // impostors added / removed per second while ramping

const _v3 = new THREE.Vector3();
const _col = new THREE.Color();
const _m4 = new THREE.Matrix4();

/** Deterministic hash of two integers → [0, 1). */
export function hashU(i, j) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A smooth-shaded low-poly ball: a dodecahedron (36 triangles) with radial normals. */
export function smoothBall(r) {
  const src = new THREE.DodecahedronGeometry(r, 0);
  src.deleteAttribute('normal');
  src.deleteAttribute('uv');
  const g = mergeVertices(src);
  src.dispose();
  const p = g.attributes.position, n = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    _v3.fromBufferAttribute(p, i).normalize();
    n[i * 3] = _v3.x; n[i * 3 + 1] = _v3.y; n[i * 3 + 2] = _v3.z;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return g;
}

/** Stand seat (tip-up chair on its tread, origin at the tread, +z toward the court); cached. */
export function stadiumSeatGeometry() {
  return getGeometry('stadium-seat', () => {
    const g = mergeParts([
      { geometry: boxGeo(0.46, 0.475, 0.4), matrix: makeMatrix(0, 0.2375, 0) },
      { geometry: boxGeo(0.46, 0.38, 0.05), matrix: makeMatrix(0, 0.475 + 0.19 * Math.cos(0.2094), -0.175 - 0.19 * Math.sin(0.2094), 0, 1, -0.2094) },
    ]);
    g.deleteAttribute('uv');
    return g;
  });
}

/** The seated figure's shirt part (torso, sleeves, shorts over the thighs); cached. */
export function crowdBodyGeometry() {
  return getGeometry('stadium-crowd-body', () => {
    const g = mergeParts([
      { geometry: boxGeo(0.38, 0.44, 0.24), matrix: makeMatrix(0, 0.31, -0.06) },       // torso, top at 0.53
      { geometry: boxGeo(0.34, 0.14, 0.4), matrix: makeMatrix(0, 0.07, 0.12) },         // thighs (shorts)
      { geometry: boxGeo(0.09, 0.26, 0.11), matrix: makeMatrix(-0.235, 0.4, -0.05) },   // sleeves
      { geometry: boxGeo(0.09, 0.26, 0.11), matrix: makeMatrix(0.235, 0.4, -0.05) },
    ]);
    g.deleteAttribute('uv');
    return g;
  });
}

/** The seated figure's skin part (head, neck, forearms, shins); cached. */
export function crowdHeadGeometry() {
  return getGeometry('stadium-crowd-head', () => {
    const g = mergeParts([
      { geometry: smoothBall(0.105), matrix: makeMatrix(0, 0.655, -0.05) },                       // head
      { geometry: boxGeo(0.09, 0.1, 0.09), matrix: makeMatrix(0, 0.55, -0.05) },                  // neck 0.50..0.60
      { geometry: boxGeo(0.07, 0.07, 0.25), matrix: makeMatrix(-0.2, 0.21, 0.08, 0, 1, 0.35) },   // forearms
      { geometry: boxGeo(0.07, 0.07, 0.25), matrix: makeMatrix(0.2, 0.21, 0.08, 0, 1, 0.35) },
      { geometry: boxGeo(0.1, 0.42, 0.1), matrix: makeMatrix(-0.09, -0.2, 0.27) },               // shins
      { geometry: boxGeo(0.1, 0.42, 0.1), matrix: makeMatrix(0.09, -0.2, 0.27) },
    ]);
    g.deleteAttribute('uv');
    return g;
  });
}

/**
 * A crowd on a list of seat spots (root-local { x, y: seat top, z, yaw }, best first). The count
 * ramps toward fraction × capacity (capacity ≤ spots) at CROWD_RATE a second, or jumps there.
 */
export class CrowdImpostors {
  /**
   * @param {THREE.Object3D} root
   * @param {Array<{x:number,y:number,z:number,yaw:number}>} spots  best first (they fill in order)
   * @param {object} o
   * @param {THREE.Material} o.material  an instanced, instance-coloured material (Stadium.seatMaterial())
   * @param {string} [o.name]
   * @param {number[]} [o.shirts] / [o.skins]  palettes
   * @param {number} [o.seed]
   * @param {THREE.Sphere} [o.bounds]  culling sphere (default: from the spots)
   */
  constructor(root, spots, o = {}) {
    const n = Math.max(1, spots.length);
    const shirts = o.shirts && o.shirts.length ? o.shirts : CROWD_SHIRTS;
    const skins = o.skins && o.skins.length ? o.skins : CROWD_SKINS;
    const seed = o.seed | 0;
    this.bodies = new THREE.InstancedMesh(crowdBodyGeometry(), o.material, n);
    this.heads = new THREE.InstancedMesh(crowdHeadGeometry(), o.material, n);
    this.heads.instanceMatrix = this.bodies.instanceMatrix;   // one upload serves both
    this.baseY = new Float32Array(n);
    const box = new THREE.Box3();
    spots.forEach((s, i) => {
      _m4.makeRotationY(s.yaw || 0).setPosition(s.x, s.y, s.z);
      this.bodies.setMatrixAt(i, _m4);
      this.baseY[i] = s.y;
      this.bodies.setColorAt(i, _col.set(shirts[Math.floor(hashU(i + seed, 11) * shirts.length)]));
      this.heads.setColorAt(i, _col.set(skins[Math.floor(hashU(i + seed, 13) * skins.length)]));
      box.expandByPoint(_v3.set(s.x, s.y, s.z));
    });
    if (!spots.length) {
      this.bodies.setColorAt(0, _col.set(0xffffff));
      this.heads.setColorAt(0, _col.set(0xffffff));
      box.expandByPoint(_v3.set(0, 0, 0));
    }
    const sphere = o.bounds || box.getBoundingSphere(new THREE.Sphere());
    if (!o.bounds) sphere.radius += 1.5;
    const name = o.name || 'Crowd';
    for (const [im, suffix] of [[this.bodies, 'Bodies'], [this.heads, 'Heads']]) {
      im.name = `${name}${suffix}`;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.receiveShadow = true;
      im.castShadow = false;
      im.customDepthMaterial = sharedDepthMaterial('instancedColor');
      im.boundingSphere = sphere;
      im.count = 0;
      im.visible = false;
      im.matrixAutoUpdate = false;
      im.userData.noMerge = true;
      root.add(im);
    }
    this.capacity = spots.length;
    this.count = 0;
    this.target = 0;
    this.frac = 0;
    this._acc = 0;
    this._cheerT = 0;
    this._cheerLift = 0;
    this._cheerOff = 0;
  }

  /** Show frac (0..1) of the spots, optionally capped (a tier's budget); instant: jump there. */
  setFraction(frac, instant = false, cap = Infinity) {
    this.frac = Math.max(0, Math.min(1, Number(frac) || 0));
    this.target = Math.min(this.capacity, cap, Math.round(this.frac * this.capacity));
    if (instant) this._setCount(this.target);
  }

  /** Show exactly n figures (the first n spots) now. */
  setCount(n) {
    this.target = Math.max(0, Math.min(this.capacity, n | 0));
    this._setCount(this.target);
  }

  /** A short lift of every third figure (0..1); allocation-free. */
  cheer(strength) {
    if (this.count === 0) return;
    if (this._cheerT > 0) this._cheerApply(0);   // settle the last one first
    this._cheerOff = (this._cheerOff + 1) % 3;
    this._cheerLift = 0.12 * Math.max(0, Math.min(1, Number(strength) || 0));
    this._cheerT = CHEER_TIME;
  }

  set castShadow(on) {
    this.bodies.castShadow = this.heads.castShadow = !!on;
  }

  /** Ramp toward the target, run the cheer (per frame, allocation-free). */
  update(dt) {
    if (!(dt > 0)) return;
    if (this.count !== this.target) {
      this._acc += dt * CROWD_RATE;
      if (this._acc >= 1) {
        const step = Math.floor(this._acc);
        this._acc -= step;
        this._setCount(this.count < this.target ? Math.min(this.target, this.count + step) : Math.max(this.target, this.count - step));
      }
    } else {
      this._acc = 0;
    }
    if (this._cheerT > 0) {
      this._cheerT -= dt;
      if (this._cheerT <= 0) this._cheerApply(0);
      else this._cheerApply(this._cheerLift * Math.sin(Math.PI * (1 - this._cheerT / CHEER_TIME)));
    }
  }

  _setCount(n) {
    n = Math.max(0, Math.min(this.capacity, n | 0));
    if (n === this.count) return;
    if (this._cheerT > 0) this._cheerApply(0);
    this.count = n;
    this.bodies.count = n;
    this.heads.count = n;
    this.bodies.visible = this.heads.visible = n > 0;
  }

  _cheerApply(lift) {
    const arr = this.bodies.instanceMatrix.array, base = this.baseY;
    for (let i = this._cheerOff; i < this.count; i += 3) arr[i * 16 + 13] = base[i] + lift;
    this.bodies.instanceMatrix.needsUpdate = true;
    if (lift === 0) this._cheerT = 0;
  }

  /** Free the instance buffers (the geometry and material are shared). */
  dispose() {
    for (const im of [this.bodies, this.heads]) {
      if (im.parent) im.parent.remove(im);
      im.dispose();
    }
  }
}
