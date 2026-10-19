import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createPublicClient, getAddress, http, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { generateSiweNonce, parseSiweMessage } from 'viem/siwe';
import { decodeReplay } from '../src/game/replay.js';
import { validateRun } from '../src/game/rules.js';
import { ARENAS, DEFAULT_ARENA, SIM_VERSION, TICK } from '../src/game/sim.js';
import { replayRun } from '../src/game/verify.js';
import { sanitizeName } from '../src/web3/profile.js';
import { createRateLimiter } from './ratelimit.js';
import { createStore } from './store.js';
import { deploymentFor, resolveChain } from '../src/web3/chains.js';

const NONCE_COOKIE = 'vr_nonce';
const SESSION_COOKIE = 'vr_session';
const NONCE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const TICKET_TTL = 2 * 60 * 60 * 1000;
const ATTESTATION_TTL_SEC = 60 * 60;
// A ticket lives 2 h, so a replay can never be longer than that many ticks.
const MAX_REPLAY_TICKS = (TICKET_TTL / 1000) * 60;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024; // decompressed — guards against zip bombs
const MAX_REPLAY_BASE64 = 4 * 1024 * 1024; // what we accept over the wire
const REALTIME_SLACK_SEC = 2;
const STAT_KEYS = ['score', 'wave', 'kills', 'tokens', 'detonations'];

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Requests per window. Login is limited per IP (no wallet yet); game endpoints per wallet,
// plus per IP for the expensive replay verification so one machine can't rotate wallets.
export const DEFAULT_LIMITS = {
  nonce: { limit: 20, windowMs: MINUTE },
  verify: { limit: 10, windowMs: MINUTE },
  start: { limit: 60, windowMs: HOUR },
  finish: { limit: 30, windowMs: HOUR },
  finishIp: { limit: 120, windowMs: HOUR },
  read: { limit: 240, windowMs: MINUTE },
  name: { limit: 20, windowMs: HOUR },
};
const DAY_MS = 24 * HOUR;
const WEEK_SEC = 7 * 24 * 60 * 60;
const ARENA_IDS = Object.keys(ARENAS);
const MAX_PROFILE_LOOKUP = 50;
const SMALL_BODY = 32 * 1024;
const REPLAY_BODY = MAX_REPLAY_BASE64 + 64 * 1024;

export const SCORE_TYPES = {
  Score: [
    { name: 'player', type: 'address' },
    { name: 'score', type: 'uint64' },
    { name: 'wave', type: 'uint32' },
    { name: 'kills', type: 'uint32' },
    { name: 'tokens', type: 'uint32' },
    { name: 'sessionId', type: 'bytes32' },
    { name: 'deadline', type: 'uint64' },
  ],
};

/**
 * @param {Record<string, string>} env  set TRUST_PROXY=1 only behind a proxy that sets X-Forwarded-For
 * @param {{ now?: () => number, limits?: object | false, store?: object }} [options]
 *   `now` is injectable so tests can fast-forward time; `limits: false` disables rate limiting;
 *   `store` defaults to a JSON file at env.DATA_FILE (memory-only when unset)
 */
