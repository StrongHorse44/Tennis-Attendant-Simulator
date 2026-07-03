import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SIZES } from '../utils/Constants.js';
import { CharacterRig } from './CharacterRig.js';

// Old primitive NPC body measured ~1.66 world units tall (head-top to
// ring-bottom Box3, no scale applied to NPC meshes). The rig targets that
// same height so gameplay proportions are unaffected by the model swap.
const NPC_TARGET_HEIGHT = 1.66;

// Deterministic model pick per archetype variety - hashed from the NPC id
// so each NPC keeps the same look across sessions/reloads.
const NPC_MODELS = ['male', 'skater-male', 'skater-female', 'survivor-male', 'survivor-female'];

function hashModelPick(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return NPC_MODELS[Math.abs(hash) % NPC_MODELS.length];
}

// Vertical offsets for floating sprites, relative to the rig's own height -
// matches the old fixed offsets (2.0 / 2.5 / 2.8) which were tuned against
// the old ~1.68-tall primitive body.
const NAME_TAG_MARGIN = 0.32;
const EXCLAMATION_MARGIN = 0.82;
const REACTION_MARGIN = 1.12;

/**
 * NPC - club member with wandering, dialogue, and task functionality
 */
export class NPC {
  constructor(scene, physicsWorld, data, waypoints, assets) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.data = data;
    this.waypoints = waypoints;
    this.assets = assets;

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
    const modelName = hashModelPick(this.id);
    const instance = this.assets.getModelInstance(modelName, { skinned: true });
    this.rig = new CharacterRig(instance, NPC_TARGET_HEIGHT);
    this.mesh = this.rig.group;

    this.mesh.position.set(pos.x, pos.y || 0, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    // Stored so update() can sync the (feet-at-group-origin) rig group to
    // the physics sphere's center regardless of resting contact height.
    this.radius = SIZES.npcRadius;
    const shape = new CANNON.Sphere(this.radius);
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
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(2, 0.5, 1);
    sprite.position.y = this.rig.height + NAME_TAG_MARGIN;
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
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(0.5, 0.5, 1);
    sprite.position.y = this.rig.height + EXCLAMATION_MARGIN;
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
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(0.6, 0.6, 1);
    sprite.position.y = this.rig.height + REACTION_MARGIN;
    this.mesh.add(sprite);
    this.reactionSprite = sprite;
    this.reactionTimer = 2.0;
  }

  update(dt, playerPos) {
    // Reaction timer
    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt;
      if (this.reactionSprite) {
        this.reactionSprite.position.y = this.rig.height + REACTION_MARGIN + (2.0 - this.reactionTimer) * 0.3;
        this.reactionSprite.material.opacity = Math.min(1, this.reactionTimer);
      }
      if (this.reactionTimer <= 0 && this.reactionSprite) {
        this.mesh.remove(this.reactionSprite);
        this.reactionSprite = null;
      }
    }

    // Exclamation bob
    if (this.exclamation.visible) {
      this.exclamation.position.y = this.rig.height + EXCLAMATION_MARGIN + Math.sin(Date.now() * 0.005) * 0.15;
    }

    // State machine
    let speed = 0;
    switch (this.state) {
      case 'idle':
        this._updateIdle(dt);
        break;
      case 'wandering':
        speed = this._updateWandering(dt);
        break;
      case 'talking':
        this._faceTarget(playerPos);
        break;
      case 'playing':
        this._updatePlaying(dt);
        break;
    }

    // Procedural walk/idle animation
    this.rig.update(dt, speed);

    // Sync mesh to physics. The sphere rests with its center `radius` above
    // the ground contact point, and the rig's feet sit at group-local y=0,
    // so subtracting `radius` (not a hardcoded offset) keeps feet grounded.
    this.mesh.position.set(
      this.body.position.x,
      this.body.position.y - this.radius,
      this.body.position.z
    );
  }

  _updateIdle(dt) {
    this.wanderTimer -= dt;

    if (this.wanderTimer <= 0) {
      this.state = 'wandering';
      this.currentTarget = this._getPreferredWaypoint();
      this.wanderTimer = Math.random() * 8 + 4;
    }
  }

  _updateWandering(dt) {
    if (!this.currentTarget) {
      this.state = 'idle';
      return 0;
    }

    const dx = this.currentTarget.x - this.body.position.x;
    const dz = this.currentTarget.z - this.body.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 1.5) {
      this.state = 'idle';
      this.body.velocity.set(0, this.body.velocity.y, 0);
      this.wanderTimer = Math.random() * 8 + 4;
      return 0;
    }

    const speed = SIZES.npcSpeed;
    this.body.velocity.x = (dx / dist) * speed;
    this.body.velocity.z = (dz / dist) * speed;

    // Face movement direction
    const angle = Math.atan2(dx, dz);
    this.mesh.rotation.y = angle;

    return 1;
  }

  _updatePlaying(dt) {
    // Tennis-playing NPCs just idle-animate for now (no dedicated swing rig pose).
  }

  _faceTarget(targetPos) {
    if (!targetPos) return;
    const dx = targetPos.x - this.mesh.position.x;
    const dz = targetPos.z - this.mesh.position.z;
    this.mesh.rotation.y = Math.atan2(dx, dz);
    this.body.velocity.set(0, this.body.velocity.y, 0);
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
