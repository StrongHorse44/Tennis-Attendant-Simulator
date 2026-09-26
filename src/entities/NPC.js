import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Quality } from '../graphics/Quality.js';
import { SIZES } from '../utils/Constants.js';
import { mat } from '../graphics/Materials.js';
import { getGeometry, mergeParts, makeMatrix, roundedBox, sphereGeo } from '../graphics/GeometryUtils.js';
import {
  Character, BlobShadows, CameraTracker, hashString, SKIN_TONES, HAIR_COLORS,
} from './CharacterModel.js';
import { findSeats, claimSeat, releaseSeat, SIT_SEAT_HEIGHT } from './Seats.js';
import { planRoute } from '../world/NavRooms.js';

/**
 * Hand-authored looks for the shipped NPCs (keyed by npcs.json id). NPCs not listed here get a
 * deterministic look derived from their id + archetype (see _deriveStyle), so new JSON entries
 * still look distinct without touching code.
 */
const NPC_STYLES = {
  mrs_wellington: {
    female: true, skin: SKIN_TONES[0], hair: 'bob', hairColor: HAIR_COLORS.silver, hat: 'visor', hatColor: 0xF4F1EA,
    hatBrim: 0x6B3F8E, bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'haughty', mouth: 'flat', necklace: 0xF6F1E4,
    racket: 0x6B3F8E, collar: 0xF4F1EA, scale: 0.86,
  },
  chad_blake: {
    skin: SKIN_TONES[1], hair: 'swept', hairColor: HAIR_COLORS.blonde, hat: 'capBack', hatColor: 0xF2F0EA, hatBrim: 0x1F3A68,
    bottom: 'shorts', bottomColor: 0x1F3A68, brows: 'stern', mouth: 'grin', racket: 0x202020, wristband: 0xF2F0EA,
    shoeAccent: 0xC0392B, scale: 0.92,
  },
  maria_santos: {
    female: true, skin: SKIN_TONES[2], hair: 'ponytail', hairColor: HAIR_COLORS.brown, tieColor: 0xF4E8C1, hat: 'visor',
    hatColor: 0xF4F1EA, hatBrim: 0xD97B1A, bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'soft', mouth: 'smile', blush: true,
    racket: 0xD97B1A, sleeveTrim: 0xF4F1EA, scale: 0.84,
  },
  bob_hendricks: {
    skin: SKIN_TONES[1], hair: 'bald', hairColor: HAIR_COLORS.grey, hat: null, bottom: 'shorts', bottomColor: 0xC9B98E,
    brows: 'soft', mouth: 'smile', mustache: true, blush: true, racket: 0x2D5A3D, belt: 0x5A3A22, scale: 0.9,
  },
  kevin_park: {
    skin: SKIN_TONES[1], hair: 'short', hairColor: HAIR_COLORS.black, hat: null, bottom: 'shorts', bottomColor: 0x33363D,
    brows: 'worried', mouth: 'o', racket: 0xE8E8E8, polo: false, shoeAccent: 0x3498DB, belt: null, scale: 0.86,
  },
  priya_sharma: {
    female: true, skin: SKIN_TONES[2], hair: 'bun', hairColor: HAIR_COLORS.black, hat: 'headband', hatColor: 0xF4F1EA,
    bottom: 'skirt', bottomColor: 0x1B4F55, brows: 'worried', mouth: 'smile', racket: null, polo: false, belt: null, scale: 0.83,
  },
  diane_ross: {
    female: true, skin: SKIN_TONES[0], hair: 'bob', hairColor: HAIR_COLORS.blonde, hat: null, sunglasses: true,
    bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'haughty', mouth: 'flat', necklace: 0xC9A24A, racket: 0xF2F0EA,
    collar: 0xF4F1EA, scale: 0.87,
  },
  tommy_chen: {
    skin: SKIN_TONES[1], hair: 'short', hairColor: HAIR_COLORS.black, hat: 'headband', hatColor: 0xE67E22,
    bottom: 'shorts', bottomColor: 0xF2EFE8, brows: 'soft', mouth: 'grin', racket: 0xE67E22, wristband: 0xE67E22,
    polo: false, stripe: 0xF4F1EA, belt: null, scale: 0.84,
  },
  hank_morris: {
    skin: SKIN_TONES[3], hair: 'short', hairColor: HAIR_COLORS.grey, hat: 'bucket', hatColor: 0xB9A77A, hatBrim: 0xA8966A,
    bottom: 'pants', bottomColor: 0x6B6452, brows: 'stern', mouth: 'smile', mustache: true, racket: null, staff: true,
    shoes: 0x6A4A2E, shoeSole: 0x3A2A1C, shoeAccent: 0x5A3E26, collar: 0xD9CDA8, belt: 0x3B2A1E, scale: 0.9, build: 1.08,
  },
  // Head pro: navy staff polo, white cap, shades, lefty red racket
  rafa_ibarra: {
    skin: SKIN_TONES[2], hair: 'short', hairColor: HAIR_COLORS.black, hat: 'cap', hatColor: 0xF4F1EA, hatBrim: 0x1F3A68,
    hatLogo: 0xC0392B, sunglasses: true, bottom: 'shorts', bottomColor: 0xF2EFE8, brows: 'soft', mouth: 'smile',
    racket: 0xC0392B, staff: true, collar: 0xF4F1EA, wristband: 0xF4F1EA, shoeAccent: 0x1F3A68, belt: null, scale: 0.9,
  },
  // Pro shop manager: club-green staff polo, black bob, charcoal slacks, deadpan
  jess_nakamura: {
    skin: SKIN_TONES[1], hair: 'bob', hairColor: HAIR_COLORS.black, hat: null, bottom: 'pants', bottomColor: 0x33363D,
    brows: 'stern', mouth: 'flat', racket: null, staff: true, collar: 0xF4E8C1, belt: 0x1C1D1F,
    shoes: 0x2B2B2B, shoeSole: 0xE8E4DA, shoeAccent: 0xD9A441, socks: 0x2B2B2B, scale: 0.83, build: 0.95,
  },
  // Teen phenom: tennis whites with the family purple, swept auburn hair, sulky
  theo_wellington: {
    skin: SKIN_TONES[0], hair: 'swept', hairColor: HAIR_COLORS.auburn, hat: null, bottom: 'shorts', bottomColor: 0x2B2F4A,
    brows: 'worried', mouth: 'flat', racket: 0x6B3F8E, collar: 0x6B3F8E, sleeveTrim: 0x6B3F8E, wristband: 0x6B3F8E,
    shoeAccent: 0x6B3F8E, belt: null, scale: 0.77, build: 0.92,
  },
  // Ten-year-old: pink tee, yellow visor + ponytail tie, junior racket
  lily_santos: {
    skin: SKIN_TONES[2], hair: 'ponytail', hairColor: HAIR_COLORS.brown, tieColor: 0xF4D03F, hat: 'visor', hatColor: 0xF4D03F,
    hatBrim: 0xF4D03F, bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'soft', mouth: 'grin', blush: true, polo: false,
    racket: 0xF4D03F, shoeAccent: 0xF06292, socks: 0xF8BBD0, belt: null, scale: 0.63, build: 1.02,
  },
  // College captain: slate crew with a gold stripe, black shorts, tall and lean
  nate_okafor: {
    skin: SKIN_TONES[4], hair: 'short', hairColor: HAIR_COLORS.black, hat: null, bottom: 'shorts', bottomColor: 0x1C1D1F,
    brows: 'stern', mouth: 'flat', polo: false, stripe: 0xF1C40F, racket: 0xF1C40F, wristband: 0xF1C40F,
    shoes: 0x1C1D1F, shoeSole: 0xF2F0EA, shoeAccent: 0xF1C40F, belt: null, scale: 0.96, build: 0.93,
  },
  // Social chair: mauve polo, white bun, sunglasses, gold necklace, forever mid-gasp
  babs_hendricks: {
    skin: SKIN_TONES[0], hair: 'bun', hairColor: HAIR_COLORS.white, hat: null, sunglasses: true, necklace: 0xC9A24A,
    bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'soft', mouth: 'o', blush: true, racket: null, collar: 0xF4F1EA,
    sleeveTrim: 0xF4F1EA, scale: 0.82, build: 1.08,
  },
  // 1960s whites, long silver hair, green sweatband, wooden racket
  gloria_castellano: {
    skin: SKIN_TONES[2], hair: 'long', hairColor: HAIR_COLORS.silver, hat: 'headband', hatColor: 0x2D5A3D,
    bottom: 'skirt', bottomColor: 0xF2EFE8, brows: 'haughty', mouth: 'grin', racket: 0x9A6A3A, collar: 0x2D5A3D,
    sleeveTrim: 0x2D5A3D, wristband: 0x2D5A3D, belt: null, scale: 0.8, build: 0.93,
  },
  // Retired colonel: grey polo, navy cap with gold emblem, cream slacks, ramrod straight
  frank_deluca: {
    skin: SKIN_TONES[1], hair: 'bald', hairColor: HAIR_COLORS.grey, hat: 'cap', hatColor: 0x1F2A44, hatBrim: 0x1F2A44,
    hatLogo: 0xD9A441, bottom: 'pants', bottomColor: 0xE3DAC2, brows: 'stern', mouth: 'flat', racket: 0x1F2A44,
    collar: 0xECEAE4, belt: 0x2B1F16, shoes: 0xF2F0EA, shoeAccent: 0x1F2A44, scale: 0.91, build: 1.06,
  },
  // Pilot: lime polo + forward white cap, swept brown hair, intense
  leo_brandt: {
    skin: SKIN_TONES[0], hair: 'swept', hairColor: HAIR_COLORS.chestnut, hat: 'cap', hatColor: 0xF4F1EA, hatBrim: 0x6F8F1E,
    bottom: 'shorts', bottomColor: 0x1F3A68, brows: 'stern', mouth: 'grin', racket: 0x6F8F1E, collar: 0xF4F1EA,
    wristband: 0xA3CB38, shoeAccent: 0xA3CB38, scale: 0.93, build: 1.03,
  },
  // Event planner: coral polo, long blonde hair, lime headband (matches Leo), navy skirt
  harper_brandt: {
    skin: SKIN_TONES[1], hair: 'long', hairColor: HAIR_COLORS.blonde, hat: 'headband', hatColor: 0xA3CB38,
    bottom: 'skirt', bottomColor: 0x1F3A68, brows: 'soft', mouth: 'smile', blush: true, racket: 0xA3CB38,
    collar: 0xF4F1EA, shoeAccent: 0xFF6F61, belt: null, scale: 0.84,
  },
  // Surgeon: burgundy polo, swept black hair, khaki shorts, worried brows (the pager)
  vik_rao: {
    skin: SKIN_TONES[3], hair: 'swept', hairColor: HAIR_COLORS.black, hat: null, bottom: 'shorts', bottomColor: 0xC9B98E,
    brows: 'worried', mouth: 'smile', racket: 0x2B2B2B, collar: 0xF2EFE8, belt: 0x3B2A1E, shoeAccent: 0x7B241C,
    scale: 0.89,
  },
  // Pool attendant: lifeguard-red tee, white shorts, white visor with a red brim, whistle, zinc nose
  dani_kowalski: {
    female: true, skin: SKIN_TONES[1], hair: 'ponytail', hairColor: HAIR_COLORS.blonde, tieColor: 0xD63A2F, hat: 'visor',
    hatColor: 0xF4F1EA, hatBrim: 0xD63A2F, bottom: 'shorts', bottomColor: 0xF4F1EA, brows: 'soft', mouth: 'grin',
    polo: false, sleeveTrim: 0xF4F1EA, whistle: 0xF4F1EA, noseColor: 0xF7F5F0, racket: null, staff: true, belt: null,
    shoes: 0xD63A2F, shoeSole: 0xF4F1EA, shoeAccent: 0xF4F1EA, socks: 0xF4F1EA, scale: 0.85, build: 0.97,
  },
  // Snack bar: pool-house blue shirt, white bib apron with blue trim, yellow cap, grey mustache
  gus_papadakis: {
    skin: SKIN_TONES[2], hair: 'short', hairColor: HAIR_COLORS.grey, hat: 'cap', hatColor: 0xF2C14E, hatBrim: 0x2F6DB3,
    hatLogo: 0x2F6DB3, bottom: 'pants', bottomColor: 0x3A3F4A, brows: 'soft', mouth: 'grin', mustache: true, blush: true,
    apron: 0xF7F4EC, apronTrim: 0x2F6DB3, collar: 0xF2C14E, racket: null, staff: true, belt: null,
    shoes: 0x2B2B2B, shoeSole: 0xE8E4DA, shoeAccent: 0x2F6DB3, scale: 0.87, build: 1.13,
  },
  // Fitness: teal athletic crew with a white stripe, black track pants with white side stripes
  marcus_bell: {
    skin: SKIN_TONES[3], hair: 'short', hairColor: HAIR_COLORS.black, hat: null, bottom: 'pants', bottomColor: 0x1C1D1F,
    pantStripe: 0xF4F1EA, brows: 'soft', mouth: 'grin', polo: false, stripe: 0xF4F1EA, wristband: 0xF4F1EA,
    racket: null, staff: true, belt: null, shoes: 0xF4F1EA, shoeSole: 0x1C1D1F, shoeAccent: 0x1FA58A,
    scale: 0.93, build: 1.1,
  },
  // Security: navy uniform shirt + trousers, navy cap with a gold crest, gold shield, epaulets
  otis_grant: {
    skin: SKIN_TONES[4], hair: 'short', hairColor: HAIR_COLORS.grey, hat: 'cap', hatColor: 0x1B2338, hatBrim: 0x141A2A,
    hatLogo: 0xD9A441, bottom: 'pants', bottomColor: 0x1B2338, brows: 'stern', mouth: 'flat', mustache: true,
    collar: 0x141A2A, sleeveTrim: 0x141A2A, badge: 0xD9A441, epaulets: 0x141A2A, racket: null, staff: true,
    belt: 0x111111, shoes: 0x151515, shoeSole: 0x0E0E0E, shoeAccent: 0x151515, socks: 0x151515, scale: 0.93, build: 1.1,
  },
};

