import { SIZES } from '../utils/Constants.js';
import { findSeats } from '../entities/Seats.js';
import { CameraTracker } from '../entities/CharacterModel.js';
import { getClip } from '../entities/CharacterAnimations.js';

/**
 * TennisCrowd — after hours the members have gone home and a few staff stay to watch the
 * attendant play Coach Rafa on Court 1: two on the west benches, Hank on the east bench and
 * Marcus standing at the east sideline, all outside the doubles alleys (court-local |u| >= 8.5,
 * |v| <= 5) so they never stand between the camera and the play. Rafa (the opponent) is left
 * alone; Dani and Otis stay at their posts.
 *
 * begin(session)          members away (NPC.setAway), every member match ended, the staff walk
 *                         in, sit / stand facing the court, wave and say hello
 * update(session, dt)     heads follow the ball (or the player), staggered reactions, sounds
 * react(kind, who, info)  a moment in the play (the plans are in _fill). The staff are on the
 *                         player's side: cheers and applause for your winners, an "ooh" for a
 *                         long rally, polite claps or a gasp for Rafa's, now and then a word of
 *                         encouragement after your errors. Staggered 0.1–0.5 s, rate-limited
 * end(session)            staff back at their posts, members back at the club
 *
 * Wiring (TennisSession): `this.crowd = new TennisCrowd(game)` once; `crowd.begin(this)` at the
 * end of begin(); `crowd.update(this, dt)` in _tick after the NPC updates; `crowd.react(...)`
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
 * Who watches and where, in the court frame (u across the court, v along it; the net is v = 0).
 * seat: sit on the court bench seat nearest (u, v) (standing at |u| = 8.9 if it is missing);
 * from: where they walk in from (outside the play area, clear of the umpire chair and benches).
 */
const LINEUP = [
  { id: 'jess_nakamura', u: -9.2, v: -1.9, seat: true, from: [-14.5, -1.9] },
  { id: 'gus_papadakis', u: -9.2, v: 1.9, seat: true, from: [-14.5, 1.9] },
  { id: 'hank_morris', u: 9.2, v: -0.4, seat: true, from: [8.7, -6.5] },
  { id: 'marcus_bell', u: 8.9, v: 3.8, seat: false, from: [8.9, 9] },
];
const MIN_U = 8.5;               // spots stay outside the doubles alley (+ ~3 m)
const MAX_V = 5;
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
};

const E = {
  clap: '👏', raise: '🙌', fire: '🔥', wow: '😮', party: '🎉',
  boom: '💥', ok: '👌', muscle: '💪', target: '🎯',
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
    const seats = findSeats(g.scene);
    for (const L of LINEUP) {
      const npc = g.npcs.find(n => n && n.id === L.id);
      if (!npc || npc === coach || npc.away) continue;
      try { this._seatSpectator(session, npc, L, seats); } catch (e) { console.error('TennisCrowd: spectator', L.id, e); }
    }
    for (const c of CROWD_CLIPS) getClip(c);
    if (g.sound && g.sound.prewarmCrowd) g.sound.prewarmCrowd();
    this.react('arrive', 0);
  }

  _seatSpectator(session, npc, L, seats) {
    const f = session.frame;
    let seat = null;
    if (L.seat) {
      const prefix = `court:${f.id}@`;
      let best = 0.5;
      for (const s of seats) {
        if (!s.id || !s.id.startsWith(prefix) || (s.taken && s.taken !== npc && !s.taken.away)) continue;
        const d = Math.hypot(f.lu(s.x, s.z) - L.u, f.lv(s.x, s.z) - L.v);
        if (d < best) { best = d; seat = s; }
      }
      // Only if the seat (and where the sitter stands) is outside the play area
      if (seat) {
        // (NPC.shelter walks the sitter to 0.5 m in front of the seat, then sits)
        const ax = seat.x + Math.sin(seat.yaw) * 0.5, az = seat.z + Math.cos(seat.yaw) * 0.5;
        if (Math.abs(f.lu(ax, az)) < MIN_U || Math.abs(f.lv(seat.x, seat.z)) > MAX_V) seat = null;
        else if (seat.taken && seat.taken !== npc) seat.taken = null; // a member who has gone home
      }
    }
    const su = seat ? f.lu(seat.x, seat.z) : Math.sign(L.u || 1) * Math.max(MIN_U + 0.4, Math.abs(L.u));
    const sv = seat ? f.lv(seat.x, seat.z) : Math.max(-MAX_V, Math.min(MAX_V, L.v));
    const x = f.wx(su, sv), z = f.wz(su, sv);
    const yaw = seat ? seat.yaw : Math.atan2(f.cx - x, f.cz - z);

    const sp = {
      npc, seat, x, z, yaw, prevIdle: npc.character.anim.idleVariants, here: false, walkT: 0,
      busyUntil: 0, curPrio: 0, pT: Infinity, pAct: null, pEmoji: null, pPrio: 0,
      lT: Infinity, lKey: null, lastLine: null, lines: this._linesFor(npc), greet: 0,
    };
    // Start a few metres out and walk in (arrival), facing the way they walk
    const fx = f.wx(L.from[0], L.from[1]), fz = f.wz(L.from[0], L.from[1]);
    const tx = seat ? seat.x + Math.sin(seat.yaw) * 0.5 : x, tz = seat ? seat.z + Math.cos(seat.yaw) * 0.5 : z;
    npc.placeAt(fx, fz, Math.atan2(tx - fx, tz - fz), this._groundY(fx, fz));
    npc.setOverlaysHidden(true);
    npc.character.anim.idleVariants = WATCH_IDLE;
    this._walkIn(sp);
    this.spectators.push(sp);
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
    const g = this.game;
    const f = session && session.frame;
    const cx = f ? f.cx : 0, cz = f ? f.cz : 0;
    for (const sp of this.spectators) {
      const npc = sp.npc;
      try {
        npc.character.lookAt(null);
        npc.character.anim.idleVariants = sp.prevIdle || npc.character.anim.idleVariants;
        npc.setOverlaysHidden(false);
        // Home: the duty post (Gus, Marcus), else a preferred spot away from the court. placeAt
        // frees the bench the player is put beside.
        const p = npc.duty ? npc.duty.post : this._homeSpot(npc, cx, cz);
        if (p) {
          npc.placeAt(p.x, p.z, Number.isFinite(p.face) ? p.face : null, 0);
          npc.wanderTimer = 1 + rnd() * 3;
        } else {
          npc.releaseShelter();
        }
      } catch (e) { console.error('TennisCrowd: restore', npc && npc.id, e); }
    }
    this.spectators.length = 0;
    for (const npc of this.awayNpcs) {
      try { npc.setAway(false, this._homeSpot(npc, cx, cz, 0.5)); } catch (e) { console.error('TennisCrowd: return', npc && npc.id, e); }
    }
    this.awayNpcs.length = 0;
    this._sndT.fill(Infinity);
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
   *   'error' | 'doubleFault' | 'longRally' | 'game' | 'set' | 'match' | 'drillTarget' | 'drillDone'
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
