import * as THREE from 'three';
import { getClipEventRacketPoint, CLIP_DEFS } from '../entities/CharacterAnimations.js';
import { BallPredictor, HALF_L, SERVICE_L } from './TennisBallSim.js';
import { RafaTactics } from './TennisTactics.js';

/**
 * TennisAI — Coach Rafa across the net: his eyes, feet and racket (the decisions about what to
 * do with the ball live in TennisTactics).
 *
 * Reading: when a ball comes his way he walks the predicted, spin-aware flight (BallPredictor)
 * and scores every candidate contact for five strokes — forehand / backhand after the bounce,
 * forehand / backhand volley out of the air, and the overhead smash for lobs and high balls —
 * using each clip's racket-head contact probe (getClipEventRacketPoint) to find the spot he has
 * to stand on. Reaction time, foot speed and reach come from the difficulty; he leaves balls that
 * are going out (the session's willBeIn read).
 *
 * Swinging: every clip's lead is its own contact event time (CLIP_DEFS), minus the point in the
 * clip he starts from: a relaxed full swing when he is early, a compact one (the backswing
 * already made, e.g. the block return of a fast serve) when he is rushed. The clip always runs
 * at timeScale 1 (well inside the one-shot early-end limit). At swing start the real racket
 * probe goes to session.scheduleContact(1, tc, racketPoint), so the ball meets the strings.
 *
 * Positioning: returns stand deeper against fast serves and step in on second serves; after
 * each shot he recovers to the centre of the player's possible angles (or follows an approach
 * shot / a serve to the net). Difficulty (DIFFICULTY) sets all of it, so Easy stays friendly:
 * slower, safer, no net rushes, patient in long rallies. Also feeds balls in the drills and
 * serves in matches.
 */

