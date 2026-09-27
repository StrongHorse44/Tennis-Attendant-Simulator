import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';
import { mat, getMaterial, registerWet, registerNightGlow } from '../graphics/Materials.js';
import { Textures, createCanvasTexture, seededRandom } from '../graphics/Textures.js';
import { roundedBox, boxGeo, cylinderGeo, sphereGeo, getGeometry, mergeParts, makeMatrix } from '../graphics/GeometryUtils.js';
import { EnvState } from '../graphics/EnvState.js';
import { withOcclusionFade } from '../graphics/OcclusionFade.js';

/**
 * Court - tennis court: one shader-painted surface (zones, lines, clay dirt, lawn), net,
 * chain-link fence with windscreen, benches, light poles and small props.
 *
 * Surfaces (map.json court `type`, exposed as `court.surface`, plus `isClay` / `isGrass`):
 *   'hard'  blue acrylic court on a green acrylic surround
 *   'clay'  red clay with the grooming paint mask (below) and side buffers
 *   'grass' manicured lawn, court and run-off alike: mow stripes parallel to the net, worn
 *           earth behind the baselines, chalk lines (COURT_GRASS, Textures.grassCourt)
 * Hard and grass pads extend HARD_PAD_EXTRA_X past the slab; neighbouring pads only share a
 * surround (no edging between them) when both courts have the same surface (sharedPadSides).
 *
 * Draw calls per court: surface, matte props, painted-metal props, chain-link, windscreen,
 * net mesh, sign faces, lamp glass, lamp halos (~9, everything else is merged).
 *
 * The frame sits at map.json center.y (court.baseY; 0 for every flat court, so they are unchanged)
 * and the surface at court.surfaceY = baseY + SIZES.courtSurfaceY. A court with a `stadium` block
 * (court.isStadium: the sunken Centre Court, see StadiumLayout.js / Stadium.js) is a show court:
 * no chain-link, fence bodies, light poles or signs, low end boards behind the baselines instead,
 * a body over the umpire chair, and no slab body (the stadium's pit-floor plane carries it;
 * slabBounds, with its y, stays for TennisCrowd). About 5 draw calls.
 *
 * Venue courts (Venues.js: the Junior Tour's other clubs) pass constructor opts — paint colours,
 * a sponsor windscreen material, the fence style (chain-link / full windscreen / hedge / none,
 * reach, height, side runs), no poles / signs / stray balls, a shared surface material — and are
 * disposed again (dispose(), setBodiesEnabled()). Without opts a court builds exactly as before.
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
  mats: null,          // sharedMaterials(), built once
  twins: new Map(),    // court material → its see-through twin (after-hours tennis)
  twinGroup: null,     // hidden meshes so the twins precompile with the scene
};

function updateShared() {
  const f = EnvState.lampFactor || 0;
  // The fake floodlight pool on the surface steps back when real stadium light is on the scene
  _shared.flood.value = f * (1 - 0.7 * (EnvState.floodFactor || 0));
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
uniform float uSurfY;     // world y of the court surface (center.y + SIZES.courtSurfaceY)
#ifdef COURT_CLAY
uniform sampler2D uDirtMap;
uniform vec4 uGrid;       // mask min x/z (court-local), mask size x/z
uniform vec2 uStripe;     // bristle lines across the brush, brush width
#endif
#ifdef COURT_GRASS
uniform vec3 uWorn;       // thinning, yellowed grass
uniform vec3 uEarth;      // bare baseline earth
uniform vec2 uMow;        // mow stripe width (m), stripe contrast
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
#elif defined(COURT_GRASS)
  // Manicured lawn: the grain tile twice (a second, larger, turned sample hides the repeat)
  vec3 lawn = mix(base, texture2D(uBaseMap, cw.yx * (uBaseScale * 0.37) + 0.43).rgb, 0.45);
  lawn *= 0.93 + 0.12 * nLarge;
  float nFine = texture2D(uNoiseMap, cw * 0.83 + 0.17).r;
  // Mow stripes parallel to the net (band edges on the net and the baselines). The blades lean
  // with the mower, so a band reads light seen along its lean and dark against it (swapping
  // with the viewing end); a floor keeps them visible from overhead. Faded out before the
  // bands get thin enough on screen to alias.
  float mw = (p.y + (nMid - 0.5) * 0.1) / uMow.x;
  float mfw = fwidth(mw);
  float tri = abs(fract((mw + 0.5) * 0.5) - 0.5) * 4.0 - 1.0;
  float band = clamp(tri / (2.0 * mfw + 0.1), -1.0, 1.0) * (1.0 - smoothstep(0.2, 0.55, mfw));
  vec3 toCam = cameraPosition - vec3(cw.x, uSurfY, cw.y);
  float lz = toCam.z / max(length(toCam), 1e-3);
  float stripe = band * (lz * 0.65 + 0.35 * clamp(lz * 4.0, -1.0, 1.0));
  vec3 grass = lawn * (1.0 + uMow.y * stripe) + vec3(0.012, 0.012, 0.0) * max(stripe, 0.0);
  // Wear: bare earth behind each baseline (the server / returner spot, thinner along the
  // baseline) and lightly thinned grass in each service box near the T (split steps)
  float bd = abs(p.y) - uCourt.y;
  vec2 cq = vec2(p.x / 2.9, (bd - 0.6) / 1.35);
  float wr = exp(-dot(cq, cq));
  float sd = (bd - 0.3) / 0.9;
  wr = max(wr, exp(-sd * sd) * (1.0 - smoothstep(3.0, 6.4, abs(p.x))) * 0.72);
  vec2 bq = vec2((abs(p.x) - uCourt.z * 0.3) / 1.2, (abs(p.y) - uCourt.w * 0.72) / 1.7);
  wr = max(wr, exp(-dot(bq, bq)) * 0.2);
  wr = wr * (0.7 + 0.6 * nMid) + (nFine - 0.5) * 0.3;
  float thin = smoothstep(0.12, 0.45, wr);
  float bare = smoothstep(0.45, 0.8, wr);
  float tuft = smoothstep(0.58, 0.72, texture2D(uNoiseMap, cw * 2.3 + 0.61).r);
  vec3 worn = uWorn * (0.86 + 0.28 * nFine) * (0.55 + 1.4 * base.g);
  vec3 earth = uEarth * (0.84 + 0.3 * texture2D(uNoiseMap, cw * 3.7 + 0.29).r);
  earth = mix(earth, worn * 0.92, tuft * 0.55);
  col = mix(grass, worn, thin * 0.9);
  col = mix(col, earth, bare);
  // chalk lines: bright on the grass, scuffed where the earth shows through
  vec3 lineCol = mix(uLineColor * (0.93 + 0.07 * nFine), earth * 1.2, bare * 0.3);
  col = mix(col, lineCol, lineM);
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

// One surface program per playing surface (map.json court `type`)
const SURFACE_MATS = {
  hard: { roughness: 0.6, name: 'courtSurfaceHard', key: 'court-surface-hard', define: null },
  clay: { roughness: 0.95, name: 'courtSurfaceClay', key: 'court-surface-clay', define: 'COURT_CLAY' },
  grass: { roughness: 0.9, name: 'courtSurfaceGrass', key: 'court-surface-grass', define: 'COURT_GRASS' },
};

/** A court config's playing surface: 'hard' | 'clay' | 'grass' (anything else counts as hard). */
export function courtSurfaceOf(config) {
  const t = config && config.type;
  return t === 'clay' || t === 'grass' ? t : 'hard';
}

