import { storageGet, storageSet } from '../systems/SaveSystem.js';

/**
 * TennisCoach — Coach Rafa's voice during the after-hours tennis (Top Spin-style coaching).
 *
 * TennisSession calls the hooks below; each one is optional and wrapped in try/catch there.
 * The coach keeps small rolling windows (typed arrays, allocated once) of your swings, shots,
 * serves, points and court position. From those it diagnoses *patterns* rather than single
 * events: mean timing error, whiffs by cause, power habit, shot variety, error type per shot,
 * footwork, serve percentage and timing, net play, stamina, momentum and big points. It then
 * says the single most useful thing, mostly while the ball is dead between points:
 *  - one line per point at most, and fewer when you are playing well (4 points apart) than
 *    when you are struggling (every point);
 *  - an issue raised again escalates from a hint to a concrete fix, then to the root cause;
 *  - fixing what Rafa told you gets noticed ("Better! Right on time now.");
 *  - never the same line twice in a row; per-issue cooldowns and fresh-sample requirements;
 *  - a short changeover line after each game with that game's key stat;
 *  - quick praise after great points; first-time how-to lines for the mechanics.
 *
 * Rafa speaks through session._say(text, seconds, bubble): the HUD coach line shows the full
 * text (≤ ~70 chars, phone width), Rafa's speech bubble the short `bubble` (≤ ~20 chars) when the
 * session passes it on (a two-argument _say simply ignores it).
 *
 * How-to lines show once, at the first relevant moment; the ones already shown are remembered
 * in localStorage 'courtcall.tennis.coach' (and per session when storage is unavailable). With
 * session.opts.tips off only the essential how-tos (load a stroke, serve, toss) are spoken.
 *
 * No per-frame allocation: update(dt) only compares numbers; strings are built when a line is
 * chosen (a few times a minute).
 */

const STORE_KEY = 'courtcall.tennis.coach';
const INF = Infinity;

// Shot codes (onShot spin) and the shot buttons they map to
const SP = { flat: 0, topspin: 1, slice: 2, lob: 3, drop: 4, smash: 5 };
const SP_LABEL = ['flat', 'topspin', 'slice', 'lob', 'drop', 'smash'];
// Where the player's ball ended (onLanded result)
const R_PEND = -1, R_IN = 0, R_NET = 1, R_LONG = 2, R_WIDE = 3, R_MISS = 4, R_CTR = 5; // R_CTR: a serve over the centre line
const RES = { in: R_IN, net: R_NET, long: R_LONG, wide: R_WIDE, miss: R_MISS, centre: R_CTR };
// How a point ended (onPointEnd why)
const WHY = { out: 1, net: 2, winner: 3, ace: 4, double: 5 };
const Y_WINNER = 3, Y_ACE = 4, Y_DOUBLE = 5;
// Swing flags
const F_WHIFF = 1, F_LATE = 2, F_EARLY = 4, F_FAR = 8, F_FORCED = 16, F_RUN = 32, F_SET = 64,
  F_STRETCH = 128, F_VOLLEY = 256, F_HALF = 512, F_PERFECT = 1024, F_GOOD = 2048;
// What is being played (an issue applies to some of these)
const M_MATCH = 1, M_GS = 2, M_VOL = 4, M_SRV = 8, M_RD = 16; // M_RD: the rally challenge drill
const M_RALLY = M_MATCH | M_GS | M_VOL | M_RD;
// Line priorities (a pending line is only replaced by a more important one)
const P_PRAISE = 1, P_TIP = 2, P_PRESS = 3, P_CHANGE = 4, P_BETTER = 5, P_HOWTO = 6, P_ESSENTIAL = 7;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** A fixed-size ring of rows with named Float32Array columns (allocated once). */
class Win {
  constructor(n, cols) {
    this.n = n; this.i = 0; this.len = 0; this.total = 0;
    for (const c of cols) this[c] = new Float32Array(n);
  }

  /** Append a row, return its slot. */
  add() {
    const k = this.i;
    this.i = (k + 1) % this.n;
    if (this.len < this.n) this.len++;
    this.total++;
    return k;
  }

  /** Slot of the k-th newest row (0 = newest; k < len). */
  at(k) { return (this.i - 1 - k + 2 * this.n) % this.n; }

  clear() { this.i = 0; this.len = 0; this.total = 0; }
}

// ─────────────────────────── the issues Rafa can diagnose ───────────────────────────
//
// sev(c) ≥ 1 means "worth saying" (NaN / < 1: no); w weights the impact on your game.
// lines[level] = variants ([text, bubble] or (c) => [text, bubble]); a repeat escalates a level.
// src: the window whose new rows count as fresh evidence (at least `fresh` since last raised).
// better(c, n): true when the n rows since it was raised show the fix took.

