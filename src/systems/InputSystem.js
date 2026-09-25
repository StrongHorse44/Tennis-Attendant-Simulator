/** Keys that trigger the world action button / advance dialogue. */
const ACTION_KEYS = new Set(['Space', 'KeyE', 'Enter', 'NumpadEnter']);
/** Keys that toggle the pause menu. */
const PAUSE_KEYS = new Set(['Escape', 'KeyP']);
/** Keyboard camera rotation (Q / R) in drag-pixels per second (was 4 px per frame at 60 fps). */
const KEY_CAMERA_RATE = 240;

/**
 * InputSystem - handles touch joystick, tap interactions, camera rotation, keyboard fallback
 *
 * Public state/API used elsewhere:
 *   moveInput, joystickActive (written by Joystick), cameraRotationDelta, wasDragging,
 *   getMoveDirection(), isActionJustPressed(), isActionHeld(), onTap(cb)
 * Added:
 *   enabled                 — false while paused: gameplay key presses are ignored
 *   onPauseToggle(cb)       — Esc / P (fires even while disabled)
 *   onChoiceKey(cb)         — digit keys 1-9 → cb(index) (dialogue choices)
 *   onKeyPress(code, cb)    — one-shot gameplay key (e.g. 'KeyC' groom camera); ignored while disabled
 *   consumeAction()         — swallow the current action press (no world action this frame)
 *   resetState()            — clear held keys / edges / camera delta (pause, blur, resume)
 *   update(dt)              — dt optional (keyboard camera rotation is now frame-rate independent)
 */
export class InputSystem {
  constructor() {
    this.moveInput = { x: 0, y: 0 };
    this._moveOut = { x: 0, y: 0 };
    this.joystickActive = false;

    this.enabled = true;

    this.actionPressed = false;
    this.actionJustPressed = false;
    this._actionPrev = false;
    this._actionConsumed = false;
    this._actionLatched = false; // a press seen since the last update (catches down+up within one frame)

    this.tapCallbacks = [];
    this.pauseCallbacks = [];
    this.choiceCallbacks = [];
    this.keyCallbacks = new Map(); // code -> [cb]

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
      if (PAUSE_KEYS.has(e.code)) {
        if (e.repeat) return;
        // Let form controls keep P; Escape always toggles
        if (e.code === 'KeyP' && e.target && e.target.tagName === 'INPUT' && e.target.type === 'text') return;
        e.preventDefault();
        for (const cb of this.pauseCallbacks) cb(e.code);
        return;
      }
      if (!this.enabled) return; // paused: the pause menu owns the keyboard

      // Enter on a focused control (e.g. the HUD action button after a mouse click)
      // is that control's native activation — it already runs the action once, so
      // don't also latch a world action for the next frame.
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && e.target instanceof Element &&
          e.target.closest('button, a[href], input, select, textarea, [role="button"]')) return;

