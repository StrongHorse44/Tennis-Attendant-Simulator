import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

/**
 * PostFX — post-processing chain driven by Quality settings.
 *
 *   low    : no composer (direct renderer.render, canvas MSAA)
 *   medium : RenderPass (4x MSAA HalfFloat) -> OutputPass + grade/vignette (to screen)
 *   high   : RenderPass -> GTAO -> Bloom -> OutputPass + grade/vignette (to screen)
 *
 * The final pass writes straight to the canvas and never swaps, so on medium the
 * composer's second target is never bound (no MSAA/depth allocated for it) and the
 * whole chain is one scene render + one full-screen pass.
 *
 *   const fx = new PostFX(renderer, scene, camera);
 *   fx.apply(Quality.settings);  fx.setSize(w, h);  fx.render(dt);
 *   fx.setGrade({ saturation: 1.1, vignette: 0.25 });
 */

/*
 * Colour grade + vignette + dither, folded into the final OutputPass (tone map + sRGB)
 * so the grade costs no extra full-screen pass. Runs display-referred (after sRGB).
 */
const GRADE_UNIFORMS = () => ({
  uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
  uGamma: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
  uGain: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
  uSaturation: { value: 1.04 },
  uContrast: { value: 1.04 },
  uVignette: { value: 0.22 },
  uAspect: { value: 1.0 },
});
const GRADE_PARS = /* glsl */`
    uniform vec3 uLift, uGamma, uGain;
    uniform float uSaturation, uContrast, uVignette, uAspect;
    float ccHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
`;
const GRADE_MAIN = /* glsl */`
      {
        vec3 c = clamp(gl_FragColor.rgb, 0.0, 1.0);
        c = c * uGain + uLift * (1.0 - c);
        c = pow(max(c, 0.0), 1.0 / uGamma);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, uSaturation);
        c = (c - 0.5) * uContrast + 0.5;
        vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
        float v = smoothstep(0.35, 1.05, length(d) * 1.25);
        c *= 1.0 - uVignette * v;
        c += (ccHash(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor.rgb = clamp(c, 0.0, 1.0);
      }
`;

