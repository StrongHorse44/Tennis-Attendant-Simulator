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
