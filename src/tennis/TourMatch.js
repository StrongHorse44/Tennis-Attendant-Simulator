import { NPC } from '../entities/NPC.js';
import { SKIN_TONES, HAIR_COLORS, hashString } from '../entities/CharacterModel.js';
import { findSeats, claimSeat, releaseSeat } from '../entities/Seats.js';
import { groundAt } from '../world/Ground.js';
import { SIZES } from '../utils/Constants.js';
import { tourOpponentDifficulty } from '../systems/TourDifficulty.js';

/**
 * TourMatch — a Junior Tour match in the after-hours tennis session (TennisSession.beginTour).
 * The session plays the match exactly as it plays Coach Rafa; this is everything around it:
 *
 *   where       spec.home: the club's own court (spec.courtId, Centre Court); else the venue
 *               (game.venues.enter(spec.venueId): a real Court at x 1800, far from the club)
 *   who         a club member in the draw (spec.opponent.npcId: Theo, Lily, Nate) walks on as
 *               themselves; everyone else is played by one visiting NPC, built once, hidden
 *               between matches (NPC.setAway) and re-dressed per opponent from
 *               spec.opponent.look (seeded, so a player looks the same every time you meet).
 *               TennisAI plays them with tourOpponentDifficulty(opponent, surface)
 *   the coach   Rafa sits courtside — the venue's coach seat, or a front-row seat in Centre
 *               Court's west stand — with his body out of the physics world; he still gives his
 *               tips (TennisCoach), plus the game plan before the match and changeover talk
 *   the chair   umpire calls in the HUD pill ("Thirty–fifteen", "Game, Okafor", "Advantage to you",
 *               "Okafor leads 3 games to 2")
 *   the crowd   the venue's (or Centre Court's) crowd impostors cheer; applause / cheers / "ooh"
 *               from SoundSystem, louder with a fuller house and bigger points
 *   the light   floodlit venues (and home) play into the night like the club; the others start
 *               earlier and the clock stops before sunset (lights: false)
 *   the result  tour.onMatchResult → TourUI's tournament card, then the session ends
 *
 * Session wiring (TennisSession): `this.tour` is the TourMatch while a tour match runs (null
 * otherwise) and `this.oppNpc` the NPC across the net (Rafa outside the tour). prepare(spec)
 * resolves the court and the opponent (false: nothing changed); begin() after the players are
 * placed; update(dt, playerPos) every tick; call() / pointEnd() / gameEnd() / board() from the
 * scoring code; report() / showResult() / askRetire() at the end; teardown() in end().
 * Everything cosmetic swallows its own errors.
 */

const VISITOR_ID = 'tour_visitor';
const NO_LIGHTS_START = 15.25;   // a venue without floodlights: an earlier start…
const NO_LIGHTS_END = 19.1;      // …and the clock stops before sunset (WeatherSystem SUNSET 19.3)
const COACH_V = 3.4;             // home: Rafa's seat, this far into the player's starting half
const INTRO_DELAY = 0.7;         // s of session time before the game-plan card (the venue renders first)

const HAIR_F = ['ponytail', 'ponytail', 'bun', 'bob', 'long'];
const HAIR_M = ['short', 'swept', 'short', 'swept', 'short'];
const HAIR_YOUNG = ['black', 'brown', 'chestnut', 'blonde', 'auburn', 'black', 'brown'];
const HATS = [null, null, null, 'cap', 'capBack', 'visor', 'headband'];
const RACKETS = [0x2B2B2B, 0xC0392B, 0x2E86C1, 0xF1C40F, 0xECF0F1, 0x16A085, 0x8E44AD, 0xE67E22];
const DARK_BOTTOMS = [0x2F3440, 0x1F2A44, 0x3B3F46, 0x243B2F];
const WORD = ['love', 'fifteen', 'thirty', 'forty'];
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];

/** Small seeded generator (mulberry32). */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hexNum = (h, def) => {
  if (typeof h === 'number' && Number.isFinite(h)) return h;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''));
  return m ? parseInt(m[1], 16) : def;
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * A tour player's look (CharacterModel style keys + scale / build), deterministic from
 * opponent.look.seed (else the id): gender from look.gender / gender ('x' = either), the shirt
 * from look.shirtColor, height from age (13-year-olds are small; adults full size).
 */
