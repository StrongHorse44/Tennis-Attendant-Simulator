import { GAME, SIZES } from '../utils/Constants.js';
import { Quality } from '../graphics/Quality.js';
import { CameraTracker } from '../entities/CharacterModel.js';
import { planLevelRoute, nearestExit, inFootprint } from '../world/Ground.js';
import { planRoute } from '../world/NavRooms.js';

/**
 * SpectatorDirector — members come and watch the Centre Court (court6) matches from the stands.
 *
 * A session runs while the court6 match is live (MatchSystem.isLive), still walking in more than
 * 15 s after its 'start' (at once when too few free members could be seated within a minute, so
 * their walk overlaps the players'), or shaking hands; never in the rain or when disabled. During
 * a session:
 *  - Recruiting: one member every 0.5–1 s while the stands fill (the session's first FILL_S),
 *    then every 4–9 s, until the target
 *    T = clamp(round(spectatorBase × event crowd × situation), 2, tier cap) is reached.
 *    Candidates are free members (no staff, no request, not in a mission, not playing or booked
 *    within 30 min, within 120 m), weighted by their relationship to the players (family /
 *    spouse ×5 … acquaintance ×1.3), a liking for the stadium, archetype, distance, whether their
 *    walk in fits the time there is (while the stands fill, what is left of FILL_S; later the
 *    arrive timeout; a walk that would run late weighs (budget / eta)^20) and whether they left
 *    the stands in the last 4 minutes (×0.3; nobody goes straight back in within a minute of
 *    leaving). Each takes the cheapest free reserved stand seat (near the net, low rows, side
 *    stands, the member's own side of the bowl; the Members' Box for VIPs; each spectator
 *    already on an aisle / a stand makes it dearer, so the crowd spreads over both side stands
 *    and several aisles; a seat whose walk would run past the budget is dearer still) and walks
 *    in through the aisles (Ground.planLevelRoute → NPC.goSpectate), briskly (up to HURRY_MAX)
 *    while the stands fill if a stroll would be late.
 *  - Records (a pool of 12) follow each spectator: 'in' (walking to the seat; helped into it after
 *    GAME.spectatorArriveTimeout when the camera is away, or after 150 s), 'seated' (stays 90–240 s
 *    or until the match ends; re-seated after a chat; mission-involved spectators stay) and 'out'
 *    (walking up and out of the footprint to a spot on the rim beside their aisle top; placed there
 *    after 60 s). Time spent chatting with the player never counts toward those timeouts.
 *  - Release: match over ('finish', or not live for 10 s) staggered 1–6 s, nearest to an aisle
 *    first; rain 0–2 s; releaseAll() at once; a stay that ran out. A spectator who starts playing
 *    or goes away is dropped.
 *  - Points (MatchSystem.onPointEnd → onPoint): seated spectators clap (winners, aces, long
 *    rallies more often; a relative of the winner always), bubbles from npcs.json `courtside`
 *    (one every 8 s at most), applause / "ooh" / "aww" by distance, and the crowd impostors lift.
 *  - Crowd impostors: Stadium.setCrowd(0.3 × crowd) during a session, 0.05 in a rain delay, else 0.
 *  - Announce: '🏟️ Centre Court: A v B' when a match starts.
 *
 * NPC contract (Centre Court API): goSpectate(seat, route, speed), leaveSpectating(route), placeAt(x, z,
 * yaw, groundY = null → Ground.groundAt), spectating, ghost / setGhost(on). MatchSystem: getMatch,
 * isLive, isBookedSoon, hooks onPointEnd / onMatchEvent (wired by Game). Each has a fallback so the
 * director degrades instead of throwing.
 *
 * update(dt) is allocation-free per frame: pooled records, reused sets and typed arrays; the
 * 0.5 s tick does the bookkeeping, the frame only fires due reactions and sounds. Routes (one per
 * recruit / release) are the only allocations.
 */

const TICK = 0.5;                 // bookkeeping tick (s)
const POOL = 12;                  // spectator records
const MAX_CANDS = 24;             // weighted candidates per recruit (Float32Array)
const RECRUIT_MIN = 4, RECRUIT_MAX = 9, RECRUIT_RETRY = 2;
const BURST_MIN = 0.5, BURST_MAX = 1;   // while the stands fill they come at once (the walk takes most of the minute)
const RECRUIT_RADIUS = 120;       // m from the court centre
const WALKIN_GRACE = 15;          // s after 'start' before a walk-in counts as a session
const NOT_LIVE_RELEASE = 10;      // s not live (walk-off, …) before everyone leaves
const STAY_MIN = 90, STAY_MAX = 240;
const ARRIVE_HARD = 150;          // s: helped into the seat regardless of the camera
const CAM_FAR = 25;               // m: placeAt only when the camera is at least this far
const OUT_TIMEOUT = 60;           // s: a leaver still in the footprint is placed at the exit
// Both anti-repeat windows are in director seconds (the clock that runs while the game does):
// nobody goes straight back in (COOL_OFF), and someone who left within RECENT (about one stay)
// weighs ×0.3. (Game hours here never overlapped the cool-off: 60 s ≈ 0.64 game hours.)
const COOL_OFF = 60;              // s: someone who just left isn't sent straight back in
const RECENT = 240;               // s: watched this recently → ×0.3 (longer than COOL_OFF)
const LINE_GAP = 8;               // s between spectator bubbles
const APPROACH_NEAR = 1.2;        // m: re-seat from here with a one-point route
const INF = Infinity;

