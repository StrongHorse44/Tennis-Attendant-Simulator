import * as THREE from 'three';
import {
  BONE_DEFS, ANIMATED_BONES, HIP_Y, LEG_X, THIGH_LEN, SHIN_LEN, ANKLE_Y, RACKET_HEAD_OFFSET,
} from './CharacterRig.js';

/**
 * CharacterAnimations — a small, data-driven clip library for the stylized characters.
 *
 * Clips are authored below (CLIP_DEFS) as sparse key poses: per-bone Euler angles in DEGREES
 * (order 'YXZ', see CharacterRig.js for the sign conventions), an optional hips offset and
 * optional leg IK targets that keep feet planted. At first use every clip is resampled at
 * 30 fps with time-aware Catmull-Rom splines (per-key easing) and baked into a
 * THREE.AnimationClip of QuaternionKeyframeTracks ('<bone>.quaternion') plus one
 * VectorKeyframeTrack ('hips.position'). All characters share the same AnimationClip objects.
 *
 * `Animator` wraps one THREE.AnimationMixer per character and adds:
 *  - a locomotion layer (idle / walk / run blended by speed, phase-synced),
 *  - a looping "base" clip that replaces locomotion (talk, sit, drive, ready, shuffle...),
 *  - one-shot clips that play over the base and fade back to it (swings, reactions...),
 *  - manual crossfading, clip events (e.g. 'contact'), held-ball timelines and idle variants.
 *
 * Key pose fields (all optional; a missing field falls back to the clip's `base`, then rest):
 *   t            seconds
 *   ease         'linear' (default) | 'in' | 'out' | 'inOut' — easing of the segment AFTER this key
 *   <bone>       [x, y, z] degrees — hips, spine, chest, head, armL/R, foreArmL/R, handL/R, racket,
 *                legL/R, shinL/R, footL/R
 *   hipsPos      [dx, dy, dz] offset of the hips from the bind pose (model units)
 *   ik: { L, R } [x, y, z, yawDeg, pitchDeg] sole target in model space (y = 0 is the ground).
 *                Overrides leg/shin/foot of that side. yaw turns the toes (+ = toward +X),
 *                pitch tips the foot (+ = toes down / heel up).
 */

const DEG = Math.PI / 180;
const FPS = 30;

// ───────────────────────────── Authoring helpers ─────────────────────────────

const SIDES = [['armL', 'armR'], ['foreArmL', 'foreArmR'], ['handL', 'handR'], ['legL', 'legR'], ['shinL', 'shinR'], ['footL', 'footR']];
const AXIAL = ['hips', 'spine', 'chest', 'head'];

/** Left/right mirror of a pose (negates yaw/roll). `legsOnly` keeps the upper body as is. */
function mirror(p, legsOnly = false) {
  const out = { ...p };
  const flip = (v) => (v ? [v[0], -v[1], -v[2]] : v);
  const pairs = legsOnly ? SIDES.slice(3) : SIDES;
  for (const [l, r] of pairs) {
    const a = p[l], b = p[r];
    if (a !== undefined || b !== undefined) {
      out[l] = flip(b); out[r] = flip(a);
      if (out[l] === undefined) delete out[l];
      if (out[r] === undefined) delete out[r];
    }
  }
  if (legsOnly) {
    if (p.hips) out.hips = flip(p.hips);
  } else {
    for (const k of AXIAL) if (p[k]) out[k] = flip(p[k]);
  }
  if (p.hipsPos) out.hipsPos = [-p.hipsPos[0], p.hipsPos[1], p.hipsPos[2]];
  if (p.ik) {
    const m = (v) => (v ? [-v[0], v[1], v[2], v[3] !== undefined ? -v[3] : undefined, v[4]] : v);
    out.ik = {};
    if (p.ik.R) out.ik.L = m(p.ik.R);
    if (p.ik.L) out.ik.R = m(p.ik.L);
  }
  return out;
}

/** Shift a list of keys in time. */
const at = (t, pose) => ({ ...pose, t });

// ───────────────────────────── Shared poses ─────────────────────────────

const STAND = {
  hipsPos: [0, -0.012, 0],
  ik: { L: [0.11, 0, 0.01, 8], R: [-0.11, 0, 0.01, -8] },
  spine: [2, 0, 0], chest: [1, 0, 0],
  armL: [2, 0, 6], armR: [2, 0, -6], foreArmL: [-10, 0, 0], foreArmR: [-10, 0, 0],
  handL: [0, 0, 0], handR: [0, 0, 0], racket: [-18, 0, 0],
};

const READY = {
  hipsPos: [0, -0.11, 0.0],
  hips: [8, 0, 0], spine: [14, 0, 0], chest: [6, 0, 0], head: [-22, 0, 0],
  ik: { L: [0.25, 0, 0.03, 14], R: [-0.25, 0, 0.03, -14] },
  armR: [-30, 0, 14], foreArmR: [-72, 22, 0], handR: [-62, 0, 0], racket: [0, 0, 0],
  armL: [-38, 0, -14], foreArmL: [-82, -38, 0], handL: [0, 0, 0],
};

const HANDS_ON_HIPS = {
  armR: [12, 0, -42], foreArmR: [-20, 0, 105], handR: [0, 0, 0],
  armL: [12, 0, 42], foreArmL: [-20, 0, -105], handL: [0, 0, 0],
};

// Walk (one cycle = two steps); the second half mirrors the first.
const WALK_HALF = [
  { t: 0, // right heel strike
    hipsPos: [0, -0.022, 0], hips: [0, 6, 0], spine: [4, 0, 0], chest: [2, -10, 0], head: [-2, 4, 0],
    legR: [-25, 0, 0], shinR: [5, 0, 0], footR: [-14, 0, 0],
    legL: [18, 0, 0], shinL: [24, 0, 0], footL: [22, 0, 0],
    armR: [20, 0, -6], foreArmR: [-10, 0, 0], armL: [-22, 0, 6], foreArmL: [-32, 0, 0] },
  { t: 0.125, // loading response
    hipsPos: [0, -0.035, 0], hips: [0, 4, -2],
    legR: [-17, 0, 0], shinR: [14, 0, 0], footR: [0, 0, 0],
    legL: [14, 0, 0], shinL: [48, 0, 0], footL: [28, 0, 0],
    armR: [12, 0, -6], foreArmR: [-14, 0, 0], armL: [-14, 0, 6], foreArmL: [-26, 0, 0] },
  { t: 0.25, // passing
    hipsPos: [0, 0.004, 0], hips: [0, 0, -2], chest: [2, 0, 0], head: [-2, 0, 0],
    legR: [-2, 0, 0], shinR: [6, 0, 0], footR: [2, 0, 0],
    legL: [-14, 0, 0], shinL: [64, 0, 0], footL: [-6, 0, 0],
    armR: [0, 0, -6], foreArmR: [-18, 0, 0], armL: [0, 0, 6], foreArmL: [-18, 0, 0] },
  { t: 0.375, // right toe-off approaching
    hipsPos: [0, 0.01, 0], hips: [0, -4, 0],
    legR: [13, 0, 0], shinR: [9, 0, 0], footR: [10, 0, 0],
    legL: [-27, 0, 0], shinL: [28, 0, 0], footL: [-12, 0, 0],
    armR: [-12, 0, -6], foreArmR: [-26, 0, 0], armL: [12, 0, 6], foreArmL: [-14, 0, 0] },
];