export function opponentStyle(o = {}) {
  const look = o.look || {};
  const seed = Number.isFinite(look.seed) ? look.seed : Math.floor(hashString(String(o.id || o.name || 'tour')) * 1e9);
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length) % a.length];
  const gender = look.gender || o.gender;
  const female = gender === 'f' ? true : gender === 'm' ? false : r() < 0.5;
  const shirt = hexNum(look.shirtColor, 0x2E86C1);
  const adult = !!o.adult;
  const age = Number.isFinite(o.age) ? o.age : 16;
  const scale = adult ? 0.9 + r() * 0.06 : clamp(0.79 + (age - 13) * 0.022 + r() * 0.03, 0.78, 0.93);
  const hairKey = adult && r() < 0.15 ? 'grey' : pick(HAIR_YOUNG);
  return {
    female,
    skin: pick(SKIN_TONES),
    hair: pick(female ? HAIR_F : HAIR_M),
    hairColor: HAIR_COLORS[hairKey] ?? HAIR_COLORS.brown,
    hat: pick(HATS),
    hatColor: r() < 0.6 ? 0xF4F2EC : shirt,
    bottom: female ? (r() < 0.6 ? 'skirt' : 'shorts') : 'shorts',
    bottomColor: r() < 0.55 ? 0xF2EFE8 : pick(DARK_BOTTOMS),
    brows: pick(['stern', 'soft', 'stern']),
    mouth: pick(['flat', 'smile', 'flat', 'grin']),
    blush: !adult && r() < 0.4,
    racket: pick(RACKETS),
    polo: r() < 0.45,
    wristband: r() < 0.5 ? shirt : 0xF4F2EC,
    shoes: 0xF2F1EC,
    shoeAccent: shirt,
    socks: 0xF4F2EC,
    shirt,
    scale,
    build: 0.95 + r() * 0.1,
  };
}

/** The opponent's surname (what the umpire calls them): the last word of the name. */
export function surnameOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'Opponent';
}

/**
 * The umpire's score call before the next point (TennisScore state, the server's view):
 * "Fifteen–love", "Thirty all", "Deuce", "Advantage Okafor" / "Advantage to you"; in a tiebreak
 * "3–2 Okafor" / "3–2 to you" / "3 all". '' before the first point of a game.
 */
export function umpirePointCall(sc, oppName) {
  if (!sc || sc.done) return '';
  if (sc.tiebreak) {
    const a = sc.pts[0], b = sc.pts[1];
    if (a === 0 && b === 0) return '';
    if (a === b) return `${a} all`;
    return a > b ? `${a}–${b} to you` : `${b}–${a} ${oppName}`;
  }
  const s = sc.currentServer;
  const a = sc.pts[s], b = sc.pts[1 - s];
  if (a === 0 && b === 0) return '';
  if (a >= 3 && b >= 3) {
    if (a === b) return 'Deuce';
    const lead = a > b ? s : 1 - s;
    return lead === 0 ? 'Advantage to you' : `Advantage ${oppName}`;
  }
  if (a === b) return `${cap(WORD[a])} all`;
  return `${cap(WORD[a])}–${WORD[b]}`;
}

/**
 * The umpire's call when a point completed a game / set / match (TennisScore event `ev`, the score
 * after it): "Game, Okafor. Okafor leads 3 games to 2." / "Game and first set to you." /
 * "Game, set and match, Okafor." '' when nothing completed.
 */
export function umpireGameCall(ev, sc, oppName) {
  if (!ev || !sc) return '';
  if (ev.match) return sc.winner === 0 ? 'Game, set and match to you.' : `Game, set and match, ${oppName}.`;
  if (ev.set) {
    const k = Math.max(0, sc.sets.length - 1);
    const ord = ORDINAL[k] || `${k + 1}th`;
    const sw = sc.setsWon;
    const hi = Math.max(sw[0], sw[1]), lo = Math.min(sw[0], sw[1]);
    const lead = `${hi} set${hi === 1 ? '' : 's'} to ${lo}`;
    const tail = sc.setsToWin > 1 ? (sw[0] === sw[1] ? ` ${sw[0]} set${sw[0] === 1 ? '' : 's'} all.` : sw[0] > sw[1] ? ` You lead ${lead}.` : ` ${oppName} leads ${lead}.`) : '';
    return (ev.setWinner === 0 ? `Game and ${ord} set to you.` : `Game and ${ord} set, ${oppName}.`) + tail;
  }
  if (ev.game) {
    const g = sc.games;
    const head = ev.gameWinner === 0 ? 'Game to you.' : `Game, ${oppName}.`;
    if (ev.tiebreak) return `${head} ${g[0]} games all. Tiebreak.`;
    if (g[0] === g[1]) return `${head} ${g[0]} game${g[0] === 1 ? '' : 's'} all.`;
    const lead = g[0] > g[1] ? 0 : 1, hi = Math.max(g[0], g[1]), lo = Math.min(g[0], g[1]);
    return `${head} ${lead === 0 ? 'You lead' : `${oppName} leads`} ${hi} game${hi === 1 ? '' : 's'} to ${lo}.`;
  }
  return '';
}

