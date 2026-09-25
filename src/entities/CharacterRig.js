/**
 * CharacterRig — the shared skeleton layout of every stylized character.
 *
 * Model space: Y up, the character faces +Z, feet at y = 0, unscaled height ≈ 1.8.
 * The character's RIGHT side is -X (the racket hand is the right hand).
 *
 * Bone rotation conventions (Euler order 'YXZ', i.e. yaw applied last in the parent frame):
 *  - legs: -x swings the thigh forward; shins: +x bends the knee (foot goes back).
 *  - arms (hanging): -x raises the arm forward; armR -z / armL +z raise it sideways.
 *    Once an arm is raised sideways, +y swings it forward around the vertical (armR) and
 *    x twists it about its own axis.
 *  - foreArms: -x flexes the elbow. hands: -x flexes the wrist forward.
 *  - spine / chest / head / hips: +x leans forward, +y turns to the character's left (+X),
 *    +z tilts toward the character's right.
 */

export const HIP_Y = 0.78;
export const KNEE_Y = 0.42;
export const ANKLE_Y = 0.1;
export const SPINE_Y = 0.9;
export const CHEST_Y = 1.1;
export const NECK_Y = 1.38;
export const SHOULDER_Y = 1.27;
export const SHOULDER_X = 0.29;
export const ELBOW_Y = 1.02;
export const WRIST_Y = 0.8;
export const LEG_X = 0.1;
export const HEAD_Y = 1.58;
export const HEAD_R = 0.22;

// Limb segment lengths used by the leg IK in the clip builder
export const THIGH_LEN = HIP_Y - KNEE_Y;     // 0.36
export const SHIN_LEN = KNEE_Y - ANKLE_Y;    // 0.32

/** Racket grip pivot (bind pose) and the racket head centre relative to it. */
export const RACKET_GRIP = [-(SHOULDER_X + 0.015), 0.76, 0.02];
export const RACKET_HEAD_OFFSET = [0, -0.36, 0];
/** Held ball (left hand) — hidden unless a clip / caller shows it. */
export const BALL_POS = [SHOULDER_X + 0.02, 0.73, 0.05];

export const BONE = {
  root: 0, hips: 1, spine: 2, chest: 3, head: 4,
  armL: 5, armR: 6, foreArmL: 7, foreArmR: 8, handL: 9, handR: 10,
  racket: 11, ball: 12,
  legL: 13, legR: 14, shinL: 15, shinR: 16, footL: 17, footR: 18,
};

// World-space pivots of each bone in the bind pose.
export const BONE_DEFS = [
  { name: 'root', parent: -1, pos: [0, 0, 0] },
  { name: 'hips', parent: 0, pos: [0, HIP_Y, 0] },
  { name: 'spine', parent: 1, pos: [0, SPINE_Y, 0] },
  { name: 'chest', parent: 2, pos: [0, CHEST_Y, 0] },
  { name: 'head', parent: 3, pos: [0, NECK_Y, 0] },
  { name: 'armL', parent: 3, pos: [SHOULDER_X, SHOULDER_Y, 0] },
  { name: 'armR', parent: 3, pos: [-SHOULDER_X, SHOULDER_Y, 0] },
  { name: 'foreArmL', parent: 5, pos: [SHOULDER_X + 0.01, ELBOW_Y, 0] },
  { name: 'foreArmR', parent: 6, pos: [-(SHOULDER_X + 0.01), ELBOW_Y, 0] },
  { name: 'handL', parent: 7, pos: [SHOULDER_X + 0.015, WRIST_Y, 0.005] },
  { name: 'handR', parent: 8, pos: [-(SHOULDER_X + 0.015), WRIST_Y, 0.005] },
  { name: 'racket', parent: 10, pos: RACKET_GRIP },
  { name: 'ball', parent: 9, pos: BALL_POS },
  { name: 'legL', parent: 1, pos: [LEG_X, HIP_Y, 0] },
  { name: 'legR', parent: 1, pos: [-LEG_X, HIP_Y, 0] },
  { name: 'shinL', parent: 13, pos: [LEG_X, KNEE_Y, 0] },
  { name: 'shinR', parent: 14, pos: [-LEG_X, KNEE_Y, 0] },
  { name: 'footL', parent: 15, pos: [LEG_X, ANKLE_Y, 0] },
  { name: 'footR', parent: 16, pos: [-LEG_X, ANKLE_Y, 0] },
];

/** Bones driven by clips (everything except the fixed root and the held-ball socket). */
export const ANIMATED_BONES = BONE_DEFS.slice(1).map(d => d.name).filter(n => n !== 'ball');
