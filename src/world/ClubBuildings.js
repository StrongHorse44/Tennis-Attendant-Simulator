import * as THREE from 'three';
import { SIZES } from '../utils/Constants.js';
import { getMaterial, registerNightGlow } from '../graphics/Materials.js';
import { createCanvasTexture } from '../graphics/Textures.js';
import {
  getGeometry, boxGeo, cylinderGeo, sphereGeo, icoGeo, coneGeo, mergeParts,
} from '../graphics/GeometryUtils.js';
import {
  Building, P, M, at, HALF_PI, C, V, Mat, wallPieces, bevelBox, prismGeo, pyramidGeo, atlasPlane, atlasDisc,
  signPlane, regionUV, ATLAS, SurfaceBuilder, segMatrix, glassPane, awningGeo, contactFrameGeo,
} from './Building.js';
import { artUV, artAspect } from './InteriorArt.js';

/**
 * ClubBuildings — the enterable buildings besides the pro shop:
 *  - Clubhouse: lobby + reception, members' lounge (fireplace, trophy case), café/bar opening onto
 *    the patio, and a locker wing (photo corridor, men's and women's locker rooms, door to the pool).
 *  - FitnessCenter: gym (treadmills, racks, mirror wall), wellness studio, juice-bar lobby.
 *  - PoolHouse: changing cubicles + snack bar, with the pool deck, pool, loungers and fence.
 *
 * Everything is built with the Building kit (merged by material, cutaway bands, compound physics).
 * Room layouts are derived from the footprints in map.json; the matching detectable areas
 * (clubhouseLobby, memberLounge, cafe, lockerRoom, fitnessCenter, poolHouse, pool) live in map.json.
 */

const T = 0.3;          // exterior wall thickness
const HT = T / 2;
const LI = 0.03;        // interior lining thickness
const PT = 0.16;        // partition thickness
const CUT_ABOVE_FLOOR = 2.35;

const WOOD = { light: 0xc79a62, mid: 0xa8743f, dark: 0x6b4a2e, walnut: 0x5a3a22 };
const MIRROR = 0xe8eef2; // mirrors ride in the metal list (glossy, reflects the env map)
const FABRIC = { green: 0x3c6e4d, cream: 0xeadfc6, rust: 0xb8643e, navy: 0x2c3e5c, sage: 0x8fae8b, rose: 0xd98a8a };

/** A plane mapped to an interior-atlas region, `width` wide (height from the region's aspect). */
function artPlane(name, width) {
  const h = +(width * artAspect(name)).toFixed(4);
  const [u0, v0, u1, v1] = artUV(name);
  return { geo: atlasPlane(`art-${name}`, width, h, u0, v0, u1, v1), h };
}

// ───────────────────────────── pool water ─────────────────────────────

function waterTexture() {
  return createCanvasTexture(256, (ctx, S, rand) => {
    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#2f9fd0'); g.addColorStop(0.5, '#3bb2dd'); g.addColorStop(1, '#2f9fd0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    // caustic net (drawn wrapped so the tile repeats seamlessly)
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? 'rgba(255,255,255,0.35)' : 'rgba(200,245,255,0.22)';
      ctx.lineWidth = pass ? 1.4 : 3;
      ctx.beginPath();
      for (let i = 0; i < 70; i++) {
        const x = rand() * S, y = rand() * S, a = rand() * Math.PI * 2, l = 10 + rand() * 22;
        for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
          ctx.moveTo(x + ox, y + oy);
          ctx.quadraticCurveTo(x + ox + Math.cos(a + 1) * l, y + oy + Math.sin(a + 1) * l, x + ox + Math.cos(a) * l * 1.6, y + oy + Math.sin(a) * l * 1.6);
        }
      }
      ctx.stroke();
    }
  }, { key: 'bld-water', seed: 53 });
}

function waterMaterial() {
  return getMaterial('bld-poolWater', () => {
    const map = waterTexture().clone(); // own offset (animated)
    map.needsUpdate = true;
    map.repeat.set(1, 1);
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, map, roughness: 0.06, metalness: 0.1, envMapIntensity: 1.3,
      emissive: 0x2fb6e8, emissiveMap: map,
    });
    registerNightGlow(m, 0.75, 0.04);
    return m;
  });
}

// ───────────────────────────── ClubBuilding (shell + furniture kit) ─────────────────────────────

export class ClubBuilding extends Building {
  /** Heights for one storey: F floor top, cut band height, ceiling, wall top, eave. */
  _levels(F, h) {
    return { F, cut: F + CUT_ABOVE_FLOOR, ceilY: h, wallTop: h + 0.06, eaveY: h + 0.12 };
  }

  /**
   * Exterior wall on a footprint edge. axis 'x' (runs along x at z = fixed) or 'z'.
   * inward: +1/-1 toward the inside (perpendicular axis). ext = [a0, a1] outer extent along the
   * axis, inner = [a0, a1] interior extent (for the lining). lv: levels. Openings: {a, b, y0, y1}.
   */
  _extWall(L, I, axis, fixed, inward, ext, inner, lv, openings = [], { lining = true, colors = null, phys = true } = {}) {
    L.walls.push(...wallPieces(axis, ext[0], ext[1], fixed, T, 0, lv.wallTop, openings, undefined, lv.cut));
    if (lining && inner) this._lining(I, axis, fixed + inward * HT, inward, inner, lv, openings, colors);
    if (phys) this._wallPhysics(axis, ext[0], ext[1], fixed, T, Math.min(lv.wallTop, 3), openings);
    for (const o of openings) if (o.y0 < 0.5) this._jambs(L, axis, fixed, o, T + 0.04, lv, C.trim);
  }

  /** Interior lining (two colour bands + chair rail + baseboard) on a wall face. */
  _lining(I, axis, face, inward, inner, lv, openings = [], colors = null) {
    const lo = (colors && colors[0]) || C.wainscot, hi = (colors && colors[1]) || C.interior;
    const c = face + inward * LI / 2;
    I.interior.push(...wallPieces(axis, inner[0], inner[1], c, LI, lv.F, 1.0, openings, lo, lv.cut));
    I.interior.push(...wallPieces(axis, inner[0], inner[1], c, LI, 1.0, lv.ceilY, openings, hi, lv.cut));
    I.trim.push(...wallPieces(axis, inner[0], inner[1], face + inward * (LI + 0.02), 0.04, 0.97, 1.03, openings, C.trim));
    I.trim.push(...wallPieces(axis, inner[0], inner[1], face + inward * (LI + 0.015), 0.03, lv.F, lv.F + 0.12, openings, C.woodDark));
  }

  /** Interior partition (both faces lined), with physics. */
  _partition(I, axis, a0, a1, fixed, lv, openings = [], colors = null) {
    const lo = (colors && colors[0]) || C.wainscot, hi = (colors && colors[1]) || C.interior;
    I.interior.push(...wallPieces(axis, a0, a1, fixed, PT, lv.F, 1.0, openings, lo, lv.cut));
    I.interior.push(...wallPieces(axis, a0, a1, fixed, PT, 1.0, lv.ceilY, openings, hi, lv.cut));
    I.trim.push(...wallPieces(axis, a0, a1, fixed, PT + 0.08, 0.97, 1.03, openings, C.trim));
    I.trim.push(...wallPieces(axis, a0, a1, fixed, PT + 0.06, lv.F, lv.F + 0.12, openings, C.woodDark));
    this._wallPhysics(axis, a0, a1, fixed, PT, Math.min(lv.ceilY, 3), openings);
    for (const o of openings) if (o.y0 < 0.5) this._jambs(I, axis, fixed, o, PT + 0.1, lv, C.trim);
  }

  /** Door casing (two jambs + head) through a wall of depth d. */
  _jambs(L, axis, fixed, o, d, lv, color) {
    const y0 = lv.F, y1 = o.y1, w = 0.09;
    const jamb = (a) => (axis === 'x'
      ? P(boxGeo(w, y1 - y0, d), M(a, (y0 + y1) / 2, fixed), color)
      : P(boxGeo(d, y1 - y0, w), M(fixed, (y0 + y1) / 2, a), color));
    L.trim.push(jamb(o.a + w / 2), jamb(o.b - w / 2));
    const hw = o.b - o.a;
    L.trim.push(axis === 'x' ? P(boxGeo(hw, 0.08, d), M((o.a + o.b) / 2, y1 - 0.04, fixed), color)
      : P(boxGeo(d, 0.08, hw), M(fixed, y1 - 0.04, (o.a + o.b) / 2), color));
  }

  /** Floor slab (visual in `list`, physics top at F). */
  _floorSlab(list, x0, x1, z0, z1, F, color) {
    list.push(P(boxGeo(x1 - x0, F, z1 - z0), M((x0 + x1) / 2, F / 2, (z0 + z1) / 2), color));
    this._physBox((x0 + x1) / 2, F - 0.1, (z0 + z1) / 2, (x1 - x0) / 2, 0.1, (z1 - z0) / 2);
  }

  /** Ceiling panel (roof layer: hidden with the roof, seen through doors from outside). */
  _ceiling(L, x0, x1, z0, z1, y) {
    L.roofTrim.push(P(boxGeo(x1 - x0, 0.04, z1 - z0), M((x0 + x1) / 2, y + 0.02, (z0 + z1) / 2), C.ceiling));
  }

  /** Inside face of a surface-mounted window: casing, stool and a glass pane. base: +z into the room. */
  _innerWindow(I, base, w, h, variant = 0) {
    const c = 0.08;
    I.glass.push(P(glassPane(w, h, variant), at(base, 0, 0, 0.006)));
    I.trim.push(P(boxGeo(w + 2 * c, c, 0.04), at(base, 0, h / 2 + c / 2, 0.02), C.trim));
    I.trim.push(P(boxGeo(c, h, 0.04), at(base, -w / 2 - c / 2, 0, 0.02), C.trim));
    I.trim.push(P(boxGeo(c, h, 0.04), at(base, w / 2 + c / 2, 0, 0.02), C.trim));
    I.trim.push(P(bevelBox(w + 0.3, 0.05, 0.16, 0.015), at(base, 0, -h / 2 - 0.025, 0.07), C.trim));
  }

  /** Window on both faces of an exterior wall. outBase: exterior face (+z out); the inner face is T behind. */
  _twoWayWindow(L, I, outBase, w, h, opts = {}) {
    this._window(L, outBase, w, h, opts);
    this._innerWindow(I, at(outBase, 0, 0, -T - LI, Math.PI), w, h, ((opts.variant || 0) + 1) & 3);
  }

  /** Doorway leaves swung open inside + threshold + transom. base: bottom centre on the outer face, +z out. */
  _openDoor(L, base, w, h, { double = true, color = C.green, depth = T, glassy = true } = {}) {
    const lw = double ? w / 2 - 0.03 : w - 0.04;
    L.metal.push(P(boxGeo(w, 0.02, depth + 0.04), at(base, 0, 0.01, -depth / 2), C.brass));
    const sides = double ? [-1, 1] : [1];
    for (const s of sides) {
      // leaf rotated 90° against the inside of the wall, hinge at the jamb
      const hx = s * (w / 2 - 0.05);
      const leaf = at(base, hx, 0, -depth - lw / 2 - 0.03, HALF_PI);
      L.trim.push(P(bevelBox(lw, h - 0.04, 0.05, 0.015), at(leaf, 0, h / 2, 0), color));
      if (glassy) L.store.push(P(atlasPlane('doorLite', +(lw - 0.2).toFixed(3), +(h * 0.5).toFixed(3), 0, 0, 1, 1), at(leaf, 0, h * 0.62, 0.03)));
      L.metal.push(P(cylinderGeo(0.016, 0.016, 0.4, 6), at(leaf, -s * (lw / 2 - 0.12), h * 0.45, 0.06), C.brass));
    }
  }

  /** Physics box for a piece of furniture (centre x, z; size w × d; height h above floor). */
  _solid(x, z, w, d, h = 1, ry = 0) {
    const sw = Math.abs(Math.cos(ry)) * w + Math.abs(Math.sin(ry)) * d;
    const sd = Math.abs(Math.sin(ry)) * w + Math.abs(Math.cos(ry)) * d;
    this._physBox(x, h / 2 + 0.05, z, sw / 2, h / 2, sd / 2);
  }

  /** Soft contact shadows for several rectangles in one mesh. */
  _contactShadows(rects) {
    const geos = rects.map(([x0, x1, z0, z1, y = 0.05]) => contactFrameGeo(x0 - 0.04, x1 + 0.04, z0 - 0.04, z1 + 0.04, 1.3, { front: y, back: y, left: y, right: y }));
    const geo = mergeParts(geos.map(g => ({ geometry: g })));
    for (const g of geos) g.dispose();
    const m = new THREE.Mesh(geo, Mat.contact());
    m.name = `${this.type}:contact`;
    m.renderOrder = 1;
    m.userData.noAO = true;
    this.mesh.add(m);
  }

  // ───────────── furniture (all positions are floor-relative via base = M(x, F, z, ry)) ─────────────

