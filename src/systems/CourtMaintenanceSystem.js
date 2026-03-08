import { GAME, SIZES } from '../utils/Constants.js';

/**
 * CourtMaintenanceSystem - manages clay court grooming minigame
 *
 * States:
 *   idle        - no grooming active, courts degrade over time
 *   tutorial    - step-by-step training walkthrough (first time only)
 *   grooming    - actively sweeping a court with the brush
 *   results     - showing score after finishing a groom session
 */
export class CourtMaintenanceSystem {
  constructor(courts, cart, dialogueSystem, soundSystem) {
    this.courts = courts;         // array of Court instances (only clay ones used)
    this.cart = cart;
    this.dialogueSystem = dialogueSystem;
    this.sound = soundSystem;

    this.clayCourts = courts.filter(c => c.isClay);

    // State
    this.state = 'idle';
    this.activeCourt = null;      // the Court being groomed
    this.groomStartCleanliness = 0;
    this.groomTimer = 0;
    this.groomCellsHit = new Set();

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
        text: "The key technique: drive in a SPIRAL pattern, starting from the OUTSIDE edges and working IN toward the center. This keeps clay from piling up at the fences.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "Go SLOW — under 5 units/sec. Too fast and you'll tear up the surface instead of smoothing it. You'll see a speed indicator while grooming.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "Watch the coverage meter on screen. Try to hit every spot on the court. The darker patches are the dirty areas that need attention.",
      },
      {
        speaker: 'Hank (Head Groundskeeper)',
        text: "One more thing — don't brush when it's raining! Wet clay turns to mud if you drag it. Alright, give it a shot! Drive onto the clay court to start grooming.",
      },
    ];

    // Degradation timer
    this.degradeTimer = GAME.courtDegradeInterval;

    // Scoring
    this.lastScore = null;

    // Brush scrape sound timer
    this.brushSoundTimer = 0;

    // Callbacks
    this.onGroomStart = null;
    this.onGroomEnd = null;
    this.onGroomUpdate = null;
    this.onTutorialStart = null;
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
   * Check if the player (in cart with brush) is near a clay court.
   * Returns the court if applicable, null otherwise.
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
   */
  startGrooming(court) {
    if (!this.tutorialCompleted) {
      this._startTutorial(court);
      return;
    }
    this._beginGrooming(court);
  }

  /**
   * Stop the current grooming session and show results.
   */
  stopGrooming() {
    if (this.state !== 'grooming' || !this.activeCourt) return;

    const cleanliness = this.activeCourt.getCleanliness();
    const totalCells = this.activeCourt.gridRows * this.activeCourt.gridCols;
    const coverage = this.groomCellsHit.size / totalCells;
    const improvement = cleanliness - this.groomStartCleanliness;

    let rating, message;
    if (cleanliness >= GAME.groomScoreThreshold && coverage >= 0.7) {
      rating = 'excellent';
      message = `Excellent work! Court is ${Math.round(cleanliness * 100)}% clean with ${Math.round(coverage * 100)}% coverage. Hank would be proud!`;
    } else if (cleanliness >= 0.6 && coverage >= 0.5) {
      rating = 'good';
      message = `Good job! Court is ${Math.round(cleanliness * 100)}% clean. A few spots could use another pass.`;
    } else {
      rating = 'needsWork';
      message = `Court is ${Math.round(cleanliness * 100)}% clean. You might want to make another pass — ${Math.round((1 - coverage) * 100)}% of the surface was missed.`;
    }

    this.lastScore = {
      courtId: this.activeCourt.id,
      cleanliness,
      coverage,
      improvement,
      rating,
      time: this.groomTimer,
    };

    this.state = 'results';
    this.activeCourt = null;
    this.groomCellsHit.clear();

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

  getActiveCourt() {
    return this.activeCourt;
  }

  getGroomingProgress() {
    if (!this.activeCourt) return null;
    const cleanliness = this.activeCourt.getCleanliness();
    const totalCells = this.activeCourt.gridRows * this.activeCourt.gridCols;
    const coverage = this.groomCellsHit.size / totalCells;
    return {
      cleanliness,
      coverage,
      time: this.groomTimer,
      speed: Math.abs(this.cart.currentSpeed),
      speedOk: Math.abs(this.cart.currentSpeed) <= GAME.groomSpeedLimit,
    };
  }

  _startTutorial(court) {
    this.state = 'tutorial';
    this.tutorialStep = 0;

    if (this.onTutorialStart) this.onTutorialStart();

    this._showTutorialStep(() => {
      this.tutorialCompleted = true;
      this._beginGrooming(court);
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

  _beginGrooming(court) {
    this.state = 'grooming';
    this.activeCourt = court;
    this.groomStartCleanliness = court.getCleanliness();
    this.groomTimer = 0;
    this.groomCellsHit.clear();
    this.brushSoundTimer = 0;

    if (this.onGroomStart) {
      this.onGroomStart(court);
    }
  }

  _updateGrooming(dt, weatherState) {
    if (!this.activeCourt || !this.cart.hasBrush) {
      this.stopGrooming();
      return;
    }

    this.groomTimer += dt;

    // Don't groom in rain
    if (weatherState === 'rainy') return;

    const brushPos = this.cart.getBrushWorldPosition();
    if (!brushPos) return;

    const speed = Math.abs(this.cart.currentSpeed);

    // Only groom when moving at reasonable speed
    if (speed < 0.3 || speed > GAME.groomSpeedPenalty) return;

    // Grooming effectiveness based on speed
    const brushRadius = GAME.groomBrushWidth / 2;
    const affected = this.activeCourt.groomAt(brushPos.x, brushPos.z, brushRadius);

    if (affected > 0) {
      // Track which cells were hit
      const center = this.activeCourt.config.center;
      const cellSize = GAME.groomCellSize;
      const w = SIZES.courtWidth;
      const d = SIZES.courtDepth;
      for (let row = 0; row < this.activeCourt.gridRows; row++) {
        for (let col = 0; col < this.activeCourt.gridCols; col++) {
          const cx = center.x - w / 2 + (col + 0.5) * cellSize;
          const cz = center.z - d / 2 + (row + 0.5) * cellSize;
          const dx = brushPos.x - cx;
          const dz = brushPos.z - cz;
          if (dx * dx + dz * dz < brushRadius * brushRadius) {
            this.groomCellsHit.add(`${row},${col}`);
          }
        }
      }

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

    // Check if cart left the court area
    const cartPos = this.cart.getPosition();
    const center = this.activeCourt.config.center;
    const dx = Math.abs(cartPos.x - center.x);
    const dz = Math.abs(cartPos.z - center.z);
    if (dx > SIZES.courtWidth / 2 + 6 || dz > SIZES.courtDepth / 2 + 6) {
      this.stopGrooming();
    }
  }
}