      this.keys[e.code] = true;
      if (ACTION_KEYS.has(e.code)) {
        if (!e.repeat) this._actionLatched = true;
        this.actionPressed = true;
        if (e.code === 'Space') e.preventDefault(); // no page scroll / button re-activation
      }
      if (!e.repeat && this.keyCallbacks.has(e.code) &&
          !(e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))) {
        for (const cb of this.keyCallbacks.get(e.code)) cb(e.code);
      }
      if (!e.repeat && e.code.startsWith('Digit')) {
        const n = e.code.charCodeAt(5) - 49; // Digit1 → 0
        if (n >= 0 && n <= 8) for (const cb of this.choiceCallbacks) cb(n);
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (ACTION_KEYS.has(e.code)) {
        // Only release if no other action key is still held
        let held = false;
        for (const k of ACTION_KEYS) if (this.keys[k]) { held = true; break; }
        this.actionPressed = held;
      }
    });
    // Losing focus (alt-tab, tab hidden) never delivers keyup → clear to avoid stuck keys
    window.addEventListener('blur', () => this.resetState());
  }

  _setupCameraTouch() {
    const canvas = document.getElementById('game-canvas');
    if (!canvas) return;

    canvas.addEventListener('touchstart', (e) => {
      if (!this.enabled) return;
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
          if (this.enabled) this.cameraRotationDelta += dx;
          this._cameraTouchLastX = touch.clientX;
          this._cameraDragDist += Math.abs(dx);
          break;
        }
      }
    }, { passive: true });

    const endTouch = (e, cancelled) => {
      for (const touch of e.changedTouches) {
        if (touch.identifier === this._cameraTouchId) {
          // Short tap with no significant drag → treat as interaction tap
          if (!cancelled && this.enabled && this._cameraDragDist < 10) {
            this._fireTap(this._cameraTouchStartX, this._cameraTouchStartY);
          }
          this._cameraTouchId = null;
          break;
        }
      }
    };
    canvas.addEventListener('touchend', (e) => endTouch(e, false));
    canvas.addEventListener('touchcancel', (e) => endTouch(e, true));
  }

  _setupMouseCamera() {
    const canvas = document.getElementById('game-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this._mouseDown = true;
      this._mouseLastX = e.clientX;
      this._mouseDragDist = 0;
      this.wasDragging = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._mouseDown) return;
      const dx = e.clientX - this._mouseLastX;
      if (this.enabled) this.cameraRotationDelta += dx;
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

  /** Esc / P pressed (receives the key code). Fires even while input is disabled. */
  onPauseToggle(callback) {
    this.pauseCallbacks.push(callback);
  }

  /** Digit key 1-9 pressed while enabled → callback(index 0-8). */
  onChoiceKey(callback) {
    this.choiceCallbacks.push(callback);
  }

  /** Register a one-shot key handler (no repeats; not fired while input is disabled). */
  onKeyPress(code, callback) {
    if (!this.keyCallbacks.has(code)) this.keyCallbacks.set(code, []);
    this.keyCallbacks.get(code).push(callback);
  }

  _fireTap(x, y) {
    for (const cb of this.tapCallbacks) {
      cb(x, y);
    }
  }

  /** Enable/disable gameplay input (pause). Disabling clears held state. */
  setEnabled(on) {
    on = !!on;
    if (this.enabled === on) return;
    this.enabled = on;
    this.resetState();
  }

  /** Clear held keys, action edges and pending camera rotation. */
  resetState() {
    for (const k in this.keys) this.keys[k] = false;
    this.actionPressed = false;
    this.actionJustPressed = false;
    this._actionPrev = false;
    this._actionConsumed = false;
    this._actionLatched = false;
    this.cameraRotationDelta = 0;
    this._mouseDown = false;
    this._cameraTouchId = null;
    if (!this.joystickActive) {
      this.moveInput.x = 0;
      this.moveInput.y = 0;
    }
  }

  /** Swallow the current action press so nothing else reacts to it this frame. */
  consumeAction() {
    this.actionJustPressed = false;
    this._actionConsumed = true;
  }

  update(dt = 1 / 60) {
    this.actionJustPressed = (this.actionPressed && !this._actionPrev) || this._actionLatched;
    this._actionPrev = this.actionPressed;
    this._actionLatched = false;
    this._actionConsumed = false;

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

    // Keyboard camera rotation (Q / R)
    if (this.keys['KeyQ']) {
      this.cameraRotationDelta -= KEY_CAMERA_RATE * dt;
    }
    if (this.keys['KeyR']) {
      this.cameraRotationDelta += KEY_CAMERA_RATE * dt;
    }
  }

  /** Current move direction. Returns a reused object — copy it if you need to keep it. */
  getMoveDirection() {
    this._moveOut.x = this.moveInput.x;
    this._moveOut.y = this.moveInput.y;
    return this._moveOut;
  }

  isActionJustPressed() {
    return this.actionJustPressed && !this._actionConsumed;
  }

  isActionHeld() {
    return this.actionPressed;
  }

  dispose() {
    this.tapCallbacks = [];
    this.pauseCallbacks = [];
    this.choiceCallbacks = [];
  }
}
