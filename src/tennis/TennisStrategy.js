/**
 * TennisStrategy — Coach Rafa's game plan: strategy pointers by difficulty, layered on the
 * technique tips of TennisCoach, which owns this object, feeds it every hook and decides when it
 * may speak (strategy has its own priority, between the technique tips and the big-point lines,
 * and its own cadence; an urgent technique fix still comes first).
 *
 * Tiers (session.ai.diffKey):
 *  - 'easy'   → basic singles strategy in simple words, one idea at a time: consistency over
 *               power, deep through the middle, cross-court is the safe shot, recover to the
 *               middle, first serve in, serve to the backhand, side to side, the net only on a
 *               short ball, no lines, high and deep when in trouble;
 *  - 'medium' → building points: cross-court until the short ball, then the line; approach down
 *               the line; attack the second serve; return deep middle against a big serve; change
 *               direction off a short ball, not a deep one; slice to change the pace; lob a net
 *               rusher; the percentages on big points; the weaker wing once it shows;
 *  - 'hard', 'tour' or anything else → in depth: serve + 1, inside-out / inside-in, the geometry
 *               of recovery (the centre of his angles), his tendencies (weaker wing, where his
 *               winners come from, what he does stretched, when he comes in, where he serves),
 *               height and spin, surface and wind plans, score strategy, stamina, momentum.
 *    'tour' (or an opponent set through preMatchPlan / setOpponent) also talks about the opponent
 *    in the third person — in a practice match the opponent is Rafa himself ("my backhand").
 *    Lines carry voice tokens ({he}, {his}, {He's}, verb{s} …) resolved by voice() at speak time.
 *
 * What it tracks — rolling windows of Float32Array columns, allocated once (Ring):
 *  - P, your rally shots: shot number in the point, return or not, where you hit from, where it
 *    landed and its depth, direction (cross / line / middle / inside-out / inside-in), wing,
 *    spin, load, result, the incoming ball's depth and direction (changing direction off a deep
 *    vs a short ball), where he stood, whether he attacked it, how the point ended;
 *  - R, his rally shots: wing, direction, landing, spin, shot family, stretch, at the net, your
 *    position against the centre of his reply angles, the ball he was hitting, how it ended;
 *  - S, your serves (side, first / second, T / body / wide, in or fault, won, serve + 1);
 *  - X, his serves (placement, pace, your return: depth, load, result);
 *  - Q, points (rally length, net approaches: from where, which direction, how they ended; his
 *    net points; big points) — plus match aggregates (m) for the summary and the tour review.
 * Topics (TOPICS) rate what the windows show (evidence ≥ 1 = worth saying), escalate when raised
 * again (hint → specific with your numbers → root cause), notice when you follow the advice and
 * mute the technique issue about the same idea. When nothing stands out, a tier lesson that fits
 * the moment (you serve / you return / a rally) may be given instead, less often.
 *
 * Data: the §3 session hooks when present (onBallLanded; onShot dir / side; onPointEnd
 * serveTarget / returnDepth / approach / oppStyle), else what the existing hooks and the live
 * session give: the new flight's planned first bounce (fl.landX / landZ) at every contact, both
 * players' positions, ai.swingClip, ai.plan.stretch, ai.tactics._fam, ai.mode. Every field may be
 * missing: an unknown value is NaN and simply doesn't count.
 *
 * Cadence (TennisCoach._choose): one line per dead ball at most and a quiet point after any line;
 * a strategy line at most every 4 / 3 / 3 points and 24 / 18 / 15 s (easy / medium / hard), a
 * point earlier for a strong pattern that just repeated; ordinary technique fixes and strategy
 * take turns, an urgent execution fault (timing, feet, no swing, double faults…) goes first; big
 * points, 30-all / deuce, serving for the set and ahead on serve get their own line (tier
 * worded); changeovers alternate strategy with the game's stat line, except the urgent ones (the
 * wind at a new end, two or four games lost in a row, tired legs); set breaks carry the plan for
 * the next set. Nothing in drills; nothing with session.opts.tips off.
 *
 * Tour (the session's tour mode calls TennisCoach, which forwards here): preMatchPlan(opponent,
 * spec?) → 2–4 strings; changeover(ev, score) → one string or null (tourChangeover); postMatch({
 * won, stats }) → 2–3 strings; setOpponent(opponent). Set ai.diffKey = 'tour' before startMatch:
 * the opponent and the plan then survive the match's reset (practice matches clear them).
 *
 * Pure: no three.js, no DOM, no storage (the coach persists `habits`). Hooks run on events only
 * (contacts, landings, points), never per frame; strings are built only when a line is chosen.
 */

// ─────────────────────────── court and codes ───────────────────────────

// The court as TennisBallSim draws it (court-local metres; duplicated so this file stays pure).
const HALF_L = 12.3, SINGLES_W = 4.65, SERVICE_L = 6.62;
const MID_U = 1.4;            // landing this close to the centre line: through the middle
const DEEP_IN = 9.0;          // an incoming ball that landed this far from the net (or more) was deep
const SHORT_IN = 7.8;         // … this close (or closer): a short ball
const BASE_D = 11.9;          // hitting from here or further back: behind the baseline
const INSIDE_D = 10.2;        // hitting from closer than this: inside the court
const SHORT_OUT = 7.4;        // your ball landing closer to the net than this sat up for him
const APP_DEEP = 11.3;        // an approach hit from this far back came from the baseline

const D_UNK = 0, D_MID = 1, D_CROSS = 2, D_LINE = 3, D_IO = 4, D_II = 5;
const DIR = { middle: D_MID, cross: D_CROSS, line: D_LINE, 'inside-out': D_IO, 'inside-in': D_II };
const SP = { flat: 0, topspin: 1, slice: 2, lob: 3, drop: 4, smash: 5 };
const R_IN = 0, R_NET = 1, R_LONG = 2, R_WIDE = 3, R_MISS = 4, R_CTR = 5, R_FAULT = 6;
const RES = { in: R_IN, net: R_NET, long: R_LONG, wide: R_WIDE, miss: R_MISS, centre: R_CTR };
const W_FH = 0, W_BH = 1, W_OH = 2;
const T_T = 0, T_BODY = 1, T_WIDE = 2;
const TGT = { T: T_T, t: T_T, body: T_BODY, wide: T_WIDE };
const E_NONE = 0, E_WIN = 1, E_ERR = 2, E_SETUP = 3, E_DREW = 4; // how a shot ended its point
const WHY = { out: 1, net: 2, winner: 3, ace: 4, double: 5 };
const Y_OUT = 1, Y_NET = 2, Y_WIN = 3, Y_ACE = 4, Y_DBL = 5;
// His shot families (TennisTactics names)
const FAM = {
  drive: 1, driveReturn: 1, approach: 2, pass: 3, lob: 4, lobDefend: 4, drop: 5, dropVolley: 5,
  slice: 6, dig: 6, volleyKill: 7, volleyDeep: 7, smash: 8, overhead: 8, blockReturn: 9,
};
const F_APPROACH = 2, F_LOB = 4;
// How a net approach ended
const A_WON = 0, A_PASSED = 1, A_LOBBED = 2, A_VOLLEY = 3, A_OTHER = 4;
// Score moments: big points (TennisScore.pressure) and the other moments that matter
const BIG_NONE = 0, BP_FOR = 1, BP_AG = 2, SP_FOR = 3, SP_AG = 4, MP_FOR = 5, MP_AG = 6;
const SC_NONE = 0, SC_30 = 1, SC_FORSET = 2, SC_STAY = 3, SC_AHEAD = 4;
// Tiers
const TB = 1, TI = 2, TA = 4;
const GAP = [4, 3, 3];         // points between strategy lines (basic / intermediate / advanced)
const GAP_T = [24, 18, 15];    // … and seconds
const LESSON_GAP = [8, 7, 6];  // points between two lessons (the general principles)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ok = (x) => x === x && x !== Infinity && x !== -Infinity; // a known number (not NaN)
const NUMS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const ORDS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** A fixed-size ring of rows with named Float32Array columns (allocated once; new rows are NaN). */
class Ring {
  constructor(n, cols) {
    this.n = n; this.i = 0; this.len = 0; this.total = 0; this.cols = cols;
    for (let c = 0; c < cols.length; c++) this[cols[c]] = new Float32Array(n);
  }

  add() {
    const k = this.i;
    this.i = (k + 1) % this.n;
    if (this.len < this.n) this.len++;
    this.total++;
    for (let c = 0; c < this.cols.length; c++) this[this.cols[c]][k] = NaN;
    return k;
  }

  /** Slot of the j-th newest row (0 = newest; j < len). */
  at(j) { return (this.i - 1 - j + 2 * this.n) % this.n; }

  clear() { this.i = 0; this.len = 0; this.total = 0; }
}

// ─────────────────────────── voice ───────────────────────────

