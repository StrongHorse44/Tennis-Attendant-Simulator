import { CameraTracker } from '../entities/CharacterModel.js';

/**
 * TennisAudio — sound for the after-hours mode, all through the shared SoundSystem (master
 * gain, mute, pause): racket and bounce pocks via playBallHit (distance-attenuated), a dull
 * thud for the net, and a cheap evening ambience (a few cricket chirps scheduled every
 * second or so — two short oscillator bursts, nothing continuous).
 */
export class TennisAudio {
  constructor(sound) {
    this.sound = sound;
    this.on = false;
    this._next = 0.8;
  }

  start() { this.on = true; this._next = 0.6; }
  stop() { this.on = false; }

  _vol(pos) {
    if (!CameraTracker.valid) return 0.8;
    const c = CameraTracker.position;
    const d = Math.sqrt((c.x - pos.x) ** 2 + (c.y - pos.y) ** 2 + (c.z - pos.z) ** 2);
    return Math.max(0, 1 - d / 60) ** 1.4;
  }

  hit(pos, k = 1) {
    const s = this.sound;
    if (s && s.playBallHit) s.playBallHit(Math.min(1, this._vol(pos) * 1.25 * k), 'hit');
  }

  bounce(pos) {
    const s = this.sound;
    if (s && s.playBallHit) s.playBallHit(this._vol(pos), 'bounce');
  }

  net(pos) {
    const s = this.sound;
    if (!s || !s.initialized || s.paused || s.muted) return;
    try {
      const ctx = s.ctx, now = ctx.currentTime;
      const v = 0.35 * this._vol(pos);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(140, now);
      o.frequency.exponentialRampToValueAtTime(70, now + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      o.connect(g); g.connect(s.masterGain);
      o.start(now); o.stop(now + 0.17);
    } catch (e) { /* audio is optional */ }
  }

  /**
   * Racket whoosh for a loaded swing: band-passed air noise whose pitch and loudness peak
   * `peakIn` seconds from now (the ball contact), louder and brighter with power.
   */
  whoosh(power = 1, peakIn = 0.16) {
    const s = this.sound;
    if (!s || !s.initialized || s.paused || s.muted) return;
    try {
      const ctx = s.ctx, now = ctx.currentTime;
      const p = Math.max(0, Math.min(1, power));
      if (!this._noise) {
        // Lightly smoothed noise: airy rather than hissy
        const n = Math.floor(ctx.sampleRate * 0.6);
        this._noise = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = this._noise.getChannelData(0);
        let b = 0;
        for (let i = 0; i < n; i++) { b = b * 0.35 + (Math.random() * 2 - 1) * 0.65; d[i] = b; }
      }
      const tp = now + Math.max(0.06, peakIn);
      const t1 = tp + 0.07 + 0.06 * (1 - p);
      const fPeak = (1100 + 1700 * p) * (0.94 + Math.random() * 0.12);
      const src = ctx.createBufferSource();
      src.buffer = this._noise;
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.4 + 1.2 * p;
      bp.frequency.setValueAtTime(fPeak * 0.35, now);
      bp.frequency.exponentialRampToValueAtTime(fPeak, tp);        // racket head accelerating
      bp.frequency.exponentialRampToValueAtTime(fPeak * 0.5, t1);  // and past the ear
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.06 + 0.16 * p, tp);
      g.gain.exponentialRampToValueAtTime(0.0001, t1);
      src.connect(bp); bp.connect(g); g.connect(s.masterGain);
      src.start(now, Math.random() * 0.2);
      src.stop(t1 + 0.02);
    } catch (e) { /* audio is optional */ }
  }

  /** Evening crickets: schedule a chirp now and then (no continuous nodes). */
  update(dt) {
    if (!this.on) return;
    this._next -= dt;
    if (this._next > 0) return;
    this._next = 0.7 + Math.random() * 1.6;
    const s = this.sound;
    if (!s || !s.initialized || s.paused || s.muted) return;
    try {
      const ctx = s.ctx, now = ctx.currentTime;
      const f = 4200 + Math.random() * 600;
      const n = 2 + Math.floor(Math.random() * 3);
      const vol = 0.012 + Math.random() * 0.01;
      for (let i = 0; i < n; i++) {
        const t0 = now + i * 0.075;
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f, t0);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
        o.connect(g); g.connect(s.masterGain);
        o.start(t0); o.stop(t0 + 0.06);
      }
    } catch (e) { /* ignore */ }
  }
}
