import * as THREE from 'three';
import { createCanvasTexture, seededRandom } from '../graphics/Textures.js';

/**
 * VenueArt — the canvas textures of a Junior Tour venue (Venues.js), drawn once per build and
 * disposed with the venue (never in the shared texture cache):
 *
 *   atlas (1024², one upload) — regions in 1024-px canvas coordinates, see ATLAS_PX:
 *     ws      the windscreen band: fence colour, weave, hems + grommets, sponsor lettering. The
 *             windscreen material uses a clone of the atlas (same GPU upload) with repeat /
 *             offset set so the court's tiled windscreen UVs (u tiles, v 0..1) land on this band.
 *     boardA / boardB  8 sponsor boards (stand fronts, courtside, scoreboard trims)
 *     sign    the club's name board (clubhouse)
 *     flag    4 flags (venue, tour, 2 sponsors)
 *     court   4 top-down practice courts (the venue's hard colour, clay, grass, blue)
 *     crowd   seated spectators with alpha (painted crowd strips on the back rows), tiles in u
 *   facade (+ its emissive twin) — a tiling window grid for city / campus / tower blocks:
 *     vertex colours tint the wall, the emissive map lights about half the windows at night.
 *   scoreboard (512 × 256) — redrawn on a score change only (drawScore).
 *
 * All sizes go through createCanvasTexture, so the tier's maxTextureSize clamps them (512 on
 * low); drawing code works in 1024-px units scaled to the real canvas.
 */

export const ATLAS_PX = 1024;
export const ATLAS = {
  ws: [0, 0, 1024, 256],
  boardA: [0, 256, 256, 128],     // + i * 256 (i = 0..3)
  boardB: [0, 384, 256, 128],
  sign: [0, 512, 1024, 128],
  flag: [0, 640, 256, 128],
  court: [0, 768, 256, 128],
  crowd: [0, 896, 1024, 128],
};
/** Crowd band tile: seats across one texture width (0.55 m a seat). */
export const CROWD_TILE_SEATS = 16;
export const CROWD_TILE_M = CROWD_TILE_SEATS * 0.55;

/**
 * Warm the 2D canvas text path (font lookup, glyph caches) once at load, so the first venue's
 * atlas doesn't pay ~100 ms for it behind the travel fade.
 */
export function primeCanvasText() {
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const ctx = c.getContext('2d');
    for (const f of [SERIF, SANS]) {
      ctx.font = `bold 20px ${f}`;
      ctx.measureText('JUNIOR TOUR');
      ctx.fillText('JT 15', 2, 20);
    }
  } catch (e) { /* no canvas */ }
}

/** UV rectangle [u0, v0, u1, v1] of an atlas region (i = index along the row), inset by `pad` px. */
export function atlasUV(name, i = 0, pad = 2) {
  const [x0, y0, w, h] = ATLAS[name];
  const x = x0 + i * w;
  return [(x + pad) / ATLAS_PX, 1 - (y0 + h - pad) / ATLAS_PX, (x + w - pad) / ATLAS_PX, 1 - (y0 + pad) / ATLAS_PX];
}

const hex = (c) => `#${new THREE.Color(c).getHexString()}`;
function shadeHex(c, k) {
  const col = new THREE.Color(c);
  if (k >= 0) col.lerp(new THREE.Color(1, 1, 1), k); else col.multiplyScalar(1 + k);
  return `#${col.getHexString()}`;
}
function lum(c) {
  const col = new THREE.Color(c);
  return 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
}

