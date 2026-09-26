/**
 * MissionGenerator — builds fresh, valid missions from parameterised templates
 * (public/data/missions.json → "templates") and the live world: members and their
 * relationships / request pools (npcs.json), areas and item spots (map.json), the court
 * schedule (schedule.json, incl. event additions), the weather, the day, the rank and
 * today's club event (EventSystem).
 *
 * Pure data code (no DOM / three.js): MissionSystem uses it at runtime and
 * `npm run validate` samples every template with it. Every mission it returns has
 * already passed MissionValidation (missionErrors) against the world facts, so a dead
 * mission is never offered. Items come from InventorySystem ITEMS (read live, so items
 * another system adds later are used too; unknown ones are stocked at templates.itemSources["*"]).
 *
 * Template (missions.json → templates.list[]):
 *   { id, type, sources: ['taskBoard'|'radio'|'random'], weight, cooldownDays,
 *     minDay, minRank, hours: [from, to], weather: [...], afterRain: bool, events: [...],
 *     roles: { name: roleSpec, ... },            resolved in order
 *     client: role, trigger: role (random),      npc roles
 *     title, description: text | [texts],
 *     steps: [ { action, prompt, npc|item|location|target: role, lines, choices } ],
 *     builder: 'request'                         (special: member request from npcs.json requests) }
 *
 * roleSpec:
 *   { npc: 'member'|'staff'|'any', ids, archetypes, notArchetypes, hasRel: [types],
 *     related: role, rel: [types], matchPlayer: role, not: [roles] }
 *   { item: [ids] | 'any', ownedBy: staffRole (templates.staffItems), stockedAt: areaRole (itemSources) }
 *   { area: [ids] | 'itemSource' | 'itemHome' | 'npcArea' | 'staffArea' | 'court' | 'upcomingMatch',
 *     of: role, surface: 'hard'|'clay', within: [h0, h1], not: [roles] }
 *   { text: [strings] }
 *
 * Text fills: {role} (npc name / item phrase / place phrase / text), {role.first},
 * {role.label} (area label), {Role} (capitalised), {role.time} (match start).
 * Dialogue lines: strings (said by the step's npc) or { by: role, text }, where text may
 * be an archetype map { entitled: ..., '*': ... }; "greet": true opens with one of the
 * speaker's own greetings, "thanks": true closes with one of their own satisfied lines.
 */
import { missionErrors, parseHour } from './MissionValidation.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArr = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** Default place phrases (templates.areaNames overrides). Courts use "Court N". */
const AREA_PHRASES = {
  proShop: 'the pro shop', patio: 'the patio', garden: 'the garden', equipmentShed: 'the equipment shed',
  clubhouseLobby: 'the clubhouse lobby', memberLounge: "the members' lounge", cafe: 'the café',
  lockerRoom: 'the locker rooms', fitnessCenter: 'the fitness centre', poolHouse: 'the pool house', pool: 'the pool',
};

/** Words in a member request that name an item (first match wins). */
const ITEM_WORDS = [
  ['towels', /\btowels?\b/i],
  ['ball_hopper', /\b(hopper|balls|ball bucket|bucket)\b/i],
  ['water_bottles', /\b(water|drinks?|lemonade|parched|thirsty|running dry)\b/i],
  ['racket', /\bracket\b/i],
];
/** Words in a member request that name a place. */
const PLACE_WORDS = [
  ['proShop', /pro shop/i], ['patio', /\bpatio\b/i], ['garden', /\bgarden\b/i], ['lockerRoom', /locker/i],
  ['pool', /\bpool\b(?! house)/i], ['poolHouse', /pool house/i], ['cafe', /\bcaf[eé]\b/i],
  ['memberLounge', /\blounge\b/i], ['fitnessCenter', /\b(gym|fitness)\b/i], ['equipmentShed', /\bshed\b/i],
];

export class MissionGenerator {
  /**
   * @param {object} o
   * @param {object} o.templates  missions.json → templates ({ list, itemSources, itemHomes, staffAreas, areaNames, itemNames, topics })
   * @param {object} o.npcs       npcs.json
   * @param {object} o.map        map.json
   * @param {object} [o.schedule] schedule.json (EventSystem may replace it with setSchedule)
   * @param {object} o.items      InventorySystem ITEMS (read live)
   * @param {object} o.facts      MissionValidation.buildWorldFacts(...)
   */
  constructor(o = {}) {
    const t = isObj(o.templates) ? o.templates : {};
    this.list = (Array.isArray(t.list) ? t.list : []).filter(x => isObj(x) && typeof x.id === 'string' && x.id);
    this.byId = new Map(this.list.map(x => [x.id, x]));
    this.itemSources = isObj(t.itemSources) ? t.itemSources : {};
    this.itemHomes = isObj(t.itemHomes) ? t.itemHomes : {};
    this.staffAreas = isObj(t.staffAreas) ? t.staffAreas : {};
    this.staffItems = isObj(t.staffItems) ? t.staffItems : {};
    this.areaNames = { ...AREA_PHRASES, ...(isObj(t.areaNames) ? t.areaNames : {}) };
    this.itemNames = isObj(t.itemNames) ? t.itemNames : {};
    this.requestLines = isObj(t.requestLines) ? t.requestLines : {};
    this.items = o.items || {};
    this.facts = o.facts || {};
    this.map = o.map || {};
    this.npcList = (isObj(o.npcs) && Array.isArray(o.npcs.npcs) ? o.npcs.npcs : []).filter(n => isObj(n) && n.id);
    this.npcById = new Map(this.npcList.map(n => [n.id, n]));
    this.courts = (isObj(this.map.areas) && Array.isArray(this.map.areas.courts) ? this.map.areas.courts : []).filter(c => isObj(c) && c.id);
    this.setSchedule(o.schedule);
  }

