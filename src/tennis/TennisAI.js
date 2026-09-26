import * as THREE from 'three';
import { getClipEventRacketPoint } from '../entities/CharacterAnimations.js';
import { BallPredictor, SINGLES_W, SERVICE_L, HALF_L, BASE_V } from './TennisBallSim.js';

/**
 * TennisAI — Coach Rafa across the net. Same contact-timing approach as MatchSystem: when a
 * ball comes his way he searches the predicted (spin-aware) flight for the spot where his
 * racket head will meet it (CharacterAnimations contact probe), runs there after his
 * reaction time, starts the forehand / backhand exactly `contact` seconds early and, at swing
 * start, re-aims the remaining flight onto the real racket so the ball meets the strings.
 * Difficulty sets reaction, foot speed, error rate, pace, depth and how hard he goes for the
 * open court. Also feeds balls in the drills and serves in matches.
 */

export const DIFFICULTY = {
  easy: {
    label: 'Easy', react: 0.4, speed: 4.5, err: 0.12, pace: [11.5, 14], depth: [7.6, 10], width: 0.55,
    aimAway: 0.4, flat: 0.1, slice: 0.2, lobAtNet: 0.25, drop: 0,
    serve: { pace: [12.5, 15], fault1: 0.14, fault2: 0.04, wide: 0.35 }, tol: 0.2, xp: 0.8,
  },
  medium: {
    label: 'Medium', react: 0.3, speed: 5.1, err: 0.065, pace: [13.5, 17], depth: [8.6, 11], width: 0.78,
    aimAway: 0.65, flat: 0.2, slice: 0.15, lobAtNet: 0.4, drop: 0.03,
    serve: { pace: [15, 18.5], fault1: 0.2, fault2: 0.05, wide: 0.5 }, tol: 0.12, xp: 1,
  },
  hard: {
    label: 'Hard', react: 0.19, speed: 5.9, err: 0.035, pace: [15.5, 20], depth: [9.4, 11.5], width: 0.92,
    aimAway: 0.85, flat: 0.3, slice: 0.12, lobAtNet: 0.55, drop: 0.06,
    serve: { pace: [17, 21], fault1: 0.25, fault2: 0.06, wide: 0.65 }, tol: 0.05, xp: 1.35,
  },
};

const SWING_T = 0.52;
const INF = Infinity;
const rand = (a, b) => a + Math.random() * (b - a);
const _v = new THREE.Vector3();

export class TennisAI {
  /** @param {TennisSession} session */
  constructor(session) {
    this.s = session;
    this.npc = null;
    this.diff = DIFFICULTY.medium;
    this.pred = new BallPredictor();
    this.fh = getClipEventRacketPoint('forehand');
    this.bh = getClipEventRacketPoint('backhand');
    this.plan = { ok: false, reach: false, clip: 'forehand', tc: INF, sx: 0, sz: 0, hx: 0, hy: 0, hz: 0, cost: 0, avail: 0, stretch: 0 };
    this.reset();
  }

  attach(npc) { this.npc = npc; this.scale = npc.modelScale || 0.87; }

  setDifficulty(key) { this.diff = DIFFICULTY[key] || DIFFICULTY.medium; this.diffKey = DIFFICULTY[key] ? key : 'medium'; }

  reset() {
    this.tSplit = this.tMove = this.tSwing = this.tRecover = INF;
    this.mx = 0; this.mz = 0; this.mSpeed = 3;
    this.swingClip = 'forehand';
    this.plan.ok = false;
    this.feedPlan = null;
    this.feedAt = INF;
    this.tFeedSwing = INF;
    this.swingStart = INF;
  }

  get side() { return this.s.sides[1]; }
  get yaw() { return this.s.frame.r + (this.side > 0 ? Math.PI : 0); }

