import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';
import { mat, getMaterial, registerWet, registerNightGlow } from '../graphics/Materials.js';
import { Textures, createCanvasTexture, seededRandom } from '../graphics/Textures.js';
import { roundedBox, boxGeo, cylinderGeo, sphereGeo, getGeometry, mergeParts, makeMatrix } from '../graphics/GeometryUtils.js';
import { EnvState } from '../graphics/EnvState.js';

/**
 * Court - tennis court: one shader-painted surface (zones, lines, clay dirt), net, chain-link
 * fence with windscreen, benches, light poles and small props.
 *
 * Draw calls per court: surface, matte props, painted-metal props, chain-link, windscreen,
 * net mesh, sign faces, lamp glass, lamp halos (~9, everything else is merged).
 *
 * Clay grooming API (used by CourtMaintenanceSystem, SaveSystem and match play):
 *   id, config, isClay, gridRows, gridCols (paint-mask size), cellSize, maskBounds,
 *   getDirtAt, groomAt (legacy round stamp), groomStroke (swept brush footprint),
 *   wearAt (localized footwork wear), degradeSurface, getCleanliness, getCoverage,
 *   beginSession, setAllDirt, getMaskData / setMaskData, getHitData / setHitData
 * The paint mask is a gridCols x gridRows RGBA DataTexture over the whole clay pad
 * (GAME.groomMaskRes cells per unit): R = dirt, G = lateral position across the brush
 * (draws the bristle lines along the driven path), B/A = pull direction x stroke strength
 * (lane shading). Scoring (cleanliness / coverage) uses the cells over the 16 x 28 slab.
 */

// ── Visual court layout (court-local units; the 16 x 28 slab stays the physics size) ──
const SURFACE_Y = SIZES.courtSurfaceY ?? 0.15;   // top of the physics box
const HALF_W = 6.2;          // doubles sideline (outer edge)
const HALF_L = 12.3;         // baseline (outer edge)
const SINGLES_W = 4.65;      // singles sideline (outer edge)
const SERVICE_L = 6.62;      // service line distance from net
const LINE_W = 0.08;
const BASELINE_W = 0.12;
const HARD_PAD_EXTRA_X = 2;  // green surround past the 16-wide slab (courts 1 & 2 meet at x=15)
const NET_POST_H = 1.02;     // visual net (physics wall stays SIZES.netHeight)
const NET_CENTER_H = 0.9;
const WIND_TOP = 1.9;        // windscreen height on the fence
const POLE_H = 7;
const CURB_W = 0.12;

// ── Shared per-frame state (lamp glow) ──
const _shared = {
  flood: { value: 0 },
  haloMat: null,
  halos: [],
};

function updateShared() {
  const f = EnvState.lampFactor || 0;
  _shared.flood.value = f;
  if (_shared.haloMat) _shared.haloMat.opacity = f * 0.6;
  const vis = f > 0.02;
  for (let i = 0; i < _shared.halos.length; i++) _shared.halos[i].visible = vis;
}

// ───────────────────────────── Surface shader ─────────────────────────────

const SURFACE_VERT_HEAD = /* glsl */`
varying vec2 vCourtWorld;
`;
const SURFACE_VERT_BODY = /* glsl */`
vCourtWorld = (modelMatrix * vec4(transformed, 1.0)).xz;
`;

const SURFACE_FRAG_HEAD = /* glsl */`
varying vec2 vCourtWorld;
uniform vec2 uCenter;
uniform vec4 uCourt;      // doubles half-width, half-length, singles half-width, service line
uniform vec2 uLW;         // line width, baseline width
uniform vec3 uLineColor;
uniform vec3 uInner;
uniform vec3 uOuter;
uniform sampler2D uBaseMap;
uniform sampler2D uNoiseMap;
uniform float uBaseScale;
uniform float uFlood;
#ifdef COURT_CLAY
uniform sampler2D uDirtMap;
uniform vec4 uGrid;       // mask min x/z (court-local), mask size x/z
uniform vec2 uStripe;     // bristle lines across the brush, brush width
#endif

float courtRect(vec2 q, vec2 c, vec2 h, vec2 fw) {
  vec2 d = abs(q - c) - h;
  vec2 m = 1.0 - smoothstep(-fw, fw, d);
  return m.x * m.y;
}

float courtLines(vec2 p, vec2 fw) {
  vec2 q = abs(p);
  float HW = uCourt.x, HL = uCourt.y, SW = uCourt.z, SL = uCourt.w;
  float lw = uLW.x * 0.5, bw = uLW.y * 0.5;
  float m = courtRect(q, vec2(HW * 0.5, HL - bw), vec2(HW * 0.5, bw), fw);   // baselines
  m = max(m, courtRect(q, vec2(HW - lw, HL * 0.5), vec2(lw, HL * 0.5), fw)); // doubles sidelines
  m = max(m, courtRect(q, vec2(SW - lw, HL * 0.5), vec2(lw, HL * 0.5), fw)); // singles sidelines
  m = max(m, courtRect(q, vec2(SW * 0.5, SL), vec2(SW * 0.5, lw), fw));      // service lines
  m = max(m, courtRect(q, vec2(0.0, SL * 0.5), vec2(lw, SL * 0.5), fw));     // centre service line
  m = max(m, courtRect(q, vec2(0.0, HL - 0.2), vec2(lw, 0.2), fw));          // centre marks
  return m;
}
`;

const SURFACE_FRAG_BODY = /* glsl */`
{
  vec2 cw = vCourtWorld;
  vec2 p = cw - uCenter;
  vec2 fw = max(fwidth(p) * 0.75, vec2(1e-4));
  float lineM = courtLines(p, fw);
  vec3 base = texture2D(uBaseMap, cw * uBaseScale).rgb;
  float nLarge = texture2D(uNoiseMap, cw * 0.037).r;
  float nMid = texture2D(uNoiseMap, cw * 0.19 + 0.31).r;
  // player wear behind the baselines
  vec2 wq = vec2(p.x / 3.2, (abs(p.y) - uCourt.y - 0.2) / 1.5);
  float wear = exp(-dot(wq, wq)) * (0.5 + 0.5 * nMid);
  vec3 col;
#ifdef COURT_CLAY
  vec2 warp = vec2(texture2D(uNoiseMap, cw * 0.23 + 0.7).r, texture2D(uNoiseMap, cw * 0.23 + 0.2).r) - 0.5;
  vec4 dt = texture2D(uDirtMap, (p + warp * 0.16 - uGrid.xy) / uGrid.zw);
  float dirt = clamp(dt.r + wear * 0.2, 0.0, 1.0);
  float dk = smoothstep(0.02, 0.55, dirt);
  // Brush strokes: G = lateral position across the brush, BA = pull direction * strength
  vec2 sdir = dt.ba * 2.0 - 1.0;
  float sLen = length(sdir);
  float sStr = clamp(sLen * 1.05 - 0.05, 0.0, 1.0);
  float fresh = sStr * (1.0 - dk);
  vec2 sN = sdir / max(sLen, 1e-3);
  // bristle lines follow the driven path (curves included)
  float lu = dt.g * uStripe.x;
  float lAA = 1.0 - smoothstep(0.3, 0.8, fwidth(lu));
  float lines = sin((lu + (nMid - 0.5) * 0.35) * 6.2832) * 0.7 + sin((lu * 2.41 + nLarge * 3.0) * 6.2832) * 0.3;
  // lane seams (the lateral coordinate jumps where one pass overwrote another) + lane edges
  float seamR = fwidth(dt.g) * uStripe.y / max(max(fw.x, fw.y) * 1.3333, 1e-5);
  float seam = smoothstep(2.5, 6.0, seamR);
  float edge = 1.0 - smoothstep(0.0, 0.05, min(dt.g, 1.0 - dt.g));
  float berm = max(seam, edge) * fresh;
  // mowing-style lanes: pulled toward / away from the viewer read lighter / darker
  vec2 toCam = cameraPosition.xz - cw;
  float lane = dot(sN, toCam / max(length(toCam), 1e-3));
  vec3 clean = base * vec3(1.12, 1.07, 1.04) * (0.98 + 0.04 * nLarge);
  clean *= 1.0 + fresh * (0.05 + 0.09 * lane + 0.08 * lines * lAA) - 0.14 * berm;
  // scuffed clay: darker blotches, footwork slides kicking up loose (lighter) clay
  float scuff = smoothstep(0.4, 0.72, texture2D(uNoiseMap, cw * 0.55 + 0.13).r);
  float slide = smoothstep(0.58, 0.8, texture2D(uNoiseMap, vec2(cw.x * 1.7, cw.y * 0.28)).r);
  float speck = smoothstep(0.62, 0.78, texture2D(uNoiseMap, cw * 2.9 + 0.41).r);
  vec3 dirty = base * mix(vec3(0.84, 0.77, 0.75), vec3(0.62, 0.52, 0.5), scuff) * (0.86 + 0.16 * nLarge);
  dirty *= 1.0 - 0.12 * speck;
  dirty = mix(dirty, base * vec3(1.1, 1.03, 0.96), slide * 0.45);
  col = mix(clean, dirty, dk);
  // white tape, dusted with clay when the court needs grooming
  vec3 lineCol = mix(uLineColor, base * 1.1, 0.1 + 0.5 * dk);
  col = mix(col, lineCol * (0.94 + 0.06 * nMid), lineM);
#else
  float inside = courtRect(abs(p), vec2(0.0), uCourt.xy, fw);
  col = mix(uOuter, uInner, inside) * base;
  col *= 0.9 + 0.2 * nLarge;
  col *= 0.97 + 0.06 * nMid;
  col = mix(col, col * 1.14 + 0.015, wear * 0.4 * inside);
  col = mix(col, uLineColor * (0.95 + 0.05 * base.r), lineM);
#endif
  diffuseColor.rgb *= col;
  // floodlights at night: a soft lit pool over the court
  vec2 fq = p / (uCourt.xy + vec2(3.0, 3.0));
  float pool = 1.0 - smoothstep(0.55, 1.25, length(fq));
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.96, 0.9) * (pool * uFlood * 0.6);
}
`;

