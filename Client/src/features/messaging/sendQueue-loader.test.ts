import { afterEach, describe, expect, it, vi } from "vitest";

// A fresh module graph per case must not re-run the real logger's own setup.
vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => {
  vi.doUnmock("./sendQueue");
  vi.resetModules();
});

describe("sendQueue loader", () => {
  it("loads the module once and hands every caller the same one", async () => {
    const { loadSendQueue } = await import("./sendQueue-loader");
    const first = await loadSendQueue();
    expect(await loadSendQueue()).toBe(first);
    expect(typeof first.runQueuedSend).toBe("function");
  });

  it("forgets a failed load, so the next call imports again", async () => {
    vi.resetModules();
    vi.doMock("./sendQueue", () => {
      throw new Error("chunk failed");
    });
    const { loadSendQueue, preloadSendQueue } = await import("./sendQueue-loader");
    await expect(loadSendQueue()).rejects.toThrow();
    // A preload that fails is logged, never thrown.
    expect(() => preloadSendQueue()).not.toThrow();

    vi.doUnmock("./sendQueue");
    vi.doMock("./sendQueue", () => ({ runQueuedSend: vi.fn() }));
    const loaded = await loadSendQueue();
    expect(typeof loaded.runQueuedSend).toBe("function");
  });
});
