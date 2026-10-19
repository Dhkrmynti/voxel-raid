// Re-simulates a recorded run. The server trusts this result, never the client's claimed stats.
import { Sim, TICK } from './sim.js';

/**
 * @param {number} seed the seed the server issued with the game ticket
 * @param {object[]} inputs decoded replay (one entry per tick)
 * @returns {{ ok: true, stats: object, seconds: number } | { ok: false, error: string }}
 */
export function replayRun(seed, inputs) {
  const sim = new Sim(seed);
  for (const input of inputs) {
    if (sim.over) return { ok: false, error: 'Replay berlanjut setelah game over.' };
    sim.step(input);
    sim.events.length = 0;
  }
  if (!sim.over) return { ok: false, error: 'Replay tidak berakhir dengan game over.' };
  return { ok: true, stats: sim.stats(), seconds: sim.tick * TICK };
}
