import { injectTheme, THEME } from './theme.js';

/**
 * PauseMenu — on-screen pause button + full-screen pause overlay with Settings and
 * Reset-progress (confirm) views. Pure DOM in #ui-root; owns no game logic.
 *
 * new PauseMenu({
 *   onPauseRequest(),            // pause button pressed
 *   onResume(),                  // Resume pressed / backdrop Esc
 *   onSave() -> boolean,         // manual save
 *   onReset(),                   // confirmed reset
 *   onLocker?(),                 // Locker button (change equipped gear / cosmetics / cart look)
 *   settings,                    // SettingsStore (volume, muted, cameraSensitivity)
 *   getQuality() -> tier, setQuality(tier),
 *   getSummary() -> { day, time, weatherIcon, weather, missionsCompleted, courtsGroomed, bestGroomRating,
 *                     wallet?, rankTitle?, rankFrac?, rankPoints?, nextRankTitle?, nextRankPoints? },
 *   getAudioStatus() -> 'ready' | 'pending' | 'unavailable',
 *   getAnchor() -> Element|null  // element the pause button sits under (the minimap)
 * })
 *
 * Methods: open(), close(), isOpen, handleEscape() -> true if it navigated back instead of closing,
 *          layoutButton(), setButtonVisible(bool), destroy()
 */