/**
 * Archetype look & feel. Colours can be overridden per archetype in npcs.json
 * (archetypes.<id>.nameTagColor / dialogueColor / soreLoser) via configureArchetypes().
 *   tag       name-tag dot colour        dialogue  dialogue name colour (legacy hex values are
 *   idle      idle-variant clips                    re-themed by DialogueBox)
 *   brows / mouth  defaults for derived looks      soreLoser  sulks after losing a match
 */
const ARCHETYPES = {
  entitled: { tag: '#E74C3C', dialogue: '#E74C3C', idle: ['idle_watch', 'idle_watch', 'idle_look', 'idle_shift'], brows: 'haughty', mouth: 'flat', soreLoser: true },
  friendly: { tag: '#27AE60', dialogue: '#27AE60', idle: ['idle_look', 'idle_shift', 'idle_look'], brows: 'soft', mouth: 'smile' },
  clueless: { tag: '#3498DB', dialogue: '#3498DB', idle: ['idle_look', 'idle_look', 'idle_shift', 'idle_watch'], brows: 'worried', mouth: 'o' },
  competitive: { tag: '#E67E22', dialogue: '#F2A65A', idle: ['idle_shift', 'idle_shift', 'idle_watch', 'idle_look'], brows: 'stern', mouth: 'flat', soreLoser: true },
  social: { tag: '#E84393', dialogue: '#F29CC4', idle: ['idle_look', 'idle_look', 'idle_shift'], brows: 'soft', mouth: 'smile' },
  veteran: { tag: '#C9C7C2', dialogue: '#D8D4CB', idle: ['idle_look', 'idle_shift', 'idle_watch'], brows: 'stern', mouth: 'flat' },
  junior: { tag: '#F4D03F', dialogue: '#F7DC6F', idle: ['idle_shift', 'idle_look', 'idle_shift', 'idle_look'], brows: 'soft', mouth: 'grin' },
  staff: { tag: '#D9A441', dialogue: '#E6C170', idle: ['idle_look', 'idle_watch', 'idle_shift'], brows: 'stern', mouth: 'smile' },
};
const ARCH_FALLBACK = { tag: '#C9A24A', dialogue: null, idle: ARCHETYPES.friendly.idle, brows: 'soft', mouth: 'smile' };
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Apply npcs.json archetype overrides (call before spawning NPCs). Unknown archetypes are added. */
export function configureArchetypes(defs) {
  if (!defs || typeof defs !== 'object') return;
  for (const [id, d] of Object.entries(defs)) {
    if (!d || typeof d !== 'object') continue;
    const a = ARCHETYPES[id] || (ARCHETYPES[id] = { ...ARCH_FALLBACK });
    if (HEX_RE.test(d.nameTagColor || '')) a.tag = d.nameTagColor;
    if (HEX_RE.test(d.dialogueColor || '')) a.dialogue = d.dialogueColor;
    if (typeof d.soreLoser === 'boolean') a.soreLoser = d.soreLoser;
  }
}

