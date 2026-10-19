// Fetches a verified replay from the server and turns it back into sim inputs for playback.
import { decodeReplay } from './game/replay.js';
import { SIM_VERSION } from './game/version.js';
import { api } from './web3/api.js';
import { getPilotName, rememberNames } from './web3/profile.js';

async function gunzipBase64(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {{ sessionId: string } | { week: number, player: string }} source
 * @returns {Promise<{ seed: number, arena: string, inputs: object[], label: string }>}
 */
export async function loadReplay(source) {
  let rec;
  try {
    rec = source.sessionId ? await api.replay(source.sessionId) : await api.bestReplay(source.week, source.player);
  } catch (err) {
    throw new Error(err.status === 404 ? 'Replay untuk skor ini tidak tersedia.' : err.message, { cause: err });
  }
  if (rec.simVersion !== SIM_VERSION) throw new Error('Replay ini dari versi game lama, jadi tidak bisa diputar.');
  if (rec.name) rememberNames({ [rec.address]: rec.name });
  const inputs = decodeReplay(await gunzipBase64(rec.replay));
  const score = Number(rec.stats.score).toLocaleString('id-ID');
  return { seed: rec.seed, arena: rec.arena, inputs, label: `REPLAY · ${getPilotName(rec.address)} · ${score}` };
}