/**
 * Which sides of `config`'s surround really continue into the neighbouring court's
 * (map.json sharedPadLeft / sharedPadRight): only when that neighbour is flagged the other
 * way round, sits on the same row and has the same surface. A hard court next to a grass
 * court keeps its own edging on that side.
 */
export function sharedPadSides(config, all) {
  const out = { left: false, right: false };
  if (!config || !Array.isArray(all)) return out;
  const cx = config.center?.x ?? 0, cz = config.center?.z ?? 0;
  const neighbour = (dir, flag) => {
    let best = null, bestD = Infinity;
    for (const o of all) {
      if (!o || o === config || !o[flag] || (Number(o.rotation) || 0) !== (Number(config.rotation) || 0)) continue;
      const dx = ((o.center?.x ?? 0) - cx) * dir;
      if (dx <= 0 || Math.abs((o.center?.z ?? 0) - cz) > 0.5 || dx >= bestD) continue;
      best = o; bestD = dx;
    }
    return best;
  };
  const surface = courtSurfaceOf(config);
  if (config.sharedPadLeft) {
    const n = neighbour(-1, 'sharedPadRight');
    out.left = !!n && courtSurfaceOf(n) === surface;
  }
  if (config.sharedPadRight) {
    const n = neighbour(1, 'sharedPadLeft');
    out.right = !!n && courtSurfaceOf(n) === surface;
  }
  return out;
}

function createSurfaceMaterial(surface, uniforms) {
  const spec = SURFACE_MATS[surface] || SURFACE_MATS.hard;
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: spec.roughness,
    metalness: 0,
  });
  m.name = spec.name;
  if (spec.define) m.defines = { [spec.define]: '' };
  m.customProgramCacheKey = () => spec.key;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SURFACE_VERT_HEAD)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + SURFACE_VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SURFACE_FRAG_HEAD)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + SURFACE_FRAG_BODY);
  };
  // Hard courts: a deeper, wetter blue in rain instead of a grey-sky wash (lilac).
  // Grass: a darker, slightly glossy soaked lawn.
  if (surface === 'clay') registerWet(m, 0.7);
  else if (surface === 'grass') registerWet(m, 0.55);
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