// Filling the stands (G2: the target seated within a minute of the session opening). A recruit's
// walk is estimated from the straight line (× ROUTE_K through the aisles, + SIT_S to settle into
// the seat) and checked against a budget: during the fill (the session's first FILL_S s) what is
// left of FILL_S (at least MIN_BUDGET) at up to HURRY_MAX, since recruits who need it walk
// briskly; after it (a replacement for a stay that ran out, at a stroll) the arrive timeout, so
// replacements are weighed as before. A walk-in whose stands would not fill in time at a stroll
// opens at 'start' (_openEarly), so members across the club still make the minute.
const FILL_S = 55;                // s: stands full by now (5 s margin on the minute)
const MIN_BUDGET = 20;            // s
const ROUTE_K = 1.1;              // route length / straight line (walk-ins measured 1.04–1.14)
const SIT_S = 3;                  // s: settling onto the seat
const SEAT_R = 13;                // m: the stand seats' distance from the court centre (recruit estimate)
const LATE_POW = 20;              // recruit weight × (budget / eta)^20 when the walk would run late
const LATE_W_MIN = 1e-3;          // …never 0, so a far pool still yields a pick
const LATE_COST = 0.1;            // seat cost per second a seat's walk would run past the budget
const HURRY_MAX = 1.9;            // m/s: a recruit whose stroll (SIZES.npcSpeed) would miss the fill walks
                                  // briskly, up to this (the fill's fit checks assume it); never after it
// Spreading the crowd: seat cost per spectator already on that aisle / that stand (VIPs – the
// players' family, entitled and veteran members – feel half of it and keep the front seats).
const SPREAD_AISLE = 0.55, SPREAD_SIDE = 0.25, SPREAD_VIP = 0.5;
const SIDE_IDX = { w: 0, e: 1, n: 2, s: 3 };
// Leavers walk on past their aisle top to a spot on the rim beside it and stop within the usual
// 1.5 m of it (2.2–5.1 m from the top), so nobody parks on the aisle top itself (pw's is
// court6_exit, the Players' Walk head: where the cart waits and after-hours tennis ends). The spot
// is EXIT_ALONG m along the rim (the next step for that aisle, so six leavers in a row stand
// apart; both ways on the side stands, outward only on the end stands so it stays out of the
// camera wells behind the baselines) and EXIT_OUT m further out from the cut.
const EXIT_ALONG = [3.5, -3.5, 5, -5, 6.5, -6.5];
const EXIT_OUT = 1.2;

/** Clip a reaction plays (NPC.react seats them: clap → sit_clap, react_happy → sit_cheer). */
const CLAP = 'clap', CHEER = 'react_happy';
const EMOJI_PARTY = '\uD83C\uDF89', EMOJI_RAISE = '\uD83D\uDE4C', EMOJI_WOW = '\uD83D\uDE2E';   // 🎉 🙌 😮
const LIVE = { warmup: 1, setup: 1, point: 1, interrupted: 1 };
const REL_W = { family: 5, spouse: 5, friend: 3, mentor: 3, student: 3, rival: 2.5, acquaintance: 1.3 };
const ARCH_W = { social: 1.4, veteran: 1.4, competitive: 1.4, junior: 1.6, clueless: 0.8 };
const RELATIVE = { family: 1, spouse: 1 };
const VIP_ARCH = { entitled: 1, veteran: 1 };

/** Daytime fallback bubbles for members without a `courtside` pool (≤ 22 chars). */
const DEFAULT_LINES = {
  winner: ['Shot!', 'Oh, well played!'],
  ace: ['Ace!', 'Untouchable!'],
  rally: ['What a rally!', 'Ooh!'],
  error: ['Oh, unlucky.', 'So close.'],
  game: ['Game!', 'Lovely game.'],
  matchWin: ['Bravo!', 'Well played, both!'],
};
const DEFAULT_LINE_CHANCE = 0.5;   // a member without their own pool speaks up half as often

const rand = (a, b) => a + Math.random() * (b - a);
const NAV_LEG = (ax, az, bx, bz, out) => planRoute(ax, az, bx, bz, out);

function makeRecord(i) {
  return {
    i, npc: null, seat: null, phase: 'free', t: 0, seatedT: 0, stay: 0,
    reactAt: INF, reactKind: null, emoji: null, lineKey: null, releaseAt: INF,
    vip: false, ax: 0, az: 0,
  };
}

