import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from './utils/Constants.js';
import { AssetLoader } from './utils/AssetLoader.js';
import { InputSystem } from './systems/InputSystem.js';
import { WeatherSystem } from './systems/WeatherSystem.js';
import { DialogueSystem } from './systems/DialogueSystem.js';
import { MissionSystem } from './systems/MissionSystem.js';
import { InventorySystem } from './systems/InventorySystem.js';
import { SoundSystem } from './systems/SoundSystem.js';
import { World } from './world/World.js';
import { Player } from './entities/Player.js';
import { GolfCart } from './entities/GolfCart.js';
import { NPC } from './entities/NPC.js';
import { Joystick } from './ui/Joystick.js';
import { DialogueBox } from './ui/DialogueBox.js';
import { HUD } from './ui/HUD.js';

class Game {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.physicsWorld = null;
    this.clock = new THREE.Clock();

    // Systems
    this.input = null;
    this.weather = null;
    this.dialogueSystem = null;
    this.missionSystem = null;
    this.inventory = null;
    this.sound = null;

    // Entities
    this.player = null;
    this.cart = null;
    this.npcs = [];
    this.world = null;

    // UI
    this.joystick = null;
    this.dialogueBox = null;
    this.hud = null;

    // Camera state
    this.cameraYaw = 0;
    this.cameraTargetYaw = 0;

    // Data
    this.mapData = null;
    this.npcData = null;
    this.missionData = null;

    // Interaction state
    this.nearestInteractable = null;
    this.nearCart = false;
    this.nearTaskBoard = false;
    this.currentArea = null;

    // Sound state
    this.footstepTimer = 0;
    this.wasInCart = false;

