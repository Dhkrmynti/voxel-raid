// Local (off-chain) persistence. Phase 3 moves the leaderboard on-chain.
const SCORES_KEY = 'voxelraid.scores.v1';
const STATS_KEY = 'voxelraid.stats.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.) — scores just won't persist
  }
}

// Guest stats keep the original key so phase-1 progress carries over.
const statsKey = (address) => (address ? `${STATS_KEY}:${address.toLowerCase()}` : STATS_KEY);

const isPlayer = (entry, address) => (address ? entry.player?.address?.toLowerCase() === address.toLowerCase() : !entry.player);

export function loadScores() {
  const list = read(SCORES_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function loadStats(address) {
  return { played: 0, tokens: 0, best: 0, ...read(statsKey(address), {}) };
}

// Stats for one player (wallet address, or guest when omitted).
export function playerSummary(address) {
  const stats = loadStats(address);
  const listed = loadScores().find((e) => isPlayer(e, address))?.score ?? 0;
  return { ...stats, best: Math.max(stats.best, listed) };
}

export function saveScore({ score, wave, kills, tokens }, player) {
  const entry = { score, wave, kills, tokens, date: Date.now(), player: player ? { address: player.address } : null };
  const prevBest = playerSummary(player?.address).best;
  const top = [...loadScores(), entry].sort((a, b) => b.score - a.score).slice(0, 10);
  write(SCORES_KEY, top);

  const stats = loadStats(player?.address);
  stats.played += 1;
  stats.tokens += tokens;
  stats.best = Math.max(prevBest, score);
  write(statsKey(player?.address), stats);

  const rank = top.indexOf(entry);
  return { rank: rank >= 0 ? rank + 1 : null, best: stats.best, isBest: score > prevBest };
}
