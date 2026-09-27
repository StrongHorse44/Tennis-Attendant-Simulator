import * as THREE from 'three';
import { COLORS } from '../utils/Constants.js';
import { mat, getMaterial, sharedDepthMaterial } from '../graphics/Materials.js';
import { Textures, seededRandom, fbm2 } from '../graphics/Textures.js';
import {
  boxGeo, cylinderGeo, sphereGeo, coneGeo, roundedBox, getGeometry, mergeParts, makeMatrix,
} from '../graphics/GeometryUtils.js';
import { Quality } from '../graphics/Quality.js';
import { EnvState } from '../graphics/EnvState.js';
import { Court, courtLampGlassMaterial, courtHaloMaterial, registerOcclusionTwin, unregisterOcclusionTwin } from './Court.js';
import { Mat, glassPane, prismGeo } from './Building.js';
import { Stadium } from './Stadium.js';
import { treeGeometry, lumpyIco, applyWindSway, benchGeometry } from './Scenery.js';
import { CrowdImpostors, stadiumSeatGeometry, hashU } from './CrowdImpostors.js';
import {
  venueAtlasTexture, atlasUV, ATLAS, ATLAS_PX, CROWD_TILE_M, facadeTextures, FACADE_TILE_M,
  scoreboardCanvas, drawScoreIdle, drawScore,
} from './VenueArt.js';

/**
 * VenueBuilder — builds one Junior Tour venue (another club's tournament court) far from the
 * club, from its tour.json definition (see Venues.js for the schema and the API). Everything is
 * made from the kit's materials and programs that exist at load (no shader compiles when a venue
 * is built): the court is a real Court (venue options), the rest is merged by material:
 *
 *   ground        a ~430 m lawn disc (the club's grass material, vertex-tinted to look.ground)
 *   apron / paths the club's path / edging materials, asphalt for a public park
 *   stands        bleachers (aluminium / wood / covered) or concrete stands with instanced seats
 *                 (the stadium seat program), crowd impostors on the front rows (2 draws, the
 *                 Centre Court figures) and painted crowd strips (the awning program) behind them
 *   clubhouse     shed / lodge / boathouse / pavilion / modern / arena (Building's materials)
 *   trees         instanced (the scenery tree program): pine / oak / maple (autumn)
 *   backdrop      city / forest / harbor / lawn / campus / night: facade blocks (lit windows at
 *                 night), forest belts, water, boats, a lighthouse, far skylines and hills (the
 *                 club horizon's hill material, so they haze like the club's)
 *   lights        the court's own poles, corner masts or stadium rigs (court lamp glass + halos)
 *   extras        umpire (a seated Character), line-judge chairs, flags (waving), scoreboards
 *
 * Coordinates: the venue's local frame has the court centre at its origin (u = x across, v = z
 * along; north = −z, the far end from the default camera). The local group sits at the venue
 * origin; the Court is built in world coordinates (its config.center) beside it.
 */

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const FENCE_Z = 14.5;           // the court's back fences (Court: courtDepth / 2 + 0.5)
const END_FRONT = 17.6;         // end stands start here (behind the camera's well, see TennisCamera)
const GROUND_R = 430;           // lawn disc radius (fog far is ≤ 340)
const STRIP_Y = 0.35;           // painted crowd strips: bottom above the tread (inside the seat pans)…
const STRIP_H = 0.95;           // …and height (torso over the seat, head above the back)
const SEAT_W = 0.55;            // seat pitch along a row

// Court colour lift: tour.json colours are what the court should look like on screen; the court
// shader multiplies by the acrylic grain and the lighting / grade darkens red most (measured on
// the club's hard courts: 0x5085c4 → #2f6db3, 0x618c66 → #3f7d55), so the paint is lifted per
// channel in linear space.
const LIFT = [0.385, 0.717, 0.75];
const FACADE_TOP_UV = Object.freeze([0.5, 0.995]);

const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _col = new THREE.Color();
const _c2 = new THREE.Color();

function liftCourtColor(hex) {
  _col.set(hex);
  _col.r = Math.min(1, _col.r / LIFT[0]);
  _col.g = Math.min(1, _col.g / LIFT[1]);
  _col.b = Math.min(1, _col.b / LIFT[2]);
  return _col.getHex();
}

/** Roofs: the shingle map is mid grey, so a roof colour is lifted (linear) to read as itself. */
function liftRoofColor(hex) {
  _col.set(hex);
  _col.r = Math.min(1, _col.r / 0.5);
  _col.g = Math.min(1, _col.g / 0.5);
  _col.b = Math.min(1, _col.b / 0.5);
  return _col.getHex();
}

function shade(hex, k) {
  _c2.set(hex);
  if (k >= 0) _c2.lerp(_col.setRGB(1, 1, 1), k); else _c2.multiplyScalar(1 + k);
  return _c2.getHex();
}

function mix(a, b, t) {
  _c2.set(a).lerp(_col.set(b), t);
  return _c2.getHex();
}

const _nm = new THREE.Matrix3();
const _pc = new THREE.Color();

/**
 * Merge parts ({ geometry, matrix?, color?, tile?, offU?, offV?, topUV? }) into one indexed
 * geometry in a single pass over preallocated arrays (no per-part clones): positions and normals
 * transformed, vertex colours from `color` (sRGB hex → linear, like mergeParts), UVs copied or,
 * with `tile`, box-projected from the transformed vertex (world units / tile; `topUV` pins the
 * up-facing faces to one texel). Mirrored transforms get their winding flipped.
 */
function fastMerge(parts) {
  let nV = 0, nI = 0, wantColor = false, wantUv = false;
  for (const p of parts) {
    const g = p.geometry;
    const n = g.attributes.position.count;
    nV += n;
    nI += g.index ? g.index.count : n;
    if (p.color !== undefined) wantColor = true;
    if (g.attributes.uv || p.tile) wantUv = true;
  }
  const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3);
  const col = wantColor ? new Float32Array(nV * 3) : null;
  const uv = wantUv ? new Float32Array(nV * 2) : null;
  const idx = nV > 65535 ? new Uint32Array(nI) : new Uint16Array(nI);
  let vo = 0, io = 0;
  for (const p of parts) {
    const g = p.geometry, P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv, C = g.attributes.color, I = g.index;
    const e = p.matrix ? p.matrix.elements : null;
    if (e) _nm.getNormalMatrix(p.matrix);
    const m = _nm.elements;
    const n = P.count;
    if (col && p.color !== undefined) _pc.set(p.color);
    const tile = p.tile || 0, offU = p.offU || 0, offV = p.offV || 0, top = p.topUV || null;
    for (let i = 0; i < n; i++) {
      let x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      let nx = N ? N.getX(i) : 0, ny = N ? N.getY(i) : 1, nz = N ? N.getZ(i) : 0;
      if (e) {
        const tx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const ty = e[1] * x + e[5] * y + e[9] * z + e[13];
        const tz = e[2] * x + e[6] * y + e[10] * z + e[14];
        x = tx; y = ty; z = tz;
        const qx = m[0] * nx + m[3] * ny + m[6] * nz;
        const qy = m[1] * nx + m[4] * ny + m[7] * nz;
        const qz = m[2] * nx + m[5] * ny + m[8] * nz;
        const l = Math.hypot(qx, qy, qz) || 1;
        nx = qx / l; ny = qy / l; nz = qz / l;
      }
      const k = (vo + i) * 3;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
      if (col) {
        if (p.color !== undefined) { col[k] = _pc.r; col[k + 1] = _pc.g; col[k + 2] = _pc.b; }
        else if (C && C.itemSize === 3) { col[k] = C.getX(i); col[k + 1] = C.getY(i); col[k + 2] = C.getZ(i); }
        else { col[k] = 1; col[k + 1] = 1; col[k + 2] = 1; }
      }
      if (uv) {
        const j = (vo + i) * 2;
        if (tile) {
          const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
          if (top && ay > 0.7) { uv[j] = top[0]; uv[j + 1] = top[1]; continue; }
          let u, v;
          if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z; v = y; } else { u = x; v = y; }
          uv[j] = u / tile + offU;
          uv[j + 1] = v / tile + offV;
        } else if (U) { uv[j] = U.getX(i); uv[j + 1] = U.getY(i); }
      }
    }
    const flip = !!(e && p.matrix.determinant() < 0);
    if (I) {
      for (let t = 0; t < I.count; t += 3) {
        const a = I.getX(t) + vo, b = I.getX(t + 1) + vo, c = I.getX(t + 2) + vo;
        idx[io++] = a;
        idx[io++] = flip ? c : b;
        idx[io++] = flip ? b : c;
      }
    } else {
      for (let t = 0; t < n; t += 3) {
        idx[io++] = vo + t;
        idx[io++] = vo + (flip ? t + 2 : t + 1);
        idx[io++] = vo + (flip ? t + 1 : t + 2);
      }
    }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** A plane (facing +z) mapped to a sub-rectangle [u0, v0, u1, v1] of a texture; cached. */
function regionPlane(w, h, r) {
  return getGeometry(`venue-rp|${w}|${h}|${r.join(',')}`, () => {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, r[0] + uv.getX(i) * (r[2] - r[0]), r[1] + uv.getY(i) * (r[3] - r[1]));
    return g;
  });
}

/** Maple: a round crown of lumpy blobs (autumn reds, oranges and golds, or summer greens). */
function mapleGeometry(autumn, lod) {
  return getGeometry(`venue-tree|maple|${autumn ? 1 : 0}|${lod ? 1 : 0}`, () => {
    const bark = 0x5a4232;
    const parts = [{ geometry: cylinderGeo(0.13, 0.22, 2.4, lod ? 5 : 7), matrix: makeMatrix(0, 1.2, 0), color: bark }];
    const pal = autumn
      ? [0xc2472c, 0xd9722f, 0xe0a13a, 0xb83a2a, 0xd88a3a, 0xc9562d]
      : [0x4d8a3b, 0x5a9844, 0x467f36, 0x69a84e, 0x518f3e, 0x5e9c47];
    const blobs = lod
      ? [[0, 3.3, 0, 1.9, 0], [0.4, 4.1, -0.3, 1.2, 2]]
      : [[0, 3.2, 0, 1.45, 0], [0.95, 2.9, 0.35, 1.05, 1], [-0.9, 3.05, -0.3, 1.1, 2],
        [0.15, 4.15, -0.1, 1.0, 3], [-0.35, 2.8, 0.9, 0.95, 4], [0.5, 3.0, -0.9, 0.95, 5]];
    blobs.forEach(([x, y, z, r, c], i) => {
      parts.push({ geometry: lumpyIco(1, lod ? 0 : 1, 60 + i), matrix: makeMatrix(x, y, z, i, [r, r * 0.9, r]), color: pal[c] });
    });
    if (!lod) parts.push({ geometry: cylinderGeo(0.05, 0.09, 1.2, 5), matrix: makeMatrix(0.35, 2.2, 0.05, 0, 1, 0, -0.7), color: bark });
    const g = mergeParts(parts);
    // cheap AO: darker under the crown
    const p = g.attributes.position, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, (p.getY(i) - 0.4) / 4.4));
      const k = 0.66 + 0.46 * t;
      c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
    }
    g.deleteAttribute('uv');
    g.computeBoundingSphere();
    return g;
  });
}

/** The scenery tree material (wind sway), fetched from its named cache (the same instance). */
function treeMaterial() {
  return getMaterial('scenery-tree', () => applyWindSway(new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.92,
  }), 0.006, 'tree'));
}

