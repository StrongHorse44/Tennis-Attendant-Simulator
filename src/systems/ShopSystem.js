import { TENNIS_STATS } from './PlayerProfile.js';

/**
 * ShopSystem — the club shop and services: what the player's wages buy.
 *
 * Data: public/data/shop.json (hand-editable; `npm run validate` runs validateShop below).
 *   categories  gear | lessons | style | cart | projects (tabs in ShopUI)
 *   slots       equip slots (racket, strings, shoes, grip, uniform, hat, eyewear, cartPaint, ...)
 *   items       { id, slot, name, desc, price, starter?, minRank?, stats?, look?, cart? }
 *               stats → PlayerProfile.getTennisStats bonuses; look → Player.setOutfit style keys;
 *               cart → GolfCart.restyle keys (+ horn)
 *   lessons     Coach Rafa: { coach, basePrice, priceStep, maxPrice, perDay, list[{ id, name, desc, boosts }] }
 *   projects    { id (a ClubUpgrades builder), name, desc, cost, place, comments[] }
 *   vendors     npc id → { title, tabs[], greeting[] } (who opens which tabs)
 *
 * Everything owned / equipped / contributed lives in PlayerProfile (saved as `profile`), so a
 * load re-applies it through applyAll(). Money goes through profile.spend (the shift wallet;
 * rank points use lifetime earnings, so spending never costs rank).
 *
 * Hooks (set by Game):
 *   onLook(playerLook, cartLook)   – re-dress the player / repaint the cart
 *   onProjectFunded(project)       – a club project just reached its cost (world addition + confetti)
 *   onPurchase({ kind, id, name, amount })  – any spend (toast / sound)
 *   onProjectsChanged([[id, funded], ...])  – after a load: show / hide every club upgrade
 *   hasRankCap() → bool             – a rank perk cap is earned (a bought hat then waits in the Locker)
 *
 * Pure logic (no three.js / DOM) so scripts/validate-data.mjs can import validateShop.
 */

export const SHOP_CATEGORIES = ['gear', 'lessons', 'style', 'cart', 'projects'];
/** Categories whose items go in equip slots. */
export const SLOT_CATEGORIES = ['gear', 'style', 'cart'];
/** Player style keys an item's `look` may set (Player.setOutfit). */
export const PLAYER_LOOK_KEYS = ['shirt', 'collar', 'sleeveTrim', 'bottom', 'bottomColor', 'pantStripe', 'shoes', 'shoeAccent',
  'wristband', 'hat', 'hatColor', 'hatBrim', 'hatLogo', 'hatBand', 'sunglasses', 'racket', 'racketStrings'];
const LOOK_ENUMS = { bottom: ['shorts', 'skirt', 'pants'], hat: ['cap', 'capBack', 'visor', 'headband', 'bucket', null], sunglasses: [true, false] };
/** Cart look keys (GolfCart.restyle) + horn. */
export const CART_LOOK_KEYS = ['body', 'accent', 'canopy', 'canopyTrim', 'lights', 'lightColor', 'rack', 'horn'];
const CART_ENUMS = { lights: ['round', 'bar', 'bug'], rack: ['cooler', 'balls', null] };
export const HORNS = ['beep', 'chime', 'ahooga', 'fanfare'];
/** Club projects that have a world addition (src/world/ClubUpgrades.js). */
export const CLUB_UPGRADE_IDS = ['project_koi', 'project_trophy', 'project_flowers', 'project_scoreboard', 'project_patio', 'project_wall'];

const HEX = /^#[0-9a-f]{6}$/i;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const COLOR_KEYS = new Set(['shirt', 'collar', 'sleeveTrim', 'bottomColor', 'pantStripe', 'shoes', 'shoeAccent', 'wristband',
  'hatColor', 'hatBrim', 'hatLogo', 'hatBand', 'racket', 'racketStrings', 'body', 'accent', 'canopy', 'canopyTrim', 'lightColor']);

