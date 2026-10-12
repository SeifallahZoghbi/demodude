// Every cap the service enforces lives here so the numbers are easy to audit and
// tests can reference the same constants instead of re-typing magic values.

export const LIMITS = {
  /** Model calls allowed per session; the next one is rejected. */
  maxModelCallsPerSession: 60,
  /** A session with no turn for this long is marked expired. */
  idleExpiryMs: 30 * 60 * 1000,
  /** History kept per session; older turns are dropped (pairs kept intact). */
  maxHistoryMessages: 40,
  /** New sessions per IP per window. */
  sessionsPerIp: 10,
  sessionsPerIpWindowMs: 60 * 60 * 1000,
  /** Visitor text per turn. */
  maxUserTextChars: 1000,
  /** Serialised app state per turn (the protocol asks apps for ~300). */
  maxStateChars: 600,
  /** Model request shape. */
  maxOutputTokens: 1024,
} as const;

export interface RateLimiter {
  /** Returns true when the key is still under the cap for the current window. */
  allow(key: string): boolean;
}

// Fixed-window counter kept in memory: a single-process service does not need
// anything shared, and a restart simply resets the counts.
export function createRateLimiter(opts: {
  max: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, { windowStart: number; count: number }>();

  function prune(t: number): void {
    for (const [key, bucket] of buckets) {
      if (t - bucket.windowStart >= opts.windowMs) buckets.delete(key);
    }
  }

  return {
    allow(key) {
      const t = now();
      if (buckets.size > 10_000) prune(t);
      const bucket = buckets.get(key);
      if (!bucket || t - bucket.windowStart >= opts.windowMs) {
        buckets.set(key, { windowStart: t, count: 1 });
        return true;
      }
      if (bucket.count >= opts.max) return false;
      bucket.count += 1;
      return true;
    },
  };
}
