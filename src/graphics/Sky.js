import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { seededRandom, fbm2 } from './Textures.js';

/**
 * Sky — cheap stylized gradient dome with sun/moon discs, drifting low-poly clouds,
 * night stars and a distant horizon (hills + treeline + far ground) so the world
 * never ends at a flat edge. Owned and driven by WeatherSystem.
 */

const SKY_RADIUS = 480;

const skyVertex = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * p;
  }
`;

const skyFragment = /* glsl */`
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uMoonDir;
  uniform float uSunDisc;     // 0..1 sun disc visibility
  uniform float uSunGlow;     // 0..1 glow strength
  uniform float uMoon;        // 0..1 moon visibility
  uniform float uHaze;        // 0..1 overcast haze (flattens gradient)
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y;
    float up = pow(clamp(h, 0.0, 1.0), mix(0.45, 1.2, uHaze));
    vec3 col = mix(uHorizon, uTop, up);
    // thin bright band just above the horizon
    col += uHorizon * 0.08 * (1.0 - smoothstep(0.0, 0.12, abs(h)));
    // below horizon fades to ground tint
    col = mix(col, uGround, smoothstep(0.0, -0.2, h));

    float d = dot(dir, uSunDir);
    float ds = max(d, 0.0);
    // warm atmospheric glow around the sun, stronger near the horizon
    float glow = pow(ds, 6.0) * 0.35 + pow(ds, 48.0) * 0.6;
    col += uSunColor * glow * uSunGlow * (0.6 + 0.4 * (1.0 - clamp(h, 0.0, 1.0)));
    // sun disc
    float disc = smoothstep(0.9990, 0.9994, d);
    col += uSunColor * disc * uSunDisc * 6.0;

    // moon
    float dm = dot(dir, uMoonDir);
    float moon = smoothstep(0.9993, 0.9996, dm);
    col += vec3(0.85, 0.9, 1.0) * (moon * 2.2 + pow(max(dm, 0.0), 200.0) * 0.12) * uMoon;

    // dither to avoid banding
    col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createSkyMaterial({ ground = 0x3a5a40, sunDisc = true } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(0x3f86d6) },
      uHorizon: { value: new THREE.Color(0xbfe0f5) },
      uGround: { value: new THREE.Color(ground) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunDisc: { value: sunDisc ? 1 : 0 },
      uSunGlow: { value: 1 },
      uMoon: { value: 0 },
      uHaze: { value: 0 },
    },
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

/** The visible sky dome (follows the camera). */
export class SkyDome {
  constructor() {
    this.material = createSkyMaterial({ ground: 0x6f8a70 });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), this.material);
    this.mesh.name = 'SkyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000; // draw after opaque scene -> early-z rejects hidden pixels
    this.mesh.matrixAutoUpdate = false;
    this.u = this.material.uniforms;

    // Environment version: no sun disc, ground = grass bounce
    this.envMaterial = createSkyMaterial({ ground: 0x4a6a34, sunDisc: false });
    // share colour uniforms so the env scene always matches (except uTop: WeatherSystem warms
    // the env zenith at golden hour so the deep-blue sky top doesn't tint the ground lilac)
    for (const k of ['uHorizon', 'uSunDir', 'uSunColor', 'uMoonDir', 'uSunGlow', 'uMoon', 'uHaze']) {
      this.envMaterial.uniforms[k] = this.u[k];
    }
    this.envScene = new THREE.Scene();
    const envMesh = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.envMaterial);
    this.envScene.add(envMesh);
  }

  followCamera(camera) {
    this.mesh.position.copy(camera.position);
    this.mesh.updateMatrix();
  }
}