const ISSUES = [
  {
    id: 'noswing', w: 1.4, modes: M_RALLY, src: (c) => (c.s.mode === 'drill' ? 'dl' : 'pt'), fresh: 1, cool: 3,
    sev: (c) => c.noSwingCount() / 2,
    lines: [
      [['Swing at it, amigo! Press SWING as the ball comes.', 'Swing!']],
      [['Press SWING when I hit. Hold it, let go when it turns green.', 'Press when I hit!']],
    ],
    better: (c, n) => n >= 3 && c.noSwingCount(n) === 0,
    betterLines: [['There it is! Now you are swinging.', 'Vamos!']],
  },
  {
    id: 'late', w: 1.25, modes: M_RALLY, src: 'sw', fresh: 2, cool: 3,
    sev: (c) => (c.meanE(8) - 0.02) / 0.03,
    lines: [
      [(c) => (c.swCount(F_FORCED, 6) >= 2
        ? ['You hold too long: the swing goes by itself, late.', 'Let go!']
        : c.pk(['A touch late, amigo. Let go a little sooner.', 'A touch late!'],
          ['Late again. Meet the ball out in front.', 'Out in front!']))],
      [(c) => [`Let go as the ring turns green. You're ${c.ms(c.meanE(8))} ms late.`, 'Let go sooner!']],
      [(c) => {
        if (c.meanPow(8) > 0.8) return ['You wait for full power, then it is late. Let go on green.', "Don't wait!"];
        if (c.swCount(F_FORCED, 6) >= 2) return ["Don't wait past the green: let go the moment it lights up.", 'Let go on green!'];
        return ['Watch the ring, not the ball. Let go the moment it is green.', 'Watch the ring!'];
      }],
    ],
    better: (c, n) => n >= 4 && c.meanE(n) < 0.025,
    betterLines: [['Better! Right on time now.', 'Better!'], ['Eso! Out in front. Keep it like that.', 'Eso!']],
  },
  {
    id: 'early', w: 1.25, modes: M_RALLY, src: 'sw', fresh: 2, cool: 3,
    sev: (c) => (-c.meanE(8) - 0.02) / 0.03,
    lines: [
      [['Too quick, amigo. Let the ball come to you.', 'Patience!'],
        ['Early again. Wait for it a little.', 'Wait for it!']],
      [(c) => [`You let go ${c.ms(c.meanE(8))} ms early. Hold on until it is green.`, 'Hold a bit longer!']],
      [['Early swings pull it wide. Think "bounce... hit", then let go.', 'Bounce... hit!']],
    ],
    better: (c, n) => n >= 4 && c.meanE(n) > -0.025,
    betterLines: [['Bueno! You waited for it. That is timing.', 'Bueno!']],
  },
  {
    id: 'far', w: 1.15, modes: M_RALLY, src: 'sw', fresh: 2, cool: 3,
    sev: (c) => (c.swCount(F_FAR, 8) + 0.5 * c.swCount(F_STRETCH, 8)) / 2,
    lines: [
      [(c) => (c.farPow(8) >= 0.6
        ? ['Loading slows your feet. Get to the ball, then load.', 'Move, then load!']
        : ['Too far from the ball. Feet first, then the swing.', 'Feet first!'])],
      [(c) => (c.s.opts && c.s.opts.assist
        ? ['Help the assist: run to the ball with the stick, then load.', 'Run to it!']
        : c.s.opts && c.s.opts.marker
          ? ['Run to the yellow marker first, then load the swing.', 'To the marker!']
          : ['Read the bounce, get there first, then load the swing.', 'Get there first!'])],
      [['Small hop as I hit, then the first step. Quick feet, amigo.', 'Quick feet!']],
    ],
    better: (c, n) => n >= 6 && c.swCount(F_FAR, n) === 0 && c.swCount(F_STRETCH, n) <= 1,
    betterLines: [['Good feet! You get there early now.', 'Good feet!']],
  },
  {
    id: 'taps', w: 0.9, modes: M_MATCH | M_GS | M_RD, src: 'sh', fresh: 3, cool: 5,
    sev: (c) => (0.25 - c.groundPow(8)) / 0.1,
    lines: [
      [['Only taps? Hold SWING longer to load some pace.', 'Load it!']],
      [['Press SWING early, as I hit. Hold, then let go on green.', 'Press early!']],
      [(c) => [`A tap just blocks it back. Your load is ${c.pct(c.groundPow(8))}% power.`, 'More load!']],
    ],
    better: (c, n) => n >= 4 && c.groundPow(n) > 0.4,
    betterLines: [['Eso! Feel the pace now?', 'Eso!']],
  },
  {
    id: 'full', w: 1.0, modes: M_MATCH | M_GS | M_RD, src: 'sh', fresh: 3, cool: 4,
    sev: (c) => {
      const p = c.groundPow(8), e = c.shErr(8);
      if (!(p > 0.85) || c.shSettled(8) < 5 || e < 3) return 0;
      return (e - 2) * 0.6 + (p - 0.85) * 4;
    },
    lines: [
      [(c) => (c.meanAbsE(8) > 0.07
        ? ['Big load, loose timing. Load less, time it better.', 'Load less!']
        : ['Full power every ball? Take seventy percent, find the court.', 'Seventy percent!'])],
      [['Press SWING a bit later: less load, more balls in.', 'Press later!']],
    ],
    better: (c, n) => n >= 6 && c.shErr(n) <= 1,
    betterLines: [['See? Less power, more balls in the court.', 'See?']],
  },
  {
    id: 'net', w: 1.0, modes: M_RALLY, src: 'sh', fresh: 2, cool: 4,
    sev: (c) => c.errSev(R_NET),
    lines: [
      [(c) => {
        if (c.meanE(8) > 0.035) return ['Late contact drops it into the net. Let go sooner.', 'Sooner!'];
        const sp = c.errSpin(R_NET);
        if (sp === SP.flat) return ['Net again. Flat needs height: aim deeper, stick up.', 'More height!'];
        if (sp === SP.slice) return ['Slice stays low. Push the stick up for depth.', 'Stick up!'];
        if (sp === SP.drop) return ['The drop needs a touch more. Stick up a little.', 'A touch more!'];
        if (c.modeBit() === M_VOL) return ['Punch it forward, not down. Stick up a touch.', 'Punch forward!'];
        return c.pk(['Into the net. Aim deeper: push the stick up.', 'Aim deeper!'],
          ['The net again, amigo. Aim higher over it.', 'Higher!']);
      }],
      [(c) => (c.modeBit() === M_VOL
        ? ['Volley: stick up a touch and punch it deep. Firm wrist.', 'Punch it deep!']
        : ['Topspin, 2, clears the net high and still dips in.', 'Topspin, 2!'])],
    ],
    better: (c, n) => n >= 6 && c.shRes(R_NET, n) === 0,
    betterLines: [['Better, over the net with margin. Bueno.', 'Bueno!']],
  },
  {
    id: 'long', w: 1.0, modes: M_RALLY, src: 'sh', fresh: 2, cool: 4,
    sev: (c) => c.errSev(R_LONG),
    lines: [
      [(c) => {
        const sp = c.errSpin(R_LONG);
        if (sp === SP.lob) return ['The lob flies long. Less load on the lob.', 'Softer lob!'];
        if (c.meanE(8) < -0.035) return ['Long: early contact, the ball is still rising. Wait.', 'Wait for it!'];
        if (c.errPow(R_LONG) > 0.75) return ['Long. Too much load: press SWING a bit later.', 'Less load!'];
        if (sp === SP.flat) return ['Flat and long. Topspin, 2, brings it down.', 'Topspin, 2!'];
        return ['Long again. Aim a bit shorter: stick down a touch.', 'A bit shorter!'];
      }],
      [['Topspin, 2, and a medium load. It dips in.', 'Topspin!']],
    ],
    better: (c, n) => n >= 6 && c.shRes(R_LONG, n) === 0,
    betterLines: [['There, inside the baseline. Bueno.', 'Bueno!']],
  },
  {
    id: 'wide', w: 0.95, modes: M_RALLY, src: 'sh', fresh: 2, cool: 4,
    sev: (c) => c.errSev(R_WIDE),
    lines: [
      [(c) => {
        const e = c.meanE(8);
        if (e < -0.035) return ['Wide. Early swings pull it wide: wait a little.', 'Wait a little!'];
        if (e > 0.035) return ['Wide. Late swings push it out. Let go sooner.', 'Sooner!'];
        return ["Wide. Don't aim for the lines: a meter inside is enough.", 'Aim inside!'];
      }],
      [['Big targets, amigo. Aim for the middle of each half.', 'Big targets!']],
    ],
    better: (c, n) => n >= 6 && c.shRes(R_WIDE, n) === 0,
    betterLines: [['Inside the lines now. Good.', 'Good!']],
  },
  {
    id: 'onrun', w: 0.75, modes: M_MATCH | M_GS | M_RD, src: 'sw', fresh: 3, cool: 5,
    sev: (c) => {
      const n = c.swN(8);
      return n < 5 ? 0 : (c.swCount(F_RUN, 8) / n - 0.2) / 0.3;
    },
    lines: [
      [['You hit on the run. Get there early and set your feet.', 'Set your feet!']],
      [['Stop, load, swing. Set feet give you control.', 'Stop, load, swing!']],
    ],
    better: (c, n) => n >= 5 && c.swCount(F_RUN, n) / n < 0.2,
    betterLines: [['Bueno, feet set. See the control?', 'Bueno!']],
  },
  {
    id: 'variety', w: 0.5, modes: M_MATCH, src: 'sh', fresh: 6, cool: 10,
    sev: (c) => (c.agg.contacts >= 12 && c.matchShare() >= 0.85 && c.topShare(12) >= 0.9 ? 1.1 : 0),
    lines: [
      [(c) => {
        switch (c._topSpin) {
          case SP.flat: return ['Flat every ball is risky. Topspin, 2, dips in.', 'Topspin, 2!'];
          case SP.slice: return ['All slice? Topspin, 2, gives you pace and margin.', 'Topspin, 2!'];
          case SP.lob: return ['Lobs all day? Drive the ball: topspin, 2.', 'Drive it!'];
          case SP.drop: return ['Too many drops. Build the point first.', 'Build it!'];
          default: return ['Always topspin? Slice, 3, stays low and makes me bend.', 'Try slice, 3!'];
        }
      }],
      [['Mix it: drop, 5, when I am deep. Lob, 4, when I come in.', 'Mix it up!']],
    ],
    better: (c, n) => n >= 8 && c.topShare(n) < 0.65,
    betterLines: [['Now you mix it. I never know what comes. Bueno!', 'Bueno!']],
  },
  {
    id: 'volleypower', w: 0.9, modes: M_MATCH | M_VOL, src: 'sh', fresh: 2, cool: 4,
    sev: (c) => {
      const v = c.volleyStats(6);
      return v.n < 2 ? 0 : v.pow > 0.6 && v.err >= 1 ? 0.6 + v.err * 0.4 : 0;
    },
    lines: [
      [['Volleys need no backswing. A quick tap, firm wrist.', 'Just a tap!']],
      [['At the net, tap SWING. The pace is already on the ball.', 'Tap it!']],
    ],
  },
  {
    id: 'volleyfar', w: 0.7, modes: M_MATCH | M_VOL, src: 'sh', fresh: 2, cool: 5,
    sev: (c) => c.volleyStats(6).far / 2,
    lines: [
      [(c) => (c.volleyStats(6).half >= 1
        ? ['A half volley at your feet? Close in, or stay back.', 'Close in!']
        : ['Volley closer to the net: two steps in, then punch.', 'Closer!'])],
    ],
  },
  // ── serve ──
  {
    id: 'doubles', w: 1.15, modes: M_MATCH, when: 'p', src: 'sv', fresh: 1, cool: 3,
    sev: (c) => (c.recentDoubles(8) >= 1 ? 0.7 + 0.4 * c.recentDoubles(8) : 0),
    lines: [
      [(c) => (c.agg.flatSecond > 0 && c.lastDoubleFlat
        ? ['A flat second serve? Kick it, 2. It clears the net.', 'Kick it, 2!']
        : c.pk(['Double fault. Second serve: kick, 2, a safe target.', 'Kick, 2!'],
          ['On the second serve, aim for the middle of the box.', 'Aim middle!']))],
      [['Second serve: kick, 2, stick centred. Just get it in.', 'Just get it in!']],
    ],
    better: (c, n) => c.secondsIn(n) >= 3,
    betterLines: [['Safe second serves now. Bueno.', 'Bueno!']],
  },
  {
    id: 'firstpct', w: 0.9, modes: M_MATCH, when: 'p', src: 'sv', fresh: 3, cool: 6,
    sev: (c) => {
      const f = c.firstIn(6);
      return c._n < 5 ? 0 : (0.55 - f) / 0.12;
    },
    lines: [
      [(c) => [`First serves in: ${c.pct(c.firstIn(6))}%. Kick, 2, has more margin.`, 'Kick, 2!']],
      [['Let go in the green and aim for the middle of the box.', 'Middle of the box!']],
    ],
    better: (c, n) => { const f = c.firstIn(n); return c._n >= 5 && f >= 0.65; },
    betterLines: [['First serves going in now. Pressure on me!', 'Bueno!']],
  },
  {
    id: 'servelate', w: 1.05, modes: M_MATCH | M_SRV, when: 'p', src: 'sv', fresh: 2, cool: 4,
    sev: (c) => (c.svMeanE(4) - 0.03) / 0.04,
    lines: [
      [(c) => (c.svRes(R_NET, 4) >= 1
        ? ['Serve into the net? The toss dropped. Let go sooner.', 'Hit it at the top!']
        : ['Serve: let go sooner, hit the toss near its peak.', 'Hit it at the top!'])],
      [(c) => [`You let go ${c.ms(c.svMeanE(4))} ms late on the serve. Go as it turns green.`, 'Sooner!']],
      [['Let go right at the top of the toss, before it falls.', 'At the top!']],
    ],
    better: (c, n) => n >= 3 && c.svMeanE(n) < 0.03,
    betterLines: [['That toss timing is better. Bueno.', 'Bueno!']],
  },
  {
    id: 'serveearly', w: 1.05, modes: M_MATCH | M_SRV, when: 'p', src: 'sv', fresh: 2, cool: 4,
    sev: (c) => (-c.svMeanE(4) - 0.03) / 0.04,
    lines: [
      [['Wait for the toss. Let go when the meter turns green.', 'Wait for the toss!']],
      [(c) => [`You let go ${c.ms(c.svMeanE(4))} ms early: the ball still rises, it flies long.`, 'Wait!']],
    ],
    better: (c, n) => n >= 3 && c.svMeanE(n) > -0.03,
    betterLines: [['Better, you wait for the toss now.', 'Better!']],
  },
  {
    id: 'svfault', w: 0.85, modes: M_MATCH | M_SRV, when: 'p', src: 'sv', fresh: 2, cool: 5,
    sev: (c) => {
      const k = c.svFaults(5), e = c.svMeanE(5);
      if (k < 3) return 0;
      // Timing explains it (late: net, early: long)? Then the timing tip is the one to give
      if ((e > 0.04 && c.svRes(R_NET, 5) >= 2) || (e < -0.04 && c.svRes(R_LONG, 5) >= 2)) return 0;
      return 0.6 + 0.25 * k;
    },
    lines: [
      [(c) => {
        if (c.svRes(R_NET, 5) >= 2) return ['Serves in the net. Kick, 2, goes higher over it.', 'Kick, 2!'];
        if (c.svRes(R_WIDE, 5) >= 2) return ['Missing wide. Aim a little more to the middle.', 'More middle!'];
        if (c.svRes(R_CTR, 5) >= 2) return ['Over the centre line. Aim a touch wider in the box.', 'A bit wider!'];
        return ['Serves long. Kick, 2, dives down into the box.', 'Kick, 2!'];
      }],
      [['Kick, 2, and aim for the middle of the box. Then add pace.', 'Middle first!']],
    ],
    better: (c, n) => n >= 4 && c.svFaults(n) <= 1,
    betterLines: [['The serve is finding the box. Vamos.', 'Vamos!']],
  },
  {
    id: 'aced', w: 0.8, modes: M_MATCH, when: 'r', src: 'pt', fresh: 2, cool: 5,
    sev: (c) => c.ptCountWhy(Y_ACE, 1, 8) / 2,
    lines: [
      [['My serve beats you. Be ready as I toss, feet moving.', 'Be ready!']],
      [['Return: a step back, and a short load. Just block it deep.', 'Block it back!']],
    ],
  },
  // ── net play ──
  {
    id: 'passed', w: 0.8, modes: M_MATCH, src: 'pt', fresh: 2, cool: 6,
    sev: (c) => c.ptNet(0) / 2,
    lines: [
      [['I pass you at the net. Approach deep, to a corner first.', 'Approach deep!']],
      [['At the net, cover the line: stand between me and the ball.', 'Cover the line!']],
    ],
  },
  {
    id: 'lobbed', w: 0.75, modes: M_MATCH, src: 'pt', fresh: 2, cool: 6,
    sev: (c) => c.ptNet(1) / 2,
    lines: [
      [['Lobbed! At the net, stay a step back from the tape.', 'Step back!']],
      [['When I lob, move back early. The smash does the rest.', 'Move back!']],
    ],
  },
  {
    id: 'rafanet', w: 0.7, modes: M_MATCH, src: 'pt', fresh: 2, cool: 6,
    sev: (c) => c.ptRafaNet() / 2,
    lines: [
      [['When I come in, lob me, 4, or pass low with slice, 3.', 'Lob me, 4!']],
      [['I am at the net: aim at my feet or over my head.', 'Feet or over!']],
    ],
  },
  {
    id: 'dropdeep', w: 0.7, modes: M_MATCH, src: 'sh', fresh: 2, cool: 8,
    sev: (c) => c.shotsWhere(SP.drop, 9.5, 10) / 2,
    lines: [[['A drop from the baseline sits up. Use it inside the court.', 'Inside the court!']]],
  },
  {
    id: 'lobdeep', w: 0.5, modes: M_MATCH, src: 'sh', fresh: 2, cool: 8,
    sev: (c) => c.lobsVsDeep(10) / 2,
    lines: [[['The lob is for when I am at the net. From the back, topspin.', 'Topspin here!']]],
  },
  // ── footwork without the auto-move assist ──
  {
    id: 'recover', w: 0.7, modes: M_MATCH, src: 'rh', fresh: 3, cool: 6,
    sev: (c) => (c.s.opts && c.s.opts.assist ? 0 : c.rhCount(0, 6) / 3),
    lines: [[['Recover to the middle after each shot. Then I have no angle.', 'Back to the middle!']]],
  },
  {
    id: 'nomans', w: 0.7, modes: M_MATCH, src: 'rh', fresh: 3, cool: 6,
    sev: (c) => (c.s.opts && c.s.opts.assist ? 0 : c.rhCount(1, 6) / 3),
    lines: [[["No man's land! Stay behind the baseline or come all the way in.", 'Back or in!']]],
  },
  // ── the body and the head ──
  {
    id: 'stamina', w: 0.6, modes: M_MATCH, src: 'none', cool: 8,
    sev: (c) => (c.s.pl && c.s.pl.stamina < 0.3 ? 1.2 : 0),
    lines: [
      [['Tired legs load slower. Breathe between points.', 'Breathe!']],
      [['Low on legs: shorter points now, go for the open court.', 'Short points!']],
    ],
  },
  {
    id: 'rhythm', w: 0.6, modes: M_MATCH, src: 'pt', fresh: 3, cool: 7,
    sev: (c) => (c.s.momentum && c.s.momentum[1] > 0.55 && c.ptLost(4) >= 3 ? 1.1 : 0),
    lines: [
      [['I have the rhythm now. Slow it down: high, deep, safe.', 'Slow it down!']],
      [['Break my rhythm: a slice, 3, then a high ball.', 'Change the pace!']],
    ],
  },
  // ── drills ──
  {
    id: 'd_short', w: 1.0, modes: M_GS, src: 'dl', fresh: 2, cool: 3,
    sev: (c) => c.drillLands(0, 4) / 2,
    lines: [
      [['The targets are deep. Push the stick up as you swing.', 'Deeper!']],
      [['Stick up at contact is depth. Aim past the service line.', 'Stick up!']],
    ],
    better: (c, n) => n >= 3 && c.drillLands(0, n) === 0,
    betterLines: [['Deep now. That is how you push me back.', 'Deep!']],
  },
  {
    id: 'd_center', w: 0.9, modes: M_GS, src: 'dl', fresh: 2, cool: 3,
    sev: (c) => c.drillLands(1, 4) / 2,
    lines: [
      [['Aim for a corner: stick left or right as you swing.', 'Corners!']],
      [['Hold the stick to the side through contact. Corners win.', 'To the side!']],
    ],
  },
  {
    id: 'd_angle', w: 1.0, modes: M_VOL, src: 'dl', fresh: 2, cool: 3,
    sev: (c) => c.drillLands(2, 4) / 2,
    lines: [
      [['Angles! Stick down and to the side for the short targets.', 'Angle it!']],
      [['Short and wide: stick diagonally down. Soft hands.', 'Short and wide!']],
    ],
  },
  {
    id: 'd_serveaim', w: 1.0, modes: M_SRV, src: 'dl', fresh: 2, cool: 3,
    sev: (c) => c.drillLands(3, 4) / 2,
    lines: [
      [(c) => (c.s.srv && c.s.srv.deuce
        ? ['From here: stick right for the T, left for the wide one.', 'Stick aims!']
        : ['From here: stick left for the T, right for the wide one.', 'Stick aims!'])],
      [['Hold the stick until the racket meets the ball. Slice, 3, skids wide.', 'Hold the aim!']],
    ],
  },
];

