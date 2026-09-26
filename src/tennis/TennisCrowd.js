import { SIZES } from '../utils/Constants.js';
import { findSeats } from '../entities/Seats.js';
import { CameraTracker } from '../entities/CharacterModel.js';
import { getClip } from '../entities/CharacterAnimations.js';

/**
 * TennisCrowd — after hours the members have gone home and a few staff stay to watch the
 * attendant play Coach Rafa, on whichever court the session uses (Court 1 hard, Court 2 grass,
 * Court 5 clay, or any other). Spots are planned per court from what is there (_planSpots): the
 * court's own benches on a side without a neighbouring court, standing room by that side's bench
 * line, and — on a side that touches another court (clay: map.json adjacentLeft / adjacentRight) —
 * the junction between the two courts at the net line, beside the cooler / bin. Every spot is
 * outside the doubles alleys (court-local |u| >= 8.5) and within |v| <= 5 of the net, so nobody
 * ever stands between the camera (behind a baseline) and the play. On Court 1: Jess and Gus on
 * the west benches, Hank on the east bench, Marcus standing at the east sideline. Rafa (the
 * opponent) is left alone; Dani and Otis stay at their posts.
 *
 * begin(session)          members away (NPC.setAway), every member match ended, the staff walk
 *                         in, sit / stand facing the court, wave and say hello
 * relocate(session)       the session moved to another court (TennisSession.setSurface, menu
 *                         only): the members stay away; the staff get up and come over — each is
 *                         put a few metres from their new spot (along the sideline, or across
 *                         the empty neighbouring court for a junction spot; the camera cuts to
 *                         the new court at the same moment) and walks the rest, then waves
 * update(session, dt)     heads follow the ball (or the player), staggered reactions, sounds
 * react(kind, who, info)  a moment in the play (the plans are in _fill). The staff are on the
 *                         player's side: cheers and applause for your winners, an "ooh" for a
 *                         long rally, polite claps or a gasp for Rafa's, now and then a word of
 *                         encouragement after your errors. Staggered 0.1–0.5 s, rate-limited
 * end(session)            staff back at their posts, members back at the club (away from the
 *                         court the session ended on)
 *
 * Wiring (TennisSession): `this.crowd = new TennisCrowd(game)` once; `crowd.begin(this)` at the
 * end of begin(); `crowd.relocate(this)` in setSurface() once the new frame, the players and the
 * camera are set; `crowd.update(this, dt)` in _tick after the NPC updates; `crowd.react(...)`
 * where points / games / drills resolve; `crowd.end(this)` in end() (before or after the player
 * is placed at the bench: both work).
 *
 * Lines come from npcs.json `courtside` pools (bubble lines <= 22 chars, validated), with the
 * DEFAULT_LINES below for staff without them. Sounds are SoundSystem.playApplause /
 * playCrowdVoice ('whoop' | 'ooh' | 'aww' | 'gasp'). Everything here is cosmetic: every public
 * method swallows its own errors, and update() allocates nothing.
 */

const SURF = SIZES.courtSurfaceY ?? 0.15;

/**
 * Who watches, in the court frame (u across the court, v along it; the net is v = 0), and where
 * they would like to be, in order of preference (_planSpots takes the first that the court has):
 *   'seat-' / 'seat+'   a seat on the court's own bench on the -u / +u side (the seat nearest v);
 *                       only sides without a neighbouring court have benches
 *   'stand-' / 'stand+' standing by that side's bench line (a side without a neighbouring court)
 *   'junction'          standing at the net line between this court and its neighbour, just on
 *                       the neighbour's side (clay courts; the spot nearest jv, else v)
 * If none is there, the first free standing / junction spot anywhere around the court.
 */
const LINEUP = [
  { id: 'jess_nakamura', v: -1.9, want: ['seat-', 'seat+', 'stand-', 'junction', 'stand+'] },
  { id: 'gus_papadakis', v: 1.9, jv: -1.9, want: ['seat-', 'junction', 'seat+', 'stand-', 'stand+'] },
  { id: 'hank_morris', v: -0.4, want: ['seat+', 'seat-', 'stand+', 'junction', 'stand-'] },
  { id: 'marcus_bell', v: 3.8, want: ['stand+', 'stand-', 'junction'] },
];
const MIN_U = 8.5;               // spots stay outside the doubles alley (+ ~3 m)
const MAX_V = 5;
const STAND_BACK = 0.3;          // standers: this far in front of their side's bench line
const JUNCTION_OUT = 0.7;        // junction spots: this far past the half-way line, on the neighbour's side
const JUNCTION_V = 1.95;         // ...either side of the net line (clear of the cooler and the bin)
const WALK_IN = 5;               // walk-in distance (m) from where a spectator appears
const WALK_IN_MAX_V = 11;        // ...never from past this (the back fences are at |v| 14.5)
const WALK_IN_ACROSS = 6;        // junction spots: walk in across the (empty) neighbouring court
const ARRIVE_TIMEOUT = 9;        // s; still walking by then → put them in place
const HOME_CLEAR = 14;           // members come back at least this far from the court centre

/** Standing spectators: only the weight shift (idle_look / idle_watch turn the head away). */
const WATCH_IDLE = ['idle_shift'];
/** Clips the spectators use (baked at begin() so the first cheer doesn't hitch). */
const CROWD_CLIPS = ['sit', 'sit_wave', 'sit_clap', 'sit_cheer', 'clap', 'wave', 'greet', 'react_happy'];

