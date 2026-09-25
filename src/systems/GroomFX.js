import * as THREE from 'three';
import { GAME, SIZES } from '../utils/Constants.js';
import { THEME } from '../ui/theme.js';

/**
 * GroomFX - in-world grooming feedback owned by CourtMaintenanceSystem:
 *   - a floating "Court N · 72%" label over each clay court, shown only while grooming
 *     (canvas sprites, redrawn only when the rounded numbers change)
 *   - a pooled gold sparkle burst when a court reaches "excellent" / 100%
 * Everything is built once, hidden, so the shaders precompile with the scene.
 */

const SPARK_N = 160;
const LABEL_W = 256;
const LABEL_H = 104;
const LABEL_SCALE = 4.4;   // world units wide
const _sz = new THREE.Vector2();

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

class CourtLabel {
  constructor(scene, court) {
    this.court = court;
    this.canvas = document.createElement('canvas');
    this.canvas.width = LABEL_W;
    this.canvas.height = LABEL_H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.SpriteMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.name = `groomLabel:${court.id}`;
    const c = court.config.center;
    this.sprite.position.set(c.x, 4.8, c.z);
    this.sprite.scale.set(LABEL_SCALE, LABEL_SCALE * LABEL_H / LABEL_W, 1);
    this.sprite.renderOrder = 20;
    this.sprite.userData.noAO = true;
    this.sprite.visible = false;
    // Fade out when the camera is right under the label (it would cover the view), and
    // grow a little with distance so it stays readable from the high overview
    this.sprite.onBeforeRender = (_r, _s, camera) => {
      const d = camera.position.distanceTo(this.sprite.position);
      this.material.opacity = Math.min(1, Math.max(0, (d - 7) / 6));
      const k = (1 + Math.sin(this.pop * Math.PI) * 0.22) * Math.min(2, Math.max(1, d / 30));
      this.sprite.scale.set(LABEL_SCALE * k, LABEL_SCALE * k * LABEL_H / LABEL_W, 1);
    };
    scene.add(this.sprite);
    this.clean = -1;
    this.cover = -1;
    this.done = 0;
    this.pop = 0;
    this.title = (court.config.label || court.id).toUpperCase();
  }

  set(cleanPct, coverPct, done) {
    if (cleanPct === this.clean && coverPct === this.cover && done === this.done) return;
    if (done > this.done) this.pop = 1;
    this.clean = cleanPct; this.cover = coverPct; this.done = done;
    const ctx = this.ctx, W = LABEL_W, H = LABEL_H;
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 4, 4, W - 8, H - 8, 22);
    ctx.fillStyle = 'rgba(28, 58, 40, 0.86)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = done >= 2 ? THEME.gold : done >= 1 ? THEME.ok : 'rgba(244, 232, 193, 0.35)';
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244, 232, 193, 0.8)';
    ctx.font = `600 19px ${THEME.fontUI || 'Inter, system-ui, sans-serif'}`;
    ctx.fillText(done >= 2 ? `${this.title} ★` : this.title, 22, 30);

    const thr = (GAME.groomScoreThreshold ?? 0.85) * 100;
    ctx.fillStyle = cleanPct >= thr ? '#8fe0a6' : cleanPct >= thr * 0.7 ? THEME.gold : '#f2a27c';
    ctx.textAlign = 'right';
    ctx.font = `700 44px ${THEME.fontDisplay || 'Georgia, serif'}`;
    ctx.fillText(`${cleanPct}%`, W - 20, 44);

    // coverage bar
    const bx = 22, by = 70, bw = W - 44, bh = 12;
    roundRect(ctx, bx, by, bw, bh, 6);
    ctx.fillStyle = 'rgba(244, 232, 193, 0.18)';
    ctx.fill();
    if (coverPct > 0) {
      roundRect(ctx, bx, by, Math.max(bh, bw * coverPct / 100), bh, 6);
      ctx.fillStyle = coverPct >= 70 ? THEME.ok : THEME.clay;
      ctx.fill();
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(244, 232, 193, 0.65)';
    ctx.font = `500 13px ${THEME.fontUI || 'Inter, system-ui, sans-serif'}`;
    ctx.fillText('brushed', 22, 55);
    this.texture.needsUpdate = true;
  }

  update(dt) {
    if (this.pop > 0) this.pop = Math.max(0, this.pop - dt * 2.2);
  }
}

