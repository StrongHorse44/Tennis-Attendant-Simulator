import * as THREE from 'three';
import { createCanvasTexture, fbm2 } from '../graphics/Textures.js';
import { drawBoard, roundRect, drawCrest } from './Building.js';

/**
 * InteriorArt — procedural canvas textures for building interiors (generated once, cached):
 *  - tile():   glazed floor / wall tiles with grout (colour map, tinted per room by vertex colour)
 *  - rubber(): speckled gym flooring
 *  - carpet(): soft woven carpet
 *  - atlas():  one 1024 px atlas holding framed club photos, signs, the café menu board, an oil
 *              painting, the champions honour board, posters and a clock face. Regions: ART.
 */

export const ART_PX = 1024;

/** Atlas regions [x, y, w, h] in 1024 px canvas coordinates (y from the top). */
export const ART = {
  photo0: [0, 0, 244, 176], photo1: [256, 0, 244, 176], photo2: [512, 0, 244, 176], photo3: [768, 0, 244, 176],
  photo4: [0, 184, 244, 176], photo5: [256, 184, 244, 176], photo6: [512, 184, 244, 176], photo7: [768, 184, 244, 176],
  chalk: [0, 368, 360, 252],
  painting: [368, 368, 330, 252],
  honor: [704, 368, 320, 252],
  fitness: [0, 628, 512, 96],
  pool: [512, 628, 512, 96],
  men: [0, 730, 168, 84],
  women: [176, 730, 200, 84],
  lockers: [384, 730, 320, 84],
  cafe: [712, 730, 312, 84],
  lounge: [0, 820, 380, 84],
  reception: [388, 820, 300, 84],
  snack: [696, 820, 328, 84],
  poster: [0, 910, 250, 112],
  rules: [258, 910, 250, 112],
  clock: [516, 910, 110, 110],
  crest: [634, 910, 112, 112],
  studio: [754, 910, 270, 112],
};

/** UV rectangle [u0, v0, u1, v1] of a region (2 px inset against bleeding). */
export function artUV(name) {
  const [x, y, w, h] = ART[name];
  const pad = 2;
  return [(x + pad) / ART_PX, 1 - (y + h - pad) / ART_PX, (x + w - pad) / ART_PX, 1 - (y + pad) / ART_PX];
}

/** Height / width of a region. */
export function artAspect(name) {
  const r = ART[name];
  return r[3] / r[2];
}

// ───────────────────────────── surface textures ─────────────────────────────

function tile() {
  return createCanvasTexture(256, (ctx, S, rand) => {
    const n = 4, t = S / n;
    ctx.fillStyle = '#b9b2a4';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const k = 236 + ((rand() * 14) | 0);
      ctx.fillStyle = `rgb(${k},${k - 3},${k - 10})`;
      ctx.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
      // glaze highlight
      const g = ctx.createLinearGradient(i * t, j * t, i * t + t, j * t + t);
      g.addColorStop(0, 'rgba(255,255,255,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0.05)');
      ctx.fillStyle = g;
      ctx.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
    }
    // faint speckle
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(90,80,70,0.08)' : 'rgba(255,255,255,0.1)';
      ctx.fillRect(rand() * S, rand() * S, 1.5, 1.5);
    }
  }, { key: 'bld-tile', seed: 41 });
}

function rubber() {
  return createCanvasTexture(256, (ctx, S, rand) => {
    ctx.fillStyle = '#3a3e42';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < S * 12; i++) {
      const r = rand();
      ctx.fillStyle = r < 0.08 ? 'rgba(90,150,110,0.8)' : r < 0.14 ? 'rgba(210,200,180,0.6)' : r < 0.6 ? 'rgba(20,22,24,0.5)' : 'rgba(95,100,105,0.5)';
      const sz = 1 + rand() * 2;
      ctx.fillRect(rand() * S, rand() * S, sz, sz);
    }
    // mat seams (1 m tiles at uvTile 2 → 2 per texture)
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, S, 2); ctx.fillRect(0, S / 2 - 1, S, 2);
    ctx.fillRect(0, 0, 2, S); ctx.fillRect(S / 2 - 1, 0, 2, S);
  }, { key: 'bld-rubber', seed: 43 });
}

