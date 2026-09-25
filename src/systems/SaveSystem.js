/**
 * SaveSystem — versioned localStorage persistence for Court Call.
 *
 *   Save slot   : 'courtcall.save.v1'         (JSON, see SAVE_VERSION / sanitizeSave)
 *   Backup slot : 'courtcall.save.v1.backup'  (corrupt / unreadable data is moved here, never crashes)
 *   Settings    : 'courtcall.settings'        (SettingsStore — volume, mute, camera sensitivity)
 *   (Graphics quality is persisted by graphics/Quality.js under 'courtcall.quality'.)
 *
 * Storage access is always wrapped in try/catch (private mode, quota, disabled storage).
 *
 * The capture/apply helpers know the Game's shape (weather, player, cart, missions, inventory,
 * court maintenance, stats, flags) so main.js only has to call:
 *   const data = saveSystem.load();          // validated + migrated, or null
 *   applySaveData(game, data);
 *   saveSystem.save(captureSaveData(game));
 */

export const SAVE_KEY = 'courtcall.save.v1';
export const SAVE_BACKUP_KEY = 'courtcall.save.v1.backup';
export const SETTINGS_KEY = 'courtcall.settings';
export const SAVE_VERSION = 1;

const WEATHERS = ['sunny', 'cloudy', 'rainy', 'windy'];
const GROOM_RATINGS = ['needsWork', 'good', 'excellent'];
const MAX_COORD = 1000;

// ───────────────────────────── storage helpers ─────────────────────────────

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch (e) {
    return null; // SecurityError when storage is blocked
  }
}

export function storageGet(key) {
  try {
    const s = storage();
    return s ? s.getItem(key) : null;
  } catch (e) {
    return null;
  }
}

export function storageSet(key, value) {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch (e) {
    return false; // quota exceeded / blocked
  }
}

export function storageRemove(key) {
  try {
    const s = storage();
    if (s) s.removeItem(key);
  } catch (e) { /* ignore */ }
}

// ───────────────────────────── sanitizers ─────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, def, min = -Infinity, max = Infinity) =>
  (typeof v === 'number' && Number.isFinite(v)) ? Math.min(max, Math.max(min, v)) : def;
const int = (v, def, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  (Number.isInteger(v)) ? Math.min(max, Math.max(min, v)) : def;
const bool = (v, def = false) => (typeof v === 'boolean' ? v : def);
const str = (v, def = null) => (typeof v === 'string' && v.length > 0 && v.length < 200 ? v : def);
const strArr = (v, max = 500) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length < 200).slice(0, max) : []);

function sanitizePos(p) {
  if (!isObj(p)) return null;
  const x = num(p.x, NaN), y = num(p.y, NaN), z = num(p.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD) return null;
  return {
    x,
    y: Number.isFinite(y) ? Math.min(20, Math.max(-1, y)) : 1,
    z,
    // Wrap (not clamp): rotation.y is unbounded after walking in circles
    yaw: Number.isFinite(p.yaw) ? Math.atan2(Math.sin(p.yaw), Math.cos(p.yaw)) : 0,
  };
}

export function createDefaultStats() {
  return {
    missionsCompleted: 0,
    courtsGroomed: 0,        // clay courts groomed (a full session counts each court)
    groomSessions: 0,
    bestGroomRating: null,   // 'needsWork' | 'good' | 'excellent'
    bestGroomCleanliness: 0, // 0..1
    tips: 0,                 // lifetime tips ($); the wallet itself lives in the shift state
    satisfaction: { satisfied: 0, neutral: 0, unsatisfied: 0 },
    playTime: 0,             // seconds of unpaused play
  };
}

export function createDefaultFlags() {
  return { tutorialSeen: false, groomTutorialSeen: false };
}

function sanitizeStats(s) {
  const d = createDefaultStats();
  if (!isObj(s)) return d;
  const sat = isObj(s.satisfaction) ? s.satisfaction : {};
  return {
    missionsCompleted: int(s.missionsCompleted, 0),
    courtsGroomed: int(s.courtsGroomed, 0),
    groomSessions: int(s.groomSessions, 0),
    bestGroomRating: GROOM_RATINGS.includes(s.bestGroomRating) ? s.bestGroomRating : null,
    bestGroomCleanliness: num(s.bestGroomCleanliness, 0, 0, 1),
    tips: num(s.tips, 0, 0, 1e9),
    satisfaction: {
      satisfied: int(sat.satisfied, 0),
      neutral: int(sat.neutral, 0),
      unsatisfied: int(sat.unsatisfied, 0),
    },
    playTime: num(s.playTime, 0, 0, 1e10),
  };
}

