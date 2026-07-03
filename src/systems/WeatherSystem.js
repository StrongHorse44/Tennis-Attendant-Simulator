import * as THREE from 'three';
import { GAME } from '../utils/Constants.js';

// sunI values assume r155+ physical lighting + MeshStandardMaterial
const TOD_KEYS = [
  //  h     sun color  sunI   sky        fog        hemiSky    hemiGnd   hemiI  envI  exp
  { h: 0.0,  sun: 0x8FA8DC, sunI: 0.30, sky: 0x0E1526, fog: 0x1A2338, hemiSky: 0x2A3B5E, hemiGnd: 0x141C14, hemiI: 0.30, env: 0.12, exp: 0.80 },
  { h: 4.5,  sun: 0x9FA0C8, sunI: 0.35, sky: 0x1B2440, fog: 0x2A3352, hemiSky: 0x35406A, hemiGnd: 0x1A231A, hemiI: 0.35, env: 0.18, exp: 0.85 },
  { h: 6.0,  sun: 0xFF8E4D, sunI: 1.40, sky: 0xE8794F, fog: 0xEFA477, hemiSky: 0xC98A6B, hemiGnd: 0x3F4A2E, hemiI: 0.50, env: 0.45, exp: 0.95 },
  { h: 7.5,  sun: 0xFFC98A, sunI: 2.40, sky: 0x8FC7E8, fog: 0xC3E0EF, hemiSky: 0x87CEEB, hemiGnd: 0x5AA83A, hemiI: 0.60, env: 0.85, exp: 1.05 },
  { h: 12.0, sun: 0xFFF2DE, sunI: 3.20, sky: 0x87CEEB, fog: 0xCFE8F2, hemiSky: 0x9AD4EE, hemiGnd: 0x5AA83A, hemiI: 0.70, env: 1.00, exp: 1.10 },
  { h: 16.0, sun: 0xFFE3B0, sunI: 2.60, sky: 0x8CC6E6, fog: 0xC8E2EF, hemiSky: 0x93CBE9, hemiGnd: 0x5AA83A, hemiI: 0.65, env: 0.90, exp: 1.05 },
  { h: 17.5, sun: 0xFFA24D, sunI: 1.80, sky: 0xE9A06B, fog: 0xEEB68C, hemiSky: 0xD9926B, hemiGnd: 0x4E5230, hemiI: 0.55, env: 0.60, exp: 1.00 },
  { h: 19.0, sun: 0xFF6A33, sunI: 0.90, sky: 0xF4845F, fog: 0xE38B62, hemiSky: 0xB06A55, hemiGnd: 0x33321F, hemiI: 0.45, env: 0.35, exp: 0.95 },
  { h: 20.5, sun: 0x7C8FC9, sunI: 0.35, sky: 0x2C3E50, fog: 0x36485C, hemiSky: 0x33456A, hemiGnd: 0x18201A, hemiI: 0.35, env: 0.18, exp: 0.85 },
  { h: 24.0, sun: 0x8FA8DC, sunI: 0.30, sky: 0x0E1526, fog: 0x1A2338, hemiSky: 0x2A3B5E, hemiGnd: 0x141C14, hemiI: 0.30, env: 0.12, exp: 0.80 },
];

/**
 * WeatherSystem - day/night cycle + weather states
 */
export class WeatherSystem {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.timeOfDay = GAME.startHour; // hours (0-24)
    this.weather = 'sunny'; // sunny, cloudy, rainy, windy
    this.weatherTimer = GAME.weatherCheckInterval;

    // Lighting references
    this.sunLight = null;
    this.hemisphereLight = null;

    // Preallocated Color instances for keyframe lerping (avoid per-frame allocation)
    this._cA = new THREE.Color();
    this._cB = new THREE.Color();
    this._sunColor = new THREE.Color();
    this._skyColor = new THREE.Color();
    this._fogColor = new THREE.Color();
    this._hemiSky = new THREE.Color();
    this._hemiGnd = new THREE.Color();

    // Rain particles
    this.rainGroup = null;
    this.rainDrops = [];

    // Wind particles
    this.windParticles = [];

    // Lens flare (simple sprite)
    this.lensFlare = null;

    this.scene.background = new THREE.Color();