class Sparkles {
  constructor(scene) {
    this.pos = new Float32Array(SPARK_N * 3);
    this.vel = new Float32Array(SPARK_N * 3);
    this.life = new Float32Array(SPARK_N).fill(1);
    this.rate = new Float32Array(SPARK_N).fill(1);
    this.seed = new Float32Array(SPARK_N);
    for (let i = 0; i < SPARK_N; i++) this.seed[i] = Math.random();
    this.next = 0;
    this.alive = 0;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aLife', this.lifeAttr);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    const uniforms = { uScale: { value: 400 }, uTime: { value: 0 } };
    this.uniforms = uniforms;
    this.material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aLife; attribute float aSeed;
        uniform float uScale; uniform float uTime;
        varying float vA; varying float vSeed;
        void main() {
          vSeed = aSeed;
          float tw = 0.55 + 0.45 * sin(uTime * (14.0 + aSeed * 10.0) + aSeed * 40.0);
          vA = aLife >= 1.0 ? 0.0 : sin(aLife * 3.14159) * tw;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aLife >= 1.0 ? 0.0 : (0.34 + 0.3 * aSeed) * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vA; varying float vSeed;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c);
          float star = max(1.0 - abs(c.x) * 14.0, 0.0) * (1.0 - r * 2.0) + max(1.0 - abs(c.y) * 14.0, 0.0) * (1.0 - r * 2.0);
          float a = (smoothstep(0.5, 0.0, r) * 0.55 + star) * vA;
          if (a < 0.01) discard;
          vec3 col = mix(vec3(1.0, 0.86, 0.5), vec3(1.0, 0.98, 0.9), vSeed);
          gl_FragColor = vec4(col * a, a);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'GroomSparkles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.userData.noAO = true;
    this.points.visible = false;
    this.points.onBeforeRender = (renderer, _s, camera) => {
      renderer.getDrawingBufferSize(_sz);
      uniforms.uScale.value = _sz.y / (2 * Math.tan((camera.fov || 50) * Math.PI / 360));
    };
    scene.add(this.points);
  }

  /** Burst `count` sparkles over a rectangle (half extents hx, hz) centred at (x, y, z). */
  burst(x, y, z, hx, hz, count) {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % SPARK_N;
      this.pos[i * 3] = x + (Math.random() * 2 - 1) * hx;
      this.pos[i * 3 + 1] = y + Math.random() * 0.4;
      this.pos[i * 3 + 2] = z + (Math.random() * 2 - 1) * hz;
      this.vel[i * 3] = (Math.random() - 0.5) * 0.4;
      this.vel[i * 3 + 1] = 0.6 + Math.random() * 1.4;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
      this.life[i] = -Math.random() * 0.35;       // staggered start
      this.rate[i] = 1 / (1.2 + Math.random() * 0.9);
    }
    this.points.visible = true;
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
    if (!this.points.visible) return;
    let alive = 0;
    for (let i = 0; i < SPARK_N; i++) {
      if (this.life[i] >= 1) continue;
      this.life[i] = Math.min(1, this.life[i] + dt * this.rate[i]);
      if (this.life[i] < 0) { alive++; continue; }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] *= 1 - dt * 1.2;
      alive++;
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    this.posAttr.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
  }
}

export class GroomFX {
  constructor(scene, clayCourts) {
    this.scene = scene;
    this.labels = new Map();
    this.sparkles = null;
    if (!scene || typeof document === 'undefined') return;
    for (const court of clayCourts) this.labels.set(court.id, new CourtLabel(scene, court));
    this.sparkles = new Sparkles(scene);
  }

  showLabels(on) {
    for (const l of this.labels.values()) {
      l.sprite.visible = !!on;
      if (on) { l.clean = -1; l.done = 0; }
    }
  }

  /** Update one court's label (percentages 0..100, done = milestone 0/1/2). */
  setCourt(court, cleanPct, coverPct, done) {
    const l = this.labels.get(court.id);
    if (l) l.set(cleanPct, coverPct, done);
  }

  /** Sparkle burst over a court (level 1 = excellent, 2 = perfect). */
  celebrate(court, level) {
    if (!this.sparkles) return;
    const c = court.config.center;
    const y = (SIZES.courtSurfaceY || 0.15) + 0.1;
    this.sparkles.burst(c.x, y, c.z, SIZES.courtWidth / 2 - 0.5, SIZES.courtDepth / 2 - 0.5, level >= 2 ? 110 : 60);
    const l = this.labels.get(court.id);
    if (l) this.sparkles.burst(l.sprite.position.x, l.sprite.position.y - 0.3, l.sprite.position.z, 1.6, 0.3, level >= 2 ? 30 : 16);
  }

  update(dt) {
    if (this.sparkles) this.sparkles.update(dt);
    for (const l of this.labels.values()) if (l.sprite.visible) l.update(dt);
  }
}
