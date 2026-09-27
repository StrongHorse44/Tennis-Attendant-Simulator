/**
 * TourSystem — the Junior Tennis Tour (game.tour). Pure game logic, Node-importable (no DOM, no
 * three.js): UI and world side effects go through the game object it is handed (all optional,
 * every access guarded) and a few hooks main.js sets.
 *
 * Story: beat Coach Rafa `unlock.rafaWins` (3) times at any level → he offers to coach you (the
 * results card via game.tourUI.showOffer, else a "!" over him at the club and a dialogue). Accept →
 * the tour: one featured tournament a week at other clubs (tour.json rotation), entries with fees,
 * draws with seeds, evening matches Wed/Thu/Fri–Sun, a rolling ranking (best 6 of the last 8 weeks)
 * against a seeded field of ~64 juniors (+ club juniors Theo and Lily, + adults on the Pro Circuit).
 * Top `hank.rank` (10) → Hank's crossroads: 'pro' (Pro Circuit, sponsored fees, 25 % off gear,
 * "Touring Pro") or 'grounds' (Hank retires, "Head Groundskeeper", wage ×1.25, groom bonus ×1.5).
 *
 * Simulation: every match the player isn't in is played point by point from ratings (TourField:
 * Elo-style serve / return point chances, TennisScore rules), both in the featured draw (round by
 * round, as the evenings pass) and in the week's background events for the rest of the field. The
 * field is rebuilt from the saved seed; only dynamic state is saved (≈ 10–20 KB).
 *
 * Days: week w = floor((day − 1) / 7), day 1 = Monday (weather.day). Rounds are evening matches on
 * consecutive days ending Sunday (draw 8: Fri–Sun, 16: Thu–Sun, 32: Wed–Sun); entries close the day
 * before round 1 (the draw is made that morning). A player match not played by the next day is a
 * walkover (rounds already won keep their points). No fail states.
 *
 * Interface (see also getHub() for the UI's data):
 *   tour.available / unlocked / accepted / career ('amateur' | 'pro' | 'grounds') / careerTitle
 *   tour.enter(tid) → { ok, reason, fee, wildcard }      tour.withdraw(tid) → { ok, reason, refund }
 *   tour.getTonight(day) → matchSpec | null              tour.onMatchResult({ tournamentId, round, won, score, retired, stats })
 *   tour.onNewDay(day)                                   tour.onSessionWin(diffKey)
 *   tour.offerFromNpc(npc) → bool                        tour.maybeOfferOnMenu() → bool
 *   tour.accept(source) / decline() / chooseCareer(c)    tour.gearDiscount() / careerEffects()
 *   tour.markerNpcIds() → npc ids that want a "!"        tour.talkMenu(npc) (dialogue fallback hub)
 *   tour.getState() / setState(s); sanitizeTour(raw) for SaveSystem
 * Hooks (Game sets them; all optional): onChange(kind), onMarkers(), onToast(text, icon),
 *   onCareer(career, { chosen }), onOpenHub(), onCelebrate(kind)
 *
 * matchSpec = { tournamentId, tournamentName, tier, tierLabel, venueId, venueName, venueShort, courtLabel,
 *   courtId (home event: the club court, else null), home, surface, wind, round ('QF'…), roundIndex,
 *   roundLabel (the short label, = round: 'R16' | 'QF' | 'SF' | 'F'), roundName ('Quarterfinal'),
 *   format ('short' | 'set' | 'bo3'), final, day, week, drawSize, seed (yours | null),
 *   opponent: { id, name, short, npcId | null, rating, effRating, style, styleLabel, age, club, adult,
 *     gender ('m' | 'f' | 'x'), pronoun ('he' | 'she' | 'they'), seed | null,
 *     look: { shirtColor, seed, gender }, styleMods, aiMods, note, level }, crowd (0..1) }
 * Everywhere in the hub, `round` / `roundLabel` are round codes and `roundName` the long name.
 */

import {
  normalizeTourData, generateField, rngFor, gauss, mod, formOf, effectiveRating, serveWinProb, simulateMatch,
  roundsOf, roundCode, matchOffset, matchesIn, buildDrawSlots, drawParticipants, levelLabel,
  TIER_ORDER, TOUR_SURFACES, ROUND_LABELS, RING, DRAW_SIZES, PRONOUNS, genderize,
} from './TourField.js';

export const CAREERS = ['amateur', 'pro', 'grounds'];
export const ME = 'me';
const HISTORY_MAX = 60, TITLES_MAX = 40, H2H_MAX = 80, RESULTS_MAX = 16;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const WIND_WORDS = { calm: 'calm', breeze: 'breezy', gusty: 'gusty' };
const SURFACE_PLANS = {
  hard: 'Hard court: take the ball early and dictate with your forehand.',
  clay: 'Clay: build the point with height and angles; the drop shot works when {he} stands deep.',
  grass: 'Grass: first strike. Serve well, take the first ball early and keep your slice low.',
};
const K_ME = 28, K_AI_VS_ME = 10;
const CATCHUP_MAX_DAYS = 7 * 60;

export const tourWeekOf = (day) => Math.floor((Math.max(1, day | 0) - 1) / 7);
export const tourWeekdayOf = (day) => mod(Math.max(1, day | 0) - 1, 7);
export const weekStartDay = (week) => week * 7 + 1;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pick = (arr, rand = Math.random) => arr[Math.floor(rand() * arr.length)];

