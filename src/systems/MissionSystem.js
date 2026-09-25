import { GAME } from '../utils/Constants.js';
import { ITEMS } from './InventorySystem.js';
import { missionErrors } from './MissionValidation.js';

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
/** Retry delay (s) for a radio dispatch that found every task slot full. */
const RADIO_RETRY_WHEN_FULL = 20;

/**
 * MissionSystem — task board, radio dispatch (with On it / Busy), random encounters,
 * per-day repeatable missions and shift routines (opening checklist / closing duties).
 *
 * Only missions whose every step can be completed in this world are ever offered
 * (see MissionValidation.js, shared with `npm run validate`).
 *
 * Hooks (all optional):
 *   onMissionUpdate(activeMissions)      – list / step changed
 *   onRadioDispatch(mission)             – a dispatch card should appear (answer with acceptDispatch / declineDispatch)
 *   onDispatchClosed(mission, accepted)  – the card should go away (answered or timed out)
 *   onMissionComplete(mission)           – fired once per completion; mission.reactions = { npcId: mood }
 *   onReaction(npcId, mood)              – each NPC reaction to a choice
 */
export class MissionSystem {
  constructor(missionData, dialogueSystem, inventorySystem) {
    this.missionTemplates = missionData.missions || [];
    this.taskTypes = missionData.taskTypes || {};
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

    /** Radio dispatch only runs while this is true (the shift turns it on at clock-in). */
    this.dispatchEnabled = true;
    /** Radio timer speed multiplier (rush windows > 1). */
    this.dispatchRate = 1;
    /** The mission on the dispatch card, waiting for On it / Busy. */
    this.pendingDispatch = null;
    this.pendingDispatchTimer = 0;
    /** NPC ids with an offered (not yet started) random encounter. */
    this.pendingEncounters = new Set();

    this.onMissionUpdate = null;
    this.onRadioDispatch = null;
    this.onDispatchClosed = null;
    this.onMissionComplete = null;
    this.onReaction = null;

    this.npcsMap = new Map();
    this._templatesById = new Map();
    for (const m of this.missionTemplates) {
      if (m && m.id) this._templatesById.set(m.id, m);
    }

    // World facts (set by Game once the map/NPCs exist) → completability + marker points
    this._facts = {};
    this._targetPoints = new Map(); // area id → { x, z, h }
    this._completable = new Map();  // mission id → bool (cached)
    this.uncompletableIds = [];
  }

  // ───────────────────────────── world facts ─────────────────────────────

  /**
   * facts: from MissionValidation.buildWorldFacts; targetPoints: Map(areaId → {x, z, h})
   * used for minimap pins and floating world markers.
   */
  setWorldFacts(facts, targetPoints) {
    this._facts = facts || {};
    if (targetPoints) this._targetPoints = targetPoints;
    this._completable.clear();
    this.uncompletableIds = this.missionTemplates.filter(m => !this.isCompletable(m)).map(m => m.id);
    // Drop anything already offered that turned out to be dead
    this.taskBoardMissions = this.taskBoardMissions.filter(m => this.isCompletable(m));
  }

  /** True when every step of the mission can be completed in this world (cached). */
  isCompletable(tpl) {
    if (!tpl || !tpl.id) return false;
    let ok = this._completable.get(tpl.id);
    if (ok === undefined) {
      const facts = this._facts;
      ok = missionErrors(tpl, facts).length === 0;
      this._completable.set(tpl.id, ok);
    }
    return ok;
  }

  /** Static world point for an area id ({x, z, h}), or null. */
  getAreaPoint(id) {
    return (id && this._targetPoints.get(id)) || null;
  }

  /**
   * Where the current step of `mission` happens: a static point ({x, z, h}) for goTo /
   * pickup / deliver / groom, else null (dialogue steps point at an NPC: getStepNpcId).
   */
  getStepTargetPoint(step) {
    if (!step) return null;
    switch (step.action) {
      case 'goTo': return this.getAreaPoint(step.target || step.location);
      case 'pickup':
      case 'deliver': return this.getAreaPoint(step.location);
      case 'groom': return this.getAreaPoint(step.target);
      default: return null;
    }
  }

