import * as THREE from 'three';
import { SIZES } from '../utils/Constants.js';

/**
 * Seats — places where NPCs can sit, discovered from the built world (no World/Court wiring):
 *  - Scenery benches (patio, garden): the instanced 'Benches' groups (bench faces +Z locally).
 *  - Court benches: each `court:<id>` group is probed with downward rays at the spots where
 *    Court._addFurniture puts its side benches; only planks that are actually there count.
 * Other modules can add seats with registerSeat().
 *
 * A seat: { id, x, y (seat top, world), z, yaw (facing, radians; 0 = +Z), taken }.
 */

/** Pelvis-to-seat height of the 'sit' clip in model units (character bottom ↔ seat top). */
export const SIT_SEAT_HEIGHT = 0.63;

const _seats = [];
let _scanned = false;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * opts.reserved: only claimSeat(seat, who, true) takes it (a staff post seat, e.g. the lifeguard
 * chair; wandering members and rain shelters skip it). opts.approach: how far in front of the seat
 * the sitter stands before sitting down (default 0.5 m).
 */
export function registerSeat(x, y, z, yaw, id = `seat${_seats.length}`, opts = null) {
  const seat = { id, x, y, z, yaw, taken: null, reserved: !!(opts && opts.reserved), approach: (opts && opts.approach) || 0.5 };
  _seats.push(seat);
  return seat;
}

function scanScenery(scene) {
  scene.traverse((o) => {
    if (!o.isInstancedMesh || !/^Benches/.test(o.name)) return;
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, _m);
      _m.premultiply(o.matrixWorld);
      _m.decompose(_p, _q, _s);
      _fwd.set(0, 0, 1).applyQuaternion(_q);
      const yaw = Math.atan2(_fwd.x, _fwd.z);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw); // bench long axis (local +X)
      for (const off of [-0.45, 0.45]) {
        registerSeat(_p.x + rx * off + _fwd.x * 0.02, _p.y + 0.475 * _s.y, _p.z + rz * off + _fwd.z * 0.02, yaw,
          `${o.name}#${i}${off < 0 ? 'a' : 'b'}`);
      }
    }
  });
}

function scanCourts(scene) {
  const courts = scene.children.filter(o => /^court:/.test(o.name));
  if (!courts.length) return;
  const w = SIZES.courtWidth || 16;
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const hits = [];
  for (const court of courts) {
    court.updateWorldMatrix(true, true);
    // Wooden bench planks are merged into the court's matte bucket; fall back to everything
    const targets = court.children.filter(c => c.isMesh && /matte/i.test(c.name));
    const list = targets.length ? targets : court.children.filter(c => c.isMesh && c.name !== 'courtSurface');
    const cx = court.position.x, cz = court.position.z;
    const found = [];
    for (const sideX of [w / 2 + 1.2, (SIZES.clayCourtBuffer || 0) + w / 2 + 1.2]) {
      for (const sgn of [-1, 1]) {
        for (const bz of [0, -2.3, 2.3]) {
          const x = cx + sgn * sideX, z = cz + bz;
          if (found.some(f => Math.abs(f.x - x) < 0.5 && Math.abs(f.z - z) < 1)) continue;
          ray.set(_p.set(x, 3, z), down);
          ray.far = 4;
          hits.length = 0;
          ray.intersectObjects(list, false, hits);
          const h = hits[0];
          if (!h) continue;
          const top = h.point.y;
          if (top < 0.4 || top > 0.9 || (h.face && h.face.normal && Math.abs(h.face.normal.y) < 0.5)) continue;
          // Confirm a plank run along z (two seat spots 0.4 either side of the centre)
          let ok = 0;
          for (const dz of [-0.4, 0.4]) {
            ray.set(_p.set(x, 3, z + dz), down);
            hits.length = 0;
            ray.intersectObjects(list, false, hits);
            if (hits[0] && Math.abs(hits[0].point.y - top) < 0.04) ok++;
          }
          if (ok < 2) continue;
          found.push({ x, z });
          const yaw = sgn < 0 ? Math.PI / 2 : -Math.PI / 2; // faces the court centre
          for (const dz of [-0.4, 0.4]) registerSeat(x, top, z + dz, yaw, `${court.name}@${sgn}${bz}${dz}`);
        }
      }
    }
  }
}

/** All seats (scans the scene once, lazily). */
export function findSeats(scene) {
  if (!_scanned && scene) {
    _scanned = true;
    try { scanScenery(scene); } catch (e) { console.warn('Seat scan (benches) failed:', e); }
    try { scanCourts(scene); } catch (e) { console.warn('Seat scan (courts) failed:', e); }
  }
  return _seats;
}

export function claimSeat(seat, who, allowReserved = false) {
  if (!seat || (seat.taken && seat.taken !== who)) return false;
  if (seat.reserved && !allowReserved) return false;
  seat.taken = who;
  return true;
}

export function releaseSeat(seat, who) {
  if (seat && seat.taken === who) seat.taken = null;
}
