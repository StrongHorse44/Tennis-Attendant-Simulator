import { GAME } from '../utils/Constants.js';

/**
 * ShiftSystem — the daily loop: clock in at 7:00 AM, opening checklist, rush windows,
 * closing duties at 6:30 PM, clock out at 7:00 PM with a report card, then the next
 * morning (the empty night is skipped). Pays wages, mission rewards and tips into a
 * wallet and climbs a staff rank ladder that unlocks small perks.
 *
 * Pure game logic: UI and world side effects go through hooks set by Game (main.js).
 * Data comes from missions.json → "shift" (wage, rush windows, rep values, ranks) and
 * npcs.json (archetype tipChance / tipRange, tipMoods). Hours are in Constants.js
 * (GAME.shiftStartHour / shiftClosingHour / shiftEndHour).
 *
 * Phases:
 *   'preShift' – clock stopped at the start hour, waiting for clock-in (no radio dispatch)
 *   'onShift'  – clock running; closing duties at shiftClosingHour
 *   'ending'   – clock stopped at shiftEndHour, waiting for a quiet moment (no dialogue / grooming)
 *   'report'   – report card on screen; nextDay() starts the next morning
 *
 * Hooks (all optional):
 *   onClockInPrompt(day)            – show the manager's clock-in radio card
 *   onClockedIn(day)                – shift started (Game adds the opening checklist)
 *   onRushChange(window|null)       – a rush window started / ended
 *   onClosingTime()                 – closing duties are due
 *   onShiftEnd(report)              – show the report card
 *   onEarn({ amount, kind, npcId }) – money went into the wallet (kind: 'task' | 'tip' | 'bonus' | 'wage')
 *   onRankUp(rank, index)           – a new rank was reached (perks are re-applied through onPerks)
 *   onPerks(perks)                  – current cumulative perks ({ cartSpeed, brushWidth, capColor, tipBonus })
 */

const DEFAULT_SHIFT = {
  hourlyWage: 12,
  manager: 'Club Manager',
  openingMission: null,
  closingMission: null,
  rushWindows: [],
  rep: { task: 2, satisfied: 3, neutral: 1, unsatisfied: 0, groomExcellent: 5, groomGood: 2, checklist: 3 },
  repPoints: 5,
  groomBonus: { excellent: 15, good: 6, needsWork: 0 },
  ranks: [{ id: 'rookie', title: 'Rookie Attendant', points: 0 }],
};

const DEFAULT_TIP_MOODS = {
  satisfied: { chance: 1.4, amount: 1.3 },
  neutral: { chance: 1, amount: 1 },
  unsatisfied: { chance: 0.25, amount: 0.6 },
};

const PHASES = ['preShift', 'onShift', 'ending', 'report'];

export function createShiftCounters() {
  return {
    clockInHour: null,       // hour the player clocked in (wage runs from here)
    tasks: 0,                // missions completed this shift (incl. routines)
    missionPay: 0,           // baseReward (+ groom bonuses)
    tips: 0,
    tipCount: 0,
    satisfied: 0,
    neutral: 0,
    unsatisfied: 0,
    rep: 0,                  // rep earned this shift
    groomBest: null,         // best groom rating this shift
    openingDone: false,
    closingDone: false,
    closingAnnounced: false,
    startRank: 0,
    startPoints: 0,
    lastGroomRating: null,   // pays the groom bonus with the next maintenance mission
    wagePaid: false,         // clock-out already processed (a reload during the report can't pay twice)
    wage: 0,
    hours: 0,
  };
}