export const DIFFICULTY = {
  easy: {
    label: 'Easy', xp: 0.8,
    // Eyes and feet: reaction (s), foot speed (m/s), reach tolerance (m), the most the ball may be
    // re-aimed onto his racket (m, horizontal), lunge (how far out of reach he still swings),
    // early (steps in to take short balls on the rise), netSpeed (× foot speed at the net: lunges)
    react: 0.36, speed: 4.6, tol: 0.2, bend: 0.9, lunge: 0.6, early: 0, netSpeed: 0.75,
    // Rally ball: pace (m/s), depth band (m from the net), width (fraction of the half court),
    // how far inside the lines he aims, scatter [u, depth, net clearance] (m), mishit rate per
    // shot (raised by a hard ball, a risky shot, nerves and long rallies), flat / slice share
    pace: [11.5, 14], depth: [7.6, 10], width: 0.5, safeU: 1.3, safeV: 2.0,
    sigma: [0.7, 0.85, 0.13], err: 0.15, flat: 0.08, slice: 0.22,
    // Tactics: risk appetite, patience (fewer risky shots as a rally grows), target shares (open
    // court, behind a runner, the weaker wing), approach off short balls and net position, depth
    // behind the baseline, drop shots / drop volleys, lobs against a net player / when stretched
    aggression: 0.1, patience: 0.6, openCourt: 0.35, behind: 0, weakWing: 0,
    approach: 0, netDepth: 4.8, backDepth: 0.45, drop: 0, dropVolley: 0, lobAtNet: 0.35, lobDefend: 0.2,
    smashPace: [12.5, 15],
    // Return of serve: reaction, extra reach, depth behind the baseline (+ per m/s of serve pace
    // above 16), step in on second serves (m)
    ret: { react: 0.32, tol: 0.1, bend: 1.0, back: 0.5, paceBack: 0.1, stepIn: 0.6 },
    // Serve: pace, fault rates, placement (wide / at the weaker wing), spin mix (kick = high bounce,
    // slice = low skid, the rest flat), serve-and-volley
    serve: { pace: [12.5, 15], fault1: 0.14, fault2: 0.04, wide: 0.3, kick1: 0, slice1: 0.6, kick2: 0, slice2: 1, weak: 0, serveVolley: 0 },
  },
  medium: {
    label: 'Medium', xp: 1,
    react: 0.28, speed: 5.1, tol: 0.18, bend: 0.95, lunge: 0.75, early: 0.35, netSpeed: 0.75,
    pace: [15, 18.2], depth: [8.6, 11], width: 0.76, safeU: 1.0, safeV: 1.45,
    sigma: [0.6, 0.75, 0.12], err: 0.106, flat: 0.2, slice: 0.2,
    aggression: 0.62, patience: 0.1, openCourt: 0.55, behind: 0.08, weakWing: 0.15,
    approach: 0.25, netDepth: 4.3, backDepth: 0.35, drop: 0.05, dropVolley: 0.12, lobAtNet: 0.35, lobDefend: 0.28,
    smashPace: [15, 18.5],
    ret: { react: 0.22, tol: 0.35, bend: 1.15, back: 0.65, paceBack: 0.14, stepIn: 0.8 },
    serve: { pace: [14.5, 18], fault1: 0.18, fault2: 0.05, wide: 0.45, kick1: 0, slice1: 0.4, kick2: 0, slice2: 0.8, weak: 0.15, serveVolley: 0 },
  },
  hard: {
    label: 'Hard', xp: 1.35,
    react: 0.2, speed: 5.75, tol: 0.15, bend: 1.0, lunge: 0.85, early: 0.7, netSpeed: 0.72,
    pace: [15.5, 19], depth: [9.2, 11.2], width: 0.78, safeU: 0.9, safeV: 1.3,
    sigma: [0.44, 0.55, 0.09], err: 0.064, flat: 0.24, slice: 0.14,
    aggression: 0.7, patience: 0, openCourt: 0.62, behind: 0.15, weakWing: 0.35,
    approach: 0.38, netDepth: 3.9, backDepth: 0.25, drop: 0.1, dropVolley: 0.25, lobAtNet: 0.45, lobDefend: 0.35,
    smashPace: [16, 19.5],
    ret: { react: 0.17, tol: 0.55, bend: 1.25, back: 0.75, paceBack: 0.16, stepIn: 1.0 },
    serve: { pace: [16, 19.5], fault1: 0.22, fault2: 0.06, wide: 0.5, kick1: 0.04, slice1: 0.35, kick2: 0.1, slice2: 0.6, weak: 0.35, serveVolley: 0.12 },
  },
};

// Rafa's strokes: forehand, backhand (after the bounce), volleys (out of the air), smash (high)
const STROKES = ['forehand', 'backhand', 'volley_fh', 'volley_bh', 'smash'];
const N = STROKES.length;
const OH = 4;
// Each clip's contact event (s), from the clip definitions
const CT = STROKES.map(n => CLIP_DEFS[n].events.contact);
// Where in the clip a relaxed swing starts, and the latest a compact (block) swing may start:
// forehand / backhand hold their full backswing at 0.30, volleys their take-back at 0.16, the
// smash its trophy pose at 0.25–0.35
const START_FULL = [0, 0, 0, 0, 0.2];
const START_MIN = [0.24, 0.24, 0.1, 0.1, 0.3];
// Contact window around the clip's contact height: how far below / above the ball may be (m)
const LOW = [0.52, 0.45, 0.62, 0.55, 0.45];
const HIGH = [0.85, 0.8, 0.5, 0.45, 0.55];
const SWING_T = CT[0];     // forehand contact (drill feeds; kept for older imports)
const INF = Infinity;
const clamp = THREE.MathUtils.clamp;
const _v = new THREE.Vector3();

