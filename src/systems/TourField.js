/**
 * TourField — the pure parts of the Junior Tennis Tour (no DOM, no three.js: Node-importable for
 * `npm run validate` and headless tests). TourSystem (the game-side state machine) builds on it.
 *
 *   normalizeTourData(raw)            tour.json → a safe, fully defaulted structure (null when unusable)
 *   generateField(data, seed, npc)    the seeded field: ~64 generated juniors, the club juniors, adults
 *   rngFor(seed, key)                 an order-independent seeded RNG per event / match / week
 *   effectiveRating(...)              rating + drift + weekly form + surface preference + style
 *   serveWinProb / simulateMatch      point-by-point match simulation (TennisScore rules)
 *   buildDrawSlots / drawRound*       brackets: seeding (standard separation), byes, rounds
 *   blendDifficulty(anchors, rating)  Rafa's easy / medium / hard DIFFICULTY → a tour opponent's
 *   applyMods(target, mods)           style / player modifiers on a DIFFICULTY-like object
 *   validateTour(raw, facts)          schema checks for scripts/validate-data.mjs
 *
 * Rating scale (calibrated against Coach Rafa): ~1100 ≈ Rafa Easy, ~1450 ≈ Medium, ~1750 ≈ Hard,
 * the best juniors ~1850, the Pro Circuit's adults ~1900–2000. Only the generated field has ratings;
 * the player's skill is their real play (the player's own "tour rating" is an Elo of real results).
 */

import { TennisScore } from '../tennis/TennisScore.js';

export const VENUE_IDS = ['cedar_park', 'maple_hollow', 'harbor_point', 'ashford_lawn', 'sunridge_academy', 'metro_center'];
/** Tiers from the weakest to the strongest. */
export const TIER_ORDER = ['local', 'regional', 'national', 'pro'];
export const TOUR_SURFACES = ['hard', 'clay', 'grass'];
export const TOUR_WINDS = ['calm', 'breeze', 'gusty'];
export const TOUR_FORMATS = ['short', 'set', 'bo3'];
export const STYLE_KEYS = ['baseliner', 'counterpuncher', 'bigServer', 'serveVolleyer', 'moonballer', 'allCourt'];
export const DRAW_SIZES = [8, 16, 32];
/** Finishing rounds, strongest first: W = title, F = runner-up, SF… = lost in that round. */
export const FINISH_CODES = ['W', 'F', 'SF', 'QF', 'R16', 'R32'];
export const ROUND_LABELS = {
  R64: 'Round of 64', R32: 'Round of 32', R16: 'Round of 16', QF: 'Quarterfinal', SF: 'Semifinal', F: 'Final', W: 'Champion',
};
export const LOOK_FENCES = ['chainlink', 'windscreen', 'hedge'];
export const LOOK_BACKDROPS = ['city', 'forest', 'harbor', 'lawn', 'campus', 'night'];
export const LOOK_CLUBHOUSES = ['shed', 'lodge', 'boathouse', 'pavilion', 'modern', 'arena'];
export const LOOK_TREES = ['pine', 'maple', 'oak', 'none'];
export const LOOK_SIDES = ['north', 'south', 'east', 'west'];
/** Rafa's DIFFICULTY anchors on the rating scale. */
export const RATING_ANCHORS = { easy: 1100, medium: 1450, hard: 1750 };
/** Weekly points ring per player (the ranking window must fit in it). */
export const RING = 12;

const HEX = /^#[0-9a-f]{6}$/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const mod = (a, n) => ((a % n) + n) % n;
const strOr = (v, d) => (typeof v === 'string' && v.trim() ? v : d);
const numOr = (v, d, lo = -Infinity, hi = Infinity) => (fin(v) ? clamp(v, lo, hi) : d);
const intOr = (v, d, lo = -Infinity, hi = Infinity) => (Number.isInteger(v) ? clamp(v, lo, hi) : d);
const lines = (v, d = []) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : d);

// ───────────────────────────── seeded randomness ─────────────────────────────

