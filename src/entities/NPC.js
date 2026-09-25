import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Quality } from '../graphics/Quality.js';
import { SIZES } from '../utils/Constants.js';
import { mat } from '../graphics/Materials.js';
import { getGeometry, mergeParts, makeMatrix, roundedBox, sphereGeo } from '../graphics/GeometryUtils.js';
import {
  Character, BlobShadows, CameraTracker, hashString, SKIN_TONES, HAIR_COLORS,
} from './CharacterModel.js';

/**
 * Hand-authored looks for the shipped NPCs (keyed by npcs.json id). NPCs not listed here get a
 * deterministic look derived from their id + archetype (see _deriveStyle), so new JSON entries
 * still look distinct without touching code.
 */
const NPC_STYLES = {
  mrs_wellington: {
    female: true, skin: SKIN_TONES[0], hair: 'bob', hairColor: HAIR_COLORS.silver, hat: 'visor', hatColor: 0xF4F1EA,
    hatBrim: 0x6B3F8E, bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'haughty', mouth: 'flat', necklace: 0xF6F1E4,
    racket: 0x6B3F8E, collar: 0xF4F1EA, scale: 0.86,
  },
  chad_blake: {
    skin: SKIN_TONES[1], hair: 'swept', hairColor: HAIR_COLORS.blonde, hat: 'capBack', hatColor: 0xF2F0EA, hatBrim: 0x1F3A68,
    bottom: 'shorts', bottomColor: 0x1F3A68, brows: 'stern', mouth: 'grin', racket: 0x202020, wristband: 0xF2F0EA,
    shoeAccent: 0xC0392B, scale: 0.92,
  },
  maria_santos: {
    female: true, skin: SKIN_TONES[2], hair: 'ponytail', hairColor: HAIR_COLORS.brown, tieColor: 0xF4E8C1, hat: 'visor',
    hatColor: 0xF4F1EA, hatBrim: 0xD97B1A, bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'soft', mouth: 'smile', blush: true,
    racket: 0xD97B1A, sleeveTrim: 0xF4F1EA, scale: 0.84,
  },
  bob_hendricks: {
    skin: SKIN_TONES[1], hair: 'bald', hairColor: HAIR_COLORS.grey, hat: null, bottom: 'shorts', bottomColor: 0xC9B98E,
    brows: 'soft', mouth: 'smile', mustache: true, blush: true, racket: 0x2D5A3D, belt: 0x5A3A22, scale: 0.9,
  },
  kevin_park: {
    skin: SKIN_TONES[1], hair: 'short', hairColor: HAIR_COLORS.black, hat: null, bottom: 'shorts', bottomColor: 0x33363D,
    brows: 'worried', mouth: 'o', racket: 0xE8E8E8, polo: false, shoeAccent: 0x3498DB, belt: null, scale: 0.86,
  },
  priya_sharma: {
    female: true, skin: SKIN_TONES[2], hair: 'bun', hairColor: HAIR_COLORS.black, hat: 'headband', hatColor: 0xF4F1EA,
    bottom: 'skirt', bottomColor: 0x1B4F55, brows: 'worried', mouth: 'smile', racket: null, polo: false, belt: null, scale: 0.83,
  },
  diane_ross: {
    female: true, skin: SKIN_TONES[0], hair: 'bob', hairColor: HAIR_COLORS.blonde, hat: null, sunglasses: true,
    bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'haughty', mouth: 'flat', necklace: 0xC9A24A, racket: 0xF2F0EA,
    collar: 0xF4F1EA, scale: 0.87,
  },
  tommy_chen: {
    skin: SKIN_TONES[1], hair: 'short', hairColor: HAIR_COLORS.black, hat: 'headband', hatColor: 0xE67E22,
    bottom: 'shorts', bottomColor: 0xF2EFE8, brows: 'soft', mouth: 'grin', racket: 0xE67E22, wristband: 0xE67E22,
    polo: false, stripe: 0xF4F1EA, belt: null, scale: 0.84,
  },
  hank_morris: {
    skin: SKIN_TONES[3], hair: 'short', hairColor: HAIR_COLORS.grey, hat: 'bucket', hatColor: 0xB9A77A, hatBrim: 0xA8966A,
    bottom: 'pants', bottomColor: 0x6B6452, brows: 'stern', mouth: 'smile', mustache: true, racket: null,
    shoes: 0x6A4A2E, shoeSole: 0x3A2A1C, shoeAccent: 0x5A3E26, collar: 0xD9CDA8, belt: 0x3B2A1E, scale: 0.9,
  },
};