// ─────────────────────────── the other lines ───────────────────────────

const HOWTO = {
  charge: ['Hold SWING to load. Let go when the ring turns green.', 'Hold, then let go!'],
  serve: ['Your serve: hold SWING, up goes the toss. Let go in the green.', 'Let go in green!'],
  tossAbort: ['Keep holding while the ball goes up. Let go in the green.', 'Keep holding!'],
  tossCatch: ['Too long, I caught it! Let go as the ball drops.', 'Let go sooner!'],
  aim: ['Aim with the stick as you swing: left, right, up for deep.', 'Stick aims!'],
  kick: ['Second serve: kick, 2. High over the net, then it jumps.', 'Kick, 2!'],
  lob: ['When I come to the net: lob, 4, over my head.', 'Lob me, 4!'],
  drop: ['From inside the court, try the drop, 5. I stay deep.', 'Drop, 5!'],
  zone: ['In the zone! Your swing loads faster now. Vamos!', 'In the zone!'],
  tired: ['Tired legs load slower. Stand still between points.', 'Rest!'],
  drill_gs: ['Three targets, all deep. Stick up for depth, sideways for corners.', 'Aim deep!'],
  drill_volley: ['Volleys: a quick tap, no big load. Punch it at a target.', 'Just a tap!'],
  drill_serve: ['Two targets: one on the T, one wide. The stick picks.', 'Stick aims!'],
  drill_rally: ['Rally: topspin, deep, through the middle. Keep it going.', 'Keep it going!'],
};
const ESSENTIAL = { charge: true, serve: true, tossAbort: true, tossCatch: true };

const PRAISE = {
  ace: [['Ace! Eso!', 'Ace!'], ['Ace! I did not even move.', 'Ace!'], ['Too good. I saw nothing.', 'Ace!']],
  smash: [['Smash! Vamos!', 'Smash!'], ['Boom. Put away. Bueno!', 'Boom!']],
  drop: [['What a drop! I am still running.', 'What a drop!']],
  lob: [['Over my head! Bueno.', 'Over my head!']],
  pass: [['You passed me! Vamos.', 'Passed me!']],
  rally: [['Long rally, and you won it. Eso!', 'Eso!']],
  streak: [['Three in a row. Vamos!', 'Vamos!'], ['You are rolling now. Keep going.', 'Rolling!']],
  winner: [['Winner! That is your tennis.', 'Winner!'], ['Eso! Clean winner.', 'Eso!']],
  quick: [['Eso!', 'Eso!'], ['Bueno!', 'Bueno!']],
};
const ENCOURAGE = [
  ['Tranquilo. One point at a time.', 'Tranquilo.'],
  ['Deep breath, amigo. Make me play one more ball.', 'Deep breath.'],
];

const PRESSURE = {
  forBreak: [['Break point! Deep and safe. Make me hit one more.', 'Break point!'],
    ['Break point. Get it back deep, let me miss.', 'Break point!']],
  forSet: [['Set point. Breathe. Your best shot, not a new one.', 'Breathe!']],
  forMatch: [['Match point! Play it like any other point.', 'Tranquilo!']],
  vsServeBreak: [['Break point down. First serve in: kick, 2, is safe.', 'First serve in!'],
    ['Break point. Breathe, then a first serve I have to play.', 'Breathe!']],
  vsServe: [['Big point on your serve. Kick, 2, to my backhand.', 'Kick, 2!'],
    ['My big point, your serve. First serve in, amigo.', 'First serve in!']],
  vsReturn: [['Big point for me. Get the return back deep, middle.', 'Deep, middle!'],
    ['My big point. Just block the return back deep.', 'Block it deep!']],
};

export class TennisCoach {
  /** @param {import('./TennisSession.js').TennisSession} session */
  constructor(session) {
    this.s = session;
    // Rolling windows
    this.sw = new Win(12, ['e', 'q', 'pow', 'f']);                                   // swings (rally)
    this.sh = new Win(12, ['spin', 'pow', 'q', 'res', 'fromNet', 'aimX', 'f', 'rafaD']); // your contacts
    this.sv = new Win(10, ['e', 'pow', 'q', 'second', 'spin', 'res']);               // your serves
    this.pt = new Win(10, ['won', 'why', 'hitter', 'pnet', 'rnet', 'shot', 'rally', 'noswing']);
    this.rh = new Win(8, ['u', 'd']);                    // your position when Rafa hits (assist off)
    this.dl = new Win(8, ['kind', 'hit', 'u', 'd', 'res', 'swung', 'ns']); // drill reps
    this.iss = ISSUES.map(def => ({ def, level: 0, lastPt: -99, raised: false, at: 0, times: 0, rep: 0, improved: 0 }));
    this.next = { text: '', short: '', sec: 0, due: INF, prio: 0, kind: '', queuedAt: 0 };
    this.log = null;          // tests: an array to push { t, text, kind } into
    this.seen = {};
    this._loadSeen();
    this.agg = {};
    this.g = { pts: [0, 0], pErr: [0, 0, 0, 0], pWin: 0, pAce: 0, rWin: 0, dbl: 0, aced: 0, f: 0, fIn: 0, server: -1 };
    this.lastText = '';
    this.lastSayT = -INF;
    this.reset('none', null);
  }

