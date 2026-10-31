import { vi } from "vitest";

/** Wraps a test body so it runs under fake timers and restores real ones afterwards. */
export function fakeTimersTest(body: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    vi.useFakeTimers();
    try {
      await body();
    } finally {
      vi.useRealTimers();
    }
  };
}
