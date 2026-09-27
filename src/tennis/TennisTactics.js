import { SINGLES_W, SERVICE_L, HALF_L, SURF, netTop } from './TennisBallSim.js';

/**
 * TennisTactics — how Coach Rafa decides what to do with the ball (TennisAI does the feet,
 * the eyes and the racket). Pure decision code on plain numbers, no per-frame work:
 *
 *  - Scout: what he has learned about the player this match (error rate per wing, whiffs,
 *    serve pace, net rushes) → the weaker wing to attack and how deep to stand on the return.
 *  - chooseShot: shot family (drive, approach, passing shot, lob, drop shot, volley, drop
 *    volley, smash, block / drive return, defensive slice) from the situation — his position
 *    and balance, the player's position and movement, the incoming ball, the rally length, the
 *    score pressure and his momentum — then a target with the difficulty's safety margins, a
 *    launch speed and a spin, and his execution sampled from his skill (_execute: a timing error
 *    against his green window, the odd mishit, where the ball meets his strings). The physics
 *    (ShotMaker) makes the shot from that: errors are never dice on the outcome — a late swing
 *    pushes it wide or long, an early one pulls it or dips it into the net, so aiming close to a
 *    line is a real risk.
 *  - chooseServe: spin (flat / slice / kick), placement (T, body, wide, the weaker wing), speed,
 *    the toss timing (faults come out of it), serve-and-volley.
 *  - recoveryU: the centre of the player's possible reply angles (bisector), so he recovers
 *    toward the right spot after each shot instead of the middle of the baseline.
 *
 * Court frame: u across (shared by both players), v along; the player's half has v·sides[0] > 0.
 * "depth" below is a distance from the net on the player's side.
 */

const W = SINGLES_W;
const EXCESS_MAX = 0.055;   // the most his timing goes past his green window (s)
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Wing of a player stroke clip: 0 forehand side, 1 backhand side, -1 (overhead / unknown). */
export function wingOf(clip) {
  if (clip === 'forehand' || clip === 'volley_fh') return 0;
  if (clip === 'backhand' || clip === 'volley_bh') return 1;
  return -1;
}

export class Scout {
  constructor() { this.reset(); }

  reset() {
    this.shots = [0, 0];      // player strokes seen per wing (forehand, backhand)
    this.err = [0, 0];        // …of which errors (out, net, whiffed)
    this.servePace = 24;      // running average of the player's serve pace (m/s, average to the bounce)
    this.serves = 0;
    this.netRushes = 0;       // player shots hit from inside the service line
    this.lastU = 0;           // where the player hit the last ball from (court u, distance from the net)
    this.lastD = HALF_L;
  }

  onShot(clip, inPlay, fromNet, u) {
    const w = wingOf(clip);
    if (w >= 0) { this.shots[w]++; if (!inPlay) this.err[w]++; }
    if (fromNet < SERVICE_L) this.netRushes++;
    this.lastU = u; this.lastD = fromNet;
  }

  onWhiff(clip) {
    const w = wingOf(clip);
    if (w >= 0) { this.shots[w]++; this.err[w]++; }
  }

  onServe(pace) {
    this.serves++;
    const k = this.serves < 4 ? 1 / this.serves : 0.25;
    this.servePace += (pace - this.servePace) * k;
  }

  /** Error rate per wing with a prior that assumes a slightly weaker backhand. */
  rate(w) { return (this.err[w] + (w === 1 ? 1.2 : 0.8)) / (this.shots[w] + 6); }

  /** 0 = forehand, 1 = backhand: the wing to attack. */
  weakWing() { return this.rate(0) > this.rate(1) + 0.04 ? 0 : 1; }
}

/**
 * Centre of the player's possible reply angles at Rafa's depth `depth` (distance from the net),
 * for a player hitting from (uc, vc) (vc = distance from the net on the player's side).
 * Baseline: the sharp cross-court angle (short) versus the deep line; at the net: both passing
 * lanes. The bisector point splits the two extreme reply lines by their lengths.
 */