/** Fill in defaults and drop malformed entries so a hand-edited shop.json can't crash the game. */
export function normalizeShopData(raw) {
  const d = isObj(raw) ? raw : {};
  const categories = (Array.isArray(d.categories) ? d.categories : [])
    .filter(c => isObj(c) && SHOP_CATEGORIES.includes(c.id));
  for (const id of SHOP_CATEGORIES) {
    if (!categories.some(c => c.id === id)) categories.push({ id, title: id[0].toUpperCase() + id.slice(1), blurb: '' });
  }
  categories.sort((a, b) => SHOP_CATEGORIES.indexOf(a.id) - SHOP_CATEGORIES.indexOf(b.id));
  const slots = {};
  for (const [k, v] of Object.entries(isObj(d.slots) ? d.slots : {})) {
    if (isObj(v) && SLOT_CATEGORIES.includes(v.category)) slots[k] = { title: k, optional: false, ...v };
  }
  const seen = new Set();
  const items = (Array.isArray(d.items) ? d.items : []).filter((it) => {
    if (!isObj(it) || !it.id || seen.has(it.id) || !slots[it.slot]) return false;
    seen.add(it.id);
    return true;
  }).map(it => ({
    ...it,
    name: String(it.name || it.id),
    desc: String(it.desc || ''),
    price: Math.max(0, Math.round(Number(it.price) || 0)),
    category: slots[it.slot].category,
  }));
  const L = isObj(d.lessons) ? d.lessons : {};
  const lessons = {
    coach: L.coach || 'rafa_ibarra',
    basePrice: Math.max(0, Number(L.basePrice) || 150),
    priceStep: Math.max(0, Number(L.priceStep) || 0),
    maxPrice: Math.max(0, Number(L.maxPrice) || 400),
    perDay: Math.max(1, Math.round(Number(L.perDay) || 2)),
    list: (Array.isArray(L.list) ? L.list : []).filter(l => isObj(l) && l.id && isObj(l.boosts)).map(l => ({ ...l, name: String(l.name || l.id), desc: String(l.desc || '') })),
  };
  const projects = (Array.isArray(d.projects) ? d.projects : [])
    .filter(p => isObj(p) && p.id && Number(p.cost) > 0)
    .map(p => ({ ...p, name: String(p.name || p.id), desc: String(p.desc || ''), cost: Math.round(Number(p.cost)), comments: Array.isArray(p.comments) ? p.comments.filter(c => typeof c === 'string') : [] }));
  const vendors = isObj(d.vendors) ? d.vendors : {};
  return { categories, slots, items, lessons, projects, vendors };
}

/**
 * Data checks for `npm run validate`. facts: { npcIds: Set, rankCount: number, rankTitles?: string[] }.
 * Returns [{ level: 'error' | 'warn', msg }].
 */
