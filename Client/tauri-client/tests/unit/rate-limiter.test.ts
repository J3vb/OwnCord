import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimiter, createRateLimiterSet } from '../../src/lib/rate-limiter';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('allows requests under limit', () => {
    const limiter = new RateLimiter(3, 1_000);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(true);
  });

  it('blocks requests at limit', () => {
    const limiter = new RateLimiter(2, 1_000);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });

  it('resets after window expires', () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);

    vi.advanceTimersByTime(1_001);

    expect(limiter.tryConsume('a')).toBe(true);
  });

  it('isolates different keys', () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.tryConsume('key1')).toBe(true);
    expect(limiter.tryConsume('key2')).toBe(true);
    expect(limiter.tryConsume('key1')).toBe(false);
    expect(limiter.tryConsume('key2')).toBe(false);
  });

  it('reset(key) clears state for a specific key', () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);

    limiter.reset('a');

    expect(limiter.tryConsume('a')).toBe(true);
    // 'b' should still be blocked
    expect(limiter.tryConsume('b')).toBe(false);
  });

  it('reset() without key clears all state', () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);

    limiter.reset();

    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('b')).toBe(true);
  });

  it('getRemainingMs returns 0 when allowed', () => {
    const limiter = new RateLimiter(5, 1_000);
    expect(limiter.getRemainingMs('a')).toBe(0);
  });

  it('getRemainingMs returns positive value when blocked', () => {
    const limiter = new RateLimiter(1, 1_000);
    limiter.tryConsume('a');

    const remaining = limiter.getRemainingMs('a');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(1_000);
  });
});

describe('createRateLimiterSet', () => {
  it('returns all expected keys', () => {
    const set = createRateLimiterSet();
    const expectedKeys = [
      'chat',
      'typing',
      'presence',
      'reactions',
      'voice',
      'voiceVideo',
      'soundboard',
    ];
    for (const key of expectedKeys) {
      expect(set).toHaveProperty(key);
      expect(set[key as keyof typeof set]).toBeInstanceOf(RateLimiter);
    }
  });

  it('typing limiter blocks at 1/3s rate', () => {
    vi.useFakeTimers();
    const set = createRateLimiterSet();

    expect(set.typing.tryConsume('chan:5')).toBe(true);
    expect(set.typing.tryConsume('chan:5')).toBe(false);

    vi.advanceTimersByTime(2_999);
    expect(set.typing.tryConsume('chan:5')).toBe(false);

    vi.advanceTimersByTime(2);
    expect(set.typing.tryConsume('chan:5')).toBe(true);
  });

  it('chat limiter allows 10/sec', () => {
    vi.useFakeTimers();
    const set = createRateLimiterSet();

    for (let i = 0; i < 10; i++) {
      expect(set.chat.tryConsume('user:1')).toBe(true);
    }
    expect(set.chat.tryConsume('user:1')).toBe(false);

    vi.advanceTimersByTime(1_001);
    expect(set.chat.tryConsume('user:1')).toBe(true);
  });
});
