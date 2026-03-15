/**
 * Per-key rate limiter with sliding window tracking.
 *
 * Internally stores an array of timestamps per key.
 * Expired entries are cleaned on every public method call.
 */

interface KeyState {
  readonly timestamps: readonly number[];
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private state: ReadonlyMap<string, KeyState>;

  constructor(maxRequests: number, windowMs: number) {
    if (maxRequests < 1) {
      throw new Error('maxRequests must be >= 1');
    }
    if (windowMs < 1) {
      throw new Error('windowMs must be >= 1');
    }
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.state = new Map();
  }

  /**
   * Attempt to consume one request for the given key.
   * Returns true if the request is allowed, false if rate-limited.
   */
  tryConsume(key: string): boolean {
    const now = Date.now();
    const cleaned = this.cleanupAll(now);
    const entry = cleaned.get(key);
    const timestamps = entry?.timestamps ?? [];

    if (timestamps.length >= this.maxRequests) {
      this.state = cleaned;
      return false;
    }

    const newEntry: KeyState = {
      timestamps: [...timestamps, now],
    };
    const next = new Map(cleaned);
    next.set(key, newEntry);
    this.state = next;
    return true;
  }

  /**
   * Reset rate limit state for a specific key, or all keys if none provided.
   */
  reset(key?: string): void {
    if (key === undefined) {
      this.state = new Map();
      return;
    }
    const next = new Map(this.state);
    next.delete(key);
    this.state = next;
  }

  /**
   * Returns milliseconds until the next request would be allowed for the key.
   * Returns 0 if a request is allowed right now.
   */
  getRemainingMs(key: string): number {
    const now = Date.now();
    const cleaned = this.cleanupAll(now);
    this.state = cleaned;

    const entry = cleaned.get(key);
    const timestamps = entry?.timestamps ?? [];

    if (timestamps.length < this.maxRequests) {
      return 0;
    }

    // The oldest timestamp in the window determines when the next slot opens
    const oldest = timestamps[0];
    if (oldest === undefined) {
      return 0;
    }
    const remaining = oldest + this.windowMs - now;
    return Math.max(0, remaining);
  }

  /**
   * Return a new map with expired timestamps removed from every key.
   */
  private cleanupAll(now: number): ReadonlyMap<string, KeyState> {
    const cutoff = now - this.windowMs;
    const next = new Map<string, KeyState>();

    for (const [key, entry] of this.state) {
      const filtered = entry.timestamps.filter((t) => t > cutoff);
      if (filtered.length > 0) {
        next.set(key, { timestamps: filtered });
      }
    }

    return next;
  }
}

/**
 * Pre-configured rate limiters matching PROTOCOL.md limits.
 */
export interface RateLimiterSet {
  readonly chat: RateLimiter;
  readonly typing: RateLimiter;
  readonly presence: RateLimiter;
  readonly reactions: RateLimiter;
  readonly voice: RateLimiter;
  readonly voiceVideo: RateLimiter;
  readonly soundboard: RateLimiter;
}

export function createRateLimiterSet(): RateLimiterSet {
  return {
    chat: new RateLimiter(10, 1_000),
    typing: new RateLimiter(1, 3_000),
    presence: new RateLimiter(1, 10_000),
    reactions: new RateLimiter(5, 1_000),
    voice: new RateLimiter(20, 1_000),
    voiceVideo: new RateLimiter(2, 1_000),
    soundboard: new RateLimiter(1, 3_000),
  };
}