const SHIFT_PHASES = ['preShift', 'onShift', 'ending', 'report'];

/**
 * Shift loop state (ShiftSystem.getState). Additive in v1: a save without it returns null
 * and ShiftSystem derives the phase from the clock.
 */
function sanitizeShift(v) {
  if (!isObj(v)) return null;
  const c = isObj(v.current) ? v.current : {};
  const money = (x) => num(x, 0, 0, 1e9);
  const count = (x) => int(x, 0, 0, 1e6);
  return {
    phase: SHIFT_PHASES.includes(v.phase) ? v.phase : 'onShift',
    wallet: money(v.wallet),
    lifetimeEarnings: money(v.lifetimeEarnings),
    lifetimeTips: money(v.lifetimeTips),
    rep: num(v.rep, 0, 0, 1e9),
    rankIndex: int(v.rankIndex, 0, 0, 50),
    shiftsWorked: count(v.shiftsWorked),
    current: {
      clockInHour: Number.isFinite(c.clockInHour) ? Math.min(24, Math.max(0, c.clockInHour)) : null,
      tasks: count(c.tasks),
      missionPay: money(c.missionPay),
      tips: money(c.tips),
      tipCount: count(c.tipCount),
      satisfied: count(c.satisfied),
      neutral: count(c.neutral),
      unsatisfied: count(c.unsatisfied),
      rep: num(c.rep, 0, 0, 1e9),
      groomBest: GROOM_RATINGS.includes(c.groomBest) ? c.groomBest : null,
      openingDone: bool(c.openingDone),
      closingDone: bool(c.closingDone),
      closingAnnounced: bool(c.closingAnnounced),
      startRank: int(c.startRank, 0, 0, 50),
      startPoints: num(c.startPoints, 0, 0, 1e10),
      lastGroomRating: GROOM_RATINGS.includes(c.lastGroomRating) ? c.lastGroomRating : null,
      wagePaid: bool(c.wagePaid),
      wage: money(c.wage),
      hours: num(c.hours, 0, 0, 24),
    },
  };
}

/**
 * Validate a parsed save object at the current version. Throws only on structural
 * corruption; individual bad fields are replaced with safe defaults.
 */
