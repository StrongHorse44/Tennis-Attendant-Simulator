import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES } from '../utils/Constants.js';
import { Mat } from './Building.js';
import { createCanvasTexture } from '../graphics/Textures.js';
import { registerNightGlow } from '../graphics/Materials.js';
import { CameraTracker } from '../entities/CharacterModel.js';
import {
  getGeometry, roundedBox, boxGeo, cylinderGeo, sphereGeo, coneGeo, mergeParts, makeMatrix,
} from '../graphics/GeometryUtils.js';

/**
 * ClubUpgrades — the visible side of the shop's club projects (shop.json → projects).
 *
 * Every project is a small group built once at load (hidden, so _precompileShaders covers it)
 * and shown when it is funded: ClubUpgrades.setFunded(id, true). Each is one or two merged,
 * vertex-coloured meshes sharing the buildings' prop / metal / lamp-glass materials, so all six
 * together add about 10 draw calls. Walls, posts and planters get static physics boxes only while
 * shown. Positions derive from map.json (fountain, clubhouse, entrance, courts, patio).
 *
 *   project_koi        koi + lily pads circling the garden fountain basin (animated)
 *   project_trophy     championship cup on top of the lounge trophy case
 *   project_flowers    raised brick planters by the entrance walk
 *   project_scoreboard double-sided scoreboard behind Court 1 (live score from MatchSystem)
 *   project_patio      two mushroom patio heaters + lanterns under the colonnade (glow at dusk)
 *   project_wall       practice hitting wall with its own hard pad behind Court 2
 */

const P = (geometry, matrix, color) => ({ geometry, matrix, color });
const M = makeMatrix;

/** Sun-bleached brick for planters (vertex colour; small props may be flat). */
const BRICK = 0xa4553a;
const BRICK_CAP = 0xcfc3a8;
const FLOWER_COLS = [0xe84a6f, 0xf4d03f, 0xf4f1e8, 0x9b59b6, 0xe8732c];

export class ClubUpgrades {
  /**
   * @param {THREE.Scene} scene
   * @param {{ physicsWorld: CANNON.World, mapData: object, matches?: object }} opts
   */
  constructor(scene, { physicsWorld, mapData, matches = null }) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.map = mapData;
    this.matches = matches;
    this.root = new THREE.Group();
    this.root.name = 'ClubUpgrades';
    scene.add(this.root);
    /** id → { group, bodies, update?, shown } */
    this.projects = new Map();
    this._t = 0;
    this._scoreTimer = 0;