export class TennisAI {
  /** @param {TennisSession} session */
  constructor(session) {
    this.s = session;
    this.npc = null;
    this.diff = DIFFICULTY.medium;
    this.diffKey = 'medium';
    this.pred = new BallPredictor();
    this.pred2 = new BallPredictor();
    this.cps = STROKES.map(n => getClipEventRacketPoint(n));   // racket head at contact, model space
    this.plan = {
      ok: false, reach: false, clip: 'forehand', ci: 0, tc: INF, sx: 0, sz: 0, hx: 0, hy: 0, hz: 0, cost: 0, avail: 0,
      stretch: 0, lead: CT[0], startAt: 0, block: false, bounces: 1, dy: 0, speed: 5,
    };
    this.stats = {};
    this.tactics = new RafaTactics(this);
    this.mode = 'base';        // 'base' | 'net'
    this.recU = 0; this.recV = HALF_L + 0.4; this.recRun = false;
    this.inPace = 12;
    this._resetStats();
    this.reset();
  }

  attach(npc) { this.npc = npc; this.scale = npc.modelScale || 0.9; }

  setDifficulty(key) {
    this.diff = DIFFICULTY[key] || DIFFICULTY.medium;
    this.diffKey = DIFFICULTY[key] ? key : 'medium';
    this._resetStats();
    this.tactics.scout.reset();
  }

  _resetStats() {
    const st = this.stats;
    for (const k of ['shots', 'returns', 'blockReturns', 'volleys', 'smashes', 'drops', 'lobs', 'passes', 'approaches',
      'serveVolleys', 'behind', 'weak', 'letGo', 'lunges', 'misses', 'unreached', 'compact', 'mishits', 'finish', 'overheads']) st[k] = 0;
  }

  reset() {
    this.tSplit = this.tMove = this.tSwing = this.tRecover = this.tFaceNet = INF;
    this.mx = 0; this.mz = 0; this.mSpeed = 3; this.mFace = true;
    this.swingClip = 'forehand';
    this.plan.ok = false;
    this.feedPlan = null;
    this.feedAt = INF;
    this.tFeedSwing = INF;
    this.swingStart = INF;
    this.mode = 'base';
    this.recRun = false;
    this._resolvedSeen = false;
  }

  get side() { return this.s.sides[1]; }
  get yaw() { return this.s.frame.r + (this.side > 0 ? Math.PI : 0); }

