import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { SIZES, GAME } from '../utils/Constants.js';
import { NPC, bowlGroundLeg } from '../entities/NPC.js';
import { CameraTracker, hashString } from '../entities/CharacterModel.js';
import { getClipEventRacketPoint } from '../entities/CharacterAnimations.js';
import { findSeats, claimSeat } from '../entities/Seats.js';
import { TennisBall, BALL_RADIUS } from '../entities/TennisBall.js';
import { RoutePlanner } from './RoutePlanner.js';
import { parseHour } from './MissionValidation.js';
import { Quality } from '../graphics/Quality.js';
import { EnvState } from '../graphics/EnvState.js';
import { groundAt, inCut, inFootprint, isWanderable, levelOf, sameLevel, planLevelRoute, getGroundModel } from '../world/Ground.js';
import { roomAt } from '../world/NavRooms.js';
import { makeShot } from '../tennis/ShotMaker.js';
import { SURFACES, SPIN, HALF_L, SINGLES_W, SERVICE_L, LINE_TOL } from '../tennis/TennisPhysics.js';

/**
 * MatchSystem — members play tennis on a court schedule (public/data/schedule.json).
 *
 * Flow per match: walk in (fence-aware route) → warm-up rally → points (serve with toss, rally)
 * with no-ad game scoring → handshake at the net and reactions → walk off to a preferred area.
 * Rain sends players to the nearest benches and resumes when it clears; a clay court being
 * groomed ends its match; talking to a player pauses the rally (the point is replayed).
 *
 * Real physics, the same as the after-hours tennis: every ball flies an integrated BallFlight
 * (tennis/BallFlight.js: gravity, drag, Magnus lift, spin decay, the club's wind, the court's
 * friction bounce, the net / net cord, the back fence or Centre Court's end boards, the stands,
 * rolling to rest) and every shot comes out of the racket–ball impact pipeline
 * (tennis/ShotMaker.makeShot). Nothing decides an outcome up front:
 *  - The hitter picks an intention from their npcs.json `tennis` block (memberProfile: the skill
 *    — the level follows it — and the style's leanings): a target (rally depth and width, a serve to the box — wide / T / body — an
 *    attack into the open court off a short ball, a high defensive ball when stretched, a
 *    moonball), a pace, a net margin and a spin (topspin / slice / flat / kick by style).
 *  - Its execution is sampled from the same skill (memberExec): a timing error (σ by skill, wider
 *    when stretched, rushed, taking it on the rise or low; a mishit tail) against the stroke's
 *    green window, and where the ball meets the strings. Inside the window the stroke adapts and
 *    the ball lands on its target; outside it the face turns and tilts and the swing slows, so
 *    errors emerge physically — into the net, long, wide — and a faster, bolder intention is
 *    riskier. Serve faults and double faults come from the same pipeline.
 *  - In / out / net is read off the real flight (judgeFlight: the net-plane event, the first
 *    bounce against the lines / the service box, a net cord on a serve = a let). The receiver
 *    plans a contact on the real flight (planContact: at the peak after the bounce when it is in
 *    the racket's reach — a small hop into it — else where it comes down or rises through the
 *    strike zone), runs there and swings; a ball nobody can reach in time is a winner.
 * The receiver's racket meets the ball because the player moves, not the ball: at swing start the
 * remaining gap between the racket's contact point (CharacterAnimations probe) and the ball is
 * glided (a lunge beyond GLIDE_REACH, a whiff beyond GLIDE_MAX). Shot planning (makeShot, ~1 ms)
 * is queued with its contact time as a deadline and run at most PLAN_BUDGET a frame across all
 * courts. No per-frame allocation; one pooled ball (with one preallocated BallFlight) per court.
 *
 * Heights are per court (frame.surf / frame.ballY from court.surfaceY): the flat courts sit at
 * y 0 and the sunken Centre Court (court6, StadiumLayout) at its baseY. Walks that start or end
 * in the bowl go through Ground.planLevelRoute (the aisles; players walk on and off the court by
 * the Players' Walk), everything else through the RoutePlanner exactly as before; a walk with an
 * end indoors (a member in the lounge) goes out through the building doors (NavRooms, _groundLeg).
 * A stuck walker in the bowl, or indoors where a sidestep would leave the room, re-plans instead
 * of sidestepping, and a hop into / out of the bowl lands on the goal's level (Ground.groundAt).
 * Centre Court players walk off to the concourse by the Players' Walk head and wander on from
 * there; a walk-off goal inside a round obstacle (the garden fountain's basin) moves to the
 * nearest clear waypoint. On Centre Court the 1 m end boards stop only a ball under their cap
 * and between their ends; over them or past the open corners a ball is dead where it meets the
 * stands or the lawn (the flight's 'stands' event); the walkway round the pad is at court level.
 *
 * Court hand-over: a walk-off whose players have left the pad no longer holds its court or a
 * maxConcurrent slot (_handedOver), so the next booking can walk on while they leave (on Centre
 * Court by the other lane of the Players' Walk), and its players may be booked again. A booking
 * whose first choice is Centre Court waits for it while the match there is winding up
 * (handshake / walk-off / past its end) rather than falling back, while its late window allows.
 * getMatch / isLive prefer the match being played over a walk-off on the same court.
 *
 * Hooks for the Centre Court spectators (SpectatorDirector; default null, each call guarded):
 *   onPointEnd(courtId, info)       after a point is scored (not a first-serve fault or a let);
 *                                   info is ONE reused object — read it now, don't keep it:
 *                                   { courtId, winner, winnerNpc, loserNpc,
 *                                     outcome: 'winner'|'ace'|'net'|'out'|'double', rally,
 *                                     gameWon, matchWon, games: [g0, g1] }
 *   onMatchEvent(courtId, kind, m)  kind 'start' | 'rain' | 'resume' | 'handshake' | 'finish';
 *                                   'finish' once per match: when it leaves the list, or just
 *                                   before the next match's 'start' on its court (hand-over)
 * Helpers: getMatch(courtId), isLive(courtId), isBookedSoon(npcId, hours), nextEntryFor(courtId, out).
 * `stats` counts shots, calls, error kinds, plans per frame and their cost (debug / tuning).
 *
 * Debug (dev console): __game.matches.debugStart('court1', ['chad_blake', 'tommy_chen'],
 *   { teleport: true, warmup: 0, gamesToWin: 1 }), .debugStop('court1'), .list(), .stats, .enabled
 */

const SURF_REL = SIZES.courtSurfaceY ?? 0.15;   // pad top above the court's base (frame.surf = y0 + this)
const FENCE_V = 14.2;                   // flat courts: the back fence (the ball's centre at the chain-link)
const BOARD_CAP = 0.06;                 // show court: end-board cap above the board height
const BASE_V = 12.9;                    // baseline stand
const SWING_T = 0.52;                   // forehand / backhand contact (clip event)
const SERVE_RELEASE = 0.62, SERVE_CONTACT = 1.22;
const FEED_T = 0.8;                     // warm-up feed: toss → own forehand
const WALK_SPEED = 1.75;
const INF = Infinity;
const SCORE_WORDS = ['Love', '15', '30', '40'];
const RALLY_PHASES = new Set(['warmup', 'setup', 'point']);
const COURT_PHASES = new Set(['warmup', 'setup', 'point', 'handshake']);
const LIVE_PHASES = new Set(['warmup', 'setup', 'point', 'interrupted']);
const HOP_MIN = 75;                     // a stuck walker may hop to its goal after this (s) …
const HOP_FORCE = 65;                   // … and does, looked at or not, this much later
const LEVEL_OPTS = Object.freeze({ prefer: 'players' });   // bowl walks: the Players' Walk
const PAD_HALF_V = (SIZES.courtDepth ?? 28) / 2 + 0.5;     // pad ends (the back fences) in court-local v
const WAIT_FIRST_MARGIN = 0.25;         // h: a booking waits for Centre Court (first choice) until this before its late limit
const EXIT_NEAR = 12;                   // m: a Centre Court walk-off ends within this of the Players' Walk head
const EXIT_CLEAR = 2;                   // m: …but not on the head itself (the next players come down that way)
const WALKER_R = SIZES.npcRadius ?? 0.35;
const PLAN_BUDGET = 2;                  // shot plans (makeShot) per frame across every court (more only when due)
const HOP_T = 0.28;                     // s: a hop into a high ball (a dip to a low one) over this either side of contact
const DIP_MAX = 0.2;                    // m: the deepest dip (bent knees) to a low ball
const MOVE_EPS = 0.08;                  // NPC.moveTo stops this short of its goal (the glide aims past it)
const TOSS_OPTS = Object.freeze({ gravityOnly: true, maxBounces: 0 });   // a toss only matters until contact

const DEFAULT_SCHEDULE = {
  maxConcurrent: 3,
  format: { gamesToWin: 2, noAd: true, warmupSeconds: 10 },
  lateStartHours: 1,
  pool: [],
  exclude: ['hank_morris'],
  matches: [],
};

const _v1 = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();

// ─────────── member tennis: pure helpers (no three.js / DOM use; Node imports this module with a navigator / localStorage shim) ───────────

/** Contact / reach constants of the member rallies (see planContact). */
export const MEMBER = Object.freeze({
  SWING_T,
  GLIDE_REACH: 0.7,     // m: a gap the correction glide during the swing covers cleanly
  GLIDE_MAX: 1.3,       // m: …up to this it is a stretch (a lunge); beyond it the ball is out of reach
  LOW_BALL: 0.3,        // m: a ball this far below the racket's contact height is still dug out
  PICKUP: 0.2,          // m: …and one this far below it is picked up early on the rise (a deep ball)
  HALF_VOLLEY: 0.45,    // m: a deep, low ball is half-volleyed off the bounce this far below it (last resort)
  MIN_STAND_V: 1.8,     // m from the net: the closest a player stands to hit a ball after its bounce
  MAX_STAND_V: 13.95,   // deepest stand (the back fence's face is at 14.35, a body's radius 0.35)
  PAD_MARGIN: 0.6,      // m inside the pad's side edge
});

/**
 * Skill → play, `a + b·skill` (members' npcs.json tennis.skill, 0.15..0.95). Execution: the timing
 * error σ (s) against the stroke's green half-width (s), the string-contact σ and a mishit tail.
 * Intention: rally pace (average horizontal m/s), net margin, target depth / width / how far
 * inside the lines, the serve paces and margins. Body: run speed, reaction, the highest hop.
 */
export const MEMBER_TUNE = {
  timeSd: [0.06, -0.028],
  gw: [0.034, 0.012],
  contactSd: [0.45, -0.2],
  tail: [0.07, -0.05],
  srvSd: [0.095, -0.05],
  pace: [20.5, 2.5],
  margin: [0.5, -0.25],
  depth: [9.5, 1.3],
  width: [1.3, 0.5],
  insideU: [1.7, -0.6],
  insideV: [1.0, -0.4],
  attack: [0.2, 0.35],
  fhTop: [0.45, 0.45],
  bhSlice: [0.55, -0.35],
  srv1: [19, 8],
  srv2: [15, 5],
  srvIn: [0.55, -0.3],
  srvM1: [0.2, -0.1],
  srvM2: [0.6, -0.3],
  speed: [4.7, 0.9],
  react: [0.36, -0.06],
  lift: [0.2, 0.25],
  windAllow: [0.45, 0.5],
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lin = (k, s) => MEMBER_TUNE[k][0] + MEMBER_TUNE[k][1] * s;
const wxOf = (f, u, v) => f.cx + u * f.c + v * f.s;
const wzOf = (f, u, v) => f.cz - u * f.s + v * f.c;
const luOf = (f, x, z) => (x - f.cx) * f.c - (z - f.cz) * f.s;
const lvOf = (f, x, z) => (x - f.cx) * f.s + (z - f.cz) * f.c;

/** A standard normal sample (Box–Muller; no allocation). */
function randn() {
  let u = Math.random();
  if (u < 1e-12) u = 1e-12;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * Math.random());
}