  /** NPC the player must talk to for this mission's current step (dialogue / pending choice), or null. */
  getStepNpcId(mission) {
    const step = mission && mission.steps ? mission.steps[mission.currentStep] : null;
    if (!step) return null;
    if (step.action === 'dialogue') return step.npcId || null;
    if (step.action === 'choose') {
      const prev = mission.steps[mission.currentStep - 1];
      return prev && prev.npcId ? prev.npcId : null;
    }
    return null;
  }

  // ───────────────────────────── bookkeeping ─────────────────────────────

  _isActive(id) {
    for (let i = 0; i < this.activeMissions.length; i++) {
      if (this.activeMissions[i].id === id) return true;
    }
    return false;
  }

  /** Active missions that count toward GAME.maxActiveMissions (shift routines don't). */
  regularActiveCount() {
    let n = 0;
    for (let i = 0; i < this.activeMissions.length; i++) if (this.activeMissions[i].source !== 'shift') n++;
    return n;
  }

  hasFreeSlot() {
    return this.regularActiveCount() < GAME.maxActiveMissions;
  }

  _isOfferable(m, source) {
    return m && m.source === source && !this.completedMissionIds.has(m.id) && !this._isActive(m.id) &&
      this.isCompletable(m);
  }

  _notifyUpdate() {
    this.refreshNPCMarkers();
    if (this.onMissionUpdate) this.onMissionUpdate(this.activeMissions);
  }

  registerNPCs(npcs) {
    this.npcsMap.clear();
    for (const npc of npcs) {
      this.npcsMap.set(npc.id, npc);
    }
    this.refreshNPCMarkers();
  }

  /**
   * The "!" marker goes only on NPCs the player needs right now: the NPC of each active
   * mission's CURRENT step, and NPCs with an offered random encounter.
   */
  refreshNPCMarkers() {
    for (const npc of this.npcsMap.values()) {
      let want = this.pendingEncounters.has(npc.id);
      if (!want) {
        for (let i = 0; i < this.activeMissions.length; i++) {
          if (this.getStepNpcId(this.activeMissions[i]) === npc.id) { want = true; break; }
        }
      }
      if (!!npc.hasRequest !== want && typeof npc.setHasRequest === 'function') npc.setHasRequest(want);
    }
  }

