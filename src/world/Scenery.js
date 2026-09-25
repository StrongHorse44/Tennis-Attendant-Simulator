import * as THREE from 'three';
import { EnvState } from '../graphics/EnvState.js';
import { Quality } from '../graphics/Quality.js';
import { Textures, hash2 } from '../graphics/Textures.js';
import { getMaterial, registerNightGlow } from '../graphics/Materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  getGeometry, cylinderGeo, coneGeo, sphereGeo, boxGeo, roundedBox,
  mergeParts, makeMatrix, createInstanced, createInstancedBuckets, gridCellKey,
} from '../graphics/GeometryUtils.js';

/**
 * World grid cells for instance bucketing (tight bounds → camera + shadow-camera culling;
 * the sun shadow frustum is ~±32 m). Bigger cells for cheap / sparse kinds keep the draw
 * count down; far backdrop (LOD) trees are one bucket per large cell.
 */
const CELL = 48;          // shadow-casting trees
const CELL_SPARSE = 64;   // grass tufts, flowers (no shadow casting), benches, lamps
const CELL_LOD = 160;     // backdrop trees (no shadows)

/**
 * Scenery — batched, instanced environment decoration shared by World and Garden.
 *
 *   const s = new Scenery(scene);
 *   s.addTree('oak', x, y, z, { scale, rotY, shadow, lod });
 *   s.addBlob(x, y, z, radius);                 // fake contact shadow
 *   s.addFlowerClump(x, y, z, color, scale);    // leafy mound + blooms
 *   s.addTuft(x, y, z, scale);                  // grass tuft (density follows Quality)
 *   s.addBench(x, y, z, rotY);                  // teak & iron garden bench
 *   s.addLamp(x, y, z, { post:true });          // lamp post (or a lantern only, post:false)
 *   s.build();                                  // creates the instanced meshes (call once)
 *   s.update();                                 // per frame: wind sway + lamp glow (no allocations)
 *
 * Everything collected here becomes ONE InstancedMesh per kind, so the whole club's
 * trees / benches / lamps / flowers cost a handful of draw calls.
 */

// ───────────────────────────── Wind sway ─────────────────────────────

const windUniforms = {
  uSwayTime: { value: 0 },
  uSwayWind: { value: 0.15 },
  uSwayDir: { value: new THREE.Vector2(1, 0) },
};

/**
 * Patch a material so its vertices sway with the wind. Displacement grows with local
 * height (trunk bases stay put). Works for instanced and plain meshes.
 * @param {THREE.Material} material  a material owned by the caller (not a shared mat())
 * @param {number} amount   sway amplitude (world units per unit height²)
 * @param {string} key      program cache key
 */
