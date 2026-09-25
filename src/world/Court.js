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
 * Clay grooming API (used by CourtMaintenanceSystem) is unchanged:
 *   id, config, isClay, gridRows, gridCols, dirtGrid,
 *   getDirtAt, groomAt, degradeSurface, getCleanliness, setAllDirt
 * The dirt visual is a gridCols x gridRows DataTexture sampled by the surface shader
 * (R = dirt, G/B = last brush direction for the fresh drag stripes).
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
uniform vec4 uGrid;       // grid min x/z (court-local), grid size x/z
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
  vec4 dt = texture2D(uDirtMap, (p + warp * 1.6 - uGrid.xy) / uGrid.zw);
  float dirt = clamp(dt.r + wear * 0.2, 0.0, 1.0);
  float dk = smoothstep(0.03, 0.75, dirt);
  // fresh drag-brush stripes, along the direction the brush last travelled (G: 1 = along x)
  float k = 26.0;
  float wob = (nMid - 0.5) * 3.0;
  float stripes = mix(sin(p.x * k + wob), sin(p.y * k + wob), dt.g);
  float sAA = 1.0 - smoothstep(0.25, 0.7, max(fw.x, fw.y) * k / 6.2832 * 1.5);
  vec3 clean = base * vec3(1.07, 1.05, 1.04) * (1.0 + 0.06 * stripes * sAA) * (0.97 + 0.06 * nLarge);
  // scuffed clay: darker blotches, footwork slides kicking up loose (lighter) clay
  float scuff = smoothstep(0.4, 0.72, texture2D(uNoiseMap, cw * 0.55 + 0.13).r);
  float slide = smoothstep(0.58, 0.8, texture2D(uNoiseMap, vec2(cw.x * 1.7, cw.y * 0.28)).r);
  vec3 dirty = base * mix(vec3(0.88, 0.82, 0.8), vec3(0.68, 0.58, 0.56), scuff) * (0.9 + 0.14 * nLarge);
  dirty = mix(dirty, base * vec3(1.14, 1.07, 1.0), slide * 0.5);
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

    // Surface grid for clay court maintenance
    this.gridCols = 0;
    this.gridRows = 0;
    this.dirtGrid = null;       // 2D array of dirtiness values (0=clean, 1=dirty)
    this.dirtTexture = null;    // gridCols x gridRows RGBA DataTexture (visual only)
    this.surfaceMesh = null;    // shader-painted court surface

    this._lastGroom = null;     // last groomAt position (for stripe direction)

    if (this.isClay) {
      this._buildDirtGrid();
    }

    this._build();
    this.scene.add(this.mesh);
  }

  /**
   * Get dirtiness at a world position. Returns -1 if outside the court.
   */
  getDirtAt(worldX, worldZ) {
    if (!this.dirtGrid) return -1;
    const cell = this._worldToGrid(worldX, worldZ);
    if (!cell) return -1;
    return this.dirtGrid[cell.row][cell.col];
  }

  /**
   * Groom (clean) cells near a world position within a given radius.
   * Returns number of cells affected.
   */
  groomAt(worldX, worldZ, radius) {
    if (!this.dirtGrid) return 0;
    const { center } = this.config;
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    const cellSize = GAME.groomCellSize;
    let affected = 0;

    // Brush travel direction (visual only): axial, encoded as cos2θ / sin2θ
    let dirC = -2, dirS = 0;
    const last = this._lastGroom;
    if (last) {
      const mx = worldX - last.x, mz = worldZ - last.z;
      const l2 = mx * mx + mz * mz;
      if (l2 > 0.0004 && l2 < 6.25) {
        dirC = (mx * mx - mz * mz) / l2;
        dirS = (2 * mx * mz) / l2;
      }
      last.x = worldX; last.z = worldZ;
    } else {
      this._lastGroom = { x: worldX, z: worldZ };
    }

    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        // Cell center in world coords
        const cx = center.x - w / 2 + (col + 0.5) * cellSize;
        const cz = center.z - d / 2 + (row + 0.5) * cellSize;
        const dx = worldX - cx;
        const dz = worldZ - cz;
        if (dx * dx + dz * dz < radius * radius) {
          if (dirC > -2) this._setCellDirection(row, col, dirC, dirS);
          if (this.dirtGrid[row][col] <= 0) continue;
          this.dirtGrid[row][col] = Math.max(0, this.dirtGrid[row][col] - 0.15);
          this._updateCellVisual(row, col);
          affected++;
        }
      }
    }
    return affected;
  }

  /**
   * Add dirt to all cells (simulates play degradation).
   */
  degradeSurface(amount) {
    if (!this.dirtGrid) return;
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        this.dirtGrid[row][col] = Math.min(1, this.dirtGrid[row][col] + amount);
        this._updateCellVisual(row, col);
      }
    }
  }

  /**
   * Get overall cleanliness (0=all dirty, 1=all clean).
   */
  getCleanliness() {
    if (!this.dirtGrid) return 1;
    let total = 0;
    const count = this.gridRows * this.gridCols;
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        total += (1 - this.dirtGrid[row][col]);
      }
    }
    return total / count;
  }

  /**
   * Set all cells to a given dirtiness level.
   */
  setAllDirt(level) {
    if (!this.dirtGrid) return;
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        this.dirtGrid[row][col] = level;
        this._updateCellVisual(row, col);
      }
    }
  }

  /**
   * Compact per-cell snapshot for saves: 6 hex chars per cell (row-major) —
   * dirt, then the two brush-direction channels (the groomed stripe pattern).
   */
  getGridHex() {
    if (!this.dirtGrid || !this.dirtTexture) return '';
    const data = this.dirtTexture.image.data;
    let out = '';
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        const i = (row * this.gridCols + col) * 4;
        const v = Math.round(Math.min(1, Math.max(0, this.dirtGrid[row][col])) * 255);
        out += (v | 0x100).toString(16).slice(1) +
          (data[i + 1] | 0x100).toString(16).slice(1) +
          (data[i + 2] | 0x100).toString(16).slice(1);
      }
    }
    return out;
  }

  /**
   * Restore a getGridHex() snapshot (6 hex/cell), or a dirt-only one (2 hex/cell).
   * Returns false (and changes nothing) when the string doesn't match this grid.
   */
  setGridHex(hex) {
    if (!this.dirtGrid || !this.dirtTexture || typeof hex !== 'string') return false;
    const cells = this.gridRows * this.gridCols;
    const per = hex.length === cells * 6 ? 6 : hex.length === cells * 2 ? 2 : 0;
    if (!per || !/^[0-9a-f]*$/i.test(hex)) return false;
    const data = this.dirtTexture.image.data;
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        const k = (row * this.gridCols + col);
        const o = k * per;
        this.dirtGrid[row][col] = parseInt(hex.substr(o, 2), 16) / 255;
        if (per === 6) {
          data[k * 4 + 1] = parseInt(hex.substr(o + 2, 2), 16);
          data[k * 4 + 2] = parseInt(hex.substr(o + 4, 2), 16);
        }
        this._updateCellVisual(row, col);
      }
    }
    this.dirtTexture.needsUpdate = true;
    return true;
  }

  _worldToGrid(worldX, worldZ) {
    const { center } = this.config;
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    const cellSize = GAME.groomCellSize;

    const localX = worldX - (center.x - w / 2);
    const localZ = worldZ - (center.z - d / 2);
    const col = Math.floor(localX / cellSize);
    const row = Math.floor(localZ / cellSize);

    if (col < 0 || col >= this.gridCols || row < 0 || row >= this.gridRows) return null;
    return { row, col };
  }

  _buildDirtGrid() {
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    const cellSize = GAME.groomCellSize;

    this.gridCols = Math.floor(w / cellSize);
    this.gridRows = Math.floor(d / cellSize);
    this.dirtGrid = [];

    const data = new Uint8Array(this.gridCols * this.gridRows * 4);
    this.dirtTexture = new THREE.DataTexture(data, this.gridCols, this.gridRows, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.dirtTexture.magFilter = THREE.LinearFilter;
    this.dirtTexture.minFilter = THREE.LinearFilter;
    this.dirtTexture.generateMipmaps = false;
    this.dirtTexture.wrapS = this.dirtTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.dirtTexture.name = `courtDirt:${this.id}`;

    for (let row = 0; row < this.gridRows; row++) {
      this.dirtGrid[row] = [];
      for (let col = 0; col < this.gridCols; col++) {
        // Start at 60% dirty
        this.dirtGrid[row][col] = 0.6;
        const i = (row * this.gridCols + col) * 4;
        data[i + 1] = 0;     // default stripes run along the court length
        data[i + 2] = 128;
        data[i + 3] = 255;
        this._updateCellVisual(row, col);
      }
    }
    this.dirtTexture.needsUpdate = true;
  }

  _updateCellVisual(row, col) {
    if (!this.dirtTexture) return;
    const v = Math.round(Math.min(1, Math.max(0, this.dirtGrid[row][col])) * 255);
    const data = this.dirtTexture.image.data;
    const i = (row * this.gridCols + col) * 4;
    if (data[i] !== v) {
      data[i] = v;
      this.dirtTexture.needsUpdate = true;
    }
  }

  _setCellDirection(row, col, c2, s2) {
    const data = this.dirtTexture.image.data;
    const i = (row * this.gridCols + col) * 4;
    const g = Math.round((c2 * 0.5 + 0.5) * 255);
    const b = Math.round((s2 * 0.5 + 0.5) * 255);
    if (data[i + 1] !== g || data[i + 2] !== b) {
      data[i + 1] = g;
      data[i + 2] = b;
      this.dirtTexture.needsUpdate = true;
    }
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

    // Pad extents (court-local). Hard: blue court + green surround; clay: slab + side buffers.
    const fenceZ = d / 2 + 0.5;
    let padX0, padX1;
    if (this.isClay) {
      const buffer = SIZES.clayCourtBuffer || 0;
      padX0 = -w / 2 - (this.config.adjacentLeft ? 0 : buffer);
      padX1 = w / 2 + (this.config.adjacentRight ? 0 : buffer);
    } else {
      padX0 = -w / 2 - HARD_PAD_EXTRA_X;
      padX1 = w / 2 + HARD_PAD_EXTRA_X;
    }
    this._pad = { x0: padX0, x1: padX1, z0: -fenceZ, z1: fenceZ };

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
      const w = SIZES.courtWidth, d = SIZES.courtDepth, cs = GAME.groomCellSize;
      uniforms.uDirtMap = { value: this.dirtTexture };
      uniforms.uGrid = { value: new THREE.Vector4(-w / 2, -d / 2, this.gridCols * cs, this.gridRows * cs) };
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