  _sofa(I, base, len, color, { cushions = 0, back = true } = {}) {
    const n = cushions || Math.max(1, Math.round(len / 0.72));
    const dark = new THREE.Color(color).multiplyScalar(0.78).getHex();
    I.trim.push(P(bevelBox(len, 0.26, 0.82, 0.04), at(base, 0, 0.19, 0), dark));
    for (let i = 0; i < n; i++) {
      const cw = (len - 0.36) / n;
      I.trim.push(P(bevelBox(cw - 0.03, 0.15, 0.62, 0.06), at(base, -len / 2 + 0.18 + cw * (i + 0.5), 0.39, 0.07), color));
      if (back) I.trim.push(P(bevelBox(cw - 0.03, 0.38, 0.16, 0.07), at(base, -len / 2 + 0.18 + cw * (i + 0.5), 0.64, -0.24, 0, 1, -0.12), color));
    }
    if (back) I.trim.push(P(bevelBox(len, 0.5, 0.16, 0.05), at(base, 0, 0.56, -0.34), dark));
    for (const s of [-1, 1]) I.trim.push(P(bevelBox(0.18, 0.4, 0.82, 0.07), at(base, s * (len / 2 - 0.09), 0.45, 0), color));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) I.trim.push(P(cylinderGeo(0.03, 0.025, 0.08, 6), at(base, sx * (len / 2 - 0.08), 0.04, sz * 0.33), C.woodDark));
  }

  _chair(I, base, color = WOOD.mid, seat = null) {
    I.trim.push(P(bevelBox(0.42, 0.05, 0.42, 0.015), at(base, 0, 0.46, 0), color));
    if (seat) I.trim.push(P(bevelBox(0.38, 0.04, 0.38, 0.015), at(base, 0, 0.5, 0), seat));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) I.trim.push(P(boxGeo(0.035, 0.44, 0.035), at(base, sx * 0.18, 0.22, sz * 0.18), color));
    I.trim.push(P(bevelBox(0.42, 0.36, 0.04, 0.012), at(base, 0, 0.72, -0.19, 0, 1, -0.08), color));
  }

  _roundTable(I, base, r = 0.4, h = 0.74, top = WOOD.mid, cloth = null) {
    I.trim.push(P(cylinderGeo(0.22, 0.26, 0.04, 14), at(base, 0, 0.02, 0), C.iron));
    I.trim.push(P(cylinderGeo(0.035, 0.035, h - 0.05, 8), at(base, 0, h / 2, 0), C.iron));
    I.trim.push(P(cylinderGeo(r, r, 0.04, 22), at(base, 0, h, 0), cloth || top));
    if (cloth) I.trim.push(P(cylinderGeo(r + 0.02, r + 0.05, 0.16, 22, true), at(base, 0, h - 0.08, 0), cloth));
  }

  _table(I, base, w, d, h = 0.74, top = WOOD.mid, legs = WOOD.dark) {
    I.trim.push(P(bevelBox(w, 0.05, d, 0.015), at(base, 0, h - 0.025, 0), top));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) I.trim.push(P(boxGeo(0.05, h - 0.05, 0.05), at(base, sx * (w / 2 - 0.06), (h - 0.05) / 2, sz * (d / 2 - 0.06)), legs));
  }

  _stool(I, base, h = 0.72, seat = FABRIC.green) {
    I.trim.push(P(cylinderGeo(0.19, 0.19, 0.07, 14), at(base, 0, h, 0), seat));
    I.metal.push(P(cylinderGeo(0.025, 0.025, h, 6), at(base, 0, h / 2, 0), C.chrome));
    I.metal.push(P(cylinderGeo(0.2, 0.22, 0.03, 14), at(base, 0, 0.015, 0), C.chrome));
    I.metal.push(P(cylinderGeo(0.15, 0.15, 0.02, 14, true), at(base, 0, h * 0.38, 0), C.chrome));
  }

  _plant(I, base, s = 1, pot = 0xb8643e) {
    const r = this._rand;
    I.trim.push(P(cylinderGeo(0.22 * s, 0.17 * s, 0.4 * s, 12), at(base, 0, 0.2 * s, 0), pot));
    I.trim.push(P(cylinderGeo(0.03, 0.04, 0.7 * s, 5), at(base, 0, 0.6 * s, 0), C.woodDark));
    for (let k = 0; k < 5; k++) {
      I.trim.push(P(icoGeo((0.24 - k * 0.025) * s, 0), at(base, (r() - 0.5) * 0.28 * s, (0.75 + k * 0.2) * s, (r() - 0.5) * 0.28 * s, r() * 3), k % 2 ? C.leaf : C.leafDark));
    }
  }

  _rug(I, base, w, d, color, border = C.trim) {
    I.trim.push(P(bevelBox(w, 0.014, d, 0.005), at(base, 0, 0.007, 0), border));
    I.trim.push(P(bevelBox(w - 0.24, 0.022, d - 0.24, 0.006), at(base, 0, 0.011, 0), color));
  }

  /** Framed art-atlas picture on a wall. base: centre on the wall face, +z out. */
  _frame(I, base, name, width, frameColor = C.woodDark) {
    const a = artPlane(name, width);
    I.trim.push(P(bevelBox(width + 0.1, a.h + 0.1, 0.04, 0.012), at(base, 0, 0, 0.02), frameColor));
    I.deco.push(P(a.geo, at(base, 0, 0, 0.045)));
    return a.h;
  }

  /** Flat sign (no frame) from the interior atlas. */
  _artSign(list, base, name, width) {
    const a = artPlane(name, width);
    list.push(P(a.geo, at(base, 0, 0, 0.01)));
    return a.h;
  }

  _sconce(I, base) {
    I.metal.push(P(bevelBox(0.12, 0.2, 0.03, 0.01), at(base, 0, 0, 0.015), C.brass));
    I.metal.push(P(cylinderGeo(0.015, 0.015, 0.16, 6), at(base, 0, 0.02, 0.09, 0, 1, HALF_PI), C.brass));
    I.lamp.push(P(cylinderGeo(0.07, 0.1, 0.16, 10), at(base, 0, 0.1, 0.17)));
  }

  _lockers(I, base, n, color = FABRIC.green) {
    const w = 0.5, h = 1.82, d = 0.46;
    I.trim.push(P(boxGeo(n * w + 0.04, 0.1, d - 0.04), at(base, 0, 0.05, 0), C.woodDark));
    for (let i = 0; i < n; i++) {
      const x = -((n - 1) * w) / 2 + i * w;
      I.trim.push(P(bevelBox(w - 0.02, h, d, 0.012), at(base, x, 0.1 + h / 2, 0), color));
      for (let v = 0; v < 3; v++) I.trim.push(P(boxGeo(w * 0.5, 0.02, 0.01), at(base, x, 0.1 + h - 0.22 - v * 0.05, d / 2 + 0.004), 0x1e2b22));
      I.metal.push(P(boxGeo(0.03, 0.14, 0.03), at(base, x + w * 0.3, 0.1 + h * 0.52, d / 2 + 0.02), C.chrome));
      I.metal.push(P(boxGeo(0.1, 0.05, 0.008), at(base, x, 0.1 + h - 0.1, d / 2 + 0.004), C.brass));
    }
    I.trim.push(P(boxGeo(n * w + 0.06, 0.06, d + 0.04), at(base, 0, 0.1 + h + 0.03, 0), C.trim));
  }

  _bench(I, base, len, top = WOOD.light) {
    I.trim.push(P(bevelBox(len, 0.06, 0.38, 0.015), at(base, 0, 0.44, 0), top));
    for (const s of [-1, 1]) I.trim.push(P(bevelBox(0.06, 0.42, 0.32, 0.01), at(base, s * (len / 2 - 0.2), 0.21, 0), C.woodDark));
  }

  /** Vanity with sinks and a wall mirror (base on the wall face, +z out). */
  _vanity(I, base, len, sinks = 2) {
    I.trim.push(P(bevelBox(len, 0.78, 0.5, 0.02), at(base, 0, 0.39, 0.27), WOOD.walnut));
    I.trim.push(P(bevelBox(len + 0.06, 0.06, 0.58, 0.015), at(base, 0, 0.81, 0.3), 0xe8e2d4));
    for (let i = 0; i < sinks; i++) {
      const x = -len / 2 + (len / sinks) * (i + 0.5);
      I.trim.push(P(cylinderGeo(0.19, 0.16, 0.06, 16), at(base, x, 0.85, 0.32), 0xffffff));
      I.metal.push(P(cylinderGeo(0.02, 0.02, 0.22, 6), at(base, x, 0.94, 0.1), C.chrome));
      I.metal.push(P(cylinderGeo(0.015, 0.015, 0.14, 6), at(base, x, 1.04, 0.16, 0, 1, HALF_PI), C.chrome));
    }
    I.trim.push(P(bevelBox(len - 0.1, 0.95, 0.03, 0.01), at(base, 0, 1.55, 0.015), C.trim));
    I.metal.push(P(boxGeo(len - 0.24, 0.82, 0.01), at(base, 0, 1.55, 0.034), MIRROR));
    for (let i = 0; i < sinks; i++) this._sconce(I, at(base, -len / 2 + (len / sinks) * (i + 0.5), 2.12, 0));
  }

  /** Shower stall against a wall (base on the wall face, +z out): tiled back, tray, head, curtain. */
  _shower(I, base, w = 0.95, curtain = 0xdfe9ef) {
    I.tile.push(P(boxGeo(w, 2.1, 0.04), at(base, 0, 1.05, 0.02), 0xd9e6ea));
    for (const s of [-1, 1]) I.tile.push(P(boxGeo(0.05, 2.1, 0.95), at(base, s * w / 2, 1.05, 0.48), 0xd9e6ea));
    I.trim.push(P(bevelBox(w - 0.04, 0.06, 0.9, 0.02), at(base, 0, 0.03, 0.47), 0xffffff));
    I.metal.push(P(cylinderGeo(0.015, 0.015, 0.3, 6), at(base, 0, 1.9, 0.12, 0, 1, HALF_PI), C.chrome));
    I.metal.push(P(cylinderGeo(0.07, 0.05, 0.04, 10), at(base, 0, 1.87, 0.27), C.chrome));
    I.metal.push(P(cylinderGeo(0.012, 0.012, w, 6), at(base, 0, 2.0, 0.93, 0, 1, 0, HALF_PI), C.chrome));
    I.trim.push(P(bevelBox(w * 0.55, 1.75, 0.03, 0.01), at(base, -w * 0.2, 1.1, 0.93), curtain));
  }

  _fireplace(I, base, lv) {
    const F = 0; // base already at floor height
    I.trim.push(P(bevelBox(2.0, 0.1, 0.7, 0.02), at(base, 0, F + 0.05, 0.35), C.stone));
    for (const s of [-1, 1]) I.trim.push(P(bevelBox(0.35, 1.2, 0.4, 0.02), at(base, s * 0.62, F + 0.6, 0.2), C.stone));
    I.trim.push(P(bevelBox(1.6, 0.3, 0.4, 0.02), at(base, 0, F + 1.05, 0.2), C.stone));
    I.trim.push(P(boxGeo(0.9, 0.9, 0.3), at(base, 0, F + 0.45, 0.12), 0x1f1a17));
    I.trim.push(P(bevelBox(2.0, 0.08, 0.42, 0.015), at(base, 0, F + 1.24, 0.22), WOOD.walnut));
    // chimney breast above the mantel (split at the cut height so the upper band cuts away cleanly)
    const top = lv.ceilY - lv.F, cut = lv.cut - lv.F;
    I.interior.push(P(boxGeo(1.6, cut - 1.28, 0.36), at(base, 0, (1.28 + cut) / 2, 0.18), C.interior));
    I.interior.push(P(boxGeo(1.6, top - cut, 0.36), at(base, 0, (cut + top) / 2, 0.18), C.interior));
    // logs + glowing embers
    for (const [x, ry] of [[-0.18, 0.3], [0.16, -0.25]]) I.trim.push(P(cylinderGeo(0.07, 0.07, 0.6, 8), at(base, x, F + 0.1, 0.25, ry, 1, 0, HALF_PI), 0x5a3a22));
    I.lamp.push(P(icoGeo(0.16, 0), at(base, 0, F + 0.14, 0.24, 0, [1.6, 0.6, 0.8])));
    I.metal.push(P(boxGeo(0.95, 0.5, 0.02), at(base, 0, F + 0.3, 0.44), C.iron)); // screen
    for (const s of [-1, 1]) {
      I.metal.push(P(cylinderGeo(0.03, 0.05, 0.3, 8), at(base, s * 0.75, F + 1.43, 0.25), C.brass));
      I.lamp.push(P(cylinderGeo(0.02, 0.02, 0.12, 6), at(base, s * 0.75, F + 1.64, 0.25)));
    }
    this._frame(I, at(base, 0, F + 1.82, 0.36), 'painting', 1.15, 0xb08a3a);
  }

  _trophyCase(I, base, len) {
    const d = 0.45;
    I.trim.push(P(bevelBox(len, 0.9, d, 0.02), at(base, 0, 0.45, d / 2), WOOD.walnut));
    for (let i = 0; i < 3; i++) I.trim.push(P(bevelBox(len / 3 - 0.08, 0.6, 0.02, 0.01), at(base, -len / 3 + (i * len) / 3, 0.45, d + 0.005), WOOD.dark));
    I.trim.push(P(boxGeo(len, 0.03, d - 0.02), at(base, 0, 1.45, d / 2), 0xf0ebe0));
    I.trim.push(P(bevelBox(len + 0.04, 0.08, d + 0.04, 0.015), at(base, 0, 2.1, d / 2), WOOD.walnut));
    I.trim.push(P(boxGeo(len, 1.15, 0.02), at(base, 0, 1.5, 0.02), 0x2d5a3d));
    for (const s of [-1, 1]) I.trim.push(P(boxGeo(0.05, 1.2, d), at(base, s * (len / 2 - 0.025), 1.5, d / 2), WOOD.walnut));
    I.store.push(P(atlasPlane('caseGlass', +(len - 0.1).toFixed(3), 1.15, 0, 0, 1, 1), at(base, 0, 1.5, d - 0.01)));
    const r = this._rand;
    for (const y of [0.92, 1.47]) {
      for (let i = 0; i < 5; i++) {
        const x = -len / 2 + 0.3 + (i * (len - 0.6)) / 4, s = 0.7 + r() * 0.5;
        I.metal.push(P(boxGeo(0.12 * s, 0.06, 0.12 * s), at(base, x, y + 0.03, d / 2), 0x3a2a1a));
        I.metal.push(P(cylinderGeo(0.015, 0.02, 0.12 * s, 6), at(base, x, y + 0.06 + 0.06 * s, d / 2), C.brass));
        if (i % 2) I.metal.push(P(cylinderGeo(0.1 * s, 0.03 * s, 0.18 * s, 12), at(base, x, y + 0.12 + 0.2 * s, d / 2), C.brass));
        else I.metal.push(P(cylinderGeo(0.09 * s, 0.09 * s, 0.015, 16), at(base, x, y + 0.12 + 0.12 * s, d / 2, 0, 1, HALF_PI), 0xd9d9d9));
      }
    }
  }

  _bookshelf(I, base, w, h = 2.0) {
    const r = this._rand;
    I.trim.push(P(bevelBox(w, h, 0.36, 0.015), at(base, 0, h / 2, 0.18), WOOD.walnut));
    I.trim.push(P(boxGeo(w - 0.1, h - 0.1, 0.02), at(base, 0, h / 2, 0.35), 0x3a2616));
    const cols = [0x7a2e2e, 0x2d4a6b, 0x3c6e4d, 0xc9a54c, 0xe0d6c0, 0x5a3a22];
    for (let s = 0; s < 4; s++) {
      const y = 0.08 + s * ((h - 0.1) / 4);
      I.trim.push(P(boxGeo(w - 0.08, 0.03, 0.32), at(base, 0, y, 0.18), WOOD.mid));
      let x = -w / 2 + 0.08;
      while (x < w / 2 - 0.12) {
        const bw = 0.04 + r() * 0.05, bh = 0.24 + r() * 0.12;
        I.trim.push(P(boxGeo(bw, bh, 0.24), at(base, x + bw / 2, y + 0.015 + bh / 2, 0.2, 0, 1, 0, r() < 0.1 ? 0.2 : 0), cols[(r() * cols.length) | 0]));
        x += bw + 0.005;
      }
    }
  }

  _floorLamp(I, base) {
    I.metal.push(P(cylinderGeo(0.16, 0.18, 0.03, 12), at(base, 0, 0.015, 0), C.brass));
    I.metal.push(P(cylinderGeo(0.018, 0.018, 1.45, 6), at(base, 0, 0.74, 0), C.brass));
    I.lamp.push(P(cylinderGeo(0.16, 0.24, 0.3, 12, true), at(base, 0, 1.55, 0)));
  }

  _tableLamp(I, base) {
    I.metal.push(P(cylinderGeo(0.06, 0.08, 0.2, 10), at(base, 0, 0.1, 0), C.brass));
    I.lamp.push(P(cylinderGeo(0.1, 0.15, 0.18, 10, true), at(base, 0, 0.3, 0)));
  }

  /** Bottles for a bar shelf (row along local x). */
  _bottles(I, base, len) {
    const r = this._rand;
    const cols = [0x2f5d3a, 0x6b3a1e, 0xc9a54c, 0x9fc3d6, 0x8a2e3a, 0xe6d9b8];
    for (let x = -len / 2 + 0.08; x < len / 2 - 0.05; x += 0.1 + r() * 0.04) {
      const h = 0.2 + r() * 0.1, c = cols[(r() * cols.length) | 0];
      I.trim.push(P(cylinderGeo(0.035, 0.035, h, 8), at(base, x, h / 2, 0), c));
      I.trim.push(P(cylinderGeo(0.012, 0.02, 0.08, 6), at(base, x, h + 0.04, 0), c));
    }
  }

  _treadmill(I, base) {
    I.trim.push(P(bevelBox(0.78, 0.2, 1.8, 0.04), at(base, 0, 0.1, 0), 0x2b2f33));
    I.trim.push(P(boxGeo(0.52, 0.02, 1.5), at(base, 0, 0.21, -0.05), 0x151719));
    for (const s of [-1, 1]) {
      I.metal.push(P(boxGeo(0.06, 1.1, 0.08), at(base, s * 0.34, 0.72, 0.78, 0, 1, -0.18), 0x9aa1a6));
      I.metal.push(P(boxGeo(0.05, 0.05, 0.5), at(base, s * 0.34, 1.1, 0.6), 0x9aa1a6));
    }
    I.trim.push(P(bevelBox(0.72, 0.3, 0.18, 0.03), at(base, 0, 1.3, 0.86, 0, 1, -0.5), 0x2b2f33));
    I.lamp.push(P(boxGeo(0.4, 0.14, 0.01), at(base, 0, 1.33, 0.8, 0, 1, -0.5)));
  }

  _dumbbellRack(I, base, len) {
    I.metal.push(P(boxGeo(len, 0.05, 0.5), at(base, 0, 0.35, 0, 0, 1, 0.25), 0x2b2f33));
    I.metal.push(P(boxGeo(len, 0.05, 0.4), at(base, 0, 0.75, -0.05, 0, 1, 0.25), 0x2b2f33));
    for (const s of [-1, 1]) I.metal.push(P(boxGeo(0.06, 0.8, 0.5), at(base, s * (len / 2 - 0.03), 0.4, 0), 0x2b2f33));
    const n = Math.floor(len / 0.3);
    for (const [y, z] of [[0.43, 0.05], [0.83, -0.02]]) {
      for (let i = 0; i < n; i++) {
        const x = -len / 2 + 0.2 + i * ((len - 0.4) / (n - 1)), s = 0.8 + (i / n) * 0.6;
        I.metal.push(P(cylinderGeo(0.015, 0.015, 0.26, 6), at(base, x, y, z, 0, 1, HALF_PI), C.chrome));
        for (const e of [-1, 1]) I.trim.push(P(cylinderGeo(0.05 * s, 0.05 * s, 0.06, 8), at(base, x, y, z + e * 0.1, 0, 1, HALF_PI), 0x1e1e1e));
      }
    }
  }

  _weightBench(I, base) {
    I.trim.push(P(bevelBox(0.3, 0.08, 1.2, 0.03), at(base, 0, 0.46, 0), 0x1f1f1f));
    I.metal.push(P(boxGeo(0.08, 0.42, 0.08), at(base, 0, 0.21, 0.45), 0x9aa1a6));
    I.metal.push(P(boxGeo(0.08, 0.42, 0.08), at(base, 0, 0.21, -0.45), 0x9aa1a6));
    I.metal.push(P(boxGeo(0.5, 0.04, 0.06), at(base, 0, 0.02, 0.45), 0x9aa1a6));
    I.metal.push(P(boxGeo(0.5, 0.04, 0.06), at(base, 0, 0.02, -0.45), 0x9aa1a6));
    for (const s of [-1, 1]) I.metal.push(P(boxGeo(0.05, 1.0, 0.05), at(base, s * 0.5, 0.5, -0.55), 0x9aa1a6));
    I.metal.push(P(cylinderGeo(0.018, 0.018, 1.8, 8), at(base, 0, 1.0, -0.5, 0, 1, 0, HALF_PI), C.chrome));
    for (const s of [-1, 1]) I.trim.push(P(cylinderGeo(0.2, 0.2, 0.05, 16), at(base, s * 0.75, 1.0, -0.5, 0, 1, 0, HALF_PI), 0x1e1e1e));
  }

  _powerRack(I, base) {
    for (const [x, z] of [[-0.6, -0.5], [0.6, -0.5], [-0.6, 0.5], [0.6, 0.5]]) I.metal.push(P(boxGeo(0.07, 2.2, 0.07), at(base, x, 1.1, z), 0x2b2f33));
    for (const z of [-0.5, 0.5]) I.metal.push(P(boxGeo(1.27, 0.07, 0.07), at(base, 0, 2.2, z), 0x2b2f33));
    for (const x of [-0.6, 0.6]) I.metal.push(P(boxGeo(0.07, 0.07, 1.07), at(base, x, 2.2, 0), 0x2b2f33));
    I.metal.push(P(cylinderGeo(0.02, 0.02, 2.0, 8), at(base, 0, 1.4, 0.45, 0, 1, 0, HALF_PI), C.chrome));
    for (const s of [-1, 1]) for (const k of [0, 1]) I.trim.push(P(cylinderGeo(0.24 - k * 0.05, 0.24 - k * 0.05, 0.05, 16), at(base, s * (0.8 + k * 0.06), 1.4, 0.45, 0, 1, 0, HALF_PI), k ? 0xc23b4e : 0x1e1e1e));
    I.rubber.push(P(boxGeo(1.4, 0.02, 1.2), at(base, 0, 0.01, 0)));
  }

  _yogaMat(I, base, color) {
    I.trim.push(P(bevelBox(0.62, 0.012, 1.75, 0.004), at(base, 0, 0.006, 0), color));
  }

  _massageTable(I, base) {
    I.trim.push(P(bevelBox(0.7, 0.1, 1.9, 0.04), at(base, 0, 0.72, 0), 0xe7dccb));
    I.trim.push(P(bevelBox(0.66, 0.04, 1.86, 0.015), at(base, 0, 0.78, 0), 0xffffff));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) I.trim.push(P(boxGeo(0.05, 0.68, 0.05), at(base, sx * 0.28, 0.34, sz * 0.8), WOOD.light));
    I.trim.push(P(bevelBox(0.4, 0.12, 0.25, 0.05), at(base, 0, 0.84, -0.75), 0xf4efe6)); // folded towel
  }

  _towelStack(I, base, n = 5, color = 0xf4f1e8) {
    for (let i = 0; i < n; i++) I.trim.push(P(bevelBox(0.4, 0.07, 0.3, 0.03), at(base, 0, 0.035 + i * 0.07, 0, (i % 2) * 0.08), i % 3 === 1 ? 0x9ec9d9 : color));
  }

  _shelf(I, base, w, levels = 3, h = 1.8, d = 0.4) {
    for (const s of [-1, 1]) I.trim.push(P(bevelBox(0.05, h, d, 0.01), at(base, s * (w / 2 - 0.025), h / 2, d / 2), WOOD.mid));
    for (let i = 0; i < levels; i++) I.trim.push(P(bevelBox(w, 0.04, d, 0.01), at(base, 0, 0.2 + i * ((h - 0.25) / (levels - 1)), d / 2), WOOD.light));
  }
}

