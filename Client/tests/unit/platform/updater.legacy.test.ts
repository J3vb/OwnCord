// Legacy binding for the AppUpdater suite: today's `lib/updater.ts` exports,
// wrapped with no cast against the contract. B7-5 re-runs
// `updater.suite.ts` against `platform/desktop` instead of this file.
//
// `updater.ts` keeps module-level install state across calls, so each test
// needs a fresh module instance (mirrors
// tests/integration/client-updater-lifecycle.test.ts).
import { vi } from "vitest";
import type { AppUpdater } from "../../../src/platform/contracts/updater";
import { describeAppUpdaterSuite } from "./updater.suite";

const invoke = vi.fn();
const relaunch = vi.fn();
const listen = vi.fn();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describeAppUpdaterSuite(async () => {
  vi.resetModules();
  invoke.mockReset();
  relaunch.mockReset().mockResolvedValue(undefined);
  listen.mockReset().mockResolvedValue(unlisten);

  const mod = await import("../../../src/lib/updater");
  const legacy: AppUpdater = {
    checkForUpdate: mod.checkForUpdate,
    downloadAndInstallUpdate: mod.downloadAndInstallUpdate,
    subscribeToInstall: mod.subscribeToUpdateInstall,
  };

  return {
    subject: legacy,
    native: {
      checkSucceedsWith(result) {
        invoke.mockImplementation((cmd: string) =>
          cmd === "check_client_update" ? Promise.resolve(result) : Promise.reject(new Error(cmd)),
        );
      },
      checkFailsWith(error) {
        invoke.mockImplementation((cmd: string) =>
          cmd === "check_client_update" ? Promise.reject(error) : Promise.reject(new Error(cmd)),
        );
      },
      installSucceeds() {
        invoke.mockImplementation((cmd: string) =>
          cmd === "download_and_install_update"
            ? Promise.resolve(undefined)
            : Promise.reject(new Error(cmd)),
        );
      },
      installFailsWith(error) {
        invoke.mockImplementation((cmd: string) =>
          cmd === "download_and_install_update"
            ? Promise.reject(error)
            : Promise.reject(new Error(cmd)),
        );
      },
    },
  };
});
