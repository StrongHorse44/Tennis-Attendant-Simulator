import * as THREE from 'three';
import { GAME, SIZES } from '../utils/Constants.js';
import { GroomFX } from './GroomFX.js';
import { GroomSummary } from '../ui/GroomSummary.js';

/**
 * CourtMaintenanceSystem - manages clay court grooming minigame
 *
 * States:
 *   idle        - no grooming active, courts degrade over time
 *   tutorial    - step-by-step training walkthrough (first time only)
 *   grooming    - actively sweeping courts with the brush
 *   results     - showing score after finishing a groom session
 *
 * All 3 clay courts are groomed in a single session. The sweep pattern is:
 *   1. Outside perimeter (near fences) first
 *   2. Pick a side, sweep near the net
 *   3. Sweep that half of the court
 *   4. Sweep the other half / between courts
 *
 * Courtside tasks (coolers, cups, trash) must be completed during grooming.
 * Proximity feedback warns if too close/far from fences and nets.
 *
 * Painting: each frame the towed brush's footprint (GAME.groomBrushWidth x groomBrushDepth,
 * facing the pull direction) is swept from last frame's brush position to this one into
 * every clay court's paint mask (Court.groomStroke) — cleanliness and coverage are read
 * back from those masks. Feel: speed-tied scrape loop, dust (GolfCart), floating per-court
 * % labels, sparkle + chime at excellent / 100% (GroomFX) and an end-of-session heatmap card.
 */
export class CourtMaintenanceSystem {
  constructor(courts, cart, dialogueSystem, soundSystem, mapData) {
    this.courts = courts;         // array of all Court instances
    this.cart = cart;
    this.dialogueSystem = dialogueSystem;
    this.sound = soundSystem;
    this.mapData = mapData;

    this.courts = Array.isArray(courts) ? courts : [];
    this.clayCourts = this.courts.filter(c => c && c.isClay);

    // State
    this.state = 'idle';
    this.activeCourts = [];       // all clay courts being groomed
    this.groomStartCleanliness = 0;
    this.groomTimer = 0;
    this._resultsTimer = 0;
    this._brushPos = new THREE.Vector3();
    this._prevBrush = { x: 0, z: 0, valid: false };
    this._milestones = new Map();   // courtId -> 0 none / 1 excellent / 2 perfect (this session)
    this._labelTimer = 0;
    this._scrapeLevel = 0;
    this.groomCamera = false;       // high-angle groom camera requested (see computeGroomCameraPose)
    this.degradePaused = false;     // set by Game each frame from weather.clockFrozen

    // In-world feedback (labels, sparkles) + end-of-session card; built once, hidden
    const scene = this.clayCourts.length ? this.clayCourts[0].scene : null;
    this.fx = new GroomFX(scene, this.clayCourts);
    this.summary = new GroomSummary();
    this._progress = {
      cleanliness: 0, coverage: 0, time: 0, speed: 0, speedOk: true,
      proximity: null, courtsideTasks: null,
    };

    // Tutorial
    this.tutorialCompleted = false;
    this.tutorialStep = 0;
    this.tutorialSteps = [
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "Hey rookie! Before you hit the clay courts, let me show you how to groom 'em properly. First things first — see this drag brush? It hooks right onto the back of the cart.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "The clay courts are all side by side. You'll sweep all three in one pass — no stopping between courts. Start on the OUTSIDE PERIMETER, right along the fence. Stay close to it — around 6 inches away. Not too close or you'll catch the fence, not too far or you'll miss the edges.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "After the perimeter, pick a side and sweep along the NET. Get close to the net — same deal, around 6 inches away. Then sweep that whole half of the court. After that, do the other half and the areas between the courts.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "Go SLOW — under 5 units/sec. Too fast and you'll tear up the surface instead of smoothing it. Watch the speed indicator on your screen. You'll also see proximity warnings — green means you're at a good distance from the fence or net.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "Oh, and between the courts you'll find igloo coolers and trash bins. While you're grooming, swap out the old coolers for fresh ones, set out cups, and grab any trash from the bins. It's all part of the job.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "One more thing — don't brush when it's raining! Wet clay turns to mud if you drag it. Alright, give it a shot! Drive onto the clay courts to start grooming.",
      },
    ];

    // Degradation timer
    this.degradeTimer = GAME.courtDegradeInterval;

    // Scoring
    this.lastScore = null;

    // Brush scrape sound timer
    this.brushSoundTimer = 0;