  /** Court schedule used by 'upcomingMatch' roles (EventSystem passes the merged event schedule). */
  setSchedule(schedule) {
    const list = isObj(schedule) && Array.isArray(schedule.matches) ? schedule.matches : [];
    this.matches = [];
    for (const m of list) {
      if (!isObj(m)) continue;
      const start = parseHour(m.start);
      const courts = asArr(m.court).filter(c => this._isArea(c));
      if (!Number.isFinite(start) || !courts.length) continue;
      this.matches.push({ id: m.id || '', start, courts, players: asArr(m.players).filter(p => this.npcById.has(p)) });
    }
  }

  templateIds() { return this.list.map(t => t.id); }

  _isArea(id) { return !this.facts.areaIds || this.facts.areaIds.has(id); }

  // ───────────────────────────── eligibility ─────────────────────────────

  /** Can template `tpl` be offered from `source` in this context (day, rank, hours, weather, event)? */
  eligible(tpl, source, ctx) {
    if (!tpl || !asArr(tpl.sources || ['taskBoard']).includes(source)) return false;
    if (Number.isFinite(tpl.minDay) && (ctx.day || 1) < tpl.minDay) return false;
    if (Number.isFinite(tpl.minRank) && (ctx.rankIndex || 0) < tpl.minRank) return false;
    if (Number.isFinite(tpl.maxRank) && (ctx.rankIndex || 0) > tpl.maxRank) return false;
    const h = tpl.hours;
    if (Array.isArray(h) && h.length === 2 && ctx.hour !== undefined && !(ctx.hour >= h[0] && ctx.hour < h[1])) return false;
    if (Array.isArray(tpl.weather) && ctx.weather && !tpl.weather.includes(ctx.weather)) return false;
    if (tpl.afterRain && !(ctx.weather === 'rainy' || (ctx.hoursSinceRain ?? 99) < 3)) return false;
    if (Array.isArray(tpl.events) && !tpl.events.includes(ctx.eventId)) return false;
    return true;
  }

  // ───────────────────────────── generation ─────────────────────────────

  /**
   * One fresh mission for `source`, or null. Templates are weighted (template weight ×
   * event boost × ctx.templateFactor); fills avoid anything ctx.isBlocked() rejects.
   * opts.trigger forces the trigger NPC (random encounters next to the player).
   */
  generate(source, ctx = {}, opts = {}) {
    const rand = ctx.rand || Math.random;
    let pool = this.list.filter(t => this.eligible(t, source, ctx));
    if (opts.trigger) pool = pool.filter(t => t.builder === 'request' || t.trigger);
    if (opts.exclude) pool = pool.filter(t => !opts.exclude.has(t.id));
    const weightOf = (t) => {
      let w = templateWeight(t, source);
      const boost = ctx.eventBoost && ctx.eventBoost[t.id];
      if (Number.isFinite(boost)) w *= boost;
      if (ctx.templateFactor) w *= ctx.templateFactor(t.id);
      return Math.max(0, w);
    };
    for (let attempt = 0; attempt < 8 && pool.length; attempt++) {
      const tpl = weightedPick(pool, weightOf, rand);
      if (!tpl) break;
      const m = this.instantiate(tpl, source, ctx, opts);
      if (m) return m;
      pool = pool.filter(t => t !== tpl); // this template has nothing fresh right now
    }
    return null;
  }

  /** Try to build `tpl` with random fills (a few tries). Returns a validated mission or null. */
  instantiate(tpl, source, ctx = {}, opts = {}) {
    for (let i = 0; i < 6; i++) {
      const m = tpl.builder === 'request' ? this._buildRequest(tpl, source, ctx, opts) : this._build(tpl, source, ctx, opts);
      if (!m) continue;
      if (ctx.isBlocked && ctx.isBlocked(m)) continue;
      if (missionErrors(m, this.facts).length) continue;
      return m;
    }
    return null;
  }

