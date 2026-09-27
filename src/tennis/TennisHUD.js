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
 *
 * The swing meter (swingMeter / swingResult) is a Top Spin-style load arc beside the player: while
 * SWING is held the fill sweeps round a 250° gauge (gold → orange → red as the load builds, red
 * hazard stripes past the full-power mark), a green band marks the release window and a white tick
 * the perfect moment. It sits on the side away from the stroke (the ball comes in on the stroke side), is
 * clamped on screen, and every per-frame call writes only what changed (fill dash offset, knob
 * rotation, position). easyCue shows Easy-mode "Load / Swing! / Toss" prompts above it,
 * contactReadout a short card after each hit (where the ball met the strings and which side of the
 * ball), umpire a chair umpire's call under the scoreboard; setNames / setTourButton serve the tour.
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
.cct-rally { position: absolute; right: 10px; bottom: -13px; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 700;
  letter-spacing: 0.6px; background: var(--cc-gold); color: #3a2608; box-shadow: 0 3px 10px rgba(0,0,0,0.35); opacity: 0; transform: scale(0.8);
  transition: opacity 0.2s ease, transform 0.2s ease; pointer-events: none; font-variant-numeric: tabular-nums; }
.cct-rally.is-on { opacity: 1; transform: none; }
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
.cct-hint__s { display: none; }

.cct-coach {
  position: absolute; left: 50%; top: calc(var(--cc-safe-top) + 12px); transform: translateX(-50%);
  max-width: min(420px, calc(100vw - 200px)); padding: 7px 12px; border-radius: 14px; font-size: 13.5px;
  background: rgba(255, 253, 246, 0.94); color: #21452F; border: 2px solid var(--cc-green-700); font-weight: 600;
  box-shadow: 0 6px 16px rgba(0,0,0,0.3); opacity: 0; transition: opacity 0.25s ease; pointer-events: none; text-align: center;
}
.cct-coach b { color: var(--cc-clay); margin-right: 4px; }
.cct-coach.is-on { opacity: 1; }
@media (max-width: 560px) { .cct-coach { top: calc(var(--cc-safe-top) + 132px); max-width: calc(100vw - 32px); } } /* under the scoreboard: the sky, not the court */
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
.cct-seg button small { display: block; font-size: 10.5px; font-weight: 400; opacity: 0.75; margin-top: 1px; }
.cct-seg button:disabled { opacity: 0.4; }
.cct-surf { font-size: 12px; color: var(--cc-cream-dim); line-height: 1.4; min-height: 2.8em; }
.cct-surf b { color: var(--cc-cream); }
.cct-wind { display: none; align-items: center; gap: 6px; font-size: 11px; color: var(--cc-cream-dim); margin-top: 4px; }
.cct-wind.is-on { display: flex; }
.cct-wind__arr { display: inline-block; width: 18px; height: 18px; line-height: 18px; text-align: center; font-size: 15px; color: #bfe9ff; transition: transform 0.4s ease; }
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
  /* Narrow phones: the shot row clears the joystick; the serve hint sits above it */
  .cct-shots { bottom: calc(var(--cc-safe-bottom) + 164px); }
  .cct-hint { bottom: calc(var(--cc-safe-bottom) + 216px); white-space: nowrap; }
  .cct-hint__l { display: none; }
  .cct-hint__s { display: inline; }
}
@media (max-height: 520px) {
  .cct-shots { bottom: calc(var(--cc-safe-bottom) + 24px); right: calc(var(--cc-safe-right) + 160px); flex-direction: column; }
  .cct-meter { right: calc(var(--cc-safe-right) + 244px); }
  /* the serve hint goes under the scoreboard (the shot column fills the right side) */
  .cct-hint { bottom: auto; top: calc(var(--cc-safe-top) + 132px); right: auto; left: calc(var(--cc-safe-left) + 10px); text-align: left; max-width: 44vw; }
  .cct-pops { top: 16%; }
}
@media (prefers-reduced-motion: reduce) { .cct-pop.is-go { animation-duration: 0.01s; opacity: 1; } .cct-modal.is-on { animation: none; } }
`;

// Swing meter, Easy cues, contact readout, chair umpire, tour button
const CSS_SWING = `
.cct-probe { position: absolute; left: 0; top: 0; width: 0; height: 0; visibility: hidden; pointer-events: none;
  padding: var(--cc-safe-top) var(--cc-safe-right) var(--cc-safe-bottom) var(--cc-safe-left); }

.cct-sm { position: absolute; left: 0; top: 0; width: 104px; height: 104px; pointer-events: none;
  opacity: 0; visibility: hidden; will-change: transform, opacity; transition: opacity 0.18s ease, visibility 0s linear 0.18s; }
