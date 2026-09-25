import * as THREE from 'three';
import { Quality } from './Quality.js';

/**
 * Textures — seeded noise helpers + cached procedural canvas textures.
 *
 *   import { Textures, createCanvasTexture, fbm2 } from '../graphics/Textures.js';
 *   const grass = Textures.grass({ repeat: [15, 12] });           // colour map, sRGB, cached
 *   const tex = createCanvasTexture(256, (ctx, s, rand) => { ... }, { key: 'myThing', repeat: [2, 2] });
 *
 * All textures are generated once and cached by key (+ repeat). Asking for the same
 * texture with a different repeat returns a lightweight clone that shares the GPU upload.
 */

// ───────────────────────────── Noise helpers ─────────────────────────────

/** Seeded PRNG (mulberry32). Returns () => float in [0,1). */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash -> [0,1). */
export function hash2(ix, iy, seed = 0) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

/**
 * 2D value noise in [0,1]. If `period` is given (integer), the noise tiles every
 * `period` units in x and y — use it for seamless repeating textures.
 */
export function valueNoise2(x, y, seed = 0, period = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  let xa = x0, xb = x0 + 1, ya = y0, yb = y0 + 1;
  if (period > 0) {
    xa = ((xa % period) + period) % period; xb = ((xb % period) + period) % period;
    ya = ((ya % period) + period) % period; yb = ((yb % period) + period) % period;
  }
  const a = hash2(xa, ya, seed), b = hash2(xb, ya, seed);
  const c = hash2(xa, yb, seed), d = hash2(xb, yb, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

/**
 * Fractal (fbm) value noise in ~[0,1]. Tileable when `period` > 0 (integer; doubled per octave).
 */
export function fbm2(x, y, { octaves = 4, seed = 0, period = 0, lacunarity = 2, gain = 0.5 } = {}) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 17, p);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    if (p) p *= lacunarity;
  }
  return sum / norm;
}

// ───────────────────────────── Texture factory ─────────────────────────────

const _cache = new Map();        // key -> base texture
const _variants = new Map();     // key|repeat -> clone
let _maxAnisotropy = 8;

/** Called by the renderer setup with renderer.capabilities.getMaxAnisotropy(). */
export function setMaxAnisotropy(n) { _maxAnisotropy = Math.max(1, n || 1); }

function currentAnisotropy() {
  return Math.min(_maxAnisotropy, Quality.settings.anisotropy || 1);
}

function clampSize(size) {
  const max = Quality.settings.maxTextureSize || 1024;
  return Math.max(16, Math.min(size, max, 1024));
}

/**
 * Create (or fetch cached) CanvasTexture.
 * @param {number} size    canvas size in px (square; clamped to Quality maxTextureSize and 1024)
 * @param {(ctx:CanvasRenderingContext2D, size:number, rand:()=>number)=>void} drawFn
 * @param {object} [opts]
 * @param {string} [opts.key]        cache key (omit = no caching)
 * @param {[number,number]} [opts.repeat=[1,1]]
 * @param {boolean} [opts.srgb=true] colour data (false for roughness/alpha/data maps)
 * @param {number} [opts.wrap=THREE.RepeatWrapping]
 * @param {number} [opts.seed=1]
 * @param {boolean} [opts.mipmaps=true]
 * @param {number} [opts.height]     optional non-square height in px
 */
