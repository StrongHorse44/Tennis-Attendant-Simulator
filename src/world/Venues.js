import * as THREE from 'three';
import { SIZES } from '../utils/Constants.js';
import { Quality } from '../graphics/Quality.js';
import { Character, SKIN_TONES, HAIR_COLORS } from '../entities/CharacterModel.js';
import { courtHaloMaterial, registerCourtHalos } from './Court.js';
import { VenueBuild } from './VenueBuilder.js';
import { primeCanvasText } from './VenueArt.js';
import { TennisOcclusion } from '../tennis/TennisOcclusion.js';

/**
 * Venues — the Junior Tour's other clubs: one tournament court at a time, built on demand far
 * from the club (VENUE_ORIGIN, x 1800: the club, its horizon ring and point lights are all
 * beyond the camera's far plane of 600 m, so the two are never drawn together).
 *
 *   game.venues = new Venues(game, tourData?.venues);
 *   const v = game.venues.enter('harbor_point');   // builds (or re-shows the cached) venue
 *   // v = { id, name, short, label, courtLabel, surface, wind, blurb, crowd, lights (floodlit), court (a real Court: build a
 *   //       TennisSession CourtFrame from it), origin {x,z}, coachSpot {x,y,z,yaw,seated},
 *   //       benches [{x,y,z,yaw}], umpire {x,y,z,yaw}, spectatorSpots [{x,y,z,yaw,seated}] (front
 *   //       row seats kept free of the crowd), crowdSeats (the same list), exitSpot {x,z,yaw},
 *   //       buildMs } — every spot in world coordinates
 *   game.venues.update(dt);            // while active: flags, water, crowd ramp, umpire, night glow
 *   game.venues.setCrowd(0.8); .cheer(1); .setScoreOverride({ names, games, points, server, sets })
 *   game.venues.exit();                // hide it (kept cached; its bodies leave the physics world)
 *   game.venues.active                 // venue id or null
 *   game.venues.activeCourts()         // [court] while active (TennisOcclusion fades its fences)
 *
 * Venue definitions come from tour.json → venues[] (game.tourData.venues, read at enter()), each
 * merged over the built-in FIXTURE for the same id so a partial entry still builds; unknown ids
 * in tour.json build from the schema alone. Schema (tour.json):
 *   { id, name, short, surface: 'hard'|'clay'|'grass', wind, blurb, look: {
 *       court, surround (hex, hard courts), fence: 'chainlink'|'windscreen'|'hedge', fenceColor,
 *       ground (lawn hex), backdrop: 'city'|'forest'|'harbor'|'lawn'|'campus'|'night',
 *       stands: { rows, sides: ['east','west','north','south'] },
 *       clubhouse: { style: 'shed'|'lodge'|'boathouse'|'pavilion'|'modern'|'arena', color, roof, side },
 *       trees: { kind: 'pine'|'maple'|'oak'|'none', count, autumn }, lights (bool), sponsors: [..],
 *       crowd (0..1) } }
 * Optional look extras (all derived when absent): accent, seatColor, lineColor, rig ('poles' |
 * 'masts' | 'rigs'), stands.style ('bleacher' | 'wood' | 'covered' | 'concrete'), stands.length,
 * apron ('concrete' | 'asphalt' | 'lawn'), umbrellas, flags (count), scoreboard, fenceSides,
 * fenceHeight, waterColor.
 *
 * Nothing here compiles a shader: every material is one of the kit's programs that already exist
 * at load (see VenueBuilder). Dev: __game.venues.debugView(id, 'baseline'|'broadcast'|'aerial',
 * { time }) holds a camera there for screenshots; __game.venues.debugEnd().
 */

export const VENUE_ORIGIN = Object.freeze({ x: 1800, z: 0 });

const DEV = !!(import.meta.env && import.meta.env.DEV);

