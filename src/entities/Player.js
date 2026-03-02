import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';

/**
 * Player - attendant character with walking/driving states
 */
export class Player {
  constructor(scene, physicsWorld, position) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.mesh = null;
    this.body = null;
    this.speed = SIZES.playerSpeed;
    this.isInCart = false;
    this.cart = null;
    this.facing = new THREE.Vector3(0, 0, -1);
    this.velocity = new THREE.Vector3();
    this.animTime = 0;

    this._createMesh(position);
    this._createPhysics(position);
  }

  _createMesh(pos) {
    this.mesh = new THREE.Group();

    // Body (polo shirt)
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.6, 0.35),
      new THREE.MeshLambertMaterial({ color: COLORS.playerPolo })
    );
    torso.position.y = 1.1;
    torso.castShadow = true;
    this.mesh.add(torso);

    // Shorts
    const shorts = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.3, 0.33),
      new THREE.MeshLambertMaterial({ color: COLORS.playerShorts })
    );
    shorts.position.y = 0.7;
    shorts.castShadow = true;
    this.mesh.add(shorts);

    // Head
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 8),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    head.position.y = 1.6;
    head.castShadow = true;
    this.mesh.add(head);

    // Visor
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.05, 0.15),
      new THREE.MeshLambertMaterial({ color: 0xFFFFFF })
    );
    visor.position.set(0, 1.68, -0.15);
    this.mesh.add(visor);

    // Left leg
    this.leftLeg = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.5, 0.15),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.leftLeg.position.set(-0.12, 0.3, 0);
    this.leftLeg.castShadow = true;
    this.mesh.add(this.leftLeg);

    // Right leg
    this.rightLeg = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.5, 0.15),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.rightLeg.position.set(0.12, 0.3, 0);
    this.rightLeg.castShadow = true;
    this.mesh.add(this.rightLeg);

    // Left arm
    this.leftArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.45, 0.12),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.leftArm.position.set(-0.38, 1.05, 0);
    this.leftArm.castShadow = true;
    this.mesh.add(this.leftArm);

    // Right arm
    this.rightArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.45, 0.12),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.rightArm.position.set(0.38, 1.05, 0);
    this.rightArm.castShadow = true;
    this.mesh.add(this.rightArm);

    // Shoes
    const leftShoe = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.08, 0.22),
      new THREE.MeshLambertMaterial({ color: COLORS.playerShoes })
    );
    leftShoe.position.set(-0.12, 0.04, -0.03);
    this.mesh.add(leftShoe);

    const rightShoe = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.08, 0.22),
      new THREE.MeshLambertMaterial({ color: COLORS.playerShoes })
    );
    rightShoe.position.set(0.12, 0.04, -0.03);
    this.mesh.add(rightShoe);

    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    const shape = new CANNON.Sphere(SIZES.playerRadius);
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
      // Compute world-space direction based on camera (negate Y: screen-up is negative Y, but forward is positive angle)
      const moveAngle = Math.atan2(moveInput.x, -moveInput.y);
      const worldAngle = cameraYaw + moveAngle;

      const moveX = Math.sin(worldAngle) * this.speed * inputLen;
      const moveZ = Math.cos(worldAngle) * this.speed * inputLen;

      this.body.velocity.x = moveX;
      this.body.velocity.z = moveZ;

      // Face the movement direction
      this.facing.set(Math.sin(worldAngle), 0, Math.cos(worldAngle));

      // Walk animation
      this.animTime += dt * inputLen * 8;
      const swing = Math.sin(this.animTime) * 0.4;
      this.leftLeg.rotation.x = swing;
      this.rightLeg.rotation.x = -swing;
      this.leftArm.rotation.x = -swing * 0.6;
      this.rightArm.rotation.x = swing * 0.6;
    } else {
      // Idle
      this.animTime = 0;
      this.leftLeg.rotation.x = 0;
      this.rightLeg.rotation.x = 0;
      this.leftArm.rotation.x = 0;
      this.rightArm.rotation.x = 0;

      // Gentle breathing
      const breathe = Math.sin(Date.now() * 0.003) * 0.01;
      this.mesh.children[0].position.y = 1.1 + breathe;
    }

    // Sync mesh to physics
    this.mesh.position.set(
      this.body.position.x,
      this.body.position.y - 1,
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
