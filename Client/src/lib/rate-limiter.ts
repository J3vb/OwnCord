/**
 * Window-based rate limiter with per-key tracking.
 *
 * Uses a sliding window algorithm: each key stores an array of timestamps.
 * Expired entries are pruned on every public call. No external dependencies.
 */

// ---------------------------------------------------------------------------
// Default key used when callers omit the key argument
// ---------------------------------------------------------------------------

const DEFAULT_KEY = "__default__";

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly state = new Map<string, number[]>();

  constructor(
    private readonly maxTokens: number,
    private readonly windowMs: number,
  ) {
    if (maxTokens < 1) {
      // i18n-exempt: internal configuration guard, never rendered
      throw new Error("maxTokens must be >= 1");
    }
    if (windowMs < 1) {
      // i18n-exempt: internal configuration guard, never rendered
      throw new Error("windowMs must be >= 1");
    }
  }

  /**
   * Attempt to consume one token for the given key.
   * Returns `true` if the action is allowed, `false` if rate-limited.
   */
  tryConsume(key: string = DEFAULT_KEY): boolean {
    const now = Date.now();
    const timestamps = this.prune(key, now);

    if (timestamps.length >= this.maxTokens) {
      return false;
    }

    timestamps.push(now);
    this.state.set(key, timestamps);
    return true;
  }

  /**
   * Returns milliseconds until the next request would be allowed for the key.
   * Returns 0 if a request is allowed right now.
   */
  getRemainingMs(key: string = DEFAULT_KEY): number {
    const now = Date.now();
    const timestamps = this.prune(key, now);

    if (timestamps.length < this.maxTokens) {
      return 0;
    }

    const oldest = timestamps[0];
    if (oldest === undefined) {
      return 0;
    }
    return Math.max(0, oldest + this.windowMs - now);
  }

  /** Remove expired timestamps for a key and return its live array. */
  private prune(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const filtered = (this.state.get(key) ?? []).filter((t) => t > cutoff);
    if (filtered.length > 0) {
      this.state.set(key, filtered);
    } else {
      this.state.delete(key);
    }
    return filtered;
  }
}

// ---------------------------------------------------------------------------
// Pre-configured limiters (PROTOCOL.md - Rate Limits)
// ---------------------------------------------------------------------------

/**
 * Presence updates: 1 per 10 seconds.
 *
 * Exported on its own (not just inlined into `createRateLimiterSet`) because
 * presence-sender.test.ts and status-picker-userbar.test.ts also construct a
 * limiter with this exact budget directly, outside the bundled set.
 */
export function createPresenceLimiter(): RateLimiter {
  return new RateLimiter(1, 10_000);
}

// ---------------------------------------------------------------------------
// Bundled set of all protocol limiters
// ---------------------------------------------------------------------------

export interface RateLimiterSet {
  readonly typing: RateLimiter;
  readonly presence: RateLimiter;
  readonly reactions: RateLimiter;
  readonly voice: RateLimiter;
  readonly voiceVideo: RateLimiter;
}

export function createRateLimiterSet(): RateLimiterSet {
  return Object.freeze({
    // Typing events: 1 per 3 seconds (use channel id as key).
    typing: new RateLimiter(1, 3_000),
    presence: createPresenceLimiter(),
    // Reactions: 5 per second.
    reactions: new RateLimiter(5, 1_000),
    // Voice mute/deafen toggle: 2 per second — matches the server's
    // per-message budget for voice_mute and voice_deafen
    // (Server/ws/voice_broadcast.go voiceMuteRateLimit/voiceDeafenRateLimit;
    // docs/protocol.md). Gates onMuteToggle/onDeafenToggle
    // (VoiceCallbacks.ts), which apply optimistic local state before the
    // send — a looser client cap would let an over-budget toggle apply
    // locally before the server refuses it.
    voice: new RateLimiter(2, 1_000),
    // Voice camera / screenshare toggle: 2 per second.
    voiceVideo: new RateLimiter(2, 1_000),
  });
}