  // ─────────────────────────── hooks ───────────────────────────

  /** A match ('match', { format, diff }) or drill ('drill', { type }) starts. */
  reset(mode, detail) {
    const s = this.s;
    this.mode = mode;
    this.detail = detail;
    this.sw.clear(); this.sh.clear(); this.sv.clear(); this.pt.clear(); this.rh.clear(); this.dl.clear();
    for (const st of this.iss) { st.level = 0; st.lastPt = -99; st.raised = false; st.at = 0; st.times = 0; st.rep = 0; st.improved = 0; }
    const a = this.agg;
    a.eSum = 0; a.eN = 0; a.good = 0; a.contacts = 0; a.whiffFar = 0; a.whiffLate = 0; a.whiffEarly = 0;
    a.forced = 0; a.onRun = 0; a.powSum = 0; a.powN = 0; a.errNet = 0; a.errLong = 0; a.errWide = 0;
    a.errFull = 0; a.spinN = a.spinN || new Float32Array(6); a.spinN.fill(0);
    a.svESum = 0; a.svEN = 0; a.firsts = 0; a.firstIn = 0; a.doubles = 0; a.flatSecond = 0;
    a.noSwing = 0; a.aced = 0; a.netN = 0; a.netWon = 0; a.passed = 0; a.lobbed = 0;
    a.bigN = 0; a.bigWon = 0; a.lowStam = 0; a.volleyPow = 0; a.volleyN = 0;
    a.dReps = 0; a.dHits = 0; a.dShort = 0; a.dIn = 0;
    this._resetGame();
    this.pts = 0;             // points (or drill reps) finished
    this.tipPt = -99; this.tipT = -INF; this.linePt = -99;
    this.praisePt = -99; this.encPt = -99; this.betterPt = -99;
    this._praiseLast = null;
    this.streak = 0;
    this.changeover = false; this.coGame = -1; this.coSet = -1;
    this._coHist = this._coHist || ['', '', ''];
    this._coHist[0] = this._coHist[1] = this._coHist[2] = '';
    this.pressKind = 0; this.pressWhat = ''; this.pressSaid = false;
    this.awaitSwing = false; this.reachable = false;
    this.lastDoubleFlat = false;
    this._lastRS = 0;
    this._rep = { swung: 0, hit: 0, u: 0, d: 0, res: R_PEND, landed: 0, filed: 0 };
    this._quickT = -INF;
    this.next.due = INF; this.next.prio = 0;
    // The session speaks its own intro line right after this
    this.lastSayT = s ? s.t : 0;
  }

  /** You released a stroke (the session's swing record; q 0 = whiff). */
  onSwing(sw) {
    const w = this.sw, i = w.add(), a = this.agg;
    let e = Number(sw.e) || 0, f = 0;
    if (!(sw.q > 0)) {
      f |= F_WHIFF;
      if (sw.label === 'Too late') { f |= F_LATE; e = clamp(e, 0.1, 0.18); a.whiffLate++; } else if (sw.label === 'Too early') { f |= F_EARLY; e = clamp(e, -0.18, -0.1); a.whiffEarly++; } else { f |= F_FAR; a.whiffFar++; }
    } else {
      e = clamp(e, -0.18, 0.18);
      a.eSum += e; a.eN++;
      if (Math.abs(e) <= 0.045) { f |= F_GOOD; a.good++; }
    }
    if (sw.forced) { f |= F_FORCED; a.forced++; }
    if (sw.moving > 3.2 && !sw.volley) f |= F_RUN;
    if (sw.set) f |= F_SET;
    if (sw.stretch > 0.6) f |= F_STRETCH;
    if (sw.volley) f |= F_VOLLEY;
    if (sw.half) f |= F_HALF;
    if (sw.label === 'Perfect!' || sw.label === 'Power shot!' || sw.label === 'Half volley!') f |= F_PERFECT;
    w.e[i] = e; w.q[i] = sw.q || 0; w.pow[i] = sw.power || 0; w.f[i] = f;
    this.awaitSwing = false;
    this._rep.swung = 1;
  }

  /** Your racket met the ball. */
  onShot(info) {
    const s = this.s, w = this.sh, i = w.add(), a = this.agg;
    const sp = SP[info.spin] ?? SP.topspin;
    let f = 0;
    if (info.volley) f |= F_VOLLEY;
    if (info.half) f |= F_HALF;
    if (info.onRun) f |= F_RUN;
    if (info.set) f |= F_SET;
    w.spin[i] = sp; w.pow[i] = info.power || 0; w.q[i] = info.q || 0; w.res[i] = R_PEND;
    w.fromNet[i] = info.fromNet || 0; w.aimX[i] = info.aimX || 0; w.f[i] = f;
    let rd = 12;
    try {
      const npc = s.ai && s.ai.npc;
      if (npc && s.frame) rd = s.frame.lv(npc.body.position.x, npc.body.position.z) * s.sides[1];
    } catch (e) { /* keep the default */ }
    w.rafaD[i] = rd;
    a.contacts++;
    a.spinN[sp]++;
    if (info.onRun) a.onRun++;
    if (info.volley && !info.smash) { a.volleyPow += info.power || 0; a.volleyN++; }
    else if (sp <= SP.slice) { a.powSum += info.power || 0; a.powN++; }
    // A rare "Eso!" mid-rally after a perfect, fully loaded strike
    if (this._tipsOn() && info.q >= 0.95 && info.power >= 0.9 && s.t - this._quickT > 45 && s.t - this.lastSayT > 4 && Math.random() < 0.15) {
      this._quickT = s.t;
      const L = this.pk(PRAISE.quick[0], PRAISE.quick[1]);
      this._speak(L[0], L[1], 1.0, 'quick');
    }
  }

  /** Your serve was released (srv: power, e, q, label, second). */
  onServe(srv) {
    const s = this.s, w = this.sv, i = w.add(), a = this.agg;
    const shot = s.ctl ? s.ctl.shot : 0;
    const spin = shot === 0 ? 0 : shot === 2 || shot === 4 ? 2 : 1;   // flat / kick / slice
    w.e[i] = clamp(Number(srv.e) || 0, -0.3, 0.3); w.pow[i] = srv.power || 0; w.q[i] = srv.q || 0;
    w.second[i] = srv.second ? 1 : 0; w.spin[i] = spin; w.res[i] = R_PEND;
    if (srv.q > 0) { a.svESum += w.e[i]; a.svEN++; this._markSeen('serve'); }
    if (srv.second && spin === 0) a.flatSecond++;
  }

  /** The toss went wrong: 'aborted' (let go before it left the hand) / 'caught' (held too long). */
  onToss(kind) {
    const s = this.s;
    const id = kind === 'caught' ? 'tossCatch' : 'tossAbort';
    if (!this.seen[id]) { this._howto(id, 0); return; }
    // Again? A shorter reminder now and then (the ball is dead: a good moment)
    if (this._tipsOn() && s.t - this.lastSayT > 8 && Math.random() < 0.5) {
      const L = kind === 'caught' ? ['Let go as the ball comes down, amigo.', 'Let go sooner!'] : ['Hold SWING through the toss, amigo.', 'Keep holding!'];
      this._speak(L[0], L[1], 2.6, 'reply');
    }
  }

  /** Where your ball ended: { kind: 'serve' | 'rally', result, spin, power, q, second }. */
  onLanded(info) {
    const code = RES[info.result] ?? R_MISS;
    const a = this.agg, g = this.g;
    if (info.kind === 'serve') {
      const w = this.sv;
      if (w.len) { const i = w.at(0); if (w.res[i] === R_PEND) w.res[i] = code; }
      if (this.s.mode === 'match') {
        if (!info.second) { a.firsts++; g.f++; if (code === R_IN) { a.firstIn++; g.fIn++; } } else if (code !== R_IN) { this.lastDoubleFlat = info.spin === 'serve'; }
      }
    } else {
      const w = this.sh;
      if (w.len) {
        const i = w.at(0);
        if (w.res[i] === R_PEND) {
          w.res[i] = code;
          if (code !== R_IN && w.pow[i] >= 0.85 && w.spin[i] <= SP.slice) a.errFull++;
        }
      }
      if (code === R_NET) a.errNet++; else if (code === R_LONG) a.errLong++; else if (code === R_WIDE) a.errWide++;
      if (code >= R_NET && code <= R_WIDE) g.pErr[code]++;
    }
    if (this.s.mode === 'drill') this._rep.res = code;
  }

  /** The point is decided (match). info is reused by the session: copy what we keep. */
  onPointEnd(info) {
    const s = this.s, w = this.pt, i = w.add(), a = this.agg, g = this.g;
    const won = info.winner === 0;
    const why = WHY[info.why] || 0;
    w.won[i] = won ? 1 : 0; w.why[i] = why; w.hitter[i] = info.hitter;
    w.pnet[i] = info.playerNet ? 1 : 0; w.rnet[i] = info.rafaNet ? 1 : 0;
    w.shot[i] = SP[info.shot] ?? -1; w.rally[i] = info.rally || 0;
    const noSwing = !won && info.hitter === 1 && (why === Y_WINNER || why === Y_ACE) && this.awaitSwing && this.reachable && !info.miss;
    w.noswing[i] = noSwing ? 1 : 0;
    this.pts++;
    if (noSwing) a.noSwing++;
    if (!won && info.hitter === 1 && why === Y_ACE) { a.aced++; g.aced++; }
    if (why === Y_DOUBLE && info.hitter === 0) { a.doubles++; g.dbl++; }
    if (info.playerNet) {
      a.netN++; if (won) a.netWon++;
      else if (info.hitter === 1 && why === Y_WINNER) { if (info.shot === 'lob') a.lobbed++; else a.passed++; }
    }
    if (this.pressKind) { a.bigN++; if (won) a.bigWon++; }
    if (info.stamina < 0.3) a.lowStam++;
    g.pts[won ? 0 : 1]++; g.server = info.server;
    if (won && info.hitter === 0) { if (why === Y_WINNER) g.pWin++; else if (why === Y_ACE) g.pAce++; }
    if (!won && info.hitter === 1 && (why === Y_WINNER || why === Y_ACE)) g.rWin++;
    this.streak = won ? Math.max(1, this.streak + 1) : Math.min(-1, this.streak - 1);
    this.awaitSwing = false; this.reachable = false;
    this._praise(info, won, why);
  }

