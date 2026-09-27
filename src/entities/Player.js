import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';
import {
  Character, BlobShadows, SKIN_TONES, HAIR_COLORS, followGroundY, resetGroundY, blobGroundY,
} from './CharacterModel.js';
import { groundAt, inCut, inFootprint, pushOutOfFootprint } from '../world/Ground.js';

// Seated placement inside the cart (cart-local, unscaled cart units). The driver sits on the
// left seat (steering wheel side), facing the cart's front (-Z).
const SEAT_POS = new THREE.Vector3(-0.34, 0.2, 0.3);

const PLAYER_STYLE = {
  skin: SKIN_TONES[1],
  shirt: COLORS.playerPolo,
  collar: COLORS.playerCollar,
  sleeveTrim: COLORS.playerCollar,
  polo: true,
  staff: true,
  bottom: 'shorts',
  bottomColor: COLORS.playerShorts,
  belt: 0x3B2A1E,
  shoes: 0xECEAE4,
  shoeAccent: COLORS.playerCap,
  hair: 'short',
  hairColor: HAIR_COLORS.brown,
  hat: 'cap',
  hatColor: COLORS.playerCap,
  hatBrim: COLORS.playerCap,
  hatLogo: COLORS.playerCollar,
  brows: 'soft',
  mouth: 'smile',
};

/** Style keys the shop may change (Player.setOutfit); anything not in the outfit uses PLAYER_STYLE. */
const OUTFIT_KEYS = ['shirt', 'collar', 'sleeveTrim', 'bottom', 'bottomColor', 'pantStripe', 'shoes', 'shoeAccent',
  'wristband', 'hat', 'hatColor', 'hatBrim', 'hatLogo', 'hatBand', 'sunglasses', 'racket', 'racketStrings'];

const _offset = new THREE.Vector3();
const _push = { x: 0, z: 0 };

// Where exitCart() tries to put the player (cart-local, unscaled metres; the cart's front is -Z):
// right, left, behind, in front. The first spot outside the Centre Court footprint (+0.3) wins,
// so near the bowl the player never lands on the rail or in the stands; elsewhere it is always
// the first (today's spot).
const EXIT_SPOTS = [[2, 0], [-2, 0], [0, 2.5], [0, -2.5]];

// Gait: model units travelled per cycle by the walk / run clips (see CLIP_DEFS stride)
const WALK_STRIDE = 1.45;
const RUN_STRIDE = 2.4;
const MAX_CYCLES = 2.6; // cap the leg cadence at top speed so the sprint stays readable

// Perched on a nosing (slideOffNosing: the player's Player.update and every NPC's NPC.update)
export const PERCH_EPS = 0.03;   // m: centre this far above ground + r = hovering over its tread
const PERCH_EDGE = 0.05;         // m: ground this much higher within r = a step's edge (else level)
const PERCH_TOUCH = 0.02;        // m: the sphere's bottom below that step's top (+ this) = on its edge
const PERCH_SLIDE = 1.5;         // m/s: pushed off the edge
const PERCH_SIDE = 0.05;         // a support normal's horizontal part must exceed this (else: flat)
const PERCH_DIRS = [1, 0, -1, 0, 0, 1, 0, -1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2,
  -Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2];   // 8 unit directions (x, z)
const _support = { x: 0, z: 0 };  // supportPush result

/**
 * Inside the Centre Court cut, a body (sphere of radius r) that stops on the nosing of a riser or
 * an aisle step (or on the corner where an aisle step meets a row) rests on that edge with its
 * centre over the lower tread, up to a riser above the ground there. Contacts are frictionless and
 * a standing body's horizontal velocity is zeroed, so it used to creep off the corner for seconds
 * with its feet in the air. Instead it is pushed away from the higher ground within r (groundAt in
 * 8 directions, weighted by the rise) at PERCH_SLIDE until it drops onto the tread (≤ 0.2 s off
 * the corner). Only while its bottom is below that higher ground's top (resting on / sliding off
 * its edge) and the edge is within r, so it never slides on down the stand. A hovering body that
 * stands on someone's shoulder (two people who met on the steps) is pushed away from them too
 * (supportPush; both at once, so it never ping-pongs between an edge and a shoulder), and one in
 * flight has no contact and just falls. Returns true when it set the x / z velocity; outside the
 * cut it is always false and touches nothing. Shared by Player.update and NPC.update.
 */
