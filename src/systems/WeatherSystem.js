import * as THREE from 'three';
import { GAME } from '../utils/Constants.js';
import { EnvState } from '../graphics/EnvState.js';
import { Quality } from '../graphics/Quality.js';
import { SkyDome, Stars, Clouds, Horizon } from '../graphics/Sky.js';
import { applyWetness, applyNightGlow } from '../graphics/Materials.js';

/**
 * WeatherSystem — day/night cycle, weather states, lighting, sky, shadows,
 * environment map, rain and wind. Writes the shared EnvState every frame.
 *
 * Public API (kept from the original): timeOfDay, weather, getTimeString(), getWeather(),
 * getWeatherIcon(), getPeriod(), update(dt).
 * New: setShadowFocus(vec3), setCamera(camera), setQuality(settings), setWeather(w, instant)
 */

// ─── Lighting keyframes (hour -> look). Colours are sRGB hex. ───
const KEYS = [
  { h: 0.0, sun: 0x9db4ff, sunI: 0.0, sky: 0x35466a, gnd: 0x16201a, hemiI: 0.6, top: 0x040918, hor: 0x16223e },
  { h: 4.8, sun: 0x9db4ff, sunI: 0.0, sky: 0x35466a, gnd: 0x16201a, hemiI: 0.6, top: 0x040918, hor: 0x16223e },
  { h: 5.6, sun: 0xff9d6b, sunI: 0.0, sky: 0x55648f, gnd: 0x2a2a22, hemiI: 1.1, top: 0x1d2f5e, hor: 0xb87a70 },
  { h: 6.3, sun: 0xffa060, sunI: 1.5, sky: 0x93a6cc, gnd: 0x5e6038, hemiI: 1.8, top: 0x3b62a8, hor: 0xf2a878 },
  { h: 7.5, sun: 0xffc98a, sunI: 2.5, sky: 0xd2c8b6, gnd: 0x5f7040, hemiI: 1.5, top: 0x4a86d0, hor: 0xf6cf9a },
  { h: 8.8, sun: 0xffd9a6, sunI: 2.6, sky: 0xc4d4e6, gnd: 0x66784a, hemiI: 1.6, top: 0x4583cc, hor: 0xf0dcbc },
  { h: 9.5, sun: 0xfff2e0, sunI: 2.7, sky: 0xbcdcff, gnd: 0x66844a, hemiI: 1.6, top: 0x3b7fd4, hor: 0xc6e2f6 },
  { h: 15.5, sun: 0xfff2e0, sunI: 2.7, sky: 0xbcdcff, gnd: 0x66844a, hemiI: 1.6, top: 0x3b7fd4, hor: 0xc6e2f6 },
  { h: 17.2, sun: 0xffd29a, sunI: 2.6, sky: 0xb2c8e8, gnd: 0x677445, hemiI: 1.8, top: 0x4a7fc8, hor: 0xf2d6ac },
  { h: 18.5, sun: 0xff9a55, sunI: 2.6, sky: 0xd2ae98, gnd: 0x6c5c3a, hemiI: 1.9, top: 0x3a4f90, hor: 0xf39a62 },
  { h: 19.2, sun: 0xff7a45, sunI: 0.6, sky: 0x8a7890, gnd: 0x3a3028, hemiI: 1.2, top: 0x26336e, hor: 0xc76a58 },
  { h: 20.0, sun: 0x9db4ff, sunI: 0.0, sky: 0x3a4a7a, gnd: 0x1a1e1a, hemiI: 0.9, top: 0x0c1430, hor: 0x3a3a5e },
  { h: 21.0, sun: 0x9db4ff, sunI: 0.0, sky: 0x35466a, gnd: 0x16201a, hemiI: 0.6, top: 0x040918, hor: 0x16223e },
  { h: 24.0, sun: 0x9db4ff, sunI: 0.0, sky: 0x35466a, gnd: 0x16201a, hemiI: 0.6, top: 0x040918, hor: 0x16223e },
].map(k => ({
  ...k,
  sunC: new THREE.Color(k.sun), skyC: new THREE.Color(k.sky), gndC: new THREE.Color(k.gnd),
  topC: new THREE.Color(k.top), horC: new THREE.Color(k.hor),
}));