export class SpectatorDirector {
  /**
   * @param {object} o
   * @param {import('../entities/NPC.js').NPC[]} o.npcs
   * @param {import('./MatchSystem.js').MatchSystem} o.matches
   * @param {import('./MissionSystem.js').MissionSystem} [o.missions]  collectInvolvedNpcIds(set)
   * @param {import('./SoundSystem.js').SoundSystem} [o.sound]         playApplause / playCrowdVoice
   * @param {import('../world/Stadium.js').Stadium} [o.stadium]        world.stadium (null → inert)
   * @param {import('./WeatherSystem.js').WeatherSystem} [o.weather]   timeOfDay, day, getWeather()
   * @param {import('./EventSystem.js').EventSystem} [o.events]        today.crowd
   * @param {(text: string) => void} [o.announce]
   */
  constructor({ npcs, matches, missions = null, sound = null, stadium = null, weather = null, events = null, announce = null } = {}) {
    this.npcs = npcs || [];
    this.matches = matches || null;
    this.missions = missions;
    this.sound = sound;
    this.stadium = stadium || null;
    this.weather = weather;
    this.events = events;
    this.announce = typeof announce === 'function' ? announce : null;

    this.layout = this.stadium ? this.stadium.layout : null;
    this.courtId = this.layout ? this.layout.id : null;
    this.enabled = !!this.courtId;
    /** Spectator records (debug): { npc, seat, phase 'free'|'in'|'seated'|'out', t, seatedT, stay, … }. */
    this.records = [];
    for (let i = 0; i < POOL; i++) this.records.push(makeRecord(i));
    /**
     * Counters for tests / tuning (recent: recruits who had left within RECENT, weighed ×0.3;
     * earlyOpens: walk-ins whose session opened at 'start' because the recruit pool was far).
     */
    this.stats = { recruits: 0, seated: 0, reseats: 0, placed: 0, released: 0, outPlaced: 0, dropped: 0, reactions: 0, lines: 0, applause: 0, recent: 0, earlyOpens: 0 };
    /** Current session state (debug). */
    this.session = { active: false, target: 0, count: 0, crowd: 0, matchId: null };

    this._t = 0;
    this._tickT = 0;
    this._recruitT = 0.5;
    this._match = null;
    this._startT = 0;
    this._early = null;                 // walk-in opened at 'start' (far pool; _openEarly), per match
    this._announced = null;
    this._held = null;                  // a match releaseAll() ended the visit to
    this._notLiveT = 0;
    this._crowdFrac = -1;
    this._lineT = -INF;
    this._pendingReact = 0;
    this._label = 'Centre Court';
    /** Why the last releaseAll() happened (debug). */
    this.lastRelease = null;
    this._involved = new Set();
    this._involvedFresh = false;
    this._entryFx = 1;                  // × for the entry id (final / exhibition), per match
    this._leftAt = new Map();           // npc → director time when their record ended (cool-off, recent)
    this._openT = 0;                    // director time the current session opened (the fill budget)
    const n = Math.max(MAX_CANDS, this.npcs.length);
    this._cands = new Array(n).fill(null);
    this._w = new Float32Array(n);
    this._keys = new Float32Array(POOL);
    this._exit = { x: 0, z: 0, y: 0 };
    this._snd = { at: INF, applause: 0, vol: 0, ooh: false, aww: false };
    this._aisleAt = new Map();          // aisle id → along coordinate on its stand
    this._aisleIdx = new Map();         // aisle id → index into _occA
    if (this.layout) {
      for (const a of this.layout.aisles) {
        this._aisleAt.set(a.id, a.at);
        this._aisleIdx.set(a.id, this._aisleIdx.size);
      }
    }
    this._occA = new Uint8Array(Math.max(1, this._aisleIdx.size));   // spectators per aisle (_pickSeat)
    this._exitSeq = new Uint8Array(Math.max(1, this._aisleIdx.size)); // next EXIT_ALONG step per aisle
    this._occS = new Uint8Array(4);                                    // …per stand (w, e, n, s)
    this._walkSpeed = SIZES.npcSpeed || 1.5;
  }

  // ───────────────────────────── public API ─────────────────────────────

  /** Per frame (after MatchSystem.update): due reactions and sounds; the 0.5 s bookkeeping tick. */
  update(dt) {
    if (!this.courtId || !(dt > 0)) return;
    this._t += dt;
    if (this._pendingReact > 0) this._fireReactions();
    if (this._snd.at <= this._t) this._playSound();
    this._tickT -= dt;
    if (this._tickT <= 0) {
      this._tickT += TICK;
      if (this._tickT <= 0) this._tickT = TICK;
      this._tick();
    }
  }

  /** MatchSystem.onPointEnd: `info` is MatchSystem's reused object (read now, never kept). */
  onPoint(courtId, info) {
    if (!this.enabled || courtId !== this.courtId || !info || !this.session.active) return;
    const outcome = info.outcome;
    const win = outcome === 'winner' || outcome === 'ace';
    const rally = Number(info.rally) || 0;
    const winner = info.winnerNpc || null;
    const big = win || !!info.matchWon;
    const key = info.matchWon ? 'matchWin' : outcome === 'ace' ? 'ace' : rally >= 8 ? 'rally'
      : win ? 'winner' : info.gameWon ? 'game' : 'error';
    const lineDue = this._t - this._lineT >= LINE_GAP;
    let seated = 0, speaker = null, speakerScore = 0;
    for (let i = 0; i < POOL; i++) {
      const r = this.records[i];
      if (r.phase !== 'seated' || !this._isSeated(r)) continue;
      seated++;
      const relative = !!winner && this._isRelative(r.npc, winner);
      let p = rally >= 8 ? 0.9 : win ? 0.7 : 0.3;
      if (relative) p = 1;
      if (Math.random() >= p) continue;
      r.reactAt = this._t + rand(0.1, 0.6);
      r.reactKind = big || relative ? CHEER : CLAP;
      r.emoji = info.matchWon ? (Math.random() < 0.5 ? EMOJI_PARTY : null)
        : relative && win ? (Math.random() < 0.5 ? EMOJI_RAISE : null)
        : rally >= 8 ? (Math.random() < 0.15 ? EMOJI_WOW : null) : null;
      r.lineKey = null;
      this._pendingReact = 1;
      if (lineDue && !(relative && key === 'error')) {
        // Speaker: a relative of the winner first (not to commiserate), then someone with their own line
        const own = this._ownLines(r.npc, key);
        const score = (relative ? 4 : 0) + (own ? 2 : 0) + Math.random();
        if (score > speakerScore) { speakerScore = score; speaker = r; }
      }
    }
    if (speaker && (this._ownLines(speaker.npc, key) || Math.random() < DEFAULT_LINE_CHANCE)) {
      speaker.lineKey = key;
      this._lineT = this._t;
    }
    const crowd = this._crowdFrac > 0 ? this._crowdFrac : 0;
    if (seated === 0 && crowd === 0) return;
    const k = Math.min(1, 0.25 + 0.06 * seated + 0.2 * crowd + (info.gameWon ? 0.25 : 0) + (info.matchWon ? 0.4 : 0) + Math.min(0.2, 0.02 * rally));
    const s = this._snd;
    s.at = this._t + 0.15;
    s.applause = k;
    s.vol = this._volume();
    s.ooh = rally >= 8;
    s.aww = !win && Math.random() < 0.3;
    if (this.stadium) { try { this.stadium.cheer(k); } catch (e) { /* cosmetic */ } }
  }

  /** MatchSystem.onMatchEvent: 'start' | 'rain' | 'resume' | 'handshake' | 'finish'. */
  onMatchEvent(courtId, kind, m) {
    if (!this.courtId || courtId !== this.courtId) return;
    if (kind === 'start') this._matchSeen(m || null);
    else if (kind === 'rain') this._releaseSpread(0, 2, false);
    else if (kind === 'resume') this._notLiveT = 0;
    else if (kind === 'finish') {
      if (!m || m === this._match) this._match = null;
      this._releaseSpread(1, 6, true);
    }
  }

