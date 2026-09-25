import * as THREE from 'three';
import { COLORS, SIZES } from '../utils/Constants.js';
import { mat, getMaterial } from '../graphics/Materials.js';
import { Textures } from '../graphics/Textures.js';
import {
  getGeometry, roundedBox, boxGeo, cylinderGeo, sphereGeo, coneGeo, mergeParts, makeMatrix,
} from '../graphics/GeometryUtils.js';
import { seededRandom } from '../graphics/Textures.js';
import { ITEMS } from '../systems/InventorySystem.js';

/**
 * ItemProps — the physical side of errand items (ITEMS in InventorySystem.js).
 *
 *  - Waiting: while a mission's CURRENT step is `pickup`, the item sits at the pickup spot
 *    (pro shop counter, garden bench, court bench …) with a soft gold glow, a pulsing floor
 *    halo and a small bobbing arrow. It disappears when the step advances (picked up).
 *  - Carried: every inventory item is shown on the player (right / left hand, held in front
 *    or slung on the back) and, while driving, in the cart's rear rack / passenger seat.
 *  - Delivered: on delivery the item is set down at the delivery spot for DELIVERED_HOLD s
 *    while the mission's client walks over (when close) and reacts, then it pops away.
 *
 * Spots are data-driven: map.json `itemSpots` (or `waypoints`) entries
 * `<area>_<pickup|deliver>_<itemId>`, then `<area>_<pickup|deliver>` ({x, y, z, ry?});
 * otherwise a safe fallback near the area.
 *
 * One merged, vertex-coloured geometry per item type → one draw call per visible prop
 * (+ halo + arrow while waiting). Meshes are pooled per item type; nothing is allocated
 * per frame.
 */

const DELIVERED_HOLD = 20;     // s a delivered item stays at the spot
const POP_TIME = 0.35;         // s scale-in / scale-out
const STACK_STEP = 0.5;        // m between two props that share a spot
const REACT_WALK_MAX = 16;     // m: the client walks over only from this close
const REACT_NEAR = 2.2;        // m: close enough to react
const REACT_TIMEOUT = 11;      // s: react anyway if the walk takes too long
const GOLD = 0xd9a441;         // theme gold (MissionMarkers)

const THANKS = {
  towels: 'Fresh towels, lovely!',
  ball_hopper: 'A full hopper, perfect!',
  water_bottles: 'Cold water, thank you!',
  racket: 'Thanks for bringing it in!',
};

// ───────────────────────────── geometry (cached, world metres, base at y = 0) ─────────────────────────────

const P = (geometry, x, y, z, color, ry = 0, s = 1, rx = 0, rz = 0) =>
  ({ geometry, matrix: makeMatrix(x, y, z, ry, s, rx, rz), color });

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Thin rod from a to b. */
function rod(r, a, b, color, seg = 5) {
  _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _dir.length();
  _dir.divideScalar(len);
  _q.setFromUnitVectors(_up, _dir);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, new THREE.Vector3(1, 1, 1));
  return { geometry: cylinderGeo(r, r, len, seg), matrix: m, color };
}

const WIRE = 0x9aa1a8;
const WIRE_DARK = 0x5d646b;
const BALL = COLORS.tennisBall || 0xd4e157;