// ───────────────────────────── Clubhouse ─────────────────────────────

export class Clubhouse extends ClubBuilding {
  constructor(scene, physicsWorld, config) {
    super(scene, physicsWorld, 'clubhouse', config);
  }

  _build(config) {
    const w = config.width || SIZES.clubhouseWidth;
    const d = config.depth || SIZES.clubhouseDepth;
    const h = config.height || SIZES.clubhouseHeight;
    const cx = config.center.x, cz = config.center.z;
    const X0 = cx - w / 2, X1 = cx + w / 2, Z0 = cz - d / 2, Z1 = cz + d / 2;
    const lv = this._levels(0.12, h);
    const { F, cut, ceilY, eaveY } = lv;
    this.cutY = cut;
    const patioTop = 0.1;
    const L = this._lists(), I = this._lists();
    const xi0 = X0 + HT, xi1 = X1 - HT, zi0 = Z0 + HT, zi1 = Z1 - HT;       // wall inner faces
    const ii0 = xi0 + LI, ii1 = xi1 - LI, jz0 = zi0 + LI, jz1 = zi1 - LI;   // lining faces

    // Rooms: lounge | lobby | café (thirds of the main block)
    const pA = X0 + w / 3, pB = X0 + (2 * w) / 3;           // partitions (x)
    const lobbyX = cx, loungeX = (X0 + pA) / 2, cafeX = (pB + X1) / 2;
    const arch = { a: cz + 0.4, b: cz + 2.8, y0: 0, y1: 2.35 };
    const frontDoor = { a: lobbyX - 0.9, b: lobbyX + 0.9, y0: 0, y1: 2.45 };
    const cafeDoorX = X1 - 2.0;
    const cafeDoor = { a: cafeDoorX - 0.8, b: cafeDoorX + 0.8, y0: 0, y1: 2.45 };
    const backDoorX = lobbyX + 0.8;
    const backDoor = { a: backDoorX - 0.75, b: backDoorX + 0.75, y0: 0, y1: 2.3 };
    const wingDoor = { a: Z0 + 0.45, b: Z0 + 1.95, y0: 0, y1: 2.35 };

    // ── Main block shell ──
    this._extWall(L, I, 'x', Z1, -1, [X0 - HT, X1 + HT], [ii0, ii1], lv, [frontDoor, cafeDoor]);
    this._extWall(L, I, 'x', Z0, 1, [X0 - HT, X1 + HT], [ii0, ii1], lv, [backDoor]);
    this._extWall(L, I, 'z', X0, 1, [Z0 + HT, Z1 - HT], [jz0, jz1], lv, [wingDoor]);
    this._extWall(L, I, 'z', X1, -1, [Z0 + HT, Z1 - HT], [jz0, jz1], lv, []);
    this._partition(I, 'z', jz0, jz1, pA, lv, [arch]);
    this._partition(I, 'z', jz0, jz1, pB, lv, [arch]);

    // Stone plinth + corner pilasters + frieze
    L.trim.push(...wallPieces('x', X0 - HT - 0.06, X1 + HT + 0.06, Z1 + HT + 0.01, 0.1, 0, 0.45, [frontDoor, cafeDoor], C.stone));
    L.trim.push(...wallPieces('x', X0 - HT - 0.06, X1 + HT + 0.06, Z0 - HT - 0.01, 0.1, 0, 0.45, [backDoor], C.stone));
    L.trim.push(...wallPieces('z', Z0 - HT, Z1 + HT, X1 + HT + 0.01, 0.1, 0, 0.45, [], C.stone));
    L.trim.push(...wallPieces('z', Z0 - HT, Z1 + HT, X0 - HT - 0.01, 0.1, 0, 0.45, [wingDoor], C.stone));
    for (const [X, sx] of [[X0 - HT, 1], [X1 + HT, -1]]) for (const [Z, sz] of [[Z0 - HT, 1], [Z1 + HT, -1]]) {
      L.trim.push(P(boxGeo(0.36, cut - 0.45, 0.36), M(X + sx * 0.14, (0.45 + cut) / 2, Z + sz * 0.14), C.trim));
      L.trim.push(P(boxGeo(0.36, h + 0.06 - cut, 0.36), M(X + sx * 0.14, (cut + h + 0.06) / 2, Z + sz * 0.14), C.trim));
    }
    L.trim.push(P(boxGeo(w + T + 0.12, 0.3, d + T + 0.12), M(cx, eaveY - 0.24, cz), C.trim));
    this._floorSlab(I.floor, xi0, xi1, zi0, zi1, F);
    I.floor.push(P(boxGeo(frontDoor.b - frontDoor.a, F, T), M(lobbyX, F / 2, Z1)));
    I.floor.push(P(boxGeo(cafeDoor.b - cafeDoor.a, F, T), M(cafeDoorX, F / 2, Z1)));
    I.floor.push(P(boxGeo(backDoor.b - backDoor.a, F, T), M(backDoorX, F / 2, Z0)));
    this._physBox(lobbyX, F - 0.1, Z1 + HT, 0.9, 0.1, 0.3);
    this._physBox(cafeDoorX, F - 0.1, Z1 + HT, 0.8, 0.1, 0.3);
    this._physBox(backDoorX, F - 0.1, Z0 - HT, 0.75, 0.1, 0.3);

    // ── Doors ──
    this._openDoor(L, M(lobbyX, patioTop, Z1 + HT), 1.8, 2.45, { double: true });
    this._openDoor(L, M(cafeDoorX, patioTop, Z1 + HT), 1.6, 2.45, { double: true, color: C.greenLight });
    this._openDoor(L, M(backDoorX, 0, Z0 - HT, Math.PI), 1.5, 2.3, { double: false });
    L.glass.push(P(glassPane(1.8, 0.38, 2), M(lobbyX, 2.72, Z1 + HT + 0.012)));
    L.trim.push(P(boxGeo(2.1, 0.1, 0.07), M(lobbyX, 2.96, Z1 + HT + 0.035), C.trim));
    for (const s of [-1, 1]) this._lantern(L, M(lobbyX + s * 1.35, 2.2, Z1 + HT, 0));
    for (const s of [-1, 1]) this._lantern(L, M(cafeDoorX + s * 1.1, 2.2, Z1 + HT, 0), 0.85);
    this._lantern(L, M(backDoorX + 1.05, 2.05, Z0 - HT, Math.PI));
    { // back door hood
      const bd = M(backDoorX, 0, Z0 - HT, Math.PI);
      L.trim.push(P(bevelBox(1.9, 0.08, 0.75, 0.02), at(bd, 0, 2.72, 0.37), C.green));
      for (const s of [-1, 1]) L.trim.push(P(boxGeo(1, 1, 1), segMatrix(V(s * 0.85, 2.3, 0.02), V(s * 0.85, 2.68, 0.66), 0.06, 0.06).premultiply(bd), C.trim));
    }

    // ── Windows ──
    const wy = 1.65;
    [[X0 + 1.8, 0], [X0 + 4.1, 1], [X1 - 4.4, 2]].forEach(([x, v]) => this._twoWayWindow(L, I, M(x, wy, Z1 + HT, 0), 1.3, 1.6, { variant: v, box: true }));
    this._twoWayWindow(L, I, M(X0 + 3.0, wy, Z0 - HT, Math.PI), 1.3, 1.6, { variant: 3, shutters: true });
    this._twoWayWindow(L, I, M(X1 - 3.2, wy + 0.25, Z0 - HT, Math.PI), 1.3, 1.1, { variant: 1, shutters: true });
    this._twoWayWindow(L, I, M(X0 - HT, wy, cz - 0.5, -HALF_PI), 0.9, 1.4, { variant: 2, shutters: true });
    for (const oz of [-1.8, 1.8]) this._twoWayWindow(L, I, M(X1 + HT, wy, cz + oz, HALF_PI), 1.3, 1.6, { variant: oz > 0 ? 3 : 1, shutters: true });

    // ── Colonnade (split at the cut so it doesn't stand up in the way while indoors) ──
    const colZ = Z1 + HT + 0.35;
    const colXs = [X0 + 0.25, cx - 2.1, cx + 2.1, X1 - 0.25];
    for (const x of colXs) {
      L.trim.push(P(bevelBox(0.38, 0.14, 0.38, 0.02), M(x, patioTop + 0.07, colZ), C.trim));
      L.trim.push(P(cylinderGeo(0.12, 0.135, cut - patioTop - 0.14, 14), M(x, (patioTop + 0.14 + cut) / 2, colZ), C.trim));
      L.trim.push(P(cylinderGeo(0.11, 0.12, 3.1 - cut, 14), M(x, (cut + 3.1) / 2, colZ), C.trim));
      L.trim.push(P(bevelBox(0.34, 0.12, 0.34, 0.02), M(x, 3.16, colZ), C.trim));
      this._physBox(x, h / 2, colZ, 0.15, h / 2, 0.15);
    }
    L.trim.push(P(bevelBox(w + 0.6, 0.3, 0.3, 0.03), M(cx, 3.37, colZ), C.trim));

    // ── Lounge (west third) ──
    {
      const lx0 = ii0, lx1 = pA - PT / 2;
      const fz = cz + 1.6;
      this._fireplace(I, M(lx0, F, fz, HALF_PI), lv);
      this._solid(lx0 + 0.3, fz, 0.7, 2.0, 1.2);
      this._rug(I, M(lx0 + 2.9, F, fz), 3.2, 2.6, FABRIC.rust, 0xe8d9b4);
      this._sofa(I, M(lx0 + 4.3, F, fz, -HALF_PI), 2.1, FABRIC.green);
      this._solid(lx0 + 4.3, fz, 2.1, 0.85, 0.8, -HALF_PI);
      for (const s of [-1, 1]) {
        this._sofa(I, M(lx0 + 2.4, F, fz + s * 1.35, s > 0 ? Math.PI : 0), 0.95, FABRIC.cream, { cushions: 1 });
        this._solid(lx0 + 2.4, fz + s * 1.35, 0.9, 0.85, 0.8);
      }
      this._table(I, M(lx0 + 2.9, F, fz), 1.1, 0.6, 0.42, WOOD.walnut);
      I.trim.push(P(bevelBox(0.3, 0.05, 0.22, 0.01), M(lx0 + 2.8, F + 0.445, fz - 0.1, 0.3), 0x7a2e2e)); // book
      I.metal.push(P(cylinderGeo(0.12, 0.08, 0.04, 12), M(lx0 + 3.1, F + 0.44, fz + 0.12), C.brass));
      this._floorLamp(I, M(lx0 + 0.45, F, jz1 - 0.4));
      this._trophyCase(I, M(lx1, F, cz - 2.0, -HALF_PI), 2.6);
      this._solid(lx1 - 0.23, cz - 2.0, 0.46, 2.6, 2.1);
      this._bookshelf(I, M(lx0 + 1.4, F, jz0), 1.4);
      this._solid(lx0 + 1.4, jz0 + 0.2, 1.4, 0.4, 2);
      // card table
      this._table(I, M(lx0 + 3.5, F, cz - 2.4), 0.9, 0.9, 0.74, WOOD.walnut);
      I.trim.push(P(bevelBox(0.8, 0.01, 0.8, 0.004), M(lx0 + 3.5, F + 0.745, cz - 2.4), 0x2d5a3d));
      this._chair(I, M(lx0 + 3.5, F, cz - 1.75, Math.PI), WOOD.walnut, FABRIC.green);
      this._chair(I, M(lx0 + 2.85, F, cz - 2.4, HALF_PI), WOOD.walnut, FABRIC.green);
      this._solid(lx0 + 3.4, cz - 2.3, 1.1, 1.1, 0.8);
      this._frame(I, M(lx0 + 3.1, 1.75, jz0, 0), 'photo2', 0.62);
      this._sconce(I, M(lx0, 1.95, fz - 1.4, HALF_PI));
      this._sconce(I, M(lx0, 1.95, fz + 1.4, HALF_PI));
      this._plant(I, M(lx1 - 0.35, F, jz1 - 0.35), 1.1);
    }

    // ── Lobby (centre third) ──
    {
      const bx0 = pA + PT / 2, bx1 = pB - PT / 2;
      this._rug(I, M(lobbyX, F, cz + 0.8), 1.5, 5.2, FABRIC.green, C.brass);
      // reception desk (west half, back), key cabinet + crest behind it
      const rx = bx0 + 1.45, rz = jz0 + 1.55;
      I.trim.push(P(bevelBox(2.2, 1.0, 0.6, 0.03), M(rx, F + 0.5, rz), C.green));
      I.trim.push(P(bevelBox(2.36, 0.06, 0.78, 0.02), M(rx, F + 1.03, rz + 0.04), WOOD.walnut));
      for (let i = 0; i < 3; i++) I.trim.push(P(bevelBox(0.62, 0.62, 0.03, 0.01), M(rx - 0.72 + i * 0.72, F + 0.52, rz + 0.31), C.greenLight));
      I.trim.push(P(bevelBox(0.42, 0.28, 0.03, 0.01), M(rx + 0.5, F + 1.26, rz - 0.12, 0, 1, -0.3), 0x2b2f33));
      I.lamp.push(P(boxGeo(0.36, 0.22, 0.005), M(rx + 0.5, F + 1.26, rz - 0.1, 0, 1, -0.3)));
      I.metal.push(P(sphereGeo(0.05, 10, 6), M(rx - 0.7, F + 1.09, rz + 0.2, 0, [1, 0.7, 1]), C.brass));
      I.trim.push(P(bevelBox(0.36, 0.04, 0.26, 0.01), M(rx - 0.2, F + 1.08, rz + 0.1, 0.15), 0x7a2e2e)); // guest book
      I.trim.push(P(cylinderGeo(0.06, 0.05, 0.2, 10), M(rx - 0.95, F + 1.16, rz - 0.1), 0xe8f0f2)); // vase
      for (let k = 0; k < 4; k++) I.trim.push(P(icoGeo(0.06, 0), M(rx - 0.95 + (k % 2 - 0.5) * 0.08, F + 1.3 + (k >> 1) * 0.06, rz - 0.1 + ((k + 1) % 2 - 0.5) * 0.06), C.flowers[k]));
      this._stool(I, M(rx, F, rz - 0.75), 0.62, FABRIC.green);
      this._solid(rx, rz, 2.2, 0.62, 1.05);
      // key cabinet
      I.trim.push(P(bevelBox(1.3, 0.8, 0.08, 0.02), M(rx, 1.45, jz0 + 0.04), WOOD.walnut));
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) I.metal.push(P(boxGeo(0.03, 0.08, 0.03), M(rx - 0.45 + i * 0.3, 1.25 + j * 0.2, jz0 + 0.1), C.brass));
      const [u0, v0, u1, v1] = artUV('crest');
      I.deco.push(P(atlasDisc('art-crest', 0.3, u0, v0, u1, v1), M(rx, 2.12, jz0 + 0.035)));
      I.trim.push(P(cylinderGeo(0.34, 0.34, 0.03, 24), M(rx, 2.12, jz0 + 0.015, 0, 1, HALF_PI), C.brass));
      this._artSign(I.deco, M(bx1, 2.1, arch.a - 0.75, -HALF_PI).multiply(M(0, 0, 0.06)), 'cafe', 1.2);
      this._artSign(I.deco, M(bx0, 2.1, arch.a - 0.75, HALF_PI).multiply(M(0, 0, 0.06)), 'lounge', 1.2);
      this._artSign(I.deco, M(rx, 2.5 - 0.12, jz0 + 0.02), 'reception', 0.9);
      // honour board + photos
      this._frame(I, M(bx1, 1.55, cz - 2.0, -HALF_PI).multiply(M(0, 0, 0.06)), 'honor', 1.5, WOOD.walnut);
      this._frame(I, M(lobbyX - 1.6, 1.7, jz1, Math.PI), 'photo0', 0.62);
      this._frame(I, M(lobbyX + 1.6, 1.7, jz1, Math.PI), 'photo1', 0.62);
      this._frame(I, M(backDoorX + 1.4, 2.05, jz0, 0), 'clock', 0.42, C.iron);
      // bench + plants + umbrella stand
      this._bench(I, M(bx0 + 0.3, F, cz - 0.7, HALF_PI), 1.4, WOOD.walnut);
      I.trim.push(P(bevelBox(1.3, 0.08, 0.34, 0.03), M(bx0 + 0.3, F + 0.5, cz - 0.7, HALF_PI), FABRIC.green));
      this._solid(bx0 + 0.3, cz - 0.7, 0.4, 1.4, 0.5);
      this._plant(I, M(bx0 + 0.4, F, jz1 - 0.4), 1.15);
      this._plant(I, M(bx1 - 0.4, F, jz1 - 0.4), 1.15);
      I.metal.push(P(cylinderGeo(0.14, 0.12, 0.55, 12, true), M(lobbyX + 1.35, F + 0.28, jz1 - 0.35), C.brass));
      for (let k = 0; k < 3; k++) I.trim.push(P(cylinderGeo(0.02, 0.02, 0.9, 6), M(lobbyX + 1.33 + (k - 1) * 0.05, F + 0.55, jz1 - 0.35, 0, 1, (k - 1) * 0.1, 0.1), [0x2d5a3d, 0x7a2e2e, 0x2c3e5c][k]));
      this._sconce(I, M(lobbyX - 1.2, 2.0, jz1, Math.PI));
      this._sconce(I, M(lobbyX + 1.2, 2.0, jz1, Math.PI));
    }

