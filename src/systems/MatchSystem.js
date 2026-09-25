import * as THREE from 'three';
import { SIZES } from '../utils/Constants.js';
import { NPC } from '../entities/NPC.js';
import { CameraTracker, hashString } from '../entities/CharacterModel.js';
import { getClipEventRacketPoint } from '../entities/CharacterAnimations.js';
import { findSeats, claimSeat } from '../entities/Seats.js';
import { TennisBall, BALL_RADIUS, GRAVITY as G } from '../entities/TennisBall.js';
import { RoutePlanner } from './RoutePlanner.js';
import { Quality } from '../graphics/Quality.js';

/**
 * MatchSystem — members play tennis on a court schedule (public/data/schedule.json).
 *
 * Flow per match: walk in (fence-aware route) → warm-up rally → points (serve with toss, rally,
 * errors into the net / out, winners) with no-ad game scoring → handshake at the net and
 * reactions → walk off to a preferred area. Rain sends players to the nearest benches and
 * resumes when it clears; a clay court being groomed ends its match; talking to a player
 * pauses the rally (the point is replayed).
 *
 * The ball is analytic: each flight segment is a parabola on the match clock, and every racket
 * contact is planned ahead — the receiver runs to the spot where the racket head will meet the
 * ball (CharacterAnimations contact probe) and starts the swing exactly `contact` seconds early.
 * At swing start the remaining flight is re-aimed at the real racket position, so the ball
 * visibly meets the strings. Nothing here allocates per frame; one pooled ball per court.
 *
 * Debug (dev console): __game.matches.debugStart('court1', ['chad_blake', 'tommy_chen'],
 *   { teleport: true, warmup: 0, gamesToWin: 1 }), .debugStop('court1'), .list(), .enabled
 */

const SURF = SIZES.courtSurfaceY ?? 0.15;
const BALL_Y = SURF + BALL_RADIUS;      // ball centre when touching the court
const HALF_L = 12.3;                    // baseline (court-local v)
const SINGLES_W = 4.65;                 // singles sideline (court-local u)
const SERVICE_L = 6.62;                 // service line
const NET_H0 = 0.9, NET_H1 = 1.02, NET_POST = 7.8;
const FENCE_V = 14.2;                   // ball stops at the back fence
const BASE_V = 12.9;                    // baseline stand
const MAX_STAND_V = 13.8;               // deepest stand (fence at 14.5)
const RUN_SPEED = 5.4;
const SWING_T = 0.52;                   // forehand / backhand contact time
const SERVE_RELEASE = 0.62, SERVE_CONTACT = 1.22;
const WALK_SPEED = 1.75;
const INF = Infinity;
const SCORE_WORDS = ['Love', '15', '30', '40'];
const RALLY_PHASES = new Set(['warmup', 'setup', 'point']);
const COURT_PHASES = new Set(['warmup', 'setup', 'point', 'handshake']);

const DEFAULT_SCHEDULE = {
  maxConcurrent: 3,
  format: { gamesToWin: 2, noAd: true, warmupSeconds: 10 },
  lateStartHours: 1,
  pool: [],
  exclude: ['hank_morris'],
  matches: [],
};

const _v1 = new THREE.Vector3();
const _C = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const rand = (a, b) => a + Math.random() * (b - a);