/** Built-in venue definitions (the tour.json schema); tour.json entries override them field by field. */
export const VENUE_FIXTURE = [
  {
    id: 'cedar_park', name: 'Cedar Park Public Courts', short: 'Cedar Park', surface: 'hard', wind: 'breeze',
    blurb: 'Public courts in the middle of the city park: faded paint, tall chain-link and a loud crowd on the bleachers.',
    look: {
      court: '#4f8a5b', surround: '#8e4338', fence: 'chainlink', fenceColor: '#27352c', ground: '#6e9a4f',
      backdrop: 'city', stands: { rows: 3, sides: ['west'], style: 'bleacher' },
      clubhouse: { style: 'shed', color: '#c9b79a', roof: '#4a4f55', side: 'north' },
      trees: { kind: 'oak', count: 40 }, lights: true, rig: 'poles', apron: 'asphalt', lineColor: '#e8e4d6',
      sponsors: ['CEDAR PARK', 'METRO PARKS', 'CORNER DELI', 'CITY SPORTS'], crowd: 0.45, accent: '#f2c14e',
    },
  },
  {
    id: 'maple_hollow', name: 'Maple Hollow Racquet Club', short: 'Maple Hollow', surface: 'clay', wind: 'calm',
    blurb: 'Red clay in a hollow of maples, a white lodge on the hill and wooden bleachers along the side.',
    look: {
      fence: 'windscreen', fenceColor: '#244d34', ground: '#7a9a4a', backdrop: 'forest',
      stands: { rows: 4, sides: ['east'], style: 'wood' },
      clubhouse: { style: 'lodge', color: '#f4f1e8', roof: '#2e5a3f', side: 'north' },
      trees: { kind: 'maple', count: 44, autumn: true }, lights: true, rig: 'poles', apron: 'lawn',
      sponsors: ['MAPLE HOLLOW', 'HOLLOW CREEK DAIRY', 'RED LEAF OUTFITTERS', 'AMBER CIDER'], crowd: 0.55, accent: '#e0a13a',
    },
  },
  {
    id: 'harbor_point', name: 'Harbor Point Tennis Center', short: 'Harbor Point', surface: 'hard', wind: 'breeze',
    blurb: 'A blue hard court on the waterfront: sea breeze, masts in the marina and the lighthouse across the bay.',
    look: {
      court: '#2f5f9e', surround: '#26476f', fence: 'windscreen', fenceColor: '#1e3a5a', ground: '#6f9a52',
      backdrop: 'harbor', stands: { rows: 4, sides: ['east', 'west'], style: 'concrete' },
      clubhouse: { style: 'boathouse', color: '#e9e4d8', roof: '#3b4a5a', side: 'north' },
      trees: { kind: 'pine', count: 28 }, lights: true, rig: 'masts', umbrellas: true,
      sponsors: ['HARBOR POINT', 'BLUEWATER BANK', 'SEAGLASS HOTEL', 'NORTHWIND SAILS'], crowd: 0.6, accent: '#f4e8c1',
    },
  },
  {
    id: 'ashford_lawn', name: 'Ashford Lawn Tennis Club', short: 'Ashford', surface: 'grass', wind: 'calm',
    blurb: 'Grass as old as the club: clipped hedges, a white timber pavilion with its clock and a small covered stand.',
    look: {
      fence: 'hedge', fenceColor: '#2c5a38', ground: '#6a9a4a', backdrop: 'lawn',
      stands: { rows: 5, sides: ['west'], style: 'covered' },
      clubhouse: { style: 'pavilion', color: '#f6f2e8', roof: '#3f5f4a', side: 'north' },
      trees: { kind: 'oak', count: 34 }, lights: true, rig: 'poles', apron: 'lawn',
      sponsors: ['ASHFORD', 'CROWN & WILLOW', 'PEMBERTON TEA', 'OLD MILL'], crowd: 0.55, accent: '#d9a441',
    },
  },
  {
    id: 'sunridge_academy', name: 'Sunridge Tennis Academy', short: 'Sunridge', surface: 'hard', wind: 'breeze',
    blurb: 'The academy show court: teal paint, big stands, a scoreboard and the glass academy building behind it.',
    look: {
      court: '#1f8a8a', surround: '#23616b', fence: 'windscreen', fenceColor: '#15464f', ground: '#86a35a',
      backdrop: 'campus', stands: { rows: 8, sides: ['east', 'west'], style: 'concrete' },
      clubhouse: { style: 'modern', color: '#f4f4f0', roof: '#2d3b40', side: 'north' },
      trees: { kind: 'pine', count: 24 }, lights: true, rig: 'masts', umbrellas: true, scoreboard: true,
      sponsors: ['SUNRIDGE ACADEMY', 'SOLSTICE ENERGY', 'PEAK PERFORMANCE', 'TEAL WAVE'], crowd: 0.7, accent: '#f2c14e',
    },
  },
  {
    id: 'metro_center', name: 'Metro Tennis Center', short: 'Metro', surface: 'hard', wind: 'calm',
    blurb: 'The night stadium downtown: tall stands all round, light rigs over the roofs and the skyline behind them.',
    look: {
      court: '#2c4f9a', surround: '#3a3f7a', fence: 'windscreen', fenceColor: '#12182b', ground: '#4c6a45',
      backdrop: 'night', stands: { rows: 12, sides: ['east', 'west', 'north', 'south'], style: 'concrete' },
      clubhouse: { style: 'arena', color: '#2b3040', roof: '#1b1f2a', side: 'north' },
      trees: { kind: 'none', count: 0 }, lights: true, rig: 'rigs', scoreboard: true,
      sponsors: ['METRO', 'NEON AIR', 'CITYLINE', 'SKYBRIDGE'], crowd: 0.9, accent: '#6fd3ff',
    },
  },
];

