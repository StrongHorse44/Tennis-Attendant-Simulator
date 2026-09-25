import * as THREE from 'three';
import { GAME, SIZES } from '../utils/Constants.js';

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
    this.groomCellsHit = new Map(); // courtId -> Set of cell indices (row * gridCols + col)
    this._resultsTimer = 0;
    this._brushPos = new THREE.Vector3();
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
    // Degrade courts over time
    this.degradeTimer -= dt;
    if (this.degradeTimer <= 0) {
      this.degradeTimer = GAME.courtDegradeInterval;
      for (const court of this.clayCourts) {
        court.degradeSurface(GAME.courtDegradeAmount);
      }
    }

    if (this.state === 'grooming') {
      this._updateGrooming(dt, weatherState);
    } else if (this.state === 'results') {
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
      if (court && court.id && typeof court.getGridHex === 'function') {
        const hex = court.getGridHex();
        if (hex) grids[court.id] = hex;
      }
    }
    let session = null;
    if (this.state === 'grooming') {
      const hit = {};
      for (const [id, set] of this.groomCellsHit) hit[id] = [...set];
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
      for (const court of this.activeCourts) {
        const cells = session.hit[court.id];
        const set = this.groomCellsHit.get(court.id);
        if (!Array.isArray(cells) || !set) continue;
        const max = court.gridRows * court.gridCols;
        for (const c of cells) if (Number.isInteger(c) && c >= 0 && c < max) set.add(c);
      }
    }
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
        // Per-cell pattern when available (keeps groomed stripes), else the average
        if (typeof court.setGridHex === 'function' && court.setGridHex(grids[court.id])) continue;
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

    // Calculate combined score across all courts
    let totalCleanliness = 0;
    let totalCells = 0;
    let totalHitCells = 0;

    for (const court of this.activeCourts) {
      totalCleanliness += court.getCleanliness() * court.gridRows * court.gridCols;
      totalCells += court.gridRows * court.gridCols;
      const hitSet = this.groomCellsHit.get(court.id) || new Set();
      totalHitCells += hitSet.size;
    }

    const cleanliness = totalCells > 0 ? totalCleanliness / totalCells : 0;
    const coverage = totalCells > 0 ? totalHitCells / totalCells : 0;
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
    this._resultsTimer = 0.1;
    this.activeCourts = [];
    this.groomCellsHit.clear();
    this.courtsideTasks = [];

    if (this.onGroomEnd) {
      this.onGroomEnd(this.lastScore, message);
    }

    return this.lastScore;
  }

  isGrooming() {
    return this.state === 'grooming';
  }

  getActiveCourts() {
    return this.activeCourts;
  }

  /** Live grooming progress. Returns a REUSED object (don't keep a reference across frames). */
  getGroomingProgress() {
    if (this.activeCourts.length === 0) return null;

    let totalCleanliness = 0;
    let totalCells = 0;
    let totalHitCells = 0;

    for (const court of this.activeCourts) {
      totalCleanliness += court.getCleanliness() * court.gridRows * court.gridCols;
      totalCells += court.gridRows * court.gridCols;
      const hitSet = this.groomCellsHit.get(court.id) || new Set();
      totalHitCells += hitSet.size;
    }

    const p = this._progress;
    p.cleanliness = totalCells > 0 ? totalCleanliness / totalCells : 0;
    p.coverage = totalCells > 0 ? totalHitCells / totalCells : 0;
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
    this.activeCourts = [...this.clayCourts]; // groom all clay courts at once
    this.groomCellsHit.clear();

    // Initialize per-court hit tracking
    let totalCleanliness = 0;
    let totalCells = 0;
    for (const court of this.activeCourts) {
      this.groomCellsHit.set(court.id, new Set());
      totalCleanliness += court.getCleanliness() * court.gridRows * court.gridCols;
      totalCells += court.gridRows * court.gridCols;
    }
    this.groomStartCleanliness = totalCells > 0 ? totalCleanliness / totalCells : 0;
    this.groomTimer = 0;
    this.brushSoundTimer = 0;

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

    // Don't groom in rain
    if (weatherState === 'rainy') return;

    const brushPos = this.cart.getBrushWorldPosition(this._brushPos);
    if (!brushPos) return;

    const speed = Math.abs(this.cart.currentSpeed);

    // Update proximity feedback
    this._updateProximity(brushPos);

    // Only groom when moving at reasonable speed
    if (speed < 0.3 || speed > GAME.groomSpeedPenalty) return;

    // Groom across ALL active courts
    const brushRadius = GAME.groomBrushWidth / 2;
    let totalAffected = 0;

    for (const court of this.activeCourts) {
      const affected = court.groomAt(brushPos.x, brushPos.z, brushRadius);

      if (affected > 0) {
        totalAffected += affected;

        // Track which cells were hit (only scan the cells under the brush)
        const center = court.config.center;
        const cellSize = GAME.groomCellSize;
        const x0 = center.x - SIZES.courtWidth / 2;
        const z0 = center.z - SIZES.courtDepth / 2;
        const hitSet = this.groomCellsHit.get(court.id);
        const r2 = brushRadius * brushRadius;
        const colMin = Math.max(0, Math.floor((brushPos.x - brushRadius - x0) / cellSize));
        const colMax = Math.min(court.gridCols - 1, Math.floor((brushPos.x + brushRadius - x0) / cellSize));
        const rowMin = Math.max(0, Math.floor((brushPos.z - brushRadius - z0) / cellSize));
        const rowMax = Math.min(court.gridRows - 1, Math.floor((brushPos.z + brushRadius - z0) / cellSize));

        if (hitSet) {
          for (let row = rowMin; row <= rowMax; row++) {
            for (let col = colMin; col <= colMax; col++) {
              const dx = brushPos.x - (x0 + (col + 0.5) * cellSize);
              const dz = brushPos.z - (z0 + (row + 0.5) * cellSize);
              if (dx * dx + dz * dz < r2) {
                hitSet.add(row * court.gridCols + col);
              }
            }
          }
        }
      }
    }

    if (totalAffected > 0) {
      // Play brush scraping sound periodically
      this.brushSoundTimer -= dt;
      if (this.brushSoundTimer <= 0) {
        this.sound.playBrushScrape();
        this.brushSoundTimer = 0.4;
      }

      if (this.onGroomUpdate) {
        this.onGroomUpdate(this.getGroomingProgress());
      }
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