  /**
   * Everyone leaves now (after-hours tennis begins); the crowd impostors go at once, and the
   * match on court now gets no more spectators (the next one starts afresh).
   */
  releaseAll(reason = '') {
    for (let i = 0; i < POOL; i++) {
      const r = this.records[i];
      if (r.phase !== 'in' && r.phase !== 'seated') continue;
      r.reactAt = INF;
      if (!this._dropIfGone(r)) this._leave(r);
    }
    this._snd.at = INF;
    this._crowdFrac = 0;
    if (this.stadium) { try { this.stadium.setCrowd(0, true); } catch (e) { /* cosmetic */ } }
    this.session.active = false;
    this._recruitT = RECRUIT_MIN;
    this._held = this._getMatch();
    this.lastRelease = reason || 'releaseAll';
  }

  setEnabled(on) {
    const v = !!on && !!this.courtId;
    if (v === this.enabled) return;
    this.enabled = v;
    if (!v) this.releaseAll('disabled');
  }

  // ───────────────────────────── the 0.5 s tick ─────────────────────────────

  _tick() {
    const m = this._getMatch();
    if (m !== this._match) {
      if (this._match && !m) this._releaseSpread(1, 6, true);   // gone without a 'finish'
      this._match = null;
      if (m) this._matchSeen(m);
    }
    const raining = this._raining();
    this._involvedFresh = false;
    let active = false;
    if (this._held && this._held !== m) this._held = null;
    if (this.enabled && m && !raining && m !== this._held) {
      const ph = m.phase;
      active = this._isLive(m) || ph === 'handshake'
        || (ph === 'walkIn' && (this._t - this._startT > WALKIN_GRACE || this._openEarly(m)));
    }
    const S = this.session;
    if (active && !S.active) this._openT = this._t;   // (re)opened: the stands have FILL_S to fill
    S.active = active;
    S.matchId = m && m.entry ? m.entry.id : null;

    // Release rules
    if (raining) this._releaseSpread(0, 2, false);
    else if (m && !active) {
      this._notLiveT += TICK;
      if (this._notLiveT >= NOT_LIVE_RELEASE) this._releaseSpread(1, 6, true);
    } else if (!m) this._releaseSpread(1, 6, true);
    if (active) this._notLiveT = 0;

    // Records
    let count = 0;
    for (let i = 0; i < POOL; i++) {
      const r = this.records[i];
      if (r.phase === 'free') continue;
      this._updateRecord(r);
      if (r.phase === 'in' || r.phase === 'seated') count++;
    }

    // Recruiting (not while they shake hands: the match is about to end)
    S.target = active ? this._targetCount(m) : 0;
    S.count = count;
    if (active && m.phase !== 'handshake') {
      this._recruitT -= TICK;
      if (this._recruitT <= 0 && count < S.target) {
        // while the stands fill (the session's first FILL_S) they come at burst pace; after that
        // (a stay ran out) one every 4–9 s
        const burst = this._filling();
        this._recruitT = this._recruit(m) ? (burst ? rand(BURST_MIN, BURST_MAX) : rand(RECRUIT_MIN, RECRUIT_MAX)) : RECRUIT_RETRY;
      }
    } else if (this._recruitT < 0.5) this._recruitT = 0.5;

    // Crowd impostors
    let frac = 0;
    if (this.enabled && m && m !== this._held) {
      if (active) frac = Math.min(1, 0.3 * this._eventCrowd());
      else if (raining) frac = 0.05;
    }
    S.crowd = frac;
    if (frac !== this._crowdFrac && this.stadium) {
      this._crowdFrac = frac;
      try { this.stadium.setCrowd(frac); } catch (e) { /* cosmetic */ }
    }
  }

  _updateRecord(r) {
    if (this._dropIfGone(r)) return;
    const npc = r.npc;
    // A chat with the player holds the clock: it never uses up the time before a spectator is
    // helped into the seat ('in', ARRIVE_HARD) or placed outside ('out', OUT_TIMEOUT)
    if (npc.state !== 'talking') r.t += TICK;
    if (r.phase === 'out') {
      const p = npc.body.position;
      if (!inFootprint(p.x, p.z, 0)) { this._endRecord(r); return; }
      if (r.t >= OUT_TIMEOUT && npc.state !== 'talking') {
        const e = nearestExit(p.x, p.z, this._exit);
        if (e) {
          this._exitSpot(e);
          try { npc.placeAt(e.x, e.z, null, 0); } catch (err) { /* keep the record */ }
        }
        this.stats.outPlaced++;
        this._endRecord(r);
      }
      return;
    }
    // A release that is due (a chat finishes first)
    if (r.releaseAt <= this._t && npc.state !== 'talking') { this._leave(r); return; }

    if (r.phase === 'in') {
      if (this._isSeated(r)) { r.phase = 'seated'; r.t = 0; this.stats.seated++; return; }
      const st = npc.state;
      if (st === 'talking') return;
      if (st === 'wandering' && npc.spectating === r.seat && npc._seatTarget === r.seat) {
        if (r.t < (GAME.spectatorArriveTimeout ?? 90)) return;
        if (r.t < ARRIVE_HARD && !this._cameraFar(npc, r)) return;
        this._placeInSeat(r);
        return;
      }
      // Gave up (stuck: idle, held), lost the seat claim or wandered off: help or re-issue; a
      // seat that can't be had any more (someone else's now) ends the visit
      const ok = r.t >= ARRIVE_HARD || this._cameraFar(npc, r) ? this._placeInSeat(r) : this._goSeat(r);
      if (!ok) this._leave(r);
      return;
    }

    // seated
    if (this._isSeated(r)) {
      r.seatedT += TICK;
      if (r.seatedT >= r.stay && r.releaseAt === INF && !npc.hasRequest && !this._isInvolved(npc)) {
        r.releaseAt = this._t;
      }
      return;
    }
    const st = npc.state;
    if (st === 'talking' || st === 'sitting') return;   // chatting; on the way down into the seat
    if (st === 'wandering' && npc.spectating === r.seat) { r.phase = 'in'; r.t = 0; return; }   // walking back
    this.stats.reseats++;
    r.phase = 'in';
    r.t = 0;
    if (!this._goSeat(r)) this._leave(r);
  }