  /** A game (or set) ended: remember it for the changeover line at the next between(). */
  onGame(ev) {
    this.changeover = true;
    this.coGame = ev.gameWinner;
    this.coSet = ev.set ? ev.setWinner : -1;
    this.pressSaid = false;
  }

  /** The next point / drill rep is set up; the ball is dead. The best moment to talk. */
  between(info) {
    if (!info) return;
    if (info.drill) { this._betweenDrill(info); return; }
    const s = this.s, sc = s.score;
    const pr = sc && sc.pressure ? sc.pressure() : null;
    this.pressKind = pr && pr.kind !== 'game' ? (pr.for === 0 ? 1 : 2) : 0;
    this.pressWhat = this.pressKind ? pr.kind : '';
    if (info.first) { this.lastSayT = s.t; return; }
    // The umpire call ("30–15") was just said: let it be read first
    const call = !info.second && sc && (sc.tiebreak || sc.pts[0] + sc.pts[1] > 0);
    const delay = call ? 0.9 : 0.2;
    if (call) this.lastSayT = s.t;
    this._choose(delay, s.srv && s.srv.who === 0, !!info.second);
  }

  /** A drill ball landed in: { hit, pts, type }. */
  onDrillLanded(info) {
    const s = this.s, r = this._rep, f = s.frame, fl = s.fl;
    r.landed = 1; r.hit = info.hit ? 1 : 0;
    if (f && fl) { r.u = f.lu(fl.landX, fl.landZ); r.d = Math.abs(f.lv(fl.landX, fl.landZ)); }
  }

  /** Every frame: first-time how-tos at the exact moment, who-hit tracking, pending lines. */
  update(dt) {
    const s = this.s;
    if (!s || !s.active) return;
    const ph = s.phase;
    if (ph === 'menu' || ph === 'results' || !s.mode) { this.next.due = INF; this.next.prio = 0; return; }
    const t = s.t;
    // A new flight: who hit it?
    const rs = s.rallyShots;
    if (rs !== this._lastRS) {
      if (rs > this._lastRS && s.fl && s.fl.active) this._onFlight(s.fl.hitter, s.fl.kind);
      this._lastRS = rs;
    }
    // Ball coming to you: was it within reach at some point?
    const inc = s._incoming ? s._incoming() : false;
    if (inc && s.pl.idealD < 0.95) this.reachable = true;
    // First-time how-tos, right when they matter
    if (inc && !this.seen.charge && t - this.lastSayT > 1.0) this._howto('charge', 0);
    else if (ph === 'serve' && s.srv.who === 0 && !s.srv.started && !this.seen.serve && t - this.lastSayT > 2.2) this._howto('serve', 0);
    // A pending line whose moment has come
    const n = this.next;
    if (n.due <= t) {
      // Tips wait for a dead ball: not during a rally, a loaded stroke or your toss
      const live = ph === 'rally' || ph === 'feeding' || s.chg.on || (ph === 'serve' && s.srv.started);
      if (n.prio < P_HOWTO && live) {
        if (t - n.queuedAt > 6) { n.due = INF; n.prio = 0; } // stale: the moment has passed
        else n.due = t + 0.25;
      } else {
        n.due = INF;
        if (t - this.lastSayT < 1.2 && n.prio < P_HOWTO) n.due = this.lastSayT + 1.2; // let the last line be read
        else { n.prio = 0; this._speak(n.text, n.short, n.sec, n.kind); }
      }
    }
  }

  /** Rafa is talking, or about to (the session holds his serve until he is done). */
  talking() {
    const t = this.s.t;
    return this.next.due < t + 1.5 || t - this.lastSayT < 1.6;
  }

  /** 1–3 concrete lessons for the results card. */
  summary() {
    const a = this.agg, s = this.s, st = s.stats || {};
    const C = [];
    const add = (score, cat, text) => { if (score > 0) C.push({ score: Math.min(score, 3), cat, text }); };
    const P = [];
    const pos = (score, text) => { if (score > 0) P.push({ score, text }); };
    const drill = s.mode === 'drill' || this.mode === 'drill';
    const dtype = drill ? (this.detail && this.detail.type) || (s.drill && s.drill.type) : '';
    // Timing (a swing that went by itself because SWING was held too long is a late one)
    const cats = {};
    const swings = a.eN + a.whiffFar + a.whiffLate + a.whiffEarly;
    if (a.eN >= 6) {
      const m = a.eSum / a.eN;
      if (m > 0.03) {
        cats.timingIssue = true;
        add(1 + (m - 0.03) / 0.02, 'timing', a.forced >= Math.max(3, swings * 0.25)
          ? `Let go sooner: ${this.ms(m)} ms late on average, ${a.forced} swings held too long.`
          : `Release a touch earlier: you were ${this.ms(m)} ms late on average.`);
      } else if (m < -0.03) {
        cats.timingIssue = true;
        add(1 + (-m - 0.03) / 0.02, 'timing', `Hold a touch longer: you let go ${this.ms(m)} ms early on average.`);
      }
    }
    if (a.whiffFar >= 2) add(0.8 + a.whiffFar * 0.3, 'feet', `${a.whiffFar} swings were out of reach. Feet first, then the swing.`);
    if (a.noSwing >= 2) add(1 + a.noSwing * 0.35, 'swing', `${a.noSwing} balls went by without a swing. Press SWING as I hit.`);
    if (a.forced >= 3) add(0.8 + 2 * a.forced / Math.max(1, swings), 'timing', `You held too long ${a.forced} times. Let go when the ring turns green.`);
    // Power
    if (a.powN >= 6 && a.powSum / a.powN < 0.25) add(1.3, 'power', `Load your swings: your average hold was only ${this.pct(a.powSum / a.powN)}% power.`);
    const errs = a.errNet + a.errLong + a.errWide;
    if (a.errFull >= 3 && a.errFull >= errs * 0.6) add(1 + a.errFull * 0.15, 'power', `Ease off: ${a.errFull} of your ${errs} errors came at full power.`);
    // Error type
    if (errs >= 4) {
      if (a.errNet >= errs * 0.5) add(0.9 + a.errNet * 0.12, 'errors', `Most misses went into the net (${a.errNet}). Aim deeper, use topspin (2).`);
      else if (a.errLong >= errs * 0.5) add(0.9 + a.errLong * 0.12, 'errors', `${a.errLong} balls flew long. Less load, or more topspin (2).`);
      else if (a.errWide >= errs * 0.5) add(0.9 + a.errWide * 0.12, 'errors', `${a.errWide} balls went wide. Aim a meter inside the lines.`);
    }
    // Serve
    if (a.firsts >= 6) {
      const f = a.firstIn / a.firsts;
      if (f < 0.55) add(1 + (0.55 - f) * 3, 'serve', `First serves in: ${this.pct(f)}%. Kick (2) is safer than flat.`);
      else if (f >= 0.7) pos(1 + f, `${this.pct(f)}% first serves in. That puts pressure on me.`);
    }
    if (a.doubles >= 2) add(1 + a.doubles * 0.25, 'serve2', `${a.doubles} double faults. Kick the second serve (2), aim middle.`);
    if (a.svEN >= 4) {
      const m = a.svESum / a.svEN;
      if (m > 0.05) add(0.9 + (m - 0.05) * 8, 'serve3', `On the serve, let go sooner: ${this.ms(m)} ms late on average.`);
      else if (m < -0.05) add(0.9 + (-m - 0.05) * 8, 'serve3', `On the serve, wait for the toss: ${this.ms(m)} ms early on average.`);
    }
    // Feet, variety, net, big points, legs
    if (a.onRun >= 5 && a.onRun >= a.contacts * 0.3) add(0.9, 'feet', `${a.onRun} shots on the run. Get there early and set your feet.`);
    if (!drill && a.contacts >= 12) {
      let top = 0, k = 0;
      for (let j = 0; j < 6; j++) if (a.spinN[j] > top) { top = a.spinN[j]; k = j; }
      if (top / a.contacts >= 0.85) {
        add(0.7, 'variety', k === SP.flat ? `${this.pct(top / a.contacts)}% flat. Topspin (2) is safer, slice (3) stays low.`
          : `You hit ${this.pct(top / a.contacts)}% ${SP_LABEL[k]}. Mix in slice (3) and the drop (5).`);
      }
    }
    if (a.netN >= 3 && a.netWon / a.netN < 0.4) {
      add(0.8, 'net', a.lobbed >= 2 && a.lobbed > a.passed
        ? `Net points: won ${a.netWon} of ${a.netN}, lobbed ${a.lobbed} times. Stay a step back.`
        : `Net points: won ${a.netWon} of ${a.netN}. Approach deep, then close in.`);
    }
    else if (a.netN >= 3 && a.netWon / a.netN >= 0.6) pos(1.1, `Net points: ${a.netWon} of ${a.netN}. Keep coming in.`);
    if (a.bigN >= 3 && a.bigWon / a.bigN <= 0.34) add(0.85, 'big', `Big points: won ${a.bigWon} of ${a.bigN}. Deep and safe when it counts.`);
    if (a.lowStam >= 3) add(0.7, 'legs', 'Your legs ran out. Rest between points, shorter rallies.');
    if (a.aced >= 3) add(0.75, 'return', `${a.aced} of my serves came back untouched. Be ready as I toss.`);
    if (a.volleyN >= 3 && a.volleyPow / a.volleyN > 0.55) add(dtype === 'volley' ? 1.2 : 0.6, 'volley', "Volleys: tap, don't load. A firm, short punch.");
    // Drills
    if (drill && a.dReps >= 5) {
      if (dtype === 'fh' || dtype === 'bh') {
        if (a.dShort >= 3) add(1.1, 'depth', `${a.dShort} balls landed short. Push the stick up at contact.`);
        else if (a.dHits < 3) add(0.9, 'targets', `Targets hit: ${a.dHits} of ${a.dReps}. Aim for the corners with the stick.`);
      } else if (dtype === 'volley' && a.dHits < 3) add(0.9, 'targets', `Targets hit: ${a.dHits} of ${a.dReps}. Angle it short: stick down and wide.`);
      else if (dtype === 'serve' && a.dHits < 3 && a.dIn >= 3) add(0.9, 'targets', 'Serve targets: stick toward the T or out wide as you let go.');
      if (a.dHits >= 5) pos(1.2, `${a.dHits} targets! Now the same in a match.`);
    }
    // Positives
    if (a.eN >= 8 && !cats.timingIssue) {
      const sw = a.eN + a.whiffFar + a.whiffLate + a.whiffEarly;
      if (a.good / sw >= 0.55) pos(0.9 + a.good / sw, `Sharp timing: ${this.pct(a.good / sw)}% of your swings right on time.`);
    }
    if (st.aces && st.aces[0] >= 2) pos(1 + st.aces[0] * 0.1, `Your serve was a weapon: ${st.aces[0]} aces.`);
    if (st.winners && st.winners[0] >= 5) pos(1 + st.winners[0] * 0.05, `${st.winners[0]} winners. You can hurt me from the back.`);
    if (st.longest >= 12) pos(0.8, `A ${st.longest}-shot rally. Your legs are good.`);

    C.sort((x, y) => y.score - x.score);
    P.sort((x, y) => y.score - x.score);
    const out = [];
    const maxIssues = P.length ? 2 : 3;
    for (const c of C) {
      if (out.length >= maxIssues) break;
      if (cats[c.cat]) continue;
      cats[c.cat] = 1;
      out.push(c.text);
    }
    if (P.length && out.length < 3) out.push(P[0].text);
    if (!out.length) out.push(drill ? 'Clean work. Tomorrow we add pace.' : 'Good session. Same time tomorrow?');
    return out;
  }

