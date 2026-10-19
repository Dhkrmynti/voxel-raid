// Token-bucket rate limiting. Each key gets `limit` requests per `windowMs`, refilled smoothly.
// Buckets live in memory, which is right for a single long-running server. Behind several
// instances (serverless, autoscaling) swap `createRateLimiter` for a shared store such as Redis
// with the same take() contract.

const MAX_BUCKETS = 50_000;

export function createRateLimiter({ now = Date.now } = {}) {
  const buckets = new Map();

  function sweep(t) {
    // Drop buckets that have fully refilled (each by its own window); they behave exactly
    // like a missing bucket.
    for (const [key, b] of buckets) if (t - b.at >= b.windowMs) buckets.delete(key);
    // Still full: evict the least recently used. Maps iterate in insertion order and take()
    // re-inserts on every use, so the first keys are the stalest.
    for (const key of buckets.keys()) {
      if (buckets.size < MAX_BUCKETS) break;
      buckets.delete(key);
    }
  }

  /**
   * Spends one request from `key`'s bucket.
   * @returns {{ ok: true } | { ok: false, retryAfter: number }} retryAfter in whole seconds
   */
  function take(key, { limit, windowMs }) {
    const t = now();
    const rate = limit / windowMs; // tokens per ms
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= MAX_BUCKETS) sweep(t);
      b = { tokens: limit, at: t, windowMs };
    } else {
      b.tokens = Math.min(limit, b.tokens + (t - b.at) * rate);
      b.at = t;
      buckets.delete(key); // re-inserted below, which keeps the map in least-recently-used order
    }
    buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)) };
  }

  return { take, size: () => buckets.size };
}
