import { injectTheme } from './theme.js';

/**
 * ShiftReport — the end-of-shift report card (7:00 PM): tasks, tips, member happiness,
 * court quality, pay breakdown, checklist status and rank progress (with a promotion
 * highlight), plus a "Next day" button. DOM in #ui-root, styled with theme.js tokens.
 *
 *   const r = new ShiftReport({ onNextDay: () => ..., onTennis: () => ... });  // onTennis: optional
 *                                                     // "Stay for a hit with Coach Rafa" button
 *   r.show(report)   // report from ShiftSystem.buildReport()
 *   r.hide(); r.isOpen
 */

const CSS = `
.ccr-overlay {
  position: fixed; inset: 0; z-index: 300;
  display: none; align-items: center; justify-content: center;
  padding: calc(var(--cc-safe-top) + 16px) calc(var(--cc-safe-right) + 16px) calc(var(--cc-safe-bottom) + 16px) calc(var(--cc-safe-left) + 16px);
  background: radial-gradient(ellipse at 50% 40%, rgba(23, 58, 38, 0.55), rgba(8, 18, 12, 0.78));
  font-family: var(--cc-font-ui);
}
.ccr-overlay.is-open { display: flex; animation: ccr-fade 0.35s ease; }
@keyframes ccr-fade { from { opacity: 0; } to { opacity: 1; } }
.ccr-card {
  width: min(460px, 100%);
  max-height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 20px 18px;
  display: flex; flex-direction: column; gap: 12px;
  animation: ccr-rise 0.45s cubic-bezier(0.2, 0.9, 0.3, 1.15);
}
@keyframes ccr-rise { from { transform: translateY(18px) scale(0.98); opacity: 0; } to { transform: none; opacity: 1; } }
.ccr-head { text-align: center; }
.ccr-head .cc-label { color: var(--cc-gold); letter-spacing: 2.2px; }
.ccr-title { margin: 4px 0 0; font-size: 26px; line-height: 1.1; }
.ccr-sub { font-size: 13px; color: var(--cc-cream-dim); margin-top: 3px; }
.ccr-promo {
  display: none; gap: 12px; align-items: center;
  padding: 12px 14px; border-radius: 12px;
  background: linear-gradient(135deg, rgba(217, 164, 65, 0.3), rgba(217, 164, 65, 0.1));
  border: 1px solid rgba(217, 164, 65, 0.7);
  box-shadow: 0 0 24px rgba(217, 164, 65, 0.25);
}
.ccr-promo.is-on { display: flex; }
.ccr-promo__badge {
  flex: none; width: 44px; height: 44px; border-radius: 50%;
  display: grid; place-items: center; font-size: 22px;
  background: radial-gradient(circle at 35% 30%, #f7d98a, var(--cc-gold) 60%, #a97a23);
}
.ccr-promo__t { font-family: var(--cc-font-display); font-weight: 600; font-size: 17px; color: #fff4d2; }
.ccr-promo__u { font-size: 13px; color: var(--cc-cream); margin-top: 2px; }
.ccr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ccr-stat {
  background: rgba(244, 232, 193, 0.06); border: 1px solid rgba(244, 232, 193, 0.1);
  border-radius: 10px; padding: 9px 10px;
}
.ccr-stat b { display: block; font-family: var(--cc-font-display); font-size: 21px; font-weight: 600; color: var(--cc-cream); }
.ccr-stat span { display: block; font-size: 10.5px; letter-spacing: 0.8px; text-transform: uppercase; color: var(--cc-cream-dim); margin-top: 2px; }
.ccr-stat small { display: block; font-size: 12px; color: var(--cc-cream-dim); margin-top: 2px; }
.ccr-pay { border-radius: 12px; background: rgba(0, 0, 0, 0.16); padding: 8px 12px; }
.ccr-row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; padding: 4px 0; color: var(--cc-cream); }
.ccr-row span:last-child { font-variant-numeric: tabular-nums; }
.ccr-row--total { border-top: 1px solid rgba(244, 232, 193, 0.18); margin-top: 4px; padding-top: 8px; font-weight: 700; font-size: 16px; }
.ccr-row--total span:last-child { color: #ffe39a; }
.ccr-row--dim { color: var(--cc-cream-dim); font-size: 13px; }
.ccr-checks { display: flex; gap: 8px; flex-wrap: wrap; }
.ccr-check {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; padding: 5px 10px; border-radius: 999px;
  background: rgba(244, 232, 193, 0.06); border: 1px solid rgba(244, 232, 193, 0.12); color: var(--cc-cream-dim);
}
.ccr-check.is-done { color: #bff0cc; border-color: rgba(76, 175, 106, 0.55); background: rgba(76, 175, 106, 0.14); }
.ccr-rank__top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.ccr-rank__title { font-family: var(--cc-font-display); font-size: 17px; font-weight: 600; color: var(--cc-cream); }
.ccr-rank__pts { font-size: 12px; color: var(--cc-cream-dim); font-variant-numeric: tabular-nums; }
.ccr-bar { height: 10px; border-radius: 999px; background: rgba(244, 232, 193, 0.12); overflow: hidden; margin: 7px 0 5px; }
.ccr-bar i { display: block; height: 100%; width: 0; border-radius: inherit; background: linear-gradient(90deg, var(--cc-gold), #f2c14e); transition: width 1.1s cubic-bezier(0.2, 0.8, 0.3, 1) 0.25s; }
.ccr-next { font-size: 12.5px; color: var(--cc-cream-dim); }
.ccr-btn2 { width: 100%; min-height: 48px; font-size: 15px; }
.ccr-btn2[hidden] { display: none; }
.ccr-btn { width: 100%; min-height: 52px; font-size: 16px; margin-top: 2px; position: sticky; bottom: 0; box-shadow: 0 -8px 16px rgba(20, 38, 28, 0.6); }
@media (max-height: 700px) and (min-width: 700px) {
  .ccr-card { width: min(760px, 100%); display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; padding: 16px 18px; }
  .ccr-head, .ccr-promo { grid-column: 1 / -1; }
  .ccr-title { font-size: 23px; }
  .ccr-btn, .ccr-btn2 { grid-column: 1 / -1; }
}
@media (max-width: 400px) {
  .ccr-card { padding: 16px 14px 14px; gap: 10px; }
  .ccr-title { font-size: 23px; }
  .ccr-stat b { font-size: 19px; }
}
@media (prefers-reduced-motion: reduce) {
  .ccr-overlay.is-open, .ccr-card { animation: none; }
  .ccr-bar i { transition: none; }
}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.id = 'cc-report-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const money = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
const RATING = { excellent: 'Excellent', good: 'Good', needsWork: 'Needs work' };

export class ShiftReport {
  constructor({ onNextDay, onTennis } = {}) {
    injectTheme();
    injectCSS();
    this.onNextDay = onNextDay || null;
    this.onTennis = onTennis || null;
    this.isOpen = false;

    const ui = document.getElementById('ui-root') || document.body;
    const ov = document.createElement('div');
    ov.className = 'ccr-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'ccr-title');
    ov.innerHTML = `
      <div class="cc-panel ccr-card">
        <div class="ccr-head">
          <div class="cc-label">Greenbriar · End of shift</div>
          <h2 class="cc-title ccr-title" id="ccr-title" data-r="title">Shift report</h2>
          <div class="ccr-sub" data-r="sub"></div>
        </div>
        <div class="ccr-promo" data-r="promo">
          <div class="ccr-promo__badge" aria-hidden="true">★</div>
          <div><div class="ccr-promo__t" data-r="promoT"></div><div class="ccr-promo__u" data-r="promoU"></div></div>
        </div>
        <div class="ccr-grid">
          <div class="ccr-stat"><b data-r="tasks">0</b><span>Tasks done</span></div>
          <div class="ccr-stat"><b data-r="tips">$0</b><span>Tips</span><small data-r="tipsN"></small></div>
          <div class="ccr-stat"><b data-r="happy">—</b><span>Member happiness</span><small data-r="happyN"></small></div>
          <div class="ccr-stat"><b data-r="courts">—</b><span>Clay court quality</span><small data-r="groom"></small></div>
        </div>
        <div class="ccr-pay">
          <div class="ccr-row"><span data-r="wageL">Wage</span><span data-r="wage">$0</span></div>
          <div class="ccr-row"><span>Task pay</span><span data-r="taskPay">$0</span></div>
          <div class="ccr-row"><span>Tips</span><span data-r="tips2">$0</span></div>
          <div class="ccr-row ccr-row--total"><span>Today</span><span data-r="total">$0</span></div>
          <div class="ccr-row ccr-row--dim" data-r="spentRow" style="display:none"><span>Spent today (shop)</span><span data-r="spent">$0</span></div>
          <div class="ccr-row ccr-row--dim"><span>Wallet</span><span data-r="wallet">$0</span></div>
        </div>
        <div class="ccr-checks">
          <span class="ccr-check" data-r="open">Opening checklist</span>
          <span class="ccr-check" data-r="close">Closing duties</span>
        </div>
        <div class="ccr-rank">
          <div class="ccr-rank__top"><span class="ccr-rank__title" data-r="rank"></span><span class="ccr-rank__pts" data-r="pts"></span></div>
          <div class="ccr-bar"><i data-r="bar"></i></div>
          <div class="ccr-next" data-r="next"></div>
        </div>
        <button type="button" class="cc-btn ccr-btn2" data-r="tennis">🎾 Stay for a hit with Coach Rafa</button>
        <button type="button" class="cc-btn cc-btn--primary ccr-btn" data-r="btn">Next day ▸</button>
      </div>`;
    ui.appendChild(ov);
    this.el = ov;
    this.r = {};
    for (const n of ov.querySelectorAll('[data-r]')) this.r[n.dataset.r] = n;

    // Keep taps and keys on the card (the game underneath is paused anyway)
    for (const ev of ['pointerdown', 'touchstart', 'mousedown', 'wheel']) {
      ov.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
    let touched = false;
    const go = () => {
      if (!this.isOpen) return;
      this.hide();
      if (this.onNextDay) this.onNextDay();
    };
    this.r.btn.addEventListener('touchend', (e) => { e.preventDefault(); touched = true; go(); });
    this.r.btn.addEventListener('click', () => { if (touched) { touched = false; return; } go(); });
    // After-hours tennis (hidden when no handler is wired)
    this.r.tennis.hidden = !this.onTennis;
    this.r.tennis.addEventListener('click', () => {
      if (!this.isOpen || !this.onTennis) return;
      this.hide();
      this.onTennis();
    });
  }

  show(rep) {
    if (!rep) return;
    const r = this.r;
    r.title.textContent = `Day ${rep.day} shift report`;
    r.sub.textContent = `Clocked out at 7:00 PM · ${rep.hours ? rep.hours.toFixed(rep.hours % 1 ? 1 : 0) : 0} h on the clock`;
    // Today's club event (EventSystem), e.g. "🏆 Member Tournament Saturday"
    if (rep.event && rep.event.id !== 'regular') r.sub.textContent = `${rep.event.icon ? rep.event.icon + ' ' : ''}${rep.event.title} · ${r.sub.textContent}`;

    r.promo.classList.toggle('is-on', !!rep.rankUp);
    if (rep.rankUp) {
      r.promoT.textContent = `Promoted to ${rep.rank.title}!`;
      r.promoU.textContent = rep.unlocks.map(u => u.unlock).filter(Boolean).join(' ') || 'New responsibilities.';
    }

    r.tasks.textContent = String(rep.tasks);
    r.tips.textContent = money(rep.tips);
    r.tipsN.textContent = rep.tipCount ? `from ${rep.tipCount} member${rep.tipCount === 1 ? '' : 's'}` : 'No tips today';
    if (rep.happiness == null) {
      r.happy.textContent = '—';
      r.happyN.textContent = 'No member calls today';
    } else {
      const pct = Math.round(rep.happiness * 100);
      r.happy.textContent = `${pct >= 70 ? '😊' : pct >= 40 ? '🙂' : '😤'} ${pct}%`;
      const x = rep.reactions;
      r.happyN.textContent = `${x.satisfied} happy · ${x.neutral} okay · ${x.unsatisfied} upset`;
    }
    r.courts.textContent = Number.isFinite(rep.courtQuality) ? `${Math.round(rep.courtQuality * 100)}%` : '—';
    r.groom.textContent = rep.groomBest ? `Best groom: ${RATING[rep.groomBest] || rep.groomBest}` : 'Not groomed today';

    r.wageL.textContent = `Wage (${rep.hours ? rep.hours.toFixed(rep.hours % 1 ? 1 : 0) : 0} h)`;
    r.wage.textContent = money(rep.wage);
    r.taskPay.textContent = money(rep.missionPay);
    r.tips2.textContent = money(rep.tips);
    r.total.textContent = money(rep.total);
    // Shop, lessons and club projects bought today (Game sets rep.spent from ShopSystem)
    if (r.spentRow) {
      r.spentRow.style.display = rep.spent > 0 ? '' : 'none';
      r.spent.textContent = '−' + money(rep.spent || 0);
    }
    r.wallet.textContent = money(rep.wallet);

    r.open.classList.toggle('is-done', !!rep.openingDone);
    r.open.textContent = `${rep.openingDone ? '✓' : '–'} Opening checklist`;
    r.close.classList.toggle('is-done', !!rep.closingDone);
    r.close.textContent = `${rep.closingDone ? '✓' : '–'} Closing duties`;

    r.rank.textContent = rep.rank.title;
    r.pts.textContent = rep.next ? `${rep.points} / ${rep.next.points} pts` : `${rep.points} pts`;
    r.next.textContent = rep.next
      ? `+${rep.pointsGained} pts today. Next: ${rep.next.title}. ${rep.next.unlock || ''}`
      : `+${rep.pointsGained} pts today. Top of the ladder!`;
    r.bar.style.transition = 'none';
    r.bar.style.width = '0%';

    this.el.classList.add('is-open');
    this.isOpen = true;
    void r.bar.offsetWidth;
    r.bar.style.transition = '';
    r.bar.style.width = `${Math.round(rep.frac * 100)}%`;
    try { r.btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  hide() {
    this.el.classList.remove('is-open');
    this.isOpen = false;
  }
}
