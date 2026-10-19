// Filters pointer-locked mouse movement before it turns the camera.
// Windows browsers sometimes report one huge movement in a single event (display scaling,
// pointer acceleration, the cursor warp right after the lock grabs it). A real flick builds up
// over several events, so only a lone event far beyond the previous one counts as a glitch.

const SETTLE_MS = 100; // input right after locking is ignored
const SPIKE_PX = 180; // an event must be at least this large to be a spike...
const SPIKE_RATIO = 8; // ...and this many times larger than the event before it

export function createLookFilter() {
  let since = -Infinity;
  let last = 0;
  let droppedLast = false;
  let dropped = 0;

  return {
    /** Call when the pointer lock is (re)acquired. */
    reset(now) {
      since = now;
      last = 0;
      droppedLast = false;
    },

    /** True when the movement should turn the camera; false for a glitch. */
    accept(dx, dy, now) {
      const size = Math.hypot(dx, dy);
      if (now - since < SETTLE_MS) {
        dropped++;
        return false;
      }
      // Never drop two in a row: a second big event means the hand really is moving fast.
      if (!droppedLast && size > SPIKE_PX && size > last * SPIKE_RATIO) {
        droppedLast = true;
        dropped++;
        return false;
      }
      droppedLast = false;
      last = size;
      return true;
    },

    get dropped() {
      return dropped;
    },
  };
}
