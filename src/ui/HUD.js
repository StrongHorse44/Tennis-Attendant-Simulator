import { injectTheme, THEME } from './theme.js';
import { GAME, SIZES } from '../utils/Constants.js';

/**
 * HUD - mini-map, task list, time/weather, inventory, action button, radio dispatch,
 * notifications and the court-grooming overlay. All DOM (appended to #ui-root).
 *
 * Public API (unchanged): constructor(weather, missions, inventory), setActionButton(label, cb),
 * showNotification(text, duration), showRadioDispatch(mission, cb), updateTimeWeather(),
 * updateMiniMap(playerPos, npcs, cartPos, mapData), updateTaskList(), updateInventory(),
 * showGroomingHUD(), hideGroomingHUD(), updateGroomingHUD(progress), setGroomCameraActive(on),
 * onGroomCameraToggle (callback), update(dt).
 *
 * Additive:
 *   showNotification(text, duration, icon?)  — optional icon key (see ICONS) overrides auto-detect
 *   updateMiniMap(..., heading?)             — optional facing yaw in radians (three.js rotation.y
 *                                              convention: facing = (sin h, cos h) in world x/z).
 *                                              Without it the arrow follows the movement direction.
 *   hideRadioDispatch()
 *   Layout: the minimap occupies top-right, bottom edge at var(--cc-minimap-bottom); the pause
 *   button can sit directly below it (top: calc(var(--cc-minimap-bottom) + 8px)).
 */

