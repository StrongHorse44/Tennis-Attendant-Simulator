import { injectTheme } from './theme.js';
import { TENNIS_STATS } from '../systems/PlayerProfile.js';

/**
 * ShopUI — the club shop / lessons / locker overlay (DOM in #ui-root, theme.js tokens).
 *
 * new ShopUI({ shop: ShopSystem, profile: PlayerProfile, onClose(), onFeedback(result), getRankIndex() })
 *   open({ mode: 'shop' | 'locker', vendor?: npcId, tab?: category, greeting?: string })
 *   close(), isOpen, refresh()
 *
 * Modes: 'shop' (Jess at the pro shop counter: every tab; Rafa: lessons only, from vendors in
 * shop.json) buys things; 'locker' (pause menu) only changes what is equipped. The game is paused
 * while it is open (Game pauses with reason 'shop' so the pause menu stays shut). Every action goes
 * through ShopSystem; onFeedback({ kind, ok, ... }) lets Game play sounds / queue toasts.
 */

const SHOP_CSS = `
.ccs-overlay {
  position: fixed; inset: 0; z-index: 850;
  display: flex; align-items: center; justify-content: center;
  padding: calc(var(--cc-safe-top, 0px) + 12px) calc(var(--cc-safe-right, 0px) + 12px)
           calc(var(--cc-safe-bottom, 0px) + 12px) calc(var(--cc-safe-left, 0px) + 12px);
  background: radial-gradient(ellipse at 50% 40%, rgba(23, 58, 38, 0.4), rgba(8, 18, 12, 0.76) 75%);
  backdrop-filter: blur(6px) saturate(0.85); -webkit-backdrop-filter: blur(6px) saturate(0.85);
  opacity: 0; visibility: hidden;
  transition: opacity 0.2s ease, visibility 0s linear 0.2s;
  touch-action: manipulation; overscroll-behavior: contain;
  font-family: var(--cc-font-ui);
}
.ccs-overlay.is-open { opacity: 1; visibility: visible; transition: opacity 0.2s ease, visibility 0s; }
.ccs-panel {
  position: relative; display: flex; flex-direction: column;
  width: min(860px, 100%); height: min(680px, 100%);
  background: linear-gradient(180deg, rgba(31, 66, 45, 0.96), rgba(18, 38, 26, 0.97));
  border-radius: 20px; overflow: hidden;
  transform: translateY(12px) scale(0.97); transition: transform 0.24s cubic-bezier(.2,.9,.3,1.12);
  user-select: none; -webkit-user-select: none;
}
.ccs-overlay.is-open .ccs-panel { transform: none; }
.ccs-panel::before {
  content: ''; position: absolute; inset: 6px; border: 1px solid rgba(217, 164, 65, 0.22);
  border-radius: 15px; pointer-events: none; z-index: 2;
}

.ccs-head { display: flex; align-items: center; gap: 12px; padding: 16px 16px 8px 20px; }
.ccs-head__text { flex: 1; min-width: 0; }
.ccs-head__label { color: var(--cc-gold); letter-spacing: 2px; }
.ccs-head__title { margin: 2px 0 0; font-size: 25px; line-height: 1.1; }
.ccs-head__greet { margin-top: 4px; font-size: 13px; color: var(--cc-cream-dim); font-style: italic;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccs-wallet {
  flex: none; display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 4px 14px 4px 6px;
  border-radius: 999px; background: rgba(217, 164, 65, 0.14); border: 1px solid rgba(217, 164, 65, 0.45);
}
.ccs-wallet__coin { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
  background: radial-gradient(circle at 35% 30%, #ffe39a, #d9a441 60%, #a8792a); color: #3b2a10; font-weight: 800; font-size: 16px; }
.ccs-wallet b { font-family: var(--cc-font-display); font-size: 21px; color: #ffe39a; font-variant-numeric: tabular-nums; font-weight: 600; }
.ccs-wallet.is-bump { animation: ccs-bump 0.4s ease; }
@keyframes ccs-bump { 30% { transform: scale(1.08); } }
.ccs-close { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; display: grid; place-items: center; }
.ccs-close svg { width: 18px; height: 18px; }

.ccs-tabs {
  display: flex; gap: 6px; padding: 6px 16px 10px; overflow-x: auto; scrollbar-width: none; flex: none;
  -webkit-overflow-scrolling: touch;
}
.ccs-tabs::-webkit-scrollbar { display: none; }
.ccs-tab {
  flex: none; min-height: 44px; padding: 0 16px; border-radius: 999px;
  border: 1px solid rgba(244, 232, 193, 0.16); background: rgba(244, 232, 193, 0.06);
  color: var(--cc-cream-dim); font: 600 14px var(--cc-font-ui); cursor: pointer;
  display: flex; align-items: center; gap: 7px; -webkit-tap-highlight-color: transparent;
  transition: background 0.15s ease, color 0.15s ease;
}
.ccs-tab svg { width: 17px; height: 17px; }
.ccs-tab[aria-selected="true"] { background: var(--cc-cream); color: var(--cc-green-900); border-color: var(--cc-cream); }
.ccs-tab:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 2px; }

.ccs-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 2px 16px 16px; overscroll-behavior: contain; }
.ccs-blurb { font-size: 13px; color: var(--cc-cream-dim); margin: 0 4px 10px; line-height: 1.4; }
.ccs-section { margin: 14px 0 8px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 4px; }
.ccs-section .cc-label { color: var(--cc-gold); }
.ccs-section__now { font-size: 12px; color: var(--cc-cream-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ccs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.ccs-empty { padding: 14px; text-align: center; font-size: 13px; color: var(--cc-cream-dim);
  border: 1px dashed rgba(244, 232, 193, 0.16); border-radius: 12px; }

.ccs-card {
  display: grid; grid-template-columns: 64px 1fr; grid-template-areas: "art main" "act act";
  gap: 8px 12px; padding: 12px; border-radius: 14px;
  background: rgba(244, 232, 193, 0.05); border: 1px solid rgba(244, 232, 193, 0.1);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.ccs-card.is-equipped { border-color: rgba(217, 164, 65, 0.7); background: rgba(217, 164, 65, 0.1); }
.ccs-card.is-locked { opacity: 0.62; }
.ccs-card.is-flash { animation: ccs-flash 0.7s ease; }
@keyframes ccs-flash { 0% { box-shadow: 0 0 0 0 rgba(255, 227, 154, 0.8); } 100% { box-shadow: 0 0 0 14px rgba(255, 227, 154, 0); } }
.ccs-card__art { grid-area: art; width: 64px; height: 64px; border-radius: 12px; background: rgba(0, 0, 0, 0.22);
  display: grid; place-items: center; }
.ccs-card__art svg { width: 54px; height: 54px; }
.ccs-card__main { grid-area: main; min-width: 0; }
.ccs-card__name { font-family: var(--cc-font-display); font-size: 16.5px; font-weight: 600; color: var(--cc-cream); line-height: 1.2; }
.ccs-card__tag { display: inline-block; margin-left: 6px; font: 700 10px var(--cc-font-ui); letter-spacing: 0.8px; text-transform: uppercase;
  color: var(--cc-green-900); background: var(--cc-gold); border-radius: 6px; padding: 2px 6px; vertical-align: 2px; }
.ccs-card__desc { margin-top: 3px; font-size: 12.5px; line-height: 1.35; color: var(--cc-cream-dim); }
.ccs-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.ccs-chip { font: 700 11.5px var(--cc-font-ui); padding: 3px 7px; border-radius: 7px; font-variant-numeric: tabular-nums;
  background: rgba(244, 232, 193, 0.1); color: var(--cc-cream); }
.ccs-chip.is-up { background: rgba(76, 175, 106, 0.22); color: #a8e6b8; }
.ccs-chip.is-down { background: rgba(224, 90, 71, 0.2); color: #ffb4a8; }
.ccs-card__act { grid-area: act; display: flex; align-items: center; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.ccs-price { margin-right: auto; font-family: var(--cc-font-display); font-size: 18px; color: #ffe39a; font-variant-numeric: tabular-nums; }
.ccs-price small { font-family: var(--cc-font-ui); font-size: 11.5px; color: var(--cc-danger); margin-left: 6px; }
.ccs-price.is-owned { color: var(--cc-cream-dim); font-family: var(--cc-font-ui); font-size: 13px; }
.ccs-btn { min-height: 44px; padding: 8px 16px; font-size: 14.5px; }
.ccs-btn[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.ccs-btn--ghost { background: transparent; border-color: rgba(244, 232, 193, 0.2); }
.ccs-btn--gold { background: var(--cc-gold); border-color: var(--cc-gold); color: #2a1d08; }
.ccs-btn--gold:hover { background: #e8b75a; border-color: #e8b75a; }

.ccs-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; padding: 12px 14px; border-radius: 14px;
  background: rgba(0, 0, 0, 0.18); border: 1px solid rgba(244, 232, 193, 0.08); }
.ccs-stat { display: grid; grid-template-columns: 64px 1fr 30px; align-items: center; gap: 8px; font-size: 12.5px; }
.ccs-stat span { color: var(--cc-cream-dim); }
.ccs-stat b { text-align: right; font-variant-numeric: tabular-nums; color: var(--cc-cream); }
.ccs-bar { position: relative; height: 8px; border-radius: 999px; background: rgba(244, 232, 193, 0.1); overflow: hidden; }
.ccs-bar i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: inherit; }
.ccs-bar .ccs-bar__base { background: var(--cc-green-500); }
.ccs-bar .ccs-bar__gear { background: var(--cc-gold); }
.ccs-stats__note { grid-column: 1 / -1; font-size: 11.5px; color: var(--cc-cream-dim); display: flex; gap: 14px; flex-wrap: wrap; }
.ccs-stats__note i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }

.ccs-coach { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-radius: 14px; margin-bottom: 10px;
  background: rgba(47, 109, 179, 0.14); border: 1px solid rgba(47, 109, 179, 0.4); }
.ccs-coach__txt { flex: 1; min-width: 0; font-size: 13px; line-height: 1.4; }
.ccs-coach__txt b { font-family: var(--cc-font-display); font-size: 16px; color: var(--cc-cream); display: block; }
.ccs-coach__left { flex: none; text-align: center; font-size: 11px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); }
.ccs-coach__left b { display: block; font-family: var(--cc-font-display); font-size: 22px; color: var(--cc-cream); letter-spacing: 0; }

.ccs-progress { height: 10px; border-radius: 999px; background: rgba(244, 232, 193, 0.1); overflow: hidden; margin-top: 8px; }
.ccs-progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #b8862e, #ffe39a); transition: width 0.4s ease; }
.ccs-progress__txt { display: flex; justify-content: space-between; font-size: 12px; margin-top: 4px; color: var(--cc-cream-dim); font-variant-numeric: tabular-nums; }
.ccs-progress__txt b { color: #ffe39a; }

.ccs-foot { flex: none; min-height: 40px; display: flex; align-items: center; justify-content: center; padding: 6px 16px 12px;
  font-size: 13.5px; text-align: center; color: var(--cc-cream-dim); }
.ccs-foot.is-ok { color: #a8e6b8; }
.ccs-foot.is-error { color: #ffb4a8; }
.ccs-foot.is-gold { color: #ffe39a; font-weight: 600; }

@media (max-width: 560px) {
  .ccs-overlay { padding: calc(var(--cc-safe-top, 0px) + 6px) calc(var(--cc-safe-right, 0px) + 6px)
                          calc(var(--cc-safe-bottom, 0px) + 6px) calc(var(--cc-safe-left, 0px) + 6px); }
  .ccs-panel { height: 100%; border-radius: 16px; }
  .ccs-head { padding: 12px 10px 4px 14px; gap: 8px; }
  .ccs-head__title { font-size: 21px; }
  .ccs-wallet { padding-right: 10px; }
  .ccs-wallet b { font-size: 18px; }
  .ccs-wallet__coin { width: 28px; height: 28px; font-size: 14px; }
  .ccs-tabs { padding: 4px 10px 8px; }
  .ccs-tab { padding: 0 13px; font-size: 13.5px; }
  .ccs-body { padding: 2px 10px 12px; }
  .ccs-grid { grid-template-columns: 1fr; }
  .ccs-stats { grid-template-columns: 1fr; }
}
@media (max-height: 520px) {
  .ccs-panel { height: 100%; }
  .ccs-head { padding-top: 8px; }
  .ccs-head__greet { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ccs-overlay, .ccs-panel { transition: none; }
  .ccs-card.is-flash, .ccs-wallet.is-bump { animation: none; }
}
`;

