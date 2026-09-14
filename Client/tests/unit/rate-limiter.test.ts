import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter, createRateLimiterSet, createPresenceLimiter } from "@lib/rate-limiter";

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
    expect(() => new RateLimiter(0, 1_000)).toThrow("maxTokens must be >= 1");
  });

  it("throws when windowMs < 1", () => {
    expect(() => new RateLimiter(1, 0)).toThrow("windowMs must be >= 1");
  });

  it("does not throw when windowMs is exactly 1 (boundary)", () => {
    expect(() => new RateLimiter(1, 1)).not.toThrow();
  });

  // -- tryConsume -----------------------------------------------------------

  it("allows requests under the limit", () => {
    const limiter = new RateLimiter(3, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("blocks rapid-fire requests that exceed the limit", () => {
    const limiter = new RateLimiter(2, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("uses a default key when key is omitted", () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  // -- Per-key isolation ----------------------------------------------------

  it("isolates different keys", () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.tryConsume("key1")).toBe(true);
    expect(limiter.tryConsume("key2")).toBe(true);
    // Both should be individually exhausted
    expect(limiter.tryConsume("key1")).toBe(false);
    expect(limiter.tryConsume("key2")).toBe(false);
  });

  // -- Window expiry --------------------------------------------------------

  it("allows new requests after window expires", () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter.tryConsume("a")).toBe(true);
  });

  it("sliding window allows staggered requests", () => {
    const limiter = new RateLimiter(2, 1_000);

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

  // -- getRemainingMs -------------------------------------------------------

  it("getRemainingMs returns 0 when under limit", () => {
    const limiter = new RateLimiter(5, 1_000);
    expect(limiter.getRemainingMs("a")).toBe(0);
  });

  it("getRemainingMs returns positive value when blocked", () => {
    const limiter = new RateLimiter(1, 1_000);
    limiter.tryConsume("a");

    const remaining = limiter.getRemainingMs("a");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(1_000);
  });

  it("getRemainingMs uses default key when omitted", () => {
    const limiter = new RateLimiter(1, 1_000);
    limiter.tryConsume();

    expect(limiter.getRemainingMs()).toBeGreaterThan(0);
  });

  it("getRemainingMs returns 0 when under limit despite prior activity in the window", () => {
    // maxTokens=3 with only 1 consumed: timestamps.length (1) < maxTokens (3)
    // is true, so the under-limit guard must return 0 immediately rather than
    // falling through to the oldest-timestamp math below it (which would
    // wrongly report a positive wait here).
    const limiter = new RateLimiter(3, 1_000);
    limiter.tryConsume("a");

    expect(limiter.getRemainingMs("a")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createPresenceLimiter — exported on its own for presence-sender.test.ts /
// status-picker-userbar.test.ts, which construct one outside the bundled set.
// ---------------------------------------------------------------------------

describe("createPresenceLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1 per 10s", () => {
    const limiter = createPresenceLimiter();
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);

    vi.advanceTimersByTime(10_001);
    expect(limiter.tryConsume()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RateLimiterSet — verifies the protocol budgets baked into the set literal
// ---------------------------------------------------------------------------

describe("createRateLimiterSet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns all expected limiter keys", () => {
    const set = createRateLimiterSet();
    const expectedKeys = ["typing", "presence", "reactions", "voice", "voiceVideo"] as const;

    for (const key of expectedKeys) {
      expect(set[key]).toBeInstanceOf(RateLimiter);
    }
  });

  it("returns frozen object", () => {
    const set = createRateLimiterSet();
    expect(Object.isFrozen(set)).toBe(true);
  });

  it("typing: 1 per 3s", () => {
    const { typing } = createRateLimiterSet();
    expect(typing.tryConsume("chan:5")).toBe(true);
    expect(typing.tryConsume("chan:5")).toBe(false);

    // Still blocked just before 3s
    vi.advanceTimersByTime(2_999);
    expect(typing.tryConsume("chan:5")).toBe(false);

    // Allowed after 3s
    vi.advanceTimersByTime(2);
    expect(typing.tryConsume("chan:5")).toBe(true);
  });

  it("reactions: 5 per 1s", () => {
    const { reactions } = createRateLimiterSet();
    for (let i = 0; i < 5; i++) {
      expect(reactions.tryConsume()).toBe(true);
    }
    expect(reactions.tryConsume()).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(reactions.tryConsume()).toBe(true);
  });

  // voice gates onMuteToggle/onDeafenToggle (VoiceCallbacks.ts), which send
  // voice_mute / voice_deafen. The server caps each of those at 2/sec
  // (Server/ws/voice_broadcast.go voiceMuteRateLimit/voiceDeafenRateLimit,
  // docs/protocol.md). The client limit must not exceed that budget, or an
  // over-budget toggle applies its optimistic local state before the server
  // refuses the send.
  it("voice: 2 per 1s (matches the server's voice_mute/voice_deafen budget)", () => {
    const { voice } = createRateLimiterSet();
    expect(voice.tryConsume()).toBe(true);
    expect(voice.tryConsume()).toBe(true);
    expect(voice.tryConsume()).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(voice.tryConsume()).toBe(true);
  });

  it("voiceVideo: 2 per 1s", () => {
    const { voiceVideo } = createRateLimiterSet();
    expect(voiceVideo.tryConsume()).toBe(true);
    expect(voiceVideo.tryConsume()).toBe(true);
    expect(voiceVideo.tryConsume()).toBe(false);
  });
});