export function validateShop(raw, facts = {}) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  if (!isObj(raw)) { err('shop.json must be an object'); return out; }
  const npcIds = facts.npcIds || new Set();
  const rankCount = facts.rankCount || 1;

  const catIds = new Set();
  for (const c of Array.isArray(raw.categories) ? raw.categories : []) {
    if (!isObj(c) || !SHOP_CATEGORIES.includes(c.id)) err(`categories: unknown category ${JSON.stringify(c && c.id)} (known: ${SHOP_CATEGORIES.join(', ')})`);
    else if (catIds.has(c.id)) err(`categories: duplicate "${c.id}"`);
    else catIds.add(c.id);
  }
  const slots = isObj(raw.slots) ? raw.slots : {};
  if (!Object.keys(slots).length) err('slots: at least one equip slot is needed');
  for (const [k, v] of Object.entries(slots)) {
    if (!isObj(v) || !SLOT_CATEGORIES.includes(v.category)) err(`slots.${k}: category must be one of ${SLOT_CATEGORIES.join('/')}`);
  }

  const ids = new Set();
  const starters = {};
  const items = Array.isArray(raw.items) ? raw.items : [];
  for (const it of items) {
    const at = `items.${it && it.id ? it.id : '?'}`;
    if (!isObj(it) || !it.id) { err('items: every item needs an "id"'); continue; }
    if (ids.has(it.id)) err(`${at}: duplicate id`);
    ids.add(it.id);
    const slot = slots[it.slot];
    if (!slot) { err(`${at}: unknown slot "${it.slot}"`); continue; }
    if (!it.name) err(`${at}: needs a "name"`);
    if (!(Number.isInteger(it.price) && it.price >= 0)) err(`${at}: price must be a whole number of dollars ≥ 0`);
    if (it.starter) {
      if (it.price !== 0) err(`${at}: starter items must be free (price 0)`);
      if (starters[it.slot]) err(`${at}: slot "${it.slot}" already has starter ${starters[it.slot]}`);
      starters[it.slot] = it.id;
    } else if (it.price === 0) warn(`${at}: free but not a starter (it is still bought with a tap)`);
    if (it.minRank !== undefined && !(Number.isInteger(it.minRank) && it.minRank >= 0 && it.minRank < rankCount)) {
      err(`${at}: minRank must be a rank index 0..${rankCount - 1} (missions.json → shift.ranks)`);
    }
    if (it.stats !== undefined) {
      if (!isObj(it.stats)) err(`${at}: stats must be an object`);
      else for (const [s, v] of Object.entries(it.stats)) {
        if (!TENNIS_STATS.includes(s)) err(`${at}: unknown stat "${s}" (known: ${TENNIS_STATS.join(', ')})`);
        else if (!(Number.isFinite(v) && Math.abs(v) <= 20)) err(`${at}: stats.${s} must be a number in -20..20`);
      }
      if (slot.category !== 'gear') warn(`${at}: stats only count on gear (tennis) slots`);
    }
    if (slot.category === 'gear' && !it.starter && !isObj(it.stats)) warn(`${at}: gear without stats does nothing for your game`);
    const checkLook = (look, keys, enums, name) => {
      if (!isObj(look)) { err(`${at}: ${name} must be an object`); return; }
      for (const [k, v] of Object.entries(look)) {
        if (!keys.includes(k)) err(`${at}: ${name}.${k} is not a known key (${keys.join(', ')})`);
        else if (COLOR_KEYS.has(k) && !HEX.test(String(v))) err(`${at}: ${name}.${k} must be "#RRGGBB"`);
        else if (enums[k] && !enums[k].includes(v)) err(`${at}: ${name}.${k} must be one of ${enums[k].map(String).join('/')}`);
      }
    };
    if (it.look !== undefined) checkLook(it.look, PLAYER_LOOK_KEYS, LOOK_ENUMS, 'look');
    if (it.cart !== undefined) {
      checkLook(it.cart, CART_LOOK_KEYS, { ...CART_ENUMS, horn: HORNS }, 'cart');
      if (slot.category !== 'cart') err(`${at}: cart looks belong in a cart slot`);
    }
    if (slot.category === 'cart' && !isObj(it.cart)) err(`${at}: cart items need a "cart" look`);
  }
  for (const [k, v] of Object.entries(slots)) {
    if (isObj(v) && !v.optional && !starters[k]) err(`slots.${k}: needs a free starter item (or "optional": true)`);
    if (!items.some(it => it && it.slot === k && !it.starter)) warn(`slots.${k}: nothing to buy for this slot`);
  }

  const L = raw.lessons;
  if (L !== undefined) {
    if (!isObj(L)) err('lessons must be an object');
    else {
      if (L.coach && !npcIds.has(L.coach)) err(`lessons.coach "${L.coach}" is not an npcs.json id`);
      for (const k of ['basePrice', 'priceStep', 'maxPrice', 'perDay']) {
        if (L[k] !== undefined && !(Number.isFinite(L[k]) && L[k] >= 0)) err(`lessons.${k} must be a number ≥ 0`);
      }
      if (Number(L.maxPrice) < Number(L.basePrice)) err('lessons.maxPrice must be ≥ basePrice');
      const lids = new Set();
      for (const l of Array.isArray(L.list) ? L.list : []) {
        const at = `lessons.${l && l.id ? l.id : '?'}`;
        if (!isObj(l) || !l.id) { err('lessons.list: every lesson needs an "id"'); continue; }
        if (lids.has(l.id) || ids.has(l.id)) err(`${at}: duplicate id`);
        lids.add(l.id);
        if (!isObj(l.boosts) || !Object.keys(l.boosts).length) err(`${at}: needs "boosts" { stat: points }`);
        else for (const [s, v] of Object.entries(l.boosts)) {
          if (!TENNIS_STATS.includes(s)) err(`${at}: unknown stat "${s}"`);
          else if (!(Number.isFinite(v) && v > 0 && v <= 10)) err(`${at}: boosts.${s} must be 1..10`);
        }
      }
    }
  }

  const pids = new Set();
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    const at = `projects.${p && p.id ? p.id : '?'}`;
    if (!isObj(p) || !p.id) { err('projects: every project needs an "id"'); continue; }
    if (pids.has(p.id)) err(`${at}: duplicate id`);
    pids.add(p.id);
    if (!CLUB_UPGRADE_IDS.includes(p.id)) err(`${at}: no world addition for this id (ClubUpgrades builds ${CLUB_UPGRADE_IDS.join(', ')})`);
    if (!(Number.isInteger(p.cost) && p.cost > 0)) err(`${at}: cost must be a whole number > 0`);
    else if (p.cost < 500) warn(`${at}: cost ${p.cost} is under two shifts of pay; projects are meant to be 5-10 shifts`);
    if (p.comments !== undefined && !(Array.isArray(p.comments) && p.comments.every(c => typeof c === 'string' && c.trim()))) err(`${at}: comments must be an array of strings`);
  }
  for (const [npc, v] of Object.entries(isObj(raw.vendors) ? raw.vendors : {})) {
    if (!npcIds.has(npc)) err(`vendors.${npc}: not an npcs.json id`);
    const tabs = isObj(v) && Array.isArray(v.tabs) ? v.tabs : [];
    if (!tabs.length) err(`vendors.${npc}: needs "tabs"`);
    for (const t of tabs) if (!SHOP_CATEGORIES.includes(t)) err(`vendors.${npc}: unknown tab "${t}"`);
  }
  return out;
}