const STAT_LABEL = { power: 'Power', control: 'Control', spin: 'Spin', speed: 'Speed', serve: 'Serve', stamina: 'Stamina' };

const svg = (inner, vb = '0 0 64 64') => `<svg viewBox="${vb}" aria-hidden="true">${inner}</svg>`;
const TAB_ICONS = {
  gear: svg('<ellipse cx="9" cy="8" rx="5" ry="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 13l7 8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>', '0 0 24 24'),
  lessons: svg('<path d="M4 20V9l8-5 8 5v11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3" fill="currentColor"/>', '0 0 24 24'),
  style: svg('<path d="M8 4l4 2 4-2 5 4-3 3-2-1v10H8V10l-2 1-3-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>', '0 0 24 24'),
  cart: svg('<path d="M4 6h13M6 6v7M15 6v7M3 13h16l1 3H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="7" cy="18.5" r="1.8" fill="currentColor"/><circle cx="16" cy="18.5" r="1.8" fill="currentColor"/>', '0 0 24 24'),
  projects: svg('<path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.4 6.7 19.1l1-5.8L3.5 9.2l5.9-.9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>', '0 0 24 24'),
};
const CLOSE_ICON = svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>', '0 0 24 24');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const col = (c, d) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : d);

// ───────────────────────────── item art (inline SVG from the item's colours) ─────────────────────────────