export function slideOffNosing(body, r) {
  const p = body.position;
  if (!inCut(p.x, p.z)) return false;
  const gc = groundAt(p.x, p.z);
  if (!(p.y > gc + r + PERCH_EPS)) return false;
  let px = 0, pz = 0, top = gc;
  for (let i = 0; i < PERCH_DIRS.length; i += 2) {
    const dx = PERCH_DIRS[i], dz = PERCH_DIRS[i + 1];
    const up = groundAt(p.x + dx * r, p.z + dz * r) - gc;
    if (!(up > PERCH_EDGE)) continue;
    px -= dx * up;
    pz -= dz * up;
    if (gc + up > top) top = gc + up;
  }
  // Away from a step's edge it rests on (none when it is clear of the steps' tops) …
  let len = Math.sqrt(px * px + pz * pz);
  if (top !== gc && p.y - r <= top + PERCH_TOUCH && len > 1e-6) { px /= len; pz /= len; } else { px = 0; pz = 0; }
  // … and away from whatever else holds it up (someone's shoulder), so it never ping-pongs
  // between the two; in flight there is no contact and it just falls
  supportPush(body);
  px += _support.x;
  pz += _support.z;
  len = Math.sqrt(px * px + pz * pz);
  if (!(len > 1e-6)) return false;                                   // wedged: nowhere to go
  body.velocity.x = (px / len) * PERCH_SLIDE;
  body.velocity.z = (pz / len) * PERCH_SLIDE;
  return true;
}

/**
 * Unit horizontal direction away from what holds `body` up, into _support (0, 0 when nothing does):
 * the sum of the horizontal parts of the last physics step's contact normals that support it
 * from below (body.world.contacts; a flat floor or a flat top adds nothing). Only reached for a
 * hovering, standing body inside the cut, so the scan is rare.
 */
