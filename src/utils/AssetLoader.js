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
    const response = await fetch(path);
    const data = await response.json();
    this.cache.set(path, data);
    return data;
  }

  async loadAllData() {
    const [mapData, npcData, missionData] = await Promise.all([
      this.loadJSON('/data/map.json'),
      this.loadJSON('/data/npcs.json'),
      this.loadJSON('/data/missions.json'),
    ]);
    return { mapData, npcData, missionData };
  }
}
