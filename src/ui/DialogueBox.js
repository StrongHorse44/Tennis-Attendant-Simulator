/**
 * DialogueBox - bottom-center overlay for NPC dialogue
 */
export class DialogueBox {
  constructor() {
    this.container = null;
    this.nameEl = null;
    this.textEl = null;
    this.choicesEl = null;
    this.advanceHint = null;
    this.visible = false;
    this.onAdvance = null;
    this.onChoice = null;

    this._create();
  }

  _create() {
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      position: 'fixed',
      bottom: '160px',
      left: '50%',
      transform: 'translateX(-50%)',
      width: 'min(90vw, 500px)',
      background: 'rgba(20, 20, 20, 0.9)',
      borderRadius: '12px',
      padding: '16px 20px',
      color: '#fff',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      fontSize: '15px',
      lineHeight: '1.5',
      zIndex: '200',
      display: 'none',
      backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255,255,255,0.1)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    });

    this.nameEl = document.createElement('div');
    Object.assign(this.nameEl.style, {
      fontWeight: 'bold',
      fontSize: '13px',
      marginBottom: '6px',
      textTransform: 'uppercase',
      letterSpacing: '1px',
    });

    this.textEl = document.createElement('div');
    Object.assign(this.textEl.style, {
      marginBottom: '8px',
    });

    this.choicesEl = document.createElement('div');
    Object.assign(this.choicesEl.style, {
      display: 'none',
      flexDirection: 'column',
      gap: '6px',
      marginTop: '10px',
    });

    this.advanceHint = document.createElement('div');
    Object.assign(this.advanceHint.style, {
      fontSize: '11px',
      color: 'rgba(255,255,255,0.4)',
      textAlign: 'right',
      marginTop: '4px',
    });
    this.advanceHint.textContent = 'Tap to continue';

    this.container.appendChild(this.nameEl);
    this.container.appendChild(this.textEl);
    this.container.appendChild(this.choicesEl);
    this.container.appendChild(this.advanceHint);
    document.getElementById('ui-root').appendChild(this.container);

    // Tap to advance
    this.container.addEventListener('click', (e) => {
      if (e.target.classList.contains('dialogue-choice')) return;
      if (this.onAdvance) this.onAdvance();
    });
    this.container.addEventListener('touchend', (e) => {
      if (e.target.classList.contains('dialogue-choice')) return;
      e.preventDefault();
      if (this.onAdvance) this.onAdvance();
    });
  }

  show(speakerName, text, nameColor = '#fff') {
    this.nameEl.textContent = speakerName;
    this.nameEl.style.color = nameColor;
    this.textEl.textContent = text;
    this.choicesEl.style.display = 'none';
    this.advanceHint.style.display = 'block';
    this.container.style.display = 'block';
    this.visible = true;
  }

  showChoices(choices) {
    this.choicesEl.innerHTML = '';
    this.choicesEl.style.display = 'flex';
    this.advanceHint.style.display = 'none';

    choices.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.className = 'dialogue-choice';
      btn.textContent = choice.label;
      Object.assign(btn.style, {
        background: 'rgba(255,255,255,0.1)',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: '8px',
        color: '#fff',
        padding: '10px 14px',
        fontSize: '14px',
        textAlign: 'left',
        cursor: 'pointer',
        touchAction: 'manipulation',
        transition: 'background 0.2s',
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(255,255,255,0.2)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(255,255,255,0.1)';
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onChoice) this.onChoice(i, choice);
      });
      this.choicesEl.appendChild(btn);
    });
  }

  hide() {
    this.container.style.display = 'none';
    this.visible = false;
    this.onAdvance = null;
    this.onChoice = null;
  }
}
