import * as THREE from 'three';

/**
 * Stadium — the sunken Centre Court bowl in the world: stand / rim visuals, the stand and rim
 * physics compounds, the pit-floor plane, the collision-mask filter for the hole in the y = 0
 * ground plane, the rescue pass, spectator seats, scoreboards and the crowd impostors.
 * Everything geometric comes from the pure StadiumLayout (world.stadiumLayout).
 *
 * World constructs it right after the courts / court junctions (before the perimeter, trees,
 * lamps, grass and scenery.build()) and calls:
 *   world.stepPhysics(dt) → preStep() → physicsWorld.step(...) → postFrame()
 *   world.update(dt)      → update(dt)
 *
 * SKELETON: the surface other modules code against. Every method is a no-op for now; the
 * bowl itself (stream A2) fills them in.
 */
export class Stadium {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {import('cannon-es').World} o.physicsWorld
   * @param {import('./World.js').World} o.world
   * @param {import('./Court.js').Court} o.court   the stadium court (court6)
   * @param {import('./StadiumLayout.js').StadiumLayout} o.layout
   * @param {import('./Scenery.js').Scenery} o.scenery  (rim benches go in before scenery.build())
   */
  constructor({ scene, physicsWorld, world, court, layout, scenery }) {
    this.scene = scene;
    this.physicsWorld = physicsWorld;
    this.world = world;
    this.court = court || null;
    this.layout = layout;
    this.scenery = scenery;
    this.matches = null;

    /** Every stadium mesh lives here (added to the scene, not World.staticRoot). */
    this.root = new THREE.Group();
    this.root.name = 'StadiumRoot';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    scene.add(this.root);

    /** Seats.js seat objects (reserved) that spectators and after-hours staff use. */
    this.spectatorSeats = [];
    /** Rescue-pass counters (debug / tests). */
    this.stats = { rescues: 0, cartPushes: 0 };
  }

  /** Before physicsWorld.step: collision masks from the current body positions. */
  preStep() {}

  /** After physicsWorld.step: rescue embedded / fallen bodies, push the cart out of the footprint. */
  postFrame() {}

  /** Per frame: scoreboard poll, crowd ramp and cheer. Allocation-free. */
  update(dt) {} // eslint-disable-line no-unused-vars

  /** The MatchSystem the scoreboards read (getMatch / nextEntryFor). */
  setMatchSource(matchSystem) {
    this.matches = matchSystem || null;
  }

  /** Crowd impostors: ramp toward frac × capacity (instant: jump there). */
  setCrowd(frac, instant = false) {} // eslint-disable-line no-unused-vars

  /** A short lift of the crowd impostors (0..1). */
  cheer(strength) {} // eslint-disable-line no-unused-vars

  /** DEV: invariants on live bodies (support height, collision masks). */
  debugCheck() {}
}