  /**
   * Place Rafa (court-local) facing the net. The return-of-serve spot the session asks for is
   * adjusted: deeper against a fast server, a step in on second serves.
   */
  place(u, v) {
    const s = this.s, f = s.frame, npc = this.npc, d = this.diff;
    if (s.mode === 'match' && s.srv && s.srv.who === 0 && Math.abs(Math.abs(v) - (HALF_L + 0.7)) < 0.05) {
      const r = d.ret;
      let depth = HALF_L + r.back + (this.tactics.scout.servePace - 16) * r.paceBack;
      if (s.srv.second) depth -= r.stepIn;
      depth = clamp(depth, HALF_L - 1.2, HALF_L + 1.6);
      v = Math.sign(v) * depth;
      u *= 0.92 + 0.1 * (depth - HALF_L);          // further back: the angles open up, stand a bit wider
    }
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
    const s = this.s, npc = this.npc, d = this.diff, f = s.frame, b = s.ball;
    this.tSplit = this.tMove = this.tSwing = this.tRecover = this.tFaceNet = INF;
    this.plan.ok = false;
    const ret = s.fl.kind === 'serve';
    this.inPace = Math.hypot(b.v0.x, b.v0.z);
    // Scouting: which wing hit it, did it go in, and the serve pace
    if (ret) { if (!s.fl.let) this.tactics.scout.onServe(this.inPace); }
    else if (s.swing && s.fl.hitter === 0) this.tactics.scout.onShot(s.swing.clip, willBeIn, s.pl.v * s.sides[0], s.pl.u);
    const bx = npc.body.position.x, bz = npc.body.position.z;
    if (!willBeIn) {
      // Reads it: drifts a step toward it and lets it go
      this.stats.letGo++;
      this.pred.from(b);
      this.pred.at(s.fl.tGround);
      this.mx = bx + (this.pred.x - bx) * 0.2; this.mz = bz + (this.pred.z - bz) * 0.2; this.mSpeed = 2.2; this.mFace = true;
      this.tMove = t + d.react + 0.1;
      return;
    }
    const react = ret ? d.ret.react : d.react;
    const p = this._search(t, react, ret);
    if (!p.ok) {
      // Nothing he can get a racket on: a hopeless chase toward where it will pass him
      this.stats.unreached++;
      this.pred.from(b);
      this.pred.at(Math.min(s.fl.tGround === INF ? t + 1 : s.fl.tGround + 0.35, t + 2.5));
      const cu = clamp(f.lu(this.pred.x, this.pred.z), -6.5, 6.5), cv = clamp(f.lv(this.pred.x, this.pred.z) * this.side, 2, 13.6) * this.side;
      this.mx = f.wx(cu, cv); this.mz = f.wz(cu, cv); this.mSpeed = d.speed; this.mFace = true;
      this.tMove = t + react;
      return;
    }
    const split = p.tc - t > 1.1;
    if (split) this.tSplit = t + 0.04;
    this.tMove = t + Math.max(react, split ? 0.3 : 0);
    // Relaxed full swing when there is time, a compact one when rushed
    const ci = p.ci;
    const tArrive = this.tMove + p.cost / p.speed + (p.cost > 0.5 ? 0.12 : 0);
    const full = CT[ci] - START_FULL[ci], min = CT[ci] - START_MIN[ci];
    const lead = clamp(p.tc - tArrive, min, full);
    p.lead = lead; p.startAt = CT[ci] - lead; p.block = lead < full - 0.08;
    if (p.block) this.stats.compact++;
    const moveTime = Math.max(0.1, p.tc - lead - this.tMove);
    this.mx = p.sx; this.mz = p.sz;
    this.mSpeed = p.reach ? clamp(p.cost / Math.max(0.1, moveTime - 0.1) * 1.08 + 0.2, 1.2, p.speed) : p.speed;
    // Long backpedal (a lob over him): turn and run, face the net again for the stroke
    const dv = (f.lv(p.sx, p.sz) - f.lv(bx, bz)) * this.side;
    this.mFace = !(dv > 3 && dv > Math.abs(f.lu(p.sx, p.sz) - f.lu(bx, bz)));
    this.swingClip = p.clip;
    this.swingStart = p.tc - lead;
    this.tFaceNet = this.mFace ? INF : this.swingStart - 0.45;   // turn back to the net before the stroke
    // Out of reach: a lunge if it is close, otherwise he lets it go
    const short = p.cost - p.speed * Math.max(0, p.avail);
    const lunge = !p.reach && short < d.lunge + (ret ? d.ret.tol : 0);
    if (lunge) this.stats.lunges++;
    if (!p.reach && !lunge) this.stats.unreached++;
    this.tSwing = p.reach || lunge ? this.swingStart : INF;
  }