// ───────────────────────────── horn synth ─────────────────────────────

/** Note lists for each horn: [freq, start, dur, type, freqEnd?]. */
const HORN_NOTES = {
  beep: [[415, 0, 0.11, 'square'], [415, 0.16, 0.16, 'square']],
  chime: [[784, 0, 0.35, 'sine'], [622, 0.26, 0.55, 'sine']],
  ahooga: [[150, 0, 0.32, 'sawtooth', 330], [300, 0.34, 0.42, 'sawtooth', 210]],
  fanfare: [[523, 0, 0.12, 'triangle'], [659, 0.12, 0.12, 'triangle'], [784, 0.24, 0.12, 'triangle'], [1047, 0.36, 0.42, 'triangle']],
};

// ───────────────────────────── ShopSystem ─────────────────────────────

export class ShopSystem {
  /** Load public/data/shop.json (null + a warning if it is missing or broken: the shop then stays closed). */
  static async loadData(loader, base = '/') {
    try {
      return await loader.loadJSON(`${base}data/shop.json`);
    } catch (err) {
      console.warn('shop.json could not be loaded; the club shop is closed:', err && err.message ? err.message : err);
      return null;
    }
  }

  /**
   * @param {object|null} raw  shop.json
   * @param {{ profile: PlayerProfile, getDay: () => number, getRankIndex: () => number, ranks?: object[] }} opts
   */
  constructor(raw, { profile, getDay = () => 1, getRankIndex = () => 0, ranks = [] }) {
    this.available = !!raw;
    this.data = normalizeShopData(raw);
    this.profile = profile;
    this.getDay = getDay;
    this.getRankIndex = getRankIndex;
    this.ranks = ranks;
    this.items = new Map(this.data.items.map(it => [it.id, it]));
    this.projects = new Map(this.data.projects.map(p => [p.id, p]));
    this.lessons = new Map(this.data.lessons.list.map(l => [l.id, l]));

    this.onLook = null;
    this.onProjectFunded = null;
    this.onPurchase = null;
    /** Game sets this: may the horn sound now (in the cart, not paused)? */
    this.canHonk = () => false;
    this.sound = null;

    this._lookKey = '';
    this._honkUntil = 0;
    profile.setCatalog(this.data.items);
    this.grantStarters();
    profile.onChange((kind) => {
      if (kind === 'load') { this.grantStarters(); this.applyAll(); }
      else if (kind === 'equip') this.applyLooks();
    });
  }