export function recoveryU(uc, vc, depth, atNet) {
  let dA, dB;                                   // reply depths on the −W / +W sidelines
  if (atNet) { dA = dB = HALF_L - 1; }
  else {
    const cross = SERVICE_L + 1.6, line = HALF_L - 0.3;
    const k = clamp(uc / 3, -1, 1);
    dA = line + (cross - line) * Math.max(0, k);   // from the right the sharp angle goes to −W
    dB = line + (cross - line) * Math.max(0, -k);
  }
  const reach = depth + vc;
  const uA = uc + (-W - uc) * reach / (dA + vc);
  const uB = uc + (W - uc) * reach / (dB + vc);
  const LA = Math.hypot(uA - uc, reach), LB = Math.hypot(uB - uc, reach);
  return uA + (uB - uA) * LA / (LA + LB);
}

/**
 * Rafa's shot decisions. `ai` is the TennisAI (difficulty, plan, stats, npc, session).
 */
export class RafaTactics {
  constructor(ai) {
    this.ai = ai;
    this.scout = new Scout();
    // Rally shot context (filled by chooseShot, reused)
    this.ctx = {
      ret: false, volley: false, smash: false, block: false, hc: 0, mySv: 0, myU: 0, stretch: 0, vin: 0, slow: 0, heavy: 0,
      pu: 0, pd: 0, pvu: 0, fh: 1, rally: 0, nerves: 1, mo: 0, high: false, low: false, lobbed: false, dropped: false,
      wide: 0,
    };
  }

  get s() { return this.ai.s; }
  get d() { return this.ai.diff; }

  /** Score pressure and momentum → a multiplier on his scatter (and his appetite for risk). */
  _nerves() {
    const s = this.s;
    const mo = s.momentum ? s.momentum[1] : 0;
    let k = 1 - 0.2 * mo;                         // in the zone: tighter; low: looser
    const pr = s.score && s.mode === 'match' ? s.score.pressure() : null;
    if (pr && pr.kind !== 'game') k *= pr.for === 0 ? 1.2 - 0.08 * mo : 1.08;  // facing it / playing for it
    return k;
  }

  // ─────────────────────────── rally shots ───────────────────────────

