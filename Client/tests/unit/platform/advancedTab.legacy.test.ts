// Legacy bindings for the DevTools, AppProcess and Autostart suites: the
// in-place seams in `settings/AdvancedTab.ts` (`nativeDevTools`,
// `nativeAppProcess`, `nativeAutostart`), bound with no cast. B7-5 re-runs
// each suite against `platform/desktop` once its capability moves there.
import { vi } from "vitest";
import type { AppProcess } from "../../../src/platform/contracts/appProcess";
import type { DevTools } from "../../../src/platform/contracts/devTools";
import type { Autostart } from "../../../src/platform/contracts/updater";
import { describeAppProcessSuite } from "./appProcess.suite";
import { describeAutostartSuite } from "./autostart.suite";
import { describeDevToolsSuite } from "./devTools.suite";

const invoke = vi.fn();
const relaunch = vi.fn();
const autostart = vi.hoisted(() => ({ enabled: false, error: null as unknown }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/plugin-autostart", () => {
  const settle = <T>(value: () => T) =>
    autostart.error !== null ? Promise.reject(autostart.error) : Promise.resolve(value());
  return {
    isEnabled: () => settle(() => autostart.enabled),
    enable: () =>
      settle(() => {
        autostart.enabled = true;
      }),
    disable: () =>
      settle(() => {
        autostart.enabled = false;
      }),
  };
});

async function advancedTab(): Promise<
  typeof import("../../../src/components/settings/AdvancedTab")
> {
  return import("../../../src/components/settings/AdvancedTab");
}

describeDevToolsSuite(async () => {
  invoke.mockReset().mockResolvedValue(undefined);
  const legacy: DevTools = (await advancedTab()).nativeDevTools;
  return {
    subject: legacy,
    native: {
      failWith(error: unknown) {
        invoke.mockRejectedValue(error);
      },
      opened: () => invoke.mock.calls.filter((call) => call[0] === "open_devtools").length,
    },
  };
});

describeAppProcessSuite(async () => {
  relaunch.mockReset().mockResolvedValue(undefined);
  const legacy: AppProcess = (await advancedTab()).nativeAppProcess;
  return {
    subject: legacy,
    native: {
      failWith(error: unknown) {
        relaunch.mockRejectedValue(error);
      },
      relaunches: () => relaunch.mock.calls.length,
    },
  };
});

describeAutostartSuite(async () => {
  autostart.enabled = false;
  autostart.error = null;
  const legacy: Autostart = (await advancedTab()).nativeAutostart;
  return {
    subject: legacy,
    native: {
      enabledIs(value: boolean) {
        autostart.enabled = value;
      },
      failWith(error: unknown) {
        autostart.error = error;
      },
      state: () => autostart.enabled,
    },
  };
});