    this.init();
  }

  async init() {
    try {
    this._updateLoadingBar(10);

    // Setup renderer
    const canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Setup scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.sky);
    this.scene.fog = new THREE.Fog(COLORS.sky, 60, 150);

    // Setup camera
    this.camera = new THREE.PerspectiveCamera(
      60, window.innerWidth / window.innerHeight, 0.1, 200
    );
    this.camera.position.set(0, SIZES.cameraHeight, SIZES.cameraDistance);

    this._updateLoadingBar(20);

    // Setup physics
    this.physicsWorld = new CANNON.World({
      gravity: new CANNON.Vec3(0, GAME.gravity, 0),
    });
    this.physicsWorld.broadphase = new CANNON.NaiveBroadphase();
    this.physicsWorld.solver.iterations = 5;

    // Default contact material
    const defaultMat = new CANNON.Material('default');
    const defaultContact = new CANNON.ContactMaterial(defaultMat, defaultMat, {
      friction: 0.5,
      restitution: 0.1,
    });
    this.physicsWorld.addContactMaterial(defaultContact);
    this.physicsWorld.defaultContactMaterial = defaultContact;

    this._updateLoadingBar(30);

    // Load data
    const loader = new AssetLoader();
    const data = await loader.loadAllData();
    this.mapData = data.mapData;
    this.npcData = data.npcData;
    this.missionData = data.missionData;

    this._updateLoadingBar(40);

    // Setup input
    this.input = new InputSystem();

    // Setup sound
    this.sound = new SoundSystem();

    // Build world
    this.world = new World(this.scene, this.physicsWorld, this.mapData);

    this._updateLoadingBar(60);

    // Create player
    const spawn = this.mapData.spawnPoint;
    this.player = new Player(this.scene, this.physicsWorld, spawn);

    // Create golf cart
    const cartSpawn = this.mapData.cartSpawnPoint;
    this.cart = new GolfCart(this.scene, this.physicsWorld, cartSpawn);

    this._updateLoadingBar(70);

    // Setup weather
    this.weather = new WeatherSystem(this.scene);

    // Setup UI
    this.joystick = new Joystick(this.input);
    this.dialogueBox = new DialogueBox();

    // Setup dialogue system
    this.dialogueSystem = new DialogueSystem(this.dialogueBox, this.missionData);

    // Setup inventory
    this.inventory = new InventorySystem();

    // Setup mission system
    this.missionSystem = new MissionSystem(this.missionData, this.dialogueSystem, this.inventory);

    // Setup HUD
    this.hud = new HUD(this.weather, this.missionSystem, this.inventory);

    this._updateLoadingBar(80);

    // Spawn NPCs
    this._spawnNPCs();

    // Register NPCs with mission system
    this.missionSystem.registerNPCs(this.npcs);

    // Wire up radio dispatch
    this.missionSystem.onRadioDispatch = (mission) => {
      this.hud.showRadioDispatch(mission, () => {
        this.hud.updateTaskList();
      });
    };

    this._updateLoadingBar(90);

    // Setup interaction tap handling (from touch taps on right side of screen)
    this.input.onTap((x, y) => this._handleTap(x, y));

    // Handle canvas clicks for interaction (desktop — suppress if was a drag)
    const gameCanvas = document.getElementById('game-canvas');
    gameCanvas.addEventListener('click', (e) => {
      if (this.input.wasDragging) {
        this.input.wasDragging = false;
        return;
      }
      this._handleTap(e.clientX, e.clientY);
    });

    // Window resize
    window.addEventListener('resize', () => this._onResize());

    this._updateLoadingBar(100);

    // Hide loading screen
    setTimeout(() => {
      const loadingScreen = document.getElementById('loading-screen');
      loadingScreen.classList.add('hidden');
      setTimeout(() => loadingScreen.remove(), 500);
    }, 300);

    // Initial HUD update
    this.hud.updateInventory();
    this.hud.updateTaskList();

    // Show welcome notification
    setTimeout(() => {
      this.hud.showNotification('Welcome to Greenbriar Tennis Club! Check the Pro Shop task board.', 5);
      this.sound.playNotification();
    }, 1000);

    // Start game loop
    this._gameLoop();
    } catch (err) {
      console.error('Game init failed:', err);
      const loadingScreen = document.getElementById('loading-screen');
      if (loadingScreen) {
        const p = loadingScreen.querySelector('p');
        if (p) p.textContent = `Error: ${err.message}`;
      }
    }
  }

  _updateLoadingBar(pct) {
    const bar = document.getElementById('loading-bar');
    if (bar) bar.style.width = pct + '%';
  }

  _spawnNPCs() {
    const waypoints = this.mapData.waypoints;

    for (const npcDef of this.npcData.npcs) {
      const npc = new NPC(this.scene, this.physicsWorld, npcDef, waypoints);
      this.npcs.push(npc);
    }

    // Some NPCs start with requests for random encounters
    setTimeout(() => {
      const randomMissions = this.missionData.missions.filter(m => m.source === 'random');
      for (const mission of randomMissions) {
        if (mission.triggerNpc && Math.random() < 0.5) {
          const npc = this.npcs.find(n => n.id === mission.triggerNpc);
          if (npc) {
            npc.setHasRequest(true);
          }
        }
      }
    }, 5000);
  }

  _handleTap(screenX, screenY) {
    if (this.dialogueSystem.isActive()) return;

    // Raycast for NPC interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2(
      (screenX / window.innerWidth) * 2 - 1,
      -(screenY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(mouse, this.camera);

    // Check NPCs
    for (const npc of this.npcs) {
      const intersects = raycaster.intersectObjects(npc.mesh.children, true);
      if (intersects.length > 0 && npc.distanceTo(this._getPlayerWorldPos()) < GAME.interactionRange) {
        this.sound.playUIClick();
        this.missionSystem.handleInteraction(npc, this._getPlayerWorldPos(), () => {
          this.hud.updateTaskList();
        });
        return;
      }
    }
  }

  _getPlayerWorldPos() {
    if (this.player.isInCart) {
      return this.cart.getPosition();
    }
    return this.player.getPosition();
  }

  _updateInteractions() {
    if (this.dialogueSystem.isActive()) {
      this.hud.setActionButton(null);
      return;
    }

    const playerPos = this._getPlayerWorldPos();
    let actionLabel = null;
    let actionCb = null;

    // Check cart proximity
    if (!this.player.isInCart) {
      const cartDist = this.cart.distanceTo(playerPos);
      this.nearCart = cartDist < 3;

      if (this.nearCart) {
        actionLabel = 'Enter\nCart';
        actionCb = () => {
          this.player.enterCart(this.cart);
          this.sound.playCartEnter();
          this.sound.startCartEngine();
          this.wasInCart = true;
        };
      }
    } else {
      actionLabel = 'Exit\nCart';
      actionCb = () => {
        this.player.exitCart();
        this.sound.playCartEnter();
        this.sound.stopCartEngine();
        this.wasInCart = false;
      };
    }

    // Check NPC proximity (overrides cart if closer)
    if (!this.player.isInCart) {
      let closestNPC = null;
      let closestDist = GAME.interactionRange;

      for (const npc of this.npcs) {
        const dist = npc.distanceTo(playerPos);
        if (dist < closestDist) {
          closestDist = dist;
          closestNPC = npc;
        }
      }

      if (closestNPC) {
        this.nearestInteractable = closestNPC;
        actionLabel = closestNPC.hasRequest ? 'Help' : 'Talk';
        actionCb = () => {
          this.sound.playUIClick();
          this.missionSystem.handleInteraction(closestNPC, playerPos, () => {
            this.hud.updateTaskList();
          });
        };
      }
    }

    // Check task board proximity
    if (!this.player.isInCart && this.mapData.areas.proShop.taskBoard) {
      const tb = this.mapData.areas.proShop.taskBoard;
      const proShop = this.mapData.areas.proShop;
      const tbPos = new THREE.Vector3(tb.x, tb.y, proShop.center.z - proShop.bounds.depth / 2 + 0.5);
      const dist = playerPos.distanceTo(tbPos);

      if (dist < 3) {
        actionLabel = 'Task\nBoard';
        actionCb = () => {
          this.sound.playUIClick();
          this._openTaskBoard();
        };
      }
    }

    // Check area for pickup/delivery
    this.currentArea = this._detectCurrentArea(playerPos);
    if (this.currentArea && !this.player.isInCart) {
      // Check for pickups
      const pickup = this._checkPickupAvailable(this.currentArea);
      if (pickup) {
        actionLabel = 'Pick\nUp';
        actionCb = () => {
          const item = this.missionSystem.handlePickup(this.currentArea, playerPos);
          if (item) {
            this.sound.playPickup();
            this.hud.showNotification(`Picked up: ${item.name}`);
            this.hud.updateTaskList();
          }
        };
      }

      // Check for deliveries
      const delivery = this._checkDeliveryAvailable(this.currentArea);
      if (delivery) {
        actionLabel = 'Deliver';
        actionCb = () => {
          const result = this.missionSystem.handleDelivery(this.currentArea);
          if (result) {
            this.sound.playPickup();
            this.hud.showNotification(`Delivered: ${result.item.name}`);
            this.hud.updateTaskList();
          }
        };
      }
    }

    // Keyboard shortcut for action
    if (this.input.isActionJustPressed() && actionCb) {
      actionCb();
      return;
    }

    this.hud.setActionButton(actionLabel, actionCb);
  }

  _detectCurrentArea(pos) {
    const areas = this.mapData.areas;

    // Check courts
    for (const court of areas.courts) {
      const dx = Math.abs(pos.x - court.center.x);
      const dz = Math.abs(pos.z - court.center.z);
      if (dx < SIZES.courtWidth / 2 + 3 && dz < SIZES.courtDepth / 2 + 3) {
        return court.id;
      }
    }

    // Check pro shop
    const ps = areas.proShop;
    if (Math.abs(pos.x - ps.center.x) < ps.bounds.width / 2 + 2 &&
        Math.abs(pos.z - ps.center.z) < ps.bounds.depth / 2 + 2) {
      return 'proShop';
    }

    // Check patio
    const patio = areas.patio;
    if (Math.abs(pos.x - patio.center.x) < patio.bounds.width / 2 + 2 &&
        Math.abs(pos.z - patio.center.z) < patio.bounds.depth / 2 + 2) {
      return 'patio';
    }

    // Check garden
    const garden = areas.garden;
    if (Math.abs(pos.x - garden.center.x) < garden.bounds.width / 2 + 2 &&
        Math.abs(pos.z - garden.center.z) < garden.bounds.depth / 2 + 2) {
      return 'garden';
    }

    return null;
  }

  _checkPickupAvailable(area) {
    for (const mission of this.missionSystem.getActiveMissions()) {
      const step = this.missionSystem.getCurrentStep(mission.id);
      if (step && step.action === 'pickup' && step.location === area) {
        return step;
      }
    }
    return null;
  }

  _checkDeliveryAvailable(area) {
    for (const mission of this.missionSystem.getActiveMissions()) {
      const step = this.missionSystem.getCurrentStep(mission.id);
      if (step && step.action === 'deliver' && step.location === area) {
        return step;
      }
    }
    return null;
  }

  _openTaskBoard() {
    const missions = this.missionSystem.getTaskBoardMissions();

    if (missions.length === 0) {
      this.dialogueSystem.showMessage('Task Board', 'No tasks available right now. Check back later!', '#F1C40F');
      return;
    }

    // Show first available mission as a dialogue choice
    const choices = missions.map(m => ({
      label: `${m.title}`,
      description: m.description,
      mission: m,
    }));

    this.dialogueBox.show('Task Board', 'Available tasks:');
    this.dialogueSystem.active = true;
    this.dialogueSystem.showChoices(choices, (index, choice) => {
      const mission = missions[index];
      if (this.missionSystem.acceptTaskBoardMission(mission)) {
        this.sound.playNotification();
        this.hud.showNotification(`Accepted: ${mission.title}`);
        this.hud.updateTaskList();
      }
    });
  }

  _updateCamera(dt) {
    const target = this.player.isInCart ? this.cart.getPosition() : this.player.getPosition();

    // Apply manual camera rotation from touch drag / mouse drag
    const cameraDelta = this.input.cameraRotationDelta * -0.004;
    this.input.cameraRotationDelta = 0;

    if (this.player.isInCart) {
      // Follow cart heading (front of cart is local -Z)
      const cartQuat = this.cart.mesh.quaternion;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cartQuat);
      const targetYaw = Math.atan2(forward.x, forward.z);
      this.cameraTargetYaw = targetYaw;
    } else {
      // Manual camera rotation (touch/mouse drag)
      this.cameraTargetYaw += cameraDelta;
    }

    // Smooth camera yaw
    let yawDiff = this.cameraTargetYaw - this.cameraYaw;
    // Wrap angle
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
    const yawLerpSpeed = this.player.isInCart ? 4 : 8;
    this.cameraYaw += yawDiff * dt * yawLerpSpeed;

    // Camera position
    const dist = this.player.isInCart ? SIZES.cameraDistance + 2 : SIZES.cameraDistance;
    const height = this.player.isInCart ? SIZES.cameraHeight + 1 : SIZES.cameraHeight;

    const camX = target.x - Math.sin(this.cameraYaw) * dist;
    const camZ = target.z - Math.cos(this.cameraYaw) * dist;
    const camY = target.y + height;

    this.camera.position.lerp(
      new THREE.Vector3(camX, camY, camZ),
      dt * SIZES.cameraLerpSpeed
    );

    // Look ahead of the target
    const lookAhead = new THREE.Vector3(
      target.x + Math.sin(this.cameraYaw) * SIZES.cameraLookAhead,
      target.y + 1.2,
      target.z + Math.cos(this.cameraYaw) * SIZES.cameraLookAhead
    );
    this.camera.lookAt(lookAhead);
  }

  _gameLoop() {
    requestAnimationFrame(() => this._gameLoop());

    try {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    // Update input
    this.input.update();

    // Update physics
    this.physicsWorld.step(1 / 60, dt, 3);

    // Update player / cart
    const moveDir = this.input.getMoveDirection();

    if (this.player.isInCart) {
      this.cart.update(dt, moveDir, true);
      this.sound.updateCartEngine(this.cart.currentSpeed);
    } else {
      this.player.update(dt, moveDir, this.cameraYaw);
      this.cart.update(dt, { x: 0, y: 0 }, false);

      // Footstep sounds while walking
      const inputLen = Math.sqrt(moveDir.x * moveDir.x + moveDir.y * moveDir.y);
      if (inputLen > 0.1) {
        this.footstepTimer -= dt;
        if (this.footstepTimer <= 0) {
          this.sound.playFootstep();
          this.footstepTimer = 0.35;
        }
      } else {
        this.footstepTimer = 0;
      }
    }

    // Update camera
    this._updateCamera(dt);

    // Update NPCs
    const playerWorldPos = this._getPlayerWorldPos();
    for (const npc of this.npcs) {
      npc.update(dt, playerWorldPos);
    }

    // Update world (fountain, etc.)
    this.world.update(dt);

    // Update weather
    this.weather.update(dt);

    // Update interactions
    this._updateInteractions();

    // Update mission system
    this.missionSystem.update(dt, playerWorldPos);

    // Update HUD
    this.hud.updateTimeWeather();
    this.hud.updateMiniMap(playerWorldPos, this.npcs, this.cart.getPosition(), this.mapData);
    this.hud.update(dt);

    // Render
    this.renderer.render(this.scene, this.camera);
    } catch (err) {
      console.error('Game loop error:', err);
    }
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

// Start the game
new Game();
