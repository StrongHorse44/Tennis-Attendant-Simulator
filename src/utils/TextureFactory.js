import * as THREE from 'three';

const SIZE = 256;
const canvasCache = new Map(); // key -> {colorCanvas, normalCanvas}

// Tileable speckle/blotch canvas: near-white base with darker blotches.
// Tileability trick: every blob is also drawn at the 8 wrap-around offsets.
function makeDetailCanvas({ blotches = 220, minR = 2, maxR = 8, depth = 0.12, base = 0.97 }) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  const b = Math.round(base * 255);
  ctx.fillStyle = `rgb(${b},${b},${b})`;
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < blotches; i++) {
    const x = Math.random() * SIZE, y = Math.random() * SIZE;
    const r = minR + Math.random() * (maxR - minR);
    const v = Math.round((base - Math.random() * depth) * 255);
    ctx.fillStyle = `rgba(${v},${v},${v},0.6)`;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      ctx.beginPath();
      ctx.arc(x + ox * SIZE, y + oy * SIZE, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return c;
}

// Horizontal plank/shingle stripes (tileable by construction)
function makeStripeCanvas({ stripes = 8, depth = 0.15, base = 0.95, jitter = 0.05 }) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d');
  const h = SIZE / stripes;
  for (let i = 0; i < stripes; i++) {
    const v = Math.round((base - Math.random() * jitter) * 255);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(0, i * h, SIZE, h);
    const g = Math.round((base - depth) * 255);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.fillRect(0, i * h, SIZE, 2); // groove line between planks
  }
  return c;
}

// Sobel height->normal map from a grayscale canvas. Wraps at edges (tileable).
function makeNormalCanvas(heightCanvas, strength = 1.0) {
  const s = heightCanvas.width;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, s, s).data;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(s, s);
  const hAt = (x, y) => src[(((y + s) % s) * s + ((x + s) % s)) * 4] / 255;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * strength;
      const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * s + x) * 4;
      out.data[i]     = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      out.data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      out.data[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

// Style presets. Canvases are cached per style; a NEW texture is created per
// call because texture.repeat is per-texture (textures share the same image).
const STYLES = {
  grass:    () => makeDetailCanvas({ blotches: 300, minR: 3, maxR: 10, depth: 0.14, base: 0.96 }),
  clay:     () => makeDetailCanvas({ blotches: 400, minR: 1, maxR: 3,  depth: 0.08, base: 0.98 }),
  concrete: () => makeDetailCanvas({ blotches: 250, minR: 1, maxR: 4,  depth: 0.10, base: 0.97 }),
  stucco:   () => makeDetailCanvas({ blotches: 350, minR: 1, maxR: 3,  depth: 0.07, base: 0.98 }),
  planks:   () => makeStripeCanvas({ stripes: 8,  depth: 0.15, base: 0.95 }),
  shingles: () => makeStripeCanvas({ stripes: 12, depth: 0.18, base: 0.93 }),
};

const NORMAL_STRENGTH = { grass: 1.5, clay: 0.8, concrete: 1.0, stucco: 1.2, planks: 2.0, shingles: 2.5 };

/**
 * Returns { map, normalMap } for a style, with repeat set for the surface
 * size (repeat ≈ one tile per ~4 world units).
 */
export function getSurfaceTextures(style, repeatX = 1, repeatY = 1) {
  if (!canvasCache.has(style)) {
    const colorCanvas = STYLES[style]();
    const normalCanvas = makeNormalCanvas(colorCanvas, NORMAL_STRENGTH[style]);
    canvasCache.set(style, { colorCanvas, normalCanvas });
  }
  const { colorCanvas, normalCanvas } = canvasCache.get(style);
  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(repeatX, repeatY);
  const normalMap = new THREE.CanvasTexture(normalCanvas);
  // normal maps stay linear — do NOT set SRGBColorSpace on them
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.repeat.set(repeatX, repeatY);
  return { map, normalMap };
}