    // ── Café / bar (east third) ──
    {
      const kx0 = pB + PT / 2, kx1 = ii1;
      I.tile.push(P(boxGeo(kx1 - kx0, 0.012, jz1 - jz0), M((kx0 + kx1) / 2, F + 0.006, cz), 0xf1e3c8));
      // bar counter + foot rail
      const barX = (kx0 + kx1) / 2 + 0.2, barZ = jz0 + 1.55, barL = kx1 - kx0 - 1.2;
      I.trim.push(P(bevelBox(barL, 1.02, 0.6, 0.03), M(barX, F + 0.51, barZ), WOOD.walnut));
      for (let i = 0; i < 4; i++) I.trim.push(P(bevelBox(barL / 4 - 0.12, 0.7, 0.03, 0.01), M(barX - barL / 2 + (barL / 4) * (i + 0.5), F + 0.52, barZ + 0.31), WOOD.dark));
      I.trim.push(P(bevelBox(barL + 0.16, 0.06, 0.82, 0.02), M(barX, F + 1.05, barZ + 0.06), 0xe8e2d4));
      I.metal.push(P(cylinderGeo(0.025, 0.025, barL, 8), M(barX, F + 0.2, barZ + 0.42, 0, 1, 0, HALF_PI), C.brass));
      this._solid(barX, barZ + 0.05, barL, 0.8, 1.05);
      for (let i = 0; i < 4; i++) this._stool(I, M(barX - barL / 2 + 0.45 + i * ((barL - 0.9) / 3), F, barZ + 0.85), 0.74, FABRIC.green);
      // back bar: low cabinet, mirror, bottle shelves, espresso machine, taps
      I.trim.push(P(bevelBox(barL + 0.4, 0.92, 0.5, 0.02), M(barX, F + 0.46, jz0 + 0.25), WOOD.dark));
      I.trim.push(P(bevelBox(barL + 0.5, 0.05, 0.56, 0.015), M(barX, F + 0.95, jz0 + 0.28), 0xe8e2d4));
      I.metal.push(P(boxGeo(barL, 0.8, 0.01), M(barX, 1.65, jz0 + 0.01), MIRROR));
      for (const y of [1.35, 1.8]) {
        I.trim.push(P(bevelBox(barL + 0.2, 0.04, 0.24, 0.01), M(barX, y, jz0 + 0.12), WOOD.mid));
        this._bottles(I, M(barX, y + 0.02, jz0 + 0.12), barL);
      }
      I.metal.push(P(bevelBox(0.5, 0.42, 0.36, 0.04), M(barX + barL / 2 - 0.5, F + 1.18, jz0 + 0.27), C.chrome));
      I.trim.push(P(boxGeo(0.4, 0.1, 0.05), M(barX + barL / 2 - 0.5, F + 1.28, jz0 + 0.46), 0x2b2f33));
      for (let i = 0; i < 3; i++) I.metal.push(P(cylinderGeo(0.018, 0.018, 0.34, 6), M(barX - 0.4 + i * 0.2, F + 1.24, barZ - 0.12), C.brass));
      this._artSign(I.deco, M(barX, 2.29, jz0 + 0.02), 'cafe', 1.2);
      // café tables
      for (const [tx, tz] of [[kx0 + 1.2, cz + 1.3], [kx1 - 1.3, cz + 0.2]]) {
        this._roundTable(I, M(tx, F, tz), 0.42, 0.74, 0xf2ece0);
        I.trim.push(P(cylinderGeo(0.05, 0.04, 0.12, 8), M(tx, F + 0.82, tz), 0xe8f0f2));
        I.trim.push(P(icoGeo(0.06, 0), M(tx, F + 0.92, tz), C.flowers[0]));
        this._chair(I, M(tx - 0.62, F, tz, HALF_PI), 0x2d4a36, FABRIC.cream);
        this._chair(I, M(tx + 0.62, F, tz, -HALF_PI), 0x2d4a36, FABRIC.cream);
        this._solid(tx, tz, 1.6, 0.9, 0.78);
      }
      // menu board on the east wall, photos, plant
      this._frame(I, M(kx1, 1.6, cz, -HALF_PI), 'chalk', 1.0, WOOD.dark);
      this._frame(I, M(kx0, 1.7, cz - 2.2, HALF_PI).multiply(M(0, 0, 0.06)), 'photo3', 0.6);
      this._plant(I, M(kx0 + 0.4, F, jz1 - 0.4), 1.0);
      this._sconce(I, M(kx1, 2.0, cz - 1.0, -HALF_PI));
    }

