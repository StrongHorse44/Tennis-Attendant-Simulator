import { injectTheme } from './theme.js';

/**
 * TourUI — the Junior Tennis Tour hub plus the tour's story cards (DOM in #ui-root, theme.js
 * tokens). It owns no tour logic: it reads TourSystem.getHub() (plain data) and calls enter /
 * withdraw through the callbacks it is given.
 *
 *   const ui = new TourUI({
 *     getHub() -> hub | null,            // TourSystem.getHub()
 *     enter(id) -> { ok, reason },       // TourSystem.enter
 *     withdraw(id) -> { ok, reason },    // TourSystem.withdraw
 *     onOpen(kind),                      // first tour overlay opened ('hub' | 'modal'): freeze the game
 *     onClose({ kind, changed }),        // last one closed (changed: an entry / withdrawal went through)
 *     canPlayTonight?() -> bool,         // show "Play now" on tonight's banner (the report card is up)
 *     onPlayTonight?(spec),              // ...and start that match (the hub closes first)
 *     onFeedback?(kind, result),         // 'tab' | 'enter' | 'withdraw' | 'error' | 'offer' | 'champion' | 'result'
 *   });
 *
 * Hub (full-screen overlay; ✕ / Esc / P close it; tabs: week, draw, rankings, calendar, profile, scouting)
 *   ui.open({ tab? })  ui.close()  ui.refresh()  ui.showTab(id)  ui.isOpen
 * Story cards (queued, one at a time, above the hub):
 *   ui.showOffer({ onAccept, onLater, lines?, title?, openHub = true })      // Rafa: "Let me coach you"
 *   ui.showChoice({ title, speaker, role?, body, choices: [{ label, desc, primary }], cancel? }, onPick(i, choice))
 *   ui.showTournamentResult({ tournamentName, roundLabel, won, score, opponent, pointsGained, prizeGained,
 *                             next, champion, rank, rankDelta }, onClose | { onClose, hubButton })
 *   ui.isModalOpen, ui.closeModal()
 *
 * The overlays sit above the report card (300), the pause menu (800) and the shop (850). While one is
 * up, Esc / P close it in a capture-phase listener, so the game's pause toggle never runs under it.
 * The DOM is built once; a tab's content is rebuilt only on open, tab switch and after an action.
 */

