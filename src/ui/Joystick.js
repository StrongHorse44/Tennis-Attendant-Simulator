/**
 * Virtual Joystick - touch-friendly movement controller
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
    this.knobRadius = 25;

    this._create();
    this._setupEvents();
  }

  _create() {
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      position: 'fixed',
      bottom: '30px',
      left: '30px',
      width: '120px',
      height: '120px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.15)',
      border: '2px solid rgba(255,255,255,0.3)',
      touchAction: 'none',
      zIndex: '100',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });

    this.knob = document.createElement('div');
    Object.assign(this.knob.style, {
      width: '50px',
      height: '50px',
      borderRadius: '50%',
      background: 'rgba(255,255,255,0.5)',
      position: 'absolute',
      transition: 'none',
      pointerEvents: 'none',
    });

    this.container.appendChild(this.knob);
    document.getElementById('ui-root').appendChild(this.container);
  }

  _setupEvents() {
    this.container.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (this.active) return;
      const touch = e.changedTouches[0];
      this.touchId = touch.identifier;
      this.active = true;
      this.input.joystickActive = true;
      const rect = this.container.getBoundingClientRect();
      this.centerX = rect.left + rect.width / 2;
      this.centerY = rect.top + rect.height / 2;
      this._updateKnob(touch.clientX, touch.clientY);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!this.active) return;
      for (const touch of e.changedTouches) {
        if (touch.identifier === this.touchId) {
          e.preventDefault();
          this._updateKnob(touch.clientX, touch.clientY);
          break;
        }
      }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === this.touchId) {
          this.active = false;
          this.touchId = null;
          this.input.joystickActive = false;
          this.input.moveInput.x = 0;
          this.input.moveInput.y = 0;
          this.knob.style.transform = 'translate(-50%, -50%)';
          this.knob.style.left = '50%';
          this.knob.style.top = '50%';
          break;
        }
      }
    });

    // Mouse fallback for desktop testing
    this.container.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.active = true;
      this.input.joystickActive = true;
      const rect = this.container.getBoundingClientRect();
      this.centerX = rect.left + rect.width / 2;
      this.centerY = rect.top + rect.height / 2;
      this._updateKnob(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      this._updateKnob(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => {
      if (!this.active) return;
      this.active = false;
      this.input.joystickActive = false;
      this.input.moveInput.x = 0;
      this.input.moveInput.y = 0;
      this.knob.style.left = '50%';
      this.knob.style.top = '50%';
      this.knob.style.transform = 'translate(-50%, -50%)';
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

    const normX = dx / maxDist;
    const normY = dy / maxDist;

    this.input.moveInput.x = normX;
    this.input.moveInput.y = normY;

    const pctX = ((dx + maxDist) / (maxDist * 2)) * 100;
    const pctY = ((dy + maxDist) / (maxDist * 2)) * 100;
    this.knob.style.left = pctX + '%';
    this.knob.style.top = pctY + '%';
    this.knob.style.transform = 'translate(-50%, -50%)';
  }
}