  /**
   * Choose the shot at contact. Writes and returns out = { spin, u, v, speed (launch m/s) or pace
   * (lobs / drops: average m/s), margin, minT, kind, phys ('ground' | 'volley' | 'smash'), wing
   * ('fh' | 'bh'), e / gw / a / b (his execution, sampled: see _execute) }.
   * pressure: the session's read (stretch, a great incoming ball, a flat drive).
   */
  chooseShot(out, pressure) {
    const ai = this.ai, s = this.s, d = this.d, f = s.frame, b = s.ball, npc = ai.npc, plan = ai.plan;
    const c = this.ctx, st = ai.stats;
    const side = ai.side, ps = s.sides[0];
    c.ret = s.fl.kind === 'serve';
    c.volley = b.bounced === 0 && !c.ret;
    c.smash = ai.swingClip === 'smash';
    c.block = !!plan.block;
    c.hc = b.pos.y - SURF;
    c.mySv = f.lv(npc.body.position.x, npc.body.position.z) * side;
    c.myU = f.lu(npc.body.position.x, npc.body.position.z);
    c.stretch = plan.stretch || 0;
    c.vin = ai.inPace;
    c.pu = s.pl.u; c.pd = s.pl.v * ps; c.pvu = s.pl.vu;
    c.fh = ps;                                    // the player's forehand is at u = pu + ps·δ
    // Pulled wide: the player hit the last ball from out wide (−1 / +1), or is still out there
    const lu = this.scout.lastU;
    c.wide = Math.abs(c.pu) > 2.4 ? Math.sign(c.pu) : Math.abs(lu) > 2.4 && !c.ret ? Math.sign(lu) : 0;
    c.rally = s.rallyShots;
    c.mo = s.momentum ? s.momentum[1] : 0;
    c.nerves = this._nerves();
    c.high = !c.smash && c.hc > 1.45;
    c.low = c.hc < 0.45;
    // The incoming ball (its average pace to the bounce): a soft one gives him time (attack it),
    // a heavy one rushes him
    c.slow = clamp((15 - c.vin) / 5, 0, 1);
    c.heavy = c.ret ? 0 : clamp((c.vin - 19) / 6, 0, 1);
    c.lobbed = s.fl.shot === 'lob';
    c.dropped = s.fl.shot === 'drop';
    out.minT = 0; out.kind = 'rally'; out.speed = 0; out.pace = 0;
    out.phys = c.smash ? 'smash' : c.volley ? 'volley' : 'ground';
    out.wing = plan.clip === 'backhand' || plan.clip === 'volley_bh' ? 'bh' : 'fh';
    st.shots++;
    if (c.volley && !c.smash) st.volleys++;
    if (c.ret) st.returns++;

    // Risk appetite: aggression (difficulty, momentum), patience in long rallies (Easy)
    let appetite = d.aggression * (1 + 0.35 * c.mo) * (1 + 0.6 * c.slow);
    if (c.rally > 4 && d.patience > 0) appetite *= 1 - d.patience * Math.min(1, (c.rally - 4) / 6);
    const defensive = c.stretch > 0.85 || (c.mySv > 13.3 && (c.low || c.high)) || (c.lobbed && c.mySv > 11.5 && !c.smash);
    const playerAtNet = c.pd < 7.2;
    let fam;
    // Out of the air or on a lob: the put-away smash; a high bouncing ball: a controlled overhead
    if (c.smash) fam = c.ret || (!c.volley && !c.lobbed) ? 'overhead' : 'smash';
    else if (c.ret) fam = c.block || c.vin > 26 || c.high ? 'blockReturn' : 'driveReturn';
    else if (c.volley) {
      const aboveNet = b.pos.y > netTop(0) + 0.25;
      if (!aboveNet && c.pd > 11 && Math.random() < d.dropVolley) fam = 'dropVolley';
      else fam = aboveNet ? 'volleyKill' : 'volleyDeep';
    } else if (c.dropped && c.stretch > 0.6) {
      fam = 'dig';                                   // a drop shot run down at full stretch: it sits up
    } else if (playerAtNet) {
      const lobP = d.lobAtNet * (c.pd < 4.6 ? 1.3 : 0.8) * (defensive ? 1.4 : 1);
      fam = Math.random() < lobP ? 'lob' : 'pass';
    } else if (defensive) {
      fam = Math.random() < d.lobDefend * (c.stretch > 1.1 ? 1.5 : 1) ? 'lobDefend' : 'slice';
    } else if (c.mySv < 10.9 && c.hc > 0.45 && c.stretch < 0.6 && !c.dropped && Math.random() < d.approach * (0.6 + appetite) * (1 + c.slow)) {
      fam = 'approach';
    } else if (c.pd > 12.4 && c.mySv < 12.6 && c.stretch < 0.45 && !c.high && Math.random() < d.drop * (c.rally > 3 ? 1.3 : 0.7)) {
      fam = 'drop';
    } else fam = 'drive';
    this._shape(out, fam, appetite);
    this._execute(out, this._fam, pressure, appetite);
    // Where he goes next (net / baseline) and the recovery spot
    this._afterShot(out, fam);
    return out;
  }

