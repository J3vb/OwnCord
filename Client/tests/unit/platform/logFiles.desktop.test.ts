// Desktop binding for the LogFiles suite: `platform/desktop`'s log
// persistence, which now also owns `clearAll` — the private `clearLogFiles`
// that used to live in `settings/AdvancedTab.ts`. B7-4 runs the same suite
// file here and in `logFiles.legacy.test.ts`; green in both is the evidence
// the move changed nothing.
//
// The module keeps state (`initialized`, `logDir`, the buffer) across calls,
// so each test needs a fresh module instance — vi.resetModules() + a fresh
// dynamic import per test, mirroring the legacy binding.
import { describe, expect, test, vi } from "vitest";
import type { LogEntry } from "../../../src/lib/logger";
import type { LogFilesSeam } from "./logFiles.suite";
import { describeLogFilesSuite, logFilesNativeControl, resetLogFileMocks } from "./logFiles.suite";

const appLogDir = vi.fn();
const join = vi.fn();
const mkdir = vi.fn();
const writeTextFile = vi.fn();
const readDir = vi.fn();
const readTextFile = vi.fn();
const remove = vi.fn();
const exists = vi.fn();

let capturedListener: ((entry: LogEntry) => void) | null = null;

vi.mock("@tauri-apps/api/path", () => ({ appLogDir, join }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir,
  writeTextFile,
  readDir,
  readTextFile,
  remove,
  exists,
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  addLogListener: (listener: (entry: LogEntry) => void) => {
    capturedListener = listener;
    return () => {};
  },
  getLogBuffer: () => [],
}));

async function freshModule(): Promise<typeof import("../../../src/platform/desktop/logFiles")> {
  vi.resetModules();
  capturedListener = null;
  resetLogFileMocks({ appLogDir, join, mkdir, writeTextFile, readDir, remove, exists }, [
    readTextFile,
  ]);
  return await import("../../../src/platform/desktop/logFiles");
}

describeLogFilesSuite(async () => {
  const mod = await freshModule();
  const desktopBinding: LogFilesSeam = {
    init: mod.logFiles.init,
    flush: mod.logFiles.flush,
    clearPending: mod.logFiles.clearPending,
    getDir: mod.logFiles.getDir,
  };

  return {
    subject: desktopBinding,
    native: logFilesNativeControl({ appLogDir, writeTextFile }, () => capturedListener),
  };
});

// The `clearAll` half: no exported seam until this milestone, so its coverage
// lands with the move. The old path (the Clear log files button in
// AdvancedTab) keeps its own test in tests/unit/advanced-tab.test.ts.
/** Initialises the module on /logs and buffers one entry that has not been flushed yet. */
async function initWithBufferedEntry(mod: Awaited<ReturnType<typeof freshModule>>): Promise<void> {
  appLogDir.mockResolvedValue("/logs");
  await mod.logFiles.init();
  capturedListener?.({
    timestamp: new Date().toISOString(),
    level: "info",
    component: "test",
    message: "a log entry",
  });
}

describe("LogFiles.clearAll", () => {
  test("removes every persisted log file, and leaves other files alone", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue([
      { name: "2026-09-19.jsonl", isDirectory: false },
      { name: "2026-09-20.jsonl", isDirectory: false },
      { name: "notes.txt", isDirectory: false },
      { name: "subdir", isDirectory: true },
    ]);

    await mod.logFiles.clearAll();

    expect(remove.mock.calls.map((call) => call[0])).toEqual([
      "/logs/client-logs/2026-09-19.jsonl",
      "/logs/client-logs/2026-09-20.jsonl",
    ]);
  });

  test("is a no-op when the log directory does not exist yet", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockRejectedValue(new Error("No such file or directory (os error 2)"));

    await expect(mod.logFiles.clearAll()).resolves.toBeUndefined();
    expect(remove).not.toHaveBeenCalled();
  });

  test("propagates a failure that is not a missing directory", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockRejectedValue(new Error("permission denied"));

    await expect(mod.logFiles.clearAll()).rejects.toThrow("permission denied");
  });

  test("discards buffered entries rather than writing them out after a clear", async () => {
    const mod = await freshModule();
    await initWithBufferedEntry(mod);

    await mod.logFiles.clearAll();
    await mod.logFiles.flush();

    expect(writeTextFile).not.toHaveBeenCalled();
  });
});

