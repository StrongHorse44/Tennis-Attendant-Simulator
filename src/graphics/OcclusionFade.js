import * as THREE from 'three';

/**
 * OcclusionFade — screen-door "see-through" for static scenery that stands between a gameplay
 * camera and the action (after-hours tennis: floodlight poles and heads, fence posts, rails,
 * windscreen, chain-link and sign boards behind the near baseline).
 *
 *   import { withOcclusionFade, OCC_UNIFORMS } from '../graphics/OcclusionFade.js';
 *   const m = getMaterial('courtMetal', () => withOcclusionFade(new THREE.MeshStandardMaterial({...})));
 *   OCC_UNIFORMS.uOccK.value = 0.8;   // a driver (src/tennis/TennisOcclusion.js) writes the uniforms
 *
 * withOcclusionFade(material) patches the material ONCE, when it is created: onBeforeCompile
 * adds a world-position varying and a fragment `discard` driven only by the shared uniforms
 * below, with an explicit customProgramCacheKey (chained with any hook the material already
 * had). So the programs compile with the rest of the scene at load, nothing compiles when a
 * fade starts, and toggling the fade is uniform writes only (no define, no `transparent`).
 * With uOccK at 0 (the normal game) the branch is skipped and the output is unchanged.
 *
 * The fade region is described in a court frame (u across, v along the court, like
 * TennisSession's CourtFrame):
 *   - the half-space behind a baseline (|v| past zone.x) for either end, each with its own
 *     strength (ends.x for +v, ends.y for -v), limited across the court to |u| < zone.y
 *     (feathered over zone.z) so neighbouring courts stay solid;
 *   - a capsule-ish segment from the camera toward up to two foci (the player's chest, the
 *     ball) that stops 0.9 m short of the focus, applied only on the camera's side of the net
 *     (v * ends.w > ends.z), so the net band and posts are never touched;
 *   - everything below zone.w (curbs, base plates, stray balls, the court surface) stays.
 * Pixels are removed with a 4x4 Bayer threshold on gl_FragCoord: stable on screen, and at the
 * usual strength (uOccK ~0.87) 2 of every 16 pixels remain as a faint ghost of the structure.
 *
 * Shadows are untouched (depth materials are not patched): faded poles still cast shadows.
 * GTAO draws its gbuffer with an override material, so a driver should also flag faded
 * meshes userData.noAO while fading (PostFX already skips those).
 */

/** Shared uniforms (the same objects go into every patched program). */
export const OCC_UNIFORMS = {
  /** Master strength: fraction of pixels removed at full fade (0 = off, the normal game). */
  uOccK: { value: 0 },
  /** Court frame: centre x, centre z, cos(rotation), sin(rotation). */
  uOccFrame: { value: new THREE.Vector4(0, 0, 1, 0) },
  /** x: |v| where the baseline fade starts (full 0.5 m further), y: |u| limit, z: u feather, w: minimum world y. */
  uOccZone: { value: new THREE.Vector4(12.8, 10.2, 0.6, 0.28) },
  /** x: +v end strength, y: -v end strength, z: net guard for the segments (m), w: camera end sign. */
  uOccEnds: { value: new THREE.Vector4(0, 0, 1.2, 0) },
  /** Segment focus 1 (world xyz) and radius (w <= 0: off). */
  uOccA: { value: new THREE.Vector4(0, 0, 0, 0) },
  /** Segment focus 2 (world xyz) and radius (w <= 0: off). */
  uOccB: { value: new THREE.Vector4(0, 0, 0, 0) },
};

const CACHE_KEY = 'occfade1';
const _patched = new WeakSet(); // not userData: clone() copies userData but not the hook

const VERT_HEAD = /* glsl */`
varying vec3 vOccW;
`;
const VERT_BODY = /* glsl */`
{
  vec4 occP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    occP = batchingMatrix * occP;
  #endif
  #ifdef USE_INSTANCING
    occP = instanceMatrix * occP;
  #endif
  vOccW = ( modelMatrix * occP ).xyz;
}
`;