  /** Validator helper: up to `n` distinct missions from `tpl` across varied contexts (ignores gates). */
  sample(tpl, n = 12, rand = Math.random) {
    const out = [];
    const seen = new Set();
    const src = asArr(tpl.sources || ['taskBoard'])[0];
    for (let i = 0; i < n * 4 && out.length < n; i++) {
      const ctx = { day: 99, rankIndex: 9, hour: 12, weather: 'sunny', hoursSinceRain: 0, rand, sampleAnyMatch: true, eventId: asArr(tpl.events)[0] };
      const m = tpl.builder === 'request' ? this._buildRequest(tpl, src, ctx, {}) : this._build(tpl, src, ctx, {});
      if (!m || seen.has(m.sig)) continue;
      seen.add(m.sig);
      out.push(m);
    }
    return out;
  }

  // ───────────────────────────── roles ─────────────────────────────

  _npcName(n) { return (n && n.name) || ''; }

  _first(n) {
    const name = this._npcName(n);
    if (/^(Mrs?\.|Ms\.)\s/.test(name)) return name;
    return name.replace(/^(Coach|Dr\.)\s+/, '').split(' ')[0];
  }

  _areaLabel(id) {
    const c = this.courts.find(k => k.id === id);
    if (c) return c.label || id;
    const a = isObj(this.map.areas) ? this.map.areas[id] : null;
    return (a && a.label) || id;
  }

  _areaPhrase(id) {
    if (this.courts.some(c => c.id === id)) return this._areaLabel(id);
    return this.areaNames[id] || this._areaLabel(id);
  }

  _itemPhrase(id) {
    return this.itemNames[id] || ((this.items[id] && this.items[id].name) || id).toLowerCase();
  }

  /** Areas where `npc` hangs out (preferredAreas that the game can detect; staff: their post area). */
  _npcAreas(n) {
    if (!n) return [];
    const staff = this.staffAreas[n.id];
    const out = [];
    if (staff && this._isArea(staff)) out.push(staff);
    for (const a of asArr(n.preferredAreas)) if (this._isArea(a) && !out.includes(a)) out.push(a);
    if (!out.length && this._isArea('patio')) out.push('patio');
    return out;
  }

  _itemSourceAreas(item) {
    const s = this.itemSources[item] || this.itemSources['*'] || ['proShop'];
    return asArr(s).filter(a => this._isArea(a));
  }

  _itemHome(item) {
    const h = this.itemHomes[item] || this._itemSourceAreas(item)[0];
    return this._isArea(h) ? h : null;
  }

  _isStaff(n) { return !!n && n.archetype === 'staff'; }

