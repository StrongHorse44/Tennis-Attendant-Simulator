import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';
import { mat, getMaterial, sharedDepthMaterial } from '../graphics/Materials.js';
import { EnvState } from '../graphics/EnvState.js';
import {
  getGeometry, roundedBox as rbox, cylinderGeo, sphereGeo, boxGeo, mergeParts, makeMatrix,
} from '../graphics/GeometryUtils.js';
import { BlobShadows, glowMaterial, hashString } from './CharacterModel.js';

// ───────────────────────────── Geometry builders (cached) ─────────────────────────────
// All in cart-local UNSCALED units (the group is scaled by SIZES.cartScale). Front is -Z.

const WHEEL_R = 0.255;
const WHEEL_POS = [
  [-0.72, WHEEL_R, -0.92], [0.72, WHEEL_R, -0.92], // front (steer)
  [-0.72, WHEEL_R, 0.92], [0.72, WHEEL_R, 0.92],   // rear
];

/** Rounded box, 1 bevel segment by default (props); pass 2 for large visible body panels. */
const roundedBox = (w, h, d, r, seg = 1) => rbox(w, h, d, r, seg);

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** Cylinder part spanning a -> b. */
function span(r, a, b, color, seg = 8) {
  _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _dir.length();
  _dir.divideScalar(len);
  _q.setFromUnitVectors(_up, _dir);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, new THREE.Vector3(1, 1, 1));
  return { geometry: cylinderGeo(r, r, len, seg), matrix: m, color };
}
const P = (geometry, x, y, z, color, rx = 0, ry = 0, rz = 0, s = 1) =>
  ({ geometry, matrix: makeMatrix(x, y, z, ry, s, rx, rz), color });

function buildPaintGeo() {
  const C = COLORS;
  const body = C.golfCartBody;
  const parts = [
    P(roundedBox(1.5, 0.34, 2.5, 0.09, 2), 0, 0.53, 0.05, body),                       // tub
    P(roundedBox(1.52, 0.06, 2.3, 0.02), 0, 0.5, 0.05, C.golfCartAccent),                // side stripe
    P(roundedBox(1.46, 0.52, 0.56, 0.15, 2), 0, 0.8, -1.0, body),                       // front cowl
    P(roundedBox(1.2, 0.07, 0.04, 0.015), 0, 0.64, -1.285, C.golfCartAccent),            // nose band
    P(cylinderGeo(0.085, 0.085, 0.03, 18), 0, 0.88, -1.292, C.clubGold, Math.PI / 2),   // crest
    P(cylinderGeo(0.05, 0.05, 0.02, 14), 0, 0.88, -1.306, C.golfCartAccent, Math.PI / 2),
    P(roundedBox(1.36, 0.3, 0.62, 0.05), 0, 0.8, 0.24, body),                           // seat base
    P(roundedBox(1.5, 0.22, 0.62, 0.08, 2), 0, 0.78, 1.0, body),                        // rear deck
    P(roundedBox(1.52, 0.05, 0.5, 0.02), 0, 0.72, 1.0, C.golfCartAccent),               // rear stripe
  ];
  for (const sx of [-1, 1]) {
    parts.push(P(cylinderGeo(0.088, 0.088, 0.03, 16), sx * 0.47, 0.84, -1.29, C.golfCartRim, Math.PI / 2)); // bezels
    parts.push(P(roundedBox(0.2, 0.12, 0.05, 0.03), sx * 0.58, 0.78, 1.3, C.golfCartFrame));              // tail housings
  }
  return mergeParts(parts);
}

