import * as THREE from 'three';

// Stylized-PBR presets: flat low-poly colors + these values + scene env map
const PRESETS = {
  matte:   { roughness: 1.0,  metalness: 0.0 },  // grass, clay, cloth, foliage, nets, seats
  rough:   { roughness: 0.9,  metalness: 0.0 },  // stone, stucco walls, concrete paths, skin
  wood:    { roughness: 0.8,  metalness: 0.0 },  // benches, roofs, counters, trunks, boards
  plastic: { roughness: 0.55, metalness: 0.0 },  // cart body, coolers, cups, car bodies, shoes
  metal:   { roughness: 0.45, metalness: 0.7 },  // fences, posts, bins, bench legs, frames
  glass:   { roughness: 0.15, metalness: 0.0, envMapIntensity: 1.5 }, // windows, water
};

export function createMaterial(preset, options = {}) {
  return new THREE.MeshStandardMaterial({ ...PRESETS[preset], ...options });
}
