// First-run tutorial pacing: hints advance on what the player does, but never faster than
// a player can read them.
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Tutorial } from '../src/game/tutorial.js';

/** Just enough of the hint element for the Tutorial class. */
function fakeElement() {
  const node = () => ({ textContent: '', addEventListener() {}, removeEventListener() {} });
  const parts = { '.tutorial-text': node(), '.tutorial-step': node(), '.tutorial-skip': node() };
  return { hidden: true, classList: { add() {}, remove() {} }, querySelector: (s) => parts[s], parts };
}

describe('tutorial', () => {
  test('a step the player already completed still stays up for at least 2 seconds', () => {
    const el = fakeElement();
    let done = false;
    const t = new Tutorial(el, { touch: false, onDone: () => (done = true) });
    // A player who has already moved, shot, landed crits, grabbed a coin and dashed.
    const sim = { player: { x: 0, z: 0 } };
    t.observe([{ t: 'shot' }, { t: 'hit', crit: true }, { t: 'pickup', kind: 'token' }, { t: 'dash' }]);
    const shown = [];
    let time = 0;
    for (let frame = 0; frame < 60 * 30 && !done; frame++) {
      sim.player.x += 0.1; // keeps moving
      t.update(sim, 1 / 60);
      time += 1 / 60;
      const step = el.parts['.tutorial-step'].textContent;
      if (shown.at(-1)?.step !== step) shown.push({ step, at: time });
    }
    assert.ok(done, 'the tutorial completes');
    const steps = shown.filter((s) => s.step); // the final "SIAP TEMPUR" has no step number
    assert.deepEqual(
      steps.map((s) => s.step),
      ['1/5', '2/5', '3/5', '4/5', '5/5'],
    );
    const times = shown.map((s) => s.at);
    // Every hint, including the last one before "SIAP TEMPUR", is on screen for ≥ 2 s.
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 2 - 0.02, `step ${i} shown too briefly`);
  });

  test('steps still wait for the action when the player has not done it yet', () => {
    const el = fakeElement();
    const t = new Tutorial(el, { touch: true, onDone() {} });
    const sim = { player: { x: 0, z: 0 } };
    for (let frame = 0; frame < 60 * 10; frame++) t.update(sim, 1 / 60); // standing still
    assert.equal(el.parts['.tutorial-step'].textContent, '1/5');
    assert.match(el.parts['.tutorial-text'].textContent, /JOYSTICK/);
  });
});