export function sanitizeSave(raw) {
  if (!isObj(raw)) throw new Error('save is not an object');
  if (raw.version !== SAVE_VERSION) throw new Error(`unexpected version ${raw.version}`);

  const time = isObj(raw.time) ? raw.time : {};
  const missions = isObj(raw.missions) ? raw.missions : {};
  const courts = {};
  if (isObj(raw.courts)) {
    for (const [id, c] of Object.entries(raw.courts)) {
      if (typeof id === 'string' && typeof c === 'number' && Number.isFinite(c)) courts[id] = Math.min(1, Math.max(0, c));
    }
  }
  const courtGrids = {};
  if (isObj(raw.courtGrids)) {
    for (const [id, g] of Object.entries(raw.courtGrids).slice(0, 16)) {
      if (id.length >= 64 || typeof g !== 'string') continue;
      // current: paint mask 'v2:<cols>x<rows>:<base64>' (Court.getMaskData); old: 8x14 hex grid
      if ((g.length <= 262144 && /^v2:\d{1,4}x\d{1,4}:[A-Za-z0-9+/]+=*$/.test(g)) ||
          (g.length <= 4096 && /^[0-9a-f]+$/.test(g))) courtGrids[id] = g;
    }
  }
  let groomSession = null;
  if (isObj(raw.groomSession)) {
    const gs = raw.groomSession;
    const hit = {};
    if (isObj(gs.hit)) {
      for (const [id, cells] of Object.entries(gs.hit).slice(0, 16)) {
        if (id.length >= 64) continue;
        // current: base64 bit mask (Court.getHitData); old: list of 8x14 cell indices
        if (typeof cells === 'string' && cells.length <= 65536 && /^[A-Za-z0-9+/]*=*$/.test(cells)) hit[id] = cells;
        else if (Array.isArray(cells)) hit[id] = cells.filter(c => Number.isInteger(c) && c >= 0 && c < 4096).slice(0, 4096);
      }
    }
    groomSession = {
      time: num(gs.time, 0, 0, 1e6),
      startCleanliness: num(gs.startCleanliness, NaN, 0, 1),
      tasksDone: strArr(gs.tasksDone, 64),
      hit,
    };
  }
  const flags = isObj(raw.flags) ? raw.flags : {};
  const cart = sanitizePos(raw.cart);
  if (cart) cart.hasBrush = bool(raw.cart.hasBrush);

  return {
    version: SAVE_VERSION,
    savedAt: num(raw.savedAt, 0),
    time: {
      timeOfDay: num(time.timeOfDay, NaN, 0, 24),
      day: int(time.day, 1, 1),
      weatherTimer: num(time.weatherTimer, NaN, 0, 1e6),
    },
    weather: WEATHERS.includes(raw.weather) ? raw.weather : null,
    player: sanitizePos(raw.player),
    cart,
    inCart: bool(raw.inCart),
    cameraYaw: num(raw.cameraYaw, NaN, -1e4, 1e4),
    missions: {
      active: Array.isArray(missions.active)
        ? missions.active
          .filter(a => isObj(a) && typeof a.id === 'string')
          .slice(0, 10)
          .map(a => ({ id: a.id, step: int(a.step, 0, 0, 999) }))
        : [],
      completed: strArr(missions.completed),
      taskBoard: strArr(missions.taskBoard, 10),
      radioTimer: num(missions.radioTimer, NaN, 0, 1e6),
      taskBoardTimer: num(missions.taskBoardTimer, NaN, 0, 1e6),
    },
    inventory: strArr(raw.inventory, 10),
    stats: sanitizeStats(raw.stats),
    courts,
    courtGrids,
    groomSession,
    courtDegradeTimer: num(raw.courtDegradeTimer, NaN, 0, 1e6),
    shift: sanitizeShift(raw.shift),
    flags: {
      tutorialSeen: bool(flags.tutorialSeen),
      groomTutorialSeen: bool(flags.groomTutorialSeen),
    },
  };
}

/**
 * Migrations: MIGRATIONS[n] upgrades a version-n object to version n+1.
 * Version 0 = hypothetical pre-versioned saves (no `version` field).
 */
const MIGRATIONS = {
  0: (d) => ({ ...d, version: 1 }),
};

