import { GAME } from '../utils/Constants.js';
import { ITEMS } from './InventorySystem.js';

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

    this.onMissionUpdate = null;
    this.onRadioDispatch = null;
    this.npcsMap = new Map();
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

    // Check for random encounter NPCs nearby
    if (this.randomEncounterCooldown <= 0 && playerPos) {
      this._checkRandomEncounters(playerPos);
    }
  }

  _refreshTaskBoard() {
    const available = this.missionTemplates.filter(
      m => m.source === 'taskBoard' && !this.completedMissionIds.has(m.id) &&
           !this.activeMissions.find(a => a.id === m.id)
    );

    this.taskBoardMissions = [];
    const shuffled = available.sort(() => Math.random() - 0.5);
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
    const available = this.missionTemplates.filter(
      m => m.source === 'random' && !this.completedMissionIds.has(m.id) &&
           !this.activeMissions.find(a => a.id === m.id)
    );

    for (const mission of available) {
      if (mission.triggerNpc) {
        const npc = this.npcsMap.get(mission.triggerNpc);
        if (npc && npc.distanceTo(playerPos) < GAME.interactionRange * 3) {
          if (Math.random() < GAME.randomEncounterChance) {
            npc.setHasRequest(true);
            this.randomEncounterCooldown = 30;
            break;
          }
        }
      }
    }
  }

  _setupMissionNPCs(mission) {
    for (const step of mission.steps) {
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
           !this.completedMissionIds.has(m.id)
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
    }

    // Default: random greeting
    const greetings = npc.data.greetings;
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
}
