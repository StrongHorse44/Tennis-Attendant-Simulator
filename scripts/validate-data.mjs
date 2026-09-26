#!/usr/bin/env node
/**
 * Data validator for Court Call (no dependencies): `npm run validate`.
 *
 * Checks public/data/{map,npcs,missions,schedule}.json so a hand edit can't ship a mission that
 * soft-locks: every step action is supported, every target / location / npc / dialogue key
 * / item resolves, deliver steps have a matching pickup, random missions have a trigger NPC,
 * the shift section points at real missions, and every goTo / pickup / deliver / groom
 * target has a minimap pin. schedule.json: known court / NPC ids, start < end, two players
 * per match, format ranges (validateSchedule). Exits 1 on any error (warnings don't fail).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildWorldFacts, validateMission, validateSchedule, hasMarkerPoint } from '../src/systems/MissionValidation.js';
import { ITEMS } from '../src/systems/InventorySystem.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEX = /^#[0-9a-f]{6}$/i;
const POOL_KEYS = new Set(['satisfied', 'neutral', 'unsatisfied', 'idle', 'morning', 'afternoon', 'evening', 'sunny', 'cloudy', 'rainy', 'windy', 'tips', 'hints']);
const TIMES = new Set(['morning', 'midday', 'afternoon', 'evening']);
const REL_TYPES = new Set(['family', 'spouse', 'friend', 'rival', 'mentor', 'student', 'colleague', 'acquaintance']);

/** Member data (npcs.json): ids, colours, small-talk pools, relationships, tennis, match lines. */
function validateNpcs(npcs, map) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  const list = Array.isArray(npcs.npcs) ? npcs.npcs.filter(n => n && n.id) : [];
  const ids = new Set(), names = new Set();
  for (const n of list) {
    if (ids.has(n.id)) err(`${n.id}: duplicate id`);
    if (names.has(n.name)) err(`${n.id}: duplicate name "${n.name}" (dialogue colours are looked up by name)`);
    ids.add(n.id); names.add(n.name);
  }
  const wpKeys = Object.keys((map && map.waypoints) || {}).map(k => k.toLowerCase());
  const strings = (arr) => Array.isArray(arr) && arr.every(x => typeof x === 'string' && x.trim());
  for (const n of list) {
    const at = n.id;
    if (!n.name) err(`${at}: needs a "name"`);
    if (!HEX.test(n.shirtColor || '')) err(`${at}: shirtColor must be "#RRGGBB"`);
    if (n.greetings !== undefined && !strings(n.greetings)) err(`${at}: greetings must be an array of strings`);
    for (const a of Array.isArray(n.preferredAreas) ? n.preferredAreas : []) {
      if (!wpKeys.some(k => k.includes(String(a).toLowerCase()))) warn(`${at}: preferred area "${a}" matches no map.json waypoint (they'll wander anywhere)`);
    }
    const pool = n.dialoguePool;
    if (pool !== undefined) {
      if (!pool || typeof pool !== 'object' || Array.isArray(pool)) err(`${at}: dialoguePool must be an object`);
      else for (const [k, v] of Object.entries(pool)) {
        if (!POOL_KEYS.has(k)) warn(`${at}: dialoguePool.${k} is never used (known: ${[...POOL_KEYS].join(', ')})`);
        if (!strings(v)) err(`${at}: dialoguePool.${k} must be an array of non-empty strings`);
      }
      if (pool && !Array.isArray(pool.idle)) warn(`${at}: no dialoguePool.idle small talk`);
      for (const line of (pool && Array.isArray(pool.hints)) ? pool.hints : []) {
        if (typeof line === 'string' && !(line.includes('{name}') && line.includes('{place}'))) err(`${at}: dialoguePool.hints line needs {name} and {place}: "${line}"`);
      }
    }
    // Staff duty (NPC.js parseDuty): every post / roam / break / patrol spot must be a waypoint
    const wps = (map && map.waypoints) || {};
    const spotOk = (ref, where) => {
      const key = typeof ref === 'string' ? ref : (ref && typeof ref === 'object' ? ref.spot : null);
      if (!key || !wps[key]) err(`${at}: ${where} spot "${key}" is not a map.json waypoint`);
      else if (ref && typeof ref === 'object' && typeof ref.face === 'string' && !wps[ref.face]) err(`${at}: ${where} faces unknown waypoint "${ref.face}"`);
    };
    if (n.post !== undefined) {
      if (!n.post || typeof n.post !== 'object') err(`${at}: post must be an object`);
      else {
        spotOk(n.post, 'post');
        for (const k of ['roam', 'breaks']) for (const r of Array.isArray(n.post[k]) ? n.post[k] : []) spotOk(r, `post.${k}`);
        for (const k of ['roamChance', 'breakChance']) if (n.post[k] !== undefined && !(n.post[k] >= 0 && n.post[k] <= 1)) err(`${at}: post.${k} must be 0..1`);
      }
    }
    if (n.patrol !== undefined) {
      if (!n.patrol || !Array.isArray(n.patrol.route) || n.patrol.route.length === 0) err(`${at}: patrol needs a non-empty "route" of waypoints`);
      else for (const r of n.patrol.route) spotOk(r, 'patrol.route');
    }
    if (n.preferredTime !== undefined && !TIMES.has(n.preferredTime)) err(`${at}: preferredTime must be one of ${[...TIMES].join('/')}`);
    if (n.tennis !== undefined) {
      const sk = n.tennis && n.tennis.skill;
      if (sk !== undefined && !(Number.isFinite(sk) && sk >= 0 && sk <= 1)) err(`${at}: tennis.skill must be 0..1`);
    }
    const rel = n.relationships;
    if (rel !== undefined) {
      if (!rel || typeof rel !== 'object' || Array.isArray(rel)) err(`${at}: relationships must be an object { npcId: { type, note } }`);
      else for (const [other, r] of Object.entries(rel)) {
        if (other === n.id) err(`${at}: relationship with itself`);
        else if (!ids.has(other)) err(`${at}: relationship with unknown npc "${other}"`);
        else {
          const back = list.find(x => x.id === other);
          if (!back.relationships || !back.relationships[n.id]) warn(`${at}: relationship with ${other} is one-sided`);
        }
        if (!r || !REL_TYPES.has(r.type)) err(`${at}: relationships.${other}.type must be one of ${[...REL_TYPES].join('/')}`);
      }
    }
    const ml = n.matchLines;
    if (ml !== undefined) {
      for (const k of ['win', 'lose']) {
        if (ml[k] === undefined) continue;
        if (!strings(ml[k])) err(`${at}: matchLines.${k} must be an array of strings`);
        else for (const line of ml[k]) if (line.length > 22) warn(`${at}: match line "${line}" is long for a speech bubble (> 22 chars)`);
      }
    }
  }
  return out;
}