  update(dt, playerPos) {
    // Task board refresh
    this.taskBoardTimer -= dt;
    if (this.taskBoardTimer <= 0) {
      this.taskBoardTimer = GAME.taskBoardRefreshInterval;
      this._refreshTaskBoard();
    }

    // Unanswered dispatch card → counts as "Busy" (no penalty)
    if (this.pendingDispatch) {
      this.pendingDispatchTimer -= dt;
      if (this.pendingDispatchTimer <= 0) this.declineDispatch('timeout');
    } else if (this.dispatchEnabled) {
      // Radio dispatch (faster during rush windows)
      this.radioTimer -= dt * this.dispatchRate;
      if (this.radioTimer <= 0) {
        this.radioTimer = GAME.radioDispatchInterval;
        this._dispatchRadio();
      }
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
    const available = this.missionTemplates.filter(m => this._isOfferable(m, 'taskBoard'));
    this.taskBoardMissions = [];
    const shuffled = shuffleInPlace(available);
    for (let i = 0; i < Math.min(3, shuffled.length); i++) {
      this.taskBoardMissions.push(shuffled[i]);
    }
  }

  // ───────────────────────────── radio dispatch ─────────────────────────────

  /** Offer a radio mission on the dispatch card (it only becomes active on "On it"). */
  _dispatchRadio() {
    if (this.pendingDispatch) return;
    if (!this.hasFreeSlot()) {
      this.radioTimer = RADIO_RETRY_WHEN_FULL;
      return;
    }
    const available = this.missionTemplates.filter(m => this._isOfferable(m, 'radio'));
    if (available.length === 0) return;
    const mission = available[Math.floor(Math.random() * available.length)];
    this.pendingDispatch = mission;
    this.pendingDispatchTimer = GAME.dispatchCardTimeout ?? 25;
    if (this.onRadioDispatch) this.onRadioDispatch(mission);
  }

  /** Force a dispatch now (debug / tests). Returns the offered mission or null. */
  dispatchNow() {
    this._dispatchRadio();
    return this.pendingDispatch;
  }

  /** "On it": the dispatched mission becomes active. Returns it, or null. */
  acceptDispatch() {
    const tpl = this.pendingDispatch;
    if (!tpl) return null;
    this.pendingDispatch = null;
    let active = null;
    if (this.hasFreeSlot() && !this._isActive(tpl.id)) {
      active = { ...tpl, currentStep: 0, status: 'active' };
      this.activeMissions.push(active);
      this._notifyUpdate();
    }
    if (this.onDispatchClosed) this.onDispatchClosed(tpl, !!active);
    return active;
  }

  /** "Busy" (or the card timed out): no penalty, the mission stays in the pool. */
  declineDispatch(reason = 'busy') {
    const tpl = this.pendingDispatch;
    if (!tpl) return;
    this.pendingDispatch = null;
    this.radioTimer = Math.min(this.radioTimer, GAME.dispatchDeclineCooldown ?? 30);
    if (this.onDispatchClosed) this.onDispatchClosed(tpl, false, reason);
  }

  // ───────────────────────────── random encounters ─────────────────────────────

  _checkRandomEncounters(playerPos) {
    // Per-check probability equivalent to the old per-frame chance over one interval at 60 fps
    const p = 1 - Math.pow(1 - GAME.randomEncounterChance, 60 * RANDOM_ENCOUNTER_CHECK_INTERVAL);
    for (let i = 0; i < this.missionTemplates.length; i++) {
      const mission = this.missionTemplates[i];
      if (!this._isOfferable(mission, 'random') || !mission.triggerNpc) continue;
      if (this.pendingEncounters.has(mission.triggerNpc)) continue;
      const npc = this.npcsMap.get(mission.triggerNpc);
      if (npc && !npc.hasRequest && npc.distanceTo(playerPos) < GAME.interactionRange * 3) {
        if (Math.random() < p) {
          this.offerEncounter(mission.triggerNpc);
          this.randomEncounterCooldown = 30;
          break;
        }
      }
    }
  }

  /** Give an NPC a pending random-encounter request ("!"), if they have an offerable one. */
  offerEncounter(npcId) {
    const has = this.missionTemplates.some(m => this._isOfferable(m, 'random') && m.triggerNpc === npcId);
    if (!has) return false;
    this.pendingEncounters.add(npcId);
    this.refreshNPCMarkers();
    return true;
  }

  getTaskBoardMissions() {
    return this.taskBoardMissions;
  }

  getActiveMissions() {
    return this.activeMissions;
  }

  acceptTaskBoardMission(mission) {
    if (!this.hasFreeSlot() || !mission || this._isActive(mission.id)) return false;

    const active = {
      ...mission,
      currentStep: 0,
      status: 'active',
    };
    this.activeMissions.push(active);
    this.taskBoardMissions = this.taskBoardMissions.filter(m => m.id !== mission.id);
    this._notifyUpdate();
    return true;
  }

  acceptRandomEncounter(npcId) {
    const mission = this.missionTemplates.find(m => this._isOfferable(m, 'random') && m.triggerNpc === npcId);
    if (mission && this.hasFreeSlot()) {
      const active = {
        ...mission,
        currentStep: 0,
        status: 'active',
      };
      this.activeMissions.push(active);
      this._notifyUpdate();
      return active;
    }
    return null;
  }

  // ───────────────────────────── shift routines / days ─────────────────────────────

  /**
   * Start a shift routine (source 'shift': opening checklist, closing duties). These don't
   * use a task slot. Returns the active mission, or null (unknown / dead / already active).
   */
  startShiftMission(id) {
    const tpl = this._templatesById.get(id);
    if (!tpl || this._isActive(id) || !this.isCompletable(tpl)) return null;
    const active = { ...tpl, currentStep: 0, status: 'active' };
    this.activeMissions.push(active);
    this._notifyUpdate();
    return active;
  }

  /** Remove unfinished shift routines (end of the day). Returns the ids removed. */
  clearShiftMissions() {
    const removed = [];
    this.activeMissions = this.activeMissions.filter(m => {
      if (m.source !== 'shift') return true;
      removed.push(m.id);
      return false;
    });
    if (removed.length) this._notifyUpdate();
    return removed;
  }

  /** A new day: repeatable missions can be offered again; fresh board and radio. */
  newDay() {
    for (const m of this.missionTemplates) {
      if (m && (m.repeatable || m.source === 'shift')) this.completedMissionIds.delete(m.id);
    }
    if (this.pendingDispatch) this.declineDispatch('newDay');
    this.pendingEncounters.clear();
    this._refreshTaskBoard();
    this.taskBoardTimer = GAME.taskBoardRefreshInterval;
    this.radioTimer = GAME.radioDispatchInterval;
    this._notifyUpdate();
  }

  // ───────────────────────────── steps ─────────────────────────────

  advanceMissionStep(missionId) {
    const mission = this.activeMissions.find(m => m.id === missionId);
    if (!mission) return null;

    mission.currentStep++;

    if (mission.currentStep >= mission.steps.length) {
      return this.completeMission(missionId);
    }

    this._notifyUpdate();
    return mission.steps[mission.currentStep];
  }

  /**
   * Player entered an area: complete any active `goTo` step targeting it.
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
      mission.status = 'complete';
      if (!mission.reactions) mission.reactions = {};
      // Shift routines come back every day; everything else is one-shot until the next day
      // (repeatable) or forever.
      if (mission.source !== 'shift') this.completedMissionIds.add(missionId);

      this._notifyUpdate();
      if (this.onMissionComplete) {
        try { this.onMissionComplete(mission); } catch (e) { console.error('onMissionComplete failed:', e); }
      }
      return mission;
    }
    return null;
  }

  /** Base pay for a mission (taskTypes[type].baseReward). */
  getBaseReward(mission) {
    const t = mission && this.taskTypes[mission.type];
    return t && Number.isFinite(t.baseReward) ? t.baseReward : 0;
  }

  // ───────────────────────────── talking ─────────────────────────────

  handleInteraction(npc, playerPos, onComplete) {
    // 1. This NPC is needed by an active mission's CURRENT step
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (!step) continue;
      if (step.action === 'dialogue' && step.npcId === npc.id) {
        this._runDialogueStep(mission, npc, onComplete);
        return true;
      }
      // Choices pending but not on screen (e.g. restored state): talking to the
      // NPC from the preceding dialogue step re-opens them.
      if (step.action === 'choose' && !this.dialogueSystem.isActive()) {
        const prev = mission.steps[mission.currentStep - 1];
        if (prev && prev.npcId === npc.id) {
          this._showChoices(mission, step, onComplete);
          return true;
        }
      }
    }

    // 2. An offered random encounter: start it and play its first step right away
    //    (the step is advanced afterwards, so the conversation never plays twice)
    if (this.pendingEncounters.has(npc.id)) {
      const mission = this.acceptRandomEncounter(npc.id);
      if (mission) {
        this.pendingEncounters.delete(npc.id);
        this.refreshNPCMarkers();
        const step = this.getCurrentStep(mission.id);
        if (step && step.action === 'dialogue' && step.npcId === npc.id) {
          this._runDialogueStep(mission, npc, onComplete);
        } else {
          const text = (step && step.prompt) || mission.description || 'Could you help me with something?';
          this.dialogueSystem.startDialogue(npc, [{ speaker: npc.name, text }], onComplete);
        }
        return true;
      }
      if (!this.hasFreeSlot()) {
        // Keep the request open for later — no fail states
        this.dialogueSystem.startDialogue(npc, [{ speaker: npc.name, text: "Oh, you look swamped. Come find me when you've got a minute!" }], onComplete);
        return true;
      }
      this.pendingEncounters.delete(npc.id);
      this.refreshNPCMarkers();
    }

    // 3. Small talk: a greeting, or a line matching how they feel about you
    const data = npc.data || {};
    const pool = data.dialoguePool || {};
    let lines = Array.isArray(data.greetings) && data.greetings.length ? data.greetings : ['Hello there!'];
    const moodLines = pool[npc.mood];
    if (Array.isArray(moodLines) && moodLines.length && Math.random() < 0.5) lines = moodLines;
    else if (Array.isArray(pool.idle) && pool.idle.length && Math.random() < 0.3) lines = pool.idle;
    const text = lines[Math.floor(Math.random() * lines.length)];
    this.dialogueSystem.startDialogue(npc, [{ speaker: npc.name, text }], onComplete);
    return true;
  }

