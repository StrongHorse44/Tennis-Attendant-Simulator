import * as THREE from 'three';
import { OCC_UNIFORMS, isOcclusionFaded, resetOcclusionFade } from '../graphics/OcclusionFade.js';

/**
 * TennisOcclusion — keeps the after-hours tennis view clear: everything standing between the
 * broadcast camera and the play is made see-through, and put back exactly as it was when the
 * session ends.
 *
 *   const occ = new TennisOcclusion(game);
 *   occ.begin(session);            // TennisSession.begin(), once the court / sides are set
 *   occ.update(session, dt);       // every _tick, AFTER this.cam.update(this, dt)
 *   occ.end();                     // TennisSession.end() (idempotent)
 *
 * What it does
 *  - Court meshes (every court's matte / metal / chain-link / windscreen / sign / lamp-glass
 *    material is patched at creation by withOcclusionFade, see graphics/OcclusionFade.js): the
 *    shared uniforms describe the half-space behind the baseline at the camera's end, limited
 *    across the court, above the curbs, plus camera→player-chest and camera→ball segments that
 *    stop short of their focus. That covers Court 1's near floodlight poles / arms / heads,
 *    fence posts, rails, windscreen, chain-link and sign board, and — after a change of ends,
 *    with the camera over clay courts 3/4 — their south fence, poles and heads. The strength
 *    ramps in over RAMP s; each end has its own strength and follows the camera (it swaps as
 *    the camera glides over the net on a change of ends).
 *  - Explicit hides, restored in end():
 *      club projects (the funded Court 1 scoreboard) inside the fade region → group hidden;
 *      near trees (instanced) inside the region whose canopy enters the view → instance
 *        collapsed (sticky while that end is faded, so its shadow does not flicker);
 *      floodlight night halos (THREE.Points, their .visible is reset every frame by Court)
 *        of lamps inside the region → excluded with geometry.setDrawRange.
 *  - GTAO (high tier): faded court meshes are flagged userData.noAO for the session (PostFX's
 *    AO visibility pass already skips those), so no dark AO ghost is left where they were.
 *  - Court 1's court-* meshes hidden by the old TennisSession._setFences(false) are shown again
 *    (the fade replaces that hide; the far fence stays visible as a backdrop).
 *
 * No per-frame allocations; no new shader programs at begin (uniform writes only).
 */

const HALF_L = 12.3;            // baseline, court-local v (TennisBallSim.HALF_L)
const NEAR_V = HALF_L + 0.5;    // the fade ramps in over 0.5 m from here: full from 13.3 (lamp heads
                                // overhang to ~13.35, the fence is at 14.5)
const U_MAX = 10.2;             // across-court limit: Court 1's fence ends at |u| 9, Court 2's starts at 11
const U_FEATHER = 0.6;
const MIN_Y = 0.28;             // curbs, base plates, stray balls and the surface stay solid
const KEEP = 0.8;               // fraction of pixels removed at full fade (3/16 remain as a ghost)
const RAMP = 0.4;               // s, fade in at begin / swap ends
const NET_GUARD = 1.2;          // the segments never reach within this of the net (v)
const CHEST_Y = 1.05, CHEST_R = 1.1;
const BALL_R = 0.5;
const TREE_V_MAX = NEAR_V + 24; // candidate trees: behind a baseline, up to here...
const TREE_U_MAX = 18;          // ...and this far across
const HIDE_AT = 0.5;            // explicit hides switch at this effective fade

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();

