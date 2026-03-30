import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAppLogDir,
  mockJoin,
  mockExists,
  mockMkdir,
  mockWriteTextFile,
  mockReadDir,
  mockRemove,
  mockReadTextFile,
  mockAddLogListener,
} = vi.hoisted(() => ({
  mockAppLogDir: vi.fn().mockResolvedValue("/mock/logs"),
  mockJoin: vi.fn((...parts: string[]) => parts.join("/")),
  mockExists: vi.fn().mockResolvedValue(true),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteTextFile: vi.fn().mockResolvedValue(undefined),
  mockReadDir: vi.fn().mockResolvedValue([]),
  mockRemove: vi.fn().mockResolvedValue(undefined),
  mockReadTextFile: vi.fn().mockResolvedValue(""),
  mockAddLogListener: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  appLogDir: mockAppLogDir,
  join: mockJoin,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: mockMkdir,
  writeTextFile: mockWriteTextFile,
  readDir: mockReadDir,
  remove: mockRemove,
  exists: mockExists,
  readTextFile: mockReadTextFile,
}));

vi.mock("@lib/logger", () => ({
  addLogListener: mockAddLogListener,
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { clearPendingPersistedLogs, initLogPersistence } from "@lib/logPersistence";

describe("log persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockAppLogDir.mockClear();
    mockJoin.mockClear();
    mockExists.mockClear();
    mockExists.mockResolvedValue(true);
    mockMkdir.mockClear();
    mockWriteTextFile.mockClear();
    mockReadDir.mockClear();
    mockReadDir.mockResolvedValue([]);
    mockRemove.mockClear();
    mockReadTextFile.mockClear();
    mockAddLogListener.mockClear();
  });

  it("waits for an in-progress flush before clearing pending persisted logs", async () => {
    let listener: ((entry: unknown) => void) | null = null;
    mockAddLogListener.mockImplementation((cb) => {
      listener = cb;
      return () => {};
    });

    let resolveWrite: (() => void) | null = null;
    mockWriteTextFile.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));

    await initLogPersistence();
    listener?.({ level: "info", message: "before clear", component: "test", timestamp: new Date().toISOString() });

    await vi.advanceTimersByTimeAsync(2000);
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1);

    let settled = false;
    const clearPromise = clearPendingPersistedLogs().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveWrite?.();
    await clearPromise;
    expect(settled).toBe(true);
  });
});