  // ─────────────────────────── choosing what to say ───────────────────────────

  _tipsOn() { const o = this.s.opts; return !o || o.tips !== false; }

  modeBit() {
    const s = this.s;
    if (s.mode === 'match') return M_MATCH;
    if (s.mode === 'drill') {
      const t = s.drill && s.drill.type;
      return t === 'serve' ? M_SRV : t === 'volley' ? M_VOL : t === 'rally' ? M_RD : M_GS;
    }
    return 0;
  }

  /** The drill ended: file the last rep (no line — the results card follows). */
  onDrillEnd() { this._fileRep(); }

  _betweenDrill(info) {
    const s = this.s;
    if (!info.first) this._fileRep();
    this._resetRep();
    if (info.first) { this.lastSayT = s.t; return; }
    this._choose(0.3, s.drill && s.drill.type === 'serve', false);
  }

  _fileRep() {
    const s = this.s, r = this._rep, a = this.agg;
    if (r.filed) return;
    r.filed = 1;
    {
      // One rep done: file it
      const w = this.dl, i = w.add();
      const type = s.drill ? s.drill.type : '';
      let kind = -1;
      if (r.landed && !r.hit) {
        if (type === 'fh' || type === 'bh') kind = r.d < 8.6 ? 0 : Math.abs(r.u) < 1.9 ? 1 : -1;
        else if (type === 'volley') kind = r.d > 5.8 && Math.abs(r.u) < 2.4 ? 2 : -1;
        else if (type === 'serve') kind = 3;
      }
      // A reachable ball that went by without a swing
      const ns = type !== 'serve' && !r.swung && this.reachable ? 1 : 0;
      w.kind[i] = kind; w.hit[i] = r.hit; w.u[i] = r.u; w.d[i] = r.d; w.res[i] = r.res; w.swung[i] = r.swung; w.ns[i] = ns;
      a.dReps++; if (r.hit) a.dHits++; if (r.landed) a.dIn++;
      if (kind === 0) a.dShort++;
      if (ns) a.noSwing++;
      this.pts++;
    }
  }

  _resetRep() {
    const r = this._rep;
    r.swung = 0; r.hit = 0; r.landed = 0; r.res = R_PEND; r.u = 0; r.d = 0; r.filed = 0;
    this.reachable = false; this.awaitSwing = false;
  }

  /**
   * Pick at most one line for this dead ball. Order: the changeover summary, noticing a fix,
   * a first-time how-to that fits now, a big point, then the most useful fix (with a point gap
   * that grows when you play well), else a little encouragement when it is going badly.
   */
  _choose(delay, pServe, second) {
    const s = this.s;
    if (!this._tipsOn()) {
      if (this.changeover) { this.changeover = false; this._resetGame(); }
      return;
    }
    if (this.changeover) {
      this.changeover = false;
      this._coIssue = false;
      const L = this._changeoverLine();
      this._resetGame();
      if (L) {
        this._queue(L[0], L[1], delay, P_CHANGE, 'change');
        this.linePt = this.pts;
        if (this._coIssue) { this.tipPt = this.pts; this.tipT = s.t; }
        return;
      }
    }
    // One line per point at most (praise counts), then a quiet point unless you fixed something
    // or a first-time how-to fits right now
    if (this.linePt === this.pts) return;
    if (this._checkBetter(delay)) return;
    if (second && pServe && !this.seen.kick && s.mode === 'match') { this._howto('kick', delay); return; }
    if (this.pts - this.linePt < 2) return;
    if (this._situationalHowto(delay, pServe, second)) return;
    const drill = s.mode === 'drill';
    const well = this._doingWell(), bad = this._struggling();
    // A big point: a word on how to play it (once per game)
    if (this.pressKind && !this.pressSaid && !drill && Math.random() < 0.55) {
      const L = this._pressureLine(pServe);
      if (L) { this.pressSaid = true; this._queue(L[0], L[1], delay, P_PRESS, 'press'); this.linePt = this.pts; return; }
    }
    // The fix: every 3 points (2 when it is going badly, 5 when it is going well)
    const gap = drill ? (well ? 4 : 2) : well ? 5 : bad ? 2 : 3;
    const gapT = drill ? (well ? 16 : 7) : well ? 25 : 12;
    if (this.pts - this.tipPt < gap || s.t - this.tipT < gapT) return;
    const st = this._topIssue(pServe);
    if (st) {
      const L = this._raise(st);
      if (L) { this._queue(L[0], L[1], delay, P_TIP, 'tip'); this.tipPt = this.pts; this.tipT = s.t; this.linePt = this.pts; return; }
    }
    if (bad && this.pts - this.encPt >= 8 && this.pts - this.tipPt >= 3) {
      this.encPt = this.pts;
      const L = this.pk(ENCOURAGE[0], ENCOURAGE[1]);
      this._queue(L[0], L[1], delay, P_PRAISE, 'encourage');
      this.linePt = this.pts;
    }
  }

  _topIssue(pServe) {
    const mb = this.modeBit();
    const match = mb === M_MATCH;
    let best = null, bestV = 0;
    for (const st of this.iss) {
      const d = st.def;
      if (!(d.modes & mb)) continue;
      if (match && d.when === 'p' && !pServe) continue;
      if (match && d.when === 'r' && pServe) continue;
      // Said before and not fixed yet? Wait longer each time: no nagging, other things get a turn
      if (this.pts - st.lastPt < (d.cool || 4) * (1 + 0.5 * st.rep)) continue;
      if (d.src !== 'none' && this._fresh(st) < (d.fresh || 3)) continue;
      const sv = d.sev(this);
      if (!(sv >= 1)) continue;
      const v = Math.min(sv, 3) * d.w;
      if (v > bestV) { bestV = v; best = st; }
    }
    return best;
  }

  /** Say an issue: first time level 0, again (not fixed yet) one level more concrete. */
  _raise(st) {
    const d = st.def, top = d.lines.length - 1;
    st.rep = st.raised ? st.rep + 1 : 0;
    if (!st.raised) st.level = 0;
    else if (st.level < top) st.level++;
    else if (top >= 2) st.level = st.level === top ? top - 1 : top; // still not fixed: alternate the concrete fixes
    let L = this._line(d.lines[st.level]);
    if (L && L[0] === this.lastText) {
      // Never the same line twice in a row: try the next level, else skip
      const alt = d.lines[Math.min(st.level + 1, d.lines.length - 1)];
      L = this._line(alt);
      if (!L || L[0] === this.lastText) return null;
    }
    st.raised = true; st.at = this._srcTotal(d.src); st.lastPt = this.pts; st.times++;
    return L;
  }

  _line(variants) {
    if (!variants || !variants.length) return null;
    let k = Math.floor(Math.random() * variants.length);
    for (let j = 0; j < variants.length; j++) {
      const v = variants[(k + j) % variants.length];
      const L = typeof v === 'function' ? v(this) : v;
      if (L && L[0] !== this.lastText) return L;
      if (j === variants.length - 1) return L;
    }
    return null;
  }

  /** You fixed something Rafa told you about: say so (once per fix). */
  _checkBetter(delay) {
    const mb = this.modeBit();
    if (this.pts - this.betterPt < 4) return false;
    for (const st of this.iss) {
      const d = st.def;
      if (!st.raised || !d.better || !(d.modes & mb)) continue;
      // Praised once already and it came back? Want far more evidence this time (no flip-flopping)
      if (st.improved >= 2) continue;
      const n = this._fresh(st);
      if (n < (st.improved ? 12 : 3) || !d.better(this, n)) continue;
      st.raised = false; st.level = 0; st.rep = 0; st.improved++;
      const L = this._line(d.betterLines);
      if (!L) continue;
      this._queue(L[0], L[1], delay, P_BETTER, 'better');
      this.linePt = this.pts; this.betterPt = this.pts;
      return true;
    }
    return false;
  }