export function migrateSave(raw) {
  if (!isObj(raw)) throw new Error('save is not an object');
  let data = raw;
  let v = data.version === undefined ? 0 : data.version;
  if (!Number.isInteger(v) || v < 0) throw new Error(`invalid version ${data.version}`);
  if (v > SAVE_VERSION) throw new Error(`save is from a newer version (${v})`);
  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from version ${v}`);
    data = step(data);
    v = data.version;
  }
  return data;
}

// ───────────────────────────── SaveSystem ─────────────────────────────

export class SaveSystem {
  constructor({ key = SAVE_KEY, backupKey = SAVE_BACKUP_KEY } = {}) {
    this.key = key;
    this.backupKey = backupKey;
    /** When true, save() is a no-op (used while resetting progress). */
    this.disabled = false;
    /** 'none' | 'ok' | 'migrated' | 'corrupt' — result of the last load(). */
    this.lastLoadStatus = 'none';
    this.lastError = null;
    this.lastSavedAt = 0;
  }

  hasSave() {
    return storageGet(this.key) !== null;
  }

  /** Returns validated save data, or null (no save / corrupt — corrupt data is backed up). */
  load() {
    this.lastError = null;
    const text = storageGet(this.key);
    if (text === null || text === '') {
      this.lastLoadStatus = 'none';
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      const wasVersion = isObj(parsed) ? parsed.version : undefined;
      const data = sanitizeSave(migrateSave(parsed));
      this.lastLoadStatus = wasVersion === SAVE_VERSION ? 'ok' : 'migrated';
      return data;
    } catch (err) {
      this.lastLoadStatus = 'corrupt';
      this.lastError = err;
      this._backup(text, err);
      console.warn(`[SaveSystem] Ignoring unreadable save (${err.message}); a copy was kept in "${this.backupKey}".`);
      return null;
    }
  }

  _backup(text, err) {
    const payload = JSON.stringify({ reason: String(err && err.message ? err.message : err), at: Date.now(), raw: text });
    if (!storageSet(this.backupKey, payload)) {
      // Too big for the remaining quota — keep at least the reason
      storageSet(this.backupKey, JSON.stringify({ reason: String(err && err.message), at: Date.now(), raw: null }));
    }
    storageRemove(this.key);
  }

  /** Persist a snapshot (from captureSaveData). Returns true on success. */
  save(data) {
    if (this.disabled || !data) return false;
    try {
      data.version = SAVE_VERSION;
      data.savedAt = Date.now();
      const ok = storageSet(this.key, JSON.stringify(data));
      if (ok) this.lastSavedAt = data.savedAt;
      return ok;
    } catch (e) {
      console.warn('[SaveSystem] save failed:', e);
      return false;
    }
  }

  /** Delete the save slot (Reset progress). */
  clear() {
    storageRemove(this.key);
  }
}

// ───────────────────────────── Game <-> save data ─────────────────────────────

function yawFromCannonQuat(q) {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

/** Build a plain JSON snapshot of the game's persistent state. */
export function captureSaveData(game) {
  const { weather, player, cart, missionSystem, inventory, courtMaintenance } = game;
  const w = weather.getState ? weather.getState() : { timeOfDay: weather.timeOfDay, day: 1, weather: weather.weather };
  const cm = courtMaintenance ? courtMaintenance.getState() : { courts: {}, tutorialCompleted: false };
  const pb = player.body.position;
  const cb = cart.body.position;
  const flags = { ...createDefaultFlags(), ...(game.flags || {}) };
  flags.groomTutorialSeen = !!(cm.tutorialCompleted || flags.groomTutorialSeen);

  return {
    version: SAVE_VERSION,
    savedAt: 0,
    time: { timeOfDay: w.timeOfDay, day: w.day || 1, weatherTimer: w.weatherTimer },
    weather: w.weather,
    player: {
      x: pb.x, y: pb.y, z: pb.z,
      yaw: player.mesh && !player.isInCart
        ? Math.atan2(Math.sin(player.mesh.rotation.y), Math.cos(player.mesh.rotation.y)) : 0,
    },
    cart: {
      x: cb.x, y: cb.y, z: cb.z,
      yaw: yawFromCannonQuat(cart.body.quaternion),
      hasBrush: !!cart.hasBrush,
    },
    inCart: !!player.isInCart,
    cameraYaw: game.cameraYaw || 0,
    missions: missionSystem.getState(),
    inventory: inventory.getState(),
    stats: sanitizeStats(game.stats),
    courts: cm.courts,
    courtGrids: cm.grids || {},
    groomSession: cm.session || null,
    courtDegradeTimer: cm.degradeTimer,
    shift: game.shift ? game.shift.getState() : null,
    flags,
  };
}

function placeBody(body, x, y, z, yaw) {
  body.position.set(x, y, z);
  if (body.previousPosition) body.previousPosition.set(x, y, z);
  if (body.interpolatedPosition) body.interpolatedPosition.set(x, y, z);
  body.velocity.set(0, 0, 0);
  body.angularVelocity.set(0, 0, 0);
  if (yaw !== undefined) {
    body.quaternion.setFromEuler(0, yaw, 0);
    if (body.previousQuaternion) body.previousQuaternion.copy(body.quaternion);
    if (body.interpolatedQuaternion) body.interpolatedQuaternion.copy(body.quaternion);
  }
  body.aabbNeedsUpdate = true;
  if (body.wakeUp) body.wakeUp();
}

/**
 * Apply validated save data to a freshly-built game. Each section is isolated so a
 * problem in one never prevents the rest from loading.
 */
export function applySaveData(game, data) {
  if (!data) return false;
  const { weather, player, cart, missionSystem, inventory, courtMaintenance } = game;
  const step = (label, fn) => {
    try { fn(); } catch (e) { console.warn(`[SaveSystem] could not restore ${label}:`, e); }
  };

  step('flags', () => { game.flags = { ...createDefaultFlags(), ...data.flags }; });
  step('stats', () => { game.stats = sanitizeStats(data.stats); });

  step('time/weather', () => {
    if (weather.setState) {
      weather.setState({
        timeOfDay: Number.isFinite(data.time.timeOfDay) ? data.time.timeOfDay : undefined,
        day: data.time.day,
        weatherTimer: Number.isFinite(data.time.weatherTimer) ? data.time.weatherTimer : undefined,
        weather: data.weather || undefined,
      });
    } else if (Number.isFinite(data.time.timeOfDay)) {
      weather.timeOfDay = data.time.timeOfDay;
    }
  });

  step('courts', () => {
    if (!courtMaintenance) return;
    courtMaintenance.setState({
      tutorialCompleted: !!data.flags.groomTutorialSeen,
      degradeTimer: Number.isFinite(data.courtDegradeTimer) ? data.courtDegradeTimer : undefined,
      courts: data.courts,
      grids: data.courtGrids,
    });
  });

  step('inventory', () => inventory.setState(data.inventory));
  step('missions', () => missionSystem.setState(data.missions));
  // After time/weather (the phase is checked against the clock) and missions (routines)
  step('shift', () => { if (game.shift) game.shift.setState(data.shift); });

  step('cart', () => {
    if (!data.cart) return;
    const c = data.cart;
    placeBody(cart.body, c.x, Math.max(c.y, 0.2), c.z, c.yaw);
    cart.currentSpeed = 0;
    if (typeof cart._syncMesh === 'function') cart._syncMesh();
    if (c.hasBrush && !cart.hasBrush) cart.attachBrush();
    if (!c.hasBrush && cart.hasBrush) cart.detachBrush();
  });

  step('player', () => {
    if (player.isInCart) player.exitCart();
    if (data.player) {
      const p = data.player;
      placeBody(player.body, p.x, Math.max(p.y, 0.3), p.z);
      if (player.mesh) {
        player.mesh.position.set(p.x, 0, p.z);
        player.mesh.rotation.y = p.yaw;
      }
      if (player.facing) player.facing.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    }
    if (data.inCart) {
      player.enterCart(cart);
      cart.occupied = true;
      game.wasInCart = true;
      if (game.sound) game.sound.startCartEngine(); // deferred until audio unlocks
    }
  });

  // A save taken mid-groom re-opens the session (panel, coverage, courtside tasks)
  step('groom session', () => {
    if (!courtMaintenance || !data.groomSession || !player.isInCart || !cart.hasBrush) return;
    courtMaintenance.resumeGrooming(data.groomSession);
  });

  step('camera', () => {
    if (Number.isFinite(data.cameraYaw)) {
      game.cameraYaw = data.cameraYaw;
      game.cameraTargetYaw = data.cameraYaw;
    }
  });

  return true;
}

// ───────────────────────────── Settings ─────────────────────────────

export const DEFAULT_SETTINGS = Object.freeze({
  volume: 0.8,              // 0..1
  muted: false,
  cameraSensitivity: 1,     // 0.25..2.5 multiplier
});

/** Small persisted settings store ('courtcall.settings'). */
export class SettingsStore {
  constructor(key = SETTINGS_KEY) {
    this.key = key;
    this.values = { ...DEFAULT_SETTINGS };
    this._listeners = [];
    this.load();
  }

  load() {
    const text = storageGet(this.key);
    if (!text) return this.values;
    try {
      const raw = JSON.parse(text);
      if (isObj(raw)) {
        this.values.volume = num(raw.volume, DEFAULT_SETTINGS.volume, 0, 1);
        this.values.muted = bool(raw.muted, DEFAULT_SETTINGS.muted);
        this.values.cameraSensitivity = num(raw.cameraSensitivity, DEFAULT_SETTINGS.cameraSensitivity, 0.25, 2.5);
      }
    } catch (e) {
      console.warn('[Settings] ignoring unreadable settings');
    }
    return this.values;
  }

  save() {
    storageSet(this.key, JSON.stringify(this.values));
  }

  get(k) {
    return this.values[k];
  }

  set(k, v) {
    if (!(k in DEFAULT_SETTINGS)) return;
    if (this.values[k] === v) return;
    this.values[k] = v;
    this.save();
    for (const fn of this._listeners) {
      try { fn(k, v, this.values); } catch (e) { console.error(e); }
    }
  }

  /** fn(key, value, allValues); returns an unsubscribe function. */
  onChange(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter(f => f !== fn); };
  }
}
