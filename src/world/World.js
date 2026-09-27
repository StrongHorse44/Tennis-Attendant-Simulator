import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES } from '../utils/Constants.js';
import { Court, sharedPadSides } from './Court.js';
import { Building } from './Building.js';
import { Clubhouse, FitnessCenter, PoolHouse } from './ClubBuildings.js';
import { CameraTracker } from '../entities/CharacterModel.js';
import { Garden } from './Garden.js';
import { GROUND_GROUPS, setGroundModel, setGroundExtents, groundAt } from './Ground.js';
import { findStadiumCourt, computeStadiumLayout } from './StadiumLayout.js';
import { Stadium } from './Stadium.js';
import { Scenery, bakeParts } from './Scenery.js';
import { EnvState } from '../graphics/EnvState.js';
import { Quality } from '../graphics/Quality.js';
import { mat, getMaterial } from '../graphics/Materials.js';
import { Textures, createCanvasTexture, fbm2, valueNoise2, seededRandom, hash2 } from '../graphics/Textures.js';
import {
  getGeometry, roundedBox, boxGeo, cylinderGeo, sphereGeo, coneGeo,
  mergeStaticMeshes, createInstanced, mergeParts, makeMatrix,
} from '../graphics/GeometryUtils.js';

// Layer heights for flat ground pieces (>= 0.015 apart so nothing z-fights, all below court surfaces ~0.155)
const LAYER = {
  edge: 0.02,     // brick edging under paths
  path: 0.04,     // concrete cart paths
  lot: 0.06,      // asphalt parking + driveway (covers paths that cross it)
  paint: 0.078,   // parking paint
};

const PATH_TILE = 5;       // world metres per concrete texture tile
const EDGE_EXTRA = 0.42;   // total extra width of the edging band

// ───────────────────────────── helpers ─────────────────────────────

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-6;
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + dx * t - px, z = az + dz * t - pz;
  return Math.sqrt(x * x + z * z);
}

/**
 * Builds flat, upward-facing ground decals (ribbons, discs, rects) into one geometry with
 * WORLD-SPACE UVs. Overlapping pieces at the same height sample the same texel, so unions
 * of segments + joint discs render seamlessly (no z-fighting / flicker).
 */
class FlatBuilder {
  constructor() { this.pos = []; this.idx = []; }
  _tri(a, b, c) {
    // ensure +Y facing (counter-clockwise seen from above)
    const p = this.pos;
    const ax = p[a * 3], az = p[a * 3 + 2], bx = p[b * 3], bz = p[b * 3 + 2], cx = p[c * 3], cz = p[c * 3 + 2];
    const cross = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (cross >= 0) this.idx.push(a, b, c); else this.idx.push(a, c, b);
  }
  ribbon(ax, az, bx, bz, w) {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    const nx = (-dz / L) * w / 2, nz = (dx / L) * w / 2;
    const i = this.pos.length / 3;
    this.pos.push(ax + nx, 0, az + nz, ax - nx, 0, az - nz, bx - nx, 0, bz - nz, bx + nx, 0, bz + nz);
    this._tri(i, i + 1, i + 2); this._tri(i, i + 2, i + 3);
  }
  disc(cx, cz, r, seg = 20) {
    const c = this.pos.length / 3;
    this.pos.push(cx, 0, cz);
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      this.pos.push(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
    }
    for (let s = 0; s < seg; s++) this._tri(c, c + 1 + s, c + 1 + ((s + 1) % seg));
  }
  /** Convex quad (any winding) from four [x, z] corners. */
  quad(p0, p1, p2, p3) {
    const i = this.pos.length / 3;
    for (const q of [p0, p1, p2, p3]) this.pos.push(q[0], 0, q[1]);
    this._tri(i, i + 1, i + 2); this._tri(i, i + 2, i + 3);
  }
  rect(cx, cz, hx, hz, rotY = 0) {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const i = this.pos.length / 3;
    for (const [lx, lz] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]]) {
      this.pos.push(cx + lx * c + lz * s, 0, cz - lx * s + lz * c);
    }
    this._tri(i, i + 1, i + 2); this._tri(i, i + 2, i + 3);
  }
  get empty() { return this.idx.length === 0; }
  toGeometry(y, tile = 4) {
    const n = this.pos.length / 3;
    const pos = new Float32Array(this.pos);
    const uv = new Float32Array(n * 2), nor = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3 + 1] = y;
      uv[i * 2] = pos[i * 3] / tile;
      uv[i * 2 + 1] = pos[i * 3 + 2] / tile;
      nor[i * 3 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Replace UVs with a world-space box projection (geometry must already be in world space).
 * vertical: planks/boards run vertically on walls; swapTop: rotate the projection on top faces.
 */
export function worldBoxUV(geo, tile = 2, { vertical = false, swapTop = false } = {}) {
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
    if (ay >= ax && ay >= az) { u = swapTop ? z : x; v = swapTop ? x : z; }
    else if (ax >= az) { u = vertical ? y : z; v = vertical ? z : y; }
    else { u = vertical ? y : x; v = vertical ? x : y; }
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
  return geo;
}

function P(geometry, matrix, color) { return { geometry, matrix, color }; }

/**
 * Fence lines { x0, x1, z0, z1 } from map.json `bounds` ({ minX, maxX, minZ, maxZ }, ± 5 m).
 * A legacy { width, depth } block, or none, gives the old symmetric club (±mapWidth/2 + 5).
 */
function fenceBounds(b) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (b && ok(b.minX) && ok(b.maxX) && ok(b.minZ) && ok(b.maxZ) && b.minX < b.maxX && b.minZ < b.maxZ) {
    return { x0: b.minX - 5, x1: b.maxX + 5, z0: b.minZ - 5, z1: b.maxZ + 5 };
  }
  const hw = (b && ok(b.width) && b.width > 0 ? b.width : SIZES.mapWidth) / 2 + 5;
  const hd = (b && ok(b.depth) && b.depth > 0 ? b.depth : SIZES.mapDepth) / 2 + 5;
  return { x0: -hw, x1: hw, z0: -hd, z1: hd };
}

/**
 * Visual ground plane extents for the fence lines: 55 m of meadow beyond the fence in x and
 * 45 m in z (the old 240 × 200 plane around the ±65 × ±55 club), on even metres so the
 * 2 m vertex grid lands on the bowl's cut edges.
 */
function planeExtents(f) {
  const even = (v, dir) => (dir < 0 ? Math.floor(v / 2) : Math.ceil(v / 2)) * 2;
  return { x0: even(f.x0 - 55, -1), x1: even(f.x1 + 55, 1), z0: even(f.z0 - 45, -1), z1: even(f.z1 + 45, 1) };
}

/** Shared vertex-coloured prop material (everything small & static merges into one draw). */
function propMat() {
  return getMaterial('scenery-prop', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
}
function glossyPropMat() {
  return getMaterial('world-glossyProp', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.15 }));
}