/** Opponent chatter: rare, short (NPC bubble ≤ ~22 chars). */
const OPP_LINES = {
  bigPoint: ['Come on!', 'Yes!', 'Let’s go!', 'Come on, focus!'],
  niceShot: ['Too good.', 'Nice shot.', 'Great ball.'],
  netCord: ['Sorry!', 'Sorry about that.'],
  lostGame: ['Come on…', 'Wake up!', 'Focus.'],
  win: ['Good match.', 'Well played.', 'Thanks, good match.'],
  lose: ['Well played.', 'Too good today.', 'Good luck next round.'],
};
const pickLine = (a) => a[Math.floor(Math.random() * a.length)];

export class TourMatch {
  constructor(session) {
    this.s = session;
    this.game = session.game;
    this.active = false;
    this.spec = null;
    this.court = null;
    this.info = null;           // the venue's info (Venues.enter), null at home
    this.home = false;
    this.lights = true;
    this.dayStart = 16.75;
    this.dayEnd = 21;
    this.oppNpc = null;
    this.clubOpp = false;       // the opponent is a club member (g.npcs), not the visitor
    this.visitor = null;        // the one visiting NPC (lazy)
    this.oppName = 'Opponent';  // umpire / pops: the surname
    this.oppShort = 'Opponent'; // scoreboard row: "K. Okafor"
    this.oppBoard = 'OPPONENT'; // stadium / venue scoreboard
    this.result = null;         // tour.onMatchResult's answer once reported
    this.reported = false;
    this.t = 0;
    this._introAt = Infinity;
    this._onStart = null;
    this._coachSeat = null;
    this._coachBody = false;    // Rafa's body was taken out of the physics world (restored in teardown)
    this._saved = null;         // the club side: player spot, camera yaw
    this._oppCd = 0;            // opponent chatter cooldown (s)
    this._coachCd = 0;          // Rafa's courtside reactions cooldown (s)
    this._crowdK = 0.5;
  }

  // ─────────────────────────── set-up ───────────────────────────

  /**
   * Resolve the court and the opponent for `spec` (TourSystem matchSpec). On success the venue
   * is shown (away) and this.court / this.oppNpc are set; on failure nothing is left changed.
   */
  prepare(spec) {
    if (!spec || typeof spec !== 'object' || !spec.opponent) return false;
    const g = this.game;
    this.spec = spec;
    this.result = null;
    this.reported = false;
    this.home = !!(spec.home || spec.courtId);
    let court = null, info = null;
    if (this.home) {
      const courts = (g.world && g.world.courts) || [];
      court = courts.find(c => c.id === (spec.courtId || 'court6')) || null;
    } else {
      const vs = g.venues;
      if (vs && typeof vs.enter === 'function') {
        try { info = vs.enter(spec.venueId); } catch (e) { console.error('TourMatch: venue', e); info = null; }
      }
      court = info && info.court ? info.court : null;
    }
    if (!court) { this._exitVenue(); this.spec = null; return false; }
    this.court = court;
    this.info = info;
    // Light: home and floodlit venues play into the night; the others keep the daylight
    let lights = true;
    if (!this.home) {
      try {
        const def = g.venues && typeof g.venues.get === 'function' ? g.venues.get(spec.venueId) : null;
        lights = info && typeof info.lights === 'boolean' ? info.lights : !!(def && def.look && def.look.lights);
      } catch (e) { lights = true; }
    }
    this.lights = lights;
    this.dayStart = lights ? 16.75 : NO_LIGHTS_START;
    this.dayEnd = lights ? 21 : NO_LIGHTS_END;

    // The opponent
    const o = spec.opponent;
    let npc = null;
    this.clubOpp = false;
    if (o.npcId) {
      npc = (g.npcs || []).find(n => n && n.id === o.npcId) || null;
      if (npc) this.clubOpp = true;
    }
    if (!npc) {
      npc = this._visitorFor(o);
      if (npc) {
        try { npc.setAway(false, { x: court.config?.center?.x ?? 0, z: court.config?.center?.z ?? 0, y: court.surfaceY ?? 0.15 }); } catch (e) { console.error('TourMatch: visitor', e); npc = null; }
      }
    } else if (npc.away) {
      try { npc.setAway(false); } catch (e) { /* placed by the session */ }
    }
    if (!npc) { this._exitVenue(); this.spec = null; this.court = null; this.info = null; return false; }
    this.oppNpc = npc;
    this.oppName = surnameOf(o.name);
    this.oppShort = String(o.short || o.name || this.oppName);
    this.oppBoard = this.oppShort.toUpperCase().slice(0, 14);
    return true;
  }