  /** Place Rafa (court-local) facing the net. */
  place(u, v) {
    const f = this.s.frame, npc = this.npc;
    const x = f.wx(u, v), z = f.wz(u, v);
    npc.stopMove();
    npc.body.position.x = x; npc.body.position.z = z;
    npc.body.velocity.set(0, 0, 0);
    npc.mesh.position.x = x; npc.mesh.position.z = z;
    npc.mesh.rotation.y = this.yaw;
    npc.setFacing(this.yaw, true);
    this.reset();
  }

  // ─────────────────────────── receiving ───────────────────────────

  /**
   * A ball is on its way to Rafa (after the player's contact, a serve, or a net cord).
   * willBeIn: the session's in/out read — he leaves balls that are going out.
   */
  onIncoming(t, willBeIn) {
    const s = this.s, npc = this.npc, d = this.diff;
    this.tSplit = this.tMove = this.tSwing = this.tRecover = INF;
    this.plan.ok = false;
    const bx = npc.body.position.x, bz = npc.body.position.z;
    if (!willBeIn) {
      // Reads it: drifts a step toward it and lets it go
      this.pred.from(s.ball);
      this.pred.at(s.fl.tGround);
      this.mx = bx + (this.pred.x - bx) * 0.2; this.mz = bz + (this.pred.z - bz) * 0.2; this.mSpeed = 2.2;
      this.tMove = t + d.react + 0.1;
      return;
    }
    const p = this._search(t);
    if (!p.ok) { this.tSplit = t + 0.05; return; }
    const split = p.tc - t > 1.1;
    if (split) this.tSplit = t + 0.04;
    this.tMove = t + Math.max(d.react, split ? 0.36 : 0);
    const moveTime = Math.max(0.12, p.tc - SWING_T - this.tMove - 0.05);
    this.mx = p.sx; this.mz = p.sz;
    this.mSpeed = p.reach ? THREE.MathUtils.clamp(p.cost / moveTime, 1.2, d.speed + 0.6) : d.speed;
    this.swingClip = p.clip;
    this.swingStart = p.tc - SWING_T;
    // Out of reach: a lunge if it is close, otherwise he lets it go
    const short = p.cost - d.speed * Math.max(0, p.avail);
    this.tSwing = p.reach || short < 1.3 ? this.swingStart : INF;
  }

