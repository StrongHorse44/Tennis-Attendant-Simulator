import { injectTheme } from '../ui/theme.js';
import { TENNIS_STATS } from '../systems/PlayerProfile.js';

/**
 * TennisHUD — DOM overlay for the after-hours mode (in #ui-root, theme.js tokens):
 * scoreboard (sets / games / points, server dot) with the stamina and momentum bars, a big
 * SWING button (hold to load: the power fill rises inside it; the timing ring closes at the
 * ideal release; thumb-reachable bottom-right), the serve toss meter, the shot selector
 * (Flat / Topspin / Slice / Lob / Drop), "Perfect!" / "Out!" popups, the mode menu and the
 * results card. The regular HUD is hidden while body.cc-tennis is set. DOM writes are cached so the
 * per-frame calls (timing, stamina, meter) only touch the DOM when a value changes.
 */

const CSS = `
body.cc-tennis .cc-hud-left, body.cc-tennis .cc-map, body.cc-tennis .cc-action,
body.cc-tennis .cc-inv, body.cc-tennis .cc-toasts, body.cc-tennis .cc-radio { display: none !important; }
body.cc-tennis-modal .cc-joy { display: none !important; }
body.cc-tennis .ccp-btn-pause { top: calc(var(--cc-safe-top) + 10px) !important; right: calc(var(--cc-safe-right) + 12px) !important; }
.cct { position: fixed; inset: 0; pointer-events: none; z-index: 90; font-family: var(--cc-font-ui); color: var(--cc-cream); display: none; }
.cct.is-on { display: block; }
.cct button { font-family: inherit; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.cct-play { display: none; }
.cct.is-play .cct-play { display: block; }

.cct-board {
  position: absolute; left: calc(var(--cc-safe-left) + 10px); top: calc(var(--cc-safe-top) + 10px);
  min-width: 212px; max-width: min(300px, calc(100vw - 150px)); padding: 8px 10px 9px; pointer-events: auto;
}
.cct-info { font-size: 10.5px; letter-spacing: 0.9px; text-transform: uppercase; color: var(--cc-cream-dim); margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cct-rows { display: grid; grid-template-columns: 12px 1fr auto; gap: 3px 6px; align-items: center; }
.cct-dot { width: 9px; height: 9px; border-radius: 50%; background: transparent; border: 1px solid rgba(244,232,193,0.25); }
.cct-dot.is-on { background: var(--cc-gold); border-color: var(--cc-gold); box-shadow: 0 0 8px rgba(217,164,65,0.8); }
.cct-name { font-family: var(--cc-font-display); font-weight: 600; font-size: 15px; white-space: nowrap; }
.cct-cells { display: flex; gap: 3px; font-variant-numeric: tabular-nums; }
.cct-cell { min-width: 22px; text-align: center; font-size: 14px; padding: 2px 3px; border-radius: 5px; background: rgba(244,232,193,0.07); color: var(--cc-cream-dim); }
.cct-cell.is-cur { background: rgba(244,232,193,0.14); color: var(--cc-cream); font-weight: 700; }
.cct-cell.is-pts { min-width: 30px; background: var(--cc-green-700); color: #fff; font-weight: 700; }
.cct-drill { font-family: var(--cc-font-display); font-size: 18px; font-weight: 600; }
.cct-stam { display: flex; align-items: center; gap: 6px; margin-top: 7px; font-size: 10px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); }
.cct-stam__bar { flex: 1; height: 6px; border-radius: 99px; background: rgba(244,232,193,0.14); overflow: hidden; }
.cct-stam__bar i { display: block; height: 100%; width: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--cc-ok), #9be27f); transform-origin: left; }
.cct-stam__bar.is-low i { background: linear-gradient(90deg, var(--cc-danger), var(--cc-warn)); }
.cct-mom { display: none; align-items: center; gap: 6px; margin-top: 5px; font-size: 10px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); }
.cct-mom.is-on { display: flex; }
.cct-mom__bar { flex: 1; height: 6px; border-radius: 99px; background: rgba(244,232,193,0.14); position: relative; overflow: hidden; }
.cct-mom__bar::after { content: ''; position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px; background: rgba(244,232,193,0.45); }
.cct-mom__bar i { position: absolute; top: 0; bottom: 0; left: 50%; width: 50%; transform-origin: left; transform: scaleX(0); border-radius: 0 99px 99px 0; background: linear-gradient(90deg, #f2c14e, #ffe066); }
.cct-mom__bar i.is-neg { left: 0; transform-origin: right; border-radius: 99px 0 0 99px; background: linear-gradient(90deg, #e07a4f, var(--cc-clay)); }
.cct-mom__bar.is-zone { box-shadow: 0 0 8px rgba(255,224,102,0.8); }
.cct-menu-btn {
  position: absolute; top: calc(var(--cc-safe-top) + 10px); right: calc(var(--cc-safe-right) + 64px);
  height: 44px; min-width: 44px; padding: 0 14px; border-radius: 22px; pointer-events: auto;
  background: var(--cc-panel-bg); border: 1px solid var(--cc-panel-border); color: var(--cc-cream); font-weight: 600; font-size: 13px; cursor: pointer;
}

.cct-swing {
  position: absolute; right: calc(var(--cc-safe-right) + 20px); bottom: calc(var(--cc-safe-bottom) + 24px);
  width: 104px; height: 104px; border-radius: 50%; pointer-events: auto; cursor: pointer; padding: 0;
  background: radial-gradient(circle at 38% 30%, #fff6d8 0%, #f2c14e 38%, #c98a1f 100%);
  border: 3px solid rgba(255,255,255,0.7); box-shadow: 0 8px 22px rgba(0,0,0,0.4), inset 0 -5px 10px rgba(120,70,10,0.3);
  color: #3a2608; display: flex; flex-direction: column; align-items: center; justify-content: center;
  touch-action: none; user-select: none; -webkit-user-select: none; transition: transform 0.08s ease;
}
.cct-swing.is-down { transform: scale(0.93); }
.cct-pow { position: absolute; inset: 5px; border-radius: 50%; overflow: hidden; pointer-events: none; }
.cct-pow i { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; transform-origin: bottom; transform: scaleY(0);
  background: linear-gradient(0deg, rgba(232,96,46,0.85), rgba(255,210,90,0.55)); }
.cct-swing.is-full .cct-pow i { background: linear-gradient(0deg, rgba(255,70,40,0.95), rgba(255,236,150,0.8)); }
.cct-swing.is-full { box-shadow: 0 0 22px rgba(255,190,80,0.9), 0 8px 22px rgba(0,0,0,0.4); }
.cct-swing b, .cct-swing small { position: relative; }
.cct-swing b { font-size: 17px; letter-spacing: 1.2px; font-weight: 800; pointer-events: none; }
.cct-swing small { font-size: 10px; opacity: 0.7; font-weight: 600; pointer-events: none; }
.cct-ring { position: absolute; inset: -9px; pointer-events: none; transform: rotate(-90deg); opacity: 0; transition: opacity 0.15s; }
.cct-ring.is-on { opacity: 1; }
.cct-ring circle { fill: none; stroke-width: 6; }
.cct-ring .bg { stroke: rgba(20,38,28,0.35); }
.cct-ring .fg { stroke: #fff4d2; stroke-linecap: round; }
.cct-ring.is-now .fg { stroke: #7CFFA0; }
.cct-ring.is-now { filter: drop-shadow(0 0 8px rgba(124,255,160,0.9)); }

.cct-meter {
  position: absolute; right: calc(var(--cc-safe-right) + 136px); bottom: calc(var(--cc-safe-bottom) + 24px);
  width: 20px; height: 120px; border-radius: 10px; background: rgba(20,38,28,0.7); border: 1px solid var(--cc-panel-border);
  overflow: hidden; display: none;
}
.cct-meter.is-on { display: block; }
.cct-meter__zone { position: absolute; left: 0; right: 0; bottom: 69.2%; height: 12.3%; background: rgba(76,175,106,0.55); border-top: 1px solid #9be27f; border-bottom: 1px solid #9be27f; }
.cct-meter__fill { position: absolute; left: 3px; right: 3px; bottom: 3px; height: 0; border-radius: 7px; background: linear-gradient(0deg, #f2c14e, #fff4d2); }
.cct-meter__fill.is-over { background: linear-gradient(0deg, #f2c14e, var(--cc-danger)); }

.cct-shots {
  position: absolute; right: calc(var(--cc-safe-right) + 12px); bottom: calc(var(--cc-safe-bottom) + 140px);
  display: flex; gap: 6px; pointer-events: auto;
}
.cct-shot {
  min-width: 52px; height: 44px; padding: 0 6px; border-radius: 12px; cursor: pointer;
  background: var(--cc-panel-bg); border: 1px solid var(--cc-panel-border); color: var(--cc-cream-dim);
  font-size: 12px; font-weight: 700; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.05;
}
.cct-shot small { font-size: 9px; opacity: 0.6; font-weight: 600; }
.cct-shot.is-on { background: var(--cc-green-700); color: #fff; border-color: var(--cc-gold); box-shadow: 0 0 0 1px var(--cc-gold) inset; }
.cct-hint {
  position: absolute; right: calc(var(--cc-safe-right) + 12px); bottom: calc(var(--cc-safe-bottom) + 192px);
  font-size: 12px; padding: 5px 10px; border-radius: 99px; background: rgba(20,38,28,0.72); color: var(--cc-cream); display: none; max-width: 60vw; text-align: right;
}
.cct-hint.is-on { display: block; }

.cct-coach {
  position: absolute; left: 50%; top: calc(var(--cc-safe-top) + 12px); transform: translateX(-50%);
  max-width: min(420px, calc(100vw - 200px)); padding: 7px 12px; border-radius: 14px; font-size: 13.5px;
  background: rgba(255, 253, 246, 0.94); color: #21452F; border: 2px solid var(--cc-green-700); font-weight: 600;
  box-shadow: 0 6px 16px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.25s ease; pointer-events: none; text-align: center;
}
.cct-coach b { color: var(--cc-clay); margin-right: 4px; }
.cct-coach.is-on { opacity: 1; }
@media (max-width: 560px) { .cct-coach { top: auto; bottom: calc(var(--cc-safe-bottom) + 232px); max-width: calc(100vw - 32px); } }
@media (max-height: 520px) and (min-width: 561px) {
  .cct-coach { left: auto; right: calc(var(--cc-safe-right) + 12px); transform: none; top: calc(var(--cc-safe-top) + 62px); max-width: min(380px, calc(100vw - 360px)); }
}
.cct-pops { position: absolute; left: 0; right: 0; top: 24%; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.cct-pop {
  font-family: var(--cc-font-display); font-weight: 700; font-size: 30px; color: #fff; opacity: 0;
  text-shadow: 0 3px 12px rgba(0,0,0,0.55), 0 0 2px rgba(0,0,0,0.6); white-space: nowrap;
}
.cct-pop.is-go { animation: cct-pop 1.1s ease-out forwards; }
.cct-pop--perfect { color: #ffe066; font-size: 36px; }
.cct-pop--good { color: #bff0cc; }
.cct-pop--meh { color: var(--cc-cream); font-size: 24px; }
.cct-pop--bad { color: #ffb3a3; font-size: 24px; }
.cct-pop--call { color: #fff; font-size: 32px; letter-spacing: 1px; }
.cct-pop--big { color: var(--cc-gold); font-size: 38px; }
.cct-pop--small { font-size: 20px; color: var(--cc-cream); }
@keyframes cct-pop { 0% { opacity: 0; transform: translateY(10px) scale(0.85); } 12% { opacity: 1; transform: none; } 75% { opacity: 1; } 100% { opacity: 0; transform: translateY(-14px); } }

.cct-modal {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: auto;
  padding: calc(var(--cc-safe-top) + 14px) calc(var(--cc-safe-right) + 14px) calc(var(--cc-safe-bottom) + 14px) calc(var(--cc-safe-left) + 14px);
  background: radial-gradient(ellipse at 50% 40%, rgba(12, 30, 20, 0.35), rgba(6, 14, 10, 0.62));
}
.cct-modal.is-on { display: flex; animation: cct-fade 0.3s ease; }
@keyframes cct-fade { from { opacity: 0; } to { opacity: 1; } }
.cct-card { width: min(520px, 100%); max-height: 100%; overflow-y: auto; overscroll-behavior: contain; padding: 18px 18px 16px; display: flex; flex-direction: column; gap: 12px; }
.cct-card h2 { margin: 0; font-size: 24px; line-height: 1.1; }
.cct-sub { font-size: 13px; color: var(--cc-cream-dim); margin-top: 3px; }
.cct-sec { display: flex; flex-direction: column; gap: 7px; }
.cct-sec > .cc-label { color: var(--cc-gold); }
.cct-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.cct-big { min-height: 48px; font-size: 14px; }
.cct-seg { display: flex; gap: 6px; }
.cct-seg button { flex: 1; min-height: 44px; font-size: 13px; }
.cct-seg button[aria-pressed="true"], .cct-opt[aria-pressed="true"] { background: var(--cc-green-700); border-color: var(--cc-gold); color: #fff; }
.cct-opts { display: flex; gap: 6px; flex-wrap: wrap; }
.cct-opt { flex: 1 1 30%; min-height: 44px; font-size: 12.5px; }
.cct-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 10px; }
.cct-stat { font-size: 11px; color: var(--cc-cream-dim); text-transform: capitalize; }
.cct-stat b { color: var(--cc-cream); font-size: 13px; float: right; font-variant-numeric: tabular-nums; }
.cct-stat i { display: block; height: 4px; border-radius: 99px; background: rgba(244,232,193,0.12); margin-top: 3px; overflow: hidden; }
.cct-stat i span { display: block; height: 100%; background: linear-gradient(90deg, var(--cc-gold), #f2c14e); }
.cct-record { font-size: 12px; color: var(--cc-cream-dim); }
.cct-keys { font-size: 11.5px; color: var(--cc-cream-dim); line-height: 1.45; }
.cct-score { font-family: var(--cc-font-display); font-size: 28px; font-weight: 600; text-align: center; color: #fff4d2; letter-spacing: 1px; }
.cct-rgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cct-rstat { background: rgba(244,232,193,0.06); border: 1px solid rgba(244,232,193,0.1); border-radius: 10px; padding: 7px 9px; display: flex; justify-content: space-between; font-size: 13px; }
.cct-rstat b { font-variant-numeric: tabular-nums; }
.cct-xp { display: flex; flex-wrap: wrap; gap: 6px; }
.cct-chip { font-size: 12px; padding: 5px 9px; border-radius: 99px; background: rgba(244,232,193,0.08); border: 1px solid rgba(244,232,193,0.14); }
.cct-chip span { text-transform: capitalize; }
.cct-chip.is-up { background: rgba(217,164,65,0.25); border-color: var(--cc-gold); color: #fff4d2; font-weight: 700; }
.cct-tips { font-size: 13px; color: var(--cc-cream); font-style: italic; padding-left: 10px; border-left: 3px solid var(--cc-gold); }
.cct-btns { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; position: sticky; bottom: -16px; padding: 8px 0 2px; background: linear-gradient(180deg, rgba(20,38,28,0), rgba(20,38,28,0.95) 30%); }
.cct-btns button { min-height: 48px; font-size: 14px; }
.cct-results .cct-head { text-align: center; }
.cct-results.is-won h2 { color: var(--cc-gold); }
@media (max-width: 420px) {
  .cct-card { padding: 14px 12px 12px; gap: 10px; }
  .cct-stats { grid-template-columns: 1fr 1fr; }
  .cct-swing { width: 96px; height: 96px; }
  .cct-shot { min-width: 48px; }
}
@media (max-height: 520px) {
  .cct-shots { bottom: calc(var(--cc-safe-bottom) + 24px); right: calc(var(--cc-safe-right) + 160px); flex-direction: column; }
  .cct-meter { right: calc(var(--cc-safe-right) + 220px); }
  .cct-hint { bottom: calc(var(--cc-safe-bottom) + 136px); }
  .cct-pops { top: 16%; }
}
@media (prefers-reduced-motion: reduce) { .cct-pop.is-go { animation-duration: 0.01s; opacity: 1; } .cct-modal.is-on { animation: none; } }
`;

