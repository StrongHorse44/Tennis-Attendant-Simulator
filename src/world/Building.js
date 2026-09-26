import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES } from '../utils/Constants.js';
import { getMaterial, basicMat, registerNightGlow, registerWet } from '../graphics/Materials.js';
import { Textures, createCanvasTexture, seededRandom } from '../graphics/Textures.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { InteriorArt } from './InteriorArt.js';
import { registerNav } from './NavRooms.js';
import {
  getGeometry, boxGeo, cylinderGeo, sphereGeo, icoGeo, mergeParts, makeMatrix,
} from '../graphics/GeometryUtils.js';

/**
 * Building — shared kit for the club's enterable buildings, plus the pro shop.
 * (Clubhouse, fitness centre and pool house live in ClubBuildings.js and extend Building.)
 *
 * Built from primitives but merged by material: each building's shell is ~10 draw calls
 * (walls, trim/props, metal, window glass, store glass, lamps, signs, awnings, roof, contact shadow),
 * and its interior another handful (floors, partitions, furniture) that is hidden when the camera
 * is far away. See the Building class doc for the cutaway (roof + upper band of the walls).
 */

export const P = (geometry, matrix, color) => ({ geometry, matrix, color });
export const M = makeMatrix;
/** base (Matrix4) * local transform */
export const at = (base, x, y, z, ry = 0, s = 1, rx = 0, rz = 0) => base.clone().multiply(M(x, y, z, ry, s, rx, rz));

export const HALF_PI = Math.PI / 2;

// Palette (with fallbacks so the file stays self-contained)
export const C = {
  siding: COLORS.bldSiding ?? 0xf4e7cb,
  stucco: COLORS.bldStucco ?? 0xfbf1de,
  trim: COLORS.bldTrim ?? 0xf2eee3,
  green: COLORS.bldTrimGreen ?? 0x2d5a3d,
  greenDark: 0x234a31,
  greenLight: 0x3c6e4d,
  roofGreen: COLORS.bldRoofGreen ?? 0x5a8a68,
  roofSlate: COLORS.bldRoofSlate ?? 0x7c8894,
  ridgeGreen: 0x31503c,
  ridgeSlate: COLORS.bldRidge ?? 0x3a4148,
  stone: COLORS.bldStone ?? 0xb7ad9c,
  brick: COLORS.bldBrick ?? 0x9e5238,
  brass: COLORS.bldBrass ?? 0xc9a54c,
  iron: 0x23272a,
  chrome: 0xc9ced3,
  copper: COLORS.bldCopper ?? 0x6fa48f,
  wainscot: COLORS.bldWainscot ?? 0x7d9c83,
  interior: COLORS.bldInteriorWall ?? 0xf1e6cc,
  floorWood: COLORS.bldFloorWood ?? 0xb98a55,
  wood: 0xa8743f,
  woodDark: 0x6b4a2e,
  ceiling: 0xefe7d6,
  ball: 0xd4e157,
  flowers: [0xe25c7a, 0xf2c14e, 0xf4efe6, 0xc23b4e, 0x9b6fd1, 0xf08a4b],
  leaf: 0x4f8a3c,
  leafDark: 0x3b6e2e,
};

// ───────────────────────────── geometry helpers ─────────────────────────────

/** World-space box projection UVs (geometry must already be in world space). */
export function boxUV(geo, tile = 2) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  let uv = geo.attributes.uv;
  if (!uv || uv.count !== p.count) {
    uv = new THREE.BufferAttribute(new Float32Array(p.count * 2), 2);
    geo.setAttribute('uv', uv);
  }
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let u, v;
    if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z; v = y; } else { u = x; v = y; }
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Split a straight wall into boxes around rectangular openings.
 * axis 'x': wall runs along x from a0..a1 at z = fixed. axis 'z': along z at x = fixed.
 */
export function wallPieces(axis, a0, a1, fixed, t, yA, yB, openings = [], color, cut = null) {
  const cuts = [a0, a1];
  for (const o of openings) { if (o.a > a0 && o.a < a1) cuts.push(o.a); if (o.b > a0 && o.b < a1) cuts.push(o.b); }
  cuts.sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i], e = cuts[i + 1];
    if (e - s < 1e-4) continue;
    const mid = (s + e) / 2;
    const o = openings.find(op => mid > op.a && mid < op.b);
    let spans = o ? [[yA, Math.min(yB, o.y0)], [Math.max(yA, o.y1), yB]] : [[yA, yB]];
    // Split at the cutaway height so the upper band can be hidden separately (see Building.cutY)
    if (cut !== null) spans = spans.flatMap(([ya, yb]) => (ya < cut - 1e-3 && yb > cut + 1e-3 ? [[ya, cut], [cut, yb]] : [[ya, yb]]));
    for (const [ya, yb] of spans) {
      if (yb - ya < 1e-3) continue;
      const cy = (ya + yb) / 2, hy = yb - ya;
      out.push(axis === 'x'
        ? P(boxGeo(e - s, hy, t), M(mid, cy, fixed), color)
        : P(boxGeo(t, hy, e - s), M(fixed, cy, mid), color));
    }
  }
  return out;
}

const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _n = new THREE.Vector3();
const _s = new THREE.Vector3(), _eave = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
export const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Accumulates flat-shaded polygons (roof planes) with slope-aligned UVs. */
export class SurfaceBuilder {
  constructor() { this.p = []; this.n = []; this.uv = []; }

  /**
   * @param {THREE.Vector3[]} pts  convex polygon (3 or 4 points, any winding)
   * @param {object} o  outward: facing hint; eave: along-eave direction (U); origin; tile (m per UV unit)
   */
  poly(pts, { outward = UP, eave = null, origin = null, tile = 1 } = {}) {
    let a = pts;
    _e1.subVectors(a[1], a[0]); _e2.subVectors(a[2], a[0]);
    _n.crossVectors(_e1, _e2).normalize();
    if (_n.dot(outward) < 0) { a = a.slice().reverse(); _n.negate(); }
    const o = origin || a[0];
    if (eave) {
      _eave.copy(eave).normalize();
      _s.crossVectors(_n, _eave).normalize();
      if (_s.y < 0) _s.negate();
    }
    for (let i = 1; i < a.length - 1; i++) {
      for (const q of [a[0], a[i], a[i + 1]]) {
        this.p.push(q.x, q.y, q.z);
        this.n.push(_n.x, _n.y, _n.z);
        if (eave) {
          const dx = q.x - o.x, dy = q.y - o.y, dz = q.z - o.z;
          this.uv.push((dx * _eave.x + dy * _eave.y + dz * _eave.z) / tile, (dx * _s.x + dy * _s.y + dz * _s.z) / tile);
        } else this.uv.push(0, 0);
      }
    }
  }

  /** Hipped roof over the rectangle (x0..x1, z0..z1), eave at y. Returns ridge/hip lines for caps. */
  hipRoof(x0, x1, z0, z1, y, rise, tile) {
    const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, top = y + rise;
    const A = V(x0, y, z0), B = V(x1, y, z0), Cc = V(x1, y, z1), Dd = V(x0, y, z1);
    const X = V(1, 0, 0), Z = V(0, 0, 1);
    if (W >= D) {
      const r0 = V(x0 + D / 2, top, cz), r1 = V(x1 - D / 2, top, cz);
      this.poly([Dd, Cc, r1, r0], { outward: V(0, 1, 1), eave: X, origin: Dd, tile });
      this.poly([B, A, r0, r1], { outward: V(0, 1, -1), eave: X, origin: A, tile });
      this.poly([A, Dd, r0], { outward: V(-1, 1, 0), eave: Z, origin: A, tile });
      this.poly([Cc, B, r1], { outward: V(1, 1, 0), eave: Z, origin: B, tile });
      return { ridge: [r0, r1], hips: [[A, r0], [Dd, r0], [B, r1], [Cc, r1]] };
    }
    const r0 = V(cx, top, z0 + W / 2), r1 = V(cx, top, z1 - W / 2);
    this.poly([A, Dd, r1, r0], { outward: V(-1, 1, 0), eave: Z, origin: A, tile });
    this.poly([Cc, B, r0, r1], { outward: V(1, 1, 0), eave: Z, origin: B, tile });
    this.poly([B, A, r0], { outward: V(0, 1, -1), eave: X, origin: A, tile });
    this.poly([Dd, Cc, r1], { outward: V(0, 1, 1), eave: X, origin: Dd, tile });
    return { ridge: [r0, r1], hips: [[A, r0], [B, r0], [Dd, r1], [Cc, r1]] };
  }

  /**
   * Gable roof with the ridge along z at x = cx (half span hs incl. overhang), eave y, z from z0..z1.
   * ref {hs, y}: the eave line that UV v=0 is measured from (so split pieces of one gable line up).
   */
  gableZ(cx, hs, z0, z1, y, rise, tile, ref = null) {
    const top = y + rise, Z = V(0, 0, 1);
    const rh = ref ? ref.hs : hs, ry = ref ? ref.y : y;
    const l0 = V(cx - hs, y, z0), l1 = V(cx - hs, y, z1), r0 = V(cx + hs, y, z0), r1 = V(cx + hs, y, z1);
    const t0 = V(cx, top, z0), t1 = V(cx, top, z1);
    this.poly([l0, l1, t1, t0], { outward: V(-1, 1, 0), eave: Z, origin: V(cx - rh, ry, 0), tile });
    this.poly([r0, r1, t1, t0], { outward: V(1, 1, 0), eave: Z, origin: V(cx + rh, ry, 0), tile });
    return { ridge: [t0, t1] };
  }