function carpet() {
  return createCanvasTexture(256, (ctx, S, rand) => {
    ctx.fillStyle = '#e8e2d6';
    ctx.fillRect(0, 0, S, S);
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    const opt = { octaves: 3, seed: 9, period: 8 };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = fbm2((x / S) * 8, (y / S) * 8, opt);
      const weave = ((x + y) % 4 < 2 ? 6 : -6) + (rand() - 0.5) * 14;
      const v = 220 + n * 30 + weave;
      const i = (y * S + x) * 4;
      d[i] = v; d[i + 1] = v - 4; d[i + 2] = v - 12; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, { key: 'bld-carpet', seed: 47 });
}

// ───────────────────────────── atlas drawing ─────────────────────────────

function sepiaFrame(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#e9d8b4');
  g.addColorStop(1, '#b89c70');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function figure(ctx, x, y, s, col = '#4a3a28') {
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(x, y - s * 1.55, s * 0.28, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(x - s * 0.3, y - s * 1.25, s * 0.6, s * 0.75);
  ctx.fillStyle = '#f3ead6';
  ctx.fillRect(x - s * 0.32, y - s * 0.55, s * 0.64, s * 0.3); // white shorts/skirt
  ctx.fillStyle = col;
  ctx.fillRect(x - s * 0.24, y - s * 0.28, s * 0.16, s * 0.3);
  ctx.fillRect(x + s * 0.08, y - s * 0.28, s * 0.16, s * 0.3);
}

function drawPhoto(ctx, [x, y, w, h], k, rand) {
  // mat + photo
  ctx.fillStyle = '#f6f0e2';
  ctx.fillRect(x, y, w, h);
  const px = x + w * 0.08, py = y + h * 0.1, pw = w * 0.84, ph = h * 0.8;
  sepiaFrame(ctx, px, py, pw, ph);
  ctx.save();
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  const ink = '#4a3a28';
  const kind = k % 4;
  if (kind === 0 || kind === 2) {
    // court in perspective with net and two players
    ctx.fillStyle = 'rgba(120,95,60,0.45)';
    ctx.beginPath();
    ctx.moveTo(px + pw * 0.3, py + ph * 0.35); ctx.lineTo(px + pw * 0.7, py + ph * 0.35);
    ctx.lineTo(px + pw * 1.05, py + ph); ctx.lineTo(px - pw * 0.05, py + ph); ctx.fill();
    ctx.strokeStyle = 'rgba(250,240,220,0.8)'; ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(60,45,30,0.7)';
    ctx.fillRect(px + pw * 0.15, py + ph * 0.58, pw * 0.7, ph * 0.06);
    figure(ctx, px + pw * (kind ? 0.32 : 0.62), py + ph * 0.5, ph * 0.13, ink);
    figure(ctx, px + pw * (kind ? 0.6 : 0.38), py + ph * 0.95, ph * 0.22, ink);
    // trees on the horizon
    ctx.fillStyle = 'rgba(70,55,35,0.55)';
    for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.arc(px + pw * (i / 8), py + ph * 0.33, ph * (0.06 + rand() * 0.06), 0, Math.PI * 2); ctx.fill(); }
  } else if (kind === 1) {
    // team photo: two rows
    ctx.fillStyle = 'rgba(95,75,50,0.35)';
    ctx.fillRect(px, py + ph * 0.72, pw, ph * 0.28);
    const n = 6;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < n - row; i++) {
        const fx = px + pw * ((i + 0.5 + row * 0.5) / n), fy = py + ph * (row ? 0.98 : 0.8);
        figure(ctx, fx, fy, ph * (row ? 0.3 : 0.26), ink);
      }
    }
    // trophy in front
    ctx.fillStyle = '#8a6a2a';
    ctx.fillRect(px + pw * 0.47, py + ph * 0.75, pw * 0.06, ph * 0.18);
  } else {
    // the clubhouse, circa 1962
    ctx.fillStyle = 'rgba(90,70,45,0.5)';
    ctx.beginPath(); ctx.moveTo(px + pw * 0.12, py + ph * 0.5); ctx.lineTo(px + pw * 0.5, py + ph * 0.2); ctx.lineTo(px + pw * 0.88, py + ph * 0.5); ctx.fill();
    ctx.fillStyle = 'rgba(245,232,205,0.9)';
    ctx.fillRect(px + pw * 0.16, py + ph * 0.5, pw * 0.68, ph * 0.34);
    ctx.fillStyle = 'rgba(70,55,35,0.7)';
    for (let i = 0; i < 5; i++) ctx.fillRect(px + pw * (0.22 + i * 0.12), py + ph * 0.58, pw * 0.06, ph * 0.12);
    ctx.fillRect(px + pw * 0.46, py + ph * 0.66, pw * 0.08, ph * 0.18);
    ctx.fillStyle = 'rgba(95,75,50,0.45)';
    ctx.fillRect(px, py + ph * 0.84, pw, ph * 0.16);
  }
  // vignette / age
  const v = ctx.createRadialGradient(px + pw / 2, py + ph / 2, ph * 0.2, px + pw / 2, py + ph / 2, pw * 0.7);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(60,40,20,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(px, py, pw, ph);
  ctx.restore();
  // caption plate
  ctx.fillStyle = '#c9a54c';
  ctx.fillRect(x + w * 0.38, y + h * 0.925, w * 0.24, h * 0.05);
}

function drawChalk(ctx, [x, y, w, h]) {
  ctx.fillStyle = '#6b4a2e';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2b3230';
  ctx.fillRect(x + 12, y + 12, w - 24, h - 24);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 8; i++) ctx.fillRect(x + 20 + i * 40, y + 16, 22, h - 32);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f3eee2';
  ctx.font = `italic bold ${Math.round(h * 0.13)}px Georgia, serif`;
  ctx.fillText('Café Menu', x + w / 2, y + h * 0.17);
  ctx.strokeStyle = 'rgba(243,238,226,0.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + w * 0.2, y + h * 0.27); ctx.lineTo(x + w * 0.8, y + h * 0.27); ctx.stroke();
  const items = [['Iced Tea', '3'], ['Arnold Palmer', '4'], ['Espresso', '3'], ['Club Sandwich', '12'], ['Fruit Cup', '6']];
  ctx.font = `${Math.round(h * 0.075)}px 'Trebuchet MS', Arial, sans-serif`;
  items.forEach(([n, p], i) => {
    const yy = y + h * (0.38 + i * 0.11);
    ctx.textAlign = 'left'; ctx.fillStyle = i % 2 ? '#f2d58a' : '#f3eee2';
    ctx.fillText(n, x + w * 0.14, yy);
    ctx.textAlign = 'right'; ctx.fillText(p, x + w * 0.86, yy);
  });
}