  /** Play a dialogue step, then advance; open the choices if the next step is `choose`. */
  _runDialogueStep(mission, npc, onComplete) {
    this._executeMissionStep(mission, npc, () => {
      this.advanceMissionStep(mission.id);
      const nextStep = this.getCurrentStep(mission.id);
      if (nextStep && nextStep.action === 'choose') {
        this._showChoices(mission, nextStep, onComplete);
      } else if (onComplete) {
        onComplete();
      }
    });
  }

  _executeMissionStep(mission, npc, onComplete) {
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
          if (!mission.reactions) mission.reactions = {};
          for (const [npcId, mood] of Object.entries(choice.reactions)) {
            mission.reactions[npcId] = mood;
            const npc = this.npcsMap.get(npcId);
            if (this.onReaction) {
              try { this.onReaction(npcId, mood); } catch (e) { /* ignore */ }
            }
            if (npc) {
              npc.mood = mood;
              const emoji = mood === 'satisfied' ? '😊' :
                           mood === 'unsatisfied' ? '😤' : '🤷';
              npc.showReaction(emoji);
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
   * Restore progress. Unknown or uncompletable mission ids are dropped, step indices are
   * clamped, and NPC request markers are re-applied for the current steps.
   */
  setState(state) {
    if (!state || typeof state !== 'object') return;
    const known = this._templatesById;

    this.completedMissionIds = new Set();
    if (Array.isArray(state.completed)) {
      for (const id of state.completed) {
        const tpl = known.get(id);
        if (tpl && tpl.source !== 'shift') this.completedMissionIds.add(id);
      }
    }

    this.activeMissions = [];
    this.pendingDispatch = null;
    if (Array.isArray(state.active)) {
      for (const a of state.active) {
        if (!a) continue;
        const tpl = known.get(a.id);
        if (!tpl || this.completedMissionIds.has(tpl.id) || this._isActive(tpl.id) || !this.isCompletable(tpl)) continue;
        if (tpl.source !== 'shift' && !this.hasFreeSlot()) continue;
        const steps = tpl.steps || [];
        let step = Number.isInteger(a.step) ? a.step : 0;
        step = Math.max(0, Math.min(step, Math.max(0, steps.length - 1)));
        step = this._rewindChoose(steps, step);
        this.activeMissions.push({ ...tpl, currentStep: step, status: 'active' });
      }
    }

    this.taskBoardMissions = [];
    if (Array.isArray(state.taskBoard)) {
      for (const id of state.taskBoard) {
        const tpl = known.get(id);
        if (this._isOfferable(tpl, 'taskBoard') && this.taskBoardMissions.length < 3 && !this.taskBoardMissions.includes(tpl)) {
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

    this._notifyUpdate();
  }
}