const ARCH_ACCENT = { entitled: '#E74C3C', friendly: '#27AE60', clueless: '#3498DB' };

// Name tag fade distances (camera -> tag)
const TAG_FAR_FULL = 11;
const TAG_FAR_ZERO = 16;
const TAG_NEAR_ZERO = 2.2;
const TAG_NEAR_FULL = 3.6;
const TAG_W = 1.25;          // world width at normal distances
const TAG_CONST_DIST = 7;    // closer than this the tag shrinks to keep a constant on-screen size

const _emojiTextures = new Map();

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
    this._markerTime = 0;
    this._moving = 0;

    this.reactionSprite = null;
    this.reactionTimer = 0;

    CameraTracker.install(scene);
    this._blobs = BlobShadows.get(scene);
    this._blobSlot = this._blobs.alloc();

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
      // Numbered spots for the area (patio1..3) are shared out at random so NPCs
      // don't all stack on the first; otherwise the first waypoint naming the area.
      const a = area.toLowerCase();
      const numbered = [];
      let first = null;
      for (const [key, wp] of Object.entries(this.waypoints)) {
        const k = key.toLowerCase();
        if (!k.includes(a)) continue;
        if (!first) first = wp;
        if (k.startsWith(a) && /^\d+$/.test(k.slice(a.length))) numbered.push(wp);
      }
      if (numbered.length) return numbered[Math.floor(Math.random() * numbered.length)];
      if (first) return first;
    }
    // Fallback to a random waypoint
    const keys = Object.keys(this.waypoints);
    return this.waypoints[keys[Math.floor(Math.random() * keys.length)]];
  }

  /** Deterministic fallback look for NPCs without a hand-authored style. */
  _deriveStyle() {
    const h = (salt) => hashString(this.id + salt);
    const female = h('f') < 0.5;
    const hairs = female ? ['bob', 'ponytail', 'bun', 'long'] : ['short', 'swept', 'bald', 'short'];
    const hats = [null, 'cap', 'visor', 'headband'];
    const hairKeys = Object.keys(HAIR_COLORS);
    const brows = { entitled: 'haughty', friendly: 'soft', clueless: 'worried' }[this.archetype] || 'soft';
    const mouth = { entitled: 'flat', friendly: 'smile', clueless: 'o' }[this.archetype] || 'smile';
    return {
      female,
      skin: SKIN_TONES[Math.floor(h('s') * SKIN_TONES.length)],
      hair: hairs[Math.floor(h('h') * hairs.length)],
      hairColor: HAIR_COLORS[hairKeys[Math.floor(h('c') * hairKeys.length)]],
      hat: hats[Math.floor(h('t') * hats.length)],
      hatColor: 0xF2F0EA,
      bottom: female && h('b') < 0.7 ? 'skirt' : 'shorts',
      bottomColor: h('bc') < 0.6 ? 0xF2EFE8 : 0x2F3440,
      brows, mouth,
      blush: this.archetype === 'friendly',
      racket: h('r') < 0.6 ? 0x2B2B2B : null,
      polo: h('p') < 0.6,
      scale: 0.83 + h('sc') * 0.09,
    };
  }

  _createMesh(pos) {
    this.mesh = new THREE.Group();
    this.mesh.name = `NPC:${this.id}`;

    const style = { ...(NPC_STYLES[this.id] || this._deriveStyle()) };
    style.shirt = this.shirtColor;
    this.style = style;

    this.character = new Character(style, `npc:${this.id}:${this.data.shirtColor}`);
    const s = style.scale ?? 0.87;
    this.character.root.scale.setScalar(s);
    this.mesh.add(this.character.root);
    this.modelScale = s;

    // Legacy limb handles (other code / debugging may poke these)
    this.leftLeg = this.character.legL;
    this.rightLeg = this.character.legR;
    this.leftArm = this.character.armL;
    this.rightArm = this.character.armR;

    this.mesh.position.set(pos.x, pos.y || 0, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    const shape = new CANNON.Sphere(SIZES.npcRadius);
    this.body = new CANNON.Body({
      mass: 60,
      position: new CANNON.Vec3(pos.x, (pos.y || 0) + SIZES.npcRadius, pos.z), // resting on the ground
      shape,
      linearDamping: 0.95,
      angularDamping: 1.0,
      fixedRotation: true,
    });
    this.physicsWorld.addBody(this.body);
    this._settleTime = 1.5;
  }

  /** Club-style pill name tag (forest green + cream, archetype colour dot). */
  _createNameTag() {
    const W = 256, H = 64;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const font = '600 26px "Trebuchet MS", "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.font = font;
    const textW = Math.min(W - 64, ctx.measureText(this.data.name).width);
    const pillW = Math.min(W - 6, textW + 58);
    const x0 = (W - pillW) / 2;
    const y0 = 10, ph = 44, r = ph / 2;

    // Soft drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.roundRect(x0 + 1, y0 + 3, pillW, ph, r);
    ctx.fill();
    // Pill
    ctx.fillStyle = 'rgba(33,69,47,0.94)';
    ctx.beginPath();
    ctx.roundRect(x0, y0, pillW, ph, r);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#E9DCB2';
    ctx.beginPath();
    ctx.roundRect(x0 + 2.5, y0 + 2.5, pillW - 5, ph - 5, r - 2.5);
    ctx.stroke();
    // Archetype dot
    ctx.fillStyle = ARCH_ACCENT[this.archetype] || '#C9A24A';
    ctx.beginPath();
    ctx.arc(x0 + 22, y0 + ph / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#F4E8C1';
    ctx.stroke();
    // Name
    ctx.font = font;
    ctx.fillStyle = '#F4E8C1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.data.name, x0 + 36, y0 + ph / 2 + 1, W - x0 - 44);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 2;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false })
    );
    sprite.scale.set(TAG_W, TAG_W * H / W, 1);
    this._tagAspect = H / W;
    sprite.center.set(0.5, 0);
    sprite.position.y = this._headTop() + 0.06;
    sprite.renderOrder = 10;
    sprite.material.opacity = 0;
    sprite.visible = false;
    this.mesh.add(sprite);
    this.nameTag = sprite;
  }

  _headTop() {
    const hatExtra = this.style.hat === 'bucket' ? 0.12 : (this.style.hair === 'bun' ? 0.06 : 0);
    return (1.84 + hatExtra) * this.modelScale;
  }

  /** Bouncy gold "!" request marker (shared geometry/material). */
  _createExclamation() {
    const geo = getGeometry('npc-exclaim', () => mergeParts([
      { geometry: roundedBox(0.12, 0.3, 0.12, 0.05, 3), matrix: makeMatrix(0, 0.12, 0) },
      { geometry: sphereGeo(0.07, 12, 8), matrix: makeMatrix(0, -0.13, 0) },
    ]));
    const material = mat(0xF2B82E, { emissive: 0xB0740C, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.25 });
    const marker = new THREE.Mesh(geo, material);
    marker.name = 'RequestMarker';
    marker.userData.noAO = true;
    const baseY = this._headTop() + 0.72;
    marker.position.y = baseY;
    marker.visible = false;
    this._markerBaseY = baseY;
    this.mesh.add(marker);
    this.exclamation = marker;
  }

  setHasRequest(val) {
    this.hasRequest = val;
    this.exclamation.visible = val;
    if (val) this._markerTime = 0;
  }

  showReaction(emoji) {
    let texture = _emojiTextures.get(emoji);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext('2d');
      ctx.font = '72px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, 48, 52);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      _emojiTextures.set(emoji, texture);
    }
    if (!this.reactionSprite) {
      this.reactionSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false })
      );
      this.reactionSprite.scale.set(0.6, 0.6, 1);
      this.reactionSprite.renderOrder = 11;
    } else {
      this.reactionSprite.material.map = texture;
    }
    this.reactionSprite.material.opacity = 1;
    this.reactionSprite.position.y = this._headTop() + 0.9;
    if (!this.reactionSprite.parent) this.mesh.add(this.reactionSprite);
    this.reactionTimer = 2.0;
  }

  update(dt, playerPos) {
    // Reaction timer (float up + fade)
    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt;
      if (this.reactionSprite) {
        const age = 2.0 - this.reactionTimer;
        this.reactionSprite.position.y = this._headTop() + 0.9 + age * 0.3;
        const pop = Math.min(1, age * 6);
        const sc = 0.6 * (0.6 + 0.4 * pop + 0.12 * Math.sin(Math.min(1, age * 3) * Math.PI));
        this.reactionSprite.scale.set(sc, sc, 1);
        this.reactionSprite.material.opacity = Math.max(0, Math.min(1, this.reactionTimer));
      }
      if (this.reactionTimer <= 0 && this.reactionSprite) {
        this.mesh.remove(this.reactionSprite);
      }
    }

    // State machine
    this._moving = 0;
    switch (this.state) {
      case 'idle':
        this._updateIdle(dt);
        break;
      case 'wandering':
        this._updateWandering(dt);
        break;
      case 'talking':
        this._faceTarget(playerPos, dt);
        break;
      case 'playing':
        this._updatePlaying(dt);
        break;
    }

    // Just after spawning, pull a hovering body down briskly (linearDamping also damps gravity)
    if (this._settleTime > 0) {
      this._settleTime -= dt;
      if (this.body.position.y > SIZES.npcRadius + 0.02) this.body.velocity.y = Math.min(this.body.velocity.y, -6);
    }

    // Sync mesh to physics (feet on the ground: sphere centre minus its radius)
    this.mesh.position.set(
      this.body.position.x,
      Math.max(0, this.body.position.y - SIZES.npcRadius),
      this.body.position.z
    );

    const mode = this.state === 'talking' ? 'talking' : (this.state === 'playing' ? 'playing' : 'idle');
    this.character.update(dt, this._moving, 7.5, mode);

    const bs = 0.95 * this.modelScale;
    this._blobs.set(this._blobSlot, this.mesh.position.x, this.mesh.position.z, bs, bs, 0, Math.max(this.mesh.position.y + 0.02, 0.065));

    this._updateOverlays(dt, playerPos);
  }

  _updateOverlays(dt, playerPos) {
    // Camera distance (fallback: player distance + typical camera offset)
    let camDist;
    if (CameraTracker.valid) {
      const c = CameraTracker.position;
      const dx = c.x - this.mesh.position.x, dy = c.y - (this.mesh.position.y + 1.6), dz = c.z - this.mesh.position.z;
      camDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    } else {
      camDist = playerPos ? this.mesh.position.distanceTo(playerPos) + 8 : 10;
    }

    // Name tag: visible in a comfortable band, faded at the edges
    let a = 1;
    if (camDist > TAG_FAR_FULL) a = 1 - (camDist - TAG_FAR_FULL) / (TAG_FAR_ZERO - TAG_FAR_FULL);
    if (camDist < TAG_NEAR_FULL) a = Math.min(a, (camDist - TAG_NEAR_ZERO) / (TAG_NEAR_FULL - TAG_NEAR_ZERO));
    if (this.state === 'talking') a = Math.min(a, 0.35);
    a = Math.max(0, Math.min(1, a));
    this._camDist = camDist;
    // Body LOD: low-detail mesh when far (hysteresis) and always on the low tier
    const far = Quality.tier === 'low' || (this._lodFar ? camDist > 13 : camDist > 16);
    if (far !== this._lodFar) { this._lodFar = far; this.character.setLod(far); }
    const tag = this.nameTag;
    tag.material.opacity += (a - tag.material.opacity) * Math.min(1, dt * 10);
    tag.visible = tag.material.opacity > 0.02;
    if (tag.visible) {
      const w = TAG_W * Math.min(1, camDist / TAG_CONST_DIST);
      tag.scale.set(w, w * this._tagAspect, 1);
    }

    // Request marker: bounce + squash + spin, scaled up a little with distance for readability
    if (this.exclamation.visible) {
      this._markerTime += dt;
      const t = this._markerTime;
      const bounce = Math.abs(Math.sin(t * 4.2));
      const squash = 1 - Math.max(0, 0.25 - bounce) * 0.8;
      const grow = camDist < 6 ? Math.max(0.35, camDist / 6) : Math.min(2.2, Math.max(1, camDist / 12));
      const intro = Math.min(1, t * 4);
      this.exclamation.position.y = this._markerBaseY + bounce * 0.22 + (grow - 1) * 0.3;
      this.exclamation.rotation.y += dt * 2.2;
      this.exclamation.scale.set(grow * intro * (2 - squash), grow * intro * squash, grow * intro * (2 - squash));
    }
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

    // Face movement direction (smoothly)
    this._turnToward(Math.atan2(dx, dz), dt, 8);

    this.animTime += dt * 6;
    this._moving = 1;
  }

  _updatePlaying(dt) {
    this.animTime += dt * 3;
  }

  _turnToward(target, dt, rate) {
    let d = target - this.mesh.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.mesh.rotation.y += d * Math.min(1, dt * rate);
  }

  _faceTarget(targetPos, dt = 0.016) {
    if (!targetPos) return;
    const dx = targetPos.x - this.mesh.position.x;
    const dz = targetPos.z - this.mesh.position.z;
    this._turnToward(Math.atan2(dx, dz), dt, 10);
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