  // ───────────────────────────── queries ─────────────────────────────

  get categories() { return this.data.categories; }

  getItem(id) { return this.items.get(id) || null; }

  getProject(id) { return this.projects.get(id) || null; }

  getLesson(id) { return this.lessons.get(id) || null; }

  slotsFor(category) {
    return Object.entries(this.data.slots).filter(([, s]) => s.category === category).map(([id, s]) => ({ id, ...s }));
  }

  itemsForSlot(slot) { return this.data.items.filter(it => it.slot === slot); }

  vendor(npcId) { return this.data.vendors[npcId] || null; }

  isOwned(id) { return this.profile.owns(id); }

  isEquipped(id) {
    const it = this.getItem(id);
    return !!(it && this.profile.getEquipped(it.slot) === id);
  }

  /** Item worn in a slot (the starter when nothing is chosen), or null. */
  equippedItem(slot) {
    return this.getItem(this.profile.getEquipped(slot)) || null;
  }

  /** Rank index an item needs (0 = none) and whether the player has it. */
  rankNeeded(item) { return item && Number.isInteger(item.minRank) ? item.minRank : 0; }

  isLocked(item) { return this.rankNeeded(item) > this.getRankIndex(); }

  rankTitle(i) { const r = this.ranks[i]; return r ? r.title : `rank ${i + 1}`; }

  /** Tennis stat changes if `item` replaced what is equipped in its slot: { stat: delta } (non-zero only). */
  statDelta(item) {
    const out = {};
    if (!item) return out;
    const cur = this.equippedItem(item.slot);
    if (cur && cur.id === item.id) return out;
    const a = (cur && cur.stats) || {};
    const b = item.stats || {};
    for (const s of TENNIS_STATS) {
      const d = (b[s] || 0) - (a[s] || 0);
      if (d) out[s] = d;
    }
    return out;
  }

  // ───────────────────────────── day bookkeeping ─────────────────────────────

  _syncDay() {
    const day = this.getDay() || 1;
    const st = this.profile.shop;
    if (st.day !== day) {
      st.day = day;
      st.spentToday = 0;
      st.lessonsToday = 0;
    }
    return st;
  }

  spentToday() { return this._syncDay().spentToday; }

  _pay(amount, label, kind, id) {
    if (!this.profile.spend(amount, label)) return false;
    const st = this._syncDay();
    st.spentToday += amount;
    st.spentTotal += amount;
    if (this.onPurchase) this.onPurchase({ kind, id, name: label, amount });
    return true;
  }

  // ───────────────────────────── buy / equip ─────────────────────────────

