import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';

/**
 * NPC - club member with wandering, dialogue, and task functionality
 */
export class NPC {
  constructor(scene, physicsWorld, data, waypoints) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.data = data;
    this.waypoints = waypoints;

    this.id = data.id;
    this.name = data.name;
    this.archetype = data.archetype;
    this.shirtColor = parseInt(data.shirtColor.replace('#', ''), 16);

    this.mesh = null;
    this.body = null;
    this.nameTag = null;
    this.exclamation = null;

    this.state = 'idle'; // idle, wandering, talking, playing
    this.currentTarget = null;
    this.wanderTimer = Math.random() * 5 + 2;
    this.hasRequest = false;
    this.mood = 'neutral';
    this.animTime = 0;

    this.reactionSprite = null;
    this.reactionTimer = 0;

    const startWaypoint = this._getPreferredWaypoint();
    this._createMesh(startWaypoint);
    this._createPhysics(startWaypoint);
    this._createNameTag();
    this._createExclamation();
  }

  _getPreferredWaypoint() {
    const prefs = this.data.preferredAreas;
    if (prefs && prefs.length > 0) {
      const area = prefs[Math.floor(Math.random() * prefs.length)];
      // Find a waypoint matching this area
      for (const [key, wp] of Object.entries(this.waypoints)) {
        if (key.toLowerCase().includes(area.toLowerCase())) {
          return wp;
        }
      }
    }
    // Fallback to a random waypoint
    const keys = Object.keys(this.waypoints);
    return this.waypoints[keys[Math.floor(Math.random() * keys.length)]];
  }

  _createMesh(pos) {
    this.mesh = new THREE.Group();

    const archColors = {
      entitled: COLORS.npcEntitled,
      friendly: COLORS.npcFriendly,
      clueless: COLORS.npcClueless,
    };
    const outlineColor = archColors[this.archetype] || 0xAAAAAA;

    // Body (shirt)
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.55, 0.3),
      new THREE.MeshLambertMaterial({ color: this.shirtColor })
    );
    torso.position.y = 1.05;
    torso.castShadow = true;
    this.mesh.add(torso);

    // Shorts/pants
    const shorts = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.3, 0.28),
      new THREE.MeshLambertMaterial({ color: 0x444455 })
    );
    shorts.position.y = 0.65;
    shorts.castShadow = true;
    this.mesh.add(shorts);

    // Head
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 8),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    head.position.y = 1.5;
    head.castShadow = true;
    this.mesh.add(head);

    // Legs
    this.leftLeg = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.45, 0.13),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.leftLeg.position.set(-0.1, 0.28, 0);
    this.mesh.add(this.leftLeg);

    this.rightLeg = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.45, 0.13),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.rightLeg.position.set(0.1, 0.28, 0);
    this.mesh.add(this.rightLeg);

    // Arms
    this.leftArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.4, 0.1),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.leftArm.position.set(-0.33, 1.0, 0);
    this.mesh.add(this.leftArm);

    this.rightArm = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.4, 0.1),
      new THREE.MeshLambertMaterial({ color: COLORS.playerSkin })
    );
    this.rightArm.position.set(0.33, 1.0, 0);
    this.mesh.add(this.rightArm);

    // Archetype indicator ring at feet
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.5, 16),
      new THREE.MeshBasicMaterial({ color: outlineColor, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.mesh.add(ring);

    this.mesh.position.set(pos.x, pos.y || 0, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    const shape = new CANNON.Sphere(SIZES.npcRadius);
    this.body = new CANNON.Body({
      mass: 60,
      position: new CANNON.Vec3(pos.x, (pos.y || 0) + 1, pos.z),
      shape,
      linearDamping: 0.95,
      angularDamping: 1.0,
      fixedRotation: true,
    });
    this.physicsWorld.addBody(this.body);
  }

  _createNameTag() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.roundRect(4, 4, 248, 56, 8);
    ctx.fill();

    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = this.data.archetype === 'entitled' ? '#E74C3C' :
                    this.data.archetype === 'friendly' ? '#27AE60' : '#3498DB';
    ctx.textAlign = 'center';
    ctx.fillText(this.data.name, 128, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(2, 0.5, 1);
    sprite.position.y = 2.0;
    this.mesh.add(sprite);
    this.nameTag = sprite;
  }

  _createExclamation() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // Yellow circle with !
    ctx.fillStyle = '#F1C40F';
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 40px sans-serif';
    ctx.fillStyle = '#333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 32, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(0.5, 0.5, 1);
    sprite.position.y = 2.5;
    sprite.visible = false;
    this.mesh.add(sprite);
    this.exclamation = sprite;
  }

  setHasRequest(val) {
    this.hasRequest = val;
    this.exclamation.visible = val;
  }

  showReaction(emoji) {
    if (this.reactionSprite) {
      this.mesh.remove(this.reactionSprite);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = '48px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 32, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(0.6, 0.6, 1);
    sprite.position.y = 2.8;
    this.mesh.add(sprite);
    this.reactionSprite = sprite;
    this.reactionTimer = 2.0;
  }

  update(dt, playerPos) {
    // Reaction timer
    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt;
      if (this.reactionSprite) {
        this.reactionSprite.position.y = 2.8 + (2.0 - this.reactionTimer) * 0.3;
        this.reactionSprite.material.opacity = Math.min(1, this.reactionTimer);
      }
      if (this.reactionTimer <= 0 && this.reactionSprite) {
        this.mesh.remove(this.reactionSprite);
        this.reactionSprite = null;
      }
    }

    // Exclamation bob
    if (this.exclamation.visible) {
      this.exclamation.position.y = 2.5 + Math.sin(Date.now() * 0.005) * 0.15;
    }

    // State machine
    switch (this.state) {
      case 'idle':
        this._updateIdle(dt);
        break;
      case 'wandering':
        this._updateWandering(dt);
        break;
      case 'talking':
        this._faceTarget(playerPos);
        break;
      case 'playing':
        this._updatePlaying(dt);
        break;
    }

    // Sync mesh to physics
    this.mesh.position.set(
      this.body.position.x,
      this.body.position.y - 1,
      this.body.position.z
    );
  }

  _updateIdle(dt) {
    this.wanderTimer -= dt;
    // Idle breathing
    const breathe = Math.sin(Date.now() * 0.002 + this.id.length) * 0.01;
    this.mesh.children[0].position.y = 1.05 + breathe;

    if (this.wanderTimer <= 0) {
      this.state = 'wandering';
      this.currentTarget = this._getPreferredWaypoint();
      this.wanderTimer = Math.random() * 8 + 4;
    }
  }

  _updateWandering(dt) {
    if (!this.currentTarget) {
      this.state = 'idle';
      return;
    }

    const dx = this.currentTarget.x - this.body.position.x;
    const dz = this.currentTarget.z - this.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 1.5) {
      this.state = 'idle';
      this.body.velocity.set(0, this.body.velocity.y, 0);
      this.wanderTimer = Math.random() * 8 + 4;
      return;
    }

    const speed = SIZES.npcSpeed;
    this.body.velocity.x = (dx / dist) * speed;
    this.body.velocity.z = (dz / dist) * speed;

    // Face movement direction
    const angle = Math.atan2(dx, dz);
    this.mesh.rotation.y = angle;

    // Walk animation
    this.animTime += dt * 6;
    const swing = Math.sin(this.animTime) * 0.3;
    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -swing * 0.5;
    this.rightArm.rotation.x = swing * 0.5;
  }

  _updatePlaying(dt) {
    // Simple tennis-playing animation (arm swinging)
    this.animTime += dt * 3;
    this.rightArm.rotation.x = Math.sin(this.animTime) * 0.8;
    this.rightArm.rotation.z = Math.sin(this.animTime * 0.5) * 0.2;
  }

  _faceTarget(targetPos) {
    if (!targetPos) return;
    const dx = targetPos.x - this.mesh.position.x;
    const dz = targetPos.z - this.mesh.position.z;
    this.mesh.rotation.y = Math.atan2(dx, dz);
    this.body.velocity.set(0, this.body.velocity.y, 0);

    // Reset walk animation
    this.leftLeg.rotation.x = 0;
    this.rightLeg.rotation.x = 0;
    this.leftArm.rotation.x = 0;
    this.rightArm.rotation.x = 0;
  }

  startTalking() {
    this.state = 'talking';
    this.body.velocity.set(0, this.body.velocity.y, 0);
  }

  stopTalking() {
    this.state = 'idle';
    this.wanderTimer = Math.random() * 5 + 3;
  }

  distanceTo(point) {
    return this.mesh.position.distanceTo(point);
  }
}