// After-hours tennis dithers the poles, fence, windscreen and signs between its camera and the
// play (graphics/OcclusionFade.js). The opaque court materials stay plain in the normal game (a
// shader that may `discard` costs early-Z on tile GPUs); each has a patched "fade twin" that
// TennisOcclusion swaps onto the meshes in its fade region for the session only. The twins are
// precompiled with the scene (a hidden mesh each under the first court). The chain-link already
// discards (alphaTest), so it is patched in place. Named materials, so a patch never reaches a
// parameter-cached mat() another module might share.
function sharedMaterials() {
  if (_shared.mats) return _shared.mats;
  const mats = {
    matte: getMaterial('courtMatte', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0,
    })),
    metal: getMaterial('courtMetal', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.35,
    })),
    chainLink: getMaterial('courtChainLink', () => withOcclusionFade(new THREE.MeshStandardMaterial({
      color: 0x456f55,
      map: Textures.chainLink(),
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true, // one draw (not back+front) and no per-draw program flip
      roughness: 0.55,
      metalness: 0.3,
    }))),
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
    windscreen: getMaterial('courtWindscreen', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, map: windscreenTexture(), roughness: 0.92, metalness: 0,
    })),
    sign: getMaterial('courtSign', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, map: signAtlas(), roughness: 0.7, metalness: 0,
    })),
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
  // Fade twins (see above)
  const twins = _shared.twins;
  for (const k of ['matte', 'metal', 'windscreen', 'sign', 'lampGlass']) {
    const base = mats[k];
    const twin = getMaterial(`${base.name || k}Occ|${k}`, () => {
      const t = withOcclusionFade(base.clone());
      if (k === 'lampGlass') registerNightGlow(t, 3.2, 0);
      return t;
    });
    twins.set(base, twin);
  }
  _shared.mats = mats;
  return mats;
}

/**
 * The see-through twin of a court material (after-hours tennis), or null. TennisOcclusion swaps
 * it onto a mesh for the session and restores the original afterwards.
 */
export function courtOcclusionTwin(material) {
  return _shared.twins.get(material) || null;
}

/**
 * Give an opaque material (a venue windscreen, a hedge...) a see-through twin so after-hours
 * tennis fades it like the court's own: withOcclusionFade(material.clone()), which shares the
 * program of the court twins as long as the material's program parameters match one (a plain
 * MeshStandardMaterial with a map, or with vertex colours). Returns the twin. Pair it with
 * unregisterOcclusionTwin() when the material is disposed (Venues does).
 */
export function registerOcclusionTwin(material) {
  if (!material) return null;
  let twin = _shared.twins.get(material);
  if (!twin) {
    twin = withOcclusionFade(material.clone());
    twin.name = `${material.name || 'material'}Occ`;
    _shared.twins.set(material, twin);
  }
  return twin;
}

/** Forget (and dispose) a twin made by registerOcclusionTwin(). */
export function unregisterOcclusionTwin(material) {
  const twin = material ? _shared.twins.get(material) : null;
  if (!twin) return;
  _shared.twins.delete(material);
  twin.dispose();
}

/** The hedge material (the garden's) with its see-through twin: a court's `fence.style: 'hedge'`. */
function hedgeMaterial() {
  const m = mat(0xffffff, { map: Textures.hedge({ repeat: [1, 1] }), roughness: 0.95, wet: 0.35, name: 'hedge' });
  registerOcclusionTwin(m);
  return m;
}

/**
 * The court floodlights' lamp-glass material (glows with EnvState.lampFactor). Shared so other
 * floodlights (the Centre Court masts, the stadium arch lanterns) reuse its program.
 */
export function courtLampGlassMaterial() {
  return sharedMaterials().lampGlass;
}

/** The court floodlights' additive halo material (a THREE.PointsMaterial, opacity follows the lamps). */
export function courtHaloMaterial() {
  return haloMaterial();
}

/**
 * Register a THREE.Points of lamp halos (on courtHaloMaterial()) so it is shown and hidden with the
 * court floodlights (the lamp factor, updated as the court surfaces render).
 */
export function registerCourtHalos(points) {
  if (!points || _shared.halos.includes(points)) return;
  points.visible = false;
  _shared.halos.push(points);
}