    this._setupLighting();
    this._setupRain();
    this._setupWind();
    this._setupLensFlare();
  }

  _setupLighting() {
    // Sun/directional light
    this.sunLight = new THREE.DirectionalLight(0xFFEECC, 1.2);
    this.sunLight.position.set(30, 50, 20);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 150;
    this.sunLight.shadow.camera.left = -40;
    this.sunLight.shadow.camera.right = 40;
    this.sunLight.shadow.camera.top = 40;
    this.sunLight.shadow.camera.bottom = -40;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Hemisphere light (sky + ground bounce)
    this.hemisphereLight = new THREE.HemisphereLight(0x87CEEB, 0x5AA83A, 0.6);
    this.scene.add(this.hemisphereLight);
  }

  _setupRain() {
    this.rainGroup = new THREE.Group();
    this.rainGroup.visible = false;

    const rainGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(GAME.rainParticleCount * 3);
    const velocities = [];

    for (let i = 0; i < GAME.rainParticleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 80;
      positions[i * 3 + 1] = Math.random() * 30;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
      velocities.push({
        y: -15 - Math.random() * 10,
        x: 0,
      });
    }

    rainGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.rainVelocities = velocities;
    this.rainPositions = positions;

    const rainMat = new THREE.PointsMaterial({
      color: 0xAAAACC,
      size: 0.15,
      transparent: true,
      opacity: 0.6,
    });

    const rain = new THREE.Points(rainGeo, rainMat);
    this.rainGroup.add(rain);
    this.rainPoints = rain;
    this.scene.add(this.rainGroup);
  }

  _setupWind() {
    // Wind leaves/debris particles
    this.windGroup = new THREE.Group();
    this.windGroup.visible = false;

    for (let i = 0; i < 20; i++) {
      const leaf = new THREE.Mesh(
        new THREE.PlaneGeometry(0.15, 0.1),
        new THREE.MeshBasicMaterial({
          color: [0x228B22, 0x8B6914, 0x556B2F][i % 3],
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.8,
        })
      );
      leaf.position.set(
        (Math.random() - 0.5) * 60,
        Math.random() * 5 + 0.5,
        (Math.random() - 0.5) * 60
      );
      this.windGroup.add(leaf);
      this.windParticles.push({
        mesh: leaf,
        speed: 3 + Math.random() * 4,
        wobble: Math.random() * Math.PI * 2,
        height: leaf.position.y,
      });
    }
    this.scene.add(this.windGroup);
  }

  _setupLensFlare() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255, 240, 200, 0.8)');
    gradient.addColorStop(0.3, 'rgba(255, 200, 100, 0.3)');
    gradient.addColorStop(1, 'rgba(255, 200, 100, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.lensFlare = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending })
    );
    this.lensFlare.scale.set(15, 15, 1);
    this.lensFlare.visible = false;
    this.scene.add(this.lensFlare);
  }

  getTimeString() {
    const hours = Math.floor(this.timeOfDay);
    const minutes = Math.floor((this.timeOfDay % 1) * 60);
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h = hours > 12 ? hours - 12 : hours || 12;
    return `${h}:${minutes.toString().padStart(2, '0')} ${ampm}`;
  }

  getWeather() {
    return this.weather;
  }

  getWeatherIcon() {
    switch (this.weather) {
      case 'sunny': return '\u2600\uFE0F';
      case 'cloudy': return '\u2601\uFE0F';
      case 'rainy': return '\uD83C\uDF27\uFE0F';
      case 'windy': return '\uD83D\uDCA8';
      default: return '\u2600\uFE0F';
    }
  }

  getPeriod() {
    if (this.timeOfDay < GAME.morningEnd) return 'morning';
    if (this.timeOfDay < GAME.afternoonEnd) return 'afternoon';
    if (this.timeOfDay < GAME.eveningEnd) return 'evening';
    return 'night';
  }

  update(dt, playerPos) {
    // Advance time
    const hoursPerSecond = 24 / GAME.dayDurationSeconds;
    this.timeOfDay += hoursPerSecond * dt;
    if (this.timeOfDay >= 24) this.timeOfDay -= 24;

    // Weather timer
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      this.weatherTimer = GAME.weatherCheckInterval;
      if (Math.random() < GAME.weatherChangeProbability) {
        const weathers = ['sunny', 'sunny', 'cloudy', 'rainy', 'windy'];
        this.weather = weathers[Math.floor(Math.random() * weathers.length)];
      }
    }

    this._updateLighting(playerPos);
    this._updateRain(dt);
    this._updateWind(dt);
    this._updateLensFlare();
    this._updateSkyColor();
  }

  // Find the bracketing keyframes for hour t and return lerped values, using
  // the preallocated Color instances (no per-frame allocation).
  _sampleToD(t) {
    const keys = TOD_KEYS;
    let i = 0;
    while (i < keys.length - 2 && t >= keys[i + 1].h) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const f = (t - a.h) / (b.h - a.h);

    const sunColor = this._sunColor.copy(this._cA.setHex(a.sun)).lerp(this._cB.setHex(b.sun), f);
    const sky = this._skyColor.copy(this._cA.setHex(a.sky)).lerp(this._cB.setHex(b.sky), f);
    const fog = this._fogColor.copy(this._cA.setHex(a.fog)).lerp(this._cB.setHex(b.fog), f);
    const hemiSky = this._hemiSky.copy(this._cA.setHex(a.hemiSky)).lerp(this._cB.setHex(b.hemiSky), f);
    const hemiGnd = this._hemiGnd.copy(this._cA.setHex(a.hemiGnd)).lerp(this._cB.setHex(b.hemiGnd), f);

    return {
      sunColor,
      sunI: a.sunI + (b.sunI - a.sunI) * f,
      sky,
      fog,
      hemiSky,
      hemiGnd,
      hemiI: a.hemiI + (b.hemiI - a.hemiI) * f,
      env: a.env + (b.env - a.env) * f,
      exp: a.exp + (b.exp - a.exp) * f,
    };
  }

  _updateLighting(playerPos) {
    const t = this.timeOfDay;
    const k = this._sampleToD(t);

    // Sun 6-18; same light becomes the moon at night (mirrored arc; cool
    // color/intensity come from the keyframes)
    let angle;
    if (t >= 6 && t < 18) {
      angle = ((t - 6) / 12) * Math.PI;
    } else {
      const tn = t < 6 ? t + 24 : t; // 18..30
      angle = ((tn - 18) / 12) * Math.PI;
    }
    const px = playerPos ? playerPos.x : 0;
    const pz = playerPos ? playerPos.z : 0;
    this.sunLight.position.set(px + Math.cos(angle) * 40, Math.max(Math.sin(angle) * 50, 8), pz + 20);
    this.sunLight.target.position.set(px, 0, pz);

    let sunI = k.sunI, hemiI = k.hemiI, envI = k.env, exp = k.exp;
    if (this.weather === 'cloudy')     { sunI *= 0.35; hemiI *= 1.15; envI *= 0.7; exp -= 0.05; }
    else if (this.weather === 'rainy') { sunI *= 0.20; hemiI *= 0.9;  envI *= 0.5; exp -= 0.10; }

    this.sunLight.color.copy(k.sunColor);
    this.sunLight.intensity = sunI;
    this.hemisphereLight.color.copy(k.hemiSky);
    this.hemisphereLight.groundColor.copy(k.hemiGnd);
    this.hemisphereLight.intensity = hemiI;
    this.scene.environmentIntensity = envI;
    this.renderer.toneMappingExposure = exp;
  }

  _updateSkyColor() {
    const k = this._sampleToD(this.timeOfDay);

    if (this.weather === 'cloudy' || this.weather === 'rainy') {
      k.sky.lerp(this._cA.setHex(0x8899AA), 0.5);
      k.fog.lerp(this._cA.setHex(0x8899AA), 0.5);
    }

    this.scene.background.copy(k.sky);
    this.scene.fog.color.copy(k.fog);
  }

  _updateRain(dt) {
    const isRaining = this.weather === 'rainy';
    this.rainGroup.visible = isRaining;

    if (!isRaining) return;

    const positions = this.rainPoints.geometry.attributes.position.array;
    for (let i = 0; i < GAME.rainParticleCount; i++) {
      positions[i * 3 + 1] += this.rainVelocities[i].y * dt;
      positions[i * 3] += this.rainVelocities[i].x * dt;

      if (positions[i * 3 + 1] < 0) {
        positions[i * 3] = (Math.random() - 0.5) * 80;
        positions[i * 3 + 1] = 25 + Math.random() * 5;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
      }
    }
    this.rainPoints.geometry.attributes.position.needsUpdate = true;
  }

  _updateWind(dt) {
    const isWindy = this.weather === 'windy';
    this.windGroup.visible = isWindy;

    if (!isWindy) return;

    for (const p of this.windParticles) {
      p.mesh.position.x += p.speed * dt;
      p.wobble += dt * 3;
      p.mesh.position.y = p.height + Math.sin(p.wobble) * 0.5;
      p.mesh.rotation.z += dt * 5;

      if (p.mesh.position.x > 40) {
        p.mesh.position.x = -40;
        p.mesh.position.z = (Math.random() - 0.5) * 60;
      }
    }
  }

  _updateLensFlare() {
    const t = this.timeOfDay;
    const showFlare = this.weather === 'sunny' && ((t > 6 && t < 9) || (t > 16 && t < 19));

    this.lensFlare.visible = showFlare;
    if (showFlare) {
      this.lensFlare.position.copy(this.sunLight.position);
      const flareIntensity = t < 9 ? (9 - t) / 3 : (t - 16) / 3;
      this.lensFlare.material.opacity = Math.min(0.6, flareIntensity * 0.6);
    }
  }
}