function buildMatteGeo() {
  const C = COLORS;
  const frame = C.golfCartFrame;
  const uph = C.golfCartUpholstery;
  const parts = [
    P(roundedBox(1.3, 0.14, 2.4, 0.04), 0, 0.3, 0.05, frame),                            // chassis rail
    P(roundedBox(1.36, 0.12, 0.14, 0.05), 0, 0.4, -1.34, frame),                          // front bumper
    P(roundedBox(1.42, 0.12, 0.12, 0.04), 0, 0.44, 1.35, frame),                          // rear bumper
    P(roundedBox(1.3, 0.03, 0.66, 0.01), 0, 0.715, -0.42, 0x2A2C2E),                      // floor mat
    P(roundedBox(1.36, 0.17, 0.22, 0.06), 0, 1.1, -0.8, frame),                           // dash
    P(roundedBox(0.36, 0.05, 0.16, 0.02), 0.3, 1.2, -0.8, 0x3A3D40),                      // glovebox lid
    P(roundedBox(1.34, 0.13, 0.58, 0.06), 0, 1.0, 0.22, uph),                             // seat cushion
    P(roundedBox(0.02, 0.14, 0.5, 0.008), 0, 1.0, 0.22, 0xB8A57F),                        // cushion seam
    P(roundedBox(1.34, 0.44, 0.11, 0.05), 0, 1.3, 0.53, uph, 0.12),                        // seat back
    P(roundedBox(0.02, 0.4, 0.115, 0.008), 0, 1.3, 0.53, 0xB8A57F, 0.12),                 // back seam
    P(roundedBox(1.36, 0.05, 0.12, 0.02), 0, 1.53, 0.56, C.golfCartCanopyTrim, 0.12),      // back piping
    // Canopy: roof, cream trim underside, raised rib
    P(roundedBox(1.72, 0.08, 2.26, 0.035), 0, 2.4, -0.13, C.golfCartCanopy),
    P(roundedBox(1.64, 0.04, 2.18, 0.018), 0, 2.345, -0.13, C.golfCartCanopyTrim),
    P(roundedBox(1.46, 0.05, 1.94, 0.024), 0, 2.455, -0.13, 0x26503A),
    // Bag rack platform + tennis bag + ball hopper
    P(roundedBox(1.1, 0.04, 0.46, 0.015), 0, 0.91, 1.06, 0x2A2C2E),
    P(roundedBox(0.72, 0.26, 0.3, 0.12, 2), -0.2, 1.06, 1.06, C.golfCartAccent),
    P(roundedBox(0.74, 0.05, 0.31, 0.02), -0.2, 1.09, 1.06, C.golfCartCanopyTrim),
    P(cylinderGeo(0.03, 0.03, 0.26, 8), -0.2, 1.2, 1.06, 0x1E1F21, 0, 0, Math.PI / 2),      // bag handle
    P(cylinderGeo(0.15, 0.13, 0.28, 12), 0.36, 1.07, 1.06, 0x5A5F64),                       // hopper
    P(cylinderGeo(0.155, 0.155, 0.02, 12), 0.36, 1.21, 1.06, 0x8A9096),                    // hopper rim
  ];
  // Tennis balls peeking out of the hopper
  const balls = [[0.36, 1.06], [0.3, 1.02], [0.42, 1.02], [0.31, 1.11], [0.41, 1.1], [0.36, 1.13]];
  balls.forEach(([x, z], i) => parts.push(P(sphereGeo(0.042, 8, 6), x, 1.22 + (i % 2) * 0.02, z, 0xD4E157)));

  for (const sx of [-1, 1]) {
    // Canopy struts (front struts lean forward slightly, rear straight)
    parts.push(span(0.032, [sx * 0.64, 1.05, -0.8], [sx * 0.68, 2.35, -1.04], frame));
    parts.push(span(0.032, [sx * 0.64, 0.95, 0.66], [sx * 0.68, 2.35, 0.76], frame));
    // Hip restraints / grab handles
    parts.push(span(0.022, [sx * 0.69, 0.95, -0.02], [sx * 0.69, 1.14, 0.1], frame));
    parts.push(span(0.022, [sx * 0.69, 1.14, 0.1], [sx * 0.69, 1.14, 0.42], frame));
    // Bag rack posts
    parts.push(span(0.022, [sx * 0.5, 0.92, 1.3], [sx * 0.5, 1.5, 1.32], frame));
    // Mirror stalk + mirror
    parts.push(span(0.012, [sx * 0.66, 1.62, -0.92], [sx * 0.8, 1.66, -0.93], frame));
    parts.push(P(roundedBox(0.04, 0.09, 0.13, 0.015), sx * 0.82, 1.66, -0.93, 0x1E1F21));
  }
  parts.push(span(0.022, [-0.5, 1.5, 1.32], [0.5, 1.5, 1.32], frame));
  parts.push(span(0.02, [-0.5, 1.2, 1.31], [0.5, 1.2, 1.31], frame));
  parts.push(span(0.02, [-0.66, 2.33, -1.035], [0.66, 2.33, -1.035], frame));                   // windshield header
  parts.push(span(0.03, [-0.34, 1.08, -0.74], [-0.34, 1.26, -0.54], 0x1E1F21));                // steering column
  // Pedals
  parts.push(P(roundedBox(0.1, 0.03, 0.16, 0.01), -0.42, 0.78, -0.62, 0x1E1F21, -0.6));
  parts.push(P(roundedBox(0.1, 0.03, 0.16, 0.01), -0.22, 0.78, -0.62, 0x1E1F21, -0.6));
  return mergeParts(parts);
}