function fitText(ctx, text, maxW, size, weight, family) {
  let s = size;
  ctx.font = `${weight} ${Math.round(s)}px ${family}`;
  while (s > 8 && ctx.measureText(text).width > maxW) {
    s *= 0.92;
    ctx.font = `${weight} ${Math.round(s)}px ${family}`;
  }
  return s;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = '"Inter", "Helvetica Neue", Arial, sans-serif';

/**
 * The venue atlas. v = the venue definition (Venues: { id, name, short, surface, look }).
 * pal = resolved palette { fence, accent, text, court, surround, clubColor, roof } (hex numbers).
 */
export function venueAtlasTexture(v, pal) {
  const look = v.look;
  const serif = look.clubhouse.style === 'lodge' || look.clubhouse.style === 'pavilion' || look.clubhouse.style === 'boathouse';
  const family = serif ? SERIF : SANS;
  const sponsors = look.sponsors.length ? look.sponsors : [v.short.toUpperCase()];
  let seed = 7;
  for (let i = 0; i < v.id.length; i++) seed = (seed * 31 + v.id.charCodeAt(i)) >>> 0;
  const tex = createCanvasTexture(ATLAS_PX, (ctx, W, rand) => {
    const k = W / ATLAS_PX;
    ctx.save();
    ctx.scale(k, k);
    ctx.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    drawWindscreen(ctx, v, pal, sponsors, family, rand);
    for (let i = 0; i < 8; i++) drawBoard(ctx, i, v, pal, sponsors, family);
    drawSign(ctx, v, pal, family);
    for (let i = 0; i < 4; i++) drawFlag(ctx, i, v, pal, sponsors);
    for (let i = 0; i < 4; i++) drawCourt(ctx, i, pal);
    drawCrowd(ctx, pal, rand);
    ctx.restore();
  }, { seed });
  tex.name = `venueAtlas:${v.id}`;
  return tex;
}

function drawWindscreen(ctx, v, pal, sponsors, family, rand) {
  const [x0, y0, w, h] = ATLAS.ws;
  const bg = hex(pal.fence);
  ctx.fillStyle = bg;
  ctx.fillRect(x0, y0, w, h);
  // fabric weave
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#000000';
  for (let x = 0; x < w; x += 3) ctx.fillRect(x0 + x, y0, 1, h);
  ctx.fillStyle = '#ffffff';
  for (let y = 0; y < h; y += 3) ctx.fillRect(x0, y0 + y, w, 1);
  ctx.globalAlpha = 1;
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(x0 + rand() * w, y0 + rand() * h, 2 + rand() * 30, 1 + rand() * 2);
  }
  // hems + grommets
  const hem = Math.round(h * 0.09);
  ctx.fillStyle = shadeHex(pal.fence, -0.3);
  ctx.fillRect(x0, y0, w, hem);
  ctx.fillRect(x0, y0 + h - hem, w, hem);
  ctx.fillStyle = '#c9c2a8';
  for (let x = 24; x < w; x += 64) {
    for (const y of [hem / 2, h - hem / 2]) {
      ctx.beginPath();
      ctx.arc(x0 + x, y0 + y, h * 0.018, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // lettering: the venue in the middle, a sponsor either side (the band tiles every ~8 m)
  const light = lum(pal.fence) < 0.35;
  const ink = light ? 'rgba(255,250,236,0.86)' : 'rgba(20,24,28,0.82)';
  const accent = hex(pal.accent);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const s1 = sponsors[1 % sponsors.length], s2 = sponsors[(2 % sponsors.length)] || sponsors[0];
  const slots = [[w * 0.17, s1, 0.2], [w * 0.5, v.short.toUpperCase(), 0.27], [w * 0.83, s2, 0.2]];
  for (const [cx, text, size] of slots) {
    ctx.fillStyle = text === v.short.toUpperCase() ? ink : accent;
    const fs = fitText(ctx, text, w * 0.3, h * size, 'bold', family);
    ctx.fillText(text, x0 + cx, y0 + h * 0.47);
    if (text === v.short.toUpperCase()) {
      ctx.font = `${Math.round(fs * 0.36)}px ${family}`;
      ctx.fillStyle = light ? 'rgba(255,250,236,0.55)' : 'rgba(20,24,28,0.55)';
      ctx.fillText('JUNIOR TENNIS TOUR', x0 + cx, y0 + h * 0.7);
    }
  }
  // dividers
  ctx.fillStyle = light ? 'rgba(255,250,236,0.25)' : 'rgba(0,0,0,0.2)';
  ctx.fillRect(x0 + w * 0.335, y0 + h * 0.3, 2, h * 0.4);
  ctx.fillRect(x0 + w * 0.665, y0 + h * 0.3, 2, h * 0.4);
}

const BOARD_STYLES = [
  ['#ffffff', '#1b2a3a'], ['#1b2a3a', '#ffffff'], ['#f4e8c1', '#2d5a3d'], ['#c23b4e', '#ffffff'],
  ['#2f6db3', '#ffffff'], ['#ffffff', '#c8663c'], ['#10281b', '#d9a441'], ['#f2c14e', '#1b2a3a'],
];

function drawBoard(ctx, i, v, pal, sponsors, family) {
  const row = i < 4 ? ATLAS.boardA : ATLAS.boardB;
  const x = row[0] + (i % 4) * row[2], y = row[1], w = row[2], h = row[3];
  let bg, fg, text;
  if (i === 0) { bg = hex(pal.fence); fg = '#fff8e6'; text = v.short.toUpperCase(); }
  else if (i === 4) { bg = '#10281b'; fg = '#d9a441'; text = 'JUNIOR TOUR'; }
  else {
    [bg, fg] = BOARD_STYLES[(i * 3 + v.id.length) % BOARD_STYLES.length];
    text = sponsors[(i - (i > 4 ? 2 : 1)) % sponsors.length];
  }
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, text, w * 0.86, h * 0.36, 'bold', family);
  ctx.fillText(text, x + w / 2, y + h * 0.5);
  if (i === 4) {
    ctx.fillStyle = 'rgba(217,164,65,0.6)';
    ctx.fillRect(x + w * 0.2, y + h * 0.74, w * 0.6, 3);
  }
}

function drawSign(ctx, v, pal, family) {
  const [x, y, w, h] = ATLAS.sign;
  const bg = hex(pal.signBg), fg = hex(pal.signFg), gold = '#d9a441';
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = gold;
  ctx.lineWidth = h * 0.05;
  ctx.strokeRect(x + h * 0.08, y + h * 0.08, w - h * 0.16, h - h * 0.16);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const name = v.name.toUpperCase();
  fitText(ctx, name, w * 0.86, h * 0.44, 'bold', family);
  try { ctx.letterSpacing = '3px'; } catch (e) { /* older canvas */ }
  ctx.fillText(name, x + w / 2, y + h * 0.53);
  try { ctx.letterSpacing = '0px'; } catch (e) { /* noop */ }
}

function drawFlag(ctx, i, v, pal, sponsors) {
  const [fx, y, w, h] = ATLAS.flag;
  const x = fx + i * w;
  if (i === 0) {
    // venue flag: two colour bands and the initials
    ctx.fillStyle = hex(pal.fence);
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hex(pal.accent);
    ctx.fillRect(x, y + h * 0.72, w, h * 0.28);
    ctx.fillStyle = '#fff8e6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ini = v.short.split(/\s+/).map(s => s[0]).join('').slice(0, 3).toUpperCase();
    ctx.font = `bold ${Math.round(h * 0.42)}px ${SERIF}`;
    ctx.fillText(ini, x + w * 0.5, y + h * 0.38);
  } else if (i === 1) {
    // tour flag: cream with the gold ball emblem
    ctx.fillStyle = '#f4e8c1';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#2d5a3d';
    ctx.fillRect(x, y, w * 0.18, h);
    ctx.fillStyle = '#d9a441';
    ctx.beginPath();
    ctx.arc(x + w * 0.55, y + h * 0.5, h * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f4e8c1';
    ctx.lineWidth = h * 0.04;
    ctx.beginPath();
    ctx.arc(x + w * 0.55 - h * 0.34, y + h * 0.5, h * 0.3, -0.7, 0.7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w * 0.55 + h * 0.34, y + h * 0.5, h * 0.3, Math.PI - 0.7, Math.PI + 0.7);
    ctx.stroke();
  } else {
    const [bg, fg] = BOARD_STYLES[(i * 5 + v.id.length) % BOARD_STYLES.length];
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const t = sponsors[(i + 1) % sponsors.length];
    fitText(ctx, t, w * 0.84, h * 0.3, 'bold', SANS);
    ctx.fillText(t, x + w / 2, y + h / 2);
  }
}

function drawCourt(ctx, i, pal) {
  const [cx0, y, w, h] = ATLAS.court;
  const x = cx0 + i * w;
  // the court's long axis runs across the region (36.6 m ↔ 256 px, 18.3 m ↔ 128 px)
  const s = w / 36.6;
  const colors = [
    [hex(pal.surround), hex(pal.court)],
    ['#c8663c', '#c8663c'],
    ['#4f8a3c', '#5a953f'],
    ['#3f7d55', '#2f6db3'],
  ][i];
  ctx.fillStyle = colors[0];
  ctx.fillRect(x, y, w, h);
  const L = 23.77 * s, W = 10.97 * s, SW = 8.23 * s, SL = 6.4 * s;
  const cx = x + w / 2, cy = y + h / 2;
  ctx.fillStyle = colors[1];
  ctx.fillRect(cx - L / 2, cy - W / 2, L, W);
  ctx.strokeStyle = '#f4f1e8';
  ctx.lineWidth = Math.max(1.2, 0.08 * s * 2);
  ctx.strokeRect(cx - L / 2, cy - W / 2, L, W);
  ctx.strokeRect(cx - L / 2, cy - SW / 2, L, SW);
  ctx.beginPath();
  ctx.moveTo(cx - SL, cy - SW / 2); ctx.lineTo(cx - SL, cy + SW / 2);
  ctx.moveTo(cx + SL, cy - SW / 2); ctx.lineTo(cx + SL, cy + SW / 2);
  ctx.moveTo(cx - SL, cy); ctx.lineTo(cx + SL, cy);
  ctx.stroke();
  // net shadow
  ctx.fillStyle = 'rgba(20,24,20,0.55)';
  ctx.fillRect(cx - 1, cy - W / 2 - 3, 2, W + 6);
}

/** Seated spectators (alpha): shirts, heads, hair, a few empty seats; tiles across the band. */
function drawCrowd(ctx, pal, rand) {
  const [x0, y0, w, h] = ATLAS.crowd;
  ctx.clearRect(x0, y0, w, h);
  const shirts = ['#f4efe6', '#e9dfc6', '#2f3e5c', '#8fae8b', '#9cc3e0', '#e8b4b8', '#d9a441', '#2d5a3d',
    '#c23b4e', '#ffffff', '#1b2a3a', hex(pal.accent), hex(pal.fence)];
  const skins = ['#f1c9a5', '#d9a47e', '#a8744f', '#7a4f33'];
  const hairs = ['#2a1d14', '#5b3a22', '#c9a15a', '#8a8580', '#1a1a1a'];
  const cell = w / CROWD_TILE_SEATS;
  for (let i = 0; i < CROWD_TILE_SEATS; i++) {
    if (rand() < 0.08) continue;                       // an empty seat
    const cx = x0 + (i + 0.5) * cell + (rand() - 0.5) * cell * 0.12;
    const lean = (rand() - 0.5) * 0.12;
    const tall = 0.9 + rand() * 0.18;
    const shirt = shirts[(rand() * shirts.length) | 0];
    const skin = skins[(rand() * skins.length) | 0];
    const base = y0 + h;
    const torsoH = h * 0.5 * tall, torsoW = cell * 0.62;
    const top = base - torsoH;
    // torso + shoulders
    ctx.fillStyle = shirt;
    roundRect(ctx, cx - torsoW / 2 + lean * 20, top, torsoW, torsoH + 2, cell * 0.16);
    ctx.fill();
    // arms at the sides
    ctx.fillStyle = shadeHex(shirt, -0.12);
    ctx.fillRect(cx - torsoW / 2 - 2 + lean * 20, top + torsoH * 0.18, cell * 0.12, torsoH * 0.55);
    ctx.fillRect(cx + torsoW / 2 - cell * 0.12 + 2 + lean * 20, top + torsoH * 0.18, cell * 0.12, torsoH * 0.55);
    // neck + head
    const hr = cell * 0.2 * tall;
    const hx = cx + lean * 28, hy = top - hr * 0.95;
    ctx.fillStyle = skin;
    ctx.fillRect(hx - hr * 0.35, hy + hr * 0.5, hr * 0.7, hr * 0.7);
    ctx.beginPath();
    ctx.arc(hx, hy, hr, 0, Math.PI * 2);
    ctx.fill();
    // hair / a cap now and then
    const r = rand();
    ctx.fillStyle = r < 0.2 ? shirts[(rand() * shirts.length) | 0] : hairs[(rand() * hairs.length) | 0];
    ctx.beginPath();
    ctx.arc(hx, hy - hr * 0.12, hr * 1.02, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    if (r < 0.2) ctx.fillRect(hx - hr * 0.2, hy - hr * 0.45, hr * 1.5, hr * 0.28);
  }
}

/**
 * Facade tile (map) and its emissive twin: `style` 'apartment' (brick-ish, balconies),
 * 'campus' (cream panels, wide windows) or 'tower' (glass office grid, many lit windows).
 * 4 × 4 windows a tile: one tile = FACADE_TILE_M metres square on a building.
 */
export const FACADE_TILE_M = 12;
export function facadeTextures(style, seed = 1) {
  const cols = 4, rows = 4;
  const lit = [];
  const r0 = seededRandom(seed * 7 + 3);
  const litFrac = style === 'tower' ? 0.55 : style === 'campus' ? 0.4 : 0.45;
  for (let i = 0; i < cols * rows; i++) lit.push(r0() < litFrac ? 0.55 + r0() * 0.45 : 0);
  const draw = (emissive) => (ctx, S, rand) => {
    const cw = S / cols, ch = S / rows;
    if (emissive) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, S, S);
    } else {
      // wall (white-ish: the vertex colour tints it) with a little grain
      ctx.fillStyle = style === 'tower' ? '#9aa4ad' : '#efe9df';
      ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < S * 3; i++) {
        ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)';
        ctx.fillRect(rand() * S, rand() * S, 1 + rand() * 2, 1 + rand() * 2);
      }
      if (style === 'apartment') {
        // brick courses
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        for (let y = 0; y < S; y += Math.max(2, S / 96)) ctx.fillRect(0, y, S, 1);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw, y = r * ch;
        let wx, wy, ww, wh;
        if (style === 'tower') { wx = x + cw * 0.06; ww = cw * 0.88; wy = y + ch * 0.14; wh = ch * 0.7; }
        else if (style === 'campus') { wx = x + cw * 0.1; ww = cw * 0.8; wy = y + ch * 0.22; wh = ch * 0.5; }
        else { wx = x + cw * 0.24; ww = cw * 0.52; wy = y + ch * 0.2; wh = ch * 0.56; }
        const L = lit[r * cols + c];
        if (emissive) {
          if (L > 0) {
            ctx.fillStyle = `rgba(255,${(205 + L * 30) | 0},${(140 + L * 50) | 0},${0.55 + L * 0.45})`;
            ctx.fillRect(wx + 2, wy + 2, ww - 4, wh - 4);
          }
          continue;
        }
        // frame, glass with a sky gradient, mullion
        ctx.fillStyle = style === 'tower' ? '#2c3440' : '#f7f3ea';
        ctx.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
        const g = ctx.createLinearGradient(0, wy, 0, wy + wh);
        g.addColorStop(0, style === 'tower' ? '#5d7a92' : '#6f8ea6');
        g.addColorStop(1, style === 'tower' ? '#233344' : '#2f4152');
        ctx.fillStyle = g;
        ctx.fillRect(wx, wy, ww, wh);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(wx + ww * 0.08, wy + wh * 0.08, ww * 0.18, wh * 0.84);
        ctx.fillStyle = style === 'tower' ? '#2c3440' : '#f7f3ea';
        ctx.fillRect(wx + ww / 2 - 1, wy, 2, wh);
        if (style === 'apartment' && r % 2 === 1) {
          // balcony rail under every other row
          ctx.fillStyle = 'rgba(40,44,48,0.8)';
          ctx.fillRect(wx - cw * 0.06, wy + wh + 1, ww + cw * 0.12, Math.max(2, ch * 0.05));
        }
      }
    }
  };
  const size = 256;
  const map = createCanvasTexture(size, draw(false), { seed });
  const emissive = createCanvasTexture(size, draw(true), { seed });
  map.name = `venueFacade:${style}`;
  emissive.name = `venueFacadeEm:${style}`;
  return { map, emissive };
}