/** FNV-1a 32-bit hash of a string. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32: a small fast seeded PRNG → () => [0, 1). */
export function mulberry32(a) {
  let s = a >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded RNG for one keyed thing (a match, a week's form, a draw): the same seed + key always
 * gives the same sequence, whatever order things are simulated in.
 */
export function rngFor(seed, key) {
  return mulberry32((hashStr(key) ^ Math.imul((seed >>> 0) || 1, 0x9E3779B1)) >>> 0);
}

export function gauss(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function weightedKey(entries, rand) {
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, w);
  if (total <= 0) return entries.length ? entries[0][0] : null;
  let x = rand() * total;
  for (const [k, w] of entries) { x -= Math.max(0, w); if (x <= 0) return k; }
  return entries[entries.length - 1][0];
}

// ───────────────────────────── data ─────────────────────────────

const DEFAULT_TIERS = {
  local: { label: 'Local', points: { W: 100, F: 65, SF: 40, QF: 22, R16: 10, R32: 5 }, prize: null, fee: 20, cutoff: null,
    formats: { R32: 'short', R16: 'short', QF: 'short', SF: 'set', F: 'set' }, draws: [8, 16, 32] },
  regional: { label: 'Regional', points: { W: 250, F: 160, SF: 100, QF: 55, R16: 28, R32: 14 }, prize: { W: 250, F: 150, SF: 80, QF: 40 }, fee: 45, cutoff: 60,
    formats: { R32: 'short', R16: 'short', QF: 'set', SF: 'set', F: 'set' }, draws: [16, 32] },
  national: { label: 'National', points: { W: 500, F: 320, SF: 200, QF: 110, R16: 55, R32: 28 }, prize: { W: 600, F: 350, SF: 200, QF: 100, R16: 50 }, fee: 90, cutoff: 28,
    formats: { R32: 'short', R16: 'set', QF: 'set', SF: 'set', F: 'bo3' }, draws: [16, 32] },
  pro: { label: 'Pro Circuit', points: { W: 800, F: 500, SF: 300, QF: 160, R16: 80, R32: 40 }, prize: { W: 2000, F: 1100, SF: 600, QF: 320, R16: 160, R32: 80 }, fee: 150, cutoff: null,
    formats: { R32: 'set', R16: 'set', QF: 'set', SF: 'set', F: 'bo3' }, draws: [16, 32], careers: ['pro'], juniors: 6 },
};

const DEFAULT_STYLE = {
  label: 'All-court', weight: 1, blurb: '',
  sim: { serve: 0, return: 0, surface: {} },
  ai: {},
  scout: { strengths: [], weaknesses: [], plan: [] },
};

const DEFAULT_FIRST_M = ['Mateo', 'Aarav', 'Kenji', 'Luca', 'Noah', 'Diego', 'Kwame', 'Omar'];
const DEFAULT_FIRST_F = ['Sofia', 'Amara', 'Chloe', 'Zara', 'Ines', 'Elena', 'Freya', 'Mei'];
const DEFAULT_LAST = ['Marquez', 'Okonkwo', 'Novak', 'Tanaka', 'Haddad', 'Lindqvist', 'Silva', 'Mensah', 'Petrov', 'Duarte', 'Fischer', 'Rossi'];

// ───────────────────────────── pronouns ─────────────────────────────

/** 'm' | 'f' | 'x' (x: names given without a gender → they / them / their). */
export const GENDERS = ['m', 'f', 'x'];
export const PRONOUNS = {
  m: { he: 'he', him: 'him', his: 'his', "he's": "he's", himself: 'himself' },
  f: { he: 'she', him: 'her', his: 'her', "he's": "she's", himself: 'herself' },
  x: { he: 'they', him: 'them', his: 'their', "he's": "they're", himself: 'themself' },
};
/** The tokens scouting / note texts may use: {he} {him} {his} {he's} {himself}, capitalised too. */
export const PRONOUN_TOKEN = /\{(he|him|his|he's|himself|He|Him|His|He's|Himself)\}/g;
const ANY_TOKEN = /\{[^{}]*\}/g;

/** Fill a text's pronoun tokens for a player's gender ("Bring {him} forward" → "Bring her forward"). */
export function genderize(text, gender) {
  const P = PRONOUNS[gender] || PRONOUNS.x;
  return String(text == null ? '' : text).replace(PRONOUN_TOKEN, (m, k) => {
    const w = P[k.toLowerCase()];
    return k[0] === 'H' ? w[0].toUpperCase() + w.slice(1) : w;
  });
}

function normPointsTable(v, d) {
  const out = {};
  const src = isObj(v) ? v : d;
  for (const c of FINISH_CODES) {
    const x = src && src[c];
    if (fin(x) && x >= 0) out[c] = Math.round(x);
    else if (d && fin(d[c])) out[c] = d[c];
  }
  return out;
}

function normTier(key, raw) {
  const d = DEFAULT_TIERS[key];
  const t = isObj(raw) ? raw : {};
  const formats = {};
  const fsrc = isObj(t.formats) ? t.formats : d.formats;
  for (const c of ['R64', 'R32', 'R16', 'QF', 'SF', 'F']) {
    const f = fsrc[c] ?? d.formats[c];
    formats[c] = TOUR_FORMATS.includes(f) ? f : (c === 'F' || c === 'SF' ? 'set' : 'short');
  }
  const draws = Array.isArray(t.draws) ? t.draws.filter(n => DRAW_SIZES.includes(n)) : d.draws;
  return {
    key,
    label: strOr(t.label, d.label),
    points: normPointsTable(t.points, d.points),
    prize: t.prize === null ? null : (isObj(t.prize) ? normPointsTable(t.prize, null) : (t.prize === undefined ? d.prize : null)),
    fee: Math.round(numOr(t.fee, d.fee, 0, 1e6)),
    cutoff: t.cutoff === null ? null : (Number.isInteger(t.cutoff) && t.cutoff >= 1 ? t.cutoff : (t.cutoff === undefined ? d.cutoff : null)),
    formats,
    draws: draws.length ? draws : d.draws,
    careers: Array.isArray(t.careers) ? t.careers.filter(c => typeof c === 'string') : (d.careers || null),
    juniors: intOr(t.juniors, d.juniors || 0, 0, 32),
  };
}

function normStyle(raw) {
  const s = isObj(raw) ? raw : {};
  const sim = isObj(s.sim) ? s.sim : {};
  const surf = {};
  if (isObj(sim.surface)) for (const k of TOUR_SURFACES) if (fin(sim.surface[k])) surf[k] = clamp(sim.surface[k], -300, 300);
  const sc = isObj(s.scout) ? s.scout : {};
  return {
    label: strOr(s.label, DEFAULT_STYLE.label),
    weight: numOr(s.weight, 1, 0, 100),
    blurb: strOr(s.blurb, ''),
    sim: { serve: numOr(sim.serve, 0, -0.2, 0.2), return: numOr(sim.return, 0, -0.2, 0.2), surface: surf },
    ai: isObj(s.ai) ? s.ai : {},
    scout: { strengths: lines(sc.strengths), weaknesses: lines(sc.weaknesses), plan: lines(sc.plan) },
  };
}

/**
 * tour.json → a fully defaulted structure the TourSystem can trust (bad entries are dropped,
 * missing ones defaulted). Returns null when `raw` is not an object.
 */
export function normalizeTourData(raw) {
  if (!isObj(raw)) return null;
  const d = {};
  d.unlock = { rafaWins: intOr(raw.unlock && raw.unlock.rafaWins, 3, 1, 99) };
  const r = isObj(raw.rafa) ? raw.rafa : {};
  d.rafa = {
    npc: strOr(r.npc, 'rafa_ibarra'),
    offer: lines(r.offer, ['You beat me three times. You should play competitively. Let me coach you. What do you say?']),
    session: strOr(r.session, 'You should play competitively. Let me coach you.'),
    accept: lines(r.accept, ['Vamos! Every week there is a tournament. We start with the local events.']),
    later: lines(r.later, ['Bueno. The offer stands.']),
    remind: lines(r.remind, ['My offer stands. Are you ready?']),
  };
  if (!d.rafa.offer.length) d.rafa.offer = ['You should play competitively. Let me coach you. What do you say?'];
  const h = isObj(raw.hank) ? raw.hank : {};
  const ch = lines(h.choices);
  d.hank = {
    npc: strOr(h.npc, 'hank_morris'),
    rank: intOr(h.rank, 10, 1, 999),
    askAgainDays: intOr(h.askAgainDays, 3, 1, 60),
    ask: lines(h.ask, ['Top ten, kid. So: play competitive tennis, or take over my job?']),
    choices: ch.length === 3 ? ch : ['Play competitive tennis', 'Take over your role', 'Let me think'],
    pro: lines(h.pro, ['Then go and play. The club pays your entry fees.']),
    grounds: lines(h.grounds, ['Here are the shed keys. The grounds are yours.']),
    think: lines(h.think, ['Take your time. I will ask again in a few days.']),
    retired: lines(h.retired, []),
  };
  if (!d.hank.ask.length) d.hank.ask = ['So: play competitive tennis, or take over my job?'];
  const car = isObj(raw.careers) ? raw.careers : {};
  const cp = isObj(car.pro) ? car.pro : {}, cg = isObj(car.grounds) ? car.grounds : {};
  d.careers = {
    pro: { title: strOr(cp.title, 'Touring Pro'), gearDiscount: numOr(cp.gearDiscount, 0.25, 0, 0.9), sponsoredFees: cp.sponsoredFees !== false },
    grounds: { title: strOr(cg.title, 'Head Groundskeeper'), wageMul: numOr(cg.wageMul, 1.25, 1, 5), groomBonusMul: numOr(cg.groomBonusMul, 1.5, 1, 10) },
  };
  const rk = isObj(raw.ranking) ? raw.ranking : {};
  const window = intOr(rk.window, 8, 1, RING);
  d.ranking = { window, bestOf: intOr(rk.bestOf, 6, 1, window) };

  d.tiers = {};
  const rt = isObj(raw.tiers) ? raw.tiers : {};
  for (const k of TIER_ORDER) d.tiers[k] = normTier(k, rt[k]);

  const wk = isObj(raw.week) ? raw.week : {};
  const bg = isObj(wk.background) ? wk.background : {};
  const bgSize = (v, dflt) => (Number.isInteger(v) && v >= 4 && v <= 64 && (v & (v - 1)) === 0 ? v : (v === 0 ? 0 : dflt));
  d.week = {
    background: { national: bgSize(bg.national, 16), regional: bgSize(bg.regional, 32), local: bgSize(bg.local, 16) },
    backgroundPoints: numOr(wk.backgroundPoints, 1, 0.1, 1),
    restChance: numOr(wk.restChance, 0.2, 0, 0.6),
    jitter: numOr(wk.jitter, 3, 0, 20),
  };

  const f = isObj(raw.field) ? raw.field : {};
  const sim = isObj(f.sim) ? f.sim : {};
  const ages = Array.isArray(f.ages) && f.ages.length === 2 && f.ages.every(Number.isInteger) && f.ages[0] <= f.ages[1] ? f.ages : [13, 18];
  const rmin = numOr(f.ratingMin, 950, 400, 3000), rmax = numOr(f.ratingMax, 1840, 400, 3000);
  d.field = {
    juniors: intOr(f.juniors, 64, 8, 160),
    ratingMean: numOr(f.ratingMean, 1360, 400, 3000),
    ratingSd: numOr(f.ratingSd, 170, 0, 800),
    ratingMin: Math.min(rmin, rmax), ratingMax: Math.max(rmin, rmax),
    ages,
    formSd: numOr(f.formSd, 35, 0, 300),
    femaleShare: numOr(f.femaleShare, 0.5, 0, 1),
    prefBonus: numOr(f.prefBonus, 35, 0, 300),
    weakMalus: numOr(f.weakMalus, 30, 0, 300),
    drift: numOr(f.drift, 6, 0, 64),
    sim: {
      serveBase: numOr(sim.serveBase, 0.6, 0.4, 0.8),
      proServeBase: numOr(sim.proServeBase, 0.63, 0.4, 0.85),
      k: numOr(sim.k, 0.0008, 0, 0.05),
    },
  };

  // Venues: the six remote clubs (look blocks are passed through for the venues builder), the home club
  d.venues = [];
  const seenV = new Set();
  for (const v of Array.isArray(raw.venues) ? raw.venues : []) {
    if (!isObj(v) || typeof v.id !== 'string' || seenV.has(v.id)) continue;
    seenV.add(v.id);
    d.venues.push({
      ...v,
      name: strOr(v.name, v.id), short: strOr(v.short, strOr(v.name, v.id)),
      surface: TOUR_SURFACES.includes(v.surface) ? v.surface : 'hard',
      wind: TOUR_WINDS.includes(v.wind) ? v.wind : 'calm',
      blurb: strOr(v.blurb, ''),
      look: isObj(v.look) ? v.look : {},
    });
  }
  const hv = isObj(raw.homeVenue) ? raw.homeVenue : null;
  d.homeVenue = hv && typeof hv.id === 'string' ? {
    id: hv.id, name: strOr(hv.name, 'Greenbriar Tennis & Social Club'), short: strOr(hv.short, 'Greenbriar'),
    court: strOr(hv.court, 'court6'), courtLabel: strOr(hv.courtLabel, 'Centre Court'),
    surface: TOUR_SURFACES.includes(hv.surface) ? hv.surface : 'grass', wind: TOUR_WINDS.includes(hv.wind) ? hv.wind : 'calm',
    blurb: strOr(hv.blurb, ''), home: true,
  } : null;
  d.venueById = new Map(d.venues.map(v => [v.id, v]));
  if (d.homeVenue && !d.venueById.has(d.homeVenue.id)) d.venueById.set(d.homeVenue.id, d.homeVenue);

  // Tournaments: the weekly rotation (amateur by weekSlot, pro alternating on the pro path)
  d.tournaments = [];
  const seenT = new Set();
  for (const t of Array.isArray(raw.tournaments) ? raw.tournaments : []) {
    if (!isObj(t) || typeof t.id !== 'string' || seenT.has(t.id)) continue;
    const tier = d.tiers[t.tier];
    const venue = d.venueById.get(t.venue);
    if (!tier || !venue) continue;
    seenT.add(t.id);
    let draw = DRAW_SIZES.includes(t.draw) ? t.draw : 16;
    if (!tier.draws.includes(draw)) draw = tier.draws.reduce((b, n) => (Math.abs(n - draw) < Math.abs(b - draw) ? n : b), tier.draws[0]);
    const circuit = t.tier === 'pro' ? 'pro' : (t.circuit === 'pro' ? 'pro' : 'amateur');
    d.tournaments.push({
      id: t.id, name: strOr(t.name, t.id), venue: venue.id, tier: tier.key, draw,
      weekSlot: intOr(t.weekSlot, d.tournaments.length, 0, 999), circuit,
      home: !!t.home || !!venue.home,
      wind: TOUR_WINDS.includes(t.wind) ? t.wind : venue.wind,
      surface: venue.surface,
      blurb: strOr(t.blurb, venue.blurb || ''),
    });
  }
  const bySlot = (a, b) => a.weekSlot - b.weekSlot || (a.id < b.id ? -1 : 1);
  d.amateur = d.tournaments.filter(t => t.circuit === 'amateur').sort(bySlot);
  d.pro = d.tournaments.filter(t => t.circuit === 'pro').sort(bySlot);
  d.tournamentById = new Map(d.tournaments.map(t => [t.id, t]));

  d.styles = {};
  const rs = isObj(raw.styles) ? raw.styles : {};
  for (const [k, v] of Object.entries(rs)) if (isObj(v)) d.styles[k] = normStyle(v);
  for (const k of STYLE_KEYS) if (!d.styles[k]) d.styles[k] = normStyle({ label: k, weight: 1 });
  d.styleKeys = Object.keys(d.styles);

  // First names by gender (firstM / firstF); a plain `first` list is gender-neutral ('x')
  const nm = isObj(raw.names) ? raw.names : {};
  const fm = lines(nm.firstM), ff = lines(nm.firstF), fx = lines(nm.first), last = lines(nm.last);
  d.names = { m: fm, f: ff, x: fm.length || ff.length ? [] : fx, last: last.length ? last : DEFAULT_LAST };
  if (!fm.length && !ff.length && !fx.length) { d.names.m = DEFAULT_FIRST_M; d.names.f = DEFAULT_FIRST_F; }
  d.clubs = lines(raw.clubs, ['Riverside Racquet Club']);
  if (!d.clubs.length) d.clubs = ['Riverside Racquet Club'];
  d.shirtColors = lines(raw.shirtColors).filter(c => HEX.test(c));
  if (!d.shirtColors.length) d.shirtColors = ['#c0392b', '#2e86c1', '#27ae60', '#8e44ad', '#f39c12', '#16a085'];

  const person = (p) => ({
    npc: p.npc,
    rating: numOr(p.rating, 1400, 400, 3000),
    style: d.styles[p.style] ? p.style : 'allCourt',
    age: intOr(p.age, 16, 5, 60),
    surface: TOUR_SURFACES.includes(p.surface) ? p.surface : null,
    club: strOr(p.club, 'Greenbriar'),
    gender: GENDERS.includes(p.gender) ? p.gender : 'x',
    note: strOr(p.note, ''),
    ai: isObj(p.ai) ? p.ai : null,
    localOnly: !!p.localOnly,
    wildcardChance: numOr(p.wildcardChance, 0.5, 0, 1),
    home: !!p.home,
  });
  d.clubJuniors = [];
  const seenCJ = new Set();
  for (const p of Array.isArray(raw.clubJuniors) ? raw.clubJuniors : []) {
    if (!isObj(p) || typeof p.npc !== 'string' || seenCJ.has(p.npc)) continue;
    seenCJ.add(p.npc);
    d.clubJuniors.push(person(p));
  }
  const ad = isObj(raw.adults) ? raw.adults : {};
  const rr = Array.isArray(ad.ratingRange) && ad.ratingRange.length === 2 && ad.ratingRange.every(fin) ? ad.ratingRange.slice().sort((a, b) => a - b) : [1760, 2020];
  const aa = Array.isArray(ad.ages) && ad.ages.length === 2 && ad.ages.every(Number.isInteger) && ad.ages[0] <= ad.ages[1] ? ad.ages : [19, 31];
  d.adults = { count: intOr(ad.count, 24, 0, 64), ratingRange: rr, ages: aa, named: [] };
  for (const p of Array.isArray(ad.named) ? ad.named : []) {
    if (!isObj(p) || typeof p.npc !== 'string' || seenCJ.has(p.npc)) continue;
    seenCJ.add(p.npc);
    d.adults.named.push(person(p));
  }
  return d;
}

// ───────────────────────────── the field ─────────────────────────────

const titleCase = (id) => String(id).split(/[_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const pad2 = (n) => (n < 10 ? '0' + n : String(n));

/**
 * The tour's players, rebuilt from the seed on every load (only dynamic state is saved).
 * npcInfo(id) → { name, shirtColor } | null resolves club members (npcs.json).
 * Returns { players: Map(id → player), juniors: [ids], adults: [ids], clubIds: Set }.
 *   player = { id, name, first, last, short, gender ('m' | 'f' | 'x'), club, age, rating, style, pref, weak, npcId, adult,
 *              localOnly, wildcardChance, home, shirtColor, lookSeed, ai, note }
 */
export function generateField(d, seed, npcInfo = () => null) {
  const rand = rngFor(seed, 'field');
  const players = new Map();
  const juniors = [], adults = [];
  const clubIds = new Set();
  const usedFull = new Set(), usedShort = new Set();
  const f = d.field;
  const styleEntries = d.styleKeys.map(k => [k, d.styles[k].weight]);
  const N = d.names;
  const pickGender = () => {
    if (N.m.length && N.f.length) return rand() < f.femaleShare ? 'f' : 'm';
    return N.f.length ? 'f' : N.m.length ? 'm' : 'x';
  };
  const pickName = () => {
    const gender = pickGender();
    const pool = gender === 'f' ? N.f : gender === 'm' ? N.m : N.x;
    for (let tries = 0; tries < 400; tries++) {
      const first = pool[Math.floor(rand() * pool.length)];
      const last = N.last[Math.floor(rand() * N.last.length)];
      const full = `${first} ${last}`, short = `${first[0]}. ${last}`;
      if (!usedFull.has(full) && !usedShort.has(short)) { usedFull.add(full); usedShort.add(short); return { first, last, gender }; }
    }
    const n = usedFull.size + 1;
    const first = pool[n % pool.length], last = `${N.last[n % N.last.length]} ${n}`;
    usedFull.add(`${first} ${last}`); usedShort.add(`${first[0]}. ${last}`);
    return { first, last, gender };
  };
  const surfacePrefs = () => {
    const x = rand();
    const pref = x < 0.45 ? 'hard' : x < 0.8 ? 'clay' : 'grass';
    const others = TOUR_SURFACES.filter(s => s !== pref);
    const weak = rand() < 0.6 ? others[Math.floor(rand() * others.length)] : null;
    return { pref, weak };
  };
  const make = (id, nm, extra) => {
    const p = {
      id, name: `${nm.first} ${nm.last}`, first: nm.first, last: nm.last, short: `${nm.first[0]}. ${nm.last}`,
      gender: nm.gender || 'x',
      club: d.clubs[Math.floor(rand() * d.clubs.length)],
      age: 16, rating: 1400, style: 'allCourt', pref: null, weak: null, npcId: null, adult: false,
      localOnly: false, wildcardChance: 0, home: false,
      shirtColor: d.shirtColors[Math.floor(rand() * d.shirtColors.length)],
      lookSeed: Math.floor(rand() * 4294967296) >>> 0,
      ai: null, note: '',
      ...extra,
    };
    players.set(id, p);
    return p;
  };

  // Generated juniors: ratings on a deterministic spread (logistic quantiles + a little noise), shuffled
  const n = f.juniors;
  const ratings = [];
  for (let i = 0; i < n; i++) {
    const q = (i + 0.5) / n;
    const z = 0.5513 * Math.log(q / (1 - q));
    ratings.push(clamp(f.ratingMean + f.ratingSd * z + (rand() - 0.5) * 40, f.ratingMin, f.ratingMax));
  }
  shuffleInPlace(ratings, rand);
  for (let i = 0; i < n; i++) {
    const nm = pickName();
    const sp = surfacePrefs();
    const p = make(`j${pad2(i + 1)}`, nm, {
      rating: Math.round(ratings[i]),
      style: weightedKey(styleEntries, rand) || 'allCourt',
      age: f.ages[0] + Math.floor(rand() * (f.ages[1] - f.ages[0] + 1)),
      pref: sp.pref, weak: sp.weak,
    });
    juniors.push(p.id);
  }

  // Club juniors (members of the club): fixed ratings / styles from the data
  const member = (cj, adult) => {
    const info = npcInfo(cj.npc) || null;
    const name = (info && info.name) || titleCase(cj.npc);
    const parts = name.replace(/^(Dr|Mr|Mrs|Ms|Coach)\.?\s+/i, '').split(' ');
    const first = parts[0], last = parts.slice(1).join(' ') || parts[0];
    const others = TOUR_SURFACES.filter(s => s !== cj.surface);
    const p = make(cj.npc, { first, last, gender: cj.gender }, {
      name, short: `${first[0]}. ${last}`, club: cj.club, age: cj.age, rating: Math.round(cj.rating), style: cj.style,
      pref: cj.surface, weak: cj.surface ? others[Math.floor(rand() * others.length)] : null,
      npcId: cj.npc, adult, localOnly: cj.localOnly, wildcardChance: cj.wildcardChance, home: cj.home,
      shirtColor: (info && HEX.test(info.shirtColor || '') ? info.shirtColor : null) || d.shirtColors[0],
      ai: cj.ai, note: cj.note,
    });
    usedFull.add(p.name); usedShort.add(p.short);
    clubIds.add(p.id);
    return p;
  };
  for (const cj of d.clubJuniors) juniors.push(member(cj, false).id);

  // Pro Circuit adults: the named club members first, then generated ones
  for (const a of d.adults.named) adults.push(member(a, true).id);
  const na = d.adults.count;
  const [lo, hi] = d.adults.ratingRange;
  for (let i = 0; i < na; i++) {
    const nm = pickName();
    const sp = surfacePrefs();
    const q = (i + 0.5) / Math.max(1, na);
    const p = make(`a${pad2(i + 1)}`, nm, {
      rating: Math.round(clamp(lo + (hi - lo) * q + (rand() - 0.5) * 30, lo, hi)),
      style: weightedKey(styleEntries, rand) || 'allCourt',
      age: d.adults.ages[0] + Math.floor(rand() * (d.adults.ages[1] - d.adults.ages[0] + 1)),
      pref: sp.pref, weak: sp.weak, adult: true,
    });
    adults.push(p.id);
  }
  return { players, juniors, adults, clubIds };
}

/** Weekly form (rating points): the same for a player all week, fresh every week. */
export function formOf(seed, id, week, sd) {
  if (!(sd > 0)) return 0;
  return clamp(gauss(rngFor(seed, `form:${id}:${week}`)) * sd, -2.5 * sd, 2.5 * sd);
}

/** Surface adjustment (rating points): preferred / weak surface plus the style's surface edge. */
export function surfaceAdj(d, p, surface) {
  let a = 0;
  if (p.pref && p.pref === surface) a += d.field.prefBonus;
  else if (p.weak && p.weak === surface) a -= d.field.weakMalus;
  const st = d.styles[p.style];
  if (st && fin(st.sim.surface[surface])) a += st.sim.surface[surface];
  return a;
}

/** A player's strength this week on this surface: rating + drift + form + surface. */
export function effectiveRating(d, seed, p, week, surface, drift = 0) {
  return p.rating + drift + formOf(seed, p.id, week, d.field.formSd) + surfaceAdj(d, p, surface);
}

// ───────────────────────────── match simulation ─────────────────────────────

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * P(the server wins a point): logistic in the effective rating difference (k per rating point),
 * from a base hold rate plus the server's serve edge and the returner's return edge (styles).
 */
export function serveWinProb(base, k, effServer, effReturner, styleServer = null, styleReturner = null) {
  const b = clamp(base + (styleServer ? styleServer.sim.serve : 0) - (styleReturner ? styleReturner.sim.return : 0), 0.3, 0.85);
  return clamp(sigmoid(logit(b) + k * (effServer - effReturner)), 0.15, 0.93);
}

/** "6-4 7-6(5)" from player `w`'s point of view. */
export function scoreLine(sets, w) {
  const out = [];
  for (const s of sets) {
    let t = `${s.g[w]}-${s.g[1 - w]}`;
    if (s.tb) t += `(${Math.min(s.tb[0], s.tb[1])})`;
    out.push(t);
  }
  return out.join(' ');
}

/**
 * Point-by-point match between A (0) and B (1): pA / pB = each one's chance to win a point on
 * their own serve. format: 'short' | 'set' | 'bo3' (TennisScore rules: tiebreaks, no-ad nothing).
 * Returns { winner: 0 | 1, sets: [{ g, tb }], score (winner's view), points: [a, b] }.
 */
export function simulateMatch(rand, pA, pB, format = 'set') {
  const sc = new TennisScore({ format, firstServer: rand() < 0.5 ? 0 : 1 });
  let guard = 0;
  while (!sc.done && guard++ < 4000) {
    const s = sc.currentServer;
    const p = s === 0 ? pA : pB;
    sc.pointTo(rand() < p ? s : 1 - s);
  }
  let winner = sc.winner;
  if (winner !== 0 && winner !== 1) winner = sc.totalPoints[0] >= sc.totalPoints[1] ? 0 : 1;
  const sets = sc.sets.map(s => ({ g: [s.g[0], s.g[1]], tb: s.tb ? [s.tb[0], s.tb[1]] : null }));
  return { winner, sets, score: scoreLine(sets, winner), points: [sc.totalPoints[0], sc.totalPoints[1]] };
}

// ───────────────────────────── draws ─────────────────────────────

export const roundsOf = (size) => Math.round(Math.log2(size));

/** Round code of round index r (0 = first) in a draw of `size`: …, 'QF', 'SF', 'F'. */
export function roundCode(size, r) {
  const codes = ['F', 'SF', 'QF', 'R16', 'R32', 'R64'];
  return codes[roundsOf(size) - 1 - r] || `R${size >> r}`;
}

export const matchOffset = (size, r) => size - size / (1 << r);
export const matchesIn = (size, r) => size / (1 << (r + 1));

/** Classic bracket order: virtual seed k sits at bracketOrder(size).indexOf(k). */
export function bracketOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2 + 1;
    const next = [];
    for (const s of order) next.push(s, n - s);
    order = next;
  }
  return order;
}

/**
 * Slots for a draw of `size`: `seeded` (best first) take the seed lines (1 and 2 in different
 * halves, 1–4 in different quarters …), the others are shuffled into the rest; missing entrants
 * become byes (null), which always meet the top seeds.
 */
export function buildDrawSlots(size, seeded, others, rand) {
  const order = bracketOrder(size);
  const list = seeded.concat(shuffleInPlace(others.slice(), rand));
  const slots = new Array(size).fill(null);
  for (let i = 0; i < size; i++) slots[i] = list[order[i] - 1] ?? null;
  return slots;
}

/** Whoever won match (r, i): an id, null (a bye / empty line) or undefined (not decided yet). */
export function drawWinner(draw, r, i) {
  const res = draw.res[matchOffset(draw.size, r) + i];
  if (!res || res[0] < 0) return undefined;
  const [a, b] = drawParticipants(draw, r, i);
  return res[0] === 0 ? a : b;
}

/** The two participants of match (r, i): ids, null (bye) or undefined (the previous match is pending). */
export function drawParticipants(draw, r, i) {
  if (r === 0) return [draw.slots[2 * i] ?? null, draw.slots[2 * i + 1] ?? null];
  return [drawWinner(draw, r - 1, 2 * i), drawWinner(draw, r - 1, 2 * i + 1)];
}

// ───────────────────────────── opponents' difficulty ─────────────────────────────

function lerpTree(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => lerpTree(x, b[i] ?? x, t));
  if (isObj(a) && isObj(b)) {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k in a && k in b) out[k] = lerpTree(a[k], b[k], t);
      else out[k] = clone(k in a ? a[k] : b[k]);
    }
    return out;
  }
  return clone(t < 0.5 ? (a === undefined ? b : a) : (b === undefined ? a : b));
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) { const o = {}; for (const k in v) o[k] = clone(v[k]); return o; }
  return v;
}