const FRAG_HEAD = /* glsl */`
varying vec3 vOccW;
uniform float uOccK;
uniform vec4 uOccFrame;
uniform vec4 uOccZone;
uniform vec4 uOccEnds;
uniform vec4 uOccA;
uniform vec4 uOccB;
float occBayer2( vec2 a ) { a = mod( floor( a ), 2.0 ); return fract( a.x * 0.5 + a.y * 0.75 ); } // exact at any resolution
float occSeg( vec3 p, vec4 f ) {
  if ( f.w <= 0.0 ) return 0.0;
  vec3 d = f.xyz - cameraPosition;
  float len = length( d );
  vec3 dir = d / max( len, 1e-3 );
  vec3 q = p - cameraPosition;
  float t = dot( q, dir );
  float tEnd = len - 0.9;
  if ( t <= 0.0 || t >= tEnd ) return 0.0;
  float r = length( q - dir * t );
  return ( 1.0 - smoothstep( 0.6 * f.w, f.w, r ) ) * smoothstep( 0.0, 0.6, tEnd - t );
}
`;
const FRAG_BODY = /* glsl */`
if ( uOccK > 0.0 ) {
  vec2 occD = vOccW.xz - uOccFrame.xy;
  float occU = occD.x * uOccFrame.z - occD.y * uOccFrame.w;
  float occV = occD.x * uOccFrame.w + occD.y * uOccFrame.z;
  float occAcross = 1.0 - smoothstep( uOccZone.y, uOccZone.y + uOccZone.z, abs( occU ) );
  float occF = max( uOccEnds.x * smoothstep( uOccZone.x, uOccZone.x + 0.5, occV ),
                    uOccEnds.y * smoothstep( uOccZone.x, uOccZone.x + 0.5, -occV ) ) * occAcross;
  if ( occV * uOccEnds.w > uOccEnds.z ) occF = max( occF, max( occSeg( vOccW, uOccA ), occSeg( vOccW, uOccB ) ) );
  occF *= uOccK * smoothstep( uOccZone.w, uOccZone.w + 0.2, vOccW.y );
  if ( occF > occBayer2( gl_FragCoord.xy * 0.5 ) * 0.25 + occBayer2( gl_FragCoord.xy ) ) discard;
}
`;

function inject(shader) {
  const vs = shader.vertexShader, fs = shader.fragmentShader;
  if (!vs.includes('#include <common>') || !vs.includes('#include <project_vertex>')) return;
  if (!fs.includes('#include <common>') || !fs.includes('#include <clipping_planes_fragment>')) return;
  Object.assign(shader.uniforms, OCC_UNIFORMS);
  shader.vertexShader = vs
    .replace('#include <common>', '#include <common>\n' + VERT_HEAD)
    .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);
  shader.fragmentShader = fs
    .replace('#include <common>', '#include <common>\n' + FRAG_HEAD)
    .replace('#include <clipping_planes_fragment>', FRAG_BODY + '\n#include <clipping_planes_fragment>');
}

/**
 * Patch a material (built-in lit / unlit mesh materials: MeshStandard, MeshBasic, ...) so it
 * follows OCC_UNIFORMS. Call it once, when the material is created, on a material owned by the
 * caller (a named getMaterial(), never a parameter-cached mat() that other code may share).
 * Idempotent. Returns the material.
 */
export function withOcclusionFade(material) {
  if (!material || _patched.has(material)) return material;
  const baseCompile = THREE.Material.prototype.onBeforeCompile;
  const baseKey = THREE.Material.prototype.customProgramCacheKey;
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  const hasHook = prevCompile !== baseCompile;
  const hasKey = prevKey !== baseKey;
  const prevHookSrc = hasHook && !hasKey ? prevCompile.toString() : '';
  material.onBeforeCompile = function (shader, renderer) {
    if (hasHook) prevCompile.call(this, shader, renderer);
    inject(shader);
  };
  material.customProgramCacheKey = function () {
    const k = hasKey ? prevKey.call(this) : prevHookSrc;
    return k ? `${k}|${CACHE_KEY}` : CACHE_KEY;
  };
  _patched.add(material);
  return material;
}

/** True for a material patched by withOcclusionFade. */
export function isOcclusionFaded(material) {
  return !!material && _patched.has(material);
}

/** Turn the fade off (the normal game): master strength, ends and segments to zero. */
export function resetOcclusionFade() {
  const u = OCC_UNIFORMS;
  u.uOccK.value = 0;
  u.uOccEnds.value.x = 0;
  u.uOccEnds.value.y = 0;
  u.uOccEnds.value.w = 0;
  u.uOccA.value.w = 0;
  u.uOccB.value.w = 0;
}