  /** Give every starter item and wear it where the slot is empty (new games and old saves). */
  grantStarters() {
    for (const it of this.data.items) {
      if (!it.starter) continue;
      if (!this.profile.owns(it.id)) this.profile.owned.add(it.id); // quiet: no 'grant' event spam
      if (!this.profile.getEquipped(it.slot)) this.profile.equipped[it.slot] = it.id;
    }
  }

  /**
   * Buy an item. Wears it at once, except a hat while the rank perk cap is earned (the gold cap
   * stays until the player picks the hat in the Locker) — pass { equip: true } to force.
   * Returns { ok, reason?: 'unknown' | 'owned' | 'locked' | 'funds', item, equipped }.
   */
  buy(id, { equip } = {}) {
    const item = this.getItem(id);
    if (!item) return { ok: false, reason: 'unknown' };
    if (this.profile.owns(id)) return { ok: false, reason: 'owned', item };
    if (this.isLocked(item)) return { ok: false, reason: 'locked', item };
    if (!this.profile.canAfford(item.price)) return { ok: false, reason: 'funds', item, short: item.price - this.profile.wallet };
    if (item.price > 0 && !this._pay(item.price, item.name, 'item', id)) return { ok: false, reason: 'funds', item };
    this.profile.grant(id);
    const wear = equip ?? !(item.slot === 'hat' && this.hasRankCap && this.hasRankCap());
    if (wear) this.profile.equip(item.slot, id);
    return { ok: true, item, equipped: wear };
  }

  equip(id) {
    const item = this.getItem(id);
    if (!item || !this.profile.owns(id)) return false;
    return this.profile.equip(item.slot, id);
  }

  /** Take off an optional slot (hat, eyewear, rack) or go back to the starter. */
  unequip(slot) {
    const s = this.data.slots[slot];
    if (!s) return false;
    if (s.optional) return this.profile.equip(slot, null);
    const starter = this.data.items.find(it => it.slot === slot && it.starter);
    return starter ? this.profile.equip(slot, starter.id) : false;
  }

  // ───────────────────────────── lessons ─────────────────────────────

  lessonPrice() {
    const L = this.data.lessons;
    return Math.round(Math.min(L.maxPrice, L.basePrice + L.priceStep * this.profile.lessons));
  }

  lessonsLeftToday() { return Math.max(0, this.data.lessons.perDay - this._syncDay().lessonsToday); }

  /** Book a lesson: { ok, reason?: 'unknown' | 'limit' | 'funds', lesson, price, gains }. */
  bookLesson(id) {
    const lesson = this.getLesson(id);
    if (!lesson) return { ok: false, reason: 'unknown' };
    if (this.lessonsLeftToday() <= 0) return { ok: false, reason: 'limit', lesson };
    const price = this.lessonPrice();
    if (!this.profile.canAfford(price)) return { ok: false, reason: 'funds', lesson, price, short: price - this.profile.wallet };
    if (!this._pay(price, lesson.name, 'lesson', id)) return { ok: false, reason: 'funds', lesson, price };
    const before = { ...this.profile.skills };
    this.profile.applyLesson(lesson.boosts);
    this._syncDay().lessonsToday++;
    const gains = {};
    for (const s of TENNIS_STATS) if (this.profile.skills[s] !== before[s]) gains[s] = this.profile.skills[s] - before[s];
    return { ok: true, lesson, price, gains };
  }

  // ───────────────────────────── club projects ─────────────────────────────

  projectProgress(id) {
    const p = this.getProject(id);
    if (!p) return null;
    const funded = Math.min(p.cost, this.profile.getContribution(id));
    return { project: p, funded, cost: p.cost, remaining: p.cost - funded, done: funded >= p.cost, frac: funded / p.cost };
  }

  isFunded(id) { const pr = this.projectProgress(id); return !!(pr && pr.done); }

