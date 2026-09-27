import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES } from '../utils/Constants.js';
import { mat, getMaterial, registerWet, registerNightGlow, sharedDepthMaterial } from '../graphics/Materials.js';
import { Textures } from '../graphics/Textures.js';
import { boxGeo, cylinderGeo, getGeometry, mergeParts, makeMatrix } from '../graphics/GeometryUtils.js';
import { Quality } from '../graphics/Quality.js';
import { Mat, ATLAS, regionUV, atlasPlane, boxUV, segMatrix } from './Building.js';
import { courtLampGlassMaterial, courtHaloMaterial, registerCourtHalos } from './Court.js';
import { GROUND_GROUPS } from './Ground.js';
import { registerNav } from './NavRooms.js';
import { RoutePlanner } from '../systems/RoutePlanner.js';
import { registerSeat } from '../entities/Seats.js';

/**
 * Stadium — the sunken Centre Court bowl in the world: stand / rim visuals, the stand and rim
 * physics compounds, the pit-floor plane, the collision-mask filter for the hole in the y = 0
 * ground plane, the rescue pass, spectator seats, scoreboards and the crowd impostors.
 * Everything geometric comes from the pure StadiumLayout (world.stadiumLayout).
 *
 * World constructs it right after the courts / court junctions (before the perimeter, trees,
 * lamps, grass and scenery.build(): the rim benches go into the scenery batch) and calls:
 *   world.stepPhysics(dt) → preStep() → physicsWorld.step(...) → postFrame()
 *   world.update(dt)      → update(dt)
 *
 * Visuals (all in StadiumRoot, added to the scene with matrixAutoUpdate off; ~13 draw calls on
 * existing programs only — no new shader program on any tier):
 *   CentreCourtConcrete   floor walkway, rows (green riser + light tread cap), aisle half-steps
 *                         with gold nosings, coping, arch piers, mast plinths, the bollard; the
 *                         wall-stone program (concrete map + vertex colours, fake AO baked in)
 *   CentreCourtSeats@w|e|n|s  ~1,600 instanced seats, instance colours only (the parked-car program)
 *   CentreCourtCrowdBodies / Heads  instanced crowd impostors on unused seats (same material)
 *   CentreCourtMetal      rail, box rail, Players' Walk handrails, masts + heads, arch beam,
 *                         scoreboard housings + legs (Building's metal)
 *   CentreCourtGlass      mast lamp tiles, arch lanterns (the court floodlight glass)
 *   centreCourtHalos      8 points on the court halo material (lamp factor)
 *   CentreCourtScoreFaces both scoreboard faces on one canvas texture (redrawn on a change only)
 *   CentreCourtSign       the "CENTRE COURT" boards on the arch (Building's sign atlas)
 *
 * Physics (see Ground.GROUND_GROUPS): the y = 0 plane is GROUND_TOP; a dynamic body whose centre
 * is inside the cut drops GROUND_TOP from its mask and falls through the hole onto a stand box or
 * the infinite pit-floor plane (PIT_FLOOR, y = surfY); ghost spectators (SPECTATOR) are left out
 * of every dynamic mask. Masks are written before each world.step (preStep: teleports) and after
 * every substep (the postStep listener: cannon-es fires it after integrate, so the next
 * substep's broadphase sees them). The rescue pass (postFrame) lifts embedded / fallen bodies
 * and pushes the cart out of the footprint.
 */

const DEV = !!(import.meta.env && import.meta.env.DEV);
const DYN = CANNON.Body.DYNAMIC;
const SPHERE = CANNON.Shape.types.SPHERE;
const MASK_IN = ~(GROUND_GROUPS.GROUND_TOP | GROUND_GROUPS.SPECTATOR);   // -11
const MASK_OUT = ~GROUND_GROUPS.SPECTATOR;                                // -9

const C = {
  riser: COLORS.stadiumRiser ?? 0x2a513b,
  tread: COLORS.stadiumTread ?? 0xe3d8c0,
  walk: COLORS.stadiumWalk ?? 0x2c5a40,
  stone: COLORS.stadiumStone ?? 0xeae2cf,
  rail: COLORS.stadiumRail ?? 0x1f3a2b,
  trim: COLORS.stadiumTrim ?? 0xd9a441,
  board: 0x173a28,
  mast: 0x2b4a36,
  lampHead: 0x4c544e,
  brass: 0xc9a54c,
};

const SHIRTS = [0xf4efe6, 0xe9dfc6, 0x2f3e5c, 0x8fae8b, 0x9cc3e0, 0xe8b4b8, 0xd9a441, 0x2d5a3d];
const SKINS = [0xf1c9a5, 0xd9a47e, 0xa8744f, 0x7a4f33];

const HANDRAIL_H = 0.9;      // Players' Walk handrails above the nosing line
const SIGN_Y = 3.7;          // arch sign centre (the 3.2 × 0.8 boards span y 3.3..4.1)
const CHEER_TIME = 0.35;     // crowd lift duration (s)
const CROWD_RATE = 6;        // crowd impostors added / removed per second
const SCORE_POLL = 0.5;      // scoreboard poll (s)
const PTS = ['0', '15', '30', '40', 'AD'];
const NONE2 = Object.freeze(['', '']);
const ZERO2 = Object.freeze([0, 0]);

const _col = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _exit = { x: 0, z: 0, y: 0 };
const _push = { x: 0, z: 0 };

/** True when every component is finite (one NaN / ±Infinity makes the sum non-finite). */
function finite3(v) {
  return Number.isFinite(v.x + v.y + v.z);
}
function finiteQ(q) {
  return Number.isFinite(q.x + q.y + q.z + q.w);
}

function hashU(i, j) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Axis-aligned boxes baked straight into one indexed geometry (position, normal, colour): the
 * bottom faces are dropped (never seen), colours get the bowl's fake AO (darker toward the pit)
 * and a box may darken its back edge (tread caps: a contact shadow under the next riser).
 */
class BoxSoup {
  constructor(surfY, depth) {
    this.surfY = surfY;
    this.depth = depth;
    this.p = [];
    this.n = [];
    this.c = [];
    this.i = [];
  }

  /** back: { axis: 'x' | 'z', value } darkens that edge's vertices by 10 %. */
  box(x0, x1, y0, y1, z0, z1, color, back = null) {
    _col.set(color);
    const r = _col.r, g = _col.g, b = _col.b;
    const face = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz) => {
      const base = this.p.length / 3;
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz], [dx, dy, dz]]) {
        this.p.push(x, y, z);
        this.n.push(nx, ny, nz);
        let f = 0.86 + 0.14 * Math.min(1, Math.max(0, (y - this.surfY) / this.depth));
        if (back && Math.abs((back.axis === 'x' ? x : z) - back.value) < 1e-6) f *= 0.9;
        this.c.push(r * f, g * f, b * f);
      }
      this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    face(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 1, 0, 0);     // +x
    face(x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, -1, 0, 0);    // -x
    face(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0);     // +y
    face(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1);     // +z
    face(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1);    // -z
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