const RUN_HALF = [
  { t: 0, // right foot strike
    hipsPos: [0, -0.045, 0], hips: [0, 10, 0], spine: [10, 0, 0], chest: [4, -14, 0], head: [-10, 6, 0],
    legR: [-36, 0, 0], shinR: [18, 0, 0], footR: [-8, 0, 0],
    legL: [22, 0, 0], shinL: [78, 0, 0], footL: [25, 0, 0],
    armR: [38, 0, -10], foreArmR: [-72, 0, 0], armL: [-44, 0, 10], foreArmL: [-96, 0, 0], racket: [-35, 0, 0] },
  { t: 0.125, // mid stance
    hipsPos: [0, -0.07, 0], hips: [0, 5, 0],
    legR: [-8, 0, 0], shinR: [32, 0, 0], footR: [4, 0, 0],
    legL: [-12, 0, 0], shinL: [112, 0, 0], footL: [12, 0, 0],
    armR: [22, 0, -10], foreArmR: [-80, 0, 0], armL: [-24, 0, 10], foreArmL: [-90, 0, 0] },
  { t: 0.25, // toe-off
    hipsPos: [0, 0.0, 0], hips: [0, -4, 0], chest: [4, 0, 0],
    legR: [26, 0, 0], shinR: [22, 0, 0], footR: [32, 0, 0],
    legL: [-52, 0, 0], shinL: [82, 0, 0], footL: [-4, 0, 0],
    armR: [0, 0, -10], foreArmR: [-88, 0, 0], armL: [0, 0, 10], foreArmL: [-84, 0, 0] },
  { t: 0.375, // flight
    hipsPos: [0, 0.03, 0], hips: [0, -8, 0],
    legR: [18, 0, 0], shinR: [74, 0, 0], footR: [22, 0, 0],
    legL: [-44, 0, 0], shinL: [40, 0, 0], footL: [-12, 0, 0],
    armR: [-30, 0, -10], foreArmR: [-96, 0, 0], armL: [30, 0, 10], foreArmL: [-74, 0, 0] },
];

function cycle(half, dur) {
  const keys = half.map(k => ({ ...k, t: k.t * dur }));
  for (const k of half) keys.push({ ...mirror(k), t: (k.t + 0.5) * dur });
  keys.push({ ...half[0], t: dur });
  return keys;
}

// Shuffle to the character's left (+X): trail foot closes, lead foot pushes out.
const SHUFFLE_L = [
  { t: 0, ik: { L: [0.30, 0, 0.02, 12], R: [-0.25, 0, 0.02, -12] }, hipsPos: [0.03, -0.14, 0] },
  { t: 0.05, ik: { L: [0.27, 0, 0.02, 12], R: [-0.28, 0, 0.02, -12] }, hipsPos: [0.03, -0.14, 0] },
  { t: 0.125, ik: { L: [0.23, 0, 0.02, 12], R: [-0.17, 0.08, 0.02, -12, 10] }, hipsPos: [0.05, -0.1, 0] },
  { t: 0.2, ik: { L: [0.18, 0, 0.02, 12], R: [-0.07, 0, 0.02, -12] }, hipsPos: [0.06, -0.11, 0] },
  { t: 0.25, ik: { L: [0.15, 0, 0.02, 12], R: [-0.10, 0, 0.02, -12] }, hipsPos: [0.04, -0.12, 0] },
  { t: 0.35, ik: { L: [0.25, 0.08, 0.02, 12, 10], R: [-0.16, 0, 0.02, -12] }, hipsPos: [0.05, -0.1, 0] },
  { t: 0.45, ik: { L: [0.33, 0, 0.02, 12], R: [-0.22, 0, 0.02, -12] }, hipsPos: [0.04, -0.14, 0] },
  { t: 0.5, ik: { L: [0.30, 0, 0.02, 12], R: [-0.25, 0, 0.02, -12] }, hipsPos: [0.03, -0.14, 0] },
];

// ───────────────────────────── Clip definitions ─────────────────────────────

/**
 * name → { duration, loop, base, keys, events?, ball?, ballOnEnd?, fade?, fadeOut?, stride?, speed? }
 *  - events: { name: seconds } fired by Animator (onClipEvent) when playback crosses them
 *  - ball:   [[t, visible], ...] held-ball visibility timeline while the clip plays
 *  - stride: model units travelled per cycle (walk/run); speed: model units/s at timeScale 1 (shuffle)
 */
