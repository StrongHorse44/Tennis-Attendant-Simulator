/**
 * EventSystem — the daily events calendar (public/data/events.json). Every in-game day gets a
 * theme (Member Tournament Saturday, Junior Clinic, Pool Party, Board Inspection, VIP Visit,
 * Rain Day…): a weekly rotation (day 1 = Monday) with weighted picks per weekday, a small
 * wildcard chance and no repeat of the last two days' events.
 *
 * Effects of today's event (all optional in the data):
 *   dispatchRate          × radio dispatch speed (MissionSystem.eventDispatchScale)
 *   tipMultiplier         × tips (ShiftSystem.eventTipMultiplier)
 *   groomBonusMultiplier  × groom bonus (ShiftSystem.eventGroomBonusMultiplier)
 *   boardSize             task board options (2..4)
 *   templateBoost         { templateId: × weight } for MissionGenerator; event-only templates
 *                         (templates.list[].events) are offered only on their event's day
 *   missionBoost          { missionId: × weight } for authored missions
 *   weather / weatherUntil  forced weather in the morning (a rain day, a sunny pool party)
 *   schedule              { maxConcurrent, format, matches: [...] } merged into schedule.json
 *                         (MatchSystem.setSchedule via onScheduleChange, only at day start / load)
 *
 * Pure logic (no DOM / three.js): Game wires the hooks, `npm run validate` checks the data
 * with validateEvents().
 */
import { validateSchedule } from './MissionValidation.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WEATHERS = ['sunny', 'cloudy', 'rainy', 'windy'];
const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** Weekday key for an in-game day (day 1 = Monday). */
export function weekdayOf(day) { return WEEKDAYS[(((Math.max(1, day | 0) - 1) % 7) + 7) % 7]; }
export function weekdayName(day) { return WEEKDAY_NAMES[WEEKDAYS.indexOf(weekdayOf(day))]; }

/** Merge an event's schedule additions into the base schedule.json (never mutates either). */
export function mergeSchedule(base, ev) {
  const b = isObj(base) ? base : {};
  const add = ev && isObj(ev.schedule) ? ev.schedule : null;
  if (!add) return b;
  const out = { ...b };
  if (Number.isInteger(add.maxConcurrent)) out.maxConcurrent = add.maxConcurrent;
  if (isObj(add.format)) out.format = { ...(b.format || {}), ...add.format };
  const ids = new Set((Array.isArray(b.matches) ? b.matches : []).map(m => m && m.id));
  out.matches = [...(Array.isArray(b.matches) ? b.matches : []), ...(Array.isArray(add.matches) ? add.matches : []).filter(m => isObj(m) && !ids.has(m.id))];
  return out;
}

/**
 * Pick the event for `day`: firstDay on day 1, else a weighted pick from the weekday's list
 * (minDay-gated, skipping `recent`), with a `wildcard.chance` of a wildcard pick instead.
 */
export function pickEvent(data, day, recent = [], rand = Math.random) {
  const byId = new Map((Array.isArray(data.events) ? data.events : []).filter(e => isObj(e) && e.id).map(e => [e.id, e]));
  const fallback = byId.get(data.fallback) || byId.values().next().value || null;
  if (day <= 1 && byId.has(data.firstDay)) return byId.get(data.firstDay);
  const ok = (id) => { const e = byId.get(id); return e && !(Number.isFinite(e.minDay) && day < e.minDay); };
  const pickFrom = (list, avoid) => {
    const c = (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? { id: x, weight: 1 } : x))
      .filter(x => isObj(x) && ok(x.id) && !(avoid && recent.includes(x.id)));
    let total = 0;
    for (const x of c) total += Math.max(0, Number(x.weight ?? 1));
    if (total <= 0) return null;
    let r = rand() * total;
    for (const x of c) { r -= Math.max(0, Number(x.weight ?? 1)); if (r <= 0) return byId.get(x.id); }
    return byId.get(c[c.length - 1].id);
  };
  const w = isObj(data.wildcard) ? data.wildcard : null;
  if (w && rand() < (Number(w.chance) || 0)) {
    const e = pickFrom(w.events, true);
    if (e) return e;
  }
  const list = isObj(data.week) ? data.week[weekdayOf(day)] : null;
  return pickFrom(list, true) || pickFrom(list, false) || fallback;
}

