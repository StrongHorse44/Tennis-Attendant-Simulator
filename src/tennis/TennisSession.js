import * as THREE from 'three';
import { SIZES, GAME } from '../utils/Constants.js';
import { NPC } from '../entities/NPC.js';
import { storageGet, storageSet } from '../systems/SaveSystem.js';
import { getClipEventRacketPoint } from '../entities/CharacterAnimations.js';
import {
  TennisBallSim, BallPredictor, planShot, SPIN, SURFACES, G, R, SURF, HALF_L, SINGLES_W,
  SERVICE_L, FENCE_V, BASE_V, LINE_TOL, setCourtBase, SURF_REL,
} from './TennisBallSim.js';
import { makeShot } from './ShotMaker.js';
import { apparentCOR, sweetness } from './RacketImpact.js';
import { groundAt, inFootprint, nearestExit } from '../world/Ground.js';
import { TennisScore, FORMATS } from './TennisScore.js';
import { TennisAI, DIFFICULTY } from './TennisAI.js';
import { TennisHUD } from './TennisHUD.js';
import { TennisCamera } from './TennisCamera.js';
import { TennisFX } from './TennisFX.js';
import { TennisAudio } from './TennisAudio.js';
import { TennisOcclusion } from './TennisOcclusion.js';
import { TennisCrowd } from './TennisCrowd.js';
import { TennisCoach } from './TennisCoach.js';

/**
 * TennisSession — the after-hours tennis mode: an evening hit with Coach Rafa under the
 * floodlights, on hard (Court 1), clay (Court 5) or grass (Centre Court: the sunken show court
 * court6, whose frame sits at its map.json center.y — see CourtFrame.y0 / _applyCourtBase), calm
 * or windy. Drills (forehand / backhand / volley / serve, fed by Rafa, with scored targets) or a
 * practice match (real scoring, three formats, three difficulties).
 *
 * While active, Game._update hands the whole frame to update(dt): the session steps physics,
 * NPCs, weather and the world itself, drives the player (joystick / WASD + SWING / shot
 * selector) and runs its own camera. Everything happens on the session clock `t`.
 *
 * Real physics throughout: every ball flies a real flight (BallFlight: drag, Magnus lift of the
 * spin, wind, the friction bounce, the net, the back wall or a show court's end boards, the
 * stands), integrated once when it leaves a racket or a hand; the session walks that flight's
 * events (bounces, the net, the wall, the stands) as its clock passes them. Every racket shot —
 * yours, Rafa's, his feeds — comes out of the same pipeline (ShotMaker: plan → racket–ball impact
 * inverse → execution → impact forward); a racket meets the true ball at its contact time (the
 * drawn ball eases onto the strings).
 *
 * Your stroke (Top Spin style): press SWING to take the racket back, hold to load, release to
 * swing — the racket meets the ball LEAD seconds later. The ideal contact t* is the peak of the
 * ball's bounce (the strongest, most accurate strike), where the assist walks you. The timing
 * error e = contact − t*; inside the green window (±gw: control widens it, a full load narrows
 * it) the stroke adapts and the ball lands where you aimed — and the aim is kept inside the
 * lines, so green is in. Outside it the face turns: early pulls (and dips into the net), late
 * pushes (and floats long). Where the ball meets the strings matters too (a sweeter contact
 * carries more pace; the frame is a mishit). Serves are timed on the toss the same way, flipped:
 * early → net or wide, late → long, wide or net.
 *
 * Nothing is saved mid-session: quitting or reloading returns to the post-shift state (the
 * shift phase is untouched); XP and the record are written to the profile (and the save)
 * when a drill or match ends.
 *
 * Debug (dev): __game.tennis.begin('debug'); .startMatch('short', 'easy'); .startDrill('fh');
 *   .bot = { think(session, dt) { ...session.ctl... } }; .externalClock = true; ._tick(dt)
 */

const LEAD = 0.18;              // release → racket contact (s)
const SWING_CONTACT = 0.52;     // forehand / backhand clip contact time
const BACKSWING_T = 0.3;        // forehand / backhand clip: full backswing (held while charging)
const CHARGE_FULL = 0.7;        // hold SWING this long for a full-power stroke
const REACH = 1.2;              // max ball–racket distance across the ball's path at contact that still counts (beyond: a whiff)
const E_WHIFF = 0.13;           // a swing this far off the ideal contact (s) misses the ball altogether
const STRING_REACH = 0.8;       // ball–racket offset across the swing (m) that puts the ball on the frame
const ZONE_LO = 0.3, ZONE_TOP = 1.6;         // groundstroke strike zone above the court: the swing's height adapts inside it
const VZONE_LO = 0.2, VZONE_TOP = 2.0;       // volleys
const OH_ZONE_LO = 1.85, OH_ZONE_TOP = 3.0;  // the overhead
const PEAK_W = 9;               // ideal contact: (t − peak)² weight against the ball–racket distance² (0.1 s ≈ 0.3 m)
const GREEN_PERFECT = 0.35;     // |e| within this share of the green half-width: Perfect!
const SERVE_TS = 1.25, SERVE_SA = 0.3; // player's serve clip: timeScale / startAt (press → toss)
const SERVE_RELEASE = 0.62, SERVE_CONTACT = 1.22;
const SERVE_HOLD = 0.64;        // serve clip: trophy position (still pose), held until SWING is released
const SERVE_SWING = 0.3;        // serve: release → contact (s)
const TOSS_DROP = 0.55;         // the toss peaks this far above the racket at full stretch
const SERVE_BOX_MID = SINGLES_W / 2;  // the middle of a service box (court u from the centre line)
const SERVE_OVER = 0.35;        // full stick aims this far past a box line (angled too far: out, even from the green)
const SERVE_DEPTH = 5.75;       // stick centred: this far from the net
const OH_MIN_H = 1.95;          // contact height (above the court) where the overhead takes over
const MAX_UNWIND = 1.8;         // fastest clip speed when a tap (short hold) unwinds to contact
const INF = Infinity;
const TOSS_OPTS = { gravityOnly: true };
// The session's day: it starts in late-afternoon light and the clock runs only while you play,
// through golden hour and sunset until the floodlights take over. Hours of game time per second
// of play, per match format (a longer match gets a slower sunset); drills use the short rate.
const DAY_START = 16.75, DAY_END = 21;
const DUSK_RATE = { short: 2.9 / 330, set: 2.9 / 660, bo3: 2.9 / 1300 };
const DRILL_REPS = 10;
const RALLY_TRIES = 3;          // rally challenge: attempts (stars from the best rally)
const RALLY_STARS = [6, 14, 25];
const XP_CAP = 45;             // per stat, per drill / match
const OPTS_KEY = 'courtcall.tennis';
const SHOTS = ['flat', 'topspin', 'slice', 'lob', 'drop'];
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];
// Candidate strokes: forehand, backhand, overhead smash, forehand / backhand volley. HOLD_T is the
// still racket-back pose held while charging, CONTACT_T the clip's contact event.
const STROKES = ['forehand', 'backhand', 'smash', 'volley_fh', 'volley_bh'];
const HOLD_T = [BACKSWING_T, BACKSWING_T, 0.32, 0.16, 0.16];
const CONTACT_T = [SWING_CONTACT, SWING_CONTACT, 0.7, 0.3, 0.3];
const N_STROKES = STROKES.length;
const STROKE_BIAS = [0, 0, 0.35, -0.08, -0.08]; // preference when two strokes could reach the ball

// Rafa's drill intros: [HUD line, short speech bubble]
const DRILL_INTRO = {
  fh: ['I feed, you hit the targets. Hold to load, let go in the green.', 'Hit the targets!'],
  bh: ['I feed, you hit the targets. Hold to load, let go in the green.', 'Hit the targets!'],
  volley: ['At the net. Short, firm punch. A tap is enough.', 'Firm punch!'],
  serve: ['Serves. Hold SWING to toss, let go in the green.', 'Toss, then hit!'],
  rally: ['Rally with me. Keep it in, keep it deep. Three tries.', 'Keep it going!'],
};