    // ── Locker wing ──
    const wing = config.wing;
    let wingRect = null;
    if (wing && wing.center) {
      const wlv = this._levels(F, wing.height || h - 0.3);
      const WX0 = wing.center.x - wing.width / 2, WX1 = wing.center.x + wing.width / 2;
      const WZ0 = wing.center.z - wing.depth / 2, WZ1 = wing.center.z + wing.depth / 2;
      wingRect = [WX0, WX1, WZ0, WZ1];
      const wx0 = WX0 + HT, wz0 = WZ0 + HT, wz1 = WZ1 - HT;
      const corrX = WX1 - 2.0;                                     // corridor | locker partition (x)
      const midZ = (WZ0 + WZ1) / 2;                                 // men's | women's partition (z)
      const cx0 = corrX + PT / 2, cx1 = X0 - HT;                   // corridor interior (x)
      const corrDoor = { a: (cx0 + cx1) / 2 - 0.7, b: (cx0 + cx1) / 2 + 0.7, y0: 0, y1: 2.3 };
      const womenDoor = { a: (midZ + WZ1) / 2 - 0.45 - 0.75, b: (midZ + WZ1) / 2 - 0.45 + 0.75, y0: 0, y1: 2.25 };
      const menDoor = { a: (WZ0 + midZ) / 2 - 0.75, b: (WZ0 + midZ) / 2 + 0.75, y0: 0, y1: 2.25 };
      this.wingDoorPoint = { x: (cx0 + cx1) / 2, z: WZ0 - 0.8 };

      this._extWall(L, I, 'z', WX0, 1, [WZ0 - HT, WZ1 + HT], [wz0 + LI, wz1 - LI], wlv, [], { colors: [0xb9c9c2, 0xeef1ec] });
      this._extWall(L, I, 'x', WZ0, 1, [WX0 - HT, WX1 + HT], [wx0 + LI, X0 - HT - LI], wlv, [corrDoor]);
      this._extWall(L, I, 'x', WZ1, -1, [WX0 - HT, X0 - HT], [wx0 + LI, X0 - HT - LI], wlv, [], { colors: [0xe7d3cd, 0xf6ece6] });
      this._extWall(L, I, 'z', WX1, -1, [WZ0 + HT, Z0 - HT], [wz0 + LI, Z0 - HT], wlv, []);
      // corridor side of the main block's west wall (between the wing and the lounge)
      this._lining(I, 'z', X0 - HT, -1, [Z0 - HT, wz1 - LI], wlv, [wingDoor]);
      this._partition(I, 'z', wz0 + LI, wz1 - LI, corrX, wlv, [womenDoor, menDoor]);
      this._partition(I, 'x', wx0 + LI, corrX - PT / 2, midZ, wlv, [], [0xb9c9c2, 0xeef1ec]);
      L.trim.push(...wallPieces('z', WZ0 - HT, WZ1 + HT, WX0 - HT - 0.01, 0.1, 0, 0.45, [], C.stone));
      L.trim.push(...wallPieces('x', WX0 - HT - 0.06, WX1 + HT + 0.06, WZ0 - HT - 0.01, 0.1, 0, 0.45, [corrDoor], C.stone));
      L.trim.push(...wallPieces('x', WX0 - HT - 0.06, X0 - HT, WZ1 + HT + 0.01, 0.1, 0, 0.45, [], C.stone));
      L.trim.push(...wallPieces('z', WZ0 - HT, Z0 - HT, WX1 + HT + 0.01, 0.1, 0, 0.45, [], C.stone));
      L.trim.push(P(boxGeo(wing.width + T + 0.12, 0.26, wing.depth + T + 0.12), M(wing.center.x - 0.06, wlv.eaveY - 0.22, wing.center.z), C.trim));
      this._floorSlab(I.floor, wx0, cx1, wz0, wz1, F);
      I.floor.push(P(boxGeo(corrDoor.b - corrDoor.a, F, T), M((corrDoor.a + corrDoor.b) / 2, F / 2, WZ0)));
      I.floor.push(P(boxGeo(T + 0.02, F, wingDoor.b - wingDoor.a), M(X0, F / 2, (wingDoor.a + wingDoor.b) / 2)));
      this._physBox((corrDoor.a + corrDoor.b) / 2, F - 0.1, WZ0 - HT, 0.7, 0.1, 0.3);
      this._physBox(X0, F - 0.1, (wingDoor.a + wingDoor.b) / 2, HT + 0.05, 0.1, 0.75);
      this._openDoor(L, M((corrDoor.a + corrDoor.b) / 2, 0, WZ0 - HT, Math.PI), 1.4, 2.3, { double: false });
      this._lantern(L, M(corrDoor.b + 0.45, 2.0, WZ0 - HT, Math.PI));
      // windows: high privacy windows for the locker rooms, regular ones along the corridor
      for (const z of [(WZ0 + midZ) / 2, (midZ + WZ1) / 2]) this._twoWayWindow(L, I, M(WX0 - HT, 2.2, z, -HALF_PI), 1.2, 0.36, { variant: 3 });
      this._twoWayWindow(L, I, M(WX0 + 2.2, 2.2, WZ1 + HT, 0), 1.0, 0.36, { variant: 3 });
      this._twoWayWindow(L, I, M(WX0 + 2.2, 2.2, WZ0 - HT, Math.PI), 1.0, 0.36, { variant: 3 });
      for (const z of [WZ0 + 2.2, Z0 - 2.4]) this._twoWayWindow(L, I, M(WX1 + HT, 1.6, z, HALF_PI), 1.0, 1.4, { variant: 0, shutters: true });

      // corridor: runner, photo gallery both sides, sign, water fountain
      I.trim.push(P(bevelBox(1.0, 0.016, wz1 - wz0 - 0.6, 0.005), M((cx0 + cx1) / 2, F + 0.008, (wz0 + wz1) / 2), 0x6b2e2e));
      const photoZs = [WZ0 + 1.0, WZ0 + 3.9, midZ + 0.4, WZ1 - 1.2];
      photoZs.forEach((z, i) => this._frame(I, M(cx0, 1.6, z, HALF_PI).multiply(M(0, 0, 0.06)), `photo${(i + 4) % 8}`, 0.6));
      [WZ0 + 1.2, WZ0 + 3.3, Z0 - 1.2].forEach((z, i) => this._frame(I, M(cx1 - LI, 1.6, z, -HALF_PI), `photo${(i * 3 + 1) % 8}`, 0.55));
      this._artSign(I.deco, M((cx0 + cx1) / 2, 2.15, wz1 - LI - 0.01, Math.PI), 'lockers', 1.4);
      I.metal.push(P(bevelBox(0.4, 0.3, 0.3, 0.05), M(cx1 - 0.2, F + 0.9, WZ0 + 0.6), C.chrome));
      I.metal.push(P(boxGeo(0.06, 0.8, 0.06), M(cx1 - 0.2, F + 0.4, WZ0 + 0.6), C.chrome));
      this._sconce(I, M(cx0, 2.0, (WZ0 + midZ) / 2 + 0.6, HALF_PI).multiply(M(0, 0, 0.06)));
      this._sconce(I, M(cx0, 2.0, (midZ + WZ1) / 2 + 1.2, HALF_PI).multiply(M(0, 0, 0.06)));

      // locker rooms (men's north half, women's south half)
      const lx0 = wx0 + LI, lx1 = corrX - PT / 2;
      for (const [z0, z1, men] of [[wz0 + LI, midZ - PT / 2, true], [midZ + PT / 2, wz1 - LI, false]]) {
        const zc = (z0 + z1) / 2;
        const tint = men ? 0xcfdde3 : 0xf3e2dc;
        I.tile.push(P(boxGeo(lx1 - lx0, 0.012, z1 - z0), M((lx0 + lx1) / 2, F + 0.006, zc), tint));
        this._lockers(I, M(lx0 + 0.24, F, zc - 0.2, HALF_PI), 8, men ? 0x2f5d4a : 0x7d9c83);
        this._solid(lx0 + 0.24, zc - 0.2, 0.46, 4.0, 1.9);
        this._bench(I, M(lx0 + 1.75, F, zc - 0.2, HALF_PI), 2.6, WOOD.light);
        this._solid(lx0 + 1.75, zc - 0.2, 0.38, 2.6, 0.45);
        // vanity on the shared partition, showers on the outer wall, towels by the door
        const vz = men ? z1 : z0, vry = men ? Math.PI : 0;
        this._vanity(I, M(lx0 + 2.9, F, vz, vry), 2.2, 2);
        this._solid(lx0 + 2.9, vz + (men ? -0.3 : 0.3), 2.2, 0.6, 0.9);
        const sz = men ? z0 : z1, sry = men ? 0 : Math.PI;
        for (const k of [0, 1]) this._shower(I, M(lx0 + 2.2 + k * 1.02, F, sz, sry), 0.95, men ? 0xcfe0ea : 0xf2d9e0);
        this._solid(lx0 + 2.71, sz + (men ? 0.48 : -0.48), 2.05, 0.95, 2);
        this._shelf(I, M(lx1, F, zc + 1.3, -HALF_PI).multiply(M(0, 0, 0.06)), 0.9, 3, 1.5, 0.36);
        for (const y of [0.22, 0.85]) this._towelStack(I, M(lx1 - 0.25, F + y, zc + 1.3, HALF_PI), 3, men ? 0xf4f1e8 : 0xf6e7ea);
        this._solid(lx1 - 0.2, zc + 1.3, 0.4, 0.9, 1.5);
        this._artSign(I.deco, M(cx0 + 0.001, 2.12, (men ? menDoor : womenDoor).a - 0.45, HALF_PI).multiply(M(0, 0, 0.06)), men ? 'men' : 'women', 0.62);
        this._plant(I, M(lx1 - 0.35, F, z0 + (men ? 0.5 : 0.9)), 0.85, 0xe8e2d4);
        this._sconce(I, M(lx0, 2.05, zc + 1.4, HALF_PI));
      }
      this._ceiling(L, wx0, X0 - HT, wz0, wz1, wlv.ceilY);
      this.rooms.push({ x0: wx0, x1: X0 - HT, z0: wz0, z1: wz1 });
      this.footprints.push({ x0: WX0 - 0.8, x1: X0, z0: WZ0 - 0.8, z1: WZ1 + 0.8 });

      // wing roof (hip, ridge along z)
      const wr = new SurfaceBuilder();
      const wrx0 = WX0 - HT - 0.5, wrx1 = X0 - HT - 0.6, wrz0 = WZ0 - HT - 0.5, wrz1 = WZ1 + HT + 0.3;
      const wrise = ((wrx1 - wrx0) / 2) * 0.6;
      const wlines = wr.hipRoof(wrx0, wrx1, wrz0, wrz1, wlv.eaveY, wrise, 2.0);
      this._roofCaps(L.roofTrim, wlines, C.ridgeSlate);
      this._eaves(L.roofTrim, wrx0, wrx1, wrz0, wrz1, wlv.eaveY, C.trim, C.trim);
      this._wingRoof = wr;
    }

    // ── Roof (hip + entrance cross gable, dormers, chimney, cupola) ──
    const rx0 = X0 - HT - 0.6, rx1 = X1 + HT + 0.6, rz0 = Z0 - HT - 0.6, rz1 = Z1 + HT + 0.7;
    const pitch = 0.625;
    const rise = ((rz1 - rz0) / 2) * pitch;
    const ridgeY = eaveY + rise, ridgeZ = (rz0 + rz1) / 2;
    const roofAt = z => eaveY + (rz1 - z) * pitch;
    const sb = new SurfaceBuilder();
    const lines = sb.hipRoof(rx0, rx1, rz0, rz1, eaveY, rise, 2.0);
    const R = L.roofTrim;
    this._roofCaps(R, lines, C.ridgeSlate);
    this._eaves(R, rx0, rx1, rz0, rz1, eaveY, C.trim, C.trim);
    this._ceiling(L, xi0, xi1, zi0, zi1, ceilY);
    const gHW = 2.4, gRise = 2.0, gOv = 0.3, gSlope = gRise / gHW;
    const gz = rz1 + 0.08, gFront = gz + 0.42, gEave = eaveY - gOv * gSlope;
    const gBack = rz1 - (gRise + 0.3) / pitch;
    const g = sb.crossGableZ(cx, gHW + gOv, gBack, rz1, gFront, eaveY, gEave, eaveY + gRise, 2.0);
    this._roofCaps(R, { ridge: g.ridge }, C.ridgeSlate);
    R.push(P(prismGeo(gHW, gRise, 0.14), M(cx, eaveY - 0.06, gz - 0.14), C.trim));
    R.push(P(boxGeo(2 * gHW + 0.24, 0.14, gz - Z1 + 0.06), M(cx, eaveY - 0.07, (Z1 + gz + 0.06) / 2), C.trim));
    for (const s of [-1, 1]) R.push(P(boxGeo(1, 1, 1), segMatrix(V(cx + s * (gHW + gOv), gEave - 0.07, gFront - 0.03), V(cx, eaveY + gRise - 0.07, gFront - 0.03), 0.2, 0.06), C.trim));
    const cs = signPlane('club', 2.7);
    R.push(P(bevelBox(2.82, cs.h + 0.1, 0.06, 0.02), M(cx, eaveY + 0.42, gz + 0.03), C.green));
    L.roofSign.push(P(cs.geo, M(cx, eaveY + 0.42, gz + 0.064)));
    {
      const [u0, v0, u1, v1] = regionUV(ATLAS.crest);
      L.roofSign.push(P(atlasDisc('crest', 0.3, u0, v0, u1, v1), M(cx, eaveY + 1.13, gz + 0.045)));
      R.push(P(cylinderGeo(0.34, 0.34, 0.04, 24), M(cx, eaveY + 1.13, gz + 0.02, 0, 1, HALF_PI), C.brass));
    }
    // dormers on the front slope (walls + windows ride in the upper band)
    for (const ox of [-5.6, 5.6]) {
      const dx = cx + ox, fz = Z1 - 0.7, bz = fz - 1.9;
      const dTop = 5.6, dHW = 0.8, dOv = 0.15, dRise = 0.62;
      L.walls.push(P(boxGeo(2 * dHW, dTop - (roofAt(fz) - 0.2), fz - bz), M(dx, (dTop + roofAt(fz) - 0.2) / 2, (fz + bz) / 2)));
      R.push(P(prismGeo(dHW, dRise, 0.08), M(dx, dTop - 0.04, fz - 0.06), C.trim));
      const dBack = rz1 - (dTop + dRise - eaveY + 0.25) / pitch;
      const dSlope = dRise / dHW;
      const dg = sb.gableZ(dx, dHW + dOv, dBack, fz + 0.25, dTop - dOv * dSlope, dRise + dOv * dSlope, 2.0);
      this._roofCaps(R, { ridge: dg.ridge }, C.ridgeSlate, 0.12);
      for (const s of [-1, 1]) R.push(P(boxGeo(1, 1, 1), segMatrix(V(dx + s * (dHW + dOv), dTop - dOv * dSlope - 0.05, fz + 0.23), V(dx, dTop + dRise - 0.05, fz + 0.23), 0.12, 0.04), C.trim));
      this._window(L, M(dx, dTop - 0.52, fz, 0), 0.8, 0.62, { variant: ox < 0 ? 3 : 0 });
    }
    // chimney above the lounge fireplace
    {
      const chx = X0 + 0.45, chz = cz + 1.6;
      R.push(P(boxGeo(0.9, 2.6, 0.9), M(chx, 4.3, chz), C.brick));
      R.push(P(boxGeo(1.0, 0.12, 1.0), M(chx, 5.62, chz), 0x8a4630));
      R.push(P(boxGeo(1.06, 0.1, 1.06), M(chx, 5.74, chz), C.stone));
      for (const s of [-1, 1]) R.push(P(cylinderGeo(0.1, 0.12, 0.32, 10), M(chx, 5.95, chz + s * 0.22), 0xb8643e));
    }
    // cupola + weathervane
    {
      const ux = cx, uz = ridgeZ, by = ridgeY - 0.3;
      R.push(P(bevelBox(1.3, 1.5, 1.3, 0.03), M(ux, by + 0.75, uz), C.trim));
      for (let k = 0; k < 4; k++) {
        const base = M(ux, by + 0.85, uz, (k * Math.PI) / 2).multiply(M(0, 0, 0.65));
        R.push(P(bevelBox(0.8, 0.72, 0.03, 0.01), at(base, 0, 0, 0.01), C.green));
        for (let s = 0; s < 5; s++) R.push(P(boxGeo(0.72, 0.03, 0.02), at(base, 0, -0.28 + s * 0.14, 0.03), C.greenDark));
      }
      R.push(P(bevelBox(1.55, 0.1, 1.55, 0.02), M(ux, by + 1.55, uz), C.trim));
      R.push(P(pyramidGeo(), M(ux, by + 1.6 + 0.45, uz, Math.PI / 4, [1.12, 0.9, 1.12]), C.copper));
      const vy = by + 2.5;
      R.push(P(sphereGeo(0.07, 10, 6), M(ux, vy, uz), C.brass));
      R.push(P(cylinderGeo(0.018, 0.018, 0.8, 6), M(ux, vy + 0.4, uz), C.iron));
      R.push(P(boxGeo(0.5, 0.02, 0.02), M(ux, vy + 0.35, uz), C.iron));
      R.push(P(boxGeo(0.02, 0.02, 0.5), M(ux, vy + 0.35, uz), C.iron));
      R.push(P(boxGeo(0.9, 0.03, 0.03), M(ux, vy + 0.72, uz, 0.6), C.iron));
    }
    // merge the wing roof planes into the main roof surface (one draw)
    if (this._wingRoof) { sb.p.push(...this._wingRoof.p); sb.n.push(...this._wingRoof.n); sb.uv.push(...this._wingRoof.uv); }