/** Wire ball hopper (legs, square wire basket full of balls, two raised handles). */
function buildHopper() {
  const parts = [];
  const hw = 0.19, y0 = 0.2, y1 = 0.52;       // basket half width, bottom, rim
  const r = 0.007;
  // basket floor grid
  for (let i = -2; i <= 2; i++) {
    const t = (i / 2) * hw;
    parts.push(rod(r, [t, y0, -hw], [t, y0, hw], WIRE));
    parts.push(rod(r, [-hw, y0, t], [hw, y0, t], WIRE));
  }
  // horizontal rings
  for (const y of [y0, (y0 + y1) / 2, y1]) {
    const rr = y === y1 ? 0.011 : r;
    parts.push(rod(rr, [-hw, y, -hw], [hw, y, -hw], WIRE));
    parts.push(rod(rr, [-hw, y, hw], [hw, y, hw], WIRE));
    parts.push(rod(rr, [-hw, y, -hw], [-hw, y, hw], WIRE));
    parts.push(rod(rr, [hw, y, -hw], [hw, y, hw], WIRE));
  }
  // vertical wires on each face
  for (let i = -3; i <= 3; i++) {
    const t = (i / 3) * hw;
    parts.push(rod(r, [t, y0, -hw], [t, y1, -hw], WIRE));
    parts.push(rod(r, [t, y0, hw], [t, y1, hw], WIRE));
    if (Math.abs(i) < 3) {
      parts.push(rod(r, [-hw, y0, t], [-hw, y1, t], WIRE));
      parts.push(rod(r, [hw, y0, t], [hw, y1, t], WIRE));
    }
  }
  // legs (splayed) with rubber feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(rod(0.011, [sx * (hw - 0.01), y0, sz * (hw - 0.01)], [sx * (hw + 0.035), 0.02, sz * (hw + 0.035)], WIRE_DARK));
    parts.push(P(sphereGeo(0.018, 6, 4), sx * (hw + 0.035), 0.018, sz * (hw + 0.035), 0x2a2d30));
  }
  // two handles rising from the rim on the ±x sides, meeting over the middle with a grip
  const top = 0.82;
  for (const sx of [-1, 1]) {
    parts.push(rod(0.011, [sx * hw, y1, -hw * 0.75], [sx * 0.03, top, -0.06], WIRE));
    parts.push(rod(0.011, [sx * hw, y1, hw * 0.75], [sx * 0.03, top, 0.06], WIRE));
  }
  parts.push(P(roundedBox(0.07, 0.035, 0.18, 0.015, 1), 0, top, 0, 0x2d5a3d));
  // balls: a heaped top layer + layers visible through the wires
  const rand = seededRandom(7);
  const br = 0.036;
  for (let layer = 0; layer < 4; layer++) {
    const y = y0 + br + layer * br * 1.8;
    const n = 4;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = -hw + br + 0.01 + (i + (layer % 2) * 0.5) * ((2 * hw - 2 * br - 0.02) / (n - 0.5));
      const z = -hw + br + 0.01 + (j + (layer % 2) * 0.5) * ((2 * hw - 2 * br - 0.02) / (n - 0.5));
      if (Math.abs(x) > hw - br * 0.9 || Math.abs(z) > hw - br * 0.9) continue;
      const outer = i === 0 || j === 0 || i === n - 1 || j === n - 1;
      if (!outer && layer < 3) continue; // hidden inside
      parts.push(P(sphereGeo(br, layer === 3 ? 8 : 6, layer === 3 ? 6 : 4), x, y, z, BALL));
    }
  }
  // mound on top
  const mound = [[0, 0], [0.07, 0.04], [-0.06, 0.05], [0.03, -0.07], [-0.05, -0.05], [0.08, -0.06]];
  mound.forEach(([x, z], i) => parts.push(P(sphereGeo(br, 8, 6), x, y1 + 0.02 + (i === 0 ? 0.04 : 0) + rand() * 0.01, z, i % 3 === 0 ? 0xdbe86a : BALL)));
  return mergeParts(parts);
}

/** Stack of three folded club towels (white with a green stripe, gold crest on top). */
function buildTowels() {
  const parts = [];
  const cols = [0xf7f5ee, 0xf2efe4, 0xf7f5ee];
  for (let i = 0; i < 3; i++) {
    const y = 0.037 + i * 0.07;
    const ry = (i - 1) * 0.06;
    parts.push(P(roundedBox(0.42, 0.068, 0.3, 0.03, 2), 0, y, 0, cols[i], ry));
    // woven stripe band near one end
    parts.push(P(roundedBox(0.05, 0.071, 0.304, 0.02, 1), 0.13, y, 0, COLORS.clubGreen || 0x2d5a3d, ry));
    // folded edge (a slightly rounded lip on the front)
    parts.push(P(cylinderGeo(0.034, 0.034, 0.418, 8), 0, y, 0.15, cols[i], ry, 1, 0, Math.PI / 2));
  }
  parts.push(P(cylinderGeo(0.03, 0.03, 0.006, 12), -0.1, 0.212, 0.04, COLORS.clubGold || 0xc9a24a));
  return mergeParts(parts);
}