export const CLIP_DEFS = {
  // ── Idle family ──
  idle: {
    duration: 4, loop: true, base: STAND,
    keys: [
      { t: 0, hips: [0, 0, 1], head: [0, 0, 0] },
      { t: 2, hips: [0, 0, -1], hipsPos: [0.008, -0.015, 0], chest: [3, 2, 0], head: [2, -6, 1], armL: [3, 0, 7], armR: [3, 0, -7] },
      { t: 4, hips: [0, 0, 1], head: [0, 0, 0] },
    ],
  },
  idle_look: {
    duration: 4.2, base: STAND,
    keys: [
      { t: 0, ease: 'inOut', hips: [0, 0, 1] },
      { t: 0.8, head: [-3, 48, 0], chest: [2, 12, 0] },
      { t: 1.8, ease: 'inOut', head: [-5, 52, 3], chest: [2, 14, 0] },
      { t: 2.6, head: [2, -42, -2], chest: [2, -12, 0] },
      { t: 3.4, ease: 'inOut', head: [3, -46, 0], chest: [2, -13, 0] },
      { t: 4.2, hips: [0, 0, 1] },
    ],
  },
  idle_shift: {
    duration: 4.4, base: STAND,
    keys: [
      { t: 0, ease: 'inOut', hips: [0, 0, 1] },
      { t: 0.9, hipsPos: [0.045, -0.02, 0], hips: [0, 6, 6], spine: [2, 0, -3], chest: [1, -4, -3], head: [0, 10, -5],
        ik: { L: [0.1, 0, 0.0, 8], R: [-0.15, 0, 0.1, -20, 8] }, armL: [4, 0, 9], armR: [-4, 0, -9] },
      { t: 3.3, ease: 'inOut', hipsPos: [0.05, -0.022, 0], hips: [0, 5, 7], spine: [2, 0, -3], chest: [1, -2, -3], head: [3, -14, -3],
        ik: { L: [0.1, 0, 0.0, 8], R: [-0.15, 0, 0.1, -20, 8] }, armL: [4, 0, 9], armR: [-4, 0, -9] },
      { t: 4.4, hips: [0, 0, 1] },
    ],
  },
  idle_watch: {
    duration: 3.4, base: STAND,
    keys: [
      { t: 0, ease: 'inOut' },
      { t: 0.55, armL: [-30, 0, 2], foreArmL: [-108, -52, 0], handL: [-10, 0, 0], head: [22, 14, 0], chest: [3, 6, 0] },
      { t: 1.9, ease: 'inOut', armL: [-32, 0, 2], foreArmL: [-110, -52, 0], handL: [-10, 0, 0], head: [26, 16, 2], chest: [3, 6, 0] },
      { t: 2.5, head: [-2, -6, 0] },
      { t: 3.4 },
    ],
  },

  // ── Locomotion ──
  walk: { duration: 1, loop: true, base: { ...STAND, ik: undefined }, keys: cycle(WALK_HALF, 1), stride: 1.45 },
  run: { duration: 1, loop: true, base: { ...STAND, ik: undefined }, keys: cycle(RUN_HALF, 1), stride: 2.4 },

  // ── Social ──
  talk: {
    duration: 4.8, loop: true, base: STAND,
    keys: [
      { t: 0, armR: [-8, 0, -8], foreArmR: [-42, 0, 0], armL: [-4, 0, 8], foreArmL: [-26, 0, 0] },
      { t: 0.8, armR: [-34, 0, -22], foreArmR: [-78, 28, 0], handR: [-10, 0, 0], head: [-4, -6, 3], chest: [0, -7, 0] },
      { t: 1.4, armR: [-24, 0, -14], foreArmR: [-56, 10, 0], head: [5, -2, 0] },
      { t: 2.2, armR: [-24, 0, -26], armL: [-24, 0, 26], foreArmR: [-70, 32, 0], foreArmL: [-70, -32, 0], chest: [-2, 0, 0], head: [-5, 0, 0], hipsPos: [0, -0.005, 0] },
      { t: 3.0, armL: [-40, 0, 18], foreArmL: [-84, -22, 0], armR: [-8, 0, -8], foreArmR: [-38, 0, 0], head: [2, 9, -3], chest: [2, 7, 0] },
      { t: 3.8, armL: [-20, 0, 10], foreArmL: [-50, -8, 0], head: [7, 4, 0] },
      { t: 4.8, armR: [-8, 0, -8], foreArmR: [-42, 0, 0], armL: [-4, 0, 8], foreArmL: [-26, 0, 0] },
    ],
  },
  greet: {
    duration: 1.5, base: STAND,
    keys: [
      { t: 0, ease: 'out' },
      { t: 0.35, armR: [-40, 0, -34], foreArmR: [-44, 0, 0], handR: [-10, 0, 0], head: [14, 0, 0], chest: [5, 0, 0] },
      { t: 0.75, ease: 'inOut', armR: [-38, 0, -32], foreArmR: [-40, 0, 0], head: [-4, 0, 2], chest: [2, 0, 0] },
      { t: 1.5 },
    ],
  },
  wave: {
    duration: 2.3, base: STAND,
    keys: [
      { t: 0, ease: 'out' },
      { t: 0.35, armR: [0, 0, -150], foreArmR: [0, 0, 32], chest: [0, 0, -4], head: [-6, 0, 5] },
      { t: 0.6, foreArmR: [0, 0, -12], armR: [0, 0, -148], chest: [0, 0, -4], head: [-6, 0, 5] },
      { t: 0.85, foreArmR: [0, 0, 32], armR: [0, 0, -150], chest: [0, 0, -4], head: [-6, 0, 5] },
      { t: 1.1, foreArmR: [0, 0, -12], armR: [0, 0, -148], chest: [0, 0, -4], head: [-6, 0, 5] },
      { t: 1.35, foreArmR: [0, 0, 32], armR: [0, 0, -150], chest: [0, 0, -4], head: [-6, 0, 5] },
      { t: 1.6, ease: 'inOut', foreArmR: [0, 0, 8], armR: [0, 0, -146], chest: [0, 0, -4], head: [-6, 0, 5] },
      { t: 2.3 },
    ],
  },
  react_happy: {
    duration: 2.0, base: STAND,
    keys: [
      { t: 0, ease: 'inOut' },
      { t: 0.22, ease: 'in', hipsPos: [0, -0.1, 0], ik: { L: [0.12, 0, 0.02, 8], R: [-0.12, 0, 0.02, -8] }, spine: [16, 0, 0], head: [10, 0, 0],
        armR: [24, 0, -18], armL: [24, 0, 18], foreArmR: [-30, 0, 0], foreArmL: [-30, 0, 0] },
      { t: 0.45, ease: 'out', hipsPos: [0, 0.11, 0], ik: { L: [0.12, 0.13, 0.0, 8, 25], R: [-0.12, 0.13, 0.0, -8, 25] }, spine: [-8, 0, 0], head: [-16, 0, 0],
        armR: [-10, 0, -158], armL: [-10, 0, 158], foreArmR: [-18, 0, 0], foreArmL: [-18, 0, 0] },
      { t: 0.7, ease: 'out', hipsPos: [0, -0.07, 0], ik: { L: [0.12, 0, 0.02, 8], R: [-0.12, 0, 0.02, -8] }, spine: [8, 0, 0], head: [-4, 0, 0],
        armR: [-10, 0, -140], armL: [-10, 0, 140], foreArmR: [-30, 0, 0], foreArmL: [-30, 0, 0] },
      { t: 1.0, hipsPos: [0, 0.0, 0], armR: [-20, 0, -120], armL: [-20, 0, 120], foreArmR: [-80, 0, 0], foreArmL: [-80, 0, 0], head: [-10, 0, 0] },
      { t: 1.25, ease: 'inOut', hipsPos: [0, -0.02, 0], armR: [-45, 0, -30], armL: [-45, 0, 30], foreArmR: [-120, 0, 0], foreArmL: [-120, 0, 0], spine: [6, 0, 0], head: [4, 0, 0] },
      { t: 2.0 },
    ],
  },
  react_annoyed: {
    duration: 2.8, base: STAND,
    keys: [
      { t: 0, ease: 'out' },
      { t: 0.4, ...HANDS_ON_HIPS, chest: [-5, 0, 0], head: [-8, 0, 0], hipsPos: [0.03, -0.015, 0], hips: [0, 0, 5] },
      { t: 0.8, ...HANDS_ON_HIPS, chest: [-5, 0, 0], head: [-6, -20, 0], hipsPos: [0.03, -0.015, 0], hips: [0, 0, 5], ik: { R: [-0.14, 0, 0.1, -12, -18] } },
      { t: 1.1, ...HANDS_ON_HIPS, chest: [-5, 0, 0], head: [-6, 20, 0], hipsPos: [0.03, -0.015, 0], hips: [0, 0, 5], ik: { R: [-0.14, 0, 0.1, -12, 0] } },
      { t: 1.4, ...HANDS_ON_HIPS, chest: [-5, 0, 0], head: [-6, -16, 0], hipsPos: [0.03, -0.015, 0], hips: [0, 0, 5], ik: { R: [-0.14, 0, 0.1, -12, -18] } },
      { t: 1.7, ...HANDS_ON_HIPS, chest: [-5, 0, 0], head: [-8, 8, 0], hipsPos: [0.03, -0.015, 0], hips: [0, 0, 5], ik: { R: [-0.14, 0, 0.1, -12, 0] } },
      { t: 2.2, ease: 'inOut', ...HANDS_ON_HIPS, chest: [-4, 0, 0], head: [-10, 0, 0], hipsPos: [0.03, -0.015, 0], hips: [0, 0, 5], ik: { R: [-0.14, 0, 0.1, -12, 0] } },
      { t: 2.8 },
    ],
  },
  shrug: {
    duration: 1.7, base: STAND,
    keys: [
      { t: 0, ease: 'out' },
      { t: 0.4, armR: [-6, 0, -22], foreArmR: [-82, -48, 0], armL: [-6, 0, 22], foreArmL: [-82, 48, 0], chest: [-5, 0, 0], head: [0, 0, -14], hipsPos: [0, 0.01, 0] },
      { t: 0.95, ease: 'inOut', armR: [-6, 0, -24], foreArmR: [-80, -50, 0], armL: [-6, 0, 24], foreArmL: [-80, 50, 0], chest: [-5, 0, 0], head: [2, 0, -12], hipsPos: [0, 0.01, 0] },
      { t: 1.7 },
    ],
  },

  // ── Seated ──
  sit: {
    duration: 6, loop: true,
    base: {
      hipsPos: [0, -0.07, 0], hips: [-6, 0, 0], spine: [14, 0, 0], chest: [4, 0, 0], head: [-10, 0, 0],
      legL: [-48, 0, 5], legR: [-48, 0, -5], shinL: [44, 0, 0], shinR: [44, 0, 0], footL: [6, 0, 0], footR: [6, 0, 0],
      armL: [-26, 0, -6], armR: [-26, 0, 6], foreArmL: [-34, 0, 0], foreArmR: [-34, 0, 0], racket: [-40, 0, 0],
    },
    keys: [
      { t: 0 },
      { t: 2.2, ease: 'inOut', head: [-8, 22, 0], chest: [4, 5, 0] },
      { t: 3.4, ease: 'inOut', head: [-8, 20, 2], chest: [4, 5, 0] },
      { t: 4.8, head: [-12, -16, 0], chest: [4, -3, 0] },
      { t: 6 },
    ],
  },
  drive: {
    duration: 4, loop: true,
    base: {
      hipsPos: [0, 0, 0], hips: [-4, 0, 0], spine: [10, 0, 0], chest: [8, 0, 0], head: [-10, 0, 0],
      legL: [-86, 0, 7], legR: [-86, 0, -7], shinL: [78, 0, 0], shinR: [78, 0, 0], footL: [-4, 0, 0], footR: [-4, 0, 0],
      armL: [-62, 0, -8], armR: [-62, 0, 8], foreArmL: [-32, -12, 0], foreArmR: [-32, 12, 0], racket: [-40, 0, 0],
    },
    keys: [
      { t: 0 },
      { t: 1.6, ease: 'inOut', head: [-8, 10, 0], chest: [8, 3, 0] },
      { t: 2.6, ease: 'inOut', head: [-10, -6, 0], chest: [8, -2, 0] },
      { t: 4 },
    ],
  },

  // ── Tennis (right-handed; the racket is in the right hand) ──
  ready: {
    duration: 1, loop: true, base: READY,
    keys: [
      { t: 0 },
      { t: 0.25, hipsPos: [0, -0.125, 0] },
      { t: 0.5 },
      { t: 0.75, hipsPos: [0, -0.125, 0] },
      { t: 1 },
    ],
  },
  split_step: {
    duration: 0.55, base: READY, events: { land: 0.36 },
    keys: [
      { t: 0, ease: 'in' },
      { t: 0.1, ease: 'out', hipsPos: [0, -0.14, 0] },
      { t: 0.24, ease: 'in', hipsPos: [0, -0.02, 0], ik: { L: [0.2, 0.07, 0.03, 14, 18], R: [-0.2, 0.07, 0.03, -14, 18] } },
      { t: 0.36, ease: 'out', hipsPos: [0, -0.16, 0], ik: { L: [0.31, 0, 0.03, 16], R: [-0.31, 0, 0.03, -16] }, spine: [18, 0, 0] },
      { t: 0.55 },
    ],
  },
  shuffle_left: {
    duration: 0.5, loop: true, base: READY, speed: 0.6,
    keys: SHUFFLE_L,
  },
  shuffle_right: {
    duration: 0.5, loop: true, base: READY, speed: 0.6,
    keys: SHUFFLE_L.map(k => ({ ...mirror(k, true), t: k.t })),
  },
  forehand: {
    duration: 1.3, base: READY, events: { contact: 0.52 },
    keys: [
      { t: 0, ease: 'out' },
      { t: 0.3, // unit turn + backswing
        hips: [6, -30, 0], spine: [12, -22, 0], chest: [4, -30, 0], head: [-14, 44, 0], hipsPos: [-0.04, -0.13, 0],
        ik: { L: [0.2, 0, 0.18, 0], R: [-0.28, 0, -0.08, -40] },
        armR: [-10, -40, -70], foreArmR: [-40, 0, 0], handR: [0, 0, -30], racket: [0, 0, 0],
        armL: [-82, -40, 0], foreArmL: [-12, 0, 0], handL: [0, 0, 0] },
      { t: 0.43, ease: 'in', // racket drop
        hips: [6, -18, 0], spine: [12, -14, 0], chest: [4, -18, 0], head: [-14, 30, 0], hipsPos: [-0.02, -0.14, 0.01],
        ik: { L: [0.2, 0, 0.18, 0], R: [-0.28, 0, -0.08, -40] },
        armR: [-10, -50, -62], foreArmR: [-22, 0, 0], handR: [0, 0, 20],
        armL: [-78, -20, 0], foreArmL: [-20, 0, 0] },
      { t: 0.52, ease: 'out', // contact
        hips: [6, 10, 0], spine: [10, 8, 0], chest: [2, 8, 0], head: [-10, -20, 0], hipsPos: [0.02, -0.12, 0.04],
        ik: { L: [0.2, 0, 0.18, 0], R: [-0.27, 0.02, -0.07, -35, 20] },
        armR: [-10, 4, -86], foreArmR: [-10, 0, 0], handR: [0, 0, 0],
        armL: [-40, 30, 20], foreArmL: [-70, 0, 0] },
      { t: 0.75, ease: 'inOut', // follow-through over the left shoulder
        hips: [6, 40, 0], spine: [8, 26, 0], chest: [0, 36, 0], head: [-8, -34, 0], hipsPos: [0.03, -0.1, 0.03],
        ik: { L: [0.2, 0, 0.18, 0], R: [-0.2, 0.05, -0.02, -20, 34] },
        armR: [-10, 105, -118], foreArmR: [-110, 0, 0], handR: [-10, 0, 0],
        armL: [-24, 40, 24], foreArmL: [-100, -40, 0] },
      { t: 0.95, ease: 'inOut',
        hips: [6, 30, 0], spine: [10, 18, 0], chest: [2, 26, 0], head: [-14, -24, 0], hipsPos: [0.02, -0.11, 0.02],
        ik: { L: [0.2, 0, 0.14, 4], R: [-0.24, 0, -0.02, -20] },
        armR: [-10, 95, -105], foreArmR: [-100, 0, 0], handR: [-10, 0, 0],
        armL: [-30, 30, 10], foreArmL: [-96, -40, 0] },
      { t: 1.3 },
    ],
  },
  backhand: {
    duration: 1.3, base: READY, events: { contact: 0.52 },
    keys: [
      { t: 0, ease: 'out' },
      { t: 0.3, // shoulder turn, racket back over the left hip
        hips: [6, 34, 0], spine: [12, 26, 0], chest: [6, 40, 0], head: [-16, -52, 0], hipsPos: [0.03, -0.13, 0],
        ik: { L: [0.28, 0, -0.08, 40], R: [-0.12, 0, 0.2, 10] },
        armR: [-50, 0, 42], foreArmR: [-58, 0, 0], handR: [-20, 0, 0], racket: [0, 0, 0],
        armL: [-44, 0, -14], foreArmL: [-96, -36, 0] },
      { t: 0.43, ease: 'in',
        hips: [6, 24, 0], spine: [12, 18, 0], chest: [6, 28, 0], head: [-14, -36, 0], hipsPos: [0.01, -0.14, 0.01],
        ik: { L: [0.28, 0, -0.08, 40], R: [-0.12, 0, 0.2, 10] },
        armR: [-40, 0, 52], foreArmR: [-30, 0, 0], handR: [10, 0, 0],
        armL: [-10, 0, 10], foreArmL: [-40, 0, 0] },
      { t: 0.52, ease: 'out', // contact out in front-left
        hips: [6, 6, 0], spine: [10, 2, 0], chest: [4, -2, 0], head: [-10, 22, 0], hipsPos: [-0.02, -0.12, 0.04],
        ik: { L: [0.28, 0.02, -0.08, 30, 18], R: [-0.12, 0, 0.2, 10] },
        armR: [-78, 0, 38], foreArmR: [-6, 0, 0], handR: [0, 0, 0],
        armL: [26, 0, 40], foreArmL: [-10, 0, 0] },
      { t: 0.75, ease: 'inOut', // high finish to the right
        hips: [6, -10, 0], spine: [8, -10, 0], chest: [0, -18, 0], head: [-8, 30, 0], hipsPos: [-0.03, -0.1, 0.03],
        ik: { L: [0.24, 0.05, -0.04, 20, 30], R: [-0.12, 0, 0.2, 10] },
        armR: [-150, 0, -24], foreArmR: [-10, 0, 0], handR: [-15, 0, 0],
        armL: [40, 0, 62], foreArmL: [-6, 0, 0] },
      { t: 0.95, ease: 'inOut',
        hips: [6, -4, 0], spine: [10, -6, 0], chest: [2, -10, 0], head: [-14, 20, 0], hipsPos: [-0.02, -0.11, 0.02],
        ik: { L: [0.26, 0, 0.0, 14], R: [-0.16, 0, 0.14, -4] },
        armR: [-130, 0, -20], foreArmR: [-20, 0, 0],
        armL: [30, 0, 45], foreArmL: [-10, 0, 0] },
      { t: 1.3 },
    ],
  },
  serve: {
    duration: 2.2, base: READY, events: { release: 0.62, contact: 1.22 }, ball: [[0, true], [0.62, false]],
    keys: [
      { t: 0, ease: 'inOut', // side-on stance, ball and racket together
        hips: [0, -50, 0], spine: [4, -10, 0], chest: [0, -10, 0], head: [-6, 62, 0], hipsPos: [0, -0.03, 0],
        ik: { L: [0.12, 0, 0.22, -30], R: [-0.22, 0, -0.1, -70] },
        armR: [-34, 0, 16], foreArmR: [-62, 22, 0], handR: [-40, 0, 0], racket: [0, 0, 0],
        armL: [-36, 0, -12], foreArmL: [-62, -34, 0], handL: [0, 0, 0] },
      { t: 0.3, ease: 'inOut', // arms drop together
        hips: [0, -50, 0], spine: [6, -10, 0], chest: [0, -12, 0], head: [-6, 62, 0], hipsPos: [0, -0.05, 0],
        ik: { L: [0.12, 0, 0.22, -30], R: [-0.22, 0, -0.1, -70] },
        armR: [26, 0, -14], foreArmR: [-12, 0, 0], handR: [0, 0, 0],
        armL: [8, 0, 12], foreArmL: [-12, 0, 0] },
      { t: 0.62, ease: 'inOut', // toss + trophy position
        hips: [0, -48, 0], spine: [-10, -8, 0], chest: [-10, -8, 0], head: [-38, 56, 0], hipsPos: [0.03, -0.13, -0.02],
        ik: { L: [0.12, 0, 0.22, -30], R: [-0.22, 0, -0.1, -70] },
        armR: [-90, -30, -95], foreArmR: [-110, 0, 0], handR: [0, 0, 0],
        armL: [-172, 0, 6], foreArmL: [0, 0, 0] },
      { t: 0.95, ease: 'in', // racket drop behind the back, legs drive
        hips: [0, -30, 0], spine: [-14, -4, 0], chest: [-10, -2, 0], head: [-42, 36, 0], hipsPos: [0.02, -0.06, 0],
        ik: { L: [0.12, 0, 0.22, -30], R: [-0.2, 0.02, -0.1, -60, 20] },
        armR: [90, -10, -150], foreArmR: [-140, 0, 0], handR: [0, 0, 0],
        armL: [-130, 0, 8], foreArmL: [-20, 0, 0] },
      { t: 1.22, ease: 'out', // contact at full stretch
        hips: [0, 0, 0], spine: [0, 4, 0], chest: [2, 10, 0], head: [-40, 0, 0], hipsPos: [0, 0.06, 0.04],
        ik: { L: [0.1, 0.07, 0.26, -10, 24], R: [-0.12, 0.14, -0.06, -10, 40] },
        armR: [-20, 0, -168], foreArmR: [-8, 0, 0], handR: [-20, 0, 0],
        armL: [-40, 0, 20], foreArmL: [-100, -40, 0] },
      { t: 1.5, ease: 'out', // follow-through across the body, land on the left foot
        hips: [4, 34, 0], spine: [18, 12, 0], chest: [18, 30, 0], head: [-16, -30, 0], hipsPos: [0, -0.1, 0.1],
        ik: { L: [0.12, 0, 0.34, 0], R: [-0.14, 0.26, -0.3, -10, 60] },
        armR: [-40, 0, 44], foreArmR: [-22, 0, 0], handR: [0, 0, 0],
        armL: [-20, 0, 30], foreArmL: [-90, -30, 0] },
      { t: 1.8, ease: 'inOut',
        hips: [6, 12, 0], spine: [14, 4, 0], chest: [8, 10, 0], head: [-20, -10, 0], hipsPos: [0, -0.11, 0.05],
        ik: { L: [0.2, 0, 0.18, 8], R: [-0.24, 0, 0.0, -14] } },
      { t: 2.2 },
    ],
  },
  pickup_ball: {
    duration: 1.8, base: STAND, events: { grab: 0.78 }, ball: [[0, false], [0.78, true]], ballOnEnd: true,
    keys: [
      { t: 0, ease: 'inOut' },
      { t: 0.35, hipsPos: [0, -0.05, 0.03], spine: [18, 0, 0], chest: [8, 0, 0],
        ik: { L: [0.12, 0, 0.18, 8], R: [-0.14, 0, -0.1, -10] } },
      { t: 0.78, ease: 'inOut', hipsPos: [0, -0.3, -0.06], hips: [10, 0, 0], spine: [40, 0, 0], chest: [22, 6, 0], head: [-18, 6, 0],
        ik: { L: [0.14, 0, 0.2, 8], R: [-0.14, 0, -0.1, -10, 16] },
        armL: [-52, 0, 4], foreArmL: [-6, 0, 0], armR: [14, 0, -18], foreArmR: [-20, 0, 0] },
      { t: 1.2, ease: 'inOut', hipsPos: [0, -0.06, 0], spine: [10, 0, 0], chest: [4, 0, 0], head: [6, 0, 0],
        ik: { L: [0.12, 0, 0.1, 8], R: [-0.12, 0, 0.0, -8] },
        armL: [-40, 0, 0], foreArmL: [-66, -20, 0] },
      { t: 1.8, armL: [-10, 0, 4], foreArmL: [-30, 0, 0] },
    ],
  },
};