  /** Put money toward a project (clamped to what's left and what you have). { ok, reason?, amount, done }. */
  contribute(id, amount) {
    const pr = this.projectProgress(id);
    if (!pr) return { ok: false, reason: 'unknown' };
    if (pr.done) return { ok: false, reason: 'done', project: pr.project };
    const amt = Math.round(Math.min(pr.remaining, Math.max(0, amount), this.profile.wallet));
    if (amt <= 0) return { ok: false, reason: 'funds', project: pr.project, short: Math.min(pr.remaining, amount) };
    if (!this._pay(amt, pr.project.name, 'project', id)) return { ok: false, reason: 'funds', project: pr.project };
    this.profile.contribute(id, amt);
    const done = this.isFunded(id);
    if (done && this.onProjectFunded) this.onProjectFunded(pr.project);
    return { ok: true, amount: amt, done, project: pr.project };
  }

  fundedProjects() { return this.data.projects.filter(p => this.isFunded(p.id)); }

  /** Small-talk lines about funded projects (SmallTalk club-talk bucket), or null. */
  clubTalk() {
    let lines = null;
    for (const p of this.data.projects) {
      if (!p.comments.length || !this.isFunded(p.id)) continue;
      (lines || (lines = [])).push(...p.comments);
    }
    return lines;
  }

  // ───────────────────────────── looks ─────────────────────────────

  /** Combined player style patch of every equipped item (slot order: uniform first, gear, hat last). */
  playerLook() {
    const look = {};
    for (const slot of Object.keys(this.data.slots)) {
      const it = this.equippedItem(slot);
      if (it && it.look) Object.assign(look, it.look);
    }
    return look;
  }

  cartLook() {
    const look = {};
    for (const slot of Object.keys(this.data.slots)) {
      const it = this.equippedItem(slot);
      if (it && it.cart) Object.assign(look, it.cart);
    }
    return look;
  }

  /** Re-dress the player and repaint the cart (only when something changed). */
  applyLooks() {
    const p = this.playerLook();
    const c = this.cartLook();
    const key = JSON.stringify(p) + JSON.stringify(c);
    if (key === this._lookKey) return;
    this._lookKey = key;
    if (this.onLook) this.onLook(p, c);
  }

  /** Everything after a load: starters, looks, and which club projects stand in the world. */
  applyAll() {
    this._lookKey = '';
    this.applyLooks();
    if (this.onProjectsChanged) this.onProjectsChanged(this.data.projects.map(p => [p.id, this.isFunded(p.id)]));
  }

  // ───────────────────────────── horn ─────────────────────────────

  /** Sound the equipped horn (procedural; goes through the master gain so volume / mute / pause apply). */
  honk() {
    const snd = this.sound;
    if (!snd || !snd.initialized || !snd.ctx || !snd.masterGain) return false;
    const now = snd.ctx.currentTime;
    if (now < this._honkUntil) return false;
    const style = this.cartLook().horn || 'beep';
    const notes = HORN_NOTES[style] || HORN_NOTES.beep;
    try {
      let end = 0;
      for (const [f, t0, dur, type, f1] of notes) {
        const osc = snd.ctx.createOscillator();
        const g = snd.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(f, now + t0);
        if (f1) osc.frequency.linearRampToValueAtTime(f1, now + t0 + dur);
        const peak = type === 'sine' || type === 'triangle' ? 0.16 : 0.06;
        g.gain.setValueAtTime(0.0001, now + t0);
        g.gain.exponentialRampToValueAtTime(peak, now + t0 + 0.015);
        g.gain.setValueAtTime(peak, now + t0 + dur * 0.7);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur);
        osc.connect(g);
        g.connect(snd.masterGain);
        osc.start(now + t0);
        osc.stop(now + t0 + dur + 0.05);
        end = Math.max(end, t0 + dur);
      }
      this._honkUntil = now + end + 0.1;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Clamp helper for UI amounts. */
  static clampAmount(v, max) { return clamp(Math.round(v) || 0, 0, Math.max(0, max)); }
}
