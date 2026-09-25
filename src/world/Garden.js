import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS } from '../utils/Constants.js';
import { Scenery, bakeParts, lumpyIco } from './Scenery.js';
import { EnvState } from '../graphics/EnvState.js';
import { Quality } from '../graphics/Quality.js';
import { mat, getMaterial } from '../graphics/Materials.js';
import { Textures, createCanvasTexture, hash2 } from '../graphics/Textures.js';
import { getGeometry, roundedBox, cylinderGeo, mergeStaticMeshes, makeMatrix } from '../graphics/GeometryUtils.js';

const WALK_Y = 0.07;     // paver walks (above cart paths at 0.04)
const WALK_EDGE_Y = 0.055;

function P(geometry, matrix, color) { return { geometry, matrix, color }; }

/** World-space box-projected UVs (geometry already in world space). */
function boxUV(geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new THREE.BufferAttribute(new Float32Array(p.count * 2), 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (ay >= ax && ay >= az) uv.setXY(i, x / tile, z / tile);
    else if (ax >= az) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  geo.setAttribute('uv', uv);
  return geo;
}

/** Flat +Y geometry (discs & ribbons) with world-space UVs. */
function flatGeometry(shapes, y, tile) {
  const pos = [], idx = [];
  const tri = (a, b, c) => {
    const ax = pos[a * 3], az = pos[a * 3 + 2], bx = pos[b * 3], bz = pos[b * 3 + 2], cx = pos[c * 3], cz = pos[c * 3 + 2];
    if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  for (const s of shapes) {
    if (s.disc) {
      const [cx, cz, r] = s.disc, seg = 40;
      const c = pos.length / 3;
      pos.push(cx, y, cz);
      for (let k = 0; k < seg; k++) { const a = (k / seg) * Math.PI * 2; pos.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r); }
      for (let k = 0; k < seg; k++) tri(c, c + 1 + k, c + 1 + ((k + 1) % seg));
    } else {
      const [x0, z0, x1, z1] = s.rect;
      const i = pos.length / 3;
      pos.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      tri(i, i + 1, i + 2); tri(i, i + 2, i + 3);
    }
  }
  const n = pos.length / 3;
  const uv = new Float32Array(n * 2), nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { uv[i * 2] = pos[i * 3] / tile; uv[i * 2 + 1] = pos[i * 3 + 2] / tile; nor[i * 3 + 1] = 1; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Vertical streaks (alpha) for falling water sheets. */
function waterStreakTexture() {
  return createCanvasTexture(128, (ctx, s, rand) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 70; i++) {
      const x = rand() * s, w = 1 + rand() * 3, a = 0.25 + rand() * 0.75;
      const y0 = rand() * s, len = s * (0.3 + rand() * 0.7);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(x, y0, w, len);
      ctx.fillRect(x, y0 - s, w, len);
    }
  }, { key: 'garden-waterStreaks', srgb: false });
}

/**
 * Garden - landscaping area with hedges, flower beds, and fountain
 */
export class Garden {
  /**
   * @param {THREE.Scene} scene
   * @param {CANNON.World} physicsWorld
   * @param {object} config  map.json areas.garden
   * @param {object} [env]   { scenery: Scenery (shared batch), isFree: (x,z,margin)=>bool }
   */
  constructor(scene, physicsWorld, config, env = {}) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.mesh = new THREE.Group();
    this.mesh.name = 'Garden';
    this.fountainParticles = [];   // legacy field (spray is GPU-animated now)
    this.scenery = env.scenery || null;
    this._ownScenery = !this.scenery;
    if (this._ownScenery) this.scenery = new Scenery(scene);
    this.isFree = env.isFree || (() => true);
    this._animated = [];            // textures / uniforms to advance in update()

    this._build(config);
    mergeStaticMeshes(this.mesh);
    this.scene.add(this.mesh);
    if (this._ownScenery) this.scenery.build();
  }

  _build(config) {
    const { center } = config;

    // Paver walks: round plaza around the fountain + cross walks
    this._addWalks(config);

    // Hedges
    if (config.hedges) {
      const hedgeParts = [];
      for (const hedge of config.hedges) {
        this._addHedge(hedge, hedgeParts);
      }
      if (hedgeParts.length) {
        const geo = boxUV(bakeParts(hedgeParts), 2.5);
        const m = new THREE.Mesh(geo, mat(0xffffff, { map: Textures.hedge({ repeat: [1, 1] }), roughness: 0.95, wet: 0.35, name: 'hedge' }));
        m.castShadow = m.receiveShadow = true;
        m.name = 'GardenHedges';
        this.mesh.add(m);
      }
    }

    // Flower beds
    if (config.flowerBeds) {
      const bedParts = [];
      for (const bed of config.flowerBeds) {
        this._addFlowerBed(bed, bedParts);
      }
      if (bedParts.length) {
        const m = new THREE.Mesh(bakeParts(bedParts), getMaterial('scenery-prop', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })));
        m.castShadow = m.receiveShadow = true;
        this.mesh.add(m);
      }
    }

    // Fountain
    if (config.fountain) {
      this._addFountain(config.fountain);
    }

    // Benches at the ends of the west and south walks, facing the fountain
    const f = config.fountain || center;
    const hw = config.bounds.width / 2, hd = config.bounds.depth / 2;
    const walk = this._walk;
    this.scenery.addBench(walk.w + 0.4, WALK_Y, f.z, Math.PI / 2);
    this.scenery.addBench(f.x, WALK_Y, walk.s + 0.4, 0);

    // Lamps flanking the north and east entrances
    this.scenery.addLamp(f.x - 1.35, 0, walk.n + 0.1);
    this.scenery.addLamp(f.x + 1.35, 0, walk.n + 0.1);
    // (skip any that would land on a neighbouring court's clay/pad — grooming lane)
    const offCourt = (x, z) => this.isFree(x, z, 0.3, { ignore: ['garden', 'building', 'patio', 'lot'], paths: false });
    for (const dz of [-1.35, 1.35]) {
      if (offCourt(walk.e - 0.7, f.z + dz)) this.scenery.addLamp(walk.e - 0.7, 0, f.z + dz);
    }

    // Clipped cypresses framing the south bench
    for (const sx of [-1, 1]) this.scenery.addTree('cypress', f.x + sx * 1.8, 0, walk.s - 0.5, { scale: 0.75 });

    // Decorative trees (with trunk collision) around the garden's west side, clear of walks/beds/courts
    const candidates = [
      ['blossom', center.x - 7.8, center.z - 4.5], ['oak', center.x - 9.0, center.z + 2.4],
      ['pine', center.x - 9.3, center.z - 8.0], ['blossom', center.x - 10.5, center.z - 12],
      ['oak', center.x - 11, center.z + 6],
    ];
    let placed = 0;
    for (const [sp, x, z] of candidates) {
      if (placed >= 3) break;
      if (!this.isFree(x, z, 1.2, { ignore: ['garden'] })) continue;
      this._addTree(x, z, sp);
      placed++;
    }

    // Tufts along the hedge bases
    if (config.hedges) {
      for (const h of config.hedges) {
        const alongX = h.width > h.depth;
        const L = alongX ? h.width : h.depth;
        for (let t = -L / 2; t < L / 2; t += 0.35) {
          for (const sd of [-1, 1]) {
            const r = hash2(Math.round(t * 10), sd, h.x | 0);
            if (r < 0.4) continue;
            const off = (alongX ? h.depth : h.width) / 2 + 0.08 + r * 0.25;
            const x = h.x + (alongX ? t : sd * off), z = h.z + (alongX ? sd * off : t);
            this.scenery.addTuft(x, 0, z, 0.7 + r * 0.5);
          }
        }
      }
    }
  }

  _addWalks(config) {
    const f = config.fountain || config.center;
    const c = config.center;
    const hw = config.bounds.width / 2, hd = config.bounds.depth / 2;
    const ww = 1.6, rPlaza = 2.9, e = 0.16;
    const walkN = c.z + hd - 2.8, walkS = c.z - hd + 2.4, walkE = c.x + hw - 1, walkW = c.x - hw + 2.6;
    this._walk = { n: walkN, s: walkS, e: walkE, w: walkW };
    const shapes = (grow) => [
      { disc: [f.x, f.z, rPlaza + grow] },
      { rect: [f.x - ww / 2 - grow, f.z, f.x + ww / 2 + grow, walkN + grow] },
      { rect: [f.x - ww / 2 - grow, walkS - grow, f.x + ww / 2 + grow, f.z] },
      { rect: [f.x, f.z - ww / 2 - grow, walkE + grow, f.z + ww / 2 + grow] },
      { rect: [walkW - grow, f.z - ww / 2 - grow, f.x, f.z + ww / 2 + grow] },
    ];
    const top = new THREE.Mesh(flatGeometry(shapes(0), WALK_Y, 2.0),
      mat(0xffffff, { map: Textures.pavers({ repeat: [1, 1] }), roughness: 0.85, wet: 0.7, name: 'patioPavers' }));
    const edge = new THREE.Mesh(flatGeometry(shapes(e), WALK_EDGE_Y, 1.6),
      mat(COLORS.pathEdging, { map: Textures.pavers({ repeat: [1, 1] }), roughness: 0.9, wet: 0.6, name: 'pathEdging' }));
    top.receiveShadow = edge.receiveShadow = true;
    this.mesh.add(top, edge);
  }

  _addHedge(config, parts) {
    parts.push(P(roundedBox(config.width, 1.5, config.depth, 0.38, 3), makeMatrix(config.x, 0.75, config.z)));
    // Topiary balls capping the hedge ends
    const alongX = config.width > config.depth;
    const L = alongX ? config.width : config.depth;
    for (const s of [-1, 1]) {
      const x = config.x + (alongX ? s * (L / 2 - 0.45) : 0), z = config.z + (alongX ? 0 : s * (L / 2 - 0.45));
      parts.push(P(lumpyIco(0.62, 1, 12, 0.06), makeMatrix(x, 1.68, z)));
    }

    // Physics
    const shape = new CANNON.Box(new CANNON.Vec3(config.width / 2, 0.75, config.depth / 2));
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(config.x, 0.75, config.z), shape });
    this.physicsWorld.addBody(body);
  }

  _addFlowerBed(config, parts) {
    const w = config.width, d = config.depth;
    const STONE = 0xdcd2bb;
    // Raised soil bed + stone kerb
    parts.push(P(roundedBox(w - 0.3, 0.22, d - 0.3, 0.06), makeMatrix(config.x, 0.11, config.z), COLORS.soil));
    parts.push(P(roundedBox(w, 0.28, 0.2, 0.05), makeMatrix(config.x, 0.14, config.z - d / 2 + 0.1), STONE));
    parts.push(P(roundedBox(w, 0.28, 0.2, 0.05), makeMatrix(config.x, 0.14, config.z + d / 2 - 0.1), STONE));
    parts.push(P(roundedBox(0.2, 0.28, d - 0.4, 0.05), makeMatrix(config.x - w / 2 + 0.1, 0.14, config.z), STONE));
    parts.push(P(roundedBox(0.2, 0.28, d - 0.4, 0.05), makeMatrix(config.x + w / 2 - 0.1, 0.14, config.z), STONE));

    // Flowers: a grid of leafy clumps with blooms, a pale accent border and a taller centrepiece
    const flowerColor = COLORS.flowers[config.color % COLORS.flowers.length];
    const inner = 0.5, step = 0.5;
    for (let x = -w / 2 + inner; x <= w / 2 - inner + 1e-3; x += step) {
      for (let z = -d / 2 + inner; z <= d / 2 - inner + 1e-3; z += step) {
        const edge = Math.abs(x) > w / 2 - inner - 0.1 || Math.abs(z) > d / 2 - inner - 0.1;
        const jx = (hash2(Math.round(x * 10), Math.round(z * 10), config.color) - 0.5) * 0.18;
        const jz = (hash2(Math.round(z * 10), Math.round(x * 10), config.color + 3) - 0.5) * 0.18;
        const col = edge && (config.color % 2 === 0) ? 0xf5f0e6 : flowerColor;
        this.scenery.addFlowerClump(config.x + x + jx, 0.2, config.z + z + jz, col, edge ? 0.85 : 1.05);
      }
    }
    this.scenery.addTree('cypress', config.x, 0.2, config.z, { scale: 0.42, shadow: true });
  }

  _addFountain(pos) {
    const stoneMat = mat(0xe4ddcb, { map: Textures.stucco({ repeat: [4, 1] }), roughness: 0.8, wet: 0.6, name: 'fountainStone' });

    // Basin: lathe profile (outer wall, lip, inner wall)
    const basinProfile = [
      [2.02, 0.0], [2.05, 0.05], [2.0, 0.38], [2.14, 0.42], [2.16, 0.5], [2.1, 0.55], [1.86, 0.55], [1.82, 0.5], [1.8, 0.2], [0.01, 0.2],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const basin = new THREE.Mesh(getGeometry('garden-basin', () => new THREE.LatheGeometry(basinProfile, 40)), stoneMat);
    basin.position.set(pos.x, 0, pos.z);
    basin.castShadow = basin.receiveShadow = true;
    this.mesh.add(basin);

    // Tiered pedestal with two bowls
    const pedProfile = [
      [0.62, 0.2], [0.62, 0.34], [0.5, 0.4], [0.3, 0.46], [0.24, 0.6], [0.22, 0.95], [0.3, 1.02],
      [0.5, 1.06], [0.95, 1.14], [1.08, 1.24], [1.04, 1.3], [0.9, 1.26], [0.2, 1.24],
      [0.14, 1.3], [0.12, 1.62], [0.2, 1.68], [0.48, 1.74], [0.6, 1.83], [0.57, 1.88], [0.46, 1.84],
      [0.1, 1.84], [0.08, 1.95], [0.12, 2.02], [0.08, 2.1], [0.04, 2.16], [0.0, 2.17],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const ped = new THREE.Mesh(getGeometry('garden-pedestal', () => new THREE.LatheGeometry(pedProfile, 32)), stoneMat);
    ped.position.set(pos.x, 0, pos.z);
    ped.castShadow = ped.receiveShadow = true;
    this.mesh.add(ped);

    // Water surfaces (scrolling bump ripples, glossy)
    const ripple = Textures.noise({ scale: 8 }).clone();
    ripple.repeat.set(2.5, 2.5);
    ripple.needsUpdate = true;
    const waterMat = new THREE.MeshStandardMaterial({
      color: COLORS.fountainWater, roughness: 0.06, metalness: 0.05, transparent: true, opacity: 0.86,
      bumpMap: ripple, bumpScale: 0.9, envMapIntensity: 1.4,
    });
    waterMat.name = 'fountainWater';
    const waterGeo = new THREE.Group();
    for (const [r, y] of [[1.82, 0.46], [0.96, 1.25], [0.47, 1.845]]) {
      const w = new THREE.Mesh(getGeometry(`garden-water|${r}`, () => new THREE.CircleGeometry(r, 36).rotateX(-Math.PI / 2)), waterMat);
      w.position.set(pos.x, y, pos.z);
      w.receiveShadow = true;
      waterGeo.add(w);
    }
    waterGeo.userData.noMerge = true;
    this.mesh.add(waterGeo);
    this._animated.push({ tex: ripple, dx: 0.02, dy: 0.035 });

    // Falling water sheets from each bowl rim (scrolling streak alpha)
    const streaks = waterStreakTexture().clone();
    streaks.repeat.set(6, 1);
    streaks.needsUpdate = true;
    const sheetMat = new THREE.MeshStandardMaterial({
      color: 0xdff3fa, roughness: 0.1, transparent: true, opacity: 0.7, alphaMap: streaks,
      depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    });
    sheetMat.name = 'fountainSheet';
    const sheets = new THREE.Group();
    for (const [rt, rb, y0, y1] of [[1.09, 1.2, 1.28, 0.47], [0.6, 0.66, 1.86, 1.26]]) {
      const g = getGeometry(`garden-sheet|${rt}`, () => new THREE.CylinderGeometry(rt, rb, y0 - y1, 36, 1, true));
      const m = new THREE.Mesh(g, sheetMat);
      m.position.set(pos.x, (y0 + y1) / 2, pos.z);
      m.renderOrder = 2;
      m.userData.noAO = true;
      sheets.add(m);
    }
    sheets.userData.noMerge = true;
    this.mesh.add(sheets);
    this._animated.push({ tex: streaks, dx: 0, dy: 0.9 });

    // Spray: GPU-animated particle arcs from the finial into the top bowl
    const lowQ = Quality.tier === 'low';
    const N = lowQ ? 90 : 220;
    const seeds = new Float32Array(N * 3), p = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      seeds[i * 3] = (i / N) * Math.PI * 2 * 7.13;
      seeds[i * 3 + 1] = hash2(i, 1, 9);
      seeds[i * 3 + 2] = hash2(i, 2, 9);
      p[i * 3] = pos.x; p[i * 3 + 1] = 2.15; p[i * 3 + 2] = pos.z;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.sprayMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSize: { value: 36 }, uColor: { value: new THREE.Color(0xe8f6ff) } },
      vertexShader: `
        attribute vec3 aSeed;
        uniform float uTime; uniform float uSize;
        varying float vA;
        void main() {
          float t = fract(uTime * 0.85 + aSeed.z);
          float r = (0.32 + 0.18 * aSeed.y) * t;
          vec3 p = position + vec3(cos(aSeed.x) * r, (1.35 + 0.35 * aSeed.y) * t - (1.6 + 0.3 * aSeed.y) * t * t, sin(aSeed.x) * r);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * (0.6 + 0.6 * aSeed.y) / max(-mv.z, 0.5);
          vA = 0.35 + 0.65 * (1.0 - t);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          gl_FragColor = vec4(uColor, (1.0 - d * 2.0) * vA * 0.8);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    const spray = new THREE.Points(sg, this.sprayMaterial);
    spray.frustumCulled = false;
    spray.userData.noMerge = true;
    spray.renderOrder = 3;
    // gl_PointSize is in framebuffer pixels: follow the renderer's (per-tier, live) pixel ratio
    const sizeU = this.sprayMaterial.uniforms.uSize;
    spray.onBeforeRender = (renderer) => { sizeU.value = 36 * renderer.getPixelRatio(); };
    this.mesh.add(spray);

    // Physics blocker
    const shape = new CANNON.Cylinder(2.0, 2.0, 0.5, 8);
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(pos.x, 0.25, pos.z), shape });
    this.physicsWorld.addBody(body);

    // Flowers around the basin foot
    for (let k = 0; k < 4; k++) {
      for (const da of [-0.3, 0, 0.3]) {
        const a = k * Math.PI / 2 + Math.PI / 4 + da;
        this.scenery.addFlowerClump(pos.x + Math.cos(a) * 2.45, WALK_Y, pos.z + Math.sin(a) * 2.45, da === 0 ? 0x9fb7e8 : 0xf5f0e6, 0.75);
      }
    }
  }

  _addTree(x, z, species = 'blossom') {
    this.scenery.addTree(species, x, 0, z, { scale: species === 'oak' ? 0.9 : 1.0 });

    // Physics trunk
    const shape = new CANNON.Cylinder(0.3, 0.3, 2, 6);
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, 1, z), shape });
    this.physicsWorld.addBody(body);
  }

  update(dt) {
    const t = EnvState.time;
    for (const a of this._animated) {
      a.tex.offset.set((t * a.dx) % 1, (t * a.dy) % 1);
    }
    if (this.sprayMaterial) {
      const u = this.sprayMaterial.uniforms;
      u.uTime.value = t;
      const k = 1 - 0.7 * (EnvState.nightFactor || 0);
      u.uColor.value.setRGB(0.9 * k, 0.95 * k, 1.0 * k);
    }
    if (this._ownScenery) this.scenery.update();
  }
}