/** "6–4  3–6" / "6-4 3-6" → "6-4 3-6" (ASCII hyphens, single spaces). */
export function normScore(s) {
  return String(s == null ? '' : s).replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** The same set line from the other player's side: "6-4 3-6(5)" → "4-6 6-3(5)". */
export function flipScore(s) {
  return normScore(s).split(' ').map(tok => tok.replace(/^(\d+)-(\d+)/, '$2-$1')).join(' ');
}

export class TourSystem {
  /**
   * @param {object|null} raw  tour.json (null / invalid → the tour stays unavailable)
   * @param {object} game      the Game (duck-typed: profile, shift, weather, npcs, npcData,
   *                           dialogueSystem, missionSystem, tennis, tourUI, hud …; all optional)
   */
  constructor(raw, game = {}) {
    this.game = game || {};
    this.data = normalizeTourData(raw);
    this.available = !!(this.data && this.data.amateur.length);

    // ── saved state ──
    this.seed = ((Math.random() * 4294967296) >>> 0) || 1;
    this.accepted = false;
    this.career = 'amateur';
    this.acceptedDay = 0;
    this.origin = 0;              // rotation origin: the amateur event of weekSlot 0 is played in this week
    this.proFromWeek = -1;        // pro path: Pro Circuit weeks alternate from this week
    this.hank = { decided: false, reached: false, snoozeUntil: 0, asked: 0, choice: null };
    this.offer = { shownDay: -1, declined: 0 };
    this.rafaWins = { easy: 0, medium: 0, hard: 0 };
    this.lastDay = 0;             // last day processed (onNewDay)
    this.curWeek = 0;             // the week being played (weeks before it are final)
    this.ring = new Map();        // junior id → weekly points ring (index = week mod RING)
    this.rd = new Map();          // id → rating drift (Elo), non-zero only
    this.me = createMe();
    this.entry = null;            // { tid, week, fee, wildcard, day }
    this.draw = null;             // this week's featured draw: { tid, week, size, slots, res, seeds }
    this.pubRanks = null;         // { id: rank } published at the last week rollover
    this.prevRanks = null;        // … and the one before (rank moves)

    // ── runtime ──
    this.field = null;
    this._rankCache = null;
    this._vals = [];
    this._markerIds = [];
    this._quiet = false;
    this._syncing = false;
    this._lastWins = this._profileWins();
    this._retiredLast = null;
    this._offerCard = false;      // the offer card is up (TourUI.showOffer), waiting for an answer
    this._hankWas = false;

    // Hooks (Game sets them)
    this.onChange = null;
    this.onMarkers = null;
    this.onToast = null;
    this.onCareer = null;
    this.onOpenHub = null;
    this.onCelebrate = null;

    const prof = this.game.profile;
    if (this.available && prof && typeof prof.onChange === 'function') {
      prof.onChange((kind) => this._onProfile(kind));
    }
  }

  // ───────────────────────────── status ─────────────────────────────

  get unlocked() { return this.available && this._profileWins() >= this.data.unlock.rafaWins; }

  /** Rafa's offer is waiting for an answer (he carries a "!" at the club). */
  get offerPending() { return this.unlocked && !this.accepted; }

  /**
   * Hank's crossroads is due (undecided, not snoozed, and the player has been in the top
   * `hank.rank` at least once — sticky, so a mid-week wobble to #11 doesn't take it away): he
   * carries a "!".
   */
  get hankPending() {
    if (!this.available || !this.accepted || this.career !== 'amateur' || this.hank.decided) return false;
    if (!this.hank.reached) {
      const r = this.myRank();
      if (r === null || r > this.data.hank.rank) return false;
      this.hank.reached = true;
    }
    return this._day() >= this.hank.snoozeUntil;
  }

  get careerTitle() {
    if (!this.available) return null;
    if (this.career === 'pro') return this.data.careers.pro.title;
    if (this.career === 'grounds') return this.data.careers.grounds.title;
    return null;
  }

  /** What the chosen career changes: { career, title, wageMul, groomBonusMul, gearDiscount, sponsoredFees }. */
  careerEffects() {
    const c = this.available ? this.data.careers : null;
    const pro = this.career === 'pro', gr = this.career === 'grounds';
    return {
      career: this.career,
      title: this.careerTitle,
      wageMul: gr && c ? c.grounds.wageMul : 1,
      groomBonusMul: gr && c ? c.grounds.groomBonusMul : 1,
      gearDiscount: pro && c ? c.pro.gearDiscount : 0,
      sponsoredFees: !!(pro && c && c.pro.sponsoredFees),
    };
  }

  /**
   * Jess's sponsorship on the pro path: the share off a tennis-gear price (0 otherwise). Game
   * hands it to the shop (ShopSystem.discountFor), which charges and shows the lower price.
   */
  gearDiscount() { return this.careerEffects().gearDiscount; }

  /** npc ids that should carry a "!" for the tour right now (reused array). */
  markerNpcIds() {
    const out = this._markerIds;
    out.length = 0;
    if (!this.available) return out;
    if (this.offerPending) out.push(this.data.rafa.npc);
    if (this.hankPending) out.push(this.data.hank.npc);
    return out;
  }

  myRank() {
    if (!this.accepted || !this.field) return null;
    return this._ranking().pos.get(ME) ?? null;
  }

  // ───────────────────────────── unlock and offers ─────────────────────────────

  /** Rafa-match win bookkeeping from the session (diffKey 'easy' | 'medium' | 'hard'); maybe the offer. */
  onSessionWin(diffKey) {
    if (!this.available) return false;
    if (diffKey in this.rafaWins) this.rafaWins[diffKey]++;
    if (!this.offerPending) return false;
    return this._offer('win');
  }

  /** The after-hours tennis menu opened: a pending offer is made there (once a day). */
  maybeOfferOnMenu() {
    if (!this.offerPending) return false;
    return this._offer('menu');
  }

  _onProfile(kind) {
    if (kind === 'load') {
      this._lastWins = this._profileWins();
      this._markersChanged();
      return;
    }
    if (kind !== 'record') return;
    const wins = this._profileWins();
    if (wins === this._lastWins) return;       // drills and losses emit 'record' too
    const more = wins > this._lastWins;
    this._lastWins = wins;
    if (more && this.offerPending) this._offer('win');
  }

  /**
   * Make the offer. In a tennis session: Rafa says it on court and the results card shows
   * "Accept — coach me" / "Not yet" (game.tourUI.showOffer); without that UI (or at the club) he
   * carries a "!" and talking to him asks. Unasked offers come at most once a game day.
   */
  _offer(source) {
    if (!this.offerPending) return false;
    const g = this.game, day = this._day();
    this._markersChanged();
    if (source !== 'talk' && source !== 'debug' && this.offer.shownDay === day) return false;
    this.offer.shownDay = day;
    const tennis = g.tennis;
    const inSession = !!(tennis && tennis.active);
    if (inSession) {
      try { if (typeof tennis._say === 'function') tennis._say(this.data.rafa.session, 3.6); } catch (e) { /* cosmetic */ }
    }
    const ui = g.tourUI;
    if (ui && typeof ui.showOffer === 'function') {
      if (this._offerCard) return true;          // one card at a time (it is still up)
      this._offerCard = true;
      // After the current frame's UI (the results card comes up right after the record is written)
      Promise.resolve().then(() => {
        if (!this.offerPending) { this._offerCard = false; return; }
        try {
          ui.showOffer({
            lines: this.data.rafa.offer.slice(),
            wins: this._profileWins(),
            onAccept: () => { this._offerCard = false; this.accept('ui'); },
            onLater: () => { this._offerCard = false; this.decline(); },
          });
        } catch (e) { this._offerCard = false; console.warn('TourUI.showOffer failed:', e); }
      });
      return true;
    }
    this._toast(inSession ? 'Coach Rafa wants a word with you at the club.' : 'Coach Rafa has something to ask you.', 'talk');
    return false;
  }

  /** Accept Rafa's offer: the tour starts (field, ranking history, this week's event). */
  accept(source = 'ui') {
    if (!this.available || this.accepted) return false;
    if (!this.unlocked && source !== 'debug') return false;
    const day = this._day();
    this.accepted = true;
    this.career = 'amateur';
    this.acceptedDay = day;
    const w = tourWeekOf(day);
    // The rotation starts with its first (local) event in the first week you can still enter it
    const first = this.data.amateur[0];
    this.origin = day < weekStartDay(w) + 7 - roundsOf(first.draw) ? w : w + 1;
    this.lastDay = day;
    this.me.rating = this._startRating();
    this._ensureField();
    this._quiet = true;
    try { this._prehistory(w); } finally { this._quiet = false; }
    this._ensureDraw(day);
    this._changed('accept');
    const inSession = !!(this.game.tennis && this.game.tennis.active);
    if (inSession) {
      try { this.game.tennis._say(this.data.rafa.accept[0], 3.4); } catch (e) { /* cosmetic */ }
    }
    if (source !== 'talk' && this.onOpenHub) {
      try { this.onOpenHub(); } catch (e) { console.warn('Tour hub:', e); }
    }
    return true;
  }

  /** "Not yet": the offer stands (Rafa keeps his "!"; talking to him asks again). */
  decline() {
    if (!this.offerPending) return;
    this.offer.declined++;
    const tennis = this.game.tennis;
    if (tennis && tennis.active) {
      try { tennis._say(this.data.rafa.later[0], 2.6); } catch (e) { /* cosmetic */ }
    }
    this._changed('decline');
  }

  /** Hank's crossroads answered: 'pro' | 'grounds'. */
  chooseCareer(career) {
    if (!this.available || !this.accepted || (career !== 'pro' && career !== 'grounds')) return false;
    if (this.career !== 'amateur') return false;
    this.career = career;
    this.hank.decided = true;
    this.hank.choice = career;
    if (career === 'pro') this.proFromWeek = this.curWeek + 1;
    if (this.onCareer) { try { this.onCareer(career, { chosen: true }); } catch (e) { console.warn(e); } }
    this._toast(career === 'pro'
      ? `You're a ${this.data.careers.pro.title} now: the club pays your entry fees and the Pro Circuit opens next week.`
      : `You're the club's ${this.data.careers.grounds.title} now: better wage, bigger groom bonus.`, 'sparkle');
    this._celebrate('career');
    this._changed('career');
    return true;
  }

  // ───────────────────────────── club conversations ─────────────────────────────

  /**
   * Talking to an NPC (Game._runAction 'talk' / taps, before the tennis offer and the shop):
   * Rafa with a pending offer, Hank at the crossroads, retired Hank's small talk on the grounds
   * path. Never takes over a conversation a mission step or an encounter needs. Returns true when
   * it took the conversation.
   */
  offerFromNpc(npc) {
    if (!this.available || !npc || !npc.id) return false;
    const g = this.game;
    if (g.tennis && g.tennis.active) return false;
    const ds = g.dialogueSystem;
    if (!ds || (typeof ds.isActive === 'function' && ds.isActive())) return false;
    if (npc.away || npc.playing || this._npcNeeded(npc)) return false;
    if (npc.id === this.data.rafa.npc && this.offerPending) {
      this._rafaOfferTalk(npc);
      return true;
    }
    if (npc.id === this.data.hank.npc) {
      if (this.hankPending) { this._hankTalk(npc); return true; }
      if (this.career === 'grounds' && this.data.hank.retired.length) { this._hankRetiredTalk(npc); return true; }
    }
    return false;
  }

  _npcNeeded(npc) {
    const ms = this.game.missionSystem;
    if (!ms) return false;
    try {
      const act = typeof ms.getActiveMissions === 'function' ? ms.getActiveMissions() : [];
      for (const m of act) if (typeof ms.getStepNpcId === 'function' && ms.getStepNpcId(m) === npc.id) return true;
      if (ms.pendingEncounters && typeof ms.pendingEncounters.has === 'function' && ms.pendingEncounters.has(npc.id)) return true;
    } catch (e) { return false; }
    return false;
  }

  /**
   * Lines (all but the last as a dialogue), then the last line with choices. onDone runs after the
   * dialogue has fully closed (DialogueSystem clears its callbacks right after calling them, so a
   * follow-up dialogue started from inside one would lose its own).
   */
  _talk(npc, lines, choices, onChoice, onDone) {
    const ds = this.game.dialogueSystem;
    if (!ds) return;
    const color = (ds.speakerColors && ds.speakerColors.get && ds.speakerColors.get(npc.name)) || npc.dialogueColor || undefined;
    const seq = lines.map(text => ({ speaker: npc.name, text }));
    if (!choices || !choices.length) {
      ds.startDialogue(npc, seq, () => {
        if (onDone) Promise.resolve().then(() => { try { onDone(); } catch (e) { console.warn('Tour dialogue:', e); } });
      });
      return;
    }
    const last = seq.pop();
    const ask = () => {
      ds.currentNPC = npc;
      if (typeof npc.startTalking === 'function') npc.startTalking();
      ds.dialogueBox.show(npc.name, last.text, color);
      ds.active = true;
      ds.showChoices(choices.map(c => (typeof c === 'string' ? { label: c } : c)), (i) => {
        if (npc.state === 'talking' && typeof npc.stopTalking === 'function') npc.stopTalking();
        onChoice(i);
      });
    };
    if (seq.length) ds.startDialogue(npc, seq, ask);
    else ask();
  }

  _rafaOfferTalk(npc) {
    const R = this.data.rafa;
    const lines = this.offer.declined > 0 ? [pick(R.remind)] : R.offer.slice();
    this.offer.shownDay = this._day();
    this._talk(npc, lines, ['Accept — coach me', 'Not yet'], (i) => {
      if (i === 0) {
        this.accept('talk');
        this._talk(npc, R.accept.slice(), null, null, () => {
          if (this.onOpenHub) { try { this.onOpenHub(); } catch (e) { console.warn(e); } }
          else this.talkMenu(npc);
        });
      } else {
        this.decline();
        this._talk(npc, R.later.slice(), null, null, null);
      }
    });
  }

  /**
   * Hank's crossroads. With a TourUI that has showChoice, his question ends on its choice card (each
   * path's consequences spelled out; Esc = "Let me think"); otherwise the dialogue's own choices.
   */
  _hankTalk(npc) {
    const H = this.data.hank;
    this.hank.asked++;
    const decide = (i) => {
      if (!this.hankPending) return;             // answered meanwhile (another path, a reload)
      if (i === 0) {
        this.chooseCareer('pro');
        this._talk(npc, H.pro.slice(), null, null, null);
      } else if (i === 1) {
        this.chooseCareer('grounds');
        this._talk(npc, H.grounds.slice(), null, null, null);
      } else {
        this.hank.snoozeUntil = this._day() + H.askAgainDays;
        this._changed('snooze');
        this._talk(npc, H.think.slice(), null, null, null);
      }
    };
    const ui = this.game.tourUI;
    if (!ui || typeof ui.showChoice !== 'function') {
      this._talk(npc, H.ask.slice(), H.choices.slice(), decide);
      return;
    }
    const C = this.data.careers;
    const choices = [
      { label: H.choices[0], primary: true,
        desc: `${C.pro.title}: the Pro Circuit opens (adult fields, prize money, a night stadium), the club pays your entry fees and Jess takes ${Math.round(C.pro.gearDiscount * 100)}% off tennis gear. Your shifts go on.` },
      { label: H.choices[1], primary: true,
        desc: `${C.grounds.title}: Hank retires and hands you the keys. Wage ×${C.grounds.wageMul}, groom bonus ×${C.grounds.groomBonusMul}. You can still play the junior events.` },
      { label: H.choices[2] || 'Let me think', desc: `Hank asks again in ${H.askAgainDays} day${H.askAgainDays === 1 ? '' : 's'}.` },
    ];
    const card = () => {
      try {
        ui.showChoice({
          title: 'Your future at Greenbriar', speaker: npc.name, role: 'Head of Grounds',
          body: H.ask[H.ask.length - 1], choices, cancel: 2,
        }, (i) => {
          // After the card has closed and the game has resumed (the follow-up is a dialogue)
          Promise.resolve().then(() => { try { decide(i); } catch (e) { console.warn('Hank:', e); } });
        });
      } catch (e) {
        console.warn('TourUI.showChoice failed:', e);
        this._talk(npc, [H.ask[H.ask.length - 1]], H.choices.slice(), decide);
      }
    };
    if (H.ask.length > 1) this._talk(npc, H.ask.slice(0, -1), null, null, card);
    else card();
  }

  _hankRetiredTalk(npc) {
    const pool = this.data.hank.retired;
    let line = pick(pool);
    if (pool.length > 1 && line === this._retiredLast) line = pool[(pool.indexOf(line) + 1) % pool.length];
    this._retiredLast = line;
    this._talk(npc, [line], null, null, null);
  }

  /**
   * The tour through a conversation (Rafa: works without the hub UI): tonight's match, this
   * week's event with Enter / Withdraw, the rankings.
   */
  talkMenu(npc) {
    if (!this.available || !this.accepted || !npc || !this.game.dialogueSystem) return false;
    this._sync();
    const hub = this.getHub();
    const f = hub.featured;
    const lines = [];
    if (hub.tonight) lines.push(`Tonight: the ${hub.tonight.roundName.toLowerCase()} against ${hub.tonight.opponent.name} at ${hub.tonight.venueName}. After your shift, from the report card.`);
    if (f) {
      const status = f.entered ? (f.status === 'entered' ? 'You are entered.' : f.status === 'inProgress' ? 'You are still in it.' : '')
        : f.canEnter ? `Entry $${f.fee}${f.sponsored ? ' (the club pays)' : ''}, until ${WEEKDAY_NAMES[tourWeekdayOf(f.startDay - 1)]}.` : f.reason;
      lines.push(`This week: the ${f.name}, ${f.tierLabel.toLowerCase()}, ${f.draw} players on ${f.surface} at ${f.venueName}. ${status}`.trim());
    }
    lines.push(hub.me.rank ? `You are number ${hub.me.rank} with ${hub.me.points} points.` : 'You have no ranking yet: win some matches.');
    const choices = [];
    if (f && f.canEnter) choices.push({ label: `Enter ($${f.fee})`, act: 'enter' });
    if (f && f.status === 'entered') choices.push({ label: 'Withdraw (refund)', act: 'withdraw' });
    choices.push({ label: 'Rankings', act: 'rankings' }, { label: 'Thanks, coach', act: 'done' });
    this._talk(npc, lines, choices, (i) => {
      const act = choices[i] && choices[i].act;
      if (act === 'enter') {
        const r = this.enter(f.id);
        this._talk(npc, [r.ok ? `Vamos! You are in the ${f.name}. The draw comes out on ${WEEKDAY_NAMES[tourWeekdayOf(f.startDay)]}.` : r.reason], null, null, null);
      } else if (act === 'withdraw') {
        const r = this.withdraw(f.id);
        this._talk(npc, [r.ok ? `Bueno. You are out${r.refund ? `, and the $${r.refund} comes back to you` : ''}.` : r.reason], null, null, null);
      } else if (act === 'rankings') {
        const top = hub.rankings.filter(x => x.rank && x.rank <= 5).map(x => `${x.rank}. ${x.isMe ? 'You' : x.short || x.name} (${x.points})`).join(', ');
        const mine = hub.me.rank ? ` You: number ${hub.me.rank}.` : '';
        this._talk(npc, [`Top five: ${top || 'nobody yet'}.${mine}`], null, null, null);
      }
    });
    return true;
  }

  // ───────────────────────────── entries ─────────────────────────────

  /** This week's featured tournament (the rotation; Pro Circuit weeks alternate on the pro path). */
  featuredFor(week) {
    if (!this.available) return null;
    const d = this.data;
    if (this.career === 'pro' && this.proFromWeek >= 0 && week >= this.proFromWeek && d.pro.length && (week - this.proFromWeek) % 2 === 0) {
      return d.pro[mod((week - this.proFromWeek) / 2, d.pro.length)];
    }
    return d.amateur[mod(week - this.origin, d.amateur.length)];
  }

  _startDay(week, t) { return weekStartDay(week) + 7 - roundsOf(t.draw); }

  _roundDay(draw, r) { return weekStartDay(draw.week) + 7 - roundsOf(draw.size) + r; }

  /** Can the player enter `t` (this week's event) right now? { ok, reason, fee, wildcard, sponsored }. */
  _entryInfo(t) {
    const out = { ok: false, reason: '', fee: 0, wildcard: false, sponsored: false };
    if (!this.available) { out.reason = 'The tour is not available.'; return out; }
    if (!this.accepted) { out.reason = "Accept Coach Rafa's offer first."; return out; }
    if (!t) { out.reason = 'No tournament this week.'; return out; }
    const tier = this.data.tiers[t.tier];
    const eff = this.careerEffects();
    out.sponsored = eff.sponsoredFees;
    out.fee = eff.sponsoredFees ? 0 : tier.fee;
    const day = this._day();
    if (this.entry && this.entry.week === this.curWeek && this.entry.tid === t.id) { out.reason = "You're already entered."; out.fee = this.entry.fee; return out; }
    if (day >= this._startDay(this.curWeek, t) || (this.draw && this.draw.week === this.curWeek)) { out.reason = 'Entries are closed: the draw is out.'; return out; }
    if (tier.careers && tier.careers.length && !tier.careers.includes(this.career)) {
      out.reason = `${tier.label} events are for touring pros only.`;
      return out;
    }
    const rank = this.myRank();
    if (tier.cutoff !== null && !(rank !== null && rank <= tier.cutoff)) {
      if (t.home) out.wildcard = true;
      else {
        out.reason = `Ranking cutoff: top ${tier.cutoff} (you are ${rank ? '#' + rank : 'unranked'}).`;
        return out;
      }
    }
    const wallet = this._wallet();
    if (out.fee > 0 && wallet < out.fee) { out.reason = `The entry fee is $${out.fee} (you have $${Math.floor(wallet)}).`; return out; }
    out.ok = true;
    return out;
  }

  /** Enter this week's tournament: pays the fee (sponsored on the pro path). { ok, reason, fee, wildcard }. */
  enter(tournamentId) {
    if (!this.available) return { ok: false, reason: 'The tour is not available.' };
    this._sync();
    const t = this.featuredFor(this.curWeek);
    if (!t || t.id !== tournamentId) return { ok: false, reason: "You can only enter this week's tournament." };
    const info = this._entryInfo(t);
    if (!info.ok) return { ok: false, reason: info.reason, fee: info.fee };
    if (info.fee > 0 && !this._spend(info.fee, `${t.name} entry`)) return { ok: false, reason: `The entry fee is $${info.fee}.`, fee: info.fee };
    this.entry = { tid: t.id, week: this.curWeek, fee: info.fee, wildcard: info.wildcard, day: this._day() };
    this._toast(`Entered: ${t.name}${info.wildcard ? ' (wildcard)' : ''}. The draw comes out ${WEEKDAY_NAMES[tourWeekdayOf(this._startDay(this.curWeek, t))]}.`, 'check');
    this._changed('enter');
    return { ok: true, fee: info.fee, wildcard: info.wildcard };
  }

  /**
   * Withdraw: before the draw the fee comes back; after it the next match is a walkover (points
   * and prize money for the rounds already won stay). { ok, reason, refund, walkover }.
   */
  withdraw(tournamentId) {
    if (!this.available) return { ok: false, reason: 'The tour is not available.' };
    this._sync();
    const e = this.entry;
    if (!e || e.week !== this.curWeek || (tournamentId && e.tid !== tournamentId)) return { ok: false, reason: "You're not entered." };
    if (!this.draw || this.draw.week !== this.curWeek) {
      const refund = e.fee || 0;
      this.entry = null;
      if (refund > 0) this._refund(refund);
      this._toast(`Withdrawn${refund ? `: $${refund} refunded` : ''}.`, 'check');
      this._changed('withdraw');
      return { ok: true, refund, walkover: false };
    }
    const pm = this._playerPending(this.draw);
    if (!pm) return { ok: false, reason: "You're already out of this one." };
    this._walkover(this.draw, pm.r, pm.i, 1 - pm.side, 'withdrew');
    this._simRoundOthers(this.draw, pm.r);
    this._changed('withdraw');
    return { ok: true, refund: 0, walkover: true };
  }

  // ───────────────────────────── the day, matches ─────────────────────────────

  /** Next day (Game.startNextDay) and after a load: walkovers, simulated rounds, week rollover, draws. */
  onNewDay(day = this._day()) {
    if (!this.available) return;
    this._offerCard = false;
    if (!this.accepted) { this.lastDay = day; this._markersChanged(); return; }
    this._sync(day);
    this._changed('day');
  }

  /** Tonight's tournament match for the player (the report card button), or null. */
  getTonight(day = this._day()) {
    if (!this.available || !this.accepted) return null;
    this._sync();
    const draw = this.draw;
    if (!draw || draw.week !== this.curWeek) return null;
    const pm = this._playerPending(draw);
    if (!pm || this._roundDay(draw, pm.r) !== day) return null;
    return this._matchSpec(draw, pm);
  }

  /**
   * The player's tournament match is over (TennisSession tour mode). won: the player won; score:
   * the set line from the player's side ("6-4 3-6 7-5"; en dashes are fine); retired: the match
   * ended by a retirement (quitting it from the menu = won false, retired true) — it only adds
   * "ret." to the score. stats are accepted and ignored (the results card shows them).
   * Returns null (no such match) or { won, round / roundLabel ('QF'), roundName ('Quarterfinal'), final, title,
   * prize, points (this week's tournament points), rank, next: { day, round, roundLabel, roundName, opponent } | null,
   * tournamentId, tournamentName, opponent (name), score (your side, + " ret."), champion, prizeGained,
   * pointsGained, rankDelta (+ = climbed) } — the last group in TourUI.showTournamentResult's words.
   */
  onMatchResult({ tournamentId = null, round = null, won = false, score = '', retired = false, stats = null } = {}) {
    if (!this.available || !this.accepted) return null;
    this._sync();
    const draw = this.draw;
    if (!draw || draw.week !== this.curWeek || (tournamentId && draw.tid !== tournamentId)) return null;
    const pm = this._playerPending(draw);
    if (!pm) return null;
    if (round !== null && round !== undefined && round !== pm.code && round !== pm.r) return null;
    const t = this.data.tournamentById.get(draw.tid);
    const win = !!won;
    const mine = normScore(score);
    const winnerView = win ? mine : flipScore(mine);
    const day = this._day();
    const ptsBefore = this._provisional().get(ME) || 0;
    const rankBefore = this.myRank();
    draw.res[pm.idx] = [win ? pm.side : 1 - pm.side, ((winnerView || '') + (retired ? ' ret.' : '')).trim().slice(0, 40), day];
    const opp = this.field.players.get(pm.oppId) || null;
    // Record, head-to-head, history, ratings
    if (win) this.me.w++; else this.me.l++;
    if (opp) {
      const h = this.me.h2h[opp.id] || (this.me.h2h[opp.id] = { w: 0, l: 0, name: opp.name });
      if (win) h.w++; else h.l++;
      h.name = opp.name;
      this._trimH2H();
      const oe = this._eff(opp.id, draw.week, t.surface);
      const E = 1 / (1 + Math.pow(10, (oe - this.me.rating) / 400));
      const S = win ? 1 : 0;
      this.me.rating = clamp(this.me.rating + K_ME * (S - E), 600, 3000);
      this._drift(opp.id, K_AI_VS_ME * ((1 - S) - (1 - E)));
    }
    this._pushHistory({
      week: draw.week, day, tid: t.id, tournament: t.name, venue: this._venueShort(t), round: pm.code, roundLabel: pm.code, roundName: ROUND_LABELS[pm.code] || pm.code,
      oppId: opp ? opp.id : null, opponent: opp ? opp.name : 'Unknown', won: win, score: (mine + (retired ? ' ret.' : '')).trim(), wo: false,
    });
    let title = false, prize = 0;
    if (!win) prize = this._endRun(draw, 'lost', pm.r);
    else if (pm.r === roundsOf(draw.size) - 1) { title = true; prize = this._endRun(draw, 'title', pm.r + 1); }
    this._simRoundOthers(draw, pm.r);
    this._rankCache = null;
    this._changed('result');
    const next = this._playerPending(draw);
    const nextOpp = next ? this.field.players.get(next.oppId) : null;
    const points = this._provisional().get(ME) || 0;
    const rank = this.myRank();
    return {
      won: win, round: pm.code, roundLabel: pm.code, roundName: ROUND_LABELS[pm.code] || pm.code, final: pm.r === roundsOf(draw.size) - 1,
      title, prize, points, rank,
      next: next ? { day: this._roundDay(draw, next.r), round: next.code, roundLabel: next.code, roundName: ROUND_LABELS[next.code] || next.code, opponent: nextOpp ? nextOpp.name : null } : null,
      // The same, in the result card's words (TourUI.showTournamentResult)
      tournamentId: t.id, tournamentName: t.name, opponent: opp ? opp.name : 'Unknown', score: (mine + (retired ? ' ret.' : '')).trim(),
      champion: title, prizeGained: prize, pointsGained: Math.max(0, points - ptsBefore),
      rankDelta: rankBefore && rank ? rankBefore - rank : 0,
    };
  }

  // ───────────────────────────── hub data (UI) ─────────────────────────────

  /**
   * Everything the tour hub shows, as plain data (fresh objects; safe to keep).
   * { available, unlocked, offerPending, hankPending, unlock: { need, wins }, accepted, career, careerTitle,
   *   day, week, weekday, wallet, me, featured, calendar, rankings, draw, tonight, nextMatch, scouting,
   *   canEnter, reason, entries }
   */
  getHub() {
    const day = this._day();
    const need = this.data ? this.data.unlock.rafaWins : 3;
    const base = {
      available: this.available, unlocked: this.unlocked, offerPending: this.offerPending, hankPending: false,
      unlock: { need, wins: Math.min(need, this._profileWins()) },
      accepted: this.accepted, career: this.career, careerTitle: this.careerTitle, day, week: tourWeekOf(day), weekday: tourWeekdayOf(day),
      wallet: Math.floor(this._wallet()),
      me: { name: 'You', rank: null, points: 0, move: 0, rating: Math.round(this.me.rating), prize: this.me.prize,
        pointsBreakdown: [], record: { w: this.me.w, l: this.me.l }, titles: [], history: [], lastMatch: null, h2h: {} },
      featured: null, calendar: [], rankings: [], draw: null, tonight: null, nextMatch: null, scouting: null,
      canEnter: false, reason: this.available ? "Accept Coach Rafa's offer first." : 'The tour is not available.', entries: [],
    };
    if (!this.available || !this.accepted) return base;
    this._sync();
    const d = this.data;
    const rk = this._ranking();
    const myRank = rk.pos.get(ME) ?? null;
    base.hankPending = this.hankPending;
    base.me.rank = myRank;
    base.me.points = myRank ? rk.list[myRank - 1].pts : this._points(ME, this._provisional());
    base.me.move = this._move(ME, myRank);
    base.me.pointsBreakdown = this._breakdown();
    base.me.titles = this.me.titles.map(x => ({ ...x }));
    base.me.history = this.me.history.map(x => ({ ...x }));            // oldest first (like titles)
    base.me.lastMatch = base.me.history.length ? base.me.history[base.me.history.length - 1] : null;
    for (const [id, h] of Object.entries(this.me.h2h)) base.me.h2h[id] = { ...h };

    // This week's tournament
    const t = this.featuredFor(this.curWeek);
    if (t) {
      const tier = d.tiers[t.tier];
      const info = this._entryInfo(t);
      const entered = !!(this.entry && this.entry.week === this.curWeek && this.entry.tid === t.id);
      const inDraw = !!(this.draw && this.draw.week === this.curWeek && this.draw.slots.includes(ME));
      const pending = inDraw ? this._playerPending(this.draw) : null;
      const startDay = this._startDay(this.curWeek, t);
      const n = roundsOf(t.draw);
      const codes = [];
      for (let r = 0; r < n; r++) codes.push(roundCode(t.draw, r));
      const table = (src) => {
        const o = {};
        if (!src) return o;
        if (fin(src.W)) o.W = src.W;
        for (let r = n - 1; r >= 0; r--) if (fin(src[codes[r]])) o[codes[r]] = src[codes[r]];
        return o;
      };
      let status;
      if (this.draw && this.draw.week === this.curWeek) status = inDraw ? (pending ? 'inProgress' : 'done') : (this._drawDone(this.draw) ? 'done' : 'closed');
      else status = entered ? 'entered' : (day >= startDay ? 'closed' : 'open');
      const venue = d.venueById.get(t.venue);
      base.featured = {
        id: t.id, name: t.name, venueId: t.venue, venueName: venue ? venue.name : t.venue, venueShort: venue ? venue.short : t.venue,
        surface: t.surface, wind: t.wind, tier: t.tier, tierLabel: tier.label, draw: t.draw, home: !!t.home, circuit: t.circuit,
        blurb: t.blurb, fee: entered ? this.entry.fee : info.fee, baseFee: tier.fee, sponsored: info.sponsored,
        prize: table(tier.prize), points: table(tier.points), cutoff: tier.cutoff,
        days: codes.map((c, r) => ({ day: startDay + r, weekday: tourWeekdayOf(startDay + r), round: c, roundLabel: c, roundName: ROUND_LABELS[c] || c, format: tier.formats[c] })),
        startDay, closeDay: startDay - 1,
        status, canEnter: info.ok, reason: info.ok ? '' : info.reason, entered: entered || inDraw,
        wildcard: entered ? !!this.entry.wildcard : info.wildcard,
      };
      base.canEnter = info.ok;
      base.reason = info.ok ? '' : info.reason;
      if (entered) base.entries.push({ tournamentId: t.id, week: this.curWeek, fee: this.entry.fee, wildcard: !!this.entry.wildcard });
    }

    // Calendar: this week and the next five
    for (let w = this.curWeek; w < this.curWeek + 6; w++) {
      const c = this.featuredFor(w);
      if (!c) continue;
      const v = d.venueById.get(c.venue);
      base.calendar.push({
        week: w, id: c.id, name: c.name, venueName: v ? v.name : c.venue, venueShort: v ? v.short : c.venue, surface: c.surface,
        tier: c.tier, tierLabel: d.tiers[c.tier].label, draw: c.draw, startDay: this._startDay(w, c), current: w === this.curWeek,
        home: !!c.home, circuit: c.circuit,
      });
    }

    // Rankings: the top 20, then the three around you (or you, unranked)
    const row = (e) => {
      const isMe = e.id === ME;
      const p = isMe ? null : this.field.players.get(e.id);
      return {
        rank: e.rank, id: e.id, name: isMe ? 'You' : p.name, short: isMe ? 'You' : p.short, club: isMe ? 'Greenbriar' : p.club,
        points: e.pts, isMe, isClub: isMe ? false : this.field.clubIds.has(e.id), move: this._move(e.id, e.rank),
        age: isMe ? null : p.age, style: isMe ? null : p.style,
      };
    };
    const top = Math.min(20, rk.list.length);
    for (let i = 0; i < top; i++) base.rankings.push(row(rk.list[i]));
    if (myRank && myRank > 20) {
      for (let i = Math.max(20, myRank - 2); i < Math.min(rk.list.length, myRank + 1); i++) base.rankings.push(row(rk.list[i]));
    } else if (!myRank) {
      base.rankings.push({ rank: null, id: ME, name: 'You', short: 'You', club: 'Greenbriar', points: base.me.points, isMe: true, isClub: false, move: 0, age: null, style: null });
    }

    // The draw (bracket)
    if (this.draw && this.draw.week === this.curWeek) base.draw = this._drawView(this.draw);

    // Tonight / the next match / scouting
    base.tonight = this.getTonight(day);
    const pm = this.draw && this.draw.week === this.curWeek ? this._playerPending(this.draw) : null;
    let spec = base.tonight;
    if (pm) {
      spec = spec || this._matchSpec(this.draw, pm);
      base.nextMatch = { day: this._roundDay(this.draw, pm.r), weekday: tourWeekdayOf(this._roundDay(this.draw, pm.r)), round: pm.code, roundLabel: pm.code, roundName: ROUND_LABELS[pm.code] || pm.code, opponent: spec ? spec.opponent : null };
    }
    base.scouting = spec ? this._scouting(spec) : null;
    return base;
  }

  _move(id, rank) {
    const prev = this.prevRanks && this.prevRanks[id];
    if (!rank || !prev) return 0;
    return prev - rank;
  }

  _breakdown() {
    const out = [];
    const W = this.data.ranking.window;
    const recent = this.me.results.filter(r => r.week > this.curWeek - W && r.week < this.curWeek);
    for (const r of recent) out.push({ tournament: r.tournament, round: r.round, roundLabel: r.round, roundName: ROUND_LABELS[r.round] || r.round, points: r.points, week: r.week, provisional: false, counted: false });
    const prov = this._provisional().get(ME) || 0;
    if (this.draw && this.draw.week === this.curWeek && this.draw.slots.includes(ME)) {
      const t = this.data.tournamentById.get(this.draw.tid);
      const st = this._standing(this.draw).get(ME);
      const code = st ? (st.champion ? 'W' : roundCode(this.draw.size, Math.min(st.r, roundsOf(this.draw.size) - 1))) : '';
      out.push({ tournament: t ? t.name : this.draw.tid, round: code, roundLabel: code, roundName: ROUND_LABELS[code] || code, points: prov, week: this.curWeek, provisional: true, counted: false });
    }
    const order = out.map((x, i) => i).sort((a, b) => out[b].points - out[a].points);
    for (let k = 0; k < order.length && k < this.data.ranking.bestOf; k++) if (out[order[k]].points > 0) out[order[k]].counted = true;
    return order.map(i => out[i]);
  }

  _drawView(draw) {
    const t = this.data.tournamentById.get(draw.tid);
    const v = t ? this.data.venueById.get(t.venue) : null;
    const n = roundsOf(draw.size);
    const who = (id) => {
      if (id === undefined) return null;
      if (id === null) return { id: null, name: 'Bye', short: 'Bye', seed: null, isMe: false, isClub: false, bye: true };
      if (id === ME) return { id: ME, name: 'You', short: 'You', seed: draw.seeds[ME] || null, isMe: true, isClub: false, club: 'Greenbriar' };
      const p = this.field.players.get(id);
      return { id, name: p ? p.name : id, short: p ? p.short : id, seed: draw.seeds[id] || null, isMe: false, isClub: this.field.clubIds.has(id), club: p ? p.club : '' };
    };
    const rounds = [];
    for (let r = 0; r < n; r++) {
      const arr = [];
      const code = roundCode(draw.size, r);
      for (let i = 0; i < matchesIn(draw.size, r); i++) {
        const [a, b] = drawParticipants(draw, r, i);
        const res = draw.res[matchOffset(draw.size, r) + i];
        arr.push({ a: who(a), b: who(b), winner: res[0] === 0 ? 'a' : res[0] === 1 ? 'b' : null, score: res[0] >= 0 ? res[1] : '', day: this._roundDay(draw, r), code, roundLabel: code, roundName: ROUND_LABELS[code] || code });
      }
      rounds.push(arr);
    }
    return { tournamentId: draw.tid, name: t ? t.name : draw.tid, venueName: v ? v.name : '', surface: t ? t.surface : 'hard', size: draw.size, week: draw.week, rounds };
  }

  _scouting(spec) {
    const o = spec.opponent;
    const st = this.data.styles[o.style] || null;
    const strengths = st ? st.scout.strengths.slice() : [];
    const weaknesses = st ? st.scout.weaknesses.slice() : [];
    const plan = st ? st.scout.plan.slice() : [];
    const p = this.field.players.get(o.id);
    if (p) {
      if (p.pref && p.pref === spec.surface) strengths.push(`At home on ${spec.surface}`);
      else if (p.weak && p.weak === spec.surface) weaknesses.push(`Uncomfortable on ${spec.surface}`);
      const form = formOf(this.seed, p.id, spec.week, this.data.field.formSd);
      if (form > this.data.field.formSd * 0.7) strengths.push('In good form this week');
      else if (form < -this.data.field.formSd * 0.7) weaknesses.push('Out of form this week');
    }
    if (SURFACE_PLANS[spec.surface]) plan.push(SURFACE_PLANS[spec.surface]);
    if (spec.wind && spec.wind !== 'calm') plan.push(`It is ${WIND_WORDS[spec.wind] || spec.wind} at ${spec.venueShort || spec.venueName}: aim well inside the lines and lob with the wind behind you.`);
    const h = this.me.h2h[o.id];
    const g = o.gender, gz = (list) => list.map(x => genderize(x, g));
    return {
      opponent: o, level: levelLabel(o.effRating), strengths: gz(strengths), weaknesses: gz(weaknesses), plan: gz(plan),
      h2h: h ? { w: h.w, l: h.l } : { w: 0, l: 0 },
      note: genderize(o.note || (st ? st.blurb : ''), g),
    };
  }

  _matchSpec(draw, pm) {
    const d = this.data;
    const t = d.tournamentById.get(draw.tid);
    const tier = d.tiers[t.tier];
    const venue = d.venueById.get(t.venue);
    const p = this.field.players.get(pm.oppId);
    const st = p ? d.styles[p.style] : null;
    const eff = p ? this._eff(p.id, draw.week, t.surface) : 1400;
    const n = roundsOf(draw.size);
    const crowdBase = venue && venue.look && fin(venue.look.crowd) ? venue.look.crowd : (t.home ? 0.9 : 0.5);
    const roundF = [0.4, 0.5, 0.65, 0.85, 1][clamp(5 - (n - pm.r), 0, 4)];
    const home = !!t.home;
    return {
      tournamentId: t.id, tournamentName: t.name, tier: t.tier, tierLabel: tier.label,
      venueId: t.venue, venueName: venue ? venue.name : t.venue, venueShort: venue ? venue.short : t.venue,
      courtLabel: home ? (venue && venue.courtLabel) || 'Centre Court' : (pm.code === 'F' || pm.code === 'SF' ? 'Stadium Court' : 'Court 1'),
      courtId: home && venue ? venue.court || null : null, home,
      surface: t.surface, wind: t.wind, round: pm.code, roundIndex: pm.r, roundLabel: pm.code, roundName: ROUND_LABELS[pm.code] || pm.code,
      format: tier.formats[pm.code] || 'set', final: pm.code === 'F', day: this._roundDay(draw, pm.r), week: draw.week, drawSize: draw.size,
      opponent: p ? {
        id: p.id, name: p.name, short: p.short, npcId: p.npcId || null, rating: Math.round(p.rating + (this.rd.get(p.id) || 0)),
        effRating: Math.round(eff), style: p.style, styleLabel: st ? st.label : p.style, age: p.age, club: p.club,
        gender: p.gender || 'x', pronoun: (PRONOUNS[p.gender] || PRONOUNS.x).he,
        seed: draw.seeds[p.id] || null, look: { shirtColor: p.shirtColor, seed: p.lookSeed, gender: p.gender || 'x' },
        styleMods: st ? JSON.parse(JSON.stringify(st.ai)) : null, aiMods: p.ai ? JSON.parse(JSON.stringify(p.ai)) : null,
        note: genderize(p.note || '', p.gender), level: levelLabel(eff), adult: !!p.adult,
      } : null,
      crowd: clamp(crowdBase * roundF * (home ? 1.25 : 1), 0, 1),
      seed: draw.seeds[ME] || null,
    };
  }

  // ───────────────────────────── field, ranking ─────────────────────────────

  _ensureField() {
    if (!this.available) return null;
    if (!this.field) this.field = generateField(this.data, this.seed, (id) => this._npcInfo(id));
    return this.field;
  }

  _npcInfo(id) {
    const g = this.game;
    const list = g.npcData && Array.isArray(g.npcData.npcs) ? g.npcData.npcs : null;
    const def = list ? list.find(n => n && n.id === id) : null;
    if (def) return { name: def.name, shirtColor: def.shirtColor };
    const npc = Array.isArray(g.npcs) ? g.npcs.find(n => n && n.id === id) : null;
    return npc ? { name: npc.name, shirtColor: npc.data && npc.data.shirtColor } : null;
  }

  _baseRating(id) {
    if (id === ME) return this.me.rating;
    const p = this.field.players.get(id);
    return p ? p.rating + (this.rd.get(id) || 0) : 0;
  }

  _eff(id, week, surface) {
    if (id === ME) return this.me.rating;
    const p = this.field.players.get(id);
    return p ? effectiveRating(this.data, this.seed, p, week, surface, this.rd.get(id) || 0) : 1200;
  }

  _drift(id, delta) {
    if (id === ME || !fin(delta) || !delta) return;
    const v = clamp((this.rd.get(id) || 0) + delta, -150, 150);
    this.rd.set(id, v);
  }

  /** Points each draw participant has this week (final or, while alive, the round reached). */
  _provisional() {
    const out = new Map();
    if (this.draw && this.draw.week === this.curWeek) this._drawPointsInto(this.draw, out);
    return out;
  }

  _points(id, prov) {
    const ring = id === ME ? this.me.ring : this.ring.get(id);
    const vals = this._vals;
    vals.length = 0;
    const W = this.data.ranking.window;
    for (let k = 1; k < W; k++) vals.push(ring ? ring[mod(this.curWeek - k, RING)] || 0 : 0);
    vals.push(prov.get(id) || 0);
    vals.sort((a, b) => b - a);
    let s = 0;
    for (let i = 0; i < this.data.ranking.bestOf && i < vals.length; i++) s += vals[i];
    if (id === ME) s += this.me.adj;
    return Math.max(0, Math.round(s));
  }

  /** The live ranking: { list: [{ id, pts, rating, rank }], pos: Map(id → rank) } (juniors and you). */
  _ranking() {
    if (this._rankCache) return this._rankCache;
    this._ensureField();
    const prov = this._provisional();
    const list = [];
    for (const id of this.field.juniors) {
      const p = this._points(id, prov);
      if (p > 0) list.push({ id, pts: p, rating: this._baseRating(id), rank: 0 });
    }
    if (this.accepted) {
      const p = this._points(ME, prov);
      if (p > 0) list.push({ id: ME, pts: p, rating: this.me.rating, rank: 0 });
    }
    list.sort((a, b) => b.pts - a.pts || b.rating - a.rating || (a.id < b.id ? -1 : 1));
    const pos = new Map();
    for (let i = 0; i < list.length; i++) { list[i].rank = i + 1; pos.set(list[i].id, i + 1); }
    this._rankCache = { list, pos };
    return this._rankCache;
  }

  _rankSnapshot() {
    const o = {};
    for (const e of this._ranking().list) o[e.id] = e.rank;
    return o;
  }

  /** Juniors in allocation order for week w (ranking + a little jitter), without resting / excluded / club-only players. */
  _sortedJuniors(w, exclude) {
    const d = this.data;
    const { pos } = this._ranking();
    const ex = new Set(exclude);
    const keys = new Map();
    const out = [];
    for (const id of this.field.juniors) {
      if (ex.has(id)) continue;
      const p = this.field.players.get(id);
      if (p.localOnly) continue;
      if (rngFor(this.seed, `rest:${w}:${id}`)() < d.week.restChance) continue;
      const base = pos.get(id) ?? (1000 + (3000 - this._baseRating(id)) / 10);
      keys.set(id, base + gauss(rngFor(this.seed, `jit:${w}:${id}`)) * d.week.jitter);
      out.push(id);
    }
    out.sort((a, b) => keys.get(a) - keys.get(b) || (a < b ? -1 : 1));
    return out;
  }

  /** Background events of stronger tiers take their players first (a featured event's band). */
  _bandOffset(tierKey) {
    const bg = this.data.week.background;
    if (tierKey === 'local') return bg.national + bg.regional;
    if (tierKey === 'regional') return bg.national;
    return 0;
  }

  _byRanking(a, b) {
    const { pos } = this._ranking();
    const ra = pos.get(a) ?? Infinity, rb = pos.get(b) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return this._baseRating(b) - this._baseRating(a) || (a < b ? -1 : 1);
  }

  // ───────────────────────────── draws ─────────────────────────────

  _ensureDraw(day) {
    if (!this.accepted || (this.draw && this.draw.week === this.curWeek)) return;
    const t = this.featuredFor(this.curWeek);
    if (!t || day < this._startDay(this.curWeek, t)) return;
    this.draw = this._makeDraw(this.curWeek, t);
    this._resolveByes(this.draw);
    this._rankCache = null;
    const pm = this._playerPending(this.draw);
    if (pm) {
      const opp = this.field.players.get(pm.oppId);
      const rd = this._roundDay(this.draw, pm.r);
      this._toast(`Draw is out: ${ROUND_LABELS[pm.code] || pm.code} vs ${opp ? opp.short : 'TBD'}${rd === day ? ' tonight' : ` on ${WEEKDAY_NAMES[tourWeekdayOf(rd)]}`}, ${t.name}.`, 'bell');
    }
    this._resolveBefore(this.draw, day);
  }

  /** The featured draw of week w: the player (if entered), reserved club juniors, then the tier's band. */
  _makeDraw(w, t) {
    const d = this.data, tier = d.tiers[t.tier], size = t.draw;
    const rand = rngFor(this.seed, `draw:${w}:${t.id}`);
    const reserved = [];
    if (this.entry && this.entry.week === w && this.entry.tid === t.id) reserved.push(ME);
    for (const id of this.field.juniors) {
      const p = this.field.players.get(id);
      if (t.home && p.home) reserved.push(id);
      else if (p.localOnly && t.tier === 'local' && rngFor(this.seed, `wc:${w}:${id}`)() < p.wildcardChance) reserved.push(id);
    }
    const need = Math.max(0, size - reserved.length);
    let chosen;
    if (t.tier === 'pro') {
      const adults = this.field.adults.slice().sort((a, b) => this._eff(b, w, t.surface) - this._eff(a, w, t.surface));
      const nA = Math.max(0, Math.min(adults.length, need - Math.min(tier.juniors, need)));
      chosen = adults.slice(0, nA);
      chosen = chosen.concat(this._sortedJuniors(w, reserved).slice(0, need - chosen.length));
    } else {
      const pool = this._sortedJuniors(w, reserved);
      const skip = Math.min(this._bandOffset(t.tier), Math.max(0, pool.length - need));
      chosen = pool.slice(skip, skip + need);
    }
    const entrants = reserved.concat(chosen);
    // Seeds: the junior ranking (unranked players are never seeded); on the Pro Circuit, where
    // adults have no junior ranking, the strongest players by rating
    const pro = t.tier === 'pro';
    const ranked = entrants.slice().sort(pro ? (a, b) => this._baseRating(b) - this._baseRating(a) || (a < b ? -1 : 1) : (a, b) => this._byRanking(a, b));
    const { pos } = this._ranking();
    const seeded = ranked.slice(0, Math.max(1, size / 4)).filter(id => pro || pos.has(id));
    const others = entrants.filter(id => !seeded.includes(id));
    const slots = buildDrawSlots(size, seeded, others, rand);
    const seeds = {};
    seeded.forEach((id, i) => { seeds[id] = i + 1; });
    return { tid: t.id, week: w, size, slots, res: Array.from({ length: size - 1 }, () => [-1, '', 0]), seeds };
  }

  /** Byes: a match with a known empty line goes to the other player at once. */
  _resolveByes(draw) {
    const n = roundsOf(draw.size);
    for (let r = 0; r < n; r++) {
      const off = matchOffset(draw.size, r);
      for (let i = 0; i < matchesIn(draw.size, r); i++) {
        const res = draw.res[off + i];
        if (res[0] >= 0) continue;
        const [a, b] = drawParticipants(draw, r, i);
        if (a === undefined || b === undefined) continue;
        if (a === null || b === null) { res[0] = a === null ? 1 : 0; res[1] = 'bye'; res[2] = this._roundDay(draw, r); }
      }
    }
  }

  /** Decide every match scheduled before `day` (the player's own → a walkover). */
  _resolveBefore(draw, day) {
    const n = roundsOf(draw.size);
    for (let r = 0; r < n; r++) {
      if (this._roundDay(draw, r) >= day) break;
      this._resolveByes(draw);
      const off = matchOffset(draw.size, r);
      for (let i = 0; i < matchesIn(draw.size, r); i++) {
        if (draw.res[off + i][0] >= 0) continue;
        const [a, b] = drawParticipants(draw, r, i);
        if (a === undefined || b === undefined) continue;
        if (a === ME || b === ME) { this._walkover(draw, r, i, a === ME ? 1 : 0, 'missed'); continue; }
        this._simDrawMatch(draw, r, i);
      }
    }
    this._resolveByes(draw);
    this._rankCache = null;
  }

  /** After the player's match: the rest of that round is played the same evening. */
  _simRoundOthers(draw, r) {
    this._resolveByes(draw);
    const off = matchOffset(draw.size, r);
    for (let i = 0; i < matchesIn(draw.size, r); i++) {
      if (draw.res[off + i][0] >= 0) continue;
      const [a, b] = drawParticipants(draw, r, i);
      if (a === undefined || b === undefined || a === ME || b === ME) continue;
      this._simDrawMatch(draw, r, i);
    }
    this._resolveByes(draw);
    this._rankCache = null;
  }

  _simDrawMatch(draw, r, i) {
    const t = this.data.tournamentById.get(draw.tid);
    const tier = this.data.tiers[t.tier];
    const code = roundCode(draw.size, r);
    const [a, b] = drawParticipants(draw, r, i);
    const m = this._simPair(a, b, draw.week, t.surface, tier.formats[code] || 'set', `m:${draw.week}:${draw.tid}:${r}:${i}`);
    const res = draw.res[matchOffset(draw.size, r) + i];
    res[0] = m.winner; res[1] = m.score; res[2] = this._roundDay(draw, r);
  }

  /** One simulated match between two field players (Elo drift on the result). */
  _simPair(a, b, week, surface, format, key) {
    const d = this.data;
    const pa = this.field.players.get(a), pb = this.field.players.get(b);
    const ea = this._eff(a, week, surface), eb = this._eff(b, week, surface);
    const base = (pa && pa.adult) || (pb && pb.adult) ? d.field.sim.proServeBase : d.field.sim.serveBase;
    const sa = pa ? d.styles[pa.style] : null, sb = pb ? d.styles[pb.style] : null;
    const pA = serveWinProb(base, d.field.sim.k, ea, eb, sa, sb);
    const pB = serveWinProb(base, d.field.sim.k, eb, ea, sb, sa);
    const m = simulateMatch(rngFor(this.seed, key), pA, pB, format);
    const E = 1 / (1 + Math.pow(10, ((this._baseRating(b)) - this._baseRating(a)) / 400));
    const S = m.winner === 0 ? 1 : 0;
    const K = d.field.drift;
    this._drift(a, K * (S - E));
    this._drift(b, K * ((1 - S) - (1 - E)));
    return m;
  }

  /** The player gives a match away: missed it (next day) or withdrew. */
  _walkover(draw, r, i, winnerSide, why) {
    const res = draw.res[matchOffset(draw.size, r) + i];
    res[0] = winnerSide; res[1] = 'W/O'; res[2] = this._roundDay(draw, r);
    const t = this.data.tournamentById.get(draw.tid);
    const [a, b] = drawParticipants(draw, r, i);
    const oppId = a === ME ? b : a;
    const opp = oppId ? this.field.players.get(oppId) : null;
    const code = roundCode(draw.size, r);
    this._pushHistory({
      week: draw.week, day: this._roundDay(draw, r), tid: t.id, tournament: t.name, venue: this._venueShort(t), round: code, roundLabel: code, roundName: ROUND_LABELS[code] || code,
      oppId: opp ? opp.id : null, opponent: opp ? opp.name : 'Unknown', won: false, score: 'W/O', wo: true,
    });
    this._endRun(draw, 'wo', r);
    this._toast(why === 'withdrew'
      ? `You withdrew from the ${t.name}: walkover to ${opp ? opp.short : 'your opponent'}.`
      : `You missed your ${ROUND_LABELS[code] || code} at the ${t.name}: walkover to ${opp ? opp.short : 'your opponent'}.`, 'bell');
    this._rankCache = null;
  }

  /**
   * The player's run is over: 'lost' in round r, 'wo' (walkover in round r: no points or prize
   * for a first-round walkover), 'title' (r = rounds). Pays the prize money for the round reached.
   */
  _endRun(draw, kind, r) {
    const t = this.data.tournamentById.get(draw.tid);
    const tier = this.data.tiers[t.tier];
    const n = roundsOf(draw.size);
    const code = kind === 'title' ? 'W' : roundCode(draw.size, Math.min(r, n - 1));
    let prize = 0;
    if (!(kind === 'wo' && r === 0) && tier.prize && fin(tier.prize[code])) prize = tier.prize[code];
    if (prize > 0) {
      this.me.prize += prize;
      this._payPrize(prize, `${t.name}: ${ROUND_LABELS[code] || code}`);
    }
    if (kind === 'title') {
      this.me.titles.push({ name: t.name, tid: t.id, week: draw.week, venue: this._venueShort(t), tier: t.tier, day: this._day() });
      if (this.me.titles.length > TITLES_MAX) this.me.titles.splice(0, this.me.titles.length - TITLES_MAX);
      this._toast(`Champion! You won the ${t.name}${prize ? ` (+$${prize})` : ''}.`, 'sparkle');
      this._celebrate('title');
    } else if (kind === 'lost') {
      this._toast(`Out in the ${ROUND_LABELS[code] || code} of the ${t.name}${prize ? ` (+$${prize} prize money)` : ''}.`, 'check');
    }
    return prize;
  }

  /** The player's next undecided match in `draw`: { r, i, idx, side, oppId, code } or null. */
  _playerPending(draw) {
    if (!draw || !draw.slots.includes(ME)) return null;
    const n = roundsOf(draw.size);
    for (let r = 0; r < n; r++) {
      const off = matchOffset(draw.size, r);
      for (let i = 0; i < matchesIn(draw.size, r); i++) {
        const [a, b] = drawParticipants(draw, r, i);
        if (a !== ME && b !== ME) continue;
        const res = draw.res[off + i];
        if (res[0] >= 0) { if ((res[0] === 0 ? a : b) !== ME) return null; break; }   // lost here: out
        const oppId = a === ME ? b : a;
        if (oppId === undefined) return null;   // the opponent isn't known yet (shouldn't happen)
        return { r, i, idx: off + i, side: a === ME ? 0 : 1, oppId, code: roundCode(draw.size, r) };
      }
    }
    return null;
  }

  _drawDone(draw) { return draw.res.every(x => x[0] >= 0); }

  /** Where each participant stands: Map id → { r, out, wo, champion }. */
  _standing(draw) {
    const st = new Map();
    const n = roundsOf(draw.size);
    for (let r = 0; r < n; r++) {
      const off = matchOffset(draw.size, r);
      for (let i = 0; i < matchesIn(draw.size, r); i++) {
        const [a, b] = drawParticipants(draw, r, i);
        for (const id of [a, b]) if (id) st.set(id, { r, out: false, wo: false, champion: false });
        const res = draw.res[off + i];
        if (res[0] < 0) continue;
        const loser = res[0] === 0 ? b : a, winner = res[0] === 0 ? a : b;
        if (loser) st.set(loser, { r, out: true, wo: res[1] === 'W/O', champion: false });
        if (r === n - 1 && winner) st.set(winner, { r: n, out: true, wo: false, champion: true });
      }
    }
    return st;
  }

  /** Points from a draw (final for finished runs, the round reached for those still alive). */
  _drawPointsInto(draw, out) {
    const t = this.data.tournamentById.get(draw.tid);
    if (!t) return out;
    const pts = this.data.tiers[t.tier].points;
    const n = roundsOf(draw.size);
    for (const [id, s] of this._standing(draw)) {
      let p = 0;
      if (s.champion) p = pts.W || 0;
      else if (!(s.wo && s.r === 0)) p = pts[roundCode(draw.size, Math.min(s.r, n - 1))] || 0;
      out.set(id, (out.get(id) || 0) + p);
    }
    return out;
  }

  // ───────────────────────────── weeks ─────────────────────────────

  /** Bring the tour up to `day`: every evening in between is played (walkovers, sims, rollovers). */
  _sync(day = this._day()) {
    if (!this.available || !this.accepted || this._syncing) return;
    this._syncing = true;
    try {
      this._ensureField();
      if (!(this.lastDay >= 1)) this.lastDay = day;
      if (day > this.lastDay) {
        const stop = Math.min(day, this.lastDay + CATCHUP_MAX_DAYS);
        const quiet = this._quiet;
        try {
          // A catch-up over several days only announces the last one (no burst of stale toasts)
          for (let d = this.lastDay + 1; d <= stop; d++) { this._quiet = quiet || d < day; this._advanceDay(d); }
        } finally { this._quiet = quiet; }
        if (stop < day) { this.curWeek = tourWeekOf(day); this.draw = null; }
        this.lastDay = day;
      }
      const w = tourWeekOf(day);
      let guard = 0;
      while (this.curWeek < w && guard++ < 70) this._finalizeWeek(this.curWeek);
      if (this.curWeek < w) this.curWeek = w;
      this._ensureDraw(day);
    } finally {
      this._syncing = false;
    }
  }

  _advanceDay(day) {
    if (this.draw && this.draw.week === this.curWeek) this._resolveBefore(this.draw, day);
    const w = tourWeekOf(day);
    let guard = 0;
    while (this.curWeek < w && guard++ < 70) this._finalizeWeek(this.curWeek);
    this._ensureDraw(day);
    // Entries close tonight: a reminder when the player could still enter
    const t = this.featuredFor(this.curWeek);
    if (t && day === this._startDay(this.curWeek, t) - 1 && !(this.entry && this.entry.week === this.curWeek)) {
      if (this._entryInfo(t).ok) this._toast(`Entries for the ${t.name} close today.`, 'bell');
    }
  }

  /** Week w is over: the featured draw is finished, the background events run, points are banked. */
  _finalizeWeek(w) {
    const t = this.featuredFor(w);
    let draw = this.draw && this.draw.week === w ? this.draw : null;
    if (!draw && t) draw = this._makeDraw(w, t);
    const weekPts = new Map();
    const inFeatured = new Set();
    if (draw) {
      this._resolveBefore(draw, Infinity);
      for (const id of draw.slots) if (id) inFeatured.add(id);
      this._drawPointsInto(draw, weekPts);
    }
    this._simulateBackground(w, t, inFeatured, weekPts);
    for (const id of this.field.juniors) {
      let ring = this.ring.get(id);
      if (!ring) { ring = new Array(RING).fill(0); this.ring.set(id, ring); }
      ring[mod(w, RING)] = weekPts.get(id) || 0;
    }
    this.me.ring[mod(w, RING)] = weekPts.get(ME) || 0;
    if (draw && inFeatured.has(ME)) {
      const s = this._standing(draw).get(ME);
      const code = s ? (s.champion ? 'W' : roundCode(draw.size, Math.min(s.r, roundsOf(draw.size) - 1))) : '';
      this.me.results.push({ week: w, tid: t.id, tournament: t.name, round: s && s.wo && s.r === 0 ? 'W/O' : code, points: weekPts.get(ME) || 0 });
      if (this.me.results.length > RESULTS_MAX) this.me.results.splice(0, this.me.results.length - RESULTS_MAX);
    }
    // Ratings drift back toward the base a little every week
    for (const [id, v] of this.rd) {
      const nv = Math.round(v * 0.97 * 10) / 10;
      if (Math.abs(nv) < 0.5) this.rd.delete(id); else this.rd.set(id, nv);
    }
    if (this.entry && this.entry.week <= w) this.entry = null;
    this.draw = null;
    this.curWeek = w + 1;
    this._rankCache = null;
    const before = this.pubRanks ? this.pubRanks[ME] : undefined;
    this.prevRanks = this.pubRanks;
    this.pubRanks = this._rankSnapshot();
    const after = this.pubRanks[ME];
    if (!this._quiet && this.accepted && after) {
      this._toast(before && before !== after ? `Tour ranking: #${before} → #${after}.` : `Tour ranking this week: #${after}.`, before && after < before ? 'sparkle' : 'bell');
    }
  }

  /** The rest of the field's week: one event per tier the featured event isn't (strongest first). */
  _simulateBackground(w, t, inFeatured, weekPts) {
    const d = this.data;
    const featTier = t ? t.tier : null;
    const pool = this._sortedJuniors(w, [...inFeatured]);
    for (const k of ['national', 'regional', 'local']) {
      if (k === featTier) continue;
      const size = d.week.background[k];
      if (!(size > 0)) continue;
      const ids = pool.splice(0, size);
      if (k === 'local') {
        for (const id of this.field.juniors) {
          const p = this.field.players.get(id);
          if (p.localOnly && !inFeatured.has(id) && rngFor(this.seed, `wcb:${w}:${id}`)() < p.wildcardChance) ids.push(id);
        }
      }
      if (ids.length < 2) continue;
      const surface = TOUR_SURFACES[Math.floor(rngFor(this.seed, `bgs:${w}:${k}`)() * TOUR_SURFACES.length)];
      this._runEvent(ids, k, surface, w, `bg:${w}:${k}`, weekPts);
    }
  }

  /** A whole simulated event (the background): seeded draw, every round, points into `out`. */
  _runEvent(ids, tierKey, surface, w, key, out) {
    const tier = this.data.tiers[tierKey];
    let size = 2;
    while (size < ids.length) size *= 2;
    const ranked = ids.slice().sort((a, b) => this._byRanking(a, b));
    const nSeeds = size >= 8 ? size / 4 : 0;
    const seeded = ranked.slice(0, nSeeds);
    const others = ranked.slice(nSeeds);
    const rand = rngFor(this.seed, `${key}:draw`);
    const draw = { tid: null, week: w, size, slots: buildDrawSlots(size, seeded, others, rand), res: Array.from({ length: size - 1 }, () => [-1, '', 0]), seeds: {} };
    const n = roundsOf(size);
    for (let r = 0; r < n; r++) {
      const off = matchOffset(size, r);
      const code = roundCode(size, r);
      for (let i = 0; i < matchesIn(size, r); i++) {
        const [a, b] = drawParticipants(draw, r, i);
        const res = draw.res[off + i];
        if (a === null || b === null || a === undefined || b === undefined) { res[0] = a ? 0 : 1; res[1] = 'bye'; continue; }
        const m = this._simPair(a, b, w, surface, tier.formats[code] || 'set', `${key}:${r}:${i}`);
        res[0] = m.winner; res[1] = m.score;
      }
    }
    // Background events are the week's smaller satellite events: week.backgroundPoints of the tier's table
    const pts = tier.points, f = this.data.week.backgroundPoints;
    for (const [id, s] of this._standing(draw)) {
      const p = s.champion ? (pts.W || 0) : (pts[roundCode(size, Math.min(s.r, n - 1))] || 0);
      out.set(id, (out.get(id) || 0) + Math.round(p * f));
    }
  }

  /** At acceptance: the field's last `window` weeks, so the ranking starts full (the player unranked). */
  _prehistory(w0) {
    const W = this.data.ranking.window;
    this.draw = null;
    for (let w = w0 - W; w < w0; w++) {
      this.curWeek = w;
      this._finalizeWeek(w);
    }
    this.curWeek = w0;
    this._rankCache = null;
  }

  _startRating() {
    const rw = this.rafaWins;
    const wins = this._profileWins();
    const est = 1150 + 40 * rw.easy + 90 * rw.medium + 150 * rw.hard;
    return clamp(Math.round(rw.easy + rw.medium + rw.hard > 0 ? est : 1150 + 30 * Math.min(10, wins)), 1100, 1700);
  }

  // ───────────────────────────── money, UI side effects ─────────────────────────────

  _day() {
    const w = this.game.weather;
    return w && Number.isInteger(w.day) && w.day >= 1 ? w.day : 1;
  }

  _profileWins() {
    const p = this.game.profile;
    return p && p.record && fin(p.record.wins) ? p.record.wins : 0;
  }

  _wallet() {
    const g = this.game;
    if (g.shift && fin(g.shift.wallet)) return g.shift.wallet;
    if (g.profile && fin(g.profile.wallet)) return g.profile.wallet;
    return 0;
  }

  _spend(amount, label) {
    const g = this.game;
    if (g.profile && typeof g.profile.spend === 'function') return !!g.profile.spend(amount, label);
    if (g.shift && fin(g.shift.wallet) && g.shift.wallet >= amount) { g.shift.wallet -= amount; return true; }
    return false;
  }

  _refund(amount) {
    const sh = this.game.shift;
    if (!sh || !(amount > 0)) return;
    if (typeof sh.refund === 'function') sh.refund(amount, 'refund');
    else if (fin(sh.wallet)) sh.wallet += amount;
  }

  _payPrize(amount, label) {
    const sh = this.game.shift;
    if (!sh || !(amount > 0)) return;
    if (typeof sh.earnPrize === 'function') sh.earnPrize(amount, label);
    else if (typeof sh._earn === 'function') sh._earn(amount, 'bonus');
    else if (fin(sh.wallet)) sh.wallet += amount;
  }

  _venueShort(t) {
    const v = this.data.venueById.get(t.venue);
    return v ? v.short : t.venue;
  }

  _nameOf(id) {
    const p = this.field && this.field.players.get(id);
    return p ? p.name : String(id);
  }

  // Saved lists come back from their packed arrays (see pack* below)
  _unpackHistory(a) {
    const [week, day, tid, round, oppId, opponent, won, score, wo] = a;
    const t = this.data.tournamentById.get(tid);
    return {
      week, day, tid, tournament: t ? t.name : tid, venue: t ? this._venueShort(t) : '', round, roundLabel: round, roundName: ROUND_LABELS[round] || round,
      oppId: oppId || null, opponent: opponent || (oppId ? this._nameOf(oppId) : 'Unknown'), won: !!won, score, wo: !!wo,
    };
  }

  _unpackTitle(a) {
    const [tid, week, day, name, tier] = a;
    const t = this.data.tournamentById.get(tid);
    return { name: t ? t.name : name, tid, week, venue: t ? this._venueShort(t) : '', tier: t ? t.tier : tier, day };
  }

  _unpackResult(a) {
    const [week, tid, round, points] = a;
    const t = this.data.tournamentById.get(tid);
    return { week, tid, tournament: t ? t.name : tid, round, points };
  }

  _pushHistory(e) {
    this.me.history.push(e);
    if (this.me.history.length > HISTORY_MAX) this.me.history.splice(0, this.me.history.length - HISTORY_MAX);
  }

  _trimH2H() {
    const keys = Object.keys(this.me.h2h);
    if (keys.length <= H2H_MAX) return;
    keys.sort((a, b) => (this.me.h2h[a].w + this.me.h2h[a].l) - (this.me.h2h[b].w + this.me.h2h[b].l));
    for (let i = 0; i < keys.length - H2H_MAX; i++) delete this.me.h2h[keys[i]];
  }

  _toast(text, icon) {
    if (this._quiet || !this.onToast) return;
    try { this.onToast(text, icon); } catch (e) { /* cosmetic */ }
  }

  _celebrate(kind) {
    if (this._quiet || !this.onCelebrate) return;
    try { this.onCelebrate(kind); } catch (e) { /* cosmetic */ }
  }

  _markersChanged() {
    if (!this.onMarkers) return;
    try { this.onMarkers(); } catch (e) { /* cosmetic */ }
  }

  _changed(kind) {
    this._rankCache = null;
    // Hank's crossroads just became due: point the player at him (once)
    const hp = this.hankPending;
    if (hp && !this._hankWas) this._toast(`Top ${this.data.hank.rank} in the junior rankings! Hank Morris wants a word with you.`, 'talk');
    this._hankWas = hp;
    this._markersChanged();
    if (this.onChange) { try { this.onChange(kind); } catch (e) { console.warn('Tour onChange:', e); } }
  }

  // ───────────────────────────── save / load ─────────────────────────────

  getState() {
    const ring = {};
    for (const [id, arr] of this.ring) if (arr.some(x => x > 0)) ring[id] = arr.slice();
    const rd = {};
    for (const [id, v] of this.rd) if (Math.abs(v) >= 0.5) rd[id] = Math.round(v * 10) / 10;
    return {
      v: 1,
      seed: this.seed,
      accepted: this.accepted,
      career: this.career,
      acceptedDay: this.acceptedDay,
      origin: this.origin,
      proFromWeek: this.proFromWeek,
      hank: { ...this.hank },
      offer: { ...this.offer },
      rafaWins: { ...this.rafaWins },
      lastDay: this.lastDay,
      curWeek: this.curWeek,
      ring, rd,
      // Lists are packed into arrays (names and labels come back from the data and the seeded field)
      me: {
        ring: this.me.ring.slice(), rating: Math.round(this.me.rating * 10) / 10, w: this.me.w, l: this.me.l,
        prize: this.me.prize, adj: this.me.adj,
        titles: this.me.titles.map(packTitle), history: this.me.history.map(packHistory),
        h2h: packH2H(this.me.h2h), results: this.me.results.map(packResult),
      },
      entry: this.entry ? { ...this.entry } : null,
      draw: this.draw ? { tid: this.draw.tid, week: this.draw.week, size: this.draw.size, slots: this.draw.slots.slice(), res: this.draw.res.map(x => x.slice()), seeds: { ...this.draw.seeds } } : null,
      pub: this.pubRanks ? { ...this.pubRanks } : null,
      prev: this.prevRanks ? { ...this.prevRanks } : null,
    };
  }

  /** Restore (sanitizeTour output). Rebuilds the field from the seed, then catches up to today. */
  setState(s) {
    if (!isObj(s)) return;
    this.seed = s.seed >>> 0 || this.seed;
    this.field = null;
    this.accepted = !!s.accepted;
    this.career = CAREERS.includes(s.career) ? s.career : 'amateur';
    this.acceptedDay = s.acceptedDay | 0;
    this.origin = s.origin | 0;
    this.proFromWeek = Number.isInteger(s.proFromWeek) ? s.proFromWeek : -1;
    this.hank = { decided: false, reached: false, snoozeUntil: 0, asked: 0, choice: null, ...(s.hank || {}) };
    this.offer = { shownDay: -1, declined: 0, ...(s.offer || {}) };
    this.rafaWins = { easy: 0, medium: 0, hard: 0, ...(s.rafaWins || {}) };
    // The tour can't be ahead of the clock (a crafted or mismatched save): it restarts at today
    const today = this._day();
    this.lastDay = Math.min(s.lastDay | 0, today);
    this.curWeek = Number.isInteger(s.curWeek) ? s.curWeek : tourWeekOf(today);
    const ahead = this.curWeek > tourWeekOf(today);
    if (ahead) { this.curWeek = tourWeekOf(today); this.lastDay = today; }
    this.ring = new Map();
    this.rd = new Map();
    this.me = createMe();
    this.entry = s.entry && !ahead ? { ...s.entry } : null;
    this.draw = null;
    this.pubRanks = s.pub ? { ...s.pub } : null;
    this.prevRanks = s.prev ? { ...s.prev } : null;
    this._rankCache = null;
    this._lastWins = this._profileWins();
    if (!this.available) return;
    this._ensureField();
    const known = (id) => id === ME || this.field.players.has(id);
    for (const [id, arr] of Object.entries(s.ring || {})) if (this.field.players.has(id)) this.ring.set(id, arr.slice(0, RING).concat(new Array(Math.max(0, RING - arr.length)).fill(0)));
    for (const [id, v] of Object.entries(s.rd || {})) if (this.field.players.has(id)) this.rd.set(id, v);
    const m = s.me || {};
    if (Array.isArray(m.ring)) this.me.ring = m.ring.slice(0, RING).concat(new Array(Math.max(0, RING - m.ring.length)).fill(0));
    if (fin(m.rating)) this.me.rating = m.rating;
    this.me.w = m.w | 0; this.me.l = m.l | 0;
    this.me.prize = fin(m.prize) ? m.prize : 0;
    this.me.adj = m.adj | 0;
    this.me.titles = Array.isArray(m.titles) ? m.titles.map(a => this._unpackTitle(a)) : [];
    this.me.history = Array.isArray(m.history) ? m.history.map(a => this._unpackHistory(a)) : [];
    this.me.h2h = {};
    if (isObj(m.h2h)) for (const [id, a] of Object.entries(m.h2h)) this.me.h2h[id] = { w: a[0] | 0, l: a[1] | 0, name: this._nameOf(id) };
    this.me.results = Array.isArray(m.results) ? m.results.map(a => this._unpackResult(a)) : [];
    // The draw only if it still matches the data (a hand-edited tour.json may have changed the rotation)
    const dr = s.draw;
    if (dr && this.accepted && !ahead && dr.week === this.curWeek) {
      const t = this.featuredFor(dr.week);
      if (t && t.id === dr.tid && t.draw === dr.size && dr.slots.every(id => id === null || known(id))) {
        this.draw = { tid: dr.tid, week: dr.week, size: dr.size, slots: dr.slots.slice(), res: dr.res.map(x => x.slice()), seeds: { ...(dr.seeds || {}) } };
      }
    }
    if (this.entry && (!this.accepted || !this.data.tournamentById.has(this.entry.tid))) this.entry = null;
    if (this.accepted) this._sync();
    this._hankWas = this.hankPending;   // (no "Hank wants a word" toast just for loading)
    if (this.onCareer) { try { this.onCareer(this.career, { chosen: false }); } catch (e) { console.warn(e); } }
    this._markersChanged();
  }

  // ───────────────────────────── dev helpers (window.__tour in DEV builds) ─────────────────────────────

  /** Give the profile enough Rafa wins to unlock the tour; the offer follows. */
  debugUnlock() {
    const p = this.game.profile;
    if (p && typeof p.recordMatch === 'function') {
      let guard = 0;
      while (this._profileWins() < this.data.unlock.rafaWins && guard++ < 10) p.recordMatch({ won: true, setsWon: 1, setsLost: 0 });
    }
    // The third recorded win usually makes the offer itself (profile 'record'); otherwise make it now
    if (this.offer.shownDay !== this._day()) this._offer('debug');
    return this.offerPending;
  }

  debugAccept() { return this.accept('debug'); }

  /** Put the player at ranking #n (adjusts a debug points offset). */
  debugSetRank(n = 10) {
    if (!this.accepted) this.accept('debug');
    this._sync();
    this.me.adj = 0;
    this._rankCache = null;
    const others = this._ranking().list.filter(e => e.id !== ME);
    const mine = this._points(ME, this._provisional());
    const target = n <= 1 ? (others[0] ? others[0].pts + 1 : 1) : (others[n - 1] ? others[n - 1].pts + 1 : 1);
    const above = n >= 2 && others[n - 2] ? others[n - 2].pts : Infinity;
    this.me.adj = Math.max(0, Math.min(target, above - 1) - mine);
    if (this.me.adj === 0 && mine <= 0) this.me.adj = 1;
    this._changed('debug');
    return this.myRank();
  }

  /** Hank's crossroads now (top 10 and no snooze). */
  debugHank() {
    this.debugSetRank(Math.min(this.data.hank.rank, 8));
    this.hank.snoozeUntil = 0;
    this.hank.decided = false;
    if (this.career !== 'amateur') this.career = 'amateur';
    this._changed('debug');
    return this.hankPending;
  }

  debugCareer(c) { if (!this.accepted) this.accept('debug'); this.hank.decided = false; this.career = 'amateur'; return this.chooseCareer(c); }

  /** Play tonight's match instantly: won true / false / a win probability (0..1). */
  debugPlayTonight(won = true) {
    const spec = this.getTonight();
    if (!spec) return null;
    const w = typeof won === 'number' ? Math.random() < won : !!won;
    const fmt = spec.format;
    const sets = fmt === 'short' ? (w ? '4-2' : '2-4') : fmt === 'bo3' ? (w ? '6-4 4-6 6-3' : '4-6 6-4 3-6') : (w ? '6-3' : '3-6');
    return this.onMatchResult({ tournamentId: spec.tournamentId, round: spec.round, won: w, score: sets });
  }

  /**
   * Advance the game n weeks (dev only: moves weather.day). Each day: enter this week's event when
   * possible (opts.enter, default true), play tonight's match (opts.result: 'win' | 'lose' | 'skip'
   * | a win probability, default 0.6), then the next day.
   */
  debugSimWeeks(n = 1, { result = 0.6, enter = true } = {}) {
    if (!this.accepted) this.accept('debug');
    const g = this.game;
    for (let k = 0; k < Math.max(1, n | 0) * 7; k++) {
      this._sync();
      const t = this.featuredFor(this.curWeek);
      if (enter && t && this._entryInfo(t).ok) this.enter(t.id);
      if (result !== 'skip') {
        let guard = 0;
        while (this.getTonight() && guard++ < 3) this.debugPlayTonight(result === 'win' ? true : result === 'lose' ? false : result);
      }
      const w = g.weather;
      if (w) {
        if (typeof w.startNewDay === 'function') w.startNewDay(fin(w.timeOfDay) ? w.timeOfDay : 7);
        else w.day = (w.day || 1) + 1;
      }
      this.onNewDay(this._day());
    }
    return this.getHub();
  }
}

function createMe() {
  return { ring: new Array(RING).fill(0), rating: 1150, w: 0, l: 0, prize: 0, adj: 0, titles: [], history: [], h2h: {}, results: [] };
}

// Packed save forms (arrays keep the tour section small: ~60 matches of history in ~6 KB)
//   history [week, day, tid, round, oppId, opponent, won 0|1, score, wo 0|1]
//   titles  [tid, week, day, name, tier]      results [week, tid, round, points]      h2h { id: [w, l] }
const packHistory = (e) => [e.week, e.day, e.tid, e.round, e.oppId || '', e.opponent || '', e.won ? 1 : 0, e.score || '', e.wo ? 1 : 0];
const packTitle = (e) => [e.tid, e.week, e.day, e.name, e.tier];
const packResult = (e) => [e.week, e.tid, e.round, e.points];
function packH2H(h) {
  const out = {};
  for (const [id, v] of Object.entries(h)) out[id] = [v.w, v.l];
  return out;
}

// ───────────────────────────── save sanitizer (SaveSystem) ─────────────────────────────

const sStr = (v, max = 80) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const sInt = (v, d, lo, hi) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : d);
const sNum = (v, d, lo, hi) => (fin(v) ? Math.min(hi, Math.max(lo, v)) : d);
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