/** OutputPass (tone mapping + sRGB) with the grade appended; exposes the grade uniforms. */
class GradeOutputPass extends OutputPass {
  constructor() {
    super();
    Object.assign(this.uniforms, GRADE_UNIFORMS()); // material.uniforms is this same object
    const fs = this.material.fragmentShader;
    const end = fs.lastIndexOf('}');
    this.material.fragmentShader = fs.slice(0, end).replace('varying vec2 vUv;', GRADE_PARS + '\n    varying vec2 vUv;') + GRADE_MAIN + '}';
  }
}

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = null;
    this.settings = null;
    /** False on GPUs that can't render to half-float targets (set by Game): use 8-bit targets. */
    this.halfFloat = true;
    this.gradePass = null;
    this.bloomPass = null;
    this.aoPass = null;
    this._w = 1;
    this._h = 1;
    // grade values persist across composer rebuilds
    this.grade = {
      lift: new THREE.Vector3(0.0, 0.0, 0.0),
      gamma: new THREE.Vector3(1, 1, 1),
      gain: new THREE.Vector3(1, 1, 1),
      saturation: 1.04,
      contrast: 1.04,
      vignette: 0.22,
    };
  }

  get enabled() { return !!this.composer; }

  /** (Re)build the chain for a Quality settings object. */
  apply(settings) {
    this.settings = settings;
    this._dispose();
    if (!settings.postFX) return;

    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: this.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples: settings.msaaSamples || 0,
    });
    rt.texture.name = 'PostFX.rt';
    const composer = new EffectComposer(r, rt);
    composer.setPixelRatio(r.getPixelRatio());
    composer.setSize(this._w, this._h);

    composer.addPass(new RenderPass(this.scene, this.camera));

    // GTAO and bloom allocate half-float targets internally
    if (settings.ao && this.halfFloat) {
      const ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.75;
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: 12 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      // Alpha-tested / transparent / sky objects must not occlude (fences would become walls)
      const cache = ao._visibilityCache;
      const hide = (o) => {
        cache.set(o, o.visible);
        if (o.isPoints || o.isLine || o.isSprite || o.userData.noAO) { o.visible = false; return; }
        const m = o.material;
        if (m && !Array.isArray(m) && (m.transparent || m.alphaTest > 0 || m.side === THREE.BackSide)) o.visible = false;
      };
      ao.overrideVisibility = function () { this.scene.traverse(hide); };
      composer.addPass(ao);
      this.aoPass = ao;
    }

    if (settings.bloom && this.halfFloat) {
      const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.28, 0.55, 1.25);
      composer.addPass(bloom);
      this.bloomPass = bloom;
    }

    const out = settings.colorGrade ? new GradeOutputPass() : new OutputPass();
    out.needsSwap = false; // renders to screen: no ping-pong for the next frame
    composer.addPass(out);
    if (settings.colorGrade) {
      this.gradePass = out;
      this._pushGrade();
    }

    // With an even number of swapping passes the RenderPass always targets renderTarget2,
    // and renderTarget1 is at most a plain intermediate: drop its MSAA + depth.
    const swaps = composer.passes.filter(p => p.enabled && p.needsSwap).length;
    if (swaps % 2 === 0) {
      composer.renderTarget1.samples = 0;
      composer.renderTarget1.depthBuffer = false;
    }

    this.composer = composer;
  }

  /** Set grade parameters (partial). Vectors accept Vector3 or [r,g,b]. */
  setGrade(p) {
    const g = this.grade;
    for (const k of ['lift', 'gamma', 'gain']) {
      if (p[k] !== undefined) Array.isArray(p[k]) ? g[k].fromArray(p[k]) : g[k].copy(p[k]);
    }
    for (const k of ['saturation', 'contrast', 'vignette']) if (p[k] !== undefined) g[k] = p[k];
    this._pushGrade();
  }

  /**
   * Per-frame mood grade from EnvState (night = cooler & less saturated, golden = warmer,
   * overcast = flatter). Writes uniforms directly — no allocations.
   */
  updateFromEnv(env) {
    if (!this.gradePass) return;
    const u = this.gradePass.uniforms;
    // Under stadium floodlights the court reads like day: most of the night grade is lifted
    const n = env.nightFactor * (1 - 0.75 * (env.floodFactor || 0)), gd = env.goldenFactor, o = env.overcast;
    const g = this.grade;
    u.uSaturation.value = g.saturation * (1 - 0.45 * n - 0.12 * o) + 0.05 * gd;
    u.uContrast.value = g.contrast * (1 - 0.04 * o);
    u.uGain.value.set(
      g.gain.x * (1 - 0.2 * n + 0.03 * gd),
      g.gain.y * (1 - 0.12 * n),
      g.gain.z * (1 + 0.02 * n - 0.04 * gd)
    );
    u.uLift.value.set(g.lift.x, g.lift.y + 0.004 * n, g.lift.z + 0.018 * n);
    u.uVignette.value = g.vignette + 0.1 * n;
  }

  _pushGrade() {
    if (!this.gradePass) return;
    const u = this.gradePass.uniforms;
    u.uLift.value.copy(this.grade.lift);
    u.uGamma.value.copy(this.grade.gamma);
    u.uGain.value.copy(this.grade.gain);
    u.uSaturation.value = this.grade.saturation;
    u.uContrast.value = this.grade.contrast;
    u.uVignette.value = this.grade.vignette;
    u.uAspect.value = this._w / Math.max(1, this._h);
  }

  setSize(w, h) {
    this._w = w;
    this._h = h;
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    if (this.gradePass) this.gradePass.uniforms.uAspect.value = w / Math.max(1, h);
  }

  render(dt) {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  _dispose() {
    if (!this.composer) return;
    for (const p of this.composer.passes) if (p.dispose) p.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer = null;
    this.gradePass = null;
    this.bloomPass = null;
    this.aoPass = null;
  }

  dispose() { this._dispose(); }
}
