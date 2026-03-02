import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES } from '../utils/Constants.js';

/**
 * Building - pro shop and clubhouse structures
 */
export class Building {
  constructor(scene, physicsWorld, type, config) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.type = type;
    this.mesh = new THREE.Group();

    if (type === 'proShop') {
      this._buildProShop(config);
    } else if (type === 'clubhouse') {
      this._buildClubhouse(config);
    }

    this.scene.add(this.mesh);
  }

  _buildProShop(config) {
    const { center } = config;
    const w = SIZES.proShopWidth;
    const d = SIZES.proShopDepth;
    const h = SIZES.proShopHeight;

    // Walls
    const wallMat = new THREE.MeshLambertMaterial({ color: COLORS.proShopWall });

    // Back wall
    const backWall = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 0.3),
      wallMat
    );
    backWall.position.set(center.x, h / 2, center.z - d / 2);
    backWall.castShadow = true;
    backWall.receiveShadow = true;
    this.mesh.add(backWall);

    // Left wall
    const leftWall = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, h, d),
      wallMat
    );
    leftWall.position.set(center.x - w / 2, h / 2, center.z);
    leftWall.castShadow = true;
    this.mesh.add(leftWall);

    // Right wall
    const rightWall = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, h, d),
      wallMat
    );
    rightWall.position.set(center.x + w / 2, h / 2, center.z);
    rightWall.castShadow = true;
    this.mesh.add(rightWall);

    // Front wall with door gap
    const doorWidth = 2.5;
    const frontLeftW = (w - doorWidth) / 2;
    const frontLeft = new THREE.Mesh(
      new THREE.BoxGeometry(frontLeftW, h, 0.3),
      wallMat
    );
    frontLeft.position.set(center.x - doorWidth / 2 - frontLeftW / 2, h / 2, center.z + d / 2);
    frontLeft.castShadow = true;
    this.mesh.add(frontLeft);

    const frontRight = new THREE.Mesh(
      new THREE.BoxGeometry(frontLeftW, h, 0.3),
      wallMat
    );
    frontRight.position.set(center.x + doorWidth / 2 + frontLeftW / 2, h / 2, center.z + d / 2);
    frontRight.castShadow = true;
    this.mesh.add(frontRight);

    // Door header
    const header = new THREE.Mesh(
      new THREE.BoxGeometry(doorWidth, h - 2.5, 0.3),
      wallMat
    );
    header.position.set(center.x, h - (h - 2.5) / 2, center.z + d / 2);
    this.mesh.add(header);

    // Roof
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 1, 0.3, d + 1),
      new THREE.MeshLambertMaterial({ color: COLORS.proShopRoof })
    );
    roof.position.set(center.x, h + 0.15, center.z);
    roof.castShadow = true;
    roof.receiveShadow = true;
    this.mesh.add(roof);

    // Floor
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(w - 0.4, 0.1, d - 0.4),
      new THREE.MeshLambertMaterial({ color: 0xD2B48C })
    );
    floor.position.set(center.x, 0.05, center.z);
    floor.receiveShadow = true;
    this.mesh.add(floor);

    // Counter
    const counter = new THREE.Mesh(
      new THREE.BoxGeometry(4, 1.1, 1),
      new THREE.MeshLambertMaterial({ color: COLORS.counter })
    );
    counter.position.set(center.x + 2, 0.55, center.z - 2);
    counter.castShadow = true;
    this.mesh.add(counter);

    // Register on counter
    const register = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.4, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x333333 })
    );
    register.position.set(center.x + 2, 1.3, center.z - 2);
    this.mesh.add(register);

    // Shelves along back wall
    for (let i = 0; i < 3; i++) {
      const shelf = new THREE.Mesh(
        new THREE.BoxGeometry(3.5, 0.1, 0.6),
        new THREE.MeshLambertMaterial({ color: COLORS.shelf })
      );
      shelf.position.set(center.x - 3, 1 + i * 1.0, center.z - d / 2 + 0.8);
      this.mesh.add(shelf);

      // Items on shelves
      for (let j = 0; j < 4; j++) {
        const item = new THREE.Mesh(
          new THREE.BoxGeometry(0.3 + Math.random() * 0.3, 0.4 + Math.random() * 0.3, 0.25),
          new THREE.MeshLambertMaterial({
            color: [0x3498DB, 0xE74C3C, 0x2ECC71, 0xF1C40F][j % 4]
          })
        );
        item.position.set(
          center.x - 4.2 + j * 1.0,
          1.3 + i * 1.0,
          center.z - d / 2 + 0.8
        );
        this.mesh.add(item);
      }
    }

    // Task board (clipboard on wall)
    if (config.taskBoard) {
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 1.0, 0.05),
        new THREE.MeshLambertMaterial({ color: 0xD4A76A })
      );
      board.position.set(config.taskBoard.x, config.taskBoard.y, center.z - d / 2 + 0.2);
      this.mesh.add(board);

      // Paper on board
      const paper = new THREE.Mesh(
        new THREE.BoxGeometry(0.65, 0.85, 0.02),
        new THREE.MeshLambertMaterial({ color: 0xFFFFF0 })
      );
      paper.position.set(config.taskBoard.x, config.taskBoard.y, center.z - d / 2 + 0.25);
      this.mesh.add(paper);
    }

    // Sign above door
    const sign = this._createSign('PRO SHOP');
    sign.position.set(center.x, h - 0.2, center.z + d / 2 + 0.2);
    this.mesh.add(sign);

    // Physics walls
    this._addWallPhysics(center.x, h / 2, center.z - d / 2, w / 2, h / 2, 0.15); // back
    this._addWallPhysics(center.x - w / 2, h / 2, center.z, 0.15, h / 2, d / 2); // left
    this._addWallPhysics(center.x + w / 2, h / 2, center.z, 0.15, h / 2, d / 2); // right
    // front walls (with gap)
    this._addWallPhysics(center.x - doorWidth / 2 - frontLeftW / 2, h / 2, center.z + d / 2, frontLeftW / 2, h / 2, 0.15);
    this._addWallPhysics(center.x + doorWidth / 2 + frontLeftW / 2, h / 2, center.z + d / 2, frontLeftW / 2, h / 2, 0.15);
  }

  _buildClubhouse(config) {
    const { center, width, depth, height } = config;
    const w = width || SIZES.clubhouseWidth;
    const d = depth || SIZES.clubhouseDepth;
    const h = height || SIZES.clubhouseHeight;

    // Main structure
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: COLORS.clubhouseWall })
    );
    building.position.set(center.x, h / 2, center.z);
    building.castShadow = true;
    building.receiveShadow = true;
    this.mesh.add(building);

    // Roof
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 1.5, 0.4, d + 1.5),
      new THREE.MeshLambertMaterial({ color: COLORS.clubhouseRoof })
    );
    roof.position.set(center.x, h + 0.2, center.z);
    roof.castShadow = true;
    this.mesh.add(roof);

    // Windows
    const windowMat = new THREE.MeshLambertMaterial({
      color: 0x87CEEB,
      emissive: 0x222244,
    });
    for (let i = 0; i < 4; i++) {
      const win = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.0, 0.05),
        windowMat
      );
      win.position.set(
        center.x - w / 2 + 2.5 + i * 3.5,
        h / 2 + 0.3,
        center.z + d / 2 + 0.03
      );
      this.mesh.add(win);
    }

    // Awning over patio side
    const awning = new THREE.Mesh(
      new THREE.BoxGeometry(w + 2, 0.08, 3),
      new THREE.MeshLambertMaterial({ color: 0xCC8844, transparent: true, opacity: 0.8 })
    );
    awning.position.set(center.x, h - 0.3, center.z + d / 2 + 1.5);
    awning.castShadow = true;
    this.mesh.add(awning);

    // Sign
    const sign = this._createSign('GREENBRIAR CLUB');
    sign.position.set(center.x, h + 0.8, center.z + d / 2 + 0.1);
    this.mesh.add(sign);

    // Physics
    this._addWallPhysics(center.x, h / 2, center.z, w / 2, h / 2, d / 2);
  }

  _createSign(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#2d5a3d';
    ctx.roundRect(0, 0, 512, 96, 8);
    ctx.fill();

    ctx.font = 'bold 40px Georgia, serif';
    ctx.fillStyle = '#f4e8c1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 48);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture })
    );
    sprite.scale.set(5, 1, 1);
    return sprite;
  }

  _addWallPhysics(x, y, z, hw, hh, hd) {
    const shape = new CANNON.Box(new CANNON.Vec3(hw, hh, hd));
    const body = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(x, y, z), shape });
    this.physicsWorld.addBody(body);
  }
}
