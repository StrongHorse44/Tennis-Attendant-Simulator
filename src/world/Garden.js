import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS } from '../utils/Constants.js';

/**
 * Garden - landscaping area with hedges, flower beds, and fountain
 */
export class Garden {
  constructor(scene, physicsWorld, config) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.mesh = new THREE.Group();
    this.fountainParticles = [];

    this._build(config);
    this.scene.add(this.mesh);
  }

  _build(config) {
    const { center } = config;

    // Ground cover (slightly different green)
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(config.bounds.width, 0.05, config.bounds.depth),
      new THREE.MeshLambertMaterial({ color: 0x5AA83A })
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
  }

  _addHedge(config) {
    const hedge = new THREE.Mesh(
      new THREE.BoxGeometry(config.width, 1.5, config.depth),
      new THREE.MeshLambertMaterial({ color: COLORS.hedge })
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
      new THREE.MeshLambertMaterial({ color: 0x5C4033 })
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
        new THREE.MeshLambertMaterial({ color: 0x228B22 })
      );
      stem.position.set(fx, 0.3, fz);
      this.mesh.add(stem);

      // Flower head
      const flower = new THREE.Mesh(
        new THREE.SphereGeometry(0.08 + Math.random() * 0.05, 6, 6),
        new THREE.MeshLambertMaterial({ color: flowerColor })
      );
      flower.position.set(fx, 0.45 + Math.random() * 0.1, fz);
      this.mesh.add(flower);
    }

    // Border stones
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x999999 });
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
      new THREE.MeshLambertMaterial({ color: COLORS.fountain })
    );
    pool.position.set(pos.x, 0.2, pos.z);
    pool.castShadow = true;
    this.mesh.add(pool);

    // Water in pool
    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 0.05, 16),
      new THREE.MeshLambertMaterial({
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
      new THREE.MeshLambertMaterial({ color: COLORS.fountain })
    );
    column.position.set(pos.x, 1.0, pos.z);
    column.castShadow = true;
    this.mesh.add(column);

    // Top bowl
    const bowl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.3, 0.3, 12),
      new THREE.MeshLambertMaterial({ color: COLORS.fountain })
    );
    bowl.position.set(pos.x, 1.65, pos.z);
    this.mesh.add(bowl);

    // Water particles (simple spheres that we'll animate)
    for (let i = 0; i < 8; i++) {
      const particle = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 4, 4),
        new THREE.MeshLambertMaterial({
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
    // Trunk
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.2, 2, 6),
      new THREE.MeshLambertMaterial({ color: 0x8B6914 })
    );
    trunk.position.set(x, 1, z);
    trunk.castShadow = true;
    this.mesh.add(trunk);

    // Canopy (layered cones for low-poly look)
    const canopyMat = new THREE.MeshLambertMaterial({ color: 0x2E8B57 });
    const c1 = new THREE.Mesh(new THREE.ConeGeometry(1.5, 1.5, 6), canopyMat);
    c1.position.set(x, 2.8, z);
    c1.castShadow = true;
    this.mesh.add(c1);

    const c2 = new THREE.Mesh(new THREE.ConeGeometry(1.2, 1.2, 6), canopyMat);
    c2.position.set(x, 3.6, z);
    c2.castShadow = true;
    this.mesh.add(c2);

    // Physics trunk
    const shape = new CANNON.Cylinder(0.3, 0.3, 2, 6);
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, 1, z), shape });
    this.physicsWorld.addBody(body);
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
