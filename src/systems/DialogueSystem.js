import { GAME } from '../utils/Constants.js';

/**
 * DialogueSystem - manages NPC conversations and branching dialogue
 */
export class DialogueSystem {
  constructor(dialogueBox, missionData) {
    this.dialogueBox = dialogueBox;
    this.dialogues = missionData.dialogues || {};
    this.active = false;
    this.currentNPC = null;
    this.queue = [];
    this.queueIndex = 0;
    this.onComplete = null;
    this.onChoiceMade = null;
    this._choices = null;       // choices currently on screen (keyboard 1-9 selects)
    this._warnedKeys = new Set();
  }

  /** True while the choice buttons are showing (Space/Enter must not advance past them). */
  hasChoices() {
    return !!(this.active && this._choices && this._choices.length);
  }

  /**
   * Advance the current line (keyboard Space/Enter/E). Returns true if something advanced.
   * Goes through DialogueBox.advance() when it exists (e.g. to finish a typewriter effect),
   * else the same onAdvance hook a click uses.
   */
  advance() {
    if (!this.active) return false;
    const box = this.dialogueBox;
    if (typeof box.advance === 'function') {
      // The box finishes a typewriter line first and ignores presses while choices are up
      box.advance();
      return true;
    }
    if (this.hasChoices()) return false;
    if (typeof box.onAdvance === 'function') {
      box.onAdvance();
      return true;
    }
    return false;
  }

  /** Pick a visible choice by index (keyboard 1-9). */
  choose(index) {
    if (!this.hasChoices() || index < 0 || index >= this._choices.length) return false;
    const box = this.dialogueBox;
    // Choices are only revealed once the prompt finishes typing: the first digit
    // press completes the prompt (like Space) instead of committing an unseen choice.
    if (typeof box.isTyping === 'function' && box.isTyping()) {
      if (typeof box.advance === 'function') box.advance();
      return false;
    }
    if (typeof box.onChoice === 'function') {
      box.onChoice(index, this._choices[index]);
      return true;
    }
    return false;
  }

  isActive() {
    return this.active;
  }

  startDialogue(npc, lines, onComplete) {
    if (this.active) return;

    this.active = true;
    this._choices = null;
    this.currentNPC = npc;
    this.queue = lines;
    this.queueIndex = 0;
    this.onComplete = onComplete;

    if (npc && npc.startTalking) npc.startTalking();
    this._showNextLine();

    this.dialogueBox.onAdvance = () => {
      this._advance();
    };
  }

  startDialogueFromKey(npc, dialogueKey, onComplete) {
    const lines = this.dialogues[dialogueKey];
    if (!Array.isArray(lines) || lines.length === 0) {
      if (!this._warnedKeys.has(dialogueKey)) {
        this._warnedKeys.add(dialogueKey);
        console.warn(`Dialogue key "${dialogueKey}" not found in missions.json`);
      }
      // Still give the player feedback instead of silently skipping
      const name = npc && npc.name ? npc.name : '';
      this.startDialogue(npc, [{ speaker: name, text: 'Ah, thanks — I appreciate it.' }], onComplete);
      return;
    }
    this.startDialogue(npc, lines, onComplete);
  }

  showChoices(choices, onChoice) {
    this._choices = choices;
    this.dialogueBox.showChoices(choices);
    this.onChoiceMade = onChoice;
    this.dialogueBox.onChoice = (index, choice) => {
      this._choices = null;
      this.dialogueBox.hide();
      this.active = false;
      if (this.currentNPC) {
        this.currentNPC.stopTalking();
      }
      if (onChoice) onChoice(index, choice);
    };
  }

  showMessage(speaker, text, nameColor, onDismiss) {
    this.active = true;
    this._choices = null;
    this.dialogueBox.show(speaker, text, nameColor);
    this.dialogueBox.onAdvance = () => {
      this.dialogueBox.hide();
      this.active = false;
      if (onDismiss) onDismiss();
    };
  }

  _showNextLine() {
    if (this.queueIndex >= this.queue.length) {
      this._endDialogue();
      return;
    }

    const line = this.queue[this.queueIndex];
    const nameColor = this.currentNPC && this.currentNPC.data ?
      this.currentNPC.data.archetype === 'entitled' ? '#E74C3C' :
      this.currentNPC.data.archetype === 'friendly' ? '#27AE60' : '#3498DB'
      : '#fff';

    const speaker = line.speaker || (this.currentNPC ? this.currentNPC.name : '');
    this.dialogueBox.show(speaker, line.text, nameColor);
  }

  _advance() {
    this.queueIndex++;
    this._showNextLine();
  }

  _endDialogue() {
    this.dialogueBox.hide();
    this.active = false;
    this._choices = null;
    if (this.currentNPC) {
      this.currentNPC.stopTalking();
    }
    if (this.onComplete) {
      this.onComplete();
    }
    this.currentNPC = null;
    this.onComplete = null;
  }

  forceEnd() {
    if (!this.active) return;
    this.dialogueBox.hide();
    this.active = false;
    this._choices = null;
    if (this.currentNPC) {
      this.currentNPC.stopTalking();
    }
    this.currentNPC = null;
    this.onComplete = null;
  }
}
