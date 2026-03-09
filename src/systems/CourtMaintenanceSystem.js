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

    this.clayCourts = courts.filter(c => c.isClay);

    // State
    this.state = 'idle';
    this.activeCourts = [];       // all clay courts being groomed
    this.groomStartCleanliness = 0;
    this.groomTimer = 0;
    this.groomCellsHit = new Map(); // courtId -> Set of "row,col"

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
    }
  }

  /**
   * Check if the player (in cart with brush) is near any clay court.
   * Returns the first nearby court if applicable, null otherwise.
   */
  getNearbyClayCourtForGrooming(playerPos) {
    if (!this.cart.hasBrush || !this.cart.occupied) return null;
    if (this.state === 'grooming') return null;

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
    this.activeCourts = [];
    this.groomCellsHit.clear();
    this.courtsideTasks = [];

    if (this.onGroomEnd) {
      this.onGroomEnd(this.lastScore, message);
    }

    // Return to idle after showing results
    setTimeout(() => {
      this.state = 'idle';
    }, 100);

    return this.lastScore;
  }

  isGrooming() {
    return this.state === 'grooming';
  }

  getActiveCourts() {
    return this.activeCourts;
  }

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

    const cleanliness = totalCells > 0 ? totalCleanliness / totalCells : 0;
    const coverage = totalCells > 0 ? totalHitCells / totalCells : 0;

    return {
      cleanliness,
      coverage,
      time: this.groomTimer,
      speed: Math.abs(this.cart.currentSpeed),
      speedOk: Math.abs(this.cart.currentSpeed) <= GAME.groomSpeedLimit,
      proximity: this.proximityState,
      courtsideTasks: this.courtsideTasks,
    };
  }

  /**
   * Get nearby courtside task that can be interacted with.
   * Returns the task if cart is close enough, null otherwise.
   */
  getNearbyCourtTask(cartPos) {
    if (this.state !== 'grooming' || !cartPos) return null;

    for (const task of this.courtsideTasks) {
      if (task.completed) continue;

      const junction = this.junctions.find(j => j.id === task.junctionId);
      if (!junction) continue;

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

    const brushPos = this.cart.getBrushWorldPosition();
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

        // Track which cells were hit
        const center = court.config.center;
        const cellSize = GAME.groomCellSize;
        const w = SIZES.courtWidth;
        const d = SIZES.courtDepth;
        const hitSet = this.groomCellsHit.get(court.id);

        for (let row = 0; row < court.gridRows; row++) {
          for (let col = 0; col < court.gridCols; col++) {
            const cx = center.x - w / 2 + (col + 0.5) * cellSize;
            const cz = center.z - d / 2 + (row + 0.5) * cellSize;
            const dx = brushPos.x - cx;
            const dz = brushPos.z - cz;
            if (dx * dx + dz * dz < brushRadius * brushRadius) {
              hitSet.add(`${row},${col}`);
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
    const isNearAnyCourt = this.activeCourts.some(court => {
      const center = court.config.center;
      const dx = Math.abs(cartPos.x - center.x);
      const dz = Math.abs(cartPos.z - center.z);
      return dx < SIZES.courtWidth / 2 + 8 && dz < SIZES.courtDepth / 2 + 8;
    });

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
      const buffer = SIZES.clayCourtBuffer || 0;

      // Distance to baseline fences (pushed out by buffer for clay courts)
      const fenceNorthZ = center.z - halfD - buffer - 0.5;
      const fenceSouthZ = center.z + halfD + buffer + 0.5;
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

    this.proximityState = {
      nearestFenceDist: nearestFenceDist === Infinity ? null : nearestFenceDist,
      nearestNetDist: nearestNetDist === Infinity ? null : nearestNetDist,
      fenceStatus,
      netStatus,
    };

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
