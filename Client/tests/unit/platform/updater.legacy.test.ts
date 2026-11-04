// Legacy binding for the AppUpdater suite: the `lib/net/updater.ts` exports,
// wrapped with no cast against the contract. B7-5 moved the install behind
// `platform/desktop` and kept these exports as its callers' names, so the
// suite runs here and in `updater.desktop.test.ts`.
//
// `updater.ts` keeps module-level install state across calls, so each test
// needs a fresh module instance (mirrors
// tests/integration/client-updater-lifecycle.test.ts).
import { vi } from "vitest";
import type { AppUpdater } from "../../../src/platform/contracts/updater";
import {
  describeAppUpdaterSuite,
  resetUpdaterNatives,
  updaterNativeControl,
} from "./updater.suite";
import * as lm from "../../helpers/loggerMock";

const invoke = vi.fn();
const relaunch = vi.fn();
const listen = vi.fn();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@lib/logger", () => lm.loggerMock());

describeAppUpdaterSuite(async () => {
  resetUpdaterNatives({ invoke, relaunch, listen, unlisten });

  const mod = await import("../../../src/lib/net/updater");
  const legacy: AppUpdater = {
    available: true,
    checkForUpdate: mod.checkForUpdate,
    downloadAndInstallUpdate: mod.downloadAndInstallUpdate,
    subscribeToInstall: mod.subscribeToUpdateInstall,
  };

  return {
    subject: legacy,
    native: updaterNativeControl(invoke),
  };
});