  /** The AI's table for this opponent on this surface (TourDifficulty), or null. */
  difficulty() {
    const sp = this.spec;
    if (!sp) return null;
    try { return tourOpponentDifficulty(sp.opponent, sp.surface || 'hard'); } catch (e) { console.error('TourMatch: difficulty', e); return null; }
  }

  _visitorFor(o) {
    const g = this.game;
    const style = opponentStyle(o);
    let npc = this.visitor;
    if (!npc) {
      try {
        const def = {
          id: VISITOR_ID, name: String(o.name || 'Visitor'), archetype: o.age && o.age < 13 ? 'junior' : 'competitive',
          shirtColor: '#' + style.shirt.toString(16).padStart(6, '0'), preferredAreas: [], greetings: [], dialoguePool: [],
          style,
        };
        npc = new NPC(g.scene, g.physicsWorld, def, (g.mapData && g.mapData.waypoints) || {});
        npc.tourVisitor = true;
        npc.setAway(true);
        this.visitor = npc;
      } catch (e) {
        console.error('TourMatch: could not build the visiting player', e);
        this.visitor = null;
        return null;
      }
    }
    this._dress(npc, o, style);
    return npc;
  }

  /** Re-dress the visitor as `o` (cached geometry swap; the root scale carries height / build). */
  _dress(npc, o, style) {
    const patch = { ...style };
    delete patch.scale; delete patch.build;
    try { npc.character.restyle(patch); } catch (e) { console.warn('TourMatch: restyle', e); }
    npc.style = { ...npc.style, ...style };
    npc.shirtColor = style.shirt;
    const s = style.scale, bw = clamp(style.build, 0.85, 1.15);
    npc.character.root.scale.set(s * bw, s, s * bw);
    npc.modelScale = s;
    npc.name = String(o.name || 'Visitor');
    if (npc.data) npc.data.name = npc.name;
  }

  /**
   * Called by the session once the frame, the players and the camera are set: Rafa courtside,
   * overlays off, names, the crowd, the umpire. `onStart` runs when the game-plan card is closed.
   */
  begin(onStart) {
    const sp = this.spec, g = this.game, s = this.s;
    if (!sp) return;
    this.active = true;
    this.t = 0;
    this._oppCd = 4;
    this._coachCd = 3;
    this._onStart = onStart || null;
    this._introAt = INTRO_DELAY;
    const opp = this.oppNpc;
    try { opp.setOverlaysHidden(true); } catch (e) { /* cosmetic */ }
    this._seatCoach();
    // The crowd: the venue's impostors, or Centre Court's (a home crowd, a little fuller)
    this._crowdK = clamp(Number(sp.crowd) || 0.5, 0.15, 1);
    try {
      if (this.info && g.venues) g.venues.setCrowd(this._crowdK, true);
      else if (g.world && g.world.stadium && s.frame && s.frame.court && s.frame.court.isStadium) g.world.stadium.setCrowd(this._crowdK, true);
    } catch (e) { /* cosmetic */ }
    try { if (g.sound && g.sound.prewarmCrowd) g.sound.prewarmCrowd(); } catch (e) { /* cosmetic */ }
    const hud = s.hud;
    if (hud) {
      hud.setNames(['You', this.oppShort]);
      hud.setInfo(this.infoLine());
      if (hud.setTourButton) hud.setTourButton(false);
    }
    this.board(null);
  }

  /** "Harbor Point Open · Quarterfinal · Stadium Court" */
  infoLine() {
    const sp = this.spec || {};
    return [sp.tournamentName, sp.roundName, sp.courtLabel].filter(Boolean).join(' · ');
  }