const SUNRISE = 6.0;
const SUNSET = 19.3;
const MOON_DIR = new THREE.Vector3(-0.45, 0.78, 0.4).normalize();
const MOON_COLOR = new THREE.Color(0xaabbee);
const OVERCAST_TOP = new THREE.Color(0x8d99a8);
const OVERCAST_HOR = new THREE.Color(0xc4cad0);
const RAIN_TOP = new THREE.Color(0x646e7a);
const RAIN_HOR = new THREE.Color(0x8e969e);
const OVERCAST_SKYLIGHT = new THREE.Color(0xb4bcc6);
const CLOUD_WHITE = new THREE.Color(0xffffff);
const CLOUD_GREY = new THREE.Color(0xa3abb5);
const CLOUD_DARK = new THREE.Color(0x6c747e);

const WEATHER_TARGETS = {
  sunny: { overcast: 0, rain: 0, wind: 0.15, clouds: 0.45 },
  cloudy: { overcast: 0.7, rain: 0, wind: 0.35, clouds: 1 },
  rainy: { overcast: 1, rain: 1, wind: 0.55, clouds: 1 },
  windy: { overcast: 0.15, rain: 0, wind: 1.0, clouds: 0.65 },
};

const RAIN_MAX = 1600;
const RAIN_AREA = new THREE.Vector3(70, 32, 70);

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function approach(cur, target, rate, dt) {
  const d = target - cur;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

export class WeatherSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} [renderer]  enables env-map (PMREM) + exposure control
   */
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;
    this.timeOfDay = GAME.startHour; // hours (0-24)
    this.day = 1; // in-game day counter (increments at midnight)
    this.weather = 'sunny'; // sunny, cloudy, rainy, windy
    this.weatherTimer = GAME.weatherCheckInterval;

    // Lighting references
    this.sunLight = null;
    this.ambientLight = null;
    this.hemisphereLight = null;

    // Smoothed weather factors
    this._overcast = 0;
    this._rain = 0;
    this._wind = 0.15;
    this._cloudAmt = 0.45;
    this._wetness = 0;
    this._elapsed = 0;

    this.settings = Quality.settings;
    this.camera = null;
    this._focus = new THREE.Vector3();

    // temps (no per-frame allocations)
    this._c1 = new THREE.Color();
    this._c2 = new THREE.Color();
    this._tmpColor = new THREE.Color();
    this._cloudCol = new THREE.Color();
    this._keyDir = new THREE.Vector3();
    this._sunDir = new THREE.Vector3();
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._look = {
      sun: new THREE.Color(), sunI: 0, sky: new THREE.Color(), gnd: new THREE.Color(), hemiI: 1,
      top: new THREE.Color(), hor: new THREE.Color(),
    };

    // env map state
    this._pmrem = null;
    this._envRT = null;
    this._envLastT = -99;
    this._envLastO = -1;
    this._envCooldown = 0;

    this._setupLighting();
    this._setupSky();
    this._setupRain();
    this._setupWind();
    this.setQuality(this.settings);
    this._updateLighting(0);
  }

  // ───────────────────────────── setup ─────────────────────────────

  _setupLighting() {
    this.sunLight = new THREE.DirectionalLight(0xfff2e0, 3);
    this.sunLight.name = 'Sun';
    this.sunLight.position.set(30, 50, 20);
    this.sunLight.castShadow = true;
    const cam = this.sunLight.shadow.camera;
    cam.near = 1;
    cam.far = 220;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Tiny ambient floor so nothing is ever pitch black (kept for API compatibility)
    this.ambientLight = new THREE.AmbientLight(0x8899bb, 0.08);
    this.scene.add(this.ambientLight);

    this.hemisphereLight = new THREE.HemisphereLight(0xbcdcff, 0x66844a, 1.6);
    this.scene.add(this.hemisphereLight);
  }

  _setupSky() {
    this.sky = new SkyDome();
    this.scene.add(this.sky.mesh);
    this.stars = new Stars();
    this.scene.add(this.stars.points);
    this.clouds = new Clouds(15);
    this.scene.add(this.clouds.group);
    this.horizon = new Horizon();
    this.scene.add(this.horizon.group);

    this.scene.background = null; // sky dome covers everything
    if (!this.scene.fog) this.scene.fog = new THREE.Fog(0xc6e2f6, 80, 340);
  }

  _setupRain() {
    // GPU-animated rain streaks: zero CPU cost per frame (just uniforms).
    const pos = new Float32Array(RAIN_MAX * 2 * 3);
    const top = new Float32Array(RAIN_MAX * 2);
    for (let i = 0; i < RAIN_MAX; i++) {
      const x = Math.random() * RAIN_AREA.x;
      const y = Math.random() * RAIN_AREA.y;
      const z = Math.random() * RAIN_AREA.z;
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        pos[j * 3] = x; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z;
        top[j] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aTop', new THREE.BufferAttribute(top, 1));
    this.rainMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uFocus: { value: new THREE.Vector3() },
        uArea: { value: RAIN_AREA.clone() },
        uSpeed: { value: 22 },
        uWind: { value: new THREE.Vector2(0.15, 0.05) },
        uLength: { value: 0.9 },
        uColor: { value: new THREE.Color(0xc8d2e0) },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */`
        attribute float aTop;
        uniform float uTime, uSpeed, uLength;
        uniform vec3 uFocus, uArea;
        uniform vec2 uWind;
        varying float vA;
        void main() {
          float fall = mod(position.y - uTime * uSpeed, uArea.y);
          vec3 p;
          p.x = uFocus.x + (fract((position.x - uFocus.x) / uArea.x) - 0.5) * uArea.x;
          p.z = uFocus.z + (fract((position.z - uFocus.z) / uArea.z) - 0.5) * uArea.z;
          p.y = fall;
          p.xz += uWind * fall;
          vec3 dir = normalize(vec3(uWind.x, -1.0, uWind.y));
          p -= dir * uLength * aTop;
          vA = 1.0 - aTop * 0.8;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA *= smoothstep(60.0, 12.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vA;
        void main() {
          gl_FragColor = vec4(uColor, vA * uOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.rainPoints = new THREE.LineSegments(g, this.rainMaterial); // name kept for compatibility
    this.rainPoints.frustumCulled = false;
    this.rainPoints.renderOrder = 10;
    this.rainGroup = new THREE.Group();
    this.rainGroup.add(this.rainPoints);
    this.rainGroup.visible = false;
    this.scene.add(this.rainGroup);
  }

  _setupWind() {
    // Blowing leaves: one InstancedMesh (1 draw call)
    const count = 36;
    const geo = new THREE.PlaneGeometry(0.18, 0.11);
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.9 });
    this.windMesh = new THREE.InstancedMesh(geo, mat, count);
    this.windMesh.frustumCulled = false;
    const cols = [0x3f7f2f, 0x9a7a2a, 0x6b7f35, 0xb0662e];
    const c = new THREE.Color();
    this.windParticles = [];
    for (let i = 0; i < count; i++) {
      this.windMesh.setColorAt(i, c.set(cols[i % cols.length]));
      this.windParticles.push({
        x: (Math.random() - 0.5) * 60,
        z: (Math.random() - 0.5) * 60,
        height: Math.random() * 4 + 0.4,
        speed: 3 + Math.random() * 4,
        wobble: Math.random() * Math.PI * 2,
        spin: Math.random() * Math.PI * 2,
      });
    }
    this.windMesh.instanceColor.needsUpdate = true;
    this.windGroup = new THREE.Group();
    this.windGroup.add(this.windMesh);
    this.windGroup.visible = false;
    this.scene.add(this.windGroup);
    this._wObj = new THREE.Object3D();
  }

  // ───────────────────────────── public API ─────────────────────────────

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
      case 'sunny': return EnvState.nightFactor > 0.5 ? '\uD83C\uDF19' : '\u2600\uFE0F'; // moon at night
      case 'cloudy': return '☁️';
      case 'rainy': return '🌧️';
      case 'windy': return '💨';
      default: return '☀️';
    }
  }

  getPeriod() {
    if (this.timeOfDay < GAME.morningEnd) return 'morning';
    if (this.timeOfDay < GAME.afternoonEnd) return 'afternoon';
    if (this.timeOfDay < GAME.eveningEnd) return 'evening';
    return 'night';
  }

  /** Serializable clock/weather state (save system). */
  getState() {
    return { timeOfDay: this.timeOfDay, day: this.day, weather: this.weather, weatherTimer: this.weatherTimer };
  }

  /** Restore clock/weather state; weather is applied instantly (no transition on load). */
  setState(s) {
    if (!s || typeof s !== 'object') return;
    if (Number.isFinite(s.timeOfDay)) this.timeOfDay = ((s.timeOfDay % 24) + 24) % 24;
    if (Number.isInteger(s.day) && s.day >= 1) this.day = s.day;
    if (Number.isFinite(s.weatherTimer) && s.weatherTimer > 0) {
      this.weatherTimer = Math.min(s.weatherTimer, GAME.weatherCheckInterval);
    }
    if (typeof s.weather === 'string' && WEATHER_TARGETS[s.weather]) this.setWeather(s.weather, true);
    this._envLastT = -99; // force env map refresh for the new time of day
  }

  /** Change weather; `instant` skips the smooth transition. */
  setWeather(w, instant = false) {
    if (!WEATHER_TARGETS[w]) return;
    this.weather = w;
    if (instant) {
      const T = WEATHER_TARGETS[w];
      this._overcast = T.overcast; this._rain = T.rain; this._wind = T.wind; this._cloudAmt = T.clouds;
      this._wetness = T.rain;
      this._envLastO = -1;
      // update() only resizes clouds when the rounded count changes between frames
      if (this.clouds) this.clouds.setCount(Math.round((this._maxClouds || 8) * this._cloudAmt));
    }
  }

  /** Point the shadow frustum, rain and leaves follow (player / cart / camera target). */
  setShadowFocus(v) {
    this._focus.copy(v);
    EnvState.focus.copy(v);
  }

  /** Camera the sky dome / stars follow. */
  setCamera(camera) {
    this.camera = camera;
  }

  /** Apply a Quality settings object (shadow map size, env map, cloud count...). */
  setQuality(settings) {
    this.settings = settings;
    const L = this.sunLight;
    L.castShadow = !!settings.shadows;
    const size = settings.shadowMapSize || 1024;
    if (L.shadow.mapSize.x !== size) {
      L.shadow.mapSize.set(size, size);
      if (L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; }
    }
    const e = settings.shadowExtent || 30;
    const cam = L.shadow.camera;
    cam.left = -e; cam.right = e; cam.top = e; cam.bottom = -e;
    cam.updateProjectionMatrix();
    const texel = (2 * e) / size;
    L.shadow.bias = -0.0003;
    L.shadow.normalBias = texel * 1.1;
    L.shadow.radius = 2;
    this._shadowTexel = texel;

    this.clouds.setCount(Math.round((settings.cloudCount || 8) * this._cloudAmt));
    this._maxClouds = settings.cloudCount || 8;

    if (!settings.envMap && this.scene.environment) {
      this.scene.environment = null;
      if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    }
    this._envLastO = -1; // force regen if enabled
    this.rainPoints.geometry.setDrawRange(0, Math.round(RAIN_MAX * (settings.rainDensity ?? 1)) * 2);
  }

  // ───────────────────────────── update ─────────────────────────────

  update(dt) {
    this._elapsed += dt;

    // Advance time
    const hoursPerSecond = 24 / GAME.dayDurationSeconds;
    this.timeOfDay += hoursPerSecond * dt;
    if (this.timeOfDay >= 24) { this.timeOfDay -= 24; this.day++; }
    if (this.timeOfDay < 0) this.timeOfDay += 24;

    // Weather timer
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      this.weatherTimer = GAME.weatherCheckInterval;
      if (Math.random() < GAME.weatherChangeProbability) {
        const weathers = ['sunny', 'sunny', 'cloudy', 'rainy', 'windy'];
        this.weather = weathers[Math.floor(Math.random() * weathers.length)];
      }
    }

    // Smooth weather factors toward targets
    const T = WEATHER_TARGETS[this.weather] || WEATHER_TARGETS.sunny;
    this._overcast = approach(this._overcast, T.overcast, 0.5, dt);
    this._rain = approach(this._rain, T.rain, 0.6, dt);
    this._wind = approach(this._wind, T.wind, 0.4, dt);
    const prevClouds = this._cloudAmt;
    this._cloudAmt = approach(this._cloudAmt, T.clouds, 0.2, dt);
    if (Math.round(prevClouds * this._maxClouds) !== Math.round(this._cloudAmt * this._maxClouds)) {
      this.clouds.setCount(Math.round(this._maxClouds * this._cloudAmt));
    }
    // wetness: ~10 s to soak, ~60 s to dry
    this._wetness = this._rain > 0.5
      ? approach(this._wetness, 1, 0.1, dt)
      : approach(this._wetness, 0, 1 / 60, dt);

    this._updateLighting(dt);
    this.clouds.update(dt, EnvState.windDirection, this._wind);
    this._updateRain(dt);
    this._updateWind(dt);
    this._updateEnvMap(dt);
  }

  _sampleKeys(t) {
    let i = 0;
    while (i < KEYS.length - 2 && t >= KEYS[i + 1].h) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const f = smoothstep(0, 1, (t - a.h) / (b.h - a.h));
    const L = this._look;
    L.sun.copy(a.sunC).lerp(b.sunC, f);
    L.sky.copy(a.skyC).lerp(b.skyC, f);
    L.gnd.copy(a.gndC).lerp(b.gndC, f);
    L.top.copy(a.topC).lerp(b.topC, f);
    L.hor.copy(a.horC).lerp(b.horC, f);
    L.sunI = a.sunI + (b.sunI - a.sunI) * f;
    L.hemiI = a.hemiI + (b.hemiI - a.hemiI) * f;
    return L;
  }

  _updateLighting(dt) {
    const t = this.timeOfDay;
    const o = this._overcast;
    const r = this._rain;
    const L = this._sampleKeys(t);

    // Sun path: rises in +X (east), sets in -X, arcs toward +Z (south)
    const a = ((t - SUNRISE) / (SUNSET - SUNRISE)) * Math.PI;
    const elev = Math.sin(a);
    this._sunDir.set(Math.cos(a), elev * 0.95, 0.5).normalize();

    const night = 1 - smoothstep(-0.1, 0.1, elev);
    const golden = smoothstep(0.0, 0.08, elev) * (1 - smoothstep(0.3, 0.6, elev));
    const lamp = Math.min(1, Math.max(1 - smoothstep(0.02, 0.22, elev), r * 0.35, o * 0.15));

    // Key light: sun or moon, whichever is brighter
    const sunI = L.sunI * smoothstep(-0.02, 0.06, elev) * (1 - 0.85 * o) * (1 - 0.15 * r);
    const moonI = 0.32 * night * (1 - 0.6 * o);
    const light = this.sunLight;
    if (sunI >= moonI) {
      this._keyDir.copy(this._sunDir);
      light.color.copy(L.sun).lerp(OVERCAST_SKYLIGHT, o * 0.6);
      light.intensity = sunI;
    } else {
      this._keyDir.copy(MOON_DIR);
      light.color.copy(MOON_COLOR);
      light.intensity = moonI;
    }
    // overcast: diffuse sky, so sun/moon shadows soften and fade
    light.shadow.intensity = Math.max(0.15, 1 - 0.85 * o);

    // Hemisphere fill (reduced when an env map supplies fill)
    const envOn = !!this.scene.environment;
    const day = 1 - night;
    this.hemisphereLight.color.copy(L.sky).lerp(this._c1.copy(OVERCAST_SKYLIGHT).multiplyScalar(0.25 + 0.75 * day), o * 0.7);
    this.hemisphereLight.groundColor.copy(L.gnd);
    this.hemisphereLight.intensity = L.hemiI * (1 - 0.2 * r) * (1 + 0.4 * o) * (envOn ? 0.35 : 1.0);
    if (envOn) this.scene.environmentIntensity = (0.45 + 0.1 * day + 0.8 * golden) * (1 - 0.25 * r) * (1 + 0.6 * o);

    // Sky colours
    const top = this._c1.copy(L.top);
    const hor = this._c2.copy(L.hor);
    const bright = 0.12 + 0.88 * day;
    if (o > 0) {
      const tc = this._tmpColor;
      tc.copy(OVERCAST_TOP).lerp(RAIN_TOP, r).multiplyScalar(bright);
      top.lerp(tc, o * 0.85);
      tc.copy(OVERCAST_HOR).lerp(RAIN_HOR, r).multiplyScalar(bright);
      hor.lerp(tc, o * 0.85);
    }
    const u = this.sky.u;
    u.uTop.value.copy(top);
    u.uHorizon.value.copy(hor);
    u.uGround.value.copy(hor).multiplyScalar(0.75);
    u.uSunDir.value.copy(this._sunDir);
    u.uSunColor.value.copy(L.sun);
    u.uMoonDir.value.copy(MOON_DIR);
    u.uSunDisc.value = (1 - o * 0.95) * smoothstep(-0.03, 0.02, elev);
    u.uSunGlow.value = (1 - o * 0.8) * (0.55 + 0.9 * golden) * smoothstep(-0.12, 0.02, elev);
    u.uMoon.value = night * (1 - o * 0.9);
    u.uHaze.value = o;
    // env-map zenith: warmed toward the hemisphere sky colour at golden hour
    this.sky.envMaterial.uniforms.uTop.value.copy(top).lerp(L.sky, 0.7 * golden * (1 - o));
    // env-map lower hemisphere = ground bounce (follows the hemisphere ground colour)
    this.sky.envMaterial.uniforms.uGround.value.copy(L.gnd).multiplyScalar(1.2);

    // Far hills: unfogged, tinted toward (never into) the horizon
    this.horizon.setHillTint(hor, L.sun, this._sunDir, day, Math.max(o, r));

    // Fog matched to horizon
    const fog = this.scene.fog;
    fog.color.copy(hor);
    fog.near = 80 - 30 * o - 25 * r;
    fog.far = 340 - 90 * o - 90 * r;

    // Clouds: lit by the scene lights + emissive sky fill
    this._cloudCol.copy(CLOUD_WHITE).lerp(CLOUD_GREY, o).lerp(CLOUD_DARK, r).multiplyScalar(0.12 + 0.88 * day);
    this.clouds.setColors(this._cloudCol, hor, 0.45 + 0.3 * o);

    // Stars
    if (this.camera) {
      this.sky.followCamera(this.camera);
      this.stars.update(this.camera, (this.settings.stars ? 1 : 0) * night * (1 - o) * (1 - o));
    }

    // Exposure: gentle lift at night for readability
    if (this.renderer) this.renderer.toneMappingExposure = 1.0 + 0.1 * night - 0.08 * r;

    // Shadow frustum follows focus with texel snapping
    this._updateShadowCamera();

    // Shared env state
    const E = EnvState;
    E.time = this._elapsed;
    E.timeOfDay = t;
    E.weather = this.weather;
    E.nightFactor = night;
    E.lampFactor = lamp;
    E.goldenFactor = golden;
    E.wetness = this._wetness;
    E.overcast = o;
    E.windStrength = this._wind;
    E.sunDirection.copy(this._sunDir);
    E.sunColor.copy(light.color);
    E.sunIntensity = light.intensity;
    E.skyTopColor.copy(top);
    E.horizonColor.copy(hor);

    applyWetness(this._wetness);
    applyNightGlow(lamp);
  }

  _updateShadowCamera() {
    const light = this.sunLight;
    const dir = this._keyDir;
    const f = this._tmpA.copy(this._focus);
    f.y = 0;
    // Light-space basis matching Object3D.lookAt for the shadow camera (up = +Y)
    const xAxis = this._tmpB.crossVectors(this._up, dir);
    if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0); else xAxis.normalize();
    const texel = this._shadowTexel || 0.05;
    const fx = f.dot(xAxis);
    const sx = Math.round(fx / texel) * texel - fx;
    f.addScaledVector(xAxis, sx);
    // y axis = dir x xAxis
    const yx = dir.y * xAxis.z - dir.z * xAxis.y;
    const yy = dir.z * xAxis.x - dir.x * xAxis.z;
    const yz = dir.x * xAxis.y - dir.y * xAxis.x;
    const fy = f.x * yx + f.y * yy + f.z * yz;
    const sy = Math.round(fy / texel) * texel - fy;
    f.x += yx * sy; f.y += yy * sy; f.z += yz * sy;

    light.target.position.copy(f);
    light.position.copy(f).addScaledVector(dir, 100);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
  }

  _updateRain(dt) {
    const r = this._rain;
    const on = r > 0.01;
    this.rainGroup.visible = on;
    if (!on) return;
    const u = this.rainMaterial.uniforms;
    u.uTime.value = this._elapsed;
    u.uFocus.value.copy(this._focus);
    u.uOpacity.value = 0.38 * r;
    u.uWind.value.set(0.08 + this._wind * 0.25, 0.03 + this._wind * 0.08);
    u.uColor.value.copy(this.sky.u.uHorizon.value).lerp(CLOUD_WHITE, 0.35);
  }

  _updateWind(dt) {
    const on = this.weather === 'windy' || this._wind > 0.7;
    this.windGroup.visible = on;
    if (!on) return;
    const fx = this._focus.x, fz = this._focus.z;
    const obj = this._wObj;
    for (let i = 0; i < this.windParticles.length; i++) {
      const p = this.windParticles[i];
      p.x += p.speed * dt;
      p.wobble += dt * 3;
      p.spin += dt * 5;
      if (p.x > 30) { p.x = -30; p.z = (Math.random() - 0.5) * 60; }
      obj.position.set(fx + p.x, p.height + Math.sin(p.wobble) * 0.5, fz + p.z);
      obj.rotation.set(p.wobble * 0.7, p.spin * 0.3, p.spin);
      obj.updateMatrix();
      this.windMesh.setMatrixAt(i, obj.matrix);
    }
    this.windMesh.instanceMatrix.needsUpdate = true;
  }

  /** Build scene.environment now (before shader pre-compilation: it's part of program keys). */
  prepareEnvironment() {
    this._envCooldown = 0;
    this._envLastT = -99;
    this._updateEnvMap(0);
  }

  _updateEnvMap(dt) {
    this._envCooldown -= dt;
    if (!this.renderer || !this.settings.envMap) return;
    let dT = Math.abs(this.timeOfDay - this._envLastT);
    if (dT > 12) dT = 24 - dT;
    const dO = Math.abs(this._overcast - this._envLastO);
    if (dT < 0.2 && dO < 0.08) return;
    // cooldown throttles gradual drift; a time jump (save load, debug) refreshes at once
    if (this._envCooldown > 0 && dT < 1) return;
    this._envCooldown = 1.0;
    this._envLastT = this.timeOfDay;
    this._envLastO = this._overcast;
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);
    // The env sky is a smooth gradient: render it with a persistent 64 px CubeCamera and
    // re-filter into the SAME PMREM target, so nothing is reallocated and
    // scene.environment keeps its identity (no per-material program re-evaluation).
    if (!this._envCube) {
      this._envCubeRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType, generateMipmaps: false });
      this._envCube = new THREE.CubeCamera(1, 100, this._envCubeRT);
    }
    this._envCube.update(this.renderer, this.sky.envScene);
    this._envRT = this._pmrem.fromCubemap(this._envCubeRT.texture, this._envRT);
    if (this.scene.environment !== this._envRT.texture) this.scene.environment = this._envRT.texture;
  }
}
