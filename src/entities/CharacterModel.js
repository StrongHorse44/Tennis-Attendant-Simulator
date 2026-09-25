import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { getMaterial, basicMat, sharedDepthMaterial, registerNightGlow } from '../graphics/Materials.js';
import { Textures } from '../graphics/Textures.js';
import { Quality } from '../graphics/Quality.js';

/**
 * CharacterModel — stylized low-poly people built from rounded primitives.
 *
 * Each character is ONE SkinnedMesh (one draw call + one shadow call) with a tiny rigid
 * skeleton (every vertex is bound 100% to one bone), so limbs animate without splitting the
 * body into many meshes. All characters share a single vertex-coloured material.
 *
 * Model space: Y up, the character faces +Z, feet at y = 0, unscaled height ≈ 1.8.
 * The character's RIGHT side is -X.
 *
 * Also exports:
 *  - BlobShadows: one InstancedMesh of soft contact shadows for all characters / carts.
 *  - CameraTracker: last rendered camera position (for name-tag fading) without main.js wiring.
 */

// ───────────────────────────── Skeleton layout ─────────────────────────────

export const BONE = {
  root: 0, hips: 1, spine: 2, head: 3, armL: 4, armR: 5, legL: 6, legR: 7, shinL: 8, shinR: 9,
};
const HIP_Y = 0.78;
const KNEE_Y = 0.42;
const SPINE_Y = 0.9;
const NECK_Y = 1.38;
const SHOULDER_Y = 1.27;
const SHOULDER_X = 0.29;
const LEG_X = 0.1;
const HEAD_Y = 1.58;
const HEAD_R = 0.22;

// World-space pivots of each bone in the bind pose (parents listed separately).
const BONE_DEFS = [
  { name: 'root', parent: -1, pos: [0, 0, 0] },
  { name: 'hips', parent: 0, pos: [0, HIP_Y, 0] },
  { name: 'spine', parent: 1, pos: [0, SPINE_Y, 0] },
  { name: 'head', parent: 2, pos: [0, NECK_Y, 0] },
  { name: 'armL', parent: 2, pos: [SHOULDER_X, SHOULDER_Y, 0] },
  { name: 'armR', parent: 2, pos: [-SHOULDER_X, SHOULDER_Y, 0] },
  { name: 'legL', parent: 1, pos: [LEG_X, HIP_Y, 0] },
  { name: 'legR', parent: 1, pos: [-LEG_X, HIP_Y, 0] },
  { name: 'shinL', parent: 6, pos: [LEG_X, KNEE_Y, 0] },
  { name: 'shinR', parent: 7, pos: [-LEG_X, KNEE_Y, 0] },
];

// ───────────────────────────── Shared resources ─────────────────────────────

const CHAR_NIGHT_RIM = 0x1c2a38;

/** One shared material for every character (skinning variant is compiled per object type). */
export function getCharacterMaterial() {
  return getMaterial('character-vc', () => {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0,
    });
    // Low tier has no carry light at night: a faint cool emissive (following the lamp
    // factor) stands in for a rim so characters stay readable on dark lawn.
    const setRim = (tier) => m.emissive.setHex(tier === 'low' ? CHAR_NIGHT_RIM : 0x000000);
    setRim(Quality.tier);
    Quality.onChange(setRim);
    registerNightGlow(m, 0.7);
    return m;
  });
}

const _geoCache = new Map();
const _tmpObj = new THREE.Object3D();
const _col = new THREE.Color();

// Base primitive cache (never mutated; parts are cloned before transforming).
const _prim = new Map();
function prim(key, factory) {
  let g = _prim.get(key);
  if (!g) { g = factory(); _prim.set(key, g); }
  return g;
}
// Far LOD build: while true, primitives use about half the segments and tiny parts
// (face details, buttons...) are dropped. Only set around buildGeometry() calls.
let _far = false;
const seg = (n, min) => (_far ? Math.max(min, Math.ceil(n / 2)) : n);