/** Green club carrier crate with six water bottles and a carry handle. */
function buildWater() {
  const parts = [];
  const W = 0.36, D = 0.25, H = 0.13, t = 0.018, G = COLORS.clubGreen || 0x2d5a3d;
  parts.push(P(roundedBox(W, t, D, 0.006, 1), 0, t / 2, 0, G));
  parts.push(P(roundedBox(W, H, t, 0.006, 1), 0, H / 2, D / 2 - t / 2, G));
  parts.push(P(roundedBox(W, H, t, 0.006, 1), 0, H / 2, -D / 2 + t / 2, G));
  parts.push(P(roundedBox(t, H, D, 0.006, 1), W / 2 - t / 2, H / 2, 0, G));
  parts.push(P(roundedBox(t, H, D, 0.006, 1), -W / 2 + t / 2, H / 2, 0, G));
  parts.push(P(roundedBox(W + 0.004, 0.02, t + 0.004, 0.006, 1), 0, H - 0.03, D / 2 - t / 2, COLORS.clubCream || 0xf1e6c4));
  parts.push(P(roundedBox(W + 0.004, 0.02, t + 0.004, 0.006, 1), 0, H - 0.03, -D / 2 + t / 2, COLORS.clubCream || 0xf1e6c4));
  // centre divider + handle
  parts.push(P(boxGeo(W - 2 * t, 0.26, 0.012), 0, 0.13, 0, G));
  parts.push(P(roundedBox(0.16, 0.05, 0.03, 0.012, 1), 0, 0.3, 0, G));
  parts.push(P(roundedBox(0.1, 0.02, 0.034, 0.008, 1), 0, 0.275, 0, 0x1d3a28));
  // bottles (2 x 3)
  for (let i = 0; i < 3; i++) for (const sz of [-1, 1]) {
    const x = (i - 1) * 0.105, z = sz * 0.062;
    parts.push(P(cylinderGeo(0.036, 0.036, 0.2, 10), x, 0.12, z, 0xa9d8ee));
    parts.push(P(cylinderGeo(0.037, 0.037, 0.06, 10), x, 0.12, z, 0xf4f1e8));          // label
    parts.push(P(cylinderGeo(0.0375, 0.0375, 0.012, 10), x, 0.12, z, 0x2f6db3));        // label stripe
    parts.push(P(cylinderGeo(0.018, 0.034, 0.05, 10), x, 0.245, z, 0xa9d8ee));          // shoulder
    parts.push(P(cylinderGeo(0.018, 0.018, 0.026, 8), x, 0.281, z, 0x2f6db3));           // cap
  }
  return mergeParts(parts);
}

/** Tennis racket lying flat: length along X (handle -X, head +X), centred, face up. */
function buildRacket() {
  const parts = [];
  const T = 0.024, y = T / 2;
  const hx = 0.17, hr = 0.125, hl = 0.16;      // head centre x, half width (z), half length (x)
  const FRAME = 0x1f3f63, ACC = COLORS.clubGold || 0xc9a24a;
  // head frame: ellipse ring (torus, scaled)
  const ring = new THREE.TorusGeometry(1, 0.1, 5, 26);
  parts.push({ geometry: ring, matrix: new THREE.Matrix4().compose(new THREE.Vector3(hx, y, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), new THREE.Vector3(hl, hr, 0.14)), color: FRAME });
  // strings: flat bed + a few string lines
  parts.push(P(cylinderGeo(1, 1, 0.004, 22), hx, y, 0, 0xe9e6da, 0, [hl - 0.012, 1, hr - 0.012]));
  for (let i = -3; i <= 3; i++) {
    const zz = (i / 4) * (hr - 0.02);
    const half = (hl - 0.015) * Math.sqrt(Math.max(0, 1 - (zz / (hr - 0.01)) ** 2));
    parts.push(P(boxGeo(half * 2, 0.007, 0.004), hx, y, zz, 0xcfcab8));
  }
  for (let i = -4; i <= 4; i++) {
    const xx = (i / 5) * (hl - 0.02);
    const half = (hr - 0.015) * Math.sqrt(Math.max(0, 1 - (xx / (hl - 0.01)) ** 2));
    parts.push(P(boxGeo(0.004, 0.007, half * 2), hx + xx, y, 0, 0xcfcab8));
  }
  // throat (open V) + bridge
  const tx = hx - hl + 0.005;
  parts.push(rod(0.011, [tx - 0.1, y, 0], [tx + 0.02, y, 0.05], FRAME, 6));
  parts.push(rod(0.011, [tx - 0.1, y, 0], [tx + 0.02, y, -0.05], FRAME, 6));
  // handle: shaft + grip wrap + butt cap
  parts.push(P(cylinderGeo(0.014, 0.014, 0.08, 8), tx - 0.13, y, 0, FRAME, 0, 1, 0, Math.PI / 2));
  parts.push(P(cylinderGeo(0.017, 0.017, 0.17, 8), -0.255, y, 0, 0xf4f1e8, 0, 1, 0, Math.PI / 2));
  parts.push(P(cylinderGeo(0.0175, 0.0175, 0.02, 8), -0.26, y, 0, ACC, 0, 1, 0, Math.PI / 2));
  parts.push(P(cylinderGeo(0.02, 0.018, 0.02, 8), -0.345, y, 0, FRAME, 0, 1, 0, Math.PI / 2));
  return mergeParts(parts);
}

/**
 * Per item: geometry, the hand grip point (item-local), carry mounts and extents.
 *  hand: hanging from a hand (rotation applied before the grip is aligned to the hand)
 *  front / back: held in front of the chest / slung across the back (chest-bone local)
 *  rack: cart rack scale factor
 */
