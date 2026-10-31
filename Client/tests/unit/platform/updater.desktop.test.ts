// Desktop binding for the AppUpdater suite: `platform/desktop`'s updater.
// B7-5 runs the same suite file here and in `updater.legacy.test.ts`, whose
// `lib/net/updater.ts` exports still exist; green in both is the evidence the
// move changed nothing.
//
// The updater keeps module-level install state across calls, so each test
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

  const mod = await import("../../../src/platform/desktop/updater");
  const desktopBinding: AppUpdater = mod.updater;

  return {
    subject: desktopBinding,
    native: updaterNativeControl(invoke),
  };
});