function buildWheelGeo() {
  const C = COLORS;
  const parts = [
    P(new THREE.TorusGeometry(0.18, 0.075, 6, 18), 0, 0, 0, C.golfCartTire, 0, Math.PI / 2),
    P(cylinderGeo(0.185, 0.185, 0.13, 16), 0, 0, 0, 0x2A2B2E, 0, 0, Math.PI / 2),          // sidewall fill
    P(cylinderGeo(0.125, 0.125, 0.145, 16), 0, 0, 0, C.golfCartRim, 0, 0, Math.PI / 2),     // rim
    P(cylinderGeo(0.05, 0.05, 0.16, 10), 0, 0, 0, 0x7C8288, 0, 0, Math.PI / 2),             // hub cap
  ];
  for (let i = 0; i < 5; i++) {                                                              // spokes (both faces)
    const a = (i / 5) * Math.PI * 2;
    for (const sx of [-1, 1]) {
      parts.push(P(roundedBox(0.02, 0.1, 0.03, 0.008), sx * 0.074, Math.cos(a) * 0.08, Math.sin(a) * 0.08, 0x8C9298, a));
    }
  }
  return mergeParts(parts);
}

function buildSteeringGeo() {
  return mergeParts([
    { geometry: new THREE.TorusGeometry(0.15, 0.022, 6, 22), color: 0x1E1F21 },
    P(roundedBox(0.28, 0.03, 0.02, 0.008), 0, 0, 0, 0x2A2C2E),
    P(roundedBox(0.03, 0.14, 0.02, 0.008), 0, -0.07, 0, 0x2A2C2E),
    P(cylinderGeo(0.045, 0.045, 0.04, 12), 0, 0, 0, COLORS.clubGold, Math.PI / 2),
  ]);
}

