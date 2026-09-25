import * as THREE from 'three';
import { mat } from '../graphics/Materials.js';
import { getGeometry, mergeParts, makeMatrix } from '../graphics/GeometryUtils.js';
import { GAME } from '../utils/Constants.js';

/**
 * MissionMarkers — floating gold objective markers in the world for the current step of
 * every active mission that happens at a place (goTo / pickup / deliver / groom). Steps
 * that need an NPC use the NPC's own "!" marker instead.
 *
 * A small pool of meshes (one draw call each, no shadow, shared geometry + material),
 * bobbing and spinning; hidden when unused or when the player is standing at the spot.
 * No per-frame allocations.
 */

const POOL = (GAME.maxActiveMissions || 3) + 2; // + shift routines
const HIDE_NEAR = 4.5;   // m: the player is at the spot → hide (the action button takes over)
const MARKER_GOLD = 0xd9a441; // theme gold (ui/theme.js THEME.gold)

function markerGeometry() {
  return getGeometry('missionMarker', () => {
    // A faceted gem over a down-pointing chevron: reads as "go here" from far away
    const gem = new THREE.OctahedronGeometry(0.42, 0);
    const tip = new THREE.ConeGeometry(0.26, 0.42, 4, 1);
    return mergeParts([
      { geometry: gem, matrix: makeMatrix(0, 0.55, 0, 0, [1, 1.35, 1]) },
      { geometry: tip, matrix: makeMatrix(0, -0.12, 0, Math.PI / 4, 1, Math.PI) },
    ]);
  });
}

export class MissionMarkers {
  /**
   * @param {THREE.Scene} scene
   * @param {MissionSystem} missions
   */
  constructor(scene, missions) {
    this.missions = missions;
    this.time = 0;
    const geo = markerGeometry();
    const material = mat(MARKER_GOLD, { roughness: 0.35, metalness: 0.2, emissive: MARKER_GOLD, emissiveIntensity: 0.55 });
    this.meshes = [];
    for (let i = 0; i < POOL; i++) {
      const m = new THREE.Mesh(geo, material);
      m.name = 'missionMarker';
      m.visible = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.userData.noAO = true;
      m.userData.noMerge = true;
      m.userData.dynamic = true;
      m.frustumCulled = true;
      scene.add(m);
      this.meshes.push(m);
    }
  }

  /**
   * @param {number} dt
   * @param {{x:number,z:number}} playerPos
   * @param {THREE.Vector3} [cameraPos]  bigger markers far from the camera (stay readable)
   */
  update(dt, playerPos, cameraPos) {
    this.time += dt;
    const active = this.missions.getActiveMissions();
    let used = 0;
    for (let i = 0; i < active.length && used < this.meshes.length; i++) {
      const mission = active[i];
      const step = mission.steps ? mission.steps[mission.currentStep] : null;
      const pt = this.missions.getStepTargetPoint(step);
      if (!pt) continue;
      // two missions at the same spot share one marker
      let dup = false;
      for (let j = 0; j < used; j++) {
        const o = this.meshes[j].userData.pt;
        if (o === pt) { dup = true; break; }
      }
      if (dup) continue;
      const dx = playerPos ? playerPos.x - pt.x : 99;
      const dz = playerPos ? playerPos.z - pt.z : 99;
      if (dx * dx + dz * dz < HIDE_NEAR * HIDE_NEAR) continue;

      const m = this.meshes[used++];
      m.userData.pt = pt;
      const phase = i * 1.7;
      m.position.set(pt.x, pt.h + Math.sin(this.time * 2.4 + phase) * 0.22, pt.z);
      m.rotation.y = this.time * 1.4 + phase;
      let s = 1;
      if (cameraPos) {
        const cx = cameraPos.x - pt.x;
        const cz = cameraPos.z - pt.z;
        s = Math.min(2.4, Math.max(1, Math.sqrt(cx * cx + cz * cz) / 22));
      }
      m.scale.setScalar(s);
      m.visible = true;
    }
    for (let i = used; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (m.visible) m.visible = false;
      m.userData.pt = null;
    }
  }
}
