import { afterEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ create: vi.fn(), warn: vi.fn() }));

// A fresh module graph per case must not re-run the real logger's own setup.
vi.mock("../../lib/logger", () => ({
  createLogger: (name: string) => {
    log.create(name);
    return { debug: vi.fn(), info: vi.fn(), warn: log.warn, error: vi.fn() };
  },
}));

afterEach(() => {
  vi.doUnmock("./sendQueue");
  vi.resetModules();
  log.create.mockClear();
  log.warn.mockClear();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("sendQueue loader", () => {
  it("loads the module once and hands every caller the same one", async () => {
    const { loadSendQueue } = await import("./sendQueueLoader");
    const first = await loadSendQueue();
    expect(await loadSendQueue()).toBe(first);
    expect(typeof first.runQueuedSend).toBe("function");
  });

  it("forgets a failed load, so the next call imports again", async () => {
    vi.resetModules();
    vi.doMock("./sendQueue", () => {
      throw new Error("chunk failed");
    });
    const { loadSendQueue, preloadSendQueue } = await import("./sendQueueLoader");
    await expect(loadSendQueue()).rejects.toThrow();
    // A preload that fails is logged, never thrown.
    expect(() => preloadSendQueue()).not.toThrow();

    vi.doUnmock("./sendQueue");
    vi.doMock("./sendQueue", () => ({ runQueuedSend: vi.fn() }));
    const loaded = await loadSendQueue();
    expect(typeof loaded.runQueuedSend).toBe("function");
  });

  it("logs under the send-queue tag", async () => {
    await import("./sendQueueLoader");
    expect(log.create).toHaveBeenCalledExactlyOnceWith("send-queue");
  });

  it("starts the import as soon as a preload is asked for", async () => {
    const factory = vi.fn(() => ({ runQueuedSend: vi.fn() }));
    vi.doMock("./sendQueue", factory);
    const { loadSendQueue, preloadSendQueue } = await import("./sendQueueLoader");
    preloadSendQueue();
    await settle();
    expect(factory).toHaveBeenCalledTimes(1);
    // The later send finds it loaded: no second import.
    await loadSendQueue();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a failed preload with the reason instead of throwing", async () => {
    vi.doMock("./sendQueue", () => {
      throw new Error("chunk failed");
    });
    const { preloadSendQueue } = await import("./sendQueueLoader");
    preloadSendQueue();
    await settle();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("Send queue preload failed", {
      error: expect.stringContaining("Error") as unknown,
    });
  });
});
