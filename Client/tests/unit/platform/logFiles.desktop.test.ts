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
import { describeLogFilesSuite } from "./logFiles.suite";

const appLogDir = vi.fn();
const join = vi.fn();
const mkdir = vi.fn();
const writeTextFile = vi.fn();
const readDir = vi.fn();
const remove = vi.fn();
const exists = vi.fn();

let capturedListener: ((entry: LogEntry) => void) | null = null;

vi.mock("@tauri-apps/api/path", () => ({ appLogDir, join }));
vi.mock("@tauri-apps/plugin-fs", () => ({ mkdir, writeTextFile, readDir, remove, exists }));
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
  for (const mock of [appLogDir, join, mkdir, writeTextFile, readDir, remove, exists]) {
    mock.mockReset();
  }
  join.mockImplementation((base: string, sub: string) => Promise.resolve(`${base}/${sub}`));
  exists.mockResolvedValue(true);
  readDir.mockResolvedValue([]);
  writeTextFile.mockResolvedValue(undefined);
  mkdir.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);
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
    native: {
      succeedWith() {
        appLogDir.mockResolvedValue("/logs");
      },
      unavailable() {
        appLogDir.mockRejectedValue(new Error("not running under the native host"));
      },
      logEntry() {
        capturedListener?.({
          timestamp: new Date().toISOString(),
          level: "info",
          component: "test",
          message: "a log entry",
        });
      },
      written() {
        return writeTextFile.mock.calls.map((call) => call[1] as string);
      },
    },
  };
});

// The `clearAll` half: no exported seam until this milestone, so its coverage
// lands with the move. The old path (the Clear Log Files button in
// AdvancedTab) keeps its own test in tests/unit/advanced-tab.test.ts.
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
    appLogDir.mockResolvedValue("/logs");
    await mod.logFiles.init();
    capturedListener?.({
      timestamp: new Date().toISOString(),
      level: "info",
      component: "test",
      message: "a log entry",
    });

    await mod.logFiles.clearAll();
    await mod.logFiles.flush();

    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