// Name tag fade distances (camera -> tag)
const TAG_FAR_FULL = 11;
const TAG_FAR_ZERO = 16;
const TAG_NEAR_ZERO = 2.2;
const TAG_NEAR_FULL = 3.6;
const TAG_W = 1.25;          // world width at normal distances
const TAG_CONST_DIST = 7;    // closer than this the tag shrinks to keep a constant on-screen size

const _emojiTextures = new Map();

// Reaction emoji → reaction clip (MissionSystem shows 😊 / 😤 / 🤷 after a choice)
const REACTION_CLIPS = {
  '\uD83D\uDE0A': 'react_happy', '\uD83D\uDE00': 'react_happy', '\uD83D\uDE03': 'react_happy', '\uD83C\uDF89': 'react_happy', '\uD83D\uDC4D': 'react_happy',
  '\uD83D\uDE24': 'react_annoyed', '\uD83D\uDE20': 'react_annoyed', '\uD83D\uDE21': 'react_annoyed', '\uD83D\uDE12': 'react_annoyed',
  '\uD83E\uDD37': 'shrug', '\uD83E\uDD14': 'shrug',
};
const MOOD_CLIPS = { satisfied: 'react_happy', unsatisfied: 'react_annoyed', neutral: 'shrug' };

const WALK_STRIDE = 1.45;   // model units per walk cycle (CLIP_DEFS.walk.stride)
const RUN_STRIDE = 2.4;
const SIT_CHANCE = 0.3;      // chance an idle NPC near a free seat goes to sit
const SIT_CHANCE_BENCH_WP = 0.75; // …when its current waypoint is a *_bench waypoint
const SEAT_SEARCH_RADIUS = 9;
const _tmpV = new THREE.Vector3();

// One-shot clips a new movement command may cut short (swings / serves always finish)
const INTERRUPTIBLE = new Set(['split_step', 'react_happy', 'react_annoyed', 'shrug', 'wave', 'greet',
  'idle_look', 'idle_shift', 'idle_watch']);

// Areas (e.g. a court with a match on) wandering NPCs should not pick as a destination
const _busyAreas = new Set();
function isBusyKey(key) {
  if (!_busyAreas.size || /_bench$/i.test(key)) return false;
  for (const a of _busyAreas) if (key.startsWith(a)) return true;
  return false;
}

// Speech bubble (score calls etc.)
const BUBBLE_W = 256, BUBBLE_H = 112;

const DEG = Math.PI / 180;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const range2 = (v, def) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && v[0] >= 0 && v[0] <= v[1] ? [v[0], v[1]] : def);
const chance = (v, def) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : def);

/** Yaw a duty point asks for: its `face` (radians, parsed), or none. */
function faceYaw(pt) {
  return pt && Number.isFinite(pt.face) ? pt.face : null;
}

/**
 * Staff duty from npcs.json (all optional; unknown waypoints are skipped):
 *   post:   { spot: <waypoint>, face: <deg | waypoint to look at>, seat: <seat id>,
 *             stay: [s, s], roam: [<spot>…], roamChance, roamStay: [s, s],
 *             breaks: [<spot>…], breakChance, breakStay: [s, s] }
 *   patrol: { route: [<spot>…], chance, pause: [s, s], speed }   (a loop from the post and back)
 * A <spot> is a waypoint key or { spot, face, hold: [s, s] }. face: degrees, 0 = +z (south),
 * 90 = +x (east), or a waypoint key to look toward. The NPC idles at the post most of the time,
 * with short roams / breaks (and, with a patrol, walks the whole route now and then); it heads
 * straight back to the post while a mission step needs it.
 */
function parseDuty(data, waypoints) {
  const post = data && typeof data.post === 'object' ? data.post : null;
  const patrol = data && typeof data.patrol === 'object' ? data.patrol : null;
  if (!post && !patrol) return null;
  const wps = waypoints || {};
  const point = (ref) => {
    const o = typeof ref === 'string' ? { spot: ref } : (ref && typeof ref === 'object' ? ref : null);
    const wp = o && wps[o.spot];
    if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.z)) return null;
    const pt = { key: o.spot, x: wp.x, z: wp.z, face: null, hold: range2(o.hold, null) };
    if (Number.isFinite(o.face)) pt.face = o.face * DEG;
    else if (typeof o.face === 'string' && wps[o.face]) pt.face = Math.atan2(wps[o.face].x - wp.x, wps[o.face].z - wp.z);
    return pt;
  };
  const list = (arr) => (Array.isArray(arr) ? arr.map(point).filter(Boolean) : []);
  const route = list(patrol && patrol.route);
  const postPt = post ? point({ spot: post.spot, face: post.face, hold: post.hold }) : null;
  const home = postPt || route[0];
  if (!home) return null;
  return {
    post: home,
    seatId: post && typeof post.seat === 'string' ? post.seat : null,
    stay: range2(post && post.stay, [35, 70]),
    roam: list(post && post.roam),
    roamChance: chance(post && post.roamChance, 0.3),
    roamStay: range2(post && post.roamStay, [6, 14]),
    breaks: list(post && post.breaks),
    breakChance: chance(post && post.breakChance, 0.08),
    breakStay: range2(post && post.breakStay, [25, 45]),
    route,
    patrolChance: chance(patrol && patrol.chance, route.length ? 0.5 : 0),
    pause: range2(patrol && patrol.pause, [1, 3]),
    patrolSpeed: Number.isFinite(patrol && patrol.speed) ? Math.max(0.8, Math.min(3, patrol.speed)) : 0,
    leg: 'post', target: home, routeIdx: 0, holdOnce: false, queue: [],
  };
}

/**
 * NPC - club member with wandering, dialogue, and task functionality
 */
export class NPC {
  constructor(scene, physicsWorld, data, waypoints) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.data = data;
    this.waypoints = waypoints;

    this.id = data.id;
    this.name = data.name;
    this.archetype = data.archetype;
    this.shirtColor = parseInt(String(data.shirtColor || '#3A7BD5').replace('#', ''), 16) || 0x3A7BD5;
    const arch = ARCHETYPES[this.archetype] || ARCH_FALLBACK;
    this.arch = arch;
    /** Name-tag dot colour and dialogue name colour (archetype). */
    this.tagColor = arch.tag;
    this.dialogueColor = arch.dialogue || arch.tag;
    /** Sulks after losing a match (per-NPC `soreLoser` in npcs.json beats the archetype). */
    this.soreLoser = typeof data.soreLoser === 'boolean' ? data.soreLoser : !!arch.soreLoser;

    this.mesh = null;
    this.body = null;
    this.nameTag = null;
    this.exclamation = null;

    this.state = 'idle'; // idle, wandering, talking, playing
    this.currentTarget = null;
    this.wanderTimer = Math.random() * 5 + 2;
    this.hasRequest = false;
    this._mood = 'neutral';
    /** True once something (a mission reaction / client verdict) has set the mood. */
    this.moodSet = false;
    this.animTime = 0;
    this._markerTime = 0;
    this._moving = 0;

    this.reactionSprite = null;
    this.reactionTimer = 0;

    // Sitting (benches) and tennis ('playing') state
    this._seatTarget = null;     // seat we are walking to
    this._sitSeat = null;        // seat we are on / getting up from (drives the mesh offset)
    this._sitBlend = 0;
    this._sitTimer = 0;
    this._wanderTime = 0;
    this._lastWaypointKey = null;
    this.playing = null;         // { courtId, side } while in the 'playing' state
    this._playMove = null;       // { x, z, speed, face, onArrive }
    this._playClip = null;
    this._faceYaw = null;
    this._resumePlaying = false;
    this._camDist = 10;
    this._reactHold = 0;
    this.moveSpeed = 0;          // current scripted walking speed (m/s), 0 when standing
    this._holdSeat = false;      // sheltering (rain delay): stay seated / put until released
    this._settle = true;         // moveTo: settle into 'ready' on arrival
    this.bubble = null;          // speech bubble sprite (lazy)
    this._bubbleTimer = 0;
    this._dutyFace = null;       // yaw to face while standing at a duty point
    this._dutySitTime = 0;       // sit time for the next _sitDown (duty seats)

