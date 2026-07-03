import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * AssetLoader - loads JSON data files and 3D model/texture assets
 */
export class AssetLoader {
  constructor() {
    this.cache = new Map();
    this.modelCache = new Map();
    this.gltfLoader = new GLTFLoader();
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
    const base = import.meta.env.BASE_URL;
    const [mapData, npcData, missionData] = await Promise.all([
      this.loadJSON(`${base}data/map.json`),
      this.loadJSON(`${base}data/npcs.json`),
      this.loadJSON(`${base}data/missions.json`),
    ]);
    return { mapData, npcData, missionData };
  }

  /**
   * Loads (and caches) a vendored glTF model by name from
   * public/assets/models/<name>.gltf.
   */
  async loadModel(name) {
    if (this.modelCache.has(name)) {
      return this.modelCache.get(name);
    }
    const base = import.meta.env.BASE_URL;
    const promise = this.gltfLoader.loadAsync(`${base}assets/models/${name}.gltf`);
    this.modelCache.set(name, promise);
    const gltf = await promise;
    this.modelCache.set(name, gltf);
    return gltf;
  }

  /** Preloads a list of models in parallel (for loading-screen checkpoints). */
  async preloadModels(names) {
    return Promise.all(names.map((name) => this.loadModel(name)));
  }

  /**
   * Returns a fresh instance of a previously-loaded model's scene graph.
   * Skinned characters must use SkeletonUtils.clone (plain Object3D.clone
   * breaks skinned meshes/bone bindings); static props/vehicles can use a
   * regular deep clone.
   */
  getModelInstance(name, { skinned = false } = {}) {
    const gltf = this.modelCache.get(name);
    if (!gltf || gltf instanceof Promise) {
      throw new Error(`AssetLoader.getModelInstance: model "${name}" is not loaded — call loadModel()/preloadModels() first.`);
    }
    const instance = skinned ? skeletonClone(gltf.scene) : gltf.scene.clone(true);
    instance.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
      }
    });
    return instance;
  }
}