export class Stadium {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {import('cannon-es').World} o.physicsWorld
   * @param {import('./World.js').World} o.world
   * @param {import('./Court.js').Court} o.court   the stadium court (court6)
   * @param {import('./StadiumLayout.js').StadiumLayout} o.layout
   * @param {import('./Scenery.js').Scenery} o.scenery  (rim benches go in before scenery.build())
   */
  constructor({ scene, physicsWorld, world, court, layout, scenery }) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.world = world;
    this.court = court || null;
    this.layout = layout;
    this.scenery = scenery;
    this.matches = null;

    /** Every stadium mesh lives here (added to the scene, not World.staticRoot). */
    this.root = new THREE.Group();
    this.root.name = 'StadiumRoot';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    scene.add(this.root);

    /** Seats.js seat objects (reserved) that spectators and after-hours staff use. */
    this.spectatorSeats = [];
    /** Rescue-pass counters (debug / tests). */
    this.stats = { rescues: 0, cartPushes: 0 };

    this._warned = new WeakSet();
    this._dbgFrame = 0;
    this._dbgSeen = new Set();

    this._buildConcrete();
    this._buildSeats();
    this._buildCrowd();
    this._buildMetalAndGlass();
    this._buildScoreboards();
    this._buildSign();
    this._buildPhysics();

    // Navigation: wanderers and scripted walks go round the bowl; StadiumLayout plans the stairs
    const fp = layout.footprint;
    registerNav({ blockers: [{ x0: fp.x0, x1: fp.x1, z0: fp.z0, z1: fp.z1 }] });
    RoutePlanner.addVirtualRect({ x0: fp.x0, z0: fp.z0, x1: fp.x1, z1: fp.z1 });

    // The reserved stand seats (row order, row 0 first) and the ordinary rim benches
    for (const s of layout.spectatorSeatSpecs) {
      this.spectatorSeats.push(registerSeat(s.x, s.y, s.z, s.yaw, s.id, {
        reserved: true, approach: s.opts.approach, stadium: { ...s.opts.stadium },
      }));
    }
    if (scenery) for (const b of layout.rimBenches) scenery.addBench(b.x, 0, b.z, b.yaw);

    this._applyQuality(Quality.settings);
    this._offQuality = Quality.onChange((tier, settings) => this._applyQuality(settings));

