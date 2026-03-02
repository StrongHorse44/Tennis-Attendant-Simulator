/**
 * SoundSystem - procedural audio using Web Audio API
 */
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

    // Auto-init on first user interaction (browser autoplay policy)
    this._boundInit = () => this._init();
    window.addEventListener('touchstart', this._boundInit, { once: true });
    window.addEventListener('click', this._boundInit, { once: true });
  }

  _init() {
    if (this.initialized) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.25;
      this.masterGain.connect(this.ctx.destination);
      this.initialized = true;
      this.startAmbient();
    } catch (e) {
      // Audio not available
    }
  }

  playFootstep() {
    if (!this.initialized) return;
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
  }

  startCartEngine() {
    if (!this.initialized || this.cartOsc) return;

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
  }

  updateCartEngine(speed) {
    if (!this.cartOsc) return;
    const freq = 55 + speed * 3;
    this.cartOsc.frequency.value = freq;
    this.cartOsc2.frequency.value = freq * 1.5;
    this.cartFilter.frequency.value = 150 + speed * 20;
    this.cartGainNode.gain.value = Math.min(0.06, 0.02 + speed * 0.005);
  }

  stopCartEngine() {
    if (!this.cartOsc) return;
    const now = this.ctx.currentTime;
    this.cartGainNode.gain.setValueAtTime(this.cartGainNode.gain.value, now);
    this.cartGainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    const osc1 = this.cartOsc;
    const osc2 = this.cartOsc2;
    this.cartOsc = null;
    this.cartOsc2 = null;
    this.cartGainNode = null;
    this.cartFilter = null;
    setTimeout(() => {
      osc1.stop();
      osc2.stop();
    }, 350);
  }

  playCartEnter() {
    if (!this.initialized) return;
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
  }

  playUIClick() {
    if (!this.initialized) return;
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
  }

  playPickup() {
    if (!this.initialized) return;
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
  }

  playNotification() {
    if (!this.initialized) return;
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
    if (!this.initialized) return;
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
  }
}