export class ShiftSystem {
  /**
   * @param {object} shiftData   missions.json → shift (may be undefined)
   * @param {object} npcData     npcs.json (archetypes, tipMoods)
   * @param {WeatherSystem} weather
   * @param {MissionSystem} missions
   */
  constructor(shiftData, npcData, weather, missions) {
    const d = shiftData && typeof shiftData === 'object' ? shiftData : {};
    this.data = {
      ...DEFAULT_SHIFT,
      ...d,
      rep: { ...DEFAULT_SHIFT.rep, ...(d.rep || {}) },
      groomBonus: { ...DEFAULT_SHIFT.groomBonus, ...(d.groomBonus || {}) },
      ranks: Array.isArray(d.ranks) && d.ranks.length ? d.ranks.slice().sort((a, b) => a.points - b.points) : DEFAULT_SHIFT.ranks,
      rushWindows: Array.isArray(d.rushWindows) ? d.rushWindows : [],
    };
    this.archetypes = (npcData && npcData.archetypes) || {};
    this.tipMoods = (npcData && npcData.tipMoods) || DEFAULT_TIP_MOODS;
    this.weather = weather;
    this.missions = missions;
    this.rand = Math.random;

    this.startHour = GAME.shiftStartHour ?? 7;
    this.endHour = GAME.shiftEndHour ?? 19;
    this.closingHour = GAME.shiftClosingHour ?? 18.5;

    this.phase = 'preShift';
    this.wallet = 0;
    this.lifetimeEarnings = 0;
    this.lifetimeTips = 0;
    this.rep = 0;
    this.rankIndex = 0;
    this.shiftsWorked = 0;
    this.shift = createShiftCounters();
    this.lastReport = null;
    this._rush = null;
    // Today's club event (EventSystem sets these each day; 1 = no change)
    this.eventTipMultiplier = 1;
    this.eventGroomBonusMultiplier = 1;
    /** () => { title, icon, ... } | null: today's event for the report card (set by Game). */
    this.getEvent = null;

    this.onClockInPrompt = null;
    this.onClockedIn = null;
    this.onRushChange = null;
    this.onClosingTime = null;
    this.onShiftEnd = null;
    this.onEarn = null;
    this.onRankUp = null;
    this.onPerks = null;

    this._applyPhaseSideEffects();
  }

  // ───────────────────────────── queries ─────────────────────────────

  isOnShift() { return this.phase === 'onShift'; }

  get ranks() { return this.data.ranks; }

  getRank(i = this.rankIndex) { return this.data.ranks[Math.max(0, Math.min(this.data.ranks.length - 1, i))]; }

  /** Career points: lifetime earnings + rep × repPoints. */
  getPoints() {
    return Math.floor(this.lifetimeEarnings + this.rep * (this.data.repPoints || 0));
  }

  _rankForPoints(points) {
    let idx = 0;
    const r = this.data.ranks;
    for (let i = 0; i < r.length; i++) if (points >= r[i].points) idx = i;
    return idx;
  }

  /** { rank, next, points, frac } — frac is progress from this rank to the next (1 at the top). */
  getRankProgress() {
    const points = this.getPoints();
    const rank = this.getRank();
    const next = this.data.ranks[this.rankIndex + 1] || null;
    const frac = next ? Math.max(0, Math.min(1, (points - rank.points) / Math.max(1, next.points - rank.points))) : 1;
    return { rank, next, points, frac, index: this.rankIndex };
  }

  /** Cumulative perks of every rank reached so far (later ranks override). */
  getPerks() {
    const perks = { cartSpeed: 0, brushWidth: 0, capColor: null, tipBonus: 0 };
    for (let i = 0; i <= this.rankIndex && i < this.data.ranks.length; i++) {
      const p = this.data.ranks[i].perks;
      if (p && typeof p === 'object') Object.assign(perks, p);
    }
    return perks;
  }

  /** Active rush window ({label, start, end}) at the current time, or null. */
  getRushWindow(t = this.weather.timeOfDay) {
    if (this.phase !== 'onShift') return null;
    for (const w of this.data.rushWindows) if (w && t >= w.start && t < w.end) return w;
    return null;
  }

  // ───────────────────────────── per frame ─────────────────────────────

  /**
   * @param {number} dt
   * @param {boolean} quiet  true when nothing modal is going on (no dialogue, not grooming),
   *                         so the report card may appear
   */
  update(dt, quiet = true) {
    const w = this.weather;
    if (this.phase === 'onShift') {
      const t = w.timeOfDay;
      // Rush windows speed up the radio
      const rush = this.getRushWindow(t);
      if (rush !== this._rush) {
        this._rush = rush;
        this.missions.dispatchRate = rush ? (GAME.rushDispatchScale ?? 2) : 1;
        if (this.onRushChange) this.onRushChange(rush);
      }
      if (!this.shift.closingAnnounced && t >= this.closingHour) {
        this.shift.closingAnnounced = true;
        if (this.onClosingTime) this.onClosingTime();
      }
      if (t >= this.endHour || t < this.startHour - 0.01) {
        // Clock out: stop the clock at 7 PM and wait for a quiet moment
        w.timeOfDay = this.endHour;
        this.phase = 'ending';
        this._applyPhaseSideEffects();
      }
    }
    if (this.phase === 'ending' && quiet) this.finishShift();
  }

