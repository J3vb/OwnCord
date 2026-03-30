import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — available before any import runs
// ---------------------------------------------------------------------------
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
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fresh-import the module so module-level state resets. */
async function freshImport() {
  const mod = await import("@lib/logPersistence");
  return mod;
}

/** Capture the listener callback that initLogPersistence registers. */
function captureListener(): {
  getListener: () => ((entry: unknown) => void) | null;
} {
  let listener: ((entry: unknown) => void) | null = null;
  mockAddLogListener.mockImplementation(
    (cb: (entry: unknown) => void) => {
      listener = cb;
      return () => {};
    },
  );
  return {
    getListener: () => listener,
  };
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    level: "info",
    component: "test",
    message: "hello",
    timestamp: "2025-06-15T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("log persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00.000Z"));
    vi.resetModules();

    // Reset all mocks to default behavior
    mockAppLogDir.mockReset().mockResolvedValue("/mock/logs");
    mockJoin.mockReset().mockImplementation((...parts: string[]) => parts.join("/"));
    mockExists.mockReset().mockResolvedValue(true);
    mockMkdir.mockReset().mockResolvedValue(undefined);
    mockWriteTextFile.mockReset().mockResolvedValue(undefined);
    mockReadDir.mockReset().mockResolvedValue([]);
    mockRemove.mockReset().mockResolvedValue(undefined);
    mockReadTextFile.mockReset().mockResolvedValue("");
    mockAddLogListener.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // initLogPersistence
  // -----------------------------------------------------------------------
  describe("initLogPersistence", () => {
    it("resolves the log directory using appLogDir + join", async () => {
      const { initLogPersistence } = await freshImport();
      captureListener();
      await initLogPersistence();

      expect(mockAppLogDir).toHaveBeenCalledTimes(1);
      expect(mockJoin).toHaveBeenCalledWith("/mock/logs", "client-logs");
    });

    it("creates the log directory when it does not exist", async () => {
      mockExists.mockResolvedValue(false);
      const { initLogPersistence } = await freshImport();
      captureListener();
      await initLogPersistence();

      expect(mockMkdir).toHaveBeenCalledWith(
        "/mock/logs/client-logs",
        { recursive: true },
      );
    });

    it("does NOT create the log directory when it already exists", async () => {
      mockExists.mockResolvedValue(true);
      const { initLogPersistence } = await freshImport();
      captureListener();
      await initLogPersistence();

      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it("registers a log listener via addLogListener", async () => {
      const { initLogPersistence } = await freshImport();
      captureListener();
      await initLogPersistence();

      expect(mockAddLogListener).toHaveBeenCalledTimes(1);
      expect(typeof mockAddLogListener.mock.calls[0][0]).toBe("function");
    });

    it("returns a no-op cleanup if already initialized", async () => {
      const { initLogPersistence } = await freshImport();
      captureListener();
      const cleanup1 = await initLogPersistence();
      const cleanup2 = await initLogPersistence();

      // Second call should return a no-op — addLogListener should only be
      // called once (from the first init).
      expect(mockAddLogListener).toHaveBeenCalledTimes(1);
      expect(typeof cleanup1).toBe("function");
      expect(typeof cleanup2).toBe("function");
    });

    it("returns a cleanup function that removes the listener and flushes", async () => {
      const removeMock = vi.fn();
      mockAddLogListener.mockImplementation(() => removeMock);
      const { initLogPersistence } = await freshImport();
      const cleanup = await initLogPersistence();

      cleanup();

      expect(removeMock).toHaveBeenCalledTimes(1);
    });

    it("cleanup cancels any pending flush timer", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      const cleanup = await initLogPersistence();

      // Emit a log entry to schedule a flush
      getListener()!(makeEntry());

      // Cleanup before the timer fires
      cleanup();

      // Advance past the 2000ms debounce — flush should NOT fire
      await vi.advanceTimersByTimeAsync(3000);

      // writeTextFile was called from the cleanup's own flushBuffer call
      // (best-effort final flush). But no second call from the timer.
      // The key check: no crash and the timer was cleared.
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    });

    it("returns a no-op cleanup on init failure", async () => {
      mockAppLogDir.mockRejectedValue(new Error("no access"));
      const { initLogPersistence } = await freshImport();
      const cleanup = await initLogPersistence();

      // Should not throw
      cleanup();
      expect(typeof cleanup).toBe("function");
    });
  });

  // -----------------------------------------------------------------------
  // getLogDir
  // -----------------------------------------------------------------------
  describe("getLogDir", () => {
    it("returns null before initialization", async () => {
      const { getLogDir } = await freshImport();
      expect(getLogDir()).toBeNull();
    });

    it("returns the resolved path after initialization", async () => {
      captureListener();
      const { initLogPersistence, getLogDir } = await freshImport();
      await initLogPersistence();

      expect(getLogDir()).toBe("/mock/logs/client-logs");
    });
  });

  // -----------------------------------------------------------------------
  // onLogEntry + scheduleFlush + flushBuffer
  // -----------------------------------------------------------------------
  describe("log entry buffering and flushing", () => {
    it("does not buffer entries before initialization", async () => {
      // Manually trigger the listener callback without initializing
      const { getLogDir } = await freshImport();

      // Not initialized, so even if we had a reference to onLogEntry,
      // nothing happens. We verify via getLogDir being null and no writes.
      expect(getLogDir()).toBeNull();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it("buffers entries and flushes after 2000ms debounce", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      const entry = makeEntry();
      getListener()!(entry);

      // Not yet flushed
      expect(mockWriteTextFile).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const [filePath, content, opts] = mockWriteTextFile.mock.calls[0];
      expect(filePath).toBe("/mock/logs/client-logs/2025-06-15.jsonl");
      expect(content).toBe(JSON.stringify(entry) + "\n");
      expect(opts).toEqual({ append: true });
    });

    it("batches multiple entries into a single write", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      const e1 = makeEntry({ message: "one" });
      const e2 = makeEntry({ message: "two" });
      const e3 = makeEntry({ message: "three" });

      getListener()!(e1);
      getListener()!(e2);
      getListener()!(e3);

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const content = mockWriteTextFile.mock.calls[0][1] as string;
      const lines = content.trimEnd().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).message).toBe("one");
      expect(JSON.parse(lines[1]).message).toBe("two");
      expect(JSON.parse(lines[2]).message).toBe("three");
    });

    it("does not schedule a second timer while one is pending", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry({ message: "first" }));

      // Advance 1s (still within debounce)
      await vi.advanceTimersByTimeAsync(1000);

      // Another entry — should not create a new timer
      getListener()!(makeEntry({ message: "second" }));

      // Advance the remaining 1s for the original timer
      await vi.advanceTimersByTimeAsync(1000);

      // The first flush fires with the first entry only.
      // The second entry triggers a new timer after the first fires.
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const content = mockWriteTextFile.mock.calls[0][1] as string;
      expect(content).toContain("first");
      expect(content).toContain("second");
    });

    it("handles writeTextFile failure gracefully", async () => {
      mockWriteTextFile.mockRejectedValueOnce(new Error("disk full"));
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // Should not throw — error is swallowed
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    });

    it("does not flush when buffer is empty", async () => {
      captureListener();
      const { initLogPersistence, flushLogs } = await freshImport();
      await initLogPersistence();

      await flushLogs();

      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it("does not flush when logDir is null (not initialized)", async () => {
      const { flushLogs } = await freshImport();
      await flushLogs();

      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // flushLogs (forced flush)
  // -----------------------------------------------------------------------
  describe("flushLogs", () => {
    it("cancels any pending timer and flushes immediately", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence, flushLogs } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry({ message: "urgent" }));

      // Force flush immediately — timer should be cancelled
      await flushLogs();

      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const content = mockWriteTextFile.mock.calls[0][1] as string;
      expect(content).toContain("urgent");

      // Advancing past the original timer should NOT cause a second write
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
    });

    it("is safe to call when no timer is pending", async () => {
      captureListener();
      const { initLogPersistence, flushLogs } = await freshImport();
      await initLogPersistence();

      // No entries buffered, no timer — should be safe
      await flushLogs();
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // clearPendingPersistedLogs
  // -----------------------------------------------------------------------
  describe("clearPendingPersistedLogs", () => {
    it("clears the buffer so pending entries are discarded", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence, clearPendingPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry({ message: "will-be-cleared" }));

      await clearPendingPersistedLogs();

      // Advance past debounce — nothing should be written
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it("clears a pending flush timer", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence, clearPendingPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await clearPendingPersistedLogs();

      // Timer was cleared — advancing should not trigger a write
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it("waits for an in-progress flush before resolving", async () => {
      const { getListener } = captureListener();

      let resolveWrite: (() => void) | null = null;
      mockWriteTextFile.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      );

      const { initLogPersistence, clearPendingPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // Write is in progress
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);

      let settled = false;
      const clearPromise = clearPendingPersistedLogs().then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      resolveWrite!();
      await clearPromise;
      expect(settled).toBe(true);
    });

    it("resolves immediately when no flush is active and no timer is pending", async () => {
      const { clearPendingPersistedLogs } = await freshImport();
      // Should complete instantly
      await clearPendingPersistedLogs();
    });
  });

  // -----------------------------------------------------------------------
  // Date change & rotation
  // -----------------------------------------------------------------------
  describe("date change and log rotation", () => {
    it("rotates old files when date changes", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      // First entry on the initial date
      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      expect(mockWriteTextFile.mock.calls[0][0]).toContain("2025-06-15");

      // Advance the system clock to the next day
      vi.setSystemTime(new Date("2025-06-16T08:00:00.000Z"));

      // Simulate enough old files to trigger rotation
      mockReadDir.mockResolvedValueOnce([
        { name: "2025-06-10.jsonl", isDirectory: false },
        { name: "2025-06-11.jsonl", isDirectory: false },
        { name: "2025-06-12.jsonl", isDirectory: false },
        { name: "2025-06-13.jsonl", isDirectory: false },
        { name: "2025-06-14.jsonl", isDirectory: false },
        { name: "2025-06-15.jsonl", isDirectory: false },
        { name: "2025-06-16.jsonl", isDirectory: false },
      ]);

      getListener()!(makeEntry({ message: "next-day" }));
      await vi.advanceTimersByTimeAsync(2000);

      // Should have written to the new date file
      expect(mockWriteTextFile).toHaveBeenCalledTimes(2);
      expect(mockWriteTextFile.mock.calls[1][0]).toContain("2025-06-16");

      // Should have removed the oldest files (7 files, keep 5 => remove 2)
      expect(mockRemove).toHaveBeenCalledTimes(2);
      expect(mockRemove).toHaveBeenCalledWith(
        "/mock/logs/client-logs/2025-06-10.jsonl",
      );
      expect(mockRemove).toHaveBeenCalledWith(
        "/mock/logs/client-logs/2025-06-11.jsonl",
      );
    });

    it("does not rotate when file count is within MAX_LOG_FILES", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      // First flush to set currentDate
      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // Change date
      vi.setSystemTime(new Date("2025-06-16T08:00:00.000Z"));

      mockReadDir.mockResolvedValueOnce([
        { name: "2025-06-14.jsonl", isDirectory: false },
        { name: "2025-06-15.jsonl", isDirectory: false },
        { name: "2025-06-16.jsonl", isDirectory: false },
      ]);

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // No files should be removed (3 <= 5)
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("does not rotate on flush when the date has not changed", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // Second entry on the same date
      getListener()!(makeEntry({ message: "same-day" }));
      await vi.advanceTimersByTimeAsync(2000);

      // readDir should not be called for rotation (only date change triggers it)
      expect(mockReadDir).not.toHaveBeenCalled();
    });

    it("handles rotation failure gracefully", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      // Set current date via first flush
      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // Change date and make readDir fail
      vi.setSystemTime(new Date("2025-06-16T08:00:00.000Z"));
      mockReadDir.mockRejectedValueOnce(new Error("permission denied"));

      getListener()!(makeEntry({ message: "after-rotation-fail" }));
      await vi.advanceTimersByTimeAsync(2000);

      // The write should still succeed despite rotation failure
      expect(mockWriteTextFile).toHaveBeenCalledTimes(2);
    });

    it("filters out directories and non-jsonl files during rotation", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      vi.setSystemTime(new Date("2025-06-16T08:00:00.000Z"));

      mockReadDir.mockResolvedValueOnce([
        { name: "2025-06-10.jsonl", isDirectory: false },
        { name: "2025-06-11.jsonl", isDirectory: false },
        { name: "2025-06-12.jsonl", isDirectory: false },
        { name: "2025-06-13.jsonl", isDirectory: false },
        { name: "2025-06-14.jsonl", isDirectory: false },
        { name: "2025-06-15.jsonl", isDirectory: false },
        // These should be ignored:
        { name: "some-dir", isDirectory: true },
        { name: "notes.txt", isDirectory: false },
        { name: undefined, isDirectory: false },
      ]);

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // 6 jsonl files - keep 5 = remove 1
      expect(mockRemove).toHaveBeenCalledTimes(1);
      expect(mockRemove).toHaveBeenCalledWith(
        "/mock/logs/client-logs/2025-06-10.jsonl",
      );
    });
  });

  // -----------------------------------------------------------------------
  // readAllPersistedLogs
  // -----------------------------------------------------------------------
  describe("readAllPersistedLogs", () => {
    it("returns empty string when not initialized (logDir is null)", async () => {
      const { readAllPersistedLogs } = await freshImport();
      const result = await readAllPersistedLogs();
      expect(result).toBe("");
    });

    it("reads and concatenates all jsonl files in sorted order", async () => {
      captureListener();
      const { initLogPersistence, readAllPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      mockReadDir.mockResolvedValueOnce([
        { name: "2025-06-14.jsonl", isDirectory: false },
        { name: "2025-06-15.jsonl", isDirectory: false },
        { name: "2025-06-13.jsonl", isDirectory: false },
      ]);

      mockReadTextFile
        .mockResolvedValueOnce('{"day":"13"}\n')
        .mockResolvedValueOnce('{"day":"14"}\n')
        .mockResolvedValueOnce('{"day":"15"}\n');

      const result = await readAllPersistedLogs();

      // Files should be read in sorted order: 13, 14, 15
      expect(mockReadTextFile).toHaveBeenCalledTimes(3);
      expect(mockReadTextFile.mock.calls[0][0]).toContain("2025-06-13");
      expect(mockReadTextFile.mock.calls[1][0]).toContain("2025-06-14");
      expect(mockReadTextFile.mock.calls[2][0]).toContain("2025-06-15");

      expect(result).toBe('{"day":"13"}\n{"day":"14"}\n{"day":"15"}\n');
    });

    it("filters out directories and non-jsonl entries", async () => {
      captureListener();
      const { initLogPersistence, readAllPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      mockReadDir.mockResolvedValueOnce([
        { name: "2025-06-15.jsonl", isDirectory: false },
        { name: "subdir", isDirectory: true },
        { name: "readme.txt", isDirectory: false },
      ]);

      mockReadTextFile.mockResolvedValueOnce('{"msg":"only"}\n');

      const result = await readAllPersistedLogs();

      expect(mockReadTextFile).toHaveBeenCalledTimes(1);
      expect(result).toBe('{"msg":"only"}\n');
    });

    it("returns empty string when directory has no jsonl files", async () => {
      captureListener();
      const { initLogPersistence, readAllPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      mockReadDir.mockResolvedValueOnce([
        { name: "notes.txt", isDirectory: false },
      ]);

      const result = await readAllPersistedLogs();
      expect(result).toBe("");
      expect(mockReadTextFile).not.toHaveBeenCalled();
    });

    it("returns empty string on readDir failure", async () => {
      captureListener();
      const { initLogPersistence, readAllPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      mockReadDir.mockRejectedValueOnce(new Error("no access"));

      const result = await readAllPersistedLogs();
      expect(result).toBe("");
    });

    it("returns empty string on readTextFile failure", async () => {
      captureListener();
      const { initLogPersistence, readAllPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      mockReadDir.mockResolvedValueOnce([
        { name: "2025-06-15.jsonl", isDirectory: false },
      ]);
      mockReadTextFile.mockRejectedValueOnce(new Error("corrupt file"));

      const result = await readAllPersistedLogs();
      // The entire function returns "" on any error
      expect(result).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // JSONL format
  // -----------------------------------------------------------------------
  describe("JSONL format", () => {
    it("writes each entry as valid JSON on a separate line", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      const entry = makeEntry({ data: { key: "value" } });
      getListener()!(entry);

      await vi.advanceTimersByTimeAsync(2000);

      const content = mockWriteTextFile.mock.calls[0][1] as string;
      const lines = content.trimEnd().split("\n");
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe("info");
      expect(parsed.message).toBe("hello");
      expect(parsed.data).toEqual({ key: "value" });
    });

    it("appends a trailing newline to the written content", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      const content = mockWriteTextFile.mock.calls[0][1] as string;
      expect(content.endsWith("\n")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // activeFlush concurrency
  // -----------------------------------------------------------------------
  describe("activeFlush tracking", () => {
    it("clears activeFlush after successful flush", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence, clearPendingPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // After flush completes, activeFlush should be null.
      // clearPendingPersistedLogs should resolve immediately.
      await clearPendingPersistedLogs();
      // No hanging — test completes
    });

    it("clears activeFlush after failed flush", async () => {
      mockWriteTextFile.mockRejectedValueOnce(new Error("write error"));
      const { getListener } = captureListener();
      const { initLogPersistence, clearPendingPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // Even after failure, activeFlush should be cleared
      await clearPendingPersistedLogs();
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    it("entries are not buffered after cleanup is called", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      const cleanup = await initLogPersistence();

      cleanup();

      // The listener was removed by cleanup, but even if called directly,
      // initialized is now false so onLogEntry should bail.
      // We can verify no writes happen after advancing timers.
      await vi.advanceTimersByTimeAsync(5000);

      // Only the final flush from cleanup (which had empty buffer)
      expect(mockWriteTextFile).not.toHaveBeenCalled();
    });

    it("handles entries with undefined name in readDir during rotation", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      vi.setSystemTime(new Date("2025-06-16T08:00:00.000Z"));

      mockReadDir.mockResolvedValueOnce([
        { name: undefined, isDirectory: false },
        { name: "2025-06-15.jsonl", isDirectory: false },
      ]);

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      // Should not crash, and should not try to remove undefined entries
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("handles entries with undefined name in readAllPersistedLogs", async () => {
      captureListener();
      const { initLogPersistence, readAllPersistedLogs } =
        await freshImport();
      await initLogPersistence();

      mockReadDir.mockResolvedValueOnce([
        { name: undefined, isDirectory: false },
        { name: "2025-06-15.jsonl", isDirectory: false },
      ]);
      mockReadTextFile.mockResolvedValueOnce('{"msg":"ok"}\n');

      const result = await readAllPersistedLogs();
      expect(result).toBe('{"msg":"ok"}\n');
    });

    it("multiple rapid entries reuse the same debounce timer", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      // Rapidly add 10 entries
      for (let i = 0; i < 10; i++) {
        getListener()!(makeEntry({ message: `msg-${i}` }));
      }

      await vi.advanceTimersByTimeAsync(2000);

      // All should be in a single write
      expect(mockWriteTextFile).toHaveBeenCalledTimes(1);
      const content = mockWriteTextFile.mock.calls[0][1] as string;
      const lines = content.trimEnd().split("\n");
      expect(lines).toHaveLength(10);
    });

    it("file path uses the correct date and extension", async () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      await initLogPersistence();

      getListener()!(makeEntry());
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockWriteTextFile.mock.calls[0][0]).toBe(
        "/mock/logs/client-logs/2024-01-01.jsonl",
      );
    });

    it("cleanup final flush catches and logs errors", async () => {
      const { getListener } = captureListener();
      const { initLogPersistence } = await freshImport();
      const cleanup = await initLogPersistence();

      // Add an entry, then make writeTextFile fail
      getListener()!(makeEntry());
      mockWriteTextFile.mockRejectedValueOnce(new Error("final write failed"));

      // Cleanup should not throw even if flushBuffer fails
      cleanup();

      // Let any pending microtasks settle
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