export class TennisOcclusion {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.frame = null;
    this.k = 0;                 // master ramp 0..1
    this.ends = [0, 0];         // current strength of the +v / -v end fade
    this.target = [0, 0];
    this.camSign = 1;
    // explicit hides (filled in begin, static geometry)
    this._trees = [];           // { im, i, orig: Float32Array(16), x, y, z, r, end, hidden }
    this._projects = [];        // { p, vMin, vMax, uAbs, yMax, hidden }
    this._halos = [];           // { pts: THREE.Points, pos: Float32Array, n, range }
    this._noAO = [];            // { mesh, prev }
    this._dirty = [];           // InstancedMeshes touched this frame (reused)
  }

  // ─────────────────────────── lifecycle ───────────────────────────

  /** Start fading for a session (reads session.frame, session.sides, session.game). */
  begin(session) {
    if (this.active) this.end();
    if (!session || !session.frame) return false;
    this.active = true;
    this.frame = session.frame;
    this.k = 0;
    const side = session.sides && session.sides[0] < 0 ? -1 : 1;
    this.camSign = side;
    this.target[0] = this.ends[0] = side > 0 ? 1 : 0;
    this.target[1] = this.ends[1] = side > 0 ? 0 : 1;
    const f = this.frame, U = OCC_UNIFORMS;
    U.uOccFrame.value.set(f.cx, f.cz, f.c, f.s);
    U.uOccZone.value.set(NEAR_V, U_MAX, U_FEATHER, MIN_Y);
    U.uOccEnds.value.set(this.ends[0], this.ends[1], NET_GUARD, side);
    U.uOccA.value.w = 0;
    U.uOccB.value.w = 0;
    U.uOccK.value = 0;
    try { this._collect(); } catch (e) { console.warn('TennisOcclusion: setup skipped', e); }
    return true;
  }

  /** Per tick, after the tennis camera has moved. No allocations. */
  update(session, dt) {
    if (!this.active || !session) return;
    const f = session.frame || this.frame;
    if (!f) return;
    this.frame = f;
    const g = this.game, U = OCC_UNIFORMS;
    const cam = (session.game && session.game.camera) || g.camera;

    // Which end is the camera behind? (hysteresis over the net while it glides round)
    let camV = 0;
    if (cam) camV = f.lv(cam.position.x, cam.position.z);
    else camV = (session.sides && session.sides[0] < 0 ? -1 : 1) * (HALF_L + 8);
    if (camV > 1) { this.target[0] = 1; this.target[1] = 0; this.camSign = 1; }
    else if (camV < -1) { this.target[0] = 0; this.target[1] = 1; this.camSign = -1; }

    const step = dt > 0 ? dt / RAMP : 0;
    this.k = Math.min(1, this.k + step);
    for (let e = 0; e < 2; e++) {
      const d = this.target[e] - this.ends[e];
      this.ends[e] += Math.abs(d) <= step ? d : Math.sign(d) * step;
    }
    const kk = smooth(0, 1, this.k);
    U.uOccK.value = KEEP * kk;
    U.uOccFrame.value.set(f.cx, f.cz, f.c, f.s);
    U.uOccEnds.value.set(smooth(0, 1, this.ends[0]), smooth(0, 1, this.ends[1]), NET_GUARD, this.camSign);

    // Segments: camera → player's chest, camera → ball (stop short of the focus, see the shader)
    const pm = session.game && session.game.player && session.game.player.mesh;
    if (pm) U.uOccA.value.set(pm.position.x, pm.position.y + CHEST_Y, pm.position.z, CHEST_R);
    else U.uOccA.value.w = 0;
    const b = session.ball;
    if (b && b.active && b.shown && b.pos) U.uOccB.value.set(b.pos.x, b.pos.y, b.pos.z, BALL_R);
    else U.uOccB.value.w = 0;

    try { this._updateHides(cam, kk); } catch (e) { /* cosmetic */ }
  }

  /** Stop: the fade off, every hide restored. Idempotent; the normal game renders as before. */
  end() {
    resetOcclusionFade();
    if (!this.active) return;
    this.active = false;
    this.k = 0;
    this.ends[0] = this.ends[1] = 0;
    try {
      for (const t of this._trees) if (t.hidden) this._setTree(t, false);
      for (const im of this._dirty) im.instanceMatrix.needsUpdate = true;
      this._dirty.length = 0;
      for (const pr of this._projects) {
        if (pr.hidden) { pr.hidden = false; pr.p.group.visible = !!pr.p.shown; }
      }
      for (const h of this._halos) { h.pts.geometry.setDrawRange(0, Infinity); h.range = -1; }
      for (const a of this._noAO) {
        if (a.prev === undefined) delete a.mesh.userData.noAO; else a.mesh.userData.noAO = a.prev;
      }
    } catch (e) { console.warn('TennisOcclusion: restore failed', e); }
    this._trees.length = 0;
    this._projects.length = 0;
    this._halos.length = 0;
    this._noAO.length = 0;
  }

  // ─────────────────────────── region ───────────────────────────

  /** Effective fade (0..1) of the half-space term at a world point, before the master ramp. */
  fadeAt(x, y, z) {
    const f = this.frame;
    if (!f) return 0;
    const dx = x - f.cx, dz = z - f.cz;
    const u = dx * f.c - dz * f.s, v = dx * f.s + dz * f.c;
    const across = 1 - smooth(U_MAX, U_MAX + U_FEATHER, Math.abs(u));
    const e = Math.max(smooth(0, 1, this.ends[0]) * smooth(NEAR_V, NEAR_V + 0.5, v),
      smooth(0, 1, this.ends[1]) * smooth(NEAR_V, NEAR_V + 0.5, -v));
    return e * across * smooth(MIN_Y, MIN_Y + 0.2, y);
  }

  _uv(x, z, out) {
    const f = this.frame, dx = x - f.cx, dz = z - f.cz;
    out.x = dx * f.c - dz * f.s;
    out.y = dx * f.s + dz * f.c;
    return out;
  }

  // ─────────────────────────── setup ───────────────────────────

  _collect() {
    const g = this.game;
    const uv = new THREE.Vector2();
    const courts = (g.world && g.world.courts) || [];

    // Court meshes: re-show what the old _setFences hid; flag faded meshes noAO (GTAO ghosts)
    const own = this.frame.court && this.frame.court.mesh;
    for (const court of courts) {
      const root = court && court.mesh;
      if (!root) continue;
      root.updateMatrixWorld(true);
      for (const ch of root.children) {
        if (!ch.isMesh || !isOcclusionFaded(ch.material)) continue;
        if (root === own && !ch.visible) ch.visible = true;
        if (!ch.geometry.boundingBox) ch.geometry.computeBoundingBox();
        _box.copy(ch.geometry.boundingBox).applyMatrix4(ch.matrixWorld);
        if (this._boxInRegion(_box, uv, true)) {
          this._noAO.push({ mesh: ch, prev: ch.userData.noAO });
          ch.userData.noAO = true;
        }
      }
      // Floodlight halos (4 points: -v end pair, +v end pair)
      for (const ch of root.children) {
        if (!ch.isPoints || ch.name !== 'courtLampHalos') continue;
        const pa = ch.geometry.attributes.position;
        if (!pa) continue;
        const pos = new Float32Array(pa.count * 3);
        for (let i = 0; i < pa.count; i++) {
          _v.fromBufferAttribute(pa, i).applyMatrix4(ch.matrixWorld);
          pos[i * 3] = _v.x; pos[i * 3 + 1] = _v.y; pos[i * 3 + 2] = _v.z;
        }
        this._halos.push({ pts: ch, pos, n: pa.count, range: -1 });
      }
    }

    // Club projects (the Court 1 scoreboard sits right behind the south fence)
    const up = g.clubUpgrades && g.clubUpgrades.projects;
    if (up && typeof up.values === 'function') {
      for (const p of up.values()) {
        if (!p || !p.group) continue;
        p.group.updateMatrixWorld(true);
        _box.makeEmpty().expandByObject(p.group);
        if (_box.isEmpty() || !this._boxInRegion(_box, uv, true)) continue;
        const r = this._boxUV(_box, uv);
        this._projects.push({ p, vMin: r.vMin, vMax: r.vMax, uAbs: r.uAbs, yMax: _box.max.y, hidden: false });
      }
    }

    // Near trees (instanced buckets, full-detail LOD only)
    const sc = g.world && g.world.scenery;
    const meshes = sc && sc.meshes;
    if (meshes) {
      for (const key of Object.keys(meshes)) {
        if (!key.startsWith('tree:') || key.split('|')[1] !== '0') continue;
        const group = meshes[key];
        if (!group) continue;
        group.updateMatrixWorld(true);
        group.traverse((im) => {
          if (!im.isInstancedMesh) return;
          const geo = im.geometry;
          if (!geo.boundingSphere) geo.computeBoundingSphere();
          const bs = geo.boundingSphere;
          const arr = im.instanceMatrix.array;
          for (let i = 0; i < im.count; i++) {
            _m4.fromArray(arr, i * 16).premultiply(im.matrixWorld);
            _v.copy(bs.center).applyMatrix4(_m4);
            const s = _m4.getMaxScaleOnAxis();
            this._uv(_v.x, _v.z, uv);
            const av = Math.abs(uv.y);
            if (av < NEAR_V - 2 || av > TREE_V_MAX || Math.abs(uv.x) > TREE_U_MAX) continue;
            this._trees.push({
              im, i, orig: arr.slice(i * 16, i * 16 + 16),
              x: _v.x, y: _v.y, z: _v.z, r: bs.radius * s, end: uv.y > 0 ? 0 : 1, hidden: false,
            });
          }
        });
      }
    }
  }

  /** u / v extent of a world box in the court frame. */
  _boxUV(box, uv) {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < 4; i++) {
      this._uv(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.z : box.min.z, uv);
      uMin = Math.min(uMin, uv.x); uMax = Math.max(uMax, uv.x);
      vMin = Math.min(vMin, uv.y); vMax = Math.max(vMax, uv.y);
    }
    const uAbs = uMin <= 0 && uMax >= 0 ? 0 : Math.min(Math.abs(uMin), Math.abs(uMax));
    return { uMin, uMax, vMin, vMax, uAbs };
  }

  /** Does a world box reach into the fade region of either end (setup only)? */
  _boxInRegion(box, uv, eitherEnd) {
    const r = this._boxUV(box, uv);
    if (r.uAbs >= U_MAX + U_FEATHER || box.max.y <= MIN_Y) return false;
    return eitherEnd ? (r.vMax > NEAR_V || r.vMin < -NEAR_V) : false;
  }

  // ─────────────────────────── per frame ───────────────────────────

  _updateHides(cam, kk) {
    const e0 = smooth(0, 1, this.ends[0]) * kk, e1 = smooth(0, 1, this.ends[1]) * kk;

    // Club projects: hidden while their end is faded and they reach into the region
    for (let i = 0; i < this._projects.length; i++) {
      const pr = this._projects[i], p = pr.p;
      const inPos = pr.vMax > NEAR_V && e0 > HIDE_AT;
      const inNeg = pr.vMin < -NEAR_V && e1 > HIDE_AT;
      const hide = !!p.shown && pr.uAbs < U_MAX + U_FEATHER && pr.yMax > MIN_Y && (inPos || inNeg);
      if (hide !== pr.hidden) {
        pr.hidden = hide;
        p.group.visible = hide ? false : !!p.shown;
      }
    }

    // Halos: drop the pairs of lamps inside the region (points 0-1 = -v end, 2-3 = +v end)
    for (let i = 0; i < this._halos.length; i++) {
      const h = this._halos[i], P = h.pos;
      let range;
      if (h.n === 4) {
        const a = this.fadeAt(P[0], P[1], P[2]) * kk > HIDE_AT || this.fadeAt(P[3], P[4], P[5]) * kk > HIDE_AT;
        const b = this.fadeAt(P[6], P[7], P[8]) * kk > HIDE_AT || this.fadeAt(P[9], P[10], P[11]) * kk > HIDE_AT;
        range = a && b ? 3 : a ? 1 : b ? 2 : 0;
      } else {
        range = 0;
        for (let j = 0; j < h.n; j++) if (this.fadeAt(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]) * kk > HIDE_AT) { range = 3; break; }
      }
      if (range !== h.range) {
        h.range = range;
        const geo = h.pts.geometry;
        if (range === 0) geo.setDrawRange(0, Infinity);
        else if (range === 1) geo.setDrawRange(2, 2);
        else if (range === 2) geo.setDrawRange(0, 2);
        else geo.setDrawRange(0, 0);
      }
    }

    // Trees: collapse an instance whose canopy enters the view from inside the region
    if (this._trees.length && cam) {
      cam.updateMatrixWorld();
      _m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_m4);
      for (let i = 0; i < this._trees.length; i++) {
        const t = this._trees[i];
        const on = (t.end === 0 ? e0 : e1) > HIDE_AT;
        let hide = false;
        if (on) {
          if (t.hidden) hide = true; // sticky while this end is faded
          else {
            _sphere.center.set(t.x, t.y, t.z);
            _sphere.radius = t.r;
            hide = _frustum.intersectsSphere(_sphere);
          }
        }
        if (hide !== t.hidden) this._setTree(t, hide);
      }
    }
    for (let i = 0; i < this._dirty.length; i++) this._dirty[i].instanceMatrix.needsUpdate = true;
    this._dirty.length = 0;
  }

  _setTree(t, hide) {
    t.hidden = hide;
    const arr = t.im.instanceMatrix.array, o = t.i * 16;
    for (let j = 0; j < 16; j++) arr[o + j] = t.orig[j];
    // Collapse in place (basis scaled to ~0, translation kept): no fragments, no shadow, no NaNs
    if (hide) for (let j = 0; j < 11; j++) if (j !== 3 && j !== 7) arr[o + j] *= 1e-5;
    if (this._dirty.indexOf(t.im) < 0) this._dirty.push(t.im);
  }
}