function parseHour(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

export class MatchSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {CANNON.World} o.physicsWorld
   * @param {Court[]} o.courts          World.courts
   * @param {NPC[]} o.npcs
   * @param {WeatherSystem} o.weather   timeOfDay / day / getWeather()
   * @param {MissionSystem} [o.missions] busy-NPC check (current step NPCs)
   * @param {CourtMaintenanceSystem} [o.maintenance] clay courts being groomed are unavailable
   * @param {SoundSystem} [o.sound]     playBallHit(volume, kind)
   * @param {THREE.Camera} [o.camera]   frustum LOD on the low tier
   * @param {object} [o.waypoints]      map.json waypoints (rain fallback spots)
   */
  constructor(o) {
    this.scene = o.scene;
    this.courts = o.courts || [];
    this.npcs = o.npcs || [];
    this.weather = o.weather;
    this.missions = o.missions || null;
    this.maintenance = o.maintenance || null;
    this.sound = o.sound || null;
    this.camera = o.camera || null;
    this.waypoints = o.waypoints || {};
    this.planner = o.physicsWorld ? new RoutePlanner(o.physicsWorld) : null;

    this.enabled = true;
    this.matches = [];
    this._pool = [];          // TennisBall pool
    this._started = new Set();
    this._day = -1;
    this._schedTimer = 0.5;
    this._rainClear = 0;
    this._npcById = new Map();
    for (const n of this.npcs) this._npcById.set(n.id, n);
    this._frames = new Map();
    for (const c of this.courts) this._frames.set(c.id, this._makeFrame(c));
    this.setSchedule(DEFAULT_SCHEDULE);
  }

  /** Load public/data/schedule.json (falls back to the built-in empty schedule). */
  async load(url) {
    const path = url || `${import.meta.env.BASE_URL}data/schedule.json`;
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.setSchedule(await res.json());
    } catch (err) {
      console.warn('MatchSystem: schedule.json unavailable, no scheduled matches:', err.message || err);
    }
    return this;
  }

  /** Validate / normalise a schedule object (hand-edited JSON: never throw). */
  setSchedule(data) {
    const d = data && typeof data === 'object' ? data : {};
    const f = d.format || {};
    this.format = {
      gamesToWin: Math.max(1, Math.min(6, Math.round(Number(f.gamesToWin) || 2))),
      noAd: f.noAd !== false,
      warmupSeconds: Math.max(0, Math.min(60, Number(f.warmupSeconds ?? 10) || 0)),
    };
    this.maxConcurrent = Math.max(0, Math.min(5, Math.round(Number(d.maxConcurrent ?? 3))));
    this.lateStart = Math.max(0.1, Number(d.lateStartHours) || 1);
    this.exclude = new Set(Array.isArray(d.exclude) ? d.exclude : ['hank_morris']);
    this.pool = (Array.isArray(d.pool) ? d.pool : []).filter(id => this._npcById.has(id) && !this.exclude.has(id));
    if (!this.pool.length) this.pool = this.npcs.map(n => n.id).filter(id => !this.exclude.has(id));
    this.entries = [];
    const list = Array.isArray(d.matches) ? d.matches : [];
    list.forEach((m, i) => {
      if (!m || typeof m !== 'object') return;
      const start = parseHour(m.start), end = parseHour(m.end);
      const courts = (Array.isArray(m.court) ? m.court : [m.court]).filter(id => this._frames.has(id));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !courts.length) {
        console.warn(`schedule.json: match #${i} ignored (needs start < end and a known court)`);
        return;
      }
      const players = (Array.isArray(m.players) ? m.players : []).slice(0, 2);
      while (players.length < 2) players.push('any');
      this.entries.push({ id: m.id || `m${i}`, courts, start, end, players });
    });
    this._started.clear();
  }

  // ───────────────────────────── court frames ─────────────────────────────

  _makeFrame(court) {
    const cfg = court.config || {};
    const r = Number(cfg.rotation) || 0;
    const clay = !!court.isClay;
    const buf = clay ? (SIZES.clayCourtBuffer || 0) : 2;
    return {
      court, id: court.id, isClay: clay,
      cx: cfg.center?.x ?? 0, cz: cfg.center?.z ?? 0, r, c: Math.cos(r), s: Math.sin(r),
      halfPadL: SIZES.courtWidth / 2 + (cfg.adjacentLeft ? 0 : buf),
      halfPadR: SIZES.courtWidth / 2 + (cfg.adjacentRight ? 0 : buf),
      wear: typeof court.wearAt === 'function',
    };
  }
  _wx(f, u, v) { return f.cx + u * f.c + v * f.s; }
  _wz(f, u, v) { return f.cz - u * f.s + v * f.c; }
  _lu(f, x, z) { return (x - f.cx) * f.c - (z - f.cz) * f.s; }
  _lv(f, x, z) { return (x - f.cx) * f.s + (z - f.cz) * f.c; }

  // ───────────────────────────── availability ─────────────────────────────

  isCourtInUse(courtId) { return this.matches.some(m => m.frame.id === courtId); }

  _courtBlocked(frame) {
    if (this.isCourtInUse(frame.id)) return true;
    return this._grooming(frame);
  }

  _grooming(frame) {
    const mt = this.maintenance;
    if (!frame.isClay || !mt || typeof mt.isGrooming !== 'function' || !mt.isGrooming()) return false;
    const act = typeof mt.getActiveCourts === 'function' ? mt.getActiveCourts() : null;
    return !act || act.includes(frame.court);
  }

  _raining() {
    const w = this.weather && (this.weather.getWeather ? this.weather.getWeather() : this.weather.weather);
    return w === 'rainy' || w === 'stormy';
  }

  _missionNpcs() {
    const set = this._missionSet || (this._missionSet = new Set());
    set.clear();
    const ms = this.missions;
    if (!ms || typeof ms.getActiveMissions !== 'function') return set;
    for (const m of ms.getActiveMissions()) {
      const id = typeof ms.getStepNpcId === 'function' ? ms.getStepNpcId(m) : null;
      if (id) set.add(id);
    }
    return set;
  }

  _available(npc, busy) {
    if (!npc || this.exclude.has(npc.id)) return false;
    if (npc.playing || npc.state === 'talking' || npc.state === 'playing') return false;
    if (busy.has(npc.id)) return false; // a pending "!" encounter is fine: talk to them courtside
    return !this.matches.some(m => m.players[0].npc === npc || m.players[1].npc === npc);
  }

  // ───────────────────────────── schedule ─────────────────────────────

  _checkSchedule() {
    const w = this.weather;
    if (!w || !this.enabled) return;
    if (w.day !== this._day) { this._day = w.day; this._started.clear(); }
    if (this._raining()) return;
    const tod = w.timeOfDay;
    const busy = this._missionNpcs();
    for (let i = 0; i < this.entries.length; i++) {
      if (this.matches.length >= this.maxConcurrent) return;
      const e = this.entries[i];
      if (this._started.has(i)) continue;
      if (tod < e.start || tod > Math.min(e.end - 0.75, e.start + this.lateStart)) continue;
      const frame = e.courts.map(id => this._frames.get(id)).find(f => f && !this._courtBlocked(f));
      if (!frame) continue;
      const picked = this._pickPlayers(e, tod, busy);
      if (!picked) continue;
      this._started.add(i);
      this._startMatch(frame, picked, { entry: e });
    }
  }

  _pickPlayers(e, tod, busy) {
    const out = [];
    const allowSub = tod - e.start > 0.2; // give the booked member a moment to free up
    for (const id of e.players) {
      let npc = id !== 'any' ? this._npcById.get(id) : null;
      if (npc && (!this._available(npc, busy) || out.includes(npc))) {
        if (!allowSub) return null;
        npc = null;
      }
      if (!npc) {
        const cands = this.pool.map(pid => this._npcById.get(pid))
          .filter(n => n && !out.includes(n) && !e.players.includes(n.id) && this._available(n, busy));
        if (!cands.length) return null;
        npc = cands[Math.floor(Math.random() * cands.length)];
      }
      out.push(npc);
    }
    return out;
  }

  // ───────────────────────────── match lifecycle ─────────────────────────────

  _acquireBall() {
    let b = this._pool.find(x => !x.inUse);
    if (!b) { b = new TennisBall(this.scene); this._pool.push(b); }
    b.inUse = true;
    b.groundY = SURF;
    b.hide();
    return b;
  }

  _startMatch(frame, npcs, opts = {}) {
    const entry = opts.entry || { id: 'debug', start: this.weather.timeOfDay, end: INF };
    const flip = Math.random() < 0.5;
    const m = {
      frame, entry, day: this.weather.day,
      ball: this._acquireBall(),
      phase: 'walkIn', t: 0, phaseT: 0, started: false,
      gamesToWin: opts.gamesToWin ?? this.format.gamesToWin,
      noAd: this.format.noAd,
      warmup: opts.warmup ?? this.format.warmupSeconds,
      warmEnd: 0, feedAt: INF, feeder: 0,
      score: { pts: [0, 0], games: [0, 0], server: Math.random() < 0.5 ? 0 : 1 },
      faults: 0, rallyLen: 0,
      segType: 'none', segEnd: INF, bounces: 0,
      shot: { hitter: 0, receiver: 1, outcome: 'in', returnable: false, missed: false, tContact: INF, kind: 'rally' },
      aimPt: new THREE.Vector3(), H: new THREE.Vector3(),
      srv: { active: false, released: false, tStart: 0, C: new THREE.Vector3() },
      resolved: false, pointWinner: -1, tPointOver: INF, tServe: INF, tNext: INF,
      resumePhase: null, winner: -1, reactAt: INF, leaveAt: INF,
      wear: new Float32Array(4 * 16), wearN: 0, wearT: 0,
      rainT: 0, talkWas: false,
      players: npcs.map((npc, i) => this._makePlayer(npc, (i === 0) !== flip ? 1 : -1, frame, i)),
    };
    for (const p of m.players) {
      p.npc.startPlaying(frame.id, p.side > 0 ? 'north' : 'south');
      p.npc.character.setBallVisible(false);
    }
    NPC.setAreaBusy(frame.id, true);
    this.matches.push(m);
    for (const p of m.players) {
      const x = this._wx(frame, 0, p.side * BASE_V), z = this._wz(frame, 0, p.side * BASE_V);
      if (opts.teleport) {
        p.npc.body.position.set(x, SURF + SIZES.npcRadius + 0.02, z);
        p.npc.body.velocity.set(0, 0, 0);
        p.npc.mesh.position.set(x, SURF, z);
        p.npc.mesh.rotation.y = p.yaw;
      }
      this._route(p, x, z, p.yaw);
    }
    return m;
  }

  _makePlayer(npc, side, frame, idx) {
    const scale = npc.modelScale || 0.87;
    return {
      npc, side, idx, scale,
      yaw: frame.r + (side > 0 ? Math.PI : 0),
      skill: 0.35 + hashString(npc.id + ':tennis') * 0.5,
      fh: getClipEventRacketPoint('forehand'),
      bh: getClipEventRacketPoint('backhand'),
      route: [], ri: 0, arrived: false, endYaw: null, walkT: 0, stuckT: 0, bestD: INF,
      tSplit: INF, tMove: INF, tSwing: INF, tRecover: INF, swingAt: 0,
      mx: 0, mz: 0, mSpeed: 3, clip: 'forehand', aim: false,
      rx: 0, rz: 0, done: false,
    };
  }

  /** Plan a walking route for a player (fence / net aware). */
  _route(p, x, z, endYaw) {
    const b = p.npc.body.position;
    if (this.planner) this.planner.plan(b.x, b.z, x, z, p.route);
    else { p.route.length = 0; p.route.push({ x, z }); }
    p.ri = 0; p.arrived = false; p.endYaw = endYaw; p.walkT = 0; p.stuckT = 0; p.bestD = INF;
    p.goalX = x; p.goalZ = z; p.retries = 0;
    p.npc.stopMove();
  }

  /** Blocked (column, parked cart, a person): sidestep and re-plan from there. */
  _unstick(p) {
    const npc = p.npc;
    const b = npc.body.position;
    const w = p.route[Math.min(p.route.length - 1, Math.max(0, p.ri - 1))] || { x: p.goalX, z: p.goalZ };
    let dx = w.x - b.x, dz = w.z - b.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const side = p.retries % 2 ? 1 : -1;
    const sx = b.x - dz * 1.6 * side - dx * 0.5, sz = b.z + dx * 1.6 * side - dz * 0.5;
    p.retries++;
    const rest = [];
    if (this.planner) this.planner.plan(sx, sz, p.goalX, p.goalZ, rest);
    else rest.push({ x: p.goalX, z: p.goalZ });
    p.route.length = 0;
    p.route.push({ x: sx, z: sz }, ...rest);
    p.ri = 0; p.stuckT = 0; p.bestD = INF;
    npc.stopMove();
  }

  /** Advance a route; true once arrived. */
  _followRoute(m, p, dt) {
    if (p.arrived) return true;
    const npc = p.npc;
    if (npc.state !== 'playing') return false; // talking: resume afterwards
    p.walkT += dt;
    if (!npc.moving) {
      if (p.ri >= p.route.length) {
        // Waypoints skipped as stuck: only "arrived" when actually there
        const g = p.route[p.route.length - 1];
        if (g && Math.hypot(g.x - npc.body.position.x, g.z - npc.body.position.z) > 1.0 && p.retries < 12) {
          this._unstick(p);
          return false;
        }
        p.arrived = true;
        if (p.endYaw !== null) npc.setFacing(p.endYaw);
        return true;
      }
      const w = p.route[p.ri++];
      npc.moveTo(w.x, w.z, { speed: WALK_SPEED, gait: 'walk', settle: p.ri >= p.route.length });
      p.stuckT = 0; p.bestD = INF;
    } else {
      const w = p.route[Math.max(0, p.ri - 1)];
      const d = Math.hypot(w.x - npc.body.position.x, w.z - npc.body.position.z);
      if (d < p.bestD - 0.25) { p.bestD = d; p.stuckT = 0; } else if ((p.stuckT += dt) > 2.5) this._unstick(p);
    }
    // Hopelessly stuck (hedge corner, cart parked in the way): hop there when nobody is looking
    if (p.walkT > 75 && p.route.length) {
      const g = p.route[p.route.length - 1];
      const cam = CameraTracker.position;
      if (p.walkT > 140 || !CameraTracker.valid || Math.hypot(cam.x - g.x, cam.z - g.z) > 30) {
        npc.stopMove();
        npc.body.position.x = g.x; npc.body.position.z = g.z;
        npc.body.velocity.set(0, 0, 0);
        p.ri = p.route.length;
      }
    }
    return false;
  }

  _setPhase(m, phase) { m.phase = phase; m.phaseT = 0; }

  /** Begin leaving: route each player to one of their preferred spots. */
  _startWalkOut(m) {
    if (m.phase === 'walkOut') return;
    this._clearRally(m);
    NPC.setAreaBusy(m.frame.id, false);
    this._setPhase(m, 'walkOut');
    for (const p of m.players) {
      const npc = p.npc;
      p.done = false;
      npc.character.setBallVisible(false);
      if (npc.state !== 'playing' && npc.state !== 'talking') { npc.releaseShelter(); npc.stopPlaying(); p.done = true; continue; }
      let wp = null;
      try { wp = npc._getPreferredWaypoint(); } catch (e) { wp = null; }
      if (!wp) { npc.stopPlaying(); p.done = true; continue; }
      this._route(p, wp.x, wp.z, null);
    }
  }

  _finish(m) {
    const i = this.matches.indexOf(m);
    if (i >= 0) this.matches.splice(i, 1);
    this._clearRally(m);
    m.ball.hide();
    m.ball.inUse = false;
    this._flushWear(m);
    NPC.setAreaBusy(m.frame.id, false);
    for (const p of m.players) {
      if (p.npc.playing) { p.npc.releaseShelter(); p.npc.stopPlaying(); }
    }
  }

  _clearRally(m) {
    m.segType = 'none'; m.segEnd = INF; m.srv.active = false;
    m.tServe = INF; m.tNext = INF; m.tPointOver = INF; m.feedAt = INF;
    m.ball.hide();
    for (const p of m.players) {
      p.tSplit = p.tMove = p.tSwing = p.tRecover = INF;
      p.npc.character.setBallVisible(false);
    }
  }

  // ───────────────────────────── per frame ─────────────────────────────

  update(dt) {
    if (!this.weather) return;
    this._schedTimer -= dt;
    if (this._schedTimer <= 0) { this._schedTimer = 1; this._checkSchedule(); }
    this._rainClear = this._raining() ? 0 : this._rainClear + dt;

    let lowFrustum = false;
    if (Quality.tier === 'low' && this.camera && this.matches.length) {
      _pm.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pm);
      lowFrustum = true;
    }

    for (let i = this.matches.length - 1; i >= 0; i--) {
      const m = this.matches[i];
      try { this._updateMatch(m, dt); } catch (err) {
        console.error('MatchSystem: match error, ending it', err);
        this._finish(m);
        continue;
      }
      if (this.matches[i] !== m) continue;
      // Ball: advance / draw (LOD: far courts keep logic only)
      const b = m.ball;
      if (b.active) {
        if (b.rolling) {
          b.stepRoll(dt);
          const v = this._lv(m.frame, b.pos.x, b.pos.z);
          if (Math.abs(v) > FENCE_V) { b.v0.x = 0; b.v0.z = 0; }
        } else b.at(m.t);
        let vis = true;
        if (CameraTracker.valid) {
          const c = CameraTracker.position;
          const d2 = (c.x - b.pos.x) ** 2 + (c.z - b.pos.z) ** 2;
          vis = d2 < (Quality.tier === 'low' ? 45 * 45 : 80 * 80);
        }
        if (vis && lowFrustum) vis = _frustum.containsPoint(b.pos);
        b.sync(vis);
      } else if (b.shown) b.sync(false);
      // Clay wear (footwork + bounces), batched: one texture upload per court every 0.4 s
      if (m.frame.wear && COURT_PHASES.has(m.phase)) {
        m.wearT += dt;
        if (m.wearT >= 0.4) {
          m.wearT = 0;
          for (const p of m.players) {
            const sp = p.npc.moveSpeed || 0;
            const a = sp > 0.4 ? 0.02 * Math.min(1.6, sp / 3) : 0.004;
            this._queueWear(m, p.npc.body.position.x, p.npc.body.position.z, 0.55, a);
          }
          this._flushWear(m);
        }
      }
    }
  }

  _updateMatch(m, dt) {
    const f = m.frame;
    const tod = this.weather.timeOfDay;
    const over = this.weather.day !== m.day || tod >= m.entry.end;
    const talking = m.players[0].npc.state === 'talking' || m.players[1].npc.state === 'talking';
    m.phaseT += dt;

    // Grooming takes the court back
    if (m.phase !== 'walkOut' && this._grooming(f)) {
      if (m.phase !== 'rain') this._say(m.players[0], 'Grooming time!', 1.6);
      this._startWalkOut(m);
    }
    // Rain delay
    if (this._raining() && m.phase !== 'walkOut' && m.phase !== 'rain') {
      if (m.phase === 'handshake') this._startWalkOut(m); else { this._startRain(m); return; }
    }

    switch (m.phase) {
      case 'walkIn': {
        if (over) { this._startWalkOut(m); break; }
        const a = this._followRoute(m, m.players[0], dt);
        const b = this._followRoute(m, m.players[1], dt);
        if (a && b && !talking) {
          if (m.started || m.warmup <= 0) this._setupPoint(m, true);
          else this._startWarmup(m);
        }
        break;
      }
      case 'rain': {
        m.rainT += dt;
        if (over) { this._finish(m); break; }
        if (this._rainClear > 4 && tod < m.entry.end - 0.3) {
          for (const p of m.players) {
            p.npc.startPlaying(f.id, p.side > 0 ? 'north' : 'south');
            this._route(p, this._wx(f, 0, p.side * BASE_V), this._wz(f, 0, p.side * BASE_V), p.yaw);
          }
          NPC.setAreaBusy(f.id, true);
          this._setPhase(m, 'walkIn');
        }
        break;
      }
      case 'interrupted': {
        if (!talking && m.phaseT > 0.6) {
          if (m.resumePhase === 'warmup') this._startWarmup(m, true);
          else this._setupPoint(m, false);
        }
        break;
      }
      case 'handshake': this._updateHandshake(m, dt); break;
      case 'walkOut': {
        let all = true;
        for (const p of m.players) {
          if (p.done) continue;
          if (p.npc.state !== 'playing' && p.npc.state !== 'talking') { p.done = true; continue; }
          if (this._followRoute(m, p, dt) || m.phaseT > 120) { p.npc.stopPlaying(); p.done = true; } else all = false;
        }
        if (all) this._finish(m);
        break;
      }
      default: {
        // warmup / setup / point
        if (talking) { this._interrupt(m); break; }
        if (over && m.phase === 'warmup') { this._startWalkOut(m); break; }
        m.t += dt;
        // Safety nets: a player who cannot reach a spot (someone standing on it) just plays from there
        if ((m.phase === 'setup' && m.phaseT > 12) || (m.phase === 'warmup' && m.feedAt !== INF && m.t > m.feedAt + 6)) {
          for (const p of m.players) p.npc.stopMove();
        }
        if (m.phase === 'warmup' && m.phaseT > m.warmup + 60) { this._setupPoint(m, true); break; }
        this._updateRally(m, over);
      }
    }
  }

  _interrupt(m) {
    m.resumePhase = m.phase === 'warmup' ? 'warmup' : 'setup';
    this._clearRally(m);
    for (const p of m.players) if (p.npc.state === 'playing') p.npc.stopMove();
    this._setPhase(m, 'interrupted');
  }

  _startRain(m) {
    this._clearRally(m);
    this._setPhase(m, 'rain');
    m.rainT = 0;
    NPC.setAreaBusy(m.frame.id, false);
    const seats = findSeats(this.scene);
    for (const p of m.players) {
      const npc = p.npc;
      const x = npc.body.position.x, z = npc.body.position.z;
      let best = null, bd = 30 * 30;
      for (const s of seats) {
        if (s.taken && s.taken !== npc) continue;
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      if (best && !claimSeat(best, npc)) best = null;
      const wp = this.waypoints[`${m.frame.id}_bench`];
      const side = m.frame.halfPadL + 1.5;
      const pt = wp || { x: this._wx(m.frame, -side, p.side * 2), z: this._wz(m.frame, -side, p.side * 2) };
      npc.shelter(best, pt);
    }
    if (Math.random() < 0.7) this._say(m.players[0], 'Rain delay!', 1.8);
  }

  // ───────────────────────────── warm-up / points ─────────────────────────────

  _startWarmup(m, resume = false) {
    this._clearRally(m);
    this._setPhase(m, 'warmup');
    if (!resume) m.warmEnd = m.t + m.warmup;
    for (const p of m.players) this._moveHome(m, p, 0, 2.2);
    m.feeder = Math.random() < 0.5 ? 0 : 1;
    m.feedAt = m.t + 2.2;
    m.players[m.feeder].npc.character.setBallVisible(true);
  }

  _moveHome(m, p, u, speed) {
    const f = m.frame;
    const x = this._wx(f, u, p.side * BASE_V), z = this._wz(f, u, p.side * BASE_V);
    p.npc.setFacing(p.yaw);
    const d = Math.hypot(x - p.npc.body.position.x, z - p.npc.body.position.z);
    if (d > 0.1) p.npc.moveTo(x, z, { speed, face: d < 3 ? p.yaw : null, gait: d < 3 ? null : 'walk' });
  }

  /** Feed a warm-up ball: self toss from the left hand into a forehand. */
  _feed(m) {
    const p = m.players[m.feeder];
    const npc = p.npc;
    if (npc.moving) { m.feedAt = m.t + 0.3; return; }
    npc.mesh.rotation.y = p.yaw;
    npc.character.setBallVisible(false);
    npc.character.getBallHandWorldPosition(_v1);
    npc.character.getContactPointWorld('forehand', m.aimPt);
    const tau = 0.8;
    this._launchTo(m, _v1, m.aimPt, tau);
    m.segType = 'contact'; m.segEnd = m.t + tau;
    const sh = m.shot;
    sh.hitter = p.idx; sh.receiver = p.idx; sh.outcome = 'in'; sh.returnable = true; sh.missed = false;
    sh.tContact = m.segEnd; sh.kind = 'warmup';
    m.bounces = 0; m.resolved = false;
    p.clip = 'forehand'; p.aim = true; p.swingAt = m.segEnd - SWING_T; p.tSwing = p.swingAt;
  }

  _setupPoint(m, first) {
    this._clearRally(m);
    this._setPhase(m, 'setup');
    m.started = true;
    m.resolved = false; m.rallyLen = 0; m.faults = 0;
    const sc = m.score;
    const srv = m.players[sc.server], rcv = m.players[1 - sc.server];
    const deuce = (sc.pts[0] + sc.pts[1]) % 2 === 0;
    const f = m.frame;
    const su = srv.side * (deuce ? 0.9 : -0.9), sv = srv.side * (HALF_L + 0.35);
    const ru = rcv.side * (deuce ? 2.6 : -2.6), rv = rcv.side * (HALF_L + 0.7);
    m.deuce = deuce;
    for (const [p, u, v] of [[srv, su, sv], [rcv, ru, rv]]) {
      const x = this._wx(f, u, v), z = this._wz(f, u, v);
      p.npc.setFacing(p.yaw);
      p.npc.moveTo(x, z, { speed: 2.8, gait: 'walk' });
    }
    // Server faces the target box
    const bu = rcv.side * (deuce ? 2.3 : -2.3), bv = rcv.side * 4.5;
    srv.serveYaw = Math.atan2(this._wx(f, bu, bv) - this._wx(f, su, sv), this._wz(f, bu, bv) - this._wz(f, su, sv));
    srv.npc.character.setBallVisible(true);
    m.tServe = INF;
    m.callScore = first ? 'start' : 'score';
  }

  _updateRally(m, over) {
    const t = m.t;
    const sc = m.score;

    if (m.phase === 'setup') {
      const srv = m.players[sc.server];
      if (m.tServe === INF && !m.players[0].npc.moving && !m.players[1].npc.moving) {
        if (over && m.callScore !== 'second') { this._endMatch(m); return; }
        srv.npc.setFacing(srv.serveYaw);
        m.tServe = t + (m.callScore === 'second' ? 0.8 : 1.1);
        if (m.callScore === 'start') this._say(srv, 'Let\'s play!', 1.4);
        else if (m.callScore === 'score') this._say(srv, this._scoreCall(m), 1.5);
      }
      if (t >= m.tServe) this._startServe(m);
      return;
    }

    if (m.phase === 'warmup' && t >= m.feedAt) { m.feedAt = INF; this._feed(m); }

    // Serve toss release
    const s = m.srv;
    if (s.active && !s.released && t >= s.tStart + SERVE_RELEASE) {
      s.released = true;
      const srv = m.players[sc.server];
      srv.npc.character.getBallHandWorldPosition(_v1);
      srv.npc.character.setBallVisible(false);
      const tc = s.tStart + SERVE_CONTACT;
      m.ball.launch(t, _v1.x, _v1.y, _v1.z, 0, 0, 0);
      this._launchTo(m, _v1, s.C, tc - t);
      m.segType = 'contact'; m.segEnd = tc;
      const sh = m.shot;
      sh.hitter = srv.idx; sh.receiver = srv.idx; sh.returnable = true; sh.missed = false; sh.kind = 'toss';
      sh.tContact = tc;
    }

    // Player timelines
    for (const p of m.players) {
      const npc = p.npc;
      if (t >= p.tSplit) { p.tSplit = INF; if (!npc.isBusyClip()) npc.swing('split_step', { fade: 0.08 }); }
      if (t >= p.tMove) { p.tMove = INF; npc.moveTo(p.mx, p.mz, { speed: p.mSpeed, face: p.yaw }); }
      if (t >= p.tSwing) { p.tSwing = INF; this._startSwing(m, p, t); }
      if (t >= p.tRecover) {
        p.tRecover = INF;
        if (!npc.moving) npc.moveTo(p.rx, p.rz, { speed: 3.2, face: p.yaw });
      }
    }

    // Ball events (in time order; several can fall into one frame)
    let guard = 0;
    while (m.segType !== 'none' && t >= m.segEnd && guard++ < 6) this._ballEvent(m);

    // Point over → score → next
    if (m.resolved && t >= m.tPointOver) {
      m.tPointOver = INF;
      m.ball.hide();
      if (m.phase === 'warmup') {
        if (t >= m.warmEnd) this._setupPoint(m, true);
        else { m.feeder = 1 - m.feeder; m.players[m.feeder].npc.character.setBallVisible(true); m.feedAt = t + 1.2; m.resolved = false; }
        return;
      }
      this._awardPoint(m, m.pointWinner, over);
    }
  }

  _startServe(m) {
    const srv = m.players[m.score.server];
    const npc = srv.npc;
    npc.stopMove();
    npc.mesh.rotation.y = srv.serveYaw;
    npc.character.setBallVisible(true);
    npc.swing('serve', { fade: 0.15 });
    npc.character.getContactPointWorld('serve', m.srv.C);
    m.srv.active = true; m.srv.released = false; m.srv.tStart = m.t;
    m.tServe = INF;
    this._setPhase(m, 'point');
    m.resolved = false;
    // Receiver: ready, split-step just before the strike
    const rcv = m.players[1 - m.score.server];
    rcv.npc.setFacing(rcv.yaw);
    rcv.tSplit = m.t + SERVE_CONTACT - 0.12;
  }

  _startSwing(m, p, t) {
    const npc = p.npc;
    npc.stopMove();
    npc.mesh.rotation.y = p.yaw;
    npc.setFacing(p.yaw);
    const late = Math.min(0.2, Math.max(0, t - p.swingAt));
    npc.swing(p.clip, { fade: 0.1, startAt: late > 0.001 ? late : undefined });
    if (!p.aim || m.shot.receiver !== p.idx) return;
    npc.character.getContactPointWorld(p.clip, _v1);
    if (_v1.distanceTo(m.aimPt) > 1.3) { m.shot.missed = true; return; }
    m.aimPt.copy(_v1);
    if (m.segType === 'contact') {
      // Already past the bounce (or a toss / feed): bend the rest of the flight onto the strings
      const b = m.ball;
      b.at(t);
      _v1.copy(b.pos);
      this._launchTo(m, _v1, m.aimPt, Math.max(0.02, m.segEnd - t), t);
    }
  }

  /** Ball segment from `from` reaching `to` after `tau` seconds (starting at time t0). */
  _launchTo(m, from, to, tau, t0 = m.t) {
    const vx = (to.x - from.x) / tau, vz = (to.z - from.z) / tau;
    const vy = (to.y - from.y + 0.5 * G * tau * tau) / tau;
    m.ball.launch(t0, from.x, from.y, from.z, vx, vy, vz);
  }

  _ballEvent(m) {
    const b = m.ball;
    const t = m.segEnd;
    b.at(t);
    const pos = b.pos;
    const sh = m.shot;
    const f = m.frame;
    switch (m.segType) {
      case 'contact': {
        if (sh.missed) {
          // Swing and a miss: the ball flies on
          m.segType = 'bounce';
          m.segEnd = b.timeToHeight(BALL_Y);
          if (!m.resolved) this._resolve(m, sh.hitter === sh.receiver ? -1 : sh.hitter, 1.4);
          return;
        }
        const hitter = m.players[sh.receiver];
        this._pock(pos, 'hit');
        if (sh.kind === 'toss') m.srv.active = false;
        if (f.wear) this._queueWear(m, hitter.npc.body.position.x, hitter.npc.body.position.z, 0.5, 0.03);
        this._planShot(m, hitter, t, sh.kind === 'toss' ? 'serve' : (m.phase === 'warmup' ? 'warmup' : 'rally'));
        return;
      }
      case 'bounce': {
        m.bounces++;
        this._pock(pos, 'bounce');
        if (f.wear) this._queueWear(m, pos.x, pos.z, 0.3, 0.035);
        const vx = b.v0.x, vy = b.vyAt(t), vz = b.v0.z;
        if (m.bounces === 1 && sh.returnable && !sh.missed && t < sh.tContact) {
          _v1.set(pos.x, BALL_Y, pos.z);
          this._launchTo(m, _v1, m.aimPt, sh.tContact - t, t);
          m.segType = 'contact'; m.segEnd = sh.tContact;
        } else {
          this._physicalBounce(m, t, vx, vy, vz);
        }
        if (!m.resolved) {
          if (m.bounces === 1 && sh.outcome === 'out') {
            this._resolve(m, sh.receiver, 1.4);
            if (Math.random() < 0.8) this._say(m.players[sh.receiver], sh.kind === 'serve' ? 'Fault!' : 'Out!', 1.2);
          } else if (m.bounces >= 2) {
            this._resolve(m, sh.hitter, 1.2);
          }
        }
        return;
      }
      case 'net': {
        this._pock(pos, 'bounce');
        const vx = b.v0.x, vz = b.v0.z;
        b.launch(t, pos.x - vx * 0.004, Math.max(pos.y, BALL_Y), pos.z - vz * 0.004, -vx * 0.08, 0.4, -vz * 0.08);
        m.segType = 'bounce'; m.segEnd = b.timeToHeight(BALL_Y);
        m.bounces = 5;
        if (!m.resolved) this._resolve(m, sh.receiver, 1.5);
        return;
      }
      case 'fence': {
        const vx = b.v0.x, vy = b.vyAt(t), vz = b.v0.z;
        // reflect the court-length component, damp the rest
        const lu = vx * f.c - vz * f.s, lv = vx * f.s + vz * f.c;
        const nu = lu * 0.4, nv = -lv * 0.25;
        b.launch(t, pos.x, pos.y, pos.z, nu * f.c + nv * f.s, Math.min(vy, 0.5), -nu * f.s + nv * f.c);
        m.segType = 'bounce'; m.segEnd = b.timeToHeight(BALL_Y);
        m.bounces = Math.max(m.bounces, 2);
        if (!m.resolved) this._resolve(m, sh.hitter, 1.2);
        return;
      }
      default:
        m.segType = 'none'; m.segEnd = INF;
    }
  }

  _physicalBounce(m, t, vx, vy, vz) {
    const b = m.ball, f = m.frame;
    const e = f.isClay ? 0.7 : 0.74, kh = f.isClay ? 0.64 : 0.74;
    const nvx = vx * kh, nvz = vz * kh, nvy = -vy * e;
    const pos = b.pos;
    if (nvy < 0.9) {
      b.roll(t, nvx, nvz);
      m.segType = 'none'; m.segEnd = INF;
      return;
    }
    b.launch(t, pos.x, BALL_Y, pos.z, nvx, nvy, nvz);
    let tEnd = t + 2 * nvy / G, type = 'bounce';
    const v0 = this._lv(f, pos.x, pos.z), vv = nvx * f.s + nvz * f.c;
    if (Math.abs(vv) > 1e-3) {
      const tf = (Math.sign(vv) * FENCE_V - v0) / vv;
      if (tf > 0.01 && t + tf < tEnd) { tEnd = t + tf; type = 'fence'; }
    }
    m.segType = type; m.segEnd = tEnd;
  }

  _resolve(m, winner, delay) {
    m.resolved = true;
    m.pointWinner = winner;
    m.tPointOver = m.t + delay;
    for (const p of m.players) {
      p.tSplit = p.tMove = p.tSwing = INF;
      if (!p.npc.isBusyClip()) p.npc.stopMove();
    }
  }

  /**
   * Plan the next flight from the ball's current position (the hitter's racket contact) at time
   * t0: pick the outcome, a target, a flight time that clears the net, and the receiver's
   * return (clip, stand spot, timing).
   */
  _planShot(m, hitter, t0, kind) {
    const f = m.frame;
    const b = m.ball;
    const C = _C.copy(b.pos);
    const rcv = m.players[1 - hitter.idx];
    const r = rcv.side;
    const sh = m.shot;
    sh.hitter = hitter.idx; sh.receiver = rcv.idx; sh.missed = false; sh.kind = kind;
    m.bounces = 0;
    rcv.tRecover = INF;
    if (kind !== 'warmup') m.rallyLen++;
    if (kind === 'serve') m.srv.active = false;

    // Outcome
    let outcome = 'in';
    const sk = hitter.skill;
    if (kind === 'serve') {
      const pf = m.faults === 0 ? 0.24 - sk * 0.12 : 0.1 - sk * 0.06;
      const x = Math.random();
      if (x < pf) outcome = Math.random() < 0.5 ? 'net' : 'out';
      else if (x < pf + 0.03 + sk * 0.05) outcome = 'winner';
    } else if (kind === 'rally') {
      const n = m.rallyLen;
      const pe = 0.06 + (1 - sk) * 0.12 + 0.02 * n;
      const pw = 0.04 + sk * 0.06 + 0.012 * n;
      const x = Math.random();
      if (x < pe) outcome = Math.random() < 0.42 ? 'net' : 'out';
      else if (x < pe + pw) outcome = 'winner';
    }
    const cu = this._lu(f, C.x, C.z), cv = this._lv(f, C.x, C.z);
    const ru = this._lu(f, rcv.npc.body.position.x, rcv.npc.body.position.z);

    if (outcome === 'net') {
      const nu = THREE.MathUtils.clamp(cu * 0.5 + rand(-2.5, 2.5), -4, 4);
      const top = SURF + NET_H0 + (NET_H1 - NET_H0) * (nu / NET_POST) ** 2;
      _v1.set(this._wx(f, nu, -r * 0.02), top - rand(0.12, 0.35), this._wz(f, nu, -r * 0.02));
      const d = Math.hypot(_v1.x - C.x, _v1.z - C.z);
      const tn = d / rand(13, 17);
      this._launchTo(m, b.pos, _v1, tn, t0);
      m.segType = 'net'; m.segEnd = t0 + tn;
      sh.outcome = 'net'; sh.returnable = false; sh.tContact = INF;
      this._recover(m, hitter, t0);
      // receiver reads it and steps in a little
      rcv.tSplit = t0 + 0.05;
      return;
    }

    const speedBase = kind === 'serve' ? rand(15.5, 19.5) + sk * 1.5 : kind === 'warmup' ? rand(10.5, 12.5) : rand(12.5, 15.5) + sk * 2;
    let best = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      // Target (court-local)
      let bu, bv;
      const shrink = 1 - attempt * 0.07;
      if (kind === 'serve') {
        const sgn = m.deuce ? r : -r;
        if (outcome === 'out') { bu = sgn * rand(0.5, 3.8); bv = r * rand(SERVICE_L + 0.4, SERVICE_L + 1.8); }
        else if (outcome === 'winner') { bu = sgn * (Math.random() < 0.5 ? rand(3.6, 4.3) : rand(0.3, 0.8)); bv = r * rand(5.2, 6.3); }
        else { bu = sgn * rand(0.9, 3.6) * shrink; bv = r * rand(3.8, 6.2) * (0.8 + 0.2 * shrink); }
      } else if (outcome === 'out') {
        if (Math.random() < 0.55) { bu = rand(-3.5, 3.5); bv = r * rand(HALF_L + 0.3, HALF_L + 1.5); }
        else { bu = (Math.random() < 0.5 ? -1 : 1) * rand(SINGLES_W + 0.25, SINGLES_W + 1.2); bv = r * rand(6.5, 11); }
      } else if (outcome === 'winner') {
        const away = ru > 0 ? -1 : 1;
        bu = away * rand(3.2, 4.4); bv = r * rand(8.5, 11.8);
      } else if (kind === 'warmup') {
        bu = THREE.MathUtils.clamp(ru + rand(-1.2, 1.2), -2.5, 2.5) * shrink; bv = r * rand(8.8, 10.8) * (0.85 + 0.15 * shrink);
      } else {
        bu = THREE.MathUtils.clamp(rand(-3.8, 3.8) * shrink + ru * 0.15 * attempt, -4.2, 4.2);
        bv = r * rand(7.2, 11.2) * (0.8 + 0.2 * shrink);
      }
      // Aim along the line toward a comfortable return spot (serves always, rallies as a fallback)
      if (outcome === 'in' && (kind === 'serve' || attempt >= 4)) {
        const rb = rcv.npc.body.position;
        const hu = ru + rand(-1.4, 1.4), hv = this._lv(f, rb.x, rb.z) - r * rand(0.3, 1.8);
        const fr = kind === 'serve' ? rand(0.55, 0.78) : rand(0.6, 0.82);
        bu = cu + (hu - cu) * fr; bv = cv + (hv - cv) * fr;
        if (kind === 'serve') {
          const sgn = m.deuce ? r : -r;
          bu = sgn * THREE.MathUtils.clamp(bu * sgn, 0.25, SINGLES_W - 0.3);
          bv = r * THREE.MathUtils.clamp(bv * r, 1.5, SERVICE_L - 0.25);
        } else {
          bu = THREE.MathUtils.clamp(bu, -SINGLES_W + 0.4, SINGLES_W - 0.4);
          bv = r * THREE.MathUtils.clamp(bv * r, 3, HALF_L - 0.6);
        }
      }
      const Bx = this._wx(f, bu, bv), Bz = this._wz(f, bu, bv);
      const D = Math.hypot(Bx - C.x, Bz - C.z);
      // Flight time: from the pace, stretched until it clears the net
      let T1 = D / speedBase;
      const fr = (0 - cv) / (bv - cv);
      const nu = cu + (bu - cu) * fr;
      const need = SURF + NET_H0 + (NET_H1 - NET_H0) * (nu / NET_POST) ** 2 + BALL_RADIUS + (kind === 'serve' ? 0.12 : 0.3);
      let vy0 = 0;
      for (let k = 0; k < 30; k++) {
        vy0 = (BALL_Y - C.y + 0.5 * G * T1 * T1) / T1;
        const tn = fr * T1;
        if (fr <= 0 || fr >= 1 || C.y + vy0 * tn - 0.5 * G * tn * tn >= need) break;
        T1 += 0.05;
      }
      const vx = (Bx - C.x) / T1, vz = (Bz - C.z) / T1;
      const vyB = vy0 - G * T1;
      const e = f.isClay ? 0.7 : 0.74, kh = f.isClay ? 0.64 : 0.74;
      const plan = { Bx, Bz, T1, vx, vy0, vz, rt: null };
      if (outcome === 'in' || outcome === 'winner') {
        plan.rt = this._evalReturn(m, rcv, Bx, Bz, vx * kh, vz * kh, -vyB * e, t0 + T1);
        if (plan.rt) {
          const react = t0 + (kind === 'serve' ? 0.15 : 0.4);
          const avail = plan.rt.tContact - SWING_T - react - 0.05;
          plan.rt.reach = plan.rt.cost <= RUN_SPEED * Math.max(0, avail) + 0.1;
          plan.rt.avail = avail;
        }
      }
        if (!best) best = plan;
      if (outcome === 'out') { best = plan; break; }
      const ok = plan.rt && plan.rt.reach;
      if (outcome === 'in' && ok) { best = plan; break; }
      if (outcome === 'winner') { best = plan; if (!ok || attempt >= 2) break; }
      if (ok && !(best.rt && best.rt.reach)) best = plan;
    }

    // Launch
    const p = best;
    if (this.debug) {
      const log = this.debugLog || (this.debugLog = []);
      log.push(`${kind}/${outcome} T1=${p.T1.toFixed(2)} ` + (p.rt ? `cost=${p.rt.cost.toFixed(1)} avail=${p.rt.avail.toFixed(2)} reach=${p.rt.reach} clip=${p.rt.clip}` : 'no-rt'));
      if (log.length > 200) log.shift();
    }
    b.launch(t0, C.x, C.y, C.z, p.vx, p.vy0, p.vz);
    m.segType = 'bounce'; m.segEnd = t0 + p.T1;
    sh.outcome = outcome;
    this._recover(m, hitter, t0);
    const rt = p.rt;
    if (!rt) {
      // out: the receiver drifts toward the ball a little, then leaves it
      sh.returnable = false; sh.tContact = INF;
      rcv.tSplit = t0 + 0.05;
      const bx = rcv.npc.body.position.x, bz = rcv.npc.body.position.z;
      rcv.mx = bx + (p.Bx - bx) * 0.25; rcv.mz = bz + (p.Bz - bz) * 0.25; rcv.mSpeed = 2.4;
      rcv.tMove = t0 + 0.45;
      return;
    }
    sh.returnable = rt.reach && outcome !== 'winner';
    if (!rt.reach && outcome === 'in') sh.outcome = 'winner';
    if (rt.reach && outcome === 'winner') { sh.returnable = true; sh.outcome = 'in'; }
    sh.tContact = rt.tContact;
    m.aimPt.set(rt.hx, rt.hy, rt.hz);
    rcv.mx = rt.sx; rcv.mz = rt.sz; rcv.clip = rt.clip;
    const split = rt.tContact - t0 > 1.15 && kind !== 'serve';
    if (split) rcv.tSplit = t0 + 0.04;
    rcv.tMove = t0 + (split ? 0.38 : 0.12);
    const dist = rt.cost;
    const moveTime = Math.max(0.15, rt.tContact - SWING_T - rcv.tMove - 0.06);
    rcv.mSpeed = sh.returnable ? THREE.MathUtils.clamp(dist / moveTime, 1.2, RUN_SPEED + 1) : RUN_SPEED;
    rcv.swingAt = rt.tContact - SWING_T;
    rcv.aim = sh.returnable;
    // Out of reach: a lunge if it is close, otherwise let it go
    const short = dist - RUN_SPEED * Math.max(0, rt.avail);
    rcv.tSwing = sh.returnable || short < 1.2 ? rcv.swingAt : INF;
    // End of the warm-up: the receiver catches... well, lets this one go
    if (kind === 'warmup' && t0 >= m.warmEnd) {
      sh.returnable = false; sh.outcome = 'winner';
      rcv.aim = false; rcv.tSwing = INF; rcv.tMove = INF; rcv.tSplit = INF;
    }
  }

  /** Best receiver contact for a post-bounce flight (both strokes, rising / falling ball). */
  _evalReturn(m, rcv, Bx, Bz, vhx, vhz, vyb, tB) {
    const f = m.frame;
    const npc = rcv.npc;
    const gy = npc.mesh.position.y;
    const cy = Math.cos(rcv.yaw), sy = Math.sin(rcv.yaw);
    const px = npc.body.position.x, pz = npc.body.position.z;
    let best = null, bestCost = INF;
    for (let ci = 0; ci < 2; ci++) {
      const cp = ci === 0 ? rcv.fh : rcv.bh;
      if (!cp) continue;
      const hc = gy + cp.y * rcv.scale;
      const disc = vyb * vyb - 2 * G * (hc - BALL_Y);
      const r0 = disc >= 0 ? Math.sqrt(disc) : 0;
      for (let k = 0; k < (disc >= 0 ? 2 : 1); k++) {
        const tau = disc >= 0 ? (k === 0 ? (vyb + r0) / G : (vyb - r0) / G) : vyb / G;
        if (tau < 0.15) continue;
        const hx = Bx + vhx * tau, hz = Bz + vhz * tau;
        const ox = (cp.x * cy + cp.z * sy) * rcv.scale, oz = (-cp.x * sy + cp.z * cy) * rcv.scale;
        const sx = hx - ox, sz = hz - oz;
        const su = this._lu(f, sx, sz), sv = this._lv(f, sx, sz) * rcv.side;
        if (sv < 1.8 || sv > MAX_STAND_V || su < -f.halfPadL + 0.6 || su > f.halfPadR - 0.6) continue;
        const cost = Math.hypot(sx - px, sz - pz);
        const score = cost + (k === 1 ? 0.6 : 0) + (ci === 1 ? 0.15 : 0);
        if (score < bestCost) {
          bestCost = score;
          best = best || {};
          best.clip = ci === 0 ? 'forehand' : 'backhand';
          best.hx = hx; best.hy = hc; best.hz = hz; best.sx = sx; best.sz = sz;
          best.cost = cost; best.tContact = tB + tau;
        }
      }
    }
    return best;
  }

  _recover(m, p, t0) {
    const f = m.frame;
    const u = THREE.MathUtils.clamp(this._lu(f, p.npc.body.position.x, p.npc.body.position.z) * 0.3, -1.5, 1.5);
    p.rx = this._wx(f, u, p.side * BASE_V); p.rz = this._wz(f, u, p.side * BASE_V);
    p.tRecover = t0 + 0.6;
    p.tSplit = p.tMove = p.tSwing = INF;
  }

  // ───────────────────────────── scoring & chatter ─────────────────────────────

  _awardPoint(m, w, over) {
    const sc = m.score;
    if (w < 0) { this._setupPoint(m, false); return; } // let (e.g. interrupted toss)
    const srvIdx = sc.server;
    // A serve fault is not a point unless it is the second one
    if (m.shot.kind === 'serve' && (m.shot.outcome === 'out' || m.shot.outcome === 'net') && m.faults === 0 && w !== srvIdx) {
      m.faults = 1;
      this._clearRally(m);
      this._setPhase(m, 'setup');
      m.resolved = false;
      const srv = m.players[srvIdx];
      srv.npc.character.setBallVisible(true);
      m.tServe = INF;
      m.callScore = 'second';
      return;
    }
    const L = m.players[1 - w], W = m.players[w];
    // Chatter / reactions (not every point)
    const x = Math.random();
    if (m.shot.outcome === 'winner' && x < 0.4) W.npc.showReaction(x < 0.2 ? '👍' : '😊');
    else if ((m.shot.outcome === 'net' || m.shot.outcome === 'out') && x < 0.35) {
      L.npc.showReaction(L.npc.archetype === 'entitled' ? '😤' : '🤷');
    }

    sc.pts[w]++;
    const a = sc.pts[w], b = sc.pts[1 - w];
    const game = m.noAd ? a >= 4 : (a >= 4 && a - b >= 2);
    if (game) {
      sc.games[w]++;
      sc.pts[0] = sc.pts[1] = 0;
      sc.server = 1 - sc.server;
      if (sc.games[w] >= m.gamesToWin) { m.winner = w; this._startHandshake(m); return; }
      this._say(W, 'Game!', 1.3);
    }
    if (over) { this._endMatch(m); return; }
    this._setupPoint(m, false);
  }

  _endMatch(m) {
    const g = m.score.games, p = m.score.pts;
    m.winner = g[0] !== g[1] ? (g[0] > g[1] ? 0 : 1) : (p[0] !== p[1] ? (p[0] > p[1] ? 0 : 1) : -1);
    this._say(m.players[0], 'Time!', 1.2);
    this._startHandshake(m);
  }

  _scoreCall(m) {
    const sc = m.score, s = sc.server;
    const a = sc.pts[s], b = sc.pts[1 - s];
    if (a === 0 && b === 0) return `Games ${sc.games[s]}–${sc.games[1 - s]}`;
    if (a >= 3 && b >= 3) {
      if (a === b) return m.noAd ? 'Deciding point' : 'Deuce';
      return a > b ? 'Ad in' : 'Ad out';
    }
    if (a === b) return `${SCORE_WORDS[a]}-all`;
    return `${SCORE_WORDS[Math.min(3, a)]}–${SCORE_WORDS[Math.min(3, b)]}`;
  }

  _say(p, text, sec) { try { p.npc.say(text, sec); } catch (e) { /* bubble is cosmetic */ } }

  // ───────────────────────────── handshake ─────────────────────────────

  _startHandshake(m) {
    this._clearRally(m);
    this._setPhase(m, 'handshake');
    const f = m.frame;
    for (const p of m.players) {
      const u = -p.side * 0.26, v = p.side * 0.55;
      p.npc.setFacing(p.yaw);
      p.npc.moveTo(this._wx(f, u, v), this._wz(f, u, v), { speed: 1.8, gait: 'walk' });
      p.shook = false;
    }
    m.reactAt = INF; m.leaveAt = INF;
  }

  _updateHandshake(m) {
    const t = m.phaseT;
    const [a, b] = m.players;
    if (m.reactAt === INF) {
      const arrived = !a.npc.moving && !b.npc.moving && a.npc.state === 'playing' && b.npc.state === 'playing';
      if (arrived || t > 25) {
        for (const p of m.players) { p.npc.stopMove(); p.npc.mesh.rotation.y = p.yaw; p.npc.swing('greet', { fade: 0.2 }); }
        m.reactAt = t + 1.7;
      }
      return;
    }
    if (t >= m.reactAt && m.leaveAt === INF) {
      const W = m.winner >= 0 ? m.players[m.winner] : null;
      const L = m.winner >= 0 ? m.players[1 - m.winner] : null;
      if (W) {
        W.npc.showReaction('🎉');
        this._say(W, 'Good match!', 1.8);
        const sore = L.npc.archetype === 'entitled';
        L.npc.showReaction(sore ? '😤' : '🤷');
        if (Math.random() < 0.6) this._say(L, sore ? 'Hmph. Rematch.' : 'Well played!', 1.8);
      } else {
        for (const p of m.players) p.npc.showReaction('😊');
        this._say(a, 'A draw!', 1.6);
      }
      m.leaveAt = t + 3.2;
    }
    if (t >= m.leaveAt) this._startWalkOut(m);
  }

  // ───────────────────────────── audio / wear ─────────────────────────────

  _pock(pos, kind) {
    const s = this.sound;
    if (!s || typeof s.playBallHit !== 'function' || !CameraTracker.valid) return;
    const c = CameraTracker.position;
    const d = Math.sqrt((c.x - pos.x) ** 2 + (c.y - pos.y) ** 2 + (c.z - pos.z) ** 2);
    const k = 1 - d / 55;
    if (k <= 0) return;
    s.playBallHit(Math.pow(k, 1.6), kind);
  }

  _queueWear(m, x, z, r, a) {
    if (!m.frame.wear || m.wearN >= 16) return;
    const i = m.wearN++ * 4;
    m.wear[i] = x; m.wear[i + 1] = z; m.wear[i + 2] = r; m.wear[i + 3] = a;
  }

  _flushWear(m) {
    if (!m.wearN) return;
    const c = m.frame.court;
    for (let k = 0; k < m.wearN; k++) {
      const i = k * 4;
      try { c.wearAt(m.wear[i], m.wear[i + 1], m.wear[i + 2], m.wear[i + 3]); } catch (e) { m.frame.wear = false; break; }
    }
    m.wearN = 0;
  }

  // ───────────────────────────── debug / info ─────────────────────────────

  /**
   * Start a match now (dev). ids: two npc ids (default: the first two available pool members).
   * opts: { teleport: place players on the baselines, warmup: seconds, gamesToWin }
   */
  debugStart(courtId = 'court1', ids = null, opts = {}) {
    const frame = this._frames.get(courtId);
    if (!frame) return `unknown court ${courtId}`;
    const existing = this.matches.find(m => m.frame.id === courtId);
    if (existing) this._finish(existing);
    const busy = this._missionNpcs();
    let npcs = (ids || []).map(id => this._npcById.get(id)).filter(Boolean);
    for (const n of npcs) {
      for (const m of this.matches.slice()) if (m.players.some(p => p.npc === n)) this._finish(m);
      if (n.state === 'talking') n.stopTalking();
    }
    if (npcs.length < 2) {
      const extra = this.pool.map(id => this._npcById.get(id)).filter(n => n && !npcs.includes(n) && this._available(n, busy));
      npcs = npcs.concat(extra).slice(0, 2);
    }
    if (npcs.length < 2) return 'not enough free players';
    const m = this._startMatch(frame, npcs, { ...opts, entry: { id: 'debug', start: this.weather.timeOfDay, end: opts.end ?? INF } });
    return `${courtId}: ${m.players[0].npc.id} vs ${m.players[1].npc.id}`;
  }

  debugStop(courtId) {
    const m = this.matches.find(x => x.frame.id === courtId);
    if (m) this._startWalkOut(m);
    return !!m;
  }

  /** Summary of the running matches (allocates; debug / HUD polling only). */
  list() {
    return this.matches.map(m => ({
      court: m.frame.id, entry: m.entry.id, phase: m.phase,
      players: m.players.map(p => p.npc.id),
      games: m.score.games.slice(), points: m.score.pts.slice(), server: m.score.server,
      rally: m.rallyLen, t: +m.t.toFixed(2),
    }));
  }
}