const CSS = `
.ccp-btn-pause {
  position: fixed;
  top: calc(var(--cc-minimap-bottom, calc(var(--cc-safe-top, 0px) + 148px)) + 10px);
  right: calc(var(--cc-safe-right, 0px) + 12px);
  width: 44px; height: 44px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  padding: 0;
  z-index: 95;
  background: var(--cc-panel-bg, rgba(20,38,28,0.78));
  border: 1px solid var(--cc-panel-border, rgba(244,232,193,0.18));
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  color: var(--cc-cream, #f4e8c1);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.12s ease, background 0.15s ease, opacity 0.2s ease;
}
.ccp-btn-pause:hover { background: rgba(45, 90, 61, 0.9); }
.ccp-btn-pause:active { transform: scale(0.92); }
.ccp-btn-pause:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 2px; }
.ccp-btn-pause.is-hidden { opacity: 0; pointer-events: none; }

.ccp-overlay {
  position: fixed; inset: 0;
  z-index: 800;
  display: flex; align-items: center; justify-content: center;
  padding: calc(var(--cc-safe-top, 0px) + 16px) calc(var(--cc-safe-right, 0px) + 16px)
           calc(var(--cc-safe-bottom, 0px) + 16px) calc(var(--cc-safe-left, 0px) + 16px);
  background:
    radial-gradient(ellipse at 50% 40%, rgba(23, 58, 38, 0.35), rgba(8, 18, 12, 0.72) 75%);
  backdrop-filter: blur(7px) saturate(0.85);
  -webkit-backdrop-filter: blur(7px) saturate(0.85);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.22s ease, visibility 0s linear 0.22s;
  touch-action: manipulation;
  overscroll-behavior: contain;
}
.ccp-overlay.is-open {
  opacity: 1; visibility: visible;
  transition: opacity 0.22s ease, visibility 0s;
}
.ccp-panel {
  position: relative;
  width: min(380px, 100%);
  max-height: 100%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 22px 20px 18px;
  background: linear-gradient(180deg, rgba(31, 66, 45, 0.94), rgba(20, 42, 29, 0.95));
  border-radius: 20px;
  transform: translateY(14px) scale(0.965);
  transition: transform 0.26s cubic-bezier(.2,.9,.3,1.15);
  user-select: none; -webkit-user-select: none;
}
.ccp-overlay.is-open .ccp-panel { transform: none; }
.ccp-panel::before {
  content: ''; position: absolute; inset: 6px;
  border: 1px solid rgba(217, 164, 65, 0.22);
  border-radius: 15px; pointer-events: none;
}
.ccp-view { display: none; flex-direction: column; gap: 10px; }
.ccp-view.is-active { display: flex; animation: ccp-in 0.22s ease both; }
@keyframes ccp-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.ccp-head { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; margin-bottom: 4px; }
.ccp-crest { width: 58px; height: 66px; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.35)); }
.ccp-club { margin-top: 6px; color: var(--cc-gold); letter-spacing: 2.4px; }
.ccp-title { font-size: 28px; line-height: 1.1; margin: 0; }
.ccp-sub { font-size: 13px; color: var(--cc-cream-dim); font-family: var(--cc-font-ui); }

.ccp-rule { height: 1px; margin: 4px 8px; background: linear-gradient(90deg, transparent, rgba(244,232,193,0.25), transparent); }

.ccp-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 2px 0 4px; }
.ccp-stat {
  background: rgba(244, 232, 193, 0.06);
  border: 1px solid rgba(244, 232, 193, 0.1);
  border-radius: 10px; padding: 8px 6px; text-align: center;
}
.ccp-stat b { display: block; font-family: var(--cc-font-display); font-size: 19px; color: var(--cc-cream); font-weight: 600; }
.ccp-stat span { display: block; font-size: 10px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); margin-top: 2px; }

.ccp-career {
  display: flex; align-items: center; gap: 12px;
  background: rgba(217, 164, 65, 0.1); border: 1px solid rgba(217, 164, 65, 0.35);
  border-radius: 10px; padding: 9px 12px; margin: 0 0 4px;
}
.ccp-career__wallet { flex: none; text-align: center; min-width: 64px; }
.ccp-career__wallet b { display: block; font-family: var(--cc-font-display); font-size: 20px; color: #ffe39a; font-weight: 600; font-variant-numeric: tabular-nums; }
.ccp-career__wallet span { display: block; font-size: 10px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); }
.ccp-career__rank { flex: 1; min-width: 0; }
.ccp-career__title { font-family: var(--cc-font-display); font-size: 15px; font-weight: 600; color: var(--cc-cream); }
.ccp-career__bar { height: 6px; border-radius: 999px; background: rgba(244, 232, 193, 0.12); overflow: hidden; margin: 5px 0 3px; }
.ccp-career__bar i { display: block; height: 100%; width: 0; background: var(--cc-gold); border-radius: inherit; }
.ccp-career__next { font-size: 11.5px; color: var(--cc-cream-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ccp-btn { width: 100%; min-height: 52px; font-size: 16px; display: flex; align-items: center; justify-content: center; gap: 10px; }
.ccp-btn svg { width: 18px; height: 18px; flex: none; }
.ccp-btn-row { display: flex; gap: 10px; }
.ccp-btn-row .ccp-btn { flex: 1; }
.ccp-btn--small { min-height: 44px; font-size: 14px; }
.ccp-status {
  min-height: 18px; text-align: center; font-size: 13px; color: var(--cc-ok);
  opacity: 0; transition: opacity 0.25s ease;
}
.ccp-status.is-visible { opacity: 1; }
.ccp-status.is-error { color: var(--cc-danger); }
.ccp-hint { text-align: center; font-size: 12px; color: var(--cc-cream-dim); opacity: 0.8; }
@media (hover: none) { .ccp-hint--kbd { display: none; } }

.ccp-field { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px;
  background: rgba(244, 232, 193, 0.05); border: 1px solid rgba(244, 232, 193, 0.08); }
.ccp-field-head { display: flex; align-items: center; justify-content: space-between; }
.ccp-value { font-variant-numeric: tabular-nums; font-size: 14px; color: var(--cc-cream); font-weight: 600; }
.ccp-note { font-size: 12px; color: var(--cc-cream-dim); line-height: 1.35; }

.ccp-range {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 44px; background: transparent; margin: 0; cursor: pointer;
  touch-action: pan-y;
}
.ccp-range:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 4px; border-radius: 6px; }
.ccp-range::-webkit-slider-runnable-track {
  height: 6px; border-radius: 3px;
  background: linear-gradient(90deg, var(--cc-gold) 0 var(--fill, 50%), rgba(244,232,193,0.18) var(--fill, 50%) 100%);
}
.ccp-range::-moz-range-track { height: 6px; border-radius: 3px; background: rgba(244,232,193,0.18); }
.ccp-range::-moz-range-progress { height: 6px; border-radius: 3px; background: var(--cc-gold); }
.ccp-range::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 24px; height: 24px; border-radius: 50%; margin-top: -9px;
  background: var(--cc-cream); border: 2px solid var(--cc-green-700);
  box-shadow: 0 2px 6px rgba(0,0,0,0.35);
}
.ccp-range::-moz-range-thumb {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--cc-cream); border: 2px solid var(--cc-green-700);
}
.ccp-range:disabled { opacity: 0.45; }

.ccp-switch {
  position: relative; width: 52px; height: 30px; flex: none;
  border-radius: 15px; border: 1px solid rgba(244,232,193,0.25);
  background: rgba(244,232,193,0.12); cursor: pointer; padding: 0;
  transition: background 0.18s ease;
}
.ccp-switch::after {
  content: ''; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%;
  background: var(--cc-cream); transition: transform 0.18s ease; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.ccp-switch[aria-checked="true"] { background: var(--cc-danger); border-color: transparent; }
.ccp-switch[aria-checked="true"]::after { transform: translateX(22px); }
.ccp-switch:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 2px; }
.ccp-switch-wrap { display: flex; align-items: center; justify-content: space-between; min-height: 44px; gap: 12px; cursor: pointer; }

.ccp-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px; border-radius: 12px; background: rgba(0,0,0,0.22); }
.ccp-seg button {
  min-height: 44px; border: 0; border-radius: 9px; background: transparent;
  color: var(--cc-cream-dim); font: 600 14px var(--cc-font-ui); cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  -webkit-tap-highlight-color: transparent;
}
.ccp-seg button[aria-pressed="true"] { background: var(--cc-cream); color: var(--cc-green-900); }
.ccp-seg button:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 1px; }

.ccp-confirm-icon { width: 48px; height: 48px; margin: 0 auto; color: var(--cc-danger); }
.ccp-body { text-align: center; font-size: 14px; line-height: 1.5; color: var(--cc-cream); opacity: 0.9; margin: 0 4px 6px; }

.ccp-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ccp-status { margin: -4px 0 -6px; }

@media (max-height: 560px) {
  .ccp-crest { width: 40px; height: 46px; }
  .ccp-title { font-size: 22px; }
  .ccp-panel { padding: 14px 16px 12px; }
  .ccp-btn { min-height: 46px; }
  .ccp-view, .ccp-col { gap: 8px; }
  .ccp-hint { display: none; }
}
/* Landscape phones: two columns so everything fits without scrolling */
@media (max-height: 560px) and (min-width: 600px) {
  .ccp-panel { width: min(680px, 100%); }
  .ccp-view.is-active[data-view="main"] { display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; align-items: center; }
  .ccp-view.is-active[data-view="settings"] { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; align-items: start; }
  .ccp-view[data-view="settings"] > .ccp-head,
  .ccp-view[data-view="settings"] > .ccp-btn { grid-column: 1 / -1; }
  .ccp-view[data-view="settings"] > .ccp-head { display: none; }
  .ccp-field--sound { grid-column: 1; grid-row: 1 / span 2; }
  .ccp-field--gfx { grid-column: 2; grid-row: 1; }
  .ccp-field--cam { grid-column: 2; grid-row: 2; }
  .ccp-view[data-view="settings"] > .ccp-btn { grid-row: 3; min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .ccp-overlay, .ccp-panel, .ccp-view.is-active { transition: none; animation: none; }
}
`;

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.3" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1.3" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.6 7.6 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7.6 7.6 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.7 7.7 0 0 1 0-2.9L4.6 9.3l2-3.4 1.9.7a7.6 7.6 0 0 1 2-1.2L10.8 3h4l.3 2.4a7.6 7.6 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.7 7.7 0 0 1 0 3z"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V3z"/><path fill="none" stroke="currentColor" stroke-width="2" d="M8 3v5h7V3M8 21v-7h8v7"/></svg>',
  reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 1 0 2.4-5.7L4 8.6M4 3.5v5.1h5.1"/></svg>',
  locker: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v18M9 8h1M14 8h1M9 11h1M14 11h1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>',
  warn: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="rgba(224,90,71,0.15)" stroke="currentColor" stroke-width="2"/><path d="M24 13v14" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/><circle cx="24" cy="34" r="2.2" fill="currentColor"/></svg>',
};

