import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sharedDepthMaterial } from './Materials.js';

/**
 * GeometryUtils — geometry caches, static-mesh merging and instancing helpers.
 *
 *   import { roundedBox, getGeometry, mergeStaticMeshes, createInstanced } from '../graphics/GeometryUtils.js';
 *   const g = roundedBox(1, 0.5, 1, 0.08);                  // cached RoundedBoxGeometry
 *   const cone = getGeometry('treeCone', () => new THREE.ConeGeometry(1, 2, 7));
 *   mergeStaticMeshes(courtGroup);                           // N meshes -> 1 mesh per material
 *   createInstanced(geo, mat, [{ position:[x,0,z], rotationY:1.2, scale:1.1 }], { castShadow:true });
 */

const _geoCache = new Map();

/** Named geometry cache. Returned geometries are shared: do not mutate/dispose them. */
export function getGeometry(key, factory) {
  let g = _geoCache.get(key);
  if (!g) {
    g = factory();
    _geoCache.set(key, g);
  }
  return g;
}

/**
 * Cached rounded box (bevelled box). Radius is clamped to half the smallest side.
 * @returns {THREE.BufferGeometry}
 */
export function roundedBox(w, h, d, r = 0.06, segments = 2) {
  const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  const key = `rbox|${w}|${h}|${d}|${rr}|${segments}`;
  return getGeometry(key, () => new RoundedBoxGeometry(w, h, d, segments, Math.max(rr, 0.001)));
}