const CSS = `
.ccj-defs { position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none; }
.ccj-overlay, .ccj-modal {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; visibility: hidden;
  transition: opacity 0.2s ease, visibility 0s linear 0.2s;
  touch-action: manipulation; overscroll-behavior: contain;
  font-family: var(--cc-font-ui); color: var(--cc-cream);
}
.ccj-overlay.is-open, .ccj-modal.is-open { opacity: 1; visibility: visible; transition: opacity 0.2s ease, visibility 0s; }
.ccj-overlay {
  z-index: 860;
  padding: calc(var(--cc-safe-top) + 12px) calc(var(--cc-safe-right) + 12px) calc(var(--cc-safe-bottom) + 12px) calc(var(--cc-safe-left) + 12px);
  background: radial-gradient(ellipse at 50% 35%, rgba(23, 58, 38, 0.45), rgba(8, 18, 12, 0.8) 75%);
  backdrop-filter: blur(6px) saturate(0.85); -webkit-backdrop-filter: blur(6px) saturate(0.85);
}
.ccj-panel {
  position: relative; display: flex; flex-direction: column;
  width: min(940px, 100%); height: min(720px, 100%);
  background: linear-gradient(180deg, rgba(31, 66, 45, 0.97), rgba(16, 34, 23, 0.98));
  border-radius: 20px; overflow: hidden;
  transform: translateY(12px) scale(0.97); transition: transform 0.24s cubic-bezier(.2,.9,.3,1.12);
}
.ccj-overlay.is-open .ccj-panel { transform: none; }
.ccj-panel::before, .ccj-mcard::before {
  content: ''; position: absolute; inset: 6px; border: 1px solid rgba(217, 164, 65, 0.22);
  border-radius: 15px; pointer-events: none; z-index: 3;
}

/* header */
.ccj-head { display: flex; align-items: center; gap: 12px; padding: 16px 16px 8px 20px; flex: none; }
.ccj-crest {
  flex: none; width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center;
  background: radial-gradient(circle at 35% 30%, rgba(255, 231, 163, 0.32), rgba(217, 164, 65, 0.1));
  border: 1px solid rgba(217, 164, 65, 0.5);
}
.ccj-crest svg { width: 34px; height: 34px; }
.ccj-head__text { flex: 1; min-width: 0; }
.ccj-head__label { color: var(--cc-gold); letter-spacing: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-head__title { margin: 2px 0 0; font-size: 25px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-head__sub { margin-top: 3px; font-size: 13px; color: var(--cc-cream-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.ccj-head__sub span + span::before { content: ' · '; }
.ccj-wallet {
  flex: none; display: flex; align-items: center; gap: 7px; min-height: 44px; padding: 4px 13px 4px 6px;
  border-radius: 999px; background: rgba(217, 164, 65, 0.14); border: 1px solid rgba(217, 164, 65, 0.45);
}
.ccj-wallet[hidden] { display: none; }
.ccj-wallet__coin { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
  background: radial-gradient(circle at 35% 30%, #ffe39a, #d9a441 60%, #a8792a); color: #3b2a10; font-weight: 800; font-size: 15px; }
.ccj-wallet b { font-family: var(--cc-font-display); font-size: 20px; color: #ffe39a; font-variant-numeric: tabular-nums; font-weight: 600; }
.ccj-close { flex: none; width: 44px; height: 44px; padding: 0; border-radius: 50%; display: grid; place-items: center; }
.ccj-close svg { width: 18px; height: 18px; }

/* tabs */
.ccj-tabs { display: flex; gap: 6px; padding: 6px 16px 10px; overflow-x: auto; scrollbar-width: none; flex: none; -webkit-overflow-scrolling: touch; }
.ccj-tabs::-webkit-scrollbar { display: none; }
.ccj-tabs[hidden] { display: none; }
.ccj-tab {
  flex: none; position: relative; min-height: 44px; padding: 0 15px; border-radius: 999px;
  border: 1px solid rgba(244, 232, 193, 0.16); background: rgba(244, 232, 193, 0.06);
  color: var(--cc-cream-dim); font: 600 14px var(--cc-font-ui); cursor: pointer;
  display: flex; align-items: center; gap: 7px; -webkit-tap-highlight-color: transparent;
  transition: background 0.15s ease, color 0.15s ease;
}
.ccj-tab svg { width: 17px; height: 17px; flex: none; }
.ccj-tab:hover { background: rgba(244, 232, 193, 0.12); color: var(--cc-cream); }
.ccj-tab[aria-selected="true"] { background: var(--cc-cream); color: var(--cc-green-900); border-color: var(--cc-cream); }
.ccj-tab:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 2px; }
.ccj-tab__dot { position: absolute; top: 6px; right: 7px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--cc-gold); box-shadow: 0 0 0 2px rgba(20, 38, 28, 0.95); }
.ccj-tab__dot[hidden] { display: none; }

/* body + footer */
.ccj-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 4px 16px 16px; overscroll-behavior: contain; }
.ccj-body:focus { outline: none; }
.ccj-foot { flex: none; min-height: 38px; display: flex; align-items: center; justify-content: center; padding: 4px 16px 10px;
  font-size: 13px; text-align: center; color: var(--cc-cream-dim); }
.ccj-foot:empty { min-height: 12px; padding: 0; }
.ccj-foot.is-ok { color: #a8e6b8; }
.ccj-foot.is-error { color: #ffb4a8; }
.ccj-foot.is-gold { color: #ffe39a; font-weight: 600; }

/* shared blocks */
.ccj-card { position: relative; background: rgba(244, 232, 193, 0.05); border: 1px solid rgba(244, 232, 193, 0.1); border-radius: 14px; padding: 14px; min-width: 0; }
.ccj-sec { margin: 16px 2px 8px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ccj-sec:first-child { margin-top: 2px; }
.ccj-sec .cc-label { color: var(--cc-gold); }
.ccj-sec__aside { font-size: 12px; color: var(--cc-cream-dim); text-align: right; }
.ccj-empty { padding: 26px 18px; text-align: center; font-size: 13.5px; line-height: 1.5; color: var(--cc-cream-dim);
  border: 1px dashed rgba(244, 232, 193, 0.18); border-radius: 14px; }
.ccj-empty svg { display: block; margin: 0 auto 10px; width: 46px; height: 46px; color: rgba(244, 232, 193, 0.5); }
.ccj-empty b { display: block; color: var(--cc-cream); font-family: var(--cc-font-display); font-weight: 600; font-size: 18px; margin-bottom: 4px; }
.ccj-empty .cc-btn { margin-top: 12px; }
.ccj-note { font-size: 12.5px; color: var(--cc-cream-dim); line-height: 1.45; }
.ccj-chip { display: inline-flex; align-items: center; gap: 5px; font: 700 10.5px var(--cc-font-ui); letter-spacing: 0.7px; text-transform: uppercase;
  padding: 4px 8px; border-radius: 999px; background: rgba(244, 232, 193, 0.1); color: var(--cc-cream); white-space: nowrap; }
.ccj-chip svg { width: 13px; height: 13px; }
.ccj-chip i { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.ccj-chip--hard { background: rgba(47, 109, 179, 0.35); color: #d4e6ff; }
.ccj-chip--clay { background: rgba(200, 102, 60, 0.35); color: #ffd9c6; }
.ccj-chip--grass { background: rgba(76, 154, 82, 0.38); color: #d6f4cd; }
.ccj-chip--gold { background: rgba(217, 164, 65, 0.24); color: #ffe39a; }
.ccj-chip--club { background: rgba(63, 125, 85, 0.5); color: #dcf7e3; }
.ccj-chip--ok { background: rgba(76, 175, 106, 0.25); color: #c4f0d0; }
.ccj-chip--bad { background: rgba(224, 90, 71, 0.22); color: #ffcabf; }
.ccj-btn { min-height: 48px; font-size: 15px; width: 100%; }
.ccj-btn--gold { background: var(--cc-gold); border-color: var(--cc-gold); color: #2a1d08; }
.ccj-btn--gold:hover { background: #e8b75a; border-color: #e8b75a; }
.ccj-btn[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.ccj-btn[aria-disabled="true"]:active { transform: none; }
.ccj-linkbtn { min-height: 44px; padding: 0 12px; border: 0; border-radius: 10px; background: transparent; color: var(--cc-gold);
  font: 600 13.5px var(--cc-font-ui); cursor: pointer; }
.ccj-linkbtn:hover { background: rgba(217, 164, 65, 0.12); }
.ccj-linkbtn:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 1px; }

/* This week */
.ccj-week { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.ccj-week > .ccj-tonight { grid-column: 1 / -1; }
.ccj-stack { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.ccj-tonight { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px;
  background: linear-gradient(135deg, rgba(217, 164, 65, 0.3), rgba(217, 164, 65, 0.08));
  border: 1px solid rgba(217, 164, 65, 0.7); box-shadow: 0 0 22px rgba(217, 164, 65, 0.18); }
.ccj-tonight__ic { flex: none; width: 46px; height: 46px; display: grid; place-items: center; border-radius: 50%; background: rgba(0, 0, 0, 0.2); }
.ccj-tonight__ic svg { width: 32px; height: 32px; }
.ccj-tonight__tx { flex: 1; min-width: 0; }
.ccj-tonight__tx .cc-label { color: #ffe39a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-tonight__tx b { display: block; font-family: var(--cc-font-display); font-size: 19px; font-weight: 600; color: #fff4d2; line-height: 1.2; margin-top: 1px; }
.ccj-tonight__tx span { display: block; font-size: 12.5px; color: var(--cc-cream); margin-top: 2px; }
.ccj-tonight .ccj-btn { width: auto; flex: none; padding: 0 18px; }
.ccj-feat { padding: 0; overflow: hidden; }
.ccj-feat__band { position: relative; padding: 16px 16px 14px; background: linear-gradient(135deg, var(--ccj-s1, #3f7d55), var(--ccj-s2, #1f4a31)); overflow: hidden; }
.ccj-feat--hard { --ccj-s1: #2f6db3; --ccj-s2: #1b4373; }
.ccj-feat--clay { --ccj-s1: #c8663c; --ccj-s2: #86391b; }
.ccj-feat--grass { --ccj-s1: #4c9a52; --ccj-s2: #235a2c; }
.ccj-feat__court { position: absolute; right: -18px; top: 50%; width: 170px; height: 96px; transform: translateY(-50%) rotate(-9deg); opacity: 0.2; color: #fff; pointer-events: none; }
.ccj-feat__tier { position: relative; font: 700 11px var(--cc-font-ui); letter-spacing: 1.4px; text-transform: uppercase; color: rgba(255, 255, 255, 0.86); }
.ccj-feat__name { position: relative; margin: 5px 0 2px; font-family: var(--cc-font-display); font-weight: 600; font-size: 23px; line-height: 1.12; color: #fff; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); }
.ccj-feat__venue { position: relative; font-size: 13.5px; color: rgba(255, 255, 255, 0.9); }
.ccj-feat__chips { position: relative; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.ccj-feat__chips .ccj-chip { background: rgba(0, 0, 0, 0.24); color: #fff; }
.ccj-feat__in { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.ccj-status { display: flex; align-items: flex-start; gap: 9px; font-size: 14px; font-weight: 600; line-height: 1.35; }
.ccj-status i { width: 10px; height: 10px; border-radius: 50%; background: var(--cc-cream-dim); flex: none; margin-top: 4px; }
.ccj-status.is-open i { background: var(--cc-ok); box-shadow: 0 0 0 3px rgba(76, 175, 106, 0.25); }
.ccj-status.is-in i { background: var(--cc-gold); box-shadow: 0 0 0 3px rgba(217, 164, 65, 0.25); }
.ccj-status.is-out i { background: var(--cc-danger); }
.ccj-facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ccj-fact { background: rgba(0, 0, 0, 0.16); border-radius: 10px; padding: 8px 10px; min-width: 0; }
.ccj-fact b { display: block; font-family: var(--cc-font-display); font-size: 18px; font-weight: 600; color: var(--cc-cream); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.ccj-fact span { display: block; font-size: 10.5px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); margin-top: 2px; }
.ccj-fact s { color: var(--cc-cream-dim); font-size: 13px; margin-right: 4px; font-family: var(--cc-font-ui); }
.ccj-sched { display: flex; gap: 6px; }
.ccj-day { flex: 1 1 0; min-width: 0; text-align: center; padding: 7px 2px; border-radius: 10px; background: rgba(244, 232, 193, 0.06); border: 1px solid rgba(244, 232, 193, 0.1); }
.ccj-day b { display: block; font-size: 11px; letter-spacing: 0.7px; text-transform: uppercase; color: var(--cc-cream-dim); }
.ccj-day span { display: block; font-family: var(--cc-font-display); font-size: 16px; font-weight: 600; color: var(--cc-cream); margin-top: 1px; }
.ccj-day.is-today { border-color: var(--cc-gold); background: rgba(217, 164, 65, 0.16); }
.ccj-day.is-today b { color: #ffe39a; }
.ccj-day.is-past { opacity: 0.5; }
.ccj-act { display: flex; flex-direction: column; gap: 8px; }
.ccj-reason { font-size: 12.5px; color: #ffd0ad; text-align: center; line-height: 1.4; }
.ccj-confirm { padding: 12px; border-radius: 12px; background: rgba(224, 90, 71, 0.12); border: 1px solid rgba(224, 90, 71, 0.45); font-size: 13.5px; line-height: 1.4; display: flex; flex-direction: column; gap: 10px; }
.ccj-confirm__row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ccj-confirm__row .cc-btn { min-height: 44px; font-size: 14px; }
.ccj-next { font-size: 13px; color: var(--cc-cream); line-height: 1.4; padding: 9px 11px; border-radius: 10px; background: rgba(0, 0, 0, 0.16); }
.ccj-next b { color: #ffe39a; }

/* tables (prizes, points) */
.ccj-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.ccj-table th { text-align: left; font: 600 10.5px var(--cc-font-ui); letter-spacing: 0.9px; text-transform: uppercase; color: var(--cc-cream-dim); padding: 0 8px 7px; }
.ccj-table td { padding: 8px; border-top: 1px solid rgba(244, 232, 193, 0.08); font-variant-numeric: tabular-nums; }
.ccj-table .num { text-align: right; white-space: nowrap; }
.ccj-table tr.is-hi td { color: #ffe39a; font-weight: 600; }
.ccj-table tr.is-total td { border-top: 1px solid rgba(244, 232, 193, 0.22); font-weight: 700; }
.ccj-table td small { display: block; font-size: 11.5px; color: var(--cc-cream-dim); margin-top: 1px; }
.ccj-soon { display: flex; flex-direction: column; gap: 6px; }
.ccj-soon__i { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 11px; background: rgba(244, 232, 193, 0.05); border: 1px solid rgba(244, 232, 193, 0.08); }
.ccj-soon__w { flex: none; width: 46px; text-align: center; font-size: 10.5px; letter-spacing: 0.7px; text-transform: uppercase; color: var(--cc-cream-dim); }
.ccj-soon__w b { display: block; font-family: var(--cc-font-display); font-size: 18px; color: var(--cc-cream); letter-spacing: 0; }
.ccj-soon__t { flex: 1; min-width: 0; }
.ccj-soon__t b { display: block; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-soon__t span { display: block; font-size: 12px; color: var(--cc-cream-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Draw */
.ccj-drawbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin: 2px 0 10px; }
.ccj-drawbar__t { min-width: 0; flex: 1 1 200px; }
.ccj-drawbar__t .cc-label { color: var(--cc-gold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-drawbar__t b { display: block; font-family: var(--cc-font-display); font-size: 19px; font-weight: 600; line-height: 1.2; }
.ccj-rounds { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: rgba(0, 0, 0, 0.22); flex: none; }
.ccj-rbtn { min-width: 48px; min-height: 44px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--cc-cream-dim);
  font: 700 13.5px var(--cc-font-ui); cursor: pointer; -webkit-tap-highlight-color: transparent; }
.ccj-rbtn[aria-pressed="true"] { background: var(--cc-cream); color: var(--cc-green-900); }
.ccj-rbtn:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 1px; }
.ccj-rbtn.has-me::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 5px; border-radius: 50%; background: var(--cc-gold); vertical-align: 2px; }
.ccj-bracket { position: relative; display: flex; gap: 14px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 2px 2px 12px;
  overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scrollbar-width: thin; scrollbar-color: rgba(244, 232, 193, 0.25) transparent; }
.ccj-bracket:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 2px; border-radius: 10px; }
.ccj-col { flex: 1 0 200px; display: flex; flex-direction: column; scroll-snap-align: start; min-width: 0; }
.ccj-col__h { font: 700 11px var(--cc-font-ui); letter-spacing: 1.2px; text-transform: uppercase; color: var(--cc-gold); padding: 0 2px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-col.is-flash .ccj-col__h { animation: ccj-flash 0.8s ease; }
@keyframes ccj-flash { 30% { color: #fff4d2; text-shadow: 0 0 10px rgba(255, 227, 154, 0.9); } }
.ccj-col__list { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.ccj-fgroup { display: flex; flex-direction: column; gap: 8px; }
@media (min-width: 761px) {
  /* Wide screens: a classic bracket, each match centred between the two it comes from; the
     columns shrink to fit (a 16 draw needs no sideways scroll) and only a 32 draw scrolls */
  .ccj-col__list { justify-content: space-around; }
  .ccj-col { flex: 1 1 0; min-width: 180px; }
  .ccj-bracket { scroll-snap-type: x proximity; }
}
.ccj-m { border-radius: 11px; background: rgba(244, 232, 193, 0.06); border: 1px solid rgba(244, 232, 193, 0.12); overflow: hidden; }
.ccj-m.is-me { border-color: rgba(217, 164, 65, 0.85); box-shadow: 0 0 0 1px rgba(217, 164, 65, 0.3), 0 4px 14px rgba(0, 0, 0, 0.25); }
.ccj-p { display: grid; grid-template-columns: 20px minmax(0, 1fr) 16px; align-items: center; gap: 6px; min-height: 30px; padding: 3px 9px 3px 7px; font-size: 13.5px; color: var(--cc-cream); }
.ccj-p + .ccj-p { border-top: 1px solid rgba(244, 232, 193, 0.07); }
.ccj-p.is-win { font-weight: 700; }
.ccj-p.is-lose { color: var(--cc-cream-dim); }
.ccj-p.is-lose .ccj-p__n { text-decoration: line-through; text-decoration-color: rgba(196, 184, 150, 0.45); }
.ccj-p.is-me { background: rgba(217, 164, 65, 0.16); color: #fff4d2; }
.ccj-p__n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-p__n i { color: var(--cc-cream-dim); font-style: normal; opacity: 0.7; }
.ccj-seed { font-size: 10.5px; color: var(--cc-cream-dim); text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; }
.ccj-you { display: inline-block; margin-left: 6px; font: 800 9.5px var(--cc-font-ui); letter-spacing: 0.8px; text-transform: uppercase; padding: 2px 5px; border-radius: 5px; background: var(--cc-gold); color: #2a1d08; vertical-align: 1px; }
.ccj-club { display: inline-block; margin-left: 6px; width: 7px; height: 7px; border-radius: 50%; background: #6fcf8e; vertical-align: 1px; box-shadow: 0 0 0 2px rgba(111, 207, 142, 0.25); }
.ccj-p__w { color: var(--cc-gold); font-size: 13px; text-align: right; }
.ccj-m__f { display: flex; justify-content: space-between; gap: 8px; padding: 5px 9px; font-size: 11.5px; color: var(--cc-cream-dim); background: rgba(0, 0, 0, 0.16); font-variant-numeric: tabular-nums; }
.ccj-m__f b { color: var(--cc-cream); font-weight: 700; letter-spacing: 0.3px; }
.ccj-m__f .is-tonight { color: #ffe39a; font-weight: 700; }
.ccj-champ { display: flex; align-items: center; gap: 10px; margin-top: 6px; padding: 10px 12px; border-radius: 12px;
  background: radial-gradient(circle at 20% 30%, rgba(217, 164, 65, 0.26), rgba(217, 164, 65, 0.05) 70%); border: 1px solid rgba(217, 164, 65, 0.45); }
.ccj-champ svg { flex: none; width: 40px; height: 40px; }
.ccj-champ .cc-label { color: var(--cc-gold); }
.ccj-champ b { display: block; font-family: var(--cc-font-display); font-size: 16px; font-weight: 600; line-height: 1.2; }
.ccj-champ.is-me b { color: #ffe39a; }
.ccj-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 11.5px; color: var(--cc-cream-dim); margin-top: 4px; }
.ccj-legend span { display: inline-flex; align-items: center; gap: 6px; }
.ccj-legend .ccj-sw { width: 14px; height: 10px; border-radius: 3px; border: 1px solid rgba(217, 164, 65, 0.85); background: rgba(217, 164, 65, 0.16); }

/* Rankings */
.ccj-rkhead { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin: 2px 0 12px; }
.ccj-rkme { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 12px; background: rgba(217, 164, 65, 0.14); border: 1px solid rgba(217, 164, 65, 0.45);
  color: var(--cc-cream); font: inherit; text-align: left; min-height: 44px; }
button.ccj-rkme { cursor: pointer; -webkit-tap-highlight-color: transparent; }
button.ccj-rkme:hover { background: rgba(217, 164, 65, 0.22); }
button.ccj-rkme:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 2px; }
.ccj-rkme__go { font-size: 11.5px; color: #ffe39a; font-weight: 700; }
.ccj-rk tr.is-flash td { animation: ccj-rowflash 1.2s ease; }
@keyframes ccj-rowflash { 25% { background: rgba(255, 227, 154, 0.38); } }
.ccj-rkme__n { font-family: var(--cc-font-display); font-size: 28px; font-weight: 600; color: #ffe39a; line-height: 1; font-variant-numeric: tabular-nums; }
.ccj-rkme__t { font-size: 12.5px; color: var(--cc-cream); line-height: 1.35; }
.ccj-rkme__t b { font-size: 14px; }
.ccj-rkhead .ccj-note { flex: 1 1 200px; }
.ccj-rk { width: 100%; border-collapse: separate; border-spacing: 0 4px; font-size: 14px; }
.ccj-rk th { text-align: left; font: 600 10.5px var(--cc-font-ui); letter-spacing: 0.9px; text-transform: uppercase; color: var(--cc-cream-dim); padding: 0 10px 2px; }
.ccj-rk th:last-child { text-align: right; }
.ccj-rk td { padding: 8px 10px; background: rgba(244, 232, 193, 0.05); vertical-align: middle; }
.ccj-rk td:first-child { border-radius: 10px 0 0 10px; width: 46px; text-align: center; font-family: var(--cc-font-display); font-weight: 600; font-size: 16px; font-variant-numeric: tabular-nums; }
.ccj-rk td:last-child { border-radius: 0 10px 10px 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
.ccj-rk tr.is-top td:first-child { color: var(--cc-gold); }
.ccj-rk tr.is-me td { background: rgba(217, 164, 65, 0.2); }
.ccj-rk tr.is-me td:first-child { box-shadow: inset 3px 0 0 var(--cc-gold); }
.ccj-rk tr.is-club td:first-child { box-shadow: inset 3px 0 0 #6fcf8e; }
.ccj-rk tr.is-me.is-club td:first-child { box-shadow: inset 3px 0 0 var(--cc-gold); }
.ccj-who { min-width: 0; }
.ccj-who b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-who small { display: block; font-size: 11.5px; color: var(--cc-cream-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.ccj-rk tr.ccj-gap td { background: none; padding: 0; text-align: center; color: var(--cc-cream-dim); letter-spacing: 5px; font-size: 13px; line-height: 14px; }
.ccj-rk .ccj-who { max-width: 0; width: 100%; }

/* Calendar */
.ccj-cal { list-style: none; margin: 0; padding: 0; position: relative; }
.ccj-cal::before { content: ''; position: absolute; left: 17px; top: 18px; bottom: 18px; width: 2px; background: rgba(244, 232, 193, 0.12); }
.ccj-ci { position: relative; display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; align-items: center; padding: 5px 0; }
.ccj-ci__dot { justify-self: center; width: 14px; height: 14px; border-radius: 50%; background: var(--ccj-dot, #7d8a80); border: 2px solid rgba(20, 38, 28, 0.95); box-shadow: 0 0 0 1px rgba(244, 232, 193, 0.25); z-index: 1; }
.ccj-ci.is-current .ccj-ci__dot { width: 18px; height: 18px; box-shadow: 0 0 0 4px rgba(217, 164, 65, 0.4); }
.ccj-ci--hard { --ccj-dot: #4f8fd8; } .ccj-ci--clay { --ccj-dot: #d9764a; } .ccj-ci--grass { --ccj-dot: #62b567; }
.ccj-ci__card { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: rgba(244, 232, 193, 0.05); border: 1px solid rgba(244, 232, 193, 0.1); }
.ccj-ci.is-current .ccj-ci__card { border-color: rgba(217, 164, 65, 0.65); background: rgba(217, 164, 65, 0.1); }
.ccj-ci.is-past .ccj-ci__card { opacity: 0.62; }
.ccj-ci__main { flex: 1; min-width: 0; }
.ccj-ci__main .cc-label { font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-ci.is-current .cc-label { color: #ffe39a; }
.ccj-ci__main b { display: block; font-family: var(--cc-font-display); font-size: 16px; font-weight: 600; line-height: 1.2; margin-top: 1px; }
.ccj-ci__main span { display: block; font-size: 12.5px; color: var(--cc-cream-dim); margin-top: 2px; }
.ccj-ci__side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }

/* Profile */
.ccj-prof { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 18px; align-items: start; }
.ccj-mestats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ccj-mestat { text-align: center; padding: 10px 6px; border-radius: 12px; background: rgba(244, 232, 193, 0.06); border: 1px solid rgba(244, 232, 193, 0.1); min-width: 0; }
.ccj-mestat b { display: block; font-family: var(--cc-font-display); font-size: 22px; font-weight: 600; color: var(--cc-cream); line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ccj-mestat span { display: block; font-size: 10px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); margin-top: 3px; }
.ccj-mestat.is-gold b { color: #ffe39a; }
.ccj-career { margin-top: 8px; font-size: 12.5px; color: var(--cc-cream-dim); line-height: 1.45; }
.ccj-career b { color: var(--cc-cream); }
.ccj-trophies { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
.ccj-trophy { text-align: center; padding: 12px 8px 10px; border-radius: 12px; min-width: 0;
  background: radial-gradient(circle at 50% 28%, rgba(217, 164, 65, 0.26), rgba(217, 164, 65, 0.04) 70%); border: 1px solid rgba(217, 164, 65, 0.4); }
.ccj-trophy svg { width: 46px; height: 46px; }
.ccj-trophy b { display: block; font-family: var(--cc-font-display); font-size: 14px; font-weight: 600; line-height: 1.2; margin-top: 4px; }
.ccj-trophy small { display: block; font-size: 11.5px; color: var(--cc-cream-dim); margin-top: 3px; }
.ccj-hist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.ccj-hist li { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 7px 10px 7px 7px; border-radius: 10px; background: rgba(244, 232, 193, 0.05); }
.ccj-hist li > div { min-width: 0; }
.ccj-hist b { display: block; font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-hist small { display: block; font-size: 11.5px; color: var(--cc-cream-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ccj-hist .ccj-score { font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--cc-cream); white-space: nowrap; }
.ccj-wl { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; font-weight: 800; font-size: 12.5px; }
.ccj-wl.is-w { background: rgba(76, 175, 106, 0.28); color: #c4f0d0; }
.ccj-wl.is-l { background: rgba(224, 90, 71, 0.24); color: #ffcabf; }
.ccj-h2h { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px; }
.ccj-h2h div { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 9px 11px; border-radius: 10px; background: rgba(244, 232, 193, 0.05); font-size: 13.5px; min-width: 0; }
.ccj-h2h span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ccj-h2h b { font-variant-numeric: tabular-nums; flex: none; }
.ccj-h2h b.is-up { color: #a8e6b8; } .ccj-h2h b.is-down { color: #ffb4a8; }

/* Scouting */
.ccj-scout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.ccj-opp { display: flex; gap: 14px; align-items: center; }
.ccj-avatar { flex: none; width: 66px; height: 66px; border-radius: 50%; display: grid; place-items: center; font-family: var(--cc-font-display); font-size: 25px; font-weight: 600;
  color: #fff; background: var(--ccj-av, #3f7d55); border: 2px solid rgba(244, 232, 193, 0.4); box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3); }
.ccj-opp__t { min-width: 0; flex: 1; }
.ccj-opp__t .cc-label { color: var(--cc-gold); }
.ccj-opp__t b { display: block; font-family: var(--cc-font-display); font-size: 22px; font-weight: 600; line-height: 1.15; margin-top: 2px; }
.ccj-opp__t span { display: block; font-size: 13px; color: var(--cc-cream-dim); margin-top: 3px; }
.ccj-opp__chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.ccj-stars { display: inline-flex; gap: 2px; color: #ffd36b; align-items: center; }
.ccj-stars svg { width: 17px; height: 17px; }
.ccj-stars em { font-style: normal; font-size: 12px; color: var(--cc-cream-dim); margin-left: 5px; }
.ccj-nextline { margin-top: 12px; font-size: 13px; color: var(--cc-cream); padding: 9px 11px; border-radius: 10px; background: rgba(0, 0, 0, 0.16); line-height: 1.4; }
.ccj-list { list-style: none; margin: 0; padding: 0; }
.ccj-list li { position: relative; padding: 6px 0 6px 28px; font-size: 13.5px; line-height: 1.4; }
.ccj-list li::before { position: absolute; left: 0; top: 6px; width: 19px; height: 19px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 800; }
.ccj-list--good li::before { content: '+'; background: rgba(76, 175, 106, 0.3); color: #c4f0d0; }
.ccj-list--bad li::before { content: '−'; background: rgba(224, 90, 71, 0.28); color: #ffcabf; }
.ccj-plan { position: relative; padding: 14px 14px 12px 16px; border-radius: 14px; background: rgba(47, 109, 179, 0.14); border: 1px solid rgba(47, 109, 179, 0.42); }
.ccj-plan__h { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.ccj-plan__h svg { width: 20px; height: 20px; color: #bcd6f7; }
.ccj-plan__h b { font-family: var(--cc-font-display); font-size: 16px; font-weight: 600; }
.ccj-plan ol { margin: 0; padding-left: 20px; }
.ccj-plan li { font-size: 13.5px; line-height: 1.45; padding: 3px 0; color: var(--cc-cream); }
.ccj-plan li::marker { color: #bcd6f7; font-weight: 700; }

/* Locked */
.ccj-locked { max-width: 520px; margin: 18px auto 0; text-align: center; }
.ccj-locked svg.ccj-lock-art { width: 110px; height: 110px; opacity: 0.9; }
.ccj-locked h3 { font-family: var(--cc-font-display); font-weight: 600; font-size: 22px; margin: 8px 0 6px; }
.ccj-locked p { font-size: 14px; line-height: 1.55; color: var(--cc-cream); opacity: 0.9; margin: 0 0 10px; }
.ccj-pips { display: flex; justify-content: center; gap: 8px; margin: 12px 0 6px; }
.ccj-pips i { width: 28px; height: 28px; border-radius: 50%; border: 2px solid rgba(217, 164, 65, 0.6); display: grid; place-items: center; font-style: normal; font-size: 13px; color: #2a1d08; }
.ccj-pips i.is-on { background: var(--cc-gold); }

/* Story cards */
.ccj-modal {
  z-index: 880;
  padding: calc(var(--cc-safe-top) + 16px) calc(var(--cc-safe-right) + 16px) calc(var(--cc-safe-bottom) + 16px) calc(var(--cc-safe-left) + 16px);
  background: radial-gradient(ellipse at 50% 40%, rgba(46, 36, 14, 0.5), rgba(8, 14, 10, 0.84) 75%);
  backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
}
.ccj-mcard {
  position: relative; width: min(480px, 100%); max-height: 100%; overflow-y: auto; overscroll-behavior: contain;
  padding: 22px 20px 18px; display: flex; flex-direction: column; gap: 14px;
  background: linear-gradient(180deg, rgba(62, 50, 24, 0.97), rgba(26, 42, 30, 0.98) 55%, rgba(18, 34, 24, 0.98));
  border-radius: 20px; transform: translateY(14px) scale(0.97); transition: transform 0.28s cubic-bezier(.2,.9,.3,1.15);
}
.ccj-modal.is-open .ccj-mcard { transform: none; }
.ccj-mhead { text-align: center; }
.ccj-mhead .cc-label { color: var(--cc-gold); letter-spacing: 2.2px; }
.ccj-mtitle { margin: 5px 0 0; font-size: 27px; line-height: 1.12; }
.ccj-msub { font-size: 13px; color: var(--cc-cream-dim); margin-top: 4px; }
.ccj-quote { position: relative; font-family: var(--cc-font-display); font-size: 16.5px; line-height: 1.5; color: #fff4d2; padding: 2px 4px 0 30px; }
.ccj-quote::before { content: '“'; position: absolute; left: 0; top: -12px; font-size: 54px; line-height: 1; color: var(--cc-gold); opacity: 0.75; }
.ccj-quote p { margin: 0 0 10px; }
.ccj-quote p:last-child { margin-bottom: 0; }
.ccj-sign { text-align: right; font-size: 13px; color: var(--cc-cream-dim); margin-top: -6px; }
.ccj-perks { list-style: none; margin: 0; padding: 10px 12px; border-radius: 12px; background: rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; gap: 7px; }
.ccj-perks li { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; line-height: 1.4; }
.ccj-perks svg { flex: none; width: 18px; height: 18px; color: var(--cc-gold); margin-top: 1px; }
.ccj-mbtns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ccj-mbtns .cc-btn { min-height: 52px; font-size: 15.5px; }
.ccj-mbtns--one { grid-template-columns: 1fr; }
.ccj-mnote { text-align: center; font-size: 12px; color: var(--cc-cream-dim); margin-top: -4px; }
.ccj-body-txt { font-size: 14.5px; line-height: 1.55; color: var(--cc-cream); }
.ccj-body-txt p { margin: 0 0 10px; }
.ccj-body-txt p:last-child { margin-bottom: 0; }
.ccj-choices { display: flex; flex-direction: column; gap: 8px; }
.ccj-choices .cc-btn { width: 100%; min-height: 58px; padding: 10px 14px; text-align: left; display: flex; flex-direction: column; justify-content: center; gap: 3px; }
.ccj-choices .cc-btn b { font-size: 15.5px; }
.ccj-choices .cc-btn span { font-size: 12.5px; font-weight: 500; color: var(--cc-cream-dim); line-height: 1.35; }
.ccj-choices .cc-btn.ccj-btn--gold span { color: rgba(42, 29, 8, 0.78); }
.ccj-res { text-align: center; align-items: stretch; }
.ccj-res__art { position: relative; height: 112px; display: grid; place-items: center; }
.ccj-res__art svg { width: 104px; height: 104px; filter: drop-shadow(0 8px 20px rgba(217, 164, 65, 0.45)); position: relative; }
.ccj-res__art .ccj-ball { width: 78px; height: 78px; filter: drop-shadow(0 6px 12px rgba(0, 0, 0, 0.35)); }
.ccj-res__glow { position: absolute; inset: -10px 22%; border-radius: 50%; background: radial-gradient(circle, rgba(255, 227, 154, 0.5), rgba(255, 227, 154, 0) 65%); }
.ccj-res.is-champ .ccj-mtitle { color: #ffe39a; font-size: 32px; }
.ccj-res.is-lost .ccj-mtitle { color: var(--cc-cream); }
.ccj-res__score { font-family: var(--cc-font-display); font-size: 30px; font-weight: 600; letter-spacing: 1px; color: #fff4d2; font-variant-numeric: tabular-nums; }
.ccj-res__opp { font-size: 13.5px; color: var(--cc-cream-dim); margin-top: -8px; }
.ccj-res__chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.ccj-res__chip { min-width: 88px; padding: 8px 12px; border-radius: 12px; background: rgba(244, 232, 193, 0.08); border: 1px solid rgba(244, 232, 193, 0.14);
  font-size: 10.5px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); }
.ccj-res__chip b { display: block; font-family: var(--cc-font-display); font-size: 21px; letter-spacing: 0; text-transform: none; color: #ffe39a; font-variant-numeric: tabular-nums; }
.ccj-res__chip b small { font-family: var(--cc-font-ui); font-size: 12px; margin-left: 4px; font-weight: 700; }
.ccj-res__chip b small.is-up { color: #a8e6b8; } .ccj-res__chip b small.is-down { color: #ffb4a8; }
.ccj-res__next { font-size: 13.5px; color: var(--cc-cream); padding: 10px 12px; border-radius: 12px; background: rgba(0, 0, 0, 0.18); line-height: 1.4; }
.ccj-spark { position: absolute; width: 8px; height: 8px; border-radius: 2px; background: #ffe39a; opacity: 0; animation: ccj-spark 2.6s ease-in-out infinite; }
@keyframes ccj-spark { 0% { opacity: 0; transform: translateY(8px) rotate(0deg) scale(0.4); } 25% { opacity: 1; } 70% { opacity: 0.9; } 100% { opacity: 0; transform: translateY(-34px) rotate(160deg) scale(1); } }

@media (max-width: 760px) {
  .ccj-week, .ccj-prof, .ccj-scout { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .ccj-col { flex: 0 0 min(250px, 78vw); }
}
@media (max-width: 560px) {
  .ccj-overlay { padding: calc(var(--cc-safe-top) + 6px) calc(var(--cc-safe-right) + 6px) calc(var(--cc-safe-bottom) + 6px) calc(var(--cc-safe-left) + 6px); }
  .ccj-panel { height: 100%; border-radius: 16px; }
  .ccj-head { padding: 12px 10px 4px 14px; gap: 8px; }
  .ccj-crest { display: none; }
  .ccj-head__label { letter-spacing: 1.1px; }
  .ccj-head__title { font-size: 22px; }
  /* the week / weekday half of the sub-line gets its own line */
  .ccj-head__sub span { display: block; overflow: hidden; text-overflow: ellipsis; }
  .ccj-head__sub span + span::before { content: none; }
  .ccj-sec__aside--long { display: none; }
  .ccj-wallet { padding-right: 10px; }
  .ccj-wallet b { font-size: 17px; }
  .ccj-wallet__coin { width: 26px; height: 26px; font-size: 13px; }
  .ccj-tabs { padding: 4px 10px 8px; }
  .ccj-tab { padding: 0 13px; font-size: 13.5px; }
  .ccj-body { padding: 2px 10px 12px; }
  .ccj-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ccj-mestats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ccj-tonight { flex-wrap: wrap; }
  .ccj-tonight .ccj-btn { width: 100%; }
  .ccj-feat__name { font-size: 21px; }
  .ccj-mcard { padding: 18px 14px 14px; gap: 12px; }
  .ccj-mtitle { font-size: 24px; }
  .ccj-quote { font-size: 15.5px; }
}
@media (max-width: 380px) {
  .ccj-day b { font-size: 10px; letter-spacing: 0.3px; }
  .ccj-day span { font-size: 14px; }
  .ccj-rk td { padding: 7px 8px; }
  .ccj-rk td:first-child { width: 38px; }
}
@media (max-height: 520px) {
  /* Landscape phones: every pixel of height goes to the content */
  .ccj-overlay { padding: calc(var(--cc-safe-top) + 6px) calc(var(--cc-safe-right) + 10px) calc(var(--cc-safe-bottom) + 6px) calc(var(--cc-safe-left) + 10px); }
  .ccj-panel { height: 100%; border-radius: 16px; }
  .ccj-head { padding: 6px 10px 0 16px; }
  .ccj-crest, .ccj-head__label { display: none; }
  .ccj-head__title { font-size: 20px; margin-top: 0; }
  .ccj-head__sub { margin-top: 1px; font-size: 12px; }
  .ccj-head__sub span { display: inline; }
  .ccj-head__sub span + span::before { content: ' · '; }
  .ccj-tabs { padding: 4px 12px 6px; }
  .ccj-foot { min-height: 28px; padding-bottom: 4px; }
  .ccj-foot:empty { min-height: 8px; }
  .ccj-tonight { padding: 8px 12px; }
  .ccj-tonight__ic { display: none; }
  .ccj-drawbar { margin-bottom: 6px; }
  .ccj-mcard { padding: 14px 16px 12px; gap: 10px; }
  .ccj-res__art { height: 76px; }
  .ccj-res__art svg { width: 72px; height: 72px; }
  .ccj-res__art .ccj-ball { width: 56px; height: 56px; }
}
@media (prefers-reduced-motion: reduce) {
  .ccj-overlay, .ccj-modal, .ccj-panel, .ccj-mcard { transition: none; }
  .ccj-spark, .ccj-col.is-flash .ccj-col__h { animation: none; }
  .ccj-spark { display: none; }
}
`;