/**
 * A member's tennis from their npcs.json `tennis` block ({ level, style, skill, hand }): the
 * MEMBER_TUNE lines at their skill, then the style's leanings (topspin / slice / flat hitters,
 * moonballers, big servers, runners, steady defenders, the erratic).
 */
export function memberProfile(tennis, id = '') {
  const t = tennis && typeof tennis === 'object' ? tennis : {};
  let sk = Number(t.skill);
  if (!Number.isFinite(sk)) sk = 0.35 + hashString(String(id) + ':tennis') * 0.5;
  sk = clamp(sk, 0.15, 0.95);
  const st = String(t.style || '').toLowerCase();
  const P = {
    skill: sk,
    timeSd: lin('timeSd', sk), gw: lin('gw', sk), contactSd: lin('contactSd', sk), tail: lin('tail', sk), srvSd: lin('srvSd', sk),
    pace: lin('pace', sk), margin: lin('margin', sk), depth: lin('depth', sk), width: lin('width', sk),
    insideU: lin('insideU', sk), insideV: lin('insideV', sk), attack: lin('attack', sk),
    fhTop: lin('fhTop', sk), bhSlice: lin('bhSlice', sk), flat: 0.12, moon: 0,
    srv1: lin('srv1', sk), srv2: lin('srv2', sk), srvIn: lin('srvIn', sk), srvM1: lin('srvM1', sk), srvM2: lin('srvM2', sk),
    srvSlice: 0.15 + 0.3 * sk, kick: sk > 0.55 ? 0.65 : 0.25,
    speed: lin('speed', sk), react: lin('react', sk), lift: lin('lift', sk), windAllow: lin('windAllow', sk),
  };
  if (/topspin|heavy/.test(st)) { P.fhTop = Math.min(1.25, P.fhTop + 0.3); P.bhSlice *= 0.5; }
  if (/slice|chip/.test(st)) { P.bhSlice = Math.max(P.bhSlice, 0.75); P.srvSlice = Math.max(P.srvSlice, 0.5); }
  if (/flat/.test(st)) { P.flat = 0.5; P.bhSlice *= 0.35; }
  if (/moonball/.test(st)) P.moon = 0.35; else if (/\blob\b/.test(st)) P.moon = 0.12;
  if (/big (first )?serve|first-strike|serve he copied/.test(st)) { P.srv1 += 3; P.srvIn *= 0.8; }
  if (/footwork|legs|hustle|runs down|gets to everything|anticipation/.test(st)) { P.speed += 0.6; P.react -= 0.04; }
  if (/defensive|patience|patient|never misses|returns everything|steady/.test(st)) { P.timeSd *= 0.9; P.margin += 0.15; P.insideU += 0.2; P.insideV += 0.2; }
  if (/falls apart|no idea where/.test(st)) P.tail += 0.03;
  if (/volley|net player|serve-volley|chip-and-charge/.test(st)) P.attack = Math.min(0.9, P.attack + 0.15);
  return P;
}

function setSpin(out, prof, k) {
  out.top = prof.top * k; out.side = prof.side * k; out.gyro = prof.gyro * k;
}

/**
 * A serve's intention into `it` (the makeShot intent + u / v / label / load): the receiver's box
 * (r = the receiver's side, sgn = the box's u sign), wide / T / body; a first serve is flat or
 * sliced and aimed P.srvIn inside the lines, a second is slower, safer and kicked or spun in.
 */
export function serveIntent(it, P, fr, r, sgn, first, rcvU) {
  const sk = P.skill;
  const inside = first ? P.srvIn : P.srvIn + 0.5;
  const x = Math.random();
  let au;
  if (x < 0.42) au = SINGLES_W - inside - Math.abs(randn()) * 0.35;             // wide
  else if (x < 0.84) au = 0.25 + inside * 0.8 + Math.abs(randn()) * 0.35;      // down the T
  else au = clamp(Math.abs(rcvU) + randn() * 0.4, 0.8, SINGLES_W - 1);        // at the body
  if (!first) au = 0.6 * au + 0.4 * (SINGLES_W / 2);
  au = clamp(au, 0.3, SINGLES_W - 0.3);
  const av = clamp(SERVICE_L - inside * 0.9 - Math.abs(randn()) * 0.45, 3.6, SERVICE_L - 0.25);
  it.u = sgn * au; it.v = r * av;
  it.tx = wxOf(fr, it.u, it.v); it.tz = wzOf(fr, it.u, it.v);
  it.kind = 'serve'; it.wing = 'fh'; it.minT = 0; it.speed = 0;
  if (first) {
    const slice = Math.random() < P.srvSlice;
    setSpin(it.profile, slice ? SPIN.slicesrv : SPIN.serve, slice ? 0.5 + 0.5 * sk : 1);
    it.pace = P.srv1 * (0.93 + 0.1 * Math.random());
    it.margin = P.srvM1;
    it.label = slice ? 'slice serve' : 'flat serve';
  } else {
    const kick = Math.random() < P.kick;
    setSpin(it.profile, kick ? SPIN.kick : SPIN.serve, kick ? 0.45 + 0.5 * sk : 1.6);
    it.pace = P.srv2 * (0.93 + 0.1 * Math.random());
    it.margin = P.srvM2;
    it.label = kick ? 'kick serve' : 'second serve';
  }
  it.load = first ? 0.8 : 0.3;
  return it;
}

/**
 * A groundstroke's intention into `it`. h = the hitter at contact { u, v (court-local, the
 * ball), side, wing 'fh'|'bh', stretch (m beyond a clean reach), height (m above the court),
 * inSpin (the incoming ball's spin, m/s: less topspin can be brushed over a heavy ball) },
 * o = the opponent { u, v, side }. Warm-up (warm): a comfortable ball to the partner. Else: an
 * attack into the open court off a short, sitting ball (P.attack), a high safe ball through the
 * middle when stretched or pushed deep, a moonball (moonballers), or a neutral rally ball
 * (cross-court tendency, depth and spread by skill), P.inside inside the lines.
 */
export function rallyIntent(it, P, fr, h, o, warm) {
  const sk = P.skill;
  const r = -h.side;
  let u, depth, pace = P.pace, margin = P.margin, minT = 0, prof = SPIN.topspin, load = P.fhTop, label = 'drive';
  if (warm) {
    u = clamp(o.u + randn() * 0.5, -2.8, 2.8);
    depth = clamp(Math.abs(o.v) - 3.8 + randn() * 0.4, 6.5, 10.5);
    pace = 13 + 3 * sk; margin = 0.9; load = 0.5; label = 'warmup';
  } else {
    const shortBall = Math.abs(h.v) < HALF_L - 2.2 && h.height > 0.55 && h.stretch < 0.15;
    const pushed = h.stretch > 0.25 || Math.abs(h.v) > HALF_L + 0.9;
    if (shortBall && Math.random() < P.attack) {
      const away = o.u > 0.3 ? -1 : o.u < -0.3 ? 1 : (Math.random() < 0.5 ? -1 : 1);
      u = away * (SINGLES_W - P.insideU * 0.8 - Math.abs(randn()) * 0.5);
      depth = HALF_L - P.insideV - Math.abs(randn()) * 0.8;
      pace *= 1.2; margin *= 0.75; label = 'attack';
    } else if (pushed) {
      u = randn() * 1.0; depth = P.depth + 0.6 + randn() * 0.5;
      pace *= 0.8; margin += 0.6; label = 'defend';
    } else if ((h.inSpin || 0) < 8 && Math.random() < P.moon) {
      u = randn() * 1.6; depth = P.depth + 0.8 + randn() * 0.6;
      prof = SPIN.lob; load = 1; pace = 10 + 1.5 * sk; margin = 2.2; minT = 1.35; label = 'moonball';
    } else {
      const cross = -Math.sign(h.u || 1e-3) * Math.min(1, Math.abs(h.u) / 3) * 1.2;
      u = cross + randn() * P.width;
      depth = P.depth + randn() * 0.9;
    }
    if (label !== 'moonball') {
      if (h.wing === 'bh' && Math.random() < (label === 'attack' ? P.bhSlice * 0.3 : P.bhSlice)) {
        prof = SPIN.slice; load = 0.35 + 0.35 * sk; pace *= 0.9; if (label === 'drive') label = 'slice';
      } else if (Math.random() < P.flat) { prof = SPIN.flat; load = 1; if (label === 'drive') label = 'flat'; }
      else { prof = SPIN.topspin; load = h.wing === 'fh' ? P.fhTop : P.fhTop * 0.85; }
    }
    // Over a heavy incoming topspin ball (after its bounce) a racket can only brush so much: ask
    // for what a swing can make (makeShot would otherwise re-plan with less spin, at a cost)
    if (prof !== SPIN.slice) load *= clamp(1.2 - 0.045 * (h.inSpin || 0), 0.5, 1) * (label === 'defend' ? 0.7 : 1);
  }
  const lim = SINGLES_W - P.insideU;
  u = clamp(u, -lim, lim);
  depth = clamp(depth, 5.5, HALF_L - Math.max(0.3, P.insideV));
  it.u = u; it.v = r * depth;
  it.tx = wxOf(fr, u, it.v); it.tz = wzOf(fr, u, it.v);
  setSpin(it.profile, prof, load);
  it.pace = pace * (0.94 + 0.12 * Math.random());
  it.speed = 0; it.margin = margin; it.minT = minT;
  it.kind = 'ground'; it.wing = h.wing; it.label = label;
  it.load = clamp((it.pace - 12) / 12, 0, 1);
  return it;
}

/**
 * A member's execution into `ex` (makeShot's exec: e, gw, a, b): the timing error is normal with
 * σ = P.timeSd × the difficulty (a stretch, a ball taken on the rise or dug out low, a hop, pace
 * coming in; second serves are steadier), a mishit tail (P.tail, more when stretched) widens it,
 * and the string contact scatters by P.contactSd (off-centre toward the tip when stretched, low on
 * a dug-out ball). A bolder load narrows the green window. The warm-up is clean.
 * ctx { serve, first, how 'peak'|'rise'|'fall', stretch, inSpeed, low, lift, load, warm }
 */
export function memberExec(ex, P, ctx) {
  ex.tail = false;
  if (ctx.warm) { ex.e = 0; ex.a = 0; ex.b = 0; ex.gw = 0.05; return ex; }
  const stretch = ctx.stretch || 0, low = ctx.low || 0;
  let k = 1;
  if (ctx.serve) k = (ctx.first ? 1 : 0.7) * P.srvSd / P.timeSd;
  else {
    k += 1.4 * stretch + (ctx.how === 'rise' ? 0.25 : ctx.how === 'fall' ? 0.08 : 0)
      + 0.03 * Math.max(0, (ctx.inSpeed || 0) - 15) + 2.2 * low + 0.35 * (ctx.lift || 0);
  }
  const tail = Math.random() < P.tail * (1 + 1.5 * stretch);
  ex.tail = tail;
  ex.e = randn() * P.timeSd * k * (tail ? 2.7 : 1);
  ex.gw = P.gw * (1.12 - 0.25 * (ctx.load || 0));
  const cs = P.contactSd * (tail ? 2 : 1) * (1 + 0.8 * stretch);
  ex.a = randn() * cs + 0.6 * stretch;
  ex.b = randn() * cs * 0.8 + 1.5 * low;
  return ex;
}