const errors = [];
const warnings = [];

function load(name) {
  const path = join(root, 'public', 'data', name);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    errors.push(`${name}: ${e.message}`);
    return null;
  }
}

const map = load('map.json');
const npcs = load('npcs.json');
const missions = load('missions.json');
const schedule = load('schedule.json');

if (map && npcs && missions) {
  const facts = buildWorldFacts({ map, npcs, missions, items: ITEMS });
  const list = Array.isArray(missions.missions) ? missions.missions : [];
  const ids = new Set();

  // npcs.json
  const archetypes = npcs.archetypes || {};
  for (const n of npcs.npcs || []) {
    if (!n || !n.id) { errors.push('npcs.json: an NPC has no id'); continue; }
    if (!archetypes[n.archetype]) errors.push(`npcs.json ${n.id}: unknown archetype "${n.archetype}"`);
    if (!Array.isArray(n.greetings) || n.greetings.length === 0) warnings.push(`npcs.json ${n.id}: no greetings`);
  }
  for (const [k, a] of Object.entries(archetypes)) {
    if (!(a.tipChance >= 0 && a.tipChance <= 1)) errors.push(`npcs.json archetype ${k}: tipChance must be 0..1`);
    if (!Array.isArray(a.tipRange) || a.tipRange.length !== 2 || !(a.tipRange[0] <= a.tipRange[1])) errors.push(`npcs.json archetype ${k}: tipRange must be [min, max]`);
  }
  for (const [k, a] of Object.entries(archetypes)) {
    for (const f of ['nameTagColor', 'dialogueColor']) {
      if (a[f] !== undefined && !HEX.test(a[f])) errors.push(`npcs.json archetype ${k}: ${f} must be "#RRGGBB"`);
    }
    if (a.nameTagColor === undefined) warnings.push(`npcs.json archetype ${k}: no nameTagColor (name tag dot falls back to gold)`);
  }
  for (const p of validateNpcs(npcs, map)) (p.level === 'error' ? errors : warnings).push(`npcs.json ${p.msg}`);

  // storyline chains must not loop
  const byId = new Map(list.filter(m => m && m.id).map(m => [m.id, m]));
  for (const m of byId.values()) {
    const seen = new Set();
    const walk = (id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      const r = byId.get(id);
      return !!(r && Array.isArray(r.requires) && r.requires.some(walk));
    };
    if (Array.isArray(m.requires) && m.requires.some(walk) && seen.has(m.id)) errors.push(`missions.json ${m.id}: "requires" chain loops back to itself`);
  }

  // missions
  for (const m of list) {
    const id = (m && m.id) || '(no id)';
    if (ids.has(id)) errors.push(`missions.json ${id}: duplicate id`);
    ids.add(id);
    for (const p of validateMission(m, facts, missions.taskTypes)) {
      (p.level === 'error' ? errors : warnings).push(`missions.json ${id}: ${p.msg}`);
    }
    for (const [i, s] of (Array.isArray(m && m.steps) ? m.steps : []).entries()) {
      const t = s && (s.action === 'goTo' || s.action === 'groom' ? (s.target || s.location)
        : (s.action === 'pickup' || s.action === 'deliver') ? s.location : null);
      if (t && !hasMarkerPoint(map, t)) warnings.push(`missions.json ${id} step ${i}: "${t}" has no waypoint/area centre for the minimap pin`);
    }
  }

  // unused dialogue keys (warning only)
  const used = new Set();
  for (const m of list) for (const s of (m && m.steps) || []) if (s && s.dialogueKey) used.add(s.dialogueKey);
  for (const k of Object.keys(missions.dialogues || {})) if (!used.has(k)) warnings.push(`missions.json dialogue "${k}" is never used`);

  // shift section
  const shift = missions.shift;
  if (shift) {
    for (const key of ['openingMission', 'closingMission']) {
      const mid = shift[key];
      if (!mid) continue;
      const m = list.find(x => x && x.id === mid);
      if (!m) errors.push(`missions.json shift.${key}: mission "${mid}" not found`);
      else if (m.source !== 'shift') errors.push(`missions.json shift.${key}: mission "${mid}" must have source "shift"`);
    }
    if (!(shift.hourlyWage >= 0)) errors.push('missions.json shift.hourlyWage must be a number >= 0');
    const ranks = Array.isArray(shift.ranks) ? shift.ranks : [];
    if (ranks.length === 0) errors.push('missions.json shift.ranks: needs at least one rank');
    let last = -1;
    for (const [i, r] of ranks.entries()) {
      if (!r || !r.title) errors.push(`missions.json shift.ranks[${i}]: needs a title`);
      if (!(r && r.points >= 0) || r.points <= last) errors.push(`missions.json shift.ranks[${i}]: points must increase`);
      if (r) last = r.points;
    }
    if (ranks[0] && ranks[0].points !== 0) errors.push('missions.json shift.ranks[0]: the first rank must start at 0 points');
    for (const [i, w] of (shift.rushWindows || []).entries()) {
      if (!(w && w.start < w.end)) errors.push(`missions.json shift.rushWindows[${i}]: start must be before end`);
    }
  }
}

// schedule.json (MatchSystem)
let nMatches = 0;
if (map && npcs && schedule) {
  const facts = buildWorldFacts({ map, npcs, missions: missions || {}, items: ITEMS });
  nMatches = Array.isArray(schedule.matches) ? schedule.matches.length : 0;
  for (const p of validateSchedule(schedule, facts)) {
    (p.level === 'error' ? errors : warnings).push(`schedule.json ${p.msg}`);
  }
}

for (const w of warnings) console.warn('warn  ' + w);
for (const e of errors) console.error('ERROR ' + e);
const n = map && missions && Array.isArray(missions.missions) ? missions.missions.length : 0;
console.log(`validate-data: ${n} missions, ${nMatches} scheduled matches checked, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