const mapNum = (v, fn) => (typeof v === 'number' ? fn(v) : Array.isArray(v) ? v.map(x => (typeof x === 'number' ? fn(x) : x)) : v);

/**
 * Apply modifiers to a DIFFICULTY-like object in place: `key: n` adds n, `key: { mul, add }`
 * scales then adds, `key: { set }` replaces; nested objects (serve / ret) recurse; arrays change
 * every element. Keys the target doesn't have are ignored (the table may grow or shrink).
 */
export function applyMods(target, mods) {
  if (!isObj(target) || !isObj(mods)) return target;
  for (const [k, m] of Object.entries(mods)) {
    if (k[0] === '_' || !(k in target)) continue;
    const cur = target[k];
    if (fin(m)) target[k] = mapNum(cur, (x) => x + m);
    else if (isObj(m) && ('mul' in m || 'add' in m || 'set' in m)) {
      if (fin(m.set)) target[k] = mapNum(cur, () => m.set);
      else {
        const mul = fin(m.mul) ? m.mul : 1, add = fin(m.add) ? m.add : 0;
        target[k] = mapNum(cur, (x) => x * mul + add);
      }
    } else if (isObj(m) && isObj(cur)) applyMods(cur, m);
  }
  return target;
}

/** Keep every number inside what the three anchors make plausible (shares 0..1, rates ≥ 0, no runaway). */
function clampTree(out, anchors) {
  const walk = (o, as) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      const av = as.map(a => (a ? a[k] : undefined));
      if (typeof v === 'number') o[k] = clampNum(v, av);
      else if (Array.isArray(v)) o[k] = v.map((x, i) => (typeof x === 'number' ? clampNum(x, av.map(a => (Array.isArray(a) ? a[i] : undefined))) : x));
      else if (isObj(v)) walk(v, av.map(a => (isObj(a) ? a : null)));
    }
  };
  walk(out, anchors);
}