  /** Rafa sits courtside: the venue's coach seat, or a front-row seat in Centre Court's west stand. */
  _seatCoach() {
    const s = this.s, g = this.game, rafa = s.coachNpc;
    if (!rafa) return;
    let seat = null;
    const cs = this.info && this.info.coachSpot;
    if (cs && Number.isFinite(cs.x) && Number.isFinite(cs.z)) {
      seat = { id: 'tour:coach', x: cs.x, y: Number.isFinite(cs.y) ? cs.y : 0.46, z: cs.z, yaw: Number.isFinite(cs.yaw) ? cs.yaw : 0, taken: null, reserved: true, approach: 0.45 };
    } else if (this.home && s.frame) {
      seat = this._homeCoachSeat(s.frame, rafa);
    }
    try {
      if (rafa.state === 'talking') rafa.stopTalking();
      if (rafa.playing) rafa.stopPlaying();
      if (seat) {
        const ap = seat.approach ?? 0.45;
        const ax = seat.x + Math.sin(seat.yaw) * ap, az = seat.z + Math.cos(seat.yaw) * ap;
        const floor = this.home ? groundAt(ax, az) : Math.max(0, seat.y - 0.46);
        rafa.placeAt(ax, az, seat.yaw, floor);
        claimSeat(seat, rafa, true);
        rafa._sitDown(seat);
        rafa._holdSeat = true;
        this._coachSeat = seat;
      } else if (s.frame) {
        // Nowhere to sit: standing beside the player's bench line
        const f = s.frame, x = f.wx(-9.2, 3.2), z = f.wz(-9.2, 3.2);
        rafa.placeAt(x, z, Math.atan2(f.cx - x, f.cz - z), s.frame.y0 + (SIZES.courtSurfaceY ?? 0.15));
        rafa._holdFace = Math.atan2(f.cx - x, f.cz - z);
      }
      // A seated decoration for the match: out of the physics world (the stands can't shove him)
      if (rafa.body.world) { g.physicsWorld.removeBody(rafa.body); this._coachBody = true; }
      rafa.setOverlaysHidden(true);
      rafa.character.setRacketVisible(false);
      rafa.character.setBallVisible(false);
      rafa.fullRateAnim = false;
    } catch (e) { console.error('TourMatch: coach seat', e); }
  }

  _homeCoachSeat(f, rafa) {
    const seats = findSeats(this.game.scene);
    const prefix = `court:${f.id}@stand:`;
    let best = null, bd = Infinity;
    for (const seat of seats) {
      if (!seat.id || !seat.id.startsWith(prefix) || !seat.stadium) continue;
      const t = seat.taken;
      if (t && t !== rafa && !t.away) continue;
      if (f.lu(seat.x, seat.z) > 0) continue;              // the −u (west) stand: the Players' Walk side
      const d = Math.abs(f.lv(seat.x, seat.z) - COACH_V) + 0.9 * (seat.stadium.row || 0);
      if (d < bd) { bd = d; best = seat; }
    }
    return best;
  }

  // ─────────────────────────── per tick ───────────────────────────

  update(dt, playerPos) {
    if (!this.active) return;
    this.t += dt;
    this._oppCd -= dt;
    this._coachCd -= dt;
    // The visitor is not in game.npcs: the session's NPC loop doesn't reach it
    const v = this.visitor;
    if (v && v === this.oppNpc && !v.away) {
      try { v.update(dt, playerPos); } catch (e) { /* cosmetic */ }
    }
    if (this.t >= this._introAt) {
      this._introAt = Infinity;
      this._intro();
    }
  }

  /** The game-plan card (TourUI), else Rafa says it and the match starts a moment later. */
  _intro() {
    const s = this.s, sp = this.spec, g = this.game;
    let plan = null;
    try { plan = s.coach && s.coach.preMatchPlan ? s.coach.preMatchPlan(sp.opponent, sp) : null; } catch (e) { plan = null; }
    if (!Array.isArray(plan) || !plan.length) plan = ['Play your game: deep, patient, first serves in.', 'Make every point a long one early on.'];
    const go = () => { const f = this._onStart; this._onStart = null; if (f) { try { f(); } catch (e) { console.error('TourMatch: start', e); } } };
    const ui = g.tourUI;
    if (ui && typeof ui.showMatchIntro === 'function') {
      let h2h = null, scouting = null;
      try {
        const hub = g.tour && g.tour.getHub ? g.tour.getHub() : null;
        h2h = hub && hub.me && hub.me.h2h ? hub.me.h2h[sp.opponent.id] || null : null;
        scouting = hub && hub.scouting ? hub.scouting : null;
      } catch (e) { h2h = null; scouting = null; }
      try {
        ui.showMatchIntro({ ...sp, plan, h2h, scouting, lights: this.lights }, go);
        return;
      } catch (e) { console.warn('TourMatch: intro card', e); }
    }
    // No card: Rafa's first line on the HUD, then play
    try { s._say(plan[0], 3.2); } catch (e) { /* cosmetic */ }
    this._introAt = Infinity;
    setTimeout(go, 1200);
  }