  /**
   * Best contact on the predicted flight: every stroke, out of the air (volleys / smash) or after
   * the bounce (groundstrokes / high smash). Writes this.plan.
   */
  _search(t, react, ret) {
    const s = this.s, f = s.frame, npc = this.npc, d = this.diff, pl = this.plan;
    const pred = this.pred.from(s.ball);
    const px = npc.body.position.x, pz = npc.body.position.z;
    const gy = npc.mesh.position.y;
    const yaw = this.yaw, cy = Math.cos(yaw), sy = Math.sin(yaw), sc = this.scale;
    const side = this.side;
    const myV = f.lv(px, pz) * side;
    const lobbed = s.fl.shot === 'lob';
    const netMode = this.mode === 'net';
    const tol = d.tol + (ret ? d.ret.tol : 0);
    const early = d.early;
    // At the net he lunges and shuffles rather than sprints (and has less time to read)
    const speed = netMode && myV < SERVICE_L + 0.5 ? d.speed * d.netSpeed : d.speed;
    let bestScore = INF;
    pl.ok = false;
    const t1 = Math.min(t + 3.4, (s.fl.tGround === INF ? t + 3.4 : s.fl.tGround + 1.9));
    for (let tt = t + 0.12; tt < t1; tt += 0.02) {
      const nb = pred.at(tt);
      const tot = s.ball.bounced + nb;
      if (tot >= 2) break;
      const bv = f.lv(pred.x, pred.z) * side;
      if (bv < 0.45) continue;                  // not over the net yet
      const by = pred.y - gy;                   // ball height above his feet
      for (let ci = 0; ci < N; ci++) {
        if (tot === 0) {
          // Out of the air: volleys (net play or already forward), smash on lobs / high balls
          if (ret || ci < 2) continue;
          if (ci !== OH && !(netMode || myV < 8.5)) continue;
          if (ci === OH && !(lobbed || netMode || myV < 9.5)) continue;
        } else if (ci === 2 || ci === 3) continue;  // volley clips only out of the air
        // Overhead after the bounce: a lob, a high ball inside the court, or a big kick serve
        else if (ci === OH && !(lobbed ? by > 1.5 : by > (ret ? 1.9 : 1.75) && (ret || bv < 9.5))) continue;
        const cp = this.cps[ci];
        const hc = cp.y * sc;
        const dy = by - hc;
        if (dy < -LOW[ci] || dy > HIGH[ci]) continue;
        const ox = (cp.x * cy + cp.z * sy) * sc, oz = (-cp.x * sy + cp.z * cy) * sc;
        const sx = pred.x - ox, sz = pred.z - oz;
        const su = f.lu(sx, sz), sv = f.lv(sx, sz) * side;
        if (sv < 1.75 || sv > 14.0 || Math.abs(su) > 7.6) continue;
        const cost = Math.hypot(sx - px, sz - pz);
        const minLead = CT[ci] - START_MIN[ci];
        const avail = tt - minLead - (t + react) - (cost > 0.5 ? 0.12 : 0);
        const reach = cost <= speed * Math.max(0, avail) + tol;
        // Comfort: the right height, not too much running, a slight preference for the forehand,
        // for volleys at the net (never let it drop at his feet), early contacts when aggressive
        // (stepping in on short balls), the smash only when it is the natural stroke
        let score = (reach ? 0 : 40 + cost - speed * Math.max(0, avail))
          + cost * 0.45
          + (dy > 0 ? dy * dy * 2.6 : dy * dy * 3.6)
          + (tt - t) * 0.15
          + (ci === 1 ? 0.1 : ci === 3 ? 0.08 : 0);
        if (tot === 0 && ci !== OH) score += netMode ? -0.9 : 0.5;
        else if (tot === 1 && netMode && ci !== OH) score += 0.7;
        if (ci === OH) score += lobbed || tot === 0 ? (by > hc - 0.1 ? -0.3 : 0.5) : ret ? 1.6 : 0.9;
        if (tot === 1 && !netMode && ci !== OH) score -= early * 0.12 * clamp(12.8 - sv, 0, 3.5);
        if (score < bestScore) {
          bestScore = score;
          pl.ok = true; pl.reach = reach; pl.ci = ci; pl.clip = STROKES[ci]; pl.bounces = tot;
          pl.tc = tt; pl.sx = sx; pl.sz = sz; pl.hx = pred.x; pl.hy = pred.y; pl.hz = pred.z; pl.dy = dy;
          pl.cost = cost; pl.avail = avail; pl.speed = speed;
          pl.stretch = avail > 0 ? Math.min(1.5, cost / (speed * avail + 0.01)) : 1.5;
        }
      }
    }
    if (pl.ok && Math.abs(pl.dy) > 0.45) pl.stretch = Math.max(pl.stretch, 0.5 + 0.4 * Math.abs(pl.dy));
    return pl;
  }

  /** Cancel whatever he was about to do (point over). */
  standDown() {
    this.tSplit = this.tMove = this.tSwing = this.tRecover = this.tFaceNet = INF;
    this.plan.ok = false;
    if (this.npc && !this.npc.isBusyClip()) this.npc.stopMove();
  }

  /** After his shot: recover (to the spot TennisTactics chose) `delay` seconds from now. */
  recover(t, delay = 0.55) {
    this.tRecover = t + delay;
  }

