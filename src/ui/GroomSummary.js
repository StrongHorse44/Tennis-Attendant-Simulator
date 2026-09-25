import { injectTheme, THEME } from './theme.js';

/**
 * GroomSummary - short end-of-session card: rating, before → after cleanliness,
 * coverage, courtside tasks and a heatmap of the paint masks (brushed clay is bright,
 * missed cells are dim). Auto-hides after a few seconds; tap or the close button dismisses.
 */

const CSS = `
.cc-gsum {
  position: fixed;
  left: 0; right: 0;
  top: calc(var(--cc-safe-top, 0px) + 22%);
  margin: 0 auto;
  width: min(340px, calc(100vw - 24px));
  z-index: 40;
  padding: 14px 16px 12px;
  box-sizing: border-box;
  opacity: 0;
  transform: translateY(10px) scale(0.98);
  transition: opacity .25s ease, transform .25s ease;
  pointer-events: auto;
}
.cc-gsum--in { opacity: 1; transform: none; }
.cc-gsum__head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.cc-gsum__title { flex: 1; font-family: var(--cc-font-display); font-size: 18px; font-weight: 600; }
.cc-gsum__badge {
  font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; background: rgba(244,232,193,.14);
}
.cc-gsum__close {
  width: 44px; height: 44px; margin: -10px -10px -10px 0;
  border: 0; background: transparent; color: inherit; font-size: 22px; cursor: pointer;
}
.cc-gsum__stats { display: flex; justify-content: space-between; gap: 8px; margin: 4px 0 10px; font-size: 12px; }
.cc-gsum__stats div { display: flex; flex-direction: column; gap: 2px; }
.cc-gsum__stats b { font-size: 16px; font-variant-numeric: tabular-nums; }
.cc-gsum__stats span { opacity: .7; }
.cc-gsum__map { display: block; width: 100%; height: auto; border-radius: 10px; image-rendering: pixelated; }
.cc-gsum__legend { display: flex; justify-content: space-between; font-size: 10.5px; opacity: .7; margin-top: 6px; }
`;

const RATING = {
  excellent: { label: 'Excellent', color: '#8fe0a6' },
  good: { label: 'Good', color: THEME.gold },
  needsWork: { label: 'Needs work', color: '#f2a27c' },
};

export class GroomSummary {
  constructor() {
    this.el = null;
    this._timer = null;
    this._hideTimer = null;
  }

  _ensure() {
    if (this.el || typeof document === 'undefined') return !!this.el;
    injectTheme();
    if (!document.getElementById('cc-gsum-css')) {
      const st = document.createElement('style');
      st.id = 'cc-gsum-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const root = document.getElementById('ui-root') || document.body;
    const el = document.createElement('div');
    el.className = 'cc-panel cc-glass cc-gsum';
    el.style.display = 'none';
    for (const ev of ['pointerdown', 'touchstart', 'mousedown', 'click']) {
      el.addEventListener(ev, (e) => e.stopPropagation());
    }
    el.addEventListener('click', () => this.hide());
    root.appendChild(el);
    this.el = el;
    return true;
  }

  /**
   * @param {object} score CourtMaintenanceSystem.lastScore
   * @param {Array} courts clay Court instances (drawHeatmap)
   * @param {number} [duration=7] seconds
   */
  show(score, courts, duration = 7) {
    if (!score || !this._ensure()) return;
    const el = this.el;
    const r = RATING[score.rating] || RATING.good;
    const pct = (v) => `${Math.round((v || 0) * 100)}%`;
    const before = Math.max(0, Math.min(1, (score.cleanliness || 0) - (score.improvement || 0)));
    el.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'cc-gsum__head';
    const title = document.createElement('span');
    title.className = 'cc-gsum__title';
    title.textContent = 'Grooming report';
    const badge = document.createElement('span');
    badge.className = 'cc-gsum__badge';
    badge.textContent = r.label;
    badge.style.color = r.color;
    const close = document.createElement('button');
    close.className = 'cc-gsum__close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    head.append(title, badge, close);

    const stats = document.createElement('div');
    stats.className = 'cc-gsum__stats';
    const stat = (value, label) => {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = value;
      const s = document.createElement('span');
      s.textContent = label;
      d.append(b, s);
      stats.appendChild(d);
    };
    stat(`${pct(before)} → ${pct(score.cleanliness)}`, 'Clean');
    stat(pct(score.coverage), 'Brushed');
    const m = Math.floor((score.time || 0) / 60), s = Math.floor((score.time || 0) % 60);
    stat(`${m}:${String(s).padStart(2, '0')}`, 'Time');
    if (score.tasksTotal) stat(`${score.tasksCompleted}/${score.tasksTotal}`, 'Courtside');

    el.append(head, stats);

    // Heatmap: the three slabs side by side
    const list = (courts || []).filter(c => c && c.scoreCells > 0 && typeof c.drawHeatmap === 'function');
    if (list.length) {
      const w = list[0]._sc1 - list[0]._sc0 + 1, h = list[0]._sr1 - list[0]._sr0 + 1;
      const gap = 3;
      const cv = document.createElement('canvas');
      cv.width = list.length * w + (list.length - 1) * gap;
      cv.height = h;
      cv.className = 'cc-gsum__map';
      const ctx = cv.getContext('2d');
      ctx.fillStyle = 'rgba(0,0,0,0)';
      list.forEach((c, i) => c.drawHeatmap(ctx, i * (w + gap), 0, 1));
      // net lines
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      list.forEach((c, i) => ctx.fillRect(i * (w + gap), Math.floor(h / 2), w, 1));
      el.appendChild(cv);
      const leg = document.createElement('div');
      leg.className = 'cc-gsum__legend';
      leg.innerHTML = '<span>Bright = fresh clay</span><span>Dark = missed / scuffed</span>';
      el.appendChild(leg);
    }

    clearTimeout(this._timer);
    clearTimeout(this._hideTimer);
    el.style.display = 'block';
    // next frame → transition in
    requestAnimationFrame(() => el.classList.add('cc-gsum--in'));
    this._timer = setTimeout(() => this.hide(), duration * 1000);
  }

  hide() {
    if (!this.el || this.el.style.display === 'none') return;
    clearTimeout(this._timer);
    this.el.classList.remove('cc-gsum--in');
    this._hideTimer = setTimeout(() => { if (this.el) this.el.style.display = 'none'; }, 260);
  }
}