describe("LogFiles daily limit", () => {
  test("stops writing a day's file past about 20 MB, with one note", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    await mod.logFiles.init();
    const line = (message: string): void =>
      capturedListener?.({ timestamp: "t", level: "debug", component: "test", message });

    line("x".repeat(15 << 20));
    await mod.logFiles.flush();
    line("y".repeat(10 << 20));
    await mod.logFiles.flush();
    line("z");
    await mod.logFiles.flush();

    const written = writeTextFile.mock.calls.map((call) => call[1] as string);
    expect(written).toHaveLength(2);
    expect(written[0]).toContain("xxx");
    expect(written[1]).toContain("daily log limit reached");
    expect(written[1]).not.toContain("yyy");
  });

  test("writes again after the logs were cleared past the limit", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue([{ name: "2026-09-19.jsonl", isDirectory: false }]);
    await mod.logFiles.init();
    const line = (message: string): void =>
      capturedListener?.({ timestamp: "t", level: "debug", component: "test", message });

    line("x".repeat(25 << 20));
    await mod.logFiles.flush();
    await mod.logFiles.clearAll();
    writeTextFile.mockClear();
    line("after the clear");
    await mod.logFiles.flush();

    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile.mock.calls[0]?.[1]).toContain("after the clear");
  });
});

// The support bundle's log half (B7-15c).
describe("LogFiles.readAll", () => {
  test("reads every persisted log file oldest first, verbatim, and nothing else", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue([
      { name: "2026-09-20.jsonl", isDirectory: false },
      { name: "notes.txt", isDirectory: false },
      { name: "2026-09-19.jsonl", isDirectory: false },
      { name: "subdir", isDirectory: true },
    ]);
    readTextFile.mockImplementation((path: string) => Promise.resolve(`contents of ${path}\n`));

    await expect(mod.logFiles.readAll()).resolves.toEqual([
      { name: "2026-09-19.jsonl", text: "contents of /logs/client-logs/2026-09-19.jsonl\n" },
      { name: "2026-09-20.jsonl", text: "contents of /logs/client-logs/2026-09-20.jsonl\n" },
    ]);
  });

  test("flushes buffered entries before reading, so the bundle has the latest lines", async () => {
    const mod = await freshModule();
    await initWithBufferedEntry(mod);

    await mod.logFiles.readAll();

    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(writeTextFile.mock.invocationCallOrder[0]!).toBeLessThan(
      readDir.mock.invocationCallOrder.at(-1)!,
    );
  });

  test("is empty when the log directory does not exist yet", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockRejectedValue(new Error("No such file or directory (os error 2)"));

    await expect(mod.logFiles.readAll()).resolves.toEqual([]);
  });

  test("keeps only the newest 4 MB of a large file", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue([{ name: "2026-09-20.jsonl", isDirectory: false }]);
    const big = "o".repeat(1000) + "n".repeat(4 << 20);
    readTextFile.mockResolvedValue(big);

    const [file] = await mod.logFiles.readAll();
    expect(file?.text).toBe("n".repeat(4 << 20));
  });

  test("propagates a failure that is not a missing directory", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockRejectedValue(new Error("permission denied"));

    await expect(mod.logFiles.readAll()).rejects.toThrow("permission denied");
  });
});

