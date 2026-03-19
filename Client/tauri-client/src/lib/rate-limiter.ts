/**
 * Window-based rate limiter with per-key tracking.
 *
 * Uses a sliding window algorithm: each key stores an array of timestamps.
 * Expired entries are pruned on every public call. No external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimiterConfig {
  /** Maximum number of actions allowed per window. */
  readonly maxTokens: number;
  /** Window duration in milliseconds. */
  readonly windowMs: number;
}

interface KeyState {
  readonly timestamps: readonly number[];
}

// ---------------------------------------------------------------------------
// Default key used when callers omit the key argument
// ---------------------------------------------------------------------------

const DEFAULT_KEY = "__default__" as const;

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly config: Readonly<RateLimiterConfig>;
  private state: ReadonlyMap<string, KeyState>;

  constructor(config: RateLimiterConfig) {
    if (config.maxTokens < 1) {
      throw new Error("maxTokens must be >= 1");
    }
    if (config.windowMs < 1) {
      throw new Error("windowMs must be >= 1");
    }
    this.config = Object.freeze({ ...config });
    this.state = new Map();
  }

  /**
   * Attempt to consume one token for the given key.
   * Returns `true` if the action is allowed, `false` if rate-limited.
   */
  tryConsume(key?: string): boolean {
    const k = key ?? DEFAULT_KEY;
    const now = Date.now();
    const cleaned = this.pruneAll(now);
    const entry = cleaned.get(k);
    const timestamps = entry?.timestamps ?? [];

    if (timestamps.length >= this.config.maxTokens) {
      this.state = cleaned;
      return false;
    }

    const newEntry: KeyState = { timestamps: [...timestamps, now] };
    const next = new Map(cleaned);
    next.set(k, Object.freeze(newEntry));
    this.state = next;
    return true;
  }

  /** Reset state for a single key (or the default key when omitted). */
  reset(key?: string): void {
    const k = key ?? DEFAULT_KEY;
    const next = new Map(this.state);
    next.delete(k);
    this.state = next;
  }

  /** Clear all tracked state across every key. */
  resetAll(): void {
    this.state = new Map();
  }

  /**
   * Returns milliseconds until the next request would be allowed for the key.
   * Returns 0 if a request is allowed right now.
   */
  getRemainingMs(key?: string): number {
    const k = key ?? DEFAULT_KEY;
    const now = Date.now();
    const cleaned = this.pruneAll(now);
    this.state = cleaned;

    const entry = cleaned.get(k);
    const timestamps = entry?.timestamps ?? [];

    if (timestamps.length < this.config.maxTokens) {
      return 0;
    }

    const oldest = timestamps[0];
    if (oldest === undefined) {
      return 0;
    }
    return Math.max(0, oldest + this.config.windowMs - now);
  }

  /** Return a new map with expired timestamps removed from every key. */
  private pruneAll(now: number): ReadonlyMap<string, KeyState> {
    const cutoff = now - this.config.windowMs;
    const next = new Map<string, KeyState>();

    for (const [key, entry] of this.state) {
      const filtered = entry.timestamps.filter((t) => t > cutoff);
      if (filtered.length > 0) {
        next.set(key, Object.freeze({ timestamps: filtered }));
      }
    }

    return next;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `RateLimiter` from explicit config values.
 *
 * @param maxTokens  Maximum actions per window.
 * @param windowMs   Window length in milliseconds.
 */
export function createRateLimiter(maxTokens: number, windowMs: number): RateLimiter {
  return new RateLimiter({ maxTokens, windowMs });
}

// ---------------------------------------------------------------------------
// Pre-configured limiters (PROTOCOL.md - Rate Limits)
// ---------------------------------------------------------------------------

/** Chat messages: 10 per second. */
export function createChatLimiter(): RateLimiter {
  return createRateLimiter(10, 1_000);
}

/** Typing events: 1 per 3 seconds (use channel id as key). */
export function createTypingLimiter(): RateLimiter {
  return createRateLimiter(1, 3_000);
}

/** Presence updates: 1 per 10 seconds. */
export function createPresenceLimiter(): RateLimiter {
  return createRateLimiter(1, 10_000);
}

/** Reactions: 5 per second. */
export function createReactionLimiter(): RateLimiter {
  return createRateLimiter(5, 1_000);
}

/** Voice signaling: 20 per second. */
export function createVoiceLimiter(): RateLimiter {
  return createRateLimiter(20, 1_000);
}

/** Voice camera / screenshare toggle: 2 per second. */
export function createVideoCameraLimiter(): RateLimiter {
  return createRateLimiter(2, 1_000);
}

/** Soundboard: 1 per 3 seconds. */
export function createSoundboardLimiter(): RateLimiter {
  return createRateLimiter(1, 3_000);
}

// ---------------------------------------------------------------------------
// Bundled set of all protocol limiters
// ---------------------------------------------------------------------------

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
  return Object.freeze({
    chat: createChatLimiter(),
    typing: createTypingLimiter(),
    presence: createPresenceLimiter(),
    reactions: createReactionLimiter(),
    voice: createVoiceLimiter(),
    voiceVideo: createVideoCameraLimiter(),
    soundboard: createSoundboardLimiter(),
  });
}