function artRacket(frame = '#2b2b2b', strings = '#edead8') {
  return svg(`<g transform="rotate(-35 32 32)">
    <rect x="29.5" y="38" width="5" height="20" rx="2.5" fill="#1c1c1c"/>
    <path d="M30 38l-4-6M34 38l4-6" stroke="${frame}" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="32" cy="20" rx="13" ry="16" fill="${strings}" fill-opacity="0.35" stroke="${frame}" stroke-width="4"/>
    <g stroke="${strings}" stroke-width="1.1" opacity="0.95">
      <path d="M26 7v26M30 5v30M34 5v30M38 7v26M21 12h22M20 17h24M20 22h24M21 27h22M24 32h16"/></g></g>`);
}
function artShoe(shoe = '#eceae4', accent = '#2d5a3d') {
  return svg(`<path d="M8 40c0-6 4-11 9-12l9-2 8 7c4 3 10 4 17 5 5 1 7 4 7 7v3H8z" fill="${shoe}" stroke="rgba(0,0,0,0.35)" stroke-width="1.2"/>
    <path d="M8 48h50v4H8z" fill="#b9b4aa"/><path d="M22 32l14 10 16 1" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>
    <path d="M20 28l2 5M25 26l2 5M30 26l2 5" stroke="rgba(0,0,0,0.35)" stroke-width="1.4"/>`);
}
function artGrip(color, band) {
  if (band) {
    return svg(`<ellipse cx="32" cy="24" rx="17" ry="6" fill="${band}" opacity="0.7"/><rect x="15" y="24" width="34" height="18" fill="${band}"/>
      <ellipse cx="32" cy="42" rx="17" ry="6" fill="${band}"/><path d="M15 30h34M15 36h34" stroke="rgba(0,0,0,0.12)" stroke-width="2"/>`);
  }
  return svg(`<g transform="rotate(-30 32 32)"><rect x="25" y="6" width="14" height="52" rx="5" fill="${color || '#f4f1e8'}"/>
    <path d="M25 14l14-6M25 22l14-6M25 30l14-6M25 38l14-6M25 46l14-6M25 54l14-6" stroke="rgba(0,0,0,0.22)" stroke-width="2"/></g>`);
}
function artShirt(look) {
  const shirt = col(look.shirt, '#2d5a3d'), collar = col(look.collar, '#f4e8c1'), bottom = col(look.bottomColor, '#e8dcc0');
  const pants = look.bottom === 'pants';
  return svg(`<path d="M${pants ? '22 40h20l-1 22h-7l-2-12-2 12h-7z' : '21 42h22l-1 12h-8l-2-5-2 5h-8z'}" fill="${bottom}"/>
    ${pants && look.pantStripe ? `<path d="M24 42v20M40 42v20" stroke="${look.pantStripe}" stroke-width="1.6"/>` : ''}
    <path d="M22 8l10 4 10-4 12 8-5 9-6-3v22H21V22l-6 3-5-9z" fill="${shirt}"/>
    <path d="M26 8l6 7 6-7" fill="none" stroke="${collar}" stroke-width="3.2" stroke-linejoin="round"/>
    <path d="M15 22.5l-4.5-7.5M49 22.5l4.5-7.5" stroke="${col(look.sleeveTrim, collar)}" stroke-width="2.4"/>
    <path d="M32 15v8" stroke="${collar}" stroke-width="1.6"/>`);
}
function artHat(look) {
  const c = col(look.hatColor, '#2d5a3d'), b = col(look.hatBrim, c);
  switch (look.hat) {
    case 'visor': return svg(`<path d="M12 34c4-8 36-8 40 0" fill="none" stroke="${c}" stroke-width="5"/><path d="M14 36c10 8 26 8 36 0l4 4c-12 10-32 10-44 0z" fill="${b}"/>`);
    case 'bucket': return svg(`<path d="M20 20c2-6 22-6 24 0l3 16H17z" fill="${c}"/><path d="M8 38c6-4 42-4 48 0-6 5-42 5-48 0z" fill="${b}"/><path d="M18 31h28" stroke="${col(look.hatBand, '#2d5a3d')}" stroke-width="4"/>`);
    case 'headband': return svg(`<ellipse cx="32" cy="32" rx="20" ry="8" fill="none" stroke="${c}" stroke-width="8"/>`);
    case 'capBack': return svg(`<path d="M14 38c0-14 8-22 18-22s18 8 18 22z" fill="${c}"/><path d="M4 38h18l-2 5H6z" fill="${b}"/><circle cx="32" cy="16" r="2.5" fill="${b}"/>`);
    default: return svg(`<path d="M14 38c0-14 8-22 18-22s18 8 18 22z" fill="${c}"/><path d="M42 38h18l-2 5H44z" fill="${b}"/><circle cx="32" cy="16" r="2.5" fill="${b}"/>`);
  }
}
function artShades() {
  return svg(`<path d="M8 26h48" stroke="#8a7a52" stroke-width="2"/><path d="M10 26c0 10 4 14 10 14s9-5 9-12z" fill="#151719" stroke="#c9a24a" stroke-width="1.6"/>
    <path d="M54 26c0 10-4 14-10 14s-9-5-9-12z" fill="#151719" stroke="#c9a24a" stroke-width="1.6"/><path d="M14 30l6-2" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>`);
}
function artCart(c) {
  const body = col(c.body, '#ede8da'), accent = col(c.accent, '#2d5a3d'), canopy = col(c.canopy, '#2d5a3d'), trim = col(c.canopyTrim, '#f4e8c1');
  const rack = c.rack === 'cooler' ? '<rect x="47" y="28" width="9" height="10" rx="3" fill="#e87440"/><rect x="46" y="27" width="11" height="3" rx="1.5" fill="#f0f0f0"/>'
    : c.rack === 'balls' ? '<rect x="46" y="31" width="11" height="7" rx="1.5" fill="#3a3d40"/><circle cx="48.5" cy="30" r="2" fill="#d4e157"/><circle cx="52" cy="29.5" r="2" fill="#d4e157"/><circle cx="55" cy="30" r="2" fill="#d4e157"/>' : '';
  const light = col(c.lightColor, '#fff1c8');
  const lamp = c.lights === 'bar' ? `<rect x="5" y="35" width="3" height="5" rx="1" fill="${light}"/>` : c.lights === 'bug' ? `<circle cx="7" cy="34" r="3.4" fill="${light}" stroke="#c4c8cc" stroke-width="1.2"/>` : `<circle cx="7" cy="35" r="2.2" fill="${light}"/>`;
  return svg(`<rect x="10" y="12" width="44" height="4" rx="2" fill="${canopy}"/><rect x="11" y="16" width="42" height="1.6" fill="${trim}"/>
    <path d="M14 17l-2 18M50 17v18" stroke="#2b2e31" stroke-width="2"/>${rack}
    <path d="M6 40c0-5 3-8 8-8h8l4-4h14v6h14c3 0 4 2 4 6v4H6z" fill="${body}"/><rect x="6" y="41" width="52" height="2.4" fill="${accent}"/>
    <rect x="26" y="27" width="14" height="5" rx="2" fill="#d8c7a0"/>${lamp}
    <circle cx="17" cy="47" r="6" fill="#1e1f21"/><circle cx="17" cy="47" r="2.6" fill="#c4c8cc"/><circle cx="47" cy="47" r="6" fill="#1e1f21"/><circle cx="47" cy="47" r="2.6" fill="#c4c8cc"/>`);
}
function artHorn(style) {
  const notes = { beep: 1, chime: 2, ahooga: 3, fanfare: 4 }[style] || 1;
  let n = '';
  for (let i = 0; i < notes; i++) n += `<path d="M${40 + i * 5} ${22 - i * 3}v10" stroke="#ffe39a" stroke-width="2"/><circle cx="${38.5 + i * 5}" cy="${32 - i * 3}" r="2.4" fill="#ffe39a"/>`;
  return svg(`<path d="M8 26h8l12-10v32L16 38H8z" fill="#c4c8cc"/><path d="M31 24c3 4 3 12 0 16" fill="none" stroke="#c4c8cc" stroke-width="2.4" stroke-linecap="round"/>${n}`);
}
const PROJECT_ART = {
  project_koi: svg('<ellipse cx="32" cy="34" rx="26" ry="16" fill="#3a8fb7"/><ellipse cx="28" cy="32" rx="10" ry="4.5" fill="#e8732c"/><path d="M17 32l-6-4v8z" fill="#e8732c"/><circle cx="31" cy="31" r="2" fill="#f4f1e8"/><ellipse cx="44" cy="40" rx="6" ry="3" fill="#4f8a3c"/><circle cx="45" cy="38" r="2" fill="#f4a7c0"/>'),
  project_trophy: svg('<path d="M20 10h24v8c0 10-6 16-12 16s-12-6-12-16z" fill="#d9a441"/><path d="M20 14h-6c0 8 4 11 8 11M44 14h6c0 8-4 11-8 11" fill="none" stroke="#d9a441" stroke-width="3"/><path d="M29 34h6v8h-6z" fill="#d9a441"/><rect x="21" y="42" width="22" height="10" rx="2" fill="#5a3a22"/><rect x="27" y="45" width="10" height="3" fill="#d9a441"/>'),
  project_flowers: svg('<rect x="8" y="38" width="48" height="16" rx="3" fill="#a4553a"/><rect x="6" y="36" width="52" height="4" rx="2" fill="#cfc3a8"/><circle cx="16" cy="30" r="6" fill="#4f8f45"/><circle cx="32" cy="28" r="7" fill="#3f7d3a"/><circle cx="48" cy="30" r="6" fill="#4f8f45"/><circle cx="14" cy="26" r="3" fill="#e84a6f"/><circle cx="22" cy="28" r="3" fill="#f4d03f"/><circle cx="30" cy="22" r="3" fill="#f4f1e8"/><circle cx="37" cy="25" r="3" fill="#9b59b6"/><circle cx="46" cy="25" r="3" fill="#e84a6f"/><circle cx="52" cy="28" r="3" fill="#e8732c"/>'),
  project_scoreboard: svg('<rect x="6" y="10" width="52" height="32" rx="3" fill="#12301f" stroke="#2b4a36" stroke-width="3"/><rect x="24" y="5" width="16" height="4" fill="#d9a441"/><path d="M10 22h24M10 32h24" stroke="#f4e8c1" stroke-width="3"/><text x="44" y="26" font-size="9" fill="#ffe39a" font-family="sans-serif" font-weight="700">4</text><text x="44" y="37" font-size="9" fill="#ffe39a" font-family="sans-serif" font-weight="700">2</text><path d="M16 42v16M48 42v16" stroke="#2b4a36" stroke-width="3"/>'),
  project_patio: svg('<path d="M18 58V22M46 58V22" stroke="#9aa0a4" stroke-width="2.4"/><path d="M8 20l10-8 10 8zM36 20l10-8 10 8z" fill="#9aa0a4"/><rect x="16" y="22" width="4" height="7" fill="#ffb86e"/><rect x="44" y="22" width="4" height="7" fill="#ffb86e"/><path d="M4 8c14 8 42 8 56 0" fill="none" stroke="#1f2622" stroke-width="1.4"/><circle cx="14" cy="11" r="2" fill="#ffe2a8"/><circle cx="25" cy="13" r="2" fill="#ffe2a8"/><circle cx="39" cy="13" r="2" fill="#ffe2a8"/><circle cx="50" cy="11" r="2" fill="#ffe2a8"/><rect x="14" y="56" width="8" height="3" fill="#1f2622"/><rect x="42" y="56" width="8" height="3" fill="#1f2622"/>'),
  project_wall: svg('<rect x="6" y="8" width="52" height="34" rx="2" fill="#2f6a45"/><rect x="5" y="6" width="54" height="4" fill="#cfc8b8"/><path d="M8 30h48" stroke="#f0eee6" stroke-width="2"/><circle cx="32" cy="18" r="6" fill="#d9a441"/><circle cx="32" cy="18" r="4.5" fill="#1f4a34"/><path d="M4 42h56l4 14H0z" fill="#618c66"/><circle cx="44" cy="48" r="3" fill="#d8e04e"/>'),
};
const LESSON_ART = svg('<circle cx="32" cy="32" r="24" fill="rgba(47,109,179,0.35)"/><path d="M22 44l12-12" stroke="#f4e8c1" stroke-width="3" stroke-linecap="round"/><ellipse cx="38" cy="25" rx="8" ry="10" fill="none" stroke="#f4e8c1" stroke-width="3" transform="rotate(40 38 25)"/><circle cx="20" cy="22" r="5" fill="#d8e04e"/>');

