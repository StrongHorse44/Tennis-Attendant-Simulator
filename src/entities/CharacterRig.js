import * as THREE from 'three';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// Deform bones present on the vendored Kenney character rigs. IK helper
// nodes (e.g. LeftFootIK, LeftKneeCtrl) are not part of the skinned deform
// hierarchy and are intentionally ignored.
const BONE_NAMES = [
  'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot',
  'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm',
];

// The vendored rig's bind pose is a literal T-pose (arms straight out to the
// sides) - there are no animation clips to retarget against, so "rest" as
// exported is not a usable standing pose on its own. These per-bone
// corrections are baked into restQuats at construction (empirically found:
// each arm's bind orientation happens to use a different local axis for
// shoulder abduction - Z for the left arm, X for the right - verified by
// rotating each in isolation and observing which axis lowers the arm to the
// character's side). Everything downstream (idle, walk swing) then treats
// this corrected "arms at sides" pose as the true rest, per Gotcha #3.
const ARM_HANG_CORRECTION = {
  LeftArm: { axis: Z_AXIS, angle: -1.85 },
  RightArm: { axis: X_AXIS, angle: -1.85 },
};

// Bones actually driven by the procedural walk/idle cycle - everything else
// in BONE_NAMES stays untouched at its bind (rest) pose.
const ANIMATED_BONE_NAMES = [
  'Chest', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg',
  'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm',
];

const STRIDE = 2.2;
const EASE_RATE = 8; // idle blend-back-to-rest rate, roughly per second

/**
 * CharacterRig - wraps a skinned character instance (from
 * AssetLoader.getModelInstance(name, { skinned: true })) and drives a fully
 * procedural walk/idle animation by rotating its humanoid bones every
 * frame. The vendored models ship with no animation clips, so every pose is
 * a bone-space delta applied on top of the rig's bind pose.
 *
 * CRITICAL: bone.quaternion is always set to restQuaternion * deltaQuaternion
 * (or eased toward it) - never accumulated frame-over-frame - or the
 * skeleton drifts/deforms.
 */
export class CharacterRig {
  constructor(instance, targetHeight) {
    this.root = instance;

    // Callers (Player/NPC) treat `group` as "the mesh": scene.add, position
    // sync, visibility toggling. `instance` itself gets an internal offset
    // to plant its feet at group-local y=0, so callers never need to know
    // about the model's own bind-pose origin.
    this.group = new THREE.Group();
    this.group.add(instance);

    // Uniform-scale so the model's height matches the primitive body it
    // replaces.
    const box = new THREE.Box3().setFromObject(instance);
    const rawHeight = box.max.y - box.min.y;
    const scale = rawHeight > 0 ? targetHeight / rawHeight : 1;
    instance.scale.setScalar(scale);
    this.height = targetHeight;

    // Ground the model: `instance` sits at local position (0,0,0) with no
    // rotation, so its Box3 scales linearly about that origin - the scaled
    // min.y is simply box.min.y * scale. Offset by that amount so the feet
    // land exactly on y=0 of `group`.
    const groundOffset = -(box.min.y * scale);
    instance.position.y = groundOffset;

    // Find deform bones and snapshot their bind-pose (rest) rotations.
    this.bones = {};
    this.restQuats = {};
    for (const name of BONE_NAMES) {
      const bone = instance.getObjectByName(name);
      if (bone) {
        this.bones[name] = bone;
        this.restQuats[name] = bone.quaternion.clone();
      }
    }

    // Bake the T-pose -> arms-at-sides correction into the stored rest
    // quaternions (see ARM_HANG_CORRECTION above).
    for (const [name, correction] of Object.entries(ARM_HANG_CORRECTION)) {
      const rest = this.restQuats[name];
      if (!rest) continue;
      rest.multiply(new THREE.Quaternion().setFromAxisAngle(correction.axis, correction.angle));
    }

    if (this.bones.Hips) {
      this.hipsRestY = this.bones.Hips.position.y;
    }

    this.phase = 0;
    this.time = 0;
  }

  _setBoneDelta(name, deltaQuat) {
    const bone = this.bones[name];
    const rest = this.restQuats[name];
    if (!bone || !rest) return;
    bone.quaternion.copy(rest).multiply(deltaQuat);
  }

  _easeBoneToward(name, targetQuat, alpha) {
    const bone = this.bones[name];
    if (!bone) return;
    bone.quaternion.slerp(targetQuat, alpha);
  }

  /**
   * @param {number} dt frame delta seconds
   * @param {number} speed normalized movement magnitude (0 = idle, up to ~1
   *   for a full-speed walk) - the same value the old primitive swing
   *   animation was driven by.
   */
  update(dt, speed) {
    this.time += dt;
    const moving = speed > 0.1;
    this.phase += dt * speed * STRIDE;

    if (moving) {
      const swing = Math.sin(this.phase);

      this._setBoneDelta('LeftUpLeg', new THREE.Quaternion().setFromAxisAngle(X_AXIS, 0.6 * swing));
      this._setBoneDelta('RightUpLeg', new THREE.Quaternion().setFromAxisAngle(X_AXIS, -0.6 * swing));

      // Knee bends forward while that leg is on its back-swing.
      const leftKnee = Math.max(0, -swing) * 0.8;
      const rightKnee = Math.max(0, swing) * 0.8;
      this._setBoneDelta('LeftLeg', new THREE.Quaternion().setFromAxisAngle(X_AXIS, leftKnee));
      this._setBoneDelta('RightLeg', new THREE.Quaternion().setFromAxisAngle(X_AXIS, rightKnee));

      // Arms counter-swing opposite the same-side leg.
      this._setBoneDelta('LeftArm', new THREE.Quaternion().setFromAxisAngle(X_AXIS, -0.35 * swing));
      this._setBoneDelta('RightArm', new THREE.Quaternion().setFromAxisAngle(X_AXIS, 0.35 * swing));

      // Slight constant elbow bend.
      const foreArmBend = new THREE.Quaternion().setFromAxisAngle(X_AXIS, 0.15);
      this._setBoneDelta('LeftForeArm', foreArmBend);
      this._setBoneDelta('RightForeArm', foreArmBend);

      // Hip bob at double the stride frequency.
      if (this.bones.Hips && this.hipsRestY !== undefined) {
        this.bones.Hips.position.y = this.hipsRestY + Math.sin(this.phase * 2) * 0.03;
      }

      // Forward lean scaled by normalized speed.
      const lean = THREE.MathUtils.clamp(speed, 0, 1) * 0.08;
      this._setBoneDelta('Chest', new THREE.Quaternion().setFromAxisAngle(X_AXIS, lean));
    } else {
      // Idle: gentle breathing sway on the chest, and every animated bone
      // eases back toward rest rather than snapping (so stopping mid-stride
      // settles smoothly instead of popping to the bind pose).
      const alpha = Math.min(1, dt * EASE_RATE);
      const breathAngle = 0.015 * Math.sin(this.time * 1.5);
      const breathQuat = new THREE.Quaternion().setFromAxisAngle(X_AXIS, breathAngle);

      for (const name of ANIMATED_BONE_NAMES) {
        const rest = this.restQuats[name];
        if (!rest) continue;
        const target = name === 'Chest' ? rest.clone().multiply(breathQuat) : rest;
        this._easeBoneToward(name, target, alpha);
      }

      if (this.bones.Hips && this.hipsRestY !== undefined) {
        this.bones.Hips.position.y = THREE.MathUtils.lerp(this.bones.Hips.position.y, this.hipsRestY, alpha);
      }
    }
  }
}
