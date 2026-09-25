/**
 * MissionValidation — one source of truth for "can this mission actually be completed?".
 *
 * Used at runtime by MissionSystem (never offer or dispatch a mission with a dead step) and
 * by `npm run validate` (scripts/validate-data.mjs) so bad JSON fails CI before deploy.
 * Pure data code: no DOM, no three.js, safe to import from Node.
 */

/** Step actions MissionSystem / Game know how to complete. */
export const SUPPORTED_ACTIONS = ['goTo', 'dialogue', 'pickup', 'deliver', 'choose', 'groom'];

/** Mission sources MissionSystem understands. */
export const MISSION_SOURCES = ['taskBoard', 'radio', 'random', 'shift'];

/** Non-court areas Game._detectCurrentArea recognises (court ids are recognised too). */
export const DETECTABLE_AREAS = ['proShop', 'patio', 'garden', 'equipmentShed'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * World facts a mission can reference, derived from map.json + npcs.json + missions.json.
 * @returns {{ areaIds:Set<string>, clayCourtIds:Set<string>, courtIds:Set<string>, npcIds:Set<string>, dialogueKeys:Set<string>, itemIds:Set<string> }}
 */
export function buildWorldFacts({ map, npcs, missions, items }) {
  const areaIds = new Set();
  const clayCourtIds = new Set();
  const areas = isObj(map) && isObj(map.areas) ? map.areas : {};
  for (const c of Array.isArray(areas.courts) ? areas.courts : []) {
    if (!isObj(c) || !c.id || !isObj(c.center)) continue;
    areaIds.add(c.id);
    if (c.type === 'clay') clayCourtIds.add(c.id);
  }
  for (const id of DETECTABLE_AREAS) {
    const a = areas[id];
    if (isObj(a) && isObj(a.center) && isObj(a.bounds)) areaIds.add(id);
  }
  const courtIds = new Set();
  for (const c of Array.isArray(areas.courts) ? areas.courts : []) if (isObj(c) && c.id && isObj(c.center)) courtIds.add(c.id);
  const npcIds = new Set();
  for (const n of (isObj(npcs) && Array.isArray(npcs.npcs)) ? npcs.npcs : []) if (isObj(n) && n.id) npcIds.add(n.id);
  const dialogueKeys = new Set(isObj(missions) && isObj(missions.dialogues) ? Object.keys(missions.dialogues) : []);
  const itemIds = new Set(isObj(items) ? Object.keys(items) : []);
  return { areaIds, clayCourtIds, courtIds, npcIds, dialogueKeys, itemIds };
}

/** Does the map have somewhere to put a pin / marker for this area id? */
export function hasMarkerPoint(map, id) {
  if (!isObj(map)) return false;
  const wp = isObj(map.waypoints) ? map.waypoints : {};
  if (isObj(wp[id + '_marker']) || isObj(wp[id + '_center']) || isObj(wp[id])) return true;
  const areas = isObj(map.areas) ? map.areas : {};
  if (isObj(areas[id]) && isObj(areas[id].center)) return true;
  return Array.isArray(areas.courts) && areas.courts.some(c => isObj(c) && c.id === id && isObj(c.center));
}

/**
 * Problems with one mission. `facts` from buildWorldFacts (a missing set skips that check,
 * e.g. before NPCs are registered). Returns [] when the mission can be completed.
 * Each problem: { level: 'error' | 'warn', msg }.
 */
export function validateMission(m, facts = {}, taskTypes = null) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  if (!isObj(m)) { err('mission is not an object'); return out; }
  if (!m.id || typeof m.id !== 'string') err('missing string "id"');
  if (!m.title) warn('missing "title"');
  if (!MISSION_SOURCES.includes(m.source)) err(`unknown source "${m.source}" (expected ${MISSION_SOURCES.join('/')})`);
  if (taskTypes && !taskTypes[m.type]) warn(`type "${m.type}" has no taskTypes entry (no pay)`);
  const { areaIds, clayCourtIds, npcIds, dialogueKeys, itemIds } = facts;
  if (m.source === 'random') {
    if (!m.triggerNpc) err('random mission needs "triggerNpc"');
    else if (npcIds && !npcIds.has(m.triggerNpc)) err(`triggerNpc "${m.triggerNpc}" is not in npcs.json`);
  }
  if (m.client && npcIds && !npcIds.has(m.client)) err(`client "${m.client}" is not in npcs.json`);
  const steps = m.steps;
  if (!Array.isArray(steps) || steps.length === 0) { err('needs a non-empty "steps" array'); return out; }

  const carried = new Set(); // items picked up by earlier steps
  steps.forEach((s, i) => {
    const at = `step ${i}`;
    if (!isObj(s)) { err(`${at}: not an object`); return; }
    if (!SUPPORTED_ACTIONS.includes(s.action)) { err(`${at}: unsupported action "${s.action}"`); return; }
    if (!s.prompt && s.action !== 'choose') warn(`${at}: no "prompt" (the task list shows it)`);
    switch (s.action) {
      case 'goTo': {
        const t = s.target || s.location;
        if (!t) err(`${at}: goTo needs "target"`);
        else if (areaIds && !areaIds.has(t)) err(`${at}: goTo target "${t}" is not an area the game can detect`);
        break;
      }
      case 'dialogue':
        if (!s.npcId) err(`${at}: dialogue needs "npcId"`);
        else if (npcIds && !npcIds.has(s.npcId)) err(`${at}: npcId "${s.npcId}" is not in npcs.json`);
        if (s.dialogueKey && dialogueKeys && !dialogueKeys.has(s.dialogueKey)) err(`${at}: dialogueKey "${s.dialogueKey}" is not in missions.json dialogues`);
        if (!s.dialogueKey && !s.prompt) err(`${at}: dialogue needs "dialogueKey" or "prompt"`);
        break;
      case 'pickup':
      case 'deliver':
        if (!s.location) err(`${at}: ${s.action} needs "location"`);
        else if (areaIds && !areaIds.has(s.location)) err(`${at}: location "${s.location}" is not an area the game can detect`);
        if (!s.item) err(`${at}: ${s.action} needs "item"`);
        else if (itemIds && !itemIds.has(s.item)) err(`${at}: item "${s.item}" is not in InventorySystem ITEMS`);
        if (s.action === 'pickup') carried.add(s.item);
        else if (s.item && !carried.has(s.item)) err(`${at}: delivers "${s.item}" but no earlier step picks it up`);
        else carried.delete(s.item);
        break;
      case 'choose': {
        if (!Array.isArray(s.choices) || s.choices.length === 0) { err(`${at}: choose needs a non-empty "choices" array`); break; }
        const prev = steps[i - 1];
        if (!prev || prev.action !== 'dialogue') err(`${at}: choose must follow a dialogue step (it opens when that talk ends)`);
        if (i !== steps.length - 1) err(`${at}: choose must be the last step (it completes the mission)`);
        s.choices.forEach((c, j) => {
          if (!isObj(c) || !c.label) err(`${at}: choice ${j} needs a "label"`);
          if (isObj(c) && isObj(c.reactions) && npcIds) {
            for (const id of Object.keys(c.reactions)) if (!npcIds.has(id)) err(`${at}: choice ${j} reacts with unknown npc "${id}"`);
          }
        });
        break;
      }
      case 'groom': {
        const t = s.target;
        if (!t) err(`${at}: groom needs "target"`);
        else if (clayCourtIds && !clayCourtIds.has(t)) err(`${at}: groom target "${t}" is not a clay court`);
        break;
      }
      default: break;
    }
  });
  return out;
}

