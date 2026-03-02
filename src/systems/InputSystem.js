import { GAME } from '../utils/Constants.js';

/**
 * InputSystem - handles touch joystick, tap interactions, keyboard fallback
 */
export class InputSystem {
  constructor() {
    this.moveInput = { x: 0, y: 0 };
    this.isTouching = false;
    this.joystickActive = false;
    this.joystickCenter = { x: 0, y: 0 };
    this.joystickTouchId = null;

    this.actionPressed = false;
    this.actionJustPressed = false;
    this._actionPrev = false;

    this.tapPosition = null;
    this.tapCallbacks = [];

    // Keyboard state (desktop fallback)
    this.keys = {};

    this._setupKeyboard();
  }

  _setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'Space' || e.code === 'KeyE') {
        this.actionPressed = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (e.code === 'Space' || e.code === 'KeyE') {
        this.actionPressed = false;
      }
    });
  }

  onTap(callback) {
    this.tapCallbacks.push(callback);
  }

  _fireTap(x, y) {
    this.tapPosition = { x, y };
    for (const cb of this.tapCallbacks) {
      cb(x, y);
    }
  }

  update() {
    this.actionJustPressed = this.actionPressed && !this._actionPrev;
    this._actionPrev = this.actionPressed;

    // Keyboard movement (WASD / arrows)
    if (!this.joystickActive) {
      let kx = 0, ky = 0;
      if (this.keys['KeyW'] || this.keys['ArrowUp']) ky -= 1;
      if (this.keys['KeyS'] || this.keys['ArrowDown']) ky += 1;
      if (this.keys['KeyA'] || this.keys['ArrowLeft']) kx -= 1;
      if (this.keys['KeyD'] || this.keys['ArrowRight']) kx += 1;
      const len = Math.sqrt(kx * kx + ky * ky);
      if (len > 0) {
        this.moveInput.x = kx / len;
        this.moveInput.y = ky / len;
      } else {
        this.moveInput.x = 0;
        this.moveInput.y = 0;
      }
    }
  }

  getMoveDirection() {
    return { x: this.moveInput.x, y: this.moveInput.y };
  }

  isActionJustPressed() {
    return this.actionJustPressed;
  }

  isActionHeld() {
    return this.actionPressed;
  }

  dispose() {
    this.tapCallbacks = [];
  }
}
