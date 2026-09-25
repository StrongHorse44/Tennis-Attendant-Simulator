import { injectTheme, THEME } from './theme.js';

/**
 * DialogueBox - bottom-center overlay for NPC dialogue.
 *
 * Public API (used by DialogueSystem / MissionSystem / main.js):
 *   show(speakerName, text, nameColor?)  — show a line (typewriter)
 *   showChoices(choices)                 — show choice buttons ({label, description?})
 *   hide()                               — hide and clear onAdvance/onChoice
 *   advance()                            — finish the typewriter, or fire onAdvance
 *   onAdvance / onChoice(index, choice)  — callbacks set by the caller
 *   visible, isTyping()
 */

const CHARS_PER_SEC = 55;

/** Legacy archetype colours passed by callers → themed accent colours. */
const ACCENTS = {
  '#e74c3c': { color: '#ee8b78', label: 'Member' },   // entitled
  '#27ae60': { color: '#79d493', label: 'Member' },   // friendly
  '#3498db': { color: '#7db5ee', label: 'Guest' },    // clueless
  '#f1c40f': { color: THEME.gold, label: 'Club' },    // task board / staff
};

const CSS = `
.cc-dlg {
  position: fixed;
  left: 50%;
  bottom: calc(var(--cc-safe-bottom) + 20px);
  width: min(calc(100vw - 24px - var(--cc-safe-left) - var(--cc-safe-right)), 580px);
  padding: 16px 18px 12px;
  z-index: 200;
  display: none;
  transform: translate(-50%, 12px);
  opacity: 0;
  transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
  cursor: pointer;
  touch-action: manipulation;
  background: linear-gradient(180deg, rgba(30, 58, 41, 0.92), rgba(16, 32, 23, 0.94));
  border: 1px solid rgba(244, 232, 193, 0.2);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.cc-dlg::before {
  /* gold hairline accent along the top edge */
  content: '';
  position: absolute;
  left: 18px; right: 18px; top: -1px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--cc-dlg-accent, var(--cc-gold)), transparent);
  opacity: 0.8;
}
.cc-dlg--in { opacity: 1; transform: translate(-50%, 0); }
.cc-dlg__chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 4px 12px 4px 6px;
  margin-bottom: 8px;
  border-radius: 999px;
  background: var(--cc-dlg-accent-bg, rgba(244, 232, 193, 0.14));
  border: 1px solid var(--cc-dlg-accent-line, rgba(244, 232, 193, 0.45));
  font-family: var(--cc-font-display);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.2px;
  color: var(--cc-cream);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cc-dlg__avatar {
  flex: none;
  width: 22px; height: 22px;
  border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--cc-dlg-accent, var(--cc-cream));
  color: var(--cc-green-900);
  font-family: var(--cc-font-ui);
  font-size: 11px;
  font-weight: 700;
}
.cc-dlg__text {
  font-family: var(--cc-font-ui);
  font-size: 16px;
  line-height: 1.5;
  color: #fbf5e2;
  min-height: 24px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cc-dlg__rest { color: transparent; }
.cc-dlg__choices {
  display: none;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.cc-dlg__choices .cc-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  font-size: 15px;
  line-height: 1.3;
  padding: 10px 14px 10px 10px;
  touch-action: manipulation;
  opacity: 0;
  transform: translateY(6px);
  transition: background 0.15s ease, transform 0.2s ease, opacity 0.2s ease, border-color 0.15s ease;
}
.cc-dlg__choices--in .cc-btn { opacity: 1; transform: none; }
.cc-dlg__choices:not(.cc-dlg__choices--in) .cc-btn { pointer-events: none; }
.cc-dlg__num {
  flex: none;
  width: 26px; height: 26px;
  border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(217, 164, 65, 0.18);
  border: 1px solid rgba(217, 164, 65, 0.55);
  color: var(--cc-gold);
  font-size: 13px;
  font-weight: 700;
}
.cc-dlg__choice-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cc-dlg__choice-desc { font-size: 12.5px; font-weight: 500; color: var(--cc-cream-dim); }
.cc-dlg__hint {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-family: var(--cc-font-ui);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: rgba(244, 232, 193, 0.5);
  transition: opacity 0.2s ease;
}
.cc-dlg__hint b { color: var(--cc-gold); font-weight: 700; animation: cc-dlg-nudge 1.2s ease-in-out infinite; }
.cc-dlg--typing .cc-dlg__hint { opacity: 0.35; }
.cc-dlg--typing .cc-dlg__hint b { animation: none; }
@keyframes cc-dlg-nudge { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(3px); } }
@media (max-width: 480px) {
  .cc-dlg { padding: 14px 14px 10px; }
  .cc-dlg__text { font-size: 15px; }
}
@media (prefers-reduced-motion: reduce) {
  .cc-dlg, .cc-dlg__choices .cc-btn { transition: none; }
  .cc-dlg__hint b { animation: none; }
}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.id = 'cc-dialogue-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function accentFor(nameColor) {
  const key = (nameColor || '').toLowerCase();
  if (ACCENTS[key]) return ACCENTS[key].color;
  if (!key || key === '#fff' || key === '#ffffff' || key === 'white') return THEME.cream;
  return nameColor;
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(244, 232, 193, ${a})`;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function initials(name) {
  const parts = String(name).replace(/^(mr|mrs|ms|dr)\.?\s+/i, '').split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const a = parts[0][0] || '';
  const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (a + b).toUpperCase();
}

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

    // Typewriter state
    this._fullText = '';
    this._shown = 0;
    this._typing = false;
    this._typeStart = 0;
    this._raf = 0;
    this._hideTimer = null;
    this._pendingChoices = false;
    this._touchHandled = false;
    this._hasChoices = false;

    this._tick = this._tick.bind(this);

    injectTheme();
    injectCSS();
    this._create();
  }

  _create() {
    this.container = document.createElement('div');
    this.container.className = 'cc-panel cc-dlg';
    this.container.setAttribute('role', 'dialog');
    this.container.setAttribute('aria-live', 'polite');

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'cc-dlg__chip';
    this._avatarEl = document.createElement('span');
    this._avatarEl.className = 'cc-dlg__avatar';
    this._nameTextEl = document.createElement('span');
    this.nameEl.appendChild(this._avatarEl);
    this.nameEl.appendChild(this._nameTextEl);

    this.textEl = document.createElement('div');
    this.textEl.className = 'cc-dlg__text';
    this._typedEl = document.createElement('span');
    this._restEl = document.createElement('span');
    this._restEl.className = 'cc-dlg__rest';
    this._restEl.setAttribute('aria-hidden', 'true');
    this.textEl.appendChild(this._typedEl);
    this.textEl.appendChild(this._restEl);

    this.choicesEl = document.createElement('div');
    this.choicesEl.className = 'cc-dlg__choices';

    this.advanceHint = document.createElement('div');
    this.advanceHint.className = 'cc-dlg__hint';
    this.advanceHint.innerHTML = 'Tap / Space <b>▸</b>';

    this.container.appendChild(this.nameEl);
    this.container.appendChild(this.textEl);
    this.container.appendChild(this.choicesEl);
    this.container.appendChild(this.advanceHint);
    document.getElementById('ui-root').appendChild(this.container);

    // Tap to finish typing / advance
    const isChoice = (t) => t && t.closest && t.closest('.cc-dlg__choice');
    this.container.addEventListener('touchend', (e) => {
      if (isChoice(e.target)) return;
      e.preventDefault();
      this._touchHandled = true;
      this.advance();
    });
    this.container.addEventListener('click', (e) => {
      if (isChoice(e.target)) return;
      if (this._touchHandled) { this._touchHandled = false; return; }
      this.advance();
    });
  }

  /** True while the typewriter is still revealing the current line. */
  isTyping() {
    return this._typing;
  }

  /** First press completes the line instantly; the next fires onAdvance. */
  advance() {
    if (!this.visible) return;
    if (this._typing) {
      this._finishTyping();
      return;
    }
    if (this._hasChoices) return; // waiting on a choice
    if (this.onAdvance) this.onAdvance();
  }

  show(speakerName, text, nameColor = '#fff') {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }

    const accent = accentFor(nameColor);
    const st = this.container.style;
    st.setProperty('--cc-dlg-accent', accent);
    st.setProperty('--cc-dlg-accent-bg', hexToRgba(accent, 0.16));
    st.setProperty('--cc-dlg-accent-line', hexToRgba(accent, 0.55));
    if (speakerName) {
      this._nameTextEl.textContent = speakerName;
      const ini = initials(speakerName);
      this._avatarEl.textContent = ini;
      this._avatarEl.style.display = ini ? '' : 'none';
      this.nameEl.style.display = '';
    } else {
      this.nameEl.style.display = 'none';
    }

    this.choicesEl.style.display = 'none';
    this.choicesEl.classList.remove('cc-dlg__choices--in');
    this._pendingChoices = false;
    this._hasChoices = false;
    this.advanceHint.style.display = '';

    this._startTyping(text == null ? '' : String(text));

    this.container.style.display = 'block';
    this.visible = true;
    // commit display:block, then transition in (no rAF: stays snappy even when frames are slow)
    void this.container.offsetWidth;
    this.container.classList.add('cc-dlg--in');
  }

  showChoices(choices) {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    this.choicesEl.innerHTML = '';
    this.choicesEl.classList.remove('cc-dlg__choices--in');
    this.choicesEl.style.display = 'none'; // shown once the prompt finishes typing
    this._hasChoices = true;
    this.advanceHint.style.display = 'none';

    const list = Array.isArray(choices) ? choices : [];
    list.forEach((choice, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cc-btn dialogue-choice cc-dlg__choice';
      btn.style.transitionDelay = `${i * 45}ms`;

      const num = document.createElement('span');
      num.className = 'cc-dlg__num';
      num.textContent = String(i + 1);
      btn.appendChild(num);

      const body = document.createElement('span');
      body.className = 'cc-dlg__choice-body';
      const label = document.createElement('span');
      label.textContent = choice && choice.label != null ? choice.label : `Option ${i + 1}`;
      body.appendChild(label);
      if (choice && choice.description) {
        const d = document.createElement('span');
        d.className = 'cc-dlg__choice-desc';
        d.textContent = choice.description;
        body.appendChild(d);
      }
      btn.appendChild(body);

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onChoice) this.onChoice(i, choice);
      });
      this.choicesEl.appendChild(btn);
    });

    if (!this.visible) {
      this.container.style.display = 'block';
      this.visible = true;
      void this.container.offsetWidth;
      this.container.classList.add('cc-dlg--in');
    }

    // Reveal the buttons once the prompt has finished typing
    if (this._typing) this._pendingChoices = true;
    else this._revealChoices();
  }

  hide() {
    this._stopTyping();
    this.container.classList.remove('cc-dlg--in');
    this.visible = false;
    this.onAdvance = null;
    this.onChoice = null;
    this._pendingChoices = false;
    this._hasChoices = false;
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      this._hideTimer = null;
      if (!this.visible) this.container.style.display = 'none';
    }, 200);
  }

  // ─── internals ───

  _revealChoices() {
    this._pendingChoices = false;
    this.choicesEl.style.display = 'flex';
    void this.choicesEl.offsetWidth; // commit the hidden state so the buttons transition in
    this.choicesEl.classList.add('cc-dlg__choices--in');
  }

  _startTyping(text) {
    this._stopTyping();
    this._fullText = text;
    this._shown = 0;
    if (!text.length) {
      this._typedEl.textContent = '';
      this._restEl.textContent = '';
      return;
    }
    this._typedEl.textContent = '';
    this._restEl.textContent = text;
    this._typing = true;
    this.container.classList.add('cc-dlg--typing');
    this._typeStart = performance.now();
    // Wall-clock timer (not rAF) so typing keeps pace even when rendering is slow
    this._raf = setInterval(this._tick, 30);
  }

  /** Freeze / resume the typewriter (game pause). Typing picks up where it left off. */
  setPaused(on) {
    on = !!on;
    if (on === !!this._pausedAt) return;
    if (on) {
      this._pausedAt = performance.now();
    } else {
      if (this._typing) this._typeStart += performance.now() - this._pausedAt;
      this._pausedAt = 0;
    }
  }

  _tick() {
    if (!this._typing || this._pausedAt) return;
    const now = performance.now();
    const n = Math.min(this._fullText.length, Math.floor(((now - this._typeStart) / 1000) * CHARS_PER_SEC));
    if (n !== this._shown) {
      this._shown = n;
      this._typedEl.textContent = this._fullText.slice(0, n);
      this._restEl.textContent = this._fullText.slice(n);
    }
    if (n >= this._fullText.length) {
      this._finishTyping();
    }
  }

  _finishTyping() {
    this._stopTyping();
    this._shown = this._fullText.length;
    this._typedEl.textContent = this._fullText;
    this._restEl.textContent = '';
    if (this._pendingChoices) this._revealChoices();
  }

  _stopTyping() {
    if (this._raf) clearInterval(this._raf);
    this._raf = 0;
    this._typing = false;
    this.container.classList.remove('cc-dlg--typing');
  }
}