    // ── Meshes ──
    this._emit(L, { wallMat: Mat.stucco(), wallTile: 3, metalAsTrim: true });
    this._emit(I, { interior: true });
    this._emitRoof(L, sb, Mat.roof(C.roofSlate));
    const rects = [[X0 - HT, X1 + HT, Z0 - HT, Z1 + HT, 0.05]];
    if (wingRect) rects.push([wingRect[0] - HT, wingRect[1] - HT, wingRect[2] - HT, wingRect[3] + HT, 0.05]);
    this._contactShadows(rects);
    this.rooms.push({ x0: xi0, x1: xi1, z0: zi0, z1: zi1 + 0.05 });
    this.footprints.push({ x0: X0 - 0.9, x1: X1 + 0.9, z0: Z0 - 0.9, z1: Z1 + 1.0 });
    this.roofTop = ridgeY + 0.5;
  }
}

// ───────────────────────────── Fitness & wellness centre ─────────────────────────────

export class FitnessCenter extends ClubBuilding {
  constructor(scene, physicsWorld, config) {
    super(scene, physicsWorld, 'fitnessCenter', config);
  }

  /** Entrance faces -z (toward the perimeter path). */
  _build(config) {
    const b = config.building || {};
    const w = b.width || config.bounds.width, d = b.depth || config.bounds.depth, h = b.height || 3.8;
    const cx = config.center.x, cz = config.center.z;
    const X0 = cx - w / 2, X1 = cx + w / 2, Zf = cz - d / 2, Zb = cz + d / 2;  // front (door) / back
    const lv = this._levels(0.1, h);
    const { F, cut, ceilY, eaveY } = lv;
    this.cutY = cut;
    const L = this._lists(), I = this._lists();
    const xi0 = X0 + HT, xi1 = X1 - HT, zf = Zf + HT, zb = Zb - HT;
    const ii0 = xi0 + LI, ii1 = xi1 - LI, jf = zf + LI, jb = zb - LI;
    const gymW = w * 0.56;
    const pX = X0 + gymW;                    // gym | lobby+studio partition
    const pZ = Zf + d * 0.42;                // lobby | studio partition
    const doorX = (pX + X1) / 2 - 0.3;
    const door = { a: doorX - 0.8, b: doorX + 0.8, y0: 0, y1: 2.5 };
    const store = [
      { a: X0 + 0.9, b: X0 + gymW / 2 - 0.3, y0: 0.6, y1: 2.35 },
      { a: X0 + gymW / 2 + 0.3, b: pX - 0.7, y0: 0.6, y1: 2.35 },
    ];
    const gymArch = { a: jf + 0.6, b: jf + 3.0, y0: 0, y1: 2.35 };
    const studioDoor = { a: pX + 1.0, b: pX + 2.6, y0: 0, y1: 2.3 };
    const cols = [0xd6e4dc, 0xf3f0e8];

    // ── Shell ──
    this._extWall(L, I, 'x', Zf, 1, [X0 - HT, X1 + HT], [ii0, ii1], lv, [door, ...store], { colors: cols });
    this._extWall(L, I, 'x', Zb, -1, [X0 - HT, X1 + HT], [ii0, ii1], lv, [], { colors: cols });
    this._extWall(L, I, 'z', X0, 1, [Zf + HT, Zb - HT], [jf, jb], lv, [], { colors: cols });
    this._extWall(L, I, 'z', X1, -1, [Zf + HT, Zb - HT], [jf, jb], lv, [], { colors: cols });
    this._partition(I, 'z', jf, jb, pX, lv, [gymArch], cols);
    this._partition(I, 'x', pX + PT / 2, ii1, pZ, lv, [studioDoor], cols);
    L.trim.push(...wallPieces('x', X0 - HT - 0.06, X1 + HT + 0.06, Zf - HT - 0.01, 0.1, 0, 0.45, [door, ...store.map(s => ({ ...s, y0: 0.45, y1: 0.5 }))], C.stone));
    L.trim.push(...wallPieces('x', X0 - HT - 0.06, X1 + HT + 0.06, Zb + HT + 0.01, 0.1, 0, 0.45, [], C.stone));
    L.trim.push(...wallPieces('z', Zf - HT, Zb + HT, X0 - HT - 0.01, 0.1, 0, 0.45, [], C.stone));
    L.trim.push(...wallPieces('z', Zf - HT, Zb + HT, X1 + HT + 0.01, 0.1, 0, 0.45, [], C.stone));
    for (const [X, sx] of [[X0 - HT, 1], [X1 + HT, -1]]) for (const [Z, sz] of [[Zf - HT, 1], [Zb + HT, -1]]) {
      L.trim.push(P(boxGeo(0.34, cut - 0.45, 0.34), M(X + sx * 0.13, (0.45 + cut) / 2, Z + sz * 0.13), C.trim));
      L.trim.push(P(boxGeo(0.34, h + 0.06 - cut, 0.34), M(X + sx * 0.13, (cut + h + 0.06) / 2, Z + sz * 0.13), C.trim));
    }
    L.trim.push(P(boxGeo(w + T + 0.12, 0.3, d + T + 0.12), M(cx, eaveY - 0.24, cz), C.trim));
    this._floorSlab(I.rubber, xi0, pX, zf, zb, F);
    I.floor.push(P(boxGeo(xi1 - pX, F, zb - zf), M((pX + xi1) / 2, F / 2, cz)));
    this._physBox((pX + xi1) / 2, F - 0.1, cz, (xi1 - pX) / 2, 0.1, (zb - zf) / 2);
    I.floor.push(P(boxGeo(door.b - door.a, F, T), M(doorX, F / 2, Zf)));
    this._physBox(doorX, F - 0.1, Zf - HT, 0.8, 0.1, 0.3);
    L.trim.push(P(bevelBox(door.b - door.a + 1.2, 0.09, 1.2, 0.03), M(doorX, 0.045, Zf - HT - 0.6), C.stone));

    // storefront glass + frames
    for (const o of store) {
      const mid = (o.a + o.b) / 2, ww = o.b - o.a, wh = o.y1 - o.y0, my = (o.y0 + o.y1) / 2;
      L.store.push(P(atlasPlane('storeGlass', +ww.toFixed(3), +wh.toFixed(3), 0, 0, 1, 1), M(mid, my, Zf)));
      for (const y of [o.y0 + 0.035, o.y1 - 0.035]) L.trim.push(P(boxGeo(ww, 0.07, 0.14), M(mid, y, Zf), C.green));
      for (const x of [o.a + 0.035, o.b - 0.035, mid]) L.trim.push(P(boxGeo(0.07, wh, 0.14), M(x, my, Zf), C.green));
      L.trim.push(P(bevelBox(ww + 0.3, 0.06, 0.22, 0.02), M(mid, o.y0 - 0.03, Zf - HT - 0.08), C.trim));
      L.trim.push(P(boxGeo(ww + 0.24, 0.12, 0.06), M(mid, o.y1 + 0.06, Zf - HT - 0.03), C.trim));
      const aw = ww + 0.5;
      L.awning.push(P(awningGeo(+aw.toFixed(3), 0.95, 0.45, 0.26), M(mid, 3.0, Zf - HT - 0.02, Math.PI)));
    }
    this._openDoor(L, M(doorX, 0, Zf - HT, Math.PI), 1.6, 2.5, { double: true, color: C.green });
    for (const s of [-1, 1]) this._lantern(L, M(doorX + s * 1.25, 2.2, Zf - HT, Math.PI));
    this._artSign(L.deco, M(doorX, 3.15, Zf - HT - 0.03, Math.PI), 'fitness', 2.6);
    L.trim.push(P(bevelBox(2.72, 0.6, 0.05, 0.02), M(doorX, 3.15, Zf - HT - 0.015, Math.PI), C.green));
    // side + back windows
    for (const x of [X0 + 2.6, X0 + 6.2, pX + 1.7, X1 - 1.8]) this._twoWayWindow(L, I, M(x, 1.7, Zb + HT, 0), 1.3, 1.5, { variant: (x | 0) & 3, shutters: true });
    for (const z of [pZ + 1.6, Zb - 1.4]) this._twoWayWindow(L, I, M(X1 + HT, 1.7, z, HALF_PI), 1.2, 1.5, { variant: 2, shutters: true });
    this._twoWayWindow(L, I, M(X1 + HT, 1.7, Zf + 1.9, HALF_PI), 1.0, 1.4, { variant: 1, shutters: true });

    // ── Gym ──
    {
      const gx0 = ii0, gx1 = pX - PT / 2;
      // mirror wall (west)
      I.trim.push(P(bevelBox(0.05, 1.9, d - 2.2, 0.01), M(gx0 + 0.025, F + 1.25, cz + 0.4), C.trim));
      I.metal.push(P(boxGeo(0.01, 1.76, d - 2.4), M(gx0 + 0.055, F + 1.25, cz + 0.4), MIRROR));
      for (let i = 0; i < 3; i++) {
        const tx = gx0 + 1.4 + i * ((gx1 - gx0 - 2.4) / 2);
        this._treadmill(I, M(tx, F, jf + 1.6, Math.PI));
        this._solid(tx, jf + 1.6, 0.8, 1.8, 1.3);
      }
      this._dumbbellRack(I, M(gx0 + 2.6, F, jb - 0.35, Math.PI), 3.0);
      this._solid(gx0 + 2.6, jb - 0.35, 3.0, 0.6, 0.9);
      for (const [x, z] of [[gx0 + 1.7, cz + 0.9], [gx0 + 3.7, cz + 0.9]]) {
        this._weightBench(I, M(x, F, z));
        this._solid(x, z, 0.6, 1.3, 0.6);
      }
      this._powerRack(I, M(gx1 - 1.1, F, jb - 1.0));
      this._solid(gx1 - 1.1, jb - 1.0, 1.3, 1.1, 2.2);
      for (let i = 0; i < 5; i++) {
        const kz = cz - 0.6 + i * 0.35, s = 0.8 + i * 0.1;
        I.trim.push(P(sphereGeo(0.1 * s, 10, 6), M(gx0 + 0.35, F + 0.1 * s, kz), [0xc23b4e, 0x2f6db3, 0xd9a441, 0x2d5a3d, 0x2b2f33][i]));
        I.metal.push(P(boxGeo(0.12 * s, 0.06, 0.03), M(gx0 + 0.35, F + 0.22 * s, kz), 0x2b2f33));
      }
      for (const [x, z, c] of [[gx1 - 0.5, jf + 3.8, 0x2f6db3], [gx1 - 0.9, jf + 4.3, 0xc23b4e]]) I.trim.push(P(sphereGeo(0.32, 14, 10), M(x, F + 0.32, z), c));
      this._frame(I, M(gx1, 1.7, cz + 1.6, -HALF_PI).multiply(M(0, 0, 0.06)), 'poster', 1.3, C.iron);
      I.metal.push(P(bevelBox(0.34, 1.0, 0.34, 0.03), M(gx1 - 0.3, F + 0.5, jf + 3.6), 0xe8eef0)); // water cooler
      I.lamp.push(P(cylinderGeo(0.13, 0.13, 0.35, 12), M(gx1 - 0.3, F + 1.2, jf + 3.6)));
      this._solid(gx1 - 0.3, jf + 3.6, 0.4, 0.4, 1.3);
      this._plant(I, M(gx0 + 0.4, F, jf + 0.4), 1.0, 0xe8e2d4);
    }

    // ── Lobby / juice bar ──
    {
      const bx0 = pX + PT / 2, bx1 = ii1, bz1 = pZ - PT / 2;
      I.tile.push(P(boxGeo(bx1 - bx0, 0.012, bz1 - jf), M((bx0 + bx1) / 2, F + 0.006, (jf + bz1) / 2), 0xece4d2));
      const kx = bx1 - 0.45, kz = (jf + bz1) / 2 + 0.2, kl = bz1 - jf - 1.3;
      I.trim.push(P(bevelBox(0.6, 1.0, kl, 0.03), M(kx, F + 0.5, kz), 0x7d9c83));
      I.trim.push(P(bevelBox(0.78, 0.06, kl + 0.16, 0.02), M(kx - 0.05, F + 1.03, kz), WOOD.light));
      this._solid(kx, kz, 0.7, kl, 1.05);
      I.metal.push(P(bevelBox(0.18, 0.3, 0.18, 0.03), M(kx, F + 1.21, kz - 0.6), C.chrome)); // blender
      I.trim.push(P(cylinderGeo(0.08, 0.06, 0.24, 10), M(kx, F + 1.48, kz - 0.6), 0xd98a4a));
      I.trim.push(P(cylinderGeo(0.2, 0.12, 0.1, 14), M(kx, F + 1.11, kz + 0.3), 0xf2ece0));
      for (let k = 0; k < 5; k++) I.trim.push(P(sphereGeo(0.06, 8, 6), M(kx + (k % 3 - 1) * 0.07, F + 1.19 + (k >> 2) * 0.05, kz + 0.3 + ((k + 1) % 2 - 0.5) * 0.08), [0xf28c28, 0xd4e157, 0xc23b4e, 0xf2c14e, 0x6cb052][k]));
      for (let i = 0; i < 2; i++) this._stool(I, M(kx - 0.75, F, kz - 0.4 + i * 0.8), 0.72, 0xd98a4a);
      this._frame(I, M(bx1, 2.05, kz, -HALF_PI), 'clock', 0.4, C.iron);
      this._bench(I, M(bx0 + 0.3, F, jf + 3.4, HALF_PI), 1.2, WOOD.light);
      this._solid(bx0 + 0.3, jf + 3.4, 0.4, 1.2, 0.45);
      this._towelStack(I, M(bx0 + 0.35, F + 0.47, jf + 3.1, HALF_PI), 4);
      this._plant(I, M(bx0 + 0.4, F, jf + 0.4), 1.0, 0xe8e2d4);
      this._rug(I, M(doorX, F, jf + 1.0), 1.4, 1.2, 0x2d5a3d, 0xd9a441);
    }

    // ── Studio ──
    {
      const sx0 = pX + PT / 2, sx1 = ii1, sz0 = pZ + PT / 2;
      const mats = [0x7d9c83, 0xd98a8a, 0x8fb3d5, 0xd9a441];
      for (let i = 0; i < 4; i++) this._yogaMat(I, M(sx0 + 1.0 + (i % 2) * 1.3, F, sz0 + 1.5 + (i >> 1) * 2.1), mats[i]);
      this._massageTable(I, M(sx1 - 0.8, F, (sz0 + jb) / 2 + 0.4));
      this._solid(sx1 - 0.8, (sz0 + jb) / 2 + 0.4, 0.75, 1.9, 0.85);
      for (let i = 0; i < 3; i++) I.trim.push(P(cylinderGeo(0.07, 0.07, 0.62, 10), M(sx1 - 0.25, F + 0.07 + i * 0.14, jb - 0.5, 0, 1, 0, HALF_PI), mats[i]));
      this._frame(I, M((sx0 + sx1) / 2, 1.75, jb, Math.PI), 'studio', 1.8, WOOD.light);
      this._plant(I, M(sx0 + 0.4, F, jb - 0.4), 1.1, 0xe8e2d4);
      this._plant(I, M(sx1 - 0.4, F, sz0 + 0.4), 0.9, 0xe8e2d4);
      I.trim.push(P(sphereGeo(0.3, 14, 10), M(sx0 + 0.5, F + 0.3, sz0 + 0.5), 0x8fae8b));
      this._sconce(I, M(sx0, 2.0, (sz0 + jb) / 2, HALF_PI).multiply(M(0, 0, 0.06)));
    }

    // ── Roof ──
    const rx0 = X0 - HT - 0.55, rx1 = X1 + HT + 0.55, rz0 = Zf - HT - 0.55, rz1 = Zb + HT + 0.55;
    const rise = ((rz1 - rz0) / 2) * 0.5;
    const sb = new SurfaceBuilder();
    const lines = sb.hipRoof(rx0, rx1, rz0, rz1, eaveY, rise, 2.0);
    this._roofCaps(L.roofTrim, lines, C.ridgeGreen);
    this._eaves(L.roofTrim, rx0, rx1, rz0, rz1, eaveY, C.green, C.ceiling);
    this._ceiling(L, xi0, xi1, zf, zb, ceilY);
    // skylight lanterns on the ridge
    for (const ox of [-3, 0, 3]) {
      L.roofTrim.push(P(bevelBox(1.0, 0.5, 1.0, 0.03), M(cx + ox, eaveY + rise + 0.1, cz), C.trim));
      L.roofTrim.push(P(pyramidGeo(), M(cx + ox, eaveY + rise + 0.55, cz, Math.PI / 4, [0.85, 0.4, 0.85]), C.copper));
    }

    this._emit(L, { wallMat: Mat.stucco(), wallTile: 3, metalAsTrim: true });
    this._emit(I, { interior: true });
    this._emitRoof(L, sb, Mat.roof(C.roofGreen));
    this._contactShadows([[X0 - HT, X1 + HT, Zf - HT, Zb + HT, 0.05]]);
    this.rooms.push({ x0: xi0, x1: xi1, z0: zf - 0.05, z1: zb });
    this.footprints.push({ x0: X0 - 0.9, x1: X1 + 0.9, z0: Zf - 0.9, z1: Zb + 0.9 });
    this.roofTop = eaveY + rise + 1.2;
    this.doorPoint = { x: doorX, z: Zf - 1.2 };
  }
}