/** Fallback courtside lines (staff without a `courtside` block in npcs.json). */
const DEFAULT_LINES = {
  arrive: ['Evening!', 'Mind if I watch?'],
  winner: ['Great shot!', 'Yes!'],
  ace: ['What a serve!', 'Ace!'],
  rally: ['What a rally!', 'Ooh!'],
  rafa: ['Nice one, Rafa.', 'Wow.'],
  error: ['Shake it off!', 'Next one!'],
  game: ['Game! Nice!', 'Keep going!'],
  matchWin: ['You did it!', 'Bravo!'],
  matchLose: ['Good fight!', 'So close!'],
  drill: ['Nice!', 'Right on target!'],
  closeIn: ['On the line!', 'By a whisker!'],
  closeOut: ['Just out!', 'Ooh, so close!'],
};

const E = {
  clap: '👏', raise: '🙌', fire: '🔥', wow: '😮', party: '🎉',
  boom: '💥', ok: '👌', muscle: '💪', target: '🎯', grimace: '😬', phew: '😅',
};

/**
 * Event plans (filled by _plan). n: spectators who react (0 = all); act: the first one's body
 * language, act2: everyone else's ('cheer' | 'clap' | 'nod' | 'wave' | null); emoji (on up to
 * `emojis` of them); line: courtside pool, lineChance, speakers; applause / voice + voiceK: sound
 * levels 0..1 (0 = none); prio: a bigger moment replaces a smaller pending one; minor: small
 * stuff, rate-limited by a shared cooldown and `chance`.
 */
class Plan {
  reset() {
    this.n = 0; this.act = null; this.act2 = null; this.emoji = null; this.emojis = 1;
    this.line = null; this.lineChance = 1; this.speakers = 1;
    this.applause = 0; this.voice = null; this.voiceK = 0; this.voiceChance = 1;
    this.prio = 1; this.minor = false; this.chance = 1; this.encourage = false;
    return this;
  }
}

/** Crowd sounds, one pending slot each (SoundSystem: playApplause / playCrowdVoice(kind)). */
const SND = ['applause', 'whoop', 'ooh', 'aww', 'gasp'];
const SND_I = { applause: 0, whoop: 1, ooh: 2, aww: 3, gasp: 4 };

