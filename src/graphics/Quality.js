/**
 * Quality — graphics quality tiers ('low' | 'medium' | 'high').
 *
 * Usage:
 *   import { Quality } from '../graphics/Quality.js';
 *   if (Quality.settings.shadows) mesh.castShadow = true;
 *   const n = Math.round(200 * Quality.settings.grassDensity);
 *   const off = Quality.onChange((tier, settings) => { ... }); // returns unsubscribe fn
 *
 * The active tier is auto-detected on first load and persisted in
 * localStorage under 'courtcall.quality'. Game.setQuality(tier) applies a tier live.
 */

const STORAGE_KEY = 'courtcall.quality';

export const QUALITY_TIERS = ['low', 'medium', 'high'];

/** Per-tier settings. Other modules should only READ these. */
export const QUALITY_SETTINGS = {
  low: {
    tier: 'low',
    pixelRatioCap: 1,
    shadows: false,
    shadowMapSize: 512,
    shadowSoft: false,
    shadowExtent: 34,          // half-size of the sun shadow frustum (world units)
    postFX: false,             // no EffectComposer at all -> direct render
    msaaSamples: 0,
    ao: false,
    bloom: false,
    colorGrade: false,
    envMap: false,             // scene.environment (PMREM)
    anisotropy: 1,
    maxTextureSize: 512,
    grassDensity: 0.25,        // 0..1 multiplier for grass tufts / scatter props
    propDensity: 0.5,          // 0..1 multiplier for optional decorative props
    rainDensity: 0.4,          // 0..1 multiplier for rain streak count
    cloudCount: 5,
    stars: false,
    maxLights: 0,              // extra (non-sun) dynamic lights allowed (lamps use emissive only)
  },
  medium: {
    tier: 'medium',
    pixelRatioCap: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    shadowSoft: true,
    shadowExtent: 32,
    postFX: true,
    msaaSamples: 4,
    ao: false,
    bloom: false,
    colorGrade: true,
    envMap: true,
    anisotropy: 4,
    maxTextureSize: 1024,
    grassDensity: 0.6,
    propDensity: 0.8,
    rainDensity: 0.7,
    cloudCount: 9,
    stars: true,
    maxLights: 2,
  },
  high: {
    tier: 'high',
    pixelRatioCap: 2,
    shadows: true,
    shadowMapSize: 2048,
    shadowSoft: true,
    shadowExtent: 42,
    postFX: true,
    msaaSamples: 4,
    ao: true,
    bloom: true,
    colorGrade: true,
    envMap: true,
    anisotropy: 8,
    maxTextureSize: 1024,
    grassDensity: 1,
    propDensity: 1,
    rainDensity: 1,
    cloudCount: 12,
    stars: true,
    maxLights: 4,
  },
};

/** Guess a sensible default tier from the device. */
export function detectQualityTier() {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const cores = nav.hardwareConcurrency || 4;
    const mem = nav.deviceMemory || 4;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const minSide = Math.min(window.innerWidth || 1280, window.innerHeight || 720);
    const small = minSide < 600;
    if (cores <= 2 || mem <= 2) return 'low';
    // Phones / tablets: medium, but low for ≤4 GB phones — medium's MSAA half-float
    // composer + env map has crashed mid-range mobile GPUs (lost WebGL context).
    if (coarse || small) return mem <= 4 ? 'low' : 'medium';
    // Desktop with few cores (old laptops) -> medium
    if (cores <= 4 && mem <= 4) return 'medium';
    return 'high';
  } catch (e) {
    return 'medium';
  }
}

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return QUALITY_TIERS.includes(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function writeStored(tier) {
  try { localStorage.setItem(STORAGE_KEY, tier); } catch (e) { /* ignore */ }
}

class QualityManager {
  constructor() {
    this._listeners = new Set();
    this.tier = readStored() || detectQualityTier();
    /** Live settings object for the active tier (same object identity is replaced on change). */
    this.settings = QUALITY_SETTINGS[this.tier];
  }

  /** Switch tier; persists and notifies listeners. Returns the applied tier. */
  set(tier, { persist = true } = {}) {
    if (!QUALITY_TIERS.includes(tier)) {
      console.warn(`[Quality] unknown tier "${tier}"`);
      return this.tier;
    }
    const changed = tier !== this.tier;
    this.tier = tier;
    this.settings = QUALITY_SETTINGS[tier];
    if (persist) writeStored(tier);
    if (changed) {
      for (const fn of this._listeners) {
        try { fn(tier, this.settings); } catch (e) { console.error('[Quality] listener error', e); }
      }
    }
    return tier;
  }

  get() { return this.tier; }

  /** Register a change listener (tier, settings) => void. Returns an unsubscribe function. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Forget the stored choice and return to the auto-detected tier. */
  resetToAuto() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    return this.set(detectQualityTier(), { persist: false });
  }
}

/** Singleton quality manager. */
export const Quality = new QualityManager();