const V_ME = {
  he: 'I', He: 'I', him: 'me', Him: 'Me', his: 'my', His: 'My', "he's": "I'm", "He's": "I'm",
  has: 'have', is: 'am', s: '', es: '', does: 'do', "doesn't": "don't", "isn't": "I'm not",
};
const V_HE = {
  he: 'he', He: 'He', him: 'him', Him: 'Him', his: 'his', His: 'His', "he's": "he's", "He's": "He's",
  has: 'has', is: 'is', s: 's', es: 'es', does: 'does', "doesn't": "doesn't", "isn't": "he isn't",
};
const TOK = /\{([A-Za-z']+)\}/g;

/**
 * The opponent's voice: '{He} serve{s} wide' → 'I serve wide' (a practice match: Rafa is the
 * opponent) or 'He serves wide' (tour: Rafa coaches from the box). {Name} is the opponent's name
 * in the tour ('He' without one). Text without a token is returned as is (no allocation).
 */
export function voice(text, tour, name) {
  if (!text || text.indexOf('{') < 0) return text;
  const V = tour ? V_HE : V_ME;
  return text.replace(TOK, (m, k) => (k === 'Name' ? (tour && name ? name : V.He) : V[k] !== undefined ? V[k] : m));
}

/** 'easy' → 0 (basic), 'medium' → 1 (intermediate), anything else ('hard', 'tour') → 2 (advanced). */
export function tierOf(diffKey) { return diffKey === 'easy' ? 0 : diffKey === 'medium' ? 1 : 2; }

/**
 * Shot direction from where it was hit to where it landed, both lateral as seen by the hitter
 * (m, + = the hitter's right; right-handed players). Inside-out / inside-in are forehands from the
 * backhand side, cross-court / down the line.
 */
export function dirOf(fu, lu, wing) {
  if (!ok(lu)) return D_UNK;
  if (wing === W_FH && fu < -0.7) return lu > MID_U ? D_IO : lu < -MID_U ? D_II : D_MID;
  if (Math.abs(lu) < MID_U) return D_MID;
  if (!ok(fu) || Math.abs(fu) < 0.7) {
    if (wing === W_FH) return lu < 0 ? D_CROSS : D_LINE;   // a right-hander's forehand crosses to his left
    if (wing === W_BH) return lu > 0 ? D_CROSS : D_LINE;
    return D_MID;
  }
  return (lu > 0) === (fu > 0) ? D_LINE : D_CROSS;
}

/**
 * The receiver's best recovery spot (court u) against a hitter at court u `uc`, `vc` from the net,
 * the receiver `depth` from the net: the bisector of the hitter's two extreme replies (the sharp
 * cross-court angle, short, and the deep line) — as TennisTactics.recoveryU.
 */
export function recoveryU(uc, vc, depth) {
  const W = SINGLES_W, cross = SERVICE_L + 1.6, line = HALF_L - 0.3;
  const k = clamp(uc / 3, -1, 1);
  const dA = line + (cross - line) * Math.max(0, k), dB = line + (cross - line) * Math.max(0, -k);
  const reach = depth + vc;
  const uA = uc + (-W - uc) * reach / (dA + vc), uB = uc + (W - uc) * reach / (dB + vc);
  const LA = Math.hypot(uA - uc, reach), LB = Math.hypot(uB - uc, reach);
  return uA + (uB - uA) * LA / (LA + LB);
}

/** Serve target from the landing's court u (the service box spans 0 … SINGLES_W from the centre line). */
function tgtOf(u) {
  const a = Math.abs(u);
  return a < 1.25 ? T_T : a > 3.25 ? T_WIDE : T_BODY;
}

/** 1 = a serve to a right-handed receiver's backhand, 0 = forehand, -1 = at the body. */
function srvToBH(deuce, tgt) {
  if (tgt === T_BODY || !ok(tgt)) return -1;
  return (deuce === 1) === (tgt === T_T) ? 1 : 0;
}

// ─────────────────────────── topics ───────────────────────────
//
// tiers: bit mask (TB basic, TI intermediate, TA advanced). ev(x): evidence (≥ 1: worth saying),
// it may leave numbers in x._n1 / x._n2 / … for the lines. lines[tier][level] = variants:
// [text, bubble] or (x) => [text, bubble] (text ≤ 70 chars, bubble ≤ 20, in both voices).
// src: the window whose new rows are fresh evidence (fresh: how many since last raised); cool:
// points before it may come again (longer each time it is repeated unfixed). when: 'serve' /
// 'return' (only before you serve / receive). fix(x, n): true when the n rows since it was raised
// show you followed it; good[tier]: the lines for that. mute: technique issues about the same idea
// (they wait their turn); own: technique issues that give the same advice (silent while this topic
// is raised and not yet followed).

const TOPICS = [
  // ── direction and depth ──
  {
    id: 'chgDeep', tiers: TI | TA, w: 1.15, src: 'P', fresh: 2, cool: 6,
    ev: (x) => x.evChgDeep(),
    lines: [null, [
      [['Change direction off a short ball, not a deep one.', 'Wait for short!'],
        ['Deep ball? Send it back cross. The line is for short balls.', 'Deep: cross!']],
      [(x) => [`${x.ordTime(x._n3)} off a deep ball. Wait for the short one.`, 'Wait for short!']],
      [['Off a deep ball the line is risky: high net, short court. Cross it.', 'Cross it back!']],
    ], [
      [(x) => (x._setup
        ? ['You changed direction off a deep ball: {he} had the open court.', 'Wait for short!']
        : x._n3 >= 2 && x._n3 <= 4
          ? [`${x.ordChange(x._n3)} off a deep ball. Wait for the short one.`, 'Wait for short!']
          : ['You keep changing direction off deep balls. Wait for the short one.', 'Wait for short!'])],
      [(x) => [`Off deep balls you go line: ${x._n2} of ${x._n1} lost. Deep cross, then line.`, 'Cross, then line!']],
      [['A deep ball has pace and spin: redirecting it is a gamble. Cross it.', 'Cross it back!'],
        ['Line off a deep ball: high net, short court, open court behind you.', 'Cross first!']],
    ]],
    fix: (x, n) => x.fixChgDeep(n),
    good: [null,
      [(x) => (x._lineShort ? ["That's it: deep cross, then the line.", "That's it!"] : ['Patient cross on the deep ones. Bueno.', 'Bueno!'])],
      [(x) => (x._lineShort ? ["That's it — deep cross, then the line on the short one.", "That's it!"] : ['Better: cross on the deep ones, you wait for the short ball.', 'Better!'])]],
  },
  {
    id: 'lineErr', tiers: TB, w: 1.0, src: 'P', fresh: 2, cool: 6,
    ev: (x) => x.evLineErr(),
    lines: [[
      [['Cross-court is the safe shot: low net, long court.', 'Cross-court!'],
        ['Down the line is the hard shot. Keep it cross-court.', 'Cross-court!']],
      [(x) => [`${x.Num(x._n1)} misses down the line. Cross-court has more room.`, 'More room cross!']],
      [['Cross, the net is lower and the court is longer. Easy margin.', 'Easy margin!']],
    ], null, null],
    fix: (x, n) => x.fixLineErr(n),
    good: [[['Bueno, cross-court and deep. Safe tennis.', 'Bueno!']], null, null],
  },
  {
    id: 'deepMid', tiers: TB, w: 1.0, src: 'P', fresh: 3, cool: 6, mute: ['wide'],
    ev: (x) => x.evDeepMid(),
    lines: [[
      [['Aim deep through the middle. Let {him} make the errors.', 'Deep, middle!'],
        ['Big targets, amigo: deep and through the middle.', 'Deep, middle!']],
      [(x) => [`${x.Num(x._n1)} of your last eight missed. Deep middle, a meter inside.`, 'Deep, middle!']],
      [["Don't go for the lines. Margin wins: deep, middle, again.", 'Margin wins!']],
    ], null, null],
    fix: (x, n) => x.fixErrs(n, 6, 1),
    good: [[['Bueno! Deep, middle, in. Now {he} {has} to do something.', 'Bueno!']], null, null],
  },
  {
    id: 'side', tiers: TB | TI, w: 0.85, src: 'P', fresh: 3, cool: 8,
    ev: (x) => x.evSide(),
    lines: [[
      [["You're steady now. Move {him}: one corner, then the other.", 'Side to side!'],
        ['Now move {him} side to side. Make {him} run.', 'Make {him} run!']],
      [['Every ball comes to {him}. Aim for the corners, a meter inside.', 'Corners!']],
    ], [
      [['Every ball comes right to {him}. Make {him} run: corner to corner.', 'Make {him} run!']],
      [(x) => [`${x.Num(x._n1)} of eight went where {he} stood. Move {him} side to side.`, 'Side to side!']],
      [['A player on the run makes errors. Corner, then the other corner.', 'Corner to corner!']],
    ], null],
    fix: (x, n) => x.fixSide(n),
    good: [[['Eso! Side to side. Now {he} {is} running.', 'Eso!']], [["Eso! Now {he's} running. That's how you build it.", 'Eso!']], null],
  },
  {
    id: 'short', tiers: TB | TI | TA, w: 0.9, src: 'P', fresh: 3, cool: 7,
    ev: (x) => x.evShort(),
    lines: [[
      [['Aim deeper. A short ball lets {him} attack.', 'Aim deeper!'],
        ['Hit higher over the net: the ball goes deeper.', 'Higher, deeper!']],
      [(x) => [`${x.Num(x._n1)} balls landed short. Aim past the service line.`, 'Deeper!']],
    ], [
      [['Your ball lands short and {he} step{s} in. Higher over the net: deeper.', 'Deeper!']],
      [(x) => [`${x._n1} of your last 8 landed short. That's {his} attacking ball.`, 'Deeper!']],
      [['Depth comes from height: aim a meter higher over the net.', 'Higher!']],
    ], [
      [(x) => [`${x._n1} of your last 8 landed short. {He} step{s} in and attack{s}.`, 'Deeper!']],
      [['Net clearance is depth: a meter higher, topspin, it lands deep.', 'Higher over!']],
      [['Short balls give {him} time and angles. Depth takes both away.', 'Depth!']],
    ]],
    fix: (x, n) => x.fixShort(n),
    good: [[["Deep now. See? {He} can't attack that.", 'Deep now!']], [["Deep now. See? {He} can't attack that.", 'Deep now!']],
      [['Deep now: {he} {is} hitting from behind the baseline.', 'Deep now!']]],
  },
  {
    id: 'noAttack', tiers: TI | TA, w: 1.0, src: 'P', fresh: 2, cool: 6,
    ev: (x) => x.evNoAttack(),
    lines: [null, [
      [['A short ball is your chance. Down the line, then come in.', 'Attack it!']],
      [(x) => [`${x.Num(x._n1)} short balls and you rallied back cross. Attack them!`, 'Attack!']],
      [['Short ball means time. Step in, line, net: the point is yours.', 'Step in!']],
    ], [
      [['Short ball: take it early down the line, then close the net.', 'Take it early!']],
      [(x) => [`${x.Num(x._n1)} short balls and you rallied back cross. Attack them!`, 'Attack!']],
      [["A short ball is an invitation: early, line, net. Don't rally it.", "Don't rally it!"]],
    ]],
    fix: (x, n) => x.fixNoAttack(n),
    good: [null, [["Yes! Short ball, down the line, in. That's the pattern.", 'Yes!']], [["Yes! Short ball, down the line, in. That's the pattern.", 'Yes!']]],
  },
  {
    id: 'open', tiers: TI | TA, w: 1.0, src: 'P', fresh: 2, cool: 6,
    ev: (x) => x.evOpen(),
    lines: [null, [
      [["When {he's} pulled wide, hit into the open court.", 'Open court!']],
      [(x) => [`${x.times(x._n1)} {he} was wide and you went back to {him}. Other side!`, 'Open court!']],
      [["Wide ball first, then the other side. That's how you finish.", 'Finish it!']],
    ], [
      [['{He} was stretched wide and you went back to {him}. Open court!', 'Open court!']],
      [(x) => [`${x.times(x._n1)} {he} was wide and you went back to {him}. Other side!`, 'Open court!']],
      [['Pull {him} wide, then the open court. Not where {he} stand{s}.', 'Open court!']],
    ]],
    fix: (x, n) => x.fixOpen(n),
    good: [null, [['Eso! Wide, then the open court. {He} had no chance.', 'Eso!']], [['Eso! Wide, then the open court. {He} had no chance.', 'Eso!']]],
  },
  {
    id: 'sameSide', tiers: TI | TA, w: 0.75, src: 'P', fresh: 4, cool: 10,
    ev: (x) => x.evSameSide(),
    lines: [null, [
      [(x) => (x._w === W_FH
        ? ['You feed {his} forehand. Try the backhand side.', 'Backhand side!']
        : ['All to {his} backhand? Surprise {him}: the forehand, then back.', 'Surprise {him}!'])],
      [(x) => [`${x.Num(x._n1)} of ten to {his} ${x.wing(x._w)}. Make {him} move.`, 'Mix it up!']],
    ], [
      [(x) => (x._w === W_FH
        ? ['Everything goes to {his} forehand. Open {him} up: backhand side.', 'Backhand side!']
        : ['Always the backhand: {he} {is} set for it. Wrong-foot {him} once.', 'Wrong-foot {him}!'])],
      [(x) => [`${x.Num(x._n1)} of ten to {his} ${x.wing(x._w)}. {He} know{s} where it goes.`, 'Mix it up!']],
    ]],
    fix: (x, n) => x.fixSameSide(n),
    good: [null, [['Better: now {he} {has} to hit both sides.', 'Better!']], [['Better: now {he} {has} to hit both sides.', 'Better!']]],
  },
  {
    id: 'io', tiers: TA, w: 0.8, src: 'P', fresh: 3, cool: 8,
    ev: (x) => x.evInsideOut(),
    lines: [null, null, [
      [['Run around the backhand: inside-out forehand to {his} backhand.', 'Inside-out!']],
      [(x) => [`${x.Num(x._n1)} backhands from the corner, ${x.num(x._n2)} lost. Step around it.`, 'Step around!']],
      [['Your forehand is the weapon. Take the backhand corner with it.', 'Forehand!']],
    ]],
    fix: (x, n) => x.fixInsideOut(n),
    good: [null, null, [["Inside-out forehand! That's the play.", 'Inside-out!']]],
  },
  {
    id: 'ii', tiers: TA, w: 0.7, src: 'P', fresh: 2, cool: 8,
    ev: (x) => x.evInsideIn(),
    lines: [null, null, [
      [['Inside-in is risky. Inside-out first, the line only when {he} lean{s}.', 'Inside-out first!']],
      [(x) => [`${x.Num(x._n2)} inside-in forehands missed. It goes over the high net.`, 'Inside-out first!']],
      [['Inside-in is over the high net to a short court. Earn it first.', 'Earn it!']],
    ]],
  },
  {
    id: 'trouble', tiers: TB | TI | TA, w: 0.85, src: 'P', fresh: 3, cool: 8,
    ev: (x) => x.evTrouble(),
    lines: [[
      [['In trouble? Hit it high and deep. Buy time.', 'High and deep!']],
      [(x) => [`${x.Num(x._n1)} points lost going for it from out wide. High and deep instead.`, 'High and deep!']],
    ], [
      [["Stretched? Don't go for the winner. High and deep, or slice, 3.", 'Buy time!']],
      [(x) => [`${x.Num(x._n1)} points lost forcing it from out wide. Neutralise first.`, 'Neutralise!']],
    ], [
      [['Out wide and late: neutralise. Height to the middle, then recover.', 'Neutralise!']],
      [(x) => [`${x.Num(x._n1)} points lost forcing it on the stretch. Defend, then attack.`, 'Defend first!']],
    ]],
    fix: (x, n) => x.fixTrouble(n),
    good: [[['Bueno: high and deep, and you were back in the point.', 'Bueno!']], [['Good defence: you bought time and got back in.', 'Good defence!']],
      [['Good defence: neutral ball, back in the point.', 'Good defence!']]],
  },
  {
    id: 'oppShade', tiers: TA, w: 0.7, src: 'P', fresh: 4, cool: 12,
    ev: (x) => x.evOppShade(),
    lines: [null, null, [
      [['{He} cheat{s} to your cross-court. Off a short ball, the line is open.', 'Line is open!']],
      [['Watch where {he} stand{s}: covering cross. On the short ball, go line.', 'Watch {him}!']],
    ]],
  },
  // ── serve ──
  {
    id: 'serveMix', tiers: TI | TA, w: 0.9, src: 'S', fresh: 3, cool: 8, when: 'serve',
    ev: (x) => x.evServeMix(),
    lines: [null, [
      [(x) => [`Your first serves all go ${x.tgtTo(x._tgt)}. Mix in ${x.tgtOther(x._tgt)}.`, 'Mix it up!']],
      [['If {he} know{s} where the serve goes, {he} {is} waiting there. Mix it.', 'Mix it!']],
    ], [
      [(x) => [`{He} read{s} your ${x.tgtWord(x._tgt)} serve now. Go ${x.tgtAlt(x._tgt)}, then the open court.`, 'Mix it up!']],
      [(x) => [`${x.Num(x._n1)} of six first serves ${x.tgtTo(x._tgt)}. {He} {is} waiting there.`, 'Mix it up!']],
      [["A serve {he} can't read is worth ten km/h. Mix T, body, wide.", 'Mix T, body, wide!']],
    ]],
    fix: (x, n) => x.fixServeMix(n),
    good: [null, [["Better. Now {he} can't read your serve.", 'Better!']], [["Better. Now {he} can't read your serve.", 'Better!']]],
  },
  {
    id: 'serveBH', tiers: TB | TI, w: 0.9, src: 'S', fresh: 3, cool: 8, when: 'serve',
    ev: (x) => x.evServeBH(),
    lines: [[
      [(x) => (x.cur.deuce
        ? ['Serve to {his} backhand: from the right, down the T.', 'To {his} backhand!']
        : ['From the left, serve wide: {his} backhand is there.', 'Wide, {his} backhand!'])],
      [(x) => [`${x.Num(x._n1)} serves to {his} forehand. Aim for the backhand side.`, 'Backhand side!']],
    ], [
      [['Your serves find {his} forehand. Deuce side T, ad side wide.', 'To {his} backhand!']],
      [(x) => [`${x.Num(x._n1)} serves to {his} forehand. Deuce side T, ad side wide.`, 'Backhand side!']],
    ], null],
    fix: (x, n) => x.fixServeBH(n),
    good: [[["To {his} backhand. {He} {doesn't} like that one!", 'Eso!']], [["To {his} backhand. {He} {doesn't} like that one!", 'Eso!']], null],
  },
  {
    id: 'firstIn', tiers: TB | TI | TA, w: 1.0, src: 'S', fresh: 3, cool: 8, when: 'serve', mute: ['firstpct'],
    ev: (x) => x.evFirstIn(),
    lines: [[
      [['Get the first serve in. A little less pace, a big target.', 'First serve in!']],
      [(x) => [`First serves in: ${x._pct}%. Take pace off, get it in.`, 'Get it in!']],
      [['A first serve in puts the pressure on {him}. It is half the point.', 'Get it in!']],
    ], [
      [(x) => [`First serves in: ${x._pct}%. A 3/4 serve in beats a big one out.`, 'First serve in!']],
      [['Too many second serves: {he} attack{s} those. First serve in, then play.', 'First serve in!']],
    ], [
      [(x) => [`${x._pct}% first serves: {he} feast{s} on your seconds. Spot over speed.`, 'Spot over speed!']],
      [['Serve at 80 percent pace to a spot. The spot hurts more than speed.', 'Spot over speed!']],
    ]],
    fix: (x, n) => x.fixFirstIn(n),
    good: [[['First serves going in. Now you serve with the lead.', 'Bueno!']], [['First serves going in. Now you serve with the lead.', 'Bueno!']],
      [['First serves going in. Now you serve with the lead.', 'Bueno!']]],
  },
  {
    id: 'plus1', tiers: TA, w: 1.0, src: 'S', fresh: 2, cool: 8, when: 'serve',
    ev: (x) => x.evPlus1(),
    lines: [null, null, [
      [['Serve plus one: after the serve, your first ball to the open court.', 'Open court!']],
      [(x) => [`${x.times(x._n1)} your next ball went back to {him}. Open court!`, 'Open court!']],
      [['Plan two shots: serve wide, then the next ball to the other side.', 'Plan two shots!']],
    ]],
    fix: (x, n) => x.fixPlus1(n),
    good: [null, null, [['Serve, then the open court. Textbook.', 'Textbook!']]],
  },
  // ── return ──
  {
    id: 'att2', tiers: TI | TA, w: 1.0, src: 'X', fresh: 2, cool: 8, when: 'return',
    ev: (x) => x.evAttack2(),
    lines: [null, [
      [['Second serve: step in and attack it. To {his} backhand.', 'Attack it!']],
      [(x) => [`${x.Num(x._n1)} soft returns on {his} second serve. Punish it!`, 'Punish it!']],
    ], [
      [['{His} second serve is soft: step in, drive it to {his} backhand.', 'Step in!']],
      [(x) => [`${x.Num(x._n1)} soft returns on {his} second serve. Punish it!`, 'Punish it!']],
      [['On a second serve the server is scared. You take the first strike.', 'First strike!']],
    ]],
    fix: (x, n) => x.fixAttack2(n),
    good: [null, [['Yes! Attack the second serve. Now {he} feel{s} it.', 'Yes!']], [['Yes! Attack the second serve. Now {he} feel{s} it.', 'Yes!']]],
  },
  {
    id: 'retDeep', tiers: TB | TI | TA, w: 0.9, src: 'X', fresh: 3, cool: 8, when: 'return',
    ev: (x) => x.evRetDeep(),
    lines: [[
      [['Return deep through the middle. Just get it back.', 'Deep, middle!']],
      [(x) => [`${x.Num(x._n1)} returns short or out. Deep middle, nothing more.`, 'Deep, middle!']],
    ], [
      [['Big serve? Block it back deep, through the middle.', 'Block it deep!']],
      [(x) => [`${x.Num(x._n1)} returns short or out. Deep middle, nothing more.`, 'Deep, middle!']],
    ], [
      [['Against the big serve: short backswing, deep middle. No angles.', 'Deep middle!']],
      [(x) => [`${x.Num(x._n1)} returns short or out. Deep middle, then build.`, 'Deep middle!']],
      [['A deep return takes the serve away. Then the rally is yours.', 'Deep return!']],
    ]],
    fix: (x, n) => x.fixRetDeep(n),
    good: [[['Good returns. Deep middle, and the serve is gone.', 'Good returns!']], [['Good returns. Deep middle, and the serve is gone.', 'Good returns!']],
      [['Good returns. Deep middle, and the serve is gone.', 'Good returns!']]],
  },
  // ── the net ──
  {
    id: 'appDeep', tiers: TB | TI, w: 1.0, src: 'Q', fresh: 2, cool: 8, mute: ['passed'], own: ['passed'],
    ev: (x) => x.evAppDeep(),
    lines: [[
      [['Come to the net only on a short ball.', 'Short ball only!']],
      [(x) => [`${x.times(x._n1)} in from the baseline, ${x.num(x._n2)} lost. Wait for a short one.`, 'Short ball only!']],
    ], [
      [['From the baseline the net is too far. Approach off a short ball.', 'Short ball first!']],
      [(x) => [`${x.times(x._n1)} in from the baseline, ${x.num(x._n2)} lost. Wait for a short one.`, 'Short ball first!']],
    ], null],
    fix: (x, n) => x.fixAppDeep(n),
    good: [[["Short ball, then in. That's when you come.", "That's it!"]], [["Short ball, then in. That's when you come.", "That's it!"]], null],
  },
  {
    id: 'appCross', tiers: TI | TA, w: 1.1, src: 'Q', fresh: 2, cool: 8, mute: ['passed'], own: ['passed'],
    ev: (x) => x.evAppCross(),
    lines: [null, [
      [['Approach down the line, then close in. Cross opens the pass.', 'Down the line!']],
      [['Cross-court approach, passed down the line. Approach down the line!', 'Down the line!']],
      [['Down the line, the ball stays in front of you: you cover the pass.', 'Cover the pass!']],
    ], [
      [['Cross-court approach, and {he} passed you down the line. Go line.', 'Approach line!']],
      [(x) => [`${x.Num(x._n1)} cross-court approaches, ${x.num(x._n2)} passed. Approach down the line.`, 'Approach line!']],
      [['Approach line, then close to the middle of {his} passing angles.', 'Close the angle!']],
    ]],
    fix: (x, n) => x.fixAppCross(n),
    good: [null, [["That's it: down the line, close in. Now {he} {has} no angle.", "That's it!"]],
      [["That's it: down the line, close in. Now {he} {has} no angle.", "That's it!"]]],
  },
  {
    id: 'lob', tiers: TI | TA, w: 0.9, src: 'Q', fresh: 2, cool: 8, mute: ['rafanet'], own: ['rafanet'],
    ev: (x) => x.evLobRusher(),
    lines: [null, [
      [['When {he} crowd{s} the net, lob {him}, 4.', 'Lob {him}, 4!']],
      [(x) => [`{He} won ${x._n1} of ${x._n2} at the net. The lob, 4, keeps {him} honest.`, 'Lob, 4!']],
    ], [
      [['{He} close{s} the net tight. Lob over {his} backhand shoulder.', 'Lob, 4!']],
      [(x) => [`{He} won ${x._n1} of ${x._n2} at the net. The lob, 4, keeps {him} honest.`, 'Lob, 4!']],
      [["Lob once, and {he} can't crowd the net. Then pass {him} low.", 'Lob, then pass!']],
    ]],
    fix: (x, n) => x.fixLobRusher(n),
    good: [null, [["Over the top! Now {he} can't crowd the net.", 'Over the top!']], [["Over the top! Now {he} can't crowd the net.", 'Over the top!']]],
  },
  {
    id: 'netShy', tiers: TI | TA, w: 0.8, src: 'P', fresh: 4, cool: 12,
    ev: (x) => x.evNetShy(),
    lines: [null, [
      [['On grass, come forward: short ball, approach, volley.', 'Come forward!']],
    ], [
      [(x) => (x.surf() === 'grass'
        ? ['On grass, come forward: short ball, approach, volley.', 'Come forward!']
        : ['Short balls, and you stay back. Take one early and close the net.', 'Close the net!'])],
      [['At the net the point is short and you choose the angle. Come in.', 'Come in!']],
    ]],
    fix: (x) => x.m.app > 0,
    good: [null, [['Now you come forward. {He} {has} to pass you.', 'Vamos!']], [['Now you come forward. {He} {has} to pass you.', 'Vamos!']]],
  },
  // ── position ──
  {
    id: 'recover', tiers: TB | TI, w: 0.8, src: 'R', fresh: 3, cool: 8, mute: ['recover'], own: ['recover'],
    ev: (x) => x.evRecover(),
    lines: [[
      [['After each shot, back to the middle. Then {he} {has} no easy winner.', 'Back to the middle!']],
      [['Hit, then two steps back to the middle. Every ball.', 'Recover!']],
    ], [
      [["Recover after every ball. Don't watch your shot: move.", 'Recover!']],
      [(x) => [`${x.Num(x._n1)} winners into the open court. Recover faster.`, 'Recover!']],
    ], null],
    fix: (x, n) => x.fixRecover(n),
    good: [[["Better: you're back in the middle. No easy winners now.", 'Better!']], [["Better: you're back in the middle. No easy winners now.", 'Better!']], null],
  },
  {
    id: 'bisect', tiers: TA, w: 0.9, src: 'R', fresh: 3, cool: 8,
    ev: (x) => x.evBisect(),
    lines: [null, null, [
      [(x) => (x._mid
        ? ['Wide ball, wide angle: cover {his} cross-court first. Shade a step.', 'Shade a step!']
        : ['Recover to the middle of {his} angles, not the middle of the court.', 'Split the angles!'])],
      [(x) => [`${x.times(x._n1)} out of position when {he} hit. Split {his} angles.`, 'Split the angles!']],
      [['From a corner {he} {has} two lanes: sharp cross, deep line. Split them.', 'Split the angles!']],
    ]],
    fix: (x, n) => x.fixBisect(n),
    good: [null, null, [['Good position. Now {he} need{s} a great shot to beat you.', 'Good position!']]],
  },
  // ── his game ──
  {
    id: 'oppWing', tiers: TI | TA, w: 1.1, src: 'R', fresh: 3, cool: 8,
    ev: (x) => x.evOppWing(),
    lines: [null, [
      [(x) => [`{His} ${x.wing(x._w)} is missing tonight. Play there more.`, `{His} ${x.wing(x._w)}!`]],
      [(x) => [`${x.Num(x._n1)} ${x.wing(x._w)} errors from {him}. Keep going there.`, 'Keep going there!']],
    ], [
      [(x) => [`{He} {has} made ${x.num(x._n1)} ${x.wing(x._w)} errors. Keep feeding it.`, 'Keep feeding it!']],
      [(x) => (x._low
        ? [`${x.Num(x._n1)} ${x.wing(x._w)} errors, and you play {his} ${x.wing(1 - x._w)}. ${x.Wing(x._w)}!`, `${x.Wing(x._w)}!`]
        : [`Make {him} hit ${x.wing(x._w)}s under pressure: high, deep, in the corner.`, 'Under pressure!'])],
      [(x) => [`Make {him} hit ${x.wing(x._w)}s on the run: that's where {he} break{s}.`, 'On the run!']],
    ]],
    fix: (x, n) => x.fixOppWing(n),
    good: [null, [(x) => [`Yes, all to the ${x.wing(x._w)}. {He} {is} feeling it.`, 'Yes!']], [(x) => [`Yes, all to the ${x.wing(x._w)}. {He} {is} feeling it.`, 'Yes!']]],
  },
  {
    id: 'oppWin', tiers: TI | TA, w: 1.0, src: 'R', fresh: 2, cool: 8,
    ev: (x) => x.evOppWinners(),
    lines: [null, [
      [(x) => [`{He's} hurting you with {his} ${x.wing(x._w)}. Play to {his} ${x.wing(1 - x._w)}.`, `{His} ${x.wing(1 - x._w)}!`]],
    ], [
      [(x) => [`{He's} winning with {his} ${x.wing(x._w)}: play to {his} ${x.wing(1 - x._w)}.`, `${x.Wing(1 - x._w)} side!`]],
      [(x) => [`${x.Num(x._n1)} ${x.wing(x._w)} winners from {him}. Stop feeding it.`, 'Stop feeding it!']],
    ]],
    fix: (x, n) => x.fixOppWinners(n),
    good: [null, [(x) => [`Better: now {he} {has} to beat you with the ${x.wing(1 - x._w)}.`, 'Better!']],
      [(x) => [`Better: now {he} {has} to beat you with the ${x.wing(1 - x._w)}.`, 'Better!']]],
  },
  {
    id: 'oppStretch', tiers: TA, w: 0.8, src: 'R', fresh: 2, cool: 10,
    ev: (x) => x.evOppStretch(),
    lines: [null, null, [
      [(x) => (x._lob
        ? ['Stretched, {he} lob{s}. Stay a step back, then the smash.', 'Watch the lob!']
        : ['Stretched, {he} slice{s} it back short. Move in on it.', 'Move in!'])],
      [["When {he's} stretched, the reply is weak. Close in, take it early.", 'Close in!']],
    ]],
  },
  {
    id: 'oppNet', tiers: TA, w: 0.8, src: 'R', fresh: 2, cool: 10,
    ev: (x) => x.evOppNet(),
    lines: [null, null, [
      [['{He} come{s} in on your short balls. Keep it deep, or pass {him} low.', 'Keep it deep!']],
      [['Deep balls keep {him} back, short ones bring {him} in. Your choice.', 'Keep it deep!']],
    ]],
  },
  {
    id: 'oppServe', tiers: TA, w: 0.8, src: 'X', fresh: 3, cool: 10, when: 'return',
    ev: (x) => x.evOppServe(),
    lines: [null, null, [
      [(x) => (x._tgt === T_BODY
        ? [`{He} serve{s} at your body on the ${x.cur.deuce ? 'deuce' : 'ad'} side. Step aside early.`, 'Step aside early!']
        : [`Mira: {he} serve{s} ${x._tgt === T_T ? 'down the T' : 'wide'} on the ${x.cur.deuce ? 'deuce' : 'ad'} side. Shade a step ${x._shade}.`, 'Shade a step!'])],
      [['Stand where {his} favourite serve goes. Make {him} hit the other one.', 'Take it away!']],
    ]],
  },
  {
    id: 'highBH', tiers: TA, w: 0.8, src: 'P', fresh: 4, cool: 12,
    ev: (x) => x.evHighBH(),
    lines: [null, null, [
      [['Heavy topspin, 2, high to {his} backhand. Make {him} reach up.', 'High backhand!']],
      [['Above the shoulder the backhand has no power. Topspin, 2, and high.', 'Up high!']],
    ]],
  },
  {
    id: 'lowSlice', tiers: TA, w: 0.8, src: 'R', fresh: 2, cool: 12,
    ev: (x) => x.evLowSlice(),
    lines: [null, null, [
      [['Your topspin sits up for {him}. Keep it low: slice, 3.', 'Slice, 3!']],
      [['A big hitter hates the low ball. Slice, 3, make {him} lift it.', 'Keep it low!']],
    ]],
  },
  {
    id: 'drop', tiers: TI | TA, w: 0.75, src: 'P', fresh: 3, cool: 10, mute: ['dropdeep'],
    ev: (x) => x.evDrop(),
    lines: [null, [
      [['On clay {he} stay{s} deep. From inside the court: drop shot, 5.', 'Drop shot, 5!']],
    ], [
      [["{He's} camped deep. From inside the court: drop shot, 5.", 'Drop shot, 5!']],
      [['Drop shot, then pass or lob when {he} run{s} in. A two-shot play.', 'Two-shot play!']],
    ]],
    fix: (x) => x.m.drops > 0,
    good: [null, [['A drop! Now {he} {has} to think about it every ball.', 'Eso!']], [['A drop! Now {he} {has} to think about it every ball.', 'Eso!']]],
  },
  // ── conditions, the body, the head ──
  {
    id: 'wind', tiers: TI | TA, w: 0.8, src: 'P', fresh: 3, cool: 10,
    ev: (x) => x.evWind(),
    lines: [null, [
      [(x) => (x._face
        ? ['Into the wind the ball stops short. Hit through it, aim deeper.', 'Hit through it!']
        : ['Wind at your back: the ball flies. More topspin, aim shorter.', 'More topspin!'])],
    ], [
      [(x) => (x._face
        ? ['Into the wind: flatter, more pace, aim deep. It will stop.', 'Hit through it!']
        : ["Wind behind you: add spin and margin. And lob, it's your end.", 'Spin and margin!'])],
    ]],
  },
  {
    id: 'long', tiers: TB | TI | TA, w: 0.8, src: 'Q', fresh: 3, cool: 10,
    ev: (x) => x.evLong(),
    lines: [[
      [['Long rallies: stay patient. Deep, middle, wait for {his} error.', 'Patience!']],
    ], [
      [['In long rallies you force it. Wait for the short ball.', 'Wait for it!']],
      [(x) => [`Rallies of 7 or more: you won ${x._n2} of ${x._n1}. Patience, then attack.`, 'Patience!']],
    ], [
      [(x) => (x._win
        ? ['You win the long rallies. Make every point long: height, depth.', 'Make it long!']
        : ["Long rallies go to {him}. Take the first short ball, don't wait.", 'First short ball!'])],
      [(x) => [`Rallies of 7 or more: you won ${x._n2} of ${x._n1}. ${x._win ? 'Keep them long.' : 'Strike earlier.'}`, x._win ? 'Keep them long!' : 'Strike earlier!']],
    ]],
  },
  {
    id: 'strike', tiers: TA, w: 0.8, src: 'Q', fresh: 3, cool: 10,
    ev: (x) => x.evFirstStrike(),
    lines: [null, null, [
      [['{He} win{s} the first strike. Get the return deep, then your pattern.', 'Deep return!']],
      [(x) => [`Points of three shots or less: {he} won ${x._n2} of ${x._n1}. Serve and return!`, 'Serve and return!']],
    ]],
  },
  {
    id: 'momentum', tiers: TB | TI | TA, w: 1.0, src: 'Q', fresh: 2, cool: 8, mute: ['rhythm'], own: ['rhythm'],
    ev: (x) => x.evMomentum(),
    lines: [[
      [['Tranquilo. Deep, middle, one point at a time.', 'Tranquilo.']],
      [['Slow it down. High and deep, make {him} play every ball.', 'Slow it down!']],
    ], [
      [['Slow it down: deep cross-court, then build again.', 'Slow it down!']],
      [(x) => (x._n1 >= 2
        ? [`${x.Num(x._n1)} games in a row to {him}. Change the rhythm: slice, 3.`, 'Change the rhythm!']
        : ['{He} {has} the rhythm. Change it: a slice, 3, then a high ball.', 'Change the rhythm!'])],
    ], [
      [(x) => (x._n1 >= 2
        ? [`${x.Num(x._n1)} games gone. Reset: your safest pattern, make {him} play.`, 'Reset!']
        : ['{He} {has} the momentum. Break the rhythm: slower, higher, longer.', 'Break the rhythm!'])],
      [['Momentum turns on one long point. Make {him} play five balls.', 'One long point!']],
    ]],
    fix: (x, n) => x.fixMomentum(n),
    good: [[['There. Tranquilo, and the points come back.', 'Vamos!']], [["That's the reset. Now we play again.", 'Vamos!']], [["That's the reset. Now we play again.", 'Vamos!']]],
  },
  {
    id: 'stamina', tiers: TI | TA, w: 0.9, src: 'none', cool: 10, mute: ['stamina'], own: ['stamina'],
    ev: (x) => x.evStamina(),
    lines: [null, [
      [['Tired legs? Shorter points: first strike, then the open court.', 'Shorter points!']],
    ], [
      [['Legs are heavy: shorten the points. Serve and first strike.', 'Shorten points!']],
      [['Tired? Higher over the net, walk slowly, breathe between points.', 'Breathe!']],
    ]],
  },
];

// ─────────────────────────── lessons ───────────────────────────
// The tier's principles, for when nothing in your play stands out: the one that fits the moment
// (ctx: you serve / you return / a rally point / any). rel(x, second) scales the chance (0 = not
// now). Each at most once per match. tp: the topic that says the same thing — once one of them
// was said, the other doesn't repeat it (the topic then opens with your numbers).

const SURF_LINE = {
  hard: ['Hard court: balanced. Take the ball early, dictate with the forehand.', 'Dictate!'],
  clay: ["Clay: build with height and angles. Drop shot when {he's} deep.", 'Height and angles!'],
  grass: ['Grass: first strike. Low slice, serve and volley, stay low.', 'First strike!'],
};

const LESSONS = [
  // basic
  { tp: 'firstIn', tier: 0, ctx: 'serve', rel: (x) => (x.m.firsts < 4 || x.m.firstIn / x.m.firsts < 0.7 ? 1 : 0.3),
    lines: [['First serve: just get it in. Then play the point.', 'Get it in!'], ['No aces needed. First serve in, then deep and safe.', 'Just get it in!']] },
  { tp: 'serveBH', tier: 0, ctx: 'serve', rel: () => 0.8,
    lines: [(x) => (x.cur.deuce ? ['Serve to {his} backhand: from the right, down the T.', 'To {his} backhand!'] : ['From the left, serve wide: {his} backhand is there.', 'Wide, {his} backhand!'])] },
  { tp: 'retDeep', tier: 0, ctx: 'return', rel: () => 1,
    lines: [['Return deep through the middle. No risk on the return.', 'Deep, middle!'], ['Just get the return back, deep. Make {him} play.', 'Just get it back!']] },
  { tp: 'deepMid', tier: 0, ctx: 'rally', rel: () => 1, lines: [['Aim deep through the middle. Big margin, few errors.', 'Deep, middle!']] },
  { tp: 'lineErr', tier: 0, ctx: 'rally', rel: () => 0.9, lines: [['Cross-court is the safe shot: low net, long court.', 'Cross-court!']] },
  { tp: 'recover', tier: 0, ctx: 'rally', rel: (x) => (x.assist() ? 0.25 : 1), lines: [['After each shot, back to the middle.', 'Back to the middle!']] },
  { tp: 'side', tier: 0, ctx: 'rally', rel: (x) => (x.recentErrs(8) <= 2 ? 1 : 0.2), lines: [['Move {him} side to side. One corner, then the other.', 'Side to side!']] },
  { tp: 'appDeep', tier: 0, ctx: 'rally', rel: (x) => (x.lastApproach() ? 1.2 : 0.5), lines: [['Come to the net only on a short ball.', 'Short ball only!']] },
  { tier: 0, ctx: 'rally', rel: (x) => (x.recentErrs(6) >= 2 ? 1.2 : 0.4), lines: [["Don't go for the lines. A meter inside is plenty.", 'Not the lines!']] },
  { tp: 'trouble', tier: 0, ctx: 'rally', rel: (x) => (x.lastStretched() ? 1.3 : 0.4), lines: [['In trouble? Hit it high and deep. Buy time.', 'High and deep!']] },
  { tier: 0, ctx: 'any', rel: () => 0.7, lines: [['Consistency beats power. One more ball than {him}.', 'One more ball!']] },
  // intermediate
  { tier: 1, ctx: 'rally', rel: () => 1, lines: [['Build the point: cross-court until {he} give{s} you a short one.', 'Build it!']] },
  { tp: 'noAttack', tier: 1, ctx: 'rally', rel: () => 0.9, lines: [['Short ball? Down the line, then close in.', 'Short: line!']] },
  { tp: 'appCross', tier: 1, ctx: 'rally', rel: (x) => (x.lastApproach() ? 1.2 : 0.6), lines: [['Approach down the line, then close the net.', 'Line, then in!']] },
  { tp: 'att2', tier: 1, ctx: 'return', rel: (x, second) => (second ? 1.5 : 0), lines: [['Second serve: step in and attack it.', 'Attack it!']] },
  { tp: 'retDeep', tier: 1, ctx: 'return', rel: (x, second) => (second ? 0 : 1), lines: [['Big first serve: short swing, deep through the middle.', 'Deep middle!']] },
  { tier: 1, ctx: 'rally', rel: (x) => (x.m.slices < 2 ? 1 : 0.3), lines: [['Change the pace with a slice, 3. Break {his} rhythm.', 'Slice, 3!']] },
  { tp: 'lob', tier: 1, ctx: 'rally', rel: (x) => (x.lastOppNet() ? 1.3 : 0), lines: [['When {he} crowd{s} the net, lob {him}, 4.', 'Lob, 4!']] },
  { tp: 'serveBH', tier: 1, ctx: 'serve', rel: () => 1, lines: [['Serve to {his} backhand, then take the next ball early.', 'To the backhand!']] },
  { tp: 'oppWing', tier: 1, ctx: 'rally', rel: (x) => (x.m.pts >= 8 ? 0.8 : 0), lines: [['Find {his} weaker wing, then keep going there.', 'Find the weak wing!']] },
  { tier: 1, ctx: 'rally', rel: () => 0.7, lines: [['Play the percentages: cross-court, deep, then the line.', 'Percentages!']] },
  { tier: 1, ctx: 'rally', rel: () => 0.7, lines: [['Depth first, then angles. A deep ball buys you the next one.', 'Depth first!']] },
  // advanced
  { tp: 'plus1', tier: 2, ctx: 'serve', rel: (x) => (x.cur.deuce ? 1 : 0), lines: [['Deuce side: slice it wide, then the forehand into the open court.', 'Wide, then open!']] },
  { tier: 2, ctx: 'serve', rel: () => 0.8, lines: [['T serve to jam {him}, then attack the middle.', 'T, then attack!']] },
  { tier: 2, ctx: 'serve', rel: (x) => (x.cur.deuce ? 0 : 1), lines: [['Ad side: wide to the backhand, then the inside-out forehand.', 'Wide, inside-out!']] },
  { tp: 'plus1', tier: 2, ctx: 'serve', rel: () => 0.7, lines: [['Serve plus one: plan two shots, not one.', 'Plan two shots!']] },
  { tp: 'retDeep', tier: 2, ctx: 'return', rel: (x, second) => (second ? 0.3 : 1), lines: [['Return deep middle, then build. Take away {his} angles.', 'Deep middle!']] },
  { tp: 'att2', tier: 2, ctx: 'return', rel: (x, second) => (second ? 1.5 : 0), lines: [['Second serve: take it early, to the weaker wing, and move in.', 'Take it early!']] },
  { tp: 'io', tier: 2, ctx: 'rally', rel: () => 0.9, lines: [['Run around the backhand: inside-out forehand to {his} backhand.', 'Inside-out!']] },
  { tp: 'ii', tier: 2, ctx: 'rally', rel: () => 0.6, lines: [['Inside-in only when {he} lean{s} to cover the inside-out.', 'Inside-in!']] },
  { tp: 'bisect', tier: 2, ctx: 'rally', rel: () => 0.9, lines: [['Recover to the middle of {his} angles, not the middle of the court.', 'Split the angles!']] },
  { tier: 2, ctx: 'rally', rel: () => 0.8, lines: [['A wide ball opens {his} angle too: cover the cross-court first.', 'Cover cross first!']] },
  { tp: 'highBH', tier: 2, ctx: 'rally', rel: (x) => (x.surf() === 'clay' ? 1.2 : 0.7), lines: [['Heavy topspin high to the backhand: make {him} hit above the shoulder.', 'High backhand!']] },
  { tp: 'lowSlice', tier: 2, ctx: 'rally', rel: (x) => (x.surf() === 'grass' ? 1.3 : 0.6), lines: [['Low slice to a big hitter: make {him} lift it and make the pace.', 'Low slice!']] },
  { tier: 2, ctx: 'rally', rel: (x) => (x.surf() === 'hard' ? 1 : 0.4), lines: [['Take the ball early, on the rise. Steal {his} time.', 'Take it early!']] },
  { tier: 2, ctx: 'rally', rel: () => 0.8, lines: [(x) => SURF_LINE[x.surf()]] },
  { tier: 2, ctx: 'rally', rel: (x) => (x.windEnd() ? 1.2 : 0),
    lines: [(x) => (x.windEnd() > 0
      ? ['Wind at your back this end: more spin, more margin. Lob now.', 'Spin and margin!']
      : ['Into the wind this end: hit through it, flatter and deeper.', 'Hit through it!'])] },
  { tier: 2, ctx: 'rally', rel: () => 0.7, lines: [['Hit to the open court, then recover to cover {his} best reply.', 'Open, then cover!']] },
  { tier: 2, ctx: 'rally', rel: () => 0.6, lines: [['Approach to {his} weaker wing, down the line, then split step.', 'Approach, split!']] },
];

// ─────────────────────────── the plan, big points, changeovers ───────────────────────────

const OPENING = [
  [['Plan: deep through the middle. Let {him} make the errors.', 'Deep, middle!'],
    ['Plan: first serve in, then keep the ball in play.', 'Keep it in play!'],
    ['Plan: cross-court and deep. Consistency first.', 'Consistency!']],
  [['Plan: cross-court until {he} give{s} you a short ball, then the line.', 'Build the point!'],
    ['Plan: serve to {his} backhand, attack {his} second serve.', 'Your plan!'],
    ['Plan: depth first. Short ball, down the line, come in.', 'Depth first!']],
  [['Plan: serve wide, forehand into the open court. Find {his} weak wing.', 'Serve plus one!'],
    ['Plan: deep middle returns, then {his} weaker wing. No free points.', 'No free points!']],
];
const SURF_PLAN = {
  hard: ['Hard court plan: take it early, dictate with the forehand.', 'Take it early!'],
  clay: ["Clay plan: height and angles, drop shot when {he's} deep.", 'Height and angles!'],
  grass: ['Grass plan: first strike. Low slice, come forward, stay low.', 'First strike!'],
};

// Big points (TennisScore.pressure): per kind, per tier
const BIG = [];
BIG[BP_FOR] = [
  [['Break point! Get the return in, deep. Make {him} play.', 'Break point!'],
    ['Break point! Just a deep return. Let {him} feel the pressure.', 'Break point!']],
  [(x) => (x.cur.second
    ? ['Break point on a second serve: step in and attack it.', 'Attack it!']
    : ['Break point: make {him} play. Deep return, then build.', 'Make {him} play!'])],
  [(x) => (x.cur.second
    ? ['Break point, second serve: step in, drive it to the weaker wing.', 'Step in!']
    : ['Break point: deep middle return, then {his} weaker wing. No gifts.', 'No gifts!'])],
];
BIG[BP_AG] = [
  [['Break point. First serve in, then deep and safe.', 'First serve in!'],
    ['Break point against you. Breathe. First serve in, then rally.', 'Breathe!']],
  [['Break point down: first serve in, to {his} backhand.', 'First serve in!'],
    ['Break point down: your safest serve, then deep cross-court.', 'Safest serve!']],
  [(x) => x.bestServeLine('Break point')],
];
BIG[SP_FOR] = [
  [['Set point! Your safest shots: deep, middle.', 'Safe and deep!']],
  [['Set point: your best pattern. Cross, cross, then the line.', 'Your pattern!'],
    ['Set point: percentages. Make {him} hit one more ball.', 'Percentages!']],
  [['Set point: your pattern, not a new shot. Make {him} play.', 'Your pattern!'],
    ['Set point: high percentage first, then the open court.', 'Your pattern!']],
];
BIG[SP_AG] = [
  [['{His} set point. Just keep the ball in. Make {him} win it.', 'Keep it in!']],
  [['{His} set point: percentages. Deep and cross, no gifts.', 'No gifts!']],
  [['Set point down: make {him} earn it. First ball deep, then build.', 'Make {him} earn it!']],
];
BIG[MP_FOR] = [
  [['Match point! Same as always: deep and in.', 'Deep and in!']],
  [['Match point: your pattern, nothing new. Make {him} play.', 'Your pattern!']],
  [['Match point: high percentage, first strike on your terms.', 'Your terms!']],
];
BIG[MP_AG] = [
  [['{His} match point. One point at a time: just keep it in.', 'Keep it in!']],
  [['Match point down: deep, middle, make {him} hit one more.', 'One more ball!']],
  [['Match point down: no gifts. Deep middle, make {him} finish it.', 'No gifts!']],
];

// Other score moments: per kind, per tier (null: nothing to add), and how often
const SCORE = [];
SCORE[SC_30] = [
  null,
  [(x) => [`${x.cur.scTxt}: big point. High percentage, deep cross-court.`, 'High percentage!']],
  [(x) => (x.cur.server === 0
    ? [`${x.cur.scTxt}: first serve in, big targets. Make {him} play.`, 'Big targets!']
    : [`${x.cur.scTxt}: return deep middle. Make {him} hit one more.`, 'Deep middle!'])],
];
SCORE[SC_FORSET] = [
  [['Serving for the set! First serve in, keep it simple.', 'Keep it simple!']],
  [['Serving for the set: first serves in, play your patterns.', 'Your patterns!']],
  [(x) => x.forSetLine()],
];
SCORE[SC_STAY] = [
  [['{He} serve{s} for the set. Get every return back.', 'Every return!']],
  [['{He} serve{s} for the set. Make {him} play: returns deep.', 'Returns deep!']],
  [['{He} serve{s} for the set: the nerves are {his}. Make {him} play.', 'Make {him} play!']],
];
SCORE[SC_AHEAD] = [
  null,
  null,
  [(x) => [`${x.cur.scTxt}: a free point. Take a calculated risk: the big serve.`, 'Go for it!'],
    (x) => [`${x.cur.scTxt} up: now you can go for more. The big first serve.`, 'Go for more!']],
];
const SCORE_P = [[0, 0, 0.6, 0.5, 0], [0, 0.35, 0.7, 0.6, 0], [0, 0.5, 0.8, 0.7, 0.5]];
const SCORE_GAP = [0, 2, 1, 1, 4];   // games between two lines of the same kind

const WIND_CO = [null,
  [['New end, wind at your back: more topspin, aim shorter.', 'Wind behind you!'], ['New end, into the wind: hit through it, aim deeper.', 'Into the wind!']],
  [['This end the wind is behind you: spin, margin, and lob more.', 'Wind behind you!'], ['This end you face the wind: flatter, deeper, no lobs.', 'Into the wind!']],
];
const UP_CO = [['Up a break: same patterns. Hold serve, stay aggressive.', 'Same patterns!'],
  ['Ahead now. No gifts on your serve: first serves in.', 'No gifts!'],
  ['You lead. The pressure is on {him}: make {him} play.', 'Keep the pressure!']];
const DOWN_CO = [['Down a break: hold first. The chances come on {his} serve.', 'Hold first!'],
  ['Behind, but one break back is enough. Make {him} play.', 'One break!'],
  ['Down a break: deep returns, long points. Make {him} earn it.', 'Make {him} earn it!']];
const NEXT_SERVE = [['Your serve next: first serve in, then your pattern.', 'Your serve!'],
  ['Service game: wide, then the open court. Hold it.', 'Hold it!']];
const NEXT_RETURN = [['{His} serve next: deep returns, make {him} play every point.', 'Deep returns!'],
  ['Return game: step in on the second serve. The chances come.', 'Step in!']];
const STAMINA_CO = [null,
  ['Changeover: breathe, drink. Short points next game.', 'Breathe!'],
  ['Changeover: breathe, legs first. Next game, serve and first strike.', 'Breathe!'],
];

// Tour: the opponent's style → the plan (two lines each); unknown styles use allCourt
const STYLE_PLAN = {
  baseliner: [['{Name} is a baseliner. Break {his} rhythm: slice, then bring {him} in.', 'Break the rhythm!'],
    ['Come to the net off the short ball: a baseliner hates a target.', 'Come in!']],
  counterpuncher: [['{Name} gets it all back. Be patient, build, then the short ball.', 'Be patient!'],
    ["Don't go for too much early. {He} feed{s} on your errors.", 'No early risks!']],
  bigServer: [['{Name} serves big. Block returns deep middle, win the rallies.', 'Block it deep!'],
    ['Hold your serve and wait: one break is the set.', 'Hold and wait!']],
  serveVolleyer: [['{Name} comes in behind the serve. Low returns at {his} feet.', 'At {his} feet!'],
    ['Make {him} volley low: dipping returns, then pass or lob.', 'Make {him} volley!']],
  moonballer: [['{Name} loops it high. Step in, take it early or in the air.', 'Take it early!'],
    ["Don't let the high ball push you back. Move in, take the time away.", 'Move in!']],
  allCourt: [['{Name} can do it all. Stick to your patterns, make {him} choose.', 'Your patterns!'],
    ['Find {his} weaker wing early, then keep going there.', 'Find the weakness!']],
  bigHitter: [['{Name} hits big. Low slices and depth take {his} pace away.', 'Low and deep!'],
    ['Move {him}: a big hitter on the run is just a hitter.', 'Move {him}!']],
};
const STYLE_WEIGHT = {   // opponent-aware emphasis (tour)
  baseliner: { side: 1.2, noAttack: 1.3, appCross: 1.2, netShy: 1.3 },
  counterpuncher: { long: 1.3, noAttack: 1.2, deepMid: 1.2, short: 1.2 },
  bigServer: { retDeep: 1.4, att2: 1.3, strike: 1.3, firstIn: 1.2 },
  serveVolleyer: { lob: 1.4, retDeep: 1.3, oppNet: 1.4 },
  moonballer: { noAttack: 1.3, short: 1.2 },
  allCourt: { oppWing: 1.2, oppWin: 1.2 },
  bigHitter: { lowSlice: 1.4, side: 1.2, open: 1.2 },
};

const WON_OPEN = [['Well played. You stuck to the plan.', 'Well played!'], ['Bueno! You won it with your head, not only your arm.', 'Bueno!']];
const LOST_OPEN = [['Tough one. We learn from it: two things.', 'We learn.'], ['Not tonight. But I saw what decides it.', 'Next time.']];

export class TennisStrategy {
  /** @param {import('./TennisCoach.js').TennisCoach} coach */
  constructor(coach) {
    this.c = coach;
    this.P = new Ring(24, ['pt', 'k', 'ret', 'fu', 'fd', 'lu', 'ld', 'dir', 'dg', 'wing', 'vol', 'spin', 'pow', 'aim', 'aimD',
      'res', 'inD', 'inDir', 'ou', 'od', 'ohu', 'owide', 'end', 'app', 'pun', 'str']);
    this.R = new Ring(24, ['pt', 'k', 'ret', 'fu', 'fd', 'lcu', 'lu', 'ld', 'dir', 'wing', 'spin', 'fam', 'str', 'net',
      'pcu', 'pd', 'icu', 'end', 'prevLd', 'prevSpin']);
    this.S = new Ring(16, ['pt', 'deuce', 'second', 'spin', 'tgt', 'res', 'won', 'p1']);
    this.X = new Ring(16, ['pt', 'deuce', 'second', 'tgt', 'res', 'pace', 'retD', 'retPow', 'retRes', 'won']);
    this.Q = new Ring(32, ['won', 'why', 'hitter', 'rally', 'server', 'second', 'app', 'appDir', 'appFrom', 'lost', 'passDir',
      'rnet', 'plob', 'big']);
    this.tp = TOPICS.map(def => ({ def, level: 0, raised: false, at: 0, lastPt: -99, times: 0, rep: 0, good: 0, told: false }));
    this.byId = {};
    for (const st of this.tp) this.byId[st.def.id] = st;
    this.scoreSaid = new Int16Array(5);
    this.le = LESSONS.map(def => ({ def, lastPt: -99, n: 0 }));
    this.m = { tgt: new Float32Array(3), tgtPts: new Float32Array(3), tgtWon: new Float32Array(3), rErrW: new Float32Array(3), rWinW: new Float32Array(3) };
    this.cur = { shots: 0, server: 0, second: false, deuce: true, big: 0, sc: 0, scTxt: '', srvRow: -1, xRow: -1 };
    this._cnt = new Float32Array(3);
    this._co = { text: '', short: '', urgent: false };
    this._coK = ['', ''];     // the kinds of the last two strategy changeover lines
    this.opp = null;          // tour: the opponent ({ name, short, style, rating, … })
    this.oppStyle = '';
    this.hasBL = false;       // the session sends onBallLanded: trust it over the flight's plan
    this._planGiven = false;  // tour: preMatchPlan was given for the coming match (no opening line then)
    this.reset('none', null);
  }

  // ─────────────────────────── state ───────────────────────────

  /** A match or drill starts (TennisCoach.reset). */
  reset(mode, detail) {
    this.P.clear(); this.R.clear(); this.S.clear(); this.X.clear(); this.Q.clear();
    for (const st of this.tp) { st.level = 0; st.raised = false; st.at = 0; st.lastPt = -99; st.times = 0; st.rep = 0; st.good = 0; st.told = false; }
    for (const ls of this.le) { ls.lastPt = -99; ls.n = 0; }
    const m = this.m;
    m.pts = 0; m.won = 0; m.shots = 0;
    m.chgDeep = 0; m.chgDeepBad = 0; m.chgShort = 0; m.chgShortWon = 0;
    m.lineN = 0; m.lineErr = 0; m.crossN = 0; m.crossErr = 0;
    m.shortRecv = 0; m.shortAtt = 0; m.shortHit = 0; m.deepHit = 0; m.toFH = 0; m.toBH = 0;
    m.drops = 0; m.lobs = 0; m.slices = 0;
    m.firsts = 0; m.firstIn = 0; m.tgt.fill(0); m.tgtPts.fill(0); m.tgtWon.fill(0);
    m.s1 = 0; m.s1Good = 0; m.ret1 = 0; m.ret1Bad = 0; m.ret2 = 0; m.ret2Weak = 0;
    m.app = 0; m.appWon = 0; m.appDeep = 0; m.appDeepLost = 0; m.appCross = 0; m.appCrossLost = 0; m.appLine = 0; m.appLineWon = 0;
    m.passed = 0; m.lobbed = 0; m.rNet = 0; m.rNetWon = 0;
    m.rErrW.fill(0); m.rWinW.fill(0); m.rErr = 0; m.rWin = 0;
    m.longN = 0; m.longWon = 0; m.shortN = 0; m.shortWon = 0; m.bigN = 0; m.bigWon = 0;
    m.lostRow = 0; m.wonRow = 0; m.maxLostRow = 0; m.followed = 0; m.followedId = '';
    const cur = this.cur;
    cur.shots = 0; cur.server = 0; cur.second = false; cur.deuce = true; cur.big = BIG_NONE; cur.sc = SC_NONE; cur.scTxt = '';
    cur.srvRow = -1; cur.xRow = -1;
    this.lastP = -1; this.lastR = -1;
    this.linePt = -99; this.lineT = -Infinity; this.lessonPt = -99; this.goodPt = -99;
    this.lastLine = '';
    this.gameIdx = 0; this.scoreSaidGame = -1; this.endPt = -1;
    this._coK[0] = this._coK[1] = '';
    this.scoreSaid.fill(-99);
    this.hasBL = false;
    this._habDone = false;
    this.mode = mode;
    // A practice match (or a drill) with Rafa across the net: no tour opponent. A tour match
    // (diffKey 'tour') keeps the opponent and the plan given before it started.
    const s = this.c && this.c.s;
    const k = s && s.ai && s.ai.diffKey;
    if (mode !== 'match' || k === 'easy' || k === 'medium' || k === 'hard') { this.opp = null; this.oppStyle = ''; this._planGiven = false; }
  }

  /** Tour: who is across the net (preMatchPlan calls it; the session may call it directly). */
  setOpponent(opp) {
    this.opp = opp && typeof opp === 'object' ? opp : null;
    this.oppStyle = this.opp && typeof this.opp.style === 'string' ? this.opp.style : '';
  }

  tier() { const s = this.c.s; return tierOf(s && s.ai && s.ai.diffKey); }
  isTour() { const s = this.c.s; return !!this.opp || !!(s && s.ai && s.ai.diffKey === 'tour'); }
  oppName() { const o = this.opp; return o ? String(o.short || o.name || '') : ''; }

  /** Strategy may speak: a match, tips on. */
  on() { const s = this.c.s; return !!s && s.mode === 'match' && this.c._tipsOn(); }

  surf() {
    const s = this.c.s;
    const k = (s && (s.surface || (s.frame && s.frame.court && s.frame.court.surface))) || 'hard';
    return k === 'clay' || k === 'grass' ? k : 'hard';
  }

  /** +1 wind at your back at this end, -1 in your face, 0 calm or across. */
  windEnd() {
    const s = this.c.s, w = s && s.wind, f = s && s.frame;
    if (!w || !f || !s.windKey || s.windKey === 'calm' || !s.sides) return 0;
    const sp = Math.hypot(w.x || 0, w.z || 0);
    if (!(sp > 0.5)) return 0;
    const wv = (w.x || 0) * f.s + (w.z || 0) * f.c;       // along +v
    if (Math.abs(wv) < 0.45 * sp) return 0;
    return wv * -s.sides[0] > 0 ? 1 : -1;                  // you hit toward −sides[0]
  }

  assist() { const o = this.c.s && this.c.s.opts; return !o || o.assist !== false; }

  // ─────────────────────────── hooks (TennisCoach passes them on) ───────────────────────────

  /** Your racket met the ball (a rally shot). */
  onShot(info) {
    const s = this.c.s;
    if (!info || !s || s.mode !== 'match') return;
    const cur = this.cur, P = this.P, i = P.add(), pt = this.c.pts;
    cur.shots++;
    P.pt[i] = pt; P.k[i] = cur.shots;
    P.ret[i] = cur.server === 1 && cur.shots === 2 ? 1 : 0;
    if (P.ret[i] && cur.xRow >= 0 && this.X.pt[cur.xRow] === pt) this.X.res[cur.xRow] = R_IN; // you played his serve
    const side = s.sides ? s.sides[0] : 1;
    if (s.pl) { P.fu[i] = s.pl.u * side; P.fd[i] = s.pl.v * side; }
    const fn = +info.fromNet;
    if (ok(fn)) P.fd[i] = fn;
    this._oppXZ(s);
    if (ok(this._ou)) { P.ou[i] = this._ou * side; P.od[i] = -this._ov * side; }
    let wing = info.side === 'fh' ? W_FH : info.side === 'bh' ? W_BH : -1;
    if (info.smash) wing = W_OH;
    else if (wing < 0) {
      const clip = s.swing && s.swing.clip;
      wing = clip === 'forehand' || clip === 'volley_fh' ? W_FH : clip === 'backhand' || clip === 'volley_bh' ? W_BH : clip === 'smash' ? W_OH : -1;
    }
    P.wing[i] = wing;
    P.vol[i] = info.volley ? 1 : 0;
    const sp = SP[info.spin];
    P.spin[i] = info.smash ? SP.smash : sp !== undefined ? sp : SP.topspin;
    P.pow[i] = +info.power || 0;
    P.aim[i] = +info.aimX; P.aimD[i] = +info.aimDepth;
    P.str[i] = ok(+info.stretch) ? +info.stretch : s.swing && ok(+s.swing.stretch) ? +s.swing.stretch : 0;
    // Where it will land: the new flight's plan (onBallLanded corrects it when the session sends it)
    if (!this.hasBL) {
      this._flightLand(s);
      if (ok(this._lu)) { P.lu[i] = this._lu * side; P.ld[i] = -this._lv * side; }
    }
    const dd = DIR[info.dir];
    P.dg[i] = dd !== undefined ? 1 : 0;
    P.dir[i] = dd !== undefined ? dd : dirOf(P.fu[i], P.lu[i], wing);
    // The ball you hit: his last shot of this point
    const r = this.lastR;
    if (r >= 0 && this.R.pt[r] === pt) {
      const R = this.R;
      P.inD[i] = R.ld[r]; P.inDir[i] = R.dir[r];
      // Where he hit it from (your frame: mirrored), and whether you had pulled him wide
      if (ok(R.fu[r])) { P.ohu[i] = -R.fu[r]; P.owide[i] = R.str[r] > 0.45 || Math.abs(R.fu[r]) > 3.3 ? 1 : 0; }
    }
    P.end[i] = E_NONE; P.app[i] = 0; P.pun[i] = 0;
    if (P.spin[i] === SP.drop) this.m.drops++;
    else if (P.spin[i] === SP.lob) this.m.lobs++;
    else if (P.spin[i] === SP.slice) this.m.slices++;
    this.lastP = i;
  }

  /** Your serve was released (a new serve row; its target comes from the flight / landing). */
  onServe(srv) {
    const s = this.c.s;
    if (!srv || !s || s.mode !== 'match') return;
    const S = this.S, i = S.add();
    S.pt[i] = this.c.pts;
    S.deuce[i] = s.srv && s.srv.deuce ? 1 : 0;
    S.second[i] = srv.second ? 1 : 0;
    const shot = s.ctl ? s.ctl.shot : 0;
    S.spin[i] = shot === 0 ? 0 : shot === 2 || shot === 4 ? 2 : 1;   // flat / kick / slice
    this.cur.srvRow = i;
  }

  /** Where your ball ended ({ kind: 'serve' | 'rally', result }). */
  onLanded(info) {
    const s = this.c.s;
    if (!info || !s || s.mode !== 'match') return;
    const code = RES[info.result] ?? R_MISS, pt = this.c.pts;
    if (info.kind === 'serve') {
      const i = this.cur.srvRow, S = this.S;
      if (i < 0 || S.pt[i] !== pt || S.res[i] >= 0) return;
      S.res[i] = code;
      if (!ok(S.tgt[i]) && code !== R_MISS) { this._flightLand(s); if (ok(this._lu)) S.tgt[i] = tgtOf(this._lu); }
      return;
    }
    const i = this.lastP, P = this.P;
    if (i < 0 || P.pt[i] !== pt) return;
    if (!(P.res[i] >= 0) || code !== R_IN) P.res[i] = code;
    if (!ok(P.lu[i]) && !this.hasBL && code !== R_NET && code !== R_MISS) {
      this._flightLand(s);
      if (ok(this._lu)) {
        const side = s.sides ? s.sides[0] : 1;
        P.lu[i] = this._lu * side; P.ld[i] = -this._lv * side;
        if (!P.dg[i]) P.dir[i] = dirOf(P.fu[i], P.lu[i], P.wing[i]);
      }
    }
  }

  /**
   * §3: every first bounce, both players ({ hitter, u, v, kind, shot, inPlay, fromU, fromV, oppU,
   * oppV }, court-local): the exact landing, and where both players were at the contact.
   */
  onBallLanded(ev) {
    const s = this.c.s;
    if (!ev || !s || s.mode !== 'match') return;
    const u = +ev.u, v = +ev.v;
    if (!ok(u) || !ok(v)) return;
    this.hasBL = true;
    const h = ev.hitter === 1 ? 1 : 0, sides = s.sides || [1, -1], side = sides[h], pt = this.c.pts;
    if (ev.kind === 'serve') {
      if (h === 0) { const i = this.cur.srvRow; if (i >= 0 && this.S.pt[i] === pt) { this.S.tgt[i] = tgtOf(u); if (ev.inPlay === true && !(this.S.res[i] >= 0)) this.S.res[i] = R_IN; } }
      else { const i = this.cur.xRow; if (i >= 0 && this.X.pt[i] === pt) { this.X.tgt[i] = tgtOf(u); if (ev.inPlay === true) this.X.res[i] = R_IN; } }
      return;
    }
    const fu = +ev.fromU, fv = +ev.fromV, ou = +ev.oppU, ov = +ev.oppV;
    if (h === 0) {
      const P = this.P, i = this.lastP;
      if (i < 0 || P.pt[i] !== pt) return;
      P.lu[i] = u * side; P.ld[i] = -v * side;
      if (ok(fu)) P.fu[i] = fu * side;
      if (ok(fv)) P.fd[i] = fv * side;
      if (ok(ou)) P.ou[i] = ou * side;
      if (ok(ov)) P.od[i] = -ov * side;
      if (!P.dg[i]) P.dir[i] = dirOf(P.fu[i], P.lu[i], P.wing[i]);
      if (!(P.res[i] >= 0)) P.res[i] = ev.inPlay === false ? (Math.abs(u) > SINGLES_W ? R_WIDE : R_LONG) : R_IN;
    } else {
      const R = this.R, i = this.lastR;
      if (i < 0 || R.pt[i] !== pt) return;
      R.lcu[i] = u; R.lu[i] = u * side; R.ld[i] = -v * side;
      if (ok(fu)) R.fu[i] = fu * side;
      if (ok(fv)) R.fd[i] = fv * side;
      R.dir[i] = dirOf(R.fu[i], R.lu[i], R.wing[i]);
      // Where you stood as he struck, and the centre of his reply angles
      if (ok(ou)) R.pcu[i] = ou;
      if (ok(ov)) R.pd[i] = ov * sides[0];
      if (ok(fu) && ok(fv) && R.pd[i] > 8) R.icu[i] = recoveryU(fu, fv * side, R.pd[i]);
    }
  }

  /** A new flight left a racket (TennisCoach.update sees it): his shots, and both serves. */
  onFlight(hitter, kind) {
    const s = this.c.s;
    if (!s || s.mode !== 'match') return;
    const cur = this.cur, pt = this.c.pts;
    if (hitter === 0) {
      if (kind !== 'serve') return;                 // your rally shots come through onShot
      cur.shots++;
      const i = cur.srvRow;
      if (i >= 0 && this.S.pt[i] === pt && !this.hasBL) { this._flightLand(s); if (ok(this._lu)) this.S.tgt[i] = tgtOf(this._lu); }
      return;
    }
    cur.shots++;
    // Your last ball was in play: he hit it
    const lp = this.lastP, P = this.P;
    if (lp >= 0 && P.pt[lp] === pt && !(P.res[lp] >= 0)) P.res[lp] = R_IN;
    if (kind === 'serve') { this._hisServe(s, pt); return; }
    if (kind !== 'rally') return;
    const R = this.R, i = R.add(), sides = s.sides || [1, -1], side = sides[1];
    R.pt[i] = pt; R.k[i] = cur.shots; R.ret[i] = cur.server === 0 && cur.shots === 2 ? 1 : 0;
    this._oppXZ(s);
    R.fu[i] = this._ou * side; R.fd[i] = this._ov * side;
    if (!this.hasBL) {
      this._flightLand(s);
      R.lcu[i] = this._lu; R.lu[i] = this._lu * side; R.ld[i] = -this._lv * side;
    }
    const ai = s.ai;
    const clip = ai && ai.swingClip;
    R.wing[i] = clip === 'forehand' || clip === 'volley_fh' ? W_FH : clip === 'backhand' || clip === 'volley_bh' ? W_BH : clip === 'smash' ? W_OH : -1;
    const fsp = s.fl && SP[s.fl.shot];
    R.spin[i] = fsp !== undefined ? fsp : NaN;
    const fam = ai && ai.tactics && ai.tactics._fam;
    R.fam[i] = fam && FAM[fam] ? FAM[fam] : 0;
    R.str[i] = ai && ai.plan ? +ai.plan.stretch || 0 : 0;
    R.net[i] = ai && ai.mode === 'net' ? 1 : 0;
    R.dir[i] = dirOf(R.fu[i], R.lu[i], R.wing[i]);
    // Your position as he struck, and the best one (the centre of his reply angles)
    const pl = s.pl;
    if (pl) {
      R.pcu[i] = pl.u; R.pd[i] = pl.v * sides[0];
      if (ok(this._ov) && R.pd[i] > 8) R.icu[i] = recoveryU(this._ou, this._ov * side, R.pd[i]);
    }
    // The ball he hit: your last one (did he attack it?)
    if (lp >= 0 && P.pt[lp] === pt) {
      R.prevLd[i] = P.ld[lp]; R.prevSpin[i] = P.spin[lp];
      if (R.fam[i] === F_APPROACH || R.net[i]) P.pun[lp] = 1;
    }
    R.end[i] = E_NONE;
    this.lastR = i;
  }

  _hisServe(s, pt) {
    const X = this.X, i = X.add();
    X.pt[i] = pt;
    X.deuce[i] = s.srv && s.srv.deuce ? 1 : 0;
    X.second[i] = s.srv && s.srv.second ? 1 : 0;
    if (!this.hasBL) { this._flightLand(s); if (ok(this._lu)) X.tgt[i] = tgtOf(this._lu); }
    const b = s.ball, v0 = b && b.v0;
    if (v0 && ok(v0.x) && ok(v0.z)) X.pace[i] = Math.hypot(v0.x, v0.z);
    this.cur.xRow = i;
  }

  /** The next point (or the second serve) is set up: who serves, the score moment. */
  between(info) {
    const s = this.c.s;
    if (!info || !s || s.mode !== 'match') return;
    const cur = this.cur, pt = this.c.pts;
    if (info.second) {
      // The first serve was a fault: the same point, served again
      const xi = cur.xRow;
      if (cur.server === 1 && xi >= 0 && this.X.pt[xi] === pt && this.X.second[xi] === 0 && !(this.X.res[xi] >= 0)) this.X.res[xi] = R_FAULT;
      cur.shots = 0; cur.second = true;
      this._scoreState();
      return;
    }
    cur.shots = 0; cur.second = false; cur.srvRow = -1; cur.xRow = -1;
    cur.server = s.srv && s.srv.who === 1 ? 1 : 0;
    cur.deuce = s.srv ? !!s.srv.deuce : true;
    this.lastP = -1; this.lastR = -1;
    this._scoreState();
  }

  /** The point is decided (TennisCoach.onPointEnd, before it counts the point). */
  onPointEnd(info) {
    const s = this.c.s;
    if (!info || !s || s.mode !== 'match') return;
    const pt = this.c.pts, cur = this.cur, m = this.m, P = this.P, R = this.R;
    const won = info.winner === 0, why = WHY[info.why] || 0, hitter = info.hitter === 1 ? 1 : 0;
    const Q = this.Q, q = Q.add();
    const rally = ok(+info.rally) ? +info.rally : cur.shots;
    const server = info.server === 1 || info.server === 0 ? info.server : cur.server;
    Q.won[q] = won ? 1 : 0; Q.why[q] = why; Q.hitter[q] = hitter; Q.rally[q] = rally; Q.server[q] = server;
    Q.second[q] = info.second ? 1 : 0; Q.big[q] = cur.big; Q.rnet[q] = info.rafaNet ? 1 : 0;
    m.pts++; if (won) m.won++;
    if (typeof info.oppStyle === 'string' && info.oppStyle) this.oppStyle = info.oppStyle;
    // Rows of this point (newest first, consecutive in the rings)
    let np = 0; while (np < P.len && P.pt[P.at(np)] === pt) np++;
    let nr = 0; while (nr < R.len && R.pt[R.at(nr)] === pt) nr++;
    const lp = np ? P.at(0) : -1, lr = nr ? R.at(0) : -1;
    const lastShot = rally || cur.shots;
    // Did you come in? The approach shot is your last groundstroke before the first volley
    let app = info.approach === true ? true : info.approach === false ? false : !!info.playerNet;
    let appIdx = -1;
    for (let j = np - 1; j >= 0; j--) {
      const i = P.at(j);
      if (P.vol[i] === 1 || (P.spin[i] === SP.smash && P.fd[i] < 8)) { if (info.approach !== false) app = true; break; }
      if (this._gs(i)) appIdx = i;
    }
    Q.app[q] = app ? 1 : 0;
    if (app) {
      m.app++; if (won) m.appWon++;
      if (appIdx >= 0) { P.app[appIdx] = 1; Q.appDir[q] = P.dir[appIdx]; Q.appFrom[q] = P.fd[appIdx]; }
      let lost = A_WON;
      if (!won) {
        if (hitter === 1 && why === Y_WIN) lost = info.shot === 'lob' || (lr >= 0 && R.spin[lr] === SP.lob) ? A_LOBBED : A_PASSED;
        else if (hitter === 0 && lp >= 0 && P.vol[lp] === 1) lost = A_VOLLEY;
        else lost = A_OTHER;
      }
      Q.lost[q] = lost;
      if (lost === A_PASSED && lr >= 0) Q.passDir[q] = R.dir[lr];
      const ad = Q.appDir[q];
      if (Q.appFrom[q] >= APP_DEEP) { m.appDeep++; if (!won) m.appDeepLost++; }
      if (ad === D_CROSS || ad === D_IO) { m.appCross++; if (lost === A_PASSED) m.appCrossLost++; } else if (ad === D_LINE || ad === D_II) { m.appLine++; if (won) m.appLineWon++; }
      if (lost === A_PASSED) m.passed++; else if (lost === A_LOBBED) m.lobbed++;
    }
    // How the last ball ended it
    if (hitter === 0) {
      if (lp >= 0 && P.k[lp] >= lastShot - 0.5) {
        if (why === Y_WIN) P.end[lp] = E_WIN;
        else if (why === Y_OUT || why === Y_NET) { P.end[lp] = E_ERR; if (!(P.res[lp] > R_IN)) P.res[lp] = why === Y_NET ? R_NET : R_LONG; }
      }
      if ((why === Y_OUT || why === Y_NET) && lr >= 0 && lp >= 0 && R.k[lr] === P.k[lp] - 1) R.end[lr] = E_DREW;
    } else if (lr >= 0 && R.k[lr] >= lastShot - 0.5) {
      const w = R.wing[lr];
      if (why === Y_WIN) {
        R.end[lr] = E_WIN; m.rWin++;
        if (w >= 0 && w < 3 && !app) m.rWinW[w]++;      // a pass against your approach is a net-play matter
        if (lp >= 0 && P.k[lp] === R.k[lr] - 1) P.end[lp] = E_SETUP;
      } else if (why === Y_OUT || why === Y_NET) {
        R.end[lr] = E_ERR; m.rErr++;
        if (w >= 0 && w < 3) m.rErrW[w]++;
        if (lp >= 0 && P.k[lp] === R.k[lr] - 1) P.end[lp] = E_DREW;
      }
    }
    Q.plob[q] = lp >= 0 && P.spin[lp] === SP.lob ? 1 : 0;
    if (info.rafaNet) { m.rNet++; if (!won) m.rNetWon++; }
    // Serve and return
    if (server === 0) {
      const si = cur.srvRow, S = this.S;
      if (si >= 0 && S.pt[si] === pt) {
        S.won[si] = won ? 1 : 0;
        if (typeof info.serveTarget === 'string' && TGT[info.serveTarget] !== undefined) S.tgt[si] = TGT[info.serveTarget];
        if (why !== Y_DBL && !(S.res[si] >= 0)) S.res[si] = R_IN;
        const tg = S.tgt[si];
        if (S.second[si] === 0 && S.res[si] === R_IN && tg >= 0 && tg < 3) { m.tgtPts[tg]++; if (won) m.tgtWon[tg]++; }
        // Serve + 1: your first rally ball of the point (shot 3)
        for (let j = 0; j < np; j++) {
          const i = P.at(j);
          if (P.k[i] !== 3) continue;
          let good = NaN;
          if (this._isErr(P.res[i])) good = 0;
          else if (ok(P.lu[i]) && ok(P.ou[i])) good = (P.lu[i] * P.ou[i] < 0 && Math.abs(P.lu[i]) >= 1.3) || Math.abs(P.lu[i] - P.ou[i]) >= 3.2 ? 1 : 0;
          if (ok(good)) { S.p1[si] = good; m.s1++; if (good) m.s1Good++; }
          break;
        }
      }
    } else {
      const xi = cur.xRow, X = this.X;
      if (xi >= 0 && X.pt[xi] === pt) {
        if (why === Y_DBL) X.res[xi] = R_FAULT;
        else if (!(X.res[xi] >= 0)) X.res[xi] = R_IN;
        X.won[xi] = won ? 1 : 0;
        let ri = -1;
        for (let j = 0; j < np; j++) { const i = P.at(j); if (P.ret[i] === 1) { ri = i; break; } }
        if (ri >= 0) {
          const rd = +info.returnDepth;
          X.retD[xi] = ok(rd) ? rd : P.ld[ri];
          X.retPow[xi] = P.pow[ri];
          X.retRes[xi] = P.res[ri] >= 0 ? P.res[ri] : P.end[ri] === E_ERR ? R_LONG : R_IN;
          if (X.second[xi] === 1) { m.ret2++; if (P.pow[ri] < 0.45 || X.retD[xi] < 7.6) m.ret2Weak++; } else { m.ret1++; if (this._isErr(X.retRes[xi]) || X.retD[xi] < 7.6) m.ret1Bad++; }
        } else if (why === Y_ACE) X.retRes[xi] = R_MISS;
      }
    }
    // Rally length, big points
    if (rally >= 7) { m.longN++; if (won) m.longWon++; } else if (rally <= 3 && why !== Y_DBL) { m.shortN++; if (won) m.shortWon++; }
    if (cur.big) { m.bigN++; if (won) m.bigWon++; }
    // Your shots of this point: the match picture
    for (let j = 0; j < np; j++) {
      const i = P.at(j);
      if (!this._rally(i)) continue;
      m.shots++;
      const d = P.dir[i], e = this._isErr(P.res[i]);
      if (d === D_LINE || d === D_II) { m.lineN++; if (e) m.lineErr++; } else if (d === D_CROSS || d === D_IO) { m.crossN++; if (e) m.crossErr++; }
      if (this._chg(i)) {
        if (this._deep(i)) { m.chgDeep++; if (e || P.end[i] === E_SETUP) m.chgDeepBad++; }
        else if (this._short(i)) { m.chgShort++; if (P.end[i] === E_WIN || P.end[i] === E_DREW) m.chgShortWon++; }
      }
      if (this._short(i)) { m.shortRecv++; if (d === D_LINE || d === D_II || P.app[i] === 1) m.shortAtt++; }
      if (!e && ok(P.ld[i])) { if (P.ld[i] < SHORT_OUT) m.shortHit++; else if (P.ld[i] >= DEEP_IN) m.deepHit++; }
      if (!e && ok(P.lu[i]) && ok(P.ou[i])) { const rel = P.lu[i] - P.ou[i]; if (rel > 0.4) m.toBH++; else if (rel < -0.4) m.toFH++; }
    }
    // Your serves of this point (first-serve percentage, targets)
    const S = this.S;
    for (let j = 0; j < S.len; j++) {
      const i = S.at(j);
      if (S.pt[i] !== pt) break;
      if (S.second[i] === 1 || !(S.res[i] >= 0)) continue;
      m.firsts++; if (S.res[i] === R_IN) m.firstIn++;
      const tg = S.tgt[i];
      if (tg >= 0 && tg < 3) m.tgt[tg]++;
    }
  }

  /** A game (or set) ended: runs of games, the ends. */
  onGame(ev) {
    const s = this.c.s;
    if (!ev || !s || s.mode !== 'match') return;
    this.gameIdx++;
    const m = this.m;
    if (ev.gameWinner === 0) { m.wonRow++; m.lostRow = 0; } else if (ev.gameWinner === 1) { m.lostRow++; m.wonRow = 0; if (m.lostRow > m.maxLostRow) m.maxLostRow = m.lostRow; }
    if (ev.changeEnds && (!s.opts || s.opts.changeEnds !== false)) this.endPt = this.c.pts;
  }

  /**
   * True when a topic of this tier gives the same advice as technique issue `id` and has it in
   * hand: raised and not yet followed, or with the evidence to say it (in a match, tips on).
   */
  owns(id) {
    if (!this.on()) return false;
    const bit = 1 << this.tier();
    for (const st of this.tp) {
      const d = st.def;
      if (!d.own || !(d.tiers & bit) || d.own.indexOf(id) < 0) continue;
      if (st.raised || d.ev(this) >= 1) return true;
    }
    return false;
  }

  /** TennisCoach raised technique issue `id`: strategy topics about the same idea wait their turn. */
  muted(id) {
    for (const st of this.tp) if (st.def.mute && st.def.mute.indexOf(id) >= 0) st.lastPt = this.c.pts;
  }

  // ─────────────────────────── what to say ───────────────────────────

  /** 2: a strategy line may come now; 1: only a pattern that just repeated strongly; 0: not yet. */
  due() {
    if (!this.on() || this.c.pts < 2) return 0;
    const t = this.tier(), dp = this.c.pts - this.linePt, dt = this.c.s.t - this.lineT;
    if (dp >= GAP[t] && dt >= GAP_T[t]) return 2;
    if (dp >= GAP[t] - 1 && dt >= GAP_T[t] * 0.6) return 1;
    return 0;
  }

  /**
   * The strategy line for this dead ball, or null: the strongest topic that fits the moment,
   * else (less often, never early) a lesson of the tier. The caller checked due().
   */
  pick(pServe, second, early) {
    if (!this.on()) return null;
    const t = this.tier(), bit = 1 << t;
    const st = this._topTopic(pServe, early ? 1.4 : 1, bit);
    let L = st ? this._raise(st) : null;
    if (!L && !early) L = this._lesson(pServe, second, t);
    if (!L) return null;
    this.linePt = this.c.pts; this.lineT = this.c.s.t; this.lastLine = L[0];
    return L;
  }

  _topTopic(pServe, minEv, bit) {
    const pts = this.c.pts, sw = this.isTour() ? STYLE_WEIGHT[this.oppStyle] : null;
    let best = null, bestV = 0;
    for (const st of this.tp) {
      const d = st.def;
      if (!(d.tiers & bit)) continue;
      if (pServe !== null && ((d.when === 'serve' && !pServe) || (d.when === 'return' && pServe))) continue;
      if (pts - st.lastPt < d.cool * (1 + 0.5 * st.rep)) continue;
      if (d.src !== 'none' && this._fresh(st) < (d.fresh || 3)) continue;
      const ev = d.ev(this);
      if (!(ev >= minEv)) continue;
      // serve / return topics fit this moment; a topic not said yet gets its turn before a repeat
      const v = Math.min(ev, 3) * d.w * (sw && sw[d.id] ? sw[d.id] : 1) * (pServe !== null && d.when ? 1.3 : 1)
        * (st.times ? 1 / (1 + 0.45 * st.times) : 1.15);
      if (v > bestV) { bestV = v; best = st; }
    }
    return best;
  }

  /** Say a topic: first time level 0, again (not fixed) one level more concrete. */
  _raise(st) {
    const d = st.def, T = d.lines[this.tier()];
    if (!T) return null;
    const top = T.length - 1;
    const rep = st.raised ? st.rep + 1 : 0;
    // Raised again unfixed: one level more concrete; back after you had followed it: not the same opener
    let level = st.raised ? (st.level < top ? st.level + 1 : top >= 2 ? (st.level === top ? top - 1 : top) : top) : (st.good > 0 || st.told) && top >= 1 ? 1 : 0;
    d.ev(this);                                      // fresh numbers for the lines
    let L = this._line(T[level]);
    if (L && (L[0] === this.c.lastText || L[0] === this.lastLine)) {
      level = Math.min(level + 1, top);
      L = this._line(T[level]);
      if (!L || L[0] === this.c.lastText || L[0] === this.lastLine) return null;
    }
    if (!L) return null;
    st.rep = rep; st.level = level; st.raised = true; st.at = this._srcTotal(d.src); st.lastPt = this.c.pts; st.times++;
    this._mute(d);
    return L;
  }

  _lesson(pServe, second, t) {
    const pts = this.c.pts;
    if (pts - this.lessonPt < LESSON_GAP[t]) return null;
    let best = null, bestV = 0;
    for (const ls of this.le) {
      const d = ls.def;
      if (d.tier !== t || ls.n >= 1) continue;          // each principle once per match
      if (d.tp && this.byId[d.tp] && this.byId[d.tp].times > 0) continue; // the topic said it already
      if ((d.ctx === 'serve' && !pServe) || (d.ctx === 'return' && pServe)) continue;
      const r = d.rel ? d.rel(this, !!second) : 1;
      if (!(r > 0)) continue;
      const v = r * (0.7 + 0.6 * Math.random());
      if (v > bestV) { bestV = v; best = ls; }
    }
    if (!best) return null;
    const L = this._line(best.def.lines);
    if (!L || L[0] === this.c.lastText || L[0] === this.lastLine) return null;
    best.n++; best.lastPt = pts; this.lessonPt = pts;
    const tp = best.def.tp && this.byId[best.def.tp];
    if (tp) tp.told = true;
    return L;
  }

  /** You followed a pointer: say so (once per raise, 4 points apart at least). */
  followed() {
    if (!this.on()) return null;
    const pts = this.c.pts, t = this.tier(), bit = 1 << t;
    if (pts - this.goodPt < 4) return null;
    for (const st of this.tp) {
      const d = st.def;
      if (!st.raised || !d.fix || st.good >= 2 || !(d.tiers & bit)) continue;
      const n = d.src === 'none' ? 99 : this._fresh(st);
      if (n < 3) continue;
      if (!d.fix(this, n)) continue;
      st.raised = false; st.level = 0; st.rep = 0; st.good++;
      const G = d.good && (d.good[t] || d.good[2] || d.good[1] || d.good[0]);
      const L = G ? this._line(G) : null;
      if (!L) continue;
      this.goodPt = pts; this.m.followed++; this.m.followedId = d.id;
      return L;
    }
    return null;
  }

  /** The first point of a match: the plan in one line (tour: the pre-match plan already did it). */
  opening() {
    const planned = this._planGiven;
    this._planGiven = false;                       // (a plan covers one match)
    if (!this.on() || (this.isTour() && planned)) return null;
    const t = this.tier();
    if (Math.random() > [0.7, 0.8, 0.85][t]) return null;
    let L;
    if (t === 2) {
      const we = this.c.s.windKey && this.c.s.windKey !== 'calm';
      const x = Math.random();
      L = we && x < 0.3 ? ['Wind tonight: into it hit through, with it add spin and margin.', 'Mind the wind!']
        : this.surf() !== 'hard' && x < 0.7 ? SURF_PLAN[this.surf()] : this._line(OPENING[2]);
    } else L = this._line(OPENING[t]);
    if (L) { this.linePt = this.c.pts; this.lineT = this.c.s.t; this.lastLine = L[0]; }
    return L;
  }

  /** A big point (pressure): how to play it at this tier, or null (the coach's generic line then). */
  bigPoint() {
    if (!this.on()) return null;
    const B = BIG[this.cur.big];
    const V = B && B[this.tier()];
    return V ? this._line(V) : null;
  }

  /** The other score moments (30-all / deuce, serving for the set, ahead on serve): once per game. */
  scoreLine() {
    if (!this.on() || this.cur.sc === SC_NONE || this.scoreSaidGame === this.gameIdx) return null;
    const t = this.tier(), k = this.cur.sc;
    const V = SCORE[k] && SCORE[k][t];
    if (!V || this.gameIdx - this.scoreSaid[k] < SCORE_GAP[k] || Math.random() > SCORE_P[t][k]) return null;
    const L = this._line(V);
    if (L) { this.scoreSaidGame = this.gameIdx; this.scoreSaid[k] = this.gameIdx; this.linePt = this.c.pts; this.lineT = this.c.s.t; this.lastLine = L[0]; }
    return L;
  }

  /**
   * A changeover (or set break): { text, short, urgent } or null. Urgent ones (the wind at this
   * new end, games slipping away, tired legs) always come; the rest only when `open` (the coach
   * alternates them with its game-stat lines).
   */
  changeoverLine(coGame, coSet, open) {
    if (!this.on()) return null;
    const t = this.tier(), m = this.m, s = this.c.s;
    const we = this.endPt === this.c.pts ? this.windEnd() : 0;
    if (we && t >= 1) return this._coOut('wind', WIND_CO[t][we > 0 ? 0 : 1], true);
    const mo = this.byId.momentum;
    if (coGame === 1 && (m.lostRow === 2 || m.lostRow === 4) && this.c.pts - mo.lastPt >= 4) {
      mo.lastPt = this.c.pts; mo.times++; mo.raised = true; mo.at = this._srcTotal('Q');
      return this._coOut('momentum', this._momentumCo(t, m.lostRow), true);
    }
    if (t >= 1 && s.pl && s.pl.stamina < 0.4 && !this._coRecent('stamina')) return this._coOut('stamina', STAMINA_CO[t], true);
    if (!open) return null;
    if (coSet >= 0) return t >= 1 ? this._coOut('set', this._setLine(coSet, t), false) : null;
    const st = this._topTopic(!!(s.srv && s.srv.who === 0), 1.3, 1 << t);  // serve topics before your service game
    if (st) { const L = this._raise(st); if (L) return this._coOut('topic', L, false); }
    if (t === 2 && s.score && s.score.games && !this._coRecent('score')) {
      const d = s.score.games[0] - s.score.games[1];
      if (d >= 2 || d <= -2) return this._coOut('score', this._line(d >= 2 ? UP_CO : DOWN_CO), false);
    }
    return null;
  }

  /** A changeover line of `kind` (the kinds rotate: the same one never twice running unless urgent). */
  _coOut(kind, L, urgent) {
    if (!L) return null;
    const o = this._co, h = this._coK;
    h[1] = h[0]; h[0] = kind;
    o.text = L[0]; o.short = L[1]; o.urgent = urgent;
    this.linePt = this.c.pts; this.lineT = this.c.s.t; this.lastLine = L[0];
    return o;
  }

  _coRecent(kind) { const h = this._coK; return h[0] === kind || h[1] === kind; }

  _momentumCo(t, n) {
    const N = this.Num(n);
    if (t === 0) return [`${N} games to {him}. Tranquilo: deep, middle, one point at a time.`, 'Tranquilo.'];
    if (t === 1) return [`${N} games in a row to {him}. Change the rhythm: slice, high balls.`, 'Change the rhythm!'];
    return [`${N} games gone. Reset: first serves in, deep returns, long points.`, 'Reset!'];
  }

  _setLine(coSet, t) {
    const w = this.oppWeak(), m = this.m;
    if (coSet === 0) {
      if (t === 2 && w >= 0) return [`Set to you! Keep going at {his} ${this.wing(w)}: ${m.rErrW[w]} errors so far.`, 'Same plan!'];
      return t === 2 ? ['Set to you! Same patterns. {He} will change something: watch.', 'Same plan!']
        : ['Set to you! Same plan: deep cross, then the short ball.', 'Same plan!'];
    }
    if (t === 2 && m.firsts >= 6 && m.firstIn / m.firsts < 0.55) return [`{His} set. First serves at ${Math.round(100 * m.firstIn / m.firsts)}%: that's the first fix.`, 'First serves!'];
    return t === 2 ? ['{His} set. New set: more first serves in, and make {him} play.', 'New set!']
      : ['{His} set. New set, new start: first serves in, deep returns.', 'New start!'];
  }

  /** Your first-serve target that has won the most points (≥ 3 played, ≥ 60 % won), or -1. */
  _bestServe() {
    const m = this.m;
    let k = -1, best = 0;
    for (let t = 0; t < 3; t++) {
      if (m.tgtPts[t] < 3) continue;
      const r = m.tgtWon[t] / m.tgtPts[t];
      if (r >= 0.6 && r > best) { best = r; k = t; }
    }
    return k;
  }

  /** Break point on your serve: your best first-serve target so far, if one stands out. */
  bestServeLine(prefix) {
    const m = this.m, k = this._bestServe();
    if (k >= 0) return [`${prefix}: your ${this.tgtWord(k)} serve won ${m.tgtWon[k]} of ${m.tgtPts[k]}. Go there.`, 'Go there!'];
    return [`${prefix} down: first serve in, then your safest pattern.`, 'First serve in!'];
  }

  forSetLine() {
    const k = this._bestServe();
    return k >= 0 ? [`Serving for the set: your best pattern. ${cap(this.tgtWord(k))} serve, then attack.`, 'Your pattern!']
      : ['Serving for the set: your best pattern. First serve in, then attack.', 'Your pattern!'];
  }

  // ─────────────────────────── tour: plan, changeovers, review ───────────────────────────

  /**
   * Tour: the game plan before a match, 2–4 lines (third person, the opponent's name): his style,
   * the surface / wind, what your own last matches say (habits), and his rating.
   * opponent: { name, short, style, rating, … } (the tour's matchSpec.opponent); spec (optional):
   * { surface, wind } when the session hasn't set them on itself yet.
   */
  preMatchPlan(opponent, spec) {
    this.setOpponent(opponent);
    this._planGiven = true;
    const o = this.opp || {}, name = this.oppName();
    const P = STYLE_PLAN[this.oppStyle] || STYLE_PLAN.allCourt;
    const out = [];
    out.push(P[0][0]);
    const sk = (spec && spec.surface) || this.surf(), wk = (spec && spec.wind) || this.c.s.windKey || 'calm';
    if (wk && wk !== 'calm' && Math.random() < 0.5) out.push(wk === 'gusty' ? 'Gusty tonight: big margins, and lob only with the wind behind you.' : 'A breeze: into it hit through, with it add spin and margin.');
    else if (sk === 'clay' || sk === 'grass' || sk === 'hard') out.push(SURF_PLAN[sk][0]);
    const own = this._habitLine();
    out.push(own || P[1][0]);
    const r = +o.rating;
    if (ok(r) && out.length < 4) {
      if (r >= 1650) out.push("On paper {he's} stronger. Nothing to lose: play free, take your chances.");
      else if (r >= 1400) out.push('An even match on paper. The first-serve percentage decides it.');
      else out.push("You're the favourite. No free points: make {him} earn everything.");
    }
    for (let i = 0; i < out.length; i++) out[i] = voice(out[i], true, name);
    return out;
  }

  /**
   * Tour: one line ([text, bubble]) for a changeover / set break, about the match situation: the
   * set, games slipping away, the wind at the new end, tired legs, his tendencies, the score, else
   * the plan for the next game. The kinds rotate, so the same message never comes twice running.
   */
  tourChangeover(ev, score) {
    if (!this.on()) return null;
    const sc = score || this.c.s.score, m = this.m, t = this.tier(), s = this.c.s;
    let o = null;
    if (ev && ev.set) o = this._coOut('set', this._setLine(ev.setWinner === 0 ? 0 : 1, 2), false);
    const mo = this.byId.momentum;
    if (!o && m.lostRow >= 2 && !this._coRecent('momentum') && this.c.pts - mo.lastPt >= 4) {
      mo.lastPt = this.c.pts; mo.times++; mo.raised = true; mo.at = this._srcTotal('Q');
      o = this._coOut('momentum', this._momentumCo(t, m.lostRow), true);
    }
    const we = this.endPt === this.c.pts ? this.windEnd() : 0;
    if (!o && we) o = this._coOut('wind', WIND_CO[2][we > 0 ? 0 : 1], true);
    if (!o && s.pl && s.pl.stamina < 0.4 && !this._coRecent('stamina')) o = this._coOut('stamina', STAMINA_CO[2], true);
    // Who serves the next game (the score has already moved on)
    const pServe = !!(sc && typeof sc.currentServer === 'number' ? sc.currentServer === 0 : s.srv && s.srv.who === 0);
    if (!o && !this._coRecent('topic')) { const st = this._topTopic(pServe, 1, 1 << t); const L = st ? this._raise(st) : null; if (L) o = this._coOut('topic', L, false); }
    if (!o && sc && sc.games && !this._coRecent('score')) {
      const d = sc.games[0] - sc.games[1];
      if (d >= 2 || d <= -2) o = this._coOut('score', this._line(d >= 2 ? UP_CO : DOWN_CO), false);
    }
    if (!o && !this._coRecent('next')) o = this._coOut('next', this._line(pServe ? NEXT_SERVE : NEXT_RETURN), false);
    return o ? [o.text, o.short] : null;
  }

  /** Tour: 2–3 review lines after a match ({ won, stats }). */
  postMatch(res) {
    const won = !!(res && res.won), out = [];
    out.push(this._line(won ? WON_OPEN : LOST_OPEN)[0]);
    const good = this._reviewGood();
    if (good) out.push(good);
    const work = this._reviewWork(null);
    if (work) out.push(work.text);
    if (out.length < 2) out.push(won ? 'Same plan next round. Your patterns, your pace.' : 'Next time: first serves in, deep returns, and patience.');
    const name = this.oppName();
    for (let i = 0; i < out.length; i++) out[i] = voice(out[i], this.isTour(), name);
    return out.slice(0, 3);
  }

  _reviewGood() {
    const m = this.m, tier = this.tier();
    const w = this.oppWeak();
    if (tier >= 1 && w >= 0 && m.rErrW[w] >= 4) return `{His} ${this.wing(w)} broke down: ${m.rErrW[w]} errors. You found it.`;
    if (tier >= 1) for (let t = 0; t < 3; t++) if (m.tgtPts[t] >= 4 && m.tgtWon[t] / m.tgtPts[t] >= 0.7) return `Your ${this.tgtWord(t)} serve won ${m.tgtWon[t]} of ${m.tgtPts[t]} points. A weapon.`;
    if (m.app >= 4 && m.appWon / m.app >= 0.6) return `At the net you won ${m.appWon} of ${m.app}. Keep coming in.`;
    if (m.bigN >= 4 && m.bigWon / m.bigN >= 0.6) return `Big points: you won ${m.bigWon} of ${m.bigN}. That's the difference.`;
    if (m.longN >= 4 && m.longWon / m.longN >= 0.6) return `Long rallies: ${m.longWon} of ${m.longN} to you. Your legs held.`;
    if (m.followed >= 2) return 'You listened and changed things mid-match. That wins matches.';
    return '';
  }

  /** The strategy lesson of the match: { score, text } or null. cats: technique categories already on the card. */
  _reviewWork(cats) {
    const m = this.m, t = this.tier(), C = this._revC || (this._revC = []);
    C.length = 0;
    const add = (score, text) => { if (score > 0) C.push(score, text); };
    if (m.chgDeepBad >= 3 && t >= 1) add(1 + 0.2 * m.chgDeepBad, `Going line off deep balls cost you ${m.chgDeepBad} points. Wait for the short ball.`);
    if (m.lineErr >= 4 && m.lineErr / Math.max(1, m.lineN) > 0.3 && t === 0) add(1 + 0.15 * m.lineErr, `${m.lineErr} misses down the line. Cross-court is the safe shot.`);
    if (m.firsts >= 8 && m.firstIn / m.firsts < 0.55 && !(cats && cats.serve)) add(1 + (0.55 - m.firstIn / m.firsts) * 3, `First serves in: ${Math.round(100 * m.firstIn / m.firsts)}%. Get it to 65% and the match gets easier.`);
    const tt = m.tgt[0] + m.tgt[1] + m.tgt[2];
    if (tt >= 8 && t >= 1) {
      let k = 0; for (let q = 1; q < 3; q++) if (m.tgt[q] > m.tgt[k]) k = q;
      if (m.tgt[k] / tt >= 0.75) add(0.9, `${Math.round(100 * m.tgt[k] / tt)}% of your first serves went ${this.tgtTo(k)}. Mix in ${this.tgtOther(k)}.`);
    }
    if (m.appCrossLost >= 2 && t >= 1) add(1.1, `${m.appCrossLost} cross-court approaches got passed. Approach down the line.`);
    if (m.appDeepLost >= 2 && t <= 1) add(1, `Coming in from the baseline cost ${m.appDeepLost} points. Only on a short ball.`);
    if (m.shots >= 15 && m.shortHit / m.shots >= 0.35) add(0.9, `${m.shortHit} of your balls landed short. Aim higher over the net: depth.`);
    if (m.ret2 >= 3 && m.ret2Weak / m.ret2 >= 0.6 && t >= 1) add(0.9, 'Second-serve returns were soft. Step in and attack them.');
    if (m.ret1 >= 5 && m.ret1Bad / m.ret1 >= 0.5) add(0.85, `${m.ret1Bad} of ${m.ret1} returns short or out. Deep through the middle.`);
    const f = m.rWinW[W_FH], b = m.rWinW[W_BH];
    if (t >= 1 && f >= 3 && f >= 0.7 * (f + b)) add(0.9, `${f} forehand winners from {him}. Keep the ball on {his} backhand.`);
    if (t >= 1 && b >= 3 && b >= 0.7 * (f + b)) add(0.9, `${b} backhand winners from {him}. Keep the ball on {his} forehand.`);
    if (m.longN >= 4 && m.longWon / m.longN <= 0.3) add(0.8, `Long rallies: you won ${m.longWon} of ${m.longN}. ${t === 0 ? 'Patience: deep, middle.' : 'Strike on the first short ball.'}`);
    if (m.maxLostRow >= 3) add(0.7, `${this.Num(m.maxLostRow)} games in a row slipped away. Reset early: deep, safe, make {him} play.`);
    let bi = -1, bs = 0;
    for (let i = 0; i < C.length; i += 2) if (C[i] > bs) { bs = C[i]; bi = i; }
    if (bi < 0) return null;
    const o = this._rev || (this._rev = { score: 0, text: '' });
    o.score = Math.min(3, bs); o.text = C[bi + 1];
    return o;
  }

  /**
   * The strategy takeaway for the results card (matches): { score, text } or null — the lesson of
   * the match, else something that worked. Also stores this match in the coach's habits (the
   * tour pre-match plan reads them).
   */
  summaryLine(cats) {
    const s = this.c.s;
    if (!s || (s.mode !== 'match' && this.mode !== 'match') || this.m.pts < 6) return null;
    this._updateHabits();
    const w = this._reviewWork(cats);
    if (w) return w;
    const g = this._reviewGood();
    if (!g) return null;
    const o = this._rev || (this._rev = { score: 0, text: '' });
    o.score = 0.8; o.text = g;
    return o;
  }

  _updateHabits() {
    if (this._habDone || this.m.pts < 10) return;
    this._habDone = true;
    const c = this.c, m = this.m;
    const h = c.habits && typeof c.habits === 'object' ? c.habits : (c.habits = {});
    const r2 = (x) => Math.round(clamp(x, 0, 1) * 100) / 100;
    h.n = (h.n | 0) + 1;
    if (m.firsts >= 6) h.fi = r2(m.firstIn / m.firsts);
    h.cd = Math.min(20, m.chgDeepBad);
    if (m.app >= 3) h.nw = r2(m.appWon / m.app);
    if (m.shots >= 12) h.sh = r2(m.shortHit / m.shots);
    const tt = m.tgt[0] + m.tgt[1] + m.tgt[2];
    if (tt >= 6) { let k = 0; for (let q = 1; q < 3; q++) if (m.tgt[q] > m.tgt[k]) k = q; h.tk = k; h.ts = r2(m.tgt[k] / tt); }
    if (m.bigN >= 3) h.bw = r2(m.bigWon / m.bigN);
    if (typeof c._saveStore === 'function') c._saveStore();
  }

  _habitLine() {
    const h = this.c.habits;
    if (!h || !(h.n >= 1)) return '';
    if (h.fi >= 0 && h.fi < 0.55) return `Your first serve was ${Math.round(h.fi * 100)}% last time. Tonight: first serve in.`;
    if (h.cd >= 3) return 'Last match the line off deep balls cost you. Cross first, then line.';
    if (h.sh >= 0.35) return 'Your ball landed short last time. Tonight: depth, higher over the net.';
    if (h.ts >= 0.75 && h.tk >= 0 && h.tk < 3) return `Last time your first serve went ${this.tgtTo(h.tk)} all night. Mix it up.`;
    if (h.nw >= 0.6) return 'You win at the net: come forward on the short balls.';
    if (h.nw >= 0 && h.nw < 0.4) return 'Your net points leaked last time: approach down the line.';
    if (h.bw >= 0 && h.bw < 0.4) return 'Big points went against you last time. Tonight: percentages.';
    return '';
  }

  // ─────────────────────────── the score moment ───────────────────────────

  _scoreState() {
    const s = this.c.s, sc = s.score, cur = this.cur;
    cur.big = BIG_NONE; cur.sc = SC_NONE; cur.scTxt = '';
    if (!sc || !sc.pts) return;
    const pr = typeof sc.pressure === 'function' ? sc.pressure() : null;
    if (pr && pr.kind !== 'game') {
      const mine = pr.for === 0;
      cur.big = pr.kind === 'break' ? (mine ? BP_FOR : BP_AG) : pr.kind === 'set' ? (mine ? SP_FOR : SP_AG) : pr.kind === 'match' ? (mine ? MP_FOR : MP_AG) : BIG_NONE;
      return;
    }
    if (sc.tiebreak) return;
    const a = sc.pts[0], b = sc.pts[1], srv = cur.server, G = sc.gamesPerSet || 6, g = sc.games || [0, 0];
    if (a === 2 && b === 2) { cur.sc = SC_30; cur.scTxt = '30-all'; } else if (a >= 3 && a === b) { cur.sc = SC_30; cur.scTxt = 'Deuce'; } else if (a === 0 && b === 0) {
      if (srv === 0 && g[0] + 1 >= G && g[0] + 1 - g[1] >= 2) cur.sc = SC_FORSET;
      else if (srv === 1 && g[1] + 1 >= G && g[1] + 1 - g[0] >= 2) cur.sc = SC_STAY;
    } else if (srv === 0 && a >= 3 && a - b >= 2 && b <= 1) { cur.sc = SC_AHEAD; cur.scTxt = b === 0 ? '40-0' : '40-15'; }
  }

  // ─────────────────────────── evidence ───────────────────────────

  _gs(i) { const P = this.P; return P.vol[i] !== 1 && P.spin[i] <= SP.slice && P.wing[i] !== W_OH; }
  _rally(i) { return this._gs(i) && this.P.ret[i] !== 1; }
  _isErr(r) { return r >= R_NET && r <= R_MISS; }
  /** Going down the line (a change of direction unless his ball came down the line too). */
  _chg(i) {
    const P = this.P, d = P.dir[i];
    if (d !== D_LINE && d !== D_II) return false;
    const id = P.inDir[i];
    return id !== D_LINE && id !== D_II;
  }
  _deep(i) { const P = this.P, d = P.inD[i]; return ok(d) ? d >= DEEP_IN : P.fd[i] >= BASE_D; }
  _short(i) { const P = this.P, d = P.inD[i]; return ok(d) ? d <= SHORT_IN : P.fd[i] < INSIDE_D; }
  _last(W, n) { return Math.min(n, W.len); }

  recentErrs(n) {
    const P = this.P, m = this._last(P, n);
    let k = 0;
    for (let j = 0; j < m; j++) if (this._isErr(P.res[P.at(j)])) k++;
    return k;
  }

  lastApproach() { return this.Q.len > 0 && this.Q.app[this.Q.at(0)] === 1; }
  lastOppNet() { return this.Q.len > 0 && this.Q.rnet[this.Q.at(0)] === 1; }
  lastStretched() {
    const P = this.P, Q = this.Q;
    return P.len > 0 && Q.len > 0 && P.pt[P.at(0)] === this.c.pts - 1 && Math.abs(P.fu[P.at(0)]) > 3.2 && Q.won[Q.at(0)] === 0;
  }

  /** His weaker wing from his errors (W_FH / W_BH), or -1. */
  oppWeak() {
    const e = this.m.rErrW;
    if (e[W_BH] >= 3 && e[W_BH] >= 2 * e[W_FH] + 1) return W_BH;
    if (e[W_FH] >= 3 && e[W_FH] >= 2 * e[W_BH] + 1) return W_FH;
    return -1;
  }

  evChgDeep() {
    const P = this.P, m = this._last(P, 16);
    let n = 0, bad = 0, setup = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !this._chg(i) || !this._deep(i)) continue;
      n++;
      if (this._isErr(P.res[i])) bad++;
      else if (P.end[i] === E_SETUP) { bad++; setup++; }
    }
    this._n1 = n; this._n2 = bad; this._setup = setup > 0 && setup * 2 >= bad; this._n3 = Math.max(n, this.m.chgDeep);
    if (!bad) return 0;
    return n >= 3 ? 1 + 0.4 * (bad - 1) + 0.15 * (n - 3) : bad >= 2 ? 1 : 0;
  }

  fixChgDeep(k) {
    const P = this.P, m = this._last(P, k);
    let deep = 0, chg = 0;
    this._lineShort = false;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i)) continue;
      if (this._deep(i)) { deep++; if (this._chg(i)) chg++; } else if (this._short(i) && this._chg(i) && !this._isErr(P.res[i])) this._lineShort = true;
    }
    return deep >= 4 && chg === 0;
  }

  evLineErr() {
    const P = this.P, m = this._last(P, 12);
    let ln = 0, le = 0, cn = 0, ce = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._gs(i) || !(P.res[i] >= 0)) continue;
      const d = P.dir[i], e = this._isErr(P.res[i]) ? 1 : 0;
      if (d === D_LINE || d === D_II) { ln++; le += e; } else if (d === D_CROSS || d === D_IO) { cn++; ce += e; }
    }
    this._n1 = le;
    if (le < 2) return 0;
    return le / ln >= (cn ? ce / cn : 0) + 0.2 ? 0.6 + 0.3 * le : 0;
  }

  fixLineErr(k) {
    const P = this.P, m = this._last(P, k);
    let n = 0, e = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._gs(i) || !(P.res[i] >= 0)) continue;
      const d = P.dir[i];
      if (d === D_LINE || d === D_II || d === D_CROSS || d === D_IO) { n++; if ((d === D_LINE || d === D_II) && this._isErr(P.res[i])) e++; }
    }
    return n >= 4 && e === 0;
  }

  evDeepMid() {
    const P = this.P, m = this._last(P, 8);
    let n = 0, errs = 0, near = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!(P.res[i] >= 0)) continue;
      n++;
      if (!this._isErr(P.res[i])) continue;
      errs++;
      if (P.res[i] === R_WIDE || Math.abs(P.aim[i]) >= 3.0 || P.aimD[i] >= 10.8) near++;
    }
    this._n1 = errs;
    return n >= 5 && errs >= 3 && near >= 2 ? 0.7 + 0.2 * errs : 0;
  }

  fixErrs(k, need, maxErr) {
    const P = this.P, m = this._last(P, k);
    let n = 0, e = 0;
    for (let j = 0; j < m; j++) { const i = P.at(j); if (!(P.res[i] >= 0)) continue; n++; if (this._isErr(P.res[i])) e++; }
    return n >= need && e <= maxErr;
  }

  evSide() {
    const P = this.P, m = this._last(P, 8);
    let n = 0, near = 0, errs = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.ou[i])) continue;
      if (this._isErr(P.res[i])) { errs++; continue; }
      if (!ok(P.lu[i])) continue;
      n++;
      if (Math.abs(P.lu[i] - P.ou[i]) < 1.8) near++;
    }
    this._n1 = near;
    return n >= 6 && errs <= 1 && near >= 6 ? 1 + 0.25 * (near - 6) : 0;
  }

  fixSide(k) {
    const P = this.P, m = this._last(P, k);
    let far = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (this._rally(i) && ok(P.lu[i]) && ok(P.ou[i]) && !this._isErr(P.res[i]) && Math.abs(P.lu[i] - P.ou[i]) >= 2.6) far++;
    }
    return far >= 3;
  }

  evShort() {
    const P = this.P, m = this._last(P, 8);
    let n = 0, sh = 0, pun = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.ld[i]) || this._isErr(P.res[i])) continue;
      n++;
      if (P.ld[i] < SHORT_OUT) { sh++; if (P.end[i] === E_SETUP || P.pun[i] === 1) pun++; }
    }
    this._n1 = sh;
    if (n < 5) return 0;
    return sh >= 5 ? 1 + 0.25 * (sh - 5) : sh >= 4 && pun >= 1 ? 1 : 0;
  }

  fixShort(k) {
    const P = this.P, m = this._last(P, k);
    let n = 0, sh = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.ld[i]) || this._isErr(P.res[i])) continue;
      n++; if (P.ld[i] < SHORT_OUT) sh++;
    }
    return n >= 5 && sh <= 1;
  }

  evNoAttack() {
    const P = this.P, m = this._last(P, 12);
    let pas = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !this._short(i) || this._isErr(P.res[i])) continue;
      const d = P.dir[i];
      const att = d === D_LINE || d === D_II || P.app[i] === 1 || P.end[i] === E_WIN || P.pow[i] >= 0.75;
      if (!att) pas++;
    }
    this._n1 = pas;
    return pas >= 3 ? 1 + 0.3 * (pas - 3) : 0;
  }

  fixNoAttack(k) {
    const P = this.P, m = this._last(P, k);
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (this._rally(i) && this._short(i) && (P.dir[i] === D_LINE || P.dir[i] === D_II || P.app[i] === 1)) return true;
    }
    return false;
  }

  /** You had pulled him wide (his last ball came from out wide or at a stretch): row i's landing vs where he was. */
  _wideBack(i) { const P = this.P; return P.lu[i] * P.ohu[i] > 0 && Math.abs(P.lu[i] - P.ohu[i]) < 2.4; }

  evOpen() {
    const P = this.P, m = this._last(P, 12);
    let back = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || P.owide[i] !== 1 || !ok(P.lu[i]) || this._isErr(P.res[i])) continue;
      if (this._wideBack(i)) back++;
    }
    this._n1 = back;
    return back >= 2 ? 0.6 + 0.4 * back : 0;
  }

  fixOpen(k) {
    const P = this.P, m = this._last(P, k);
    let n = 0, open = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || P.owide[i] !== 1 || !ok(P.lu[i]) || this._isErr(P.res[i])) continue;
      n++;
      if (!this._wideBack(i)) open++;
    }
    return n >= 1 && open === n;
  }

  evSameSide() {
    const P = this.P, m = this._last(P, 10);
    let n = 0, fh = 0, bh = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.lu[i]) || !ok(P.ou[i]) || this._isErr(P.res[i])) continue;
      n++;
      const rel = P.lu[i] - P.ou[i];     // + = your right = his left: his backhand
      if (rel > 0.4) bh++; else if (rel < -0.4) fh++;
    }
    if (n < 8) return 0;
    const weak = this.oppWeak();
    if (fh >= 8 && weak !== W_FH) { this._w = W_FH; this._n1 = fh; return 1.1; }
    if (bh >= 9 && weak !== W_BH && this.ptLost(8) >= 5) { this._w = W_BH; this._n1 = bh; return 1.0; }
    return 0;
  }

  fixSameSide(k) {
    const P = this.P, m = this._last(P, k);
    let other = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.lu[i]) || !ok(P.ou[i])) continue;
      const rel = P.lu[i] - P.ou[i];
      if (this._w === W_FH ? rel > 0.4 : rel < -0.4) other++;
    }
    return other >= 3;
  }

  evInsideOut() {
    const P = this.P, m = this._last(P, 12);
    let bh = 0, lost = 0, io = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i)) continue;
      if (P.wing[i] === W_BH && P.fu[i] < -1.2) { bh++; if (this._isErr(P.res[i]) || P.end[i] === E_SETUP) lost++; }
      if (P.wing[i] === W_FH && P.fu[i] < -0.7) io++;
    }
    this._n1 = bh; this._n2 = lost;
    return bh >= 4 && lost >= 2 && io === 0 ? 1.1 : 0;
  }

  fixInsideOut(k) {
    const P = this.P, m = this._last(P, k);
    for (let j = 0; j < m; j++) { const i = P.at(j); if (this._rally(i) && P.wing[i] === W_FH && P.dir[i] === D_IO && !this._isErr(P.res[i])) return true; }
    return false;
  }

  evInsideIn() {
    const P = this.P, m = this._last(P, 12);
    let e = 0;
    for (let j = 0; j < m; j++) { const i = P.at(j); if (this._rally(i) && P.dir[i] === D_II && this._isErr(P.res[i])) e++; }
    this._n2 = e;
    return e >= 2 ? 0.5 + 0.3 * e : 0;
  }

  /** Stretched (or from beyond the sideline) and going for it, and it cost the point. */
  evTrouble() {
    const P = this.P, m = this._last(P, 12);
    let k = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._gs(i) || !(P.str[i] > 0.6 || Math.abs(P.fu[i]) > 3.9)) continue;
      if ((this._isErr(P.res[i]) || P.end[i] === E_SETUP) && P.pow[i] > 0.55 && P.spin[i] !== SP.slice) k++;
    }
    this._n1 = k;
    return k >= 2 ? 0.7 + 0.25 * k : 0;
  }

  fixTrouble(k) {
    const P = this.P, m = this._last(P, k);
    let n = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._gs(i) || !(P.str[i] > 0.6 || Math.abs(P.fu[i]) > 3.9)) continue;
      if (this._isErr(P.res[i])) return false;
      n++;
    }
    return n >= 2;
  }

  /** He covers your cross-court (stands on its side of the centre when you hit from a corner) while you keep going cross. */
  evOppShade() {
    const P = this.P, m = this._last(P, 10);
    let n = 0, shade = 0, cross = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !(Math.abs(P.fu[i]) > 2) || !ok(P.ou[i])) continue;
      n++;
      if (P.ou[i] * Math.sign(P.fu[i]) < -0.8) shade++;
      if (P.dir[i] === D_CROSS || P.dir[i] === D_IO) cross++;
    }
    return n >= 6 && shade >= 5 && cross >= 0.6 * n ? 1 : 0;
  }

  evServeMix() {
    const S = this.S, c = this._cnt;
    c[0] = c[1] = c[2] = 0;
    let n = 0, lost = 0;
    for (let j = 0; j < S.len && n < 6; j++) {
      const i = S.at(j);
      if (S.second[i] === 1 || !(S.tgt[i] >= 0)) continue;
      n++; c[S.tgt[i]]++;
      if (S.won[i] === 0) lost++;
    }
    if (n < 6) return 0;
    let top = 0, k = 0;
    for (let t = 0; t < 3; t++) if (c[t] > top) { top = c[t]; k = t; }
    this._n1 = top; this._tgt = k;
    if (top < 5) return 0;
    return (top === 6 ? 1.3 : 1.0) + (lost >= 3 ? 0.3 : 0);
  }

  fixServeMix(k) {
    const S = this.S, c = this._cnt;
    c[0] = c[1] = c[2] = 0;
    let n = 0;
    for (let j = 0; j < this._last(S, k); j++) { const i = S.at(j); if (S.second[i] === 1 || !(S.tgt[i] >= 0)) continue; n++; c[S.tgt[i]]++; }
    return n >= 4 && (c[0] > 0) + (c[1] > 0) + (c[2] > 0) >= 2;
  }

  evServeBH() {
    const S = this.S;
    let n = 0, fh = 0, bh = 0;
    for (let j = 0; j < S.len && n < 6; j++) {
      const i = S.at(j);
      if (S.second[i] === 1 || S.res[i] !== R_IN || !(S.tgt[i] >= 0)) continue;
      n++;
      const b = srvToBH(S.deuce[i], S.tgt[i]);
      if (b === 1) bh++; else if (b === 0) fh++;
    }
    this._n1 = fh;
    return n >= 4 && fh >= 4 && bh <= 1 ? 1 + 0.25 * (fh - 4) : 0;
  }

  fixServeBH(k) {
    const S = this.S;
    let n = 0, bh = 0;
    for (let j = 0; j < this._last(S, k); j++) {
      const i = S.at(j);
      if (S.second[i] === 1 || S.res[i] !== R_IN || !(S.tgt[i] >= 0)) continue;
      n++; if (srvToBH(S.deuce[i], S.tgt[i]) === 1) bh++;
    }
    return n >= 3 && bh >= 2;
  }

  evFirstIn() {
    const S = this.S;
    let n = 0, inn = 0;
    for (let j = 0; j < S.len && n < 8; j++) {
      const i = S.at(j);
      if (S.second[i] === 1 || !(S.res[i] >= 0)) continue;
      n++; if (S.res[i] === R_IN) inn++;
    }
    this._pct = n ? Math.round(100 * inn / n) : 0;
    return n >= 6 && inn / n < 0.5 ? 1 + (0.5 - inn / n) * 3 : 0;
  }

  fixFirstIn(k) {
    const S = this.S;
    let n = 0, inn = 0;
    for (let j = 0; j < this._last(S, k); j++) { const i = S.at(j); if (S.second[i] === 1 || !(S.res[i] >= 0)) continue; n++; if (S.res[i] === R_IN) inn++; }
    return n >= 5 && inn >= 4;
  }

  evPlus1() {
    const S = this.S;
    let n = 0, miss = 0, good = 0;
    for (let j = 0; j < S.len && n < 6; j++) {
      const i = S.at(j);
      if (!ok(S.p1[i])) continue;
      n++; if (S.p1[i] === 1) good++; else miss++;
    }
    this._n1 = miss;
    return n >= 3 && miss >= 3 && good <= 1 ? 1 + 0.3 * (miss - 3) : 0;
  }

  fixPlus1(k) {
    const S = this.S;
    let good = 0, miss = 0;
    for (let j = 0; j < this._last(S, k); j++) { const i = S.at(j); if (!ok(S.p1[i])) continue; if (S.p1[i] === 1) good++; else miss++; }
    return good >= 2 && miss === 0;
  }

  evAttack2() {
    const X = this.X;
    let n = 0, weak = 0;
    for (let j = 0; j < X.len && n < 3; j++) {
      const i = X.at(j);
      if (X.second[i] !== 1 || X.res[i] !== R_IN || !ok(X.retPow[i])) continue;
      n++;
      if (X.retPow[i] < 0.45 || (ok(X.retD[i]) && X.retD[i] < 7.6)) weak++;
    }
    this._n1 = weak;
    return n >= 2 && weak >= 2 ? 1.1 : 0;
  }

  fixAttack2(k) {
    const X = this.X;
    let strong = 0;
    for (let j = 0; j < this._last(X, k); j++) {
      const i = X.at(j);
      if (X.second[i] === 1 && ok(X.retPow[i]) && X.retPow[i] >= 0.55 && X.retRes[i] === R_IN) strong++;
    }
    return strong >= 2;
  }

  evRetDeep() {
    const X = this.X;
    let n = 0, bad = 0;
    for (let j = 0; j < X.len && n < 5; j++) {
      const i = X.at(j);
      if (X.second[i] === 1 || X.res[i] !== R_IN || !(X.retRes[i] >= 0)) continue;
      n++;
      if (this._isErr(X.retRes[i]) || (ok(X.retD[i]) && X.retD[i] < 7.6)) bad++;
    }
    this._n1 = bad;
    return n >= 4 && bad >= 3 ? 1 + 0.3 * (bad - 3) : 0;
  }

  fixRetDeep(k) {
    const X = this.X;
    let n = 0, bad = 0;
    for (let j = 0; j < this._last(X, k); j++) {
      const i = X.at(j);
      if (X.res[i] !== R_IN || !(X.retRes[i] >= 0)) continue;
      n++; if (this._isErr(X.retRes[i]) || (ok(X.retD[i]) && X.retD[i] < 7.6)) bad++;
    }
    return n >= 3 && bad === 0;
  }

  evAppDeep() {
    const Q = this.Q, m = this._last(Q, 16);
    let n = 0, lost = 0;
    for (let j = 0; j < m; j++) {
      const i = Q.at(j);
      if (Q.app[i] !== 1 || !(Q.appFrom[i] >= APP_DEEP)) continue;
      n++; if (!Q.won[i]) lost++;
    }
    this._n1 = n; this._n2 = lost;
    return lost >= 2 ? 0.6 + 0.4 * lost : 0;
  }

  fixAppDeep(k) {
    const Q = this.Q;
    for (let j = 0; j < this._last(Q, k); j++) { const i = Q.at(j); if (Q.app[i] === 1 && Q.appFrom[i] < APP_DEEP) return true; }
    return false;
  }

  evAppCross() {
    const Q = this.Q, m = this._last(Q, 16);
    let n = 0, passed = 0, line = 0;
    for (let j = 0; j < m; j++) {
      const i = Q.at(j);
      if (Q.app[i] !== 1 || (Q.appDir[i] !== D_CROSS && Q.appDir[i] !== D_IO)) continue;
      n++;
      if (Q.lost[i] === A_PASSED) { passed++; if (Q.passDir[i] === D_LINE || Q.passDir[i] === D_II) line++; }
    }
    this._n1 = n; this._n2 = passed;
    return passed >= 2 ? 1 + 0.2 * (passed - 2) : line >= 1 ? 1.1 : 0;
  }

  fixAppCross(k) {
    const Q = this.Q;
    for (let j = 0; j < this._last(Q, k); j++) { const i = Q.at(j); if (Q.app[i] === 1 && (Q.appDir[i] === D_LINE || Q.appDir[i] === D_II)) return true; }
    return false;
  }

  evLobRusher() {
    const Q = this.Q, m = this._last(Q, 12);
    let n = 0, rw = 0;
    for (let j = 0; j < m; j++) {
      const i = Q.at(j);
      if (Q.rnet[i] !== 1) continue;
      n++; if (!Q.won[i] && Q.plob[i] !== 1) rw++;
    }
    this._n1 = rw; this._n2 = n;
    return n >= 3 && rw >= 2 ? 0.8 + 0.3 * rw : 0;
  }

  fixLobRusher(k) {
    const Q = this.Q;
    for (let j = 0; j < this._last(Q, k); j++) { const i = Q.at(j); if (Q.rnet[i] === 1 && Q.plob[i] === 1 && Q.won[i]) return true; }
    return false;
  }

  evNetShy() {
    const t = this.tier();
    if (this.m.app > 0 || this.c.pts < 10 || (t === 1 && this.surf() !== 'grass')) return 0;
    const P = this.P, m = this._last(P, 12);
    let sb = 0;
    for (let j = 0; j < m; j++) { const i = P.at(j); if (this._rally(i) && this._short(i)) sb++; }
    return sb >= 3 ? (this.surf() === 'grass' ? 1.3 : 1.0) : 0;
  }

  evRecover() {
    if (this.assist()) return 0;
    const R = this.R, m = this._last(R, 12);
    let k = 0;
    for (let j = 0; j < m; j++) {
      const i = R.at(j);
      if (R.end[i] !== E_WIN || !ok(R.pcu[i]) || !ok(R.lcu[i])) continue;
      if (Math.abs(R.pcu[i]) > 2.4 && R.lcu[i] * R.pcu[i] < 0) k++;
    }
    this._n1 = k;
    return k >= 2 ? 0.8 + 0.2 * k : 0;
  }

  fixRecover(k) {
    const R = this.R, m = this._last(R, k);
    let n = 0;
    for (let j = 0; j < m; j++) { const i = R.at(j); if (!ok(R.pcu[i])) continue; n++; if (Math.abs(R.pcu[i]) > 2.4) return false; }
    return n >= 6;
  }

  evBisect() {
    const R = this.R;
    let n = 0, bad = 0, mid = 0;
    for (let j = 0; j < R.len && n < 6; j++) {
      const i = R.at(j);
      if (!ok(R.icu[i]) || !ok(R.pcu[i]) || !(R.pd[i] > 9)) continue;
      n++;
      if (Math.abs(R.pcu[i] - R.icu[i]) > 1.3) { bad++; if (Math.abs(R.pcu[i]) < 0.7 && Math.abs(R.icu[i]) > 1.0) mid++; }
    }
    this._n1 = bad; this._mid = mid >= 2;
    return n >= 4 && bad >= 3 ? 1 + 0.25 * (bad - 3) : 0;
  }

  fixBisect(k) {
    const R = this.R, m = this._last(R, k);
    let n = 0;
    for (let j = 0; j < m; j++) {
      const i = R.at(j);
      if (!ok(R.icu[i]) || !ok(R.pcu[i]) || !(R.pd[i] > 9)) continue;
      n++; if (Math.abs(R.pcu[i] - R.icu[i]) > 1.3) return false;
    }
    return n >= 4;
  }

  evOppWing() {
    const w = this.oppWeak();
    if (w < 0) return 0;
    const m = this.m, n = m.rErrW[w];
    this._w = w; this._n1 = n;
    const to = w === W_BH ? m.toBH : m.toFH, tot = m.toBH + m.toFH;
    this._low = tot >= 8 && to / tot < 0.5;
    return 1 + 0.2 * (n - 3) + (this._low ? 0.4 : 0);
  }

  fixOppWing(k) {
    const P = this.P, m = this._last(P, k), w = this._w;
    let n = 0, to = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.lu[i]) || !ok(P.ou[i])) continue;
      n++;
      const rel = P.lu[i] - P.ou[i];
      if (w === W_BH ? rel > 0.4 : rel < -0.4) to++;
    }
    return n >= 8 && to >= 5;
  }

  evOppWinners() {
    const w = this.m.rWinW, f = w[W_FH], b = w[W_BH];
    if (f >= 3 && f >= 0.7 * (f + b)) { this._w = W_FH; this._n1 = f; return 1.1; }
    if (b >= 3 && b >= 0.7 * (f + b)) { this._w = W_BH; this._n1 = b; return 1.1; }
    return 0;
  }

  fixOppWinners(k) {
    const P = this.P, m = this._last(P, k), w = this._w;
    let n = 0, other = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.lu[i]) || !ok(P.ou[i])) continue;
      n++;
      const rel = P.lu[i] - P.ou[i];
      if (w === W_FH ? rel > 0.4 : rel < -0.4) other++;
    }
    return n >= 6 && other >= 4;
  }

  evOppStretch() {
    const R = this.R, m = this._last(R, 10);
    let lob = 0, sl = 0;
    for (let j = 0; j < m; j++) {
      const i = R.at(j);
      if (!(R.str[i] > 0.7)) continue;
      if (R.spin[i] === SP.lob || R.fam[i] === F_LOB) lob++; else if (R.spin[i] === SP.slice) sl++;
    }
    this._lob = lob >= sl;
    return lob >= 2 || sl >= 2 ? 1 : 0;
  }

  evOppNet() {
    const R = this.R, m = this._last(R, 12);
    let k = 0;
    for (let j = 0; j < m; j++) {
      const i = R.at(j);
      if ((R.fam[i] === F_APPROACH || (R.net[i] === 1 && R.fd[i] > 7)) && R.prevLd[i] < SHORT_IN) k++;
    }
    return k >= 2 ? 1 : 0;
  }

  evOppServe() {
    const X = this.X, c = this._cnt, dz = this.cur.deuce ? 1 : 0;
    c[0] = c[1] = c[2] = 0;
    let n = 0;
    for (let j = 0; j < X.len && n < 4; j++) {
      const i = X.at(j);
      if (X.deuce[i] !== dz || !(X.tgt[i] >= 0) || X.res[i] === R_FAULT) continue;
      n++; c[X.tgt[i]]++;
    }
    if (n < 4) return 0;
    let top = 0, k = 0;
    for (let t = 0; t < 3; t++) if (c[t] > top) { top = c[t]; k = t; }
    if (top < 3) return 0;
    this._tgt = k;
    this._shade = (dz === 1) === (k === T_WIDE) ? 'right' : 'left';
    return 1;
  }

  evHighBH() {
    if (this.oppWeak() !== W_BH) return 0;
    const P = this.P, m = this._last(P, 10);
    let n = 0, top = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || !ok(P.lu[i]) || !ok(P.ou[i]) || P.lu[i] - P.ou[i] <= 0.4) continue;
      n++; if (P.spin[i] === SP.topspin) top++;
    }
    return n >= 5 && top / n < 0.4 ? 1 : 0;
  }

  evLowSlice() {
    const R = this.R, m = this._last(R, 12);
    let k = 0;
    for (let j = 0; j < m; j++) {
      const i = R.at(j);
      if (R.end[i] === E_WIN && R.prevSpin[i] === SP.topspin && R.prevLd[i] >= SHORT_OUT && R.prevLd[i] < 9.5) k++;
    }
    return k >= 2 ? (this.surf() === 'grass' ? 1.3 : 1.0) : 0;
  }

  evDrop() {
    const t = this.tier();
    if (this.m.drops > 0 || (t === 1 && this.surf() !== 'clay')) return 0;
    const P = this.P, m = this._last(P, 10);
    let k = 0;
    for (let j = 0; j < m; j++) { const i = P.at(j); if (this._rally(i) && P.fd[i] < 10.8 && P.od[i] >= 13.0) k++; }
    return k >= 3 ? (this.surf() === 'clay' ? 1.3 : 1.0) : 0;
  }

  evWind() {
    const we = this.windEnd();
    if (!we) return 0;
    const P = this.P, m = this._last(P, 8);
    let sh = 0, lg = 0;
    for (let j = 0; j < m; j++) {
      const i = P.at(j);
      if (!this._rally(i) || P.pt[i] < this.endPt) continue;
      if (P.res[i] === R_LONG) lg++;
      else if (!this._isErr(P.res[i]) && ok(P.ld[i]) && P.ld[i] < SHORT_OUT) sh++;
    }
    this._face = we < 0;
    return we < 0 ? (sh >= 4 ? 1 : 0) : (lg >= 2 ? 1 : 0);
  }

  evLong() {
    const Q = this.Q, m = this._last(Q, 20);
    let n = 0, w = 0, sn = 0, sw = 0;
    for (let j = 0; j < m; j++) {
      const i = Q.at(j);
      if (Q.rally[i] >= 7) { n++; if (Q.won[i]) w++; } else if (Q.rally[i] <= 3 && Q.why[i] !== Y_DBL) { sn++; if (Q.won[i]) sw++; }
    }
    this._n1 = n; this._n2 = w; this._win = false;
    if (n >= 3 && (n - w) / n >= 0.7) return 1;
    if (this.tier() === 2 && n >= 4 && w / n >= 0.7 && sn >= 4 && (sn - sw) / sn >= 0.6) { this._win = true; return 1; }
    return 0;
  }

  evFirstStrike() {
    const Q = this.Q;
    let n = 0, l = 0;
    for (let j = 0; j < Q.len && n < 8; j++) {
      const i = Q.at(j);
      if (!(Q.rally[i] <= 3) || Q.why[i] === Y_DBL) continue;
      n++; if (!Q.won[i]) l++;
    }
    this._n1 = n; this._n2 = l;
    return n >= 6 && l >= 5 && l / n >= 0.65 ? 1 : 0;
  }

  evMomentum() {
    const lr = this.m.lostRow;
    this._n1 = lr;
    if (lr >= 2) return 1.2;
    const s = this.c.s;
    return s.momentum && s.momentum[1] > 0.55 && this.ptLost(4) >= 3 ? 1.0 : 0;
  }

  fixMomentum(k) {
    const Q = this.Q;
    if (Math.min(k, Q.len) < 2) return false;
    return Q.won[Q.at(0)] === 1 && Q.won[Q.at(1)] === 1;
  }

  evStamina() { const s = this.c.s; return s.pl && s.pl.stamina < 0.35 ? 1.2 : 0; }

  ptLost(n) {
    const Q = this.Q, m = this._last(Q, n);
    let k = 0;
    for (let j = 0; j < m; j++) if (!Q.won[Q.at(j)]) k++;
    return k;
  }

  // ─────────────────────────── words ───────────────────────────

  num(n) { n = Math.round(n); return n >= 0 && n < NUMS.length ? NUMS[n] : String(n); }
  Num(n) { return cap(this.num(n)); }
  times(n) { n = Math.round(n); return n === 1 ? 'Once' : n === 2 ? 'Twice' : `${this.Num(n)} times`; }
  ordTime(n) { n = Math.round(n); return n >= 2 && n <= 4 ? `${ORDS[n]} time down the line` : 'Down the line again'; }
  ordChange(n) { n = Math.round(n); return n >= 2 && n <= 4 ? `${ORDS[n]} change of direction` : 'Again a change of direction'; }
  wing(w) { return w === W_BH ? 'backhand' : 'forehand'; }
  Wing(w) { return w === W_BH ? 'Backhand' : 'Forehand'; }
  tgtWord(t) { return t === T_T ? 'T' : t === T_BODY ? 'body' : 'wide'; }
  tgtTo(t) { return t === T_T ? 'to the T' : t === T_BODY ? 'at {his} body' : 'wide'; }
  tgtOther(t) { return t === T_T ? 'the wide one' : t === T_BODY ? 'the T and wide' : 'the T'; }
  tgtAlt(t) { return t === T_WIDE ? 'down the T' : 'wide'; }

  /** One variant ([text, bubble] or a function of this), never the line just said if another fits. */
  _line(variants) {
    if (!variants || !variants.length) return null;
    const k = Math.floor(Math.random() * variants.length), last = this.c.lastText;
    let L = null;
    for (let j = 0; j < variants.length; j++) {
      const v = variants[(k + j) % variants.length];
      L = typeof v === 'function' ? v(this) : v;
      if (L && L[0] !== last && L[0] !== this.lastLine) return L;
    }
    return L;
  }

  _mute(d) {
    if (!d.mute) return;
    const iss = this.c.iss;
    if (!iss) return;
    for (let k = 0; k < iss.length; k++) if (d.mute.indexOf(iss[k].def.id) >= 0) iss[k].lastPt = this.c.pts;
  }

  _srcTotal(src) { const W = src === 'P' ? this.P : src === 'R' ? this.R : src === 'S' ? this.S : src === 'X' ? this.X : src === 'Q' ? this.Q : null; return W ? W.total : 0; }
  _fresh(st) { return this._srcTotal(st.def.src) - st.at; }

  /** Court-local position of the opponent (his body) → this._ou / this._ov (NaN when unknown). */
  _oppXZ(s) {
    this._ou = NaN; this._ov = NaN;
    const npc = s.ai && s.ai.npc, f = s.frame;
    if (!npc || !npc.body || !f || typeof f.lu !== 'function') return;
    const p = npc.body.position;
    this._ou = f.lu(p.x, p.z); this._ov = f.lv(p.x, p.z);
  }

  /** The current flight's planned first bounce, court-local → this._lu / this._lv (NaN when unknown). */
  _flightLand(s) {
    this._lu = NaN; this._lv = NaN;
    const fl = s.fl, f = s.frame;
    if (!fl || !f || typeof f.lu !== 'function' || !ok(fl.landX) || !ok(fl.landZ)) return;
    this._lu = f.lu(fl.landX, fl.landZ); this._lv = f.lv(fl.landX, fl.landZ);
  }
}

/** For tests and tools: every line template (topics, lessons, plans, big points …). */
export const STRATEGY_TEXT = { TOPICS, LESSONS, OPENING, SURF_PLAN, SURF_LINE, BIG, SCORE, WIND_CO, STAMINA_CO, UP_CO, DOWN_CO, NEXT_SERVE, NEXT_RETURN, STYLE_PLAN, WON_OPEN, LOST_OPEN };