  /** Candidate values for a role, given the fills so far. Values: { kind, id, npc?, ... }. */
  _candidates(spec, fills, ctx) {
    const notIds = new Set(asArr(spec.not).map(r => fills[r] && fills[r].id).filter(Boolean));
    if (spec.npc !== undefined || spec.related || spec.matchPlayer) {
      let list = this.npcList;
      if (spec.npc === 'member') list = list.filter(n => !this._isStaff(n));
      else if (spec.npc === 'staff') list = list.filter(n => this._isStaff(n));
      if (spec.ids) list = list.filter(n => spec.ids.includes(n.id));
      if (spec.archetypes) list = list.filter(n => spec.archetypes.includes(n.archetype));
      if (spec.notArchetypes) list = list.filter(n => !spec.notArchetypes.includes(n.archetype));
      if (spec.hasRel) list = list.filter(n => isObj(n.relationships) && Object.values(n.relationships).some(r => r && spec.hasRel.includes(r.type)));
      if (spec.related) {
        const base = fills[spec.related] && fills[spec.related].npc;
        const rel = base && isObj(base.relationships) ? base.relationships : {};
        list = list.filter(n => rel[n.id] && (!spec.rel || spec.rel.includes(rel[n.id].type)));
      }
      if (spec.matchPlayer) {
        const m = fills[spec.matchPlayer] && fills[spec.matchPlayer].match;
        list = m ? list.filter(n => m.players.includes(n.id)) : [];
      }
      for (const f of Object.values(fills)) if (f && f.kind === 'npc') notIds.add(f.id); // one person per role
      if (ctx.busyNpcs) list = list.filter(n => !ctx.busyNpcs.has(n.id));
      return list.filter(n => !notIds.has(n.id) && (!this.facts.npcIds || this.facts.npcIds.has(n.id)))
        .map(n => ({ kind: 'npc', id: n.id, npc: n, w: ctx.npcWeight ? ctx.npcWeight(n.id) : 1 }));
    }
    if (spec.item !== undefined) {
      const all = Object.keys(this.items);
      let ids = spec.item === 'any' ? all : asArr(spec.item).filter(id => all.includes(id));
      // ownedBy: a staff role → only what that staff member hands out / takes back (templates.staffItems)
      if (spec.ownedBy) {
        const o = fills[spec.ownedBy];
        const own = o && this.staffItems[o.id];
        ids = own ? ids.filter(id => asArr(own).includes(id)) : [];
      }
      // stockedAt: an area role → only items that area stocks (templates.itemSources)
      if (spec.stockedAt) {
        const a = fills[spec.stockedAt];
        ids = a ? ids.filter(id => this._itemSourceAreas(id).includes(a.id)) : [];
      }
      return ids.filter(id => !notIds.has(id)).map(id => ({ kind: 'item', id }));
    }
    if (spec.area !== undefined) {
      let ids = [];
      let match = null;
      const of = spec.of && fills[spec.of];
      switch (spec.area) {
        case 'itemSource': ids = of ? this._itemSourceAreas(of.id) : []; break;
        case 'itemHome': { const h = of ? this._itemHome(of.id) : null; ids = h ? [h] : []; break; }
        case 'npcArea': ids = of && of.npc ? this._npcAreas(of.npc) : []; break;
        case 'staffArea': ids = of && of.npc && this.staffAreas[of.id] ? [this.staffAreas[of.id]] : []; break;
        case 'court': ids = this.courts.filter(c => !spec.surface || c.type === spec.surface).map(c => c.id); break;
        case 'upcomingMatch': {
          const [a, b] = Array.isArray(spec.within) ? spec.within : [0.25, 3];
          const hour = ctx.hour ?? 12;
          const out = [];
          for (const m of this.matches) {
            if (!ctx.sampleAnyMatch && !(m.start >= hour + a && m.start <= hour + b)) continue;
            if (m.players.length < 1) continue;
            const court = m.courts.find(c => !spec.surface || (this.courts.find(k => k.id === c) || {}).type === spec.surface);
            if (court) out.push({ kind: 'area', id: court, match: m });
          }
          return out.filter(v => !notIds.has(v.id));
        }
        default: ids = asArr(spec.area); break;
      }
      return ids.filter(id => this._isArea(id) && !notIds.has(id)).map(id => ({ kind: 'area', id, match }));
    }
    if (spec.text !== undefined) return asArr(spec.text).map(s => ({ kind: 'text', id: String(s) }));
    return [];
  }

  _resolveRoles(tpl, ctx, preset = {}) {
    const rand = ctx.rand || Math.random;
    const fills = {};
    for (const [name, spec] of Object.entries(isObj(tpl.roles) ? tpl.roles : {})) {
      if (!isObj(spec)) return null;
      let cands = this._candidates(spec, fills, ctx);
      if (preset[name]) cands = cands.filter(c => c.id === preset[name]);
      if (!cands.length) return null;
      fills[name] = weightedPick(cands, (c) => (Number.isFinite(c.w) ? c.w : 1), rand);
    }
    return fills;
  }

  // ───────────────────────────── text ─────────────────────────────

  _display(f) {
    if (!f) return '';
    if (f.kind === 'npc') return this._npcName(f.npc);
    if (f.kind === 'item') return this._itemPhrase(f.id);
    if (f.kind === 'area') return this._areaPhrase(f.id);
    return f.id;
  }

  _fill(text, fills, rand) {
    let s = pickText(text, null, rand);
    if (typeof s !== 'string') return '';
    return s.replace(/\{(\w+)(?:\.(\w+))?\}/g, (all, role, prop) => {
      const key = role.charAt(0).toLowerCase() + role.slice(1);
      const f = fills[key];
      if (!f) return all;
      let v;
      if (prop === 'first') v = f.kind === 'npc' ? this._first(f.npc) : this._display(f);
      else if (prop === 'label') v = f.kind === 'area' ? this._areaLabel(f.id) : this._display(f);
      else if (prop === 'time') v = f.match ? formatHour(f.match.start) : '';
      else v = this._display(f);
      if (role !== key) v = v.charAt(0).toUpperCase() + v.slice(1);
      return v;
    });
  }

  /** Dialogue lines for a step: [{ speaker, text }]. */
  _lines(step, fills, speakerRole, rand) {
    const out = [];
    const npcOf = (role) => fills[role] && fills[role].npc;
    const main = npcOf(speakerRole);
    if (step.greet && main && Array.isArray(main.greetings) && main.greetings.length) {
      out.push({ speaker: main.name, text: main.greetings[Math.floor(rand() * main.greetings.length)] });
    }
    for (const l of asArr(step.lines)) {
      const by = isObj(l) && l.by ? npcOf(l.by) : main;
      const raw = isObj(l) && l.text !== undefined ? l.text : l;
      const text = this._fill(pickText(raw, by && by.archetype, rand), fills, rand);
      if (text) out.push({ speaker: by ? by.name : '', text });
    }
    if (step.idle && main) {
      const pool = main.dialoguePool && Array.isArray(main.dialoguePool.idle) ? main.dialoguePool.idle : [];
      if (pool.length) out.push({ speaker: main.name, text: pool[Math.floor(rand() * pool.length)] });
    }
    if (step.thanks && main) {
      const pool = main.dialoguePool && Array.isArray(main.dialoguePool.satisfied) ? main.dialoguePool.satisfied : [];
      if (pool.length) out.push({ speaker: main.name, text: pool[Math.floor(rand() * pool.length)] });
    }
    return out;
  }