  /**
   * Cross gable meeting a main roof: behind the main eave line (zEave) the gable's eaves are lifted
   * just above the main eave so the main soffit/fascia never poke through; in front it overhangs fully.
   */
  crossGableZ(cx, hs, zBack, zEave, zFront, eaveY, yLow, top, tile) {
    const slope = (top - yLow) / hs, lift = 0.07;
    const ref = { hs, y: yLow };
    this.gableZ(cx, (top - eaveY - lift) / slope, zBack, zEave, eaveY + lift, top - eaveY - lift, tile, ref);
    this.gableZ(cx, hs, zEave, zFront, yLow, top - yLow, tile, ref);
    return { ridge: [V(cx, top, zBack), V(cx, top, zFront)] };
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _dir = new THREE.Vector3();
const _mid = new THREE.Vector3(), _scl = new THREE.Vector3();
const X_AXIS = new THREE.Vector3(1, 0, 0);

/** Matrix for a unit box stretched from a to b (thickness th x width wd), optionally rolled 45° (ridge caps). */
export function segMatrix(a, b, th, wd, roll = 0) {
  _dir.subVectors(b, a);
  const L = _dir.length();
  _dir.divideScalar(L || 1);
  _q.setFromUnitVectors(X_AXIS, _dir);
  if (roll) _q.multiply(_q2.setFromAxisAngle(X_AXIS, roll));
  _mid.addVectors(a, b).multiplyScalar(0.5);
  return new THREE.Matrix4().compose(_mid, _q, _scl.set(L, th, wd));
}

/**
 * Chamfered box (flat bevels on every edge and corner): ~130 vertices instead of ~900 for a
 * RoundedBoxGeometry, which matters because the pro shop merges a few hundred of these.
 */
export function bevelBox(w, h, d, c = 0.03) {
  const cc = Math.max(0.002, Math.min(c, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  return getGeometry(`bld-bevel|${w}|${h}|${d}|${cc}`, () => {
    const pts = [];
    const hx = w / 2, hy = h / 2, hz = d / 2;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      pts.push(new THREE.Vector3(sx * hx, sy * (hy - cc), sz * (hz - cc)));
      pts.push(new THREE.Vector3(sx * (hx - cc), sy * hy, sz * (hz - cc)));
      pts.push(new THREE.Vector3(sx * (hx - cc), sy * (hy - cc), sz * hz));
    }
    return new ConvexGeometry(pts);
  });
}

/** Triangular prism (pediment / gable end): base width 2*hw, height rise, depth along +z from 0..depth. */
export function prismGeo(hw, rise, depth) {
  return getGeometry(`bld-prism|${hw}|${rise}|${depth}`, () => {
    const s = new THREE.Shape();
    s.moveTo(-hw, 0); s.lineTo(hw, 0); s.lineTo(0, rise); s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  });
}

/** Flat-shaded 4-sided pyramid (unit base radius, unit height, centred on its mid-height). */
export function pyramidGeo() {
  return getGeometry('bld-pyramid', () => {
    const g = new THREE.ConeGeometry(1, 1, 4, 1).toNonIndexed();
    g.computeVertexNormals();
    return g;
  });
}

/** Plane mapped to a sub-rectangle of a texture (u0,v0,u1,v1). */
export function atlasPlane(key, w, h, u0, v0, u1, v1) {
  return getGeometry(`bld-ap|${key}|${w}|${h}`, () => {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return g;
  });
}

/** Disc mapped to a sub-rectangle of a texture. */
export function atlasDisc(key, r, u0, v0, u1, v1) {
  return getGeometry(`bld-ad|${key}|${r}`, () => {
    const g = new THREE.CircleGeometry(r, 28);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    return g;
  });
}

// ───────────────────────────── textures ─────────────────────────────

const ATLAS_PX = 1024;
/** Sign atlas regions in 1024px canvas coordinates [x, y, w, h] (y from top). */
export const ATLAS = {
  proShop: [0, 0, 1024, 220],
  club: [0, 232, 1024, 200],
  crest: [0, 444, 300, 300],
  open: [316, 448, 184, 88],
  board: [512, 444, 512, 384],
  rackets: [0, 756, 500, 110],
  apparel: [0, 878, 500, 110],
};

export function regionUV(r) {
  const [x, y, w, h] = r;
  const pad = 2;
  return [(x + pad) / ATLAS_PX, 1 - (y + h - pad) / ATLAS_PX, (x + w - pad) / ATLAS_PX, 1 - (y + pad) / ATLAS_PX];
}

export function signPlane(name, width) {
  const r = ATLAS[name];
  const hgt = width * (r[3] / r[2]);
  const [u0, v0, u1, v1] = regionUV(r);
  return { geo: atlasPlane(name, width, +hgt.toFixed(4), u0, v0, u1, v1), h: hgt };
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawBoard(ctx, [x, y, w, h], title, sub) {
  ctx.fillStyle = '#2d5a3d';
  roundRect(ctx, x, y, w, h, h * 0.08);
  ctx.fill();
  // subtle vertical sheen
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(255,255,255,0.07)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#c9a54c';
  ctx.lineWidth = h * 0.035;
  roundRect(ctx, x + h * 0.08, y + h * 0.08, w - h * 0.16, h - h * 0.16, h * 0.05);
  ctx.stroke();
  ctx.lineWidth = h * 0.012;
  roundRect(ctx, x + h * 0.14, y + h * 0.14, w - h * 0.28, h - h * 0.28, h * 0.03);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f4e8c1';
  const mainY = sub ? y + h * 0.44 : y + h * 0.53;
  ctx.font = `bold ${Math.round(h * (sub ? 0.4 : 0.5))}px Georgia, 'Times New Roman', serif`;
  try { ctx.letterSpacing = `${Math.round(h * 0.03)}px`; } catch (e) { /* older canvas */ }
  ctx.fillText(title, x + w / 2, mainY);
  if (sub) {
    ctx.font = `bold ${Math.round(h * 0.13)}px Georgia, 'Times New Roman', serif`;
    try { ctx.letterSpacing = `${Math.round(h * 0.03)}px`; } catch (e) { /* noop */ }
    ctx.fillStyle = '#c9a54c';
    ctx.fillText(sub, x + w / 2, y + h * 0.76);
  }
  try { ctx.letterSpacing = '0px'; } catch (e) { /* noop */ }
}

export function drawCrest(ctx, [x, y, w]) {
  const cx = x + w / 2, cy = y + w / 2, R = w * 0.47;
  ctx.fillStyle = '#2d5a3d';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c9a54c'; ctx.lineWidth = w * 0.035;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.92, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#f4e8c1'; ctx.lineWidth = w * 0.01;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.82, 0, Math.PI * 2); ctx.stroke();
  // crossed rackets
  for (const a of [-0.6, 0.6]) {
    ctx.save();
    ctx.translate(cx, cy + w * 0.05);
    ctx.rotate(a);
    ctx.strokeStyle = '#f4e8c1';
    ctx.lineWidth = w * 0.022;
    ctx.beginPath(); ctx.ellipse(0, -w * 0.16, w * 0.1, w * 0.13, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.lineWidth = w * 0.005;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath(); ctx.moveTo(i * w * 0.025, -w * 0.3); ctx.lineTo(i * w * 0.025, -w * 0.02); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-w * 0.1, -w * 0.16 + i * w * 0.032); ctx.lineTo(w * 0.1, -w * 0.16 + i * w * 0.032); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#f4e8c1';
    ctx.fillRect(-w * 0.017, -w * 0.03, w * 0.034, w * 0.2);
    ctx.restore();
  }
  // throat emblem + ball
  ctx.fillStyle = '#c9a54c';
  ctx.beginPath(); ctx.arc(cx, cy + w * 0.2, w * 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d4e157';
  ctx.beginPath(); ctx.arc(cx, cy - w * 0.25, w * 0.055, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f4e8c1';
  ctx.font = `bold ${Math.round(w * 0.075)}px Georgia, serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('1962', cx, cy + w * 0.34);
}

function drawTaskBoard(ctx, [x, y, w, h], rand) {
  // cork
  ctx.fillStyle = '#b98a58';
  ctx.fillRect(x, y, w, h);
  for (let i = 0; i < 1400; i++) {
    const px = x + rand() * w, py = y + rand() * h, r = 0.8 + rand() * 1.8;
    ctx.fillStyle = rand() < 0.5 ? 'rgba(90,55,25,0.35)' : 'rgba(235,200,150,0.35)';
    ctx.fillRect(px, py, r, r);
  }
  // header
  ctx.fillStyle = '#2d5a3d';
  ctx.fillRect(x, y, w, h * 0.19);
  ctx.fillStyle = '#c9a54c';
  ctx.fillRect(x, y + h * 0.19, w, h * 0.012);
  ctx.fillStyle = '#f4e8c1';
  ctx.font = `bold ${Math.round(h * 0.11)}px Georgia, serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  try { ctx.letterSpacing = '4px'; } catch (e) { /* noop */ }
  ctx.fillText('TASK BOARD', x + w / 2, y + h * 0.1);
  try { ctx.letterSpacing = '0px'; } catch (e) { /* noop */ }
  // pinned cards
  const cards = [
    [0.05, 0.27, '#fbf6e4', '#c0392b'], [0.37, 0.25, '#fff1a0', '#2d5a3d'], [0.69, 0.28, '#d8ecf7', '#2f6db3'],
    [0.12, 0.62, '#ffd9c7', '#2f6db3'], [0.45, 0.6, '#fbf6e4', '#c9a54c'], [0.73, 0.63, '#e3f1d4', '#c0392b'],
  ];
  cards.forEach(([fx, fy, col, pin], i) => {
    const cw = w * 0.25, ch = h * 0.3;
    ctx.save();
    ctx.translate(x + fx * w + cw / 2, y + fy * h + ch / 2);
    ctx.rotate((rand() - 0.5) * 0.14);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(-cw / 2 + 4, -ch / 2 + 5, cw, ch);
    ctx.fillStyle = col;
    ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
    ctx.fillStyle = '#3b3b3b';
    ctx.fillRect(-cw * 0.38, -ch * 0.3, cw * (0.45 + rand() * 0.3), ch * 0.07);
    ctx.fillStyle = 'rgba(60,60,60,0.55)';
    for (let l = 0; l < 4; l++) ctx.fillRect(-cw * 0.38, -ch * 0.1 + l * ch * 0.13, cw * (0.4 + rand() * 0.36), ch * 0.035);
    if (i % 2 === 0) { ctx.strokeStyle = '#2d5a3d'; ctx.lineWidth = 3; ctx.strokeRect(cw * 0.22, ch * 0.2, cw * 0.12, ch * 0.12); }
    ctx.fillStyle = pin;
    ctx.beginPath(); ctx.arc(0, -ch * 0.42, cw * 0.06, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(-cw * 0.018, -ch * 0.44, cw * 0.02, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });
}

function drawOpen(ctx, [x, y, w, h]) {
  ctx.fillStyle = '#1d2521';
  roundRect(ctx, x, y, w, h, h * 0.2);
  ctx.fill();
  ctx.strokeStyle = '#ffb347'; ctx.lineWidth = h * 0.05;
  roundRect(ctx, x + h * 0.1, y + h * 0.1, w - h * 0.2, h - h * 0.2, h * 0.14);
  ctx.stroke();
  ctx.fillStyle = '#ffd08a';
  ctx.font = `bold ${Math.round(h * 0.52)}px 'Trebuchet MS', Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('OPEN', x + w / 2, y + h * 0.54);
}

function signAtlas() {
  return createCanvasTexture(ATLAS_PX, (ctx, S, rand) => {
    ctx.save();
    ctx.scale(S / ATLAS_PX, S / ATLAS_PX);
    ctx.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
    drawBoard(ctx, ATLAS.proShop, 'PRO SHOP', 'GREENBRIAR TENNIS CLUB');
    drawBoard(ctx, ATLAS.club, 'GREENBRIAR CLUB', 'MEMBERS  ·  EST. 1962');
    drawCrest(ctx, ATLAS.crest);
    drawOpen(ctx, ATLAS.open);
    drawTaskBoard(ctx, ATLAS.board, rand);
    drawBoard(ctx, ATLAS.rackets, 'RACKETS');
    drawBoard(ctx, ATLAS.apparel, 'APPAREL');
    ctx.restore();
  }, { key: 'bld-signAtlas', wrap: THREE.ClampToEdgeWrapping, seed: 7 });
}

/** 2x2 atlas of window glass variants: colour (sky reflection + curtains) and emissive (lit interior). */
function glassMaps() {
  const bright = [1, 0.78, 0.92, 0.6];
  const draw = (emissive) => (ctx, S) => {
    const c = S / 2;
    for (let k = 0; k < 4; k++) {
      const ox = (k % 2) * c, oy = (1 - (k >> 1)) * c;
      ctx.save();
      ctx.beginPath(); ctx.rect(ox, oy, c, c); ctx.clip();
      const b = bright[k];
      if (!emissive) {
        const g = ctx.createLinearGradient(0, oy, 0, oy + c);
        g.addColorStop(0, '#a9bfcd'); g.addColorStop(0.45, '#5d7486'); g.addColorStop(1, '#2b3a47');
        ctx.fillStyle = g; ctx.fillRect(ox, oy, c, c);
        // warm interior hint
        ctx.fillStyle = 'rgba(120,95,60,0.25)'; ctx.fillRect(ox, oy + c * 0.55, c, c * 0.45);
      } else {
        ctx.fillStyle = '#000'; ctx.fillRect(ox, oy, c, c);
        const g = ctx.createRadialGradient(ox + c / 2, oy + c * 0.45, c * 0.05, ox + c / 2, oy + c * 0.5, c * 0.75);
        g.addColorStop(0, `rgba(255,214,150,${b})`); g.addColorStop(1, `rgba(230,150,70,${b * 0.75})`);
        ctx.fillStyle = g; ctx.fillRect(ox, oy, c, c);
      }
      // curtains
      const cw = c * 0.17;
      for (const side of [0, 1]) {
        const cx0 = side ? ox + c - cw - c * 0.03 : ox + c * 0.03;
        ctx.fillStyle = emissive ? `rgba(170,95,40,${0.9 * b})` : 'rgba(236,226,204,0.85)';
        ctx.fillRect(cx0, oy + c * 0.03, cw, c * 0.94);
        ctx.fillStyle = emissive ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.12)';
        for (let f = 1; f < 4; f++) ctx.fillRect(cx0 + (cw / 4) * f, oy + c * 0.03, c * 0.012, c * 0.94);
      }
      if (k === 3) { // half-drawn blind
        ctx.fillStyle = emissive ? 'rgba(90,55,25,0.9)' : 'rgba(225,214,190,0.95)';
        ctx.fillRect(ox + c * 0.03, oy + c * 0.03, c * 0.94, c * 0.36);
      }
      if (!emissive) { // reflection streaks
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.beginPath();
        ctx.moveTo(ox + c * 0.15, oy + c); ctx.lineTo(ox + c * 0.45, oy + c); ctx.lineTo(ox + c * 0.95, oy); ctx.lineTo(ox + c * 0.65, oy);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.09)';
        ctx.beginPath();
        ctx.moveTo(ox + c * 0.52, oy + c); ctx.lineTo(ox + c * 0.6, oy + c); ctx.lineTo(ox + c * 1.1, oy); ctx.lineTo(ox + c * 1.02, oy);
        ctx.fill();
      }
      // muntins (2x2 lites) + border
      ctx.fillStyle = emissive ? '#000' : '#eeeade';
      const mw = c * 0.035;
      ctx.fillRect(ox + c / 2 - mw / 2, oy, mw, c);
      ctx.fillRect(ox, oy + c / 2 - mw / 2, c, mw);
      ctx.fillRect(ox, oy, c, mw); ctx.fillRect(ox, oy + c - mw, c, mw);
      ctx.fillRect(ox, oy, mw, c); ctx.fillRect(ox + c - mw, oy, mw, c);
      ctx.restore();
    }
  };
  return {
    map: createCanvasTexture(512, draw(false), { key: 'bld-glassColor', wrap: THREE.ClampToEdgeWrapping }),
    emissive: createCanvasTexture(512, draw(true), { key: 'bld-glassEmissive', wrap: THREE.ClampToEdgeWrapping }),
  };
}

export function glassPane(w, h, variant) {
  const u0 = (variant % 2) * 0.5 + 0.004, v0 = (variant >> 1) * 0.5 + 0.004;
  return atlasPlane(`glass${variant}`, +w.toFixed(3), +h.toFixed(3), u0, v0, u0 + 0.492, v0 + 0.492);
}

/** Awning canvas: vertical club stripes, with a scalloped valance in the bottom band (alpha-tested). */
function awningTexture() {
  return createCanvasTexture(256, (ctx, S) => {
    ctx.clearRect(0, 0, S, S);
    const n = 8, sw = S / n, scallopTop = S * 0.86;
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 ? '#f1e6c4' : '#2d5a3d';
      ctx.fillRect(i * sw, 0, sw, scallopTop);
      ctx.beginPath();
      ctx.arc(i * sw + sw / 2, scallopTop, sw / 2, 0, Math.PI);
      ctx.fill();
    }
    // fold shading at the slope/valance seam and a soft top shade
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, S * 0.71, S, S * 0.014);
    const g = ctx.createLinearGradient(0, 0, 0, S * 0.7);
    g.addColorStop(0, 'rgba(0,0,0,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0.05)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S * 0.7);
    // canvas weave
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let y = 0; y < S * 0.86; y += 3) ctx.fillRect(0, y, S, 1);
  }, { key: 'bld-awning', repeat: [1, 1] });
}

export function contactTexture() {
  return createCanvasTexture(64, (ctx, S, rand, H) => {
    const g = ctx.createLinearGradient(0, 0, S, 0);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.clearRect(0, 0, S, H);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, H);
  }, { key: 'bld-contact', height: 16, wrap: THREE.ClampToEdgeWrapping, srgb: false });
}

// ───────────────────────────── materials ─────────────────────────────

export const Mat = {
  prop: () => getMaterial('bld-prop', () => registerWet(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }), 0.4)),
  metal: () => getMaterial('bld-metal', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.7 })),
  siding: () => getMaterial('bld-siding', () => registerWet(new THREE.MeshStandardMaterial({ color: C.siding, map: Textures.siding(), roughness: 0.78 }), 0.45)),
  stucco: () => getMaterial('bld-stucco', () => registerWet(new THREE.MeshStandardMaterial({ color: C.stucco, map: Textures.stucco(), roughness: 0.9 }), 0.45)),
  roof: (color) => getMaterial(`bld-roof-${color.toString(16)}`, () => registerWet(new THREE.MeshStandardMaterial({
    color, map: Textures.shingles(), roughness: 0.8, side: THREE.DoubleSide,
  }), 0.85)),
  interior: () => getMaterial('bld-interior', () => {
    const tex = Textures.stucco();
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.9, emissive: 0xffe2b8, emissiveMap: tex });
    registerNightGlow(m, 0.34, 0.16);
    return m;
  }),
  floor: () => getMaterial('bld-floor', () => {
    const tex = Textures.wood({ tone: C.floorWood });
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: 0xffe2b8, emissiveMap: tex });
    registerNightGlow(m, 0.24, 0.1);
    return m;
  }),
  glass: () => getMaterial('bld-windowGlass', () => {
    const { map, emissive } = glassMaps();
    const m = new THREE.MeshStandardMaterial({
      map, emissiveMap: emissive, emissive: 0xffffff, roughness: 0.12, metalness: 0.25, envMapIntensity: 1.4,
    });
    registerNightGlow(m, 1.9, 0);
    return m;
  }),
  storeGlass: () => getMaterial('bld-storeGlass', () => {
    const m = new THREE.MeshStandardMaterial({
      color: 0xcfe2e8, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false,
      side: THREE.DoubleSide, forceSinglePass: true, envMapIntensity: 1.6, emissive: 0xffd49a,
    });
    registerNightGlow(m, 0.3, 0);
    return m;
  }),
  lamp: () => getMaterial('bld-lampGlass', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0xfff2d8, roughness: 0.3, emissive: 0xffd49a });
    registerNightGlow(m, 2.6, 0.08);
    return m;
  }),
  signs: () => getMaterial('bld-signs', () => {
    const tex = signAtlas();
    const m = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.55, emissive: 0xffffff, emissiveMap: tex, polygonOffset: true,
      polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    registerNightGlow(m, 0.45, 0);
    return m;
  }),
  awning: () => getMaterial('bld-awning', () => registerWet(new THREE.MeshStandardMaterial({
    map: awningTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.92,
  }), 0.5)),
  contact: () => {
    const m = basicMat(0x000000, { map: contactTexture(), transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
    m.forceSinglePass = true; // DoubleSide + transparent would otherwise draw twice
    return m;
  },
  ghost: () => getMaterial('bld-ghost', () => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })),
  // ── interiors (textures in InteriorArt.js) ──
  tile: () => getMaterial('bld-tile', () => {
    const tex = InteriorArt.tile();
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.35, emissive: 0xffe2b8, emissiveMap: tex });
    registerNightGlow(m, 0.22, 0.08);
    return m;
  }),
  rubber: () => getMaterial('bld-rubber', () => {
    const tex = InteriorArt.rubber();
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: 0xffe2b8, emissiveMap: tex });
    registerNightGlow(m, 0.3, 0.12);
    return m;
  }),
  carpet: () => getMaterial('bld-carpet', () => {
    const tex = InteriorArt.carpet();
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.95, emissive: 0xffe2b8, emissiveMap: tex });
    registerNightGlow(m, 0.26, 0.1);
    return m;
  }),
  deck: () => getMaterial('bld-deck', () => registerWet(new THREE.MeshStandardMaterial({
    vertexColors: true, map: Textures.pavers({ repeat: [1, 1] }), roughness: 0.85,
  }), 0.7)),
  mirror: () => getMaterial('bld-mirror', () => new THREE.MeshStandardMaterial({
    color: 0xdfe6ea, roughness: 0.04, metalness: 0.95, envMapIntensity: 1.6,
  })),
  deco: () => getMaterial('bld-deco', () => {
    const tex = InteriorArt.atlas();
    const m = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, polygonOffset: true,
      polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    registerNightGlow(m, 0.4, 0.1);
    return m;
  }),
};

/** Awning shell (local: wall at z=0, top edge at y=0, spans x ±W/2). */
export function awningGeo(W, D, drop, val) {
  return getGeometry(`bld-awning|${W}|${D}|${drop}|${val}`, () => {
    const pos = [], uv = [];
    const quad = (a, b, c, d, ua, ub, uc, ud) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); uv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud); };
    const hw = W / 2, T = 2.0; // 2 m per stripe tile
    quad([-hw, 0, 0], [hw, 0, 0], [hw, -drop, D], [-hw, -drop, D], [-hw / T, 1], [hw / T, 1], [hw / T, 0.3], [-hw / T, 0.3]);
    quad([-hw, -drop, D], [hw, -drop, D], [hw, -drop - val, D], [-hw, -drop - val, D], [-hw / T, 0.28], [hw / T, 0.28], [hw / T, 0], [-hw / T, 0]);
    for (const x of [-hw, hw]) { pos.push(x, 0, 0, x, -drop, D, x, -drop, 0); uv.push(0, 0.6, D / T, 0.6, 0, 0.5); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  });
}

/** Soft contact-shadow frame hugging a rectangular footprint. ys = y per side {front, back, left, right}. */
export function contactFrameGeo(x0, x1, z0, z1, o, ys) {
  const pos = [], uv = [];
  const side = (i0, i1, o1, o0, y) => {
    const v = [[...i0, 0], [...i1, 0], [...o1, 1], [...o0, 1]];
    for (const idx of [0, 1, 2, 0, 2, 3]) { const q = v[idx]; pos.push(q[0], y, q[1]); uv.push(q[2], 0.5); }
  };
  side([x0, z0], [x1, z0], [x1 + o, z0 - o], [x0 - o, z0 - o], ys.back);
  side([x1, z0], [x1, z1], [x1 + o, z1 + o], [x1 + o, z0 - o], ys.right);
  side([x1, z1], [x0, z1], [x0 - o, z1 + o], [x1 + o, z1 + o], ys.front);
  side([x0, z1], [x0, z0], [x0 - o, z0 - o], [x0 - o, z1 + o], ys.left);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.computeBoundingSphere();
  return g;
}

/** Beyond this camera distance (m) a building's interior group is hidden (unless cut away). */
const INTERIOR_VIEW_DIST = 32;

/** Index count a part adds to a mergeParts() geometry (non-indexed parts get an identity index). */
function partIndexCount(g) { return g.index ? g.index.count : g.attributes.position.count; }

const _pc = new THREE.Vector3();
/** World-space y of a part's bounding-box centre (decides its cutaway band). */
function partCenterY(p) {
  const g = p.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  g.boundingBox.getCenter(_pc);
  if (p.matrix) _pc.applyMatrix4(p.matrix);
  return _pc.y;
}

/**
 * Material + shadow flags for each part list. `interior` lists never cast (they sit under the
 * roof's shadow anyway), which also keeps the shadow pass cheap.
 */
const LIST_SPEC = {
  walls: { cast: true },
  interior: { mat: () => Mat.interior(), cast: false, uvTile: 2.5 },
  floor: { mat: () => Mat.floor(), cast: false, uvTile: 1.2 },
  tile: { mat: () => Mat.tile(), cast: false, uvTile: 1.2 },
  rubber: { mat: () => Mat.rubber(), cast: false, uvTile: 2 },
  carpet: { mat: () => Mat.carpet(), cast: false, uvTile: 1.5 },
  deck: { mat: () => Mat.deck(), cast: false, uvTile: 2.4 },
  trim: { mat: () => Mat.prop(), cast: true },
  metal: { mat: () => Mat.metal(), cast: true },
  glass: { mat: () => Mat.glass(), cast: false },
  mirror: { mat: () => Mat.mirror(), cast: false, receive: false },
  store: { mat: () => Mat.storeGlass(), cast: false, receive: false, renderOrder: 2, noAO: true },
  lamp: { mat: () => Mat.lamp(), cast: false, receive: false },
  signs: { mat: () => Mat.signs(), cast: false },
  deco: { mat: () => Mat.deco(), cast: false },
  awning: { mat: () => Mat.awning(), cast: true },
};

// ───────────────────────────── Building ─────────────────────────────

/**
 * Base class for every enterable club building. Subclasses (see ClubBuildings.js) implement
 * `_build(config)`; the pro shop is built here.
 *
 * Cutaway: every building has a cut height (`cutY`). Wall, trim and furniture parts whose centre
 * sits above it are merged *after* the lower parts in the same geometry, so hiding the upper band
 * is just `geometry.setDrawRange(0, lowerCount)` (no extra draw calls while outside). A ghost twin
 * (shared buffers, drawRange = upper band, colorWrite off) keeps casting the upper band's shadow.
 * The roof layer (roof, ceiling, roof trim/signs) is hidden entirely. World.update() calls
 * `updateView(followTarget, cameraPos)` every frame: the cutaway is on while the followed player
 * stands in one of `this.rooms` (or the camera is inside the footprint), and the interior group
 * (floors, partitions, furniture) is hidden when the camera is far away and outside.
 */
export class Building {
  constructor(scene, physicsWorld, type, config) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.type = type;
    this.config = config;
    this.mesh = new THREE.Group();
    this.mesh.name = `Building:${type}`;
    /** Floors, partitions and furniture (hidden when the camera is far away and outside). */
    this.interiorGroup = new THREE.Group();
    this.interiorGroup.name = `${type}:interior`;
    this.mesh.add(this.interiorGroup);
    /** Roof layer hidden while the camera looks into the building. */
    this.roofGroup = new THREE.Group();
    this.roofGroup.name = `${type}:roof`;
    this.mesh.add(this.roofGroup);
    this.cutawayActive = false;
    this.cutY = Infinity;
    /** Interior rectangles {x0, x1, z0, z1} (the followed player standing in one → cutaway). */
    this.rooms = [];
    /** Outer footprint rectangles (camera inside one below roofTop → cutaway). */
    this.footprints = [];
    this.roofTop = 8;
    this.center = new THREE.Vector3(config && config.center ? config.center.x : 0, 0, config && config.center ? config.center.z : 0);
    this._roofMeshes = [];
    this._splits = [];
    this._body = null;
    this._rand = seededRandom(type === 'proShop' ? 11 : type === 'clubhouse' ? 23 : 37 + type.length);

    if (type === 'proShop') this._buildProShop(config);
    else this._build(config);

    this._addGhostPrewarm();
    this.scene.add(this.mesh);
  }

  /** Subclasses build here. */
  _build() {}

  /** True when (x, z) is inside one of the building's rooms (optional margin grows each rect). */
  isInside(x, z, margin = 0) {
    for (let i = 0; i < this.rooms.length; i++) {
      const r = this.rooms[i];
      if (x > r.x0 - margin && x < r.x1 + margin && z > r.z0 - margin && z < r.z1 + margin) return true;
    }
    return false;
  }

  /**
   * Per-frame view update (World.update). target: followed player/cart position; cam: last
   * rendered camera position (may be null). Returns true when the target is indoors.
   */
  updateView(target, cam) {
    const inside = !!target && this.isInside(target.x, target.z);
    let cut = inside;
    if (!cut && cam && cam.y < this.roofTop) {
      for (let i = 0; i < this.footprints.length; i++) {
        const r = this.footprints[i];
        if (cam.x > r.x0 && cam.x < r.x1 && cam.z > r.z0 && cam.z < r.z1) { cut = true; break; }
      }
    }
    if (cut !== this.cutawayActive) this.setCutaway(cut);
    let show = cut;
    if (!show) {
      if (!cam) show = true;
      else {
        const dx = cam.x - this.center.x, dy = cam.y, dz = cam.z - this.center.z;
        show = dx * dx + dy * dy + dz * dz < INTERIOR_VIEW_DIST * INTERIOR_VIEW_DIST;
      }
    }
    if (this.interiorGroup.visible !== show) this.interiorGroup.visible = show;
    return inside;
  }

  /**
   * Show/hide the upper band + roof layer. Hidden roof meshes keep casting shadows (ghost
   * material) so the interior stays shaded; non-shadow roof pieces (signs, lamps) are just hidden.
   */
  setCutaway(on) {
    this.cutawayActive = !!on;
    for (const m of this._roofMeshes) {
      if (m.castShadow && !m.userData.hideInCutaway) {
        m.material = on ? Mat.ghost() : m.userData.baseMaterial;
        m.userData.noAO = !!on;
      } else {
        m.visible = !on;
      }
    }
    for (const sp of this._splits) {
      sp.geo.setDrawRange(0, on ? sp.lowerCount : Infinity);
      if (sp.ghost) sp.ghost.visible = !!on;
    }
  }

  _addGhostPrewarm() {
    if (Building._prewarmed) return; // one per scene is enough
    Building._prewarmed = true;
    // Empty mesh that keeps the ghost material's shader compiled, so the first cutaway doesn't hitch.
    const prewarm = new THREE.Mesh(getGeometry('bld-empty', () => {
      const e = new THREE.BufferGeometry();
      e.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      return e;
    }), Mat.ghost());
    prewarm.frustumCulled = false;
    prewarm.name = `${this.type}:ghostPrewarm`;
    prewarm.userData.noAO = true;
    this.roofGroup.add(prewarm);
  }

  // ───────────── shared builders ─────────────

  _lists() {
    const L = { roofTrim: [], roofSign: [], roofLamp: [] };
    for (const k of Object.keys(LIST_SPEC)) L[k] = [];
    return L;
  }

  /**
   * One merged mesh per list, split into a lower + upper band at this.cutY (see class doc).
   * Returns the mesh (or null for an empty list).
   */
  _splitMesh(parts, material, { cast = true, receive = true, uvTile = 0, parent = this.mesh, name, ghostShadow = cast } = {}) {
    if (!parts.length) return null;
    const lower = [], upper = [];
    for (const p of parts) (partCenterY(p) < this.cutY ? lower : upper).push(p);
    if (!upper.length) return this._mesh(parts, material, { cast, receive, uvTile, parent, name });
    let lowerCount = 0;
    for (const p of lower) lowerCount += partIndexCount(p.geometry);
    const geo = mergeParts(lower.concat(upper));
    if (uvTile) boxUV(geo, uvTile);
    geo.computeBoundingBox();
    const m = new THREE.Mesh(geo, material);
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.name = name || `${this.type}:${material.name}`;
    parent.add(m);
    let ghost = null;
    if (cast && ghostShadow) {
      const g2 = new THREE.BufferGeometry();
      for (const k of Object.keys(geo.attributes)) g2.setAttribute(k, geo.attributes[k]);
      g2.setIndex(geo.index);
      g2.boundingBox = geo.boundingBox;
      g2.boundingSphere = geo.boundingSphere;
      g2.setDrawRange(lowerCount, Infinity);
      ghost = new THREE.Mesh(g2, Mat.ghost());
      ghost.castShadow = true;
      ghost.receiveShadow = false;
      ghost.visible = false;
      ghost.userData.noAO = true;
      ghost.name = `${m.name}:ghost`;
      parent.add(ghost);
    }
    this._splits.push({ geo, lowerCount, ghost });
    return m;
  }

  /**
   * Build every list of `L` (walls use `wallMat`). interior=true → parented to the interior group,
   * nothing casts. Returns { key: mesh }.
   */
  _emit(L, { interior = false, wallMat = null, wallTile = 2, prefix = this.type, metalAsTrim = false } = {}) {
    const out = {};
    if (metalAsTrim && L.metal.length) { L.trim.push(...L.metal); L.metal.length = 0; }
    const parent = interior ? this.interiorGroup : this.mesh;
    for (const [k, spec] of Object.entries(LIST_SPEC)) {
      const parts = L[k];
      if (!parts || !parts.length) continue;
      const material = k === 'walls' ? (wallMat || Mat.stucco()) : spec.mat();
      const m = this._splitMesh(parts, material, {
        cast: interior ? false : spec.cast, receive: spec.receive !== false, ghostShadow: k === 'walls',
        uvTile: k === 'walls' ? wallTile : (spec.uvTile || 0), parent, name: `${prefix}:${interior ? 'in-' : ''}${k}`,
      });
      if (!m) continue;
      if (spec.renderOrder) m.renderOrder = spec.renderOrder;
      if (spec.noAO) m.userData.noAO = true;
      out[k] = m;
    }
    return out;
  }

  /** Roof layer meshes (always fully hidden in cutaway). sb: SurfaceBuilder with the roof planes. */
  _emitRoof(L, sb, roofMat) {
    const g = this.roofGroup;
    if (sb) this._roofMeshes.push(this._roofSurface(sb, roofMat, g));
    const trim = this._mesh(L.roofTrim, Mat.prop(), { parent: g, name: `${this.type}:roofTrim` });
    if (trim && sb) trim.userData.hideInCutaway = true; // the roof surface's ghost carries the shadow
    this._roofMeshes.push(trim);
    this._roofMeshes.push(this._mesh(L.roofSign, Mat.signs(), { cast: false, parent: g, name: `${this.type}:roofSign` }));
    this._roofMeshes.push(this._mesh(L.roofLamp, Mat.lamp(), { cast: false, receive: false, parent: g, name: `${this.type}:ceilingLights` }));
    this._roofMeshes = this._roofMeshes.filter(Boolean);
    for (const m of this._roofMeshes) m.userData.baseMaterial = m.material;
  }

  // ───────────── physics (one compound static body per building) ─────────────

  _physBox(x, y, z, hw, hh, hd) {
    if (!this._body) {
      this._body = new CANNON.Body({ mass: 0 });
      this._body.position.set(this.center.x, 0, this.center.z);
      this.physicsWorld.addBody(this._body);
    }
    const b = this._body;
    b.addShape(new CANNON.Box(new CANNON.Vec3(hw, hh, hd)), new CANNON.Vec3(x - b.position.x, y, z - b.position.z));
  }

  /**
   * Physics for a straight wall: full-height boxes between the door openings (openings that
   * start near the floor). Same axis convention as wallPieces().
   */
  _wallPhysics(axis, a0, a1, fixed, t, h, openings = []) {
    const doors = openings.filter(o => o.y0 < 0.5).sort((p, q) => p.a - q.a);
    let s = a0;
    const seg = (from, to) => {
      if (to - from < 0.05) return;
      const mid = (from + to) / 2, hl = (to - from) / 2;
      if (axis === 'x') this._physBox(mid, h / 2, fixed, hl, h / 2, t / 2);
      else this._physBox(fixed, h / 2, mid, t / 2, h / 2, hl);
    };
    for (const d of doors) { seg(s, d.a); s = Math.max(s, d.b); }
    seg(s, a1);
  }

  _mesh(parts, material, { cast = true, receive = true, uvTile = 0, parent = this.mesh, name } = {}) {
    if (!parts.length) return null;
    const geo = mergeParts(parts);
    if (uvTile) boxUV(geo, uvTile);
    geo.computeBoundingBox();
    const m = new THREE.Mesh(geo, material);
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.name = name || `${this.type}:${material.name}`;
    parent.add(m);
    return m;
  }

  _roofSurface(sb, material, parent) {
    const geo = sb.toGeometry();
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = `${this.type}:roof`;
    parent.add(m);
    return m;
  }

  /** Ridge/hip caps (rolled square battens) for a hip roof. */
  _roofCaps(list, lines, color, size = 0.17) {
    const { ridge, hips } = lines;
    if (ridge && ridge[0].distanceTo(ridge[1]) > 0.01) list.push(P(boxGeo(1, 1, 1), segMatrix(ridge[0], ridge[1], size, size, Math.PI / 4), color));
    for (const [a, b] of hips || []) list.push(P(boxGeo(1, 1, 1), segMatrix(a, b, size * 0.8, size * 0.8, Math.PI / 4), color));
  }

  /** Eave fascia + soffit for a rectangular roof. */
  _eaves(list, x0, x1, z0, z1, eaveY, fasciaColor, soffitColor) {
    const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, fy = eaveY - 0.08;
    list.push(P(boxGeo(W + 0.1, 0.24, 0.05), M(cx, fy, z1 + 0.025), fasciaColor));
    list.push(P(boxGeo(W + 0.1, 0.24, 0.05), M(cx, fy, z0 - 0.025), fasciaColor));
    list.push(P(boxGeo(0.05, 0.24, D), M(x0 - 0.025, fy, cz), fasciaColor));
    list.push(P(boxGeo(0.05, 0.24, D), M(x1 + 0.025, fy, cz), fasciaColor));
    list.push(P(boxGeo(W - 0.02, 0.06, D - 0.02), M(cx, eaveY - 0.05, cz), soffitColor));
  }

  /**
   * Surface-mounted window. base: Matrix4 at the window centre on the wall face, local +z = outward.
   */
  _window(L, base, w, h, { variant = 0, shutters = false, box = false, trim = C.trim, boxColor = C.green } = {}) {
    const c = 0.1, dz = 0.06;
    L.trim.push(P(boxGeo(w + 2 * c, c, dz), at(base, 0, h / 2 + c / 2, dz / 2), trim));
    L.trim.push(P(boxGeo(c, h, dz), at(base, -w / 2 - c / 2, 0, dz / 2), trim));
    L.trim.push(P(boxGeo(c, h, dz), at(base, w / 2 + c / 2, 0, dz / 2), trim));
    L.trim.push(P(bevelBox(w + 2 * c + 0.14, 0.07, 0.17, 0.02), at(base, 0, -h / 2 - 0.035, 0.085), trim));
    L.trim.push(P(bevelBox(w + 2 * c + 0.12, 0.07, 0.12, 0.02), at(base, 0, h / 2 + c + 0.035, 0.06), trim));
    L.glass.push(P(glassPane(w, h, variant), at(base, 0, 0, 0.012)));
    if (shutters) {
      const sw = Math.min(0.55, w * 0.45);
      for (const s of [-1, 1]) {
        const sx = s * (w / 2 + c + sw / 2 + 0.03);
        L.trim.push(P(bevelBox(sw, h + 0.1, 0.05, 0.015), at(base, sx, 0, 0.03), C.green));
        for (const fy of [-0.3, 0, 0.3]) L.trim.push(P(boxGeo(sw - 0.12, 0.035, 0.02), at(base, sx, fy * h, 0.062), C.greenDark));
      }
    }
    if (box) this._flowerBox(L, at(base, 0, -h / 2 - 0.2, 0), w + 0.2, boxColor);
  }

  /** Window box with flowers; base at the box centre on the wall face (local +z out). */
  _flowerBox(L, base, w, color) {
    const r = this._rand;
    L.trim.push(P(bevelBox(w, 0.24, 0.26, 0.03), at(base, 0, 0, 0.15), color));
    L.trim.push(P(boxGeo(w - 0.08, 0.02, 0.2), at(base, 0, 0.11, 0.15), 0x4a3526));
    const n = Math.max(4, Math.round(w / 0.14));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + 0.08 + (i / (n - 1)) * (w - 0.16);
      L.trim.push(P(icoGeo(0.085, 0), at(base, x, 0.17 + r() * 0.04, 0.12 + r() * 0.08, r() * 3), i % 2 ? C.leaf : C.leafDark));
      if (r() < 0.8) L.trim.push(P(icoGeo(0.06, 0), at(base, x + (r() - 0.5) * 0.08, 0.26 + r() * 0.05, 0.16 + r() * 0.06, r() * 3), C.flowers[(i + (r() * 3 | 0)) % C.flowers.length]));
    }
  }

  /** Wall lantern (black frame, glowing glass). base: on the wall face, local +z out. */
  _lantern(L, base, scale = 1) {
    const s = scale;
    L.metal.push(P(bevelBox(0.14 * s, 0.28 * s, 0.03 * s, 0.01), at(base, 0, 0, 0.015 * s), C.iron));
    L.metal.push(P(boxGeo(0.035 * s, 0.035 * s, 0.14 * s), at(base, 0, 0.02 * s, 0.09 * s), C.iron));
    L.metal.push(P(pyramidGeo(), at(base, 0, 0.19 * s, 0.2 * s, Math.PI / 4, [0.15 * s, 0.1 * s, 0.15 * s]), C.iron));
    L.metal.push(P(boxGeo(0.17 * s, 0.035 * s, 0.17 * s), at(base, 0, -0.12 * s, 0.2 * s), C.iron));
    L.lamp.push(P(boxGeo(0.14 * s, 0.22 * s, 0.14 * s), at(base, 0, 0.03 * s, 0.2 * s)));
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      L.metal.push(P(boxGeo(0.018 * s, 0.24 * s, 0.018 * s), at(base, x * 0.075 * s, 0.03 * s, 0.2 * s + z * 0.075 * s), C.iron));
    }
  }

  /** Panelled door with glass lites. base: bottom centre on the wall face (local +z out). */
  _door(L, base, w, h, { double = true, color = C.green, transom = true, trim = C.trim } = {}) {
    const c = 0.12;
    L.trim.push(P(boxGeo(w + 2 * c, c, 0.07), at(base, 0, h + c / 2, 0.035), trim));
    L.trim.push(P(boxGeo(c, h, 0.07), at(base, -w / 2 - c / 2, h / 2, 0.035), trim));
    L.trim.push(P(boxGeo(c, h, 0.07), at(base, w / 2 + c / 2, h / 2, 0.035), trim));
    const leaves = double ? [-w / 4, w / 4] : [0];
    const lw = double ? w / 2 - 0.02 : w - 0.02;
    for (const lx of leaves) {
      L.trim.push(P(bevelBox(lw, h - 0.02, 0.06, 0.015), at(base, lx, h / 2, 0.02), color));
      L.glass.push(P(glassPane(lw - 0.24, h * 0.42, 1), at(base, lx, h * 0.66, 0.052)));
      L.trim.push(P(bevelBox(lw - 0.26, h * 0.28, 0.03, 0.01), at(base, lx, h * 0.22, 0.05), C.greenDark));
      L.metal.push(P(boxGeo(lw - 0.08, 0.12, 0.012), at(base, lx, 0.08, 0.056), C.brass));
      const hx = double ? lx - Math.sign(lx) * (lw / 2 - 0.1) : lw / 2 - 0.12;
      L.metal.push(P(cylinderGeo(0.018, 0.018, 0.3, 8), at(base, hx, h * 0.45, 0.085), C.brass));
    }
    if (transom) {
      L.glass.push(P(glassPane(w, 0.4, 2), at(base, 0, h + c + 0.21, 0.012)));
      L.trim.push(P(boxGeo(w + 2 * c, 0.1, 0.07), at(base, 0, h + c + 0.47, 0.035), trim));
      L.trim.push(P(boxGeo(c, 0.44, 0.07), at(base, -w / 2 - c / 2, h + c + 0.21, 0.035), trim));
      L.trim.push(P(boxGeo(c, 0.44, 0.07), at(base, w / 2 + c / 2, h + c + 0.21, 0.035), trim));
    }
  }

  /** Tennis racket parts (local: face toward +z, handle down, origin at racket centre). */
  _racket(list, base, color) {
    const head = getGeometry('bld-racketHead', () => new THREE.TorusGeometry(0.125, 0.014, 5, 20));
    const strings = getGeometry('bld-racketStrings', () => new THREE.CircleGeometry(0.12, 16));
    list.push(P(head, at(base, 0, 0.17, 0, 0, [1, 1.3, 1]), color));
    list.push(P(strings, at(base, 0, 0.17, 0.001, 0, [1, 1.3, 1]), 0xe9e5d8));
    for (const s of [-1, 1]) list.push(P(cylinderGeo(0.011, 0.011, 0.16, 5), at(base, s * 0.035, -0.06, 0, 0, 1, 0, s * 0.42), color));
    list.push(P(cylinderGeo(0.021, 0.023, 0.28, 8), at(base, 0, -0.26, 0), 0x2a2a2a));
  }

  // ───────────── pro shop ─────────────

  _buildProShop(config) {
    const { center } = config;
    const w = SIZES.proShopWidth;
    const d = SIZES.proShopDepth;
    const h = SIZES.proShopHeight;
    const cx = center.x, cz = center.z;
    const x0 = cx - w / 2, x1 = cx + w / 2, zb = cz - d / 2, zf = cz + d / 2;
    const T = 0.3, ht = T / 2;
    const X0 = x0 - ht, X1 = x1 + ht, Z0 = zb - ht, Z1 = zf + ht; // outer faces
    const F = 0.08;               // interior floor top
    const eaveY = h + 0.12;
    const wallTop = h + 0.06;
    const ceilY = eaveY - 0.08;   // soffit / ceiling underside
    const doorWidth = 2.5, doorH = 2.6;
    const win = [
      { a: x0 + 0.9, b: cx - doorWidth / 2 - 0.7, y0: 0.65, y1: 2.55 },
      { a: cx + doorWidth / 2 + 0.7, b: x1 - 0.9, y0: 0.65, y1: 2.55 },
    ];
    const openings = [{ a: cx - doorWidth / 2, b: cx + doorWidth / 2, y0: 0, y1: doorH }, ...win];
    const L = this._lists();
    const I = this._lists(); // interior (hidden when far away)
    const r = this._rand;
    const cut = F + 2.5;
    this.cutY = cut;

    // ── Shell ──
    L.walls.push(...wallPieces('x', X0, X1, zf, T, 0, wallTop, openings, undefined, cut));
    L.walls.push(...wallPieces('x', X0, X1, zb, T, 0, wallTop, [], undefined, cut));
    L.walls.push(...wallPieces('z', zb + ht, zf - ht, x0, T, 0, wallTop, [], undefined, cut));
    L.walls.push(...wallPieces('z', zb + ht, zf - ht, x1, T, 0, wallTop, [], undefined, cut));

    // Stone plinth (door gap), corner boards, frieze
    L.trim.push(...wallPieces('x', X0 - 0.06, X1 + 0.06, Z1 + 0.01, 0.1, 0, 0.42, [{ a: cx - doorWidth / 2, b: cx + doorWidth / 2, y0: 0, y1: 1 }], C.stone));
    L.trim.push(...wallPieces('x', X0 - 0.06, X1 + 0.06, Z0 - 0.01, 0.1, 0, 0.42, [], C.stone));
    L.trim.push(...wallPieces('z', Z0 + 0.04, Z1 - 0.04, X0 - 0.01, 0.1, 0, 0.42, [], C.stone));
    L.trim.push(...wallPieces('z', Z0 + 0.04, Z1 - 0.04, X1 + 0.01, 0.1, 0, 0.42, [], C.stone));
    for (const [X, sx] of [[X0, 1], [X1, -1]]) for (const [Z, sz] of [[Z0, 1], [Z1, -1]]) {
      L.trim.push(P(bevelBox(0.2, cut - 0.42, 0.2, 0.02), M(X + sx * 0.07, (0.42 + cut) / 2, Z + sz * 0.07), C.trim));
      L.trim.push(P(bevelBox(0.2, h + 0.02 - cut, 0.2, 0.02), M(X + sx * 0.07, (cut + h + 0.02) / 2, Z + sz * 0.07), C.trim));
    }
    const fy = (3.72 + ceilY) / 2, fh = ceilY - 3.72;
    L.trim.push(P(boxGeo(X1 - X0 + 0.1, fh, 0.05), M(cx, fy, Z1 + 0.015), C.trim));
    L.trim.push(P(boxGeo(X1 - X0 + 0.1, fh, 0.05), M(cx, fy, Z0 - 0.015), C.trim));
    L.trim.push(P(boxGeo(0.05, fh, Z1 - Z0), M(X0 - 0.015, fy, cz), C.trim));
    L.trim.push(P(boxGeo(0.05, fh, Z1 - Z0), M(X1 + 0.015, fy, cz), C.trim));

    // Front stoop
    L.trim.push(P(bevelBox(doorWidth + 1.0, 0.09, 1.1, 0.03), M(cx, 0.045, Z1 + 0.55), C.stone));

    // ── Storefront windows (real openings) ──
    for (const o of win) {
      const mid = (o.a + o.b) / 2, ww = o.b - o.a, wh = o.y1 - o.y0, my = (o.y0 + o.y1) / 2;
      L.store.push(P(atlasPlane('storeGlass', +ww.toFixed(3), +wh.toFixed(3), 0, 0, 1, 1), M(mid, my, zf + 0.02)));
      // green storefront frame inside the opening
      L.trim.push(P(boxGeo(ww, 0.07, 0.14), M(mid, o.y0 + 0.035, zf), C.green));
      L.trim.push(P(boxGeo(ww, 0.07, 0.14), M(mid, o.y1 - 0.035, zf), C.green));
      L.trim.push(P(boxGeo(0.07, wh, 0.14), M(o.a + 0.035, my, zf), C.green));
      L.trim.push(P(boxGeo(0.07, wh, 0.14), M(o.b - 0.035, my, zf), C.green));
      for (const f of [1 / 3, 2 / 3]) L.trim.push(P(boxGeo(0.06, wh, 0.12), M(o.a + ww * f, my, zf), C.green));
      L.trim.push(P(boxGeo(ww, 0.06, 0.12), M(mid, 2.1, zf), C.green));
      // white casing + sill outside, stool inside
      L.trim.push(P(boxGeo(ww + 0.24, 0.12, 0.06), M(mid, o.y1 + 0.06, Z1 + 0.03), C.trim));
      L.trim.push(P(boxGeo(0.12, wh + 0.06, 0.06), M(o.a - 0.06, my + 0.03, Z1 + 0.03), C.trim));
      L.trim.push(P(boxGeo(0.12, wh + 0.06, 0.06), M(o.b + 0.06, my + 0.03, Z1 + 0.03), C.trim));
      L.trim.push(P(bevelBox(ww + 0.34, 0.06, 0.22, 0.02), M(mid, o.y0 - 0.03, Z1 + 0.08), C.trim));
      L.trim.push(P(bevelBox(ww + 0.1, 0.04, 0.2, 0.01), M(mid, o.y0 - 0.02, zf - ht - 0.08), C.trim));
      // flower box under each storefront
      this._flowerBox(L, M(mid, 0.4, Z1), ww + 0.1, C.green);
      // striped awning
      const aw = ww + 0.5;
      L.awning.push(P(awningGeo(+aw.toFixed(3), 1.05, 0.5, 0.28), M(mid, 3.1, Z1 + 0.02)));
      L.metal.push(P(boxGeo(aw + 0.04, 0.05, 0.05), M(mid, 3.12, Z1 + 0.04), C.iron));
      for (const s of [-1, 1]) L.metal.push(P(boxGeo(1, 1, 1), segMatrix(V(mid + s * aw / 2, 2.45, Z1), V(mid + s * aw / 2, 2.62, Z1 + 1.04), 0.03, 0.03), C.iron));
    }

    // ── Entrance ──
    L.trim.push(P(boxGeo(doorWidth + 0.24, 0.12, 0.07), M(cx, doorH + 0.06, Z1 + 0.035), C.trim));
    for (const s of [-1, 1]) L.trim.push(P(boxGeo(0.12, doorH, 0.07), M(cx + s * (doorWidth / 2 + 0.06), doorH / 2, Z1 + 0.035), C.trim));
    L.glass.push(P(glassPane(doorWidth - 0.2, 0.45, 2), M(cx, 2.975, Z1 + 0.012)));
    L.trim.push(P(boxGeo(doorWidth + 0.04, 0.1, 0.06), M(cx, 3.25, Z1 + 0.03), C.trim));
    for (const s of [-1, 1]) L.trim.push(P(boxGeo(0.1, 0.55, 0.06), M(cx + s * (doorWidth / 2 - 0.08), 2.97, Z1 + 0.03), C.trim));
    L.metal.push(P(boxGeo(doorWidth, 0.02, T + 0.04), M(cx, F + 0.01, zf), C.brass));
    // Glass doors swung open against the inside of the front wall
    for (const s of [-1, 1]) {
      const base = M(cx + s * (doorWidth / 2 - 0.05), F, zf - ht - 0.62, HALF_PI);
      for (const lx of [-0.54, 0.54]) L.trim.push(P(bevelBox(0.1, 2.5, 0.05, 0.015), at(base, lx, 1.25, 0), C.green));
      L.trim.push(P(bevelBox(1.18, 0.14, 0.05, 0.015), at(base, 0, 2.43, 0), C.green));
      L.trim.push(P(bevelBox(1.18, 0.3, 0.05, 0.015), at(base, 0, 0.15, 0), C.green));
      L.store.push(P(atlasPlane('doorGlass', 0.98, 2.06, 0, 0, 1, 1), at(base, 0, 1.33, 0)));
      L.metal.push(P(cylinderGeo(0.016, 0.016, 0.55, 8), at(base, -s * 0.42, 1.1, 0.06), C.brass));
    }
    // Lanterns either side of the door
    for (const s of [-1, 1]) this._lantern(L, M(cx + s * 1.62, 2.2, Z1, 0));

    // ── Side & back windows (surface-mounted), back service door ──
    for (const z of [zb + 2.3, zf - 2.3]) {
      this._window(L, M(X0, 1.75, z, -HALF_PI), 1.2, 1.4, { variant: (z * 7 | 0) & 3, shutters: true });
      this._window(L, M(X1, 1.75, z, HALF_PI), 1.2, 1.4, { variant: (z * 3 | 0) & 3, shutters: true });
    }
    for (const x of [x0 + 2.2, x1 - 2.2]) this._window(L, M(x, 1.75, Z0, Math.PI), 1.2, 1.4, { variant: 1, shutters: true });
    const backDoor = M(cx, 0, Z0, Math.PI);
    this._door(L, backDoor, 1.1, 2.2, { double: false, transom: false });
    L.trim.push(P(bevelBox(1.7, 0.08, 0.7, 0.02), at(backDoor, 0, 2.62, 0.35), C.green));
    for (const s of [-1, 1]) L.trim.push(P(boxGeo(1, 1, 1), segMatrix(V(s * 0.75, 2.2, 0.02), V(s * 0.75, 2.58, 0.62), 0.06, 0.06).premultiply(backDoor), C.trim));
    this._lantern(L, at(backDoor, 0.95, 2.0, 0));

    // ── Interior ──
    const li = 0.03, xi0 = x0 + ht, xi1 = x1 - ht, zi0 = zb + ht, zi1 = zf - ht;
    for (const [yA, yB, col] of [[F, 1.0, C.wainscot], [1.0, ceilY, C.interior]]) {
      L.interior.push(...wallPieces('x', xi0, xi1, zi0 + li / 2, li, yA, yB, [], col, cut));
      L.interior.push(...wallPieces('z', zi0 + li, zi1 - li, xi0 + li / 2, li, yA, yB, [], col, cut));
      L.interior.push(...wallPieces('z', zi0 + li, zi1 - li, xi1 - li / 2, li, yA, yB, [], col, cut));
      L.interior.push(...wallPieces('x', xi0, xi1, zi1 - li / 2, li, yA, yB, openings, C.interior, cut));
    }
    const ii0 = xi0 + li, ii1 = xi1 - li, jz0 = zi0 + li, jz1 = zi1 - li; // interior surfaces
    // chair rail, baseboard, crown
    for (const [y, hh, dd, col] of [[1.0, 0.06, 0.035, C.trim], [F + 0.06, 0.12, 0.025, C.woodDark], [ceilY - 0.05, 0.1, 0.05, C.trim]]) {
      L.trim.push(P(boxGeo(ii1 - ii0, hh, dd), M(cx, y, jz0 + dd / 2), col));
      L.trim.push(P(boxGeo(dd, hh, jz1 - jz0 - 2 * dd), M(ii0 + dd / 2, y, cz), col));
      L.trim.push(P(boxGeo(dd, hh, jz1 - jz0 - 2 * dd), M(ii1 - dd / 2, y, cz), col));
    }
    // floor (+ threshold) and entry rug
    I.floor.push(P(boxGeo(xi1 - xi0, F, zi1 - zi0), M(cx, F / 2, cz)));
    I.floor.push(P(boxGeo(doorWidth, F, T), M(cx, F / 2, zf)));
    // Floor physics (top at F) so feet stand on the boards, not 8 cm inside them
    this._addWallPhysics(cx, F - 0.1, (zi0 + zf + ht) / 2, (xi1 - xi0) / 2, 0.1, (zf + ht - zi0) / 2);
    I.trim.push(P(bevelBox(2.4, 0.012, 1.7, 0.004), M(cx, F + 0.006, zi1 - 1.1), 0xe9dcb8));
    I.trim.push(P(bevelBox(2.1, 0.022, 1.4, 0.006), M(cx, F + 0.011, zi1 - 1.1), C.green));

    // Task board (cork board from the sign atlas) with a brass picture light
    if (config.taskBoard) {
      const tb = config.taskBoard;
      const bz = jz0;
      const board = signPlane('board', 1.5);
      I.trim.push(P(bevelBox(1.66, board.h + 0.16, 0.06, 0.02), M(tb.x, tb.y, bz + 0.03), C.woodDark));
      I.signs.push(P(board.geo, M(tb.x, tb.y, bz + 0.065)));
      I.metal.push(P(boxGeo(0.06, 0.2, 0.05), M(tb.x, tb.y + board.h / 2 + 0.2, bz + 0.03), C.brass));
      I.metal.push(P(cylinderGeo(0.045, 0.045, 0.9, 10), M(tb.x, tb.y + board.h / 2 + 0.3, bz + 0.2, 0, 1, 0, HALF_PI), C.brass));
      I.lamp.push(P(boxGeo(0.8, 0.02, 0.06), M(tb.x, tb.y + board.h / 2 + 0.26, bz + 0.2)));
      I.metal.push(P(boxGeo(1, 1, 1), segMatrix(V(tb.x, tb.y + board.h / 2 + 0.28, bz + 0.05), V(tb.x, tb.y + board.h / 2 + 0.3, bz + 0.18), 0.03, 0.03), C.brass));
    }

    // Back-wall shelving unit (to the right of the task board)
    {
      const sx = cx - 1.4, sw = 2.4, sd = 0.45, sz = jz0 + sd / 2;
      for (const s of [-1, 1]) I.trim.push(P(bevelBox(0.06, 2.3, sd, 0.015), M(sx + s * (sw / 2 - 0.03), F + 1.15, sz), C.woodDark));
      I.trim.push(P(boxGeo(sw, 2.3, 0.02), M(sx, F + 1.15, jz0 + 0.01), 0x8a6a48));
      const shelfYs = [0.35, 0.9, 1.45, 2.0, 2.3];
      for (const y of shelfYs) I.trim.push(P(bevelBox(sw - 0.1, 0.04, sd - 0.02, 0.01), M(sx, F + y, sz), C.wood));
      const shoe = [0xf4f1e8, 0xf28c28, 0x3b6ea8, 0xe0e0dc, 0x2d5a3d, 0xc23b4e];
      for (let i = 0; i < 4; i++) I.trim.push(P(bevelBox(0.44, 0.16, 0.3, 0.02), M(sx - 0.8 + i * 0.52, F + 0.37 + 0.08, sz), shoe[i]));
      for (let i = 0; i < 4; i++) I.trim.push(P(bevelBox(0.44, 0.16, 0.3, 0.02), M(sx - 0.8 + i * 0.52, F + 0.37 + 0.24, sz), shoe[(i + 2) % 6]));
      for (let i = 0; i < 12; i++) {
        I.trim.push(P(cylinderGeo(0.04, 0.04, 0.22, 10), M(sx - 1.0 + i * 0.18, F + 0.92 + 0.11, sz + 0.05), C.ball));
        I.trim.push(P(cylinderGeo(0.042, 0.042, 0.03, 10), M(sx - 1.0 + i * 0.18, F + 0.92 + 0.235, sz + 0.05), 0x5d6266));
      }
      for (let i = 0; i < 7; i++) I.trim.push(P(cylinderGeo(0.05, 0.05, 0.05, 12), M(sx - 0.9 + i * 0.3, F + 1.5, sz + 0.05, 0, 1, HALF_PI), [0xf4f1e8, 0x2d5a3d, 0xc23b4e, 0x3b6ea8][i % 4]));
      for (let i = 0; i < 3; i++) I.trim.push(P(bevelBox(0.6, 0.26, 0.32, 0.05), M(sx - 0.7 + i * 0.7, F + 2.02 + 0.13, sz), [0x2d5a3d, 0x1f3f63, 0xb8343e][i]));
    }

    // Counter with register, bell, ball-can pyramid, towels
    {
      const kx = cx + 2, kz = cz - 2;
      I.trim.push(P(bevelBox(4.0, 0.98, 0.85, 0.04), M(kx, F + 0.49, kz), C.green));
      I.trim.push(P(bevelBox(4.2, 0.06, 1.02, 0.02), M(kx, F + 1.01, kz), C.wood));
      for (let i = 0; i < 4; i++) I.trim.push(P(bevelBox(0.78, 0.58, 0.03, 0.01), M(kx - 1.44 + i * 0.96, F + 0.5, kz + 0.43), C.greenLight));
      I.trim.push(P(boxGeo(4.0, 0.08, 0.05), M(kx, F + 0.04, kz + 0.41), C.woodDark));
      I.trim.push(P(bevelBox(0.46, 0.14, 0.4, 0.03), M(kx + 0.8, F + 1.11, kz - 0.1), 0x2b2f33));
      I.trim.push(P(bevelBox(0.42, 0.28, 0.03, 0.01), M(kx + 0.8, F + 1.32, kz - 0.25, 0, 1, -0.3), 0x2b2f33));
      I.lamp.push(P(boxGeo(0.36, 0.22, 0.005), M(kx + 0.8, F + 1.32, kz - 0.268, Math.PI, 1, 0.3)));
      I.trim.push(P(bevelBox(0.12, 0.05, 0.18, 0.01), M(kx + 1.3, F + 1.065, kz + 0.2), 0x2b2f33));
      I.metal.push(P(cylinderGeo(0.07, 0.08, 0.02, 12), M(kx + 1.6, F + 1.05, kz + 0.25), C.brass));
      I.metal.push(P(sphereGeo(0.06, 12, 6), M(kx + 1.6, F + 1.07, kz + 0.25, 0, [1, 0.7, 1]), C.brass));
      const cans = [[-3, 0], [-1, 0], [1, 0], [3, 0], [-2, 1], [0, 1], [2, 1], [-1, 2], [1, 2], [0, 3]];
      for (const [i, row] of cans) {
        const px = kx - 1.2 + i * 0.05, py = F + 1.04 + row * 0.2 + 0.1;
        I.trim.push(P(cylinderGeo(0.045, 0.045, 0.18, 10), M(px, py, kz + 0.1), C.ball));
        I.trim.push(P(cylinderGeo(0.047, 0.047, 0.025, 10), M(px, py + 0.1, kz + 0.1), 0x5d6266));
      }
      for (let i = 0; i < 3; i++) I.trim.push(P(bevelBox(0.4, 0.07, 0.3, 0.03), M(kx - 0.35, F + 1.075 + i * 0.07, kz + 0.15, i * 0.1), i === 1 ? 0xeae6da : 0xf4f1e8));
      // stool behind the counter
      I.trim.push(P(cylinderGeo(0.2, 0.2, 0.06, 14), M(kx + 0.6, F + 0.72, kz - 0.9), C.wood));
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) I.metal.push(P(cylinderGeo(0.015, 0.015, 0.7, 5), M(kx + 0.6 + a * 0.11, F + 0.35, kz - 0.9 + b * 0.11), C.iron));
    }

    // Wall behind the counter: club crest + trophy shelf; bag shelf in the corner
    {
      const [u0, v0, u1, v1] = regionUV(ATLAS.crest);
      I.signs.push(P(atlasDisc('crest', 0.55, u0, v0, u1, v1), M(cx + 2, 2.75, jz0 + 0.02)));
      I.trim.push(P(cylinderGeo(0.6, 0.6, 0.03, 28), M(cx + 2, 2.75, jz0 + 0.005, 0, 1, HALF_PI), C.woodDark));
      I.trim.push(P(bevelBox(2.4, 0.05, 0.3, 0.01), M(cx + 2, 1.7, jz0 + 0.15), C.wood));
      for (const [ox, s] of [[-0.8, 0.85], [0, 1.15], [0.8, 0.95]]) {
        I.metal.push(P(cylinderGeo(0.08 * s, 0.05 * s, 0.14 * s, 12), M(cx + 2 + ox, 1.725 + 0.07 * s, jz0 + 0.15), 0x3a2a1a));
        I.metal.push(P(cylinderGeo(0.1 * s, 0.03 * s, 0.2 * s, 14), M(cx + 2 + ox, 1.725 + 0.24 * s, jz0 + 0.15), C.brass));
        I.metal.push(P(cylinderGeo(0.015 * s, 0.015 * s, 0.1 * s, 6), M(cx + 2 + ox, 1.725 + 0.12 * s, jz0 + 0.15), C.brass));
      }
      const bx = ii1 - 1.25;
      for (const s of [-1, 1]) I.trim.push(P(bevelBox(0.06, 2.2, 0.5, 0.015), M(bx + s * 1.1, F + 1.1, jz0 + 0.25), C.woodDark));
      for (const y of [0.45, 1.2, 1.95]) I.trim.push(P(bevelBox(2.2, 0.04, 0.48, 0.01), M(bx, F + y, jz0 + 0.25), C.wood));
      const bags = [0x2d5a3d, 0xc23b4e, 0x1f3f63, 0xf4f1e8, 0x222222, 0xf28c28];
      for (let i = 0; i < 6; i++) {
        const row = i % 3, col = i >> 2 ? 1 : 0;
        I.trim.push(P(bevelBox(0.85, 0.28, 0.32, 0.1), M(bx - 0.5 + col * 0.95, F + [0.45, 1.2, 1.95][row] + 0.16, jz0 + 0.26), bags[i]));
      }
    }

    // Racket wall (left) with a RACKETS sign
    {
      const px = ii0;
      I.trim.push(P(bevelBox(0.03, 1.75, 6.2, 0.01), M(px + 0.015, 1.8, cz), 0xc9a57a));
      for (const zz of [cz - 3.1, cz + 3.1]) I.trim.push(P(boxGeo(0.05, 1.85, 0.08), M(px + 0.03, 1.8, zz), C.woodDark));
      const cols = [0xc23b4e, 0x222222, 0x1f5fa8, 0xf4f1e8, 0xf28c28, 0x9acd32, 0x6a3d9a, 0xe0e0dc, 0xd4a017];
      for (let row = 0; row < 2; row++) {
        for (let i = 0; i < 9; i++) {
          const zz = cz - 2.6 + i * 0.65;
          const base = M(px + 0.05, 1.35 + row * 0.8, zz, HALF_PI, 1, 0, (r() - 0.5) * 0.08);
          this._racket(I.trim, base, cols[(i + row * 4) % cols.length]);
          I.metal.push(P(cylinderGeo(0.008, 0.008, 0.08, 4), M(px + 0.05, 1.35 + row * 0.8 + 0.39, zz, 0, 1, 0, HALF_PI), C.chrome));
        }
      }
      const rs = signPlane('rackets', 1.5);
      I.trim.push(P(bevelBox(0.04, rs.h + 0.06, 1.56, 0.01), M(px + 0.02, 3.05, cz), C.woodDark));
      I.signs.push(P(rs.geo, M(px + 0.045, 3.05, cz, HALF_PI)));
    }

    // Apparel racks + shoe cubbies (right wall)
    {
      const px = ii1;
      const shirt = [0x2d5a3d, 0xf4f1e8, 0x1f3f63, 0xf08a7a, 0xf2d15e, 0x7fb3d5, 0xffffff, 0xc23b4e];
      for (const [z0r, z1r] of [[cz - 2.7, cz - 0.3], [cz + 0.4, cz + 2.8]]) {
        const rx = px - 0.75, rzc = (z0r + z1r) / 2, len = z1r - z0r;
        I.metal.push(P(cylinderGeo(0.018, 0.018, len, 8), M(rx, F + 1.52, rzc, 0, 1, HALF_PI), C.chrome));
        for (const zz of [z0r, z1r]) {
          I.metal.push(P(cylinderGeo(0.018, 0.018, 1.5, 8), M(rx, F + 0.77, zz), C.chrome));
          I.metal.push(P(boxGeo(0.5, 0.03, 0.05), M(rx, F + 0.02, zz), C.chrome));
        }
        const n = Math.floor(len / 0.17);
        for (let i = 0; i < n; i++) {
          const zz = z0r + 0.12 + i * ((len - 0.24) / (n - 1));
          I.trim.push(P(bevelBox(0.5, 0.64, 0.035, 0.012), M(rx, F + 1.15, zz, 0, 1, 0, (r() - 0.5) * 0.05), shirt[(i * 3 + (z0r > cz ? 1 : 0)) % shirt.length]));
        }
      }
      for (const y of [2.0, 2.45]) {
        I.trim.push(P(bevelBox(0.32, 0.04, 5.6, 0.01), M(px - 0.16, y, cz), C.wood));
        for (let i = 0; i < 9; i++) {
          const zz = cz - 2.5 + i * 0.62;
          for (const o of [-0.06, 0.06]) I.trim.push(P(bevelBox(0.26, 0.1, 0.1, 0.035), M(px - 0.17, y + 0.07, zz + o), shirt[(i + (y > 2.2 ? 3 : 0)) % shirt.length]));
        }
      }
      const as = signPlane('apparel', 1.5);
      I.trim.push(P(bevelBox(0.04, as.h + 0.06, 1.56, 0.01), M(px - 0.02, 3.05, cz), C.woodDark));
      I.signs.push(P(as.geo, M(px - 0.045, 3.05, cz, -HALF_PI)));
    }

    // Display table, ball hopper, plants, storefront displays, OPEN sign
    {
      const tx = cx + 3.6, tz = cz + 2.0;
      I.trim.push(P(cylinderGeo(0.1, 0.16, 0.75, 12), M(tx, F + 0.375, tz), C.woodDark));
      I.trim.push(P(cylinderGeo(0.62, 0.62, 0.05, 24), M(tx, F + 0.77, tz), C.wood));
      const fold = [0xf4f1e8, 0x2d5a3d, 0x1f3f63, 0xf08a7a];
      for (let s = 0; s < 3; s++) {
        const a = s * 2.1, ox = Math.cos(a) * 0.3, oz = Math.sin(a) * 0.3;
        for (let k = 0; k < 3; k++) I.trim.push(P(bevelBox(0.3, 0.05, 0.24, 0.015), M(tx + ox, F + 0.82 + k * 0.05, tz + oz, a), fold[(s + k) % 4]));
      }
      for (const [a, col] of [[0.8, 0xf4f1e8], [2.9, C.green], [5.0, 0x1f3f63]]) {
        const ox = Math.cos(a) * 0.12, oz = Math.sin(a) * 0.12;
        I.trim.push(P(sphereGeo(0.09, 10, 5), M(tx + ox, F + 0.8, tz + oz, 0, [1, 0.6, 1]), col));
        I.trim.push(P(boxGeo(0.12, 0.012, 0.1), M(tx + ox + Math.cos(a) * 0.12, F + 0.8, tz + oz + Math.sin(a) * 0.12, -a), col));
      }
      // ball hopper
      const hx = ii0 + 0.7, hz = jz1 - 0.9;
      I.metal.push(P(cylinderGeo(0.22, 0.19, 0.46, 12, true), M(hx, F + 0.55, hz), 0x2b2f33));
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) I.metal.push(P(cylinderGeo(0.012, 0.012, 0.6, 4), M(hx + a * 0.13, F + 0.3, hz + b * 0.13), 0x2b2f33));
      for (let i = 0; i < 14; i++) {
        const a = i * 2.4, rr = 0.05 + (i % 3) * 0.05;
        I.trim.push(P(sphereGeo(0.034, 8, 5), M(hx + Math.cos(a) * rr, F + 0.74 + (i % 4) * 0.02, hz + Math.sin(a) * rr), C.ball));
      }
      // plants in the front corners
      for (const px of [ii0 + 0.4, ii1 - 0.4]) {
        const pz = jz1 - 0.45;
        I.trim.push(P(cylinderGeo(0.24, 0.18, 0.4, 12), M(px, F + 0.2, pz), 0xb8643e));
        I.trim.push(P(cylinderGeo(0.03, 0.04, 0.9, 5), M(px, F + 0.8, pz), C.woodDark));
        for (let k = 0; k < 5; k++) I.trim.push(P(icoGeo(0.26 - k * 0.02, 0), M(px + (r() - 0.5) * 0.3, F + 1.0 + k * 0.22, pz + (r() - 0.5) * 0.3, r() * 3), k % 2 ? C.leaf : C.leafDark));
      }
      // storefront display plinths
      for (const [k, o] of win.entries()) {
        const mid = (o.a + o.b) / 2, dz = zi1 - 0.3;
        I.trim.push(P(bevelBox(o.b - o.a - 0.5, 0.5, 0.45, 0.03), M(mid, F + 0.25, dz), 0xe9dcb8));
        I.trim.push(P(bevelBox(0.95, 0.3, 0.3, 0.1), M(mid - 0.9, F + 0.65, dz), k ? 0xc23b4e : C.green));
        I.trim.push(P(bevelBox(0.97, 0.06, 0.31, 0.02), M(mid - 0.9, F + 0.68, dz), 0xf4f1e8));
        for (let i = 0; i < 3; i++) I.trim.push(P(cylinderGeo(0.045, 0.045, 0.2, 10), M(mid + 0.1 + i * 0.12, F + 0.6, dz), C.ball));
        this._racket(I.trim, M(mid + 0.9, F + 0.88, dz - 0.05, 0, 1, -0.12, 0.25), k ? 0x1f5fa8 : 0xc23b4e);
      }
      const op = signPlane('open', 0.6);
      L.signs.push(P(op.geo, M(win[0].b - 0.55, 2.15, zf - 0.02, Math.PI)));
      L.signs.push(P(op.geo, M(win[0].b - 0.55, 2.15, zf + 0.04)));
      L.metal.push(P(boxGeo(0.005, 0.4, 0.005), M(win[0].b - 0.75, 2.45, zf + 0.01), C.iron));
      L.metal.push(P(boxGeo(0.005, 0.4, 0.005), M(win[0].b - 0.35, 2.45, zf + 0.01), C.iron));
    }

    // ── Roof layer (cutaway group) ──
    const rx0 = X0 - 0.55, rx1 = X1 + 0.55, rz0 = Z0 - 0.55, rz1 = Z1 + 0.55;
    const rise = ((rz1 - rz0) / 2) * 0.51;
    const sb = new SurfaceBuilder();
    const lines = sb.hipRoof(rx0, rx1, rz0, rz1, eaveY, rise, 2.0);
    this._roofCaps(L.roofTrim, lines, C.ridgeGreen);
    this._eaves(L.roofTrim, rx0, rx1, rz0, rz1, eaveY, C.green, C.ceiling);
    // Front cross gable carrying the PRO SHOP sign
    const gHW = 2.5, gRise = 2.3, gOv = 0.3, slope = gRise / gHW;
    const gz = rz1 + 0.1;                  // pediment front face
    const gFront = gz + 0.45;
    const gEave = eaveY - gOv * slope;
    const g = sb.crossGableZ(cx, gHW + gOv, cz + 0.8, rz1, gFront, eaveY, gEave, eaveY + gRise, 2.0);
    this._roofCaps(L.roofTrim, { ridge: g.ridge }, C.ridgeGreen);
    L.roofTrim.push(P(prismGeo(gHW, gRise, 0.14), M(cx, eaveY - 0.06, gz - 0.14), C.siding)); // 6 cm under the roof plane (no z-fight)
    L.roofTrim.push(P(boxGeo(2 * gHW + 0.2, 0.14, gz - Z1 + 0.06), M(cx, eaveY - 0.07, (Z1 + gz + 0.06) / 2), C.trim));
    for (const s of [-1, 1]) {
      L.roofTrim.push(P(boxGeo(1, 1, 1), segMatrix(V(cx + s * (gHW + gOv), gEave - 0.07, gFront - 0.03), V(cx, eaveY + gRise - 0.07, gFront - 0.03), 0.2, 0.06), C.green));
      L.roofTrim.push(P(bevelBox(0.16, 0.5, 0.5, 0.03), M(cx + s * (gHW - 0.15), eaveY - 0.38, Z1 + 0.25), C.trim));
    }
    L.roofTrim.push(P(cylinderGeo(0.4, 0.4, 0.04, 24), M(cx, eaveY + 1.5, gz + 0.02, 0, 1, HALF_PI), C.trim));
    L.roofTrim.push(P(cylinderGeo(0.32, 0.32, 0.05, 24), M(cx, eaveY + 1.5, gz + 0.03, 0, 1, HALF_PI), C.green));
    for (let i = -2; i <= 2; i++) L.roofTrim.push(P(boxGeo(0.5 - Math.abs(i) * 0.08, 0.04, 0.03), M(cx, eaveY + 1.5 + i * 0.1, gz + 0.06), C.greenDark));
    const ps = signPlane('proShop', 3.0);
    L.roofTrim.push(P(bevelBox(3.12, ps.h + 0.1, 0.06, 0.02), M(cx, eaveY + 0.48, gz + 0.03), C.green));
    L.roofSign.push(P(ps.geo, M(cx, eaveY + 0.48, gz + 0.064)));
    // Ceiling lights
    for (const lx of [-4, 0, 4]) for (const lz of [-2.5, 2.5]) {
      L.roofLamp.push(P(cylinderGeo(0.26, 0.26, 0.03, 18), M(cx + lx, ceilY - 0.015, cz + lz)));
      L.roofTrim.push(P(cylinderGeo(0.3, 0.3, 0.02, 18), M(cx + lx, ceilY - 0.008, cz + lz), C.brass));
    }

    // Ceiling (seen through the door; hidden with the roof layer)
    L.roofTrim.push(P(boxGeo(xi1 - xi0, 0.04, zi1 - zi0), M(cx, ceilY + 0.02, cz), C.ceiling));

    // ── Meshes ──
    this._emit(L, { wallMat: Mat.siding(), wallTile: 1.6, prefix: 'proShop' });
    this._emit(I, { interior: true, prefix: 'proShop' });
    this._emitRoof(L, sb, Mat.roof(C.roofGreen));

    this._contactShadow(X0, X1, Z0, Z1, { front: 0.05, back: 0.05, left: 0.05, right: 0.05 });
    this.rooms.push({ x0: x0 + ht, x1: x1 - ht, z0: zb + ht, z1: zf - ht + 0.1 });
    registerNav({
      rooms: [{ x0: x0 + ht + 0.1, x1: x1 - ht - 0.1, z0: zb + ht + 0.1, z1: zf - ht }],
      doors: [{ a: { x: cx, z: zf - ht - 0.8 }, b: { x: cx, z: zf + ht + 1.0 } }],
    });
    this.footprints.push({ x0: X0 - 0.6, x1: X1 + 0.6, z0: Z0 - 0.6, z1: Z1 + 0.6 });
    this.roofTop = eaveY + rise + 0.5;

    // Physics walls (unchanged from the original layout)
    const frontLeftW = (w - doorWidth) / 2;
    this._addWallPhysics(center.x, h / 2, center.z - d / 2, w / 2, h / 2, 0.15); // back
    this._addWallPhysics(center.x - w / 2, h / 2, center.z, 0.15, h / 2, d / 2); // left
    this._addWallPhysics(center.x + w / 2, h / 2, center.z, 0.15, h / 2, d / 2); // right
    // front walls (with gap)
    this._addWallPhysics(center.x - doorWidth / 2 - frontLeftW / 2, h / 2, center.z + d / 2, frontLeftW / 2, h / 2, 0.15);
    this._addWallPhysics(center.x + doorWidth / 2 + frontLeftW / 2, h / 2, center.z + d / 2, frontLeftW / 2, h / 2, 0.15);
  }

  _contactShadow(x0, x1, z0, z1, ys) {
    const geo = contactFrameGeo(x0 - 0.04, x1 + 0.04, z0 - 0.04, z1 + 0.04, 1.3, ys);
    const m = new THREE.Mesh(geo, Mat.contact());
    m.name = `${this.type}:contact`;
    m.renderOrder = 1;
    m.userData.noAO = true;
    this.mesh.add(m);
  }

  _addWallPhysics(x, y, z, hw, hh, hd) {
    const shape = new CANNON.Box(new CANNON.Vec3(hw, hh, hd));
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, y, z), shape });
    this.physicsWorld.addBody(body);
  }
}