  _situationalHowto(delay, pServe, second) {
    const s = this.s, mb = this.modeBit(), sn = this.seen;
    if (mb === M_MATCH) {
      const w = this.pt;
      if (!sn.lob && w.len && w.rnet[w.at(0)]) return this._howto('lob', delay);
      if (!sn.drop && this.sh.len) {
        const i = this.sh.at(0);
        if (this.sh.fromNet[i] < 8.5 && this.sh.rafaD[i] > 11.5 && !(this.sh.f[i] & F_VOLLEY)) return this._howto('drop', delay);
      }
      if (!sn.zone && s.momentum && s.momentum[0] >= 0.7) return this._howto('zone', delay);
      if (!sn.tired && s.pl && s.pl.stamina < 0.35) return this._howto('tired', delay);
    } else if (mb === M_GS && !sn.drill_gs) return this._howto('drill_gs', delay);
    else if (mb === M_VOL && !sn.drill_volley) return this._howto('drill_volley', delay);
    else if (mb === M_SRV && !sn.drill_serve) return this._howto('drill_serve', delay);
    else if (mb === M_RD && !sn.drill_rally) return this._howto('drill_rally', delay);
    // Never uses the stick to aim?
    if (!sn.aim && (mb & (M_MATCH | M_GS)) && this.sh.len >= 5) {
      let still = 0;
      for (let j = 0; j < 5; j++) if (Math.abs(this.sh.aimX[this.sh.at(j)]) < 0.3) still++;
      if (still >= 5) return this._howto('aim', delay);
    }
    return false;
  }

  _pressureLine(pServe) {
    const k = this.pressKind, w = this.pressWhat;
    if (k === 1) return this._line(w === 'match' ? PRESSURE.forMatch : w === 'set' ? PRESSURE.forSet : PRESSURE.forBreak);
    if (k === 2) return this._line(pServe ? (w === 'break' ? PRESSURE.vsServeBreak : PRESSURE.vsServe) : PRESSURE.vsReturn);
    return null;
  }

  /**
   * After a game: who won it and the one stat that decided it. Candidates in order of interest;
   * the same kind of line is never used for two changeovers running, and when you are playing
   * well an unremarkable game you won passes without a word.
   */
  _changeoverLine() {
    const g = this.g, s = this.s;
    if (this.coSet >= 0) {
      return this.coSet === 0 ? this.pk(['Set to you! Vamos. Same plan now.', 'Set to you!'], ['Your set! Bueno. Stay hungry.', 'Your set!'])
        : this.pk(['My set. Bueno, we go again. Fresh start.', 'My set.'], ['Set to me. Breathe, and start strong.', 'New set!']);
    }
    const C = [];
    const cand = (type, L) => { C.push(type, L); };
    const pServed = g.server === 0;
    const n = g.pErr[R_NET], l = g.pErr[R_LONG], wd = g.pErr[R_WIDE], errs = n + l + wd;
    if (this.coGame === 0) {
      if (!pServed) cand('break', this.pk(['You broke me! Now hold your serve.', 'Break!'], ['Break! Now consolidate, amigo.', 'Break!']));
      if (g.pAce >= 2 && g.pAce >= g.pWin) cand('aces', this.pk([`Your game! ${g.pAce} aces. What a serve.`, 'Your game!'], [`Held with ${g.pAce} aces. I need glasses.`, 'Held!']));
      if (g.pWin >= 2) cand('winners', this.pk([`Your game! ${g.pWin} winners. Keep attacking.`, 'Your game!'], [`${g.pWin} winners that game. Vamos!`, 'Vamos!']));
      if (pServed && g.f >= 3 && g.fIn / g.f >= 0.75) cand('first', [`Held! ${this.pct(g.fIn / g.f)}% first serves in. Bueno.`, 'Held!']);
      if (errs === 0 && g.pts[0] + g.pts[1] >= 4) cand('clean', ['Your game, and no errors. That is how.', 'Your game!']);
      const quiet = this._doingWell() && Math.random() < 0.5;
      for (let i = 0; i < C.length; i += 2) if (!this._coRecent(C[i]) && (!quiet || C[i] === 'break')) return this._coUse(C[i], C[i + 1]);
      if (quiet || this._coRecent('won')) return null;
      return this._coUse('won', this.pk(['Your game. Bueno.', 'Your game.'], ['Your game. Keep the ball deep.', 'Your game.']));
    }
    if (pServed && g.dbl >= 1) cand('dbl', [`My game. ${g.dbl === 1 ? 'A double fault' : `${g.dbl} double faults`}: kick the second, 2.`, 'Kick, 2!']);
    if (n >= 2 && n >= l && n >= wd) cand('net', [`My game. ${n} balls in the net: more height.`, 'More height!']);
    if (l >= 2 && l >= wd) cand('long', [`My game. ${l} long: less load, more topspin.`, 'Less load!']);
    if (wd >= 2) cand('wide', [`My game. ${wd} wide: aim inside the lines.`, 'Aim inside!']);
    if (!pServed && g.aced >= 1) cand('aced', this.pk(['My game. My serve worked. Be ready on the return.', 'Be ready!'], [`My game. ${g.aced > 1 ? `${g.aced} aces` : 'An ace'} from me. Read my toss.`, 'Read my toss!']));
    if (g.rWin >= 2) cand('rwin', [`My game. ${g.rWin} winners from me: push me back, deeper.`, 'Deeper!']);
    if (pServed) cand('broken', this.pk(['I broke you. Next game, first serves in.', 'First serves in!'], ['Broken. Hold the next one: kick, 2, is safe.', 'Hold the next!']));
    for (let i = 0; i < C.length; i += 2) if (!this._coRecent(C[i])) return this._coUse(C[i], C[i + 1]);
    // Nothing new stood out: the current top issue, if any
    const st = this._topIssue(s.srv && s.srv.who === 0);
    if (st) {
      const L = this._raise(st);
      if (L) { this._coIssue = true; return this._coUse('issue', [`My game. ${L[0]}`.length <= 70 ? `My game. ${L[0]}` : L[0], L[1]]); }
    }
    if (this._coRecent('lost')) return null;
    return this._coUse('lost', this.pk(['My game. The next one is yours.', 'Next one!'], ['My game. Stay with me.', 'Stay with me!']));
  }

  /** Was this kind of changeover line used in the last three changeovers? */
  _coRecent(type) { const h = this._coHist; return h[0] === type || h[1] === type || h[2] === type; }

  _coUse(type, L) {
    const h = this._coHist;
    h[2] = h[1]; h[1] = h[0]; h[0] = type;
    return L;
  }

  /** Quick praise right after a great point (the ball is dead for a moment). */
  _praise(info, won, why) {
    const s = this.s;
    // Only your own winners and aces (Rafa comments on his own errors himself)
    if (!won || info.hitter !== 0 || (why !== Y_WINNER && why !== Y_ACE)) return;
    if (!this._tipsOn() || this.pts - this.praisePt < 4 || this.pts - this.linePt < 2 || s.t - this.lastSayT < 2) return;
    let type = '';
    if (why === Y_ACE) type = 'ace';
    else if (info.shot === 'smash') type = 'smash';
    else if (info.shot === 'drop') type = 'drop';
    else if (info.shot === 'lob' && info.rafaNet) type = 'lob';
    else if (info.rafaNet) type = 'pass';
    else if (info.rally >= 8) type = 'rally';
    else if (this.streak >= 3) type = 'streak';
    else if (Math.random() < 0.35) type = 'winner';
    // The same kind of praise gets old: aces every 10 points at most, the rest every 6
    const last = this._praiseLast || (this._praiseLast = {});
    if (!type || this.pts - (last[type] ?? -99) < (type === 'ace' || type === 'winner' ? 10 : 6) || Math.random() > 0.65) return;
    // Rotate through the variants (a random start per session)
    const list = PRAISE[type], rot = this._praiseRot || (this._praiseRot = {});
    const k = rot[type] = ((rot[type] ?? Math.floor(Math.random() * list.length)) + 1) % list.length;
    const L = list[k];
    last[type] = this.pts;
    this.praisePt = this.pts; this.linePt = this.pts;
    this._speak(L[0], L[1], 1.8, 'praise');
  }

  /** Show a how-to line once (localStorage + this session). delay 0 = now. */
  _howto(id, delay) {
    const L = HOWTO[id];
    if (!L || this.seen[id]) return false;
    if (!ESSENTIAL[id] && !this._tipsOn()) return false;
    this._markSeen(id);
    if (delay > 0) { this._queue(L[0], L[1], delay, ESSENTIAL[id] ? P_ESSENTIAL : P_HOWTO, 'howto'); this.linePt = this.pts; } else this._speak(L[0], L[1], 3.2, 'howto');
    return true;
  }

  _queue(text, short, delay, prio, kind) {
    const n = this.next;
    if (n.due < INF && n.prio > prio) return;
    n.text = text; n.short = short; n.prio = prio; n.kind = kind;
    n.sec = clamp(1.6 + text.length * 0.034, 2.2, 3.8);
    n.due = this.s.t + delay;
    n.queuedAt = this.s.t;
  }

  _speak(text, short, sec, kind) {
    const s = this.s;
    this.lastText = text;
    this.lastSayT = s.t;
    if (this.log) this.log.push({ t: +s.t.toFixed(2), kind, text, pt: this.pts });
    // A how-to or reply replaces any pending lesser line
    if (kind === 'howto' || kind === 'reply') { this.next.due = INF; this.next.prio = 0; }
    s._say(text, sec, short);
  }

  // ─────────────────────────── bookkeeping ───────────────────────────

  _onFlight(hitter, kind) {
    const s = this.s;
    if (hitter !== 1) return;
    // Rafa just hit: you have a ball to play (was it reachable, did you swing?)
    this.awaitSwing = true; this.reachable = false;
    if (kind === 'rally' && s.mode === 'match' && s.pl) {
      const w = this.rh, i = w.add();
      w.u[i] = Math.abs(s.pl.u); w.d[i] = s.pl.v * s.sides[0];
    }
  }

  _resetGame() {
    const g = this.g;
    g.pts[0] = g.pts[1] = 0; g.pErr.fill(0); g.pWin = 0; g.pAce = 0; g.rWin = 0; g.dbl = 0; g.aced = 0; g.f = 0; g.fIn = 0; g.server = -1;
  }

  _doingWell() {
    const s = this.s;
    if (s.mode === 'drill') {
      const w = this.dl; const n = Math.min(4, w.len);
      if (n < 3) return false;
      let ok = 0;
      for (let j = 0; j < n; j++) { const i = w.at(j); if (w.hit[i] || w.res[i] === R_IN) ok++; }
      return ok >= n;
    }
    const n = Math.min(5, this.pt.len);
    if (n < 4) return false;
    const won = n - this.ptLost(n);
    return won >= 4 || (won >= 3 && s.momentum && s.momentum[0] > 0.5);
  }