  // ───────────────────────────── builders ─────────────────────────────

  _base(tpl, source, fills, ctx) {
    const rand = ctx.rand || Math.random;
    const m = {
      id: ctx.uid ? ctx.uid(tpl.id) : `gen:${tpl.id}:${Math.floor(rand() * 1e9).toString(36)}`,
      generated: true,
      template: tpl.id,
      type: tpl.type || 'errand',
      source,
      title: this._fill(tpl.title || tpl.id, fills, rand),
      description: this._fill(tpl.description || '', fills, rand),
      steps: [],
    };
    if (tpl.event || (Array.isArray(tpl.events) && ctx.eventId)) m.event = ctx.eventId || tpl.event;
    return m;
  }

  _sig(tpl, fills, keyRoles) {
    const roles = asArr(keyRoles || tpl.key);
    const parts = roles.length ? roles.map(r => (fills[r] ? fills[r].id : '')) : Object.values(fills).filter(f => f && (f.kind === 'npc' || f.kind === 'area')).slice(0, 2).map(f => f.id);
    return `${tpl.id}|${parts.join('|')}`;
  }

  _build(tpl, source, ctx, opts) {
    const rand = ctx.rand || Math.random;
    const preset = {};
    if (opts.trigger && tpl.trigger) preset[tpl.trigger] = opts.trigger;
    const fills = this._resolveRoles(tpl, ctx, preset);
    if (!fills) return null;
    if (source === 'random' && !(tpl.trigger && fills[tpl.trigger] && fills[tpl.trigger].kind === 'npc')) return null;
    const m = this._base(tpl, source, fills, ctx);
    for (const s of asArr(tpl.steps)) {
      if (!isObj(s)) return null;
      const st = { action: s.action };
      if (s.prompt) st.prompt = this._fill(s.prompt, fills, rand);
      switch (s.action) {
        case 'goTo': st.target = fills[s.target] ? fills[s.target].id : s.target; break;
        case 'groom': st.target = fills[s.target] ? fills[s.target].id : s.target; break;
        case 'pickup':
        case 'deliver':
          st.item = fills[s.item] ? fills[s.item].id : s.item;
          st.location = fills[s.location] ? fills[s.location].id : s.location;
          break;
        case 'dialogue': {
          const f = fills[s.npc];
          if (!f || f.kind !== 'npc') return null;
          st.npcId = f.id;
          const lines = this._lines(s, fills, s.npc, rand);
          if (lines.length) st.lines = lines;
          if (!st.prompt) st.prompt = `Talk to ${this._first(f.npc)}.`;
          break;
        }
        case 'choose':
          st.choices = asArr(s.choices).map(c => {
            const out = { label: this._fill(c.label, fills, rand), result: this._fill(c.result, fills, rand) };
            if (isObj(c.reactions)) {
              out.reactions = {};
              for (const [role, mood] of Object.entries(c.reactions)) if (fills[role] && fills[role].kind === 'npc') out.reactions[fills[role].id] = mood;
            }
            return out;
          });
          break;
        default: break;
      }
      m.steps.push(st);
    }
    if (tpl.client && fills[tpl.client] && fills[tpl.client].kind === 'npc') m.client = fills[tpl.client].id;
    if (source === 'random') m.triggerNpc = fills[tpl.trigger].id;
    m.sig = this._sig(tpl, fills);
    m.npcs = Object.values(fills).filter(f => f && f.kind === 'npc').map(f => f.id);
    return m;
  }

