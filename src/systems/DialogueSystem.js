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
  }

  isActive() {
    return this.active;
  }

  startDialogue(npc, lines, onComplete) {
    if (this.active) return;

    this.active = true;
    this.currentNPC = npc;
    this.queue = lines;
    this.queueIndex = 0;
    this.onComplete = onComplete;

    npc.startTalking();
    this._showNextLine();

    this.dialogueBox.onAdvance = () => {
      this._advance();
    };
  }

  startDialogueFromKey(npc, dialogueKey, onComplete) {
    const lines = this.dialogues[dialogueKey];
    if (!lines) {
      console.warn(`Dialogue key "${dialogueKey}" not found`);
      if (onComplete) onComplete();
      return;
    }
    this.startDialogue(npc, lines, onComplete);
  }

  showChoices(choices, onChoice) {
    this.dialogueBox.showChoices(choices);
    this.onChoiceMade = onChoice;
    this.dialogueBox.onChoice = (index, choice) => {
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
    const nameColor = this.currentNPC ?
      this.currentNPC.data.archetype === 'entitled' ? '#E74C3C' :
      this.currentNPC.data.archetype === 'friendly' ? '#27AE60' : '#3498DB'
      : '#fff';

    this.dialogueBox.show(line.speaker || this.currentNPC.name, line.text, nameColor);
  }

  _advance() {
    this.queueIndex++;
    this._showNextLine();
  }

  _endDialogue() {
    this.dialogueBox.hide();
    this.active = false;
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
    if (this.currentNPC) {
      this.currentNPC.stopTalking();
    }
    this.currentNPC = null;
    this.onComplete = null;
  }
}
