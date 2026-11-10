/**
 * In-memory rate limiting.
 *
 * Deliberately simple: a sliding window per key, held on globalThis so a hot
 * reload does not reset everyone's counter. It is per-process, so behind more
 * than one instance it limits per instance — good enough to stop password
 * guessing from a browser, not a substitute for a shared store at scale.
 */
type Hit = { count: number; resetAt: number };

const store = (globalThis as unknown as { __rl?: Map<string, Hit> }).__rl ??= new Map<string, Hit>();

export type Verdict = { ok: true } | { ok: false; retryAfter: number };

export function rateLimit(key: string, limit: number, windowMs: number): Verdict {
  const now = Date.now();
  const hit = store.get(key);

  if (!hit || hit.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (hit.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((hit.resetAt - now) / 1000) };
  }
  hit.count++;
  return { ok: true };
}

/** Forget a key — called after a successful login so one typo is not punished. */
export function clearLimit(key: string): void {
  store.delete(key);
}

/**
 * Best-effort client address.
 *
 * Only trusts proxy headers when TRUST_PROXY is set: otherwise anyone could
 * send X-Forwarded-For and get a fresh bucket per request, which would make
 * the limiter worse than useless.
 */
export function clientKey(req: Request): string {
  if (process.env.TRUST_PROXY === "1") {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]!.trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return "local";
}

// Periodically drop expired buckets so the map cannot grow without bound.
const g = globalThis as unknown as { __rlSweep?: NodeJS.Timeout };
g.__rlSweep ??= setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.resetAt <= now) store.delete(k);
}, 60_000).unref?.() as unknown as NodeJS.Timeout;
