import { injectTheme } from './theme.js';

const CSS = `
.cc-joy {
  position: fixed;
  left: calc(var(--cc-safe-left) + 24px);
  bottom: calc(var(--cc-safe-bottom) + 24px);
  width: 132px;
  height: 132px;
  border-radius: 50%;
  touch-action: none;
  z-index: 100;
  opacity: 0.55;
  transition: opacity 0.35s ease, transform 0.35s ease;
  -webkit-tap-highlight-color: transparent;
  cursor: grab;
}
.cc-joy::before {
  /* base ring */
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(circle, rgba(20, 38, 28, 0.10) 0 38%, rgba(20, 38, 28, 0.42) 39% 100%);
  border: 1.5px solid rgba(244, 232, 193, 0.34);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25), inset 0 0 0 7px rgba(244, 232, 193, 0.05);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}
.cc-joy::after {
  /* direction ticks */
  content: '';
  position: absolute;
  inset: 9px;
  border-radius: 50%;
  background:
    linear-gradient(rgba(244,232,193,0.45), rgba(244,232,193,0.45)) 50% 0 / 2px 7px no-repeat,
    linear-gradient(rgba(244,232,193,0.45), rgba(244,232,193,0.45)) 50% 100% / 2px 7px no-repeat,
    linear-gradient(rgba(244,232,193,0.45), rgba(244,232,193,0.45)) 0 50% / 7px 2px no-repeat,
    linear-gradient(rgba(244,232,193,0.45), rgba(244,232,193,0.45)) 100% 50% / 7px 2px no-repeat;
  pointer-events: none;
}
.cc-joy--idle { opacity: 0.38; }
.cc-joy--active { opacity: 1; cursor: grabbing; }
.cc-joy__knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 58px;
  height: 58px;
  margin: -29px 0 0 -29px;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #fffaf0 0%, #f4e8c1 45%, #d9c894 100%);
  border: 2px solid rgba(255, 255, 255, 0.55);
  box-shadow: 0 5px 14px rgba(0, 0, 0, 0.35), inset 0 -3px 6px rgba(120, 95, 40, 0.25);
  pointer-events: none;
  z-index: 1;
  will-change: transform;
  transition: box-shadow 0.2s ease;
}
.cc-joy__knob::after {
  content: '';
  position: absolute;
  inset: 17px;
  border-radius: 50%;
  border: 2px solid rgba(45, 90, 61, 0.35);
}
.cc-joy--active .cc-joy__knob {
  box-shadow: 0 5px 14px rgba(0, 0, 0, 0.35), 0 0 0 4px rgba(217, 164, 65, 0.35), inset 0 -3px 6px rgba(120, 95, 40, 0.25);
}
.cc-joy--return .cc-joy__knob { transition: transform 0.18s cubic-bezier(0.3, 1.4, 0.5, 1), box-shadow 0.2s ease; }
@media (hover: hover) and (pointer: fine) {
  .cc-joy--idle { opacity: 0.28; }
  .cc-joy:hover { opacity: 0.7; }
}
`;

let cssInjected = false;
function injectCSS() {
  if (cssInjected) return;
  cssInjected = true;
  const s = document.createElement('style');
  s.id = 'cc-joystick-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** Seconds of inactivity before the joystick fades back to its idle opacity. */
const IDLE_DELAY_MS = 2500;

/**
 * Virtual Joystick - touch-friendly movement controller.
 * Writes input.moveInput.{x,y} (−1..1) and input.joystickActive.
 */
export class Joystick {
  constructor(inputSystem) {
    this.input = inputSystem;
    this.container = null;
    this.knob = null;
    this.active = false;
    this.touchId = null;
    this.centerX = 0;
    this.centerY = 0;
    this.radius = 50;
    this.knobRadius = 29;
    this._idleTimer = null;

    injectTheme();
    injectCSS();
    this._create();
    this._setupEvents();
  }

  _create() {
    this.container = document.createElement('div');
    this.container.className = 'cc-joy cc-joy--idle';
    this.container.setAttribute('aria-hidden', 'true');

    this.knob = document.createElement('div');
    this.knob.className = 'cc-joy__knob';

    this.container.appendChild(this.knob);
    document.getElementById('ui-root').appendChild(this.container);
  }

  _begin(clientX, clientY) {
    this.active = true;
    this.input.joystickActive = true;
    const rect = this.container.getBoundingClientRect();
    this.centerX = rect.left + rect.width / 2;
    this.centerY = rect.top + rect.height / 2;
    // Travel radius scales with the rendered size (132px → 50px)
    this.radius = rect.width * 0.38 || 50;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    this.container.classList.remove('cc-joy--idle', 'cc-joy--return');
    this.container.classList.add('cc-joy--active');
    this._updateKnob(clientX, clientY);
  }

  _end() {
    this.active = false;
    this.touchId = null;
    this.input.joystickActive = false;
    this.input.moveInput.x = 0;
    this.input.moveInput.y = 0;
    this.container.classList.remove('cc-joy--active');
    this.container.classList.add('cc-joy--return');
    this.knob.style.transform = 'translate3d(0px, 0px, 0)';
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (!this.active) this.container.classList.add('cc-joy--idle');
    }, IDLE_DELAY_MS);
  }

  _setupEvents() {
    this.container.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (this.active) return;
      const touch = e.changedTouches[0];
      this.touchId = touch.identifier;
      this._begin(touch.clientX, touch.clientY);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!this.active || this.touchId === null) return;
      for (const touch of e.changedTouches) {
        if (touch.identifier === this.touchId) {
          e.preventDefault();
          this._updateKnob(touch.clientX, touch.clientY);
          break;
        }
      }
    }, { passive: false });

    const onTouchEnd = (e) => {
      if (this.touchId === null) return;
      for (const touch of e.changedTouches) {
        if (touch.identifier === this.touchId) {
          this._end();
          break;
        }
      }
    };
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);

    // Mouse fallback for desktop testing
    this._mouseActive = false;
    this.container.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._mouseActive = true;
      this._begin(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.active || !this._mouseActive) return;
      this._updateKnob(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => {
      if (!this.active || !this._mouseActive) return;
      this._mouseActive = false;
      this._end();
    });
  }

  _updateKnob(clientX, clientY) {
    let dx = clientX - this.centerX;
    let dy = clientY - this.centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = this.radius;

    if (dist > maxDist) {
      dx = (dx / dist) * maxDist;
      dy = (dy / dist) * maxDist;
    }

    this.input.moveInput.x = dx / maxDist;
    this.input.moveInput.y = dy / maxDist;

    this.knob.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
  }
}