const CREST_SVG = `
<svg class="ccp-crest" viewBox="0 0 64 72" aria-hidden="true">
  <defs>
    <linearGradient id="ccpCrestFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${THEME.green500}"/><stop offset="1" stop-color="${THEME.green900}"/>
    </linearGradient>
  </defs>
  <path d="M32 3 L59 11.5 V35 C59 52 46.5 63.5 32 69 C17.5 63.5 5 52 5 35 V11.5 Z" fill="url(#ccpCrestFill)" stroke="${THEME.cream}" stroke-width="2.4"/>
  <path d="M32 8.5 L54 15.5 V35 C54 48.5 44 58 32 62.8 C20 58 10 48.5 10 35 V15.5 Z" fill="none" stroke="${THEME.gold}" stroke-width="1" opacity="0.75"/>
  <g fill="none" stroke="${THEME.cream}" stroke-width="2" stroke-linecap="round">
    <ellipse cx="23.5" cy="32" rx="6.6" ry="9" transform="rotate(-32 23.5 32)"/>
    <line x1="28.2" y1="39.6" x2="40.5" y2="55"/>
    <ellipse cx="40.5" cy="32" rx="6.6" ry="9" transform="rotate(32 40.5 32)"/>
    <line x1="35.8" y1="39.6" x2="23.5" y2="55"/>
  </g>
  <g stroke="${THEME.cream}" stroke-width="0.6" opacity="0.55">
    <line x1="19" y1="28" x2="27.5" y2="36.5"/><line x1="21" y1="25.5" x2="29" y2="33.5"/>
    <line x1="45" y1="28" x2="36.5" y2="36.5"/><line x1="43" y1="25.5" x2="35" y2="33.5"/>
  </g>
  <circle cx="32" cy="19.5" r="4.6" fill="#d8e04e" stroke="${THEME.green900}" stroke-width="0.8"/>
  <path d="M28.2 17.6 C30.5 19 30.5 21 28.6 22.4 M35.8 16.8 C33.6 18.2 33.5 20.6 35.6 22" fill="none" stroke="#fdfbe8" stroke-width="0.9"/>
</svg>`;

