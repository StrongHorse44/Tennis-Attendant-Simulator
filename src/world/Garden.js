import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS } from '../utils/Constants.js';
import { createMaterial } from '../utils/Materials.js';
import { getSurfaceTextures } from '../utils/TextureFactory.js';

// Garden trees favor the smaller/leafier models over the tall perimeter
// tree-big. Base uniform scale (measured via Box3 during development —
// tree-small raw height ~0.700, low-poly-tree ~2.296) brings them to a
// height comparable to the old primitive garden trees (~4.2 units).
const GARDEN_TREE_MODELS = ['tree-small', 'low-poly-tree'];
const GARDEN_TREE_BASE_SCALE = {
  'tree-small': 5.4,
  'low-poly-tree': 1.96,
};

const ROCK_MODELS = ['formation-stone', 'formation-rock', 'formation-large-stone'];
// Offsets from the garden center, tucked between hedges/flower beds and
// clear of the paths that cross the garden.
const ROCK_OFFSETS = [
  { x: -8.2, z: 0 },
  { x: 8.2, z: -3.5 },
  { x: -4, z: -6.8 },
  { x: 4, z: -6.8 },
  { x: -5.8, z: 5.3 },
  { x: 5.8, z: 5.3 },
];

/**
 * Garden - landscaping area with hedges, flower beds, and fountain
 */
export class Garden {
  constructor(scene, physicsWorld, config, assets) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.assets = assets;
    this.mesh = new THREE.Group();
    this.fountainParticles = [];

