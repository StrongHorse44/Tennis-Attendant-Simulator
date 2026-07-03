import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Cheap vignette applied in linear space before OutputPass
const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.30 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float strength;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - strength * smoothstep(0.4, 0.85, d);
      gl_FragColor = c;
    }`,
};

// Skip post entirely on very low-end phones
export function isLowEndDevice() {
  const cores = navigator.hardwareConcurrency || 4;
  const minDim = Math.min(window.screen.width, window.screen.height);
  return cores <= 4 || minDim <= 400;
}

export class PostFX {
  constructor(renderer, scene, camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // HDR half-float target + 4x MSAA (WebGL2 guaranteed in r170)
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      samples: 4,
      type: THREE.HalfFloatType,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(window.innerWidth, window.innerHeight);

    this.composer.addPass(new RenderPass(scene, camera));
    // Subtle filmic bloom — only genuinely bright things glow
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.25, 0.4, 1.3);
    this.composer.addPass(this.bloomPass);
    this.vignettePass = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignettePass);
    // OutputPass applies ACES tone mapping + sRGB; it reads
    // renderer.toneMapping / toneMappingExposure live each frame
    this.composer.addPass(new OutputPass());
  }

  render() { this.composer.render(); }
  setSize(w, h) { this.composer.setSize(w, h); }
}
