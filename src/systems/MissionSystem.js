import { GAME } from '../utils/Constants.js';
import { ITEMS } from './InventorySystem.js';
import { missionErrors } from './MissionValidation.js';
import { weightedPick } from './MissionGenerator.js';
import { pickSmallTalk } from './SmallTalk.js';
import { EnvState } from '../graphics/EnvState.js';

/** Unbiased in-place Fisher-Yates shuffle. */
export function shuffleInPlace(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** How often (s) nearby random-encounter NPCs are checked (was every frame). */
const RANDOM_ENCOUNTER_CHECK_INTERVAL = 0.5;
/** Retry delay (s) for a radio dispatch that found every task slot full. */
const RADIO_RETRY_WHEN_FULL = 20;
/** Seconds between generated (procedural) random encounters, and how long an unanswered one waits. */
const GEN_ENCOUNTER_COOLDOWN = 120;
const GEN_ENCOUNTER_TTL = 240;
/** Chance per check (0.5 s) that a nearby member offers a generated request, once the cooldown is over. */
const GEN_ENCOUNTER_CHANCE = 0.04;
/** Days of mission history kept (cooldowns / "helped recently"). */
const HISTORY_DAYS = 14;
const HISTORY_MAX = 400;

const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * MissionSystem — task board, radio dispatch (with On it / Busy), random encounters,
 * per-day repeatable missions and shift routines (opening checklist / closing duties).
 *
 * Only missions whose every step can be completed in this world are ever offered
 * (see MissionValidation.js, shared with `npm run validate`).
 *
 * Hooks (all optional):
 *   onMissionUpdate(activeMissions)      – list / step changed
 *   onRadioDispatch(mission)             – a dispatch card should appear (answer with acceptDispatch / declineDispatch)
 *   onDispatchClosed(mission, accepted)  – the card should go away (answered or timed out)
 *   onMissionComplete(mission)           – fired once per completion; mission.reactions = { npcId: mood }
 *   onReaction(npcId, mood)              – each NPC reaction to a choice
 *   onItemDelivered(mission, item, loc)  – an errand item was handed over (ItemProps sets it down)
 */
export class MissionSystem {
  constructor(missionData, dialogueSystem, inventorySystem) {
    this.missionTemplates = missionData.missions || [];
    this.taskTypes = missionData.taskTypes || {};
    this.dialogueSystem = dialogueSystem;
    this.inventory = inventorySystem;
    this.dialogues = missionData.dialogues || {};

    this.activeMissions = [];
    this.completedMissionIds = new Set();
    this.taskBoardMissions = [];
    this.taskBoardTimer = 5; // populate quickly at start
    this.radioTimer = GAME.radioDispatchInterval;
    this.randomEncounterCooldown = 0;
    this.randomEncounterCheckTimer = 0;

    /** Radio dispatch only runs while this is true (the shift turns it on at clock-in). */
    this.dispatchEnabled = true;
    /** Radio timer speed multiplier (rush windows > 1). */
    this.dispatchRate = 1;
    /** The mission on the dispatch card, waiting for On it / Busy. */
    this.pendingDispatch = null;
    this.pendingDispatchTimer = 0;
    /** NPC ids with an offered (not yet started) random encounter. */
    this.pendingEncounters = new Set();
    /** (npc) => "on Court 3" | "in the café" | null: where someone is, for staff whereabouts hints (set by Game). */
    this.describePlace = null;

    this.onMissionUpdate = null;
    this.onRadioDispatch = null;
    this.onDispatchClosed = null;
    this.onMissionComplete = null;
    this.onReaction = null;
    this.onItemDelivered = null;

    this.npcsMap = new Map();
    this._templatesById = new Map();
    for (const m of this.missionTemplates) {
      if (m && m.id) this._templatesById.set(m.id, m);
    }

    // Procedural missions (MissionGenerator) + anti-repetition memory across days
    this.generator = null;
    /** () => in-game day number / () => rank index (set by Game; gates minDay / minRank). */
    this.getDay = () => 1;
    this.getRankIndex = () => 0;
    /** () => today's club event ({ id, boardSize, templateBoost, ... }) or null (set by EventSystem wiring). */
    this.getEvent = () => null;
    /** Extra radio speed from today's event (multiplies dispatchRate). */
    this.eventDispatchScale = 1;
    this._generatedById = new Map();  // generated mission id → definition (board, active, pending)
    this._genEncounters = new Map();  // npc id → { mission, ttl }
    this._genEncounterCooldown = 60;
    /**
     * { log: [{ s: sig, t: template, n: [npcIds], d: day, k: 'a'|'c' }], helped: { npcId: day },
     *   offered: { sig: last earlier day it was offered }, seq }
     */
    this.history = { log: [], helped: {}, offered: {}, seq: 0 };
    this._offeredToday = new Map();   // sig → times offered today
    this._tplOfferedToday = new Map(); // template → times offered today
    this._lastRainAt = -1e9;          // day * 24 + hour of the last rain seen

    // World facts (set by Game once the map/NPCs exist) → completability + marker points
    this._facts = {};
    this._targetPoints = new Map(); // area id → { x, z, h }
    this._completable = new Map();  // mission id → bool (cached)
    this.uncompletableIds = [];
  }

  // ───────────────────────────── world facts ─────────────────────────────

  /**
   * facts: from MissionValidation.buildWorldFacts; targetPoints: Map(areaId → {x, z, h})
   * used for minimap pins and floating world markers.
   */
  setWorldFacts(facts, targetPoints) {
    this._facts = facts || {};
    if (targetPoints) this._targetPoints = targetPoints;
    this._completable.clear();
    this.uncompletableIds = this.missionTemplates.filter(m => !this.isCompletable(m)).map(m => m.id);
    // Drop anything already offered that turned out to be dead
    this.taskBoardMissions = this.taskBoardMissions.filter(m => this.isCompletable(m));
  }

  /** True when every step of the mission can be completed in this world (cached). */
  isCompletable(tpl) {
    if (!tpl || !tpl.id) return false;
    let ok = this._completable.get(tpl.id);
    if (ok === undefined) {
      const facts = this._facts;
      ok = missionErrors(tpl, facts).length === 0;
      this._completable.set(tpl.id, ok);
    }
    return ok;
  }

  /** Mission definition by id: authored (missions.json) or generated. */
  _lookup(id) {
    return this._templatesById.get(id) || this._generatedById.get(id) || null;
  }

  /** Attach a MissionGenerator (procedural missions fill the board, radio and encounters). */
  setGenerator(gen) {
    this.generator = gen || null;
  }

  /** Static world point for an area id ({x, z, h}), or null. */
  getAreaPoint(id) {
    return (id && this._targetPoints.get(id)) || null;
  }

  /**
   * Where the current step of `mission` happens: a static point ({x, z, h}) for goTo /
   * pickup / deliver / groom, else null (dialogue steps point at an NPC: getStepNpcId).
   */
  getStepTargetPoint(step) {
    if (!step) return null;
    switch (step.action) {
      case 'goTo': return this.getAreaPoint(step.target || step.location);
      case 'pickup':
      case 'deliver': return this.getAreaPoint(step.location);
      case 'groom': return this.getAreaPoint(step.target);
      default: return null;
    }
  }

  /** NPC the player must talk to for this mission's current step (dialogue / pending choice), or null. */
  getStepNpcId(mission) {
    const step = mission && mission.steps ? mission.steps[mission.currentStep] : null;
    if (!step) return null;
    if (step.action === 'dialogue') return step.npcId || null;
    if (step.action === 'choose') {
      const prev = mission.steps[mission.currentStep - 1];
      return prev && prev.npcId ? prev.npcId : null;
    }
    return null;
  }

  /**
   * Every NPC an active mission still involves: npcIds on the current and remaining
   * steps, the client and trigger NPC, and anyone the description or remaining prompts
   * name (e.g. "it needs Jess"). Fills `out` (a Set) so the minimap can colour them
   * while the player goes back and forth. Name matching is cached per mission+step.
   */
  collectInvolvedNpcIds(out) {
    if (!this._involvedCache) this._involvedCache = new Map();
    for (let m = 0; m < this.activeMissions.length; m++) {
      const mission = this.activeMissions[m];
      const key = `${mission.id}|${mission.currentStep}`;
      let ids = this._involvedCache.get(key);
      if (!ids) {
        ids = new Set();
        if (mission.client) ids.add(mission.client);
        if (mission.triggerNpc) ids.add(mission.triggerNpc);
        const steps = mission.steps || [];
        let text = mission.description || '';
        for (let i = Math.max(0, mission.currentStep || 0); i < steps.length; i++) {
          if (steps[i].npcId) ids.add(steps[i].npcId);
          if (steps[i].prompt) text += ' ' + steps[i].prompt;
        }
        for (const npc of this.npcsMap.values()) {
          if (!npc.name) continue;
          const first = npc.name.replace(/^(Mrs?\.|Ms\.|Dr\.|Coach)\s+/, '').split(' ')[0];
          const re = new RegExp(`\\b(${escapeRe(npc.name)}|${escapeRe(first)})\\b`);
          if (re.test(text)) ids.add(npc.id);
        }
        this._involvedCache.set(key, ids);
      }
      for (const id of ids) out.add(id);
    }
    return out;
  }

  // ───────────────────────────── bookkeeping ─────────────────────────────

  _isActive(id) {
    for (let i = 0; i < this.activeMissions.length; i++) {
      if (this.activeMissions[i].id === id) return true;
    }
    return false;
  }

  /** Active missions that count toward GAME.maxActiveMissions (shift routines don't). */
  regularActiveCount() {
    let n = 0;
    for (let i = 0; i < this.activeMissions.length; i++) if (this.activeMissions[i].source !== 'shift') n++;
    return n;
  }

  hasFreeSlot() {
    return this.regularActiveCount() < GAME.maxActiveMissions;
  }

  _isOfferable(m, source) {
    return m && m.source === source && !this.completedMissionIds.has(m.id) && !this._isActive(m.id) &&
      this._storyReady(m) && this.isCompletable(m);
  }

  // ───────────────────────────── history / anti-repetition ─────────────────────────────

  /** Repetition key: generated missions carry `sig` (template + key roles); authored use their id. */
  _sig(m) { return (m && (m.sig || m.id)) || ''; }

  _tplOf(m) { return (m && (m.template || m.id)) || ''; }

  _npcsOf(m) {
    const out = new Set();
    if (!m) return out;
    if (m.client) out.add(m.client);
    if (m.triggerNpc) out.add(m.triggerNpc);
    for (const s of m.steps || []) if (s && s.npcId) out.add(s.npcId);
    return out;
  }

  /** Remember an accepted ('a') or completed ('c') mission for cooldowns and member weighting. */
  _remember(m, kind) {
    if (!m || m.source === 'shift') return;
    const day = this.getDay() || 1;
    const npcs = [...this._npcsOf(m)];
    this.history.log.push({ s: this._sig(m), t: this._tplOf(m), n: npcs, d: day, k: kind });
    if (kind === 'c') for (const id of npcs) this.history.helped[id] = day;
    if (this.history.log.length > HISTORY_MAX) this.history.log.splice(0, this.history.log.length - HISTORY_MAX);
  }

  /** Days since `sig` was last accepted / completed (Infinity = never). */
  _daysSinceSig(sig) {
    const day = this.getDay() || 1;
    const log = this.history.log;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].s === sig) return day - log[i].d;
    return Infinity;
  }

  _daysSinceTemplate(tpl) {
    const day = this.getDay() || 1;
    const log = this.history.log;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].t === tpl) return day - log[i].d;
    return Infinity;
  }

  /** Favour members you haven't helped recently (never: 2, today: 0.35). */
  npcWeight(id) {
    if (this._busyNpcs && this._busyNpcs.has(id)) return 0.15;
    const d = this.history.helped[id];
    if (d === undefined) return 2;
    const ago = (this.getDay() || 1) - d;
    return ago <= 0 ? 0.35 : ago === 1 ? 0.6 : ago === 2 ? 0.9 : 1.4;
  }

  /** Something identical is on the board, active, on the radio card or waiting as an encounter. */
  _sigInPlay(sig) {
    for (const m of this.taskBoardMissions) if (this._sig(m) === sig) return true;
    for (const m of this.activeMissions) if (this._sig(m) === sig) return true;
    if (this.pendingDispatch && this._sig(this.pendingDispatch) === sig) return true;
    for (const e of this._genEncounters.values()) if (this._sig(e.mission) === sig) return true;
    return false;
  }

  /** Days since `sig` was offered on an earlier day (Infinity = not recently). */
  _offeredAgo(sig) {
    const d = this.history.offered[sig];
    return d === undefined ? Infinity : (this.getDay() || 1) - d;
  }

  /** Weight factor for something offered (and passed on) yesterday / the day before. */
  _offeredFactor(sig) {
    const ago = this._offeredAgo(sig);
    return ago <= 1 ? 0.35 : ago === 2 ? 0.7 : 1;
  }

  /**
   * Generated mission rejected: same template + key roles inside its cooldown, offered twice
   * today, or (usually) offered yesterday already.
   */
  _isBlocked(m) {
    const sig = this._sig(m);
    if (this._sigInPlay(sig)) return true;
    if ((this._offeredToday.get(sig) || 0) >= 2) return true;
    if (Math.random() > this._offeredFactor(sig)) return true;
    const tpl = this.generator && this.generator.byId.get(m.template);
    const cd = tpl && Number.isInteger(tpl.cooldownDays) ? tpl.cooldownDays : 2;
    return this._daysSinceSig(sig) < cd;
  }

  /** Template weight factor: rotate templates within a day, cool off ones just done. */
  _templateFactor(tplId) {
    const n = this._tplOfferedToday.get(tplId) || 0;
    const ago = this._daysSinceTemplate(tplId);
    return (1 / (1 + 0.6 * n)) * (ago <= 0 ? 0.5 : 1);
  }

  _noteOffered(m) {
    const sig = this._sig(m);
    this._offeredToday.set(sig, (this._offeredToday.get(sig) || 0) + 1);
    const t = this._tplOf(m);
    this._tplOfferedToday.set(t, (this._tplOfferedToday.get(t) || 0) + 1);
  }

  /** Generation context for MissionGenerator (built on demand, a few times a minute at most). */
  _genCtx() {
    const day = this.getDay() || 1;
    const hour = EnvState.timeOfDay;
    const ev = this.getEvent ? this.getEvent() : null;
    const busy = new Set(this.pendingEncounters);
    for (const m of this.activeMissions) for (const id of this._npcsOf(m)) busy.add(id);
    this._busyNpcs = busy;
    return {
      day, hour, weather: EnvState.weather,
      hoursSinceRain: (day * 24 + hour) - this._lastRainAt,
      rankIndex: this.getRankIndex() || 0,
      eventId: ev ? ev.id : null,
      eventBoost: ev && ev.templateBoost ? ev.templateBoost : null,
      busyNpcs: busy,
      rand: Math.random,
      uid: (tpl) => `g${day}-${++this.history.seq}-${tpl}`,
      isBlocked: (m) => this._isBlocked(m),
      npcWeight: (id) => this.npcWeight(id),
      templateFactor: (id) => this._templateFactor(id),
    };
  }

  /** One generated mission for `source` (registered, not yet offered), or null. */
  _generate(source, ctx, opts) {
    if (!this.generator) return null;
    let m = null;
    try { m = this.generator.generate(source, ctx || this._genCtx(), opts || {}); } catch (e) { console.warn('MissionGenerator failed:', e); }
    if (!m || !this.isCompletable(m)) return null;
    this._generatedById.set(m.id, m);
    return m;
  }

  /** Weight of an authored mission on the board / radio: fresh one-shots first, repeatables rotate. */
  _authoredWeight(m) {
    let w = m.repeatable ? 1.1 : 3;
    if (m.type === 'maintenance') w = 1.6;
    const ago = this._daysSinceSig(m.id);
    if (ago <= 0) w *= 0.3; else if (ago === 1) w *= 0.6;
    w *= this._offeredFactor(m.id);
    w /= 1 + 0.8 * (this._offeredToday.get(m.id) || 0);
    const ev = this.getEvent ? this.getEvent() : null;
    if (ev && ev.missionBoost && Number.isFinite(ev.missionBoost[m.id])) w *= ev.missionBoost[m.id];
    return w;
  }

  /** Board size for today (event boardSize, 2..4; default 3). */
  _boardSize() {
    const ev = this.getEvent ? this.getEvent() : null;
    const n = ev && Number.isFinite(ev.boardSize) ? ev.boardSize : 3;
    return Math.max(2, Math.min(4, Math.round(n)));
  }

  /** Drop generated definitions nothing refers to any more. */
  _pruneGenerated() {
    const keep = new Set();
    for (const m of this.taskBoardMissions) keep.add(m.id);
    for (const m of this.activeMissions) keep.add(m.id);
    if (this.pendingDispatch) keep.add(this.pendingDispatch.id);
    for (const e of this._genEncounters.values()) keep.add(e.mission.id);
    for (const id of this._generatedById.keys()) {
      if (!keep.has(id)) { this._generatedById.delete(id); this._completable.delete(id); }
    }
  }

  /**
   * Member storylines: `requires` (mission ids completed first) and `hours` ([from, to) in-game
   * hours) gate when a mission can be OFFERED. Once active it runs to the end at any hour.
   */
  _storyReady(m) {
    const req = m.requires;
    if (Array.isArray(req)) {
      for (let i = 0; i < req.length; i++) if (!this.completedMissionIds.has(req[i])) return false;
    }
    const h = m.hours;
    if (Array.isArray(h) && h.length === 2) {
      const t = EnvState.timeOfDay;
      if (!(t >= h[0] && t < h[1])) return false;
    }
    // Progression: chapters unlock by day number and rank (index into shift.ranks)
    if (Number.isFinite(m.minDay) && (this.getDay() || 1) < m.minDay) return false;
    if (Number.isFinite(m.minRank) && (this.getRankIndex() || 0) < m.minRank) return false;
    return true;
  }

  _notifyUpdate() {
    this.refreshNPCMarkers();
    if (this.onMissionUpdate) this.onMissionUpdate(this.activeMissions);
  }

  registerNPCs(npcs) {
    this.npcsMap.clear();
    const colors = new Map(); // speaker name → dialogue colour (multi-speaker mission scripts)
    for (const npc of npcs) {
      this.npcsMap.set(npc.id, npc);
      if (npc.name && npc.dialogueColor) colors.set(npc.name, npc.dialogueColor);
    }
    if (this.dialogueSystem) this.dialogueSystem.speakerColors = colors;
    this.refreshNPCMarkers();
  }

  /**
   * The "!" marker goes only on NPCs the player needs right now: the NPC of each active
   * mission's CURRENT step, and NPCs with an offered random encounter.
   */
  refreshNPCMarkers() {
    for (const npc of this.npcsMap.values()) {
      let want = this.pendingEncounters.has(npc.id);
      if (!want) {
        for (let i = 0; i < this.activeMissions.length; i++) {
          if (this.getStepNpcId(this.activeMissions[i]) === npc.id) { want = true; break; }
        }
      }
      if (!!npc.hasRequest !== want && typeof npc.setHasRequest === 'function') npc.setHasRequest(want);
    }
  }

  update(dt, playerPos) {
    if (EnvState.weather === 'rainy') this._lastRainAt = (this.getDay() || 1) * 24 + EnvState.timeOfDay;
    if (this._genEncounterCooldown > 0) this._genEncounterCooldown -= dt;
    if (this._genEncounters.size) {
      for (const [id, e] of this._genEncounters) {
        e.ttl -= dt;
        if (e.ttl <= 0) this._dropEncounter(id);
      }
    }

    // Task board refresh
    this.taskBoardTimer -= dt;
    if (this.taskBoardTimer <= 0) {
      this.taskBoardTimer = GAME.taskBoardRefreshInterval;
      this._refreshTaskBoard();
    }

    // Unanswered dispatch card → counts as "Busy" (no penalty)
    if (this.pendingDispatch) {
      this.pendingDispatchTimer -= dt;
      if (this.pendingDispatchTimer <= 0) this.declineDispatch('timeout');
    } else if (this.dispatchEnabled) {
      // Radio dispatch (faster during rush windows)
      this.radioTimer -= dt * this.dispatchRate * (this.eventDispatchScale || 1);
      if (this.radioTimer <= 0) {
        this.radioTimer = GAME.radioDispatchInterval;
        this._dispatchRadio();
      }
    }

    // Random encounters
    if (this.randomEncounterCooldown > 0) {
      this.randomEncounterCooldown -= dt;
    }

    // Check for random encounter NPCs nearby (throttled; the chance is scaled so the
    // encounter rate matches the old per-frame check at ~60 fps)
    this.randomEncounterCheckTimer -= dt;
    if (this.randomEncounterCooldown <= 0 && playerPos && this.randomEncounterCheckTimer <= 0) {
      this.randomEncounterCheckTimer = RANDOM_ENCOUNTER_CHECK_INTERVAL;
      this._checkRandomEncounters(playerPos);
    }
  }

  /**
   * New board: 2–4 options (event boardSize), a weighted mix of authored missions (fresh
   * one-shots and storylines first, repeatables rotating) and generated ones. Nothing that
   * is on cooldown, already offered twice today or already in play.
   */
  _refreshTaskBoard() {
    const size = this._boardSize();
    const authored = this.missionTemplates.filter(m => this._isOfferable(m, 'taskBoard'));
    if (!this.generator) {
      this.taskBoardMissions = shuffleInPlace(authored).slice(0, Math.min(size, authored.length));
      for (const m of this.taskBoardMissions) this._noteOffered(m);
      return;
    }
    this.taskBoardMissions = [];
    this._pruneGenerated();
    const ctx = this._genCtx();
    const cands = authored.map(m => ({ m, w: this._authoredWeight(m) }));
    const usedTpl = new Set();
    for (let i = 0; i < size + 2; i++) {
      const g = this._generate('taskBoard', ctx, { exclude: usedTpl });
      if (!g) break;
      usedTpl.add(g.template);
      cands.push({ m: g, w: 1.6 });
    }
    const board = [];
    const sigs = new Set();
    let repeatables = 0;
    while (board.length < size && cands.length) {
      const c = weightedPick(cands, (x) => x.w);
      if (!c) break;
      cands.splice(cands.indexOf(c), 1);
      const sig = this._sig(c.m);
      if (sigs.has(sig)) continue;
      // At most two daily repeatables per board; one maintenance job is enough
      if (!c.m.generated && c.m.repeatable && repeatables >= 2) continue;
      sigs.add(sig);
      board.push(c.m);
      if (!c.m.generated && c.m.repeatable) repeatables++;
      if (c.m.type === 'maintenance') for (const o of cands) if (o.m.type === 'maintenance') o.w *= 0.25;
    }
    this.taskBoardMissions = board;
    for (const m of board) this._noteOffered(m);
    this._pruneGenerated();
  }

  /** Keep at least two options on the board (after the player takes one). */
  _topUpBoard() {
    if (!this.generator || this.taskBoardMissions.length >= 2) return;
    const ctx = this._genCtx();
    const used = new Set(this.taskBoardMissions.map(m => this._tplOf(m)));
    for (let i = 0; i < 3 && this.taskBoardMissions.length < 2; i++) {
      const g = this._generate('taskBoard', ctx, { exclude: used });
      if (!g) break;
      used.add(g.template);
      this.taskBoardMissions.push(g);
      this._noteOffered(g);
    }
  }

  // ───────────────────────────── radio dispatch ─────────────────────────────

  /** Offer a radio mission on the dispatch card (it only becomes active on "On it"). */
  _dispatchRadio() {
    if (this.pendingDispatch) return;
    if (!this.hasFreeSlot()) {
      this.radioTimer = RADIO_RETRY_WHEN_FULL;
      return;
    }
    const cands = this.missionTemplates.filter(m => this._isOfferable(m, 'radio')).map(m => ({ m, w: this._authoredWeight(m) }));
    if (this.generator) {
      const ctx = this._genCtx();
      const used = new Set();
      for (let i = 0; i < 2; i++) {
        const g = this._generate('radio', ctx, { exclude: used });
        if (!g) break;
        used.add(g.template);
        cands.push({ m: g, w: 1.8 });
      }
    }
    const pick = cands.length ? weightedPick(cands, (x) => x.w) || cands[0] : null;
    if (!pick) {
      this.radioTimer = RADIO_RETRY_WHEN_FULL; // nothing fits right now: try again soon
      return;
    }
    const mission = pick.m;
    this._noteOffered(mission);
    this.pendingDispatch = mission;
    this.pendingDispatchTimer = GAME.dispatchCardTimeout ?? 25;
    if (this.onRadioDispatch) this.onRadioDispatch(mission);
  }

  /** Force a dispatch now (debug / tests). Returns the offered mission or null. */
  dispatchNow() {
    this._dispatchRadio();
    return this.pendingDispatch;
  }

  /** "On it": the dispatched mission becomes active. Returns it, or null. */
  acceptDispatch() {
    const tpl = this.pendingDispatch;
    if (!tpl) return null;
    this.pendingDispatch = null;
    let active = null;
    if (this.hasFreeSlot() && !this._isActive(tpl.id)) {
      active = { ...tpl, currentStep: 0, status: 'active' };
      this.activeMissions.push(active);
      this._remember(active, 'a');
      this._notifyUpdate();
    }
    if (this.onDispatchClosed) this.onDispatchClosed(tpl, !!active);
    return active;
  }

  /** "Busy" (or the card timed out): no penalty, the mission stays in the pool. */
  declineDispatch(reason = 'busy') {
    const tpl = this.pendingDispatch;
    if (!tpl) return;
    this.pendingDispatch = null;
    if (tpl.generated) this._generatedById.delete(tpl.id);
    this.radioTimer = Math.min(this.radioTimer, GAME.dispatchDeclineCooldown ?? 30);
    if (this.onDispatchClosed) this.onDispatchClosed(tpl, false, reason);
  }

  // ───────────────────────────── random encounters ─────────────────────────────

  _checkRandomEncounters(playerPos) {
    // Per-check probability equivalent to the old per-frame chance over one interval at 60 fps
    const p = 1 - Math.pow(1 - GAME.randomEncounterChance, 60 * RANDOM_ENCOUNTER_CHECK_INTERVAL);
    for (let i = 0; i < this.missionTemplates.length; i++) {
      const mission = this.missionTemplates[i];
      if (!this._isOfferable(mission, 'random') || !mission.triggerNpc) continue;
      if (this.pendingEncounters.has(mission.triggerNpc)) continue;
      const npc = this.npcsMap.get(mission.triggerNpc);
      if (npc && !npc.hasRequest && npc.distanceTo(playerPos) < GAME.interactionRange * 3) {
        if (Math.random() < p) {
          this.offerEncounter(mission.triggerNpc);
          this.randomEncounterCooldown = 30;
          return;
        }
      }
    }
    this._checkGeneratedEncounter(playerPos);
  }

  /**
   * Procedural encounters: now and then a member near the player (not busy with a mission)
   * gets a generated request ("!"). One at a time, spaced out, and they give up after a while.
   */
  _checkGeneratedEncounter(playerPos) {
    if (!this.generator || this._genEncounterCooldown > 0 || this._genEncounters.size > 0 || !this.hasFreeSlot()) return;
    if (!this.dispatchEnabled) return; // on shift only
    if (Math.random() >= GEN_ENCOUNTER_CHANCE) return;
    const range = GAME.interactionRange * 3;
    const near = [];
    for (const npc of this.npcsMap.values()) {
      if (npc.hasRequest || this.pendingEncounters.has(npc.id) || npc.playing) continue;
      if (typeof npc.distanceTo === 'function' && npc.distanceTo(playerPos) < range) near.push(npc);
    }
    if (!near.length) return;
    const ctx = this._genCtx();
    const npc = weightedPick(near, (n) => this.npcWeight(n.id)) || near[0];
    const m = this._generate('random', ctx, { trigger: npc.id });
    this._genEncounterCooldown = m ? GEN_ENCOUNTER_COOLDOWN : 20;
    if (!m) return;
    m.triggerNpc = npc.id;
    this._genEncounters.set(npc.id, { mission: m, ttl: GEN_ENCOUNTER_TTL });
    this._noteOffered(m);
    this.pendingEncounters.add(npc.id);
    this.refreshNPCMarkers();
  }

  _dropEncounter(npcId) {
    const e = this._genEncounters.get(npcId);
    if (!e) return;
    this._genEncounters.delete(npcId);
    this._generatedById.delete(e.mission.id);
    this.pendingEncounters.delete(npcId);
    this.refreshNPCMarkers();
  }

  /** The mission an offered encounter with `npcId` would start (authored first, then generated). */
  _encounterFor(npcId) {
    const authored = this.missionTemplates.find(m => this._isOfferable(m, 'random') && m.triggerNpc === npcId);
    if (authored) return authored;
    const e = this._genEncounters.get(npcId);
    return e ? e.mission : null;
  }

  /** Give an NPC a pending random-encounter request ("!"), if they have an offerable one. */
  offerEncounter(npcId) {
    const has = this.missionTemplates.some(m => this._isOfferable(m, 'random') && m.triggerNpc === npcId) || this._genEncounters.has(npcId);
    if (!has) return false;
    this.pendingEncounters.add(npcId);
    this.refreshNPCMarkers();
    return true;
  }

  getTaskBoardMissions() {
    return this.taskBoardMissions;
  }

  getActiveMissions() {
    return this.activeMissions;
  }

  acceptTaskBoardMission(mission) {
    if (!this.hasFreeSlot() || !mission || this._isActive(mission.id)) return false;

    const active = {
      ...mission,
      currentStep: 0,
      status: 'active',
    };
    this.activeMissions.push(active);
    this.taskBoardMissions = this.taskBoardMissions.filter(m => m.id !== mission.id);
    this._remember(active, 'a');
    this._topUpBoard();
    this._notifyUpdate();
    return true;
  }

  acceptRandomEncounter(npcId) {
    const mission = this._encounterFor(npcId);
    if (mission && this.hasFreeSlot() && !this._isActive(mission.id)) {
      const active = {
        ...mission,
        currentStep: 0,
        status: 'active',
      };
      if (this._genEncounters.has(npcId) && this._genEncounters.get(npcId).mission === mission) this._genEncounters.delete(npcId);
      this.activeMissions.push(active);
      this._remember(active, 'a');
      this._notifyUpdate();
      return active;
    }
    return null;
  }

  // ───────────────────────────── shift routines / days ─────────────────────────────

  /**
   * Start a shift routine (source 'shift': opening checklist, closing duties). These don't
   * use a task slot. Returns the active mission, or null (unknown / dead / already active).
   */
  startShiftMission(id) {
    const tpl = this._templatesById.get(id);
    if (!tpl || this._isActive(id) || !this.isCompletable(tpl)) return null;
    const active = { ...tpl, currentStep: 0, status: 'active' };
    this.activeMissions.push(active);
    this._notifyUpdate();
    return active;
  }

  /** Remove unfinished shift routines (end of the day). Returns the ids removed. */
  clearShiftMissions() {
    const removed = [];
    this.activeMissions = this.activeMissions.filter(m => {
      if (m.source !== 'shift') return true;
      removed.push(m.id);
      return false;
    });
    if (removed.length) this._notifyUpdate();
    return removed;
  }

  /** A new day: repeatable missions can be offered again; fresh board and radio. */
  newDay() {
    for (const m of this.missionTemplates) {
      if (m && (m.repeatable || m.source === 'shift')) this.completedMissionIds.delete(m.id);
    }
    if (this.pendingDispatch) this.declineDispatch('newDay');
    this.pendingEncounters.clear();
    this._genEncounters.clear();
    this._genEncounterCooldown = 60;
    // Yesterday's offers feed tomorrow's rotation (history.offered)
    const yesterday = (this.getDay() || 1) - 1;
    for (const sig of this._offeredToday.keys()) this.history.offered[sig] = yesterday;
    this._offeredToday.clear();
    this._tplOfferedToday.clear();
    this._pruneHistory();
    this._refreshTaskBoard();
    this.taskBoardTimer = GAME.taskBoardRefreshInterval;
    this.radioTimer = GAME.radioDispatchInterval;
    this._notifyUpdate();
  }

  /** Forget history older than HISTORY_DAYS. */
  _pruneHistory() {
    const day = this.getDay() || 1;
    this.history.log = this.history.log.filter(e => day - e.d <= HISTORY_DAYS);
    for (const [id, d] of Object.entries(this.history.helped)) if (day - d > HISTORY_DAYS) delete this.history.helped[id];
    for (const [sig, d] of Object.entries(this.history.offered)) if (day - d > 3) delete this.history.offered[sig];
  }

  // ───────────────────────────── steps ─────────────────────────────

  advanceMissionStep(missionId) {
    const mission = this.activeMissions.find(m => m.id === missionId);
    if (!mission) return null;

    mission.currentStep++;

    if (mission.currentStep >= mission.steps.length) {
      return this.completeMission(missionId);
    }

    this._notifyUpdate();
    return mission.steps[mission.currentStep];
  }

  /**
   * Player entered an area: complete any active `goTo` step targeting it.
   * Returns the advanced mission or null. Allocation-free; safe to call every frame.
   */
  handleArrival(areaId) {
    if (!areaId) return null;
    for (let i = 0; i < this.activeMissions.length; i++) {
      const m = this.activeMissions[i];
      const step = m.steps[m.currentStep];
      if (step && step.action === 'goTo' && (step.target === areaId || step.location === areaId)) {
        this.advanceMissionStep(m.id);
        return m;
      }
    }
    return null;
  }

  getCurrentStep(missionId) {
    const mission = this.activeMissions.find(m => m.id === missionId);
    if (!mission || mission.currentStep >= mission.steps.length) return null;
    return mission.steps[mission.currentStep];
  }

  completeMission(missionId) {
    const idx = this.activeMissions.findIndex(m => m.id === missionId);
    if (idx >= 0) {
      const mission = this.activeMissions[idx];
      this.activeMissions.splice(idx, 1);
      mission.status = 'complete';
      if (!mission.reactions) mission.reactions = {};
      // Shift routines come back every day; everything else is one-shot until the next day
      // (repeatable) or forever. Generated missions are unique and live on in `history`.
      if (mission.source !== 'shift' && !mission.generated) this.completedMissionIds.add(missionId);
      this._remember(mission, 'c');
      if (mission.generated) this._generatedById.delete(missionId);

      this._notifyUpdate();
      if (this.onMissionComplete) {
        try { this.onMissionComplete(mission); } catch (e) { console.error('onMissionComplete failed:', e); }
      }
      return mission;
    }
    return null;
  }

  /** Base pay for a mission (taskTypes[type].baseReward). */
  getBaseReward(mission) {
    const t = mission && this.taskTypes[mission.type];
    return t && Number.isFinite(t.baseReward) ? t.baseReward : 0;
  }

  // ───────────────────────────── talking ─────────────────────────────

  handleInteraction(npc, playerPos, onComplete) {
    // 1. This NPC is needed by an active mission's CURRENT step
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (!step) continue;
      if (step.action === 'dialogue' && step.npcId === npc.id) {
        this._runDialogueStep(mission, npc, onComplete);
        return true;
      }
      // Choices pending but not on screen (e.g. restored state): talking to the
      // NPC from the preceding dialogue step re-opens them.
      if (step.action === 'choose' && !this.dialogueSystem.isActive()) {
        const prev = mission.steps[mission.currentStep - 1];
        if (prev && prev.npcId === npc.id) {
          this._showChoices(mission, step, onComplete);
          return true;
        }
      }
    }

    // 2. An offered random encounter: start it and play its first step right away
    //    (the step is advanced afterwards, so the conversation never plays twice)
    if (this.pendingEncounters.has(npc.id)) {
      const mission = this.acceptRandomEncounter(npc.id);
      if (mission) {
        this.pendingEncounters.delete(npc.id);
        this.refreshNPCMarkers();
        const step = this.getCurrentStep(mission.id);
        if (step && step.action === 'dialogue' && step.npcId === npc.id) {
          this._runDialogueStep(mission, npc, onComplete);
        } else {
          const text = (step && step.prompt) || mission.description || 'Could you help me with something?';
          this.dialogueSystem.startDialogue(npc, [{ speaker: npc.name, text }], onComplete);
        }
        return true;
      }
      if (!this.hasFreeSlot()) {
        // Keep the request open for later — no fail states
        this.dialogueSystem.startDialogue(npc, [{ speaker: npc.name, text: "Oh, you look swamped. Come find me when you've got a minute!" }], onComplete);
        return true;
      }
      this.pendingEncounters.delete(npc.id);
      this.refreshNPCMarkers();
    }

    // 3. Small talk (SmallTalk.js): a greeting the first time in a while, then personality,
    //    time-of-day and weather lines, or how they feel about you after a mission reaction
    const now = EnvState.time;
    const firstChat = npc._smallTalkAt == null || now - npc._smallTalkAt > 600;
    const text = pickSmallTalk(npc.data, {
      mood: npc.mood, moodSet: !!npc.moodSet, firstChat,
      hour: EnvState.timeOfDay, weather: EnvState.weather, last: npc._smallTalkLast,
      whereabouts: () => this._whereabouts(npc),
    });
    npc._smallTalkAt = now;
    npc._smallTalkLast = text;
    this.dialogueSystem.startDialogue(npc, [{ speaker: npc.name, text }], onComplete);
    return true;
  }

  /**
   * Someone worth pointing the player at, for a staff member's "hints" small talk: the NPC an
   * active mission is waiting on (or one with an offered encounter) first, else a random member.
   * @returns {{ name: string, place: string, needed: boolean } | null}
   */
  _whereabouts(speaker) {
    if (typeof this.describePlace !== 'function') return null;
    const place = (n) => {
      if (!n || n === speaker || !n.body) return null;
      try { return this.describePlace(n); } catch (e) { return null; }
    };
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (!step || step.action !== 'dialogue' || !step.npcId) continue;
      const n = this.npcsMap.get(step.npcId);
      const p = place(n);
      if (p) return { name: n.name, place: p, needed: true };
    }
    for (const id of this.pendingEncounters) {
      const n = this.npcsMap.get(id);
      const p = place(n);
      if (p) return { name: n.name, place: p, needed: true };
    }
    const all = [...this.npcsMap.values()].filter(n => n !== speaker && n.archetype !== 'staff');
    for (let tries = 0; tries < 4 && all.length; tries++) {
      const n = all[Math.floor(Math.random() * all.length)];
      const p = place(n);
      if (p) return { name: n.name, place: p, needed: false };
    }
    return null;
  }

  /** Play a dialogue step, then advance; open the choices if the next step is `choose`. */
  _runDialogueStep(mission, npc, onComplete) {
    this._executeMissionStep(mission, npc, () => {
      this.advanceMissionStep(mission.id);
      const nextStep = this.getCurrentStep(mission.id);
      if (nextStep && nextStep.action === 'choose') {
        this._showChoices(mission, nextStep, onComplete);
      } else if (onComplete) {
        onComplete();
      }
    });
  }

  _executeMissionStep(mission, npc, onComplete) {
    const step = this.getCurrentStep(mission.id);
    if (!step) return;

    if (step.action === 'dialogue' && step.dialogueKey) {
      this.dialogueSystem.startDialogueFromKey(npc, step.dialogueKey, onComplete);
    } else if (step.action === 'dialogue' && Array.isArray(step.lines) && step.lines.length) {
      // Generated missions carry their own filled-in lines ({ speaker, text })
      this.dialogueSystem.startDialogue(npc, step.lines.map(l => ({ speaker: l.speaker || npc.name, text: l.text })), onComplete);
    } else if (step.action === 'dialogue') {
      const lines = [{ speaker: npc.name, text: step.prompt }];
      this.dialogueSystem.startDialogue(npc, lines, onComplete);
    }
  }

  _showChoices(mission, step, onComplete) {
    this.dialogueSystem.dialogueBox.show('', step.prompt);
    this.dialogueSystem.active = true;

    this.dialogueSystem.showChoices(step.choices, (index, choice) => {
      // Show result
      this.dialogueSystem.showMessage('', choice.result, '#fff', () => {
        // Apply reactions
        if (choice.reactions) {
          if (!mission.reactions) mission.reactions = {};
          for (const [npcId, mood] of Object.entries(choice.reactions)) {
            mission.reactions[npcId] = mood;
            const npc = this.npcsMap.get(npcId);
            if (this.onReaction) {
              try { this.onReaction(npcId, mood); } catch (e) { /* ignore */ }
            }
            if (npc) {
              npc.mood = mood;
              const emoji = mood === 'satisfied' ? '😊' :
                           mood === 'unsatisfied' ? '😤' : '🤷';
              npc.showReaction(emoji);
            }
          }
        }

        this.completeMission(mission.id);
        if (onComplete) onComplete();
      });
    });
  }

  handlePickup(location, playerPos) {
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (step && step.action === 'pickup' && step.location === location) {
        const item = ITEMS[step.item];
        if (item && this.inventory.canPickup()) {
          this.inventory.pickup({ ...item });
          this.advanceMissionStep(mission.id);
          return item;
        }
      }
    }
    return null;
  }

  handleDelivery(location) {
    for (const mission of this.activeMissions) {
      const step = this.getCurrentStep(mission.id);
      if (step && step.action === 'deliver' && step.location === location) {
        const item = ITEMS[step.item];
        if (item && this.inventory.hasItem(item.id)) {
          this.inventory.removeItem(item.id);
          this.advanceMissionStep(mission.id);
          if (this.onItemDelivered) {
            try { this.onItemDelivered(mission, item, location); } catch (e) { console.warn('onItemDelivered failed:', e); }
          }
          return { mission, item };
        }
      }
    }
    return null;
  }

  // ───────────────────────────── save / load ─────────────────────────────

  /** Step index to resume from: rewinds past 'choose' steps to the preceding step. */
  _rewindChoose(steps, step) {
    while (step > 0 && steps && steps[step] && steps[step].action === 'choose') step--;
    return step;
  }

  /** Serializable mission progress. */
  getState() {
    return {
      // A 'choose' step is persisted as the dialogue step leading into it, so a
      // reload replays that conversation and the advance-then-choose path shows
      // the choices again (otherwise nothing could ever re-open them).
      active: this.activeMissions.map(m => ({ id: m.id, step: this._rewindChoose(m.steps, m.currentStep) })),
      completed: [...this.completedMissionIds],
      taskBoard: this.taskBoardMissions.map(m => m.id),
      radioTimer: this.radioTimer,
      taskBoardTimer: this.taskBoardTimer,
      // Generated missions on the board or in progress (full definitions: their ids are unique)
      generated: [...this.activeMissions, ...this.taskBoardMissions]
        .filter(m => m.generated)
        .map(m => stripRuntime(m)),
      // Anti-repetition memory across days (cooldowns, members helped recently)
      history: {
        log: this.history.log.slice(-HISTORY_MAX),
        helped: { ...this.history.helped },
        offered: { ...this.history.offered },
        today: { day: this.getDay() || 1, sigs: [...this._offeredToday.keys()].slice(0, 200) },
        seq: this.history.seq,
      },
    };
  }

  /**
   * Restore progress. Unknown or uncompletable mission ids are dropped, step indices are
   * clamped, and NPC request markers are re-applied for the current steps.
   */
  setState(state) {
    if (!state || typeof state !== 'object') return;
    // Generated definitions first (validated again: the world or data may have changed)
    this._generatedById.clear();
    if (Array.isArray(state.generated)) {
      for (const g of state.generated) {
        if (!g || typeof g !== 'object' || typeof g.id !== 'string' || this._templatesById.has(g.id)) continue;
        const def = { ...g, generated: true };
        if (missionErrors(def, this._facts).length === 0) this._generatedById.set(def.id, def);
      }
    }
    const h = state.history;
    if (h && typeof h === 'object') {
      this.history = {
        log: Array.isArray(h.log) ? h.log.filter(e => e && typeof e.s === 'string' && Number.isFinite(e.d)).map(e => ({
          s: e.s, t: typeof e.t === 'string' ? e.t : e.s, n: Array.isArray(e.n) ? e.n.filter(x => typeof x === 'string') : [], d: e.d, k: e.k === 'c' ? 'c' : 'a',
        })).slice(-HISTORY_MAX) : [],
        helped: {},
        offered: {},
        seq: Number.isFinite(h.seq) ? h.seq : 0,
      };
      if (h.helped && typeof h.helped === 'object') for (const [id, d] of Object.entries(h.helped)) if (Number.isFinite(d)) this.history.helped[id] = d;
      if (h.offered && typeof h.offered === 'object') for (const [sig, d] of Object.entries(h.offered)) if (Number.isFinite(d)) this.history.offered[sig] = d;
      // Offers from the saved day: same day → still "today"; an earlier day → yesterday's rotation
      this._offeredToday.clear();
      const t = h.today;
      if (t && Array.isArray(t.sigs) && Number.isFinite(t.day)) {
        for (const sig of t.sigs) {
          if (typeof sig !== 'string') continue;
          if (t.day === (this.getDay() || 1)) this._offeredToday.set(sig, 1);
          else this.history.offered[sig] = t.day;
        }
      }
    }
    const known = { get: (id) => this._lookup(id) };

    this.completedMissionIds = new Set();
    if (Array.isArray(state.completed)) {
      for (const id of state.completed) {
        const tpl = known.get(id);
        if (tpl && tpl.source !== 'shift') this.completedMissionIds.add(id);
      }
    }

    this.activeMissions = [];
    this.pendingDispatch = null;
    if (Array.isArray(state.active)) {
      for (const a of state.active) {
        if (!a) continue;
        const tpl = known.get(a.id);
        if (!tpl || this.completedMissionIds.has(tpl.id) || this._isActive(tpl.id) || !this.isCompletable(tpl)) continue;
        if (tpl.source !== 'shift' && !this.hasFreeSlot()) continue;
        const steps = tpl.steps || [];
        let step = Number.isInteger(a.step) ? a.step : 0;
        step = Math.max(0, Math.min(step, Math.max(0, steps.length - 1)));
        step = this._rewindChoose(steps, step);
        this.activeMissions.push({ ...tpl, currentStep: step, status: 'active' });
      }
    }

    this.taskBoardMissions = [];
    if (Array.isArray(state.taskBoard)) {
      for (const id of state.taskBoard) {
        const tpl = known.get(id);
        if (this._isOfferable(tpl, 'taskBoard') && this.taskBoardMissions.length < 4 && !this.taskBoardMissions.includes(tpl)) {
          this.taskBoardMissions.push(tpl);
        }
      }
    }
    if (Number.isFinite(state.radioTimer)) {
      this.radioTimer = Math.max(5, Math.min(GAME.radioDispatchInterval, state.radioTimer));
    }
    if (Number.isFinite(state.taskBoardTimer)) {
      this.taskBoardTimer = Math.max(1, Math.min(GAME.taskBoardRefreshInterval, state.taskBoardTimer));
    }
    if (this.taskBoardMissions.length === 0) this.taskBoardTimer = Math.min(this.taskBoardTimer, 5);
    this._pruneGenerated();

    this._notifyUpdate();
  }
}

/** A mission definition without runtime fields (for the save). */
function stripRuntime(m) {
  const { currentStep, status, reactions, ...def } = m;
  return def;
}