  /** Best contact on the predicted flight (post-bounce; he stays back). Writes this.plan. */
  _search(t) {
    const s = this.s, f = s.frame, npc = this.npc, d = this.diff, pl = this.plan;
    const pred = this.pred.from(s.ball);
    const px = npc.body.position.x, pz = npc.body.position.z;
    const gy = s.surfY;
    const yaw = this.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw), sc = this.scale;
    const side = this.side;
    let bestScore = INF;
    pl.ok = false;
    const t1 = Math.min(t + 3.2, (s.fl.tGround === INF ? t + 3.2 : s.fl.tGround + 1.8));
    for (let tt = t + 0.2; tt < t1; tt += 0.02) {
      const nb = pred.at(tt);
      const tot = s.ball.bounced + nb;
      if (tot >= 2) break;
      if (tot === 0) continue; // no volleys: he stays back
      for (let ci = 0; ci < 2; ci++) {
        const cp = ci === 0 ? this.fh : this.bh;
        const hc = gy + cp.y * sc;
        const dy = Math.abs(pred.y - hc);
        if (dy > 0.55) continue;
        const ox = (cp.x * cy + cp.z * sy) * sc, oz = (-cp.x * sy + cp.z * cy) * sc;
        const sx = pred.x - ox, sz = pred.z - oz;
        const su = f.lu(sx, sz), sv = f.lv(sx, sz) * side;
        if (sv < 1.2 || sv > 14.0 || Math.abs(su) > 7.6) continue;
        const cost = Math.hypot(sx - px, sz - pz);
        const avail = tt - SWING_T - (t + d.react);
        const reach = cost <= d.speed * Math.max(0, avail) + d.tol;
        const score = (reach ? 0 : 50 + cost) + cost * 0.5 + dy * 2.2 + (ci === 1 ? 0.12 : 0) + (tt - t) * 0.15;
        if (score < bestScore) {
          bestScore = score;
          pl.ok = true; pl.reach = reach; pl.clip = ci === 0 ? 'forehand' : 'backhand';
          pl.tc = tt; pl.sx = sx; pl.sz = sz; pl.hx = pred.x; pl.hy = pred.y; pl.hz = pred.z;
          pl.cost = cost; pl.avail = avail;
          pl.stretch = avail > 0 ? Math.min(1.5, cost / (d.speed * avail + 0.01)) : 1.5;
        }
      }
    }
    return pl;
  }

  /** Cancel whatever he was about to do (point over). */
  standDown() {
    this.tSplit = this.tMove = this.tSwing = INF;
    this.plan.ok = false;
    if (this.npc && !this.npc.isBusyClip()) this.npc.stopMove();
  }

  /** Walk back toward the middle of his baseline. */
  recover(t, delay = 0.55) {
    this.tRecover = t + delay;
  }

  update(t) {
    const npc = this.npc;
    if (!npc) return;
    if (t >= this.tSplit) { this.tSplit = INF; if (!npc.isBusyClip()) npc.swing('split_step', { fade: 0.08 }); }
    if (t >= this.tMove) { this.tMove = INF; npc.moveTo(this.mx, this.mz, { speed: this.mSpeed, face: this.yaw }); }
    if (t >= this.tSwing) { this.tSwing = INF; this._startSwing(t); }
    if (t >= this.tRecover) {
      this.tRecover = INF;
      const f = this.s.frame;
      const u = THREE.MathUtils.clamp(f.lu(npc.body.position.x, npc.body.position.z) * 0.3, -1.5, 1.5);
      if (!npc.isBusyClip() || !npc.moving) npc.moveTo(f.wx(u, this.side * BASE_V), f.wz(u, this.side * BASE_V), { speed: 3.4, face: this.yaw });
    }
    if (t >= this.feedAt) this._feedToss(t);
    if (t >= this.tFeedSwing) { this.tFeedSwing = INF; npc.swing('forehand', { fade: 0.1 }); }
  }

  _startSwing(t) {
    const npc = this.npc, pl = this.plan, s = this.s;
    npc.stopMove();
    npc.mesh.rotation.y = this.yaw;
    npc.setFacing(this.yaw);
    const late = Math.min(0.2, Math.max(0, t - this.swingStart));
    npc.swing(this.swingClip, { fade: 0.1, startAt: late > 0.001 ? late : undefined });
    if (!pl.ok || !pl.reach || s.fl.resolved || s.fl.receiver !== 1) return;
    npc.mesh.updateMatrixWorld(true);
    npc.character.getContactPointWorld(this.swingClip, _v);
    if (Math.hypot(_v.x - pl.hx, _v.z - pl.hz) > 1.4) return; // could not get there: a miss
    s.scheduleContact(1, pl.tc, _v);
  }

  // ─────────────────────────── hitting ───────────────────────────

  /**
   * Choose Rafa's shot at contact. Writes and returns out = { spin, u, v, pace, margin, minT, kind }.
   * pressure 0..1+ (how stretched he was, how hard the incoming ball was).
   */
  chooseShot(out, pressure) {
    const s = this.s, d = this.diff;
    const ps = s.sides[0];                  // the player's side
    const pu = s.pl.u, pvv = s.pl.v * ps;   // player position (court-local u, distance from net)
    let err = d.err + pressure * 0.1;
    if (s.rallyShots > 8) err += 0.01 * (s.rallyShots - 8);
    out.minT = 0; out.kind = 'rally';
    // Shot type
    const x = Math.random();
    out.spin = x < d.flat ? 'flat' : x < d.flat + d.slice ? 'slice' : 'topspin';
    if (pressure > 0.85 && this.swingClip === 'backhand') out.spin = 'slice';
    const pr = d.pace;
    out.pace = rand(pr[0], pr[1]) * (out.spin === 'slice' ? 0.8 : out.spin === 'flat' ? 1.08 : 1) * (1 - Math.min(0.35, pressure * 0.25));
    out.margin = out.spin === 'topspin' ? rand(0.6, 1.1) : out.spin === 'slice' ? rand(0.25, 0.5) : rand(0.3, 0.6);
    // Target: away from the player (open court) or back through the middle
    const W = SINGLES_W - 0.55;
    let u, v;
    if (Math.random() < d.aimAway) {
      const away = pu > 0 ? -1 : 1;
      u = away * rand(0.55, 1) * d.width * W;
    } else {
      u = THREE.MathUtils.clamp(pu * 0.4 + rand(-1, 1) * d.width * W * 0.55, -W, W);
    }
    v = rand(d.depth[0], d.depth[1]);
    // Player at the net: pass or lob
    if (pvv < 6.5 && Math.random() < d.lobAtNet) {
      out.spin = 'lob'; out.pace = rand(8, 10); out.margin = 2.5; out.minT = rand(1.5, 1.9); v = rand(9.5, 11.3);
    } else if (pvv > 12.4 && Math.random() < d.drop) {
      out.spin = 'slice'; out.pace = rand(7, 9); out.margin = 0.25; v = rand(2.6, 4.2); out.kind = 'drop';
    }
    // Errors
    if (Math.random() < err) {
      if (Math.random() < 0.45) out.margin = -rand(0.12, 0.45);
      else if (Math.random() < 0.55) v = rand(HALF_L + 0.35, HALF_L + 1.6);
      else u = (u >= 0 ? 1 : -1) * rand(SINGLES_W + 0.3, SINGLES_W + 1.3);
    }
    out.u = u;
    out.v = ps * v;
    return out;
  }

  /** Serve target / pace. deuce: serving from the deuce side. second: second serve. */
  chooseServe(out, deuce, second) {
    const d = this.diff.serve;
    const s = this.side, r = -s;
    const sgn = deuce ? r : -r;             // receiver box u sign
    const wide = Math.random() < d.wide;
    let u = sgn * (wide ? rand(3.1, 4.1) : Math.random() < 0.5 ? rand(0.35, 1.2) : rand(1.4, 3));
    let v = r * rand(4.6, 6.1);
    out.spin = second ? 'kick' : 'serve';
    out.pace = rand(d.pace[0], d.pace[1]) * (second ? 0.78 : 1);
    out.margin = second ? rand(0.35, 0.6) : rand(0.1, 0.3);
    out.minT = 0; out.kind = 'serve';
    if (Math.random() < (second ? d.fault2 : d.fault1)) {
      const k = Math.random();
      if (k < 0.4) out.margin = -rand(0.08, 0.3);
      else if (k < 0.75) v = r * rand(SERVICE_L + 0.25, SERVICE_L + 1.3);
      else u = sgn * rand(SINGLES_W + 0.2, SINGLES_W + 0.9);
    }
    out.u = u; out.v = v;
    return out;
  }

  // ─────────────────────────── drills: feeding ───────────────────────────

  /**
   * Feed a ball: toss from his hand into a forehand, then the session plans the flight to
   * `plan` ({ u, v, pace, margin, spin }) at contact.
   */
  feed(t, plan) {
    this.feedPlan = plan;
    this.feedAt = t;
  }

  _feedToss(t) {
    this.feedAt = INF;
    const npc = this.npc, s = this.s;
    if (npc.moving) { this.feedAt = t + 0.25; return; }
    npc.mesh.rotation.y = this.yaw;
    npc.setFacing(this.yaw, true);
    npc.mesh.updateMatrixWorld(true);
    npc.character.setBallVisible(false);
    npc.character.getBallHandWorldPosition(_v);
    const tau = 0.8;
    s.launchToss(1, _v, tau, 'forehand');
    this.tFeedSwing = t + tau - SWING_T;
  }
}
export { SWING_T };