    const builders = {
      project_koi: () => this._buildKoi(),
      project_trophy: () => this._buildTrophy(),
      project_flowers: () => this._buildFlowers(),
      project_scoreboard: () => this._buildScoreboard(),
      project_patio: () => this._buildPatio(),
      project_wall: () => this._buildWall(),
    };
    for (const [id, build] of Object.entries(builders)) {
      try {
        const p = build();
        if (!p) continue;
        p.group.name = id;
        p.group.visible = false;
        p.shown = false;
        this.root.add(p.group);
        this.projects.set(id, p);
      } catch (err) {
        console.warn(`Club upgrade "${id}" could not be built:`, err);
      }
    }
  }

  static get IDS() { return ['project_koi', 'project_trophy', 'project_flowers', 'project_scoreboard', 'project_patio', 'project_wall']; }

  has(id) { return this.projects.has(id); }

  isShown(id) { const p = this.projects.get(id); return !!(p && p.shown); }

  /** Show / hide a funded project (and add / remove its physics). */
  setFunded(id, on) {
    const p = this.projects.get(id);
    if (!p || p.shown === !!on) return;
    p.shown = !!on;
    p.group.visible = p.shown;
    for (const b of p.bodies || []) {
      if (p.shown) this.physicsWorld.addBody(b);
      else this.physicsWorld.removeBody(b);
    }
    if (p.shown && p.onShow) p.onShow();
  }

  /** World point to show the player where a project went (for toasts / camera), or null. */
  getSpot(id) {
    const p = this.projects.get(id);
    return p ? p.spot : null;
  }

  update(dt) {
    this._t += dt;
    for (const p of this.projects.values()) {
      if (p.shown && p.update) p.update(dt);
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  _mesh(parts, material, { shadow = true, receive = true } = {}) {
    const mesh = new THREE.Mesh(mergeParts(parts), material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = receive;
    return mesh;
  }

  _box(x, y, z, hx, hy, hz, ry = 0) {
    const b = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, y, z), shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)) });
    if (ry) b.quaternion.setFromEuler(0, ry, 0);
    return b;
  }

  // ───────────────────────────── koi ─────────────────────────────

  _buildKoi() {
    const g = this.map.areas && this.map.areas.garden;
    const f = g && g.fountain;
    if (!f) return null;
    // Water surface in the basin is at y 0.46 (Garden._addFountain, radius 1.82). Koi ride just
    // under it (their backs break the surface), lily pads float 0.018 above it.
    const parts = [];
    const fish = [
      [0.0, 1.3, 0xe8732c, 0xf4f1e8], [1.05, 1.5, 0xf4f1e8, 0xe8732c], [2.1, 1.2, 0xd9433a, 0xf4f1e8],
      [3.2, 1.45, 0xf2a93b, 0xf2a93b], [4.2, 1.28, 0xf4f1e8, 0x2b2b2b], [5.25, 1.52, 0xe8732c, 0xe8732c],
    ];
    for (const [a, r, body, spot] of fish) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // The group spins +y, so a fish at angle a moves along (sin a, -cos a): heading ry = PI - a
      const ry = Math.PI - a, hx = Math.sin(a), hz = -Math.cos(a);
      const bob = ((a * 3) % 1) * 0.012;
      parts.push(P(sphereGeo(0.1, 10, 8), M(x, 0.452 + bob, z, ry, [0.55, 0.36, 1.35]), body));
      parts.push(P(sphereGeo(0.05, 8, 6), M(x + hx * 0.03, 0.478 + bob, z + hz * 0.03, ry, [0.7, 0.35, 1.2]), spot));
      const tail = spot === 0x2b2b2b ? body : spot;
      parts.push(P(sphereGeo(0.1, 8, 6), M(x - hx * 0.17, 0.456 + bob, z - hz * 0.17, ry, [0.5, 0.14, 0.45]), tail));
    }
    for (const [a, r, s] of [[0.5, 1.5, 1], [2.6, 1.55, 0.8], [3.9, 1.1, 0.9], [5.6, 1.45, 1.15]]) {
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      parts.push(P(cylinderGeo(0.2 * s, 0.2 * s, 0.012, 14), M(x, 0.478, z), 0x4f8a3c));
      if (s > 0.95) {
        parts.push(P(sphereGeo(0.05, 8, 6), M(x + 0.05, 0.505, z), 0xf4a7c0));
        parts.push(P(sphereGeo(0.028, 6, 4), M(x + 0.05, 0.535, z), 0xf7e27a));
      }
    }
    const mesh = this._mesh(parts, Mat.prop(), { shadow: false });
    const group = new THREE.Group();
    group.position.set(f.x, 0, f.z);
    group.add(mesh);
    return {
      group, bodies: [], spot: { x: f.x, y: 0.5, z: f.z },
      update: (dt) => { mesh.rotation.y += dt * 0.22; },
    };
  }

  // ───────────────────────────── trophy ─────────────────────────────

  _buildTrophy() {
    const ch = this.map.areas && this.map.areas.patio && this.map.areas.patio.clubhouse;
    if (!ch || !ch.center) return null;
    // Top of the lounge trophy case (ClubBuildings: case against the lounge/lobby partition)
    const x = ch.center.x - 3.3, y = 2.262, z = ch.center.z - 2.0;
    const gold = 0xd9a441, silver = 0xd8d8d2, walnut = 0x5a3a22;
    const wood = [
      P(roundedBox(0.36, 0.1, 0.3, 0.02), M(0, 0.05, 0), walnut),
      P(roundedBox(0.28, 0.08, 0.22, 0.015), M(0, 0.14, 0), walnut),
      P(boxGeo(0.18, 0.05, 0.005), M(0, 0.14, 0.113), gold), // plaque
    ];
    const cupProfile = [[0.02, 0], [0.09, 0], [0.09, 0.02], [0.03, 0.05], [0.025, 0.2], [0.06, 0.24], [0.11, 0.3], [0.15, 0.42], [0.155, 0.46], [0.14, 0.46], [0.13, 0.43]]
      .map(([r, h]) => new THREE.Vector2(r, h));
    const metal = [
      P(getGeometry('upg-trophyCup', () => new THREE.LatheGeometry(cupProfile, 20)), M(0, 0.18, 0), gold),
      P(new THREE.TorusGeometry(0.07, 0.013, 6, 12, Math.PI), M(0.15, 0.55, 0, 0, 1, 0, -Math.PI / 2), gold),
      P(new THREE.TorusGeometry(0.07, 0.013, 6, 12, Math.PI), M(-0.15, 0.55, 0, 0, 1, 0, Math.PI / 2), gold),
      P(cylinderGeo(0.14, 0.14, 0.012, 20), M(0, 0.645, 0), silver),
      P(coneGeo(0.05, 0.08, 10), M(0, 0.69, 0), silver),
      P(sphereGeo(0.03, 8, 6), M(0, 0.75, 0), gold),
    ];
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.add(this._mesh(wood, Mat.prop()), this._mesh(metal, Mat.metal()));
    // Interiors are hidden beyond ~32 m (Building); do the same so it never costs a draw far away
    return {
      group, bodies: [], spot: { x, y: y + 0.4, z },
      update: () => {
        const cam = CameraTracker.valid ? CameraTracker.position : null;
        const near = !cam || (Math.abs(cam.x - x) < 32 && Math.abs(cam.z - z) < 32);
        if (group.children[0].visible !== near) for (const c of group.children) c.visible = near;
      },
    };
  }

  // ───────────────────────────── entrance flower beds ─────────────────────────────

  _buildFlowers() {
    const e = this.map.areas && this.map.areas.entrance;
    if (!e || !e.center) return null;
    const beds = [
      { x: e.center.x - 2.0, z: e.center.z - 5.5, w: 1.8, d: 4.6 },  // west lawn beside the entrance walk
      { x: e.center.x + 10.0, z: e.center.z - 2.5, w: 4.4, d: 1.3 }, // strip along the walk to the pro shop
    ];
    const parts = [];
    const bodies = [];
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const H = 0.42;
    for (const b of beds) {
      parts.push(P(roundedBox(b.w, H, b.d, 0.05), M(b.x, H / 2, b.z), BRICK));
      parts.push(P(roundedBox(b.w + 0.1, 0.06, b.d + 0.1, 0.02), M(b.x, H + 0.02, b.z), BRICK_CAP));
      parts.push(P(boxGeo(b.w - 0.16, 0.04, b.d - 0.16), M(b.x, H + 0.04, b.z), COLORS.soil));
      // Leafy mounds, then blooms on top (seeded → stable layout)
      const nx = Math.max(2, Math.round(b.w / 0.42)), nz = Math.max(2, Math.round(b.d / 0.42));
      for (let i = 0; i < nx; i++) {
        for (let k = 0; k < nz; k++) {
          const px = b.x - b.w / 2 + 0.2 + (i + 0.5) * ((b.w - 0.4) / nx) + (rand() - 0.5) * 0.08;
          const pz = b.z - b.d / 2 + 0.2 + (k + 0.5) * ((b.d - 0.4) / nz) + (rand() - 0.5) * 0.08;
          parts.push(P(sphereGeo(0.17, 8, 6), M(px, H + 0.14, pz, 0, [1, 0.75, 1]), rand() < 0.5 ? 0x3f7d3a : 0x4f8f45));
          const col = FLOWER_COLS[Math.floor(rand() * FLOWER_COLS.length)];
          for (let f = 0; f < 3; f++) {
            parts.push(P(sphereGeo(0.055, 6, 5), M(px + (rand() - 0.5) * 0.2, H + 0.26 + rand() * 0.06, pz + (rand() - 0.5) * 0.2), col));
          }
        }
      }
      bodies.push(this._box(b.x, H / 2, b.z, b.w / 2, H / 2, b.d / 2));
    }
    const group = new THREE.Group();
    group.add(this._mesh(parts, Mat.prop()));
    return { group, bodies, spot: { x: beds[0].x, y: 0.6, z: beds[0].z } };
  }

  // ───────────────────────────── Court 1 scoreboard ─────────────────────────────

  _buildScoreboard() {
    const courts = (this.map.areas && this.map.areas.courts) || [];
    const c = courts.find(k => k.id === 'court1') || courts[0];
    if (!c || !c.center) return null;
    const x = c.center.x, z = c.center.z + SIZES.courtDepth / 2 + 2.5; // behind the south fence
    const W = 3.4, H = 1.7, Y = 2.55; // board size, centre height (clears the 3 m fence from the court)
    const frame = [
      P(roundedBox(W + 0.24, H + 0.24, 0.22, 0.05), M(0, Y, 0), COLORS.courtFenceGreen),
      P(roundedBox(W + 0.4, 0.14, 0.34, 0.04), M(0, Y + H / 2 + 0.18, 0), COLORS.courtFenceGreen),
      P(boxGeo(1.1, 0.26, 0.02), M(0, Y + H / 2 + 0.36, 0), 0xd9a441),
    ];
    for (const sx of [-1, 1]) {
      frame.push(P(cylinderGeo(0.08, 0.09, Y, 10), M(sx * (W / 2 - 0.3), Y / 2, 0), COLORS.courtFenceGreen));
      frame.push(P(cylinderGeo(0.16, 0.18, 0.12, 12), M(sx * (W / 2 - 0.3), 0.06, 0), 0x8a8f86));
    }
    // Score face: a small canvas (redrawn only when the score changes), both sides of the board
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const faceMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, roughness: 0.6 });
    faceMat.name = 'upg-scoreFace';
    registerNightGlow(faceMat, 0.55, 0.12);
    const faceGeo = mergeParts([
      P(new THREE.PlaneGeometry(W, H), M(0, Y, 0.115)),
      P(new THREE.PlaneGeometry(W, H), M(0, Y, -0.115, Math.PI)),
    ]);
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.userData.noAO = true;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.add(this._mesh(frame, Mat.prop()), face);
    const bodies = [this._box(x, Y / 2 + 0.5, z, W / 2 + 0.12, Y / 2 + 0.5, 0.15)];

    let lastKey = '';
    const draw = (info) => {
      const key = info ? `${info.a}|${info.b}|${info.ga}|${info.gb}|${info.pa}|${info.pb}|${info.srv}` : 'idle';
      if (key === lastKey) return;
      lastKey = key;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#12301f';
      ctx.fillRect(0, 0, 512, 256);
      ctx.strokeStyle = 'rgba(244,232,193,0.35)';
      ctx.lineWidth = 4;
      ctx.strokeRect(8, 8, 496, 240);
      ctx.fillStyle = '#d9a441';
      ctx.font = '600 30px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('GREENBRIAR · COURT 1', 256, 50);
      if (!info) {
        ctx.fillStyle = '#f4e8c1';
        ctx.font = '600 40px Georgia, serif';
        ctx.fillText('Court open', 256, 140);
        ctx.font = '24px sans-serif';
        ctx.fillStyle = 'rgba(244,232,193,0.7)';
        ctx.fillText('Book with the pro shop', 256, 190);
      } else {
        ctx.textAlign = 'left';
        ctx.font = '600 34px sans-serif';
        const rows = [[info.a, info.ga, info.pa, info.srv === 0], [info.b, info.gb, info.pb, info.srv === 1]];
        rows.forEach(([name, g, p, serving], i) => {
          const y = 118 + i * 70;
          ctx.fillStyle = '#f4e8c1';
          ctx.fillText(String(name).slice(0, 14), 40, y);
          if (serving) { ctx.fillStyle = '#d8e04e'; ctx.beginPath(); ctx.arc(24, y - 11, 8, 0, Math.PI * 2); ctx.fill(); }
          ctx.textAlign = 'right';
          ctx.fillStyle = '#ffe39a';
          ctx.fillText(String(g), 380, y);
          ctx.fillStyle = '#f4e8c1';
          ctx.fillText(String(p), 480, y);
          ctx.textAlign = 'left';
        });
        ctx.fillStyle = 'rgba(244,232,193,0.55)';
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('GAMES', 380, 80);
        ctx.fillText('PTS', 480, 80);
      }
      tex.needsUpdate = true;
    };
    draw(null);

    const PTS = ['0', '15', '30', '40', 'AD'];
    const readMatch = () => {
      const ms = this.matches && this.matches.matches;
      if (!ms) return null;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        if (!m || !m.frame || m.frame.id !== c.id || !m.score || !m.players || m.players.length < 2) continue;
        const sc = m.score;
        const nameOf = (pl) => (pl && pl.npc && pl.npc.name ? pl.npc.name.split(' ')[0] : '—');
        const pt = (v) => PTS[Math.max(0, Math.min(4, v | 0))] || String(v);
        return {
          a: nameOf(m.players[0]), b: nameOf(m.players[1]),
          ga: sc.games ? sc.games[0] : 0, gb: sc.games ? sc.games[1] : 0,
          pa: sc.pts ? pt(sc.pts[0]) : '0', pb: sc.pts ? pt(sc.pts[1]) : '0', srv: sc.server,
        };
      }
      return null;
    };
    return {
      group, bodies, spot: { x, y: Y, z },
      onShow: () => draw(readMatch()),
      update: (dt) => {
        this._scoreTimer -= dt;
        if (this._scoreTimer > 0) return;
        this._scoreTimer = 0.75;
        try { draw(readMatch()); } catch (e) { /* cosmetic */ }
      },
    };
  }

  // ───────────────────────────── patio heaters + lanterns ─────────────────────────────

  _buildPatio() {
    const patio = this.map.areas && this.map.areas.patio;
    if (!patio || !patio.center) return null;
    const ch = patio.clubhouse;
    const slab = 0.1;
    const x0 = patio.center.x - patio.bounds.width / 2, x1 = patio.center.x + patio.bounds.width / 2;
    const clubFront = ch ? ch.center.z + (ch.depth || 8) / 2 : patio.center.z - patio.bounds.depth / 2;
    const heaters = [[x0 + 0.75, clubFront + 2.9], [x1 - 0.75, clubFront + 2.9]];
    const metal = [];
    const glass = [];
    const bodies = [];
    const iron = COLORS.ironWork;
    const steel = 0x9aa0a4;
    for (const [hx, hz] of heaters) {
      metal.push(
        P(cylinderGeo(0.26, 0.3, 0.1, 16), M(hx, slab + 0.05, hz), iron),
        P(cylinderGeo(0.2, 0.24, 0.5, 14), M(hx, slab + 0.35, hz), steel),               // gas-bottle housing
        P(cylinderGeo(0.035, 0.035, 1.6, 8), M(hx, slab + 1.4, hz), steel),              // pole
        P(cylinderGeo(0.09, 0.11, 0.42, 12), M(hx, slab + 2.36, hz), iron),              // burner cage
        P(coneGeo(0.62, 0.22, 18), M(hx, slab + 2.68, hz), steel),                      // reflector dome
        P(cylinderGeo(0.63, 0.63, 0.03, 18), M(hx, slab + 2.58, hz), iron),
      );
      glass.push(P(cylinderGeo(0.075, 0.075, 0.36, 10), M(hx, slab + 2.36, hz)));         // glowing element
      bodies.push(this._box(hx, 0.6, hz, 0.25, 0.6, 0.25));
    }
    // Lanterns hanging from the colonnade beam (front of the clubhouse)
    if (ch) {
      const beamZ = clubFront + 0.1 + 0.35;
      const w = ch.width || 18;
      const cx = ch.center.x;
      for (const ox of [-6.6, -4.4, -1.1, 1.1, 4.4, 6.6]) {
        const lx = cx + ox * (w / 18);
        metal.push(
          P(cylinderGeo(0.008, 0.008, 0.3, 4), M(lx, 3.07, beamZ), iron),                 // chain
          P(coneGeo(0.14, 0.1, 6), M(lx, 2.9, beamZ), iron),                                // cap
          P(roundedBox(0.2, 0.03, 0.2, 0.01), M(lx, 2.64, beamZ), iron),                  // base
        );
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) metal.push(P(boxGeo(0.018, 0.25, 0.018), M(lx + sx * 0.085, 2.73, beamZ + sz * 0.085), iron));
        glass.push(P(boxGeo(0.15, 0.22, 0.15), M(lx, 2.74, beamZ)));
      }
    }
    const group = new THREE.Group();
    const glow = new THREE.Mesh(mergeParts(glass), Mat.lamp());
    glow.userData.noAO = true;
    group.add(this._mesh(metal, Mat.metal()), glow);
    return { group, bodies, spot: { x: patio.center.x, y: 2, z: clubFront + 2 } };
  }

  // ───────────────────────────── hitting wall ─────────────────────────────

  _buildWall() {
    const courts = (this.map.areas && this.map.areas.courts) || [];
    const c = courts.find(k => k.id === 'court2') || courts.find(k => k.id === 'court1');
    if (!c || !c.center) return null;
    // Behind Court 2's south fence, facing away from it onto its own pad (lawn up to the
    // perimeter path); trees there stand at x ≈ 24 and 38, so the 7 m wall fits between them.
    const x = c.center.x + 6, z = c.center.z + SIZES.courtDepth / 2 + 3.8;
    const W = 7, H = 3, T = 0.32, padD = 7.2, padY = 0.055;
    const face = 0x2f6a45, trim = 0xcfc8b8, line = 0xf0eee6;
    const parts = [
      // hard pad in front of the wall (its own layer, above paths 0.04 and below the lot 0.06 edge)
      P(roundedBox(W + 0.6, padY, padD, 0.02), M(x, padY / 2, z + T / 2 + padD / 2), COLORS.courtHardOuter),
      P(boxGeo(W - 0.4, 0.03, 0.06), M(x, padY, z + T / 2 + 5.5), line),                          // service line (+15 mm)
      P(boxGeo(0.06, 0.03, 5.5), M(x, padY, z + T / 2 + 2.75), line),                               // centre line
      // wall slab, cap, footing, buttresses on the back
      P(roundedBox(W, H, T, 0.05), M(x, H / 2, z), face),
      P(roundedBox(W + 0.12, 0.1, T + 0.12, 0.03), M(x, H + 0.05, z), trim),
      P(roundedBox(W + 0.1, 0.18, T + 0.1, 0.03), M(x, 0.09, z), trim),
      P(boxGeo(W - 0.2, 0.06, 0.01), M(x, 0.914, z + T / 2 + 0.005), line),                        // net-height line
      P(boxGeo(0.06, 1.9, 0.01), M(x, 1.95, z + T / 2 + 0.005), line),                              // centre stripe
    ];
    for (const sx of [-2.4, 0, 2.4]) parts.push(P(roundedBox(0.3, H - 0.4, 0.8, 0.04), M(x + sx, (H - 0.4) / 2, z - T / 2 - 0.4), trim));
    // Club crest disc above the net line
    parts.push(P(cylinderGeo(0.42, 0.42, 0.02, 24), M(x, 2.25, z + T / 2 + 0.01, 0, 1, Math.PI / 2), 0xd9a441));
    parts.push(P(cylinderGeo(0.33, 0.33, 0.02, 24), M(x, 2.25, z + T / 2 + 0.03, 0, 1, Math.PI / 2), 0x1f4a34));
    parts.push(P(sphereGeo(0.12, 10, 8), M(x, 2.25, z + T / 2 + 0.05), 0xd8e04e));
    const group = new THREE.Group();
    group.add(this._mesh(parts, Mat.prop()));
    const bodies = [this._box(x, H / 2, z, W / 2, H / 2, T / 2 + 0.05), this._box(x, (H - 0.4) / 2, z - T / 2 - 0.4, W / 2 - 0.9, (H - 0.4) / 2, 0.4)];
    return { group, bodies, spot: { x, y: 1.5, z: z + 3 } };
  }
}
