/**
 * Per-key rate limiting: a plain sliding window held in memory.
 *
 * Two honest caveats, both worth documenting wherever the server is documented:
 *
 *  - it is per process, so the effective ceiling across a fanned-out serverless
 *    deployment is (limit × instances). That is fine for what it guards against
 *    — a runaway agent loop hammering one connection — and it costs no round
 *    trip on the hot path.
 *  - it resets on cold start.
 *
 * The durable backstop in production is a per-key counter on the API key row,
 * which survives restarts and is shared across instances. This limiter is the
 * friendly, fast, write-shaped one.
 */

export interface RateWindow {
  limit: number;
  windowMs: number;
}

const HOUR = 60 * 60 * 1000;

/** Generous on purpose: an agent building a game should never feel this. */
export const RATE_LIMITS = {
  /** Anything that changes state, per API key. */
  write: { limit: 60, windowMs: HOUR },
  /** Reads on behalf of a key. */
  read: { limit: 600, windowMs: HOUR },
  /** Keyless public reads, counted per client. */
  anonymous: { limit: 120, windowMs: HOUR },
} as const satisfies Record<string, RateWindow>;

export type RateKind = keyof typeof RATE_LIMITS;

export type RateDecision =
  | { allowed: true; remaining: number; resetInMs: number }
  | { allowed: false; remaining: 0; resetInMs: number };

/** Timestamps of the hits inside the current window, per bucket key. */
export type RateStore = Map<string, number[]>;

export function createRateStore(): RateStore {
  return new Map();
}

/**
 * Record a hit and decide whether it is allowed. Pure apart from mutating the
 * store you hand it, which is what makes it testable without faking timers.
 */
export function consume(
  store: RateStore,
  key: string,
  window: RateWindow,
  now: number = Date.now(),
): RateDecision {
  const cutoff = now - window.windowMs;
  const hits = (store.get(key) ?? []).filter((t) => t > cutoff);

  if (hits.length >= window.limit) {
    store.set(key, hits);
    const oldest = hits[0] ?? now;
    return { allowed: false, remaining: 0, resetInMs: Math.max(0, oldest + window.windowMs - now) };
  }

  hits.push(now);
  store.set(key, hits);

  // Opportunistic sweep: without it a long-lived process holds a bucket for
  // every key it ever saw. Cheap, because it only runs as the map grows.
  if (store.size > 5_000) sweep(store, now, window.windowMs);

  return { allowed: true, remaining: window.limit - hits.length, resetInMs: window.windowMs };
}

function sweep(store: RateStore, now: number, windowMs: number): void {
  for (const [key, hits] of store) {
    const live = hits.filter((t) => t > now - windowMs);
    if (live.length === 0) store.delete(key);
    else store.set(key, live);
  }
}

/** Human copy for a refusal. Agents read these; make them actionable. */
export function rateLimitMessage(kind: RateKind, decision: RateDecision): string {
  const minutes = Math.max(1, Math.ceil(decision.resetInMs / 60_000));
  if (kind === 'anonymous') {
    return `Rate limit reached for anonymous access (${RATE_LIMITS.anonymous.limit} calls/hour). Wait about ${minutes} minute(s), or create an API key at https://aimade.games/settings for a much higher limit.`;
  }
  return `Rate limit reached: ${RATE_LIMITS[kind].limit} ${kind} calls per hour for this API key. Try again in about ${minutes} minute(s).`;
}

/** A limiter bound to one store, which is what the server actually holds. */
export function createLimiter(store: RateStore = createRateStore()) {
  return {
    store,
    check(kind: RateKind, bucket: string, now?: number): RateDecision {
      return consume(store, `${kind}:${bucket}`, RATE_LIMITS[kind], now);
    },
    reset(): void {
      store.clear();
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