  // ─────────────────────────── calls and reactions ───────────────────────────

  /** The umpire's pill (HUD) — falsy text hides it. */
  call(text, sec) {
    try { if (this.s.hud && this.s.hud.umpire) this.s.hud.umpire(text, sec); } catch (e) { /* cosmetic */ }
  }

  /** The umpire's score call before the next point. */
  pointCall() {
    const txt = umpirePointCall(this.s.score, this.oppName);
    if (txt) this.call(txt);
  }

  /** The first point of the match: "Okafor to serve. Play." */
  openingCall() {
    const sc = this.s.score;
    if (!sc) return;
    this.call(sc.currentServer === 0 ? 'You to serve. Play.' : `${this.oppName} to serve. Play.`, 2.2);
  }

  /**
   * A point is over (after the session's own bookkeeping): the crowd, Rafa courtside and the
   * opponent react. winner / hitter: 0 you, 1 the opponent; why: 'winner' | 'ace' | 'out' | 'net'
   * | 'double' | …; rally: shots in the point; big: a break / set / match point was on.
   */
  pointEnd(winner, why, hitter, rally = 0, big = false) {
    try { this._pointEnd(winner, why, hitter, rally, big); } catch (e) { /* cosmetic */ }
  }

  _pointEnd(winner, why, hitter, rally, big) {
    const g = this.game, snd = g.sound;
    const k = this._crowdK;
    let strength = 0.35, applause = 0.4;
    if (why === 'winner' || why === 'ace') { strength = 0.75; applause = 0.7; }
    else if (why === 'double') { strength = 0.2; applause = 0.15; }
    if (rally >= 9) { strength += 0.25; applause += 0.2; }
    if (big) { strength += 0.25; applause += 0.25; }
    strength = clamp(strength, 0, 1);
    this._cheer(strength);
    const vol = 0.3 + 0.7 * k;
    if (snd) {
      if (rally >= 9 && snd.playCrowdVoice) snd.playCrowdVoice('ooh', clamp(0.4 + 0.05 * rally, 0, 1), vol * 0.8);
      if (why === 'double' && snd.playCrowdVoice) snd.playCrowdVoice('aww', 0.4, vol * 0.7);
      else if (snd.playApplause) snd.playApplause(clamp(applause, 0, 1), vol);
      if (winner === 0 && (why === 'winner' || why === 'ace' || big) && snd.playCheer) snd.playCheer(clamp(strength, 0, 1), vol * (this.home ? 1 : 0.7));
    }
    // Rafa: claps your winners, a fist pump on the big ones
    const rafa = this.s.coachNpc;
    if (rafa && this._coachCd <= 0 && winner === 0 && (why === 'winner' || why === 'ace' || big)) {
      this._coachCd = 2.5;
      try { rafa.react(big ? 'react_happy' : 'clap'); } catch (e) { /* cosmetic */ }
    }
    // The opponent: now and then a word
    const opp = this.oppNpc;
    if (opp && this._oppCd <= 0) {
      let line = null;
      if (winner === 1 && big && Math.random() < 0.55) line = pickLine(OPP_LINES.bigPoint);
      else if (winner === 0 && (why === 'winner' || why === 'ace') && rally >= 6 && Math.random() < 0.18) line = pickLine(OPP_LINES.niceShot);
      if (line) { this._oppCd = 9; try { opp.say(line, 1.8); } catch (e) { /* cosmetic */ } }
    }
  }

  /** A net cord the opponent won: the customary apology. */
  netCord(hitter) {
    if (hitter !== 1 || this._oppCd > 0 || Math.random() > 0.6) return;
    this._oppCd = 6;
    try { this.oppNpc.say(pickLine(OPP_LINES.netCord), 1.6); } catch (e) { /* cosmetic */ }
  }

  /**
   * A game / set was completed (not the match): the umpire's call, a bigger cheer. Returns Rafa's
   * changeover line (TennisCoach.changeover) when the players change ends or a set ended, else null.
   */
  gameEnd(ev, sc) {
    let line = null;
    try {
      this.call(umpireGameCall(ev, sc, this.oppName), 2.6);
      this._cheer(ev.set ? 0.9 : 0.55);
      const snd = this.game.sound;
      if (snd && snd.playApplause) snd.playApplause(ev.set ? 0.85 : 0.5, 0.3 + 0.7 * this._crowdK);
      if (ev.gameWinner === 0 && ev.set && snd && snd.playCheer) snd.playCheer(0.8, 0.3 + 0.7 * this._crowdK);
      const opp = this.oppNpc;
      if (ev.gameWinner === 0 && opp && this._oppCd <= 0 && Math.random() < 0.25) { this._oppCd = 10; opp.say(pickLine(OPP_LINES.lostGame), 1.6); }
      if ((ev.changeEnds || ev.set) && this.s.coach && this.s.coach.changeover) line = this.s.coach.changeover(ev, sc);
    } catch (e) { line = null; }
    return line || null;
  }