/** Stars (Points on the upper hemisphere), follows the camera with the dome. */
export class Stars {
  constructor(count = 450) {
    const rand = seededRandom(77);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = rand() * Math.PI * 2;
      const y = 0.08 + rand() * 0.92;
      const r = Math.sqrt(1 - y * y);
      const R = SKY_RADIUS * 0.95;
      pos[i * 3] = Math.cos(u) * r * R;
      pos[i * 3 + 1] = y * R;
      pos[i * 3 + 2] = Math.sin(u) * r * R;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.material = new THREE.PointsMaterial({
      color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0,
      depthWrite: false, fog: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1001;
    this.points.visible = false;
    this.points.matrixAutoUpdate = false;
  }

  update(camera, opacity) {
    this.points.visible = opacity > 0.01;
    if (!this.points.visible) return;
    this.material.opacity = opacity;
    this.points.position.copy(camera.position);
    this.points.updateMatrix();
  }
}

/** Build one puffy low-poly cloud geometry from a few flattened icosahedra. */
function buildCloudGeometry(rand) {
  const parts = [];
  const n = 6 + ((rand() * 4) | 0);
  for (let i = 0; i < n; i++) {
    // cluster: big puffs in the middle, smaller toward the ends, spread wider in X than Z
    const t = (i + 0.5) / n;
    const x = (t - 0.5) * 5.2 + (rand() - 0.5) * 0.6;
    const z = (rand() - 0.5) * 1.8;
    const r = 0.6 + Math.sin(t * Math.PI) * 0.75 + rand() * 0.3;
    const g = new THREE.IcosahedronGeometry(r, 2);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const y = p.getY(v);
      p.setY(v, Math.max(y * 0.8, -r * 0.2)); // flat bottom
    }
    g.translate(x, r * 0.2 + rand() * 0.25, z);
    g.deleteAttribute('uv');
    parts.push(g);
  }
  // weld each puff so normals are smooth (soft, rounded shading)
  const welded = parts.map((p) => { p.deleteAttribute('normal'); const w = mergeVertices(p, 1e-3); w.computeVertexNormals(); p.dispose(); return w; });
  const merged = mergeGeometries(welded, false);
  welded.forEach(p => p.dispose());
  return merged;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

/** Drifting stylized clouds — 3 InstancedMeshes (3 draw calls max). */
export class Clouds {
  constructor(maxCount = 15) {
    const rand = seededRandom(1234);
    this.group = new THREE.Group();
    this.group.name = 'Clouds';
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, metalness: 0, flatShading: false, fog: false,
      emissive: 0x8899aa, emissiveIntensity: 0.35,
    });
    this.shapes = [];
    this.clouds = [];
    const perShape = Math.ceil(maxCount / 3);
    for (let s = 0; s < 3; s++) {
      const im = new THREE.InstancedMesh(buildCloudGeometry(rand), this.material, perShape);
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;
      im.count = perShape;
      this.shapes.push(im);
      this.group.add(im);
    }
    for (let i = 0; i < maxCount; i++) {
      const ang = rand() * Math.PI * 2;
      // Beyond the front hill ring (r=215) and well above the ridges, so clouds
      // read as sky rather than blobs sitting just over the fences.
      const rad = 200 + rand() * 130;
      this.clouds.push({
        shape: i % 3,
        slot: Math.floor(i / 3),
        ang,
        rad,
        x: Math.cos(ang) * rad,
        z: Math.sin(ang) * rad,
        y: 85 + rand() * 45,
        scale: 11 + rand() * 8,
        rot: rand() * Math.PI,
        speed: 0.6 + rand() * 0.8,
      });
    }
    this.visibleCount = maxCount;
    this._apply();
  }

  setCount(n) {
    this.visibleCount = Math.max(0, Math.min(n, this.clouds.length));
    for (const im of this.shapes) im.count = 0;
    for (let i = 0; i < this.visibleCount; i++) {
      const c = this.clouds[i];
      const im = this.shapes[c.shape];
      im.count = Math.max(im.count, c.slot + 1);
    }
    // hide instances beyond visibleCount that fall under a shape's count
    this._apply();
  }

  _apply() {
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      const hidden = i >= this.visibleCount;
      _p.set(c.x, c.y, c.z);
      _q.setFromAxisAngle(_yAxis, c.rot);
      const sc = hidden ? 0 : c.scale;
      _s.set(sc, sc * 0.55, sc);
      _m4.compose(_p, _q, _s);
      this.shapes[c.shape].setMatrixAt(c.slot, _m4);
    }
    for (const im of this.shapes) im.instanceMatrix.needsUpdate = true;
  }

  /**
   * Drift slowly around the horizon ring (wind sets speed and direction).
   * Clouds orbit instead of translating so they never pass low over the
   * play area, where they read as blobs sitting on the fences. No allocations.
   */
  update(dt, windDir, windStrength) {
    const sp = (1.5 + windStrength * 5) * dt;
    const dir = windDir.x + windDir.z >= 0 ? 1 : -1;
    for (let i = 0; i < this.visibleCount; i++) {
      const c = this.clouds[i];
      c.ang += (dir * sp * c.speed) / c.rad;
      c.x = Math.cos(c.ang) * c.rad;
      c.z = Math.sin(c.ang) * c.rad;
    }
    this._apply();
  }

  /** Tint: lit colour + emissive fill so clouds blend into the sky. */
  setColors(baseColor, emissiveColor, emissiveIntensity) {
    this.material.color.copy(baseColor);
    this.material.emissive.copy(emissiveColor);
    this.material.emissiveIntensity = emissiveIntensity;
  }
}