const DEFS = {
  ball_hopper: {
    geo: () => getGeometry('itemProp:ball_hopper', buildHopper),
    grip: [0, 0.82, 0], height: 0.86, radius: 0.28,
    anchors: ['handR', 'handL', 'front'],
    hand: { rot: [0, Math.PI / 4, 0], s: 0.78 },
    front: { pos: [0, -0.62, 0.34], rot: [0, 0, 0], s: 0.7 },
    rack: { s: 0.8 },
  },
  towels: {
    geo: () => getGeometry('itemProp:towels', buildTowels),
    grip: [0, 0.1, 0], height: 0.22, radius: 0.26,
    anchors: ['front', 'back', 'handL'],
    front: { pos: [0, -0.34, 0.3], rot: [0, 0, 0], s: 1 },
    back: { pos: [0, -0.05, -0.26], rot: [Math.PI / 2, 0, 0], s: 0.9 },
    hand: { rot: [0, 0, Math.PI / 2], s: 0.9 },
    rack: { s: 1 },
  },
  water_bottles: {
    geo: () => getGeometry('itemProp:water_bottles', buildWater),
    grip: [0, 0.3, 0], height: 0.33, radius: 0.22,
    anchors: ['handL', 'handR', 'front'],
    hand: { rot: [0, Math.PI / 2, 0], s: 1 },
    front: { pos: [0, -0.5, 0.32], rot: [0, 0, 0], s: 1 },
    rack: { s: 1 },
  },
  racket: {
    geo: () => getGeometry('itemProp:racket', buildRacket),
    grip: [-0.25, 0.012, 0], height: 0.05, radius: 0.36,
    anchors: ['handR', 'back', 'handL'],
    hand: { rot: [0, 0, -Math.PI / 2], s: 1 },
    back: { pos: [0, 0.02, -0.21], rot: [Math.PI / 2, 0, 1.0], s: 1 },
    rack: { s: 1, flat: true },
  },
};
const DEFAULT_DEF = DEFS.towels;

// Cart-local (unscaled cart units, front is -Z) resting spots: rear rack (on the bag),
// passenger seat, passenger footwell.
const CART_SLOTS = [
  { pos: [-0.2, 1.2, 1.08], ry: 0 },
  { pos: [0.36, 1.07, 0.18], ry: 0 },
  { pos: [0.36, 0.73, -0.45], ry: 0 },
];

// Hand grip offset in hand-bone space (the fist sits a little below the wrist pivot)
const HAND_OFFSET = { handR: [-0.03, -0.075, 0.01], handL: [0.03, -0.075, 0.01] };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler();
const _qq = new THREE.Quaternion();