  // ───────────────────────────── transitions ─────────────────────────────

  /** Stop / start the clock and the radio to match the phase. */
  _applyPhaseSideEffects() {
    const on = this.phase === 'onShift';
    this.weather.clockFrozen = !on;
    this.missions.dispatchEnabled = on;
    if (!on) {
      this.missions.dispatchRate = 1;
      this._rush = null;
      if (this.missions.pendingDispatch && this.phase !== 'onShift') this.missions.declineDispatch('offShift');
    }
  }

  /** Called at the start of a day (and after loading a pre-shift save): ask for clock-in. */
  promptClockIn() {
    if (this.phase !== 'preShift') return;
    if (this.onClockInPrompt) this.onClockInPrompt(this.weather.day || 1);
  }

  /** Start the shift (from the clock-in card, or the first-day tutorial). */
  clockIn() {
    if (this.phase !== 'preShift') return false;
    this.phase = 'onShift';
    const s = this.shift;
    s.clockInHour = Math.min(this.weather.timeOfDay, this.endHour);
    s.startRank = this.rankIndex;
    s.startPoints = this.getPoints();
    this._applyPhaseSideEffects();
    if (this.data.openingMission) this.missions.startShiftMission(this.data.openingMission);
    if (this.onClockedIn) this.onClockedIn(this.weather.day || 1);
    return true;
  }

  /** Clock out now: pay wages, build the report card. */
  finishShift() {
    if (this.phase === 'report') return this.lastReport;
    this.weather.timeOfDay = Math.max(this.weather.timeOfDay, this.endHour);
    const s = this.shift;
    if (!s.wagePaid) {
      const clockIn = s.clockInHour == null ? this.startHour : s.clockInHour;
      s.hours = Math.max(0, Math.min(this.endHour - this.startHour, this.endHour - clockIn));
      s.wage = Math.round(s.hours * (this.data.hourlyWage || 0));
      s.wagePaid = true;
      if (s.wage > 0) this._earn(s.wage, 'wage');
      this.shiftsWorked++;
    }
    this.missions.clearShiftMissions();
    this.phase = 'report';
    this._applyPhaseSideEffects();
    this.lastReport = this.buildReport(s.wage, s.hours);
    if (this.onShiftEnd) this.onShiftEnd(this.lastReport);
    return this.lastReport;
  }

  /** Report card data for the shift that just ended. */
  buildReport(wage = 0, hours = 0) {
    const s = this.shift;
    const reactions = s.satisfied + s.neutral + s.unsatisfied;
    const happiness = reactions > 0 ? (s.satisfied + s.neutral * 0.5) / reactions : null;
    const prog = this.getRankProgress();
    return {
      day: this.weather.day || 1,
      hours,
      tasks: s.tasks,
      missionPay: s.missionPay,
      tips: s.tips,
      tipCount: s.tipCount,
      wage,
      total: wage + s.missionPay + s.tips,
      happiness,
      reactions: { satisfied: s.satisfied, neutral: s.neutral, unsatisfied: s.unsatisfied },
      courtQuality: this.getCourtQuality ? this.getCourtQuality() : null,
      groomBest: s.groomBest,
      openingDone: s.openingDone,
      closingDone: s.closingDone,
      rep: s.rep,
      wallet: this.wallet,
      rankBefore: this.getRank(s.startRank),
      rank: prog.rank,
      rankIndex: this.rankIndex,
      rankUp: this.rankIndex > s.startRank,
      unlocks: this.data.ranks.slice(s.startRank + 1, this.rankIndex + 1).map(r => ({ title: r.title, unlock: r.unlock || '' })),
      next: prog.next,
      points: prog.points,
      pointsGained: prog.points - s.startPoints,
      frac: prog.frac,
      event: this.getEvent ? this.getEvent() : null,
    };
  }

