import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { COLORS, SIZES, GAME } from '../utils/Constants.js';

/**
 * Court - tennis court with surface, lines, net, fencing, and benches
 */
export class Court {
  constructor(scene, physicsWorld, config) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.config = config;
    this.mesh = new THREE.Group();
    this.id = config.id;
    this.isClay = config.type === 'clay';

    // Surface grid for clay court maintenance
    this.gridCols = 0;
    this.gridRows = 0;
    this.dirtGrid = null;       // 2D array of dirtiness values (0=clean, 1=dirty)
    this.gridMeshes = null;     // 2D array of overlay meshes
    this.surfaceMesh = null;    // reference to main surface for color updates

    this._build();
    this.scene.add(this.mesh);

    if (this.isClay) {
      this._buildDirtGrid();
    }
  }

  /**
   * Get dirtiness at a world position. Returns -1 if outside the court.
   */
  getDirtAt(worldX, worldZ) {
    if (!this.dirtGrid) return -1;
    const cell = this._worldToGrid(worldX, worldZ);
    if (!cell) return -1;
    return this.dirtGrid[cell.row][cell.col];
  }

  /**
   * Groom (clean) cells near a world position within a given radius.
   * Returns number of cells affected.
   */
  groomAt(worldX, worldZ, radius) {
    if (!this.dirtGrid) return 0;
    const { center } = this.config;
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    const cellSize = GAME.groomCellSize;
    let affected = 0;

    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        if (this.dirtGrid[row][col] <= 0) continue;

        // Cell center in world coords
        const cx = center.x - w / 2 + (col + 0.5) * cellSize;
        const cz = center.z - d / 2 + (row + 0.5) * cellSize;
        const dx = worldX - cx;
        const dz = worldZ - cz;
        if (dx * dx + dz * dz < radius * radius) {
          this.dirtGrid[row][col] = Math.max(0, this.dirtGrid[row][col] - 0.15);
          this._updateCellVisual(row, col);
          affected++;
        }
      }
    }
    return affected;
  }

  /**
   * Add dirt to all cells (simulates play degradation).
   */
  degradeSurface(amount) {
    if (!this.dirtGrid) return;
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        this.dirtGrid[row][col] = Math.min(1, this.dirtGrid[row][col] + amount);
        this._updateCellVisual(row, col);
      }
    }
  }

  /**
   * Get overall cleanliness (0=all dirty, 1=all clean).
   */
  getCleanliness() {
    if (!this.dirtGrid) return 1;
    let total = 0;
    const count = this.gridRows * this.gridCols;
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        total += (1 - this.dirtGrid[row][col]);
      }
    }
    return total / count;
  }

  /**
   * Set all cells to a given dirtiness level.
   */
  setAllDirt(level) {
    if (!this.dirtGrid) return;
    for (let row = 0; row < this.gridRows; row++) {
      for (let col = 0; col < this.gridCols; col++) {
        this.dirtGrid[row][col] = level;
        this._updateCellVisual(row, col);
      }
    }
  }

  _worldToGrid(worldX, worldZ) {
    const { center } = this.config;
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    const cellSize = GAME.groomCellSize;

    const localX = worldX - (center.x - w / 2);
    const localZ = worldZ - (center.z - d / 2);
    const col = Math.floor(localX / cellSize);
    const row = Math.floor(localZ / cellSize);

    if (col < 0 || col >= this.gridCols || row < 0 || row >= this.gridRows) return null;
    return { row, col };
  }

  _buildDirtGrid() {
    const { center } = this.config;
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    const cellSize = GAME.groomCellSize;

    this.gridCols = Math.floor(w / cellSize);
    this.gridRows = Math.floor(d / cellSize);
    this.dirtGrid = [];
    this.gridMeshes = [];

    const dirtyMat = new THREE.MeshLambertMaterial({
      color: COLORS.clayCourtDirty,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });

    for (let row = 0; row < this.gridRows; row++) {
      this.dirtGrid[row] = [];
      this.gridMeshes[row] = [];
      for (let col = 0; col < this.gridCols; col++) {
        // Start at 60% dirty
        this.dirtGrid[row][col] = 0.6;

        const cellMesh = new THREE.Mesh(
          new THREE.BoxGeometry(cellSize - 0.05, 0.01, cellSize - 0.05),
          dirtyMat.clone()
        );
        const cx = center.x - w / 2 + (col + 0.5) * cellSize;
        const cz = center.z - d / 2 + (row + 0.5) * cellSize;
        cellMesh.position.set(cx, 0.17, cz);
        cellMesh.receiveShadow = true;
        this.mesh.add(cellMesh);
        this.gridMeshes[row][col] = cellMesh;

        this._updateCellVisual(row, col);
      }
    }
  }

  _updateCellVisual(row, col) {
    const mesh = this.gridMeshes[row][col];
    const dirt = this.dirtGrid[row][col];
    // Opacity shows dirt level — fully clean = invisible, fully dirty = visible overlay
    mesh.material.opacity = dirt * 0.6;
  }

  _build() {
    const { center, type } = this.config;
    const w = SIZES.courtWidth;
    const d = SIZES.courtDepth;
    const surfaceColor = type === 'clay' ? COLORS.clayCourt : COLORS.hardCourt;

    // Court surface
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.15, d),
      new THREE.MeshLambertMaterial({ color: surfaceColor })
    );
    surface.position.set(center.x, 0.08, center.z);
    surface.receiveShadow = true;
    this.mesh.add(surface);

    // Court lines
    this._addLines(center, w, d);

    // Net
    this._addNet(center, w);

    // Fence
    this._addFence(center, w, d);

    // Benches on outer sides only (skip when adjacent to another court)
    if (!this.config.adjacentLeft) {
      this._addBench(center.x - w / 2 - 1.2, center.z);
    }
    if (!this.config.adjacentRight) {
      this._addBench(center.x + w / 2 + 1.2, center.z);
    }

    // Court label
    this._addLabel(center);

    // Physics: static body for court surface
    const courtShape = new CANNON.Box(new CANNON.Vec3(w / 2, 0.1, d / 2));
    const courtBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(center.x, 0.05, center.z),
      shape: courtShape,
    });
    this.physicsWorld.addBody(courtBody);
  }

  _addLines(center, w, d) {
    const lineMat = new THREE.MeshBasicMaterial({ color: COLORS.hardCourtLines });
    const lineH = 0.16;

    // Outline
    const lines = [
      // Baselines (top & bottom)
      { pos: [0, 0, -d / 2 + 0.05], size: [w - 0.5, 0.02, 0.1] },
      { pos: [0, 0, d / 2 - 0.05], size: [w - 0.5, 0.02, 0.1] },
      // Sidelines
      { pos: [-w / 2 + 0.3, 0, 0], size: [0.1, 0.02, d - 0.5] },
      { pos: [w / 2 - 0.3, 0, 0], size: [0.1, 0.02, d - 0.5] },
      // Singles sidelines
      { pos: [-w / 2 + 1.8, 0, 0], size: [0.08, 0.02, d - 0.5] },
      { pos: [w / 2 - 1.8, 0, 0], size: [0.08, 0.02, d - 0.5] },
      // Center service line
      { pos: [0, 0, 0], size: [0.08, 0.02, d / 2 - 1] },
      // Service lines
      { pos: [0, 0, -d / 4], size: [w - 3.6, 0.02, 0.08] },
      { pos: [0, 0, d / 4], size: [w - 3.6, 0.02, 0.08] },
      // Center mark
      { pos: [0, 0, -d / 2 + 0.4], size: [0.08, 0.02, 0.6] },
      { pos: [0, 0, d / 2 - 0.4], size: [0.08, 0.02, 0.6] },
    ];

    for (const line of lines) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(...line.size),
        lineMat
      );
      mesh.position.set(
        center.x + line.pos[0],
        lineH + line.pos[1],
        center.z + line.pos[2]
      );
      this.mesh.add(mesh);
    }
  }

  _addNet(center, w) {
    // Net posts
    const postGeo = new THREE.CylinderGeometry(0.05, 0.05, SIZES.netHeight);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x666666 });

    const leftPost = new THREE.Mesh(postGeo, postMat);
    leftPost.position.set(center.x - w / 2 + 0.2, SIZES.netHeight / 2, center.z);
    leftPost.castShadow = true;
    this.mesh.add(leftPost);

    const rightPost = new THREE.Mesh(postGeo, postMat);
    rightPost.position.set(center.x + w / 2 - 0.2, SIZES.netHeight / 2, center.z);
    rightPost.castShadow = true;
    this.mesh.add(rightPost);

    // Net mesh (simplified as a flat plane)
    const net = new THREE.Mesh(
      new THREE.PlaneGeometry(w - 0.4, SIZES.netHeight - 0.2),
      new THREE.MeshLambertMaterial({
        color: COLORS.net,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
      })
    );
    net.position.set(center.x, SIZES.netHeight / 2, center.z);
    this.mesh.add(net);

    // Net cord (top cable)
    const cord = new THREE.Mesh(
      new THREE.BoxGeometry(w - 0.4, 0.04, 0.04),
      new THREE.MeshLambertMaterial({ color: 0xFFFFFF })
    );
    cord.position.set(center.x, SIZES.netHeight - 0.1, center.z);
    this.mesh.add(cord);

    // Net collision body (thin wall across the court)
    const netShape = new CANNON.Box(new CANNON.Vec3((w - 0.4) / 2, SIZES.netHeight / 2, 0.08));
    const netBody = new CANNON.Body({
      mass: 0,
      position: new CANNON.Vec3(center.x, SIZES.netHeight / 2, center.z),
      shape: netShape,
    });
    this.physicsWorld.addBody(netBody);
  }

  _addFence(center, w, d) {
    const fenceH = SIZES.fenceHeight;
    const fenceMat = new THREE.MeshLambertMaterial({
      color: COLORS.courtFence,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    const postMat = new THREE.MeshLambertMaterial({ color: 0x666666 });

    // Back fences (behind baselines)
    const fences = [
      { pos: [0, fenceH / 2, -d / 2 - 0.5], size: [w + 2, fenceH, 0.1] },
      { pos: [0, fenceH / 2, d / 2 + 0.5], size: [w + 2, fenceH, 0.1] },
    ];

    for (const f of fences) {
      const fence = new THREE.Mesh(
        new THREE.PlaneGeometry(f.size[0], f.size[1]),
        fenceMat
      );
      fence.position.set(center.x + f.pos[0], f.pos[1], center.z + f.pos[2]);
      if (f.size[2] > 0.05) {
        fence.rotation.y = 0;
      }
      this.mesh.add(fence);
    }

    // Fence collision bodies (behind baselines)
    for (const f of fences) {
      const fenceShape = new CANNON.Box(new CANNON.Vec3(f.size[0] / 2, fenceH / 2, 0.15));
      const fenceBody = new CANNON.Body({
        mass: 0,
        position: new CANNON.Vec3(center.x + f.pos[0], f.pos[1], center.z + f.pos[2]),
        shape: fenceShape,
      });
      this.physicsWorld.addBody(fenceBody);
    }

    // Fence posts
    const postGeo = new THREE.CylinderGeometry(0.04, 0.04, fenceH);
    const postSpacing = 4;
    for (let x = -w / 2 - 1; x <= w / 2 + 1; x += postSpacing) {
      for (const zOff of [-d / 2 - 0.5, d / 2 + 0.5]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(center.x + x, fenceH / 2, center.z + zOff);
        post.castShadow = true;
        this.mesh.add(post);
      }
    }
  }

  _addBench(x, z) {
    const bench = new THREE.Group();

    // Seat
    const seat = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.08, 0.4),
      new THREE.MeshLambertMaterial({ color: COLORS.bench })
    );
    seat.position.y = 0.45;
    seat.castShadow = true;
    bench.add(seat);

    // Legs
    const legGeo = new THREE.BoxGeometry(0.08, 0.45, 0.08);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const legs = [[-0.6, 0.225, 0.12], [0.6, 0.225, 0.12], [-0.6, 0.225, -0.12], [0.6, 0.225, -0.12]];
    for (const [lx, ly, lz] of legs) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(lx, ly, lz);
      bench.add(leg);
    }

    // Backrest
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.4, 0.06),
      new THREE.MeshLambertMaterial({ color: COLORS.bench })
    );
    back.position.set(0, 0.7, -0.15);
    bench.add(back);

    bench.position.set(x, 0, z);
    this.mesh.add(bench);
  }

  _addLabel(center) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.config.label, 64, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true })
    );
    sprite.scale.set(3, 1.5, 1);
    sprite.position.set(center.x, 4.5, center.z);
    this.mesh.add(sprite);
  }
}
