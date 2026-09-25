import * as THREE from 'three';

/**
 * Materials — cached MeshStandardMaterial factory + wetness / night-glow registries.
 *
 *   import { mat, getMaterial, registerNightGlow } from '../graphics/Materials.js';
 *   const white = mat(0xffffff, { roughness: 0.6 });                 // cached by params
 *   const grass = mat(0xffffff, { map: Textures.grass({repeat:[20,20]}), wet: true });
 *   const glass = getMaterial('window', () => new THREE.MeshStandardMaterial({...})); // named cache
 *   registerNightGlow(bulbMat, 2.5);   // emissiveIntensity follows EnvState.lampFactor automatically
 *
 * Cached materials are SHARED — never mutate a material returned by mat()/getMaterial()
 * for a single object. If you need per-object changes (opacity fades, colour lerps), use
 * mat(..., { unique: true }) or material.clone().
 */

const _matCache = new Map();
const _named = new Map();

/**
 * Cache key for mat()/basicMat(). NOTE: `name` is deliberately NOT part of the key —
 * identical parameters share one material. Use getMaterial(key, factory) when a mesh
 * needs its own instance (e.g. InstancedMesh users, which must not share a material with
 * plain meshes or the program flips `instancing` on every draw).
 */
function keyOf(color, o) {
  const c = color instanceof THREE.Color ? color.getHexString() : String(color);
  return [
    c,
    o.roughness ?? 0.85,
    o.metalness ?? 0,
    o.map ? o.map.uuid : '',
    o.normalMap ? o.normalMap.uuid : '',
    o.roughnessMap ? o.roughnessMap.uuid : '',
    o.bumpMap ? o.bumpMap.uuid : '',
    o.bumpScale ?? '',
    o.alphaMap ? o.alphaMap.uuid : '',
    o.flatShading ? 1 : 0,
    o.transparent ? 1 : 0,
    o.opacity ?? 1,
    o.side ?? THREE.FrontSide,
    o.emissive ?? '',
    o.emissiveIntensity ?? '',
    o.vertexColors ? 1 : 0,
    o.alphaTest ?? 0,
    o.polygonOffset ?? '',
    o.depthWrite ?? '',
    o.fog ?? '',
    o.wet ? (typeof o.wet === 'number' ? o.wet : 1) : 0,
    o.envMapIntensity ?? '',
  ].join('|');
}

/**
 * Get a cached MeshStandardMaterial.
 * @param {number|string|THREE.Color} color
 * @param {object} [o]
 * @param {number} [o.roughness=0.85]
 * @param {number} [o.metalness=0]
 * @param {THREE.Texture} [o.map] / normalMap / roughnessMap / bumpMap / alphaMap
 * @param {boolean} [o.flatShading]
 * @param {boolean} [o.transparent] @param {number} [o.opacity]
 * @param {number} [o.side]
 * @param {number} [o.emissive] @param {number} [o.emissiveIntensity]
 * @param {boolean} [o.vertexColors]
 * @param {number} [o.alphaTest]
 * @param {boolean|number} [o.polygonOffset]  true = factor -1, or a number (negative pulls toward camera)
 * @param {boolean} [o.depthWrite] @param {boolean} [o.fog]
 * @param {boolean|number} [o.wet]  register for rain wetness (number = strength 0..1, default 1)
 * @param {boolean} [o.unique]  bypass the cache (returns a fresh material you may mutate)
 * @param {string} [o.name]
 */
export function mat(color = 0xffffff, o = {}) {
  const key = o.unique ? null : keyOf(color, o);
  if (key && _matCache.has(key)) return _matCache.get(key);

  const params = {
    color,
    roughness: o.roughness ?? 0.85,
    metalness: o.metalness ?? 0,
  };
  for (const k of ['map', 'normalMap', 'roughnessMap', 'bumpMap', 'bumpScale', 'alphaMap', 'flatShading',
    'transparent', 'opacity', 'side', 'emissive', 'emissiveIntensity', 'vertexColors', 'alphaTest',
    'depthWrite', 'fog', 'envMapIntensity']) {
    if (o[k] !== undefined) params[k] = o[k];
  }
  const m = new THREE.MeshStandardMaterial(params);
  if (o.polygonOffset) {
    const f = typeof o.polygonOffset === 'number' ? o.polygonOffset : -1;
    m.polygonOffset = true;
    m.polygonOffsetFactor = f;
    m.polygonOffsetUnits = f;
  }
  if (o.name) m.name = o.name;
  if (o.wet) registerWet(m, typeof o.wet === 'number' ? o.wet : 1);
  if (key) _matCache.set(key, m);
  return m;
}