  /** "Next day": 7:00 AM tomorrow, fresh counters, repeatable missions return. */
  nextDay() {
    if (this.phase !== 'report' && this.phase !== 'ending') return false;
    if (this.phase === 'ending') this.finishShift();
    this.weather.startNewDay(this.startHour);
    this.missions.newDay();
    this.shift = createShiftCounters();
    this.phase = 'preShift';
    this._applyPhaseSideEffects();
    this.promptClockIn();
    return true;
  }

  // ───────────────────────────── money + rep ─────────────────────────────

  _earn(amount, kind, npcId = null) {
    amount = Math.max(0, Math.round(amount));
    if (!amount) return 0;
    this.wallet += amount;
    this.lifetimeEarnings += amount;
    if (kind === 'tip') this.lifetimeTips += amount;
    if (this.onEarn) this.onEarn({ amount, kind, npcId });
    this._checkRank();
    return amount;
  }

  _addRep(n) {
    if (!n) return;
    this.rep += n;
    this.shift.rep += n;
    this._checkRank();
  }

  _checkRank() {
    const idx = this._rankForPoints(this.getPoints());
    if (idx > this.rankIndex) {
      this.rankIndex = idx;
      if (this.onRankUp) this.onRankUp(this.getRank(), idx);
      if (this.onPerks) this.onPerks(this.getPerks());
    }
  }

  /**
   * Roll a tip from an NPC. Chance and amount come from the archetype (tipChance, tipRange)
   * scaled by the mood (npcs.json tipMoods) and the Head of Grounds perk. Returns dollars (0 = none).
   */
  rollTip(npc, mood) {
    if (!npc) return 0;
    const arch = this.archetypes[(npc.data && npc.data.archetype) || npc.archetype] || {};
    const m = this.tipMoods[mood] || this.tipMoods.neutral || { chance: 1, amount: 1 };
    const chance = Math.min(0.95, (Number.isFinite(arch.tipChance) ? arch.tipChance : 0.3) * (m.chance ?? 1));
    if (this.rand() >= chance) return 0;
    const range = Array.isArray(arch.tipRange) ? arch.tipRange : [1, 5];
    const lo = Number(range[0]) || 0;
    const hi = Math.max(lo, Number(range[1]) || lo);
    const base = lo + this.rand() * (hi - lo);
    const bonus = (1 + (this.getPerks().tipBonus || 0)) * (this.eventTipMultiplier || 1);
    return Math.max(1, Math.round(base * (m.amount ?? 1) * bonus));
  }

  /**
   * A mission finished: base pay, rep, and tips from everyone involved. `npcsById` maps
   * NPC id → NPC. `moods` overrides per-NPC moods (defaults to mission.reactions, then
   * npc.mood). Returns { pay, tips: [{ npcId, amount }] }.
   */
  recordMissionComplete(mission, npcsById, moods = null) {
    const out = { pay: 0, tips: [] };
    if (!mission) return out;
    const s = this.shift;
    s.tasks++;
    const pay = this.missions.getBaseReward(mission);
    let bonus = 0;
    if (mission.type === 'maintenance' && s.lastGroomRating) {
      bonus = Math.round((this.data.groomBonus[s.lastGroomRating] || 0) * (this.eventGroomBonusMultiplier || 1));
      s.lastGroomRating = null;
    }
    if (pay + bonus > 0) {
      s.missionPay += pay + bonus;
      out.pay = this._earn(pay + bonus, 'task');
    }
    this._addRep(this.data.rep.task || 0);
    if (mission.source === 'shift') {
      if (mission.id === this.data.openingMission) s.openingDone = true;
      if (mission.id === this.data.closingMission) s.closingDone = true;
      this._addRep(this.data.rep.checklist || 0);
    }

    // Who might tip: everyone who reacted, the client, and the NPCs you talked to
    const reactions = moods || mission.reactions || {};
    const people = new Set(Object.keys(reactions));
    if (mission.client) people.add(mission.client);
    for (const st of mission.steps || []) if (st && st.npcId) people.add(st.npcId);
    if (mission.source === 'shift') people.clear(); // routines aren't tipped
    for (const id of people) {
      const npc = npcsById && npcsById.get ? npcsById.get(id) : null;
      if (!npc) continue;
      const mood = reactions[id] || npc.mood || 'neutral';
      const tip = this.rollTip(npc, mood);
      if (tip > 0) {
        s.tips += tip;
        s.tipCount++;
        this._earn(tip, 'tip', id);
        out.tips.push({ npcId: id, amount: tip });
      }
    }
    return out;
  }

