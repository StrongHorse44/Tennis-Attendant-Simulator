import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SIZES, GAME } from '../utils/Constants.js';
import { CharacterRig } from './CharacterRig.js';

// Old primitive player body measured ~1.8 world units tall (head-top to
// shoe-bottom Box3), scaled by SIZES.playerScale (0.85) -> 1.53. The rig
// targets that same height so gameplay proportions (camera distance,
// interaction ranges, court scale) are unaffected by the model swap.
const PLAYER_TARGET_HEIGHT = 1.8 * SIZES.playerScale;

/**
 * Player - attendant character with walking/driving states
 */
export class Player {
  constructor(scene, physicsWorld, position, assets) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.assets = assets;
    this.mesh = null;
    this.body = null;
    this.speed = SIZES.playerSpeed;
    this.isInCart = false;
    this.cart = null;
    this.facing = new THREE.Vector3(0, 0, -1);
    this.velocity = new THREE.Vector3();

    this._createMesh(position);
    this._createPhysics(position);
  }

  _createMesh(pos) {
    const instance = this.assets.getModelInstance('male', { skinned: true });
    this.rig = new CharacterRig(instance, PLAYER_TARGET_HEIGHT);
    this.mesh = this.rig.group;

    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    // Stored so update() can sync the (feet-at-group-origin) rig group to
    // the physics sphere's center regardless of resting contact height.
    this.radius = SIZES.playerRadius * SIZES.playerScale;
    const shape = new CANNON.Sphere(this.radius);
    this.body = new CANNON.Body({
      mass: 70,
      position: new CANNON.Vec3(pos.x, pos.y + 1, pos.z),
      shape,
      linearDamping: 0.95,
      angularDamping: 1.0,
      fixedRotation: true,
    });
    this.body.material = new CANNON.Material({ friction: GAME.groundFriction });
    this.physicsWorld.addBody(this.body);
  }

  enterCart(cart) {
    this.isInCart = true;
    this.cart = cart;
    this.mesh.visible = false;
    this.body.collisionResponse = false;
    this.body.velocity.set(0, 0, 0);
  }

  exitCart() {
    if (!this.cart) return;
    const cartPos = this.cart.mesh.position;
    const offset = new THREE.Vector3(2, 0, 0);
    offset.applyQuaternion(this.cart.mesh.quaternion);

    this.body.position.set(
      cartPos.x + offset.x,
      cartPos.y + 1,
      cartPos.z + offset.z
    );
    this.body.velocity.set(0, 0, 0);
    this.body.collisionResponse = true;
    this.mesh.visible = true;
    this.isInCart = false;
    this.cart = null;
  }

  update(dt, moveInput, cameraYaw) {
    if (this.isInCart) return;

    const inputLen = Math.sqrt(moveInput.x * moveInput.x + moveInput.y * moveInput.y);

    if (inputLen > 0.1) {
      // Compute world-space direction based on camera
      // Negate both axes: camera right = -X world, and screen-up = negative Y
      const moveAngle = Math.atan2(-moveInput.x, -moveInput.y);
      const worldAngle = cameraYaw + moveAngle;

      const moveX = Math.sin(worldAngle) * this.speed * inputLen;
      const moveZ = Math.cos(worldAngle) * this.speed * inputLen;

      this.body.velocity.x = moveX;
      this.body.velocity.z = moveZ;

      // Face the movement direction
      this.facing.set(Math.sin(worldAngle), 0, Math.cos(worldAngle));
    }

    // Procedural walk/idle animation
    this.rig.update(dt, inputLen);

    // Sync mesh to physics. The sphere rests with its center `radius` above
    // the ground contact point, and the rig's feet sit at group-local y=0,
    // so subtracting `radius` (not a hardcoded offset) keeps feet grounded.
    this.mesh.position.set(
      this.body.position.x,
      this.body.position.y - this.radius,
      this.body.position.z
    );

    // Rotate mesh to face direction
    if (inputLen > 0.1) {
      const targetAngle = Math.atan2(this.facing.x, this.facing.z);
      this.mesh.rotation.y = targetAngle;
    }
  }

  getPosition() {
    return this.mesh.position;
  }

  getWorldPosition() {
    return new THREE.Vector3(
      this.body.position.x,
      this.body.position.y,
      this.body.position.z
    );
  }
}