const ENUMS = {
  surface: ['hard', 'clay', 'grass'],
  fence: ['chainlink', 'windscreen', 'hedge', 'none'],
  backdrop: ['city', 'forest', 'harbor', 'lawn', 'campus', 'night'],
  style: ['shed', 'lodge', 'boathouse', 'pavilion', 'modern', 'arena'],
  side: ['north', 'south', 'east', 'west'],
  trees: ['pine', 'maple', 'oak', 'none'],
  rig: ['poles', 'masts', 'rigs'],
  standStyle: ['bleacher', 'wood', 'covered', 'concrete'],
  apron: ['concrete', 'asphalt', 'lawn'],
};

const _c = new THREE.Color();
function hexOf(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v & 0xffffff;
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim())) {
    try { return _c.set(v.trim().startsWith('#') ? v.trim() : `#${v.trim()}`).getHex(); } catch (e) { /* fall through */ }
  }
  return fallback;
}
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const num = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : fallback);

/** A venue definition, tour.json over the fixture, every field checked (never throws). */
export function sanitizeVenue(raw, base = null) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = base || {};
  const rl = r.look && typeof r.look === 'object' ? r.look : {};
  const bl = b.look || {};
  const id = typeof r.id === 'string' && r.id ? r.id : b.id || 'venue';
  const surface = oneOf(r.surface ?? b.surface, ENUMS.surface, 'hard');
  const name = String(r.name ?? b.name ?? id).slice(0, 60);
  const short = String(r.short ?? b.short ?? name.split(' ')[0]).slice(0, 24);
  const pick = (k) => (rl[k] !== undefined ? rl[k] : bl[k]);
  const standsR = { ...(bl.stands || {}), ...(rl.stands && typeof rl.stands === 'object' ? rl.stands : {}) };
  const clubR = { ...(bl.clubhouse || {}), ...(rl.clubhouse && typeof rl.clubhouse === 'object' ? rl.clubhouse : {}) };
  const treesR = { ...(bl.trees || {}), ...(rl.trees && typeof rl.trees === 'object' ? rl.trees : {}) };
  const sides = Array.isArray(standsR.sides) ? [...new Set(standsR.sides.filter(s => ENUMS.side.includes(s)))] : [];
  const rows = Math.round(num(standsR.rows, 0, 14, 3));
  const style = oneOf(clubR.style, ENUMS.style, surface === 'grass' ? 'pavilion' : 'lodge');
  const fence = oneOf(pick('fence'), ENUMS.fence, 'chainlink');
  const backdrop = oneOf(pick('backdrop'), ENUMS.backdrop, 'lawn');
  // (tour.json may describe stands by material / covered instead of style; its word wins over the fixture's)
  const rs = rl.stands && typeof rl.stands === 'object' ? rl.stands : {};
  const matStyle = rs.style !== undefined ? rs.style
    : rs.covered === true ? 'covered'
      : rs.material === 'metal' || rs.material === 'aluminium' ? (rows >= 6 ? 'concrete' : 'bleacher')
        : rs.material === 'wood' ? 'wood' : rs.material === 'concrete' ? 'concrete' : undefined;
  const standStyle = oneOf(matStyle !== undefined ? matStyle : standsR.style, ENUMS.standStyle,
    style === 'arena' || rows >= 6 ? 'concrete' : style === 'shed' ? 'bleacher' : style === 'pavilion' ? 'covered' : style === 'lodge' ? 'wood' : 'concrete');
  const rig = oneOf(pick('rig'), ENUMS.rig, style === 'arena' ? 'rigs' : rows >= 4 && sides.length >= 2 ? 'masts' : 'poles');
  const look = {
    court: surface === 'hard' ? hexOf(pick('court'), 0x2f6db3) : null,
    surround: surface === 'hard' ? hexOf(pick('surround'), 0x3f7d55) : null,
    fence,
    fenceColor: hexOf(pick('fenceColor'), 0x2b4a36),
    ground: hexOf(pick('ground'), 0x6f9a52),
    backdrop,
    stands: { rows: sides.length ? rows : 0, sides, style: standStyle, length: standsR.length !== undefined ? num(standsR.length, 8, 30, undefined) : undefined },
    clubhouse: {
      style,
      color: hexOf(clubR.color, 0xf2eee3),
      roof: hexOf(clubR.roof, 0x3f5f4a),
      side: oneOf(clubR.side, ENUMS.side, 'north'),
    },
    trees: {
      kind: oneOf(treesR.kind, ENUMS.trees, 'oak'),
      count: Math.round(num(treesR.count, 0, 90, 20)),
      autumn: !!treesR.autumn,
    },
    lights: pick('lights') !== false,
    rig,
    sponsors: (Array.isArray(pick('sponsors')) ? pick('sponsors') : []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 22).toUpperCase()).slice(0, 8),
    crowd: num(pick('crowd'), 0, 1, 0.5),
    accent: pick('accent') !== undefined ? hexOf(pick('accent'), undefined) : undefined,
    seatColor: pick('seatColor') !== undefined ? hexOf(pick('seatColor'), undefined) : undefined,
    lineColor: pick('lineColor') !== undefined ? hexOf(pick('lineColor'), undefined) : undefined,
    apron: oneOf(pick('apron'), ENUMS.apron, surface === 'grass' || fence === 'hedge' ? 'lawn' : 'concrete'),
    umbrellas: pick('umbrellas') !== undefined ? !!pick('umbrellas') : backdrop === 'harbor' || backdrop === 'campus',
    flags: Math.round(num(pick('flags'), 0, 5, 3)),
    scoreboard: pick('scoreboard') !== undefined ? !!pick('scoreboard') : undefined,
    fenceSides: pick('fenceSides') !== undefined ? !!pick('fenceSides') : undefined,
    fenceHeight: pick('fenceHeight') !== undefined ? num(pick('fenceHeight'), 1.5, 5, undefined) : undefined,
    waterColor: pick('waterColor') !== undefined ? hexOf(pick('waterColor'), undefined) : undefined,
  };
  if (!look.sponsors.length) look.sponsors = [short.toUpperCase()];
  return {
    id, name, short, surface,
    wind: typeof (r.wind ?? b.wind) === 'string' ? (r.wind ?? b.wind) : 'calm',
    blurb: String(r.blurb ?? b.blurb ?? ''),
    courtLabel: String(r.courtLabel ?? b.courtLabel ?? (style === 'arena' || rows >= 6 ? 'Stadium Court' : 'Centre Court')),
    look,
  };
}

