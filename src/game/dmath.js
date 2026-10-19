// Deterministic math for the simulation.
// Math.sin/cos/atan2/exp/hypot are "implementation-approximated" in ECMAScript: V8, SpiderMonkey
// and JavaScriptCore may differ in the last bit, and in a simulation those bits snowball. These
// versions use only + - * / and sqrt (exactly rounded IEEE-754 operations), so a run replays
// bit-for-bit in every browser and on the server.

const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const TWO_PI = 6.283185307179586;
const LN2 = 0.6931471805599453;

/** sin(x) via range reduction to [-π/2, π/2] and a Taylor series to x^17 (error < 1e-12). */
export function dsin(x) {
  let r = x - TWO_PI * Math.round(x / TWO_PI);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const r2 = r * r;
  return (
    r *
    (1 +
      r2 *
        (-1 / 6 +
          r2 *
            (1 / 120 +
              r2 *
                (-1 / 5040 +
                  r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800 + r2 * (-1 / 1307674368000 + r2 / 355687428096000))))))))
  );
}

export function dcos(x) {
  return dsin(x + HALF_PI);
}

/** atan(z) for any z, using two half-angle reductions so the series converges fast. */
function datan(z) {
  if (z < 0) return -datan(-z);
  if (z > 1) return HALF_PI - datan(1 / z);
  // atan(z) = 2·atan(z / (1 + sqrt(1 + z²))), applied twice brings z below ~0.2
  let t = z / (1 + Math.sqrt(1 + z * z));
  t = t / (1 + Math.sqrt(1 + t * t));
  const t2 = t * t;
  let sum = 0;
  for (let k = 12; k >= 0; k--) sum = (k % 2 ? -1 : 1) / (2 * k + 1) + t2 * sum;
  return 4 * t * sum;
}

export function datan2(y, x) {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

/** e^x via x = k·ln2 + r with |r| ≤ ln2/2 and a Taylor series for e^r. */
export function dexp(x) {
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= 20; i++) {
    term = (term * r) / i;
    sum += term;
  }
  let scale = 1;
  const base = k < 0 ? 0.5 : 2;
  for (let i = 0; i < Math.abs(k); i++) scale *= base;
  return sum * scale;
}

export function dhypot(x, y, z = 0) {
  return Math.sqrt(x * x + y * y + z * z);
}
