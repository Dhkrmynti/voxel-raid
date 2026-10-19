// On-screen controls for touch devices: a floating movement stick on the left, drag-to-look on
// the right, and action buttons. FIRE also aims while held, so one thumb can shoot and track.
const STICK_RADIUS = 52;
const DEADZONE = 0.18;

export class TouchControls {
  constructor(root, { onLook, onPause }) {
    this.root = root;
    this.onLook = onLook;
    this.onPause = onPause;
    this.stick = root.querySelector('#stick');
    this.knob = root.querySelector('#stick-knob');
    this.reset();

    this.track(root.querySelector('#stick-zone'), {
      down: (e) => {
        this.stickOrigin = { x: e.clientX, y: e.clientY };
        this.stick.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        this.stick.classList.add('active');
      },
      move: (e) => {
        let dx = e.clientX - this.stickOrigin.x;
        let dy = e.clientY - this.stickOrigin.y;
        const len = Math.hypot(dx, dy);
        if (len > STICK_RADIUS) {
          dx = (dx / len) * STICK_RADIUS;
          dy = (dy / len) * STICK_RADIUS;
        }
        this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
        const mag = Math.min(1, len / STICK_RADIUS);
        this.move = mag < DEADZONE ? { x: 0, z: 0 } : { x: dx / STICK_RADIUS, z: -dy / STICK_RADIUS };
      },
      up: () => {
        this.move = { x: 0, z: 0 };
        this.knob.style.transform = '';
        this.stick.classList.remove('active');
      },
    });

    const look = (e, last) => this.onLook(e.clientX - last.x, e.clientY - last.y);
    this.track(root.querySelector('#look-zone'), { move: look });
    this.track(root.querySelector('#btn-fire'), {
      down: () => (this.fire = true),
      move: look,
      up: () => (this.fire = false),
    });
    this.track(root.querySelector('#btn-jump'), { down: () => (this.jump = true), up: () => (this.jump = false) });
    this.track(root.querySelector('#btn-dash'), { down: () => (this.pending.dash = true) });
    this.track(root.querySelector('#btn-reload'), { down: () => (this.pending.reload = true) });
    this.track(root.querySelector('#btn-swap'), { down: () => (this.pending.cycle = true) });
    this.track(root.querySelector('#btn-pause'), { down: () => this.onPause() });
  }

  /** Follows one pointer from down to up on `el`, even if it slides off the element. */
  track(el, { down, move, up }) {
    let id = null;
    let last = null;
    el.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      e.preventDefault();
      id = e.pointerId;
      last = { x: e.clientX, y: e.clientY };
      try {
        el.setPointerCapture(id);
      } catch {
        // Pointer already released (or synthetic); tracking still works without capture.
      }
      el.classList.add('pressed');
      down?.(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      move?.(e, last);
      last = { x: e.clientX, y: e.clientY };
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('pressed');
      up?.(e);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  reset() {
    this.move = { x: 0, z: 0 };
    this.fire = false;
    this.jump = false;
    this.pending = { dash: false, reload: false, cycle: false };
  }

  /** Current stick/button state; one-shot buttons are cleared once read. */
  consume() {
    const out = { mx: this.move.x, mz: this.move.z, fire: this.fire, jump: this.jump, ...this.pending };
    this.pending = { dash: false, reload: false, cycle: false };
    return out;
  }
}