const QUALITY_NOTES = {
  low: 'Fastest. No shadows or post effects — best for older phones.',
  medium: 'Balanced. Soft shadows and colour grading.',
  high: 'Best looking. Adds ambient occlusion and bloom.',
};

const RATING_LABEL = { excellent: 'A+', good: 'B', needsWork: 'C' };

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.id = 'cc-pause-css';
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class PauseMenu {
  constructor(opts = {}) {
    this.opts = opts;
    this.isOpen = false;
    this.view = 'main';
    this._statusTimer = null;
    this._keyboardNav = false; // move focus into the menu only for keyboard users
    this._onKeyNav = () => { this._keyboardNav = true; };
    this._onPointerNav = () => { this._keyboardNav = false; };
    window.addEventListener('keydown', this._onKeyNav, true);
    window.addEventListener('pointerdown', this._onPointerNav, true);
    this._layoutTimers = [];
    this._resizeObs = null;

    injectTheme();
    injectCSS();
    this.root = document.getElementById('ui-root') || document.body;
    this._buildButton();
    this._buildOverlay();

    this._onResize = () => this.layoutButton();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    // The HUD may lay itself out after us; re-anchor a few times, then observe
    for (const ms of [0, 300, 1200]) this._layoutTimers.push(setTimeout(this._onResize, ms));
    const anchor = this._anchor();
    if (anchor && typeof ResizeObserver !== 'undefined') {
      this._resizeObs = new ResizeObserver(this._onResize);
      this._resizeObs.observe(anchor);
    }
  }

  // ───────────────────────────── build ─────────────────────────────

  _buildButton() {
    const b = el('button', 'ccp-btn-pause', ICONS.pause);
    b.type = 'button';
    b.setAttribute('aria-label', 'Pause game');
    b.title = 'Pause (Esc)';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      b.blur();
      if (this.opts.onPauseRequest) this.opts.onPauseRequest();
    });
    // Don't let the press start a camera drag / tap underneath
    for (const ev of ['pointerdown', 'touchstart', 'mousedown']) {
      b.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    this.pauseButton = b;
    this.root.appendChild(b);
  }

  _buildOverlay() {
    const ov = el('div', 'ccp-overlay');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Pause menu');
    ov.setAttribute('aria-hidden', 'true');
    // Block every pointer from reaching the game while open
    for (const ev of ['touchstart', 'touchmove', 'mousedown', 'wheel']) {
      ov.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    // Keep focus inside the dialog
    ov.addEventListener('keydown', (e) => this._trapFocus(e));

    const panel = el('div', 'ccp-panel cc-panel');
    ov.appendChild(panel);

    panel.appendChild(this._buildMainView());
    panel.appendChild(this._buildSettingsView());
    panel.appendChild(this._buildConfirmView());

    this.overlay = ov;
    this.panel = panel;
    this.root.appendChild(ov);
  }

  _buildMainView() {
    const v = el('div', 'ccp-view is-active');
    v.dataset.view = 'main';

    const head = el('div', 'ccp-head');
    head.innerHTML = `${CREST_SVG}
      <div class="cc-label ccp-club">Greenbriar Tennis &amp; Social Club</div>
      <h2 class="cc-title ccp-title">Paused</h2>
      <div class="ccp-sub" data-ref="sub"></div>`;
    this.subEl = head.querySelector('[data-ref="sub"]');

    const info = el('div', 'ccp-col ccp-col--info');
    const actions = el('div', 'ccp-col ccp-col--actions');
    v.appendChild(info);
    v.appendChild(actions);
    info.appendChild(head);

    const stats = el('div', 'ccp-stats');
    stats.innerHTML = `
      <div class="ccp-stat"><b data-ref="missions">0</b><span>Tasks done</span></div>
      <div class="ccp-stat"><b data-ref="courts">0</b><span>Courts groomed</span></div>
      <div class="ccp-stat"><b data-ref="rating">—</b><span>Best groom</span></div>`;
    info.appendChild(stats);
    this.statEls = {
      missions: stats.querySelector('[data-ref="missions"]'),
      courts: stats.querySelector('[data-ref="courts"]'),
      rating: stats.querySelector('[data-ref="rating"]'),
    };

    // Career: wallet + staff rank progress (shift loop)
    const career = el('div', 'ccp-career');
    career.innerHTML = `
      <div class="ccp-career__wallet"><b data-ref="wallet">$0</b><span>Wallet</span></div>
      <div class="ccp-career__rank">
        <div class="ccp-career__title" data-ref="rank">Rookie Attendant</div>
        <div class="ccp-career__bar"><i data-ref="rankBar"></i></div>
        <div class="ccp-career__next" data-ref="rankNext"></div>
      </div>`;
    info.appendChild(career);
    this.careerEl = career;
    this.statEls.wallet = career.querySelector('[data-ref="wallet"]');
    this.statEls.rank = career.querySelector('[data-ref="rank"]');
    this.statEls.rankBar = career.querySelector('[data-ref="rankBar"]');
    this.statEls.rankNext = career.querySelector('[data-ref="rankNext"]');

    this.resumeBtn = this._button(`${ICONS.play}<span>Resume</span>`, 'cc-btn cc-btn--primary ccp-btn', () => {
      if (this.opts.onResume) this.opts.onResume();
    });
    actions.appendChild(this.resumeBtn);

    const row = el('div', 'ccp-btn-row');
    row.appendChild(this._button(`${ICONS.gear}<span>Settings</span>`, 'cc-btn ccp-btn', () => this.showView('settings')));
    row.appendChild(this._button(`${ICONS.save}<span>Save</span>`, 'cc-btn ccp-btn', () => this._doSave()));
    actions.appendChild(row);
    // Locker: change equipped gear / uniform / cart look anywhere (ShopUI in locker mode, on top)
    if (this.opts.onLocker) {
      actions.appendChild(this._button(`${ICONS.locker}<span>Locker</span>`, 'cc-btn ccp-btn', () => this.opts.onLocker()));
    }

    this.statusEl = el('div', 'ccp-status');
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');
    actions.appendChild(this.statusEl);

    actions.appendChild(el('div', 'ccp-rule'));
    actions.appendChild(this._button(`${ICONS.reset}<span>Reset progress</span>`, 'cc-btn cc-btn--danger ccp-btn ccp-btn--small', () => this.showView('confirm')));
    this.saveHintEl = el('div', 'ccp-hint ccp-hint--kbd', 'Esc or P to resume · progress autosaves');
    actions.appendChild(this.saveHintEl);
    return v;
  }

  _buildSettingsView() {
    const s = this.opts.settings;
    const v = el('div', 'ccp-view');
    v.dataset.view = 'settings';

    const head = el('div', 'ccp-head');
    head.innerHTML = `<div class="cc-label ccp-club">Pause menu</div><h2 class="cc-title ccp-title">Settings</h2>`;
    v.appendChild(head);

    // ── Sound
    const sound = el('div', 'ccp-field ccp-field--sound');
    sound.innerHTML = `
      <div class="ccp-field-head"><span class="cc-label">Master volume</span><span class="ccp-value" data-ref="vol"></span></div>
      <input class="ccp-range" type="range" min="0" max="100" step="1" aria-label="Master volume" data-ref="volRange">
      <label class="ccp-switch-wrap"><span class="ccp-note" style="font-size:14px;color:var(--cc-cream)">Mute all sound</span>
        <button type="button" class="ccp-switch" role="switch" aria-checked="false" aria-label="Mute all sound" data-ref="mute"></button></label>
      <div class="ccp-note" data-ref="audioNote"></div>`;
    v.appendChild(sound);
    this.volValue = sound.querySelector('[data-ref="vol"]');
    this.volRange = sound.querySelector('[data-ref="volRange"]');
    this.muteSwitch = sound.querySelector('[data-ref="mute"]');
    this.audioNote = sound.querySelector('[data-ref="audioNote"]');
    this.volRange.addEventListener('input', () => {
      const vol = Number(this.volRange.value) / 100;
      if (s) s.set('volume', vol);
      if (vol > 0 && s && s.get('muted')) s.set('muted', false);
      this._syncSettings();
    });
    const toggleMute = (e) => {
      e.preventDefault();
      if (s) s.set('muted', !s.get('muted'));
      this._syncSettings();
    };
    this.muteSwitch.addEventListener('click', toggleMute);

    // ── Graphics
    const gfx = el('div', 'ccp-field ccp-field--gfx');
    gfx.innerHTML = `
      <div class="ccp-field-head"><span class="cc-label">Graphics quality</span></div>
      <div class="ccp-seg" role="group" aria-label="Graphics quality">
        <button type="button" data-q="low">Low</button>
        <button type="button" data-q="medium">Medium</button>
        <button type="button" data-q="high">High</button>
      </div>
      <div class="ccp-note" data-ref="qNote"></div>`;
    v.appendChild(gfx);
    this.qButtons = Array.from(gfx.querySelectorAll('[data-q]'));
    this.qNote = gfx.querySelector('[data-ref="qNote"]');
    for (const b of this.qButtons) {
      b.addEventListener('click', () => {
        if (this.opts.setQuality) this.opts.setQuality(b.dataset.q);
        this._syncSettings();
      });
    }

    // ── Camera
    const cam = el('div', 'ccp-field ccp-field--cam');
    cam.innerHTML = `
      <div class="ccp-field-head"><span class="cc-label">Camera sensitivity</span><span class="ccp-value" data-ref="sens"></span></div>
      <input class="ccp-range" type="range" min="25" max="250" step="5" aria-label="Camera sensitivity" data-ref="sensRange">`;
    v.appendChild(cam);
    this.sensValue = cam.querySelector('[data-ref="sens"]');
    this.sensRange = cam.querySelector('[data-ref="sensRange"]');
    this.sensRange.addEventListener('input', () => {
      if (s) s.set('cameraSensitivity', Number(this.sensRange.value) / 100);
      this._syncSettings();
    });

    v.appendChild(this._button(`${ICONS.back}<span>Back</span>`, 'cc-btn ccp-btn', () => this.showView('main')));
    return v;
  }

  _buildConfirmView() {
    const v = el('div', 'ccp-view');
    v.dataset.view = 'confirm';
    v.appendChild(el('div', 'ccp-confirm-icon', ICONS.warn));
    const head = el('div', 'ccp-head');
    head.innerHTML = `<h2 class="cc-title ccp-title">Reset all progress?</h2>`;
    v.appendChild(head);
    v.appendChild(el('p', 'ccp-body',
      'This erases your day, missions, inventory, court conditions and stats, and restarts your first shift. Your settings are kept.'));
    const row = el('div', 'ccp-btn-row');
    this.cancelResetBtn = this._button('<span>Cancel</span>', 'cc-btn ccp-btn', () => this.showView('main'));
    row.appendChild(this.cancelResetBtn);
    row.appendChild(this._button('<span>Reset</span>', 'cc-btn cc-btn--danger ccp-btn', () => {
      if (this.opts.onReset) this.opts.onReset();
    }));
    v.appendChild(row);
    return v;
  }

  _button(html, cls, onClick) {
    const b = el('button', cls, html);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick(e);
    });
    return b;
  }

  // ───────────────────────────── behaviour ─────────────────────────────

  _anchor() {
    try {
      return this.opts.getAnchor ? this.opts.getAnchor() : null;
    } catch (e) {
      return null;
    }
  }

  /** Place the pause button just below the anchor (minimap), right-aligned with it. */
  layoutButton() {
    const a = this._anchor();
    if (!a || !a.isConnected) return; // keep CSS fallback position
    const r = a.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const b = this.pauseButton;
    b.style.top = `${Math.round(r.bottom + 10)}px`;
    b.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  }

  setButtonVisible(on) {
    this.pauseButton.classList.toggle('is-hidden', !on);
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this._lastFocus = document.activeElement;
    this.showView('main', true);
    this._refreshSummary();
    this._syncSettings();
    this.overlay.classList.add('is-open');
    this.overlay.setAttribute('aria-hidden', 'false');
    this.setButtonVisible(false);
    // Focus after the transition begins (prevents the opening keypress from activating it)
    if (this._keyboardNav) {
      requestAnimationFrame(() => {
        if (this.isOpen) try { this.resumeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      });
    }
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay.classList.remove('is-open');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.setButtonVisible(true);
    if (document.activeElement && this.overlay.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    this._clearStatus();
  }

  /** Esc while open: step back from a sub-view. Returns true if handled (menu stays open). */
  handleEscape() {
    if (!this.isOpen) return false;
    if (this.view !== 'main') {
      this.showView('main');
      return true;
    }
    return false;
  }

  showView(name, instant = false) {
    this.view = name;
    for (const v of this.panel.querySelectorAll('.ccp-view')) {
      const on = v.dataset.view === name;
      v.classList.toggle('is-active', on);
      if (on && instant) v.style.animation = 'none';
      else v.style.animation = '';
    }
    if (name === 'settings') this._syncSettings();
    if (name === 'main') this._refreshSummary();
    if (!instant && this._keyboardNav) {
      const first = name === 'main' ? this.resumeBtn : name === 'confirm' ? this.cancelResetBtn : this.volRange;
      requestAnimationFrame(() => { try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
    }
    this.panel.scrollTop = 0;
  }

  _refreshSummary() {
    const s = this.opts.getSummary ? this.opts.getSummary() : null;
    if (!s) return;
    const parts = [];
    if (s.day) parts.push(`Day ${s.day}`);
    if (s.time) parts.push(s.time);
    if (s.weather) parts.push(`${s.weatherIcon ? s.weatherIcon + ' ' : ''}${s.weather[0].toUpperCase()}${s.weather.slice(1)}`);
    this.subEl.textContent = parts.join('  ·  ');
    this.statEls.missions.textContent = String(s.missionsCompleted || 0);
    this.statEls.courts.textContent = String(s.courtsGroomed || 0);
    this.statEls.rating.textContent = s.bestGroomRating ? (RATING_LABEL[s.bestGroomRating] || '—') : '—';
    this.statEls.rating.title = s.bestGroomRating || 'No grooming yet';
    const hasCareer = typeof s.wallet === 'number' && !!s.rankTitle;
    this.careerEl.style.display = hasCareer ? '' : 'none';
    if (hasCareer) {
      this.statEls.wallet.textContent = '$' + Math.round(s.wallet).toLocaleString('en-US');
      this.statEls.rank.textContent = s.rankTitle;
      this.statEls.rankBar.style.width = Math.round((s.rankFrac || 0) * 100) + '%';
      this.statEls.rankNext.textContent = s.nextRankTitle
        ? `${s.rankPoints} / ${s.nextRankPoints} pts to ${s.nextRankTitle}`
        : `${s.rankPoints} pts · top rank`;
    }
    if (this.saveHintEl) {
      this.saveHintEl.textContent = s.canSave === false
        ? 'Esc or P to resume · saving is unavailable in this browser'
        : 'Esc or P to resume · progress autosaves';
    }
  }

  _syncSettings() {
    const s = this.opts.settings;
    if (s) {
      const vol = Math.round((s.get('volume') ?? 0.8) * 100);
      const muted = !!s.get('muted');
      if (document.activeElement !== this.volRange) this.volRange.value = String(vol);
      this.volRange.style.setProperty('--fill', `${vol}%`);
      this.volValue.textContent = muted ? 'Muted' : `${vol}%`;
      this.muteSwitch.setAttribute('aria-checked', muted ? 'true' : 'false');

      const sens = s.get('cameraSensitivity') ?? 1;
      if (document.activeElement !== this.sensRange) this.sensRange.value = String(Math.round(sens * 100));
      this.sensRange.style.setProperty('--fill', `${((sens * 100 - 25) / 225) * 100}%`);
      this.sensValue.textContent = `${sens.toFixed(2).replace(/0$/, '')}×`;
    }
    const status = this.opts.getAudioStatus ? this.opts.getAudioStatus() : 'ready';
    this.audioNote.textContent = status === 'unavailable'
      ? 'Audio is unavailable in this browser.'
      : status === 'pending' ? 'Sound starts after your first tap or key press.' : '';
    this.audioNote.style.display = this.audioNote.textContent ? '' : 'none';

    const tier = this.opts.getQuality ? this.opts.getQuality() : 'medium';
    for (const b of this.qButtons) b.setAttribute('aria-pressed', b.dataset.q === tier ? 'true' : 'false');
    this.qNote.textContent = QUALITY_NOTES[tier] || '';
  }

  _doSave() {
    let ok = false;
    try { ok = this.opts.onSave ? !!this.opts.onSave() : false; } catch (e) { ok = false; }
    const t = new Date();
    const hh = t.getHours(), mm = String(t.getMinutes()).padStart(2, '0');
    this._setStatus(ok ? `✓ Game saved · ${((hh + 11) % 12) + 1}:${mm} ${hh < 12 ? 'AM' : 'PM'}`
      : 'Couldn’t save — storage is unavailable', !ok);
  }

  _setStatus(text, isError) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('is-error', !!isError);
    this.statusEl.classList.add('is-visible');
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => this.statusEl.classList.remove('is-visible'), 2600);
  }

  _clearStatus() {
    clearTimeout(this._statusTimer);
    this.statusEl.classList.remove('is-visible');
  }

  _trapFocus(e) {
    if (e.key !== 'Tab') return;
    const view = this.panel.querySelector('.ccp-view.is-active');
    if (!view) return;
    const items = Array.from(view.querySelectorAll('button, input')).filter(x => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    window.removeEventListener('keydown', this._onKeyNav, true);
    window.removeEventListener('pointerdown', this._onPointerNav, true);
    for (const t of this._layoutTimers) clearTimeout(t);
    if (this._resizeObs) this._resizeObs.disconnect();
    this.pauseButton.remove();
    this.overlay.remove();
  }
}
