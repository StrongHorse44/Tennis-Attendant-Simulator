import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES } from '../utils/Constants.js';
import { Court } from './Court.js';
import { Building } from './Building.js';
import { Garden } from './Garden.js';
import { createMaterial } from '../utils/Materials.js';
import { getSurfaceTextures } from '../utils/TextureFactory.js';

// Vendored car models (visual only — physics blockers are unchanged boxes)
const CAR_MODELS = ['sedan', 'suv', 'suv-luxury', 'hatchback', 'taxi', 'van'];

// Base uniform scale to bring each vendored tree model (native scale varies
// per asset) to a comparable height to the primitives it replaces (~4-6
// units), measured via THREE.Box3 during development:
//   tree-big raw height ~0.767, tree-small ~0.700, low-poly-tree ~2.296
const TREE_BASE_SCALE = {
  'tree-big': 7.15,
  'tree-small': 5.4,
  'low-poly-tree': 1.96,
};

// Bench/table models measured via Box3 (raw length ~2.37 / ~3.70) and scaled
// down to roughly match the footprint of the old primitive geometry.
const BENCH_SCALE = 0.7; // patio bench, seat ~2.0 long -> ~1.66
const TABLE_SCALE = 0.65; // patio table, ~3.7 long -> ~2.4 (incl. old chairs' span)

const ROCK_MODELS = ['formation-stone', 'formation-rock', 'formation-large-stone'];

// Density-pass scatter: extra trees + rock formations tucked in the buffer
// strip between the outermost courts/buildings/paths and the perimeter
// fence (fence sits at x/z = ±(mapWidth/2+5) / ±(mapDepth/2+5) = ±65/±55).
// Positions are hand-picked to sit clear of every area rect and path in
// map.json (courts max out around x -10..40 / z -45..15, garden/patio/shed/
// parking/entrance cluster around x -47..-11 / z -40..46) and interleaved
// with the existing perimeter tree loop (which sits right at the fence
// line) rather than on top of it.
const SCATTER_TREES = [
  { x: -54, z: -49 }, { x: -30, z: -49 }, { x: -6, z: -49 }, { x: 18, z: -49 }, { x: 42, z: -49 },
  { x: -42, z: 49 }, { x: -18, z: 49 }, { x: 6, z: 49 }, { x: 30, z: 49 }, { x: 54, z: 49 },
];
const SCATTER_ROCKS = [
  { x: -58, z: -49 }, { x: 58, z: -49 }, { x: -58, z: 49 }, { x: 58, z: 49 },
];

/**
 * World - loads map.json and builds the entire club environment
 */
export class World {
  constructor(scene, physicsWorld, mapData, assets) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.mapData = mapData;
    this.assets = assets;
    this.courts = [];
    this.buildings = [];
    this.garden = null;
    this.trees = [];

    this.courtJunctionObjects = []; // coolers + trash bins between courts

