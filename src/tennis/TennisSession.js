import * as THREE from 'three';
import { SIZES, GAME } from '../utils/Constants.js';
import { NPC } from '../entities/NPC.js';
import { storageGet, storageSet } from '../systems/SaveSystem.js';
import {
  TennisBallSim, BallPredictor, planFlight, SPIN, G, R, SURF, BALL_Y, HALF_L, SINGLES_W,
  SERVICE_L, FENCE_V, BASE_V, LINE_TOL, netTop,
} from './TennisBallSim.js';
import { TennisScore, FORMATS } from './TennisScore.js';
import { TennisAI, DIFFICULTY } from './TennisAI.js';
import { TennisHUD } from './TennisHUD.js';
import { TennisCamera } from './TennisCamera.js';
import { TennisFX } from './TennisFX.js';
import { TennisAudio } from './TennisAudio.js';

/**
 * TennisSession — the after-hours tennis mode: an evening hit with Coach Rafa on Court 1
 * under the floodlights. Drills (forehand / backhand / volley / serve, fed by Rafa, with
 * scored targets) or a practice match (real scoring, three formats, three difficulties).
 *
 * While active, Game._update hands the whole frame to update(dt): the session steps physics,
 * NPCs, weather and the world itself, drives the player (joystick / WASD + SWING / shot
 * selector) and runs its own camera. Everything happens on the session clock `t`: the ball
 * is analytic (TennisBallSim), every bounce / net crossing / racket contact is a planned event.
 *
 * Swing timing: pressing SWING starts the stroke so the racket meets the ball LEAD seconds
 * later; the quality comes from how close the predicted ball is to the racket head at that
 * instant (early / late / stretched), plus the PlayerProfile tennis stats.
 *
 * Nothing is saved mid-session: quitting or reloading returns to the post-shift state (the
 * shift phase is untouched); XP and the record are written to the profile (and the save)
 * when a drill or match ends.
 *
 * Debug (dev): __game.tennis.begin('debug'); .startMatch('short', 'easy'); .startDrill('fh');
 *   .bot = { think(session, dt) { ...session.ctl... } }; .externalClock = true; ._tick(dt)
 */

const LEAD = 0.18;              // press → racket contact (s)
const SWING_CONTACT = 0.52;     // forehand / backhand clip contact time
const REACH = 1.2;              // max ball–racket distance at contact that still counts
const SERVE_TS = 1.25, SERVE_SA = 0.3; // player's serve clip: timeScale / startAt
const SERVE_RELEASE = 0.62, SERVE_CONTACT = 1.22;
const INF = Infinity;
const DRILL_REPS = 10;
const XP_CAP = 45;             // per stat, per drill / match
const OPTS_KEY = 'courtcall.tennis';
const SHOTS = ['flat', 'topspin', 'slice', 'lob'];

export const DRILLS = {
  fh: { label: 'Forehand drill', short: 'Forehands' },
  bh: { label: 'Backhand drill', short: 'Backhands' },
  volley: { label: 'Volley drill', short: 'Volleys' },
  serve: { label: 'Serve practice', short: 'Serves' },
};

const TIPS = {
  late: ['Earlier! Meet it out in front.', 'You are late. Start the swing sooner.', 'Racket back early, amigo.'],
  early: ['Wait for it. Patience.', 'Too early. Let the ball come to you.', 'Calm. The ball has no hurry.'],
  far: ['Move your feet! Split step.', 'Feet first. Get behind the ball.', 'Closer! Your arm is not that long.'],
  net: ['Lift it! Brush up with topspin.', 'Over the net, bueno? Aim higher.', 'More net clearance. Topspin is your friend.'],
  long: ['Too long. More spin, less arm.', 'Topspin brings it down. Use it.'],
  wide: ['Aim inside the lines. Big targets.', 'Too fine. Give yourself margin.'],
  double: ['Second serve: spin it in. Do not gift points.', 'Slower second serve. Kick it in.'],
  fault: ['Easy on the power. Find the green zone.', 'Smooth toss, smooth swing.'],
  good: ['Vamos! Beautiful.', 'Bueno! That is tennis.', 'Eso es! Perfect timing.'],
};

const rand = (a, b) => a + Math.random() * (b - a);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = THREE.MathUtils.clamp;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _R = [new THREE.Vector3(), new THREE.Vector3()];

class CourtFrame {
  constructor(court) {
    const cfg = court.config || {};
    this.court = court;
    this.id = court.id;
    this.cx = cfg.center?.x ?? 0; this.cz = cfg.center?.z ?? 0;
    this.r = Number(cfg.rotation) || 0;
    this.c = Math.cos(this.r); this.s = Math.sin(this.r);
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
    this.opts = { assist: true, marker: true, changeEnds: true };
    try {
      const raw = storageGet(OPTS_KEY);
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') for (const k in this.opts) if (typeof o[k] === 'boolean') this.opts[k] = o[k];
    } catch (e) { /* defaults */ }
    this.lastMatch = { format: 'short', diff: 'easy' };
    this.lastDrill = 'fh';

    const courts = (game.world && game.world.courts) || [];
    const court = courts.find(c => c.id === 'court1') || courts.find(c => !c.isClay) || courts[0] || null;
    this.frame = court ? new CourtFrame(court) : null;
    this.coachNpc = (game.npcs || []).find(n => n.id === 'rafa_ibarra') || null;

    this.ctl = { moveX: 0, moveY: 0, swing: false, shot: 1 };
    this._prevSwing = false;
    this._prevDigits = [false, false, false, false];
    this.sides = [1, -1];

    this.fl = {
      active: false, kind: 'none', hitter: 0, receiver: 1, resolved: false, bounces: 0,
      tGround: INF, tNet: INF, tFence: INF, tContact: INF, contactBy: -1, cpt: new THREE.Vector3(),
      netU: 0, netPending: false, let: false, willBeIn: true, landX: 0, landZ: 0, shot: 'flat',
      q: 1, volley: false, touchedByReceiver: false,
    };
    this.srv = { who: 0, started: false, charging: false, charge: 0, tRelease: INF, tContact: INF, tAuto: INF, power: 0, deuce: true, second: false, yaw: 0 };
    this.pl = {
      u: 0, v: 0, yaw: 0, stamina: 1, clip: null, swingFree: 0, swung: false, swing: null,
      ax: 0, az: 0, aValid: false, aFrom: 0, hx: 0, hz: 0, moved: 0, lastSpeed: 0, tIdeal: INF, idealSide: 1,
    };
    this.swing = { tc: INF, clip: 'forehand', q: 0, e: 0, dmin: 0, label: '', volley: false, stretch: 0 };
    this._plan = { vx: 0, vy: 0, vz: 0, T: 0, g: G, hNet: 0, tNet: 0 };
    this._shot = { spin: 'flat', u: 0, v: 0, pace: 12, margin: 0.5, minT: 0, kind: 'rally' };
    this.pred = new BallPredictor();
    this.pred2 = new BallPredictor();
    this.rallyShots = 0;
    this._tipCooldown = 0;
    this._built = false;
  }

  // ─────────────────────────── lazily built parts ───────────────────────────