const UMPIRE_STYLE = {
  skin: SKIN_TONES[1], hair: 'short', hairColor: HAIR_COLORS.grey, hat: 'cap', hatColor: 0x1f2a44, hatBrim: 0x1f2a44,
  shirt: 0x1f2a44, collar: 0xf4f1ea, polo: true, bottom: 'pants', bottomColor: 0xe9e4d8, brows: 'stern', mouth: 'flat',
  racket: null, sunglasses: true, scale: 0.86,
};

const _v = new THREE.Vector3();

export class Venues {
  /**
   * @param {object} game
   * @param {Array} [venueData] tour.json → venues (game.tourData.venues is read again at enter())
   */
  constructor(game, venueData = null) {
    this.game = game;
    this.scene = game.scene;
    this._data = Array.isArray(venueData) ? venueData : null;
    this.active = null;
    this.build = null;          // the cached VenueBuild (the last venue built)
    this.info = null;
    this.origin = { x: VENUE_ORIGIN.x, z: VENUE_ORIGIN.z };
    this._clouds = null;        // saved club cloud position while a venue is shown
    this._umpire = null;        // one seated umpire, moved into each venue
    this._umpFrame = 0;
    this._halos = null;         // one lamp-halo Points (court halo material), refilled per venue
    primeCanvasText();
    this._offQuality = Quality.onChange((tier, settings) => {
      try { if (this.build) this.build.applyQuality(settings); } catch (e) { /* cosmetic */ }
    });
  }

