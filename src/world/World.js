import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES } from '../utils/Constants.js';
import { Court } from './Court.js';
import { Building } from './Building.js';
import { Garden } from './Garden.js';

/**
 * World - loads map.json and builds the entire club environment
 */
export class World {
  constructor(scene, physicsWorld, mapData) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.mapData = mapData;
    this.courts = [];
    this.buildings = [];
    this.garden = null;
    this.trees = [];

    this._buildGround();
    this._buildPaths();
    this._buildCourts();
    this._buildProShop();
    this._buildClubhouse();
    this._buildGarden();
    this._buildPatio();
    this._buildParking();
    this._buildPerimeter();
  }

  _buildGround() {
    // Main ground plane
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(SIZES.mapWidth * 2, SIZES.mapDepth * 2),
      new THREE.MeshLambertMaterial({ color: COLORS.ground })
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
    const pathMat = new THREE.MeshLambertMaterial({ color: COLORS.path });

    for (const path of this.mapData.paths) {
      const points = path.points;
      const width = path.width || 3;

      for (let i = 0; i < points.length - 1; i++) {
        const start = points[i];
        const end = points[i + 1];
        const dx = end.x - start.x;
        const dz = end.z - start.z;
        const length = Math.sqrt(dx * dx + dz * dz);
        const angle = Math.atan2(dx, dz);

        const segment = new THREE.Mesh(
          new THREE.BoxGeometry(width, 0.06, length + width * 0.3),
          pathMat
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
          pathMat
        );
        joint.position.set(point.x, 0.03, point.z);
        joint.receiveShadow = true;
        this.scene.add(joint);
      }
    }
  }

  _buildCourts() {
    for (const courtConfig of this.mapData.areas.courts) {
      const court = new Court(this.scene, this.physicsWorld, courtConfig);
      this.courts.push(court);
    }
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
    this.garden = new Garden(this.scene, this.physicsWorld, gardenConfig);
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
      new THREE.MeshLambertMaterial({ color: 0xC4A882 })
    );
    floor.position.set(patioConfig.center.x, 0.04, patioConfig.center.z);
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  _addPatioTable(x, z) {
    const group = new THREE.Group();

    // Table top
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.8, 0.08, 8),
      new THREE.MeshLambertMaterial({ color: 0xDEB887 })
    );
    top.position.y = 0.75;
    top.castShadow = true;
    group.add(top);

    // Table leg
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.75, 6),
      new THREE.MeshLambertMaterial({ color: 0x888888 })
    );
    leg.position.y = 0.375;
    group.add(leg);

    // Umbrella pole
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 2.0, 6),
      new THREE.MeshLambertMaterial({ color: 0x888888 })
    );
    pole.position.y = 1.75;
    group.add(pole);

    // Umbrella
    const umbrella = new THREE.Mesh(
      new THREE.ConeGeometry(1.2, 0.5, 8),
      new THREE.MeshLambertMaterial({ color: 0xB22222 })
    );
    umbrella.position.y = 2.5;
    umbrella.castShadow = true;
    group.add(umbrella);

    // Chairs (2)
    for (const offset of [-0.9, 0.9]) {
      const chair = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.05, 0.4),
        new THREE.MeshLambertMaterial({ color: 0xDEB887 })
      );
      chair.position.set(offset, 0.45, 0);
      group.add(chair);

      const chairLeg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.45, 4),
        new THREE.MeshLambertMaterial({ color: 0x888888 })
      );
      chairLeg.position.set(offset, 0.225, 0);
      group.add(chairLeg);
    }

    group.position.set(x, 0, z);
    this.scene.add(group);
  }

  _addPatioBench(x, z) {
    const bench = new THREE.Group();

    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.08, 0.5),
      new THREE.MeshLambertMaterial({ color: 0x8B6914 })
    );
    seat.position.y = 0.45;
    bench.add(seat);

    const back = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.5, 0.08),
      new THREE.MeshLambertMaterial({ color: 0x8B6914 })
    );
    back.position.set(0, 0.7, -0.2);
    bench.add(back);

    const legGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.45, 4);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    for (const lx of [-0.8, 0.8]) {
      for (const lz of [-0.15, 0.15]) {
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(lx, 0.225, lz);
        bench.add(leg);
      }
    }

    bench.position.set(x, 0, z);
    this.scene.add(bench);
  }

  _buildParking() {
    const parking = this.mapData.areas.parking;
    if (!parking) return;

    // Parking surface
    const lot = new THREE.Mesh(
      new THREE.BoxGeometry(parking.bounds.width, 0.06, parking.bounds.depth),
      new THREE.MeshLambertMaterial({ color: 0x555555 })
    );
    lot.position.set(parking.center.x, 0.03, parking.center.z);
    lot.receiveShadow = true;
    this.scene.add(lot);

    // Parking lines
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
    for (let i = 0; i < 5; i++) {
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.01, 4),
        lineMat
      );
      line.position.set(parking.center.x - 10 + i * 4, 0.07, parking.center.z);
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

    const car = new THREE.Group();

    // Body
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.8, 3.5),
      new THREE.MeshLambertMaterial({ color })
    );
    body.position.y = 0.7;
    body.castShadow = true;
    car.add(body);

    // Cabin
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.6, 1.8),
      new THREE.MeshLambertMaterial({ color })
    );
    cabin.position.set(0, 1.3, -0.2);
    cabin.castShadow = true;
    car.add(cabin);

    // Windows
    const winMat = new THREE.MeshLambertMaterial({
      color: 0x87CEEB,
      transparent: true,
      opacity: 0.6,
    });
    const frontWin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 0.05), winMat);
    frontWin.position.set(0, 1.25, -1.1);
    car.add(frontWin);

    // Wheels
    const wheelGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.15, 8);
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
    const wheelPositions = [[-0.9, 0.25, -1.0], [0.9, 0.25, -1.0], [-0.9, 0.25, 1.0], [0.9, 0.25, 1.0]];
    for (const [wx, wy, wz] of wheelPositions) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(wx, wy, wz);
      wheel.rotation.z = Math.PI / 2;
      car.add(wheel);
    }

    car.position.set(config.x, 0, config.z);
    car.rotation.y = config.rotation || 0;
    this.scene.add(car);

    // Physics blocker
    const shape = new CANNON.Box(new CANNON.Vec3(1.0, 0.8, 1.8));
    const physBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(config.x, 0.8, config.z),
      shape,
    });
    this.physicsWorld.addBody(physBody);
  }

  _buildPerimeter() {
    // Perimeter fence/wall
    const wallH = 2;
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x8B8B6E });
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
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.18, 1.8, 5),
      new THREE.MeshLambertMaterial({ color: 0x8B6914 })
    );
    trunk.position.set(x, 0.9, z);
    trunk.castShadow = true;
    this.scene.add(trunk);

    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 6, 5),
      new THREE.MeshLambertMaterial({ color: 0x228B22 })
    );
    canopy.position.set(x, 2.5, z);
    canopy.castShadow = true;
    this.scene.add(canopy);
  }

  update(dt) {
    if (this.garden) {
      this.garden.update(dt);
    }
  }
}