    this._onPostStep = () => this._filter(true);
    physicsWorld.addEventListener('postStep', this._onPostStep);
  }

  // ───────────────────────────── physics ─────────────────────────────

  _buildPhysics() {
    const L = this.layout, W = this.physicsWorld;
    // Pit floor: an infinite plane at court level (also the catch-all under the whole bowl)
    const pit = new CANNON.Body({ mass: 0 });
    pit.addShape(new CANNON.Plane());
    pit.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    pit.position.set(0, L.surfY, 0);
    pit.collisionFilterGroup = GROUND_GROUPS.PIT_FLOOR;
    pit.collisionFilterMask = -1;
    W.addBody(pit);
    this.pitBody = pit;
    // One compound per stand (broadphase culls the far ones) + one for the rim
    this.bodies = {};
    for (const tag of ['w', 'e', 'n', 's', 'rim']) {
      const list = L.boxes.filter(b => b.stand === tag);
      if (!list.length) continue;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const b of list) {
        x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
        y0 = Math.min(y0, b.y0); y1 = Math.max(y1, b.y1);
        z0 = Math.min(z0, b.z0); z1 = Math.max(z1, b.z1);
      }
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
      const body = new CANNON.Body({ mass: 0 });
      body.position.set(mx, my, mz);
      for (const b of list) {
        body.addShape(new CANNON.Box(new CANNON.Vec3(b.hx, b.hy, b.hz)), new CANNON.Vec3(b.cx - mx, b.cy - my, b.cz - mz));
      }
      W.addBody(body);
      this.bodies[tag] = body;
    }
  }

  /** Collision masks from the current positions (+ the bowl's vy cap after a substep). */
  _filter(cap) {
    const c = this.layout.cut, B = this.physicsWorld.bodies, vcap = SIZES.bowlVyCap ?? 2.0;
    const x0 = c.x0, x1 = c.x1, z0 = c.z0, z1 = c.z1;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (b.type !== DYN) continue;
      const p = b.position;
      const inside = p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1;
      b.collisionFilterMask = inside ? MASK_IN : MASK_OUT;
      if (cap && inside && b.velocity.y > vcap) b.velocity.y = vcap;
    }
  }

  /**
   * Before physicsWorld.step: collision masks from the current body positions (teleports since
   * the last frame), then the rescue pass once, so a body a script moved under the ground (e.g.
   * slid from the pit out past the rim at pit height) is lifted before the solver would launch it.
   */
  preStep() {
    this._filter(false);
    this._rescue();
  }

  /** After physicsWorld.step: rescue embedded / fallen bodies, push the cart out of the footprint. */
  postFrame() {
    this._rescue();
    if (DEV && ++this._dbgFrame >= 120) {
      this._dbgFrame = 0;
      const probs = this.debugCheck();
      for (let i = 0; i < probs.length; i++) {
        const k = probs[i].split(':')[0];
        if (this._dbgSeen.has(k)) continue;
        this._dbgSeen.add(k);
        console.warn(`[Stadium] ${probs[i]}`);
      }
    }
  }

  /**
   * Rescue pass (every dynamic body that collides; the player's body in the cart is skipped):
   *  1. a non-finite position goes to the nearest aisle top; a non-finite velocity, angular
   *     velocity, quaternion, force or torque (with a finite position) is reset where it stands —
   *     one NaN in the solver would otherwise spread to every body it touches and the static
   *     ground, and cannon-es would throw on every later step;
   *  2. a vehicle (more than one shape / not a sphere) inside the footprint + 0.3 is pushed out;
   *  3. a sphere that fell (y < surfY − 1), sits under the lawn outside the cut (y < −0.1: only a
   *     teleport at pit height does that), or is embedded in the cut (below the lowest ground
   *     within 0.3 m − 0.05) is put back on the ground.
   * A static body (the ground and pit planes, the stands) never moves, so a non-finite velocity
   * on one (the solver adds 0 × NaN to it) is zeroed.
   * A body pressed against a riser sees the lower row in groundMinAround, so it is never lifted a
   * row (no climbing assist). On the flat club none of this ever fires (bodies rest at y = r).
   */
  _rescue() {
    const L = this.layout, B = this.physicsWorld.bodies;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (b.type !== DYN) {
        if (!finite3(b.velocity) || !finite3(b.angularVelocity)) {
          b.velocity.set(0, 0, 0);
          b.angularVelocity.set(0, 0, 0);
          this.stats.rescues++;
          this._warnOnce(b, 'non-finite velocity on a static body');
        }
        continue;
      }
      if (b.collisionResponse === false) continue;
      const p = b.position;
      const vehicle = b.shapes.length > 1 || b.shapes[0].type !== SPHERE;
      const r = vehicle ? 0.6 * SIZES.cartScale : b.shapes[0].radius;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
        L.nearestExit(Number.isFinite(p.x) ? p.x : L.cx, Number.isFinite(p.z) ? p.z : L.cz, _exit);
        this._place(b, _exit.x, (vehicle ? r : r + 0.02), _exit.z);
        this.stats.rescues++;
        this._warnOnce(b, 'non-finite position');
        continue;
      }
      if (!finite3(b.velocity) || !finite3(b.angularVelocity) || !finiteQ(b.quaternion) || !finite3(b.force) || !finite3(b.torque)) {
        this._resetMotion(b, vehicle);
        this.stats.rescues++;
        this._warnOnce(b, 'non-finite velocity / rotation');
      }
      if (vehicle) {
        if (L.inFootprint(p.x, p.z, 0.3)) {
          L.pushOutOfFootprint(p.x, p.z, 1.6, _push);
          this._place(b, _push.x, r, _push.z);
          this.stats.cartPushes++;
          this._warnOnce(b, 'vehicle inside the stadium footprint');
        }
        continue;
      }
      const inside = L.inCut(p.x, p.z);
      if (p.y < L.surfY - 1.0 || (!inside && p.y < -0.1) || (inside && p.y < L.groundMinAround(p.x, p.z, 0.3) - 0.05)) {
        this._place(b, p.x, L.groundAt(p.x, p.z) + r + 0.02, p.z);
        this.stats.rescues++;
        this._warnOnce(b, 'embedded / fallen');
      }
    }
  }

  _place(b, x, y, z) {
    b.position.set(x, y, z);
    b.previousPosition.set(x, y, z);
    b.interpolatedPosition.set(x, y, z);
    this._resetMotion(b, b.shapes.length > 1 || b.shapes[0].type !== SPHERE);
    // the mask follows the new position at once
    const c = this.layout.cut;
    b.collisionFilterMask = (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1) ? MASK_IN : MASK_OUT;
  }

  /**
   * Zero velocity, angular velocity, force and torque; the orientation becomes upright: identity,
   * or for a vehicle its yaw alone (the twist about y) when its quaternion is still finite.
   */
  _resetMotion(b, vehicle) {
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.force.set(0, 0, 0);
    b.torque.set(0, 0, 0);
    const q = b.quaternion;
    let qy = 0, qw = 1;
    if (vehicle && finiteQ(q)) {
      const n = Math.hypot(q.y, q.w);
      if (n > 1e-6) { qy = q.y / n; qw = q.w / n; }
    }
    q.set(0, qy, 0, qw);
    b.previousQuaternion.copy(q);
    b.interpolatedQuaternion.copy(q);
  }

  _warnOnce(b, what) {
    if (this._warned.has(b)) return;
    this._warned.add(b);
    console.warn(`[Stadium] rescued a body (${what}) at (${b.position.x.toFixed(2)}, ${b.position.y.toFixed(2)}, ${b.position.z.toFixed(2)})`);
  }

  /**
   * DEV: invariants on the live bodies — I7 (a dynamic body has bit 2 cleared iff its centre is in
   * the cut, bit 8 always cleared) and I3 (a sphere in the cut rests no lower than the ground under
   * it). Runs every 120 frames from postFrame in dev builds; returns a list of problems.
   */
  debugCheck() {
    const L = this.layout, B = this.physicsWorld.bodies, out = this._dbgOut || (this._dbgOut = []);
    out.length = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (b.type !== DYN) continue;
      const p = b.position, m = b.collisionFilterMask;
      const inside = L.inCut(p.x, p.z);
      if (((m & GROUND_GROUPS.GROUND_TOP) === 0) !== inside || (m & GROUND_GROUPS.SPECTATOR) !== 0) {
        out.push(`I7: body ${b.id} mask ${m} at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}), in cut ${inside}`);
      }
      if (inside && b.collisionResponse !== false && b.shapes.length === 1 && b.shapes[0].type === SPHERE) {
        const g = L.groundMinAround(p.x, p.z, 0.3), r = b.shapes[0].radius;
        if (p.y < g + r - 0.12) out.push(`I3: body ${b.id} at y ${p.y.toFixed(3)} below the ground ${g.toFixed(3)} + r`);
      }
    }
    return out;
  }

  // ───────────────────────────── per frame ─────────────────────────────

  /** Per frame: scoreboard poll, crowd ramp and cheer. Allocation-free. */
  update(dt) {
    if (!(dt > 0)) return;
    this._sbT -= dt;
    if (this._sbT <= 0) {
      this._sbT = SCORE_POLL;
      try { this._pollScoreboard(); } catch (e) { /* cosmetic */ }
    }
    this._updateCrowd(dt);
  }

  /** The MatchSystem the scoreboards read (getMatch / nextEntryFor). */
  setMatchSource(matchSystem) {
    this.matches = matchSystem || null;
    this._sbT = 0;
  }

  /**
   * A score of the caller's own on both faces (after-hours tennis) instead of the MatchSystem
   * booking: o = { names: [a, b], games: [n, n], points: [s, s], server: 0 | 1, sets: [n, n] }
   * ('CENTRE COURT', then a row per player: name · serve dot · games · points, and a sets column
   * once a set has been won). null goes back to the MatchSystem source. The canvas is redrawn
   * only when a value changes; a repeated call with the same values allocates nothing.
   */
  setScoreOverride(o) {
    const ov = this._ov;
    if (!ov) return;
    if (!o) {
      if (!ov.on) return;
      ov.on = false;
      // the next poll (now) redraws whatever the MatchSystem shows
      this._sbMatch = undefined;
      this._sbKey = -1;
      this._sbStart = -2;
      this._sbT = 0;
      try { this._pollScoreboard(); } catch (e) { /* cosmetic */ }
      return;
    }
    const n = o.names || NONE2, g = o.games || ZERO2, p = o.points || NONE2, s = o.sets || ZERO2;
    const server = o.server === 1 ? 1 : 0;
    const g0 = g[0] | 0, g1 = g[1] | 0, s0 = s[0] | 0, s1 = s[1] | 0;
    if (ov.on && n[0] === ov.n0 && n[1] === ov.n1 && g0 === ov.g0 && g1 === ov.g1 && p[0] === ov.p0 && p[1] === ov.p1
        && server === ov.server && s0 === ov.s0 && s1 === ov.s1) return;
    ov.on = true;
    ov.n0 = n[0]; ov.n1 = n[1];
    ov.g0 = g0; ov.g1 = g1;
    ov.p0 = p[0]; ov.p1 = p[1];
    ov.s0 = s0; ov.s1 = s1;
    ov.server = server;
    this._drawOverride();
  }

  // ───────────────────────────── concrete ─────────────────────────────

  _buildConcrete() {
    const L = this.layout, N = L.N, T = L.T, cx = L.cx, cz = L.cz, surfY = L.surfY;
    const soup = new BoxSoup(surfY, Math.max(0.5, -surfY));
    const U = L.U, V = L.V, H = L.H;
    // stand-local (d0..d1, a0..a1) → world rect on stand si, and that stand's back edge
    const rectOf = (si, d0, d1, a0, a1) => {
      switch (si) {
        case 0: return [cx - d1, cx - d0, cz + a0, cz + a1, { axis: 'x', value: cx - d1 }];
        case 1: return [cx + d0, cx + d1, cz + a0, cz + a1, { axis: 'x', value: cx + d1 }];
        case 2: return [cx + a0, cx + a1, cz + d0, cz + d1, { axis: 'z', value: cz + d1 }];
        default: return [cx + a0, cx + a1, cz - d1, cz - d0, { axis: 'z', value: cz - d1 }];
      }
    };
    const standBox = (si, d0, d1, a0, a1, y0, y1, color, darkBack = false) => {
      const [x0, x1, z0, z1, back] = rectOf(si, d0, d1, a0, a1);
      soup.box(x0, x1, y0, y1, z0, z1, color, darkBack ? back : null);
    };
    // Ring between rect (iu, iv) and (ou, ov) around the centre: four boxes (the u sides take the corners)
    const ring = (iu, iv, ou, ov, y0, y1, color) => {
      soup.box(cx - ou, cx - iu, y0, y1, cz - ov, cz + ov, color);
      soup.box(cx + iu, cx + ou, y0, y1, cz - ov, cz + ov, color);
      soup.box(cx - iu, cx + iu, y0, y1, cz + iv, cz + ov, color);
      soup.box(cx - iu, cx + iu, y0, y1, cz - ov, cz - iv, color);
    };
    // Pit floor: the green walkway round the pad (to row 0's front half), row 0's light back half
    const padU = L.pad.x1 - cx, padV = L.pad.z1 - cz;
    ring(padU, padV, U[0] + T / 2, V[0] + T / 2, surfY - 0.1, surfY, C.walk);
    ring(U[0] + T / 2, V[0] + T / 2, U[1], V[1], surfY - 0.1, surfY, C.tread);
    // Rows 1..N−1: a deep-green riser box and a light tread cap (its 4 cm front face is the nosing line)
    for (let k = 1; k < N; k++) {
      for (let si = 0; si < 4; si++) {
        const isSide = si < 2;
        const d0 = isSide ? U[k] : V[k], d1 = isSide ? U[k + 1] : V[k + 1];
        const ext = isSide ? V[k + 1] : U[k];
        standBox(si, d0, d1, -ext, ext, H[k] - L.R - 0.02, H[k] - 0.04, C.riser);
        standBox(si, d0, d1, -ext, ext, H[k] - 0.04, H[k], C.tread, true);
      }
    }
    // Aisles: half-steps on the back half of rows 0..N−2, gold nosings on every step front
    for (const a of L.aisles) {
      const si = a.sideIndex, front = si < 2 ? U : V;
      const a0 = a.at - a.half, a1 = a.at + a.half, n0 = a0 + 0.02, n1 = a1 - 0.02;
      for (let k = 0; k < N - 1; k++) {
        const top = H[k] + L.R / 2, d = front[k] + T / 2;
        standBox(si, d, front[k + 1], a0, a1, H[k] - 0.02, top, C.tread);
        standBox(si, d - 0.015, d + 0.035, n0, n1, top - 0.02, top + 0.015, C.trim);
      }
      for (let k = 1; k < N; k++) {
        const d = front[k];
        standBox(si, d - 0.015, d + 0.035, n0, n1, H[k] - 0.02, H[k] + 0.015, C.trim);
      }
    }
    // Coping over the lawn / top-row seam: 6 cm proud, a flush threshold (1.5 cm) across each aisle
    const cutU = U[N], cutV = V[N], c0 = -0.05, c1 = 0.5;
    for (let si = 0; si < 4; si++) {
      const isSide = si < 2, cutD = isSide ? cutU : cutV;
      const ext = isSide ? cutV + c1 : cutU + c0;   // the side pieces take the corners
      const cuts = L.aisles.filter(a => a.sideIndex === si).map(a => [a.at - a.half, a.at + a.half]).sort((p, q) => p[0] - q[0]);
      let s = -ext;
      for (const [g0, g1] of cuts) {
        if (g0 > s) standBox(si, cutD + c0, cutD + c1, s, g0, -0.06, 0.06, C.stone);
        standBox(si, cutD + c0, cutD + c1, g0, g1, -0.06, 0.015, C.stone);
        s = g1;
      }
      if (ext > s) standBox(si, cutD + c0, cutD + c1, s, ext, -0.06, 0.06, C.stone);
    }
    // Arch piers (plinth, shaft, cap) and the Players' Walk bollard
    if (L.arch) {
      for (const p of L.arch.piers) {
        soup.box(p.x - 0.35, p.x + 0.35, 0, 0.22, p.z - 0.35, p.z + 0.35, C.stone);
        soup.box(p.x - 0.275, p.x + 0.275, 0.22, 2.85, p.z - 0.275, p.z + 0.275, C.stone);
        soup.box(p.x - 0.33, p.x + 0.33, 2.85, 2.95, p.z - 0.33, p.z + 0.33, C.stone);
      }
    }
    for (const b of L.bollards) {
      const cutD = b.si < 2 ? cutU : cutV, dm = cutD + (L.rail.d0 + L.rail.d1) / 2, h = b.size / 2;
      standBox(b.si, dm - h, dm + h, b.a - h, b.a + h, 0, 0.84, C.stone);
      standBox(b.si, dm - h - 0.03, dm + h + 0.03, b.a - h - 0.03, b.a + h + 0.03, 0.84, 0.92, C.stone);
    }
    // Mast plinths
    for (const m of L.masts) soup.box(m.x - 0.6, m.x + 0.6, 0, 0.4, m.z - 0.6, m.z + 0.6, C.stone);

    const geo = soup.toGeometry();
    boxUV(geo, 2.5);
    const material = mat(0xffffff, {
      map: Textures.concrete({ joints: true, repeat: [1, 1] }), vertexColors: true, roughness: 0.9, wet: 0.7, name: 'stadiumConcrete',
    });
    this._addMesh('CentreCourtConcrete', geo, material, true, true);
  }

  // ───────────────────────────── seats + crowd ─────────────────────────────

  static seatMaterial() {
    return getMaterial('stadium-seat-inst', () => registerWet(new THREE.MeshStandardMaterial({ roughness: 0.55 }), 0.5));
  }

  _buildSeats() {
    const L = this.layout;
    const geo = getGeometry('stadium-seat', () => {
      const g = mergeParts([
        { geometry: boxGeo(0.46, 0.475, 0.4), matrix: makeMatrix(0, 0.2375, 0) },
        { geometry: boxGeo(0.46, 0.38, 0.05), matrix: makeMatrix(0, 0.475 + 0.19 * Math.cos(0.2094), -0.175 - 0.19 * Math.sin(0.2094), 0, 1, -0.2094) },
      ]);
      g.deleteAttribute('uv');
      return g;
    });
    const material = Stadium.seatMaterial();
    this.seatMeshes = [];
    for (const side of ['w', 'e', 'n', 's']) {
      const items = [];
      for (const s of L.seats) {
        if (s.side !== side) continue;
        items.push({ position: [s.x, s.baseY, s.z], rotationY: s.yaw, color: s.color });
      }
      if (!items.length) continue;
      const im = new THREE.InstancedMesh(geo, material, items.length);
      im.name = `CentreCourtSeats@${side}`;
      items.forEach((it, i) => {
        _m4.makeRotationY(it.rotationY).setPosition(it.position[0], it.position[1], it.position[2]);
        im.setMatrixAt(i, _m4);
        im.setColorAt(i, _col.set(it.color));
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.receiveShadow = true;
      im.castShadow = false;
      im.customDepthMaterial = sharedDepthMaterial('instancedColor');
      im.computeBoundingSphere();
      im.matrixAutoUpdate = false;
      this.root.add(im);
      this.seatMeshes.push(im);
    }
  }

  _buildCrowd() {
    const L = this.layout, cfg = L.config.crowd || {};
    const cap = Math.max(0, Math.min(600, Number.isInteger(cfg.capacity) ? cfg.capacity : 240));
    this._crowdCapHigh = cap;
    this._crowdCapLow = Math.max(0, Math.min(cap, Number.isInteger(cfg.capacityLow) ? cfg.capacityLow : 120));
    // Unregistered seats, nearest the middle of each stand, low rows and the Members' Box first
    const pool = L.seats.filter(s => !s.registered)
      .map(s => ({ s, k: Math.abs(s.along) / 6 + s.row / 3 - (s.box ? 1 : 0) + hashU(s.index, 7) }))
      .sort((a, b) => a.k - b.k)
      .slice(0, cap)
      .map(e => e.s);
    const n = Math.max(1, pool.length);
    const bodyGeo = getGeometry('stadium-crowd-body', () => {
      const g = mergeParts([
        { geometry: boxGeo(0.4, 0.46, 0.26), matrix: makeMatrix(0, 0.3, -0.05) },
        { geometry: boxGeo(0.36, 0.14, 0.4), matrix: makeMatrix(0, 0.07, 0.12) },
      ]);
      g.deleteAttribute('uv');
      return g;
    });
    const headGeo = getGeometry('stadium-crowd-head', () => {
      const g = new THREE.IcosahedronGeometry(0.11, 0);
      g.translate(0, 0.68, -0.04);
      g.deleteAttribute('uv');
      return g;
    });
    const material = Stadium.seatMaterial();
    const bodies = new THREE.InstancedMesh(bodyGeo, material, n);
    const heads = new THREE.InstancedMesh(headGeo, material, n);
    heads.instanceMatrix = bodies.instanceMatrix;   // one upload serves both
    this._crowdBaseY = new Float32Array(n);
    pool.forEach((s, i) => {
      _m4.makeRotationY(s.yaw).setPosition(s.x, s.y, s.z);
      bodies.setMatrixAt(i, _m4);
      this._crowdBaseY[i] = s.y;
      bodies.setColorAt(i, _col.set(SHIRTS[Math.floor(hashU(s.index, 11) * SHIRTS.length)]));
      heads.setColorAt(i, _col.set(SKINS[Math.floor(hashU(s.index, 13) * SKINS.length)]));
    });
    if (!pool.length) { bodies.setColorAt(0, _col.set(0xffffff)); heads.setColorAt(0, _col.set(0xffffff)); }
    const sphere = new THREE.Sphere(new THREE.Vector3(L.cx, -1.5, L.cz), 32);
    for (const [im, name] of [[bodies, 'CentreCourtCrowdBodies'], [heads, 'CentreCourtCrowdHeads']]) {
      im.name = name;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.receiveShadow = true;
      im.castShadow = false;
      im.customDepthMaterial = sharedDepthMaterial('instancedColor');
      im.boundingSphere = sphere;
      im.count = 0;
      im.visible = false;
      im.matrixAutoUpdate = false;
      this.root.add(im);
    }
    this.crowd = { bodies, heads, capacity: pool.length, count: 0, target: 0, frac: 0, acc: 0, cheerT: 0, cheerLift: 0, cheerOff: 0 };
  }

  /** Crowd impostors: ramp toward frac × capacity (instant: jump there). */
  setCrowd(frac, instant = false) {
    const cr = this.crowd;
    if (!cr) return;
    cr.frac = Math.max(0, Math.min(1, Number(frac) || 0));
    cr.target = Math.min(cr.capacity, Math.round(cr.frac * this._crowdCap()));
    if (instant) this._setCrowdCount(cr.target);
  }

  /** A short lift of every third crowd impostor (0..1); allocation-free. */
  cheer(strength) {
    const cr = this.crowd;
    if (!cr || cr.count === 0) return;
    if (cr.cheerT > 0) this._cheerApply(0);   // settle the last one first
    cr.cheerOff = (cr.cheerOff + 1) % 3;
    cr.cheerLift = 0.12 * Math.max(0, Math.min(1, Number(strength) || 0));
    cr.cheerT = CHEER_TIME;
  }

  _crowdCap() {
    return Quality.tier === 'low' ? this._crowdCapLow : this._crowdCapHigh;
  }

  _setCrowdCount(n) {
    const cr = this.crowd;
    n = Math.max(0, Math.min(cr.capacity, n | 0));
    if (n === cr.count) return;
    if (cr.cheerT > 0) this._cheerApply(0);
    cr.count = n;
    cr.bodies.count = n;
    cr.heads.count = n;
    cr.bodies.visible = cr.heads.visible = n > 0;
  }

  _cheerApply(lift) {
    const cr = this.crowd, arr = cr.bodies.instanceMatrix.array, base = this._crowdBaseY;
    for (let i = cr.cheerOff; i < cr.count; i += 3) arr[i * 16 + 13] = base[i] + lift;
    cr.bodies.instanceMatrix.needsUpdate = true;
    if (lift === 0) cr.cheerT = 0;
  }

  _updateCrowd(dt) {
    const cr = this.crowd;
    if (!cr) return;
    const cap = Math.min(cr.capacity, this._crowdCap());
    if (cr.target > cap) cr.target = cap;
    if (cr.count !== cr.target) {
      cr.acc += dt * CROWD_RATE;
      if (cr.acc >= 1) {
        const step = Math.floor(cr.acc);
        cr.acc -= step;
        this._setCrowdCount(cr.count < cr.target ? Math.min(cr.target, cr.count + step) : Math.max(cr.target, cr.count - step));
      }
    } else {
      cr.acc = 0;
    }
    if (cr.cheerT > 0) {
      cr.cheerT -= dt;
      if (cr.cheerT <= 0) this._cheerApply(0);
      else this._cheerApply(cr.cheerLift * Math.sin(Math.PI * (1 - cr.cheerT / CHEER_TIME)));
    }
  }

  _applyQuality(settings) {
    const cast = !!(settings && settings.shadows !== false && settings.shadowMapSize >= 2048);
    for (const im of this.seatMeshes || []) im.castShadow = cast;
    if (this.crowd) {
      this.crowd.bodies.castShadow = this.crowd.heads.castShadow = cast;
      this.crowd.target = Math.min(this.crowd.capacity, Math.round(this.crowd.frac * this._crowdCap()));
      if (this.crowd.count > this.crowd.target) this._setCrowdCount(this.crowd.target);
    }
  }

  // ───────────────────────────── rail, masts, arch, glass ─────────────────────────────

  _buildMetalAndGlass() {
    const L = this.layout, N = L.N, cx = L.cx, cz = L.cz;
    const metal = [], glass = [], haloPos = [];
    const P = (geometry, matrix, color) => metal.push({ geometry, matrix, color });
    const at = (si, d, a) => L.standToWorld(si, d, a, { x: 0, z: 0 });
    const cutOf = (si) => (si < 2 ? L.U[N] : L.V[N]);

    // Rim rail on d = cut + 0.25: top rail at 1.05, mid rail, posts ≤ 1.6 m apart, gold caps at the openings
    const rd = (L.rail.d0 + L.rail.d1) / 2, rh = L.rail.height;
    for (const run of L.railRuns) {
      const si = run.si, d = cutOf(si) + rd;
      const lim = (si < 2 ? L.V[N] : L.U[N]) + rd + 0.03;       // visual runs meet at the corner posts
      const a0 = Math.max(run.a0, -lim), a1 = Math.min(run.a1, lim), len = a1 - a0;
      if (len < 0.05) continue;
      const mid = at(si, d, (a0 + a1) / 2), ry = si < 2 ? 0 : Math.PI / 2;
      P(boxGeo(0.06, 0.06, len), makeMatrix(mid.x, rh - 0.03, mid.z, ry), C.rail);
      P(boxGeo(0.04, 0.04, len), makeMatrix(mid.x, 0.55, mid.z, ry), C.rail);
      const nPost = Math.max(1, Math.ceil(len / 1.6));
      for (let i = 0; i <= nPost; i++) {
        const q = at(si, d, a0 + (len * i) / nPost);
        P(boxGeo(0.05, rh, 0.05), makeMatrix(q.x, rh / 2, q.z), C.rail);
      }
      const isOpen = (a) => L.openings.some(o => o.si === si && (Math.abs(o.a0 - a) < 0.01 || Math.abs(o.a1 - a) < 0.01));
      for (const [a, open] of [[a0, isOpen(run.a0)], [a1, isOpen(run.a1)]]) {
        if (!open) continue;
        const q = at(si, d, a);
        P(boxGeo(0.09, 0.05, 0.09), makeMatrix(q.x, rh + 0.025, q.z), C.trim);
      }
    }
    // Bollard ring (brass band)
    for (const b of L.bollards) {
      const q = at(b.si, cutOf(b.si) + rd, b.a);
      P(boxGeo(b.size + 0.02, 0.05, b.size + 0.02), makeMatrix(q.x, 0.7, q.z), C.trim);
    }

    // Members' Box rail: brass, knee height, on the front edge of its first row
    const mb = L.config.membersBox;
    if (mb && typeof mb === 'object') {
      const si = { w: 0, e: 1, n: 2, s: 3 }[mb.side] ?? 0;
      const rows = Array.isArray(mb.rows) ? mb.rows : [2, 4];
      const k = Math.max(0, Math.min(N - 1, rows[0] | 0)), half = Number(mb.halfAlong) || 6.2;
      const front = si < 2 ? L.U : L.V, d = front[k] + 0.03, y = L.H[k];
      const pa = L.aisles.find(a => a.sideIndex === si && a.players);
      const inner = pa ? pa.half + 0.25 : 0.2;
      for (const sgn of [-1, 1]) {
        const a0 = sgn * inner, a1 = sgn * half, len = Math.abs(a1 - a0);
        const mid = at(si, d, (a0 + a1) / 2), ry = si < 2 ? 0 : Math.PI / 2;
        P(boxGeo(0.045, 0.045, len), makeMatrix(mid.x, y + 0.55, mid.z, ry), C.brass);
        const np = Math.max(1, Math.round(len / 1.6));
        for (let i = 0; i <= np; i++) {
          const q = at(si, d, a0 + ((a1 - a0) * i) / np);
          P(boxGeo(0.035, 0.53, 0.035), makeMatrix(q.x, y + 0.265, q.z), C.brass);
        }
      }
    }

    // Players' Walk handrails: slanted rails at the aisle edges from the lip down to the foot
    for (const a of L.aisles) {
      if (!a.players) continue;
      const si = a.sideIndex, front = si < 2 ? L.U : L.V, cutD = front[N];
      const dTop = cutD - 0.3, dFoot = front[0] - 0.45;
      const ya = HANDRAIL_H, yb = L.surfY + HANDRAIL_H;
      for (const off of [-(a.half - 0.05), a.half - 0.05]) {
        const p0 = at(si, dTop, a.at + off), p1 = at(si, dFoot, a.at + off);
        const A = new THREE.Vector3(p0.x, ya, p0.z), B = new THREE.Vector3(p1.x, yb, p1.z);
        metal.push({ geometry: boxGeo(1, 1, 1), matrix: segMatrix(A, B, 0.05, 0.05), color: C.brass });
        const steps = 6;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps, d = dTop + (dFoot - dTop) * t, q = at(si, d, a.at + off);
          const g = L.groundAt(q.x, q.z), top = ya + (yb - ya) * t;
          if (top - g < 0.2) continue;
          P(boxGeo(0.04, top - g, 0.04), makeMatrix(q.x, (top + g) / 2, q.z), C.rail);
        }
      }
    }

    // Floodlight masts: tapered column, collar, head frame yawed at the court and tilted 35° down
    for (const m of L.masts) {
      const h = m.height;
      P(cylinderGeo(0.16, 0.3, h - 0.4, 10), makeMatrix(m.x, 0.4 + (h - 0.4) / 2, m.z), C.mast);
      P(cylinderGeo(0.34, 0.34, 0.2, 10), makeMatrix(m.x, 0.5, m.z), C.mast);
      P(cylinderGeo(0.22, 0.22, 0.15, 10), makeMatrix(m.x, h * 0.62, m.z), C.mast);
      const yaw = Math.atan2(cx - m.x, cz - m.z);
      const head = new THREE.Matrix4().makeTranslation(m.x, h + 0.55, m.z)
        .multiply(_m4.makeRotationY(yaw)).multiply(_m4b.makeRotationX(35 * Math.PI / 180));
      const local = (x, y, z, sx = 1, sy = 1, sz = 1) => head.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, z)).multiply(new THREE.Matrix4().makeScale(sx, sy, sz));
      metal.push({ geometry: boxGeo(3.2, 1.6, 0.3), matrix: local(0, 0, 0), color: C.lampHead });
      metal.push({ geometry: boxGeo(3.36, 0.08, 0.36), matrix: local(0, 0.84, 0), color: C.mast });
      metal.push({ geometry: boxGeo(0.4, 0.5, 0.4), matrix: new THREE.Matrix4().makeTranslation(m.x, h + 0.05, m.z), color: C.mast });
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          glass.push({ geometry: boxGeo(0.7, 0.6, 0.04), matrix: local(-1.125 + c * 0.75, 0.36 - r * 0.72, 0.16) });
        }
      }
      for (const hx of [-0.8, 0.8]) {
        _v3.set(hx, 0, 0.6).applyMatrix4(head);
        haloPos.push(_v3.x, _v3.y, _v3.z);
      }
    }

    // Arch over the Players' Walk: beam, sign backing board, a lantern on each pier
    if (L.arch) {
      const a = L.aisles.find(q => q.id === L.arch.aisleId) || L.aisles[0];
      const si = a.sideIndex, d = cutOf(si) + L.arch.d, c0 = at(si, d, a.at), ry = si < 2 ? 0 : Math.PI / 2;
      P(boxGeo(0.4, 0.3, 3.7), makeMatrix(c0.x, 3.1, c0.z, ry), C.rail);
      P(boxGeo(0.44, 0.04, 3.74), makeMatrix(c0.x, 3.27, c0.z, ry), C.trim);
      P(boxGeo(0.08, 0.9, 3.34), makeMatrix(c0.x, SIGN_Y, c0.z, ry), C.board);
      P(boxGeo(0.1, 0.04, 3.38), makeMatrix(c0.x, SIGN_Y + 0.47, c0.z, ry), C.trim);
      for (const p of L.arch.piers) {
        // outward face (toward the club): d grows away from the court
        const out = at(si, d + 0.34, p === L.arch.piers[0] ? a.at + L.arch.pierAlong : a.at - L.arch.pierAlong);
        P(boxGeo(0.06, 0.05, 0.06), makeMatrix((out.x + p.x) / 2, 2.55, (out.z + p.z) / 2), C.rail);
        P(boxGeo(0.22, 0.05, 0.22), makeMatrix(out.x, 2.64, out.z), C.rail);
        P(boxGeo(0.26, 0.04, 0.26), makeMatrix(out.x, 2.26, out.z), C.rail);
        glass.push({ geometry: boxGeo(0.18, 0.34, 0.18), matrix: makeMatrix(out.x, 2.45, out.z) });
      }
    }

    // Scoreboards: housing, gold top trim, legs (the face is its own canvas mesh)
    for (const b of L.scoreboards) {
      const ry = b.yaw, y0 = b.bottom, y1 = b.bottom + b.h;
      P(boxGeo(b.w, b.h, 0.5), makeMatrix(b.x, (y0 + y1) / 2, b.z, ry), C.board);
      P(boxGeo(b.w + 0.12, 0.1, 0.56), makeMatrix(b.x, y1 + 0.05, b.z, ry), C.trim);
      P(boxGeo(b.w + 0.12, 0.08, 0.56), makeMatrix(b.x, y0 - 0.02, b.z, ry), C.mast);
      for (const sx of [-2.6, 2.6]) P(boxGeo(0.35, y0, 0.35), makeMatrix(b.x + sx, y0 / 2, b.z), C.mast);
    }

    this._addMesh('CentreCourtMetal', mergeParts(metal), Mat.metal(), true, true);
    this._addMesh('CentreCourtGlass', mergeParts(glass), courtLampGlassMaterial(), false, false);

    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(haloPos, 3));
    const halos = new THREE.Points(hg, courtHaloMaterial());
    halos.name = 'centreCourtHalos';
    halos.userData.noMerge = true;
    halos.userData.noAO = true;
    halos.matrixAutoUpdate = false;
    this.root.add(halos);
    registerCourtHalos(halos);
    this.halos = halos;
  }

  // ───────────────────────────── scoreboards ─────────────────────────────

  _buildScoreboards() {
    const L = this.layout;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const material = getMaterial(`stadium-scoreFace|${L.id}`, () => {
      const m = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, roughness: 0.6 });
      registerNightGlow(m, 0.55, 0.12);
      return m;
    });
    const parts = [];
    for (const b of L.scoreboards) {
      // the face 0.02 proud of the housing's court side (the board's yaw faces the court)
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
      parts.push({ geometry: new THREE.PlaneGeometry(b.w - 0.6, b.h - 0.5), matrix: makeMatrix(b.x + fx * 0.27, b.bottom + b.h / 2, b.z + fz * 0.27, b.yaw) });
    }
    const mesh = this._addMesh('CentreCourtScoreFaces', mergeParts(parts), material, false, false);
    mesh.userData.noAO = true;
    this._sb = { canvas, ctx: canvas.getContext('2d'), tex, mesh };
    this._sbT = 0;
    this._sbMatch = undefined;
    this._sbKey = -1;
    this._sbStart = -2;
    this._sbP0 = null;
    this._sbP1 = null;
    this._sbNext = { start: 0, players: [null, null] };
    // setScoreOverride state: the values last drawn
    this._ov = { on: false, n0: '', n1: '', g0: 0, g1: 0, p0: '', p1: '', s0: 0, s1: 0, server: 0 };
    this._drawIdle(null);
  }

  /** Allocation-free poll: redraw only when a number (score, next booking) changes. */
  _pollScoreboard() {
    if (this._ov.on) return;   // setScoreOverride owns the faces
    const ms = this.matches, id = this.layout.id;
    let m = null;
    if (ms) {
      if (typeof ms.getMatch === 'function') m = ms.getMatch(id);
      else if (Array.isArray(ms.matches)) {
        for (let i = 0; i < ms.matches.length; i++) {
          const x = ms.matches[i];
          if (x && x.frame && x.frame.id === id) { m = x; break; }
        }
      }
    }
    if (m && m.score && m.players && m.players.length >= 2) {
      const sc = m.score;
      const key = 1 + (sc.games[0] | 0) * 100000 + (sc.games[1] | 0) * 1000 + (sc.pts[0] | 0) * 100 + (sc.pts[1] | 0) * 10 + (sc.server | 0);
      if (m !== this._sbMatch || key !== this._sbKey) {
        this._sbMatch = m;
        this._sbKey = key;
        this._drawMatch(m);
      }
      return;
    }
    const next = this._nextEntry(ms, id);
    const start = next ? next.start : -1, p0 = next ? next.players[0] : null, p1 = next ? next.players[1] : null;
    if (this._sbMatch !== null || start !== this._sbStart || p0 !== this._sbP0 || p1 !== this._sbP1) {
      this._sbMatch = null;
      this._sbKey = -1;
      this._sbStart = start;
      this._sbP0 = p0;
      this._sbP1 = p1;
      this._drawIdle(next);
    }
  }

  /** The next booking on this court ({ start, players }) or null (MatchSystem.nextEntryFor when present). */
  _nextEntry(ms, id) {
    if (!ms) return null;
    const out = this._sbNext;
    if (typeof ms.nextEntryFor === 'function') return ms.nextEntryFor(id, out);
    const E = ms.entries, tod = ms.weather ? ms.weather.timeOfDay : 0, started = ms._started;
    if (!Array.isArray(E)) return null;
    let best = null;
    for (let i = 0; i < E.length; i++) {
      const e = E[i];
      if (!e || !e.courts || e.courts[0] !== id || (started && started.has(i)) || !(e.end > tod)) continue;
      if (!best || e.start < best.start) best = e;
    }
    if (!best) return null;
    out.start = best.start;
    out.players[0] = best.players ? best.players[0] : null;
    out.players[1] = best.players ? best.players[1] : null;
    return out;
  }

  _npcName(ms, idOrNpc) {
    const npc = typeof idOrNpc === 'string' ? (ms && ms._npcById && ms._npcById.get(idOrNpc)) : idOrNpc;
    const name = npc && npc.name ? String(npc.name) : '';
    if (!name) return typeof idOrNpc === 'string' && idOrNpc !== 'any' ? idOrNpc.toUpperCase() : 'TBA';
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) return name.toUpperCase();
    return `${parts[0][0]}. ${parts[parts.length - 1]}`.toUpperCase();
  }

  _drawFrame(ctx) {
    ctx.fillStyle = '#10281b';
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = 'rgba(217,164,65,0.55)';
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, 496, 240);
    ctx.fillStyle = '#d9a441';
    ctx.font = '600 30px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    try { ctx.letterSpacing = '4px'; } catch (e) { /* older canvas */ }
    ctx.fillText('CENTRE COURT', 256, 48);
    try { ctx.letterSpacing = '0px'; } catch (e) { /* noop */ }
    ctx.fillStyle = 'rgba(217,164,65,0.4)';
    ctx.fillRect(40, 62, 432, 2);
  }

  _drawMatch(m) {
    const { ctx, tex } = this._sb, ms = this.matches, sc = m.score;
    this._drawFrame(ctx);
    const a = sc.pts[0] | 0, b = sc.pts[1] | 0;
    const ptsOf = (me, other) => {
      if (m.noAd || me < 3 || other < 3) return PTS[Math.min(3, me)];
      return me > other ? PTS[4] : PTS[3];
    };
    ctx.font = '600 16px sans-serif';
    ctx.fillStyle = 'rgba(244,232,193,0.55)';
    ctx.textAlign = 'right';
    ctx.fillText('GAMES', 390, 90);
    ctx.fillText('PTS', 482, 90);
    for (let i = 0; i < 2; i++) {
      const y = 140 + i * 66;
      ctx.textAlign = 'left';
      ctx.font = '600 34px sans-serif';
      ctx.fillStyle = '#f4e8c1';
      ctx.fillText(this._npcName(ms, m.players[i].npc).slice(0, 13), 52, y);
      if ((sc.server | 0) === i) {
        ctx.fillStyle = '#d8e04e';
        ctx.beginPath();
        ctx.arc(32, y - 11, 8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffe39a';
      ctx.fillText(String(sc.games[i] | 0), 390, y);
      ctx.fillStyle = '#f4e8c1';
      ctx.fillText(i === 0 ? ptsOf(a, b) : ptsOf(b, a), 482, y);
    }
    tex.needsUpdate = true;
  }

  /** The setScoreOverride score: the match layout, plus a SETS column once a set is won. */
  _drawOverride() {
    const { ctx, tex } = this._sb, ov = this._ov;
    const sets = ov.s0 + ov.s1 > 0;
    const xg = sets ? 400 : 390, xs = 312, nameW = (sets ? xs - 44 : xg - 58) - 52;
    this._drawFrame(ctx);
    ctx.font = '600 16px sans-serif';
    ctx.fillStyle = 'rgba(244,232,193,0.55)';
    ctx.textAlign = 'right';
    if (sets) ctx.fillText('SETS', xs, 90);
    ctx.fillText('GAMES', xg, 90);
    ctx.fillText('PTS', 482, 90);
    for (let i = 0; i < 2; i++) {
      const y = 140 + i * 66;
      ctx.textAlign = 'left';
      ctx.font = '600 34px sans-serif';
      ctx.fillStyle = '#f4e8c1';
      ctx.fillText(String((i === 0 ? ov.n0 : ov.n1) ?? '').toUpperCase(), 52, y, nameW);
      if (ov.server === i) {
        ctx.fillStyle = '#d8e04e';
        ctx.beginPath();
        ctx.arc(32, y - 11, 8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.textAlign = 'right';
      if (sets) {
        ctx.fillStyle = 'rgba(244,232,193,0.8)';
        ctx.fillText(String(i === 0 ? ov.s0 : ov.s1), xs, y);
      }
      ctx.fillStyle = '#ffe39a';
      ctx.fillText(String(i === 0 ? ov.g0 : ov.g1), xg, y);
      ctx.fillStyle = '#f4e8c1';
      ctx.fillText(String((i === 0 ? ov.p0 : ov.p1) ?? ''), 482, y, 76);
    }
    tex.needsUpdate = true;
  }

  _drawIdle(next) {
    const { ctx, tex } = this._sb, ms = this.matches;
    this._drawFrame(ctx);
    ctx.textAlign = 'center';
    if (next && next.start >= 0) {
      const h = Math.floor(next.start), mm = Math.round((next.start - h) * 60);
      ctx.fillStyle = 'rgba(244,232,193,0.7)';
      ctx.font = '600 26px sans-serif';
      ctx.fillText(`NEXT  ${h}:${String(mm).padStart(2, '0')}`, 256, 124);
      ctx.fillStyle = '#f4e8c1';
      ctx.font = '600 32px sans-serif';
      ctx.fillText(`${this._npcName(ms, next.players[0])} v ${this._npcName(ms, next.players[1])}`, 256, 182, 460);
    } else {
      ctx.fillStyle = '#f4e8c1';
      ctx.font = '600 34px Georgia, serif';
      ctx.fillText('GREENBRIAR', 256, 142);
      ctx.fillStyle = 'rgba(244,232,193,0.7)';
      ctx.font = '600 22px sans-serif';
      ctx.fillText('TENNIS & SOCIAL CLUB · EST. 1962', 256, 190);
    }
    tex.needsUpdate = true;
  }

  // ───────────────────────────── arch sign ─────────────────────────────

  _buildSign() {
    const L = this.layout;
    if (!L.arch) return;
    const a = L.aisles.find(q => q.id === L.arch.aisleId) || L.aisles[0];
    const si = a.sideIndex, d = (si < 2 ? L.U[L.N] : L.V[L.N]) + L.arch.d;
    const c = L.standToWorld(si, d, a.at, { x: 0, z: 0 });
    const [u0, v0, u1, v1] = regionUV(ATLAS.centreCourt);
    const face = atlasPlane('centreCourt', 3.2, 0.8, u0, v0, u1, v1);
    // the board faces along the stand's depth: outward (toward the club) and inward (the pit)
    const outYaw = [-Math.PI / 2, Math.PI / 2, 0, Math.PI][si];
    const ox = Math.sin(outYaw), oz = Math.cos(outYaw);
    const parts = [
      { geometry: face, matrix: makeMatrix(c.x + ox * 0.045, SIGN_Y, c.z + oz * 0.045, outYaw) },
      { geometry: face, matrix: makeMatrix(c.x - ox * 0.045, SIGN_Y, c.z - oz * 0.045, outYaw + Math.PI) },
    ];
    this._addMesh('CentreCourtSign', mergeParts(parts), Mat.signs(), false, true);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  _addMesh(name, geo, material, cast, receive) {
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.castShadow = cast;
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    m.userData.noMerge = true;
    this.root.add(m);
    return m;
  }
}
