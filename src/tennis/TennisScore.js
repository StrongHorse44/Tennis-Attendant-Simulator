/**
 * TennisScore — pure tennis scoring (no THREE, no DOM): points with deuce / advantage,
 * games, sets with a tiebreak, serve rotation (incl. the tiebreak's every-two-points rule)
 * and change of ends. Player 0 = you, player 1 = Coach Rafa.
 *
 *   const s = new TennisScore({ format: 'set', firstServer: 0 });
 *   const ev = s.pointTo(0);   // { game, set, match, tiebreak, changeEnds, winner }
 *   s.server, s.isDeuceSide(), s.pointText(0), s.setLine()
 *
 * Formats: 'short' – one set to 4 games (win by 2, tiebreak at 4–4)
 *          'set'   – one set to 6 games (tiebreak at 6–6)
 *          'bo3'   – best of three sets to 6 (tiebreak at 6–6 in every set)
 * Tiebreak: first to 7, win by 2. Its first point is served by whoever's turn it is, then the
 * serve alternates every two points; the other player serves the first game of the next set.
 * Ends change after every odd game of a set, every 6 tiebreak points and after a set whose
 * game total (the tiebreak counts as one game) is odd.
 */

export const FORMATS = {
  short: { label: 'Short set (to 4)', setsToWin: 1, games: 4 },
  set: { label: '1 set', setsToWin: 1, games: 6 },
  bo3: { label: 'Best of 3', setsToWin: 2, games: 6 },
};

const WORDS = ['0', '15', '30', '40'];

export class TennisScore {
  constructor({ format = 'set', firstServer = 0 } = {}) {
    this.format = FORMATS[format] ? format : 'set';
    const f = FORMATS[this.format];
    this.setsToWin = f.setsToWin;
    this.gamesPerSet = f.games;
    this.sets = [];            // finished sets: [{ g: [a, b], tb: [a, b] | null }]
    this.setsWon = [0, 0];
    this.games = [0, 0];
    this.pts = [0, 0];
    this.tiebreak = false;
    this.tbFirst = 0;
    this.server = firstServer ? 1 : 0;
    this.done = false;
    this.winner = -1;
    this.totalPoints = [0, 0];
    this._ev = { game: false, set: false, match: false, tiebreak: false, changeEnds: false, winner: -1, gameWinner: -1, setWinner: -1 };
  }

  /** Current server for the next point (inside a tiebreak it changes every two points). */
  get currentServer() {
    if (!this.tiebreak) return this.server;
    const k = this.pts[0] + this.pts[1];
    if (k === 0) return this.tbFirst;
    return (Math.floor((k + 1) / 2) % 2 === 0) ? this.tbFirst : 1 - this.tbFirst;
  }

  /** The next point is served from the deuce (right) side. */
  isDeuceSide() { return (this.pts[0] + this.pts[1]) % 2 === 0; }

  /** Break point / set point etc. are left to the caller; this is the plain game state. */
  isDeuce() { return !this.tiebreak && this.pts[0] >= 3 && this.pts[1] >= 3 && this.pts[0] === this.pts[1]; }

  /** Award a point. Returns a reused event object describing what it completed. */
  pointTo(w) {
    const ev = this._ev;
    ev.game = ev.set = ev.match = ev.tiebreak = ev.changeEnds = false;
    ev.winner = w; ev.gameWinner = -1; ev.setWinner = -1;
    if (this.done) return ev;
    this.totalPoints[w]++;
    this.pts[w]++;
    const a = this.pts[w], b = this.pts[1 - w];
    if (this.tiebreak) {
      const n = this.pts[0] + this.pts[1];
      if (a >= 7 && a - b >= 2) {
        this.games[w]++;
        ev.game = true; ev.gameWinner = w;
        this._endSet(w, ev, [this.pts[0], this.pts[1]]);
        this.server = 1 - this.tbFirst;
      } else if (n % 6 === 0) ev.changeEnds = true;
      return ev;
    }
    if (a >= 4 && a - b >= 2) {
      this.games[w]++;
      ev.game = true; ev.gameWinner = w;
      this.pts[0] = this.pts[1] = 0;
      this.server = 1 - this.server;
      const G = this.gamesPerSet;
      const ga = this.games[w], gb = this.games[1 - w];
      if (ga >= G && ga - gb >= 2) {
        this._endSet(w, ev, null);
      } else if (this.games[0] === G && this.games[1] === G) {
        this.tiebreak = true;
        this.tbFirst = this.server;
        ev.tiebreak = true;
        if ((this.games[0] + this.games[1]) % 2 === 1) ev.changeEnds = true;
      } else if ((this.games[0] + this.games[1]) % 2 === 1) ev.changeEnds = true;
    }
    return ev;
  }

  _endSet(w, ev, tb) {
    const total = this.games[0] + this.games[1];
    this.sets.push({ g: [this.games[0], this.games[1]], tb });
    this.setsWon[w]++;
    ev.set = true; ev.setWinner = w;
    if (total % 2 === 1) ev.changeEnds = true;
    this.games[0] = this.games[1] = 0;
    this.pts[0] = this.pts[1] = 0;
    this.tiebreak = false;
    if (this.setsWon[w] >= this.setsToWin) {
      this.done = true;
      this.winner = w;
      ev.match = true;
    }
  }

  /** Point text for one player ('0', '15', '30', '40', 'AD', '' or tiebreak numbers). */
  pointText(i) {
    const a = this.pts[i], b = this.pts[1 - i];
    if (this.tiebreak) return String(a);
    if (a >= 3 && b >= 3) {
      if (a === b) return '40';
      return a > b ? 'AD' : '';
    }
    return WORDS[Math.min(3, a)];
  }

  /** Umpire-style call from the server's point of view ("30–15", "Deuce", "Advantage Rafa"). */
  callText(names = ['You', 'Rafa']) {
    const s = this.currentServer;
    const a = this.pts[s], b = this.pts[1 - s];
    if (this.tiebreak) return `${this.pts[0]}–${this.pts[1]}`;
    if (a === 0 && b === 0) return '';
    if (a >= 3 && b >= 3) {
      if (a === b) return 'Deuce';
      return `Advantage ${names[a > b ? s : 1 - s]}`;
    }
    if (a === b) return `${WORDS[a]}-all`;
    return `${WORDS[a]}–${WORDS[b]}`;
  }

  /** "6–4 3–6 7–6(5)" from player `i`'s point of view (includes the set in progress). */
  setLine(i = 0) {
    const out = [];
    for (const s of this.sets) {
      let t = `${s.g[i]}–${s.g[1 - i]}`;
      if (s.tb) t += `(${Math.min(s.tb[0], s.tb[1])})`;
      out.push(t);
    }
    if (!this.done && (this.games[0] || this.games[1] || this.pts[0] || this.pts[1])) out.push(`${this.games[i]}–${this.games[1 - i]}`);
    return out.join('  ');
  }

  /** Games won by player i in set k (k = current set when k === this.sets.length). */
  gamesIn(k, i) {
    if (k < this.sets.length) return this.sets[k].g[i];
    return this.games[i];
  }
}