function supportPush(body) {
  _support.x = 0;
  _support.z = 0;
  const list = body.world ? body.world.contacts : null;
  if (!list) return;
  let px = 0, pz = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    let s = 0;                                                       // sign: normal toward this body
    if (c.bi === body) s = -1;
    else if (c.bj === body) s = 1;
    else continue;
    const n = c.ni;
    if (!(n.y * s > 0)) continue;                                    // not holding it up
    const hx = n.x * s, hz = n.z * s;
    if (hx * hx + hz * hz < PERCH_SIDE * PERCH_SIDE) continue;       // flat support: it stands there
    px += hx;
    pz += hz;
  }
  const len = Math.sqrt(px * px + pz * pz);
  if (len > 1e-6) { _support.x = px / len; _support.z = pz / len; }
}

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
    this.facing = new THREE.Vector3(0, 0, 1); // the model faces +Z at rotation.y = 0
    this.velocity = new THREE.Vector3();
    this.animTime = 0;

    this._blobs = BlobShadows.get(scene);
    this._blobSlot = this._blobs.alloc();

    // Mesh feet height over the ground model (followGroundY; eased only inside the bowl)
    this._meshY = 0;
    this._easingY = false;
    this._groundPX = NaN;
    this._groundPZ = NaN;

    this._createMesh(position);
    this._createPhysics(position);
    resetGroundY(this, position.x, Math.max(groundAt(position.x, position.z), position.y || 0), position.z);
  }

  _createMesh(pos) {
    this.mesh = new THREE.Group();
    this.mesh.name = 'Player';

    this.character = new Character(PLAYER_STYLE, 'player');
    this._rankCap = null;   // rank perk cap colour (setCapColor)
    this._outfit = null;    // shop look patch (setOutfit)
    this._styleKey = JSON.stringify(this._stylePatch());
    this.mesh.add(this.character.root);
    // Seated in the cart the game loop no longer calls update(): tick the driving clip from
    // the body's own render callback instead (no main.js wiring). See enterCart().
    this._seatTickAt = 0;
    this._seatTick = () => {
      const now = performance.now();
      const dt = (now - this._seatTickAt) / 1000;
      if (dt < 0.004) return; // extra render passes (GTAO / shadows) in the same frame
      this._seatTickAt = now;
      if (this.cart) this.character.setSteer(-(this.cart.steerAngle || 0) / 0.45);
      this.character.update(Math.min(dt, 0.05));
    };

    // Legacy limb handles
    this.leftLeg = this.character.legL;
    this.rightLeg = this.character.legR;
    this.leftArm = this.character.armL;
    this.rightArm = this.character.armR;

    // Scale down for better proportions relative to courts
    const s = SIZES.playerScale;
    this.mesh.scale.set(s, s, s);

    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    const shape = new CANNON.Sphere(SIZES.playerRadius * SIZES.playerScale);
    this.body = new CANNON.Body({
      mass: 70,
      // Spawn resting on the ground (sphere centre = radius): no 10 s float-down
      position: new CANNON.Vec3(pos.x, (pos.y || 0) + SIZES.playerRadius * SIZES.playerScale, pos.z),
      shape,
      // Low damping: velocity is set every frame (and zeroed without input), so heavy damping
      // would only shave the configured walk speed (0.95 cost ~5% per 1/60 s substep).
      linearDamping: 0.01,
      angularDamping: 1.0,
      fixedRotation: true,
    });
    // No material: contacts use the world's frictionless default (see Game.init).
    this.physicsWorld.addBody(this.body);
    this._settleTime = 1.5;
  }

  /** Sit in the cart: the character is parented to the cart's driver seat in a seated pose. */
  enterCart(cart) {
    this.isInCart = true;
    this.cart = cart;
    this.body.collisionResponse = false;
    this.body.velocity.set(0, 0, 0);

    const cs = SIZES.cartScale;
    this.character.setSeated(true);
    this._seatTickAt = performance.now();
    this.character.skinned.onBeforeRender = this._seatTick;
    (cart.seatAnchor || cart.mesh).add(this.mesh);
    this.mesh.position.copy(SEAT_POS);
    this.mesh.rotation.set(0, Math.PI, 0);
    this.mesh.scale.setScalar(SIZES.playerScale / cs);
    this.mesh.visible = true;
    this._blobs.hide(this._blobSlot);
  }

  exitCart() {
    if (!this.cart) return;
    const cartPos = this.cart.mesh.position;
    const q = this.cart.mesh.quaternion;
    // First exit spot (EXIT_SPOTS) clear of the Centre Court footprint; none: pushed out of it
    let found = false;
    for (let i = 0; i < EXIT_SPOTS.length && !found; i++) {
      _offset.set(EXIT_SPOTS[i][0], 0, EXIT_SPOTS[i][1]).applyQuaternion(q);
      found = !inFootprint(cartPos.x + _offset.x, cartPos.z + _offset.z, 0.3);
    }
    if (!found) _offset.set(EXIT_SPOTS[0][0], 0, EXIT_SPOTS[0][1]).applyQuaternion(q);
    let x = cartPos.x + _offset.x, z = cartPos.z + _offset.z;
    if (!found) {
      pushOutOfFootprint(x, z, 0.5, _push);
      x = _push.x; z = _push.z;
    }
    const gy = groundAt(x, z);

    this.body.position.set(
      x,
      gy + SIZES.playerRadius * SIZES.playerScale, // straight onto the ground, no hover
      z
    );
    this.body.velocity.set(0, 0, 0);
    this.body.collisionResponse = true;
    this._settleTime = 1.5;

    // Back into the world, standing, facing away from the cart
    this.scene.add(this.mesh);
    this.character.skinned.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
    this.character.setSeated(false);
    const s = SIZES.playerScale;
    this.mesh.scale.set(s, s, s);
    this.mesh.rotation.set(0, Math.atan2(_offset.x, _offset.z), 0);
    this.facing.set(_offset.x, 0, _offset.z).normalize();
    this.mesh.position.set(this.body.position.x, gy, this.body.position.z);
    resetGroundY(this, x, gy, z);
    this.mesh.visible = true;
    this.isInCart = false;
    this.cart = null;
  }

  update(dt, moveInput, cameraYaw) {
    if (this.isInCart) return;

    const inputLen = Math.min(1, Math.sqrt(moveInput.x * moveInput.x + moveInput.y * moveInput.y));

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
      this.animTime += dt * inputLen * 8;
    } else if (!slideOffNosing(this.body, SIZES.playerRadius * SIZES.playerScale)) {
      // Contacts are frictionless, so stop explicitly when the stick is released (off a step's
      // edge in the bowl first: slideOffNosing)
      this.body.velocity.x = 0;
      this.body.velocity.z = 0;
    }

    // Locomotion clips: idle → walk → run by stick deflection, cadence matched to ground speed
    if (inputLen > 0.1) {
      const run = THREE.MathUtils.smoothstep(inputLen, 0.5, 0.85);
      const modelSpeed = (this.speed * inputLen) / SIZES.playerScale;
      const stride = WALK_STRIDE + (RUN_STRIDE - WALK_STRIDE) * run;
      this.character.setLocomotion(1, Math.min(MAX_CYCLES, modelSpeed / stride), run);
    } else {
      this.character.setLocomotion(0);
    }
    this.character.update(dt);

    // Sync mesh to physics (feet on the ground: sphere centre minus its radius)
    const r = SIZES.playerRadius * SIZES.playerScale;
    const bp = this.body.position;
    // Briefly after spawning / leaving the cart, pull a hovering body down briskly
    // (linearDamping also damps gravity, so it would otherwise float for seconds)
    if (this._settleTime > 0) {
      this._settleTime -= dt;
      if (bp.y > groundAt(bp.x, bp.z) + r + 0.02) this.body.velocity.y = Math.min(this.body.velocity.y, -6);
    }
    // Feet on the ground model: today's max(0, feet) outside the bowl, eased over its steps
    this.mesh.position.set(bp.x, followGroundY(this, bp.x, bp.z, bp.y - r, dt), bp.z);

    // Smoothly rotate to face the movement direction
    if (inputLen > 0.1) {
      const targetAngle = Math.atan2(this.facing.x, this.facing.z);
      let d = targetAngle - this.mesh.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.mesh.rotation.y += d * Math.min(1, dt * 16);
    }

    // y: on raised surfaces (court pads 0.15, patio 0.10, lot 0.06) the blob must sit on top;
    // in the bowl it follows the ground under it (never above the feet + 0.02)
    const mp = this.mesh.position;
    this._blobs.set(this._blobSlot, mp.x, mp.z, 0.85, 0.85, 0, blobGroundY(mp.x, mp.z, mp.y));
  }

  /**
   * Snap the mesh's ground-follow state after another system teleported the body (the eased
   * mesh y would otherwise glide from the old height). `y` = feet height (default: the ground).
   */
  snapToGround(y = null) {
    const p = this.body.position;
    const gy = Number.isFinite(y) ? y : groundAt(p.x, p.z);
    resetGroundY(this, p.x, gy, p.z);
    if (!this.isInCart) this.mesh.position.y = gy;
  }

  /**
   * Staff cap colour (Grounds Lead rank perk). Accepts a hex number or CSS colour string;
   * null restores the default club-green cap. An equipped shop hat (setOutfit) wins over it.
   * Rebuilds the body geometry only on change.
   */
  setCapColor(color) {
    const hex = color == null ? null : new THREE.Color(color).getHex();
    if (hex === this._rankCap) return;
    this._rankCap = hex;
    this._applyStyle();
  }

  /**
   * Shop look: a style patch over PLAYER_STYLE (uniform colours, shoes, wristband, hat,
   * sunglasses, racket frame / strings; see OUTFIT_KEYS). null = the default staff look.
   * Hat fields in the patch replace the staff cap (and its rank colour).
   */
  setOutfit(look) {
    this._outfit = look ? { ...look } : null;
    this._applyStyle();
  }

  /** The complete patch (every OUTFIT_KEY) for the current outfit + rank cap. */
  _stylePatch() {
    const o = this._outfit || {};
    const patch = {};
    for (const k of OUTFIT_KEYS) patch[k] = k in o ? o[k] : (PLAYER_STYLE[k] ?? null);
    if (!('hat' in o) && this._rankCap != null) { patch.hatColor = this._rankCap; patch.hatBrim = this._rankCap; }
    return patch;
  }

  _applyStyle() {
    const patch = this._stylePatch();
    const key = JSON.stringify(patch);
    if (key === this._styleKey) return;
    this._styleKey = key;
    this.character.restyle(patch);
  }

  getPosition() {
    // While seated the mesh is parented to the cart (local coords) -> report the cart's position.
    if (this.isInCart && this.cart) return this.cart.mesh.position;
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
