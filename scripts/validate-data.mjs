#!/usr/bin/env node
/**
 * Data validator for Court Call (no dependencies): `npm run validate`.
 *
 * Checks public/data/{map,npcs,missions,schedule}.json so a hand edit can't ship a mission that
 * soft-locks: every step action is supported, every target / location / npc / dialogue key
 * / item resolves, deliver steps have a matching pickup, random missions have a trigger NPC,
 * the shift section points at real missions, and every goTo / pickup / deliver / groom
 * target has a minimap pin. schedule.json: known court / NPC ids, start < end, two players
 * per match, format ranges (validateSchedule). missions.json → templates: shape
 * (validateTemplatesShape) plus sampled fills from every template through MissionGenerator,
 * each checked with validateMission. events.json: schema, boosts that name real templates /
 * missions, each event's merged schedule (validateEvents). shop.json: validateShop (ShopSystem.js).
 * map.json courts: unique ids, `type` hard / clay / grass, shared-surround flags. map.json
 * `bounds` and the sunken stadium court (validateGround): validateStadiumMap (StadiumLayout.js:
 * config ranges + the selfCheck invariants), court heights, paths / waypoints / item spots /
 * staff posts against the bowl's cut and footprint, the stadium court's own waypoints, preferred
 * areas that only name spots inside the bowl. Exits 1 on any error (warnings don't fail).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildWorldFacts, validateMission, validateSchedule, hasMarkerPoint } from '../src/systems/MissionValidation.js';
import { ITEMS } from '../src/systems/InventorySystem.js';
import { MissionGenerator, validateTemplatesShape, COURT_SURFACES } from '../src/systems/MissionGenerator.js';
import { validateEvents } from '../src/systems/EventSystem.js';
import { validateShop } from '../src/systems/ShopSystem.js';
import { validateStadiumMap, findStadiumCourt, computeStadiumLayout } from '../src/world/StadiumLayout.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEX = /^#[0-9a-f]{6}$/i;
const POOL_KEYS = new Set(['satisfied', 'neutral', 'unsatisfied', 'idle', 'morning', 'afternoon', 'evening', 'sunny', 'cloudy', 'rainy', 'windy', 'tips', 'hints']);
const TIMES = new Set(['morning', 'midday', 'afternoon', 'evening']);
const COURTSIDE_KEYS = new Set(['arrive', 'winner', 'ace', 'rally', 'rafa', 'error', 'game', 'matchWin', 'matchLose', 'drill', 'closeIn', 'closeOut']);
const REL_TYPES = new Set(['family', 'spouse', 'friend', 'rival', 'mentor', 'student', 'colleague', 'acquaintance']);

/** Member data (npcs.json): ids, colours, small-talk pools, relationships, tennis, match / courtside lines. */
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
    // Courtside lines (after-hours tennis spectators, src/tennis/TennisCrowd.js)
    const cs = n.courtside;
    if (cs !== undefined) {
      if (!cs || typeof cs !== 'object' || Array.isArray(cs)) err(`${at}: courtside must be an object { key: [lines] }`);
      else for (const [k, arr] of Object.entries(cs)) {
        if (!COURTSIDE_KEYS.has(k)) warn(`${at}: courtside.${k} is never used (known: ${[...COURTSIDE_KEYS].join(', ')})`);
        if (!strings(arr)) err(`${at}: courtside.${k} must be an array of non-empty strings`);
        else for (const line of arr) if (line.length > 22) warn(`${at}: courtside line "${line}" is long for a speech bubble (> 22 chars)`);
      }
    }
  }
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** True when segment a→b touches the closed rect r (Liang–Barsky). */
function segHitsRect(ax, az, bx, bz, r) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dz, az - r.z0) && clip(dz, r.z1 - az);
}

/** Distance from segment a→b to the rect r (0 when they touch). */
function segRectDist(ax, az, bx, bz, r) {
  if (segHitsRect(ax, az, bx, bz, r)) return 0;
  const toRect = (x, z) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const toSeg = (px, pz) => {
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    return Math.hypot(ax + t * dx - px, az + t * dz - pz);
  };
  return Math.min(toRect(ax, az), toRect(bx, bz), toSeg(r.x0, r.z0), toSeg(r.x1, r.z0), toSeg(r.x0, r.z1), toSeg(r.x1, r.z1));
}

