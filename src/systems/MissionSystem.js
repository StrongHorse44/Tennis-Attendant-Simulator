import { GAME } from '../utils/Constants.js';
import { ITEMS } from './InventorySystem.js';

/** Unbiased in-place Fisher-Yates shuffle. */
export function shuffleInPlace(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** How often (s) nearby random-encounter NPCs are checked (was every frame). */
const RANDOM_ENCOUNTER_CHECK_INTERVAL = 0.5;

/**
 * MissionSystem - task board, radio dispatch, random encounters
 */
export class MissionSystem {
  constructor(missionData, dialogueSystem, inventorySystem) {
    this.missionTemplates = missionData.missions || [];
    this.dialogueSystem = dialogueSystem;
    this.inventory = inventorySystem;
    this.dialogues = missionData.dialogues || {};

    this.activeMissions = [];
    this.completedMissionIds = new Set();
    this.taskBoardMissions = [];
    this.taskBoardTimer = 5; // populate quickly at start
    this.radioTimer = GAME.radioDispatchInterval;
    this.randomEncounterCooldown = 0;

    this.randomEncounterCheckTimer = 0;

    this.onMissionUpdate = null;
    this.onRadioDispatch = null;
    /** (mission) => void — fired once whenever a mission completes (any path). */
    this.onMissionComplete = null;
    /** (npcId, mood) => void — fired for each NPC reaction to a choice. */
    this.onReaction = null;
    this.npcsMap = new Map();
    this._templatesById = new Map();
    for (const m of this.missionTemplates) {
      if (m && m.id) this._templatesById.set(m.id, m);
    }
  }

  _isActive(id) {
    for (let i = 0; i < this.activeMissions.length; i++) {
      if (this.activeMissions[i].id === id) return true;
    }
    return false;
  }

  registerNPCs(npcs) {
    this.npcsMap.clear();
    for (const npc of npcs) {
      this.npcsMap.set(npc.id, npc);
    }
  }

  update(dt, playerPos) {
    // Task board refresh
    this.taskBoardTimer -= dt;
    if (this.taskBoardTimer <= 0) {
      this.taskBoardTimer = GAME.taskBoardRefreshInterval;
      this._refreshTaskBoard();
    }

    // Radio dispatch
    this.radioTimer -= dt;
    if (this.radioTimer <= 0) {
      this.radioTimer = GAME.radioDispatchInterval;
      this._dispatchRadio();
    }

    // Random encounters
    if (this.randomEncounterCooldown > 0) {
      this.randomEncounterCooldown -= dt;
    }

    // Check for random encounter NPCs nearby (throttled; the chance is scaled so the
    // encounter rate matches the old per-frame check at ~60 fps)
    this.randomEncounterCheckTimer -= dt;
    if (this.randomEncounterCooldown <= 0 && playerPos && this.randomEncounterCheckTimer <= 0) {
      this.randomEncounterCheckTimer = RANDOM_ENCOUNTER_CHECK_INTERVAL;
      this._checkRandomEncounters(playerPos);
    }
  }

  _refreshTaskBoard() {
    const available = this.missionTemplates.filter(
      m => m.source === 'taskBoard' && !this.completedMissionIds.has(m.id) &&
           !this.activeMissions.find(a => a.id === m.id)
    );

    this.taskBoardMissions = [];
    const shuffled = shuffleInPlace(available);
    for (let i = 0; i < Math.min(3, shuffled.length); i++) {
      this.taskBoardMissions.push(shuffled[i]);
    }
  }

  _dispatchRadio() {
    if (this.activeMissions.length >= GAME.maxActiveMissions) return;

    const available = this.missionTemplates.filter(
      m => m.source === 'radio' && !this.completedMissionIds.has(m.id) &&
           !this.activeMissions.find(a => a.id === m.id)
    );

    if (available.length > 0) {
      const mission = available[Math.floor(Math.random() * available.length)];
      this.activeMissions.push({
        ...mission,
        currentStep: 0,
        status: 'active',
      });
      if (this.onRadioDispatch) {
        this.onRadioDispatch(mission);
      }
      if (this.onMissionUpdate) {
        this.onMissionUpdate(this.activeMissions);
      }

      // Set up NPC exclamation if relevant
      this._setupMissionNPCs(mission);
    }
  }

  _checkRandomEncounters(playerPos) {
    // Per-check probability equivalent to the old per-frame chance over one interval at 60 fps
    const p = 1 - Math.pow(1 - GAME.randomEncounterChance, 60 * RANDOM_ENCOUNTER_CHECK_INTERVAL);
    for (let i = 0; i < this.missionTemplates.length; i++) {
      const mission = this.missionTemplates[i];
      if (mission.source !== 'random' || this.completedMissionIds.has(mission.id) || this._isActive(mission.id)) continue;
      if (mission.triggerNpc) {
        const npc = this.npcsMap.get(mission.triggerNpc);
        if (npc && !npc.hasRequest && npc.distanceTo(playerPos) < GAME.interactionRange * 3) {
          if (Math.random() < p) {
            npc.setHasRequest(true);
            this.randomEncounterCooldown = 30;
            break;
          }
        }
      }
    }
  }

  _setupMissionNPCs(mission, fromStep = 0) {
    const steps = mission.steps || [];
    for (let i = fromStep; i < steps.length; i++) {
      const step = steps[i];
      if (step.npcId) {
        const npc = this.npcsMap.get(step.npcId);
        if (npc) {
          npc.setHasRequest(true);
        }
      }
    }
  }

  getTaskBoardMissions() {
    return this.taskBoardMissions;
  }

  getActiveMissions() {
    return this.activeMissions;
  }

  acceptTaskBoardMission(mission) {
    if (this.activeMissions.length >= GAME.maxActiveMissions) return false;

    const active = {
      ...mission,
      currentStep: 0,
      status: 'active',
    };
    this.activeMissions.push(active);
    this.taskBoardMissions = this.taskBoardMissions.filter(m => m.id !== mission.id);

    this._setupMissionNPCs(mission);

    if (this.onMissionUpdate) {
      this.onMissionUpdate(this.activeMissions);
    }
    return true;
  }

  acceptRandomEncounter(npcId) {
    const mission = this.missionTemplates.find(
      m => m.source === 'random' && m.triggerNpc === npcId &&
           !this.completedMissionIds.has(m.id) && !this._isActive(m.id)
    );

    if (mission && this.activeMissions.length < GAME.maxActiveMissions) {
      const active = {
        ...mission,
        currentStep: 0,
        status: 'active',
      };
      this.activeMissions.push(active);

      if (this.onMissionUpdate) {
        this.onMissionUpdate(this.activeMissions);
      }
      return active;
    }
    return null;
  }

  advanceMissionStep(missionId) {
    const mission = this.activeMissions.find(m => m.id === missionId);
    if (!mission) return null;

    mission.currentStep++;

    if (mission.currentStep >= mission.steps.length) {
      return this.completeMission(missionId);
    }

    if (this.onMissionUpdate) {
      this.onMissionUpdate(this.activeMissions);
    }
    return mission.steps[mission.currentStep];
  }

  /**
   * Player entered an area: complete any active `goTo` step targeting it.
   * (goTo steps were previously never completed, stalling those missions.)
   * Returns the advanced mission or null. Allocation-free; safe to call every frame.
   */
  handleArrival(areaId) {
    if (!areaId) return null;
    for (let i = 0; i < this.activeMissions.length; i++) {
      const m = this.activeMissions[i];
      const step = m.steps[m.currentStep];
      if (step && step.action === 'goTo' && (step.target === areaId || step.location === areaId)) {
        this.advanceMissionStep(m.id);
        return m;
      }
    }
    return null;
  }

  getCurrentStep(missionId) {
    const mission = this.activeMissions.find(m => m.id === missionId);
    if (!mission || mission.currentStep >= mission.steps.length) return null;
    return mission.steps[mission.currentStep];
  }

  completeMission(missionId) {
    const idx = this.activeMissions.findIndex(m => m.id === missionId);
    if (idx >= 0) {
      const mission = this.activeMissions[idx];
      this.activeMissions.splice(idx, 1);
      this.completedMissionIds.add(missionId);

      if (this.onMissionUpdate) {
        this.onMissionUpdate(this.activeMissions);
      }
      if (this.onMissionComplete) {
        try { this.onMissionComplete(mission); } catch (e) { console.error('onMissionComplete failed:', e); }
      }
      return mission;
    }
    return null;
  }

  handleInteraction(npc, playerPos, onComplete) {
    // Check if NPC has a request (random encounter)
    if (npc.hasRequest) {
      npc.setHasRequest(false);

      // Try to start a random encounter mission
      const mission = this.acceptRandomEncounter(npc.id);
      if (mission) {
        this._executeMissionStep(mission, npc, playerPos, onComplete);
        return true;
      }
    }

    // Check if NPC is part of an active mission
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (step && step.npcId === npc.id && step.action === 'dialogue') {
        this._executeMissionStep(mission, npc, playerPos, () => {
          this.advanceMissionStep(mission.id);
          const nextStep = this.getCurrentStep(mission.id);
          if (nextStep && nextStep.action === 'choose') {
            this._showChoices(mission, nextStep, onComplete);
          } else if (onComplete) {
            onComplete();
          }
        });
        return true;
      }
      // Choices pending but not on screen (e.g. restored state): talking to the
      // NPC from the preceding dialogue step re-opens them.
      if (step && step.action === 'choose' && !this.dialogueSystem.isActive()) {
        const prev = mission.steps[mission.currentStep - 1];
        if (prev && prev.npcId === npc.id) {
          this._showChoices(mission, step, onComplete);
          return true;
        }
      }
    }

    // Default: random greeting
    const greetings = (npc.data && Array.isArray(npc.data.greetings) && npc.data.greetings.length)
      ? npc.data.greetings : ['Hello there!'];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    this.dialogueSystem.startDialogue(npc, [{ speaker: npc.name, text: greeting }], onComplete);
    return true;
  }

  _executeMissionStep(mission, npc, playerPos, onComplete) {
    const step = this.getCurrentStep(mission.id);
    if (!step) return;

    if (step.action === 'dialogue' && step.dialogueKey) {
      this.dialogueSystem.startDialogueFromKey(npc, step.dialogueKey, onComplete);
    } else if (step.action === 'dialogue') {
      const lines = [{ speaker: npc.name, text: step.prompt }];
      this.dialogueSystem.startDialogue(npc, lines, onComplete);
    }
  }

  _showChoices(mission, step, onComplete) {
    this.dialogueSystem.dialogueBox.show('', step.prompt);
    this.dialogueSystem.active = true;

    this.dialogueSystem.showChoices(step.choices, (index, choice) => {
      // Show result
      this.dialogueSystem.showMessage('', choice.result, '#fff', () => {
        // Apply reactions
        if (choice.reactions) {
          for (const [npcId, mood] of Object.entries(choice.reactions)) {
            const npc = this.npcsMap.get(npcId);
            if (this.onReaction) {
              try { this.onReaction(npcId, mood); } catch (e) { /* ignore */ }
            }
            if (npc) {
              npc.mood = mood;
              const emoji = mood === 'satisfied' ? '\uD83D\uDE0A' :
                           mood === 'unsatisfied' ? '\uD83D\uDE24' : '\uD83E\uDD37';
              npc.showReaction(emoji);
              npc.setHasRequest(false);
            }
          }
        }

        this.completeMission(mission.id);
        if (onComplete) onComplete();
      });
    });
  }

  handlePickup(location, playerPos) {
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (step && step.action === 'pickup' && step.location === location) {
        const item = ITEMS[step.item];
        if (item && this.inventory.canPickup()) {
          this.inventory.pickup({ ...item });
          this.advanceMissionStep(mission.id);
          return item;
        }
      }
    }
    return null;
  }

  handleDelivery(location) {
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (step && step.action === 'deliver' && step.location === location) {
        const item = ITEMS[step.item];
        if (item && this.inventory.hasItem(item.id)) {
          this.inventory.removeItem(item.id);
          this.advanceMissionStep(mission.id);
          return { mission, item };
        }
      }
    }
    return null;
  }

  // ───────────────────────────── save / load ─────────────────────────────

  /** Step index to resume from: rewinds past 'choose' steps to the preceding step. */
  _rewindChoose(steps, step) {
    while (step > 0 && steps && steps[step] && steps[step].action === 'choose') step--;
    return step;
  }

  /** Serializable mission progress. */
  getState() {
    return {
      // A 'choose' step is persisted as the dialogue step leading into it, so a
      // reload replays that conversation and the advance-then-choose path shows
      // the choices again (otherwise nothing could ever re-open them).
      active: this.activeMissions.map(m => ({ id: m.id, step: this._rewindChoose(m.steps, m.currentStep) })),
      completed: [...this.completedMissionIds],
      taskBoard: this.taskBoardMissions.map(m => m.id),
      radioTimer: this.radioTimer,
      taskBoardTimer: this.taskBoardTimer,
    };
  }

  /**
   * Restore progress. Unknown mission ids are dropped, step indices are clamped,
   * and NPC request markers are re-applied for the remaining steps.
   */
  setState(state) {
    if (!state || typeof state !== 'object') return;
    const known = this._templatesById;

    this.completedMissionIds = new Set();
    if (Array.isArray(state.completed)) {
      for (const id of state.completed) if (known.has(id)) this.completedMissionIds.add(id);
    }

    this.activeMissions = [];
    if (Array.isArray(state.active)) {
      for (const a of state.active) {
        if (!a || this.activeMissions.length >= GAME.maxActiveMissions) continue;
        const tpl = known.get(a.id);
        if (!tpl || this.completedMissionIds.has(tpl.id) || this._isActive(tpl.id)) continue;
        const steps = tpl.steps || [];
        let step = Number.isInteger(a.step) ? a.step : 0;
        step = Math.max(0, Math.min(step, Math.max(0, steps.length - 1)));
        step = this._rewindChoose(steps, step);
        const mission = { ...tpl, currentStep: step, status: 'active' };
        this.activeMissions.push(mission);
        this._setupMissionNPCs(mission, step);
      }
    }

    this.taskBoardMissions = [];
    if (Array.isArray(state.taskBoard)) {
      for (const id of state.taskBoard) {
        const tpl = known.get(id);
        if (tpl && tpl.source === 'taskBoard' && !this.completedMissionIds.has(id) && !this._isActive(id) &&
            this.taskBoardMissions.length < 3 && !this.taskBoardMissions.includes(tpl)) {
          this.taskBoardMissions.push(tpl);
        }
      }
    }
    if (Number.isFinite(state.radioTimer)) {
      this.radioTimer = Math.max(5, Math.min(GAME.radioDispatchInterval, state.radioTimer));
    }
    if (Number.isFinite(state.taskBoardTimer)) {
      this.taskBoardTimer = Math.max(1, Math.min(GAME.taskBoardRefreshInterval, state.taskBoardTimer));
    }
    if (this.taskBoardMissions.length === 0) this.taskBoardTimer = Math.min(this.taskBoardTimer, 5);

    if (this.onMissionUpdate) this.onMissionUpdate(this.activeMissions);
  }
}