    this._build(config);
    this.scene.add(this.mesh);
  }

  _build(config) {
    const { center } = config;

    // Ground cover (slightly different green)
    const groundTex = getSurfaceTextures('grass', config.bounds.width / 4, config.bounds.depth / 4);
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(config.bounds.width, 0.05, config.bounds.depth),
      createMaterial('matte', {
        color: 0x5AA83A,
        map: groundTex.map,
        normalMap: groundTex.normalMap,
        normalScale: new THREE.Vector2(0.6, 0.6),
      })
    );
    ground.position.set(center.x, 0.03, center.z);
    ground.receiveShadow = true;
    this.mesh.add(ground);

    // Hedges
    if (config.hedges) {
      for (const hedge of config.hedges) {
        this._addHedge(hedge);
      }
    }

    // Flower beds
    if (config.flowerBeds) {
      for (const bed of config.flowerBeds) {
        this._addFlowerBed(bed);
      }
    }

    // Fountain
    if (config.fountain) {
      this._addFountain(config.fountain);
    }

    // Decorative trees
    this._addTree(center.x - 7, center.z - 2);
    this._addTree(center.x + 5, center.z - 15);
    this._addTree(center.x - 6, center.z - 16);

    // Scattered rock formations among the beds
    this._addRocks(center);
  }

  _addHedge(config) {
    const hedge = new THREE.Mesh(
      new THREE.BoxGeometry(config.width, 1.5, config.depth),
      createMaterial('matte', { color: COLORS.hedge })
    );
    hedge.position.set(config.x, 0.75, config.z);
    hedge.castShadow = true;
    hedge.receiveShadow = true;
    this.mesh.add(hedge);

    // Physics
    const shape = new CANNON.Box(new CANNON.Vec3(config.width / 2, 0.75, config.depth / 2));
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(config.x, 0.75, config.z), shape });
    this.physicsWorld.addBody(body);
  }

  _addFlowerBed(config) {
    // Soil bed
    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(config.width, 0.15, config.depth),
      createMaterial('matte', { color: 0x5C4033 })
    );
    bed.position.set(config.x, 0.08, config.z);
    bed.receiveShadow = true;
    this.mesh.add(bed);

    // Flowers
    const flowerColor = COLORS.flowers[config.color % COLORS.flowers.length];
    const flowerCount = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < flowerCount; i++) {
      const fx = config.x + (Math.random() - 0.5) * (config.width - 0.4);
      const fz = config.z + (Math.random() - 0.5) * (config.depth - 0.4);

      // Stem
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, 0.02, 0.3 + Math.random() * 0.2),
        createMaterial('matte', { color: 0x228B22 })
      );
      stem.position.set(fx, 0.3, fz);
      this.mesh.add(stem);

      // Flower head
      const flower = new THREE.Mesh(
        new THREE.SphereGeometry(0.08 + Math.random() * 0.05, 6, 6),
        createMaterial('matte', { color: flowerColor })
      );
      flower.position.set(fx, 0.45 + Math.random() * 0.1, fz);
      this.mesh.add(flower);
    }

    // Border stones
    const stoneMat = createMaterial('rough', { color: 0x999999 });
    const stoneSize = 0.15;
    for (let x = -config.width / 2; x <= config.width / 2; x += stoneSize * 1.5) {
      for (const z of [-config.depth / 2, config.depth / 2]) {
        const stone = new THREE.Mesh(
          new THREE.BoxGeometry(stoneSize, stoneSize, stoneSize),
          stoneMat
        );
        stone.position.set(config.x + x, stoneSize / 2, config.z + z);
        this.mesh.add(stone);
      }
    }
  }

  _addFountain(pos) {
    // Base pool
    const pool = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 2.0, 0.4, 16),
      createMaterial('rough', { color: COLORS.fountain })
    );
    pool.position.set(pos.x, 0.2, pos.z);
    pool.castShadow = true;
    this.mesh.add(pool);

    // Water in pool
    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 0.05, 16),
      createMaterial('glass', {
        color: COLORS.fountainWater,
        transparent: true,
        opacity: 0.7,
      })
    );
    water.position.set(pos.x, 0.38, pos.z);
    this.mesh.add(water);

    // Center column
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.3, 1.2, 8),
      createMaterial('rough', { color: COLORS.fountain })
    );
    column.position.set(pos.x, 1.0, pos.z);
    column.castShadow = true;
    this.mesh.add(column);

    // Top bowl
    const bowl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.3, 0.3, 12),
      createMaterial('rough', { color: COLORS.fountain })
    );
    bowl.position.set(pos.x, 1.65, pos.z);
    this.mesh.add(bowl);

    // Water particles (simple spheres that we'll animate)
    for (let i = 0; i < 8; i++) {
      const particle = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 4, 4),
        createMaterial('glass', {
          color: COLORS.fountainWater,
          transparent: true,
          opacity: 0.6,
        })
      );
      particle.position.set(pos.x, 1.8, pos.z);
      this.mesh.add(particle);
      this.fountainParticles.push({
        mesh: particle,
        angle: (i / 8) * Math.PI * 2,
        speed: 0.5 + Math.random() * 0.3,
        offset: Math.random() * Math.PI * 2,
        baseX: pos.x,
        baseZ: pos.z,
      });
    }

    // Physics blocker
    const shape = new CANNON.Cylinder(2.0, 2.0, 0.5, 8);
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(pos.x, 0.25, pos.z), shape });
    this.physicsWorld.addBody(body);
  }

  _addTree(x, z) {
    const name = GARDEN_TREE_MODELS[Math.floor(Math.random() * GARDEN_TREE_MODELS.length)];
    const raw = this.assets.getModelInstance(name);
    const tree = this._groundAndCenter(raw);
    const scale = GARDEN_TREE_BASE_SCALE[name] * (0.85 + Math.random() * 0.45);
    tree.scale.setScalar(scale);
    tree.rotation.y = Math.random() * Math.PI * 2;
    tree.position.set(x, 0, z);
    this.mesh.add(tree);

    // Physics trunk (unchanged)
    const shape = new CANNON.Cylinder(0.3, 0.3, 2, 6);
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, 1, z), shape });
    this.physicsWorld.addBody(body);
  }

  _addRocks(center) {
    const count = 4 + Math.floor(Math.random() * 3); // 4-6
    const offsets = [...ROCK_OFFSETS].sort(() => Math.random() - 0.5).slice(0, count);
    for (const offset of offsets) {
      const name = ROCK_MODELS[Math.floor(Math.random() * ROCK_MODELS.length)];
      const raw = this.assets.getModelInstance(name);
      const rock = this._groundAndCenter(raw);
      const scale = 0.5 + Math.random() * 0.5;
      rock.scale.setScalar(scale);
      rock.rotation.y = Math.random() * Math.PI * 2;
      rock.position.set(center.x + offset.x, 0, center.z + offset.z);
      this.mesh.add(rock);
    }
  }

  /**
   * Wraps a vendored model instance in a Group that recenters it on X/Z and
   * grounds its lowest point to y=0 (the rock formation models keep their
   * original scene-relative transform baked in and need this to be usable).
   */
  _groundAndCenter(instance) {
    const box = new THREE.Box3().setFromObject(instance);
    const center = new THREE.Vector3();
    box.getCenter(center);
    instance.position.set(-center.x, -box.min.y, -center.z);
    const wrapper = new THREE.Group();
    wrapper.add(instance);
    return wrapper;
  }

  update(dt) {
    // Animate fountain particles
    const t = Date.now() * 0.001;
    for (const p of this.fountainParticles) {
      const angle = p.angle + t * p.speed;
      const radius = 0.4 + Math.sin(t * 2 + p.offset) * 0.2;
      const height = 1.8 + Math.sin(t * 3 + p.offset) * 0.3;
      p.mesh.position.set(
        p.baseX + Math.cos(angle) * radius,
        height,
        p.baseZ + Math.sin(angle) * radius
      );
    }
  }
}