function createSurfaceMaterial(isClay, uniforms) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: isClay ? 0.95 : 0.6,
    metalness: 0,
  });
  m.name = isClay ? 'courtSurfaceClay' : 'courtSurfaceHard';
  if (isClay) m.defines = { COURT_CLAY: '' };
  m.customProgramCacheKey = () => (isClay ? 'court-surface-clay' : 'court-surface-hard');
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SURFACE_VERT_HEAD)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + SURFACE_VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SURFACE_FRAG_HEAD)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SURFACE_FRAG_BODY);
  };
  // Hard courts: a deeper, wetter blue in rain instead of a grey-sky wash (lilac)
  if (isClay) registerWet(m, 0.7);
  else registerWet(m, 0.6, { tint: new THREE.Color(0.86, 0.96, 1.12), wetEnv: 0.5 });
  return m;
}

// ───────────────────────────── Shared textures ─────────────────────────────

function windscreenTexture() {
  return createCanvasTexture(1024, (ctx, w, rand, h) => {
    ctx.fillStyle = '#1f4a34';
    ctx.fillRect(0, 0, w, h);
    // fabric weave
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#000000';
    for (let x = 0; x < w; x += 3) ctx.fillRect(x, 0, 1, h);
    ctx.fillStyle = '#ffffff';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    ctx.globalAlpha = 1;
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(rand() * w, rand() * h, 2 + rand() * 30, 1 + rand() * 2);
    }
    // hems + grommets
    const hem = Math.round(h * 0.09);
    ctx.fillStyle = '#163826';
    ctx.fillRect(0, 0, w, hem);
    ctx.fillRect(0, h - hem, w, hem);
    ctx.fillStyle = '#c9c2a8';
    for (let x = 24; x < w; x += 64) {
      for (const y of [hem / 2, h - hem / 2]) {
        ctx.beginPath();
        ctx.arc(x, y, h * 0.018, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // club lettering
    ctx.fillStyle = 'rgba(244,232,193,0.78)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(h * 0.26)}px Georgia, "Times New Roman", serif`;
    ctx.fillText('GREENBRIAR', w * 0.5, h * 0.46);
    ctx.font = `${Math.round(h * 0.1)}px Georgia, "Times New Roman", serif`;
    ctx.fillStyle = 'rgba(244,232,193,0.6)';
    ctx.fillText('TENNIS  &  SOCIAL  CLUB', w * 0.5, h * 0.68);
    ctx.fillRect(w * 0.14, h * 0.5 - 1, w * 0.16, 2);
    ctx.fillRect(w * 0.7, h * 0.5 - 1, w * 0.16, 2);
  }, { key: 'courtWindscreen', height: 256, seed: 7 });
}

const SIGN_COLS = 5;
const SIGN_ROWS = 2;
function signAtlas() {
  return createCanvasTexture(1024, (ctx, w, rand, h) => {
    const cw = w / SIGN_COLS, ch = h / SIGN_ROWS;
    for (let i = 0; i < SIGN_COLS * SIGN_ROWS; i++) {
      const x = (i % SIGN_COLS) * cw, y = Math.floor(i / SIGN_COLS) * ch;
      ctx.fillStyle = '#2d5a3d';
      ctx.fillRect(x, y, cw, ch);
      ctx.strokeStyle = '#f4e8c1';
      ctx.lineWidth = ch * 0.045;
      ctx.strokeRect(x + ch * 0.08, y + ch * 0.08, cw - ch * 0.16, ch - ch * 0.16);
      ctx.fillStyle = '#f4e8c1';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(ch * 0.17)}px Georgia, "Times New Roman", serif`;
      ctx.fillText('COURT', x + cw / 2, y + ch * 0.3);
      ctx.font = `bold ${Math.round(ch * 0.46)}px Georgia, "Times New Roman", serif`;
      ctx.fillText(String(i + 1), x + cw / 2, y + ch * 0.64);
    }
  }, { key: 'courtSignAtlas', height: 256, wrap: THREE.ClampToEdgeWrapping });
}

// ───────────────────────────── Shared materials ─────────────────────────────

function sharedMaterials() {
  return {
    matte: mat(0xffffff, { vertexColors: true, roughness: 0.78 }),
    metal: mat(0xffffff, { vertexColors: true, roughness: 0.45, metalness: 0.35 }),
    chainLink: getMaterial('courtChainLink', () => new THREE.MeshStandardMaterial({
      color: 0x456f55,
      map: Textures.chainLink(),
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true, // one draw (not back+front) and no per-draw program flip
      roughness: 0.55,
      metalness: 0.3,
    })),
    net: getMaterial('courtNetMesh', () => new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: Textures.tennisNet(),
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      roughness: 0.9,
    })),
    windscreen: mat(0xffffff, { map: windscreenTexture(), roughness: 0.92 }),
    sign: mat(0xffffff, { map: signAtlas(), roughness: 0.7 }),
    lampGlass: getMaterial('courtLampGlass', () => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xd8dcd8,
        roughness: 0.3,
        metalness: 0.1,
        emissive: new THREE.Color(COLORS.courtLampGlow),
        emissiveIntensity: 0,
      });
      registerNightGlow(m, 3.2, 0);
      return m;
    }),
  };
}

function haloMaterial() {
  if (!_shared.haloMat) {
    _shared.haloMat = new THREE.PointsMaterial({
      color: 0xffe3b5,
      map: Textures.radialBlob(),
      size: 2.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    _shared.haloMat.name = 'courtLampHalo';
  }
  return _shared.haloMat;
}

// Plane geometry with UVs scaled in world units (for tiling on merged meshes)
function tiledPlane(w, h, uScale, vScale, uOffset = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * uScale + uOffset, uv.getY(i) * vScale);
  }
  return g;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const _m4 = new THREE.Matrix4();

const MASK_RES = GAME.groomMaskRes || 4;
const TAU = Math.PI * 2;
const LEGACY_COLS = 8;       // pre-mask saves: 8 x 14 cells of 2 units over the 16 x 28 slab
const LEGACY_ROWS = 14;

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  }
  return btoa(s);
}

function b64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Court - tennis court with surface, lines, net, fencing, and benches
 */
export class Court {
  constructor(scene, physicsWorld, config) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.config = config;
    this.mesh = new THREE.Group();
    this.mesh.name = `court:${config.id}`;
    this.id = config.id;
    this.isClay = config.type === 'clay';
    this._pad = this._computePad();

    // Paint mask for clay court maintenance (see the header comment)
    this.gridCols = 0;
    this.gridRows = 0;
    this.cellSize = 1 / MASK_RES;
    this.maskBounds = null;     // world-space { x0, z0, x1, z1 } covered by the mask
    this.dirt = null;           // Float32Array per cell (0 = clean, 1 = dirty)
    this.mask = null;           // Uint8Array RGBA (the DataTexture's data)
    this.hit = null;            // Uint8Array per cell: brushed during the current session
    this.dirtTexture = null;
    this.surfaceMesh = null;    // shader-painted court surface
    this.scoreCells = 0;        // cells over the playing slab (cleanliness / coverage)
    this._hitCount = 0;
    this._cleanCache = -1;
    this._lastGroom = null;     // last groomAt position (legacy stamp direction)

    if (this.isClay) this._buildMask();

    this._build();
    this.scene.add(this.mesh);
  }

  // ───────────────────────────── Paint mask: queries ─────────────────────────────

  /** Mask cell index at a world position, or -1 outside the mask. */
  cellIndexAt(worldX, worldZ) {
    const B = this.maskBounds;
    if (!B) return -1;
    const c = Math.floor((worldX - B.x0) * MASK_RES);
    const r = Math.floor((worldZ - B.z0) * MASK_RES);
    if (c < 0 || c >= this.gridCols || r < 0 || r >= this.gridRows) return -1;
    return r * this.gridCols + c;
  }

  /** Dirtiness (0..1) at a world position. Returns -1 if outside the clay mask. */
  getDirtAt(worldX, worldZ) {
    const i = this.cellIndexAt(worldX, worldZ);
    return i < 0 ? -1 : this.dirt[i];
  }

  /** Overall cleanliness of the playing slab (0 = all dirty, 1 = all clean). Cached until the mask changes. */
  getCleanliness() {
    if (!this.dirt) return 1;
    if (this._cleanCache >= 0) return this._cleanCache;
    const cols = this.gridCols;
    let total = 0;
    for (let r = this._sr0; r <= this._sr1; r++) {
      const row = r * cols;
      for (let c = this._sc0; c <= this._sc1; c++) total += this.dirt[row + c];
    }
    this._cleanCache = this.scoreCells > 0 ? 1 - total / this.scoreCells : 1;
    return this._cleanCache;
  }

  /** Fraction (0..1) of the playing slab brushed since beginSession(). */
  getCoverage() {
    return this.scoreCells > 0 ? this._hitCount / this.scoreCells : 0;
  }

  /** Brushed cell count over the playing slab since beginSession(). */
  getHitCount() {
    return this._hitCount;
  }

  /** Start a grooming session: clears the brushed-cells mask used for coverage. */
  beginSession() {
    if (!this.hit) return;
    this.hit.fill(0);
    this._hitCount = 0;
  }

  // ───────────────────────────── Paint mask: painting ─────────────────────────────

  /**
   * Sweep the brush footprint (a width x depth rectangle facing (hx, hz), the direction
   * the brush is pulled) from (ax, az) to (bx, bz) — gapless however far it moved this
   * frame. Cleans by `GAME.groomPassClean * strength` per full pass, writes the stroke
   * (lateral position + pull direction) for the drag stripes and marks cells as brushed.
   * Returns the number of cells under the footprint (0 when it isn't on this court).
   */
  groomStroke(ax, az, bx, bz, hx, hz, width, depth, strength = 1) {
    const B = this.maskBounds;
    if (!B) return 0;
    const hw = width * 0.5, hd = depth * 0.5, R = hw + hd;
    const minX = Math.min(ax, bx) - R, maxX = Math.max(ax, bx) + R;
    const minZ = Math.min(az, bz) - R, maxZ = Math.max(az, bz) + R;
    if (maxX < B.x0 || minX > B.x1 || maxZ < B.z0 || minZ > B.z1) return 0;

    const sx = bx - ax, sz = bz - az;
    const segL2 = sx * sx + sz * sz;
    const segL = Math.sqrt(segL2);
    let hl = Math.sqrt(hx * hx + hz * hz);
    if (hl < 1e-6) {
      if (segL < 1e-6) return 0;
      hx = sx; hz = sz; hl = segL;
    }
    hx /= hl; hz /= hl;
    const nx = -hz, nz = hx;                     // lateral axis across the brush
    const s = clamp01(strength);
    const clean = GAME.groomPassClean * s * Math.min(1, segL / Math.max(0.05, depth));
    const vis = 0.35 + 0.65 * s;                 // stroke strength drawn (fast = faint, torn)
    const gB = Math.round(128 + 127 * hx * vis);
    const gA = Math.round(128 + 127 * hz * vis);

    const cols = this.gridCols;
    const c0 = Math.max(0, Math.floor((minX - B.x0) * MASK_RES));
    const c1 = Math.min(cols - 1, Math.floor((maxX - B.x0) * MASK_RES));
    const r0 = Math.max(0, Math.floor((minZ - B.z0) * MASK_RES));
    const r1 = Math.min(this.gridRows - 1, Math.floor((maxZ - B.z0) * MASK_RES));
    const inv = 1 / MASK_RES;
    const mask = this.mask, dirt = this.dirt, hit = this.hit;
    let covered = 0;

    for (let r = r0; r <= r1; r++) {
      const cz = B.z0 + (r + 0.5) * inv;
      const inRow = r >= this._sr0 && r <= this._sr1;
      for (let c = c0; c <= c1; c++) {
        const cx = B.x0 + (c + 0.5) * inv;
        let t = 0;
        if (segL2 > 1e-8) {
          t = ((cx - ax) * sx + (cz - az) * sz) / segL2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
        }
        const rx = cx - (ax + sx * t), rz = cz - (az + sz * t);
        const lat = rx * nx + rz * nz;
        if (lat > hw || lat < -hw) continue;
        const lon = rx * hx + rz * hz;
        if (lon > hd || lon < -hd) continue;
        const i = r * cols + c;
        const k = i * 4;
        covered++;
        mask[k + 1] = Math.round((lat / width + 0.5) * 255);
        mask[k + 2] = gB;
        mask[k + 3] = gA;
        if (clean > 0 && dirt[i] > 0) this._setDirt(i, dirt[i] - clean);
        if (!hit[i]) {
          hit[i] = 1;
          if (inRow && c >= this._sc0 && c <= this._sc1) this._hitCount++;
        }
      }
    }
    if (covered > 0) this.dirtTexture.needsUpdate = true;
    return covered;
  }

  /**
   * Legacy round stamp: clean cells within `radius` of a world position (0.15 per call)
   * and mark them brushed. Prefer groomStroke(). Returns the number of cells cleaned.
   */
  groomAt(worldX, worldZ, radius) {
    const B = this.maskBounds;
    if (!B) return 0;
    let hx = 0, hz = -1;
    const last = this._lastGroom;
    if (last) {
      const mx = worldX - last.x, mz = worldZ - last.z;
      const l2 = mx * mx + mz * mz;
      if (l2 > 0.0004 && l2 < 6.25) { const l = Math.sqrt(l2); hx = mx / l; hz = mz / l; }
      last.x = worldX; last.z = worldZ;
    } else {
      this._lastGroom = { x: worldX, z: worldZ };
    }
    let affected = 0;
    this._forCellsInRadius(worldX, worldZ, radius, (i, dx, dz) => {
      const k = i * 4;
      const lat = dx * -hz + dz * hx;
      this.mask[k + 1] = Math.round(clamp01(lat / (2 * radius) + 0.5) * 255);
      this.mask[k + 2] = Math.round(128 + 127 * hx);
      this.mask[k + 3] = Math.round(128 + 127 * hz);
      this._markHit(i);
      if (this.dirt[i] <= 0) return;
      this._setDirt(i, this.dirt[i] - 0.15);
      affected++;
    });
    this.dirtTexture.needsUpdate = true;
    return affected;
  }

  /**
   * Localized wear (footwork, sliding, a dropped hopper...): adds up to `amount` dirt
   * with a soft falloff inside `radius` world units of (x, z) and scuffs the drag stripes
   * there. Safe to call every frame; no allocations. Returns the number of cells touched.
   * @param {number} x world X
   * @param {number} z world Z
   * @param {number} [radius=0.6] world units
   * @param {number} [amount=0.05] dirt added at the centre (0..1)
   */
  wearAt(x, z, radius = 0.6, amount = 0.05) {
    const B = this.maskBounds;
    if (!B || !(radius > 0) || !(amount > 0)) return 0;
    if (x + radius < B.x0 || x - radius > B.x1 || z + radius < B.z0 || z - radius > B.z1) return 0;
    const r2 = radius * radius;
    const cols = this.gridCols, inv = 1 / MASK_RES;
    const c0 = Math.max(0, Math.floor((x - radius - B.x0) * MASK_RES));
    const c1 = Math.min(cols - 1, Math.floor((x + radius - B.x0) * MASK_RES));
    const r0 = Math.max(0, Math.floor((z - radius - B.z0) * MASK_RES));
    const r1 = Math.min(this.gridRows - 1, Math.floor((z + radius - B.z0) * MASK_RES));
    const mask = this.mask;
    let n = 0;
    for (let r = r0; r <= r1; r++) {
      const dz = B.z0 + (r + 0.5) * inv - z;
      for (let c = c0; c <= c1; c++) {
        const dx = B.x0 + (c + 0.5) * inv - x;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const f = 1 - d2 / r2;
        const i = r * cols + c, k = i * 4;
        this._setDirt(i, this.dirt[i] + amount * f);
        const keep = 1 - Math.min(1, amount * f * 5);
        mask[k + 2] = Math.round(128 + (mask[k + 2] - 128) * keep);
        mask[k + 3] = Math.round(128 + (mask[k + 3] - 128) * keep);
        n++;
      }
    }
    if (n > 0) this.dirtTexture.needsUpdate = true;
    return n;
  }

  /** Add dirt to every cell (play degradation over time). */
  degradeSurface(amount) {
    if (!this.dirt) return;
    for (let i = 0; i < this.dirt.length; i++) this._setDirt(i, this.dirt[i] + amount);
    this.dirtTexture.needsUpdate = true;
  }

  /** Set every cell to a given dirtiness level (keeps the stroke pattern). */
  setAllDirt(level) {
    if (!this.dirt) return;
    const v = clamp01(Number(level) || 0);
    for (let i = 0; i < this.dirt.length; i++) this._setDirt(i, v);
    this.dirtTexture.needsUpdate = true;
  }

  // ───────────────────────────── Paint mask: save / load ─────────────────────────────

  /**
   * Compact snapshot for saves: `v2:<cols>x<rows>:<base64>`, 3 bytes per cell (row-major):
   * dirt (0..255), lateral stroke position (0..255), and the stroke direction packed as
   * (64-step angle << 2) | strength 1..3, or 0 for an unbrushed cell.
   */
  getMaskData() {
    if (!this.mask) return '';
    const n = this.gridCols * this.gridRows;
    const out = new Uint8Array(n * 3);
    const m = this.mask;
    for (let i = 0; i < n; i++) {
      const k = i * 4, o = i * 3;
      out[o] = m[k];
      out[o + 1] = m[k + 1];
      const dx = (m[k + 2] - 128) / 127, dz = (m[k + 3] - 128) / 127;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.08) { out[o + 2] = 0; continue; }
      let a = Math.atan2(dz, dx);
      if (a < 0) a += TAU;
      const q = Math.round((a / TAU) * 64) & 63;
      const st = Math.max(1, Math.min(3, Math.round(len * 3)));
      out[o + 2] = (q << 2) | st;
    }
    return `v2:${this.gridCols}x${this.gridRows}:${bytesToB64(out)}`;
  }

  /**
   * Restore a getMaskData() snapshot, or a pre-mask save's 8 x 14 hex grid (6 or 2 hex
   * chars per cell), which is upsampled. Returns false (and changes nothing) when the
   * data doesn't fit this court.
   */
  setMaskData(data) {
    if (!this.mask || typeof data !== 'string' || !data) return false;
    if (data.startsWith('v2:')) {
      const m = /^v2:(\d+)x(\d+):([A-Za-z0-9+/=]+)$/.exec(data);
      if (!m || +m[1] !== this.gridCols || +m[2] !== this.gridRows) return false;
      let bytes;
      try { bytes = b64ToBytes(m[3]); } catch (e) { return false; }
      const n = this.gridCols * this.gridRows;
      if (bytes.length !== n * 3) return false;
      const mask = this.mask;
      for (let i = 0; i < n; i++) {
        const o = i * 3, k = i * 4;
        this.dirt[i] = bytes[o] / 255;
        mask[k] = bytes[o];
        mask[k + 1] = bytes[o + 1];
        const d = bytes[o + 2];
        if (d === 0) { mask[k + 2] = 128; mask[k + 3] = 128; continue; }
        const a = ((d >> 2) / 64) * TAU, st = (d & 3) / 3;
        mask[k + 2] = Math.round(128 + 127 * Math.cos(a) * st);
        mask[k + 3] = Math.round(128 + 127 * Math.sin(a) * st);
      }
      this._cleanCache = -1;
      this.dirtTexture.needsUpdate = true;
      return true;
    }
    return this.setGridHex(data);
  }

  /** Pre-mask save format (8 x 14 cells, 6 or 2 hex chars each): bilinear upsample. */
  setGridHex(hex) {
    if (!this.mask || typeof hex !== 'string') return false;
    const cells = LEGACY_COLS * LEGACY_ROWS;
    const per = hex.length === cells * 6 ? 6 : hex.length === cells * 2 ? 2 : 0;
    if (!per || !/^[0-9a-f]*$/i.test(hex)) return false;
    const old = new Float32Array(cells);
    for (let k = 0; k < cells; k++) old[k] = parseInt(hex.substr(k * per, 2), 16) / 255;
    const hwS = SIZES.courtWidth / 2, hdS = SIZES.courtDepth / 2;
    const lane = GAME.groomBrushWidth || 3;
    const cols = this.gridCols, p = this._pad, inv = 1 / MASK_RES;
    for (let r = 0; r < this.gridRows; r++) {
      const lz = p.z0 + (r + 0.5) * inv;
      const fz = Math.max(0, Math.min(LEGACY_ROWS - 1, (lz + hdS) / 2 - 0.5));
      const z0 = Math.min(LEGACY_ROWS - 2, Math.floor(fz)), tz = fz - z0;
      for (let c = 0; c < cols; c++) {
        const lx = p.x0 + (c + 0.5) * inv;
        const fx = Math.max(0, Math.min(LEGACY_COLS - 1, (lx + hwS) / 2 - 0.5));
        const x0 = Math.min(LEGACY_COLS - 2, Math.floor(fx)), tx = fx - x0;
        const a = old[z0 * LEGACY_COLS + x0], b = old[z0 * LEGACY_COLS + x0 + 1];
        const cc = old[(z0 + 1) * LEGACY_COLS + x0], d = old[(z0 + 1) * LEGACY_COLS + x0 + 1];
        const v = (a + (b - a) * tx) * (1 - tz) + (cc + (d - cc) * tx) * tz;
        const i = r * cols + c, k = i * 4;
        this.dirt[i] = v;
        this.mask[k] = Math.round(clamp01(v) * 255);
        // Old saves kept only an axis per cell: a groomed court gets up-and-back lanes
        if (v < 0.4) {
          const ul = (lx + hwS) / lane;
          const li = Math.floor(ul);
          const hz = (li & 1) ? 1 : -1;
          const st = 1 - v / 0.4;
          this.mask[k + 1] = Math.round((ul - li) * 255);
          this.mask[k + 2] = 128;
          this.mask[k + 3] = Math.round(128 + 127 * hz * st);
        } else {
          this.mask[k + 1] = 128; this.mask[k + 2] = 128; this.mask[k + 3] = 128;
        }
      }
    }
    this._cleanCache = -1;
    this.dirtTexture.needsUpdate = true;
    return true;
  }

  /** Session brushed-cells mask as base64 bits (row-major over the whole mask). */
  getHitData() {
    if (!this.hit) return '';
    const n = this.hit.length;
    const bytes = new Uint8Array((n + 7) >> 3);
    for (let i = 0; i < n; i++) if (this.hit[i]) bytes[i >> 3] |= 1 << (i & 7);
    return bytesToB64(bytes);
  }

  /**
   * Restore getHitData(), or a pre-mask save's list of 8 x 14 cell indices (each marks
   * the 2 x 2 unit block it covered). Returns the brushed slab cell count.
   */
  setHitData(data) {
    if (!this.hit) return 0;
    this.beginSession();
    const n = this.hit.length;
    if (typeof data === 'string' && data) {
      let bytes;
      try { bytes = b64ToBytes(data); } catch (e) { return 0; }
      if (bytes.length !== ((n + 7) >> 3)) return 0;
      for (let i = 0; i < n; i++) if (bytes[i >> 3] & (1 << (i & 7))) this._markHit(i);
    } else if (Array.isArray(data)) {
      const B = this.maskBounds, { center } = this.config;
      const x0 = center.x - SIZES.courtWidth / 2, z0 = center.z - SIZES.courtDepth / 2;
      for (const cell of data) {
        if (!Number.isInteger(cell) || cell < 0 || cell >= LEGACY_COLS * LEGACY_ROWS) continue;
        const cx0 = x0 + (cell % LEGACY_COLS) * 2, cz0 = z0 + Math.floor(cell / LEGACY_COLS) * 2;
        const cA = Math.max(0, Math.ceil((cx0 - B.x0) * MASK_RES - 0.5));
        const cB = Math.min(this.gridCols - 1, Math.floor((cx0 + 2 - B.x0) * MASK_RES - 0.5 - 1e-6));
        const rA = Math.max(0, Math.ceil((cz0 - B.z0) * MASK_RES - 0.5));
        const rB = Math.min(this.gridRows - 1, Math.floor((cz0 + 2 - B.z0) * MASK_RES - 0.5 - 1e-6));
        for (let r = rA; r <= rB; r++) for (let c = cA; c <= cB; c++) this._markHit(r * this.gridCols + c);
      }
    }
    return this._hitCount;
  }

  /** Debug/summary: draw the slab's dirt (and brushed cells) into a 2D context at (ox, oy), `px` pixels per cell. */
  drawHeatmap(ctx, ox, oy, px = 1) {
    if (!this.dirt || !ctx) return;
    const cols = this.gridCols;
    const w = this._sc1 - this._sc0 + 1, h = this._sr1 - this._sr0 + 1;
    const img = ctx.createImageData(w, h);
    const d = img.data;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = (r + this._sr0) * cols + (c + this._sc0);
        const v = clamp01(this.dirt[i]);
        const o = (r * w + c) * 4;
        // clean → fresh clay orange, dirty → dark scuffed brown, never brushed → dimmed
        const dim = this.hit[i] ? 1 : 0.8;
        d[o] = (226 - 110 * v) * dim;
        d[o + 1] = (120 - 60 * v) * dim;
        d[o + 2] = (72 - 30 * v) * dim;
        d[o + 3] = 255;
      }
    }
    if (px === 1) { ctx.putImageData(img, ox, oy); return; }
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, ox, oy, w * px, h * px);
  }

  // ───────────────────────────── Paint mask: internals ─────────────────────────────

  _setDirt(i, v) {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    if (this.dirt[i] === v) return;
    this.dirt[i] = v;
    this._cleanCache = -1;
    this.mask[i * 4] = (v * 255 + 0.5) | 0;
  }

  _markHit(i) {
    if (this.hit[i]) return;
    this.hit[i] = 1;
    const r = (i / this.gridCols) | 0, c = i - r * this.gridCols;
    if (r >= this._sr0 && r <= this._sr1 && c >= this._sc0 && c <= this._sc1) this._hitCount++;
  }

  _forCellsInRadius(x, z, radius, fn) {
    const B = this.maskBounds, inv = 1 / MASK_RES, r2 = radius * radius;
    const c0 = Math.max(0, Math.floor((x - radius - B.x0) * MASK_RES));
    const c1 = Math.min(this.gridCols - 1, Math.floor((x + radius - B.x0) * MASK_RES));
    const r0 = Math.max(0, Math.floor((z - radius - B.z0) * MASK_RES));
    const r1 = Math.min(this.gridRows - 1, Math.floor((z + radius - B.z0) * MASK_RES));
    for (let r = r0; r <= r1; r++) {
      const dz = z - (B.z0 + (r + 0.5) * inv);
      for (let c = c0; c <= c1; c++) {
        const dx = x - (B.x0 + (c + 0.5) * inv);
        if (dx * dx + dz * dz < r2) fn(r * this.gridCols + c, -dx, -dz);
      }
    }
  }

  /** Pad extents (court-local). Hard: blue court + green surround; clay: slab + side buffers. */
  _computePad() {
    const w = SIZES.courtWidth, d = SIZES.courtDepth;
    const fenceZ = d / 2 + 0.5;
    let x0, x1;
    if (this.isClay) {
      const buffer = SIZES.clayCourtBuffer || 0;
      x0 = -w / 2 - (this.config.adjacentLeft ? 0 : buffer);
      x1 = w / 2 + (this.config.adjacentRight ? 0 : buffer);
    } else {
      x0 = -w / 2 - HARD_PAD_EXTRA_X;
      x1 = w / 2 + HARD_PAD_EXTRA_X;
    }
    return { x0, x1, z0: -fenceZ, z1: fenceZ };
  }

  _buildMask() {
    const p = this._pad, { center } = this.config;
    const cols = Math.max(1, Math.round((p.x1 - p.x0) * MASK_RES));
    const rows = Math.max(1, Math.round((p.z1 - p.z0) * MASK_RES));
    this.gridCols = cols;
    this.gridRows = rows;
    this.maskBounds = {
      x0: center.x + p.x0, z0: center.z + p.z0,
      x1: center.x + p.x0 + cols / MASK_RES, z1: center.z + p.z0 + rows / MASK_RES,
    };
    // Scoring region: cells whose centres lie on the 16 x 28 playing slab
    const hw = SIZES.courtWidth / 2, hd = SIZES.courtDepth / 2;
    this._sc0 = Math.max(0, Math.ceil((-hw - p.x0) * MASK_RES - 0.5));
    this._sc1 = Math.min(cols - 1, Math.floor((hw - p.x0) * MASK_RES - 0.5));
    this._sr0 = Math.max(0, Math.ceil((-hd - p.z0) * MASK_RES - 0.5));
    this._sr1 = Math.min(rows - 1, Math.floor((hd - p.z0) * MASK_RES - 0.5));
    this.scoreCells = (this._sc1 - this._sc0 + 1) * (this._sr1 - this._sr0 + 1);

    const n = cols * rows;
    this.dirt = new Float32Array(n).fill(0.6);   // start 60% dirty
    this.hit = new Uint8Array(n);
    const data = new Uint8Array(n * 4);
    const d0 = Math.round(0.6 * 255);
    for (let i = 0; i < n; i++) {
      data[i * 4] = d0;
      data[i * 4 + 1] = 128;
      data[i * 4 + 2] = 128;   // no stroke yet
      data[i * 4 + 3] = 128;
    }
    this.mask = data;
    this.dirtTexture = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.dirtTexture.magFilter = THREE.LinearFilter;
    this.dirtTexture.minFilter = THREE.LinearFilter;
    this.dirtTexture.generateMipmaps = false;
    this.dirtTexture.wrapS = this.dirtTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.dirtTexture.name = `courtDirt:${this.id}`;
    this.dirtTexture.needsUpdate = true;
  }

  // ───────────────────────────── Build ─────────────────────────────

  _build() {
    const { center } = this.config;
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    this.mesh.position.set(center.x, 0, center.z);

    this._mats = sharedMaterials();
    this._parts = { matte: [], metal: [], chain: [], wind: [], net: [], sign: [], glass: [] };
    this._halo = [];
    this._rand = seededRandom(hashStr(this.id));

    const fenceZ = d / 2 + 0.5;
    const padX0 = this._pad.x0, padX1 = this._pad.x1;

    this._addSurface(center);
    this._addCurbs();
    this._addNet(center, w);
    this._addFence(center, w, d);
    this._addLights(w, d);
    this._addFurniture(w);
    this._addSigns(d);
    this._finalizeParts();

    // Physics: ONE static slab per court covering the playing surface and the
    // surround / clay buffer (two overlapping coplanar boxes double the contacts
    // and friction, which slows walking ~5x). World merges contiguous slabs.
    const pw = Math.max(w, padX1 - padX0), pd = Math.max(d, 2 * fenceZ);
    const offX = (padX0 + padX1) / 2;
    this.slabBounds = {
      x0: center.x + offX - pw / 2, x1: center.x + offX + pw / 2,
      z0: center.z - pd / 2, z1: center.z + pd / 2,
    };
    this.slabBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(center.x + offX, 0.05, center.z),
      shape: new CANNON.Box(new CANNON.Vec3(pw / 2, 0.1, pd / 2)),
    });
    this.physicsWorld.addBody(this.slabBody);
  }

  _surfaceY(x, z) {
    const p = this._pad;
    return (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) ? SURFACE_Y : 0;
  }

  _add(bucket, geometry, x, y, z, color, ry = 0, s = 1, rx = 0, rz = 0) {
    this._parts[bucket].push({ geometry, matrix: makeMatrix(x, y, z, ry, s, rx, rz), color });
  }

  _addSurface(center) {
    const p = this._pad;
    const pw = p.x1 - p.x0, pd = p.z1 - p.z0;
    const geo = new THREE.PlaneGeometry(pw, pd);
    geo.rotateX(-Math.PI / 2);
    geo.translate((p.x0 + p.x1) / 2, SURFACE_Y, 0);

    const uniforms = {
      uCenter: { value: new THREE.Vector2(center.x, center.z) },
      uCourt: { value: new THREE.Vector4(HALF_W, HALF_L, SINGLES_W, SERVICE_L) },
      uLW: { value: new THREE.Vector2(LINE_W, BASELINE_W) },
      uLineColor: { value: new THREE.Color(COLORS.courtLine) },
      uInner: { value: new THREE.Color(COLORS.courtHardInner) },
      uOuter: { value: new THREE.Color(COLORS.courtHardOuter) },
      uBaseMap: { value: this.isClay ? Textures.clay() : Textures.acrylic() },
      uNoiseMap: { value: Textures.noise({ scale: 8 }) },
      uBaseScale: { value: this.isClay ? 0.26 : 0.4 },
      uFlood: _shared.flood,
    };
    if (this.isClay) {
      uniforms.uDirtMap = { value: this.dirtTexture };
      uniforms.uGrid = { value: new THREE.Vector4(p.x0, p.z0, this.gridCols / MASK_RES, this.gridRows / MASK_RES) };
      uniforms.uStripe = { value: new THREE.Vector2(15, GAME.groomBrushWidth || 3) };
    }
    this._surfaceUniforms = uniforms;

    const surface = new THREE.Mesh(geo, createSurfaceMaterial(this.isClay, uniforms));
    surface.receiveShadow = true;
    surface.userData.noMerge = true;
    surface.name = 'courtSurface';
    surface.onBeforeRender = updateShared;
    this.mesh.add(surface);
    this.surfaceMesh = surface;
  }

  _addCurbs() {
    const p = this._pad;
    const h = SURFACE_Y + 0.025;
    const c = this.isClay ? COLORS.courtCurb : 0x2c5a40;
    const pw = p.x1 - p.x0;
    const midX = (p.x0 + p.x1) / 2;
    // back edges (under the fences)
    for (const z of [p.z0 + CURB_W / 2, p.z1 - CURB_W / 2]) {
      this._add('matte', boxGeo(pw, h, CURB_W), midX, h / 2, z, c);
    }
    // side edges (skipped where a neighbouring clay court continues the surface)
    const sideLen = p.z1 - p.z0 - CURB_W * 2;
    // (also skipped where two hard-court surrounds meet: map.json sharedPadLeft / sharedPadRight)
    if (!(this.isClay && this.config.adjacentLeft) && !this.config.sharedPadLeft) {
      this._add('matte', boxGeo(CURB_W, h, sideLen), p.x0 + CURB_W / 2, h / 2, 0, c);
    }
    if (!(this.isClay && this.config.adjacentRight) && !this.config.sharedPadRight) {
      this._add('matte', boxGeo(CURB_W, h, sideLen), p.x1 - CURB_W / 2, h / 2, 0, c);
    }
  }

  _addNet(center, w) {
    const y0 = SURFACE_Y;
    const postX = w / 2 - 0.2;
    const green = COLORS.courtFenceGreen;
    const topAt = (x) => {
      const t = x / postX;
      return y0 + NET_CENTER_H + (NET_POST_H - NET_CENTER_H) * t * t;
    };

    // Posts with caps, base plates and a winder on one side
    const postGeo = cylinderGeo(0.055, 0.06, NET_POST_H + 0.06, 10);
    for (const sx of [-1, 1]) {
      const x = sx * postX;
      this._add('metal', postGeo, x, y0 + (NET_POST_H + 0.06) / 2, 0, green);
      this._add('metal', sphereGeo(0.065, 10, 6), x, y0 + NET_POST_H + 0.06, 0, green);
      this._add('metal', cylinderGeo(0.1, 0.1, 0.02, 10), x, y0 + 0.01, 0, 0x3a3f3a);
    }
    this._add('metal', boxGeo(0.05, 0.05, 0.14), postX, y0 + 0.75, 0.09, 0x9aa19a);
    this._add('metal', cylinderGeo(0.012, 0.012, 0.16, 6), postX + 0.06, y0 + 0.75, 0.16, 0x9aa19a, 0, 1, 0, Math.PI / 2);

    // Sagging mesh
    const span = 2 * postX - 0.1;
    const seg = 24;
    const netGeo = new THREE.PlaneGeometry(span, 1, seg, 1);
    const pos = netGeo.attributes.position;
    const uv = netGeo.attributes.uv;
    const cell = 0.11;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const top = pos.getY(i) > 0;
      const y = top ? topAt(x) - 0.03 : y0 + 0.04;
      pos.setXY(i, x, y);
      uv.setXY(i, (x + span / 2) / cell, (y - y0) / cell);
    }
    netGeo.computeVertexNormals();
    this._parts.net.push({ geometry: netGeo, matrix: null });

    // White headband following the sag, bottom cable, centre strap
    const band = new THREE.BoxGeometry(span, 0.075, 0.035, seg, 1, 1);
    const bpos = band.attributes.position;
    for (let i = 0; i < bpos.count; i++) {
      const x = bpos.getX(i);
      bpos.setY(i, bpos.getY(i) + topAt(x) - 0.0375);
    }
    band.computeVertexNormals();
    this._parts.matte.push({ geometry: band, matrix: null, color: COLORS.courtLine });
    this._add('metal', boxGeo(span, 0.02, 0.02), 0, y0 + 0.04, 0, 0x2a2d2a);
    this._add('matte', boxGeo(0.05, NET_CENTER_H, 0.03), 0, y0 + NET_CENTER_H / 2, 0, COLORS.courtLine);
    this._add('metal', boxGeo(0.08, 0.02, 0.08), 0, y0 + 0.01, 0, 0x3a3f3a);

    // Net collision body (thin wall across the court)
    const netShape = new CANNON.Box(new CANNON.Vec3((w - 0.4) / 2, SIZES.netHeight / 2, 0.08));
    const netBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(center.x, SIZES.netHeight / 2, center.z),
      shape: netShape,
    });
    this.physicsWorld.addBody(netBody);
  }

  _addFence(center, w, d) {
    const fenceH = SIZES.fenceHeight;
    const green = COLORS.courtFenceGreen;

    // Back fences (behind baselines) — physics unchanged
    const fences = [
      { pos: [0, fenceH / 2, -d / 2 - 0.5], size: [w + 2, fenceH, 0.1] },
      { pos: [0, fenceH / 2, d / 2 + 0.5], size: [w + 2, fenceH, 0.1] },
    ];

    // Visual extents: trim where a neighbouring court's fence continues (no overlap / z-fight)
    const x0 = this.config.adjacentLeft ? -w / 2 : -w / 2 - 1;
    const x1 = this.config.adjacentRight ? w / 2 : w / 2 + 1;
    const L = x1 - x0;
    const midX = (x0 + x1) / 2;
    const linkH = fenceH - WIND_TOP + 0.02;
    const tiles = Math.max(1, Math.round(L / 8));
    const baseY = 0;

    for (const f of fences) {
      const z = f.pos[2];
      // chain-link above the windscreen
      this._parts.chain.push({
        geometry: tiledPlane(L, linkH, L / 0.42, linkH / 0.42),
        matrix: makeMatrix(midX, WIND_TOP - 0.02 + linkH / 2, z),
      });
      // windscreen: two single-sided panels so the lettering reads correctly from both sides
      const wsH = WIND_TOP - 0.05;
      const wsGeo = getGeometry(`courtWind|${L}|${wsH}|${tiles}`, () => tiledPlane(L, wsH, tiles, 1));
      this._parts.wind.push({ geometry: wsGeo, matrix: makeMatrix(midX, 0.05 + wsH / 2, z + 0.012) });
      this._parts.wind.push({ geometry: wsGeo, matrix: makeMatrix(midX, 0.05 + wsH / 2, z - 0.012, Math.PI) });

      // posts
      const n = Math.max(1, Math.ceil(L / 3.2));
      for (let i = 0; i <= n; i++) {
        if (i === 0 && this.config.adjacentLeft) continue;
        const x = x0 + (L * i) / n;
        const end = i === 0 || i === n;
        const r = end ? 0.06 : 0.045;
        this._add('metal', cylinderGeo(r, r, fenceH + 0.05, 8), x, baseY + (fenceH + 0.05) / 2, z, green);
        this._add('metal', sphereGeo(r * 1.15, 8, 5), x, fenceH + 0.05, z, green);
      }
      // rails: top, windscreen top, bottom tension
      for (const [y, r] of [[fenceH, 0.035], [WIND_TOP, 0.025], [0.08, 0.018]]) {
        this._add('metal', cylinderGeo(r, r, L, 6), midX, y, z, green, 0, 1, 0, Math.PI / 2);
      }
    }

    // Fence collision bodies (behind baselines)
    for (const f of fences) {
      const fenceShape = new CANNON.Box(new CANNON.Vec3(f.size[0] / 2, fenceH / 2, 0.15));
      const fenceBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(center.x + f.pos[0], f.pos[1], center.z + f.pos[2]),
        shape: fenceShape,
      });
      this.physicsWorld.addBody(fenceBody);
    }
  }

  _addLights(w, d) {
    const fenceZ = d / 2 + 0.5;
    const dark = 0x59605a;
    const green = COLORS.courtFenceGreen;
    const haloPos = [];
    const tmp = new THREE.Vector3();
    for (const sz of [-1, 1]) {
      const z = sz * fenceZ;
      const inward = -sz;
      for (const sx of [-1, 1]) {
        const x = sx * 4.5;
        this._add('metal', cylinderGeo(0.07, 0.1, POLE_H, 10), x, POLE_H / 2, z, green);
        this._add('metal', cylinderGeo(0.18, 0.2, 0.08, 10), x, 0.04, z, 0x3a3f3a);
        // arm
        this._add('metal', boxGeo(0.07, 0.07, 0.8), x, POLE_H - 0.05, z + inward * 0.4, green);
        // luminaire tilted toward the court
        const hz = z + inward * 0.85;
        const hy = POLE_H - 0.12;
        const tilt = -inward * 0.55;
        const headM = makeMatrix(x, hy, hz, 0, 1, tilt);
        this._parts.metal.push({ geometry: roundedBox(1.1, 0.16, 0.55, 0.04), matrix: headM, color: dark });
        const glassM = headM.clone().multiply(_m4.makeTranslation(0, -0.085, 0));
        this._parts.glass.push({ geometry: boxGeo(0.98, 0.02, 0.44), matrix: glassM });
        tmp.set(0, -0.25, 0).applyMatrix4(headM);
        haloPos.push(tmp.x, tmp.y, tmp.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(haloPos, 3));
    const halos = new THREE.Points(g, haloMaterial());
    halos.name = 'courtLampHalos';
    halos.visible = false;
    halos.userData.noMerge = true;
    halos.userData.noAO = true;
    this.mesh.add(halos);
    _shared.halos.push(halos);
  }

  _addFurniture(w) {
    const umpire = this.config.id === 'court1' || this.config.umpireChair === true;
    const sideX = (this.isClay ? (SIZES.clayCourtBuffer || 0) : 0) + w / 2 + 1.2;

    // Benches on outer sides only (skip when adjacent to another court)
    if (!this.config.adjacentLeft) {
      if (umpire) {
        this._addUmpireChair(-(w / 2 + 0.95), 0, 1);
        this._addBench(-sideX, -2.3, 1);
        this._addBench(-sideX, 2.3, 1);
      } else {
        this._addBench(-sideX, 0, 1);
      }
    }
    if (!this.config.adjacentRight) {
      this._addBench(sideX, 0, -1);
    }

    // Ball hopper
    if (!this.isClay && !umpire) this._addBallHopper(4.2, -13.2);
    if (this.isClay && !this.config.adjacentRight) this._addBallHopper(-4.5, 13.3);

    // Stray balls near the back fences
    const r = this._rand;
    const nBalls = 3 + Math.floor(r() * 3);
    for (let i = 0; i < nBalls; i++) {
      const x = (r() - 0.5) * (w - 2);
      const z = (r() < 0.5 ? -1 : 1) * (13.4 + r() * 0.9);
      this._add('matte', sphereGeo(0.045, 8, 6), x, this._surfaceY(x, z) + 0.045, z, COLORS.tennisBall);
    }

    // Clay-court maintenance bits
    if (this.isClay && !this.config.adjacentLeft) this._addLineBroom(-w / 2 + 0.6, -14.2);
    if (this.isClay && !this.config.adjacentRight) this._addHoseReel(w / 2 + 2.5, -13.6);
  }

  /** Slatted wooden bench; `dir` = +1 faces +x, -1 faces -x. Long axis along z. */
  _addBench(x, z, dir) {
    const y = this._surfaceY(x, z);
    const wood = COLORS.courtBenchWood;
    const green = COLORS.courtFenceGreen;
    const L = 1.7;
    for (const dx of [-0.14, 0, 0.14]) {
      this._add('matte', roundedBox(0.12, 0.045, L, 0.015), x + dx * dir, y + 0.46, z, wood);
    }
    for (const [dy, ox] of [[0.64, -0.22], [0.8, -0.235]]) {
      this._add('matte', roundedBox(0.04, 0.11, L, 0.015), x + ox * dir, y + dy, z, wood, 0, 1, 0, dir * 0.12);
    }
    for (const dz of [-0.72, 0.72]) {
      this._add('metal', boxGeo(0.05, 0.44, 0.05), x + 0.16 * dir, y + 0.22, z + dz, green);
      this._add('metal', boxGeo(0.05, 0.86, 0.05), x - 0.21 * dir, y + 0.43, z + dz, green, 0, 1, 0, dir * 0.06);
      this._add('metal', boxGeo(0.44, 0.04, 0.05), x - 0.02 * dir, y + 0.42, z + dz, green);
      this._add('metal', boxGeo(0.42, 0.035, 0.06), x - 0.01 * dir, y + 0.64, z + dz, green);
    }
  }

  _addUmpireChair(x, z, dir) {
    const y = this._surfaceY(x, z);
    const green = COLORS.courtFenceGreen;
    const wood = COLORS.courtBenchWood;
    const legH = 1.5;
    for (const lx of [-0.28, 0.28]) {
      for (const lz of [-0.28, 0.28]) {
        this._add('metal', cylinderGeo(0.03, 0.035, legH, 8), x + lx, y + legH / 2, z + lz, green);
      }
    }
    for (const yy of [0.5, 1.0]) {
      this._add('metal', boxGeo(0.6, 0.03, 0.03), x, y + yy, z - 0.28, green);
      this._add('metal', boxGeo(0.6, 0.03, 0.03), x, y + yy, z + 0.28, green);
    }
    this._add('matte', roundedBox(0.75, 0.06, 0.75, 0.02), x, y + legH + 0.03, z, wood);
    // seat
    this._add('matte', roundedBox(0.34, 0.3, 0.46, 0.03), x - 0.05 * dir, y + legH + 0.21, z, COLORS.uiPrimary);
    this._add('matte', roundedBox(0.46, 0.06, 0.5, 0.025), x, y + legH + 0.39, z, wood);
    this._add('matte', roundedBox(0.06, 0.5, 0.5, 0.025), x - 0.24 * dir, y + legH + 0.66, z, wood, 0, 1, 0, dir * 0.1);
    for (const lz of [-0.26, 0.26]) {
      this._add('metal', boxGeo(0.4, 0.035, 0.04), x, y + legH + 0.62, z + lz, green);
      this._add('metal', boxGeo(0.035, 0.24, 0.035), x + 0.18 * dir, y + legH + 0.5, z + lz, green);
    }
    // footrest
    this._add('metal', boxGeo(0.06, 0.03, 0.56), x + 0.34 * dir, y + 1.05, z, green);
    // ladder at the back
    const lx = x - 0.48 * dir;
    for (const lz of [-0.2, 0.2]) {
      this._add('metal', boxGeo(0.035, 1.62, 0.035), lx + 0.1 * dir, y + 0.78, z + lz, green, 0, 1, 0, -dir * 0.14);
    }
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      this._add('metal', boxGeo(0.03, 0.03, 0.42), lx + (0.1 - (0.5 - t) * 0.22) * dir, y + t * 1.55, z, 0x9aa19a);
    }
    // shade canopy
    for (const lz of [-0.3, 0.3]) {
      this._add('metal', cylinderGeo(0.02, 0.02, 1.1, 6), x - 0.3 * dir, y + legH + 0.95, z + lz, green);
    }
    this._add('matte', roundedBox(0.9, 0.06, 0.85, 0.03), x - 0.08 * dir, y + legH + 1.5, z, COLORS.uiPrimary, 0, 1, 0, -dir * 0.08);
    this._add('matte', boxGeo(0.92, 0.1, 0.02), x - 0.08 * dir, y + legH + 1.44, z + 0.43, COLORS.uiAccent);
    this._add('matte', boxGeo(0.92, 0.1, 0.02), x - 0.08 * dir, y + legH + 1.44, z - 0.43, COLORS.uiAccent);
  }

  _addBallHopper(x, z) {
    const y = this._surfaceY(x, z);
    const wire = 0x3a3f3a;
    const basketY = y + 0.55;
    for (const [lx, lz] of [[-0.14, -0.14], [0.14, -0.14], [-0.14, 0.14], [0.14, 0.14]]) {
      this._add('metal', cylinderGeo(0.012, 0.012, 0.58, 5), x + lx * 1.15, y + 0.29, z + lz * 1.15, wire, 0, 1, -lz * 0.5, lx * 0.5);
    }
    this._add('metal', cylinderGeo(0.2, 0.17, 0.34, 12), x, basketY + 0.17, z, wire);
    this._add('metal', boxGeo(0.02, 0.5, 0.02), x - 0.21, basketY + 0.4, z, wire);
    this._add('metal', boxGeo(0.02, 0.5, 0.02), x + 0.21, basketY + 0.4, z, wire);
    this._add('metal', boxGeo(0.44, 0.02, 0.02), x, basketY + 0.65, z, wire);
    const r = this._rand;
    for (let i = 0; i < 14; i++) {
      const a = r() * Math.PI * 2, rr = Math.sqrt(r()) * 0.15;
      const bx = x + Math.cos(a) * rr, bz = z + Math.sin(a) * rr;
      this._add('matte', sphereGeo(0.045, 8, 6), bx, basketY + 0.36 + (0.15 - rr) * 0.5 + r() * 0.02, bz, COLORS.tennisBall);
    }
  }

  _addLineBroom(x, z) {
    const y = this._surfaceY(x, z);
    // handle leaning against the fence
    this._add('matte', cylinderGeo(0.018, 0.018, 1.5, 6), x, y + 0.72, z + 0.18, 0xb08850, 0, 1, -0.28, 0);
    this._add('matte', roundedBox(0.5, 0.07, 0.08, 0.02), x, y + 0.05, z + 0.38, 0x4a3a2a);
    this._add('matte', boxGeo(0.46, 0.05, 0.07), x, y + 0.015, z + 0.38, 0xc9b27a);
  }

  _addHoseReel(x, z) {
    const y = this._surfaceY(x, z);
    const green = COLORS.courtFenceGreen;
    this._add('metal', boxGeo(0.05, 0.5, 0.5), x - 0.2, y + 0.25, z, green);
    this._add('metal', boxGeo(0.05, 0.5, 0.5), x + 0.2, y + 0.25, z, green);
    this._add('matte', cylinderGeo(0.22, 0.22, 0.34, 14), x, y + 0.34, z, 0x2f6b3a, 0, 1, 0, Math.PI / 2);
    this._add('metal', cylinderGeo(0.26, 0.26, 0.02, 14), x - 0.17, y + 0.34, z, 0xb0b5b0, 0, 1, 0, Math.PI / 2);
    this._add('metal', cylinderGeo(0.26, 0.26, 0.02, 14), x + 0.17, y + 0.34, z, 0xb0b5b0, 0, 1, 0, Math.PI / 2);
    const torus = getGeometry('courtHoseLoop', () => new THREE.TorusGeometry(0.24, 0.025, 6, 16));
    for (const dx of [-0.08, 0, 0.08]) {
      this._add('matte', torus, x + dx, y + 0.34, z, 0x3f8a4a, Math.PI / 2);
    }
  }

  _addSigns(d) {
    const m = /\d+/.exec(this.config.label || this.config.id || '');
    const num = Math.min(SIGN_COLS * SIGN_ROWS, Math.max(1, m ? parseInt(m[0], 10) : 1));
    const idx = num - 1;
    const u0 = (idx % SIGN_COLS) / SIGN_COLS, u1 = u0 + 1 / SIGN_COLS;
    const v1 = 1 - Math.floor(idx / SIGN_COLS) / SIGN_ROWS, v0 = v1 - 1 / SIGN_ROWS;
    const face = new THREE.PlaneGeometry(0.9, 0.52);
    const uv = face.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) < 0.5 ? u0 + 0.004 : u1 - 0.004, uv.getY(i) < 0.5 ? v0 + 0.006 : v1 - 0.006);
    }
    const fenceZ = d / 2 + 0.5;
    const y = WIND_TOP + 0.45;
    for (const sz of [-1, 1]) {
      const z = sz * fenceZ;
      this._add('matte', roundedBox(1.02, 0.64, 0.05, 0.03), 0, y, z, COLORS.uiPrimary);
      this._parts.sign.push({ geometry: face, matrix: makeMatrix(0, y, z + 0.027) });
      this._parts.sign.push({ geometry: face, matrix: makeMatrix(0, y, z - 0.027, Math.PI) });
    }
  }

  _finalizeParts() {
    const M = this._mats;
    const spec = [
      ['matte', M.matte, true, true],
      ['metal', M.metal, true, true],
      ['chain', M.chainLink, false, true],
      ['wind', M.windscreen, true, true],
      ['net', M.net, false, true],
      ['sign', M.sign, false, true],
      ['glass', M.lampGlass, false, false],
    ];
    for (const [key, material, cast, receive] of spec) {
      const parts = this._parts[key];
      if (!parts.length) continue;
      const geo = mergeParts(parts);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `court-${key}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      if (key === 'chain' || key === 'net') mesh.userData.noAO = true;
      this.mesh.add(mesh);
    }
    this._parts = null;
  }
}
