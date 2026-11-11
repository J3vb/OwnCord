import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fail: true, loads: 0 }));

vi.mock("@lib/dispatcher", () => {
  state.loads += 1;
  if (state.fail) throw new Error("chunk fetch failed");
  return { wireDispatcher: vi.fn(), wireConnectionStatus: vi.fn() };
});

import { loadDispatcher } from "../../src/app/sessionDispatcher";

describe("loadDispatcher", () => {
  it("forgets a failed load so the next sign-in retries, then reuses the loaded module", async () => {
    await expect(loadDispatcher()).rejects.toThrow();
    state.fail = false;
    const first = await loadDispatcher();
    const second = await loadDispatcher();
    expect(second).toBe(first);
    expect(typeof first.wireDispatcher).toBe("function");
    expect(state.loads).toBe(2);
  });
});