  /**
   * Member request (npcs.json `requests`): the member's own line opens the mission and a
   * small classifier turns it into steps: an item errand (towels / hopper / water / racket
   * to or from a named place), a message relay to another member, or a check on a place.
   */
  _buildRequest(tpl, source, ctx, opts) {
    const rand = ctx.rand || Math.random;
    let people = this.npcList.filter(n => Array.isArray(n.requests) && n.requests.length);
    if (tpl.roles && isObj(tpl.roles.member)) {
      const s = tpl.roles.member;
      if (s.npc === 'member') people = people.filter(n => !this._isStaff(n));
      if (s.npc === 'staff') people = people.filter(n => this._isStaff(n));
    }
    if (opts.trigger) people = people.filter(n => n.id === opts.trigger);
    if (ctx.busyNpcs) people = people.filter(n => !ctx.busyNpcs.has(n.id));
    if (!people.length) return null;
    const n = weightedPick(people, (p) => (ctx.npcWeight ? ctx.npcWeight(p.id) : 1), rand);
    const idx = Math.floor(rand() * n.requests.length);
    const line = n.requests[idx];
    const plan = this.classifyRequest(n, line, rand);
    if (!plan) return null;
    const fills = { member: { kind: 'npc', id: n.id, npc: n } };
    if (plan.item) fills.item = { kind: 'item', id: plan.item };
    if (plan.to) fills.place = { kind: 'area', id: plan.to };
    if (plan.from) fills.from = { kind: 'area', id: plan.from };
    if (plan.other) fills.other = { kind: 'npc', id: plan.other.id, npc: plan.other };
    const L = this.requestLines;
    const kind = plan.kind;
    const m = this._base(tpl, source, fills, ctx);
    m.title = this._fill(pickText((L.titles || {})[kind] || '{member.first} needs a hand', null, rand), fills, rand);
    m.description = `“${line}” — ${n.name}`;
    const first = this._first(n);
    const opening = [{ speaker: n.name, text: line }];
    const ack = pickText((L.ack || {})[kind], n.archetype, rand);
    if (ack) opening.push({ speaker: n.name, text: this._fill(ack, fills, rand) });
    m.steps.push({ action: 'dialogue', npcId: n.id, prompt: `Hear out ${first}.`, lines: opening });
    const thanksPool = n.dialoguePool && Array.isArray(n.dialoguePool.satisfied) ? n.dialoguePool.satisfied : [];
    const thanks = thanksPool.length ? thanksPool[Math.floor(rand() * thanksPool.length)] : 'Thank you.';
    if (kind === 'fetch') {
      m.steps.push({ action: 'pickup', item: plan.item, location: plan.from, prompt: this._fill('Pick up {item} at {from}.', fills, rand) });
      m.steps.push({ action: 'deliver', item: plan.item, location: plan.to, prompt: this._fill('Bring {item} to {place}.', fills, rand) });
      if (!this._isStaff(n) || plan.reportBack) m.steps.push({ action: 'dialogue', npcId: n.id, prompt: `Let ${first} know it's done.`, lines: [{ speaker: n.name, text: thanks }] });
    } else if (kind === 'relay') {
      const o = plan.other;
      const relay = this._fill(pickText((L.relay || {})[o.archetype] || (L.relay || {})['*'] || '{member.first} asked me to pass something on.', o.archetype, rand), fills, rand);
      m.steps.push({ action: 'dialogue', npcId: o.id, prompt: `Pass ${first}'s message to ${this._first(o)}.`, lines: [{ speaker: 'You', text: `Message from ${first}: "${line}"` }, { speaker: o.name, text: relay }] });
    } else if (kind === 'groom') {
      m.type = 'maintenance';
      m.steps.push({ action: 'goTo', target: 'equipmentShed', prompt: 'Hitch the drag brush at the equipment shed.' });
      m.steps.push({ action: 'groom', target: plan.to, prompt: 'Groom the clay courts.' });
      m.steps.push({ action: 'dialogue', npcId: n.id, prompt: `Report back to ${first}.`, lines: [{ speaker: n.name, text: thanks }] });
    } else {
      m.steps.push({ action: 'goTo', target: plan.to, prompt: this._fill('Check on {place}.', fills, rand) });
      const back = pickText((L.checked || {})['*'], null, rand) || 'All sorted.';
      m.steps.push({ action: 'dialogue', npcId: n.id, prompt: `Report back to ${first}.`, lines: [{ speaker: 'You', text: this._fill(back, fills, rand) }, { speaker: n.name, text: thanks }] });
    }
    if (m.type === 'errand' && kind !== 'fetch') m.type = kind === 'relay' ? 'social' : 'errand';
    if (!this._isStaff(n)) m.client = n.id;
    if (source === 'random') m.triggerNpc = n.id;
    m.sig = `${tpl.id}|${n.id}|${idx}`;
    m.npcs = [n.id].concat(plan.other ? [plan.other.id] : []);
    return m;
  }

