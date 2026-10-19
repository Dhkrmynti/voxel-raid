// Tiny synthesized SFX via WebAudio — no asset files needed.
let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
let spot = null; // { pan, vol } of the positional sound currently being played

/** Shared AudioContext (created lazily after a user gesture); music.js plays through it too. */
export function audioContext() {
  return ac();
}

// Voices route through a stereo panner while a positional sound plays.
function output(c) {
  if (!spot) return master;
  const panner = c.createStereoPanner();
  panner.pan.value = spot.pan;
  panner.connect(master);
  return panner;
}

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ f = 440, f2 = f, d = 0.1, type = 'square', v = 0.2, delay = 0 }) {
  const c = ac();
  if (!c || muted) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + d);
  g.gain.setValueAtTime(v * (spot?.vol ?? 1), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(output(c));
  o.start(t);
  o.stop(t + d + 0.02);
}

function noise({ d = 0.1, v = 0.2, freq = 2000, delay = 0 }) {
  const c = ac();
  if (!c || muted) return;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const t = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(freq, t);
  filter.frequency.exponentialRampToValueAtTime(200, t + d);
  const g = c.createGain();
  g.gain.setValueAtTime(v * (spot?.vol ?? 1), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(filter).connect(g).connect(output(c));
  src.start(t);
  src.stop(t + d + 0.02);
}

export const sfx = {
  unlock: () => ac(),
  get muted() {
    return muted;
  },
  toggleMute() {
    muted = !muted;
    return muted;
  },
  setMuted(value) {
    muted = value;
  },
  /** Plays `name` panned/attenuated for a world position: sfx.at({ pan, vol }, 'explode'). */
  at(where, name) {
    spot = where;
    try {
      this[name]();
    } finally {
      spot = null;
    }
  },
  shoot() {
    noise({ d: 0.07, v: 0.22, freq: 3200 });
    tone({ f: 520, f2: 90, d: 0.08, v: 0.1 });
  },
  scatter() {
    noise({ d: 0.22, v: 0.32, freq: 1800 });
    tone({ f: 180, f2: 50, d: 0.18, type: 'sawtooth', v: 0.14 });
  },
  rail() {
    tone({ f: 1800, f2: 120, d: 0.35, type: 'sawtooth', v: 0.12 });
    tone({ f: 2400, f2: 900, d: 0.2, type: 'square', v: 0.06, delay: 0.02 });
    noise({ d: 0.12, v: 0.15, freq: 5000 });
  },
  hit() {
    tone({ f: 980, f2: 620, d: 0.05, v: 0.07 });
  },
  crit() {
    tone({ f: 1500, f2: 1100, d: 0.06, v: 0.09 });
    tone({ f: 2200, d: 0.05, v: 0.05, delay: 0.03 });
  },
  explode() {
    noise({ d: 0.6, v: 0.45, freq: 700 });
    tone({ f: 120, f2: 30, d: 0.5, type: 'sawtooth', v: 0.22 });
  },
  fuse() {
    [0, 0.2, 0.4, 0.55, 0.68].forEach((delay) => tone({ f: 1200, d: 0.04, v: 0.05, delay }));
  },
  dash() {
    noise({ d: 0.15, v: 0.18, freq: 4000 });
    tone({ f: 300, f2: 900, d: 0.12, type: 'triangle', v: 0.06 });
  },
  swap() {
    tone({ f: 420, f2: 300, d: 0.05, v: 0.06 });
    tone({ f: 640, d: 0.04, v: 0.06, delay: 0.08 });
  },
  powerup() {
    [523, 784, 1046, 1568].forEach((f, i) => tone({ f, d: 0.08, type: 'triangle', v: 0.12, delay: i * 0.05 }));
  },
  shieldHit() {
    tone({ f: 600, f2: 260, d: 0.18, type: 'triangle', v: 0.16 });
  },
  unlock() {
    [392, 523, 659, 784, 1046].forEach((f, i) => tone({ f, d: 0.1, v: 0.1, delay: i * 0.07 }));
  },
  streak() {
    tone({ f: 660, d: 0.08, v: 0.1 });
    tone({ f: 990, d: 0.14, v: 0.1, delay: 0.08 });
  },
  kill() {
    tone({ f: 420, f2: 60, d: 0.25, type: 'sawtooth', v: 0.13 });
    noise({ d: 0.18, v: 0.18, freq: 1400 });
  },
  hurt() {
    tone({ f: 190, f2: 55, d: 0.25, type: 'sawtooth', v: 0.22 });
  },
  pickup() {
    [660, 880, 1320].forEach((f, i) => tone({ f, d: 0.07, v: 0.08, delay: i * 0.05 }));
  },
  heal() {
    [392, 523, 659, 784].forEach((f, i) => tone({ f, d: 0.09, type: 'triangle', v: 0.14, delay: i * 0.06 }));
  },
  reload() {
    tone({ f: 300, f2: 200, d: 0.05, v: 0.08 });
    tone({ f: 520, f2: 700, d: 0.06, v: 0.08, delay: 0.95 });
  },
  enemyShoot() {
    tone({ f: 760, f2: 240, d: 0.14, type: 'triangle', v: 0.07 });
  },
  wave() {
    tone({ f: 440, d: 0.12, v: 0.12 });
    tone({ f: 660, d: 0.2, v: 0.12, delay: 0.14 });
  },
  waveClear() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f, d: 0.12, v: 0.1, delay: i * 0.08 }));
  },
  boss() {
    tone({ f: 110, f2: 55, d: 0.9, type: 'sawtooth', v: 0.25 });
    tone({ f: 165, f2: 80, d: 0.9, type: 'square', v: 0.12, delay: 0.1 });
  },
  bossDown() {
    noise({ d: 0.8, v: 0.35, freq: 900 });
    [784, 659, 523, 392, 262].forEach((f, i) => tone({ f, d: 0.15, v: 0.12, delay: i * 0.1 }));
  },
  gameOver() {
    [392, 330, 262, 196].forEach((f, i) => tone({ f, d: 0.25, type: 'triangle', v: 0.16, delay: i * 0.18 }));
  },
};