export class ItemProps {
  /**
   * @param {THREE.Scene} scene
   * @param {{missions: import('../systems/MissionSystem.js').MissionSystem,
   *          inventory: import('../systems/InventorySystem.js').InventorySystem,
   *          player: object, cart: object, mapData: object}} deps
   */
  constructor(scene, { missions, inventory, player, cart, mapData }) {
    this.scene = scene;
    this.missions = missions;
    this.inventory = inventory;
    this.player = player;
    this.cart = cart;
    this.mapData = mapData || {};
    this.time = 0;

    this.material = getMaterial('itemProp', () => new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.05,
    }));
    // Same program as `material`; its emissive pulses to highlight props waiting for pickup
    this.hiMaterial = getMaterial('itemPropHighlight', () => new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.62, metalness: 0.05, emissive: 0xffc15a, emissiveIntensity: 0.2,
    }));
    this.haloMaterial = getMaterial('itemPropHalo', () => new THREE.MeshBasicMaterial({
      color: 0xffd27a, map: Textures.radialBlob(), transparent: true, opacity: 0.55, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: true,
    }));
    this.arrowMaterial = mat(GOLD, { roughness: 0.35, metalness: 0.2, emissive: GOLD, emissiveIntensity: 0.55 });
    this.haloGeo = getGeometry('itemPropHalo', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.arrowGeo = getGeometry('itemPropArrow', () => coneGeo(0.12, 0.22, 4).rotateX(Math.PI));

    /** Free meshes per item id */
    this._pool = new Map();
    /** @type {Array<{mesh, itemId, missionId, spotKey, x, y, z, halo, arrow, t, out}>} */
    this.waiting = [];
    /** @type {Array<{mesh, itemId, anchor, base, t}>} */
    this.carried = [];
    /** @type {Array<{mesh, itemId, spotKey, x, y, z, t, hold, npc, reacted, walkT, line}>} */
    this.delivered = [];
    this._halos = [];
    this._arrows = [];

    this._carriedDirty = true;
    this._carriedInCart = null;
    if (inventory && typeof inventory.onChange === 'function') {
      inventory.onChange(() => { this._carriedDirty = true; });
    }
  }

  // ───────────────────────────── pooling ─────────────────────────────

  _def(itemId) { return DEFS[itemId] || DEFAULT_DEF; }

  _acquire(itemId) {
    let list = this._pool.get(itemId);
    if (!list) { list = []; this._pool.set(itemId, list); }
    let m = list.pop();
    if (!m) {
      m = new THREE.Mesh(this._def(itemId).geo(), this.material);
      m.name = 'itemProp:' + itemId;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.dynamic = true;
      m.userData.noMerge = true;
      m.userData.itemId = itemId;
    }
    m.material = this.material;
    m.visible = true;
    m.rotation.set(0, 0, 0);
    m.position.set(0, 0, 0);
    m.scale.setScalar(1);
    return m;
  }

  _release(m) {
    if (!m) return;
    if (m.parent) m.parent.remove(m);
    m.visible = false;
    const id = m.userData.itemId;
    let list = this._pool.get(id);
    if (!list) { list = []; this._pool.set(id, list); }
    list.push(m);
  }

  _acquireFx(list, geo, material, name) {
    let m = list.pop();
    if (!m) {
      m = new THREE.Mesh(geo, material);
      m.name = name;
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.noAO = true;
      m.userData.dynamic = true;
      m.userData.noMerge = true;
      m.renderOrder = 3;
    }
    m.visible = true;
    this.scene.add(m);
    return m;
  }

  _releaseFx(list, m) {
    if (!m) return;
    if (m.parent) m.parent.remove(m);
    m.visible = false;
    list.push(m);
  }

  // ───────────────────────────── spots ─────────────────────────────

  /**
   * Where an item rests for `kind` ('pickup' | 'deliver') at area `area`: map.json itemSpots /
   * waypoints `<area>_<kind>_<item>` or `<area>_<kind>` ({x, y, z, ry}), else a safe fallback.
   * Writes into `out` ({x, y, z, ry, key}).
   */
  resolveSpot(area, itemId, kind, out) {
    const spots = this.mapData.itemSpots || {};
    const wps = this.mapData.waypoints || {};
    const pick = (key) => {
      const w = spots[key] || wps[key];
      if (w && Number.isFinite(w.x) && Number.isFinite(w.z)) {
        out.x = w.x; out.z = w.z;
        out.y = Number.isFinite(w.y) ? w.y : 0;
        out.ry = Number.isFinite(w.ry) ? w.ry : 0;
        out.key = key;
        return true;
      }
      return false;
    };
    if (pick(`${area}_${kind}_${itemId}`) || pick(`${area}_${kind}`)) return out;

    // Fallback: courts → on the pad between the baseline and the north fence; other areas →
    // their marker / centre point on the ground.
    const areas = this.mapData.areas || {};
    const court = (areas.courts || []).find(c => c && c.id === area);
    out.ry = 0;
    out.key = `${area}_${kind}`;
    if (court && court.center) {
      out.x = court.center.x + 3;
      out.y = SIZES.courtSurfaceY;
      out.z = court.center.z + (SIZES.courtDepth || 28) / 2 - 1.3;
      return out;
    }
    const pt = this.missions.getAreaPoint(area) || (areas[area] && areas[area].center) || { x: 0, z: 0 };
    out.x = pt.x + 0.8; out.y = 0.02; out.z = pt.z;
    return out;
  }

  /** How many live props already occupy `key` (waiting + delivered). */
  _spotCount(key) {
    let n = 0;
    for (let i = 0; i < this.waiting.length; i++) if (this.waiting[i].spotKey === key) n++;
    for (let i = 0; i < this.delivered.length; i++) if (this.delivered[i].spotKey === key) n++;
    return n;
  }

  _place(rec, area, itemId, kind) {
    const s = this.resolveSpot(area, itemId, kind, this._spot || (this._spot = {}));
    const n = this._spotCount(s.key);
    const off = n * STACK_STEP;
    rec.spotKey = s.key;
    rec.x = s.x + Math.cos(s.ry) * off;
    rec.z = s.z - Math.sin(s.ry) * off;
    rec.y = s.y;
    rec.ry = s.ry;
    const m = rec.mesh;
    m.position.set(rec.x, rec.y, rec.z);
    m.rotation.set(0, s.ry, 0);
    this.scene.add(m);
  }

  // ───────────────────────────── waiting (pickup) ─────────────────────────────

  _findWaiting(missionId, itemId) {
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i];
      if (w.missionId === missionId && w.itemId === itemId) return w;
    }
    return null;
  }

  _spawnWaiting(mission, step) {
    const itemId = step.item;
    const mesh = this._acquire(itemId);
    mesh.material = this.hiMaterial;
    const rec = { mesh, itemId, missionId: mission.id, spotKey: '', x: 0, y: 0, z: 0, ry: 0, t: 0, out: -1, alive: true, halo: null, arrow: null };
    this._place(rec, step.location, itemId, 'pickup');
    const def = this._def(itemId);
    rec.halo = this._acquireFx(this._halos, this.haloGeo, this.haloMaterial, 'itemPropHalo');
    rec.halo.position.set(rec.x, rec.y + 0.012, rec.z);
    rec.halo.scale.setScalar(def.radius * 3.4);
    rec.arrow = this._acquireFx(this._arrows, this.arrowGeo, this.arrowMaterial, 'itemPropArrow');
    rec.arrow.position.set(rec.x, rec.y + def.height + 0.45, rec.z);
    this.waiting.push(rec);
    return rec;
  }

  _syncWaiting() {
    for (let i = 0; i < this.waiting.length; i++) this.waiting[i].alive = false;
    const active = this.missions.activeMissions || [];
    for (let i = 0; i < active.length; i++) {
      const m = active[i];
      const step = m && m.steps ? m.steps[m.currentStep] : null;
      if (!step || step.action !== 'pickup' || !ITEMS[step.item]) continue;
      const w = this._findWaiting(m.id, step.item) || this._spawnWaiting(m, step);
      w.alive = true;
      if (w.out >= 0) w.out = -1; // re-offered while popping away: come back
    }
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i];
      if (!w.alive && w.out < 0) {
        // picked up (or the mission went away): drop the fx and pop the prop out
        this._releaseFx(this._halos, w.halo); w.halo = null;
        this._releaseFx(this._arrows, w.arrow); w.arrow = null;
        w.out = POP_TIME * 0.6;
      }
    }
  }

  _updateWaiting(dt) {
    const t = this.time;
    this.hiMaterial.emissiveIntensity = 0.12 + 0.2 * (0.5 + 0.5 * Math.sin(t * 3.2));
    this.haloMaterial.opacity = 0.35 + 0.25 * (0.5 + 0.5 * Math.sin(t * 3.2));
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const w = this.waiting[i];
      w.t += dt;
      const m = w.mesh;
      if (w.out >= 0) {
        w.out -= dt;
        const k = Math.max(0, w.out / (POP_TIME * 0.6));
        m.scale.setScalar(k);
        m.position.y = w.y + (1 - k) * 0.35;
        if (w.out <= 0) {
          this._release(m);
          this.waiting.splice(i, 1);
        }
        continue;
      }
      const intro = Math.min(1, w.t / POP_TIME);
      const ease = 1 - (1 - intro) * (1 - intro);
      // gentle "breathing" hop on the surface (never sinks below it)
      const hop = Math.max(0, Math.sin(t * 2.6 + i)) * 0.025;
      m.scale.setScalar(ease * (1 + 0.035 * Math.sin(t * 3.2)));
      m.position.y = w.y + hop;
      if (w.arrow) {
        const def = this._def(w.itemId);
        w.arrow.position.y = w.y + def.height + 0.42 + Math.sin(t * 2.4 + i) * 0.08;
        w.arrow.rotation.y = t * 1.6;
        w.arrow.scale.setScalar(ease);
      }
      if (w.halo) w.halo.scale.setScalar(this._def(w.itemId).radius * (3.1 + 0.4 * Math.sin(t * 3.2)) * ease);
    }
  }

  // ───────────────────────────── carried ─────────────────────────────

  _anchorObject(anchor) {
    const c = this.player && this.player.character;
    if (!c) return null;
    switch (anchor) {
      case 'handR': return c.handR;
      case 'handL': return c.handL;
      case 'front':
      case 'back': return c.chest;
      default: return null;
    }
  }

  /** Put mesh on a player anchor with the item's mount transform. */
  _mountOnPlayer(rec) {
    const def = this._def(rec.itemId);
    const bone = this._anchorObject(rec.anchor);
    const m = rec.mesh;
    if (!bone) { m.visible = false; return; }
    const ps = SIZES.playerScale || 1;
    if (rec.anchor === 'handR' || rec.anchor === 'handL') {
      const h = def.hand || {};
      const s = (h.s || 1) / ps;
      const r = h.rot || [0, 0, 0];
      _e.set(r[0], r[1], r[2], 'ZYX');
      m.rotation.copy(_e);
      _qq.setFromEuler(_e);
      // grip point → hand: position = handOffset - R * grip * s
      _v.set(def.grip[0], def.grip[1], def.grip[2]).applyQuaternion(_qq).multiplyScalar(s);
      const o = HAND_OFFSET[rec.anchor];
      m.position.set(o[0] - _v.x, o[1] - _v.y, o[2] - _v.z);
      m.scale.setScalar(s);
    } else {
      const mt = def[rec.anchor] || def.front || { pos: [0, -0.34, 0.3], rot: [0, 0, 0], s: 1 };
      const s = (mt.s || 1) / ps;
      m.rotation.set(mt.rot[0], mt.rot[1], mt.rot[2], 'ZYX');
      m.position.set(mt.pos[0], mt.pos[1], mt.pos[2]);
      m.scale.setScalar(s);
    }
    rec.base = m.scale.x;
    bone.add(m);
  }

  _mountInCart(rec, slot) {
    const def = this._def(rec.itemId);
    const anchor = this.cart && (this.cart.seatAnchor || this.cart.mesh);
    const m = rec.mesh;
    if (!anchor) { m.visible = false; return; }
    const cs = SIZES.cartScale || 1;
    const sl = CART_SLOTS[Math.min(slot, CART_SLOTS.length - 1)];
    const s = ((def.rack && def.rack.s) || 1) / cs;
    m.position.set(sl.pos[0], sl.pos[1], sl.pos[2]);
    m.rotation.set(0, sl.ry + (def.rack && def.rack.flat ? Math.PI / 2 : 0), 0);
    m.scale.setScalar(s);
    rec.base = s;
    anchor.add(m);
  }

  _rebuildCarried() {
    const inCart = !!(this.player && this.player.isInCart);
    const items = this.inventory ? this.inventory.items : [];
    // Keep existing meshes for items still held (no pop), release the rest
    const keep = this._keep || (this._keep = []);
    keep.length = 0;
    for (let i = 0; i < items.length; i++) {
      const id = items[i] && items[i].id;
      let rec = null;
      for (let j = 0; j < this.carried.length; j++) {
        const c = this.carried[j];
        if (c.itemId === id && keep.indexOf(c) < 0) { rec = c; break; }
      }
      if (!rec) rec = { mesh: this._acquire(id), itemId: id, anchor: null, base: 1, t: 0 };
      keep.push(rec);
    }
    for (let j = 0; j < this.carried.length; j++) {
      if (keep.indexOf(this.carried[j]) < 0) this._release(this.carried[j].mesh);
    }
    this.carried.length = 0;
    for (let i = 0; i < keep.length; i++) this.carried.push(keep[i]);

    // Assign anchors (first free preferred anchor per item) and mount
    const used = this._used || (this._used = new Set());
    used.clear();
    for (let i = 0; i < this.carried.length; i++) {
      const rec = this.carried[i];
      const m = rec.mesh;
      if (m.parent) m.parent.remove(m);
      m.visible = true;
      if (inCart) {
        rec.anchor = 'cart';
        this._mountInCart(rec, i);
      } else {
        const def = this._def(rec.itemId);
        let a = null;
        for (const cand of def.anchors) if (!used.has(cand)) { a = cand; break; }
        if (!a) a = ['handR', 'handL', 'front', 'back'].find(x => !used.has(x)) || 'front';
        used.add(a);
        rec.anchor = a;
        this._mountOnPlayer(rec);
      }
      if (rec.t >= POP_TIME) m.scale.setScalar(rec.base);
    }
    this._carriedInCart = inCart;
    this._carriedDirty = false;
  }

  _updateCarried(dt) {
    const inCart = !!(this.player && this.player.isInCart);
    if (this._carriedDirty || inCart !== this._carriedInCart) this._rebuildCarried();
    for (let i = 0; i < this.carried.length; i++) {
      const rec = this.carried[i];
      if (rec.t < POP_TIME) {
        rec.t += dt;
        const k = Math.min(1, rec.t / POP_TIME);
        const back = 1 + 0.25 * Math.sin(k * Math.PI);   // small overshoot pop
        rec.mesh.scale.setScalar(rec.base * k * back);
      }
    }
  }

  // ───────────────────────────── delivered ─────────────────────────────

  /**
   * An item was handed over at `location` for `mission` (MissionSystem.onItemDelivered).
   * Sets the prop down at the delivery spot and gets the mission's client to react.
   */
  onDelivered(mission, item, location) {
    const itemId = item && item.id;
    if (!itemId) return;
    const mesh = this._acquire(itemId);
    const rec = {
      mesh, itemId, spotKey: '', x: 0, y: 0, z: 0, ry: 0, t: 0, hold: DELIVERED_HOLD,
      npc: null, reacted: false, walkT: 0, line: THANKS[itemId] || 'Thank you!',
    };
    this._place(rec, location, itemId, 'deliver');
    mesh.scale.setScalar(0.001);
    this.delivered.push(rec);
    this._startReaction(rec, mission);
  }

  _startReaction(rec, mission) {
    const ms = this.missions;
    const npcs = ms.npcsMap;
    let npc = mission && mission.client && npcs ? npcs.get(mission.client) : null;
    if (!npc && npcs) {
      // No client: the nearest member within a few metres reacts
      let best = 6;
      for (const n of npcs.values()) {
        const d = this._npcDist(n, rec.x, rec.z);
        if (d < best) { best = d; npc = n; }
      }
    }
    if (npc && npcs && this._npcDist(npc, rec.x, rec.z) > REACT_WALK_MAX) {
      // The client is elsewhere on the grounds: they still smile (radio'd thanks) and a
      // member standing nearby comes over to look instead.
      try { npc.showReaction('😊'); } catch (e) { /* cosmetic */ }
      let near = null, best = 10;
      for (const n of npcs.values()) {
        if (n === npc) continue;
        const dd = this._npcDist(n, rec.x, rec.z);
        if (dd < best) { best = dd; near = n; }
      }
      npc = near;
    }
    if (!npc) { rec.reacted = true; return; }
    rec.npc = npc;
    const d = this._npcDist(npc, rec.x, rec.z);
    const free = (npc.state === 'idle' || npc.state === 'wandering') && !npc._holdSeat && !npc._sitSeat;
    if (d > REACT_NEAR && d < REACT_WALK_MAX && free) {
      // Walk over to a point just beside the item, then react
      try {
        if (typeof npc._cancelSeatTarget === 'function') npc._cancelSeatTarget();
        const dx = npc.body.position.x - rec.x, dz = npc.body.position.z - rec.z;
        const k = 1.1 / Math.max(0.001, Math.hypot(dx, dz));
        npc.currentTarget = { x: rec.x + dx * k, z: rec.z + dz * k };
        npc.state = 'wandering';
        npc._wanderTime = 0;
        npc._reactHold = 0;
        return;
      } catch (e) { /* fall through: react on the spot */ }
    }
    this._react(rec);
  }

  _npcDist(npc, x, z) {
    const p = npc && npc.body ? npc.body.position : (npc && npc.mesh ? npc.mesh.position : null);
    if (!p) return Infinity;
    const dx = p.x - x, dz = p.z - z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  _react(rec) {
    rec.reacted = true;
    const npc = rec.npc;
    if (!npc) return;
    try {
      if (npc.state !== 'playing' && npc.state !== 'talking' && npc.mesh) {
        const dx = rec.x - npc.mesh.position.x, dz = rec.z - npc.mesh.position.z;
        if (dx * dx + dz * dz < 25) npc.mesh.rotation.y = Math.atan2(dx, dz);
      }
      npc.showReaction('😊');
      if (typeof npc.say === 'function') npc.say(rec.line, 2.6);
    } catch (e) { /* cosmetic only */ }
  }

  _updateDelivered(dt) {
    for (let i = this.delivered.length - 1; i >= 0; i--) {
      const d = this.delivered[i];
      d.t += dt;
      d.hold -= dt;
      const m = d.mesh;
      if (d.hold <= 0) {
        this._release(m);
        this.delivered.splice(i, 1);
        continue;
      }
      let k = 1;
      if (d.t < POP_TIME) {
        const a = d.t / POP_TIME;
        k = a * (1 + 0.2 * Math.sin(a * Math.PI));
        m.position.y = d.y + (1 - a) * 0.25;
      } else if (d.hold < POP_TIME) {
        k = d.hold / POP_TIME;
      } else if (m.position.y !== d.y) {
        m.position.y = d.y;
      }
      m.scale.setScalar(Math.max(0.001, k));

      if (!d.reacted) {
        d.walkT += dt;
        const npc = d.npc;
        const near = this._npcDist(npc, d.x, d.z) < REACT_NEAR + 0.3;
        if (near || d.walkT > REACT_TIMEOUT || !npc || npc.state === 'talking' || npc.state === 'playing') {
          this._react(d);
        }
      }
    }
  }

  // ───────────────────────────── per frame ─────────────────────────────

  update(dt) {
    this.time += dt;
    this._syncWaiting();
    this._updateWaiting(dt);
    this._updateCarried(dt);
    this._updateDelivered(dt);
  }

  /** Debug / tests: counts of live props. */
  getStats() {
    return { waiting: this.waiting.length, carried: this.carried.length, delivered: this.delivered.length };
  }
}