  /** The match is over: the umpire, the crowd, the handshake words. */
  matchEnd(won) {
    try {
      const sc = this.s.score;
      this.call(umpireGameCall({ match: true }, sc, this.oppName), 3.2);
      this._cheer(1);
      const snd = this.game.sound;
      const vol = 0.3 + 0.7 * this._crowdK;
      if (snd && snd.playApplause) snd.playApplause(1, vol);
      if (won && snd && snd.playCheer) snd.playCheer(1, vol);
      const opp = this.oppNpc;
      if (opp) { opp.say(pickLine(won ? OPP_LINES.lose : OPP_LINES.win), 2.4); opp.swing('greet', { fade: 0.2 }); }
      const rafa = this.s.coachNpc;
      if (rafa) rafa.react(won ? 'react_happy' : 'clap');
    } catch (e) { /* cosmetic */ }
  }

  _cheer(strength) {
    const g = this.game;
    try {
      if (this.info && g.venues) g.venues.cheer(strength);
      else if (this.home && g.world && g.world.stadium && g.world.stadium.cheer) g.world.stadium.cheer(strength);
    } catch (e) { /* cosmetic */ }
  }

  /**
   * The venue's / Centre Court's scoreboards: { games, points, server, sets } (names filled in
   * here), or null for the match card (names, no score yet). Returns true when handled.
   */
  board(o) {
    const g = this.game;
    const sc = o ? { ...o, names: ['YOU', this.oppBoard] } : { names: ['YOU', this.oppBoard], games: [0, 0], points: ['', ''], server: 0, sets: [0, 0] };
    try {
      if (this.info && g.venues) { g.venues.setScoreOverride(sc); return true; }
      const st = g.world && g.world.stadium;
      const f = this.s.frame;
      if (this.home && st && typeof st.setScoreOverride === 'function' && f && f.court && f.court.isStadium) { st.setScoreOverride(sc); return true; }
    } catch (e) { /* cosmetic */ }
    return false;
  }

  _clearBoard() {
    const g = this.game;
    try { if (g.venues) g.venues.setScoreOverride(null); } catch (e) { /* cosmetic */ }
    try { if (this.home && g.world && g.world.stadium && g.world.stadium.setScoreOverride) g.world.stadium.setScoreOverride(null); } catch (e) { /* cosmetic */ }
  }

  // ─────────────────────────── the result ───────────────────────────

  /**
   * Tell the tour (once): won, retired (you quit from the menu: a loss, "ret."), the set line
   * from your side. Returns tour.onMatchResult's answer (null if the tour refused it).
   */
  report(won, retired = false, stats = null) {
    if (this.reported) return this.result;
    this.reported = true;
    const sp = this.spec, g = this.game, sc = this.s.score;
    let score = sc ? sc.setLine(0) : '';
    if (!score && retired) score = '0–0';
    let res = null;
    try {
      res = g.tour && typeof g.tour.onMatchResult === 'function'
        ? g.tour.onMatchResult({ tournamentId: sp.tournamentId, round: sp.round, won: !!won, score, retired: !!retired, stats })
        : null;
    } catch (e) { console.error('TourMatch: result', e); res = null; }
    this.result = res;
    try { g.saveGame(); } catch (e) { /* ignore */ }
    return res;
  }

  /** The tournament card (TourUI) for the reported result, then `done` (the session ends). */
  showResult(done) {
    const g = this.game, ui = g.tourUI, res = this.result;
    const finish = () => { try { if (done) done(); } catch (e) { console.error('TourMatch: after result', e); } };
    if (res && ui && typeof ui.showTournamentResult === 'function') {
      try { ui.showTournamentResult(res, { onClose: finish, hubButton: true }); return; } catch (e) { console.warn('TourMatch: result card', e); }
    }
    finish();
  }