const P = {
  sphere: (r, w = 10, h = 8) => { w = seg(w, 6); h = seg(h, 4); return prim(`s${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h)); },
  sphereCap: (r, thetaLen, w = 16, h = 8, phiStart = 0, phiLen = Math.PI * 2, thetaStart = 0) => {
    w = seg(w, 6); h = seg(h, 2);
    return prim(`sc${r}|${thetaLen}|${w}|${h}|${phiStart}|${phiLen}|${thetaStart}`,
      () => new THREE.SphereGeometry(r, w, h, phiStart, phiLen, thetaStart, thetaLen));
  },
  capsule: (r, len, cap = 2, rad = 8) => { cap = seg(cap, 1); rad = seg(rad, 6); return prim(`c${r}|${len}|${cap}|${rad}`, () => new THREE.CapsuleGeometry(r, len, cap, rad)); },
  cyl: (rt, rb, h, n = 12, open = false, ts = 0, tl = Math.PI * 2) => {
    n = seg(n, 5);
    return prim(`y${rt}|${rb}|${h}|${n}|${open}|${ts}|${tl}`, () => new THREE.CylinderGeometry(rt, rb, h, n, 1, open, ts, tl));
  },
  rbox: (w, h, d, r = 0.03, n = 1) => prim(`b${w}|${h}|${d}|${r}|${n}${_far ? '|f' : ''}`,
    () => (_far ? new THREE.BoxGeometry(w, h, d)
      : new RoundedBoxGeometry(w, h, d, n, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)))),
  torus: (R, t, rs = 6, ts = 16, arc = Math.PI * 2) => { rs = seg(rs, 3); ts = seg(ts, 8); return prim(`t${R}|${t}|${rs}|${ts}|${arc}`, () => new THREE.TorusGeometry(R, t, rs, ts, arc)); },
};

/** Low-detail version of buildGeometry(style) for distant / low-tier characters. */
function buildFarGeometry(style) {
  _far = true;
  try { return buildGeometry(style); } finally { _far = false; }
}

/**
 * Accumulates parts (geometry + transform + colour + bone) and bakes them into one
 * skinned BufferGeometry.
 */
class PartBuilder {
  constructor() { this.parts = []; }
  /**
   * @param {THREE.BufferGeometry} geo
   * @param {number} bone  BONE index
   * @param {number} color hex
   * @param {number[]} p   [x,y,z]
   * @param {number[]} [r] [rx,ry,rz] euler XYZ
   * @param {number[]|number} [s] scale
   * @param {THREE.Matrix4} [post] extra matrix applied after (e.g. hat yaw)
   */
  add(geo, bone, color, p, r = null, s = null, post = null) {
    if (_far) {
      // Drop details under ~3 cm (eyes, buttons, badges): invisible at LOD distance
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      const k = s == null ? 1 : (typeof s === 'number' ? s : Math.max(s[0], s[1], s[2]));
      if (geo.boundingSphere.radius * k < 0.03) return;
    }
    _tmpObj.position.set(p[0], p[1], p[2]);
    if (r) _tmpObj.rotation.set(r[0], r[1], r[2]); else _tmpObj.rotation.set(0, 0, 0);
    if (s == null) _tmpObj.scale.set(1, 1, 1);
    else if (typeof s === 'number') _tmpObj.scale.setScalar(s);
    else _tmpObj.scale.set(s[0], s[1], s[2]);
    _tmpObj.updateMatrix();
    const m = _tmpObj.matrix.clone();
    if (post) m.premultiply(post);
    this.parts.push({ geo, bone, color, m });
  }
  /** Adds a cylinder spanning two points (for struts / straps). */
  addSpan(radius, a, b, bone, color, seg = 8) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const geo = P.cyl(radius, radius, len, seg);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1));
    this.parts.push({ geo, bone, color, m });
  }
  build() {
    const geos = [];
    for (const part of this.parts) {
      let g = part.geo.clone();
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      }
      g.applyMatrix4(part.m);
      if (!g.index) {
        const n = g.attributes.position.count;
        const idx = new Uint16Array(n);
        for (let i = 0; i < n; i++) idx[i] = i;
        g.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      const n = g.attributes.position.count;
      _col.set(part.color);
      const c = new Float32Array(n * 3);
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        c[i * 3] = _col.r; c[i * 3 + 1] = _col.g; c[i * 3 + 2] = _col.b;
        si[i * 4] = part.bone;
        sw[i * 4] = 1;
      }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      geos.push(g);
    }
    const out = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}

// ───────────────────────────── Style helpers ─────────────────────────────

export const SKIN_TONES = [0xF3D2B3, 0xE8B98F, 0xC98F62, 0x9C6644, 0x6E4630];
export const HAIR_COLORS = {
  black: 0x1F1A17, brown: 0x4A3122, chestnut: 0x6B3F22, blonde: 0xD8B46A, auburn: 0x8A3B1E,
  grey: 0x9A9A96, silver: 0xC9C7C2, white: 0xE4E1DA,
};

/** Deterministic 0..1 hash from a string. */
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

function shade(hex, k) {
  _col.set(hex);
  if (k >= 0) _col.lerp(new THREE.Color(1, 1, 1), k); else _col.multiplyScalar(1 + k);
  return _col.getHex();
}

/**
 * Style object (all optional):
 *  skin, shirt, collar, sleeveTrim, bottom ('shorts'|'skirt'|'pants'), bottomColor, belt,
 *  shoes, shoeAccent, socks, hair ('short'|'swept'|'bob'|'ponytail'|'bun'|'long'|'bald'|'none'),
 *  hairColor, hat ('cap'|'capBack'|'visor'|'headband'|'bucket'|null), hatColor, hatBrim,
 *  brows ('soft'|'haughty'|'worried'|'stern'), mouth ('smile'|'flat'|'o'|'grin'),
 *  mustache (bool), blush (bool), sunglasses (bool), necklace (color|null), wristband (color|null),
 *  racket (color|null), staff (bool: name badge + radio), polo (bool)
 */
function buildGeometry(style) {
  const b = new PartBuilder();
  const skin = style.skin ?? SKIN_TONES[0];
  const skinDark = shade(skin, -0.12);
  const shirt = style.shirt ?? 0x3a7bd5;
  const bottomColor = style.bottomColor ?? 0xF0EDE4;
  const shoe = style.shoes ?? 0xEDEBE6;
  const hairC = style.hairColor ?? HAIR_COLORS.brown;
  const B = BONE;

  // ── Legs (thigh on leg bone, shin + shoe on shin bone) ──
  for (const side of [1, -1]) {
    const x = side * LEG_X;
    const legBone = side > 0 ? B.legL : B.legR;
    const shinBone = side > 0 ? B.shinL : B.shinR;
    const thighColor = style.bottom === 'pants' ? bottomColor : skin;
    b.add(P.capsule(0.07, 0.27), legBone, thighColor, [x, (HIP_Y + KNEE_Y) / 2, 0]);
    if (style.bottom === 'shorts' || style.bottom === undefined) {
      b.add(P.cyl(0.092, 0.088, 0.2, 12), legBone, bottomColor, [x, HIP_Y - 0.1, 0]);
    }
    const shinColor = style.bottom === 'pants' ? bottomColor : skin;
    b.add(P.capsule(0.062, 0.27), shinBone, shinColor, [x, KNEE_Y - 0.17, 0]);
    if (style.bottom === 'pants') {
      b.add(P.cyl(0.074, 0.078, 0.08, 12), shinBone, shade(bottomColor, -0.1), [x, 0.14, 0]);
    } else {
      b.add(P.cyl(0.068, 0.068, 0.09, 10), shinBone, style.socks ?? 0xF2F0EA, [x, 0.14, 0]);
    }
    // Shoe: rounded upper + contrasting sole + toe accent
    b.add(P.rbox(0.15, 0.1, 0.27, 0.045), shinBone, shoe, [x, 0.065, 0.035]);
    b.add(P.rbox(0.16, 0.035, 0.28, 0.015), shinBone, style.shoeSole ?? 0xB9B4AA, [x, 0.018, 0.035]);
    b.add(P.rbox(0.152, 0.03, 0.1, 0.012), shinBone, style.shoeAccent ?? 0x2D5A3D, [x, 0.07, -0.02]);
  }

  // ── Hips: shorts / skirt / pants seat + belt ──
  if (style.bottom === 'skirt') {
    b.add(P.cyl(0.19, 0.28, 0.27, 16), B.hips, bottomColor, [0, HIP_Y - 0.02, 0], null, [1, 1, 0.82]);
    b.add(P.cyl(0.19, 0.19, 0.04, 16), B.hips, shade(bottomColor, -0.08), [0, HIP_Y + 0.1, 0], null, [1, 1, 0.82]);
  } else {
    b.add(P.rbox(0.36, 0.2, 0.25, 0.08), B.hips, bottomColor, [0, HIP_Y + 0.02, 0]);
    if (style.belt !== null) {
      b.add(P.rbox(0.37, 0.04, 0.26, 0.018), B.hips, style.belt ?? 0x3B2A1E, [0, HIP_Y + 0.11, 0]);
      b.add(P.rbox(0.05, 0.04, 0.02, 0.008), B.hips, 0xC9A24A, [0, HIP_Y + 0.11, 0.13]);
    }
  }
  if (style.staff) {
    // Radio clipped to the belt (right hip) with a stubby antenna
    b.add(P.rbox(0.07, 0.11, 0.045, 0.012), B.hips, 0x1C1D1F, [-0.19, HIP_Y + 0.04, 0.05]);
    b.add(P.cyl(0.008, 0.008, 0.09, 5), B.hips, 0x1C1D1F, [-0.205, HIP_Y + 0.14, 0.05]);
  }

  // ── Torso (spine) ──
  b.add(P.capsule(0.2, 0.2, 3, 12), B.spine, shirt, [0, 1.1, 0], null, [1.1, 1, 0.74]);
  if (style.polo !== false) {
    const collar = style.collar ?? shade(shirt, 0.55);
    // Collar ring + two front flaps + placket with buttons
    b.add(P.torus(0.085, 0.03, 6, 16), B.spine, collar, [0, 1.36, 0.0], [Math.PI / 2 - 0.25, 0, 0], [1.05, 1, 1]);
    b.add(P.rbox(0.07, 0.045, 0.02, 0.009), B.spine, collar, [0.045, 1.335, 0.118], [0.5, 0, -0.3]);
    b.add(P.rbox(0.07, 0.045, 0.02, 0.009), B.spine, collar, [-0.045, 1.335, 0.118], [0.5, 0, 0.3]);
    b.add(P.rbox(0.045, 0.13, 0.02, 0.008), B.spine, collar, [0, 1.25, 0.142], [0.18, 0, 0]);
    b.add(P.sphere(0.009, 6, 4), B.spine, 0xF2F0EA, [0, 1.27, 0.153]);
    b.add(P.sphere(0.009, 6, 4), B.spine, 0xF2F0EA, [0, 1.22, 0.153]);
  } else {
    // Crew neck trim
    b.add(P.torus(0.08, 0.02, 6, 16), B.spine, shade(shirt, -0.15), [0, 1.37, 0.0], [Math.PI / 2 - 0.2, 0, 0], [1.05, 1, 1]);
  }
  if (style.stripe) {
    // Chest stripe (sporty) — thin band hugging the torso front
    b.add(P.rbox(0.4, 0.035, 0.02, 0.01), B.spine, style.stripe, [0, 1.17, 0.145]);
  }
  if (style.staff) {
    // Name badge + small club crest on the chest
    b.add(P.rbox(0.09, 0.045, 0.012, 0.006), B.spine, 0xF4E8C1, [0.1, 1.2, 0.147], [0.12, 0, 0]);
    b.add(P.cyl(0.022, 0.022, 0.01, 10), B.spine, 0xC9A24A, [-0.1, 1.21, 0.146], [Math.PI / 2 + 0.12, 0, 0]);
  }
  if (style.necklace) {
    b.add(P.torus(0.1, 0.013, 5, 18), B.spine, style.necklace, [0, 1.345, 0.02], [Math.PI / 2 - 0.4, 0, 0]);
  }

  // ── Arms (sleeve + arm + hand on each arm bone) ──
  for (const side of [1, -1]) {
    const bone = side > 0 ? B.armL : B.armR;
    const x = side * (SHOULDER_X + 0.005);
    b.add(P.sphere(0.085, 10, 8), bone, shirt, [side * (SHOULDER_X - 0.02), SHOULDER_Y - 0.01, 0], null, [1, 0.9, 1]);
    b.add(P.cyl(0.074, 0.066, 0.17, 10), bone, style.sleeveColor ?? shirt, [x, SHOULDER_Y - 0.1, 0], [0, 0, side * 0.04]);
    if (style.sleeveTrim) {
      b.add(P.cyl(0.068, 0.068, 0.025, 10), bone, style.sleeveTrim, [x + side * 0.004, SHOULDER_Y - 0.18, 0]);
    }
    b.add(P.capsule(0.044, 0.36, 3, 8), bone, skin, [x + side * 0.008, 0.99, 0.0]);
    b.add(P.sphere(0.056, 10, 8), bone, skin, [x + side * 0.01, 0.765, 0.01], null, [0.9, 1.15, 1]);
    if (style.wristband && side < 0) {
      b.add(P.cyl(0.054, 0.054, 0.05, 10), bone, style.wristband, [x + side * 0.009, 0.84, 0]);
    }
  }

  // ── Racket in the right hand (-X), hanging head-down and slightly forward ──
  if (style.racket) {
    const hx = -(SHOULDER_X + 0.015);
    const post = new THREE.Matrix4().makeTranslation(hx, 0.76, 0.02)
      .multiply(new THREE.Matrix4().makeRotationX(-0.35))
      .multiply(new THREE.Matrix4().makeTranslation(-hx, -0.76, -0.02));
    const frame = style.racket;
    b.add(P.cyl(0.02, 0.018, 0.2, 8), B.armR, 0x1C1C1C, [hx, 0.73, 0.02], null, null, post);          // grip
    b.add(P.cyl(0.012, 0.012, 0.12, 6), B.armR, frame, [hx, 0.58, 0.02], null, null, post);            // throat
    b.add(P.torus(0.118, 0.014, 5, 20), B.armR, frame, [hx, 0.4, 0.02], [0, Math.PI / 2, 0], [1, 1.25, 1], post);
    b.add(P.cyl(0.112, 0.112, 0.006, 16), B.armR, 0xEDEAD8, [hx, 0.4, 0.02], [0, 0, Math.PI / 2], [1.25, 1, 1], post);
  }

  // ── Head ──
  b.add(P.cyl(0.062, 0.068, 0.14, 10), B.head, skinDark, [0, NECK_Y + 0.03, 0]);
  b.add(P.sphere(HEAD_R, 16, 12), B.head, skin, [0, HEAD_Y, 0], null, [1, 1.02, 0.97]);
  for (const side of [1, -1]) {
    b.add(P.sphere(0.048, 8, 6), B.head, skin, [side * 0.212, HEAD_Y - 0.02, -0.01], null, [0.55, 1, 0.8]);   // ears
  }
  b.add(P.sphere(0.036, 8, 6), B.head, skinDark, [0, HEAD_Y - 0.035, HEAD_R - 0.01], null, [1, 0.9, 0.9]); // nose

  // Eyes / sunglasses
  const eyeY = HEAD_Y + 0.025;
  if (style.sunglasses) {
    for (const side of [1, -1]) {
      b.add(P.rbox(0.1, 0.06, 0.03, 0.02), B.head, 0x151719, [side * 0.075, eyeY, 0.19], [0, side * 0.3, 0]);
    }
    b.add(P.rbox(0.05, 0.015, 0.02, 0.006), B.head, 0x151719, [0, eyeY + 0.01, 0.212]);
  } else {
    for (const side of [1, -1]) {
      b.add(P.sphere(0.036, 8, 8), B.head, 0x2A211C, [side * 0.078, eyeY, 0.192], [0, side * 0.35, 0], [0.85, 1.25, 0.55]);
      b.add(P.sphere(0.011, 5, 4), B.head, 0xFFFFFF, [side * 0.078 + 0.014, eyeY + 0.018, 0.207]);
    }
  }
  // Brows
  const browC = style.browColor ?? shade(hairC, -0.1);
  const browTilt = { soft: 0.1, haughty: -0.28, worried: 0.35, stern: -0.15 }[style.brows ?? 'soft'] ?? 0.1;
  const browLift = style.brows === 'worried' ? 0.015 : 0;
  for (const side of [1, -1]) {
    b.add(P.rbox(0.085, 0.022, 0.02, 0.009), B.head, browC,
      [side * 0.08, eyeY + 0.075 + browLift, 0.186], [-0.2, side * 0.35, side * browTilt]);
  }
  // Mouth
  const mouthY = HEAD_Y - 0.1;
  const mouthC = 0x7A2E2A;
  switch (style.mouth ?? 'smile') {
    case 'flat':
      b.add(P.rbox(0.07, 0.016, 0.02, 0.007), B.head, mouthC, [0, mouthY + 0.005, 0.19], [-0.35, 0, 0]);
      break;
    case 'o':
      b.add(P.torus(0.022, 0.009, 5, 10), B.head, mouthC, [0, mouthY, 0.194], [-0.35, 0, 0]);
      break;
    case 'grin':
      b.add(P.torus(0.055, 0.014, 5, 12, Math.PI), B.head, mouthC, [0, mouthY + 0.03, 0.182], [-0.4, 0, Math.PI]);
      b.add(P.rbox(0.09, 0.02, 0.012, 0.006), B.head, 0xF6F3EE, [0, mouthY + 0.022, 0.2], [-0.35, 0, 0]);
      break;
    default:
      b.add(P.torus(0.045, 0.012, 5, 12, Math.PI), B.head, mouthC, [0, mouthY + 0.03, 0.188], [-0.4, 0, Math.PI]);
  }
  if (style.blush) {
    for (const side of [1, -1]) {
      b.add(P.sphere(0.035, 8, 6), B.head, 0xE8918A, [side * 0.13, HEAD_Y - 0.05, 0.165], [0, side * 0.6, 0], [1, 0.7, 0.35]);
    }
  }
  if (style.mustache) {
    b.add(P.capsule(0.022, 0.08, 3, 6), B.head, hairC, [0, mouthY + 0.045, 0.2], [0, 0, Math.PI / 2], [1, 1, 0.8]);
  }

  // ── Hair ──
  const hairCap = (thetaLen, tiltX = -0.3, scale = 1.07) =>
    b.add(P.sphereCap(HEAD_R, thetaLen, 16, 8), B.head, hairC, [0, HEAD_Y + 0.01, -0.012], [tiltX, 0, 0], [scale, scale * 1.0, scale]);
  switch (style.hair ?? 'short') {
    case 'none': break;
    case 'bald':
      b.add(P.sphereCap(HEAD_R * 1.04, Math.PI * 0.2, 16, 4, Math.PI, Math.PI, Math.PI * 0.42), B.head, hairC, [0, HEAD_Y, 0]);
      break;
    case 'swept':
      hairCap(Math.PI * 0.5);
      b.add(P.sphere(0.1, 10, 8), B.head, hairC, [0.03, HEAD_Y + 0.19, 0.08], [0.3, 0, -0.3], [1.45, 0.6, 1.1]);
      break;
    case 'bob':
      hairCap(Math.PI * 0.56, -0.35, 1.09);
      b.add(P.sphere(0.24, 14, 10), B.head, hairC, [0, HEAD_Y - 0.05, -0.07], null, [1.07, 0.88, 0.82]);
      break;
    case 'ponytail':
      hairCap(Math.PI * 0.52);
      b.add(P.sphere(0.05, 8, 6), B.head, style.tieColor ?? 0xE74C3C, [0, HEAD_Y + 0.05, -0.235]);
      b.add(P.capsule(0.06, 0.16, 3, 8), B.head, hairC, [0, HEAD_Y - 0.08, -0.28], [0.35, 0, 0], [1, 1, 0.85]);
      break;
    case 'bun':
      hairCap(Math.PI * 0.52);
      b.add(P.sphere(0.085, 10, 8), B.head, hairC, [0, HEAD_Y + 0.17, -0.14]);
      break;
    case 'long':
      hairCap(Math.PI * 0.54, -0.3, 1.08);
      b.add(P.rbox(0.4, 0.4, 0.13, 0.06), B.head, hairC, [0, HEAD_Y - 0.14, -0.12], [0.08, 0, 0]);
      break;
    default: // short
      hairCap(Math.PI * 0.46, -0.35, 1.06);
  }

  // ── Headwear ──
  const hat = style.hat;
  if (hat) {
    const hc = style.hatColor ?? 0xF2F0EA;
    const brim = style.hatBrim ?? shade(hc, -0.12);
    const yaw = hat === 'capBack' ? new THREE.Matrix4().makeRotationY(Math.PI) : null;
    if (hat === 'cap' || hat === 'capBack') {
      b.add(P.sphereCap(0.235, Math.PI * 0.5, 18, 8), B.head, hc, [0, HEAD_Y + 0.035, -0.01], [-0.12, 0, 0], [1.02, 0.86, 1.04], yaw);
      b.add(P.cyl(0.17, 0.17, 0.02, 16, false, -Math.PI / 2, Math.PI), B.head, brim, [0, HEAD_Y + 0.05, 0.17], [0.12, 0, 0], [1, 1, 1.25], yaw);
      b.add(P.sphere(0.022, 6, 4), B.head, brim, [0, HEAD_Y + 0.24, -0.02], null, null, yaw);
      if (style.hatLogo) b.add(P.cyl(0.032, 0.032, 0.01, 10), B.head, style.hatLogo, [0, HEAD_Y + 0.13, 0.215], [Math.PI / 2 - 0.55, 0, 0], null, yaw);
    } else if (hat === 'visor') {
      b.add(P.torus(0.226, 0.026, 5, 20), B.head, hc, [0, HEAD_Y + 0.08, -0.005], [Math.PI / 2 + 0.12, 0, 0]);
      b.add(P.cyl(0.17, 0.17, 0.016, 16, false, -Math.PI / 2, Math.PI), B.head, brim, [0, HEAD_Y + 0.075, 0.18], [0.2, 0, 0], [1, 1, 1.2]);
    } else if (hat === 'headband') {
      b.add(P.torus(0.225, 0.028, 5, 20), B.head, hc, [0, HEAD_Y + 0.09, -0.005], [Math.PI / 2 + 0.12, 0, 0]);
    } else if (hat === 'bucket') {
      b.add(P.cyl(0.19, 0.235, 0.16, 16), B.head, hc, [0, HEAD_Y + 0.17, -0.01]);
      b.add(P.cyl(0.33, 0.33, 0.018, 18), B.head, brim, [0, HEAD_Y + 0.095, -0.01], [0.06, 0, 0]);
      b.add(P.cyl(0.236, 0.236, 0.035, 16, true), B.head, style.hatBand ?? 0x3B2A1E, [0, HEAD_Y + 0.115, -0.01]);
    }
  }

  return b.build();
}

// ───────────────────────────── Character ─────────────────────────────

/**
 * A skinned, animated character. `root` is a Group to add to your entity group.
 * Call `update(dt, opts)` each frame (no allocations).
 */
export class Character {
  /**
   * @param {object} style  see buildGeometry()
   * @param {string} cacheKey  geometry cache key (same key -> shared geometry)
   */
  constructor(style, cacheKey) {
    let geo = cacheKey ? _geoCache.get(cacheKey) : null;
    if (!geo) {
      geo = buildGeometry(style);
      if (cacheKey) _geoCache.set(cacheKey, geo);
    }

    this.bones = [];
    for (const def of BONE_DEFS) {
      const bone = new THREE.Bone();
      bone.name = def.name;
      if (def.parent < 0) bone.position.set(def.pos[0], def.pos[1], def.pos[2]);
      else {
        const pp = BONE_DEFS[def.parent].pos;
        bone.position.set(def.pos[0] - pp[0], def.pos[1] - pp[1], def.pos[2] - pp[2]);
        this.bones[def.parent].add(bone);
      }
      this.bones.push(bone);
    }
    const B = this.bones;
    this.hips = B[BONE.hips]; this.spine = B[BONE.spine]; this.head = B[BONE.head];
    this.armL = B[BONE.armL]; this.armR = B[BONE.armR];
    this.legL = B[BONE.legL]; this.legR = B[BONE.legR];
    this.shinL = B[BONE.shinL]; this.shinR = B[BONE.shinR];
    this._hipBaseY = this.hips.position.y;

    this._style = style;
    this._cacheKey = cacheKey;
    this._geoNear = geo;
    this._geoFar = null;

    const mesh = new THREE.SkinnedMesh(geo, getCharacterMaterial());
    mesh.name = 'CharacterBody';
    mesh.castShadow = true;
    mesh.customDepthMaterial = sharedDepthMaterial('skinned');
    mesh.receiveShadow = true;
    mesh.add(B[0]);
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(this.bones));
    // Generous bounds so animated limbs never pop out of the frustum test.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.25);
    mesh.userData.dynamic = true;
    this.skinned = mesh;

    this.root = new THREE.Group();
    this.root.add(mesh);

    // Animation state
    this.walkPhase = 0;
    this.walkBlend = 0;
    this.talkBlend = 0;
    this.t = 0;
    this.seed = (cacheKey ? hashString(cacheKey) : Math.random()) * 10;
    this.seated = false;
  }

  /**
   * @param {number} dt
   * @param {number} moving  0..1 walk intensity (0 = idle)
   * @param {number} cadence  walk cycles speed (radians/s of the gait phase)
   * @param {'idle'|'talking'|'playing'} [mode]
   */
  /**
   * Swap between the full and the low-detail (about half the triangles) body geometry.
   * Same attributes, bones and material, so this costs no shader program change.
   */
  setLod(far) {
    let g = this._geoNear;
    if (far) {
      if (!this._geoFar) {
        const key = this._cacheKey ? this._cacheKey + '|far' : null;
        this._geoFar = (key && _geoCache.get(key)) || buildFarGeometry(this._style);
        if (key) _geoCache.set(key, this._geoFar);
      }
      g = this._geoFar;
    }
    if (this.skinned.geometry !== g) this.skinned.geometry = g;
  }

  update(dt, moving, cadence = 9, mode = 'idle') {
    if (this.seated) return;
    this.t += dt;
    const t = this.t + this.seed;
    const k = Math.min(1, dt * 8);
    this.walkBlend += (moving - this.walkBlend) * k;
    this.talkBlend += ((mode === 'talking' ? 1 : 0) - this.talkBlend) * Math.min(1, dt * 5);
    if (moving > 0.01) this.walkPhase += dt * cadence;

    const wb = this.walkBlend;
    const ib = 1 - wb;
    const tb = this.talkBlend;
    const s = Math.sin(this.walkPhase);
    const c = Math.cos(this.walkPhase);

    // Legs + knees
    const stride = 0.55 * wb;
    this.legL.rotation.x = s * stride;
    this.legR.rotation.x = -s * stride;
    this.shinL.rotation.x = Math.max(0, Math.sin(this.walkPhase + 0.9)) * 0.85 * wb;
    this.shinR.rotation.x = Math.max(0, -Math.sin(this.walkPhase + 0.9)) * 0.85 * wb;
    this.legL.rotation.z = 0;
    this.legR.rotation.z = 0;

    // Hips bob + sway
    const breath = Math.sin(t * 2.1);
    this.hips.position.y = this._hipBaseY + (Math.abs(c) - 0.6) * 0.06 * wb;
    this.hips.rotation.y = -s * 0.08 * wb;
    this.hips.rotation.z = c * 0.03 * wb + Math.sin(t * 0.35) * 0.015 * ib;

    // Spine: counter-twist, forward lean, breathing
    this.spine.rotation.y = s * 0.16 * wb;
    this.spine.rotation.x = 0.07 * wb + breath * 0.012 * ib;
    this.spine.rotation.z = -this.hips.rotation.z * 0.8;
    this.spine.scale.set(1 + breath * 0.012 * ib, 1 + breath * 0.018 * ib, 1 + breath * 0.02 * ib);

    // Arms: swing opposite to legs; idle hang; talking gestures
    const armSwing = 0.5 * wb;
    const gest = Math.sin(t * 3.3) * 0.5 + 0.5;
    const gest2 = Math.sin(t * 2.1 + 1.3);
    this.armL.rotation.x = -s * armSwing + breath * 0.02 * ib - tb * (0.35 + 0.35 * Math.max(0, gest2));
    this.armR.rotation.x = s * armSwing + breath * 0.02 * ib - tb * (0.55 + 0.35 * gest);
    this.armL.rotation.z = 0.07 + 0.04 * wb + tb * 0.18 * Math.max(0, gest2);
    this.armR.rotation.z = -0.07 - 0.04 * wb - tb * (0.2 + 0.12 * gest);
    this.armL.rotation.y = 0;
    this.armR.rotation.y = 0;

    if (mode === 'playing') {
      const sw = Math.sin(t * 3);
      this.armR.rotation.x = -0.6 + sw * 0.9;
      this.armR.rotation.z = -0.3 - Math.sin(t * 1.5) * 0.25;
      this.spine.rotation.y = sw * 0.35;
    }

    // Head: gentle look-around when idle, nod when talking, steady when walking
    this.head.rotation.y = Math.sin(t * 0.43) * 0.3 * ib * (1 - tb) + Math.sin(t * 1.3) * 0.08 * tb;
    this.head.rotation.x = Math.sin(t * 0.61) * 0.05 * ib + Math.sin(t * 5.2) * 0.07 * tb - 0.03 * wb;
    this.head.rotation.z = Math.sin(t * 0.37) * 0.04 * ib + 0.06 * tb * Math.sin(t * 0.8);
  }

  /** Static seated pose (driving the cart). Update() is skipped while seated. */
  setSeated(on) {
    this.seated = on;
    this.hips.position.y = this._hipBaseY;
    this.hips.rotation.set(0, 0, 0);
    this.spine.rotation.set(on ? -0.08 : 0, 0, 0);
    this.spine.scale.set(1, 1, 1);
    this.head.rotation.set(on ? 0.05 : 0, 0, 0);
    this.legL.rotation.set(on ? -Math.PI / 2 : 0, 0, on ? 0.08 : 0);
    this.legR.rotation.set(on ? -Math.PI / 2 : 0, 0, on ? -0.08 : 0);
    this.shinL.rotation.set(on ? Math.PI / 2 - 0.1 : 0, 0, 0);
    this.shinR.rotation.set(on ? Math.PI / 2 - 0.1 : 0, 0, 0);
    // Right hand (-X) to the wheel, left arm resting forward
    this.armR.rotation.set(on ? -1.05 : 0, 0, on ? 0.18 : 0);
    this.armL.rotation.set(on ? -0.75 : 0, 0, on ? -0.08 : 0);
  }
}

// ───────────────────────────── Blob (contact) shadows ─────────────────────────────

const _blobM = new THREE.Matrix4();
const _blobs = new WeakMap(); // scene -> manager

/**
 * One InstancedMesh of soft radial contact shadows shared by all characters and carts.
 * `BlobShadows.get(scene).alloc()` returns a slot index; `set(slot, x, z, sx, sz, yaw)`.
 */
export class BlobShadows {
  static get(scene) {
    let m = _blobs.get(scene);
    if (!m) { m = new BlobShadows(scene); _blobs.set(scene, m); }
    return m;
  }
  constructor(scene, capacity = 24) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: 0x0d1a10, map: Textures.radialBlob(), transparent: true, opacity: 0.4,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.material = material;
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.name = 'BlobShadows';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.userData.noMerge = true;
    this.mesh.userData.noAO = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _blobM.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, _blobM);
    this.mesh.count = 0;
    this.capacity = capacity;
    scene.add(this.mesh);
    const applyQ = (s) => { material.opacity = s.shadows ? 0.32 : 0.45; };
    applyQ(Quality.settings);
    Quality.onChange((_, s) => applyQ(s));
  }
  alloc() {
    if (this.mesh.count >= this.capacity) return -1;
    return this.mesh.count++;
  }
  set(slot, x, z, sx, sz = sx, yaw = 0, y = 0.04) {
    if (slot < 0) return;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // rotationY * scale, then translate
    _blobM.set(
      c * sx, 0, s * sz, x,
      0, 1, 0, y,
      -s * sx, 0, c * sz, z,
      0, 0, 0, 1,
    );
    this.mesh.setMatrixAt(slot, _blobM);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  hide(slot) {
    if (slot < 0) return;
    _blobM.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(slot, _blobM);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ───────────────────────────── Camera tracking ─────────────────────────────

/**
 * Captures the main camera's world position every render via scene.onBeforeRender
 * (chained, installed once per scene). `CameraTracker.valid` is false until the first frame.
 */
export const CameraTracker = {
  position: new THREE.Vector3(),
  valid: false,
  install(scene) {
    if (scene.userData.__camTracker) return;
    scene.userData.__camTracker = true;
    const prev = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, sc, camera, rt) {
      if (camera && camera.isPerspectiveCamera) {
        const e = camera.matrixWorld.elements;
        CameraTracker.position.set(e[12], e[13], e[14]);
        CameraTracker.valid = true;
      }
      if (prev) prev.call(this, renderer, sc, camera, rt);
    };
  },
};

// ───────────────────────────── Glow helpers ─────────────────────────────

/** Soft additive glow material (shared) used for headlight pools etc. */
export function glowMaterial(color, key) {
  return getMaterial(`glow-${key}`, () => new THREE.MeshBasicMaterial({
    color, map: Textures.radialBlob(), transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  }));
}

export { basicMat };