function buildBrushGeos() {
  const galv = 0x9EA4AA;
  const metal = [
    span(0.03, [0, 0.42, 1.42], [-1.0, 0.2, 3.12], galv),
    span(0.03, [0, 0.42, 1.42], [1.0, 0.2, 3.12], galv),
    span(0.03, [0, 0.42, 1.42], [0, 0.21, 3.12], galv),
    P(sphereGeo(0.055, 10, 8), 0, 0.44, 1.41, 0xC4C8CC),                                    // hitch ball
    P(roundedBox(0.14, 0.08, 0.14, 0.02), 0, 0.42, 1.44, 0x5A5F64),                         // coupler
    P(roundedBox(2.66, 0.06, 0.06, 0.02), 0, 0.2, 3.15, galv),                              // front rail
    P(roundedBox(2.66, 0.06, 0.06, 0.02), 0, 0.2, 3.86, galv),                              // rear rail
    P(roundedBox(0.06, 0.06, 0.77, 0.02), -1.3, 0.2, 3.5, galv),
    P(roundedBox(0.06, 0.06, 0.77, 0.02), 1.3, 0.2, 3.5, galv),
    span(0.018, [-1.3, 0.2, 3.15], [-0.4, 0.2, 3.86], galv),
    span(0.018, [1.3, 0.2, 3.15], [0.4, 0.2, 3.86], galv),
    span(0.018, [-0.4, 0.2, 3.15], [0.4, 0.2, 3.86], galv),
  ];
  for (const sx of [-1, 1]) {
    // Chains to the trailing drag mat
    metal.push(span(0.012, [sx * 1.1, 0.2, 3.87], [sx * 1.1, 0.05, 3.97], 0x4A4E52, 5));
  }

  const soft = [
    P(roundedBox(2.52, 0.06, 0.4, 0.015), 0, 0.15, 3.5, 0x2D5A3D),
    P(roundedBox(2.4, 0.03, 0.2, 0.01), 0, 0.19, 3.5, 0x8A6440),                         // brush board
    P(roundedBox(0.08, 0.16, 0.64, 0.02), -1.29, 0.13, 3.5, 0xE8732A),                      // safety end caps
    P(roundedBox(0.08, 0.16, 0.64, 0.02), 1.29, 0.13, 3.5, 0xE8732A),
    P(roundedBox(2.45, 0.012, 0.55, 0.005), 0, 0.04, 4.22, 0x5B5347),                       // drag mat
  ];
  for (let i = 0; i < 6; i++) {
    soft.push(P(roundedBox(2.45, 0.02, 0.02, 0.005), 0, 0.042, 3.99 + i * 0.09, 0x3F3931));
  }
  // Bristle tufts: 5 rows x 26, slightly jittered straw colours
  const rowsZ = [3.26, 3.38, 3.5, 3.62, 3.74];
  for (let r = 0; r < rowsZ.length; r++) {
    for (let i = 0; i < 26; i++) {
      const x = -1.2 + (i / 25) * 2.4 + (r % 2) * 0.045;
      const hsh = hashString(`b${r}:${i}`);
      const col = hsh < 0.33 ? 0xC9A66B : hsh < 0.66 ? 0xB38E55 : 0xD6B67C;
      soft.push(P(boxGeo(0.075, 0.13, 0.075), x, 0.07, rowsZ[r], col, (hsh - 0.5) * 0.25, 0, (hsh - 0.5) * 0.2));
    }
  }
  return { metal: mergeParts(metal), soft: mergeParts(soft) };
}


// ───────────────────────────── Brush dust trail ─────────────────────────────

const DUST_N = 56;
const _dv = new THREE.Vector3();
const _dsz = new THREE.Vector2();