    this._buildGround();
    this._buildPaths();
    this._buildCourts();
    this._buildCourtJunctions();
    this._buildProShop();
    this._buildClubhouse();
    this._buildGarden();
    this._buildEquipmentShed();
    this._buildPatio();
    this._buildParking();
    this._buildPerimeter();
    this._buildDensityScatter();
  }

  _buildGround() {
    // Main ground plane
    const groundW = SIZES.mapWidth * 2;
    const groundD = SIZES.mapDepth * 2;
    const groundTex = getSurfaceTextures('grass', groundW / 4, groundD / 4);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundW, groundD),
      createMaterial('matte', {
        color: COLORS.ground,
        map: groundTex.map,
        normalMap: groundTex.normalMap,
        normalScale: new THREE.Vector2(0.6, 0.6),
      })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Physics ground
    const groundShape = new CANNON.Plane();
    const groundBody = new CANNON.Body({
      mass: 0,
      shape: groundShape,
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.physicsWorld.addBody(groundBody);
  }

  _buildPaths() {
    for (const path of this.mapData.paths) {
      const points = path.points;
      const width = path.width || 3;
      const jointTex = getSurfaceTextures('concrete', width / 4, width / 4);
      const jointMat = createMaterial('rough', {
        color: COLORS.path,
        map: jointTex.map,
        normalMap: jointTex.normalMap,
        normalScale: new THREE.Vector2(0.4, 0.4),
      });

      for (let i = 0; i < points.length - 1; i++) {
        const start = points[i];
        const end = points[i + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.sqrt(dx * dx + dz * dz);
        const angle = Math.atan2(dx, dz);

        const segTex = getSurfaceTextures('concrete', width / 4, length / 4);
        const segment = new THREE.Mesh(
          new THREE.BoxGeometry(width, 0.06, length + width * 0.3),
          createMaterial('rough', {
            color: COLORS.path,
            map: segTex.map,
            normalMap: segTex.normalMap,
            normalScale: new THREE.Vector2(0.4, 0.4),
          })
        );
        segment.position.set(
          start.x + dx / 2,
          0.03,
          start.z + dz / 2
        );
        segment.rotation.y = angle;
        segment.receiveShadow = true;
        this.scene.add(segment);
      }

      // Circular joints at path intersections
      for (const point of points) {
        const joint = new THREE.Mesh(
          new THREE.CylinderGeometry(width / 2, width / 2, 0.06, 8),
          jointMat
        );
        joint.position.set(point.x, 0.03, point.z);
        joint.receiveShadow = true;
        this.scene.add(joint);
      }
    }
  }

  /**
   * Wraps a vendored model instance in a Group that recenters it on X/Z and
   * grounds its lowest point to y=0 (some vendored models keep their
   * original scene-relative transform baked in, e.g. the rock formations).
   * Callers can then freely set position/rotation/scale on the returned
   * wrapper as if it were a primitive centered at its own origin.
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

  _buildCourts() {
    for (const courtConfig of this.mapData.areas.courts) {
      const court = new Court(this.scene, this.physicsWorld, courtConfig, this.assets);
      this.courts.push(court);
    }
  }

  _buildCourtJunctions() {
    const junctions = this.mapData.areas.courtJunctions;
    if (!junctions) return;

    for (const junction of junctions) {
      const pos = junction.position;
      const junctionData = { id: junction.id, position: pos, meshes: {} };

      if (junction.hasCooler) {
        junctionData.meshes.cooler = this._addIglooCooler(pos.x - 0.8, pos.z);
      }
      if (junction.hasTrashBin) {
        junctionData.meshes.trashBin = this._addTrashBin(pos.x + 0.8, pos.z);
      }

      this.courtJunctionObjects.push(junctionData);
    }
  }

  _addIglooCooler(x, z) {
    const group = new THREE.Group();

    // Cooler body (orange/red igloo style)
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.5, 0.5),
      createMaterial('plastic', { color: COLORS.iglooCooler })
    );
    body.position.y = 0.45;
    body.castShadow = true;
    group.add(body);

    // Cooler lid (white)
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.08, 0.52),
      createMaterial('plastic', { color: COLORS.iglooCoolerLid })
    );
    lid.position.y = 0.74;
    group.add(lid);

    // Stand/legs
    const legGeo = new THREE.BoxGeometry(0.06, 0.2, 0.06);
    const legMat = createMaterial('metal', { color: 0x666666 });
    for (const lx of [-0.25, 0.25]) {
      for (const lz of [-0.18, 0.18]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, 0.1, lz);
        group.add(leg);
      }
    }

    // Cup holder tray (attached to side)
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.04, 0.25),
      createMaterial('wood', { color: COLORS.cupHolder })
    );
    tray.position.set(0.5, 0.55, 0);
    group.add(tray);

    // Cup holder rings (2)
    for (const offset of [-0.08, 0.08]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.06, 0.015, 6, 8),
        createMaterial('metal', { color: 0x777777 })
      );
      ring.position.set(0.5, 0.58, offset);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    }

    // Spigot (front)
    const spigot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.1, 6),
      createMaterial('metal', { color: 0xCCCCCC })
    );
    spigot.position.set(0, 0.35, -0.3);
    spigot.rotation.x = Math.PI / 2;
    group.add(spigot);

    group.position.set(x, 0, z);
    this.scene.add(group);
    return group;
  }

  _addTrashBin(x, z) {
    const group = new THREE.Group();

    // Bin body (cylinder)
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.22, 0.7, 8),
      createMaterial('metal', { color: COLORS.trashBin })
    );
    body.position.y = 0.35;
    body.castShadow = true;
    group.add(body);

    // Lid (slightly wider)
    const lid = new THREE.Mesh(
      new THREE.CylinderGeometry(0.27, 0.27, 0.06, 8),
      createMaterial('metal', { color: COLORS.trashBinLid })
    );
    lid.position.y = 0.73;
    group.add(lid);

    // Handle on lid
    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(0.06, 0.015, 4, 8, Math.PI),
      createMaterial('metal', { color: 0x777777 })
    );
    handle.position.y = 0.78;
    handle.rotation.x = Math.PI;
    group.add(handle);

    group.position.set(x, 0, z);
    this.scene.add(group);
    return group;
  }

  _buildProShop() {
    const config = this.mapData.areas.proShop;
    const proShop = new Building(this.scene, this.physicsWorld, 'proShop', config);
    this.buildings.push(proShop);
  }

  _buildClubhouse() {
    const patioConfig = this.mapData.areas.patio;
    if (patioConfig && patioConfig.clubhouse) {
      const clubhouse = new Building(this.scene, this.physicsWorld, 'clubhouse', patioConfig.clubhouse);
      this.buildings.push(clubhouse);
    }
  }

  _buildGarden() {
    const gardenConfig = this.mapData.areas.garden;
    this.garden = new Garden(this.scene, this.physicsWorld, gardenConfig, this.assets);
  }

  _buildEquipmentShed() {
    const shed = this.mapData.areas.equipmentShed;
    if (!shed) return;

    const { center, bounds } = shed;
    const w = bounds.width;
    const d = bounds.depth;
    const h = 2.5;

    // Shed floor
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.08, d),
      createMaterial('rough', { color: 0x999999 })
    );
    floor.position.set(center.x, 0.04, center.z);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Walls (3 sides — open front facing +Z)
    const wallMat = createMaterial('wood', { color: 0x8B7355 });

    // Back wall
    const backWall = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 0.15),
      wallMat
    );
    backWall.position.set(center.x, h / 2, center.z - d / 2);
    backWall.castShadow = true;
    this.scene.add(backWall);

    // Side walls
    for (const side of [-1, 1]) {
      const sideWall = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, h, d),
        wallMat
      );
      sideWall.position.set(center.x + side * w / 2, h / 2, center.z);
      sideWall.castShadow = true;
      this.scene.add(sideWall);
    }

    // Roof
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.5, 0.12, d + 0.5),
      createMaterial('wood', { color: 0x6B4226 })
    );
    roof.position.set(center.x, h, center.z);
    roof.castShadow = true;
    this.scene.add(roof);

    // Shed label
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Equipment Shed', 128, 40);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(4, 1, 1);
    sprite.position.set(center.x, h + 1, center.z);
    this.scene.add(sprite);

    // Physics blockers for walls
    const backShape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, 0.1));
    const backBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(center.x, h / 2, center.z - d / 2),
      shape: backShape,
    });
    this.physicsWorld.addBody(backBody);

    for (const side of [-1, 1]) {
      const sideShape = new CANNON.Box(new CANNON.Vec3(0.1, h / 2, d / 2));
      const sideBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(center.x + side * w / 2, h / 2, center.z),
        shape: sideShape,
      });
      this.physicsWorld.addBody(sideBody);
    }

    // Visual brush prop inside the shed (standing against back wall)
    const brushProp = new THREE.Group();
    // Frame
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.06, 0.06),
      createMaterial('metal', { color: 0x888888 })
    );
    frame.position.set(0, 0.8, 0);
    brushProp.add(frame);
    // Bristles
    const bristles = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.12, 0.4),
      createMaterial('matte', { color: 0x8B7355 })
    );
    bristles.position.set(0, 0.3, 0);
    brushProp.add(bristles);
    // Handle
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6),
      createMaterial('metal', { color: 0x888888 })
    );
    handle.position.set(0, 1.4, 0);
    brushProp.add(handle);

    brushProp.position.set(center.x, 0, center.z - d / 2 + 0.5);
    this.scene.add(brushProp);
  }

  _buildPatio() {
    const patioConfig = this.mapData.areas.patio;
    if (!patioConfig || !patioConfig.seating) return;

    for (const seat of patioConfig.seating) {
      if (seat.type === 'table') {
        this._addPatioTable(seat.x, seat.z);
      } else if (seat.type === 'bench') {
        this._addPatioBench(seat.x, seat.z);
      }
    }

    // Patio floor
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(patioConfig.bounds.width, 0.08, patioConfig.bounds.depth),
      createMaterial('rough', { color: 0xC4A882 })
    );
    floor.position.set(patioConfig.center.x, 0.04, patioConfig.center.z);
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  _addPatioTable(x, z) {
    const raw = this.assets.getModelInstance('table');
    const table = this._groundAndCenter(raw);
    table.scale.setScalar(TABLE_SCALE);
    table.position.set(x, 0, z);
    this.scene.add(table);
  }

  _addPatioBench(x, z) {
    const raw = this.assets.getModelInstance('bench');
    const bench = this._groundAndCenter(raw);
    bench.scale.setScalar(BENCH_SCALE);
    bench.position.set(x, 0, z);
    this.scene.add(bench);
  }

  _buildParking() {
    const parking = this.mapData.areas.parking;
    if (!parking) return;

    // Parking surface
    const lotTex = getSurfaceTextures('concrete', parking.bounds.width / 4, parking.bounds.depth / 4);
    const lot = new THREE.Mesh(
      new THREE.BoxGeometry(parking.bounds.width, 0.06, parking.bounds.depth),
      createMaterial('rough', {
        color: 0x555555,
        map: lotTex.map,
        normalMap: lotTex.normalMap,
        normalScale: new THREE.Vector2(0.4, 0.4),
      })
    );
    lot.position.set(parking.center.x, 0.03, parking.center.z);
    lot.receiveShadow = true;
    this.scene.add(lot);

    // Parking lines (main row, plus one extra divider for the density-pass
    // spot added at the row's open end)
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
    for (let i = 0; i < 6; i++) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.01, 4),
        lineMat
      );
      line.position.set(parking.center.x - 10 + i * 4, 0.07, parking.center.z);
      this.scene.add(line);
    }

    // Perpendicular row markings along the back edge (density-pass cars
    // parked lengthwise against the lot boundary)
    for (let i = 0; i < 4; i++) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(4, 0.01, 0.1),
        lineMat
      );
      line.position.set(parking.center.x - 10.5, 0.07, parking.center.z - 6 + i * 4);
      this.scene.add(line);
    }

    // Parked cars
    if (parking.cars) {
      for (const car of parking.cars) {
        this._addParkedCar(car);
      }
    }
  }

  _addParkedCar(config) {
    const colorIdx = config.color || 0;
    const color = COLORS.car[colorIdx % COLORS.car.length];

    const modelName = CAR_MODELS[Math.floor(Math.random() * CAR_MODELS.length)];
    const raw = this.assets.getModelInstance(modelName);
    const car = this._groundAndCenter(raw);

    // Paint tint from the old car color palette. Kenney cars have a
    // dedicated "paint<Color>" body material distinct from the plastic
    // trim/window/light materials, so it can be identified reliably by
    // name. Clone it before tinting — instances share materials otherwise.
    raw.traverse((obj) => {
      if (obj.isMesh && obj.material && /^paint/i.test(obj.material.name || '')) {
        obj.material = obj.material.clone();
        obj.material.color.set(color);
      }
    });

    const rotationY = (config.rotation || 0) + (Math.random() - 0.5) * 0.1; // ±0.05 rad jitter
    car.position.set(config.x, 0, config.z);
    car.rotation.y = rotationY;
    this.scene.add(car);

    // Physics blocker (box size unchanged; orientation now matches the
    // visual so cars rotated to park along an edge — e.g. the density-pass
    // additions — block/collide correctly instead of leaving a mismatched
    // axis-aligned box).
    const shape = new CANNON.Box(new CANNON.Vec3(1.0, 0.8, 1.8));
    const physBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(config.x, 0.8, config.z),
      shape,
    });
    physBody.quaternion.setFromEuler(0, rotationY, 0);
    this.physicsWorld.addBody(physBody);
  }

  _buildPerimeter() {
    // Perimeter fence/wall
    const wallH = 2;
    const wallMat = createMaterial('rough', { color: 0x8B8B6E });
    const halfW = SIZES.mapWidth / 2 + 5;
    const halfD = SIZES.mapDepth / 2 + 5;

    const walls = [
      { pos: [0, wallH / 2, -halfD], size: [halfW * 2, wallH, 0.3] },
      { pos: [0, wallH / 2, halfD], size: [halfW * 2, wallH, 0.3] },
      { pos: [-halfW, wallH / 2, 0], size: [0.3, wallH, halfD * 2] },
      { pos: [halfW, wallH / 2, 0], size: [0.3, wallH, halfD * 2] },
    ];

    for (const w of walls) {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(...w.size),
        wallMat
      );
      wall.position.set(...w.pos);
      wall.castShadow = true;
      this.scene.add(wall);

      // Physics
      const shape = new CANNON.Box(
        new CANNON.Vec3(w.size[0] / 2, w.size[1] / 2, w.size[2] / 2)
      );
      const body = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(...w.pos),
        shape,
      });
      this.physicsWorld.addBody(body);
    }

    // Decorative trees along perimeter
    for (let i = -halfW + 5; i < halfW; i += 12) {
      this._addPerimeterTree(i, -halfD + 2);
      this._addPerimeterTree(i, halfD - 2);
    }
    for (let i = -halfD + 5; i < halfD; i += 12) {
      this._addPerimeterTree(-halfW + 2, i);
      this._addPerimeterTree(halfW - 2, i);
    }
  }

  _addPerimeterTree(x, z) {
    // Weighted toward tree-big along the perimeter
    const roll = Math.random();
    const name = roll < 0.6 ? 'tree-big' : (roll < 0.8 ? 'tree-small' : 'low-poly-tree');

    const raw = this.assets.getModelInstance(name);
    const tree = this._groundAndCenter(raw);
    const scale = TREE_BASE_SCALE[name] * (0.85 + Math.random() * 0.45);
    tree.scale.setScalar(scale);
    tree.rotation.y = Math.random() * Math.PI * 2;
    tree.position.set(x, 0, z);
    this.scene.add(tree);
  }

  /**
   * Density pass: extra trees + rock formations scattered in the buffer
   * strip between the playable area and the perimeter fence. Purely
   * decorative (no physics bodies) — see SCATTER_TREES/SCATTER_ROCKS above
   * for how positions were chosen to clear every area/path rect.
   */
  _buildDensityScatter() {
    for (const { x, z } of SCATTER_TREES) {
      this._addPerimeterTree(x, z);
    }
    for (const { x, z } of SCATTER_ROCKS) {
      const name = ROCK_MODELS[Math.floor(Math.random() * ROCK_MODELS.length)];
      const raw = this.assets.getModelInstance(name);
      const rock = this._groundAndCenter(raw);
      rock.scale.setScalar(0.7 + Math.random() * 0.6);
      rock.rotation.y = Math.random() * Math.PI * 2;
      rock.position.set(x, 0, z);
      this.scene.add(rock);
    }
  }

  update(dt) {
    if (this.garden) {
      this.garden.update(dt);
    }
  }

  setNightGlow(f) {
    for (const b of this.buildings) b.setNightGlow(f);
  }
}