  _struggling() {
    const s = this.s;
    if (s.mode === 'drill') {
      const w = this.dl; const n = Math.min(3, w.len);
      if (n < 3) return false;
      let bad = 0;
      for (let j = 0; j < n; j++) { const i = w.at(j); if (!w.hit[i] && w.res[i] !== R_IN) bad++; }
      return bad >= 3;
    }
    const n = Math.min(5, this.pt.len);
    return (n >= 4 && this.ptLost(n) >= 4) || !!(s.momentum && s.momentum[1] > 0.5);
  }

  _srcTotal(src) {
    const w = this[typeof src === 'function' ? src(this) : src];
    return w instanceof Win ? w.total : 0;
  }

  _fresh(st) { return this._srcTotal(st.def.src) - st.at; }

  _loadSeen() {
    try {
      const raw = storageGet(STORE_KEY);
      const o = raw ? JSON.parse(raw) : null;
      if (o && o.seen && typeof o.seen === 'object') for (const k in o.seen) if (HOWTO[k] && o.seen[k]) this.seen[k] = true;
    } catch (e) { /* first time, or storage blocked: per session only */ }
  }

  _markSeen(id) {
    if (this.seen[id]) return;
    this.seen[id] = true;
    try { storageSet(STORE_KEY, JSON.stringify({ v: 1, seen: this.seen })); } catch (e) { /* per session only */ }
  }

  // ─────────────────────────── window statistics (used by ISSUES) ───────────────────────────

  /** One of two [text, bubble] variants, never the line just said. */
  pk(a, b) {
    let x = Math.random() < 0.5 ? a : b;
    if (x[0] === this.lastText) x = x === a ? b : a;
    return x;
  }
  ms(x) { return Math.round(Math.abs(x) * 100) * 10; }
  pct(x) { return Math.round(clamp(x, 0, 1) * 100); }
  swN(n) { return Math.min(n, this.sw.len); }

  /** Mean timing error (s, + late) of the newest n swings; out-of-reach whiffs excluded. NaN if < 3. */
  meanE(n) {
    const w = this.sw, m = Math.min(n, w.len);
    let s = 0, k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.f[i] & F_FAR) continue; s += w.e[i]; k++; }
    return k >= 3 ? s / k : NaN;
  }

  meanAbsE(n) {
    const w = this.sw, m = Math.min(n, w.len);
    let s = 0, k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.f[i] & F_FAR) continue; s += Math.abs(w.e[i]); k++; }
    return k >= 3 ? s / k : NaN;
  }

  meanPow(n) {
    const w = this.sw, m = Math.min(n, w.len);
    let s = 0;
    for (let j = 0; j < m; j++) s += w.pow[w.at(j)];
    return m >= 3 ? s / m : NaN;
  }

  /** Mean load of the newest n swings that were out of reach or stretched (NaN if none). */
  farPow(n) {
    const w = this.sw, m = Math.min(n, w.len);
    let s = 0, k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.f[i] & (F_FAR | F_STRETCH)) { s += w.pow[i]; k++; } }
    return k ? s / k : NaN;
  }

  swCount(flag, n) {
    const w = this.sw, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) if (w.f[w.at(j)] & flag) k++;
    return k;
  }

  /** Mean load of your newest n groundstrokes (flat / topspin / slice, not volleys). */
  groundPow(n) {
    const w = this.sh, m = Math.min(n, w.len);
    let s = 0, k = 0;
    for (let j = 0; j < m; j++) {
      const i = w.at(j);
      if (w.spin[i] > SP.slice || (w.f[i] & F_VOLLEY)) continue;
      s += w.pow[i]; k++;
    }
    return k >= 4 ? s / k : NaN;
  }

  shSettled(n) {
    const w = this.sh, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) if (w.res[w.at(j)] >= R_IN) k++;
    return k;
  }

  shRes(code, n) {
    const w = this.sh, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) if (w.res[w.at(j)] === code) k++;
    return k;
  }

  shErr(n) { return this.shRes(R_NET, n) + this.shRes(R_LONG, n) + this.shRes(R_WIDE, n); }

  /** How strongly error type `code` stands out in your last 8 shots (≥ 1: say it). */
  errSev(code) {
    if (this.shSettled(8) < 4) return 0;
    const k = this.shRes(code, 8);
    return k < 3 ? 0 : 1 + (k - 3) * 0.5;
  }

  /** The shot type most of your recent `code` errors were hit with. */
  errSpin(code) {
    const w = this.sh, m = w.len, cnt = this._spinCnt || (this._spinCnt = new Float32Array(6));
    cnt.fill(0);
    for (let j = 0; j < Math.min(8, m); j++) { const i = w.at(j); if (w.res[i] === code) cnt[w.spin[i]]++; }
    let best = -1, bk = 0;
    for (let k = 0; k < 6; k++) if (cnt[k] > bk) { bk = cnt[k]; best = k; }
    return bk >= 2 ? best : -1;
  }

  errPow(code) {
    const w = this.sh, m = Math.min(8, w.len);
    let s = 0, k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.res[i] === code) { s += w.pow[i]; k++; } }
    return k ? s / k : 0;
  }

  /** Share of the most used shot type over the whole match / drill. */
  matchShare() {
    const a = this.agg;
    let top = 0;
    for (let k = 0; k < 6; k++) if (a.spinN[k] > top) top = a.spinN[k];
    return a.contacts ? top / a.contacts : 0;
  }

  /** Share of the most used shot type among the newest n contacts (sets _topSpin). */
  topShare(n) {
    const w = this.sh, m = Math.min(n, w.len), cnt = this._spinCnt || (this._spinCnt = new Float32Array(6));
    if (m < 6) return 0;
    cnt.fill(0);
    for (let j = 0; j < m; j++) cnt[w.spin[w.at(j)]]++;
    let bk = 0;
    for (let k = 0; k < 6; k++) if (cnt[k] > bk) { bk = cnt[k]; this._topSpin = k; }
    return bk / m;
  }

  /** Your recent volleys: count, mean load, errors, from far (> 6 m), half volleys. */
  volleyStats(n) {
    const w = this.sh, m = Math.min(n, w.len), o = this._vs || (this._vs = { n: 0, pow: 0, err: 0, far: 0, half: 0 });
    o.n = 0; o.pow = 0; o.err = 0; o.far = 0; o.half = 0;
    for (let j = 0; j < m; j++) {
      const i = w.at(j);
      if (!(w.f[i] & F_VOLLEY) || w.spin[i] === SP.smash) continue;
      o.n++; o.pow += w.pow[i];
      if (w.res[i] > R_IN) o.err++;
      if (w.fromNet[i] > 6.2) o.far++;
      if (w.f[i] & F_HALF) o.half++;
    }
    if (o.n) o.pow /= o.n;
    return o;
  }

  shotsWhere(spin, minFromNet, n) {
    const w = this.sh, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.spin[i] === spin && w.fromNet[i] > minFromNet) k++; }
    return k;
  }

  /** Lobs hit while Rafa stood at the back (no one at the net to lob). */
  lobsVsDeep(n) {
    const w = this.sh, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.spin[i] === SP.lob && w.rafaD[i] > 10) k++; }
    return k;
  }

  svMeanE(n) {
    const w = this.sv, m = Math.min(n, w.len);
    let s = 0, k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.res[i] === R_MISS) continue; s += w.e[i]; k++; }
    return k >= 3 ? s / k : NaN;
  }

  svRes(code, n) {
    const w = this.sv, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) if (w.res[w.at(j)] === code) k++;
    return k;
  }

  svFaults(n) { return this.svRes(R_NET, n) + this.svRes(R_LONG, n) + this.svRes(R_WIDE, n) + this.svRes(R_CTR, n) + this.svRes(R_MISS, n); }

  /** First-serve percentage over the newest n first serves (count in _n). */
  firstIn(n) {
    const w = this.sv;
    let k = 0, inn = 0;
    for (let j = 0; j < w.len && k < n; j++) {
      const i = w.at(j);
      if (w.second[i] || w.res[i] < R_IN) continue;
      k++; if (w.res[i] === R_IN) inn++;
    }
    this._n = k;
    return k ? inn / k : 0;
  }

  /** Second serves in among the newest n serves. */
  secondsIn(n) {
    const w = this.sv, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.second[i] && w.res[i] === R_IN) k++; }
    return k;
  }

  recentDoubles(n) {
    const w = this.pt, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.why[i] === Y_DOUBLE && w.hitter[i] === 0) k++; }
    return k;
  }

  /** Reachable balls you let go by without a swing (last 6 points / last 4 drill reps). */
  noSwingCount(n) {
    const drill = this.s.mode === 'drill';
    const w = drill ? this.dl : this.pt, m = Math.min(n || (drill ? 4 : 6), w.len), col = drill ? w.ns : w.noswing;
    let k = 0;
    for (let j = 0; j < m; j++) if (col[w.at(j)]) k++;
    return k;
  }

  ptLost(n) {
    const w = this.pt, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) if (!w.won[w.at(j)]) k++;
    return k;
  }

  /** Points lost with `why` from `hitter`'s shot among the newest n. */
  ptCountWhy(why, hitter, n) {
    const w = this.pt, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.why[i] === why && w.hitter[i] === hitter && !w.won[i]) k++; }
    return k;
  }

  /** At the net and beaten by a winner: lob (1) or a pass (0), last 8 points. */
  ptNet(lob) {
    const w = this.pt, m = Math.min(8, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) {
      const i = w.at(j);
      if (!w.pnet[i] || w.won[i] || w.why[i] !== Y_WINNER || w.hitter[i] !== 1) continue;
      if ((w.shot[i] === SP.lob) === !!lob) k++;
    }
    return k;
  }

  ptRafaNet() {
    const w = this.pt, m = Math.min(8, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) { const i = w.at(j); if (w.rnet[i] && !w.won[i]) k++; }
    return k;
  }

  /** Your position when Rafa hit: 0 = pulled wide (> 3 m off centre), 1 = no man's land. */
  rhCount(kind, n) {
    const w = this.rh, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) {
      const i = w.at(j);
      if (kind === 0 ? w.u[i] > 3.0 : w.d[i] > 4.8 && w.d[i] < 9.2) k++;
    }
    return k;
  }

  /** Drill reps of a miss kind (0 short, 1 centre, 2 volley not angled, 3 serve off target). */
  drillLands(kind, n) {
    const w = this.dl, m = Math.min(n, w.len);
    let k = 0;
    for (let j = 0; j < m; j++) if (w.kind[w.at(j)] === kind) k++;
    return k;
  }
}