function sRing(a) {
  if (!Array.isArray(a)) return null;
  const out = [];
  for (let i = 0; i < RING; i++) out.push(sInt(Math.round(Number(a[i]) || 0), 0, 0, 100000));
  return out;
}

function sRankMap(o) {
  if (!isObj(o)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (n >= 240) break;
    if (ID_RE.test(k) && Number.isInteger(v) && v >= 1 && v <= 1000) { out[k] = v; n++; }
  }
  return out;
}

/**
 * Keep a loaded tour section sane: plain JSON only, clamped numbers, capped sizes (≤ ~25 KB).
 * Returns null for anything that isn't a tour state object.
 */
export function sanitizeTour(raw) {
  if (!isObj(raw)) return null;
  const hank = isObj(raw.hank) ? raw.hank : {};
  const offer = isObj(raw.offer) ? raw.offer : {};
  const rw = isObj(raw.rafaWins) ? raw.rafaWins : {};
  const ring = {};
  let nRing = 0;
  if (isObj(raw.ring)) {
    for (const [k, v] of Object.entries(raw.ring)) {
      if (nRing >= 200) break;
      const r = ID_RE.test(k) ? sRing(v) : null;
      if (r) { ring[k] = r; nRing++; }
    }
  }
  const rd = {};
  let nRd = 0;
  if (isObj(raw.rd)) {
    for (const [k, v] of Object.entries(raw.rd)) {
      if (nRd >= 200) break;
      if (ID_RE.test(k) && fin(v)) { rd[k] = Math.max(-150, Math.min(150, Math.round(v * 10) / 10)); nRd++; }
    }
  }
  // The player's lists, packed (see packHistory / packTitle / packResult / packH2H)
  const m = isObj(raw.me) ? raw.me : {};
  const arrs = (v, max, len) => (Array.isArray(v) ? v.filter(a => Array.isArray(a) && a.length >= len).slice(-max) : []);
  const hist = arrs(m.history, HISTORY_MAX, 9).map(a => [
    sInt(a[0], 0, -1e5, 1e5), sInt(a[1], 0, 0, 1e6), sStr(a[2], 60) || '', sStr(a[3], 8) || '', sStr(a[4], 40) || '',
    sStr(a[5]) || '', a[6] ? 1 : 0, sStr(a[7], 40) || '', a[8] ? 1 : 0,
  ]);
  const titles = arrs(m.titles, TITLES_MAX, 5).map(a => [
    sStr(a[0], 60) || '', sInt(a[1], 0, -1e5, 1e5), sInt(a[2], 0, 0, 1e6), sStr(a[3]) || '', TIER_ORDER.includes(a[4]) ? a[4] : 'local',
  ]);
  const h2h = {};
  let nH = 0;
  if (isObj(m.h2h)) {
    for (const [k, v] of Object.entries(m.h2h)) {
      if (nH >= H2H_MAX) break;
      if (!ID_RE.test(k) || !Array.isArray(v)) continue;
      h2h[k] = [sInt(v[0], 0, 0, 9999), sInt(v[1], 0, 0, 9999)];
      nH++;
    }
  }
  const results = arrs(m.results, RESULTS_MAX, 4).map(a => [
    sInt(a[0], 0, -1e5, 1e5), sStr(a[1], 60) || '', sStr(a[2], 8) || '', sInt(Math.round(Number(a[3]) || 0), 0, 0, 100000),
  ]);
  let entry = null;
  if (isObj(raw.entry) && sStr(raw.entry.tid, 60)) {
    entry = {
      tid: raw.entry.tid, week: sInt(raw.entry.week, 0, -1e5, 1e5), fee: sNum(raw.entry.fee, 0, 0, 1e6),
      wildcard: !!raw.entry.wildcard, day: sInt(raw.entry.day, 0, 0, 1e6),
    };
  }
  let draw = null;
  const dr = raw.draw;
  if (isObj(dr) && sStr(dr.tid, 60) && DRAW_SIZES.includes(dr.size) && Array.isArray(dr.slots) && dr.slots.length === dr.size
    && Array.isArray(dr.res) && dr.res.length === dr.size - 1) {
    const slots = dr.slots.map(x => (x === null ? null : (typeof x === 'string' && ID_RE.test(x) ? x : undefined)));
    const res = dr.res.map(x => (Array.isArray(x) ? [sInt(x[0], -1, -1, 1), typeof x[1] === 'string' ? x[1].slice(0, 40) : '', sInt(x[2], 0, 0, 1e6)] : null));
    if (!slots.includes(undefined) && !res.includes(null)) {
      const seeds = {};
      if (isObj(dr.seeds)) for (const [k, v] of Object.entries(dr.seeds)) if (ID_RE.test(k) && Number.isInteger(v) && v >= 1 && v <= 32) seeds[k] = v;
      draw = { tid: dr.tid, week: sInt(dr.week, 0, -1e5, 1e5), size: dr.size, slots, res, seeds };
    }
  }
  const out = {
    v: 1,
    seed: (Number.isInteger(raw.seed) && raw.seed > 0 && raw.seed <= 4294967295) ? raw.seed : 1,
    accepted: !!raw.accepted,
    career: CAREERS.includes(raw.career) ? raw.career : 'amateur',
    acceptedDay: sInt(raw.acceptedDay, 0, 0, 1e6),
    origin: sInt(raw.origin, 0, -1e5, 1e5),
    proFromWeek: sInt(raw.proFromWeek, -1, -1, 1e5),
    hank: {
      decided: !!hank.decided, reached: !!hank.reached, snoozeUntil: sInt(hank.snoozeUntil, 0, 0, 1e6), asked: sInt(hank.asked, 0, 0, 9999),
      choice: hank.choice === 'pro' || hank.choice === 'grounds' ? hank.choice : null,
    },
    offer: { shownDay: sInt(offer.shownDay, -1, -1, 1e6), declined: sInt(offer.declined, 0, 0, 9999) },
    rafaWins: { easy: sInt(rw.easy, 0, 0, 1e6), medium: sInt(rw.medium, 0, 0, 1e6), hard: sInt(rw.hard, 0, 0, 1e6) },
    lastDay: sInt(raw.lastDay, 0, 0, 1e6),
    curWeek: sInt(raw.curWeek, 0, -1e5, 1e5),
    ring, rd,
    me: {
      ring: sRing(m.ring) || new Array(RING).fill(0), rating: sNum(m.rating, 1150, 600, 3000),
      w: sInt(m.w, 0, 0, 1e6), l: sInt(m.l, 0, 0, 1e6), prize: sNum(m.prize, 0, 0, 1e9), adj: sInt(m.adj, 0, 0, 1e6),
      titles, history: hist, h2h, results,
    },
    entry, draw,
    pub: sRankMap(raw.pub),
    prev: sRankMap(raw.prev),
  };
  // Hard cap on size (a crafted save can't bloat the slot): drop the oldest history first
  try {
    let json = JSON.stringify(out);
    while (json.length > 30000 && out.me.history.length > 10) {
      out.me.history.splice(0, 10);
      json = JSON.stringify(out);
    }
  } catch (e) { /* plain data */ }
  return out;
}