/** Only the blocking problems (errors). */
export function missionErrors(m, facts, taskTypes) {
  return validateMission(m, facts, taskTypes).filter(p => p.level === 'error');
}

// ───────────────────────────── schedule.json ─────────────────────────────

/** In-game hour from 8.5 / "8:30" / "8" (NaN when unreadable). Shared with MatchSystem. */
export function parseHour(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/**
 * Problems with public/data/schedule.json (MatchSystem). Checks known court / NPC ids,
 * start < end within the day, two players per match (or "any"), no player twice, format ranges.
 * `facts` from buildWorldFacts. Each problem: { level: 'error' | 'warn', msg }.
 */
export function validateSchedule(sched, facts = {}) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  if (!isObj(sched)) { err('schedule is not an object'); return out; }
  const { courtIds, npcIds } = facts;
  const knownNpc = (id) => !npcIds || npcIds.has(id);

  const f = sched.format;
  if (f !== undefined) {
    if (!isObj(f)) err('format must be an object');
    else {
      if (f.gamesToWin !== undefined && !(Number.isInteger(f.gamesToWin) && f.gamesToWin >= 1 && f.gamesToWin <= 6)) err('format.gamesToWin must be an integer 1..6');
      if (f.warmupSeconds !== undefined && !(f.warmupSeconds >= 0 && f.warmupSeconds <= 60)) err('format.warmupSeconds must be 0..60');
    }
  }
  if (sched.maxConcurrent !== undefined && !(Number.isInteger(sched.maxConcurrent) && sched.maxConcurrent >= 0 && sched.maxConcurrent <= 5)) err('maxConcurrent must be an integer 0..5');
  if (sched.lateStartHours !== undefined && !(sched.lateStartHours > 0)) err('lateStartHours must be a number > 0');

  const exclude = new Set();
  if (sched.exclude !== undefined && !Array.isArray(sched.exclude)) err('exclude must be an array of npc ids');
  for (const id of Array.isArray(sched.exclude) ? sched.exclude : []) {
    if (!knownNpc(id)) warn(`exclude: "${id}" is not in npcs.json`);
    exclude.add(id);
  }
  if (sched.pool !== undefined && !Array.isArray(sched.pool)) err('pool must be an array of npc ids');
  const pool = Array.isArray(sched.pool) ? sched.pool : [];
  for (const id of pool) {
    if (!knownNpc(id)) err(`pool: "${id}" is not in npcs.json`);
    else if (exclude.has(id)) warn(`pool: "${id}" is also excluded (never picked)`);
  }

  if (!Array.isArray(sched.matches)) { err('needs a "matches" array'); return out; }
  const ids = new Set();
  const windows = []; // fixed single-court bookings, for overlap warnings
  sched.matches.forEach((m, i) => {
    const at = `match #${i}${isObj(m) && m.id ? ` (${m.id})` : ''}`;
    if (!isObj(m)) { err(`${at}: not an object`); return; }
    if (!m.id) warn(`${at}: no "id" (saves track started matches by id)`);
    else if (ids.has(m.id)) err(`${at}: duplicate id`);
    else ids.add(m.id);

    const courts = Array.isArray(m.court) ? m.court : [m.court];
    if (courts.length === 0 || courts.some(c => typeof c !== 'string' || !c)) err(`${at}: "court" must be a court id or a non-empty list of ids`);
    else for (const c of courts) if (courtIds && !courtIds.has(c)) err(`${at}: court "${c}" is not in map.json courts`);

    const start = parseHour(m.start), end = parseHour(m.end);
    if (!Number.isFinite(start)) err(`${at}: start "${m.start}" is not a time (8.5 or "8:30")`);
    if (!Number.isFinite(end)) err(`${at}: end "${m.end}" is not a time (8.5 or "8:30")`);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      if (!(start < end)) err(`${at}: start must be before end`);
      if (start < 0 || end > 24) err(`${at}: times must be within 0..24`);
      else if (start < end && end - start < 0.75) warn(`${at}: window under 45 game minutes (a match may not finish)`);
      if (courts.length === 1 && typeof courts[0] === 'string') windows.push({ at, court: courts[0], start, end });
    }

    if (!Array.isArray(m.players)) err(`${at}: "players" must be an array of two npc ids (or "any")`);
    else {
      if (m.players.length !== 2) err(`${at}: needs exactly 2 players (use "any" for a pool pick), has ${m.players.length}`);
      const seen = new Set();
      for (const id of m.players) {
        if (id === 'any') continue;
        if (typeof id !== 'string' || !knownNpc(id)) err(`${at}: player "${id}" is not in npcs.json`);
        else if (exclude.has(id)) err(`${at}: player "${id}" is excluded from matches`);
        if (seen.has(id)) err(`${at}: player "${id}" is listed twice`);
        seen.add(id);
      }
    }
  });
  for (let a = 0; a < windows.length; a++) {
    for (let b = a + 1; b < windows.length; b++) {
      const x = windows[a], y = windows[b];
      if (x.court === y.court && x.start < y.end && y.start < x.end) warn(`${x.at} and ${y.at} book ${x.court} at overlapping times (the later one waits)`);
    }
  }
  return out;
}
