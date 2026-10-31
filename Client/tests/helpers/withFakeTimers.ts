import { afterEach, beforeEach, vi } from "vitest";

/** Runs `body` under fake timers and always restores the real ones. */
export async function withFakeTimers(body: () => Promise<void> | void): Promise<void> {
  vi.useFakeTimers();
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Registers hooks that give each test an empty localStorage and fake timers;
 * `teardown` runs after each test, before the real timers return.
 */
export function useFakeClockAndStorage(teardown: () => void): void {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    teardown();
    vi.useRealTimers();
  });
}