/** The scoreboard canvas (512 × 256) + texture; redraw with drawScore / drawIdle. */
export function scoreboardCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.name = 'venueScoreboard';
  return { canvas, ctx: canvas.getContext('2d'), tex };
}

function scoreFrame(ctx, title, pal) {
  ctx.fillStyle = '#0d1520';
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = hex(pal.accent);
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, 496, 240);
  ctx.globalAlpha = 1;
  ctx.fillStyle = hex(pal.accent);
  ctx.font = `600 28px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  try { ctx.letterSpacing = '4px'; } catch (e) { /* older canvas */ }
  ctx.fillText(title, 256, 46, 460);
  try { ctx.letterSpacing = '0px'; } catch (e) { /* noop */ }
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(40, 60, 432, 2);
}

/** Idle face: the venue, the tour. */
export function drawScoreIdle(sb, v, pal) {
  const ctx = sb.ctx;
  scoreFrame(ctx, v.short.toUpperCase(), pal);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4e8c1';
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText('JUNIOR TENNIS TOUR', 256, 138, 460);
  ctx.fillStyle = 'rgba(244,232,193,0.6)';
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText('WELCOME', 256, 188);
  sb.tex.needsUpdate = true;
}

/** Score face: o = { names, games, points, server, sets } (the Stadium.setScoreOverride shape). */
export function drawScore(sb, v, pal, o) {
  const ctx = sb.ctx;
  scoreFrame(ctx, v.short.toUpperCase(), pal);
  const sets = o.s0 + o.s1 > 0;
  const xg = sets ? 400 : 390, xs = 312, nameW = (sets ? xs - 44 : xg - 58) - 52;
  ctx.font = `600 16px ${SANS}`;
  ctx.fillStyle = 'rgba(244,232,193,0.55)';
  ctx.textAlign = 'right';
  if (sets) ctx.fillText('SETS', xs, 90);
  ctx.fillText('GAMES', xg, 90);
  ctx.fillText('PTS', 482, 90);
  for (let i = 0; i < 2; i++) {
    const y = 140 + i * 66;
    ctx.textAlign = 'left';
    ctx.font = `600 34px ${SANS}`;
    ctx.fillStyle = '#f4e8c1';
    ctx.fillText(String((i === 0 ? o.n0 : o.n1) ?? '').toUpperCase(), 52, y, nameW);
    if (o.server === i) {
      ctx.fillStyle = '#d8e04e';
      ctx.beginPath();
      ctx.arc(32, y - 11, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.textAlign = 'right';
    if (sets) {
      ctx.fillStyle = 'rgba(244,232,193,0.8)';
      ctx.fillText(String(i === 0 ? o.s0 : o.s1), xs, y);
    }
    ctx.fillStyle = '#ffe39a';
    ctx.fillText(String(i === 0 ? o.g0 : o.g1), xg, y);
    ctx.fillStyle = '#f4e8c1';
    ctx.fillText(String((i === 0 ? o.p0 : o.p1) ?? ''), 482, y, 76);
  }
  sb.tex.needsUpdate = true;
}