  // ─────────────── definitions ───────────────

  _rawList() {
    const t = this.game && this.game.tourData;
    if (t && Array.isArray(t.venues) && t.venues.length) return t.venues;
    return this._data || [];
  }

  /** Every venue: tour.json entries (over the fixture of the same id) + fixture venues it lacks. */
  list() {
    const raw = this._rawList();
    const out = [];
    const seen = new Set();
    for (const r of raw) {
      if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(sanitizeVenue(r, VENUE_FIXTURE.find(f => f.id === r.id) || null));
    }
    for (const f of VENUE_FIXTURE) if (!seen.has(f.id)) out.push(sanitizeVenue(f));
    return out;
  }

  get(id) {
    return this.list().find(v => v.id === id) || null;
  }

  // ─────────────── lifecycle ───────────────

  /** Build (or re-show) a venue; returns its info (spots in world coordinates) or null. */
  enter(id) {
    const def = this.get(id);
    if (!def) {
      console.warn(`Venues: unknown venue "${id}"`);
      return null;
    }
    if (this.active === id && this.info) return this.info;
    if (this.active) this.exit();
    let b = this.build;
    if (b && b.def.id !== id) {
      this._detachShared(b);
      b.dispose();
      b = this.build = null;
      this.info = null;
    }
    if (!b) {
      try {
        b = new VenueBuild(this.game, def, this.origin).build();
      } catch (err) {
        console.error(`Venues: building "${id}" failed`, err);
        try { if (b) b.dispose(); } catch (e) { /* ignore */ }
        return null;
      }
      this.build = b;
      this.info = this._info(b);
      this._attachShared(b);
    }
    if (!b.group.parent) this.scene.add(b.group);
    b.group.visible = true;
    b.court.setBodiesEnabled(true);
    b.setScore(null);
    b.setCrowd(def.look.crowd, true);
    this.active = id;
    // The club's clouds orbit the club: bring them over (restored in exit())
    const clouds = this.game.weather && this.game.weather.clouds && this.game.weather.clouds.group;
    if (clouds) {
      this._clouds = { group: clouds, pos: clouds.position.clone() };
      clouds.position.set(this.origin.x, 0, this.origin.z);
      clouds.updateMatrixWorld(true);
    }
    return this.info;
  }