/** Cached simple primitives (shared). */
export function boxGeo(w, h, d) {
  return getGeometry(`box|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d));
}
export function cylinderGeo(rt, rb, h, seg = 12, open = false) {
  return getGeometry(`cyl|${rt}|${rb}|${h}|${seg}|${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
}
export function sphereGeo(r, ws = 12, hs = 8) {
  return getGeometry(`sph|${r}|${ws}|${hs}`, () => new THREE.SphereGeometry(r, ws, hs));
}
export function coneGeo(r, h, seg = 8) {
  return getGeometry(`cone|${r}|${h}|${seg}`, () => new THREE.ConeGeometry(r, h, seg));
}
export function icoGeo(r, detail = 0) {
  return getGeometry(`ico|${r}|${detail}`, () => new THREE.IcosahedronGeometry(r, detail));
}

const _tmpMat = new THREE.Matrix4();
const _invRoot = new THREE.Matrix4();
const _cv = new THREE.Vector3();

/** Grid cell ('ix,iz') of a mesh's world bounding-sphere centre, or 'big' if it spans > a cell. */
function cellKey(o, cellSize) {
  const g = o.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  const bs = g.boundingSphere;
  if (bs.radius * o.matrixWorld.getMaxScaleOnAxis() > cellSize) return 'big';
  _cv.copy(bs.center).applyMatrix4(o.matrixWorld);
  return `${Math.floor(_cv.x / cellSize)},${Math.floor(_cv.z / cellSize)}`;
}

/** Grid cell key for an x/z position. */
export function gridCellKey(x, z, cellSize) {
  return `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
}

function normaliseForMerge(geo, wantUv, wantColor, indexed) {
  let g = geo;
  // Keep only the attributes we can merge consistently
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const count = g.attributes.position.count;
  if (wantUv && !g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  if (!wantUv && g.attributes.uv) g.deleteAttribute('uv');
  if (wantColor && !g.attributes.color) {
    const c = new Float32Array(count * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (!wantColor && g.attributes.color) g.deleteAttribute('color');
  if (g.attributes.color && g.attributes.color.itemSize !== 3) g.deleteAttribute('color');
  if (indexed && !g.index) {
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!indexed && g.index) g = g.toNonIndexed();
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/**
 * Merge all static child meshes of `root` into one mesh per (material, castShadow, receiveShadow).
 * World transforms are baked relative to `root`, and the merged meshes are added to `root`.
 * Skips: InstancedMesh, SkinnedMesh, multi-material meshes, sprites/points/lines, objects with
 * userData.noMerge / userData.dynamic (or inside such a parent), and invisible meshes.
 * Call AFTER the group is positioned and its children are final (before adding physics is fine).
 *
 * @param {THREE.Object3D} root
 * @param {object} [opts]
 * @param {(mesh:THREE.Mesh)=>boolean} [opts.filter]  return false to keep a mesh unmerged
 * @param {number} [opts.minCount=2]  only merge groups with at least this many meshes
 * @param {number} [opts.cellSize=0]  > 0: also group by world-space grid cell (x/z) of each
 *   mesh's bounding-sphere centre, so merged meshes stay spatially compact and can be
 *   frustum-culled by the camera and the shadow camera (meshes larger than a cell share
 *   one 'big' group).
 * @returns {{ merged: THREE.Mesh[], removed: number }}
 */
export function mergeStaticMeshes(root, opts = {}) {
  const { filter, minCount = 2, cellSize = 0 } = opts;
  root.updateMatrixWorld(true);
  _invRoot.copy(root.matrixWorld).invert();

  const groups = new Map();
  const skipBranch = new Set();
  root.traverse((o) => {
    if (o !== root && (o.userData.noMerge || o.userData.dynamic)) skipBranch.add(o);
  });
  const inSkipped = (o) => {
    let p = o;
    while (p && p !== root) { if (skipBranch.has(p)) return true; p = p.parent; }
    return false;
  };

  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return;
    if (Array.isArray(o.material) || !o.visible || !o.geometry || !o.geometry.attributes.position) return;
    if (o.morphTargetInfluences && o.morphTargetInfluences.length) return;
    if (inSkipped(o)) return;
    if (filter && filter(o) === false) return;
    let k = `${o.material.uuid}|${o.castShadow ? 1 : 0}|${o.receiveShadow ? 1 : 0}|${o.renderOrder}`;
    if (cellSize > 0) k += '|' + cellKey(o, cellSize);
    let arr = groups.get(k);
    if (!arr) { arr = []; groups.set(k, arr); }
    arr.push(o);
  });

  const merged = [];
  let removed = 0;
  for (const meshes of groups.values()) {
    if (meshes.length < minCount) continue;
    const wantUv = meshes.some(m => m.geometry.attributes.uv);
    const wantColor = meshes.some(m => m.geometry.attributes.color);
    const indexed = meshes.some(m => m.geometry.index);
    const geos = [];
    for (const m of meshes) {
      const g = m.geometry.clone();
      _tmpMat.multiplyMatrices(_invRoot, m.matrixWorld);
      g.applyMatrix4(_tmpMat);
      // Mirrored transforms flip winding — fix so faces don't vanish
      if (_tmpMat.determinant() < 0 && g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
      }
      geos.push(normaliseForMerge(g, wantUv, wantColor, indexed));
    }
    const mg = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!mg) continue;
    mg.computeBoundingSphere();
    mg.computeBoundingBox();
    const first = meshes[0];
    const mesh = new THREE.Mesh(mg, first.material);
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    mesh.name = `merged:${first.material.name || first.material.type}`;
    mesh.userData.merged = meshes.length;
    for (const m of meshes) {
      m.parent && m.parent.remove(m);
      removed++;
    }
    root.add(mesh);
    merged.push(mesh);
  }
  // Drop now-empty plain groups
  const empties = [];
  root.traverse((o) => { if (o !== root && o.type === 'Group' && o.children.length === 0) empties.push(o); });
  for (const e of empties) e.parent && e.parent.remove(e);
  return { merged, removed };
}

const _obj = new THREE.Object3D();
const _col = new THREE.Color();

/**
 * Build an InstancedMesh from a list of transforms.
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material
 * @param {Array<{position:number[]|THREE.Vector3, rotationY?:number, rotation?:number[]|THREE.Euler,
 *                scale?:number|number[]|THREE.Vector3, color?:number|THREE.Color}>} items
 * @param {object} [opts] { castShadow, receiveShadow, frustumCulled=true, name }
 * @returns {THREE.InstancedMesh}
 */
export function createInstanced(geometry, material, items, opts = {}) {
  const im = new THREE.InstancedMesh(geometry, material, Math.max(1, items.length));
  im.count = items.length;
  let hasColor = false;
  items.forEach((it, i) => {
    const p = it.position;
    if (Array.isArray(p)) _obj.position.set(p[0], p[1], p[2]); else _obj.position.copy(p);
    if (it.rotation) {
      if (Array.isArray(it.rotation)) _obj.rotation.set(it.rotation[0], it.rotation[1], it.rotation[2]);
      else _obj.rotation.copy(it.rotation);
    } else {
      _obj.rotation.set(0, it.rotationY || 0, 0);
    }
    const s = it.scale ?? 1;
    if (typeof s === 'number') _obj.scale.setScalar(s);
    else if (Array.isArray(s)) _obj.scale.set(s[0], s[1], s[2]);
    else _obj.scale.copy(s);
    _obj.updateMatrix();
    im.setMatrixAt(i, _obj.matrix);
    if (it.color !== undefined) {
      hasColor = true;
      im.setColorAt(i, _col.set(it.color));
    }
  });
  if (hasColor) {
    // fill missing colours with white
    items.forEach((it, i) => { if (it.color === undefined) im.setColorAt(i, _col.set(0xffffff)); });
    im.instanceColor.needsUpdate = true;
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = !!opts.castShadow;
  im.receiveShadow = !!opts.receiveShadow;
  if (im.castShadow) im.customDepthMaterial = sharedDepthMaterial(hasColor ? 'instancedColor' : 'instanced');
  if (opts.frustumCulled === false) im.frustumCulled = false;
  if (opts.name) im.name = opts.name;
  im.computeBoundingSphere();
  return im;
}

/**
 * createInstanced, bucketed by world grid cell (x/z of each item's position): one
 * InstancedMesh per occupied cell, each with a tight bounding sphere so the camera and
 * the shadow camera can cull it (one map-wide InstancedMesh is never culled).
 * Returns a Group whose children are the bucket meshes (child.userData.maxCount = items).
 */
export function createInstancedBuckets(geometry, material, items, opts = {}, cellSize = 32) {
  const buckets = new Map();
  for (const it of items) {
    const p = it.position;
    const x = Array.isArray(p) ? p[0] : p.x, z = Array.isArray(p) ? p[2] : p.z;
    const k = gridCellKey(x, z, cellSize);
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    b.push(it);
  }
  const group = new THREE.Group();
  group.name = opts.name || 'Instanced';
  for (const [k, list] of buckets) {
    const im = createInstanced(geometry, material, list, { ...opts, name: `${opts.name || 'Instanced'}@${k}` });
    im.userData.maxCount = list.length;
    group.add(im);
  }
  return group;
}

/**
 * Merge an array of {geometry, matrix} pieces into a single BufferGeometry (e.g. build one
 * tree geometry from trunk + canopy). Pieces are cloned; attributes are normalised.
 * @param {Array<{geometry:THREE.BufferGeometry, matrix?:THREE.Matrix4, color?:number}>} parts
 *   `color` (optional) bakes a vertex colour into that part (use material.vertexColors = true).
 */
export function mergeParts(parts) {
  const wantColor = parts.some(p => p.color !== undefined);
  const geos = parts.map((p) => {
    const g = p.geometry.clone();
    if (p.matrix) g.applyMatrix4(p.matrix);
    if (wantColor) {
      _col.set(p.color ?? 0xffffff);
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    return normaliseForMerge(g, parts.some(pp => pp.geometry.attributes.uv), wantColor, true);
  });
  const out = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  out.computeBoundingSphere();
  return out;
}

/** Convenience: Matrix4 from position / euler(y) / uniform-or-vector scale. */
export function makeMatrix(x = 0, y = 0, z = 0, ry = 0, s = 1, rx = 0, rz = 0) {
  _obj.position.set(x, y, z);
  _obj.rotation.set(rx, ry, rz);
  if (typeof s === 'number') _obj.scale.setScalar(s); else _obj.scale.set(s[0], s[1], s[2]);
  _obj.updateMatrix();
  return _obj.matrix.clone();
}