// The support bundle's native (Rust) log half (CLI-03).
describe("LogFiles.readNative", () => {
  test("reads the active and rotated Rust logs, newest first, and nothing else", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue([
      { name: "owncord-client_2026-09-19_10-00-00.log", isDirectory: false },
      { name: "owncord-client.log", isDirectory: false },
      { name: "notes.txt", isDirectory: false },
      { name: "owncord-client-backup.txt", isDirectory: false },
      { name: "subdir", isDirectory: true },
    ]);
    readTextFile.mockImplementation((path: string) => Promise.resolve(`contents of ${path}\n`));

    await expect(mod.logFiles.readNative()).resolves.toEqual([
      { name: "owncord-client.log", text: "contents of /logs/owncord-client.log\n" },
      {
        name: "owncord-client_2026-09-19_10-00-00.log",
        text: "contents of /logs/owncord-client_2026-09-19_10-00-00.log\n",
      },
    ]);
  });

  test("caps each file to its last 2 MB so the store-only zip stays small", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue([{ name: "owncord-client.log", isDirectory: false }]);
    const big = "a".repeat((2 << 20) + 10) + "TAIL";
    readTextFile.mockResolvedValue(big);

    const [file] = await mod.logFiles.readNative();

    expect(file!.text.length).toBe(2 << 20);
    expect(file!.text.endsWith("TAIL")).toBe(true);
    expect(file!.text.startsWith("a")).toBe(true);
  });

  test("is empty when the app log directory does not exist yet", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockRejectedValue(new Error("No such file or directory (os error 2)"));

    await expect(mod.logFiles.readNative()).resolves.toEqual([]);
  });

  test("keeps the files it read when a rotated file vanishes mid-read", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue([
      { name: "owncord-client.log", isDirectory: false },
      { name: "owncord-client_2026-09-19_10-00-00.log", isDirectory: false },
    ]);
    readTextFile.mockImplementation((path: string) =>
      path.endsWith("owncord-client.log")
        ? Promise.resolve("active\n")
        : Promise.reject(new Error("No such file or directory (os error 2)")),
    );

    await expect(mod.logFiles.readNative()).resolves.toEqual([
      { name: "owncord-client.log", text: "active\n" },
    ]);
  });

  test("is empty, not a rejection, when a read fails for another reason", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockRejectedValue(new Error("permission denied"));

    await expect(mod.logFiles.readNative()).resolves.toEqual([]);
  });
});

// Codex review of B7-15c: flush() must wait for a write the debounce timer
// already started, and writes must land in order.
describe("LogFiles.flush ordering", () => {
  const emit = (message: string): void =>
    capturedListener?.({
      timestamp: new Date().toISOString(),
      level: "info",
      component: "test",
      message,
    });

  test("flush waits for a write the debounce timer already started", async () => {
    vi.useFakeTimers();
    try {
      const mod = await freshModule();
      appLogDir.mockResolvedValue("/logs");
      await mod.logFiles.init();

      const releases: (() => void)[] = [];
      writeTextFile.mockImplementation(
        () => new Promise<void>((resolve) => releases.push(resolve)),
      );

      emit("first");
      await vi.advanceTimersByTimeAsync(2000);
      expect(writeTextFile).toHaveBeenCalledTimes(1);

      emit("second");
      let flushed = false;
      const flushing = mod.logFiles.flush().then(() => {
        flushed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(flushed).toBe(false);
      // The second write must not start until the first has finished.
      expect(writeTextFile).toHaveBeenCalledTimes(1);

      releases[0]!();
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(2));
      expect(flushed).toBe(false);
      releases[1]!();
      await flushing;

      expect(flushed).toBe(true);
      expect(writeTextFile.mock.calls[0]![1]).toContain("first");
      expect(writeTextFile.mock.calls[1]![1]).toContain("second");
    } finally {
      vi.useRealTimers();
    }
  });
});

// The diagnostic event log's disk half: its own files beside the logs.
describe("LogFiles event files", () => {
  async function initWithEventLog(mod: Awaited<ReturnType<typeof freshModule>>) {
    appLogDir.mockResolvedValue("/logs");
    const eventLog = await import("../../../src/lib/diagnostics/eventLog");
    await mod.logFiles.init();
    await vi.waitFor(() => {
      eventLog.record("ws.open", { generation: 1 }, Date.now());
      expect(writeTextFile).not.toHaveBeenCalled();
      return mod.logFiles.flush().then(() => {
        expect(writeTextFile).toHaveBeenCalled();
      });
    });
    writeTextFile.mockClear();
    return eventLog;
  }

  test("writes event lines to an events file, not to the day's log", async () => {
    const mod = await freshModule();
    const eventLog = await initWithEventLog(mod);
    eventLog.record("ws.ready", { generation: 1, after_ms: 12 }, Date.now());
    await mod.logFiles.flush();

    const [path, text] = writeTextFile.mock.calls[0] as [string, string];
    expect(path).toMatch(
      /^\/logs\/client-logs\/events-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}\.jsonl$/,
    );
    expect(text).toContain('"code":"ws.ready"');
  });

  test("starts a new file once one is full, so the newest events are kept", async () => {
    const mod = await freshModule();
    const eventLog = await initWithEventLog(mod);
    // About 1.4 MB of rate-limit-free lines over two flushes.
    const codes = ["ws.open", "ws.ready", "ws.closed", "ws.connecting"] as const;
    let at = Date.now();
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 12_000; i++) {
        at += 2_100;
        eventLog.record(codes[i % codes.length]!, { generation: i }, at);
      }
      // oxlint-disable-next-line no-await-in-loop -- two flushes in order
      await mod.logFiles.flush();
    }
    const paths = writeTextFile.mock.calls.map((call) => call[0] as string);
    expect(paths).toHaveLength(2);
    expect(paths[1]).not.toBe(paths[0]);
    expect(paths[1]! > paths[0]!).toBe(true);
    const total = writeTextFile.mock.calls.reduce((n, call) => n + (call[1] as string).length, 0);
    expect(total).toBeGreaterThan(1 << 20);
  });

  test("rotates log files and event files on their own counts", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    readDir.mockResolvedValue(
      [
        "2026-10-28.jsonl",
        "2026-10-29.jsonl",
        "2026-10-30.jsonl",
        "2026-10-31.jsonl",
        "2026-11-01.jsonl",
        "2026-11-02.jsonl",
        "events-2026-10-30T08-00-00.jsonl",
        "events-2026-10-31T08-00-00.jsonl",
        "events-2026-11-01T08-00-00.jsonl",
        "events-2026-11-02T08-00-00.jsonl",
        "events-2026-11-03T08-00-00.jsonl",
      ].map((name) => ({ name, isDirectory: false })),
    );
    await mod.logFiles.init();

    expect(remove.mock.calls.map((call) => call[0])).toEqual([
      "/logs/client-logs/2026-10-28.jsonl",
      "/logs/client-logs/events-2026-10-30T08-00-00.jsonl",
    ]);
  });
});

