import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RateLimiter,
  createRateLimiter,
  createRateLimiterSet,
  createTypingLimiter,
  createPresenceLimiter,
  createReactionLimiter,
  createVoiceLimiter,
  createSoundboardLimiter,
  createChatLimiter,
  createVideoCameraLimiter,
} from "@lib/rate-limiter";

// ---------------------------------------------------------------------------
// Core RateLimiter behaviour
// ---------------------------------------------------------------------------

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- Construction ---------------------------------------------------------

  it("throws when maxTokens < 1", () => {
    expect(() => new RateLimiter({ maxTokens: 0, windowMs: 1_000 })).toThrow(
      "maxTokens must be >= 1",
    );
  });

  it("throws when windowMs < 1", () => {
    expect(() => new RateLimiter({ maxTokens: 1, windowMs: 0 })).toThrow(
      "windowMs must be >= 1",
    );
  });

  // -- tryConsume -----------------------------------------------------------

  it("allows requests under the limit", () => {
    const limiter = createRateLimiter(3, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("blocks rapid-fire requests that exceed the limit", () => {
    const limiter = createRateLimiter(2, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("uses a default key when key is omitted", () => {
    const limiter = createRateLimiter(1, 1_000);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  // -- Per-key isolation ----------------------------------------------------

  it("isolates different keys", () => {
    const limiter = createRateLimiter(1, 1_000);
    expect(limiter.tryConsume("key1")).toBe(true);
    expect(limiter.tryConsume("key2")).toBe(true);
    // Both should be individually exhausted
    expect(limiter.tryConsume("key1")).toBe(false);
    expect(limiter.tryConsume("key2")).toBe(false);
  });

  // -- Window expiry --------------------------------------------------------

  it("allows new requests after window expires", () => {
    const limiter = createRateLimiter(1, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("sliding window allows staggered requests", () => {
    const limiter = createRateLimiter(2, 1_000);

    // t=0: consume first
    expect(limiter.tryConsume("a")).toBe(true);

    // t=500: consume second
    vi.advanceTimersByTime(500);
    expect(limiter.tryConsume("a")).toBe(true);

    // t=500: blocked (2 within window)
    expect(limiter.tryConsume("a")).toBe(false);

    // t=1001: first request expired, slot opens
    vi.advanceTimersByTime(501);
    expect(limiter.tryConsume("a")).toBe(true);
  });

  // -- reset ----------------------------------------------------------------

  it("reset(key) clears state for a specific key only", () => {
    const limiter = createRateLimiter(1, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("b")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);

    limiter.reset("a");

    expect(limiter.tryConsume("a")).toBe(true);
    // "b" should still be blocked
    expect(limiter.tryConsume("b")).toBe(false);
  });

  it("reset() without key clears the default key only", () => {
    const limiter = createRateLimiter(1, 1_000);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);

    limiter.reset();

    expect(limiter.tryConsume()).toBe(true);
  });

  // -- resetAll -------------------------------------------------------------

  it("resetAll() clears all keys", () => {
    const limiter = createRateLimiter(1, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("b")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("b")).toBe(false);

    limiter.resetAll();

    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("b")).toBe(true);
  });

  // -- getRemainingMs -------------------------------------------------------

  it("getRemainingMs returns 0 when under limit", () => {
    const limiter = createRateLimiter(5, 1_000);
    expect(limiter.getRemainingMs("a")).toBe(0);
  });

  it("getRemainingMs returns positive value when blocked", () => {
    const limiter = createRateLimiter(1, 1_000);
    limiter.tryConsume("a");

    const remaining = limiter.getRemainingMs("a");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(1_000);
  });

  it("getRemainingMs uses default key when omitted", () => {
    const limiter = createRateLimiter(1, 1_000);
    limiter.tryConsume();

    expect(limiter.getRemainingMs()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

describe("createRateLimiter", () => {
  it("creates a limiter with the specified config", () => {
    const limiter = createRateLimiter(3, 500);
    expect(limiter).toBeInstanceOf(RateLimiter);
    // Verify the config by consuming exactly 3 tokens
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pre-configured protocol limiters
// ---------------------------------------------------------------------------

describe("Pre-configured limiters", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createChatLimiter: 10 per 1s", () => {
    const limiter = createChatLimiter();
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume("user:1")).toBe(true);
    }
    expect(limiter.tryConsume("user:1")).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(limiter.tryConsume("user:1")).toBe(true);
  });

  it("createTypingLimiter: 1 per 3s", () => {
    const limiter = createTypingLimiter();
    expect(limiter.tryConsume("chan:5")).toBe(true);
    expect(limiter.tryConsume("chan:5")).toBe(false);

    // Still blocked just before 3s
    vi.advanceTimersByTime(2_999);
    expect(limiter.tryConsume("chan:5")).toBe(false);

    // Allowed after 3s
    vi.advanceTimersByTime(2);
    expect(limiter.tryConsume("chan:5")).toBe(true);
  });

  it("createPresenceLimiter: 1 per 10s", () => {
    const limiter = createPresenceLimiter();
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(10_001);
    expect(limiter.tryConsume()).toBe(true);
  });

  it("createReactionLimiter: 5 per 1s", () => {
    const limiter = createReactionLimiter();
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume()).toBe(true);
    }
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(limiter.tryConsume()).toBe(true);
  });

  it("createVoiceLimiter: 20 per 1s", () => {
    const limiter = createVoiceLimiter();
    for (let i = 0; i < 20; i++) {
      expect(limiter.tryConsume()).toBe(true);
    }
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(limiter.tryConsume()).toBe(true);
  });

  it("createVideoCameraLimiter: 2 per 1s", () => {
    const limiter = createVideoCameraLimiter();
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it("createSoundboardLimiter: 1 per 3s", () => {
    const limiter = createSoundboardLimiter();
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(3_001);
    expect(limiter.tryConsume()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RateLimiterSet
// ---------------------------------------------------------------------------

describe("createRateLimiterSet", () => {
  it("returns all expected limiter keys", () => {
    const set = createRateLimiterSet();
    const expectedKeys = [
      "chat",
      "typing",
      "presence",
      "reactions",
      "voice",
      "voiceVideo",
      "soundboard",
    ] as const;

    for (const key of expectedKeys) {
      expect(set[key]).toBeInstanceOf(RateLimiter);
    }
  });

  it("returns frozen object", () => {
    const set = createRateLimiterSet();
    expect(Object.isFrozen(set)).toBe(true);
  });
});