/**
 * Named material cache. `factoryOrParams` is either a function returning a material or a
 * MeshStandardMaterial parameter object. Returns the same instance for the same key.
 */
export function getMaterial(key, factoryOrParams) {
  let m = _named.get(key);
  if (!m) {
    m = typeof factoryOrParams === 'function'
      ? factoryOrParams()
      : new THREE.MeshStandardMaterial(factoryOrParams || {});
    if (!m.name) m.name = key;
    _named.set(key, m);
  }
  return m;
}

/** Basic unlit cached material (for UI-ish 3D bits, glows). */
export function basicMat(color = 0xffffff, o = {}) {
  const key = 'basic|' + keyOf(color, o);
  if (_matCache.has(key)) return _matCache.get(key);
  const m = new THREE.MeshBasicMaterial({ color, ...pick(o, ['map', 'transparent', 'opacity', 'side', 'depthWrite', 'fog', 'alphaTest', 'vertexColors']) });
  if (o.blending !== undefined) m.blending = o.blending;
  _matCache.set(key, m);
  return m;
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

// ───────────────────────────── Wetness ─────────────────────────────

const _wet = [];   // { m, baseRough, baseColor, baseEnv, strength, tint, wetEnv }
let _lastWet = -1;
const _wetTint = new THREE.Color();

/**
 * Make a material respond to rain (lower roughness, darker).
 * opts.tint     — colour multiplier reached when fully wet (e.g. deepen a blue court)
 * opts.wetEnv   — envMapIntensity reached when fully wet (tame grey-sky reflections)
 */
export function registerWet(material, strength = 1, opts = null) {
  if (_wet.some(e => e.m === material)) return material;
  _wet.push({
    m: material,
    baseRough: material.roughness,
    baseColor: material.color.clone(),
    baseEnv: material.envMapIntensity ?? 1,
    strength,
    tint: opts && opts.tint ? new THREE.Color(opts.tint) : null,
    wetEnv: opts && opts.wetEnv !== undefined ? opts.wetEnv : null,
  });
  if (_lastWet > 0) applyWetness(_lastWet, true);
  return material;
}

/** Called by WeatherSystem (only when wetness changes by > 0.01). */
export function applyWetness(w, force = false) {
  if (!force && Math.abs(w - _lastWet) < 0.01) return;
  _lastWet = w;
  for (const e of _wet) {
    const k = w * e.strength;
    e.m.roughness = e.baseRough + (Math.min(e.baseRough, 0.2) - e.baseRough) * k;
    e.m.color.copy(e.baseColor).multiplyScalar(1 - 0.38 * k);
    if (e.tint) e.m.color.multiply(_wetTint.setRGB(1, 1, 1).lerp(e.tint, w));
    if (e.wetEnv !== null) e.m.envMapIntensity = e.baseEnv + (e.wetEnv - e.baseEnv) * w;
  }
}

// ───────────────────────────── Night glow ─────────────────────────────

const _glow = [];  // { m, max, baseEmissive }
let _lastGlow = -1;

/**
 * Register an emissive material (window glass, lamp bulb, sign) whose emissiveIntensity
 * follows EnvState.lampFactor: intensity = min + (max - min) * lampFactor.
 * Set material.emissive to the glow colour first.
 */
export function registerNightGlow(material, maxIntensity = 2, minIntensity = 0) {
  if (_glow.some(e => e.m === material)) return material;
  _glow.push({ m: material, max: maxIntensity, min: minIntensity });
  material.emissiveIntensity = minIntensity + (maxIntensity - minIntensity) * Math.max(0, _lastGlow);
  return material;
}

/** Called by WeatherSystem (only when lampFactor changes by > 0.01). */
export function applyNightGlow(f, force = false) {
  if (!force && Math.abs(f - _lastGlow) < 0.01) return;
  _lastGlow = f;
  for (const e of _glow) e.m.emissiveIntensity = e.min + (e.max - e.min) * f;
}


// ───────────────────────────── shadow depth variants ─────────────────────────────

const _depthVariants = {};

/**
 * Shared shadow-pass depth material per vertex variant ('instanced' | 'instancedColor' |
 * 'skinned'). three's single built-in depth material otherwise flips its program between
 * plain, instanced and skinned casters on every shadow draw. Assign as customDepthMaterial.
 */
export function sharedDepthMaterial(variant) {
  let m = _depthVariants[variant];
  if (!m) {
    m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.name = `shadowDepth:${variant}`;
    _depthVariants[variant] = m;
  }
  return m;
}
