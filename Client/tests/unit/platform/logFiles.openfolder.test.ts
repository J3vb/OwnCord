// Desktop `logFiles.openFolder`: the `open_log_folder` command (src-tauri/src/tray.rs)
// as a typed result. A native rejection never reaches the caller.
import { beforeEach, describe, expect, test, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/path", () => ({ appLogDir: vi.fn(), join: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(),
  writeTextFile: vi.fn(),
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  exists: vi.fn(),
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  addLogListener: () => () => {},
  getLogBuffer: () => [],
}));

import { logFiles } from "../../../src/platform/desktop/logFiles";

describe("desktop logFiles.openFolder", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  test("invokes open_log_folder and reports ok", async () => {
    invoke.mockResolvedValue(undefined);
    await expect(logFiles.openFolder()).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("open_log_folder");
  });

  test("turns a string rejection into a typed failure", async () => {
    invoke.mockRejectedValue("no handler for the folder");
    await expect(logFiles.openFolder()).resolves.toEqual({
      ok: false,
      error: "no handler for the folder",
    });
  });

  test("turns an Error rejection into a typed failure", async () => {
    invoke.mockRejectedValue(new Error("ipc down"));
    await expect(logFiles.openFolder()).resolves.toEqual({ ok: false, error: "ipc down" });
  });
});