  /** Hide the active venue (kept cached for a return visit) and put back what enter() moved. */
  exit() {
    if (!this.active) return;
    const b = this.build;
    if (b) {
      b.group.visible = false;
      b.court.setBodiesEnabled(false);
      b.setScore(null);
    }
    if (this._clouds) {
      this._clouds.group.position.copy(this._clouds.pos);
      this._clouds.group.updateMatrixWorld(true);
      this._clouds = null;
    }
    this.active = null;
  }

  /** The active venue's court(s) (TennisOcclusion, anything that walks world.courts). */
  activeCourts() {
    return this.active && this.build && this.build.court ? [this.build.court] : [];
  }

  /** Extra roots whose court-style meshes may fade for the tennis camera (none: see VenueBuilder). */
  fadeRoots() {
    return [];
  }

  /** Per frame while a venue is shown (allocation-free). */
  update(dt) {
    if (!this.active || !this.build) return;
    this.build.update(dt);
    const u = this._umpire;
    if (u && u.root.parent) {
      if (++this._umpFrame >= 2) { this._umpFrame = 0; u.update(dt * 2); }
    }
  }

  /** Crowd fraction 0..1 (the stands' front rows first; impostors to the tier budget, strips behind). */
  setCrowd(frac, instant = false) {
    if (this.build) this.build.setCrowd(frac, instant);
  }

  /** A short lift through the crowd (0..1). */
  cheer(strength = 1) {
    if (this.build && this.build.crowd) this.build.crowd.cheer(strength);
  }

  /** The venue scoreboards (Stadium.setScoreOverride's shape), or null for the idle face. */
  setScoreOverride(o) {
    if (this.build) this.build.setScore(o);
  }

  dispose() {
    this.exit();
    if (this.build) { this._detachShared(this.build); this.build.dispose(); }
    this.build = null;
    this.info = null;
    if (this._offQuality) this._offQuality();
  }

  // ─────────────── shared pieces ───────────────

