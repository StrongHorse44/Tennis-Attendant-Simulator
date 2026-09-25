import * as THREE from 'three';

/**
 * EnvState — shared, mutable environment state. WeatherSystem writes it once per
 * frame; any module may READ it (never allocate from it per frame; copy into your own temps).
 *
 * Usage:
 *   import { EnvState } from '../graphics/EnvState.js';
 *   lampMat.emissiveIntensity = EnvState.lampFactor * 3;
 *   tree.rotation.z = Math.sin(EnvState.time * 1.3 + phase) * 0.02 * EnvState.windStrength;
 */
export const EnvState = {
  /** Seconds since start (monotonic, scaled by dt). Use for animation phases. */
  time: 0,
  /** In-game hour 0..24. */
  timeOfDay: 7,
  /** 'sunny' | 'cloudy' | 'rainy' | 'windy' */
  weather: 'sunny',
  /** 0 = full day, 1 = full night (smooth through dawn/dusk). */
  nightFactor: 0,
  /** 0..1 — how much lamps / windows should glow (on a bit earlier than full night, and in heavy rain). */
  lampFactor: 0,
  /** 0..1 — golden-hour strength (sunrise / sunset warmth). */
  goldenFactor: 0,
  /** 0..1 — surfaces wetness (ramps up while raining, dries slowly). */
  wetness: 0,
  /** 0..1 — how overcast it is (cloudy/rainy). */
  overcast: 0,
  /** 0..~1.5 — wind strength for sway (calm ~0.15, windy ~1). */
  windStrength: 0.15,
  /** Normalised XZ wind direction (y always 0). */
  windDirection: new THREE.Vector3(1, 0, 0.3).normalize(),
  /** Unit vector pointing FROM the ground TOWARD the sun (may point below horizon at night). */
  sunDirection: new THREE.Vector3(0.5, 0.7, 0.5).normalize(),
  /** Current key-light (sun or moon) colour and intensity. */
  sunColor: new THREE.Color(0xffffff),
  sunIntensity: 3,
  /** Sky colours this frame (linear). */
  skyTopColor: new THREE.Color(0x3f86d6),
  horizonColor: new THREE.Color(0xbfe0f5),
  /** Point the shadow camera / rain follow (player or camera target). */
  focus: new THREE.Vector3(),
};
