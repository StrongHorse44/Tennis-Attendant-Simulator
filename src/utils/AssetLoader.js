/**
 * Error thrown when a data file can't be loaded or parsed. `files` lists every failure
 * (so the loading screen can report them all at once).
 */
export class AssetLoadError extends Error {
  constructor(message, files = []) {
    super(message);
    this.name = 'AssetLoadError';
    this.files = files; // [{ path, reason }]
  }
}

/**
 * AssetLoader - loads JSON data files and future model/texture assets
 */
export class AssetLoader {
  constructor() {
    this.cache = new Map();
  }

  async loadJSON(path) {
    if (this.cache.has(path)) {
      return this.cache.get(path);
    }
    const file = path.split('/').pop();

    let response;
    try {
      response = await fetch(path, { cache: 'no-cache' });
    } catch (err) {
      throw new AssetLoadError(`Couldn't reach ${file} (network error)`, [{ path, reason: 'network error' }]);
    }
    if (!response.ok) {
      const reason = `HTTP ${response.status}${response.status === 404 ? ' — file not found' : ''}`;
      throw new AssetLoadError(`Couldn't load ${file} (${reason})`, [{ path, reason }]);
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      // Most dev servers answer unknown paths with index.html → say so explicitly
      const looksHtml = /^\s*</.test(text);
      const reason = looksHtml ? 'got HTML instead of JSON (missing file?)' : `malformed JSON: ${err.message}`;
      throw new AssetLoadError(`${file} is invalid (${reason})`, [{ path, reason }]);
    }
    if (data === null || typeof data !== 'object') {
      throw new AssetLoadError(`${file} is invalid (expected a JSON object)`, [{ path, reason: 'not an object' }]);
    }
    this.cache.set(path, data);
    return data;
  }

  async loadAllData() {
    const base = import.meta.env.BASE_URL;
    const names = ['map.json', 'npcs.json', 'missions.json'];
    const results = await Promise.allSettled(names.map(n => this.loadJSON(`${base}data/${n}`)));

    const failures = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        const err = r.reason;
        if (err instanceof AssetLoadError && err.files.length) failures.push(...err.files);
        else failures.push({ path: `${base}data/${names[i]}`, reason: err && err.message ? err.message : String(err) });
      }
    }
    if (failures.length) {
      const list = failures.map(f => `${f.path.split('/').pop()}: ${f.reason}`).join('; ');
      throw new AssetLoadError(`Couldn't load game data — ${list}`, failures);
    }

    const [mapData, npcData, missionData] = results.map(r => r.value);
    return { mapData, npcData, missionData };
  }
}