const rnd = Math.random;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class TennisCrowd {
  constructor(game) {
    this.game = game;
    this.active = false;
    /**
     * Staff watching: { npc, seat (null = standing), x, z, yaw (their spot), prevIdle, here (arrived),
     * walkT, greet, busyUntil / curPrio (clip playing), pT / pAct / pEmoji / pPrio (pending
     * reaction), lT / lKey (pending line), lastLine, lines (npcs.json courtside) }
     */
    this.spectators = [];
    /** Members sent home by begin() (brought back by end()). */
    this.awayNpcs = [];
    this.t = 0;
    this._plan = new Plan();
    this._order = [0, 1, 2, 3, 4, 5, 6, 7];
    this._minorCd = 0;
    this._encourageCd = 0;
    this._lineCd = 0;
    this._lastSpeaker = null;
    this._arrived = false;
    // Crowd sounds by SND index: pending time + level (same-type requests merge), cooldown, last level
    this._sndT = new Float64Array(SND.length).fill(Infinity);
    this._sndK = new Float32Array(SND.length);
    this._sndCd = new Float32Array(SND.length);
    this._sndLast = new Float32Array(SND.length);
  }

  // ─────────────────────────── lifecycle ───────────────────────────

  /**
   * The session has started: send the members home, end member matches, bring the staff out.
   * Call it right after TennisSession.begin() has set the court up (it is safe either way).
   */
  begin(session) {
    try { this._begin(session); } catch (err) { console.error('TennisCrowd.begin', err); }
  }

  _begin(session) {
    if (this.active) this._restore(session);
    const g = this.game;
    const f = session && session.frame;
    if (!f || !g || !Array.isArray(g.npcs)) return;
    this.active = true;
    this.t = 0;
    this._minorCd = 2;
    this._encourageCd = 8;
    this._lineCd = 0;
    this._lastSpeaker = null;
    this._arrived = false;
    this._sndT.fill(Infinity);
    const coach = session.coachNpc || null;

    // Every member match ends (not only Court 1's): the club is closing
    const ms = g.matches;
    if (ms && Array.isArray(ms.matches)) {
      const ours = coach && coach.playing && coach.playing.courtId === f.id ? coach.playing : null;
      for (const m of ms.matches.slice()) {
        // Rafa already belongs to the session: keep _finish from standing him down
        if (ours) coach.playing = null;
        try { ms._finish(m); } catch (e) { /* ignore */ }
        if (ours) coach.playing = ours;
      }
    }

    // A chat in progress with anyone but Rafa ends
    const ds = g.dialogueSystem;
    if (ds && ds.isActive && ds.isActive() && ds.currentNPC && ds.currentNPC !== coach) {
      try { ds.forceEnd(); } catch (e) { /* ignore */ }
    }

    // Members go home
    this.awayNpcs.length = 0;
    for (const npc of g.npcs) {
      if (!npc || npc === coach || npc.archetype === 'staff' || npc.away || typeof npc.setAway !== 'function') continue;
      try { npc.setAway(true); this.awayNpcs.push(npc); } catch (e) { console.error('TennisCrowd: setAway', npc.id, e); }
    }

    // Staff come to watch
    this.spectators.length = 0;
    const who = [];
    for (const L of LINEUP) {
      const npc = g.npcs.find(n => n && n.id === L.id);
      if (npc && npc !== coach && !npc.away) who.push(npc);
    }
    const spots = this._spotsFor(session, who);
    for (let i = 0; i < who.length; i++) {
      const npc = who[i], spot = spots[i];
      if (!spot) continue;
      try {
        const sp = {
          npc, seat: null, x: 0, z: 0, yaw: 0, prevIdle: npc.character.anim.idleVariants, here: false, walkT: 0,
          busyUntil: 0, curPrio: 0, pT: Infinity, pAct: null, pEmoji: null, pPrio: 0,
          lT: Infinity, lKey: null, lastLine: null, lines: this._linesFor(npc), greet: 0,
        };
        npc.setOverlaysHidden(true);
        npc.character.anim.idleVariants = WATCH_IDLE;
        this._place(session, sp, spot);
        this.spectators.push(sp);
      } catch (e) { console.error('TennisCrowd: spectator', npc.id, e); }
    }
    for (const c of CROWD_CLIPS) getClip(c);
    if (g.sound && g.sound.prewarmCrowd) g.sound.prewarmCrowd();
    this.react('arrive', 0);
  }

  /**
   * The session moved to another court (TennisSession.setSurface, from the menu, after the new
   * frame, the players and the camera are set): the members stay away, the staff come over to
   * the new court's spots (see the class notes) and wave once they are there.
   */
  relocate(session) {
    try { this._relocate(session); } catch (err) { console.error('TennisCrowd.relocate', err); }
  }

  _relocate(session) {
    if (!this.active) { this._begin(session); return; }
    const f = session && session.frame;
    if (!f) return;
    // Nothing pending from the old court: reactions, lines, sounds
    this._sndT.fill(Infinity);
    this._lineCd = 1.5;
    this._minorCd = Math.max(this._minorCd, 2);
    this._lastSpeaker = null;
    // Everyone stands up where they are first (frees the old seats before the plan)
    const who = [];
    for (const sp of this.spectators) {
      const p = sp.npc.body.position;
      sp.npc.character.lookAt(null);
      sp.npc.placeAt(p.x, p.z, null, this._groundY(p.x, p.z));
      who.push(sp.npc);
    }
    const spots = this._spotsFor(session, who);
    const keep = [];
    for (let i = 0; i < this.spectators.length; i++) {
      const sp = this.spectators[i], spot = spots[i];
      if (!spot) { this._sendHome(sp, f.cx, f.cz); continue; } // no room at this court
      sp.pT = Infinity; sp.pAct = null; sp.pEmoji = null; sp.pPrio = 0;
      sp.lT = Infinity; sp.lKey = null; sp.busyUntil = 0; sp.curPrio = 0;
      sp.greet = 1; // a wave once seated (no hello again)
      this._place(session, sp, spot);
      keep.push(sp);
    }
    this.spectators.length = 0;
    for (const sp of keep) this.spectators.push(sp);
  }

  /** _planSpots, or nobody (an empty plan: everyone stays home) if it fails. */
  _spotsFor(session, npcs) {
    try { return this._planSpots(session, npcs); } catch (e) { console.error('TennisCrowd: plan', e); return []; }
  }

  /**
   * Where each of `npcs` (in LINEUP order) watches on the session's court: [{ seat | null, u, v
   * (the spot; for a seat, the seat itself), au, av (where they stand / sit down from), fu, fv
   * (where they appear to walk in from) }] (null: no room). Seats: the court's own benches, found
   * by Seats.js (`court:<id>@…`), free (or a member's who went home, or Rafa's).
   */
  _planSpots(session, npcs) {
    const f = session.frame;
    const g = this.game;
    const cfg = (f.court && f.court.config) || {};
    const coach = session.coachNpc || null;
    const halfW = (SIZES.courtWidth || 16) / 2;
    const seats = findSeats(g.scene);
    const prefix = `court:${f.id}@`;
    const open = [!cfg.adjacentLeft, !cfg.adjacentRight]; // -u side, +u side

    // The court's seats (only where the sitter stays outside the play area)
    const seatList = [];
    const benchU = [Infinity, Infinity];
    for (const s of seats) {
      if (!s.id || !s.id.startsWith(prefix)) continue;
      const ax = s.x + Math.sin(s.yaw) * 0.5, az = s.z + Math.cos(s.yaw) * 0.5;
      const au = f.lu(ax, az), av = f.lv(ax, az), su = f.lu(s.x, s.z), sv = f.lv(s.x, s.z);
      if (Math.abs(au) < MIN_U || Math.abs(sv) > MAX_V) continue;
      const side = su < 0 ? 0 : 1;
      benchU[side] = Math.min(benchU[side], Math.abs(su));
      seatList.push({ seat: s, side, u: su, v: sv, au, av, used: false });
    }

    // Junction spots (between this court and a neighbour, at the net line): map.json
    // courtJunctions naming this court, else the half-way line on an adjacent side
    const junctions = [];
    const js = g.mapData && g.mapData.areas && Array.isArray(g.mapData.areas.courtJunctions) ? g.mapData.areas.courtJunctions : [];
    const jSide = [false, false];
    for (const j of js) {
      if (!j || !j.position || !Array.isArray(j.between) || !j.between.includes(f.id)) continue;
      const ju = f.lu(j.position.x, j.position.z), jv = f.lv(j.position.x, j.position.z);
      if (Math.abs(ju) < halfW - 1 || Math.abs(jv) > MAX_V) continue;
      const sgn = ju < 0 ? -1 : 1;
      jSide[sgn < 0 ? 0 : 1] = true;
      for (const dv of [-JUNCTION_V, JUNCTION_V]) junctions.push({ u: ju + sgn * JUNCTION_OUT, v: jv + dv, sgn, used: false });
    }
    for (let side = 0; side < 2; side++) {
      if (open[side] || jSide[side]) continue;
      const sgn = side ? 1 : -1;
      for (const dv of [-JUNCTION_V, JUNCTION_V]) junctions.push({ u: sgn * (halfW + JUNCTION_OUT), v: dv, sgn, used: false });
    }

    const standers = []; // spots handed out so far (standing): { u, v }
    const clampV = (v) => Math.max(-MAX_V, Math.min(MAX_V, v));
    // Walk in along the sideline from further toward that end (inside the back fences)
    const walkFrom = (v) => Math.max(-WALK_IN_MAX_V, Math.min(WALK_IN_MAX_V, v + (v < 0 ? -WALK_IN : WALK_IN)));
    const out = [];
    const trySeat = (npc, side, v) => {
      let best = null, bd = Infinity;
      for (const s of seatList) {
        if (s.used || s.side !== side) continue;
        const t = s.seat.taken;
        // Free, ours, a member's who went home, or Rafa's (he just stood up to play)
        if (t && t !== npc && !t.away && t !== coach) continue;
        const d = Math.abs(s.v - v);
        if (d < bd) { bd = d; best = s; }
      }
      if (!best) return null;
      best.used = true;
      if (best.seat.taken && best.seat.taken !== npc) best.seat.taken = null; // a member who has gone home
      return { seat: best.seat, u: best.u, v: best.v, au: best.au, av: best.av, fu: best.au, fv: walkFrom(best.av) };
    };
    const tryStand = (side, v) => {
      if (!open[side]) return null;
      const sgn = side ? 1 : -1;
      const u = sgn * (Number.isFinite(benchU[side]) ? Math.max(MIN_U + 0.1, benchU[side] - STAND_BACK) : MIN_U + 0.4);
      // Clear of this side's benches and of anyone else standing there: v, then further out, then in
      const free = (c) => !seatList.some(s => s.side === side && Math.abs(s.v - c) < 1.3)
        && !standers.some(o => Math.abs(o.u - u) < 1 && Math.abs(o.v - c) < 1.2);
      const v0 = clampV(v), d = v0 < 0 ? -1 : 1;
      let sv = null;
      for (let k = 0; k <= 16 && sv === null; k++) {
        const c = k <= 8 ? v0 + d * k * 0.6 : v0 - d * (k - 8) * 0.6;
        if (Math.abs(c) <= MAX_V && free(c)) sv = c;
      }
      if (sv === null) return null;
      standers.push({ u, v: sv });
      return { seat: null, u, v: sv, au: u, av: sv, fu: u, fv: walkFrom(sv) };
    };
    const tryJunction = (v) => {
      let best = null, bd = Infinity;
      for (const j of junctions) {
        if (j.used) continue;
        const d = Math.abs(j.v - v);
        if (d < bd) { bd = d; best = j; }
      }
      if (!best) return null;
      best.used = true;
      standers.push({ u: best.u, v: best.v });
      return { seat: null, u: best.u, v: best.v, au: best.u, av: best.v, fu: best.u + best.sgn * WALK_IN_ACROSS, fv: best.v };
    };

    for (const npc of npcs) {
      const L = LINEUP.find(l => l.id === npc.id) || { v: 0, want: ['stand+', 'stand-', 'junction'] };
      let spot = null;
      for (const w of L.want) {
        if (w === 'seat-') spot = trySeat(npc, 0, L.v);
        else if (w === 'seat+') spot = trySeat(npc, 1, L.v);
        else if (w === 'stand-') spot = tryStand(0, L.v);
        else if (w === 'stand+') spot = tryStand(1, L.v);
        else if (w === 'junction') spot = tryJunction(Number.isFinite(L.jv) ? L.jv : L.v);
        if (spot) break;
      }
      if (!spot) spot = tryStand(1, L.v) || tryStand(0, L.v) || tryJunction(L.v);
      out.push(spot);
    }
    return out;
  }

  /** Put a spectator a few metres out from their spot and let them walk in (facing the way they walk). */
  _place(session, sp, spot) {
    const f = session.frame, npc = sp.npc;
    const seat = spot.seat;
    sp.seat = seat;
    sp.x = seat ? seat.x : f.wx(spot.u, spot.v);
    sp.z = seat ? seat.z : f.wz(spot.u, spot.v);
    sp.yaw = seat ? seat.yaw : Math.atan2(f.cx - sp.x, f.cz - sp.z);
    sp.here = false;
    sp.walkT = 0;
    const fx = f.wx(spot.fu, spot.fv), fz = f.wz(spot.fu, spot.fv);
    const tx = f.wx(spot.au, spot.av), tz = f.wz(spot.au, spot.av);
    npc.placeAt(fx, fz, Math.atan2(tx - fx, tz - fz), this._groundY(fx, fz));
    this._walkIn(sp);
  }

  _walkIn(sp) {
    const npc = sp.npc;
    if (sp.seat) npc.shelter(sp.seat, null);
    else npc.shelter(null, { x: sp.x, z: sp.z, precise: true, face: sp.yaw });
  }

  /** Arrived (sitting on the seat / standing at the spot)? */
  _isHere(sp) {
    const npc = sp.npc;
    if (sp.seat) return npc.state === 'sitting' && npc._sitSeat === sp.seat;
    if (npc.state !== 'idle') return false;
    const dx = npc.body.position.x - sp.x, dz = npc.body.position.z - sp.z;
    return dx * dx + dz * dz < 0.5;
  }

  /** Put a late spectator in place (they got stuck on the way). */
  _snapInPlace(sp) {
    const npc = sp.npc;
    if (sp.seat) {
      const ax = sp.seat.x + Math.sin(sp.seat.yaw) * 0.5, az = sp.seat.z + Math.cos(sp.seat.yaw) * 0.5;
      npc.placeAt(ax, az, sp.seat.yaw, this._groundY(ax, az));
    } else {
      npc.placeAt(sp.x, sp.z, sp.yaw, this._groundY(sp.x, sp.z));
    }
    this._walkIn(sp);
  }

  /** The session is over: staff back to work, members back at the club. */
  end(session) {
    try { this._restore(session); } catch (err) { console.error('TennisCrowd.end', err); }
  }

  _restore(session) {
    if (!this.active) return;
    this.active = false;
    const f = session && session.frame;
    const cx = f ? f.cx : 0, cz = f ? f.cz : 0;
    for (const sp of this.spectators) this._sendHome(sp, cx, cz);
    this.spectators.length = 0;
    for (const npc of this.awayNpcs) {
      try { npc.setAway(false, this._homeSpot(npc, cx, cz, 0.5)); } catch (e) { console.error('TennisCrowd: return', npc && npc.id, e); }
    }
    this.awayNpcs.length = 0;
    this._sndT.fill(Infinity);
  }

  /** A spectator back to work: their duty post, else a preferred spot away from the court. */
  _sendHome(sp, cx, cz) {
    const npc = sp.npc;
    try {
      npc.character.lookAt(null);
      npc.character.anim.idleVariants = sp.prevIdle || npc.character.anim.idleVariants;
      npc.setOverlaysHidden(false);
      // (placeAt frees the bench the player is put beside)
      const p = npc.duty ? npc.duty.post : this._homeSpot(npc, cx, cz);
      if (p) {
        npc.placeAt(p.x, p.z, Number.isFinite(p.face) ? p.face : null, 0);
        npc.wanderTimer = 1 + rnd() * 3;
      } else {
        npc.releaseShelter();
      }
    } catch (e) { console.error('TennisCrowd: restore', npc && npc.id, e); }
  }

  /** A preferred waypoint of theirs, clear of the court (as if arriving at the club). */
  _homeSpot(npc, cx, cz, jitter = 0) {
    const wps = npc.waypoints || {};
    const player = this.game.player && this.game.player.body ? this.game.player.body.position : null;
    let p = null;
    for (let i = 0; i < 6 && !p; i++) {
      const w = npc._getPreferredWaypoint ? npc._getPreferredWaypoint() : null;
      if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.z)) continue;
      if (Math.hypot(w.x - cx, w.z - cz) < HOME_CLEAR) continue;
      if (player && Math.hypot(w.x - player.x, w.z - player.z) < 6) continue;
      p = w;
    }
    if (!p) p = wps.entrance || wps.parking || null;
    if (!p) return null;
    if (!jitter) return p;
    return { x: p.x + (rnd() * 2 - 1) * jitter, y: p.y || 0, z: p.z + (rnd() * 2 - 1) * jitter };
  }

  // ─────────────────────────── per frame ───────────────────────────

  /** Heads follow the ball; pending reactions and sounds fire. Allocation-free. */
  update(session, dt) {
    if (!this.active) return;
    try { this._update(session, dt); } catch (err) { console.error('TennisCrowd.update', err); }
  }

  _update(session, dt) {
    this.t += dt;
    const t = this.t;
    if (this._minorCd > 0) this._minorCd -= dt;
    if (this._encourageCd > 0) this._encourageCd -= dt;
    if (this._lineCd > 0) this._lineCd -= dt;
    for (let i = 0; i < SND.length; i++) if (this._sndCd[i] > 0) this._sndCd[i] -= dt;

    const ball = session && session.ball;
    const pm = session && session.game && session.game.player ? session.game.player.mesh : null;
    const look = ball && ball.shown ? ball.pos : (pm ? pm.position : null);

    for (let i = 0; i < this.spectators.length; i++) {
      const sp = this.spectators[i];
      const npc = sp.npc;
      if (!sp.here) {
        sp.walkT += dt;
        if (this._isHere(sp)) { sp.here = true; if (sp.greet) this._greet(sp); }
        else if (sp.walkT > ARRIVE_TIMEOUT) { this._snapInPlace(sp); sp.walkT = 0; }
      } else if (!npc._holdSeat) {
        this._walkIn(sp); // something released them: back to the spot
        sp.here = false;
      }
      if (look) npc.character.lookAt(look);

      if (t >= sp.pT) this._fire(sp);
      if (t >= sp.lT) {
        sp.lT = Infinity;
        this._speak(sp, sp.lKey);
      }
    }

    for (let i = 0; i < SND.length; i++) {
      if (t >= this._sndT[i]) { this._sndT[i] = Infinity; this._playSound(i, this._sndK[i]); }
    }
  }

  // ─────────────────────────── reactions ───────────────────────────

  /**
   * A moment in the play.
   * @param {string} kind 'arrive' | 'winner' | 'ace' | 'smash' | 'drop' | 'perfect' | 'powerShot' |
   *   'error' | 'doubleFault' | 'longRally' | 'game' | 'set' | 'match' | 'drillTarget' | 'drillDone' |
   *   'closeIn' | 'closeOut' (a first bounce within a few cm of a line, in / out: a small murmur —
   *   a gasp and a clap for your line-clipper, a groan when yours just misses, a relieved little
   *   cheer when Rafa's does; minor, so rate-limited like the other small moments)
   * @param {number} who 0 = the player, 1 = Rafa: who hit it / erred / served; for 'game' /
   *   'set' / 'match' the winner; for 'longRally' the point winner
   * @param {object} [info] optional: { stars } for 'drillDone', { shots } for 'longRally'
   */
  react(kind, who = 0, info = null) {
    if (!this.active || !this.spectators.length) return;
    try { this._react(kind, who === 1 ? 1 : 0, info); } catch (err) { console.error('TennisCrowd.react', kind, err); }
  }

  _react(kind, who, info) {
    if (kind === 'arrive') { this._arrive(); return; }
    const P = this._plan.reset();
    if (!this._fill(P, kind, who, info)) return;
    if (P.minor) {
      if (this._minorCd > 0 || rnd() > P.chance) return;
      this._minorCd = 6 + rnd() * 5;
    } else if (rnd() > P.chance) return;

    // Who reacts: a random few (or all), cascading 0.1–0.5 s after the moment
    const count = this.spectators.length;
    const order = this._order;
    for (let i = 0; i < count; i++) order[i] = i;
    for (let i = count - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = order[i]; order[i] = order[j]; order[j] = tmp; }
    const n = P.n <= 0 ? count : Math.min(count, P.n);
    const wantLine = P.line && rnd() < P.lineChance && (this._lineCd <= 0 || P.prio >= 4) && (!P.encourage || this._encourageCd <= 0);
    let speakers = wantLine ? P.speakers : 0;
    for (let i = 0; i < n; i++) {
      const sp = this.spectators[order[i]];
      const delay = 0.1 + (n > 1 ? (i / (n - 1)) * 0.3 : 0) + rnd() * 0.1;
      this._queue(sp, delay, i === 0 ? P.act : P.act2, i < P.emojis ? P.emoji : null, P.prio);
      if (speakers > 0 && sp !== this._lastSpeaker) {
        sp.lT = this.t + delay + 0.15 + (P.speakers - speakers) * 0.9;
        sp.lKey = P.line;
        this._lastSpeaker = sp;
        speakers--;
      }
    }
    if (speakers > 0 && speakers === P.speakers) {
      // Everyone who reacted spoke last time: let the first one talk anyway
      const sp = this.spectators[order[0]];
      sp.lT = this.t + 0.3; sp.lKey = P.line; this._lastSpeaker = sp;
    }
    if (wantLine) {
      this._lineCd = 4;
      if (P.encourage) this._encourageCd = 20 + rnd() * 10;
    }
    if (P.voice && P.voiceK > 0 && rnd() < P.voiceChance) this._queueSound(P.voice, P.voiceK, 0.06 + rnd() * 0.08);
    if (P.applause > 0) this._queueSound('applause', P.applause, 0.22 + rnd() * 0.1);
  }

  /** Fill the plan for an event; false = nobody reacts. */
  _fill(P, kind, who, info) {
    const you = who === 0;
    switch (kind) {
      case 'ace':
        if (you) { P.act = P.act2 = 'cheer'; P.emoji = E.fire; P.emojis = 2; P.line = 'ace'; P.lineChance = 0.7; P.applause = 0.8; P.voice = 'whoop'; P.voiceK = 0.8; P.prio = 4; }
        else { P.n = 1; P.emoji = E.wow; P.line = 'rafa'; P.lineChance = 0.35; P.applause = 0.2; P.voice = 'gasp'; P.voiceK = 0.35; P.prio = 2; P.minor = true; P.chance = 0.85; }
        return true;
      case 'smash':
      case 'winner':
      case 'drop':
        if (you) {
          const smash = kind === 'smash', drop = kind === 'drop';
          P.n = smash ? 0 : 2;
          P.act = drop ? 'clap' : 'cheer'; P.act2 = smash ? 'cheer' : 'clap';
          P.emoji = smash ? E.boom : drop ? E.wow : E.clap; P.emojis = smash ? 2 : 1;
          P.line = 'winner'; P.lineChance = smash ? 0.6 : drop ? 0.4 : 0.35;
          P.applause = smash ? 0.75 : drop ? 0.45 : 0.55;
          P.voice = drop ? 'ooh' : 'whoop'; P.voiceK = smash ? 0.7 : 0.45; P.voiceChance = smash || drop ? 1 : 0.6;
          P.prio = smash ? 4 : 3;
        } else {
          P.n = 1; P.act = rnd() < 0.5 ? 'clap' : null; P.emoji = E.wow;
          P.line = 'rafa'; P.lineChance = 0.3;
          P.applause = P.act ? 0.18 : 0; P.voice = kind === 'smash' ? 'ooh' : 'gasp'; P.voiceK = 0.35; P.voiceChance = 0.6;
          P.prio = 2; P.minor = true; P.chance = 0.8;
        }
        return true;
      case 'closeIn':
        // On the line: a gasp; a small clap when it is yours
        P.n = 1; P.act = you ? 'clap' : null; P.emoji = E.wow;
        P.line = 'closeIn'; P.lineChance = you ? 0.3 : 0.15;
        P.voice = you ? 'ooh' : 'gasp'; P.voiceK = you ? 0.35 : 0.25; P.applause = you ? 0.15 : 0;
        P.prio = 1; P.minor = true; P.chance = you ? 0.75 : 0.55;
        return true;
      case 'closeOut':
        // Just out: a groan for yours, a relieved little cheer for Rafa's
        P.n = 1; P.act = you ? null : 'cheer'; P.emoji = you ? E.grimace : E.phew;
        P.line = 'closeOut'; P.lineChance = you ? 0.3 : 0.2;
        P.voice = you ? 'aww' : 'whoop'; P.voiceK = you ? 0.3 : 0.2; P.voiceChance = you ? 0.8 : 0.5;
        P.prio = 1; P.minor = true; P.chance = you ? 0.75 : 0.55;
        return true;
      case 'perfect':
        if (!you) return false;
        P.n = 1; P.act = 'nod'; P.emoji = E.ok; P.prio = 1; P.minor = true; P.chance = 0.3;
        return true;
      case 'powerShot':
        P.n = 1; P.emoji = you ? E.muscle : E.wow; P.voice = 'ooh'; P.voiceK = you ? 0.35 : 0.25;
        P.prio = 1; P.minor = true; P.chance = you ? 0.35 : 0.2;
        return true;
      case 'longRally': {
        const shots = info && Number.isFinite(info.shots) ? info.shots : 10;
        const k = clamp01((shots - 8) / 12);
        P.act = P.act2 = 'clap'; P.emoji = E.clap; P.emojis = 2;
        P.line = 'rally'; P.lineChance = 0.5;
        P.voice = 'ooh'; P.voiceK = 0.45 + 0.35 * k; P.applause = 0.45 + 0.25 * k + (you ? 0.1 : 0);
        P.prio = 3;
        return true;
      }
      case 'error':
      case 'doubleFault':
        if (!you) return false; // no cheering the opponent's mistakes
        P.n = 1; P.line = 'error'; P.lineChance = kind === 'doubleFault' ? 0.5 : 0.35; P.encourage = true;
        P.voice = 'aww'; P.voiceK = kind === 'doubleFault' ? 0.35 : 0.3; P.voiceChance = 0.5;
        P.prio = 1; P.minor = true; P.chance = 0.8;
        return true;
      case 'game':
        if (you) { P.n = 3; P.act = 'cheer'; P.act2 = 'clap'; P.emoji = E.raise; P.line = 'game'; P.lineChance = 0.6; P.applause = 0.6; P.voice = 'whoop'; P.voiceK = 0.45; P.voiceChance = 0.5; P.prio = 4; }
        else { P.n = 1; P.act = 'clap'; P.applause = 0.15; P.prio = 2; P.chance = 0.5; }
        return true;
      case 'set':
        if (you) { P.act = P.act2 = 'cheer'; P.emoji = E.raise; P.emojis = 2; P.line = 'game'; P.applause = 0.85; P.voice = 'whoop'; P.voiceK = 0.8; P.prio = 5; }
        else { P.n = 2; P.act = P.act2 = 'clap'; P.line = 'error'; P.lineChance = 0.5; P.applause = 0.3; P.prio = 3; }
        return true;
      case 'match':
        if (you) { P.act = P.act2 = 'cheer'; P.emoji = E.party; P.emojis = 4; P.line = 'matchWin'; P.speakers = 2; P.applause = 1; P.voice = 'whoop'; P.voiceK = 1; P.prio = 6; }
        else { P.act = P.act2 = 'clap'; P.line = 'matchLose'; P.speakers = 2; P.applause = 0.45; P.voice = 'aww'; P.voiceK = 0.25; P.voiceChance = 0.5; P.prio = 6; }
        return true;
      case 'drillTarget':
        if (!you) return false;
        P.n = 1; P.act = 'clap'; P.emoji = E.target; P.line = 'drill'; P.lineChance = 0.25; P.applause = 0.2;
        P.prio = 1; P.minor = true; P.chance = 0.35;
        return true;
      case 'drillDone': {
        const stars = info && Number.isFinite(info.stars) ? info.stars : 1;
        if (stars >= 3) { P.act = P.act2 = 'cheer'; P.emoji = E.party; P.emojis = 2; P.line = 'drill'; P.applause = 0.8; P.voice = 'whoop'; P.voiceK = 0.6; }
        else if (stars >= 2) { P.act = P.act2 = 'clap'; P.emoji = E.clap; P.line = 'drill'; P.applause = 0.55; }
        else { P.n = 2; P.act = P.act2 = 'clap'; P.line = 'error'; P.applause = 0.3; }
        P.prio = 5;
        return true;
      }
      default:
        return false;
    }
  }

  /** Arrival: each waves once they are in place (seated / at the sideline); two say hello. */
  _arrive() {
    if (this._arrived) return;
    this._arrived = true;
    let said = 0;
    for (let i = 0; i < this.spectators.length; i++) {
      const sp = this.spectators[i];
      sp.greet = 1;
      if (said < 2 && (i === 0 || rnd() < 0.6)) { sp.greet = 2; said++; }
    }
  }

  /** Just arrived: wave toward the court (and maybe say hello). */
  _greet(sp) {
    const delay = 0.35 + rnd() * 0.3;
    this._queue(sp, delay, 'wave', null, 1);
    if (sp.greet === 2 && this._lineCd <= 0) {
      sp.lT = this.t + delay + 0.2;
      sp.lKey = 'arrive';
      this._lineCd = 1.2;
    }
    sp.greet = 0;
  }

  /** Queue a spectator's reaction (a bigger pending one wins). */
  _queue(sp, delay, act, emoji, prio) {
    if (sp.pT !== Infinity && sp.pPrio > prio) return;
    sp.pT = this.t + delay;
    sp.pAct = act;
    sp.pEmoji = emoji;
    sp.pPrio = prio;
  }

  _fire(sp) {
    const npc = sp.npc;
    const act = sp.pAct, emoji = sp.pEmoji, prio = sp.pPrio;
    sp.pT = Infinity; sp.pAct = null; sp.pEmoji = null; sp.pPrio = 0;
    // Mid-clip with something at least as big: let it play out
    if (this.t < sp.busyUntil && prio <= sp.curPrio) return;
    const seated = npc.state === 'sitting';
    let clip = null;
    if (act === 'cheer') clip = 'react_happy';          // seated: sit_cheer (NPC.react)
    else if (act === 'clap') clip = 'clap';             // seated: sit_clap
    else if (act === 'nod') clip = seated ? null : 'greet';
    else if (act === 'wave') clip = 'wave';             // seated: sit_wave
    try {
      if (emoji) npc.showReaction(emoji, null);
      if (clip) {
        const d = npc.react(clip);
        sp.busyUntil = this.t + (d || 1.5);
        sp.curPrio = prio;
      }
    } catch (e) { /* cosmetic */ }
  }

  _linesFor(npc) {
    const cs = npc.data && npc.data.courtside;
    return cs && typeof cs === 'object' && !Array.isArray(cs) ? cs : null;
  }

  _speak(sp, key) {
    if (!key) return;
    let arr = sp.lines && Array.isArray(sp.lines[key]) && sp.lines[key].length ? sp.lines[key] : DEFAULT_LINES[key];
    if (!arr || !arr.length) return;
    let i = Math.floor(rnd() * arr.length);
    if (arr.length > 1 && arr[i] === sp.lastLine) i = (i + 1) % arr.length;
    const text = String(arr[i]);
    sp.lastLine = text;
    try { sp.npc.say(text, 2.2); } catch (e) { /* cosmetic */ }
  }

  // ─────────────────────────── sound ───────────────────────────

  /** Ask for a crowd sound `delay` s from now (a pending one of the same type takes the larger level). */
  _queueSound(type, k, delay) {
    const i = SND_I[type];
    if (i === undefined) return;
    const at = this.t + delay;
    if (this._sndT[i] !== Infinity) { this._sndK[i] = Math.max(this._sndK[i], k); this._sndT[i] = Math.min(this._sndT[i], at); return; }
    // Just played one: only a clearly bigger moment plays again so soon
    if (this._sndCd[i] > 0 && k < this._sndLast[i] + 0.25) return;
    this._sndT[i] = at;
    this._sndK[i] = k;
  }

  _playSound(i, k) {
    const snd = this.game.sound;
    this._sndLast[i] = k;
    this._sndCd[i] = i === 0 ? 1.2 : 1;
    if (!snd) return;
    try {
      if (i === 0) { if (snd.playApplause) snd.playApplause(k, this._volume()); }
      else if (snd.playCrowdVoice) snd.playCrowdVoice(SND[i], k, this._volume());
    } catch (e) { /* audio is optional */ }
  }

  /** Mild distance attenuation: camera → the middle of the spectators. */
  _volume() {
    if (!CameraTracker.valid || !this.spectators.length) return 0.85;
    let x = 0, z = 0;
    for (const sp of this.spectators) { x += sp.x; z += sp.z; }
    x /= this.spectators.length; z /= this.spectators.length;
    const c = CameraTracker.position;
    const d = Math.sqrt((c.x - x) ** 2 + c.y * c.y + (c.z - z) ** 2);
    return Math.max(0.45, Math.min(1, 1.2 - d / 60));
  }

  // ─────────────────────────── helpers ───────────────────────────

  /** Ground height at (x, z): the top of a court pad, else the lawn. */
  _groundY(x, z) {
    const courts = (this.game.world && this.game.world.courts) || [];
    for (const c of courts) {
      const b = c.slabBounds;
      if (b && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return SURF;
    }
    return 0;
  }
}
