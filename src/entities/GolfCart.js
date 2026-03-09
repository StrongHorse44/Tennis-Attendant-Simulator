import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';

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

    this._createMesh(position);
    this._createPhysics(position);
  }

  _createMesh(pos) {
    this.mesh = new THREE.Group();

    // Cart body (main chassis)
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(SIZES.cartWidth, 0.3, SIZES.cartLength),
      new THREE.MeshLambertMaterial({ color: COLORS.golfCart })
    );
    chassis.position.y = 0.5;
    chassis.castShadow = true;
    chassis.receiveShadow = true;
    this.mesh.add(chassis);

    // Floor
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(SIZES.cartWidth - 0.1, 0.05, SIZES.cartLength - 0.2),
      new THREE.MeshLambertMaterial({ color: 0xCCCCCC })
    );
    floor.position.y = 0.35;
    this.mesh.add(floor);

    // Seat
    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(SIZES.cartWidth - 0.3, 0.15, 0.6),
      new THREE.MeshLambertMaterial({ color: COLORS.golfCartSeat })
    );
    seat.position.set(0, 0.75, 0.3);
    seat.castShadow = true;
    this.mesh.add(seat);

    // Seat back
    const seatBack = new THREE.Mesh(
      new THREE.BoxGeometry(SIZES.cartWidth - 0.3, 0.5, 0.1),
      new THREE.MeshLambertMaterial({ color: COLORS.golfCartSeat })
    );
    seatBack.position.set(0, 1.0, 0.6);
    seatBack.castShadow = true;
    this.mesh.add(seatBack);

    // Roof
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(SIZES.cartWidth + 0.1, 0.08, SIZES.cartLength + 0.1),
      new THREE.MeshLambertMaterial({ color: COLORS.golfCartRoof })
    );
    roof.position.y = 1.8;
    roof.castShadow = true;
    this.mesh.add(roof);

    // Roof supports (4 posts)
    const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.2);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
    const posts = [
      [-0.7, 1.2, -1.0],
      [0.7, 1.2, -1.0],
      [-0.7, 1.2, 1.0],
      [0.7, 1.2, 1.0],
    ];
    for (const [px, py, pz] of posts) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(px, py, pz);
      this.mesh.add(post);
    }

    // Steering wheel
    const steering = new THREE.Mesh(
      new THREE.TorusGeometry(0.12, 0.02, 8, 12),
      new THREE.MeshLambertMaterial({ color: 0x333333 })
    );
    steering.position.set(-0.3, 0.95, -0.5);
    steering.rotation.x = -Math.PI / 4;
    this.mesh.add(steering);
    this.steeringWheel = steering;

    // Wheels (4)
    const wheelGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.12, 8);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    this.wheels = [];
    const wheelPositions = [
      [-0.8, 0.2, -0.9],
      [0.8, 0.2, -0.9],
      [-0.8, 0.2, 0.9],
      [0.8, 0.2, 0.9],
    ];
    for (const [wx, wy, wz] of wheelPositions) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(wx, wy, wz);
      wheel.rotation.z = Math.PI / 2;
      wheel.castShadow = true;
      this.mesh.add(wheel);
      this.wheels.push(wheel);
    }

    // Headlights
    const lightGeo = new THREE.SphereGeometry(0.08, 6, 6);
    const lightMat = new THREE.MeshLambertMaterial({ color: 0xFFFF88, emissive: 0x444400 });
    const ll = new THREE.Mesh(lightGeo, lightMat);
    ll.position.set(-0.5, 0.55, -1.4);
    this.mesh.add(ll);
    const rl = new THREE.Mesh(lightGeo, lightMat);
    rl.position.set(0.5, 0.55, -1.4);
    this.mesh.add(rl);

    // Rear cargo area
    const cargo = new THREE.Mesh(
      new THREE.BoxGeometry(SIZES.cartWidth - 0.2, 0.3, 0.6),
      new THREE.MeshLambertMaterial({ color: 0xDDDDDD })
    );
    cargo.position.set(0, 0.55, 1.2);
    this.mesh.add(cargo);

    // Scale down the cart mesh for better proportions relative to courts
    const s = SIZES.cartScale;
    this.mesh.scale.set(s, s, s);

    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(this.mesh);
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
    if (!isOccupied) {
      // Apply brake when not occupied
      this.body.velocity.x *= 0.98;
      this.body.velocity.z *= 0.98;
      this._syncMesh();
      return;
    }

    // Wake body in case it went to sleep
    this.body.wakeUp();

    const forward = moveInput.y;
    const steer = moveInput.x;

    // Steering
    this.steerAngle = THREE.MathUtils.lerp(this.steerAngle, -steer * 0.5, dt * 5);

    // Get cart forward direction (-Z is front/headlights)
    const quat = this.body.quaternion;
    const fwd = new CANNON.Vec3(0, 0, -1);
    quat.vmult(fwd, fwd);

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
      const turnForce = this.steerAngle * Math.min(absSpeed, 6) * 0.45;
      this.body.angularVelocity.y = turnForce;
    } else {
      this.body.angularVelocity.y = 0;
    }

    // Keep cart upright
    this.body.quaternion.x *= 0.95;
    this.body.quaternion.z *= 0.95;
    this.body.quaternion.normalize();

    // Wheel spin animation
    const wheelSpin = absSpeed * dt * 2;
    for (const w of this.wheels) {
      w.rotation.x += wheelSpin;
    }

    // Steering wheel animation
    this.steeringWheel.rotation.z = this.steerAngle * 2;

    this._syncMesh();
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
  }

  attachBrush() {
    if (this.hasBrush) return;
    this.hasBrush = true;

    this.brushMesh = new THREE.Group();

    // Tow bar (connects cart rear to brush)
    const towBar = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.08, 1.2),
      new THREE.MeshLambertMaterial({ color: COLORS.dragBrushFrame })
    );
    towBar.position.set(0, 0.3, 2.2);
    this.brushMesh.add(towBar);

    // Brush frame (U-shaped handles)
    const frameLeft = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 1.0),
      new THREE.MeshLambertMaterial({ color: COLORS.dragBrushFrame })
    );
    frameLeft.position.set(-1.2, 0.25, 3.0);
    this.brushMesh.add(frameLeft);

    const frameRight = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.06, 1.0),
      new THREE.MeshLambertMaterial({ color: COLORS.dragBrushFrame })
    );
    frameRight.position.set(1.2, 0.25, 3.0);
    this.brushMesh.add(frameRight);

    // Cross bar
    const crossBar = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 0.06, 0.06),
      new THREE.MeshLambertMaterial({ color: COLORS.dragBrushFrame })
    );
    crossBar.position.set(0, 0.25, 3.5);
    this.brushMesh.add(crossBar);

    // Bristle block (the actual brush head - 6ft / ~1.8m wide)
    const bristles = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.12, 0.6),
      new THREE.MeshLambertMaterial({ color: COLORS.dragBrushBristles })
    );
    bristles.position.set(0, 0.08, 3.5);
    bristles.castShadow = true;
    this.brushMesh.add(bristles);

    // Bristle texture stripes (visual detail)
    const stripeMat = new THREE.MeshLambertMaterial({ color: 0x6B5B3F });
    for (let i = -3; i <= 3; i++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.13, 0.62),
        stripeMat
      );
      stripe.position.set(i * 0.3, 0.08, 3.5);
      this.brushMesh.add(stripe);
    }

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
  getBrushWorldPosition() {
    if (!this.hasBrush) return null;
    // Brush is at local Z=3.5 behind the cart
    const localBrushPos = new THREE.Vector3(0, 0.1, 3.5);
    const worldPos = localBrushPos.clone();
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