  /** Target and flight for a shot family (the intention: his execution comes after). */
  _shape(out, fam, appetite) {
    const ai = this.ai, s = this.s, d = this.d, c = this.ctx, st = ai.stats;
    const ps = s.sides[0];
    const uMax = W - d.safeU;
    const sr = d.shotSpeed;
    let u = 0, depth = 10, spin = 'topspin', speed = rand(sr[0], sr[1]), pace = 0, margin = rand(0.6, 1.0);
    // A shot to the open court (away from the player) / behind a runner / at the weaker wing
    const open = () => (c.pu > 0.3 ? -1 : c.pu < -0.3 ? 1 : (Math.random() < 0.5 ? -1 : 1));
    const weakU = (off) => c.pu + (this.scout.weakWing() === 0 ? 1 : -1) * c.fh * off;
    const baseSpin = () => {
      const x = Math.random();
      return x < d.flat * (0.7 + appetite) ? 'flat' : x < d.flat + d.slice ? 'slice' : 'topspin';
    };
    switch (fam) {
      case 'smash': {
        spin = 'smash'; st.smashes++;
        speed = rand(d.smashSpeed[0], d.smashSpeed[1]);
        margin = rand(0.25, 0.4);
        u = open() * rand(0.55, 1) * uMax;
        depth = Math.random() < 0.4 ? rand(5.8, 7.2) : rand(8.2, HALF_L - d.safeV);
        break;
      }
      case 'overhead': {                             // a high bouncing ball / kick serve taken overhead: controlled
        spin = 'smash'; st.overheads++;
        speed = rand(d.smashSpeed[0], d.smashSpeed[1]) * 0.8;
        margin = rand(0.4, 0.6);
        u = clamp(c.pu * 0.3 + rand(-1.4, 1.4), -uMax, uMax);
        depth = rand(8.4, HALF_L - d.safeV);
        break;
      }
      case 'volleyKill': {
        spin = 'flat';
        speed = rand(17, 22) * (0.9 + 0.2 * appetite);
        margin = rand(0.25, 0.4);
        u = open() * rand(0.6, 1) * uMax;
        depth = Math.random() < 0.55 ? rand(5.2, 7) : rand(8.6, HALF_L - d.safeV);
        break;
      }
      case 'volleyDeep': {
        spin = Math.random() < 0.6 ? 'slice' : 'flat';
        speed = rand(15, 18.5);
        margin = rand(0.35, 0.55);
        u = Math.random() < d.weakWing ? clamp(weakU(2.2), -uMax, uMax) : open() * rand(0.45, 0.9) * uMax;
        depth = rand(8.8, HALF_L - d.safeV);
        break;
      }
      case 'dropVolley': {
        spin = 'drop'; st.drops++;
        speed = 0; pace = rand(6, 7.5); margin = rand(0.2, 0.32); out.minT = rand(0.4, 0.55);
        u = open() * rand(0.4, 0.85) * uMax;
        depth = rand(1.7, 2.9);
        out.kind = 'drop';
        break;
      }
      case 'pass': {
        st.passes++;
        spin = 'topspin';
        speed = rand(sr[0], sr[1]) * 1.04;
        margin = rand(0.25, 0.45);
        // The lane with more room beside the player: down the line deep or a dipping cross angle
        const gapPos = W - c.pu, gapNeg = c.pu + W;
        const sgn = gapPos > gapNeg ? 1 : -1;
        u = sgn * rand(0.75, 1) * uMax;
        depth = Math.abs(u - c.myU) > 4 ? rand(6.2, 8) : rand(9.6, HALF_L - d.safeV);
        break;
      }
      case 'lob': case 'lobDefend': {
        st.lobs++;
        spin = 'lob';
        speed = 0; pace = rand(8, 10);
        margin = 2.5;
        out.minT = fam === 'lob' ? rand(1.5, 1.9) : rand(1.8, 2.25);
        u = fam === 'lob' ? (c.pu > 0 ? -1 : 1) * rand(0.2, 0.75) * uMax : rand(-1.5, 1.5);
        depth = rand(9.6, HALF_L - Math.max(0.9, d.safeV * 0.8));
        break;
      }
      case 'dig': {
        spin = 'slice';
        speed = rand(13, 16);
        margin = rand(0.5, 0.85);
        u = clamp(c.myU * 0.5 + rand(-1.2, 1.2), -uMax, uMax);
        depth = rand(6.2, 9);
        break;
      }
      case 'slice': {                               // stretched: a low, deep, safe slice
        spin = 'slice';
        speed = rand(sr[0], sr[1]) * 0.88;
        margin = rand(0.35, 0.6);
        u = clamp(c.pu * 0.25 + rand(-1.6, 1.6), -uMax, uMax);
        depth = rand(Math.max(d.depth[0], 8.6), HALF_L - d.safeV * 1.1);
        break;
      }
      case 'blockReturn': {
        st.blockReturns++;
        spin = Math.random() < 0.5 ? 'slice' : 'flat';
        speed = rand(sr[0], sr[1]) * rand(0.8, 0.9);
        margin = rand(0.45, 0.7);
        u = Math.random() < d.weakWing ? clamp(weakU(1.6), -uMax * 0.8, uMax * 0.8) : clamp(rand(-1.6, 1.6), -uMax, uMax);
        depth = rand(8.4, HALF_L - d.safeV * 1.1);
        break;
      }
      case 'driveReturn': {                          // a slower / second serve: step in and drive it
        spin = baseSpin() === 'slice' ? 'slice' : 'topspin';
        speed = rand(sr[0], sr[1]) * (0.94 + 0.1 * appetite);
        margin = spin === 'topspin' ? rand(0.55, 0.9) : rand(0.3, 0.5);
        u = Math.random() < d.weakWing ? clamp(weakU(2.4), -uMax, uMax) : open() * rand(0.3, 0.9) * uMax * d.width;
        depth = rand(d.depth[0], d.depth[1]);
        if (c.mySv < HALF_L - 0.2 && Math.random() < d.approach * 0.5) { fam = 'approach'; this._approachFlag = true; }
        break;
      }
      case 'approach': {
        spin = Math.random() < 0.5 ? 'slice' : 'topspin';
        speed = rand(sr[0], sr[1]) * (spin === 'slice' ? 0.92 : 0.98);
        margin = spin === 'slice' ? rand(0.3, 0.5) : rand(0.55, 0.85);
        // Deep, to the weaker wing or down the line (the ball stays in front of him at the net)
        u = Math.random() < d.weakWing + 0.2 ? clamp(weakU(2.4), -uMax, uMax) : clamp(c.myU * 0.9 + rand(-0.8, 0.8), -uMax, uMax);
        depth = rand(Math.max(9.4, d.depth[0]), HALF_L - d.safeV);
        break;
      }
      case 'drop': {
        spin = 'drop'; st.drops++;
        speed = 0; pace = rand(7.5, 9); margin = rand(0.2, 0.34); out.minT = rand(0.45, 0.6);
        u = open() * rand(0.3, 0.85) * uMax;
        depth = rand(2.2, 3.6);
        out.kind = 'drop';
        break;
      }
      default: {                                     // 'drive': the neutral rally ball
        spin = baseSpin();
        speed = rand(sr[0], sr[1]) * (0.94 + 0.12 * appetite) * (spin === 'slice' ? 0.9 : spin === 'flat' ? 1.04 : 1);
        margin = spin === 'topspin' ? rand(0.6, 1.1) : spin === 'slice' ? rand(0.28, 0.5) : rand(0.32, 0.6);
        const wide = d.width * (0.75 + 0.35 * appetite);
        const x = Math.random();
        // A runner: still moving across, or recovering from a wide ball
        const runDir = Math.abs(c.pvu) > 1.8 ? Math.sign(c.pvu) : c.wide ? -c.wide : 0;
        if (runDir && x < d.behind) {
          // Behind the runner: back to where the player is coming from (wrong-foot him)
          st.behind++;
          u = clamp(-runDir * rand(0.6, 1) * uMax, -uMax, uMax);
        } else if (c.wide && Math.random() < appetite * 0.8) {
          // The player was pulled wide: finish into the open court (flatter, harder, wider)
          st.finish++;
          u = -c.wide * rand(0.75, 1) * Math.min(1, wide + 0.15) * uMax;
          if (spin === 'slice') spin = 'topspin';
          speed *= 1.05;
          if (Math.random() < 0.5) { spin = 'flat'; margin = rand(0.32, 0.55); }
        } else if (x < d.behind + d.weakWing) {
          st.weak++;
          u = clamp(weakU(rand(1.6, 2.6)), -uMax, uMax);
        } else if (x < d.behind + d.weakWing + d.openCourt * (Math.abs(c.pu) > 2.2 ? 1.25 : 1)) {
          u = open() * rand(0.5, 1) * wide * uMax;
        } else {
          u = clamp(c.pu * 0.35 + rand(-1, 1) * wide * uMax * 0.55, -uMax, uMax);   // through the middle
        }
        depth = rand(d.depth[0], d.depth[1]);
        // A short cross-court angle now and then (Hard / Medium with appetite)
        if (Math.random() < 0.08 * appetite && Math.abs(u) > 2.2) { depth = rand(6.4, 7.6); u = Math.sign(u) * Math.min(uMax + 0.2, Math.abs(u) + 0.6); }
      }
    }
    // Rafa's swing is also his balance: stretched or rushed balls come back softer
    if (speed && fam !== 'smash' && fam !== 'overhead') {
      speed *= 1 - Math.min(0.14, Math.max(0, c.stretch - 0.4) * 0.2) - (c.block && fam !== 'blockReturn' ? 0.06 : 0) - 0.06 * c.heavy;
    }
    // Rushed by a heavy ball: a drive or slice lands shorter (something to attack)
    if (c.heavy > 0 && (fam === 'drive' || fam === 'slice' || fam === 'driveReturn')) depth -= 1.3 * c.heavy;
    this._fam = fam;
    out.spin = spin; out.speed = speed; out.pace = pace; out.margin = margin;
    out.u = u; out.v = ps * clamp(depth, 1.4, HALF_L + 2);
    this._depth = depth;
  }