/** Path ribbons (half width + this) must stay clear of a bowl's cut: the edging and end discs. */
const PATH_EDGE_EXTRA = 0.21;

/**
 * map.json `bounds` and the sunken stadium court (StadiumLayout): validateStadiumMap (config
 * ranges + selfCheck), court heights, then everything in map.json / npcs.json that has to agree
 * with the bowl: paths stay out of the footprint and their ribbons out of the cut; waypoints and
 * item spots inside the cut sit on its ground (groundAt), those outside at y ≈ 0; the stadium
 * court has `<id>_center` on the pit floor and `<id>_exit` outside the footprint (and ideally a
 * `<id>_bench`); staff posts / patrols stay out of the footprint; a preferred area that only
 * names spots inside the bowl leaves its member wandering anywhere. Without a stadium only the
 * flat-club checks run (bounds, court heights, waypoint heights).
 */
function validateGround(map, npcs) {
  const out = [];
  const err = (msg, file = 'map.json') => out.push({ level: 'error', msg: `${file} ${msg}` });
  const warn = (msg, file = 'map.json') => out.push({ level: 'warn', msg: `${file} ${msg}` });

  // bounds: { minX, maxX, minZ, maxZ } (World fence lines ± 5), or the legacy { width, depth }
  const b = map.bounds;
  const BK = ['minX', 'maxX', 'minZ', 'maxZ'];
  let fence = null;
  if (b === undefined) warn('bounds: missing (the club falls back to the old ±mapWidth/2 × ±mapDepth/2 fence)');
  else if (!isObj(b)) err('bounds must be { minX, maxX, minZ, maxZ }');
  else if (BK.some(k => b[k] !== undefined)) {
    if (!BK.every(k => fin(b[k]))) err('bounds: minX, maxX, minZ and maxZ must all be numbers');
    else if (!(b.minX < b.maxX && b.minZ < b.maxZ)) err('bounds: needs minX < maxX and minZ < maxZ');
    else fence = { x0: b.minX - 5, x1: b.maxX + 5, z0: b.minZ - 5, z1: b.maxZ + 5 };
  } else if (b.width !== undefined || b.depth !== undefined) {
    if (!(fin(b.width) && b.width > 0 && fin(b.depth) && b.depth > 0)) err('bounds: the legacy { width, depth } must be positive numbers');
    else fence = { x0: -b.width / 2 - 5, x1: b.width / 2 + 5, z0: -b.depth / 2 - 5, z1: b.depth / 2 + 5 };
  } else err('bounds must be { minX, maxX, minZ, maxZ } (or the legacy { width, depth })');

  // court heights: center.y sinks only a stadium court
  const courts = isObj(map.areas) && Array.isArray(map.areas.courts) ? map.areas.courts : [];
  for (const c of courts) {
    if (!isObj(c) || !c.id || !isObj(c.center) || c.center.y === undefined) continue;
    const y = c.center.y;
    if (!fin(y)) { err(`courts (${c.id}): center.y must be a number`); continue; }
    if (y < -6 || y > 0.5) err(`courts (${c.id}): center.y ${y} is outside -6..0.5`);
    else if (y < -0.5 && !isObj(c.stadium)) err(`courts (${c.id}): center.y ${y} sinks the court, which needs a "stadium" block (seats, aisles and the bowl around it)`);
  }

  // the stadium block itself (one stadium court, rotation 0, config ranges, selfCheck invariants)
  const st = validateStadiumMap(map);
  for (const m of st.errors) err(m);
  for (const m of st.warnings) warn(m);
  const sc = findStadiumCourt(map);
  let L = null;
  if (sc) { try { L = computeStadiumLayout(sc); } catch (e) { L = null; /* reported by validateStadiumMap */ } }
  const groundAt = (x, z) => (L ? L.groundAt(x, z) : 0);
  const inCut = (x, z) => !!L && L.inCut(x, z);
  const inFoot = (x, z) => !!L && L.inFootprint(x, z, 0);
  const wanderable = (x, z) => (L ? L.isWanderable(x, z) : fin(x) && fin(z));
  const wps = isObj(map.waypoints) ? map.waypoints : {};
  const wpOk = (w) => isObj(w) && fin(w.x) && fin(w.z);

  // waypoints: on the bowl's ground inside the cut, at y ≈ 0 outside
  for (const [k, w] of Object.entries(wps)) {
    if (!wpOk(w)) continue;
    const y = fin(w.y) ? w.y : 0;
    if (inCut(w.x, w.z)) {
      const g = groundAt(w.x, w.z);
      if (Math.abs(y - g) > 0.05) err(`waypoint "${k}" at (${w.x}, ${w.z}) is inside the ${L.id} bowl: y must be the ground there (${g.toFixed(3)}), is ${y}`);
    } else if (Math.abs(y) > 0.2) warn(`waypoint "${k}" at (${w.x}, ${w.z}) has y ${y} (the ground outside the bowl is 0)`);
  }

  // item spots inside the cut: on the pit / stand ground, at most counter height above it
  const spots = isObj(map.itemSpots) ? map.itemSpots : {};
  for (const [k, s] of Object.entries(spots)) {
    if (!isObj(s) || !fin(s.x) || !fin(s.z) || !inCut(s.x, s.z)) continue;
    if (s.y === undefined) continue; // ItemProps finds the surface itself
    const g = groundAt(s.x, s.z);
    if (!fin(s.y) || s.y < g - 0.01 || s.y > g + 1.6) err(`itemSpots.${k}: inside the ${L.id} bowl y must be ${g.toFixed(2)}..${(g + 1.6).toFixed(2)} (the ground there + 1.6), is ${s.y}`);
  }

  if (!L) return out;
  const id = L.id;

  // the stadium court's own waypoints
  const center = wps[`${id}_center`], exit = wps[`${id}_exit`];
  if (!wpOk(center)) err(`waypoint "${id}_center" is required for the stadium court (markers, minimap pin, walk-ons)`);
  else if (!(fin(center.y) && Math.abs(center.y - L.surfY) <= 0.05)) err(`waypoint "${id}_center" must sit on the court (y ${L.surfY}), is y ${center.y}`);
  if (!wpOk(exit)) err(`waypoint "${id}_exit" is required for the stadium court (after-hours tennis leaves the player there)`);
  else {
    if (inFoot(exit.x, exit.z)) err(`waypoint "${id}_exit" at (${exit.x}, ${exit.z}) must be outside the bowl's footprint`);
    if (!(Math.abs(fin(exit.y) ? exit.y : 0) <= 0.05)) err(`waypoint "${id}_exit" must be on the lawn (y 0), is y ${exit.y}`);
  }
  if (!wpOk(wps[`${id}_bench`])) warn(`waypoint "${id}_bench" is missing (a rim spot for the stadium court)`);

  // spawns and paths: nothing to drive into the bowl
  for (const k of ['spawnPoint', 'cartSpawnPoint']) {
    const p = map[k];
    if (isObj(p) && fin(p.x) && fin(p.z) && inFoot(p.x, p.z)) err(`${k} (${p.x}, ${p.z}) is inside the ${id} bowl's footprint`);
  }
  for (const [i, p] of (Array.isArray(map.paths) ? map.paths : []).entries()) {
    if (!isObj(p) || !Array.isArray(p.points)) continue;
    const at = `paths[${i}]${p.id ? ` (${p.id})` : ''}`;
    const pts = p.points.filter(q => isObj(q) && fin(q.x) && fin(q.z));
    const r = (fin(p.width) && p.width > 0 ? p.width : 3) / 2 + PATH_EDGE_EXTRA;
    for (const q of pts) if (inFoot(q.x, q.z)) err(`${at}: point (${q.x}, ${q.z}) is inside the ${id} bowl's footprint`);
    for (let j = 0; j < pts.length; j++) {
      const a = pts[j], c = pts[Math.min(j + 1, pts.length - 1)];
      const d = segRectDist(a.x, a.z, c.x, c.z, L.cut);
      if (d < r) { err(`${at}: the ribbon from (${a.x}, ${a.z}) to (${c.x}, ${c.z}) comes within ${d.toFixed(2)} m of the ${id} cut (needs ≥ ${r.toFixed(2)}: half width + ${PATH_EDGE_EXTRA} edging)`); break; }
    }
  }
  if (fence) {
    const ring = L.concourse + 1.5;
    if (L.cut.x0 - ring < fence.x0 || L.cut.x1 + ring > fence.x1 || L.cut.z0 - ring < fence.z0 || L.cut.z1 + ring > fence.z1) {
      warn(`the ${id} concourse (cut + ${ring} m) reaches past the fence lines (bounds ± 5)`);
    }
  }

  // staff posts / patrols (NPC.js parseDuty) and wandering members (preferredAreas → waypoints)
  const list = isObj(npcs) && Array.isArray(npcs.npcs) ? npcs.npcs.filter(n => isObj(n) && n.id) : [];
  const spotKey = (ref) => (typeof ref === 'string' ? ref : isObj(ref) ? ref.spot : null);
  for (const n of list) {
    const refs = [];
    if (isObj(n.post)) {
      refs.push(['post', n.post.spot]);
      for (const k of ['roam', 'breaks']) for (const r of Array.isArray(n.post[k]) ? n.post[k] : []) refs.push([`post.${k}`, spotKey(r)]);
    }
    if (isObj(n.patrol)) for (const r of Array.isArray(n.patrol.route) ? n.patrol.route : []) refs.push(['patrol.route', spotKey(r)]);
    for (const [where, key] of refs) {
      const w = key && wps[key];
      if (wpOk(w) && inFoot(w.x, w.z)) err(`${n.id}: ${where} spot "${key}" is inside the ${id} bowl's footprint (staff walk straight to their spots)`, 'npcs.json');
    }
    for (const a of Array.isArray(n.preferredAreas) ? n.preferredAreas : []) {
      const al = String(a).toLowerCase();
      const hits = Object.entries(wps).filter(([k, w]) => k.toLowerCase().includes(al) && wpOk(w));
      if (hits.length && hits.every(([, w]) => !wanderable(w.x, w.z))) {
        warn(`${n.id}: preferred area "${a}" only matches waypoints inside the ${id} bowl (${hits.map(([k]) => k).join(', ')}): members never wander there`, 'npcs.json');
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
const events = load('events.json');

// map.json courts: ids, playing surfaces (Court.js: hard / clay / grass), shared surrounds
if (map) {
  const courts = map.areas && Array.isArray(map.areas.courts) ? map.areas.courts : [];
  const seen = new Set();
  for (const [i, c] of courts.entries()) {
    const at = `map.json courts[${i}]${c && c.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c.id !== 'string' || !c.id) { errors.push(`${at}: needs a string "id"`); continue; }
    if (seen.has(c.id)) errors.push(`${at}: duplicate court id`);
    seen.add(c.id);
    if (c.type === undefined) warnings.push(`${at}: no "type" (built as a hard court)`);
    else if (!COURT_SURFACES.includes(c.type)) errors.push(`${at}: "type" must be one of ${COURT_SURFACES.join(' / ')}`);
    // sharedPadLeft / Right: a neighbour on the same row flagged the other way (only merged when the surfaces match)
    for (const [flag, other, dir] of [['sharedPadLeft', 'sharedPadRight', -1], ['sharedPadRight', 'sharedPadLeft', 1]]) {
      if (!c[flag]) continue;
      const n = courts.find(o => o && o !== c && o[other] && Math.abs((o.center?.z ?? 0) - (c.center?.z ?? 0)) < 0.5 && ((o.center?.x ?? 0) - (c.center?.x ?? 0)) * dir > 0);
      if (!n) warnings.push(`${at}: ${flag} but no court on that side has ${other}`);
    }
  }
  // bounds + the sunken stadium court and everything that must agree with its bowl
  for (const p of validateGround(map, npcs || {})) (p.level === 'error' ? errors : warnings).push(p.msg);
}

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

// missions.json → templates (MissionGenerator): shape, then sampled fills must all be valid missions
let nTemplates = 0, nSamples = 0;
const stadiumTemplates = new Set();
let stadiumId = null;
if (map && npcs && missions && missions.templates !== undefined) {
  for (const p of validateTemplatesShape(missions.templates, { taskTypes: missions.taskTypes })) {
    (p.level === 'error' ? errors : warnings).push(`missions.json ${p.msg}`);
  }
  const facts = buildWorldFacts({ map, npcs, missions, items: ITEMS });
  const gen = new MissionGenerator({ templates: missions.templates, npcs, map, schedule, items: ITEMS, facts });
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const checkSample = (t, m) => {
    nSamples++;
    for (const p of validateMission(m, facts, missions.taskTypes)) {
      if (p.level === 'error') errors.push(`missions.json template ${t.id} (${m.sig}): ${p.msg}`);
    }
    const leftover = JSON.stringify(m).match(/\{[A-Za-z]+(\.[a-z]+)?\}/);
    if (leftover) errors.push(`missions.json template ${t.id} (${m.sig}): unfilled placeholder ${leftover[0]}`);
    for (const [i, s] of m.steps.entries()) {
      const tgt = s.action === 'goTo' || s.action === 'groom' ? s.target : (s.action === 'pickup' || s.action === 'deliver') ? s.location : null;
      if (tgt && !hasMarkerPoint(map, tgt)) warnings.push(`missions.json template ${t.id} step ${i}: "${tgt}" has no minimap pin`);
    }
  };
  for (const t of gen.list) {
    nTemplates++;
    const samples = gen.sample(t, 16, rand);
    if (!samples.length) { warnings.push(`missions.json template ${t.id}: produced no mission from the current data (never offered)`); continue; }
    for (const m of samples) checkSample(t, m);
  }
  // The stadium court: every template with an area role that can land on it is also sampled with
  // that role pinned to it, so a sunken-court mission is always checked (random fills may miss it).
  const sc = findStadiumCourt(map);
  if (sc && facts.areaIds.has(sc.id)) {
    stadiumId = sc.id;
    for (const t of gen.list) {
      if (t.builder === 'request') continue;
      for (const [role, spec] of Object.entries(t.roles && typeof t.roles === 'object' ? t.roles : {})) {
        if (!spec || typeof spec !== 'object' || spec.area === undefined) continue;
        const pinned = gen.sample(t, 2, rand, { [role]: sc.id });
        if (pinned.length) stadiumTemplates.add(t.id);
        for (const m of pinned) checkSample(t, m);
      }
    }
  }
}

// events.json (EventSystem): schema, template / mission boosts, each event's merged schedule
let nEvents = 0;
if (events && map && npcs && missions) {
  nEvents = Array.isArray(events.events) ? events.events.length : 0;
  const facts = buildWorldFacts({ map, npcs, missions, items: ITEMS });
  const templateIds = new Set(missions.templates && Array.isArray(missions.templates.list) ? missions.templates.list.map(t => t && t.id) : []);
  const missionIds = new Set((missions.missions || []).map(m => m && m.id));
  for (const p of validateEvents(events, { templateIds, missionIds, facts, baseSchedule: schedule })) {
    (p.level === 'error' ? errors : warnings).push(`events.json ${p.msg}`);
  }
  const eventIds = new Set((events.events || []).map(e => e && e.id));
  for (const t of (missions.templates && missions.templates.list) || []) {
    for (const id of (t && Array.isArray(t.events)) ? t.events : []) if (!eventIds.has(id)) errors.push(`missions.json template ${t.id}: events lists unknown event "${id}"`);
  }
}

// shop.json (ShopSystem): slots, items (stats / looks / cart looks), lessons, club projects, vendors
const shop = load('shop.json');
let nShop = 0;
if (shop && npcs) {
  nShop = Array.isArray(shop.items) ? shop.items.length : 0;
  const ranks = missions && missions.shift && Array.isArray(missions.shift.ranks) ? missions.shift.ranks : [];
  const npcIds = new Set((npcs.npcs || []).filter(n => n && n.id).map(n => n.id));
  for (const p of validateShop(shop, { npcIds, rankCount: Math.max(1, ranks.length) })) {
    (p.level === 'error' ? errors : warnings).push(`shop.json ${p.msg}`);
  }
}

for (const w of warnings) console.warn('warn  ' + w);
console.log(`validate-data: ${nTemplates} mission templates (${nSamples} sampled missions${stadiumId ? `; ${stadiumTemplates.size} can target ${stadiumId}: ${[...stadiumTemplates].join(', ')}` : ''}), ${nEvents} events checked`);
for (const e of errors) console.error('ERROR ' + e);
const n = map && missions && Array.isArray(missions.missions) ? missions.missions.length : 0;
console.log(`validate-data: ${n} missions, ${nMatches} scheduled matches, ${nShop} shop items checked, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