function clampNum(v, anchorVals) {
  if (!Number.isFinite(v)) {
    const f = anchorVals.find(fin);
    return fin(f) ? f : 0;
  }
  const nums = anchorVals.filter(fin);
  if (!nums.length) return v;
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const span = Math.max(hi - lo, 0.25 * Math.abs(hi), 1e-3);
  let x = clamp(v, lo - span, hi + span);
  if (lo >= 0) x = Math.max(x, lo > 0 ? lo * 0.35 : 0);
  if (lo >= 0 && hi <= 1) x = clamp(x, 0, 1);
  return x;
}

/**
 * A tour opponent's AI table: Rafa's difficulties (`anchors` = { easy, medium, hard }, e.g.
 * difficultyFor(key, surface) of each) interpolated by rating (1100 ≈ easy, 1450 medium, 1750 hard,
 * extrapolated up to 60 % of a step beyond hard for the best juniors and the pros, a little below
 * easy for the weakest), then `mods` (style, player) applied in order. Always a fresh object with
 * the anchors' shape; numbers are kept plausible (shares 0..1, nothing negative, no runaway).
 */
export function blendDifficulty(anchors, rating, mods = [], extra = {}) {
  const r = fin(rating) ? rating : RATING_ANCHORS.medium;
  const A = RATING_ANCHORS;
  let a, b, t;
  if (r <= A.easy) { a = anchors.easy; b = anchors.medium; t = -Math.min(0.5, (A.easy - r) / 700); }
  else if (r <= A.medium) { a = anchors.easy; b = anchors.medium; t = (r - A.easy) / (A.medium - A.easy); }
  else if (r <= A.hard) { a = anchors.medium; b = anchors.hard; t = (r - A.medium) / (A.hard - A.medium); }
  else { a = anchors.medium; b = anchors.hard; t = 1 + Math.min(0.6, (r - A.hard) / 500); }
  const out = lerpTree(a, b, t);
  for (const m of mods) if (isObj(m)) applyMods(out, m);
  clampTree(out, [anchors.easy, anchors.medium, anchors.hard]);
  return Object.assign(out, extra);
}

