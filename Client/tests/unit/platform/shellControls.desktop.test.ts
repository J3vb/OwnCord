// Desktop bindings for the DevTools, AppProcess and Autostart suites:
// `platform/desktop`'s `devTools`, `appProcess` and `autostart`. B7-5 ran the
// same suite files against the in-place seams in `settings/AdvancedTab.ts`
// first (proving they could fail and pinning today's behaviour), then re-bound
// them here. The legacy bindings are deleted with this commit: their exports
// are gone.
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

describeDevToolsSuite(async () => {
  invoke.mockReset().mockResolvedValue(undefined);
  const desktopBinding: DevTools = (await import("../../../src/platform/desktop/devTools"))
    .devTools;
  return {
    subject: desktopBinding,
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
  const desktopBinding: AppProcess = (await import("../../../src/platform/desktop/appProcess"))
    .appProcess;
  return {
    subject: desktopBinding,
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
  const desktopBinding: Autostart = (await import("../../../src/platform/desktop/autostart"))
    .autostart;
  return {
    subject: desktopBinding,
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