  // ───────────────────────────── recruiting ─────────────────────────────

  _targetCount(m) {
    let fx = this._entryFx;
    const w = this._weatherName();
    if (w === 'cloudy' || w === 'windy') fx *= 0.8;
    const tod = this.weather ? Number(this.weather.timeOfDay) : 12;
    if (tod < 9 || tod > 18) fx *= 0.7;
    const tier = Quality.tier;
    const cap = tier === 'low' ? (GAME.spectatorMaxLow ?? 4) : tier === 'medium' ? (GAME.spectatorMaxMedium ?? 8) : (GAME.spectatorMax ?? 10);
    const T = Math.round((GAME.spectatorBase ?? 5) * this._eventCrowd() * fx);
    return Math.max(Math.min(2, cap), Math.min(cap, POOL, T));
  }

  _recruit(m) {
    const L = this.layout;
    const p0 = m.players && m.players[0] ? m.players[0].npc : null;
    const p1 = m.players && m.players[1] ? m.players[1].npc : null;
    const budget = this._fillBudget(), v = this._recruitSpeed();
    const cands = this._cands, W = this._w;
    let n = 0, total = 0;
    for (let i = 0; i < this.npcs.length && n < W.length; i++) {
      const npc = this.npcs[i];
      if (!this._isCandidate(npc)) continue;
      const bp = npc.body.position;
      const d = Math.hypot(bp.x - L.cx, bp.z - L.cz);
      if (!(d <= RECRUIT_RADIUS)) continue;
      let w = 1;
      const rw = Math.max(this._relWeight(npc, p0), this._relWeight(npc, p1));
      if (rw > 1) w *= rw;
      if (this._likesStadium(npc)) w *= 2;
      w *= ARCH_W[npc.archetype] || 1;
      w *= 1 - Math.min(0.7, d / 150);
      // Can they be in their seat in time (the stands full)? Late walkers fade out fast
      const eta = this._eta(Math.max(0, d - SEAT_R), v);
      if (eta > budget) w *= Math.max(LATE_W_MIN, Math.pow(budget / eta, LATE_POW));
      if (this._recent(npc)) w *= 0.3;
      cands[n] = npc;
      W[n] = w;
      total += w;
      n++;
    }
    if (!n) return false;
    // Weighted pick; a candidate whose seat or route fails falls out and we pick again
    for (let attempt = 0; attempt < 3 && total > 0; attempt++) {
      let x = Math.random() * total, k = 0;
      for (; k < n - 1; k++) { x -= W[k]; if (x < 0 && W[k] > 0) break; }
      while (k > 0 && W[k] <= 0) k--;
      const npc = cands[k];
      const w = W[k];
      if (!(w > 0)) break;
      const vip = this._isVip(npc, p0, p1);
      const seat = this._pickSeat(npc, vip, budget, v);
      if (!seat) break;                               // stands full
      const r = this._freeRecord();
      if (!r) break;
      r.npc = npc;
      r.seat = seat;
      r.vip = vip;
      const a = Number.isFinite(seat.approach) ? seat.approach : 0.5;
      r.ax = seat.x + Math.sin(seat.yaw) * a;
      r.az = seat.z + Math.cos(seat.yaw) * a;
      if (this._goSeat(r)) {
        r.phase = 'in';
        r.t = 0;
        r.seatedT = 0;
        r.stay = rand(STAY_MIN, STAY_MAX);
        r.releaseAt = INF;
        r.reactAt = INF;
        this.stats.recruits++;
        if (this._recent(npc)) this.stats.recent++;
        for (let j = 0; j < n; j++) cands[j] = null;
        return true;
      }
      this._clearRecord(r);
      total -= w;
      W[k] = 0;
    }
    for (let j = 0; j < n; j++) cands[j] = null;
    return false;
  }

  _isCandidate(npc) {
    if (!npc || npc.away || !npc.body || !npc.mesh) return false;
    if (npc.archetype === 'staff' || npc.duty) return false;
    const st = npc.state;
    if (!(st === 'idle' || (st === 'wandering' && !npc._seatTarget))) return false;
    if (npc.hasRequest || npc.playing || npc.spectating || npc._holdSeat) return false;
    for (let i = 0; i < POOL; i++) if (this.records[i].npc === npc) return false;
    if (this._isInvolved(npc)) return false;
    const left = this._leftAt.get(npc);
    if (left !== undefined && this._t - left < COOL_OFF) return false;
    return !this._bookedSoon(npc.id);
  }