  /** "Retire from the match?" (TourUI choice card): onRetire runs on yes. */
  askRetire(onRetire) {
    const g = this.game, ui = g.tourUI, sp = this.spec || {};
    const body = [
      `Retiring ends your ${String(sp.roundName || 'match').toLowerCase()} against ${sp.opponent ? sp.opponent.name : 'your opponent'} now: it goes down as a loss (ret.).`,
      'The ranking points you have already won this week stay yours.',
    ];
    if (ui && typeof ui.showChoice === 'function') {
      try {
        ui.showChoice({
          title: 'Retire from the match?', speaker: 'Chair umpire', role: sp.tournamentName || 'Junior Tour', body,
          choices: [{ label: 'Keep playing', desc: 'Back to the court', primary: true }, { label: 'Retire', desc: 'A loss, and home to the club' }],
          cancel: 0,
        }, (i) => { if (i === 1 && onRetire) onRetire(); });
        return;
      } catch (e) { console.warn('TourMatch: retire card', e); }
    }
    // (no card: the menu button retires straight away — the session's own Menu is the only way here)
    if (onRetire) onRetire();
  }

  // ─────────────────────────── the way home ───────────────────────────

  /** Remember where the player was at the club (the session puts them back there afterwards). */
  saveClubSide() {
    const g = this.game, p = g.player;
    const pos = p && p.body ? p.body.position : null;
    this._saved = pos ? { x: pos.x, z: pos.z, yaw: g.cameraYaw } : null;
  }

  /** The player's spot back at the club: { x, y, z, yaw } (where they were, else the clubhouse). */
  clubSpot() {
    const g = this.game, sv = this._saved;
    if (sv && Number.isFinite(sv.x) && Number.isFinite(sv.z) && Math.abs(sv.x) < 1000) {
      return { x: sv.x, y: groundAt(sv.x, sv.z), z: sv.z, yaw: sv.yaw };
    }
    const wps = (g.mapData && g.mapData.waypoints) || {};
    const w = wps.clubhouse || wps.patio || wps.entrance || { x: 0, z: 0 };
    return { x: w.x, y: groundAt(w.x, w.z), z: w.z, yaw: null };
  }

  /**
   * Put everyone back (the session's end() calls this before placing the player): Rafa to his
   * post, the opponent home (a club member) or away (the visitor), the venue hidden, the boards
   * back to their own faces.
   */
  teardown() {
    const s = this.s, g = this.game;
    this.active = false;
    this._introAt = Infinity;
    this._onStart = null;
    this.call(null);
    this._clearBoard();
    // Rafa
    const rafa = s.coachNpc;
    if (rafa) {
      try {
        rafa._holdSeat = false;
        rafa._holdFace = null;
        if (this._coachSeat) releaseSeat(this._coachSeat, rafa);
        this._coachSeat = null;
        if (this._coachBody && !rafa.body.world) g.physicsWorld.addBody(rafa.body);
        this._coachBody = false;
        rafa.setOverlaysHidden(false);
        const home = rafa.duty && rafa.duty.post ? rafa.duty.post : this._clubWaypoint(rafa);
        if (home) rafa.placeAt(home.x, home.z, Number.isFinite(home.face) ? home.face : null, Number.isFinite(home.y) ? home.y : null);
      } catch (e) { console.error('TourMatch: coach home', e); }
    }
    // The opponent
    const opp = this.oppNpc;
    if (opp) {
      try {
        opp.fullRateAnim = false;
        if (opp.playing) opp.stopPlaying();
        opp.setOverlaysHidden(false);
        if (opp === this.visitor) opp.setAway(true);
        else {
          const home = this._clubWaypoint(opp);
          if (home) opp.placeAt(home.x, home.z, null, Number.isFinite(home.y) ? home.y : null);
        }
      } catch (e) { console.error('TourMatch: opponent home', e); }
    }
    this.oppNpc = null;
    this._exitVenue();
  }

  /** A preferred club waypoint for `npc` (never a venue spot), else the entrance. */
  _clubWaypoint(npc) {
    const wps = (this.game.mapData && this.game.mapData.waypoints) || {};
    let w = null;
    try { w = npc._getPreferredWaypoint ? npc._getPreferredWaypoint() : null; } catch (e) { w = null; }
    if (!w || !Number.isFinite(w.x) || Math.abs(w.x) > 1000) w = wps.entrance || wps.parking || null;
    return w;
  }

  _exitVenue() {
    const g = this.game;
    if (this.info || (g.venues && g.venues.active)) {
      try { g.venues.setScoreOverride(null); } catch (e) { /* cosmetic */ }
      try { g.venues.exit(); } catch (e) { console.error('TourMatch: venue exit', e); }
    }
    this.info = null;
  }
}