.cct-sm.is-on { opacity: 1; visibility: visible; transition: opacity 0.08s ease, visibility 0s; }
.cct-sm.is-on.is-slide { transition: opacity 0.08s ease, visibility 0s, transform 0.14s ease-out; }
.cct-sm__in { position: absolute; inset: 0; transform: scale(0.82); transition: transform 0.2s cubic-bezier(0.3, 1.6, 0.5, 1); }
.cct-sm.is-on .cct-sm__in { transform: none; }
.cct-sm__svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.cct-sm .face { fill: url(#cct-sm-face); }
.cct-sm .sh, .cct-sm .rim, .cct-sm .halo, .cct-sm .trk, .cct-sm .ovz, .cct-sm .band, .cct-sm .fill, .cct-sm .fillx { fill: none; }
.cct-sm .sh { stroke: rgba(0, 0, 0, 0.3); stroke-width: 19; stroke-linecap: round; }
.cct-sm .rim { stroke: rgba(255, 246, 220, 0.36); stroke-width: 15; stroke-linecap: round; }
.cct-sm .halo { stroke: #8dffb4; stroke-width: 21; opacity: 0.62; }
.cct-sm .trk { stroke: rgba(13, 28, 19, 0.9); stroke-width: 12; stroke-linecap: round; }
.cct-sm .sc path { fill: none; stroke: rgba(255, 246, 220, 0.5); stroke-width: 1.6; stroke-linecap: round; }
.cct-sm .ovz { stroke: rgba(122, 22, 30, 0.6); stroke-width: 12; }
.cct-sm .band { stroke: #46d983; stroke-width: 12; }
.cct-sm .fill { stroke: #f7cf57; stroke-width: 8.4; }
.cct-sm .fillx { stroke: url(#cct-sm-hz); stroke-width: 8.4; }
.cct-sm .fm { stroke: rgba(255, 246, 220, 0.9); stroke-width: 2.6; stroke-linecap: round; }
.cct-sm.is-full .fm { stroke: #ffd76a; stroke-width: 3.4; }
.cct-sm .be0, .cct-sm .pf0 { fill: none; stroke: rgba(6, 18, 11, 0.88); stroke-width: 5; stroke-linecap: round; }
.cct-sm .be1 { fill: none; stroke: #9dffbf; stroke-width: 2.4; stroke-linecap: round; }
.cct-sm.is-in .be1 { stroke: #fff; }
.cct-sm .pf0 { stroke-width: 5.8; }
.cct-sm .pf1 { fill: none; stroke: #fff; stroke-width: 2.8; stroke-linecap: round; }
.cct-sm .kn0 { fill: #fffaf0; stroke: #13261a; stroke-width: 2.2; }
.cct-sm .kn1 { fill: #d23a2a; opacity: 0; }
.cct-sm.is-in .halo { opacity: 1; stroke: #b4ffcc; }
.cct-sm.is-in .kn0 { fill: #b6ffd0; }
.cct-sm.is-full .kn1 { opacity: 1; }
.cct-sm.is-serve .kn0 { fill: #e1f05a; stroke: #33430b; }
.cct-sm.is-far .halo, .cct-sm.is-far .band, .cct-sm.is-far .pf, .cct-sm.is-far .be { visibility: hidden; }
.cct-sm.is-far .fill { stroke: #8f9892 !important; }
.cct-sm.is-far .fillx { stroke: #6d7470; }
.cct-sm.is-far .ovz { stroke: rgba(60, 64, 62, 0.6); }
.cct-sm.is-far .kn0 { fill: #c9cec9; }
.cct-sm.is-far .rim { stroke: rgba(205, 210, 205, 0.26); }
.cct-sm .ic { opacity: 0; }
.cct-sm .ic .o { fill: none; stroke: rgba(6, 14, 9, 0.7); stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; }
.cct-sm .ic .c { fill: none; stroke-width: 4.6; stroke-linecap: round; stroke-linejoin: round; }
.cct-sm .ic-star .c { fill: #ffd84d; stroke: #6b4500; stroke-width: 2; }
.cct-sm .ic-check .c { stroke: #9dffbf; }
.cct-sm .ic-early .c, .cct-sm .ic-late .c { stroke: #ffc56b; }
.cct-sm .ic-miss .c { stroke: #ff8a7a; }
.cct-sm[data-res="perfect"] .ic-star, .cct-sm[data-res="good"] .ic-check, .cct-sm[data-res="early"] .ic-early,
.cct-sm[data-res="late"] .ic-late, .cct-sm[data-res="miss"] .ic-miss { opacity: 1; }
.cct-sm[data-res="perfect"] .halo { stroke: #ffe27a; opacity: 1; }
.cct-sm[data-res="perfect"] .band { stroke: #ffcf3f; }
.cct-sm[data-res="early"] .halo, .cct-sm[data-res="late"] .halo { stroke: #ffc56b; opacity: 0.8; }
.cct-sm[data-res="miss"] .halo { stroke: #ff7a6a; opacity: 0.8; }
.cct-sm__plate { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%); padding: 2px 9px 3px; border-radius: 99px;
  background: #f4e8c1; color: #1d3a27; border: 1px solid rgba(29, 58, 39, 0.4); box-shadow: 0 2px 7px rgba(0, 0, 0, 0.45);
  font-size: 10px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; line-height: 1.25; white-space: nowrap; }
.cct-sm.is-far .cct-sm__plate { background: #c6cbc5; color: #3b423d; }
.cct-sm[data-res] .cct-sm__plate { font-size: 12px; letter-spacing: 0.2px; text-transform: none; padding: 2px 10px 3px; }
.cct-sm[data-res="perfect"] .cct-sm__plate { background: linear-gradient(180deg, #fff5bd, #ffcf4a); color: #4b3000; border-color: #b8860b; }
.cct-sm[data-res="good"] .cct-sm__plate { background: #c9f5d6; color: #154628; border-color: #3f9c61; }
.cct-sm[data-res="early"] .cct-sm__plate, .cct-sm[data-res="late"] .cct-sm__plate { background: #ffd79a; color: #5a3200; border-color: #c98a1f; }
.cct-sm[data-res="miss"] .cct-sm__plate { background: #ffb4a8; color: #5c140c; border-color: #c0402f; }
.cct-sm__burst { position: absolute; left: 11%; top: 7.7%; width: 78%; height: 78%; border-radius: 50%; border: 3px solid #b4ffcc; opacity: 0; }
.cct-sm[data-res="perfect"] .cct-sm__burst { border-color: #ffe27a; box-shadow: 0 0 16px rgba(255, 214, 90, 0.85), inset 0 0 10px rgba(255, 214, 90, 0.6); }
.cct-sm[data-res="early"] .cct-sm__burst, .cct-sm[data-res="late"] .cct-sm__burst { border-color: #ffc56b; }
.cct-sm[data-res="miss"] .cct-sm__burst { border-color: #ff7a6a; }
.cct-sm.is-res .cct-sm__in { animation: cct-sm-hit 0.45s cubic-bezier(0.2, 1.3, 0.4, 1); }
.cct-sm.is-res .cct-sm__burst { animation: cct-sm-burst 0.5s ease-out forwards; }
@keyframes cct-sm-hit { 0% { transform: scale(1); } 25% { transform: scale(1.13); } 100% { transform: scale(1); } }
@keyframes cct-sm-burst { 0% { opacity: 0.95; transform: scale(0.72); } 100% { opacity: 0; transform: scale(1.5); } }

.cct-cue { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; opacity: 0; visibility: hidden;
  will-change: transform, opacity; transition: opacity 0.22s ease, visibility 0s linear 0.22s; }
.cct-cue.is-on { opacity: 1; visibility: visible; transition: opacity 0.1s ease, visibility 0s; }
.cct-cue__pos { position: absolute; bottom: 0; left: 0; }
.cct-cue.is-l .cct-cue__pos { left: auto; right: 0; }
.cct-cue.is-c .cct-cue__pos { transform: translateX(-50%); }
.cct-cue__pill { display: flex; align-items: center; gap: 7px; padding: 6px 14px 7px 9px; border-radius: 99px; white-space: nowrap;
  background: rgba(19, 38, 27, 0.93); border: 2px solid var(--cc-gold); color: var(--cc-cream);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.42); transform-origin: 50% 100%; animation: cct-cue-pulse 0.7s ease-in-out infinite alternate; }
.cct-cue__pill b { font-family: var(--cc-font-display); font-size: 23px; font-weight: 700; line-height: 1; color: #ffd76a; letter-spacing: 0.3px; }
.cct-cue__pill span { font-size: 11px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase; opacity: 0.92; }
.cct-cue__pill span:empty { display: none; }
.cct-cue__ic { width: 22px; height: 22px; flex: none; }
.cct-cue__ic g { display: none; }
.cct-cue.is-load .ic-load, .cct-cue.is-swing .ic-swing, .cct-cue.is-toss .ic-toss { display: inline; }
.cct-cue.is-swing .cct-cue__pill { background: linear-gradient(180deg, #46c779, #2a8f50); border-color: #d6ffe2; color: #fff;
  animation: cct-cue-go 0.3s cubic-bezier(0.2, 1.8, 0.4, 1); box-shadow: 0 0 0 4px rgba(124, 255, 160, 0.32), 0 6px 16px rgba(0, 0, 0, 0.42); }
.cct-cue.is-swing .cct-cue__pill b { color: #fff; font-size: 27px; }
.cct-cue.is-toss .cct-cue__pill { border-color: #e1f05a; }
.cct-cue:not(.is-on) .cct-cue__pill { animation: none; }
@keyframes cct-cue-pulse { from { transform: scale(1); } to { transform: scale(1.07); } }
@keyframes cct-cue-go { from { transform: scale(0.55); } to { transform: scale(1); } }

.cct-cr { position: absolute; left: calc(var(--cc-safe-left) + 12px); bottom: calc(var(--cc-safe-bottom) + 170px);
  display: flex; align-items: center; gap: 8px; padding: 8px 13px 8px 8px; max-width: 268px; border-radius: 14px;
  background: rgba(17, 33, 24, 0.86); border: 1px solid var(--cc-panel-border); box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
  pointer-events: none; opacity: 0; visibility: hidden; transform: translateY(8px);
  transition: opacity 0.35s ease, transform 0.35s ease, visibility 0s linear 0.35s; }
.cct-cr.is-on { opacity: 1; visibility: visible; transform: none; transition: opacity 0.14s ease, transform 0.14s ease, visibility 0s; }
.cct-cr__rk { width: 40px; height: 63px; flex: none; }
.cct-cr__ball { width: 46px; height: 46px; flex: none; }
.cct-cr__txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cct-cr__q { font-family: var(--cc-font-display); font-size: 15px; font-weight: 700; color: #fff4d2; line-height: 1.15; }
.cct-cr__p { font-size: 11.5px; color: var(--cc-cream); opacity: 0.85; line-height: 1.2; }
.cct-cr__p:empty { display: none; }
.cct-cr__chips { display: flex; gap: 5px; margin-top: 4px; flex-wrap: wrap; }
.cct-cr__chip { display: inline-flex; align-items: center; gap: 4px; font-style: normal; font-size: 10.5px; font-weight: 700; padding: 1px 7px 2px;
  border-radius: 99px; background: rgba(244, 232, 193, 0.1); color: var(--cc-cream); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cct-cr__chip.is-g { background: rgba(76, 175, 106, 0.34); color: #c8f7d6; }
.cct-cr__chip.is-w { background: rgba(232, 179, 60, 0.28); color: #ffe3a6; }
.cct-cr__chip.is-off { display: none; }
.cct-cr__pk { width: 26px; height: 5px; border-radius: 99px; background: rgba(244, 232, 193, 0.2); overflow: hidden; }
.cct-cr__pk i { display: block; width: 100%; height: 100%; background: linear-gradient(90deg, #d9a441, #ffe066); transform-origin: left; }
.cct-cr .rk-face { fill: rgba(244, 232, 193, 0.08); }
.cct-cr .rk-str { stroke: rgba(244, 232, 193, 0.42); stroke-width: 0.7; }
.cct-cr .rk-sweet { fill: rgba(95, 224, 138, 0.2); stroke: rgba(95, 224, 138, 0.8); stroke-width: 0.9; stroke-dasharray: 2 1.6; }
.cct-cr .rk-frm { fill: none; stroke: #e9dcb4; stroke-width: 3.2; }
.cct-cr .rk-thr { fill: none; stroke: #e9dcb4; stroke-width: 2.6; stroke-linecap: round; }
.cct-cr .rk-hdl { fill: #2d5a3d; stroke: #e9dcb4; stroke-width: 1.4; }
.cct-cr .dot0 { fill: rgba(8, 18, 12, 0.9); }
.cct-cr .bl-felt { fill: url(#cct-cr-felt); stroke: rgba(40, 52, 8, 0.55); stroke-width: 1; }
.cct-cr .bl-seam { fill: none; stroke: rgba(255, 255, 255, 0.88); stroke-width: 1.9; stroke-linecap: round; }
.cct-cr .bl-arr0 { fill: none; stroke: rgba(8, 18, 12, 0.72); stroke-width: 4.6; stroke-linecap: round; stroke-linejoin: round; }
.cct-cr .bl-arr { fill: none; stroke: #fff; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.cct-cr .bl-flat { fill: none; stroke: #fff; stroke-width: 1.4; stroke-dasharray: 2.2 2; }
.cct-cr .bdot { fill: var(--cc-clay); stroke: #fff; stroke-width: 1.7; }

.cct-ump { position: absolute; left: calc(var(--cc-safe-left) + 10px); top: var(--cct-ump-top, calc(var(--cc-safe-top) + 152px)); display: flex; align-items: center; gap: 8px; padding: 5px 13px 6px 8px;
  border-radius: 12px; background: rgba(10, 18, 14, 0.92); border: 1px solid rgba(217, 164, 65, 0.6); color: #fff;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.38); pointer-events: none; white-space: nowrap;
  opacity: 0; visibility: hidden; transform: translateY(-4px); transition: opacity 0.22s ease, transform 0.22s ease, visibility 0s linear 0.22s; }
.cct-ump.is-on { opacity: 1; visibility: visible; transform: none; transition: opacity 0.12s ease, transform 0.12s ease, visibility 0s; }
.cct-ump__ic { width: 22px; height: 22px; flex: none; }
.cct-ump small { display: block; font-size: 8.5px; font-weight: 700; letter-spacing: 1.3px; text-transform: uppercase; color: var(--cc-gold); line-height: 1.2; }
.cct-ump__t { display: block; font-family: var(--cc-font-display); font-style: italic; font-weight: 600; font-size: 17px; line-height: 1.15; }

.cct-tour { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 52px; font-size: 15.5px; font-weight: 700;
  background: linear-gradient(135deg, rgba(217, 164, 65, 0.32), rgba(200, 102, 60, 0.24)); border-color: var(--cc-gold); color: #fff4d2; }
.cct-tour:hover { background: linear-gradient(135deg, rgba(217, 164, 65, 0.45), rgba(200, 102, 60, 0.32)); border-color: #ffd76a; }
.cct-tour svg { width: 22px; height: 22px; flex: none; }
.cct-tour.is-hidden { display: none; }
.cct-name { max-width: 10em; overflow: hidden; text-overflow: ellipsis; }

@media (max-width: 560px), (max-height: 520px) {
  .cct-sm { width: 92px; height: 92px; }
  .cct-sm__plate { font-size: 9.5px; padding: 2px 8px 3px; }
  .cct-sm[data-res] .cct-sm__plate { font-size: 11px; }
  .cct-cue__pill b { font-size: 20px; }
  .cct-cue.is-swing .cct-cue__pill b { font-size: 23px; }
}
/* Narrow portrait: the serve hint gives way to the meter; the readout sits between the joystick and
   SWING (below the player), the umpire under the Menu / pause buttons */
@media (max-width: 560px) {
  .cct.has-sm .cct-hint { opacity: 0; }
}
@media (max-width: 560px) and (min-height: 521px) {
  .cct-cr { left: calc(var(--cc-safe-left) + 160px); right: calc(var(--cc-safe-right) + 124px); bottom: calc(var(--cc-safe-bottom) + 16px);
    max-width: none; flex-wrap: wrap; justify-content: center; gap: 3px 6px; padding: 6px 5px 7px; }
  .cct-cr__rk { width: 28px; height: 44px; }
  .cct-cr__ball { width: 34px; height: 34px; }
  .cct-cr__txt { flex-basis: 100%; align-items: center; text-align: center; }
  .cct-cr__q { font-size: 12.5px; }
  .cct-cr__p { font-size: 10.5px; }
  .cct-cr__chips { justify-content: center; margin-top: 2px; }
  .cct-cr__chip.is-pkc { display: none; }
  .cct-ump { left: auto; top: calc(var(--cc-safe-top) + 64px); right: calc(var(--cc-safe-right) + 12px);
    max-width: calc(100vw - 254px); white-space: normal; padding: 5px 10px 6px 7px; }
  .cct-ump__t { font-size: 15px; }
}
/* Short landscape phones: the readout goes over the joystick, the umpire next to the scoreboard (the sky) */
@media (max-height: 520px) {
  .cct-cr { bottom: calc(var(--cc-safe-bottom) + 160px); padding: 5px 11px 5px 6px; gap: 6px; max-width: 240px; }
  .cct-cr__rk { width: 28px; height: 44px; }
  .cct-cr__ball { width: 34px; height: 34px; }
  .cct-cr__q { font-size: 13px; }
  .cct-cr__p { font-size: 10.5px; }
  .cct-cr__chips { margin-top: 2px; }
  .cct-ump { top: calc(var(--cc-safe-top) + 10px); left: calc(var(--cc-safe-left) + 246px); }
}
@media (prefers-reduced-motion: reduce) {
  .cct-cue__pill, .cct-cue.is-swing .cct-cue__pill, .cct-sm.is-res .cct-sm__in { animation: none; }
  .cct-sm.is-res .cct-sm__burst { animation-duration: 0.01s; }
}
`;

let injected = false;
function injectCSS() {
  if (injected) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'cc-tennis-style';
  s.textContent = CSS + CSS_SWING;
  document.head.appendChild(s);
}

const SHOT_NAMES = [['Flat', '1'], ['Topspin', '2'], ['Slice', '3'], ['Lob', '4'], ['Drop', '5']];
// Surface: [name, what it does to the game]
const SURFACE_NOTES = {
  hard: ['Hard court', 'True, medium-fast bounce: every shot works. Topspin kicks up, a slice stays low.'],
  clay: ['Red clay', 'Slow and high: heavy topspin jumps over the shoulder, slices check up, drop shots die. Long rallies — slide into the wide ones. Every bounce leaves a mark.'],
  grass: ['Grass', 'Fast and low: slices skid through, flat balls fly, the kick stays down. Big serves and coming in pay off.'],
};
const METER_MAX = 1.3, METER_ZONE = [0.9, 1.06]; // serve meter: 1 = the ideal release
const RING_R = 55, RING_C = 2 * Math.PI * RING_R;

// ── Swing meter geometry (SVG viewBox 120 × 120). Meter units: 0 = SWING pressed, 1 = full power,
// up to SM_MAX (held past full). They map linearly onto a 250° arc, open at the bottom.
const SM_CX = 60, SM_CY = 56, SM_R = 43, SM_SWEEP = 250, SM_MAX = 1.25;
const SM_DPU = SM_SWEEP / SM_MAX;   // arc degrees per meter unit
const SM_A0 = -SM_SWEEP / 2;        // start angle (degrees from 12 o'clock, clockwise)
const SM_Q = 400;                   // quantisation: 1/400 unit (0.5° of arc) per DOM write
const SM_STROKES = { forehand: 'Forehand', backhand: 'Backhand', volley: 'Volley', volley_fh: 'Volley', volley_bh: 'Volley', smash: 'Smash', serve: 'Serve' };
const SM_KINDS = { perfect: 1, good: 1, early: 1, late: 1, miss: 1 };
const SM_FREEZE_MS = 520;           // swingResult holds the meter this long
const CUE_FADE_MS = 600;            // an Easy cue fades this long after its last call
const CR_SHOW_MS = 1600;            // the contact readout's time on screen
const UMP_SHOW_S = 1.4;

function lerpRgb(stops, t) {
  let i = 1;
  while (i < stops.length - 1 && t > stops[i][0]) i++;
  const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
  const k = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`;
}
// Fill colour by load, gold → orange → red: 17 prebuilt strings, so a per-frame change allocates nothing
const SM_FILL = Array.from({ length: 17 }, (_, i) => lerpRgb([
  [0, [247, 207, 87]], [0.5, [245, 160, 56]], [0.8, [238, 108, 44]], [1, [226, 56, 42]],
], i / 16));
// Contact dot on the racket: sweet spot → yellow → orange → frame
const CR_DOT = ['#5fe08a', '#ffd84d', '#ff9c3a', '#ff5a47'];

function smAng(u) { return SM_A0 + u * SM_DPU; }
function smPt(u, r) {
  const a = (smAng(u) * Math.PI) / 180;
  return [SM_CX + r * Math.sin(a), SM_CY - r * Math.cos(a)];
}
/** SVG path of the meter arc from unit u0 to u1 (radius r). */
function smArc(u0, u1, r = SM_R) {
  const p0 = smPt(u0, r), p1 = smPt(u1, r);
  const large = (u1 - u0) * SM_DPU > 180 ? 1 : 0;
  return `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)}A${r} ${r} 0 ${large} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
}

function swingMeterSvg() {
  const all = smArc(0, SM_MAX), main = smArc(0, 1), over = smArc(1, SM_MAX);
  const rot = (u) => `rotate(${smAng(u).toFixed(2)} ${SM_CX} ${SM_CY})`;
  const top = SM_CY - SM_R;
  const glyph = (cls, d) => `<g class="ic ${cls}"><path class="o" d="${d}"/><path class="c" d="${d}"/></g>`;
  // Window edges: short notches just outside the track (visible even when the fill covers the band)
  const edge = `<path class="be0" d="M${SM_CX} ${top - 11.8}v4.6"/><path class="be1" d="M${SM_CX} ${top - 11.8}v4.6"/>`;
  let scale = '';   // quarter marks on the inside of the track
  for (const u of [0.25, 0.5, 0.75]) scale += `<path transform="${rot(u)}" d="M${SM_CX} ${SM_CY - 35.4}v3.2"/>`;
  return `<svg class="cct-sm__svg" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
    <defs><radialGradient id="cct-sm-face" cx="50%" cy="42%" r="54%">
      <stop offset="0" stop-color="#0c1a12" stop-opacity="0.06"/><stop offset="1" stop-color="#0c1a12" stop-opacity="0.34"/>
    </radialGradient>
    <pattern id="cct-sm-hz" patternUnits="userSpaceOnUse" width="5.6" height="5.6" patternTransform="rotate(45)">
      <rect width="5.6" height="5.6" fill="#8e1022"/><rect width="2.8" height="5.6" fill="#ec4a34"/>
    </pattern></defs>
    <circle class="face" cx="${SM_CX}" cy="${SM_CY}" r="36"/>
    <path class="sh" d="${all}" transform="translate(0 1.6)"/>
    <path class="rim" d="${all}"/>
    <g class="sc">${scale}</g>
    <path class="halo" d="${all}" pathLength="1250" stroke-dasharray="0 3000"/>
    <path class="trk" d="${all}"/>
    <path class="ovz" d="${over}"/>
    <path class="band" d="${all}" pathLength="1250" stroke-dasharray="0 3000"/>
    <path class="fill" d="${main}" pathLength="1000" stroke-dasharray="1000 3000" stroke-dashoffset="1000"/>
    <path class="fillx" d="${over}" pathLength="250" stroke-dasharray="250 1000" stroke-dashoffset="250"/>
    <g transform="${rot(1)}"><path class="fm" d="M${SM_CX} ${top - 12}v6.5"/></g>
    <g class="be" opacity="0"><g class="be-a" transform="${rot(0)}">${edge}</g><g class="be-b" transform="${rot(0)}">${edge}</g></g>
    <g class="pf" transform="${rot(0)}" opacity="0"><path class="pf0" d="M${SM_CX} ${top - 9}v18"/><path class="pf1" d="M${SM_CX} ${top - 9}v18"/></g>
    <g class="kn" transform="${rot(0)}"><circle class="kn0" cx="${SM_CX}" cy="${top}" r="7"/><circle class="kn1" cx="${SM_CX}" cy="${top}" r="2.4"/></g>
    <g class="ic ic-star"><path class="c" d="M60 42L63.8 51.8L74.3 52.3L66.1 58.9L68.8 69L60 63.3L51.2 69L53.9 58.9L45.7 52.3L56.2 51.8Z"/></g>
    ${glyph('ic-check', 'M49 56.5L56.5 64L71.5 48')}
    ${glyph('ic-early', 'M62.5 46.5L53 56L62.5 65.5M72 46.5L62.5 56L72 65.5')}
    ${glyph('ic-late', 'M57.5 46.5L67 56L57.5 65.5M48 46.5L57.5 56L48 65.5')}
    ${glyph('ic-miss', 'M51.5 47.5L68.5 64.5M68.5 47.5L51.5 64.5')}
  </svg>`;
}

function racketSvg() {
  // Head: ellipse centre (24, 25), 16.5 across × 21.5 along (a = +1 tip at the top, −1 throat)
  let str = '';
  for (let x = 12.2; x < 36.5; x += 3.4) str += `M${x.toFixed(1)} 2V48`;
  for (let y = 6; y < 45; y += 3.6) str += `M6 ${y.toFixed(1)}H42`;
  return `<svg class="cct-cr__rk" viewBox="0 0 48 76" aria-hidden="true" focusable="false">
    <defs><clipPath id="cct-cr-head"><ellipse cx="24" cy="25" rx="16.5" ry="21.5"/></clipPath></defs>
    <path class="rk-thr" d="M16.5 43.5L22 55M31.5 43.5L26 55"/>
    <rect class="rk-hdl" x="20.8" y="54" width="6.4" height="20" rx="2.6"/>
    <ellipse class="rk-face" cx="24" cy="25" rx="16.5" ry="21.5"/>
    <path class="rk-str" clip-path="url(#cct-cr-head)" d="${str}"/>
    <ellipse class="rk-sweet" cx="24" cy="25" rx="5.8" ry="7.4"/>
    <ellipse class="rk-frm" cx="24" cy="25" rx="16.5" ry="21.5"/>
    <circle class="dot0" cx="24" cy="25" r="4.9"/><circle class="dot" cx="24" cy="25" r="3.5" fill="${CR_DOT[0]}"/>
  </svg>`;
}

function ballSvg() {
  return `<svg class="cct-cr__ball" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <defs><radialGradient id="cct-cr-felt" cx="38%" cy="32%" r="72%">
      <stop offset="0" stop-color="#f6ff9a"/><stop offset="0.55" stop-color="#d6e744"/><stop offset="1" stop-color="#9db21e"/>
    </radialGradient></defs>
    <circle class="bl-felt" cx="24" cy="24" r="17"/>
    <path class="bl-seam" d="M11.2 12.6C19 18.5 19 29.5 11.2 35.4M36.8 12.6C29 18.5 29 29.5 36.8 35.4"/>
    <circle class="bl-flat" cx="24" cy="24" r="6.5"/>
    <path class="bl-arr0" d=""/><path class="bl-arr" d=""/>
    <circle class="bdot" cx="24" cy="24" r="3.6"/>
  </svg>`;
}

const ICON_CHAIR = `<svg class="cct-ump__ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <rect x="7.2" y="1.8" width="9.6" height="5.6" rx="1.6" fill="#d9a441"/><rect x="5.6" y="7.6" width="12.8" height="2.6" rx="1" fill="#d9a441"/>
  <path d="M7.4 10.2L5 22.4M16.6 10.2L19 22.4M6.3 15.2H17.7M5.6 19H18.4" fill="none" stroke="#d9a441" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const ICON_TROPHY = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#ffd76a" d="M7 2.5h10v4.8a5 5 0 0 1-10 0z"/>
  <path fill="none" stroke="#ffd76a" stroke-width="1.8" d="M7.2 4.2H4.2v1.9a3.4 3.4 0 0 0 3.4 3.4M16.8 4.2h3v1.9a3.4 3.4 0 0 1-3.4 3.4"/>
  <path fill="#ffd76a" d="M11 12.2h2v4h-2zM8.2 20.8h7.6l-1-3.9H9.2z"/></svg>`;

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

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
    this._cache = { stam: -1, low: null, ring: -2, now: null, meter: -2, info: '', score: '', pow: -2, full: null, mom: -9, zone: null };
    // Screen layout for the swing meter / cue (re-measured after a resize, never per frame)
    this._lay = { dirty: true, w: 0, h: 0, t: 0, r: 0, b: 0, l: 0, s: 104 };
    this._names = ['You', 'Rafa'];
    this._buildPlay();
    this._buildMenu();
    this._buildResults();
    this._onResize = () => { this._lay.dirty = true; this._cue.w = 0; };
    window.addEventListener('resize', this._onResize);
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
    this.rallyEl = el('div', 'cct-rally', board);
    const st = el('div', 'cct-stam', board);
    el('span', '', st, 'Stamina');
    this.stamBar = el('span', 'cct-stam__bar', st);
    this.stamFill = el('i', '', this.stamBar);
    this.momRow = el('div', 'cct-mom', board);
    el('span', '', this.momRow, 'Momentum');
    this.momBar = el('span', 'cct-mom__bar', this.momRow);
    this.momFill = el('i', '', this.momBar);
    this.momRow.title = 'Momentum: gold = yours, clay = Rafa\'s';
    this.windRow = el('div', 'cct-wind', board);
    this.windArr = el('span', 'cct-wind__arr', this.windRow, '↑');
    this.windTxt = el('span', '', this.windRow, '');
    this.windRow.title = 'Wind: the arrow shows where it blows on your screen';

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
    this.hintLong = el('span', 'cct-hint__l', this.hintEl);
    this.hintShort = el('span', 'cct-hint__s', this.hintEl);

    // Serve meter
    this.meter = el('div', 'cct-meter', play);
    el('div', 'cct-meter__zone', this.meter);
    this.meterFill = el('div', 'cct-meter__fill', this.meter);

    // Swing meter at the player, Easy cues, contact readout, chair umpire
    this._probe = el('div', 'cct-probe', play);
    this.board = board;
    this._buildUmpire(play);
    this._buildReadout(play);
    this._buildSwingMeter(play);
    this._buildCue(play);

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
    if (!on) { this.timing(-1); this.setMeter(-1); this.setPower(-1); this.setServeHint(false); this.setRally(0); this._resetSwingUi(); }
  }

  /** Wind pill: speed (m/s) and the direction on screen (radians, 0 = up the screen, clockwise). */
  setWind(speed, ang) {
    const on = speed >= 0.3;
    const c = this._cache;
    if (c.windOn !== on) { c.windOn = on; this.windRow.classList.toggle('is-on', on); }
    if (!on) return;
    const tenths = Math.round(speed * 10);
    const deg = Math.round((ang * 180) / Math.PI / 10) * 10;
    if (c.windTenths !== tenths) { c.windTenths = tenths; this.windTxt.textContent = `Wind ${(tenths / 10).toFixed(1)} m/s`; }
    if (c.windDeg !== deg) { c.windDeg = deg; this.windArr.style.transform = `rotate(${deg}deg)`; }
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

  setDrillLine(text) { this.drillEl.textContent = text; }

  /** Live rally length badge on the scoreboard (from 5 shots; 0 hides it). */
  setRally(n) {
    const v = n >= 5 ? n : 0;
    if (v === this._cache.rally) return;
    this._cache.rally = v;
    if (v) this.rallyEl.textContent = `Rally ${v}`;
    this.rallyEl.classList.toggle('is-on', v > 0);
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
    if (on) {
      // Full line, and a one-line version for narrow phones (CSS picks)
      this.hintLong.textContent = second
        ? 'Second serve: hold SWING to toss, let go in the green · 2 = safe kick'
        : 'Your serve: hold SWING to toss, let go in the green · 1 flat · 2 kick · 3 slice · stick aims';
      this.hintShort.textContent = second ? '2nd serve: hold, let go in the green' : 'Hold SWING, let go in the green';
    }
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

  /** Scoreboard names (default ['You', 'Rafa']; a tour match shows the opponent's). */
  setNames(names) {
    for (let i = 0; i < 2; i++) {
      const raw = names && names[i] != null ? String(names[i]).trim() : '';
      const n = raw || (i === 0 ? 'You' : 'Rafa');
      if (n === this._names[i]) continue;
      this._names[i] = n;
      this.rows[i].name.textContent = n;
      this.rows[i].name.title = n;
    }
    const a = this._names[0];
    this.momRow.title = `Momentum: gold = ${a === 'You' ? 'yours' : `${a}'s`}, clay = ${this._names[1]}'s`;
  }

  /** Hide every swing aid (meter, cue, readout, umpire): the play UI went away. */
  _resetSwingUi() {
    const m = this._sm;
    if (m.timer) { clearTimeout(m.timer); m.timer = 0; }
    m.frozen = false;
    m.q.on = false;
    this._smApply();
    this._cueHide();
    if (this._cr.timer) clearTimeout(this._cr.timer);
    this._crHide();
    if (this._ump.timer) clearTimeout(this._ump.timer);
    this._umpHide();
  }

  // ─────────────────────── swing meter (Top Spin-style load arc) ───────────────────────

  _buildSwingMeter(play) {
    const w = el('div', 'cct-sm', play);
    w.setAttribute('aria-hidden', 'true');
    w.innerHTML = `<div class="cct-sm__in"><div class="cct-sm__burst"></div>${swingMeterSvg()}<div class="cct-sm__plate"></div></div>`;
    const q = (s) => w.querySelector(s);
    this._sm = {
      el: w, plate: q('.cct-sm__plate'), halo: q('.halo'), band: q('.band'), fill: q('.fill'), fillx: q('.fillx'), pf: q('.pf'), kn: q('.kn'),
      be: q('.be'), beA: q('.be-a'), beB: q('.be-b'),
      // What the DOM shows now (cached, so a repeated call writes nothing)
      on: false, px: NaN, py: NaN, lx: 0, ly: 0, side: -1, placed: false, head: 0, hx: 0, col: -1, b0: -1, b1: -1, pfq: -1,
      inb: false, far: false, full: false, over: false, serve: false, plateTxt: '', res: '', frozen: false, timer: 0, slideT: 0,
      // The latest request, copied out of the caller's object (which it may reuse every frame)
      q: { on: false, x: NaN, y: NaN, load: 0, head: 0, b0: NaN, b1: NaN, perfect: NaN, full: false, reach: true, stroke: 'forehand', serve: false, side: 0 },
    };
    this._smThawCb = () => this._smThaw();
    this._smSlideEnd = () => { this._sm.slideT = 0; this._sm.el.classList.remove('is-slide'); };
  }

  /**
   * The load arc at the player. Call it every frame while SWING is held (and once with on: false
   * after); only changed values touch the DOM. o = { on, x, y, load, head, band: [b0, b1], perfect,
   * full, reach, stroke, serve, side? }: x, y = the player's feet (CSS px); load = power 0 … 1 (fill
   * colour gold → red); head = the fill head 0 … 1.25 (1 = the full-power mark, beyond it the held
   * overcharge); band / perfect = the release window and its centre in the same units; reach false =
   * grey, no band; stroke 'forehand' | 'backhand' | 'volley' | 'smash' | 'serve'; serve = the toss
   * meter. Optional side −1 / +1 = left / right of the player (default: right of a backhand, else left).
   */
  swingMeter(o) {
    if (!o) return;
    const m = this._sm, q = m.q;
    q.on = !!o.on;
    if (Number.isFinite(o.x) && Number.isFinite(o.y)) { q.x = o.x; q.y = o.y; }
    q.load = Number.isFinite(o.load) ? o.load : 0;
    q.head = Number.isFinite(o.head) ? o.head : 0;
    const b = o.band;
    q.b0 = b && b.length > 1 && b[0] != null ? +b[0] : NaN;
    q.b1 = b && b.length > 1 && b[1] != null ? +b[1] : NaN;
    q.perfect = o.perfect == null ? NaN : +o.perfect;
    q.full = !!o.full;
    q.reach = o.reach !== false;
    q.serve = !!o.serve;
    q.stroke = o.stroke || (q.serve ? 'serve' : 'forehand');
    q.side = o.side === 1 || o.side === -1 ? o.side : 0;
    if (m.frozen) {
      // swingResult holds the meter; only a fresh load (head back near 0) takes over early
      if (q.on && q.head <= 0.08) this._smThaw();
      return;
    }
    this._smApply();
  }

  _smApply() {
    const m = this._sm, q = m.q, w = m.el;
    if (!q.on || !Number.isFinite(q.x)) {
      if (m.on) { m.on = false; w.classList.remove('is-on'); this.root.classList.remove('has-sm'); }
      return;
    }
    if (!m.on && m.res) this._smClearRes();
    // Beside the feet, on the side away from the ball, clamped on screen; a change of wing
    // mid-load glides it across (0.14 s) instead of jumping past the player
    const side = q.side || (q.stroke === 'backhand' || q.stroke === 'volley_bh' ? 1 : -1);
    if (side !== m.side && m.on) {
      w.classList.add('is-slide');
      if (m.slideT) clearTimeout(m.slideT);
      m.slideT = setTimeout(this._smSlideEnd, 170);
    }
    this._smBox(q.x, q.y, side);
    const lx = Math.round(m.lx), ly = Math.round(m.ly);
    if (lx !== m.px || ly !== m.py) { m.px = lx; m.py = ly; w.style.transform = `translate3d(${lx}px,${ly}px,0)`; }
    m.side = side;
    m.placed = true;
    const far = !q.reach;
    if (far !== m.far) { m.far = far; w.classList.toggle('is-far', far); }
    if (q.full !== m.full) { m.full = q.full; w.classList.toggle('is-full', q.full); }
    if (q.serve !== m.serve) { m.serve = q.serve; w.classList.toggle('is-serve', q.serve); }
    if (!m.res) this._smPlate(far ? 'Out of reach' : SM_STROKES[q.stroke] || q.stroke);
    // Fill head: the fill up to 1, the overcharge past it, the knob
    const hq = Math.round(clamp(q.head, 0, SM_MAX) * SM_Q);
    if (hq !== m.head) {
      m.head = hq;
      const h = hq / SM_Q;
      m.fill.setAttribute('stroke-dashoffset', ((1 - Math.min(1, h)) * 1000).toFixed(1));
      const hx = Math.max(0, hq - SM_Q);
      if (hx !== m.hx) { m.hx = hx; m.fillx.setAttribute('stroke-dashoffset', (250 - (hx / SM_Q) * 1000).toFixed(1)); }
      m.kn.setAttribute('transform', `rotate(${smAng(h).toFixed(2)} ${SM_CX} ${SM_CY})`);
      const over = hq > SM_Q;
      if (over !== m.over) { m.over = over; w.classList.toggle('is-over', over); }
    }
    const col = Math.round(clamp(q.load, 0, 1) * 16);
    if (col !== m.col) { m.col = col; m.fill.style.stroke = SM_FILL[col]; }
    // Release window and the perfect tick (NaN compares false: no band)
    const bandOk = q.reach && q.b1 > q.b0 && q.b0 < SM_MAX && q.b1 > 0;
    const b0 = bandOk ? Math.round(Math.max(0, q.b0) * SM_Q) : -1;
    const b1 = bandOk ? Math.round(Math.min(SM_MAX, q.b1) * SM_Q) : -1;
    if (b0 !== m.b0 || b1 !== m.b1) {
      if ((b0 < 0) !== (m.b0 < 0)) m.be.setAttribute('opacity', b0 < 0 ? '0' : '1');
      if (b0 >= 0 && b0 !== m.b0) m.beA.setAttribute('transform', `rotate(${smAng(b0 / SM_Q).toFixed(2)} ${SM_CX} ${SM_CY})`);
      if (b1 >= 0 && b1 !== m.b1) m.beB.setAttribute('transform', `rotate(${smAng(b1 / SM_Q).toFixed(2)} ${SM_CX} ${SM_CY})`);
      m.b0 = b0; m.b1 = b1;
      const dash = b0 < 0 ? '0 3000' : `${(((b1 - b0) / SM_Q) * 1000).toFixed(1)} 3000`;
      const off = b0 < 0 ? '0' : ((-b0 / SM_Q) * 1000).toFixed(1);
      m.band.setAttribute('stroke-dasharray', dash); m.band.setAttribute('stroke-dashoffset', off);
      m.halo.setAttribute('stroke-dasharray', dash); m.halo.setAttribute('stroke-dashoffset', off);
    }
    const pq = bandOk && q.perfect >= 0 && q.perfect <= SM_MAX ? Math.round(q.perfect * SM_Q) : -1;
    if (pq !== m.pfq) {
      if ((pq < 0) !== (m.pfq < 0)) m.pf.setAttribute('opacity', pq < 0 ? '0' : '1');
      m.pfq = pq;
      if (pq >= 0) m.pf.setAttribute('transform', `rotate(${smAng(pq / SM_Q).toFixed(2)} ${SM_CX} ${SM_CY})`);
    }
    const inb = b0 >= 0 && hq >= b0 && hq <= b1;
    if (inb !== m.inb) { m.inb = inb; w.classList.toggle('is-in', inb); }
    if (!m.on) { m.on = true; w.classList.add('is-on'); this.root.classList.add('has-sm'); }
  }

  /** Screen metrics (viewport, safe-area insets, meter size): measured after a resize only. */
  _layout() {
    const L = this._lay;
    if (L.dirty) {
      L.w = window.innerWidth; L.h = window.innerHeight;
      const s = this._sm.el.offsetWidth;
      if (s > 0) {
        L.s = s;
        const cs = getComputedStyle(this._probe);
        L.t = parseFloat(cs.paddingTop) || 0; L.r = parseFloat(cs.paddingRight) || 0;
        L.b = parseFloat(cs.paddingBottom) || 0; L.l = parseFloat(cs.paddingLeft) || 0;
        L.dirty = false;
      }
    }
    return L;
  }

  /** The meter box (top-left, CSS px) for feet at (x, y): beside the player, on screen. Sets m.lx / m.ly. */
  _smBox(x, y, side) {
    const L = this._layout(), m = this._sm, S = L.s, gap = S >= 100 ? 20 : 15;
    const lx = side > 0 ? x + gap : x - gap - S;
    m.lx = clamp(lx, L.l + 6, Math.max(L.l + 6, L.w - L.r - 6 - S));
    m.ly = clamp(y - S + 14, L.t + 6, Math.max(L.t + 6, L.h - L.b - 6 - S));
  }

  _smPlate(text) {
    const m = this._sm;
    if (text !== m.plateTxt) { m.plateTxt = text; m.plate.textContent = text; }
  }

  /**
   * The swing was released: hold the meter where it stopped for ~0.5 s and flash the verdict on it.
   * kind 'perfect' | 'good' | 'early' | 'late' | 'miss'; label e.g. "Perfect!", "Early · 18 ms".
   */
  swingResult(label, kind) {
    const m = this._sm, w = m.el, q = m.q;
    const k = SM_KINDS[kind] ? kind : 'good';
    this._cueHide();   // the swing is gone: no "Swing!" lingering over the verdict
    if (!m.on) {
      if (!Number.isFinite(q.x)) return;   // never placed: nowhere to show it
      this._smBox(q.x, q.y, m.side);
      m.px = Math.round(m.lx); m.py = Math.round(m.ly);
      w.style.transform = `translate3d(${m.px}px,${m.py}px,0)`;
      m.on = true; w.classList.add('is-on'); this.root.classList.add('has-sm');
    }
    if (m.timer) clearTimeout(m.timer);
    m.frozen = true;
    m.timer = setTimeout(this._smThawCb, SM_FREEZE_MS);
    m.res = k;
    w.setAttribute('data-res', k);
    w.classList.remove('is-res');
    void w.offsetWidth;   // restart the flash
    w.classList.add('is-res');
    this._smPlate(label ? String(label) : '');
  }

  _smThaw() {
    const m = this._sm;
    if (m.timer) { clearTimeout(m.timer); m.timer = 0; }
    m.frozen = false;
    if (m.q.on) this._smClearRes();   // a new load: straight back to the live meter
    this._smApply();                  // else it fades out with the verdict still on it
  }

  _smClearRes() {
    const m = this._sm;
    if (!m.res) return;
    m.res = '';
    m.el.removeAttribute('data-res');
    m.el.classList.remove('is-res');
  }

  // ─────────────────────── Easy cues ───────────────────────

  _buildCue(play) {
    const c = el('div', 'cct-cue is-l', play);
    c.setAttribute('aria-hidden', 'true');
    c.innerHTML = `<div class="cct-cue__pos"><div class="cct-cue__pill"><svg class="cct-cue__ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g class="ic-load"><circle cx="12" cy="12" r="8.4" fill="none" stroke="rgba(255,215,106,0.32)" stroke-width="3.4"/><path d="M12 3.6A8.4 8.4 0 0 1 20 14.6" fill="none" stroke="#ffd76a" stroke-width="3.4" stroke-linecap="round"/></g>
      <g class="ic-swing"><path d="M3.5 17C7.5 9.5 14 6 20 6.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M15.8 3.2L20.6 6.6L17 10.8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g>
      <g class="ic-toss"><circle cx="12" cy="16" r="5.2" fill="#e1f05a" stroke="#33430b" stroke-width="1.2"/><path d="M12 9V2.6M8.8 5.6L12 2.4L15.2 5.6" fill="none" stroke="#e1f05a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g>
    </svg><b></b><span></span></div></div>`;
    this._cue = {
      el: c, pill: c.querySelector('.cct-cue__pill'), b: c.querySelector('b'), s: c.querySelector('.cct-cue__pill span'),
      kind: null, stroke: null, on: false, last: 0, timer: 0, w: 0, h: 0, ax: NaN, ay: NaN, al: 'l',
    };
    // One pending timer at most: it re-arms itself while calls keep coming
    this._cueCheck = () => {
      const k = this._cue;
      k.timer = 0;
      const left = CUE_FADE_MS - (performance.now() - k.last);
      if (left > 16) k.timer = setTimeout(this._cueCheck, left);
      else this._cueHide();
    };
  }

  /**
   * Easy mode: when to start the swing. kind 'load' (start holding SWING now; the stroke is named),
   * 'swing' (let go now), 'toss' (serve: start the toss), null hides. Call it every frame the cue
   * applies; it fades 0.6 s after the last call. It sits above the swing meter, or above where the
   * meter will appear (optional x, y = the feet; else the last swingMeter position).
   */
  easyCue(kind, stroke, x, y) {
    const c = this._cue;
    if (kind !== 'load' && kind !== 'swing' && kind !== 'toss') { this._cueHide(); return; }
    c.last = performance.now();
    const st = stroke || (kind === 'toss' ? 'serve' : '');
    if (kind !== c.kind || st !== c.stroke) {
      if (kind !== c.kind) {
        if (c.kind) c.el.classList.remove(`is-${c.kind}`);
        c.el.classList.add(`is-${kind}`);
      }
      c.kind = kind; c.stroke = st;
      c.b.textContent = kind === 'swing' ? 'Swing!' : kind === 'toss' ? 'Toss' : 'Load';
      c.s.textContent = kind === 'swing' ? '' : SM_STROKES[st] || st;
      c.w = 0;
    }
    this._cuePlace(x, y);
    if (!c.on) { c.on = true; c.el.classList.add('is-on'); }
    if (!c.timer) c.timer = setTimeout(this._cueCheck, CUE_FADE_MS);
  }

  _cueHide() {
    const c = this._cue;
    if (c.timer) { clearTimeout(c.timer); c.timer = 0; }
    if (c.on) { c.on = false; c.el.classList.remove('is-on'); }
  }

  /** Above the meter, flush with its outer edge (so it never covers the player). */
  _cuePlace(x, y) {
    const c = this._cue, m = this._sm, L = this._layout();
    let ax, ay, al;
    if (m.on) {
      al = m.side > 0 ? 'r' : 'l';
      ax = m.side > 0 ? m.px : m.px + L.s;
      ay = m.py - 2;
    } else {
      const fx = Number.isFinite(x) ? x : m.q.x, fy = Number.isFinite(y) ? y : m.q.y;
      if (Number.isFinite(fx) && Number.isFinite(fy)) {
        const side = c.stroke === 'backhand' || c.stroke === 'volley_bh' ? 1 : -1;
        this._smBox(fx, fy, side);
        al = side > 0 ? 'r' : 'l';
        ax = side > 0 ? m.lx : m.lx + L.s;
        ay = m.ly - 2;
      } else {
        al = 'c'; ax = L.w / 2; ay = L.h * 0.6;
      }
    }
    if (!c.w) { c.w = c.pill.offsetWidth || 150; c.h = c.pill.offsetHeight || 40; }
    const lo = L.l + 6, hi = L.w - L.r - 6;
    if (al === 'l') ax = clamp(ax, lo + c.w, Math.max(lo + c.w, hi));
    else if (al === 'r') ax = clamp(ax, lo, Math.max(lo, hi - c.w));
    else ax = clamp(ax, lo + c.w / 2, Math.max(lo + c.w / 2, hi - c.w / 2));
    ay = Math.round(clamp(ay, L.t + 6 + c.h, Math.max(L.t + 6 + c.h, L.h - L.b - 6)));
    ax = Math.round(ax);
    if (al !== c.al) { c.el.classList.remove(`is-${c.al}`); c.el.classList.add(`is-${al}`); c.al = al; }
    if (ax !== c.ax || ay !== c.ay) { c.ax = ax; c.ay = ay; c.el.style.transform = `translate3d(${ax}px,${ay}px,0)`; }
  }

  // ─────────────────────── contact readout ───────────────────────

  _buildReadout(play) {
    const r = el('div', 'cct-cr', play);
    r.setAttribute('aria-hidden', 'true');
    r.innerHTML = `${racketSvg()}${ballSvg()}<div class="cct-cr__txt"><b class="cct-cr__q"></b><span class="cct-cr__p"></span>
      <span class="cct-cr__chips"><i class="cct-cr__chip is-t is-off"></i><i class="cct-cr__chip is-pkc is-off"><span class="cct-cr__pk"><i></i></span>Peak</i></span></div>`;
    const q = (s) => r.querySelector(s);
    this._cr = {
      el: r, dot: q('.dot'), dot0: q('.dot0'), bdot: q('.bdot'), arr: q('.bl-arr'), arr0: q('.bl-arr0'), flatEl: q('.bl-flat'),
      qEl: q('.cct-cr__q'), pEl: q('.cct-cr__p'), tEl: q('.is-t'), pkEl: q('.is-pkc'), pkFill: q('.cct-cr__pk i'),
      on: false, timer: 0, label: null, rx: 24, ry: 25, col: 0, bx: 24, by: 24, flatOn: true, tSt: 'off', tTxt: '', pk: -1,
    };
    this._crHide = () => { const k = this._cr; k.timer = 0; if (k.on) { k.on = false; k.el.classList.remove('is-on'); } };
  }

  /**
   * After each hit: where the ball met the strings (a −1 throat … +1 tip, b −1 … +1 across; green =
   * sweet spot → red = the frame) and where the racket met the ball (sx −1 its left side … +1 right,
   * sy −1 under … +1 over; the arrow shows where that sends it), the line `label` ("Sweet spot · At
   * the peak"), the timing error e (s, green = inside the window) and the peak quality (0 … 1).
   * Fades after ~1.6 s.
   */
  contactReadout(o) {
    if (!o) return;
    const c = this._cr;
    // Racket: the impact dot (clamped onto the frame)
    let a = Number.isFinite(o.a) ? o.a : 0, b = Number.isFinite(o.b) ? o.b : 0;
    const off = Math.hypot(a, b);
    if (off > 1) { a /= off; b /= off; }
    const rx = Math.round((24 + b * 16.5) * 10) / 10, ry = Math.round((25 - a * 21.5) * 10) / 10;
    if (rx !== c.rx || ry !== c.ry) {
      c.rx = rx; c.ry = ry;
      c.dot.setAttribute('cx', rx); c.dot.setAttribute('cy', ry);
      c.dot0.setAttribute('cx', rx); c.dot0.setAttribute('cy', ry);
    }
    const col = off <= 0.3 ? 0 : off <= 0.6 ? 1 : off <= 0.88 ? 2 : 3;
    if (col !== c.col) { c.col = col; c.dot.setAttribute('fill', CR_DOT[col]); }
    // Ball: the contact point, and an arrow away from it (hit its left side → it goes right)
    let sx = Number.isFinite(o.sx) ? o.sx : 0, sy = Number.isFinite(o.sy) ? o.sy : 0;
    const sm = Math.hypot(sx, sy);
    if (sm > 1) { sx /= sm; sy /= sm; }
    const bx = Math.round((24 + sx * 13) * 10) / 10, by = Math.round((24 - sy * 13) * 10) / 10;
    if (bx !== c.bx || by !== c.by) {
      c.bx = bx; c.by = by;
      c.bdot.setAttribute('cx', bx); c.bdot.setAttribute('cy', by);
      let d = '';
      if (sm >= 0.12) {
        const n = Math.min(1, sm), ux = -sx / sm, uy = sy / sm, len = 8 + 8 * n;
        const ex = 24 + ux * len, ey = 24 + uy * len;
        const h1x = ex - (ux * 0.866 - uy * 0.5) * 5, h1y = ey - (ux * 0.5 + uy * 0.866) * 5;
        const h2x = ex - (ux * 0.866 + uy * 0.5) * 5, h2y = ey - (uy * 0.866 - ux * 0.5) * 5;
        const f = (v) => v.toFixed(1);
        d = `M24 24L${f(ex)} ${f(ey)}M${f(h1x)} ${f(h1y)}L${f(ex)} ${f(ey)}L${f(h2x)} ${f(h2y)}`;
      }
      c.arr.setAttribute('d', d); c.arr0.setAttribute('d', d);
      const flat = !d;   // a clean hit through the middle: a ring instead of an arrow
      if (flat !== c.flatOn) { c.flatOn = flat; c.flatEl.setAttribute('opacity', flat ? '1' : '0'); }
    }
    // The line: "Quality · where on the bounce"
    const label = o.label == null ? '' : String(o.label);
    if (label !== c.label) {
      c.label = label;
      const i = label.indexOf(' · ');
      c.qEl.textContent = i < 0 ? label : label.slice(0, i);
      c.pEl.textContent = i < 0 ? '' : label.slice(i + 3);
    }
    // Timing chip (green inside the window) and the peak bar
    let tSt = 'off';
    if (Number.isFinite(o.e)) {
      const ms = Math.round(Math.abs(o.e) * 1000);
      const txt = ms < 3 ? 'On time' : `${o.e < 0 ? 'Early' : 'Late'} ${ms} ms`;
      if (txt !== c.tTxt) { c.tTxt = txt; c.tEl.textContent = txt; }
      tSt = o.green ? 'g' : 'w';
    }
    if (tSt !== c.tSt) { c.tSt = tSt; c.tEl.className = `cct-cr__chip is-t is-${tSt}`; }
    const pk = Number.isFinite(o.peak) ? Math.round(clamp(o.peak, 0, 1) * 20) : -1;
    if (pk !== c.pk) {
      if ((pk < 0) !== (c.pk < 0)) c.pkEl.classList.toggle('is-off', pk < 0);
      c.pk = pk;
      if (pk >= 0) c.pkFill.style.transform = `scaleX(${pk / 20})`;
    }
    if (!c.on) { c.on = true; c.el.classList.add('is-on'); }
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(this._crHide, CR_SHOW_MS);
  }

  // ─────────────────────── chair umpire ───────────────────────

  _buildUmpire(play) {
    const u = el('div', 'cct-ump', play);
    u.setAttribute('role', 'status');
    u.setAttribute('aria-live', 'polite');
    u.innerHTML = `${ICON_CHAIR}<div><small>Umpire</small><span class="cct-ump__t"></span></div>`;
    this._ump = { el: u, t: u.querySelector('.cct-ump__t'), on: false, timer: 0, text: '', top: NaN };
    this._umpHide = () => { const k = this._ump; k.timer = 0; if (k.on) { k.on = false; k.el.classList.remove('is-on'); } };
  }

  /** The chair umpire's call (tour matches): a pill under the scoreboard for ~1.4 s (sec); falsy text hides it. */
  umpire(text, sec = UMP_SHOW_S) {
    const u = this._ump;
    if (u.timer) { clearTimeout(u.timer); u.timer = 0; }
    if (!text) { this._umpHide(); return; }
    const s = String(text);
    if (s !== u.text) { u.text = s; u.t.textContent = s; }
    // Under the scoreboard, whose height depends on the rows shown (small screens: CSS places it)
    const top = Math.round(this.board.offsetTop + this.board.offsetHeight + 20);
    if (top !== u.top) { u.top = top; u.el.style.setProperty('--cct-ump-top', `${top}px`); }
    if (!u.on) { u.on = true; u.el.classList.add('is-on'); }
    u.timer = setTimeout(this._umpHide, Math.max(0.3, +sec || UMP_SHOW_S) * 1000);
  }

  // ─────────────────────────── menu ───────────────────────────

  _buildMenu() {
    const m = el('div', 'cct-modal', this.root);
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', 'After-hours tennis');
    const card = el('div', 'cc-panel cct-card', m);
    card.innerHTML = `
      <div><div class="cc-label" style="color:var(--cc-gold)" data-m="courtline">Court 1 · into the sunset, then under the lights</div>
      <h2 class="cc-title">Evening hit with Coach Rafa</h2>
      <div class="cct-sub">No clock, no members. Just you, Rafa and a basket of balls.</div></div>
      <button type="button" class="cc-btn cct-tour is-hidden" data-m="tour">${ICON_TROPHY}<span data-m="tourlabel">Junior Tour</span><span aria-hidden="true">▸</span></button>
      <div class="cct-sec"><div class="cc-label">Your game</div><div class="cct-stats" data-m="stats"></div><div class="cct-record" data-m="record"></div></div>
      <div class="cct-sec"><div class="cc-label">Court &amp; conditions</div>
        <div class="cct-seg" data-m="surface" role="group" aria-label="Court surface">
          <button type="button" class="cc-btn" data-v="hard">Hard<small>Court 1</small></button>
          <button type="button" class="cc-btn" data-v="clay">Clay<small>Court 5</small></button>
          <button type="button" class="cc-btn" data-v="grass">Grass<small>Centre Court</small></button>
        </div>
        <div class="cct-surf" data-m="surfnote"></div>
        <div class="cct-seg" data-m="wind" role="group" aria-label="Wind">
          <button type="button" class="cc-btn" data-v="calm">Calm</button>
          <button type="button" class="cc-btn" data-v="breeze">Breezy</button>
          <button type="button" class="cc-btn" data-v="gusty">Gusty</button>
        </div>
      </div>
      <div class="cct-sec"><div class="cc-label">Drills (Rafa feeds)</div>
        <div class="cct-grid2">
          <button type="button" class="cc-btn cct-big" data-drill="fh">Forehands</button>
          <button type="button" class="cc-btn cct-big" data-drill="bh">Backhands</button>
          <button type="button" class="cc-btn cct-big" data-drill="volley">Volleys</button>
          <button type="button" class="cc-btn cct-big" data-drill="serve">Serves</button>
          <button type="button" class="cc-btn cct-big" data-drill="rally" style="grid-column: 1 / -1">Rally challenge (keep it going)</button>
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
          <button type="button" class="cc-btn cct-opt" data-o="cues">Swing cues</button>
          <button type="button" class="cc-btn cct-opt" data-o="assist">Auto-move assist</button>
          <button type="button" class="cc-btn cct-opt" data-o="marker">Landing marker</button>
          <button type="button" class="cc-btn cct-opt" data-o="aim">Aim guide</button>
          <button type="button" class="cc-btn cct-opt" data-o="tips">Coach tips</button>
          <button type="button" class="cc-btn cct-opt" data-o="changeEnds">Change ends</button>
          <button type="button" class="cc-btn cct-opt" data-o="trail">Ball trail</button>
        </div>
        <div class="cct-keys">Move: joystick / WASD · Swing: hold SWING / Space / J as the ball comes: the meter at your player fills (gold → red = power); let go while the needle is in the green band — the white line is perfect, and a full load narrows the green · Swing cues: on Easy the game tells you when to load and when to swing · Serve: hold to toss, let go in the green · Shots: buttons or 1–5 (Drop = touch shot, best from the net) · Aim: stick direction at contact (left / right, up = deep, down = short; short + wide = angle) · Spin: topspin dips and kicks up, a slice floats, curves and stays low (backhand curves left, forehand right), the slice serve swings wide, the kick serve jumps · The trail shows the spin: gold topspin, blue slice.</div>
      </div>
      <button type="button" class="cc-btn" data-m="leave" style="min-height:48px">Call it a night ▸ next day</button>`;
    this.menu = m;
    this.mq = {};
    for (const n of card.querySelectorAll('[data-m]')) this.mq[n.dataset.m] = n;
    this._fmt = 'short'; this._diff = 'easy'; this._surf = 'hard'; this._wind = 'calm';
    for (const b of card.querySelectorAll('[data-drill]')) b.addEventListener('click', () => this.cb.onStartDrill && this.cb.onStartDrill(b.dataset.drill));
    const seg = (name, set) => {
      for (const b of this.mq[name].querySelectorAll('button')) {
        b.addEventListener('click', () => { set(b.dataset.v); this._syncSeg(); });
      }
    };
    seg('format', (v) => { this._fmt = v; });
    seg('diff', (v) => { this._diff = v; });
    seg('surface', (v) => { if (!this.cb.onSurface || this.cb.onSurface(v) !== false) this._surf = v; });
    seg('wind', (v) => { this._wind = v; if (this.cb.onWind) this.cb.onWind(v); });
    this.mq.play.addEventListener('click', () => this.cb.onStartMatch && this.cb.onStartMatch(this._fmt, this._diff));
    this.mq.leave.addEventListener('click', () => this.cb.onLeave && this.cb.onLeave());
    this.mq.tour.addEventListener('click', () => this.cb.onTour && this.cb.onTour());
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
    for (const b of this.mq.surface.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === this._surf ? 'true' : 'false');
    for (const b of this.mq.wind.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.v === this._wind ? 'true' : 'false');
    const n = SURFACE_NOTES[this._surf] || SURFACE_NOTES.hard;
    this.mq.surfnote.innerHTML = `<b>${n[0]}</b> ${n[1]}`;
    const ch = this._choices && this._choices.find(c => c.surface === this._surf);
    this.mq.courtline.textContent = `${ch ? ch.label : 'Court 1'} · ${n[0].toLowerCase()} · sunset, then floodlights`;
  }

  /** The menu's "Junior Tour" button (hidden until the tour is unlocked); it calls cb.onTour(). */
  setTourButton(visible, label) {
    this.mq.tour.classList.toggle('is-hidden', !visible);
    if (label) this.mq.tourlabel.textContent = String(label);
  }

  /** The session changed the court / wind itself (not through the menu buttons). */
  setConditions(surface, wind) {
    if (surface) this._surf = surface;
    if (wind) this._wind = wind;
    this._syncSeg();
  }

  showMenu({ opts, last, profile, court, wind } = {}) {
    if (last) { this._fmt = last.format; this._diff = last.diff; }
    if (court) {
      this._surf = court.surface;
      this._choices = court.choices || [];
      for (const b of this.mq.surface.querySelectorAll('button')) {
        const c = this._choices.find(k => k.surface === b.dataset.v);
        b.disabled = !c;
        const sm = b.querySelector('small');
        if (sm && c) sm.textContent = c.label;
      }
    }
    if (wind) this._wind = wind;
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
      <div class="cct-sec"><div class="cc-label" data-r="xpLabel">Practice XP</div><div class="cct-xp" data-r="xp"></div></div>
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

  /**
   * The results card. d: { kind: 'match' | 'drill', title, sub, score, won, stats: [[k, v]], xp, ups,
   * tips, record } plus, for a Junior Tour match: kindLabel (the gold line, e.g. "Harbor Point Open ·
   * Quarter-final"), xpLabel, recordText (instead of the record vs Rafa) and buttons: { again,
   * mode, done } — false hides one, a string relabels it (the tour shows only "Continue").
   */
  showResults(d) {
    const q = this.rq;
    q.kind.textContent = d.kindLabel || (d.kind === 'match' ? 'Practice match' : 'Drill complete');
    q.title.textContent = d.title;
    q.sub.textContent = d.sub || '';
    q.score.textContent = d.score || '';
    const bt = d.buttons || {};
    const btn = (el, v, def) => {
      el.style.display = v === false ? 'none' : '';
      el.textContent = typeof v === 'string' ? v : def;
    };
    btn(q.again, bt.again, d.kind === 'match' ? 'Rematch' : 'Again');
    btn(q.mode, bt.mode, 'Change mode');
    btn(q.done, bt.done, 'Done');
    q.xpLabel.textContent = d.xpLabel || 'Practice XP';
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
    q.record.textContent = d.recordText != null ? String(d.recordText) : r ? `Record vs Rafa: ${r.wins}–${r.losses} · drills done: ${r.drills}` : '';
    this.results.classList.add('is-on');
    this._modal();
    const first = bt.again === false ? (bt.done === false ? q.mode : q.done) : q.again;
    try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  hideResults() { this.results.classList.remove('is-on'); this._blur(this.results); this._modal(); }
}