function itemArt(item, shop) {
  const look = item.look || {};
  const cart = item.cart ? { ...shop.cartLook(), ...item.cart } : null;
  switch (item.slot) {
    case 'racket': return artRacket(col(look.racket, '#2b2b2b'), col((shop.equippedItem('strings') || {}).look?.racketStrings, '#edead8'));
    case 'strings': return artRacket(col((shop.equippedItem('racket') || {}).look?.racket, '#2b2b2b'), col(look.racketStrings, '#edead8'));
    case 'shoes': return artShoe(col(look.shoes, '#eceae4'), col(look.shoeAccent, '#2d5a3d'));
    case 'grip': return artGrip(null, look.wristband ? col(look.wristband, '#f4e8c1') : null);
    case 'uniform': return artShirt(look);
    case 'hat': return artHat(look);
    case 'eyewear': return artShades();
    case 'cartHorn': return artHorn(item.cart && item.cart.horn);
    default: return cart ? artCart(cart) : LESSON_ART;
  }
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

let cssInjected = false;

export class ShopUI {
  constructor(opts) {
    this.opts = opts;
    this.shop = opts.shop;
    this.profile = opts.profile;
    this.isOpen = false;
    this.mode = 'shop';
    this.tab = 'gear';
    this.tabs = [];
    this._statusTimer = null;
    injectTheme();
    if (!cssInjected) {
      cssInjected = true;
      const style = document.createElement('style');
      style.id = 'cc-shop-css';
      style.textContent = SHOP_CSS;
      document.head.appendChild(style);
    }
    this.root = document.getElementById('ui-root') || document.body;
    this._build();
  }

  // ───────────────────────────── build ─────────────────────────────

  _build() {
    const ov = el('div', 'ccs-overlay');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-hidden', 'true');
    ov.setAttribute('aria-labelledby', 'ccs-title');
    // Keep every pointer away from the game canvas while open
    for (const ev of ['touchstart', 'touchmove', 'mousedown', 'pointerdown', 'wheel', 'click']) {
      ov.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    ov.addEventListener('keydown', (e) => this._onKey(e));

    const panel = el('div', 'ccs-panel cc-panel');
    const head = el('div', 'ccs-head');
    head.innerHTML = `
      <div class="ccs-head__text">
        <div class="cc-label ccs-head__label" data-ref="label">Greenbriar Pro Shop</div>
        <h2 class="cc-title ccs-head__title" id="ccs-title" data-ref="title">Pro Shop</h2>
        <div class="ccs-head__greet" data-ref="greet"></div>
      </div>
      <div class="ccs-wallet" data-ref="wallet" aria-label="Wallet"><span class="ccs-wallet__coin">$</span><b data-ref="walletAmt">0</b></div>`;
    const close = el('button', 'cc-btn ccs-close', CLOSE_ICON);
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    head.appendChild(close);
    this.closeBtn = close;
    this.labelEl = head.querySelector('[data-ref="label"]');
    this.titleEl = head.querySelector('[data-ref="title"]');
    this.greetEl = head.querySelector('[data-ref="greet"]');
    this.walletEl = head.querySelector('[data-ref="wallet"]');
    this.walletAmtEl = head.querySelector('[data-ref="walletAmt"]');

    this.tabsEl = el('div', 'ccs-tabs');
    this.tabsEl.setAttribute('role', 'tablist');
    this.bodyEl = el('div', 'ccs-body');
    this.bodyEl.setAttribute('role', 'tabpanel');
    this.footEl = el('div', 'ccs-foot');
    this.footEl.setAttribute('role', 'status');
    this.footEl.setAttribute('aria-live', 'polite');

    panel.append(head, this.tabsEl, this.bodyEl, this.footEl);
    ov.appendChild(panel);
    this.overlay = ov;
    this.panel = panel;
    this.root.appendChild(ov);

    // One delegated click handler for every card button (data-act / data-id)
    this.bodyEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || !this.bodyEl.contains(b)) return;
      e.preventDefault();
      this._act(b.dataset.act, b.dataset.id, b.dataset.arg, b);
    });
  }

  // ───────────────────────────── open / close ─────────────────────────────

  /**
   * @param {{ mode?: 'shop'|'locker', vendor?: string, tab?: string, greeting?: string }} o
   */
  open(o = {}) {
    this.mode = o.mode === 'locker' ? 'locker' : 'shop';
    const vendor = o.vendor ? this.shop.vendor(o.vendor) : null;
    const all = this.shop.categories.map(c => c.id);
    if (this.mode === 'locker') this.tabs = ['gear', 'style', 'cart'];
    else this.tabs = vendor && Array.isArray(vendor.tabs) ? vendor.tabs.filter(t => all.includes(t)) : all;
    if (!this.tabs.length) this.tabs = all;
    this.tab = this.tabs.includes(o.tab) ? o.tab : this.tabs[0];
    this.labelEl.textContent = this.mode === 'locker' ? 'Staff room' : 'Greenbriar Tennis & Social Club';
    this.titleEl.textContent = this.mode === 'locker' ? 'Locker' : (vendor && vendor.title) || 'Pro Shop';
    this.greetEl.textContent = o.greeting || (this.mode === 'locker' ? 'Change what you wear and drive. Buy new things at the pro shop counter.' : '');
    this.greetEl.style.display = this.greetEl.textContent ? '' : 'none';
    this._renderTabs();
    this.refresh();
    this._setStatus('');
    this.isOpen = true;
    this._lastFocus = document.activeElement;
    this.overlay.classList.add('is-open');
    this.overlay.setAttribute('aria-hidden', 'false');
    this.bodyEl.scrollTop = 0;
    requestAnimationFrame(() => { if (this.isOpen) try { this.closeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.overlay.classList.remove('is-open');
    this.overlay.setAttribute('aria-hidden', 'true');
    if (document.activeElement && this.overlay.contains(document.activeElement)) document.activeElement.blur();
    clearTimeout(this._statusTimer);
    if (this.opts.onClose) this.opts.onClose(this.mode);
  }

  _renderTabs() {
    this.tabsEl.textContent = '';
    for (const id of this.tabs) {
      const cat = this.shop.categories.find(c => c.id === id);
      const b = el('button', 'ccs-tab', `${TAB_ICONS[id] || ''}<span>${esc(cat ? cat.title : id)}</span>`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      b.addEventListener('click', () => this.showTab(id));
      this.tabsEl.appendChild(b);
    }
    this._syncTabs();
  }

  _syncTabs() {
    for (const b of this.tabsEl.children) b.setAttribute('aria-selected', b.dataset.tab === this.tab ? 'true' : 'false');
  }

  showTab(id) {
    if (!this.tabs.includes(id)) return;
    this.tab = id;
    this._syncTabs();
    this.refresh();
    this.bodyEl.scrollTop = 0;
  }

  // ───────────────────────────── render ─────────────────────────────

  refresh() {
    this.walletAmtEl.textContent = Math.round(this.profile.wallet).toLocaleString('en-US');
    const body = this.bodyEl;
    const keep = body.scrollTop;
    body.textContent = '';
    const cat = this.shop.categories.find(c => c.id === this.tab);
    if (cat && cat.blurb && this.mode === 'shop') body.appendChild(el('p', 'ccs-blurb', esc(cat.blurb)));
    if (this.tab === 'lessons') this._renderLessons(body);
    else if (this.tab === 'projects') this._renderProjects(body);
    else this._renderSlots(body, this.tab);
    body.scrollTop = keep;
  }

  _renderStats(body, { lessons = false } = {}) {
    const stats = this.profile.getTennisStats();
    const base = this.profile.skills;
    const box = el('div', 'ccs-stats');
    box.setAttribute('aria-label', 'Your tennis stats');
    for (const s of TENNIS_STATS) {
      const total = stats[s];
      const b = Math.min(total, base[s]);
      const row = el('div', 'ccs-stat');
      row.innerHTML = `<span>${STAT_LABEL[s]}</span><div class="ccs-bar"><i class="ccs-bar__gear" style="width:${total}%"></i><i class="ccs-bar__base" style="width:${b}%"></i></div><b>${total}</b>`;
      box.appendChild(row);
    }
    const note = el('div', 'ccs-stats__note', `<span><i style="background:var(--cc-green-500)"></i>Skill${lessons ? ' (lessons raise this)' : ''}</span><span><i style="background:var(--cc-gold)"></i>Gear bonus</span>`);
    box.appendChild(note);
    body.appendChild(box);
  }

  _renderSlots(body, category) {
    const shop = this.shop;
    if (category === 'gear') this._renderStats(body);
    const locker = this.mode === 'locker';
    for (const slot of shop.slotsFor(category)) {
      let items = shop.itemsForSlot(slot.id);
      if (locker) items = items.filter(it => shop.isOwned(it.id));
      const cur = shop.equippedItem(slot.id);
      const sec = el('div', 'ccs-section', `<span class="cc-label">${esc(slot.title)}</span><span class="ccs-section__now">${cur ? 'Wearing: ' + esc(cur.name) : (slot.optional ? 'Nothing equipped' : '')}</span>`);
      if (slot.id.startsWith('cart')) sec.querySelector('.ccs-section__now').textContent = cur ? 'Fitted: ' + cur.name : 'Nothing fitted';
      body.appendChild(sec);
      const grid = el('div', 'ccs-grid');
      if (!items.length) {
        grid.appendChild(el('div', 'ccs-empty', locker ? 'Nothing here yet. The pro shop counter has plenty.' : 'Sold out.'));
      }
      for (const it of items) grid.appendChild(this._itemCard(it, slot));
      if (slot.optional && cur) {
        const off = el('div', 'ccs-card');
        off.innerHTML = `<div class="ccs-card__art">${slot.id === 'hat' && this.opts.hasRankCap && this.opts.hasRankCap()
          ? artHat({ hat: 'cap', hatColor: '#d9a441' }) : slot.id === 'hat' ? artHat({ hat: 'cap', hatColor: '#2d5a3d' }) : '<span style="font-size:26px;opacity:.6">—</span>'}</div>
          <div class="ccs-card__main"><div class="ccs-card__name">${slot.id === 'hat' ? 'Staff cap' : 'None'}</div>
          <div class="ccs-card__desc">${slot.id === 'hat' ? (this.opts.hasRankCap && this.opts.hasRankCap() ? 'Your rank cap, in Grounds Lead gold.' : 'The regulation club-green cap.') : 'Go without.'}</div></div>
          <div class="ccs-card__act"><span class="ccs-price is-owned">Always yours</span><button type="button" class="cc-btn ccs-btn" data-act="unequip" data-id="${esc(slot.id)}">${slot.id === 'hat' ? 'Wear' : 'Take off'}</button></div>`;
        grid.appendChild(off);
      }
      body.appendChild(grid);
    }
  }

  _itemCard(it) {
    const shop = this.shop;
    const owned = shop.isOwned(it.id);
    const equipped = shop.isEquipped(it.id);
    const locked = !owned && shop.isLocked(it);
    const card = el('div', 'ccs-card' + (equipped ? ' is-equipped' : '') + (locked ? ' is-locked' : ''));
    card.dataset.id = it.id;
    let chips = '';
    if (it.stats) {
      const delta = shop.statDelta(it);
      const show = equipped || !Object.keys(delta).length ? it.stats : delta;
      for (const s of TENNIS_STATS) {
        const v = show[s];
        if (!v) continue;
        chips += `<span class="ccs-chip ${v > 0 ? 'is-up' : 'is-down'}" title="${equipped ? 'Bonus' : 'Change vs. equipped'}">${v > 0 ? '+' : '−'}${Math.abs(v)} ${STAT_LABEL[s]}</span>`;
      }
      if (!equipped && Object.keys(delta).length && chips) chips = `<span class="ccs-chip" title="Compared with what you have equipped">vs. now</span>` + chips;
    }
    const tag = equipped ? '<span class="ccs-card__tag">On</span>' : '';
    let act;
    if (equipped) {
      act = `<span class="ccs-price is-owned">${it.price ? 'Owned' : 'Standard issue'}</span><button type="button" class="cc-btn ccs-btn" aria-disabled="true" data-act="noop">Equipped ✓</button>`;
    } else if (owned) {
      act = `<span class="ccs-price is-owned">${it.price ? 'Owned' : 'Standard issue'}</span><button type="button" class="cc-btn cc-btn--primary ccs-btn" data-act="equip" data-id="${esc(it.id)}">Equip</button>`;
    } else if (this.mode === 'locker') {
      act = '';
    } else if (locked) {
      act = `<span class="ccs-price">${money(it.price)}</span><button type="button" class="cc-btn ccs-btn" aria-disabled="true" data-act="locked" data-id="${esc(it.id)}">Needs ${esc(shop.rankTitle(shop.rankNeeded(it)))}</button>`;
    } else {
      const short = it.price - this.profile.wallet;
      act = `<span class="ccs-price">${money(it.price)}${short > 0 ? `<small>need ${money(short)} more</small>` : ''}</span>
        <button type="button" class="cc-btn ${short > 0 ? '' : 'ccs-btn--gold '}ccs-btn" ${short > 0 ? 'aria-disabled="true"' : ''} data-act="buy" data-id="${esc(it.id)}">Buy</button>`;
    }
    card.innerHTML = `<div class="ccs-card__art">${itemArt(it, shop)}</div>
      <div class="ccs-card__main"><div class="ccs-card__name">${esc(it.name)}${tag}</div>
        <div class="ccs-card__desc">${esc(it.desc)}</div>${chips ? `<div class="ccs-chips">${chips}</div>` : ''}</div>
      <div class="ccs-card__act">${act}</div>`;
    return card;
  }

  _renderLessons(body) {
    const shop = this.shop;
    const price = shop.lessonPrice();
    const left = shop.lessonsLeftToday();
    const coach = el('div', 'ccs-coach');
    coach.innerHTML = `<div class="ccs-card__art">${LESSON_ART}</div>
      <div class="ccs-coach__txt"><b>Coach Rafa Ibarra</b>Next lesson ${money(price)}. Each one raises your skills for good; the price creeps up as you improve.</div>
      <div class="ccs-coach__left"><b>${left}</b>left today</div>`;
    body.appendChild(coach);
    this._renderStats(body, { lessons: true });
    body.appendChild(el('div', 'ccs-section', `<span class="cc-label">Sessions</span><span class="ccs-section__now">${this.profile.lessons} taken so far</span>`));
    const grid = el('div', 'ccs-grid');
    for (const l of shop.data.lessons.list) {
      const card = el('div', 'ccs-card');
      card.dataset.id = l.id;
      let chips = '';
      for (const s of TENNIS_STATS) if (l.boosts[s]) chips += `<span class="ccs-chip is-up">+${l.boosts[s]} ${STAT_LABEL[s]}</span>`;
      const short = price - this.profile.wallet;
      let act;
      if (left <= 0) act = `<span class="ccs-price">${money(price)}</span><button type="button" class="cc-btn ccs-btn" aria-disabled="true" data-act="limit">Back tomorrow</button>`;
      else act = `<span class="ccs-price">${money(price)}${short > 0 ? `<small>need ${money(short)} more</small>` : ''}</span>
        <button type="button" class="cc-btn ${short > 0 ? '' : 'ccs-btn--gold '}ccs-btn" ${short > 0 ? 'aria-disabled="true"' : ''} data-act="lesson" data-id="${esc(l.id)}">Book</button>`;
      card.innerHTML = `<div class="ccs-card__art">${LESSON_ART}</div>
        <div class="ccs-card__main"><div class="ccs-card__name">${esc(l.name)}</div><div class="ccs-card__desc">${esc(l.desc)}</div><div class="ccs-chips">${chips}</div></div>
        <div class="ccs-card__act">${act}</div>`;
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  _renderProjects(body) {
    const shop = this.shop;
    const grid = el('div', 'ccs-grid');
    const wallet = this.profile.wallet;
    for (const p of shop.data.projects) {
      const pr = shop.projectProgress(p.id);
      const card = el('div', 'ccs-card' + (pr.done ? ' is-equipped' : ''));
      card.dataset.id = p.id;
      let act;
      if (pr.done) {
        act = `<span class="ccs-price is-owned">Funded ✓ · see it at ${esc(p.place || 'the club')}</span>`;
      } else {
        const all = Math.min(pr.remaining, wallet);
        const btn = (amt, label, gold) => {
          const dis = wallet < 1 || (amt > wallet && label !== 'all');
          return `<button type="button" class="cc-btn ${gold && !dis ? 'ccs-btn--gold ' : ''}ccs-btn" ${dis ? 'aria-disabled="true"' : ''} data-act="fund" data-id="${esc(p.id)}" data-arg="${amt}">${label === 'all' ? (all >= pr.remaining ? `Fund the rest ${money(all)}` : `All in ${money(all)}`) : '+' + money(amt)}</button>`;
        };
        act = (pr.remaining > 50 ? btn(50, '50') : '') + (pr.remaining > 250 ? btn(250, '250') : '') + btn(all, 'all', true);
      }
      card.innerHTML = `<div class="ccs-card__art">${PROJECT_ART[p.id] || LESSON_ART}</div>
        <div class="ccs-card__main"><div class="ccs-card__name">${esc(p.name)}${pr.done ? '<span class="ccs-card__tag">Built</span>' : ''}</div>
          <div class="ccs-card__desc">${esc(p.desc)}</div>
          <div class="ccs-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${pr.cost}" aria-valuenow="${pr.funded}"><i style="width:${(pr.frac * 100).toFixed(1)}%"></i></div>
          <div class="ccs-progress__txt"><span><b>${money(pr.funded)}</b> of ${money(pr.cost)}</span><span>${pr.done ? 'Complete' : money(pr.remaining) + ' to go'}</span></div></div>
        <div class="ccs-card__act">${act}</div>`;
      grid.appendChild(card);
    }
    body.appendChild(grid);
  }

  // ───────────────────────────── actions ─────────────────────────────

  _act(act, id, arg) {
    const shop = this.shop;
    const fb = (r) => { if (this.opts.onFeedback) this.opts.onFeedback(r); };
    let r = null;
    switch (act) {
      case 'buy': {
        r = shop.buy(id);
        if (r.ok) {
          this._setStatus(r.equipped ? `${r.item.name}: yours, and you're wearing it.` : `${r.item.name}: yours. Your rank cap stays on until you pick the hat below.`, 'ok');
        } else if (r.reason === 'funds') {
          this._setStatus(`Not enough cash: you need ${money(r.short || 0)} more. Work a few more tasks!`, 'error');
        } else if (r.reason === 'locked') {
          this._setStatus(`Reach ${shop.rankTitle(shop.rankNeeded(r.item))} to buy this.`, 'error');
        }
        fb({ kind: 'buy', ...r });
        break;
      }
      case 'equip':
        if (shop.equip(id)) { this._setStatus(`Now wearing: ${(shop.getItem(id) || {}).name}.`, 'ok'); fb({ kind: 'equip', ok: true, id }); }
        break;
      case 'unequip':
        if (shop.unequip(id)) { this._setStatus('Changed.', 'ok'); fb({ kind: 'equip', ok: true, id }); }
        break;
      case 'locked': {
        const it = shop.getItem(id);
        this._setStatus(`Reach ${shop.rankTitle(shop.rankNeeded(it))} to buy this.`, 'error');
        break;
      }
      case 'limit':
        this._setStatus('Rafa: "Two a day. Muscles need to sleep too." Come back tomorrow.', 'error');
        break;
      case 'lesson': {
        r = shop.bookLesson(id);
        if (r.ok) {
          const g = Object.entries(r.gains).map(([s, v]) => `${STAT_LABEL[s]} +${v}`).join(', ');
          this._setStatus(`${r.lesson.name} done: ${g || 'skills maxed'}. Rafa: "Good! Again!"`, 'gold');
        } else if (r.reason === 'funds') this._setStatus(`Not enough cash: you need ${money(r.short || 0)} more.`, 'error');
        else if (r.reason === 'limit') this._setStatus('Rafa: "Two a day. Muscles need to sleep too." Come back tomorrow.', 'error');
        fb({ kind: 'lesson', ...r });
        break;
      }
      case 'fund': {
        r = shop.contribute(id, Number(arg) || 0);
        if (r.ok) {
          this._setStatus(r.done ? `${r.project.name} is fully funded! Go and see it at ${r.project.place || 'the club'}.` : `You put ${money(r.amount)} toward ${r.project.name}.`, r.done ? 'gold' : 'ok');
        } else if (r.reason === 'funds') this._setStatus(this.profile.wallet < 1 ? 'Your wallet is empty. Tips and tasks will fix that.' : `Not enough cash for that. Try a smaller amount.`, 'error');
        fb({ kind: 'fund', ...r });
        break;
      }
      default:
        return;
    }
    this.refresh();
    if (r && r.ok) {
      this.walletEl.classList.remove('is-bump');
      void this.walletEl.offsetWidth;
      this.walletEl.classList.add('is-bump');
    }
    const card = id ? Array.from(this.bodyEl.querySelectorAll('.ccs-card')).find(c => c.dataset.id === id) : null;
    if (card && (act === 'equip' || (r && r.ok))) {
      card.classList.add('is-flash');
      const b = card.querySelector('button:not([aria-disabled="true"])') || card.querySelector('button');
      if (b) try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  _setStatus(text, kind = '') {
    this.footEl.textContent = text || (this.mode === 'locker' ? 'Esc or ✕ to go back' : 'Tap Buy to purchase · Esc or ✕ to leave');
    this.footEl.className = 'ccs-foot' + (text && kind ? ` is-${kind}` : '');
    clearTimeout(this._statusTimer);
    if (text) this._statusTimer = setTimeout(() => this._setStatus(''), 6000);
  }

  _onKey(e) {
    if (e.key === 'Tab') {
      const items = Array.from(this.panel.querySelectorAll('button')).filter(x => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!e.target.classList || !e.target.classList.contains('ccs-tab')) return;
      const i = this.tabs.indexOf(this.tab) + (e.key === 'ArrowRight' ? 1 : -1);
      const next = this.tabs[(i + this.tabs.length) % this.tabs.length];
      this.showTab(next);
      const b = this.tabsEl.querySelector(`[data-tab="${next}"]`);
      if (b) b.focus();
    }
  }
}