function staticMesh(geo, material, cast = true, receive = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

// ───────────────────────────── textures owned by World ─────────────────────────────

function asphaltTexture() {
  return createCanvasTexture(512, (ctx, s, rand) => {
    ctx.fillStyle = '#66686b';
    ctx.fillRect(0, 0, s, s);
    // soft patches (tileable: draw wrapped)
    for (let i = 0; i < 40; i++) {
      const x = rand() * s, y = rand() * s, r = s * (0.05 + rand() * 0.15);
      const dark = rand() < 0.5;
      for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, dark ? 'rgba(30,32,36,0.10)' : 'rgba(150,150,150,0.08)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
    const cols = ['#8d8e8f', '#4a4b4e', '#a39d93', '#56575a', '#7a7b7d'];
    for (let i = 0; i < s * 70; i++) {
      ctx.fillStyle = cols[(rand() * cols.length) | 0];
      ctx.globalAlpha = 0.35 + rand() * 0.5;
      const r = 0.6 + rand() * 1.5;
      ctx.fillRect(rand() * s, rand() * s, r, r);
    }
    ctx.globalAlpha = 1;
  }, { key: 'world-asphalt' });
}

/** Wrought-iron pickets with spear tips (alpha). 8 bars per tile, V spans the full panel height. */
function picketTexture() {
  return createCanvasTexture(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = '#ffffff';
    const bars = 8, pitch = s / bars, bw = Math.max(3, s / 48);
    for (let i = 0; i < bars; i++) {
      const cx = (i + 0.5) * pitch;
      ctx.fillRect(cx - bw / 2, s * 0.09, bw, s * 0.91);
      ctx.beginPath();                      // spear tip
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx + bw * 1.6, s * 0.1);
      ctx.lineTo(cx - bw * 1.6, s * 0.1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillRect(0, s * 0.16, s, s * 0.035);      // top rail
    ctx.fillRect(0, s * 0.9, s, s * 0.04);        // bottom rail
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, s / 90);
    for (let i = 0; i < bars; i++) {              // rings between bars
      ctx.beginPath();
      ctx.arc((i + 1) * pitch, s * 0.26, pitch * 0.28, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, { key: 'world-ironPickets' });
}

function signTexture(key, lines, { w = 1024, h = 256, bg = '#2d5a3d', fg = '#f1e6c4', gold = '#c9a54c' } = {}) {
  return createCanvasTexture(w, (ctx, W, rand, H) => {
    ctx.save();
    ctx.scale(W / w, H / h);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = gold;
    ctx.lineWidth = h * 0.035;
    ctx.strokeRect(h * 0.07, h * 0.07, w - h * 0.14, h - h * 0.14);
    ctx.lineWidth = h * 0.012;
    ctx.strokeRect(h * 0.12, h * 0.12, w - h * 0.24, h - h * 0.24);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((ln) => {
      ctx.font = `${ln.weight || 'bold'} ${Math.round(h * ln.size)}px Georgia, 'Times New Roman', serif`;
      if (ln.color) ctx.fillStyle = ln.color;
      ctx.fillText(ln.text, w / 2, h * ln.y);
      ctx.fillStyle = fg;
    });
    ctx.restore();
  }, { key, height: h, wrap: THREE.ClampToEdgeWrapping });
}

// ───────────────────────────── World ─────────────────────────────

/**
 * World - loads map.json and builds the entire club environment
 */
export class World {
  constructor(scene, physicsWorld, mapData) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.mapData = mapData;

    // The sunken Centre Court (the court entry with a `stadium` block): its analytic layout is
    // the club's ground model (Ground.js). A broken block degrades to a plain flat court.
    let layout = null;
    const sc = findStadiumCourt(mapData);
    if (sc) {
      try {
        layout = computeStadiumLayout(sc);
      } catch (err) {
        console.warn(`Stadium "${sc.id}" disabled, building a flat court instead:`, err && err.message ? err.message : err);
        if (sc.center) sc.center.y = 0;
        delete sc.stadium;
        layout = null;
      }
    }
    this.stadiumLayout = layout;
    setGroundModel(layout);
    this.stadium = null;
    this.courts = [];
    this.buildings = [];
    this.garden = null;
    this.trees = [];

    this.courtJunctionObjects = []; // coolers + trash bins between courts

    // Fence lines (map.json `bounds` ± 5; the same numbers as the perimeter physics walls) and
    // the visual ground plane around them. The club grew east of the old ±65 m fence: west of
    // _splitX everything outside the bowl (perimeter runs, tree belts, woodland) is built
    // exactly as before, and the extension east of it is built on its own.
    this.bounds = fenceBounds(mapData.bounds);
    this.groundExtents = planeExtents(this.bounds);
    this._splitX = Math.min(this.bounds.x1, SIZES.mapWidth / 2 + 5);
    const parking = mapData.areas.parking;
    const entrance = mapData.areas.entrance;
    this.gateX = parking ? parking.center.x : (entrance ? entrance.center.x : 0);

    this.scenery = new Scenery(scene);
    this.staticRoot = new THREE.Group();
    this.staticRoot.name = 'WorldStatic';
    this.lights = [];
    this._lastLampFactor = -1;

    this._collectBlockers();

    this._buildGround();
    this._buildPaths();
    this._buildCourts();
    this._buildCourtJunctions();
    // Right after the courts and before perimeter, trees, lamps, grass and scenery.build()
    // (the stadium adds rim benches to the scenery batch)
    this.stadium = layout ? new Stadium({
      scene: this.scene, physicsWorld: this.physicsWorld, world: this,
      court: this.courts.find(c => c.id === layout.id) || null, layout, scenery: this.scenery,
    }) : null;
    this._buildProShop();
    this._buildClubhouse();
    this._buildClubBuildings();
    this._buildGarden();
    this._buildEquipmentShed();
    this._buildPatio();
    this._buildParking();
    this._buildPerimeter();
    this._buildTrees();
    this._buildLamps();
    this._buildGrass();

    this.scenery.build();
    // Group merges by 32 m cell as well as material, so each merged mesh stays compact
    // enough for camera + shadow-camera frustum culling.
    mergeStaticMeshes(this.staticRoot, { cellSize: 32 });
    this.staticRoot.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    this.scene.add(this.staticRoot);

    this._buildLights();
  }

  // ───────────────────────────── placement helpers ─────────────────────────────

  _collectBlockers() {
    const A = this.mapData.areas;
    const layout = this.stadiumLayout;
    // A path of the club's east extension (a point east of the old fence line _splitX, or inside
    // the bowl's clear zone) is flagged `ext`: isFree({ preBowl }) and the lawn pass's
    // pre-extension draws leave it out, so the grounds west of it are placed as before it existed
    const clear = layout ? layout.blockers.find(b => b.tag === 'stadiumClear') : null;
    const isExt = (path) => path.points.some(p => p.x > this._splitX + 1e-6
      || (clear && Math.abs(p.x - clear.cx) < clear.hx && Math.abs(p.z - clear.cz) < clear.hz));
    const segs = [];
    for (const path of this.mapData.paths) {
      const w = path.width || 3;
      const ext = isExt(path);
      for (let i = 0; i < path.points.length - 1; i++) {
        const a = path.points[i], b = path.points[i + 1];
        segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, r: w / 2 + EDGE_EXTRA / 2, ext });
      }
    }
    const rects = [];
    const addRect = (cx, cz, hx, hz, tag) => rects.push({ cx, cz, hx, hz, tag });
    for (const c of A.courts || []) {
      if (layout && c.id === layout.id) continue;   // the bowl's court: its 'stadiumCourt' rect comes with the layout
      const clay = c.type === 'clay';
      addRect(c.center.x, c.center.z, SIZES.courtWidth / 2 + (clay ? (SIZES.clayCourtBuffer || 0) + 1.5 : 2.5), SIZES.courtDepth / 2 + 1.5, 'court');
    }
    if (A.proShop) addRect(A.proShop.center.x, A.proShop.center.z, A.proShop.bounds.width / 2 + 1, A.proShop.bounds.depth / 2 + 1, 'building');
    if (A.patio) {
      addRect(A.patio.center.x, A.patio.center.z, A.patio.bounds.width / 2 + 0.6, A.patio.bounds.depth / 2 + 0.6, 'patio');
      if (A.patio.clubhouse) {
        const ch = A.patio.clubhouse;
        addRect(ch.center.x, ch.center.z, (ch.width || SIZES.clubhouseWidth) / 2 + 1.5, (ch.depth || SIZES.clubhouseDepth) / 2 + 1.5, 'building');
        const wg = ch.wing;
        if (wg && wg.center) addRect(wg.center.x, wg.center.z, wg.width / 2 + 1.5, wg.depth / 2 + 1.5, 'building');
      }
    }
    // Club buildings (fitness centre, pool house) and the pool deck
    for (const id of ['fitnessCenter', 'poolHouse']) {
      const a = A[id];
      if (!a || !a.center) continue;
      const b = a.building || a.bounds;
      addRect(a.center.x, a.center.z, b.width / 2 + 1.5, b.depth / 2 + 1.5, 'building');
    }
    if (A.pool && A.pool.center) addRect(A.pool.center.x, A.pool.center.z, A.pool.bounds.width / 2 + 0.8, A.pool.bounds.depth / 2 + 0.8, 'patio');
    if (A.garden) addRect(A.garden.center.x, A.garden.center.z, A.garden.bounds.width / 2, A.garden.bounds.depth / 2, 'garden');
    if (A.equipmentShed) {
      const s = A.equipmentShed;
      addRect(s.center.x, s.center.z + 0.8, s.bounds.width / 2 + 1.2, s.bounds.depth / 2 + 2.2, 'building');
    }
    if (A.parking) {
      const p = A.parking;
      addRect(p.center.x, p.center.z, p.bounds.width / 2 + 0.4, p.bounds.depth / 2 + 0.4, 'lot');
      const z0 = p.center.z + p.bounds.depth / 2;
      addRect(this.gateX, (z0 + 110) / 2, 4.2, (110 - z0) / 2, 'lot');   // driveway (inside + beyond the gate)
    }
    // The sunken Centre Court (StadiumLayout.blockers): 'stadiumCourt' (its court rect, same size
    // as any grass / hard court's), 'stadium' (cut + 1, for everything), 'stadiumClear'
    // (cut + 8, trees only), 'cameraWell' (trees and lamps), 'building' (masts, scoreboards)
    if (layout) {
      for (const b of layout.blockers) rects.push({ cx: b.cx, cz: b.cz, hx: b.hx, hz: b.hz, tag: b.tag, layout: true });
    }
    this._segs = segs;
    this._rects = rects;
  }

  /**
   * True when (x, z) keeps at least `margin` clear of paths, courts, buildings, patio,
   * garden, shed, parking, the driveway and the Centre Court bowl. opts.ignore: array of rect
   * tags to skip. opts.preBowl: the blockers as they were before the club grew east — every
   * layout rect of the bowl (its court included: there was no Centre Court) and the extension's
   * paths (`ext` segments) are left out.
   */
  isFree(x, z, margin = 0, opts = {}) {
    const ignore = opts.ignore, preBowl = !!opts.preBowl;
    for (const r of this._rects) {
      if (ignore && ignore.includes(r.tag)) continue;
      if (preBowl && r.layout) continue;
      if (Math.abs(x - r.cx) < r.hx + margin && Math.abs(z - r.cz) < r.hz + margin) return false;
    }
    if (opts.paths !== false) {
      for (const s of this._segs) {
        if (preBowl && s.ext) continue;
        if (distToSeg(x, z, s.ax, s.az, s.bx, s.bz) < s.r + margin) return false;
      }
    }
    return true;
  }

  /** Clear of the bowl's masts and scoreboards (its layout 'building' rects) by `margin`. */
  _clearOfBowlProps(x, z, margin) {
    for (const r of this._rects) {
      if (r.layout && r.tag === 'building' && Math.abs(x - r.cx) < r.hx + margin && Math.abs(z - r.cz) < r.hz + margin) return false;
    }
    return true;
  }

  _insideFence(x, z, margin = 0) {
    const b = this.bounds;
    return x > b.x0 + margin && x < b.x1 - margin && z > b.z0 + margin && z < b.z1 - margin;
  }

  /**
   * Visual ground height (flat inside the club; soft hills outside the fence, fading out
   * again toward the plane's edge where the horizon's outer ground takes over).
   */
  groundHeight(x, z) {
    const b = this.bounds, g = this.groundExtents;
    const dx = Math.max(0, (b.x0 - 3) - x, x - (b.x1 + 3));
    const dz = Math.max(0, (b.z0 - 3) - z, z - (b.z1 + 3));
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= 0) return 0;
    let k = smoothstep(0, 24, d);
    // 0 at the origin, 1 on the plane's edge (per side, so the east extension reaches it too)
    const e = Math.max(x < 0 ? x / Math.min(-1, g.x0) : x / Math.max(1, g.x1), z < 0 ? z / Math.min(-1, g.z0) : z / Math.max(1, g.z1));
    k *= 1 - smoothstep(0.84, 0.985, e);
    if (z > b.z1 - 5) k *= smoothstep(6, 16, Math.abs(x - this.gateX));
    if (k <= 0) return 0;
    const n = fbm2(x * 0.028 + 31.7, z * 0.028 + 11.3, this._hillOpts || (this._hillOpts = { octaves: 3, seed: 77 }));
    return k * (0.5 + 5.2 * n * n);
  }

  // ───────────────────────────── ground ─────────────────────────────

  _buildGround() {
    // The plane covers groundExtents on a 2 m vertex grid (fence ± 55 / 45 m: 284 × 200 with
    // the club's eastward extension; the vertices west of it are the old 240 × 200 plane's)
    const ext = this.groundExtents, fb = this.bounds;
    const W = ext.x1 - ext.x0, D = ext.z1 - ext.z0;
    const geo = new THREE.PlaneGeometry(W, D, Math.round(W / 2), Math.round(D / 2));
    geo.rotateX(-Math.PI / 2);
    geo.translate((ext.x0 + ext.x1) / 2, 0, (ext.z0 + ext.z1) / 2);
    setGroundExtents(ext);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    const col = new Float32Array(pos.count * 3);
    const nOpt = { octaves: 3, seed: 5 };
    const meadow = new THREE.Color(0xe6e3b0);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, this.groundHeight(x, z));
      uv.setXY(i, x / 11, z / 11);
      // broad colour variation breaks up texture tiling; meadow tone outside the fence
      const n = fbm2(x * 0.022 + 100, z * 0.022 + 100, nOpt);
      let k = 0.86 + n * 0.22;
      const dx = Math.max(0, fb.x0 - x, x - fb.x1), dz = Math.max(0, fb.z0 - z, z - fb.z1);
      const o = smoothstep(0, 10, Math.sqrt(dx * dx + dz * dz));
      const r = k * (1 + (meadow.r - 1) * o), g = k * (1 + (meadow.g - 1) * o), b = k * (1 + (meadow.b - 1) * o);
      col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();

    // Split into the manicured lawn (mow stripes) and the meadow outside the fence (no stripes).
    // Both share the vertex buffers; only the index differs.
    // The meadow is chunked into quadrants around the origin (160 m cells on the old plane) so
    // chunks behind the camera are culled; the east extension joins the eastern quadrants.
    // Triangles inside the Centre Court cut are dropped: the bowl is a hole in the lawn (its
    // cut edges are on even metres, so the hole follows the grid exactly).
    const cut = this.stadiumLayout ? this.stadiumLayout.cut : null;
    const src = geo.index.array, inner = [], outer = new Map();
    for (let t = 0; t < src.length; t += 3) {
      let cx = 0, cz = 0;
      for (let k = 0; k < 3; k++) { cx += pos.getX(src[t + k]); cz += pos.getZ(src[t + k]); }
      cx /= 3; cz /= 3;
      if (cut && cx > cut.x0 && cx < cut.x1 && cz > cut.z0 && cz < cut.z1) continue;
      const inside = cx > fb.x0 - 1.5 && cx < fb.x1 + 1.5 && cz > fb.z0 - 1.5 && cz < fb.z1 + 1.5;
      if (inside) { inner.push(src[t], src[t + 1], src[t + 2]); continue; }
      const key = `${cx < 0 ? -1 : 0},${cz < 0 ? -1 : 0}`;
      let arr = outer.get(key);
      if (!arr) { arr = []; outer.set(key, arr); }
      arr.push(src[t], src[t + 1], src[t + 2]);
    }
    const mk = (indices, stripes, name) => {
      const g = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv', 'color']) g.setAttribute(k, geo.attributes[k]);
      g.setIndex(indices);
      // Bounds from the indexed vertices only (computeBoundingSphere would use the whole
      // shared position buffer, i.e. the entire ground, and nothing would ever cull)
      const box = new THREE.Box3(), v = new THREE.Vector3();
      for (let i = 0; i < indices.length; i++) box.expandByPoint(v.fromBufferAttribute(pos, indices[i]));
      g.boundingBox = box;
      g.boundingSphere = new THREE.Sphere();
      box.getCenter(g.boundingSphere.center);
      let r2 = 0;
      for (let i = 0; i < indices.length; i++) r2 = Math.max(r2, g.boundingSphere.center.distanceToSquared(v.fromBufferAttribute(pos, indices[i])));
      g.boundingSphere.radius = Math.sqrt(r2);
      const m = new THREE.Mesh(g, mat(0xffffff, {
        map: Textures.grass({ repeat: [1, 1], stripes }), vertexColors: true, roughness: 0.95, wet: 0.45, name,
      }));
      m.receiveShadow = true;
      m.name = name;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.scene.add(m);
      return m;
    };
    this.groundMesh = mk(inner, true, 'Ground');
    this.meadowMeshes = [];
    for (const [key, idx] of outer) {
      const m = mk(idx, false, 'Meadow');
      m.name = `Meadow@${key}`;
      this.meadowMeshes.push(m);
    }

    // Physics ground
    const groundShape = new CANNON.Plane();
    const groundBody = new CANNON.Body({
      mass: 0,
      shape: groundShape,
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    // With a bowl, dynamic bodies inside its cut drop GROUND_TOP from their mask (Stadium)
    groundBody.collisionFilterGroup = this.stadiumLayout ? GROUND_GROUPS.GROUND_TOP : GROUND_GROUPS.WORLD;
    this.physicsWorld.addBody(groundBody);
    this.groundBody = groundBody;
  }

  // ───────────────────────────── physics / ground queries ─────────────────────────────

  /**
   * The only place the physics world is stepped (main loop and after-hours tennis): the
   * stadium refreshes collision masks before the step and rescues bodies after it.
   */
  stepPhysics(dt) {
    if (this.stadium) this.stadium.preStep();
    this.physicsWorld.step(1 / 60, dt, 3);
    if (this.stadium) this.stadium.postFrame();
  }

  /** Walk-surface y at (x, z) (Ground.groundAt: 0 everywhere outside the bowl). */
  groundAt(x, z) {
    return groundAt(x, z);
  }

  // ───────────────────────────── paths ─────────────────────────────

  _pathMaterials() {
    return {
      top: mat(COLORS.cartPathTint, { map: Textures.concrete({ joints: false, repeat: [1, 1] }), roughness: 0.9, wet: 0.8, name: 'cartPath' }),
      edge: mat(COLORS.pathEdging, { map: Textures.pavers({ repeat: [1, 1] }), roughness: 0.9, wet: 0.6, name: 'pathEdging' }),
    };
  }

  _buildPaths() {
    const top = new FlatBuilder(), edge = new FlatBuilder();
    for (const path of this.mapData.paths) {
      const points = path.points;
      const width = path.width || 3;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        top.ribbon(a.x, a.z, b.x, b.z, width);
        edge.ribbon(a.x, a.z, b.x, b.z, width + EDGE_EXTRA);
      }
      // Round joints (also caps the ends)
      for (const p of points) {
        top.disc(p.x, p.z, width / 2, 24);
        edge.disc(p.x, p.z, width / 2 + EDGE_EXTRA / 2, 24);
      }
    }
    this._fillPathNotches(top, edge);
    const m = this._pathMaterials();
    const pathMesh = staticMesh(top.toGeometry(LAYER.path, PATH_TILE), m.top, false, true);
    pathMesh.name = 'CartPaths';
    const edgeMesh = staticMesh(edge.toGeometry(LAYER.edge, 1.6), m.edge, false, true);
    edgeMesh.name = 'PathEdging';
    this.staticRoot.add(pathMesh, edgeMesh);
  }

  /**
   * Round joints leave a small concave notch between the round outer corner (or round end cap)
   * of one path and a neighbouring path that runs alongside it (e.g. the court loop and the
   * perimeter path touch edge-to-edge at the NE/SE corners). Wherever the square (mitered)
   * corner of a joint would lie on another path's pavement, fill that corner square so the
   * union has no wedge-shaped hole. Corners out in the open keep their rounded look.
   */
  _fillPathNotches(top, edge) {
    const paths = this.mapData.paths;
    const TOL = 0.35;
    // Is (x, z) on (or within TOL of) the pavement of any path other than `self`?
    const onOtherPath = (x, z, self) => {
      for (const q of paths) {
        if (q === self) continue;
        const r = (q.width || 3) / 2 + TOL;
        const pts = q.points;
        if (pts.length === 1 && Math.hypot(x - pts[0].x, z - pts[0].z) < r) return true;
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSeg(x, z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z) < r) return true;
        }
      }
      return false;
    };
    // Adds the square between p, p+a·h, p+a·h+b·h, p+b·h (a, b unit vectors) to both layers.
    const fill = (px, pz, ax, az, bx, bz, h) => {
      const he = h + EDGE_EXTRA / 2;
      top.quad([px, pz], [px + ax * h, pz + az * h], [px + (ax + bx) * h, pz + (az + bz) * h], [px + bx * h, pz + bz * h]);
      edge.quad([px, pz], [px + ax * he, pz + az * he], [px + (ax + bx) * he, pz + (az + bz) * he], [px + bx * he, pz + bz * he]);
    };
    const dir = (a, b) => {
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      return L < 1e-6 ? null : [dx / L, dz / L];
    };
    let filled = 0;
    for (const path of paths) {
      const pts = path.points;
      const h = (path.width || 3) / 2;
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const dIn = i > 0 ? dir(pts[i - 1], p) : null;
        const dOut = i < n - 1 ? dir(p, pts[i + 1]) : null;
        if (dIn && dOut) {
          // Interior joint: only the outer side has a round-vs-square gap
          const cross = dIn[0] * dOut[1] - dIn[1] * dOut[0];
          if (Math.abs(cross) < 1e-3) continue;              // straight through
          const s = cross > 0 ? -1 : 1;                        // outer side normal sign
          const n1 = [-dIn[1] * s, dIn[0] * s], n2 = [-dOut[1] * s, dOut[0] * s];
          // mitered corner point (clamped for very sharp turns)
          const mx = n1[0] + n2[0], mz = n1[1] + n2[1];
          const ml = Math.hypot(mx, mz) || 1;
          const k = Math.min(2.5, 2 / ml) * h;                  // miter length = h / cos(θ/2)
          const cx = p.x + (mx / ml) * k, cz = p.z + (mz / ml) * k;
          if (!onOtherPath(cx, cz, path)) continue;
          const he = h + EDGE_EXTRA / 2, ke = k * he / h;
          top.quad([p.x, p.z], [p.x + n1[0] * h, p.z + n1[1] * h], [cx, cz], [p.x + n2[0] * h, p.z + n2[1] * h]);
          edge.quad([p.x, p.z], [p.x + n1[0] * he, p.z + n1[1] * he], [p.x + (mx / ml) * ke, p.z + (mz / ml) * ke], [p.x + n2[0] * he, p.z + n2[1] * he]);
          filled++;
        } else {
          // End cap: square off each half whose corner lands on another path
          const d = dOut ? [-dOut[0], -dOut[1]] : dIn;          // pointing out of the path end
          if (!d) continue;
          for (const s of [-1, 1]) {
            const nx = -d[1] * s, nz = d[0] * s;
            const cx = p.x + (d[0] + nx) * h, cz = p.z + (d[1] + nz) * h;
            if (!onOtherPath(cx, cz, path)) continue;
            fill(p.x, p.z, d[0], d[1], nx, nz, h);
            filled++;
          }
        }
      }
    }
    this.pathNotchFills = filled;
  }

  // ───────────────────────────── courts & buildings (other modules) ─────────────────────────────

  _buildCourts() {
    const configs = this.mapData.areas.courts;
    for (const courtConfig of configs) {
      // neighbouring surrounds merge only between courts of the same surface
      const court = new Court(this.scene, this.physicsWorld, courtConfig, { sharedPad: sharedPadSides(courtConfig, configs) });
      this.courts.push(court);
    }
    this._mergeCourtSlabs();
  }

  /**
   * Replace the slab bodies of side-by-side courts (clay 3-5, courts 1-2) with one
   * body per contiguous run, so walking across a seam never touches two
   * coplanar boxes (double contacts = double friction). Only courts at the same base height
   * merge (a sunken court has no slab body at all).
   */
  _mergeCourtSlabs() {
    const eps = 0.05;
    const baseOf = (c) => c.baseY || 0;
    const list = this.courts.filter(c => c.slabBody && c.slabBounds)
      .sort((a, b) => a.slabBounds.x0 - b.slabBounds.x0);
    const used = new Set();
    for (const first of list) {
      if (used.has(first)) continue;
      const run = [first];
      used.add(first);
      let cur = first.slabBounds;
      for (const c of list) {
        if (used.has(c)) continue;
        const b = c.slabBounds;
        if (Math.abs(b.x0 - cur.x1) < eps && Math.abs(b.z0 - cur.z0) < eps && Math.abs(b.z1 - cur.z1) < eps && baseOf(c) === baseOf(first)) {
          run.push(c); used.add(c); cur = b;
        }
      }
      if (run.length < 2) continue;
      const x0 = run[0].slabBounds.x0, x1 = run[run.length - 1].slabBounds.x1;
      const { z0, z1 } = run[0].slabBounds;
      for (const c of run) { this.physicsWorld.removeBody(c.slabBody); }
      const body = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3((x0 + x1) / 2, baseOf(first) + 0.05, (z0 + z1) / 2),
        shape: new CANNON.Box(new CANNON.Vec3((x1 - x0) / 2, 0.1, (z1 - z0) / 2)),
      });
      this.physicsWorld.addBody(body);
      for (const c of run) c.slabBody = body;
    }
  }

  _buildProShop() {
    const config = this.mapData.areas.proShop;
    const proShop = new Building(this.scene, this.physicsWorld, 'proShop', config);
    this.buildings.push(proShop);
  }

  _buildClubhouse() {
    const patioConfig = this.mapData.areas.patio;
    if (patioConfig && patioConfig.clubhouse) {
      const clubhouse = new Clubhouse(this.scene, this.physicsWorld, patioConfig.clubhouse);
      this.buildings.push(clubhouse);
    }
  }

  /** Fitness & wellness centre and the pool house + pool (map.json areas.fitnessCenter / poolHouse / pool). */
  _buildClubBuildings() {
    const A = this.mapData.areas;
    const ok = (a) => a && a.center && Number.isFinite(a.center.x) && Number.isFinite(a.center.z) && (a.building || a.bounds);
    if (ok(A.fitnessCenter)) this.buildings.push(new FitnessCenter(this.scene, this.physicsWorld, A.fitnessCenter));
    if (ok(A.poolHouse)) this.buildings.push(new PoolHouse(this.scene, this.physicsWorld, A.poolHouse, ok(A.pool) ? A.pool : null));
  }

  /** The building whose rooms contain (x, z), or null. */
  buildingAt(x, z) {
    for (const b of this.buildings) if (b.isInside(x, z)) return b;
    return null;
  }

  _buildGarden() {
    const gardenConfig = this.mapData.areas.garden;
    if (!gardenConfig) return;
    this.garden = new Garden(this.scene, this.physicsWorld, gardenConfig, {
      scenery: this.scenery,
      isFree: (x, z, m, o) => this.isFree(x, z, m, o),
    });
  }

  // ───────────────────────────── court junction props ─────────────────────────────

  _buildCourtJunctions() {
    const junctions = this.mapData.areas.courtJunctions;
    if (!junctions) return;

    for (const junction of junctions) {
      const pos = junction.position;
      const junctionData = { id: junction.id, position: pos, meshes: {} };

      // Offset along z so the props sit beside (not inside) the net line, on the court surface
      if (junction.hasCooler) {
        junctionData.meshes.cooler = this._addIglooCooler(pos.x - 0.8, pos.z - 0.75);
      }
      if (junction.hasTrashBin) {
        junctionData.meshes.trashBin = this._addTrashBin(pos.x + 0.8, pos.z + 0.75);
      }

      this.courtJunctionObjects.push(junctionData);
    }
  }

  /** Height of the highest court surface under (x, z) (ignores nets, fences, posts above 0.6 m). */
  _surfaceY(x, z) {
    if (!this._ray) this._ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 3);
    this._ray.ray.origin.set(x, 0.6, z);
    let best = 0;
    for (const c of this.courts) {
      if (!c.mesh) continue;
      c.mesh.updateMatrixWorld(true);
      for (const hit of this._ray.intersectObject(c.mesh, true)) {
        if (hit.point.y > best && hit.point.y < 0.6 && hit.object.visible) best = hit.point.y;
      }
    }
    return best;
  }

  _addIglooCooler(x, z) {
    const geo = getGeometry('world-iglooCooler', () => {
      const O = COLORS.coolerOrange, W = COLORS.coolerWhite, S = COLORS.clubGreen, I = COLORS.ironWork;
      const parts = [
        // folding stand
        P(roundedBox(0.66, 0.05, 0.52, 0.02), makeMatrix(0, 0.5, 0), S),
        P(boxGeo(0.62, 0.04, 0.04), makeMatrix(0, 0.2, 0.2), I),
        P(boxGeo(0.62, 0.04, 0.04), makeMatrix(0, 0.2, -0.2), I),
      ];
      for (const sx of [-0.28, 0.28]) for (const sz of [-0.22, 0.22]) parts.push(P(boxGeo(0.04, 0.5, 0.04), makeMatrix(sx, 0.25, sz), I));
      // cooler body + white bands + lid
      parts.push(
        P(cylinderGeo(0.265, 0.25, 0.5, 20), makeMatrix(0, 0.78, 0), O),
        P(cylinderGeo(0.258, 0.258, 0.05, 20), makeMatrix(0, 0.55, 0), W),
        P(cylinderGeo(0.275, 0.268, 0.07, 20), makeMatrix(0, 1.04, 0), W),
        P(cylinderGeo(0.2, 0.26, 0.07, 20), makeMatrix(0, 1.11, 0), W),
        P(cylinderGeo(0.07, 0.08, 0.05, 12), makeMatrix(0, 1.165, 0), W),
        // side handles
        P(roundedBox(0.05, 0.05, 0.16, 0.02), makeMatrix(0.29, 0.98, 0), W),
        P(roundedBox(0.05, 0.05, 0.16, 0.02), makeMatrix(-0.29, 0.98, 0), W),
        // spigot
        P(roundedBox(0.08, 0.08, 0.07, 0.02), makeMatrix(0, 0.62, 0.27), W),
        P(cylinderGeo(0.018, 0.018, 0.06, 6), makeMatrix(0, 0.59, 0.32), W),
        // cup dispenser tube + cups
        P(cylinderGeo(0.05, 0.05, 0.44, 10), makeMatrix(0.36, 0.84, 0), W),
        P(cylinderGeo(0.052, 0.04, 0.06, 10), makeMatrix(0.36, 0.6, 0), 0xf5f1e3),
      );
      return mergeParts(parts);
    });
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geo, propMat());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const y = this._surfaceY(x, z);
    group.position.set(x, y, z);
    group.rotation.y = Math.PI;       // spigot faces the net
    this.scene.add(group);
    this.scenery.addBlob(x, y, z, 0.55);
    return group;
  }

  _addTrashBin(x, z) {
    const geo = getGeometry('world-trashBin', () => {
      const G = COLORS.binGreen, C = COLORS.clubCream, I = COLORS.ironWork;
      const parts = [
        P(cylinderGeo(0.26, 0.23, 0.7, 16), makeMatrix(0, 0.37, 0), G),
        P(cylinderGeo(0.24, 0.24, 0.04, 16), makeMatrix(0, 0.03, 0), I),
        P(cylinderGeo(0.275, 0.275, 0.06, 16), makeMatrix(0, 0.71, 0), C),
        P(cylinderGeo(0.25, 0.25, 0.04, 16), makeMatrix(0, 0.745, 0), 0xf4f4f0), // liner
        P(cylinderGeo(0.16, 0.27, 0.12, 16), makeMatrix(0, 0.82, 0), G),        // lid dome
        P(cylinderGeo(0.1, 0.16, 0.05, 16), makeMatrix(0, 0.9, 0), G),
        P(cylinderGeo(0.03, 0.03, 0.04, 8), makeMatrix(0, 0.94, 0), C),
      ];
      for (let i = 0; i < 8; i++) {                 // vertical slat ribs
        const a = (i / 8) * Math.PI * 2;
        parts.push(P(boxGeo(0.035, 0.6, 0.03), makeMatrix(Math.cos(a) * 0.255, 0.37, Math.sin(a) * 0.255, -a), 0x264a33));
      }
      return mergeParts(parts);
    });
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geo, propMat());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const y = this._surfaceY(x, z);
    group.position.set(x, y, z);
    this.scene.add(group);
    this.scenery.addBlob(x, y, z, 0.45);
    return group;
  }

  // ───────────────────────────── equipment shed ─────────────────────────────

  _buildEquipmentShed() {
    const shed = this.mapData.areas.equipmentShed;
    if (!shed) return;

    const { center, bounds } = shed;
    const w = bounds.width;
    const d = bounds.depth;
    const h = 2.5;
    const cx = center.x, cz = center.z;
    const back = cz - d / 2, front = cz + d / 2;
    const rise = 1.15;

    // Slab + apron (concrete, world UV)
    // Low (0.08) so carts roll straight in from the apron without a physics step
    const slabGeo = mergeParts([P(roundedBox(w + 0.5, 0.08, d + 1.7, 0.03), makeMatrix(cx, 0.04, cz + 0.6))]);
    worldBoxUV(slabGeo, PATH_TILE);
    this.staticRoot.add(staticMesh(slabGeo, this._pathMaterials().top, false, true));

    // Board & batten walls + gables + open doors (vertical planks)
    const woodParts = [
      P(boxGeo(w + 0.15, h, 0.15), makeMatrix(cx, h / 2, back)),
      P(boxGeo(0.15, h, d), makeMatrix(cx - w / 2, h / 2, cz)),
      P(boxGeo(0.15, h, d), makeMatrix(cx + w / 2, h / 2, cz)),
    ];
    const gable = getGeometry(`world-shedGable|${w}|${rise}`, () => {
      const s = new THREE.Shape();
      s.moveTo(-w / 2 - 0.08, 0); s.lineTo(w / 2 + 0.08, 0); s.lineTo(0, rise); s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth: 0.15, bevelEnabled: false });
      g.translate(0, 0, -0.075);
      return g;
    });
    woodParts.push(P(gable, makeMatrix(cx, h, back)), P(gable, makeMatrix(cx, h, front)));
    // Door leaves hinged at the front corners, swung all the way back against the side
    // walls so the drive-in bay and its apron are completely clear
    const leafW = w / 2 - 0.05, leafH = h - 0.25;
    const DOOR_SWING = Math.PI - 0.07;
    for (const side of [-1, 1]) {
      const dirX = side * Math.sin(DOOR_SWING), dirZ = Math.cos(DOOR_SWING);
      const ry = Math.atan2(-dirZ, dirX);
      const hx = cx + side * (w / 2 + 0.09), hz = front + 0.05;
      woodParts.push(P(boxGeo(leafW, leafH, 0.07), makeMatrix(hx + dirX * leafW / 2, leafH / 2 + 0.12, hz + dirZ * leafW / 2, ry)));
    }
    const woodGeo = mergeParts(woodParts);
    worldBoxUV(woodGeo, 1.3, { vertical: true });
    const woodMat = mat(0xffffff, { map: Textures.wood({ tone: COLORS.shedWood, repeat: [1, 1] }), roughness: 0.82, wet: 0.4, name: 'shedWood' });
    this.staticRoot.add(staticMesh(woodGeo, woodMat));

    // Gable roof (shingles)
    const run = w / 2 + 0.45, slope = Math.atan2(rise, w / 2), L = run / Math.cos(slope) + 0.05;
    const roofParts = [];
    for (const side of [-1, 1]) {
      const mx = cx + side * (L / 2) * Math.cos(slope);
      const my = h + rise - (L / 2) * Math.sin(slope) + 0.1;
      roofParts.push(P(roundedBox(L, 0.1, d + 0.9, 0.03), makeMatrix(mx, my, cz, 0, 1, 0, -side * slope)));
    }
    const roofGeo = mergeParts(roofParts);
    worldBoxUV(roofGeo, 2, { swapTop: true });
    this.staticRoot.add(staticMesh(roofGeo, mat(COLORS.shedRoof, { map: Textures.shingles({ repeat: [1, 1] }), roughness: 0.8, wet: 0.8, name: 'shedRoof' })));

    // Trim, sign frame, windows, interior props (vertex colours → merges with other props)
    const C = COLORS.clubCream, G = 0x2b2f2c;
    const trim = [
      P(roundedBox(0.2, 0.14, d + 0.95, 0.04), makeMatrix(cx, h + rise + 0.14, cz), 0x3c4a45),     // ridge cap
      P(boxGeo(w + 0.3, 0.26, 0.2), makeMatrix(cx, h - 0.1, front), C),                          // header
    ];
    for (const sx of [-1, 1]) {
      for (const z of [back, front]) trim.push(P(boxGeo(0.2, h, 0.2), makeMatrix(cx + sx * (w / 2 + 0.02), h / 2, z), C));
      // side window (behind the folded-back door leaf)
      const winZ = back + 0.72;
      trim.push(P(boxGeo(0.06, 0.8, 0.9), makeMatrix(cx + sx * (w / 2 + 0.08), 1.6, winZ), C));
      trim.push(P(boxGeo(0.07, 0.62, 0.72), makeMatrix(cx + sx * (w / 2 + 0.09), 1.6, winZ), 0x2c3a40));
      trim.push(P(boxGeo(0.08, 0.05, 0.72), makeMatrix(cx + sx * (w / 2 + 0.1), 1.6, winZ), C));
      // door Z-braces (both faces)
      const dirX = sx * Math.sin(DOOR_SWING), dirZ = Math.cos(DOOR_SWING);
      const ry = Math.atan2(-dirZ, dirX);
      const hx = cx + sx * (w / 2 + 0.09), hz = front + 0.05;
      const mid = (t, y, off) => [hx + dirX * leafW * t + Math.sin(ry) * off, y, hz + dirZ * leafW * t + Math.cos(ry) * off];
      for (const off of [-0.05, 0.05]) {
        for (const y of [0.45, leafH - 0.2]) {
          const [x1, y1, z1] = mid(0.5, y, off);
          trim.push(P(boxGeo(leafW - 0.1, 0.14, 0.03), makeMatrix(x1, y1, z1, ry), C));
        }
        const [x2, y2, z2] = mid(0.5, leafH / 2 + 0.12, off);
        const diag = Math.atan2(leafH - 0.65, leafW - 0.2);
        const m = new THREE.Matrix4().makeTranslation(x2, y2, z2)
          .multiply(new THREE.Matrix4().makeRotationY(ry))
          .multiply(new THREE.Matrix4().makeRotationZ(sx * diag));
        trim.push(P(boxGeo(Math.hypot(leafH - 0.65, leafW - 0.2), 0.12, 0.03), m, C));
      }
    }
    // Shelving on the back wall
    for (const y of [0.9, 1.6]) trim.push(P(boxGeo(w - 0.6, 0.05, 0.45), makeMatrix(cx, y, back + 0.33), 0x8a6a48));
    for (const sx of [-1, 1]) trim.push(P(boxGeo(0.06, 1.75, 0.45), makeMatrix(cx + sx * (w / 2 - 0.35), 0.875, back + 0.33), 0x6f5438));
    const shelfItems = [
      [-1.5, 0.93, 0.18, 0.28, 0xf28c28], [-1.1, 0.93, 0.16, 0.26, 0xf4f1e8], [-0.7, 0.93, 0.16, 0.26, 0xf28c28],
      [0.9, 1.63, 0.14, 0.2, 0x3b6ea8], [1.25, 1.63, 0.14, 0.2, 0xe8e3d4],
    ];
    for (const [ox, y, r, hh, c] of shelfItems) trim.push(P(cylinderGeo(r, r * 0.85, hh, 12), makeMatrix(cx + ox, y + hh / 2, back + 0.33), c));
    for (let i = 0; i < 4; i++) trim.push(P(roundedBox(0.5, 0.16, 0.34, 0.06), makeMatrix(cx + 0.3 + (i % 2) * 0.52, 0.2 + Math.floor(i / 2) * 0.17, back + 0.4, (i * 0.3) % 0.2), 0xcaa47a)); // clay bags
    // line tape rolls
    for (let i = 0; i < 3; i++) trim.push(P(cylinderGeo(0.14, 0.14, 0.06, 14), makeMatrix(cx - 0.4 + i * 0.3, 1.66, back + 0.3, 0, 1, Math.PI / 2), 0xf6f4ee));
    // rakes & broom leaning on the right wall
    for (let i = 0; i < 3; i++) {
      const rz = cz - 1.0 + i * 0.55;
      trim.push(P(cylinderGeo(0.018, 0.018, 1.7, 6), makeMatrix(cx + w / 2 - 0.3, 0.85, rz, 0, 1, 0, 0.12), 0xc8a26b));
      trim.push(P(boxGeo(0.06, 0.08, 0.42), makeMatrix(cx + w / 2 - 0.2, 1.68, rz), i === 1 ? 0x7a5a3a : 0x777d80));
    }
    // Drag brush on the floor (what the cart hooks up to)
    const bx = cx - 0.3, bz = cz - 0.2;
    trim.push(P(boxGeo(1.8, 0.06, 0.06), makeMatrix(bx, 0.24, bz), 0xb8bdc2));
    trim.push(P(roundedBox(1.8, 0.14, 0.34, 0.04), makeMatrix(bx, 0.14, bz + 0.05), COLORS.dragBrushBristles));
    for (const sx of [-1, 1]) trim.push(P(cylinderGeo(0.02, 0.02, 1.15, 6), makeMatrix(bx + sx * 0.45, 0.26, bz + 0.55, 0, 1, Math.PI / 2, sx * 0.66), 0xb8bdc2));
    trim.push(P(cylinderGeo(0.04, 0.04, 0.12, 8), makeMatrix(bx, 0.26, bz + 1.02, 0, 1, Math.PI / 2), 0x555a5e));
    this.staticRoot.add(staticMesh(mergeParts(trim), propMat()));

    // Sign on the front gable
    const signTex = signTexture('world-shedSign', [
      { text: 'EQUIPMENT SHED', size: 0.4, y: 0.52 },
    ], { w: 512, h: 128 });
    const signMat = mat(0xffffff, { map: signTex, roughness: 0.6, name: 'shedSign' });
    const sign = new THREE.Mesh(getGeometry('world-shedSignPlane', () => new THREE.PlaneGeometry(2.3, 0.58)), signMat);
    sign.position.set(cx, h + 0.42, front + 0.1);
    this.staticRoot.add(sign);
    this.staticRoot.add(staticMesh(mergeParts([P(roundedBox(2.45, 0.7, 0.05, 0.02), makeMatrix(cx, h + 0.42, front + 0.07), C)]), propMat()));

    // Physics blockers for walls
    const backShape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, 0.1));
    const backBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(center.x, h / 2, center.z - d / 2),
      shape: backShape,
    });
    this.physicsWorld.addBody(backBody);

    for (const side of [-1, 1]) {
      const sideShape = new CANNON.Box(new CANNON.Vec3(0.1, h / 2, d / 2));
      const sideBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(center.x + side * w / 2, h / 2, center.z),
        shape: sideShape,
      });
      this.physicsWorld.addBody(sideBody);
    }

    // Planters behind the shed
    for (const sx of [-1, 1]) this.scenery.addFlowerClump(cx + sx * (w / 2 + 0.55), 0, back - 0.55, sx < 0 ? 0xf2c14e : 0xe8e1f0, 1.1);

    // "Brush hitch" parking bay painted on the apron (shed_apron path in map.json): an
    // outlined box with chevrons pointing into the open bay. Attach/Detach triggers anywhere
    // on the apron or inside the shed (CourtMaintenanceSystem.isNearEquipmentShed).
    const paint = new FlatBuilder();
    const bayW = 3.2, bz0 = front + 0.55, bz1 = front + 4.1, lw = 0.07;
    paint.rect(cx - bayW / 2, (bz0 + bz1) / 2, lw, (bz1 - bz0) / 2);
    paint.rect(cx + bayW / 2, (bz0 + bz1) / 2, lw, (bz1 - bz0) / 2);
    paint.rect(cx, bz1, bayW / 2 + lw, lw);
    for (const oz of [1.2, 2.3]) {          // chevrons (tip toward the shed)
      const tz = bz0 + oz;
      for (const sx of [-1, 1]) {
        const ang = -sx * 0.62;
        paint.rect(cx + sx * 0.36, tz + 0.26, 0.44, 0.075, ang);
      }
    }
    this.staticRoot.add(staticMesh(paint.toGeometry(LAYER.paint, 4), mat(0xf0ece2, { roughness: 0.55, polygonOffset: -1, name: 'paint' }), false, true));
  }

  // ───────────────────────────── patio ─────────────────────────────

  _buildPatio() {
    const patio = this.mapData.areas.patio;
    if (!patio) return;
    const ch = patio.clubhouse;
    const clubFront = ch ? ch.center.z + (ch.depth || SIZES.clubhouseDepth) / 2 : patio.center.z - patio.bounds.depth / 2;
    const x0 = patio.center.x - patio.bounds.width / 2, x1 = patio.center.x + patio.bounds.width / 2;
    const zMin = Math.max(patio.center.z - patio.bounds.depth / 2, clubFront - 0.3);
    const zMax = patio.center.z + patio.bounds.depth / 2;
    const slabH = 0.1;
    this.patioTop = slabH;
    // Physics slab matching the paver top, so characters stand on it rather than in it
    this.physicsWorld.addBody(new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3((x0 + x1) / 2, slabH - 0.1, (zMin + zMax) / 2),
      shape: new CANNON.Box(new CANNON.Vec3((x1 - x0) / 2, 0.1, (zMax - zMin) / 2)),
    }));

    // Paver slab with a darker soldier-course border
    const slab = mergeParts([P(roundedBox(x1 - x0, slabH, zMax - zMin, 0.03), makeMatrix((x0 + x1) / 2, slabH / 2, (zMin + zMax) / 2))]);
    worldBoxUV(slab, 2.4);
    this.staticRoot.add(staticMesh(slab, mat(0xffffff, { map: Textures.pavers({ repeat: [1, 1] }), roughness: 0.85, wet: 0.7, name: 'patioPavers' }), false, true));
    const border = mergeParts([
      P(roundedBox(x1 - x0 + 0.5, slabH - 0.02, 0.28, 0.02), makeMatrix((x0 + x1) / 2, (slabH - 0.02) / 2, zMax + 0.12)),
      P(roundedBox(0.28, slabH - 0.02, zMax - zMin + 0.2, 0.02), makeMatrix(x0 - 0.12, (slabH - 0.02) / 2, (zMin + zMax) / 2)),
      P(roundedBox(0.28, slabH - 0.02, zMax - zMin + 0.2, 0.02), makeMatrix(x1 + 0.12, (slabH - 0.02) / 2, (zMin + zMax) / 2)),
    ]);
    worldBoxUV(border, 1.6);
    this.staticRoot.add(staticMesh(border, mat(COLORS.pathEdging, { map: Textures.pavers({ repeat: [1, 1] }), roughness: 0.9, wet: 0.6, name: 'pathEdging' }), false, true));

    const props = [];
    const umbrellaFinials = [];
    const tableGeo = this._tableSetGeometry();
    const canopyGeo = this._umbrellaGeometry();
    for (const seat of patio.seating || []) {
      if (seat.type === 'table') {
        const tz = Math.max(seat.z, clubFront + 1.35);
        props.push(P(tableGeo, makeMatrix(seat.x, slabH, tz, (hash2(seat.x | 0, 3, 1) - 0.5) * 0.3)));
        props.push(P(canopyGeo, makeMatrix(seat.x, slabH, tz)));
        umbrellaFinials.push([seat.x, slabH + 2.72, tz]);
        this.scenery.addBlob(seat.x, slabH, tz, 1.3);
      } else if (seat.type === 'bench') {
        this.scenery.addBench(seat.x, slabH, Math.min(seat.z, zMax - 0.5), 0);
      }
    }

    // Planters (terracotta pots with flowers)
    const potGeo = getGeometry('world-pot', () => mergeParts([
      P(cylinderGeo(0.42, 0.3, 0.62, 14), makeMatrix(0, 0.31, 0), 0xb8643e),
      P(cylinderGeo(0.47, 0.47, 0.09, 14), makeMatrix(0, 0.6, 0), 0xc9774f),
      P(cylinderGeo(0.4, 0.4, 0.04, 14), makeMatrix(0, 0.62, 0), COLORS.soil),
    ]));
    const pots = [[patio.center.x - 1.9, zMax - 0.45], [patio.center.x + 1.9, zMax - 0.45], [x0 + 0.5, clubFront + 1.0], [x1 - 0.5, clubFront + 1.0]];
    pots.forEach(([px, pz], i) => {
      props.push(P(potGeo, makeMatrix(px, slabH, pz)));
      const col = COLORS.flowers[i % COLORS.flowers.length];
      this.scenery.addFlowerClump(px, slabH + 0.6, pz, col, 1.25);
      this.scenery.addFlowerClump(px + 0.18, slabH + 0.58, pz + 0.12, 0xf4efe6, 0.8);
      this.scenery.addBlob(px, slabH, pz, 0.6);
    });

    // String lights: festoons zig-zag between front posts and umbrella finials
    const postXs = [x0 + 0.15, patio.center.x - 3, patio.center.x + 3, x1 - 0.15];
    const postTop = 3.05;
    const posts = postXs.map((px) => [px, slabH + postTop, zMax - 0.12]);
    for (const [px, , pz] of posts) {
      props.push(P(cylinderGeo(0.055, 0.07, postTop, 8), makeMatrix(px, slabH + postTop / 2, pz), COLORS.ironWork));
      props.push(P(sphereGeo(0.08, 8, 6), makeMatrix(px, slabH + postTop + 0.05, pz), COLORS.ironWork));
    }
    const chain = [];
    for (let i = 0; i < posts.length; i++) {
      chain.push(posts[i]);
      if (umbrellaFinials[i]) chain.push(umbrellaFinials[i]);
    }
    const wirePts = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i], b = chain[i + 1];
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const sag = 0.18 + len * 0.05;
      const steps = Math.max(6, Math.round(len / 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const p = new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t);
        if (s > 0 || i === 0) wirePts.push(p);
        if (s > 0 && s < steps) this.scenery.addBulb(p.x, p.y - 0.07, p.z);
      }
    }
    if (wirePts.length > 2) {
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wirePts), wirePts.length * 2, 0.012, 4, false);
      props.push(P(tube, null, 0x1a1d1b));
    }
    this.staticRoot.add(staticMesh(bakeParts(props), propMat()));
  }

  /** Round café table + 4 teak chairs (local origin on the slab). */
  _tableSetGeometry() {
    return getGeometry('world-tableSet', () => {
      const I = COLORS.ironWork, T = COLORS.teak;
      const parts = [
        P(cylinderGeo(0.62, 0.62, 0.05, 24), makeMatrix(0, 0.75, 0), 0xefe8d8),
        P(cylinderGeo(0.64, 0.6, 0.03, 24), makeMatrix(0, 0.715, 0), 0xd9d0bc),
        P(cylinderGeo(0.04, 0.05, 0.7, 8), makeMatrix(0, 0.37, 0), I),
        P(cylinderGeo(0.26, 0.32, 0.05, 16), makeMatrix(0, 0.025, 0), I),
        P(cylinderGeo(0.022, 0.022, 2.7, 6), makeMatrix(0, 1.35, 0), 0xe8e2d2), // umbrella pole
      ];
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + k * Math.PI / 2;
        const r = 0.95, x = Math.cos(a) * r, z = Math.sin(a) * r;
        const ry = Math.atan2(x, z) + Math.PI; // chair faces the table
        const f = (lx, ly, lz) => {
          const c = Math.cos(ry), s = Math.sin(ry);
          return [x + lx * c + lz * s, ly, z - lx * s + lz * c];
        };
        const seat = f(0, 0.46, 0);
        parts.push(P(roundedBox(0.46, 0.05, 0.46, 0.02), makeMatrix(seat[0], seat[1], seat[2], ry), T));
        const bk = f(0, 0.74, -0.21);
        parts.push(P(roundedBox(0.46, 0.4, 0.04, 0.02), makeMatrix(bk[0], bk[1], bk[2], ry), T));
        for (const lx of [-0.19, 0.19]) for (const lz of [-0.19, 0.19]) {
          const lp = f(lx, 0.22, lz);
          parts.push(P(boxGeo(0.035, 0.44, 0.035), makeMatrix(lp[0], lp[1], lp[2], ry), I));
        }
      }
      const g = mergeParts(parts);
      g.deleteAttribute('uv');
      return g;
    });
  }

  /** Striped market umbrella canopy (club green & cream), both sides, with valance. */
  _umbrellaGeometry() {
    return getGeometry('world-umbrella', () => {
      const seg = 16, R = 1.35, H = 0.46, y0 = 2.3;
      const [c0, c1] = COLORS.umbrellaStripe.map(c => new THREE.Color(c));
      const pos = [], col = [];
      const push = (x, y, z, c, k = 1) => { pos.push(x, y, z); col.push(c.r * k, c.g * k, c.b * k); };
      for (let s = 0; s < seg; s++) {
        const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
        const c = s % 2 ? c1 : c0;
        const ax = Math.cos(a0) * R, az = Math.sin(a0) * R, bx = Math.cos(a1) * R, bz = Math.sin(a1) * R;
        // top (outward, counter-clockwise from above)
        push(0, y0 + H, 0, c); push(bx, y0, bz, c); push(ax, y0, az, c);
        // underside
        push(0, y0 + H - 0.02, 0, c, 0.7); push(ax, y0 - 0.02, az, c, 0.7); push(bx, y0 - 0.02, bz, c, 0.7);
        // valance flap (outer + inner)
        const vy = y0 - 0.14;
        push(ax, y0, az, c, 0.95); push(bx, y0, bz, c, 0.95); push(bx, vy, bz, c, 0.95);
        push(ax, y0, az, c, 0.95); push(bx, vy, bz, c, 0.95); push(ax, vy, az, c, 0.95);
        push(ax, y0, az, c, 0.7); push(bx, vy, bz, c, 0.7); push(bx, y0, bz, c, 0.7);
        push(ax, y0, az, c, 0.7); push(ax, vy, az, c, 0.7); push(bx, vy, bz, c, 0.7);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.computeVertexNormals();
      const fin = sphereGeo(0.05, 8, 6).clone();
      fin.deleteAttribute('uv');
      fin.translate(0, y0 + H + 0.04, 0);
      const fc = new Float32Array(fin.attributes.position.count * 3).fill(0.85);
      fin.setAttribute('color', new THREE.BufferAttribute(fc, 3));
      g.setIndex(null);
      return bakeParts([{ geometry: g }, { geometry: fin }]);
    });
  }

  // ───────────────────────────── parking ─────────────────────────────

  _buildParking() {
    const parking = this.mapData.areas.parking;
    if (!parking) return;
    const { center, bounds } = parking;
    const lx0 = center.x - bounds.width / 2, lx1 = center.x + bounds.width / 2;
    const lz0 = center.z - bounds.depth / 2, lz1 = center.z + bounds.depth / 2;
    const driveW = 7;
    const driveEnd = 112;

    // Asphalt lot + driveway through the gate (one geometry), with edging underneath
    const lot = new FlatBuilder(), lotEdge = new FlatBuilder();
    lot.rect(center.x, center.z, bounds.width / 2, bounds.depth / 2);
    lot.ribbon(this.gateX, lz1 - 0.5, this.gateX, driveEnd, driveW);
    lotEdge.rect(center.x, center.z, bounds.width / 2 + 0.25, bounds.depth / 2 + 0.25);
    lotEdge.ribbon(this.gateX, lz1, this.gateX, driveEnd, driveW + 0.6);
    const asphalt = mat(0xffffff, { map: asphaltTexture(), roughness: 0.92, wet: 1, name: 'asphalt' });
    const lotMesh = staticMesh(lot.toGeometry(LAYER.lot, 6), asphalt, false, true);
    lotMesh.name = 'ParkingLot';
    this.staticRoot.add(lotMesh);
    this.staticRoot.add(staticMesh(lotEdge.toGeometry(LAYER.edge + 0.012, PATH_TILE), this._pathMaterials().top, false, true));

    // Stall lines: boundaries between parked cars, extended across the row
    const cars = parking.cars || [];
    const rowZ = cars.length ? cars.reduce((s, c) => s + c.z, 0) / cars.length : center.z + 1;
    const xs = cars.map(c => c.x).sort((a, b) => a - b);
    const lines = [];
    if (xs.length) {
      lines.push(xs[0] - 2.1);
      for (let i = 0; i < xs.length - 1; i++) lines.push((xs[i] + xs[i + 1]) / 2);
      lines.push(xs[xs.length - 1] + 2.1);
      while (lines[0] - 3.2 > lx0 + 0.6) lines.unshift(lines[0] - 3.2);
      while (lines[lines.length - 1] + 3.2 < lx1 - 0.6) lines.push(lines[lines.length - 1] + 3.2);
    }
    const paint = new FlatBuilder();
    const zs = rowZ - 2.7, ze = lz1 - 0.3;
    for (const x of lines) paint.rect(x, (zs + ze) / 2, 0.06, (ze - zs) / 2);
    // stall front line + aisle arrows
    if (lines.length > 1) paint.rect((lines[0] + lines[lines.length - 1]) / 2, zs, (lines[lines.length - 1] - lines[0]) / 2 + 0.06, 0.06);
    for (const ax of [center.x - bounds.width * 0.3, center.x + bounds.width * 0.3]) {
      const az = lz0 + 2.4;
      paint.rect(ax - 0.6, az, 0.8, 0.09);
      const i = paint.pos.length / 3;
      paint.pos.push(ax + 0.2, 0, az - 0.4, ax + 0.9, 0, az, ax + 0.2, 0, az + 0.4);
      paint._tri(i, i + 1, i + 2);
    }
    this.staticRoot.add(staticMesh(paint.toGeometry(LAYER.paint, 4), mat(0xf0ece2, { roughness: 0.55, polygonOffset: -1, name: 'paint' }), false, true));

    // Curbs + wheel stops (concrete, vertex coloured)
    const CURB = 0xd6d0c2;
    const curb = [];
    const addCurb = (x, z, len, alongX) => {
      if (len <= 0.2) return;
      curb.push(P(roundedBox(alongX ? len : 0.26, 0.17, alongX ? 0.26 : len, 0.05), makeMatrix(x, 0.085, z), CURB));
    };
    addCurb(lx0 - 0.13, (lz0 + 1.8 + lz1) / 2, lz1 - lz0 - 1.8, false);
    const gapA = this.gateX - driveW / 2 - 0.2, gapB = this.gateX + driveW / 2 + 0.2;
    addCurb((lx0 + gapA) / 2, lz1 + 0.13, gapA - lx0, true);
    addCurb((gapB + lx1) / 2, lz1 + 0.13, lx1 - gapB, true);
    addCurb(lx1 + 0.13, (lz0 + 3 + lz1) / 2, lz1 - lz0 - 3, false);
    for (let i = 0; i < lines.length - 1; i++) {
      const sx = (lines[i] + lines[i + 1]) / 2;
      curb.push(P(roundedBox(1.5, 0.12, 0.22, 0.05), makeMatrix(sx, LAYER.lot + 0.06, lz1 - 0.75), 0xcfc9bb));
    }
    this.staticRoot.add(staticMesh(mergeParts(curb), propMat()));

    // Parked cars (2 instanced draws for all cars)
    if (cars.length) {
      const [paintGeo, trimGeo] = this._carGeometries();
      const items = cars.map((c) => ({
        position: [c.x, LAYER.lot, c.z],
        rotationY: c.rotation || 0,
        color: COLORS.carPaint[(c.color || 0) % COLORS.carPaint.length],
      }));
      const body = createInstanced(paintGeo, mat(0xffffff, { roughness: 0.3, metalness: 0.2, name: 'carPaint' }), items, { castShadow: true, receiveShadow: true, name: 'CarBodies' });
      const trim = createInstanced(trimGeo, glossyPropMat(), items.map(i => ({ position: i.position, rotationY: i.rotationY })), { castShadow: true, receiveShadow: true, name: 'CarTrim' });
      body.matrixAutoUpdate = trim.matrixAutoUpdate = false;
      this.scene.add(body, trim);
      for (const c of cars) this.scenery.addBlob(c.x, LAYER.lot, c.z, 2.3);
    }
    for (const car of cars) {
      // Physics blocker
      const shape = new CANNON.Box(new CANNON.Vec3(1.0, 0.8, 1.8));
      const physBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(car.x, 0.8, car.z),
        shape,
      });
      this.physicsWorld.addBody(physBody);
    }

    // Lot lamps
    this.scenery.addLamp(lx0 - 0.9, 0, lz1 - 0.8);
    this.scenery.addLamp(lx1 + 0.9, 0, lz1 - 0.8);
  }

  /** @returns {[THREE.BufferGeometry, THREE.BufferGeometry]} painted body, trim (glass/wheels/lights). */
  _carGeometries() {
    const paint = getGeometry('world-carPaint', () => {
      const g = mergeParts([
        P(roundedBox(1.84, 0.6, 3.9, 0.24, 2), makeMatrix(0, 0.62, 0)),
        P(roundedBox(1.52, 0.1, 1.75, 0.05, 2), makeMatrix(0, 1.43, 0.18)),
      ]);
      g.deleteAttribute('uv');
      return g;
    });
    const trim = getGeometry('world-carTrim', () => {
      const parts = [
        P(roundedBox(1.62, 0.52, 2.0, 0.2, 2), makeMatrix(0, 1.14, 0.15), 0x27333c),
        P(roundedBox(1.72, 0.16, 0.14, 0.05), makeMatrix(0, 0.4, -1.92), 0x35383b),
        P(roundedBox(1.72, 0.16, 0.14, 0.05), makeMatrix(0, 0.4, 1.92), 0x35383b),
        P(roundedBox(0.72, 0.16, 0.05, 0.02), makeMatrix(0, 0.64, -1.94), 0x25282b),
        P(boxGeo(0.46, 0.13, 0.03), makeMatrix(0, 0.62, 1.96), 0xefe9d8),
      ];
      for (const sx of [-1, 1]) {
        for (const sz of [-1.25, 1.25]) {
          parts.push(P(cylinderGeo(0.34, 0.34, 0.26, 12), makeMatrix(sx * 0.8, 0.34, sz, 0, 1, 0, Math.PI / 2), 0x1c1c1e));
          parts.push(P(cylinderGeo(0.19, 0.19, 0.27, 8), makeMatrix(sx * 0.8, 0.34, sz, 0, 1, 0, Math.PI / 2), 0xc4c8cc));
        }
        parts.push(P(roundedBox(0.42, 0.13, 0.06, 0.03), makeMatrix(sx * 0.58, 0.76, -1.93), 0xf4f0dc));
        parts.push(P(roundedBox(0.42, 0.12, 0.06, 0.03), makeMatrix(sx * 0.6, 0.78, 1.93), 0xa3161a));
        parts.push(P(roundedBox(0.14, 0.1, 0.08, 0.03), makeMatrix(sx * 0.95, 1.0, -0.62), 0x2a2d30));
      }
      const g = mergeParts(parts);
      g.deleteAttribute('uv');
      return g;
    });
    return [paint, trim];
  }

  // ───────────────────────────── perimeter ─────────────────────────────

  _buildPerimeter() {
    // Perimeter wall physics (unchanged: 2 m high, 0.3 thick) along the fence lines. The north
    // and south runs split at _splitX: west of it they are the pre-extension fence exactly,
    // east of it an extension run reaches the east side.
    const wallH = 2;
    const { x0, x1, z0, z1 } = this.bounds;
    const xs = this._splitX;
    const ext = x1 > xs + 0.5;
    const zN = z1;   // the north fence line (gate side)

    const walls = [
      { pos: [(x0 + xs) / 2, wallH / 2, z0], size: [xs - x0, wallH, 0.3] },
      { pos: [(x0 + xs) / 2, wallH / 2, z1], size: [xs - x0, wallH, 0.3] },
      { pos: [x0, wallH / 2, (z0 + z1) / 2], size: [0.3, wallH, z1 - z0] },
      { pos: [x1, wallH / 2, (z0 + z1) / 2], size: [0.3, wallH, z1 - z0] },
    ];
    if (ext) {
      walls.push({ pos: [(xs + x1) / 2, wallH / 2, z0], size: [x1 - xs, wallH, 0.3] });
      walls.push({ pos: [(xs + x1) / 2, wallH / 2, z1], size: [x1 - xs, wallH, 0.3] });
    }
    for (const w of walls) {
      const shape = new CANNON.Box(
        new CANNON.Vec3(w.size[0] / 2, w.size[1] / 2, w.size[2] / 2)
      );
      const body = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(...w.pos),
        shape,
      });
      this.physicsWorld.addBody(body);
    }

    // Visual: stone base + piers + wrought-iron pickets, with a gated entrance on the north side
    const gx = this.gateX, gateHalf = 4.1, pillarW = 1.15;
    const stone = [];
    const panels = [];   // [x0, z0, x1, z1, y0, y1]
    const BASE = 0xd9d0bc, PIER = 0xeae2cf, CAP = 0xf4eee0;
    // skip: 'first' / 'last' pier of an extension run (the pre-extension run already has one there)
    const sides = [
      { a: [x0, z0], b: [xs, z0] },
      { a: [x1, z0], b: [x1, z1] },
      { a: [xs, z1], b: [x0, z1], gate: true },
      { a: [x0, z1], b: [x0, z0] },
    ];
    if (ext) {
      sides.push({ a: [xs, z0], b: [x1, z0], skip: 'first' });
      sides.push({ a: [x1, z1], b: [xs, z1], skip: 'last' });
    }
    const pierAt = (x, z) => {
      stone.push(P(roundedBox(0.62, 2.1, 0.62, 0.05, 1), makeMatrix(x, 1.05, z), PIER));
      stone.push(P(roundedBox(0.8, 0.14, 0.8, 0.04, 1), makeMatrix(x, 2.17, z), CAP));
      stone.push(P(sphereGeo(0.14, 8, 5), makeMatrix(x, 2.35, z), CAP));
    };
    for (const s of sides) {
      const [ax, az] = s.a, [bx, bz] = s.b;
      const len = Math.hypot(bx - ax, bz - az);
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      // split around the gate
      let spans = [[0, len]];
      if (s.gate) {
        const tg = (gx - ax) / ux; // along-side param of the gate centre
        spans = [[0, tg - gateHalf - pillarW], [tg + gateHalf + pillarW, len]];
      }
      for (const [t0, t1] of spans) {
        const L = t1 - t0;
        if (L <= 0.5) continue;
        const mx = ax + ux * (t0 + L / 2), mz = az + uz * (t0 + L / 2);
        const alongX = Math.abs(ux) > 0.5;
        stone.push(P(roundedBox(alongX ? L : 0.42, 0.55, alongX ? 0.42 : L, 0.05, 1), makeMatrix(mx, 0.275, mz), BASE));
        const n = Math.max(1, Math.round(L / 9.5));
        for (let i = 0; i <= n; i++) {
          const t = t0 + (L * i) / n;
          if (!((s.skip === 'first' && i === 0) || (s.skip === 'last' && i === n))) pierAt(ax + ux * t, az + uz * t);
          if (i < n) {
            const ta = t + 0.33, tb = t0 + (L * (i + 1)) / n - 0.33;
            panels.push([ax + ux * ta, az + uz * ta, ax + ux * tb, az + uz * tb, 0.52, 1.92]);
          }
        }
      }
    }
    // Gate pillars
    for (const sx of [-1, 1]) {
      const px = gx + sx * (gateHalf + pillarW / 2);
      stone.push(P(roundedBox(pillarW, 3.1, pillarW, 0.06), makeMatrix(px, 1.55, zN), PIER));
      stone.push(P(roundedBox(pillarW + 0.3, 0.2, pillarW + 0.3, 0.05), makeMatrix(px, 3.2, zN), CAP));
      stone.push(P(roundedBox(pillarW + 0.2, 0.3, pillarW + 0.2, 0.05), makeMatrix(px, 0.15, zN), BASE));
      this.scenery.addLamp(px, 3.3, zN, { post: false });
      this.scenery.addFlowerClump(px, 0, zN - 1.3, COLORS.flowers[sx < 0 ? 0 : 3], 1.3);
      this.scenery.addFlowerClump(px + 0.7 * sx, 0, zN - 1.1, 0xf4efe6, 1.0);
      this.scenery.addTree('cypress', px + sx * 1.6, 0, zN + 1.6, { scale: 1.1 });
    }
    const stoneGeo = mergeParts(stone);
    worldBoxUV(stoneGeo, 2.2);
    const stoneMat = mat(0xffffff, { map: Textures.pavers({ repeat: [1, 1] }), vertexColors: true, roughness: 0.9, wet: 0.5, name: 'wallStone' });
    this.staticRoot.add(staticMesh(stoneGeo, stoneMat));

    // Iron picket panels + gate leaves (one alpha-tested geometry)
    panels.push([gx - gateHalf, zN, gx - 0.03, zN, 0.04, 2.35]);
    panels.push([gx + 0.03, zN, gx + gateHalf, zN, 0.04, 2.35]);
    const pp = [], pu = [], pn = [], pi = [];
    for (const [x0, z0, x1, z1, y0, y1] of panels) {
      const L = Math.hypot(x1 - x0, z1 - z0);
      const u1 = Math.max(1, Math.round(L / 1.2));
      const nx = -(z1 - z0) / L, nz = (x1 - x0) / L;
      const i = pp.length / 3;
      pp.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0);
      pu.push(0, 0, u1, 0, u1, 1, 0, 1);
      for (let k = 0; k < 4; k++) pn.push(nx, 0, nz);
      pi.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }
    const ironGeo = new THREE.BufferGeometry();
    ironGeo.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    ironGeo.setAttribute('normal', new THREE.Float32BufferAttribute(pn, 3));
    ironGeo.setAttribute('uv', new THREE.Float32BufferAttribute(pu, 2));
    ironGeo.setIndex(pi);
    const ironMat = mat(COLORS.ironWork, { map: picketTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.35, name: 'ironPickets' });
    const iron = staticMesh(ironGeo, ironMat, true, false);
    iron.name = 'IronFence';
    this.staticRoot.add(iron);

    // Gate crossbar, scroll arch and hanging club sign
    const I = COLORS.ironWork;
    const arch = [
      P(boxGeo(gateHalf * 2 + 0.2, 0.09, 0.09), makeMatrix(gx, 2.5, zN), I),
      P(boxGeo(0.07, 2.4, 0.07), makeMatrix(gx - 0.03, 1.2, zN), I),
      P(boxGeo(0.07, 2.4, 0.07), makeMatrix(gx + 0.03, 1.2, zN), I),
    ];
    const archGeo = getGeometry(`world-gateArch|${gateHalf}`, () => {
      const g = new THREE.TorusGeometry(gateHalf, 0.05, 6, 28, Math.PI);
      g.scale(1, 0.34, 1);
      return g;
    });
    arch.push(P(archGeo, makeMatrix(gx, 2.5, zN), I));
    for (const sx of [-1, 1]) arch.push(P(boxGeo(0.05, 0.8, 0.05), makeMatrix(gx + sx * 1.9, 2.95, zN), I));
    arch.push(P(roundedBox(5.0, 1.02, 0.1, 0.04), makeMatrix(gx, 3.55, zN), COLORS.clubGreen));
    this.staticRoot.add(staticMesh(mergeParts(arch), propMat()));

    const name = (this.mapData.name || 'Greenbriar Tennis & Social Club').trim();
    const sp = name.indexOf(' ');
    const title = (sp > 0 ? name.slice(0, sp) : name).toUpperCase();
    const sub = (sp > 0 ? name.slice(sp + 1) : '').toUpperCase();
    const signTex = signTexture('world-gateSign', [
      { text: title, size: 0.42, y: 0.43 },
      { text: sub, size: 0.17, y: 0.76, weight: 'normal', color: '#e7d7a6' },
    ]);
    const signMat = mat(0xffffff, { map: signTex, roughness: 0.55, name: 'gateSign' });
    const signPlane = getGeometry('world-gateSignPlane', () => new THREE.PlaneGeometry(4.8, 0.92));
    for (const face of [-1, 1]) {
      const s = new THREE.Mesh(signPlane, signMat);
      s.position.set(gx, 3.55, zN + face * 0.056);
      s.rotation.y = face > 0 ? 0 : Math.PI;
      s.castShadow = false;
      this.staticRoot.add(s);
    }

    // Hedge band just inside the fence (gap for the driveway)
    const hedgeMat = mat(0xffffff, { map: Textures.hedge({ repeat: [1, 1] }), roughness: 0.95, wet: 0.35, name: 'hedge' });
    const hedgeCells = new Map(); // 64 m cell (club quadrant) -> parts (compact, cullable chunks)
    const inset = 1.15, hh = 1.3, hd = 1.1;
    // the extension's hedge joins the easternmost pre-extension cells (no extra draw calls)
    const maxKx = Math.floor((xs - inset) / 64);
    const run = (ax, az, bx, bz) => {
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(L / 9));
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      for (let i = 0; i < n; i++) {
        const t0 = (L * i) / n + 0.15, t1 = (L * (i + 1)) / n - 0.15;
        const seg = t1 - t0, mx = ax + ux * (t0 + seg / 2), mz = az + uz * (t0 + seg / 2);
        const h = hh + (hash2(i, Math.round(mx), 4) - 0.5) * 0.25;
        const alongX = Math.abs(ux) > 0.5;
        const ck = `${Math.min(Math.floor(mx / 64), maxKx)},${Math.floor(mz / 64)}`;
        if (!hedgeCells.has(ck)) hedgeCells.set(ck, []);
        hedgeCells.get(ck).push(P(roundedBox(alongX ? seg : hd, h, alongX ? hd : seg, 0.42, 1), makeMatrix(mx, h / 2, mz)));
      }
    };
    const e = inset;
    run(x0 + e, z0 + e, xs - e, z0 + e);
    run(x1 - e, z0 + e, x1 - e, z1 - e);
    run(xs - e, z1 - e, gx + gateHalf + pillarW + 2.2, z1 - e);
    run(gx - gateHalf - pillarW - 2.2, z1 - e, x0 + e, z1 - e);
    run(x0 + e, z1 - e, x0 + e, z0 + e);
    if (ext) {
      // the extension runs pick up where the pre-extension corner used to be
      run(xs - e, z0 + e, x1 - e, z0 + e);
      run(x1 - e, z1 - e, xs - e, z1 - e);
    }
    for (const [ck, parts] of hedgeCells) {
      const hedgeGeo = mergeParts(parts);
      worldBoxUV(hedgeGeo, 2.5);
      const hedgeMesh = staticMesh(hedgeGeo, hedgeMat);
      hedgeMesh.name = `PerimeterHedge@${ck}`;
      this.staticRoot.add(hedgeMesh);
    }
  }

  // ───────────────────────────── trees ─────────────────────────────

  _buildTrees() {
    const rand = seededRandom(9127);
    const placed = [];
    const tooClose = (x, z, d) => placed.some(p => (p[0] - x) ** 2 + (p[1] - z) ** 2 < d * d);
    const belts = [];   // trees inside the fence that get trunk collision
    const { x0, x1, z0, z1 } = this.bounds;
    const xs = this._splitX;
    const layout = this.stadiumLayout;

    const speciesAt = (x, z) => {
      const n = valueNoise2(x * 0.06 + 3.1, z * 0.06 + 7.7, 21);
      if (n < 0.36) return 'pine';
      if (n > 0.78) return 'blossom';
      return 'oak';
    };
    const plantBelt = (sp, x, z, scale) => {
      this.scenery.addTree(sp, x, 0, z, { scale });
      belts.push([x, z, scale]);
    };
    // The lawn pass (_buildGrass) rings every tree inside the fence with tufts, drawing from its
    // own stream tree by tree in the scenery's order (species key, then insertion). To keep that
    // stream as it was before the club grew east it gets the pre-extension trees in their old
    // order — the scenery keys that already exist (garden), then the legacy draws below, planted
    // or left out for the bowl — and the extension's trees (this._extTrees) separately.
    const keyOf = (sp) => `${sp}|0|1`;
    const legacy = this._legacyTrees = { keys: Object.keys(this.scenery.trees), pre: {}, seq: {} };
    for (const k of legacy.keys) legacy.pre[k] = this.scenery.trees[k].items.length;
    const legacyTree = (sp, x, z, planted) => {
      const k = keyOf(sp);
      if (!legacy.seq[k]) { legacy.seq[k] = []; if (!legacy.keys.includes(k)) legacy.keys.push(k); }
      legacy.seq[k].push([x, z, planted]);
    };
    this._extTrees = [];

    // Inner belts between the perimeter cart path and the hedge. The pre-extension belts (west
    // of _splitX) draw from `rand` exactly as before the club grew east, against the blockers
    // of that time (isFree preBowl), so they, the feature trees and the outer woodland after them
    // keep their places; a drawn tree is planted only where it is still free (not in the bowl's
    // clear zone, nor on the extension's paths).
    const regions = [
      [x0 + 3.2, -44.2, z0 + 3.2, z1 - 3.2, 34],
      [49.8, xs - 3.2, z0 + 3.2, z1 - 3.2, 22],
      [x0 + 3.2, xs - 3.2, z0 + 3.0, -47.2, 12],
      [x0 + 3.2, xs - 3.2, 37.2, z1 - 3.0, 22],
    ];
    for (const [rx0, rx1, rz0, rz1, target] of regions) {
      let n = 0;
      for (let tries = 0; tries < target * 30 && n < target; tries++) {
        const x = rx0 + rand() * (rx1 - rx0), z = rz0 + rand() * (rz1 - rz0);
        const sp = speciesAt(x, z);
        const r = sp === 'pine' ? 4.2 : 5.4;
        if (tooClose(x, z, r) || !this.isFree(x, z, 1.8, { preBowl: true })) continue;
        const scale = 0.85 + rand() * 0.45;
        const free = this.isFree(x, z, 1.8);
        if (free) plantBelt(sp, x, z, scale);
        legacyTree(sp, x, z, free);
        placed.push([x, z]);
        n++;
      }
    }
    // The extension east of _splitX (its own stream): the east belt behind the bowl's clear
    // zone, and the north / south belts carried on to the east fence
    if (x1 > xs + 0.5) {
      const r2 = seededRandom(9128);
      const eastFrom = Math.max(49.8, xs - 3.2, layout ? layout.cut.x1 + 8 : -Infinity);
      const ext = [
        [eastFrom, x1 - 3.2, z0 + 3.2, z1 - 3.2, 18],
        [xs - 3.2, x1 - 3.2, z0 + 3.0, -47.2, 4],
        [xs - 3.2, x1 - 3.2, 37.2, z1 - 3.0, 8],
      ];
      for (const [rx0, rx1, rz0, rz1, target] of ext) {
        if (!(rx1 - rx0 > 1 && rz1 - rz0 > 1)) continue;
        let n = 0;
        for (let tries = 0; tries < target * 30 && n < target; tries++) {
          const x = rx0 + r2() * (rx1 - rx0), z = rz0 + r2() * (rz1 - rz0);
          const sp = speciesAt(x, z);
          if (tooClose(x, z, sp === 'pine' ? 4.2 : 5.4) || !this.isFree(x, z, 1.8)) continue;
          plantBelt(sp, x, z, 0.85 + r2() * 0.45);
          this._extTrees.push([x, z]);
          placed.push([x, z]);
          n++;
        }
      }
    }

    // Feature trees inside the grounds (no collision; kept clear of paths and NPC routes)
    const features = [
      ['oak', 9, 27], ['oak', 24, 28.5], ['blossom', 1, 29.5], ['oak', 38, 26], ['blossom', 16, 30.5],
      ['oak', -33, -16], ['pine', -37, -24], ['oak', -31, -27], ['pine', -36, -8], ['blossom', -30, -21],
      ['blossom', -10.2, 26], ['blossom', -10.2, 21], ['oak', 39.5, 14], ['pine', 39.5, -3],
      ['blossom', -31.5, 17], ['oak', -34.5, 13.5],
    ];
    for (const [sp, x, z] of features) {
      if (!this._insideFence(x, z, 3) || tooClose(x, z, 3.5) || !this.isFree(x, z, 1.4, { preBowl: true })) continue;
      const scale = 0.95 + rand() * 0.25;
      const free = this.isFree(x, z, 1.4);
      if (free) this.scenery.addTree(sp, x, 0, z, { scale });
      legacyTree(sp, x, z, free);
      placed.push([x, z]);
    }

    // Outside the fence: meadow woodland on the soft hills (low detail, no shadows/physics).
    // The pre-extension loop draws exactly as before (sampling ±wx × ±wz around the old fence)
    // and leaves out what now falls inside the grown fence; an east pass on its own stream
    // fills the plane's extension at the same density.
    const g = this.groundExtents;
    const outer = [];
    const oOpt = { octaves: 3, seed: 91 };
    const inFence = (x, z, m) => x > x0 - m && x < x1 + m && z > z0 - m && z < z1 + m;
    const woodland = (rnd, x, z) => {   // the same two draws whether or not the tree is planted
      const sp = rnd() < 0.45 ? 'pine' : 'oak';
      const scale = 0.9 + rnd() * 0.6;
      if (inFence(x, z, 4)) return;
      const near = inFence(x, z, 14);
      this.scenery.addTree(sp, x, this.groundHeight(x, z) - 0.1, z, { scale, lod: !near, shadow: near });
    };
    const wx = Math.min(-g.x0, g.x1) - 4, wz = Math.min(-g.z0, g.z1) - 4;
    for (let tries = 0; tries < 9000 && outer.length < 260; tries++) {
      const x = (rand() * 2 - 1) * wx;
      const z = (rand() * 2 - 1) * wz;
      if (x > x0 - 4 && x < xs + 4 && z > z0 - 4 && z < z1 + 4) continue;   // the pre-extension fence + 4
      if (z > z1 && Math.abs(x - this.gateX) < 10) continue;
      const dens = fbm2(x * 0.03, z * 0.03, oOpt);
      if (dens < 0.42 + rand() * 0.12) continue;
      if (outer.some(p => (p[0] - x) ** 2 + (p[1] - z) ** 2 < 16)) continue;
      outer.push([x, z]);
      woodland(rand, x, z);
    }
    const ex0 = Math.max(x1 + 4, wx), ex1 = g.x1 - 4;
    if (ex1 - ex0 > 4) {
      const r3 = seededRandom(92);
      // Same tries per m² as the loop above; its cap spread over the area outside the old fence
      const share = ((ex1 - ex0) * 2 * wz) / (4 * wx * wz);
      const clubShare = ((xs - x0 + 8) * (z1 - z0 + 8)) / (4 * wx * wz);
      const cap = outer.length + Math.ceil(260 * share / Math.max(0.2, 1 - clubShare));
      const tries = Math.round(9000 * share);
      for (let t = 0; t < tries && outer.length < cap; t++) {
        const x = ex0 + r3() * (ex1 - ex0);
        const z = (r3() * 2 - 1) * wz;
        if (inFence(x, z, 4) || (z > z1 && Math.abs(x - this.gateX) < 10)) continue;
        const dens = fbm2(x * 0.03, z * 0.03, oOpt);
        if (dens < 0.42 + r3() * 0.12) continue;
        if (outer.some(p => (p[0] - x) ** 2 + (p[1] - z) ** 2 < 16)) continue;
        outer.push([x, z]);
        woodland(r3, x, z);
      }
    }

    // Trunk collision for belt trees: one static body per belt region (many small box shapes)
    if (belts.length) {
      const body = new CANNON.Body({ mass: 0 });
      for (const [x, z, s] of belts) {
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.28 * s, 1.2, 0.28 * s)), new CANNON.Vec3(x, 1.2, z));
      }
      this.physicsWorld.addBody(body);
    }
  }

  // ───────────────────────────── lamps ─────────────────────────────

  _buildLamps() {
    const placed = this.scenery.lamps.map(l => [l.x, l.z]);
    // keep the spawn views clear (count them as occupied)
    for (const sp of [this.mapData.spawnPoint, this.mapData.cartSpawnPoint]) if (sp) placed.push([sp.x, sp.z]);
    const spacing = 17;
    let side = 1;
    for (const path of this.mapData.paths) {
      const w = path.width || 3;
      const pts = path.points;
      let carry = spacing * 0.5;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L < 0.01) continue;
        const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
        for (let t = carry; t < L; t += spacing) {
          side = -side;
          const off = w / 2 + EDGE_EXTRA / 2 + 0.55;
          const x = a.x + ux * t - uz * off * side, z = a.z + uz * t + ux * off * side;
          if (!this._insideFence(x, z, 3)) continue;
          // lamps may line the bowl's ring path (its clear zone), not stand in a camera well,
          // nor right in front of a scoreboard or against a floodlight mast
          if (!this.isFree(x, z, 0.25, { ignore: ['stadiumClear'] }) || !this._clearOfBowlProps(x, z, 1.2)) continue;
          if (placed.some(p => (p[0] - x) ** 2 + (p[1] - z) ** 2 < 110)) continue;
          placed.push([x, z]);
          this.scenery.addLamp(x, 0, z);
        }
        carry = ((carry - L) % spacing + spacing) % spacing;
      }
    }
  }

  // ───────────────────────────── grass tufts & wildflowers ─────────────────────────────

  _buildGrass() {
    const rand = seededRandom(5511);
    const MAX = 7000;
    const s = this.scenery;
    // Tufts and wildflowers may grow in the bowl's clear zone and camera wells (not in the bowl)
    const lawnIgnore = ['garden', 'stadiumClear', 'cameraWell'];
    const tryTuft = (x, z, scale) => {
      if (s.tufts.length >= MAX) return;
      if (!this._insideFence(x, z, 2.2) || !this.isFree(x, z, 0.12, { ignore: lawnIgnore })) return;
      if (this._inGarden(x, z)) return;
      s.addTuft(x, 0, z, scale);
    };
    // Along a path's edges (untrimmed verge)
    const verge = (rnd, seg) => {
      const L = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      const ux = (seg.bx - seg.ax) / (L || 1), uz = (seg.bz - seg.az) / (L || 1);
      for (let t = 0; t < L; t += 0.5) {
        for (const sd of [-1, 1]) {
          if (rnd() < 0.3) continue;
          const off = seg.r + 0.14 + rnd() * 0.45;
          const tt = t + rnd() * 0.6;
          tryTuft(seg.ax + ux * tt - uz * off * sd, seg.az + uz * tt + ux * off * sd, 0.45 + rnd() * 0.35);
        }
      }
    };
    // Around a court fence or a building base
    const rectEdge = (rnd, r) => {
      if (r.tag !== 'court' && r.tag !== 'building' && r.tag !== 'patio') return;
      const per = 2 * (r.hx + r.hz) * 2;
      for (let k = 0; k < per * 1.1; k++) {
        const u = rnd() * 4;
        let x, z;
        const o = 0.1 + rnd() * 0.5;
        if (u < 1) { x = r.cx - r.hx + u * 2 * r.hx; z = r.cz - r.hz - o; }
        else if (u < 2) { x = r.cx - r.hx + (u - 1) * 2 * r.hx; z = r.cz + r.hz + o; }
        else if (u < 3) { x = r.cx - r.hx - o; z = r.cz - r.hz + (u - 2) * 2 * r.hz; }
        else { x = r.cx + r.hx + o; z = r.cz - r.hz + (u - 3) * 2 * r.hz; }
        tryTuft(x, z, 0.5 + rnd() * 0.3);
      }
    };
    // Around a tree trunk (the draws happen whether or not the tree was planted)
    const trunk = (rnd, x, z, planted) => {
      if (!this._insideFence(x, z, 2)) return;
      for (let k = 0; k < 6; k++) {
        const a = rnd() * Math.PI * 2, r = 0.3 + rnd() * 0.7;
        const sc = 0.5 + rnd() * 0.3;
        if (planted) tryTuft(x + Math.cos(a) * r, z + Math.sin(a) * r, sc);
      }
    };

    // The pre-extension lawn draws from `rand` exactly as before the club grew east — the verges
    // of the paths of that time, the courts' and buildings' edges, the trunks of the trees of
    // that time in their old order (_buildTrees: this._legacyTrees), then the wildflowers — so
    // it all keeps its place (a tuft or clump now on the bowl's ground is left out). The
    // extension's verges, the bowl's masts / scoreboards and its trees follow on their own stream.
    for (const seg of this._segs) if (!seg.ext) verge(rand, seg);
    for (const r of this._rects) if (!r.layout) rectEdge(rand, r);
    const lg = this._legacyTrees;
    if (lg) {
      for (const key of lg.keys) {
        const t = s.trees[key];
        if (t && t.lod) continue;
        const n0 = lg.pre[key] || 0;
        for (let i = 0; i < n0; i++) trunk(rand, t.items[i].position[0], t.items[i].position[2], true);
        const seq = lg.seq[key];
        if (seq) for (const [x, z, planted] of seq) trunk(rand, x, z, planted);
      }
    } else {
      for (const t of Object.values(s.trees)) {
        if (t.lod) continue;
        for (const it of t.items) trunk(rand, it.position[0], it.position[2], true);
      }
    }
    // Wildflower drifts (the open lawn itself stays manicured: no random clumps). They stay in
    // the pre-extension grounds (west of _splitX, the edge measured from the old fence): the east
    // extension would add a pair of flower draw calls per scenery cell for a handful of clumps;
    // its edges carry the belts. A drift drawn where the bowl now stands is left out.
    const { x0, z0, z1 } = this.bounds, xw = this._splitX;
    const wild = [0xf6f3ea, 0xf2d34c, 0xc9b6e8, 0xf6f3ea];
    let flowers = 0;
    for (let tries = 0; tries < 3000 && flowers < 140; tries++) {
      const x = x0 + 2.5 + rand() * (xw - x0 - 5), z = z0 + 2.5 + rand() * (z1 - z0 - 5);
      // drifts near the edges of the grounds
      const edge = Math.min(x - x0, xw - x, z - z0, z1 - z);
      if (edge > 14 && rand() < 0.85) continue;
      if (!this.isFree(x, z, 0.4, { ignore: lawnIgnore, preBowl: true }) || this._inGarden(x, z)) continue;
      const color = wild[(rand() * wild.length) | 0], scale = 0.45 + rand() * 0.2;
      if (this.isFree(x, z, 0.4, { ignore: lawnIgnore })) s.addFlowerClump(x, -0.02, z, color, scale);
      flowers++;
    }

    const r2 = seededRandom(5512);
    for (const seg of this._segs) if (seg.ext) verge(r2, seg);
    for (const r of this._rects) if (r.layout) rectEdge(r2, r);
    for (const [x, z] of this._extTrees || []) trunk(r2, x, z, true);
    this._legacyTrees = this._extTrees = null;   // build-time only
  }

  _inGarden(x, z) {
    const g = this.mapData.areas.garden;
    if (!g) return false;
    return Math.abs(x - g.center.x) < g.bounds.width / 2 + 0.5 && Math.abs(z - g.center.z) < g.bounds.depth / 2 + 0.5;
  }

  // ───────────────────────────── lights ─────────────────────────────

  _buildLights() {
    const A = this.mapData.areas;
    const spots = [];
    if (A.patio) spots.push([A.patio.center.x, 2.6, A.patio.center.z + 1.5, 16]);
    if (A.garden && A.garden.fountain) spots.push([A.garden.fountain.x, 3.0, A.garden.fountain.z, 11]);
    if (A.parking) spots.push([A.parking.center.x, 3.8, A.parking.center.z + 2, 14]);
    spots.push([this.gateX, 3.4, this.bounds.z1 - 2.5, 10]);
    this._lightSpots = spots;
    // Slot 0 (when any light is allowed) is a warm "carry" light that follows the
    // player / cart so the follow-cam subject stays readable at night. The light
    // count is fixed per tier, so moving it never triggers a shader recompile.
    const apply = (settings) => {
      const n = Math.min(spots.length + 1, Math.max(0, settings.maxLights | 0));
      while (this.lights.length < n) {
        const i = this.lights.length;
        let l;
        if (i === 0) {
          l = new THREE.PointLight(0xffe2b8, 0, 7, 2);
          l.userData.power = 4;
          l.userData.carry = true;
          if (this._carryFocus) l.position.copy(this._carryFocus);
          this._carryLight = l;
        } else {
          const [x, y, z, power] = spots[i - 1];
          l = new THREE.PointLight(0xffb86e, 0, 15, 2);
          l.position.set(x, y, z);
          l.userData.power = power;
        }
        l.castShadow = false;
        l.visible = false; // only counted by three (NUM_POINT_LIGHTS) once lit, see update()
        this.scene.add(l);
        this.lights.push(l);
      }
      while (this.lights.length > n) {
        const l = this.lights.pop();
        if (l === this._carryLight) this._carryLight = null;
        this.scene.remove(l);
        l.dispose && l.dispose();
      }
      this._lastLampFactor = -1;
    };
    apply(Quality.settings);
    Quality.onChange((tier, settings) => apply(settings));
  }

  /** @param {number} dt @param {{x:number,y:number,z:number}} [focus] player / cart world position */
  update(dt, focus) {
    // Building cutaways + interior visibility; indoorBlend eases the follow camera in/up indoors
    const cam = CameraTracker.valid ? CameraTracker.position : null;
    let indoor = false;
    for (let i = 0; i < this.buildings.length; i++) {
      const b = this.buildings[i];
      if (b.updateView(focus, cam)) indoor = true;
      if (b.update) b.update(dt);
    }
    const k = Math.min(1, dt * 3);
    this.indoorBlend = (this.indoorBlend || 0) + ((indoor ? 1 : 0) - (this.indoorBlend || 0)) * k;
    if (focus) {
      const cf = this._carryFocus || (this._carryFocus = new THREE.Vector3());
      cf.set(focus.x, focus.y + 2.4, focus.z);
      if (this._carryLight) this._carryLight.position.copy(cf);
    }
    if (this.garden) {
      this.garden.update(dt);
    }
    if (this.stadium) this.stadium.update(dt);
    this.scenery.update();
    const f = EnvState.lampFactor || 0;
    if (Math.abs(f - this._lastLampFactor) > 0.01) {
      this._lastLampFactor = f;
      // Hidden while off: three compiles every lit shader with NUM_POINT_LIGHTS = visible
      // lights, so zero-intensity lights would still cost a BRDF loop per pixel all day.
      // Hysteresis keeps dusk flicker from toggling programs back and forth.
      const on = this.lights.length && this.lights[0].visible ? f > 0.01 : f > 0.03;
      for (const l of this.lights) {
        l.intensity = f * l.userData.power;
        l.visible = on;
      }
    }
  }
}
