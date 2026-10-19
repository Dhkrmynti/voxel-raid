// Game balance shared by the in-browser game and the server-side score validation.
// Changing a number here changes both, so the validator never drifts from the game.

export const ENEMY_TYPES = {
  grunt: { hp: 40, speed: 3.4, dmg: 10, score: 100, radius: 0.7 },
  runner: { hp: 22, speed: 6.8, dmg: 6, score: 150, radius: 0.5 },
  shooter: { hp: 55, speed: 2.4, dmg: 8, score: 200, radius: 0.6, ranged: true },
  exploder: { hp: 30, speed: 5.2, dmg: 30, score: 120, radius: 0.55 },
  boss: { hp: 700, speed: 2.1, dmg: 25, score: 2500, radius: 1.9, ranged: true },
};

export const WEAPONS = [
  { id: 'pulse', name: 'PULSE', dmg: 20, pellets: 1, interval: 0.11, mag: 24, reload: 1.1, spread: 0.008, unlockWave: 1 },
  { id: 'scatter', name: 'SCATTER', dmg: 11, pellets: 8, interval: 0.75, mag: 6, reload: 1.4, spread: 0.085, falloff: 40, unlockWave: 3 },
  { id: 'rail', name: 'RAIL', dmg: 85, pellets: 1, interval: 1.0, mag: 5, reload: 1.6, spread: 0, pierce: true, unlockWave: 6 },
];

export const POWERUPS = {
  rapid: { name: 'RAPID FIRE', duration: 8 },
  double: { name: 'DOUBLE SCORE', duration: 10 },
  shield: { name: 'SHIELD', amount: 50 },
};

export const CRIT_MULT = 2;
export const MAX_MULTIPLIER = 5;
export const POWERUP_SCORE_MULT = 2; // DOUBLE SCORE
export const TOKEN_SCORE = 50;
export const WAVE_BONUS = 250; // multiplied by the wave number
export const BOSS_EVERY = 5;
export const BOSS_MINIONS = 4; // summoned once when the boss drops below half health
export const BOSS_TOKEN_DROPS = 12;
export const FIRST_INTERMISSION = 2.5;
export const WAVE_INTERMISSION = 4;

export const isBossWave = (n) => n % BOSS_EVERY === 0;
export const waveRegularCount = (n) => (isBossWave(n) ? 3 + n : 5 + n * 2);
/** Enemies spawned through the queue (regular + boss). */
export const waveQueueCount = (n) => waveRegularCount(n) + (isBossWave(n) ? 1 : 0);
/** Every enemy that has to die for the wave to clear, including the boss's minions. */
export const waveEnemyCount = (n) => waveQueueCount(n) + (isBossWave(n) ? BOSS_MINIONS : 0);
export const spawnInterval = (n) => Math.max(0.35, 1.3 - n * 0.07);
export const multiplierFor = (streak) => Math.min(MAX_MULTIPLIER, 1 + Math.floor(streak / 4));

/** Enemy roster for wave `n`, drawn from a deterministic rng. */
export function waveRoster(n, rng) {
  const list = [];
  for (let i = 0; i < waveRegularCount(n); i++) {
    const r = rng();
    if (n >= 4 && r < 0.15) list.push('exploder');
    else if (n >= 3 && r < 0.35) list.push('shooter');
    else if (n >= 2 && r < 0.6) list.push('runner');
    else list.push('grunt');
  }
  if (isBossWave(n)) list.splice(1, 0, 'boss');
  return list;
}

const SCORES = Object.values(ENEMY_TYPES).map((t) => t.score);
const MIN_ENEMY_SCORE = Math.min(...SCORES);
const MAX_REGULAR_SCORE = Math.max(...Object.entries(ENEMY_TYPES).filter(([k]) => k !== 'boss').map(([, t]) => t.score));

/**
 * Plausibility check for a finished run. The game runs on the client, so this
 * cannot prove a run was legit — it rejects results the game rules make impossible
 * (too many kills for the wave, scores outside the reachable range, waves cleared
 * faster than enemies can even spawn).
 *
 * @param {{score:number, wave:number, kills:number, tokens:number, detonations?:number}} run
 *   detonations = exploders that blew up on their own (they leave the wave without being kills)
 * @param {number} elapsedSec real time since the server issued the game ticket
 * @returns {string|null} a reason when the run is rejected, otherwise null
 */
export function validateRun({ score, wave, kills, tokens, detonations = 0 }, elapsedSec) {
  const values = [score, wave, kills, tokens, detonations];
  if (!values.every(Number.isSafeInteger) || values.some((v) => v < 0)) return 'Data skor tidak valid.';
  if (wave < 1 || wave > 500) return 'Wave tidak valid.';

  let minGone = 0;
  let maxGone = 0;
  let minBonus = 0;
  let maxBonus = 0;
  let bossWaves = 0;
  let minTime = FIRST_INTERMISSION;
  for (let n = 1; n <= wave; n++) {
    const count = waveEnemyCount(n);
    maxGone += count;
    maxBonus += WAVE_BONUS * n; // dying during the intermission after clearing wave n
    if (isBossWave(n)) bossWaves++;
    if (n < wave) {
      minGone += count;
      minBonus += WAVE_BONUS * n;
      minTime += (waveQueueCount(n) - 1) * spawnInterval(n) + WAVE_INTERMISSION;
    }
  }
  const gone = kills + detonations;
  if (gone < minGone || gone > maxGone) return 'Jumlah kill tidak cocok dengan wave yang dicapai.';

  const bossKills = Math.min(kills, bossWaves);
  if (tokens > kills + bossKills * (BOSS_TOKEN_DROPS - 1)) return 'Jumlah token melebihi drop yang mungkin.';

  const minScore = kills * MIN_ENEMY_SCORE + minBonus + tokens * TOKEN_SCORE;
  const maxKillScore = (kills - bossKills) * MAX_REGULAR_SCORE + bossKills * ENEMY_TYPES.boss.score;
  const maxScore = maxKillScore * MAX_MULTIPLIER * POWERUP_SCORE_MULT + maxBonus + tokens * TOKEN_SCORE;
  if (score < minScore || score > maxScore) return 'Skor di luar rentang yang mungkin.';

  // Slack covers network latency between game start and ticket issue.
  if (elapsedSec < minTime * 0.9 - 2) return 'Run selesai lebih cepat dari yang mungkin.';
  return null;
}