/**
 * The call on a flight, as the players see it: the net-plane event, then the first bounce
 * against the lines (a serve: its box). r = the receiver's side (their half has v·r > 0); sgn = a
 * serve's box u sign (0 in a rally). Writes out { call 'in'|'let'|'out'|'net', tCall, long, wide,
 * short (bounced on its own side), cord, b0 (the first bounce event or null), tDead (an unreturned
 * in-ball's next contact: the second bounce, the fence, the stands) } and returns it.
 */
export function judgeFlight(out, f, fr, r, sgn) {
  const nc = f.netCross();
  const b0 = f.bounce(0);
  out.cord = !!nc && nc.type === 'netcord';
  out.b0 = b0; out.long = false; out.wide = false; out.short = false;
  out.tDead = f.tEnd;
  if (nc && nc.type === 'net' && (!b0 || nc.t <= b0.t)) { out.call = 'net'; out.tCall = nc.t; return out; }
  if (b0 && (!nc || b0.t < nc.t)) { out.call = 'net'; out.short = true; out.tCall = b0.t; return out; }
  if (!b0) {
    out.call = 'out'; out.long = true; out.tCall = f.tEnd;
    for (let i = 0; i < f.nEvents; i++) {
      const e = f.events[i];
      if (e.type === 'fence' || e.type === 'stands' || e.type === 'rest') { out.tCall = e.t; break; }
    }
    return out;
  }
  const u = b0.u, v = b0.v * r;
  const inU = sgn ? (u * sgn >= -LINE_TOL && Math.abs(u) <= SINGLES_W + LINE_TOL) : Math.abs(u) <= SINGLES_W + LINE_TOL;
  const inV = v > 0 && v <= (sgn ? SERVICE_L : HALF_L) + LINE_TOL;
  out.tCall = b0.t;
  if (inU && inV) {
    out.call = sgn && out.cord ? 'let' : 'in';
    for (let i = 0; i < f.nEvents; i++) {
      const e = f.events[i];
      if (e.t > b0.t + 1e-6 && (e.type === 'bounce' || e.type === 'fence' || e.type === 'stands' || e.type === 'rest')) { out.tDead = e.t; break; }
    }
    return out;
  }
  out.call = 'out'; out.long = !inV; out.wide = !inU;
  return out;
}

const _st = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, bounces: 0, rolling: false };

/**
 * Where the receiver meets a flight after its first bounce (the real flight — what they read).
 * For each stroke (forehand / backhand: the racket's contact point `fh` / `bh`, model space, at
 * the player's scale and facing) the contact height is hc = feet + point.y; a hop of up to
 * rc.lift reaches a higher ball. Candidates: the peak after the bounce when it is within the
 * reach (hc − LOW_BALL … hc + lift: "at the peak"), else where the ball comes down through (or
 * rises into) the top of that reach before its next contact (second bounce, fence, stands). The
 * stand spot is the ball minus the racket offset; it must be on the court (MIN / MAX_STAND_V, the
 * pad's sides). Reach: running at rc.speed after rc.react from t0 until the swing starts
 * (contact − SWING_T), the rest glided during the swing (≤ GLIDE_REACH clean, ≤ GLIDE_MAX a
 * stretch). The best by (reachable, the peak, then the falling ball, little running) wins.
 * rc { x, z (body), gy (feet), yaw, scale, side, speed, lift, fh, bh, halfPadL, halfPadR }.
 * Writes out { ok, reach, t, how, clip, x, y, z (ball), sx, sz (stand), cost, avail, short,
 * stretch, lift, low, inSpeed } and returns it (ok false: nothing on the court).
 */
export function planContact(out, f, fr, rc, t0, react) {
  out.ok = false; out.reach = false;
  const b0 = f.bounce(0);
  if (!b0) return out;
  const tB = b0.t;
  let tEnd = f.tEnd;
  for (let i = 0; i < f.nEvents; i++) {
    const e = f.events[i];
    if (e.t > tB + 1e-6 && (e.type === 'bounce' || e.type === 'fence' || e.type === 'stands' || e.type === 'rest')) { tEnd = e.t; break; }
  }
  const ap = f.apex(0);
  const apT = ap ? ap.t : INF, apY = ap ? ap.y : -INF;
  const cy = Math.cos(rc.yaw), sy = Math.sin(rc.yaw);
  const tReady = t0 + react;
  const M = MEMBER;
  let best = INF;
  const peakIn = apT < tEnd - 0.02;
  for (let ci = 0; ci < 2; ci++) {
    const cp = ci ? rc.bh : rc.fh;
    if (!cp) continue;
    const ox = (cp.x * cy + cp.z * sy) * rc.scale, oz = (-cp.x * sy + cp.z * cy) * rc.scale;
    const hc = rc.gy + cp.y * rc.scale, hTop = hc + rc.lift;
    // (the highest point of the reach the ball rises to: the peak itself when it is within it)
    const h1 = peakIn ? Math.min(hTop, apY - 0.03) : hTop;
    for (let k = 0; k < 7; k++) {
      let t = INF, how = 'peak';
      if (k === 0) { if (peakIn && apY <= hTop + 1e-3 && apY >= hc - M.LOW_BALL) t = apT; }
      else if (k === 5) {                                         // a low pick-up early on the rise (deep balls)
        if (h1 > hc - M.PICKUP + 0.05) { t = f.crossHeight(hc - M.PICKUP, tB, peakIn ? apT : tEnd, false); how = 'rise'; }
      } else if (k === 6) {                                       // a half volley off the bounce (a deep, low ball)
        const hv = Math.max(f.ballY + 0.12, hc - M.HALF_VOLLEY);
        if (h1 > hv + 0.03 && best >= 50) { t = f.crossHeight(hv, tB, peakIn ? apT : tEnd, false); how = 'rise'; }
      }
      else if (k === 1) {                                         // on the rise, near the top of the reach
        if (h1 > hc - M.LOW_BALL) { t = f.crossHeight(h1, tB, peakIn ? apT : tEnd, false); how = 'rise'; }
      } else if (k === 2) {                                       // on the rise at the racket's own height
        if (h1 > hc + 0.05) { t = f.crossHeight(hc, tB, peakIn ? apT : tEnd, false); how = 'rise'; }
      } else if (peakIn) {                                        // coming down through the reach
        const hh = k === 3 ? hTop : hc;
        if (apY > hh + 0.05 && (k === 3 || apY > hTop + 0.05 || hTop > hc + 0.05)) { t = f.crossHeight(hh, apT, tEnd, true); how = 'fall'; }
      }
      if (!(t < tEnd - 0.01) || t < tB + 0.03) continue;
      if (t - SWING_T < tReady - 0.18) continue;          // no time to swing
      f.at(t, _st);
      const lift = Math.max(0, _st.y - hc), low = Math.max(0, hc - _st.y);
      const sx = _st.x - ox, sz = _st.z - oz;
      const su = luOf(fr, sx, sz), sv = lvOf(fr, sx, sz) * rc.side;
      if (sv < M.MIN_STAND_V || sv > M.MAX_STAND_V || su < -rc.halfPadL + M.PAD_MARGIN || su > rc.halfPadR - M.PAD_MARGIN) continue;
      const cost = Math.hypot(sx - rc.x, sz - rc.z);
      const avail = t - SWING_T - tReady - 0.05;
      const short = cost - rc.speed * Math.max(0, avail);
      const score = Math.max(0, short - M.GLIDE_REACH) * 5 + (short > M.GLIDE_MAX ? 50 : 0) + 0.25 * cost
        + (how === 'rise' ? 0.6 : how === 'fall' ? 0.2 : 0) + (ci ? 0.1 : 0) + 4 * low + 0.5 * lift;
      if (score >= best) continue;
      best = score;
      out.ok = true; out.reach = short <= M.GLIDE_MAX;
      out.t = t; out.how = how; out.clip = ci ? 'backhand' : 'forehand';
      out.x = _st.x; out.y = _st.y; out.z = _st.z; out.sx = sx; out.sz = sz;
      out.cost = cost; out.avail = avail; out.short = short;
      out.stretch = clamp(short - M.GLIDE_REACH, 0, M.GLIDE_MAX - M.GLIDE_REACH);
      out.lift = lift; out.low = low;
      out.inSpeed = Math.sqrt(_st.vx * _st.vx + _st.vy * _st.vy + _st.vz * _st.vz);
    }
  }
  return out;
}

// Scratch for the shot planning (one plan runs at a time)
const _it = { tx: 0, tz: 0, u: 0, v: 0, profile: { top: 0, side: 0, gyro: 0 }, pace: 0, speed: 0, margin: 0, minT: 0, kind: 'ground', wing: 'fh', label: '', load: 0 };
const _ex = { e: 0, gw: 0.04, a: 0, b: 0, B: null, outSign: 1, tail: false };
const _xc = { serve: false, first: true, how: 'peak', stretch: 0, inSpeed: 0, low: 0, lift: 0, load: 0, warm: false };
const _h = { u: 0, v: 0, side: 1, wing: 'fh', stretch: 0, height: 0, inSpin: 0 };
const _o = { u: 0, v: 0, side: -1 };
const _Bup = { x: 0, y: 1, z: 0 };
const _Bsv = { x: 1, y: 0, z: 0 };
const _pw = { x: 0, z: 0 };
const _planEnv = { surfY: 0, frame: null, fence: null, surface: null, wind: _pw, groundAt: null, net: true };