export const DRILLS = {
  fh: { label: 'Forehand drill', short: 'Forehands' },
  bh: { label: 'Backhand drill', short: 'Backhands' },
  volley: { label: 'Volley drill', short: 'Volleys' },
  rally: { label: 'Rally challenge', short: 'Rally' },
  serve: { label: 'Serve practice', short: 'Serves' },
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = THREE.MathUtils.clamp;

// Wind options: mean speed (m/s) and gust strength (fraction)
export const WINDS = {
  calm: { label: 'Calm', speed: 0, gust: 0 },
  breeze: { label: 'Breezy', speed: 2.6, gust: 0.25 },
  gusty: { label: 'Gusty', speed: 4.6, gust: 0.55 },
};

// The court for each playing surface (map.json ids): the menu picks a surface, the session
// moves to its court. A court's surface is its map.json `type`. Grass is Centre Court, the
// sunken show court (its surface sits at y −2.85: every height goes through frame.y0 / SURF).
export const SURFACE_COURTS = { hard: 'court1', clay: 'court5', grass: 'court6' };
export const SURFACE_LABELS = { hard: 'Hard', clay: 'Clay', grass: 'Grass' };
export function surfaceOf(court) {
  const t = court && court.config && court.config.type;
  return t === 'clay' || t === 'grass' ? t : 'hard';
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _exit = { x: 0, z: 0, y: 0 };
const _R = STROKES.map(() => new THREE.Vector3());

// A show court's end boards (map.json stadium.endBoards; the same defaults as Court._addEndBoards)
const BOARD_V0 = 14.3, BOARD_H = 1.0, BOARD_HALF_U = 9.0;
const BOARD_CAP = 0.06;         // the green cap on top of the boards

/**
 * The session court's frame: centre, rotation (court-local u across, v along; the net is v = 0)
 * and heights: y0 = the court frame's world y (court.baseY: 0 on the flat courts, below the lawn
 * on the sunken Centre Court), surfY = its playing surface. It is also the BallFlight env's
 * frame (cx, cz, c, s).
 *
 * fence = the back wall behind each baseline, as the ball meets it: v (court-local |v| of the
 * ball's centre at the wall), top (world y of its top: a ball whose bottom is under it hits it),
 * halfU (its reach across, court-local |u|). A flat court's 3 m chain-link stops every ball that gets there (top / halfU Infinity:
 * the same rule as ever). A show court (map.json `stadium`, the sunken Centre Court) has only its
 * 1 m end boards (`open`): a ball above them or past their open corners flies on over the
 * walkway and is a dead ball where it meets the stands.
 */
class CourtFrame {
  constructor(court) {
    const cfg = court.config || {};
    this.court = court;
    this.id = court.id;
    this.cx = cfg.center?.x ?? 0; this.cz = cfg.center?.z ?? 0;
    this.r = Number(cfg.rotation) || 0;
    this.c = Math.cos(this.r); this.s = Math.sin(this.r);
    this.y0 = Number.isFinite(court.baseY) ? court.baseY : 0;
    this.surfY = Number.isFinite(court.surfaceY) ? court.surfaceY : this.y0 + SURF_REL;
    this.fence = { v: FENCE_V, top: INF, halfU: INF, open: false };
    if (court.isStadium && cfg.stadium) {
      const eb = cfg.stadium.endBoards || {};
      const v0 = Number.isFinite(eb.v0) ? eb.v0 : BOARD_V0;
      const h = Number.isFinite(eb.height) ? eb.height : BOARD_H;
      const hu = Number.isFinite(eb.halfU) ? eb.halfU : BOARD_HALF_U;
      this.fence.v = v0 - R;                        // the ball's centre when it touches their inner face
      this.fence.top = this.surfY + h + BOARD_CAP;  // (the ball clears them when its bottom is above this)
      this.fence.halfU = hu;
      this.fence.open = true;
    }
  }
  wx(u, v) { return this.cx + u * this.c + v * this.s; }
  wz(u, v) { return this.cz - u * this.s + v * this.c; }
  lu(x, z) { return (x - this.cx) * this.c - (z - this.cz) * this.s; }
  lv(x, z) { return (x - this.cx) * this.s + (z - this.cz) * this.c; }
}
export class TennisSession {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.externalClock = false;  // tests: step with _tick(dt) instead of the game loop
    this.bot = null;             // tests: { think(session, dt) } fills session.ctl
    this.phase = 'off';
    this.t = 0;
    this.surfY = SURF;
    // cues: Easy only — Rafa's "load now / swing now" timing cues (hud.easyCue)
    this.opts = { assist: true, marker: true, aim: true, tips: true, changeEnds: true, trail: true, cues: true };
    let prefSurface = 'hard', prefWind = 'calm';
    try {
      const raw = storageGet(OPTS_KEY);
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        for (const k in this.opts) if (typeof o[k] === 'boolean') this.opts[k] = o[k];
        if (SURFACE_COURTS[o.surface]) prefSurface = o.surface;
        if (WINDS[o.wind]) prefWind = o.wind;
      }
    } catch (e) { /* defaults */ }
    this.lastMatch = { format: 'short', diff: 'easy' };
    this.lastDrill = 'fh';
    this.oppStyle = null;        // tour matches: the opponent's style (the coach's point read)

    const courts = (game.world && game.world.courts) || [];
    const court = this._courtFor(prefSurface, courts) || courts.find(c => c.id === SURFACE_COURTS.hard) || courts.find(c => !c.isClay) || courts[0] || null;
    this.frame = court ? new CourtFrame(court) : null;
    this.surface = surfaceOf(court);
    this.coachNpc = (game.npcs || []).find(n => n.id === 'rafa_ibarra') || null;
    // The flights' court (BallFlight env): the real one (the real wind), and the one a hitter
    // plans with (only the part of the wind he allows for)
    this._env = { surfY: SURF, frame: null, fence: null, surface: SURFACES.hard, wind: null, groundAt: null, net: true };
    this._planEnv = { surfY: SURF, frame: null, fence: null, surface: SURFACES.hard, wind: null, groundAt: null, net: true };
    // The ball and the court overlays exist (hidden) from the start, so the game's shader
    // pre-compile covers their programs, day and night variants: nothing compiles mid-rally
    this.ball = null; this.fx = null;
    if (game.scene) {
      try { this._buildBallFx(); } catch (err) { console.error('TennisSession: ball / FX', err); this.ball = this.fx = null; }
    }
    this._applyCourtBase();

    this.ctl = { moveX: 0, moveY: 0, swing: false, shot: 1 };
    this._prevSwing = false;
    this._prevDigits = [false, false, false, false, false];
    this.sides = [1, -1];

    // The ball in play: the current flight's kind, hitter / receiver, the next event to walk
    // (evI), a planned racket contact (tContact / contactBy / cpt), and what the flight will do
    // (read at launch: landing, net crossing, in / out, average pace)
    this.fl = {
      active: false, kind: 'none', hitter: 0, receiver: 1, resolved: false, bounces: 0,
      tGround: INF, tContact: INF, contactBy: -1, cpt: new THREE.Vector3(), evI: 0, tLaunch: 0,
      netU: 0, netH: INF, netted: false, let: false, willBeIn: true, landX: 0, landZ: 0, shot: 'flat',
      q: 1, power: 0, touchedByReceiver: false, pace: 10, tossClip: 'serve',
      fromU: 0, fromV: 0, oppU: 0, oppV: 0,
    };
    this.srv = {
      who: 0, started: false, charging: false, charge: 0, tRelease: INF, tContact: INF, tAuto: INF, power: 0,
      deuce: true, second: false, yaw: 0, tPress: INF, tSweet: INF, hold: 0.8, tossed: false, e: 0, q: 1, label: '',
      catchY: 0, spin: 'serve', gw: 0.04, a: 0, b: 0, green: false, pending: false, tWhiff: INF,
    };
    this.pl = {
      u: 0, v: 0, vu: 0, vv: 0, yaw: 0, stamina: 1, clip: null, swingFree: 0, swung: false, swing: null,
      ax: 0, az: 0, aValid: false, aFrom: 0, hx: 0, hz: 0, moved: 0, lastSpeed: 0, tIdeal: INF, idealSide: 1,
      idealD: INF, setT: 0, burst: 0, sideD: STROKES.map(() => INF), sliding: 0, tracking: false,
    };
    // Hold-to-charge: press starts the backswing, holding builds power, release swings
    this.chg = { on: false, t0: 0, stroke: 0, power: 0, hold: BACKSWING_T };
    // Your last stroke: e = contact − ideal contact (s), gw = the green half-width, a / b = where
    // the ball met the strings (−1…1 each; beyond = the frame), peak = how close to the top of the
    // bounce (1 = at the peak), q = an overall quality 0…1 (0 = a whiff) for the coach
    this.swing = {
      tc: INF, clip: 'forehand', stroke: 0, q: 0, e: 0, dmin: 0, label: '', volley: false, stretch: 0, power: 0,
      half: false, moving: 0, set: false, forced: false, hc: 0, slide: false, onRun: false, run: 0,
      gw: 0.045, green: false, perfect: false, frame: false, a: 0, b: 0, peak: 1, tStar: INF, vin: 0,
    };
    // Momentum (−1 … 1) for you / Rafa: points, big shots and errors swing it
    this.momentum = [0, 0];
    this._aim = { u: 0, v: 0, valid: false, xs: 0, depth: 0 };
    this._prof = { top: 0, side: 0, gyro: 0 };                  // hitter-frame spin of the shot being hit
    this.wind = { x: 0, z: 0 };   // m/s, world (session option)
    this.windKey = prefWind;
    this._windDir = 0; this._windPhase = 0; this._windBase = 0;
    this._windA = { x: 0, z: 0 };
    // Rafa's shot (TennisTactics fills it: the intention and his execution)
    this._shot = { spin: 'flat', u: 0, v: 0, speed: 24, pace: 0, margin: 0.5, minT: 0, kind: 'rally', phys: 'ground', wing: 'fh', e: 0, gw: 0.045, a: 0, b: 0 };
    this.pred = new BallPredictor();
    this.pred2 = new BallPredictor();
    this.rallyShots = 0;
    // Scratch, reused for every shot and query (no allocation in play)
    this._cs = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, bounces: 0, rolling: false }; // the ball at a contact
    this._qs = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, bounces: 0, rolling: false }; // queries
    this._res = { n: { x: 0, y: 0, z: 0 } };                    // ShotMaker result
    this._pln = {};                                             // planShot result (the last-resort green launch)
    this._popts = { speed: 0, pace: 0, margin: 0.4, minT: 0 };
    this._tgt = { x: 0, z: 0 };
    this._intent = { tx: 0, tz: 0, profile: this._prof, speed: 0, pace: 0, margin: 0.5, minT: 0, kind: 'ground', wing: 'fh' };
    this._exec = { e: 0, gw: 0.05, a: 0, b: 0, B: null, outSign: 1 };
    this._up = { x: 0, y: 1, z: 0 };
    this._axB = { x: 1, y: 0, z: 0 };                           // a horizontal across axis (serves, the overhead)
    this._ic = STROKES.map(() => ({ t: INF, d: INF, x: 0, y: 0, z: 0 }));
    this._cd = INF;                                             // _cost's ball–racket distance
    this._peakT = INF; this._reboundVy = 2; this._fiSerial = -1;// the incoming flight's peak (after its first bounce)
    this._gwEst = 0.045;                                        // the green half-width expected at the ideal release
    this._landed = { hitter: 0, u: 0, v: 0, kind: '', shot: '', inPlay: false, fromU: 0, fromV: 0, oppU: 0, oppV: 0 };
    this._meter = { on: false, x: 0, y: 0, load: 0, head: 0, band: [0, 0], perfect: 0, full: 1, reach: false, stroke: 'forehand', serve: false };
    this._readout = { a: 0, b: 0, sx: 0, sy: 0, peak: 1, e: 0, green: false, label: '' };
    this._cueK = null; this._cueS = null;
    // This point, for the coach: your last three shot directions, the serve's target, the
    // return's depth, whether you came in
    this._pt = { pattern: [], serveTarget: '', returnDepth: 0, approach: false };
    this._hudErr = false;
    this._boardSet = false;      // the stadium scoreboard shows this session's match (_stadiumBoard)
    this._built = false;
  }

  // ─────────────────────────── lazily built parts ───────────────────────────

  _build() {
    if (this._built) return;
    this._built = true;
    const g = this.game;
    if (!this.ball || !this.fx) this._buildBallFx();
    this.ai = new TennisAI(this);
    if (this.coachNpc) this.ai.attach(this.coachNpc);
    this.cam = new TennisCamera(g.camera);
    this.audio = new TennisAudio(g.sound);
    this.occ = new TennisOcclusion(g);   // see-through lights / fences / props between the camera and the play
    this.crowd = new TennisCrowd(g);     // members go home, staff watch from the sidelines
    this.coach = new TennisCoach(this);  // Rafa's tips: patterns in your play, between points
    this.hud = new TennisHUD({
      onSwingDown: () => { this._hudSwing = true; },
      onSwingUp: () => { this._hudSwing = false; },
      onShot: (i) => this.setShot(i),
      onStartDrill: (type) => this.startDrill(type),
      onStartMatch: (format, diff) => this.startMatch(format, diff),
      onOption: (k, v) => this.setOption(k, v),
      onSurface: (key) => { const ok = this.setSurface(key); if (ok) this._saveOpts(); return ok; },
      onWind: (key) => { this.setWind(key); this._saveOpts(); },
      onLeave: () => this.end(),
      onMenu: () => this.openMenu(true),
      onRematch: () => this._rematch(),
      onChangeMode: () => this.openMenu(false),
      onDone: () => this.end(),
      getProfile: () => this.game.profile,
    });
    this._hudSwing = false;
  }

  _buildBallFx() {
    const scene = this.game.scene;
    if (!this.ball) {
      this.ball = new TennisBallSim(scene);
      this.ball.surface = SURFACES[this.surface] || SURFACES.hard;
    }
    if (!this.fx) {
      this.fx = new TennisFX(scene);
      this.fx._markY = SURF;
    }
  }

  /**
   * The playing surface follows the session court's height (frame.y0): the ball physics
   * (TennisBallSim SURF / BALL_Y, live bindings), the flights' court, the ball's ground, the
   * landing marks. Called whenever the frame changes (construction, begin, setSurface); a no-op
   * change on the flat courts.
   */
  _applyCourtBase() {
    setCourtBase(this.frame ? this.frame.y0 : 0);
    this.surfY = SURF;
    if (this.ball) this.ball.groundY = SURF;
    if (this.fx) this.fx._markY = SURF;
    this._syncEnv();
  }

  /**
   * The flights' court (BallFlight env) for the session court: its surface height, frame, back
   * wall (a flat court's fence / the show court's end boards), bounce surface, and the stands
   * round the sunken show court (groundAt: a ball that comes down on them is dead).
   */
  _syncEnv() {
    const f = this.frame, surf = SURFACES[this.surface] || SURFACES.hard;
    const ga = f && f.fence.open ? groundAt : null;
    for (let i = 0; i < 2; i++) {
      const e = i ? this._planEnv : this._env;
      e.surfY = SURF; e.frame = f; e.fence = f ? f.fence : null; e.surface = surf; e.groundAt = ga; e.net = true;
    }
  }

  // ─────────────────────────── availability / entry ───────────────────────────

  /** Rafa's dialogue hook: after closing time he offers a hit (true if handled). */
  offerFromNpc(npc) {
    if (!npc || npc !== this.coachNpc || this.active || !this.frame) return false;
    const g = this.game, sh = g.shift;
    if (!sh) return false;
    const t = g.weather.timeOfDay;
    const after = (sh.phase === 'onShift' && t >= (GAME.shiftClosingHour ?? 18.5)) || sh.phase === 'ending';
    if (!after) return false;
    const ms = g.missionSystem;
    if (ms) {
      for (const m of ms.getActiveMissions()) if (ms.getStepNpcId && ms.getStepNpcId(m) === npc.id) return false;
      if (ms.pendingEncounters && ms.pendingEncounters.has && ms.pendingEncounters.has(npc.id)) return false;
    }
    const ds = g.dialogueSystem;
    if (!ds || ds.isActive()) return false;
    ds.currentNPC = npc;
    npc.startTalking();
    ds.active = true;
    ds.dialogueBox.show(npc.name, 'The courts are quiet now. Stay for a hit after your shift? We play into the sunset, then under the lights. I will go easy. Maybe.', npc.dialogueColor || '#7db5ee');
    ds.showChoices([
      { label: "Let's hit! 🎾", description: `Clock out and meet Rafa on ${this.frame.court?.config?.label || 'Court 1'}` },
      { label: 'Not tonight', description: 'Maybe another evening' },
    ], (i) => {
      if (i === 0) this.begin('rafa');
      else npc.say('Bueno. Another night.', 2);
    });
    return true;
  }

  /**
   * Start the evening session. from: 'report' (report card button), 'rafa' (dialogue,
   * shift not yet closed), 'debug'.
   */
  begin(from = 'report') {
    if (this.active || !this.frame || !this.coachNpc) return false;
    this._build();
    this._applyCourtBase();
    const g = this.game;
    this.from = from;
    this.active = true;
    this.phase = 'menu';
    this.mode = null;
    this.t = 0;

    // Leave the report pause (the card is hidden by its own button)
    if (g.shiftReport && g.shiftReport.isOpen) g.shiftReport.hide();
    if (g.paused && g.pauseReason === 'report') g.resume();
    if (g.dialogueSystem && g.dialogueSystem.isActive()) g.dialogueSystem.forceEnd();
    if (g.player.isInCart) { g.player.exitCart(); g.sound.stopCartEngine && g.sound.stopCartEngine(); g.wasInCart = false; }
    if (g.hud && g.hud.isRadioCardVisible && g.hud.isRadioCardVisible()) g.hud.hideRadioDispatch();

    // Late afternoon, clear sky, weather held; the session's own clock takes it to sunset and
    // the floodlights (WeatherSystem.stadium) as you play
    const w = g.weather;
    this._saved = { frozen: w.clockFrozen, weatherTimer: w.weatherTimer, matches: g.matches ? g.matches.enabled : true, time: w.timeOfDay };
    w.timeOfDay = DAY_START;
    w.clockFrozen = true;
    w.stadium = 1;
    if (w.getWeather() !== 'sunny') w.setWeather('sunny', true);
    // Court 1 to ourselves
    if (g.matches) {
      g.matches.enabled = false;
      // After hours: every member match winds up (Rafa may be booked on another court)
      for (const m of g.matches.matches.slice()) { try { g.matches._finish(m); } catch (e) { /* ignore */ } }
    }
    // Centre Court's spectators and crowd impostors go home too (optional systems)
    try { g.spectators?.releaseAll?.('tennis'); } catch (e) { /* ignore */ }
    try { g.world?.stadium?.setCrowd?.(0, true); } catch (e) { /* ignore */ }
    NPC.setAreaBusy(this.frame.id, true);

    // Player: on foot, racket out, no collisions (we place the body ourselves)
    const p = g.player;
    p.body.velocity.set(0, 0, 0);
    p.character.setRacketVisible(true);
    p.character.anim.autoIdleVariants = false;
    // Rafa
    const npc = this.coachNpc;
    if (npc.state === 'talking') npc.stopTalking();
    if (npc.playing) npc.stopPlaying();
    npc.startPlaying(this.frame.id, 'north');
    npc.fullRateAnim = true; // the opponent animates every frame at full detail, whatever the camera distance
    npc.character.setBallVisible(false);

    this.sides[0] = 1; this.sides[1] = -1;
    this._setSurfaceKey(this.surface);
    this.setWind(this.windKey);
    this._placePlayer(0, BASE_V);
    this.ai.place(0, -BASE_V);
    this.ball.hide();
    this.fx.hideAll();
    this.cam.snap(this);
    try { this.occ.begin(this); } catch (err) { console.error('TennisOcclusion', err); }
    document.body.classList.add('cc-tennis');
    this.hud.show();
    this.openMenu(false);
    this.audio.start();
    this._crowd('begin', this);
    npc.say(pick(['Vamos! The court is ours.', 'Play till the lights come on.', 'Hola! Warm up the feet first.']), 2.6);
    this._resetCtl();
    return true;
  }

  /** Leave the court: back to the club, then the next day (or the report card). */
  end() {
    if (!this.active) return;
    const g = this.game;
    this._applyPendingXp();
    this._clearStadiumBoard();
    this.active = false;
    this.phase = 'off';
    this.mode = null;
    this.chg.on = false;
    this._hudFrame();            // (the swing meter and the cues off)
    this.hud.hide();
    this.fx.hideAll();
    this.ball.hide();
    this.audio.stop();
    try { this.occ.end(); } catch (err) { console.error('TennisOcclusion', err); }
    this._crowd('end', this);
    document.body.classList.remove('cc-tennis');
    NPC.setAreaBusy(this.frame.id, false);
    const npc = this.coachNpc;
    this.ai.reset();
    npc.stopPlaying();
    npc.fullRateAnim = false;
    const p = g.player;
    p.character.setRacketVisible(false);
    p.character.setBallVisible(false);
    p.character.anim.autoIdleVariants = true;
    p.character.stop(0.2);
    // Walk off beside the court (bench side); a court with an `<id>_exit` waypoint (the sunken
    // Centre Court: the head of the Players' Walk, up on the lawn) is left from exactly there
    const wps = g.mapData && g.mapData.waypoints;
    const ex = wps && wps[`${this.frame.id}_exit`];
    const wp = ex ? null : wps && wps[`${this.frame.id}_bench`];
    const x = ex ? ex.x : wp ? wp.x - 1.2 : this.frame.wx(-9.5, 2), z = ex ? ex.z : wp ? wp.z : this.frame.wz(-9.5, 2);
    const src = ex || wp;
    const gy = src && Number.isFinite(src.y) ? src.y : groundAt(x, z);
    p.body.position.set(x, gy + SIZES.playerRadius * SIZES.playerScale, z);
    p.body.velocity.set(0, 0, 0);
    p.mesh.position.set(x, gy, z);
    if (typeof p.snapToGround === 'function') p.snapToGround(gy); // (Player.update's eased mesh-y state too)
    // Rafa must not stay behind in the bowl: up the nearest aisle to the lawn
    if (inFootprint(npc.body.position.x, npc.body.position.z)) {
      const out = nearestExit(npc.body.position.x, npc.body.position.z, _exit);
      if (out) {
        // (never on top of the player at the same aisle head: a step along the rim path)
        const side = Math.hypot(out.x - x, out.z - z) < 1.2 ? 1.4 : 0;
        const dx = out.x - this.frame.cx, dz = out.z - this.frame.cz, dl = Math.hypot(dx, dz) || 1;
        npc.placeAt(out.x - (dz / dl) * side, out.z + (dx / dl) * side, null, 0);
      }
    }
    if (g.matches) g.matches.enabled = this._saved ? this._saved.matches : true;
    const w = g.weather;
    w.stadium = 0;
    if (this._saved) { w.weatherTimer = this._saved.weatherTimer; }
    g.cameraYaw = g.cameraTargetYaw = Math.atan2(this.frame.cx - x, this.frame.cz - z);
    if (g._snapCamera) g._snapCamera();
    g._actionLabel = undefined;
    // Continue the evening: the report card if the shift is still closing, else the next day
    const sh = g.shift;
    if (this.from === 'debug') {
      if (this._saved) { w.timeOfDay = this._saved.time; w.clockFrozen = this._saved.frozen; }
    } else if (sh && sh.phase === 'report') {
      g.startNextDay();
    } else if (sh) {
      w.timeOfDay = Math.max(w.timeOfDay, sh.endHour || GAME.shiftEndHour || 19);
      w.clockFrozen = this._saved ? this._saved.frozen : false;
      if (sh.phase === 'onShift' || sh.phase === 'ending') sh.update(0, true); // clock out → report card
    }
    // Saved once the club's clock is back (never the session's afternoon-to-night time)
    try { g.saveGame(); } catch (e) { /* ignore */ }
  }

  setOption(k, v) {
    if (!(k in this.opts)) return;
    this.opts[k] = !!v;
    this._saveOpts();
    if (k === 'marker' && !v) this.fx.hideMarker();
    if (k === 'trail' && !v) this.fx.trailUpdate(false);
  }

  _saveOpts() {
    try { storageSet(OPTS_KEY, JSON.stringify({ ...this.opts, surface: this.surface, wind: this.windKey })); } catch (e) { /* ignore */ }
  }

  /** Courts you can play on right now: [{ surface, id, label }] (one per surface that has a court). */
  courtChoices() {
    const courts = (this.game.world && this.game.world.courts) || [];
    const out = [];
    for (const key of ['hard', 'clay', 'grass']) {
      const c = this._courtFor(key, courts);
      if (c && !out.some(o => o.id === c.id)) out.push({ surface: key, id: c.id, label: c.config?.label || c.id });
    }
    return out;
  }

  _courtFor(surface, courts) {
    const want = SURFACE_COURTS[surface];
    const c = courts.find(k => k.id === want && surfaceOf(k) === surface);
    return c || courts.find(k => surfaceOf(k) === surface) || null;
  }

  /**
   * Move the session to the court of another surface ('hard' | 'clay' | 'grass'), from the menu
   * only. Frees the old court, takes the new one, re-seats the staff and re-aims the see-through.
   */
  setSurface(surface) {
    const courts = (this.game.world && this.game.world.courts) || [];
    const court = this._courtFor(surface, courts);
    if (!court) return false;
    if (this.frame && court.id === this.frame.id) { this._setSurfaceKey(surfaceOf(court)); return true; }
    if (this.active && this.phase !== 'menu') return false;
    if (!this.active) { this.frame = new CourtFrame(court); this._applyCourtBase(); this._setSurfaceKey(surfaceOf(court)); return true; }
    this._clearStadiumBoard();
    try { this.occ.end(); } catch (err) { console.error('TennisOcclusion', err); }
    NPC.setAreaBusy(this.frame.id, false);
    this.frame = new CourtFrame(court);
    this._applyCourtBase();
    this._setSurfaceKey(surfaceOf(court));
    NPC.setAreaBusy(this.frame.id, true);
    const npc = this.coachNpc;
    npc.stopPlaying();
    npc.startPlaying(this.frame.id, 'north');
    npc.character.setBallVisible(false);
    this.sides[0] = 1; this.sides[1] = -1;
    this._placePlayer(0, BASE_V);
    this.ai.place(0, -BASE_V);
    this.cam.snap(this);
    if (this.crowd && this.crowd.relocate) this._crowd('relocate', this);
    else { this._crowd('end', this); this._crowd('begin', this); }
    try { this.occ.begin(this); } catch (err) { console.error('TennisOcclusion', err); }
    return true;
  }

  _setSurfaceKey(key) {
    this.surface = SURFACES[key] ? key : 'hard';
    if (this.ball) this.ball.surface = SURFACES[this.surface];
    this._syncEnv();
    if (this.hud) this.hud.setConditions(this.surface, null);
  }

  /**
   * Wind for the next match / drill: 'calm', 'breeze' or 'gusty'. A breeze blows steadily from
   * one direction; gusty wind is stronger and comes and goes. Each shot takes the wind at its
   * launch (it is part of the flight's acceleration), the hitter only partly allows for it.
   */
  setWind(key) {
    if (!WINDS[key]) key = 'calm';
    this.windKey = key;
    if (this.hud) this.hud.setConditions(null, key);
    const wd = WINDS[key];
    this._windDir = Math.random() * Math.PI * 2;
    this._windPhase = Math.random() * 10;
    this._windBase = wd.speed;
    this._updateWind(0);
  }

  /** The wind pill: speed and where it blows on screen (relative to the camera's heading). */
  _windHud() {
    const w = this.wind, sp = Math.hypot(w.x, w.z);
    if (sp < 0.3 || this.phase === 'menu') { this.hud.setWind(0, 0); return; }
    const cam = this.game.camera;
    cam.getWorldDirection(_v1);
    const fx = _v1.x, fz = _v1.z, fl = Math.hypot(fx, fz) || 1;
    // clockwise angle from the camera's forward (up the screen) to the wind
    const ang = Math.atan2((fx * w.z - fz * w.x) / fl, (fx * w.x + fz * w.z) / fl);
    this.hud.setWind(sp, ang);
  }

  /** Current wind vector (gusts), into the ball for the next launch. */
  _updateWind(dt) {
    const wd = WINDS[this.windKey] || WINDS.calm;
    if (!wd.speed) { this.wind.x = this.wind.z = 0; if (this.ball) this.ball.wind = null; return; }
    this._windPhase += dt;
    const ph = this._windPhase;
    const gust = wd.gust ? 1 + wd.gust * (0.6 * Math.sin(ph * 0.37) + 0.4 * Math.sin(ph * 1.13 + 1.7)) : 1;
    const dir = this._windDir + (wd.gust ? 0.25 * Math.sin(ph * 0.21) : 0);
    const sp = Math.max(0, this._windBase * gust);
    this.wind.x = Math.sin(dir) * sp; this.wind.z = Math.cos(dir) * sp;
    if (this.ball) this.ball.wind = this.wind;
  }

  setShot(i) {
    if (i < 0 || i >= SHOTS.length) return;
    this.ctl.shot = i;
    if (this.hud) this.hud.setShot(i);
  }

  openMenu(abandon) {
    if (abandon && (this.phase !== 'menu' && this.phase !== 'results')) this._applyPendingXp();
    this._stopPlay();
    this._clearStadiumBoard();
    this.phase = 'menu';
    this.mode = null;
    this.ball.hide();
    this.fx.hideAll();
    this.ai.reset();
    this.hud.hideResults();
    this.hud.setPlayUi(false);
    this.hud.showMenu({
      opts: this.opts, last: this.lastMatch, lastDrill: this.lastDrill, profile: this.game.profile,
      court: { surface: this.surface, choices: this.courtChoices() }, wind: this.windKey,
    });
    this._placePlayer(0, BASE_V * this.sides[0]);
    this.ai.place(0, BASE_V * this.sides[1]);
  }

  /** Drop whatever was in flight (menu / leaving mid-point): no live ball, no held stroke or toss. */
  _stopPlay() {
    const fl = this.fl, srv = this.srv;
    this._cancelCharge();
    fl.active = false; fl.resolved = false; fl.kind = 'none';
    fl.tContact = fl.tGround = INF; fl.contactBy = -1; fl.evI = 0;
    this.tPointOver = INF; this.tFeed = INF;
    srv.started = false; srv.charging = false; srv.tossed = false; srv.pending = false;
    srv.tRelease = srv.tContact = srv.tWhiff = INF;
    this.ball.hide();
    this.ball.clearOffset();
    const ch = this.game.player.character;
    if (ch.anim.oneShot) ch.stop(0.2);
    ch.setBallVisible(false);
    this.pl.clip = null; this.pl.swingFree = 0;
    this.hud.setMeter?.(-1); this.hud.setServeHint?.(false); this.hud.setRally(0);
    this._hudFrame();
  }

  _resetCtl() {
    this.ctl.moveX = this.ctl.moveY = 0;
    this.ctl.swing = false;
    this._prevSwing = false;
    this._hudSwing = false;
  }

  // ─────────────────────────── modes ───────────────────────────

  _newStats() {
    this.stats = {
      winners: [0, 0], errors: [0, 0], aces: [0, 0], doubles: [0, 0], points: [0, 0],
      rallies: 0, rallyShots: 0, longest: 0, perfect: 0, swings: 0, hits: 0, reached: 0,
      serveIn: 0, serves: 0, firstIn: 0, firsts: 0, charges: 0, powerShots: 0, smashes: 0, drops: 0,
      netPts: [0, 0], unforced: 0,
      xp: { power: 0, control: 0, spin: 0, speed: 0, serve: 0, stamina: 0 },
      drill: { score: 0, targets: 0, inCourt: 0, reps: 0 },
    };
    this._xpApplied = false;
  }

  startMatch(format = 'short', diff = 'medium') {
    if (!this.active) return;
    this.lastMatch = { format: FORMATS[format] ? format : 'short', diff: DIFFICULTY[diff] ? diff : 'medium' };
    this.mode = 'match';
    this.format = this.lastMatch.format;
    this.setWind(this.windKey);   // a new day's breeze: a fresh direction
    this.ai.setDifficulty(this.lastMatch.diff, this.surface);
    this.score = new TennisScore({ format: this.format, firstServer: Math.random() < 0.5 ? 0 : 1 });
    this.sides[0] = 1; this.sides[1] = -1;
    this._newStats();
    this.faults = 0;
    this.pl.stamina = 1;
    this.hud.hideMenu();
    this.hud.hideResults();
    this.hud.setPlayUi(true, 'match');
    this._hudCall('setNames', null);
    this.hud.setInfo(`${FORMATS[this.format].label} · ${DIFFICULTY[this.lastMatch.diff].label} · ${SURFACES[this.surface].label}${this.windKey !== 'calm' ? ' · ' + WINDS[this.windKey].label : ''}`);
    this._updateScoreboard();
    this.momentum[0] = this.momentum[1] = 0;
    this.hud.setMomentum(0, 0);
    this._coach('reset', 'match', { format: this.format, diff: this.lastMatch.diff });
    this._say(pick(['Bueno. Real points now.', 'Vamos! Show me what you have.', 'Play smart. Not hard. Smart.']), 2.2);
    this._setupPoint(true);
  }

  startDrill(type = 'fh') {
    if (!this.active) return;
    if (!DRILLS[type]) type = 'fh';
    this.lastDrill = type;
    this.mode = 'drill';
    this._clearStadiumBoard();
    this.setWind(this.windKey);
    this.drill = { type, rep: 0, score: 0, count: 0, best: 0 };
    this.momentum[0] = this.momentum[1] = 0;
    this.sides[0] = 1; this.sides[1] = -1;
    this.ai.setDifficulty('easy', this.surface);
    this._newStats();
    this.faults = 0;
    this.pl.stamina = 1;
    this.hud.hideMenu();
    this.hud.hideResults();
    this.hud.setPlayUi(true, 'drill');
    this._drillTargets();
    this._coach('reset', 'drill', { type });
    const intro = DRILL_INTRO[type] || DRILL_INTRO.fh;
    this._say(intro[0], 2.6, intro[1]);
    this._drillSetup(true);
  }

  _rematch() {
    if (this.mode === 'drill' || (this.lastWasDrill && this.lastDrill)) this.startDrill(this.lastDrill);
    else this.startMatch(this.lastMatch.format, this.lastMatch.diff);
  }

  // ─────────────────────────── per frame ───────────────────────────

  update(dt) {
    if (!this.active || this.externalClock) return;
    this._tick(dt);
  }

  _tick(dt) {
    const g = this.game;
    this.t += dt;
    this._readControls(dt);
    this._updateWind(dt);

    // Physics (NPC bodies), NPCs, scheduled member matches winding down
    g.world.stepPhysics(dt);
    const pp = g.player.mesh.position;
    for (const npc of g.npcs) npc.update(dt, pp);
    if (g.matches) g.matches.update(dt);

    try { this._updatePlay(dt); } catch (err) {
      console.error('TennisSession error — back to the menu', err);
      this.openMenu(false);
    }

    // World, weather (lights / shadows centred on the court), camera, HUD bits
    g.world.update(dt, pp);
    g.weather.weatherTimer = Math.max(g.weather.weatherTimer, 30); // hold the weather
    this._advanceDay(dt);
    _v1.set(this.frame.cx, this.frame.y0, this.frame.cz);
    g.weather.setShadowFocus(_v1);
    g.weather.update(dt);
    this.cam.update(this, dt);
    this._windHud();
    this._hudFrame();            // the swing meter at your feet (after the camera: projected), Easy cues
    try { this.occ.update(this, dt); } catch (err) { /* cosmetic */ }
    this._coach('update', dt);
    this._crowd('update', this, dt);
    this.fx.update(dt);
    if (g.hud) g.hud.update(dt);
    this.audio.update(dt);
  }

  /**
   * The club's clock while the session runs its own sunset (saves use it): the session always
   * ends at clock-out or later, or back where it started for a debug session.
   */
  clubTimeOfDay() {
    if (!this.active || !this._saved) return NaN;
    if (this.from === 'debug') return this._saved.time;
    const sh = this.game.shift;
    return Math.max(this._saved.time, (sh && sh.endHour) || GAME.shiftEndHour || 19);
  }

  /** The sun goes down while you play (not in the menu / results): day → sunset → floodlights. */
  _advanceDay(dt) {
    const ph = this.phase;
    if (ph === 'menu' || ph === 'results' || !this.mode) return;
    const w = this.game.weather;
    const rate = this.mode === 'match' ? (DUSK_RATE[this.format] || DUSK_RATE.short) : DUSK_RATE.short;
    if (w.timeOfDay < DAY_END) w.timeOfDay = Math.min(DAY_END, w.timeOfDay + dt * rate);
  }

  _readControls(dt) {
    const c = this.ctl;
    if (this.bot) { this.bot.think(this, dt); return; }
    const inp = this.game.input;
    inp.cameraRotationDelta = 0; // Q/R and canvas drags must not pile up for after the session
    const mv = inp.getMoveDirection();
    c.moveX = mv.x; c.moveY = mv.y;
    const k = inp.keys;
    c.swing = !!(this._hudSwing || (inp.enabled && (k.Space || k.KeyJ)));
    for (let i = 0; i < DIGITS.length; i++) {
      const down = !!k[DIGITS[i]];
      if (down && !this._prevDigits[i]) this.setShot(i);
      this._prevDigits[i] = down;
    }
  }

  _updatePlay(dt) {
    const t = this.t;
    // Swing edges
    const sw = this.ctl.swing;
    if (sw && !this._prevSwing) this._onSwingDown();
    if (!sw && this._prevSwing) this._onSwingUp();
    this._prevSwing = sw;

    this.ai.update(t);
    this._updateServe(dt);
    this._updateCharge();
    this._updatePlayer(dt);
    this._updateBall(dt);
    this._updateAids();

    // Point / rep over
    if (this.fl.resolved && t >= this.tPointOver) {
      this.tPointOver = INF;
      if (this.mode === 'match') this._awardPoint();
      else if (this.mode === 'drill') this._drillNext();
    }
    if (this.mode === 'drill' && this.phase === 'feedWait' && t >= this.tFeed) {
      this.tFeed = INF;
      this._drillFeed();
    }
  }

  // ─────────────────────────── player ───────────────────────────

  _placePlayer(u, v) {
    const g = this.game, p = g.player, f = this.frame;
    const x = f.wx(u, v), z = f.wz(u, v);
    // (the body keeps its flat-court relation to the court frame: y0 + r, the mesh on the surface)
    p.body.position.set(x, f.y0 + SIZES.playerRadius * SIZES.playerScale, z);
    p.body.velocity.set(0, 0, 0);
    p.mesh.position.set(x, SURF, z);
    this.pl.u = u; this.pl.v = v; this.pl.vu = 0; this.pl.vv = 0;
    this.pl.yaw = f.r + (this.sides[0] > 0 ? Math.PI : 0);
    p.mesh.rotation.y = this.pl.yaw;
    p.mesh.updateMatrixWorld(true);
    this.pl.swung = false;
    this.pl.aValid = false;
    if (this.pl.swingFree === INF) this.pl.swingFree = 0;
  }

  _placeAt(who, u, v) {
    if (who === 0) this._placePlayer(u, v); else this.ai.place(u, v);
  }

  _speed() {
    const st = this.game.profile ? this.game.profile.getTennisStats() : null;
    const sp = st ? st.speed : 30;
    const fat = this._fatigue();
    return (4.0 + sp * 0.035) * (0.8 + 0.2 * fat);
  }

  /** 1 = fresh … 0 = exhausted (below 30 % stamina it starts to hurt). */
  _fatigue() { return clamp(this.pl.stamina / 0.3, 0, 1); }

  _updatePlayer(dt) {
    const g = this.game, p = g.player, ch = p.character, f = this.frame, pl = this.pl, c = this.ctl;
    const side = this.sides[0];
    const t = this.t;
    let vu = 0, vv = 0;
    const planted = t < pl.swingFree || (this.phase === 'serve' && this.srv.who === 0) || this.phase === 'menu' || this.phase === 'results';
    if (!planted) {
      const full = this._speed() * (pl.burst > 0 ? 1.12 : 1); // a quicker first step out of a split step
      if (this.chg.on) {
        // Loading a stroke (Top Spin style): the stick aims now, the feet make the adjustment
        // steps toward the ideal hitting spot — briskly with the assist, small steps without it
        if (pl.aValid && t >= pl.aFrom) {
          const du = pl.ax - pl.u, dvv = pl.az - pl.v;
          const d = Math.hypot(du, dvv);
          if (d > 0.05) {
            const as = Math.min(full * (this.opts.assist ? 0.88 : 0.55), d * 5);
            vu = du / d * as; vv = dvv / d * as;
          }
        }
      } else {
        const speed = full;
        const len = Math.min(1, Math.hypot(c.moveX, c.moveY));
        if (len > 0.12) {
          vu = side * c.moveX / Math.max(len, 1e-3) * speed * len;
          vv = side * c.moveY / Math.max(len, 1e-3) * speed * len;
        }
        // Auto-move assist: drift toward the ideal hitting spot (or home after your shot)
        if (this.opts.assist && pl.aValid && t >= pl.aFrom) {
          const du = pl.ax - pl.u, dvv = pl.az - pl.v;
          const d = Math.hypot(du, dvv);
          if (d > 0.05) {
            const as = Math.min(speed * 0.88, d * 5); // a touch slower than your legs: steering still pays
            const k = len > 0.12 ? 0.45 : 1;
            vu = vu * (len > 0.12 ? 0.75 : 0) + du / d * as * k;
            vv = vv * (len > 0.12 ? 0.75 : 0) + dvv / d * as * k;
          }
        }
        const sp = Math.hypot(vu, vv);
        if (sp > speed) { vu *= speed / sp; vv *= speed / sp; }
      }
    }
    // Feet, not skates: quick acceleration, quicker stops (the surface decides how quick: clay
    // lets you slide into a wide ball, grass gives a little less grip)
    const mv = (this.ball && this.ball.surface || SURFACES.hard).move;
    const speeding = vu * vu + vv * vv > pl.vu * pl.vu + pl.vv * pl.vv;
    const k = 1 - Math.exp(-dt * (speeding ? 11 * mv.accel : 17 * mv.stop));
    const cur = Math.hypot(pl.vu, pl.vv);
    if (mv.slide && !speeding && cur > 2.6 && Math.hypot(vu, vv) < cur * 0.6) {
      if (pl.sliding <= 0) {
        this.fx.dust(f.wx(pl.u, pl.v), f.wz(pl.u, pl.v), pl.vu * f.c + pl.vv * f.s, -pl.vu * f.s + pl.vv * f.c);
        this.audio.slide(p.mesh.position, Math.min(1, cur / 5));
      }
      pl.sliding = 0.3;
    } else if (pl.sliding > 0) pl.sliding -= dt;
    pl.vu += (vu - pl.vu) * k; pl.vv += (vv - pl.vv) * k;
    if (planted && Math.abs(pl.vu) + Math.abs(pl.vv) < 0.05) { pl.vu = 0; pl.vv = 0; }
    vu = pl.vu; vv = pl.vv;
    if (pl.burst > 0) pl.burst -= dt;
    const u0 = pl.u, v0 = pl.v;
    pl.u = clamp(pl.u + vu * dt, -7.4, 7.4);
    const vmin = this.mode === 'drill' && this.drill && this.drill.type === 'volley' ? 1.2 : 0.8;
    pl.v = side * clamp(side * (pl.v + vv * dt), vmin, 14.0);
    if (pl.u !== u0 + vu * dt) pl.vu = 0;
    if (pl.v !== v0 + vv * dt) pl.vv = 0;
    const moved = Math.hypot(vu, vv);
    pl.lastSpeed = moved;
    pl.setT = moved < 1.0 ? pl.setT + dt : 0;
    if (pl.tracking) pl.moved += moved * dt;
    const x = f.wx(pl.u, pl.v), z = f.wz(pl.u, pl.v);
    p.body.position.x = x; p.body.position.z = z;
    p.body.position.y = f.y0 + SIZES.playerRadius * SIZES.playerScale;
    p.body.velocity.set(0, 0, 0);
    p.mesh.position.set(x, SURF, z);
    // Face the net while playing (serve: the target box)
    const yaw = this.phase === 'serve' && this.srv.who === 0 ? this.srv.yaw : pl.yaw;
    let dy = yaw - p.mesh.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    p.mesh.rotation.y += dy * Math.min(1, dt * 14);
    // A split step gives way as soon as you run
    const os = ch.anim.oneShot;
    if (os && os.entry.name === 'split_step' && moved > 1.5) ch.stop(0.12);

    // Stamina: running costs, standing recovers (a lot between points)
    const st = g.profile ? g.profile.getTennisStats().stamina : 30;
    const drain = (moved / 6) * 0.02 * (1.55 - st / 100);
    const rec = this.fl.active && !this.fl.resolved ? 0.012 : 0.07;
    pl.stamina = clamp(pl.stamina - drain * dt + (moved < 0.5 ? rec * dt : 0), 0, 1);

    // Animation: shuffle sideways, run, or the ready stance
    const busy = !!ch.anim.oneShot;
    const ms = SIZES.playerScale;
    if (moved > 0.3) {
      const lat = Math.abs(vu) > Math.abs(vv) * 1.2 && moved < 4.8;
      if (!busy) {
        if (lat) {
          // vu in court u; the player's own left is -side in u
          const leftward = (vu * side) < 0;
          this._playerClip(leftward ? 'shuffle_left' : 'shuffle_right', clamp(moved / ms / 0.6, 0.6, 2.4));
        } else {
          this._playerClip('run');
          const run = THREE.MathUtils.smoothstep(moved, 1.8, 3.4);
          ch.setLocomotion(1, Math.min(2.6, (moved / ms) / (1.45 + 0.95 * run)), run);
        }
      }
    } else if (!busy) {
      if (pl.clip !== 'ready') this._playerClip('ready');
      ch.setLocomotion(0);
    }
    ch.updateEvery = 1;
    ch.update(dt);
    p._blobs.set(p._blobSlot, x, z, 0.85, 0.85, 0, SURF + 0.02);
  }

  _playerClip(name, timeScale = 1) {
    const ch = this.game.player.character, pl = this.pl;
    if (name === 'run') {
      if (pl.clip !== 'run') ch.stop(0.18);
    } else if (pl.clip !== name) {
      ch.play(name, { fade: 0.18, timeScale });
    } else if (timeScale !== 1) {
      const e = ch.anim._entries && ch.anim._entries.get(name);
      if (e) e.action.timeScale = timeScale;
    }
    pl.clip = name;
  }

  // ─────────────────────────── input → strokes ───────────────────────────

  /** A live ball is on its way to the player: a stroke can be charged. */
  _incoming() {
    const fl = this.fl;
    return this.phase === 'rally' && fl.active && !fl.resolved && fl.receiver === 0 && !this.pl.swung && fl.kind !== 'toss';
  }

  _onSwingDown() {
    if (!this.active) return;
    const ph = this.phase, s = this.srv;
    if (ph === 'serve' && s.who === 0 && !s.started) {
      if (this.cam.busy) s.pending = true; // tossed as soon as the camera arrives, if still held
      else this._serveToss();
      return;
    }
    if (this._incoming()) { if (!this.chg.on) this._startCharge(); return; }
    // A practice swing between points (never mid-rally: it would plant your feet)
    if (this.t >= this.pl.swingFree && (ph === 'menu' || ph === 'feedWait' || ph === 'results')) {
      const ch = this.game.player.character;
      ch.play(this.ctl.shot === 2 ? 'backhand' : 'forehand', { fade: 0.08, startAt: SWING_CONTACT - LEAD });
      this.pl.swingFree = this.t + LEAD + 0.3;
      this.pl.clip = null;
    }
  }

  _onSwingUp() {
    const s = this.srv;
    if (this.phase === 'serve' && s.who === 0 && s.charging) { this._serveRelease(); return; }
    if (this.chg.on) this._release(false);
  }

  /** Hold time for a full-power stroke: slower when tired, quicker in the zone. */
  _chargeFull() {
    return CHARGE_FULL * (1.25 - 0.25 * this._fatigue()) * (this.momentum[0] > 0.6 ? 0.88 : 1);
  }

  /** SWING pressed with the ball coming: take the racket back (forehand, backhand or overhead). */
  _startCharge() {
    const c = this.chg, pl = this.pl, ch = this.game.player.character;
    this._aidT = 0;
    this._updateAids(true);
    c.on = true; c.t0 = this.t; c.power = 0;
    c.stroke = pl.idealSide;
    c.hold = HOLD_T[c.stroke];
    ch.play(STROKES[c.stroke], { fade: 0.12, startAt: 0.03 });
    pl.clip = null;
    this.stats.charges++;
  }

  /** Per frame while SWING is held: power, the held backswing pose, wing changes, auto-release. */
  _updateCharge() {
    const c = this.chg;
    if (!c.on) return;
    if (!this._incoming()) { this._cancelCharge(); return; }
    const t = this.t, pl = this.pl, ch = this.game.player.character;
    c.power = clamp((t - c.t0) / this._chargeFull(), 0, 1);
    // The ball moved to the other wing (or up high): switch the preparation early enough
    const want = pl.idealSide;
    if (want !== c.stroke && pl.tIdeal - t > 0.3 && pl.sideD[want] < pl.sideD[c.stroke] - 0.3) {
      c.stroke = want; c.hold = HOLD_T[want];
      ch.play(STROKES[want], { fade: 0.1, startAt: Math.min(c.hold, 0.12) });
      pl.clip = null;
    }
    this._holdPose(STROKES[c.stroke], c.hold);
    this.hud.setPower?.(c.power);
    if (this.opts.aim) this._showAim();
    // Held too long: the swing goes anyway (late — past the green window)
    const late = Math.max(0.06, this._gwEst + 0.012);
    if ((pl.tIdeal < INF && t >= pl.tIdeal - LEAD + late) || t - c.t0 > 3) this._release(true);
  }

  /** Freeze a one-shot clip at `hold` (racket back) while it is the current stroke. */
  _holdPose(clip, hold) {
    const an = this.game.player.character.anim;
    const e = an._entries && an._entries.get(clip);
    if (!e || !an.oneShot || an.oneShot.entry !== e) return;
    if (e.action.time >= hold) { e.action.time = hold; e.action.timeScale = 1e-4; }
  }

  /** After contact: let the stroke finish at a natural speed (the unwind may have been fast). */
  _followThrough(clip, ts) {
    const an = this.game.player.character.anim, e = an._entries && an._entries.get(clip);
    if (e && an.oneShot && an.oneShot.entry === e) e.action.timeScale = ts;
  }

  /** The game paused (menu, tab hidden): a held SWING must not fire as a release on resume. */
  onPause() {
    if (!this.active) return;
    this._cancelCharge();
    this._prevSwing = false;
    this._hudSwing = false;
    this.ctl.swing = false;
  }

  _cancelCharge() {
    const c = this.chg;
    if (!c.on) return;
    c.on = false; c.power = 0;
    const ch = this.game.player.character;
    if (ch.anim.oneShot) ch.stop(0.2);
    this.pl.clip = null;
    this.hud.setPower?.(-1);
    this.fx.hideAim();
  }

  _release(forced) {
    const c = this.chg;
    if (!c.on) return;
    c.on = false;
    this.hud.setPower?.(-1);
    this.fx.hideAim();
    this._playerSwing(c.power, c.stroke, forced);
  }

  /**
   * The stroke is released: the racket meets the ball LEAD seconds from now. Pick the stroke
   * (forehand, backhand, overhead, volleys) that best meets the ball from where you stand, read
   * the timing against its ideal contact (e = contact − ideal: − early, + late; green inside ±gw),
   * where the ball will meet the strings (a, b), how close to the top of its bounce (peak), and
   * schedule the contact (the ball flies from wherever it truly is then).
   */
  _playerSwing(power, pref, forced) {
    const g = this.game, p = g.player, ch = p.character, t = this.t, sw = this.swing, pl = this.pl, b = this.ball;
    const tc = t + LEAD;
    pl.swung = true;
    this.stats.swings++;
    p.mesh.rotation.y = pl.yaw;
    p.mesh.updateMatrixWorld(true);
    this._flightInfo();
    const pred = this.pred.from(b);
    let best = pref >= 0 && pref < N_STROKES ? pref : 0, bestS = INF, bestDc = INF;
    for (let ci = 0; ci < N_STROKES; ci++) {
      const Rv = _R[ci];
      ch.getContactPointWorld(STROKES[ci], Rv);
      const ic = this._idealFor(ci, Rv, pred, t, this._ic[ci]);
      const dc = this._reachAt(ci, Rv, pred, tc);
      if (!(ic.t < INF) && !(dc < INF)) continue;
      // The stroke that meets this ball best from here (the one being loaded if it is close)
      const score = Math.min(ic.d, 4) + Math.min(dc, 4) * 0.35 + (ci === pref ? -0.12 : 0) + STROKE_BIAS[ci];
      if (score < bestS) { bestS = score; best = ci; bestDc = dc; }
    }
    const ic = this._ic[best];
    const clip = STROKES[best];
    const tStar = ic.t < INF ? ic.t : tc;
    const e = tc - tStar;             // + late, − early
    sw.clip = clip; sw.stroke = best; sw.e = e; sw.tc = tc; sw.power = power; sw.forced = !!forced; sw.tStar = tStar;
    sw.dmin = ic.d;
    sw.moving = pl.lastSpeed; sw.set = pl.setT >= 0.22 && pl.lastSpeed < 1.2;
    sw.slide = pl.sliding > 0;   // clay: sliding into the ball (braking, not running)
    sw.onRun = sw.moving > 3.2 && best < 3 && !sw.slide;
    sw.run = pl.moved;
    // Unwind the held backswing so the racket arrives exactly at tc (or start the stroke late)
    const an = ch.anim, ent = an._entries && an._entries.get(clip), ct = CONTACT_T[best];
    const held = ent && an.oneShot && an.oneShot.entry === ent ? ent.action.time : -1;
    if (held >= 0 && held < ct - 0.03 && (ct - held) / LEAD <= MAX_UNWIND) {
      ent.action.timeScale = Math.max(0.5, (ct - held) / LEAD);
    } else {
      // A tap (the backswing barely started) or a change of stroke: start it late, not whippy
      const sa = Math.max(0, ct - MAX_UNWIND * LEAD);
      ch.play(clip, { fade: 0.06, startAt: sa, timeScale: (ct - sa) / LEAD });
    }
    pl.clip = null;
    pl.swingFree = tc + (best === 2 ? 0.4 : best >= 3 ? 0.2 : 0.28);
    pl.stamina = Math.max(0, pl.stamina - 0.006 - 0.01 * power);
    pl.aValid = false;
    this.hud.timing?.(-1);
    if (power > 0.45) this.audio.whoosh(power, LEAD - 0.02);

    // The ball at the contact
    const nb = pred.at(tc);
    const tot = b.bounced + nb;
    sw.volley = tot === 0;
    sw.hc = pred.y - SURF;
    sw.vin = Math.hypot(pred.vxr, pred.vyr, pred.vzr);
    // Half volley: picked up just after the bounce, down at the shoe laces
    sw.half = tot === 1 && best < 2 && pred.y - SURF < 0.42 && this._sinceBounce(tc) < 0.2;
    if (!(bestDc < REACH) || Math.abs(e) > E_WHIFF) {
      // Whiff: out of reach, or the swing long gone (or not yet there) when the ball comes
      sw.q = 0; sw.stretch = 1; sw.green = false; sw.perfect = false; sw.frame = false;
      sw.label = e < -E_WHIFF ? 'Too early' : e > E_WHIFF ? 'Too late' : 'Too far';
      this._miss = sw.label;
      this._verdict(sw.label, 'miss');
      this._coach('onSwing', sw);
      return;
    }
    // Where the ball meets the strings (across the swing: out along the racket, up / down)
    this._stringContact(best, pred, _R[best], sw);
    // How close to the top of its bounce: the strongest, most accurate strike is at the peak
    sw.peak = this._peakQuality(best, tot, pred.vyr);
    sw.gw = this._greenWidth(power, sw, SHOTS[this.ctl.shot] || 'topspin');
    sw.frame = Math.abs(sw.a) > 1 || Math.abs(sw.b) > 1;
    sw.green = Math.abs(e) <= sw.gw && !sw.frame;
    sw.perfect = sw.green && Math.abs(e) <= GREEN_PERFECT * sw.gw;
    sw.stretch = clamp((Math.max(Math.abs(sw.a), Math.abs(sw.b)) * STRING_REACH - 0.35) / 0.45, 0, 1);
    const sweet = sweetness(clamp(sw.a, -1, 1), clamp(sw.b, -1, 1));
    sw.q = sw.green ? clamp(0.78 + 0.22 * (1 - Math.abs(e) / sw.gw) * (0.5 + 0.5 * sweet), 0.72, 1)
      : clamp(0.7 - (Math.abs(e) - sw.gw) / 0.12, 0.1, 0.7);
    if (sw.half) sw.q *= 0.9;
    if (forced) sw.q *= 0.95;
    let kind;
    if (sw.frame) { sw.label = 'Frame!'; kind = 'miss'; }
    else if (sw.perfect) { sw.label = sw.half ? 'Half volley!' : power >= 0.92 ? 'Power shot!' : 'Perfect!'; kind = 'perfect'; this.stats.perfect++; }
    else if (sw.green) { sw.label = sw.stretch > 0.6 ? 'Stretch' : 'Good'; kind = 'good'; }
    else { sw.label = e < 0 ? 'Early' : 'Late'; kind = e < 0 ? 'early' : 'late'; }
    this._verdict(sw.label, kind);
    if (sw.perfect && !sw.half) {
      this._swingMomentum(0, 0.025);
      this._crowd('react', sw.label === 'Power shot!' ? 'powerShot' : 'perfect', 0);
    }
    this._coach('onSwing', sw);
    this.scheduleContact(0, tc, _R[best]);
  }

  /**
   * Where the ball will meet the strings (writes out.a / out.b, −1…+1 each, beyond = the frame),
   * from the ball–racket offset at the contact (pred: the ball then; Rv: the racket head). For a
   * groundstroke or volley, a = across the ball's path, out along the racket (+ toward the tip,
   * − jammed toward the throat), b = up / down beyond the strike zone (inside it the swing
   * adapts its height); the overhead reaches up (a along the vertical racket, b across it). The
   * along-the-path part of the offset is the timing (e), not the strings.
   */
  _stringContact(ci, pred, Rv, out) {
    const pm = this.game.player.mesh.position;
    const dx = pred.x - Rv.x, dz = pred.z - Rv.z;
    const hy = pred.y - SURF;
    if (ci === 2) {
      const ex = hy > OH_ZONE_TOP ? hy - OH_ZONE_TOP : hy < OH_ZONE_LO ? hy - OH_ZONE_LO : 0;
      const yaw = this.pl.yaw, rx = -Math.cos(yaw), rz = Math.sin(yaw);
      out.a = ex / STRING_REACH;
      out.b = (dx * rx + dz * rz) / STRING_REACH;
      return out;
    }
    // across the ball's path (horizontal), pointing from the body out to the racket head
    let vx = pred.vxr, vz = pred.vzr;
    const vl = Math.hypot(vx, vz);
    if (vl > 0.3) { vx /= vl; vz /= vl; } else { vx = 0; vz = 0; }
    let lx = -vz, lz = vx;
    if (vl <= 0.3) { lx = Rv.x - pm.x; lz = Rv.z - pm.z; const ll = Math.hypot(lx, lz) || 1; lx /= ll; lz /= ll; }
    if (lx * (Rv.x - pm.x) + lz * (Rv.z - pm.z) < 0) { lx = -lx; lz = -lz; }
    const lo = ci <= 1 ? ZONE_LO : VZONE_LO, hi = ci <= 1 ? ZONE_TOP : VZONE_TOP;
    const ex = hy > hi ? hy - hi : hy < lo ? hy - lo : 0;
    out.a = (dx * lx + dz * lz) / STRING_REACH;
    out.b = ex / STRING_REACH;
    return out;
  }

  /**
   * How close to the top of its bounce the ball is met (1 = at the peak, 0 = on the rise just
   * after the bounce, or dropping fast): 1 − |vy| / (its rebound's vy). Volleys and overheads
   * have no bounce to read (1); a half volley is the hardest (≈ 0).
   */
  _peakQuality(ci, tot, vy) {
    if (tot !== 1 || ci >= 2) return 1;
    return clamp(1 - Math.abs(vy) / Math.max(2, this._reboundVy), 0, 1);
  }

  /**
   * The green window's half-width (s) for a stroke released with load `power` (the spec's
   * (0.042 + 0.028·control)·(1.18 − 0.38·power): control widens it, a full load narrows it),
   * narrower when tired, on a big point you face, on the run or against a hard ball (fast, high,
   * skidding low; a drop shot from far back), wider with set feet, a slide into it (clay) or in
   * the zone. ctx: { onRun, set, slide, run (m run for this ball), hc (contact height), vin
   * (incoming speed at contact), volley }.
   */
  _greenWidth(power, ctx, label) {
    const st = this._stats();
    let gw = (0.042 + 0.028 * st.control / 100) * (1.18 - 0.38 * clamp(power, 0, 1));
    gw *= 0.85 + 0.15 * this._fatigue();
    if (this.momentum[0] >= 0.7) gw *= 1.06;
    const pr = this.score && this.mode === 'match' ? this.score.pressure() : null;
    if (pr && pr.kind !== 'game' && pr.for === 1) gw *= 0.9;
    if (ctx.onRun) gw *= 0.82;
    else if (ctx.set || ctx.slide) gw *= 1.04;
    // A long run to get there (off balance) and a hard ball to handle: fast, high above the
    // shoulders, or skidding low for a drive
    const run = Number.isFinite(ctx.run) ? ctx.run : 0;
    if (run > 2) gw /= 1 + 0.09 * (run - 2);
    const hc = Number.isFinite(ctx.hc) ? ctx.hc : 1, vin = Number.isFinite(ctx.vin) ? ctx.vin : 14;
    let d = clamp((vin - (ctx.volley ? 14 : 8)) / 6, 0, 1) + clamp((hc - 1.35) / 1.2, 0, 0.4) * (label === 'topspin' ? 0.4 : 1);
    if (hc < 0.45 && !ctx.volley && (label === 'flat' || label === 'topspin')) d += 0.25;
    gw /= 1 + 0.5 * d;
    if (label === 'drop') gw *= 1 - 0.3 * clamp((this.pl.v * this.sides[0] - 6) / 7, 0, 1);
    return gw;
  }

  /**
   * May the overhead be used on this ball? Out of the air, on a lob, or from inside the court —
   * a high-kicking ball at the baseline is taken with a high forehand / backhand instead.
   */
  _ohOk(totBounces) {
    if (totBounces === 0 || this.fl.shot === 'lob') return true;
    return this.pl.v * this.sides[0] < 8.5;
  }

  /** Can stroke `ci` take a ball that has bounced `tot` times (since the last hit)? */
  _strokeOk(ci, tot) {
    if (ci === 2) return this._ohOk(tot);
    if (ci >= 3) return tot === 0;   // volleys only out of the air
    return tot === 1;                // groundstrokes after the bounce
  }

  /** Seconds between the ball's last bounce before tc and tc (Infinity if it has not bounced). */
  _sinceBounce(tc) {
    const b = this.ball;
    let tb = -INF;
    for (let k = 0; k < 4; k++) { const tk = b.bounceTime(k); if (tk <= tc) tb = tk; else break; }
    return tb > -INF ? tc - tb : INF;
  }

  /**
   * The incoming flight's bounce read (once per flight): the peak after its first bounce — the
   * ideal groundstroke contact (or, for a bounce above the strike zone, the moment it comes back
   * down to the top of the zone) — and the rebound's upward speed (the peak-quality scale).
   */
  _flightInfo() {
    const b = this.ball, F = b.flight;
    if (this._fiSerial === b.serial) return;
    this._fiSerial = b.serial;
    this._peakT = INF; this._reboundVy = 2;
    const tb0 = b.bounceTime(0);
    if (!(tb0 < INF)) return;
    const o = b.stateAt(tb0 + 0.004, this._qs);
    this._reboundVy = Math.max(0.5, o.vy);
    const ap = F.apex(0);
    if (!ap) return;
    if (ap.y - SURF <= ZONE_TOP) this._peakT = ap.t;
    else {
      const tz = F.crossHeight(SURF + ZONE_TOP, ap.t, Math.min(b.bounceTime(1), F.tEnd), true);
      this._peakT = tz < INF ? tz : ap.t;
    }
  }

  /**
   * The ideal contact for stroke ci on the incoming flight with the racket where it is now (Rv:
   * the racket head at the clip's contact, world): out.t (Infinity when this stroke cannot take
   * the ball), out.d (the ball–racket distance then: the strike zone's height is free), out.x/y/z
   * (the ball then). Groundstrokes: the peak of the bounce, eased toward the moment the ball comes
   * closest when you are not where the peak is (min distance² + PEAK_W·(t − peak)²); volleys:
   * the closest approach out of the air; the overhead: the closest approach of a high ball.
   */
  _idealFor(ci, Rv, pred, t0, out) {
    const b = this.ball, F = b.flight;
    out.t = INF; out.d = INF;
    if (!F.valid || !b.active) return out;
    const tb0 = b.bounceTime(0), tb1 = b.bounceTime(1);
    const tEnd = Math.min(b.tLive, F.tEnd);
    let ta, tz;
    if (ci <= 1) { if (!(tb0 < INF)) return out; ta = Math.max(t0 + 0.02, tb0 + 0.01); tz = Math.min(tb1, tEnd); }
    else if (ci >= 3) { ta = t0 + 0.02; tz = Math.min(tb0, tEnd); }
    else { ta = t0 + 0.02; tz = Math.min(this._ohOk(1) ? tb1 : tb0, tEnd); }
    tz = Math.min(tz, t0 + 3.6) - 0.004;
    if (!(tz > ta)) return out;
    const n = Math.max(1, Math.min(180, Math.ceil((tz - ta) / 0.02)));
    const step = (tz - ta) / n;
    let bi = -1, bc = INF, cPrev = INF, cL = INF, cR = INF;
    for (let i = 0; i <= n; i++) {
      const c = this._cost(ci, Rv, pred, ta + i * step);
      if (c < bc) { bc = c; bi = i; cL = cPrev; cR = INF; } else if (i === bi + 1) cR = c;
      cPrev = c;
    }
    if (bi < 0 || !(bc < INF)) return out;
    let tt = ta + bi * step;
    // (a parabola through the neighbours: the minimum between the samples)
    if (cL < INF && cR < INF) {
      const den = cL - 2 * bc + cR;
      if (den > 1e-9) tt += clamp(0.5 * step * (cL - cR) / den, -step, step);
    }
    if (!(this._cost(ci, Rv, pred, tt) < INF)) { tt = ta + bi * step; this._cost(ci, Rv, pred, tt); }
    out.t = tt; out.d = this._cd; out.x = pred.x; out.y = pred.y; out.z = pred.z;
    return out;
  }

  /**
   * Cost of meeting the ball at time tt with stroke ci (racket head at Rv): the ball–racket
   * distance² (the strike zone's height free), plus PEAK_W·(tt − peak)² for groundstrokes.
   * Leaves the distance in this._cd and the ball in pred. Infinity if the ball is not playable.
   */
  _cost(ci, Rv, pred, tt) {
    pred.at(tt);
    if (this.frame.lv(pred.x, pred.z) * this.sides[0] < 0.3) { this._cd = INF; return INF; }   // not over the net yet
    const hy = pred.y - SURF;
    let lo, hi, cap;
    if (ci <= 1) { lo = ZONE_LO; hi = ZONE_TOP; cap = ZONE_TOP + 0.6; }
    else if (ci >= 3) { lo = VZONE_LO; hi = VZONE_TOP; cap = VZONE_TOP + 0.5; }
    else {
      lo = OH_ZONE_LO; hi = OH_ZONE_TOP; cap = OH_ZONE_TOP + 0.6;
      if (hy < OH_MIN_H - 0.15) { this._cd = INF; return INF; }
    }
    if (hy > cap) { this._cd = INF; return INF; }
    const dx = pred.x - Rv.x, dz = pred.z - Rv.z;
    const ex = hy > hi ? hy - hi : hy < lo ? lo - hy : 0;
    const d2 = dx * dx + dz * dz + ex * ex;
    this._cd = Math.sqrt(d2);
    const tp = ci <= 1 && this._peakT < INF ? tt - this._peakT : 0;
    return d2 + PEAK_W * tp * tp;
  }

  /**
   * How far the racket is from the ball at time tc for stroke ci, across the ball's path (the
   * part along it is the timing, e): Infinity if that stroke cannot take the ball then.
   */
  _reachAt(ci, Rv, pred, tc) {
    const b = this.ball;
    if (tc >= b.tLive) return INF;
    const nb = pred.at(tc), tot = b.bounced + nb;
    if (tot >= 2 || !this._strokeOk(ci, tot)) return INF;
    if (!(this._cost(ci, Rv, pred, tc) < INF)) return INF;
    const dx = pred.x - Rv.x, dz = pred.z - Rv.z;
    const hs = Math.hypot(pred.vxr, pred.vzr);
    const along = hs > 0.5 ? (dx * pred.vxr + dz * pred.vzr) / hs : 0;
    return Math.sqrt(Math.max(0, this._cd * this._cd - along * along));
  }

  // ─────────────────────────── ball / flights ───────────────────────────

  /**
   * A racket will meet the ball at (tc, pt): the contact is taken at the true ball then (the
   * shot leaves from it); the drawn ball eases onto the strings on the way (TennisBallSim.reachTo).
   */
  scheduleContact(by, tc, pt) {
    const fl = this.fl;
    if (fl.resolved || !fl.active) return;
    fl.contactBy = by; fl.tContact = tc; fl.cpt.copy(pt);
    this.ball.reachTo(tc, pt.x, pt.y, pt.z);
  }

  /** Toss (serve) or feed: the ball from the hand to the hitter's contact point in tau seconds. */
  launchToss(who, from, tau, clip) {
    const b = this.ball, fl = this.fl, t = this.t;
    const ch = who === 0 ? this.game.player.character : this.coachNpc.character;
    (who === 0 ? this.game.player.mesh : this.coachNpc.mesh).updateMatrixWorld(true);
    ch.getContactPointWorld(clip, _v2);
    this._flyTo(t, from, _v2, tau);
    b.spin = 'feed';
    fl.active = true; fl.kind = 'toss'; fl.hitter = who; fl.receiver = who; fl.resolved = false;
    fl.bounces = 0; fl.let = false; fl.netted = false; fl.evI = 0; fl.tLaunch = t;
    fl.contactBy = who; fl.tContact = t + tau; fl.cpt.copy(_v2);
    fl.tGround = b.bounceTime(0);
    fl.tossClip = clip;
    b.reachTo(t + tau, _v2.x, _v2.y, _v2.z);
  }

  /**
   * A hand launch (a toss, a feed's toss): a lift-free flight from `from` that passes `to` at
   * t + T (drag and the wind allowed for: the launch is corrected until it does, to a millimetre).
   */
  _flyTo(t, from, to, T) {
    const b = this.ball, o = this._qs;
    this._env.wind = this.wind;
    let vx = (to.x - from.x) / T, vy = (to.y - from.y + 0.5 * G * T * T) / T, vz = (to.z - from.z) / T;
    for (let i = 0; i < 4; i++) {
      b.fly(t, from.x, from.y, from.z, vx, vy, vz, 0, 0, 0, this._env, TOSS_OPTS);
      b.stateAt(t + T, o);
      const ex = to.x - o.x, ey = to.y - o.y, ez = to.z - o.z;
      if (ex * ex + ey * ey + ez * ez < 1e-6) break;
      vx += ex / T; vy += ey / T; vz += ez / T;
    }
  }

  /**
   * The ball leaves a racket: make the shot (ShotMaker: plan → racket–ball impact inverse →
   * execution → impact forward) from the true ball at the contact (st, at time tc) and fly it
   * for real. The hitter plans with the part of the wind he allows for; the flight takes the real
   * wind. `guarantee`: a green stroke aimed inside the lines lands in — if the real flight misses
   * anyway (the wind he did not allow for, a spin the strings could not give), the stroke adapts:
   * the aim moves off by the miss (or clears the net higher) and it is made again; the last resort
   * flies the plan itself (the planner lands on its target through the same integrator).
   * Returns the ShotMaker result (res.n: the face at contact).
   */
  _makeAndFly(hitter, kind, label, tc, st, intent, exec, guarantee) {
    const b = this.ball, res = this._res, env = this._planEnv;
    env.wind = this._windAllowed(hitter);
    this._env.wind = this.wind;
    const prof = intent.profile;
    for (let k = 0; k < 6; k++) {
      if (k < 5) makeShot(res, st, intent, exec, env);
      else {
        const o = this._popts, tg = this._tgt;
        o.speed = intent.speed || 0; o.pace = intent.pace || 0; o.margin = intent.margin; o.minT = intent.minT || 0;
        tg.x = intent.tx; tg.z = intent.tz;
        const P = planShot(this._pln, st, tg, prof, o, env);
        res.vx = P.vx; res.vy = P.vy; res.vz = P.vz; res.wx = P.wx; res.wy = P.wy; res.wz = P.wz;
      }
      b.fly(tc, st.x, st.y, st.z, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, this._env);
      if (!guarantee || !this._greenMiss(kind, hitter, intent)) break;
      // (a spin the strings could not give: ask for less)
      if (k >= 2 && !res.ok) { prof.top *= 0.5; prof.side *= 0.5; prof.gyro *= 0.5; }
    }
    return res;
  }

  /**
   * Did the flight just launched miss (for a stroke that must land in)? If so, move the aim off
   * by the miss (or raise the net margin) in `intent` and return true.
   */
  _greenMiss(kind, hitter, intent) {
    const F = this.ball.flight, f = this.frame;
    const nc = F.netCross();
    if (nc && nc.type !== 'cross') { intent.margin += 0.3; return true; }
    let bn = null;
    for (let i = 0; i < F.nEvents; i++) {
      const e = F.events[i];
      if (e.type === 'bounce') { bn = e; break; }
      if (e.type === 'fence' || e.type === 'stands') break;
    }
    if (bn) {
      const u = f.lu(bn.x, bn.z), v = f.lv(bn.x, bn.z);
      if (this._isIn(u, v, kind, hitter) && this._lineMargin(u, v, kind, hitter) > 0.03) return false;
      intent.tx += (intent.tx - bn.x) * 1.15;
      intent.tz += (intent.tz - bn.z) * 1.15;
      return true;
    }
    // flew out on the full over the wall: aim a metre shorter
    const dx = intent.tx - F.s[1], dz = intent.tz - F.s[3], d = Math.hypot(dx, dz) || 1;
    intent.tx -= dx / d; intent.tz -= dz / d;
    return true;
  }

  /**
   * The flight just launched (_makeAndFly) is now the ball in play: who hit it and from where,
   * what it will do (_readFlight), the rally count, the receiver's reaction.
   */
  _launchBook(hitter, kind, label, tc, st) {
    const b = this.ball, fl = this.fl, f = this.frame;
    b.spin = label;
    fl.active = true; fl.kind = kind; fl.hitter = hitter; fl.receiver = 1 - hitter; fl.resolved = false;
    fl.bounces = 0; fl.let = false; fl.contactBy = -1; fl.tContact = INF; fl.shot = label;
    fl.touchedByReceiver = false; fl.evI = 0; fl.tLaunch = tc;
    // Where both players were at the contact (the coach reads each landing against them)
    const npc = this.coachNpc;
    const ru = npc ? f.lu(npc.body.position.x, npc.body.position.z) : 0, rv = npc ? f.lv(npc.body.position.x, npc.body.position.z) : 0;
    fl.fromU = hitter === 0 ? this.pl.u : ru; fl.fromV = hitter === 0 ? this.pl.v : rv;
    fl.oppU = hitter === 0 ? ru : this.pl.u; fl.oppV = hitter === 0 ? rv : this.pl.v;
    this._readFlight(st.x, st.z, tc);
    if (kind !== 'toss') {
      this.rallyShots++;
      if (this.mode === 'match') this.hud.setRally(this.rallyShots);
    }
    this._onFlight();
  }

  /**
   * Read the ball's current (just launched) flight: its net crossing (and how high), its first
   * bounce (the landing), in or out, its average pace to the bounce. From (cx, cz) at tc.
   */
  _readFlight(cx, cz, tc) {
    const f = this.frame, b = this.ball, fl = this.fl, F = b.flight;
    const nc = F.netCross();
    fl.netU = nc ? nc.u : 0;
    fl.netH = nc ? nc.h : INF;
    fl.netted = !!nc && nc.type === 'net';
    let bn = null, wall = null;
    for (let i = 0; i < F.nEvents; i++) {
      const e = F.events[i];
      if (e.type === 'bounce') { bn = e; break; }
      if (e.type === 'fence' || e.type === 'stands') { wall = e; break; }
    }
    fl.tGround = bn ? bn.t : INF;
    const land = bn || wall;
    if (land) { fl.landX = land.x; fl.landZ = land.z; } else { fl.landX = cx; fl.landZ = cz; }
    fl.willBeIn = !fl.netted && !!bn && this._isIn(f.lu(bn.x, bn.z), f.lv(bn.x, bn.z), fl.kind, fl.hitter);
    fl.pace = bn ? Math.hypot(bn.x - cx, bn.z - cz) / Math.max(0.05, bn.t - tc) : 10;
  }

  /** The wind a hitter allows for when aiming (you roughly, Rafa by his level): the planner's wind. */
  _windAllowed(hitter) {
    const w = this.wind;
    if (!w || (!w.x && !w.z)) return null;
    const k = hitter === 0 ? 0.55 : (this.ai.diff.wind ?? 0.7);
    const o = this._windA;
    o.x = w.x * k; o.z = w.z * k;
    return o;
  }

  /**
   * Signed distance (m) from the first bounce at (u, v) to the edge of the zone it had to land
   * in: + inside by that much, − outside (the same zone and line tolerance as _isIn).
   */
  _lineMargin(u, v, kind, hitter) {
    const rs = this.sides[1 - hitter];
    const vv = v * rs;
    let m = vv + LINE_TOL;                                    // (the net side: never a close call)
    if (kind === 'serve') {
      const sgn = this.srv.deuce ? rs : -rs;
      const uu = u * sgn;
      m = Math.min(uu + LINE_TOL, SINGLES_W + LINE_TOL - uu, SERVICE_L + LINE_TOL - vv);
    } else m = Math.min(SINGLES_W + LINE_TOL - Math.abs(u), HALF_L + LINE_TOL - vv);
    return m;
  }

  /** A first bounce within a hand's width of a line: call it (the clay mark shows it too). */
  _closeCall(u, v) {
    const fl = this.fl;
    if (fl.kind === 'toss' || (this.mode === 'drill' && fl.hitter === 1)) return;
    const m = this._lineMargin(u, v, fl.kind, fl.hitter);
    if (Math.abs(m) > 0.09) return;
    const cm = Math.max(1, Math.round(Math.abs(m) * 100));
    const clay = this.ball.surface.key === 'clay';
    if (m >= 0) this.hud.pop(cm <= 2 ? (clay ? 'Mark on the line!' : 'On the line!') : `Just in · ${cm} cm`, 'call');
    else this.hud.pop(clay ? `Mark: out by ${cm} cm` : `Out by ${cm} cm`, 'call');
    this._crowd('react', m >= 0 ? 'closeIn' : 'closeOut', fl.hitter);
  }

  /** In / out for the first bounce of a shot from `hitter` (serve: the service box). */
  _isIn(u, v, kind, hitter) {
    const rs = this.sides[1 - hitter];
    const vv = v * rs;
    if (vv < -LINE_TOL) return false;
    if (kind === 'serve') {
      const sgn = this.srv.deuce ? rs : -rs;
      const uu = u * sgn;
      return uu >= -LINE_TOL && uu <= SINGLES_W + LINE_TOL && vv <= SERVICE_L + LINE_TOL;
    }
    return Math.abs(u) <= SINGLES_W + LINE_TOL && vv <= HALF_L + LINE_TOL;
  }

  /** New flight in the air: the receiver reacts (AI plan / player assist + landing marker). */
  _onFlight(netCord = false) {
    const fl = this.fl;
    if (fl.receiver === 1) {
      if (this.mode === 'match' || this._rallyDrill()) this.ai.onIncoming(this.t, fl.willBeIn);
      this.fx.hideMarker();
      this.pl.aValid = false;
      // After your shot: drift back to the middle
      const side = this.sides[0];
      if (!(this.mode === 'drill' && this.drill.type === 'volley')) {
        this.pl.ax = clamp(this.pl.u * 0.35, -1.5, 1.5); this.pl.az = side * BASE_V; this.pl.aValid = this.mode === 'match' || this._rallyDrill(); this.pl.aFrom = this.t + 0.3;
      }
    } else {
      const pl = this.pl;
      pl.swung = false;
      pl.moved = 0; pl.tracking = true;
      this._planAssist();
      pl.aFrom = this.t + 0.22; // the assist "reads" the ball after a reaction time
      if (this.opts.marker && !fl.netted && fl.tGround < INF) this.fx.showMarker(fl.landX, SURF, fl.landZ, fl.willBeIn);
      // Split step as Rafa strikes: a quicker first step if you were on your toes
      if (!netCord && pl.lastSpeed < 1.5 && !this.chg.on && this.phase === 'rally') {
        const ch = this.game.player.character;
        if (!ch.anim.oneShot) { ch.play('split_step', { fade: 0.08, timeScale: 1.5 }); pl.clip = null; }
        pl.burst = 0.45;
      }
      // Still holding SWING from before: the charge starts now
      if (this.ctl.swing && !this.chg.on && this._incoming()) this._startCharge();
    }
  }

  /**
   * Where should the player stand to meet the incoming ball? (the auto-move target): for a
   * groundstroke, where the racket meets the ball at the peak of its bounce — if you can get
   * there in time (else the reachable moment nearest it); at the net, a volley or the overhead
   * early and close. Sets pl.ax / pl.az (court-local), pl.tIdeal, pl.idealSide.
   */
  _planAssist() {
    const pl = this.pl, f = this.frame, t = this.t, b = this.ball, F = b.flight;
    this._flightInfo();
    const pred = this.pred2.from(b);
    const sc = SIZES.playerScale;
    const yaw = pl.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const side = this.sides[0];
    const cps = this._cps || (this._cps = STROKES.map(n => getClipEventRacketPoint(n)));
    const px = f.wx(pl.u, pl.v), pz = f.wz(pl.u, pl.v);
    const run = this._speed() * 0.85;
    const volleyZone = pl.v * side < 7.5;
    const tPk = this._peakT;
    const tEnd = Math.min(b.tLive, F.tEnd, t + 3.2);
    let best = INF;
    pl.aValid = false;
    // i = −1: exactly the peak; then the flight every 0.02 s
    for (let i = -1; ; i++) {
      const tt = i < 0 ? tPk : t + 0.15 + i * 0.02;
      if (i >= 0 && tt >= tEnd) break;
      if (i < 0 && !(tt > t + 0.1 && tt < tEnd)) continue;
      const nb = pred.at(tt);
      const tot = b.bounced + nb;
      if (tot >= 2) { if (i >= 0) break; continue; }
      if (tot === 0 && !volleyZone) continue;
      if (f.lv(pred.x, pred.z) * side < 0.8) continue; // not over the net yet
      const hy = pred.y - SURF;
      for (let ci = 0; ci < N_STROKES; ci++) {
        const cp = cps[ci];
        if (!cp || !this._strokeOk(ci, tot)) continue;
        if (ci <= 1 ? (hy > ZONE_TOP + 0.3 || hy < 0.12) : ci >= 3 ? (hy > VZONE_TOP || hy < VZONE_LO) : hy < OH_MIN_H) continue;
        const ox = (cp.x * cy + cp.z * sy) * sc, oz = (-cp.x * sy + cp.z * cy) * sc;
        const sx = pred.x - ox, sz = pred.z - oz;
        const su = f.lu(sx, sz), sv = f.lv(sx, sz) * side;
        if (sv < 0.9 || sv > 14 || Math.abs(su) > 7.4) continue;
        const dist = Math.hypot(sx - px, sz - pz);
        const late = dist / run - (tt - t - 0.22);   // > 0: no time to get there
        let score = ci <= 1
          ? (tPk < INF ? (tt - tPk) * (tt - tPk) * 40 : 0) + dist * 0.35   // groundstrokes: the peak
          : dist * 0.6 + (tt - t) * 0.25 + (ci >= 3 ? 0.2 : 0);            // volleys / the overhead: early, close
        if (late > 0) score += 20 + late * 10;
        score += STROKE_BIAS[ci] + (ci === 1 ? 0.1 : 0);
        if (score < best) {
          best = score;
          pl.ax = su; pl.az = sv * side; pl.aValid = true;
          pl.tIdeal = tt; pl.idealSide = ci;
        }
      }
    }
  }

  /**
   * Walk the current flight's events (bounces, the net, the back wall, the stands) as the
   * session clock passes them — a racket contact first ends the flight (the next one is
   * launched from the true ball) — then draw the ball.
   */
  _updateBall(dt) {
    const b = this.ball, fl = this.fl, t = this.t;
    if (!b.active || !fl.active) { if (b.shown) b.sync(false); this.fx.trailUpdate(false); return; }
    for (let guard = 0; guard < 32; guard++) {
      const F = b.flight;
      const ev = fl.evI < F.nEvents ? F.events[fl.evI] : null;
      const te = ev ? ev.t : INF;
      if (fl.tContact <= te && t >= fl.tContact) {
        this._evContact(fl.tContact);
        if (!fl.active || !b.active) break;
        continue;
      }
      if (!ev || t < te) break;
      fl.evI++;
      this._onEvent(ev);
      if (!fl.active || !b.active) break;
    }
    if (!b.active || !fl.active) { if (b.shown) b.sync(false); this.fx.trailUpdate(false); return; }
    b.at(t);
    b.updateDraw(t);
    if (!b.rolling && this.opts.trail) {
      const v = b.vel, hs = Math.hypot(v.x, v.z) || 1;
      const dp = b.drawPos;
      this.fx.trailUpdate(true, dp.x, dp.y, dp.z, b.mesh.scale.x, (b.w.x * v.z - b.w.z * v.x) / hs);
    } else this.fx.trailUpdate(false);
    b.sync(true);
    b.turn(dt);
  }

  /** One event of the current flight. */
  _onEvent(ev) {
    switch (ev.type) {
      case 'bounce': this._evBounce(ev); break;
      case 'net': this._evNet(ev); break;
      case 'netcord': this._evNetCord(ev); break;
      case 'fence': this._evWall(ev, false); break;
      case 'stands': this._evWall(ev, true); break;
      default: break;   // 'cross' (a clean net crossing), 'rest'
    }
  }

  /** A racket meets the ball (the true ball at tc): the hitter's shot flies from there. */
  _evContact(tc) {
    const fl = this.fl, b = this.ball;
    const who = fl.contactBy;
    fl.tContact = INF; fl.contactBy = -1;
    const st = b.stateAt(tc, this._cs);
    b.at(tc);                    // (the true contact point: the tactics read ball.pos)
    b.releaseOffset(tc);
    this.audio.hit(b.pos, fl.kind === 'toss' && this.phase === 'serve' ? 1.1 : 0.9);
    if (fl.kind === 'toss') {
      if (this.phase === 'serve' && this.srv.who === who) {
        if (who === 0) this._followThrough('serve', 1);
        this._serveShot(who, tc, st);
      } else this._feedShot(tc, st);
      return;
    }
    if (fl.resolved) return;     // (the point ended meanwhile: the ball flies on)
    if (who === fl.receiver) fl.touchedByReceiver = true;
    if (who === 0) {
      // Follow through at a natural pace (faster after a big swing)
      this._followThrough(this.swing.clip, Math.min(1.3, 0.9 + 0.4 * this.swing.power));
      this._playerShot(tc, st);
    } else this._aiShot(tc, st);
  }

  /** The ball hits the net (it drops on the hitter's side): a fault, or the point to the other side. */
  _evNet(ev) {
    const fl = this.fl;
    _v1.set(ev.x, ev.y, ev.z);
    this.audio.net(_v1);
    this._cancelContact();
    if (fl.resolved || fl.kind === 'toss') return;
    if (fl.kind === 'serve') this._fault('net');
    else this._resolve(1 - fl.hitter, 'net');
  }

  /** The ball clips the tape and trickles over (a serve that does it and lands in is a let). */
  _evNetCord(ev) {
    const fl = this.fl;
    _v1.set(ev.x, ev.y, ev.z);
    this.audio.net(_v1);
    if (fl.resolved || fl.kind === 'toss') return;
    if (fl.kind === 'serve') fl.let = true;
    this.hud.pop('Net cord!', 'call');
    this._onFlight(true);   // the receiver reads it again
  }

  /**
   * A bounce. The first one decides the shot (in / out, a let, a close call, the drill target),
   * a second one in the court ends the point (a winner, or an ace off a serve); every bounce
   * sounds like its court and marks the clay.
   */
  _evBounce(ev) {
    const fl = this.fl, b = this.ball, f = this.frame;
    b.bounced = ev.k + 1;
    _v1.set(ev.x, ev.y, ev.z);
    this.audio.bounce(_v1, this.surface);
    if (fl.kind === 'toss') return;
    if (b.surface.key === 'clay') this.fx.mark(ev.x, ev.z, ev.vx, ev.vz);
    const u = f.lu(ev.x, ev.z), v = f.lv(ev.x, ev.z);
    if (ev.k === 0 && !fl.netted) this._ballLanded(u, v);
    if (fl.resolved) return;
    if (ev.k === 0) {
      const onReceiverSide = v * this.sides[fl.receiver] > 0;
      if (onReceiverSide) this._closeCall(u, v);
      if (!onReceiverSide || !this._isIn(u, v, fl.kind, fl.hitter)) {
        if (fl.kind === 'serve') this._fault('out');
        else this._resolve(fl.receiver, 'out');
        return;
      }
      fl.bounces = 1;
      this.fx.hideMarker();
      const pt = this._pt;
      if (fl.kind === 'serve' && !fl.let) {
        const au = Math.abs(u);
        pt.serveTarget = au < 1.25 ? 'T' : au > 3.3 ? 'wide' : 'body';
      } else if (this.rallyShots === 2 && fl.kind === 'rally') pt.returnDepth = Math.abs(v);
      if (fl.kind === 'serve' && fl.let && this.mode === 'match') { // (a drill serve that clips the tape and lands in simply counts)
        // A let is replayed: that serve does not count (first-serve % / the coach)
        if (fl.hitter === 0) { this.stats.serves--; if (!this.srv.second) this.stats.firsts--; }
        this._resolve(-1, 'let');
      } else if (this.mode === 'drill' && fl.hitter === 0) { this._coach('onLanded', { kind: fl.kind, result: 'in', spin: fl.shot, power: fl.power || 0, q: fl.q }); this._drillLanded(u, v); }
      else if (fl.kind === 'serve' && fl.hitter === 0) { this.stats.serveIn++; if (!this.srv.second) this.stats.firstIn++; this._xp('serve', this.srv.second ? 0.4 : 0.6); }
      else if (fl.hitter === 0) { this._xp('control', 0.5); if (fl.shot === 'topspin' || fl.shot === 'slice') this._xp('spin', 0.3); }
      if (fl.hitter === 0 && this.mode === 'match' && !(fl.kind === 'serve' && fl.let)) this._coach('onLanded', { kind: fl.kind, result: 'in', spin: fl.kind === 'serve' ? this.srv.spin : fl.shot, power: fl.kind === 'serve' ? this.srv.power : fl.power || 0, q: fl.kind === 'serve' ? this.srv.q : fl.q, second: this.srv.second });
    } else if (fl.bounces >= 1) {
      // Second bounce: the receiver never got it back
      this._resolve(fl.hitter, fl.kind === 'serve' && !fl.touchedByReceiver ? 'ace' : 'winner');
    }
  }

  /**
   * Every first bounce of a shot that crossed the net (both players): the coach's landing read —
   * where it landed, from where, and where the other player stood (court-local; a player's own
   * half has v·sides[p] > 0). The info object is reused: copy what you keep.
   */
  _ballLanded(u, v) {
    const fl = this.fl, L = this._landed;
    L.hitter = fl.hitter; L.u = u; L.v = v; L.kind = fl.kind; L.shot = fl.shot;
    L.inPlay = v * this.sides[fl.receiver] > 0 && this._isIn(u, v, fl.kind, fl.hitter);
    L.fromU = fl.fromU; L.fromV = fl.fromV; L.oppU = fl.oppU; L.oppV = fl.oppV;
    this._coach('onBallLanded', L);
  }

  /** The ball left the court unplayed (the back wall, the stands): out on the full, a winner after a bounce. */
  _offCourt() {
    const fl = this.fl;
    if (fl.resolved || fl.kind === 'toss') return;
    if (fl.bounces === 0) { if (fl.kind === 'serve') this._fault('out'); else this._resolve(fl.receiver, 'out'); }
    else this._resolve(fl.hitter, fl.kind === 'serve' && !fl.touchedByReceiver ? 'ace' : 'winner');
  }

  /** The ball met the back fence (a flat court), the end boards or the stands (the show court): off the court. */
  _evWall(ev, stands) {
    _v1.set(ev.x, ev.y, ev.z);
    if (stands) this.audio.bounce(_v1, 'hard');
    this._cancelContact();
    this._offCourt();
  }

  // ─────────────────────────── shots ───────────────────────────

  _stats() {
    const st = this.game.profile ? this.game.profile.getTennisStats() : null;
    const o = this._statCopy || (this._statCopy = {});
    o.power = st ? st.power : 30; o.control = st ? st.control : 30; o.spin = st ? st.spin : 30;
    o.speed = st ? st.speed : 30; o.serve = st ? st.serve : 30; o.stamina = st ? st.stamina : 30;
    return o;
  }

  /**
   * Where the stick is aiming right now (before timing / scatter): court-local u / v on Rafa's
   * side, for the shot type selected. Screen space: right = your right, up = deep, down = short.
   */
  _aimTarget(out, shot, volley, smash) {
    const c = this.ctl, side = this.sides[0], opp = -side;
    const ax = clamp(c.moveX, -1, 1), ay = clamp(c.moveY, -1, 1);
    let xs = ax * 3.7, depth;
    if (smash) depth = 8.6 - ay * (ay < 0 ? 2.4 : 3.2);
    else if (shot === 'drop') { depth = 3.1 - ay * (ay < 0 ? 1.4 : 0.9); xs = ax * 3.4; }
    else if (shot === 'lob') depth = volley ? 10 : Math.max(10.2, 10.6 - ay * 0.8);
    else if (volley) depth = 6.2 - ay * 2.2;
    else {
      depth = 9.4 - ay * (ay < 0 ? 1.9 : 3.6);
      // Short and wide at the same time: a sharp angle
      if (ay > 0.35 && Math.abs(ax) > 0.5) xs = ax * 4.2;
    }
    if (shot === 'slice' && !volley && !smash) depth -= 0.4;
    out.u = side * xs; out.v = opp * depth; out.xs = xs; out.depth = depth;
    return out;
  }

  /** The aim guide on Rafa's side while you load up a stroke. */
  _showAim() {
    const a = this._aimTarget(this._aim, SHOTS[this.ctl.shot] || 'topspin', this.chg.stroke >= 3, this.chg.stroke === 2);
    const f = this.frame;
    this.fx.showAim(f.wx(a.u, a.v), SURF, f.wz(a.u, a.v));
  }

  /**
   * Your stroke meets the ball (st: the true ball at tc). The intention: the stick's target —
   * kept inside the lines (0.35 m, more off the peak: you can't place it as close from a bad
   * bounce), the shot type, the launch speed your swing gives (the load, the power stat, the shot;
   * the incoming pace comes back off the strings — more of it off the sweet spot), the net margin,
   * the spin. Then the physics: inside the green it lands where you aimed; outside it the face
   * turns (early pulls, late pushes) and it goes wherever that sends it.
   */
  _playerShot(tc, st) {
    const fl = this.fl, sw = this.swing, c = this.ctl, pl = this.pl, f = this.frame;
    const S = this._stats();
    const volley = sw.volley, smash = sw.stroke === 2;
    const label = smash ? 'smash' : SHOTS[c.shot] || 'topspin';
    const power = sw.power, mo = this.momentum[0];
    this.stats.hits++;
    if (pl.moved > 3) { this.stats.reached++; this._xp('speed', 0.35); }
    pl.tracking = false;
    const pw = S.power / 100, spn = S.spin / 100;
    const fromNet = pl.v * this.sides[0];         // your distance from the net
    // Aim: the stick picks the target, kept inside the lines
    const a = this._aimTarget(this._aim, smash ? 'topspin' : label, volley, smash);
    const qp = sw.peak;
    const m = 0.35 + 0.6 * (1 - qp);
    const xs = clamp(a.xs, -(SINGLES_W - m), SINGLES_W - m);
    let depth = a.depth;
    if (label === 'drop') depth += 1.6 * Math.max(0, power - 0.3);   // a drop wants touch: power makes it long
    depth = clamp(depth, label === 'drop' ? 1.3 : volley ? 2.2 : 3.2, HALF_L - m);
    const side = this.sides[0], opp = -side;
    const u = side * xs, v = opp * depth;
    // The swing: how hard the racket drives through the ball (load, the power stat, the shot);
    // the incoming ball's pace comes back off the strings (pace on pace), a sweeter contact more
    const vin = Math.hypot(st.vx, st.vy, st.vz);
    const eA = apparentCOR(clamp(sw.a, -1.5, 1.5), clamp(sw.b, -1.5, 1.5));
    let Vs = 0, pace = 0, margin, minT = 0, load = 1;
    switch (label) {
      case 'smash': Vs = 13 + 5 * power + 4 * pw; margin = 0.3; load = 1; break;
      case 'flat': Vs = 12.5 + 6 * power + 3.5 * pw; margin = 0.48; load = 0.6 + 0.6 * power; break;
      case 'slice': Vs = 10 + 3.5 * power + 2 * pw; margin = 0.28; load = 0.8 + 0.3 * power; break;
      case 'lob': pace = clamp((8.5 + 1.5 * pw) * (0.92 + 0.16 * power), 7.8, 11); margin = 2.8; minT = 1.55 + 0.25 * (1 - qp) - 0.2 * power; load = 0.4 + 0.9 * power; break;
      case 'drop': pace = (8.5 + 1.5 * pw) * (1 + 0.25 * power); margin = 0.24; minT = 0.55; break;
      default: Vs = 11.5 + 5 * power + 3 * pw; margin = 0.7 + 0.45 * spn; load = 0.55 + 0.6 * power;
    }
    const punch = volley && !smash && label !== 'lob' && label !== 'drop';
    if (punch) { Vs = 5 + 4 * power + 1.5 * pw; margin = 0.3; }
    let speed = 0;
    if (Vs) {
      speed = (1 + eA) * Vs + eA * vin * 0.55;
      speed *= (0.84 + 0.16 * qp) * (0.9 + 0.1 * this._fatigue()) * (sw.onRun ? 0.9 : 1) * (1 + 0.03 * mo);
      if (sw.label === 'Power shot!') speed *= 1.04;
      speed = clamp(speed, 9, 42);
    }
    if (sw.half) margin += 0.12;
    // Spin: the shot's profile loaded by the swing (a clean strike brushes more) and the spin
    // stat; a volley is a punch (a little underspin) unless it is sliced. The incoming ball's
    // own spin goes through the impact (a heavy topspin ball wants a real brush to send back
    // with topspin)
    if (punch && label !== 'slice') load *= 0.25;
    load *= 0.6 + 0.4 * sw.q;
    const prof = this._shapeSpin(this._prof, label, sw.clip, load, 0.75 + 0.5 * spn);
    if (punch && label !== 'slice') prof.top -= 1.5;
    // → the physics
    const I = this._intent, X = this._exec;
    I.tx = f.wx(u, v); I.tz = f.wz(u, v); I.profile = prof;
    I.speed = speed; I.pace = pace; I.margin = margin; I.minT = minT;
    I.kind = smash ? 'smash' : volley ? 'volley' : 'ground';
    I.wing = sw.clip === 'backhand' || sw.clip === 'volley_bh' ? 'bh' : 'fh';
    X.e = sw.e; X.gw = sw.gw; X.a = sw.a; X.b = sw.b; X.outSign = 1;
    X.B = smash ? this._rightOf(pl.yaw) : this._up;
    const res = this._makeAndFly(0, 'rally', label, tc, st, I, X, sw.green);
    this._launchBook(0, 'rally', label, tc, st);
    pl.swung = true;
    fl.q = sw.q;
    fl.power = power;
    this._lastShotQ = sw.q;
    if (sw.label === 'Power shot!') this.stats.powerShots++;
    if (smash) { this.stats.smashes++; this.hud.pop('Smash!', 'perfect'); }
    if (label === 'drop') this.stats.drops++;
    const when = smash ? 'Overhead' : volley ? 'Volley' : sw.half ? 'Half volley' : sw.peak >= 0.85 ? 'At the peak' : st.vy > 0 ? 'On the rise' : 'Dropping';
    this._readoutFor(res.n, sw.a, sw.b, sw.peak, sw.e, sw.green, this._contactText(sw.a, sw.b, when), pl.yaw);
    // Direction (from where you hit to where it landed, your view) and the point's pattern
    const toXs = fl.tGround < INF && !fl.netted ? f.lu(fl.landX, fl.landZ) * side : xs;
    const dir = this._shotDir(pl.u * side, toXs, I.wing);
    const P = this._pt;
    if (P.pattern.length >= 3) P.pattern.shift();
    P.pattern.push(dir);
    if (volley || smash || fromNet < 8.2) P.approach = true;
    const inTop = vin > 0.1 ? (st.wx * st.vz - st.wz * st.vx) / Math.max(0.1, Math.hypot(st.vx, st.vz)) : 0;
    this._coach('onShot', {
      spin: label, power, q: sw.q, volley, smash, half: sw.half, onRun: sw.onRun, set: sw.set, slide: sw.slide && !volley,
      fromNet, incoming: vin, inTop, contactH: sw.hc, aimX: a.xs, aimDepth: a.depth,
      dir, peak: sw.peak, e: sw.e, green: sw.green, a: sw.a, b: sw.b, side: I.wing, stretch: sw.stretch,
    });
  }

  /**
   * A shot's direction in the hitter's view (fromXs / toXs: court u in his screen frame, + =
   * his right): 'middle', 'cross' (diagonal), 'line', or for a forehand from the backhand corner
   * 'inside-out' (cross-court) / 'inside-in' (down the line).
   */
  _shotDir(fromXs, toXs, wing) {
    if (Math.abs(toXs) < 1.2) return 'middle';
    if (wing === 'fh' && fromXs < -1) return toXs > 0 ? 'inside-out' : 'inside-in';
    if (fromXs > 0.8) return toXs < 0 ? 'cross' : 'line';
    if (fromXs < -0.8) return toXs > 0 ? 'cross' : 'line';
    return (wing === 'fh' ? toXs < 0 : toXs > 0) ? 'cross' : 'line';
  }

  /** The hitter's right (horizontal) for a facing yaw, into the shared across axis. */
  _rightOf(yaw) {
    const B = this._axB;
    B.x = -Math.cos(yaw); B.y = 0; B.z = Math.sin(yaw);
    return B;
  }

  /** The readout's line: where on the strings · when in the ball's flight ("Sweet spot · At the peak"). */
  _contactText(a, b, when) {
    const aa = Math.abs(a), ab = Math.abs(b);
    const where = aa > 1 || ab > 1 ? 'Off the frame' : aa <= 0.35 && ab <= 0.35 ? 'Sweet spot'
      : aa >= ab ? (a > 0 ? 'Near the tip' : 'Near the throat') : (b > 0 ? 'High on the strings' : 'Low on the strings');
    return `${where} · ${when}`;
  }

  /**
   * After your hit: the contact readout (hud.contactReadout) — where on the strings (a, b), where
   * the racket met the ball (from the face n at contact: the racket touches the ball at −n·R from
   * its centre; in your view sx −1 its left … +1 its right, sy −1 under … +1 over), the peak
   * quality, the timing error, green or not, the label.
   */
  _readoutFor(n, a, b, peak, e, green, label, yaw) {
    const R = this._readout;
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    R.a = a; R.b = b; R.peak = peak; R.e = e; R.green = green; R.label = label;
    R.sx = n ? clamp(-(n.x * rx + n.z * rz) * 2.5, -1, 1) : 0;
    R.sy = n ? clamp(-n.y * 2.5, -1, 1) : 0;
    this._hudCall('contactReadout', R);
  }

  /**
   * Hitter-frame spin of a shot (out = { top, side, gyro }): the label's profile (SPIN) times the
   * swing's load and the spin stat, mirrored for a slice / drop from the forehand side (it curves
   * right and skids right instead of left). The incoming ball's own spin is not added here: it
   * goes through the racket–ball impact (ShotMaker), which asks for less spin when the strings
   * can't give it.
   */
  _shapeSpin(out, label, clip, load, spinK) {
    const base = SPIN[label] || SPIN.flat;
    let side = base.side, gyro = base.gyro;
    if ((label === 'slice' || label === 'drop') && (clip === 'forehand' || clip === 'volley_fh')) { side = -side; gyro = -gyro; }
    out.top = base.top * load * spinK;
    out.side = side * (0.6 + 0.4 * load) * spinK;
    out.gyro = gyro * load;
    return out;
  }

  /**
   * Rafa's racket meets the ball (st: the true ball at tc): TennisTactics picks the intention
   * (shot, target with his margins, speed, spin) and samples his execution (timing error, string
   * contact, the odd mishit), and the physics does the rest — his errors come out of it.
   */
  _aiShot(tc, st) {
    const b = this.ball, ai = this.ai, f = this.frame, I = this._intent, X = this._exec;
    if (this._rallyDrill()) {
      // Rally challenge: Rafa keeps it going (clean, cooperative), a little quicker the longer it lasts
      const side = this.sides[0], n = this.drill.count;
      const us = clamp(side * this.pl.u * 0.5 + rand(-1.8, 1.8), -3.6, 3.6);
      const u = side * us, v = side * rand(8.6, 10.6);
      I.tx = f.wx(u, v); I.tz = f.wz(u, v);
      I.profile = this._shapeSpin(this._prof, 'topspin', ai.plan.clip, 0.75, 0.9);
      I.speed = 0; I.pace = Math.min(15.5, rand(11, 12.3) + 0.12 * n); I.margin = rand(0.7, 1); I.minT = 0;
      I.kind = 'ground'; I.wing = ai.plan.clip === 'backhand' ? 'bh' : 'fh';
      X.e = 0; X.gw = 0.05; X.a = 0; X.b = 0; X.B = null; X.outSign = 1;
      this._makeAndFly(1, 'rally', 'topspin', tc, st, I, X, true);
      this._launchBook(1, 'rally', 'topspin', tc, st);
      ai.recover(this.t, 0.5);
      this.coachNpc.character.setBallVisible(false);
      return;
    }
    const pressure = clamp((ai.plan.stretch || 0) - 0.5, 0, 1) + (this._lastShotQ > 0.9 ? 0.25 : 0) + (this.fl.shot === 'flat' ? 0.1 : 0);
    const s = ai.chooseShot(this._shot, pressure);
    // His spin: the shot's profile, loaded by how hard he swings (speed against his difficulty's range)
    const sr = ai.diff.shotSpeed || DIFFICULTY.medium.shotSpeed;
    const load = s.spin === 'drop' || s.spin === 'lob' || !s.speed ? 1 : clamp(0.6 + 0.6 * (s.speed - sr[0]) / Math.max(1, sr[1] - sr[0]), 0.45, 1.3);
    I.profile = this._shapeSpin(this._prof, s.spin, ai.plan.clip, load, ai.diff.spin ?? 1);
    I.tx = f.wx(s.u, s.v); I.tz = f.wz(s.u, s.v);
    I.speed = s.speed || 0; I.pace = s.speed ? 0 : s.pace || 10; I.margin = s.margin; I.minT = s.minT || 0;
    I.kind = s.phys || 'ground'; I.wing = s.wing || 'fh';
    X.e = s.e; X.gw = s.gw; X.a = s.a; X.b = s.b; X.outSign = 1;
    X.B = I.kind === 'smash' ? this._rightOf(ai.yaw) : this._up;
    this._makeAndFly(1, 'rally', s.spin, tc, st, I, X, false);
    this._launchBook(1, 'rally', s.spin, tc, st);
    ai.recover(this.t, 0.5);
    this.coachNpc.character.setBallVisible(false);
    void b;
  }

  /** Rafa's drill feed off his own toss: a clean, planned ball (it lands where he means it to). */
  _feedShot(tc, st) {
    const plan = this.ai.feedPlan, f = this.frame, I = this._intent, X = this._exec;
    if (!plan) return;
    this.phase = 'rally'; // before the launch: the player's flight handlers (held SWING, split step) need it
    I.tx = f.wx(plan.u, plan.v); I.tz = f.wz(plan.u, plan.v);
    I.profile = this._shapeSpin(this._prof, plan.spin, 'forehand', plan.spin === 'topspin' ? 0.7 : 1, 1);
    I.speed = 0; I.pace = plan.pace; I.margin = plan.margin; I.minT = 0; I.kind = 'ground'; I.wing = 'fh';
    X.e = 0; X.gw = 0.05; X.a = 0; X.b = 0; X.B = null; X.outSign = 1;
    this._makeAndFly(1, 'rally', plan.spin, tc, st, I, X, true);
    this._launchBook(1, 'rally', plan.spin, tc, st);
    this.ai.feedPlan = null;
  }

  // ─────────────────────────── serving ───────────────────────────

  _serveSpot(who, deuce) {
    const s = this.sides[who];
    return { u: s * (deuce ? 0.9 : -0.9), v: s * (HALF_L + 0.35) };
  }

  _beginServe(who, deuce, second) {
    const srv = this.srv, f = this.frame;
    srv.who = who; srv.started = false; srv.charging = false; srv.charge = 0; srv.power = 0;
    srv.deuce = deuce; srv.second = second; srv.tRelease = INF; srv.tContact = INF;
    srv.tPress = INF; srv.tSweet = INF; srv.tossed = false; srv.tWhiff = INF; srv.label = ''; srv.pending = false;
    const s = this.sides[who], r = -s;
    const sp = this._serveSpot(who, deuce);
    const bu = (deuce ? r : -r) * 2.3, bv = r * 4.5;
    srv.yaw = Math.atan2(f.wx(bu, bv) - f.wx(sp.u, sp.v), f.wz(bu, bv) - f.wz(sp.u, sp.v));
    // Server on the baseline; receiver on his right (deuce) or left (ad) half, behind the baseline
    this._placeAt(who, sp.u, sp.v);
    this._placeAt(1 - who, (deuce ? -s : s) * 2.6, r * (HALF_L + 0.7));
    this.phase = 'serve';
    this.fl.active = false; this.fl.resolved = false; this.fl.kind = 'none';
    this.ball.hide();
    this.fx.hideMarker();
    this.fx.hideAim();
    this.rallyShots = 0;
    this._cancelCharge();
    if (who === 0) {
      const ch = this.game.player.character;
      ch.setBallVisible(true);
      if (ch.anim.oneShot) ch.stop(0.15);
      this.pl.clip = null;
      this.game.player.mesh.rotation.y = srv.yaw;
      this.hud.setMeter?.(-1);
      this.hud.setServeHint(true, second);
    } else {
      this.coachNpc.character.setBallVisible(true);
      this.coachNpc.mesh.rotation.y = srv.yaw;
      this.coachNpc.setFacing(srv.yaw, true);
      srv.tAuto = this.t + (second ? 0.9 : 1.4);
      this.hud.setServeHint(false);
    }
  }

  _updateServe(dt) {
    const srv = this.srv, t = this.t;
    if (this.phase !== 'serve') return;
    if (srv.pending && !this.cam.busy) {
      srv.pending = false;
      if (srv.who === 0 && !srv.started && this.ctl.swing) this._serveToss();
    }
    if (srv.who === 0 && srv.started) {
      if (srv.charging) {
        // Trophy position while SWING is held; the meter shows how far through the toss you are
        this._holdPose('serve', SERVE_HOLD);
        if (srv.tossed) {
          const o = this.ball.stateAt(t, this._qs);
          if (o.y < srv.catchY && o.vy < 0) this._catchToss();
        }
      }
      if (t >= srv.tWhiff) { srv.tWhiff = INF; this._fault('miss'); }
    }
    if (srv.who === 1 && !srv.started && this.cam.busy) srv.tAuto = Math.max(srv.tAuto, t + 0.6); // let the camera arrive
    if (srv.who === 1 && !srv.started && this._coach('talking')) srv.tAuto = Math.max(srv.tAuto, t + 0.3); // Rafa finishes his sentence
    if (srv.who === 1 && !srv.started && t >= srv.tAuto) this._startServe(1, 0.8);
    if (srv.started && t >= srv.tRelease) {
      srv.tRelease = INF;
      const ch = srv.who === 0 ? this.game.player.character : this.coachNpc.character;
      (srv.who === 0 ? this.game.player.mesh : this.coachNpc.mesh).updateMatrixWorld(true);
      ch.getBallHandWorldPosition(_v1);
      ch.setBallVisible(false);
      if (srv.who === 0) this._launchPlayerToss(_v1);
      else this.launchToss(srv.who, _v1, srv.tContact - t, 'serve');
    }
  }

  /** Rafa's serve: a fixed, clean motion (the AI picks pace and placement at contact). */
  _startServe(who, power) {
    const srv = this.srv, t = this.t;
    srv.started = true; srv.power = power;
    const npc = this.coachNpc;
    npc.stopMove();
    npc.mesh.rotation.y = srv.yaw;
    npc.setFacing(srv.yaw, true);
    npc.swing('serve', { fade: 0.15 });
    srv.tRelease = t + SERVE_RELEASE;
    srv.tContact = t + SERVE_CONTACT;
  }

  /** Your serve, part 1: SWING pressed — the toss goes up, the power builds while you hold. */
  _serveToss() {
    const srv = this.srv, t = this.t, p = this.game.player;
    srv.started = true; srv.charging = true; srv.tPress = t; srv.tossed = false; srv.power = 0;
    srv.tContact = INF; srv.tSweet = INF; srv.hold = 0.8;
    p.mesh.rotation.y = srv.yaw;
    p.character.play('serve', { fade: 0.12, timeScale: SERVE_TS, startAt: SERVE_SA });
    this.pl.clip = null;
    srv.tRelease = t + (SERVE_RELEASE - SERVE_SA) / SERVE_TS; // the ball leaves the hand
    this.pl.swingFree = INF;
    this.hud.setServeHint(false);
    this.stats.serves++;
    if (!srv.second) this.stats.firsts++;
  }

  /** The toss: straight up over the racket's full-stretch point, peaking TOSS_DROP above it. */
  _launchPlayerToss(from) {
    const p = this.game.player, ch = p.character, b = this.ball, fl = this.fl, t = this.t, srv = this.srv;
    p.mesh.rotation.y = srv.yaw;
    p.mesh.updateMatrixWorld(true);
    ch.getContactPointWorld('serve', _v2);
    const apex = _v2.y + TOSS_DROP;
    const vy = Math.sqrt(Math.max(1, 2 * G * (apex - from.y)));
    const tS = vy / G + Math.sqrt(2 * TOSS_DROP / G); // the sweet spot: back down at racket height
    this._flyTo(t, from, _v2, tS);                    // (a real flight: it passes the racket point at tS)
    b.spin = 'feed';
    fl.active = true; fl.kind = 'toss'; fl.hitter = 0; fl.receiver = 0; fl.resolved = false;
    fl.bounces = 0; fl.let = false; fl.netted = false; fl.evI = 0; fl.tLaunch = t;
    fl.contactBy = -1; fl.tContact = INF; fl.tGround = b.bounceTime(0);
    fl.tossClip = 'serve';
    srv.tossed = true;
    srv.tSweet = t + tS;
    srv.hold = srv.tSweet - SERVE_SWING - srv.tPress; // the ideal hold (meter = 1)
    srv.catchY = _v2.y - 0.8;
  }

  /**
   * Your serve, part 2: SWING released — the racket meets the ball SERVE_SWING later. The timing
   * against the toss (e = contact − the ball back at full stretch; green inside ±gw), where it meets
   * the strings, the label; the physics then turns the face for a mistimed one (early: into the net
   * or wide; late: long, wide, or down into the net).
   */
  _serveRelease() {
    const srv = this.srv, t = this.t, p = this.game.player, ch = p.character;
    srv.charging = false;
    this.hud.setMeter?.(-1);
    if (!srv.tossed) { this._abortServe(); return; }
    const tc = t + SERVE_SWING;
    srv.tContact = tc;
    const sel = SHOTS[this.ctl.shot] || 'topspin';
    srv.spin = sel === 'flat' ? 'serve' : sel === 'slice' || sel === 'drop' ? 'slicesrv' : 'kick';
    srv.power = clamp((t - srv.tPress) / srv.hold, 0, 1);  // the longer the load, the more power
    srv.e = tc - srv.tSweet;                               // − early (ball still up), + late (dropping)
    srv.gw = this._serveGreen(srv.power);
    const an = ch.anim, e = an._entries && an._entries.get('serve');
    if (e && an.oneShot && an.oneShot.entry === e && e.action.time < SERVE_CONTACT - 0.05) {
      e.action.timeScale = Math.max(0.4, (SERVE_CONTACT - e.action.time) / SERVE_SWING);
    } else {
      ch.play('serve', { fade: 0.05, startAt: SERVE_CONTACT - SERVE_SWING, timeScale: 1 });
    }
    p.mesh.rotation.y = srv.yaw;
    p.mesh.updateMatrixWorld(true);
    ch.getContactPointWorld('serve', _v2);
    const o = this.ball.stateAt(tc, this._qs);
    const dx = o.x - _v2.x, dy = o.y - _v2.y, dz = o.z - _v2.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.pl.swingFree = tc + 0.35;
    this.ai.tSplit = tc - 0.1;
    if (d > 0.9 || o.y < _v2.y - 0.75) {
      // Swung at thin air: the toss was too far gone (or not up yet)
      srv.q = 0; srv.green = false; srv.label = srv.e < 0 ? 'Too early' : 'Too late';
      this._verdict(srv.label, 'miss');
      srv.tWhiff = tc + 0.25;
      this._coach('onServe', srv);
      return;
    }
    // Where the toss meets the strings: along the racket (it reaches straight up) and across it
    const rx = -Math.cos(srv.yaw), rz = Math.sin(srv.yaw);
    srv.a = dy / STRING_REACH;
    srv.b = (dx * rx + dz * rz) / STRING_REACH;
    const frame = Math.abs(srv.a) > 1 || Math.abs(srv.b) > 1;
    const ae = Math.abs(srv.e);
    srv.green = ae <= srv.gw && !frame;
    const perfect = srv.green && ae <= GREEN_PERFECT * srv.gw;
    srv.q = srv.green ? clamp(0.8 + 0.2 * (1 - ae / srv.gw), 0.8, 1) : clamp(0.75 - (ae - srv.gw) / 0.2, 0.05, 0.75);
    let kind;
    if (frame) { srv.label = 'Frame!'; kind = 'miss'; }
    else if (perfect) { srv.label = srv.power >= 0.95 ? 'Power serve!' : 'Perfect!'; kind = 'perfect'; }
    else if (srv.green) { srv.label = 'Good'; kind = 'good'; }
    else { srv.label = srv.e < 0 ? 'Early' : 'Late'; kind = srv.e < 0 ? 'early' : 'late'; }
    this._verdict(srv.label, kind);
    this._coach('onServe', srv);
    this.scheduleContact(0, tc, _v2);
  }

  /**
   * A serve's green half-width (s): (0.04 + 0.03·serve)·(1.12 − 0.3·power), narrower when tired
   * or facing a big point, wider in the zone.
   */
  _serveGreen(power) {
    const st = this._stats();
    let gw = (0.04 + 0.03 * st.serve / 100) * (1.12 - 0.3 * clamp(power, 0, 1));
    gw *= 0.85 + 0.15 * this._fatigue();
    if (this.momentum[0] >= 0.7) gw *= 1.1;
    const pr = this.score && this.mode === 'match' ? this.score.pressure() : null;
    if (pr && pr.kind !== 'game' && pr.for === 1) gw *= 0.9;
    return gw;
  }

  /** Released before the ball even left the hand: start again (no fault). */
  _abortServe() {
    const srv = this.srv, ch = this.game.player.character;
    srv.started = false; srv.tossed = false; srv.tRelease = INF; srv.tContact = INF;
    this.stats.serves--; if (!srv.second) this.stats.firsts--;
    ch.stop(0.15); ch.setBallVisible(true);
    this.pl.clip = null; this.pl.swingFree = 0;
    this.hud.setMeter?.(-1);
    this.hud.setServeHint(true, srv.second);
    this.hud.pop('Hold it through the toss', 'small');
    this._coach('onToss', 'aborted');
  }

  /** Held SWING too long: you catch the toss and go again (no fault). */
  _catchToss() {
    const srv = this.srv, ch = this.game.player.character;
    srv.started = false; srv.charging = false; srv.tossed = false; srv.tRelease = INF; srv.tContact = INF;
    this.stats.serves--; if (!srv.second) this.stats.firsts--;
    this.fl.active = false; this.fl.kind = 'none';
    this.ball.hide();
    ch.stop(0.2); ch.setBallVisible(true);
    this.pl.clip = null; this.pl.swingFree = 0;
    this.hud.setMeter?.(-1);
    this.hud.setServeHint(true, srv.second);
    this.hud.pop('Toss again', 'small');
    this._coach('onToss', 'caught');
  }

  /**
   * The serve leaves the racket (st: the true ball at tc). Rafa: TennisTactics picks it and samples
   * his execution. You: the stick aims over the box — at full stick up to SERVE_OVER past a line
   * (angled too far: out even from the green) — the load gives the speed, the selector the spin
   * (flat / kick / slice), and the physics turns a mistimed one (flipped: early → net or wide,
   * late → long, wide or net). Released in the green and aimed inside the box, it goes in.
   */
  _serveShot(who, tc, st) {
    const srv = this.srv, c = this.ctl, f = this.frame, I = this._intent, X = this._exec;
    this.phase = 'rally';
    const side = this.sides[who], r = -side;
    if (who === 1) {
      const s = this.ai.chooseServe(this._shot, srv.deuce, srv.second);
      const sp = this.ai.diff.serve.speed || DIFFICULTY.medium.serve.speed;
      const load = clamp(0.7 + 0.5 * (s.speed - sp[0] * 0.8) / Math.max(1, sp[1] - sp[0] * 0.8), 0.6, 1.25);
      I.profile = this._shapeSpin(this._prof, s.spin, 'serve', load, this.ai.diff.spin ?? 1);
      I.tx = f.wx(s.u, s.v); I.tz = f.wz(s.u, s.v);
      I.speed = s.speed; I.pace = 0; I.margin = s.margin; I.minT = 0; I.kind = 'serve'; I.wing = 'fh';
      X.e = s.e; X.gw = s.gw; X.a = s.a; X.b = s.b; X.B = this._rightOf(srv.yaw); X.outSign = srv.deuce ? 1 : -1;
      this._makeAndFly(1, 'serve', s.spin, tc, st, I, X, false);
      this._launchBook(1, 'serve', s.spin, tc, st);
      this.ai.recover(this.t, 0.6);
      return;
    }
    const S = this._stats();
    const sv = S.serve / 100, spn = S.spin / 100;
    const p = srv.power, mo = this.momentum[0];
    const sgnScreen = srv.deuce ? -1 : 1;        // the box is to your left from the deuce side
    const second = srv.second;
    // Flat = the big first serve, Topspin / Lob = kick (safe, jumps up), Slice / Drop = slice (skids
    // away): chosen at the release (_serveRelease)
    const spin = srv.spin;
    const mx = clamp(c.moveX, -1, 1), my = clamp(c.moveY, -1, 1);
    const uScreen = sgnScreen * SERVE_BOX_MID + mx * (SERVE_BOX_MID + SERVE_OVER) + (spin === 'slicesrv' ? sgnScreen * 0.3 : 0);
    const depth = SERVE_DEPTH - my * (my < 0 ? SERVICE_L + SERVE_OVER - SERVE_DEPTH : 1.7);
    let speed = (27 + 12 * p * (0.5 + 0.5 * sv)) * (spin === 'kick' ? 0.82 : spin === 'slicesrv' ? 0.9 : 1) * (second ? 0.92 : 1);
    speed *= (0.9 + 0.1 * this._fatigue()) * (1 + 0.02 * mo) * (srv.label === 'Power serve!' ? 1.03 : 1);
    let margin = spin === 'kick' ? 0.5 : spin === 'slicesrv' ? 0.26 : 0.14;
    if (second && spin !== 'kick') margin += 0.15;       // a safer, higher second serve
    // Spin: a loaded kick jumps higher, a loaded slice curves and skids further
    const load = (spin === 'serve' ? 0.7 + 0.5 * p : 0.75 + 0.45 * p) * (0.7 + 0.3 * srv.q);
    I.profile = this._shapeSpin(this._prof, spin, 'serve', load, 0.8 + 0.4 * (0.5 * spn + 0.5 * sv));
    const u = side * uScreen, v = r * depth;
    I.tx = f.wx(u, v); I.tz = f.wz(u, v);
    I.speed = speed; I.pace = 0; I.margin = margin; I.minT = 0; I.kind = 'serve'; I.wing = 'fh';
    X.e = srv.e; X.gw = srv.gw; X.a = srv.a; X.b = srv.b; X.B = this._rightOf(srv.yaw); X.outSign = srv.deuce ? 1 : -1;
    const aimIn = this._lineMargin(u, v, 'serve', 0) > 0.06;   // aimed inside the box (else: angled too far)
    const res = this._makeAndFly(0, 'serve', spin, tc, st, I, X, srv.green && aimIn);
    this._launchBook(0, 'serve', spin, tc, st);
    const when = srv.green ? 'Full stretch' : srv.e < 0 ? 'Ball still up' : 'Ball dropped';
    this._readoutFor(res.n, srv.a, srv.b, 1, srv.e, srv.green, this._contactText(srv.a, srv.b, when), srv.yaw);
    this.hud.setMeter?.(-1);
  }

  /** A planned racket contact that will not happen: the ball flies on (the drawn ball rejoins it). */
  _cancelContact() {
    const fl = this.fl;
    fl.contactBy = -1; fl.tContact = INF;
    this.ball.releaseOffset(this.t);
  }

  // ─────────────────────────── points ───────────────────────────

  _fault(kind) {
    const fl = this.fl;
    fl.resolved = true;
    this._cancelContact();
    this._cancelCharge();
    this.ai.standDown();
    this.pl.aValid = false;
    this.fx.hideMarker();
    const who = fl.hitter;
    this.tPointOver = this.t + 1.15;
    if (who === 0) this._coach('onLanded', { kind: 'serve', result: kind === 'net' ? 'net' : kind === 'miss' ? 'miss' : this._errorKind(), second: this.srv.second, spin: this.srv.spin });
    if (this.mode === 'drill') { this._pointWhy = 'fault'; this.hud.pop('Fault', 'call'); this._drillMissed(); return; }
    if (this.srv.second) {
      this.stats.doubles[who]++;
      this._pointWinner = 1 - who; this._pointWhy = 'double';
      this.hud.pop('Double fault', 'call');
      this._crowd('react', 'doubleFault', who);
      this.tPointOver = this.t + 1.5;
      this._pointEnd(1 - who, 'double', who);
    } else {
      this._pointWinner = -2; this._pointWhy = 'fault';
      this.hud.pop(kind === 'net' ? 'Fault (net)' : kind === 'miss' ? 'Fault' : 'Fault', 'call');
    }
  }

  /** 'long' or 'wide' for a ball that landed out (landX / landZ of the current flight). */
  _errorKind() {
    const fl = this.fl, f = this.frame;
    const u = f.lu(fl.landX, fl.landZ);
    if (fl.kind === 'serve') {
      // Out of the service box: past the service line = long, over the centre line = centre,
      // past the singles side line = wide (the same frame as _isIn)
      const rs = this.sides[1 - fl.hitter];
      const vv = f.lv(fl.landX, fl.landZ) * rs;
      if (vv > SERVICE_L + LINE_TOL) return 'long';
      return u * (this.srv.deuce ? rs : -rs) < -LINE_TOL ? 'centre' : 'wide';
    }
    return Math.abs(u) > SINGLES_W + LINE_TOL ? 'wide' : 'long';
  }

  /**
   * The point is decided. winner: 0 / 1, or -1 for a let. why: 'out' | 'net' | 'winner' |
   * 'ace' | 'let'. The ball keeps flying; scoring happens a moment later (_awardPoint).
   */
  _resolve(winner, why) {
    const fl = this.fl;
    if (fl.resolved) return;
    fl.resolved = true;
    this._cancelContact();
    this._cancelCharge();
    this.ai.standDown();
    this.pl.aValid = false;
    this.pl.tracking = false;
    this.fx.hideMarker();
    this.hud.timing(-1);
    this._pointWinner = winner; this._pointWhy = why;
    this.tPointOver = this.t + (why === 'let' ? 1.1 : 1.6);
    const hitter = fl.hitter;
    this.hud.setRally(0);
    if (hitter === 0 && (why === 'out' || why === 'net')) {
      this._coach('onLanded', { kind: fl.kind, result: why === 'net' ? 'net' : this._errorKind(), spin: fl.shot, power: fl.power || 0, q: fl.q });
    }
    if (this.mode === 'drill') {
      if (why === 'out' || why === 'net') this.hud.pop(why === 'net' ? 'Net' : 'Out', 'call');
      else if (why === 'winner' && hitter === 1) this.hud.pop(this._miss ? 'Missed' : 'Not up', 'call');
      this._drillMissed(why);
      this._miss = null;
      return;
    }
    if (why === 'let') { this.hud.pop('Let', 'call'); return; }
    this.stats.rallies++;
    this.stats.rallyShots += this.rallyShots;
    this.stats.longest = Math.max(this.stats.longest, this.rallyShots);
    if (this.rallyShots >= 6) this._xp('stamina', Math.min(3, 0.8 + 0.1 * (this.rallyShots - 6)));
    if (this.rallyShots >= 9) this._crowd('react', 'longRally', winner, { shots: this.rallyShots });
    if (why === 'out' || why === 'net') {
      this.stats.errors[hitter]++;
      this.hud.pop(why === 'net' ? 'Net' : 'Out!', 'call');
      if (hitter === 0 && fl.q > 0.6 && this.swing.stretch < 0.5) this.stats.unforced++;
      this._crowd('react', 'error', hitter);
      if (hitter === 1 && Math.random() < 0.3) this._say(pick(['Bueno...', 'Ay. My fault.', 'Hm. The ball has no memory.']), 1.6);
    } else if (why === 'ace') {
      this.stats.aces[hitter]++;
      this.hud.pop('Ace!', hitter === 0 ? 'perfect' : 'call');
      if (hitter === 0) this._xp('serve', 4);
      this._crowd('react', 'ace', hitter);
    } else if (why === 'winner') {
      this.stats.winners[hitter]++;
      this.hud.pop(hitter === 0 ? 'Winner!' : (this._miss ? 'Missed' : 'Winner, Rafa'), hitter === 0 ? 'perfect' : 'call');
      if (hitter === 0) this._xp('power', 3);
      this._crowd('react', fl.shot === 'smash' ? 'smash' : fl.shot === 'drop' ? 'drop' : 'winner', hitter);
    }
    this._pointEnd(winner, why, hitter);
    this._miss = null;
  }

  /** Tell the coach how the point ended; net-point bookkeeping. */
  _pointEnd(winner, why, hitter) {
    const pl = this.pl, fl = this.fl;
    const atNet = pl.v * this.sides[0] < SERVICE_L + 0.6;
    if (atNet) { this.stats.netPts[1]++; if (winner === 0) this.stats.netPts[0]++; }
    const info = this._pe || (this._pe = {});
    info.winner = winner; info.why = why; info.hitter = hitter; info.rally = this.rallyShots;
    info.playerNet = atNet; info.shot = fl.shot; info.kind = fl.kind; info.second = this.srv.second;
    info.server = this.srv.who; info.miss = this._miss; info.stamina = pl.stamina;
    info.rafaNet = this.ai.npc ? this.frame.lv(this.ai.npc.body.position.x, this.ai.npc.body.position.z) * this.sides[1] < SERVICE_L + 0.6 : false;
    // The point's shape (copy what you keep: the pattern array is reused)
    const P = this._pt;
    info.pattern = P.pattern; info.serveTarget = P.serveTarget; info.returnDepth = P.returnDepth;
    info.approach = P.approach || atNet; info.oppStyle = this.oppStyle;
    this._coach('onPointEnd', info);
  }

  _awardPoint() {
    const w = this._pointWinner, why = this._pointWhy;
    if (why === 'let') { this._setupPoint(false, this.srv.second); return; }
    if (w === -2) { this._setupPoint(false, true); return; } // first-serve fault → second serve
    const ev = this.score.pointTo(w);
    this.stats.points[w]++;
    this._pointMomentum(w, why, this.fl.hitter);
    this._updateScoreboard();
    const names = ['You', 'Rafa'];
    if (ev.match) { this._finishMatch(); return; }
    if (ev.set) { this.hud.pop(`Set ${names[ev.setWinner]}!`, 'big'); this._crowd('react', 'set', ev.setWinner); }
    else if (ev.game) { this.hud.pop(`Game ${names[ev.gameWinner]}`, 'big'); this._crowd('react', 'game', ev.gameWinner); }
    if (ev.tiebreak) this.hud.pop('Tiebreak!', 'big');
    if (ev.game) this.pl.stamina = Math.min(1, this.pl.stamina + 0.25);
    if (ev.game || ev.set) this._coach('onGame', ev, this.score);
    if (ev.changeEnds && this.opts.changeEnds) {
      this.sides[0] = -this.sides[0]; this.sides[1] = -this.sides[1];
      this.cam.flip();
      this.hud.pop('Change ends', 'call');
    }
    this._setupPoint(false, false);
  }

  /** Points, big shots and errors swing momentum (it drifts back toward even every point). */
  _pointMomentum(w, why, hitter) {
    const m = this.momentum;
    m[0] *= 0.85; m[1] *= 0.85;
    let gain = 0.06;
    if (why === 'winner' || why === 'ace') gain += 0.06;
    if (this.rallyShots >= 8) gain += 0.04;
    this._swingMomentum(w, gain);
    if ((why === 'out' || why === 'net' || why === 'double') && hitter === 1 - w) this._swingMomentum(hitter, why === 'double' ? -0.12 : -0.08);
    else this._swingMomentum(1 - w, -0.05);
  }

  _swingMomentum(who, d) {
    if (this.mode !== 'match') return;
    const m = this.momentum, before = m[who];
    m[who] = clamp(m[who] + d, -1, 1);
    if (who === 0 && before < 0.7 && m[0] >= 0.7) this.hud.pop('In the zone!', 'big');
    this.hud.setMomentum(m[0], m[1]);
  }

  _setupPoint(first, second = false) {
    const sc = this.score;
    this.fl.active = false; this.fl.resolved = false;
    this.ball.hide();
    this.ai.reset();
    this.srv.second = !!second;
    if (!second) this._resetPointInfo();
    this._beginServe(sc.currentServer, sc.isDeuceSide(), !!second);
    const call = sc.callText(['You', 'Rafa']);
    if (!first && !second && call) this._say(call, 1.5);
    if (second) this.hud.pop('Second serve', 'small');
    else {
      const pr = sc.pressure();
      if (pr) {
        const what = pr.kind === 'match' ? 'Match point' : pr.kind === 'set' ? 'Set point' : 'Break point';
        this.hud.pop(pr.for === 0 ? `${what}!` : `${what}, Rafa`, 'big');
      }
    }
    this._updateScoreboard();
    this._coach('between', { first, second });
  }

  _resetPointInfo() {
    const P = this._pt;
    P.pattern.length = 0; P.serveTarget = ''; P.returnDepth = 0; P.approach = false;
  }

  _updateScoreboard() {
    if (this.mode !== 'match' || !this.score) return;
    const server = this.phase === 'serve' ? this.srv.who : this.score.currentServer;
    this.hud.setScore(this.score, server);
    this._stadiumBoard(server);
  }

  /**
   * On the show court the stadium's big scoreboards show this match (Stadium.setScoreOverride,
   * when the world has one): names, games (the last set's once it is over), points, the server
   * and sets. Called on a score change only; _clearStadiumBoard hands the boards back to the
   * club (menu, drills, another court, leaving).
   */
  _stadiumBoard(server) {
    const st = this.game.world?.stadium, f = this.frame, sc = this.score;
    if (typeof st?.setScoreOverride !== 'function') return;
    if (!sc || !f?.court?.isStadium || (st.layout && st.layout.id !== f.id)) { this._clearStadiumBoard(); return; }
    const g = sc.done && sc.sets.length ? sc.sets[sc.sets.length - 1].g : sc.games;
    try {
      st.setScoreOverride({
        names: ['YOU', 'R. IBARRA'],
        games: [g[0], g[1]],
        points: sc.done ? ['', ''] : [sc.pointText(0), sc.pointText(1)],
        server: server === 1 ? 1 : 0,
        sets: [sc.setsWon[0], sc.setsWon[1]],
      });
      this._boardSet = true;
    } catch (e) { /* cosmetic */ }
  }

  _clearStadiumBoard() {
    if (!this._boardSet) return;
    this._boardSet = false;
    try { this.game.world?.stadium?.setScoreOverride?.(null); } catch (e) { /* cosmetic */ }
  }

  _finishMatch() {
    const sc = this.score, s = this.stats;
    const won = sc.winner === 0;
    this.phase = 'results';
    this.lastWasDrill = false;
    this.ball.hide();
    this.fx.hideAll();
    this._cancelCharge();
    // XP: completion + result, scaled by difficulty
    const mul = this.ai.diff.xp;
    for (const k in s.xp) s.xp[k] += 1.5;
    if (won) { s.xp.power += 2; s.xp.control += 2; s.xp.serve += 1; s.xp.stamina += 1; }
    for (const k in s.xp) s.xp[k] *= mul;
    const ups = this._applyPendingXp();
    const prof = this.game.profile;
    if (prof) prof.recordMatch({ won, setsWon: sc.setsWon[0], setsLost: sc.setsWon[1] });
    try { this.game.saveGame(); } catch (e) { /* ignore */ }
    this.coachNpc.swing('greet', { fade: 0.2 });
    this._say(won ? pick(['Bueno. Well played.', 'You beat me. Tomorrow I train.', 'No memory. Bueno.']) : pick(['Vamos! Good fight.', 'Footwork first. Then we talk.', 'Again tomorrow?']), 2.6);
    this._crowd('react', 'match', won ? 0 : 1);
    this.hud.setPlayUi(false);
    const fsp = s.firsts ? `${Math.round(100 * s.firstIn / s.firsts)}%` : '–';
    this.hud.showResults({
      kind: 'match', won, title: won ? 'Victory!' : 'Rafa takes it',
      sub: `${FORMATS[this.format].label} · ${this.ai.diff.label} · ${SURFACES[this.surface].label}${this.windKey !== 'calm' ? ' · ' + WINDS[this.windKey].label : ''}`,
      score: sc.setLine(0),
      stats: [
        ['Winners', s.winners[0]], ['Unforced errors', s.unforced], ['Aces', s.aces[0]], ['Double faults', s.doubles[0]],
        ['1st serves in', fsp], ['Power shots', s.powerShots],
        ['Net points won', `${s.netPts[0]}/${s.netPts[1]}`], ['Perfect hits', s.perfect],
        ['Longest rally', s.longest], ['Avg rally', s.rallies ? (s.rallyShots / s.rallies).toFixed(1) : '0'],
        ['Points won', `${s.points[0]}/${s.points[0] + s.points[1]}`], ['Rafa errors', s.errors[1]],
      ],
      xp: this._xpShown, ups, tips: this._topTips(),
      record: prof ? prof.record : null,
    });
    if (won) this.game.sound.playRankUp && this.game.sound.playRankUp();
    else this.game.sound.playNotification && this.game.sound.playNotification();
  }

  // ─────────────────────────── drills ───────────────────────────

  _rallyDrill() { return this.mode === 'drill' && !!this.drill && this.drill.type === 'rally'; }

  _drillReps() { return this._rallyDrill() ? RALLY_TRIES : DRILL_REPS; }

  _drillTargets() {
    const d = this.drill, opp = this.sides[1];
    const T = this._targets || (this._targets = []);
    T.length = 0;
    if (d.type === 'fh' || d.type === 'bh') {
      T.push({ u: -3.1, v: opp * 10.2, r: 1.25 }, { u: 3.1, v: opp * 10.2, r: 1.25 }, { u: 0, v: opp * 10.8, r: 1.1 });
    } else if (d.type === 'volley') {
      T.push({ u: -3.3, v: opp * 4.6, r: 1.25 }, { u: 3.3, v: opp * 4.6, r: 1.25 }, { u: 0, v: opp * 9.8, r: 1.3 });
    }
    this._showTargets();
  }

  _showTargets() {
    const f = this.frame;
    this.fx.setTargets(this._targets.map(tg => ({ x: f.wx(tg.u, tg.v), z: f.wz(tg.u, tg.v), r: tg.r })), SURF);
  }

  _drillHud() {
    const d = this.drill, reps = this._drillReps();
    if (d.type === 'rally') {
      this.hud.setInfo(`${DRILLS.rally.label} · try ${Math.min(d.rep + 1, reps)}/${reps} · best ${d.best}`);
      this.hud.setDrillLine(`Rally ${d.count}  ·  best ${d.best}`);
    } else {
      this.hud.setInfo(`${DRILLS[d.type].label} · ${Math.min(d.rep + 1, reps)}/${reps} · ${d.score} pts`);
      this.hud.setDrill(d.rep, reps, d.score);
    }
  }

  _drillSetup(first) {
    const d = this.drill;
    const side = this.sides[0];
    this.fl.active = false; this.fl.resolved = false;
    this.ball.hide();
    this._resetPointInfo();
    this.ai.reset();
    d.count = 0;
    this._drillHud();
    if (d.type === 'serve') {
      const deuce = d.rep % 2 === 0;
      this.srv.second = false;
      this._beginServe(0, deuce, false);
      // targets: T and wide corner of the box being served into
      const r = -side, sgn = deuce ? r : -r;
      this._targets = [{ u: sgn * 0.75, v: r * 5.6, r: 0.85 }, { u: sgn * 3.85, v: r * 5.6, r: 0.85 }];
      this._showTargets();
      this._coach('between', { drill: true, first, rep: d.rep }); // after the side is set (aim tips)
      return;
    }
    const pv = d.type === 'volley' ? 3.4 : BASE_V;
    if (first || d.type === 'volley' || d.type === 'rally') this._placePlayer(0, side * pv);
    this.ai.place(0, this.sides[1] * (d.type === 'volley' ? 11.8 : d.type === 'rally' ? BASE_V : 11.2));
    this.coachNpc.character.setBallVisible(true);
    this.phase = 'feedWait';
    this.tFeed = this.t + (first ? 1.6 : 0.9);
    this._coach('between', { drill: true, first, rep: d.rep });
  }

  _drillFeed() {
    const d = this.drill, side = this.sides[0];
    const pu = this.pl.u;
    let plan;
    if (d.type === 'volley') {
      const off = (Math.random() < 0.5 ? 1 : -1) * rand(0.5, 1.3);
      plan = { u: clamp(pu + side * off, -3.8, 3.8), v: side * rand(6.4, 7.6), pace: rand(10.5, 12), margin: rand(0.25, 0.4), spin: 'flat' };
    } else {
      const toRight = d.type === 'fh' ? 1 : d.type === 'bh' ? -1 : (Math.random() < 0.5 ? 1 : -1); // player's forehand = screen right
      const us = clamp(side * pu + toRight * rand(0.8, 2.0) + rand(-0.8, 0.8), -3.9, 3.9);
      plan = { u: side * us, v: side * rand(8.4, 10.4), pace: rand(11, 13), margin: rand(0.6, 0.9), spin: 'topspin' };
    }
    this.ai.feed(this.t, plan);
    this.phase = 'feeding';
  }

  /** The player's drill shot bounced in the court: score it (targets), or keep the rally going. */
  _drillLanded(u, v) {
    const d = this.drill;
    const f = this.frame;
    if (d.type === 'rally') {
      d.count++;
      if (d.count > d.best) d.best = d.count;
      this._drillHud();
      this._xp('control', 0.35);
      if (this.fl.shot === 'topspin' || this.fl.shot === 'slice') this._xp('spin', 0.2);
      if (d.count >= 6) this._xp('stamina', 0.25);
      if (d.count % 5 === 0) { this.hud.pop(`${d.count}!`, 'good'); this._crowd('react', 'longRally', 0, { shots: d.count }); }
      this._coach('onDrillLanded', { hit: false, pts: 1, type: d.type, count: d.count });
      return; // the rally goes on: Rafa plays it back
    }
    let pts = 1, hit = false;
    for (const tg of this._targets || []) {
      if (Math.hypot(u - tg.u, v - tg.v) <= tg.r + R) { hit = true; break; }
    }
    if (hit) pts = 3;
    d.score += pts;
    this.stats.drill.inCourt++;
    if (hit) this.stats.drill.targets++;
    this.fx.burstAt(f.wx(u, v), SURF, f.wz(u, v), hit);
    this.hud.pop(hit ? 'Target! +3' : 'In +1', hit ? 'perfect' : 'good');
    const stat = d.type === 'serve' ? 'serve' : d.type === 'volley' ? 'control' : 'control';
    this._xp(stat, hit ? 2 : 1);
    if (d.type !== 'serve' && d.type !== 'volley') { if (this.fl.shot === 'topspin' || this.fl.shot === 'slice') this._xp('spin', 0.6); if (hit) this._xp('power', 0.8); }
    if (d.type === 'volley') this._xp('speed', 0.5);
    if (hit) this._crowd('react', 'drillTarget', 0);
    this.fl.resolved = true;
    this._cancelContact();
    this._pointWhy = 'in';
    this.tPointOver = this.t + 1.1;
    this._coach('onDrillLanded', { hit, pts, type: d.type });
  }

  /** A drill rep ended without a score (rally challenge: the attempt is over). */
  _drillMissed() {
    const d = this.drill;
    if (!d || d.type !== 'rally') return;
    d.score += d.count;
    this.stats.longest = Math.max(this.stats.longest, d.count);
    if (d.count >= 8) this.hud.pop(`Rally of ${d.count}!`, 'big');
  }

  _drillNext() {
    const d = this.drill;
    d.rep++;
    if (d.rep >= this._drillReps()) { this._finishDrill(); return; }
    this._drillSetup(false);
  }

  _finishDrill() {
    const d = this.drill, s = this.stats;
    this.phase = 'results';
    this.lastWasDrill = true;
    this.ball.hide();
    this.fx.hideAll();
    this._cancelCharge();
    for (const k in s.xp) s.xp[k] += 0.5;
    this._coach('onDrillEnd'); // the last rep counts in Rafa's lessons too
    const ups = this._applyPendingXp();
    const prof = this.game.profile;
    if (prof) prof.recordMatch({ drill: true });
    try { this.game.saveGame(); } catch (e) { /* ignore */ }
    const rally = d.type === 'rally';
    const max = DRILL_REPS * 3;
    const stars = rally ? RALLY_STARS.filter(n => d.best >= n).length
      : d.score >= max * 0.6 ? 3 : d.score >= max * 0.35 ? 2 : d.score >= max * 0.15 ? 1 : 0;
    this._say(stars >= 2 ? 'Vamos! Now you are hitting.' : 'Bueno. We keep working.', 2.4);
    this._crowd('react', 'drillDone', 0, { stars });
    this.hud.setPlayUi(false);
    this.hud.showResults({
      kind: 'drill', won: stars >= 2, title: DRILLS[d.type].label, sub: `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`,
      score: rally ? `Best rally ${d.best}` : `${d.score} / ${max} pts`,
      stats: rally
        ? [['Best rally', d.best], ['Total shots', d.score], ['Perfect hits', s.perfect], ['Swings', s.swings]]
        : [['In the court', `${s.drill.inCourt}/${DRILL_REPS}`], ['Targets hit', s.drill.targets], ['Perfect hits', s.perfect], ['Swings', s.swings]],
      xp: this._xpShown, ups, tips: this._topTips(), record: prof ? prof.record : null,
    });
    this.game.sound.playMissionComplete && this.game.sound.playMissionComplete();
  }

  // ─────────────────────────── aids (timing ring, marker) ───────────────────────────

  /**
   * The timing read while a ball comes to you (every 0.05 s): for each stroke its ideal contact
   * from where you stand (the peak of the bounce for a groundstroke) → pl.tIdeal (the ideal
   * contact; release LEAD earlier), pl.idealSide (the stroke), pl.idealD (the ball–racket
   * distance then), and the green window you can expect (the meter's band).
   */
  _updateAids(force = false) {
    const fl = this.fl, t = this.t, pl = this.pl;
    if (this.phase === 'rally' && fl.active && !fl.resolved && fl.receiver === 0 && !pl.swung && fl.kind !== 'toss') {
      if (force || !this._aidT || t - this._aidT > 0.05) {
        this._aidT = t;
        const p = this.game.player;
        p.mesh.updateMatrixWorld(true);
        this._flightInfo();
        const pred = this.pred2.from(this.ball);
        let best = INF, bs = pl.idealSide || 0, bt = INF, bd = INF;
        const sd = pl.sideD;
        for (let ci = 0; ci < N_STROKES; ci++) {
          p.character.getContactPointWorld(STROKES[ci], _R[ci]);
          const ic = this._idealFor(ci, _R[ci], pred, t, this._ic[ci]);
          sd[ci] = ic.t < INF ? ic.d + STROKE_BIAS[ci] : INF;
          if (sd[ci] < best) { best = sd[ci]; bs = ci; bt = ic.t; bd = ic.d; }
        }
        pl.tIdeal = bt; pl.idealD = bd; pl.idealSide = bs;
        // The green window to expect at the ideal release (the meter's band): the load you will
        // have then, the ball then
        if (bt < INF) {
          const c = this.chg, cf = this._chargeFull();
          const pw = c.on ? clamp((bt - LEAD - c.t0) / cf, 0, 1) : 0.65;
          const ic = this._ic[bs];
          pred.at(bt);
          const ctx = this._gwCtx || (this._gwCtx = { onRun: false, set: false, slide: false, run: 0, hc: 1, vin: 14, volley: false });
          ctx.onRun = pl.lastSpeed > 3.2 && bs < 3; ctx.set = pl.setT >= 0.22 && pl.lastSpeed < 1.2; ctx.slide = pl.sliding > 0; ctx.run = pl.moved;
          ctx.hc = ic.y - SURF; ctx.vin = Math.hypot(pred.vxr, pred.vyr, pred.vzr); ctx.volley = bs >= 3;
          this._gwEst = this._greenWidth(pw, ctx, SHOTS[this.ctl.shot] || 'topspin');
        }
      }
      const lead = pl.tIdeal - LEAD - t;
      this.hud.timing?.(pl.tIdeal === INF ? -1 : clamp(1 - lead / 1.0, 0, 1.2), pl.idealD < REACH * 0.8);
    } else if (this._aidT) {
      this._aidT = 0;
      this.hud.timing?.(-1);
    }
    this.hud.setStamina(pl.stamina);
  }

  /** Per frame, after the camera: the swing meter at your feet, the Easy cues. */
  _hudFrame() {
    if (!this.hud) return;
    this._meterFrame();
    this._cueFrame();
  }

  /**
   * The load graphic (hud.swingMeter) while you hold SWING: head = hold / full-load time (1 = the
   * full mark), band = the green release window in the same units (where the head will be at the
   * ideal release ± gw), perfect = the ideal release; for a serve the toss mapped the same way
   * (the ideal release at 1). The payload object is reused (the HUD writes the DOM on change only).
   */
  _meterFrame() {
    const M = this._meter, t = this.t, srv = this.srv, c = this.chg, pl = this.pl;
    let on = false;
    if (c.on && this._incoming()) {
      const cf = this._chargeFull();
      M.head = clamp((t - c.t0) / cf, 0, 1.25);
      M.load = Math.min(1, M.head);
      if (pl.tIdeal < INF) {
        const tr = pl.tIdeal - LEAD, gw = this._gwEst;
        M.perfect = (tr - c.t0) / cf; M.band[0] = (tr - gw - c.t0) / cf; M.band[1] = (tr + gw - c.t0) / cf;
      } else { M.perfect = -1; M.band[0] = -1; M.band[1] = -1; }
      M.reach = pl.idealD < REACH * 0.8;
      M.stroke = STROKES[c.stroke]; M.serve = false; M.full = 1;
      on = true;
    } else if (this.phase === 'serve' && srv.who === 0 && srv.started && srv.charging) {
      const hold = srv.tossed ? Math.max(0.2, srv.hold) : 0.85;
      M.head = clamp((t - srv.tPress) / hold, 0, 1.25);
      M.load = Math.min(1, M.head);
      if (srv.tossed) {
        const gw = this._serveGreen(1) / hold;
        M.perfect = 1; M.band[0] = 1 - gw; M.band[1] = 1 + gw;
      } else { M.perfect = -1; M.band[0] = -1; M.band[1] = -1; }
      M.reach = srv.tossed; M.stroke = 'serve'; M.serve = true; M.full = 1;
      on = true;
    }
    if (!on) {
      if (M.on) { M.on = false; this._hudCall('swingMeter', M); }
      return;
    }
    M.on = true;
    this._screenOf(this.game.player.mesh.position, M);
    this._hudCall('swingMeter', M);
  }

  /** CSS px of a point on the court (at the surface) on screen: out.x / out.y. */
  _screenOf(p, out) {
    const cam = this.game.camera;
    cam.updateMatrixWorld();
    _v1.set(p.x, SURF, p.z).project(cam);
    out.x = (_v1.x + 1) * 0.5 * (window.innerWidth || 1);
    out.y = (1 - _v1.y) * 0.5 * (window.innerHeight || 1);
  }

  /**
   * Easy (with the cues option on): when to start the swing, per stroke — 'load' around the
   * moment to press for a ~65 % load (a volley: a short tap), 'swing' as the release window
   * opens; serves: 'toss' (press to toss), then 'swing' as the toss comes down into the green.
   * hud.easyCue(kind, stroke, x, y) every frame inside the cue's window (the HUD fades it after
   * the last call), at your feet (where the meter will be); null once when none applies.
   */
  _cueFrame() {
    let kind = null, stroke = null;
    const t = this.t, ph = this.phase;
    if (this.opts.cues && this.ai && this.ai.diffKey === 'easy' && this.mode && ph !== 'menu' && ph !== 'results') {
      const srv = this.srv, pl = this.pl;
      if (ph === 'serve' && srv.who === 0) {
        if (!srv.started) { if (!this.cam.busy) { kind = 'toss'; stroke = 'serve'; } }
        else if (srv.charging && srv.tossed) {
          const tr = srv.tSweet - SERVE_SWING, gw = this._serveGreen(1);
          if (t >= tr - gw - 0.05 && t <= tr + gw) { kind = 'swing'; stroke = 'serve'; }
        }
      } else if (this._incoming() && pl.tIdeal < INF) {
        const ci = this.chg.on ? this.chg.stroke : pl.idealSide;
        const tr = pl.tIdeal - LEAD;
        if (!this.chg.on) {
          const tl = tr - (ci >= 3 ? 0.2 : 0.65) * this._chargeFull();
          if (t >= tl - 0.12 && t <= tr) kind = 'load';
        } else if (t >= tr - this._gwEst - 0.05 && t <= tr + this._gwEst) kind = 'swing';
        if (kind) stroke = STROKES[ci];
      }
    }
    if (kind) {
      const C = this._cuePos || (this._cuePos = { x: 0, y: 0 });
      this._screenOf(this.game.player.mesh.position, C);
      this._cueK = kind; this._cueS = stroke;
      this._hudCall('easyCue', kind, stroke, C.x, C.y);
    } else if (this._cueK !== null) {
      this._cueK = null; this._cueS = null;
      this._hudCall('easyCue', null, null);
    }
  }

  /**
   * A stroke's verdict: the swing meter shows it (hud.swingResult: kind 'perfect' | 'good' |
   * 'early' | 'late' | 'miss'); a pop instead when the HUD has no meter.
   */
  _verdict(label, kind) {
    if (this.hud && typeof this.hud.swingResult === 'function') this._hudCall('swingResult', label, kind);
    else this.hud.pop(label, kind === 'perfect' ? 'perfect' : kind === 'good' ? 'good' : kind === 'miss' ? 'bad' : 'meh');
  }

  /** Call an optional TennisHUD method (the swing meter, cues, readouts: cosmetic, never fatal). */
  _hudCall(m, a, b, c, d) {
    const h = this.hud;
    if (!h || typeof h[m] !== 'function') return;
    try { h[m](a, b, c, d); } catch (err) {
      if (!this._hudErr) { this._hudErr = true; console.warn('TennisHUD', m, err); }
    }
  }

  // ─────────────────────────── XP, tips ───────────────────────────

  _xp(stat, amount) {
    if (this.stats && stat in this.stats.xp) this.stats.xp[stat] += amount;
  }

  /** Apply the XP collected so far to the profile (once). Returns skill-ups. */
  _applyPendingXp() {
    const ups = [];
    this._xpShown = {};
    if (!this.stats || this._xpApplied) return ups;
    this._xpApplied = true;
    const prof = this.game.profile;
    for (const k in this.stats.xp) {
      const amt = Math.round(Math.min(XP_CAP, this.stats.xp[k]));
      this._xpShown[k] = amt;
      if (amt > 0 && prof) {
        const before = prof.skills[k];
        const gained = prof.addXP(k, amt);
        if (gained) ups.push({ stat: k, from: before, to: prof.skills[k] });
      }
    }
    if (ups.length) {
      this.game.sound.playRankUp && this.game.sound.playRankUp();
    }
    return ups;
  }

  /** Call a TennisCoach hook (tips are cosmetic: an error there never breaks play). */
  _coach(method, a, b) {
    const c = this.coach;
    if (!c || typeof c[method] !== 'function') return undefined;
    try { return c[method](a, b); } catch (err) { console.error('TennisCoach', method, err); return undefined; }
  }

  /** Call a TennisCrowd hook (spectators are cosmetic too). */
  _crowd(method, a, b, c) {
    const cr = this.crowd;
    if (!cr || typeof cr[method] !== 'function') return undefined;
    try { return cr[method](a, b, c); } catch (err) { console.error('TennisCrowd', method, err); return undefined; }
  }

  /**
   * Rafa speaks: the full line on the HUD (readable on phones) and in his speech bubble in the
   * scene — or the short `bubble` version there when one is given (coach tips).
   */
  _say(text, sec = 2.2, bubble = null) {
    try { this.coachNpc.say(bubble || text, sec); } catch (e) { /* cosmetic */ }
    if (this.hud) this.hud.coach(text, sec + 0.6);
  }

  _topTips() {
    const out = this._coach('summary');
    return Array.isArray(out) && out.length ? out : ['Good session. Same time tomorrow?'];
  }

}