  _attachShared(b) {
    // lamp halos (one registered Points, refilled with this venue's mast heads)
    if (b.halos.length) {
      if (!this._halos) {
        const pts = new THREE.Points(new THREE.BufferGeometry(), courtHaloMaterial());
        pts.name = 'courtLampHalos';
        pts.userData.noMerge = true;
        pts.userData.noAO = true;
        registerCourtHalos(pts);
        this._halos = pts;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.halos, 3));
      g.computeBoundingSphere();
      const old = this._halos.geometry;
      this._halos.geometry = g;
      old.dispose();
      b.local.add(this._halos);
      this._halos.updateMatrix();
    }
    // the chair umpire
    const u = b.spots.umpire;
    if (u) {
      if (!this._umpire) {
        try {
          this._umpire = new Character(UMPIRE_STYLE, 'venue-umpire');
          this._umpire.root.scale.setScalar(UMPIRE_STYLE.scale);
          this._umpire.anim.autoIdleVariants = false;
          this._umpire.play('sit', { fade: 0, loop: true });
          this._umpire.update(1 / 30);
        } catch (e) {
          console.warn('Venues: umpire skipped', e);
          this._umpire = null;
        }
      }
      if (this._umpire) {
        const r = this._umpire.root;
        r.position.set(u.x, u.y - 0.63 * UMPIRE_STYLE.scale, u.z);
        r.rotation.set(0, u.yaw, 0);
        if (Quality.tier === 'low') this._umpire.setLod(true);
        b.local.add(r);
        this._umpire.lookAt(_v.set(this.origin.x, 1, this.origin.z));
      }
    }
  }

  _detachShared(b) {
    if (this._halos && this._halos.parent === b.local) b.local.remove(this._halos);
    if (this._umpire && this._umpire.root.parent === b.local) b.local.remove(this._umpire.root);
  }

  /** World-coordinate spots for the session. */
  _info(b) {
    const d = b.def, o = this.origin;
    const W = (s) => (s ? { ...s, x: s.x + o.x, z: s.z + o.z } : null);
    const spectators = b.spots.spectators.map(W);
    const lay = b.lay;
    return {
      id: d.id, name: d.name, short: d.short, label: d.name, courtLabel: d.courtLabel,
      surface: d.surface, wind: d.wind, blurb: d.blurb, crowd: d.look.crowd, lights: !!d.look.lights,
      court: b.court,
      origin: { x: o.x, z: o.z },
      coachSpot: W(b.spots.coach),
      benches: b.spots.benches.map(W),
      umpire: W(b.spots.umpire),
      spectatorSpots: spectators,
      crowdSeats: spectators,
      exitSpot: { x: o.x - (lay.benchX + 1.4), z: o.z + 4.5, yaw: Math.PI / 2 },
      buildMs: Math.round(b.buildMs * 10) / 10,
    };
  }

  // ─────────────── dev ───────────────

  /**
   * DEV: freeze the game on a venue view for screenshots. mode: 'baseline' (the tennis camera
   * behind the near baseline), 'broadcast' (the TV angle, higher and further back), 'aerial',
   * 'side'. opts: { time (hour), weather ('sunny' | 'cloudy' | 'rainy' | 'windy'), crowd (0..1),
   * players (true: the player and Rafa on the court) }.
   * Returns { calls, triangles, programs, buildMs }.
   */
  debugView(id, mode = 'baseline', opts = {}) {
    if (!DEV) return null;
    const g = this.game;
    const info = this.enter(id);
    if (!info) return null;
    const o = this.origin, w = g.weather;
    if (!this._dbg) {
      this._dbg = {
        time: w.timeOfDay, frozen: w.clockFrozen, stadium: w.stadium, weather: w.getWeather(),
        player: g.player.body.position.clone(),
      };
    }
    g.paused = true;
    g.pauseReason = 'venueDebug';
    if (g.input && g.input.setEnabled) g.input.setEnabled(false);
    w.clockFrozen = true;
    w.stadium = 1;
    const wx = typeof opts.weather === 'string' ? opts.weather : 'sunny';
    if (w.getWeather() !== wx) w.setWeather(wx, true);
    w.timeOfDay = Number.isFinite(opts.time) ? opts.time : 17.5;
    if (opts.crowd !== undefined) this.setCrowd(opts.crowd, true);
    // the player on the near baseline, Rafa on the far one
    if (opts.players !== false) {
      const p = g.player;
      const px = o.x, pz = o.z + 12.9;
      p.body.position.set(px, 0.15 + SIZES.playerRadius * SIZES.playerScale, pz);
      p.body.velocity.set(0, 0, 0);
      p.mesh.position.set(px, 0.15, pz);
      p.mesh.rotation.set(0, Math.PI, 0);
      if (typeof p.snapToGround === 'function') p.snapToGround(0.15);
      const rafa = (g.npcs || []).find(n => n.id === 'rafa_ibarra');
      if (rafa && typeof rafa.placeAt === 'function') rafa.placeAt(o.x + 1, o.z - 12.9, 0, 0.15);
    }
    // camera
    const cam = g.camera, aspect = cam.aspect || 1.6, portrait = aspect < 0.8;
    const pos = new THREE.Vector3(), look = new THREE.Vector3();
    const arena = this.build && this.build.look.clubhouse.style === 'arena';
    const boards = this.build && this.build._score;
    if (mode === 'broadcast' && arena) { pos.set(0, 17, 25.5); look.set(0, 0, -4); }
    else if (mode === 'broadcast' && boards) { pos.set(0, 15, 27.5); look.set(0, 0.2, -4); }
    else if (mode === 'broadcast') { pos.set(0, 14.5, 36); look.set(0, 0.5, -3); }
    else if (mode === 'aerial') { pos.set(52, 46, 62); look.set(0, 0, -8); }
    else if (mode === 'side') { pos.set(24, 8, 6); look.set(0, 0.8, -3); }
    else if (portrait) { pos.set(0, 9.2, 12.3 + 12.2); look.set(0, 0.2, -1.5); }
    else { pos.set(0, 6.1, 12.3 + 8.4); look.set(0, 0.7, 0.5); }
    pos.x += o.x; pos.z += o.z; look.x += o.x; look.z += o.z;
    cam.position.copy(pos);
    cam.lookAt(look);
    cam.updateMatrixWorld();
    // the tennis camera's see-through (TennisOcclusion) on the near end, like a session would
    this._debugOcclusion(mode === 'baseline');
    // settle the frame: weather (lights, sky, env map, night glow), world, venue
    w.setShadowFocus(_v.set(o.x, 0, o.z));
    w._envLastT = -99;
    w.update(0);
    g.world.update(1 / 60, g.player.mesh.position);
    for (const n of g.npcs || []) { try { n.update(1 / 60, g.player.mesh.position); } catch (e) { /* ignore */ } }
    this.update(1 / 60);
    g._render(0);
    g._render(0);
    const r = g.renderer;
    return {
      calls: g.renderStats.calls, triangles: g.renderStats.triangles, programs: r.info.programs ? r.info.programs.length : -1,
      buildMs: info.buildMs, timings: this.build.timings,
    };
  }

  /** DEV: the session's see-through on the active venue court (a minimal session stand-in). */
  _debugOcclusion(on) {
    const occ = (this.game.tennis && this.game.tennis.occ) || (this._dbgOcc ||= new TennisOcclusion(this.game));
    occ.end();
    if (!on || !this.build) return;
    const o = this.origin;
    const frame = {
      court: this.build.court, id: this.build.court.id, cx: o.x, cz: o.z, r: 0, c: 1, s: 0, y0: 0, surfY: 0.15,
      lu(x, z) { return (x - this.cx) * this.c - (z - this.cz) * this.s; },
      lv(x, z) { return (x - this.cx) * this.s + (z - this.cz) * this.c; },
    };
    const fake = { frame, sides: [1, -1], game: this.game, ball: null };
    occ.begin(fake);
    occ.update(fake, 1);
  }

  /** DEV: leave the debug view (the club, its clock and the player back as they were). */
  debugEnd() {
    if (!DEV || !this._dbg) return;
    const g = this.game, w = g.weather, s = this._dbg;
    this._debugOcclusion(false);
    this.exit();
    w.timeOfDay = s.time;
    w.clockFrozen = s.frozen;
    w.stadium = s.stadium;
    w.setWeather(s.weather, true);
    g.player.body.position.copy(s.player);
    g.player.mesh.position.set(s.player.x, 0, s.player.z);
    if (typeof g.player.snapToGround === 'function') g.player.snapToGround(0);
    // (debugView put Rafa on the venue court: back to his post)
    const rafa = (g.npcs || []).find(n => n.id === 'rafa_ibarra');
    if (rafa && rafa.body && Math.abs(rafa.body.position.x - this.origin.x) < 200) {
      const home = rafa.duty && rafa.duty.post;
      if (home && typeof rafa.placeAt === 'function') rafa.placeAt(home.x, home.z, Number.isFinite(home.face) ? home.face : null, Number.isFinite(home.y) ? home.y : null);
    }
    this._dbg = null;
    g.paused = false;
    g.pauseReason = null;
    if (g.input && g.input.setEnabled) g.input.setEnabled(true);
    if (g._snapCamera) g._snapCamera();
    if (g.clock) g.clock.getDelta();
  }
}
