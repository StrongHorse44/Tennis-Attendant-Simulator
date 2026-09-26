import * as THREE from 'three';
import { getMaterial } from '../graphics/Materials.js';
import { getGeometry } from '../graphics/GeometryUtils.js';

/**
 * TennisFX — flat court overlays for the after-hours mode: the landing marker for the
 * incoming ball (optional aid), drill target rings, and a small burst ring where a drill
 * shot lands. A handful of unlit meshes (≤ 6 draw calls, only while the mode runs), with
 * shared geometries and per-role materials; nothing allocates per frame.
 */

const MAX_TARGETS = 3;
const Y_OFF = 0.02; // above the court surface (no z-fighting)

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
    this.burstMat = getMaterial('tennisBurstMat', () => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false, fog: false }));
    this.burst = flatMesh(burst, this.burstMat, 5);
    this.root.add(this.burst);
    this._burstT = 0;
    this._t = 0;
    this._markerOn = false;
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
    for (const m of this.targets) m.visible = false;
    this.burst.visible = false;
    this._burstT = 0;
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
    const pulse = 0.6 + 0.2 * Math.sin(this._t * 3);
    this.targetMat.opacity = pulse;
  }
}
