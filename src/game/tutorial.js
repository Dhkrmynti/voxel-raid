// First-run tutorial: one hint at a time, each finished by actually doing it.
// Purely a view on top of the sim's state and events, so it never affects a replay.
const MIN_STEP_SEC = 2; // a step the player already did still shows long enough to read
const STEPS = [
  {
    text: { desktop: 'GERAK DENGAN W A S D', touch: 'GESER JOYSTICK DI KIRI UNTUK BERGERAK' },
    done: (p) => p.moved > 3,
  },
  {
    text: {
      desktop: 'BIDIK DENGAN MOUSE · KLIK UNTUK MENEMBAK',
      touch: 'GESER LAYAR KANAN UNTUK MEMBIDIK · TAHAN FIRE UNTUK MENEMBAK',
    },
    done: (p) => p.shots > 0,
  },
  {
    text: { desktop: 'TEMBAK KEPALA MUSUH = DAMAGE ×2', touch: 'TEMBAK KEPALA MUSUH = DAMAGE ×2' },
    done: (p) => p.crits > 0 || p.kills >= 3,
  },
  {
    text: { desktop: 'AMBIL KOIN EMAS · 1 KOIN = 1 TOKEN VXL', touch: 'AMBIL KOIN EMAS · 1 KOIN = 1 TOKEN VXL' },
    done: (p) => p.tokens > 0 || p.inStep > 14,
  },
  {
    text: { desktop: 'SHIFT = DASH · KEBAL SESAAT', touch: 'TOMBOL DASH = LARI CEPAT · KEBAL SESAAT' },
    done: (p) => p.dashes > 0 || p.inStep > 12,
  },
];

export class Tutorial {
  /**
   * @param {HTMLElement} el hint container with a .tutorial-text child and a .tutorial-skip button
   * @param {{ touch: boolean, onDone: () => void }} options
   */
  constructor(el, { touch, onDone }) {
    this.el = el;
    this.textEl = el.querySelector('.tutorial-text');
    this.device = touch ? 'touch' : 'desktop';
    this.onDone = onDone;
    this.step = 0;
    this.progress = { moved: 0, shots: 0, crits: 0, kills: 0, tokens: 0, dashes: 0, inStep: 0 };
    this.last = null;
    this.finished = false;
    this.skip = () => this.finish();
    el.querySelector('.tutorial-skip').addEventListener('click', this.skip, { once: true });
    this.show();
  }

  show() {
    this.el.hidden = false;
    this.el.classList.remove('done');
    this.textEl.textContent = STEPS[this.step].text[this.device];
    this.el.querySelector('.tutorial-step').textContent = `${this.step + 1}/${STEPS.length}`;
  }

  /** Called with each batch of sim events the view consumed. */
  observe(events) {
    for (const ev of events) {
      if (ev.t === 'shot') this.progress.shots++;
      else if (ev.t === 'hit' && ev.crit) this.progress.crits++;
      else if (ev.t === 'kill') this.progress.kills++;
      else if (ev.t === 'pickup' && ev.kind === 'token') this.progress.tokens++;
      else if (ev.t === 'dash') this.progress.dashes++;
    }
  }

  update(sim, dt) {
    if (this.finished) return;
    const p = sim.player;
    if (this.last) this.progress.moved += Math.hypot(p.x - this.last.x, p.z - this.last.z);
    this.last = { x: p.x, z: p.z };
    this.progress.inStep += dt;
    if (this.progress.inStep < MIN_STEP_SEC || !STEPS[this.step].done(this.progress)) return;
    this.step++;
    this.progress.inStep = 0;
    if (this.step >= STEPS.length) this.finish();
    else this.show();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.textEl.textContent = 'SIAP TEMPUR! SELAMAT BERBURU SKOR.';
    this.el.querySelector('.tutorial-step').textContent = '';
    this.el.classList.add('done');
    setTimeout(() => (this.el.hidden = true), 2500);
    this.onDone();
  }

  /** Hides the hint without marking the tutorial as completed (e.g. leaving the game). */
  dispose() {
    this.finished = true;
    this.el.hidden = true;
    this.el.querySelector('.tutorial-skip').removeEventListener('click', this.skip);
  }
}
