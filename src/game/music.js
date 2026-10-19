// Procedural chiptune soundtrack: a lookahead scheduler plays bass, arpeggio, lead and drums
// from tiny patterns. Three intensities: 0 = calm (between waves), 1 = combat, 2 = boss.
import { audioContext } from './audio.js';

// A minor: Am – F – C – G, one bar each (MIDI note numbers).
const PROGRESSION = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
const BOSS_LEAD = [69, 72, 76, 74, 72, 71, 69, 64];
const TEMPO = [96, 128, 144];
const BASS_STEPS = [
  [0, 8],
  [0, 3, 6, 8, 11, 14],
  [0, 2, 4, 6, 8, 10, 12, 14],
];
const VOLUME = 0.5;
const LOOKAHEAD = 0.12; // seconds scheduled ahead of the audio clock
const SCHEDULER_MS = 25;

const freq = (m) => 440 * 2 ** ((m - 69) / 12);

let out = null;
let noiseBuf = null;
let muted = false;
let playing = false;
let intensity = 0;
let step = 0;
let nextTime = 0;
let timer = null;
let beats = [];

function voice(c, t, { f, d, type, v }) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + d + 0.02);
}

function drum(c, t, kind) {
  if (kind === 'kick') {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.14);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.18);
    return;
  }
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate / 2, c.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const filter = c.createBiquadFilter();
  const g = c.createGain();
  const snare = kind === 'snare';
  filter.type = snare ? 'bandpass' : 'highpass';
  filter.frequency.value = snare ? 1800 : 7000;
  const d = snare ? 0.12 : 0.03;
  g.gain.setValueAtTime(snare ? 0.22 : 0.07, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  src.connect(filter).connect(g).connect(out);
  src.start(t);
  src.stop(t + d + 0.02);
}

function schedule(c, s, t) {
  const pos = s % 16;
  const chord = PROGRESSION[Math.floor(s / 16) % PROGRESSION.length];
  const level = intensity;

  if (level >= 1) {
    if (pos % 4 === 0 || (level === 2 && pos % 4 === 2)) drum(c, t, 'kick');
    if (pos === 4 || pos === 12) drum(c, t, 'snare');
    if (pos % 2 === 1) drum(c, t, 'hat');
  } else if (pos % 4 === 2) {
    drum(c, t, 'hat');
  }
  if (pos % 4 === 0) beats.push(t);

  if (BASS_STEPS[level].includes(pos)) {
    voice(c, t, { f: freq(chord[0] - 24), d: level === 0 ? 0.6 : 0.18, type: 'triangle', v: 0.18 });
  }
  if (level >= 1 || pos % 2 === 0) {
    const note = chord[pos % 3] + (pos >= 8 ? 12 : 0) + (level === 2 ? 12 : 0);
    voice(c, t, { f: freq(note), d: 0.09, type: 'square', v: level === 0 ? 0.02 : 0.03 });
  }
  if (level === 2 && pos % 4 === 0) {
    voice(c, t, { f: freq(BOSS_LEAD[(s / 4) % BOSS_LEAD.length]), d: 0.28, type: 'sawtooth', v: 0.035 });
  }
}

function tick() {
  const c = audioContext();
  if (!c) return;
  const stepLen = 60 / TEMPO[intensity] / 4; // 16th notes
  // After a long stall (background tab) skip ahead instead of bursting the backlog.
  if (nextTime < c.currentTime - 0.5) nextTime = c.currentTime;
  while (nextTime < c.currentTime + LOOKAHEAD) {
    schedule(c, step, nextTime);
    nextTime += stepLen;
    step++;
  }
  beats = beats.filter((b) => b > c.currentTime - 1);
}

export const music = {
  start() {
    const c = audioContext();
    if (!c || playing) return;
    if (!out) {
      out = c.createGain();
      out.connect(c.destination);
    }
    out.gain.cancelScheduledValues(c.currentTime);
    out.gain.setValueAtTime(muted ? 0 : VOLUME, c.currentTime);
    playing = true;
    step = 0;
    nextTime = c.currentTime + 0.05;
    timer = setInterval(tick, SCHEDULER_MS);
  },
  stop(fade = 0.8) {
    if (!playing) return;
    playing = false;
    clearInterval(timer);
    const c = audioContext();
    out.gain.cancelScheduledValues(c.currentTime);
    out.gain.setValueAtTime(out.gain.value, c.currentTime);
    out.gain.linearRampToValueAtTime(0, c.currentTime + fade);
  },
  setIntensity(level) {
    intensity = level;
  },
  get muted() {
    return muted;
  },
  setMuted(value) {
    muted = value;
    const c = audioContext();
    if (out && c) out.gain.setValueAtTime(value || !playing ? 0 : VOLUME, c.currentTime);
  },
  /** 1 exactly on a beat, decaying to 0 — drives the arena's neon pulse. */
  pulse() {
    const c = audioContext();
    if (!c || !playing) return 0;
    let since = Infinity;
    for (const b of beats) if (b <= c.currentTime) since = Math.min(since, c.currentTime - b);
    return since < 0.35 ? 1 - since / 0.35 : 0;
  },
};