/** Soft clay-dust puffs kicked up behind the drag brush (one Points draw call, world space). */
class BrushDust {
  constructor(scene) {
    this.pos = new Float32Array(DUST_N * 3);
    this.vel = new Float32Array(DUST_N * 3);
    this.life = new Float32Array(DUST_N).fill(1);
    this.seed = new Float32Array(DUST_N);
    for (let i = 0; i < DUST_N; i++) this.seed[i] = Math.random();
    this.next = 0;
    this.acc = 0;
    this.alive = 0;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aLife', this.lifeAttr);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    const uniforms = {
      uColor: { value: new THREE.Color(0xDDAA82) },
      uScale: { value: 400 },
      uAlpha: { value: 0.5 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */`
        attribute float aLife; attribute float aSeed;
        uniform float uScale;
        varying float vLife; varying float vSeed;
        void main() {
          vLife = aLife; vSeed = aSeed;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float size = (0.35 + aLife * 0.9) * (0.8 + aSeed * 0.5);
          gl_PointSize = aLife >= 1.0 ? 0.0 : size * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uAlpha;
        varying float vLife; varying float vSeed;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          float a = smoothstep(1.0, 0.2, d) * uAlpha * sin(clamp(vLife, 0.0, 1.0) * 3.14159) * (0.7 + 0.3 * vSeed);
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * (0.92 + 0.16 * vSeed), a);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'BrushDust';
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.userData.noAO = true;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer, _s, camera) => {
      renderer.getDrawingBufferSize(_dsz);
      uniforms.uScale.value = _dsz.y / (2 * Math.tan((camera.fov || 50) * Math.PI / 360));
    };
    scene.add(this.points);
  }

  /** @param {THREE.Matrix4} brushMatrix cart matrixWorld; emitRate particles/s (0 = none). */
  update(dt, cartMatrix, emitRate) {
    if (emitRate > 0) {
      this.acc += dt * emitRate;
      while (this.acc >= 1) {
        this.acc -= 1;
        const i = this.next;
        this.next = (this.next + 1) % DUST_N;
        // Random spot along the trailing edge of the bristles (cart-local, unscaled)
        _dv.set((Math.random() - 0.5) * 2.4, 0.08, 3.8 + Math.random() * 0.25).applyMatrix4(cartMatrix);
        this.pos[i * 3] = _dv.x; this.pos[i * 3 + 1] = _dv.y; this.pos[i * 3 + 2] = _dv.z;
        this.vel[i * 3] = (Math.random() - 0.5) * 0.5;
        this.vel[i * 3 + 1] = 0.25 + Math.random() * 0.35;
        this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
        this.life[i] = 0;
      }
    }
    let alive = 0;
    for (let i = 0; i < DUST_N; i++) {
      if (this.life[i] >= 1) continue;
      this.life[i] = Math.min(1, this.life[i] + dt / (1.1 + this.seed[i] * 0.8));
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] *= 1 - dt * 1.5;
      alive++;
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    if (alive > 0 || emitRate > 0) {
      this.posAttr.needsUpdate = true;
      this.lifeAttr.needsUpdate = true;
    }
  }
}

// Reusable temporaries (no per-frame allocations)
const _wm = new THREE.Matrix4();
const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _we = new THREE.Euler(0, 0, 0, 'YXZ');
const _ws = new THREE.Vector3(1, 1, 1);
const _fwd = new CANNON.Vec3();

/**
 * GolfCart - drivable cart with physics
 */
export class GolfCart {
  constructor(scene, physicsWorld, position) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.mesh = null;
    this.body = null;
    this.occupied = false;
    this.steerAngle = 0;
    this.currentSpeed = 0;
    this.engineSound = 0;

    // Brush attachment state
    this.hasBrush = false;
    this.brushMesh = null;
    /** Dust behind the brush: null = auto (brush attached and moving), or force true/false
     *  (e.g. main can set `cart.brushDust = courtMaintenance.isGrooming()` so grass stays clean). */
    this.brushDust = null;
    this._dust = null;

    this._wheelSpin = 0;
    this._lastLight = -1;
    this._roll = 0;
    this._pitch = 0;
    this._prevSpeed = 0;
    this._t = 0;

    this._blobs = BlobShadows.get(scene);
    this._blobSlot = this._blobs.alloc();

    this._createMesh(position);
    this._createPhysics(position);
  }

  _createMesh(pos) {
    this.mesh = new THREE.Group();
    this.mesh.name = 'GolfCart';

    // Everything that rolls/pitches with the suspension lives in bodyGroup (the driver too).
    this.bodyGroup = new THREE.Group();
    this.bodyGroup.name = 'CartBody';
    this.mesh.add(this.bodyGroup);
    this.seatAnchor = this.bodyGroup;

    const paintMat = mat(0xffffff, { vertexColors: true, roughness: 0.38, metalness: 0.05, wet: 0.5, name: 'cartPaint' });
    // Own instance (mat() ignores `name`, so this would alias the courts' matte material,
    // which also feeds InstancedMesh wheels → per-draw program flips)
    const matteMat = getMaterial('cartMatte', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }));

    const paint = new THREE.Mesh(getGeometry('cart-paint', buildPaintGeo), paintMat);
    paint.castShadow = true;
    paint.receiveShadow = true;
    this.bodyGroup.add(paint);

    const matte = new THREE.Mesh(getGeometry('cart-matte', buildMatteGeo), matteMat);
    matte.castShadow = true;
    matte.receiveShadow = true;
    this.bodyGroup.add(matte);

    // Windshield (transparent, no shadow)
    const glass = new THREE.Mesh(
      roundedBox(1.26, 1.22, 0.02, 0.01),
      mat(0xCFE3EE, { transparent: true, opacity: 0.26, roughness: 0.05, metalness: 0, depthWrite: false, envMapIntensity: 1.4, name: 'cartGlass' })
    );
    glass.position.set(0, 1.7, -0.92);
    glass.rotation.x = -0.185;
    glass.renderOrder = 2;
    this.bodyGroup.add(glass);

    // Steering wheel (spins with steering)
    const steerPivot = new THREE.Object3D();
    steerPivot.position.set(-0.34, 1.28, -0.52);
    steerPivot.rotation.x = -0.9;
    const steering = new THREE.Mesh(getGeometry('cart-steer', buildSteeringGeo), matteMat);
    steering.castShadow = true;
    steerPivot.add(steering);
    this.bodyGroup.add(steerPivot);
    this.steeringWheel = steering;

    // Lights: per-cart materials so intensity can follow night/rain
    this.headlightMat = mat(COLORS.golfCartHeadlight, {
      emissive: COLORS.golfCartHeadlight, emissiveIntensity: 0.2, roughness: 0.2, unique: true, name: 'cartHeadlight',
    });
    this.taillightMat = mat(0x8E1C14, {
      emissive: COLORS.golfCartTaillight, emissiveIntensity: 0.15, roughness: 0.3, unique: true, name: 'cartTaillight',
    });
    const headGeo = getGeometry('cart-headlights', () => mergeParts([
      P(cylinderGeo(0.068, 0.068, 0.03, 16), -0.47, 0.84, -1.305, undefined, Math.PI / 2),
      P(cylinderGeo(0.068, 0.068, 0.03, 16), 0.47, 0.84, -1.305, undefined, Math.PI / 2),
    ]));
    const tailGeo = getGeometry('cart-taillights', () => mergeParts([
      P(roundedBox(0.15, 0.08, 0.03, 0.012), -0.58, 0.78, 1.33),
      P(roundedBox(0.15, 0.08, 0.03, 0.012), 0.58, 0.78, 1.33),
    ]));
    this.bodyGroup.add(new THREE.Mesh(headGeo, this.headlightMat));
    this.bodyGroup.add(new THREE.Mesh(tailGeo, this.taillightMat));

    // Headlight pool on the ground (additive, only visible at night / in rain)
    const pool = new THREE.Mesh(
      getGeometry('cart-lightpool', () => new THREE.PlaneGeometry(2.8, 4.6).rotateX(-Math.PI / 2)),
      glowMaterial(0xFFE2A8, 'cartHeadPool').clone()
    );
    pool.position.set(0, 0.06, -3.6);
    pool.visible = false;
    pool.renderOrder = 3;
    pool.userData.noAO = true;
    this.mesh.add(pool);
    this.lightPool = pool;

    // Wheels: one InstancedMesh (spin + front steer set per frame)
    // Instanced → its own material instance (sharing with plain meshes flips `instancing`)
    const wheelMat = getMaterial('cartWheelInst', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }));
    const wheels = new THREE.InstancedMesh(getGeometry('cart-wheel', buildWheelGeo), wheelMat, 4);
    wheels.castShadow = true;
    wheels.receiveShadow = true;
    wheels.customDepthMaterial = sharedDepthMaterial('instanced');
    wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    wheels.frustumCulled = false;
    wheels.userData.dynamic = true;
    this.mesh.add(wheels);
    this.wheelMesh = wheels;
    this.wheels = WHEEL_POS;
    this._updateWheels();

    // Scale down the cart mesh for better proportions relative to courts
    const s = SIZES.cartScale;
    this.mesh.scale.set(s, s, s);

    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(this.mesh);
    this._updateLights(0);
  }

  _createPhysics(pos) {
    const s = SIZES.cartScale;
    const shape = new CANNON.Box(
      new CANNON.Vec3(SIZES.cartWidth / 2 * s, 0.4 * s, SIZES.cartLength / 2 * s)
    );
    this.body = new CANNON.Body({
      mass: 400,
      position: new CANNON.Vec3(pos.x, pos.y + 0.6 * s, pos.z),
      shape,
      linearDamping: 0.3,
      angularDamping: 0.85,
    });
    this.body.material = new CANNON.Material({ friction: GAME.cartFriction });

    // Lock Y-axis rotation to prevent flipping
    this.body.angularFactor = new CANNON.Vec3(0, 1, 0);

    this.physicsWorld.addBody(this.body);
  }

  update(dt, moveInput, isOccupied) {
    this.occupied = isOccupied;
    this._t += dt;
    if (!isOccupied) {
      // Apply brake when not occupied
      this.body.velocity.x *= 0.98;
      this.body.velocity.z *= 0.98;
      this.currentSpeed *= Math.max(0, 1 - 3 * dt);
      if (Math.abs(this.currentSpeed) < 0.01) this.currentSpeed = 0;
      this.steerAngle += (0 - this.steerAngle) * Math.min(1, dt * 3);
      this._animate(dt);
      this._syncMesh();
      return;
    }

    // Wake body in case it went to sleep
    this.body.wakeUp();

    const forward = moveInput.y;
    const steer = moveInput.x;

    // Steering
    this.steerAngle = THREE.MathUtils.lerp(this.steerAngle, -steer * 0.45, Math.min(1, dt * 5));

    // Get cart forward direction (-Z is front/headlights)
    _fwd.set(0, 0, -1);
    this.body.quaternion.vmult(_fwd, _fwd);
    const fwd = _fwd;

    // Drive: track speed internally so ground friction can't eat our velocity
    if (forward < -0.1) {
      // Accelerate forward
      const targetSpeed = SIZES.cartMaxSpeed * Math.abs(forward);
      this.currentSpeed = Math.min(this.currentSpeed + SIZES.cartAcceleration * dt, targetSpeed);
    } else if (forward > 0.1) {
      // Reverse
      const targetSpeed = SIZES.cartMaxSpeed * 0.4 * Math.abs(forward);
      this.currentSpeed = Math.max(this.currentSpeed - SIZES.cartAcceleration * dt * 0.5, -targetSpeed);
    } else {
      // Coast deceleration
      const decay = 1 - 2 * dt;
      this.currentSpeed *= decay;
      if (Math.abs(this.currentSpeed) < 0.01) this.currentSpeed = 0;
    }

    // Apply velocity to physics body
    this.body.velocity.x = fwd.x * this.currentSpeed;
    this.body.velocity.z = fwd.z * this.currentSpeed;

    // Turn (only when moving)
    const absSpeed = Math.abs(this.currentSpeed);
    if (absSpeed > 0.5) {
      const turnForce = this.steerAngle * Math.min(absSpeed, 5) * 0.39;
      this.body.angularVelocity.y = turnForce;
    } else {
      this.body.angularVelocity.y = 0;
    }

    // Keep cart upright
    this.body.quaternion.x *= 0.95;
    this.body.quaternion.z *= 0.95;
    this.body.quaternion.normalize();

    this._animate(dt);
    this._syncMesh();
  }

  /** Visual-only animation: wheels, steering wheel, body roll/pitch, brush judder, lights. */
  _animate(dt) {
    const s = SIZES.cartScale;
    this._wheelSpin -= (this.currentSpeed * dt) / (WHEEL_R * s);
    if (this._wheelSpin > 1e4 || this._wheelSpin < -1e4) this._wheelSpin %= Math.PI * 2;
    this._updateWheels();

    // Steering wheel animation
    this.steeringWheel.rotation.z = this.steerAngle * 2;

    // Suspension: lean out of turns, squat under acceleration
    const accel = dt > 0 ? (this.currentSpeed - this._prevSpeed) / dt : 0;
    this._prevSpeed = this.currentSpeed;
    const targetRoll = -this.steerAngle * Math.min(Math.abs(this.currentSpeed), 7) * 0.012;
    const targetPitch = THREE.MathUtils.clamp(-accel * 0.006, -0.03, 0.03);
    const k = Math.min(1, dt * 6);
    this._roll += (targetRoll - this._roll) * k;
    this._pitch += (targetPitch - this._pitch) * k;
    const bump = Math.sin(this._t * 17) * 0.004 * Math.min(1, Math.abs(this.currentSpeed) / 4);
    this.bodyGroup.rotation.set(this._pitch, 0, this._roll);
    this.bodyGroup.position.y = bump;

    const absSpeed = Math.abs(this.currentSpeed);
    let dustOn = this.brushDust === null ? this.hasBrush : (this.brushDust && this.hasBrush);
    if (dustOn && this.brushDust === null && absSpeed > 1.0) dustOn = this._brushOverClay();
    const rate = dustOn && absSpeed > 1.0 ? 10 + absSpeed * 6 : 0;
    if (rate > 0 && !this._dust) this._dust = new BrushDust(this.scene);
    if (this._dust) this._dust.update(dt, this.mesh.matrixWorld, rate);

    if (this.brushMesh) {
      const sp = Math.min(1, Math.abs(this.currentSpeed) / 5);
      this.brushMesh.position.y = Math.abs(Math.sin(this._t * 23)) * 0.015 * sp;
      this.brushMesh.rotation.z = Math.sin(this._t * 9.3) * 0.008 * sp;
    }

    const night = Math.max(EnvState.nightFactor, EnvState.lampFactor * 0.8);
    this._updateLights(night * (this.occupied ? 1 : 0.2));
  }

  /** Tell the cart where the clay courts are (Box3 list) so brush dust only kicks up on clay. */
  setClayAreas(boxes) {
    this._clayBounds = Array.isArray(boxes) ? boxes : null;
  }

  /** Auto dust gating: is the brush over a clay court (bounds from setClayAreas)? */
  _brushOverClay() {
    if (!this._clayBounds || this._clayBounds.length === 0) return false;
    _dv.set(0, 0, 3.5).applyMatrix4(this.mesh.matrixWorld);
    for (const bx of this._clayBounds) {
      if (_dv.x >= bx.min.x && _dv.x <= bx.max.x && _dv.z >= bx.min.z && _dv.z <= bx.max.z) return true;
    }
    return false;
  }

  _updateWheels() {
    const steer = this.steerAngle * 0.9;
    for (let i = 0; i < 4; i++) {
      const w = WHEEL_POS[i];
      _wp.set(w[0], w[1], w[2]);
      _we.set(this._wheelSpin, i < 2 ? steer : 0, 0, 'YXZ');
      _wq.setFromEuler(_we);
      _wm.compose(_wp, _wq, _ws);
      this.wheelMesh.setMatrixAt(i, _wm);
    }
    this.wheelMesh.instanceMatrix.needsUpdate = true;
  }

  _updateLights(f) {
    if (Math.abs(f - this._lastLight) < 0.01) return;
    this._lastLight = f;
    this.headlightMat.emissiveIntensity = 0.2 + 2.6 * f;
    this.taillightMat.emissiveIntensity = 0.15 + 1.9 * f;
    this.lightPool.material.opacity = 0.32 * f;
    this.lightPool.visible = f > 0.03;
  }

  _syncMesh() {
    const s = SIZES.cartScale;
    this.mesh.position.set(
      this.body.position.x,
      this.body.position.y - 0.4 * s,
      this.body.position.z
    );
    this.mesh.quaternion.set(
      this.body.quaternion.x,
      this.body.quaternion.y,
      this.body.quaternion.z,
      this.body.quaternion.w
    );
    const q = this.body.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    this._blobs.set(this._blobSlot, this.mesh.position.x, this.mesh.position.z,
      SIZES.cartWidth * s * 1.35, SIZES.cartLength * s * 1.2, yaw, Math.max(this.mesh.position.y + 0.02, 0.065));
  }

  attachBrush() {
    if (this.hasBrush) return;
    this.hasBrush = true;

    const geos = getGeometry('cart-brush', buildBrushGeos);
    this.brushMesh = new THREE.Group();
    this.brushMesh.name = 'DragBrush';
    const metal = new THREE.Mesh(geos.metal, mat(0xffffff, { vertexColors: true, roughness: 0.4, metalness: 0.35, name: 'brushMetal' }));
    const soft = new THREE.Mesh(geos.soft, mat(0xffffff, { vertexColors: true, roughness: 0.9, name: 'brushSoft' }));
    metal.castShadow = true;
    soft.castShadow = true;
    soft.receiveShadow = true;
    this.brushMesh.add(metal, soft);

    this.mesh.add(this.brushMesh);
  }

  detachBrush() {
    if (!this.hasBrush || !this.brushMesh) return;
    this.mesh.remove(this.brushMesh);
    this.brushMesh = null;
    this.hasBrush = false;
  }

  /**
   * Get the world position of the brush head center (for grooming calculations).
   */
  getBrushWorldPosition(target) {
    if (!this.hasBrush) return null;
    // Brush is at local Z=3.5 behind the cart (pass `target` to avoid allocating)
    const worldPos = (target || new THREE.Vector3()).set(0, 0.1, 3.5);
    this.mesh.localToWorld(worldPos);
    return worldPos;
  }

  getPosition() {
    return this.mesh.position;
  }

  distanceTo(point) {
    return this.mesh.position.distanceTo(point);
  }
}