  /** Turn a request line into { kind: 'fetch'|'relay'|'check'|'groom', item, from, to, other }. */
  classifyRequest(n, line, rand = Math.random) {
    const text = String(line || '');
    const home = this._npcAreas(n);
    const homeArea = home[0] || null;
    // Places named in the line, in order of appearance
    const places = [];
    const re = /\bcourt\s*(\d)\b/ig;
    let mm;
    const found = [];
    while ((mm = re.exec(text))) {
      const id = `court${mm[1]}`;
      if (this._isArea(id)) found.push({ id, at: mm.index });
    }
    for (const [id, rx] of PLACE_WORDS) {
      const r = rx.exec(text);
      if (r && this._isArea(id)) found.push({ id, at: r.index });
    }
    const generic = /\bcourt\b(?!\s*\d)/i.exec(text);
    if (generic && !found.some(f => /^court/.test(f.id))) {
      const c = home.find(a => /^court/.test(a));
      if (c) found.push({ id: c, at: generic.index });
    }
    found.sort((a, b) => a.at - b.at);
    for (const f of found) if (!places.some(p => p.id === f.id)) places.push(f);
    const fromCourts = /\bfrom the courts\b/i.test(text);

    // Grooming (Hank / Diane)
    if (/\b(groom|grooming|sweep|swept)\b/i.test(text)) {
      const clay = this.courts.filter(c => c.type === 'clay' && this.facts.clayCourtIds ? this.facts.clayCourtIds.has(c.id) : c.type === 'clay');
      if (clay.length) return { kind: 'groom', to: clay[0].id };
    }
    // Item errands
    let item = null;
    for (const [id, rx] of ITEM_WORDS) if (this.items[id] && rx.test(text)) { item = id; break; }
    if (/\bcooler\b/i.test(text) && !/running dry/i.test(text)) item = item === 'water_bottles' ? null : item;
    if (item) {
      const sources = this._itemSourceAreas(item);
      const staff = this._isStaff(n);
      const dest = (p) => new RegExp(`\\b(to|at|on|for)\\s+(the\\s+)?${escapeRe(this._matchWord(p.id, text))}`, 'i').test(text) && !new RegExp(`\\b(from|in)\\s+(the\\s+)?${escapeRe(this._matchWord(p.id, text))}`, 'i').test(text);
      const taken = /\b(waiting|lost|found|dropped|full of)\b|\bleft (my|it|them|balls|a|the|his|her)\b/i.test(text);
      // "My racket needs Jess": take it to the staff member named in the line
      const namedStaff = this.npcList.find(o => o.id !== n.id && this._isStaff(o) && this.staffAreas[o.id] &&
        new RegExp(`\\b${escapeRe(this._first(o))}\\b`).test(text));
      let from = null, to = null;
      if (places.length >= 2) { from = places[0].id; to = places[1].id; }
      else if (places.length === 0 && namedStaff) { from = homeArea; to = this.staffAreas[namedStaff.id]; }
      else if (places.length === 1) {
        const p = places[0];
        const isTo = /\b(to|get it to|gets to)\s+(the\s+)?/i.test(text.slice(Math.max(0, p.at - 12), p.at + 1));
        if (isTo) { to = p.id; }
        else if (/\bfrom\b/i.test(text.slice(Math.max(0, p.at - 10), p.at)) || taken || (sources.includes(p.id) && !dest(p))) { from = p.id; }
        else to = p.id;
      } else if (fromCourts) {
        const hard = this.courts.filter(c => c.type !== 'clay').map(c => c.id).filter(id => this._isArea(id));
        from = hard.length ? hard[Math.floor(rand() * hard.length)] : null;
      } else if (taken) {
        from = homeArea;
      } else if (staff && /\bout\b/i.test(text)) {
        // "Could you run towels out?": from the counter out to a court
        const courts = this.courts.map(c => c.id).filter(id => this._isArea(id));
        to = courts.length ? courts[Math.floor(rand() * courts.length)] : null;
      } else {
        to = homeArea; // "Bring me fresh towels": to where the member is
      }
      if (from && !to) to = taken && !staff ? this._itemHome(item) : homeArea;
      if (to && !from) {
        const personal = item === 'racket' && sources.includes(to);
        const own = staff && this.staffAreas[n.id];
        from = personal ? homeArea : (own && own !== to && sources.includes(own)) ? own : sources.find(s => s !== to) || null;
      }
      if (from && to && from !== to && this._isArea(from) && this._isArea(to)) return { kind: 'fetch', item, from, to, reportBack: staff && to !== homeArea && to !== this.staffAreas[n.id] };
    }
    // Message relay to another person named in the line
    if (/\b(tell|let|remind|ask|asks|whistle|know|deliver it to)\b/i.test(text)) {
      for (const o of this.npcList) {
        if (o.id === n.id) continue;
        const first = this._first(o);
        if (new RegExp(`\\b${escapeRe(first)}\\b`).test(text)) return { kind: 'relay', other: o };
      }
    }
    // Check on a place (named, else where the member is)
    const to = (places[0] && places[0].id) || homeArea;
    if (to) return { kind: 'check', to };
    return null;
  }