// ─── Tiny inline icon set (24×24, stroke = currentColor) ───
const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  cart: svg('<path d="M4 6h13"/><path d="M6 6v7"/><path d="M15 6v7"/><path d="M3 13h16l1 3H3z"/><circle cx="7" cy="18.5" r="1.8"/><circle cx="16" cy="18.5" r="1.8"/><path d="M17 9h3l1 4"/>'),
  exit: svg('<path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>'),
  talk: svg('<path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8"/><path d="M8 12h5"/>'),
  help: svg('<path d="M4 5h16v10H9l-5 4z"/><path d="M12 7.5v3.5"/><circle cx="12" cy="13" r="0.6" fill="currentColor"/>'),
  brush: svg('<path d="M4 20l7-7"/><path d="M11 13l2-2 6 6-2 2z"/><path d="M13 19l4-4"/><path d="M15 21l4-4"/>'),
  groom: svg('<rect x="3" y="14" width="18" height="4" rx="1"/><path d="M5 18v2M9 18v2M13 18v2M17 18v2M21 18v2"/><path d="M12 14V4"/><path d="M9 4h6"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2.5"/>'),
  board: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4"/>'),
  pickup: svg('<path d="M4 9l8-4 8 4-8 4z"/><path d="M4 9v7l8 4 8-4V9"/><path d="M12 13v7"/>'),
  deliver: svg('<path d="M3 8l7-3.5L17 8l-7 3.5z"/><path d="M3 8v7l7 3.5"/><path d="M17 8v3"/><path d="M14 17l2.5 2.5L21 15"/>'),
  cooler: svg('<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M4 12h16"/><path d="M9 8V5h6v3"/><path d="M16 15h1"/>'),
  cups: svg('<path d="M6 5h12l-1.5 15h-9z"/><path d="M6.5 9h11"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 10"/>'),
  bell: svg('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  radio: svg('<rect x="6" y="7" width="12" height="14" rx="2.5"/><path d="M9 7V2.5"/><path d="M9 11h6M9 14h6M9 17h6"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>'),
  rain: svg('<path d="M7 14a4 4 0 0 1 .5-8A5.5 5.5 0 0 1 18 7.5a3.5 3.5 0 0 1-1 6.5z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>'),
  tasks: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8.5 11.5l1.5 1.5 2.5-2.5"/><path d="M8.5 17l1.5 1.5 2.5-2.5"/><path d="M14.5 12h1.5M14.5 17.5h1.5"/>'),
  chevron: svg('<path d="M8 10l4 4 4-4"/>'),
  timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9.5 2.5h5"/>'),
  speed: svg('<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>'),
  camera: svg('<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
};

/** Action-button label → icon key. */
function actionIconFor(label) {
  const l = label.toLowerCase();
  if (l.includes('exit') && l.includes('cart')) return 'exit';
  if (l.includes('cart')) return 'cart';
  if (l.includes('help')) return 'help';
  if (l.includes('talk')) return 'talk';
  if (l.includes('brush')) return 'brush';
  if (l.includes('stop')) return 'stop';
  if (l.includes('groom')) return 'groom';
  if (l.includes('board')) return 'board';
  if (l.includes('pick')) return 'pickup';
  if (l.includes('deliver')) return 'deliver';
  if (l.includes('cooler')) return 'cooler';
  if (l.includes('cup')) return 'cups';
  if (l.includes('trash')) return 'trash';
  return 'sparkle';
}

/** Notification text → icon key. */
function toastIconFor(text) {
  const t = text.toLowerCase();
  if (t.includes('picked up')) return 'pickup';
  if (t.includes('delivered')) return 'deliver';
  if (t.includes('new task') || t.includes('accepted') || t.includes('dispatch')) return 'board';
  if (t.includes('brush') || t.includes('groom')) return 'groom';
  if (t.includes('rain')) return 'rain';
  if (t.includes('done') || t.includes('complete') || t.includes('excellent') || t.includes('great')) return 'check';
  if (t.includes('cart')) return 'cart';
  return 'bell';
}

const MISSION_TYPE = {
  reservation: { color: THEME.gold, label: 'Reservation' },
  conflict: { color: '#ee8b78', label: 'Member issue' },
  errand: { color: '#7db5ee', label: 'Errand' },
  maintenance: { color: THEME.clay, label: 'Maintenance' },
  story: { color: '#f29cc4', label: 'Member story' },
};

const MINIMAP_CSS_SIZE = 136;
const HANK_ID = 'hank_morris';
const MINIMAP_INVOLVED = '#4fc3f7'; // members involved in an active mission
const MINIMAP_STAFF = '#9be7c4';    // club staff
const MINIMAP_HANK = '#ff8a3d';     // Hank, the grounds manager
const MINIMAP_INTERVAL = 1000 / 12;   // ~12 fps redraw
const GROOM_INTERVAL = 1000 / 10;     // ~10 fps DOM updates
const GROOM_PANEL_KEY = 'courtcall.groomPanel'; // sessionStorage: 'compact' | 'full'
const TOAST_MAX = 3;
const FLOAT_POOL = 6;
const CONFETTI_POOL = 28;

const CSS = `
:root {
  --cc-minimap-size: ${MINIMAP_CSS_SIZE}px;
  --cc-minimap-bottom: calc(var(--cc-safe-top) + 12px + ${MINIMAP_CSS_SIZE}px);
}
.cc-hud-left {
  position: fixed;
  top: calc(var(--cc-safe-top) + 12px);
  left: calc(var(--cc-safe-left) + 12px);
  width: min(290px, calc(100vw - var(--cc-safe-left) - var(--cc-safe-right) - ${MINIMAP_CSS_SIZE + 40}px));
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  z-index: 90;
  pointer-events: none;
}
.cc-hud-left > * { pointer-events: auto; }
.cc-glass {
  background: linear-gradient(180deg, rgba(31, 60, 43, 0.84), rgba(17, 34, 25, 0.86));
  border: 1px solid rgba(244, 232, 193, 0.16);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(10px) saturate(1.15);
  -webkit-backdrop-filter: blur(10px) saturate(1.15);
  color: var(--cc-cream);
  font-family: var(--cc-font-ui);
}
.cc-ico { display: inline-flex; width: 20px; height: 20px; flex: none; }
.cc-ico svg { width: 100%; height: 100%; }

/* Time & weather pill */
.cc-time {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 46px;
  padding: 5px 16px 5px 5px;
  border-radius: 999px;
}
.cc-time__icon {
  width: 36px; height: 36px;
  border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 19px;
  background: radial-gradient(circle at 40% 35%, rgba(244, 232, 193, 0.22), rgba(244, 232, 193, 0.06));
  border: 1px solid rgba(244, 232, 193, 0.18);
}
.cc-time__main { display: flex; flex-direction: column; line-height: 1.05; }
.cc-time__clock {
  font-family: var(--cc-font-display);
  font-weight: 600;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}
.cc-time__period {
  margin-top: 3px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.4px;
  text-transform: uppercase;
  color: var(--cc-gold);
}
/* Today's club event (EventSystem): a third line in the time pill */
.cc-time__event {
  display: none;
  margin-top: 2px;
  max-width: 150px;
  font-size: 11px;
  font-weight: 600;
  color: var(--cc-cream);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cc-time__event.is-on { display: block; }

/* Task panel */
.cc-tasks { width: 100%; border-radius: var(--cc-radius); overflow: hidden; }
.cc-tasks__head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 46px;
  padding: 6px 12px;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.cc-tasks__head:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: -2px; }
.cc-tasks__title { font-family: var(--cc-font-display); font-weight: 600; font-size: 15px; }
.cc-tasks__badge {
  min-width: 20px; height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--cc-gold);
  color: var(--cc-green-900);
  font-size: 11px; font-weight: 700;
}
.cc-tasks__badge--zero { background: rgba(244, 232, 193, 0.16); color: var(--cc-cream-dim); }
.cc-tasks__preview {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--cc-cream-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cc-tasks__chev { margin-left: auto; transition: transform 0.25s ease; opacity: 0.8; }
.cc-tasks--open .cc-tasks__chev { transform: rotate(180deg); }
.cc-tasks--open .cc-tasks__preview { visibility: hidden; }
.cc-tasks__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.28s ease;
}
.cc-tasks--open .cc-tasks__body { grid-template-rows: 1fr; }
.cc-tasks__inner { overflow: hidden; min-height: 0; }
.cc-tasks__list {
  display: flex; flex-direction: column; gap: 8px;
  padding: 0 10px 10px;
  max-height: calc(100vh - 260px);
  overflow-y: auto;
}
.cc-task {
  position: relative;
  padding: 10px 12px 10px 14px;
  border-radius: var(--cc-radius-sm);
  background: rgba(244, 232, 193, 0.06);
  border: 1px solid rgba(244, 232, 193, 0.08);
}
.cc-task::before {
  content: '';
  position: absolute;
  left: 0; top: 10px; bottom: 10px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--cc-task-accent, var(--cc-gold));
}
.cc-task__type {
  font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;
  color: var(--cc-task-accent, var(--cc-gold));
  margin-bottom: 2px;
}
.cc-task__title { font-weight: 600; font-size: 14px; line-height: 1.3; color: #fbf5e2; }
.cc-task__step {
  display: flex; gap: 6px;
  margin-top: 6px;
  font-size: 13px; line-height: 1.4;
  color: rgba(244, 232, 193, 0.85);
}
.cc-task__step::before { content: '\\25B8'; color: var(--cc-gold); flex: none; }
.cc-task__pips { display: flex; gap: 4px; margin-top: 8px; }
.cc-task__pip { width: 14px; height: 4px; border-radius: 2px; background: rgba(244, 232, 193, 0.16); }
.cc-task__pip--done { background: rgba(244, 232, 193, 0.55); }
.cc-task__pip--now { background: var(--cc-task-accent, var(--cc-gold)); }
.cc-tasks__empty { padding: 4px 4px 6px; font-size: 13px; line-height: 1.45; color: var(--cc-cream-dim); }

/* Minimap */
.cc-map {
  position: fixed;
  top: calc(var(--cc-safe-top) + 12px);
  right: calc(var(--cc-safe-right) + 12px);
  width: ${MINIMAP_CSS_SIZE}px;
  height: ${MINIMAP_CSS_SIZE}px;
  padding: 4px;
  border-radius: 24px;
  z-index: 90;
  background: linear-gradient(145deg, rgba(244, 232, 193, 0.9), rgba(217, 164, 65, 0.85) 55%, rgba(120, 90, 35, 0.9));
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
}
.cc-map__inner {
  position: relative;
  width: 100%; height: 100%;
  border-radius: 20px;
  overflow: hidden;
  background: #173a26;
  box-shadow: inset 0 0 0 2px rgba(23, 58, 38, 0.9);
}
.cc-map canvas { display: block; width: 100%; height: 100%; }
.cc-map__inner::after {
  content: '';
  position: absolute; inset: 0;
  border-radius: 20px;
  box-shadow: inset 0 0 14px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.cc-map__n {
  position: absolute;
  top: -3px; left: 50%;
  transform: translateX(-50%);
  width: 20px; height: 20px;
  border-radius: 50%;
  background: var(--cc-green-900);
  border: 1.5px solid var(--cc-gold);
  color: var(--cc-cream);
  font: 700 10px/17px var(--cc-font-ui);
  text-align: center;
  z-index: 1;
}

/* Action button */
.cc-action {
  position: fixed;
  right: calc(var(--cc-safe-right) + 24px);
  bottom: calc(var(--cc-safe-bottom) + 28px);
  width: 92px; height: 92px;
  border-radius: 50%;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 8px;
  z-index: 100;
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  color: var(--cc-green-900);
  background: radial-gradient(circle at 38% 30%, #fffaf0 0%, #f4e8c1 55%, #dccb95 100%);
  border: 3px solid var(--cc-green-700);
  box-shadow: 0 0 0 3px rgba(244, 232, 193, 0.55), 0 10px 24px rgba(0, 0, 0, 0.35), inset 0 -4px 8px rgba(120, 95, 40, 0.22);
  font-family: var(--cc-font-ui);
  transition: transform 0.12s ease, box-shadow 0.2s ease;
}
.cc-action:active { transform: scale(0.94); }
.cc-action:focus-visible { outline: 3px solid var(--cc-gold); outline-offset: 4px; }
.cc-action .cc-ico { width: 30px; height: 30px; color: var(--cc-green-700); }
.cc-action__label {
  max-width: 76px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
  line-height: 1.1;
  text-transform: uppercase;
  text-align: center;
}
.cc-action__key {
  position: absolute;
  top: -4px; right: -4px;
  min-width: 24px; height: 24px;
  padding: 0 6px;
  border-radius: 7px;
  background: var(--cc-green-900);
  border: 1px solid rgba(244, 232, 193, 0.4);
  color: var(--cc-cream);
  font: 700 11px/22px var(--cc-font-ui);
  display: none;
}
@media (hover: hover) and (pointer: fine) { .cc-action__key { display: block; } }
.cc-action::after {
  content: '';
  position: absolute; inset: -3px;
  border-radius: 50%;
  border: 3px solid var(--cc-gold);
  opacity: 0;
  pointer-events: none;
}
.cc-action--pulse::after { animation: cc-ring 0.9s ease-out 2; }
.cc-action--pulse { animation: cc-pop 0.35s cubic-bezier(0.3, 1.5, 0.5, 1); }
@keyframes cc-ring { 0% { opacity: 0.9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.35); } }
@keyframes cc-pop { 0% { transform: scale(0.7); } 100% { transform: scale(1); } }

/* Inventory */
.cc-inv {
  position: fixed;
  left: 0;
  right: 0;
  margin: 0 auto;
  width: max-content;
  bottom: calc(var(--cc-safe-bottom) + 24px);
  display: none;
  gap: 8px;
  padding: 6px;
  border-radius: 18px;
  z-index: 90;
}
.cc-inv__slot {
  position: relative;
  width: 52px; height: 52px;
  border-radius: 13px;
  display: flex; align-items: center; justify-content: center;
  font-size: 26px;
  background: radial-gradient(circle at 50% 35%, rgba(244, 232, 193, 0.2), rgba(244, 232, 193, 0.05));
  border: 1px solid rgba(244, 232, 193, 0.28);
}
.cc-inv__slot--new { animation: cc-pop 0.35s cubic-bezier(0.3, 1.5, 0.5, 1); }
.cc-inv__name {
  position: absolute;
  left: 50%; bottom: -3px;
  transform: translate(-50%, 100%);
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(17, 34, 25, 0.85);
  color: var(--cc-cream);
  font: 600 10px/1.3 var(--cc-font-ui);
  white-space: nowrap;
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.cc-inv__slot:hover .cc-inv__name, .cc-inv__slot--new .cc-inv__name { opacity: 1; }
.cc-inv__cap {
  align-self: center;
  padding: 0 4px 0 2px;
  font: 600 11px var(--cc-font-ui);
  color: var(--cc-cream-dim);
  font-variant-numeric: tabular-nums;
}

/* Toasts */
.cc-toasts {
  /* centred without a transform: a transformed parent breaks backdrop-filter on the toasts */
  position: fixed;
  top: calc(var(--cc-safe-top) + 14px);
  left: 0;
  right: 0;
  margin: 0 auto;
  width: min(420px, calc(100vw - 2 * ${MINIMAP_CSS_SIZE + 40}px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 220;
  pointer-events: none;
}
.cc-toasts--below { top: var(--cc-radio-bottom, calc(var(--cc-safe-top) + 104px)); }
.cc-toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 9px 16px 9px 9px;
  border-radius: 16px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.35;
  color: #fbf5e2;
  background: linear-gradient(180deg, rgba(34, 64, 46, 0.95), rgba(19, 38, 27, 0.96));
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  opacity: 0;
  transform: translateY(-10px) scale(0.97);
  transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.cc-toast--in { opacity: 1; transform: none; }
.cc-toast--out { opacity: 0; transform: translateY(-8px) scale(0.97); }
.cc-toast__ico {
  width: 30px; height: 30px;
  flex: none;
  border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: rgba(217, 164, 65, 0.2);
  color: var(--cc-gold);
}
.cc-toast__ico svg { width: 18px; height: 18px; }

/* Radio dispatch — walkie-talkie card */
.cc-radio {
  position: fixed;
  top: calc(var(--cc-safe-top) + 12px);
  left: 50%;
  transform: translateX(-50%);
  width: min(360px, calc(100vw - 2 * ${MINIMAP_CSS_SIZE + 40}px));
  min-height: 80px;
  display: none;
  align-items: stretch;
  gap: 12px;
  padding: 10px 14px 10px 10px;
  border-radius: 18px;
  cursor: pointer;
  z-index: 95;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  color: var(--cc-cream);
  font-family: var(--cc-font-ui);
  text-align: left;
  background: linear-gradient(180deg, #2c302d, #1a1d1b);
  border: 1px solid rgba(217, 164, 65, 0.5);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  animation: cc-radio-in 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.3);
}
.cc-radio:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 3px; }
@keyframes cc-radio-in {
  0% { opacity: 0; transform: translate(-50%, -14px) rotate(-2deg); }
  60% { opacity: 1; transform: translate(-50%, 2px) rotate(1deg); }
  100% { transform: translate(-50%, 0) rotate(0); }
}
.cc-radio__device {
  position: relative;
  flex: none;
  width: 40px;
  margin-top: 8px;
  border-radius: 8px;
  background: linear-gradient(180deg, #3b3f3c, #262926);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.cc-radio__device::before {
  /* antenna */
  content: '';
  position: absolute;
  left: 7px; top: -14px;
  width: 5px; height: 16px;
  border-radius: 3px 3px 0 0;
  background: #454a46;
}
.cc-radio__grille {
  position: absolute;
  left: 7px; right: 7px; top: 20px; bottom: 8px;
  border-radius: 4px;
  background: repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.55) 0 2px, rgba(255, 255, 255, 0.08) 2px 4px);
}
.cc-radio__led {
  position: absolute;
  right: 7px; top: 7px;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #ff5a45;
  box-shadow: 0 0 8px #ff5a45;
  animation: cc-blink 1s steps(2, jump-none) infinite;
}
@keyframes cc-blink { 0% { opacity: 1; } 100% { opacity: 0.25; } }
.cc-radio__body { display: flex; flex-direction: column; justify-content: center; min-width: 0; gap: 2px; }
.cc-radio__ch {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--cc-gold);
}
.cc-radio__wave { display: inline-flex; gap: 2px; align-items: flex-end; height: 10px; }
.cc-radio__wave i { width: 2px; background: var(--cc-gold); border-radius: 1px; animation: cc-wave 0.8s ease-in-out infinite; }
.cc-radio__wave i:nth-child(1) { height: 4px; animation-delay: 0s; }
.cc-radio__wave i:nth-child(2) { height: 9px; animation-delay: 0.15s; }
.cc-radio__wave i:nth-child(3) { height: 6px; animation-delay: 0.3s; }
@keyframes cc-wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }
.cc-radio__title {
  font-family: var(--cc-font-display);
  font-weight: 600;
  font-size: 16px;
  line-height: 1.2;
  color: #fbf5e2;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.cc-radio__cta { font-size: 12px; font-weight: 600; color: var(--cc-cream-dim); }
.cc-radio__cta b { color: var(--cc-cream); }

/* Grooming panel */
.cc-groom {
  display: none;
  width: 100%;
  padding: 12px;
  border-radius: var(--cc-radius);
  border-color: rgba(200, 102, 60, 0.55);
}
.cc-groom__head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.cc-groom__head .cc-ico { color: var(--cc-clay); width: 20px; height: 20px; }
.cc-groom__title { font-family: var(--cc-font-display); font-weight: 600; font-size: 15px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-groom__timer {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(244, 232, 193, 0.1);
  font-size: 12px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.cc-groom__timer .cc-ico { width: 13px; height: 13px; color: var(--cc-cream-dim); }
.cc-groom__cam {
  flex: none;
  width: 44px; height: 44px; margin: -8px -6px -8px 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(244, 232, 193, 0.25);
  border-radius: 999px;
  background: rgba(244, 232, 193, 0.08);
  color: var(--cc-cream);
  cursor: pointer;
  touch-action: manipulation;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.cc-groom__cam .cc-ico { width: 18px; height: 18px; }
.cc-groom__cam[aria-pressed="true"] { background: var(--cc-clay); border-color: var(--cc-gold); }
.cc-groom__top { display: flex; align-items: center; gap: 12px; }
.cc-ring { position: relative; width: 64px; height: 64px; flex: none; }
.cc-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.cc-ring__bg { stroke: rgba(244, 232, 193, 0.12); }
.cc-ring__fg { transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease; }
.cc-ring__val {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  line-height: 1;
}
.cc-ring__val b { font-family: var(--cc-font-display); font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cc-ring__val span { margin-top: 2px; font-size: 8.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--cc-cream-dim); }
.cc-groom__stats { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.cc-groom__row { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; color: var(--cc-cream-dim); }
.cc-groom__row b { color: var(--cc-cream); font-variant-numeric: tabular-nums; }
.cc-bar { height: 6px; border-radius: 3px; background: rgba(244, 232, 193, 0.12); overflow: hidden; }
.cc-bar__fill { height: 100%; width: 0%; border-radius: 3px; background: linear-gradient(90deg, var(--cc-clay), var(--cc-gold)); transition: width 0.3s ease; }
.cc-speed {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 4px 8px;
  border-radius: 8px;
  font-size: 11.5px; font-weight: 700;
  font-variant-numeric: tabular-nums;
  transition: background 0.2s ease, color 0.2s ease;
}
.cc-speed .cc-ico { width: 14px; height: 14px; }
.cc-speed span { white-space: nowrap; }
.cc-speed--ok { background: rgba(76, 175, 106, 0.2); color: #8fe0a6; }
.cc-speed--bad { background: rgba(224, 90, 71, 0.25); color: #ffb3a6; }
.cc-groom__sec {
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px solid rgba(244, 232, 193, 0.1);
}
.cc-groom__sec .cc-label { display: block; margin-bottom: 6px; font-size: 10px; }
.cc-gauge { margin-bottom: 7px; }
.cc-gauge:last-child { margin-bottom: 0; }
.cc-gauge__top { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; margin-bottom: 4px; }
.cc-gauge__name { color: var(--cc-cream-dim); font-weight: 600; }
.cc-gauge__val { font-weight: 700; font-variant-numeric: tabular-nums; }
.cc-gauge__track { position: relative; height: 8px; border-radius: 4px; opacity: 0.9; }
.cc-gauge__mark {
  position: absolute;
  top: -3px;
  width: 4px; height: 14px;
  margin-left: -2px;
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 0 0 1.5px rgba(23, 58, 38, 0.9), 0 1px 4px rgba(0, 0, 0, 0.4);
  transition: left 0.15s linear;
}
.cc-gauge--none .cc-gauge__track { opacity: 0.25; }
.cc-gauge--none .cc-gauge__mark { display: none; }
.cc-gauge--none .cc-gauge__val { color: var(--cc-cream-dim); font-weight: 500; }
.cc-check { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.cc-check li { display: flex; align-items: center; gap: 7px; font-size: 12px; line-height: 1.3; color: rgba(244, 232, 193, 0.92); }
.cc-check__box {
  flex: none;
  width: 16px; height: 16px;
  border-radius: 5px;
  border: 1.5px solid rgba(244, 232, 193, 0.45);
  display: inline-flex; align-items: center; justify-content: center;
}
.cc-check li.cc-check--done { color: rgba(244, 232, 193, 0.45); text-decoration: line-through; }
.cc-check--done .cc-check__box { background: var(--cc-ok); border-color: var(--cc-ok); }
.cc-check--done .cc-check__box::after {
  content: '';
  width: 7px; height: 4px;
  border-left: 2px solid #fff; border-bottom: 2px solid #fff;
  transform: translateY(-1px) rotate(-45deg);
}

/* Grooming panel: details toggle + compact strip (default on phones; see _groomCompact) */
.cc-groom__more {
  flex: none;
  width: 44px; height: 44px; margin: -8px -6px -8px 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid rgba(244, 232, 193, 0.25);
  border-radius: 999px;
  background: rgba(244, 232, 193, 0.08);
  color: var(--cc-cream);
  cursor: pointer;
  touch-action: manipulation;
}
.cc-groom__more .cc-ico { width: 20px; height: 20px; transition: transform 0.25s ease; transform: rotate(180deg); }
.cc-groom--compact .cc-groom__more .cc-ico { transform: none; }
.cc-groom__pills { display: none; flex-wrap: wrap; align-items: center; gap: 4px 5px; min-width: 0; }
.cc-groom__pill {
  display: inline-flex; align-items: center; gap: 5px;
  min-width: 0; max-width: 100%;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 11px; font-weight: 700; line-height: 1.25;
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: rgba(244, 232, 193, 0.1); color: var(--cc-cream-dim);
  transition: background 0.2s ease, color 0.2s ease;
}
.cc-groom__pill::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.cc-groom__pill--optimal { background: rgba(76, 175, 106, 0.24); color: #8fe0a6; }
.cc-groom__pill--warn { background: rgba(217, 164, 65, 0.26); color: #f3cd7e; }
.cc-groom__pill--danger, .cc-groom__pill--far { background: rgba(224, 90, 71, 0.3); color: #ffb3a6; }
/* Compact strip (~85px tall):  [ring] [coverage bar  0%] ([cam]) [more·badge]
                                [ring] [fence / net pill ················]   */
.cc-hud-left--grooming .cc-groom.cc-groom--compact {
  display: grid !important;
  grid-template-columns: 40px minmax(0, 1fr) 44px;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 5px 6px;
  padding: 7px 8px 8px 9px;
}
.cc-groom--compact .cc-groom__head, .cc-groom--compact .cc-groom__top { display: contents; }
.cc-groom--compact .cc-groom__head > .cc-ico, .cc-groom--compact .cc-groom__title,
.cc-groom--compact .cc-groom__timer, .cc-groom--compact .cc-groom__sec,
.cc-groom--compact .cc-groom__cam { display: none; }
.cc-groom--compact .cc-groom__more { grid-column: -2; grid-row: 1; margin: 0; }
.cc-groom.cc-groom--compact .cc-ring { grid-column: 1; grid-row: 1 / span 2; width: 40px; height: 40px; }
.cc-groom.cc-groom--compact .cc-ring__val b { font-size: 12px; }
.cc-groom--compact .cc-ring__val span { display: none; }
.cc-hud-left--grooming .cc-groom--compact .cc-groom__stats {
  grid-column: 2; grid-row: 1; width: auto;
  flex-direction: row; flex-wrap: wrap; align-items: center; gap: 4px 7px;
}
.cc-groom--compact .cc-groom__stats .cc-bar { order: 0; flex: 1 1 30px; }
.cc-groom--compact .cc-groom__row { order: 1; flex: none; }
.cc-groom--compact .cc-groom__row span { display: none; }
.cc-groom--compact .cc-speed { order: 2; flex: 1 0 100%; padding: 2px 6px; font-size: 10.5px; }
.cc-groom--compact .cc-speed--ok { display: none; }   /* speed only when it matters */
.cc-groom--compact .cc-groom__pills { display: flex; grid-column: 2 / -1; grid-row: 2; }
.cc-groom__badge {
  display: none;
  position: absolute; top: -5px; right: -6px;
  min-width: 18px; padding: 1px 5px;
  border-radius: 999px;
  background: var(--cc-gold); color: #1d2a21;
  font-size: 10px; font-weight: 800; line-height: 14px;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.cc-groom__badge--done { background: var(--cc-ok); color: #fff; }
.cc-groom--compact .cc-groom__more { position: relative; }
.cc-groom--compact .cc-groom__badge:not(:empty) { display: block; }
/* Room for the camera button too (most phones are ≥ 400px wide, and all larger screens) */
@media (min-width: 400px) {
  .cc-hud-left--grooming .cc-groom.cc-groom--compact { grid-template-columns: 40px minmax(0, 1fr) 44px 44px; }
  .cc-groom--compact .cc-groom__cam { display: inline-flex; grid-column: 3; grid-row: 1; margin: 0; }
}

/* ─── Narrow screens (phones, portrait) ─── */
@media (max-width: 640px) {
  /* full panel header must fit ~200px: drop the title text, keep icon + timer + buttons */
  .cc-groom__title { display: none; }
  .cc-groom__head { gap: 6px; }
  .cc-groom__head .cc-groom__timer { margin-right: auto; }
  .cc-groom__timer .cc-ico { display: none; }
  .cc-toasts, .cc-toasts--below {
    top: calc(var(--cc-safe-top) + 8px);
    width: calc(100vw - 20px - var(--cc-safe-left) - var(--cc-safe-right));
  }
  .cc-toast { width: 100%; padding: 7px 14px 7px 7px; font-size: 13.5px; }
  .cc-toast:nth-last-child(n+3) { display: none; }
  .cc-tasks:not(.cc-tasks--open) { width: auto; }
  .cc-tasks:not(.cc-tasks--open) .cc-tasks__body { display: none; }
  .cc-tasks__preview { display: none; }
  .cc-tasks__chev { margin-left: 4px; }
  .cc-wide-only { display: none; }
  .cc-speed .cc-ico { display: none; }
  .cc-speed { font-size: 11px; padding: 4px 6px; }
  .cc-radio {
    position: static;
    transform: none;
    width: 100%;
    min-height: 72px;
    animation-name: cc-radio-in-static;
  }
  @keyframes cc-radio-in-static {
    0% { opacity: 0; transform: translateY(-10px); }
    100% { opacity: 1; transform: none; }
  }
  .cc-radio__title { font-size: 14.5px; }
  .cc-inv {
    left: auto;
    right: calc(var(--cc-safe-right) + 30px);
    margin: 0;
    bottom: calc(var(--cc-safe-bottom) + 136px);
    flex-direction: column-reverse;
    gap: 6px;
    padding: 5px;
  }
  .cc-inv__slot { width: 46px; height: 46px; font-size: 23px; }
  .cc-inv__cap { padding: 0; text-align: center; }
  .cc-inv__name { left: auto; right: calc(100% + 6px); bottom: 50%; transform: translateY(50%); }
  .cc-action { width: 86px; height: 86px; }
}
@media (max-height: 520px) {
  .cc-tasks__list { max-height: calc(100vh - 150px); }
}
/* ─── Short landscape (phones on their side): the stacked 290px panel would run off
   the bottom and under the joystick, so lay it out as one wide, short strip ─── */
@media (max-height: 520px) and (min-width: 560px) {
  .cc-hud-left--grooming .cc-tasks { display: none; }
  .cc-hud-left--grooming .cc-groom {
    display: grid !important;
    grid-template-columns: auto minmax(104px, 1fr) minmax(0, 1.35fr);
    align-items: start;
    column-gap: 12px;
    width: min(600px, calc(100vw - var(--cc-safe-left) - var(--cc-safe-right) - var(--cc-minimap-size) - 44px));
    padding: 9px 12px 10px;
    /* never reach the joystick (bottom 24 + 132 + margin), scroll inside if the screen is tiny */
    max-height: calc(100vh - var(--cc-safe-top) - var(--cc-safe-bottom) - 66px - 170px);
    overflow-y: auto;
  }
  .cc-hud-left--grooming .cc-groom__head { grid-column: 1 / -1; margin-bottom: 7px; }
  .cc-hud-left--grooming .cc-groom__top { gap: 10px; }
  .cc-hud-left--grooming .cc-ring { width: 54px; height: 54px; }
  .cc-hud-left--grooming .cc-ring__val b { font-size: 15px; }
  .cc-hud-left--grooming .cc-groom__stats { width: 104px; flex: none; gap: 5px; }
  .cc-hud-left--grooming .cc-groom__sec {
    margin-top: 0; padding-top: 0; border-top: 0;
    padding-left: 12px; border-left: 1px solid rgba(244, 232, 193, 0.1);
    min-width: 0;
  }
  .cc-hud-left--grooming .cc-groom__sec .cc-label { margin-bottom: 4px; }
  .cc-hud-left--grooming .cc-gauge { margin-bottom: 5px; }
  .cc-hud-left--grooming .cc-check { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 10px; }
  .cc-hud-left--grooming .cc-check li { font-size: 11.5px; min-width: 0; }
  .cc-hud-left--grooming .cc-check li > span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cc-hud-left--grooming .cc-groom.cc-groom--compact {
    width: min(320px, calc(100vw - var(--cc-safe-left) - var(--cc-safe-right) - var(--cc-minimap-size) - 44px));
    padding: 7px 8px 8px 9px;
  }
}
/* Status row: clock pill + wallet */
.cc-hud-row { display: flex; align-items: center; gap: 8px; max-width: 100%; }
.cc-hud-row > * { pointer-events: auto; }
.cc-wallet {
  display: flex; align-items: center; gap: 7px;
  min-height: 46px; padding: 5px 14px 5px 6px;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
  transition: transform 0.2s ease, border-color 0.2s ease;
}
.cc-wallet__coin {
  display: grid; place-items: center; flex: none;
  width: 32px; height: 32px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #f7d98a, var(--cc-gold) 60%, #a97a23);
  color: var(--cc-green-900); font-weight: 800; font-size: 16px;
  box-shadow: inset 0 -2px 0 rgba(0,0,0,0.18);
}
.cc-wallet__amt { font-family: var(--cc-font-display); font-weight: 600; font-size: 18px; color: #fbf5e2; }
.cc-wallet--up { border-color: rgba(217, 164, 65, 0.7); transform: scale(1.06); }

/* Radio card actions + answer timer */
.cc-radio { cursor: default; overflow: hidden; }
.cc-radio__actions { display: flex; gap: 8px; margin-top: 6px; }
.cc-radio__actions:empty { display: none; }
.cc-radio__btn { min-height: 44px; padding: 8px 16px; font-size: 14px; flex: 1 1 auto; }
.cc-radio__timer { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(244,232,193,0.12); }
.cc-radio__timer i { display: block; height: 100%; background: var(--cc-gold); transform-origin: left; }

/* Floating "+$X" and confetti */
.cc-fx { position: fixed; inset: 0; pointer-events: none; z-index: 230; overflow: hidden; }
.cc-float {
  position: absolute; left: 0; top: 0; opacity: 0;
  transform: translate(-50%, 0);
  padding: 4px 10px; border-radius: 999px;
  font: 700 17px/1 var(--cc-font-display);
  color: #fff7dc; background: rgba(23, 58, 38, 0.82);
  border: 1px solid rgba(217, 164, 65, 0.7);
  text-shadow: 0 1px 2px rgba(0,0,0,0.4);
  white-space: nowrap;
}
.cc-float--tip { color: #ffe39a; }
.cc-float--wage { color: var(--cc-cream); }
.cc-float--go { animation: cc-float-up 1.6s cubic-bezier(0.2, 0.8, 0.3, 1) forwards; }
@keyframes cc-float-up {
  0% { opacity: 0; transform: translate(-50%, 8px) scale(0.8); }
  15% { opacity: 1; transform: translate(-50%, -6px) scale(1.08); }
  70% { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -70px) scale(1); }
}
.cc-confetto {
  position: absolute; left: 50%; top: 30%;
  width: 8px; height: 12px; border-radius: 2px;
  background: var(--c); opacity: 0;
}
.cc-confetto:nth-child(3n) { width: 6px; height: 6px; border-radius: 50%; }
.cc-confetto--go { animation: cc-confetti var(--d, 1.2s) cubic-bezier(0.15, 0.7, 0.4, 1) forwards; }
@keyframes cc-confetti {
  0% { opacity: 1; transform: translate(-50%, 0) rotate(0); }
  70% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(var(--dy) + 140px)) rotate(var(--r)); }
}
@media (max-width: 640px) {
  .cc-wallet { min-height: 40px; padding: 3px 10px 3px 4px; gap: 5px; }
  .cc-wallet__coin { width: 28px; height: 28px; font-size: 14px; }
  .cc-wallet__amt { font-size: 16px; }
  .cc-radio { position: relative; left: auto; top: auto; }
  .cc-radio__btn { padding: 8px 10px; }
  .cc-radio__cta { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
}

@media (prefers-reduced-motion: reduce) {
  .cc-float--go, .cc-wallet { animation-duration: 0.01s; transition: none; }
  .cc-action--pulse, .cc-action--pulse::after, .cc-radio, .cc-radio__led, .cc-radio__wave i, .cc-inv__slot--new { animation: none; }
}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.id = 'cc-hud-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el(tag, className, parent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (parent) parent.appendChild(e);
  return e;
}

function icon(name, parent) {
  const s = el('span', 'cc-ico', parent);
  s.innerHTML = ICONS[name] || ICONS.sparkle;
  return s;
}

export class HUD {
  constructor(weatherSystem, missionSystem, inventorySystem) {
    this.weather = weatherSystem;
    this.missions = missionSystem;
    this.inventory = inventorySystem;

    this.container = null;
    this.timeWeatherEl = null;
    this.miniMapCanvas = null;
    this.miniMapCtx = null;
    this.actionButton = null;
    this.actionCallback = null;
    this.taskListEl = null;
    this.taskListOpen = false;
    this.inventoryEl = null;
    this.radioIndicator = null;
    this.radioCallback = null;
    this.notificationEl = null;   // toast stack container
    this.notificationTimer = 0;   // seconds left on the newest toast

    // Grooming HUD
    this.groomingOverlay = null;
    this.groomCoverageBar = null;
    this.groomCoverageText = null;
    this.groomSpeedIndicator = null;
    this.groomTimerText = null;
    this.groomProximityEl = null;
    this.groomTaskListEl = null;

    // Internal caches (avoid DOM churn every frame)
    this._actionLabel = null;
    this._timeKey = '';
    this._toasts = [];
    this._mapLast = 0;
    this._mapStatic = null;
    this._mapStaticFor = null;
    this._mapXform = { cx: 0, cz: 0, s: 1, size: MINIMAP_CSS_SIZE };
    this._mapDpr = 1;
    this._heading = 0;
    this._headingValid = false;
    this._lastPX = NaN;
    this._lastPZ = NaN;
    this._groomLast = 0;
    this._groomCache = { clean: -1, cover: -1, speed: '', speedOk: null, time: '', fence: '', net: '', tasks: '' };
    this._tasksWasOpen = false;
    this._invCount = 0;

    injectTheme();
    injectCSS();
    this._create();
    this._setupTaskListSwipe();
  }

  _create() {
    const ui = document.getElementById('ui-root');
    this.container = ui;

    // ── Left column: time pill, radio (narrow screens), tasks, grooming ──
    this._leftCol = el('div', 'cc-hud-left', ui);

    const statusRow = el('div', 'cc-hud-row', this._leftCol);
    this.timeWeatherEl = el('div', 'cc-glass cc-time', statusRow);
    this._timeIconEl = el('span', 'cc-time__icon', this.timeWeatherEl);
    const tMain = el('span', 'cc-time__main', this.timeWeatherEl);
    this._timeClockEl = el('span', 'cc-time__clock', tMain);
    this._timePeriodEl = el('span', 'cc-time__period', tMain);
    this._timeEventEl = el('span', 'cc-time__event', tMain);

    // Wallet (ticks up toward the real balance in update())
    this.walletEl = el('div', 'cc-glass cc-wallet', statusRow);
    this.walletEl.setAttribute('role', 'status');
    this.walletEl.setAttribute('aria-label', 'Wallet');
    const coin = el('span', 'cc-wallet__coin', this.walletEl);
    coin.textContent = '$';
    this._walletTextEl = el('span', 'cc-wallet__amt', this.walletEl);
    this._walletTextEl.textContent = '0';
    this._walletTarget = 0;
    this._walletShown = 0;
    this._walletText = '0';

    // Radio card (walkie-talkie): dispatches with On it / Busy, the manager's clock-in and
    // closing calls. Fixed top-centre on wide screens; flows in the left column on phones.
    this.radioIndicator = el('div', 'cc-radio', this._leftCol);
    this.radioIndicator.setAttribute('role', 'group');
    const dev = el('span', 'cc-radio__device', this.radioIndicator);
    el('span', 'cc-radio__grille', dev);
    el('span', 'cc-radio__led', dev);
    const rBody = el('span', 'cc-radio__body', this.radioIndicator);
    const ch = el('span', 'cc-radio__ch', rBody);
    ch.innerHTML = '<span class="cc-radio__wave"><i></i><i></i><i></i></span>';
    this._radioChEl = el('span', '', ch);
    this._radioTitleEl = el('span', 'cc-radio__title', rBody);
    this._radioCtaEl = el('span', 'cc-radio__cta', rBody);
    this._radioActionsEl = el('span', 'cc-radio__actions', rBody);
    this._radioTimerEl = el('span', 'cc-radio__timer', this.radioIndicator);
    this._radioTimerFill = el('i', '', this._radioTimerEl);
    this._radioKind = null;
    this._radioTimerFrac = -1;
    // (DOM overlay: taps never reach the canvas listeners, and window-level listeners
    // such as the audio unlock still see them.)

    // Tasks (collapsible)
    this.taskListEl = el('div', 'cc-glass cc-tasks', this._leftCol);
    this._taskHead = el('button', 'cc-tasks__head', this.taskListEl);
    this._taskHead.type = 'button';
    this._taskHead.setAttribute('aria-expanded', 'false');
    icon('tasks', this._taskHead).style.color = 'var(--cc-gold)';
    const tt = el('span', 'cc-tasks__title', this._taskHead);
    tt.textContent = 'Tasks';
    this._taskBadge = el('span', 'cc-tasks__badge cc-tasks__badge--zero', this._taskHead);
    this._taskBadge.textContent = '0';
    this._taskPreview = el('span', 'cc-tasks__preview', this._taskHead);
    const chev = icon('chevron', this._taskHead);
    chev.classList.add('cc-tasks__chev');
    this._taskHead.addEventListener('click', () => this._toggleTaskList());
    const body = el('div', 'cc-tasks__body', this.taskListEl);
    const inner = el('div', 'cc-tasks__inner', body);
    this.taskListContent = el('div', 'cc-tasks__list', inner);
    // Kept for compatibility (old code toggled a side tab)
    this.taskListTab = this._taskHead;

    // Grooming overlay
    this._createGroomingPanel(this._leftCol);

    // ── Minimap (top-right) ──
    const map = el('div', 'cc-map', ui);
    const mapInner = el('div', 'cc-map__inner', map);
    const n = el('div', 'cc-map__n', map);
    n.textContent = 'N';
    this.miniMapCanvas = el('canvas', '', mapInner);
    this._mapDpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const px = Math.round((MINIMAP_CSS_SIZE - 8) * this._mapDpr);
    this.miniMapCanvas.width = px;
    this.miniMapCanvas.height = px;
    this._mapXform.size = MINIMAP_CSS_SIZE - 8;
    this.miniMapCtx = this.miniMapCanvas.getContext('2d');
    this._mapEl = map;
    this.miniMapContainer = map; // pause-button anchor (main.js)

    // ── Action button (bottom-right) ──
    this.actionButton = el('button', 'cc-action', ui);
    this.actionButton.type = 'button';
    this._actionIconEl = icon('sparkle', this.actionButton);
    this._actionLabelEl = el('span', 'cc-action__label', this.actionButton);
    const key = el('span', 'cc-action__key', this.actionButton);
    key.textContent = 'E';
    // Prevent double-firing from touchend + click on mobile
    let touchHandled = false;
    this.actionButton.addEventListener('touchend', (e) => {
      e.preventDefault();
      touchHandled = true;
      this.actionButton.blur();
      if (this.actionCallback) this.actionCallback();
    });
    this.actionButton.addEventListener('click', (e) => {
      // A pointer click must not leave keyboard focus here (Enter would re-fire it);
      // keyboard activation (detail === 0) keeps focus for keyboard users.
      if (e.detail > 0) this.actionButton.blur();
      if (touchHandled) { touchHandled = false; return; }
      if (this.actionCallback) this.actionCallback();
    });

    // ── Inventory ──
    this.inventoryEl = el('div', 'cc-glass cc-inv', ui);

    // ── Toast stack ──
    this.notificationEl = el('div', 'cc-toasts', ui);
    this.notificationEl.setAttribute('aria-live', 'polite');

    // ── Pooled "+$X" floaters and confetti (reused DOM, CSS-animated) ──
    this._fxLayer = el('div', 'cc-fx', ui);
    this._floats = [];
    for (let i = 0; i < FLOAT_POOL; i++) {
      const f = el('div', 'cc-float', this._fxLayer);
      this._floats.push(f);
    }
    this._floatNext = 0;
    this._confetti = [];
    const colors = [THEME.gold, THEME.cream, THEME.clay, THEME.ok, '#7db5ee', '#f2c14e'];
    for (let i = 0; i < CONFETTI_POOL; i++) {
      const c = el('i', 'cc-confetto', this._fxLayer);
      c.style.setProperty('--c', colors[i % colors.length]);
      this._confetti.push(c);
    }

    // Initial state
    this.taskListOpen = window.innerWidth >= 900 && window.innerHeight >= 600;
    this._applyTaskListOpen();

    // Wire up inventory changes
    this.inventory.onChange(() => this.updateInventory());
  }

  _createGroomingPanel(parent) {
    const g = el('div', 'cc-glass cc-groom', parent);
    this.groomingOverlay = g;

    const head = el('div', 'cc-groom__head', g);
    icon('groom', head);
    const title = el('span', 'cc-groom__title', head);
    title.textContent = 'Grooming';
    title.title = 'Court grooming';
    const timer = el('span', 'cc-groom__timer', head);
    icon('timer', timer);
    this.groomTimerText = el('span', '', timer);
    this.groomTimerText.textContent = '0:00';
    // High-angle groom camera toggle (also key C); main.js sets onGroomCameraToggle
    const cam = el('button', 'cc-groom__cam', head);
    cam.type = 'button';
    cam.title = 'Overhead camera (C)';
    cam.setAttribute('aria-label', 'Toggle overhead groom camera');
    cam.setAttribute('aria-pressed', 'false');
    icon('camera', cam);
    const stop = (e) => e.stopPropagation();
    cam.addEventListener('touchstart', stop, { passive: true });
    cam.addEventListener('mousedown', stop);
    cam.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail > 0) cam.blur(); // Enter/Space must not re-fire it later
      if (this.onGroomCameraToggle) this.onGroomCameraToggle();
    });
    this._groomCamBtn = cam;

    // Details toggle: compact strip (clean %, coverage, proximity pill) ⇄ full panel
    const more = el('button', 'cc-groom__more', head);
    more.type = 'button';
    icon('chevron', more);
    more.addEventListener('touchstart', stop, { passive: true });
    more.addEventListener('mousedown', stop);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail > 0) more.blur();
      this._setGroomCompact(!this._groomCompact, true);
    });
    this._groomMoreBtn = more;

    const top = el('div', 'cc-groom__top', g);
    // Cleanliness ring
    const ring = el('div', 'cc-ring', top);
    const R = 27;
    this._ringCirc = 2 * Math.PI * R;
    ring.innerHTML = `<svg viewBox="0 0 64 64"><circle class="cc-ring__bg" cx="32" cy="32" r="${R}" stroke-width="7" fill="none"/>` +
      `<circle class="cc-ring__fg" cx="32" cy="32" r="${R}" stroke-width="7" fill="none" stroke-linecap="round" stroke="${THEME.clay}" stroke-dasharray="${this._ringCirc.toFixed(2)}" stroke-dashoffset="${this._ringCirc.toFixed(2)}"/></svg>`;
    this._ringFg = ring.querySelector('.cc-ring__fg');
    const val = el('div', 'cc-ring__val', ring);
    this._ringVal = el('b', '', val);
    this._ringVal.textContent = '0%';
    el('span', '', val).textContent = 'Clean';

    const stats = el('div', 'cc-groom__stats', top);
    const covRow = el('div', 'cc-groom__row', stats);
    el('span', '', covRow).textContent = 'Coverage';
    this.groomCoverageText = el('b', '', covRow);
    this.groomCoverageText.textContent = '0%';
    const bar = el('div', 'cc-bar', stats);
    this.groomCoverageBar = el('div', 'cc-bar__fill', bar);
    // Compact-mode pills: nearest fence/net distance + courtside task count
    const pills = el('div', 'cc-groom__pills', g);
    this._groomProxPill = el('span', 'cc-groom__pill', pills);
    this._groomProxPill.textContent = 'Drive closer';
    // Courtside task count rides on the details button as a badge
    this._groomTaskBadge = el('span', 'cc-groom__badge', this._groomMoreBtn);
    this.groomSpeedIndicator = el('div', 'cc-speed cc-speed--ok', stats);
    icon('speed', this.groomSpeedIndicator);
    this._speedText = el('span', '', this.groomSpeedIndicator);

    // Proximity gauges
    const prox = el('div', 'cc-groom__sec', g);
    const pl = el('span', 'cc-label', prox);
    pl.textContent = 'Brush distance';
    this.groomProximityEl = prox;
    this._gauges = {
      fence: this._createGauge(prox, 'Fence'),
      net: this._createGauge(prox, 'Net'),
    };

    // Courtside tasks
    const ts = el('div', 'cc-groom__sec', g);
    const tl = el('span', 'cc-label', ts);
    tl.textContent = 'Courtside tasks';
    this.groomTaskListEl = el('ul', 'cc-check', ts);

    // Phones / short screens start compact; the player's choice sticks for the session
    let saved = null;
    try { saved = window.sessionStorage.getItem(GROOM_PANEL_KEY); } catch (e) { /* storage blocked */ }
    const small = window.innerWidth <= 640 || window.innerHeight <= 520;
    this._setGroomCompact(saved ? saved === 'compact' : small, false);
    window.addEventListener('resize', () => this._fitGroomPanel());
  }

  /** Compact strip (true) or full panel (false); `remember` stores it for this session. */
  _setGroomCompact(on, remember) {
    this._groomCompact = !!on;
    this.groomingOverlay.classList.toggle('cc-groom--compact', this._groomCompact);
    const b = this._groomMoreBtn;
    b.setAttribute('aria-expanded', this._groomCompact ? 'false' : 'true');
    b.setAttribute('aria-label', this._groomCompact ? 'Show grooming details' : 'Hide grooming details');
    b.title = this._groomCompact ? 'More detail' : 'Less detail';
    if (remember) {
      try { window.sessionStorage.setItem(GROOM_PANEL_KEY, this._groomCompact ? 'compact' : 'full'); } catch (e) { /* storage blocked */ }
    }
    this._fitGroomPanel();
  }

  /** Keep the (expanded) panel above the joystick: cap its height and scroll inside. */
  _fitGroomPanel() {
    const g = this.groomingOverlay;
    if (!g || g.style.display === 'none') return;
    g.style.maxHeight = '';
    g.style.overflowY = '';
    const joy = document.querySelector('.cc-joy');
    const jr = joy && joy.getBoundingClientRect();
    const floor = jr && jr.height > 0 ? jr.top - 10 : window.innerHeight - 12;
    const r = g.getBoundingClientRect();
    if (r.bottom > floor) {
      g.style.maxHeight = Math.max(96, Math.floor(floor - r.top)) + 'px';
      g.style.overflowY = 'auto';
    }
  }

  _createGauge(parent, name) {
    const MAX = 6;
    const pct = (v) => ((Math.min(MAX, Math.max(0, v)) / MAX) * 100).toFixed(1) + '%';
    const dMin = pct(GAME.proximityDangerMin ?? 0.3);
    const oMin = pct(GAME.proximityOptimalMin ?? 0.5);
    const oMax = pct(GAME.proximityOptimalMax ?? 3);
    const wMax = pct(GAME.proximityWarnMax ?? 4.5);
    const R = THEME.danger, Y = THEME.warn, G = THEME.ok;

    const wrap = el('div', 'cc-gauge cc-gauge--none', parent);
    const top = el('div', 'cc-gauge__top', wrap);
    el('span', 'cc-gauge__name', top).textContent = name;
    const v = el('span', 'cc-gauge__val', top);
    v.textContent = '—';
    const track = el('div', 'cc-gauge__track', wrap);
    track.style.background = `linear-gradient(90deg, ${R} 0 ${dMin}, ${Y} ${dMin} ${oMin}, ${G} ${oMin} ${oMax}, ${Y} ${oMax} ${wMax}, ${R} ${wMax} 100%)`;
    const mark = el('div', 'cc-gauge__mark', track);
    return { wrap, val: v, mark, max: MAX };
  }

  _setupTaskListSwipe() {
    // Swipe right from the left screen edge opens the task panel
    let startX = 0;
    let isDragging = false;

    document.addEventListener('touchstart', (e) => {
      if (e.touches[0].clientX < 24) {
        startX = e.touches[0].clientX;
        isDragging = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const dx = e.touches[0].clientX - startX;
      if (dx > 50 && !this.taskListOpen) {
        this._toggleTaskList();
        isDragging = false;
      }
    }, { passive: true });

    document.addEventListener('touchend', () => {
      isDragging = false;
    });
  }

  _toggleTaskList() {
    this.taskListOpen = !this.taskListOpen;
    this._applyTaskListOpen();
  }

  _applyTaskListOpen() {
    this.taskListEl.classList.toggle('cc-tasks--open', this.taskListOpen);
    this._taskHead.setAttribute('aria-expanded', this.taskListOpen ? 'true' : 'false');
  }

  setActionButton(label, callback) {
    if (!label) {
      if (this._actionLabel !== null) {
        this.actionButton.style.display = 'none';
        this.actionButton.classList.remove('cc-action--pulse');
        this._actionLabel = null;
      }
      this.actionCallback = null;
      return;
    }
    this.actionCallback = callback;
    if (label === this._actionLabel) return; // called every frame — only touch the DOM on change

    const text = String(label).replace(/\s*\n\s*/g, ' ');
    this._actionLabelEl.textContent = text;
    this._actionIconEl.innerHTML = ICONS[actionIconFor(text)];
    this.actionButton.setAttribute('aria-label', text);
    this.actionButton.style.display = 'flex';
    // Gentle pulse when newly available / changed
    this.actionButton.classList.remove('cc-action--pulse');
    void this.actionButton.offsetWidth; // restart animation
    this.actionButton.classList.add('cc-action--pulse');
    if (this._pulseTimer) clearTimeout(this._pulseTimer);
    this._pulseTimer = setTimeout(() => {
      this._pulseTimer = null;
      this.actionButton.classList.remove('cc-action--pulse');
    }, 1900);
    this._actionLabel = label;
  }

  showNotification(text, duration = 3, iconName) {
    if (text == null) return;
    text = String(text);
    // Same message as the newest toast → just refresh its timer
    const newest = this._toasts[this._toasts.length - 1];
    if (newest && !newest.leaving && newest.text === text) {
      newest.t = duration;
      this.notificationTimer = duration;
      return;
    }

    const t = el('div', 'cc-glass cc-toast', this.notificationEl);
    const ic = el('span', 'cc-toast__ico', t);
    ic.innerHTML = ICONS[iconName] || ICONS[toastIconFor(text)];
    const msg = el('span', '', t);
    msg.textContent = text;
    void t.offsetWidth; // commit the start state, then transition in
    t.classList.add('cc-toast--in');

    this._toasts.push({ el: t, text, t: duration, leaving: false });
    this.notificationTimer = duration;

    // Cap the stack
    let live = 0;
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      if (this._toasts[i].leaving) continue;
      live++;
      if (live > TOAST_MAX) this._dismissToast(this._toasts[i]);
    }
  }

  _dismissToast(toast) {
    if (toast.leaving) return;
    toast.leaving = true;
    toast.el.classList.remove('cc-toast--in');
    toast.el.classList.add('cc-toast--out');
    setTimeout(() => {
      toast.el.remove();
      const i = this._toasts.indexOf(toast);
      if (i >= 0) this._toasts.splice(i, 1);
    }, 260);
  }

  /**
   * Show the walkie-talkie card.
   *   kind     – 'dispatch' | 'clockIn' | 'info' (a dispatch shows its answer timer)
   *   channel  – small caps header, title – big line, text – optional small line
   *   actions  – [{ label, primary, onClick }] (each button hides the card first)
   */
  showRadioCard({ kind = 'info', channel = 'Staff radio', title = '', text = '', actions = [] } = {}) {
    this._radioKind = kind;
    this._radioChEl.textContent = channel;
    this._radioTitleEl.textContent = title;
    this._radioCtaEl.textContent = text;
    this._radioCtaEl.style.display = text ? '' : 'none';
    this._radioActionsEl.textContent = '';
    for (const a of actions) {
      const b = el('button', 'cc-btn cc-radio__btn' + (a.primary ? ' cc-btn--primary' : ''), this._radioActionsEl);
      b.type = 'button';
      b.textContent = a.label;
      let touched = false;
      const fire = () => {
        this.hideRadioDispatch();
        if (a.onClick) a.onClick();
      };
      b.addEventListener('touchend', (e) => { e.preventDefault(); touched = true; fire(); });
      b.addEventListener('click', () => { if (touched) { touched = false; return; } fire(); });
    }
    this._radioTimerEl.style.display = kind === 'dispatch' ? '' : 'none';
    this._radioTimerFrac = -1;
    this.radioIndicator.setAttribute('aria-label', `${channel}: ${title}`);
    // restart the arrival animation
    this.radioIndicator.style.display = 'none';
    void this.radioIndicator.offsetWidth;
    this.radioIndicator.style.display = 'flex';
    // Toasts sit just under the card (its height depends on the text)
    const r = this.radioIndicator.getBoundingClientRect();
    document.documentElement.style.setProperty('--cc-radio-bottom', Math.round(r.bottom + 10) + 'px');
    this.notificationEl.classList.add('cc-toasts--below');
  }

  /**
   * Radio dispatch card with "On it" / "Busy". onAccept(mission) / onDecline(mission).
   * (Old 2-argument calls still work: the callback runs on "On it".)
   */
  showRadioDispatch(mission, onAccept, onDecline) {
    const title = (mission && mission.title) || 'New dispatch';
    this.radioCallback = onAccept || null;
    this.showRadioCard({
      kind: 'dispatch',
      channel: 'Dispatch · Ch 3',
      title,
      text: mission && mission.description ? mission.description : '',
      actions: [
        { label: 'On it', primary: true, onClick: () => { this.radioCallback = null; if (onAccept) onAccept(mission); } },
        { label: 'Busy', onClick: () => { this.radioCallback = null; if (onDecline) onDecline(mission); } },
      ],
    });
  }

  /** Is a radio card of this kind (or any, if omitted) on screen? */
  isRadioCardVisible(kind) {
    return this.radioIndicator.style.display === 'flex' && (!kind || this._radioKind === kind);
  }

  hideRadioDispatch() {
    this.radioIndicator.style.display = 'none';
    this._radioKind = null;
    this.notificationEl.classList.remove('cc-toasts--below');
  }

  /** Today's club event in the time pill ({ label, icon, title } from EventSystem.describe(), or null). */
  setEventLabel(ev) {
    const text = ev ? `${ev.icon ? ev.icon + ' ' : ''}${ev.label || ev.title || ''}` : '';
    if (text === this._eventText) return;
    this._eventText = text;
    this._timeEventEl.textContent = text;
    this._timeEventEl.classList.toggle('is-on', !!text);
    if (ev && ev.title) this._timeEventEl.title = ev.title;
  }

  updateTimeWeather() {
    const time = this.weather.getTimeString();
    const ic = this.weather.getWeatherIcon();
    const period = this.weather.getPeriod();
    const day = this.weather.day || 1;
    const key = time + '|' + ic + '|' + period + '|' + day;
    if (key === this._timeKey) return;
    this._timeKey = key;
    this._timeClockEl.textContent = time;
    this._timeIconEl.textContent = ic;
    this._timePeriodEl.textContent = `Day ${day} · ${period}`;
  }

  // ─────────────────────────── Wallet / rewards ───────────────────────────

  /** Set the wallet balance; the counter ticks up to it (instant = jump, e.g. after loading). */
  setWallet(amount, instant = false) {
    this._walletTarget = Math.max(0, Math.round(amount) || 0);
    if (instant || this._walletTarget < this._walletShown) {
      this._walletShown = this._walletTarget;
      this._setWalletText(this._walletShown);
    }
  }

  _setWalletText(v) {
    const t = String(Math.round(v));
    if (t === this._walletText) return;
    this._walletText = t;
    this._walletTextEl.textContent = t;
  }

  /**
   * Floating "+$X" at a screen position (css px); without one it rises from the wallet.
   * kind: 'tip' | 'task' | 'wage' | 'bonus' (colour / label).
   */
  showMoneyFloat(amount, x, y, kind = 'tip') {
    if (!(amount > 0)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const r = this.walletEl.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.bottom + 16;
    }
    const f = this._floats[this._floatNext];
    this._floatNext = (this._floatNext + 1) % this._floats.length;
    f.className = 'cc-float cc-float--' + kind;
    f.textContent = (kind === 'tip' ? 'Tip +$' : '+$') + Math.round(amount);
    const w = window.innerWidth;
    f.style.left = Math.max(40, Math.min(w - 40, x)).toFixed(0) + 'px';
    f.style.top = Math.max(60, y).toFixed(0) + 'px';
    void f.offsetWidth; // restart the animation
    f.classList.add('cc-float--go');
  }

  /** Confetti burst (pooled DOM). Skipped with prefers-reduced-motion. */
  celebrate() {
    if (this._reducedMotion === undefined) {
      try { this._reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { this._reducedMotion = false; }
    }
    if (this._reducedMotion) return;
    const n = this._confetti.length;
    for (let i = 0; i < n; i++) {
      const c = this._confetti[i];
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = 90 + Math.random() * 170;
      c.style.setProperty('--dx', (Math.cos(a) * sp).toFixed(0) + 'px');
      c.style.setProperty('--dy', (Math.sin(a) * sp * 0.7 - 60).toFixed(0) + 'px');
      c.style.setProperty('--r', ((Math.random() * 2 - 1) * 540).toFixed(0) + 'deg');
      c.style.setProperty('--d', (0.9 + Math.random() * 0.6).toFixed(2) + 's');
      c.classList.remove('cc-confetto--go');
    }
    void this._fxLayer.offsetWidth;
    for (let i = 0; i < n; i++) this._confetti[i].classList.add('cc-confetto--go');
  }

  // ─────────────────────────── Minimap ───────────────────────────

  updateMiniMap(playerPos, npcs, cartPos, mapData, heading) {
    // Heading: explicit, else derived from movement (sampled every call, cheap)
    if (playerPos) {
      if (typeof heading === 'number' && isFinite(heading)) {
        this._heading = heading;
        this._headingValid = true;
      } else if (!Number.isNaN(this._lastPX)) {
        const dx = playerPos.x - this._lastPX;
        const dz = playerPos.z - this._lastPZ;
        if (dx * dx + dz * dz > 0.0004) {
          const target = Math.atan2(dx, dz);
          if (!this._headingValid) {
            this._heading = target;
            this._headingValid = true;
          } else {
            let d = target - this._heading;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            this._heading += d * 0.35;
          }
        }
      }
      this._lastPX = playerPos.x;
      this._lastPZ = playerPos.z;
    }

    const now = performance.now();
    if (now - this._mapLast < MINIMAP_INTERVAL) return;
    this._mapLast = now;

    if (mapData && this._mapStaticFor !== mapData) this._buildMapStatic(mapData);

    const ctx = this.miniMapCtx;
    const dpr = this._mapDpr;
    const X = this._mapXform;
    const size = X.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this._mapStatic) {
      ctx.drawImage(this._mapStatic, 0, 0, size, size);
    } else {
      ctx.fillStyle = '#4f8a3f';
      ctx.fillRect(0, 0, size, size);
    }
    const mx = (x) => (x - X.cx) * X.s + size / 2;
    const my = (z) => (z - X.cz) * X.s + size / 2;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.006);

    // Active mission markers: the place of every current step (goTo / pickup / deliver /
    // groom) and the NPCs to talk to
    const missions = this.missions.getActiveMissions();
    let npcTargets = null;
    for (let m = 0; m < missions.length; m++) {
      const mission = missions[m];
      const npcId = this.missions.getStepNpcId ? this.missions.getStepNpcId(mission) : null;
      if (npcId) {
        if (!npcTargets) npcTargets = this._npcTargetSet || (this._npcTargetSet = new Set());
        npcTargets.add(npcId);
      }
      const step = mission.steps ? mission.steps[mission.currentStep] : null;
      const pt = step && this.missions.getStepTargetPoint ? this.missions.getStepTargetPoint(step) : null;
      if (pt) this._drawObjective(ctx, mx(pt.x), my(pt.z), pulse);
    }

    // NPCs. Gold (pulsing) = talk to them for the current step; sky blue = involved
    // in an active mission (go back and forth between them); mint = staff; orange
    // badge = Hank, drawn last and pinned to the map edge so he's always findable.
    const involved = this._npcInvolvedSet || (this._npcInvolvedSet = new Set());
    involved.clear();
    if (this.missions.collectInvolvedNpcIds) this.missions.collectInvolvedNpcIds(involved);
    let hank = null;
    if (npcs) {
      for (let i = 0; i < npcs.length; i++) {
        const npc = npcs[i];
        if (!npc || !npc.mesh) continue;
        if (npc.id === HANK_ID) { hank = npc; continue; }
        const pos = npc.mesh.position;
        const nx = mx(pos.x);
        const ny = my(pos.z);
        const targeted = npcTargets && npcTargets.has(npc.id);
        const isInvolved = !targeted && involved.has(npc.id);
        let r = 2.2;
        if (npc.hasRequest || targeted) {
          ctx.fillStyle = `rgba(217, 164, 65, ${0.25 + pulse * 0.3})`;
          ctx.beginPath();
          ctx.arc(nx, ny, 5.5 + pulse * 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#f2c14e';
          r = 3;
        } else if (isInvolved) {
          ctx.fillStyle = `rgba(79, 195, 247, ${0.22 + pulse * 0.2})`;
          ctx.beginPath();
          ctx.arc(nx, ny, 5 + pulse, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = MINIMAP_INVOLVED;
          r = 3;
        } else if (npc.archetype === 'staff') {
          ctx.fillStyle = MINIMAP_STAFF;
          r = 2.6;
        } else {
          ctx.fillStyle = '#f4e8c1';
        }
        ctx.strokeStyle = '#173a26';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (hank) {
      const edge = 7;
      const hx = Math.min(size - edge, Math.max(edge, mx(hank.mesh.position.x)));
      const hy = Math.min(size - edge, Math.max(edge, my(hank.mesh.position.z)));
      const hTarget = (npcTargets && npcTargets.has(hank.id)) || hank.hasRequest || involved.has(hank.id);
      if (hTarget) {
        ctx.fillStyle = `rgba(255, 138, 61, ${0.25 + pulse * 0.3})`;
        ctx.beginPath();
        ctx.arc(hx, hy, 8 + pulse * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = MINIMAP_HANK;
      ctx.strokeStyle = '#173a26';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#173a26';
      ctx.font = 'bold 7px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('H', hx, hy + 0.5);
    }
    if (npcTargets) npcTargets.clear();

    // Cart (skip when the player is driving it — the arrow covers it)
    if (cartPos) {
      const nearPlayer = playerPos && Math.abs(cartPos.x - playerPos.x) < 1.5 && Math.abs(cartPos.z - playerPos.z) < 1.5;
      if (!nearPlayer) {
        const cx = mx(cartPos.x);
        const cy = my(cartPos.z);
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#173a26';
        ctx.lineWidth = 1.2;
        this._roundRect(ctx, cx - 3, cy - 4, 6, 8, 1.8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#2d5a3d';
        ctx.fillRect(cx - 2, cy - 1, 4, 2.2);
      }
    }

    // Player arrow
    if (playerPos) {
      const px = mx(playerPos.x);
      const py = my(playerPos.z);
      // canvas angle for world facing (sin h, cos h): x→x, z→y
      const ang = this._headingValid ? Math.atan2(Math.cos(this._heading), Math.sin(this._heading)) : -Math.PI / 2;
      ctx.save();
      ctx.translate(px, py);
      // soft view cone
      ctx.rotate(ang);
      if (!this._coneGrad) {
        this._coneGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 22);
        this._coneGrad.addColorStop(0, 'rgba(255, 250, 235, 0.45)');
        this._coneGrad.addColorStop(1, 'rgba(255, 250, 235, 0)');
      }
      ctx.fillStyle = this._coneGrad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 22, -0.55, 0.55);
      ctx.closePath();
      ctx.fill();
      // arrow
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 3;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#173a26';
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-5, 5);
      ctx.lineTo(-2.5, 0);
      ctx.lineTo(-5, -5);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawObjective(ctx, x, y, pulse) {
    ctx.fillStyle = `rgba(217, 164, 65, ${0.18 + pulse * 0.22})`;
    ctx.beginPath();
    ctx.arc(x, y, 7 + pulse * 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2c14e';
    ctx.strokeStyle = '#173a26';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 4, y);
    ctx.lineTo(x, y + 5);
    ctx.lineTo(x - 4, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Pre-render the static club layout once (grass, paths, courts, buildings). */
  _buildMapStatic(mapData) {
    this._mapStaticFor = mapData;
    const areas = mapData.areas || {};
    const size = this._mapXform.size;
    const dpr = this._mapDpr;

    // World bounds of everything we draw
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const grow = (x, z, hw = 0, hd = 0) => {
      minX = Math.min(minX, x - hw); maxX = Math.max(maxX, x + hw);
      minZ = Math.min(minZ, z - hd); maxZ = Math.max(maxZ, z + hd);
    };
    for (const p of mapData.paths || []) for (const pt of p.points) grow(pt.x, pt.z, (p.width || 2) / 2, (p.width || 2) / 2);
    for (const c of areas.courts || []) grow(c.center.x, c.center.z, SIZES.courtWidth / 2 + 2, SIZES.courtDepth / 2 + 2);
    for (const k of ['entrance', 'parking', 'proShop', 'garden', 'equipmentShed', 'patio', 'fitnessCenter', 'poolHouse', 'pool']) {
      const a = areas[k];
      if (a && a.center) grow(a.center.x, a.center.z, a.bounds ? a.bounds.width / 2 : 3, a.bounds ? a.bounds.depth / 2 : 3);
    }
    if (!isFinite(minX)) { minX = -60; maxX = 60; minZ = -50; maxZ = 50; }
    const pad = 6;
    const span = Math.max(maxX - minX, maxZ - minZ) + pad * 2;
    const X = this._mapXform;
    X.cx = (minX + maxX) / 2;
    X.cz = (minZ + maxZ) / 2;
    X.s = size / span;
    const s = X.s;
    const mx = (x) => (x - X.cx) * s + size / 2;
    const my = (z) => (z - X.cz) * s + size / 2;

    const cv = document.createElement('canvas');
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Grass with mow stripes
    ctx.fillStyle = '#5a9a48';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    const stripe = Math.max(4, 5 * s);
    for (let x = 0; x < size; x += stripe * 2) ctx.fillRect(x, 0, stripe, size);

    const rect = (cx, cz, w, d, fill, stroke, lw = 1, r = 1.5) => {
      const x = mx(cx - w / 2), y = my(cz - d / 2);
      this._roundRect(ctx, x, y, w * s, d * s, r);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
    };

    // Garden lawn + hedges + beds + fountain
    const garden = areas.garden;
    if (garden && garden.center) {
      const b = garden.bounds || { width: 18, depth: 18 };
      rect(garden.center.x, garden.center.z, b.width, b.depth, '#68ad52', null, 1, 3);
      for (const h of garden.hedges || []) rect(h.x, h.z, h.width, h.depth, '#2f6a33', null, 1, 1);
      const beds = ['#e7879a', '#f2c14e', '#b98ae0', '#f59e6b'];
      for (const f of garden.flowerBeds || []) rect(f.x, f.z, f.width, f.depth, beds[(f.color || 0) % beds.length], null, 1, 1.2);
      const fo = garden.fountain || garden.center;
      ctx.fillStyle = '#d8d0bc';
      ctx.beginPath(); ctx.arc(mx(fo.x), my(fo.z), 2.2 * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#6fb6de';
      ctx.beginPath(); ctx.arc(mx(fo.x), my(fo.z), 1.5 * s, 0, Math.PI * 2); ctx.fill();
    }

    // Paths (edge then fill for a crisp border)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const p of mapData.paths || []) {
        if (!p.points || p.points.length < 2) continue;
        ctx.beginPath();
        p.points.forEach((pt, i) => (i ? ctx.lineTo(mx(pt.x), my(pt.z)) : ctx.moveTo(mx(pt.x), my(pt.z))));
        const w = Math.max(1.6, (p.width || 2.5) * s);
        ctx.lineWidth = pass ? w : w + 1.4;
        ctx.strokeStyle = pass ? '#e6dab8' : 'rgba(120, 105, 70, 0.55)';
        ctx.stroke();
      }
    }

    // Parking lot
    const parking = areas.parking;
    if (parking && parking.center) {
      const b = parking.bounds || { width: 25, depth: 12 };
      rect(parking.center.x, parking.center.z, b.width, b.depth, '#54585a', 'rgba(0,0,0,0.25)', 1, 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 0.8;
      for (let x = parking.center.x - b.width / 2 + 3; x < parking.center.x + b.width / 2 - 1; x += 3.5) {
        ctx.beginPath();
        ctx.moveTo(mx(x), my(parking.center.z));
        ctx.lineTo(mx(x), my(parking.center.z + b.depth / 2 - 0.5));
        ctx.stroke();
      }
    }

    // Patio pavers
    const patio = areas.patio;
    if (patio && patio.center) {
      const b = patio.bounds || { width: 18, depth: 8 };
      rect(patio.center.x, patio.center.z, b.width, b.depth, '#d3c4a0', null, 1, 1.5);
    }

    // Courts
    for (const c of areas.courts || []) {
      const W = SIZES.courtWidth, D = SIZES.courtDepth;
      ctx.save();
      ctx.translate(mx(c.center.x), my(c.center.z));
      if (c.rotation) ctx.rotate(-c.rotation);
      const box = (w, d, fill) => { ctx.fillStyle = fill; ctx.fillRect(-w * s / 2, -d * s / 2, w * s, d * s); };
      if (c.type === 'clay') {
        box(W, D, '#c8663c');
        ctx.strokeStyle = 'rgba(255, 244, 225, 0.75)';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-W * 0.34 * s, -D * 0.4 * s, W * 0.68 * s, D * 0.8 * s);
      } else {
        box(W, D, '#3f7d55');
        box(W * 0.7, D * 0.8, '#2f6db3');
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-W * 0.35 * s, -D * 0.4 * s, W * 0.7 * s, D * 0.8 * s);
      }
      // net
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-W * 0.42 * s, 0);
      ctx.lineTo(W * 0.42 * s, 0);
      ctx.stroke();
      // fence outline
      ctx.strokeStyle = 'rgba(23, 58, 38, 0.85)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-W * s / 2, -D * s / 2, W * s, D * s);
      ctx.restore();
    }

    // Buildings (cream walls, slate-green roof ridge)
    const building = (cx, cz, w, d) => {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetY = 1;
      rect(cx, cz, w, d, '#f3e8c9', null, 1, 1.5);
      ctx.restore();
      rect(cx, cz, w, d, null, '#6d6450', 1, 1.5);
      ctx.strokeStyle = 'rgba(45, 90, 61, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const horiz = w >= d;
      if (horiz) { ctx.moveTo(mx(cx - w / 2 + 1), my(cz)); ctx.lineTo(mx(cx + w / 2 - 1), my(cz)); }
      else { ctx.moveTo(mx(cx), my(cz - d / 2 + 1)); ctx.lineTo(mx(cx), my(cz + d / 2 - 1)); }
      ctx.stroke();
    };
    const ps = areas.proShop;
    if (ps && ps.center) building(ps.center.x, ps.center.z, ps.bounds ? ps.bounds.width : 14, ps.bounds ? ps.bounds.depth : 10);
    const ch = patio && patio.clubhouse;
    if (ch && ch.center) building(ch.center.x, ch.center.z, ch.width || 18, ch.depth || 8);
    const shed = areas.equipmentShed;
    if (shed && shed.center) {
      const b = shed.bounds || { width: 5, depth: 4 };
      rect(shed.center.x, shed.center.z, b.width, b.depth, '#9a6a3f', '#5b3d22', 1, 1);
    }
    // Club buildings: clubhouse locker wing, fitness centre, pool house + pool deck and water
    const wing = ch && ch.wing;
    if (wing && wing.center) building(wing.center.x, wing.center.z, wing.width, wing.depth);
    const pool = areas.pool;
    if (pool && pool.center && pool.bounds) {
      rect(pool.center.x, pool.center.z, pool.bounds.width, pool.bounds.depth, '#e6dcc6', 'rgba(35,39,42,0.6)', 1, 1);
      const wtr = pool.water;
      if (wtr) rect(wtr.x, wtr.z, wtr.width, wtr.length, '#4cb8e6', '#f7f3ea', 1.2, 1);
    }
    for (const k of ['fitnessCenter', 'poolHouse']) {
      const a = areas[k];
      const bb = a && (a.building || a.bounds);
      if (a && a.center && bb) building(a.center.x, a.center.z, bb.width, bb.depth);
    }

    // Soft edge vignette
    const vg = ctx.createRadialGradient(size / 2, size / 2, size * 0.35, size / 2, size / 2, size * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(10, 30, 18, 0.35)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, size, size);

    // GPU-backed 2D canvases lose their pixels when the GPU resets; rebuild on restore
    cv.addEventListener('contextrestored', () => { this._mapStaticFor = null; });
    this._mapStatic = cv;
  }

  // ─────────────────────────── Tasks ───────────────────────────

  updateTaskList() {
    const missions = this.missions.getActiveMissions();
    this.taskListContent.innerHTML = '';

    const n = missions.length;
    this._taskBadge.textContent = String(n);
    this._taskBadge.classList.toggle('cc-tasks__badge--zero', n === 0);

    if (n === 0) {
      this._taskPreview.textContent = 'Check the Pro Shop board';
      const empty = el('div', 'cc-tasks__empty', this.taskListContent);
      empty.textContent = 'No active tasks. Check the task board in the Pro Shop, or wait for a radio dispatch.';
      return;
    }

    const firstStep = this.missions.getCurrentStep(missions[0].id);
    this._taskPreview.textContent = firstStep && firstStep.prompt ? firstStep.prompt : missions[0].title;

    for (const mission of missions) {
      const type = MISSION_TYPE[mission.type] || { color: THEME.gold, label: mission.type || 'Task' };
      const card = el('div', 'cc-task', this.taskListContent);
      card.style.setProperty('--cc-task-accent', type.color);

      el('div', 'cc-task__type', card).textContent = type.label;
      el('div', 'cc-task__title', card).textContent = mission.title;

      const step = this.missions.getCurrentStep(mission.id);
      if (step && step.prompt) el('div', 'cc-task__step', card).textContent = step.prompt;

      const total = Array.isArray(mission.steps) ? mission.steps.length : 0;
      if (total > 1) {
        const pips = el('div', 'cc-task__pips', card);
        const cur = mission.currentStep || 0;
        pips.title = `Step ${Math.min(cur + 1, total)} of ${total}`;
        for (let i = 0; i < total; i++) {
          el('span', 'cc-task__pip' + (i < cur ? ' cc-task__pip--done' : i === cur ? ' cc-task__pip--now' : ''), pips);
        }
      }
    }
  }

  // ─────────────────────────── Inventory ───────────────────────────

  updateInventory() {
    const items = this.inventory.getItems();
    const prev = this._invCount;
    this._invCount = items.length;
    this.inventoryEl.innerHTML = '';

    if (items.length === 0) {
      this.inventoryEl.style.display = 'none';
      return;
    }
    this.inventoryEl.style.display = 'flex';

    items.forEach((item, i) => {
      const slot = el('div', 'cc-inv__slot', this.inventoryEl);
      if (i >= prev) {
        slot.classList.add('cc-inv__slot--new');
        setTimeout(() => slot.classList.remove('cc-inv__slot--new'), 1800);
      }
      slot.textContent = item.icon || '📦';
      slot.title = item.name || '';
      const name = el('span', 'cc-inv__name', slot);
      name.textContent = item.name || '';
    });
    const cap = el('span', 'cc-inv__cap', this.inventoryEl);
    cap.textContent = `${items.length}/${this.inventory.maxSlots}`;
  }

  // ─────────────────────────── Grooming ───────────────────────────

  showGroomingHUD() {
    this.groomingOverlay.style.display = 'block';
    this._leftCol.classList.add('cc-hud-left--grooming');
    this._groomLast = 0;
    const C = this._groomCache;
    C.clean = -1; C.cover = -1; C.speed = ''; C.speedOk = null; C.time = ''; C.fence = ''; C.net = ''; C.tasks = ''; C.pill = '';
    // Make room: collapse the task list while grooming, restore afterwards
    this._tasksWasOpen = this.taskListOpen;
    if (this.taskListOpen) this._toggleTaskList();
    this._fitGroomPanel();
  }

  /** Reflect the groom-camera state on the panel button. */
  setGroomCameraActive(on) {
    if (this._groomCamBtn) this._groomCamBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  hideGroomingHUD() {
    this.setGroomCameraActive(false);
    this.groomingOverlay.style.display = 'none';
    this._leftCol.classList.remove('cc-hud-left--grooming');
    if (this._tasksWasOpen && !this.taskListOpen) this._toggleTaskList();
    this._tasksWasOpen = false;
  }

  updateGroomingHUD(progress) {
    if (!progress) return;
    // Called every frame (sometimes twice) — throttle DOM writes to ~10 fps
    const now = performance.now();
    if (now - this._groomLast < GROOM_INTERVAL) return;
    this._groomLast = now;
    const C = this._groomCache;

    const cleanPct = Math.round(progress.cleanliness * 100);
    const coverPct = Math.round(progress.coverage * 100);
    if (cleanPct !== C.clean) {
      C.clean = cleanPct;
      const frac = Math.max(0, Math.min(1, progress.cleanliness));
      this._ringFg.setAttribute('stroke-dashoffset', (this._ringCirc * (1 - frac)).toFixed(2));
      const thr = GAME.groomScoreThreshold ?? 0.85;
      this._ringFg.setAttribute('stroke', frac >= thr ? THEME.ok : frac >= thr * 0.7 ? THEME.gold : THEME.clay);
      this._ringVal.textContent = cleanPct + '%';
    }
    if (coverPct !== C.cover) {
      C.cover = coverPct;
      this.groomCoverageBar.style.width = coverPct + '%';
      this.groomCoverageText.textContent = coverPct + '%';
    }

    // Speed indicator
    const speed = (progress.speed || 0).toFixed(1);
    if (speed !== C.speed || progress.speedOk !== C.speedOk) {
      C.speed = speed;
      if (progress.speedOk !== C.speedOk) {
        C.speedOk = progress.speedOk;
        this.groomSpeedIndicator.classList.toggle('cc-speed--ok', !!progress.speedOk);
        this.groomSpeedIndicator.classList.toggle('cc-speed--bad', !progress.speedOk);
      }
      this._speedText.textContent = progress.speedOk ? `${speed} m/s · Good` : `${speed} m/s · Too fast!`;
    }

    // Timer
    const mins = Math.floor(progress.time / 60);
    const secs = Math.floor(progress.time % 60);
    const tStr = `${mins}:${secs.toString().padStart(2, '0')}`;
    if (tStr !== C.time) {
      C.time = tStr;
      this.groomTimerText.textContent = tStr;
    }

    if (progress.proximity) this._updateProximityDisplay(progress.proximity);
    if (progress.courtsideTasks) this._updateCourtsideTaskDisplay(progress.courtsideTasks);
  }

  _updateProximityDisplay(proximity) {
    this._updateGauge(this._gauges.fence, proximity.nearestFenceDist, proximity.fenceStatus, 'fence');
    this._updateGauge(this._gauges.net, proximity.nearestNetDist, proximity.netStatus, 'net');

    // Compact pill: whichever of fence / net is nearer (and in range)
    const has = (d, st) => d !== null && d !== undefined && st && st !== 'none';
    const f = has(proximity.nearestFenceDist, proximity.fenceStatus);
    const n = has(proximity.nearestNetDist, proximity.netStatus);
    let name = null, dist = 0, status = 'none';
    if (f && (!n || proximity.nearestFenceDist <= proximity.nearestNetDist)) { name = 'Fence'; dist = proximity.nearestFenceDist; status = proximity.fenceStatus; }
    else if (n) { name = 'Net'; dist = proximity.nearestNetDist; status = proximity.netStatus; }
    const sig = name ? name + status + dist.toFixed(1) : 'none';
    if (sig === this._groomCache.pill) return;
    this._groomCache.pill = sig;
    const pill = this._groomProxPill;
    pill.className = 'cc-groom__pill' + (name ? ' cc-groom__pill--' + status : '');
    const hint = status === 'warn' ? ' · closer' : status === 'far' ? ' · too far' : status === 'danger' ? ' · too close!' : '';
    pill.textContent = name ? `${name} ${dist.toFixed(1)}m${hint}` : 'Drive closer';
  }

  _updateGauge(g, dist, status, key) {
    const none = dist === null || dist === undefined || !status || status === 'none';
    const sig = none ? 'none' : status + dist.toFixed(1);
    if (this._groomCache[key] === sig) return;
    this._groomCache[key] = sig;
    g.wrap.classList.toggle('cc-gauge--none', none);
    if (none) {
      g.val.textContent = 'Drive closer';
      g.val.style.color = '';
      return;
    }
    const { color, label } = this._getProximityVisual(status, key === 'fence' ? 'Fence' : 'Net');
    g.val.textContent = `${dist.toFixed(1)}m ${label}`;
    g.val.style.color = color;
    g.mark.style.left = ((Math.min(g.max, Math.max(0, dist)) / g.max) * 100).toFixed(1) + '%';
  }

  _getProximityVisual(status, type) {
    switch (status) {
      case 'optimal':
        return { color: '#8fe0a6', label: 'Good' };
      case 'warn':
        return { color: THEME.warn, label: 'Get closer' };
      case 'far':
        return { color: '#ff9c8c', label: 'Too far!' };
      case 'danger':
        return { color: '#ff9c8c', label: 'Too close!' };
      default:
        return { color: 'rgba(244,232,193,0.5)', label: '' };
    }
  }

  _updateCourtsideTaskDisplay(tasks) {
    let sig = String(tasks.length);
    for (let i = 0; i < tasks.length; i++) sig += tasks[i].completed ? '1' : '0';
    if (sig === this._groomCache.tasks) return;
    this._groomCache.tasks = sig;

    let done = 0;
    for (let i = 0; i < tasks.length; i++) if (tasks[i].completed) done++;
    this._groomTaskBadge.textContent = tasks.length ? `${done}/${tasks.length}` : '';
    this._groomTaskBadge.classList.toggle('cc-groom__badge--done', tasks.length > 0 && done === tasks.length);

    this.groomTaskListEl.innerHTML = '';
    if (tasks.length === 0) {
      const li = el('li', '', this.groomTaskListEl);
      li.style.color = 'var(--cc-cream-dim)';
      li.textContent = 'None today';
      return;
    }
    for (const task of tasks) {
      const li = el('li', task.completed ? 'cc-check--done' : '', this.groomTaskListEl);
      el('span', 'cc-check__box', li);
      el('span', '', li).textContent = task.label;
    }
    if (!this._groomCompact) this._fitGroomPanel();
  }

  // ─────────────────────────── Per-frame ───────────────────────────

  update(dt) {
    // Wallet counter ticks toward the balance
    if (this._walletShown < this._walletTarget) {
      const d = this._walletTarget - this._walletShown;
      this._walletShown = Math.min(this._walletTarget, this._walletShown + Math.max(12, d * 3) * dt);
      this._setWalletText(Math.floor(this._walletShown));
      if (!this._walletPulsing) {
        this._walletPulsing = true;
        this.walletEl.classList.add('cc-wallet--up');
      }
    } else if (this._walletPulsing) {
      this._walletPulsing = false;
      this.walletEl.classList.remove('cc-wallet--up');
    }

    // Dispatch card answer timer (game time: freezes while paused)
    if (this._radioKind === 'dispatch' && this.missions.pendingDispatch) {
      const frac = Math.max(0, Math.min(1, this.missions.pendingDispatchTimer / (GAME.dispatchCardTimeout || 25)));
      const q = Math.round(frac * 200) / 200;
      if (q !== this._radioTimerFrac) {
        this._radioTimerFrac = q;
        this._radioTimerFill.style.transform = `scaleX(${q})`;
      }
    }

    // Toast timers
    if (this.notificationTimer > 0) this.notificationTimer -= dt;
    for (let i = 0; i < this._toasts.length; i++) {
      const t = this._toasts[i];
      if (t.leaving) continue;
      t.t -= dt;
      if (t.t <= 0) this._dismissToast(t);
    }
  }
}
