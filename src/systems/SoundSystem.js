/**
 * SoundSystem - procedural audio using Web Audio API
 * All public methods are wrapped in try-catch to prevent audio errors from crashing the game.
 */
/** Master gain at 100% volume (the original fixed level was 0.25). */
const BASE_MASTER_GAIN = 0.3;

export class SoundSystem {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.initialized = false;

    // Cart engine oscillators
    this.cartOsc = null;
    this.cartOsc2 = null;
    this.cartGainNode = null;
    this.cartFilter = null;

    // Ambient state
    this.ambientStarted = false;
    this.birdTimeoutId = null;

    // Volume / mute / pause (settable before the AudioContext exists; applied on init)
    this.volume = 0.8;          // 0..1 user master volume
    this.muted = false;
    this.paused = false;
    this.available = true;      // false if Web Audio failed to start
    this._wantCartEngine = false;

    // Auto-init on first user interaction (browser autoplay policy)
    this._boundInit = () => this._init();
    this._initEvents = ['touchstart', 'touchend', 'click', 'keydown', 'pointerdown'];
    for (const ev of this._initEvents) window.addEventListener(ev, this._boundInit, { once: true });
  }

  /** Effective master gain for the current volume / mute state. */
  _targetGain() {
    if (this.muted) return 0;
    const v = Math.max(0, Math.min(1, this.volume));
    return BASE_MASTER_GAIN * v;
  }

  _applyMasterGain(instant = false) {
    if (!this.masterGain || !this.ctx) return;
    try {
      const g = this._targetGain();
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      if (instant) this.masterGain.gain.setValueAtTime(g, now);
      else this.masterGain.gain.setTargetAtTime(g, now, 0.03);
    } catch (e) { /* ignore */ }
  }

  /** Master volume 0..1. Works before the AudioContext exists. */
  setMasterVolume(v) {
    const n = Number(v);
    this.volume = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : this.volume;
    this._applyMasterGain();
  }

  getMasterVolume() {
    return this.volume;
  }

  setMuted(m) {
    this.muted = !!m;
    this._applyMasterGain();
  }

  isMuted() {
    return this.muted;
  }

  /** True once audio has started (after the first user gesture). */
  isReady() {
    return this.initialized;
  }

  /**
   * Pause/resume all audio (suspends the AudioContext so the cart engine, ambient
   * and any scheduled sounds freeze in place).
   */
  setPaused(p) {
    this.paused = !!p;
    if (!this.ctx) return;
    try {
      if (this.paused) {
        if (this.ctx.state === 'running') this.ctx.suspend();
      } else if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }
    } catch (e) { /* ignore */ }
  }

  _init() {
    if (this.initialized) return;
    for (const ev of this._initEvents) window.removeEventListener(ev, this._boundInit);
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('Web Audio API not supported');
      this.ctx = new Ctx();
      // Resume context for mobile browsers that start in suspended state
      if (this.ctx.state === 'suspended' && !this.paused) {
        this.ctx.resume();
      } else if (this.paused && this.ctx.state === 'running') {
        this.ctx.suspend();
      }
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this._targetGain();
      this.masterGain.connect(this.ctx.destination);
      this.initialized = true;
      this.available = true;
      this.startAmbient();
      if (this._wantCartEngine) this.startCartEngine();
    } catch (e) {
      // Audio not available — game continues without sound
      this.initialized = false;
      this.available = false;
      console.warn('Sound disabled:', e && e.message ? e.message : e);
    }
  }

  playFootstep() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      const bufferSize = 1024;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() - 0.5) * Math.exp(-i / 150);
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 600 + Math.random() * 200;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      source.start(now);
      source.stop(now + 0.12);
    } catch (e) { /* ignore audio errors */ }
  }

  startCartEngine() {
    this._wantCartEngine = true;
    if (!this.initialized || this.cartOsc) return;
    try {
      const now = this.ctx.currentTime;

      this.cartOsc = this.ctx.createOscillator();
      this.cartOsc.type = 'sawtooth';
      this.cartOsc.frequency.value = 55;

      this.cartOsc2 = this.ctx.createOscillator();
      this.cartOsc2.type = 'triangle';
      this.cartOsc2.frequency.value = 82;

      this.cartFilter = this.ctx.createBiquadFilter();
      this.cartFilter.type = 'lowpass';
      this.cartFilter.frequency.value = 150;

      this.cartGainNode = this.ctx.createGain();
      this.cartGainNode.gain.setValueAtTime(0.03, now);

      this.cartOsc.connect(this.cartFilter);
      this.cartOsc2.connect(this.cartFilter);
      this.cartFilter.connect(this.cartGainNode);
      this.cartGainNode.connect(this.masterGain);

      this.cartOsc.start(now);
      this.cartOsc2.start(now);
    } catch (e) {
      // Clean up on error
      this.cartOsc = null;
      this.cartOsc2 = null;
      this.cartGainNode = null;
      this.cartFilter = null;
    }
  }

  updateCartEngine(speed) {
    if (!this.cartOsc || !this.cartGainNode || !this.cartFilter) return;
    try {
      const freq = 55 + speed * 3;
      this.cartOsc.frequency.value = freq;
      this.cartOsc2.frequency.value = freq * 1.5;
      this.cartFilter.frequency.value = 150 + speed * 20;
      this.cartGainNode.gain.value = Math.min(0.06, 0.02 + speed * 0.005);
    } catch (e) { /* ignore audio errors */ }
  }

  stopCartEngine() {
    this._wantCartEngine = false;
    if (!this.cartOsc) return;
    try {
      const now = this.ctx.currentTime;
      if (this.cartGainNode) {
        this.cartGainNode.gain.setValueAtTime(this.cartGainNode.gain.value, now);
        this.cartGainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      }
      const osc1 = this.cartOsc;
      const osc2 = this.cartOsc2;
      this.cartOsc = null;
      this.cartOsc2 = null;
      this.cartGainNode = null;
      this.cartFilter = null;
      setTimeout(() => {
        try { osc1.stop(); } catch (e) { /* ignore */ }
        try { osc2.stop(); } catch (e) { /* ignore */ }
      }, 350);
    } catch (e) {
      this.cartOsc = null;
      this.cartOsc2 = null;
      this.cartGainNode = null;
      this.cartFilter = null;
    }
  }

  playCartEnter() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      const bufferSize = 4096;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() - 0.5) * (i / bufferSize) * Math.exp(-i / 2000);
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(300, now);
      filter.frequency.exponentialRampToValueAtTime(1200, now + 0.15);
      filter.Q.value = 2;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      source.start(now);
      source.stop(now + 0.2);
    } catch (e) { /* ignore audio errors */ }
  }

  playUIClick() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.06);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.06);
    } catch (e) { /* ignore audio errors */ }
  }

  playPickup() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(800, now + 0.15);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.25);
    } catch (e) { /* ignore audio errors */ }
  }

  playNotification() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      const notes = [660, 880];
      notes.forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        const gain = this.ctx.createGain();
        const start = now + i * 0.12;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.06, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.25);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + 0.25);
      });
    } catch (e) { /* ignore audio errors */ }
  }

  playBrushScrape() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      // Noise burst filtered to sound like bristles on clay
      const bufferSize = 2048;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() - 0.5) * Math.exp(-i / 800);
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 400 + Math.random() * 200;
      filter.Q.value = 1.5;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.04, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      source.start(now);
      source.stop(now + 0.2);
    } catch (e) { /* ignore audio errors */ }
  }

  playBrushAttach() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      // Metallic clank for attaching brush
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.15);

      const osc2 = this.ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(150, now);
      osc2.frequency.exponentialRampToValueAtTime(60, now + 0.1);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

      osc.connect(gain);
      osc2.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc2.start(now);
      osc.stop(now + 0.2);
      osc2.stop(now + 0.2);
    } catch (e) { /* ignore audio errors */ }
  }

  playGroomComplete() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      // Ascending three-note chime for completion
      const notes = [523, 659, 784]; // C5, E5, G5
      notes.forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        const gain = this.ctx.createGain();
        const start = now + i * 0.15;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.08, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(start);
        osc.stop(start + 0.4);
      });
    } catch (e) { /* ignore audio errors */ }
  }

  /**
   * Continuous bristle scrape for the towed brush. `level` 0..1 (0 = silent, fades out),
   * `speed` 0..1 (normalised brush speed): pitch and loudness rise with speed.
   * Cheap to call every frame: parameters only change when the values move noticeably.
   */
  setBrushScrape(level, speed = 0) {
    if (!this.initialized) return;
    try {
      const lv = Math.max(0, Math.min(1, level || 0));
      const sp = Math.max(0, Math.min(1, speed || 0));
      if (!this._scrape) {
        if (lv <= 0) return;
        const ctx = this.ctx;
        const len = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        // Grainy noise with bristle "ticks" so it reads as dragging, not hiss
        let b = 0;
        for (let i = 0; i < len; i++) {
          b = b * 0.6 + (Math.random() - 0.5) * 0.8;
          data[i] = b + (Math.random() < 0.004 ? (Math.random() - 0.5) * 1.6 : 0);
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 380;
        bp.Q.value = 0.9;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 160;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(bp);
        bp.connect(hp);
        hp.connect(gain);
        gain.connect(this.masterGain);
        src.start();
        this._scrape = { src, bp, gain, lv: -1, sp: -1 };
      }
      const s = this._scrape;
      if (Math.abs(lv - s.lv) < 0.03 && Math.abs(sp - s.sp) < 0.03) return;
      s.lv = lv; s.sp = sp;
      const now = this.ctx.currentTime;
      s.gain.gain.setTargetAtTime(lv * (0.05 + 0.1 * sp), now, lv > 0 ? 0.06 : 0.12);
      s.bp.frequency.setTargetAtTime(260 + 620 * sp, now, 0.08);
      s.src.playbackRate.setTargetAtTime(0.75 + 0.6 * sp, now, 0.08);
    } catch (e) { /* ignore audio errors */ }
  }

  /** Sparkly chime when a court hits a grooming milestone: level 1 = excellent, 2 = perfect (100%). */
  playGroomChime(level = 1) {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;
      const notes = level >= 2 ? [784, 988, 1175, 1568, 1976] : [880, 1109, 1319];
      notes.forEach((freq, i) => {
        const start = now + i * 0.075;
        for (const [mult, type, amp] of [[1, 'sine', 0.07], [2.01, 'triangle', 0.02]]) {
          const osc = this.ctx.createOscillator();
          osc.type = type;
          osc.frequency.value = freq * mult;
          const gain = this.ctx.createGain();
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(amp, start + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0008, start + 0.9);
          osc.connect(gain);
          gain.connect(this.masterGain);
          osc.start(start);
          osc.stop(start + 0.92);
        }
      });
    } catch (e) { /* ignore audio errors */ }
  }

  playProximityWarning() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      // Short beep warning
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(660, now + 0.08);

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);
      osc.stop(now + 0.1);
    } catch (e) { /* ignore audio errors */ }
  }

  playCoolerSwap() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      // Water sloshing + thunk
      const bufferSize = 4096;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() - 0.5) * Math.sin(i * 0.05) * Math.exp(-i / 1500);
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      source.start(now);
      source.stop(now + 0.3);
    } catch (e) { /* ignore audio errors */ }
  }

  playTrashPickup() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;

      // Crinkle/rustle sound
      const bufferSize = 2048;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() - 0.5) * (1 + Math.sin(i * 0.1) * 0.5) * Math.exp(-i / 600);
      }

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 800;

      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      source.start(now);
      source.stop(now + 0.15);
    } catch (e) { /* ignore audio errors */ }
  }

  /** One enveloped oscillator note into the master gain (helper for jingles). */
  _note(freq, start, dur, peak, type = 'sine', dest = null) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(gain);
    gain.connect(dest || this.masterGain);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  /** Mission complete: a bright four-note fanfare (G-C-E-G) over a soft chord. */
  playMissionComplete() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;
      const lead = [392, 523.25, 659.25, 783.99];
      lead.forEach((f, i) => {
        const t = now + i * 0.09;
        this._note(f, t, i === 3 ? 0.7 : 0.22, 0.07, 'triangle');
        this._note(f * 2, t, 0.12, 0.018, 'sine');
      });
      const t = now + 0.27;
      for (const f of [261.63, 329.63, 392]) this._note(f, t, 0.9, 0.03, 'sine');
    } catch (e) { /* ignore audio errors */ }
  }

  /** Tip / pay: two quick bright "coin" blips. */
  playCoin() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;
      this._note(987.77, now, 0.08, 0.05, 'square');
      this._note(1318.51, now + 0.07, 0.35, 0.05, 'square');
    } catch (e) { /* ignore audio errors */ }
  }

  /** Walkie-talkie squelch + call beep for radio cards. */
  playRadioChirp() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;
      const n = Math.floor(this.ctx.sampleRate * 0.12);
      const buffer = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.8;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.05, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.masterGain);
      src.start(now);
      src.stop(now + 0.12);
      this._note(1200, now + 0.13, 0.09, 0.04, 'square');
      this._note(1600, now + 0.23, 0.12, 0.04, 'square');
    } catch (e) { /* ignore audio errors */ }
  }

  /** Rank up: rising arpeggio with a shimmer. */
  playRankUp() {
    if (!this.initialized) return;
    try {
      const now = this.ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
      notes.forEach((f, i) => this._note(f, now + i * 0.08, 0.5, 0.06, 'triangle'));
      for (let i = 0; i < 6; i++) this._note(2093 + i * 180, now + 0.45 + i * 0.04, 0.2, 0.012, 'sine');
    } catch (e) { /* ignore audio errors */ }
  }

  startAmbient() {
    if (!this.initialized || this.ambientStarted) return;
    this.ambientStarted = true;
    this._scheduleBirdChirp();
  }

  _scheduleBirdChirp() {
    const delay = 4000 + Math.random() * 8000;
    this.birdTimeoutId = setTimeout(() => {
      this._playBirdChirp();
      this._scheduleBirdChirp();
    }, delay);
  }

  _playBirdChirp() {
    // Skip while paused/muted so chirps don't queue up on a suspended context
    if (!this.initialized || this.paused || this.muted) return;
    try {
      const now = this.ctx.currentTime;

      const numNotes = 2 + Math.floor(Math.random() * 3);
      const baseFreq = 2000 + Math.random() * 2000;

      for (let i = 0; i < numNotes; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';

        const chirpStart = now + i * 0.08;
        const chirpLen = 0.04 + Math.random() * 0.06;
        const freq = baseFreq * (0.8 + Math.random() * 0.4);

        osc.frequency.setValueAtTime(freq, chirpStart);
        osc.frequency.exponentialRampToValueAtTime(
          freq * (0.7 + Math.random() * 0.6),
          chirpStart + chirpLen
        );

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, chirpStart);
        gain.gain.linearRampToValueAtTime(0.015, chirpStart + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.001, chirpStart + chirpLen);

        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.start(chirpStart);
        osc.stop(chirpStart + chirpLen);
      }
    } catch (e) { /* ignore audio errors */ }
  }

  /**
   * Tennis ball "pock" (MatchSystem). volume 0..1 is the caller's distance attenuation;
   * kind 'hit' = racket strike (bright), 'bounce' = court bounce (dull, softer).
   */
  playBallHit(volume = 1, kind = 'hit') {
    if (!this.initialized || this.paused || this.muted || !(volume > 0.01)) return;
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;
      if (!this._ballNoise) {
        const n = Math.floor(ctx.sampleRate * 0.05);
        this._ballNoise = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = this._ballNoise.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.12));
      }
      const hit = kind !== 'bounce';
      const v = Math.min(1, volume) * (hit ? 0.5 : 0.22);
      const len = hit ? 0.06 : 0.05;

      const src = ctx.createBufferSource();
      src.buffer = this._ballNoise;
      src.playbackRate.value = 0.9 + Math.random() * 0.2;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = (hit ? 1350 : 620) * (0.92 + Math.random() * 0.16);
      bp.Q.value = hit ? 2.2 : 1.6;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(v, now);
      ng.gain.exponentialRampToValueAtTime(0.001, now + len);
      src.connect(bp); bp.connect(ng); ng.connect(this.masterGain);
      src.start(now); src.stop(now + len);

      // hollow body of the ball
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const f0 = (hit ? 640 : 300) * (0.95 + Math.random() * 0.1);
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.6, now + len);
      const og = ctx.createGain();
      og.gain.setValueAtTime(v * 0.7, now);
      og.gain.exponentialRampToValueAtTime(0.001, now + len * 0.9);
      osc.connect(og); og.connect(this.masterGain);
      osc.start(now); osc.stop(now + len);
    } catch (e) { /* ignore audio errors */ }
  }
}