function drawPainting(ctx, [x, y, w, h], rand) {
  ctx.fillStyle = '#8a6a2a';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#c9a54c';
  ctx.fillRect(x + 6, y + 6, w - 12, h - 12);
  const px = x + 16, py = y + 16, pw = w - 32, ph = h - 32;
  const sky = ctx.createLinearGradient(0, py, 0, py + ph * 0.6);
  sky.addColorStop(0, '#6f9cc4'); sky.addColorStop(1, '#f1d6a6');
  ctx.fillStyle = sky; ctx.fillRect(px, py, pw, ph);
  const hill = (base, col, amp) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(px, py + ph);
    for (let i = 0; i <= 20; i++) ctx.lineTo(px + (pw * i) / 20, py + ph * base - Math.sin(i * 0.7 + base * 9) * ph * amp);
    ctx.lineTo(px + pw, py + ph); ctx.fill();
  };
  hill(0.55, '#7d9a6a', 0.06); hill(0.68, '#5b7f4c', 0.05); hill(0.82, '#46703c', 0.04);
  ctx.fillStyle = '#2f5530';
  for (let i = 0; i < 14; i++) { ctx.beginPath(); ctx.arc(px + rand() * pw, py + ph * (0.62 + rand() * 0.2), ph * 0.04, 0, Math.PI * 2); ctx.fill(); }
  // brush texture
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rand() * 0.06})`;
    ctx.fillRect(px + rand() * pw, py + rand() * ph, 3 + rand() * 6, 1.5);
  }
}

function drawHonor(ctx, [x, y, w, h], rand) {
  ctx.fillStyle = '#5a3a22';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#6e4a2c';
  ctx.fillRect(x + 10, y + 10, w - 20, h - 20);
  ctx.strokeStyle = '#c9a54c'; ctx.lineWidth = 3;
  ctx.strokeRect(x + 16, y + 16, w - 32, h - 32);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e9c979';
  ctx.font = `bold ${Math.round(h * 0.085)}px Georgia, serif`;
  ctx.fillText('CLUB CHAMPIONS', x + w / 2, y + h * 0.14);
  ctx.font = `${Math.round(h * 0.052)}px Georgia, serif`;
  const names = ['Whitmore', 'Ashford', 'Delacroix', 'Pembrook', 'Harrington', 'Vance', 'Castellano', 'Brooks', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka'];
  for (let i = 0; i < 12; i++) {
    const col = i % 2, row = i >> 1;
    const yy = y + h * (0.27 + row * 0.115);
    const xx = x + w * (col ? 0.74 : 0.27);
    ctx.fillText(`${1962 + i * 5}  ${names[i]}`, xx, yy);
  }
}

function drawPoster(ctx, [x, y, w, h]) {
  ctx.fillStyle = '#2d5a3d';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d9a441';
  ctx.beginPath(); ctx.arc(x + w * 0.2, y + h * 0.5, h * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2d5a3d';
  ctx.beginPath(); ctx.arc(x + w * 0.2, y + h * 0.5, h * 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d4e157';
  ctx.beginPath(); ctx.arc(x + w * 0.2, y + h * 0.5, h * 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4e8c1';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(h * 0.2)}px 'Trebuchet MS', Arial, sans-serif`;
  ctx.fillText('TRAIN', x + w * 0.42, y + h * 0.28);
  ctx.fillText('PLAY', x + w * 0.42, y + h * 0.52);
  ctx.fillStyle = '#d9a441';
  ctx.fillText('REPEAT', x + w * 0.42, y + h * 0.76);
}