export function createCanvasTexture(size, drawFn, opts = {}) {
  const { key, repeat = [1, 1], srgb = true, wrap = THREE.RepeatWrapping, seed = 1, mipmaps = true, height } = opts;
  if (key) {
    const base = _cache.get(key);
    if (base) return withRepeat(key, base, repeat);
  }
  const w = clampSize(size);
  const h = height ? clampSize(height) : w;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  drawFn(ctx, w, seededRandom(seed), h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = wrap;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = currentAnisotropy();
  tex.generateMipmaps = mipmaps;
  tex.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.repeat.set(repeat[0], repeat[1]);
  if (key) {
    tex.name = key;
    _cache.set(key, tex);
    _variants.set(`${key}|${repeat[0]},${repeat[1]}`, tex);
  }
  return tex;
}

function withRepeat(key, base, repeat) {
  const vk = `${key}|${repeat[0]},${repeat[1]}`;
  let t = _variants.get(vk);
  if (!t) {
    t = base.clone();          // shares Source -> single GPU upload
    t.repeat.set(repeat[0], repeat[1]);
    t.needsUpdate = true;
    _variants.set(vk, t);
  }
  return t;
}

/** Re-apply anisotropy from Quality to all cached textures (called on quality change). */
export function refreshTextureQuality() {
  const a = currentAnisotropy();
  for (const t of _variants.values()) {
    if (t.anisotropy !== a) { t.anisotropy = a; t.needsUpdate = true; }
  }
}

// ───────────────────────────── Pixel helpers ─────────────────────────────

function hexToRgb(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

/**
 * Fill the canvas per-pixel: fn(u, v) -> [r,g,b] or [r,g,b,a] (0..255), u,v in [0,1).
 * Uses a reusable output array to avoid allocations: fn receives `out` as 3rd arg.
 */
function fillPixels(ctx, w, h, fn) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[3] = 255;
      fn(x / w, y / h, out, x, y);
      const i = (y * w + x) * 4;
      d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3];
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * fillPixels at 1/sx x 1/sy resolution, then drawn upscaled (bilinear) to w x h — for
 * smooth noise fields, sx*sy times cheaper. fn still gets full-res x, y (scaled).
 * Crisp detail (speckle, lines) should be drawn afterwards at full resolution.
 */
function fillPixelsScaled(ctx, w, h, sx, sy, fn) {
  const lw = Math.max(8, Math.round(w / sx)), lh = Math.max(8, Math.round(h / sy));
  if (lw >= w && lh >= h) { fillPixels(ctx, w, h, fn); return; }
  const small = document.createElement('canvas');
  small.width = lw; small.height = lh;
  const kx = w / lw, ky = h / lh;
  fillPixels(small.getContext('2d'), lw, lh, (u, v, out, x, y) => fn(u, v, out, (x * kx) | 0, (y * ky) | 0));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(small, 0, 0, w, h);
}

function mixRgb(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function speckle(ctx, w, h, rand, count, colors, minR = 0.5, maxR = 1.5, alpha = 1) {
  ctx.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[(rand() * colors.length) | 0];
    const r = minR + rand() * (maxR - minR);
    ctx.fillRect(rand() * w, rand() * h, r, r);
  }
  ctx.globalAlpha = 1;
}

// Hoisted fbm option objects (avoid a per-pixel allocation)
const _O1 = { octaves: 4, seed: 11, period: 8 };
const _O2 = { octaves: 2, seed: 5, period: 3 };
const _O3 = { octaves: 4, seed: 21, period: 6 };
const _O4 = { octaves: 3, seed: 31, period: 16 };
const _O5 = { octaves: 4, seed: 41, period: 10 };
const _O6 = { octaves: 5, seed: 51, period: 5 };
const _O7 = { octaves: 3, seed: 61 };
const _O8 = { octaves: 3, seed: 71, period: 24 };
const _O9 = { octaves: 2, seed: 72, period: 4 };
const _O10 = { octaves: 2, seed: 81, period: 30 };
const _O11 = { octaves: 4, seed: 91, period: 12 };

// ───────────────────────────── Ready-made textures ─────────────────────────────

/**
 * Library of procedural textures. Every function takes an optional
 * { repeat:[x,y] } and returns a cached THREE.Texture.
 * Colour maps are authored near their final colour — use material.color = 0xffffff
 * (or a light tint) with them.
 */
export const Textures = {
  /** Lush lawn: varied green with fine blades, optional mow stripes (2 bands per tile). */
  grass({ repeat = [1, 1], stripes = true } = {}) {
    const key = `grass${stripes ? '-s' : ''}`;
    return createCanvasTexture(1024, (ctx, s, rand) => {
      const dark = hexToRgb(0x4a8a3a), light = hexToRgb(0x6cb052), dry = hexToRgb(0x8fae4e);
      // low-frequency colour field at 1/4 res, upscaled (16x cheaper than full-res fbm)
      const ls = Math.max(64, s >> 2);
      const small = document.createElement('canvas');
      small.width = small.height = ls;
      const sctx = small.getContext('2d');
      fillPixels(sctx, ls, ls, (u, v, out) => {
        const n = fbm2(u * 8, v * 8, _O1);
        const patch = fbm2(u * 3, v * 3, _O2);
        mixRgb(out, dark, light, Math.min(1, Math.max(0, n * 1.3 - 0.15)));
        if (patch > 0.62) { const t = (patch - 0.62) * 1.2; mixRgb(out, out, dry, t); }
      });
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, s, s);
      if (stripes) {
        const bw = s / 4;
        for (let b = 0; b < 4; b++) {
          ctx.fillStyle = b % 2 === 0 ? 'rgba(255,255,230,0.07)' : 'rgba(0,30,0,0.08)';
          ctx.fillRect(b * bw, 0, bw, s);
        }
      }
      // blades: two batched paths (dark / light)
      ctx.lineWidth = 1;
      for (const style of ['rgba(40,90,30,0.35)', 'rgba(150,200,110,0.30)']) {
        ctx.strokeStyle = style;
        ctx.beginPath();
        for (let i = 0; i < s * 6; i++) {
          const x = rand() * s, y = rand() * s;
          const l = 2 + rand() * 4;
          ctx.moveTo(x, y);
          ctx.lineTo(x + (rand() - 0.5) * 2, y - l);
        }
        ctx.stroke();
      }
    }, { key, repeat });
  },

  /** Terracotta clay with fine speckle & brush streaks. */
  clay({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s, rand) => {
      const a = hexToRgb(0xc0603a), b = hexToRgb(0xd27448);
      fillPixelsScaled(ctx, s, s, 2, 2, (u, v, out) => {
        const n = fbm2(u * 6, v * 6, _O3);
        const fine = valueNoise2(u * 64, v * 64, 9, 64) * 0.12;
        mixRgb(out, a, b, Math.min(1, n * 0.95 + fine));
      });
      speckle(ctx, s, s, rand, s * 30, ['#a4502e', '#e59a6c', '#b85a36', '#f0c2a0'], 0.6, 1.6, 0.55);
    }, { key: 'clay', repeat });
  },

  /** Acrylic hard-court grain (neutral light grey — tint with material.color for blue/green). */
  acrylic({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s, rand) => {
      fillPixelsScaled(ctx, s, s, 2, 2, (u, v, out) => {
        const n = fbm2(u * 16, v * 16, _O4);
        const g = 212 + n * 43;
        out[0] = g; out[1] = g; out[2] = g;
      });
      speckle(ctx, s, s, rand, s * 40, ['#ffffff', '#d0d0d0', '#e8e8e8'], 0.5, 1.2, 0.5);
    }, { key: 'acrylic', repeat });
  },

  /** Dark asphalt with aggregate. */
  asphalt({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s, rand) => {
      fillPixelsScaled(ctx, s, s, 2, 2, (u, v, out) => {
        const n = fbm2(u * 10, v * 10, _O5);
        const g = 58 + n * 30;
        out[0] = g; out[1] = g + 1; out[2] = g + 4;
      });
      speckle(ctx, s, s, rand, s * 50, ['#8a8a8a', '#2c2c2c', '#a09a90', '#555555'], 0.6, 1.8, 0.7);
    }, { key: 'asphalt', repeat });
  },

  /** Light concrete / cart path with subtle blotches and expansion joints (1 joint per tile). */
  concrete({ repeat = [1, 1], joints = true } = {}) {
    return createCanvasTexture(512, (ctx, s, rand) => {
      fillPixelsScaled(ctx, s, s, 2, 2, (u, v, out) => {
        const n = fbm2(u * 11, v * 11, _O6);
        const g = 230 + n * 20;
        out[0] = g + 4; out[1] = g; out[2] = g - 8;
      });
      speckle(ctx, s, s, rand, s * 20, ['#9d968a', '#e8e2d6', '#b6ae9f'], 0.5, 1.4, 0.5);
      if (joints) {
        ctx.fillStyle = 'rgba(90,80,70,0.45)';
        ctx.fillRect(0, 0, s, 2);
      }
    }, { key: `concrete${joints ? '-j' : ''}`, repeat });
  },

  /** Stone / brick pavers (herringbone-ish running bond). */
  pavers({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s, rand) => {
      ctx.fillStyle = '#8f8274';
      ctx.fillRect(0, 0, s, s);
      const rows = 8, cols = 4, bh = s / rows, bw = s / cols, gap = 3;
      const tones = ['#d9c6a5', '#cdb693', '#e2d2b5', '#c8ae8a', '#d4bd98'];
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * bw / 2;
        for (let c = -1; c <= cols; c++) {
          ctx.fillStyle = tones[(rand() * tones.length) | 0];
          const x = c * bw + off;
          ctx.fillRect(x + gap / 2, r * bh + gap / 2, bw - gap, bh - gap);
        }
      }
      speckle(ctx, s, s, rand, s * 12, ['rgba(0,0,0,0.15)', 'rgba(255,255,255,0.2)'], 0.8, 2, 1);
    }, { key: 'pavers', repeat });
  },

  /** Warm wood planks (planks run along U). */
  wood({ repeat = [1, 1], tone = 0xa8743f } = {}) {
    const key = `wood-${tone.toString(16)}`;
    return createCanvasTexture(512, (ctx, s, rand) => {
      const base = hexToRgb(tone);
      const planks = 6, ph = s / planks;
      fillPixelsScaled(ctx, s, s, 4, 1, (u, v, out, x, y) => {
        const p = Math.floor(y / ph);
        const shade = 0.82 + hash2(p, 3, 7) * 0.3;
        // blend two samples so the grain tiles seamlessly along U
        const g0 = fbm2(u * 3 + p * 7, v * 40, _O7);
        const g1 = fbm2((u - 1) * 3 + p * 7, v * 40, _O7);
        const grain = g0 * (1 - u) + g1 * u;
        const k = shade * (0.85 + grain * 0.3);
        out[0] = base[0] * k; out[1] = base[1] * k; out[2] = base[2] * k;
        if (y % ph < 2) { out[0] *= 0.55; out[1] *= 0.55; out[2] *= 0.55; }
      });
      // end joints
      ctx.fillStyle = 'rgba(40,25,10,0.5)';
      for (let p = 0; p < planks; p++) {
        ctx.fillRect(((p * 0.37 + rand() * 0.3) % 1) * s, p * ph, 2, ph);
      }
    }, { key, repeat });
  },

  /** Roof shingles (rows along U, tint with material.color). Neutral mid-grey base. */
  shingles({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s, rand) => {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(0, 0, s, s);
      const rows = 10, rh = s / rows, cols = 8, cw = s / cols;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * cw / 2;
        for (let c = -1; c <= cols; c++) {
          const g = 150 + ((rand() * 70) | 0);
          ctx.fillStyle = `rgb(${g},${g},${g})`;
          ctx.fillRect(c * cw + off + 1, r * rh, cw - 2, rh - 1);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, r * rh + rh - 3, s, 3);
      }
    }, { key: 'shingles', repeat });
  },

  /** Stucco / plaster wall (light cream, tint with material.color). */
  stucco({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s) => {
      fillPixelsScaled(ctx, s, s, 2, 2, (u, v, out) => {
        const n = fbm2(u * 24, v * 24, _O8);
        const m = fbm2(u * 4, v * 4, _O9);
        const g = 228 + (n - 0.5) * 26 + (m - 0.5) * 14;
        out[0] = g + 6; out[1] = g + 2; out[2] = g - 8;
      });
    }, { key: 'stucco', repeat });
  },

  /** Horizontal lap siding / clapboard (white, tint with material.color). 8 boards per tile. */
  siding({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s) => {
      const boards = 8, bh = s / boards;
      fillPixels(ctx, s, s, (u, v, out, x, y) => {
        const t = (y % bh) / bh;
        const g = 236 - t * 22 + (fbm2(u * 30, v * 4, _O10) - 0.5) * 10;
        out[0] = g; out[1] = g; out[2] = g - 4;
        if (y % bh > bh - 3) { out[0] *= 0.65; out[1] *= 0.65; out[2] *= 0.65; }
      });
    }, { key: 'siding', repeat });
  },

  /** Hedge / foliage leaves (dark-to-light green clusters). */
  hedge({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(512, (ctx, s, rand) => {
      const dark = hexToRgb(0x23572f), light = hexToRgb(0x4f8f45);
      fillPixelsScaled(ctx, s, s, 2, 2, (u, v, out) => {
        const n = fbm2(u * 12, v * 12, _O11);
        mixRgb(out, dark, light, n);
      });
      for (let i = 0; i < s * 6; i++) {
        const x = rand() * s, y = rand() * s, r = 2 + rand() * 4;
        ctx.fillStyle = rand() < 0.5 ? 'rgba(20,60,25,0.45)' : 'rgba(120,180,90,0.35)';
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.6, rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }, { key: 'hedge', repeat });
  },

  /**
   * Chain-link fence (alpha). Use with transparent:false + alphaTest:0.5 and side:DoubleSide.
   * One tile = ~6 diamonds across; set repeat to (fenceLength/0.6, fenceHeight/0.6) or similar.
   */
  chainLink({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(128, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      ctx.strokeStyle = 'rgba(210,214,218,1)';
      ctx.lineWidth = Math.max(2, s / 40);
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(s, s);
      ctx.moveTo(s, 0); ctx.lineTo(0, s);
      ctx.moveTo(-s / 2, s / 2); ctx.lineTo(s / 2, -s / 2);
      ctx.moveTo(s / 2, s + s / 2); ctx.lineTo(s + s / 2, s / 2);
      ctx.moveTo(-s / 2, s / 2); ctx.lineTo(s / 2, s + s / 2);
      ctx.moveTo(s / 2, -s / 2); ctx.lineTo(s + s / 2, s / 2);
      ctx.stroke();
    }, { key: 'chainLink', repeat });
  },

  /** Tennis net mesh (alpha). Square grid; use alphaTest:0.5, side:DoubleSide. */
  tennisNet({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(64, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      ctx.fillStyle = 'rgba(30,30,32,1)';
      const lw = Math.max(2, s / 12);
      ctx.fillRect(0, 0, s, lw);
      ctx.fillRect(0, 0, lw, s);
    }, { key: 'tennisNet', repeat });
  },

  /** Generic greyscale fbm noise (data, not sRGB) — e.g. roughnessMap / bumpMap. */
  noise({ repeat = [1, 1], scale = 8 } = {}) {
    return createCanvasTexture(256, (ctx, s) => {
      const o = { octaves: 4, seed: 101, period: scale };
      fillPixels(ctx, s, s, (u, v, out) => {
        const g = fbm2(u * scale, v * scale, o) * 255;
        out[0] = g; out[1] = g; out[2] = g;
      });
    }, { key: `noise-${scale}`, repeat, srgb: false });
  },

  /** Soft radial blob (alpha) for fake contact shadows / glows. White with radial alpha. */
  radialBlob({ repeat = [1, 1] } = {}) {
    return createCanvasTexture(128, (ctx, s) => {
      const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }, { key: 'radialBlob', repeat, wrap: THREE.ClampToEdgeWrapping });
  },
};