    // Proximity state
    this.proximityState = {
      nearestFenceDist: null,    // distance to closest fence
      nearestNetDist: null,      // distance to closest net
      fenceStatus: 'none',       // 'optimal', 'warn', 'danger', 'none'
      netStatus: 'none',
    };

    // Courtside tasks (generated per session)
    this.courtsideTasks = [];
    // Each: { id, junctionId, type: 'cooler'|'cups'|'trash', label, completed }

    // Junction data from map
    this.junctions = [];
    if (mapData && mapData.areas && mapData.areas.courtJunctions) {
      this.junctions = mapData.areas.courtJunctions;
    }

    // Callbacks
    this.onGroomStart = null;
    this.onGroomEnd = null;
    this.onGroomUpdate = null;
    this.onTutorialStart = null;
    this.onProximityUpdate = null;
    this.onCourtsideTaskComplete = null;
  }

  update(dt, playerPos, isInCart, weatherState) {
    // Degrade courts over time (not while the shift clock stands still: before clock-in / after 7 PM)
    if (!this.degradePaused) this.degradeTimer -= dt;
    if (this.degradeTimer <= 0) {
      this.degradeTimer = GAME.courtDegradeInterval;
      for (const court of this.clayCourts) {
        court.degradeSurface(GAME.courtDegradeAmount);
      }
    }

    if (this.state === 'grooming') {
      this._updateGrooming(dt, weatherState);
    } else {
      this._setScrape(0, 0);
    }
    this.fx.update(dt);
    this.summary.update(dt);
    if (this.state === 'results') {
      // Return to idle shortly after showing results (game time, so it respects pause)
      this._resultsTimer -= dt;
      if (this._resultsTimer <= 0) this.state = 'idle';
    }
  }

  // ───────────────────────────── save / load ─────────────────────────────

  /** Serializable state: per-court cleanliness (0..1) + per-cell grids, tutorial flag, degrade timer, live session. */
  getState() {
    const courts = {};
    for (const court of this.clayCourts) {
      if (court && court.id && typeof court.getCleanliness === 'function') {
        courts[court.id] = Math.round(court.getCleanliness() * 1000) / 1000;
      }
    }
    const grids = {};
    for (const court of this.clayCourts) {
      if (court && court.id && typeof court.getMaskData === 'function') {
        const data = court.getMaskData();
        if (data) grids[court.id] = data;
      }
    }
    let session = null;
    if (this.state === 'grooming') {
      const hit = {};
      for (const court of this.activeCourts) hit[court.id] = court.getHitData();
      session = {
        time: this.groomTimer,
        startCleanliness: this.groomStartCleanliness,
        tasksDone: this.courtsideTasks.filter(t => t.completed).map(t => t.id),
        hit,
      };
    }
    return {
      tutorialCompleted: !!this.tutorialCompleted,
      degradeTimer: this.degradeTimer,
      courts,
      grids,
      session,
    };
  }

  /**
   * Re-open a grooming session captured by getState().session (after the cart
   * and brush are restored). Returns true if a session was started.
   */
  resumeGrooming(session) {
    if (!session || this.state === 'grooming' || !this.tutorialCompleted) return false;
    if (!this.cart.hasBrush || this.clayCourts.length === 0) return false;
    this._beginGrooming();
    if (Number.isFinite(session.time)) this.groomTimer = Math.max(0, session.time);
    if (Number.isFinite(session.startCleanliness)) {
      this.groomStartCleanliness = Math.max(0, Math.min(1, session.startCleanliness));
    }
    if (Array.isArray(session.tasksDone)) {
      for (const t of this.courtsideTasks) if (session.tasksDone.includes(t.id)) t.completed = true;
    }
    if (session.hit && typeof session.hit === 'object') {
      // base64 bit mask (current saves) or a list of old 8 x 14 cell indices (upsampled)
      for (const court of this.activeCourts) {
        const data = session.hit[court.id];
        if (data) court.setHitData(data);
      }
    }
    // Don't re-celebrate courts that were already done before the save
    for (const court of this.activeCourts) this._milestones.set(court.id, this._courtMilestone(court));
    return true;
  }

  setState(state) {
    if (!state || typeof state !== 'object') return;
    if (typeof state.tutorialCompleted === 'boolean') this.tutorialCompleted = state.tutorialCompleted;
    if (Number.isFinite(state.degradeTimer)) {
      this.degradeTimer = Math.max(1, Math.min(GAME.courtDegradeInterval, state.degradeTimer));
    }
    const grids = (state.grids && typeof state.grids === 'object') ? state.grids : {};
    if (state.courts && typeof state.courts === 'object') {
      for (const court of this.clayCourts) {
        // Per-cell paint mask when available (keeps groomed stripes; old 8x14 hex grids are
        // upsampled), else the average
        if (typeof court.setMaskData === 'function' && court.setMaskData(grids[court.id])) continue;
        const c = state.courts[court.id];
        if (Number.isFinite(c) && typeof court.setAllDirt === 'function') {
          court.setAllDirt(1 - Math.max(0, Math.min(1, c)));
        }
      }
    }
  }

  /**
   * Check if the player (in cart with brush) is near any clay court.
   * Returns the first nearby court if applicable, null otherwise.
   */
  getNearbyClayCourtForGrooming(playerPos) {
    if (!this.cart.hasBrush || !this.cart.occupied || !playerPos) return null;
    if (this.state === 'grooming' || this.state === 'tutorial') return null;

    for (const court of this.clayCourts) {
      const center = court.config.center;
      const dx = Math.abs(playerPos.x - center.x);
      const dz = Math.abs(playerPos.z - center.z);
      if (dx < SIZES.courtWidth / 2 + 4 && dz < SIZES.courtDepth / 2 + 4) {
        return court;
      }
    }
    return null;
  }

  /**
   * Check if the player (in cart, no brush) is near the equipment shed.
   */
  isNearEquipmentShed(playerPos, shedPos) {
    if (!playerPos || !shedPos) return false;
    const dx = playerPos.x - shedPos.x;
    const dz = playerPos.z - shedPos.z;
    return Math.sqrt(dx * dx + dz * dz) < 4;
  }

  /**
   * Start the tutorial if not completed, otherwise start grooming.
   * Grooming covers ALL clay courts simultaneously.
   */
  startGrooming(court) {
    if (this.state === 'grooming' || this.state === 'tutorial') return;
    if (this.clayCourts.length === 0) return;
    if (!this.tutorialCompleted) {
      this._startTutorial(court);
      return;
    }
    this._beginGrooming();
  }

  /**
   * Stop the current grooming session and show results.
   */
  stopGrooming() {
    if (this.state !== 'grooming' || this.activeCourts.length === 0) return;

    // Combined score across all courts, read back from the paint masks
    const { cleanliness, coverage } = this._totals();
    const improvement = cleanliness - this.groomStartCleanliness;

    // Check courtside task completion
    const tasksTotal = this.courtsideTasks.length;
    const tasksCompleted = this.courtsideTasks.filter(t => t.completed).length;
    const taskBonus = tasksTotal > 0 ? tasksCompleted / tasksTotal : 1;

    let rating, message;
    if (cleanliness >= GAME.groomScoreThreshold && coverage >= 0.7 && taskBonus >= 0.8) {
      rating = 'excellent';
      message = `Excellent work! Courts are ${Math.round(cleanliness * 100)}% clean with ${Math.round(coverage * 100)}% coverage. ${tasksCompleted}/${tasksTotal} courtside tasks done. Hank would be proud!`;
    } else if (cleanliness >= 0.6 && coverage >= 0.5) {
      rating = 'good';
      message = `Good job! Courts are ${Math.round(cleanliness * 100)}% clean. ${tasksCompleted}/${tasksTotal} courtside tasks done. A few spots could use another pass.`;
    } else {
      rating = 'needsWork';
      message = `Courts are ${Math.round(cleanliness * 100)}% clean. ${Math.round((1 - coverage) * 100)}% of the surface was missed. ${tasksCompleted}/${tasksTotal} courtside tasks done.`;
    }

    this.lastScore = {
      courtId: this.activeCourts.map(c => c.id).join(','),
      cleanliness,
      coverage,
      improvement,
      rating,
      time: this.groomTimer,
      tasksCompleted,
      tasksTotal,
    };

    this.state = 'results';
    this.groomCamera = false; // back to the follow camera when the session ends
    this._resultsTimer = 0.1;
    const groomed = this.activeCourts;
    this.activeCourts = [];
    this.courtsideTasks = [];
    this._setScrape(0, 0);
    this.fx.showLabels(false);
    this.summary.show(this.lastScore, groomed);

    if (this.onGroomEnd) {
      this.onGroomEnd(this.lastScore, message);
    }

    return this.lastScore;
  }

  isGrooming() {
    return this.state === 'grooming';
  }

  /** Slab-weighted cleanliness + coverage of the active courts (reused result object). */
  _totals() {
    const t = this._tot || (this._tot = { cleanliness: 0, coverage: 0 });
    let clean = 0, hit = 0, cells = 0;
    for (const court of this.activeCourts) {
      const n = court.scoreCells || 0;
      clean += court.getCleanliness() * n;
      hit += court.getHitCount ? court.getHitCount() : 0;
      cells += n;
    }
    t.cleanliness = cells > 0 ? clean / cells : 0;
    t.coverage = cells > 0 ? hit / cells : 0;
    return t;
  }

  /** 0 = not yet, 1 = excellent (clean ≥ threshold, ≥ 70% brushed), 2 = perfect (≈100%). */
  _courtMilestone(court) {
    const clean = court.getCleanliness(), cov = court.getCoverage();
    if (clean >= 0.995 && cov >= 0.98) return 2;
    if (clean >= GAME.groomScoreThreshold && cov >= 0.7) return 1;
    return 0;
  }

  _setScrape(level, speed) {
    if (level === 0 && this._scrapeLevel === 0) return;
    this._scrapeLevel = level;
    if (this.sound && typeof this.sound.setBrushScrape === 'function') this.sound.setBrushScrape(level, speed);
  }

  /** Toggle the high-angle groom camera flag (main.js reads computeGroomCameraPose). */
  toggleGroomCamera(on = !this.groomCamera) {
    this.groomCamera = !!on;
    return this.groomCamera;
  }

  /**
   * High-angle groom camera pose: looks down on the brush from behind and above so the
   * lanes and missed strips read clearly. Writes into outPos / outLook (no allocation).
   * Returns false when not grooming or the flag is off (use the normal follow camera).
   */
  computeGroomCameraPose(outPos, outLook, yaw) {
    if (!this.groomCamera || this.state !== 'grooming' || !this.cart.hasBrush || !this.cart.occupied) return false;
    const bs = this.cart.brushState;
    const cp = this.cart.getPosition();
    const lx = (cp.x + bs.x) * 0.5, lz = (cp.z + bs.z) * 0.5;
    outLook.set(lx, 0.2, lz);
    outPos.set(lx - Math.sin(yaw) * 5.5, 15, lz - Math.cos(yaw) * 5.5);
    return true;
  }

  /** Overnight wear (called on "Next day"): a light uniform layer so every day starts with grooming. */
  degradeOvernight(amount = GAME.courtOvernightDegrade) {
    if (!(amount > 0)) return;
    for (const court of this.clayCourts) court.degradeSurface(amount);
  }

  /** Mean cleanliness (0..1) of the clay courts, or null if there are none. Cheap (no mask encode). */
  getAverageCleanliness() {
    let sum = 0, n = 0;
    for (const court of this.clayCourts) {
      if (court && typeof court.getCleanliness === 'function') { sum += court.getCleanliness(); n++; }
    }
    return n ? sum / n : null;
  }

  getActiveCourts() {
    return this.activeCourts;
  }

  /** Live grooming progress. Returns a REUSED object (don't keep a reference across frames). */
  getGroomingProgress() {
    if (this.activeCourts.length === 0) return null;
    const t = this._totals();
    const p = this._progress;
    p.cleanliness = t.cleanliness;
    p.coverage = t.coverage;
    p.time = this.groomTimer;
    p.speed = Math.abs(this.cart.currentSpeed);
    p.speedOk = p.speed <= GAME.groomSpeedLimit;
    p.proximity = this.proximityState;
    p.courtsideTasks = this.courtsideTasks;
    return p;
  }

  /**
   * Get nearby courtside task that can be interacted with.
   * Returns the task if cart is close enough, null otherwise.
   */
  getNearbyCourtTask(cartPos) {
    if (this.state !== 'grooming' || !cartPos) return null;

    for (let t = 0; t < this.courtsideTasks.length; t++) {
      const task = this.courtsideTasks[t];
      if (task.completed) continue;

      let junction = null;
      for (let j = 0; j < this.junctions.length; j++) {
        if (this.junctions[j].id === task.junctionId) { junction = this.junctions[j]; break; }
      }
      if (!junction || !junction.position) continue;

      const pos = junction.position;
      const dx = cartPos.x - pos.x;
      const dz = cartPos.z - pos.z;
      if (Math.sqrt(dx * dx + dz * dz) < GAME.coolerInteractRange) {
        return task;
      }
    }
    return null;
  }

  /**
   * Complete a courtside task.
   */
  completeCourtTask(taskId) {
    const task = this.courtsideTasks.find(t => t.id === taskId);
    if (!task || task.completed) return false;

    task.completed = true;

    if (this.onCourtsideTaskComplete) {
      this.onCourtsideTaskComplete(task);
    }

    return true;
  }

  _startTutorial(court) {
    this.state = 'tutorial';
    this.tutorialStep = 0;

    if (this.onTutorialStart) this.onTutorialStart();

    this._showTutorialStep(() => {
      this.tutorialCompleted = true;
      this._beginGrooming();
    });
  }

  _showTutorialStep(onComplete) {
    if (this.tutorialStep >= this.tutorialSteps.length) {
      if (onComplete) onComplete();
      return;
    }

    const step = this.tutorialSteps[this.tutorialStep];
    this.dialogueSystem.showMessage(step.speaker, step.text, '#F39C12', () => {
      this.tutorialStep++;
      this._showTutorialStep(onComplete);
    });
  }

  _beginGrooming() {
    this.state = 'grooming';
    this.groomCamera = false;
    this.activeCourts = [...this.clayCourts]; // groom all clay courts at once

    // Fresh coverage masks for this session
    this._milestones.clear();
    for (const court of this.activeCourts) {
      court.beginSession();
      this._milestones.set(court.id, 0);
    }
    this.groomStartCleanliness = this._totals().cleanliness;
    this.groomTimer = 0;
    this.brushSoundTimer = 0;
    this._prevBrush.valid = false;
    this._labelTimer = 0;
    this.fx.showLabels(true);
    this._updateLabels();

    // Generate courtside tasks for this session
    this._generateCourtsideTasks();

    if (this.onGroomStart) {
      this.onGroomStart(this.activeCourts);
    }
  }

  _generateCourtsideTasks() {
    this.courtsideTasks = [];
    let taskIdx = 0;

    for (const junction of this.junctions) {
      if (junction.hasCooler) {
        this.courtsideTasks.push({
          id: `task_${taskIdx++}`,
          junctionId: junction.id,
          type: 'cooler',
          label: 'Swap cooler',
          completed: false,
        });
        this.courtsideTasks.push({
          id: `task_${taskIdx++}`,
          junctionId: junction.id,
          type: 'cups',
          label: 'Add cups',
          completed: false,
        });
      }
      if (junction.hasTrashBin) {
        this.courtsideTasks.push({
          id: `task_${taskIdx++}`,
          junctionId: junction.id,
          type: 'trash',
          label: 'Empty trash',
          completed: false,
        });
      }
    }
  }

  _updateGrooming(dt, weatherState) {
    if (this.activeCourts.length === 0 || !this.cart.hasBrush) {
      this.stopGrooming();
      return;
    }

    this.groomTimer += dt;

    const brushPos = this.cart.getBrushWorldPosition(this._brushPos);
    if (!brushPos) return;
    const bs = this.cart.brushState;
    const prev = this._prevBrush;
    const bx = brushPos.x, bz = brushPos.z;
    if (!prev.valid || Math.abs(bx - prev.x) + Math.abs(bz - prev.z) > 4) {
      prev.x = bx; prev.z = bz; prev.valid = true;   // start / teleport: no streak
    }

    // Proximity feedback (brush centre to fences / nets)
    this._updateProximity(brushPos);

    const speed = Math.abs(this.cart.currentSpeed);
    let covered = 0;

    // Don't groom in rain (wet clay turns to mud); only at a sensible speed
    if (weatherState !== 'rainy' && speed >= 0.3 && speed <= GAME.groomSpeedPenalty) {
      const lim = GAME.groomSpeedLimit, pen = GAME.groomSpeedPenalty;
      const strength = speed <= lim ? 1 : 1 - 0.7 * (speed - lim) / Math.max(0.01, pen - lim);
      const width = this.cart.getBrushWidth ? this.cart.getBrushWidth() : GAME.groomBrushWidth; // + rank perk
      const depth = GAME.groomBrushDepth || 0.55;
      for (let i = 0; i < this.activeCourts.length; i++) {
        covered += this.activeCourts[i].groomStroke(prev.x, prev.z, bx, bz, bs.hx, bs.hz, width, depth, strength);
      }
    }
    prev.x = bx; prev.z = bz;

    // Scrape loop: louder / higher with brush speed, silent off the clay
    const sn = Math.min(1, bs.speed / 6);
    this._setScrape(covered > 0 ? 0.35 + 0.65 * sn : 0, sn);

    if (covered > 0) {
      this._checkMilestones();
      if (this.onGroomUpdate) this.onGroomUpdate(this.getGroomingProgress());
    }

    // Floating % labels (~6 Hz; canvases redraw only when the numbers change)
    this._labelTimer -= dt;
    if (this._labelTimer <= 0) {
      this._labelTimer = 0.16;
      this._updateLabels();
    }

    // Check if cart left the entire clay court area (all 3 courts combined)
    const cartPos = this.cart.getPosition();
    let isNearAnyCourt = false;
    for (let i = 0; i < this.activeCourts.length; i++) {
      const center = this.activeCourts[i].config.center;
      if (Math.abs(cartPos.x - center.x) < SIZES.courtWidth / 2 + 8 &&
          Math.abs(cartPos.z - center.z) < SIZES.courtDepth / 2 + 8) {
        isNearAnyCourt = true;
        break;
      }
    }

    if (!isNearAnyCourt) {
      this.stopGrooming();
    }
  }

  _updateLabels() {
    for (let i = 0; i < this.activeCourts.length; i++) {
      const c = this.activeCourts[i];
      const clean = Math.floor(c.getCleanliness() * 100 + 0.5);
      const cover = Math.floor(c.getCoverage() * 100);
      this.fx.setCourt(c, clean, cover, this._milestones.get(c.id) || 0);
    }
  }

  /** Sparkle + chime the first time a court reaches excellent, and again at 100%. */
  _checkMilestones() {
    for (let i = 0; i < this.activeCourts.length; i++) {
      const c = this.activeCourts[i];
      const was = this._milestones.get(c.id) || 0;
      if (was >= 2) continue;
      const now = this._courtMilestone(c);
      if (now <= was) continue;
      this._milestones.set(c.id, now);
      this.fx.celebrate(c, now);
      if (this.sound && typeof this.sound.playGroomChime === 'function') this.sound.playGroomChime(now);
      this._labelTimer = 0;
    }
  }

  /**
   * Calculate proximity to nearest fence and net for feedback.
   */
  _updateProximity(brushPos) {
    let nearestFenceDist = Infinity;
    let nearestNetDist = Infinity;

    for (const court of this.activeCourts) {
      const center = court.config.center;
      const halfW = SIZES.courtWidth / 2;
      const halfD = SIZES.courtDepth / 2;

      // Distance to baseline fences (at z = center.z +/- halfD + 0.5)
      const fenceNorthZ = center.z - halfD - 0.5;
      const fenceSouthZ = center.z + halfD + 0.5;
      const distToNorth = Math.abs(brushPos.z - fenceNorthZ);
      const distToSouth = Math.abs(brushPos.z - fenceSouthZ);
      nearestFenceDist = Math.min(nearestFenceDist, distToNorth, distToSouth);

      // Side fences (only on the outermost courts)
      if (!court.config.adjacentLeft) {
        const fenceLeftX = center.x - halfW - 0.5;
        nearestFenceDist = Math.min(nearestFenceDist, Math.abs(brushPos.x - fenceLeftX));
      }
      if (!court.config.adjacentRight) {
        const fenceRightX = center.x + halfW + 0.5;
        nearestFenceDist = Math.min(nearestFenceDist, Math.abs(brushPos.x - fenceRightX));
      }

      // Distance to net (at z = center.z, running across width)
      if (brushPos.x >= center.x - halfW && brushPos.x <= center.x + halfW) {
        const distToNet = Math.abs(brushPos.z - center.z);
        nearestNetDist = Math.min(nearestNetDist, distToNet);
      }
    }

    // Determine status
    const fenceStatus = this._getProximityStatus(nearestFenceDist);
    const netStatus = this._getProximityStatus(nearestNetDist);

    // Mutate in place (no per-frame allocation)
    const ps = this.proximityState;
    ps.nearestFenceDist = nearestFenceDist === Infinity ? null : nearestFenceDist;
    ps.nearestNetDist = nearestNetDist === Infinity ? null : nearestNetDist;
    ps.fenceStatus = fenceStatus;
    ps.netStatus = netStatus;

    if (this.onProximityUpdate) {
      this.onProximityUpdate(this.proximityState);
    }
  }

  _getProximityStatus(distance) {
    if (distance === Infinity || distance > GAME.proximityWarnMax + 2) return 'none';
    if (distance < GAME.proximityDangerMin) return 'danger';
    if (distance >= GAME.proximityOptimalMin && distance <= GAME.proximityOptimalMax) return 'optimal';
    if (distance > GAME.proximityWarnMax) return 'far';
    return 'warn';
  }
}
