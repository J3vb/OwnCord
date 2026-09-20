// Legacy binding for the LogFiles suite: today's `lib/logPersistence.ts`
// exports, wrapped with no cast against the seam subset of the contract.
// B7-4 re-runs `logFiles.suite.ts` against `platform/desktop` instead of
// this file.
//
// `logPersistence.ts` keeps module-level state (`initialized`, `logDir`, the
// buffer) across calls, so each test needs a fresh module instance —
// vi.resetModules() + a fresh dynamic import per test, mirroring
// tests/integration/client-updater-lifecycle.test.ts.
import { vi } from "vitest";
import type { LogFilesSeam } from "./logFiles.suite";
import { describeLogFilesSuite } from "./logFiles.suite";

const appLogDir = vi.fn();
const join = vi.fn();
const mkdir = vi.fn();
const writeTextFile = vi.fn();
const readDir = vi.fn();
const remove = vi.fn();
const exists = vi.fn();

vi.mock("@tauri-apps/api/path", () => ({ appLogDir, join }));
vi.mock("@tauri-apps/plugin-fs", () => ({ mkdir, writeTextFile, readDir, remove, exists }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  addLogListener: () => () => {},
  getLogBuffer: () => [],
}));

describeLogFilesSuite(async () => {
  vi.resetModules();
  for (const mock of [appLogDir, join, mkdir, writeTextFile, readDir, remove, exists]) {
    mock.mockReset();
  }
  join.mockImplementation((base: string, sub: string) => Promise.resolve(`${base}/${sub}`));
  exists.mockResolvedValue(true);
  readDir.mockResolvedValue([]);
  writeTextFile.mockResolvedValue(undefined);
  mkdir.mockResolvedValue(undefined);
  remove.mockResolvedValue(undefined);

  const mod = await import("../../../src/lib/logPersistence");
  const legacy: LogFilesSeam = {
    init: mod.initLogPersistence,
    flush: mod.flushLogs,
    clearPending: mod.clearPendingPersistedLogs,
    getDir: mod.getLogDir,
  };

  return {
    subject: legacy,
    native: {
      succeedWith() {
        appLogDir.mockResolvedValue("/logs");
      },
      failWith(error: unknown) {
        appLogDir.mockRejectedValue(error);
      },
      unavailable() {
        appLogDir.mockRejectedValue(new Error("not running under the native host"));
      },
    },
  };
});
