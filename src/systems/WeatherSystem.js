import * as THREE from 'three';
import { COLORS, GAME } from '../utils/Constants.js';

/**
 * WeatherSystem - day/night cycle + weather states
 */
export class WeatherSystem {
  constructor(scene) {
    this.scene = scene;
    this.timeOfDay = GAME.startHour; // hours (0-24)
    this.weather = 'sunny'; // sunny, cloudy, rainy, windy
    this.weatherTimer = GAME.weatherCheckInterval;

    // Lighting references
    this.sunLight = null;
    this.ambientLight = null;
    this.hemisphereLight = null;

    // Rain particles
    this.rainGroup = null;
    this.rainDrops = [];

    // Wind particles
    this.windParticles = [];

    // Lens flare (simple sprite)
    this.lensFlare = null;

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
    this.sunLight.shadow.camera.left = -60;
    this.sunLight.shadow.camera.right = 60;
    this.sunLight.shadow.camera.top = 60;
    this.sunLight.shadow.camera.bottom = -60;
    this.scene.add(this.sunLight);

    // Ambient light
    this.ambientLight = new THREE.AmbientLight(0x6688AA, 0.4);
    this.scene.add(this.ambientLight);

    // Hemisphere light (sky + ground bounce)
    this.hemisphereLight = new THREE.HemisphereLight(0x87CEEB, 0x5AA83A, 0.3);
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

  update(dt) {
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

    this._updateLighting();
    this._updateRain(dt);
    this._updateWind(dt);
    this._updateLensFlare();
    this._updateSkyColor();
  }

  _updateLighting() {
    const t = this.timeOfDay;
    const period = this.getPeriod();

    // Sun position (arc across sky)
    const sunAngle = ((t - 6) / 12) * Math.PI; // sunrise at 6, sunset at 18
    const sunHeight = Math.sin(sunAngle) * 50;
    const sunX = Math.cos(sunAngle) * 40;

    this.sunLight.position.set(sunX, Math.max(sunHeight, 2), 20);

    // Light intensity based on time
    let intensity = 1.2;
    let ambientIntensity = 0.4;

    if (t < 6 || t > 20) {
      // Night
      intensity = 0.15;
      ambientIntensity = 0.15;
      this.sunLight.color.setHex(0x4466AA);
    } else if (t < 8) {
      // Dawn
      const dawn = (t - 6) / 2;
      intensity = 0.3 + dawn * 0.9;
      ambientIntensity = 0.2 + dawn * 0.2;
      this.sunLight.color.setHex(0xFFAA66);
    } else if (t > 18) {
      // Dusk
      const dusk = 1 - (t - 18) / 2;
      intensity = 0.3 + dusk * 0.9;
      ambientIntensity = 0.2 + dusk * 0.2;
      this.sunLight.color.setHex(0xFF8844);
    } else {
      // Daytime
      this.sunLight.color.setHex(0xFFEECC);
    }

    // Weather modifiers
    if (this.weather === 'cloudy') {
      intensity *= 0.6;
      ambientIntensity *= 1.2;
    } else if (this.weather === 'rainy') {
      intensity *= 0.4;
      ambientIntensity *= 1.0;
    }

    this.sunLight.intensity = intensity;
    this.ambientLight.intensity = ambientIntensity;
  }

  _updateSkyColor() {
    const t = this.timeOfDay;
    let skyColor;

    if (t < 6 || t > 20) {
      skyColor = new THREE.Color(COLORS.skyNight);
    } else if (t < 8) {
      const f = (t - 6) / 2;
      skyColor = new THREE.Color(COLORS.skyNight).lerp(new THREE.Color(COLORS.sky), f);
    } else if (t > 18) {
      const f = (t - 18) / 2;
      skyColor = new THREE.Color(COLORS.skyEvening).lerp(new THREE.Color(COLORS.skyNight), f);
    } else if (t > 16) {
      const f = (t - 16) / 2;
      skyColor = new THREE.Color(COLORS.sky).lerp(new THREE.Color(COLORS.skyEvening), f);
    } else {
      skyColor = new THREE.Color(COLORS.sky);
    }

    if (this.weather === 'cloudy' || this.weather === 'rainy') {
      skyColor.lerp(new THREE.Color(0x8899AA), 0.5);
    }

    this.scene.background = skyColor;
    this.scene.fog.color = skyColor;
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