// ───────────────────────────── the system ─────────────────────────────

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
   * @param {SoundSystem} [o.sound]     playBallHit(volume, kind, surface)
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
    this.physicsWorld = o.physicsWorld || null;
    this.planner = o.physicsWorld ? new RoutePlanner(o.physicsWorld) : null;
    // Ground leg of every walk (planLevelRoute's groundLeg, and the whole route on the flat club;
    // fills `out`: start excluded, goal included). An end indoors (a member in the lounge or the
    // café) takes the building nav graph through the doors, as the NPCs' own bowl routes do (NPC.js
    // bowlGroundLeg: NavRooms, then fence-aware outdoor legs); the RoutePlanner alone starts inside
    // a wall's margin there and runs a straight line through the clubhouse wall. Outdoors: the
    // RoutePlanner over the static boxes, as before.
    this._groundLeg = (ax, az, bx, bz, out) => {
      if (roomAt(ax, az) >= 0 || roomAt(bx, bz) >= 0) return bowlGroundLeg(ax, az, bx, bz, out);
      if (this.planner) return this.planner.plan(ax, az, bx, bz, out);
      out.length = 0;
      out.push({ x: bx, z: bz });
      return out;
    };
    this._leg = [];            // scratch route leg (_plan)
    this._pw = null;           // the bowl's Players' Walk aisle (_playersAisle)
    this._pwLayout = undefined;
    this._exitSpots = null;    // concourse waypoints by the Players' Walk head (_exitSpotsFor)
    this._roundObs = null;     // static round obstacles (the fountain basin …) for walk-off goals
    this._probe = [];          // scratch route (_clearSpot)

    /** (courtId, info) => void after each scored point (see the header); info is reused. */
    this.onPointEnd = null;
    /** (courtId, kind, m) => void: 'start' | 'rain' | 'resume' | 'handshake' | 'finish'. */
    this.onMatchEvent = null;
    this._pointInfo = {
      courtId: '', winner: -1, winnerNpc: null, loserNpc: null, outcome: 'winner',
      rally: 0, gameWon: false, matchWon: false, games: [0, 0],
    };

    /** The club's wind for the members' flights (EnvState; x / z m/s, 0 when calm). */
    this._wind = { x: 0, z: 0 };
    /** Counters for tuning / the dev console (allocation-free increments). */
    this.stats = {
      shots: 0, serves: 0, warm: 0, plans: 0, forced: 0, planMs: 0, planMsMax: 0, framePlansMax: 0,
      launches: 0, launchMs: 0, launchMsMax: 0,
      calls: { in: 0, out: 0, net: 0, let: 0 }, long: 0, wide: 0, short: 0, cords: 0,
      green: 0, offGreen: 0, frameShots: 0, tails: 0, whiffs: 0, chases: 0, lifts: 0, stuck: 0, badPlans: 0,
      how: { peak: 0, rise: 0, fall: 0 }, labels: {},
    };
    this._framePlans = 0;

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
    const surface = SURFACES[court.surface] ? court.surface : (clay ? 'clay' : 'hard');
    const buf = clay ? (SIZES.clayCourtBuffer || 0) : 2;
    // Heights: y0 = the court's base (0 on the flat courts), surf = pad top, ballY = ball centre
    // touching the pad. The sunken Centre Court (stadium) sits at its map.json center.y.
    const y0 = Number(court.baseY) || 0;
    const surf = Number.isFinite(court.surfaceY) ? court.surfaceY : y0 + SURF_REL;
    // Back wall: the flat courts' fence stops every ball at FENCE_V; a show court's end boards
    // (map.json stadium.endBoards) stop only a ball below their cap and between their ends.
    const eb = court.isStadium ? (cfg.stadium?.endBoards || {}) : null;
    const f = {
      court, id: court.id, isClay: clay, surface,
      y0, surf, ballY: surf + BALL_RADIUS, stadium: !!court.isStadium,
      fenceV: eb ? (Number(eb.v0) || 14.3) - BALL_RADIUS : FENCE_V,
      boardTop: eb ? surf + (Number(eb.height) || 1) + BOARD_CAP : INF,
      boardHalfU: eb ? (Number(eb.halfU) || 9) : INF,
      bounceE: SURFACES[surface].e,
      cx: cfg.center?.x ?? 0, cz: cfg.center?.z ?? 0, r, c: Math.cos(r), s: Math.sin(r),
      halfPadL: SIZES.courtWidth / 2 + (cfg.adjacentLeft ? 0 : buf),
      halfPadR: SIZES.courtWidth / 2 + (cfg.adjacentRight ? 0 : buf),
      wear: clay && typeof court.wearAt === 'function',   // footwork / bounce marks: clay only
      env: null,
    };
    // The court as BallFlight sees it (the frame itself carries cx / cz / c / s): the surface's
    // bounce, the back wall (a show court's end boards: open corners), the stands and the lawn
    // of the sunken court, the club's wind (held by each flight from its launch)
    f.env = {
      surfY: surf, frame: f,
      fence: { v: f.fenceV, top: f.boardTop, halfU: f.boardHalfU, open: !!eb },
      surface: SURFACES[surface], wind: this._wind, groundAt: f.stadium ? groundAt : null, net: true,
    };
    return f;
  }
  _wx(f, u, v) { return f.cx + u * f.c + v * f.s; }
  _wz(f, u, v) { return f.cz - u * f.s + v * f.c; }
  _lu(f, x, z) { return (x - f.cx) * f.c - (z - f.cz) * f.s; }
  _lv(f, x, z) { return (x - f.cx) * f.s + (z - f.cz) * f.c; }

  // ───────────────────────────── availability ─────────────────────────────

  isCourtInUse(courtId) { return this.matches.some(m => m.frame.id === courtId); }

  /**
   * The match on `courtId` in any phase (walk-in … walk-off), or null. A court can briefly hold
   * two: the next booking walking in while the last one's players walk off (see _handedOver);
   * the one being played wins. Allocation-free.
   */
  getMatch(courtId) {
    let off = null;
    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      if (m.frame.id !== courtId) continue;
      if (m.phase !== 'walkOut') return m;
      if (!off) off = m;
    }
    return off;
  }

  /** A match on `courtId` is being played (warm-up, points, or paused for a chat). */
  isLive(courtId) {
    const m = this.getMatch(courtId);
    return !!m && LIVE_PHASES.has(m.phase);
  }

  /**
   * `npcId` has a booking today that has not started yet and opens within `hours` (or is open
   * now and may still start). Allocation-free (the spectator director asks this per candidate).
   */
  isBookedSoon(npcId, hours = 0.5) {
    const w = this.weather;
    if (!w || !npcId || !this.enabled) return false;
    const tod = w.timeOfDay;
    const started = this._day === w.day ? this._started : null;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.players[0] !== npcId && e.players[1] !== npcId) continue;
      if (started && started.has(i)) continue;
      if (tod >= e.start - hours && tod <= Math.min(e.end - 0.75, e.start + this.lateStart)) return true;
    }
    return false;
  }

  /**
   * The next booking whose first-choice court is `courtId` and that can still start today, as
   * `out` = { start (hours), players: [id, id] } ('any' for an open slot); null when none.
   * `out` is the caller's (e.g. the Centre Court scoreboard); nothing is allocated.
   */
  nextEntryFor(courtId, out) {
    const w = this.weather;
    if (!w || !out) return null;
    const tod = w.timeOfDay;
    const started = this._day === w.day ? this._started : null;
    let best = null;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.courts[0] !== courtId || (started && started.has(i))) continue;
      if (tod > Math.min(e.end - 0.75, e.start + this.lateStart)) continue;
      if (!best || e.start < best.start) best = e;
    }
    if (!best) return null;
    if (!Array.isArray(out.players)) out.players = [null, null];
    out.start = best.start;
    out.players[0] = best.players[0];
    out.players[1] = best.players[1];
    return out;
  }

  _courtBlocked(frame) {
    if (this._courtHeld(frame.id)) return true;
    return this._grooming(frame);
  }

  /** A match on `courtId` still holds it (anything but a walk-off whose players have left the pad). */
  _courtHeld(courtId) {
    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      if (m.frame.id === courtId && !this._handedOver(m)) return true;
    }
    return false;
  }

  /** Matches that count toward maxConcurrent (a walk-off off the pad no longer does). */
  _activeCount() {
    let n = 0;
    for (let i = 0; i < this.matches.length; i++) if (!this._handedOver(this.matches[i])) n++;
    return n;
  }

  /**
   * A walk-off whose players are all off the pad (or done) has handed its court back: the next
   * booking may start there and it no longer takes a maxConcurrent slot. Latched once true. On
   * Centre Court the Players' Walk keeps the two apart (walk-ons descend its + lane, walk-offs
   * climb the − lane); on the flat courts the walk-offs are already beyond the fence.
   */
  _handedOver(m) {
    if (m.handedOver) return true;
    if (m.phase !== 'walkOut') return false;
    const f = m.frame;
    for (let i = 0; i < m.players.length; i++) {
      const p = m.players[i];
      if (p.done) continue;
      const b = p.npc.body.position;
      const u = this._lu(f, b.x, b.z), v = this._lv(f, b.x, b.z);
      if (u > -f.halfPadL && u < f.halfPadR && v > -PAD_HALF_V && v < PAD_HALF_V) return false;
    }
    m.handedOver = true;
    return true;
  }

  /**
   * Every match on `courtId` is winding up (walking off, shaking hands, or past its booking's end):
   * the court is free in a moment.
   */
  _freeSoon(courtId, tod) {
    let any = false;
    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      if (m.frame.id !== courtId) continue;
      if (m.phase !== 'walkOut' && m.phase !== 'handshake' && tod < m.entry.end) return false;
      any = true;
    }
    return any;
  }

  /**
   * The court a due booking starts on now, or null (none free, or waiting for its first choice):
   * the first free court of its list, except that a booking naming the show court (Centre Court)
   * first waits for it while the match there is winding up and the late window allows (the evening
   * event matches follow cc-pm there, "the final, on Centre Court"). Allocation-free.
   */
  _pickCourt(e, tod, latest) {
    for (let k = 0; k < e.courts.length; k++) {
      const f = this._frames.get(e.courts[k]);
      if (!f) continue;
      if (!this._courtBlocked(f)) return f;
      if (k === 0 && f.stadium && tod < latest - WAIT_FIRST_MARGIN && this._freeSoon(f.id, tod)) return null;
    }
    return null;
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

  /**
   * `npc` can be booked now. Not while in a match, walk-off included — except, with `walkOff`, a
   * walk-off that has handed its court over (_handedOver): a member named in the next booking goes
   * straight to it (e.g. from Centre Court's Players' Walk). Substitutes and "any" picks are never
   * taken off a walk-off.
   */
  _available(npc, busy, walkOff = false) {
    if (!npc || npc.away || this.exclude.has(npc.id)) return false;
    if (npc.state === 'talking') return false;
    if (busy.has(npc.id)) return false; // a pending "!" encounter is fine: talk to them courtside
    const role = this._matchRole(npc);
    if (role === 1 || (role === 2 && !walkOff)) return false;
    return role === 2 || !(npc.playing || npc.state === 'playing');
  }

  /** 0: in no match (or done walking off one), 1: in a match that holds its court, 2: walking off a handed-over one. */
  _matchRole(npc) {
    let role = 0;
    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      for (let k = 0; k < m.players.length; k++) {
        const p = m.players[k];
        if (p.npc !== npc || p.done) continue;
        if (!this._handedOver(m)) return 1;
        role = 2;
      }
    }
    return role;
  }

  /** `npc` joins a new match: a walk-off it was still on lets it go (without stopPlaying). */
  _detach(npc) {
    for (let i = 0; i < this.matches.length; i++) {
      const ps = this.matches[i].players;
      for (let k = 0; k < ps.length; k++) {
        if (ps[k].npc === npc && !ps[k].done) { ps[k].done = true; ps[k].detached = true; }
      }
    }
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
      if (this._activeCount() >= this.maxConcurrent) return;
      const e = this.entries[i];
      if (this._started.has(i)) continue;
      const latest = Math.min(e.end - 0.75, e.start + this.lateStart);
      if (tod < e.start || tod > latest) continue;
      const frame = this._pickCourt(e, tod, latest);
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
      if (npc && (!this._available(npc, busy, true) || out.includes(npc))) {
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

  _acquireBall(frame) {
    let b = this._pool.find(x => !x.inUse);
    if (!b) { b = new TennisBall(this.scene, { flight: true }); this._pool.push(b); }
    b.inUse = true;
    b.groundY = frame.surf;
    b.hide();
    return b;
  }

  _startMatch(frame, npcs, opts = {}) {
    const entry = opts.entry || { id: 'debug', start: this.weather.timeOfDay, end: INF };
    const flip = Math.random() < 0.5;
    const m = {
      frame, entry, day: this.weather.day,
      ball: this._acquireBall(frame),
      phase: 'walkIn', t: 0, phaseT: 0, started: false,
      gamesToWin: opts.gamesToWin ?? this.format.gamesToWin,
      noAd: this.format.noAd,
      warmup: opts.warmup ?? this.format.warmupSeconds,
      warmEnd: 0, feedAt: INF, feeder: 0,
      score: { pts: [0, 0], games: [0, 0], server: Math.random() < 0.5 ? 0 : 1 },
      faults: 0, rallyLen: 0, deuce: true,
      // The ball: its flight (m.ball.flight), what kind it is, the next of its events to play out,
      // the next racket contact (time, striker) and the call on the current shot
      flightKind: 'none', evi: 0, tHit: INF, striker: -1, bounces: 0,
      judge: { call: 'in', tCall: 0, long: false, wide: false, short: false, cord: false, b0: null, tDead: 0 },
      shot: { hitter: 0, receiver: 1, outcome: 'in', returnable: false, missed: false, tContact: INF, kind: 'rally', label: '' },
      aimPt: new THREE.Vector3(),
      srv: { active: false, released: false, tStart: 0, C: new THREE.Vector3() },
      resolved: false, pointWinner: -1, tPointOver: INF, tServe: INF, tNext: INF,
      resumePhase: null, winner: -1, reactAt: INF, leaveAt: INF,
      wear: new Float32Array(4 * 16), wearN: 0, wearT: 0,
      rainT: 0, talkWas: false,
      handedOver: false, finishSent: false,
      players: npcs.map((npc, i) => this._makePlayer(npc, (i === 0) !== flip ? 1 : -1, frame, i)),
    };
    for (const p of m.players) {
      this._detach(p.npc);
      p.npc.startPlaying(frame.id, p.side > 0 ? 'north' : 'south');
      p.npc.character.setBallVisible(false);
    }
    NPC.setAreaBusy(frame.id, true);
    // The court may still hold the last match's walk-off (handed over, see _handedOver): it is over
    // for the court's watchers now ('finish' before this 'start', as with one match per court), and
    // the new match goes in front of it so list scanners (scoreboards) find the one being played.
    let at = this.matches.length;
    for (let i = 0; i < this.matches.length; i++) {
      const o = this.matches[i];
      if (o.frame.id !== frame.id) continue;
      if (i < at) at = i;
      this._emitFinish(o);
    }
    if (at === this.matches.length) this.matches.push(m); else this.matches.splice(at, 0, m);
    for (const p of m.players) {
      const x = this._wx(frame, 0, p.side * BASE_V), z = this._wz(frame, 0, p.side * BASE_V);
      if (opts.teleport) {
        p.npc.body.position.set(x, frame.surf + SIZES.npcRadius + 0.02, z);
        p.npc.body.velocity.set(0, 0, 0);
        p.npc.mesh.position.set(x, frame.surf, z);
        p.npc.mesh.rotation.y = p.yaw;
      }
      this._route(p, x, z, p.yaw);
    }
    this._emitEvent(m, 'start');
    return m;
  }

  _makePlayer(npc, side, frame, idx) {
    const scale = npc.modelScale || 0.87;
    const prof = memberProfile(npc.data && npc.data.tennis, npc.id);
    return {
      npc, side, idx, scale,
      yaw: frame.r + (side > 0 ? Math.PI : 0),
      skill: prof.skill,
      prof,
      fh: getClipEventRacketPoint('forehand'),
      bh: getClipEventRacketPoint('backhand'),
      route: [], ri: 0, arrived: false, endYaw: null, walkT: 0, stuckT: 0, bestD: INF, hopAt: HOP_MIN,
      tSplit: INF, tMove: INF, tSwing: INF, tRecover: INF, swingAt: 0,
      mx: 0, mz: 0, mSpeed: 3, clip: 'forehand', aim: false,
      rx: 0, rz: 0, done: false, detached: false,
      // The next shot: its contact on the incoming flight (planContact), its plan (queued → ready)
      // and the makeShot result; a hop into a high ball
      ct: { ok: false, reach: false, t: 0, how: 'peak', clip: 'forehand', x: 0, y: 0, z: 0, sx: 0, sz: 0, cost: 0, avail: 0, short: 0, stretch: 0, lift: 0, low: 0, inSpeed: 0 },
      rc: { x: 0, z: 0, gy: 0, yaw: 0, scale, side, speed: prof.speed, lift: prof.lift, fh: null, bh: null, halfPadL: frame.halfPadL, halfPadR: frame.halfPadR },
      plan: { state: 0, kind: 'rally', tc: 0, how: 'peak', stretch: 0, low: 0, lift: 0, inSpeed: 0, label: '' },
      res: {},
      lift: 0, liftT0: INF, liftT1: INF,
    };
  }

  /** A member's own post-match line (npcs.json matchLines.win / lose), else the fallback. */
  _matchLine(npc, kind, fallback) {
    const ml = npc.data && npc.data.matchLines;
    const arr = ml && Array.isArray(ml[kind]) ? ml[kind] : null;
    return arr && arr.length ? String(arr[Math.floor(Math.random() * arr.length)]) : fallback;
  }

  /**
   * Waypoints from (ax, az) to (bx, bz) into `out` (start excluded, goal included): through the
   * bowl's aisles when either end is in the Centre Court cut (Ground.planLevelRoute), else the
   * fence / net aware RoutePlanner as always. Players walk onto and off the sunken court by the
   * Players' Walk whichever side of the club they come from: a ground ↔ pit trip is split at the
   * top of that aisle (from its own top it always wins the aisle choice).
   */
  _plan(ax, az, bx, bz, out) {
    const pw = this._playersAisle();
    if (pw && inCut(ax, az) !== inCut(bx, bz)) {
      const la = levelOf(ax, az), lb = levelOf(bx, bz), top = pw.top;
      if (la === 'ground' && lb === 'pit') {
        this._groundLeg(ax, az, top.x, top.z, out);
        return this._append(out, planLevelRoute(top.x, top.z, bx, bz, this._leg, this._groundLeg, LEVEL_OPTS));
      }
      if (la === 'pit' && lb === 'ground') {
        if (planLevelRoute(ax, az, top.x, top.z, out, this._groundLeg, LEVEL_OPTS)) {
          return this._append(out, this._groundLeg(top.x, top.z, bx, bz, this._leg));
        }
      }
    }
    if (planLevelRoute(ax, az, bx, bz, out, this._groundLeg, LEVEL_OPTS)) return out;
    // Flat club: the RoutePlanner as always, or the door-aware leg when an end is indoors
    return this._groundLeg(ax, az, bx, bz, out);
  }

  /** The bowl's Players' Walk aisle (StadiumLayout), or null without a bowl. */
  _playersAisle() {
    const L = getGroundModel();
    if (L !== this._pwLayout) {
      this._pwLayout = L;
      this._pw = L && Array.isArray(L.aisles) ? (L.aisles.find(a => a.players) || null) : null;
    }
    return this._pw;
  }

  /** Append the points of `leg` (a filled route or null) to `out`, skipping a repeat of its last point. */
  _append(out, leg) {
    if (!leg) return out;
    for (let i = 0; i < leg.length; i++) {
      const q = leg[i], l = out[out.length - 1];
      if (l && Math.abs(l.x - q.x) < 1e-6 && Math.abs(l.z - q.z) < 1e-6) continue;
      out.push({ x: q.x, z: q.z });
    }
    leg.length = 0;
    return out;
  }

  /** Plan a walking route for a player (fence / net aware; through the aisles into the bowl). */
  _route(p, x, z, endYaw) {
    const b = p.npc.body.position;
    this._plan(b.x, b.z, x, z, p.route);
    // Long walks (a west-side member to Centre Court) may not hop early: 1.6 × the walking time
    let len = 0, px = b.x, pz = b.z;
    for (let i = 0; i < p.route.length; i++) {
      const w = p.route[i];
      len += Math.hypot(w.x - px, w.z - pz);
      px = w.x; pz = w.z;
    }
    p.hopAt = Math.max(HOP_MIN, 1.6 * len / WALK_SPEED);
    p.ri = 0; p.arrived = false; p.endYaw = endYaw; p.walkT = 0; p.stuckT = 0; p.bestD = INF;
    p.goalX = x; p.goalZ = z; p.retries = 0;
    p.npc.stopMove();
  }

  /**
   * Blocked (column, parked cart, a person): sidestep and re-plan from there. No sidestep in the
   * bowl (stairs, rail openings: it could step off a row edge) or out of the room indoors (it would
   * land behind a wall): there it just re-plans from here, through the aisles / the doors.
   */
  _unstick(p) {
    const npc = p.npc;
    const b = npc.body.position;
    p.retries++;
    const w = p.route[Math.min(p.route.length - 1, Math.max(0, p.ri - 1))] || { x: p.goalX, z: p.goalZ };
    let dx = w.x - b.x, dz = w.z - b.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const side = (p.retries - 1) % 2 ? 1 : -1;
    const sx = b.x - dz * 1.6 * side - dx * 0.5, sz = b.z + dx * 1.6 * side - dz * 0.5;
    const room = roomAt(b.x, b.z);
    if (inFootprint(b.x, b.z, 0) || (room >= 0 && roomAt(sx, sz) !== room)) {
      this._plan(b.x, b.z, p.goalX, p.goalZ, p.route);
      p.ri = 0; p.stuckT = 0; p.bestD = INF;
      npc.stopMove();
      return;
    }
    const rest = this._plan(sx, sz, p.goalX, p.goalZ, []);
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
    if (p.walkT > p.hopAt && p.route.length) {
      const g = p.route[p.route.length - 1];
      const cam = CameraTracker.position;
      if (p.walkT > p.hopAt + HOP_FORCE || !CameraTracker.valid || Math.hypot(cam.x - g.x, cam.z - g.z) > 30) {
        npc.stopMove();
        const b = npc.body.position;
        // Into / out of the bowl: land on the goal's level (a pit spot is 2.85 m down)
        const bowl = inCut(b.x, b.z) || inCut(g.x, g.z);
        b.x = g.x; b.z = g.z;
        if (bowl) {
          const gy = groundAt(g.x, g.z);
          b.y = gy + SIZES.npcRadius + 0.02;
          npc.mesh.position.y = gy;
          // (the NPC's eased ground-follow state too: a short or vertical-only hop doesn't snap by itself)
          npc.snapToGround(gy);
        }
        npc.body.velocity.set(0, 0, 0);
        p.ri = p.route.length;
      }
    }
    return false;
  }

  _setPhase(m, phase) { m.phase = phase; m.phaseT = 0; }

  /** Begin leaving: route each player to one of their preferred spots (see _walkOffGoal). */
  _startWalkOut(m) {
    if (m.phase === 'walkOut') return;
    this._clearRally(m);
    NPC.setAreaBusy(m.frame.id, false);
    this._setPhase(m, 'walkOut');
    let taken = null;          // the first player's goal (Centre Court: the second takes another spot)
    for (const p of m.players) {
      const npc = p.npc;
      p.done = false;
      npc.character.setBallVisible(false);
      if (npc.state !== 'playing' && npc.state !== 'talking') { npc.releaseShelter(); npc.stopPlaying(); p.done = true; continue; }
      let wp = null;
      try { wp = npc._getPreferredWaypoint(); } catch (e) { wp = null; }
      if (!wp) { npc.stopPlaying(); p.done = true; continue; }
      wp = this._walkOffGoal(m, p, wp, taken);
      taken = wp;
      this._route(p, wp.x, wp.z, null);
    }
  }

  /**
   * Where a player walks off to, given their preferred waypoint `wp`:
   *  - Centre Court: up the Players' Walk to the concourse by its head (their preferred spot when
   *    it is that close, else the nearest concourse waypoint; not the one `taken` by the other
   *    player); from there they wander on as members do. Their preferred spot across the club
   *    was a 55–130 m walk that still counted as the match.
   *  - A spot inside a round obstacle (the garden: its first waypoint is the fountain's centre, in
   *    the basin): the nearest clear waypoint (garden_south; garden_north is on the clubhouse wall).
   *  - Anything else: `wp`, as before.
   */
  _walkOffGoal(m, p, wp, taken = null) {
    const pw = m.frame.stadium ? this._playersAisle() : null;
    if (pw) {
      const t = pw.top, d = Math.hypot(wp.x - t.x, wp.z - t.z);
      if (wp !== taken && d <= EXIT_NEAR && d >= EXIT_CLEAR && this._clearSpot(wp.x, wp.z)) return wp;
      const spots = this._exitSpotsFor(pw);
      for (let k = 0; k < spots.length; k++) {
        const s = spots[(p.idx + k) % spots.length];
        if (s !== taken) return s;
      }
      if (spots.length) return spots[0];
    }
    if (!this._blockedAt(wp.x, wp.z)) return wp;
    let best = null, bd = Infinity;
    for (const key in this.waypoints) {
      const w = this.waypoints[key];
      if (!w || w === wp || !this._freeSpot(key, w)) continue;
      const d = (w.x - wp.x) ** 2 + (w.z - wp.z) ** 2;
      if (d < bd) { bd = d; best = w; }
    }
    return best || wp;
  }

  /** A waypoint a member may end a walk-off on: not a duty point, and a clear spot (_clearSpot). */
  _freeSpot(key, w) {
    return !!w && Number.isFinite(w.x) && Number.isFinite(w.z) && !/^(post|patrol)_/i.test(key) && this._clearSpot(w.x, w.z);
  }

  /**
   * (x, z) is somewhere a walk can end: outside the bowl, not in a round obstacle (_blockedAt) and
   * not against a wall — the RoutePlanner would pull a goal there out of the wall's margin, often
   * to the wrong side (garden_north sits on the clubhouse's south wall).
   */
  _clearSpot(x, z) {
    if (!isWanderable(x, z) || this._blockedAt(x, z)) return false;
    if (!this.planner) return true;
    const r = this.planner.plan(x, z, x, z, this._probe);
    const e = r[r.length - 1];
    return !!e && Math.abs(e.x - x) < 1e-6 && Math.abs(e.z - z) < 1e-6;
  }

  /** Concourse waypoints within EXIT_NEAR of the Players' Walk head (not on it), nearest first. Built once. */
  _exitSpotsFor(pw) {
    if (this._exitSpots && this._exitSpots.pw === pw) return this._exitSpots.list;
    const t = pw.top, list = [];
    for (const key in this.waypoints) {
      const w = this.waypoints[key];
      if (!w || !this._freeSpot(key, w) || roomAt(w.x, w.z) >= 0) continue;
      const d = Math.hypot(w.x - t.x, w.z - t.z);
      if (d >= EXIT_CLEAR && d <= EXIT_NEAR) list.push({ w, d });
    }
    list.sort((a, b) => a.d - b.d);
    this._exitSpots = { pw, list: list.map(o => o.w) };
    return this._exitSpots.list;
  }

  /**
   * (x, z) is inside a static round obstacle a walker cannot enter (a Cylinder / Sphere body at
   * walking height — the RoutePlanner only knows boxes): the garden fountain's basin, a trunk.
   */
  _blockedAt(x, z) {
    let obs = this._roundObs;
    if (!obs) {
      obs = this._roundObs = [];
      const bodies = this.physicsWorld ? this.physicsWorld.bodies : [];
      for (const b of bodies) {
        if (b.type !== CANNON.Body.STATIC) continue;
        for (let i = 0; i < b.shapes.length; i++) {
          const s = b.shapes[i];
          let r = 0, h = 0;
          if (s instanceof CANNON.Cylinder) { r = Math.max(s.radiusTop, s.radiusBottom); h = s.height / 2; }
          else if (s instanceof CANNON.Sphere) { r = h = s.radius; }
          else continue;
          const o = b.shapeOffsets[i], cy = b.position.y + o.y;
          if (!(r > 0) || cy + h < 0.05 || cy - h > 1.3) continue;
          obs.push({ x: b.position.x + o.x, z: b.position.z + o.z, r: r + WALKER_R });
        }
      }
    }
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if ((x - o.x) ** 2 + (z - o.z) ** 2 < o.r * o.r) return true;
    }
    return false;
  }

  _finish(m) {
    const i = this.matches.indexOf(m);
    if (i >= 0) this.matches.splice(i, 1);
    this._clearRally(m);
    m.ball.hide();
    m.ball.inUse = false;
    this._flushWear(m);
    if (!this._areaHeld(m.frame.id)) NPC.setAreaBusy(m.frame.id, false);
    for (const p of m.players) {
      if (p.npc.playing && !p.detached) { p.npc.releaseShelter(); p.npc.stopPlaying(); }
    }
    this._emitFinish(m);
  }

  /** Another match on `courtId` keeps it marked busy for wanderers (walking on, playing, shaking hands). */
  _areaHeld(courtId) {
    for (let i = 0; i < this.matches.length; i++) {
      const o = this.matches[i];
      if (o.frame.id === courtId && o.phase !== 'walkOut' && o.phase !== 'rain') return true;
    }
    return false;
  }

  /** The 'finish' hook, once per match: when it leaves, or earlier when the next booking takes the court. */
  _emitFinish(m) {
    if (m.finishSent) return;
    m.finishSent = true;
    this._emitEvent(m, 'finish');
  }

  /** Stop the rally: no ball in play, no contact or shot plan pending, nobody mid-hop. */
  _clearRally(m) {
    m.flightKind = 'none'; m.evi = 0; m.tHit = INF; m.striker = -1;
    m.srv.active = false;
    m.tServe = INF; m.tNext = INF; m.tPointOver = INF; m.feedAt = INF;
    m.ball.hide();
    for (const p of m.players) {
      p.tSplit = p.tMove = p.tSwing = p.tRecover = INF;
      p.plan.state = 0; p.aim = false;
      p.lift = 0; p.liftT0 = p.liftT1 = INF;
      if (!p.detached) p.npc.character.setBallVisible(false);   // (a detached player is in their next match)
    }
  }

  // ───────────────────────────── per frame ─────────────────────────────

  update(dt) {
    if (!this.weather) return;
    this._schedTimer -= dt;
    if (this._schedTimer <= 0) { this._schedTimer = 1; this._checkSchedule(); }
    this._rainClear = this._raining() ? 0 : this._rainClear + dt;
    this._updateWind();

    let lowFrustum = false;
    if (Quality.tier === 'low' && this.camera && this.matches.length) {
      _pm.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pm);
      lowFrustum = true;
    }

    // Shot planning (makeShot) queued by the courts: the most urgent first, PLAN_BUDGET a frame
    this._framePlans = 0;
    if (this.matches.length) this._servicePlans(dt);

    for (let i = this.matches.length - 1; i >= 0; i--) {
      const m = this.matches[i];
      try { this._updateMatch(m, dt); } catch (err) {
        console.error('MatchSystem: match error, ending it', err);
        this._finish(m);
        continue;
      }
      if (this.matches[i] !== m) continue;
      // Ball: its flight at the match clock (LOD: far courts keep logic only)
      const b = m.ball;
      if (b.active) {
        b.at(m.t);
        let vis = true;
        if (CameraTracker.valid) {
          const c = CameraTracker.position;
          const d2 = (c.x - b.pos.x) ** 2 + (c.z - b.pos.z) ** 2;
          vis = d2 < (Quality.tier === 'low' ? 45 * 45 : 80 * 80);
        }
        if (vis && lowFrustum) vis = _frustum.containsPoint(b.pos);
        b.sync(vis);
      } else if (b.shown) b.sync(false);
      // A hop into a high ball / a dip to a low one (the racket meets it at the flight's height):
      // visual only, on top of the ground-follow the NPC update just set
      if (RALLY_PHASES.has(m.phase)) {
        for (let k = 0; k < m.players.length; k++) {
          const p = m.players[k];
          if (p.lift !== 0 && m.t > p.liftT0 && m.t < p.liftT1) {
            p.npc.mesh.position.y += p.lift * Math.sin(Math.PI * (m.t - p.liftT0) / (p.liftT1 - p.liftT0));
          }
        }
      }
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
    if (this._framePlans > this.stats.framePlansMax) this.stats.framePlansMax = this._framePlans;
  }

  /** The club's wind (EnvState: calm ~0.15 → none, windy ~1 → ~3 m/s) for the members' flights. */
  _updateWind() {
    const s = Math.max(0, Math.min(5, ((EnvState.windStrength || 0) - 0.25) * 4));
    const d = EnvState.windDirection;
    this._wind.x = d ? d.x * s : 0;
    this._wind.z = d ? d.z * s : 0;
  }

  /**
   * Run queued shot plans: the most urgent (nearest contact) first, at most PLAN_BUDGET a frame
   * across all courts — a plan whose contact is due within ~two frames runs regardless (and the
   * contact itself runs a missing plan at once), so a contact is never late.
   */
  _servicePlans(dt) {
    for (let pass = 0; pass < 8; pass++) {
      let bm = null, bp = null, slack = INF;
      for (let i = 0; i < this.matches.length; i++) {
        const m = this.matches[i];
        if (!RALLY_PHASES.has(m.phase)) continue;
        for (let k = 0; k < m.players.length; k++) {
          const p = m.players[k];
          if (p.plan.state !== 1) continue;
          const s = p.plan.tc - m.t;
          if (s < slack) { slack = s; bm = m; bp = p; }
        }
      }
      if (!bm) return;
      if (this._framePlans >= PLAN_BUDGET && slack > 2.2 * dt + 0.01) return;
      try { this._runPlan(bm, bp); } catch (err) {
        console.error('MatchSystem: shot planning error, ending the match', err);
        this._finish(bm);
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
          this._emitEvent(m, 'resume');
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

  /**
   * Rain delay: each player shelters on the nearest free bench on their own level, never the
   * reserved stand seats, else at the court's `<id>_bench` waypoint when it is on their level, else
   * beside the court. On Centre Court the levels are the shelter levels (_shelterLevel): anyone
   * down in the cut — on the pad, the walkway or partway up an aisle — takes the pad benches (the
   * pit is always reachable by the aisles); anyone at ground height (the lawn, the lip, row 7) the
   * rim benches or `court6_bench`.
   */
  _startRain(m) {
    const f = m.frame;
    this._clearRally(m);
    this._setPhase(m, 'rain');
    m.rainT = 0;
    NPC.setAreaBusy(f.id, false);
    const seats = findSeats(this.scene);
    for (const p of m.players) {
      const npc = p.npc;
      const x = npc.body.position.x, z = npc.body.position.z;
      const lv = f.stadium ? this._shelterLevel(x, z) : null;
      let best = null, bd = 30 * 30;
      for (const s of seats) {
        if (s.taken && s.taken !== npc) continue;
        if (s.reserved) continue;
        if (lv ? this._shelterLevel(s.x, s.z) !== lv : !sameLevel(s.x, s.z, x, z)) continue;
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      if (best && !claimSeat(best, npc)) best = null;
      const wp = this.waypoints[`${f.id}_bench`];
      let pt = wp && (!lv || this._shelterLevel(wp.x, wp.z) === lv) ? wp : null;
      if (!pt) {
        // Beside the court: on the flat courts past the pad; in the bowl on the pit walkway
        const side = f.stadium ? f.halfPadL + 0.3 : f.halfPadL + 1.5;
        const v = p.side * (f.stadium ? 6 : 2);
        pt = { x: this._wx(f, -side, v), z: this._wz(f, -side, v) };
      }
      npc.shelter(best, pt);
    }
    if (Math.random() < 0.7) this._say(m.players[0], 'Rain delay!', 1.8);
    this._emitEvent(m, 'rain');
  }

  /** Centre Court rain shelter level: 'ground' at lawn height (outside the cut, the lip, row 7), else 'pit'. */
  _shelterLevel(x, z) {
    return !inCut(x, z) || groundAt(x, z) > -0.01 ? 'ground' : 'pit';
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

  /** Feed a warm-up ball: a self toss from the left hand into the feeder's own forehand. */
  _feed(m) {
    const p = m.players[m.feeder];
    const npc = p.npc;
    if (npc.moving) { m.feedAt = m.t + 0.3; return; }
    npc.mesh.rotation.y = p.yaw;
    npc.character.setBallVisible(false);
    npc.character.getBallHandWorldPosition(_v1);
    npc.character.getContactPointWorld('forehand', m.aimPt);
    const tc = m.t + FEED_T;
    this._toss(m, _v1, m.aimPt, tc, m.t);
    m.flightKind = 'feed';
    const sh = m.shot;
    sh.hitter = p.idx; sh.receiver = p.idx; sh.outcome = 'in'; sh.returnable = true; sh.missed = false;
    sh.tContact = tc; sh.kind = 'feed';
    m.bounces = 0; m.resolved = false;
    m.tHit = tc; m.striker = p.idx;
    const pl = p.plan;
    pl.how = 'peak'; pl.stretch = 0; pl.low = 0; pl.lift = 0; pl.inSpeed = 0;
    p.clip = 'forehand'; p.aim = true; p.swingAt = tc - SWING_T; p.tSwing = p.swingAt;
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

    // Serve toss release: the toss flies up to the racket's contact point, the serve is planned
    const s = m.srv;
    if (s.active && !s.released && t >= s.tStart + SERVE_RELEASE) {
      s.released = true;
      const srv = m.players[sc.server];
      srv.npc.character.getBallHandWorldPosition(_v1);
      srv.npc.character.setBallVisible(false);
      const tc = s.tStart + SERVE_CONTACT;
      this._toss(m, _v1, s.C, tc, t);
      m.flightKind = 'toss';
      const sh = m.shot;
      sh.hitter = srv.idx; sh.receiver = srv.idx; sh.returnable = true; sh.missed = false; sh.kind = 'toss';
      sh.tContact = tc;
      m.tHit = tc; m.striker = srv.idx;
      const pl = srv.plan;
      pl.state = 1; pl.kind = 'serve'; pl.tc = tc; pl.how = 'peak'; pl.stretch = 0; pl.low = 0; pl.lift = 0; pl.inSpeed = 0;
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

    // The ball: its flight's events and the next racket contact, in time order (several can
    // fall into one frame; a contact replaces the flight, so what it would have done later is gone)
    const fl = m.ball.flight;
    for (let guard = 0; guard < 16 && m.flightKind !== 'none'; guard++) {
      const tE = m.evi < fl.nEvents ? fl.events[m.evi].t : INF;
      const tH = m.tHit;
      if (tH <= tE) {
        if (tH > t) break;
        this._contact(m);
      } else {
        if (tE > t) break;
        this._flightEvent(m, fl.events[m.evi++]);
      }
    }

    // A point with nothing left to happen (a missed contact, a flight that came to rest) is settled
    if ((m.phase === 'point' || m.phase === 'warmup') && !m.resolved && m.flightKind === 'shot' && m.tHit === INF && t > fl.tEnd + 0.4) {
      this.stats.stuck++;
      this._settle(m);
    } else if (m.phase === 'point' && !m.resolved && m.phaseT > 90) {
      this.stats.stuck++;
      this._setupPoint(m, false);
      return;
    }

    // Point over → score → next
    if (m.resolved && t >= m.tPointOver) {
      m.tPointOver = INF;
      m.ball.hide();
      if (m.phase === 'warmup') {
        if (t >= m.warmEnd) this._setupPoint(m, true);
        else { m.feeder = 1 - m.feeder; m.players[m.feeder].npc.character.setBallVisible(true); m.feedAt = t + 1.2; m.resolved = false; m.flightKind = 'none'; }
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

  /**
   * A toss (the serve's, a warm-up feed): a gravity-only flight (drag still acts) from `from`
   * through the racket's contact point C at time tc. The drag-free launch, then one correction
   * for the drag, so the ball arrives at the strings.
   */
  _toss(m, from, C, tc, t0) {
    const f = m.frame, b = m.ball;
    const tau = Math.max(0.1, tc - t0);
    let vx = (C.x - from.x) / tau, vz = (C.z - from.z) / tau;
    let vy = (C.y - from.y + 0.5 * 9.81 * tau * tau) / tau;
    for (let i = 0; i < 2; i++) {
      b.launchFlight(t0, from.x, from.y, from.z, vx, vy, vz, 0, 0, 0, f.env, TOSS_OPTS);
      if (i === 1) break;
      b.flight.at(tc, _st);
      vx += (C.x - _st.x) / tau; vy += (C.y - _st.y) / tau; vz += (C.z - _st.z) / tau;
    }
    m.evi = 0; m.bounces = 0;
    m.ball.bounced = 0;
  }

  /**
   * Swing start (contact − SWING_T): the stroke clip plays; the gap between where the racket will
   * meet the ball from here (the clip's contact probe) and the ball is glided during the swing —
   * a lunge beyond GLIDE_REACH, a whiff beyond GLIDE_MAX — and the shot is queued for planning
   * with the contact as its deadline. A hop takes the racket up to a high ball.
   */
  _startSwing(m, p, t) {
    const npc = p.npc;
    npc.stopMove();
    npc.mesh.rotation.y = p.yaw;
    npc.setFacing(p.yaw);
    const late = Math.min(0.2, Math.max(0, t - p.swingAt));
    npc.swing(p.clip, { fade: 0.1, startAt: late > 0.001 ? late : undefined });
    if (!p.aim || m.striker !== p.idx || m.tHit === INF) return;
    npc.character.getContactPointWorld(p.clip, _v1);
    const dx = m.aimPt.x - _v1.x, dz = m.aimPt.z - _v1.z;
    const d = Math.hypot(dx, dz);
    if (d > MEMBER.GLIDE_MAX + 0.15) {
      // Too far: the swing misses (the ball flies on — the hitter's point)
      m.shot.missed = true; m.tHit = INF; m.striker = -1; p.aim = false;
      this.stats.whiffs++;
      return;
    }
    if (d > 0.02) {
      // (aimed MOVE_EPS past the spot: moveTo settles that short of its goal)
      const b = npc.body.position, left = Math.max(0.12, m.tHit - t - 0.05), k = (d + MOVE_EPS - 0.005) / d;
      npc.moveTo(b.x + dx * k, b.z + dz * k, { speed: Math.min(4.5, 1.25 * d / left + 0.25), face: p.yaw });
    }
    const pl = p.plan;
    pl.stretch = Math.max(pl.stretch, clamp(d - MEMBER.GLIDE_REACH, 0, MEMBER.GLIDE_MAX - MEMBER.GLIDE_REACH));
    pl.state = 1; pl.tc = m.tHit;
    pl.kind = m.flightKind === 'feed' || m.phase === 'warmup' ? 'warmup' : 'rally';
    // Up to a high ball (a hop), down to a low one (a dip): the racket's height at contact
    const dy = pl.lift > 0.02 ? pl.lift : pl.low > 0.02 ? -Math.min(pl.low, DIP_MAX) : 0;
    p.lift = dy;
    if (dy) { p.liftT0 = m.tHit - HOP_T; p.liftT1 = m.tHit + HOP_T; this.stats.lifts++; } else p.liftT0 = p.liftT1 = INF;
  }

  /**
   * Plan p's shot now (makeShot): the intention (serveIntent / rallyIntent from the player's
   * profile and the situation), its execution (memberExec) and the racket–ball impact at the
   * ball's real state at contact. The result waits in p.res for the contact.
   */
  _runPlan(m, p) {
    const pl = p.plan;
    if (pl.state !== 1) return;
    const t0 = performance.now();
    const f = m.frame;
    const st = m.ball.flight.at(pl.tc, _st);
    const P = p.prof;
    const o = m.players[1 - p.idx];
    const ob = o.npc.body.position;
    const it = _it, ex = _ex, xc = _xc;
    if (pl.kind === 'serve') {
      const r = o.side;
      const sgn = m.deuce ? r : -r;
      const first = m.faults === 0;
      serveIntent(it, P, f, r, sgn, first, this._lu(f, ob.x, ob.z));
      xc.serve = true; xc.first = first; xc.warm = false; xc.how = 'peak'; xc.stretch = 0; xc.low = 0; xc.lift = 0; xc.inSpeed = 0; xc.load = it.load;
      memberExec(ex, P, xc);
      // The racket is upright at contact: its across axis is horizontal, square to the serve;
      // outSign +1 when the box's wide side is the server's left
      const dx = it.tx - st.x, dz = it.tz - st.z, dl = Math.hypot(dx, dz) || 1;
      _Bsv.x = dz / dl; _Bsv.y = 0; _Bsv.z = -dx / dl;
      ex.B = _Bsv;
      ex.outSign = sgn * (f.c * dz + f.s * dx) >= 0 ? 1 : -1;
    } else {
      const warm = pl.kind === 'warmup';
      const h = _h;
      h.u = this._lu(f, st.x, st.z); h.v = this._lv(f, st.x, st.z); h.side = p.side;
      h.wing = p.clip === 'backhand' ? 'bh' : 'fh'; h.stretch = pl.stretch; h.height = st.y - f.surf;
      h.inSpin = Math.sqrt(st.wx * st.wx + st.wy * st.wy + st.wz * st.wz);
      _o.u = this._lu(f, ob.x, ob.z); _o.v = this._lv(f, ob.x, ob.z); _o.side = o.side;
      rallyIntent(it, P, f, h, _o, warm);
      xc.serve = false; xc.first = false; xc.warm = warm; xc.how = pl.how; xc.stretch = pl.stretch; xc.low = pl.low;
      xc.lift = pl.lift; xc.inSpeed = Math.sqrt(st.vx * st.vx + st.vy * st.vy + st.vz * st.vz); xc.load = it.load;
      memberExec(ex, P, xc);
      ex.B = _Bup; ex.outSign = 1;
    }
    // The hitter allows for part of the wind (P.windAllow); the flight will get all of it
    const env = _planEnv, fe = f.env;
    env.surfY = fe.surfY; env.frame = fe.frame; env.fence = fe.fence; env.surface = fe.surface; env.groundAt = fe.groundAt;
    _pw.x = this._wind.x * P.windAllow; _pw.z = this._wind.z * P.windAllow;
    const res = makeShot(p.res, st, it, ex, env);
    if (!Number.isFinite(res.vx + res.vy + res.vz + res.wx + res.wy + res.wz)) {
      // (a degenerate plan: the ball just drops off the strings — the receiver's point)
      res.vx = 0; res.vy = 0.5; res.vz = 0; res.wx = res.wy = res.wz = 0;
      this.stats.badPlans++;
    }
    pl.state = 2;
    pl.label = it.label;
    // stats
    const S = this.stats;
    S.plans++;
    this._framePlans++;
    if (res.green) S.green++; else S.offGreen++;
    if (res.frame) S.frameShots++;
    if (ex.tail) S.tails++;
    S.labels[it.label] = (S.labels[it.label] || 0) + 1;
    const ms = performance.now() - t0;
    S.planMs += ms;
    if (ms > S.planMsMax) S.planMsMax = ms;
  }

  /** The striker's racket meets the ball (m.tHit): the planned shot leaves the strings as a new flight. */
  _contact(m) {
    const t = m.tHit;
    const p = m.players[m.striker];
    m.tHit = INF; m.striker = -1;
    if (!p) return;
    const pl = p.plan;
    if (pl.state === 1) { this._runPlan(m, p); this.stats.forced++; }
    if (pl.state !== 2) return;                   // (no plan: the swing missed it)
    pl.state = 0; p.aim = false;
    const f = m.frame, b = m.ball, res = p.res;
    const st = b.flight.at(t, _st);
    const px = st.x, py = st.y, pz = st.z;
    const kind = pl.kind;
    const t0 = performance.now();
    b.launchFlight(t, px, py, pz, res.vx, res.vy, res.vz, res.wx, res.wy, res.wz, f.env);
    const S = this.stats, ms = performance.now() - t0;
    S.launches++; S.launchMs += ms; if (ms > S.launchMsMax) S.launchMsMax = ms;
    b.bounced = 0;
    m.evi = 0; m.bounces = 0; m.flightKind = 'shot';
    _v1.set(px, py, pz);
    this._pock(_v1, 'hit');
    if (f.wear) this._queueWear(m, p.npc.body.position.x, p.npc.body.position.z, 0.5, 0.03);
    const sh = m.shot, rcv = m.players[1 - p.idx];
    sh.hitter = p.idx; sh.receiver = rcv.idx; sh.missed = false; sh.kind = kind; sh.label = pl.label || '';
    sh.outcome = 'in'; sh.returnable = false; sh.tContact = INF;
    if (kind === 'serve') { m.srv.active = false; this.stats.serves++; }
    else if (kind === 'warmup') this.stats.warm++;
    if (kind !== 'warmup') { m.rallyLen++; this.stats.shots++; }
    rcv.tRecover = INF;
    this._recover(m, p, t);
    this._readFlight(m, p, rcv, t);
  }

  /**
   * A new shot is in the air: the call on its flight (judgeFlight), and the receiver's answer —
   * a contact on the real flight (planContact) they run to and swing at, a chase when it is out
   * of reach (a winner), or a step toward a ball that is going out and a look.
   */
  _readFlight(m, hitter, rcv, t0) {
    const f = m.frame, fl = m.ball.flight, sh = m.shot, S = this.stats;
    const serve = sh.kind === 'serve';
    const J = judgeFlight(m.judge, fl, f, rcv.side, serve ? (m.deuce ? rcv.side : -rcv.side) : 0);
    S.calls[J.call] = (S.calls[J.call] || 0) + 1;
    if (J.long) S.long++;
    if (J.wide) S.wide++;
    if (J.short) S.short++;
    if (J.cord) S.cords++;
    const warmEnd = sh.kind === 'warmup' && t0 >= m.warmEnd;
    if (J.call === 'in' && !warmEnd) {
      const rc = rcv.rc, npc = rcv.npc;
      rc.x = npc.body.position.x; rc.z = npc.body.position.z; rc.gy = npc.mesh.position.y;
      rc.yaw = rcv.yaw; rc.side = rcv.side; rc.fh = rcv.fh; rc.bh = rcv.bh;
      const react = serve ? rcv.prof.react * 0.5 : rcv.prof.react;
      const ct = planContact(rcv.ct, fl, f, rc, t0, react);
      if (ct.ok && ct.reach) {
        sh.returnable = true; sh.tContact = ct.t;
        m.tHit = ct.t; m.striker = rcv.idx;
        m.aimPt.set(ct.x, ct.y, ct.z);
        rcv.clip = ct.clip; rcv.aim = true;
        rcv.lift = 0; rcv.liftT0 = rcv.liftT1 = INF;
        const pl = rcv.plan;
        pl.state = 0; pl.how = ct.how; pl.stretch = ct.stretch; pl.low = ct.low; pl.lift = ct.lift; pl.inSpeed = ct.inSpeed;
        S.how[ct.how]++;
        const split = ct.t - t0 > 1.15 && !serve;
        if (split) rcv.tSplit = t0 + 0.04;
        rcv.tMove = t0 + (split ? Math.max(react, 0.38) : react);
        rcv.mx = ct.sx; rcv.mz = ct.sz;
        const moveTime = Math.max(0.15, ct.t - SWING_T - rcv.tMove - 0.06);
        rcv.mSpeed = clamp(ct.cost / moveTime, 1.2, rcv.prof.speed);
        rcv.swingAt = ct.t - SWING_T;
        rcv.tSwing = rcv.swingAt;
        return;
      }
      if (ct.ok) {
        // Out of reach: a chase at full speed (a lunge at the end when it is close), then it is gone
        S.chases++;
        rcv.tSplit = t0 + 0.04;
        rcv.mx = ct.sx; rcv.mz = ct.sz; rcv.mSpeed = rcv.prof.speed; rcv.tMove = t0 + react;
        rcv.clip = ct.clip; rcv.aim = false;
        rcv.swingAt = ct.t - SWING_T;
        rcv.tSwing = ct.short < MEMBER.GLIDE_MAX + 1 ? rcv.swingAt : INF;
        return;
      }
    }
    // Going out / into the net / a let / the warm-up's last ball: a step toward it, then leave it
    rcv.tSplit = t0 + 0.05;
    const bx = rcv.npc.body.position.x, bz = rcv.npc.body.position.z;
    const b0 = J.b0;
    const tx = b0 ? b0.x : this._wx(f, 0, rcv.side * BASE_V), tz = b0 ? b0.z : this._wz(f, 0, rcv.side * BASE_V);
    rcv.mx = bx + (tx - bx) * 0.25; rcv.mz = bz + (tz - bz) * 0.25; rcv.mSpeed = 2.4;
    rcv.tMove = t0 + 0.45;
  }

  /** One event of the current flight (bounce, net, net cord, fence / end boards, stands, rest): sound, wear, the call. */
  _flightEvent(m, e) {
    const f = m.frame;
    switch (e.type) {
      case 'bounce': {
        m.bounces++;
        m.ball.bounced = m.bounces;
        this._pock(e, 'bounce', f.surface);
        if (f.wear) this._queueWear(m, e.x, e.z, 0.3, 0.035);
        if (m.resolved || m.flightKind !== 'shot') return;
        const sh = m.shot, J = m.judge;
        if (e.k === 0) {
          if (J.call === 'out') {
            sh.outcome = 'out';
            this._resolve(m, sh.receiver, 1.4);
            if (Math.random() < 0.8) this._say(m.players[sh.receiver], sh.kind === 'serve' ? 'Fault!' : 'Out!', 1.2);
          } else if (J.call === 'net') {
            sh.outcome = 'net';
            this._resolve(m, sh.receiver, 1.3);
          } else if (J.call === 'let') {
            sh.outcome = 'let';
            this._resolve(m, -1, 1.3);
            if (Math.random() < 0.7) this._say(m.players[sh.receiver], 'Let!', 1.1);
          }
        } else if (J.call === 'in') {
          sh.outcome = 'winner';
          this._resolve(m, sh.hitter, 1.2);
        }
        return;
      }
      case 'net': {
        this._pock(e, 'bounce', f.surface);
        if (m.resolved || m.flightKind !== 'shot') return;
        m.shot.outcome = 'net';
        this._resolve(m, m.shot.receiver, 1.5);
        return;
      }
      case 'netcord': {
        this._pock(e, 'bounce', f.surface);
        return;
      }
      case 'fence': case 'stands': case 'rest': {
        if (m.resolved || m.flightKind !== 'shot') return;
        this._settle(m);
        return;
      }
      default:
    }
  }

  /** The point ends with the ball dead: an in-ball nobody returned is the hitter's, anything else the receiver's. */
  _settle(m) {
    const sh = m.shot;
    if (m.judge.call === 'in' && m.bounces >= 1) { sh.outcome = 'winner'; this._resolve(m, sh.hitter, 1.2); }
    else if (m.judge.call === 'let') { sh.outcome = 'let'; this._resolve(m, -1, 1.2); }
    else { sh.outcome = m.judge.call === 'net' ? 'net' : 'out'; this._resolve(m, sh.receiver, 1.2); }
  }

  _resolve(m, winner, delay) {
    m.resolved = true;
    m.pointWinner = winner;
    m.tPointOver = m.t + delay;
    m.tHit = INF; m.striker = -1;
    for (const p of m.players) {
      p.tSplit = p.tMove = p.tSwing = INF;
      p.plan.state = 0; p.aim = false;
      if (!p.npc.isBusyClip()) p.npc.stopMove();
    }
  }

  _recover(m, p, t0) {
    const f = m.frame;
    const u = clamp(this._lu(f, p.npc.body.position.x, p.npc.body.position.z) * 0.3, -1.5, 1.5);
    p.rx = this._wx(f, u, p.side * BASE_V); p.rz = this._wz(f, u, p.side * BASE_V);
    p.tRecover = t0 + 0.6;
    p.tSplit = p.tMove = p.tSwing = INF;
  }

  // ───────────────────────────── scoring & chatter ─────────────────────────────

  _awardPoint(m, w, over) {
    const sc = m.score;
    if (w < 0) {
      // A let (a serve off the net cord into the box) or a replay: the same serve again
      const faults = m.shot.outcome === 'let' ? m.faults : 0;
      this._setupPoint(m, false);
      m.faults = faults;
      if (faults) m.callScore = 'second';
      return;
    }
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
      L.npc.showReaction(L.npc.soreLoser ? '😤' : '🤷');
    }

    sc.pts[w]++;
    const a = sc.pts[w], b = sc.pts[1 - w];
    const game = m.noAd ? a >= 4 : (a >= 4 && a - b >= 2);
    let matchWon = false;
    if (game) {
      sc.games[w]++;
      sc.pts[0] = sc.pts[1] = 0;
      sc.server = 1 - sc.server;
      matchWon = sc.games[w] >= m.gamesToWin;
    }
    this._emitPoint(m, w, W, L, game, matchWon);
    if (game) {
      if (matchWon) { m.winner = w; this._startHandshake(m); return; }
      this._say(W, 'Game!', 1.3);
    }
    if (over) { this._endMatch(m); return; }
    this._setupPoint(m, false);
  }

  /** onPointEnd hook: fill the reused info object (after the score update) and call it. */
  _emitPoint(m, w, W, L, gameWon, matchWon) {
    const cb = this.onPointEnd;
    if (typeof cb !== 'function') return;
    const sh = m.shot, info = this._pointInfo;
    let o = sh.outcome === 'in' ? 'winner' : sh.outcome;         // unreturned ball = a winner
    if (sh.kind === 'serve') o = o === 'winner' ? 'ace' : 'double'; // a serve fault here is the second
    info.courtId = m.frame.id;
    info.winner = w;
    info.winnerNpc = W.npc;
    info.loserNpc = L.npc;
    info.outcome = o;
    info.rally = m.rallyLen;
    info.gameWon = !!gameWon;
    info.matchWon = !!matchWon;
    info.games[0] = m.score.games[0];
    info.games[1] = m.score.games[1];
    try { cb(m.frame.id, info); } catch (e) { console.error('MatchSystem.onPointEnd:', e); }
  }

  /** onMatchEvent hook ('start' | 'rain' | 'resume' | 'handshake' | 'finish'). */
  _emitEvent(m, kind) {
    const cb = this.onMatchEvent;
    if (typeof cb !== 'function') return;
    try { cb(m.frame.id, kind, m); } catch (e) { console.error(`MatchSystem.onMatchEvent(${kind}):`, e); }
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
    this._emitEvent(m, 'handshake');
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
        this._say(W, this._matchLine(W.npc, 'win', 'Good match!'), 1.8);
        const sore = !!L.npc.soreLoser;
        L.npc.showReaction(sore ? '😤' : '🤷');
        if (Math.random() < 0.6) this._say(L, this._matchLine(L.npc, 'lose', sore ? 'Hmph. Rematch.' : 'Well played!'), 1.8);
      } else {
        for (const p of m.players) p.npc.showReaction('😊');
        this._say(a, 'A draw!', 1.6);
      }
      m.leaveAt = t + 3.2;
    }
    if (t >= m.leaveAt) this._startWalkOut(m);
  }

  // ───────────────────────────── audio / wear ─────────────────────────────

  _pock(pos, kind, surface) {
    const s = this.sound;
    if (!s || typeof s.playBallHit !== 'function' || !CameraTracker.valid) return;
    const c = CameraTracker.position;
    const d = Math.sqrt((c.x - pos.x) ** 2 + (c.y - pos.y) ** 2 + (c.z - pos.z) ** 2);
    const k = 1 - d / 55;
    if (k <= 0) return;
    s.playBallHit(Math.pow(k, 1.6), kind, surface);
  }

  _queueWear(m, x, z, r, a) {
    if (!m.frame.wear || m.wearN >= 16) return;
    const i = m.wearN++ * 4;
    m.wear[i] = x; m.wear[i + 1] = z; m.wear[i + 2] = r; m.wear[i + 3] = a * (GAME.matchWearScale ?? 1);
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
    for (let i = this.matches.length - 1; i >= 0; i--) {
      if (this.matches[i] && this.matches[i].frame.id === courtId) this._finish(this.matches[i]);
    }
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
    const m = this.getMatch(courtId);
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