/** Names accepted as aliases for authored clips. */
export const CLIP_ALIASES = {
  react_neutral: 'shrug', cheer: 'react_happy', celebrate: 'react_happy', annoyed: 'react_annoyed', happy: 'react_happy',
  pickup: 'pickup_ball', sidestep_left: 'shuffle_left', sidestep_right: 'shuffle_right', split: 'split_step',
};

// ───────────────────────────── Baking ─────────────────────────────

const _qH = new THREE.Quaternion();
const _qHi = new THREE.Quaternion();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _xb = new THREE.Vector3();
const _yb = new THREE.Vector3();
const _zb = new THREE.Vector3();

function eulerQ(deg, out) {
  _e.set((deg?.[0] || 0) * DEG, (deg?.[1] || 0) * DEG, (deg?.[2] || 0) * DEG, 'YXZ');
  return out.setFromEuler(_e);
}
function qToDeg(q) {
  _e.setFromQuaternion(q, 'YXZ');
  return [_e.x / DEG, _e.y / DEG, _e.z / DEG];
}

/** Two-bone leg IK: writes leg/shin/foot Euler angles for one side into `pose`. */
function solveLeg(pose, side, spec) {
  const s = side === 'L' ? 1 : -1;
  const hp = pose.hipsPos || [0, 0, 0];
  eulerQ(pose.hips, _qH);
  _qHi.copy(_qH).invert();
  // Hip joint in model space
  _v.set(s * LEG_X, 0, 0).applyQuaternion(_qH).add(_p.set(hp[0], HIP_Y + hp[1], hp[2]));
  const yaw = (spec[3] ?? s * 8) * DEG;
  const pitch = (spec[4] ?? 0) * DEG;
  // Ankle target (hips-local vector from the hip joint)
  _v2.set(spec[0], spec[1] + ANKLE_Y, spec[2]).sub(_v).applyQuaternion(_qHi);
  let d = _v2.length();
  const maxD = (THIGH_LEN + SHIN_LEN) * 0.9995;
  if (d > maxD) { _v2.multiplyScalar(maxD / d); d = maxD; }
  d = Math.max(d, 0.05);
  const vhat = _v2.clone().divideScalar(d);
  // Knee pole: toward the toes (hips-local), perpendicular to the hip→ankle line
  const pole = new THREE.Vector3(Math.sin(yaw), 0.02, Math.cos(yaw)).applyQuaternion(_qHi);
  pole.addScaledVector(vhat, -pole.dot(vhat)).normalize();
  const cosA = THREE.MathUtils.clamp((THIGH_LEN * THIGH_LEN + d * d - SHIN_LEN * SHIN_LEN) / (2 * THIGH_LEN * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _t.copy(vhat).multiplyScalar(cosA).addScaledVector(pole, sinA).normalize(); // thigh direction
  // Leg orientation: local -Y along the thigh, local +Z toward the knee pole
  _yb.copy(_t).negate();
  _zb.copy(pole).addScaledVector(_t, -pole.dot(_t)).normalize();
  _xb.crossVectors(_yb, _zb).normalize();
  _m.makeBasis(_xb, _yb, _zb);
  _qA.setFromRotationMatrix(_m); // leg (hips-local)
  // Shin: bend about local X
  const knee = _t.clone().multiplyScalar(THIGH_LEN);
  const sdir = _v2.clone().sub(knee).normalize().applyQuaternion(_qA.clone().invert());
  const beta = Math.atan2(-sdir.z, -sdir.y);
  _qB.setFromAxisAngle(_xb.set(1, 0, 0), beta);
  // Foot: desired model-space orientation (yaw + pitch), expressed in the shin frame
  const qFootWorld = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  const chain = _qH.clone().multiply(_qA).multiply(_qB);
  const qFoot = chain.invert().multiply(qFootWorld);
  pose[`leg${side}`] = qToDeg(_qA);
  pose[`shin${side}`] = [beta / DEG, 0, 0];
  pose[`foot${side}`] = qToDeg(qFoot);
}

function resolvePose(def, key) {
  const base = def.base || {};
  const p = { ...base, ...key };
  const ik = { ...(base.ik || {}), ...(key.ik || {}) };
  delete p.ik;
  for (const side of ['L', 'R']) {
    // A key that sets leg angles directly for a side (without ik for it) disables the base ik
    if (!key.ik?.[side] && key[`leg${side}`]) continue;
    if (ik[side]) solveLeg(p, side, ik[side]);
  }
  return p;
}

function ease(kind, u) {
  switch (kind) {
    case 'in': return u * u;
    case 'out': return 1 - (1 - u) * (1 - u);
    case 'inOut': return u * u * (3 - 2 * u);
    default: return u;
  }
}

/** Time-aware Catmull-Rom (Hermite) between keys, per component. */
function sampleKeys(keys, loop, dur, t, out) {
  const n = keys.length;
  let i = 0;
  while (i < n - 2 && t >= keys[i + 1].t) i++;
  const k1 = keys[i], k2 = keys[Math.min(i + 1, n - 1)];
  const h = k2.t - k1.t;
  if (h <= 1e-6) { for (let c = 0; c < out.length; c++) out[c] = k2.v[c]; return out; }
  let k0 = i > 0 ? keys[i - 1] : null;
  let k3 = i + 2 < n ? keys[i + 2] : null;
  let t0, t3;
  if (!k0) { if (loop && n > 2) { k0 = keys[n - 2]; t0 = k0.t - dur; } else { k0 = k1; t0 = k1.t - h; } } else t0 = k0.t;
  if (!k3) { if (loop && n > 2) { k3 = keys[1]; t3 = k3.t + dur; } else { k3 = k2; t3 = k2.t + h; } } else t3 = k3.t;
  const u = ease(k1.ease, THREE.MathUtils.clamp((t - k1.t) / h, 0, 1));
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const T = 0.9; // slight tension: less overshoot between held poses
  for (let c = 0; c < out.length; c++) {
    const m1 = (k2.v[c] - k0.v[c]) / Math.max(1e-6, k2.t - t0) * h * T;
    const m2 = (k3.v[c] - k1.v[c]) / Math.max(1e-6, t3 - k1.t) * h * T;
    out[c] = h00 * k1.v[c] + h10 * m1 + h01 * k2.v[c] + h11 * m2;
  }
  return out;
}

function bakeClip(name, def) {
  const keys = [...def.keys].sort((a, b) => a.t - b.t);
  if (keys[0].t > 0) keys.unshift({ ...keys[0], t: 0 });
  if (keys[keys.length - 1].t < def.duration) keys.push({ ...(def.loop ? keys[0] : keys[keys.length - 1]), t: def.duration });
  const poses = keys.map(k => resolvePose(def, k));

  const frames = Math.max(2, Math.round(def.duration * FPS) + 1);
  const times = new Float32Array(frames);
  for (let f = 0; f < frames; f++) times[f] = Math.min(def.duration, f / FPS);
  times[frames - 1] = def.duration;

  const tracks = [];
  const tmp = [0, 0, 0];
  const q = new THREE.Quaternion();
  for (const bone of ANIMATED_BONES) {
    const ch = poses.map((p, i) => ({ t: keys[i].t, ease: keys[i].ease, v: p[bone] || [0, 0, 0] }));
    const values = new Float32Array(frames * 4);
    let px = 0, py = 0, pz = 0, pw = 1;
    for (let f = 0; f < frames; f++) {
      sampleKeys(ch, def.loop, def.duration, times[f], tmp);
      eulerQ(tmp, q);
      if (f > 0 && q.x * px + q.y * py + q.z * pz + q.w * pw < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      values[f * 4] = px = q.x; values[f * 4 + 1] = py = q.y; values[f * 4 + 2] = pz = q.z; values[f * 4 + 3] = pw = q.w;
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }
  const ch = poses.map((p, i) => ({ t: keys[i].t, ease: keys[i].ease, v: p.hipsPos || [0, 0, 0] }));
  const pos = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    sampleKeys(ch, def.loop, def.duration, times[f], tmp);
    pos[f * 3] = tmp[0]; pos[f * 3 + 1] = HIP_Y + tmp[1]; pos[f * 3 + 2] = tmp[2];
  }
  tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, pos));
  return new THREE.AnimationClip(name, def.duration, tracks);
}

const _clips = new Map();
/** Baked clip by name (baked lazily on first use, then shared by every character). */
export function getClip(name) {
  let c = _clips.get(name);
  if (!c && CLIP_DEFS[name]) { c = bakeClip(name, CLIP_DEFS[name]); _clips.set(name, c); }
  return c || null;
}
/** All clips baked (name → THREE.AnimationClip). Mostly for tools / precompiling. */
export function getClips() {
  for (const name of Object.keys(CLIP_DEFS)) getClip(name);
  return _clips;
}

export function resolveClipName(name) {
  return CLIP_DEFS[name] ? name : (CLIP_ALIASES[name] && CLIP_DEFS[CLIP_ALIASES[name]] ? CLIP_ALIASES[name] : null);
}

/** Clip names available to Character.play(). */
export const CLIP_NAMES = Object.keys(CLIP_DEFS);

// ───────────────────────────── Probe (contact points) ─────────────────────────────

const _contactCache = new Map();
let _probe = null;
/**
 * Model-space (unscaled, facing +Z) racket-head centre at the clip's `event` time
 * (default 'contact'). Cached. Returns null if the clip has no such event.
 */
export function getClipEventRacketPoint(name, event = 'contact') {
  const n = resolveClipName(name);
  if (!n) return null;
  const key = `${n}|${event}`;
  if (_contactCache.has(key)) return _contactCache.get(key);
  const te = CLIP_DEFS[n].events?.[event];
  if (te === undefined) { _contactCache.set(key, null); return null; }
  if (!_probe) {
    const root = new THREE.Object3D();
    const bones = [];
    for (const def of BONE_DEFS) {
      const b = new THREE.Bone();
      b.name = def.name;
      if (def.parent < 0) { b.position.fromArray(def.pos); root.add(b); } else {
        const pp = BONE_DEFS[def.parent].pos;
        b.position.set(def.pos[0] - pp[0], def.pos[1] - pp[1], def.pos[2] - pp[2]);
        bones[def.parent].add(b);
      }
      bones.push(b);
    }
    _probe = { root, bones, mixer: new THREE.AnimationMixer(root) };
  }
  const { root, mixer } = _probe;
  mixer.stopAllAction();
  const action = mixer.clipAction(getClip(n));
  action.reset().play();
  action.time = te;
  mixer.update(0);
  root.updateMatrixWorld(true);
  const racket = root.getObjectByName('racket');
  const p = new THREE.Vector3().fromArray(RACKET_HEAD_OFFSET).applyMatrix4(racket.matrixWorld);
  action.stop();
  _contactCache.set(key, p);
  return p;
}

// ───────────────────────────── Animator ─────────────────────────────

const LOCO = ['idle', 'walk', 'run'];

/**
 * Per-character playback controller around one THREE.AnimationMixer.
 * Allocation-free per frame once every used clip has been played once.
 */
export class Animator {
  /** @param {THREE.Object3D} root  object whose skeleton owns the named bones (the SkinnedMesh) */
  constructor(root) {
    this.mixer = new THREE.AnimationMixer(root);
    /** name → { action, def, name, w, target, rate, prevTime } */
    this._entries = new Map();
    this._active = [];          // entries with weight or target > 0
    this.base = null;           // looping clip name that replaces locomotion, or null
    this.oneShot = null;        // { entry, then, onDone, fadeOut }
    this._locoW = 1;
    this._locoTarget = 1;
    this._locoRate = 5;
    this._move = 0; this._moveTarget = 0;
    this._run = 0; this._runTarget = 0;
    this._cps = 1;               // gait cycles per second
    this._phase = 0;
    this._listeners = new Map(); // 'clip:event' → Set<cb>
    this.ballOverride = null;    // visibility forced by the current clip's ball timeline
    this.idleVariants = ['idle_look', 'idle_shift', 'idle_watch'];
    this.autoIdleVariants = true;
    this._idleTimer = 4 + Math.random() * 6;
    this._rand = Math.random;
    this.onBallOnEnd = null;     // () => void — clip asked to keep the ball after it ends
    for (const n of LOCO) this._entry(n);
    const idle = this._entries.get('idle');
    idle.action.play();
    idle.action.time = Math.random() * idle.def.duration;
    for (const n of ['walk', 'run']) { const e = this._entries.get(n); e.action.timeScale = 0; }
  }

  _entry(name) {
    let e = this._entries.get(name);
    if (!e) {
      const clip = getClip(name);
      const def = CLIP_DEFS[name];
      const action = this.mixer.clipAction(clip);
      action.setLoop(def.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = true;
      action.enabled = true;
      e = { name, def, action, w: 0, target: 0, rate: 5, prevTime: 0, loco: LOCO.includes(name) };
      action.setEffectiveWeight(0);
      this._entries.set(name, e);
    }
    return e;
  }

  _setTarget(e, target, fade) {
    e.target = target;
    e.rate = 1 / Math.max(0.001, fade);
    if (target > 0 && !this._active.includes(e)) {
      this._active.push(e);
      if (!e.action.isRunning()) { e.action.reset(); e.action.play(); e.action.setEffectiveWeight(e.w); }
    }
  }

  /** Current primary clip name ('idle' / 'walk' / 'run' when on locomotion). */
  get current() {
    if (this.oneShot) return this.oneShot.entry.name;
    if (this.base) return this.base;
    if (this._moveTarget < 0.05) return 'idle';
    return this._runTarget > 0.5 ? 'run' : 'walk';
  }

  /**
   * Play a clip. Looping clips become the base (replacing locomotion) until stop() or another
   * looping clip; one-shots play over the base and fade back to it (or to `opts.then`).
   * @returns {number} playback duration in seconds (0 if the clip is unknown)
   */
  play(name, opts = {}) {
    const n = resolveClipName(name);
    if (!n) return 0;
    if (n === 'idle' || n === 'walk' || n === 'run') { this.stop(opts.fade); return CLIP_DEFS[n].duration; }
    const def = CLIP_DEFS[n];
    const fade = opts.fade ?? def.fade ?? 0.2;
    const loop = opts.loop ?? !!def.loop;
    const e = this._entry(n);
    e.action.timeScale = opts.timeScale ?? 1;
    e.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    if (loop) {
      if (this.oneShot && !opts.keepOneShot) this._endOneShot(fade, false);
      if (this.base === n) { this._retarget(fade); return def.duration / Math.abs(e.action.timeScale || 1); }
      this.base = n;
      if (opts.startAt !== undefined) e.action.time = opts.startAt;
    } else {
      if (this.oneShot && this.oneShot.entry !== e) this._fadeOut(this.oneShot.entry, fade);
      e.action.reset();
      e.action.play();
      if (opts.startAt) e.action.time = opts.startAt;
      e.prevTime = e.action.time;
      this.oneShot = { entry: e, then: opts.then ?? null, onDone: opts.onDone || null,
        fadeOut: Math.min(opts.fadeOut ?? def.fadeOut ?? 0.25, def.duration * 0.4) };
    }
    this._retarget(fade);
    return def.duration / Math.abs(e.action.timeScale || 1);
  }

  /** Back to locomotion (idle/walk/run), cancelling any base or one-shot clip. */
  stop(fade = 0.25) {
    if (this.oneShot) this._endOneShot(fade, false);
    this.base = null;
    this._retarget(fade);
  }

  _fadeOut(e, fade) { this._setTarget(e, 0, fade); }

  _endOneShot(fade, completed) {
    const os = this.oneShot;
    this.oneShot = null;
    this._fadeOut(os.entry, fade);
    this.ballOverride = null;
    if (completed) {
      if (os.entry.def.ballOnEnd && this.onBallOnEnd) this.onBallOnEnd();
      if (os.then) {
        const t = resolveClipName(os.then);
        if (t && CLIP_DEFS[t].loop) this.base = t;
        else if (t === 'idle') this.base = null;
      }
      this._emit(os.entry.name, 'end');
      if (os.onDone) { try { os.onDone(); } catch (err) { console.error(err); } }
    }
  }

  _retarget(fade) {
    const want = this.oneShot ? this.oneShot.entry : (this.base ? this._entry(this.base) : null);
    for (const e of this._entries.values()) {
      if (e.loco) continue;
      const tgt = e === want ? 1 : 0;
      if (tgt !== e.target || (tgt > 0 && !this._active.includes(e))) this._setTarget(e, tgt, fade);
    }
    this._locoTarget = want ? 0 : 1;
    this._locoRate = 1 / Math.max(0.001, fade);
  }

  /**
   * Locomotion input. move: 0 (idle) .. 1 (walking); run: 0..1 blend toward the run clip;
   * cyclesPerSecond: gait cycles (two steps) per second.
   */
  setLocomotion(move, cyclesPerSecond = 1.2, run = 0) {
    this._moveTarget = move;
    this._runTarget = run;
    if (move > 0.01) this._cps = cyclesPerSecond;
  }

  isPlaying(name) {
    const n = resolveClipName(name);
    return !!n && (this.current === n);
  }

  /**
   * Subscribe to a clip event ('contact', 'release', 'grab', 'land', 'end', ...).
   * Use clip '*' to hear every clip. Returns an unsubscribe function.
   */
  onClipEvent(clip, event, cb) {
    const n = clip === '*' ? '*' : (resolveClipName(clip) || clip);
    const key = `${n}:${event}`;
    let set = this._listeners.get(key);
    if (!set) { set = new Set(); this._listeners.set(key, set); }
    set.add(cb);
    return () => set.delete(cb);
  }

  _emit(clip, event) {
    const a = this._listeners.get(`${clip}:${event}`);
    const b = this._listeners.get(`*:${event}`);
    if (a) for (const cb of a) { try { cb(event, clip); } catch (err) { console.error(err); } }
    if (b) for (const cb of b) { try { cb(event, clip); } catch (err) { console.error(err); } }
  }

  update(dt) {
    // Idle variants (only while standing still on locomotion)
    if (this.autoIdleVariants && !this.oneShot && !this.base && this._moveTarget < 0.05 && this.idleVariants.length) {
      this._idleTimer -= dt;
      if (this._idleTimer <= 0) {
        this._idleTimer = 6 + this._rand() * 9;
        this.play(this.idleVariants[Math.floor(this._rand() * this.idleVariants.length)], { fade: 0.45, fadeOut: 0.6 });
      }
    } else if (this._moveTarget >= 0.05) {
      this._idleTimer = Math.max(this._idleTimer, 3);
    }

    // One-shot ending → fade back early so the return overlaps the tail
    const os = this.oneShot;
    if (os) {
      const a = os.entry.action;
      const dur = os.entry.def.duration;
      if (a.time >= dur - os.fadeOut * Math.abs(a.timeScale || 1) - 1e-4 || !a.isRunning()) {
        this._endOneShot(os.fadeOut, true);
        this._retarget(os.fadeOut);
      }
    }

    // Weights
    const kMove = Math.min(1, dt * 6);
    this._move += (this._moveTarget - this._move) * kMove;
    this._run += (this._runTarget - this._run) * kMove;
    const dl = this._locoTarget - this._locoW;
    this._locoW += Math.sign(dl) * Math.min(Math.abs(dl), dt * this._locoRate);
    const L = this._locoW, m = this._move, r = this._run;
    this._phase = (this._phase + dt * this._cps) % 1;
    for (const n of LOCO) {
      const e = this._entries.get(n);
      const w = n === 'idle' ? L * (1 - m) : (n === 'walk' ? L * m * (1 - r) : L * m * r);
      if (w > 0.001) {
        if (!e.action.isRunning()) e.action.play();
        e.action.enabled = true;
        e.action.setEffectiveWeight(w);
        if (n !== 'idle') e.action.time = this._phase * e.def.duration;
      } else if (e.action.isRunning()) {
        e.action.stop();
      }
    }
    for (let i = this._active.length - 1; i >= 0; i--) {
      const e = this._active[i];
      const d = e.target - e.w;
      e.w += Math.sign(d) * Math.min(Math.abs(d), dt * e.rate);
      if (e.w <= 0.001 && e.target === 0) {
        e.w = 0;
        e.action.stop();
        this._active.splice(i, 1);
      } else {
        e.action.setEffectiveWeight(e.w);
      }
      e.prevTime = e.action.time;
    }

    this.mixer.update(dt);

    // Events + ball timeline for the clips we are heading to
    for (const e of this._active) {
      if (e.target <= 0) continue;
      const def = e.def;
      const t1 = e.action.time, t0 = e.prevTime;
      if (def.events) {
        const wrapped = t1 < t0;
        for (const ev in def.events) {
          const te = def.events[ev];
          if (wrapped ? (te > t0 || te <= t1) : (te > t0 && te <= t1)) this._emit(e.name, ev);
        }
      }
      if (def.ball) {
        let vis = def.ball[0][1];
        for (const [tb, v] of def.ball) if (t1 >= tb) vis = v;
        this.ballOverride = vis;
      }
    }
  }

  /** Debug: hold a clip at time t (seconds) with full weight. */
  seek(name, t) {
    const n = resolveClipName(name);
    if (!n) return;
    this.mixer.stopAllAction();
    this._active.length = 0;
    for (const e of this._entries.values()) { e.w = 0; e.target = 0; }
    this.oneShot = null; this.base = null;
    this._locoW = 0; this._locoTarget = 0;
    const e = this._entry(n);
    e.action.reset().play();
    e.action.setEffectiveWeight(1);
    e.action.time = t;
    e.action.timeScale = 0;
    this.mixer.update(0);
    e.action.timeScale = 1;
    const def = CLIP_DEFS[n];
    this.ballOverride = null;
    if (def.ball) { let vis = def.ball[0][1]; for (const [tb, v] of def.ball) if (t >= tb) vis = v; this.ballOverride = vis; }
  }
}
