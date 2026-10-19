// Mouse-look glitch filter: drops lone spikes and post-lock warps, keeps real fast flicks.
//   npm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLookFilter } from '../src/game/lookFilter.js';

describe('look filter', () => {
  test('ignores input right after the pointer lock grabs the cursor', () => {
    const f = createLookFilter();
    f.reset(1000);
    assert.equal(f.accept(900, 0, 1010), false, 'the cursor warp on locking');
    assert.equal(f.accept(5, 0, 1150), true);
  });

  test('drops a lone spike during slow aiming', () => {
    const f = createLookFilter();
    f.reset(0);
    for (let t = 200; t < 300; t += 8) assert.equal(f.accept(3, 1, t), true);
    assert.equal(f.accept(640, -12, 308), false, 'one 640 px jump among 3 px moves');
    assert.equal(f.accept(3, 1, 316), true);
    assert.equal(f.dropped, 1);
  });

  test('keeps a real flick: it builds up, and never drops two events in a row', () => {
    const f = createLookFilter();
    f.reset(0);
    let t = 200;
    const flick = [4, 30, 90, 220, 260, 200, 80, 10];
    for (const dx of flick) assert.equal(f.accept(dx, 0, (t += 8)), true, `${dx} px`);
    // Even a sudden fast move from rest only loses its very first event.
    assert.equal(f.accept(2, 0, (t += 8)), true);
    assert.equal(f.accept(300, 0, (t += 8)), false);
    assert.equal(f.accept(300, 0, (t += 8)), true);
    assert.equal(f.accept(280, 0, t + 8), true);
  });
});
