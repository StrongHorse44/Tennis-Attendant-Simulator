/**
 * Shared UI theme — design tokens and a few base classes for all DOM UI.
 *
 * Call injectTheme() once (idempotent) before building UI. Components can use
 * the CSS custom properties (var(--cc-*)) in inline styles, or the shared
 * classes (.cc-panel, .cc-btn, ...) directly.
 */

export const THEME = {
  green900: '#173a26',
  green700: '#2d5a3d',
  green500: '#3f7d55',
  cream: '#f4e8c1',
  creamDim: '#c4b896',
  ink: '#1b1f1c',
  gold: '#d9a441',
  clay: '#c8663c',
  blue: '#2f6db3',
  ok: '#4caf6a',
  warn: '#e8b33c',
  danger: '#e05a47',
  panelBg: 'rgba(20, 38, 28, 0.78)',
  panelBorder: 'rgba(244, 232, 193, 0.18)',
  fontDisplay: "'Fraunces', Georgia, 'Times New Roman', serif",
  fontUI: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};

const CSS = `
:root {
  --cc-green-900: ${THEME.green900};
  --cc-green-700: ${THEME.green700};
  --cc-green-500: ${THEME.green500};
  --cc-cream: ${THEME.cream};
  --cc-cream-dim: ${THEME.creamDim};
  --cc-ink: ${THEME.ink};
  --cc-gold: ${THEME.gold};
  --cc-clay: ${THEME.clay};
  --cc-blue: ${THEME.blue};
  --cc-ok: ${THEME.ok};
  --cc-warn: ${THEME.warn};
  --cc-danger: ${THEME.danger};
  --cc-panel-bg: ${THEME.panelBg};
  --cc-panel-border: ${THEME.panelBorder};
  --cc-radius: 14px;
  --cc-radius-sm: 10px;
  --cc-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  --cc-blur: blur(10px);
  --cc-font-display: ${THEME.fontDisplay};
  --cc-font-ui: ${THEME.fontUI};
  --cc-safe-top: env(safe-area-inset-top, 0px);
  --cc-safe-right: env(safe-area-inset-right, 0px);
  --cc-safe-bottom: env(safe-area-inset-bottom, 0px);
  --cc-safe-left: env(safe-area-inset-left, 0px);
}

.cc-panel {
  background: var(--cc-panel-bg);
  border: 1px solid var(--cc-panel-border);
  border-radius: var(--cc-radius);
  box-shadow: var(--cc-shadow);
  backdrop-filter: var(--cc-blur);
  -webkit-backdrop-filter: var(--cc-blur);
  color: var(--cc-cream);
  font-family: var(--cc-font-ui);
}

.cc-title {
  font-family: var(--cc-font-display);
  color: var(--cc-cream);
  letter-spacing: 0.5px;
  font-weight: 600;
}

.cc-label {
  font-family: var(--cc-font-ui);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: var(--cc-cream-dim);
}

.cc-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 10px 18px;
  border-radius: var(--cc-radius-sm);
  border: 1px solid var(--cc-panel-border);
  background: rgba(244, 232, 193, 0.08);
  color: var(--cc-cream);
  font-family: var(--cc-font-ui);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease, border-color 0.15s ease;
  -webkit-tap-highlight-color: transparent;
}
.cc-btn:hover { background: rgba(244, 232, 193, 0.16); border-color: rgba(244, 232, 193, 0.35); }
.cc-btn:active { transform: scale(0.97); }
.cc-btn:focus-visible { outline: 2px solid var(--cc-gold); outline-offset: 2px; }

.cc-btn--primary {
  background: var(--cc-cream);
  color: var(--cc-green-900);
  border-color: var(--cc-cream);
}
.cc-btn--primary:hover { background: #fff6dc; border-color: #fff6dc; }

.cc-btn--danger {
  background: rgba(224, 90, 71, 0.15);
  border-color: rgba(224, 90, 71, 0.5);
  color: #ffd9d2;
}
.cc-btn--danger:hover { background: rgba(224, 90, 71, 0.28); }
`;

let injected = false;

export function injectTheme() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const style = document.createElement('style');
  style.id = 'cc-theme';
  style.textContent = CSS;
  document.head.appendChild(style);
}