  _build() {
    if (this._built) return;
    this._built = true;
    const g = this.game;
    this.ball = new TennisBallSim(g.scene);
    this.ai = new TennisAI(this);
    if (this.coachNpc) this.ai.attach(this.coachNpc);
    this.fx = new TennisFX(g.scene);
    this.cam = new TennisCamera(g.camera);
    this.audio = new TennisAudio(g.sound);
    this.hud = new TennisHUD({
      onSwingDown: () => { this._hudSwing = true; },
      onSwingUp: () => { this._hudSwing = false; },
      onShot: (i) => this.setShot(i),
      onStartDrill: (type) => this.startDrill(type),
      onStartMatch: (format, diff) => this.startMatch(format, diff),
      onOption: (k, v) => this.setOption(k, v),
      onLeave: () => this.end(),
      onMenu: () => this.openMenu(true),
      onRematch: () => this._rematch(),
      onChangeMode: () => this.openMenu(false),
      onDone: () => this.end(),
      getProfile: () => this.game.profile,
    });
    this._hudSwing = false;
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
    ds.dialogueBox.show(npc.name, 'The courts are quiet and the lights are on. Stay for a hit after your shift? I will go easy. Maybe.', npc.dialogueColor || '#7db5ee');
    ds.showChoices([
      { label: "Let's hit! 🎾", description: 'Clock out and meet Rafa on Court 1' },
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

    // Evening: 7:30 PM, lights on, dry, weather held
    const w = g.weather;
    this._saved = { frozen: w.clockFrozen, weatherTimer: w.weatherTimer, matches: g.matches ? g.matches.enabled : true, time: w.timeOfDay };
    w.timeOfDay = Math.max(19.5, Math.min(21, w.timeOfDay));
    w.clockFrozen = true;
    const wx = w.getWeather();
    if (wx === 'rainy' || wx === 'stormy') w.setWeather('sunny', true);
    // Court 1 to ourselves
    if (g.matches) {
      g.matches.enabled = false;
      for (const m of g.matches.matches.slice()) if (m.frame.id === this.frame.id) { try { g.matches._finish(m); } catch (e) { /* ignore */ } }
    }
    NPC.setAreaBusy(this.frame.id, true);
    this._setFences(false);

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
    npc.character.setBallVisible(false);

    this.sides[0] = 1; this.sides[1] = -1;
    this._placePlayer(0, BASE_V);
    this.ai.place(0, -BASE_V);
    this.ball.hide();
    this.fx.hideAll();
    this.cam.snap(this);
    document.body.classList.add('cc-tennis');
    this.hud.show();
    this.openMenu(false);
    this.audio.start();
    npc.say(pick(['Vamos! The court is ours.', 'Evening light. The most honest light.', 'Hola! Warm up the feet first.']), 2.6);
    this._resetCtl();
    return true;
  }

  /** Leave the court: back to the club, then the next day (or the report card). */
  end() {
    if (!this.active) return;
    const g = this.game;
    this._applyPendingXp();
    this.active = false;
    this.phase = 'off';
    this.mode = null;
    this.hud.hide();
    this.fx.hideAll();
    this.ball.hide();
    this.audio.stop();
    document.body.classList.remove('cc-tennis');
    this._setFences(true);
    NPC.setAreaBusy(this.frame.id, false);
    const npc = this.coachNpc;
    this.ai.reset();
    npc.stopPlaying();
    const p = g.player;
    p.character.setRacketVisible(false);
    p.character.setBallVisible(false);
    p.character.anim.autoIdleVariants = true;
    p.character.stop(0.2);
    // Walk off beside the court (bench side)
    const wp = g.mapData && g.mapData.waypoints && g.mapData.waypoints[`${this.frame.id}_bench`];
    const x = wp ? wp.x - 1.2 : this.frame.wx(-9.5, 2), z = wp ? wp.z : this.frame.wz(-9.5, 2);
    p.body.position.set(x, SIZES.playerRadius * SIZES.playerScale, z);
    p.body.velocity.set(0, 0, 0);
    p.mesh.position.set(x, 0, z);
    if (g.matches) g.matches.enabled = this._saved ? this._saved.matches : true;
    const w = g.weather;
    if (this._saved) { w.weatherTimer = this._saved.weatherTimer; }
    g.cameraYaw = g.cameraTargetYaw = Math.atan2(this.frame.cx - x, this.frame.cz - z);
    if (g._snapCamera) g._snapCamera();
    g._actionLabel = undefined;
    try { g.saveGame(); } catch (e) { /* ignore */ }
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
  }

  setOption(k, v) {
    if (!(k in this.opts)) return;
    this.opts[k] = !!v;
    try { storageSet(OPTS_KEY, JSON.stringify(this.opts)); } catch (e) { /* ignore */ }
    if (k === 'marker' && !v) this.fx.hideMarker();
  }

  setShot(i) {
    if (i < 0 || i > 3) return;
    this.ctl.shot = i;
    if (this.hud) this.hud.setShot(i);
  }

  openMenu(abandon) {
    if (abandon && (this.phase !== 'menu' && this.phase !== 'results')) this._applyPendingXp();
    this.phase = 'menu';
    this.mode = null;
    this.ball.hide();
    this.fx.hideAll();
    this.ai.reset();
    this.hud.hideResults();
    this.hud.setPlayUi(false);
    this.hud.showMenu({ opts: this.opts, last: this.lastMatch, lastDrill: this.lastDrill, profile: this.game.profile });
    this._placePlayer(0, BASE_V * this.sides[0]);
    this.ai.place(0, BASE_V * this.sides[1]);
  }

  _resetCtl() {
    this.ctl.moveX = this.ctl.moveY = 0;
    this.ctl.swing = false;
    this._prevSwing = false;
    this._hudSwing = false;
  }

  _setFences(on) {
    // The two back fences (chain link + windscreen) of our court would block the camera
    const m = this.frame && this.frame.court && this.frame.court.mesh;
    if (!m) return;
    for (const ch of m.children) {
      if (ch.name === 'court-chain' || ch.name === 'court-wind' || ch.name === 'court-sign') ch.visible = on;
    }
  }

  // ─────────────────────────── modes ───────────────────────────

  _newStats() {
    this.stats = {
      winners: [0, 0], errors: [0, 0], aces: [0, 0], doubles: [0, 0], points: [0, 0],
      rallies: 0, rallyShots: 0, longest: 0, perfect: 0, swings: 0, hits: 0, reached: 0,
      serveIn: 0, serves: 0, tips: new Map(),
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
    this.ai.setDifficulty(this.lastMatch.diff);
    this.score = new TennisScore({ format: this.format, firstServer: Math.random() < 0.5 ? 0 : 1 });
    this.sides[0] = 1; this.sides[1] = -1;
    this._newStats();
    this.faults = 0;
    this.pl.stamina = 1;
    this.hud.hideMenu();
    this.hud.hideResults();
    this.hud.setPlayUi(true, 'match');
    this.hud.setInfo(`Practice match · ${FORMATS[this.format].label} · ${DIFFICULTY[this.lastMatch.diff].label}`);
    this._updateScoreboard();
    this._say(pick(['Bueno. Real points now.', 'Vamos! Show me what you have.', 'Play smart. Not hard. Smart.']), 2.2);
    this._setupPoint(true);
  }

  startDrill(type = 'fh') {
    if (!this.active) return;
    if (!DRILLS[type]) type = 'fh';
    this.lastDrill = type;
    this.mode = 'drill';
    this.drill = { type, rep: 0, score: 0 };
    this.sides[0] = 1; this.sides[1] = -1;
    this.ai.setDifficulty('easy');
    this._newStats();
    this.faults = 0;
    this.pl.stamina = 1;
    this.hud.hideMenu();
    this.hud.hideResults();
    this.hud.setPlayUi(true, 'drill');
    this._drillTargets();
    this._say(type === 'serve' ? 'Serves. Hold, release in the green.' : type === 'volley' ? 'At the net. Short, firm punch.' : 'I feed, you hit the targets. Vamos.', 2.4);
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

    // Physics (NPC bodies), NPCs, scheduled member matches winding down
    g.physicsWorld.step(1 / 60, dt, 3);
    const pp = g.player.mesh.position;
    for (const npc of g.npcs) npc.update(dt, pp);
    if (g.matches) g.matches.update(dt);

    try { this._updatePlay(dt); } catch (err) {
      console.error('TennisSession error — back to the menu', err);
      this.openMenu(false);
    }

    // World, weather (lights / shadows centred on the court), camera, HUD bits
    g.world.update(dt, pp);
    g.weather.weatherTimer = Math.max(g.weather.weatherTimer, 30); // hold the evening
    _v1.set(this.frame.cx, 0, this.frame.cz);
    g.weather.setShadowFocus(_v1);
    g.weather.update(dt);
    this.cam.update(this, dt);
    this.fx.update(dt);
    if (g.hud) g.hud.update(dt);
    this.audio.update(dt);
  }

  _readControls(dt) {
    const c = this.ctl;
    if (this.bot) { this.bot.think(this, dt); return; }
    const inp = this.game.input;
    const mv = inp.getMoveDirection();
    c.moveX = mv.x; c.moveY = mv.y;
    const k = inp.keys;
    c.swing = !!(this._hudSwing || (inp.enabled && (k.Space || k.KeyJ)));
    for (let i = 0; i < 4; i++) {
      const down = !!k['Digit' + (i + 1)];
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
    this._updatePlayer(dt);
    this._updateBall(dt);
    this._updateAids();

    if (this._tipCooldown > 0) this._tipCooldown -= dt;
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
    p.body.position.set(x, SIZES.playerRadius * SIZES.playerScale, z);
    p.body.velocity.set(0, 0, 0);
    p.mesh.position.set(x, SURF, z);
    this.pl.u = u; this.pl.v = v;
    this.pl.yaw = f.r + (this.sides[0] > 0 ? Math.PI : 0);
    p.mesh.rotation.y = this.pl.yaw;
    p.mesh.updateMatrixWorld(true);
    this.pl.swung = false;
    this.pl.aValid = false;
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
      const speed = this._speed();
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
    pl.u = clamp(pl.u + vu * dt, -7.4, 7.4);
    const vmin = this.mode === 'drill' && this.drill && this.drill.type === 'volley' ? 1.2 : 0.8;
    pl.v = side * clamp(side * (pl.v + vv * dt), vmin, 14.0);
    const moved = Math.hypot(vu, vv);
    pl.lastSpeed = moved;
    if (pl.tracking) pl.moved += moved * dt;
    const x = f.wx(pl.u, pl.v), z = f.wz(pl.u, pl.v);
    p.body.position.x = x; p.body.position.z = z;
    p.body.position.y = SIZES.playerRadius * SIZES.playerScale;
    p.body.velocity.set(0, 0, 0);
    p.mesh.position.set(x, SURF, z);
    // Face the net while playing (serve: the target box)
    const yaw = this.phase === 'serve' && this.srv.who === 0 ? this.srv.yaw : pl.yaw;
    let dy = yaw - p.mesh.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    p.mesh.rotation.y += dy * Math.min(1, dt * 14);

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

  _onSwingDown() {
    if (!this.active) return;
    const ph = this.phase, s = this.srv;
    if (ph === 'serve' && s.who === 0 && !s.started) {
      s.charging = true; s.charge = 0;
      return;
    }
    if ((ph === 'rally') && this.fl.active && !this.fl.resolved && this.fl.receiver === 0 && !this.pl.swung && this.fl.kind !== 'toss') {
      this._playerSwing();
      return;
    }
    // A practice swing
    if (ph !== 'serve' && this.t >= this.pl.swingFree && (ph === 'menu' || ph === 'rally' || ph === 'feedWait' || ph === 'results')) {
      const ch = this.game.player.character;
      ch.play(this.ctl.shot === 2 ? 'backhand' : 'forehand', { fade: 0.08, startAt: SWING_CONTACT - LEAD });
      this.pl.swingFree = this.t + LEAD + 0.3;
      this.pl.clip = null;
    }
  }

  _onSwingUp() {
    const s = this.srv;
    if (this.phase === 'serve' && s.who === 0 && s.charging && !s.started) {
      s.charging = false;
      if (s.charge < 0.06) { this.hud.setMeter(-1); return; } // a tap: nothing
      this._startServe(0, s.charge);
    }
  }

  /** Evaluate the swing against the predicted ball and schedule the racket contact. */
  _playerSwing() {
    const g = this.game, p = g.player, ch = p.character, t = this.t, fl = this.fl, sw = this.swing, pl = this.pl;
    const tc = t + LEAD;
    pl.swung = true;
    this.stats.swings++;
    p.mesh.rotation.y = pl.yaw;
    p.mesh.updateMatrixWorld(true);
    const pred = this.pred.from(this.ball);
    let best = -1, bestD = INF, bestT = 0, bestDc = INF;
    for (let ci = 0; ci < 2; ci++) {
      const Rv = _R[ci];
      ch.getContactPointWorld(ci === 0 ? 'forehand' : 'backhand', Rv);
      let dmin = INF, tmin = 0;
      for (let tt = t; tt <= tc + 0.6; tt += 0.01) {
        const nb = pred.at(tt);
        if (this.ball.bounced + nb >= 2) break;
        const d = Math.hypot(pred.x - Rv.x, pred.y - Rv.y, pred.z - Rv.z);
        if (d < dmin) { dmin = d; tmin = tt; }
      }
      const nbc = pred.at(tc);
      const dc = this.ball.bounced + nbc >= 2 ? INF : Math.hypot(pred.x - Rv.x, pred.y - Rv.y, pred.z - Rv.z);
      const score = dmin + dc * 0.35;
      if (score < bestD) { bestD = score; best = ci; bestT = tmin; bestDc = dc; sw.dmin = dmin; }
    }
    const clip = best === 1 ? 'backhand' : 'forehand';
    const e = tc - bestT;             // + late, − early
    sw.clip = clip; sw.e = e; sw.tc = tc;
    // Start the stroke so the racket meets the ball LEAD seconds from now
    ch.play(clip, { fade: 0.06, startAt: SWING_CONTACT - LEAD });
    pl.clip = null;
    pl.swingFree = tc + 0.28;
    pl.stamina = Math.max(0, pl.stamina - 0.008);
    pl.aValid = false;
    this.hud.timing(-1);

    const pred2 = this.pred.at(tc);
    const volley = this.ball.bounced + pred2 === 0;
    const hy = this.pred.y - SURF;
    if (!(bestDc < REACH) || hy > 2.7) {
      // Whiff
      sw.q = 0;
      sw.label = bestT > tc + 0.1 ? 'Too early' : bestT < tc - 0.1 ? 'Too late' : 'Too far';
      this._miss = sw.label;
      this.hud.pop(sw.label, 'bad');
      this._noteMistake(sw.label === 'Too early' ? 'early' : sw.label === 'Too late' ? 'late' : 'far');
      return;
    }
    const timingQ = clamp(1 - (Math.abs(e) / 0.15) ** 2, 0, 1);
    const reachQ = clamp(1 - Math.max(0, sw.dmin - 0.3) / 0.85, 0, 1);
    sw.q = clamp(timingQ * 0.65 + reachQ * 0.35, 0.05, 1);
    sw.stretch = clamp((bestDc - 0.55) / 0.65, 0, 1);
    sw.volley = volley;
    if (Math.abs(e) <= 0.04 && sw.dmin < 0.5) { sw.label = 'Perfect!'; this.stats.perfect++; }
    else if (sw.q > 0.72) sw.label = 'Good';
    else if (sw.stretch > 0.6) sw.label = 'Stretch';
    else sw.label = e < 0 ? 'Early' : 'Late';
    this.hud.pop(sw.label, sw.label === 'Perfect!' ? 'perfect' : sw.q > 0.72 ? 'good' : 'meh');
    if (sw.label === 'Early') this._noteMistake('early', true);
    else if (sw.label === 'Late') this._noteMistake('late', true);
    else if (sw.label === 'Stretch') this._noteMistake('far', true);
    this.scheduleContact(0, tc, _R[best]);
  }

  // ─────────────────────────── ball / flights ───────────────────────────

  /**
   * A racket will meet the ball at (tc, pt): bend the rest of the flight onto it (or, if the
   * ball still has to bounce first, the bounce handler aims the rebound there).
   */
  scheduleContact(by, tc, pt) {
    const fl = this.fl, b = this.ball, t = this.t;
    if (fl.resolved || !fl.active) return;
    fl.contactBy = by; fl.tContact = tc; fl.cpt.copy(pt);
    if (fl.tGround < tc && b.bounced === 0 && !(fl.netPending && fl.tNet < tc)) return; // bounce first
    if (fl.netPending && fl.tNet <= tc) return; // it will not get here (net)
    b.at(t);
    _v2.copy(b.pos);
    const T = Math.max(0.03, tc - t);
    const gg = b.g;
    b.launchG(t, _v2.x, _v2.y, _v2.z, (pt.x - _v2.x) / T, (pt.y - _v2.y + 0.5 * gg * T * T) / T, (pt.z - _v2.z) / T, gg);
    fl.tGround = b.timeToHeight(BALL_Y);
    if (fl.tGround < tc) fl.tGround = INF; // aimed above the court
    fl.tFence = INF;
  }

  /** Toss (serve) or feed: ball from the hand to the hitter's contact point in tau seconds. */
  launchToss(who, from, tau, clip) {
    const b = this.ball, fl = this.fl, t = this.t;
    const ch = who === 0 ? this.game.player.character : this.coachNpc.character;
    (who === 0 ? this.game.player.mesh : this.coachNpc.mesh).updateMatrixWorld(true);
    ch.getContactPointWorld(clip, _v2);
    const T = tau;
    b.launchG(t, from.x, from.y, from.z, (_v2.x - from.x) / T, (_v2.y - from.y + 0.5 * G * T * T) / T, (_v2.z - from.z) / T, G);
    b.spin = 'feed'; b.bounced = 0;
    fl.active = true; fl.kind = 'toss'; fl.hitter = who; fl.receiver = who; fl.resolved = false;
    fl.bounces = 0; fl.let = false; fl.netPending = false; fl.tNet = INF; fl.tFence = INF;
    fl.contactBy = who; fl.tContact = t + T; fl.cpt.copy(_v2);
    fl.tGround = INF;
    fl.tossClip = clip;
  }

  /** Launch a shot from C to court-local (u, v). */
  _launchShot(hitter, kind, spin, C, u, v, pace, margin, minT = 0) {
    const f = this.frame, b = this.ball, fl = this.fl, t = this.t;
    const sp = SPIN[spin] || SPIN.flat;
    const g = G * sp.g;
    const cu = f.lu(C.x, C.z), cv = f.lv(C.x, C.z);
    let fr = -1, nu = 0;
    if ((cv > 0) !== (v > 0) && Math.abs(v - cv) > 1e-3) { fr = (0 - cv) / (v - cv); nu = cu + (u - cu) * fr; }
    const bx = f.wx(u, v), bz = f.wz(u, v);
    const P = planFlight(this._plan, C.x, C.y, C.z, bx, bz, pace, g, margin, fr, nu, minT);
    if (margin < 0 && fr > 0 && fr < 1 && P.hNet >= netTop(nu) + R) {
      // A netted shot: fly on a low line straight into the tape (below it by -margin)
      const nx = f.wx(nu, 0), nz = f.wz(nu, 0);
      const ny = Math.max(SURF + 0.3, netTop(nu) + R + margin);
      const Tn = Math.max(0.2, Math.hypot(nx - C.x, nz - C.z) / Math.max(6, pace));
      P.vx = (nx - C.x) / Tn; P.vz = (nz - C.z) / Tn; P.vy = (ny - C.y + 0.5 * g * Tn * Tn) / Tn;
      P.tNet = Tn; P.hNet = ny;
      P.T = Tn + 1; // (never reached: the net comes first)
    }
    b.launchG(t, C.x, C.y, C.z, P.vx, P.vy, P.vz, g);
    b.spin = spin; b.bounced = 0;
    fl.active = true; fl.kind = kind; fl.hitter = hitter; fl.receiver = 1 - hitter; fl.resolved = false;
    fl.bounces = 0; fl.let = false; fl.contactBy = -1; fl.tContact = INF; fl.shot = spin;
    fl.touchedByReceiver = false;
    fl.netU = nu;
    fl.netPending = fr > 0 && fr < 1 && P.hNet < netTop(nu) + R;
    fl.tNet = fl.netPending ? t + P.tNet : INF;
    fl.netH = P.hNet;
    fl.tGround = t + P.T;
    fl.tFence = INF;
    fl.landX = bx; fl.landZ = bz;
    fl.willBeIn = !fl.netPending && this._isIn(u, v, kind, hitter);
    if (kind !== 'toss') this.rallyShots++;
    this._onFlight();
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
  _onFlight() {
    const fl = this.fl;
    if (fl.receiver === 1) {
      if (this.mode === 'match') this.ai.onIncoming(this.t, fl.willBeIn);
      this.fx.hideMarker();
      this.pl.aValid = false;
      // After your shot: drift back to the middle
      const side = this.sides[0];
      if (!(this.mode === 'drill' && this.drill.type === 'volley')) {
        this.pl.ax = clamp(this.pl.u * 0.35, -1.5, 1.5); this.pl.az = side * BASE_V; this.pl.aValid = this.mode === 'match'; this.pl.aFrom = this.t + 0.3;
      }
    } else {
      this.pl.swung = false;
      this.pl.moved = 0; this.pl.tracking = true;
      this._planAssist();
      this.pl.aFrom = this.t + 0.22; // the assist "reads" the ball after a reaction time
      if (this.opts.marker) this.fx.showMarker(fl.landX, SURF, fl.landZ, fl.willBeIn);
    }
  }

  /** Where should the player stand to meet the incoming ball? (assist target) */
  _planAssist() {
    const pl = this.pl, fl = this.fl, f = this.frame, t = this.t;
    const pred = this.pred2.from(this.ball);
    const ch = this.game.player.character;
    const sc = SIZES.playerScale;
    const yaw = pl.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const side = this.sides[0];
    const fh = this.ai.fh, bh = this.ai.bh;
    const px = f.wx(pl.u, pl.v), pz = f.wz(pl.u, pl.v);
    const volleyZone = pl.v * side < 7.5;
    let best = INF;
    pl.aValid = false;
    for (let tt = t + 0.15; tt < t + 3.2; tt += 0.02) {
      const nb = pred.at(tt);
      const tot = this.ball.bounced + nb;
      if (tot >= 2) break;
      if (tot === 0 && !volleyZone) continue;
      if (tot === 0 && f.lv(pred.x, pred.z) * side < 0.8) continue; // not over the net yet
      for (let ci = 0; ci < 2; ci++) {
        const cp = ci === 0 ? fh : bh;
        const hc = SURF + cp.y * sc;
        const dy = Math.abs(pred.y - hc);
        if (dy > (tot === 0 ? 0.9 : 0.5)) continue;
        const ox = (cp.x * cy + cp.z * sy) * sc, oz = (-cp.x * sy + cp.z * cy) * sc;
        const sx = pred.x - ox, sz = pred.z - oz;
        const su = f.lu(sx, sz), sv = f.lv(sx, sz) * side;
        if (sv < 0.9 || sv > 14 || Math.abs(su) > 7.4) continue;
        const cost = Math.hypot(sx - px, sz - pz);
        const score = cost + dy * 2 + (tt - t) * 0.25 + (ci === 1 ? 0.1 : 0);
        if (score < best) {
          best = score;
          pl.ax = su; pl.az = sv * side; pl.aValid = true;
          pl.tIdeal = tt; pl.idealSide = ci;
        }
      }
    }
    void ch;
  }

  _updateBall(dt) {
    const b = this.ball, fl = this.fl, t = this.t;
    if (!fl.active && !b.rolling) { if (b.shown) b.sync(false); return; }
    let guard = 0;
    while (guard++ < 8) {
      const te = Math.min(fl.tContact, fl.tGround, fl.tNet, fl.tFence);
      if (!(t >= te)) break;
      if (te === fl.tContact) this._evContact(te);
      else if (te === fl.tNet) this._evNet(te);
      else if (te === fl.tGround) this._evGround(te);
      else this._evFence(te);
    }
    if (b.rolling) {
      b.stepRoll(dt);
      const v = this.frame.lv(b.pos.x, b.pos.z);
      if (Math.abs(v) > FENCE_V) { b.v0.x = 0; b.v0.z = 0; }
    } else if (fl.active) b.at(t);
    if (!b.active) return;
    b.sync(true);
  }

  _evContact(te) {
    const fl = this.fl, b = this.ball;
    const who = fl.contactBy;
    b.at(te);
    fl.tContact = INF; fl.contactBy = -1;
    this.audio.hit(b.pos, fl.kind === 'toss' && this.phase === 'serve' ? 1.1 : 0.9);
    if (fl.kind === 'toss') {
      if (this.phase === 'serve' && this.srv.who === who) this._serveShot(who);
      else this._feedShot();
      return;
    }
    if (fl.resolved) { this._deadBounceFromHere(te); return; }
    if (who === fl.receiver) fl.touchedByReceiver = true;
    if (who === 0) this._playerShot();
    else this._aiShot();
  }

  _evNet(te) {
    const fl = this.fl, b = this.ball;
    b.at(te);
    const pos = b.pos;
    fl.tNet = INF; fl.netPending = false;
    const top = netTop(fl.netU) + R;
    this.audio.net(pos);
    if (fl.netH >= top - 0.07) {
      // Net cord: it trickles over, slower
      const vx = b.v0.x * 0.55, vz = b.v0.z * 0.55, vy = Math.max(0.7, Math.abs(b.vyAt(te)) * 0.35);
      b.launchG(te, pos.x + vx * 0.02, Math.max(pos.y, top + 0.02), pos.z + vz * 0.02, vx, vy, vz, b.g);
      fl.tGround = b.timeToHeight(BALL_Y);
      if (fl.kind === 'serve') fl.let = true;
      // Re-read where it lands
      b.at(fl.tGround);
      const lu = this.frame.lu(b.pos.x, b.pos.z), lv = this.frame.lv(b.pos.x, b.pos.z);
      fl.landX = b.pos.x; fl.landZ = b.pos.z;
      fl.willBeIn = this._isIn(lu, lv, fl.kind, fl.hitter);
      b.at(te);
      this.hud.pop('Net cord!', 'call');
      this._onFlight();
      return;
    }
    // Into the net
    b.launchG(te, pos.x - b.v0.x * 0.01, Math.max(pos.y, BALL_Y), pos.z - b.v0.z * 0.01, -b.v0.x * 0.08, 0.3, -b.v0.z * 0.08, G);
    b.spin = 'dead'; b.bounced = 3;
    fl.tGround = b.timeToHeight(BALL_Y);
    this._cancelContact();
    if (!fl.resolved) {
      if (fl.kind === 'serve') this._fault('net');
      else this._resolve(1 - fl.hitter, 'net');
    }
  }

  _evGround(te) {
    const fl = this.fl, b = this.ball, f = this.frame;
    b.at(te);
    const pos = b.pos;
    fl.tGround = INF;
    this.audio.bounce(pos);
    const u = f.lu(pos.x, pos.z), v = f.lv(pos.x, pos.z);
    const vx = b.v0.x, vy = b.vyAt(te), vz = b.v0.z;
    if (!fl.resolved && fl.kind !== 'toss') {
      const onReceiverSide = v * this.sides[fl.receiver] > 0;
      if (fl.bounces === 0) {
        if (!onReceiverSide || !this._isIn(u, v, fl.kind, fl.hitter)) {
          if (fl.kind === 'serve') this._fault('out');
          else this._resolve(fl.receiver, 'out');
        } else {
          fl.bounces = 1;
          this.fx.hideMarker();
          if (fl.kind === 'serve' && fl.let) this._resolve(-1, 'let');
          else if (this.mode === 'drill' && fl.hitter === 0) this._drillLanded(u, v);
          else if (fl.kind === 'serve' && fl.hitter === 0) { this.stats.serveIn++; this._xp('serve', this.srv.second ? 0.4 : 0.6); }
          else if (fl.hitter === 0) { this._xp('control', 0.5); if (fl.shot === 'topspin' || fl.shot === 'slice') this._xp('spin', 0.3); }
        }
      } else if (fl.bounces >= 1) {
        // Second bounce: the receiver never got it back
        this._resolve(fl.hitter, fl.kind === 'serve' && !fl.touchedByReceiver ? 'ace' : 'winner');
      }
    }
    // Rebound: onto a scheduled racket, or physical
    if (!fl.resolved && fl.contactBy >= 0 && fl.tContact > te && b.bounced === 0) {
      b.bounced = 1;
      const T = fl.tContact - te;
      const g2 = G * (SPIN[b.spin] || SPIN.flat).g2;
      const pt = fl.cpt;
      b.launchG(te, pos.x, BALL_Y, pos.z, (pt.x - pos.x) / T, (pt.y - BALL_Y + 0.5 * g2 * T * T) / T, (pt.z - pos.z) / T, g2);
      fl.tGround = INF;
      return;
    }
    this._physicalBounce(te, vx, vy, vz);
  }

  _physicalBounce(te, vx, vy, vz) {
    const b = this.ball, fl = this.fl, f = this.frame;
    const first = b.bounced === 0;
    const sp = first ? (SPIN[b.spin] || SPIN.flat) : SPIN.dead;
    b.bounced++;
    const nvx = vx * sp.kh, nvz = vz * sp.kh, nvy = -vy * sp.e;
    const pos = b.pos;
    if (nvy < 0.8) {
      b.roll(te, nvx, nvz);
      fl.tGround = INF; fl.tFence = INF;
      return;
    }
    const g2 = G * sp.g2;
    b.launchG(te, pos.x, BALL_Y, pos.z, nvx, nvy, nvz, g2);
    fl.tGround = te + 2 * nvy / g2;
    // Back fence before the next bounce?
    fl.tFence = INF;
    const v0 = f.lv(pos.x, pos.z), vv = nvx * f.s + nvz * f.c;
    if (Math.abs(vv) > 1e-3) {
      const tf = (Math.sign(vv) * FENCE_V - v0) / vv;
      if (tf > 0.01 && te + tf < fl.tGround) fl.tFence = te + tf;
    }
  }

  _evFence(te) {
    const b = this.ball, fl = this.fl, f = this.frame;
    b.at(te);
    const pos = b.pos;
    fl.tFence = INF;
    const vx = b.v0.x, vy = b.vyAt(te), vz = b.v0.z;
    const lu = vx * f.c - vz * f.s, lv = vx * f.s + vz * f.c;
    const nu = lu * 0.4, nv = -lv * 0.25;
    b.launchG(te, pos.x, pos.y, pos.z, nu * f.c + nv * f.s, Math.min(vy, 0.5), -nu * f.s + nv * f.c, G);
    b.bounced = Math.max(b.bounced, 2);
    fl.tGround = b.timeToHeight(BALL_Y);
    if (!fl.resolved && fl.kind !== 'toss') {
      if (fl.bounces === 0) { if (fl.kind === 'serve') this._fault('out'); else this._resolve(fl.receiver, 'out'); }
      else this._resolve(fl.hitter, fl.kind === 'serve' && !fl.touchedByReceiver ? 'ace' : 'winner');
    }
  }

  _deadBounceFromHere(te) {
    const b = this.ball, fl = this.fl;
    fl.tGround = b.timeToHeight(BALL_Y);
  }

  // ─────────────────────────── shots ───────────────────────────

  _stats() {
    const st = this.game.profile ? this.game.profile.getTennisStats() : null;
    const o = this._statCopy || (this._statCopy = {});
    o.power = st ? st.power : 30; o.control = st ? st.control : 30; o.spin = st ? st.spin : 30;
    o.speed = st ? st.speed : 30; o.serve = st ? st.serve : 30; o.stamina = st ? st.stamina : 30;
    return o;
  }

  /** The player's stroke: aim (stick at contact), shot type, timing quality and stats. */
  _playerShot() {
    const fl = this.fl, sw = this.swing, b = this.ball, c = this.ctl;
    const st = this._stats();
    const side = this.sides[0], opp = -side;
    const q = sw.q, fat = 0.75 + 0.25 * this._fatigue();
    let spin = SHOTS[c.shot] || 'topspin';
    const volley = sw.volley;
    this.stats.hits++;
    if (this.pl.moved > 3) { this.stats.reached++; this._xp('speed', 0.35); }
    this.pl.tracking = false;

    // Aim in screen space: right = the player's right. Early pulls cross, late pushes out.
    const pull = clamp(sw.e / 0.1, -1.5, 1.5) * 1.1 * (sw.clip === 'forehand' ? 1 : -1);
    let xs = clamp(c.moveX, -1, 1) * 3.6 + pull;
    let depth = 9.4 - clamp(c.moveY, -1, 1) * (c.moveY < 0 ? 1.9 : 3.6);
    let pace, margin, minT = 0;
    const pw = st.power / 100, ct = st.control / 100, spn = st.spin / 100;
    switch (spin) {
      case 'flat': pace = 15 + 8 * pw; margin = 0.48; break;
      case 'slice': pace = 11 + 4 * pw; margin = 0.28; depth -= 0.4; break;
      case 'lob': pace = 8.5 + 1.5 * pw; margin = 2.8; minT = 1.55 + 0.25 * (1 - q); depth = Math.max(depth, 10.2); break;
      default: pace = 13 + 6 * pw; margin = 0.7 + 0.45 * spn; spin = 'topspin';
    }
    if (volley) { pace *= 0.82; depth = 6.2 - clamp(c.moveY, -1, 1) * 2.2; margin = Math.min(margin, 0.35); if (spin === 'lob') { depth = 10; } }
    pace *= (0.68 + 0.32 * q) * fat * (1 - sw.stretch * 0.25);
    depth *= 1 - sw.stretch * 0.18;
    // Scatter: control, timing, fatigue; spin keeps topspin in (dips)
    // Pressure: a fast or high incoming ball is harder to control
    const vin = Math.hypot(b.v0.x, b.v0.z);
    const press = 1 + clamp((vin - 11) / 9, 0, 0.7) + clamp((b.pos.y - SURF - 1.3) / 1.2, 0, 0.4);
    const sigma = (0.45 + (1 - ct) * 1.1) * (1.5 - q * 0.6) * (2 - fat) * press * (spin === 'topspin' ? 0.85 : spin === 'flat' ? 1.12 : 1);
    xs += gauss() * sigma;
    depth += gauss() * sigma * (spin === 'topspin' ? 0.8 : 1.1);
    const sm = (0.2 + (1 - q) * 0.45 + (1 - ct) * 0.18) * (spin === 'flat' ? 1.3 : spin === 'topspin' ? 0.8 : 1) * (2 - fat) * press;
    margin += gauss() * sm;
    if (spin === 'lob') margin = Math.max(margin, 0.5);
    const u = side * xs, v = opp * depth;
    this._lastShotQ = q;
    this._launchShot(0, 'rally', spin, b.pos, u, v, pace, margin, minT);
    this.pl.swung = true;
    fl.q = q;
  }

  _aiShot() {
    const fl = this.fl, b = this.ball, ai = this.ai;
    const pressure = clamp((ai.plan.stretch || 0) - 0.5, 0, 1) + (this._lastShotQ > 0.9 ? 0.25 : 0) + (fl.shot === 'flat' ? 0.1 : 0);
    const s = ai.chooseShot(this._shot, pressure);
    this._launchShot(1, 'rally', s.spin, b.pos, s.u, s.v, s.pace, s.margin, s.minT);
    ai.recover(this.t, 0.5);
    this.coachNpc.character.setBallVisible(false);
  }

  _feedShot() {
    const plan = this.ai.feedPlan, b = this.ball;
    if (!plan) return;
    this._launchShot(1, 'rally', plan.spin, b.pos, plan.u, plan.v, plan.pace, plan.margin, 0);
    this.phase = 'rally';
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
    const s = this.sides[who], r = -s;
    const sp = this._serveSpot(who, deuce);
    const bu = (deuce ? r : -r) * 2.3, bv = r * 4.5;
    srv.yaw = Math.atan2(f.wx(bu, bv) - f.wx(sp.u, sp.v), f.wz(bu, bv) - f.wz(sp.u, sp.v));
    // Receiver
    // Receiver: on his right (deuce) or left (ad) half, behind the baseline
    this._placeAt(who, sp.u, sp.v);
    this._placeAt(1 - who, (deuce ? -s : s) * 2.6, r * (HALF_L + 0.7));
    this.phase = 'serve';
    this.fl.active = false; this.fl.resolved = false; this.fl.kind = 'none';
    this.ball.hide();
    this.fx.hideMarker();
    this.rallyShots = 0;
    if (who === 0) {
      this.game.player.character.setBallVisible(true);
      this.game.player.mesh.rotation.y = srv.yaw;
      this.hud.setMeter(0);
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
    if (srv.who === 0 && srv.charging && !srv.started) {
      srv.charge = Math.min(1.25, srv.charge + dt / 1.05);
      this.hud.setMeter(srv.charge);
    }
    if (srv.who === 1 && !srv.started && t >= srv.tAuto) this._startServe(1, 0.8);
    if (srv.started && t >= srv.tRelease) {
      srv.tRelease = INF;
      const ch = srv.who === 0 ? this.game.player.character : this.coachNpc.character;
      (srv.who === 0 ? this.game.player.mesh : this.coachNpc.mesh).updateMatrixWorld(true);
      ch.getBallHandWorldPosition(_v1);
      ch.setBallVisible(false);
      this.launchToss(srv.who, _v1, srv.tContact - t, 'serve');
      // Receiver split-steps as the serve is struck
      if (srv.who === 0) this.ai.tSplit = srv.tContact - 0.1;
    }
  }

  _startServe(who, power) {
    const srv = this.srv, t = this.t;
    srv.started = true; srv.power = power;
    if (who === 0) {
      const p = this.game.player;
      p.mesh.rotation.y = srv.yaw;
      p.character.play('serve', { fade: 0.12, timeScale: SERVE_TS, startAt: SERVE_SA });
      this.pl.clip = null;
      srv.tRelease = t + (SERVE_RELEASE - SERVE_SA) / SERVE_TS;
      srv.tContact = t + (SERVE_CONTACT - SERVE_SA) / SERVE_TS;
      this.pl.swingFree = srv.tContact + 0.35;
      this.hud.setServeHint(false);
      this.hud.setMeter(-1);
      this.stats.serves++;
    } else {
      const npc = this.coachNpc;
      npc.stopMove();
      npc.mesh.rotation.y = srv.yaw;
      npc.setFacing(srv.yaw, true);
      npc.swing('serve', { fade: 0.15 });
      srv.tRelease = t + SERVE_RELEASE;
      srv.tContact = t + SERVE_CONTACT;
    }
  }

  _serveShot(who) {
    const srv = this.srv, b = this.ball, c = this.ctl;
    this.phase = 'rally';
    if (who === 1) {
      const s = this.ai.chooseServe(this._shot, srv.deuce, srv.second);
      this._launchShot(1, 'serve', s.spin, b.pos, s.u, s.v, s.pace, s.margin, 0);
      this.ai.recover(this.t, 0.6);
      return;
    }
    const st = this._stats();
    const sv = st.serve / 100;
    const p = srv.power;
    const over = Math.max(0, p - 0.93), under = Math.max(0, 0.55 - p);
    const side = this.sides[0], r = -side;
    const sgnScreen = srv.deuce ? -1 : 1;
    const second = srv.second;
    let uScreen = sgnScreen * 2.3 + clamp(c.moveX, -1, 1) * 1.75;
    let depth = 5.6 - clamp(c.moveY, -1, 1) * 0.8;
    let pace = (12.5 + 9.5 * Math.min(p, 1) * (0.55 + 0.45 * sv)) * (second ? 0.8 : 1);
    const sigma = (0.32 + (1 - sv) * 0.72 + over * 2.4) * (second ? 0.6 : 1);
    uScreen += gauss() * sigma;
    depth += gauss() * sigma * 0.85 + over * 3.2;
    let margin = (second ? 0.45 : 0.13 + under * 0.6) + gauss() * (0.1 + (1 - sv) * 0.2 + over * 0.5) * (second ? 0.7 : 1);
    const spin = second ? 'kick' : 'serve';
    if (under > 0) pace *= 0.9;
    this._launchShot(0, 'serve', spin, b.pos, side * uScreen, r * depth, pace, margin, 0);
    this.hud.setMeter(-1);
  }

  /** A planned racket contact that will not happen: let the (bent) flight fall naturally. */
  _cancelContact() {
    const fl = this.fl, b = this.ball;
    fl.contactBy = -1; fl.tContact = INF;
    if (fl.tGround === INF && b.active && !b.rolling) fl.tGround = b.timeToHeight(BALL_Y);
  }

  _fault(kind) {
    const fl = this.fl;
    fl.resolved = true;
    this._cancelContact();
    this.ai.standDown();
    this.pl.aValid = false;
    this.fx.hideMarker();
    const who = fl.hitter;
    this.tPointOver = this.t + 1.15;
    if (this.mode === 'drill') { this._pointWhy = 'fault'; this.hud.pop('Fault', 'call'); this._drillMissed(); return; }
    if (this.srv.second) {
      this.stats.doubles[who]++;
      this._pointWinner = 1 - who; this._pointWhy = 'double';
      this.hud.pop('Double fault', 'call');
      if (who === 0) this._noteMistake('double');
      this.tPointOver = this.t + 1.5;
    } else {
      this._pointWinner = -2; this._pointWhy = 'fault';
      this.hud.pop(kind === 'net' ? 'Fault (net)' : 'Fault', 'call');
      if (who === 0) this._noteMistake('fault', true);
    }
  }

  // ─────────────────────────── points ───────────────────────────

  /**
   * The point is decided. winner: 0 / 1, or -1 for a let. why: 'out' | 'net' | 'winner' |
   * 'ace' | 'let'. The ball keeps flying; scoring happens a moment later (_awardPoint).
   */
  _resolve(winner, why) {
    const fl = this.fl;
    if (fl.resolved) return;
    fl.resolved = true;
    this._cancelContact();
    this.ai.standDown();
    this.pl.aValid = false;
    this.pl.tracking = false;
    this.fx.hideMarker();
    this.hud.timing(-1);
    this._pointWinner = winner; this._pointWhy = why;
    this.tPointOver = this.t + (why === 'let' ? 1.1 : 1.6);
    const hitter = fl.hitter;
    if (this.mode === 'drill') {
      if (why === 'out' || why === 'net') { this.hud.pop(why === 'net' ? 'Net' : 'Out', 'call'); if (hitter === 0) this._noteShotError(why); }
      else if (why === 'winner' && hitter === 1) this.hud.pop(this._miss ? 'Missed' : 'Not up', 'call');
      this._drillMissed(why);
      return;
    }
    if (why === 'let') { this.hud.pop('Let', 'call'); return; }
    this.stats.rallies++;
    this.stats.rallyShots += this.rallyShots;
    this.stats.longest = Math.max(this.stats.longest, this.rallyShots);
    if (this.rallyShots >= 6) this._xp('stamina', Math.min(3, 0.8 + 0.1 * (this.rallyShots - 6)));
    if (why === 'out' || why === 'net') {
      this.stats.errors[hitter]++;
      this.hud.pop(why === 'net' ? 'Net' : 'Out!', 'call');
      if (hitter === 0) this._noteShotError(why);
      else if (Math.random() < 0.35) this._say(pick(['Bueno...', 'Ay. My fault.', 'Hm. The ball has no memory.']), 1.6);
    } else if (why === 'ace') {
      this.stats.aces[hitter]++;
      this.hud.pop('Ace!', hitter === 0 ? 'perfect' : 'call');
      if (hitter === 0) this._xp('serve', 4);
    } else if (why === 'winner') {
      this.stats.winners[hitter]++;
      this.hud.pop(hitter === 0 ? 'Winner!' : (this._miss ? 'Missed' : 'Winner, Rafa'), hitter === 0 ? 'perfect' : 'call');
      if (hitter === 0) {
        this._xp('power', 3);
        if (Math.random() < 0.4) this._coachSay('good');
      } else if (this._miss) this._maybeTip();
    }
    this._miss = null;
  }

  _awardPoint() {
    const w = this._pointWinner, why = this._pointWhy;
    if (why === 'let') { this._setupPoint(false, this.srv.second); return; }
    if (w === -2) { this._setupPoint(false, true); return; } // first-serve fault → second serve
    const ev = this.score.pointTo(w);
    this.stats.points[w]++;
    this._updateScoreboard();
    const names = ['You', 'Rafa'];
    if (ev.match) { this._finishMatch(); return; }
    if (ev.set) this.hud.pop(`Set ${names[ev.setWinner]}!`, 'big');
    else if (ev.game) this.hud.pop(`Game ${names[ev.gameWinner]}`, 'big');
    if (ev.tiebreak) this.hud.pop('Tiebreak!', 'big');
    if (ev.game) this.pl.stamina = Math.min(1, this.pl.stamina + 0.25);
    if (ev.changeEnds && this.opts.changeEnds) {
      this.sides[0] = -this.sides[0]; this.sides[1] = -this.sides[1];
      this.cam.flip();
      this.hud.pop('Change ends', 'call');
    }
    this._setupPoint(false, false);
  }

  _setupPoint(first, second = false) {
    const sc = this.score;
    this.fl.active = false; this.fl.resolved = false;
    this.ball.hide();
    this.ai.reset();
    this.srv.second = !!second;
    this._beginServe(sc.currentServer, sc.isDeuceSide(), !!second);
    const call = sc.callText(['You', 'Rafa']);
    if (!first && !second && call) this._say(call, 1.5);
    if (second) this.hud.pop('Second serve', 'small');
    this._updateScoreboard();
  }

  _updateScoreboard() {
    if (this.mode !== 'match' || !this.score) return;
    this.hud.setScore(this.score, this.phase === 'serve' ? this.srv.who : this.score.currentServer);
  }

  _finishMatch() {
    const sc = this.score, s = this.stats;
    const won = sc.winner === 0;
    this.phase = 'results';
    this.lastWasDrill = false;
    this.ball.hide();
    this.fx.hideAll();
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
    this.hud.setPlayUi(false);
    this.hud.showResults({
      kind: 'match', won, title: won ? 'Victory!' : 'Rafa takes it',
      sub: `${FORMATS[this.format].label} · ${this.ai.diff.label}`,
      score: sc.setLine(0),
      stats: [
        ['Winners', s.winners[0]], ['Errors', s.errors[0]], ['Aces', s.aces[0]], ['Double faults', s.doubles[0]],
        ['Longest rally', s.longest], ['Avg rally', s.rallies ? (s.rallyShots / s.rallies).toFixed(1) : '0'],
        ['Points won', `${s.points[0]}/${s.points[0] + s.points[1]}`], ['Perfect hits', s.perfect],
      ],
      xp: this._xpShown, ups, tips: this._topTips(),
      record: prof ? prof.record : null,
    });
    if (won) this.game.sound.playRankUp && this.game.sound.playRankUp();
    else this.game.sound.playNotification && this.game.sound.playNotification();
  }

  // ─────────────────────────── drills ───────────────────────────

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

  _drillSetup(first) {
    const d = this.drill;
    const side = this.sides[0];
    this.fl.active = false; this.fl.resolved = false;
    this.ball.hide();
    this.ai.reset();
    this.hud.setInfo(`${DRILLS[d.type].label} · ${Math.min(d.rep + 1, DRILL_REPS)}/${DRILL_REPS} · ${d.score} pts`);
    this.hud.setDrill(d.rep, DRILL_REPS, d.score);
    if (d.type === 'serve') {
      const deuce = d.rep % 2 === 0;
      this.srv.second = false;
      this._beginServe(0, deuce, false);
      // targets: T and wide corner of the box being served into
      const r = -side, sgn = deuce ? r : -r;
      this._targets = [{ u: sgn * 0.75, v: r * 5.6, r: 0.85 }, { u: sgn * 3.85, v: r * 5.6, r: 0.85 }];
      this._showTargets();
      return;
    }
    const pv = d.type === 'volley' ? 3.4 : BASE_V;
    if (first || d.type === 'volley') this._placePlayer(0, side * pv);
    this.ai.place(0, this.sides[1] * (d.type === 'volley' ? 11.8 : 11.2));
    this.coachNpc.character.setBallVisible(true);
    this.phase = 'feedWait';
    this.tFeed = this.t + (first ? 1.6 : 0.9);
  }

  _drillFeed() {
    const d = this.drill, side = this.sides[0];
    const pu = this.pl.u;
    let plan;
    if (d.type === 'volley') {
      const off = (Math.random() < 0.5 ? 1 : -1) * rand(0.5, 1.3);
      plan = { u: clamp(pu + side * off, -3.8, 3.8), v: side * rand(6.4, 7.6), pace: rand(10.5, 12), margin: rand(0.25, 0.4), spin: 'flat' };
    } else {
      const toRight = d.type === 'fh' ? 1 : -1; // player's forehand = screen right
      const us = clamp(side * pu + toRight * rand(0.8, 2.0) + rand(-0.8, 0.8), -3.9, 3.9);
      plan = { u: side * us, v: side * rand(8.4, 10.4), pace: rand(11, 13), margin: rand(0.6, 0.9), spin: 'topspin' };
    }
    this.ai.feed(this.t, plan);
    this.phase = 'feeding';
  }

  /** The player's drill shot bounced in the court: score it (targets). */
  _drillLanded(u, v) {
    const d = this.drill;
    let pts = 1, hit = false;
    for (const tg of this._targets || []) {
      if (Math.hypot(u - tg.u, v - tg.v) <= tg.r + R) { hit = true; break; }
    }
    if (hit) pts = 3;
    d.score += pts;
    this.stats.drill.inCourt++;
    if (hit) this.stats.drill.targets++;
    const f = this.frame;
    this.fx.burstAt(f.wx(u, v), SURF, f.wz(u, v), hit);
    this.hud.pop(hit ? 'Target! +3' : 'In +1', hit ? 'perfect' : 'good');
    const stat = d.type === 'serve' ? 'serve' : d.type === 'volley' ? 'control' : 'control';
    this._xp(stat, hit ? 2 : 1);
    if (d.type !== 'serve' && d.type !== 'volley') { if (this.fl.shot === 'topspin' || this.fl.shot === 'slice') this._xp('spin', 0.6); if (hit) this._xp('power', 0.8); }
    if (d.type === 'volley') this._xp('speed', 0.5);
    this.fl.resolved = true;
    this._cancelContact();
    this._pointWhy = 'in';
    this.tPointOver = this.t + 1.1;
    if (hit && Math.random() < 0.45) this._coachSay('good');
  }

  _drillMissed() {
    // nothing scored; the next rep follows via _drillNext
  }

  _drillNext() {
    const d = this.drill;
    d.rep++;
    if (d.rep >= DRILL_REPS) { this._finishDrill(); return; }
    this._drillSetup(false);
  }

  _finishDrill() {
    const d = this.drill, s = this.stats;
    this.phase = 'results';
    this.lastWasDrill = true;
    this.ball.hide();
    this.fx.hideAll();
    for (const k in s.xp) s.xp[k] += 0.5;
    const ups = this._applyPendingXp();
    const prof = this.game.profile;
    if (prof) prof.recordMatch({ drill: true });
    try { this.game.saveGame(); } catch (e) { /* ignore */ }
    const max = DRILL_REPS * 3;
    const stars = d.score >= max * 0.6 ? 3 : d.score >= max * 0.35 ? 2 : d.score >= max * 0.15 ? 1 : 0;
    this._say(stars >= 2 ? 'Vamos! Now you are hitting.' : 'Bueno. We keep working.', 2.4);
    this.hud.setPlayUi(false);
    this.hud.showResults({
      kind: 'drill', won: stars >= 2, title: DRILLS[d.type].label, sub: `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`,
      score: `${d.score} / ${max} pts`,
      stats: [['In the court', `${s.drill.inCourt}/${DRILL_REPS}`], ['Targets hit', s.drill.targets], ['Perfect hits', s.perfect], ['Swings', s.swings]],
      xp: this._xpShown, ups, tips: this._topTips(), record: prof ? prof.record : null,
    });
    this.game.sound.playMissionComplete && this.game.sound.playMissionComplete();
  }

  // ─────────────────────────── aids (timing ring, marker) ───────────────────────────

  _updateAids() {
    const fl = this.fl, t = this.t, pl = this.pl;
    if (this.phase === 'rally' && fl.active && !fl.resolved && fl.receiver === 0 && !pl.swung && fl.kind !== 'toss') {
      // When should SWING be pressed? The moment the ball is closest to the racket head
      // (forehand or backhand, whichever is closer) minus LEAD.
      if (!this._aidT || t - this._aidT > 0.05) {
        this._aidT = t;
        const p = this.game.player;
        p.mesh.updateMatrixWorld(true);
        const pred = this.pred2.from(this.ball);
        let best = INF, bt = INF;
        for (let ci = 0; ci < 2; ci++) {
          p.character.getContactPointWorld(ci === 0 ? 'forehand' : 'backhand', _R[ci]);
        }
        for (let tt = t; tt < t + 2.4; tt += 0.02) {
          const nb = pred.at(tt);
          if (this.ball.bounced + nb >= 2) break;
          for (let ci = 0; ci < 2; ci++) {
            const Rv = _R[ci];
            const d = Math.hypot(pred.x - Rv.x, pred.y - Rv.y, pred.z - Rv.z);
            if (d < best) { best = d; bt = tt; }
          }
        }
        pl.tIdeal = bt; pl.idealD = best;
      }
      const lead = pl.tIdeal - LEAD - t;
      this.hud.timing(pl.tIdeal === INF ? -1 : clamp(1 - lead / 1.0, 0, 1.2), pl.idealD < REACH * 0.8);
    } else if (this._aidT) {
      this._aidT = 0;
      this.hud.timing(-1);
    }
    this.hud.setStamina(pl.stamina);
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

  _noteMistake(kind, soft = false) {
    const m = this.stats.tips;
    m.set(kind, (m.get(kind) || 0) + (soft ? 0.5 : 1));
    if (!soft) this._maybeTip(kind);
  }

  _noteShotError(why) {
    const fl = this.fl;
    let kind = 'net';
    if (why === 'out') {
      const f = this.frame;
      const u = f.lu(fl.landX, fl.landZ);
      kind = Math.abs(u) > SINGLES_W ? 'wide' : 'long';
    }
    const sw = this.swing;
    if (sw.q < 0.55 && Math.abs(sw.e) > 0.07) kind = sw.e > 0 ? 'late' : 'early';
    this._noteMistake(kind);
  }

  _maybeTip(kind) {
    if (this._tipCooldown > 0 || !kind) return;
    const n = this.stats.tips.get(kind) || 0;
    if (n < 1 || Math.random() > 0.7) return;
    this._coachSay(kind);
  }

  _coachSay(kind) {
    const arr = TIPS[kind];
    if (!arr) return;
    this._tipCooldown = 9;
    this._say(pick(arr), 2.8);
  }

  /** Rafa speaks: his bubble in the scene, and the same line on the HUD (readable on phones). */
  _say(text, sec = 2.2) {
    try { this.coachNpc.say(text, sec); } catch (e) { /* cosmetic */ }
    if (this.hud) this.hud.coach(text, sec + 0.6);
  }

  _topTips() {
    const out = [];
    const arr = [...this.stats.tips.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of arr) {
      if (n < 1 || !TIPS[k] || k === 'good') continue;
      out.push(TIPS[k][0]);
      if (out.length >= 2) break;
    }
    if (!out.length) out.push('Good session. Same time tomorrow?');
    return out;
  }
}