  /**
   * Cheapest free reserved stand seat: near the net, low rows, side stands, near the member's own
   * side of the bowl (0.02 / m), the box for VIPs; + the spread term (SPREAD_AISLE per spectator
   * already on that aisle, SPREAD_SIDE per spectator on that stand; half for VIPs, so relatives
   * keep the front rows) + LATE_COST per second the walk there (at `v` m/s) would run past `budget`.
   */
  _pickSeat(npc, vip, budget = FILL_S, v = HURRY_MAX) {
    const seats = this.stadium.spectatorSeats;
    const bp = npc.body.position;
    const occA = this._occA, occS = this._occS;
    occA.fill(0);
    occS.fill(0);
    for (let i = 0; i < POOL; i++) {
      const r = this.records[i];
      const info = r.seat && (r.phase === 'in' || r.phase === 'seated') ? r.seat.stadium : null;
      if (!info) continue;
      const a = this._aisleIdx.get(info.aisleId), si = SIDE_IDX[info.side];
      if (a !== undefined && occA[a] < 255) occA[a]++;
      if (si !== undefined && occS[si] < 255) occS[si]++;
    }
    const spread = vip ? SPREAD_VIP : 1;
    let best = null, bc = INF;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      if (s.taken) continue;
      const info = s.stadium;
      if (!info) continue;
      const end = info.side === 'n' || info.side === 's';
      const d = Math.hypot(s.x - bp.x, s.z - bp.z);
      const a = this._aisleIdx.get(info.aisleId), si = SIDE_IDX[info.side];
      const late = this._eta(d, v) - budget;
      const c = 0.15 * Math.abs(info.along) + 0.4 * info.row + (end ? 3 : 0) + (info.box && !vip ? 2 : 0) + 0.02 * d
        + spread * (SPREAD_AISLE * (a !== undefined ? occA[a] : 0) + SPREAD_SIDE * (si !== undefined ? occS[si] : 0))
        + (late > 0 ? LATE_COST * late : 0);
      if (c < bc) { bc = c; best = s; }
    }
    return best;
  }

  /**
   * Walk-in only: open the session at once (instead of WALKIN_GRACE after 'start') when the recruit
   * pool is far: fewer free members than the target could stroll to a seat within FILL_S −
   * WALKIN_GRACE (what waiting for the grace would leave them). Their walk then overlaps the
   * players' own. Decided on the first walk-in tick of a match and kept.
   */
  _openEarly(m) {
    if (this._early === null) {
      const L = this.layout, T = this._targetCount(m);
      let near = 0;
      for (let i = 0; i < this.npcs.length && near < T; i++) {
        const npc = this.npcs[i];
        if (!this._isCandidate(npc)) continue;
        const bp = npc.body.position;
        const d = Math.hypot(bp.x - L.cx, bp.z - L.cz);
        if (d <= RECRUIT_RADIUS && this._eta(Math.max(0, d - SEAT_R)) <= FILL_S - WALKIN_GRACE) near++;
      }
      this._early = near < T;
      if (this._early) this.stats.earlyOpens++;
    }
    return this._early;
  }

  /** Estimated walk-in time (s) over `d` m of straight line at `v` m/s: through the aisles, then sitting down. */
  _eta(d, v = this._walkSpeed) {
    return d * ROUTE_K / v + SIT_S;
  }

  /** The session is filling its stands: its first FILL_S s (recruits at burst pace, may hurry). */
  _filling() {
    return this.session.active && this._t - this._openT < FILL_S;
  }

  /**
   * Seconds a recruit may take to be seated: while filling, what is left of FILL_S since the
   * session opened (at least MIN_BUDGET); after that (replacements) the arrive timeout.
   */
  _fillBudget() {
    if (!this._filling()) return GAME.spectatorArriveTimeout ?? 90;
    return Math.max(MIN_BUDGET, FILL_S - (this._t - this._openT));
  }

  /** Walking speed a recruit's fit is judged at: HURRY_MAX while filling, else a stroll. */
  _recruitSpeed() {
    return this._filling() ? HURRY_MAX : this._walkSpeed;
  }

  /** Left the stands within RECENT director seconds (and so past the COOL_OFF). */
  _recent(npc) {
    const left = this._leftAt.get(npc);
    return left !== undefined && this._t - left < RECENT;
  }

  /**
   * Send r.npc to r.seat: through the aisles (Ground.planLevelRoute), or straight to the approach
   * point when already next to it (re-seated after a chat). False when the NPC can't go now.
   */
  _goSeat(r) {
    const npc = r.npc, bp = npc.body.position;
    let route = null, speed = 0;
    if (Math.hypot(bp.x - r.ax, bp.z - r.az) < APPROACH_NEAR) route = [{ x: r.ax, z: r.az }];
    else {
      try { route = planLevelRoute(bp.x, bp.z, r.ax, r.az, [], NAV_LEG); } catch (e) { route = null; }
      if (route && !route.length) route = null;
      // While the stands fill, a walk that would miss the minute at a stroll goes briskly
      if (route && this._filling()) {
        let len = 0, px = bp.x, pz = bp.z;
        for (let i = 0; i < route.length; i++) { len += Math.hypot(route[i].x - px, route[i].z - pz); px = route[i].x; pz = route[i].z; }
        const need = len / Math.max(1, this._fillBudget() - SIT_S);
        if (need > this._walkSpeed) speed = Math.min(HURRY_MAX, need * 1.05);
      }
    }
    let ok = false;
    try { ok = !!npc.goSpectate(r.seat, route, speed); } catch (e) { ok = false; }
    return ok;
  }

  /** Helped in: placed on the approach point (the ground model's height) and sat down. */
  _placeInSeat(r) {
    const npc = r.npc;
    if (r.seat.taken && r.seat.taken !== npc) return false;
    let ok = false;
    try {
      npc.placeAt(r.ax, r.az, r.seat.yaw, null);
      ok = !!npc.goSpectate(r.seat, [{ x: r.ax, z: r.az }]);
    } catch (e) { ok = false; }
    this.stats.placed++;
    r.t = 0;
    return ok;
  }

  // ───────────────────────────── release ─────────────────────────────

  /**
   * Schedule everyone still coming or seated to leave between `t0` and `t1` s from now (a
   * release already pending stays). byAisle: nearest to their aisle first; else random order.
   */
  _releaseSpread(t0, t1, byAisle) {
    const keys = this._keys;
    let n = 0;
    for (let i = 0; i < POOL; i++) {
      const r = this.records[i];
      keys[i] = -1;
      if ((r.phase !== 'in' && r.phase !== 'seated') || r.releaseAt !== INF) continue;
      const info = r.seat && r.seat.stadium;
      const at = info ? this._aisleAt.get(info.aisleId) : undefined;
      keys[i] = byAisle && info && at !== undefined ? Math.abs(info.along - at) + 0.1 * info.row : Math.random();
      n++;
    }
    if (!n) return;
    for (let i = 0; i < POOL; i++) {
      if (keys[i] < 0) continue;
      let rank = 0;
      for (let j = 0; j < POOL; j++) if (j !== i && keys[j] >= 0 && (keys[j] < keys[i] || (keys[j] === keys[i] && j < i))) rank++;
      const r = this.records[i];
      r.releaseAt = this._t + t0 + (n > 1 ? (t1 - t0) * rank / (n - 1) : 0) + (t1 > t0 ? Math.random() * 0.3 : 0);
      r.reactAt = INF;
    }
  }

  /**
   * Up the aisle to the nearest exit (Ground.planLevelRoute) and on to a spot on the rim beside
   * that aisle top (_exitSpot), then the record waits in 'out'.
   */
  _leave(r) {
    const npc = r.npc;
    const seated = r.phase === 'seated' && this._isSeated(r);
    const bp = npc.body.position;
    const sx = seated ? r.ax : bp.x, sz = seated ? r.az : bp.z;
    let route = null;
    if (inFootprint(bp.x, bp.z, 0)) {
      const e = nearestExit(sx, sz, this._exit);
      if (e) {
        try { route = planLevelRoute(sx, sz, e.x, e.z, [], NAV_LEG); } catch (err) { route = null; }
        if (!route || !route.length) route = [{ x: e.x, z: e.z }];
        this._exitSpot(e);
        route.push({ x: e.x, z: e.z });
      }
    } else {
      route = [{ x: bp.x, z: bp.z }];                 // never got in: stop where they are
    }
    try { npc.leaveSpectating(route); } catch (e) { /* the 'out' timeout covers it */ }
    r.reactAt = INF;
    r.lineKey = null;
    r.phase = 'out';
    r.t = 0;
    r.releaseAt = INF;
    this.stats.released++;
  }

  /**
   * Move aisle top `e` (nearestExit's result, outside the footprint) to where a leaver stops: along
   * the rim by that aisle's next EXIT_ALONG step and EXIT_OUT further out from the cut (see
   * EXIT_ALONG), so successive leavers stand apart and the aisle top stays clear. The side is the
   * footprint edge the aisle top lies beyond. Returns `e`.
   */
  _exitSpot(e) {
    const L = this.layout, fp = L && L.footprint;
    if (!fp) return e;
    let ai = 0;
    for (let i = 0; i < L.aisles.length; i++) {
      const t = L.aisles[i].top;
      if (t.x === e.x && t.z === e.z) { ai = this._aisleIdx.get(L.aisles[i].id) || 0; break; }
    }
    const seq = this._exitSeq;
    const along = EXIT_ALONG[seq[ai] % EXIT_ALONG.length];
    seq[ai] = (seq[ai] + 1) % EXIT_ALONG.length;
    // end stands: always away from the centre line (the other way's steps sit 0.75 m further out)
    const out = (Math.abs(along) + (along < 0 ? 0.75 : 0)) * (e.x < L.cx ? -1 : 1);
    if (e.x <= fp.x0) { e.x -= EXIT_OUT; e.z += along; }            // west stand (pw, wn, ws)
    else if (e.x >= fp.x1) { e.x += EXIT_OUT; e.z += along; }       // east
    else if (e.z >= fp.z1) { e.z += EXIT_OUT; e.x += out; }         // north end
    else if (e.z <= fp.z0) { e.z -= EXIT_OUT; e.x += out; }         // south end
    return e;
  }

  /** Playing or gone home: the record goes (NPC.startPlaying / setAway release the seat). */
  _dropIfGone(r) {
    const npc = r.npc;
    if (npc && !npc.away && !npc.playing && npc.state !== 'playing') return false;
    this.stats.dropped++;
    this._endRecord(r);
    return true;
  }

  _endRecord(r) {
    const npc = r.npc;
    if (npc) {
      // (a leaver still walking to its rim spot stays a ghost until it gets there: NPC.leavingStands)
      if (npc.ghost && !npc.spectating && !npc.leavingStands && typeof npc.setGhost === 'function' && npc.body && !inFootprint(npc.body.position.x, npc.body.position.z, 0)) {
        try { npc.setGhost(false); } catch (e) { /* NPC.update turns it off too */ }
      }
      this._leftAt.set(npc, this._t);
    }
    this._clearRecord(r);
  }

  _clearRecord(r) {
    r.npc = null; r.seat = null; r.phase = 'free'; r.t = 0; r.seatedT = 0; r.stay = 0;
    r.reactAt = INF; r.reactKind = null; r.emoji = null; r.lineKey = null; r.releaseAt = INF; r.vip = false;
  }

  _freeRecord() {
    for (let i = 0; i < POOL; i++) if (this.records[i].phase === 'free' && !this.records[i].npc) return this.records[i];
    return null;
  }

  // ───────────────────────────── reactions and sound ─────────────────────────────

  /** Due reactions (clap / cheer, maybe an emoji and a bubble); counts what is still pending. */
  _fireReactions() {
    const t = this._t;
    let pending = 0;
    for (let i = 0; i < POOL; i++) {
      const r = this.records[i];
      if (r.reactAt === INF) continue;
      if (r.reactAt > t) { pending++; continue; }
      r.reactAt = INF;
      if (r.phase !== 'seated' || !this._isSeated(r)) { r.lineKey = null; r.emoji = null; continue; }
      const npc = r.npc;
      try {
        npc.react(r.reactKind || CLAP);
        this.stats.reactions++;
        if (r.emoji) npc.showReaction(r.emoji, null);
        if (r.lineKey) {
          const line = this._line(npc, r.lineKey);
          if (line) { npc.say(line, 1.8); this.stats.lines++; }
        }
      } catch (e) { /* cosmetic */ }
      r.lineKey = null;
      r.emoji = null;
    }
    this._pendingReact = pending;
  }

  _playSound() {
    const s = this._snd, snd = this.sound;
    s.at = INF;
    if (!snd || !(s.vol >= 0.05)) return;
    try {
      if (typeof snd.playApplause === 'function') { snd.playApplause(s.applause, s.vol); this.stats.applause++; }
      if (typeof snd.playCrowdVoice === 'function') {
        if (s.ooh) snd.playCrowdVoice('ooh', 0.4, s.vol);
        if (s.aww) snd.playCrowdVoice('aww', 0.3, s.vol);
      }
    } catch (e) { /* cosmetic */ }
  }

  /** Distance attenuation from the camera to the court (clamp(1.2 − d / 60, 0, 1)). */
  _volume() {
    if (!CameraTracker.valid) return 0;
    const L = this.layout, c = CameraTracker.position;
    const d = Math.hypot(c.x - L.cx, c.y - (L.surfY + 0.85), c.z - L.cz);
    return Math.max(0, Math.min(1, 1.2 - d / 60));
  }

  _ownLines(npc, key) {
    const cs = npc && npc.data ? npc.data.courtside : null;
    const arr = cs && typeof cs === 'object' ? cs[key] : null;
    return Array.isArray(arr) && arr.length ? arr : null;
  }

  _line(npc, key) {
    const arr = this._ownLines(npc, key) || DEFAULT_LINES[key];
    if (!arr || !arr.length) return null;
    const v = arr[Math.floor(Math.random() * arr.length)];
    return typeof v === 'string' && v ? v : null;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  _matchSeen(m) {
    if (!m) return;
    if (m !== this._match) {
      this._match = m;
      this._startT = this._t;
      this._early = null;
      this._notLiveT = 0;
      this._recruitT = Math.min(this._recruitT, 0.5);
      const id = m.entry && typeof m.entry.id === 'string' ? m.entry.id : '';
      this._entryFx = /final|exh/i.test(id) ? 1.5 : 1;
      const c = m.frame && m.frame.court && m.frame.court.config;
      if (c && typeof c.label === 'string' && c.label) this._label = c.label;
    }
    if (this._announced !== m && this.announce && this.enabled) {
      this._announced = m;
      const a = m.players && m.players[0] && m.players[0].npc, b = m.players && m.players[1] && m.players[1].npc;
      if (a && b) {
        try { this.announce(`🏟️ ${this._label}: ${a.name || a.id} v ${b.name || b.id}`); } catch (e) { /* cosmetic */ }
      }
    }
  }

  _getMatch() {
    const ms = this.matches;
    if (!ms) return null;
    if (typeof ms.getMatch === 'function') return ms.getMatch(this.courtId) || null;
    const list = ms.matches;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) if (list[i] && list[i].frame && list[i].frame.id === this.courtId) return list[i];
    }
    return null;
  }

  _isLive(m) {
    const ms = this.matches;
    if (ms && typeof ms.isLive === 'function') return !!ms.isLive(this.courtId);
    return LIVE[m.phase] === 1;
  }

  _bookedSoon(id) {
    const ms = this.matches;
    if (!ms || typeof ms.isBookedSoon !== 'function') return false;
    try { return !!ms.isBookedSoon(id, 0.5); } catch (e) { return false; }
  }

  /** In an active mission (MissionSystem.collectInvolvedNpcIds), refreshed at most once per tick. */
  _isInvolved(npc) {
    if (!this._involvedFresh) {
      this._involvedFresh = true;
      this._involved.clear();
      const ms = this.missions;
      if (ms && typeof ms.collectInvolvedNpcIds === 'function') {
        try { ms.collectInvolvedNpcIds(this._involved); } catch (e) { /* keep going */ }
      }
    }
    return this._involved.has(npc.id);
  }

  _isSeated(r) {
    const npc = r.npc;
    return !!npc && npc.state === 'sitting' && npc._sitSeat === r.seat;
  }

  _raining() {
    const w = this._weatherName();
    return w === 'rainy' || w === 'stormy';
  }

  _weatherName() {
    const w = this.weather;
    if (!w) return 'sunny';
    return typeof w.getWeather === 'function' ? w.getWeather() : w.weather;
  }

  _eventCrowd() {
    // EventSystem.getCrowd(): today's factor clamped to 0.5..2.5 (1 when absent), so a hand edit can't overflow
    if (this.events && typeof this.events.getCrowd === 'function') return this.events.getCrowd();
    const e = this.events && this.events.today;
    const c = e ? Number(e.crowd) : NaN;
    return Number.isFinite(c) && c > 0 ? c : 1;
  }

  /** The camera is at least CAM_FAR from the NPC and from its seat's approach point (a jump there is unseen). */
  _cameraFar(npc, r) {
    if (!CameraTracker.valid) return true;
    const c = CameraTracker.position, p = npc.body.position;
    return Math.hypot(c.x - p.x, c.z - p.z) >= CAM_FAR && Math.hypot(c.x - r.ax, c.z - r.az) >= CAM_FAR;
  }

  /** npcs.json relationship type between a and b (a's own entry first), or null. */
  _relType(a, b) {
    if (!a || !b) return null;
    const ra = a.data && a.data.relationships, rb = b.data && b.data.relationships;
    const x = ra && ra[b.id], y = rb && rb[a.id];
    return (x && x.type) || (y && y.type) || null;
  }

  _relWeight(npc, player) {
    const t = this._relType(npc, player);
    return t ? (REL_W[t] || 1) : 1;
  }

  _isRelative(npc, player) {
    const t = this._relType(npc, player);
    return !!t && RELATIVE[t] === 1;
  }

  _isVip(npc, p0, p1) {
    if (VIP_ARCH[npc.archetype] === 1) return true;
    return this._isRelative(npc, p0) || this._isRelative(npc, p1);
  }

  _likesStadium(npc) {
    const pa = npc.data && npc.data.preferredAreas;
    if (!Array.isArray(pa)) return false;
    for (let i = 0; i < pa.length; i++) if (pa[i] === this.courtId || pa[i] === 'stadium') return true;
    return false;
  }
}