export class EventSystem {
  /**
   * @param {object} data     public/data/events.json
   * @param {object} o        { missions: MissionSystem, shift: ShiftSystem, weather: WeatherSystem, rand }
   */
  constructor(data, o = {}) {
    this.data = isObj(data) ? data : { events: [] };
    this.events = (Array.isArray(this.data.events) ? this.data.events : []).filter(e => isObj(e) && e.id);
    this.byId = new Map(this.events.map(e => [e.id, e]));
    this.missions = o.missions || null;
    this.shift = o.shift || null;
    this.weather = o.weather || null;
    this.rand = o.rand || Math.random;
    this.baseSchedule = null;
    this.day = -1;
    this.today = null;
    this.recent = [];   // event ids of the previous days (newest last)
    this._weatherTimer = 0;
    /** (mergedSchedule) => void: MatchSystem.setSchedule + MissionGenerator.setSchedule. */
    this.onScheduleChange = null;
    /** (event, day) => void: a new day's event was chosen (HUD label). */
    this.onEventChange = null;
    if (this.missions) this.missions.getEvent = () => this.getToday();
  }

  /** The unmodified schedule.json (the event's matches are merged on top). */
  setBaseSchedule(schedule) {
    this.baseSchedule = isObj(schedule) ? schedule : null;
    this._applySchedule();
  }

  /** Today's event definition (picks one lazily when the day changed). */
  getToday() {
    this._ensureDay();
    return this.today;
  }

  getTodayId() { const e = this.getToday(); return e ? e.id : null; }

  /** "Saturday · Member Tournament" style label parts for the HUD / report. */
  describe() {
    const e = this.getToday();
    const day = (this.weather && this.weather.day) || 1;
    return e ? { id: e.id, title: e.title || e.id, label: e.label || e.title || e.id, icon: e.icon || '', weekday: weekdayName(day), announce: e.announce || '' } : null;
  }

  _ensureDay() {
    const day = (this.weather && this.weather.day) || 1;
    if (day === this.day && this.today) return;
    const fresh = this.day !== -1 || !this.today; // a real new day (not a restored one)
    if (this.today && this.day !== -1 && day !== this.day) {
      this.recent.push(this.today.id);
      if (this.recent.length > 2) this.recent.splice(0, this.recent.length - 2);
    }
    this.day = day;
    this.today = pickEvent(this.data, day, this.recent, this.rand);
    this._apply(fresh);
  }

  /** Push today's modifiers into the systems. `fresh` = a new day (force its weather). */
  _apply(fresh) {
    const e = this.today || {};
    if (this.missions) this.missions.eventDispatchScale = clamp(e.dispatchRate, 0.25, 3, 1);
    if (this.shift) {
      this.shift.eventTipMultiplier = clamp(e.tipMultiplier, 0.5, 3, 1);
      this.shift.eventGroomBonusMultiplier = clamp(e.groomBonusMultiplier, 1, 5, 1);
    }
    if (fresh && e.weather && this.weather && typeof this.weather.setWeather === 'function' && WEATHERS.includes(e.weather)) {
      try { this.weather.setWeather(e.weather, true); } catch (err) { /* cosmetic */ }
    }
    this._applySchedule();
    if (this.onEventChange) {
      try { this.onEventChange(this.today, this.day); } catch (err) { console.warn('onEventChange failed:', err); }
    }
  }

  _applySchedule() {
    if (!this.baseSchedule || !this.onScheduleChange || !this.today) return;
    try { this.onScheduleChange(mergeSchedule(this.baseSchedule, this.today)); } catch (err) { console.warn('EventSystem schedule failed:', err); }
  }

  /** Per frame: notice a new day; hold the event's weather through the morning. */
  update(dt) {
    this._ensureDay();
    const e = this.today;
    if (!e || !e.weather || !this.weather) return;
    this._weatherTimer -= dt;
    if (this._weatherTimer > 0) return;
    this._weatherTimer = 20;
    const until = Number.isFinite(e.weatherUntil) ? e.weatherUntil : 12;
    if (this.weather.timeOfDay < until && this.weather.weather !== e.weather && WEATHERS.includes(e.weather)) {
      try { this.weather.setWeather(e.weather); } catch (err) { /* cosmetic */ }
    }
  }

  getState() {
    return { day: this.day, id: this.today ? this.today.id : null, recent: this.recent.slice(-2) };
  }

  /** Restore (after the clock / day). A saved event for the current day is kept. */
  setState(s) {
    if (!isObj(s)) return;
    this.recent = Array.isArray(s.recent) ? s.recent.filter(id => this.byId.has(id)).slice(-2) : [];
    const day = (this.weather && this.weather.day) || 1;
    if (s.day === day && this.byId.has(s.id)) {
      this.day = day;
      this.today = this.byId.get(s.id);
      this._apply(false);
    } else {
      this.day = -1;
      this.today = null;
      this._ensureDay();
    }
  }
}