    CameraTracker.install(scene);
    this._blobs = BlobShadows.get(scene);
    this._blobSlot = this._blobs.alloc();

    /** Staff duty (npcs.json `post` / `patrol`): where they work instead of wandering. */
    this.duty = parseDuty(data, waypoints);
    const startWaypoint = this.duty ? this.duty.post : this._getPreferredWaypoint();
    this._createMesh(startWaypoint);
    this._createPhysics(startWaypoint);
    this._createNameTag();
    this._createExclamation();
  }

  /** How this member feels about you ('neutral' | 'satisfied' | 'unsatisfied' …); drives small talk. */
  get mood() { return this._mood; }
  set mood(v) { this._mood = v; this.moodSet = true; }

  /** Mark an area id (e.g. 'court3') as busy so wandering NPCs pick other destinations. */
  static setAreaBusy(areaId, busy) {
    if (busy) _busyAreas.add(areaId); else _busyAreas.delete(areaId);
  }

  _getPreferredWaypoint() {
    let prefs = this.data.preferredAreas;
    if (prefs && _busyAreas.size) prefs = prefs.filter(a => !_busyAreas.has(a));
    if (prefs && prefs.length > 0) {
      const area = prefs[Math.floor(Math.random() * prefs.length)];
      // Numbered spots for the area (patio1..3) are shared out at random so NPCs
      // don't all stack on the first; otherwise the first waypoint naming the area.
      const a = area.toLowerCase();
      const numbered = [];
      let first = null;
      for (const [key, wp] of Object.entries(this.waypoints)) {
        const k = key.toLowerCase();
        if (!k.includes(a) || isBusyKey(key)) continue;
        if (!first) first = wp;
        if (k.startsWith(a) && /^\d+$/.test(k.slice(a.length))) numbered.push(wp);
      }
      if (numbered.length) {
        const wp = numbered[Math.floor(Math.random() * numbered.length)];
        this._lastWaypointKey = Object.keys(this.waypoints).find(k => this.waypoints[k] === wp) || null;
        return wp;
      }
      if (first) {
        this._lastWaypointKey = Object.keys(this.waypoints).find(k => this.waypoints[k] === first) || null;
        return first;
      }
    }
    // Fallback to a random waypoint
    let keys = Object.keys(this.waypoints);
    if (_busyAreas.size) { const free = keys.filter(k => !isBusyKey(k)); if (free.length) keys = free; }
    const key = keys[Math.floor(Math.random() * keys.length)];
    this._lastWaypointKey = key;
    return this.waypoints[key];
  }

  /** Deterministic fallback look for NPCs without a hand-authored style. */
  _deriveStyle() {
    const h = (salt) => hashString(this.id + salt);
    const female = h('f') < 0.5;
    const hairs = female ? ['bob', 'ponytail', 'bun', 'long'] : ['short', 'swept', 'bald', 'short'];
    const hats = [null, 'cap', 'visor', 'headband'];
    const hairKeys = Object.keys(HAIR_COLORS);
    const brows = this.arch.brows || 'soft';
    const mouth = this.arch.mouth || 'smile';
    return {
      female,
      skin: SKIN_TONES[Math.floor(h('s') * SKIN_TONES.length)],
      hair: hairs[Math.floor(h('h') * hairs.length)],
      hairColor: HAIR_COLORS[hairKeys[Math.floor(h('c') * hairKeys.length)]],
      hat: hats[Math.floor(h('t') * hats.length)],
      hatColor: 0xF2F0EA,
      bottom: female && h('b') < 0.7 ? 'skirt' : 'shorts',
      bottomColor: h('bc') < 0.6 ? 0xF2EFE8 : 0x2F3440,
      brows, mouth,
      blush: this.archetype === 'friendly' || this.archetype === 'social' || this.archetype === 'junior',
      racket: h('r') < 0.6 ? 0x2B2B2B : null,
      polo: h('p') < 0.6,
      scale: 0.83 + h('sc') * 0.09,
    };
  }

  _createMesh(pos) {
    this.mesh = new THREE.Group();
    this.mesh.name = `NPC:${this.id}`;

    const style = { ...(NPC_STYLES[this.id] || this._deriveStyle()) };
    style.shirt = this.shirtColor;
    this.style = style;

    this.character = new Character(style, `npc:${this.id}:${this.data.shirtColor}`);
    this.character.anim.idleVariants = this.arch.idle || ARCH_FALLBACK.idle;
    const s = style.scale ?? 0.87;
    // build: body width/depth relative to height (stocky > 1 > slim); kept subtle so rackets still line up
    const bw = Math.max(0.85, Math.min(1.15, style.build ?? 1));
    this.character.root.scale.set(s * bw, s, s * bw);
    this.mesh.add(this.character.root);
    this.modelScale = s;

    // Legacy limb handles (other code / debugging may poke these)
    this.leftLeg = this.character.legL;
    this.rightLeg = this.character.legR;
    this.leftArm = this.character.armL;
    this.rightArm = this.character.armR;

    this.mesh.position.set(pos.x, pos.y || 0, pos.z);
    this.scene.add(this.mesh);
  }

  _createPhysics(pos) {
    const shape = new CANNON.Sphere(SIZES.npcRadius);
    this.body = new CANNON.Body({
      mass: 60,
      position: new CANNON.Vec3(pos.x, (pos.y || 0) + SIZES.npcRadius, pos.z), // resting on the ground
      shape,
      linearDamping: 0.95,
      angularDamping: 1.0,
      fixedRotation: true,
    });
    this.physicsWorld.addBody(this.body);
    this._settleTime = 1.5;
  }

  /** Club-style pill name tag (forest green + cream, archetype colour dot). */
  _createNameTag() {
    const W = 256, H = 64;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const font = '600 26px "Trebuchet MS", "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.font = font;
    const textW = Math.min(W - 64, ctx.measureText(this.data.name).width);
    const pillW = Math.min(W - 6, textW + 58);
    const x0 = (W - pillW) / 2;
    const y0 = 10, ph = 44, r = ph / 2;

    // Soft drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.roundRect(x0 + 1, y0 + 3, pillW, ph, r);
    ctx.fill();
    // Pill
    ctx.fillStyle = 'rgba(33,69,47,0.94)';
    ctx.beginPath();
    ctx.roundRect(x0, y0, pillW, ph, r);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#E9DCB2';
    ctx.beginPath();
    ctx.roundRect(x0 + 2.5, y0 + 2.5, pillW - 5, ph - 5, r - 2.5);
    ctx.stroke();
    // Archetype dot
    ctx.fillStyle = this.tagColor || '#C9A24A';
    ctx.beginPath();
    ctx.arc(x0 + 22, y0 + ph / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#F4E8C1';
    ctx.stroke();
    // Name
    ctx.font = font;
    ctx.fillStyle = '#F4E8C1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.data.name, x0 + 36, y0 + ph / 2 + 1, W - x0 - 44);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 2;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false })
    );
    sprite.scale.set(TAG_W, TAG_W * H / W, 1);
    this._tagAspect = H / W;
    sprite.center.set(0.5, 0);
    sprite.position.y = this._headTop() + 0.06;
    sprite.renderOrder = 10;
    sprite.material.opacity = 0;
    sprite.visible = false;
    this.mesh.add(sprite);
    this.nameTag = sprite;
  }

  _headTop() {
    const hatExtra = this.style.hat === 'bucket' ? 0.12 : (this.style.hair === 'bun' ? 0.06 : 0);
    return (1.84 + hatExtra) * this.modelScale;
  }

  /** Bouncy gold "!" request marker (shared geometry/material). */
  _createExclamation() {
    const geo = getGeometry('npc-exclaim', () => mergeParts([
      { geometry: roundedBox(0.12, 0.3, 0.12, 0.05, 3), matrix: makeMatrix(0, 0.12, 0) },
      { geometry: sphereGeo(0.07, 12, 8), matrix: makeMatrix(0, -0.13, 0) },
    ]));
    const material = mat(0xF2B82E, { emissive: 0xB0740C, emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.25 });
    const marker = new THREE.Mesh(geo, material);
    marker.name = 'RequestMarker';
    marker.userData.noAO = true;
    const baseY = this._headTop() + 0.72;
    marker.position.y = baseY;
    marker.visible = false;
    this._markerBaseY = baseY;
    this.mesh.add(marker);
    this.exclamation = marker;
  }

  setHasRequest(val) {
    this.hasRequest = val;
    this.exclamation.visible = val;
    if (val) this._markerTime = 0;
  }

  showReaction(emoji) {
    let texture = _emojiTextures.get(emoji);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext('2d');
      ctx.font = '72px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, 48, 52);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      _emojiTextures.set(emoji, texture);
    }
    if (!this.reactionSprite) {
      this.reactionSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false })
      );
      this.reactionSprite.scale.set(0.6, 0.6, 1);
      this.reactionSprite.renderOrder = 11;
    } else {
      this.reactionSprite.material.map = texture;
    }
    this.reactionSprite.material.opacity = 1;
    this.reactionSprite.position.y = this._headTop() + 0.9;
    if (!this.reactionSprite.parent) this.mesh.add(this.reactionSprite);
    this.reactionTimer = 2.0;

    // Body language to match
    const clip = REACTION_CLIPS[emoji] || MOOD_CLIPS[this.mood];
    if (clip) this.react(clip);
  }

  /** Play a reaction clip ('react_happy' | 'react_annoyed' | 'shrug' | 'wave' | 'greet' …). */
  react(clip) {
    if (this.state === 'sitting') this._standUp();
    const d = this.character.play(clip, { fade: 0.2 });
    if (this.state === 'wandering') this._reactHold = d; // stand still while reacting
  }

  update(dt, playerPos) {
    // Reaction timer (float up + fade)
    if (this.reactionTimer > 0) {
      this.reactionTimer -= dt;
      if (this.reactionSprite) {
        const age = 2.0 - this.reactionTimer;
        this.reactionSprite.position.y = this._headTop() + 0.9 + age * 0.3;
        const pop = Math.min(1, age * 6);
        const sc = 0.6 * (0.6 + 0.4 * pop + 0.12 * Math.sin(Math.min(1, age * 3) * Math.PI));
        this.reactionSprite.scale.set(sc, sc, 1);
        this.reactionSprite.material.opacity = Math.max(0, Math.min(1, this.reactionTimer));
      }
      if (this.reactionTimer <= 0 && this.reactionSprite) {
        this.mesh.remove(this.reactionSprite);
      }
    }

    // State machine
    this._moving = 0;
    this.moveSpeed = 0;
    switch (this.state) {
      case 'idle':
        this._updateIdle(dt);
        break;
      case 'wandering':
        this._updateWandering(dt);
        break;
      case 'talking':
        this._faceTarget(playerPos, dt);
        break;
      case 'sitting':
        this._updateSitting(dt);
        break;
      case 'playing':
        this._updatePlaying(dt);
        break;
    }

    // Just after spawning, pull a hovering body down briskly (linearDamping also damps gravity)
    if (this._settleTime > 0) {
      this._settleTime -= dt;
      if (this.body.position.y > SIZES.npcRadius + 0.02) this.body.velocity.y = Math.min(this.body.velocity.y, -6);
    }

    // Sync mesh to physics (feet on the ground: sphere centre minus its radius); while sitting
    // (or getting up) the mesh eases between the body and the seat.
    const gx = this.body.position.x, gz = this.body.position.z;
    const gy = Math.max(0, this.body.position.y - SIZES.npcRadius);
    const sitTarget = this.state === 'sitting' ? 1 : 0;
    const ds = sitTarget - this._sitBlend;
    this._sitBlend += Math.sign(ds) * Math.min(Math.abs(ds), dt * 2.2);
    if (this._sitSeat && this._sitBlend > 0) {
      const k = this._sitBlend * this._sitBlend * (3 - 2 * this._sitBlend);
      const seat = this._sitSeat;
      this.mesh.position.set(
        gx + (seat.x - gx) * k,
        gy + (seat.y - SIT_SEAT_HEIGHT * this.modelScale - gy) * k,
        gz + (seat.z - gz) * k,
      );
    } else {
      this.mesh.position.set(gx, gy, gz);
      if (this._sitSeat && sitTarget === 0) { releaseSeat(this._sitSeat, this); this._sitSeat = null; }
    }

    // Animation: talking looks at the player; mixer rate drops with camera distance
    if (this.state === 'talking' && playerPos) this.character.lookAt(_tmpV.set(playerPos.x, this.mesh.position.y + 1.5, playerPos.z));
    const cd = this._camDist;
    const low = Quality.tier === 'low';
    this.character.updateEvery = cd > 30 ? (low ? 5 : 4) : cd > 16 ? (low ? 3 : 2) : (low && cd > 10 ? 2 : 1);
    // Racket swings stay frame-exact near the camera (the ball meets the strings on the contact frame)
    if (this.state === 'playing' && cd < 26 && this.character.anim.oneShot) this.character.updateEvery = 1;
    this.character.update(dt);

    const bs = 0.95 * this.modelScale;
    this._blobs.set(this._blobSlot, this.mesh.position.x, this.mesh.position.z, bs, bs, 0, Math.max(this.mesh.position.y + 0.02, 0.065));

    this._updateOverlays(dt, playerPos);
  }

  _updateOverlays(dt, playerPos) {
    // Camera distance (fallback: player distance + typical camera offset)
    let camDist;
    if (CameraTracker.valid) {
      const c = CameraTracker.position;
      const dx = c.x - this.mesh.position.x, dy = c.y - (this.mesh.position.y + 1.6), dz = c.z - this.mesh.position.z;
      camDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    } else {
      camDist = playerPos ? this.mesh.position.distanceTo(playerPos) + 8 : 10;
    }

    // Name tag: visible in a comfortable band, faded at the edges
    let a = 1;
    if (camDist > TAG_FAR_FULL) a = 1 - (camDist - TAG_FAR_FULL) / (TAG_FAR_ZERO - TAG_FAR_FULL);
    if (camDist < TAG_NEAR_FULL) a = Math.min(a, (camDist - TAG_NEAR_ZERO) / (TAG_NEAR_FULL - TAG_NEAR_ZERO));
    if (this.state === 'talking') a = Math.min(a, 0.35);
    a = Math.max(0, Math.min(1, a));
    this._camDist = camDist;
    // Body LOD: low-detail mesh when far (hysteresis) and always on the low tier
    const far = Quality.tier === 'low' || (this._lodFar ? camDist > 13 : camDist > 16);
    if (far !== this._lodFar) { this._lodFar = far; this.character.setLod(far); }
    const tag = this.nameTag;
    tag.material.opacity += (a - tag.material.opacity) * Math.min(1, dt * 10);
    tag.visible = tag.material.opacity > 0.02;
    if (tag.visible) {
      const w = TAG_W * Math.min(1, camDist / TAG_CONST_DIST);
      tag.scale.set(w, w * this._tagAspect, 1);
    }

    // Speech bubble: pops in, holds, fades; constant-ish on-screen size
    if (this.bubble && this.bubble.visible) {
      this._bubbleTimer -= dt;
      const b = this.bubble;
      const age = this._bubbleAge = (this._bubbleAge || 0) + dt;
      const pop = Math.min(1, age * 7);
      b.material.opacity = Math.max(0, Math.min(1, this._bubbleTimer * 3)) * (camDist > 42 ? 0 : 1);
      const w = 1.25 * Math.max(0.75, Math.min(2.6, camDist / 7)) * (0.7 + 0.3 * pop);
      b.scale.set(w, w * BUBBLE_H / BUBBLE_W, 1);
      if (this._bubbleTimer <= 0) b.visible = false;
    }

    // Request marker: bounce + squash + spin, scaled up a little with distance for readability
    if (this.exclamation.visible) {
      this._markerTime += dt;
      const t = this._markerTime;
      const bounce = Math.abs(Math.sin(t * 4.2));
      const squash = 1 - Math.max(0, 0.25 - bounce) * 0.8;
      const grow = camDist < 6 ? Math.max(0.35, camDist / 6) : Math.min(2.2, Math.max(1, camDist / 12));
      const intro = Math.min(1, t * 4);
      this.exclamation.position.y = this._markerBaseY + bounce * 0.22 + (grow - 1) * 0.3;
      this.exclamation.rotation.y += dt * 2.2;
      this.exclamation.scale.set(grow * intro * (2 - squash), grow * intro * squash, grow * intro * (2 - squash));
    }
  }

  _updateIdle(dt) {
    this.character.setLocomotion(0);
    if (this._holdSeat) { this.body.velocity.set(0, this.body.velocity.y, 0); return; }
    this.wanderTimer -= dt;

    if (this.duty) {
      this.body.velocity.set(0, this.body.velocity.y, 0);
      if (this._dutyFace !== null) this._turnToward(this._dutyFace, dt, 4);
      // Needed for a mission step: wait at the post (walk back to it if away)
      if (this.hasRequest && this.duty.leg !== 'post' && this.wanderTimer > 2) this.wanderTimer = 2;
      if (this.wanderTimer <= 0) this._dutyNext();
      return;
    }

    if (this.wanderTimer <= 0) {
      const seat = this._pickSeat();
      this.state = 'wandering';
      this._wanderTime = 0;
      if (seat) {
        this._seatTarget = seat;
        this.currentTarget = { x: seat.x + Math.sin(seat.yaw) * 0.5, z: seat.z + Math.cos(seat.yaw) * 0.5 };
      } else {
        this.currentTarget = this._getPreferredWaypoint();
      }
      this.wanderTimer = Math.random() * 8 + 4;
    }
  }

  /** A free seat near us, sometimes (more likely when we stopped at a *_bench waypoint). */
  _pickSeat() {
    const chance = /_bench$/i.test(this._lastWaypointKey || '') ? SIT_CHANCE_BENCH_WP : SIT_CHANCE;
    if (Math.random() > chance) return null;
    const seats = findSeats(this.scene);
    let best = null, bestD = SEAT_SEARCH_RADIUS * SEAT_SEARCH_RADIUS;
    const px = this.body.position.x, pz = this.body.position.z;
    for (const seat of seats) {
      if (seat.taken || seat.reserved) continue;
      const dx = seat.x - px, dz = seat.z - pz;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = seat; }
    }
    if (best && claimSeat(best, this)) return best;
    return null;
  }

  // ── Staff duty (npcs.json `post` / `patrol`, see parseDuty) ──

  /** Walk to a duty point (a parsed waypoint); `leg` says what happens on arrival. */
  _dutyGo(pt, leg, speed = 0) {
    const d = this.duty;
    d.leg = leg;
    d.target = pt;
    this._dutyFace = null;
    this._cancelSeatTarget();
    // A fresh target per leg (not per frame): the route planner caches by target identity
    this.currentTarget = { x: pt.x, z: pt.z, precise: true, duty: true, speed };
    this.state = 'wandering';
    this._wanderTime = 0;
    this._reactHold = 0;
  }

  /**
   * Back to the post. Off a patrol, the way home follows the route (forward or back, whichever is
   * shorter): the loop is known to be walkable, a straight line across the grounds may not be.
   */
  _dutyHeadHome() {
    const d = this.duty;
    d.queue.length = 0;
    if (d.leg === 'patrol' && d.route.length) {
      const c = Math.max(0, Math.min(d.route.length - 1, d.routeIdx - 1)); // point we were walking to
      const px = this.body.position.x, pz = this.body.position.z;
      const len = (pts) => {
        let L = 0, x = px, z = pz;
        for (const q of pts) { L += Math.hypot(q.x - x, q.z - z); x = q.x; z = q.z; }
        return L + Math.hypot(d.post.x - x, d.post.z - z);
      };
      const fwd = d.route.slice(c);
      const back = d.route.slice(0, c).reverse();
      d.queue.push(...(len(back) < len(fwd) ? back : fwd));
    }
    const speed = d.patrolSpeed || 0;
    if (d.queue.length) this._dutyGo(d.queue.shift(), 'home', speed);
    else this._dutyGo(d.post, 'post', speed);
  }

  _atPoint(pt, r = 1.2) {
    const dx = pt.x - this.body.position.x, dz = pt.z - this.body.position.z;
    return dx * dx + dz * dz < r * r;
  }

  /** Idle timer ran out: decide the next duty leg. Mostly: stay at the post. */
  _dutyNext() {
    const d = this.duty;
    // Mid-patrol: next point on the loop (then home to the post); needed: head home along it
    if (d.leg === 'patrol') {
      if (this.hasRequest) { this._dutyHeadHome(); return; }
      if (d.routeIdx < d.route.length) { this._dutyGo(d.route[d.routeIdx++], 'patrol', d.patrolSpeed); return; }
    }
    if (d.leg === 'home' && d.queue.length) { this._dutyGo(d.queue.shift(), 'home', d.patrolSpeed); return; }
    if (!this._atPoint(d.post)) { this._dutyGo(d.post, 'post', d.leg === 'patrol' ? d.patrolSpeed : 0); return; }
    const hold = d.holdOnce;
    d.holdOnce = false;
    if (!this.hasRequest && !hold) {
      let r = Math.random();
      if (d.route.length && (r -= d.patrolChance) < 0) {
        d.routeIdx = 0;
        // Skip a first route point that is the post itself
        if (d.route.length > 1 && this._atPoint(d.route[0], 1.5)) d.routeIdx = 1;
        this._dutyGo(d.route[d.routeIdx++], 'patrol', d.patrolSpeed);
        return;
      }
      if (d.breaks.length && (r -= d.breakChance) < 0) { this._dutyGo(pick(d.breaks), 'break'); return; }
      if (d.roam.length && (r -= d.roamChance) < 0) { this._dutyGo(pick(d.roam), 'roam'); return; }
    }
    d.leg = 'post';
    d.target = d.post;
    this._dutyStay(d.post, d.stay);
  }

  /** Arrived at a duty point (or gave up walking there): stay a while, face, maybe sit. */
  _dutyArrive(gaveUp = false) {
    const d = this.duty;
    const pt = d.target || d.post;
    if (d.leg === 'patrol') { this._dutyStay(pt, pt.hold || d.pause); return; }
    if (d.leg === 'home') { this.wanderTimer = 0; return; }
    if (gaveUp && d.leg === 'post') { this.wanderTimer = 2 + Math.random() * 2; return; }
    const range = d.leg === 'post' ? d.stay : d.leg === 'break' ? d.breakStay : d.roamStay;
    this._dutyStay(pt, pt.hold || range);
  }

  _dutyStay(pt, range) {
    const d = this.duty;
    const t = range[0] + Math.random() * (range[1] - range[0]);
    this.wanderTimer = this.hasRequest ? Math.min(t, 6) : t;
    this._dutyFace = faceYaw(pt);
    // The post's own seat (e.g. the lifeguard chair); on a break, maybe a bench nearby
    let seat = null;
    if (d.leg === 'post' && d.seatId && !this.hasRequest) seat = this._dutySeat();
    else if (d.leg === 'break' && Math.random() < 0.6) seat = this._pickNearSeat(6);
    if (seat) {
      this._dutySitTime = t;
      this._seatTarget = seat;
      const a = seat.approach || 0.5;
      this.currentTarget = { x: seat.x + Math.sin(seat.yaw) * a, z: seat.z + Math.cos(seat.yaw) * a };
      this.state = 'wandering';
      this._wanderTime = 0;
    }
  }

  /** The reserved seat named by post.seat (claimed for us; null if missing / taken). */
  _dutySeat() {
    const id = this.duty.seatId;
    const seats = findSeats(this.scene);
    for (const seat of seats) if (seat.id === id) return claimSeat(seat, this, true) ? seat : null;
    return null;
  }

  _pickNearSeat(radius) {
    const seats = findSeats(this.scene);
    let best = null, bestD = radius * radius;
    const px = this.body.position.x, pz = this.body.position.z;
    for (const seat of seats) {
      if (seat.taken || seat.reserved) continue;
      const d = (seat.x - px) ** 2 + (seat.z - pz) ** 2;
      if (d < bestD) { bestD = d; best = seat; }
    }
    return best && claimSeat(best, this) ? best : null;
  }

  _updateWandering(dt) {
    if (!this.currentTarget) {
      this._cancelSeatTarget();
      this.state = 'idle';
      return;
    }
    this._wanderTime += dt;
    // Staff needed for a mission step head back to their post (a patrol walks home along its route)
    if (this.duty && this.hasRequest && this.currentTarget.duty && this.duty.leg !== 'post' && this.duty.leg !== 'home') {
      this._dutyHeadHome();
    }
    if (this._reactHold > 0) {
      this._reactHold -= dt;
      this.body.velocity.set(0, this.body.velocity.y, 0);
      this.character.setLocomotion(0);
      return;
    }

    // Route around walls toward the target (planned once per target; each node reached resets
    // the stuck timer). Steering aims at the next node, arrival is judged on the real target.
    if (this._routeFor !== this.currentTarget) this._planWanderRoute();
    const route = this._route;
    while (route && route.length > 1) {
      const ex = route[0].x - this.body.position.x, ez = route[0].z - this.body.position.z;
      if (ex * ex + ez * ez > 0.36) break;
      route.shift();
      this._wanderTime = 0;
    }
    const aim = route && route.length > 1 ? route[0] : this.currentTarget;
    const dx = aim.x - this.body.position.x;
    const dz = aim.z - this.body.position.z;
    const gx = this.currentTarget.x - this.body.position.x, gz = this.currentTarget.z - this.body.position.z;
    const dist = Math.sqrt(gx * gx + gz * gz);
    const seat = this._seatTarget;
    const precise = !!this.currentTarget.precise;

    if ((seat && dist < 0.22) || (!seat && dist < (precise ? 0.3 : 1.5))) {
      this.body.velocity.set(0, this.body.velocity.y, 0);
      this.wanderTimer = Math.random() * 8 + 4;
      if (seat) this._sitDown(seat);
      else {
        this.state = 'idle';
        if (this.duty && this.currentTarget.duty) this._dutyArrive();
      }
      return;
    }
    // Stuck (hedge, cart, player): give up after a while
    if (this._wanderTime > 30) {
      const wasDuty = this.duty && this.currentTarget.duty && !seat;
      this._cancelSeatTarget();
      this.state = 'idle';
      this.body.velocity.set(0, this.body.velocity.y, 0);
      if (wasDuty) this._dutyArrive(true);
      return;
    }

    let speed = (this.currentTarget.speed || SIZES.npcSpeed);
    if (seat || precise) speed = Math.min(speed, 0.35 + dist * 1.4); // settle precisely (seat / post)
    this._walkStep(dx, dz, Math.max(0.01, Math.sqrt(dx * dx + dz * dz)), speed, dt);

    // Face movement direction (smoothly)
    this._turnToward(Math.atan2(dx, dz), dt, 8);

    this.animTime += dt * 6;
    this._moving = 1;
    const cps = (speed / this.modelScale) / WALK_STRIDE;
    this.character.setLocomotion(speed > 0.05 ? 1 : 0, cps, 0);
  }

  _planWanderRoute() {
    this._routeFor = this.currentTarget;
    const t = this.currentTarget;
    try {
      // Through building doors / around the club buildings (world/NavRooms.js); straight otherwise
      this._route = planRoute(this.body.position.x, this.body.position.z, t.x, t.z, this._route || []);
    } catch (e) {
      this._route = null;
    }
  }

  _cancelSeatTarget() {
    if (this._seatTarget && this._seatTarget !== this._sitSeat) releaseSeat(this._seatTarget, this);
    this._seatTarget = null;
  }

  _sitDown(seat) {
    this._seatTarget = null;
    if (this._sitSeat && this._sitSeat !== seat) releaseSeat(this._sitSeat, this);
    this._sitSeat = seat;
    this.state = 'sitting';
    this._sitTimer = this._dutySitTime > 0 ? this._dutySitTime : 12 + Math.random() * 22;
    this._dutySitTime = 0;
    this.character.setLocomotion(0);
    this.character.play('sit', { fade: 0.5 });
  }

  _updateSitting(dt) {
    this.body.velocity.set(0, this.body.velocity.y, 0);
    if (this._sitSeat) this._turnToward(this._sitSeat.yaw, dt, 7);
    if (!this._holdSeat) this._sitTimer -= dt;
    if (this._sitTimer <= 0) this._standUp();
  }

  /** Get up from the bench (the mesh eases back to the body over ~0.45 s). */
  _standUp() {
    if (this.state !== 'sitting') return;
    this.state = 'idle';
    this.wanderTimer = Math.random() * 4 + 2;
    this.character.stop(0.45);
  }

  // ── Tennis ('playing') state — match logic lives elsewhere; these are the body controls ──

  /**
   * Enter the 'playing' state: racket out, 'ready' stance, no wandering. Other states
   * (talking to the player, reactions) still work and return here afterwards.
   * @param {string} courtId
   * @param {string} [side] e.g. 'north' | 'south' (stored for the match logic)
   */
  startPlaying(courtId, side = null) {
    if (this.state === 'sitting') this._standUp();
    this._cancelSeatTarget();
    this._holdSeat = false;
    if (!this.playing) this._racketWasVisible = this.character.racketVisible;
    this.playing = { courtId, side };
    this.state = 'playing';
    this._playMove = null;
    this._playClip = null;
    this.currentTarget = null;
    this.character.setRacketVisible(true);
    this.character.anim.autoIdleVariants = false;
    this.character.setLocomotion(0);
    this._setPlayClip('ready');
  }

  /** Leave the 'playing' state and go back to idling / wandering. */
  stopPlaying() {
    if (!this.playing && this.state !== 'playing') return;
    this.playing = null;
    this._playMove = null;
    this._playClip = null;
    this._faceYaw = null;
    this._resumePlaying = false;
    this._holdSeat = false;
    this.character.setRacketVisible(this._racketWasVisible ?? !!this.style.racket);
    this.character.setBallVisible(false);
    this.character.anim.autoIdleVariants = true;
    this.body.velocity.set(0, this.body.velocity.y, 0);
    if (this.state === 'playing') {
      this.character.stop(0.3);
      this.state = 'idle';
      this.wanderTimer = Math.random() * 4 + 2;
    }
  }

  /**
   * While playing: move the body to (x, z). Sideways moves relative to `face` use the shuffle
   * clips, longer / faster ones run; on arrival the NPC settles back into 'ready'.
   * @param {number} x
   * @param {number} z
   * @param {{speed?:number, face?:number|null, onArrive?:Function, gait?:'walk', settle?:boolean}} [opts]
   *   speed in m/s; face = yaw to keep facing (e.g. toward the net), default: the travel direction;
   *   gait 'walk' = plain walk/run locomotion (no shuffles, e.g. walking onto the court);
   *   settle false = stay in the locomotion pose on arrival instead of the 'ready' stance
   */
  moveTo(x, z, opts = {}) {
    let mv = this._playMove;
    if (!mv) mv = this._playMove = this._moveObj || (this._moveObj = {});
    mv.x = x; mv.z = z; mv.speed = opts.speed ?? 3; mv.face = opts.face ?? null;
    mv.onArrive = opts.onArrive || null; mv.gait = opts.gait || null;
    this._settle = opts.settle ?? true;
  }

  /** True while a moveTo is in progress. */
  get moving() { return !!this._playMove; }

  /** Stop a moveTo in progress (no onArrive). */
  stopMove() {
    this._playMove = null;
    this.body.velocity.set(0, this.body.velocity.y, 0);
  }

  /** True while a non-interruptible one-shot (swing, serve, pick-up) is playing. */
  isBusyClip() {
    const os = this.character.anim.oneShot;
    return !!os && !INTERRUPTIBLE.has(os.entry.name);
  }

  /**
   * Rain delay: walk to `seat` (a Seats.js seat; claimed here) or to `point` {x, z} and stay
   * there (sitting or standing) until releaseShelter() / startPlaying(). Keeps `playing` info.
   */
  shelter(seat, point) {
    this._holdSeat = true;
    this._playMove = null;
    this.character.setBallVisible(false);
    this.character.anim.autoIdleVariants = true;
    if (this.state === 'sitting' && (!seat || this._sitSeat === seat)) return;
    if (this.state === 'sitting') this._standUp();
    this._cancelSeatTarget();
    this._playClip = null;
    this.character.stop(0.3);
    if (seat && claimSeat(seat, this)) {
      this._seatTarget = seat;
      this.currentTarget = { x: seat.x + Math.sin(seat.yaw) * 0.5, z: seat.z + Math.cos(seat.yaw) * 0.5 };
    } else if (point) {
      this.currentTarget = { x: point.x, z: point.z };
    } else {
      this.currentTarget = null;
    }
    this.state = this.currentTarget ? 'wandering' : 'idle';
    this._wanderTime = 0;
    this._reactHold = 0;
  }

  /** End a rain-delay shelter (the NPC gets up after a while and wanders on). */
  releaseShelter() {
    this._holdSeat = false;
    if (this.state === 'sitting') this._sitTimer = Math.min(this._sitTimer, 2 + Math.random() * 4);
  }

  /** Short speech bubble above the head (score calls, chatter). */
  say(text, seconds = 1.8) {
    if (!this.bubble) {
      const canvas = document.createElement('canvas');
      canvas.width = BUBBLE_W; canvas.height = BUBBLE_H;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      sp.center.set(0.5, 0);
      sp.renderOrder = 12;
      sp.visible = false;
      this.mesh.add(sp);
      this.bubble = sp;
      this._bubbleCanvas = canvas;
    }
    const ctx = this._bubbleCanvas.getContext('2d');
    const W = BUBBLE_W, H = BUBBLE_H;
    ctx.clearRect(0, 0, W, H);
    let size = 40;
    const font = (px) => `700 ${px}px Inter, "Segoe UI", Helvetica, Arial, sans-serif`;
    ctx.font = font(size);
    let tw = ctx.measureText(text).width;
    while (tw > W - 44 && size > 18) { size -= 2; ctx.font = font(size); tw = ctx.measureText(text).width; }
    const bw = Math.min(W - 8, tw + 40), bh = 64, x0 = (W - bw) / 2, y0 = 6;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.roundRect(x0 + 2, y0 + 4, bw, bh, 22); ctx.fill();
    ctx.fillStyle = '#FFFDF6';
    ctx.strokeStyle = '#2D5A3D';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.roundRect(x0, y0, bw, bh, 22); ctx.fill(); ctx.stroke();
    // tail
    ctx.beginPath();
    ctx.moveTo(W / 2 - 12, y0 + bh - 2); ctx.lineTo(W / 2, y0 + bh + 26); ctx.lineTo(W / 2 + 12, y0 + bh - 2);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(W / 2 - 12, y0 + bh); ctx.lineTo(W / 2, y0 + bh + 26); ctx.lineTo(W / 2 + 12, y0 + bh);
    ctx.stroke();
    ctx.fillStyle = '#FFFDF6';
    ctx.fillRect(W / 2 - 10, y0 + bh - 4, 20, 5);
    ctx.fillStyle = '#21452F';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, y0 + bh / 2 + 2);
    this.bubble.material.map.needsUpdate = true;
    this.bubble.position.y = this._headTop() + 0.42;
    this.bubble.visible = true;
    this.bubble.material.opacity = 1;
    this._bubbleTimer = seconds;
    this._bubbleAge = 0;
  }

  /** Yaw (radians, 0 = +Z) the NPC turns to while playing / idle-playing. immediate = snap. */
  setFacing(yaw, immediate = false) {
    this._faceYaw = yaw;
    if (immediate) this.mesh.rotation.y = yaw;
  }

  /** Convenience: play a tennis clip ('forehand' | 'backhand' | 'serve' | 'split_step' | 'pickup_ball'). */
  swing(clip, opts) {
    // Drop animation time banked by a throttled mixer (updateEvery > 1) so the clip starts on
    // this frame's clock — racket contact then lands exactly `contact` seconds from now.
    const c = this.character;
    c._accDt = 0;
    c._frame = Math.max(0, (c.updateEvery | 0) - 1);
    return c.play(clip, opts);
  }

  _setPlayClip(name, timeScale = 1) {
    if (name === 'run') {
      if (this._playClip !== 'run') this.character.stop(0.2);
    } else if (this._playClip !== name) {
      this.character.play(name, { fade: 0.2, timeScale });
    } else if (timeScale !== 1) {
      const e = this.character.anim._entries.get(name);
      if (e) e.action.timeScale = timeScale;
    }
    this._playClip = name;
  }

  _updatePlaying(dt) {
    this.animTime += dt * 3;
    const mv = this._playMove;
    // Swings / serves / pick-ups always finish: clip changes wait until they are done
    const busy = this.isBusyClip();
    if (mv) {
      const dx = mv.x - this.body.position.x;
      const dz = mv.z - this.body.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.08) {
        this.body.velocity.set(0, this.body.velocity.y, 0);
        this._playMove = null;
        this.character.setLocomotion(0);
        if (this._settle && !busy) this._setPlayClip('ready');
        const cb = mv.onArrive;
        mv.onArrive = null;
        if (cb) { try { cb(); } catch (e) { console.error(e); } }
      } else {
        const v = Math.min(mv.speed, 0.4 + dist * 5);
        this._walkStep(dx, dz, dist, v, dt);
        const yaw = mv.face ?? Math.atan2(dx, dz);
        this._turnToward(yaw, dt, 10);
        // Direction of travel in the character's frame (+x = its left)
        const r = this.mesh.rotation.y, c = Math.cos(r), s = Math.sin(r);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        const modelSpeed = v / this.modelScale;
        if (busy) {
          // keep the one-shot; the body glides (short corrections only)
        } else if (mv.gait !== 'walk' && Math.abs(lx) > Math.abs(lz) * 1.2 && v < 4.5) {
          this._setPlayClip(lx > 0 ? 'shuffle_left' : 'shuffle_right', Math.min(2.4, Math.max(0.6, modelSpeed / 0.6)));
        } else {
          this._setPlayClip('run');
          const run = THREE.MathUtils.smoothstep(v, 1.8, 3.2);
          this.character.setLocomotion(1, Math.min(2.6, modelSpeed / (WALK_STRIDE + (RUN_STRIDE - WALK_STRIDE) * run)), run);
        }
        this._moving = 1;
      }
    } else {
      this.body.velocity.set(0, this.body.velocity.y, 0);
      if (!busy && this._settle && this._playClip !== 'ready') this._setPlayClip('ready');
      else if (!this._settle) this.character.setLocomotion(0);
    }
    if (this._faceYaw !== null && !mv) this._turnToward(this._faceYaw, dt, 8);
  }

  /**
   * Move the body toward a target by `speed` m/s. The body is translated directly (velocity
   * zeroed): cannon-es clamps contact friction per step as an impulse of mu*m*g, which stops a
   * velocity-driven sphere almost dead every step (walkers crept at ~1/10 of their speed with
   * their feet cycling in place). Collisions still push the body out of walls and people.
   */
  _walkStep(dx, dz, dist, speed, dt) {
    const step = Math.min(dist, speed * dt);
    this.body.position.x += (dx / dist) * step;
    this.body.position.z += (dz / dist) * step;
    this.body.velocity.x = 0;
    this.body.velocity.z = 0;
    this.moveSpeed = speed;
  }

  _turnToward(target, dt, rate) {
    let d = target - this.mesh.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.mesh.rotation.y += d * Math.min(1, dt * rate);
  }

  _faceTarget(targetPos, dt = 0.016) {
    if (!targetPos) return;
    const dx = targetPos.x - this.mesh.position.x;
    const dz = targetPos.z - this.mesh.position.z;
    this._turnToward(Math.atan2(dx, dz), dt, 10);
    this.body.velocity.set(0, this.body.velocity.y, 0);
  }

  startTalking() {
    if (this.state === 'talking') return;
    this._resumePlaying = this.state === 'playing';
    if (this.state === 'sitting') this._standUp();
    if (this.state === 'wandering') this._cancelSeatTarget();
    this.state = 'talking';
    this.body.velocity.set(0, this.body.velocity.y, 0);
    this.character.setLocomotion(0);
    this.character.play('talk', { fade: 0.35 });
  }

  stopTalking() {
    this.character.lookAt(null);
    if (this._resumePlaying && this.playing) {
      this._resumePlaying = false;
      this.state = 'playing';
      this._playClip = null;
      this._setPlayClip('ready');
      return;
    }
    this.state = 'idle';
    this.wanderTimer = Math.random() * 5 + 3;
    if (this.duty) {
      // Back to work after a beat; a chat at the post doesn't send them off on a round
      this.wanderTimer = 1.5 + Math.random() * 2;
      if (this.duty.leg === 'post') this.duty.holdOnce = true;
    }
    this.character.stop(0.4);
  }

  distanceTo(point) {
    return this.mesh.position.distanceTo(point);
  }
}