  /**
   * His execution — sampled from his skill, never an outcome: a timing error e ~ N(0, σ) against
   * his green half-width gw (σ widened by a hard ball: a stretch, pace, a high or low contact, the
   * score's nerves, a long rally; eased by a sitter), the odd mishit (a timing error well past the
   * green: probability err × the situation, more on a risky shot), and where the ball meets his
   * strings (a, b). ShotMaker's physics turns that into the shot: inside the green it lands where
   * he aimed, outside it the face turns (early pulls / dips, late pushes / floats) — net, long and
   * wide all come out of it.
   */
  _execute(out, fam, pressure, appetite) {
    const d = this.d, c = this.ctx, st = this.ai.stats;
    const X = d.exec;
    const hard = 0.55 * Math.min(1.4, c.stretch) + 0.6 * clamp((c.vin - 17) / 8, 0, 1)
      + (c.high ? 0.35 : 0) + (c.low ? 0.3 : 0) + 0.2 * Math.max(0, pressure || 0) - 0.35 * c.slow;
    let k = Math.max(0.6, 1 + 0.8 * hard) * c.nerves;
    if (c.rally > 9) k *= 1 + 0.03 * (c.rally - 9);           // long rallies end eventually
    // Per family: how hard the stroke is to time (kt) and how risky (the mishit chance)
    let kt = 1, risk = 0;
    switch (fam) {
      case 'smash': kt = 0.85; risk = -0.15; break;
      case 'overhead': kt = 1.05; risk = 0.1; break;
      case 'volleyKill': kt = 0.9; risk = 0.05; break;
      case 'volleyDeep': kt = 1; risk = 0.1; break;
      case 'dropVolley': case 'drop': kt = 1.1; risk = 0.35; break;
      case 'pass': kt = 1.1; risk = 0.35; break;
      case 'lob': case 'lobDefend': kt = 0.8; risk = 0.15; break;
      case 'blockReturn': kt = 0.85; risk = -0.2; break;
      case 'driveReturn': kt = 1; risk = 0.15; break;
      case 'approach': kt = 1; risk = 0.05; break;
      case 'slice': kt = 0.95; risk = 0; break;
      case 'dig': kt = 1.15; risk = 0.2; break;
      default:
        risk = 0.35 * appetite * (1 - 0.6 * c.slow);          // a sitter: time to go for it without much risk
        if (out.spin === 'flat') { kt = 1.1; risk += 0.15; }
    }
    const gw = X.gw * (1 - 0.12 * clamp(hard, 0, 1));
    let e = gauss() * X.sigmaT * k * kt;
    let pErr = d.err * Math.max(0.35, 1 + hard + risk) * c.nerves;
    if (c.rally > 8) pErr += d.err * 0.05 * (c.rally - 8);
    if (Math.random() < pErr) {
      st.mishits++;
      e = (Math.random() < 0.5 ? -1 : 1) * (gw + 0.012 + Math.abs(gauss()) * X.tailT);
    }
    // (a swing is never wilder than this: his misses stay misses by a metre or three, not ten)
    const eMax = gw + EXCESS_MAX;
    out.e = e < -eMax ? -eMax : e > eMax ? eMax : e;
    out.gw = gw;
    // Where the ball meets his strings: off the sweet spot it comes off weaker (shorter, into the
    // net), off the long axis the face twists (it rises long or dips) — outside his green window
    out.a = gauss() * X.sigmaC * (1 + 0.5 * Math.min(1.5, c.stretch));
    out.b = gauss() * X.sigmaC;
    if (fam === 'drop' || fam === 'dropVolley') out.v = this.s.sides[0] * Math.max(1.2, Math.abs(out.v));
  }

