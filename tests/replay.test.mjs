// Replay format and deterministic-math tests.
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { datan2, dcos, dexp, dsin } from '../src/game/dmath.js';
import { decodeReplay, ReplayWriter } from '../src/game/replay.js';
import { idleInput, Sim } from '../src/game/sim.js';
import { replayRun } from '../src/game/verify.js';
import { playToDeath } from './bot.mjs';

const roundTrip = (inputs) => {
  const w = new ReplayWriter();
  for (const input of inputs) w.push(input);
  return decodeReplay(w.bytes());
};

describe('replay format', () => {
  test('round-trips bot inputs exactly', () => {
    const { inputs } = playToDeath(Sim, 77, 60 * 60);
    assert.deepEqual(roundTrip(inputs), inputs);
  });

  test('round-trips touch-stick values, wild mouse flicks and every button', () => {
    const inputs = [
      { ...idleInput(), mx: 0.37, mz: -0.92, fire: true },
      { ...idleInput(1234.5678, -1.45), mx: -1, mz: 1, jump: true, dash: true, reload: true, weapon: 2 },
      { ...idleInput(-98765.4321, 1.45), weapon: 0 },
      idleInput(-98765.4321, 1.45),
    ];
    const quantized = inputs.map((i) => ({
      ...i,
      mx: Math.round(i.mx * 100) / 100,
      mz: Math.round(i.mz * 100) / 100,
      yaw: Math.round(i.yaw * 1e4) / 1e4,
      pitch: Math.round(i.pitch * 1e4) / 1e4,
    }));
    assert.deepEqual(roundTrip(quantized), quantized);
  });

  test('is compact: an idle tick costs one byte', () => {
    const w = new ReplayWriter();
    for (let i = 0; i < 600; i++) w.push(idleInput());
    assert.equal(w.bytes().length, 3 + 600);
  });

  test('a decoded replay re-simulates to the identical result', () => {
    const { sim, inputs } = playToDeath(Sim, 314);
    const result = replayRun(314, roundTrip(inputs));
    assert.ok(result.ok);
    assert.deepEqual(result.stats, sim.stats());
  });

  test('rejects malformed data', () => {
    assert.throws(() => decodeReplay(new Uint8Array([1, 2, 3])), /Format/);
    assert.throws(() => decodeReplay(new Uint8Array([0x56, 0x52, 0x01, 16])), /terpotong/);
    assert.throws(() => decodeReplay(new Uint8Array([0x56, 0x52, 0x01, 128])), /rusak/);
    assert.throws(() => decodeReplay(new Uint8Array([0x56, 0x52, 0x01, 16, 0x7f, 0x7f])), /rusak/); // stick > 1
    const w = new ReplayWriter();
    for (let i = 0; i < 10; i++) w.push(idleInput());
    assert.throws(() => decodeReplay(w.bytes(), 5), /terlalu panjang/);
  });
});

describe('deterministic math', () => {
  test('matches Math closely across a wide range', () => {
    for (let i = 0; i < 20000; i++) {
      const x = (i - 10000) * 0.0137;
      assert.ok(Math.abs(dsin(x) - Math.sin(x)) < 1e-12);
      assert.ok(Math.abs(dcos(x) - Math.cos(x)) < 1e-12);
      assert.ok(Math.abs(datan2(x, 3 - x * 0.5) - Math.atan2(x, 3 - x * 0.5)) < 1e-12);
    }
    for (const x of [-20, -1, -0.23, 0, 0.5, 3, 15]) assert.ok(Math.abs(dexp(x) / Math.exp(x) - 1) < 1e-13);
  });

  test('handles atan2 edge cases', () => {
    assert.equal(datan2(0, 0), 0);
    assert.equal(datan2(1, 0), Math.PI / 2);
    assert.equal(datan2(-1, 0), -Math.PI / 2);
    assert.equal(datan2(0, -1), Math.PI);
  });
});
