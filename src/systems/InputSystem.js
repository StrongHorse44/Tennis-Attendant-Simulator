import { GAME } from '../utils/Constants.js';

/**
 * InputSystem - handles touch joystick, tap interactions, camera rotation, keyboard fallback
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

    // Camera rotation (accumulated delta from touch/mouse drag)
    this.cameraRotationDelta = 0;
    this._cameraTouchId = null;
    this._cameraTouchLastX = 0;
    this._cameraTouchStartX = 0;
    this._cameraTouchStartY = 0;
    this._cameraDragDist = 0;

    // Mouse camera drag
    this._mouseDown = false;
    this._mouseLastX = 0;
    this._mouseDragDist = 0;
    this.wasDragging = false;

    this._setupKeyboard();
    this._setupCameraTouch();
    this._setupMouseCamera();
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

  _setupCameraTouch() {
    const canvas = document.getElementById('game-canvas');

    canvas.addEventListener('touchstart', (e) => {
      for (const touch of e.changedTouches) {
        // Right side of screen → camera rotation
        if (this._cameraTouchId === null && touch.clientX > window.innerWidth * 0.35) {
          this._cameraTouchId = touch.identifier;
          this._cameraTouchLastX = touch.clientX;
          this._cameraTouchStartX = touch.clientX;
          this._cameraTouchStartY = touch.clientY;
          this._cameraDragDist = 0;
          break;
        }
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === this._cameraTouchId) {
          const dx = touch.clientX - this._cameraTouchLastX;
          this.cameraRotationDelta += dx;
          this._cameraTouchLastX = touch.clientX;
          this._cameraDragDist += Math.abs(dx);
          break;
        }
      }
    }, { passive: true });

    canvas.addEventListener('touchend', (e) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === this._cameraTouchId) {
          // Short tap with no significant drag → treat as interaction tap
          if (this._cameraDragDist < 10) {
            this._fireTap(this._cameraTouchStartX, this._cameraTouchStartY);
          }
          this._cameraTouchId = null;
          break;
        }
      }
    });
  }

  _setupMouseCamera() {
    const canvas = document.getElementById('game-canvas');

    canvas.addEventListener('mousedown', (e) => {
      this._mouseDown = true;
      this._mouseLastX = e.clientX;
      this._mouseDragDist = 0;
      this.wasDragging = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._mouseDown) return;
      const dx = e.clientX - this._mouseLastX;
      this.cameraRotationDelta += dx;
      this._mouseLastX = e.clientX;
      this._mouseDragDist += Math.abs(dx);
    });

    window.addEventListener('mouseup', () => {
      if (!this._mouseDown) return;
      this._mouseDown = false;
      if (this._mouseDragDist > 5) {
        this.wasDragging = true;
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

    // Keyboard camera rotation (Q / E)
    if (this.keys['KeyQ']) {
      this.cameraRotationDelta -= 4;
    }
    if (this.keys['KeyR']) {
      this.cameraRotationDelta += 4;
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