  /** After the shot: net or baseline, and where to recover to (TennisAI.recover uses it). */
  _afterShot(out, fam) {
    const ai = this.ai, d = this.d, c = this.ctx, st = ai.stats;
    const tu = out.u, td = Math.abs(out.v);
    let net = ai.mode === 'net';
    if (fam === 'approach' || this._approachFlag) { net = true; st.approaches++; }
    else if (fam === 'lob' || fam === 'lobDefend' || c.mySv > 10.5) net = false;
    else if (c.mySv < 7) net = true;                      // already forward (a drop shot chased down)
    this._approachFlag = false;
    ai.mode = net ? 'net' : 'base';
    // Where the player will hit from: behind the bounce of this ball
    const vc = Math.min(HALF_L + 1.2, td + (fam === 'drop' || fam === 'dropVolley' ? 1.2 : 2));
    const uc = clamp(tu * 1.12, -6, 6);
    if (net) {
      const depth = Math.max(Math.min(d.netDepth, c.mySv), 2.3);
      ai.recU = clamp(recoveryU(uc, vc, depth, true), -2.8, 2.8);
      ai.recV = depth;
      ai.recRun = true;
    } else {
      let depth = HALF_L + d.backDepth;
      if (fam === 'drop' || fam === 'dropVolley') depth = HALF_L - 2.5 - d.aggression * 1.5; // cover the counter-drop
      else if (fam === 'lobDefend' || fam === 'slice') depth = HALF_L + d.backDepth + 0.3;
      ai.recU = clamp(recoveryU(uc, vc, depth, false), -2.2, 2.2);
      ai.recV = depth;
      ai.recRun = c.stretch > 0.7 || Math.abs(c.myU - ai.recU) > 3;
    }
  }

