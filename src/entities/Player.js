import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';
import { Character, BlobShadows, SKIN_TONES, HAIR_COLORS } from './CharacterModel.js';

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

// Gait: model units travelled per cycle by the walk / run clips (see CLIP_DEFS stride)
const WALK_STRIDE = 1.45;
const RUN_STRIDE = 2.4;
const MAX_CYCLES = 2.6; // cap the leg cadence at top speed so the sprint stays readable

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

    this._createMesh(position);
    this._createPhysics(position);
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
    _offset.set(2, 0, 0).applyQuaternion(this.cart.mesh.quaternion);

    this.body.position.set(
      cartPos.x + _offset.x,
      SIZES.playerRadius * SIZES.playerScale, // straight onto the ground, no hover
      cartPos.z + _offset.z
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
    this.mesh.position.set(this.body.position.x, 0, this.body.position.z);
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
    } else {
      // Contacts are frictionless, so stop explicitly when the stick is released
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
    // Briefly after spawning / leaving the cart, pull a hovering body down briskly
    // (linearDamping also damps gravity, so it would otherwise float for seconds)
    if (this._settleTime > 0) {
      this._settleTime -= dt;
      if (this.body.position.y > r + 0.02) this.body.velocity.y = Math.min(this.body.velocity.y, -6);
    }
    this.mesh.position.set(
      this.body.position.x,
      Math.max(0, this.body.position.y - r),
      this.body.position.z
    );

    // Smoothly rotate to face the movement direction
    if (inputLen > 0.1) {
      const targetAngle = Math.atan2(this.facing.x, this.facing.z);
      let d = targetAngle - this.mesh.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.mesh.rotation.y += d * Math.min(1, dt * 16);
    }

    // y: on raised surfaces (court pads 0.15, patio 0.10, lot 0.06) the blob must sit on top
    this._blobs.set(this._blobSlot, this.mesh.position.x, this.mesh.position.z, 0.85, 0.85, 0, Math.max(this.mesh.position.y + 0.02, 0.065));
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