// ───────────────────────────── Pool house + pool deck ─────────────────────────────

export class PoolHouse extends ClubBuilding {
  constructor(scene, physicsWorld, config, poolConfig) {
    super(scene, physicsWorld, 'poolHouse', { ...config, pool: poolConfig });
  }

  /** Front (door + snack hatch) faces +z, onto the pool deck. */
  _build(config) {
    const b = config.building || {};
    const w = b.width || config.bounds.width, d = b.depth || config.bounds.depth, h = b.height || 3.2;
    const cx = config.center.x, cz = config.center.z;
    const X0 = cx - w / 2, X1 = cx + w / 2, Zb = cz - d / 2, Zf = cz + d / 2;
    const lv = this._levels(0.08, h);
    const { F, cut, ceilY, eaveY } = lv;
    this.cutY = cut;
    const L = this._lists(), I = this._lists();
    const xi0 = X0 + HT, xi1 = X1 - HT, zb = Zb + HT, zf = Zf - HT;
    const ii0 = xi0 + LI, ii1 = xi1 - LI, jb = zb + LI, jf = zf - LI;
    const pX = cx;                                   // changing | snack bar partition
    const doorX = (X0 + pX) / 2;
    const door = { a: doorX - 0.75, b: doorX + 0.75, y0: 0, y1: 2.3 };
    const hatch = { a: pX + 0.8, b: X1 - 0.9, y0: 1.0, y1: 2.05 };
    const staff = { a: jb + 0.4, b: jb + 1.8, y0: 0, y1: 2.2 };
    const cols = [0x8fb3c9, 0xf4f1ea];

    this._extWall(L, I, 'x', Zf, -1, [X0 - HT, X1 + HT], [ii0, ii1], lv, [door, hatch], { colors: cols });
    this._extWall(L, I, 'x', Zb, 1, [X0 - HT, X1 + HT], [ii0, ii1], lv, [], { colors: cols });
    this._extWall(L, I, 'z', X0, 1, [Zb + HT, Zf - HT], [jb, jf], lv, [], { colors: cols });
    this._extWall(L, I, 'z', X1, -1, [Zb + HT, Zf - HT], [jb, jf], lv, [], { colors: cols });
    this._partition(I, 'z', jb, jf, pX, lv, [staff], cols);
    for (const [X, sx] of [[X0 - HT, 1], [X1 + HT, -1]]) for (const [Z, sz] of [[Zb - HT, 1], [Zf + HT, -1]]) {
      L.trim.push(P(boxGeo(0.28, cut, 0.28), M(X + sx * 0.1, cut / 2, Z + sz * 0.1), C.trim));
      L.trim.push(P(boxGeo(0.28, h + 0.06 - cut, 0.28), M(X + sx * 0.1, (cut + h + 0.06) / 2, Z + sz * 0.1), C.trim));
    }
    L.trim.push(P(boxGeo(w + T + 0.1, 0.26, d + T + 0.1), M(cx, eaveY - 0.22, cz), C.trim));
    this._floorSlab(I.tile, xi0, xi1, zb, zf, F, 0xe3eef2);
    I.tile.push(P(boxGeo(door.b - door.a, F, T), M(doorX, F / 2, Zf), 0xe3eef2));
    this._physBox(doorX, F - 0.1, Zf + HT, 0.75, 0.1, 0.3);
    this._openDoor(L, M(doorX, 0, Zf + HT), 1.5, 2.3, { double: false, color: 0x2f6db3 });
    this._artSign(L.deco, M(doorX, 2.72, Zf + HT + 0.03), 'pool', 2.3);
    L.trim.push(P(bevelBox(2.4, 0.52, 0.05, 0.02), M(doorX, 2.72, Zf + HT + 0.015), 0x2f6db3));
    this._frame(L, M(doorX - 1.55, 1.5, Zf + HT), 'rules', 0.8, C.trim);
    // snack hatch: counters inside + out, awning, sign
    const hm = (hatch.a + hatch.b) / 2, hw = hatch.b - hatch.a;
    L.trim.push(P(bevelBox(hw + 0.2, 0.06, 0.5, 0.02), M(hm, hatch.y0 - 0.03, Zf + 0.05), WOOD.light));
    for (const x of [hatch.a + 0.04, hatch.b - 0.04]) L.trim.push(P(boxGeo(0.08, hatch.y1 - hatch.y0, T + 0.06), M(x, (hatch.y0 + hatch.y1) / 2, Zf), C.trim));
    L.trim.push(P(boxGeo(hw, 0.08, T + 0.06), M(hm, hatch.y1 - 0.04, Zf), C.trim));
    L.awning.push(P(awningGeo(+(hw + 0.6).toFixed(3), 0.9, 0.42, 0.24), M(hm, 2.55, Zf + HT + 0.02)));
    this._artSign(L.deco, M(hm, 2.85, Zf + HT + 0.03), 'snack', 1.6);
    this._lantern(L, M(door.b + 0.35, 2.05, Zf + HT, 0), 0.9);
    for (const x of [X0 + 2.2, X1 - 2.2]) this._twoWayWindow(L, I, M(x, 1.7, Zb - HT, Math.PI), 1.1, 1.2, { variant: 1, shutters: true });
    this._twoWayWindow(L, I, M(X0 - HT, 2.1, cz, -HALF_PI), 1.2, 0.4, { variant: 3 });
    this._twoWayWindow(L, I, M(X1 + HT, 1.7, cz, HALF_PI), 1.1, 1.2, { variant: 2, shutters: true });

    // changing side: cubicles on the west wall, bench, lifeguard gear
    {
      const x0 = ii0, x1 = pX - PT / 2;
      for (let i = 0; i < 3; i++) {
        const z = jb + 0.6 + i * 1.05;
        I.trim.push(P(bevelBox(1.0, 1.95, 0.04, 0.01), M(x0 + 0.5, F + 1.08, z + 0.52), 0xf4f1ea));
        I.trim.push(P(bevelBox(0.9, 1.6, 0.03, 0.01), M(x0 + 1.02, F + 1.05, z, HALF_PI), [0x2f6db3, 0xf2c14e, 0x2f6db3][i]));
        I.metal.push(P(cylinderGeo(0.012, 0.012, 1.0, 6), M(x0 + 1.02, F + 1.9, z), C.chrome));
        I.trim.push(P(bevelBox(0.4, 0.05, 0.3, 0.01), M(x0 + 0.25, F + 0.45, z), WOOD.light));
      }
      I.trim.push(P(bevelBox(1.0, 1.95, 0.04, 0.01), M(x0 + 0.5, F + 1.08, jb + 0.08), 0xf4f1ea));
      this._solid(x0 + 0.5, jb + 1.6, 1.0, 3.2, 2.0);
      this._bench(I, M(x1 - 0.3, F, cz + 0.6, -HALF_PI), 1.6, WOOD.light);
      this._solid(x1 - 0.3, cz + 0.6, 0.4, 1.6, 0.45);
      I.trim.push(P(cylinderGeo(0.3, 0.3, 0.1, 18, true), M(x1 - 0.02, 1.55, cz - 1.2, 0, 1, 0, HALF_PI), 0xf04e3e)); // ring buoy
      I.trim.push(P(cylinderGeo(0.31, 0.31, 0.06, 18, true), M(x1 - 0.02, 1.55, cz - 1.2, 0, 1, 0, HALF_PI), 0xffffff));
      this._towelStack(I, M(x1 - 0.3, F + 0.47, cz + 1.2, HALF_PI), 4, 0x9ec9d9);
      this._frame(I, M(x0 + 1.5, 1.7, jf, Math.PI), 'photo6', 0.55);
    }
    // snack bar: counter under the hatch, fridge, freezer, shelves
    {
      const x0 = pX + PT / 2, x1 = ii1;
      const kz = jf - 0.35;
      I.trim.push(P(bevelBox(hw + 0.4, 0.95, 0.6, 0.03), M(hm, F + 0.475, kz), 0x2f6db3));
      I.trim.push(P(bevelBox(hw + 0.5, 0.05, 0.7, 0.015), M(hm, F + 0.97, kz), WOOD.light));
      this._solid(hm, kz, hw + 0.4, 0.6, 1.0);
      I.metal.push(P(bevelBox(0.3, 0.2, 0.25, 0.02), M(hm - 0.8, F + 1.1, kz), C.chrome)); // register
      for (let k = 0; k < 6; k++) I.trim.push(P(bevelBox(0.14, 0.2, 0.08, 0.02), M(hm + 0.2 + (k % 3) * 0.16, F + 1.1, kz - 0.1 + (k >> 1 & 1) * 0.12), [0xf2c14e, 0xc23b4e, 0x2f6db3][k % 3]));
      I.trim.push(P(bevelBox(0.8, 1.9, 0.7, 0.03), M(x1 - 0.45, F + 0.95, jb + 0.45), 0xf4f4f4));
      I.store.push(P(atlasPlane('fridgeGlass', 0.6, 1.5, 0, 0, 1, 1), M(x1 - 0.45, F + 1.0, jb + 0.81)));
      for (let s = 0; s < 3; s++) this._bottles(I, M(x1 - 0.45, F + 0.35 + s * 0.45, jb + 0.6), 0.6);
      this._solid(x1 - 0.45, jb + 0.45, 0.8, 0.7, 1.9);
      I.trim.push(P(bevelBox(1.1, 0.85, 0.6, 0.04), M(x0 + 0.9, F + 0.43, jb + 0.35), 0xf4f4f4));
      I.trim.push(P(boxGeo(1.0, 0.02, 0.5), M(x0 + 0.9, F + 0.86, jb + 0.35), 0x9ec9d9));
      this._solid(x0 + 0.9, jb + 0.35, 1.1, 0.6, 0.9);
      this._shelf(I, M(x1, F, cz, -HALF_PI).multiply(M(0, 0, 0.06)), 1.0, 3, 1.4, 0.3);
      for (let s = 0; s < 3; s++) for (let k = 0; k < 4; k++) I.trim.push(P(bevelBox(0.16, 0.22, 0.1, 0.03), M(x1 - 0.15, F + 0.33 + s * 0.57, cz - 0.35 + k * 0.23, HALF_PI), [0xc23b4e, 0xf2c14e, 0x2f6db3, 0x6cb052][(k + s) % 4]));
    }

    // ── Roof ──
    const rx0 = X0 - HT - 0.5, rx1 = X1 + HT + 0.5, rz0 = Zb - HT - 0.5, rz1 = Zf + HT + 0.6;
    const rise = ((rz1 - rz0) / 2) * 0.55;
    const sb = new SurfaceBuilder();
    const lines = sb.hipRoof(rx0, rx1, rz0, rz1, eaveY, rise, 2.0);
    this._roofCaps(L.roofTrim, lines, C.ridgeSlate);
    this._eaves(L.roofTrim, rx0, rx1, rz0, rz1, eaveY, C.trim, C.trim);
    this._ceiling(L, xi0, xi1, zb, zf, ceilY);

    this._buildPoolDeck(L, config.pool);

    this._emit(L, { wallMat: Mat.siding(), wallTile: 1.6, metalAsTrim: true });
    this._emit(I, { interior: true });
    this._emitRoof(L, sb, Mat.roof(0x4f8fa0));
    this._contactShadows([[X0 - HT, X1 + HT, Zb - HT, Zf + HT, 0.05]]);
    this.rooms.push({ x0: xi0, x1: xi1, z0: zb, z1: zf + 0.05 });
    this.footprints.push({ x0: X0 - 0.8, x1: X1 + 0.8, z0: Zb - 0.8, z1: Zf + 0.9 });
    this.roofTop = eaveY + rise + 0.5;
  }