  // ─────────────────────────── serve ───────────────────────────

  /**
   * Serve: the intention (spin, placement, speed, net margin) and the execution — his toss
   * timing sampled (first serves riskier), so faults come out of the physics: early into the net
   * or wide, late long, wide or into the net.
   */
  chooseServe(out, deuce, second) {
    const ai = this.ai, s = this.s, d = this.d, sv = d.serve, st = ai.stats;
    const side = ai.side, r = -side;
    const sgn = deuce ? r : -r;                  // receiver box u sign
    const nerves = this._nerves();
    // Spin: flat (big first serve), slice (swings wide), kick (safe, jumps up)
    const x = Math.random();
    let spin;
    if (second) spin = x < sv.kick2 ? 'kick' : x < sv.kick2 + sv.slice2 ? 'slicesrv' : 'serve';
    else spin = x < sv.kick1 ? 'kick' : x < sv.kick1 + sv.slice1 ? 'slicesrv' : 'serve';
    // Placement: wide, body (at the receiver) or T; Hard reads the weaker wing
    const pu = s.pl.u;
    const y = Math.random();
    let u;
    if (y < sv.weak) {
      const bhSign = this.scout.weakWing() === 0 ? 1 : -1;   // toward the player's weaker wing
      const toward = pu + bhSign * s.sides[0] * 1.5;
      u = sgn * clamp(toward * sgn, 0.4, 3.9);
    } else if (y < sv.weak + sv.wide * (spin === 'slicesrv' ? 1.5 : 1)) u = sgn * rand(3.0, 4.0);
    else u = sgn * (Math.random() < 0.5 ? rand(0.35, 1.2) : rand(1.4, 2.8));
    const v = r * rand(4.6, 6.0);
    out.spin = spin;
    out.speed = rand(sv.speed[0], sv.speed[1]) * (spin === 'kick' ? 0.82 : spin === 'slicesrv' ? 0.9 : 1) * (second ? 0.88 : 1);
    out.pace = 0;
    out.margin = spin === 'kick' ? rand(0.4, 0.65) : spin === 'slicesrv' ? rand(0.2, 0.4) : rand(0.1, 0.3);
    if (second && spin !== 'kick') out.margin += rand(0.15, 0.3);       // a safe, higher second serve
    out.minT = 0; out.kind = 'serve'; out.phys = 'serve'; out.wing = 'fh';
    out.u = u; out.v = v;
    // Execution: the toss timing (the faults come from it) and the contact on his strings
    out.gw = sv.gw;
    out.e = gauss() * (second ? sv.sigmaT2 : sv.sigmaT1) * nerves;
    out.a = gauss() * 0.12; out.b = gauss() * 0.08;
    // Serve and volley (Hard): follow it in
    const snv = !second ? sv.serveVolley : sv.serveVolley * 0.25;
    if (snv > 0 && Math.random() < snv) {
      ai.mode = 'net'; st.serveVolleys++;
      ai.recU = clamp(u * 0.25, -1.2, 1.2); ai.recV = SERVICE_L - 0.4; ai.recRun = true;
    } else {
      ai.mode = 'base';
      ai.recU = clamp(-u * 0.12, -0.8, 0.8); ai.recV = HALF_L + d.backDepth; ai.recRun = false;
    }
    return out;
  }
}