/** Hidden meshes so _precompileShaders compiles the twins' programs with the scene. */
function twinPrecompileGroup() {
  if (_shared.twinGroup) return null;
  const g = new THREE.Group();
  g.name = 'courtOcclusionTwins';
  g.visible = false;
  const geo = boxGeo(0.01, 0.01, 0.01);
  for (const t of _shared.twins.values()) {
    const m = new THREE.Mesh(geo, t);
    m.frustumCulled = false;
    m.userData.noMerge = true;
    g.add(m);
  }
  _shared.twinGroup = g;
  return g;
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

/** Box-projected UVs in world units / tile (geometry already in place), e.g. a hedge block. */
function projectUV(geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let u, v;
    if (ay >= ax && ay >= az) { u = x; v = z; } else if (ax >= az) { u = z; v = y; } else { u = x; v = y; }
    uv[i * 2] = u / tile;
    uv[i * 2 + 1] = v / tile;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
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
  /**
   * @param {object} [opts]
   * @param {{left:boolean, right:boolean}} [opts.sharedPad] sides whose surround continues into
   *   the neighbour's (World passes sharedPadSides(config, allConfigs); default: none)
   *
   * Venue options (Venues.js builds other clubs' courts with them; every club court leaves them
   * unset and builds exactly as before):
   * @param {{inner?:number, outer?:number, line?:number, curb?:number}} [opts.colors] paint
   *   (hard: court / surround, any surface: lines, curbs)
   * @param {THREE.Material} [opts.windscreenMaterial] the windscreen panels' material (a venue's
   *   sponsor screens; give it a twin with registerOcclusionTwin so it fades like the club's)
   * @param {{style?:'chainlink'|'windscreen'|'hedge'|'none', halfU?:number, height?:number,
   *   sides?:boolean}} [opts.fence] back fences: 'chainlink' (default: screen to 1.9 m, chain-link
   *   above), 'windscreen' (screen to 0.3 m under the top), 'hedge' (clipped hedges), 'none'
   *   (visuals only: the fence bodies stay, the ball physics keeps its back wall); halfU = reach
   *   across (default 9), height (default SIZES.fenceHeight); sides: side fences at ±halfU too
   *   (hedges: low ones)
   * @param {boolean} [opts.lights=true] the four corner floodlight poles
   * @param {boolean} [opts.signs=true] the "COURT n" boards
   * @param {boolean} [opts.strayBalls=true] loose balls by the back fences
   * @param {string} [opts.surfaceMaterialKey] share one cached surface material per key and
   *   surface (its uniforms take this court's values): courts that are rebuilt again and again
   *   (one venue at a time) don't pile up materials in the wetness registry
   */
  constructor(scene, physicsWorld, config, opts = {}) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.config = config;
    this._opts = opts || {};
    /** Every static body this court added (net, fences, slab, show-court boards / chair). */
    this.bodies = [];
    this.mesh = new THREE.Group();
    this.mesh.name = `court:${config.id}`;
    this.id = config.id;
    // Court frame height (map.json center.y; 0 for every flat court). The sunken stadium court
    // (a `stadium` block, see StadiumLayout.js) sits below the lawn at baseY.
    this.baseY = Number(config.center?.y) || 0;
    this.surfaceY = this.baseY + SURFACE_Y;   // top of the pad (walk / bounce surface)
    this.isStadium = !!config.stadium;
    this.surface = courtSurfaceOf(config);   // 'hard' | 'clay' | 'grass'
    this.isClay = this.surface === 'clay';
    this.isGrass = this.surface === 'grass';
    this._sharedPad = {
      left: !!(opts.sharedPad && opts.sharedPad.left),
      right: !!(opts.sharedPad && opts.sharedPad.right),
    };
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

  /** Pad extents (court-local). Hard / grass: court + surround; clay: slab + side buffers. */
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
    // The court frame sits at center.y (0 for every flat court; the sunken show court below the lawn)
    this.mesh.position.set(center.x, this.baseY, center.z);

    this._mats = sharedMaterials();
    const twinGroup = twinPrecompileGroup();
    if (twinGroup) this.mesh.add(twinGroup);
    this._parts = { matte: [], metal: [], chain: [], wind: [], net: [], sign: [], glass: [], hedge: [] };
    this._halo = [];
    this._rand = seededRandom(hashStr(this.id));

    const fenceZ = d / 2 + 0.5;
    const padX0 = this._pad.x0, padX1 = this._pad.x1;

    this._addSurface(center);
    this._addCurbs();
    this._addNet(center, w);
    if (this.isStadium) {
      // Show court (StadiumLayout.js): the bowl is the fence. No chain-link, fence bodies, light
      // poles (the stadium masts light it) or court signs (the arch carries the name); low end
      // boards behind the baselines and a body for the umpire chair instead.
      this._addEndBoards(center);
    } else {
      this._addFence(center, w, d);
      if (this._opts.lights !== false) this._addLights(w, d);
    }
    this._addFurniture(w);
    if (!this.isStadium && this._opts.signs !== false) this._addSigns(d);
    this._finalizeParts();

    // Physics: ONE static slab per court covering the playing surface and the
    // surround / clay buffer (two overlapping coplanar boxes double the contacts
    // and friction, which slows walking ~5x). World merges contiguous slabs.
    // The show court has none: its pit floor is the stadium's plane at the court surface.
    const pw = Math.max(w, padX1 - padX0), pd = Math.max(d, 2 * fenceZ);
    const offX = (padX0 + padX1) / 2;
    this.slabBounds = {
      x0: center.x + offX - pw / 2, x1: center.x + offX + pw / 2,
      z0: center.z - pd / 2, z1: center.z + pd / 2,
      y: this.surfaceY,
    };
    this.slabBody = null;
    if (!this.isStadium) {
      this.slabBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(center.x + offX, this.baseY + 0.05, center.z),
        shape: new CANNON.Box(new CANNON.Vec3(pw / 2, 0.1, pd / 2)),
      });
      this.physicsWorld.addBody(this.slabBody);
      this.bodies.push(this.slabBody);
    }
  }

  /**
   * Take this court's bodies out of the physics world (false) or put them back (true): a venue
   * court kept cached while the club is played. World-merged slabs are left alone.
   */
  setBodiesEnabled(on) {
    const W = this.physicsWorld;
    if (!W) return;
    for (const b of this.bodies) {
      const inWorld = W.bodies.includes(b);
      if (on && !inWorld) W.addBody(b);
      else if (!on && inWorld) W.removeBody(b);
    }
  }

  /**
   * Remove the court for good: out of its parent, its bodies out of the physics world, its own
   * geometries, lamp halos and clay mask texture disposed (shared materials and cached
   * geometries stay). Only for courts built on demand (Venues.js); the club never disposes one.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.setBodiesEnabled(false);
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
    for (const ch of this.mesh.children) {
      if (ch.name === 'courtOcclusionTwins') continue;
      if (ch.isPoints) {
        const i = _shared.halos.indexOf(ch);
        if (i >= 0) _shared.halos.splice(i, 1);
      }
      if ((ch.isMesh || ch.isPoints) && ch.geometry) ch.geometry.dispose();
    }
    if (this.dirtTexture) this.dirtTexture.dispose();
    if (this.surfaceMesh && !this._opts.surfaceMaterialKey) this.surfaceMesh.material.dispose();
    this.bodies.length = 0;
  }

  /**
   * Show court end boards (map.json stadium.endBoards): a low windscreen wall behind each
   * baseline (|v| v0..v1, |u| ≤ halfU, height above the surface) — two single-sided panels with
   * the club lettering (the `wind` bucket, so after-hours tennis can fade them), a green cap and
   * five posts; a physics box each. The corners past halfU stay open to walk round.
   */
  _addEndBoards(center) {
    const eb = (this.config.stadium && this.config.stadium.endBoards) || {};
    const v0 = Number.isFinite(eb.v0) ? eb.v0 : 14.3, v1 = Number.isFinite(eb.v1) ? eb.v1 : 14.45;
    const halfU = Number.isFinite(eb.halfU) ? eb.halfU : 9.0, h = Number.isFinite(eb.height) ? eb.height : 1.0;
    const L = 2 * halfU, t = v1 - v0, y0 = SURFACE_Y;
    const green = COLORS.courtFenceGreen;
    const tiles = Math.max(1, Math.round(L / 4));
    const geo = getGeometry(`courtBoard|${L}|${h}|${tiles}`, () => tiledPlane(L, h, tiles, 1));
    for (const sz of [-1, 1]) {
      const zi = sz * v0, zo = sz * v1, zc = sz * (v0 + v1) / 2;
      // PlaneGeometry faces +z: the inner panel faces the court (−sz), the outer one away (+sz)
      this._parts.wind.push({ geometry: geo, matrix: makeMatrix(0, y0 + h / 2, zi, sz > 0 ? Math.PI : 0) });
      this._parts.wind.push({ geometry: geo, matrix: makeMatrix(0, y0 + h / 2, zo, sz > 0 ? 0 : Math.PI) });
      this._add('matte', roundedBox(L + 0.08, 0.06, t + 0.08, 0.02), 0, y0 + h + 0.03, zc, green);
      for (let i = 0; i <= 4; i++) {
        this._add('metal', boxGeo(0.09, h + 0.02, t + 0.06), -halfU + (L * i) / 4, y0 + (h + 0.02) / 2, zc, green);
      }
      const body = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(center.x, this.baseY + y0 + h / 2, center.z + zc),
        shape: new CANNON.Box(new CANNON.Vec3(halfU, h / 2, t / 2)),
      });
      this.physicsWorld.addBody(body);
      this.bodies.push(body);
    }
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

    const paint = this._opts.colors || {};
    const uniforms = {
      uCenter: { value: new THREE.Vector2(center.x, center.z) },
      uCourt: { value: new THREE.Vector4(HALF_W, HALF_L, SINGLES_W, SERVICE_L) },
      uLW: { value: new THREE.Vector2(LINE_W, BASELINE_W) },
      uLineColor: { value: new THREE.Color(paint.line ?? COLORS.courtLine) },
      uInner: { value: new THREE.Color(paint.inner ?? COLORS.courtHardInner) },
      uOuter: { value: new THREE.Color(paint.outer ?? COLORS.courtHardOuter) },
      uBaseMap: {
        value: this.isClay ? Textures.clay() : this.isGrass ? Textures.grassCourt({ tone: COLORS.courtGrass }) : Textures.acrylic(),
      },
      uNoiseMap: { value: Textures.noise({ scale: 8 }) },
      uBaseScale: { value: this.isClay ? 0.26 : this.isGrass ? 0.42 : 0.4 },
      uFlood: _shared.flood,
      uSurfY: { value: this.surfaceY },
    };
    if (this.isClay) {
      uniforms.uDirtMap = { value: this.dirtTexture };
      uniforms.uGrid = { value: new THREE.Vector4(p.x0, p.z0, this.gridCols / MASK_RES, this.gridRows / MASK_RES) };
      uniforms.uStripe = { value: new THREE.Vector2(15, GAME.groomBrushWidth || 3) };
    } else if (this.isGrass) {
      uniforms.uWorn = { value: new THREE.Color(COLORS.courtGrassWorn) };
      uniforms.uEarth = { value: new THREE.Color(COLORS.courtGrassEarth) };
      // ten stripes from the net to each baseline
      uniforms.uMow = { value: new THREE.Vector2(HALF_L / 10, 0.14) };
    }
    this._surfaceUniforms = uniforms;

    let material;
    const key = this._opts.surfaceMaterialKey;
    if (key) {
      // One material per key + surface, rebuilt courts write their values into its uniforms
      material = getMaterial(`${key}|${this.surface}`, () => {
        const m = createSurfaceMaterial(this.surface, uniforms);
        m.userData.courtUniforms = uniforms;
        return m;
      });
      const shared = material.userData.courtUniforms;
      if (shared && shared !== uniforms) {
        for (const k of Object.keys(uniforms)) if (shared[k]) shared[k].value = uniforms[k].value;
        this._surfaceUniforms = shared;
      }
    } else {
      material = createSurfaceMaterial(this.surface, uniforms);
    }
    const surface = new THREE.Mesh(geo, material);
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
    const c = this._opts.colors?.curb ?? (this.isClay ? COLORS.courtCurb : this.isGrass ? COLORS.courtGrassCurb : 0x2c5a40);
    const pw = p.x1 - p.x0;
    const midX = (p.x0 + p.x1) / 2;
    // back edges (under the fences)
    for (const z of [p.z0 + CURB_W / 2, p.z1 - CURB_W / 2]) {
      this._add('matte', boxGeo(pw, h, CURB_W), midX, h / 2, z, c);
    }
    // side edges (skipped where a neighbouring clay court continues the surface)
    const sideLen = p.z1 - p.z0 - CURB_W * 2;
    // (also skipped where two surrounds of the same surface meet: sharedPadSides)
    if (!(this.isClay && this.config.adjacentLeft) && !this._sharedPad.left) {
      this._add('matte', boxGeo(CURB_W, h, sideLen), p.x0 + CURB_W / 2, h / 2, 0, c);
    }
    if (!(this.isClay && this.config.adjacentRight) && !this._sharedPad.right) {
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
      position: new CANNON.Vec3(center.x, this.baseY + SIZES.netHeight / 2, center.z),
      shape: netShape,
    });
    this.physicsWorld.addBody(netBody);
    this.bodies.push(netBody);
  }

  _addFence(center, w, d) {
    // Venue options (defaults: the club's 3 m chain-link over a 1.9 m windscreen, see constructor)
    const fo = this._opts.fence || {};
    const style = fo.style || 'chainlink';
    const fenceH = Number.isFinite(fo.height) ? fo.height : SIZES.fenceHeight;
    const halfU = Number.isFinite(fo.halfU) ? fo.halfU : null;
    const green = fo.color ?? COLORS.courtFenceGreen;
    const wsTop = style === 'windscreen' ? fenceH - 0.3 : WIND_TOP;

    // Back fences (behind baselines) — physics unchanged
    const fences = [
      { pos: [0, fenceH / 2, -d / 2 - 0.5], size: [halfU !== null ? 2 * halfU : w + 2, fenceH, 0.1] },
      { pos: [0, fenceH / 2, d / 2 + 0.5], size: [halfU !== null ? 2 * halfU : w + 2, fenceH, 0.1] },
    ];

    // Visual extents: trim where a neighbouring court's fence continues (no overlap / z-fight)
    const x0 = halfU !== null ? -halfU : this.config.adjacentLeft ? -w / 2 : -w / 2 - 1;
    const x1 = halfU !== null ? halfU : this.config.adjacentRight ? w / 2 : w / 2 + 1;
    const L = x1 - x0;
    const midX = (x0 + x1) / 2;

    if (style === 'hedge') this._addHedges(x0, x1, d / 2 + 0.5, fenceH, fo.sides);
    else if (style !== 'none') {
      for (const f of fences) this._addFenceRun(midX, f.pos[2], L, 0, fenceH, wsTop, green, x0, this.config.adjacentLeft && halfU === null);
      if (fo.sides) {
        // Side fences along the pads' long edges (corner posts shared with the back runs)
        const fz = d / 2 + 0.5;
        for (const x of [x0, x1]) this._addFenceRun(x, 0, 2 * fz, Math.PI / 2, fenceH, wsTop, green, -fz, true, true);
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
      this.bodies.push(fenceBody);
    }
  }

  /**
   * One straight fence run of length L centred on (cx, cz), turned ry about y (0: along x, the
   * back fences): chain-link above wsTop, the windscreen below it (two single-sided panels so the
   * lettering reads from both sides), posts every ≤ 3.2 m (a0 = the run's start in its along
   * coordinate; skipFirst / skipLast leave out an end post shared with another run) and rails.
   */
  _addFenceRun(cx, cz, L, ry, fenceH, wsTop, green, a0, skipFirst = false, skipLast = false) {
    const linkH = fenceH - wsTop + 0.02;
    const tiles = Math.max(1, Math.round(L / 8));
    const baseY = 0;
    const nx = Math.sin(ry), nz = Math.cos(ry);     // the panels' normal
    const dx = Math.cos(ry), dz = -Math.sin(ry);    // along the run
    // chain-link above the windscreen
    this._parts.chain.push({
      geometry: tiledPlane(L, linkH, L / 0.42, linkH / 0.42),
      matrix: makeMatrix(cx, wsTop - 0.02 + linkH / 2, cz, ry),
    });
    // windscreen: two single-sided panels so the lettering reads correctly from both sides
    const wsH = wsTop - 0.05;
    const wsGeo = getGeometry(`courtWind|${L}|${wsH}|${tiles}`, () => tiledPlane(L, wsH, tiles, 1));
    this._parts.wind.push({ geometry: wsGeo, matrix: makeMatrix(cx + nx * 0.012, 0.05 + wsH / 2, cz + nz * 0.012, ry) });
    this._parts.wind.push({ geometry: wsGeo, matrix: makeMatrix(cx - nx * 0.012, 0.05 + wsH / 2, cz - nz * 0.012, ry + Math.PI) });

    // posts
    const n = Math.max(1, Math.ceil(L / 3.2));
    const aMid = a0 + L / 2;
    for (let i = 0; i <= n; i++) {
      if ((i === 0 && skipFirst) || (i === n && skipLast)) continue;
      const a = a0 + (L * i) / n;
      const x = ry === 0 ? a : cx + (a - aMid) * dx;
      const z = ry === 0 ? cz : cz + (a - aMid) * dz;
      const end = i === 0 || i === n;
      const r = end ? 0.06 : 0.045;
      this._add('metal', cylinderGeo(r, r, fenceH + 0.05, 8), x, baseY + (fenceH + 0.05) / 2, z, green);
      this._add('metal', sphereGeo(r * 1.15, 8, 5), x, fenceH + 0.05, z, green);
    }
    // rails: top, windscreen top, bottom tension
    for (const [y, r] of [[fenceH, 0.035], [wsTop, 0.025], [0.08, 0.018]]) {
      this._add('metal', cylinderGeo(r, r, L, 6), cx, y, cz, green, ry, 1, 0, Math.PI / 2);
    }
  }

  /**
   * Clipped hedges instead of fences (a lawn club): a tall hedge behind each baseline (its court
   * face on the fence line) across x0..x1, and, with `sides`, low hedges along the side edges
   * with a gap either side of the net. Merged into the fadeable 'hedge' bucket.
   */
  _addHedges(x0, x1, fz, fenceH, sides) {
    const h = Math.min(fenceH, 2.1), depth = 0.9, L = x1 - x0;
    const piece = (w, hh, dd, x, y, z) => {
      const g = roundedBox(w, hh, dd, 0.16, 2).clone();
      g.applyMatrix4(_m4.makeTranslation(x, y, z));
      projectUV(g, 2.5);
      this._parts.hedge.push({ geometry: g, matrix: null });
    };
    for (const sz of [-1, 1]) piece(L, h, depth, (x0 + x1) / 2, h / 2, sz * (fz + depth / 2));
    if (sides) {
      const sh = 0.95, gap = 1.6, len = fz - gap;
      for (const x of [x0 - 0.35, x1 + 0.35]) {
        for (const sz of [-1, 1]) piece(0.7, sh, len, x, sh / 2, sz * (gap + len / 2));
      }
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
        if (this.isStadium) {
          // Show courts: a body over the chair's footprint (the pit is walked, routes go round it)
          const body = new CANNON.Body({
            mass: 0,
            position: new CANNON.Vec3(this.config.center.x - (w / 2 + 0.95), this.surfaceY + 1.2, this.config.center.z),
            shape: new CANNON.Box(new CANNON.Vec3(0.5, 1.2, 0.6)),
          });
          this.physicsWorld.addBody(body);
          this.bodies.push(body);
        }
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

    // Stray balls near the back fences (a venue's tournament court is swept clean)
    const r = this._rand;
    const nBalls = this._opts.strayBalls === false ? 0 : 3 + Math.floor(r() * 3);
    for (let i = 0; i < nBalls; i++) {
      const x = (r() - 0.5) * (w - 2);
      let z = (r() < 0.5 ? -1 : 1) * (13.4 + r() * 0.9);
      if (this.isStadium) z = Math.sign(z) * Math.min(Math.abs(z), 14.2);   // in front of the end boards
      this._add('matte', sphereGeo(0.045, 8, 6), x, this._surfaceY(x, z) + 0.045, z, COLORS.tennisBall);
    }

    // Clay-court maintenance bits
    if (this.isClay && !this.config.adjacentLeft) this._addLineBroom(-w / 2 + 0.6, -14.2);
    if (this.isClay && !this.config.adjacentRight) this._addHoseReel(w / 2 + 2.5, -13.6);
    // Grass: the line-marking trolley parked by the back fence. On a show court it stands on the
    // walkway in the corner past the end boards' west end (the boards stop at |u| 9): after-hours
    // tennis fades what stands behind the camera's baseline only above 0.28 m, so behind the
    // baseline its wheels' lower halves stayed solid in view; neither end camera sees this corner.
    if (this.isGrass) {
      if (this.isStadium) this._addLineMarker(-10.3, -14.7, SURFACE_Y);
      else this._addLineMarker(-5.2, -13.55);
    }
  }

  /** Wheeled chalk line marker (grass courts), handle toward the fence; y: its ground (court-local). */
  _addLineMarker(x, z, y = this._surfaceY(x, z)) {
    const green = COLORS.courtFenceGreen, dark = 0x3a3f3a;
    this._add('matte', roundedBox(0.34, 0.24, 0.46, 0.05), x, y + 0.27, z, 0xe9e5d8);
    this._add('matte', roundedBox(0.36, 0.04, 0.48, 0.015), x, y + 0.4, z, green);
    for (const sx of [-1, 1]) {
      this._add('metal', cylinderGeo(0.13, 0.13, 0.04, 14), x + sx * 0.2, y + 0.13, z - 0.1, dark, 0, 1, 0, Math.PI / 2);
      this._add('metal', cylinderGeo(0.045, 0.045, 0.05, 10), x + sx * 0.2, y + 0.13, z - 0.1, 0xb0b5b0, 0, 1, 0, Math.PI / 2);
      // handle tubes rising toward the fence
      this._add('metal', cylinderGeo(0.014, 0.014, 0.78, 6), x + sx * 0.13, y + 0.62, z - 0.47, green, 0, 1, -0.62, 0);
    }
    this._add('metal', cylinderGeo(0.07, 0.07, 0.03, 12), x, y + 0.07, z + 0.2, dark, 0, 1, 0, Math.PI / 2);
    this._add('metal', cylinderGeo(0.02, 0.02, 0.34, 8), x, y + 0.94, z - 0.7, 0x2a2d2a, 0, 1, 0, Math.PI / 2);
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
      ['wind', this._opts.windscreenMaterial || M.windscreen, true, true],
      ['net', M.net, false, true],
      ['sign', M.sign, false, true],
      ['glass', M.lampGlass, false, false],
      ['hedge', null, true, true],
    ];
    for (const [key, specMaterial, cast, receive] of spec) {
      const parts = this._parts[key];
      if (!parts.length) continue;
      const material = specMaterial || hedgeMaterial();   // (only a hedge fence has hedge parts)
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