let injected = false;
function injectCSS() {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'cc-tennis-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const SHOT_NAMES = [['Flat', '1'], ['Topspin', '2'], ['Slice', '3'], ['Lob', '4'], ['Drop', '5']];
const METER_MAX = 1.3, METER_ZONE = [0.9, 1.06]; // serve meter: 1 = the ideal release
const RING_R = 55, RING_C = 2 * Math.PI * RING_R;

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export class TennisHUD {
  constructor(cb) {
    injectTheme();
    injectCSS();
    this.cb = cb;
    const ui = document.getElementById('ui-root') || document.body;
    const root = el('div', 'cct', ui);
    this.root = root;
    // Taps on our controls never reach the canvas (camera drag / world taps)
    for (const ev of ['pointerdown', 'touchstart', 'mousedown', 'wheel', 'click']) {
      root.addEventListener(ev, (e) => { if (e.target !== root) e.stopPropagation(); }, { passive: true });
    }
    this._buildPlay();
    this._buildMenu();
    this._buildResults();
    this._cache = { stam: -1, low: null, ring: -2, now: null, meter: -2, info: '', score: '', pow: -2, full: null, mom: -9, zone: null };
  }

  // ─────────────────────────── play UI ───────────────────────────

  _buildPlay() {
    const play = el('div', 'cct-play', this.root);
    this.play = play;
    const board = el('div', 'cc-panel cct-board', play);
    this.infoEl = el('div', 'cct-info', board);
    this.rowsEl = el('div', 'cct-rows', board);
    this.rows = [];
    for (let i = 0; i < 2; i++) {
      const dot = el('span', 'cct-dot', this.rowsEl);
      const name = el('span', 'cct-name', this.rowsEl, i === 0 ? 'You' : 'Rafa');
      const cells = el('span', 'cct-cells', this.rowsEl);
      this.rows.push({ dot, name, cells });
    }
    this.drillEl = el('div', 'cct-drill', board);
    const st = el('div', 'cct-stam', board);
    el('span', '', st, 'Stamina');
    this.stamBar = el('span', 'cct-stam__bar', st);
    this.stamFill = el('i', '', this.stamBar);
    this.momRow = el('div', 'cct-mom', board);
    el('span', '', this.momRow, 'Momentum');
    this.momBar = el('span', 'cct-mom__bar', this.momRow);
    this.momFill = el('i', '', this.momBar);
    this.momRow.title = 'Momentum: gold = yours, clay = Rafa\'s';

    const menuBtn = el('button', 'cct-menu-btn', play, 'Menu');
    menuBtn.type = 'button';
    menuBtn.setAttribute('aria-label', 'Tennis menu (ends the current drill or match)');
    menuBtn.addEventListener('click', () => this.cb.onMenu && this.cb.onMenu());

    // Shot selector
    const shots = el('div', 'cct-shots', play);
    shots.setAttribute('role', 'group');
    shots.setAttribute('aria-label', 'Shot type');
    this.shotBtns = SHOT_NAMES.map(([n, k], i) => {
      const b = el('button', 'cct-shot', shots);
      b.type = 'button';
      b.innerHTML = `${n}<small>${k}</small>`;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.cb.onShot && this.cb.onShot(i));
      return b;
    });
    this.setShot(1);

    this.hintEl = el('div', 'cct-hint', play);

    // Serve meter
    this.meter = el('div', 'cct-meter', play);
    el('div', 'cct-meter__zone', this.meter);
    this.meterFill = el('div', 'cct-meter__fill', this.meter);

    // SWING
    const sw = el('button', 'cct-swing', play);
    sw.type = 'button';
    sw.setAttribute('aria-label', 'Swing: hold to load power, release to hit');
    sw.innerHTML = `<span class="cct-pow"><i></i></span><svg class="cct-ring" viewBox="0 0 122 122"><circle class="bg" cx="61" cy="61" r="${RING_R}"/><circle class="fg" cx="61" cy="61" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${RING_C.toFixed(1)}"/></svg><b>SWING</b><small>hold · release</small>`;
    this.swingBtn = sw;
    this.powFill = sw.querySelector('.cct-pow i');
    this.ring = sw.querySelector('.cct-ring');
    this.ringFg = sw.querySelector('.fg');
    let pid = null;
    const down = (e) => {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId;
      try { sw.setPointerCapture(pid); } catch (err) { /* ignore */ }
      sw.classList.add('is-down');
      if (this.cb.onSwingDown) this.cb.onSwingDown();
    };
    const up = (e) => {
      if (pid === null || (e && e.pointerId !== pid)) return;
      pid = null;
      sw.classList.remove('is-down');
      if (this.cb.onSwingUp) this.cb.onSwingUp();
    };
    sw.addEventListener('pointerdown', down);
    sw.addEventListener('pointerup', up);
    sw.addEventListener('pointercancel', up);
    sw.addEventListener('lostpointercapture', up);
    sw.addEventListener('contextmenu', (e) => e.preventDefault());

    // Coach line (Rafa's tips, readable on phones)
    this.coachEl = el('div', 'cct-coach', this.root);
    this.coachEl.setAttribute('aria-live', 'polite');
    this._coachTimer = null;

    // Popups (pooled)
    const pops = el('div', 'cct-pops', this.root);
    pops.setAttribute('aria-live', 'polite');
    this.pops = [];
    for (let i = 0; i < 3; i++) this.pops.push(el('div', 'cct-pop', pops));
    this._popNext = 0;
  }

  show() { this.root.classList.add('is-on'); }
  hide() {
    this.root.classList.remove('is-on');
    document.body.classList.remove('cc-tennis-modal');
    this.hideMenu();
    this.hideResults();
    this.setPlayUi(false);
  }

  setPlayUi(on, mode) {
    this.root.classList.toggle('is-play', !!on);
    if (mode) {
      const match = mode === 'match';
      this.rowsEl.style.display = match ? '' : 'none';
      this.drillEl.style.display = match ? 'none' : '';
      this.momRow.classList.toggle('is-on', match);
      if (match) this.setMomentum(0, 0);
    }
    if (!on) { this.timing(-1); this.setMeter(-1); this.setPower(-1); this.setServeHint(false); }
  }

  setInfo(text) {
    if (text === this._cache.info) return;
    this._cache.info = text;
    this.infoEl.textContent = text;
  }

  /** Scoreboard from a TennisScore; server = 0 / 1. */
  setScore(sc, server) {
    const key = `${sc.sets.length}|${sc.games}|${sc.pts}|${sc.tiebreak}|${server}|${sc.setsWon}`;
    if (key === this._cache.score) return;
    this._cache.score = key;
    for (let i = 0; i < 2; i++) {
      const r = this.rows[i];
      r.dot.classList.toggle('is-on', server === i);
      let html = '';
      for (let k = 0; k < sc.sets.length; k++) html += `<span class="cct-cell">${sc.sets[k].g[i]}</span>`;
      if (!sc.done) {
        html += `<span class="cct-cell is-cur">${sc.games[i]}</span>`;
        html += `<span class="cct-cell is-pts">${sc.pointText(i) || '&nbsp;'}</span>`;
      }
      r.cells.innerHTML = html;
    }
  }

  setDrill(rep, total, score) {
    this.drillEl.textContent = `Ball ${Math.min(rep + 1, total)} / ${total}  ·  ${score} pts`;
  }

  setStamina(v) {
    const q = Math.round(v * 50) / 50;
    if (q === this._cache.stam) return;
    this._cache.stam = q;
    this.stamFill.style.transform = `scaleX(${q})`;
    const low = q < 0.3;
    if (low !== this._cache.low) { this._cache.low = low; this.stamBar.classList.toggle('is-low', low); }
  }

  setShot(i) {
    this.shotBtns.forEach((b, k) => {
      b.classList.toggle('is-on', k === i);
      b.setAttribute('aria-pressed', k === i ? 'true' : 'false');
    });
  }

  /** Timing ring: v < 0 hidden, 0..1 closing, ≥ 0.9 "now" (green). */
  timing(v, reachable = true) {
    const c = this._cache;
    if (v < 0) {
      if (c.ring !== -1) { c.ring = -1; this.ring.classList.remove('is-on', 'is-now'); c.now = null; }
      return;
    }
    const q = Math.round(Math.min(1, v) * 60) / 60;
    if (q !== c.ring) {
      if (c.ring < 0) this.ring.classList.add('is-on');
      c.ring = q;
      this.ringFg.setAttribute('stroke-dashoffset', (RING_C * (1 - q)).toFixed(1));
    }
    const now = v >= 0.9 && v <= 1.12 && reachable;
    if (now !== c.now) { c.now = now; this.ring.classList.toggle('is-now', now); }
  }

  /**
   * Serve toss meter: v < 0 hidden, else hold time / ideal hold (0 … 1.3). It rises while SWING
   * is held (more power); the green zone is the ideal release (the ball at racket height).
   */
  setMeter(v) {
    const c = this._cache;
    if (v < 0) {
      if (c.meter !== -1) { c.meter = -1; this.meter.classList.remove('is-on'); }
      return;
    }
    const q = Math.round(v * 100) / 100;
    if (q === c.meter) return;
    if (c.meter < 0) this.meter.classList.add('is-on');
    c.meter = q;
    this.meterFill.style.height = `calc(${Math.min(100, q / METER_MAX * 100).toFixed(1)}% - 6px)`;
    this.meterFill.classList.toggle('is-over', q > METER_ZONE[1]);
  }

  /** Stroke power inside the SWING button: v < 0 empty, else 0..1 (full = glowing). */
  setPower(v) {
    const c = this._cache;
    const q = v < 0 ? -1 : Math.round(Math.min(1, v) * 40) / 40;
    if (q === c.pow) return;
    c.pow = q;
    this.powFill.style.transform = `scaleY(${Math.max(0, q)})`;
    const full = q >= 0.98;
    if (full !== c.full) { c.full = full; this.swingBtn.classList.toggle('is-full', full); }
  }

  /** Momentum bar: yours minus Rafa's (−1 … 1); gold to the right, clay to the left. */
  setMomentum(mine, rafa) {
    const c = this._cache;
    const d = Math.round(Math.max(-1, Math.min(1, (mine - rafa) / 1.4)) * 30) / 30;
    if (d !== c.mom) {
      c.mom = d;
      this.momFill.classList.toggle('is-neg', d < 0);
      this.momFill.style.transform = `scaleX(${Math.abs(d).toFixed(3)})`;
    }
    const zone = mine >= 0.7;
    if (zone !== c.zone) { c.zone = zone; this.momBar.classList.toggle('is-zone', zone); }
  }

  setServeHint(on, second = false) {
    this.hintEl.classList.toggle('is-on', !!on);
    if (on) this.hintEl.textContent = second
      ? 'Second serve: hold SWING to toss, let go in the green · 2 = safe kick'
      : 'Your serve: hold SWING to toss, let go in the green · 1 flat · 2 kick · 3 slice · stick aims';
  }

  coach(text, sec = 2.8) {
    this.coachEl.innerHTML = '<b>Rafa</b>';
    this.coachEl.appendChild(document.createTextNode(text));
    this.coachEl.classList.add('is-on');
    if (this._coachTimer) clearTimeout(this._coachTimer);
    this._coachTimer = setTimeout(() => this.coachEl.classList.remove('is-on'), sec * 1000);
  }

  pop(text, kind = 'good') {
    const p = this.pops[this._popNext];
    this._popNext = (this._popNext + 1) % this.pops.length;
    p.className = 'cct-pop';
    void p.offsetWidth;
    p.textContent = text;
    p.className = `cct-pop cct-pop--${kind} is-go`;
  }

  // ─────────────────────────── menu ───────────────────────────

  _buildMenu() {
    const m = el('div', 'cct-modal', this.root);
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', 'After-hours tennis');
    const card = el('div', 'cc-panel cct-card', m);
    card.innerHTML = `
      <div><div class="cc-label" style="color:var(--cc-gold)">Court 1 · under the lights</div>
      <h2 class="cc-title">Evening hit with Coach Rafa</h2>
      <div class="cct-sub">No clock, no members. Just you, Rafa and a basket of balls.</div></div>
      <div class="cct-sec"><div class="cc-label">Your game</div><div class="cct-stats" data-m="stats"></div><div class="cct-record" data-m="record"></div></div>
      <div class="cct-sec"><div class="cc-label">Drills (Rafa feeds)</div>
        <div class="cct-grid2">
          <button type="button" class="cc-btn cct-big" data-drill="fh">Forehands</button>
          <button type="button" class="cc-btn cct-big" data-drill="bh">Backhands</button>
          <button type="button" class="cc-btn cct-big" data-drill="volley">Volleys</button>
          <button type="button" class="cc-btn cct-big" data-drill="serve">Serves</button>
        </div></div>
      <div class="cct-sec"><div class="cc-label">Practice match vs Rafa</div>
        <div class="cct-seg" data-m="format">
          <button type="button" class="cc-btn" data-v="short">Short set</button>
          <button type="button" class="cc-btn" data-v="set">1 set</button>
          <button type="button" class="cc-btn" data-v="bo3">Best of 3</button>
        </div>
        <div class="cct-seg" data-m="diff">
          <button type="button" class="cc-btn" data-v="easy">Easy</button>
          <button type="button" class="cc-btn" data-v="medium">Medium</button>
          <button type="button" class="cc-btn" data-v="hard">Hard</button>
        </div>
        <button type="button" class="cc-btn cc-btn--primary cct-big" data-m="play">Play match ▸</button>
      </div>
      <div class="cct-sec"><div class="cc-label">Options</div>
        <div class="cct-opts">
          <button type="button" class="cc-btn cct-opt" data-o="assist">Auto-move assist</button>
          <button type="button" class="cc-btn cct-opt" data-o="marker">Landing marker</button>
          <button type="button" class="cc-btn cct-opt" data-o="aim">Aim guide</button>
          <button type="button" class="cc-btn cct-opt" data-o="tips">Coach tips</button>
          <button type="button" class="cc-btn cct-opt" data-o="changeEnds">Change ends</button>
        </div>
        <div class="cct-keys">Move: joystick / WASD · Swing: hold SWING / Space / J as the ball comes to load power, let go when the ring turns green (the longer the hold, the harder the hit, the riskier) · Serve: hold to toss, let go in the green · Shots: buttons or 1–5 (Drop = touch shot, best from the net) · Aim: stick direction at contact (left / right, up = deep, down = short; short + wide = angle).</div>
      </div>
      <button type="button" class="cc-btn" data-m="leave" style="min-height:48px">Call it a night ▸ next day</button>`;
    this.menu = m;
    this.mq = {};
    for (const n of card.querySelectorAll('[data-m]')) this.mq[n.dataset.m] = n;
    this._fmt = 'short'; this._diff = 'easy';
    for (const b of card.querySelectorAll('[data-drill]')) b.addEventListener('click', () => this.cb.onStartDrill && this.cb.onStartDrill(b.dataset.drill));
    const seg = (name, set) => {
      for (const b of this.mq[name].querySelectorAll('button')) {
        b.addEventListener('click', () => { set(b.dataset.v); this._syncSeg(); });
      }
    };
    seg('format', (v) => { this._fmt = v; });
    seg('diff', (v) => { this._diff = v; });
    this.mq.play.addEventListener('click', () => this.cb.onStartMatch && this.cb.onStartMatch(this._fmt, this._diff));
    this.mq.leave.addEventListener('click', () => this.cb.onLeave && this.cb.onLeave());
    this.optBtns = [...card.querySelectorAll('[data-o]')];
    for (const b of this.optBtns) {
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (this.cb.onOption) this.cb.onOption(b.dataset.o, on);
      });
    }
  }

  _syncSeg() {
    for (const b of this.mq.format.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === this._fmt ? 'true' : 'false');
    for (const b of this.mq.diff.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === this._diff ? 'true' : 'false');
  }

  showMenu({ opts, last, profile } = {}) {
    if (last) { this._fmt = last.format; this._diff = last.diff; }
    this._syncSeg();
    for (const b of this.optBtns) b.setAttribute('aria-pressed', opts && opts[b.dataset.o] ? 'true' : 'false');
    this._fillProfile(profile);
    this.menu.classList.add('is-on');
    this._modal();
    try { this.mq.play.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  hideMenu() { this.menu.classList.remove('is-on'); this._blur(this.menu); this._modal(); }

  _modal() {
    const on = this.menu.classList.contains('is-on') || this.results.classList.contains('is-on');
    document.body.classList.toggle('cc-tennis-modal', on && this.root.classList.contains('is-on'));
  }

  _blur(scope) {
    const a = document.activeElement;
    if (a && scope.contains(a) && a.blur) a.blur();
  }

  _fillProfile(profile) {
    const st = profile ? profile.getTennisStats() : null;
    let html = '';
    for (const k of TENNIS_STATS) {
      const v = st ? st[k] : 30;
      html += `<div class="cct-stat">${k} <b>${v}</b><i><span style="width:${v}%"></span></i></div>`;
    }
    this.mq.stats.innerHTML = html;
    const r = profile && profile.record;
    this.mq.record.textContent = r ? `Record vs Rafa: ${r.wins}–${r.losses}${r.bestStreak ? ` · best streak ${r.bestStreak}` : ''} · drills done: ${r.drills}` : '';
  }

  // ─────────────────────────── results ───────────────────────────

  _buildResults() {
    const m = el('div', 'cct-modal', this.root);
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    const card = el('div', 'cc-panel cct-card cct-results', m);
    card.innerHTML = `
      <div class="cct-head"><div class="cc-label" style="color:var(--cc-gold)" data-r="kind"></div>
        <h2 class="cc-title" data-r="title"></h2><div class="cct-sub" data-r="sub"></div></div>
      <div class="cct-score" data-r="score"></div>
      <div class="cct-rgrid" data-r="stats"></div>
      <div class="cct-sec"><div class="cc-label">Practice XP</div><div class="cct-xp" data-r="xp"></div></div>
      <div class="cct-sec"><div class="cc-label">Coach Rafa says</div><div class="cct-tips" data-r="tips"></div></div>
      <div class="cct-record" data-r="record"></div>
      <div class="cct-btns">
        <button type="button" class="cc-btn cc-btn--primary" data-r="again">Rematch</button>
        <button type="button" class="cc-btn" data-r="mode">Change mode</button>
        <button type="button" class="cc-btn" data-r="done">Done</button>
      </div>`;
    this.results = m;
    this.resCard = card;
    this.rq = {};
    for (const n of card.querySelectorAll('[data-r]')) this.rq[n.dataset.r] = n;
    this.rq.again.addEventListener('click', () => this.cb.onRematch && this.cb.onRematch());
    this.rq.mode.addEventListener('click', () => this.cb.onChangeMode && this.cb.onChangeMode());
    this.rq.done.addEventListener('click', () => this.cb.onDone && this.cb.onDone());
  }

  showResults(d) {
    const q = this.rq;
    q.kind.textContent = d.kind === 'match' ? 'Practice match' : 'Drill complete';
    q.title.textContent = d.title;
    q.sub.textContent = d.sub || '';
    q.score.textContent = d.score || '';
    q.again.textContent = d.kind === 'match' ? 'Rematch' : 'Again';
    this.resCard.classList.toggle('is-won', !!d.won);
    q.stats.innerHTML = (d.stats || []).map(([k, v]) => `<div class="cct-rstat"><span>${k}</span><b>${v}</b></div>`).join('');
    const ups = new Map((d.ups || []).map(u => [u.stat, u]));
    let xp = '';
    for (const k of TENNIS_STATS) {
      const amt = d.xp ? d.xp[k] || 0 : 0;
      const up = ups.get(k);
      if (!amt && !up) continue;
      xp += up ? `<span class="cct-chip is-up"><span>${k}</span> ${up.from} → ${up.to} ▲</span>` : `<span class="cct-chip"><span>${k}</span> +${amt} XP</span>`;
    }
    q.xp.innerHTML = xp || '<span class="cct-chip">No XP this time</span>';
    q.tips.innerHTML = (d.tips || []).map(t => `“${t}”`).join('<br>');
    const r = d.record;
    q.record.textContent = r ? `Record vs Rafa: ${r.wins}–${r.losses} · drills done: ${r.drills}` : '';
    this.results.classList.add('is-on');
    this._modal();
    try { q.again.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  hideResults() { this.results.classList.remove('is-on'); this._blur(this.results); this._modal(); }
}
