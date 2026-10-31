import { vi } from "vitest";

/** Runs `body` under fake timers and always restores the real ones. */
export async function withFakeTimers(body: () => Promise<void> | void): Promise<void> {
  vi.useFakeTimers();
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}