  /** Deck (with a hole for the pool), coping, water, loungers, umbrellas, lifeguard chair, fence. */
  _buildPoolDeck(L, pool) {
    if (!pool || !pool.center) return;
    const dx0 = pool.center.x - pool.bounds.width / 2, dx1 = pool.center.x + pool.bounds.width / 2;
    const dz0 = pool.center.z - pool.bounds.depth / 2, dz1 = pool.center.z + pool.bounds.depth / 2;
    const water = pool.water || { x: pool.center.x, z: pool.center.z, width: 6, length: 12 };
    const wx0 = water.x - water.width / 2, wx1 = water.x + water.width / 2;
    const wz0 = water.z - water.length / 2, wz1 = water.z + water.length / 2;
    const DY = 0.07, cop = 0.35;
    this.poolRect = { x0: wx0, x1: wx1, z0: wz0, z1: wz1 };
    // deck slabs around the pool
    const slab = (x0, x1, z0, z1) => { if (x1 - x0 > 0.01 && z1 - z0 > 0.01) L.deck.push(P(boxGeo(x1 - x0, DY, z1 - z0), M((x0 + x1) / 2, DY / 2, (z0 + z1) / 2), 0xf3ead9)); };
    slab(dx0, dx1, dz0, wz0 - cop);
    slab(dx0, dx1, wz1 + cop, dz1);
    slab(dx0, wx0 - cop, wz0 - cop, wz1 + cop);
    slab(wx1 + cop, dx1, wz0 - cop, wz1 + cop);
    this._physBox((dx0 + dx1) / 2, DY - 0.1, (dz0 + dz1) / 2, (dx1 - dx0) / 2, 0.1, (dz1 - dz0) / 2);
    // coping + pool wall (physics keeps walkers out of the water)
    const cp = 0xf7f3ea;
    L.trim.push(P(bevelBox(wx1 - wx0 + 2 * cop, 0.1, cop, 0.03), M(water.x, DY + 0.02, wz0 - cop / 2), cp));
    L.trim.push(P(bevelBox(wx1 - wx0 + 2 * cop, 0.1, cop, 0.03), M(water.x, DY + 0.02, wz1 + cop / 2), cp));
    L.trim.push(P(bevelBox(cop, 0.1, wz1 - wz0, 0.03), M(wx0 - cop / 2, DY + 0.02, water.z), cp));
    L.trim.push(P(bevelBox(cop, 0.1, wz1 - wz0, 0.03), M(wx1 + cop / 2, DY + 0.02, water.z), cp));
    this._physBox(water.x, 0.35, water.z, (wx1 - wx0) / 2 + 0.05, 0.35, (wz1 - wz0) / 2 + 0.05);
    // lane rope + ladders
    for (let z = wz0 + 0.3; z < wz1 - 0.2; z += 0.3) L.trim.push(P(cylinderGeo(0.05, 0.05, 0.12, 8), M(water.x, 0.06, z, 0, 1, HALF_PI), ((z - wz0) / 0.3 | 0) % 4 < 2 ? 0xc23b4e : 0xffffff));
    for (const [lx, lz, ry] of [[wx1 - 0.6, wz1, 0], [wx0 + 0.6, wz0, Math.PI]]) {
      const lb = M(lx, 0, lz, ry);
      for (const s of [-1, 1]) {
        L.metal.push(P(cylinderGeo(0.025, 0.025, 0.9, 8), at(lb, s * 0.25, 0.5, 0.12), C.chrome));
        L.metal.push(P(cylinderGeo(0.025, 0.025, 0.4, 8), at(lb, s * 0.25, 0.95, -0.05, 0, 1, HALF_PI), C.chrome));
      }
    }
    // water surface (own animated material, one draw)
    const wgeo = new THREE.PlaneGeometry(wx1 - wx0, wz1 - wz0);
    wgeo.rotateX(-Math.PI / 2);
    const uv = wgeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (wx1 - wx0) / 3, uv.getY(i) * (wz1 - wz0) / 3);
    const wm = new THREE.Mesh(wgeo, waterMaterial());
    wm.position.set(water.x, 0.045, water.z);
    wm.receiveShadow = true;
    wm.name = 'poolHouse:water';
    wm.userData.noAO = true;
    this.mesh.add(wm);
    this._water = wm;

    // loungers + side tables along both long sides
    const lounger = (x, z, ry, col) => {
      const lb = M(x, DY, z, ry);
      L.trim.push(P(bevelBox(0.66, 0.06, 1.3, 0.02), at(lb, 0, 0.32, 0.3), 0xf4f1ea));
      L.trim.push(P(bevelBox(0.62, 0.05, 1.24, 0.02), at(lb, 0, 0.37, 0.3), col));
      L.trim.push(P(bevelBox(0.66, 0.06, 0.75, 0.02), at(lb, 0, 0.55, -0.55, 0, 1, 0.75), 0xf4f1ea));
      L.trim.push(P(bevelBox(0.62, 0.05, 0.7, 0.02), at(lb, 0, 0.58, -0.52, 0, 1, 0.75), col));
      for (const [sx, sz] of [[-1, 0.9], [1, 0.9], [-1, -0.7], [1, -0.7]]) L.trim.push(P(boxGeo(0.04, 0.3, 0.04), at(lb, sx * 0.3, 0.15, sz), 0xf4f1ea));
      L.trim.push(P(bevelBox(0.5, 0.05, 0.28, 0.02), at(lb, 0, 0.52, -0.95, 0, 1, 0.75), 0xffffff));
    };
    const cols = [0x2f6db3, 0xf2c14e, 0x2d5a3d];
    for (let i = 0; i < 3; i++) {
      const z = wz0 + 1.6 + i * ((wz1 - wz0 - 3.2) / 2);
      lounger(dx0 + 1.6, z, HALF_PI, cols[i]);
      lounger(dx1 - 1.6, z + 0.8, -HALF_PI, cols[(i + 1) % 3]);
      this._solid(dx0 + 1.6, z, 1.9, 0.7, 0.5);
      this._solid(dx1 - 1.6, z + 0.8, 1.9, 0.7, 0.5);
      if (i < 2) {
        const tz = z + (wz1 - wz0 - 3.2) / 4;
        L.trim.push(P(cylinderGeo(0.22, 0.22, 0.04, 14), M(dx0 + 1.3, DY + 0.46, tz), 0xf4f1ea));
        L.trim.push(P(cylinderGeo(0.03, 0.03, 0.44, 6), M(dx0 + 1.3, DY + 0.22, tz), 0xf4f1ea));
      }
    }
    // umbrellas (canopy + pole), towel caddy, lifeguard chair
    for (const [ux, uz, c] of [[dx0 + 1.3, water.z - 1.5, 0x2d5a3d], [dx1 - 1.3, water.z + 2.4, 0x2f6db3]]) {
      L.metal.push(P(cylinderGeo(0.03, 0.03, 2.3, 6), M(ux, DY + 1.15, uz), C.chrome));
      L.trim.push(P(coneGeo(1.3, 0.45, 8), M(ux, DY + 2.25, uz), c));
      L.trim.push(P(cylinderGeo(1.3, 1.3, 0.12, 8, true), M(ux, DY + 1.99, uz), 0xf4f1ea));
      L.trim.push(P(sphereGeo(0.07, 8, 6), M(ux, DY + 2.5, uz), 0xf4f1ea));
      L.trim.push(P(cylinderGeo(0.3, 0.35, 0.12, 12), M(ux, DY + 0.06, uz), 0x9aa1a6));
    }
    {
      const gx = wx0 - cop - 1.0, gz = water.z + 0.2;
      const gb = M(gx, DY, gz, HALF_PI);
      for (const [sx, sz] of [[-0.35, -0.3], [0.35, -0.3], [-0.35, 0.35], [0.35, 0.35]]) L.trim.push(P(boxGeo(0.07, 1.7, 0.07), at(gb, sx, 0.85, sz), 0xffffff));
      L.trim.push(P(bevelBox(0.8, 0.08, 0.7, 0.02), at(gb, 0, 1.65, 0), 0xf4f1ea));
      L.trim.push(P(bevelBox(0.8, 0.6, 0.06, 0.02), at(gb, 0, 1.98, -0.32), 0xf04e3e));
      for (let k = 0; k < 4; k++) L.trim.push(P(boxGeo(0.7, 0.04, 0.08), at(gb, 0, 0.35 + k * 0.35, 0.37), 0xffffff));
      this._solid(gx, gz, 0.9, 0.9, 1.7);
    }
    // low iron fence around the deck (gap on the east side toward the path + where the house is)
    const gate = pool.gate || { side: 'east', a: pool.center.z - 1.5, b: pool.center.z + 1.5 };
    const hx0 = this.config.center.x - (this.config.building?.width || this.config.bounds.width) / 2 - 0.15;
    const hx1 = this.config.center.x + (this.config.building?.width || this.config.bounds.width) / 2 + 0.15;
    const runs = [
      ['z', dx0, dz0, dz1, []],
      ['z', dx1, dz0, dz1, gate.side === 'east' ? [{ a: gate.a, b: gate.b }] : []],
      ['x', dz1, dx0, dx1, gate.side === 'south' ? [{ a: gate.a, b: gate.b }] : []],
      ['x', dz0, dx0, dx1, [{ a: hx0, b: hx1 }]],
    ];
    const FH = 1.05;
    for (const [axis, fixed, a0, a1, gaps] of runs) {
      const segs = [];
      let s = a0;
      for (const gp of gaps.slice().sort((p, q) => p.a - q.a)) { if (gp.a > s) segs.push([s, gp.a]); s = Math.max(s, gp.b); }
      if (a1 > s) segs.push([s, a1]);
      for (const [p0, p1] of segs) {
        const len = p1 - p0, mid = (p0 + p1) / 2;
        const put = (a, y, sa, sy, sb) => (axis === 'x' ? M(a, y, fixed) : M(fixed, y, a));
        for (const y of [0.18, FH - 0.08]) {
          L.metal.push(P(axis === 'x' ? boxGeo(len, 0.04, 0.04) : boxGeo(0.04, 0.04, len), put(mid, y), C.iron));
        }
        const nP = Math.max(1, Math.round(len / 0.16));
        for (let i = 0; i <= nP; i++) {
          const a = p0 + (i / nP) * len;
          L.metal.push(P(boxGeo(0.022, FH - 0.1, 0.022), put(a, (FH - 0.1) / 2 + 0.05), C.iron));
        }
        const nPost = Math.max(1, Math.round(len / 2.4));
        for (let i = 0; i <= nPost; i++) {
          const a = p0 + (i / nPost) * len;
          L.metal.push(P(boxGeo(0.08, FH + 0.1, 0.08), put(a, (FH + 0.1) / 2), C.iron));
          L.metal.push(P(sphereGeo(0.06, 8, 6), put(a, FH + 0.14), C.brass));
        }
        if (axis === 'x') this._physBox(mid, 0.6, fixed, len / 2, 0.6, 0.05);
        else this._physBox(fixed, 0.6, mid, 0.05, 0.6, len / 2);
      }
    }
    // gate posts with ring buoys
    if (gate.side === 'east') {
      for (const z of [gate.a, gate.b]) {
        L.trim.push(P(bevelBox(0.3, 1.4, 0.3, 0.03), M(dx1, 0.7, z), C.trim));
        L.trim.push(P(bevelBox(0.36, 0.08, 0.36, 0.02), M(dx1, 1.44, z), C.trim));
      }
      L.trim.push(P(cylinderGeo(0.28, 0.28, 0.09, 16, true), M(dx1 + 0.17, 0.9, gate.a - 0.6, 0, 1, 0, HALF_PI), 0xf04e3e));
    }
    this.deckRect = { x0: dx0, x1: dx1, z0: dz0, z1: dz1 };
  }

  update(dt) {
    if (this._water) {
      const map = this._water.material.map;
      map.offset.x = (map.offset.x + dt * 0.012) % 1;
      map.offset.y = (map.offset.y + dt * 0.02) % 1;
    }
  }
}