function drawRules(ctx, [x, y, w, h]) {
  ctx.fillStyle = '#f7f5ef';
  roundRect(ctx, x, y, w, h, 10); ctx.fill();
  ctx.fillStyle = '#2f6db3';
  ctx.fillRect(x, y, w, h * 0.26);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(h * 0.17)}px 'Trebuchet MS', Arial, sans-serif`;
  ctx.fillText('POOL RULES', x + w / 2, y + h * 0.14);
  ctx.fillStyle = '#2b4a6b';
  ctx.font = `${Math.round(h * 0.1)}px 'Trebuchet MS', Arial, sans-serif`;
  ['No running on deck', 'Shower before swimming', 'No glass by the pool', 'Swim at your own risk'].forEach((t, i) => ctx.fillText(t, x + w / 2, y + h * (0.38 + i * 0.16)));
}

function drawClock(ctx, [x, y, w]) {
  const cx = x + w / 2, cy = y + w / 2, R = w * 0.46;
  ctx.fillStyle = '#2b2b2b'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f7f1e3'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.88, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#2b2b2b';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.lineWidth = i % 3 ? 2 : 4;
    ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R * 0.72, cy - Math.cos(a) * R * 0.72); ctx.lineTo(cx + Math.sin(a) * R * 0.82, cy - Math.cos(a) * R * 0.82); ctx.stroke();
  }
  ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * 0.35, cy - R * 0.25); ctx.stroke();
  ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - R * 0.1, cy - R * 0.62); ctx.stroke();
}

function drawStudio(ctx, [x, y, w, h]) {
  ctx.fillStyle = '#e9dcc3';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#7d9c83'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x + h * 0.55, y + h * 0.5, h * 0.3, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x + h * 0.55, y + h * 0.5, h * 0.15, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#4a6b53';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `italic ${Math.round(h * 0.34)}px Georgia, serif`;
  ctx.fillText('breathe', x + h * 1.05, y + h * 0.52);
}

function atlas() {
  return createCanvasTexture(ART_PX, (ctx, S, rand) => {
    ctx.save();
    ctx.scale(S / ART_PX, S / ART_PX);
    ctx.fillStyle = '#6b4a2e';
    ctx.fillRect(0, 0, ART_PX, ART_PX);
    for (let k = 0; k < 8; k++) drawPhoto(ctx, ART[`photo${k}`], k, rand);
    drawChalk(ctx, ART.chalk);
    drawPainting(ctx, ART.painting, rand);
    drawHonor(ctx, ART.honor, rand);
    drawBoard(ctx, ART.fitness, 'FITNESS & WELLNESS', 'GREENBRIAR TENNIS CLUB');
    drawBoard(ctx, ART.pool, 'POOL HOUSE', 'SWIM  ·  SUN  ·  SNACKS');
    drawBoard(ctx, ART.men, 'MEN');
    drawBoard(ctx, ART.women, 'WOMEN');
    drawBoard(ctx, ART.lockers, 'LOCKER ROOMS');
    drawBoard(ctx, ART.cafe, 'CAFÉ · BAR');
    drawBoard(ctx, ART.lounge, "MEMBERS' LOUNGE");
    drawBoard(ctx, ART.reception, 'RECEPTION');
    drawBoard(ctx, ART.snack, 'SNACK BAR');
    drawPoster(ctx, ART.poster);
    drawRules(ctx, ART.rules);
    drawClock(ctx, ART.clock);
    ctx.fillStyle = '#6b4a2e';
    ctx.fillRect(...ART.crest);
    drawCrest(ctx, ART.crest);
    drawStudio(ctx, ART.studio);
    ctx.restore();
  }, { key: 'bld-interiorAtlas', wrap: THREE.ClampToEdgeWrapping, seed: 19 });
}

export const InteriorArt = { tile, rubber, carpet, atlas };