  /** A member reacted to a choice (satisfied / neutral / unsatisfied). */
  recordReaction(mood) {
    const s = this.shift;
    if (mood === 'satisfied') s.satisfied++;
    else if (mood === 'unsatisfied') s.unsatisfied++;
    else s.neutral++;
    this._addRep(this.data.rep[mood] ?? this.data.rep.neutral ?? 0);
  }

  /** A grooming session ended ({ rating }). The bonus is paid with the maintenance mission. */
  recordGroom(score) {
    const r = score && score.rating;
    if (!r) return;
    const s = this.shift;
    const rank = { needsWork: 1, good: 2, excellent: 3 };
    if (!s.groomBest || (rank[r] || 0) > (rank[s.groomBest] || 0)) s.groomBest = r;
    s.lastGroomRating = r;
    if (r === 'excellent') this._addRep(this.data.rep.groomExcellent || 0);
    else if (r === 'good') this._addRep(this.data.rep.groomGood || 0);
  }

  // ───────────────────────────── save / load ─────────────────────────────

  getState() {
    const s = this.shift;
    return {
      phase: this.phase,
      wallet: this.wallet,
      lifetimeEarnings: this.lifetimeEarnings,
      lifetimeTips: this.lifetimeTips,
      rep: this.rep,
      rankIndex: this.rankIndex,
      shiftsWorked: this.shiftsWorked,
      current: {
        clockInHour: s.clockInHour,
        tasks: s.tasks, missionPay: s.missionPay, tips: s.tips, tipCount: s.tipCount,
        satisfied: s.satisfied, neutral: s.neutral, unsatisfied: s.unsatisfied, rep: s.rep,
        groomBest: s.groomBest, openingDone: s.openingDone, closingDone: s.closingDone,
        closingAnnounced: s.closingAnnounced, startRank: s.startRank, startPoints: s.startPoints,
        lastGroomRating: s.lastGroomRating, wagePaid: s.wagePaid, wage: s.wage, hours: s.hours,
      },
    };
  }

  /**
   * Restore (already sanitized). `state` null = a save from before the shift loop: the
   * phase is derived from the clock (inside shift hours → on shift, otherwise the next
   * morning before clock-in).
   */
  setState(state) {
    const w = this.weather;
    if (state && typeof state === 'object') {
      this.wallet = state.wallet || 0;
      this.lifetimeEarnings = Math.max(state.lifetimeEarnings || 0, this.wallet);
      this.lifetimeTips = state.lifetimeTips || 0;
      this.rep = state.rep || 0;
      this.shiftsWorked = state.shiftsWorked || 0;
      this.rankIndex = Math.max(0, Math.min(this.data.ranks.length - 1, state.rankIndex || 0));
      const c = state.current || {};
      this.shift = { ...createShiftCounters(), ...c };
      this.phase = PHASES.includes(state.phase) ? state.phase : 'onShift';
    } else {
      this.phase = 'onShift';
      this.shift = createShiftCounters();
      this.shift.clockInHour = this.startHour;
    }
    // Never demote; promote if the numbers say so (e.g. edited rank data)
    this.rankIndex = Math.max(this.rankIndex, this._rankForPoints(this.getPoints()));

    const t = w.timeOfDay;
    if (this.phase === 'onShift' || this.phase === 'ending') {
      if (t >= this.endHour) this.phase = 'ending';
      else if (t < this.startHour) {
        // Legacy save from the small hours (the day counter already rolled at midnight):
        // start this morning's shift fresh
        w.timeOfDay = this.startHour;
        this.phase = 'preShift';
        this.shift = createShiftCounters();
      }
    }
    if (this.phase === 'preShift') {
      // Waiting to clock in: the clock stands at (or after) the start hour
      if (w.timeOfDay >= this.endHour) w.startNewDay(this.startHour);
      else if (w.timeOfDay < this.startHour) w.timeOfDay = this.startHour;
    }
    if (this.phase === 'report') this.phase = 'ending'; // re-show the report card
    this._rush = null;
    this._applyPhaseSideEffects();
    if (this.onPerks) this.onPerks(this.getPerks());
  }
}
