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
import { injectTheme } from './ui/theme.js';
import { HUD } from './ui/HUD.js';
import { CourtMaintenanceSystem } from './systems/CourtMaintenanceSystem.js';
import { Quality } from './graphics/Quality.js';
import { PostFX } from './graphics/PostFX.js';
import { EnvState } from './graphics/EnvState.js';
import { setMaxAnisotropy, refreshTextureQuality } from './graphics/Textures.js';
import {
  SaveSystem, SettingsStore, captureSaveData, applySaveData, createDefaultStats, createDefaultFlags,
} from './systems/SaveSystem.js';
import { PauseMenu } from './ui/PauseMenu.js';
import { ShiftSystem } from './systems/ShiftSystem.js';
import { ShiftReport } from './ui/ShiftReport.js';
import { MissionMarkers } from './systems/MissionMarkers.js';
import { buildWorldFacts, DETECTABLE_AREAS } from './systems/MissionValidation.js';
import { ITEMS } from './systems/InventorySystem.js';
import { MatchSystem } from './systems/MatchSystem.js';

/** Seconds of unpaused play between autosaves. */
const AUTOSAVE_INTERVAL = 30;
const ZERO_MOVE = Object.freeze({ x: 0, y: 0 });
const GROOM_RATING_RANK = { needsWork: 1, good: 2, excellent: 3 };
const TASK_LABELS = { cooler: 'Swap\nCooler', cups: 'Add\nCups', trash: 'Empty\nTrash' };
/** Height (m) of the floating objective marker above each kind of area. */
const MARKER_HEIGHT = { proShop: 3.6, patio: 3.4, garden: 4.2, equipmentShed: 4.6 };
const MARKER_HEIGHT_COURT = 3.2;
/** Groom result → how the client (Hank) feels about it (tip mood). */
const GROOM_MOOD = { excellent: 'satisfied', good: 'neutral', needsWork: 'unsatisfied' };

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
    this.courtMaintenance = null;

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
    // Opening view: look from the spawn up the path toward the pro shop,
    // clubhouse and courts (instead of south into the parking lot).
    this.cameraYaw = this.cameraTargetYaw = Math.atan2(-20 - (-35), 0 - 30);

    // Data
    this.mapData = null;
    this.npcData = null;
    this.missionData = null;

    // Interaction state
    this.nearTaskBoard = false;
    this.currentArea = null;

    // Sound state
    this.footstepTimer = 0;
    this.wasInCart = false;

    // Pause / lifecycle
    this.paused = false;
    this.pauseReason = null;
    this._ready = false;
    this._pausedRenderPending = false;
    this._loggedErrors = new Map(); // error signature -> count (log each distinct error once)

    // Persistence
    this.settings = new SettingsStore();
    this.saveSystem = new SaveSystem();
    this.stats = createDefaultStats();
    this.flags = createDefaultFlags();
    this._autosaveTimer = 0;
    this._camSensitivity = this.settings.get('cameraSensitivity');

    // Deferred one-shot events: wall-clock deadlines (performance.now) that are only checked
    // while unpaused, and are pushed back by the paused duration on resume.
    this._tutorialAt = 0;
    this._npcRequestAt = 0;
    this._pausedAt = 0;

    // Current world action (no per-frame closures): kind + target, shown on the HUD button
    this._actionKind = null;
    this._actionTarget = null;
    this._actionLabel = undefined;
    this._onActionButton = () => {
      if (!this.paused && this.dialogueSystem && !this.dialogueSystem.isActive()) this._runAction();
    };

    // Pre-allocated temporaries (no per-frame allocations in camera/interaction code)
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._hits = [];
    this._tmpPos = new THREE.Vector3();
    this._camDesired = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._cartFwd = new THREE.Vector3();

    this._loop = () => this._gameLoop();

    this.init();
  }

  async init() {
    try {
    this._updateLoadingBar(10);

    // Setup renderer
    const canvas = document.getElementById('game-canvas');
    this.quality = Quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // The canvas only needs its own MSAA when there is no composer (low tier); with
      // post FX the scene renders into a 4x MSAA target and the canvas just gets the
      // final full-screen quad. (Can't be toggled live: switching to low mid-session
      // runs without AA until the next load.)
      antialias: !Quality.settings.postFX,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Quality.settings.pixelRatioCap));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // updated once per frame in _gameLoop (post passes re-render the scene)
    this.renderer.toneMapping = THREE.NeutralToneMapping; // Khronos PBR Neutral: keeps the stylized palette true (ACES washed out & hue-shifted)
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = false;         // reset once per frame so stats include every pass
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    // Many phone GPUs can't render into half-float targets. Post FX and the PMREM
    // env map need that, so detect it once and fall back (8-bit composer, no env map)
    // instead of rendering into an incomplete framebuffer (a blank screen).
    const ext = this.renderer.extensions;
    this.gpuCaps = {
      halfFloatRT: this.renderer.capabilities.isWebGL2 &&
        (ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float')),
    };

    // A GPU reset (driver crash, memory pressure, backgrounded tab) loses the WebGL
    // context and every GPU-backed canvas. Catch it instead of leaving a white screen.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._onContextLost();
    });

    // Setup scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.sky);
    this.scene.fog = new THREE.Fog(COLORS.sky, 80, 340);

    // Setup camera
    this.camera = new THREE.PerspectiveCamera(
      Game.fovForAspect(window.innerWidth / window.innerHeight),
      window.innerWidth / window.innerHeight, 0.25, 600
    );
    this.camera.position.set(0, SIZES.cameraHeight, SIZES.cameraDistance);

    // Post-processing (composer is skipped entirely on 'low')
    this.postFX = new PostFX(this.renderer, this.scene, this.camera);
    this.postFX.halfFloat = this.gpuCaps.halfFloatRT;
    this.postFX.setSize(window.innerWidth, window.innerHeight);
    this.renderStats = { calls: 0, triangles: 0 };
    this._shadowFocus = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();

    this._updateLoadingBar(20);

    // Setup physics
    this.physicsWorld = new CANNON.World({
      gravity: new CANNON.Vec3(0, GAME.gravity, 0),
    });
    this.physicsWorld.broadphase = new CANNON.NaiveBroadphase();
    this.physicsWorld.solver.iterations = 5;

    // Default contact material: frictionless. Every moving body (player, cart, NPCs) is driven by
    // setting its velocity or position directly, and none of them carry their own material, so
    // this is the contact used against the ground, courts and statics. cannon-es caps friction
    // per solver step as an *impulse* of mu*m*g (not mu*m*g*dt), which at mu 0.5 stopped the
    // player almost dead every step (8 m/s configured -> ~2.2 m/s at 60 fps, ~0.8 m/s at 20 fps).
    // Stopping is handled explicitly instead (Player zeroes its velocity without input, the cart
    // tracks currentSpeed and brakes when parked, NPCs zero theirs every update).
    const defaultMat = new CANNON.Material('default');
    const defaultContact = new CANNON.ContactMaterial(defaultMat, defaultMat, {
      friction: 0,
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
    this._normalizeData();

    this._updateLoadingBar(40);

    // Setup input
    this.input = new InputSystem();

    // Setup sound (volume / mute from saved settings; applied once audio unlocks)
    this.sound = new SoundSystem();
    this.sound.setMasterVolume(this.settings.get('volume'));
    this.sound.setMuted(this.settings.get('muted'));
    this.settings.onChange((key, value) => {
      if (key === 'volume') this.sound.setMasterVolume(value);
      else if (key === 'muted') this.sound.setMuted(value);
      else if (key === 'cameraSensitivity') this._camSensitivity = value;
    });

    // Build world
    this.world = new World(this.scene, this.physicsWorld, this.mapData);

    this._updateLoadingBar(60);

    // Create player
    const spawn = this.mapData.spawnPoint;
    this.player = new Player(this.scene, this.physicsWorld, spawn);

    // Create golf cart
    const cartSpawn = this.mapData.cartSpawnPoint;
    this.cart = new GolfCart(this.scene, this.physicsWorld, cartSpawn);

    // Brush dust only over clay (explicit court bounds, not a scene-graph guess)
    this.cart.setClayAreas(this.world.courts
      .filter(c => c.isClay && c.surfaceMesh)
      .map(c => { c.surfaceMesh.updateWorldMatrix(true, false); return new THREE.Box3().setFromObject(c.surfaceMesh); }));

    this._updateLoadingBar(70);

    // Setup weather (lighting, sky, shadows, env map)
    this.weather = new WeatherSystem(this.scene, this.renderer);
    this.weather.envMapSupported = this.gpuCaps.halfFloatRT; // PMREM renders half-float targets
    this.weather.setCamera(this.camera);

    // Setup UI
    this.joystick = new Joystick(this.input);
    this.dialogueBox = new DialogueBox();

    // Setup dialogue system
    this.dialogueSystem = new DialogueSystem(this.dialogueBox, this.missionData);

    // Setup inventory
    this.inventory = new InventorySystem();

    // Setup mission system (only missions whose every step works in this world are offered)
    this.missionSystem = new MissionSystem(this.missionData, this.dialogueSystem, this.inventory);
    this.missionSystem.setWorldFacts(
      buildWorldFacts({ map: this.mapData, npcs: this.npcData, missions: this.missionData, items: ITEMS }),
      this._buildTargetPoints()
    );
    this.missionMarkers = new MissionMarkers(this.scene, this.missionSystem);

    // Shift loop: clock-in, rush windows, closing duties, report card, pay / tips / rank
    this.shift = new ShiftSystem(this.missionData.shift, this.npcData, this.weather, this.missionSystem);
    this.weather.timeOfDay = this.shift.startHour; // a new game starts at clock-in (a save overrides)

    // Setup HUD
    this.hud = new HUD(this.weather, this.missionSystem, this.inventory);

    // Setup court maintenance system
    this.courtMaintenance = new CourtMaintenanceSystem(
      this.world.courts,
      this.cart,
      this.dialogueSystem,
      this.sound,
      this.mapData
    );

    // Wire up grooming callbacks
    this.courtMaintenance.onGroomStart = (courts) => {
      this.hud.showGroomingHUD();
      const courtNames = courts.map(c => c.config.label).join(', ');
      this.hud.showNotification(`Grooming ${courtNames}... Start at the fence perimeter, then work toward the nets!`);
    };

    this.courtMaintenance.onGroomEnd = (score, message) => {
      this.hud.hideGroomingHUD();
      this.sound.playGroomComplete();
      this.hud.showNotification(message, 5);

      // Stats (persisted)
      const courtIds = score.courtId ? score.courtId.split(',') : [];
      this._recordGroomStats(score, courtIds.length);
      this.shift.recordGroom(score);

      // One session grooms every clay court: advance every active groom step it covered
      const active = this.missionSystem.getActiveMissions().slice();
      for (const mission of active) {
        const step = this.missionSystem.getCurrentStep(mission.id);
        if (step && step.action === 'groom' && courtIds.includes(step.target)) {
          this.missionSystem.advanceMissionStep(mission.id);
        }
      }
      this.hud.updateTaskList();
      this.saveGame();
    };

    // Overhead groom camera: key C or the grooming-panel button (only while grooming)
    const toggleGroomCam = () => {
      if (this.paused || this.courtMaintenance.state !== 'grooming') return;
      const on = this.courtMaintenance.toggleGroomCamera();
      this.hud.setGroomCameraActive(on);
    };
    this.input.onKeyPress('KeyC', toggleGroomCam);
    this.hud.onGroomCameraToggle = toggleGroomCam;

    this.courtMaintenance.onGroomUpdate = (progress) => {
      this.hud.updateGroomingHUD(progress);
    };

    this.courtMaintenance.onCourtsideTaskComplete = (task) => {
      const soundMap = { cooler: 'playCoolerSwap', cups: 'playCoolerSwap', trash: 'playTrashPickup' };
      const soundMethod = soundMap[task.type];
      if (soundMethod && this.sound[soundMethod]) {
        this.sound[soundMethod]();
      }
      this.hud.showNotification(`${task.label} - Done!`, 2);
    };

    this._updateLoadingBar(80);

    // Spawn NPCs
    this._spawnNPCs();

    // Register NPCs with mission system
    this.missionSystem.registerNPCs(this.npcs);

    // Member tennis matches on the court schedule (public/data/schedule.json)
    this.matches = new MatchSystem({
      scene: this.scene, physicsWorld: this.physicsWorld, courts: this.world.courts, npcs: this.npcs,
      weather: this.weather, missions: this.missionSystem, maintenance: this.courtMaintenance,
      sound: this.sound, camera: this.camera, waypoints: this.mapData.waypoints,
    });
    this.matches.load();

    // Radio dispatch: a card with "On it" / "Busy" (Busy just passes, no penalty)
    this.missionSystem.onRadioDispatch = (mission) => {
      this.sound.playRadioChirp();
      this.hud.showRadioDispatch(mission, () => {
        const active = this.missionSystem.acceptDispatch();
        if (active) {
          this.sound.playNotification();
          this.hud.showNotification(`New task: ${active.title}`, 3, 'radio');
        } else {
          this.hud.showNotification('Your task list is full. Finish something first!', 3, 'radio');
        }
        this.hud.updateTaskList();
      }, () => {
        this.missionSystem.declineDispatch('busy');
        this.hud.showNotification("Dispatch: no problem, we'll send someone else.", 3, 'radio');
      });
    };
    this.missionSystem.onDispatchClosed = (mission, accepted, reason) => {
      if (reason === 'timeout' || reason === 'offShift' || reason === 'newDay') {
        if (this.hud.isRadioCardVisible('dispatch')) this.hud.hideRadioDispatch();
        if (reason === 'timeout') this.hud.showNotification('Dispatch reassigned the call.', 2.5, 'radio');
      }
    };
    this.missionSystem.onMissionUpdate = () => {
      if (this.hud) this.hud.updateTaskList();
    };

    // Completion: pay + tips, jingle, toast, confetti, stats, autosave
    this.missionSystem.onMissionComplete = (mission) => this._onMissionComplete(mission);
    this.missionSystem.onReaction = (npcId, mood) => {
      const sat = this.stats.satisfaction;
      if (mood === 'satisfied') sat.satisfied++;
      else if (mood === 'unsatisfied') sat.unsatisfied++;
      else sat.neutral++;
      this.shift.recordReaction(mood);
    };
    this._wireShift();

    // Apply graphics quality (shadows, pixel ratio, post FX) and react to later changes
    this._applyQuality(Quality.settings);
    Quality.onChange((tier, settings) => this._applyQuality(settings));

    this._updateLoadingBar(90);

    // Restore saved progress (after the world, entities and systems exist)
    const hadSave = this._loadGame();
    if (!hadSave) this.shift.setState({ phase: 'preShift' });
    this.hud.setWallet(this.shift.wallet, true);

    // Pause menu (+ on-screen pause button under the minimap)
    this._createPauseMenu();

    // Setup interaction tap handling (from touch taps on right side of screen)
    this.input.onTap((x, y) => this._handleTap(x, y));
    this.input.onPauseToggle(() => this.togglePause());
    this.input.onChoiceKey((i) => {
      if (!this.paused && this.dialogueSystem.hasChoices()) {
        if (this.dialogueSystem.choose(i)) this.sound.playUIClick();
      }
    });

    // Auto-pause + save when the tab is hidden; save when the page goes away
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        if (!this.paused) this.pause('hidden');
        this.saveGame();
      }
    });
    window.addEventListener('pagehide', () => this.saveGame());

    // Handle canvas clicks for interaction (desktop — suppress if was a drag)
    const gameCanvas = document.getElementById('game-canvas');
    gameCanvas.addEventListener('click', (e) => {
      if (this.paused) return;
      if (this.input.wasDragging) {
        this.input.wasDragging = false;
        return;
      }
      this._handleTap(e.clientX, e.clientY);
    });

    // Window resize
    window.addEventListener('resize', () => this._onResize());

    // Compile every shader variant now (incl. night lamps / rain / hidden props) instead of
    // hitching the first time each one comes into view
    await this._precompileShaders();

    this._updateLoadingBar(100);

    // Hide loading screen
    setTimeout(() => {
      const loadingScreen = document.getElementById('loading-screen');
      if (!loadingScreen) return;
      loadingScreen.classList.add('hidden');
      setTimeout(() => loadingScreen.remove(), 500);
    }, 300);

    // Initial HUD update
    this.hud.updateInventory();
    this.hud.updateTaskList();

    // First run: tutorial after a short delay (game time); it ends by clocking in.
    // Returning players: welcome back (and the clock-in card if the day hasn't started).
    if (!this.flags.tutorialSeen) {
      this._tutorialAt = performance.now() + 1000;
    } else {
      if (this.saveSystem.lastLoadStatus === 'ok' || this.saveSystem.lastLoadStatus === 'migrated') {
        this.hud.showNotification(`Welcome back! Day ${this.weather.day || 1}, ${this.weather.getTimeString()}`, 3);
      }
      this.shift.promptClockIn();
    }

    // Start game loop
    this._ready = true;
    this.clock.getDelta();
    this._gameLoop();
    } catch (err) {
      console.error('Game init failed:', err);
      this._showFatalError(err);
    }
  }

  /** Fill in anything missing from the JSON data so a hand-edited file can't crash the game. */
  _normalizeData() {
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const vec = (v, d) => (isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.z))
      ? { x: v.x, y: Number.isFinite(v.y) ? v.y : 0, z: v.z } : d;

    const map = this.mapData;
    if (!isObj(map.areas)) map.areas = {};
    if (!Array.isArray(map.areas.courts)) map.areas.courts = [];
    map.areas.courts = map.areas.courts.filter(c => isObj(c) && c.id && isObj(c.center));
    if (!Array.isArray(map.areas.courtJunctions)) map.areas.courtJunctions = [];
    if (!Array.isArray(map.paths)) map.paths = [];
    map.spawnPoint = vec(map.spawnPoint, { x: 0, y: 0, z: 0 });
    map.cartSpawnPoint = vec(map.cartSpawnPoint, { x: map.spawnPoint.x + 2, y: 0, z: map.spawnPoint.z - 2 });
    // waypoints: { name: {x, y, z} } — NPCs need at least one
    if (!isObj(map.waypoints) || Object.keys(map.waypoints).length === 0) {
      map.waypoints = { spawn: { ...map.spawnPoint } };
    }

    if (!isObj(this.npcData)) this.npcData = {};
    if (!Array.isArray(this.npcData.npcs)) this.npcData.npcs = [];
    this.npcData.npcs = this.npcData.npcs.filter(n => isObj(n) && n.id);

    if (!isObj(this.missionData)) this.missionData = {};
    if (!Array.isArray(this.missionData.missions)) this.missionData.missions = [];
    this.missionData.missions = this.missionData.missions.filter(m => isObj(m) && m.id && Array.isArray(m.steps));
    if (!isObj(this.missionData.dialogues)) this.missionData.dialogues = {};
  }

  /** Readable error on the loading screen (or a fallback overlay) with a Reload button. */
  _showFatalError(err) {
    try {
      const host = document.getElementById('loading-screen') || document.body;
      if (host.id === 'loading-screen') {
        host.classList.remove('hidden');
        const bar = document.getElementById('loading-bar-container');
        if (bar) bar.style.display = 'none';
      }
      let box = document.getElementById('cc-fatal');
      if (!box) {
        box = document.createElement('div');
        box.id = 'cc-fatal';
        box.setAttribute('role', 'alert');
        Object.assign(box.style, {
          marginTop: '20px', maxWidth: 'min(440px, calc(100vw - 32px))', padding: '16px 18px',
          borderRadius: '14px', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(224,90,71,0.55)',
          color: '#f4e8c1', font: "14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif", textAlign: 'center',
          zIndex: '1001',
        });
        if (host === document.body) {
          Object.assign(box.style, { position: 'fixed', left: '50%', top: '40%', transform: 'translate(-50%, -50%)', background: '#173a26' });
        }
        host.appendChild(box);
      }
      box.textContent = '';
      const title = document.createElement('div');
      title.textContent = "Couldn't start Court Call";
      Object.assign(title.style, { fontWeight: '700', fontSize: '16px', marginBottom: '6px', color: '#ffd9d2' });
      const msg = document.createElement('div');
      const files = err && Array.isArray(err.files) ? err.files : null;
      if (files && files.length) {
        msg.textContent = 'These game data files could not be loaded:';
        const ul = document.createElement('ul');
        Object.assign(ul.style, { listStyle: 'none', margin: '8px 0 0', padding: '0', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '12.5px' });
        for (const f of files) {
          const li = document.createElement('li');
          li.textContent = `${String(f.path).split('/').pop()} \u2014 ${f.reason}`;
          ul.appendChild(li);
        }
        msg.appendChild(ul);
      } else {
        msg.textContent = (err && err.message) ? err.message : String(err);
      }
      const btn = document.createElement('button');
      btn.textContent = 'Reload';
      Object.assign(btn.style, {
        marginTop: '14px', minHeight: '44px', minWidth: '120px', borderRadius: '10px', border: '0',
        background: '#f4e8c1', color: '#173a26', fontWeight: '700', fontSize: '15px', cursor: 'pointer',
      });
      btn.addEventListener('click', () => location.reload());
      box.append(title, msg, btn);
    } catch (e) { /* nothing more we can do */ }
  }

  _updateLoadingBar(pct) {
    const bar = document.getElementById('loading-bar');
    if (bar) bar.style.width = pct + '%';
  }

  _spawnNPCs() {
    const waypoints = this.mapData.waypoints;

    for (const npcDef of this.npcData.npcs) {
      try {
        const npc = new NPC(this.scene, this.physicsWorld, npcDef, waypoints);
        this.npcs.push(npc);
      } catch (err) {
        console.error(`Could not spawn NPC "${npcDef.id}":`, err);
      }
    }

    // Some NPCs start with requests for random encounters (after 5 s of play; see _seedNPCRequests)
    this._npcRequestAt = performance.now() + 5000;
  }

  _seedNPCRequests() {
    for (const mission of this.missionData.missions) {
      if (mission.source !== 'random' || !mission.triggerNpc) continue;
      if (Math.random() < 0.5) this.missionSystem.offerEncounter(mission.triggerNpc);
    }
  }

  /**
   * Static marker / pin points for every area a mission step can target:
   * waypoint `<id>_marker`, `<id>_center` or `<id>`, else the area's centre.
   */
  _buildTargetPoints() {
    const points = new Map();
    const map = this.mapData;
    const wps = map.waypoints || {};
    const areas = map.areas || {};
    const add = (id, fallback, h) => {
      const wp = wps[id + '_marker'] || wps[id + '_center'] || wps[id] || fallback;
      if (wp && Number.isFinite(wp.x) && Number.isFinite(wp.z)) points.set(id, { x: wp.x, z: wp.z, h });
    };
    for (const c of areas.courts || []) add(c.id, c.center, MARKER_HEIGHT_COURT);
    for (const id of DETECTABLE_AREAS) if (areas[id]) add(id, areas[id].center, MARKER_HEIGHT[id] || 3.4);
    return points;
  }

  // ───────────────────────────── shift loop ─────────────────────────────

  _wireShift() {
    const shift = this.shift;
    shift.getCourtQuality = () => (this.courtMaintenance ? this.courtMaintenance.getAverageCleanliness() : null);
    shift.onClockInPrompt = (day) => {
      this.sound.playRadioChirp();
      this.hud.showRadioCard({
        kind: 'clockIn',
        channel: shift.data.manager || 'Club Manager',
        title: `Good morning! Day ${day} starts now.`,
        text: 'Shift runs 7 AM to 7 PM. Opening checklist first.',
        actions: [{ label: 'Clock in', primary: true, onClick: () => this.clockIn() }],
      });
    };
    shift.onClockedIn = (day) => {
      if (this.hud.isRadioCardVisible('clockIn')) this.hud.hideRadioDispatch();
      this.sound.playNotification();
      this.hud.showNotification(`Clocked in for Day ${day}. Opening checklist added to your tasks.`, 4, 'check');
      this.hud.updateTaskList();
    };
    shift.onRushChange = (w) => {
      if (w) this.hud.showNotification(`${w.label || 'Rush hour'}: the radio is about to get busy!`, 4, 'radio');
    };
    shift.onClosingTime = () => {
      const closing = shift.data.closingMission ? this.missionSystem.startShiftMission(shift.data.closingMission) : null;
      this.sound.playRadioChirp();
      this.hud.showRadioCard({
        kind: 'info',
        channel: shift.data.manager || 'Club Manager',
        title: 'Closing time in 30 minutes.',
        text: closing ? 'Closing duties are on your task list.' : 'Wrap up your tasks.',
        actions: [{ label: 'Got it', primary: true, onClick: () => {} }],
      });
      this.hud.updateTaskList();
    };
    shift.onShiftEnd = (report) => {
      if (this.hud.isRadioCardVisible()) this.hud.hideRadioDispatch();
      this.hud.updateTaskList();
      this.hud.setWallet(shift.wallet, true);
      this.sound.playGroomComplete();
      this.pause('report');
      this.shiftReport.show(report);
      if (report.rankUp) this.sound.playRankUp();
      this.saveGame();
    };
    shift.onEarn = ({ amount, kind, npcId }) => {
      this.hud.setWallet(shift.wallet);
      if (kind === 'tip') {
        this.stats.tips += amount;
        const npc = npcId ? this.npcs.find(n => n.id === npcId) : null;
        const scr = npc && npc.mesh ? this._toScreen(npc.mesh.position, 2.3) : null;
        this.hud.showMoneyFloat(amount, scr ? scr.x : NaN, scr ? scr.y : NaN, 'tip');
        this.sound.playCoin();
      } else if (kind === 'task' || kind === 'bonus') {
        this.hud.showMoneyFloat(amount, NaN, NaN, 'task');
      }
    };
    shift.onRankUp = (rank) => {
      this.sound.playRankUp();
      this.hud.celebrate();
      this.hud.showNotification(`Promoted to ${rank.title}! ${rank.unlock || ''}`.trim(), 5, 'sparkle');
    };
    shift.onPerks = (perks) => this._applyPerks(perks);

    this.shiftReport = new ShiftReport({ onNextDay: () => this.startNextDay() });
  }

  /** Clock in (clock-in card, or the end of the first-day tutorial). */
  clockIn() {
    if (this.shift.clockIn()) this.saveGame();
  }

  /** Report card "Next day": 7 AM tomorrow, clock-in card, autosave. */
  startNextDay() {
    this.shiftReport.hide();
    if (this.shift.nextDay()) this.courtMaintenance.degradeOvernight();
    this.hud.updateTaskList();
    this.hud.setWallet(this.shift.wallet, true);
    if (this.paused && this.pauseReason === 'report') this.resume();
    this.saveGame();
  }

  /** Rank perks: cart top speed, brush width, cap colour (tips are applied in ShiftSystem). */
  _applyPerks(perks) {
    if (!perks) return;
    // Explicit per-object hooks (the shared SIZES / GAME tuning tables are never mutated)
    if (this.cart) {
      this.cart.maxSpeedScale = 1 + (Number(perks.cartSpeed) || 0);
      this.cart.setBrushWidthBonus(perks.brushWidth || 0);
    }
    // Re-applied on every load (ShiftSystem.setState -> onPerks), so the gold cap persists
    if (this.player) {
      try { this.player.setCapColor(perks.capColor || null); } catch (e) { /* cosmetic only */ }
    }
  }

  _onMissionComplete(mission) {
    this.stats.missionsCompleted++;
    // Moods for tipping: choices set them; an errand's client is pleased it got done;
    // a maintenance client judges the groom.
    const moods = { ...(mission.reactions || {}) };
    const client = mission.client ? this.missionSystem.npcsMap.get(mission.client) : null;
    if (client && !moods[client.id]) {
      let mood = 'satisfied';
      if (mission.type === 'maintenance' && this.shift.shift.lastGroomRating) mood = GROOM_MOOD[this.shift.shift.lastGroomRating] || 'neutral';
      moods[client.id] = mood;
      if (mission.source !== 'shift') {
        client.mood = mood;
        try { client.showReaction(mood === 'satisfied' ? '\uD83D\uDE0A' : mood === 'unsatisfied' ? '\uD83D\uDE24' : '\uD83D\uDC4D'); } catch (e) { /* ignore */ }
      }
    }
    const result = this.shift.recordMissionComplete(mission, this.missionSystem.npcsMap, moods);
    this.sound.playMissionComplete();
    this.hud.celebrate();
    const pay = result.pay ? ` +$${result.pay}` : '';
    this.hud.showNotification(`Task complete: ${mission.title}${pay}`, 3.5, 'check');
    this.hud.updateTaskList();
    // Defer so the completing flow (dialogue / HUD updates) finishes first
    setTimeout(() => this.saveGame(), 0);
  }

  /** World point (+ lift) → CSS px on screen, or null when behind the camera. Reuses a temp. */
  _toScreen(pos, lift = 0) {
    const v = this._tmpPos.set(pos.x, pos.y + lift, pos.z).project(this.camera);
    if (v.z > 1) return null;
    const out = this._scr || (this._scr = { x: 0, y: 0 });
    out.x = (v.x + 1) / 2 * window.innerWidth;
    out.y = (1 - v.y) / 2 * window.innerHeight;
    return out;
  }

  _handleTap(screenX, screenY) {
    if (!this._ready || this.paused || this.dialogueSystem.isActive()) return;

    // Raycast for NPC interaction (reused raycaster / vectors / hit array)
    const raycaster = this._raycaster;
    this._ndc.set(
      (screenX / window.innerWidth) * 2 - 1,
      -(screenY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(this._ndc, this.camera);

    // Check NPCs
    const hits = this._hits;
    for (const npc of this.npcs) {
      if (!npc.mesh) continue;
      hits.length = 0;
      raycaster.intersectObjects(npc.mesh.children, true, hits);
      if (hits.length > 0 && npc.distanceTo(this._getPlayerWorldPos()) < GAME.interactionRange) {
        hits.length = 0;
        this.sound.playUIClick();
        this.missionSystem.handleInteraction(npc, this._getPlayerWorldPos(), () => {
          this.hud.updateTaskList();
        });
        return;
      }
    }
  }

  /** Facing angle (radians; facing = (sin h, cos h)) of the player or the cart being driven. */
  _getHeading() {
    if (this.player.isInCart) {
      const f = this._cartFwd.set(0, 0, -1).applyQuaternion(this.cart.mesh.quaternion);
      return Math.atan2(f.x, f.z);
    }
    // On foot: the model's actual (smoothed) heading — same (sin h, cos h) convention as
    // `facing`, but also right at spawn and after exiting the cart (facing isn't updated there)
    const m = this.player.mesh;
    if (m) return m.rotation.y;
    const f = this.player.facing;
    return f ? Math.atan2(f.x, f.z) : this.cameraYaw;
  }

  _getPlayerWorldPos() {
    if (this.player.isInCart) {
      return this.cart.getPosition();
    }
    return this.player.getPosition();
  }

  _updateInteractions() {
    if (this.dialogueSystem.isActive()) {
      this._actionKind = null;
      this._actionTarget = null;
      this._setActionLabel(null);
      return;
    }

    const playerPos = this._getPlayerWorldPos();
    const areas = this.mapData.areas;
    const inCart = this.player.isInCart;
    let kind = null;
    let label = null;
    let target = null;

    // Check cart proximity
    if (!inCart) {
      if (this.cart.distanceTo(playerPos) < 3) {
        kind = 'enterCart';
        label = 'Enter\nCart';
      }
    } else {
      kind = 'exitCart';
      label = 'Exit\nCart';
    }

    // Check NPC proximity (overrides cart if closer)
    if (!inCart) {
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
        kind = 'talk';
        target = closestNPC;
        label = closestNPC.hasRequest ? 'Help' : 'Talk';
      }
    }

    // Check equipment shed - attach/detach brush (must be in cart)
    const shed = areas.equipmentShed;
    if (inCart && shed && shed.center) {
      const shedPos = this._tmpPos.set(shed.center.x, 0, shed.center.z);
      if (this.courtMaintenance.isNearEquipmentShed(playerPos, shedPos)) {
        if (!this.cart.hasBrush) {
          kind = 'attachBrush';
          label = 'Attach\nBrush';
        } else {
          kind = 'detachBrush';
          label = 'Detach\nBrush';
        }
        target = null;
      }
    }

    // Check clay court grooming - start/stop grooming (must be in cart with brush)
    if (inCart && this.cart.hasBrush) {
      if (this.courtMaintenance.isGrooming()) {
        // Check for nearby courtside tasks first
        const nearbyTask = this.courtMaintenance.getNearbyCourtTask(playerPos);
        if (nearbyTask) {
          kind = 'courtTask';
          target = nearbyTask;
          label = TASK_LABELS[nearbyTask.type] || 'Do\nTask';
        } else {
          // Allow stopping mid-groom
          kind = 'stopGroom';
          target = null;
          label = 'Stop\nGroom';
        }
      } else {
        const nearbyCourt = this.courtMaintenance.getNearbyClayCourtForGrooming(playerPos);
        if (nearbyCourt) {
          kind = 'startGroom';
          target = nearbyCourt;
          label = 'Start\nGroom';
        }
      }
    }

    // Check task board proximity
    const proShop = areas.proShop;
    if (!inCart && proShop && proShop.taskBoard && proShop.center && proShop.bounds) {
      const tb = proShop.taskBoard;
      const tbPos = this._tmpPos.set(
        Number.isFinite(tb.x) ? tb.x : proShop.center.x,
        Number.isFinite(tb.y) ? tb.y : 0,
        proShop.center.z - proShop.bounds.depth / 2 + 0.5
      );
      if (playerPos.distanceTo(tbPos) < 3) {
        kind = 'taskBoard';
        target = null;
        label = 'Task\nBoard';
      }
    }

    // Check area for pickup/delivery (and complete goTo steps on arrival)
    this.currentArea = this._detectCurrentArea(playerPos);
    if (this.currentArea && this.missionSystem.handleArrival(this.currentArea)) {
      this.hud.updateTaskList();
    }
    if (this.currentArea && !inCart) {
      if (this._checkPickupAvailable(this.currentArea)) {
        kind = 'pickup';
        target = null;
        label = 'Pick\nUp';
      }
      if (this._checkDeliveryAvailable(this.currentArea)) {
        kind = 'deliver';
        target = null;
        label = 'Deliver';
      }
    }

    this._actionKind = kind;
    this._actionTarget = target;

    // Keyboard shortcut for action
    if (kind && this.input.isActionJustPressed()) {
      this.input.consumeAction();
      this._runAction();
      return;
    }

    this._setActionLabel(label);
  }

  /** Update the HUD action button only when its label changes. */
  _setActionLabel(label) {
    if (label === this._actionLabel) return;
    this._actionLabel = label;
    this.hud.setActionButton(label, label ? this._onActionButton : null);
  }

  /** Execute the current world action (keyboard E/Space/Enter or the HUD button). */
  _runAction() {
    const kind = this._actionKind;
    const target = this._actionTarget;
    if (!kind) return;
    const playerPos = this._getPlayerWorldPos();

    switch (kind) {
      case 'enterCart':
        this.player.enterCart(this.cart);
        this.sound.playCartEnter();
        this.sound.startCartEngine();
        this.wasInCart = true;
        break;
      case 'exitCart':
        this.player.exitCart();
        this.sound.playCartEnter();
        this.sound.stopCartEngine();
        this.wasInCart = false;
        break;
      case 'talk':
        if (!target) break;
        this.sound.playUIClick();
        this.missionSystem.handleInteraction(target, playerPos, () => {
          this.hud.updateTaskList();
        });
        break;
      case 'attachBrush':
        this.cart.attachBrush();
        this.sound.playBrushAttach();
        this.hud.showNotification('Drag brush attached! Drive to a clay court to start grooming.', 4);
        break;
      case 'detachBrush':
        if (this.courtMaintenance.isGrooming()) {
          this.courtMaintenance.stopGrooming();
        }
        this.cart.detachBrush();
        this.sound.playBrushAttach();
        this.hud.showNotification('Drag brush detached.', 2);
        break;
      case 'courtTask':
        if (target) this.courtMaintenance.completeCourtTask(target.id);
        break;
      case 'stopGroom':
        this.courtMaintenance.stopGrooming();
        break;
      case 'startGroom':
        if (target) this.courtMaintenance.startGrooming(target);
        break;
      case 'taskBoard':
        this.sound.playUIClick();
        this._openTaskBoard();
        break;
      case 'pickup': {
        const item = this.missionSystem.handlePickup(this.currentArea, playerPos);
        if (item) {
          this.sound.playPickup();
          this.hud.showNotification(`Picked up: ${item.name}`);
          this.hud.updateTaskList();
        } else if (!this.inventory.canPickup()) {
          this.hud.showNotification('Your hands are full. Deliver something first!', 3, 'pickup');
        }
        break;
      }
      case 'deliver': {
        const result = this.missionSystem.handleDelivery(this.currentArea);
        if (result) {
          this.sound.playPickup();
          this.hud.showNotification(`Delivered: ${result.item.name}`);
          this.hud.updateTaskList();
        }
        break;
      }
      default:
        break;
    }
    // Force the HUD to refresh next frame (state probably changed)
    this._actionLabel = undefined;
  }

  /** Point-in-area test with padding; false if the area is missing or malformed. */
  _inArea(pos, area, pad) {
    if (!area || !area.center || !area.bounds) return false;
    return Math.abs(pos.x - area.center.x) < area.bounds.width / 2 + pad &&
           Math.abs(pos.z - area.center.z) < area.bounds.depth / 2 + pad;
  }

  _detectCurrentArea(pos) {
    const areas = this.mapData.areas;

    // Check courts
    const courts = areas.courts || [];
    for (let i = 0; i < courts.length; i++) {
      const court = courts[i];
      if (!court.center) continue;
      const dx = Math.abs(pos.x - court.center.x);
      const dz = Math.abs(pos.z - court.center.z);
      if (dx < SIZES.courtWidth / 2 + 3 && dz < SIZES.courtDepth / 2 + 3) {
        return court.id;
      }
    }

    if (this._inArea(pos, areas.proShop, 2)) return 'proShop';
    if (this._inArea(pos, areas.patio, 2)) return 'patio';
    if (this._inArea(pos, areas.garden, 2)) return 'garden';
    if (this._inArea(pos, areas.equipmentShed, 2)) return 'equipmentShed';

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

  _showGameTutorial() {
    const steps = [
      {
        speaker: 'Greenbriar Staff Radio',
        text: "Welcome to Greenbriar Tennis & Social Club! You're the new court attendant. Use WASD or arrow keys to move. On mobile, use the joystick in the bottom-left corner.",
      },
      {
        speaker: 'Greenbriar Staff Radio',
        text: "Press E or tap the action button to interact with people and objects. Walk up to club members to chat or help them out.",
      },
      {
        speaker: 'Greenbriar Staff Radio',
        text: "Head to the Pro Shop and check the Task Board for your assignments. You'll also get tasks over the radio while on the job.",
      },
      {
        speaker: 'Greenbriar Staff Radio',
        text: "See the golf cart nearby? Walk up to it and press E to hop in. You can drive it around the club with the same movement keys.",
      },
      {
        speaker: 'Greenbriar Staff Radio',
        text: "To groom the clay courts, drive the cart to the Equipment Shed and press E to attach the drag brush. Then drive onto the clay courts to start sweeping.",
      },
      {
        speaker: 'Greenbriar Staff Radio',
        text: "Your shift runs 7 AM to 7 PM. You earn a wage plus pay for every task, and happy members tip. Do well and you'll climb from Rookie Attendant to Head of Grounds.",
      },
      {
        speaker: 'Greenbriar Staff Radio',
        text: "I'm clocking you in now. Start with the opening checklist on your task list. Good luck!",
      },
    ];

    let stepIndex = 0;
    const showNext = () => {
      if (stepIndex >= steps.length) {
        // Never replay the intro once it has been read through; the first shift starts now
        this.flags.tutorialSeen = true;
        if (this.shift.phase === 'preShift') this.shift.clockIn();
        this.saveGame();
        return;
      }
      const step = steps[stepIndex];
      this.dialogueSystem.showMessage(step.speaker, step.text, '#3498DB', () => {
        stepIndex++;
        showNext();
      });
    };
    this.sound.playNotification();
    showNext();
  }

  _updateCamera(dt) {
    const target = this.player.isInCart ? this.cart.getPosition() : this.player.getPosition();

    // Apply manual camera rotation from touch drag / mouse drag (scaled by the sensitivity setting)
    const cameraDelta = this.input.cameraRotationDelta * -0.004 * this._camSensitivity;
    this.input.cameraRotationDelta = 0;

    if (this.player.isInCart) {
      // Follow cart heading (front of cart is local -Z)
      const forward = this._cartFwd.set(0, 0, -1).applyQuaternion(this.cart.mesh.quaternion);
      this.cameraTargetYaw = Math.atan2(forward.x, forward.z);
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
    this.cameraYaw += yawDiff * Math.min(1, dt * yawLerpSpeed);

    // High-angle groom camera while grooming (C / panel button); otherwise the follow camera
    if (!this.courtMaintenance.computeGroomCameraPose(this._camDesired, this._camLook, this.cameraYaw)) {
      this._computeCameraPose(target, this.cameraYaw);
    }
    this.camera.position.lerp(this._camDesired, Math.min(1, dt * SIZES.cameraLerpSpeed));
    this.camera.lookAt(this._camLook);
  }

  /** Desired camera position / look-at for a follow target and yaw → _camDesired / _camLook. */
  _computeCameraPose(target, yaw) {
    const inCart = this.player.isInCart;
    // Portrait phones: pull back a little so the narrow frame isn't a corridor
    const portrait = this.camera.aspect < 0.8;
    const dist = (inCart ? SIZES.cameraDistance + 2 : SIZES.cameraDistance) + (portrait ? 1.5 : 0);
    const height = (inCart ? SIZES.cameraHeight + 1 : SIZES.cameraHeight) + (portrait ? 0.8 : 0);
    this._camDesired.set(
      target.x - Math.sin(yaw) * dist,
      target.y + height,
      target.z - Math.cos(yaw) * dist
    );
    // Look ahead of the target
    this._camLook.set(
      target.x + Math.sin(yaw) * SIZES.cameraLookAhead,
      target.y + 1.2,
      target.z + Math.cos(yaw) * SIZES.cameraLookAhead
    );
  }

  /** Jump the camera straight to its follow pose (after loading a save — no long swoop). */
  _snapCamera() {
    const target = this.player.isInCart ? this.cart.getPosition() : this.player.getPosition();
    if (this.player.isInCart) {
      const f = this._cartFwd.set(0, 0, -1).applyQuaternion(this.cart.mesh.quaternion);
      this.cameraTargetYaw = this.cameraYaw = Math.atan2(f.x, f.z);
    }
    this._computeCameraPose(target, this.cameraYaw);
    this.camera.position.copy(this._camDesired);
    this.camera.lookAt(this._camLook);
  }

  _gameLoop() {
    requestAnimationFrame(this._loop);

    if (this.paused) {
      // Frozen: nothing advances. Re-render only if the canvas was invalidated (resize / quality).
      if (this._pausedRenderPending) {
        this._pausedRenderPending = false;
        try { this._render(0); } catch (err) { this._reportLoopError('render', err); }
      }
      return;
    }

    const dt = Math.min(this.clock.getDelta(), 0.05);

    try {
      this._update(dt);
    } catch (err) {
      this._reportLoopError('update', err);
    }

    try {
      this._render(dt);
    } catch (err) {
      this._reportLoopError('render', err);
    }
  }

  /** Log each distinct loop error once (with a count on the rare repeat milestones); keep running. */
  _reportLoopError(stage, err) {
    const msg = err && err.message ? err.message : String(err);
    const frame = err && err.stack ? (err.stack.split('\n')[1] || '').trim() : '';
    const key = `${stage}|${msg}|${frame}`;
    const n = (this._loggedErrors.get(key) || 0) + 1;
    if (this._loggedErrors.size < 100 || this._loggedErrors.has(key)) this._loggedErrors.set(key, n);
    if (n === 1) {
      console.error(`Game loop error (${stage}) — further repeats are suppressed:`, err);
    } else if (n === 600) {
      console.warn(`Game loop error (${stage}) still occurring (600+ times): ${msg}`);
    }
  }

  _update(dt) {
    // Update input
    this.input.update(dt);

    // Keyboard dialogue advance (Space / Enter / E). The press is consumed so it can't also
    // trigger the world action button on the frame the dialogue closes.
    if (this.dialogueSystem.isActive() && this.input.isActionJustPressed()) {
      this.dialogueSystem.advance();
      this.input.consumeAction();
    }

    // Deferred events + play-time
    this.stats.playTime += dt;
    const now = performance.now();
    if (this._tutorialAt && now >= this._tutorialAt) {
      if (this.dialogueSystem.isActive()) {
        this._tutorialAt = now + 500; // wait for the current dialogue to finish
      } else {
        this._tutorialAt = 0;
        this._showGameTutorial();
      }
    }
    if (this._npcRequestAt && now >= this._npcRequestAt) {
      this._npcRequestAt = 0;
      this._seedNPCRequests();
    }
    this._autosaveTimer += dt;
    if (this._autosaveTimer >= AUTOSAVE_INTERVAL) {
      this._autosaveTimer = 0;
      this.saveGame();
    }

    // Update physics
    this.physicsWorld.step(1 / 60, dt, 3);

    // Update player / cart
    const moveDir = this.input.getMoveDirection();

    if (this.player.isInCart) {
      this.cart.update(dt, moveDir, true);
      this.sound.updateCartEngine(this.cart.currentSpeed);
    } else {
      this.player.update(dt, moveDir, this.cameraYaw);
      this.cart.update(dt, ZERO_MOVE, false);

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
    if (this.matches) this.matches.update(dt); // after NPCs: swings start on the frame they are due

    // Update world (fountain, etc.)
    this.world.update(dt, playerWorldPos);

    // Update weather (writes EnvState, lighting, sky, shadow frustum around the player)
    this.weather.setShadowFocus(this._computeShadowFocus());
    this.weather.update(dt);

    // Update interactions
    this._updateInteractions();

    // Update court maintenance system
    const weatherState = this.weather.getWeather();
    this.courtMaintenance.degradePaused = !!this.weather.clockFrozen;
    this.courtMaintenance.update(dt, playerWorldPos, this.player.isInCart, weatherState);

    // Update grooming HUD in real time if grooming
    if (this.courtMaintenance.isGrooming()) {
      const progress = this.courtMaintenance.getGroomingProgress();
      if (progress) this.hud.updateGroomingHUD(progress);
    }

    // Update mission system, objective markers and the shift clock
    this.missionSystem.update(dt, playerWorldPos);
    this.missionMarkers.update(dt, playerWorldPos, this.camera.position);
    this.shift.update(dt, !this.dialogueSystem.isActive() && !this.courtMaintenance.isGrooming());

    // Update HUD
    this.hud.updateTimeWeather();
    this.hud.updateMiniMap(playerWorldPos, this.npcs, this.cart.getPosition(), this.mapData, this._getHeading());
    this.hud.update(dt);
  }

  // ───────────────────────────── pause ─────────────────────────────

  _createPauseMenu() {
    this.pauseMenu = new PauseMenu({
      onPauseRequest: () => this.pause('button'),
      onResume: () => this.resume(),
      onSave: () => this.saveGame({ manual: true }),
      onReset: () => this.resetProgress(),
      settings: this.settings,
      getQuality: () => Quality.tier,
      setQuality: (tier) => this.setQuality(tier),
      getAudioStatus: () => (!this.sound.available ? 'unavailable' : this.sound.isReady() ? 'ready' : 'pending'),
      getSummary: () => ({
        day: this.weather.day || 1,
        time: this.weather.getTimeString(),
        weather: this.weather.getWeather(),
        weatherIcon: this.weather.getWeatherIcon(),
        missionsCompleted: this.stats.missionsCompleted,
        courtsGroomed: this.stats.courtsGroomed,
        bestGroomRating: this.stats.bestGroomRating,
        canSave: !this._saveFailed,
        wallet: this.shift.wallet,
        ...this._rankSummary(),
      }),
      getAnchor: () => {
        const c = this.hud && this.hud.miniMapCanvas;
        return this.hud && this.hud.miniMapContainer ? this.hud.miniMapContainer : (c ? c.parentElement : null);
      },
    });
  }

  _rankSummary() {
    const p = this.shift.getRankProgress();
    return {
      rankTitle: p.rank.title,
      rankFrac: p.frac,
      rankPoints: p.points,
      nextRankTitle: p.next ? p.next.title : null,
      nextRankPoints: p.next ? p.next.points : null,
      onShift: this.shift.isOnShift(),
    };
  }

  isPaused() {
    return this.paused;
  }

  /**
   * Freeze the game: physics, game time, weather, missions/radio timers, NPCs, input and audio.
   * reason: 'menu' | 'button' | 'key' | 'hidden'
   */
  pause(reason = 'menu') {
    if (!this._ready || this.paused) return;
    this.paused = true;
    this.pauseReason = reason;
    this._pausedAt = performance.now();
    this.input.setEnabled(false);
    this.sound.setPaused(true);
    if (this.dialogueBox && this.dialogueBox.setPaused) this.dialogueBox.setPaused(true);
    // The report card and the GPU-reset panel are their own modals; everything else opens the pause menu
    if (this.pauseMenu && reason !== 'report' && reason !== 'gpu') this.pauseMenu.open();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pauseReason = null;
    const pausedFor = performance.now() - this._pausedAt;
    if (this._tutorialAt) this._tutorialAt += pausedFor;
    if (this._npcRequestAt) this._npcRequestAt += pausedFor;
    if (this.pauseMenu) this.pauseMenu.close();
    this.input.setEnabled(true);
    this.sound.setPaused(false);
    if (this.dialogueBox && this.dialogueBox.setPaused) this.dialogueBox.setPaused(false);
    this.clock.getDelta(); // discard the paused interval → no dt jump
  }

  togglePause() {
    if (!this._ready) return;
    if (this.pauseReason === 'report') return; // the report card's "Next day" resumes
    if (this.pauseReason === 'gpu') return;    // only a reload recovers from a lost context
    if (this.paused) {
      if (this.pauseMenu && this.pauseMenu.handleEscape()) return; // stepped back from a sub-view
      this.resume();
    } else {
      this.pause('key');
    }
  }

  // ───────────────────────────── save / load ─────────────────────────────

  _loadGame() {
    let data = null;
    try {
      data = this.saveSystem.load();
      if (data) {
        applySaveData(this, data);
        this.hud.updateInventory();
        this.hud.updateTaskList();
      }
    } catch (err) {
      console.error('Loading the save failed; starting fresh:', err);
    }
    if (this.saveSystem.lastLoadStatus === 'corrupt') {
      this.hud.showNotification('Your previous save could not be read, so a new game was started.', 5);
    }
    this._snapCamera();
    return !!data;
  }

  /** Save now. Returns true on success. `manual` is for the pause-menu button. */
  saveGame({ manual = false } = {}) {
    if (!this._ready || this.saveSystem.disabled) return false;
    let ok = false;
    try {
      this.flags.groomTutorialSeen = !!(this.flags.groomTutorialSeen || this.courtMaintenance.tutorialCompleted);
      ok = this.saveSystem.save(captureSaveData(this));
    } catch (err) {
      console.error('Save failed:', err);
      ok = false;
    }
    if (ok) {
      this._autosaveTimer = 0;
      this._saveFailed = false;
    } else {
      this._saveFailed = true;
      // Autosaves are silent; warn once so a whole session isn't lost unnoticed
      if (!manual && !this._warnedSaveFail && this.hud) {
        this._warnedSaveFail = true;
        this.hud.showNotification("Progress can't be saved in this browser (storage unavailable).", 5);
      }
    }
    if (manual && !this.paused && this.hud) this.hud.showNotification(ok ? 'Game saved' : 'Could not save', 2);
    return ok;
  }

  /** Wipe the save and restart from a fresh first shift (settings are kept). */
  resetProgress() {
    this.saveSystem.disabled = true; // stop pagehide / visibility autosaves re-creating it
    this.saveSystem.clear();
    location.reload();
  }

  _recordGroomStats(score, courtCount) {
    const st = this.stats;
    st.groomSessions++;
    st.courtsGroomed += Math.max(0, courtCount | 0);
    if (score && score.rating && (GROOM_RATING_RANK[score.rating] || 0) > (GROOM_RATING_RANK[st.bestGroomRating] || 0)) {
      st.bestGroomRating = score.rating;
    }
    if (score && Number.isFinite(score.cleanliness)) {
      st.bestGroomCleanliness = Math.max(st.bestGroomCleanliness, score.cleanliness);
    }
    this.flags.groomTutorialSeen = true;
  }

  /**
   * Centre of the sun shadow frustum: the ground point the camera looks at, pulled back
   * toward the camera so the whole foreground is covered. No allocations.
   */
  _computeShadowFocus() {
    const cam = this.camera;
    const fwd = this._camFwd;
    cam.getWorldDirection(fwd);
    const extent = Quality.settings.shadowExtent || 30;
    const h = Math.hypot(fwd.x, fwd.z) || 1;
    let dist = extent * 0.7;
    if (fwd.y < -0.02) dist = Math.min(dist, (-cam.position.y / fwd.y) * h);
    this._shadowFocus.set(
      cam.position.x + (fwd.x / h) * dist,
      0,
      cam.position.z + (fwd.z / h) * dist
    );
    return this._shadowFocus;
  }

  /**
   * The WebGL context was lost (GPU reset). GPU-backed resources, including the
   * procedural canvas textures, are gone, so recovering in place isn't reliable.
   * Save, step quality down one tier for the next load, and offer a reload.
   */
  _onContextLost() {
    if (this._contextLost) return;
    this._contextLost = true;
    try { if (!this.paused) this.pause('gpu'); } catch (e) { /* keep going */ }
    try { this.saveGame(); } catch (e) { /* ignore */ }
    const order = ['high', 'medium', 'low'];
    const next = order[Math.min(order.indexOf(Quality.tier) + 1, order.length - 1)] || 'low';
    try { localStorage.setItem('courtcall.quality', next); } catch (e) { /* ignore */ }
    console.warn(`WebGL context lost; graphics set to ${next} for the next load`);
    this._showGpuResetPanel(next);
  }

  _showGpuResetPanel(tier) {
    if (document.getElementById('cc-gpu-reset')) return;
    injectTheme();
    const wrap = document.createElement('div');
    wrap.id = 'cc-gpu-reset';
    Object.assign(wrap.style, {
      position: 'fixed', inset: '0', zIndex: '2000', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: '16px',
      background: 'rgba(12, 28, 19, 0.82)',
    });
    const panel = document.createElement('div');
    panel.className = 'cc-panel';
    Object.assign(panel.style, { maxWidth: '360px', padding: '22px', textAlign: 'center' });
    const title = document.createElement('div');
    title.className = 'cc-title';
    title.style.fontSize = '22px';
    title.textContent = 'Graphics need a restart';
    const text = document.createElement('p');
    Object.assign(text.style, { margin: '10px 0 18px', lineHeight: '1.5', fontSize: '15px' });
    text.textContent = `Your device reset its graphics. Your progress is saved, and graphics quality is now set to ${tier[0].toUpperCase()}${tier.slice(1)} so it runs smoother.`;
    const btn = document.createElement('button');
    btn.className = 'cc-btn cc-btn--primary';
    btn.textContent = 'Reload';
    btn.addEventListener('click', () => window.location.reload());
    panel.append(title, text, btn);
    wrap.appendChild(panel);
    for (const ev of ['pointerdown', 'touchstart', 'mousedown']) wrap.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(wrap);
  }

  _render(dt) {
    if (this._contextLost) return;
    const r = this.renderer;
    r.info.reset();
    if (r.shadowMap.enabled) r.shadowMap.needsUpdate = true;
    this.postFX.updateFromEnv(EnvState);
    this.postFX.render(dt);
    this.renderStats.calls = r.info.render.calls;
    this.renderStats.triangles = r.info.render.triangles;
  }

  /**
   * Switch graphics quality live: 'low' | 'medium' | 'high'. Persists to localStorage.
   */
  setQuality(tier) {
    Quality.set(tier); // triggers _applyQuality via onChange when the tier changes
    return Quality.tier;
  }

  /**
   * Pre-compile shader programs: once with every hidden object shown (night point lights,
   * rain, stars, lamp halos... so those variants exist before dusk / the first shower), then
   * for the current state. Bounded by a timeout so a slow driver can't hold the loader.
   */
  async _precompileShaders() {
    const r = this.renderer;
    if (!r || typeof r.compileAsync !== 'function') return;
    // The env map is part of every lit program's key: make sure it exists first
    if (this.weather && this.weather.prepareEnvironment) this.weather.prepareEnvironment();
    const shown = [];
    // Programs depend on the output target (screen: sRGB + tone mapping; composer target:
    // linear, no tone mapping), so compile against the target the scene really renders to.
    const prevRT = r.getRenderTarget();
    const fx = this.postFX && this.postFX.composer;
    try {
      r.setRenderTarget(fx ? fx.readBuffer : null);
      this.scene.traverse((o) => { if (!o.visible) { o.visible = true; shown.push(o); } });
      // Without KHR_parallel_shader_compile, compileAsync only warns and polls: compile synchronously
      const parallel = r.extensions && r.extensions.has && r.extensions.has('KHR_parallel_shader_compile');
      const compile = (s, c) => (parallel ? r.compileAsync(s, c) : (r.compile(s, c), Promise.resolve()));
      const all = compile(this.scene, this.camera);
      for (const o of shown) o.visible = false;
      shown.length = 0;
      const current = compile(this.scene, this.camera);
      r.setRenderTarget(prevRT);
      await Promise.race([Promise.all([all, current]), new Promise((res) => setTimeout(res, 8000))]);
    } catch (err) {
      console.warn('Shader pre-compile skipped:', err);
    } finally {
      for (const o of shown) o.visible = false;
      if (r.getRenderTarget() !== prevRT) r.setRenderTarget(prevRT);
    }
  }

  _applyQuality(settings) {
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatioCap));
    r.setSize(window.innerWidth, window.innerHeight);
    const shadowsWanted = !!settings.shadows;
    const typeWanted = settings.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (r.shadowMap.enabled !== shadowsWanted || r.shadowMap.type !== typeWanted) {
      r.shadowMap.enabled = shadowsWanted;
      r.shadowMap.type = typeWanted;
      // programs must recompile for shadow changes
      this.scene.traverse((o) => {
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => { m.needsUpdate = true; });
          else o.material.needsUpdate = true;
        }
      });
    }
    this.weather.setQuality(settings);
    this.postFX.apply(settings);
    this.postFX.setSize(window.innerWidth, window.innerHeight);
    refreshTextureQuality();
    this._pausedRenderPending = true;
    // Recompile changed programs now (usually from the pause menu) rather than mid-gameplay
    if (this._ready) this._precompileShaders();
  }

  /** Wider vertical FOV on portrait screens (60° vertical is only ~29° across on a phone). */
  static fovForAspect(aspect) {
    return aspect < 0.8 ? 72 : 60;
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.fov = Game.fovForAspect(w / h);
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Quality.settings.pixelRatioCap));
    this.renderer.setSize(w, h);
    this.postFX.setSize(w, h);
    this._pausedRenderPending = true;
  }
}

// Start the game
const game = new Game();

// Dev-only handle for debugging and automated screenshots
if (import.meta.env.DEV) {
  window.__game = game;
  window.__env = EnvState;
}