export function createApp(env = process.env, { now = Date.now, limits = DEFAULT_LIMITS, store } = {}) {
  store ??= createStore({ file: env.DATA_FILE, now });
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  if (!env.SERVER_SIGNER_KEY) throw new Error('SERVER_SIGNER_KEY is missing.');

  const chain = resolveChain(env.CHAIN);
  const signer = privateKeyToAccount(env.SERVER_SIGNER_KEY);
  const client = createPublicClient({ chain, transport: http(env.RPC_URL || undefined) });
  // LEADERBOARD_ADDRESS wins; otherwise read deployments.json on each request so a
  // fresh local deployment is picked up without a restart.
  const contractAddress = () => {
    if (env.LEADERBOARD_ADDRESS) return env.LEADERBOARD_ADDRESS;
    const file = new URL('../src/web3/deployments.json', import.meta.url);
    return deploymentFor(JSON.parse(readFileSync(file, 'utf8')), chain.id)?.leaderboard ?? null;
  };

  // ---------- stateless signed tokens (HMAC) ----------

  const mac = (body) => createHmac('sha256', env.SESSION_SECRET).update(body).digest();
  const seal = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${mac(body).toString('base64url')}`;
  };
  const unseal = (token, typ) => {
    if (typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const given = Buffer.from(sig, 'base64url');
    const expected = mac(body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return data.typ === typ && data.exp > now() ? data : null;
    } catch {
      return null;
    }
  };

  const cookieOpts = (c, ttlMs) => ({
    httpOnly: true,
    sameSite: 'Lax',
    path: '/api',
    secure: new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
    maxAge: Math.floor(ttlMs / 1000),
  });

  const readJson = (c) => c.req.json().catch(() => null);

  // ---------- daily challenge ----------

  const today = () => Math.floor(now() / DAY_MS);
  // Everyone gets the same world each day; derived from the server secret, so nothing to store.
  const dailySeed = (day) => mac(`daily:${day}`).readUInt32LE(0);
  const dailyArena = (day) => ARENA_IDS[day % ARENA_IDS.length];
  const withNames = (entries) => {
    const names = store.names(entries.map((e) => e.address));
    return entries.map((e) => ({ ...e, name: names[e.address] ?? null }));
  };

  // ---------- abuse protection ----------

  const limiter = createRateLimiter({ now });
  // X-Forwarded-For is client-controlled unless a trusted proxy overwrites it.
  const clientIp = (c) =>
    (env.TRUST_PROXY === '1' && c.req.header('x-forwarded-for')?.split(',')[0].trim()) ||
    c.env?.incoming?.socket?.remoteAddress ||
    'unknown';

  /** Middleware: one request from `name`'s budget, keyed by IP or by the signed-in wallet. */
  const rateLimit = (name, by) => async (c, next) => {
    if (limits) {
      const key = by === 'wallet' ? c.get('session').address : clientIp(c);
      const res = limiter.take(`${name}:${key}`, limits[name]);
      if (!res.ok) {
        c.header('Retry-After', String(res.retryAfter));
        return c.json({ error: `Terlalu banyak permintaan. Coba lagi dalam ${res.retryAfter} detik.` }, 429);
      }
    }
    await next();
  };

  const maxBody = (maxSize) => bodyLimit({ maxSize, onError: (c) => c.json({ error: 'Permintaan terlalu besar.' }, 413) });

  const requireSession = async (c, next) => {
    const session = unseal(getCookie(c, SESSION_COOKIE), 'session');
    if (!session) return c.json({ error: 'Belum login ranked.' }, 401);
    c.set('session', session);
    await next();
  };

  // ---------- routes ----------

  const app = new Hono().basePath('/api');

  app.get('/config', (c) =>
    c.json({ chainId: chain.id, chainName: chain.name, contract: contractAddress(), signer: signer.address }),
  );

  app.get('/auth/nonce', rateLimit('nonce', 'ip'), (c) => {
    const nonce = generateSiweNonce();
    setCookie(c, NONCE_COOKIE, seal({ typ: 'nonce', nonce, exp: now() + NONCE_TTL }), cookieOpts(c, NONCE_TTL));
    return c.json({ nonce });
  });

  app.post('/auth/verify', maxBody(SMALL_BODY), rateLimit('verify', 'ip'), async (c) => {
    const body = await readJson(c);
    const { message, signature } = body ?? {};
    if (typeof message !== 'string' || typeof signature !== 'string' || message.length > 2000) {
      return c.json({ error: 'Permintaan tidak valid.' }, 400);
    }
    const nonce = unseal(getCookie(c, NONCE_COOKIE), 'nonce');
    if (!nonce) return c.json({ error: 'Sesi login kedaluwarsa. Coba lagi.' }, 401);

    let fields;
    try {
      fields = parseSiweMessage(message);
    } catch {
      return c.json({ error: 'Pesan login tidak valid.' }, 400);
    }
    if (!fields.address || !isAddress(fields.address)) return c.json({ error: 'Alamat tidak valid.' }, 400);
    if (fields.chainId !== chain.id) return c.json({ error: `Login harus di jaringan ${chain.name}.` }, 400);

    // Checks domain, nonce, validity window and the signature (incl. smart-contract wallets).
    // SIWE_DOMAIN pins the expected site; forwarded headers are spoofable, so they are never used.
    const domain = env.SIWE_DOMAIN || new URL(c.req.url).host;
    const valid = await client.verifySiweMessage({ message, signature, domain, nonce: nonce.nonce }).catch(() => false);
    if (!valid) return c.json({ error: 'Tanda tangan tidak valid.' }, 401);

    const address = getAddress(fields.address);
    deleteCookie(c, NONCE_COOKIE, { path: '/api' });
    setCookie(c, SESSION_COOKIE, seal({ typ: 'session', address, exp: now() + SESSION_TTL }), cookieOpts(c, SESSION_TTL));
    return c.json({ address });
  });

  app.get('/auth/me', (c) => {
    const session = unseal(getCookie(c, SESSION_COOKIE), 'session');
    return c.json({ address: session?.address ?? null });
  });

  app.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/api' });
    return c.json({ ok: true });
  });

  // The server picks the seed, so a player can't shop for a lucky world.
  app.post('/game/start', maxBody(SMALL_BODY), requireSession, rateLimit('start', 'wallet'), async (c) => {
    const { address } = c.get('session');
    const body = (await readJson(c)) ?? {};
    const daily = body.mode === 'daily';
    const day = today();
    const arena = daily ? dailyArena(day) : (body.arena ?? DEFAULT_ARENA);
    if (!Object.hasOwn(ARENAS, arena)) return c.json({ error: 'Arena tidak dikenal.' }, 400);
    const startedAt = now();
    const sessionId = `0x${randomBytes(32).toString('hex')}`;
    const seed = daily ? dailySeed(day) : randomBytes(4).readUInt32LE(0);
    const mode = daily ? 'daily' : 'ranked';
    const ticket = seal({ typ: 'ticket', sessionId, seed, arena, mode, day, address, startedAt, exp: startedAt + TICKET_TTL });
    return c.json({ ticket, seed, arena, mode, simVersion: SIM_VERSION });
  });

  app.post(
    '/game/finish',
    maxBody(REPLAY_BODY),
    requireSession,
    rateLimit('finishIp', 'ip'),
    rateLimit('finish', 'wallet'),
    async (c) => {
      const { address } = c.get('session');
      const body = await readJson(c);
      const ticket = unseal(body?.ticket, 'ticket');
      if (!ticket || ticket.address !== address) return c.json({ error: 'Tiket game tidak valid atau kedaluwarsa.' }, 400);

      if (body.simVersion !== SIM_VERSION) {
        return c.json({ error: 'Versi game berbeda dengan server. Muat ulang halaman lalu main lagi.' }, 409);
      }

      // Re-simulate the run from the server's seed and the recorded inputs; only that result counts.
      if (typeof body.replay !== 'string' || body.replay.length > MAX_REPLAY_BASE64) {
        return c.json({ error: 'Replay tidak ada atau terlalu besar.' }, 400);
      }
      let inputs;
      try {
        const raw = gunzipSync(Buffer.from(body.replay, 'base64'), { maxOutputLength: MAX_REPLAY_BYTES });
        inputs = decodeReplay(raw, MAX_REPLAY_TICKS);
      } catch {
        return c.json({ error: 'Replay tidak valid.' }, 400);
      }
      // Cheap check first: a run can't contain more ticks than real time allows, so reject
      // over-long replays before spending CPU on re-simulating them.
      const elapsed = (now() - ticket.startedAt) / 1000;
      if (inputs.length * TICK > elapsed + REALTIME_SLACK_SEC) {
        return c.json({ error: 'Run berjalan lebih cepat dari waktu nyata.' }, 422);
      }
      const result = replayRun(ticket.seed, inputs, ticket.arena);
      if (!result.ok) return c.json({ error: result.error }, 422);
      const stats = result.stats;
      if (STAT_KEYS.some((k) => body[k] !== stats[k])) {
        return c.json({ error: 'Hasil replay tidak cocok dengan skor yang dikirim.' }, 422);
      }
      const problem = validateRun(stats, elapsed);
      if (problem) return c.json({ error: problem }, 422);

      // Verified: keep the replay if it's a personal best, and update the daily board.
      const { dailyRank } = store.recordRun({
        sessionId: ticket.sessionId,
        address,
        seed: ticket.seed,
        arena: ticket.arena,
        mode: ticket.mode ?? 'ranked',
        day: ticket.day,
        week: Math.floor(ticket.startedAt / 1000 / WEEK_SEC),
        simVersion: SIM_VERSION,
        stats,
        replay: body.replay,
      });
      const run = { score: stats.score, wave: stats.wave, kills: stats.kills, tokens: stats.tokens };

      const verifyingContract = contractAddress();
      if (!verifyingContract) return c.json({ error: `Contract belum di-deploy di ${chain.name}.` }, 503);

      const deadline = BigInt(Math.floor(now() / 1000) + ATTESTATION_TTL_SEC);
      const signature = await signer.signTypedData({
        domain: { name: 'VoxelRaid', version: '1', chainId: chain.id, verifyingContract },
        types: SCORE_TYPES,
        primaryType: 'Score',
        message: { player: address, ...run, score: BigInt(run.score), sessionId: ticket.sessionId, deadline },
      });
      return c.json({
        attestation: { ...run, sessionId: ticket.sessionId, deadline: deadline.toString(), contract: verifyingContract },
        signature,
        dailyRank,
      });
    },
  );

  // ---------- public reads: daily board, replays, pilot names ----------

  app.get('/daily', rateLimit('read', 'ip'), (c) => {
    const day = today();
    return c.json({
      day,
      seed: dailySeed(day),
      arena: dailyArena(day),
      resetsAt: (day + 1) * DAY_MS,
      simVersion: SIM_VERSION,
      top: withNames(store.dailyTop(day)),
    });
  });

  const replayView = (r) =>
    r && {
      sessionId: r.sessionId,
      address: r.address,
      name: store.names([r.address])[r.address] ?? null,
      seed: r.seed,
      arena: r.arena,
      mode: r.mode,
      simVersion: r.simVersion,
      stats: r.stats,
      replay: r.replay,
    };

  app.get('/replays/best', rateLimit('read', 'ip'), (c) => {
    const week = Number(c.req.query('week'));
    const player = c.req.query('player') ?? '';
    if (!Number.isSafeInteger(week) || !isAddress(player)) return c.json({ error: 'Permintaan tidak valid.' }, 400);
    const r = store.weeklyBestReplay(week, player);
    return r ? c.json(replayView(r)) : c.json({ error: 'Replay tidak ditemukan.' }, 404);
  });

  app.get('/replays/:id', rateLimit('read', 'ip'), (c) => {
    const r = store.getReplay(c.req.param('id'));
    return r ? c.json(replayView(r)) : c.json({ error: 'Replay tidak ditemukan.' }, 404);
  });

  app.get('/profiles', rateLimit('read', 'ip'), (c) => {
    const addresses = (c.req.query('addresses') ?? '').split(',').filter((a) => isAddress(a));
    if (addresses.length > MAX_PROFILE_LOOKUP) return c.json({ error: 'Terlalu banyak alamat.' }, 400);
    return c.json({ names: store.names(addresses) });
  });

  // The session proves wallet ownership, so the name is stored for that address only.
  app.post('/profile/name', maxBody(SMALL_BODY), requireSession, rateLimit('name', 'wallet'), async (c) => {
    const { address } = c.get('session');
    const body = await readJson(c);
    const name = typeof body?.name === 'string' ? sanitizeName(body.name) : '';
    if (name.length < 2) return c.json({ error: 'Nama minimal 2 karakter (huruf, angka, spasi, _ atau -).' }, 400);
    store.setName(address, name);
    return c.json({ name });
  });

  return app;
}