export function applyWindSway(material, amount, key) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSwayTime = windUniforms.uSwayTime;
    shader.uniforms.uSwayWind = windUniforms.uSwayWind;
    shader.uniforms.uSwayDir = windUniforms.uSwayDir;
    shader.vertexShader = 'uniform float uSwayTime;\nuniform float uSwayWind;\nuniform vec2 uSwayDir;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        float swH = max(transformed.y, 0.0);
        vec3 swIp = vec3(0.0);
        vec3 swDir = vec3(uSwayDir.x, 0.0, uSwayDir.y);
        #ifdef USE_INSTANCING
          swIp = instanceMatrix[3].xyz;
          swDir = normalize(swDir * mat3(instanceMatrix) + vec3(1e-5, 0.0, 0.0));
        #endif
        float swPh = swIp.x * 0.37 + swIp.z * 0.61;
        float swS = sin(uSwayTime * 1.7 + swPh) * 0.65 + sin(uSwayTime * 3.1 + swPh * 1.9) * 0.35;
        float swAmp = ${amount.toFixed(4)} * swH * swH * uSwayWind;
        transformed.xz += swDir.xz * (swS * 0.6 + uSwayWind * 0.5) * swAmp;
        transformed.x += sin(uSwayTime * 4.3 + swPh * 2.3 + transformed.y * 3.0) * swAmp * 0.12;
      }`);
  };
  material.customProgramCacheKey = () => 'sway-' + key;
  return material;
}

/** Update the shared wind uniforms from EnvState (called by Scenery.update). */
export function updateWindUniforms() {
  windUniforms.uSwayTime.value = EnvState.time;
  windUniforms.uSwayWind.value = EnvState.windStrength;
  const d = EnvState.windDirection;
  if (d) windUniforms.uSwayDir.value.set(d.x, d.z);
}

// ───────────────────────────── Geometry helpers ─────────────────────────────

/**
 * Like GeometryUtils.mergeParts, but parts WITHOUT a `color` keep their existing vertex
 * colours (pre-coloured sub-assemblies such as a table set). Drops UVs; output is indexed.
 * @param {Array<{geometry, matrix?, color?}>} parts
 */
export function bakeParts(parts) {
  const geos = parts.map((p) => {
    let g = p.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
    if (p.matrix) g.applyMatrix4(p.matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    if (p.color !== undefined || !g.attributes.color || g.attributes.color.itemSize !== 3) {
      _c.set(p.color ?? 0xffffff);
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = _c.r; c[i * 3 + 1] = _c.g; c[i * 3 + 2] = _c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    if (!g.index) {
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    g.morphAttributes = {};
    g.clearGroups();
    return g;
  });
  const out = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  out.computeBoundingSphere();
  return out;
}

const _c = new THREE.Color();

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Icosahedron with deterministic lumps (vertices displaced by a hash of their position, so no cracks). */
export function lumpyIco(r, detail = 1, seed = 1, amount = 0.14) {
  return getGeometry(`lumpyIco|${r}|${detail}|${seed}|${amount}`, () => {
    const g = new THREE.IcosahedronGeometry(r, detail);
    g.deleteAttribute('uv');
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const qx = Math.round(x * 1000), qy = Math.round(y * 1000), qz = Math.round(z * 1000);
      const h = hash2(qx + qz * 7, qy, seed);
      const k = 1 + (h - 0.5) * 2 * amount;
      p.setXYZ(i, x * k, y * k, z * k);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** Multiply vertex colours by a vertical gradient (dark base -> bright top): cheap fake AO. */
function shadeByHeight(geo, lo = 0.7, hi = 1.12, y0 = null, y1 = null) {
  geo.computeBoundingBox();
  const a = y0 ?? geo.boundingBox.min.y, b = y1 ?? geo.boundingBox.max.y;
  const p = geo.attributes.position, c = geo.attributes.color;
  if (!c) return geo;
  for (let i = 0; i < p.count; i++) {
    const t = smoothstep(a, b, p.getY(i));
    const k = lo + (hi - lo) * t;
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  c.needsUpdate = true;
  return geo;
}

function P(geometry, matrix, color) { return { geometry, matrix, color }; }

const BARK = 0x6b4b34;

/** Tree geometries per species and LOD (cached). Local origin at the trunk base. */
export function treeGeometry(species, lod = false) {
  return getGeometry(`tree|${species}|${lod ? 1 : 0}`, () => {
    const parts = [];
    let g;
    if (species === 'oak') {
      parts.push(P(cylinderGeo(0.15, 0.26, 2.5, lod ? 5 : 7), makeMatrix(0, 1.25, 0), BARK));
      if (!lod) {
        parts.push(P(cylinderGeo(0.06, 0.1, 1.3, 5), makeMatrix(0.42, 2.2, 0.05, 0, 1, 0, -0.75), BARK));
        parts.push(P(cylinderGeo(0.05, 0.09, 1.1, 5), makeMatrix(-0.35, 2.3, -0.1, 0.6, 1, 0.2, 0.7), BARK));
        const blobs = [
          [0, 3.35, 0, 1.55, 0x4d8a3b], [1.05, 2.95, 0.3, 1.12, 0x5a9844], [-0.95, 3.05, -0.3, 1.18, 0x467f36],
          [0.2, 4.2, -0.15, 1.05, 0x69a84e], [-0.3, 2.85, 0.95, 1.0, 0x518f3e], [0.45, 3.0, -0.95, 0.98, 0x5e9c47],
        ];
        blobs.forEach(([x, y, z, r, col], i) => parts.push(P(lumpyIco(1, 1, 3 + i), makeMatrix(x, y, z, i, [r, r * 0.88, r]), col)));
      } else {
        parts.push(P(lumpyIco(1, 0, 3), makeMatrix(0, 3.3, 0, 0, [1.8, 1.5, 1.8]), 0x4f8c3d));
        parts.push(P(lumpyIco(1, 0, 4), makeMatrix(0.3, 4.1, -0.2, 1, [1.1, 0.95, 1.1]), 0x62a049));
      }
      g = mergeParts(parts);
      shadeByHeight(g, 0.62, 1.12, 0.5, 4.8);
    } else if (species === 'pine') {
      parts.push(P(cylinderGeo(0.12, 0.2, 1.6, 6), makeMatrix(0, 0.8, 0), BARK));
      const tiers = lod
        ? [[1.8, 2.8, 2.1, 0x315f3c], [1.1, 2.2, 3.9, 0x3d7349]]
        : [[1.75, 2.2, 1.9, 0x2e5b39], [1.4, 2.0, 2.9, 0x336442], [1.05, 1.7, 3.8, 0x3a6e48], [0.62, 1.3, 4.6, 0x447a50]];
      tiers.forEach(([r, h, y, col], i) => parts.push(P(coneGeo(1, 1, lod ? 6 : 8), makeMatrix(0, y, 0, i * 0.7, [r, h, r]), col)));
      g = mergeParts(parts);
      shadeByHeight(g, 0.6, 1.15, 0.3, 5.3);
    } else if (species === 'blossom') {
      parts.push(P(cylinderGeo(0.09, 0.15, 1.4, 6), makeMatrix(0, 0.7, 0), 0x5e4535));
      parts.push(P(cylinderGeo(0.05, 0.08, 1.1, 5), makeMatrix(0.3, 1.6, 0, 0, 1, 0, -0.55), 0x5e4535));
      parts.push(P(cylinderGeo(0.05, 0.08, 1.1, 5), makeMatrix(-0.28, 1.6, 0.1, 0, 1, 0.2, 0.6), 0x5e4535));
      const blobs = lod
        ? [[0, 2.3, 0, 1.4, 0xf2a7bd]]
        : [[0, 2.35, 0, 1.15, 0xf2a7bd], [0.8, 2.15, 0.2, 0.85, 0xf7c0cf], [-0.75, 2.2, -0.25, 0.9, 0xe98fab],
          [0.1, 2.85, -0.2, 0.8, 0xfbd3de], [-0.2, 2.1, 0.75, 0.75, 0xee9fb6]];
      blobs.forEach(([x, y, z, r, col], i) => parts.push(P(lumpyIco(1, lod ? 0 : 1, 20 + i), makeMatrix(x, y, z, i, [r, r * 0.72, r]), col)));
      g = mergeParts(parts);
      shadeByHeight(g, 0.8, 1.08, 0.4, 3.4); // keep shaded undersides pink, not lavender
    } else {
      // cypress (columnar)
      parts.push(P(cylinderGeo(0.1, 0.15, 0.8, 5), makeMatrix(0, 0.4, 0), BARK));
      parts.push(P(lumpyIco(1, lod ? 0 : 1, 31, 0.1), makeMatrix(0, 2.3, 0, 0, [0.72, 2.1, 0.72]), 0x2f5a39));
      parts.push(P(lumpyIco(1, 0, 32, 0.1), makeMatrix(0, 3.9, 0, 0.5, [0.42, 0.8, 0.42]), 0x3a6a43));
      g = mergeParts(parts);
      shadeByHeight(g, 0.62, 1.12, 0.2, 4.6);
    }
    g.deleteAttribute('uv');
    g.computeBoundingSphere();
    return g;
  });
}

/** Grass tuft: 7 blades, vertex colours dark base -> light tip, normals up (shades like the lawn). */
function tuftGeometry() {
  return getGeometry('scenery-tuft', () => {
    const pos = [], col = [], nor = [];
    const base = new THREE.Color(0x538f3f), tip = new THREE.Color(0x92c466);
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + hash2(i, 1, 5) * 0.8;
      const r = 0.03 + hash2(i, 2, 5) * 0.05;
      const h = 0.2 + hash2(i, 3, 5) * 0.2;
      const lean = 0.05 + hash2(i, 4, 5) * 0.1;
      const cx = Math.cos(a), sz = Math.sin(a);
      const px = -sz * 0.028, pz = cx * 0.028; // blade half-width, perpendicular
      const bx = cx * r, bz = sz * r;
      pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + cx * lean, h, bz + sz * lean);
      col.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
      nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
  });
}

/** Teak & iron garden bench, facing +Z, 1.8 m long. */
export function benchGeometry() {
  return getGeometry('scenery-bench', () => {
    const teak = 0xb07a48, iron = 0x2a2f2b;
    const parts = [];
    for (let i = 0; i < 4; i++) parts.push(P(roundedBox(1.8, 0.05, 0.11, 0.02), makeMatrix(0, 0.45, -0.18 + i * 0.125), teak));
    for (let i = 0; i < 3; i++) parts.push(P(roundedBox(1.8, 0.09, 0.04, 0.015), makeMatrix(0, 0.64 + i * 0.13, -0.3 - i * 0.03, 0, 1, -0.2), teak));
    for (const sx of [-0.84, 0.84]) {
      parts.push(P(boxGeo(0.06, 0.44, 0.06), makeMatrix(sx, 0.22, 0.2), iron));
      parts.push(P(boxGeo(0.06, 0.95, 0.06), makeMatrix(sx, 0.47, -0.3, 0, 1, -0.12), iron));
      parts.push(P(roundedBox(0.08, 0.05, 0.6, 0.02), makeMatrix(sx, 0.68, -0.03), iron));
      parts.push(P(boxGeo(0.05, 0.05, 0.5), makeMatrix(sx, 0.4, -0.05), iron));
    }
    const g = mergeParts(parts);
    g.deleteAttribute('uv');
    return g;
  });
}

/** Lamp post pole (no lantern). Height 2.85, lantern sits on top. */
function lampPostGeometry() {
  return getGeometry('scenery-lampPost', () => {
    const iron = 0x222925;
    const g = mergeParts([
      P(cylinderGeo(0.13, 0.17, 0.32, 8), makeMatrix(0, 0.16, 0), iron),
      P(cylinderGeo(0.09, 0.13, 0.12, 8), makeMatrix(0, 0.38, 0), iron),
      P(cylinderGeo(0.045, 0.06, 2.3, 8), makeMatrix(0, 1.57, 0), iron),
      P(cylinderGeo(0.08, 0.05, 0.12, 8), makeMatrix(0, 2.78, 0), iron),
    ]);
    g.deleteAttribute('uv');
    return g;
  });
}

/** Lantern frame (iron) — local origin at the lantern bottom. */
function lanternFrameGeometry() {
  return getGeometry('scenery-lanternFrame', () => {
    const iron = 0x222925;
    const parts = [
      P(cylinderGeo(0.17, 0.1, 0.07, 4), makeMatrix(0, 0.03, 0, Math.PI / 4), iron),
      P(coneGeo(0.26, 0.2, 4), makeMatrix(0, 0.52, 0, Math.PI / 4), iron),
      P(sphereGeo(0.045, 6, 4), makeMatrix(0, 0.66, 0), iron),
    ];
    for (const sx of [-0.12, 0.12]) for (const sz of [-0.12, 0.12]) parts.push(P(boxGeo(0.03, 0.4, 0.03), makeMatrix(sx, 0.25, sz), iron));
    const g = mergeParts(parts);
    g.deleteAttribute('uv');
    return g;
  });
}

function lanternGlassGeometry() {
  return getGeometry('scenery-lanternGlass', () => {
    const g = boxGeo(0.21, 0.36, 0.21).clone();
    g.translate(0, 0.25, 0);
    return g;
  });
}

// ───────────────────────────── Shared materials ─────────────────────────────

function treeMaterial() {
  return getMaterial('scenery-tree', () => applyWindSway(new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.92,
  }), 0.006, 'tree'));
}

function grassMaterial() {
  return getMaterial('scenery-grass', () => applyWindSway(new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, side: THREE.DoubleSide,
  }), 1.1, 'grass'));
}

/**
 * Instanced props get their OWN material instance: sharing one material between
 * InstancedMesh and plain (merged) meshes flips its program every draw.
 */
function propMaterial() {
  return getMaterial('scenery-prop-inst', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
}

/** Warm lamp glass that lights up at dusk (shared with World's gate lanterns). */
export function lampGlassMaterial(instanced = false) {
  return getMaterial(instanced ? 'scenery-lampGlass-inst' : 'scenery-lampGlass', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0xf2e6c8, emissive: 0xffb45a, roughness: 0.25 });
    registerNightGlow(m, 2.6, 0);
    return m;
  });
}

// ───────────────────────────── Scenery batch ─────────────────────────────

const TREE_TINTS = {
  oak: [0xffffff, 0xf2fff0, 0xfff8e6, 0xe8f4e0, 0xfffbe0],
  pine: [0xffffff, 0xeef8f2, 0xf6fff4],
  blossom: [0xf4f4f4, 0xfff4f8, 0xf8f0ff, 0xf0f6ee],
  cypress: [0xffffff, 0xeef6ee],
};

export class Scenery {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'Scenery';
    this.trees = {};           // key -> items
    this.blobs = [];
    this.clumps = [];
    this.heads = [];
    this.tufts = [];
    this.benches = [];
    this.lamps = [];           // { x, y, z, post }
    this.bulbs = [];           // string-light bulbs
    this.meshes = {};
    this._lastLamp = -1;
    this._tuftMax = 0;
    this._built = false;
  }

  /**
   * @param {'oak'|'pine'|'blossom'|'cypress'} species
   * @param {object} [o] { scale=1, rotY, shadow=true, lod=false, tint }
   */
  addTree(species, x, y, z, o = {}) {
    const lod = !!o.lod;
    const shadow = o.shadow !== false && !lod;
    const key = `${species}|${lod ? 1 : 0}|${shadow ? 1 : 0}`;
    (this.trees[key] ||= { species, lod, shadow, items: [] }).items.push({
      position: [x, y, z],
      rotationY: o.rotY ?? hash2(Math.round(x * 10), Math.round(z * 10), 7) * Math.PI * 2,
      scale: o.scale ?? 1,
      color: o.tint ?? TREE_TINTS[species][(hash2(Math.round(x), Math.round(z), 3) * TREE_TINTS[species].length) | 0],
    });
    if (!lod) this.addBlob(x, y, z, 1.6 * (o.scale ?? 1) * (species === 'cypress' ? 0.6 : 1));
  }

  /** Soft dark blob on the ground (fake contact shadow). */
  addBlob(x, y, z, radius) {
    this.blobs.push({ position: [x, y + 0.012, z], rotation: [-Math.PI / 2, 0, 0], scale: [radius * 2, radius * 2, 1] });
  }

  /** Leafy mound with 4–6 blooms of roughly `color`. */
  addFlowerClump(x, y, z, color, scale = 1) {
    const h = (k) => hash2(Math.round(x * 97), Math.round(z * 97), k);
    this.clumps.push({
      position: [x, y, z],
      rotationY: h(1) * 6.28,
      scale: [scale * (0.9 + h(2) * 0.3), scale * (0.8 + h(3) * 0.4), scale * (0.9 + h(4) * 0.3)],
      color: _c.setHSL(0.28 + h(5) * 0.06, 0.45, 0.28 + h(6) * 0.08).getHex(),
      nHeads: 0,
    });
    const n = 4 + ((h(7) * 3) | 0);
    this.clumps[this.clumps.length - 1].nHeads = n;
    const base = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.28 + h(10 + i) * 1.2;
      const r = (0.08 + h(20 + i) * 0.12) * scale;
      const c = base.clone().offsetHSL((h(30 + i) - 0.5) * 0.04, 0, (h(40 + i) - 0.5) * 0.14);
      this.heads.push({
        position: [x + Math.cos(a) * r, y + (0.2 + h(50 + i) * 0.1) * scale, z + Math.sin(a) * r],
        rotation: [h(60 + i) - 0.5, h(70 + i) * 6, 0],
        scale: (0.8 + h(80 + i) * 0.5) * scale,
        color: c.getHex(),
      });
    }
  }

  addTuft(x, y, z, scale = 1) {
    const h = hash2(Math.round(x * 53), Math.round(z * 53), 9);
    this.tufts.push({
      position: [x, y, z],
      rotationY: h * 6.28,
      scale: [scale, scale * (0.8 + h * 0.5), scale],
      color: _c.setHSL(0.25 + h * 0.05, 0.35 + h * 0.2, 0.9 + h * 0.1).getHex(),
    });
  }

  addBench(x, y, z, rotY = 0) {
    this.benches.push({ position: [x, y, z], rotationY: rotY });
    this.addBlob(x, y, z, 1.05);
  }

  /** Lamp post (post:true) or a lantern alone sitting at height y (post:false). */
  addLamp(x, y, z, o = {}) {
    this.lamps.push({ x, y, z, post: o.post !== false });
  }

  /** A small festoon bulb (string lights); glows at dusk. */
  addBulb(x, y, z) {
    this.bulbs.push({ position: [x, y, z] });
  }

  /** Create all instanced meshes and add them to the scene. */
  build() {
    if (this._built) return;
    this._built = true;
    const tm = treeMaterial();
    this._treeGroups = [];
    for (const k of Object.keys(this.trees)) {
      const t = this.trees[k];
      const g = createInstancedBuckets(treeGeometry(t.species, t.lod), tm, t.items, {
        castShadow: t.shadow, receiveShadow: !t.lod, name: `Trees:${k}`,
      }, t.lod ? CELL_LOD : CELL);
      this.root.add(g);
      this.meshes['tree:' + k] = g;
      if (!t.lod) this._treeGroups.push({ group: g, species: t.species });
    }

    if (this.blobs.length) {
      const blobGeo = getGeometry('scenery-blobPlane', () => new THREE.PlaneGeometry(1, 1));
      const blobMat = getMaterial('scenery-blob', () => new THREE.MeshBasicMaterial({
        color: 0x0b1a08, map: Textures.radialBlob(), transparent: true, opacity: 0.3,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      const im = createInstanced(blobGeo, blobMat, this.blobs, { name: 'BlobShadows' });
      im.renderOrder = 1;
      im.userData.noAO = true;
      this.root.add(im);
      this.meshes.blobs = im;
    }

    if (this.clumps.length) {
      const leafGeo = getGeometry('scenery-leafMound', () => {
        const g = lumpyIco(0.24, 0, 44, 0.12).clone();
        g.scale(1, 0.7, 1);
        g.translate(0, 0.1, 0);
        return g;
      });
      const leafMat = getMaterial('scenery-leaf', () => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }));
      const headGeo = getGeometry('scenery-bloom', () => {
        const g = new THREE.IcosahedronGeometry(0.06, 0);
        g.scale(1, 0.6, 1);
        return g;
      });
      const headMat = getMaterial('scenery-bloomMat', () => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.6 }));
      // Bucket clumps (with their blooms) by cell; shuffle each bucket deterministically so
      // any prefix (propDensity) is spread evenly and blooms never lose their leaf mound.
      const buckets = new Map();
      let hi = 0;
      for (const c of this.clumps) {
        const k = gridCellKey(c.position[0], c.position[2], CELL_SPARSE);
        let b = buckets.get(k);
        if (!b) { b = []; buckets.set(k, b); }
        b.push({ clump: c, heads: this.heads.slice(hi, hi + c.nHeads) });
        hi += c.nHeads;
      }
      this.meshes.clumps = new THREE.Group(); this.meshes.clumps.name = 'FlowerLeaves';
      this.meshes.heads = new THREE.Group(); this.meshes.heads.name = 'FlowerHeads';
      for (const [k, b] of buckets) {
        for (let i = b.length - 1; i > 0; i--) {
          const j = (hash2(i, 31, b.length) * (i + 1)) | 0;
          const t = b[i]; b[i] = b[j]; b[j] = t;
        }
        const heads = [], prefix = [0];
        for (const e of b) { heads.push(...e.heads); prefix.push(heads.length); }
        const cm = createInstanced(leafGeo, leafMat, b.map(e => e.clump), { receiveShadow: true, name: `FlowerLeaves@${k}` });
        cm.userData.maxCount = b.length;
        const hm = createInstanced(headGeo, headMat, heads, { name: `FlowerHeads@${k}` });
        hm.userData.maxCount = heads.length;
        cm.userData.heads = hm;
        cm.userData.headPrefix = prefix;
        this.meshes.clumps.add(cm);
        this.meshes.heads.add(hm);
      }
      this.root.add(this.meshes.clumps, this.meshes.heads);
    }

    if (this.tufts.length) {
      // shuffle deterministically so any prefix (count) of each bucket is spread uniformly
      for (let i = this.tufts.length - 1; i > 0; i--) {
        const j = (hash2(i, 77, 3) * (i + 1)) | 0;
        const t = this.tufts[i]; this.tufts[i] = this.tufts[j]; this.tufts[j] = t;
      }
      this._tuftMax = this.tufts.length;
      this.meshes.tufts = createInstancedBuckets(tuftGeometry(), grassMaterial(), this.tufts, { receiveShadow: true, name: 'GrassTufts' }, CELL_SPARSE);
      this.meshes.tufts.userData.noAO = true;
      this.root.add(this.meshes.tufts);
    }

    if (this.benches.length) {
      this.meshes.benches = createInstancedBuckets(benchGeometry(), propMaterial(), this.benches, { castShadow: true, receiveShadow: true, name: 'Benches' }, CELL_SPARSE);
      this.root.add(this.meshes.benches);
    }

    if (this.lamps.length) {
      const posts = this.lamps.filter(l => l.post).map(l => ({ position: [l.x, l.y, l.z] }));
      if (posts.length) {
        this.meshes.lampPosts = createInstancedBuckets(lampPostGeometry(), propMaterial(), posts, { castShadow: true, name: 'LampPosts' }, CELL_SPARSE);
        this.root.add(this.meshes.lampPosts);
      }
      const heads = this.lamps.map(l => ({ position: [l.x, l.y + (l.post ? 2.84 : 0), l.z], rotationY: Math.PI / 4 }));
      this.meshes.lanterns = createInstancedBuckets(lanternFrameGeometry(), propMaterial(), heads, { castShadow: true, name: 'Lanterns' }, CELL_SPARSE);
      this.meshes.lampGlass = createInstancedBuckets(lanternGlassGeometry(), lampGlassMaterial(true), heads, { name: 'LanternGlass' }, CELL_SPARSE);
      this.root.add(this.meshes.lanterns, this.meshes.lampGlass);

      // Night halos (one Points draw) and warm light pools on the ground (one instanced draw)
      const hp = new Float32Array(heads.length * 3);
      heads.forEach((h, i) => { hp[i * 3] = h.position[0]; hp[i * 3 + 1] = h.position[1] + 0.25; hp[i * 3 + 2] = h.position[2]; });
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
      this.haloMaterial = new THREE.PointsMaterial({
        color: 0xffc47a, size: 2.2, map: Textures.radialBlob(), transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: true,
      });
      this.meshes.halos = new THREE.Points(hg, this.haloMaterial);
      this.meshes.halos.name = 'LampHalos';
      this.meshes.halos.visible = false;
      this.root.add(this.meshes.halos);

      const pools = this.lamps.filter(l => l.post).map(l => ({
        position: [l.x, l.y + 0.09, l.z], rotation: [-Math.PI / 2, 0, 0], scale: [6, 6, 1],
      }));
      if (pools.length) {
        this.poolMaterial = new THREE.MeshBasicMaterial({
          color: 0xffb865, map: Textures.radialBlob(), transparent: true, opacity: 0,
          depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        });
        this.meshes.pools = createInstanced(getGeometry('scenery-blobPlane', () => new THREE.PlaneGeometry(1, 1)), this.poolMaterial, pools, { name: 'LightPools' });
        this.meshes.pools.visible = false;
        this.meshes.pools.renderOrder = 2;
        this.meshes.pools.userData.noAO = true;
        this.root.add(this.meshes.pools);
      }
    }

    if (this.bulbs.length) {
      const bulbMat = getMaterial('scenery-bulb', () => {
        const m = new THREE.MeshStandardMaterial({ color: 0xf4ead0, emissive: 0xffc070, roughness: 0.3 });
        registerNightGlow(m, 3.2, 0);
        return m;
      });
      this.meshes.bulbs = createInstanced(sphereGeo(0.055, 8, 6), bulbMat, this.bulbs, { name: 'StringBulbs' });
      this.meshes.bulbs.userData.noAO = true;
      this.root.add(this.meshes.bulbs);
      const bp = new Float32Array(this.bulbs.length * 3);
      this.bulbs.forEach((b, i) => { bp[i * 3] = b.position[0]; bp[i * 3 + 1] = b.position[1]; bp[i * 3 + 2] = b.position[2]; });
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(bp, 3));
      this.bulbHaloMaterial = new THREE.PointsMaterial({
        color: 0xffc67e, size: 0.75, map: Textures.radialBlob(), transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false, sizeAttenuation: true,
      });
      this.meshes.bulbHalos = new THREE.Points(bg, this.bulbHaloMaterial);
      this.meshes.bulbHalos.visible = false;
      this.meshes.bulbHalos.name = 'BulbHalos';
      this.root.add(this.meshes.bulbHalos);
    }

    this.root.traverse((m) => { m.matrixAutoUpdate = false; m.updateMatrix(); });
    this.scene.add(this.root);
    this._applyQualityDensity(Quality.settings);
    this._unsub = Quality.onChange((tier, settings) => this._applyQualityDensity(settings));
  }

  /** Tier → grass tufts (grassDensity), flower clumps (propDensity), tree LOD on low. */
  _applyQualityDensity(settings) {
    const low = settings.tier === 'low';
    const t = this.meshes.tufts;
    if (t) {
      const d = low ? 0 : (settings.grassDensity ?? 1);
      for (const im of t.children) {
        im.count = Math.round(im.userData.maxCount * d);
        im.visible = im.count > 0;
      }
      t.visible = d > 0;
    }
    const c = this.meshes.clumps;
    if (c) {
      const d = Math.max(0, Math.min(1, settings.propDensity ?? 1));
      for (const cm of c.children) {
        const n = Math.round(cm.userData.maxCount * d);
        cm.count = n;
        cm.visible = n > 0;
        const hm = cm.userData.heads;
        hm.count = cm.userData.headPrefix[n];
        hm.visible = hm.count > 0;
      }
    }
    // Low: near trees use the cheap LOD geometry (~60 vs ~550 tris per oak)
    for (const { group, species } of this._treeGroups || []) {
      const geo = treeGeometry(species, low);
      for (const im of group.children) if (im.geometry !== geo) im.geometry = geo;
    }
  }

  /** Per frame (no allocations). */
  update() {
    updateWindUniforms();
    const f = EnvState.lampFactor || 0;
    if (Math.abs(f - this._lastLamp) > 0.01) {
      this._lastLamp = f;
      if (this.haloMaterial) {
        this.haloMaterial.opacity = f * 0.75;
        this.meshes.halos.visible = f > 0.02;
      }
      if (this.poolMaterial) {
        this.poolMaterial.opacity = f * 0.32;
        this.meshes.pools.visible = f > 0.02;
      }
      if (this.bulbHaloMaterial) {
        this.bulbHaloMaterial.opacity = f * 0.8;
        this.meshes.bulbHalos.visible = f > 0.02;
      }
    }
  }
}