/** A rating in words (the scouting report / the results card). */
export function levelLabel(rating) {
  if (!fin(rating)) return 'Unknown';
  if (rating < 1200) return 'Rafa-on-Easy level';
  if (rating < 1400) return 'Between Rafa Easy and Medium';
  if (rating < 1550) return 'Rafa-on-Medium level';
  if (rating < 1700) return 'Between Rafa Medium and Hard';
  if (rating < 1800) return 'Rafa-on-Hard level';
  return 'Stronger than Rafa on Hard';
}

// ───────────────────────────── validation (npm run validate) ─────────────────────────────

/**
 * Schema checks for tour.json. facts: { npcIds: Set, courts: [{ id, type }], stadiumCourtId }.
 * Returns [{ level: 'error' | 'warn', msg }].
 */
export function validateTour(raw, facts = {}) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  if (!isObj(raw)) { err('must be a JSON object'); return out; }
  const npcIds = facts.npcIds instanceof Set ? facts.npcIds : null;
  const courts = Array.isArray(facts.courts) ? facts.courts : null;
  const strs = (a) => Array.isArray(a) && a.every(x => typeof x === 'string' && x.trim());

  if (!(raw.unlock && Number.isInteger(raw.unlock.rafaWins) && raw.unlock.rafaWins >= 1)) err('unlock.rafaWins must be a whole number ≥ 1');
  const h = raw.hank;
  if (!isObj(h)) err('hank must be an object');
  else {
    if (!(Number.isInteger(h.rank) && h.rank >= 1)) err('hank.rank must be a whole number ≥ 1');
    if (!(Number.isInteger(h.askAgainDays) && h.askAgainDays >= 1)) err('hank.askAgainDays must be a whole number ≥ 1');
    if (npcIds && !npcIds.has(h.npc)) err(`hank.npc "${h.npc}" is not an npcs.json id`);
    for (const k of ['ask', 'pro', 'grounds', 'think']) if (!strs(h[k]) || !h[k].length) err(`hank.${k} must be a non-empty array of lines`);
    if (h.choices !== undefined && !(strs(h.choices) && h.choices.length === 3)) err('hank.choices must be three strings (play / take over / think)');
    if (h.retired !== undefined && !strs(h.retired)) err('hank.retired must be an array of lines');
  }
  const r = raw.rafa;
  if (!isObj(r)) err('rafa must be an object');
  else {
    if (npcIds && !npcIds.has(r.npc)) err(`rafa.npc "${r.npc}" is not an npcs.json id`);
    for (const k of ['offer', 'accept', 'later']) if (!strs(r[k]) || !r[k].length) err(`rafa.${k} must be a non-empty array of lines`);
    if (typeof r.session !== 'string' || !r.session.trim()) err('rafa.session must be a line of text');
  }
  if (raw.careers !== undefined) {
    const c = raw.careers;
    if (!isObj(c)) err('careers must be an object { pro, grounds }');
    else {
      if (isObj(c.pro) && c.pro.gearDiscount !== undefined && !(fin(c.pro.gearDiscount) && c.pro.gearDiscount >= 0 && c.pro.gearDiscount < 1)) err('careers.pro.gearDiscount must be 0..1');
      if (isObj(c.grounds)) for (const k of ['wageMul', 'groomBonusMul']) if (c.grounds[k] !== undefined && !(fin(c.grounds[k]) && c.grounds[k] >= 1)) err(`careers.grounds.${k} must be a number ≥ 1`);
    }
  }
  const rk = raw.ranking;
  if (isObj(rk)) {
    if (!(Number.isInteger(rk.window) && rk.window >= 1 && rk.window <= RING)) err(`ranking.window must be 1..${RING} weeks`);
    if (!(Number.isInteger(rk.bestOf) && rk.bestOf >= 1 && rk.bestOf <= (rk.window || 8))) err('ranking.bestOf must be 1..window');
  } else warn('ranking: missing (best 6 of the last 8 weeks)');

  // tiers
  const tiers = isObj(raw.tiers) ? raw.tiers : null;
  if (!tiers) err('tiers must be an object');
  for (const k of TIER_ORDER) {
    const t = tiers && tiers[k];
    const at = `tiers.${k}`;
    if (!isObj(t)) { err(`${at}: missing`); continue; }
    if (typeof t.label !== 'string' || !t.label) err(`${at}.label must be a string`);
    const pts = t.points;
    if (!isObj(pts)) err(`${at}.points must be an object { W, F, SF, QF, R16, R32 }`);
    else {
      let last = Infinity;
      for (const c of FINISH_CODES) {
        if (pts[c] === undefined) { if (c !== 'R32' && c !== 'R16') err(`${at}.points.${c} is missing`); continue; }
        if (!(Number.isInteger(pts[c]) && pts[c] >= 0)) err(`${at}.points.${c} must be a whole number ≥ 0`);
        else if (pts[c] >= last) err(`${at}.points must decrease by round (${c} ${pts[c]} ≥ the round above ${last})`);
        else last = pts[c];
      }
    }
    if (t.prize !== null && t.prize !== undefined) {
      if (!isObj(t.prize)) err(`${at}.prize must be null or an object { W, F, … }`);
      else {
        let last = Infinity;
        for (const c of FINISH_CODES) {
          if (t.prize[c] === undefined) continue;
          if (!(fin(t.prize[c]) && t.prize[c] >= 0)) err(`${at}.prize.${c} must be a number ≥ 0`);
          else if (t.prize[c] > last) err(`${at}.prize must not increase for earlier rounds (${c})`);
          else last = t.prize[c];
        }
        if (k === 'local' && Object.keys(t.prize).length) warn(`${at}.prize: local events are meant to pay no prize money`);
      }
    }
    if (!(fin(t.fee) && t.fee >= 0)) err(`${at}.fee must be a number ≥ 0`);
    if (!(t.cutoff === null || (Number.isInteger(t.cutoff) && t.cutoff >= 1))) err(`${at}.cutoff must be null (open) or a ranking ≥ 1`);
    if (!isObj(t.formats)) err(`${at}.formats must be an object { R32, R16, QF, SF, F }`);
    else for (const [c, f] of Object.entries(t.formats)) if (!TOUR_FORMATS.includes(f)) err(`${at}.formats.${c} must be one of ${TOUR_FORMATS.join(' / ')}`);
    if (!(Array.isArray(t.draws) && t.draws.length && t.draws.every(n => DRAW_SIZES.includes(n)))) err(`${at}.draws must list draw sizes from ${DRAW_SIZES.join(' / ')}`);
    if (t.careers !== undefined && !(Array.isArray(t.careers) && t.careers.every(c => ['amateur', 'pro', 'grounds'].includes(c)))) err(`${at}.careers must list amateur / pro / grounds`);
  }
  if (tiers && isObj(tiers.pro) && tiers.pro.juniors !== undefined && !(Number.isInteger(tiers.pro.juniors) && tiers.pro.juniors >= 0)) err('tiers.pro.juniors must be a whole number ≥ 0');

  // venues
  const venues = Array.isArray(raw.venues) ? raw.venues : null;
  const venueIds = new Set();
  if (!venues) err('venues must be an array');
  for (const [i, v] of (venues || []).entries()) {
    const at = `venues[${i}]${v && v.id ? ` (${v.id})` : ''}`;
    if (!isObj(v) || typeof v.id !== 'string') { err(`${at}: needs a string id`); continue; }
    if (venueIds.has(v.id)) err(`${at}: duplicate venue id`);
    venueIds.add(v.id);
    if (!VENUE_IDS.includes(v.id)) err(`${at}: unknown venue id (the venues builder knows ${VENUE_IDS.join(', ')})`);
    for (const k of ['name', 'short']) if (typeof v[k] !== 'string' || !v[k].trim()) err(`${at}.${k} must be a string`);
    if (!TOUR_SURFACES.includes(v.surface)) err(`${at}.surface must be ${TOUR_SURFACES.join(' / ')}`);
    if (!TOUR_WINDS.includes(v.wind)) err(`${at}.wind must be ${TOUR_WINDS.join(' / ')}`);
    const L = v.look;
    if (!isObj(L)) { err(`${at}.look must be an object`); continue; }
    for (const k of ['court', 'surround', 'fenceColor', 'ground']) if (!HEX.test(L[k] || '')) err(`${at}.look.${k} must be "#RRGGBB"`);
    if (!LOOK_FENCES.includes(L.fence)) err(`${at}.look.fence must be ${LOOK_FENCES.join(' / ')}`);
    if (!LOOK_BACKDROPS.includes(L.backdrop)) err(`${at}.look.backdrop must be ${LOOK_BACKDROPS.join(' / ')}`);
    const st = L.stands;
    if (!isObj(st) || !(Number.isInteger(st.rows) && st.rows >= 0 && st.rows <= 20) || !(Array.isArray(st.sides) && st.sides.every(s => LOOK_SIDES.includes(s)))) {
      err(`${at}.look.stands must be { rows: 0..20, sides: [${LOOK_SIDES.join(', ')}] }`);
    }
    const ch = L.clubhouse;
    if (!isObj(ch) || !LOOK_CLUBHOUSES.includes(ch.style) || !HEX.test(ch.color || '') || !HEX.test(ch.roof || '') || !LOOK_SIDES.includes(ch.side)) {
      err(`${at}.look.clubhouse must be { style: ${LOOK_CLUBHOUSES.join(' | ')}, color, roof ("#RRGGBB"), side }`);
    }
    const tr = L.trees;
    if (!isObj(tr) || !LOOK_TREES.includes(tr.kind) || !(Number.isInteger(tr.count) && tr.count >= 0 && tr.count <= 200)) {
      err(`${at}.look.trees must be { kind: ${LOOK_TREES.join(' | ')}, count: 0..200, autumn? }`);
    }
    if (typeof L.lights !== 'boolean') err(`${at}.look.lights must be true / false`);
    if (!strs(L.sponsors)) err(`${at}.look.sponsors must be an array of banner texts`);
    else for (const s of L.sponsors) if (s.length > 24) warn(`${at}.look.sponsors: "${s}" is long for a banner (> 24 chars)`);
    if (!(fin(L.crowd) && L.crowd >= 0 && L.crowd <= 1)) err(`${at}.look.crowd must be 0..1`);
  }
  for (const id of VENUE_IDS) if (venues && !venueIds.has(id)) err(`venues: "${id}" is missing (the venues builder expects all six)`);

  // home venue (the club itself)
  const hv = raw.homeVenue;
  let homeId = null;
  if (hv !== undefined) {
    if (!isObj(hv) || typeof hv.id !== 'string') err('homeVenue must be { id, name, court, surface }');
    else {
      homeId = hv.id;
      if (venueIds.has(hv.id)) err(`homeVenue.id "${hv.id}" clashes with a remote venue id`);
      if (courts) {
        const c = courts.find(k => k.id === hv.court);
        if (!c) err(`homeVenue.court "${hv.court}" is not a map.json court id`);
        else if (hv.surface && c.type && c.type !== hv.surface) warn(`homeVenue.surface "${hv.surface}" differs from ${hv.court}'s type "${c.type}"`);
        if (facts.stadiumCourtId && hv.court !== facts.stadiumCourtId) warn(`homeVenue.court "${hv.court}" is not the club's show court (${facts.stadiumCourtId})`);
      }
    }
  }

  // tournaments
  const tours = Array.isArray(raw.tournaments) ? raw.tournaments : null;
  if (!tours || !tours.length) err('tournaments must be a non-empty array');
  const tIds = new Set();
  const slots = { amateur: new Set(), pro: new Set() };
  let nAm = 0, nHome = 0;
  for (const [i, t] of (tours || []).entries()) {
    const at = `tournaments[${i}]${t && t.id ? ` (${t.id})` : ''}`;
    if (!isObj(t) || typeof t.id !== 'string') { err(`${at}: needs a string id`); continue; }
    if (tIds.has(t.id)) err(`${at}: duplicate tournament id`);
    tIds.add(t.id);
    if (typeof t.name !== 'string' || !t.name.trim()) err(`${at}.name must be a string`);
    if (!venueIds.has(t.venue) && t.venue !== homeId) err(`${at}.venue "${t.venue}" is not a venue id (or the homeVenue)`);
    const tier = tiers && tiers[t.tier];
    if (!tier) { err(`${at}.tier "${t.tier}" is not one of ${TIER_ORDER.join(' / ')}`); continue; }
    if (!DRAW_SIZES.includes(t.draw)) err(`${at}.draw must be ${DRAW_SIZES.join(' / ')}`);
    else if (Array.isArray(tier.draws) && !tier.draws.includes(t.draw)) err(`${at}.draw ${t.draw} is not allowed for the ${t.tier} tier (${tier.draws.join(', ')})`);
    if (!(Number.isInteger(t.weekSlot) && t.weekSlot >= 0)) err(`${at}.weekSlot must be a whole number ≥ 0`);
    const circuit = t.tier === 'pro' ? 'pro' : (t.circuit || 'amateur');
    if (t.tier === 'pro' && t.circuit !== undefined && t.circuit !== 'pro') err(`${at}: a pro-tier event must have circuit "pro"`);
    if (t.circuit === 'pro' && t.tier !== 'pro') err(`${at}: circuit "pro" events must be pro tier`);
    if (!['amateur', 'pro'].includes(circuit)) err(`${at}.circuit must be amateur / pro`);
    else if (slots[circuit].has(t.weekSlot)) err(`${at}.weekSlot ${t.weekSlot} is used twice in the ${circuit} rotation`);
    else slots[circuit].add(t.weekSlot);
    if (t.venue === 'metro_center' && t.tier !== 'pro') err(`${at}: Metro Tennis Center hosts pro events only`);
    if (circuit === 'amateur') nAm++;
    if (t.home) { nHome++; if (t.venue !== homeId) err(`${at}: a home event must be played at the homeVenue (${homeId})`); }
    if (t.wind !== undefined && !TOUR_WINDS.includes(t.wind)) err(`${at}.wind must be ${TOUR_WINDS.join(' / ')}`);
    if (tier && isObj(tier.formats) && DRAW_SIZES.includes(t.draw)) {
      for (let rr = 0; rr < roundsOf(t.draw); rr++) {
        const c = roundCode(t.draw, rr);
        if (!TOUR_FORMATS.includes(tier.formats[c])) err(`${at}: the ${t.tier} tier has no format for round ${c}`);
        if (isObj(tier.points) && !Number.isInteger(tier.points[c])) err(`${at}: the ${t.tier} tier has no points for round ${c}`);
      }
    }
  }
  if (tours && !nAm) err('tournaments: needs at least one amateur event');
  if (tours && !nHome) warn('tournaments: no home event (the club\'s own tournament)');
  if (tours && !tours.some(t => t && t.tier === 'pro')) warn('tournaments: no Pro Circuit events (the pro path would have none)');

  // styles
  const styles = isObj(raw.styles) ? raw.styles : null;
  if (!styles) err('styles must be an object');
  for (const k of STYLE_KEYS) if (styles && !styles[k]) warn(`styles.${k} is missing (a default is used)`);
  const checkMods = (m, at) => {
    if (!isObj(m)) { err(`${at} must be an object of modifiers`); return; }
    for (const [k, v] of Object.entries(m)) {
      if (fin(v)) continue;
      if (isObj(v) && ('mul' in v || 'add' in v || 'set' in v)) {
        for (const q of ['mul', 'add', 'set']) if (q in v && !fin(v[q])) err(`${at}.${k}.${q} must be a number`);
        continue;
      }
      if (isObj(v)) { checkMods(v, `${at}.${k}`); continue; }
      err(`${at}.${k} must be a number, { mul / add / set } or a nested object`);
    }
  };
  // Texts about a player: pronouns as tokens ({he} {him} {his} {he's} {himself}, capitalised too)
  const BARE = /\b(he|him|his|himself|she|her|hers|herself)\b/i;
  const checkTokens = (line, at) => {
    for (const t of String(line).match(ANY_TOKEN) || []) {
      if (!t.match(PRONOUN_TOKEN)) err(`${at}: unknown token ${t} in "${line}" (use {he} {him} {his} {he's} {himself})`);
    }
    const bare = String(line).replace(ANY_TOKEN, '').match(BARE);
    if (bare) warn(`${at}: "${bare[0]}" in "${line}" — write {he} / {him} / {his} so it fits every opponent`);
  };
  for (const [k, s] of Object.entries(styles || {})) {
    const at = `styles.${k}`;
    if (!isObj(s)) { err(`${at} must be an object`); continue; }
    if (typeof s.label !== 'string' || !s.label) err(`${at}.label must be a string`);
    if (s.weight !== undefined && !(fin(s.weight) && s.weight >= 0)) err(`${at}.weight must be ≥ 0`);
    if (s.sim !== undefined) {
      if (!isObj(s.sim)) err(`${at}.sim must be an object`);
      else {
        for (const q of ['serve', 'return']) if (s.sim[q] !== undefined && !(fin(s.sim[q]) && Math.abs(s.sim[q]) <= 0.2)) err(`${at}.sim.${q} must be -0.2..0.2`);
        if (s.sim.surface !== undefined) {
          if (!isObj(s.sim.surface)) err(`${at}.sim.surface must be { hard, clay, grass }`);
          else for (const [q, v] of Object.entries(s.sim.surface)) if (!TOUR_SURFACES.includes(q) || !fin(v)) err(`${at}.sim.surface.${q} must be a surface → rating points`);
        }
      }
    }
    if (s.ai !== undefined) checkMods(s.ai, `${at}.ai`);
    if (s.scout !== undefined) {
      if (!isObj(s.scout)) err(`${at}.scout must be { strengths, weaknesses, plan }`);
      else {
        for (const q of ['strengths', 'weaknesses', 'plan']) if (!strs(s.scout[q]) || !s.scout[q].length) err(`${at}.scout.${q} must be a non-empty array of lines`);
        for (const q of ['strengths', 'weaknesses', 'plan']) for (const line of strs(s.scout[q]) ? s.scout[q] : []) checkTokens(line, `${at}.scout.${q}`);
      }
    }
  }

  // names (first names by gender: firstM / firstF; a plain `first` list reads as they / them), clubs, colours
  const nm = raw.names;
  const fm = isObj(nm) && strs(nm.firstM) ? nm.firstM : [], ff = isObj(nm) && strs(nm.firstF) ? nm.firstF : [];
  const fx = isObj(nm) && strs(nm.first) ? nm.first : [];
  if (!isObj(nm) || !(fm.length || ff.length || fx.length) || !strs(nm.last) || !nm.last.length) {
    err('names must be { firstM: [...], firstF: [...], last: [...] } (or a gender-neutral first: [...])');
  } else {
    if (isObj(nm) && ((nm.firstM !== undefined && !strs(nm.firstM)) || (nm.firstF !== undefined && !strs(nm.firstF)))) err('names.firstM / firstF must be arrays of names');
    if (fm.length || ff.length) {
      if (fm.length < 10 || ff.length < 10) warn(`names: ${fm.length} male / ${ff.length} female first names (the field needs variety in both)`);
      const both = fm.filter(x => ff.includes(x));
      if (both.length) warn(`names: ${both.join(', ')} listed as both male and female`);
    } else if (fx.length < 20) warn(`names.first has only ${fx.length} names (the field needs variety)`);
    if (nm.last.length < 20) warn(`names.last has only ${nm.last.length} names (the field needs variety)`);
    const fieldN = (isObj(raw.field) && Number.isInteger(raw.field.juniors) ? raw.field.juniors : 64) + (isObj(raw.adults) && Number.isInteger(raw.adults.count) ? raw.adults.count : 24);
    const firsts = fm.length || ff.length ? Math.min(fm.length || Infinity, ff.length || Infinity) * 2 : fx.length;
    if (firsts * nm.last.length < fieldN * 3) warn('names: few first × last combinations for the field size (names may repeat)');
  }
  if (!strs(raw.clubs) || !raw.clubs.length) err('clubs must be a non-empty array of club names');
  if (raw.shirtColors !== undefined && !(Array.isArray(raw.shirtColors) && raw.shirtColors.length && raw.shirtColors.every(c => HEX.test(c)))) err('shirtColors must be "#RRGGBB" colours');

  // field
  const f = raw.field;
  if (isObj(f)) {
    if (!(Number.isInteger(f.juniors) && f.juniors >= 16 && f.juniors <= 160)) err('field.juniors must be 16..160');
    if (fin(f.ratingMin) && fin(f.ratingMax) && f.ratingMin >= f.ratingMax) err('field.ratingMin must be below ratingMax');
    if (f.femaleShare !== undefined && !(fin(f.femaleShare) && f.femaleShare >= 0 && f.femaleShare <= 1)) err('field.femaleShare must be 0..1');
    if (isObj(f.sim)) {
      if (!(fin(f.sim.serveBase) && f.sim.serveBase > 0.4 && f.sim.serveBase < 0.8)) err('field.sim.serveBase must be 0.4..0.8');
      if (!(fin(f.sim.k) && f.sim.k > 0 && f.sim.k < 0.05)) err('field.sim.k must be 0..0.05');
    }
  }
  const wk = raw.week;
  if (isObj(wk) && isObj(wk.background)) {
    for (const [k, v] of Object.entries(wk.background)) {
      if (!['national', 'regional', 'local'].includes(k)) err(`week.background.${k}: only national / regional / local background events exist`);
      else if (!(v === 0 || (Number.isInteger(v) && v >= 4 && v <= 64 && (v & (v - 1)) === 0))) err(`week.background.${k} must be 0 or a power of two 4..64`);
    }
  }

  // club juniors and adults
  const people = [];
  for (const [i, p] of (Array.isArray(raw.clubJuniors) ? raw.clubJuniors : []).entries()) people.push([`clubJuniors[${i}]`, p]);
  if (raw.clubJuniors !== undefined && !Array.isArray(raw.clubJuniors)) err('clubJuniors must be an array');
  const ad = raw.adults;
  if (ad !== undefined) {
    if (!isObj(ad)) err('adults must be an object { count, ratingRange, named }');
    else {
      if (!(Number.isInteger(ad.count) && ad.count >= 0 && ad.count <= 64)) err('adults.count must be 0..64');
      if (!(Array.isArray(ad.ratingRange) && ad.ratingRange.length === 2 && ad.ratingRange.every(fin) && ad.ratingRange[0] < ad.ratingRange[1])) err('adults.ratingRange must be [low, high]');
      for (const [i, p] of (Array.isArray(ad.named) ? ad.named : []).entries()) people.push([`adults.named[${i}]`, p]);
    }
  }
  const seen = new Set();
  for (const [at, p] of people) {
    if (!isObj(p) || typeof p.npc !== 'string') { err(`${at}: needs an "npc" id`); continue; }
    if (seen.has(p.npc)) err(`${at}: "${p.npc}" is listed twice`);
    seen.add(p.npc);
    if (npcIds && !npcIds.has(p.npc)) err(`${at}: "${p.npc}" is not an npcs.json id`);
    if (!(fin(p.rating) && p.rating >= 800 && p.rating <= 2300)) err(`${at}.rating must be 800..2300`);
    if (styles && !styles[p.style] && !STYLE_KEYS.includes(p.style)) err(`${at}.style "${p.style}" is not a style`);
    if (p.surface !== undefined && !TOUR_SURFACES.includes(p.surface)) err(`${at}.surface must be ${TOUR_SURFACES.join(' / ')}`);
    if (p.gender !== undefined && !GENDERS.includes(p.gender)) err(`${at}.gender must be ${GENDERS.join(' / ')}`);
    else if (p.gender === undefined) warn(`${at}: no gender ('m' / 'f'); scouting will say they / them`);
    if (typeof p.note === 'string') checkTokens(p.note, `${at}.note`);
    if (p.ai !== undefined) checkMods(p.ai, `${at}.ai`);
    if (p.wildcardChance !== undefined && !(fin(p.wildcardChance) && p.wildcardChance >= 0 && p.wildcardChance <= 1)) err(`${at}.wildcardChance must be 0..1`);
  }
  return out;
}