// ───────────────────────────── icons (24×24, currentColor) ─────────────────────────────

const ic = (inner, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
const ICON = {
  week: ic('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M12 12.6l1.1 2.2 2.4.3-1.8 1.6.5 2.3-2.2-1.2-2.2 1.2.5-2.3-1.8-1.6 2.4-.3z" stroke-width="1.4"/>'),
  draw: ic('<path d="M3.5 4h5v6.5h-5M3.5 13.5h5V20h-5M8.5 7.2h5v9.6h-5M13.5 12H20"/>'),
  rankings: ic('<path d="M3 20.5h18M5 20.5v-6h4.5v6M9.5 20.5V8.5h5v12M14.5 20.5v-9H19v9"/><path d="M12 3.5l.7 1.4 1.5.2-1.1 1 .3 1.5L12 6.9l-1.4.7.3-1.5-1.1-1 1.5-.2z" stroke-width="1.2"/>'),
  calendar: ic('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M7.5 13.5h2M11 13.5h2M14.5 13.5h2M7.5 17h2M11 17h2"/>'),
  profile: ic('<circle cx="12" cy="8.3" r="3.9"/><path d="M4.5 20.5c.9-4.2 3.9-6.3 7.5-6.3s6.6 2.1 7.5 6.3"/>'),
  scouting: ic('<circle cx="6.8" cy="15.2" r="3.7"/><circle cx="17.2" cy="15.2" r="3.7"/><path d="M10.5 15.2h3M4.6 12.1L7 5.5h2.6l.7 6.3M19.4 12.1L17 5.5h-2.6l-.7 6.3"/>'),
  close: ic('<path d="M6 6l12 12M18 6L6 18" stroke-width="2.4"/>'),
  trophy: ic('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 5.5H5c0 2.8 1.4 4.3 3.3 4.5M16 5.5h3c0 2.8-1.4 4.3-3.3 4.5M12 13v3.5M8.5 20.5h7M9.7 16.5h4.6l.6 4H9.1z"/>'),
  clipboard: ic('<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 13.5h7M8.5 17h4"/>'),
  wind: ic('<path d="M3 8.5h10.5a2.8 2.8 0 1 0-2.8-2.8M3 12.5h15a2.8 2.8 0 1 1-2.8 2.8M3 16.5h7"/>'),
  ball: ic('<circle cx="12" cy="12" r="8.5"/><path d="M5.8 6.2c2.9 2.6 2.9 9 0 11.6M18.2 6.2c-2.9 2.6-2.9 9 0 11.6"/>'),
  people: ic('<circle cx="8.5" cy="9" r="3"/><circle cx="16.5" cy="9.5" r="2.5"/><path d="M3.5 19c.6-3.2 2.6-4.8 5-4.8s4.4 1.6 5 4.8M14 14.6c2.8-.4 5 1 5.6 4.4"/>'),
  map: ic('<path d="M9 4.5L3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5z"/><path d="M9 4.5v13M15 6.5v13"/>'),
  lock: ic('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
};
const STAR_PATH = 'M12 2.8l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 16.8l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z';

/** The gold trophy (the gradient lives in one hidden <defs> in #ui-root, shared by every copy). */
const trophyArt = (cls = '') => `<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true">
  <path d="M19 8h26v13c0 9.5-5.8 15.5-13 15.5S19 30.5 19 21z" fill="url(#ccj-gold)"/>
  <path d="M19.5 12.5H12c0 8 4.2 12.3 9.4 12.8M44.5 12.5H52c0 8-4.2 12.3-9.4 12.8" fill="none" stroke="url(#ccj-gold)" stroke-width="3.4" stroke-linecap="round"/>
  <path d="M28.6 36h6.8l1.8 8.5H26.8z" fill="url(#ccj-gold)"/>
  <rect x="21" y="44.5" width="22" height="11.5" rx="2.2" fill="#5a3a22"/>
  <rect x="26.5" y="48.2" width="11" height="4" rx="1.2" fill="#e8c46a"/>
  <path d="M24.5 13c0 6.5 1.4 11 4.2 14" fill="none" stroke="#fff7dc" stroke-width="2.2" stroke-linecap="round" opacity="0.65"/>
</svg>`;
const ballArt = `<svg class="ccj-ball" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" fill="#d8e04e"/><circle cx="32" cy="32" r="27" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="2"/>
  <path d="M13 13c9 7 9 31 0 38M51 13c-9 7-9 31 0 38" fill="none" stroke="#fdfbe8" stroke-width="3.2" stroke-linecap="round"/></svg>`;
const courtArt = `<svg class="ccj-feat__court" viewBox="0 0 120 60" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8">
  <rect x="4" y="4" width="112" height="52"/><path d="M4 10.5h112M4 49.5h112M60 2v56M30 10.5v39M90 10.5v39M30 30h60"/></g></svg>`;

// ───────────────────────────── data helpers ─────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const num = (n) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Math.round(Number(n)).toLocaleString('en-US') : '—');
const money = (n) => '$' + (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : '0');
const arr = (a) => (Array.isArray(a) ? a : []);

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WD_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** Day 1 is a Monday (EventSystem / TourSystem convention). */
const weekdayOf = (day) => (isNum(day) ? (((Math.floor(day) - 1) % 7) + 7) % 7 : -1);
const SURFACE_LABEL = { hard: 'Hard court', clay: 'Red clay', grass: 'Grass' };
const TIER_LABEL = { local: 'Local', regional: 'Regional', national: 'National', pro: 'Pro Circuit', home: 'Home event' };
const ROUND_LONG = { F: 'Final', SF: 'Semi-final', QF: 'Quarter-final', R16: 'Round of 16', R32: 'Round of 32', R64: 'Round of 64', R128: 'Round of 128' };
const REACHED = { W: 'Champion', F: 'Finalist', SF: 'Semi-finalist', QF: 'Quarter-finalist', R16: 'Round of 16', R32: 'Round of 32', R64: 'Round of 64' };
const PRIZE_ROWS = ['W', 'F', 'SF', 'QF', 'R16', 'R32', 'R64'];
const FORMAT_LABEL = { short: 'Short set', set: 'One set', bo3: 'Best of 3 sets' };
const WIND_LABEL = { breeze: 'Breezy', gusty: 'Gusty' };
const STATUS_ORDER = ['open', 'closed', 'entered', 'inProgress', 'done'];
const VENUE_SHORT = {
  cedar_park: 'Cedar Park', maple_hollow: 'Maple Hollow', harbor_point: 'Harbor Point', ashford_lawn: 'Ashford Lawn',
  sunridge_academy: 'Sunridge', metro_center: 'Metro Center', greenbriar: 'Greenbriar', home: 'Greenbriar',
};
const TAB_LIST = [
  { id: 'week', label: 'This week', icon: ICON.week },
  { id: 'draw', label: 'Draw', icon: ICON.draw },
  { id: 'rankings', label: 'Rankings', icon: ICON.rankings },
  { id: 'calendar', label: 'Calendar', icon: ICON.calendar },
  { id: 'profile', label: 'Profile', icon: ICON.profile },
  { id: 'scouting', label: 'Scouting', icon: ICON.scouting },
];
const TAB_IDS = TAB_LIST.map(t => t.id);

const prettyId = (id) => String(id || '').split(/[_\-\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
/** A round's short key ('R16', 'QF', 'SF', 'F') from the draw size and the round index. */
const roundKeyFor = (size, r) => {
  const n = Math.round((size || 2) / Math.pow(2, r));
  return n <= 2 ? 'F' : n === 4 ? 'SF' : n === 8 ? 'QF' : 'R' + n;
};
const roundLong = (k) => ROUND_LONG[k] || (k ? String(k) : 'Match');
/** An opponent / player name from a string or { short, name } object. */
const nameOf = (o, fallback = 'TBD') => (typeof o === 'string' ? o : o && (o.short || o.name)) || fallback;
const fullNameOf = (o, fallback = 'TBD') => (typeof o === 'string' ? o : o && (o.name || o.short)) || fallback;
const initials = (name) => String(name || '?').replace(/[^A-Za-zÀ-ÿ .'-]/g, '').split(/[\s.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
/** A stable avatar colour from an id. */
function avatarColor(id) {
  let h = 0;
  for (const ch of String(id || 'x')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}, 42%, 36%)`;
}
/**
 * 1–5 stars (halves) from a rating. Ratings are Elo-like (a strong club junior ≈ 1650, the pro
 * adults ≈ 2000+): 1200 → 1 star, 2100 → 5. Small numbers are taken as a 0–5 / 0–100 scale.
 */
export function ratingStars(rating) {
  const r = Number(rating);
  if (!Number.isFinite(r)) return 0;
  const s = r <= 5 ? r : r <= 100 ? r / 20 : 1 + (r - 1200) / 225;
  return Math.max(0.5, Math.min(5, Math.round(s * 2) / 2));
}
function starsHtml(rating) {
  const s = ratingStars(rating);
  if (!s) return '';
  let out = '';
  for (let i = 1; i <= 5; i++) {
    const fill = s >= i ? 'currentColor' : s >= i - 0.5 ? 'url(#ccj-half)' : 'none';
    out += `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="${fill}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }
  return `<span class="ccj-stars" role="img" aria-label="Rating ${s} out of 5">${out}</span>`;
}
function venueShortOf(spec) {
  if (!spec) return '';
  if (spec.venueShort) return spec.venueShort;
  if (spec.venueId && VENUE_SHORT[spec.venueId]) return VENUE_SHORT[spec.venueId];
  if (spec.venueName) return String(spec.venueName).replace(/\s+(Tennis Center|Tennis Centre|Racquet Club|Lawn Tennis Club|Tennis Club|Public Courts|Tennis Academy)$/i, '');
  return spec.venueId ? prettyId(spec.venueId) : (spec.courtLabel || '');
}

/**
 * Text for tonight's tournament match (report card button, hub banner):
 * { line: 'QF vs S. Marquez — Harbor Point', sub, aria, round, roundLong, opponent, venue, final }.
 */
export function describeTourMatch(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const round = spec.roundLabel || spec.round || '';
  const opp = nameOf(spec.opponent, 'TBD');
  const venue = venueShortOf(spec);
  const final = !!spec.final || round === 'F';
  const line = `${round ? round + ' ' : ''}vs ${opp}${venue ? ' — ' + venue : ''}`;
  const bits = [spec.tournamentName, SURFACE_LABEL[spec.surface], FORMAT_LABEL[spec.format]].filter(Boolean);
  const long = round ? roundLong(round).toLowerCase() : 'match';
  return {
    line, sub: bits.join(' · '), round, roundLong: roundLong(round), opponent: opp, venue, final,
    aria: `Play tonight's tournament ${long} against ${fullNameOf(spec.opponent, opp)}${venue ? ' at ' + venue : ''}`,
  };
}

/** Rankings rows to show: the top 20, a window round the player, every club junior; null = a gap. */
function pickRankRows(list, top = 20, around = 3) {
  const sorted = list.filter(r => r && typeof r === 'object').slice()
    .sort((a, b) => (isNum(a.rank) ? a.rank : 1e9) - (isNum(b.rank) ? b.rank : 1e9));
  const keep = new Set();
  for (let i = 0; i < sorted.length && i < top; i++) keep.add(i);
  const me = sorted.findIndex(r => r.isMe);
  if (me >= 0) for (let j = Math.max(0, me - around); j <= Math.min(sorted.length - 1, me + around); j++) keep.add(j);
  sorted.forEach((r, i) => { if (r.isClub) keep.add(i); });
  const rows = [];
  let prev = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (!keep.has(i)) continue;
    if (prev >= 0 && i > prev + 1) rows.push(null);
    else if (prev < 0 && i > 0) rows.push(null);
    rows.push(sorted[i]);
    prev = i;
  }
  if (prev >= 0 && prev < sorted.length - 1) rows.push(null);
  return rows;
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.id = 'cc-tour-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ───────────────────────────── the UI ─────────────────────────────

export class TourUI {
  constructor(opts = {}) {
    this.opts = opts || {};
    this.isOpen = false;
    this.tab = 'week';
    this.hub = null;
    this._holds = 0;           // open overlays (hub + story card): onOpen at 0 → 1, onClose at 1 → 0
    this._changed = false;     // an entry / withdrawal went through while open (onClose tells Game to save)
    this._modal = null;        // the story card on screen: { kind, cancel(), lastFocus }
    this._queue = [];          // story cards waiting for the current one
    this._statusTimer = null;
    this._confirmWithdraw = false;
    injectTheme();
    injectCSS();
    this.root = document.getElementById('ui-root') || document.body;
    this._buildDefs();
    this._buildHub();
    this._buildModal();
    // Esc / P belong to the tour overlays while one is up (capture phase: the game's pause toggle,
    // a bubble listener on window, never sees them)
    this._onWinKey = (e) => this._globalKey(e);
    window.addEventListener('keydown', this._onWinKey, true);
  }

  get isModalOpen() { return !!this._modal; }
  /** Any tour overlay (hub or story card) on screen. */
  get isBusy() { return this.isOpen || !!this._modal; }

  // ───────────────────────────── build ─────────────────────────────

  _buildDefs() {
    const d = el('div', 'ccj-defs');
    d.setAttribute('aria-hidden', 'true');
    d.innerHTML = `<svg width="0" height="0" focusable="false"><defs>
      <linearGradient id="ccj-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe7a3"/><stop offset="0.5" stop-color="#d9a441"/><stop offset="1" stop-color="#9c6d1f"/></linearGradient>
      <linearGradient id="ccj-half" x1="0" y1="0" x2="1" y2="0"><stop offset="0.5" stop-color="#ffd36b"/><stop offset="0.5" stop-color="#ffd36b" stop-opacity="0"/></linearGradient>
    </defs></svg>`;
    this.root.appendChild(d);
    this.defsEl = d;
  }

  _buildHub() {
    const ov = el('div', 'ccj-overlay');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-hidden', 'true');
    ov.setAttribute('aria-labelledby', 'ccj-title');
    this._shield(ov);
    ov.addEventListener('keydown', (e) => this._hubKey(e));

    const panel = el('div', 'ccj-panel cc-panel');
    const head = el('div', 'ccj-head');
    head.innerHTML = `
      <div class="ccj-crest" aria-hidden="true">${trophyArt()}</div>
      <div class="ccj-head__text">
        <div class="cc-label ccj-head__label" data-ref="label">Junior Tennis Tour</div>
        <h2 class="cc-title ccj-head__title" id="ccj-title" data-ref="title">The Junior Tour</h2>
        <div class="ccj-head__sub" data-ref="sub"></div>
      </div>
      <div class="ccj-wallet" data-ref="wallet" role="img" aria-label="Wallet"><span class="ccj-wallet__coin" aria-hidden="true">$</span><b data-ref="walletAmt">0</b></div>`;
    const close = el('button', 'cc-btn ccj-close', ICON.close);
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the tour hub');
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => this.close());
    head.appendChild(close);
    this.closeBtn = close;
    const ref = (n) => head.querySelector(`[data-ref="${n}"]`);
    this.labelEl = ref('label');
    this.titleEl = ref('title');
    this.subEl = ref('sub');
    this.walletEl = ref('wallet');
    this.walletAmtEl = ref('walletAmt');

    const tabs = el('div', 'ccj-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Tour sections');
    this.tabBtns = [];
    for (const t of TAB_LIST) {
      const b = el('button', 'ccj-tab', `${t.icon}<span>${t.label}</span><i class="ccj-tab__dot" hidden></i>`);
      b.type = 'button';
      b.id = `ccj-tab-${t.id}`;
      b.dataset.tab = t.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'ccj-body');
      b.addEventListener('click', () => this.showTab(t.id, true));
      tabs.appendChild(b);
      this.tabBtns.push(b);
    }
    this.tabsEl = tabs;

    const body = el('div', 'ccj-body');
    body.id = 'ccj-body';
    body.setAttribute('role', 'tabpanel');
    body.tabIndex = -1;
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !body.contains(b)) return;
      e.preventDefault();
      if (b.getAttribute('aria-disabled') === 'true' && b.dataset.act !== 'why') return;
      this._act(b.dataset.act, b);
    });
    this.bodyEl = body;

    const foot = el('div', 'ccj-foot');
    foot.setAttribute('role', 'status');
    foot.setAttribute('aria-live', 'polite');
    this.footEl = foot;

    panel.append(head, tabs, body, foot);
    ov.appendChild(panel);
    this.root.appendChild(ov);
    this.overlay = ov;
    this.panel = panel;
  }

  _buildModal() {
    const m = el('div', 'ccj-modal');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-hidden', 'true');
    m.setAttribute('aria-labelledby', 'ccj-mtitle');
    this._shield(m);
    m.addEventListener('keydown', (e) => { if (e.key === 'Tab') this._trap(e, this.mcard); });
    const card = el('div', 'ccj-mcard cc-panel');
    m.appendChild(card);
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mact]');
      if (!b || !card.contains(b) || !this._modal) return;
      e.preventDefault();
      const f = this._modal.actions && this._modal.actions[b.dataset.mact];
      if (f) f();
    });
    this.root.appendChild(m);
    this.modalEl = m;
    this.mcard = card;
  }

  /** Keep every pointer / wheel event on the overlay (the canvas and camera drag never see them). */
  _shield(node) {
    for (const ev of ['touchstart', 'touchmove', 'mousedown', 'pointerdown', 'wheel', 'click', 'contextmenu']) {
      node.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
  }

  // ───────────────────────────── hub: open / close ─────────────────────────────

  /** Open the hub (or switch tab / refresh if it is already open). */
  open(o = {}) {
    const wasOpen = this.isOpen;
    this._loadHub();
    if (o && TAB_IDS.includes(o.tab)) this.tab = o.tab;
    else if (!wasOpen) this.tab = 'week';
    this._confirmWithdraw = false;
    if (!wasOpen) {
      this.isOpen = true;
      this._changed = false;
      this._lastFocus = document.activeElement;
      this.overlay.classList.add('is-open');
      this.overlay.setAttribute('aria-hidden', this._modal ? 'true' : 'false');
      this._hold('hub');
    }
    this._render();
    this._setStatus('');
    if (!this._modal) requestAnimationFrame(() => { if (this.isOpen && !this._modal) this._focusTab(); });
    return true;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this._confirmWithdraw = false;
    this.overlay.classList.remove('is-open');
    this.overlay.setAttribute('aria-hidden', 'true');
    clearTimeout(this._statusTimer);
    this._restoreFocus(this.overlay, this._lastFocus);
    this._lastFocus = null;
    this._release('hub');
  }

  /** Re-read the hub data and redraw the current tab (e.g. after the tour changed underneath). */
  refresh() {
    if (!this.isOpen) return;
    this._loadHub();
    this._render(true);
  }

  showTab(id, fromUser = false) {
    if (!TAB_IDS.includes(id)) return;
    const changed = id !== this.tab;
    this.tab = id;
    this._confirmWithdraw = false;
    if (this.isOpen) this._render();
    if (fromUser && changed) this._call('onFeedback', 'tab');
  }

  _loadHub() {
    let h = null;
    this._hubError = null;
    try { h = typeof this.opts.getHub === 'function' ? this.opts.getHub() : null; } catch (err) {
      console.warn('TourUI getHub:', err);
      this._hubError = (err && err.message) || String(err);
    }
    this.hub = h && typeof h === 'object' ? h : null;
  }

  _hold(kind) {
    if (this._holds++ === 0) this._call('onOpen', kind);
  }

  _release(kind) {
    if (this._holds <= 0) return;
    if (--this._holds === 0) {
      const changed = this._changed;
      this._changed = false;
      this._call('onClose', { kind, changed });
    }
  }

  _call(name, ...args) {
    const f = this.opts[name];
    if (typeof f !== 'function') return undefined;
    try { return f(...args); } catch (err) { console.warn(`TourUI ${name}:`, err); return undefined; }
  }

  // ───────────────────────────── hub: render ─────────────────────────────

  _render(keepScroll = false) {
    const h = this.hub;
    const locked = !h || !h.accepted;
    this._renderHead(h, locked);
    this.tabsEl.hidden = locked;
    const tonight = !locked && !!h.tonight;
    for (const b of this.tabBtns) {
      const on = b.dataset.tab === this.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      const dot = b.querySelector('.ccj-tab__dot');
      const t = b.dataset.tab;
      const show = !locked && ((t === 'draw' && tonight) || (t === 'scouting' && !!(h.scouting && h.scouting.opponent)));
      if (dot) dot.hidden = !show;
    }
    const keep = keepScroll ? this.bodyEl.scrollTop : 0;
    let html;
    try {
      html = locked ? this._htmlLocked(h) : this[`_html_${this.tab}`](h);
    } catch (err) {
      console.warn('TourUI render:', err);
      html = this._emptyHtml(ICON.clipboard, 'Something went wrong', 'The tour data could not be read. Close the hub and try again.');
    }
    this.bodyEl.innerHTML = html;
    this.bodyEl.setAttribute('aria-labelledby', locked ? 'ccj-title' : `ccj-tab-${this.tab}`);
    this.bodyEl.scrollTop = keep;
    if (!locked && this.tab === 'draw') this._wireBracket();
  }

  _renderHead(h, locked) {
    const me = (h && h.me) || {};
    const career = h && h.careerTitle ? String(h.careerTitle) : '';
    this.labelEl.textContent = career && !locked ? `Junior Tour · ${career}` : 'Junior Tennis Tour';
    this.titleEl.textContent = locked ? 'The Junior Tour' : isNum(me.rank) ? `Ranked #${me.rank}` : 'Unranked';
    // Two halves (standing · calendar): one line on wide screens, two on phones
    const a = [], b = [];
    if (!locked) {
      const rec = me.record || {};
      a.push(`${num(me.points || 0)} pts`, `${rec.w || 0}–${rec.l || 0}`);
    }
    if (h && isNum(h.week)) b.push(`Week ${h.week + 1}`);
    const wd = h ? (isNum(h.weekday) ? h.weekday : weekdayOf(h.day)) : -1;
    if (wd >= 0 && wd <= 6) b.push(WD_LONG[wd]);
    this.subEl.innerHTML = [a, b].filter(x => x.length).map(x => `<span>${esc(x.join(' · '))}</span>`).join('');
    const w = h && isNum(h.wallet) ? h.wallet : null;
    this.walletEl.hidden = w == null;
    if (w != null) {
      this.walletAmtEl.textContent = num(w);
      this.walletEl.setAttribute('aria-label', `Wallet: ${money(w)}`);
    }
  }

  _emptyHtml(icon, title, text, btn = '') {
    return `<div class="ccj-empty">${icon}<b>${esc(title)}</b>${esc(text)}${btn}</div>`;
  }

  _htmlLocked(h) {
    if (!h) {
      return `<div class="ccj-locked">${trophyArt('ccj-lock-art')}<h3>The tour desk is closed</h3>
        <p>${esc(this._hubError ? 'The tour information couldn’t be loaded right now.' : 'There’s no tour information yet.')}</p></div>`;
    }
    const u = h.unlock && typeof h.unlock === 'object' ? h.unlock : null;
    const need = u && isNum(u.need) ? Math.max(1, Math.min(9, u.need)) : 3;
    const wins = u && isNum(u.wins) ? Math.max(0, u.wins) : null;
    let pips = '';
    if (wins != null) {
      for (let i = 0; i < need; i++) pips += `<i class="${i < wins ? 'is-on' : ''}">${i < wins ? '✓' : ''}</i>`;
      pips = `<div class="ccj-pips" role="img" aria-label="${Math.min(wins, need)} of ${need} wins against Coach Rafa">${pips}</div>`;
    }
    const ready = wins != null && wins >= need;
    return `<div class="ccj-locked">${trophyArt('ccj-lock-art')}
      <h3>${ready ? 'Rafa wants a word' : 'Not on the tour yet'}</h3>
      <p>${ready ? 'You’ve beaten Coach Rafa enough times to get his attention. Talk to him at the club — he has an offer.'
        : `Beat Coach Rafa ${need} times after hours (any level) and he’ll offer to coach you on the Junior Tennis Tour: tournaments at other clubs, real draws, a ranking and rivals.`}</p>
      ${pips}<p class="ccj-note">Play him from the end-of-shift report: “Stay for a hit with Coach Rafa”.</p></div>`;
  }

  // ── This week

  _html_week(h) {
    const f = h.featured && typeof h.featured === 'object' ? h.featured : null;
    const tonight = h.tonight ? this._tonightHtml(h) : '';
    if (!f) {
      const next = arr(h.calendar).find(c => isNum(c.week) && isNum(h.week) && c.week > h.week);
      return `<div class="ccj-week">${tonight}<div class="ccj-stack">${this._emptyHtml(ICON.calendar, 'A rest week',
        next ? `No tournament this week. Next up: ${next.name} (week ${next.week + 1}).` : 'No tournament this week. Rest those legs.',
        '<button type="button" class="cc-btn" data-act="tab" data-tab="calendar">See the calendar</button>')}</div>
        <div class="ccj-stack">${this._soonHtml(h, null)}</div></div>`;
    }
    return `<div class="ccj-week">${tonight}
      <div class="ccj-stack">${this._featHtml(h, f)}</div>
      <div class="ccj-stack">${this._prizeHtml(f, h)}${this._soonHtml(h, f)}</div></div>`;
  }

  _tonightHtml(h) {
    const s = h.tonight;
    const d = describeTourMatch(s);
    if (!d) return '';
    const play = this._canPlayTonight();
    const bits = [s.courtLabel || s.venueName || d.venue, SURFACE_LABEL[s.surface], FORMAT_LABEL[s.format], WIND_LABEL[s.wind]].filter(Boolean);
    return `<div class="ccj-tonight" role="group" aria-label="Tonight's match">
      <div class="ccj-tonight__ic" aria-hidden="true">${trophyArt()}</div>
      <div class="ccj-tonight__tx"><div class="cc-label">Tonight · ${esc(s.tournamentName || 'Tournament')}${d.final ? ' · the final!' : ''}</div>
        <b>${esc(d.roundLong)} vs ${esc(d.opponent)}</b><span>${esc(bits.join(' · '))}</span>
        ${play ? '' : '<span>Play it from your end-of-shift report card.</span>'}</div>
      ${play ? '<button type="button" class="cc-btn ccj-btn ccj-btn--gold" data-act="play">Play now ▸</button>' : ''}</div>`;
  }

  _canPlayTonight() {
    return typeof this.opts.onPlayTonight === 'function' && !!this._call('canPlayTonight');
  }

  _featHtml(h, f) {
    const surface = SURFACE_LABEL[f.surface] ? f.surface : '';
    const tier = f.tierLabel || TIER_LABEL[f.tier] || prettyId(f.tier);
    const chips = [];
    if (surface) chips.push(`<span class="ccj-chip"><i></i>${esc(SURFACE_LABEL[surface])}</span>`);
    if (isNum(f.draw)) chips.push(`<span class="ccj-chip">${f.draw}-player draw</span>`);
    if (f.wildcard) chips.push(`<span class="ccj-chip">★ ${esc(typeof f.wildcard === 'string' ? f.wildcard : 'Wildcard')}</span>`);
    const facts = this._factsHtml(h, f);
    return `<section class="ccj-card ccj-feat ccj-feat--${esc(surface || 'none')}" aria-labelledby="ccj-feat-name">
      <div class="ccj-feat__band">${courtArt}
        <div class="ccj-feat__tier">${esc([tier, isNum(h.week) ? `Week ${h.week + 1}` : ''].filter(Boolean).join(' · '))}</div>
        <h3 class="ccj-feat__name" id="ccj-feat-name">${esc(f.name || 'This week’s tournament')}</h3>
        <div class="ccj-feat__venue">${esc(f.venueName || prettyId(f.venueId))}</div>
        <div class="ccj-feat__chips">${chips.join('')}</div></div>
      <div class="ccj-feat__in">
        ${this._statusHtml(h, f)}
        ${facts}
        ${this._schedHtml(h, f)}
        ${this._actionHtml(h, f)}
      </div></section>`;
  }

  /** Where the player stands in the featured event: { alive, out, champion, lastRound }. */
  _myRun(h, f) {
    const d = h.draw && (!f || !h.draw.tournamentId || !f.id || h.draw.tournamentId === f.id) ? h.draw : null;
    const run = { alive: false, out: false, champion: false, lastKey: null, pendingKey: null };
    if (!d || !Array.isArray(d.rounds)) return run;
    const size = d.size || (arr(d.rounds[0]).length * 2);
    d.rounds.forEach((ms, r) => {
      for (const m of arr(ms)) {
        if (!m) continue;
        const side = m.a && m.a.isMe ? 'a' : m.b && m.b.isMe ? 'b' : null;
        if (!side) continue;
        const key = roundKeyFor(size, r);
        if (m.winner === side) { run.lastKey = key; if (key === 'F') run.champion = true; }
        else if (m.winner) { run.out = true; run.lastKey = key; }
        else run.pendingKey = key;
      }
    });
    run.alive = !run.out && !run.champion && !!run.pendingKey;
    return run;
  }

  _statusHtml(h, f) {
    const status = STATUS_ORDER.includes(f.status) ? f.status : 'open';
    const days = arr(f.days).filter(d => d && isNum(d.day)).sort((a, b) => a.day - b.day);
    const first = days[0];
    const closeWd = first ? weekdayOf(first.day - 1) : -1;
    // entries close (and the draw is made) the evening before round 1
    const closeWhen = !first ? '' : isNum(h.day) && first.day - 1 === h.day ? 'tonight' : `${WD_LONG[closeWd]} night`;
    const run = this._myRun(h, f);
    let cls = '', text;
    if (status === 'open') {
      cls = 'is-open';
      text = closeWhen ? `Entries open until ${closeWhen}` : 'Entries open';
    } else if (status === 'closed') {
      text = f.entered ? 'Entries closed — you’re in the draw' : 'Entries are closed for this one';
      if (f.entered) cls = 'is-in';
    } else if (status === 'entered') {
      cls = 'is-in';
      text = closeWhen ? `You’re entered · the draw is made ${closeWhen}` : 'You’re entered · waiting for the draw';
    } else if (status === 'inProgress') {
      if (!f.entered) text = 'In progress — you’re not in this one';
      else if (run.out) { cls = 'is-out'; text = `Out in the ${roundLong(run.lastKey).toLowerCase()} · your points are banked`; }
      else { cls = 'is-in'; text = run.pendingKey ? `You’re in the ${roundLong(run.pendingKey).toLowerCase()}` : 'You’re still in it'; }
    } else {
      const champ = this._champion(h);
      if (run.champion) { cls = 'is-in'; text = 'You won it! 🏆'; }
      else if (f.entered && run.lastKey) text = `Finished · you reached the ${roundLong(run.lastKey).toLowerCase()}`;
      else text = champ ? `Finished · won by ${nameOf(champ, 'TBD')}` : 'Finished';
    }
    let next = '';
    const nm = h.nextMatch && !h.tonight ? h.nextMatch : null;
    if (nm && (status === 'inProgress' || status === 'entered' || status === 'closed')) {
      next = `<div class="ccj-next">Next: <b>${esc(roundLong(nm.roundLabel))}</b> ${esc(this._whenText(h, nm.day))} vs ${esc(nameOf(nm.opponent, 'the winner of the other match'))}</div>`;
    }
    return `<div class="ccj-status ${cls}"><i aria-hidden="true"></i><span>${esc(text)}</span></div>${next}`;
  }

  _whenText(h, day) {
    if (!isNum(day)) return '';
    if (isNum(h.day) && day === h.day) return 'tonight';
    if (isNum(h.day) && day === h.day + 1) return 'tomorrow evening';
    const wd = weekdayOf(day);
    return wd >= 0 ? `${WD_LONG[wd]} evening` : '';
  }

  _champion(h) {
    const d = h.draw;
    if (!d || !Array.isArray(d.rounds) || !d.rounds.length) return null;
    const fin = arr(d.rounds[d.rounds.length - 1])[0];
    if (!fin) return null;
    return fin.winner === 'a' ? fin.a : fin.winner === 'b' ? fin.b : null;
  }

  _factsHtml(h, f) {
    const fee = Number(f.fee) || 0;
    const sponsored = !!f.sponsored || (h.career === 'pro' && fee === 0);
    let feeTxt;
    if (sponsored) feeTxt = isNum(f.baseFee) && f.baseFee > 0 ? `<s>${money(f.baseFee)}</s>$0` : '$0';
    else feeTxt = fee > 0 ? money(fee) : 'Free';
    const cutoff = isNum(f.cutoff) && f.cutoff > 0 ? `Top ${f.cutoff}` : 'Open';
    const firstPrize = f.prize && isNum(Number(f.prize.W)) && Number(f.prize.W) > 0 ? money(f.prize.W) : '—';
    const winPts = f.points && Number(f.points.W) > 0 ? num(f.points.W) : '—';
    return `<div class="ccj-facts">
      <div class="ccj-fact"><b>${feeTxt}</b><span>${sponsored ? 'Entry · club pays' : 'Entry fee'}</span></div>
      <div class="ccj-fact"><b>${esc(cutoff)}</b><span>Ranking cutoff</span></div>
      <div class="ccj-fact"><b>${firstPrize}</b><span>Winner’s prize</span></div>
      <div class="ccj-fact"><b>${winPts}</b><span>Winner’s points</span></div></div>`;
  }

  _schedHtml(h, f) {
    const days = arr(f.days).filter(d => d && isNum(d.day)).sort((a, b) => a.day - b.day);
    if (!days.length) return '';
    let html = '';
    for (const d of days) {
      const wd = isNum(d.weekday) ? d.weekday : weekdayOf(d.day);
      const today = isNum(h.day) && d.day === h.day;
      const past = isNum(h.day) && d.day < h.day;
      const label = d.round || d.roundLabel || '';
      html += `<div class="ccj-day${today ? ' is-today' : ''}${past ? ' is-past' : ''}" title="${esc(roundLong(label))}${wd >= 0 ? ' · ' + WD_LONG[wd] : ''}">
        <b>${today ? 'Today' : wd >= 0 ? WD[wd] : 'Day ' + d.day}</b><span>${esc(label)}</span></div>`;
    }
    return `<div><div class="ccj-sec" style="margin:0 2px 6px"><span class="cc-label">Schedule · evening matches</span></div><div class="ccj-sched">${html}</div></div>`;
  }

  _actionHtml(h, f) {
    const status = STATUS_ORDER.includes(f.status) ? f.status : 'open';
    const fee = Number(f.fee) || 0;
    const run = this._myRun(h, f);
    const name = esc(f.name || 'this tournament');
    if (this._confirmWithdraw) {
      const walkover = status === 'inProgress';
      return `<div class="ccj-confirm" role="alert">
        <div>${walkover ? `Withdraw from the ${name}? Your next match becomes a walkover; points you have already won stay.`
          : `Withdraw from the ${name}? Your place in the draw goes to the next player on the list.`}</div>
        <div class="ccj-confirm__row"><button type="button" class="cc-btn" data-act="keep">Keep my place</button>
          <button type="button" class="cc-btn cc-btn--danger" data-act="withdraw-yes">Withdraw</button></div></div>`;
    }
    if (f.entered) {
      const canWithdraw = status === 'entered' || status === 'closed' || (status === 'inProgress' && run.alive && !h.tonight);
      if (!canWithdraw) return '';
      return `<div class="ccj-act"><button type="button" class="cc-btn ccj-btn" data-act="withdraw">Withdraw</button></div>`;
    }
    if (status !== 'open') {
      return f.reason ? `<div class="ccj-reason">${esc(f.reason)}</div>` : '';
    }
    const sponsored = !!f.sponsored || (h.career === 'pro' && fee === 0);
    const price = sponsored ? 'club-sponsored' : fee > 0 ? money(fee) : 'free';
    if (f.canEnter) {
      return `<div class="ccj-act"><button type="button" class="cc-btn ccj-btn ccj-btn--gold" data-act="enter">Enter · ${esc(price)}</button>
        ${f.wildcard ? '<div class="ccj-note" style="text-align:center">You’re in on a wildcard — no ranking needed.</div>' : ''}</div>`;
    }
    const why = f.reason || h.reason || 'You can’t enter this one.';
    return `<div class="ccj-act"><button type="button" class="cc-btn ccj-btn" aria-disabled="true" data-act="why" aria-describedby="ccj-why">Enter · ${esc(price)}</button>
      <div class="ccj-reason" id="ccj-why">${esc(why)}</div></div>`;
  }

  _prizeHtml(f, h) {
    const run = this._myRun(h, f);
    const reached = run.champion ? 'W' : run.lastKey;
    let rows = '';
    for (const k of PRIZE_ROWS) {
      const pts = f.points ? f.points[k] : undefined;
      const prize = f.prize ? f.prize[k] : undefined;
      if (pts == null && prize == null) continue;
      const hi = f.entered && reached && ((k === 'W' && run.champion) || (!run.champion && k === (run.out ? run.lastKey : null)));
      rows += `<tr class="${hi ? 'is-hi' : ''}"><td>${esc(REACHED[k] || k)}</td><td class="num">${pts == null ? '—' : num(pts)}</td><td class="num">${prize == null || Number(prize) <= 0 ? '—' : money(prize)}</td></tr>`;
    }
    if (!rows) return '';
    return `<section class="ccj-card"><div class="ccj-sec" style="margin:0 0 8px"><span class="cc-label" id="ccj-prize-h">Points &amp; prize money</span></div>
      <table class="ccj-table" aria-labelledby="ccj-prize-h"><thead><tr><th scope="col">Result</th><th scope="col" class="num">Points</th><th scope="col" class="num">Prize</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="ccj-note" style="margin-top:8px">Your ranking counts your best 6 results from the last 8 weeks.</div></section>`;
  }

  _soonHtml(h, f) {
    const cal = arr(h.calendar).filter(c => c && isNum(c.week)).sort((a, b) => a.week - b.week);
    const cur = isNum(h.week) ? h.week : (cal.find(c => c.current) || {}).week;
    const soon = cal.filter(c => !c.current && (!isNum(cur) || c.week > cur) && (!f || c.id !== f.id)).slice(0, 3);
    if (!soon.length) return '';
    const items = soon.map(c => `<div class="ccj-soon__i"><div class="ccj-soon__w">Week<b>${c.week + 1}</b></div>
      <div class="ccj-soon__t"><b>${esc(c.name)}</b><span>${esc([c.venueName, TIER_LABEL[c.tier] || prettyId(c.tier), isNum(c.draw) ? c.draw + ' draw' : ''].filter(Boolean).join(' · '))}</span></div>
      ${SURFACE_LABEL[c.surface] ? `<span class="ccj-chip ccj-chip--${c.surface}">${esc(c.surface)}</span>` : ''}</div>`).join('');
    return `<section><div class="ccj-sec"><span class="cc-label">Coming up</span><button type="button" class="ccj-linkbtn" data-act="tab" data-tab="calendar">Full calendar ›</button></div>
      <div class="ccj-soon">${items}</div></section>`;
  }

  // ── Draw

  _html_draw(h) {
    const d = h.draw;
    const f = h.featured;
    if (!d || !Array.isArray(d.rounds) || !d.rounds.length) {
      return this._emptyHtml(ICON.draw, 'No draw yet', f && f.name
        ? `The ${f.name} draw is made when entries close, the evening before round 1.${f.entered ? ' You’re in it — check back then.' : ''}`
        : 'Enter a tournament and its draw shows up here once entries close.',
      '<button type="button" class="cc-btn" data-act="tab" data-tab="week">This week’s tournament</button>');
    }
    const size = d.size || (arr(d.rounds[0]).length * 2);
    const focus = this._drawFocusRound(d);
    let chips = '', cols = '';
    const dayOfRound = (r) => {
      const m = arr(d.rounds[r]).find(x => x && isNum(x.day));
      if (m) return m.day;
      const fd = f && arr(f.days)[r];
      return fd && isNum(fd.day) ? fd.day : null;
    };
    d.rounds.forEach((ms, r) => {
      const key = roundKeyFor(size, r);
      const mine = arr(ms).some(m => m && ((m.a && m.a.isMe) || (m.b && m.b.isMe)));
      const day = dayOfRound(r);
      const wd = weekdayOf(day);
      const played = arr(ms).length > 0 && arr(ms).every(m => m && (m.winner === 'a' || m.winner === 'b'));
      const when = isNum(day) && isNum(h.day) && day === h.day && !played ? 'Tonight' : wd >= 0 ? WD[wd] : '';
      chips += `<button type="button" class="ccj-rbtn${mine ? ' has-me' : ''}" data-act="round" data-round="${r}" aria-pressed="${r === focus ? 'true' : 'false'}" aria-label="${esc(roundLong(key))}${mine ? ', you play in this round' : ''}">${esc(key)}</button>`;
      const last = r === d.rounds.length - 1;
      const cards = arr(ms).map(m => this._matchHtml(m, h, key)).join('');
      cols += `<section class="ccj-col" data-col="${r}" aria-label="${esc(roundLong(key))}">
        <div class="ccj-col__h">${esc(roundLong(key))}${when ? ' · ' + esc(when) : ''}</div>
        <div class="ccj-col__list">${last ? `<div class="ccj-fgroup">${cards}${this._champHtml(arr(ms)[0])}</div>` : cards}</div></section>`;
    });
    const tonight = h.tonight ? describeTourMatch(h.tonight) : null;
    return `<div class="ccj-drawbar"><div class="ccj-drawbar__t"><div class="cc-label">${esc(size)}-player draw${f && f.venueName ? ' · ' + esc(f.venueName) : ''}</div>
        <b>${esc(d.name || (f && f.name) || 'Draw')}</b></div>
      <div class="ccj-rounds" role="group" aria-label="Jump to a round">${chips}</div></div>
      ${tonight ? `<div class="ccj-next" style="margin-bottom:10px">Tonight: <b>${esc(tonight.roundLong)}</b> vs ${esc(tonight.opponent)}${this._canPlayTonight() ? '' : ' · play it from your end-of-shift report'}</div>` : ''}
      <div class="ccj-bracket" tabindex="0" role="region" aria-label="Draw bracket, scroll sideways for later rounds" data-focus="${focus}">${cols}</div>
      <div class="ccj-legend"><span><i class="ccj-sw" aria-hidden="true"></i>Your matches</span><span><span class="ccj-club" aria-hidden="true"></span>Greenbriar junior</span><span>Seeds on the left · ✓ winner</span></div>`;
  }

  /** The round to show first: the player's pending match, else their last one, else the round being played. */
  _drawFocusRound(d) {
    let mineLast = -1, minePending = -1, firstOpen = -1;
    d.rounds.forEach((ms, r) => {
      for (const m of arr(ms)) {
        if (!m) continue;
        const me = (m.a && m.a.isMe) || (m.b && m.b.isMe);
        if (!m.winner && firstOpen < 0 && m.a && m.b) firstOpen = r;
        if (me) { mineLast = r; if (!m.winner && minePending < 0) minePending = r; }
      }
    });
    if (minePending >= 0) return minePending;
    if (firstOpen >= 0) return firstOpen;
    if (mineLast >= 0) return mineLast;
    return d.rounds.length - 1;
  }

  _matchHtml(m, h, key) {
    if (!m) return '';
    const done = m.winner === 'a' || m.winner === 'b';
    const mine = (m.a && m.a.isMe) || (m.b && m.b.isMe);
    const clubIds = this._clubIds(h);
    const pname = (p) => (p ? (p.isMe ? (p.name && !/^you$/i.test(p.name) ? p.name : 'You') : (p.name || 'TBD')) : null);
    const row = (p, side) => {
      const win = done && m.winner === side, lose = done && !win;
      const name = pname(p);
      const club = p && !p.isMe && (p.isClub || clubIds.has(p.id));
      const cls = 'ccj-p' + (win ? ' is-win' : '') + (lose ? ' is-lose' : '') + (p && p.isMe ? ' is-me' : '');
      return `<div class="${cls}"><span class="ccj-seed">${p && isNum(p.seed) ? p.seed : ''}</span>
        <span class="ccj-p__n">${name ? esc(name) : '<i>To be decided</i>'}${p && p.isMe && name !== 'You' ? '<span class="ccj-you">You</span>' : ''}${club ? '<span class="ccj-club" title="Greenbriar junior"></span>' : ''}</span>
        <span class="ccj-p__w" aria-hidden="true">${win ? '✓' : ''}</span></div>`;
    };
    let foot;
    if (done) {
      const s = String(m.score || '').trim();
      foot = `<span>${/^(w\/?o|walkover)$/i.test(s) ? 'Walkover' : 'Final score'}</span><b>${esc(/^(w\/?o|walkover)$/i.test(s) ? 'W/O' : s || '—')}</b>`;
    } else {
      const tonight = isNum(m.day) && isNum(h.day) && m.day === h.day;
      const wd = weekdayOf(m.day);
      foot = `<span class="${tonight ? 'is-tonight' : ''}">${tonight ? 'Tonight' : wd >= 0 ? WD_LONG[wd] + ' evening' : 'To be played'}</span><b></b>`;
    }
    const na = pname(m.a) || 'to be decided', nb = pname(m.b) || 'to be decided';
    const w = done ? (m.winner === 'a' ? na : nb) : null;
    const aria = `${roundLong(key)}: ${na} versus ${nb}${w ? `, ${w} won ${m.score || ''}` : ''}`;
    return `<div class="ccj-m${mine ? ' is-me' : ''}" role="group" aria-label="${esc(aria)}">${row(m.a, 'a')}${row(m.b, 'b')}<div class="ccj-m__f">${foot}</div></div>`;
  }

  _clubIds(h) {
    const ids = new Set();
    for (const r of arr(h.rankings)) if (r && r.isClub && r.id) ids.add(r.id);
    return ids;
  }

  _champHtml(fin) {
    const w = fin && (fin.winner === 'a' ? fin.a : fin.winner === 'b' ? fin.b : null);
    const name = w ? (w.isMe ? 'You!' : (w.name || 'TBD')) : 'To be decided';
    return `<div class="ccj-champ${w && w.isMe ? ' is-me' : ''}">${trophyArt()}<div><div class="cc-label">Champion</div><b>${esc(name)}</b></div></div>`;
  }

  _wireBracket() {
    const br = this.bodyEl.querySelector('.ccj-bracket');
    if (!br) return;
    this._bracket = br;
    const focus = Number(br.dataset.focus) || 0;
    const col = br.querySelector(`[data-col="${focus}"]`);
    if (col) br.scrollLeft = Math.max(0, col.offsetLeft - 2);
    let raf = 0;
    br.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; this._syncRounds(br); });
    }, { passive: true });
  }

  /**
   * Round chips follow the bracket's horizontal scroll: the pressed round stays while its column
   * is fully in view (a jump to the final that can't reach the left edge keeps "F"), otherwise the
   * left-most visible column takes over.
   */
  _syncRounds(br) {
    if (!br.isConnected || br.scrollWidth <= br.clientWidth + 2) return;
    const cols = br.querySelectorAll('.ccj-col');
    const x0 = br.scrollLeft - 4, x1 = br.scrollLeft + br.clientWidth + 4;
    const btns = this.bodyEl.querySelectorAll('.ccj-rbtn');
    let pressed = -1;
    for (const b of btns) if (b.getAttribute('aria-pressed') === 'true') pressed = Number(b.dataset.round);
    const inView = (c) => c && c.offsetLeft >= x0 && c.offsetLeft + c.offsetWidth <= x1;
    if (pressed >= 0 && inView(cols[pressed])) return;
    let best = 0, bestD = Infinity;
    cols.forEach((c, i) => {
      const d = Math.abs(c.offsetLeft - 2 - br.scrollLeft);
      if (d < bestD) { bestD = d; best = i; }
    });
    for (const b of btns) b.setAttribute('aria-pressed', Number(b.dataset.round) === best ? 'true' : 'false');
  }

  // ── Rankings

  _html_rankings(h) {
    const list = arr(h.rankings);
    const me = h.me || {};
    if (!list.length) return this._emptyHtml(ICON.rankings, 'No rankings yet', 'The first ranking list comes out after the first tournament of the season.');
    const rows = pickRankRows(list);
    let body = '';
    for (const r of rows) {
      if (!r) { body += '<tr class="ccj-gap" aria-hidden="true"><td colspan="3">···</td></tr>'; continue; }
      const cls = [r.isMe ? 'is-me' : '', r.isClub ? 'is-club' : '', isNum(r.rank) && r.rank <= 3 ? 'is-top' : ''].filter(Boolean).join(' ');
      const nm = r.isMe ? (r.name && !/^you$/i.test(r.name) ? r.name : 'You') : r.name;
      body += `<tr class="${cls}"${r.isMe ? ' aria-current="true"' : ''}><td>${isNum(r.rank) ? r.rank : '—'}</td>
        <td class="ccj-who"><b>${esc(nm || '—')}${r.isMe && nm !== 'You' ? '<span class="ccj-you">You</span>' : ''}${r.isClub && !r.isMe ? '<span class="ccj-club" role="img" aria-label="Greenbriar junior"></span>' : ''}</b><small>${esc(r.club || (r.isClub ? 'Greenbriar' : ''))}</small></td>
        <td>${num(r.points)}</td></tr>`;
    }
    const ranked = isNum(me.rank);
    const listed = rows.some(r => r && r.isMe);
    const card = `<div class="ccj-rkme__n">${ranked ? '#' + me.rank : '—'}</div>
        <div class="ccj-rkme__t"><b>${ranked ? 'Your ranking' : 'Unranked'}</b><br>${num(me.points || 0)} points${listed && ranked && me.rank > 8 ? '<br><span class="ccj-rkme__go">Find me in the list ↓</span>' : ''}</div>`;
    return `<div class="ccj-rkhead">${listed && ranked && me.rank > 8
      ? `<button type="button" class="ccj-rkme" data-act="find-me" aria-label="Your ranking: ${me.rank}. Scroll to your row">${card}</button>`
      : `<div class="ccj-rkme">${card}</div>`}
      <div class="ccj-note">${ranked ? '' : 'Win a round at any tournament to get a ranking. '}Best 6 results from the last 8 weeks count; ties go to the higher rating. Green marks a Greenbriar junior.</div></div>
      <table class="ccj-rk"><thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">Points</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  // ── Calendar

  _html_calendar(h) {
    const cal = arr(h.calendar).filter(c => c && typeof c === 'object').slice().sort((a, b) => (a.week || 0) - (b.week || 0));
    if (!cal.length) return this._emptyHtml(ICON.calendar, 'No calendar yet', 'The tour publishes its calendar week by week.');
    const results = this._resultsByTournament(h);
    const cur = isNum(h.week) ? h.week : (cal.find(c => c.current) || {}).week;
    // This week's event: where the player stands now (the draw), not only the rounds already played
    const f = h.featured;
    const run = f && f.entered ? this._myRun(h, f) : null;
    const nowRes = !run ? null : run.champion ? { label: 'Champion', won: true, champion: true }
      : run.out ? { label: `Lost ${run.lastKey}`, won: false } : run.pendingKey ? { label: `In the ${run.pendingKey}`, won: true } : { label: 'Entered', won: true };
    let items = '';
    for (const c of cal) {
      const current = !!c.current || (isNum(cur) && c.week === cur);
      const past = !current && isNum(cur) && isNum(c.week) && c.week < cur;
      const surf = SURFACE_LABEL[c.surface] ? c.surface : '';
      const wd = weekdayOf(c.startDay);
      const when = wd >= 0 ? `${WD[wd]}–Sun` : '';
      const res = (current && nowRes && f && (!f.id || !c.id || f.id === c.id || f.name === c.name) ? nowRes : null)
        || results.get(`${c.week}|${c.name}`) || (past ? results.get(`|${c.name}`) : null);
      let side = surf ? `<span class="ccj-chip ccj-chip--${surf}">${esc(c.surface)}</span>` : '';
      if (res) side += `<span class="ccj-chip ${res.champion ? 'ccj-chip--gold' : res.won ? 'ccj-chip--ok' : ''}">${esc(res.label)}</span>`;
      items += `<li class="ccj-ci${current ? ' is-current' : ''}${past ? ' is-past' : ''}${surf ? ' ccj-ci--' + surf : ''}"${current ? ' aria-current="true"' : ''}>
        <span class="ccj-ci__dot" aria-hidden="true"></span>
        <div class="ccj-ci__card"><div class="ccj-ci__main"><div class="cc-label">Week ${isNum(c.week) ? c.week + 1 : '?'}${current ? ' · this week' : ''}${when ? ' · ' + when : ''}</div>
          <b>${esc(c.name || 'Tournament')}</b><span>${esc([c.venueName, TIER_LABEL[c.tier] || prettyId(c.tier), isNum(c.draw) ? c.draw + '-player draw' : ''].filter(Boolean).join(' · '))}</span></div>
          <div class="ccj-ci__side">${side}</div></div></li>`;
    }
    return `<div class="ccj-sec"><span class="cc-label">Tour calendar</span><span class="ccj-sec__aside ccj-sec__aside--long">One featured event a week · matches in the evenings</span></div>
      <ol class="ccj-cal">${items}</ol>`;
  }

  /** The player's best round per tournament (from the match history): 'week|name' → { label, won, champion }. */
  _resultsByTournament(h) {
    const out = new Map();
    const hist = arr(h.me && h.me.history);
    const titles = arr(h.me && h.me.titles);
    for (const e of hist) {
      if (!e || !e.tournament) continue;
      const k = `${isNum(e.week) ? e.week : ''}|${e.tournament}`;
      const champion = e.won && (e.round === 'F' || e.round === 'W');
      const label = champion ? 'Champion' : e.won ? `Won ${e.round || ''}`.trim() : `Lost ${e.round || ''}`.trim();
      out.set(k, { label, won: !!e.won, champion });
      if (!out.has(`|${e.tournament}`) || champion) out.set(`|${e.tournament}`, { label, won: !!e.won, champion });
    }
    for (const t of titles) if (t && t.name) out.set(`${isNum(t.week) ? t.week : ''}|${t.name}`, { label: 'Champion', won: true, champion: true });
    return out;
  }

  // ── Profile

  _html_profile(h) {
    const me = h.me || {};
    const rec = me.record || {};
    const w = Number(rec.w) || 0, l = Number(rec.l) || 0;
    const pct = w + l ? Math.round((w / (w + l)) * 100) + '%' : '—';
    const titles = arr(me.titles);
    const stats = `<div class="ccj-mestats">
      <div class="ccj-mestat is-gold"><b>${isNum(me.rank) ? '#' + me.rank : '—'}</b><span>Ranking</span></div>
      <div class="ccj-mestat"><b>${num(me.points || 0)}</b><span>Points</span></div>
      <div class="ccj-mestat"><b>${w}–${l}</b><span>Won–lost</span></div>
      <div class="ccj-mestat"><b>${pct}</b><span>Win rate</span></div></div>`;
    const careerLine = this._careerLine(h);
    const trophies = titles.length
      ? `<div class="ccj-trophies">${titles.slice().reverse().map(t => `<div class="ccj-trophy">${trophyArt()}<b>${esc(t.name || 'Title')}</b><small>${esc([t.venue, isNum(t.week) ? 'Week ' + (t.week + 1) : ''].filter(Boolean).join(' · '))}</small></div>`).join('')}</div>`
      : `<div class="ccj-empty" style="padding:16px">${ICON.trophy}Your trophy cabinet is empty — for now.</div>`;
    const pb = arr(me.pointsBreakdown).filter(Boolean);
    let pts;
    if (pb.length) {
      const total = pb.reduce((s, r) => s + (Number(r.points) || 0), 0);
      pts = `<section class="ccj-card"><table class="ccj-table"><thead><tr><th scope="col">Result</th><th scope="col" class="num">Points</th></tr></thead><tbody>
        ${pb.map(r => `<tr><td>${esc(r.tournament || '—')}<small>${esc([REACHED[r.round] || r.round, isNum(r.week) ? 'week ' + (r.week + 1) : ''].filter(Boolean).join(' · '))}</small></td><td class="num">${num(r.points)}</td></tr>`).join('')}
        <tr class="is-total"><td>Ranking points</td><td class="num">${num(isNum(me.points) ? me.points : total)}</td></tr></tbody></table></section>`;
    } else pts = '<div class="ccj-note">No ranking points yet. Every round you win at a tournament earns some.</div>';
    const hist = arr(me.history).filter(Boolean).slice(-8).reverse();
    const histHtml = hist.length
      ? `<ol class="ccj-hist">${hist.map(e => `<li><span class="ccj-wl ${e.won ? 'is-w' : 'is-l'}" aria-label="${e.won ? 'Won' : 'Lost'}">${e.won ? 'W' : 'L'}</span>
          <div><b>${esc(roundLong(e.round))} vs ${esc(nameOf(e.opponent, '—'))}</b><small>${esc([e.tournament, isNum(e.week) ? 'week ' + (e.week + 1) : ''].filter(Boolean).join(' · '))}</small></div>
          <span class="ccj-score">${esc(e.score || '')}</span></li>`).join('')}</ol>`
      : '<div class="ccj-note">No tour matches yet.</div>';
    const h2h = Object.entries(h.me && h.me.h2h && typeof h.me.h2h === 'object' ? h.me.h2h : {})
      .map(([id, v]) => ({ id, w: Number(v && v.w) || 0, l: Number(v && v.l) || 0, name: (v && v.name) || prettyId(id) }))
      .filter(x => x.w + x.l > 0).sort((a, b) => (b.w + b.l) - (a.w + a.l) || b.w - a.w).slice(0, 12);
    const h2hHtml = h2h.length
      ? `<div class="ccj-h2h">${h2h.map(x => `<div><span>${esc(x.name)}</span><b class="${x.w > x.l ? 'is-up' : x.w < x.l ? 'is-down' : ''}">${x.w}–${x.l}</b></div>`).join('')}</div>`
      : '<div class="ccj-note">Head-to-heads build up as you meet the same players again.</div>';
    return `<div class="ccj-prof">
      <div><div class="ccj-sec"><span class="cc-label">Your season</span></div>${stats}${careerLine}
        <div class="ccj-sec"><span class="cc-label">Titles</span><span class="ccj-sec__aside">${titles.length ? titles.length + (titles.length === 1 ? ' trophy' : ' trophies') : ''}</span></div>${trophies}
        <div class="ccj-sec"><span class="cc-label">Points that count</span><span class="ccj-sec__aside">best 6 · last 8 weeks</span></div>${pts}</div>
      <div><div class="ccj-sec"><span class="cc-label">Recent matches</span></div>${histHtml}
        <div class="ccj-sec"><span class="cc-label">Head-to-head</span></div>${h2hHtml}</div></div>`;
  }

  _careerLine(h) {
    const c = h.career;
    const title = h.careerTitle || (c === 'pro' ? 'Touring Pro' : c === 'grounds' ? 'Head Groundskeeper' : 'Amateur');
    const txt = c === 'pro' ? 'The Pro Circuit is open, the club pays your entry fees and Jess sponsors your gear. The shifts still run.'
      : c === 'grounds' ? 'The grounds are yours to run, and you still play the amateur tour events.'
        : 'You pay your own entry fees from your shift wages. Coach Rafa is in your box.';
    return `<div class="ccj-career"><b>${esc(title)}.</b> ${esc(txt)}</div>`;
  }

  // ── Scouting

  _html_scouting(h) {
    const s = h.scouting;
    if (!s || !s.opponent) {
      return this._emptyHtml(ICON.scouting, 'Nobody to scout yet', h.featured && h.featured.entered
        ? 'Rafa scouts your next opponent as soon as the draw names one.'
        : 'Enter a tournament: once the draw is out, Rafa writes up your next opponent here.');
    }
    const o = s.opponent;
    const meta = [isNum(o.age) ? `${o.age} years old` : '', o.club].filter(Boolean).join(' · ');
    const next = h.tonight || h.nextMatch;
    let nextLine = '';
    if (next) {
      const round = next.roundLabel || next.round;
      const when = h.tonight ? 'tonight' : this._whenText(h, next.day);
      const where = h.tonight ? venueShortOf(h.tonight) : '';
      nextLine = `<div class="ccj-nextline">${esc(roundLong(round))}${when ? ' · ' + esc(when) : ''}${where ? ' · ' + esc(where) : ''}</div>`;
    }
    const rec = h.me && h.me.h2h && o.id && h.me.h2h[o.id];
    const h2h = rec && ((rec.w || 0) + (rec.l || 0)) ? `<span class="ccj-chip ${rec.w >= rec.l ? 'ccj-chip--ok' : 'ccj-chip--bad'}">You ${rec.w || 0}–${rec.l || 0}</span>` : '<span class="ccj-chip">First meeting</span>';
    const list = (items, cls) => {
      const a = arr(items).filter(Boolean);
      return a.length ? `<ul class="ccj-list ${cls}">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="ccj-note">Nothing stands out.</div>';
    };
    const plan = arr(s.plan).filter(Boolean);
    return `<div class="ccj-scout">
      <section class="ccj-card">
        <div class="ccj-opp"><div class="ccj-avatar" style="--ccj-av:${avatarColor(o.id || o.name)}" aria-hidden="true">${esc(initials(o.name || o.short))}</div>
          <div class="ccj-opp__t"><div class="cc-label">Next opponent${isNum(o.seed) ? ` · seed ${o.seed}` : ''}</div><b>${esc(o.name || o.short || 'Unknown')}</b><span>${esc(meta)}</span></div></div>
        <div class="ccj-opp__chips">${o.styleLabel || o.style ? `<span class="ccj-chip ccj-chip--gold">${esc(o.styleLabel || prettyId(o.style))}</span>` : ''}${starsHtml(o.rating)}${h2h}</div>
        ${nextLine}
      </section>
      <section class="ccj-plan" aria-label="Coach Rafa's game plan"><div class="ccj-plan__h">${ICON.clipboard}<b>Rafa’s game plan</b></div>
        ${plan.length ? `<ol>${plan.map(p => `<li>${esc(p)}</li>`).join('')}</ol>` : '<div class="ccj-note">“Play your game. I will watch the first games and tell you at the changeover.”</div>'}</section>
      <section class="ccj-card"><div class="ccj-sec" style="margin-top:0"><span class="cc-label" style="color:#a8e6b8">Strengths</span></div>${list(s.strengths, 'ccj-list--good')}</section>
      <section class="ccj-card"><div class="ccj-sec" style="margin-top:0"><span class="cc-label" style="color:#ffb4a8">Weaknesses</span></div>${list(s.weaknesses, 'ccj-list--bad')}</section>
    </div>`;
  }

  // ───────────────────────────── hub: actions ─────────────────────────────

  _act(act, btn) {
    const h = this.hub;
    const f = h && h.featured;
    switch (act) {
      case 'tab':
        this.showTab(btn.dataset.tab, true);
        this._focusTab();
        return;
      case 'round': {
        const r = Number(btn.dataset.round) || 0;
        const br = this.bodyEl.querySelector('.ccj-bracket');
        const col = br && br.querySelector(`[data-col="${r}"]`);
        if (!br || !col) return;
        for (const b of this.bodyEl.querySelectorAll('.ccj-rbtn')) b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        try { br.scrollTo({ left: Math.max(0, col.offsetLeft - 2), behavior: reduce ? 'auto' : 'smooth' }); } catch (e) { br.scrollLeft = Math.max(0, col.offsetLeft - 2); }
        col.classList.remove('is-flash');
        void col.offsetWidth;
        col.classList.add('is-flash');
        return;
      }
      case 'find-me': {
        const row = this.bodyEl.querySelector('.ccj-rk tr.is-me');
        if (!row) return;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        try { row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }); } catch (e) { row.scrollIntoView(); }
        row.classList.remove('is-flash');
        void row.offsetWidth;
        row.classList.add('is-flash');
        return;
      }
      case 'play': {
        const spec = h && h.tonight;
        if (!spec || !this._canPlayTonight()) return;
        // The match starts with no overlay on top; if it can't start, the hub comes back and says so
        this.close();
        if (this._call('onPlayTonight', spec) === false) {
          this.open({ tab: 'week' });
          this._setStatus('The match couldn’t start right now. Try the button on your report card.', 'error');
        }
        return;
      }
      case 'why':
        this._setStatus((f && f.reason) || (h && h.reason) || 'You can’t enter this one.', 'error');
        this._call('onFeedback', 'error');
        return;
      case 'enter': {
        if (!f || !f.id) return;
        const r = this._result(this.opts.enter, f.id);
        if (r.ok) {
          this._changed = true;
          this._loadHub();
          this._render(true);
          const nf = this.hub && this.hub.featured;
          const first = nf && arr(nf.days).filter(d => d && isNum(d.day)).sort((a, b) => a.day - b.day)[0];
          const wd = first ? weekdayOf(first.day) : -1;
          this._setStatus(`You’re in the ${f.name || 'draw'}!${first ? ` ${roundLong(first.round)}: ${WD_LONG[wd] || 'this week'} evening.` : ''}`, 'gold');
          this._call('onFeedback', 'enter', r);
        } else {
          this._setStatus(r.reason || 'The entry didn’t go through.', 'error');
          this._call('onFeedback', 'error', r);
        }
        return;
      }
      case 'withdraw':
        this._confirmWithdraw = true;
        this._render(true);
        this._focusIn('[data-act="keep"]');
        return;
      case 'keep':
        this._confirmWithdraw = false;
        this._render(true);
        this._focusIn('[data-act="withdraw"]');
        return;
      case 'withdraw-yes': {
        this._confirmWithdraw = false;
        if (!f || !f.id) return;
        const r = this._result(this.opts.withdraw, f.id);
        if (r.ok) {
          this._changed = true;
          this._loadHub();
          this._render(true);
          this._setStatus(r.reason || `You’ve withdrawn from the ${f.name || 'tournament'}.`, 'ok');
          this._call('onFeedback', 'withdraw', r);
        } else {
          this._render(true);
          this._setStatus(r.reason || 'You can’t withdraw right now.', 'error');
          this._call('onFeedback', 'error', r);
        }
        return;
      }
      default:
    }
  }

  /** Call enter / withdraw safely: always a { ok, reason } object. */
  _result(fn, id) {
    if (typeof fn !== 'function') return { ok: false, reason: 'The tour desk is closed right now.' };
    try {
      const r = fn(id);
      if (r && typeof r === 'object') return { ...r, ok: !!r.ok };
      return { ok: !!r };
    } catch (err) {
      console.warn('TourUI action:', err);
      return { ok: false, reason: 'Something went wrong. Try again.' };
    }
  }

  _setStatus(text, kind = '') {
    // The idle line is a keyboard hint: touch screens get an empty (collapsed) footer instead
    const touch = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
    this.footEl.textContent = text || (touch ? '' : 'Esc or ✕ to close');
    this.footEl.className = 'ccj-foot' + (text && kind ? ` is-${kind}` : '');
    clearTimeout(this._statusTimer);
    if (text) this._statusTimer = setTimeout(() => this._setStatus(''), 6500);
  }

  // ───────────────────────────── keyboard / focus ─────────────────────────────

  _globalKey(e) {
    if (!this.isOpen && !this._modal) return;
    if (e.code !== 'Escape' && e.code !== 'KeyP') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (this._modal) { if (this._modal.cancel) this._modal.cancel(); return; }
    this.close();
  }

  _hubKey(e) {
    if (e.key === 'Tab') { this._trap(e, this.panel); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') && e.target.classList && e.target.classList.contains('ccj-tab')) {
      e.preventDefault();
      const i = TAB_IDS.indexOf(this.tab);
      const n = TAB_IDS.length;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
      this.showTab(TAB_IDS[next], true);
      this._focusTab();
    }
  }

  _trap(e, scope) {
    const items = Array.from(scope.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])'))
      .filter(x => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  _focusTab() {
    const b = !this.tabsEl.hidden && this.tabBtns.find(x => x.dataset.tab === this.tab);
    const target = b || this.closeBtn;
    try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    if (b && b.scrollIntoView) { try { b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ } }
  }

  _focusIn(sel) {
    requestAnimationFrame(() => {
      const n = this.bodyEl.querySelector(sel);
      if (n) try { n.focus({ preventScroll: false }); } catch (e) { /* ignore */ }
    });
  }

  _restoreFocus(scope, prev) {
    if (document.activeElement && scope.contains(document.activeElement)) document.activeElement.blur();
    if (prev && prev.isConnected && prev.focus && prev !== document.body && prev.offsetParent !== null) {
      try { prev.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  // ───────────────────────────── story cards ─────────────────────────────

  /**
   * Coach Rafa's offer after the third win. onAccept() (TourSystem: accepted = true), then the hub
   * opens (openHub: false to skip); onLater() for "Not yet" / Esc.
   */
  showOffer(o = {}) {
    const lines = arr(o.lines).filter(Boolean);
    const words = lines.length ? lines : [
      'Three times now. Nobody beats me three times by luck — I don’t allow it.',
      'You have a real game: good feet, patience, a forehand I would steal. It is wasted on Court 1 after closing.',
      'There is a junior tour. Tournaments at other clubs, proper draws, a ranking. Let me coach you. I sit in your box every match, and I tell you the truth.',
    ];
    const perks = [
      [ICON.map, 'Tournaments at clubs around the region — hard courts, red clay and grass'],
      [ICON.rankings, 'Real draws, a ranking and rivals (Theo Wellington is on it too)'],
      [ICON.clipboard, 'Rafa scouts every opponent and gives you a game plan'],
    ];
    this._enqueue({
      kind: 'offer',
      html: `<div class="ccj-mhead"><div class="cc-label">${esc(o.speaker || 'Coach Rafa Ibarra')}</div>
          <h2 class="cc-title ccj-mtitle" id="ccj-mtitle">${esc(o.title || 'Play for real?')}</h2></div>
        <div class="ccj-quote">${words.map(p => `<p>${esc(p)}</p>`).join('')}</div>
        <div class="ccj-sign">— Rafa</div>
        <ul class="ccj-perks">${perks.map(([icn, t]) => `<li>${icn}<span>${esc(t)}</span></li>`).join('')}</ul>
        <div class="ccj-mbtns"><button type="button" class="cc-btn" data-mact="later">${esc(o.laterLabel || 'Not yet')}</button>
          <button type="button" class="cc-btn ccj-btn--gold" data-mact="accept" data-primary>${esc(o.acceptLabel || 'Yes, coach me')}</button></div>
        <div class="ccj-mnote">${esc(o.note || 'Not ready? Talk to Rafa at the club whenever you are.')}</div>`,
      actions: {
        accept: () => this._finishModal(() => {
          this._call('onFeedback', 'offer', { accepted: true });
          if (typeof o.onAccept === 'function') { try { o.onAccept(); } catch (err) { console.warn('TourUI onAccept:', err); } }
          if (o.openHub !== false && !this.isOpen) this.open({ tab: 'week' });
        }),
        later: () => this._finishModal(() => {
          if (typeof o.onLater === 'function') { try { o.onLater(); } catch (err) { console.warn('TourUI onLater:', err); } }
        }),
      },
      cancel: 'later',
    });
  }

  /**
   * A big career choice (Hank's crossroads). choices: [{ label, desc?, primary? }]; onPick(index, choice).
   * Esc picks `cancel` (an index) when given — never a choice by default.
   */
  showChoice(o = {}, onPick) {
    const choices = arr(o.choices).filter(c => c && c.label);
    if (!choices.length) return;
    const paras = Array.isArray(o.body) ? o.body : String(o.body || '').split(/\n{2,}/);
    const actions = {};
    let btns = '';
    choices.forEach((c, i) => {
      actions['c' + i] = () => this._finishModal(() => { if (typeof onPick === 'function') { try { onPick(i, c); } catch (err) { console.warn('TourUI onPick:', err); } } });
      btns += `<button type="button" class="cc-btn${c.primary ? ' ccj-btn--gold' : ''}" data-mact="c${i}"${c.primary ? ' data-primary' : ''}><b>${esc(c.label)}</b>${c.desc ? `<span>${esc(c.desc)}</span>` : ''}</button>`;
    });
    const cancel = Number.isInteger(o.cancel) && o.cancel >= 0 && o.cancel < choices.length ? 'c' + o.cancel : null;
    this._enqueue({
      kind: 'choice',
      focus: cancel, // a big decision: the keyboard starts on the safe answer, never on a career change
      html: `<div class="ccj-mhead"><div class="cc-label">${esc([o.speaker, o.role].filter(Boolean).join(' · ') || 'A decision')}</div>
          <h2 class="cc-title ccj-mtitle" id="ccj-mtitle">${esc(o.title || 'Your call')}</h2></div>
        <div class="ccj-body-txt">${paras.filter(Boolean).map(p => `<p>${esc(p)}</p>`).join('')}</div>
        <div class="ccj-choices" role="group" aria-label="Choices">${btns}</div>`,
      actions,
      cancel,
    });
  }

  /**
   * The card after a tour match. result: { tournamentName, roundLabel, won, score, opponent, pointsGained,
   * prizeGained, next, champion, rank, rankDelta }. cb: onClose, or { onClose, hubButton = true }.
   */
  showTournamentResult(r = {}, cb) {
    const onClose = typeof cb === 'function' ? cb : cb && cb.onClose;
    const hubButton = !(cb && typeof cb === 'object' && cb.hubButton === false);
    const round = r.roundLabel || '';
    const champ = !!r.champion || (r.won && round === 'F');
    const lostFinal = !r.won && round === 'F';
    const opp = fullNameOf(r.opponent, '');
    let label = r.tournamentName || 'Junior Tour';
    let title, art;
    if (champ) { title = 'Champion!'; art = `<div class="ccj-res__glow"></div>${trophyArt()}${this._sparks()}`; }
    else if (r.won) { title = `Through to the ${this._nextRoundName(r).toLowerCase()}!`; art = ballArt; }
    else if (lostFinal) { title = 'Runner-up'; art = ballArt; }
    else { title = `Out in the ${roundLong(round).toLowerCase()}`; art = ballArt; }
    if (round) label += ` · ${roundLong(round)}`;
    const chips = [];
    if (isNum(r.pointsGained) && r.pointsGained > 0) chips.push(`<div class="ccj-res__chip"><b>+${num(r.pointsGained)}</b>ranking pts</div>`);
    if (isNum(r.prizeGained) && r.prizeGained > 0) chips.push(`<div class="ccj-res__chip"><b>+${money(r.prizeGained)}</b>prize money</div>`);
    if (isNum(r.rank)) {
      const d = isNum(r.rankDelta) ? r.rankDelta : 0;
      const delta = d > 0 ? `<small class="is-up">▲${d}</small>` : d < 0 ? `<small class="is-down">▼${-d}</small>` : '';
      chips.push(`<div class="ccj-res__chip"><b>#${r.rank}${delta}</b>ranking</div>`);
    }
    const next = r.won && !champ ? this._nextText(r.next) : '';
    const words = champ ? 'What a week. Rafa is already talking about next week.'
      : r.won ? '' : lostFinal ? 'A final is a final. The points are yours — and so is the next one.' : 'Every loss is a lesson. The points you won this week still count.';
    const hub = hubButton && typeof this.opts.getHub === 'function';
    const actions = {
      ok: () => this._finishModal(() => { if (typeof onClose === 'function') { try { onClose(); } catch (err) { console.warn('TourUI result onClose:', err); } } }),
      hub: () => this._finishModal(() => {
        this.open({ tab: 'draw' });
        if (typeof onClose === 'function') { try { onClose(); } catch (err) { console.warn('TourUI result onClose:', err); } }
      }),
    };
    this._enqueue({
      kind: 'result',
      cls: 'ccj-res' + (champ ? ' is-champ' : r.won ? ' is-won' : ' is-lost'),
      feedback: champ ? 'champion' : 'result',
      html: `<div class="ccj-res__art">${art}</div>
        <div class="ccj-mhead"><div class="cc-label">${esc(label)}</div><h2 class="cc-title ccj-mtitle" id="ccj-mtitle">${esc(title)}</h2></div>
        ${r.score ? `<div class="ccj-res__score">${esc(r.score)}</div>` : ''}
        ${opp ? `<div class="ccj-res__opp">${r.won ? 'Beat' : 'Lost to'} ${esc(opp)}${lostFinal || champ ? ' in the final' : ''}</div>` : ''}
        ${chips.length ? `<div class="ccj-res__chips">${chips.join('')}</div>` : ''}
        ${next ? `<div class="ccj-res__next">${esc(next)}</div>` : ''}
        ${words ? `<div class="ccj-note">${esc(words)}</div>` : ''}
        <div class="ccj-mbtns${hub ? '' : ' ccj-mbtns--one'}">${hub ? '<button type="button" class="cc-btn" data-mact="hub">View draw</button>' : ''}
          <button type="button" class="cc-btn ${champ ? 'ccj-btn--gold' : 'cc-btn--primary'}" data-mact="ok" data-primary>Continue</button></div>`,
      actions,
      cancel: 'ok',
    });
  }

  _nextRoundName(r) {
    const n = r.next;
    const k = n && typeof n === 'object' ? (n.roundLabel || n.round) : null;
    if (k) return roundLong(k);
    const order = ['R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F'];
    const i = order.indexOf(r.roundLabel);
    return i >= 0 && i < order.length - 1 ? roundLong(order[i + 1]) : 'next round';
  }

  _nextText(n) {
    if (!n) return '';
    if (typeof n === 'string') return n;
    const bits = [];
    const k = n.roundLabel || n.round;
    bits.push(`Next: ${roundLong(k)}`);
    const wd = weekdayOf(n.day);
    if (n.when) bits.push(String(n.when));
    else if (wd >= 0) bits.push(`${WD_LONG[wd]} evening`);
    const opp = n.opponent ? nameOf(n.opponent, '') : '';
    return bits.join(' · ') + (opp ? ` vs ${opp}` : ' — opponent to be decided');
  }

  _sparks() {
    const pos = [[16, 30, 0], [80, 22, 0.5], [28, 70, 1.1], [74, 64, 1.6], [50, 12, 0.8], [8, 52, 2], [90, 46, 1.3]];
    return pos.map(([x, y, d]) => `<i class="ccj-spark" style="left:${x}%;top:${y}%;animation-delay:${d}s" aria-hidden="true"></i>`).join('');
  }

  closeModal() {
    if (this._modal && this._modal.cancel) this._modal.cancel();
  }

  _enqueue(m) {
    const cancelKey = m.cancel;
    m.cancel = cancelKey && m.actions[cancelKey] ? m.actions[cancelKey] : null;
    if (this._modal) { this._queue.push(m); return; }
    this._showModal(m);
  }

  _showModal(m) {
    this._modal = m;
    m.lastFocus = document.activeElement;
    this.mcard.className = 'ccj-mcard cc-panel' + (m.cls ? ' ' + m.cls : '');
    this.mcard.innerHTML = m.html;
    this.mcard.scrollTop = 0;
    this.modalEl.classList.add('is-open');
    this.modalEl.setAttribute('aria-hidden', 'false');
    if (this.isOpen) this.overlay.setAttribute('aria-hidden', 'true');
    this._hold('modal');
    if (m.feedback) this._call('onFeedback', m.feedback);
    requestAnimationFrame(() => {
      if (this._modal !== m) return;
      const b = (m.focus && this.mcard.querySelector(`[data-mact="${m.focus}"]`))
        || this.mcard.querySelector('[data-primary]') || this.mcard.querySelector('button');
      if (b) try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    });
  }

  /**
   * Leave the current card: hide it, run `then` (which may open the hub or queue another card —
   * the hold stays up across it, so the game doesn't resume in between), then release.
   */
  _finishModal(then) {
    const m = this._modal;
    if (!m) return;
    this._modal = null;
    this.modalEl.classList.remove('is-open');
    this.modalEl.setAttribute('aria-hidden', 'true');
    if (this.isOpen) this.overlay.setAttribute('aria-hidden', 'false');
    if (document.activeElement && this.modalEl.contains(document.activeElement)) document.activeElement.blur();
    try { if (then) then(); } finally {
      const next = !this._modal && this._queue.length ? this._queue.shift() : null;
      if (next) this._showModal(next);
      if (!this._modal) {
        if (this.isOpen) requestAnimationFrame(() => { if (this.isOpen && !this._modal) this._focusTab(); });
        else this._restoreFocus(this.modalEl, m.lastFocus);
      }
      this._release('modal');
    }
  }

  destroy() {
    window.removeEventListener('keydown', this._onWinKey, true);
    clearTimeout(this._statusTimer);
    this.overlay.remove();
    this.modalEl.remove();
    this.defsEl.remove();
  }
}