function blobMaterial() {
  return getMaterial('scenery-blob', () => new THREE.MeshBasicMaterial({
    color: 0x0b1a08, map: Textures.radialBlob(), transparent: true, opacity: 0.3,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
}

function propInstMaterial() {
  return getMaterial('scenery-prop-inst', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
}

/** Concrete (stand treads, walls) and timber (bleachers): vertex colours over a texture. */
function standConcreteMaterial() {
  return getMaterial('venue-standConcrete', () => new THREE.MeshStandardMaterial({
    vertexColors: true, map: Textures.concrete({ repeat: [1, 1] }), roughness: 0.9,
  }));
}
function standWoodMaterial() {
  return getMaterial('venue-standWood', () => new THREE.MeshStandardMaterial({
    vertexColors: true, map: Textures.wood({ repeat: [1, 1] }), roughness: 0.8,
  }));
}

// ───────────────────────────── build ─────────────────────────────

export class VenueBuild {
  /**
   * @param {object} game
   * @param {object} def    sanitized venue definition (Venues._resolve)
   * @param {{x:number,z:number}} origin
   * @param {object} [shared]  { umpire: Character, halos: THREE.Points } kept by Venues across builds
   */
  constructor(game, def, origin, shared = {}) {
    this.game = game;
    this.def = def;
    this.look = def.look;
    this.origin = { x: origin.x, z: origin.z };
    this.shared = shared;
    this.rand = seededRandom(hashU(def.id.length * 131 + def.id.charCodeAt(0), def.id.charCodeAt(def.id.length - 1)) * 1e6 + 11);
    this.low = Quality.tier === 'low';

    /** World-origin group: the court mesh (world coordinates) and the local group. */
    this.group = new THREE.Group();
    this.group.name = `Venue:${def.id}`;
    /** Venue-local group at the origin: everything but the court. */
    this.local = new THREE.Group();
    this.local.name = `VenueLocal:${def.id}`;
    this.local.position.set(origin.x, 0, origin.z);
    this.group.add(this.local);

    this._buckets = new Map();
    this._owned = { geometries: [], textures: [], materials: [], twins: [] };
    this._glow = [];            // { m, min, max }
    this._flags = [];
    this._water = null;
    this._strips = null;
    this.crowd = null;
    this.spots = { spectators: [], coach: null, benches: [], umpire: null };
    this.stands = [];
    this.seatMeshes = [];
    this.halos = [];
    this._lastLamp = -1;
    this._t = 0;
  }

  // ─────────────── palette / materials ───────────────

  _palette() {
    const L = this.look, v = this.def;
    const fence = L.fenceColor;
    const accent = L.accent ?? (v.surface === 'clay' ? 0xf4e8c1 : 0xd9a441);
    return {
      fence, accent,
      court: L.court ?? 0x2f6db3,
      surround: L.surround ?? 0x3f7d55,
      clubColor: L.clubhouse.color,
      roof: liftRoofColor(L.clubhouse.roof),
      ground: L.ground,
      seat: L.seatColor ?? shade(fence, 0.18),
      signBg: L.clubhouse.style === 'modern' || L.clubhouse.style === 'arena' ? 0x14202c : shade(fence, -0.15),
      signFg: 0xf4e8c1,
    };
  }

  _materials() {
    const pal = this.pal, own = this._owned;
    const atlas = venueAtlasTexture(this.def, pal);
    own.textures.push(atlas);
    // The windscreen band (the court's tiled screen UVs: u tiles, v 0..1) and the crowd band
    const ws = atlas.clone();
    ws.repeat.set(1, ATLAS.ws[3] / ATLAS_PX);
    ws.offset.set(0, 1 - (ATLAS.ws[1] + ATLAS.ws[3]) / ATLAS_PX);
    ws.needsUpdate = true;
    const crowd = atlas.clone();
    crowd.repeat.set(1, ATLAS.crowd[3] / ATLAS_PX);
    crowd.offset.set(0, 1 - (ATLAS.crowd[1] + ATLAS.crowd[3]) / ATLAS_PX);
    crowd.needsUpdate = true;
    own.textures.push(ws, crowd);

    const M = (params, name) => {
      const m = new THREE.MeshStandardMaterial(params);
      m.name = `venue-${name}`;
      own.materials.push(m);
      return m;
    };
    this.mats = {
      atlas: M({ map: atlas, roughness: 0.75 }, 'atlas'),
      windscreen: M({ map: ws, roughness: 0.92 }, 'windscreen'),
      flag: M({ map: atlas, side: THREE.DoubleSide, roughness: 0.9 }, 'flag'),
      strip: M({ map: crowd, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.92 }, 'crowdStrip'),
      walls: M({
        color: pal.clubColor,
        map: this.look.clubhouse.style === 'shed' || this.look.clubhouse.style === 'modern' ? Textures.stucco({ repeat: [1, 1] }) : Textures.siding({ repeat: [1, 1] }),
        roughness: 0.82,
      }, 'walls'),
      roof: M({ color: pal.roof, map: Textures.shingles({ repeat: [1, 1] }), side: THREE.DoubleSide, roughness: 0.8 }, 'roof'),
    };
    // The windscreen fades like the club's (a see-through twin on the same program)
    own.twins.push(this.mats.windscreen);
    registerOcclusionTwin(this.mats.windscreen);
  }

  _facadeMaterial(style) {
    if (this.mats.facade) return this.mats.facade;
    const seed = this.def.id.length * 17 + style.length;
    const { map, emissive } = facadeTextures(style, seed);
    this._owned.textures.push(map, emissive);
    const m = new THREE.MeshStandardMaterial({
      vertexColors: true, map, emissive: 0xffffff, emissiveMap: emissive, emissiveIntensity: 0, roughness: 0.78,
    });
    m.name = 'venue-facade';
    this._owned.materials.push(m);
    this._glow.push({ m, min: 0.02, max: style === 'tower' ? 1.25 : 0.9 });
    this.mats.facade = m;
    return m;
  }

  // ─────────────── buckets ───────────────

  /**
   * key → merged mesh on `material` (castShadow / receiveShadow). Parts: { geometry, matrix,
   * color } like mergeParts. `far` buckets are big and far away: no shadow casting.
   */
  _bucket(key, material, cast = true, receive = true) {
    let b = this._buckets.get(key);
    if (!b) { b = { material, cast, receive, parts: [] }; this._buckets.set(key, b); }
    return b.parts;
  }

  _box(key, w, h, d, x, y, z, color, ry = 0, rx = 0, rz = 0) {
    this._bucketParts(key).push({ geometry: boxGeo(w, h, d), matrix: makeMatrix(x, y, z, ry, 1, rx, rz), color });
  }

  _rbox(key, w, h, d, r, x, y, z, color, ry = 0) {
    this._bucketParts(key).push({ geometry: roundedBox(w, h, d, r), matrix: makeMatrix(x, y, z, ry), color });
  }

  _cyl(key, rt, rb, h, seg, x, y, z, color, ry = 0, rx = 0, rz = 0) {
    this._bucketParts(key).push({ geometry: cylinderGeo(rt, rb, h, seg), matrix: makeMatrix(x, y, z, ry, 1, rx, rz), color });
  }

  /** A part with world-projected UVs (textured buckets), projected when the bucket merges. */
  _tpart(key, geometry, matrix, tile, color, offU = 0, offV = 0) {
    this._bucketParts(key).push({ geometry, matrix, color, tile, offU, offV });
  }

  _tbox(key, w, h, d, x, y, z, tile, color, ry = 0, rx = 0, rz = 0) {
    this._tpart(key, boxGeo(w, h, d), makeMatrix(x, y, z, ry, 1, rx, rz), tile, color);
  }

  _bucketParts(key) {
    const b = this._buckets.get(key);
    if (b) return b.parts;
    const spec = this._bucketSpec(key);
    if (!spec) throw new Error(`VenueBuild: unknown bucket ${key}`);
    return this._bucket(key, spec[0], spec[1], true);
  }

  /** [material, castShadow] of a bucket (created on first use only). */
  _bucketSpec(key) {
    const M = this.mats;
    switch (key) {
      case 'prop': return [Mat.prop(), true];
      case 'propFar': return [Mat.prop(), false];
      case 'metal': return [Mat.metal(), true];
      case 'metalFar': return [Mat.metal(), false];
      case 'concrete': return [standConcreteMaterial(), true];
      case 'concreteFar': return [standConcreteMaterial(), false];
      case 'wood': return [standWoodMaterial(), true];
      case 'walls': return [M.walls, true];
      case 'roof': return [M.roof, true];
      case 'glass': return [Mat.glass(), false];
      case 'lamp': return [courtLampGlassMaterial(), false];
      case 'atlas': return [M.atlas, true];
      case 'facade': return [M.facade || this._facadeMaterial('apartment'), false];
      case 'hedge': return [mat(0xffffff, { map: Textures.hedge({ repeat: [1, 1] }), roughness: 0.95, wet: 0.35, name: 'hedge' }), true];
      case 'path': return [mat(COLORS.cartPathTint, { map: Textures.concrete({ joints: false, repeat: [1, 1] }), roughness: 0.9, wet: 0.8, name: 'cartPath' }), false];
      case 'pavers': return [mat(COLORS.pathEdging, { map: Textures.pavers({ repeat: [1, 1] }), roughness: 0.9, wet: 0.6, name: 'pathEdging' }), false];
      case 'asphalt': return [mat(0xffffff, { map: Textures.asphalt({ repeat: [1, 1] }), roughness: 0.92, wet: 0.8, name: 'venueAsphalt' }), false];
      default: return null;
    }
  }

  _finishBuckets() {
    const shadows = !!Quality.settings.shadows;
    for (const [key, b] of this._buckets) {
      if (!b.parts.length) continue;
      const geo = fastMerge(b.parts);
      this._owned.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, b.material);
      mesh.name = `venue-${key}`;
      mesh.castShadow = b.cast && shadows;
      mesh.userData.castDefault = b.cast;
      mesh.receiveShadow = b.receive;
      mesh.matrixAutoUpdate = false;
      if (key === 'glass' || key === 'lamp') mesh.userData.noAO = true;
      this.local.add(mesh);
      mesh.updateMatrix();
    }
    this._buckets.clear();
  }

  // ─────────────── build ───────────────

  build() {
    const t0 = performance.now();
    const steps = this.timings = {};
    let tp = t0;
    const step = (name, fn) => { fn.call(this); const t = performance.now(); steps[name] = Math.round((t - tp) * 10) / 10; tp = t; };
    this.pal = this._palette();
    step('materials', this._materials);
    this._layout();
    step('court', this._buildCourt);
    step('ground', this._buildGround);
    step('apron', this._buildApron);
    step('stands', this._buildStands);
    step('clubhouse', this._buildClubhouse);
    step('lights', this._buildLights);
    step('extras', this._buildExtras);
    step('backdrop', this._buildBackdrop);
    step('trees', this._buildTrees);
    step('flags', this._buildFlags);
    step('scoreboards', this._buildScoreboards);
    step('crowd', this._buildCrowd);
    step('merge', () => { this._finishBenches(); this._finishBuckets(); });
    this.local.traverse((o) => { if (o !== this.local && !o.userData.dynamic) { o.matrixAutoUpdate = false; o.updateMatrix(); } });
    this.local.updateMatrixWorld(true);
    this.buildMs = performance.now() - t0;
    return this;
  }

  /** Where things go (court-local): pad, fences, stands, the clubhouse footprint. */
  _layout() {
    const L = this.look, clay = this.def.surface === 'clay';
    const padX = clay ? 12 : 10;
    const benchX = clay ? 13.2 : 9.2;
    const fenceSides = L.fenceSides ?? L.fence === 'chainlink';
    const halfU = L.fence === 'hedge' ? padX + 0.6 : fenceSides ? padX + 2.4 : padX;
    // Side stands start clear of the benches / side fences
    const sideFront = Math.max(padX + 2.6, benchX + 2.4, fenceSides ? halfU + 0.8 : 0);
    const big = L.stands.rows >= 6;
    this.lay = {
      padX, benchX, halfU, fenceSides, sideFront,
      endFront: END_FRONT,
      apronX: sideFront - 0.4, apronZ: END_FRONT - 0.4,
      rowD: L.stands.style === 'bleacher' ? 0.72 : 0.85,
      rowRise: L.stands.style === 'bleacher' ? 0.36 : big ? 0.44 : 0.4,
      base: L.stands.style === 'bleacher' ? 0.18 : 0.35,
    };
  }

  // ─────────────── court ───────────────

  _buildCourt() {
    const v = this.def, L = this.look, lay = this.lay, pal = this.pal;
    const config = {
      id: `venue_${v.id}`,
      label: v.courtLabel || v.name,
      type: v.surface,
      center: { x: this.origin.x, y: 0, z: this.origin.z },
      rotation: 0,
      umpireChair: true,
    };
    const colors = {};
    if (v.surface === 'hard') {
      colors.inner = liftCourtColor(pal.court);
      colors.outer = liftCourtColor(pal.surround);
    }
    if (L.lineColor !== undefined) colors.line = L.lineColor;
    if (L.curbColor !== undefined) colors.curb = L.curbColor;
    const style = L.fence === 'hedge' ? 'hedge' : L.fence === 'windscreen' ? 'windscreen' : L.fence === 'none' ? 'none' : 'chainlink';
    this.court = new Court(this.group, this.game.physicsWorld, config, {
      colors,
      windscreenMaterial: this.mats.windscreen,
      fence: {
        style,
        halfU: lay.halfU,
        height: L.fenceHeight ?? (style === 'windscreen' ? 3.3 : style === 'hedge' ? 2.1 : 3.4),
        sides: style === 'hedge' ? true : lay.fenceSides,
        color: shade(pal.fence, -0.25),
      },
      lights: L.lights && L.rig === 'poles',
      signs: false,
      strayBalls: false,
      surfaceMaterialKey: 'venue-court-surface',
    });
    this.court.venue = v.id;
    // A tournament clay court: freshly dragged and lined (lanes up and back)
    if (this.court.isClay) this._groomClay(this.court);
  }

  _groomClay(court) {
    court.setAllDirt(0.05);
    const B = court.maskBounds;
    if (!B) return;
    const lane = 2.9;
    let dir = 1;
    for (let x = B.x0 + lane / 2; x < B.x1; x += lane * 0.94) {
      const z0 = dir > 0 ? B.z0 + 0.3 : B.z1 - 0.3, z1 = dir > 0 ? B.z1 - 0.3 : B.z0 + 0.3;
      const steps = 16;
      for (let i = 0; i < steps; i++) {
        const a = z0 + ((z1 - z0) * i) / steps, b = z0 + ((z1 - z0) * (i + 1)) / steps;
        court.groomStroke(x, a, x, b, 0, dir, 3, 0.55, 1);
      }
      dir = -dir;
    }
    court.setAllDirt(0.03);
    court.beginSession();
  }

  // ─────────────── ground ───────────────

  _buildGround() {
    const L = this.look, bd = L.backdrop, rand = this.rand;
    // Polar grid: fine rings near the court, coarser far out
    const rings = [0, 6, 12, 18, 24, 30, 38, 46, 56, 68, 82, 100, 122, 150, 185, 230, 285, 350, GROUND_R];
    const seg = 72;
    const pos = [], col = [], uv = [], idx = [];
    // the grass tile's mean colour → multiplier toward look.ground (linear)
    const tint = new THREE.Color(L.ground);
    const base = new THREE.Color(0x5b9d46);
    const kr = tint.r / base.r, kg = tint.g / base.g, kb = tint.b / base.b;
    const water = bd === 'harbor' ? this._shoreZ() : null;
    const hilly = bd === 'lawn' ? 1 : bd === 'forest' ? 0.8 : bd === 'harbor' || bd === 'night' ? 0.25 : 0.45;
    const hOpt = { octaves: 3, seed: 91 + this.def.id.length };
    const cOpt = { octaves: 3, seed: 5 };
    const heightAt = (x, z, r) => {
      if (water !== null && z < water - 0.5) return z < water - 6 ? -3.2 : -3.2 * Math.min(1, (water - 0.5 - z) / 5.5);
      const k = Math.min(1, Math.max(0, (r - 58) / 60));
      if (k <= 0) return 0;
      const n = fbm2(x * 0.018 + 17, z * 0.018 + 5, hOpt);
      let h = k * hilly * (0.6 + 7.5 * n * n);
      if (water !== null && z < water + 16) h *= Math.max(0, (z - water) / 16);
      return h;
    };
    for (let ri = 0; ri < rings.length; ri++) {
      const r = rings[ri];
      const n = ri === 0 ? 1 : seg;
      for (let s = 0; s < n; s++) {
        const a = (s / seg) * TAU;
        const x = ri === 0 ? 0 : Math.cos(a) * r, z = ri === 0 ? 0 : Math.sin(a) * r;
        const y = heightAt(x, z, r);
        pos.push(x, y, z);
        uv.push(x / 11, z / 11);
        const nz = fbm2(x * 0.022 + 100, z * 0.022 + 100, cOpt);
        let k = 0.84 + nz * 0.26;
        let cr = kr * k, cg = kg * k, cb = kb * k;
        if (water !== null && z < water) { cr = 0.55; cg = 0.5; cb = 0.4; }           // sea bed
        else if (r > 150) { const m = Math.min(1, (r - 150) / 150); cr *= 1 + 0.12 * m; cg *= 1 - 0.05 * m; }
        col.push(cr, cg, cb);
      }
    }
    // indices: centre fan, then quads between rings
    for (let s = 0; s < seg; s++) idx.push(0, 1 + ((s + 1) % seg), 1 + s);
    for (let ri = 1; ri < rings.length - 1; ri++) {
      const a0 = 1 + (ri - 1) * seg, b0 = 1 + ri * seg;
      for (let s = 0; s < seg; s++) {
        const s1 = (s + 1) % seg;
        const a = a0 + s, b = a0 + s1, c = b0 + s, d = b0 + s1;
        if (ri % 2) { idx.push(a, d, c, a, b, d); } else { idx.push(a, b, c, b, d, c); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this._owned.geometries.push(g);
    // (the club's meadow material: the same program and texture, tinted by the vertex colours)
    const m = new THREE.Mesh(g, mat(0xffffff, {
      map: Textures.grass({ repeat: [1, 1], stripes: false }), vertexColors: true, roughness: 0.95, wet: 0.45, name: 'Meadow',
    }));
    m.name = 'venue-ground';
    m.receiveShadow = true;
    this.local.add(m);
    void rand;
  }

  _shoreZ() { return -44; }

  // ─────────────── apron, paths ───────────────

  _buildApron() {
    const L = this.look, lay = this.lay;
    const key = L.apron === 'asphalt' ? 'asphalt' : L.apron === 'lawn' ? null : 'path';
    const ax = lay.apronX, az = lay.apronZ;
    if (key) {
      // the paved surround under and around the court pad (the pad sits 0.1 above it)
      this._tbox(key, 2 * ax, 0.1, 2 * az, 0, -0.02, 0, key === 'asphalt' ? 6 : 5);
      // a kerb of edging round it
      for (const sx of [-1, 1]) this._tbox('pavers', 0.35, 0.1, 2 * az + 0.35, sx * (ax + 0.17), -0.015, 0, 1.6);
      for (const sz of [-1, 1]) this._tbox('pavers', 2 * ax, 0.1, 0.35, 0, -0.015, sz * (az + 0.17), 1.6);
    }
    // a walk from the court to the clubhouse, benches and lamps along it
    const cs = L.clubhouse.side;
    const pz = cs === 'south' ? 1 : -1;
    const pathKey = L.apron === 'asphalt' ? 'asphalt' : L.apron === 'lawn' ? 'pavers' : 'path';
    const px = this.def.surface === 'clay' ? -lay.padX + 3 : -ax + 4;
    const z0 = key ? az + 0.35 : 14.6;
    const len = cs === 'north' || cs === 'south' ? 12 : 20;
    this._tbox(pathKey, 3.2, 0.1, len, px, -0.02, pz * (z0 + len / 2), pathKey === 'pavers' ? 1.6 : 5);
    for (const side of [-1, 1]) {
      this._bench(px + side * 2.6, pz * (z0 + len * 0.55), side > 0 ? -HALF_PI : HALF_PI);
      this._pathLamp(px + side * 2.2, pz * (z0 + len * 0.2));
    }
  }

  /** A teak & iron garden bench (the scenery bench, instanced with the others). */
  _bench(x, z, yaw) {
    (this._benches ||= []).push({ x, z, yaw });
  }

  /** A slim iron lamp post with a lantern (glows with the court lamp glass at dusk). */
  _pathLamp(x, z, h = 3.1) {
    this._cyl('metal', 0.05, 0.08, h, 8, x, h / 2, z, 0x222925);
    this._cyl('metal', 0.14, 0.17, 0.3, 8, x, 0.15, z, 0x222925);
    this._bucketParts('metal').push({ geometry: coneGeo(0.24, 0.2, 4), matrix: makeMatrix(x, h + 0.52, z, Math.PI / 4), color: 0x222925 });
    this._bucketParts('lamp').push({ geometry: boxGeo(0.2, 0.34, 0.2), matrix: makeMatrix(x, h + 0.25, z) });
  }

  _finishBenches() {
    const list = this._benches;
    if (!list || !list.length) return;
    const im = new THREE.InstancedMesh(benchGeometry(), propInstMaterial(), list.length);
    im.name = 'VenueBenches';
    list.forEach((b, i) => {
      _m4.makeRotationY(b.yaw).setPosition(b.x, 0, b.z);
      im.setMatrixAt(i, _m4);
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = !!Quality.settings.shadows;
    im.userData.castDefault = true;
    im.receiveShadow = true;
    im.customDepthMaterial = sharedDepthMaterial('instanced');
    im.computeBoundingSphere();
    im.userData.noMerge = true;
    this.local.add(im);
  }

  // ─────────────── stands ───────────────

  _buildStands() {
    const L = this.look, lay = this.lay;
    const rows = L.stands.rows | 0;
    if (!rows || !L.stands.sides.length) return;
    const style = L.stands.style;
    for (const side of L.stands.sides) {
      const endStand = side === 'north' || side === 'south';
      const sgn = side === 'east' || side === 'south' ? 1 : -1;
      let len = endStand ? Math.min(26, 2 * (lay.sideFront - 0.6)) : L.stands.length || (rows >= 6 ? 28 : rows >= 4 ? 22 : 13);
      if (!endStand) len = Math.min(len, 30);
      const front = endStand ? lay.endFront : lay.sideFront;
      const center = endStand ? 0 : (L.stands.offset || 0);
      const st = { side, sgn, endStand, rows, len, front, center, seats: [], rowSpots: [], strips: [] };
      if (style === 'concrete') this._concreteStand(st);
      else this._benchStand(st, style);
      this.stands.push(st);
    }
    // Seat meshes (one instanced mesh per stand, instance colours only)
    const seatMat = Stadium.seatMaterial();
    const shadows = !!Quality.settings.shadows && Quality.settings.shadowMapSize >= 2048;
    for (const st of this.stands) {
      if (!st.seats.length) continue;
      const im = new THREE.InstancedMesh(stadiumSeatGeometry(), seatMat, st.seats.length);
      im.name = `VenueSeats@${st.side}`;
      st.seats.forEach((s, i) => {
        _m4.makeRotationY(s.yaw).setPosition(s.x, s.y, s.z);
        im.setMatrixAt(i, _m4);
        im.setColorAt(i, _col.set(s.color));
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.receiveShadow = true;
      im.castShadow = shadows;
      im.customDepthMaterial = sharedDepthMaterial('instancedColor');
      im.computeBoundingSphere();
      im.userData.noMerge = true;
      this.local.add(im);
      this.seatMeshes.push(im);
    }
  }

  /** (d, a) in a stand's frame → local { x, z }: d from the court's centre line, a along the stand. */
  _standXZ(st, d, a) {
    return st.endStand ? { x: st.center + a, z: st.sgn * d } : { x: st.sgn * d, z: st.center + a };
  }

  _standYaw(st) {
    // seats face the court: east (+x) → −x, west → +x, south (+z) → −z, north → +z
    if (st.endStand) return st.sgn > 0 ? Math.PI : 0;
    return st.sgn > 0 ? -HALF_PI : HALF_PI;
  }

  /** A stand-frame box: depth dd across d0..d0+dd, along a0..a1, y0..y1. */
  _standBox(key, st, d0, dd, a0, a1, y0, y1, color, textured = 0) {
    const c = this._standXZ(st, d0 + dd / 2, (a0 + a1) / 2);
    const w = st.endStand ? a1 - a0 : dd, D = st.endStand ? dd : a1 - a0;
    if (textured) this._tbox(key, w, y1 - y0, D, c.x, (y0 + y1) / 2, c.z, textured, color);
    else this._box(key, w, y1 - y0, D, c.x, (y0 + y1) / 2, c.z, color);
  }

  _concreteStand(st) {
    const lay = this.lay, pal = this.pal, rand = this.rand;
    const D = lay.rowD, R = lay.rowRise, base = lay.base, half = st.len / 2;
    const riser = mix(pal.fence, 0x8c8a84, 0.55), tread = 0xd9d3c6, wall = 0xcfc8ba;
    const yaw = this._standYaw(st);
    const aisle = 1.2, block = 12;           // aisles between blocks of 12 seats
    const seatsPerBlock = block;
    for (let k = 0; k < st.rows; k++) {
      const d0 = st.front + k * D, top = base + k * R;
      // the row's mass from the ground to its tread, and a lighter tread cap
      this._standBox('concrete', st, d0, D, -half, half, 0, top - 0.05, riser, 3);
      this._standBox('concrete', st, d0, D, -half, half, top - 0.05, top, tread, 3);
      // seats in blocks with aisles
      const row = [];
      const n = Math.floor((st.len - 2 * aisle) / SEAT_W);
      let a = -half + aisle * 0.6;
      let inBlock = 0;
      for (let i = 0; i < n && a < half - 0.4; i++) {
        if (inBlock === seatsPerBlock) { a += aisle; inBlock = 0; if (a > half - 0.4) break; }
        const p = this._standXZ(st, d0 + D * 0.52, a + SEAT_W / 2);
        const col = k === 0 ? shade(pal.seat, -0.3) : (hashU(k * 97 + i, st.side.length) < 0.06 ? shade(pal.seat, 0.25) : pal.seat);
        st.seats.push({ x: p.x, y: top, z: p.z, yaw, color: col });
        row.push({ x: p.x, y: top + 0.475, z: p.z, yaw, a: a + SEAT_W / 2 });
        a += SEAT_W;
        inBlock++;
      }
      st.rowSpots.push(row);
      // painted crowd strip line for this row (used when the crowd outgrows the impostor budget)
      const s0 = this._standXZ(st, d0 + D * 0.52, -half + 0.3), s1 = this._standXZ(st, d0 + D * 0.52, half - 0.3);
      st.strips.push({ ax: s0.x, az: s0.z, bx: s1.x, bz: s1.z, y: top + STRIP_Y, yaw, off: rand() });
    }
    // back wall, end walls, front parapet with sponsor boards, handrails
    const dBack = st.front + st.rows * D, topY = base + (st.rows - 1) * R;
    this._standBox('concrete', st, dBack, 0.3, -half - 0.3, half + 0.3, 0, topY + 1.1, wall, 3);
    for (const sa of [-1, 1]) {
      for (let k = 0; k < st.rows; k++) {
        const d0 = st.front + k * D, top = base + k * R;
        this._standBox('concrete', st, d0, D, sa > 0 ? half : -half - 0.3, sa > 0 ? half + 0.3 : -half, 0, top + 0.95, wall, 3);
      }
    }
    this._standBox('concrete', st, st.front - 0.25, 0.25, -half, half, 0, base + 0.75, riser, 3);
    this._frontBoards(st, st.front - 0.27, base + 0.05, 0.62);
    // back rail on the wall top: posts every ~2 m, a top and a mid rail
    const railY = topY + 1.1;
    const rp = this._standXZ(st, dBack + 0.15, 0);
    for (const [y, t] of [[railY + 0.95, 0.06], [railY + 0.5, 0.04]]) {
      this._box('metal', st.endStand ? st.len + 0.6 : t, t, st.endStand ? t : st.len + 0.6, rp.x, y, rp.z, 0x2c3238);
    }
    const nPost = Math.max(2, Math.round((st.len + 0.6) / 2));
    for (let j = 0; j <= nPost; j++) {
      const q = this._standXZ(st, dBack + 0.15, -half - 0.3 + ((st.len + 0.6) * j) / nPost);
      this._box('metal', 0.05, 0.95, 0.05, q.x, railY + 0.475, q.z, 0x2c3238);
    }
  }

  /** Bleachers (aluminium planks on a metal frame), wooden benches, or a covered wooden stand. */
  _benchStand(st, style) {
    const lay = this.lay, pal = this.pal, rand = this.rand;
    const D = lay.rowD, R = lay.rowRise, base = lay.base, half = st.len / 2;
    const yaw = this._standYaw(st);
    const wood = style !== 'bleacher';
    const plankKey = wood ? 'wood' : 'metal';
    const plankCol = wood ? 0xc89868 : 0xc9ccd0;
    const frameCol = wood ? 0x6b4a2e : 0x8a9096;
    const frameKey = wood ? 'wood' : 'metal';
    for (let k = 0; k < st.rows; k++) {
      const d0 = st.front + k * D, top = base + k * R;
      // foot plank (front of the row) + seat plank (back of the row)
      if (wood) {
        this._standBox(plankKey, st, d0 + 0.02, D * 0.42, -half, half, top - 0.05, top, plankCol, 2);
        this._standBox(plankKey, st, d0 + D * 0.5, D * 0.42, -half, half, top + 0.37, top + 0.43, shade(plankCol, 0.08), 2);
      } else {
        this._standBox(plankKey, st, d0 + 0.02, D * 0.42, -half, half, top - 0.04, top, 0xa8adb2);
        this._standBox(plankKey, st, d0 + D * 0.5, D * 0.4, -half, half, top + 0.38, top + 0.42, plankCol);
      }
      const row = [];
      const n = Math.floor(st.len / SEAT_W);
      for (let i = 0; i < n; i++) {
        const a = -half + (i + 0.5) * (st.len / n);
        const p = this._standXZ(st, d0 + D * 0.7, a);
        row.push({ x: p.x, y: top + 0.42, z: p.z, yaw, a });
      }
      st.rowSpots.push(row);
      const s0 = this._standXZ(st, d0 + D * 0.72, -half + 0.2), s1 = this._standXZ(st, d0 + D * 0.72, half - 0.2);
      st.strips.push({ ax: s0.x, az: s0.z, bx: s1.x, bz: s1.z, y: top + 0.05, yaw, off: rand() });
    }
    // frame: legs under the back of each row, every ~2.2 m, plus stringers
    const nLeg = Math.max(2, Math.round(st.len / 2.2));
    for (let j = 0; j <= nLeg; j++) {
      const a = -half + 0.1 + ((st.len - 0.2) * j) / nLeg;
      for (let k = 0; k < st.rows; k++) {
        const d = st.front + k * D + D * 0.72, top = base + k * R;
        const p = this._standXZ(st, d, a);
        this._box(frameKey, 0.08, top + 0.38, 0.08, p.x, (top + 0.38) / 2, p.z, frameCol);
      }
      // sloped stringer from the front foot to the back top
      const pA = this._standXZ(st, st.front, a), pB = this._standXZ(st, st.front + st.rows * D, a);
      const rise = base + (st.rows - 1) * R + 0.4, run = st.rows * D;
      const ang = Math.atan2(rise, run);
      const mid = { x: (pA.x + pB.x) / 2, z: (pA.z + pB.z) / 2 };
      const len = Math.hypot(rise, run);
      if (st.endStand) this._box(frameKey, 0.07, 0.14, len, mid.x, rise / 2, mid.z, frameCol, 0, -st.sgn * ang);
      else this._box(frameKey, len, 0.14, 0.07, mid.x, rise / 2, mid.z, frameCol, 0, 0, st.sgn * ang);
    }
    // back guard rail
    const dBack = st.front + st.rows * D + 0.05, topY = base + (st.rows - 1) * R;
    for (const [y, t] of [[topY + 1.3, 0.05], [topY + 0.85, 0.04]]) {
      const p = this._standXZ(st, dBack, 0);
      this._box('metal', st.endStand ? st.len : t, t, st.endStand ? t : st.len, p.x, y, p.z, 0x5c646b);
    }
    for (let j = 0; j <= nLeg; j++) {
      const a = -half + 0.1 + ((st.len - 0.2) * j) / nLeg;
      const p = this._standXZ(st, dBack, a);
      this._box('metal', 0.05, 1.3 + topY, 0.05, p.x, (1.3 + topY) / 2, p.z, 0x5c646b);
    }
    // (never over an end stand: the tennis camera sits right above it at either end — a roof
    // there would hide the court)
    if (style === 'covered' && !st.endStand) this._standRoof(st, dBack, topY);
    // front: boards on low posts
    this._frontBoards(st, st.front - 0.35, 0.12, 0.55);
  }

  /** A covered stand's roof: columns at the back and front, a pitched roof sloping to the back. */
  _standRoof(st, dBack, topY) {
    const lay = this.lay, half = st.len / 2 + 0.4;
    const front = st.front - 0.4, back = dBack + 0.3;
    const hF = topY + 3.4, hB = topY + 2.6;
    const cols = Math.max(2, Math.round(st.len / 4.5));
    for (let j = 0; j <= cols; j++) {
      const a = -half + 0.3 + ((2 * half - 0.6) * j) / cols;
      for (const [d, h] of [[front + 0.2, hF], [back - 0.2, hB]]) {
        const p = this._standXZ(st, d, a);
        this._box('prop', 0.16, h, 0.16, p.x, h / 2, p.z, 0xf2eee3);
      }
    }
    // roof slab: slope from front (high) to back (low)
    const run = back - front, drop = hF - hB;
    const ang = Math.atan2(drop, run), L = Math.hypot(run, drop) + 0.8;
    const mid = this._standXZ(st, (front + back) / 2, 0);
    const y = (hF + hB) / 2 + 0.12;
    if (st.endStand) this._tpart('roof', boxGeo(2 * half + 0.6, 0.14, L), makeMatrix(mid.x, y, mid.z, 0, 1, st.sgn * ang), 2.5);
    else this._tpart('roof', boxGeo(L, 0.14, 2 * half + 0.6), makeMatrix(mid.x, y, mid.z, 0, 1, 0, -st.sgn * ang), 2.5);
    // fascia with the club's name sign, facing the court
    const fp = this._standXZ(st, front - 0.35, 0);
    this._box('prop', st.endStand ? 2 * half + 0.6 : 0.12, 0.55, st.endStand ? 0.12 : 2 * half + 0.6, fp.x, hF - 0.05, fp.z, 0xf2eee3);
    const signW = Math.min(9, st.len * 0.55);
    const sp = this._standXZ(st, front - 0.43, 0);
    this._bucketParts('atlas').push({
      geometry: regionPlane(signW, signW / 8, atlasUV('sign')),
      matrix: makeMatrix(sp.x, hF - 0.05, sp.z, this._standYaw(st)),
    });
    void lay;
  }

  /** Sponsor boards along a stand's front (atlas boards), facing the court. */
  _frontBoards(st, d, y0, h) {
    const w = h * 2;
    const n = Math.max(1, Math.floor((st.len - 0.4) / (w + 0.08)));
    const yaw = this._standYaw(st);
    const span = n * (w + 0.08);
    for (let i = 0; i < n; i++) {
      const a = -span / 2 + (i + 0.5) * (w + 0.08);
      const p = this._standXZ(st, d, a);
      const bi = (i + st.side.length) % 8;
      this._bucketParts('atlas').push({
        geometry: regionPlane(w, h, atlasUV(bi < 4 ? 'boardA' : 'boardB', bi % 4)),
        matrix: makeMatrix(p.x, y0 + h / 2, p.z, yaw),
      });
    }
  }

  // ─────────────── crowd ───────────────

  _buildCrowd() {
    const L = this.look;
    if (!this.stands.length) return;
    // coach + spectator spots: front row seats near the net (the coach in the east stand, the
    // player's half). Only the coach's seat is taken out of the crowd; the spectator spots stay
    // in it (nobody else sits there during a match: empty seats by the net looked odd)
    const reserved = new Set();
    const front = [];
    for (const st of this.stands) {
      const row = st.rowSpots[0] || [];
      for (const s of row) front.push({ st, s });
    }
    const east = front.filter(f => f.st.side === 'east').sort((p, q) => Math.abs(p.s.a - 5) - Math.abs(q.s.a - 5));
    if (east.length) {
      const c = east[0].s;
      this.spots.coach = { x: c.x, y: c.y, z: c.z, yaw: c.yaw, seated: true };
      reserved.add(c);
    }
    front.sort((p, q) => Math.abs(p.s.a) + (p.st.endStand ? 8 : 0) - (Math.abs(q.s.a) + (q.st.endStand ? 8 : 0)));
    for (const f of front) {
      if (reserved.has(f.s) || this.spots.spectators.length >= 16) continue;
      if (hashU(Math.round(f.s.a * 10), f.st.side.length) < 0.3) continue;   // spread them out
      this.spots.spectators.push({ x: f.s.x, y: f.s.y, z: f.s.z, yaw: f.s.yaw, seated: true });
    }
    // impostor spots, row-major (front rows first, a few gaps), then the strip rows
    const spots = [];
    const maxRows = Math.max(...this.stands.map(s => s.rowSpots.length));
    this._rowStarts = [];
    for (let k = 0; k < maxRows; k++) {
      this._rowStarts.push(spots.length);
      for (const st of this.stands) {
        const row = st.rowSpots[k];
        if (!row) continue;
        for (let i = 0; i < row.length; i++) {
          const s = row[i];
          if (reserved.has(s)) continue;
          if (hashU(k * 131 + i, st.side.length * 7 + 3) < 0.08) continue;   // an empty seat
          spots.push(s);
        }
      }
    }
    this._rowStarts.push(spots.length);
    this.crowd = new CrowdImpostors(this.local, spots, {
      material: Stadium.seatMaterial(), name: 'VenueCrowd', seed: this.def.id.length * 31,
      shirts: [0xf4efe6, 0xe9dfc6, 0x2f3e5c, 0x8fae8b, 0x9cc3e0, 0xe8b4b8, 0xd9a441, this.pal.fence, this.pal.accent, 0xc23b4e, 0xffffff],
    });
    this._crowdRows = maxRows;
    // painted strips for the rows past the impostor budget
    this._buildStrips();
    this.setCrowd(L.crowd, true);
  }

  _buildStrips() {
    const quads = [];
    const maxRows = this._crowdRows;
    for (let k = 0; k < maxRows; k++) {
      for (const st of this.stands) {
        const s = st.strips[k];
        if (s) quads.push({ ...s, row: k });
      }
    }
    if (!quads.length) return;
    const pos = new Float32Array(quads.length * 4 * 3), uv = new Float32Array(quads.length * 4 * 2);
    const nor = new Float32Array(quads.length * 4 * 3), idx = [];
    this._stripRowEnd = [];
    quads.forEach((q, i) => {
      const len = Math.hypot(q.bx - q.ax, q.bz - q.az);
      const u0 = q.off, u1 = q.off + len / CROWD_TILE_M;
      const nx = Math.sin(q.yaw), nz = Math.cos(q.yaw);
      const P = [[q.ax, q.y, q.az, u0, 0], [q.bx, q.y, q.bz, u1, 0], [q.bx, q.y + STRIP_H, q.bz, u1, 1], [q.ax, q.y + STRIP_H, q.az, u0, 1]];
      P.forEach((p, j) => {
        pos.set([p[0], p[1], p[2]], (i * 4 + j) * 3);
        uv.set([p[3], p[4]], (i * 4 + j) * 2);
        nor.set([nx, 0, nz], (i * 4 + j) * 3);
      });
      const b = i * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      this._stripRowEnd[q.row] = (i + 1) * 6;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this._owned.geometries.push(g);
    const mesh = new THREE.Mesh(g, this.mats.strip);
    mesh.name = 'VenueCrowdStrips';
    mesh.receiveShadow = true;
    mesh.userData.noAO = true;
    mesh.visible = false;
    this.local.add(mesh);
    this._strips = { mesh, quads };
  }

  /** Crowd: frac (0..1) of every stand's rows, front first; impostors to the tier's budget, strips behind. */
  setCrowd(frac, instant = false) {
    if (!this.crowd) return;
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    this._crowdFrac = f;
    const budget = Quality.tier === 'low' ? 160 : Quality.tier === 'high' ? 900 : 480;
    const rowsWanted = f > 0 ? Math.max(1, Math.round(f * this._crowdRows)) : 0;
    let impRows = 0;
    while (impRows < rowsWanted && this._rowStarts[impRows + 1] <= budget) impRows++;
    let n = this._rowStarts[impRows];
    if (impRows < rowsWanted && impRows === 0) n = Math.min(budget, this._rowStarts[1]);   // a thin crowd: part of the front row
    if (f > 0 && f < 1 && impRows === rowsWanted) {
      // a partly filled stand: thin out the last impostor row by the leftover fraction
      const exact = f * this._crowdRows, whole = Math.floor(exact);
      if (whole < rowsWanted && whole >= 0) {
        const a = this._rowStarts[whole], b = this._rowStarts[whole + 1] ?? a;
        n = Math.min(n, a + Math.round((b - a) * Math.max(0.35, exact - whole)));
      }
    }
    this.crowd.target = Math.min(this.crowd.capacity, n);
    if (instant) this.crowd.setCount(this.crowd.target);
    if (this._strips) {
      const firstStrip = impRows + (n > this._rowStarts[impRows] ? 1 : 0);
      let start = 0, end = 0;
      if (rowsWanted > firstStrip) {
        start = firstStrip > 0 ? this._stripRowEnd[firstStrip - 1] || 0 : 0;
        end = this._stripRowEnd[rowsWanted - 1] || start;
      }
      const g = this._strips.mesh.geometry;
      g.setDrawRange(start, Math.max(0, end - start));
      this._strips.mesh.visible = end > start;
    }
  }

  // ─────────────── clubhouse ───────────────

  _buildClubhouse() {
    const ch = this.look.clubhouse;
    const fn = {
      shed: this._shed, lodge: this._lodge, boathouse: this._boathouse, pavilion: this._pavilion,
      modern: this._modern, arena: this._arena,
    }[ch.style] || this._lodge;
    fn.call(this, ch);
  }

  /** Clubhouse frame: centred at (x, z), its front toward the court (width: its footprint across, roof included). */
  _clubFrame(ch, depth, xOff = 0, width = 0) {
    const side = ch.side || 'north';
    const lay = this.lay;
    const gap = ch.gap ?? 11;
    let x = xOff, z = 0, yaw = 0;
    if (side === 'north') { z = -(FENCE_Z + gap + depth / 2); yaw = 0; }
    else if (side === 'south') { z = FENCE_Z + gap + depth / 2; yaw = Math.PI; }
    else {
      const standD = this.look.stands.sides.includes(side) ? this.look.stands.rows * lay.rowD + 4 : 6;
      x = (side === 'east' ? 1 : -1) * (lay.sideFront + standD + depth / 2);
      z = xOff;
      yaw = side === 'east' ? -HALF_PI : HALF_PI;
    }
    const base = makeMatrix(x, 0, z, yaw);
    this._club = { x, z, yaw, depth, width };
    return (lx, ly, lz, ry = 0, s = 1, rx = 0, rz = 0) => base.clone().multiply(makeMatrix(lx, ly, lz, ry, s, rx, rz));
  }

  _wallBox(F, w, h, d, x, y, z, tile = 3) {
    this._tpart('walls', boxGeo(w, h, d), F(x, y, z), tile);
  }

  _window(F, w, h, x, y, z, ry = 0, trim = 0xf7f3ea, variant = 0) {
    this._bucketParts('glass').push({ geometry: glassPane(w, h, variant), matrix: F(x, y, z + 0.03 * Math.cos(ry), ry) });
    const T = 0.08;
    for (const [dx, dy, ww, hh] of [[0, h / 2 + T / 2, w + 2 * T, T], [0, -h / 2 - T / 2, w + 2 * T + 0.1, T * 1.4], [-w / 2 - T / 2, 0, T, h], [w / 2 + T / 2, 0, T, h]]) {
      this._bucketParts('prop').push({ geometry: boxGeo(ww, hh, 0.08), matrix: F(x + dx * Math.cos(ry), y + dy, z - dx * Math.sin(ry), ry), color: trim });
    }
  }

  /** Gable roof over a W × D footprint (ridge along local x), eaves at y0, rise; overhang oh. */
  _gableRoof(F, W, D, y0, rise, oh = 0.5, ridgeCol = 0x3a4148) {
    const half = D / 2 + oh, ang = Math.atan2(rise, D / 2), slope = Math.hypot(half, rise * (half / (D / 2)));
    for (const sz of [-1, 1]) {
      const mz = sz * half / 2, my = y0 + rise - (rise * (half / (D / 2))) / 2;
      this._tpart('roof', boxGeo(W + 2 * oh, 0.16, slope), F(0, my, mz, 0, 1, sz * ang), 2.5);
    }
    this._bucketParts('prop').push({ geometry: boxGeo(W + 2 * oh + 0.1, 0.18, 0.3), matrix: F(0, y0 + rise + 0.05, 0), color: ridgeCol });
    // gable ends (walls material)
    for (const sx of [-1, 1]) {
      const g = prismGeo(D / 2, rise, 0.25).clone();
      g.translate(0, 0, -0.125);
      this._tpart('walls', g, F(sx * (W / 2 - 0.12), y0, 0, HALF_PI), 3);
    }
  }

  _shed(ch) {
    const W = 10, D = 5.6, H = 3.2;
    const F = this._clubFrame(ch, D, -12, W + 1);
    this._wallBox(F, W, H, D, 0, H / 2, 0, 2.4);
    // flat roof with an overhang + fascia
    this._bucketParts('prop').push({ geometry: boxGeo(W + 1.2, 0.22, D + 1.6), matrix: F(0, H + 0.11, 0.3), color: 0x4a4f55 });
    this._bucketParts('prop').push({ geometry: boxGeo(W + 1.25, 0.3, 0.08), matrix: F(0, H + 0.08, D / 2 + 1.12), color: 0x2e3338 });
    // two doors (restrooms) with small signs, a window strip, a vending machine, a fountain
    for (const [x, c] of [[-2.6, 0x2f6db3], [2.6, 0xc23b4e]]) {
      this._bucketParts('prop').push({ geometry: boxGeo(1.0, 2.1, 0.08), matrix: F(x, 1.05, D / 2 + 0.03), color: 0x6b7278 });
      this._bucketParts('prop').push({ geometry: boxGeo(0.4, 0.4, 0.04), matrix: F(x, 2.45, D / 2 + 0.05), color: c });
    }
    this._window(F, 2.4, 0.7, 0, 2.2, D / 2, 0, 0xdfe3e6, 1);
    this._bucketParts('prop').push({ geometry: roundedBox(0.95, 1.9, 0.8, 0.05), matrix: F(W / 2 + 0.7, 0.95, 1.2), color: 0xc23b4e });
    this._bucketParts('lamp').push({ geometry: boxGeo(0.62, 1.0, 0.04), matrix: F(W / 2 + 0.7, 1.15, 1.62) });
    this._bucketParts('metal').push({ geometry: cylinderGeo(0.14, 0.18, 0.95, 10), matrix: F(-W / 2 - 0.6, 0.47, 1.6), color: 0x9aa3a8 });
    // name board on the roof edge
    this._bucketParts('atlas').push({ geometry: regionPlane(7.2, 0.9, atlasUV('sign')), matrix: F(0, H + 0.62, D / 2 + 0.95) });
    this._bucketParts('prop').push({ geometry: boxGeo(7.4, 1.05, 0.1), matrix: F(0, H + 0.62, D / 2 + 0.88), color: 0x2e3338 });
    // bike rack + trash cans + picnic tables
    for (let i = 0; i < 5; i++) {
      this._bucketParts('metal').push({ geometry: getGeometry('venue-bikeHoop', () => new THREE.TorusGeometry(0.38, 0.03, 5, 12, Math.PI)), matrix: F(-W / 2 + 0.8 + i * 0.7, 0.02, D / 2 + 3.2, HALF_PI), color: 0x3a4148 });
    }
    for (const x of [-6.2, 6.4]) this._bucketParts('prop').push({ geometry: cylinderGeo(0.3, 0.28, 0.95, 10), matrix: F(x, 0.47, D / 2 + 1.5), color: 0x2d5a3d });
    for (const [x, z] of [[8.5, 5.5], [-8.5, 6.5]]) this._picnicTable(F, x, z);
  }

  _picnicTable(F, x, z) {
    const wood = 0x9c6b3c;
    this._bucketParts('prop').push({ geometry: boxGeo(1.8, 0.06, 0.8), matrix: F(x, 0.75, z), color: wood });
    for (const sz of [-0.62, 0.62]) this._bucketParts('prop').push({ geometry: boxGeo(1.8, 0.05, 0.3), matrix: F(x, 0.45, z + sz), color: wood });
    for (const sx of [-0.7, 0.7]) {
      this._bucketParts('prop').push({ geometry: boxGeo(0.06, 0.75, 1.5), matrix: F(x + sx, 0.37, z), color: 0x5a4232 });
    }
  }

  _lodge(ch) {
    const W = 18, D = 10, H = 4.2;
    const F = this._clubFrame(ch, D + 3, 0, W + 1);
    const trim = 0xf7f3ea, green = this.pal.roof;
    this._wallBox(F, W, H, D, 0, H / 2, -1.2, 3);
    // stone plinth
    this._bucketParts('prop').push({ geometry: boxGeo(W + 0.1, 0.5, D + 0.1), matrix: F(0, 0.25, -1.2), color: 0x8f8579 });
    this._gableRoof(Fz(F, -1.2), W, D, H, 3.2, 0.6, shade(green, -0.35));
    // porch across the front: deck, posts, a shallow roof, railing
    const pz = D / 2 - 1.2 + 1.3;
    this._tpart('wood', boxGeo(W - 1, 0.3, 2.6), F(0, 0.15, pz), 2, 0xc89868);
    for (let i = 0; i <= 6; i++) {
      const x = -W / 2 + 1 + (i * (W - 2)) / 6;
      this._bucketParts('prop').push({ geometry: boxGeo(0.2, 2.9, 0.2), matrix: F(x, 1.75, pz + 1.15), color: trim });
    }
    this._tpart('roof', boxGeo(W - 0.4, 0.14, 3.2), F(0, 3.35, pz + 0.1, 0, 1, 0.16), 2.5);
    for (const x of [-W / 2 + 1, W / 2 - 1]) this._bucketParts('prop').push({ geometry: boxGeo(0.06, 0.06, 2.4), matrix: F(x, 0.95, pz), color: trim });
    this._bucketParts('prop').push({ geometry: boxGeo(W - 2, 0.07, 0.07), matrix: F(0, 0.95, pz + 1.15), color: trim });
    // windows + door
    for (const x of [-7, -4.4, 4.4, 7]) this._window(F, 1.3, 1.6, x, 2.1, D / 2 - 1.2, 0, trim, 0);
    this._bucketParts('prop').push({ geometry: boxGeo(1.4, 2.4, 0.1), matrix: F(0, 1.5, D / 2 - 1.15), color: shade(green, -0.2) });
    this._window(F, 0.9, 0.9, 0, 2.2, D / 2 - 1.08, 0, trim, 2);
    // stone chimney
    this._bucketParts('prop').push({ geometry: boxGeo(1.3, 9.2, 1.3), matrix: F(W / 2 - 1.6, 4.6, -2.8), color: 0x8f8579 });
    this._bucketParts('prop').push({ geometry: boxGeo(1.5, 0.2, 1.5), matrix: F(W / 2 - 1.6, 9.25, -2.8), color: 0x6f675e });
    // dormers on the front slope
    for (const x of [-4.5, 4.5]) {
      this._wallBox(F, 1.8, 1.4, 1.6, x, H + 1.1, D / 2 - 1.2 - 1.9, 2);
      this._window(F, 0.9, 0.8, x, H + 1.1, D / 2 - 1.2 - 1.08, 0, trim, 3);
      this._tpart('roof', prismGeo(1.1, 0.7, 1.8), F(x, H + 1.8, D / 2 - 1.2 - 2.7), 2.5);
    }
    // name board on the porch roof
    this._bucketParts('atlas').push({ geometry: regionPlane(8, 1, atlasUV('sign')), matrix: F(0, 4.15, pz + 1.72, 0, 1, -0.08) });
    // terrace: tables with parasols
    for (const x of [-12.5, 12.5]) this._parasolTable(F, x, pz + 2.5, x < 0 ? 0xc23b4e : 0x2d5a3d);
  }

  _parasolTable(F, x, z, canopy) {
    this._bucketParts('prop').push({ geometry: cylinderGeo(0.5, 0.5, 0.05, 16), matrix: F(x, 0.74, z), color: 0xf2eee3 });
    this._bucketParts('metal').push({ geometry: cylinderGeo(0.03, 0.03, 2.3, 6), matrix: F(x, 1.15, z), color: 0x3a3f3a });
    this._bucketParts('prop').push({ geometry: coneGeo(1.35, 0.55, 10), matrix: F(x, 2.35, z), color: canopy });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      this._bucketParts('prop').push({ geometry: boxGeo(0.42, 0.44, 0.42), matrix: F(x + Math.cos(a) * 0.85, 0.22, z + Math.sin(a) * 0.85), color: 0xe9e4d8 });
    }
  }

  _boathouse(ch) {
    const W = 14, D = 11, H = 5;
    // on the quay: its boat doors open onto the water (the shore is at z −44)
    const F = this._clubFrame({ ...ch, gap: -(this._shoreZ() + D / 2) - FENCE_Z - (D + 2) / 2 }, D + 2, -19, W + 1);
    const trim = 0xf7f3ea;
    this._wallBox(F, W, H, D, 0, H / 2, 0, 3);
    this._bucketParts('prop').push({ geometry: boxGeo(W + 0.1, 0.45, D + 0.1), matrix: F(0, 0.22, 0), color: 0x7e776e });
    // steep gable facing the court: ridge along local z (rotate the roof frame)
    const G = (x, y, z, ry = 0, s = 1, rx = 0, rz = 0) => F(0, 0, 0, HALF_PI).multiply(makeMatrix(x, y, z, ry, s, rx, rz));
    this._gableRoof(G, D, W, H, 4.4, 0.55, 0x2a333d);
    // big doors on both gable ends, a loft door, windows
    for (const sz of [-1, 1]) {
      this._bucketParts('prop').push({ geometry: boxGeo(4.2, 3.6, 0.1), matrix: F(0, 1.8 + 0.45, sz * (D / 2 + 0.04)), color: 0x3b4a5a });
      for (let i = 0; i < 4; i++) this._bucketParts('prop').push({ geometry: boxGeo(0.08, 3.6, 0.06), matrix: F(-1.6 + i * 1.07, 2.25, sz * (D / 2 + 0.1)), color: trim });
      this._window(F, 1.2, 1.0, 0, H + 1.4, sz * (D / 2), sz > 0 ? 0 : Math.PI, trim, 1);
    }
    for (const x of [-W / 2, W / 2]) {
      for (const z of [-2.5, 2.5]) this._window(F, 1.2, 1.4, x, 2.6, z, x > 0 ? HALF_PI : -HALF_PI, trim, 0);
    }
    // cupola + weathervane
    this._bucketParts('prop').push({ geometry: boxGeo(1.4, 1.2, 1.4), matrix: F(0, H + 4.4 + 0.5, 0), color: trim });
    this._bucketParts('prop').push({ geometry: coneGeo(1.2, 1.1, 4), matrix: F(0, H + 4.4 + 1.65, 0, Math.PI / 4), color: 0x2a333d });
    this._bucketParts('metal').push({ geometry: cylinderGeo(0.025, 0.025, 1.4, 6), matrix: F(0, H + 4.4 + 2.8, 0), color: 0x7a6a3a });
    this._bucketParts('metal').push({ geometry: boxGeo(0.9, 0.18, 0.03), matrix: F(0.1, H + 4.4 + 3.3, 0), color: 0x7a6a3a });
    // name board on the court gable
    this._bucketParts('atlas').push({ geometry: regionPlane(8, 1, atlasUV('sign')), matrix: F(0, H + 0.55, D / 2 + 0.08) });
    // deck on the court side with a railing
    this._tpart('wood', boxGeo(W + 2, 0.3, 3.2), F(0, 0.15, D / 2 + 1.6), 2, 0xa98a66);
    this._bucketParts('prop').push({ geometry: boxGeo(W + 2, 0.07, 0.07), matrix: F(0, 1.0, D / 2 + 3.15), color: trim });
    for (let i = 0; i <= 8; i++) this._bucketParts('prop').push({ geometry: boxGeo(0.07, 0.95, 0.07), matrix: F(-W / 2 - 1 + i * (W + 2) / 8, 0.5, D / 2 + 3.15), color: trim });
  }

  _pavilion(ch) {
    const W = 22, D = 9, H1 = 3.6, H2 = 7;
    const F = this._clubFrame(ch, D + 3, 0, W + 1.2);
    const trim = 0xf7f3ea, green = this.pal.roof;
    this._wallBox(F, W, H2, D, 0, H2 / 2, -1, 3);
    this._bucketParts('prop').push({ geometry: boxGeo(W + 0.1, 0.45, D + 0.1), matrix: F(0, 0.22, -1), color: 0xb5ab9a });
    this._gableRoof(Fz(F, -1), W, D, H2, 2.6, 0.55, shade(green, -0.35));
    // central clock gable projecting forward
    const cz = D / 2 - 1 + 0.9;
    this._wallBox(F, 6, H2 + 1.2, 1.8, 0, (H2 + 1.2) / 2, cz - 0.9, 3);
    const gF = (x, y, z, ry = 0, s = 1, rx = 0, rz = 0) => F(0, 0, cz - 0.9).multiply(makeMatrix(x, y, z, ry, s, rx, rz));
    const g = prismGeo(3.4, 2.2, 1.8).clone();
    this._tpart('walls', g, gF(0, H2 + 1.2, -0.9), 3);
    for (const sx of [-1, 1]) {
      const ang = Math.atan2(2.2, 3.4), len = Math.hypot(2.2, 3.4) + 0.3;
      this._tpart('roof', boxGeo(len, 0.14, 3.0), gF(sx * 1.7, H2 + 1.2 + 1.1 + 0.08, 0, 0, 1, 0, -sx * ang), 2.5);
    }
    // clock face in the gable
    const clockY = H2 + 1.95, clockZ = cz + 0.02;
    this._bucketParts('prop').push({ geometry: cylinderGeo(0.78, 0.78, 0.08, 28), matrix: F(0, clockY, clockZ, 0, 1, HALF_PI), color: 0x2a3a30 });
    this._bucketParts('prop').push({ geometry: cylinderGeo(0.66, 0.66, 0.1, 28), matrix: F(0, clockY, clockZ + 0.02, 0, 1, HALF_PI), color: 0xf6f2e6 });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      this._bucketParts('prop').push({ geometry: boxGeo(0.05, i % 3 === 0 ? 0.16 : 0.09, 0.03), matrix: F(Math.sin(a) * 0.56, clockY + Math.cos(a) * 0.56, clockZ + 0.08, 0, 1, 0, -a), color: 0x1a1a1a });
    }
    this._bucketParts('prop').push({ geometry: boxGeo(0.06, 0.42, 0.03), matrix: F(0.1, clockY + 0.18, clockZ + 0.1, 0, 1, 0, -0.5), color: 0x1a1a1a });
    this._bucketParts('prop').push({ geometry: boxGeo(0.05, 0.56, 0.03), matrix: F(-0.2, clockY + 0.05, clockZ + 0.11, 0, 1, 0, 1.9), color: 0x1a1a1a });
    // verandah + balcony
    const vz = D / 2 - 1 + 1.4;
    this._tpart('wood', boxGeo(W, 0.25, 2.8), F(0, 0.12, vz), 2, 0xb99a74);
    for (let i = 0; i <= 8; i++) {
      const x = -W / 2 + 0.4 + (i * (W - 0.8)) / 8;
      this._bucketParts('prop').push({ geometry: boxGeo(0.2, H1 - 0.2, 0.2), matrix: F(x, H1 / 2, vz + 1.25), color: trim });
      if (i < 8) this._flowerBasket(F, x + (W - 0.8) / 16, H1 - 0.7, vz + 1.25);
    }
    this._bucketParts('prop').push({ geometry: boxGeo(W + 0.2, 0.2, 3.0), matrix: F(0, H1, vz), color: trim });
    this._bucketParts('prop').push({ geometry: boxGeo(W, 0.07, 0.07), matrix: F(0, H1 + 1.0, vz + 1.4), color: trim });
    for (let i = 0; i <= 24; i++) this._bucketParts('prop').push({ geometry: boxGeo(0.05, 0.9, 0.05), matrix: F(-W / 2 + i * W / 24, H1 + 0.55, vz + 1.4), color: trim });
    // windows, both floors
    for (const x of [-9, -6, 6, 9]) {
      this._window(F, 1.5, 1.8, x, 1.6, D / 2 - 1, 0, trim, 0);
      this._window(F, 1.3, 1.6, x, 5.3, D / 2 - 1, 0, trim, 1);
    }
    this._bucketParts('prop').push({ geometry: boxGeo(2.2, 2.6, 0.08), matrix: F(0, 1.3, cz + 0.02), color: shade(green, -0.25) });
    this._window(F, 1.6, 1.6, 0, 5.2, cz, 0, trim, 2);
    // name board under the clock
    this._bucketParts('atlas').push({ geometry: regionPlane(5.6, 0.7, atlasUV('sign')), matrix: F(0, H2 - 0.3, cz + 0.04) });
  }

  _flowerBasket(F, x, y, z) {
    this._bucketParts('prop').push({ geometry: lumpyIco(0.3, 0, 71), matrix: F(x, y, z), color: 0x3f7a35 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      this._bucketParts('prop').push({ geometry: sphereGeo(0.09, 6, 4), matrix: F(x + Math.cos(a) * 0.22, y + 0.08, z + Math.sin(a) * 0.22), color: [0xe25c7a, 0xf2c14e, 0xf4efe6, 0xc23b4e, 0x9b6fd1][i] });
    }
  }

  _modern(ch) {
    const W = 30, D = 13, H = 8.4;
    const F = this._clubFrame({ ...ch, gap: 21 }, D, 0, W + 4);
    this._facadeMaterial('campus');
    // white volume with a glazed front (facade), a cantilevered roof slab, columns
    this._wallBox(F, W, H, D, 0, H / 2, 0, 3);
    this._facadeBox(F, W - 1.2, H - 0.8, 0.2, 0, (H - 0.8) / 2 + 0.2, D / 2 + 0.05, 0xf4f4f0, 3);
    this._bucketParts('prop').push({ geometry: boxGeo(W + 4, 0.45, D + 4.5), matrix: F(0, H + 0.22, 1.2), color: 0xf2f2ee });
    this._bucketParts('metal').push({ geometry: boxGeo(W + 4.05, 0.5, 0.12), matrix: F(0, H + 0.22, D / 2 + 3.46), color: 0x2d3b40 });
    for (let i = 0; i < 6; i++) this._bucketParts('metal').push({ geometry: cylinderGeo(0.14, 0.14, H, 10), matrix: F(-W / 2 + 1 + i * (W - 2) / 5, H / 2, D / 2 + 3.1), color: 0xdfe3e6 });
    // name letters on the fascia (the sign region)
    this._bucketParts('atlas').push({ geometry: regionPlane(14, 1.75, atlasUV('sign')), matrix: F(0, H + 1.15, D / 2 + 3.4) });
    this._bucketParts('prop').push({ geometry: boxGeo(14.3, 1.95, 0.1), matrix: F(0, H + 1.15, D / 2 + 3.33), color: 0x14202c });
    // solar panels on the roof
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 2; j++) {
        this._bucketParts('prop').push({ geometry: boxGeo(3.6, 0.08, 1.8), matrix: F(-10 + i * 5, H + 0.75, -3 + j * 2.4, 0, 1, -0.3), color: 0x20304a });
      }
    }
    // entrance canopy + planters
    this._bucketParts('prop').push({ geometry: boxGeo(6, 0.25, 3), matrix: F(0, 3.2, D / 2 + 1.5), color: 0xf2f2ee });
    for (const x of [-6, 6]) this._bucketParts('prop').push({ geometry: boxGeo(2.2, 0.8, 1.2), matrix: F(x, 0.4, D / 2 + 4.5), color: 0x9a9690 });
  }

  /** A facade-textured box (city / campus blocks): u along the face, v up, one tile = 12 m. */
  _facadeBox(F, w, h, d, x, y, z, color, offCells = 0) {
    // top faces: a plain wall patch of the tile (no windows on the roof)
    this._bucketParts('facade').push({
      geometry: boxGeo(w, h, d), matrix: F(x, y, z), color, tile: FACADE_TILE_M,
      offU: offCells * 0.25, offV: -(y - h / 2) / FACADE_TILE_M, topUV: FACADE_TOP_UV,
    });
  }

  _arena() {
    // The stands are the arena (all four sides): roofs over the side stands with lamp rows along
    // their front edges, tall corner towers, the name band on the far stand, video boards
    const lay = this.lay, D = lay.rowD, R = lay.rowRise;
    const rows = this.look.stands.rows;
    const topY = lay.base + (rows - 1) * R;
    for (const st of this.stands) {
      if (st.endStand) continue;
      const dF = st.front + D * 2, dB = st.front + rows * D + 0.4;
      const hF = topY + 5.2, hB = topY + 3.6;
      const half = st.len / 2 + 0.6;
      const cols = 5;
      for (let j = 0; j <= cols; j++) {
        const a = -half + (2 * half * j) / cols;
        const p = this._standXZ(st, dB, a);
        this._box('metalFar', 0.35, hB + 0.4, 0.35, p.x, (hB + 0.4) / 2, p.z, 0x1c2230);
        // cantilever truss arm out to the front edge
        const q = this._standXZ(st, (dF + dB) / 2, a);
        const run = dB - dF, drop = hF - hB;
        this._box('metalFar', run + 0.4, 0.35, 0.25, q.x, (hF + hB) / 2 + 0.3, q.z, 0x1c2230, 0, 0, -st.sgn * Math.atan2(drop, run));
      }
      // roof panels
      const mid = this._standXZ(st, (dF + dB) / 2, 0);
      const ang = Math.atan2(hF - hB, dB - dF), len = Math.hypot(dB - dF, hF - hB) + 0.4;
      this._box('metalFar', len, 0.2, 2 * half, mid.x, (hF + hB) / 2 + 0.55, mid.z, 0x2a3040, 0, 0, -st.sgn * ang);
      // lamp row along the front edge, aimed at the court
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a = -half + 1 + ((2 * half - 2) * i) / (n - 1);
        const p = this._standXZ(st, dF - 0.1, a);
        const yawIn = this._standYaw(st);
        this._bucketParts('metalFar').push({ geometry: boxGeo(0.9, 0.5, 0.4), matrix: yawTilt(p.x, hF + 0.2, p.z, yawIn, 0.6), color: 0x3c424c });
        this._bucketParts('lamp').push({ geometry: boxGeo(0.78, 0.38, 0.04), matrix: yawTilt(p.x + Math.sin(yawIn) * 0.2, hF + 0.1, p.z + Math.cos(yawIn) * 0.2, yawIn, 0.6) });
        if (i % 2 === 0) this._halo(p.x + Math.sin(yawIn) * 0.6, hF - 0.2, p.z + Math.cos(yawIn) * 0.6);
      }
    }
    // name band along the top of the far (north) stand's back wall, facing the court
    const north = this.stands.find(s => s.side === 'north');
    if (north) {
      const dB = north.front + rows * D + 0.05;
      const p = this._standXZ(north, dB - 0.2, 0);
      this._bucketParts('atlas').push({ geometry: regionPlane(18, 2.25, atlasUV('sign')), matrix: makeMatrix(p.x, topY + 3.2, p.z + 0.2, 0) });
      this._box('metalFar', 18.6, 2.6, 0.3, p.x, topY + 3.2, p.z, 0x10141c);
    }
  }

  // ─────────────── lights ───────────────

  _halo(x, y, z) {
    this.halos.push(x, y, z);
  }

  _buildLights() {
    const L = this.look, lay = this.lay;
    if (!L.lights || L.rig === 'poles') return;
    if (L.rig === 'masts' || L.rig === 'rigs') {
      const h = L.rig === 'rigs' ? 24 : 17;
      const mx = Math.max(lay.sideFront + (this.look.stands.sides.includes('east') ? this.look.stands.rows * lay.rowD + 1.2 : 1.5), 13.5);
      const mz = L.rig === 'rigs' ? lay.endFront + this.look.stands.rows * lay.rowD * 0.5 : 19.5;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) this._mast(sx * mx, sz * mz, h, L.rig === 'rigs' ? 3 : 2);
      }
    }
  }

  _mast(x, z, h, rowsOfLamps) {
    const col = 0x2b3440;
    this._cyl('metal', 0.16, 0.34, h, 10, x, h / 2, z, col);
    this._cyl('metal', 0.5, 0.5, 0.3, 10, x, 0.15, z, 0x3a3f46);
    const yaw = Math.atan2(-x, -z);
    const head = new THREE.Matrix4().makeTranslation(x, h + 0.7, z)
      .multiply(_m4.makeRotationY(yaw)).multiply(_m4b.makeRotationX(0.62));
    const local = (lx, ly, lz) => head.clone().multiply(new THREE.Matrix4().makeTranslation(lx, ly, lz));
    const w = 3.4, hh = 0.75 * rowsOfLamps + 0.3;
    this._bucketParts('metal').push({ geometry: boxGeo(w, hh, 0.3), matrix: local(0, 0, 0), color: 0x3c444e });
    this._bucketParts('metal').push({ geometry: boxGeo(0.5, 0.6, 0.5), matrix: new THREE.Matrix4().makeTranslation(x, h + 0.1, z), color: col });
    for (let r = 0; r < rowsOfLamps; r++) {
      for (let c = 0; c < 4; c++) {
        this._bucketParts('lamp').push({ geometry: boxGeo(0.72, 0.6, 0.04), matrix: local(-1.125 + c * 0.75, (rowsOfLamps - 1) * 0.375 - r * 0.75, 0.16) });
      }
    }
    for (const hx of [-0.9, 0.9]) {
      _v3.set(hx, 0, 0.7).applyMatrix4(head);
      this._halo(_v3.x, _v3.y, _v3.z);
    }
  }

  // ─────────────── court extras ───────────────

  _buildExtras() {
    const lay = this.lay, pal = this.pal, L = this.look;
    // players' benches (Court builds them at −benchX, ±2.3) → spots; umpire seat
    for (const z of [-2.3, 2.3]) this.spots.benches.push({ x: -lay.benchX, y: (lay.benchX < lay.padX ? 0.15 : 0) + 0.48, z, yaw: HALF_PI });
    this.spots.umpire = { x: -8.97, y: 0.15 + 1.92, z: 0, yaw: HALF_PI };
    // cooler + towel boxes by each bench, an umbrella over the benches (sunny venues)
    for (const z of [-2.3, 2.3]) {
      const bx = -lay.benchX - 0.1;
      this._rbox('prop', 0.46, 0.4, 0.34, 0.06, bx + 0.05, 0.2 + (lay.benchX < lay.padX ? 0.15 : 0), z + (z > 0 ? 1.15 : -1.15), pal.accent);
      if (L.umbrellas) {
        const uz = z + (z > 0 ? 0.3 : -0.3);
        this._cyl('metal', 0.025, 0.025, 2.4, 6, bx - 0.5, 1.2, uz, 0x3a3f3a);
        this._bucketParts('prop').push({ geometry: coneGeo(1.3, 0.45, 12), matrix: makeMatrix(bx - 0.5, 2.45, uz), color: z > 0 ? pal.fence : pal.accent });
      }
    }
    // line judges' chairs at the four corners (outside the doubles alleys, behind the baselines)
    // (beside the doubles alleys near the baselines: never behind a baseline, where the camera looks)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) this._chair(sx * (lay.padX - 0.9), sz * 11.3, sx > 0 ? -HALF_PI : HALF_PI, pal.fence);
    }
    // east side: the coach's chair when there is no east stand (the player's half)
    if (!this.look.stands.sides.includes('east')) {
      const cx = lay.padX + 1.2, cz = 5.5;
      this._chair(cx, cz, -HALF_PI, 0x2d5a3d);
      this.spots.coach = { x: cx, y: 0.46, z: cz, yaw: -HALF_PI, seated: true };
    }
    // courtside sponsor boards at the net posts' sides (low, facing the court) — outside the fade
    // region (|u| ≥ padX), both sides
    for (const sx of [-1, 1]) {
      const x = sx * (lay.padX + 0.35);
      for (const z of [-9, 9]) {
        if (sx < 0 && Math.abs(z) < 4) continue;
        this._bucketParts('atlas').push({ geometry: regionPlane(2.4, 0.6, atlasUV('boardA', (Math.abs(z) + sx + 4) % 4)), matrix: makeMatrix(x, 0.45, z, sx > 0 ? -HALF_PI : HALF_PI) });
        this._box('prop', 0.08, 0.7, 2.5, x + sx * 0.05, 0.4, z, 0x2e3338);
      }
    }
  }

  _chair(x, z, yaw, color) {
    const F = (lx, ly, lz) => makeMatrix(x, 0, z, yaw).multiply(makeMatrix(lx, ly, lz));
    this._bucketParts('prop').push({ geometry: boxGeo(0.46, 0.05, 0.44), matrix: F(0, 0.45, 0), color });
    this._bucketParts('prop').push({ geometry: boxGeo(0.46, 0.45, 0.05), matrix: F(0, 0.7, -0.2), color });
    for (const lx of [-0.2, 0.2]) {
      for (const lz of [-0.18, 0.18]) this._bucketParts('metal').push({ geometry: boxGeo(0.03, 0.45, 0.03), matrix: F(lx, 0.22, lz), color: 0x3a3f3a });
    }
  }

  // ─────────────── trees ───────────────

  _buildTrees() {
    const T = this.look.trees;
    const items = [];            // { kind, x, z, s, shadow, lod }
    const rand = this.rand;
    const keepOut = this._keepOut();
    const place = (n, rMin, rMax, kind, lod, tries = 30) => {
      for (let i = 0; i < n; i++) {
        for (let t = 0; t < tries; t++) {
          const a = rand() * TAU, r = rMin + Math.sqrt(rand()) * (rMax - rMin);
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          if (!this._treeOk(x, z, keepOut, items, lod ? 3 : 5)) continue;
          items.push({ kind, x, z, s: (lod ? 1.1 : 0.9) + rand() * 0.5, lod });
          break;
        }
      }
    };
    if (T.kind !== 'none' && T.count > 0) place(Math.min(90, T.count), 24, 78, T.kind, false);
    // backdrop belts
    const bd = this.look.backdrop;
    if (bd === 'forest') {
      place(this.low ? 40 : 90, 44, 75, 'mix', false, 14);
      place(this.low ? 90 : 210, 70, 150, 'mix', true, 14);
    } else if (bd === 'lawn') {
      place(this.low ? 16 : 34, 80, 150, 'oak', true, 10);
    } else if (bd === 'harbor') {
      place(this.low ? 24 : 56, 60, 160, 'pine', true, 10);
    } else if (bd === 'city') {
      place(this.low ? 10 : 26, 30, 64, 'oak', false, 12);
    } else if (bd === 'campus') {
      place(this.low ? 10 : 22, 60, 120, T.kind === 'none' ? 'pine' : T.kind, true, 10);
    }
    if (!items.length) return;
    // per species, per LOD: one instanced mesh each; shadows for the near ones
    const groups = new Map();
    for (const it of items) {
      let kind = it.kind;
      if (kind === 'mix') kind = rand() < 0.62 ? 'maple' : 'pine';
      const key = `${kind}|${it.lod ? 1 : 0}`;
      if (!groups.has(key)) groups.set(key, { kind, lod: it.lod, list: [] });
      groups.get(key).list.push(it);
    }
    const tm = treeMaterial();
    const shadows = !!Quality.settings.shadows;
    const blobs = [];
    const autumn = !!this.look.trees.autumn;
    for (const g of groups.values()) {
      const lodGeo = g.lod || this.low;
      const geo = g.kind === 'maple' ? mapleGeometry(autumn, lodGeo) : treeGeometry(g.kind === 'oak' ? 'oak' : 'pine', lodGeo);
      const im = new THREE.InstancedMesh(geo, tm, g.list.length);
      im.name = `VenueTrees:${g.kind}${g.lod ? '|far' : ''}`;
      g.list.forEach((it, i) => {
        _m4.makeRotationY(hashU(Math.round(it.x * 7), Math.round(it.z * 7)) * TAU);
        _m4.scale(_v3.set(it.s, it.s * (0.92 + hashU(i, 3) * 0.2), it.s));
        _m4.setPosition(it.x, 0, it.z);
        im.setMatrixAt(i, _m4);
        const tint = 0.9 + hashU(i, 5) * 0.16;
        im.setColorAt(i, _col.setRGB(tint, tint * (0.97 + hashU(i, 9) * 0.05), tint * 0.96));
        if (!g.lod) blobs.push(it);
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.castShadow = shadows && !g.lod;
      im.receiveShadow = !g.lod;
      im.customDepthMaterial = sharedDepthMaterial('instancedColor');
      im.computeBoundingSphere();
      im.userData.noMerge = true;
      this.local.add(im);
    }
    if (blobs.length) {
      const bg = getGeometry('scenery-blobPlane', () => new THREE.PlaneGeometry(1, 1));
      const im = new THREE.InstancedMesh(bg, blobMaterial(), blobs.length);
      blobs.forEach((it, i) => {
        const r = 1.7 * it.s;
        _m4.makeRotationX(-HALF_PI).scale(_v3.set(r * 2, r * 2, 1)).setPosition(it.x, 0.012, it.z);
        im.setMatrixAt(i, _m4);
      });
      im.instanceMatrix.needsUpdate = true;
      im.renderOrder = 1;
      im.userData.noAO = true;
      im.name = 'VenueTreeBlobs';
      im.computeBoundingSphere();
      this.local.add(im);
    }
  }

  /** Rectangles trees stay out of: the court, stands, clubhouse, the camera wells behind both ends. */
  _keepOut() {
    const lay = this.lay, L = this.look;
    const sideDepth = L.stands.sides.some(s => s === 'east' || s === 'west') ? L.stands.rows * lay.rowD + 2 : 0;
    const endDepth = L.stands.sides.some(s => s === 'north' || s === 'south') ? L.stands.rows * lay.rowD + 2 : 0;
    const rects = [
      { x0: -(lay.sideFront + sideDepth + 4), x1: lay.sideFront + sideDepth + 4, z0: -(lay.endFront + endDepth + 3), z1: lay.endFront + endDepth + 3 },
      { x0: -22, x1: 22, z0: -30, z1: 30 },   // the broadcast camera's view corridor at either end
    ];
    if (this._club) {
      const c = this._club, r = Math.max(16, c.depth + 6);
      rects.push({ x0: c.x - r, x1: c.x + r, z0: c.z - r * 0.8, z1: c.z + r * 0.8 });
    }
    const sbs = this._scoreboardSpots();
    if (sbs) for (const b of sbs.spots) rects.push({ x0: b.x - sbs.w / 2 - 2, x1: b.x + sbs.w / 2 + 2, z0: b.z - 2.5, z1: b.z + 2.5 });
    if (L.backdrop === 'harbor') rects.push({ x0: -500, x1: 500, z0: -500, z1: this._shoreZ() + 4 });
    if (this._extraKeepOut) rects.push(...this._extraKeepOut);
    return rects;
  }

  _treeOk(x, z, rects, items, minD) {
    if (this._treeLimit && !this._treeLimit(x, z)) return false;
    for (const r of rects) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) return false;
    for (const sg of this._keepSegs || []) {
      const dx = sg.bx - sg.ax, dz = sg.bz - sg.az, l2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - sg.ax) * dx + (z - sg.az) * dz) / (l2 || 1)));
      const ex = x - (sg.ax + dx * t), ez = z - (sg.az + dz * t);
      if (ex * ex + ez * ez < sg.r * sg.r) return false;
    }
    for (const it of items) {
      const dx = it.x - x, dz = it.z - z;
      if (dx * dx + dz * dz < minD * minD) return false;
    }
    return true;
  }

  // ─────────────── backdrop ───────────────

  _buildBackdrop() {
    const bd = this.look.backdrop;
    this._hillParts = [];
    if (bd === 'city') this._city('apartment');
    else if (bd === 'night') this._city('tower');
    else if (bd === 'harbor') this._harbor();
    else if (bd === 'campus') this._campus();
    else if (bd === 'lawn') this._countryside();
    // far hills / skyline ring (the club horizon's hill material)
    const hillCol = {
      city: [0x6f7f86, 0x8594a0], night: [0x252c3a, 0x39425a], harbor: [0x5c7a6a, 0x7a92a0], forest: [0x7c5a36, 0x6f7050],
      lawn: [0x557a45, 0x7890a0], campus: [0x9a9a5a, 0x9aa0a0],
    }[bd] || [0x557a45, 0x7890a0];
    // (harbor: the near ring opens over the bay, sloping down to the water either side)
    this._hillRing(260, 5, 26, hillCol[0], 0, 7, bd === 'harbor' ? [-2.35, -0.8] : null);
    this._hillRing(bd === 'harbor' ? 360 : 330, bd === 'harbor' ? 4 : 12, bd === 'harbor' ? 22 : 38, hillCol[1], 1, 11, null);
    if (bd === 'forest') this._hillRing(205, 9, 24, 0x86582e, 0, 13, null);
    this._finishHills();
  }

  /** A ring of hill silhouettes (the Hills program: aCol + aLayer). skip: an angle range left open. */
  _hillRing(r, hMin, hMax, color, layer, seed, skip) {
    const seg = 96, period = 9 + (seed % 5);
    const top = [];
    // angular distance (rad) into an open sector: hills taper to the ground over 0.35 rad at its edges
    const open = (a) => {
      if (!skip) return 1;
      let x = a;
      while (x > Math.PI) x -= TAU;
      while (x < -Math.PI) x += TAU;
      if (x > skip[0] && x < skip[1]) return 0;
      const d = Math.min(Math.abs(x - skip[0]), Math.abs(x - skip[1]));
      return Math.min(1, d / 0.35);
    };
    for (let i = 0; i <= seg; i++) {
      const n = fbm2((i / seg) * period, seed, { octaves: 4, seed, period });
      const k = Math.min(1, Math.max(0, (n - 0.25) * 1.9));
      const f = open((i / seg) * TAU);
      top.push((hMin + (hMax - hMin) * k * k * (3 - 2 * k)) * f * f * (3 - 2 * f) - 3 * (1 - f));
    }
    const c = new THREE.Color(color);
    for (let i = 0; i < seg; i++) {
      if (top[i] <= -2.9 && top[i + 1] <= -2.9) continue;
      const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
      this._hillQuad(Math.cos(a0) * r, Math.sin(a0) * r, Math.cos(a1) * r, Math.sin(a1) * r, -3, top[i], top[i + 1], c, layer);
    }
  }

  /** One vertical quad of the hill / skyline mesh (from y0 to y1a / y1b). */
  _hillQuad(x0, z0, x1, z1, y0, y1a, y1b, c, layer) {
    const P = this._hillParts;
    const sh = (y) => 0.72 + 0.28 * Math.min(1, Math.max(0, y / 40));
    P.push([x0, y0, z0, c.r * sh(y0), c.g * sh(y0), c.b * sh(y0), layer]);
    P.push([x1, y0, z1, c.r * sh(y0), c.g * sh(y0), c.b * sh(y0), layer]);
    P.push([x1, y1b, z1, c.r * sh(y1b), c.g * sh(y1b), c.b * sh(y1b), layer]);
    P.push([x0, y0, z0, c.r * sh(y0), c.g * sh(y0), c.b * sh(y0), layer]);
    P.push([x1, y1b, z1, c.r * sh(y1b), c.g * sh(y1b), c.b * sh(y1b), layer]);
    P.push([x0, y1a, z0, c.r * sh(y1a), c.g * sh(y1a), c.b * sh(y1a), layer]);
  }

  /** A skyline of flat building silhouettes on a ring (Hills program: hazed like the club's hills). */
  _skylineRing(r, n, hMin, hMax, color, layer, a0 = 0, a1 = TAU) {
    const c = new THREE.Color(color), rand = this.rand;
    let a = a0;
    while (a < a1) {
      const w = (6 + rand() * 18) / r;
      const h = hMin + Math.pow(rand(), 1.6) * (hMax - hMin);
      const rr = r + (rand() - 0.5) * 20;
      const x0 = Math.cos(a) * rr, z0 = Math.sin(a) * rr, x1 = Math.cos(a + w) * rr, z1 = Math.sin(a + w) * rr;
      c.set(color).multiplyScalar(0.85 + rand() * 0.3);
      this._hillQuad(x0, z0, x1, z1, -2, h, h, c, layer);
      a += w + (rand() < 0.3 ? rand() * 0.02 : 0);
      void n;
    }
  }

  _finishHills() {
    const P = this._hillParts;
    if (!P.length) return;
    const pos = new Float32Array(P.length * 3), aCol = new Float32Array(P.length * 3), lay = new Float32Array(P.length);
    P.forEach((p, i) => {
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      aCol[i * 3] = p[3]; aCol[i * 3 + 1] = p[4]; aCol[i * 3 + 2] = p[5];
      lay[i] = p[6];
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(aCol, 3));
    g.setAttribute('aLayer', new THREE.BufferAttribute(lay, 1));
    g.setAttribute('color', new THREE.BufferAttribute(aCol, 3));   // (the lit fallback material)
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this._owned.geometries.push(g);
    const hills = this.game.weather?.horizon?.group?.getObjectByName('Hills');
    const material = hills && hills.material && hills.material.isShaderMaterial
      ? hills.material
      : getMaterial('venue-hillsFallback', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
    const m = new THREE.Mesh(g, material);
    m.name = 'VenueSkyline';
    m.userData.noAO = true;
    this.local.add(m);
    this._hillParts = null;
  }

  /** City blocks (facade boxes with lit windows) around the park, a street grid, a far skyline. */
  _city(style) {
    const rand = this.rand;
    const fm = this._facadeMaterial(style);
    void fm;
    const night = style === 'tower';
    const F = (x, y, z) => makeMatrix(x, y, z);
    const tints = night ? [0xb8c4d0, 0x9aa8b8, 0xc8d0d8, 0x8e9aac] : [0xc98f6e, 0xe0d2bc, 0xb9b0a4, 0xd9b48f, 0xa8b4b8, 0xe8e0d0];
    const inner = night ? 95 : 76, outer = night ? 190 : 160;
    const e = inner - 9;
    this._treeLimit = (x, z) => Math.max(Math.abs(x), Math.abs(z)) < e - 8.5;
    // streets (an asphalt ring road round the park) + sidewalks; each layer on its own height
    if (!night) {
      for (const s of [-1, 1]) {
        this._tbox('asphalt', 2 * e + 12, 0.1, 9, 0, -0.02, s * e, 6);           // top 0.03
        this._tbox('asphalt', 9, 0.1, 2 * e + 12, s * e, -0.005, 0, 6);         // top 0.045
        this._tbox('path', 2 * e - 9, 0.1, 3, 0, 0.01, s * (e - 6), 4);          // top 0.06
        this._tbox('path', 3, 0.1, 2 * e - 9, s * (e - 6), 0.025, 0, 4);         // top 0.075
        // kerbs + centre lines
        this._box('prop', 2 * e + 12, 0.04, 0.12, 0, 0.03, s * e, 0xe8d77a);
        this._box('prop', 0.12, 0.04, 2 * e + 12, s * e, 0.045, 0, 0xe8d77a);
      }
      // street lamps along the park side
      for (let i = -3; i <= 3; i++) {
        for (const s of [-1, 1]) {
          this._streetLamp(i * 20, s * (e - 4.8));
          this._streetLamp(s * (e - 4.8), i * 20);
        }
      }
      // park walks: a diagonal cross from the corners to the courts, benches and lamps on them
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const ax = sx * 16, az = sz * 21, bx = sx * (e - 7.5), bz = sz * (e - 7.5);
        const len = Math.hypot(bx - ax, bz - az), yaw = Math.atan2(bx - ax, bz - az);
        this._tpart('path', boxGeo(2.6, 0.1, len), makeMatrix((ax + bx) / 2, -0.03 + (sx * sz > 0 ? 0 : 0.012), (az + bz) / 2, yaw), 4);
        (this._keepSegs ||= []).push({ ax, az, bx, bz, r: 4.5 });
        for (const t of [0.35, 0.7]) {
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const nx = Math.cos(yaw) * 2.2, nz = -Math.sin(yaw) * 2.2;
          this._bench(x + nx, z + nz, yaw - HALF_PI);
          this._pathLamp(x - nx, z - nz);
        }
      }
    }
    // blocks: rows along the four sides at `inner`..`outer`
    let placed = 0;
    for (let tries = 0; tries < 900 && placed < (night ? 70 : 64); tries++) {
      const a = rand() * TAU, r = inner + rand() * (outer - inner);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const ax = Math.abs(x), az = Math.abs(z);
      const w = 14 + rand() * 16, d = 12 + rand() * 12;
      // outside the park square and its streets (or the stadium plaza)
      if (ax - w / 2 < e + 6 && az - d / 2 < e + 6) continue;
      const h = night ? 28 + Math.pow(rand(), 1.4) * 110 : 12 + Math.pow(rand(), 1.5) * 34;
      if (this._blocks && this._blocks.some(b => Math.abs(b.x - x) < (b.w + w) / 2 + 3 && Math.abs(b.z - z) < (b.d + d) / 2 + 3)) continue;
      (this._blocks ||= []).push({ x, z, w, d });
      const col = tints[(rand() * tints.length) | 0];
      this._facadeBox(F, w, h, d, x, h / 2, z, col, (rand() * 4) | 0);
      // rooftop kit: parapet, AC units, a water tank now and then
      this._box('propFar', w + 0.4, 0.5, d + 0.4, x, h + 0.25, z, shade(col, -0.25));
      if (rand() < 0.6) this._box('propFar', 2.4, 1.4, 1.6, x + (rand() - 0.5) * w * 0.5, h + 0.9, z + (rand() - 0.5) * d * 0.5, 0x9aa0a4);
      if (!night && rand() < 0.25) {
        const tx = x + (rand() - 0.5) * w * 0.4, tz = z + (rand() - 0.5) * d * 0.4;
        this._cyl('propFar', 1.4, 1.4, 2.6, 10, tx, h + 3.2, tz, 0x7a5a3a);
        this._bucketParts('propFar').push({ geometry: coneGeo(1.5, 1, 10), matrix: F(tx, h + 5, tz), color: 0x5a4a3a });
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this._box('metalFar', 0.12, 1.9, 0.12, tx + dx, h + 0.95, tz + dz, 0x3a3a3a);
      }
      if (night && rand() < 0.35) this._bucketParts('lamp').push({ geometry: boxGeo(0.5, 0.5, 0.5), matrix: F(x, h + 0.9, z) });
      placed++;
    }
    this._skylineRing(night ? 250 : 235, 0, night ? 40 : 20, night ? 150 : 70, night ? 0x2a3044 : 0x7d8b96, 1);
  }

  _streetLamp(x, z) {
    this._cyl('metalFar', 0.06, 0.09, 5.2, 8, x, 2.6, z, 0x2a2f33);
    this._box('metalFar', 0.9, 0.08, 0.1, x + 0.4, 5.15, z, 0x2a2f33);
    this._bucketParts('lamp').push({ geometry: boxGeo(0.45, 0.12, 0.28), matrix: makeMatrix(x + 0.8, 5.08, z) });
  }

  _harbor() {
    const zS = this._shoreZ();
    const rand = this.rand;
    // water (bump ripples + env reflections: the fountain's program) over the sea bed
    const ripple = Textures.noise({ scale: 8 }).clone();
    ripple.repeat.set(60, 60);
    ripple.needsUpdate = true;
    this._owned.textures.push(ripple);
    const wm = new THREE.MeshStandardMaterial({
      color: this.look.waterColor ?? 0x2f6f86, roughness: 0.06, metalness: 0.05, transparent: true, opacity: 0.86,
      bumpMap: ripple, bumpScale: 0.9, envMapIntensity: 1.4,
    });
    wm.name = 'venue-water';
    this._owned.materials.push(wm);
    const wg = new THREE.PlaneGeometry(920, 460 + zS);
    wg.rotateX(-HALF_PI);
    wg.translate(0, -0.42, zS - (460 + zS) / 2);
    this._owned.geometries.push(wg);
    const water = new THREE.Mesh(wg, wm);
    water.name = 'venue-water';
    water.receiveShadow = true;
    water.userData.noAO = true;
    this.local.add(water);
    this._water = { mesh: water, map: ripple };
    // stone quay wall + promenade, bollards
    this._tbox('concrete', 190, 2.0, 0.8, 0, -0.85, zS - 0.4, 3, 0x9a948a);
    this._tbox('pavers', 190, 0.1, 6, 0, -0.01, zS + 3, 1.6);
    for (let x = -90; x <= 90; x += 7.5) this._cyl('metal', 0.14, 0.18, 0.55, 8, x, 0.3, zS + 0.35, 0x2a2f33);
    // pier with moored boats
    const px = 22, pl = 46;
    this._tbox('wood', 3, 0.25, pl, px, 0.2, zS - pl / 2, 2, 0xa0825e);
    for (let z = zS - 2; z > zS - pl; z -= 4) {
      for (const sx of [-1.4, 1.4]) this._cyl('wood', 0.14, 0.14, 2.6, 6, px + sx, -0.9, z, 0x6b4a2e);
    }
    let b = 0;
    for (let z = zS - 7; z > zS - pl + 2; z -= 7.5) {
      for (const sx of [-1, 1]) this._boat(px + sx * 4.6, z, sx > 0 ? HALF_PI : -HALF_PI, b++, rand);
    }
    // a few boats at anchor further out
    for (let i = 0; i < 6; i++) this._boat(-80 + rand() * 170, zS - 60 - rand() * 90, rand() * TAU, b++, rand, true);
    // the harbour front: a row of painted houses and sheds along the quay either side
    this._facadeMaterial('apartment');
    const tints = [0xe8d8b0, 0x9cc3e0, 0xe8b4b8, 0xf4efe6, 0xa8c8a0, 0xd9a47e, 0xc9d6e0];
    for (const side of [-1, 1]) {
      let x = side * 58;
      for (let i = 0; i < 9; i++) {
        const w = 8 + rand() * 7, d = 9 + rand() * 4, h = 7 + rand() * 7;
        const cx = x + side * w / 2, cz = zS + 6.5 + d / 2;
        this._facadeBox((a, b, c) => makeMatrix(a, b, c), w, h, d, cx, h / 2, cz, tints[(i * 3 + (side > 0 ? 1 : 0)) % tints.length], (rand() * 4) | 0);
        (this._extraKeepOut ||= []).push({ x0: cx - w / 2 - 3, x1: cx + w / 2 + 3, z0: cz - d / 2 - 3, z1: cz + d / 2 + 3 });
        // pitched roof
        const rise = 2.2 + rand() * 1.2;
        this._tpart('roof', prismGeo(w / 2 + 0.3, rise, d + 0.6), makeMatrix(cx, h, cz - d / 2 - 0.3), 2.5);
        x += side * (w + 0.6 + rand() * 1.5);
      }
    }
    for (let x = -50; x <= 50; x += 12.5) {
      if (Math.abs(x - 22) < 4) continue;
      this._pathLamp(x, zS + 5.4, 3.4);
      if (Math.abs(x) > 8 && Math.abs(x) < 45) this._bench(x + 6, zS + 5.6, Math.PI);
    }
    // life-ring posts on the quay
    for (const x of [-30, 8, 36]) {
      this._cyl('metal', 0.05, 0.05, 1.3, 6, x, 0.65, zS + 1.2, 0x2a2f33);
      this._bucketParts('prop').push({ geometry: getGeometry('venue-lifeRing', () => new THREE.TorusGeometry(0.28, 0.07, 6, 14)), matrix: makeMatrix(x, 1.05, zS + 1.28), color: 0xe8543a });
    }
    // breakwater + lighthouse
    const lx = -92, lz = zS - 170;
    this._tbox('concreteFar', 90, 2.6, 7, lx + 30, -0.6, lz, 4, 0x8a857c);
    this._lighthouse(lx, lz);
    (this._extraKeepOut ||= []).push({ x0: px - 5, x1: px + 5, z0: zS - pl - 4, z1: zS + 2 });
  }

  _boat(x, z, yaw, i, rand, far = false) {
    const key = far ? 'propFar' : 'prop';
    const F = (lx, ly, lz, rx = 0, rz = 0) => makeMatrix(x, 0, z, yaw).multiply(makeMatrix(lx, ly, lz, 0, 1, rx, rz));
    const L = 6 + (i % 3) * 1.6, W = 2.1 + (i % 2) * 0.3;
    const hull = [0xf4f1ea, 0x1f3a5a, 0xf4f1ea, 0x8c2f2a, 0xf4f1ea][i % 5];
    this._bucketParts(key).push({ geometry: roundedBox(W, 0.9, L, 0.35), matrix: F(0, -0.15, 0), color: hull });
    this._bucketParts(key).push({ geometry: coneGeo(W * 0.5, 1.4, 8), matrix: F(0, -0.15, L / 2 + 0.3, HALF_PI), color: hull });
    this._bucketParts(key).push({ geometry: boxGeo(W + 0.05, 0.12, L), matrix: F(0, 0.28, 0), color: 0x2a4a6a });
    if (i % 2 === 0) {
      // sailboat: mast + boom + furled sail
      this._bucketParts('metal').push({ geometry: cylinderGeo(0.05, 0.07, 8.5, 6), matrix: F(0, 4.4, 0.6), color: 0xd8dcdf });
      this._bucketParts('metal').push({ geometry: cylinderGeo(0.04, 0.04, 3.2, 6), matrix: F(0, 1.3, -0.9, HALF_PI), color: 0xd8dcdf });
      this._bucketParts(key).push({ geometry: cylinderGeo(0.14, 0.14, 3.0, 6), matrix: F(0, 1.45, -0.9, HALF_PI), color: 0x1f3a5a });
    } else {
      // motor launch: cabin + windscreen
      this._bucketParts(key).push({ geometry: roundedBox(W * 0.8, 1.0, L * 0.4, 0.15), matrix: F(0, 0.8, -0.3), color: 0xf4f1ea });
      this._bucketParts('glass').push({ geometry: glassPane(W * 0.7, 0.45, 3), matrix: F(0, 1.0, L * 0.2 - 0.28) });
    }
    void rand;
  }

  _lighthouse(x, z) {
    const H = 18;
    for (let i = 0; i < 6; i++) {
      const h = H / 6, r0 = 2.2 - i * 0.18, r1 = 2.2 - (i + 1) * 0.18;
      this._cyl('propFar', r1, r0, h, 14, x, 0.7 + h * (i + 0.5), z, i % 2 ? 0xc23b3b : 0xf4f1ea);
    }
    this._cyl('propFar', 1.5, 1.5, 0.3, 14, x, H + 0.85, z, 0x2a2f33);
    this._bucketParts('lamp').push({ geometry: cylinderGeo(0.95, 0.95, 1.5, 12), matrix: makeMatrix(x, H + 1.75, z) });
    this._bucketParts('propFar').push({ geometry: coneGeo(1.3, 1.3, 12), matrix: makeMatrix(x, H + 3.15, z), color: 0x2a2f33 });
    this._halo(x, H + 1.75, z);
    this._halo(x, H + 1.75, z);   // brighter (two points)
  }

  _campus() {
    const fm = this._facadeMaterial('campus');
    void fm;
    const rand = this.rand;
    const F = (x, y, z) => makeMatrix(x, y, z);
    const tints = [0xd98a64, 0xeee6d6, 0xc7a27c, 0xe8d8bc];
    // campus buildings around at 60-130 m (not behind the academy)
    const spots = [[-75, -40], [-90, 20], [-70, 75], [10, 95], [70, 80], [95, 20], [80, -60], [-30, -110], [40, -120]];
    for (const [x, z] of spots) {
      const w = 22 + rand() * 18, d = 14 + rand() * 8, h = 9 + rand() * 9;
      this._facadeBox(F, w, h, d, x, h / 2, z, tints[(rand() * tints.length) | 0], (rand() * 4) | 0);
      this._box('propFar', w + 0.5, 0.6, d + 0.5, x, h + 0.3, z, 0x8a8078);
    }
    // practice courts beyond the east stand: flat painted pads with low fences
    const x0 = this.lay.sideFront + this.look.stands.rows * this.lay.rowD + 8;
    for (let i = 0; i < 3; i++) {
      const cx = x0 + 10 + i * 19;
      this._bucketParts('atlas').push({
        geometry: regionPlane(36.6, 18.3, atlasUV('court', i === 1 ? 3 : 0)),
        matrix: flatMatrix(cx, 0.075, 0, HALF_PI),
      });
      this._tbox('path', 19, 0.1, 38, cx, 0.0, 0, 5);
      for (const sz of [-1, 1]) this._box('metal', 18, 1.2, 0.05, cx, 0.6, sz * 18.4, 0x2d3b40);
    }
    (this._extraKeepOut ||= []).push({ x0: x0, x1: x0 + 70, z0: -22, z1: 22 });
  }

  _countryside() {
    const rand = this.rand;
    // hedgerows: long clipped lines across the fields
    for (let i = 0; i < 9; i++) {
      const a = rand() * TAU, r = 70 + rand() * 60;
      const len = 30 + rand() * 50, yaw = a + HALF_PI + (rand() - 0.5) * 0.6;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) < 30 && Math.abs(z) < 60) continue;
      this._tpart('hedge', roundedBox(len, 1.6, 1.4, 0.4), makeMatrix(x, 0.7, z, yaw), 2.5);
    }
    // a village on the far rise: church with a spire and rooftops (skyline silhouettes)
    const c = new THREE.Color(0x6f7a72);
    const va = -2.1, vr = 225;
    for (let i = 0; i < 16; i++) {
      const a = va - 0.25 + i * 0.032, h = 6 + (i % 3) * 2.5;
      const x0 = Math.cos(a) * vr, z0 = Math.sin(a) * vr, x1 = Math.cos(a + 0.028) * vr, z1 = Math.sin(a + 0.028) * vr;
      this._hillQuad(x0, z0, x1, z1, -2, h, h, c, 0);
      // gable peaks
      const xm = (x0 + x1) / 2, zm = (z0 + z1) / 2;
      this._hillQuad(x0, z0, xm, zm, h, h, h + 3, c, 0);
      this._hillQuad(xm, zm, x1, z1, h, h + 3, h, c, 0);
    }
    const sa = va + 0.05, sx = Math.cos(sa) * (vr - 3), sz = Math.sin(sa) * (vr - 3);
    const tx = -Math.sin(sa) * 2.2, tz = Math.cos(sa) * 2.2;
    this._hillQuad(sx - tx, sz - tz, sx + tx, sz + tz, -2, 16, 16, c, 0);
    this._hillQuad(sx - tx, sz - tz, sx, sz, 16, 16, 30, c, 0);
    this._hillQuad(sx, sz, sx + tx, sz + tz, 16, 30, 16, c, 0);
  }

  // ─────────────── flags ───────────────

  _buildFlags() {
    const L = this.look, lay = this.lay;
    const n = L.flags ?? 3;
    if (!n) return;
    // a row of poles by the clubhouse side of the court, beyond the fence corner
    const cs = L.clubhouse.side === 'south' ? 1 : -1;
    const bx = (L.flagX ?? lay.sideFront + 3.5), bz = cs * (FENCE_Z + 5.5);
    const W = 1.8, H = 0.9, SEGX = 8, SEGY = 3;
    const geoms = [];
    for (let i = 0; i < n; i++) {
      const x = bx + i * 2.6, z = bz;
      const ph = 7.5 + (i === 1 ? 0.6 : 0);
      this._cyl('metal', 0.04, 0.07, ph, 8, x, ph / 2, z, 0xe8e8e4);
      this._bucketParts('metal').push({ geometry: sphereGeo(0.08, 8, 6), matrix: makeMatrix(x, ph + 0.05, z), color: 0xc9a54c });
      const r = atlasUV('flag', [1, 0, 2][i % 3]);
      const g = new THREE.PlaneGeometry(W, H, SEGX, SEGY);
      const uv = g.attributes.uv, p = g.attributes.position;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, r[0] + uv.getX(k) * (r[2] - r[0]), r[1] + uv.getY(k) * (r[3] - r[1]));
      g.translate(W / 2, ph - H / 2 - 0.1, 0);
      g.translate(x, 0, z);
      const base = new Float32Array(p.array);
      geoms.push({ g, base, x, phase: i * 1.7 });
    }
    // one mesh for all the cloths (the positions are rewritten while they wave)
    const merged = mergeParts(geoms.map(f => ({ geometry: f.g })));
    for (const f of geoms) f.g.dispose();
    const base = new Float32Array(merged.attributes.position.array);
    this._owned.geometries.push(merged);
    merged.attributes.position.setUsage(THREE.DynamicDrawUsage);
    const mesh = new THREE.Mesh(merged, this.mats.flag);
    mesh.name = 'VenueFlags';
    mesh.castShadow = !!Quality.settings.shadows;
    mesh.userData.dynamic = true;
    // Culled like anything else, against a sphere padded for the wave (the positions move, the
    // sphere doesn't: three.js only computes it when it is missing)
    merged.computeBoundingSphere();
    merged.boundingSphere.radius += 0.5;
    this.local.add(mesh);
    this._flags = { mesh, base, poles: geoms.map(f => ({ x: f.x, phase: f.phase })), W };
  }

  _updateFlags(dt) {
    const F = this._flags;
    if (!F || !F.mesh) return;
    const t = this._t, wind = 0.35 + (EnvState.windStrength || 0.2) * 1.6;
    const pos = F.mesh.geometry.attributes.position, arr = pos.array, base = F.base;
    const poles = F.poles, per = arr.length / poles.length / 3;
    for (let pi = 0; pi < poles.length; pi++) {
      const px = poles[pi].x, ph = poles[pi].phase;
      for (let k = 0; k < per; k++) {
        const i = (pi * per + k) * 3;
        const u = Math.max(0, (base[i] - px) / F.W);   // 0 at the pole, 1 at the fly
        const w = Math.sin(t * 5.2 * wind + u * 5.5 + ph) * 0.2 * u * wind + Math.sin(t * 8.3 + u * 9 + ph) * 0.05 * u;
        arr[i + 2] = base[i + 2] + w;
        arr[i] = base[i] - Math.abs(w) * 0.25 * u;
        arr[i + 1] = base[i + 1] - u * u * 0.08 * (1.2 - wind * 0.4);
      }
    }
    pos.needsUpdate = true;
    void dt;
  }

  // ─────────────── scoreboards ───────────────

  /**
   * Where the scoreboards stand (court-local): one behind each end, or null. A board that would
   * stand in the clubhouse (Ashford's pavilion is 25.5 m out) goes beside it instead, on the
   * side away from the flags.
   */
  _scoreboardSpots() {
    const L = this.look;
    const style = L.clubhouse.style;
    if (!(L.scoreboard ?? (style === 'modern' || style === 'arena'))) return null;
    const big = style === 'arena';
    const w = big ? 12 : 7.2, h = w / 2;
    const lay = this.lay, rows = L.stands.rows;
    const spots = [];
    for (const sz of [-1, 1]) {
      let x = 0, z, bottom;
      if (big) {
        const endDepth = lay.endFront + rows * lay.rowD;
        z = sz * (endDepth + 1.2);
        bottom = lay.base + (rows - 1) * lay.rowRise + 5.4;
      } else {
        // behind the portrait camera's well (it sits ~24.5 m out, 9 m up): the far board shows
        // over the far fence, the near one is behind the camera
        z = sz * 29.5;
        bottom = 5.6;
        const c = this._club;
        if (c && c.width > 0 && Math.abs(Math.sin(c.yaw)) < 0.5
          && Math.abs(z - c.z) < c.depth / 2 + 1 && Math.abs(x - c.x) < (c.width + w) / 2 + 1) {
          const off = (c.width + w) / 2 + 1.8;
          const west = c.x - off, east = c.x + off;
          const flagsEast = (L.flags ?? 3) > 0 && (L.flagX ?? 1) >= 0;
          x = Math.abs(Math.abs(west) - Math.abs(east)) > 0.01
            ? (Math.abs(west) < Math.abs(east) ? west : east)
            : (flagsEast ? west : east);
        }
      }
      spots.push({ x, z, bottom, sz });
    }
    return { big, w, h, spots };
  }

  _buildScoreboards() {
    const S = this._scoreboardSpots();
    if (!S) return;
    const sb = scoreboardCanvas();
    this._owned.textures.push(sb.tex);
    drawScoreIdle(sb, this.def, this.pal);
    const m = new THREE.MeshStandardMaterial({ map: sb.tex, emissive: 0xffffff, emissiveMap: sb.tex, emissiveIntensity: 0.12, roughness: 0.6 });
    m.name = 'venue-scoreFace';
    this._owned.materials.push(m);
    this._glow.push({ m, min: 0.12, max: 0.55 });
    const { big, w, h } = S;
    const parts = [];
    for (const { x, z, bottom, sz } of S.spots) {
      const yaw = sz > 0 ? Math.PI : 0;
      const fz = -sz * 0.27;
      parts.push({ geometry: new THREE.PlaneGeometry(w - 0.6, h - 0.5), matrix: makeMatrix(x, bottom + h / 2, z + fz, yaw) });
      this._box('metal', w, h, 0.5, x, bottom + h / 2, z, 0x121a24);
      this._box('metal', w + 0.12, 0.1, 0.56, x, bottom + h + 0.05, z, this.pal.accent);
      if (!big) for (const sx of [-2.4, 2.4]) this._box('metal', 0.35, bottom, 0.35, x + sx, bottom / 2, z, 0x2b3440);
    }
    const g = mergeParts(parts);
    for (const p of parts) p.geometry.dispose();
    this._owned.geometries.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'VenueScoreFaces';
    mesh.userData.noAO = true;
    this.local.add(mesh);
    this._score = { sb, key: '' };
  }

  /** Same shape as Stadium.setScoreOverride: { names, games, points, server, sets } | null. */
  setScore(o) {
    const S = this._score;
    if (!S) return;
    if (!o) {
      if (S.key === '') return;
      S.key = '';
      drawScoreIdle(S.sb, this.def, this.pal);
      return;
    }
    const n = o.names || ['', ''], g = o.games || [0, 0], p = o.points || ['', ''], s = o.sets || [0, 0];
    const server = o.server === 1 ? 1 : 0;
    const key = `${n[0]}|${n[1]}|${g[0] | 0}|${g[1] | 0}|${p[0]}|${p[1]}|${server}|${s[0] | 0}|${s[1] | 0}`;
    if (key === S.key) return;
    S.key = key;
    drawScore(S.sb, this.def, this.pal, {
      n0: n[0], n1: n[1], g0: g[0] | 0, g1: g[1] | 0, p0: p[0], p1: p[1], s0: s[0] | 0, s1: s[1] | 0, server,
    });
  }

  // ─────────────── per frame ───────────────

  update(dt) {
    this._t += dt;
    const f = EnvState.lampFactor || 0;
    if (Math.abs(f - this._lastLamp) > 0.01) {
      this._lastLamp = f;
      for (const g of this._glow) g.m.emissiveIntensity = g.min + (g.max - g.min) * f;
      // far city / campus walls: the stadium floodlight is one directional light over the whole
      // scene, so the facades dim themselves at night and let their windows carry them
      if (this.mats.facade) this.mats.facade.color.setScalar(1 - 0.78 * f);
    }
    if (this._water) {
      const m = this._water.map;
      m.offset.x = (m.offset.x + dt * 0.011) % 1;
      m.offset.y = (m.offset.y + dt * 0.017) % 1;
    }
    if (this.crowd) this.crowd.update(dt);
    this._flagT = (this._flagT || 0) + dt;
    if (this._flagT >= 1 / 30) { this._flagT = 0; this._updateFlags(dt); }
  }

  /** Quality changed: crowd budget and shadow casting follow the tier. */
  applyQuality(settings) {
    const shadows = !!settings.shadows;
    this.local.traverse((o) => {
      if (!o.isMesh || o.userData.castDefault === undefined) return;
      o.castShadow = shadows && o.userData.castDefault;
    });
    const seatCast = shadows && settings.shadowMapSize >= 2048;
    for (const im of this.seatMeshes) im.castShadow = seatCast;
    if (this.crowd) this.setCrowd(this._crowdFrac ?? this.look.crowd, true);
  }

  dispose() {
    if (this.crowd) { this.crowd.dispose(); this.crowd = null; }
    if (this.court) { this.court.dispose(); this.court = null; }
    for (const im of this.seatMeshes) im.dispose();
    this.local.traverse((o) => { if (o.isInstancedMesh && !o.userData.disposed) { o.userData.disposed = true; o.dispose(); } });
    for (const g of this._owned.geometries) g.dispose();
    for (const m of this._owned.twins) unregisterOcclusionTwin(m);
    for (const t of this._owned.textures) t.dispose();
    for (const m of this._owned.materials) m.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
    this._owned = { geometries: [], textures: [], materials: [], twins: [] };
  }
}

/** Yaw, then tilt about the object's own x axis (lamp heads aimed down at the court). */
function yawTilt(x, y, z, yaw, tilt) {
  return new THREE.Matrix4().makeRotationY(yaw).multiply(_m4b.makeRotationX(tilt)).setPosition(x, y, z);
}

/** A plane (facing +z) laid flat (facing +y), then turned yaw about y. */
function flatMatrix(x, y, z, yaw) {
  return new THREE.Matrix4().makeRotationY(yaw).multiply(_m4b.makeRotationX(-HALF_PI)).setPosition(x, y, z);
}

/** A frame helper offset along its local z (roofs over a footprint whose centre is not the frame's). */
function Fz(F, dz) {
  return (x, y, z, ry = 0, s = 1, rx = 0, rz = 0) => F(x, y, z + dz, ry, s, rx, rz);
}

export { liftCourtColor, benchGeometry as _benchGeometry, propInstMaterial as _propInstMaterial };
