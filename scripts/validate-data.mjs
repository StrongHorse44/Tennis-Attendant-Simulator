#!/usr/bin/env node
/**
 * Data validator for Court Call (no dependencies): `npm run validate`.
 *
 * Checks public/data/{map,npcs,missions}.json so a hand edit can't ship a mission that
 * soft-locks: every step action is supported, every target / location / npc / dialogue key
 * / item resolves, deliver steps have a matching pickup, random missions have a trigger NPC,
 * the shift section points at real missions, and every goTo / pickup / deliver / groom
 * target has a minimap pin. Exits 1 on any error (warnings don't fail).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildWorldFacts, validateMission, hasMarkerPoint } from '../src/systems/MissionValidation.js';
import { ITEMS } from '../src/systems/InventorySystem.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

for (const w of warnings) console.warn('warn  ' + w);
for (const e of errors) console.error('ERROR ' + e);
const n = map && missions && Array.isArray(missions.missions) ? missions.missions.length : 0;
console.log(`validate-data: ${n} missions checked, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