describe("LogFiles event files when the log is turned off", () => {
  test("a clear during a write deletes that write's file too", async () => {
    const mod = await freshModule();
    appLogDir.mockResolvedValue("/logs");
    const eventLog = await import("../../../src/lib/diagnostics/eventLog");
    await mod.logFiles.init();
    await vi.waitFor(() => {
      eventLog.record("ws.open", { generation: 1 }, Date.now());
      return mod.logFiles.flush().then(() => expect(writeTextFile).toHaveBeenCalled());
    });
    const written = new Set<string>();
    writeTextFile.mockImplementation((path: string) => {
      written.add(path);
      return Promise.resolve(undefined);
    });
    // The first file holds one line; a big batch forces a new file, whose
    // rotation read is where a clear can land.
    let releaseRotation!: () => void;
    readDir.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRotation = () => resolve([]);
        }),
    );
    let at = Date.now();
    const codes = ["ws.open", "ws.ready", "ws.closed", "ws.connecting"] as const;
    for (let i = 0; i < 24_000; i++) {
      at += 2_100;
      eventLog.record(codes[i % codes.length]!, { generation: i }, at);
    }
    const flushing = mod.logFiles.flush();
    await vi.waitFor(() => expect(releaseRotation).toBeTypeOf("function"));
    eventLog.clearEventLog();
    readDir.mockImplementation(() =>
      Promise.resolve([...written].map((p) => ({ name: p.split("/").pop(), isDirectory: false }))),
    );
    releaseRotation();
    await flushing;
    await mod.logFiles.flush();

    expect([...written].every((p) => /\/events-[^/]+\.jsonl$/.test(p))).toBe(true);
    const removed = new Set(remove.mock.calls.map((call) => call[0] as string));
    for (const path of written) expect(removed.has(path)).toBe(true);
  });
});