  _matchWord(id, text) {
    const c = /^court(\d)$/.exec(id);
    if (c) return `court ${c[1]}`;
    const w = PLACE_WORDS.find(p => p[0] === id);
    const r = w ? w[1].exec(text) : null;
    return r ? r[0] : id;
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Template weight for a source: a number, or { random: 4, '*': 1 }. */
export function templateWeight(t, source) {
  const w = t && t.weight;
  if (Number.isFinite(w)) return w;
  if (isObj(w)) return Number.isFinite(w[source]) ? w[source] : Number.isFinite(w['*']) ? w['*'] : 1;
  return 1;
}

/** Weighted random pick (weights <= 0 are skipped). */
export function weightedPick(list, weightOf, rand = Math.random) {
  let total = 0;
  for (const x of list) total += Math.max(0, weightOf(x) || 0);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const x of list) {
    r -= Math.max(0, weightOf(x) || 0);
    if (r <= 0) return x;
  }
  return list[list.length - 1];
}

/** A string from text | [texts] | { archetype: text, '*': text }. */
function pickText(v, archetype, rand = Math.random) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.length ? pickText(v[Math.floor(rand() * v.length)], archetype, rand) : '';
  if (isObj(v)) return pickText(v[archetype] !== undefined ? v[archetype] : v['*'], archetype, rand);
  return String(v);
}

function formatHour(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  const ap = hh >= 12 ? 'PM' : 'AM';
  const h12 = ((hh + 11) % 12) + 1;
  return mm ? `${h12}:${String(mm).padStart(2, '0')} ${ap}` : `${h12} ${ap}`;
}

/** Problems with missions.json → templates (shape only; `npm run validate` also samples fills). */
export function validateTemplatesShape(t, { taskTypes, sources = ['taskBoard', 'radio', 'random'] } = {}) {
  const out = [];
  const err = (msg) => out.push({ level: 'error', msg });
  const warn = (msg) => out.push({ level: 'warn', msg });
  if (t === undefined) return out;
  if (!isObj(t)) { err('templates must be an object { list, itemSources, ... }'); return out; }
  if (!Array.isArray(t.list)) { err('templates.list must be an array'); return out; }
  const ids = new Set();
  t.list.forEach((x, i) => {
    const at = `templates.list[${i}]${isObj(x) && x.id ? ` (${x.id})` : ''}`;
    if (!isObj(x) || !x.id) { err(`${at}: needs an "id"`); return; }
    if (ids.has(x.id)) err(`${at}: duplicate id`);
    ids.add(x.id);
    for (const s of asArr(x.sources || ['taskBoard'])) if (!sources.includes(s)) err(`${at}: unknown source "${s}"`);
    if (asArr(x.sources).includes('random') && x.builder !== 'request' && !x.trigger) err(`${at}: a random template needs "trigger" (an npc role)`);
    if (taskTypes && x.type && !taskTypes[x.type]) warn(`${at}: type "${x.type}" has no taskTypes entry (no pay)`);
    if (x.weight !== undefined && !(x.weight >= 0) && !(isObj(x.weight) && Object.values(x.weight).every(v => v >= 0))) err(`${at}: weight must be >= 0 or { source: weight }`);
    if (x.cooldownDays !== undefined && !(Number.isInteger(x.cooldownDays) && x.cooldownDays >= 0)) err(`${at}: cooldownDays must be an integer >= 0`);
    if (x.minDay !== undefined && !(Number.isInteger(x.minDay) && x.minDay >= 1)) err(`${at}: minDay must be an integer >= 1`);
    if (x.minRank !== undefined && !(Number.isInteger(x.minRank) && x.minRank >= 0)) err(`${at}: minRank must be an integer >= 0`);
    if (x.hours !== undefined && !(Array.isArray(x.hours) && x.hours.length === 2 && x.hours[0] < x.hours[1])) err(`${at}: hours must be [from, to]`);
    if (x.builder === 'request') return;
    const roles = isObj(x.roles) ? x.roles : {};
    const names = Object.keys(roles);
    const needRole = (r, where) => { if (typeof r === 'string' && !names.includes(r) && where !== 'fixed') err(`${at}: ${where} refers to unknown role "${r}"`); };
    if (x.client) needRole(x.client, 'client');
    if (x.trigger) needRole(x.trigger, 'trigger');
    names.forEach((name, k) => {
      const s = roles[name];
      for (const ref of [s && s.of, s && s.related, s && s.matchPlayer, s && s.ownedBy, s && s.stockedAt, ...asArr(s && s.not)]) {
        if (ref && !names.slice(0, k).includes(ref)) err(`${at}: role "${name}" refers to "${ref}", which must be an earlier role`);
      }
    });
    if (!Array.isArray(x.steps) || !x.steps.length) err(`${at}: needs "steps"`);
    else x.steps.forEach((s, j) => {
      if (!isObj(s)) { err(`${at} step ${j}: not an object`); return; }
      if (s.action === 'dialogue' && !names.includes(s.npc)) err(`${at} step ${j}: dialogue "npc" must be a role`);
      if ((s.action === 'pickup' || s.action === 'deliver') && (!names.includes(s.item) && !s.item)) err(`${at} step ${j}: needs "item"`);
    });
  });
  return out;
}