  update(t) {
    const npc = this.npc, s = this.s;
    if (!npc) return;
    if (t >= this.tSplit) { this.tSplit = INF; if (!npc.isBusyClip()) npc.swing('split_step', { fade: 0.08 }); }
    if (t >= this.tMove) { this.tMove = INF; npc.moveTo(this.mx, this.mz, { speed: this.mSpeed, face: this.mFace ? this.yaw : null }); }
    if (t >= this.tFaceNet) {
      this.tFaceNet = INF;
      if (npc.moving) npc.moveTo(this.mx, this.mz, { speed: this.mSpeed, face: this.yaw });
    }
    if (t >= this.tSwing) { this.tSwing = INF; this._startSwing(t); }
    if (t >= this.tRecover) {
      this.tRecover = INF;
      const f = s.frame, d = this.diff;
      const x = f.wx(this.recU, this.side * this.recV), z = f.wz(this.recU, this.side * this.recV);
      const dist = Math.hypot(x - npc.body.position.x, z - npc.body.position.z);
      const speed = this.recRun ? d.speed : clamp(dist / 0.9, 2.6, Math.min(4.2, d.speed));
      npc.moveTo(x, z, { speed, face: this.yaw });
    }
    if (t >= this.feedAt) this._feedToss(t);
    if (t >= this.tFeedSwing) { this.tFeedSwing = INF; npc.swing('forehand', { fade: 0.1 }); }
    // A rally ended: the scout notes a player whiff (the swing that missed his ball)
    const fl = s.fl;
    if (fl.resolved) {
      if (!this._resolvedSeen) {
        this._resolvedSeen = true;
        if (s.mode === 'match' && fl.hitter === 1 && s._pointWhy === 'winner' && s.pl.swung && s.swing && s.swing.q === 0) {
          this.tactics.scout.onWhiff(s.swing.clip);
        }
      }
    } else this._resolvedSeen = false;
  }

  _startSwing(t) {
    const npc = this.npc, pl = this.plan, s = this.s, d = this.diff;
    npc.stopMove();
    npc.mesh.rotation.y = this.yaw;
    npc.setFacing(this.yaw);
    const late = Math.min(0.12, Math.max(0, t - this.swingStart));
    const sa = Math.min(pl.startAt + late, CT[pl.ci] - 0.05);
    npc.swing(pl.clip, { fade: 0.1, startAt: sa > 0.001 ? sa : undefined });
    const fl = s.fl;
    if (!pl.ok || fl.resolved || fl.receiver !== 1 || fl.contactBy >= 0) return;
    npc.mesh.updateMatrixWorld(true);
    npc.character.getContactPointWorld(pl.clip, _v);
    // Where the ball really is at contact (same flight, same bounce count), and how far the
    // strings are from it: small misses are a re-aim, big ones a miss
    const pred = this.pred2.from(s.ball);
    const nb = pred.at(pl.tc);
    const ret = fl.kind === 'serve';
    const bend = ret ? d.ret.bend : d.bend;
    const dh = Math.hypot(_v.x - pred.x, _v.z - pred.z), dv = Math.abs(_v.y - pred.y);
    if (s.ball.bounced + nb !== pl.bounces || dh > bend || dv > Math.max(LOW[pl.ci], HIGH[pl.ci]) + 0.2) {
      this.stats.misses++;
      return;
    }
    s.scheduleContact(1, pl.tc, _v);
  }

  // ─────────────────────────── hitting ───────────────────────────

  /**
   * Choose Rafa's shot at contact. Writes and returns out = { spin, u, v, pace, margin, minT, kind }.
   * pressure 0..1+ (how stretched he was, how hard the incoming ball was).
   */
  chooseShot(out, pressure) {
    return this.tactics.chooseShot(out, pressure);
  }

  /** Serve target / pace. deuce: serving from the deuce side. second: second serve. */
  chooseServe(out, deuce, second) {
    return this.tactics.chooseServe(out, deuce, second);
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
    this.tFeedSwing = t + tau - CT[0];
  }
}

export { SWING_T, STROKES as AI_STROKES };