/**
 * Problems with public/data/events.json. `templateIds` / `missionIds`: known ids for boosts;
 * `facts` + `baseSchedule`: each event's merged schedule is checked with validateSchedule.
 */
export function validateEvents(data, { templateIds = null, missionIds = null, facts = {}, baseSchedule = null } = {}) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  if (!isObj(data)) { err('events.json is not an object'); return out; }
  if (!Array.isArray(data.events) || !data.events.length) { err('needs a non-empty "events" array'); return out; }
  const ids = new Set();
  for (const [i, e] of data.events.entries()) {
    const at = `events[${i}]${isObj(e) && e.id ? ` (${e.id})` : ''}`;
    if (!isObj(e) || typeof e.id !== 'string' || !e.id) { err(`${at}: needs an "id"`); continue; }
    if (ids.has(e.id)) err(`${at}: duplicate id`);
    ids.add(e.id);
    if (!e.title) err(`${at}: needs a "title"`);
    if (!e.announce) warn(`${at}: no "announce" text for the clock-in radio card`);
    const num = (k, lo, hi) => { if (e[k] !== undefined && !(Number.isFinite(e[k]) && e[k] >= lo && e[k] <= hi)) err(`${at}: ${k} must be ${lo}..${hi}`); };
    num('dispatchRate', 0.25, 3); num('tipMultiplier', 0.5, 3); num('groomBonusMultiplier', 1, 5); num('boardSize', 2, 4);
    num('weatherUntil', 0, 24);
    if (e.minDay !== undefined && !(Number.isInteger(e.minDay) && e.minDay >= 1)) err(`${at}: minDay must be an integer >= 1`);
    if (e.weather !== undefined && !WEATHERS.includes(e.weather)) err(`${at}: weather must be one of ${WEATHERS.join('/')}`);
    for (const [k, known] of [['templateBoost', templateIds], ['missionBoost', missionIds]]) {
      if (e[k] === undefined) continue;
      if (!isObj(e[k])) { err(`${at}: ${k} must be { id: multiplier }`); continue; }
      for (const [id, v] of Object.entries(e[k])) {
        if (!(Number.isFinite(v) && v >= 0)) err(`${at}: ${k}.${id} must be a number >= 0`);
        if (known && !known.has(id)) err(`${at}: ${k} refers to unknown ${k === 'templateBoost' ? 'template' : 'mission'} "${id}"`);
      }
    }
    if (e.schedule !== undefined) {
      if (!isObj(e.schedule)) err(`${at}: schedule must be an object`);
      else if (baseSchedule) {
        for (const p of validateSchedule(mergeSchedule(baseSchedule, e), facts)) (p.level === 'error' ? err : warn)(`${at} schedule: ${p.msg}`);
      }
    }
  }
  const week = data.week;
  if (!isObj(week)) err('needs a "week" object { mon: [...], ..., sun: [...] }');
  else {
    for (const d of WEEKDAYS) {
      const list = week[d];
      if (!Array.isArray(list) || !list.length) { err(`week.${d} needs a non-empty list of event ids`); continue; }
      for (const x of list) {
        const id = typeof x === 'string' ? x : isObj(x) ? x.id : null;
        if (!ids.has(id)) err(`week.${d}: unknown event "${id}"`);
        if (isObj(x) && x.weight !== undefined && !(x.weight >= 0)) err(`week.${d}: weight for "${id}" must be >= 0`);
      }
    }
    for (const k of Object.keys(week)) if (!WEEKDAYS.includes(k)) warn(`week.${k} is not a weekday (${WEEKDAYS.join(', ')})`);
  }
  if (data.firstDay !== undefined && !ids.has(data.firstDay)) err(`firstDay "${data.firstDay}" is not an event`);
  if (data.fallback !== undefined && !ids.has(data.fallback)) err(`fallback "${data.fallback}" is not an event`);
  if (data.wildcard !== undefined) {
    const w = data.wildcard;
    if (!isObj(w) || !(w.chance >= 0 && w.chance <= 1)) err('wildcard.chance must be 0..1');
    else for (const x of Array.isArray(w.events) ? w.events : []) {
      const id = typeof x === 'string' ? x : isObj(x) ? x.id : null;
      if (!ids.has(id)) err(`wildcard: unknown event "${id}"`);
    }
  }
  return out;
}
