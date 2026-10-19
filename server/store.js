// Small persistent store for verified replays, daily boards and pilot names.
// Data lives in memory and is flushed to one JSON file, which suits a single server process.
// Several instances (serverless, autoscaling) need a shared database behind the same methods.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const RETENTION_MS = 21 * DAY_MS;
const FLUSH_DELAY_MS = 500;

/**
 * @param {{ file?: string, now?: () => number }} [options] omit `file` for a memory-only store (tests)
 */
export function createStore({ file, now = Date.now } = {}) {
  // tickets: sessionId → { hash, exp } of the replay a game ticket was spent on.
  // dailyAttested: "day:address" → the one daily session that day that may go on-chain.
  let data = { replays: {}, weeklyBest: {}, daily: {}, names: {}, tickets: {}, dailyAttested: {} };
  if (file) {
    try {
      data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
    } catch {
      // first run, or unreadable: start empty
    }
  }

  let timer = null;
  function flush() {
    timer = null;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file); // atomic replace, so a crash never leaves half a file
  }
  const save = () => {
    if (file && !timer) timer = setTimeout(flush, FLUSH_DELAY_MS);
  };

  /** Drops replays nothing points to any more, and anything past the retention window. */
  function prune() {
    const cutoff = now() - RETENTION_MS;
    const keep = new Set(Object.values(data.weeklyBest));
    for (const board of Object.values(data.daily)) for (const e of Object.values(board)) keep.add(e.sessionId);
    for (const [id, r] of Object.entries(data.replays)) if (!keep.has(id) || r.createdAt < cutoff) delete data.replays[id];
    const cutoffDay = Math.floor(cutoff / DAY_MS);
    for (const day of Object.keys(data.daily)) if (Number(day) < cutoffDay) delete data.daily[day];
    for (const key of Object.keys(data.dailyAttested)) if (Number(key.split(':')[0]) < cutoffDay) delete data.dailyAttested[key];
    const cutoffWeek = Math.floor(cutoff / WEEK_MS);
    for (const key of Object.keys(data.weeklyBest)) if (Number(key.split(':')[0]) < cutoffWeek) delete data.weeklyBest[key];
    const t = now();
    for (const [id, ticket] of Object.entries(data.tickets)) if (ticket.exp < t) delete data.tickets[id];
  }
  prune();

  return {
    /**
     * Records a verified run. Its replay is kept only if it is the player's best this week
     * (and, for daily runs, their best of that day).
     * @returns {{ dailyRank: number | null }}
     */
    recordRun(run) {
      const { sessionId, address, week, mode, day, stats } = run;
      let referenced = false;
      const weekKey = `${week}:${address.toLowerCase()}`;
      const prevWeek = data.replays[data.weeklyBest[weekKey]];
      if (!prevWeek || stats.score > prevWeek.stats.score) {
        data.weeklyBest[weekKey] = sessionId;
        referenced = true;
      }
      let dailyRank = null;
      if (mode === 'daily') {
        const board = (data.daily[day] ??= {});
        const key = address.toLowerCase();
        if (!board[key] || stats.score > board[key].score) {
          board[key] = { address, sessionId, score: stats.score, wave: stats.wave, at: now() };
          referenced = true;
        }
        dailyRank = this.dailyTop(day, Infinity).findIndex((e) => e.address.toLowerCase() === key) + 1 || null;
      }
      if (referenced) data.replays[sessionId] = { ...run, createdAt: now() };
      prune();
      save();
      return { dailyRank };
    },

    /**
     * Spends a game ticket on one replay. Sending the same replay again (a retry) is fine;
     * a different replay on a spent ticket is not.
     * @returns {'new' | 'repeat' | 'conflict'}
     */
    useTicket(sessionId, hash, exp) {
      const prev = data.tickets[sessionId];
      if (prev) return prev.hash === hash ? 'repeat' : 'conflict';
      data.tickets[sessionId] = { hash, exp };
      save();
      return 'new';
    },

    /** Daily runs share one seed, so only one per wallet per day may earn an on-chain attestation. */
    claimDailyAttestation(day, address, sessionId) {
      const key = `${day}:${address.toLowerCase()}`;
      data.dailyAttested[key] ??= sessionId;
      save();
      return data.dailyAttested[key] === sessionId;
    },

    getReplay(sessionId) {
      return Object.hasOwn(data.replays, sessionId) ? data.replays[sessionId] : null;
    },

    weeklyBestReplay(week, address) {
      const id = data.weeklyBest[`${week}:${address.toLowerCase()}`];
      return id ? this.getReplay(id) : null;
    },

    /** Best run per player for a day, highest first; ties go to whoever got there first. */
    dailyTop(day, limit = 10) {
      return Object.values(data.daily[day] ?? {})
        .sort((a, b) => b.score - a.score || a.at - b.at)
        .slice(0, limit);
    },

    setName(address, name) {
      data.names[address.toLowerCase()] = { name, updatedAt: now() };
      save();
    },

    names(addresses) {
      const out = {};
      for (const a of addresses) {
        const n = data.names[a.toLowerCase()];
        if (n) out[a] = n.name;
      }
      return out;
    },

    flush,
  };
}
