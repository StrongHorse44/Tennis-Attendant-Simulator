/**
 * PlayerProfile — what the player owns and how good they are at tennis.
 *
 * Shared by the shop (spends the wallet, equips gear, buys lessons and club
 * projects) and the after-hours tennis mode (reads stats, records results).
 * Saved as the additive `profile` field of the save (see SaveSystem).
 *
 * Tennis stats are 0–100: base skill (raised by lessons and play XP) plus the
 * bonuses of equipped gear from the shop catalog.
 */

export const TENNIS_STATS = ['power', 'control', 'spin', 'speed', 'serve', 'stamina'];

const BASE_SKILL = 30;
const MAX_SKILL = 100;
// XP needed for the next skill point grows slowly with the current level.
const xpForNext = (level) => 20 + Math.max(0, level - BASE_SKILL) * 1.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class PlayerProfile {
  constructor() {
    this.skills = {};
    this.xp = {};
    for (const s of TENNIS_STATS) { this.skills[s] = BASE_SKILL; this.xp[s] = 0; }
    this.owned = new Set();          // shop item ids
    this.equipped = {};              // slot → item id
    this.projects = {};              // club project id → amount contributed
    this.record = { matches: 0, wins: 0, losses: 0, setsWon: 0, setsLost: 0, bestStreak: 0, streak: 0, drills: 0 };
    this.lessons = 0;
    // Shop bookkeeping (ShopSystem): per-day counters keyed by the game day, lifetime spend
    this.shop = { day: 0, spentToday: 0, lessonsToday: 0, spentTotal: 0 };

    this._catalog = new Map();       // item id → item (set by the shop)
    this._wallet = null;             // { get(): number, spend(amount, label): boolean, earn?(amount, label) }
    this._listeners = new Set();
    this._stats = {};                // reused result of getTennisStats()
  }

  // ─────────────────────────── wiring ───────────────────────────

  /** The shop hands its item list here so gear bonuses can be resolved. */
  setCatalog(items) {
    this._catalog.clear();
    for (const it of items || []) if (it && it.id) this._catalog.set(it.id, it);
  }

  getItem(id) { return this._catalog.get(id) || null; }

  /** Game wires the shift wallet: { get, spend(amount, label) → bool }. */
  setWallet(adapter) { this._wallet = adapter; }

  get wallet() { return this._wallet ? this._wallet.get() : 0; }

  /** Subscribe to any profile change (purchase, equip, skill-up, record). Returns an unsubscribe fn. */
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _emit(kind, detail) { for (const fn of this._listeners) { try { fn(kind, detail); } catch (e) { console.warn(e); } } }

  // ─────────────────────────── money ───────────────────────────

  canAfford(amount) { return this.wallet >= amount; }

  /** Spend from the wallet. Returns false (and spends nothing) if it can't. */
  spend(amount, label = '') {
    amount = Math.max(0, Math.round(amount));
    if (!this._wallet || !this.canAfford(amount)) return false;
    const ok = this._wallet.spend(amount, label);
    if (ok) this._emit('spend', { amount, label });
    return ok;
  }

  // ─────────────────────────── items ───────────────────────────

  owns(id) { return this.owned.has(id); }

  grant(id) {
    if (this.owned.has(id)) return;
    this.owned.add(id);
    this._emit('grant', { id });
  }

  equip(slot, id) {
    if (id && !this.owned.has(id)) return false;
    if (id) this.equipped[slot] = id; else delete this.equipped[slot];
    this._emit('equip', { slot, id });
    return true;
  }

  getEquipped(slot) { return this.equipped[slot] || null; }

  // ─────────────────────────── club projects ───────────────────────────

  contribute(projectId, amount) {
    this.projects[projectId] = (this.projects[projectId] || 0) + amount;
    this._emit('project', { id: projectId, total: this.projects[projectId] });
  }

  getContribution(projectId) { return this.projects[projectId] || 0; }

  // ─────────────────────────── tennis ───────────────────────────

  /**
   * Effective stats: base skill + equipped gear bonuses (item.stats = { power: 5, ... }),
   * clamped to 0–100. Returns a reused object — copy it if you keep it.
   */
  getTennisStats() {
    const out = this._stats;
    for (const s of TENNIS_STATS) out[s] = this.skills[s];
    for (const slot in this.equipped) {
      const item = this._catalog.get(this.equipped[slot]);
      if (!item || !item.stats) continue;
      for (const s in item.stats) if (s in out) out[s] += item.stats[s];
    }
    for (const s of TENNIS_STATS) out[s] = clamp(Math.round(out[s]), 0, MAX_SKILL);
    return out;
  }

  /** Add practice XP to one stat; raises the base skill when enough accrues. Returns levels gained. */
  addXP(stat, amount) {
    if (!(stat in this.skills) || !(amount > 0)) return 0;
    this.xp[stat] += amount;
    let gained = 0;
    while (this.skills[stat] < MAX_SKILL && this.xp[stat] >= xpForNext(this.skills[stat])) {
      this.xp[stat] -= xpForNext(this.skills[stat]);
      this.skills[stat]++;
      gained++;
    }
    if (gained) this._emit('skill', { stat, level: this.skills[stat], gained });
    return gained;
  }

  /** A paid lesson: a flat boost to one or more stats. */
  applyLesson(boosts) {
    this.lessons++;
    for (const s in boosts || {}) {
      if (s in this.skills) this.skills[s] = clamp(this.skills[s] + boosts[s], 0, MAX_SKILL);
    }
    this._emit('lesson', { boosts });
  }

  /** Record a finished after-hours match: { won, setsWon, setsLost, drill? }. */
  recordMatch({ won = false, setsWon = 0, setsLost = 0, drill = false } = {}) {
    const r = this.record;
    if (drill) { r.drills++; this._emit('record', r); return; }
    r.matches++;
    r.setsWon += setsWon;
    r.setsLost += setsLost;
    if (won) { r.wins++; r.streak++; r.bestStreak = Math.max(r.bestStreak, r.streak); }
    else { r.losses++; r.streak = 0; }
    this._emit('record', r);
  }

  // ─────────────────────────── save ───────────────────────────

  getState() {
    return {
      skills: { ...this.skills },
      xp: { ...this.xp },
      owned: [...this.owned],
      equipped: { ...this.equipped },
      projects: { ...this.projects },
      record: { ...this.record },
      lessons: this.lessons,
      shop: { ...this.shop },
    };
  }

  setState(s) {
    if (!s || typeof s !== 'object') return;
    for (const k of TENNIS_STATS) {
      if (s.skills && Number.isFinite(s.skills[k])) this.skills[k] = clamp(s.skills[k], 0, MAX_SKILL);
      if (s.xp && Number.isFinite(s.xp[k])) this.xp[k] = Math.max(0, s.xp[k]);
    }
    if (Array.isArray(s.owned)) this.owned = new Set(s.owned.filter(x => typeof x === 'string'));
    if (s.equipped && typeof s.equipped === 'object') {
      this.equipped = {};
      for (const slot in s.equipped) if (typeof s.equipped[slot] === 'string' && this.owned.has(s.equipped[slot])) this.equipped[slot] = s.equipped[slot];
    }
    if (s.projects && typeof s.projects === 'object') {
      this.projects = {};
      for (const k in s.projects) if (Number.isFinite(s.projects[k])) this.projects[k] = Math.max(0, s.projects[k]);
    }
    if (s.record && typeof s.record === 'object') {
      for (const k in this.record) if (Number.isFinite(s.record[k])) this.record[k] = Math.max(0, s.record[k]);
    }
    if (Number.isFinite(s.lessons)) this.lessons = Math.max(0, s.lessons);
    if (s.shop && typeof s.shop === 'object') {
      for (const k in this.shop) if (Number.isFinite(s.shop[k])) this.shop[k] = Math.max(0, s.shop[k]);
    }
    this._emit('load', null);
  }
}

/** Keep a loaded profile sane: plain JSON only, bounded sizes. */
export function sanitizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = new PlayerProfile();
  p.setState(raw);
  const s = p.getState();
  s.owned = s.owned.slice(0, 200);
  return s;
}
