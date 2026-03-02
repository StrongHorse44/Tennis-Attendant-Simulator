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

    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    const shape = new CANNON.Box(
      new CANNON.Vec3(SIZES.cartWidth / 2, 0.4, SIZES.cartLength / 2)
    );
    this.body = new CANNON.Body({
      mass: 400,
      position: new CANNON.Vec3(pos.x, pos.y + 0.6, pos.z),
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
    this.steerAngle = THREE.MathUtils.lerp(this.steerAngle, -steer * 0.6, dt * 5);

    // Get cart forward direction (-Z is front/headlights)
    const quat = this.body.quaternion;
    const fwd = new CANNON.Vec3(0, 0, -1);
    quat.vmult(fwd, fwd);

    // Current speed along forward axis
    const fwdSpeed = this.body.velocity.x * fwd.x + this.body.velocity.z * fwd.z;

    // Drive using direct velocity (applyForce gets eaten by box-plane friction)
    if (forward < -0.1) {
      // Accelerate forward
      const targetSpeed = SIZES.cartMaxSpeed * Math.abs(forward);
      const newSpeed = Math.min(fwdSpeed + SIZES.cartAcceleration * dt, targetSpeed);
      this.body.velocity.x = fwd.x * newSpeed;
      this.body.velocity.z = fwd.z * newSpeed;
    } else if (forward > 0.1) {
      // Reverse
      const targetSpeed = -SIZES.cartMaxSpeed * 0.4 * Math.abs(forward);
      const newSpeed = Math.max(fwdSpeed - SIZES.cartAcceleration * dt * 0.5, targetSpeed);
      this.body.velocity.x = fwd.x * newSpeed;
      this.body.velocity.z = fwd.z * newSpeed;
    } else {
      // Coast deceleration
      const decay = 1 - 2 * dt;
      this.body.velocity.x *= decay;
      this.body.velocity.z *= decay;
    }

    // Turn (only when moving)
    const absSpeed = this.body.velocity.length();
    if (absSpeed > 0.5) {
      const turnForce = this.steerAngle * Math.min(absSpeed, 8) * 0.5;
      this.body.angularVelocity.y = turnForce;
    } else {
      this.body.angularVelocity.y = 0;
    }

    // Keep cart upright
    this.body.quaternion.x *= 0.95;
    this.body.quaternion.z *= 0.95;
    this.body.quaternion.normalize();

    // Wheel spin animation
    const wheelSpin = speed * dt * 2;
    for (const w of this.wheels) {
      w.rotation.x += wheelSpin;
    }

    // Steering wheel animation
    this.steeringWheel.rotation.z = this.steerAngle * 2;

    this.currentSpeed = speed;
    this._syncMesh();
  }

  _syncMesh() {
    this.mesh.position.set(
      this.body.position.x,
      this.body.position.y - 0.4,
      this.body.position.z
    );
    this.mesh.quaternion.set(
      this.body.quaternion.x,
      this.body.quaternion.y,
      this.body.quaternion.z,
      this.body.quaternion.w
    );
  }

  getPosition() {
    return this.mesh.position;
  }

  distanceTo(point) {
    return this.mesh.position.distanceTo(point);
  }
}