/**
 * Distant horizon: rolling hills ring, a backdrop treeline ring and an outer ground annulus.
 * 3 draw calls total, all fogged so they fade into the sky.
 */
export class Horizon {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Horizon';
    const rand = seededRandom(4242);

    // Outer ground (under the main ground plane, fills to the fog distance)
    const groundGeo = new THREE.RingGeometry(95, SKY_RADIUS * 0.95, 48, 1);
    groundGeo.rotateX(-Math.PI / 2);
    this.groundMaterial = new THREE.MeshStandardMaterial({ color: 0x5a9044, roughness: 1 });
    const ground = new THREE.Mesh(groundGeo, this.groundMaterial);
    ground.position.y = -0.08;
    ground.receiveShadow = false;
    ground.name = 'OuterGround';
    this.group.add(ground);

    // Hills: two layered rings of low-poly silhouettes. Unfogged, unlit, tinted each frame
    // by WeatherSystem (setHillTint) toward the horizon colour — but never all the way, so
    // at dawn / dusk the ridges stay distinct from the sky instead of a flat cardboard wall.
    const hillGeos = [];
    const layers = [
      { r: 215, hMin: 4, hMax: 30, seg: 144, col: new THREE.Color(0x4a7a40), seed: 3, period: 14, layer: 0 },
      { r: 300, hMin: 12, hMax: 40, seg: 120, col: new THREE.Color(0x6f8fa0), seed: 9, period: 9, layer: 1 },
    ];
    for (const L of layers) {
      const pos = [];
      const cols = [];
      const lay = [];
      const top = [];
      for (let i = 0; i <= L.seg; i++) {
        const t = i / L.seg;
        const n = fbm2(t * L.period, L.seed, { octaves: 4, seed: L.seed, period: L.period });
        const k = Math.min(1, Math.max(0, (n - 0.25) * 1.9));
        top.push(L.hMin + (L.hMax - L.hMin) * k * k * (3 - 2 * k));
      }
      const hMax = Math.max(...top);
      // vertical gradient: base x0.7 -> ridge x1.0 (taller ridges catch more light)
      const shade = (y) => 0.7 + 0.3 * Math.min(1, Math.max(0, (y + 2) / (hMax + 2)));
      const c = new THREE.Color();
      const push = (x, y, z, jit) => {
        pos.push(x, y, z);
        c.copy(L.col).multiplyScalar(shade(y) * jit);
        cols.push(c.r, c.g, c.b);
        lay.push(L.layer);
      };
      for (let i = 0; i < L.seg; i++) {
        const a0 = (i / L.seg) * Math.PI * 2, a1 = ((i + 1) / L.seg) * Math.PI * 2;
        const x0 = Math.cos(a0) * L.r, z0 = Math.sin(a0) * L.r;
        const x1 = Math.cos(a1) * L.r, z1 = Math.sin(a1) * L.r;
        const y0 = top[i], y1 = top[i + 1];
        const jit = 0.94 + 0.12 * (fbm2(i * 0.37, L.seed + 5, { octaves: 2, seed: L.seed + 5, period: L.seg }));
        // two triangles, facing inward
        push(x0, -2, z0, jit); push(x1, -2, z1, jit); push(x1, y1, z1, jit);
        push(x0, -2, z0, jit); push(x1, y1, z1, jit); push(x0, y0, z0, jit);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aCol', new THREE.Float32BufferAttribute(cols, 3));
      g.setAttribute('aLayer', new THREE.Float32BufferAttribute(lay, 1));
      hillGeos.push(g);
    }
    this.hillUniforms = {
      uHorizon: { value: new THREE.Color(0xc6e2f6) },
      uSunColor: { value: new THREE.Color(0xfff2e0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDay: { value: 1 },
      uHaze: { value: 0 },
    };
    const hillMaterial = new THREE.ShaderMaterial({
      uniforms: this.hillUniforms,
      vertexShader: /* glsl */`
        attribute vec3 aCol;
        attribute float aLayer;
        varying vec3 vCol;
        varying float vLayer;
        varying vec2 vDir;
        void main() {
          vCol = aCol;
          vLayer = aLayer;
          vDir = normalize(position.xz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uHorizon, uSunColor, uSunDir;
        uniform float uDay, uHaze;
        varying vec3 vCol;
        varying float vLayer;
        varying vec2 vDir;
        void main() {
          // hills opposite the sun are front-lit, hills under the sun are backlit
          vec2 sd = normalize(uSunDir.xz + vec2(1e-4));
          float lit = 0.5 - 0.5 * dot(vDir, sd);
          vec3 col = vCol * (0.9 + 0.25 * lit * uDay) * mix(vec3(1.0), uSunColor, 0.25 * uDay);
          float haze = min(0.92, mix(0.35, 0.55, vLayer) + 0.35 * uHaze);
          col = mix(col, uHorizon, haze) * (0.55 + 0.45 * uDay);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      fog: false,
    });
    const hills = new THREE.Mesh(mergeGeometries(hillGeos, false), hillMaterial);
    hillGeos.forEach(g => g.dispose());
    hills.geometry.computeBoundingSphere();
    hills.name = 'Hills';
    this.group.add(hills);

    // Backdrop treeline: an elliptical ring of chunky cone trees just beyond the ground plane
    const treeParts = [];
    const cone = new THREE.ConeGeometry(1, 1, 7);
    cone.deleteAttribute('uv');
    const trunk = new THREE.CylinderGeometry(0.12, 0.16, 1, 5);
    trunk.deleteAttribute('uv');
    const tmp = new THREE.Matrix4();
    const greens = [0x2f5f33, 0x386b3a, 0x2a5530, 0x437a3f, 0x31603a].map(c => new THREE.Color(c));
    const trunkCol = new THREE.Color(0x5a4030);
    const addColored = (geo, matrix, col) => {
      const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      treeParts.push(g);
    };
    const blob = new THREE.IcosahedronGeometry(1, 0);
    blob.deleteAttribute('uv');
    const broadGreens = [0x3f7a3a, 0x4a8740, 0x356b36, 0x5a8f45].map(c => new THREE.Color(c));
    for (let ring = 0; ring < 2; ring++) {
      const rx = 132 + ring * 16, rz = 116 + ring * 16;
      const count = 110 + ring * 20;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rand() * 0.04;
        const jitter = (rand() - 0.5) * 9;
        const x = Math.cos(a) * (rx + jitter);
        const z = Math.sin(a) * (rz + jitter);
        const conifer = rand() < 0.55;
        const h = (conifer ? 6 : 5) + rand() * 5 + ring * 1.5;
        if (conifer) {
          const w = h * (0.28 + rand() * 0.08);
          const col = greens[(rand() * greens.length) | 0];
          tmp.compose(_p.set(x, h * 0.5 + 0.9, z), _q.identity(), _s.set(w, h, w));
          addColored(cone, tmp, col);
          tmp.compose(_p.set(x, h * 0.9 + 0.9, z), _q.identity(), _s.set(w * 0.7, h * 0.55, w * 0.7));
          addColored(cone, tmp, col);
        } else {
          const w = h * (0.42 + rand() * 0.12);
          const col = broadGreens[(rand() * broadGreens.length) | 0];
          _q.setFromAxisAngle(_yAxis, rand() * Math.PI);
          tmp.compose(_p.set(x, h * 0.62, z), _q, _s.set(w, h * 0.45, w));
          addColored(blob, tmp, col);
          _q.identity();
        }
        if (ring === 0) {
          tmp.compose(_p.set(x, 0.9, z), _q.identity(), _s.set(1.4, 1.8, 1.4));
          addColored(trunk, tmp, trunkCol);
        }
      }
    }
    const treeGeo = mergeGeometries(treeParts, false);
    treeParts.forEach(g => g.dispose());
    treeGeo.computeBoundingSphere();
    const trees = new THREE.Mesh(
      treeGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true })
    );
    trees.name = 'Treeline';
    this.group.add(trees);

    for (const c of this.group.children) {
      c.matrixAutoUpdate = false;
      c.updateMatrix();
    }
  }

  /** Per-frame hill tint (no allocations): horizon colour, sun, 0..1 daylight, 0..1 overcast/rain haze. */
  setHillTint(horizon, sunColor, sunDir, day, haze) {
    const u = this.hillUniforms;
    u.uHorizon.value.copy(horizon);
    u.uSunColor.value.copy(sunColor);
    u.uSunDir.value.copy(sunDir);
    u.uDay.value = day;
    u.uHaze.value = haze;
  }
}
